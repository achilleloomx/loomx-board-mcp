// Staleness/decay tools — exposes the DEL-008/M2 detector (dba migration
// 20260822090000, gov.doc_subscription_staleness + gov.doc_frozen_row_touches,
// predicate D-201/D8 = gov.doc_item_substantive_diff) and closes the one ring
// the detector does NOT build on its own: turning an open marking on a
// uat_case subscriber into a distinct, visible decay state (GTD 1dffa01e,
// mandate ddb6815c). M2 marks the SUBSCRIPTION stale; nothing before this
// file wrote back to the subscriber row itself.
//
// Scope (fetta verticale, GTD ddb6815c): only uat_case subscribers, only
// intent in {critical, module} — informative is FYI-only, never decays
// anything (SUBSCRIBE_INTENTS grade, subscriptions.ts). Cascade "by waves":
// this tool does not walk the chain itself — writing decay_status onto a
// uat_case row is itself a significant-column change (status is NOT touched,
// but decay lives in attrs, and 'attrs' IS a significant column per
// docm_m2_significant_columns), so the SAME trigger that fired here fires
// again for whoever subscribes to THIS row. One hop is coded; the wave is
// the existing detector re-firing on its own output, not a hand-rolled
// recursion — every level still decides via its own subscription (or its
// absence), never a blind cascade to the end of the chain.
//
// Governance params (DEC-01h registry, owner_agent_code='005'=board-mcp,
// seeded 2026-08-24): pg_rilancio_soglia_decaduti (default fallback 3),
// pg_rilancio_giorni_max (30), pg_rilancio_classi_esenti ({"classi":[...]}).
// The "classi esenti" gate needs a per-uat_case check-class attribute that
// does not exist in the schema yet — read here, surfaced as a declared gap
// in the verdict (`class_gate_note`), never silently applied or invented
// (D-136 §5: no contract invented without going through Loomy).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocResult, DocContext } from "./docs.js";
import { DOC_ITEM_TYPE_REGISTRY, validateAttrs } from "./docTypes.js";

const GOV_STALENESS = "gov.doc_subscription_staleness";
const GOV_FROZEN = "gov.doc_frozen_row_touches";
const GOV_SUBSCRIPTIONS = "gov.doc_subscriptions";
const DOC_ITEMS = "doc_items";
const DOCUMENTS = "documents";
const GOV_PARAMS = "loomx_governance_params";
const GOV_DOC_VERSIONS = "gov.doc_versions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STALENESS_STATUS_FILTERS = ["open", "closed", "all"] as const;
export const STALENESS_CLOSE_OUTCOMES = ["updated", "no_impact", "feedback_sent"] as const;
type CloseOutcome = (typeof STALENESS_CLOSE_OUTCOMES)[number];

// Decay is eligible only for these subscription grades — 'informative' is a
// watch, not a dependency, and must never flip a UAT to decayed on its own.
const DECAY_ELIGIBLE_INTENTS = new Set(["critical", "module"]);

function err(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}

interface StalenessRow {
  id: string;
  subscription_id: string;
  target_item_id: string;
  op: string;
  changed_columns: string[];
  // node-pg returns timestamptz as Date, not string — see toIsoString().
  changed_at: string | Date;
  detection_source: string;
  changed_by: string | null;
  status: string;
  closed_outcome: string | null;
  closed_note: string | null;
  closed_at: string | null;
  closed_by: string | null;
  detected_at: string;
}

interface SubscriptionRow {
  id: string;
  subscriber_item_id: string;
  subscriber_project_id: string;
  intent: string;
  target_item_id: string | null;
  target_document_id: string | null;
  status: string;
  subscribed_at_version: string;
}

interface DocItemRow {
  id: string;
  code: string | null;
  item_type: string;
  status: string;
  attrs: Record<string, unknown> | null;
  document_id?: string | null;
}

// Current published version per document — the repoint triple's source.
// `null` for a document with no publication at all, which is the COMMON case,
// not an edge one: measured 2026-08-28 on production, 143 of 153 active
// subscriptions (93%) target a document that has never been published, and all
// 10 open markings did. A staleness marking comes from a substantively-changed
// ROW (D-201/M2) and needs no publication, so the two are simply independent.
async function loadCurrentVersions(
  db: SupabaseClient,
  documentIds: string[]
): Promise<Map<string, { id: string; label: string }>> {
  const out = new Map<string, { id: string; label: string }>();
  const uniq = [...new Set(documentIds)].filter(Boolean);
  if (uniq.length === 0) return out;
  const { data } = await db
    .from(GOV_DOC_VERSIONS)
    .select("id, document_id, version_label, version_seq")
    .in("document_id", uniq)
    .order("version_seq", { ascending: false });
  // Ordered desc, so the first row seen per document is its current version.
  for (const row of (data ?? []) as Array<{ id: string; document_id: string; version_label: string }>) {
    if (!out.has(row.document_id)) out.set(row.document_id, { id: row.id, label: row.version_label });
  }
  return out;
}

// Shared by docStalenessQuery and docDecayApply: load the open/closed staleness
// markings whose SUBSCRIBER lives in project_id, joined to the subscription row.
// No SQL JOIN in the pg-shim query builder — resolved in two round trips and
// filtered in JS, same pattern doc_query uses for traceability checks.
async function loadMarkingsForProject(
  db: SupabaseClient,
  projectId: string,
  status: "open" | "closed" | "all",
  limit: number
): Promise<DocResult<{ markings: StalenessRow[]; subs: Map<string, SubscriptionRow>; truncated: boolean }>> {
  let q = db
    .from(GOV_STALENESS)
    .select(
      "id, subscription_id, target_item_id, op, changed_columns, changed_at, detection_source, changed_by, status, closed_outcome, closed_note, closed_at, closed_by, detected_at"
    );
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q.order("changed_at", { ascending: false }).limit(limit + 1);
  if (error) return err(`Failed to read gov.doc_subscription_staleness: ${error.message}`);
  const all = (Array.isArray(data) ? data : []) as StalenessRow[];
  const truncated = all.length > limit;
  const page = truncated ? all.slice(0, limit) : all;

  const subIds = [...new Set(page.map((r) => r.subscription_id))];
  const subsById = new Map<string, SubscriptionRow>();
  if (subIds.length > 0) {
    const { data: subRows, error: subErr } = await db
      .from(GOV_SUBSCRIPTIONS)
      .select("id, subscriber_item_id, subscriber_project_id, intent, target_item_id, target_document_id, status, subscribed_at_version")
      .in("id", subIds);
    if (subErr) return err(`Failed to resolve subscriptions for staleness markings: ${subErr.message}`);
    for (const s of (subRows ?? []) as SubscriptionRow[]) subsById.set(s.id, s);
  }

  const scoped = page.filter((r) => subsById.get(r.subscription_id)?.subscriber_project_id === projectId);
  return { ok: true, data: { markings: scoped, subs: subsById, truncated: truncated && scoped.length === page.length } };
}

async function loadDoc_items(db: SupabaseClient, ids: string[]): Promise<Map<string, DocItemRow>> {
  const out = new Map<string, DocItemRow>();
  const uniq = [...new Set(ids)].filter(Boolean);
  if (uniq.length === 0) return out;
  const { data } = await db.from(DOC_ITEMS).select("id, code, item_type, status, attrs, document_id").in("id", uniq);
  for (const row of (data ?? []) as DocItemRow[]) out.set(row.id, row);
  return out;
}

interface DecayParams {
  threshold: number | null;
  max_days: number | null;
  exempt_classes: string[] | null;
  missing: string[]; // param_keys that were not found — never a silent fallback
}

async function loadDecayParams(db: SupabaseClient): Promise<DecayParams> {
  const keys = ["pg_rilancio_soglia_decaduti", "pg_rilancio_giorni_max", "pg_rilancio_classi_esenti"];
  const { data } = await db
    .from(GOV_PARAMS)
    .select("param_key, value_numeric, value_json, deprecated_at")
    .in("param_key", keys);
  const rows = (data ?? []) as Array<{ param_key: string; value_numeric: number | null; value_json: Record<string, unknown> | null; deprecated_at: string | null }>;
  const byKey = new Map(rows.filter((r) => !r.deprecated_at).map((r) => [r.param_key, r]));
  const missing = keys.filter((k) => !byKey.has(k));
  const soglia = byKey.get("pg_rilancio_soglia_decaduti");
  const giorni = byKey.get("pg_rilancio_giorni_max");
  const classi = byKey.get("pg_rilancio_classi_esenti");
  const exemptRaw = classi?.value_json?.["classi"];
  // node-pg returns `numeric` columns as strings (JS numbers can't safely hold
  // arbitrary precision) — coerce here so the tool's JSON contract is a real
  // number, not "3", and so downstream arithmetic never depends on JS's
  // string-to-number coercion in relational operators to happen to be correct.
  const toNum = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    threshold: toNum(soglia?.value_numeric),
    max_days: toNum(giorni?.value_numeric),
    exempt_classes: Array.isArray(exemptRaw) ? (exemptRaw as string[]) : null,
    missing,
  };
}

function isDecayed(attrs: Record<string, unknown> | null | undefined): boolean {
  return !!attrs && attrs["decay_status"] === "decayed";
}

// node-pg returns `timestamptz` columns as Date objects, not strings — the
// uat_case attrs_schema for decay_since declares `type: "string"` (attrs is
// JSON, it has no native timestamp type), so every write path must normalize
// through here rather than assume the DB driver already returned a string.
function toIsoString(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// ---------------------------------------------------------------------------
// doc_staleness_query — read-only. Surfaces what DEL-008/M2 already detects
// (open/closed markings, frozen-row-on-published anomalies) plus the current
// decay picture for the project, computed from live rows — never cached.
// ---------------------------------------------------------------------------

export interface DocStalenessQueryArgs {
  project_id: string;
  status?: string; // open (default) | closed | all
  limit?: number;
}

export interface DocStalenessQueryResult {
  markings: Array<{
    staleness_id: string;
    subscriber_item_id: string;
    subscriber_item_code: string | null;
    subscriber_item_type: string | null;
    intent: string | null;
    target_item_id: string;
    target_item_code: string | null;
    op: string;
    changed_columns: string[];
    changed_at: string;
    detection_source: string;
    changed_by: string | null;
    status: string;
    closed_outcome: string | null;
    // Repoint triple (UAT-GOV-029): what the subscription is pinned to, what the
    // target actually publishes now, and whether a repoint is even possible.
    // Without target_current_version_id nothing could call doc_repoint — no
    // other surface exposes a gov.doc_versions.id, and the signature refuses a
    // label on purpose.
    subscribed_at_version: string | null;
    target_current_version: string | null;
    target_current_version_id: string | null;
    repoint_applicable: boolean;
    repoint_note?: string;
  }>;
  truncated?: boolean;
  frozen_row_touches: Array<{
    id: string;
    doc_item_id: string;
    doc_item_code: string | null;
    document_id: string;
    op: string;
    changed_columns: string[];
    changed_at: string;
  }>;
  decay: {
    threshold: number | null;
    max_days: number | null;
    exempt_classes: string[] | null;
    params_missing?: string[];
    decayed_uat_cases: Array<{ item_id: string; code: string | null; decay_since: string | null; decay_cause_item: string | null }>;
    decayed_count: number;
    forced_rerun: boolean;
    class_gate_note: string;
  };
}

export async function docStalenessQuery(
  db: SupabaseClient,
  args: DocStalenessQueryArgs,
  _ctx: DocContext
): Promise<DocResult<DocStalenessQueryResult>> {
  if (!UUID_RE.test(args.project_id)) return err(`project_id must be a UUID.`);
  const status = (args.status ?? "open") as "open" | "closed" | "all";
  if (!(STALENESS_STATUS_FILTERS as readonly string[]).includes(status)) {
    return err(`Invalid status '${args.status}'. Allowed: ${STALENESS_STATUS_FILTERS.join(", ")}.`);
  }
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);

  const loaded = await loadMarkingsForProject(db, args.project_id, status, limit);
  if (!loaded.ok) return loaded;
  const { markings, subs, truncated } = loaded.data;

  const itemIds = markings.flatMap((m) => {
    const s = subs.get(m.subscription_id);
    return [s?.subscriber_item_id, m.target_item_id].filter(Boolean) as string[];
  });
  const itemsById = await loadDoc_items(db, itemIds);

  // Resolve each marking's target document (XOR: the subscription pins either a
  // document or a row), then that document's current published version.
  const targetDocIds = markings
    .map((m) => {
      const s = subs.get(m.subscription_id);
      return s?.target_document_id ?? itemsById.get(m.target_item_id)?.document_id ?? null;
    })
    .filter((d): d is string => !!d);
  const currentVersions = await loadCurrentVersions(db, targetDocIds);

  const markingsOut = markings.map((m) => {
    const s = subs.get(m.subscription_id);
    const subItem = s ? itemsById.get(s.subscriber_item_id) : undefined;
    const tgtItem = itemsById.get(m.target_item_id);
    const targetDocId = s?.target_document_id ?? tgtItem?.document_id ?? null;
    const cur = targetDocId ? currentVersions.get(targetDocId) ?? null : null;
    const pin = s?.subscribed_at_version ?? null;
    // Applicable only when there IS a newer published version to move to.
    // Anything else gets a stated reason instead of a bare false — the caller
    // must be able to tell "nothing to repoint" from "cannot repoint here".
    const applicable = !!cur && pin !== null && pin !== cur.label;
    let repointNote: string | undefined;
    if (!cur) {
      repointNote =
        "Target has no published version — repointing is not applicable. A marking is raised by a substantively " +
        "changed ROW (D-201/M2), which needs no publication, so this is a normal state, not an anomaly. Settle the " +
        "debt with doc_staleness_close.";
    } else if (pin !== null && pin === cur.label) {
      repointNote = "Already pinned to the target's current version — nothing to repoint; the debt is settled with doc_staleness_close.";
    }
    return {
      staleness_id: m.id,
      subscriber_item_id: s?.subscriber_item_id ?? "",
      subscriber_item_code: subItem?.code ?? null,
      subscriber_item_type: subItem?.item_type ?? null,
      intent: s?.intent ?? null,
      target_item_id: m.target_item_id,
      target_item_code: tgtItem?.code ?? null,
      op: m.op,
      changed_columns: m.changed_columns,
      changed_at: toIsoString(m.changed_at),
      detection_source: m.detection_source,
      changed_by: m.changed_by,
      status: m.status,
      closed_outcome: m.closed_outcome,
      subscribed_at_version: pin,
      target_current_version: cur?.label ?? null,
      target_current_version_id: cur?.id ?? null,
      repoint_applicable: applicable,
      ...(repointNote ? { repoint_note: repointNote } : {}),
    };
  });

  // frozen-row touches (published-doc rewrite anomalies — the "second defect",
  // same detector, other side): scoped to this project's documents.
  const { data: docsInProject, error: docsErr } = await db.from(DOCUMENTS).select("id").eq("project_id", args.project_id);
  if (docsErr) return err(`Failed to list project documents for frozen-row scope: ${docsErr.message}`);
  const docIds = ((docsInProject ?? []) as Array<{ id: string }>).map((d) => d.id);
  let frozenOut: DocStalenessQueryResult["frozen_row_touches"] = [];
  if (docIds.length > 0) {
    const { data: frozenRows, error: frozenErr } = await db
      .from(GOV_FROZEN)
      .select("id, doc_item_id, document_id, op, changed_columns, changed_at")
      .in("document_id", docIds)
      .order("changed_at", { ascending: false })
      .limit(20);
    if (frozenErr) return err(`Failed to read gov.doc_frozen_row_touches: ${frozenErr.message}`);
    const rows = (frozenRows ?? []) as Array<{ id: string; doc_item_id: string; document_id: string; op: string; changed_columns: string[]; changed_at: string | Date }>;
    const frozenItemIds = rows.map((r) => r.doc_item_id);
    const frozenItems = await loadDoc_items(db, frozenItemIds);
    frozenOut = rows.map((r) => ({ ...r, changed_at: toIsoString(r.changed_at), doc_item_code: frozenItems.get(r.doc_item_id)?.code ?? null }));
  }

  // decay picture: every uat_case in the project, filtered in JS (attrs is JSONB).
  const { data: uatRows, error: uatErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, item_type, status, attrs")
    .eq("project_id", args.project_id)
    .eq("item_type", "uat_case");
  if (uatErr) return err(`Failed to list uat_case rows for decay summary: ${uatErr.message}`);
  const decayedRows = ((uatRows ?? []) as DocItemRow[]).filter((r) => isDecayed(r.attrs));
  const params = await loadDecayParams(db);
  const maxAgeDays =
    params.max_days != null
      ? Math.max(
          0,
          ...decayedRows.map((r) => {
            const since = (r.attrs?.["decay_since"] as string | undefined) ?? null;
            if (!since) return 0;
            return (Date.now() - new Date(since).getTime()) / 86_400_000;
          }),
          0
        )
      : 0;
  const forced =
    (params.threshold != null && decayedRows.length >= params.threshold) ||
    (params.max_days != null && maxAgeDays > params.max_days);

  const result: DocStalenessQueryResult = {
    markings: markingsOut,
    frozen_row_touches: frozenOut,
    decay: {
      threshold: params.threshold,
      max_days: params.max_days,
      exempt_classes: params.exempt_classes,
      decayed_uat_cases: decayedRows.map((r) => ({
        item_id: r.id,
        code: r.code,
        decay_since: (r.attrs?.["decay_since"] as string | undefined) ?? null,
        decay_cause_item: (r.attrs?.["decay_cause_item"] as string | undefined) ?? null,
      })),
      decayed_count: decayedRows.length,
      forced_rerun: forced,
      class_gate_note:
        "pg_rilancio_classi_esenti (deterministic checks always rerun) is read but NOT applied here — uat_case has " +
        "no check-class attribute in the schema yet to gate against. forced_rerun above ignores exemption; treat it " +
        "as a lower bound, not the final word, until the class field exists (declared gap, not a silent guess).",
    },
  };
  if (truncated) result.truncated = true;
  if (params.missing.length > 0) result.decay.params_missing = params.missing;
  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// doc_staleness_close — DEL-008's asked-for closure tool (GTD 03ffb9f5).
// Column-scoped UPDATE under doc_rw; the DB trigger fills closed_at/closed_by
// and rejects reopening a closed marking outright — this tool short-circuits
// on an already-closed row instead of hitting that rejection blind.
// ---------------------------------------------------------------------------

export interface DocStalenessCloseArgs {
  staleness_id: string;
  closed_outcome: string;
  closed_note?: string;
}

export interface DocStalenessCloseResult {
  staleness_id: string;
  status: "closed";
  closed_outcome: string;
  already_closed?: boolean;
}

export async function docStalenessClose(
  db: SupabaseClient,
  args: DocStalenessCloseArgs,
  _ctx: DocContext
): Promise<DocResult<DocStalenessCloseResult>> {
  if (!UUID_RE.test(args.staleness_id)) return err(`staleness_id must be a UUID.`);
  if (!(STALENESS_CLOSE_OUTCOMES as readonly string[]).includes(args.closed_outcome)) {
    return err(`Invalid closed_outcome '${args.closed_outcome}'. Allowed: ${STALENESS_CLOSE_OUTCOMES.join(", ")}.`);
  }
  if (args.closed_outcome === "no_impact" && (!args.closed_note || args.closed_note.trim() === "")) {
    return err(`closed_note is required when closed_outcome='no_impact' (gov.doc_subscription_staleness_no_impact_motivated).`);
  }

  const { data: row, error: rowErr } = await db
    .from(GOV_STALENESS)
    .select("id, status, closed_outcome")
    .eq("id", args.staleness_id)
    .maybeSingle();
  if (rowErr) return err(`Failed to load staleness marking: ${rowErr.message}`);
  if (!row) return err(`staleness '${args.staleness_id}' is not readable (not found, or hidden by RLS).`);
  const cur = row as { id: string; status: string; closed_outcome: string | null };

  if (cur.status === "closed") {
    return {
      ok: true,
      data: { staleness_id: cur.id, status: "closed", closed_outcome: cur.closed_outcome ?? args.closed_outcome, already_closed: true },
    };
  }

  const update: Record<string, unknown> = { status: "closed", closed_outcome: args.closed_outcome };
  if (args.closed_note) update.closed_note = args.closed_note;

  const { error: updErr } = await db.from(GOV_STALENESS).update(update).eq("id", cur.id).select("id").maybeSingle();
  if (updErr) {
    const m = updErr.message;
    if (/no_impact_motivated/i.test(m)) return err(`closed_note is required for outcome='no_impact'. Original: ${m}`);
    if (/close_own|42501|insufficient_privilege/i.test(m)) {
      return err(`Not legitimated to close '${cur.id}': closing is the subscriber's own act (their project only). Original: ${m}`);
    }
    return err(`Failed to close staleness marking: ${m}`);
  }

  const { data: after, error: afterErr } = await db.from(GOV_STALENESS).select("id, status, closed_outcome, closed_at").eq("id", cur.id).maybeSingle();
  if (afterErr || !after) return err(`Closure could not be confirmed: ${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`);
  const afterRow = after as { id: string; status: string; closed_outcome: string | null; closed_at: string | null };
  if (afterRow.status !== "closed" || afterRow.closed_outcome !== args.closed_outcome || !afterRow.closed_at) {
    return err(`Write NOT applied to '${cur.id}' as sent (D-132) — reads status='${afterRow.status}', outcome='${afterRow.closed_outcome}'.`);
  }

  return { ok: true, data: { staleness_id: cur.id, status: "closed", closed_outcome: afterRow.closed_outcome } };
}

// ---------------------------------------------------------------------------
// doc_decay_apply — the missing ring (GTD 1dffa01e/ddb6815c). Open marking +
// uat_case subscriber + eligible intent -> attrs.decay_status='decayed'. The
// marking is left OPEN — closing it is the separate, deliberate act of
// whoever reruns the UAT (doc_staleness_close), not a side effect of decaying.
// ---------------------------------------------------------------------------

export interface DocDecayApplyArgs {
  project_id: string;
  dry_run?: boolean;
}

export interface DocDecayApplyResult {
  applied: Array<{ item_id: string; code: string | null; decay_cause_item: string | null; staleness_id: string }>;
  already_decayed: Array<{ item_id: string; code: string | null; staleness_id: string }>;
  would_apply?: Array<{ item_id: string; code: string | null; staleness_id: string }>; // dry_run only
  skipped_ineligible: Array<{ staleness_id: string; reason: string }>;
  verdict: {
    threshold: number | null;
    max_days: number | null;
    decayed_count: number;
    forced_rerun: boolean;
    class_gate_note: string;
  };
}

export async function docDecayApply(
  db: SupabaseClient,
  args: DocDecayApplyArgs,
  _ctx: DocContext
): Promise<DocResult<DocDecayApplyResult>> {
  if (!UUID_RE.test(args.project_id)) return err(`project_id must be a UUID.`);
  const dryRun = args.dry_run ?? false;

  const loaded = await loadMarkingsForProject(db, args.project_id, "open", 200);
  if (!loaded.ok) return loaded;
  const { markings, subs, truncated } = loaded.data;

  const subscriberIds = markings.map((m) => subs.get(m.subscription_id)?.subscriber_item_id).filter(Boolean) as string[];
  const itemsById = await loadDoc_items(db, subscriberIds);

  const applied: DocDecayApplyResult["applied"] = [];
  const alreadyDecayed: DocDecayApplyResult["already_decayed"] = [];
  const wouldApply: NonNullable<DocDecayApplyResult["would_apply"]> = [];
  const skipped: DocDecayApplyResult["skipped_ineligible"] = [];

  const spec = DOC_ITEM_TYPE_REGISTRY["uat_case"];
  const targetIds = markings.map((m) => m.target_item_id);
  const targetItems = await loadDoc_items(db, targetIds);

  for (const m of markings) {
    const sub = subs.get(m.subscription_id);
    if (!sub) {
      skipped.push({ staleness_id: m.id, reason: "subscription no longer resolvable" });
      continue;
    }
    if (!DECAY_ELIGIBLE_INTENTS.has(sub.intent)) {
      skipped.push({ staleness_id: m.id, reason: `intent='${sub.intent}' is not decay-eligible (only critical|module)` });
      continue;
    }
    const item = itemsById.get(sub.subscriber_item_id);
    if (!item) {
      skipped.push({ staleness_id: m.id, reason: "subscriber row no longer resolvable" });
      continue;
    }
    if (item.item_type !== "uat_case") {
      skipped.push({ staleness_id: m.id, reason: `subscriber item_type='${item.item_type}' — this ring only decays uat_case (vertical slice, GTD ddb6815c)` });
      continue;
    }
    if (isDecayed(item.attrs)) {
      alreadyDecayed.push({ item_id: item.id, code: item.code, staleness_id: m.id });
      continue;
    }
    if (dryRun) {
      wouldApply.push({ item_id: item.id, code: item.code, staleness_id: m.id });
      continue;
    }

    const causeCode = targetItems.get(m.target_item_id)?.code ?? null;
    const merged = { ...(item.attrs ?? {}), decay_status: "decayed", decay_since: toIsoString(m.changed_at), decay_cause_item: causeCode };
    if (spec) {
      const schemaErrors = validateAttrs(spec.attrs_schema, merged);
      if (schemaErrors.length > 0) {
        skipped.push({ staleness_id: m.id, reason: `merged attrs would fail schema: ${schemaErrors.join("; ")}` });
        continue;
      }
    }

    const { error: updErr } = await db.from(DOC_ITEMS).update({ attrs: merged }).eq("id", item.id).select("id").maybeSingle();
    if (updErr) {
      skipped.push({ staleness_id: m.id, reason: `write failed: ${updErr.message}` });
      continue;
    }
    const { data: after, error: afterErr } = await db.from(DOC_ITEMS).select("id, attrs").eq("id", item.id).maybeSingle();
    if (afterErr || !after || (after as { attrs: Record<string, unknown> }).attrs?.["decay_status"] !== "decayed") {
      skipped.push({ staleness_id: m.id, reason: `write reported success but re-read does not confirm decay_status (D-132) — treat as UNCONFIRMED` });
      continue;
    }
    applied.push({ item_id: item.id, code: item.code, decay_cause_item: causeCode, staleness_id: m.id });
  }

  // Verdict is computed on the POST-write state (skipped when dry_run, since
  // nothing was written) — same decayed-count logic doc_staleness_query uses.
  const { data: uatRows, error: uatErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, item_type, status, attrs")
    .eq("project_id", args.project_id)
    .eq("item_type", "uat_case");
  if (uatErr) return err(`Failed to compute verdict: ${uatErr.message}`);
  const decayedRows = ((uatRows ?? []) as DocItemRow[]).filter((r) => isDecayed(r.attrs));
  const params = await loadDecayParams(db);
  const forced = params.threshold != null && decayedRows.length >= params.threshold;

  const result: DocDecayApplyResult = {
    applied,
    already_decayed: alreadyDecayed,
    skipped_ineligible: skipped,
    verdict: {
      threshold: params.threshold,
      max_days: params.max_days,
      decayed_count: decayedRows.length,
      forced_rerun: forced,
      class_gate_note:
        "exempt-class gate (pg_rilancio_classi_esenti) not applied — no check-class attribute on uat_case yet (declared gap, see doc_staleness_query).",
    },
  };
  if (dryRun) result.would_apply = wouldApply;
  if (truncated) skipped.push({ staleness_id: "(scan-truncated)", reason: "more than 200 open markings for this project — re-run to continue" });
  return { ok: true, data: result };
}

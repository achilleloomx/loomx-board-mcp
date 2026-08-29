// Subscription tools (DEL-002, items-subscription capitolato — design ratified
// D-186, SDES-SUB-000..007, doc 714d3313, project board-mcp 596cd5fc).
//
// Tables (dba migrations 20260821190000/191000/192000/200000 — DEL-001 +
// DEL-A2 opening, D-182): gov.doc_subscriptions, gov.doc_subscription_outcomes.
// Grants measured live 2026-08-21 under doc_rw: INSERT/SELECT/UPDATE on
// doc_subscriptions, INSERT/SELECT on doc_subscription_outcomes, SELECT-only
// on doc_versions/doc_version_items — no role has INSERT on doc_versions; the
// only writer is gov.doc_publish() SECURITY DEFINER (dba msg 401811d8, live
// 2026-08-21, signature aligned 1:1 to SDES-SUB-003 in msg cd8554f1). The 4th
// tool (doc_publish, below) calls it — never an INSERT.
//
// Identity is DERIVED, never a parameter (SDES-SUB-000 §1): the BEFORE
// INSERT/UPDATE trigger gov.doc_subscriptions_stamp_identity (and the
// equivalent on doc_subscription_outcomes) fills created_by/recorded_by from
// gov.caller_identity() — these tools never write an agent-identity column.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocResult, DocContext } from "./docs.js";
import { evaluateDecayGate } from "./staleness.js";

const GOV_DOC_SUBSCRIPTIONS = "gov.doc_subscriptions";
const GOV_DOC_SUBSCRIPTION_OUTCOMES = "gov.doc_subscription_outcomes";
const GOV_DOC_VERSIONS = "gov.doc_versions";
const GOV_DOC_VERSION_ITEMS = "gov.doc_version_items";
const DOC_ITEMS = "doc_items";
const DOCUMENTS = "documents";
const GOV_PARAMS = "loomx_governance_params";

// SDES-SUB-CP-004 §4 / REQ-SUB-013 criterion 3. The suspension flag lives in
// the parameter registry (numeric 0/1, owner declared per row); this tool is
// the admission surface that reads it. Suspension stops ADMITTING NEW targets,
// never the notifications already flowing — you retune before you extend, you
// don't switch the system off.
// Exported since v0.25.0: doc_fact_sync (factSync.ts) reads the SAME flag from
// the SAME helper — a derived 'fact' is still an admission, and a second reader
// with its own copy of the rule is how two surfaces drift apart.
export const ADMISSION_SUSPENDED_PARAM = "sottoscrizioni_ammissione_sospesa";

// SDES-SUB-012 (REQ-SUB-012) — "what binds everyone is not subscribable", a
// declared INTERIM approximation, not the durable rule. Loomy correction
// 2026-08-27 (msg 4162dfb7, replying to bc24b35f): the real criterion is a
// core/ambient CLASS read from a category/stream registry — a registry that
// does not exist in code yet. Gating on project residency is the exact defect
// class this rejects elsewhere; it is tolerated here ONLY as a transitional
// stand-in because today every cross-project decision happens to live in the
// hub project's two `decisions` documents. This decays at the domain-manifest
// migration — a manifest is also cross-project and MUST stay subscribable, so
// this check must never widen to "any hub-project item" and must be replaced,
// not extended, once the class lives in the registry.
export const HUB_PROJECT_ID = "22ae4e79-1800-4975-ba46-cd2f86734257";
export const HUB_UNSUBSCRIBABLE_DOCUMENT_TYPE = "decisions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Duck-typed access to the doc_rw SAVEPOINT capability (docDb.ts DocRwDb) — mirrors
// the docRwHandle pattern in docs.ts. Absent under fakes that don't implement it
// (they degrade to the no-op below, same as the mgmt backend).
function savepointHandle(db: SupabaseClient): {
  savepoint: (name: string) => Promise<void>;
  rollbackToSavepoint: (name: string) => Promise<void>;
} | null {
  const h = db as unknown as {
    __docRw?: boolean;
    savepoint?: (name: string) => Promise<void>;
    rollbackToSavepoint?: (name: string) => Promise<void>;
  };
  if (h.__docRw && h.savepoint && h.rollbackToSavepoint) {
    return { savepoint: h.savepoint, rollbackToSavepoint: h.rollbackToSavepoint };
  }
  return null;
}

// Reads the admission-suspension flag. Three outcomes, deliberately distinct:
// suspended (a value in force, non-zero), open (in force, zero), or UNVERIFIED
// — the row is missing, deprecated, or unreadable. Unverified never blocks:
// a registry that can't be read is not evidence of a suspension, and walling
// off every new subscription on a missing parameter would be a far worse
// failure than the one this gate prevents. But it is never silent either: the
// caller gets `admission_gate` telling them the flag could not be verified, so
// a suspension nobody can observe cannot pass for a suspension nobody declared
// (same principle as `missing` in staleness.ts loadDecayParams).
export interface AdmissionGate {
  suspended: boolean;
  verified: boolean;
  value: number | null;
  owner: string | null;
  reason?: string;
}

export async function readAdmissionGate(db: SupabaseClient): Promise<AdmissionGate> {
  const { data, error } = await db
    .from(GOV_PARAMS)
    .select("param_key, value_numeric, owner_agent_code, deprecated_at")
    .eq("param_key", ADMISSION_SUSPENDED_PARAM);
  if (error) {
    return { suspended: false, verified: false, value: null, owner: null, reason: `registry read failed: ${error.message}` };
  }
  const rows = (data ?? []) as Array<{ value_numeric: number | string | null; owner_agent_code: string | null; deprecated_at: string | null }>;
  const live = rows.filter((r) => !r.deprecated_at);
  if (live.length === 0) {
    return {
      suspended: false,
      verified: false,
      value: null,
      owner: null,
      reason: rows.length > 0 ? `'${ADMISSION_SUSPENDED_PARAM}' is deprecated in the registry` : `'${ADMISSION_SUSPENDED_PARAM}' is not in the registry (or not readable)`,
    };
  }
  // node-pg returns `numeric` as a string — coerce, never compare loosely.
  const raw = live[0].value_numeric;
  const num = raw == null ? null : Number(raw);
  if (num == null || Number.isNaN(num)) {
    return { suspended: false, verified: false, value: null, owner: live[0].owner_agent_code ?? null, reason: `'${ADMISSION_SUSPENDED_PARAM}' has no numeric value in force` };
  }
  return { suspended: num !== 0, verified: true, value: num, owner: live[0].owner_agent_code ?? null };
}

export const SUBSCRIBE_INTENTS = ["informative", "module", "critical"] as const;
export const SUBSCRIPTION_OUTCOMES = ["updated", "no_impact", "feedback_sent"] as const;
export const BUMP_CLASSES = ["patch", "minor", "major"] as const;
type Intent = (typeof SUBSCRIBE_INTENTS)[number];
type Outcome = (typeof SUBSCRIPTION_OUTCOMES)[number];
type BumpClass = (typeof BUMP_CLASSES)[number];

function err(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}
function nowIso(): string {
  return new Date().toISOString();
}

// D-167-style: never let a probe failure assert a certainty the call didn't
// establish. agentInProject is the same SECURITY DEFINER helper docs.ts uses.
function docRwHandle(db: SupabaseClient): { agentInProject?: (p: string) => Promise<boolean> } | null {
  const h = db as unknown as { __docRw?: boolean; agentInProject?: (p: string) => Promise<boolean> };
  return h.__docRw ? { agentInProject: h.agentInProject } : null;
}

// ---------------------------------------------------------------------------
// doc_subscribe — SDES-SUB-001. Covers CHOICE origins only (voluntary, topic,
// invite-accepted-once-DEL-009-lands); FACT origins (constitutive link,
// role/matrix) are automatic and never pass through this tool.
// ---------------------------------------------------------------------------

export interface DocSubscribeArgs {
  subscriber_item_id: string;
  target_item_id?: string;
  target_document_id?: string;
  intent: string;
  note: string;
}

export interface DocSubscribeResult {
  subscription_id: string;
  created: boolean;
  intent: string;
  intent_changed?: { from: string; to: string };
  subscribed_at_version: string;
  target_kind: "item" | "document";
  // Present only when the admission-suspension flag could not be verified
  // (SDES-SUB-CP-004 §4) — the subscription was created anyway.
  admission_gate?: string;
}

export async function docSubscribe(
  db: SupabaseClient,
  args: DocSubscribeArgs,
  ctx: DocContext
): Promise<DocResult<DocSubscribeResult>> {
  if (!UUID_RE.test(args.subscriber_item_id)) {
    return err(`subscriber_item_id must be a UUID, got '${args.subscriber_item_id}'.`);
  }
  if (!SUBSCRIBE_INTENTS.includes(args.intent as Intent)) {
    return err(`Invalid intent '${args.intent}'. Allowed: ${SUBSCRIBE_INTENTS.join(", ")}.`);
  }
  if (!args.note || args.note.trim() === "") {
    return err(`note is required — the reason FOR subscribing (gov.doc_subscriptions.note is NOT NULL, non-empty).`);
  }
  const hasItem = !!args.target_item_id;
  const hasDoc = !!args.target_document_id;
  if (hasItem === hasDoc) {
    return err(`Exactly one of target_item_id (row-level) or target_document_id (document-level watch) is required.`);
  }
  if (hasItem && !UUID_RE.test(args.target_item_id!)) return err(`target_item_id must be a UUID.`);
  if (hasDoc && !UUID_RE.test(args.target_document_id!)) return err(`target_document_id must be a UUID.`);
  if (hasItem && args.target_item_id === args.subscriber_item_id) {
    return err(`Cannot subscribe an item to itself.`);
  }

  // Subscriber row: must exist; caller must be legitimated on it (owner, a
  // member of its project, or loomy — SDES-SUB-001 §1).
  const { data: subRow, error: subErr } = await db
    .from(DOC_ITEMS)
    .select("id, project_id, owner")
    .eq("id", args.subscriber_item_id)
    .maybeSingle();
  if (subErr) return err(`Failed to load subscriber_item_id: ${subErr.message}`);
  if (!subRow) {
    return err(`subscriber_item_id '${args.subscriber_item_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS).`);
  }
  const sub = subRow as { id: string; project_id: string; owner: string | null };

  if (!ctx.isLoomy && sub.owner !== ctx.selfSlug) {
    const rw = docRwHandle(db);
    const member = rw?.agentInProject ? await rw.agentInProject(sub.project_id) : false;
    if (!member) {
      return err(
        `Not legitimated to subscribe on behalf of doc_item '${sub.id}': you are neither its owner ` +
        `('${sub.owner ?? "none"}') nor a member of project ${sub.project_id}.`
      );
    }
  }

  // Target: must be readable — the real floor is RLS ("subscribe only to what
  // you read", DEL-001 c); never reveal whether an unreadable target exists.
  let targetDocumentId: string;
  let targetProjectId: string;
  if (hasItem) {
    const { data: tRow, error: tErr } = await db
      .from(DOC_ITEMS)
      .select("id, document_id, project_id")
      .eq("id", args.target_item_id)
      .maybeSingle();
    if (tErr) return err(`Failed to load target_item_id: ${tErr.message}`);
    if (!tRow) {
      return err(
        `target_item_id '${args.target_item_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS — ` +
        `this tool never tells the two apart, D-167).`
      );
    }
    const t = tRow as { id: string; document_id: string; project_id: string };
    targetDocumentId = t.document_id;
    targetProjectId = t.project_id;
  } else {
    const { data: dRow, error: dErr } = await db
      .from(DOCUMENTS)
      .select("id, project_id")
      .eq("id", args.target_document_id)
      .maybeSingle();
    if (dErr) return err(`Failed to load target_document_id: ${dErr.message}`);
    if (!dRow) {
      return err(
        `target_document_id '${args.target_document_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS — D-167).`
      );
    }
    const d = dRow as { id: string; project_id: string };
    targetDocumentId = d.id;
    targetProjectId = d.project_id;
  }

  // subscribed_at_version = the target document's CURRENT documents.version —
  // fetched once, alongside document_type for the REQ-SUB-012 gate below.
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, version, document_type")
    .eq("id", targetDocumentId)
    .maybeSingle();
  if (docErr) return err(`Failed to load target document: ${docErr.message}`);
  if (!docRow) return err(`Target document ${targetDocumentId} could not be read for its version.`);
  const targetDoc = docRow as { id: string; version: unknown; document_type: string };
  const subscribedAtVersion = String(targetDoc.version ?? "");

  // REQ-SUB-012: what binds the whole org is never subscribable — see
  // HUB_PROJECT_ID comment above for why this specific gate (SDES-SUB-012).
  // Applies to every intent, not just 'critical' — an org-wide constraint
  // opted into voluntarily isn't a constraint (REQ-SUB-012 body).
  if (targetProjectId === HUB_PROJECT_ID && targetDoc.document_type === HUB_UNSUBSCRIBABLE_DOCUMENT_TYPE) {
    return err(
      `Cannot subscribe: the target is a cross-project decision in the hub project (${HUB_PROJECT_ID}) — these bind ` +
      `the whole fleet without an opt-in act, so they are not subscribable (REQ-SUB-012). This check is a declared ` +
      `INTERIM approximation (SDES-SUB-012): the durable rule is a core/ambient CLASS read from a category registry, ` +
      `not project residency — it will replace this gate once that registry exists, and domain manifests (also ` +
      `cross-project) will stay subscribable when it does.`
    );
  }

  // Critical cross-project: refused in v1 (SDES-SUB-001 §4, D-186 Q2).
  if (args.intent === "critical" && targetProjectId !== sub.project_id) {
    return err(
      `A 'critical' subscription across projects is refused in v1 (D-186 Q2): it needs an explicit act plus ` +
      `acceptance from the target's owner, never automatic creation (that flow is A3/DEL-009, not yet built). ` +
      `Use board_send to the target's owning agent instead, or subscribe with intent='module'|'informative'.`
    );
  }

  // Existing active subscription for this exact (subscriber, target) pair?
  let existingQ = db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, intent, subscribed_at_version")
    .eq("subscriber_item_id", args.subscriber_item_id)
    .eq("status", "active");
  existingQ = hasItem
    ? existingQ.eq("target_item_id", args.target_item_id)
    : existingQ.eq("target_document_id", args.target_document_id);
  const { data: existingRows, error: existErr } = await existingQ;
  if (existErr) return err(`Failed to check for an existing subscription: ${existErr.message}`);
  const existing = (Array.isArray(existingRows) ? existingRows : [])[0] as
    | { id: string; intent: string; subscribed_at_version: string }
    | undefined;

  if (existing) {
    if (existing.intent === args.intent) {
      return {
        ok: true,
        data: {
          subscription_id: existing.id,
          created: false,
          intent: existing.intent,
          subscribed_at_version: existing.subscribed_at_version,
          target_kind: hasItem ? "item" : "document",
        },
      };
    }
    // Re-call with a different intent = a grade change (SDES-SUB-001 §6).
    // Captured BEFORE the update: `existing` must read as the pre-image even
    // if a caller's DB client returns row objects that don't snapshot cleanly.
    const previousIntent = existing.intent;
    const { error: updErr } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .update({ intent: args.intent })
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (updErr) return err(`Failed to change subscription grade: ${updErr.message}`);
    const { data: after, error: afterErr } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .select("id, intent, subscribed_at_version")
      .eq("id", existing.id)
      .maybeSingle();
    if (afterErr || !after) {
      return err(`Subscription intent update could not be confirmed: ${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`);
    }
    const afterRow = after as { id: string; intent: string; subscribed_at_version: string };
    if (afterRow.intent !== args.intent) {
      return err(
        `Write NOT applied to subscription '${existing.id}': intent reads '${afterRow.intent}', expected '${args.intent}' ` +
        `(RLS denial under doc_rw affects 0 rows silently).`
      );
    }
    return {
      ok: true,
      data: {
        subscription_id: existing.id,
        created: false,
        intent: afterRow.intent,
        intent_changed: { from: previousIntent, to: args.intent },
        subscribed_at_version: afterRow.subscribed_at_version,
        target_kind: hasItem ? "item" : "document",
      },
    };
  }

  // Admission gate (SDES-SUB-CP-004 §4, REQ-SUB-013 criterion 3). Positioned
  // HERE on purpose — after the idempotent and grade-change branches above,
  // immediately before the only path that actually admits something new:
  //   - re-calling with the same intent returns the existing row: it admits
  //     nothing, so suspending it would break idempotent callers without
  //     suspending anything;
  //   - changing the grade of an existing subscription is a change to a target
  //     already admitted, not a new admission. It is deliberately NOT blocked.
  //     If a suspension should also freeze grade upgrades, that is a widening
  //     of the rule and belongs to whoever governs it — not to this gate
  //     quietly reading more into "l'ammissione di nuovi documenti" than it says.
  const gate = await readAdmissionGate(db);
  if (gate.suspended) {
    return err(
      `Admission to subscriptions is SUSPENDED: '${ADMISSION_SUSPENDED_PARAM}' is ${gate.value} in the governance ` +
      `parameter registry${gate.owner ? ` (owner ${gate.owner})` : ""} — a noise measure was exceeded and extension is ` +
      `paused until the thresholds are retuned (REQ-SUB-013 criterion 3, SDES-SUB-CP-004 §4). This suspends NEW ` +
      `subscriptions only: existing subscriptions and their notifications keep running untouched, and re-calling ` +
      `doc_subscribe on a subscription you already hold still works. The flag is a deliberate human act, reversible ` +
      `via gov_param_set by its declared owner, and its value and history are readable in loomx_governance_params.`
    );
  }

  // INSERT — origin is ALWAYS 'choice' from this tool (SDES-SUB-001 intro:
  // 'fact' origins are constitutive/automatic, out of scope here).
  const insert: Record<string, unknown> = {
    subscriber_item_id: args.subscriber_item_id,
    subscriber_project_id: sub.project_id,
    intent: args.intent,
    subscribed_at_version: subscribedAtVersion,
    note: args.note,
    origin: "choice",
    status: "active", // explicit, not left to the column DEFAULT (D-132 re-read must see it either way)
  };
  if (hasItem) insert.target_item_id = args.target_item_id;
  else insert.target_document_id = args.target_document_id;

  const { data, error } = await db.from(GOV_DOC_SUBSCRIPTIONS).insert(insert).select("id").maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row returned";
    if (/doc_subscriptions_insert_floor|42501|insufficient_privilege/i.test(m)) {
      return err(
        `Subscription rejected: either you are not a member of project ${sub.project_id}, or the target is not ` +
        `readable by you (DEL-001 c: "subscribe only to what you read"). Original: ${m}`
      );
    }
    if (/doc_subscriptions_no_self/i.test(m)) return err(`Cannot subscribe an item to itself.`);
    return err(`Failed to create subscription: ${m}`);
  }
  const newId = (data as { id: string }).id;

  const { data: after, error: afterErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, intent, subscribed_at_version, note, origin, status")
    .eq("id", newId)
    .maybeSingle();
  if (afterErr || !after) {
    return err(
      `Subscription insert reported success but the row is not readable at id '${newId}': ${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`
    );
  }
  const afterRow = after as { id: string; intent: string; subscribed_at_version: string; note: string; origin: string; status: string };
  if (afterRow.intent !== args.intent || afterRow.note !== args.note || afterRow.origin !== "choice" || afterRow.status !== "active") {
    return err(`Subscription '${newId}' was inserted but does not match what was sent (D-132) — treat as UNCONFIRMED.`);
  }

  const created: DocSubscribeResult = {
    subscription_id: newId,
    created: true,
    intent: afterRow.intent,
    subscribed_at_version: afterRow.subscribed_at_version,
    target_kind: hasItem ? "item" : "document",
  };
  if (!gate.verified) {
    created.admission_gate = `NOT VERIFIED — ${gate.reason ?? "unknown"}. The subscription was created; the admission-suspension flag ('${ADMISSION_SUSPENDED_PARAM}', SDES-SUB-CP-004 §4) could not be read, so this call cannot assert that admission is open.`;
  }
  return { ok: true, data: created };
}

// ---------------------------------------------------------------------------
// doc_unsubscribe — SDES-SUB-002. Tombstone only, never DELETE (DB trigger
// gov.doc_subscriptions_no_delete rejects DELETE unconditionally).
// ---------------------------------------------------------------------------

export interface DocUnsubscribeArgs {
  subscription_id: string;
  reason?: string;
}

export interface DocUnsubscribeResult {
  subscription_id: string;
  status: "tombstoned";
  already_tombstoned?: boolean;
}

export async function docUnsubscribe(
  db: SupabaseClient,
  args: DocUnsubscribeArgs,
  ctx: DocContext
): Promise<DocResult<DocUnsubscribeResult>> {
  if (!UUID_RE.test(args.subscription_id)) return err(`subscription_id must be a UUID.`);

  const { data: row, error: rowErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, subscriber_item_id, status, origin, note")
    .eq("id", args.subscription_id)
    .maybeSingle();
  if (rowErr) return err(`Failed to load subscription: ${rowErr.message}`);
  if (!row) return err(`subscription '${args.subscription_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS).`);
  const sub = row as { id: string; subscriber_item_id: string; status: string; origin: string; note: string };

  // Legitimation: owner of the subscriber row, or loomy (SDES-SUB-002 §1).
  if (!ctx.isLoomy) {
    const { data: itemRow, error: itemErr } = await db
      .from(DOC_ITEMS)
      .select("id, owner")
      .eq("id", sub.subscriber_item_id)
      .maybeSingle();
    if (itemErr) return err(`Failed to verify ownership: ${itemErr.message}`);
    const owner = (itemRow as { owner: string | null } | null)?.owner ?? null;
    if (owner !== ctx.selfSlug) {
      return err(
        `Not legitimated to unsubscribe '${args.subscription_id}': you are not the owner ('${owner ?? "none"}') of its ` +
        `subscriber row, and only loomy can act cross-agent here.`
      );
    }
  }

  // SEC-011: exit only from a CHOICE, never a FACT. The DB-floor trigger is
  // ratified (D-186 §2) AND applied since 2026-08-22 (dba migration
  // 20260822100000, msg 1051fdb7; verified live: tombstone on 'fact' → 42501,
  // on 'choice' → succeeds). This tool-floor check is therefore redundant with
  // the floor, and deliberately kept: it names the rule to the caller instead
  // of letting a bare 42501 do it. Not a stand-in for a missing floor.
  if (sub.origin === "fact") {
    return err(
      `Cannot unsubscribe '${args.subscription_id}': it originates from a structural fact (origin='fact'), not a ` +
      `choice (SEC-011) — exit by removing the underlying link/role that created it, not by tombstoning here. ` +
      `(The DB floor enforces this too — D-186 §2, live since 2026-08-22; this message just names the rule.)`
    );
  }

  if (sub.status === "tombstoned") {
    return { ok: true, data: { subscription_id: sub.id, status: "tombstoned", already_tombstoned: true } };
  }

  const update: Record<string, unknown> = { status: "tombstoned", tombstoned_at: nowIso() };
  if (args.reason && args.reason.trim() !== "") {
    // gov.doc_subscriptions has no `reason` column (schema gap, not covered by
    // DEL-001/D-186) — appended to `note` instead, same append-not-overwrite
    // pattern as wi_end's `[BLOCKER]` (SDES-007), never silently dropped.
    update.note = `${sub.note}\n[unsubscribed: ${args.reason.trim()}]`;
  }

  const { error: updErr } = await db.from(GOV_DOC_SUBSCRIPTIONS).update(update).eq("id", sub.id).select("id").maybeSingle();
  if (updErr) return err(`Failed to tombstone subscription: ${updErr.message}`);

  const { data: after, error: afterErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, status, tombstoned_at")
    .eq("id", sub.id)
    .maybeSingle();
  if (afterErr || !after) return err(`Tombstone could not be confirmed: ${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`);
  const afterRow = after as { id: string; status: string; tombstoned_at: string | null };
  if (afterRow.status !== "tombstoned" || !afterRow.tombstoned_at) {
    return err(
      `Write NOT applied to subscription '${sub.id}' — status reads '${afterRow.status}' (RLS denial under doc_rw affects 0 rows silently).`
    );
  }

  return { ok: true, data: { subscription_id: sub.id, status: "tombstoned" } };
}

// ---------------------------------------------------------------------------
// doc_subscription_outcome — SDES-SUB-004. Append-only, one row per
// (subscription × publication). An ACT, not a state — no_impact never
// inherits to the next version (D-151).
// ---------------------------------------------------------------------------

export interface DocSubscriptionOutcomeArgs {
  subscription_id: string;
  version: string;
  outcome: string;
  note?: string;
  wi_id?: string;
  message_id?: string;
}

export interface DocSubscriptionOutcomeResult {
  outcome_id: string;
  subscription_id: string;
  publication_id: string;
  version: string;
  outcome: string;
  created: boolean;
}

export async function docSubscriptionOutcome(
  db: SupabaseClient,
  args: DocSubscriptionOutcomeArgs,
  ctx: DocContext
): Promise<DocResult<DocSubscriptionOutcomeResult>> {
  if (!UUID_RE.test(args.subscription_id)) return err(`subscription_id must be a UUID.`);
  if (!SUBSCRIPTION_OUTCOMES.includes(args.outcome as Outcome)) {
    return err(`Invalid outcome '${args.outcome}'. Allowed: ${SUBSCRIPTION_OUTCOMES.join(", ")}.`);
  }
  if ((args.outcome === "no_impact" || args.outcome === "feedback_sent") && (!args.note || args.note.trim() === "")) {
    return err(`note is required when outcome='${args.outcome}' (the motivation, or the feedback reference).`);
  }
  if (args.wi_id && !UUID_RE.test(args.wi_id)) return err(`wi_id must be a UUID.`);
  if (args.message_id && !UUID_RE.test(args.message_id)) return err(`message_id must be a UUID.`);

  const { data: subRow, error: subErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, subscriber_item_id, target_item_id, target_document_id, status, tombstoned_at")
    .eq("id", args.subscription_id)
    .maybeSingle();
  if (subErr) return err(`Failed to load subscription: ${subErr.message}`);
  if (!subRow) return err(`subscription '${args.subscription_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS).`);
  const sub = subRow as {
    id: string;
    subscriber_item_id: string;
    target_item_id: string | null;
    target_document_id: string | null;
    status: string;
    tombstoned_at: string | null;
  };

  // Legitimation: owner of the subscriber row (SDES-SUB-004 §1) — the outcome
  // is the analyst's act, not the producer's.
  if (!ctx.isLoomy) {
    const { data: itemRow, error: itemErr } = await db
      .from(DOC_ITEMS)
      .select("id, owner")
      .eq("id", sub.subscriber_item_id)
      .maybeSingle();
    if (itemErr) return err(`Failed to verify ownership: ${itemErr.message}`);
    const owner = (itemRow as { owner: string | null } | null)?.owner ?? null;
    if (owner !== ctx.selfSlug) {
      return err(
        `Not legitimated to record an outcome for '${args.subscription_id}': you are not the owner ('${owner ?? "none"}') ` +
        `of its subscriber row.`
      );
    }
  }

  let targetDocumentId = sub.target_document_id;
  if (!targetDocumentId && sub.target_item_id) {
    const { data: tRow, error: tErr } = await db
      .from(DOC_ITEMS)
      .select("id, document_id")
      .eq("id", sub.target_item_id)
      .maybeSingle();
    if (tErr) return err(`Failed to resolve the subscription's target document: ${tErr.message}`);
    if (!tRow) return err(`Target of subscription '${args.subscription_id}' is no longer readable — cannot resolve its document.`);
    targetDocumentId = (tRow as { document_id: string }).document_id;
  }
  if (!targetDocumentId) return err(`Subscription '${args.subscription_id}' has no resolvable target document.`);

  // Resolve version LABEL → gov.doc_versions row (the table stores
  // publication_id, not a bare version string — SDES-SUB-004 exposes `version`
  // as the ergonomic param; this is the translation).
  const { data: pubRow, error: pubErr } = await db
    .from(GOV_DOC_VERSIONS)
    .select("id, published_at")
    .eq("document_id", targetDocumentId)
    .eq("version_label", args.version)
    .maybeSingle();
  if (pubErr) return err(`Failed to resolve version '${args.version}' on document ${targetDocumentId}: ${pubErr.message}`);
  if (!pubRow) {
    return err(
      `version '${args.version}' has never been published on document ${targetDocumentId} (no matching row in ` +
      `gov.doc_versions) — an outcome on an unpublished version is an error, not a fact.`
    );
  }
  const pub = pubRow as { id: string; published_at: string };

  // A tombstoned subscription can still be worked "until closure" (SEC-011) —
  // but only for versions published AT OR BEFORE the tombstone, never after
  // (SDES-SUB-004 §3).
  if (sub.status === "tombstoned" && sub.tombstoned_at && new Date(pub.published_at) > new Date(sub.tombstoned_at)) {
    return err(
      `Subscription '${args.subscription_id}' was tombstoned at ${sub.tombstoned_at}, before version '${args.version}' ` +
      `was published (${pub.published_at}). No outcome is expected for a version published after exit.`
    );
  }

  const insert: Record<string, unknown> = {
    subscription_id: args.subscription_id,
    publication_id: pub.id,
    outcome: args.outcome,
  };
  if (args.note) insert.note = args.note;
  if (args.wi_id) insert.wi_id = args.wi_id;
  if (args.message_id) insert.message_id = args.message_id;

  // Bug d6a57035 (atlas, DEL-006 dogfood): the whole handler runs in ONE open
  // transaction (docDb.ts runWithPool). Without a savepoint, a duplicate-key INSERT
  // aborts that transaction and the follow-up re-read below dies with "current
  // transaction is aborted" — masking BOTH the no-op and the differs-refusal.
  const sp = savepointHandle(db);
  const SAVEPOINT_NAME = "doc_subscription_outcome_ins";
  if (sp) await sp.savepoint(SAVEPOINT_NAME);

  const { data, error } = await db.from(GOV_DOC_SUBSCRIPTION_OUTCOMES).insert(insert).select("id").maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row returned";
    if (/duplicate key|doc_subscription_outcomes_once/i.test(m)) {
      // Idempotent retry vs. a genuine second (different) act — tell them apart
      // (SDES-SUB-004 §4: the ledger never corrects, only integrates). Restore a
      // live transaction first (see comment above) so this re-read can actually run.
      if (sp) await sp.rollbackToSavepoint(SAVEPOINT_NAME);
      const { data: exRows, error: exErr } = await db
        .from(GOV_DOC_SUBSCRIPTION_OUTCOMES)
        .select("id, outcome, note, wi_id, message_id")
        .eq("subscription_id", args.subscription_id)
        .eq("publication_id", pub.id);
      if (exErr || !Array.isArray(exRows) || exRows.length === 0) {
        return err(`This (subscription, version) already has an outcome, and it could not be re-read to compare: ${exErr?.message ?? "no row"}.`);
      }
      const ex = exRows[0] as { id: string; outcome: string; note: string | null; wi_id: string | null; message_id: string | null };
      const same =
        ex.outcome === args.outcome &&
        (ex.note ?? null) === (args.note ?? null) &&
        (ex.wi_id ?? null) === (args.wi_id ?? null) &&
        (ex.message_id ?? null) === (args.message_id ?? null);
      if (same) {
        return {
          ok: true,
          data: {
            outcome_id: ex.id,
            subscription_id: args.subscription_id,
            publication_id: pub.id,
            version: args.version,
            outcome: ex.outcome,
            created: false,
          },
        };
      }
      return err(
        `subscription '${args.subscription_id}' already has an outcome for version '${args.version}' (outcome='${ex.outcome}') ` +
        `that DIFFERS from this call. The ledger does not correct — it integrates: send a follow-up via board_send instead.`
      );
    }
    if (/foreign key/i.test(m)) return err(`Reference not found (subscription_id/wi_id/message_id wrong?). Original: ${m}`);
    if (/no_impact_motivated/i.test(m)) return err(`note is required for outcome='no_impact'. Original: ${m}`);
    return err(`Failed to record outcome: ${m}`);
  }
  const newId = (data as { id: string }).id;

  const { data: after, error: afterErr } = await db
    .from(GOV_DOC_SUBSCRIPTION_OUTCOMES)
    .select("id, subscription_id, publication_id, outcome, note, wi_id, message_id")
    .eq("id", newId)
    .maybeSingle();
  if (afterErr || !after) {
    return err(`Outcome insert reported success but the row is not readable at id '${newId}': ${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`);
  }
  const afterRow = after as { id: string; outcome: string };
  if (afterRow.outcome !== args.outcome) {
    return err(`Outcome '${newId}' was inserted but does not match what was sent (D-132) — treat as UNCONFIRMED.`);
  }

  return {
    ok: true,
    data: {
      outcome_id: newId,
      subscription_id: args.subscription_id,
      publication_id: pub.id,
      version: args.version,
      outcome: afterRow.outcome,
      created: true,
    },
  };
}

// ---------------------------------------------------------------------------
// doc_publish — SDES-SUB-003 (4th subscription tool). The explicit act of
// publication: verifies the changelog, bumps the header, appends to
// gov.doc_versions via gov.doc_publish() — the only writer that ledger will
// ever grant (Q5, dba msg 41fa192b/cd8554f1/401811d8). No fan-out starts on a
// plain edit; it starts HERE (guard against STOP-002).
// ---------------------------------------------------------------------------

export interface DocPublishArgs {
  document_id: string;
  new_version: string;
  bump_class: string;
  changelog_entry_id: string;
  delta_summary: string;
}

export interface DocPublishResult {
  publication_id: string;
  document_id: string;
  version_seq: number;
  version_label: string;
  bump_class: string;
  changelog_entry_id: string;
  published_at: string;
  // Present when the decay gate did NOT block but had something to say: decayed
  // tests below threshold, or thresholds that could not be read. A publication
  // that went through with stale greens under it should say so on the way out.
  decay_notice?: string;
}

export async function docPublish(
  db: SupabaseClient,
  args: DocPublishArgs,
  ctx: DocContext
): Promise<DocResult<DocPublishResult>> {
  if (!UUID_RE.test(args.document_id)) return err(`document_id must be a UUID.`);
  if (!UUID_RE.test(args.changelog_entry_id)) return err(`changelog_entry_id must be a UUID.`);
  if (!args.new_version || args.new_version.trim() === "") return err(`new_version is required.`);
  if (!BUMP_CLASSES.includes(args.bump_class as BumpClass)) {
    return err(`Invalid bump_class '${args.bump_class}'. Allowed: ${BUMP_CLASSES.join(", ")}.`);
  }
  if (!args.delta_summary || args.delta_summary.trim() === "") {
    return err(`delta_summary is required — the summary the ledger stores and the notification carries.`);
  }

  // Document must exist and be readable; legitimation = owner or loomy (SDES-SUB-003 §2).
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, project_id, owner, version, document_type")
    .eq("id", args.document_id)
    .maybeSingle();
  if (docErr) return err(`Failed to load document: ${docErr.message}`);
  if (!docRow) {
    return err(`document_id '${args.document_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS).`);
  }
  const doc = docRow as { id: string; project_id: string; owner: string | null; version: string | null; document_type: string };

  // working_doc is never publishable (REQ-DOCM-018, SDES-DOCM-018): scratchpad
  // material, no `approved` status, deliberately un-tracked. Tool-floor guard,
  // defense in depth alongside whatever gov.doc_publish() enforces server-side
  // — same pattern as the changelog gate above, never trust a single layer.
  if (doc.document_type === "working_doc") {
    return err(`document_id '${doc.id}' is a working_doc — never publishable (REQ-DOCM-018). Migrate its content into a normative document type first.`);
  }

  if (!ctx.isLoomy && doc.owner !== ctx.selfSlug) {
    return err(
      `Not legitimated to publish document '${doc.id}': you are not its owner ('${doc.owner ?? "none"}'), and only ` +
      `loomy can publish cross-agent (SDES-SUB-003 §2).`
    );
  }

  // Decay gate (GTD 56a815b4, mandate 1dffa01e point 5, closed inside PR-2b).
  // "Sopra soglia il rilancio dei collaudi decaduti deve essere OBBLIGATORIO
  // prima di pubblicare una consegna — non solo visibile nel verdetto." The
  // visibility already existed (doc_staleness_query.decay.forced_rerun); this is
  // the obligation. Scoped to the document's own project: a project publishes
  // against its own decayed tests, never against the fleet's.
  //
  // Ordered AFTER legitimation (never disclose a project's state to someone who
  // cannot publish it) but BEFORE the changelog checks, deliberately. The first
  // live run had it last and the probe came back complaining about a changelog
  // id instead: between "your parameter is wrong" and "this project cannot
  // publish right now", the second is the one that changes the caller's plan —
  // delivering it after they have built a changelog entry delivers it too late.
  const decayGate = await evaluateDecayGate(db, doc.project_id);
  if (decayGate.blocking) {
    const list = decayGate.decayed
      .slice(0, 10)
      .map((d) => d.code ?? d.item_id)
      .join(", ");
    const more = decayGate.decayed.length > 10 ? ` (+${decayGate.decayed.length - 10} more)` : "";
    return err(
      `Publication REFUSED — decayed tests must be rerun first (${decayGate.reasons.join("; ")}). Decayed: ${list}${more}. ` +
      `A decayed test is one whose subject was substantively rewritten after it passed (D-201/M2): its green is stale, ` +
      `and publishing over it would ship a verdict nobody has re-earned. Two legitimate ways out, both explicit: rerun ` +
      `the tests and close their markings with doc_staleness_close(outcome='updated'), or close them as 'no_impact' with ` +
      `a written motivation. There is deliberately no force flag on this gate. Thresholds come from ` +
      `loomx_governance_params (pg_rilancio_soglia_decaduti=${decayGate.threshold}, pg_rilancio_giorni_max=${decayGate.max_days}), ` +
      `not from code. ${decayGate.class_gate_note}`
    );
  }

  // Changelog gate (tool-floor, defense in depth — the function re-checks this
  // server-side too, dba msg 401811d8): pubblicare senza changelog è impossibile
  // by-construction (SDES-SUB-003 §1).
  const { data: chRow, error: chErr } = await db
    .from(DOC_ITEMS)
    .select("id, item_type, document_id, project_id, attrs")
    .eq("id", args.changelog_entry_id)
    .maybeSingle();
  if (chErr) return err(`Failed to load changelog_entry_id: ${chErr.message}`);
  if (!chRow) {
    return err(
      `changelog_entry_id '${args.changelog_entry_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS).`
    );
  }
  const ch = chRow as { id: string; item_type: string; document_id: string; project_id: string; attrs: Record<string, unknown> | null };
  if (ch.item_type !== "changelog_entry") {
    return err(`changelog_entry_id '${ch.id}' has item_type='${ch.item_type}', expected 'changelog_entry'.`);
  }
  if (ch.project_id !== doc.project_id) {
    return err(
      `changelog_entry_id '${ch.id}' belongs to project ${ch.project_id}, not the target document's project ${doc.project_id}.`
    );
  }
  const { data: chDocRow, error: chDocErr } = await db
    .from(DOCUMENTS)
    .select("id, document_type")
    .eq("id", ch.document_id)
    .maybeSingle();
  if (chDocErr) return err(`Failed to verify the changelog entry's document: ${chDocErr.message}`);
  if (!chDocRow || (chDocRow as { document_type: string }).document_type !== "changelog") {
    return err(`changelog_entry_id '${ch.id}' does not live in a document_type='changelog' document.`);
  }
  const chVersion = ch.attrs?.version;
  if (String(chVersion ?? "") !== args.new_version) {
    return err(
      `changelog_entry_id '${ch.id}' has attrs.version='${chVersion ?? "none"}', expected '${args.new_version}' ` +
      `(changelog-by-construction, SDES-SUB-003 §1).`
    );
  }

  // Call gov.doc_publish() — the only writer gov.doc_versions will ever grant.
  // Never INSERT directly (Q5, dba msg 41fa192b/cd8554f1).
  const rw = db as unknown as {
    __docRw?: boolean;
    docPublish?: (
      documentId: string,
      newVersion: string,
      bumpClass: string,
      changelogEntryId: string,
      deltaSummary: string
    ) => Promise<{ publication_id: string; version_seq: number; published_at: string }>;
  };
  if (!rw.__docRw || !rw.docPublish) {
    return err(
      `doc_publish: db is not a DocRwDb — refusing to bypass RLS. gov.doc_publish lives in the gov schema and is ` +
      `only reachable via the doc_rw direct-pg path (runDocRw). Test fakes must implement docPublish.`
    );
  }

  let result: { publication_id: string; version_seq: number; published_at: string };
  try {
    result = await rw.docPublish(args.document_id, args.new_version, args.bump_class, args.changelog_entry_id, args.delta_summary);
  } catch (ex) {
    const code = (ex as { code?: string }).code ?? "";
    const msg = ex instanceof Error ? ex.message : String(ex);
    if (/42501|insufficient_privilege/.test(code) || /insufficient_privilege/i.test(msg)) {
      return err(`Not legitimated to publish document '${args.document_id}' (gov.doc_publish: insufficient_privilege). Original: ${msg}`);
    }
    if (/P0002|no_data_found/.test(code) || /no_data_found/i.test(msg)) {
      return err(`gov.doc_publish: document or changelog_entry_id not found server-side. Original: ${msg}`);
    }
    if (/22023|invalid_parameter_value/.test(code) || /invalid_parameter_value/i.test(msg)) {
      return err(
        `gov.doc_publish rejected the parameters — bump_class, delta_summary, version format/ordering, or a ` +
        `changelog mismatch server-side. Original: ${msg}`
      );
    }
    if (/23505|unique_violation/.test(code) || /unique_violation|duplicate key/i.test(msg)) {
      return err(
        `version '${args.new_version}' is already published on document ${args.document_id} — republishing the ` +
        `same version is a REFUSAL, not a no-op (SDES-SUB-003 §3). Original: ${msg}`
      );
    }
    return err(`gov.doc_publish failed: ${msg}`);
  }

  // D-132 (DEL-002 acceptance b): re-read BOTH surfaces before ok — the
  // documents.version bump AND the ledger row — never trust the function's
  // return value alone.
  const { data: afterDoc, error: afterDocErr } = await db
    .from(DOCUMENTS)
    .select("id, version")
    .eq("id", args.document_id)
    .maybeSingle();
  if (afterDocErr || !afterDoc) {
    return err(
      `Publish reported success but documents.version could not be re-read: ${afterDocErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`
    );
  }
  if ((afterDoc as { version: string | null }).version !== args.new_version) {
    return err(
      `Publish reported success but documents.version reads '${(afterDoc as { version: string | null }).version}', ` +
      `expected '${args.new_version}' — treat as UNCONFIRMED.`
    );
  }

  const { data: afterPub, error: afterPubErr } = await db
    .from(GOV_DOC_VERSIONS)
    .select("id, document_id, version_seq, version_label, bump_class, changelog_item_id, published_at")
    .eq("id", result.publication_id)
    .maybeSingle();
  if (afterPubErr || !afterPub) {
    return err(
      `Publish reported success but the ledger row '${result.publication_id}' could not be re-read: ${afterPubErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`
    );
  }
  const pub = afterPub as {
    id: string; document_id: string; version_seq: number; version_label: string;
    bump_class: string; changelog_item_id: string; published_at: string;
  };
  if (
    pub.document_id !== args.document_id ||
    pub.version_label !== args.new_version ||
    pub.bump_class !== args.bump_class ||
    pub.changelog_item_id !== args.changelog_entry_id
  ) {
    return err(`Publish '${result.publication_id}' was recorded but does not match what was sent (D-132) — treat as UNCONFIRMED.`);
  }

  const published: DocPublishResult = {
    publication_id: pub.id,
    document_id: pub.document_id,
    version_seq: pub.version_seq,
    version_label: pub.version_label,
    bump_class: pub.bump_class,
    changelog_entry_id: pub.changelog_item_id,
    published_at: pub.published_at,
  };
  if (decayGate.decayed_count > 0) {
    published.decay_notice =
      `${decayGate.decayed_count} decayed uat_case row(s) in this project, below the blocking threshold ` +
      `(pg_rilancio_soglia_decaduti=${decayGate.threshold}, pg_rilancio_giorni_max=${decayGate.max_days}). ` +
      `"Decaduto non rieseguito sotto soglia" is not green (PJ-7): this publication carries them.`;
  } else if (decayGate.params_missing.length > 0) {
    published.decay_notice =
      `Decay gate NOT VERIFIED — missing from loomx_governance_params: ${decayGate.params_missing.join(", ")}. ` +
      `Publication was allowed (an unreadable registry is not evidence of an exceeded threshold), but this call ` +
      `cannot assert that the rerun obligation was satisfied.`;
  }
  return { ok: true, data: published };
}

// ---------------------------------------------------------------------------
// doc_repoint — UAT-GOV-029 / REQ-GOV-102 (dba msg ac19e421, migration
// 20260828065000). Moves a subscription's version pin to the target's CURRENT
// published version.
//
// Why a function and not an UPDATE: the same migration revoked table-level
// UPDATE from doc_rw and re-granted only (intent, status, tombstoned_at, note),
// so `SET subscribed_at_version` raises 42501 by construction. This is the only
// door, and that is the point — the pin moves through a guarded act or not at all.
//
// Why seen_version_id is a UUID and not a label: '1.0' matches 149 rows out of
// 166 (dba's measure). A label can be guessed; a UUID has to be read. The
// argument IS the proof of re-reading — that's what makes this an explicit act
// rather than a rubber stamp. Get it from doc_staleness_query, which reports
// each marking's target_current_version_id alongside the pin.
//
// What it deliberately does NOT do: close the staleness debt. It returns
// open_staleness (how many markings are still open on this subscription) and
// stops there — closing stays in doc_staleness_close + the outcomes ledger. Two
// distinct acts: one moves the pin, the other settles the debt.
// ---------------------------------------------------------------------------

export interface DocRepointArgs {
  subscription_id: string;
  seen_version_id: string;
  note?: string;
}

export interface DocRepointResult {
  subscription_id: string;
  from_version: string;
  to_version: string;
  version_id: string;
  open_staleness: number;
  staleness_note?: string;
}

export async function docRepoint(
  db: SupabaseClient,
  args: DocRepointArgs,
  ctx: DocContext
): Promise<DocResult<DocRepointResult>> {
  if (!UUID_RE.test(args.subscription_id)) return err(`subscription_id must be a UUID.`);
  if (!UUID_RE.test(args.seen_version_id)) {
    return err(
      `seen_version_id must be a UUID — the gov.doc_versions.id of the version you have just re-read, NOT a version ` +
      `label like '1.0'. A label can be guessed; that is exactly what this signature refuses. ` +
      `doc_staleness_query reports target_current_version_id for each open marking.`
    );
  }

  const rw = db as unknown as {
    __docRw?: boolean;
    subscriptionRepoint?: (
      subscriptionId: string,
      seenVersionId: string,
      note?: string
    ) => Promise<{
      subscription_id: string; from_version: string; to_version: string;
      version_id: string; rows: number; open_staleness: number;
    }>;
  };
  if (!rw.__docRw || !rw.subscriptionRepoint) {
    return err(
      `doc_repoint: db is not a DocRwDb — refusing to bypass RLS. gov.doc_subscription_repoint lives in the gov ` +
      `schema and is only reachable via the doc_rw direct-pg path (runDocRw). Test fakes must implement subscriptionRepoint.`
    );
  }

  // Tool-floor pre-read: gives a readable message for the common miss instead of
  // the function's raw P0002, and distinguishes "no such row" from "RLS hides it"
  // the way D-167 taught us to. Not a substitute for the function's own checks —
  // it re-verifies everything server-side, and only its verdict writes.
  const { data: preRow, error: preErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, status, subscriber_project_id, subscribed_at_version")
    .eq("id", args.subscription_id)
    .maybeSingle();
  if (preErr) return err(`Failed to read subscription '${args.subscription_id}': ${preErr.message}`);
  if (!preRow) {
    return err(
      `subscription_id '${args.subscription_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS). ` +
      `A repoint on a subscription that isn't there is never a silent success (REQ-GOV-102).`
    );
  }
  const pre = preRow as { id: string; status: string; subscriber_project_id: string; subscribed_at_version: string };
  if (pre.status !== "active") {
    return err(
      `Subscription '${args.subscription_id}' has status='${pre.status}' — what is not alive is not repointed. ` +
      `A tombstoned subscription stays pinned to the version it was tombstoned at, on purpose.`
    );
  }

  // The function RAISEs on every refusal, which aborts the surrounding
  // transaction (handlers run inside one BEGIN…COMMIT, see runWithPool). Without
  // a savepoint every later read — including the D-132 re-read — would fail with
  // "current transaction is aborted", masking the real refusal (bug d6a57035).
  const sp = savepointHandle(db);
  const SP = "sp_doc_repoint";
  if (sp) await sp.savepoint(SP);

  let result: { from_version: string; to_version: string; version_id: string; rows: number; open_staleness: number };
  try {
    result = await rw.subscriptionRepoint(args.subscription_id, args.seen_version_id, args.note);
  } catch (ex) {
    if (sp) await sp.rollbackToSavepoint(SP).catch(() => {});
    const e = ex as { code?: string; message?: string; detail?: string; hint?: string };
    const msg = e.message ?? String(ex);
    const detail = e.detail ? ` ${e.detail}` : "";
    // Dispatch on the E_REPOINT_* marker, not the SQLSTATE: P0002 alone covers
    // four distinct refusals, and telling them apart is the whole value here.
    if (/E_REPOINT_ARGS/.test(msg)) {
      return err(`doc_repoint: subscription_id and seen_version_id are both required. Original: ${msg}`);
    }
    if (/E_REPOINT_NO_SUB/.test(msg)) {
      return err(
        `Subscription '${args.subscription_id}' does not exist server-side. This is the case that used to return a ` +
        `mute success (REQ-GOV-102) — it is now a refusal. Original: ${msg}`
      );
    }
    if (/E_REPOINT_NOT_ACTIVE/.test(msg)) {
      return err(`Subscription '${args.subscription_id}' is not active — it cannot be repointed. Original: ${msg}`);
    }
    if (/E_REPOINT_FORBIDDEN/.test(msg)) {
      return err(
        `'${ctx.selfSlug}' is not legitimated to repoint subscription '${args.subscription_id}': the caller must be in ` +
        `the subscriber's project ${pre.subscriber_project_id} (same predicate as the doc_subscriptions_update_own ` +
        `policy). Original: ${msg}`
      );
    }
    if (/E_REPOINT_NO_TARGET_DOC/.test(msg)) {
      return err(`The subscription's target does not resolve to a document — nothing to repoint to. Original: ${msg}`);
    }
    if (/E_REPOINT_NO_VERSION/.test(msg)) {
      return err(
        `The target document has never been published, so there is no version to repoint to. This is not an edge ` +
        `case today: a staleness marking is raised by a substantively-changed ROW (D-201/M2), which needs no ` +
        `publication at all — so a marking can legitimately exist on a target that has no version. Repointing is ` +
        `simply not applicable here; settle the debt with doc_staleness_close. Original: ${msg}`
      );
    }
    if (/E_REPOINT_STALE_READ/.test(msg)) {
      return err(
        `The version you declared is not the target's current one — re-read it and call again with the current ` +
        `gov.doc_versions.id (that is precisely what this signature demands).${detail} Original: ${msg}`
      );
    }
    if (/E_REPOINT_NOOP/.test(msg)) {
      return err(
        `Subscription '${args.subscription_id}' is already pinned to that version — zero rows written is not a ` +
        `success. If the staleness debt is still open, it is closed in the outcomes register ` +
        `(doc_staleness_close), not by repointing again. Original: ${msg}`
      );
    }
    if (/E_REPOINT_ZERO_ROWS/.test(msg)) {
      return err(
        `Nothing was written for subscription '${args.subscription_id}': a concurrent repoint landed between the ` +
        `read and the write. Re-read the target and retry. Original: ${msg}`
      );
    }
    if (/42501|insufficient_privilege|permission denied/i.test(e.code ?? "") || /permission denied/i.test(msg)) {
      return err(`Not legitimated to repoint subscription '${args.subscription_id}' (permission denied). Original: ${msg}`);
    }
    return err(`gov.doc_subscription_repoint failed: ${msg}${detail}`);
  }
  // No RELEASE on the success path: an unreleased savepoint is discarded at
  // COMMIT, and the existing sites here (docSubscriptionOutcome) do the same.

  // D-132: never report ok on the function's return value alone — re-read the
  // row and confirm the pin actually reads as the new version.
  const { data: after, error: afterErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, subscribed_at_version, status")
    .eq("id", args.subscription_id)
    .maybeSingle();
  if (afterErr || !after) {
    return err(
      `Repoint reported success but subscription '${args.subscription_id}' could not be re-read: ` +
      `${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`
    );
  }
  const afterRow = after as { id: string; subscribed_at_version: string; status: string };
  if (afterRow.subscribed_at_version !== result.to_version) {
    return err(
      `Repoint reported success but subscribed_at_version reads '${afterRow.subscribed_at_version}', expected ` +
      `'${result.to_version}' — treat as UNCONFIRMED (D-132).`
    );
  }

  const out: DocRepointResult = {
    subscription_id: args.subscription_id,
    from_version: result.from_version,
    to_version: result.to_version,
    version_id: result.version_id,
    open_staleness: result.open_staleness,
  };
  // Say the quiet part out loud: moving the pin is NOT settling the debt. The
  // count alone would read as reassurance; it is the opposite.
  if (result.open_staleness > 0) {
    out.staleness_note =
      `${result.open_staleness} staleness marking(s) remain OPEN on this subscription: repointing moves the pin, ` +
      `it does not settle the debt. Close them with doc_staleness_close and a recorded outcome.`;
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// doc_version_delta — the structured delta of a publication (forge msg
// 05ba7c9e: UAT-SUB-003 / REQ-SUB-003 criterion 2, and UAT-SUB-011 /
// REQ-SUB-011 by declared consequence).
//
// Why this is NOT a declared list in changelog_entry.attrs, as SDES-SUB-003
// sketched: measured live 2026-08-28, gov.doc_publish() already writes a FULL
// row-level snapshot of the document into gov.doc_version_items (237 rows over
// 29 publications), each row carrying content_sha256. So the delta does not
// need to be declared by the caller — it is DERIVABLE by diffing consecutive
// snapshots, and derivable is strictly stronger:
//
//   - Completeness is by construction. forge's central worry ("complete, never
//     silently truncated" — same principle as CV-8/D-203) cannot be violated
//     by a list nobody writes. There is no list to truncate. What replaces the
//     truncation risk is a cap that REFUSES (see MAX_VERSION_DELTA_ROWS): an
//     oversized diff is an explicit error, never a short answer.
//   - It cannot lie. A hand-declared elenco can omit a row — accidentally, or
//     to keep a noisy publication quiet. A sha256 diff of the ledger's own
//     snapshots reports what was published, not what someone said was published.
//   - It works retroactively, on the 29 publications that already exist. A
//     declared field would only ever describe publications made after it lands.
//
// Verified live on document 9af1b1f1 (versions 1.2 → 1.3, 11 rows): exactly one
// row (UAT-OR-009) reports as changed, ten as unchanged.
//
// Boundary: this is the board-mcp surface for the delta. M1 (who filters
// document-subscribers down to the rows actually touched) and M4 (who counts
// rows to decide whether to aggregate) are dba/sweep domain and may read the
// same snapshots in SQL — same source, no second version of the truth.
// ---------------------------------------------------------------------------

// A diff bigger than this is refused, never truncated. Today's largest
// publication is 21 rows; the cap exists so that if a document ever grows past
// what one response can honestly carry, the caller is TOLD, and M4 never counts
// a number smaller than the truth.
export const MAX_VERSION_DELTA_ROWS = 2000;

export const VERSION_CHANGE_KINDS = ["created", "modified", "superseded", "removed"] as const;
export type VersionChangeKind = (typeof VERSION_CHANGE_KINDS)[number];

export interface DocVersionDeltaArgs {
  document_id: string;
  version?: string;
  against_version?: string;
}

export interface VersionDeltaChange {
  item_id: string;
  code: string | null;
  item_type: string;
  change_kind: VersionChangeKind;
}

export interface DocVersionDeltaResult {
  document_id: string;
  version: { label: string; seq: number; publication_id: string; published_at: string };
  baseline: { label: string; seq: number; publication_id: string } | null;
  changes: VersionDeltaChange[];
  counts: { created: number; modified: number; superseded: number; removed: number; unchanged: number; total_rows_in_version: number };
  complete: true;
  note?: string;
}

interface VersionRow {
  id: string;
  version_seq: number;
  version_label: string;
  published_at: string | Date;
  delta_summary: string;
}

interface VersionItemRow {
  publication_id: string;
  doc_item_id: string;
  code: string | null;
  item_type: string;
  status: string;
  content_sha256: string;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export async function docVersionDelta(
  db: SupabaseClient,
  args: DocVersionDeltaArgs,
  ctx: DocContext
): Promise<DocResult<DocVersionDeltaResult>> {
  if (!UUID_RE.test(args.document_id)) return err(`document_id must be a UUID.`);

  // The document must be readable by the caller — the delta names codes and
  // item ids, so it never widens what RLS already decided (DEL-001 c).
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, project_id")
    .eq("id", args.document_id)
    .maybeSingle();
  if (docErr) return err(`Failed to load document: ${docErr.message}`);
  if (!docRow) {
    return err(`document_id '${args.document_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS — D-167).`);
  }

  const { data: verData, error: verErr } = await db
    .from(GOV_DOC_VERSIONS)
    .select("id, version_seq, version_label, published_at, delta_summary")
    .eq("document_id", args.document_id)
    .order("version_seq", { ascending: false });
  if (verErr) return err(`Failed to read the publication ledger: ${verErr.message}`);
  const versions = ((verData ?? []) as VersionRow[]).slice().sort((a, b) => b.version_seq - a.version_seq);
  if (versions.length === 0) {
    return err(
      `Document '${args.document_id}' has never been published — there is no version to take a delta of. ` +
      `A delta exists between publications, not between edits (SDES-SUB-003: fan-out starts at doc_publish).`
    );
  }

  // Target version: explicit label, or the most recent publication.
  let target: VersionRow | undefined;
  if (args.version && args.version.trim() !== "") {
    const wanted = args.version.trim();
    const matches = versions.filter((v) => v.version_label === wanted);
    if (matches.length === 0) {
      return err(
        `Version '${wanted}' is not in this document's ledger. Published versions, newest first: ` +
        `${versions.map((v) => v.version_label).join(", ")}.`
      );
    }
    // A label is not unique by contract — never pick for the caller (same rule
    // as doc_item_resolve on ambiguity).
    if (matches.length > 1) {
      return err(
        `Version label '${wanted}' matches ${matches.length} publications of this document (seq ` +
        `${matches.map((m) => m.version_seq).join(", ")}) — this tool never picks one for you.`
      );
    }
    target = matches[0];
  } else {
    target = versions[0];
  }

  // Baseline: explicit label, or the publication immediately preceding the
  // target by seq. Null for a first publication — stated, never faked.
  let baseline: VersionRow | null = null;
  if (args.against_version && args.against_version.trim() !== "") {
    const wanted = args.against_version.trim();
    const matches = versions.filter((v) => v.version_label === wanted);
    if (matches.length === 0) {
      return err(
        `against_version '${wanted}' is not in this document's ledger. Published versions, newest first: ` +
        `${versions.map((v) => v.version_label).join(", ")}.`
      );
    }
    if (matches.length > 1) {
      return err(`against_version '${wanted}' matches ${matches.length} publications — this tool never picks one for you.`);
    }
    if (matches[0].version_seq >= target.version_seq) {
      return err(
        `against_version '${wanted}' (seq ${matches[0].version_seq}) is not older than version ` +
        `'${target.version_label}' (seq ${target.version_seq}) — a delta runs forward in time.`
      );
    }
    baseline = matches[0];
  } else {
    baseline = versions.find((v) => v.version_seq < target!.version_seq) ?? null;
  }

  const pubIds = baseline ? [target.id, baseline.id] : [target.id];
  const { data: itemData, error: itemErr } = await db
    .from(GOV_DOC_VERSION_ITEMS)
    .select("publication_id, doc_item_id, code, item_type, status, content_sha256")
    .in("publication_id", pubIds);
  if (itemErr) return err(`Failed to read the version snapshots: ${itemErr.message}`);
  const rows = (itemData ?? []) as VersionItemRow[];

  const cur = rows.filter((r) => r.publication_id === target.id);
  const base = baseline ? rows.filter((r) => r.publication_id === baseline!.id) : [];
  if (cur.length === 0) {
    return err(
      `Publication '${target.id}' (version ${target.version_label}) has no rows in gov.doc_version_items — the ` +
      `snapshot is missing or not readable, so no delta can be asserted. This is NOT an empty delta.`
    );
  }
  if (cur.length > MAX_VERSION_DELTA_ROWS || base.length > MAX_VERSION_DELTA_ROWS) {
    return err(
      `This delta spans ${Math.max(cur.length, base.length)} rows, over the ${MAX_VERSION_DELTA_ROWS} cap. Refused ` +
      `rather than truncated: a partial delta would make any downstream count (aggregation thresholds, ` +
      `subscriber filtering) wrong on a number that looks right. Read gov.doc_version_items directly for this document.`
    );
  }

  const byId = new Map(base.map((r) => [r.doc_item_id, r]));
  const changes: VersionDeltaChange[] = [];
  let unchanged = 0;
  for (const c of cur) {
    const p = byId.get(c.doc_item_id);
    let kind: VersionChangeKind | null;
    if (!p) {
      kind = "created";
    } else if (c.content_sha256 === p.content_sha256) {
      kind = null;
    } else if (c.status === "superseded" && p.status !== "superseded") {
      kind = "superseded";
    } else {
      kind = "modified";
    }
    if (kind === null) {
      unchanged += 1;
      continue;
    }
    changes.push({ item_id: c.doc_item_id, code: c.code, item_type: c.item_type, change_kind: kind });
  }
  // Rows that were in the baseline and are no longer part of the document.
  const curIds = new Set(cur.map((r) => r.doc_item_id));
  for (const p of base) {
    if (!curIds.has(p.doc_item_id)) {
      changes.push({ item_id: p.doc_item_id, code: p.code, item_type: p.item_type, change_kind: "removed" });
    }
  }

  const counts = {
    created: changes.filter((c) => c.change_kind === "created").length,
    modified: changes.filter((c) => c.change_kind === "modified").length,
    superseded: changes.filter((c) => c.change_kind === "superseded").length,
    removed: changes.filter((c) => c.change_kind === "removed").length,
    unchanged,
    total_rows_in_version: cur.length,
  };

  const out: DocVersionDeltaResult = {
    document_id: args.document_id,
    version: {
      label: target.version_label,
      seq: target.version_seq,
      publication_id: target.id,
      published_at: toIso(target.published_at),
    },
    baseline: baseline ? { label: baseline.version_label, seq: baseline.version_seq, publication_id: baseline.id } : null,
    changes,
    counts,
    complete: true,
  };
  if (!baseline) {
    out.note =
      `First publication of this document (seq ${target.version_seq}): there is no earlier snapshot to diff against, ` +
      `so every row reports as 'created'. That is the delta, not a fallback.`;
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// doc_publish_impact — D-233 fase 4 (GTD c0bbe258, SDES-SUB-006 shape). Answers
// "who is touched if I publish THIS document now" BEFORE the act — not as a
// side effect of it. v_doc_blast_radius (dba msg b465dbdd) does not fit: it
// starts from gov.doc_versions, i.e. a publication that already happened. The
// pre-act question needs gov.doc_subscriptions instead (dba's own correction).
//
// Two regimes, told apart via gov.doc_publication_state:
//  - 'first_publish' (is_published=false — ~93% of active subscriptions'
//    targets, dba measured 2026-08-28): publishing now would be the FIRST
//    publication, so every row reports 'created' by construction — same
//    null-baseline rule doc_version_delta already uses. No diff needed:
//    every active subscription (item- or document-level) is touched=true.
//  - 'republish' (is_published=true): the live doc_items row is diffed
//    against the LATEST gov.doc_version_items snapshot with the SAME
//    predicate the M2 trigger uses (gov.doc_item_substantive_diff) — so this
//    answer is provably the comparison the eventual publish will report
//    (Gate 4: "la risposta prima coincide con ciò che l'atto poi produce
//    davvero"). Measured live 2026-08-29: doc_rw has NO EXECUTE grant on that
//    function (42501) — asked dba for a narrow grant on this STABLE,
//    side-effect-free function (see docDb.ts substantiveDiff). Until granted,
//    an item that already existed in the last snapshot reports
//    touched:'unknown' with the gap named (D-136 §5: declared gap, never an
//    invented guess) — an item ABSENT from the last snapshot still resolves
//    for free (created, no diff function needed).
//
// Document-level (surveillance) subscriptions are NEVER filtered by content
// (D-233 fase 2 amendment, loomy msg 85942fff point 2: "chi sorveglia un
// documento intero riceve ogni versione") — touched=true unconditionally, in
// both regimes.
//
// Inherits vuoto ≠ negato: gov.doc_subscriptions/doc_items visibility is RLS
// under this caller's own identity — an empty or partial subscriber list does
// not prove none exist, only that none are visible to this identity.
//
// Read-only. No write path.
// ---------------------------------------------------------------------------

export interface DocPublishImpactArgs {
  document_id: string;
}

export type ImpactTouched = true | false | "unknown";

export interface DocPublishImpactSubscriber {
  subscription_id: string;
  subscriber_item_id: string;
  subscriber_project_id: string;
  intent: string;
  depth: "direct" | "inherited";
  target_item_id: string | null;
  target_code: string | null;
  touched: ImpactTouched;
  basis: string;
}

export interface DocPublishImpactResult {
  document_id: string;
  document_title: string;
  regime: "first_publish" | "republish";
  last_published_version: string | null;
  subscribers: DocPublishImpactSubscriber[];
  counts: { total: number; touched: number; not_touched: number; unknown: number; direct: number; inherited: number };
  caveat: string;
}

interface ImpactSubscriptionRow {
  id: string;
  subscriber_item_id: string;
  subscriber_project_id: string;
  intent: string;
  status: string;
  target_item_id: string | null;
  target_document_id: string | null;
}

interface ImpactDocItemRow {
  id: string;
  code: string | null;
  item_type: string;
  status: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  attrs: Record<string, unknown> | null;
}

const SNAPSHOT_DIFF_COLS = "doc_item_id, code, item_type, status, title, summary, body, attrs";

export async function docPublishImpact(
  db: SupabaseClient,
  args: DocPublishImpactArgs,
  ctx: DocContext
): Promise<DocResult<DocPublishImpactResult>> {
  if (!UUID_RE.test(args.document_id)) return err(`document_id must be a UUID.`);

  const rw = db as unknown as {
    __docRw?: boolean;
    publicationState?: (documentId: string) => Promise<{
      is_published: boolean;
      last_version_label: string | null;
    }>;
    substantiveDiff?: (before: Record<string, unknown> | null, after: Record<string, unknown>) => Promise<string[]>;
  };
  if (!rw.__docRw || !rw.publicationState || !rw.substantiveDiff) {
    return err(
      `doc_publish_impact: db is not a DocRwDb — refusing to bypass RLS. gov.doc_publication_state lives in the ` +
      `gov schema and is only reachable via the doc_rw direct-pg path (runDocRw). Test fakes must implement ` +
      `publicationState/substantiveDiff.`
    );
  }

  const { data: docRow, error: docErr } = await db.from(DOCUMENTS).select("id, title").eq("id", args.document_id).maybeSingle();
  if (docErr) return err(`Failed to load document: ${docErr.message}`);
  if (!docRow) {
    return err(`document_id '${args.document_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS — D-167).`);
  }
  const doc = docRow as { id: string; title: string };

  const pub = await rw.publicationState(args.document_id);
  const regime: "first_publish" | "republish" = pub.is_published ? "republish" : "first_publish";

  const { data: itemData, error: itemErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, item_type, status, title, summary, body, attrs")
    .eq("document_id", args.document_id);
  if (itemErr) return err(`Failed to read document items: ${itemErr.message}`);
  const items = (itemData ?? []) as ImpactDocItemRow[];
  const itemIds = items.map((i) => i.id);
  const itemById = new Map(items.map((i) => [i.id, i]));

  let itemSubs: ImpactSubscriptionRow[] = [];
  if (itemIds.length > 0) {
    const { data, error } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .select("id, subscriber_item_id, subscriber_project_id, intent, status, target_item_id, target_document_id")
      .in("target_item_id", itemIds)
      .eq("status", "active");
    if (error) return err(`Failed to read item-level subscriptions: ${error.message}`);
    itemSubs = (data ?? []) as ImpactSubscriptionRow[];
  }

  const { data: docSubData, error: docSubErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, subscriber_item_id, subscriber_project_id, intent, status, target_item_id, target_document_id")
    .eq("target_document_id", args.document_id)
    .eq("status", "active");
  if (docSubErr) return err(`Failed to read document-level subscriptions: ${docSubErr.message}`);
  const surveillanceSubs = (docSubData ?? []) as ImpactSubscriptionRow[];

  // Latest snapshot per item — only needed in the republish regime, where
  // "changed since the last publish" is a real question with a real baseline.
  const latestSnapshot = new Map<string, Record<string, unknown>>();
  if (regime === "republish" && itemIds.length > 0) {
    const { data: verData, error: verErr } = await db
      .from(GOV_DOC_VERSIONS)
      .select("id, version_seq")
      .eq("document_id", args.document_id)
      .order("version_seq", { ascending: false })
      .limit(1);
    if (verErr) return err(`Failed to read the publication ledger: ${verErr.message}`);
    const latest = (verData ?? [])[0] as { id: string } | undefined;
    if (latest) {
      const { data: snapData, error: snapErr } = await db
        .from(GOV_DOC_VERSION_ITEMS)
        .select(SNAPSHOT_DIFF_COLS)
        .eq("publication_id", latest.id)
        .in("doc_item_id", itemIds);
      if (snapErr) return err(`Failed to read the last publication's snapshot: ${snapErr.message}`);
      for (const r of (snapData ?? []) as Array<Record<string, unknown> & { doc_item_id: string }>) {
        latestSnapshot.set(r.doc_item_id, r);
      }
    }
  }

  const subscribers: DocPublishImpactSubscriber[] = [];
  let sawPermissionGap = false;

  for (const s of itemSubs) {
    const item = s.target_item_id ? itemById.get(s.target_item_id) : undefined;
    let touched: ImpactTouched;
    let basis: string;
    if (regime === "first_publish") {
      touched = true;
      basis = "First publication of the document: every row would report 'created' (no baseline — same rule as doc_version_delta).";
    } else if (!item) {
      touched = "unknown";
      basis = "Subscribed row is not currently readable in doc_items — cannot compare.";
    } else {
      const snap = s.target_item_id ? latestSnapshot.get(s.target_item_id) : undefined;
      if (!snap) {
        touched = true;
        basis = "Row absent from the last publication's snapshot: would report 'created'.";
      } else {
        // SAVEPOINT around the diff call: the whole handler runs in ONE open
        // transaction (docDb.ts runWithPool). A 42501 on gov.doc_item_substantive_diff
        // aborts that transaction — without a savepoint, every subsequent query in
        // this same loop (and the whole rest of the handler) would fail with
        // "current transaction is aborted", not the honest per-item 'unknown' this
        // branch means to report. Measured live 2026-08-29 on the un-savepointed
        // first version of this code: exactly that failure, on the second item.
        const sp = savepointHandle(db);
        const SP = "publish_impact_diff";
        if (sp) await sp.savepoint(SP);
        try {
          const changed = await rw.substantiveDiff!(snap, item as unknown as Record<string, unknown>);
          touched = changed.length > 0;
          basis = touched
            ? `Significant columns changed since the last publication: ${changed.join(", ")}.`
            : "No significant column changed since the last publication.";
        } catch (e) {
          const code = (e as { code?: string }).code ?? "";
          const msg = e instanceof Error ? e.message : String(e);
          if (/42501|insufficient_privilege/.test(code) || /permission denied|insufficient_privilege/i.test(msg)) {
            if (sp) await sp.rollbackToSavepoint(SP).catch(() => {});
            sawPermissionGap = true;
            touched = "unknown";
            basis = "gov.doc_item_substantive_diff is not EXECUTE-granted to doc_rw yet (42501) — declared gap, requested from dba.";
          } else {
            if (sp) await sp.rollbackToSavepoint(SP).catch(() => {});
            return err(`Failed to compute the live diff for item '${s.target_item_id}': ${msg}`);
          }
        }
      }
    }
    subscribers.push({
      subscription_id: s.id,
      subscriber_item_id: s.subscriber_item_id,
      subscriber_project_id: s.subscriber_project_id,
      intent: s.intent,
      depth: "direct",
      target_item_id: s.target_item_id,
      target_code: item?.code ?? null,
      touched,
      basis,
    });
  }

  for (const s of surveillanceSubs) {
    subscribers.push({
      subscription_id: s.id,
      subscriber_item_id: s.subscriber_item_id,
      subscriber_project_id: s.subscriber_project_id,
      intent: s.intent,
      depth: "inherited",
      target_item_id: null,
      target_code: null,
      touched: true,
      basis: "Document-level (surveillance) subscription: never content-filtered, receives every publication by design (D-233 fase 2).",
    });
  }

  const counts = {
    total: subscribers.length,
    touched: subscribers.filter((s) => s.touched === true).length,
    not_touched: subscribers.filter((s) => s.touched === false).length,
    unknown: subscribers.filter((s) => s.touched === "unknown").length,
    direct: subscribers.filter((s) => s.depth === "direct").length,
    inherited: subscribers.filter((s) => s.depth === "inherited").length,
  };

  let caveat =
    "Visibility follows RLS under this caller's identity — an empty or partial subscriber list does not prove none " +
    "exist, only that none are visible here (vuoto ≠ negato).";
  if (sawPermissionGap) {
    caveat +=
      " Some items report touched:'unknown' because gov.doc_item_substantive_diff is not yet EXECUTE-granted to " +
      "doc_rw — a grant request was sent to dba; this tool will start resolving them exactly once it lands, no code change needed.";
  }

  return {
    ok: true,
    data: {
      document_id: args.document_id,
      document_title: doc.title,
      regime,
      last_published_version: pub.last_version_label,
      subscribers,
      counts,
      caveat,
    },
  };
}

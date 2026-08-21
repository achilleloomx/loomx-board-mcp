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

const GOV_DOC_SUBSCRIPTIONS = "gov.doc_subscriptions";
const GOV_DOC_SUBSCRIPTION_OUTCOMES = "gov.doc_subscription_outcomes";
const GOV_DOC_VERSIONS = "gov.doc_versions";
const DOC_ITEMS = "doc_items";
const DOCUMENTS = "documents";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Critical cross-project: refused in v1 (SDES-SUB-001 §4, D-186 Q2).
  if (args.intent === "critical" && targetProjectId !== sub.project_id) {
    return err(
      `A 'critical' subscription across projects is refused in v1 (D-186 Q2): it needs an explicit act plus ` +
      `acceptance from the target's owner, never automatic creation (that flow is A3/DEL-009, not yet built). ` +
      `Use board_send to the target's owning agent instead, or subscribe with intent='module'|'informative'.`
    );
  }

  // subscribed_at_version = the target document's CURRENT documents.version.
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, version")
    .eq("id", targetDocumentId)
    .maybeSingle();
  if (docErr) return err(`Failed to load target document version: ${docErr.message}`);
  if (!docRow) return err(`Target document ${targetDocumentId} could not be read for its version.`);
  const subscribedAtVersion = String((docRow as { version: unknown }).version ?? "");

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

  return {
    ok: true,
    data: {
      subscription_id: newId,
      created: true,
      intent: afterRow.intent,
      subscribed_at_version: afterRow.subscribed_at_version,
      target_kind: hasItem ? "item" : "document",
    },
  };
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

  // SEC-011: exit only from a CHOICE, never a FACT. The DB-floor trigger for
  // this is ratified (D-186 §2) but NOT yet applied — measured live
  // 2026-08-21: no BEFORE UPDATE trigger on gov.doc_subscriptions rejects a
  // tombstone of an origin='fact' row today (dba msg 41fa192b: "proposto a
  // loomy in questo stesso giro"). Enforced here at the tool-floor meanwhile.
  if (sub.origin === "fact") {
    return err(
      `Cannot unsubscribe '${args.subscription_id}': it originates from a structural fact (origin='fact'), not a ` +
      `choice (SEC-011) — exit by removing the underlying link/role that created it, not by tombstoning here. ` +
      `(DB-floor enforcement of this rule is ratified — D-186 §2 — but not yet applied; this tool enforces it meanwhile.)`
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

  const { data, error } = await db.from(GOV_DOC_SUBSCRIPTION_OUTCOMES).insert(insert).select("id").maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row returned";
    if (/duplicate key|doc_subscription_outcomes_once/i.test(m)) {
      // Idempotent retry vs. a genuine second (different) act — tell them apart
      // (SDES-SUB-004 §4: the ledger never corrects, only integrates).
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
    .select("id, project_id, owner, version")
    .eq("id", args.document_id)
    .maybeSingle();
  if (docErr) return err(`Failed to load document: ${docErr.message}`);
  if (!docRow) {
    return err(`document_id '${args.document_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS).`);
  }
  const doc = docRow as { id: string; project_id: string; owner: string | null; version: string | null };

  if (!ctx.isLoomy && doc.owner !== ctx.selfSlug) {
    return err(
      `Not legitimated to publish document '${doc.id}': you are not its owner ('${doc.owner ?? "none"}'), and only ` +
      `loomy can publish cross-agent (SDES-SUB-003 §2).`
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

  return {
    ok: true,
    data: {
      publication_id: pub.id,
      document_id: pub.document_id,
      version_seq: pub.version_seq,
      version_label: pub.version_label,
      bump_class: pub.bump_class,
      changelog_entry_id: pub.changelog_item_id,
      published_at: pub.published_at,
    },
  };
}

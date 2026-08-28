// doc_fact_sync — the missing FIRST ring of the decay machine (PJ-7, D-210).
//
// The machine was built from the middle outwards and the two ends never met:
//
//   [link verifies/satisfies] -- MISSING --> [subscription] --M2 trigger-->
//   [staleness marking] --doc_decay_apply--> [uat_case decayed]
//
// Everything to the right of "subscription" exists and is verified live (dba
// migration 20260822090000 + staleness.ts, session #119). What never existed is
// the derivation on the LEFT: gov.doc_items_detect_change only marks rows that
// somebody has an ACTIVE SUBSCRIPTION on, and measured on production 2026-08-28
// there were 170 subscriptions — all origin='choice', hand-made — against 510
// 'verifies' and 417 'satisfies' links. 927 declared traceability bonds, zero of
// which could ever make anything decay.
//
// That is exactly the defect REG-011/PJ-7 recorded from a provoked case: "un
// disegno riscritto in modo sostanziale, il collaudo collegato rimasto passato.
// Collegamento presente, predicato di sostanzialità presente e ratificato,
// congegno assente." The link was there. Nothing read it.
//
// This tool reads it. It derives the origin='fact' subscriptions the model
// always described as "constitutive, automatic, never through doc_subscribe"
// (SDES-SUB-001 intro) but which nothing had ever written — zero rows with
// origin='fact' existed in production before this.
//
// Deliberate limits, each one a refusal to invent contract (D-136 §5):
//   - Only 'verifies' and 'satisfies'. 'refines'/'relates_to' are discursive
//     bonds, not verdict dependencies; 'supersedes' is replacement and is
//     excluded from every propagation surface already (repoint, dba msg 6583a8a8).
//   - Grade is derived from the relation, not chosen per call: verifies →
//     'critical' (the test falls when its subject moves), satisfies → 'module'
//     (a design whose requirement moved needs review, it does not fall). The map
//     is exported and echoed in the response — never a hidden decision.
//   - doc_item_links carries its own project_id and is same-project by
//     construction, so the "critical cross-project refused in v1" case (D-186
//     Q2) cannot arise here. Asserted, and still checked.
//   - A 'fact' subscription CANNOT be tombstoned (SEC-011, DB floor trigger
//     since 2026-08-22). Creating one is irreversible: hence dry_run, an
//     explicit ceiling that REFUSES rather than truncates, and orphan_facts
//     reporting facts whose link is gone — declared, because they cannot be
//     removed, not hidden because they are inconvenient.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocResult, DocContext } from "./docs.js";
import { readAdmissionGate, ADMISSION_SUSPENDED_PARAM } from "./subscriptions.js";

const GOV_DOC_SUBSCRIPTIONS = "gov.doc_subscriptions";
const DOC_ITEM_LINKS = "doc_item_links";
const DOC_ITEMS = "doc_items";
const DOCUMENTS = "documents";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The two traceability relations, and the grade each one implies. Exported so
// the tool description, the tests and the response all read the SAME map.
export const FACT_SYNC_RELATIONS = ["verifies", "satisfies"] as const;
export type FactSyncRelation = (typeof FACT_SYNC_RELATIONS)[number];
export const FACT_INTENT_BY_RELATION: Record<FactSyncRelation, "critical" | "module"> = {
  verifies: "critical",
  satisfies: "module",
};

// Ceiling on links examined in one sweep. Over it the call is REFUSED with the
// real count, never silently cut: a partial sync looks exactly like a finished
// one from the outside, and the next reader would take "0 created" for "nothing
// left to do" (same reasoning as MAX_VERSION_DELTA_ROWS, CV-8/D-203).
export const MAX_FACT_SYNC_LINKS = 1000;

function err(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}

function docRwHandle(db: SupabaseClient): { agentInProject?: (p: string) => Promise<boolean> } | null {
  const h = db as unknown as { __docRw?: boolean; agentInProject?: (p: string) => Promise<boolean> };
  return h.__docRw ? { agentInProject: h.agentInProject } : null;
}

interface LinkRow {
  id: string;
  from_item: string;
  to_item: string;
  project_id: string;
  relation_type: string;
}

interface ItemRow {
  id: string;
  code: string | null;
  item_type: string;
  project_id: string;
  document_id: string;
}

export interface DocFactSyncArgs {
  project_id: string;
  relation_types?: string[];
  dry_run?: boolean;
  limit?: number;
}

export interface FactSyncCreated {
  subscription_id: string;
  subscriber_item_id: string;
  subscriber_code: string | null;
  target_item_id: string;
  target_code: string | null;
  relation_type: string;
  intent: string;
}

export interface DocFactSyncResult {
  project_id: string;
  relation_types: string[];
  intent_map: Record<string, string>;
  dry_run: boolean;
  created: FactSyncCreated[];
  would_create?: Array<Omit<FactSyncCreated, "subscription_id">>;
  already_covered: Array<{ subscriber_code: string | null; target_code: string | null; relation_type: string; origin: string }>;
  skipped: Array<{ from_item: string; to_item: string; relation_type: string; reason: string }>;
  counts: {
    links_examined: number;
    created: number;
    already_covered: number;
    skipped: number;
  };
  orphan_facts?: Array<{ subscription_id: string; subscriber_code: string | null; target_code: string | null; note: string }>;
  admission_gate?: string;
}

export async function docFactSync(
  db: SupabaseClient,
  args: DocFactSyncArgs,
  ctx: DocContext
): Promise<DocResult<DocFactSyncResult>> {
  if (!UUID_RE.test(args.project_id)) return err(`project_id must be a UUID.`);
  const dryRun = args.dry_run ?? false;

  const requested = args.relation_types ?? [...FACT_SYNC_RELATIONS];
  const bad = requested.filter((r) => !(FACT_SYNC_RELATIONS as readonly string[]).includes(r));
  if (bad.length > 0) {
    return err(
      `relation_types ${JSON.stringify(bad)} are not derivable into subscriptions. Only ${FACT_SYNC_RELATIONS.join("/")} ` +
        `are traceability bonds that carry a verdict dependency: 'refines' and 'relates_to' are discursive, and ` +
        `'supersedes' is replacement (already excluded from every propagation surface). Widening this set is a rule ` +
        `change and belongs to whoever governs the rule, not to this call.`
    );
  }
  const relations = [...new Set(requested)] as FactSyncRelation[];

  // Legitimation: same floor as doc_subscribe — you must belong to the project
  // whose rows you are about to make subscribers, or be loomy.
  if (!ctx.isLoomy) {
    const rw = docRwHandle(db);
    const member = rw?.agentInProject ? await rw.agentInProject(args.project_id) : false;
    if (!member) {
      return err(
        `Not legitimated to derive fact subscriptions in project ${args.project_id}: you are neither a member of it ` +
          `nor loomy. This tool writes subscriber rows on that project's items.`
      );
    }
  }

  const limit = Math.min(args.limit ?? MAX_FACT_SYNC_LINKS, MAX_FACT_SYNC_LINKS);
  const { data: linkData, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .select("id, from_item, to_item, project_id, relation_type")
    .eq("project_id", args.project_id)
    .in("relation_type", relations)
    .limit(limit + 1);
  if (linkErr) return err(`Failed to read ${DOC_ITEM_LINKS}: ${linkErr.message}`);
  const links = (Array.isArray(linkData) ? linkData : []) as LinkRow[];
  if (links.length > limit) {
    return err(
      `Project ${args.project_id} has more than ${limit} ${relations.join("/")} links. This call is REFUSED rather than ` +
        `truncated: a partial sync is indistinguishable from a complete one afterwards, and the next reader would take ` +
        `"nothing created" for "nothing left to do". Re-run with a narrower relation_types, or raise limit up to ` +
        `${MAX_FACT_SYNC_LINKS}.`
    );
  }

  const itemIds = [...new Set(links.flatMap((l) => [l.from_item, l.to_item]))];
  const items = new Map<string, ItemRow>();
  if (itemIds.length > 0) {
    const { data: itemData, error: itemErr } = await db
      .from(DOC_ITEMS)
      .select("id, code, item_type, project_id, document_id")
      .in("id", itemIds);
    if (itemErr) return err(`Failed to resolve link endpoints: ${itemErr.message}`);
    for (const r of (itemData ?? []) as ItemRow[]) items.set(r.id, r);
  }

  // Existing ACTIVE subscriptions for the subscriber side, whatever their
  // origin: a hand-made 'choice' subscription on the same pair already carries
  // the dependency, and the unique index would reject a second one anyway.
  const subscriberIds = [...new Set(links.map((l) => l.from_item))];
  const covered = new Map<string, { origin: string; intent: string }>();
  if (subscriberIds.length > 0) {
    const { data: subData, error: subErr } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .select("id, subscriber_item_id, target_item_id, intent, origin, status, note")
      .in("subscriber_item_id", subscriberIds)
      .eq("status", "active");
    if (subErr) return err(`Failed to read existing subscriptions: ${subErr.message}`);
    for (const s of (subData ?? []) as Array<{ subscriber_item_id: string; target_item_id: string | null; intent: string; origin: string }>) {
      if (s.target_item_id) covered.set(`${s.subscriber_item_id}|${s.target_item_id}`, { origin: s.origin, intent: s.intent });
    }
  }

  // Target document versions — the pin written into subscribed_at_version,
  // same source doc_subscribe uses (documents.version, not the ledger label).
  const targetDocIds = [...new Set(links.map((l) => items.get(l.to_item)?.document_id).filter(Boolean))] as string[];
  const docVersions = new Map<string, string>();
  if (targetDocIds.length > 0) {
    const { data: docData, error: docErr } = await db.from(DOCUMENTS).select("id, version").in("id", targetDocIds);
    if (docErr) return err(`Failed to read target document versions: ${docErr.message}`);
    for (const d of (docData ?? []) as Array<{ id: string; version: unknown }>) docVersions.set(d.id, String(d.version ?? ""));
  }

  const created: FactSyncCreated[] = [];
  const wouldCreate: NonNullable<DocFactSyncResult["would_create"]> = [];
  const alreadyCovered: DocFactSyncResult["already_covered"] = [];
  const skipped: DocFactSyncResult["skipped"] = [];

  // Read the admission gate ONCE, before any write. Same rule doc_subscribe
  // applies: a fact derived from a link is still an admission into the register,
  // and letting 900 of them in through a side door while admission is suspended
  // would hollow out the suspension. Unverified declares itself, never blocks.
  const pending = links.filter((l) => !covered.has(`${l.from_item}|${l.to_item}`));
  const gate = await readAdmissionGate(db);
  if (gate.suspended && pending.length > 0 && !dryRun) {
    return err(
      `Admission to subscriptions is SUSPENDED ('${ADMISSION_SUSPENDED_PARAM}' = ${gate.value}` +
        `${gate.owner ? `, owner ${gate.owner}` : ""}): ${pending.length} derivable link(s) were found and NONE were ` +
        `created. A derived 'fact' is still a new admission — admitting it here while the flag is up would be the same ` +
        `extension the flag exists to pause (REQ-SUB-013 c.3). dry_run=true still works and shows what would be created.`
    );
  }

  for (const link of links) {
    const from = items.get(link.from_item);
    const to = items.get(link.to_item);
    const key = `${link.from_item}|${link.to_item}`;
    const existing = covered.get(key);
    if (existing) {
      alreadyCovered.push({
        subscriber_code: from?.code ?? null,
        target_code: to?.code ?? null,
        relation_type: link.relation_type,
        origin: existing.origin,
      });
      continue;
    }
    if (!from || !to) {
      skipped.push({
        from_item: link.from_item,
        to_item: link.to_item,
        relation_type: link.relation_type,
        reason: `link endpoint not readable (${!from ? "from" : "to"} side) — RLS or a deleted row; never guessed at`,
      });
      continue;
    }
    if (from.project_id !== to.project_id) {
      // Cannot happen through doc_item_links (it carries one project_id and the
      // FKs are composite) — checked anyway, because a 'critical' subscription
      // across projects is refused in v1 and a silent one would bypass D-186 Q2.
      skipped.push({
        from_item: link.from_item,
        to_item: link.to_item,
        relation_type: link.relation_type,
        reason: `endpoints live in different projects (${from.project_id} vs ${to.project_id}) — a cross-project fact is not derivable here (D-186 Q2)`,
      });
      continue;
    }
    const intent = FACT_INTENT_BY_RELATION[link.relation_type as FactSyncRelation];
    if (!intent) {
      skipped.push({ from_item: link.from_item, to_item: link.to_item, relation_type: link.relation_type, reason: `no grade defined for this relation` });
      continue;
    }
    const pin = docVersions.get(to.document_id);
    if (pin == null) {
      skipped.push({
        from_item: link.from_item,
        to_item: link.to_item,
        relation_type: link.relation_type,
        reason: `target document ${to.document_id} not readable for its version — no pin can be written`,
      });
      continue;
    }

    const preview = {
      subscriber_item_id: from.id,
      subscriber_code: from.code,
      target_item_id: to.id,
      target_code: to.code,
      relation_type: link.relation_type,
      intent,
    };
    if (dryRun) {
      wouldCreate.push(preview);
      continue;
    }

    const note =
      `derived from the ${link.relation_type} link ${from.code ?? from.id} → ${to.code ?? to.id} (doc_fact_sync, PJ-7/D-210): ` +
      `the bond was already declared, this subscription is what makes it carry decay.`;
    const { data: ins, error: insErr } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .insert({
        subscriber_item_id: from.id,
        subscriber_project_id: from.project_id,
        target_item_id: to.id,
        intent,
        subscribed_at_version: pin,
        note,
        origin: "fact",
        status: "active",
      })
      .select("id")
      .maybeSingle();
    if (insErr || !ins) {
      skipped.push({
        from_item: link.from_item,
        to_item: link.to_item,
        relation_type: link.relation_type,
        reason: `insert failed: ${insErr?.message ?? "no row returned"}`,
      });
      continue;
    }
    const newId = (ins as { id: string }).id;
    // D-132: re-read before claiming it exists. Under doc_rw an RLS denial
    // affects 0 rows silently, so "insert returned an id" is not proof.
    const { data: after, error: afterErr } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .select("id, intent, origin, status, target_item_id")
      .eq("id", newId)
      .maybeSingle();
    const a = after as { intent: string; origin: string; status: string; target_item_id: string } | null;
    if (afterErr || !a || a.origin !== "fact" || a.intent !== intent || a.status !== "active" || a.target_item_id !== to.id) {
      skipped.push({
        from_item: link.from_item,
        to_item: link.to_item,
        relation_type: link.relation_type,
        reason: `insert reported id '${newId}' but the re-read does not confirm it (D-132) — treat as UNCONFIRMED`,
      });
      continue;
    }
    created.push({ subscription_id: newId, ...preview });
    covered.set(key, { origin: "fact", intent });
  }

  // Facts whose link no longer exists. They cannot be tombstoned (SEC-011, DB
  // floor) — reported precisely because nothing can be done about them from
  // here, and a decay firing from a bond nobody can see anymore is worse when
  // it is also undocumented.
  const linkPairs = new Set(links.map((l) => `${l.from_item}|${l.to_item}`));
  const orphans: NonNullable<DocFactSyncResult["orphan_facts"]> = [];
  const { data: factRows } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, subscriber_item_id, target_item_id, note, origin, status, subscriber_project_id")
    .eq("subscriber_project_id", args.project_id)
    .eq("origin", "fact")
    .eq("status", "active");
  for (const f of (factRows ?? []) as Array<{ id: string; subscriber_item_id: string; target_item_id: string | null; note: string }>) {
    if (!f.target_item_id) continue;
    if (linkPairs.has(`${f.subscriber_item_id}|${f.target_item_id}`)) continue;
    orphans.push({
      subscription_id: f.id,
      subscriber_code: items.get(f.subscriber_item_id)?.code ?? null,
      target_code: items.get(f.target_item_id)?.code ?? null,
      note: `no ${relations.join("/")} link backs this fact subscription anymore. It cannot be tombstoned (origin='fact' is refused by the DB floor, SEC-011) — declared, not removable from here.`,
    });
  }

  const result: DocFactSyncResult = {
    project_id: args.project_id,
    relation_types: relations,
    intent_map: Object.fromEntries(relations.map((r) => [r, FACT_INTENT_BY_RELATION[r]])),
    dry_run: dryRun,
    created,
    already_covered: alreadyCovered,
    skipped,
    counts: {
      links_examined: links.length,
      created: created.length,
      already_covered: alreadyCovered.length,
      skipped: skipped.length,
    },
  };
  if (dryRun) result.would_create = wouldCreate;
  if (orphans.length > 0) result.orphan_facts = orphans;
  if (!gate.verified) {
    result.admission_gate =
      `NOT VERIFIED — ${gate.reason ?? "unknown"}. Derivation ran anyway; the admission-suspension flag ` +
      `('${ADMISSION_SUSPENDED_PARAM}') could not be read, so this call cannot assert that admission is open.`;
  }
  return { ok: true, data: result };
}

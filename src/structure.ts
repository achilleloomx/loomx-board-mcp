// doc_structure — PJ-8, the half of "chi firma i verdetti non può leggere ciò
// su cui firma" that belongs to board-mcp (the other half is grants, dba/PR-2a).
//
// The gap this closes, recorded twice before it was built (sessions #126, #130):
// NO surface listed the DOCUMENTS of a project. doc_query filters ITEMS, so a
// document with no rows is indistinguishable from a document that does not
// exist, and the `documents` legend of summary=true only covers documents the
// returned rows happen to live on. An auditor asked to measure "does this
// project have a SoW / a UAT document / a published delivery" had to infer it
// from item rows — that is, could not measure it at all.
//
// Read-only, by construction: this file contains no INSERT/UPDATE/DELETE.
//
// Two principles it inherits from the rest of the corpus, because they are the
// reason the auditor could not trust the numbers before:
//   - "vuoto ≠ negato" (D-167 / SDES-DOCM-012): zero documents from a project
//     you hold no membership on is NOT evidence of an empty project. The
//     response says which of the two it is (`visibility`), and never reports a
//     confident zero it cannot back.
//   - counts are broken out, never merged into one flattering number: rows by
//     status, links by relation, subscriptions by origin AND grade. A single
//     total is exactly what hides a corpus that is all draft, or all
//     hand-made choice subscriptions with no fact behind them.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocResult, DocContext } from "./docs.js";

const DOCUMENTS = "documents";
const DOC_ITEMS = "doc_items";
const DOC_ITEM_LINKS = "doc_item_links";
const DOC_ITEM_XPROJECT_LINKS = "doc_item_xproject_links";
const GOV_DOC_VERSIONS = "gov.doc_versions";
const GOV_DOC_SUBSCRIPTIONS = "gov.doc_subscriptions";
const GOV_STALENESS = "gov.doc_subscription_staleness";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}

function docRwHandle(db: SupabaseClient): { agentInProject?: (p: string) => Promise<boolean> } | null {
  const h = db as unknown as { __docRw?: boolean; agentInProject?: (p: string) => Promise<boolean> };
  return h.__docRw ? { agentInProject: h.agentInProject } : null;
}

function tally<T extends string>(values: Array<T | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = v == null || v === "" ? "(none)" : String(v);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface DocStructureArgs {
  project_id: string;
  include_items?: boolean;
}

export interface StructureDocument {
  document_id: string;
  document_type: string;
  title: string;
  status: string;
  owner: string;
  visibility: string;
  version: string;
  publications: number;
  last_published_version: string | null;
  rows: number;
  rows_by_status: Record<string, number>;
  rows_by_item_type: Record<string, number>;
  item_codes?: string[];
}

export interface DocStructureResult {
  project_id: string;
  visibility: {
    caller: string;
    member: boolean | null; // null = the membership probe itself was unavailable
    note?: string;
  };
  documents: StructureDocument[];
  totals: {
    documents: number;
    rows: number;
    rows_by_status: Record<string, number>;
    rows_by_item_type: Record<string, number>;
    documents_published: number;
    documents_never_published: number;
    links_by_relation: Record<string, number>;
    xproject_links_by_relation: Record<string, number>;
    subscriptions_by_origin: Record<string, number>;
    subscriptions_by_intent: Record<string, number>;
    open_staleness_markings: number;
  };
  notes: string[];
}

export async function docStructure(
  db: SupabaseClient,
  args: DocStructureArgs,
  ctx: DocContext
): Promise<DocResult<DocStructureResult>> {
  if (!UUID_RE.test(args.project_id)) return err(`project_id must be a UUID.`);
  const includeItems = args.include_items ?? false;

  // Membership is read for the honesty of the answer, NOT as a permission check:
  // RLS is the floor and decides what comes back. It is here so a zero can say
  // which zero it is (D-167 visibility_gap, generalised).
  const rw = docRwHandle(db);
  let member: boolean | null = null;
  if (ctx.isLoomy) {
    member = true;
  } else if (rw?.agentInProject) {
    try {
      member = await rw.agentInProject(args.project_id);
    } catch {
      member = null;
    }
  }

  const { data: docData, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, document_type, title, status, owner, visibility, version")
    .eq("project_id", args.project_id);
  if (docErr) return err(`Failed to read documents: ${docErr.message}`);
  const docs = (Array.isArray(docData) ? docData : []) as Array<{
    id: string; document_type: string; title: string; status: string; owner: string; visibility: string; version: string;
  }>;

  const { data: itemData, error: itemErr } = await db
    .from(DOC_ITEMS)
    .select("id, document_id, code, item_type, status")
    .eq("project_id", args.project_id);
  if (itemErr) return err(`Failed to read doc_items: ${itemErr.message}`);
  const items = (Array.isArray(itemData) ? itemData : []) as Array<{
    id: string; document_id: string; code: string | null; item_type: string; status: string;
  }>;

  // Publications per document — a document's `version` column is a claim, the
  // ledger is the fact. Both are reported; they are not the same thing, and the
  // difference is exactly what the publication debt is made of.
  const pubsByDoc = new Map<string, { count: number; last: string | null; lastSeq: number }>();
  if (docs.length > 0) {
    const { data: pubData } = await db
      .from(GOV_DOC_VERSIONS)
      .select("id, document_id, version_label, version_seq")
      .in("document_id", docs.map((d) => d.id));
    for (const p of (pubData ?? []) as Array<{ document_id: string; version_label: string; version_seq: number }>) {
      const cur = pubsByDoc.get(p.document_id) ?? { count: 0, last: null, lastSeq: -1 };
      cur.count += 1;
      if (p.version_seq > cur.lastSeq) {
        cur.lastSeq = p.version_seq;
        cur.last = p.version_label;
      }
      pubsByDoc.set(p.document_id, cur);
    }
  }

  const itemsByDoc = new Map<string, typeof items>();
  for (const it of items) {
    const arr = itemsByDoc.get(it.document_id) ?? [];
    arr.push(it);
    itemsByDoc.set(it.document_id, arr);
  }

  const documents: StructureDocument[] = docs
    .map((d) => {
      const rows = itemsByDoc.get(d.id) ?? [];
      const pub = pubsByDoc.get(d.id);
      const entry: StructureDocument = {
        document_id: d.id,
        document_type: d.document_type,
        title: d.title,
        status: d.status,
        owner: d.owner,
        visibility: d.visibility,
        version: String(d.version ?? ""),
        publications: pub?.count ?? 0,
        last_published_version: pub?.last ?? null,
        rows: rows.length,
        rows_by_status: tally(rows.map((r) => r.status)),
        rows_by_item_type: tally(rows.map((r) => r.item_type)),
      };
      if (includeItems) entry.item_codes = rows.map((r) => r.code).filter((c): c is string => !!c).sort();
      return entry;
    })
    .sort((a, b) => a.document_type.localeCompare(b.document_type) || a.title.localeCompare(b.title));

  const { data: linkData, error: linkErr } = await db.from(DOC_ITEM_LINKS).select("id, relation_type").eq("project_id", args.project_id);
  if (linkErr) return err(`Failed to read ${DOC_ITEM_LINKS}: ${linkErr.message}`);
  const links = (linkData ?? []) as Array<{ relation_type: string }>;

  // Cross-project links live in their own table and are project-scoped by the
  // FROM side (D-074/D-155). Counted separately, never folded into the same
  // number: "12 links" that silently mixes the two hides where the boundary is.
  //
  // Scoped through the project's own item ids, NOT a project column: measured
  // 2026-08-28, doc_item_xproject_links has exactly (id, from_item, to_item,
  // relation_type, created_at) — no project column exists to filter on.
  //
  // The first live run of this tool guessed a `from_project_id` column, and the
  // failure taught something worth keeping: under doc_rw the whole handler runs
  // in ONE transaction, so a failed query ABORTS it, and every later read comes
  // back empty. The tool reported "0 subscriptions, 0 open markings" for a
  // project that had 104 and 1 — with a polite note about the one count it knew
  // it had missed. A measuring instrument that answers ok with phantom zeros is
  // worse than one that refuses: hence no tolerated failures below. Every read
  // error returns an error.
  const projectItemIds = items.map((i) => i.id);
  const xlinkQuery = projectItemIds.length > 0
    ? await db.from(DOC_ITEM_XPROJECT_LINKS).select("id, relation_type, from_item").in("from_item", projectItemIds)
    : { data: [] as Array<{ relation_type: string }>, error: null };
  if (xlinkQuery.error) return err(`Failed to read ${DOC_ITEM_XPROJECT_LINKS}: ${xlinkQuery.error.message}`);
  const xlinks = (xlinkQuery.data ?? []) as Array<{ relation_type: string }>;

  const { data: subData, error: subErr } = await db
    .from(GOV_DOC_SUBSCRIPTIONS)
    .select("id, origin, intent, status, subscriber_project_id")
    .eq("subscriber_project_id", args.project_id)
    .eq("status", "active");
  if (subErr) return err(`Failed to read ${GOV_DOC_SUBSCRIPTIONS}: ${subErr.message}`);
  const subs = (subData ?? []) as Array<{ id: string; origin: string; intent: string }>;

  // Open markings, scoped to THIS project's subscribers. gov.doc_subscription_staleness
  // has no project column — it hangs off the subscription — so the scoping is
  // done here, on the ids just read. An unscoped count would report the fleet's
  // markings as if they were the project's.
  const subIds = new Set(subs.map((s) => s.id));
  const { data: markData, error: markErr } = await db.from(GOV_STALENESS).select("id, subscription_id, status").eq("status", "open");
  if (markErr) return err(`Failed to read ${GOV_STALENESS}: ${markErr.message}`);
  const openMarkCount = ((markData ?? []) as Array<{ subscription_id: string }>).filter((m) => subIds.has(m.subscription_id)).length;

  const notes: string[] = [];
  const visibility: DocStructureResult["visibility"] = { caller: ctx.selfSlug, member };
  if (docs.length === 0 && member === false) {
    visibility.note =
      `Zero documents returned AND the caller is not a member of this project: this is a VISIBILITY result, not a ` +
      `measurement. Do not record "the project has no documents" — record "not measurable from here" (D-167).`;
    notes.push(visibility.note);
  } else if (member === false) {
    visibility.note =
      `The caller is not a member of this project: only documents with visibility='org' can appear here. What is listed ` +
      `is real; what is missing cannot be distinguished from what is hidden.`;
    notes.push(visibility.note);
  } else if (member === null) {
    visibility.note = `Membership could not be probed — the counts below are whatever RLS returned, and this call cannot say whether anything was withheld.`;
    notes.push(visibility.note);
  }
  if (subs.length > 0 && !subs.some((s) => s.origin === "fact")) {
    notes.push(
      `All ${subs.length} active subscriptions in this project are origin='choice' (hand-made): no traceability link ` +
      `is carrying decay here. doc_fact_sync derives the missing 'fact' subscriptions from verifies/satisfies links (PJ-7).`
    );
  }

  const publishedCount = documents.filter((d) => d.publications > 0).length;

  return {
    ok: true,
    data: {
      project_id: args.project_id,
      visibility,
      documents,
      totals: {
        documents: documents.length,
        rows: items.length,
        rows_by_status: tally(items.map((r) => r.status)),
        rows_by_item_type: tally(items.map((r) => r.item_type)),
        documents_published: publishedCount,
        documents_never_published: documents.length - publishedCount,
        links_by_relation: tally(links.map((l) => l.relation_type)),
        xproject_links_by_relation: tally(xlinks.map((l) => l.relation_type)),
        subscriptions_by_origin: tally(subs.map((s) => s.origin)),
        subscriptions_by_intent: tally(subs.map((s) => s.intent)),
        open_staleness_markings: openMarkCount,
      },
      notes,
    },
  };
}

// Unit tests for src/docs.ts document-model handlers (D-a5 §7).
// Driven by a hand-built fake DB that mimics the subset of supabase-js used by
// docs.ts, plus the two DB invariants the handlers rely on:
//   - UNIQUE (project_id, code) on doc_items
//   - composite FK (item, project_id) on doc_item_links → cross-app link rejected
//
// Run with: npx tsx --test tests/docs.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  docCreate,
  docItemUpsert,
  docItemResolve,
  docLink,
  docLinkByCode,
  docSupersede,
  docQuery,
  docItemTypes,
} from "../src/docs.ts";

type Row = Record<string, any>;
type Store = { [table: string]: Row[] };

let idSeq = 0;
function uuid(): string {
  idSeq += 1;
  const n = idSeq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

function makeDb(store: Store): SupabaseClient {
  store.documents ??= [];
  store.doc_items ??= [];
  store.doc_item_links ??= [];
  store.doc_item_gtd_links ??= [];
  store.loomx_projects ??= [];

  function query(table: string) {
    const filters: Array<{ col: string; val: unknown; op: "eq" | "in" }> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let insertData: Row | null = null;
    let updateData: Row | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let single = false;
    let maybeSingle = false;

    const apply = (rows: Row[]): Row[] =>
      rows.filter((r) =>
        filters.every((f) => {
          if (f.op === "eq") return r[f.col] === f.val;
          if (f.op === "in") return (f.val as unknown[]).includes(r[f.col]);
          return true;
        })
      );

    function checkConstraints(table: string, rowToInsert: Row): string | null {
      if (table === "doc_items" && rowToInsert.code != null) {
        const dup = store.doc_items.some(
          (r) => r.project_id === rowToInsert.project_id && r.code === rowToInsert.code
        );
        if (dup) return "duplicate key value violates unique constraint uq_doc_items_project_code";
      }
      if (table === "doc_item_links") {
        const from = store.doc_items.find((r) => r.id === rowToInsert.from_item);
        const to = store.doc_items.find((r) => r.id === rowToInsert.to_item);
        if (!from || from.project_id !== rowToInsert.project_id) {
          return 'insert violates foreign key constraint "doc_item_links_from_fk"';
        }
        if (!to || to.project_id !== rowToInsert.project_id) {
          return 'insert violates foreign key constraint "doc_item_links_to_fk"';
        }
        const dupLink = store.doc_item_links.some(
          (r) => r.from_item === rowToInsert.from_item && r.to_item === rowToInsert.to_item && r.relation_type === rowToInsert.relation_type
        );
        if (dupLink) return "duplicate key value violates unique constraint doc_item_links_unique";
        if (rowToInsert.from_item === rowToInsert.to_item) return "violates check constraint doc_item_links_no_self_link";
      }
      if (table === "doc_item_gtd_links") {
        const dup = store.doc_item_gtd_links.some(
          (r) => r.doc_item_id === rowToInsert.doc_item_id && r.gtd_item_id === rowToInsert.gtd_item_id
        );
        if (dup) return "duplicate key value violates unique constraint doc_item_gtd_links_unique";
      }
      return null;
    }

    const exec = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
      store[table] ??= [];
      if (op === "insert") {
        const row: Row = { id: uuid(), ...insertData };
        if (table === "doc_items") {
          row.sort_order ??= 0;
          row.attrs ??= {};
        }
        const cerr = checkConstraints(table, row);
        if (cerr) return { data: null, error: { message: cerr } };
        store[table].push(row);
        return finalize([row]);
      }
      if (op === "update") {
        const matched = apply(store[table]);
        matched.forEach((r) => Object.assign(r, updateData));
        return finalize(matched);
      }
      if (op === "delete") {
        const matched = apply(store[table]);
        store[table] = store[table].filter((r) => !matched.includes(r));
        return finalize(matched);
      }
      // select
      let rows = apply(store[table]);
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = a[orderCol!], bv = b[orderCol!];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return finalize(rows);
    };

    function finalize(rows: Row[]): { data: unknown; error: { message: string } | null } {
      if (single) {
        if (rows.length === 0) return { data: null, error: { message: "No rows returned" } };
        return { data: rows[0], error: null };
      }
      if (maybeSingle) {
        return { data: rows.length > 0 ? rows[0] : null, error: null };
      }
      return { data: rows, error: null };
    }

    const builder: any = {
      select() { return builder; },
      eq(col: string, val: unknown) { filters.push({ col, val, op: "eq" }); return builder; },
      in(col: string, arr: unknown[]) { filters.push({ col, val: arr, op: "in" }); return builder; },
      order(col: string, opts: { ascending?: boolean } = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      single() { single = true; return exec(); },
      maybeSingle() { maybeSingle = true; return exec(); },
      insert(data: Row) { op = "insert"; insertData = data; return builder; },
      update(data: Row) { op = "update"; updateData = data; return builder; },
      delete() { op = "delete"; return builder; },
      then(onF: any, onR: any) { return exec().then(onF, onR); },
    };
    return builder;
  }

  // REQ-GOV-016: fake must implement DocRwDb so docItemResolve uses the __docRw path
  // (the fallback direct-scan is now a throw). resolveDocItem mimics the DB function:
  // find by (project_id, code), throw P0002 if not found.
  const resolveDocItem = async (projectId: string, code: string): Promise<string> => {
    const item = (store.doc_items as Row[]).find(
      (r) => r.project_id === projectId && r.code === code
    );
    if (!item) {
      const e = new Error("no_data_found") as Error & { code?: string };
      e.code = "P0002";
      throw e;
    }
    return item.id as string;
  };

  return { from: (table: string) => query(table), __docRw: true, resolveDocItem } as unknown as SupabaseClient;
}

const ctx = { selfSlug: "board-mcp", isLoomy: false };
const PROJ_A = "00000000-0000-4000-9000-0000000000aa";
const PROJ_B = "00000000-0000-4000-9000-0000000000bb";

function seedProjects(store: Store) {
  store.loomx_projects = [{ id: PROJ_A }, { id: PROJ_B }];
}

// ---------------------------------------------------------------------------

test("doc_create → doc_item_upsert returns a UUID, idempotent on (project_id, code)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);

  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req — App A" }, ctx);
  assert.ok(doc.ok && doc.data.document_id, "document created");
  const docId = (doc as any).data.document_id;

  const up1 = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-001", body: "must send a message", attrs: { moscow: "must" },
  }, ctx);
  assert.ok(up1.ok, `upsert ok: ${JSON.stringify(up1)}`);
  assert.equal((up1 as any).data.created, true);
  const uuid1 = (up1 as any).data.item_id;
  assert.match(uuid1, /^[0-9a-f-]{36}$/);

  // Second upsert with same code → UPDATE, same UUID, no duplicate row.
  const up2 = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-001", body: "must send a message (clarified)", attrs: { moscow: "should" },
  }, ctx);
  assert.ok(up2.ok);
  assert.equal((up2 as any).data.created, false, "second upsert updates, not inserts");
  assert.equal((up2 as any).data.item_id, uuid1, "same UUID returned");
  assert.equal(store.doc_items.filter((r) => r.code === "REQ-001").length, 1, "no duplicate");
});

test("doc_item_upsert rejects invalid attrs against JSON-Schema (actionable)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const docId = (doc as any).data.document_id;
  const bad = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-X", attrs: { moscow: "maybe" },  // not in enum
  }, ctx);
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /moscow|one of/i);
});

test("doc_item_upsert rejects item_type not legal for the document_type", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const docId = (doc as any).data.document_id;
  const bad = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "kpi", code: "KPI-1", attrs: { formula: "x" },
  }, ctx);
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /not allowed in a 'req'/);
});

test("doc_item_resolve is project-scoped and errors actionably on miss", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const docId = (doc as any).data.document_id;
  await docItemUpsert(db, { project_id: PROJ_A, document_id: docId, item_type: "requirement", code: "REQ-001" }, ctx);

  const ok = await docItemResolve(db, { project_id: PROJ_A, code: "REQ-001" }, ctx);
  assert.ok(ok.ok && (ok as any).data.item_id);

  // Same code, wrong project → not found.
  const miss = await docItemResolve(db, { project_id: PROJ_B, code: "REQ-001" }, ctx);
  assert.equal(miss.ok, false);
  assert.match((miss as any).error, /does not exist in project/);
});

test("doc_link rejects non-UUID with guidance; doc_link_by_code resolves+links", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const sdesDoc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (reqDoc as any).data.document_id, item_type: "requirement", code: "REQ-001" }, ctx);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (sdesDoc as any).data.document_id, item_type: "sdes_entry", code: "SDES-001" }, ctx);

  // Non-UUID rejected.
  const bad = await docLink(db, { target_kind: "doc", from_id: "SDES-001", to_id: "REQ-001", relation_type: "satisfies" }, ctx);
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /UUID-only|must be a UUID/);

  // Sugar resolves both codes then links.
  const linked = await docLinkByCode(db, { project_id: PROJ_A, from_code: "SDES-001", to_code: "REQ-001", link_type: "satisfies" }, ctx);
  assert.ok(linked.ok, `link_by_code ok: ${JSON.stringify(linked)}`);
  assert.equal(store.doc_item_links.length, 1);
  assert.equal(store.doc_item_links[0].relation_type, "satisfies");
});

test("cross-app link is rejected with an actionable error (composite FK)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docA = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req A" }, ctx);
  const docB = await docCreate(db, { project_id: PROJ_B, document_type: "req", title: "Req B" }, ctx);
  const a = await docItemUpsert(db, { project_id: PROJ_A, document_id: (docA as any).data.document_id, item_type: "requirement", code: "REQ-001" }, ctx);
  const b = await docItemUpsert(db, { project_id: PROJ_B, document_id: (docB as any).data.document_id, item_type: "requirement", code: "REQ-001" }, ctx);

  const cross = await docLink(db, {
    target_kind: "doc",
    from_id: (a as any).data.item_id,
    to_id: (b as any).data.item_id,
    relation_type: "relates_to",
  }, ctx);
  assert.equal(cross.ok, false);
  assert.match((cross as any).error, /Cross-app link rejected|same project/i);
});

test("doc_supersede: old immutable + new row + supersedes edge, code carried", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  const up = await docItemUpsert(db, { project_id: PROJ_A, document_id: (doc as any).data.document_id, item_type: "sdes_entry", code: "SDES-001", body: "v1" }, ctx);
  const oldId = (up as any).data.item_id;

  const sup = await docSupersede(db, { old_item_id: oldId, body: "v2" }, ctx);
  assert.ok(sup.ok, `supersede ok: ${JSON.stringify(sup)}`);
  const oldRow = store.doc_items.find((r) => r.id === oldId);
  assert.equal(oldRow!.status, "superseded");
  assert.equal(oldRow!.code, null, "code detached from old row");
  const newRow = store.doc_items.find((r) => r.id === (sup as any).data.new_item_id);
  assert.equal(newRow!.code, "SDES-001", "code carried to new row");
  assert.equal(newRow!.body, "v2");
  assert.equal(store.doc_item_links.filter((l) => l.relation_type === "supersedes").length, 1);
});

test("doc_supersede: transfers doc_item_links (forward + reverse) and doc_item_gtd_links to new version", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);

  // Create two items in the same document: old (to be superseded) and target (link destination).
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  const docId = (doc as any).data.document_id;
  const upOld = await docItemUpsert(db, { project_id: PROJ_A, document_id: docId, item_type: "sdes_entry", code: "SDES-010", body: "v1" }, ctx);
  const oldId = (upOld as any).data.item_id;

  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const reqDocId = (reqDoc as any).data.document_id;
  const upTarget = await docItemUpsert(db, { project_id: PROJ_A, document_id: reqDocId, item_type: "requirement", code: "REQ-010" }, ctx);
  const targetId = (upTarget as any).data.item_id;

  // Create a third item that links TO oldId (reverse direction).
  const upReverse = await docItemUpsert(db, { project_id: PROJ_A, document_id: docId, item_type: "sdes_entry", code: "SDES-011", body: "other" }, ctx);
  const reverseId = (upReverse as any).data.item_id;

  // Forward link: old → target (satisfies).
  await docLink(db, { target_kind: "doc", from_id: oldId, to_id: targetId, relation_type: "satisfies" }, ctx);
  // Reverse link: reverse → old (relates_to).
  await docLink(db, { target_kind: "doc", from_id: reverseId, to_id: oldId, relation_type: "relates_to" }, ctx);
  // GTD link: old → some GTD item.
  const fakeGtdId = "aaaaaaaa-bbbb-4000-8000-000000000001";
  store.doc_item_gtd_links.push({ id: uuid(), doc_item_id: oldId, gtd_item_id: fakeGtdId });

  // Supersede old → new.
  const sup = await docSupersede(db, { old_item_id: oldId, body: "v2" }, ctx);
  assert.ok(sup.ok, `supersede ok: ${JSON.stringify(sup)}`);
  const newId = (sup as any).data.new_item_id;

  // Forward link should now be on new item.
  const fwdLink = store.doc_item_links.find((l) => l.from_item === newId && l.to_item === targetId && l.relation_type === "satisfies");
  assert.ok(fwdLink, "forward link transferred from old → new item");
  const fwdOnOld = store.doc_item_links.find((l) => l.from_item === oldId && l.relation_type === "satisfies");
  assert.equal(fwdOnOld, undefined, "no forward satisfies link left on old item");

  // Reverse link (from reverseId TO old) should now point to new item.
  const bwdLink = store.doc_item_links.find((l) => l.from_item === reverseId && l.to_item === newId && l.relation_type === "relates_to");
  assert.ok(bwdLink, "reverse link re-targeted to new item");
  const bwdOnOld = store.doc_item_links.find((l) => l.to_item === oldId && l.relation_type === "relates_to");
  assert.equal(bwdOnOld, undefined, "no reverse relates_to link left on old item");

  // Supersedes edge still points correctly: new → supersedes → old.
  const supersedgesEdge = store.doc_item_links.find((l) => l.from_item === newId && l.to_item === oldId && l.relation_type === "supersedes");
  assert.ok(supersedgesEdge, "supersedes edge: new → old");

  // GTD link transferred to new item.
  const gtdLink = store.doc_item_gtd_links.find((l: any) => l.doc_item_id === newId && l.gtd_item_id === fakeGtdId);
  assert.ok(gtdLink, "doc_item_gtd_link transferred from old → new item");
  const gtdOnOld = store.doc_item_gtd_links.find((l: any) => l.doc_item_id === oldId);
  assert.equal(gtdOnOld, undefined, "no doc_item_gtd_link left on old item");
});

test("doc_query traceability: req_without_sdes flags uncovered REQ then clears after link", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const sdesDoc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (reqDoc as any).data.document_id, item_type: "requirement", code: "REQ-001" }, ctx);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (sdesDoc as any).data.document_id, item_type: "sdes_entry", code: "SDES-001" }, ctx);

  const before = await docQuery(db, { project_id: PROJ_A, traceability: "req_without_sdes" }, ctx);
  assert.ok(before.ok);
  assert.equal((before as any).data.count, 1, "REQ-001 has no SDES yet");

  await docLinkByCode(db, { project_id: PROJ_A, from_code: "SDES-001", to_code: "REQ-001", link_type: "satisfies" }, ctx);

  const after = await docQuery(db, { project_id: PROJ_A, traceability: "req_without_sdes" }, ctx);
  assert.ok(after.ok);
  assert.equal((after as any).data.count, 0, "REQ-001 now covered by SDES-001");
});

test("doc_query summary: compact rows with body_chars, headline, link counts (no full body)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const sdesDoc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  const longBody = "Line one with detail.\n\nLine two padding. " + "x".repeat(300);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (reqDoc as any).data.document_id, item_type: "requirement", code: "REQ-001", body: longBody }, ctx);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (sdesDoc as any).data.document_id, item_type: "sdes_entry", code: "SDES-001" }, ctx);
  await docLinkByCode(db, { project_id: PROJ_A, from_code: "SDES-001", to_code: "REQ-001", link_type: "satisfies" }, ctx);

  const res = await docQuery(db, { project_id: PROJ_A, item_type: "requirement", summary: true }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.mode, "summary");
  const row = (res as any).data.items[0];
  assert.equal(row.code, "REQ-001");
  assert.equal(row.body_chars, longBody.length, "reports full body length");
  assert.equal(row.headline.length <= 120, true, "headline capped at 120");
  assert.equal(row.headline.includes("\n"), false, "headline whitespace-collapsed");
  assert.equal(row.body, undefined, "summary never returns full body");
  assert.equal(row.links.doc_in, 1, "REQ is the target of the satisfies link");
  assert.equal(row.links.doc_out, 0);
  assert.equal(row.links.gtd, 0);
  assert.equal(row.links.wi, 0);
});

test("doc_query fields: rejects unknown column, accepts a valid projection", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  await docItemUpsert(db, { project_id: PROJ_A, document_id: (reqDoc as any).data.document_id, item_type: "requirement", code: "REQ-001", body: "b" }, ctx);

  const bad = await docQuery(db, { project_id: PROJ_A, fields: "code,bogus" }, ctx);
  assert.equal(bad.ok, false, "unknown field rejected");
  assert.match((bad as any).error, /bogus/);

  const good = await docQuery(db, { project_id: PROJ_A, fields: "code,status" }, ctx);
  assert.ok(good.ok);
  assert.equal((good as any).data.mode, "items");
  assert.equal((good as any).data.count, 1);
});

test("doc_item_types returns schema + example for a type, and parity in full mode", () => {
  const one = docItemTypes({ item_type: "requirement" });
  assert.ok(one.ok);
  assert.ok((one as any).data.attrs_schema);
  assert.ok((one as any).data.example);

  const full = docItemTypes({});
  assert.ok(full.ok);
  assert.equal((full as any).data.capability_parity.ok, true);
});

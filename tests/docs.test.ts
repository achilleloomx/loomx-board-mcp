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
  store.doc_item_wi_links ??= [];
  store.doc_item_xproject_links ??= [];
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

  // Mimics gov.relink_superseded (D-133): repoint every link direction across all
  // four tables from oldItemId → newItemId, return the total rows touched. The real
  // function is SECURITY DEFINER, so unlike a plain doc_rw .update() it can never
  // silently affect 0 rows on a missing RLS policy.
  const relinkSuperseded = async (oldItemId: string, newItemId: string): Promise<number> => {
    let n = 0;
    const repoint = (rows: Row[], col: string) => {
      for (const r of rows) {
        if (r[col] === oldItemId) { r[col] = newItemId; n++; }
      }
    };
    repoint(store.doc_item_links, "from_item");
    repoint(store.doc_item_links, "to_item");
    repoint(store.doc_item_gtd_links, "doc_item_id");
    repoint(store.doc_item_wi_links, "doc_item_id");
    repoint(store.doc_item_xproject_links, "from_item");
    repoint(store.doc_item_xproject_links, "to_item");
    return n;
  };

  return { from: (table: string) => query(table), __docRw: true, resolveDocItem, relinkSuperseded } as unknown as SupabaseClient;
}

// Simulates gov.relink_superseded raising an error (e.g. the SECURITY DEFINER
// function's own guards, or a transient failure) — docSupersede must fail loud
// (not ok:true) rather than leave the new version's links untransferred.
function makeDbWithFailingRelink(store: Store, errorMessage: string): SupabaseClient {
  const real = makeDb(store) as any;
  return {
    from: (table: string) => real.from(table),
    __docRw: true,
    resolveDocItem: real.resolveDocItem,
    relinkSuperseded: async () => { throw new Error(errorMessage); },
  } as unknown as SupabaseClient;
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

// ---------------------------------------------------------------------------
// GTD 0cdffc2b — omitted fields are PRESERVED, destructive effects are REPORTED.
// The incident: a status-only upsert during a ~240-item ratification run wiped
// REQ-GOV-037's acceptance_criteria (2085 chars → 2) and answered ok:true.
// ---------------------------------------------------------------------------

async function seedReq(store: Store, attrs: Record<string, unknown>, body = "v1") {
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const docId = (doc as any).data.document_id;
  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", body, status: "approved", attrs,
  }, ctx);
  assert.ok(up.ok, `seed upsert ok: ${JSON.stringify(up)}`);
  return { db, docId, itemId: (up as any).data.item_id };
}

test("doc_item_upsert: omitting attrs PRESERVES them (REQ-GOV-037 regression — status-only upsert must not wipe acceptance_criteria)", async () => {
  const store: Store = {};
  const criteria = ["message persisted", "recipient sees it in inbox"];
  const { db, docId, itemId } = await seedReq(store, { moscow: "must", acceptance_criteria: criteria });

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", status: "committed",   // the "most banal operation there is"
  }, ctx);

  assert.ok(up.ok, `upsert ok: ${JSON.stringify(up)}`);
  const row = store.doc_items.find((r) => r.id === itemId)!;
  assert.deepEqual(row.attrs.acceptance_criteria, criteria, "acceptance_criteria survived a status-only upsert");
  assert.equal(row.attrs.moscow, "must", "every other attr survived too");
  assert.equal(row.status, "committed", "the field that WAS passed did change");
  assert.equal(row.body, "v1", "body untouched, as before");
  assert.ok((up as any).data.fields_preserved.includes("attrs"), "response states attrs was preserved");
  assert.ok((up as any).data.fields_written.includes("status"), "response states status was written");
});

test("doc_item_upsert: omitting status PRESERVES it (a body edit must not reset a committed item to the type default)", async () => {
  const store: Store = {};
  const { db, docId, itemId } = await seedReq(store, { moscow: "must" });

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", body: "v2 — clarified",
  }, ctx);

  assert.ok(up.ok);
  const row = store.doc_items.find((r) => r.id === itemId)!;
  assert.equal(row.status, "approved", "status NOT reset to spec.default_status ('draft')");
  assert.equal(row.body, "v2 — clarified");
  assert.equal((up as any).data.status, "approved", "response reports the row's real status");
  assert.ok((up as any).data.fields_preserved.includes("status"));
});

test("doc_item_upsert: attrs:{} passed on purpose still CLEARS, and says which keys it dropped", async () => {
  const store: Store = {};
  const { db, docId, itemId } = await seedReq(store, { moscow: "must", rationale: "because" });

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", attrs: {},
  }, ctx);

  assert.ok(up.ok, "emptying attrs is a legitimate operation, not an error");
  const row = store.doc_items.find((r) => r.id === itemId)!;
  assert.deepEqual(row.attrs, {}, "explicit {} clears — omission is the no-op, not {}");
  const warnings: string[] = (up as any).data.warnings ?? [];
  assert.equal(warnings.length, 1, `one warning expected, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /moscow/);
  assert.match(warnings[0], /rationale/);
});

test("doc_item_upsert: a partial attrs replacement names the keys it drops (attrs is replaced, never merged)", async () => {
  const store: Store = {};
  const { db, docId } = await seedReq(store, { moscow: "must", acceptance_criteria: ["a", "b"], rationale: "why" });

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", attrs: { moscow: "should" },
  }, ctx);

  assert.ok(up.ok);
  const warnings: string[] = (up as any).data.warnings ?? [];
  assert.match(warnings.join("\n"), /acceptance_criteria/, "the dropped key is named");
  assert.match(warnings.join("\n"), /rationale/);
  assert.doesNotMatch(warnings.join("\n"), /\bmoscow\b/, "a key that was re-passed is not reported as dropped");
});

test("doc_item_upsert: replacing attrs carries _client_token forward (dropping it would split one item in two)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const docId = (doc as any).data.document_id;

  const first = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    body: "prose row", client_token: "tok-1", attrs: { moscow: "must" },
  }, ctx);
  assert.ok(first.ok);
  const itemId = (first as any).data.item_id;

  // Re-upsert by the SAME token but with a fresh attrs payload that omits it.
  const second = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    client_token: "tok-1", attrs: { moscow: "should" },
  }, ctx);
  assert.ok(second.ok);
  assert.equal((second as any).data.created, false, "matched the existing row by token");
  assert.equal((second as any).data.item_id, itemId);

  const row = store.doc_items.find((r) => r.id === itemId)!;
  assert.equal(row.attrs._client_token, "tok-1", "token survives an attrs replacement");
  assert.equal(store.doc_items.filter((r) => r.document_id === docId).length, 1, "no split row");
});

test("doc_item_upsert: retyping an item in place is allowed but never silent", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "sow", title: "SoW" }, ctx);
  const docId = (doc as any).data.document_id;
  const seeded = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "objective", code: "OBJ-001", body: "ship it",
  }, ctx);
  assert.ok(seeded.ok, `seed ok: ${JSON.stringify(seeded)}`);

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docId, item_type: "deliverable",
    code: "OBJ-001", body: "ship it",
  }, ctx);

  assert.ok(up.ok, `retype allowed: ${JSON.stringify(up)}`);
  assert.match(((up as any).data.warnings ?? []).join("\n"), /item_type changed in place/);
});

test("doc_item_upsert: the read-back tolerates JSONB key REORDER (real doc_rw round-trip) but not a changed value", async () => {
  const store: Store = {};
  const { db, docId } = await seedReq(store, { moscow: "must" });

  // Postgres hands JSONB back with its keys in its own order. A naive compare
  // would report a phantom mismatch on every attrs write — caught live, not in
  // this fake, which is why the fake has to reproduce it.
  const reordering = {
    from: (table: string) => {
      const q = (db as any).from(table);
      if (table !== "doc_items") return q;
      const origSelect = q.select.bind(q);
      q.select = (cols: string) => {
        const chain = origSelect(cols);
        const origMaybe = chain.maybeSingle.bind(chain);
        chain.maybeSingle = async () => {
          const res = await origMaybe();
          const row = (res as any).data;
          if (row?.attrs) {
            (res as any).data = { ...row, attrs: Object.fromEntries(Object.entries(row.attrs).reverse()) };
          }
          return res;
        };
        return chain;
      };
      return q;
    },
    __docRw: true,
  } as unknown as SupabaseClient;

  const up = await docItemUpsert(reordering, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", attrs: { moscow: "should", rationale: "r", acceptance_criteria: ["x"] },
  }, ctx);
  assert.ok(up.ok, `key reorder is not a mismatch: ${JSON.stringify(up)}`);
});

test("doc_item_upsert: a write that silently affects 0 rows fails LOUD (D-132 read-back, not the response)", async () => {
  const store: Store = {};
  const { db, docId } = await seedReq(store, { moscow: "must" });

  // A DB that accepts the UPDATE, raises nothing, and changes nothing — the
  // exact shape of an RLS denial under doc_rw (v0.8.1 no-RETURNING mode).
  const swallowing = {
    from: (table: string) => {
      const q = (db as any).from(table);
      if (table !== "doc_items") return q;
      const origUpdate = q.update.bind(q);
      q.update = (_data: any) => origUpdate({});  // drop every column, keep the chain
      return q;
    },
    __docRw: true,
  } as unknown as SupabaseClient;

  const up = await docItemUpsert(swallowing, {
    project_id: PROJ_A, document_id: docId, item_type: "requirement",
    code: "REQ-GOV-037", body: "this never lands",
  }, ctx);

  assert.equal(up.ok, false, "must not answer ok:true on a write that did not happen");
  assert.match((up as any).error, /Write NOT applied/);
  assert.match((up as any).error, /body/);
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

test("doc_supersede: fails loud (not ok:true) when gov.relink_superseded fails (D-133 regression of msg 40ef3e30's RLS-gap finding)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDbWithFailingRelink(store, "old.status <> 'superseded' (23514)");

  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  const docId = (doc as any).data.document_id;
  const upOld = await docItemUpsert(db, { project_id: PROJ_A, document_id: docId, item_type: "sdes_entry", code: "SDES-020", body: "v1" }, ctx);
  const oldId = (upOld as any).data.item_id;

  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const upTarget = await docItemUpsert(db, { project_id: PROJ_A, document_id: (reqDoc as any).data.document_id, item_type: "requirement", code: "REQ-020" }, ctx);
  const targetId = (upTarget as any).data.item_id;

  // A real link that MUST survive the version bump — the exact traceability edge
  // (SDES→satisfies→REQ) the GTD 6637405b finding is about.
  await docLink(db, { target_kind: "doc", from_id: oldId, to_id: targetId, relation_type: "satisfies" }, ctx);

  const sup = await docSupersede(db, { old_item_id: oldId, body: "v2" }, ctx);
  assert.equal(sup.ok, false, "must fail loud, not silently succeed with an orphaned link");
  assert.match((sup as any).error, /link transfer .*gov\.relink_superseded.* failed/i);

  // The link is still on the (now immutable, superseded) old item — orphaned, but
  // at least the caller was told, instead of getting a false ok:true.
  const stillOnOld = store.doc_item_links.find((l) => l.from_item === oldId && l.relation_type === "satisfies");
  assert.ok(stillOnOld, "link left dangling on the superseded item when relink fails");
});

test("doc_supersede: refuses (not ok:true) when db is not a DocRwDb — no silent fallback to the old direct-update gap", async () => {
  const store: Store = {};
  seedProjects(store);
  const real = makeDb(store) as any;
  // A plain (non-doc_rw) client: same query surface, but no __docRw/relinkSuperseded —
  // exactly what a service_role client looks like. Must not silently reintroduce the
  // 6-.update() pattern the RPC replaced.
  const db = { from: (table: string) => real.from(table) } as unknown as SupabaseClient;

  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "Sdes" }, ctx);
  const upOld = await docItemUpsert(db, { project_id: PROJ_A, document_id: (doc as any).data.document_id, item_type: "sdes_entry", code: "SDES-021", body: "v1" }, ctx);
  const oldId = (upOld as any).data.item_id;

  const sup = await docSupersede(db, { old_item_id: oldId, body: "v2" }, ctx);
  assert.equal(sup.ok, false, "must refuse, not silently skip the link transfer");
  assert.match((sup as any).error, /not a DocRwDb/i);
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

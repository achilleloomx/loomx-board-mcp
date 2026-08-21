// Unit tests for src/docs.ts document-model handlers (D-a5 §7).
// Driven by a hand-built fake DB that mimics the subset of supabase-js used by
// docs.ts, plus the two DB invariants the handlers rely on:
//   - UNIQUE (project_id, code) on doc_items
//   - composite FK (item, project_id) on doc_item_links → cross-app link rejected
//
// Run with: npx tsx --test tests/docs.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

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
import { type Row, type Store, uuid, makeDb, makeDbWithFailingRelink, ctx, PROJ_A, PROJ_B, seedProjects } from "./fakeDb.ts";

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

test("cross-project link routes to doc_item_xproject_links regardless of relation_type label (SDES-SUB-005, D-155)", async () => {
  // Superseded by SDES-SUB-005: routing is decided by the FACT of the two
  // endpoints' project_id, not by the relation_type label — a cross-project
  // 'relates_to' used to be rejected (registry claimed only 'references' was
  // cross-project-capable, which D-155 had already made false at the DB
  // level). It now routes to doc_item_xproject_links instead of failing.
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
  assert.ok(cross.ok, `cross-project link ok: ${JSON.stringify(cross)}`);
  assert.equal((cross as any).data.relation_type, "relates_to");
  assert.equal(store.doc_item_xproject_links.length, 1);
  assert.equal(store.doc_item_links.length, 0);
});

test("same-project link still routes to doc_item_links (unchanged)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const doc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req" }, ctx);
  const a = await docItemUpsert(db, { project_id: PROJ_A, document_id: (doc as any).data.document_id, item_type: "requirement", code: "REQ-001" }, ctx);
  const b = await docItemUpsert(db, { project_id: PROJ_A, document_id: (doc as any).data.document_id, item_type: "requirement", code: "REQ-002" }, ctx);

  const link = await docLink(db, {
    target_kind: "doc",
    from_id: (a as any).data.item_id,
    to_id: (b as any).data.item_id,
    relation_type: "amends",
  }, ctx);
  assert.ok(link.ok, `same-project link ok: ${JSON.stringify(link)}`);
  assert.equal(store.doc_item_links.length, 1);
  assert.equal(store.doc_item_xproject_links.length, 0);
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

test("doc_item_upsert on a document that genuinely doesn't exist: plain 404, oracle confirms it, doc_create is fine (D-167 point 4)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store); // no memberships granted — irrelevant once the oracle answers
  const someDocId = uuid(); // never created, anywhere

  // Before D-167 point 4, a caller with no standing on the named project got the
  // hedged "may exist but can't be confirmed" text even when the id was pure
  // fiction — the membership heuristic couldn't tell. doc_document_exists can:
  // ground truth says false, so the answer is the plain, unhedged 404.
  const res = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: someDocId, item_type: "requirement", code: "REQ-002",
  }, { selfSlug: "dba", isLoomy: false });
  assert.equal(res.ok, false);
  assert.match((res as any).error, new RegExp(`not found in project ${PROJ_A}`));
  assert.doesNotMatch((res as any).error, /Access denied|membership/i, "no membership heuristic needed anymore");
  assert.doesNotMatch((res as any).error, /create it first with doc_create/i);
});

// ---------------------------------------------------------------------------
// D-167 extended (GTD dc4e943e) — the three outcomes of a 0-row document lookup.
// The fakes run with rls:true so `documents` hides what production hides.
// ---------------------------------------------------------------------------

function seedDocument(store: Store, projectId: string, visibility: string, title: string): string {
  const id = uuid();
  (store.documents ??= []).push({
    id, project_id: projectId, document_type: "decisions", title,
    visibility, status: "draft", version: "1.0", owner: "loomy",
  });
  return id;
}

test("doc_item_upsert, document absent: plain 404, oracle rules out the RLS-hidden case (D-167 point 4)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store, new Set([PROJ_A]), { rls: true });
  const bogusDocId = uuid(); // never created, anywhere

  const res = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: bogusDocId, item_type: "requirement", code: "REQ-003",
  }, ctx);
  assert.equal(res.ok, false);
  assert.equal((res as any).error, `document_id '${bogusDocId}' not found in project ${PROJ_A}.`);
  assert.doesNotMatch((res as any).error, /create it first with doc_create/i);
});

test("doc_item_upsert, document exists in ANOTHER project and is org-visible: names the real project, forbids doc_create (D-167)", async () => {
  const store: Store = {};
  seedProjects(store);
  // The CFG-090 shape: caller is a member of the project it named, the document
  // lives elsewhere. Org-visible → RLS lets it through, so docItemUpsert's own
  // non-scoped lookup reaches the mismatch branch before documentNotFoundError.
  // What this test pins is that the branch now carries the *instruction* (don't
  // create, retry there) and not just the diagnosis.
  const realDocId = seedDocument(store, PROJ_B, "org", "Configurazioni verificate — decision-enforcement");
  const db = makeDb(store, new Set([PROJ_A]), { rls: true });

  const res = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: realDocId, item_type: "requirement", code: "REQ-004",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, new RegExp(`belongs to project ${PROJ_B}`));
  assert.match((res as any).error, /Do NOT call doc_create/);
  assert.match((res as any).error, new RegExp(`retry with project_id=${PROJ_B}`));
  assert.match((res as any).error, /Configurazioni verificate/); // title, so the caller recognises it
});

test("doc_item_upsert, document exists in ANOTHER project but is project-visible: 403, no leak, explicit 'do not create' (D-167 point 4)", async () => {
  const store: Store = {};
  seedProjects(store);
  // The 2026-08-16 incident verbatim: loomy's document in PROJ_B with the
  // doc_create default visibility='project'; caller is a member of PROJ_A only.
  // Before D-167 point 4 this was indistinguishable from "absent" — the oracle
  // now resolves it to a definite 403.
  const hiddenDocId = seedDocument(store, PROJ_B, "project", "loomy's private doc");
  const db = makeDb(store, new Set([PROJ_A]), { rls: true });

  const res = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: hiddenDocId, item_type: "requirement", code: "REQ-005",
  }, ctx);
  assert.equal(res.ok, false);
  // Leak floor: the oracle returns ONLY true/false — the message must not
  // reconstruct or disclose the document's real project or title from elsewhere.
  assert.doesNotMatch((res as any).error, new RegExp(PROJ_B));
  assert.doesNotMatch((res as any).error, /loomy's private doc/);
  // Repair floor (dba's constraint #1): the instruction that prevents the
  // duplicate, not just a diagnosis.
  assert.match((res as any).error, /Do NOT call doc_create/);
  assert.match((res as any).error, /exists but is not accessible/);
  assert.doesNotMatch((res as any).error, /create it first with doc_create/i);
});

test("doc_item_upsert 403 text is IDENTICAL regardless of the caller's own membership on the named project (dba's uniformity constraint)", async () => {
  const store: Store = {};
  seedProjects(store);
  const hiddenDocId = seedDocument(store, PROJ_B, "project", "loomy's private doc");

  // Same hidden document, two callers: one a member of the NAMED project (PROJ_A),
  // one a member of nothing at all. If the 403 wording varied between them, the
  // wording itself would be an unaudited second oracle about membership.
  const dbMember = makeDb(store, new Set([PROJ_A]), { rls: true });
  const dbStranger = makeDb(store, new Set(), { rls: true });

  const resMember = await docItemUpsert(dbMember, {
    project_id: PROJ_A, document_id: hiddenDocId, item_type: "requirement", code: "REQ-006",
  }, ctx);
  const resStranger = await docItemUpsert(dbStranger, {
    project_id: PROJ_A, document_id: hiddenDocId, item_type: "requirement", code: "REQ-006",
  }, ctx);

  assert.equal(resMember.ok, false);
  assert.equal(resStranger.ok, false);
  assert.equal((resMember as any).error, (resStranger as any).error, "identical text, membership-independent");
});

test("doc_item_upsert: existence-probe failure doesn't assert either certainty", async () => {
  const store: Store = {};
  seedProjects(store);
  const bogusDocId = uuid();
  const throwing = {
    from: (table: string) => (makeDb(store) as any).from(table),
    __docRw: true,
    documentExists: async () => { throw new Error("function doc_document_exists(uuid) does not exist"); },
  } as unknown as SupabaseClient;

  const res = await docItemUpsert(throwing, {
    project_id: PROJ_A, document_id: bogusDocId, item_type: "requirement", code: "REQ-007",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not found in project/);
  assert.match((res as any).error, /could not be confirmed/);
  assert.doesNotMatch((res as any).error, /create it first with doc_create/i);
});

test("doc_query 0 rows + no project membership: visibility_gap:true (D-167, closes the GTD 63142305 false-green class)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store); // no memberships granted

  const res = await docQuery(db, { project_id: PROJ_A, item_type: "requirement" }, { selfSlug: "auditor", isLoomy: false });
  assert.ok(res.ok);
  assert.equal((res as any).data.count, 0);
  assert.equal((res as any).data.visibility_gap, true);
  assert.match((res as any).data.note, /RLS block rather than an empty corpus/);
});

test("doc_query 0 rows + caller IS a project member: no visibility_gap noise (D-167)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docQuery(db, { project_id: PROJ_A, item_type: "requirement" }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.count, 0);
  assert.equal((res as any).data.visibility_gap, undefined);
});

test("doc_query traceability req_without_sdes: empty project + no membership flags visibility_gap (D-167)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store); // no memberships granted

  const res = await docQuery(db, { project_id: PROJ_A, traceability: "req_without_sdes" }, { selfSlug: "auditor", isLoomy: false });
  assert.ok(res.ok);
  assert.equal((res as any).data.count, 0);
  assert.equal((res as any).data.visibility_gap, true);
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

// ---------------------------------------------------------------------------
// GTD 4a591cfe — the "wrong document" class. The authoritative identity of a
// coded row is (project_id, code); the document is deduced, never trusted.
// ---------------------------------------------------------------------------

async function seedTwoDocs(store: Store) {
  seedProjects(store);
  const db = makeDb(store);
  const a = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req — half A" }, ctx);
  const b = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "Req — half B" }, ctx);
  const docA = (a as any).data.document_id;
  const docB = (b as any).data.document_id;
  const seeded = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docA, item_type: "requirement",
    code: "REQ-D2", body: "lives on A", attrs: { moscow: "must" },
  }, ctx);
  assert.ok(seeded.ok, `seed ok: ${JSON.stringify(seeded)}`);
  return { db, docA, docB, itemId: (seeded as any).data.item_id };
}

test("doc_item_upsert: document_id omitted on an existing code → deduced, row updated where it lives", async () => {
  const store: Store = {};
  const { db, docA, itemId } = await seedTwoDocs(store);

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, item_type: "requirement",
    code: "REQ-D2", body: "edited without naming the document",
  }, ctx);
  assert.ok(up.ok, `deduced upsert ok: ${JSON.stringify(up)}`);
  assert.equal((up as any).data.created, false);
  assert.equal((up as any).data.item_id, itemId);
  assert.equal((up as any).data.document_id, docA, "response says where the row lives");
  const row = store.doc_items.find((r) => r.code === "REQ-D2");
  assert.equal(row!.document_id, docA, "row not moved");
  assert.equal(row!.body, "edited without naming the document");
});

test("doc_item_upsert: WRONG document_id on an existing code self-corrects with a warning — no silent duplicate, no silent redirect", async () => {
  const store: Store = {};
  const { db, docA, docB, itemId } = await seedTwoDocs(store);

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docB, item_type: "requirement",
    code: "REQ-D2", body: "edited while believing it was on B",
  }, ctx);
  assert.ok(up.ok, `self-correcting upsert ok: ${JSON.stringify(up)}`);
  assert.equal((up as any).data.item_id, itemId, "same row, not a duplicate");
  assert.equal((up as any).data.document_id, docA, "response declares the real document");
  const warnings: string[] = (up as any).data.warnings ?? [];
  assert.ok(
    warnings.some((w) => w.includes("document deduced from code")),
    `mismatch is DECLARED, never silent: ${JSON.stringify(warnings)}`
  );
  assert.equal(store.doc_items.filter((r) => r.code === "REQ-D2").length, 1, "no duplicate row");
  assert.equal(store.doc_items.find((r) => r.code === "REQ-D2")!.document_id, docA, "row not moved to B");
});

test("doc_item_upsert: NEW code with no document_id errors actionably (deduction never invents a home)", async () => {
  const store: Store = {};
  const { db } = await seedTwoDocs(store);

  const up = await docItemUpsert(db, {
    project_id: PROJ_A, item_type: "requirement",
    code: "REQ-NEW", body: "brand new",
  }, ctx);
  assert.ok(!up.ok, "must refuse");
  assert.match((up as any).error, /requires document_id/i);
  assert.match((up as any).error, /doc_item_resolve/i, "points at the code-checking move");
  assert.equal(store.doc_items.filter((r) => r.code === "REQ-NEW").length, 0, "nothing created");
});

test("doc_query summary: rows carry document_id and the response carries a documents legend (multi-document projects visible at a glance)", async () => {
  const store: Store = {};
  const { db, docA, docB } = await seedTwoDocs(store);
  const other = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: docB, item_type: "requirement",
    code: "REQ-D2-B", body: "lives on B",
  }, ctx);
  assert.ok(other.ok);

  const res = await docQuery(db, { project_id: PROJ_A, summary: true }, ctx);
  assert.ok(res.ok, `summary ok: ${JSON.stringify(res)}`);
  const items = (res as any).data.items as any[];
  assert.ok(items.length >= 2);
  for (const it of items) assert.ok(it.document_id, `each summary row names its document: ${JSON.stringify(it)}`);
  const legend = (res as any).data.documents as Record<string, { title: string; document_type: string }>;
  assert.ok(legend, "documents legend present");
  assert.equal(legend[docA]?.title, "Req — half A");
  assert.equal(legend[docB]?.title, "Req — half B");
});

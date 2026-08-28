// Unit tests for src/structure.ts (doc_structure — PJ-8, the structure-reading
// surface the auditor could not have).
//
// Run with: npx tsx --test tests/structure.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { docStructure } from "../src/structure.ts";
import { makeDb, uuid, ctx, PROJ_A, PROJ_B, seedProjects, type Store, type Row } from "./fakeDb.ts";

function seedDoc(store: Store, id: string, opts: Partial<Row> = {}): void {
  store.documents ??= [];
  store.documents.push({
    id, project_id: PROJ_A, document_type: "req", title: "Doc", status: "draft",
    owner: "board-mcp", visibility: "project", version: "1.0", ...opts,
  });
}

function seedItem(store: Store, document_id: string, opts: Partial<Row> = {}): string {
  store.doc_items ??= [];
  const id = uuid();
  store.doc_items.push({
    id, project_id: PROJ_A, document_id, code: null, item_type: "requirement",
    status: "draft", owner: "board-mcp", body: "x", attrs: {}, ...opts,
  });
  return id;
}

test("doc_structure: lists documents that have NO rows — the gap that made empty and absent identical", async () => {
  const store: Store = {};
  seedProjects(store);
  const empty = uuid();
  const full = uuid();
  seedDoc(store, empty, { document_type: "uat", title: "UAT — empty" });
  seedDoc(store, full, { document_type: "req", title: "Requirements" });
  seedItem(store, full, { code: "REQ-001", status: "approved" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docStructure(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.totals.documents, 2);
  const uat = res.data.documents.find((d) => d.document_type === "uat")!;
  assert.equal(uat.rows, 0); // present, and visibly empty — not missing
  const req = res.data.documents.find((d) => d.document_type === "req")!;
  assert.equal(req.rows, 1);
  assert.deepEqual(req.rows_by_status, { approved: 1 });
});

test("doc_structure: counts are broken out by status and type, never merged", async () => {
  const store: Store = {};
  seedProjects(store);
  const d = uuid();
  seedDoc(store, d, { document_type: "sdes" });
  seedItem(store, d, { item_type: "sdes_entry", status: "active" });
  seedItem(store, d, { item_type: "sdes_entry", status: "draft" });
  seedItem(store, d, { item_type: "section", status: "draft" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docStructure(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.totals.rows_by_status, { active: 1, draft: 2 });
  assert.deepEqual(res.data.totals.rows_by_item_type, { sdes_entry: 2, section: 1 });
});

test("doc_structure: the declared version and the ledger are reported separately", async () => {
  const store: Store = {};
  seedProjects(store);
  const published = uuid();
  const claimed = uuid();
  seedDoc(store, published, { document_type: "req", title: "Published", version: "1.0" });
  seedDoc(store, claimed, { document_type: "sdes", title: "Never published", version: "1.0" });
  store["gov.doc_versions"] = [
    { id: uuid(), document_id: published, version_label: "1.0", version_seq: 1 },
  ];
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docStructure(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const pub = res.data.documents.find((d) => d.title === "Published")!;
  const never = res.data.documents.find((d) => d.title === "Never published")!;
  assert.equal(pub.publications, 1);
  assert.equal(pub.last_published_version, "1.0");
  // The claim and the fact disagree, and both are visible — this is the shape
  // of the publication debt (93% of subscriptions pinned to unpublished targets).
  assert.equal(never.version, "1.0");
  assert.equal(never.publications, 0);
  assert.equal(never.last_published_version, null);
  assert.equal(res.data.totals.documents_published, 1);
  assert.equal(res.data.totals.documents_never_published, 1);
});

test("doc_structure: zero documents for a non-member is a VISIBILITY result, and says so", async () => {
  const store: Store = {};
  seedProjects(store);
  seedDoc(store, uuid(), { project_id: PROJ_B, visibility: "project" });
  const db = makeDb(store, new Set(), { rls: true }); // member of nothing

  const res = await docStructure(db, { project_id: PROJ_B }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.totals.documents, 0);
  assert.equal(res.data.visibility.member, false);
  assert.match(res.data.visibility.note ?? "", /VISIBILITY result, not a measurement/);
  assert.match(res.data.notes.join(" "), /not measurable from here/);
});

test("doc_structure: an all-'choice' subscription set is called out — no link is carrying decay", async () => {
  const store: Store = {};
  seedProjects(store);
  const d = uuid();
  seedDoc(store, d);
  const a = seedItem(store, d, { code: "UAT-1", item_type: "uat_case" });
  const b = seedItem(store, d, { code: "SDES-1", item_type: "sdes_entry" });
  store["gov.doc_subscriptions"] = [
    { id: uuid(), subscriber_item_id: a, subscriber_project_id: PROJ_A, target_item_id: b, intent: "critical", origin: "choice", status: "active", note: "n" },
  ];
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docStructure(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.totals.subscriptions_by_origin, { choice: 1 });
  assert.deepEqual(res.data.totals.subscriptions_by_intent, { critical: 1 });
  assert.match(res.data.notes.join(" "), /no traceability link\s+is carrying decay|carrying decay/);
});

test("doc_structure: open markings are scoped to this project's subscribers, not the fleet's", async () => {
  const store: Store = {};
  seedProjects(store);
  const d = uuid();
  seedDoc(store, d);
  const a = seedItem(store, d, { code: "UAT-1", item_type: "uat_case" });
  const b = seedItem(store, d, { code: "SDES-1", item_type: "sdes_entry" });
  store["gov.doc_subscriptions"] = [
    { id: "sub-mine", subscriber_item_id: a, subscriber_project_id: PROJ_A, target_item_id: b, intent: "critical", origin: "fact", status: "active", note: "n" },
    { id: "sub-theirs", subscriber_item_id: uuid(), subscriber_project_id: PROJ_B, target_item_id: b, intent: "critical", origin: "fact", status: "active", note: "n" },
  ];
  store["gov.doc_subscription_staleness"] = [
    { id: uuid(), subscription_id: "sub-mine", status: "open" },
    { id: uuid(), subscription_id: "sub-theirs", status: "open" },
    { id: uuid(), subscription_id: "sub-mine", status: "closed" },
  ];
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docStructure(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.totals.open_staleness_markings, 1);
});

test("doc_structure: include_items lists the codes, default does not", async () => {
  const store: Store = {};
  seedProjects(store);
  const d = uuid();
  seedDoc(store, d);
  seedItem(store, d, { code: "REQ-002" });
  seedItem(store, d, { code: "REQ-001" });
  seedItem(store, d, { code: null });
  const db = makeDb(store, new Set([PROJ_A]));

  const lean = await docStructure(db, { project_id: PROJ_A }, ctx);
  assert.equal(lean.ok, true);
  if (!lean.ok) return;
  assert.equal(lean.data.documents[0].item_codes, undefined);

  const full = await docStructure(db, { project_id: PROJ_A, include_items: true }, ctx);
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.deepEqual(full.data.documents[0].item_codes, ["REQ-001", "REQ-002"]); // sorted, code-less rows dropped
});

test("doc_structure: rejects a non-uuid project_id", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store, new Set([PROJ_A]));
  const res = await docStructure(db, { project_id: "not-a-uuid" }, ctx);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------------------
// doc_rename — PJ-5, the verb that did not exist
// ---------------------------------------------------------------------------

import { docRename } from "../src/docs.ts";

test("doc_rename: renames the title and re-reads it", async () => {
  const store: Store = {};
  seedProjects(store);
  const id = uuid();
  seedDoc(store, id, { title: "Old name", owner: "board-mcp" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docRename(db, { document_id: id, new_title: "LoomX Framework - Board MCP - SoW" }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.old_title, "Old name");
  assert.equal(res.data.new_title, "LoomX Framework - Board MCP - SoW");
  assert.equal(store.documents.find((d) => d.id === id)!.title, "LoomX Framework - Board MCP - SoW");
  assert.equal(res.data.naming_warning, undefined);
});

test("doc_rename: a long dash comes back as a warning, and the rename still happens", async () => {
  const store: Store = {};
  seedProjects(store);
  const id = uuid();
  seedDoc(store, id, { title: "Old", owner: "board-mcp" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docRename(db, { document_id: id, new_title: "Requirements — Board MCP" }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.data.naming_warning ?? "", /PG-007/);
  assert.equal(store.documents.find((d) => d.id === id)!.title, "Requirements — Board MCP");
});

test("doc_rename: a non-owner is refused", async () => {
  const store: Store = {};
  seedProjects(store);
  const id = uuid();
  seedDoc(store, id, { title: "Theirs", owner: "loomy" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docRename(db, { document_id: id, new_title: "Mine now" }, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /Not legitimated/);
  assert.equal(store.documents.find((d) => d.id === id)!.title, "Theirs");
});

test("doc_rename: renaming to the same title is a no-op, not an error", async () => {
  const store: Store = {};
  seedProjects(store);
  const id = uuid();
  seedDoc(store, id, { title: "Same", owner: "board-mcp" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docRename(db, { document_id: id, new_title: "Same" }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.old_title, res.data.new_title);
});

test("doc_rename: empty title is refused", async () => {
  const store: Store = {};
  seedProjects(store);
  const id = uuid();
  seedDoc(store, id, { title: "X", owner: "board-mcp" });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docRename(db, { document_id: id, new_title: "   " }, ctx);
  assert.equal(res.ok, false);
});

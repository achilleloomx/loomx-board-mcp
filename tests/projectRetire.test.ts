// Unit tests for src/projectRetire.ts (project_retire — SDES-DOCM-030/031/032/
// 033/035, Ritiro progetto fase 3, mandato Achille 15/09, GTD 1061ce6e).
//
// Run with: npx tsx --test tests/projectRetire.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { projectRetire } from "../src/projectRetire.ts";
import { makeDb, uuid, PROJ_A, PROJ_B, seedProjects, type Store, type Row } from "./fakeDb.ts";

function ctxFor(db: ReturnType<typeof makeDb>, selfSlug: string, isLoomy = false) {
  return { selfSlug, isLoomy, serviceDb: db as any };
}

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

function seedOwnedProject(store: Store, agentId: string): void {
  store.loomx_projects = store.loomx_projects ?? [];
  const row = store.loomx_projects.find((r) => r.id === PROJ_A);
  if (row) row.agent_id = agentId;
  else store.loomx_projects.push({ id: PROJ_A, agent_id: agentId });
}

// ---------------------------------------------------------------------------

test("project_retire: only the project's responsible agent or loomy may retire it", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "atlas");
  const db = makeDb(store);

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "x" }, ctxFor(db, "board-mcp"));
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not legitimated/);
});

test("project_retire: loomy can retire any project regardless of responsible agent", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "atlas");
  const db = makeDb(store);
  const d = uuid();
  seedDoc(store, d);
  seedItem(store, d, { code: "REQ-001" });

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "x" }, ctxFor(db, "loomy", true));
  assert.ok(res.ok, JSON.stringify(res));
});

test("project_retire dry_run: reports a block for a row with an incoming link, none for an isolated row", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "board-mcp");
  const db = makeDb(store);
  const d = uuid();
  seedDoc(store, d);
  const req = seedItem(store, d, { code: "REQ-001", item_type: "requirement" });
  const sdes = seedItem(store, d, { code: "SDES-001", item_type: "sdes_entry" });
  const isolated = seedItem(store, d, { code: "REQ-002", item_type: "requirement" });
  store.doc_item_links.push({ id: uuid(), from_item: sdes, to_item: req, relation_type: "satisfies", project_id: PROJ_A });

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "x", dry_run: true }, ctxFor(db, "board-mcp"));
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.data.dry_run, true);
  assert.equal(res.data.rows_considered, 3);
  assert.equal(res.data.blocks.length, 1);
  assert.equal(res.data.blocks[0].item_id, req);
  assert.equal(res.data.blocks[0].links_in, 1);
  assert.equal(res.data.retired.length, 0, "dry_run never writes");
  assert.equal(store.doc_items.find((r) => r.id === isolated)!.status, "draft", "nothing touched on a preview");
});

test("project_retire dry_run=false NEGATIVE CASE: refuses wholesale when a block remains anywhere in the project", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "board-mcp");
  const db = makeDb(store);
  const d = uuid();
  seedDoc(store, d);
  const req = seedItem(store, d, { code: "REQ-001", item_type: "requirement" });
  const sdes = seedItem(store, d, { code: "SDES-001", item_type: "sdes_entry" });
  store.doc_item_links.push({ id: uuid(), from_item: sdes, to_item: req, relation_type: "satisfies", project_id: PROJ_A });

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "x", dry_run: false }, ctxFor(db, "board-mcp"));
  assert.equal(res.ok, false, "must refuse, not partially retire");
  assert.match((res as any).error, /Refusing to execute/);
  assert.equal(store.doc_items.find((r) => r.id === req)!.status, "draft", "blocked row untouched");
  assert.equal(store.doc_items.find((r) => r.id === sdes)!.status, "draft", "referencer untouched too — all-or-nothing");
});

test("project_retire dry_run=false clean project: retires every row, notifies subscribers, closes parked GTD, writes tombstone", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "board-mcp");
  const db = makeDb(store);
  const d = uuid();
  seedDoc(store, d);
  const a = seedItem(store, d, { code: "REQ-001" });
  const b = seedItem(store, d, { code: "REQ-002", owner: "atlas" });
  store["gov.doc_subscriptions"] = [
    { id: uuid(), subscriber_item_id: b, subscriber_project_id: PROJ_A, target_item_id: a, intent: "module", origin: "choice", status: "active", note: "n" },
  ];
  store.board_agents = [
    { agent_code: "005", slug: "board-mcp" },
    { agent_code: "010", slug: "atlas" },
  ];
  store.loomx_item_projects = [{ item_id: "gtd-parked", project_id: PROJ_A }, { item_id: "gtd-open", project_id: PROJ_A }];
  store.loomx_items = [
    { id: "gtd-parked", title: "Parked follow-up", gtd_status: "someday", owner: "board-mcp" },
    { id: "gtd-open", title: "Real open work", gtd_status: "next_action", owner: "board-mcp" },
  ];

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "superseded by another project", dry_run: false }, ctxFor(db, "board-mcp"));
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;

  assert.equal(res.data.retired.length, 2);
  assert.equal(store.doc_items.find((r) => r.id === a)!.status, "retired");
  assert.equal(store.doc_items.find((r) => r.id === b)!.status, "retired");

  assert.equal(res.data.notify_sent.length, 1);
  assert.equal(res.data.notify_sent[0].to_slug, "atlas");
  assert.equal(store.board_messages.length, 1);
  assert.equal(store.board_messages[0].to_agent, "010");
  assert.equal(store.board_messages[0].from_agent, "005");

  assert.equal(res.data.gtd_closed.length, 1);
  assert.equal(res.data.gtd_closed[0].id, "gtd-parked");
  assert.equal(store.loomx_items.find((r) => r.id === "gtd-parked")!.gtd_status, "done");

  assert.equal(res.data.gtd_needs_reassignment.length, 1);
  assert.equal(res.data.gtd_needs_reassignment[0].id, "gtd-open");
  assert.equal(store.loomx_items.find((r) => r.id === "gtd-open")!.gtd_status, "next_action", "real open work is never force-closed");

  // needs_reassignment is non-empty → tombstone withheld (SDES-DOCM-031 ordering).
  assert.equal(res.data.project_tombstone_written, false);
  assert.match(res.data.project_tombstone_note ?? "", /loomy's reassignment/);
  assert.equal(store.loomx_projects.find((r) => r.id === PROJ_A)!.retired_at, undefined);
});

test("project_retire dry_run=false: tombstone IS written when no GTD needs reassignment", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "board-mcp");
  const db = makeDb(store);
  const d = uuid();
  seedDoc(store, d);
  seedItem(store, d, { code: "REQ-001" });
  store.loomx_item_projects = [{ item_id: "gtd-parked", project_id: PROJ_A }];
  store.loomx_items = [{ id: "gtd-parked", title: "Parked", gtd_status: "waiting", owner: "board-mcp" }];

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "done, superseded", dry_run: false }, ctxFor(db, "board-mcp"));
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.data.gtd_needs_reassignment.length, 0);
  assert.equal(res.data.project_tombstone_written, true);
  const proj = store.loomx_projects.find((r) => r.id === PROJ_A)!;
  assert.equal(proj.retired_reason, "done, superseded");
  assert.ok(proj.retired_at);
});

test("project_retire: rows already terminal are excluded from the census and never re-touched", async () => {
  const store: Store = {};
  seedProjects(store);
  seedOwnedProject(store, "board-mcp");
  const db = makeDb(store);
  const d = uuid();
  seedDoc(store, d);
  seedItem(store, d, { code: "REQ-001", status: "archived" });
  const live = seedItem(store, d, { code: "REQ-002" });

  const res = await projectRetire(db, { project_id: PROJ_A, reason: "x", dry_run: true }, ctxFor(db, "board-mcp"));
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.data.rows_already_terminal, 1);
  assert.equal(res.data.rows_considered, 1);
  assert.equal(res.data.blocks.length, 0);
});

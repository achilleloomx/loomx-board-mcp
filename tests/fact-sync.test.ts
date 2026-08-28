// Unit tests for src/factSync.ts (PJ-7/D-210 — the derivation of origin='fact'
// subscriptions from traceability links) and for the decay gate that doc_publish
// consumes (GTD 56a815b4, evaluateDecayGate in staleness.ts).
//
// Run with: npx tsx --test tests/fact-sync.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { docFactSync, FACT_INTENT_BY_RELATION, MAX_FACT_SYNC_LINKS } from "../src/factSync.ts";
import { evaluateDecayGate } from "../src/staleness.ts";
import { makeDb, uuid, ctx, PROJ_A, PROJ_B, seedProjects, type Store, type Row } from "./fakeDb.ts";

function seedDoc(store: Store, id: string, project_id: string, version = "1.0"): void {
  store.documents ??= [];
  store.documents.push({ id, project_id, version, document_type: "sdes", title: "D", visibility: "project" });
}

function seedItem(store: Store, id: string, project_id: string, document_id: string, opts: Partial<Row> = {}): Row {
  store.doc_items ??= [];
  const row: Row = {
    id, project_id, document_id, owner: "board-mcp", code: null, status: "active",
    item_type: "uat_case", body: "x", attrs: {}, ...opts,
  };
  store.doc_items.push(row);
  return row;
}

function seedLink(store: Store, from_item: string, to_item: string, relation_type: string, project_id: string): void {
  store.doc_item_links ??= [];
  store.doc_item_links.push({ id: uuid(), from_item, to_item, relation_type, project_id, created_at: "2026-08-01T00:00:00.000Z" });
}

function seedParam(store: Store, key: string, opts: Partial<Row>): void {
  store.loomx_governance_params ??= [];
  store.loomx_governance_params.push({ param_key: key, value_numeric: null, value_json: null, deprecated_at: null, owner_agent_code: "005", ...opts });
}

// A project with one uat_case verifying one sdes_entry, and one sdes_entry
// satisfying one requirement — the two shapes that actually dominate the corpus
// (measured: 385 uat→sdes 'verifies', 326 sdes→req 'satisfies').
function seedTraceableProject(store: Store): { uat: string; sdes: string; req: string; docId: string } {
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  const uat = uuid(), sdes = uuid(), req = uuid();
  seedItem(store, uat, PROJ_A, docId, { code: "UAT-001", item_type: "uat_case" });
  seedItem(store, sdes, PROJ_A, docId, { code: "SDES-001", item_type: "sdes_entry" });
  seedItem(store, req, PROJ_A, docId, { code: "REQ-001", item_type: "requirement" });
  seedLink(store, uat, sdes, "verifies", PROJ_A);
  seedLink(store, sdes, req, "satisfies", PROJ_A);
  return { uat, sdes, req, docId };
}

test("doc_fact_sync: derives one fact subscription per traceability link, grade from the relation", async () => {
  const store: Store = {};
  seedProjects(store);
  const { uat, sdes, req } = seedTraceableProject(store);
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.counts.created, 2);
  assert.equal(res.data.counts.links_examined, 2);

  const rows = store["gov.doc_subscriptions"] ?? [];
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.origin, "fact");

  const verifies = rows.find((r) => r.subscriber_item_id === uat)!;
  assert.equal(verifies.target_item_id, sdes);
  // verifies → critical: the test falls when its subject moves.
  assert.equal(verifies.intent, FACT_INTENT_BY_RELATION.verifies);
  assert.equal(verifies.intent, "critical");

  const satisfies = rows.find((r) => r.subscriber_item_id === sdes)!;
  assert.equal(satisfies.target_item_id, req);
  // satisfies → module: needs review, does not fall.
  assert.equal(satisfies.intent, FACT_INTENT_BY_RELATION.satisfies);
  assert.equal(satisfies.intent, "module");

  // The note must say where the subscription came from — a fact nobody can
  // trace back to its link is indistinguishable from one invented by hand.
  assert.match(verifies.note, /verifies link UAT-001 → SDES-001/);
  assert.equal(verifies.subscribed_at_version, "1.0");
});

test("doc_fact_sync: dry_run writes nothing and previews the same rows", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A, dry_run: true }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.counts.created, 0);
  assert.equal(res.data.would_create?.length, 2);
  assert.equal((store["gov.doc_subscriptions"] ?? []).length, 0);
});

test("doc_fact_sync: idempotent — a second run creates nothing and reports coverage", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  const db = makeDb(store, new Set([PROJ_A]));

  const first = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(first.ok, true);
  const second = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.data.counts.created, 0);
  assert.equal(second.data.counts.already_covered, 2);
  assert.equal((store["gov.doc_subscriptions"] ?? []).length, 2);
});

test("doc_fact_sync: an existing hand-made 'choice' subscription counts as coverage, never duplicated", async () => {
  const store: Store = {};
  seedProjects(store);
  const { uat, sdes } = seedTraceableProject(store);
  store["gov.doc_subscriptions"] = [
    { id: uuid(), subscriber_item_id: uat, subscriber_project_id: PROJ_A, target_item_id: sdes, intent: "module", origin: "choice", status: "active", note: "by hand" },
  ];
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.counts.created, 1); // only the satisfies link
  assert.equal(res.data.counts.already_covered, 1);
  assert.equal(res.data.already_covered[0].origin, "choice");
});

test("doc_fact_sync: only verifies/satisfies are derivable — other relations are refused, not ignored", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A, relation_types: ["refines"] }, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /not derivable/i);
  assert.match(res.error, /refines/);
});

test("doc_fact_sync: 'relates_to' links in the project are never picked up", async () => {
  const store: Store = {};
  seedProjects(store);
  const { uat, req } = seedTraceableProject(store);
  seedLink(store, uat, req, "relates_to", PROJ_A);
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.counts.links_examined, 2); // the relates_to link is not even examined
  assert.equal(res.data.counts.created, 2);
});

test("doc_fact_sync: admission suspension refuses the sweep and creates nothing", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  seedParam(store, "sottoscrizioni_ammissione_sospesa", { value_numeric: 1 });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /SUSPENDED/);
  assert.equal((store["gov.doc_subscriptions"] ?? []).length, 0);
});

test("doc_fact_sync: suspension does NOT block dry_run — you can still see what is pending", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  seedParam(store, "sottoscrizioni_ammissione_sospesa", { value_numeric: 1 });
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A, dry_run: true }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.would_create?.length, 2);
});

test("doc_fact_sync: an unreadable suspension flag admits but declares itself", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  // no parameter row at all
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.counts.created, 2);
  assert.match(res.data.admission_gate ?? "", /NOT VERIFIED/);
});

test("doc_fact_sync: refuses when the project has more links than the ceiling — never a partial sweep", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  const target = uuid();
  seedItem(store, target, PROJ_A, docId, { code: "SDES-X", item_type: "sdes_entry" });
  for (let i = 0; i < 4; i++) {
    const s = uuid();
    seedItem(store, s, PROJ_A, docId, { code: `UAT-${i}`, item_type: "uat_case" });
    seedLink(store, s, target, "verifies", PROJ_A);
  }
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A, limit: 3 }, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /REFUSED rather than\s+truncated|REFUSED/);
  assert.equal((store["gov.doc_subscriptions"] ?? []).length, 0);
});

test("doc_fact_sync: a non-member is refused before any write", async () => {
  const store: Store = {};
  seedProjects(store);
  seedTraceableProject(store);
  const db = makeDb(store, new Set([PROJ_B])); // member of another project only

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /Not legitimated/);
});

test("doc_fact_sync: reports fact subscriptions whose link is gone — they cannot be removed from here", async () => {
  const store: Store = {};
  seedProjects(store);
  const { uat, sdes, req } = seedTraceableProject(store);
  // A fact whose link never existed (or was deleted): same shape, no backing link.
  store["gov.doc_subscriptions"] = [
    { id: "orphan-1", subscriber_item_id: uat, subscriber_project_id: PROJ_A, target_item_id: req, intent: "critical", origin: "fact", status: "active", note: "stale fact" },
  ];
  const db = makeDb(store, new Set([PROJ_A]));

  const res = await docFactSync(db, { project_id: PROJ_A }, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const orphans = res.data.orphan_facts ?? [];
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].subscription_id, "orphan-1");
  assert.match(orphans[0].note, /cannot be tombstoned/);
  assert.ok(sdes); // the live link is unaffected
});

// ---------------------------------------------------------------------------
// evaluateDecayGate — the rule doc_publish enforces (GTD 56a815b4)
// ---------------------------------------------------------------------------

function seedDecayedUat(store: Store, docId: string, n: number, since: string): void {
  for (let i = 0; i < n; i++) {
    seedItem(store, uuid(), PROJ_A, docId, {
      code: `UAT-D${i}`,
      item_type: "uat_case",
      attrs: { pass_fail: "pass", decay_status: "decayed", decay_since: since },
    });
  }
}

test("decay gate: under threshold does not block, but the count is reported", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  seedParam(store, "pg_rilancio_soglia_decaduti", { value_numeric: 3 });
  seedParam(store, "pg_rilancio_giorni_max", { value_numeric: 30 });
  seedDecayedUat(store, docId, 2, new Date().toISOString());
  const db = makeDb(store, new Set([PROJ_A]));

  const v = await evaluateDecayGate(db, PROJ_A);
  assert.equal(v.decayed_count, 2);
  assert.equal(v.blocking, false);
});

test("decay gate: at the threshold it blocks — 'at or over', not 'over'", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  seedParam(store, "pg_rilancio_soglia_decaduti", { value_numeric: 3 });
  seedParam(store, "pg_rilancio_giorni_max", { value_numeric: 30 });
  seedDecayedUat(store, docId, 3, new Date().toISOString());
  const db = makeDb(store, new Set([PROJ_A]));

  const v = await evaluateDecayGate(db, PROJ_A);
  assert.equal(v.blocking, true);
  assert.match(v.reasons.join(" "), /threshold/);
});

test("decay gate: one decay older than max_days blocks on its own, below threshold", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  seedParam(store, "pg_rilancio_soglia_decaduti", { value_numeric: 3 });
  seedParam(store, "pg_rilancio_giorni_max", { value_numeric: 30 });
  const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
  seedDecayedUat(store, docId, 1, old);
  const db = makeDb(store, new Set([PROJ_A]));

  const v = await evaluateDecayGate(db, PROJ_A);
  assert.equal(v.decayed_count, 1);
  assert.equal(v.blocking, true);
  assert.match(v.reasons.join(" "), /days old/);
});

test("decay gate: missing thresholds never block, they are declared", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  seedDecayedUat(store, docId, 5, new Date().toISOString()); // way over any plausible threshold
  const db = makeDb(store, new Set([PROJ_A]));

  const v = await evaluateDecayGate(db, PROJ_A);
  assert.equal(v.decayed_count, 5);
  assert.equal(v.blocking, false);
  assert.ok(v.params_missing.includes("pg_rilancio_soglia_decaduti"));
});

test("decay gate: a project with no decayed rows is clean and says nothing", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  seedDoc(store, docId, PROJ_A);
  seedParam(store, "pg_rilancio_soglia_decaduti", { value_numeric: 3 });
  seedParam(store, "pg_rilancio_giorni_max", { value_numeric: 30 });
  seedItem(store, uuid(), PROJ_A, docId, { code: "UAT-OK", item_type: "uat_case", attrs: { pass_fail: "pass" } });
  const db = makeDb(store, new Set([PROJ_A]));

  const v = await evaluateDecayGate(db, PROJ_A);
  assert.equal(v.decayed_count, 0);
  assert.equal(v.blocking, false);
  assert.equal(v.reasons.length, 0);
});

test("ceiling constant is exported and sane", () => {
  assert.ok(MAX_FACT_SYNC_LINKS >= 100);
});

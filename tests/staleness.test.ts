// Unit tests for src/staleness.ts (DEL-008/M2 exposure + D-201 decay ring,
// GTD 1dffa01e/ddb6815c/03ffb9f5). Reuses the fake DB harness from
// tests/fakeDb.ts — the same generic table-store-by-name shim used for
// subscriptions.ts, no special-casing needed for gov.* schema-qualified names.
//
// Run with: npx tsx --test tests/staleness.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { docStalenessQuery, docStalenessClose, docDecayApply } from "../src/staleness.ts";
import { makeDb, uuid, ctx, PROJ_A, seedProjects, type Store, type Row } from "./fakeDb.ts";

function seedDocument(store: Store, id: string, project_id: string): void {
  store.documents ??= [];
  store.documents.push({ id, project_id, version: "1.0", document_type: "req", title: "Doc", visibility: "project" });
}

function seedDocItem(store: Store, id: string, project_id: string, document_id: string, opts: Partial<Row> = {}): Row {
  store.doc_items ??= [];
  const row: Row = {
    id, project_id, document_id, owner: "board-mcp", code: null, status: "draft",
    item_type: "requirement", body: "x", attrs: {}, ...opts,
  };
  store.doc_items.push(row);
  return row;
}

function seedSubscription(store: Store, id: string, opts: Partial<Row>): Row {
  store["gov.doc_subscriptions"] ??= [];
  const row: Row = { id, status: "active", intent: "module", ...opts };
  store["gov.doc_subscriptions"].push(row);
  return row;
}

function seedMarking(store: Store, id: string, opts: Partial<Row>): Row {
  store["gov.doc_subscription_staleness"] ??= [];
  const row: Row = {
    id, op: "UPDATE", changed_columns: ["body"], changed_at: "2026-08-24T12:00:00.000Z",
    detection_source: "trigger", changed_by: "loomy", status: "open",
    closed_outcome: null, closed_note: null, closed_at: null, closed_by: null,
    detected_at: "2026-08-24T12:00:00.000Z", ...opts,
  };
  store["gov.doc_subscription_staleness"].push(row);
  return row;
}

function seedParam(store: Store, key: string, opts: Partial<Row>): void {
  store.loomx_governance_params ??= [];
  store.loomx_governance_params.push({ param_key: key, value_numeric: null, value_json: null, deprecated_at: null, ...opts });
}

function seedThresholdParams(store: Store): void {
  seedParam(store, "pg_rilancio_soglia_decaduti", { value_numeric: 3 });
  seedParam(store, "pg_rilancio_giorni_max", { value_numeric: 30 });
  seedParam(store, "pg_rilancio_classi_esenti", { value_json: { classi: ["deterministico"] } });
}

// ---------------------------------------------------------------------------
// doc_staleness_query
// ---------------------------------------------------------------------------

test("doc_staleness_query: returns open markings scoped to the project, with codes resolved", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const sdesId = uuid();
  seedDocItem(store, sdesId, PROJ_A, docId, { item_type: "sdes_entry", code: "SDES-001" });
  const uatId = uuid();
  seedDocItem(store, uatId, PROJ_A, docId, { item_type: "uat_case", code: "UAT-001" });
  const subId = uuid();
  seedSubscription(store, subId, { subscriber_item_id: uatId, subscriber_project_id: PROJ_A, intent: "critical", target_item_id: sdesId });
  const markId = uuid();
  seedMarking(store, markId, { subscription_id: subId, target_item_id: sdesId });
  seedThresholdParams(store);

  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const data = (res as any).data;
  assert.equal(data.markings.length, 1);
  assert.equal(data.markings[0].subscriber_item_code, "UAT-001");
  assert.equal(data.markings[0].target_item_code, "SDES-001");
  assert.equal(data.markings[0].intent, "critical");
  assert.equal(data.decay.threshold, 3);
  assert.equal(data.decay.max_days, 30);
  assert.deepEqual(data.decay.exempt_classes, ["deterministico"]);
  assert.equal(data.decay.decayed_count, 0);
});

test("doc_staleness_query: a marking whose subscriber lives in a DIFFERENT project is excluded", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const otherProj = uuid();
  const uatId = uuid();
  seedDocItem(store, uatId, otherProj, docId, { item_type: "uat_case", code: "UAT-999" });
  const subId = uuid();
  seedSubscription(store, subId, { subscriber_item_id: uatId, subscriber_project_id: otherProj, intent: "module", target_item_id: uuid() });
  seedMarking(store, uuid(), { subscription_id: subId });

  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.markings.length, 0);
});

test("doc_staleness_query: missing governance params are reported, never silently defaulted", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  // no seedThresholdParams() — the registry has nothing for this key set
  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  const data = (res as any).data;
  assert.equal(data.decay.threshold, null);
  assert.deepEqual(
    data.decay.params_missing?.sort(),
    ["pg_rilancio_classi_esenti", "pg_rilancio_giorni_max", "pg_rilancio_soglia_decaduti"]
  );
});

test("doc_staleness_query: surfaces gov.doc_frozen_row_touches for the project's documents", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const itemId = uuid();
  seedDocItem(store, itemId, PROJ_A, docId, { code: "REQ-500" });
  store["gov.doc_frozen_row_touches"] = [{
    id: uuid(), doc_item_id: itemId, document_id: docId, op: "UPDATE",
    changed_columns: ["body"], changed_at: "2026-08-24T09:00:00.000Z",
  }];

  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  const rows = (res as any).data.frozen_row_touches;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doc_item_code, "REQ-500");
});

// ---------------------------------------------------------------------------
// doc_staleness_close
// ---------------------------------------------------------------------------

test("doc_staleness_close: closes an open marking with the given outcome", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const id = uuid();
  seedMarking(store, id, { subscription_id: uuid() });

  const res = await docStalenessClose(db, { staleness_id: id, closed_outcome: "updated" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal((res as any).data.status, "closed");
  assert.equal(store["gov.doc_subscription_staleness"][0].status, "closed");
});

test("doc_staleness_close: 'no_impact' requires a note", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const id = uuid();
  seedMarking(store, id, { subscription_id: uuid() });

  const res = await docStalenessClose(db, { staleness_id: id, closed_outcome: "no_impact" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /closed_note is required/i);
});

test("doc_staleness_close: re-closing an already-closed marking is a no-op", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const id = uuid();
  seedMarking(store, id, { subscription_id: uuid(), status: "closed", closed_outcome: "updated" });

  const res = await docStalenessClose(db, { staleness_id: id, closed_outcome: "feedback_sent", closed_note: "n" }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.already_closed, true);
  assert.equal((res as any).data.closed_outcome, "updated"); // untouched — no reopen attempted
});

test("doc_staleness_close: unknown staleness_id is an explicit error", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const res = await docStalenessClose(db, { staleness_id: uuid(), closed_outcome: "updated" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not readable/i);
});

// ---------------------------------------------------------------------------
// doc_decay_apply
// ---------------------------------------------------------------------------

function seedDecayScenario(store: Store, intent = "critical") {
  seedProjects(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const sdesId = uuid();
  seedDocItem(store, sdesId, PROJ_A, docId, { item_type: "sdes_entry", code: "SDES-010" });
  const uatId = uuid();
  seedDocItem(store, uatId, PROJ_A, docId, {
    item_type: "uat_case", code: "UAT-010", status: "done",
    attrs: { pass_fail: "pass" },
  });
  const subId = uuid();
  seedSubscription(store, subId, { subscriber_item_id: uatId, subscriber_project_id: PROJ_A, intent, target_item_id: sdesId });
  const markId = uuid();
  seedMarking(store, markId, { subscription_id: subId, target_item_id: sdesId, changed_at: "2026-08-24T21:00:00.000Z" });
  return { uatId, sdesId, subId, markId };
}

test("doc_decay_apply: flips a critical-intent uat_case subscriber to decayed, preserving pass_fail", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const { uatId } = seedDecayScenario(store, "critical");
  seedThresholdParams(store);

  const res = await docDecayApply(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const data = (res as any).data;
  assert.equal(data.applied.length, 1);
  assert.equal(data.applied[0].code, "UAT-010");
  assert.equal(data.applied[0].decay_cause_item, "SDES-010");

  const row = store.doc_items.find((r: Row) => r.id === uatId)!;
  assert.equal(row.attrs.decay_status, "decayed");
  assert.equal(row.attrs.pass_fail, "pass"); // NOT overwritten (attrs is a merge, not a replace)
  assert.equal(row.attrs.decay_cause_item, "SDES-010");

  // marking stays open — closing is a separate act
  assert.equal(store["gov.doc_subscription_staleness"][0].status, "open");
});

test("doc_decay_apply: 'informative' intent never decays anything", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const { uatId } = seedDecayScenario(store, "informative");

  const res = await docDecayApply(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  const data = (res as any).data;
  assert.equal(data.applied.length, 0);
  assert.equal(data.skipped_ineligible.length, 1);
  assert.match(data.skipped_ineligible[0].reason, /informative/);
  const row = store.doc_items.find((r: Row) => r.id === uatId)!;
  assert.equal(row.attrs.decay_status, undefined);
});

test("doc_decay_apply: a non-uat_case subscriber is skipped (vertical slice boundary)", async () => {
  const store: Store = {};
  const db = makeDb(store);
  seedProjects(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const sdesId = uuid();
  seedDocItem(store, sdesId, PROJ_A, docId, { item_type: "sdes_entry", code: "SDES-020" });
  const guiId = uuid();
  seedDocItem(store, guiId, PROJ_A, docId, { item_type: "sdes_entry", code: "GUI-020" });
  const subId = uuid();
  seedSubscription(store, subId, { subscriber_item_id: guiId, subscriber_project_id: PROJ_A, intent: "module", target_item_id: sdesId });
  seedMarking(store, uuid(), { subscription_id: subId, target_item_id: sdesId });

  const res = await docDecayApply(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.applied.length, 0);
  assert.match((res as any).data.skipped_ineligible[0].reason, /uat_case/);
});

test("doc_decay_apply: idempotent — an already-decayed row is reported, not rewritten", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const { uatId } = seedDecayScenario(store, "critical");
  const row = store.doc_items.find((r: Row) => r.id === uatId)!;
  row.attrs = { pass_fail: "pass", decay_status: "decayed", decay_since: "2026-08-01T00:00:00.000Z", decay_cause_item: "SDES-OLD" };

  const res = await docDecayApply(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  const data = (res as any).data;
  assert.equal(data.applied.length, 0);
  assert.equal(data.already_decayed.length, 1);
  assert.equal(row.attrs.decay_cause_item, "SDES-OLD"); // untouched, not re-stamped
});

test("doc_decay_apply: dry_run previews without writing", async () => {
  const store: Store = {};
  const db = makeDb(store);
  const { uatId } = seedDecayScenario(store, "module");

  const res = await docDecayApply(db, { project_id: PROJ_A, dry_run: true }, ctx);
  assert.ok(res.ok);
  const data = (res as any).data;
  assert.equal(data.applied.length, 0);
  assert.equal(data.would_apply?.length, 1);
  const row = store.doc_items.find((r: Row) => r.id === uatId)!;
  assert.equal(row.attrs.decay_status, undefined);
});

test("doc_decay_apply: verdict.forced_rerun flips true once decayed_count reaches the threshold", async () => {
  const store: Store = {};
  const db = makeDb(store);
  seedProjects(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  seedThresholdParams(store); // threshold = 3

  for (let i = 0; i < 3; i++) {
    const sdesId = uuid();
    seedDocItem(store, sdesId, PROJ_A, docId, { item_type: "sdes_entry", code: `SDES-3${i}` });
    const uatId = uuid();
    seedDocItem(store, uatId, PROJ_A, docId, { item_type: "uat_case", code: `UAT-3${i}`, attrs: { pass_fail: "pass" } });
    const subId = uuid();
    seedSubscription(store, subId, { subscriber_item_id: uatId, subscriber_project_id: PROJ_A, intent: "critical", target_item_id: sdesId });
    seedMarking(store, uuid(), { subscription_id: subId, target_item_id: sdesId });
  }

  const res = await docDecayApply(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok);
  const data = (res as any).data;
  assert.equal(data.applied.length, 3);
  assert.equal(data.verdict.decayed_count, 3);
  assert.equal(data.verdict.forced_rerun, true);
  assert.match(data.verdict.class_gate_note, /not applied/i);
});

// ---------------------------------------------------------------------------
// doc_staleness_query: the repoint triple (UAT-GOV-029). Without
// target_current_version_id nothing could call doc_repoint — no other surface
// exposes a gov.doc_versions.id, and that signature refuses a label on purpose.
// ---------------------------------------------------------------------------

function seedRepointTripleScenario(store: Store, opts: { pin: string; versions: Array<[string, string, number]> }): string {
  seedProjects(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  seedDocItem(store, "sub-item", PROJ_A, docId, { item_type: "uat_case", code: "UAT-X-001" });
  seedDocItem(store, "tgt-item", PROJ_A, docId, { item_type: "sdes_entry", code: "SDES-X-001" });
  const subId = uuid();
  seedSubscription(store, subId, {
    subscriber_item_id: "sub-item", subscriber_project_id: PROJ_A,
    target_item_id: "tgt-item", subscribed_at_version: opts.pin,
  });
  seedMarking(store, uuid(), { subscription_id: subId, target_item_id: "tgt-item" });
  store["gov.doc_versions"] ??= [];
  for (const [id, label, seq] of opts.versions) {
    store["gov.doc_versions"].push({ id, document_id: docId, version_label: label, version_seq: seq });
  }
  return subId;
}

test("doc_staleness_query: reports the version UUID needed to call doc_repoint", async () => {
  const store: Store = {};
  const v2 = uuid();
  seedRepointTripleScenario(store, { pin: "1.0", versions: [[uuid(), "1.0", 1], [v2, "2.0", 2]] });
  const db = makeDb(store);

  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const m = (res as any).data.markings[0];
  assert.equal(m.subscribed_at_version, "1.0");
  assert.equal(m.target_current_version, "2.0");
  assert.equal(m.target_current_version_id, v2);
  assert.equal(m.repoint_applicable, true);
});

test("doc_staleness_query: an unpublished target reports repoint as not applicable, with the reason", async () => {
  const store: Store = {};
  seedRepointTripleScenario(store, { pin: "1.0", versions: [] });
  const db = makeDb(store);

  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const m = (res as any).data.markings[0];
  assert.equal(m.target_current_version_id, null);
  assert.equal(m.repoint_applicable, false);
  // The measured-common case (93% of live subscriptions): it must read as a
  // normal state with a stated reason, never as a bare false.
  assert.match(m.repoint_note, /no published version/);
  assert.match(m.repoint_note, /doc_staleness_close/);
});

test("doc_staleness_query: a pin already on the current version is not repointable", async () => {
  const store: Store = {};
  const v1 = uuid();
  seedRepointTripleScenario(store, { pin: "1.0", versions: [[v1, "1.0", 1]] });
  const db = makeDb(store);

  const res = await docStalenessQuery(db, { project_id: PROJ_A }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const m = (res as any).data.markings[0];
  assert.equal(m.repoint_applicable, false);
  assert.match(m.repoint_note, /Already pinned/);
});

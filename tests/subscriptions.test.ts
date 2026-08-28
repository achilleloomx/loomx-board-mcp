// Unit tests for src/subscriptions.ts (DEL-002, D-186 ratified design).
// Reuses the fake DB harness from tests/docs.test.ts (same query-builder shim
// keyed by table name — "gov.doc_subscriptions" is just a string key, no
// special-casing needed for the schema-qualified table names).
//
// Run with: npx tsx --test tests/subscriptions.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  docSubscribe, docUnsubscribe, docSubscriptionOutcome, docPublish, docRepoint, docVersionDelta,
  HUB_PROJECT_ID, HUB_UNSUBSCRIBABLE_DOCUMENT_TYPE,
} from "../src/subscriptions.ts";
import { makeDb, uuid, ctx, PROJ_A, PROJ_B, seedProjects, type Store, type Row } from "./fakeDb.ts";

function seedDocument(store: Store, id: string, project_id: string, version = "1.0", document_type = "req"): void {
  store.documents ??= [];
  store.documents.push({ id, project_id, version, document_type, title: "Doc", visibility: "project" });
}

function seedDocItem(store: Store, id: string, project_id: string, document_id: string, owner: string): Row {
  store.doc_items ??= [];
  const row = { id, project_id, document_id, owner, code: null, status: "draft", item_type: "requirement", body: "x", attrs: {} };
  store.doc_items.push(row);
  return row;
}

function seedPublication(store: Store, id: string, document_id: string, version_label: string, published_at: string): void {
  store["gov.doc_versions"] ??= [];
  store["gov.doc_versions"].push({ id, document_id, version_label, published_at });
}

// ---------------------------------------------------------------------------
// doc_subscribe
// ---------------------------------------------------------------------------

test("doc_subscribe: creates a row-level subscription owned by the caller", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.3");
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_A, docId, "dba");

  const res = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks the schema",
  }, ctx);
  assert.ok(res.ok, `subscribe ok: ${JSON.stringify(res)}`);
  assert.equal((res as any).data.created, true);
  assert.equal((res as any).data.subscribed_at_version, "1.3");
  assert.equal((res as any).data.target_kind, "item");
  assert.equal(store["gov.doc_subscriptions"].length, 1);
  assert.equal(store["gov.doc_subscriptions"][0].origin, "choice");
});

test("doc_subscribe: re-call with the same intent is a no-op (created:false)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_A, docId, "dba");

  await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "informative", note: "n1" }, ctx);
  const res2 = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "informative", note: "n2" }, ctx);
  assert.ok(res2.ok);
  assert.equal((res2 as any).data.created, false);
  assert.equal(store["gov.doc_subscriptions"].length, 1);
});

test("doc_subscribe: re-call with a DIFFERENT intent changes the grade in place", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_A, docId, "dba");

  await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "informative", note: "n1" }, ctx);
  const res2 = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "n2" }, ctx);
  assert.ok(res2.ok, JSON.stringify(res2));
  assert.equal((res2 as any).data.created, false);
  assert.deepEqual((res2 as any).data.intent_changed, { from: "informative", to: "module" });
  assert.equal(store["gov.doc_subscriptions"].length, 1);
  assert.equal(store["gov.doc_subscriptions"][0].intent, "module");
});

test("doc_subscribe: 'critical' across two different projects is refused in v1 (D-186 Q2)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docA = uuid(), docB = uuid();
  seedDocument(store, docA, PROJ_A);
  seedDocument(store, docB, PROJ_B);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docA, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_B, docB, "dba");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "critical", note: "n" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /refused in v1|D-186/i);
});

test("doc_subscribe: non-owner, non-member of the subscriber's project is rejected", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store); // no members set — board-mcp is not a member of anything
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "someone-else");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_A, docId, "dba");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "informative", note: "n" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /Not legitimated/);
});

test("doc_subscribe: project MEMBER (not owner) of the subscriber's project is legitimated", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store, new Set([PROJ_A]));
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "someone-else");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_A, docId, "dba");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "informative", note: "n" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
});

test("doc_subscribe: cannot subscribe an item to itself", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: subId, intent: "informative", note: "n" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /itself/);
});

test("doc_subscribe: requires exactly one of target_item_id / target_document_id", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A);
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");

  const res = await docSubscribe(db, { subscriber_item_id: subId, intent: "informative", note: "n" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /Exactly one/);
});

test("doc_subscribe: document-level watch (target_document_id) works", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "2.0");
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");
  const otherDocId = uuid();
  seedDocument(store, otherDocId, PROJ_A, "3.0");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_document_id: otherDocId, intent: "informative", note: "n" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal((res as any).data.target_kind, "document");
  assert.equal((res as any).data.subscribed_at_version, "3.0");
});

// ---------------------------------------------------------------------------
// REQ-SUB-012 / SDES-SUB-012 — hub cross-decisions are never subscribable
// (declared interim approximation for "core/ambient", loomy correction msg
// 4162dfb7, 2026-08-27). Every intent is rejected, not just 'critical'.
// ---------------------------------------------------------------------------

test("doc_subscribe: rejects a row in a hub cross-project decisions document, any intent", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const hubDocId = uuid();
  seedDocument(store, hubDocId, HUB_PROJECT_ID, "1.0", HUB_UNSUBSCRIBABLE_DOCUMENT_TYPE);
  const subId = uuid();
  const localDocId = uuid();
  seedDocument(store, localDocId, PROJ_A);
  seedDocItem(store, subId, PROJ_A, localDocId, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, HUB_PROJECT_ID, hubDocId, "loomy");

  for (const intent of ["informative", "module", "critical"] as const) {
    const res = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent, note: "n" }, ctx);
    assert.equal(res.ok, false, `intent=${intent} should be rejected`);
    assert.match((res as any).error, /REQ-SUB-012|not subscribable/i);
    assert.equal((store["gov.doc_subscriptions"] ?? []).length, 0);
  }
});

test("doc_subscribe: rejects a document-level watch on a hub cross-project decisions document", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const hubDocId = uuid();
  seedDocument(store, hubDocId, HUB_PROJECT_ID, "1.0", HUB_UNSUBSCRIBABLE_DOCUMENT_TYPE);
  const subId = uuid();
  const localDocId = uuid();
  seedDocument(store, localDocId, PROJ_A);
  seedDocItem(store, subId, PROJ_A, localDocId, "board-mcp");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_document_id: hubDocId, intent: "informative", note: "n" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /REQ-SUB-012|not subscribable/i);
});

test("doc_subscribe: a hub-project document that is NOT document_type='decisions' stays subscribable (e.g. a future domain manifest)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const manifestDocId = uuid();
  seedDocument(store, manifestDocId, HUB_PROJECT_ID, "1.0", "config_pattern");
  const subId = uuid();
  const localDocId = uuid();
  seedDocument(store, localDocId, PROJ_A);
  seedDocItem(store, subId, PROJ_A, localDocId, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, HUB_PROJECT_ID, manifestDocId, "loomy");

  const res = await docSubscribe(db, { subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "n" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
});

// ---------------------------------------------------------------------------
// doc_unsubscribe
// ---------------------------------------------------------------------------

function seedSubscription(store: Store, overrides: Partial<Row> = {}): string {
  store["gov.doc_subscriptions"] ??= [];
  const id = uuid();
  store["gov.doc_subscriptions"].push({
    id, subscriber_item_id: uuid(), status: "active", origin: "choice", note: "why", ...overrides,
  });
  return id;
}

test("doc_unsubscribe: tombstones an active choice-origin subscription, appends reason to note", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-owned", note: "original note" });
  const db = makeDb(store);

  const res = await docUnsubscribe(db, { subscription_id: subId, reason: "topic resolved" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal((res as any).data.status, "tombstoned");
  const row = store["gov.doc_subscriptions"].find((r: Row) => r.id === subId)!;
  assert.equal(row.status, "tombstoned");
  assert.match(row.note, /original note[\s\S]*\[unsubscribed: topic resolved\]/);
});

test("doc_unsubscribe: already-tombstoned is a no-op (already_tombstoned:true)", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-owned", status: "tombstoned" });
  const db = makeDb(store);

  const res = await docUnsubscribe(db, { subscription_id: subId }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.already_tombstoned, true);
});

test("doc_unsubscribe: origin='fact' is refused (SEC-011 — exit only from a choice)", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-owned", origin: "fact" });
  const db = makeDb(store);

  const res = await docUnsubscribe(db, { subscription_id: subId }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /structural fact|SEC-011/i);
});

test("doc_unsubscribe: non-owner (and not loomy) is rejected", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-other", PROJ_A, docId, "someone-else");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-other" });
  const db = makeDb(store);

  const res = await docUnsubscribe(db, { subscription_id: subId }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /Not legitimated/);
});

// ---------------------------------------------------------------------------
// doc_subscription_outcome
// ---------------------------------------------------------------------------

test("doc_subscription_outcome: rejected when the version was never published", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const targetId = "target-item";
  seedDocItem(store, targetId, PROJ_A, docId, "dba");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-owned", target_item_id: targetId, target_document_id: null });
  const db = makeDb(store);

  const res = await docSubscriptionOutcome(db, { subscription_id: subId, version: "9.9", outcome: "no_impact", note: "n" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /never been published/);
});

test("doc_subscription_outcome: no_impact requires a note", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const targetId = "target-item";
  seedDocItem(store, targetId, PROJ_A, docId, "dba");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-owned", target_item_id: targetId, target_document_id: null });
  seedPublication(store, "pub-1", docId, "1.1", "2026-08-20T00:00:00.000Z");
  const db = makeDb(store);

  const res = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.1", outcome: "no_impact" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /note is required/);
});

test("doc_subscription_outcome: creates an outcome; idempotent retry is a no-op; a different payload is refused", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const targetId = "target-item";
  seedDocItem(store, targetId, PROJ_A, docId, "dba");
  const subId = seedSubscription(store, { subscriber_item_id: "subitem-owned", target_item_id: targetId, target_document_id: null });
  seedPublication(store, "pub-1", docId, "1.1", "2026-08-20T00:00:00.000Z");
  const db = makeDb(store);

  const res1 = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.1", outcome: "no_impact", note: "reviewed" }, ctx);
  assert.ok(res1.ok, JSON.stringify(res1));
  assert.equal((res1 as any).data.created, true);
  assert.equal(store["gov.doc_subscription_outcomes"].length, 1);

  // Identical retry → the DB's UNIQUE(subscription_id, publication_id) fires,
  // and the tool recognises the payload matches → no-op declared, not an error.
  const res2 = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.1", outcome: "no_impact", note: "reviewed" }, ctx);
  assert.ok(res2.ok, JSON.stringify(res2));
  assert.equal((res2 as any).data.created, false);
  assert.equal(store["gov.doc_subscription_outcomes"].length, 1);

  // Same (subscription, version) but a DIFFERENT payload → refused, the ledger
  // never silently corrects an existing outcome.
  const res3 = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(res3.ok, false);
  assert.match((res3 as any).error, /DIFFERS from this call/);
  assert.equal(store["gov.doc_subscription_outcomes"].length, 1);
});

test("doc_subscription_outcome: outcome after tombstone-with-later-version is rejected, before is allowed", async () => {
  const store: Store = {};
  const docId = uuid();
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  const targetId = "target-item";
  seedDocItem(store, targetId, PROJ_A, docId, "dba");
  const subId = seedSubscription(store, {
    subscriber_item_id: "subitem-owned", target_item_id: targetId, target_document_id: null,
    status: "tombstoned", tombstoned_at: "2026-08-15T00:00:00.000Z",
  });
  seedPublication(store, "pub-before", docId, "1.0", "2026-08-10T00:00:00.000Z");
  seedPublication(store, "pub-after", docId, "2.0", "2026-08-20T00:00:00.000Z");
  const db = makeDb(store);

  const before = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.0", outcome: "updated" }, ctx);
  assert.ok(before.ok, JSON.stringify(before));

  const after = await docSubscriptionOutcome(db, { subscription_id: subId, version: "2.0", outcome: "updated" }, ctx);
  assert.equal(after.ok, false);
  assert.match((after as any).error, /tombstoned .* before version/);
});

// ---------------------------------------------------------------------------
// doc_publish
// ---------------------------------------------------------------------------

function seedChangelogDoc(store: Store, id: string, project_id: string): void {
  store.documents ??= [];
  store.documents.push({ id, project_id, version: "1.0", document_type: "changelog", title: "Changelog", visibility: "project" });
}

function seedChangelogEntry(store: Store, id: string, project_id: string, changelogDocId: string, version: string): Row {
  store.doc_items ??= [];
  const row = {
    id, project_id, document_id: changelogDocId, owner: "board-mcp", code: null,
    status: "draft", item_type: "changelog_entry", body: "x", attrs: { version },
  };
  store.doc_items.push(row);
  return row;
}

test("doc_publish: publishes a document, bumps version, appends the ledger row", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  const changelogDocId = uuid();
  seedChangelogDoc(store, changelogDocId, PROJ_A);
  const entryId = uuid();
  seedChangelogEntry(store, entryId, PROJ_A, changelogDocId, "1.1");
  // document owned by the caller (default ctx.selfSlug = "board-mcp")
  store.documents.find((r: Row) => r.id === docId)!.owner = "board-mcp";

  const res = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: entryId, delta_summary: "adds the 4th subscription tool",
  }, ctx);
  assert.ok(res.ok, `publish ok: ${JSON.stringify(res)}`);
  assert.equal((res as any).data.version_label, "1.1");
  assert.equal((res as any).data.version_seq, 1);
  assert.equal((res as any).data.bump_class, "minor");
  assert.equal(store.documents.find((r: Row) => r.id === docId)!.version, "1.1");
  assert.equal(store["gov.doc_versions"].length, 1);
  assert.equal(store["gov.doc_versions"][0].changelog_item_id, entryId);
});

test("doc_publish: rejects invalid bump_class", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  store.documents.find((r: Row) => r.id === docId)!.owner = "board-mcp";

  const res = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "huge",
    changelog_entry_id: uuid(), delta_summary: "x",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /Invalid bump_class/);
});

test("doc_publish: rejects when changelog_entry_id attrs.version does not match new_version (changelog-by-construction)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  store.documents.find((r: Row) => r.id === docId)!.owner = "board-mcp";
  const changelogDocId = uuid();
  seedChangelogDoc(store, changelogDocId, PROJ_A);
  const entryId = uuid();
  seedChangelogEntry(store, entryId, PROJ_A, changelogDocId, "9.9");

  const res = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: entryId, delta_summary: "x",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /changelog-by-construction/);
});

test("doc_publish: rejects when changelog_entry_id is not item_type='changelog_entry'", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  store.documents.find((r: Row) => r.id === docId)!.owner = "board-mcp";
  const notEntryId = uuid();
  seedDocItem(store, notEntryId, PROJ_A, docId, "board-mcp"); // item_type='requirement' (seedDocItem default)

  const res = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: notEntryId, delta_summary: "x",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /expected 'changelog_entry'/);
});

test("doc_publish: non-owner (and not loomy) is rejected", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  store.documents.find((r: Row) => r.id === docId)!.owner = "someone-else";

  const res = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: uuid(), delta_summary: "x",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /Not legitimated/);
});

test("doc_publish: working_doc is never publishable (REQ-DOCM-018/SDES-DOCM-018) — rejected before legitimation or changelog checks", async () => {
  // UAT-DOCM-018 (WI 937a2f43, 2026-08-27) found this documented as "enforced
  // DB-floor" (src/docTypes.ts comment) with NO test exercising it — exactly
  // the "a divieto non testato è un commento" the SDES entry warns against.
  // Tool-floor guard added here as defense in depth; whatever gov.doc_publish()
  // enforces server-side is unverified from this suite (no DB access from here).
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  const doc = store.documents.find((r: Row) => r.id === docId)!;
  doc.document_type = "working_doc";
  doc.owner = "board-mcp"; // even the owner cannot publish it — the block is on the type, not on legitimation

  const res = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: uuid(), delta_summary: "x",
  }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /working_doc.*never publishable/);
  assert.equal(store.documents.find((r: Row) => r.id === docId)!.version, "1.0", "no version bump on a rejected publish");
  assert.equal((store["gov.doc_versions"] ?? []).length, 0, "no ledger row written");
});

test("doc_publish: republishing the same (document_id, new_version) is a REFUSAL, not a no-op", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  store.documents.find((r: Row) => r.id === docId)!.owner = "board-mcp";
  const changelogDocId = uuid();
  seedChangelogDoc(store, changelogDocId, PROJ_A);
  const entryId = uuid();
  seedChangelogEntry(store, entryId, PROJ_A, changelogDocId, "1.1");

  const res1 = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: entryId, delta_summary: "first",
  }, ctx);
  assert.ok(res1.ok, JSON.stringify(res1));

  const res2 = await docPublish(db, {
    document_id: docId, new_version: "1.1", bump_class: "minor",
    changelog_entry_id: entryId, delta_summary: "second, same version",
  }, ctx);
  assert.equal(res2.ok, false);
  assert.match((res2 as any).error, /REFUSAL, not a no-op/);
  assert.equal(store["gov.doc_versions"].length, 1);
});

// ---------------------------------------------------------------------------
// doc_repoint (UAT-GOV-029 / REQ-GOV-102) — the pin moves only through the
// guarded function, and every refusal stays a refusal.
// ---------------------------------------------------------------------------

function seedRepointFixture(
  store: Store,
  opts: { pin?: string; published?: Array<[string, string, number]> } = {}
): { subId: string; docId: string; targetItemId: string } {
  const docId = uuid();
  const targetItemId = "target-item";
  seedDocument(store, docId, PROJ_A);
  seedDocItem(store, "subitem-owned", PROJ_A, docId, "board-mcp");
  seedDocItem(store, targetItemId, PROJ_A, docId, "dba");
  const subId = seedSubscription(store, {
    subscriber_item_id: "subitem-owned",
    subscriber_project_id: PROJ_A,
    target_item_id: targetItemId,
    intent: "module",
    subscribed_at_version: opts.pin ?? "1.0",
  });
  store["gov.doc_versions"] ??= [];
  for (const [id, label, seq] of opts.published ?? []) {
    store["gov.doc_versions"].push({ id, document_id: docId, version_label: label, version_seq: seq });
  }
  return { subId, docId, targetItemId };
}

test("doc_repoint: moves the pin to the current version and confirms it by re-reading (D-132)", async () => {
  const store: Store = {};
  seedProjects(store);
  const v2 = uuid();
  const { subId } = seedRepointFixture(store, {
    pin: "1.0",
    published: [[uuid(), "1.0", 1], [v2, "2.0", 2]],
  });
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: v2 }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal((res as any).data.from_version, "1.0");
  assert.equal((res as any).data.to_version, "2.0");
  assert.equal((res as any).data.version_id, v2);
  assert.equal(store["gov.doc_subscriptions"].find((r: Row) => r.id === subId)!.subscribed_at_version, "2.0");
});

test("doc_repoint: refuses a version label in place of the gov.doc_versions UUID", async () => {
  const store: Store = {};
  seedProjects(store);
  const { subId } = seedRepointFixture(store, { published: [[uuid(), "2.0", 1]] });
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: "2.0" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /must be a UUID/);
});

test("doc_repoint: a stale seen_version_id is refused, and says what to re-read", async () => {
  const store: Store = {};
  seedProjects(store);
  const v1 = uuid();
  const v2 = uuid();
  const { subId } = seedRepointFixture(store, { pin: "1.0", published: [[v1, "1.0", 1], [v2, "2.0", 2]] });
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: v1 }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not the target's current one/);
  // The pin must NOT have moved on a refusal.
  assert.equal(store["gov.doc_subscriptions"].find((r: Row) => r.id === subId)!.subscribed_at_version, "1.0");
});

test("doc_repoint: already pinned to the current version is a refusal, never a silent ok", async () => {
  const store: Store = {};
  seedProjects(store);
  const v1 = uuid();
  const { subId } = seedRepointFixture(store, { pin: "1.0", published: [[v1, "1.0", 1]] });
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: v1 }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /already pinned/i);
  assert.match((res as any).error, /doc_staleness_close/);
});

test("doc_repoint: a target that was never published is refused with the reason, not a crash", async () => {
  const store: Store = {};
  seedProjects(store);
  const { subId } = seedRepointFixture(store, { pin: "1.0", published: [] });
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: uuid() }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /never been published/);
});

test("doc_repoint: a tombstoned subscription is not repointed", async () => {
  const store: Store = {};
  seedProjects(store);
  const v1 = uuid();
  const { subId } = seedRepointFixture(store, { published: [[v1, "2.0", 1]] });
  store["gov.doc_subscriptions"].find((r: Row) => r.id === subId)!.status = "tombstoned";
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: v1 }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not alive is not repointed/);
});

test("doc_repoint: an unknown subscription is a refusal, not a mute success (REQ-GOV-102)", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: uuid(), seen_version_id: uuid() }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not readable|does not exist/);
});

test("doc_repoint: says openly that moving the pin does not settle an open staleness debt", async () => {
  const store: Store = {};
  seedProjects(store);
  const v2 = uuid();
  const { subId } = seedRepointFixture(store, { pin: "1.0", published: [[uuid(), "1.0", 1], [v2, "2.0", 2]] });
  store["gov.doc_subscription_staleness"] = [
    { id: uuid(), subscription_id: subId, status: "open" },
    { id: uuid(), subscription_id: subId, status: "closed" },
  ];
  const db = makeDb(store);

  const res = await docRepoint(db, { subscription_id: subId, seen_version_id: v2 }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal((res as any).data.open_staleness, 1);
  assert.match((res as any).data.staleness_note, /does not settle the debt/);
});

// ---------------------------------------------------------------------------
// Admission suspension gate (SDES-SUB-CP-004 §4, REQ-SUB-013 criterion 3)
// ---------------------------------------------------------------------------

function seedAdmissionParam(store: Store, value: number | null, opts: { deprecated?: boolean; owner?: string } = {}): void {
  store.loomx_governance_params ??= [];
  store.loomx_governance_params.push({
    id: uuid(),
    param_key: "sottoscrizioni_ammissione_sospesa",
    value_type: "numeric",
    // node-pg hands `numeric` back as a STRING — seed it as one, or the test
    // passes on a shape production never sees.
    value_numeric: value === null ? null : String(value),
    owner_agent_code: opts.owner ?? "045",
    deprecated_at: opts.deprecated ? "2026-08-01T00:00:00Z" : null,
  });
}

function seedSubscribeFixture(store: Store): { subId: string; targetId: string } {
  seedProjects(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  const subId = uuid();
  seedDocItem(store, subId, PROJ_A, docId, "board-mcp");
  const targetId = uuid();
  seedDocItem(store, targetId, PROJ_A, docId, "dba");
  return { subId, targetId };
}

test("doc_subscribe: admission suspended (flag=1) refuses a NEW subscription with a speaking error", async () => {
  const store: Store = {};
  const { subId, targetId } = seedSubscribeFixture(store);
  seedAdmissionParam(store, 1);
  const db = makeDb(store);

  const res = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks it",
  }, ctx);
  assert.equal(res.ok, false);
  const msg = (res as any).error as string;
  assert.match(msg, /SUSPENDED/);
  assert.match(msg, /sottoscrizioni_ammissione_sospesa/);
  // The error must say what is NOT suspended — otherwise it reads as "the
  // system is off", which is exactly the wrong reaction (SDES-SUB-CP-004 §4).
  assert.match(msg, /existing subscriptions and their notifications keep running/);
  assert.match(msg, /045/);
  assert.equal((store["gov.doc_subscriptions"] ?? []).length, 0);
});

test("doc_subscribe: admission suspended does NOT break the idempotent re-call", async () => {
  const store: Store = {};
  const { subId, targetId } = seedSubscribeFixture(store);
  seedAdmissionParam(store, 0);
  const db = makeDb(store);
  const first = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks it",
  }, ctx);
  assert.ok(first.ok);

  // Suspension arrives after the fact; the same call must still be a no-op,
  // because it admits nothing new.
  store.loomx_governance_params = [];
  seedAdmissionParam(store, 1);
  const again = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks it",
  }, ctx);
  assert.ok(again.ok, `idempotent re-call must survive suspension: ${JSON.stringify(again)}`);
  assert.equal((again as any).data.created, false);
});

test("doc_subscribe: admission suspended does NOT block a grade change on an existing subscription", async () => {
  const store: Store = {};
  const { subId, targetId } = seedSubscribeFixture(store);
  seedAdmissionParam(store, 0);
  const db = makeDb(store);
  assert.ok((await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "informative", note: "watch",
  }, ctx)).ok);

  store.loomx_governance_params = [];
  seedAdmissionParam(store, 1);
  const bumped = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "watch",
  }, ctx);
  assert.ok(bumped.ok, `grade change is not a new admission: ${JSON.stringify(bumped)}`);
  assert.deepEqual((bumped as any).data.intent_changed, { from: "informative", to: "module" });
});

test("doc_subscribe: flag=0 admits, and says nothing extra", async () => {
  const store: Store = {};
  const { subId, targetId } = seedSubscribeFixture(store);
  seedAdmissionParam(store, 0);
  const db = makeDb(store);
  const res = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks it",
  }, ctx);
  assert.ok(res.ok);
  assert.equal((res as any).data.created, true);
  assert.equal((res as any).data.admission_gate, undefined);
});

test("doc_subscribe: an unreadable/missing flag admits but DECLARES it could not verify", async () => {
  const store: Store = {};
  const { subId, targetId } = seedSubscribeFixture(store);
  // No param row at all.
  const db = makeDb(store);
  const res = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks it",
  }, ctx);
  assert.ok(res.ok, `a missing parameter must never wall off subscriptions: ${JSON.stringify(res)}`);
  assert.equal((res as any).data.created, true);
  assert.match((res as any).data.admission_gate as string, /NOT VERIFIED/);
});

test("doc_subscribe: a DEPRECATED flag is not in force — admits, and says it is unverified", async () => {
  const store: Store = {};
  const { subId, targetId } = seedSubscribeFixture(store);
  seedAdmissionParam(store, 1, { deprecated: true });
  const db = makeDb(store);
  const res = await docSubscribe(db, {
    subscriber_item_id: subId, target_item_id: targetId, intent: "module", note: "tracks it",
  }, ctx);
  assert.ok(res.ok, `a deprecated row must not suspend anything: ${JSON.stringify(res)}`);
  assert.match((res as any).data.admission_gate as string, /deprecated/);
});

// ---------------------------------------------------------------------------
// doc_version_delta (forge msg 05ba7c9e — REQ-SUB-003 c.2 / REQ-SUB-011)
// ---------------------------------------------------------------------------

function seedVersion(store: Store, id: string, document_id: string, seq: number, label: string): void {
  store["gov.doc_versions"] ??= [];
  store["gov.doc_versions"].push({
    id, document_id, version_seq: seq, version_label: label,
    published_at: new Date(`2026-08-2${seq}T10:00:00Z`), // Date, as node-pg returns it
    delta_summary: `prose for ${label}`,
  });
}

function seedVersionItem(
  store: Store, publication_id: string, doc_item_id: string, code: string | null, sha: string,
  opts: { status?: string; item_type?: string } = {}
): void {
  store["gov.doc_version_items"] ??= [];
  store["gov.doc_version_items"].push({
    publication_id, doc_item_id, code, item_type: opts.item_type ?? "requirement",
    status: opts.status ?? "approved", content_sha256: sha,
  });
}

test("doc_version_delta: reports only the rows that actually changed, and the counts add up", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.3");
  const pubOld = uuid(), pubNew = uuid();
  seedVersion(store, pubOld, docId, 2, "1.2");
  seedVersion(store, pubNew, docId, 3, "1.3");

  const stable = uuid(), touched = uuid(), born = uuid(), gone = uuid(), sup = uuid();
  // baseline
  seedVersionItem(store, pubOld, stable, "REQ-1", "sha-stable");
  seedVersionItem(store, pubOld, touched, "REQ-2", "sha-old");
  seedVersionItem(store, pubOld, gone, "REQ-3", "sha-gone");
  seedVersionItem(store, pubOld, sup, "REQ-4", "sha-sup-old", { status: "approved" });
  // current
  seedVersionItem(store, pubNew, stable, "REQ-1", "sha-stable");
  seedVersionItem(store, pubNew, touched, "REQ-2", "sha-new");
  seedVersionItem(store, pubNew, born, "REQ-5", "sha-born");
  seedVersionItem(store, pubNew, sup, "REQ-4", "sha-sup-new", { status: "superseded" });

  const res = await docVersionDelta(db, { document_id: docId }, ctx);
  assert.ok(res.ok, `delta ok: ${JSON.stringify(res)}`);
  const d = (res as any).data;
  assert.equal(d.version.label, "1.3");
  assert.equal(d.baseline.label, "1.2");
  const byCode = Object.fromEntries(d.changes.map((c: any) => [c.code, c.change_kind]));
  assert.deepEqual(byCode, { "REQ-2": "modified", "REQ-5": "created", "REQ-4": "superseded", "REQ-3": "removed" });
  assert.equal(d.counts.unchanged, 1);
  assert.equal(d.counts.total_rows_in_version, 4);
  // The arithmetic must be checkable by the caller: changed + unchanged over
  // the current version equals its row count (removed rows are not in it).
  assert.equal(d.counts.created + d.counts.modified + d.counts.superseded + d.counts.unchanged, d.counts.total_rows_in_version);
  assert.equal(d.complete, true);
});

test("doc_version_delta: a first publication says baseline:null instead of faking one", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  const pub = uuid();
  seedVersion(store, pub, docId, 1, "1.0");
  seedVersionItem(store, pub, uuid(), "REQ-1", "a");
  seedVersionItem(store, pub, uuid(), "REQ-2", "b");

  const res = await docVersionDelta(db, { document_id: docId }, ctx);
  assert.ok(res.ok);
  const d = (res as any).data;
  assert.equal(d.baseline, null);
  assert.equal(d.counts.created, 2);
  assert.match(d.note as string, /First publication/);
});

test("doc_version_delta: a never-published document is an explicit error, not an empty delta", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.0");
  const res = await docVersionDelta(db, { document_id: docId }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /never been published/);
});

test("doc_version_delta: a missing snapshot is an error, never reported as 'nothing changed'", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "2.0");
  const pub = uuid();
  seedVersion(store, pub, docId, 1, "2.0"); // ledger row, but no gov.doc_version_items
  const res = await docVersionDelta(db, { document_id: docId }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /NOT an empty delta/);
});

test("doc_version_delta: an unknown version label lists the real ones instead of guessing", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.1");
  const pub = uuid();
  seedVersion(store, pub, docId, 1, "1.1");
  seedVersionItem(store, pub, uuid(), "REQ-1", "a");
  const res = await docVersionDelta(db, { document_id: docId, version: "9.9" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /not in this document's ledger/);
  assert.match((res as any).error, /1\.1/);
});

test("doc_version_delta: a baseline newer than the target is refused", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  const docId = uuid();
  seedDocument(store, docId, PROJ_A, "1.2");
  const p1 = uuid(), p2 = uuid();
  seedVersion(store, p1, docId, 1, "1.1");
  seedVersion(store, p2, docId, 2, "1.2");
  seedVersionItem(store, p1, uuid(), "REQ-1", "a");
  seedVersionItem(store, p2, uuid(), "REQ-1", "b");
  const res = await docVersionDelta(db, { document_id: docId, version: "1.1", against_version: "1.2" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /a delta runs forward in time/);
});

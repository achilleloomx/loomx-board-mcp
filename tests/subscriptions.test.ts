// Unit tests for src/subscriptions.ts (DEL-002, D-186 ratified design).
// Reuses the fake DB harness from tests/docs.test.ts (same query-builder shim
// keyed by table name — "gov.doc_subscriptions" is just a string key, no
// special-casing needed for the schema-qualified table names).
//
// Run with: npx tsx --test tests/subscriptions.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { docSubscribe, docUnsubscribe, docSubscriptionOutcome, docPublish } from "../src/subscriptions.ts";
import { makeDb, uuid, ctx, PROJ_A, PROJ_B, seedProjects, type Store, type Row } from "./fakeDb.ts";

function seedDocument(store: Store, id: string, project_id: string, version = "1.0"): void {
  store.documents ??= [];
  store.documents.push({ id, project_id, version, document_type: "req", title: "Doc", visibility: "project" });
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

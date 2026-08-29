// Cantiere id (D-241, mandate Achille 29/08) — truncation-proof references.
// Covers: idResolve (REQ-039/SDES-ID-002), verifyProjectExists + the orphan
// full-set check in docFactSync (REQ-038/SDES-ID-001), and the natural key on
// docSubscriptionOutcome (REQ-040/SDES-ID-003). The constructed-negative UAT
// counterparts are UAT-ID-001..004; gtd_query `fields` (SDES-ID-004) is
// handler-level and verified live (UAT-ID-005).
//
// Run with: npx tsx --test tests/id-cantiere.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { normalizeIdPrefix, prefixToUuidRange, idResolve, type IdResolveScope } from "../src/idResolve.ts";
import { docFactSync, verifyProjectExists } from "../src/factSync.ts";
import { docSubscriptionOutcome } from "../src/subscriptions.ts";
import { makeDb, uuid, ctx, PROJ_A, seedProjects, type Store, type Row } from "./fakeDb.ts";

const SCOPE: IdResolveScope = { selfSlug: "board-mcp", selfCode: "005", isLoomy: false, isBroker: false, loomyCode: "001" };

function seedSubscription(store: Store, overrides: Partial<Row> = {}): string {
  store["gov.doc_subscriptions"] ??= [];
  const id = uuid();
  store["gov.doc_subscriptions"].push({
    id,
    subscriber_item_id: null,
    subscriber_project_id: PROJ_A,
    target_item_id: null,
    target_document_id: null,
    intent: "module",
    origin: "choice",
    status: "active",
    tombstoned_at: null,
    subscribed_at_version: "1.0",
    note: "",
    ...overrides,
  });
  return id;
}

function seedDocItem(store: Store, id: string, project_id: string, document_id: string, owner: string, extra: Partial<Row> = {}): Row {
  store.doc_items ??= [];
  const row = { id, project_id, document_id, owner, code: null, status: "active", item_type: "uat_case", body: "x", attrs: {}, ...extra };
  store.doc_items.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// normalizeIdPrefix / prefixToUuidRange
// ---------------------------------------------------------------------------

test("normalizeIdPrefix: dashes stripped, case folded", () => {
  const r = normalizeIdPrefix("A5A81B7E-94ee");
  assert.equal(r.ok, true);
  assert.equal((r as any).hex, "a5a81b7e94ee");
});

test("normalizeIdPrefix: too short, non-hex and over-long are explicit errors", () => {
  assert.equal(normalizeIdPrefix("a5a81b7").ok, false);
  assert.match((normalizeIdPrefix("a5a81b7") as any).error, /at least 8/);
  assert.equal(normalizeIdPrefix("a5a81b7g").ok, false);
  assert.match((normalizeIdPrefix("a5a81b7g") as any).error, /not hexadecimal/);
  const long = "a".repeat(33);
  assert.equal(normalizeIdPrefix(long).ok, false);
  assert.match((normalizeIdPrefix(long) as any).error, /32/);
});

test("prefixToUuidRange: pads with 0 and f into canonical UUID bounds", () => {
  const { lower, upper } = prefixToUuidRange("aaaaaaaa");
  assert.equal(lower, "aaaaaaaa-0000-0000-0000-000000000000");
  assert.equal(upper, "aaaaaaaa-ffff-ffff-ffff-ffffffffffff");
});

// ---------------------------------------------------------------------------
// idResolve
// ---------------------------------------------------------------------------

function makeResolveStore(): Store {
  const store: Store = {};
  seedProjects(store);
  store.loomx_items = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "my gtd", owner: "board-mcp", deleted_at: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000001", title: "other's gtd", owner: "dba", deleted_at: null },
  ];
  store.board_messages = [
    { id: "cccccccc-0000-4000-8000-000000000001", subject: "to me", from_agent: "001", to_agent: "005" },
    { id: "dddddddd-0000-4000-8000-000000000001", subject: "not mine", from_agent: "001", to_agent: "002" },
  ];
  return store;
}

test("idResolve: unique match returns the FULL uuid with kind and label", async () => {
  const store = makeResolveStore();
  const db = makeDb(store);
  const res = await idResolve(db, { prefix: "aaaaaaaa" }, SCOPE, async (fn) => fn(db));
  assert.equal(res.ok, true);
  const d = (res as any).data;
  assert.equal(d.id, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(d.kind, "gtd_item");
  assert.equal(d.label, "my gtd");
});

test("idResolve: zero matches is an error citing the prefix, never a guess", async () => {
  const store = makeResolveStore();
  const db = makeDb(store);
  const res = await idResolve(db, { prefix: "eeeeeeee" }, SCOPE, async (fn) => fn(db));
  assert.equal(res.ok, false);
  assert.match((res as any).error, /eeeeeeee/);
  assert.match((res as any).error, /matches NOTHING/);
});

test("idResolve: ambiguity (constructed, two rows sharing the prefix) lists ALL candidates in full", async () => {
  const store = makeResolveStore();
  const docId = uuid();
  seedDocItem(store, "ffffffff-0000-4000-8000-000000000001", PROJ_A, docId, "board-mcp", { code: "PROBE-1" });
  seedDocItem(store, "ffffffff-0000-4000-8000-000000000002", PROJ_A, docId, "board-mcp", { code: "PROBE-2" });
  const db = makeDb(store);
  const res = await idResolve(db, { prefix: "ffffffff" }, SCOPE, async (fn) => fn(db));
  assert.equal(res.ok, false);
  assert.match((res as any).error, /AMBIGUOUS/);
  assert.match((res as any).error, /ffffffff-0000-4000-8000-000000000001/);
  assert.match((res as any).error, /ffffffff-0000-4000-8000-000000000002/);
});

test("idResolve: another owner's gtd item is invisible (caller scoping, no bypass)", async () => {
  const store = makeResolveStore();
  const db = makeDb(store);
  const res = await idResolve(db, { prefix: "bbbbbbbb" }, SCOPE, async (fn) => fn(db));
  assert.equal(res.ok, false);
  assert.match((res as any).error, /matches NOTHING/);
  // loomy sees it
  const asLoomy = await idResolve(db, { prefix: "bbbbbbbb" }, { ...SCOPE, selfSlug: "loomy", selfCode: "001", isLoomy: true }, async (fn) => fn(db));
  assert.equal(asLoomy.ok, true);
});

test("idResolve: board_message scoped to own from/to; other traffic invisible", async () => {
  const store = makeResolveStore();
  const db = makeDb(store);
  const mine = await idResolve(db, { prefix: "cccccccc" }, SCOPE, async (fn) => fn(db));
  assert.equal(mine.ok, true);
  assert.equal((mine as any).data.kind, "board_message");
  const notMine = await idResolve(db, { prefix: "dddddddd" }, SCOPE, async (fn) => fn(db));
  assert.equal(notMine.ok, false);
});

test("idResolve: unknown kind is an error (a filter accepted and ignored lies)", async () => {
  const db = makeDb(makeResolveStore());
  const res = await idResolve(db, { prefix: "aaaaaaaa", kinds: ["gtd_item", "nonsense"] }, SCOPE, async (fn) => fn(db));
  assert.equal(res.ok, false);
  assert.match((res as any).error, /unknown kind/i);
});

test("idResolve: doc kinds without a doc_rw backend are DECLARED unsearched", async () => {
  const db = makeDb(makeResolveStore());
  const res = await idResolve(db, { prefix: "aaaaaaaa", kinds: ["doc_item", "document"] }, SCOPE, undefined);
  assert.equal(res.ok, false);
  assert.match((res as any).error, /could not be searched in ANY/);
  assert.match((res as any).error, /DOC_RW_DATABASE_URL/);
});

// ---------------------------------------------------------------------------
// verifyProjectExists (REQ-038 / SDES-ID-001a)
// ---------------------------------------------------------------------------

test("verifyProjectExists: existing project passes; nonexistent one fails citing the id", async () => {
  const store: Store = {};
  seedProjects(store);
  const db = makeDb(store);
  assert.equal((await verifyProjectExists(db, PROJ_A)).ok, true);
  const ghost = "12345678-1234-4123-8123-123456789012";
  const res = await verifyProjectExists(db, ghost);
  assert.equal(res.ok, false);
  assert.match((res as any).error, new RegExp(ghost));
  assert.match((res as any).error, /does not exist/);
});

// ---------------------------------------------------------------------------
// docFactSync orphan check — full relation set (REQ-038 / SDES-ID-001b)
// ---------------------------------------------------------------------------

test("docFactSync: a satisfies-backed fact is NOT an orphan when filtering relation_types=['verifies']", async () => {
  const store: Store = {};
  seedProjects(store);
  const docId = uuid();
  store.documents = [{ id: docId, project_id: PROJ_A, version: "1.0", document_type: "sdes", title: "D", visibility: "project" }];
  const sdes = seedDocItem(store, uuid(), PROJ_A, docId, "board-mcp", { item_type: "sdes_entry", code: "S-1" });
  const req = seedDocItem(store, uuid(), PROJ_A, docId, "board-mcp", { item_type: "requirement", code: "R-1" });
  store.doc_item_links = [{ id: uuid(), from_item: sdes.id, to_item: req.id, relation_type: "satisfies", project_id: PROJ_A, created_at: "2026-08-01T00:00:00.000Z" }];
  // The fact that satisfies link derived — plus one TRUE orphan with no link at all.
  seedSubscription(store, { subscriber_item_id: sdes.id, target_item_id: req.id, origin: "fact", intent: "module" });
  const orphanSub = seedSubscription(store, { subscriber_item_id: seedDocItem(store, uuid(), PROJ_A, docId, "board-mcp").id, target_item_id: req.id, origin: "fact", intent: "critical" });

  const db = makeDb(store, new Set([PROJ_A]));
  const res = await docFactSync(db, { project_id: PROJ_A, relation_types: ["verifies"], dry_run: true }, ctx);
  assert.equal(res.ok, true);
  const data = (res as any).data;
  const orphanIds = (data.orphan_facts ?? []).map((o: any) => o.subscription_id);
  // The satisfies-backed fact must NOT be flagged; the true orphan must be.
  assert.ok(!orphanIds.includes((store["gov.doc_subscriptions"] as Row[])[0].id), "satisfies-backed fact wrongly flagged as orphan");
  assert.ok(orphanIds.includes(orphanSub), "true orphan (no link at all) was not reported");
  // The orphan note names the FULL derivable set, not the filtered one.
  assert.match((data.orphan_facts ?? [])[0].note, /verifies\/satisfies/);
});

// ---------------------------------------------------------------------------
// docSubscriptionOutcome — natural key (REQ-040 / SDES-ID-003)
// ---------------------------------------------------------------------------

function seedOutcomeWorld(store: Store): { subId: string; subscriberId: string; targetId: string } {
  seedProjects(store);
  const docId = uuid();
  store.documents = [{ id: docId, project_id: PROJ_A, version: "1.1", document_type: "sdes", title: "D", visibility: "project" }];
  const subscriber = seedDocItem(store, uuid(), PROJ_A, docId, "board-mcp", { code: "SUB-1" });
  const target = seedDocItem(store, uuid(), PROJ_A, docId, "dba", { code: "TGT-1" });
  const subId = seedSubscription(store, { subscriber_item_id: subscriber.id, target_item_id: target.id });
  store["gov.doc_versions"] = [{ id: uuid(), document_id: docId, version_label: "1.1", published_at: "2026-08-20T00:00:00.000Z" }];
  return { subId, subscriberId: subscriber.id, targetId: target.id };
}

test("outcome natural key: resolves the subscription and records, echoing the resolved id", async () => {
  const store: Store = {};
  const { subId, subscriberId, targetId } = seedOutcomeWorld(store);
  const db = makeDb(store);
  const res = await docSubscriptionOutcome(
    db,
    { subscriber_item_id: subscriberId, target_item_id: targetId, version: "1.1", outcome: "updated" },
    ctx
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  const d = (res as any).data;
  assert.equal(d.subscription_id, subId);
  assert.equal(d.created, true);
  assert.equal(d.resolved_from_natural_key, true);
});

test("outcome natural key: nonexistent pair is an error citing the values (constructed negative)", async () => {
  const store: Store = {};
  const { subscriberId } = seedOutcomeWorld(store);
  const ghost = "12345678-1234-4123-8123-123456789012";
  const db = makeDb(store);
  const res = await docSubscriptionOutcome(db, { subscriber_item_id: subscriberId, target_item_id: ghost, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(res.ok, false);
  assert.match((res as any).error, new RegExp(ghost));
  assert.match((res as any).error, /No subscription found/);
});

test("outcome natural key: multiple matches with ONE active resolve to it; none-active ambiguity lists candidates", async () => {
  const store: Store = {};
  const { subId, subscriberId, targetId } = seedOutcomeWorld(store);
  // A tombstoned sibling on the same pair — the active one must win.
  seedSubscription(store, { subscriber_item_id: subscriberId, target_item_id: targetId, status: "tombstoned", tombstoned_at: "2026-08-01T00:00:00.000Z" });
  const db = makeDb(store);
  const res = await docSubscriptionOutcome(db, { subscriber_item_id: subscriberId, target_item_id: targetId, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((res as any).data.subscription_id, subId);

  // Now two tombstoned, zero active → ambiguity, candidates listed.
  const store2: Store = {};
  const w2 = seedOutcomeWorld(store2);
  (store2["gov.doc_subscriptions"] as Row[])[0].status = "tombstoned";
  const t2 = seedSubscription(store2, { subscriber_item_id: w2.subscriberId, target_item_id: w2.targetId, status: "tombstoned" });
  const db2 = makeDb(store2);
  const res2 = await docSubscriptionOutcome(db2, { subscriber_item_id: w2.subscriberId, target_item_id: w2.targetId, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(res2.ok, false);
  assert.match((res2 as any).error, /AMBIGUOUS/);
  assert.match((res2 as any).error, new RegExp(w2.subId));
  assert.match((res2 as any).error, new RegExp(t2));
});

test("outcome: both keys together, or neither, are explicit errors", async () => {
  const store: Store = {};
  const { subId, subscriberId, targetId } = seedOutcomeWorld(store);
  const db = makeDb(store);
  const both = await docSubscriptionOutcome(db, { subscription_id: subId, subscriber_item_id: subscriberId, target_item_id: targetId, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(both.ok, false);
  assert.match((both as any).error, /EITHER/);
  const neither = await docSubscriptionOutcome(db, { version: "1.1", outcome: "updated" }, ctx);
  assert.equal(neither.ok, false);
  assert.match((neither as any).error, /Missing key/);
});

test("outcome regression: the subscription_id path is unchanged (idempotent no-op included)", async () => {
  const store: Store = {};
  const { subId } = seedOutcomeWorld(store);
  const db = makeDb(store);
  const first = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((first as any).data.created, true);
  assert.equal((first as any).data.resolved_from_natural_key, undefined);
  const again = await docSubscriptionOutcome(db, { subscription_id: subId, version: "1.1", outcome: "updated" }, ctx);
  assert.equal(again.ok, true);
  assert.equal((again as any).data.created, false);
});

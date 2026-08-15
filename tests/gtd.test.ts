// Unit tests for src/tools.ts GTD update payload building.
// Run with: npx tsx --test tests/gtd.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildGtdUpdatePayload, brokerAutopilotArmBlocked, resolveBoardActorFilterCode, buildAutoGtdInsertPayload, buildProjectWarning } from "../src/tools.ts";

test("buildGtdUpdatePayload: body-only leaves gtd_status untouched (footgun regression)", () => {
  const updates = buildGtdUpdatePayload({ body: "just a note" });
  assert.equal(updates.body, "just a note");
  assert.equal("gtd_status" in updates, false);
  assert.equal("title" in updates, false);
  assert.equal("owner" in updates, false);
});

test("buildGtdUpdatePayload: explicit gtd_status is included", () => {
  const updates = buildGtdUpdatePayload({ gtd_status: "done" });
  assert.equal(updates.gtd_status, "done");
});

test("buildGtdUpdatePayload: nullable fields can be explicitly cleared", () => {
  const updates = buildGtdUpdatePayload({ deadline: null, waiting_on: null });
  assert.equal(updates.deadline, null);
  assert.equal(updates.waiting_on, null);
});

test("buildGtdUpdatePayload: always stamps updated_at", () => {
  const updates = buildGtdUpdatePayload({});
  assert.ok(typeof updates.updated_at === "string");
});

test("buildGtdUpdatePayload: no_auto_arm is included when set (D-100 park gap)", () => {
  assert.equal("no_auto_arm" in buildGtdUpdatePayload({ body: "note" }), false);
  const parked = buildGtdUpdatePayload({ no_auto_arm: true });
  assert.equal(parked.no_auto_arm, true);
  const unparked = buildGtdUpdatePayload({ no_auto_arm: false });
  assert.equal(unparked.no_auto_arm, false);
});

test("buildGtdUpdatePayload: clarified_at is included when set, untouched when omitted", () => {
  assert.equal("clarified_at" in buildGtdUpdatePayload({ body: "note" }), false);
  const cleared = buildGtdUpdatePayload({ clarified_at: null });
  assert.equal(cleared.clarified_at, null);
  const stamped = buildGtdUpdatePayload({ clarified_at: "2026-07-07T10:00:00.000Z" });
  assert.equal(stamped.clarified_at, "2026-07-07T10:00:00.000Z");
});

test("brokerAutopilotArmBlocked: broker blocked once owner has acked (clarified_at set)", () => {
  const blocked = brokerAutopilotArmBlocked({
    isBroker: true,
    isLoomy: false,
    selfSlug: "loomy-assistant",
    targetOwner: "dev-hq",
    targetClarifiedAt: "2026-07-07T10:00:00.000Z",
  });
  assert.equal(blocked, true);
});

test("brokerAutopilotArmBlocked: broker allowed on never-acked item (clarified_at null)", () => {
  const allowed = brokerAutopilotArmBlocked({
    isBroker: true,
    isLoomy: false,
    selfSlug: "loomy-assistant",
    targetOwner: "dev-hq",
    targetClarifiedAt: null,
  });
  assert.equal(allowed, false);
});

test("brokerAutopilotArmBlocked: broker on own item is never blocked by this gate", () => {
  const blocked = brokerAutopilotArmBlocked({
    isBroker: true,
    isLoomy: false,
    selfSlug: "loomy-assistant",
    targetOwner: "loomy-assistant",
    targetClarifiedAt: "2026-07-07T10:00:00.000Z",
  });
  assert.equal(blocked, false);
});

test("brokerAutopilotArmBlocked: loomy is never blocked (full override)", () => {
  const blocked = brokerAutopilotArmBlocked({
    isBroker: true,
    isLoomy: true,
    selfSlug: "loomy",
    targetOwner: "dev-hq",
    targetClarifiedAt: "2026-07-07T10:00:00.000Z",
  });
  assert.equal(blocked, false);
});

// D-093 cross-owner ack (GTD 983c0784): broker can close loomy's mail AND its own.
test("resolveBoardActorFilterCode: loomy gets no filter (full override)", () => {
  const filter = resolveBoardActorFilterCode({
    isLoomy: true,
    isBroker: false,
    selfCode: "001",
    loomyCode: "001",
  });
  assert.equal(filter, null);
});

test("resolveBoardActorFilterCode: broker is scoped to its own inbox + loomy's, not any agent", () => {
  const filter = resolveBoardActorFilterCode({
    isLoomy: false,
    isBroker: true,
    selfCode: "005",
    loomyCode: "001",
  });
  assert.deepEqual(filter, ["005", "001"]);
});

// Regression (msg 5df512b6 / 592b1cda, fixed 2026-08-01): the previous
// single-code return replaced "own inbox" with "loomy only" instead of
// adding to it, so board_ack rejected messages addressed to the broker
// itself. Both branches of the IN-filter must be present.
test("resolveBoardActorFilterCode: broker's own-inbox messages stay ackable (regression)", () => {
  const filter = resolveBoardActorFilterCode({
    isLoomy: false,
    isBroker: true,
    selfCode: "005",
    loomyCode: "001",
  });
  assert.ok(filter?.includes("005"), "broker must be able to ack messages addressed to itself");
  assert.ok(filter?.includes("001"), "broker must be able to ack messages addressed to loomy");
});

test("resolveBoardActorFilterCode: plain agent is scoped to its own inbox", () => {
  const filter = resolveBoardActorFilterCode({
    isLoomy: false,
    isBroker: false,
    selfCode: "032",
    loomyCode: "001",
  });
  assert.deepEqual(filter, ["032"]);
});

test("resolveBoardActorFilterCode: broker without a resolvable loomy code falls back to its own inbox (no unbounded ack)", () => {
  const filter = resolveBoardActorFilterCode({
    isLoomy: false,
    isBroker: true,
    selfCode: "005",
    loomyCode: undefined,
  });
  assert.deepEqual(filter, ["005"]);
});

// GTD 994b3bbc: board_send/board_broadcast auto_gtd payload shape.
test("buildAutoGtdInsertPayload: defaults to inbox/normal, source='board'", () => {
  const payload = buildAutoGtdInsertPayload({
    owner: "dev-hq",
    title: "subject line",
    body: "body text",
    source_ref: "11111111-1111-1111-1111-111111111111",
  });
  assert.deepEqual(payload, {
    title: "subject line",
    body: "body text",
    gtd_status: "inbox",
    owner: "dev-hq",
    priority: "normal",
    source: "board",
    source_ref: "11111111-1111-1111-1111-111111111111",
  });
});

test("buildAutoGtdInsertPayload: distinct owners never collide on the same source_ref (broadcast fan-out)", () => {
  const sameRef = "22222222-2222-2222-2222-222222222222";
  const a = buildAutoGtdInsertPayload({ owner: "dev-hq", title: "t", body: null, source_ref: sameRef });
  const b = buildAutoGtdInsertPayload({ owner: "atlas", title: "t", body: null, source_ref: sameRef });
  assert.notEqual(a.owner, b.owner);
  assert.equal(a.source_ref, b.source_ref);
});

test("buildAutoGtdInsertPayload: priority passthrough for wake-marked messages", () => {
  const payload = buildAutoGtdInsertPayload({
    owner: "dev-hq",
    title: "t",
    body: null,
    source_ref: "33333333-3333-3333-3333-333333333333",
    priority: "urgent",
  });
  assert.equal(payload.priority, "urgent");
});

// Stream B-4 (GTD 3acb2328): gtd_add soft-warn when project_id is omitted.
test("buildProjectWarning: warns when project_id is omitted (G1)", () => {
  const warning = buildProjectWarning(undefined);
  assert.ok(warning && warning.length > 0);
  assert.match(warning, /project_id/);
});

test("buildProjectWarning: silent when project_id is given (G2)", () => {
  assert.equal(buildProjectWarning("11111111-1111-1111-1111-111111111111"), undefined);
});

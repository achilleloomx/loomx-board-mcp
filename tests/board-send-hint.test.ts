// Unit tests for src/tools.ts buildColdRecipientHint (D-118 c2).
// Run with: npx tsx --test tests/board-send-hint.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildColdRecipientHint } from "../src/tools.ts";

const NOW = Date.parse("2026-08-10T12:00:00Z");

test("buildColdRecipientHint: cold recipient (stale heartbeat) + actionable type + no wake_priority -> hint", () => {
  const hint = buildColdRecipientHint({
    toAgent: "it-manager",
    messageType: "task",
    wakePriorityOmitted: true,
    heartbeatAt: "2026-08-10T11:00:00Z", // 60m ago, > 10m threshold
    nowMs: NOW,
  });
  assert.match(hint ?? "", /it-manager/);
  assert.match(hint ?? "", /cold/);
});

test("buildColdRecipientHint: no heartbeat row at all -> hint (treated as cold)", () => {
  const hint = buildColdRecipientHint({
    toAgent: "dba",
    messageType: "question",
    wakePriorityOmitted: true,
    heartbeatAt: null,
    nowMs: NOW,
  });
  assert.match(hint ?? "", /nessun heartbeat/);
});

test("buildColdRecipientHint: warm recipient (fresh heartbeat) -> no hint", () => {
  const hint = buildColdRecipientHint({
    toAgent: "it-manager",
    messageType: "task",
    wakePriorityOmitted: true,
    heartbeatAt: "2026-08-10T11:58:00Z", // 2m ago, < 10m threshold
    nowMs: NOW,
  });
  assert.equal(hint, undefined);
});

test("buildColdRecipientHint: wake_priority already set -> no hint (sender already handled it)", () => {
  const hint = buildColdRecipientHint({
    toAgent: "it-manager",
    messageType: "task",
    wakePriorityOmitted: false,
    heartbeatAt: null,
    nowMs: NOW,
  });
  assert.equal(hint, undefined);
});

test("buildColdRecipientHint: non-actionable type (info/done/alignment_issue) -> no hint", () => {
  for (const messageType of ["info", "done", "alignment_issue"]) {
    const hint = buildColdRecipientHint({
      toAgent: "it-manager",
      messageType,
      wakePriorityOmitted: true,
      heartbeatAt: null,
      nowMs: NOW,
    });
    assert.equal(hint, undefined, `type=${messageType} must not hint`);
  }
});

test("buildColdRecipientHint: blocker type is actionable -> hints like task/question", () => {
  const hint = buildColdRecipientHint({
    toAgent: "it-manager",
    messageType: "blocker",
    wakePriorityOmitted: true,
    heartbeatAt: null,
    nowMs: NOW,
  });
  assert.ok(hint);
});

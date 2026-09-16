// Unit tests for src/tools.ts shouldForceAutoGtd (IA-009/CORE-019, GTD 72436ca3).
// Run with: npx tsx --test tests/board-send-human-recipient.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { shouldForceAutoGtd } from "../src/tools.ts";

test("shouldForceAutoGtd: human recipient forces it on even with auto_gtd omitted", () => {
  assert.equal(
    shouldForceAutoGtd({ requestedAutoGtd: undefined, isHumanRecipient: true }),
    true
  );
});

test("shouldForceAutoGtd: human recipient forces it on even with auto_gtd explicitly false", () => {
  assert.equal(
    shouldForceAutoGtd({ requestedAutoGtd: false, isHumanRecipient: true }),
    true
  );
});

test("shouldForceAutoGtd: non-human recipient respects the caller's explicit true", () => {
  assert.equal(
    shouldForceAutoGtd({ requestedAutoGtd: true, isHumanRecipient: false }),
    true
  );
});

test("shouldForceAutoGtd: non-human recipient, no opt-in -> unchanged (false)", () => {
  assert.equal(
    shouldForceAutoGtd({ requestedAutoGtd: undefined, isHumanRecipient: false }),
    false
  );
  assert.equal(
    shouldForceAutoGtd({ requestedAutoGtd: false, isHumanRecipient: false }),
    false
  );
});

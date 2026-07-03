// Unit tests for src/tools.ts GTD update payload building.
// Run with: npx tsx --test tests/gtd.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildGtdUpdatePayload } from "../src/tools.ts";

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

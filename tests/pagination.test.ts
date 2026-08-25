// Unit tests for src/pagination.ts (CV-8, D-203).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { paginate } from "../src/pagination.ts";

test("paginate: fewer rows than limit -> no truncated field at all", () => {
  const res = paginate([1, 2, 3], 5);
  assert.deepEqual(res.page, [1, 2, 3]);
  assert.equal("truncated" in res, false);
});

test("paginate: exactly limit rows -> no truncated field (not a false sentinel)", () => {
  const res = paginate([1, 2, 3], 3);
  assert.deepEqual(res.page, [1, 2, 3]);
  assert.equal("truncated" in res, false);
});

test("paginate: limit+1 rows fetched -> sliced to limit, truncated:true", () => {
  const res = paginate([1, 2, 3, 4], 3);
  assert.deepEqual(res.page, [1, 2, 3]);
  assert.equal(res.truncated, true);
});

test("paginate: empty input -> empty page, no truncated field", () => {
  const res = paginate([], 20);
  assert.deepEqual(res.page, []);
  assert.equal("truncated" in res, false);
});

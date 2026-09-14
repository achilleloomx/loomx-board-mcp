// Unit tests for PgShimClient.rpc() — schema-qualified function names
// (gov.applicable_norms, agent_context/SDES-001). Before this fix the bare
// identifier regex rejected any dotted name outright ("Invalid function
// name"), even though `.from("gov.doc_subscriptions")` already trusted the
// same dotted form via `ident()` for tables. rpc() now reuses that same
// validated-and-quoted path instead of interpolating the name raw.
//
// Run: npx tsx --test tests/pgshim-rpc.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PgShimClient } from "../src/pg-shim.ts";

function fakePool(rowsFor: (sql: string) => any[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
  };
  return { pool, calls };
}

test("rpc: schema-qualified function name is quoted per-segment and the scalar column is unwrapped by its BASE name", async () => {
  const { pool, calls } = fakePool(() => [{ applicable_norms: [{ code: "CORE-001", grade: 1 }] }]);
  const client = new PgShimClient(pool as any);

  const { data, error } = await client.rpc("gov.applicable_norms", { p_agent: "board-mcp" });

  assert.equal(error, null);
  assert.deepEqual(data, [{ code: "CORE-001", grade: 1 }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM "gov"\."applicable_norms"\(p_agent => \$1\)/);
  assert.deepEqual(calls[0].params, ["board-mcp"]);
});

test("rpc: unqualified function name — no regression vs pre-fix behavior", async () => {
  const { pool, calls } = fakePool(() => [{ board_archive_old: 3 }]);
  const client = new PgShimClient(pool as any);

  const { data } = await client.rpc("board_archive_old", { days: 30 });

  assert.equal(data, 3);
  assert.match(calls[0].sql, /FROM "board_archive_old"\(days => \$1\)/);
});

test("rpc: set-returning function (multiple/columns rows) returns the row array untouched", async () => {
  const { pool } = fakePool(() => [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  const client = new PgShimClient(pool as any);

  const { data, error } = await client.rpc("some_fn", {});

  assert.equal(error, null);
  assert.deepEqual(data, [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
});

test("rpc: malformed function name is rejected, never reaches the pool", async () => {
  const { pool, calls } = fakePool(() => []);
  const client = new PgShimClient(pool as any);

  const { data, error } = await client.rpc("gov.bad name; DROP TABLE x", {});

  assert.equal(data, null);
  assert.ok(error, "expected an error for a malformed function name");
  assert.equal(calls.length, 0, "must never reach the pool with an unvalidated identifier");
});

test("rpc: three-segment name is rejected (schema.function only, same as ident() for tables)", async () => {
  const { pool } = fakePool(() => []);
  const client = new PgShimClient(pool as any);

  const { error } = await client.rpc("a.b.c", {});

  assert.ok(error);
});

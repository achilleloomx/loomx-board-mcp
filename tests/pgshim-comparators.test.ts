// Unit tests for PgQuery comparator filters (gte/lte/gt/lt).
// wi.ts's resolveAutoWaitingOn (D-118 guard, runs unconditionally even with
// LOOMX_RW_GUARDS_ENABLED off, for the dry-run log) and wi_query --since both
// call .gte() on the query builder — the pg-shim (DATABASE_URL backend, D-084)
// never implemented it, so any agent running on the direct-postgres backend
// crashed with "db.from(...).select(...).eq(...).gte is not a function" on
// wi_end(status="waiting") (board msg 5cc2fba8, agent nottolini).
//
// Run: npx tsx --test tests/pgshim-comparators.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PgQuery, type PgExecutor } from "../src/pg-shim.ts";

function recorder(rowsFor: (sql: string) => any[] = () => []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const exec: PgExecutor = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: rowsFor(sql) };
  };
  return { exec, calls };
}

test("gte builds a >= WHERE clause", async () => {
  const { exec, calls } = recorder();
  const q = new PgQuery(exec, "board_messages");
  const { error } = await q
    .select("id, to_agent, type, created_at")
    .eq("from_agent", "005")
    .gte("created_at", "2026-08-10T00:00:00Z");

  assert.equal(error, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE "from_agent" = \$1 AND "created_at" >= \$2/);
  assert.deepEqual(calls[0].params, ["005", "2026-08-10T00:00:00Z"]);
});

test("lte/gt/lt build the matching comparison operators", async () => {
  const { exec, calls } = recorder();
  await new PgQuery(exec, "widgets").select().lte("a", 1);
  await new PgQuery(exec, "widgets").select().gt("b", 2);
  await new PgQuery(exec, "widgets").select().lt("c", 3);

  assert.match(calls[0].sql, /"a" <= \$1/);
  assert.match(calls[1].sql, /"b" > \$1/);
  assert.match(calls[2].sql, /"c" < \$1/);
});

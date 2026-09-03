// Unit tests for PgQuery comparator filters (gte/lte/gt/lt/neq).
// wi.ts's resolveAutoWaitingOn (D-118 guard, runs unconditionally even with
// LOOMX_RW_GUARDS_ENABLED off, for the dry-run log) and wi_query --since both
// call .gte() on the query builder — the pg-shim (DATABASE_URL backend, D-084)
// never implemented it, so any agent running on the direct-postgres backend
// crashed with "db.from(...).select(...).eq(...).gte is not a function" on
// wi_end(status="waiting") (board msg 5cc2fba8, agent nottolini).
//
// Same class of bug recurred for .neq(): computePendingWakes (D-238,
// src/pendingInbox.ts) chains .not("wake_priority","is",null).neq("status",
// "acknowledged") — the shim never implemented .neq() either, so wi_end on the
// pg backend closed the WI/GTD fine but threw composing the response (board
// msg 835fcd46, agent frame). Regression test below pins .neq() down.
//
//
// ISS-051 (board msg 0331e86d, it-manager): .not(col, "eq", val) was the one
// .not() form never implemented (only "in" and "is"+null were) — tools.ts's
// autoCreateGtdForRecipient (board_send/board_broadcast auto_gtd) and both
// gtd_add dedup checks chain .not("gtd_status", "eq", "trash"), so every
// source_ref dedup and every auto_gtd call threw "Unsupported .not() form:
// eq" on the pg backend. Regression test below pins the eq branch down.
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

test("neq builds a <> WHERE clause and chains after .not()", async () => {
  const { exec, calls } = recorder();
  const { error } = await new PgQuery(exec, "board_messages")
    .select("id, to_agent, wake_priority, status")
    .eq("to_agent", "005")
    .is("archived_at", null)
    .not("wake_priority", "is", null)
    .neq("status", "acknowledged");

  assert.equal(error, null);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].sql,
    /WHERE "to_agent" = \$1 AND "archived_at" IS NULL AND "wake_priority" IS NOT NULL AND "status" <> \$2/
  );
  assert.deepEqual(calls[0].params, ["005", "acknowledged"]);
});

test("not(col, 'eq', val) builds a <> WHERE clause (ISS-051)", async () => {
  const { exec, calls } = recorder();
  const { error } = await new PgQuery(exec, "loomx_items")
    .select("id")
    .eq("owner", "board-mcp")
    .not("gtd_status", "eq", "trash");

  assert.equal(error, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE "owner" = \$1 AND "gtd_status" <> \$2/);
  assert.deepEqual(calls[0].params, ["board-mcp", "trash"]);
});

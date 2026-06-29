// Unit tests for the pg-shim doc_rw "no-RETURNING" mode (D-a5 write-path fix).
// Under doc_rw, `INSERT/UPDATE … RETURNING` makes the RLS WITH CHECK wrongly deny
// GUC-based writes. In noReturning mode PgQuery must: emit NO RETURNING, inject a
// client-side id on INSERT and synthesize the result, and do a follow-up SELECT
// for UPDATE. Normal mode must keep RETURNING (no regression).
//
// Run: npx tsx --test tests/pgshim-noreturning.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PgQuery, type PgExecutor } from "../src/pg-shim.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fake executor that records every (sql, params) and returns canned rows.
function recorder(rowsFor: (sql: string) => any[] = () => []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const exec: PgExecutor = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: rowsFor(sql) };
  };
  return { exec, calls };
}

test("noReturning INSERT: no RETURNING, id injected, row synthesized", async () => {
  const { exec, calls } = recorder();
  const q = new PgQuery(exec, "documents", { noReturning: true });
  const { data, error } = await q
    .insert({ project_id: "p1", document_type: "sow", title: "t" })
    .select("id, document_type, title")
    .single();

  assert.equal(error, null);
  assert.equal(calls.length, 1, "exactly one statement (the INSERT)");
  assert.ok(!/RETURNING/i.test(calls[0].sql), `INSERT must not contain RETURNING: ${calls[0].sql}`);
  assert.match(calls[0].sql, /^INSERT INTO "documents"/);
  // id was injected into the column list + synthesized into the result
  assert.match(calls[0].sql, /"id"/);
  assert.ok(UUID_RE.test((data as any).id), "synthesized row carries a generated uuid");
  assert.equal((data as any).document_type, "sow");
  assert.equal((data as any).title, "t");
});

test("noReturning INSERT keeps a caller-provided id (no override)", async () => {
  const { exec, calls } = recorder();
  const q = new PgQuery(exec, "doc_items", { noReturning: true });
  const { data } = await q.insert({ id: "fixed-id", code: "REQ-1" }).select("id, code").single();
  assert.equal((data as any).id, "fixed-id");
  assert.ok(!/RETURNING/i.test(calls[0].sql));
});

test("noReturning UPDATE: no RETURNING, follow-up SELECT returns the row", async () => {
  const { exec, calls } = recorder((sql) => (/^SELECT/.test(sql) ? [{ id: "x1", status: "superseded" }] : []));
  const q = new PgQuery(exec, "doc_items", { noReturning: true });
  const { data, error } = await q
    .update({ status: "superseded" })
    .eq("id", "x1")
    .select("id, status")
    .single();

  assert.equal(error, null);
  assert.equal(calls.length, 2, "UPDATE then follow-up SELECT");
  assert.match(calls[0].sql, /^UPDATE "doc_items" SET/);
  assert.ok(!/RETURNING/i.test(calls[0].sql), "UPDATE must not contain RETURNING");
  assert.match(calls[1].sql, /^SELECT "id", "status" FROM "doc_items" WHERE "id" = \$1/);
  assert.deepEqual(data, { id: "x1", status: "superseded" });
});

test("normal mode (no opts) keeps RETURNING — no regression", async () => {
  const { exec, calls } = recorder(() => [{ id: "srv-id", title: "t" }]);
  const q = new PgQuery(exec, "documents"); // default: RETURNING on
  await q.insert({ title: "t" }).select("id, title").single();
  assert.match(calls[0].sql, /RETURNING "id", "title"/);
  assert.equal(calls.length, 1);
});

// Unit tests for PgQuery.upsert (GTD a82858fb-091e-44e0-8967-6f650ed528ba).
// item_project_link calls db.from(...).upsert({...}, {onConflict}).select().maybeSingle(),
// which threw "upsert is not a function" whenever board-mcp runs on the direct-postgres
// backend (DATABASE_URL / pg-shim) — the shim never implemented upsert().
//
// Run: npx tsx --test tests/pgshim-upsert.test.ts

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

test("upsert issues INSERT .. ON CONFLICT DO UPDATE with RETURNING", async () => {
  const { exec, calls } = recorder(() => [{ item_id: "i1", project_id: "p1" }]);
  const q = new PgQuery(exec, "loomx_item_projects");
  const { data, error } = await q
    .upsert({ item_id: "i1", project_id: "p1" }, { onConflict: "item_id,project_id" })
    .select("item_id, project_id")
    .maybeSingle();

  assert.equal(error, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^INSERT INTO "loomx_item_projects" \("item_id", "project_id"\) VALUES \(\$1, \$2\)/);
  assert.match(calls[0].sql, /ON CONFLICT \("item_id", "project_id"\) DO UPDATE SET/);
  assert.match(calls[0].sql, /RETURNING "item_id", "project_id"/);
  assert.deepEqual(data, { item_id: "i1", project_id: "p1" });
});

test("upsert with extra non-conflict columns updates only those on conflict", async () => {
  const { exec, calls } = recorder(() => [{ id: "x1", name: "n2" }]);
  const q = new PgQuery(exec, "widgets");
  await q.upsert({ id: "x1", name: "n2" }, { onConflict: "id" }).select("id, name").maybeSingle();

  assert.match(calls[0].sql, /ON CONFLICT \("id"\) DO UPDATE SET "name" = EXCLUDED\."name"/);
});

test("upsert requires onConflict", async () => {
  const { exec } = recorder();
  const q = new PgQuery(exec, "widgets");
  const { error } = await q.upsert({ id: "x1" }).select("id").maybeSingle();
  assert.ok(error);
  assert.match(error!.message, /onConflict is required/);
});

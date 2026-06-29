// Unit tests for the doc_rw transaction wrapper (D-a5 F4.5). Deterministic,
// no DB/network. Validates: the exact contract transaction block is built, the
// caller slug is escaped (never a SQL-injection vector), values are inlined
// safely, invalid slugs are rejected, and no doc_rw backend → actionable refusal.
//
// Run: npx tsx --test tests/docrw.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildMgmtSql,
  inlineParams,
  literal,
  assertSlug,
  docRwMode,
  runDocRw,
} from "../src/docDb.ts";

test("buildMgmtSql emits the exact contract transaction block", () => {
  const sql = buildMgmtSql("analyst-pieroni", "SELECT * FROM documents WHERE project_id = $1", ["p1"]);
  assert.match(sql, /^BEGIN; SET LOCAL ROLE doc_rw; /);
  // Slug set via loomx_set_agent_slug() (SECURITY DEFINER, REQ-GOV-012) in a DO block
  // (no result set) so a 0-row data query is not masked by the slug-set row.
  assert.match(sql, /DO \$docrw\$ BEGIN PERFORM loomx_set_agent_slug\('analyst-pieroni'\); END \$docrw\$;/);
  assert.match(sql, /SELECT \* FROM documents WHERE project_id = 'p1';/);
  assert.match(sql, /COMMIT;$/);
});

test("slug is escaped into loomx_set_agent_slug() call (no injection)", () => {
  // assertSlug would reject this in runDocRw, but buildMgmtSql must still escape.
  const sql = buildMgmtSql("a'; DROP TABLE documents; --", "SELECT 1", []);
  assert.ok(!/DROP TABLE documents/.test(sql.split("loomx_set_agent_slug")[0]), "no injection before loomx_set_agent_slug");
  // the quote is doubled inside the escaped literal
  assert.match(sql, /loomx_set_agent_slug\('a''; DROP TABLE documents; --'\)/);
});

test("inlineParams inlines values safely (escaping, jsonb, null, numbers, bools)", () => {
  assert.equal(literal(null), "NULL");
  assert.equal(literal(42), "42");
  assert.equal(literal(true), "true");
  assert.equal(literal("it's"), "'it''s'");
  assert.equal(literal({ a: 1 }), `'{"a":1}'::jsonb`);
  assert.throws(() => literal([1, 2]), /array params not supported/);

  const out = inlineParams("INSERT INTO t (a,b,c) VALUES ($1,$2,$3)", ["x'y", 7, null]);
  assert.equal(out, "INSERT INTO t (a,b,c) VALUES ('x''y',7,NULL)");
});

test("assertSlug rejects empty/invalid, accepts real slugs", () => {
  assert.throws(() => assertSlug(""), /invalid agent slug/);
  assert.throws(() => assertSlug("Bad Slug"), /invalid agent slug/);
  assert.throws(() => assertSlug("a'b"), /invalid agent slug/);
  assert.doesNotThrow(() => assertSlug("analyst-pieroni"));
  assert.doesNotThrow(() => assertSlug("dev-kinesis"));
  assert.doesNotThrow(() => assertSlug("board-mcp"));
});

test("runDocRw refuses when no doc_rw backend is configured (no service_role bypass)", async () => {
  const saved = {
    url: process.env.DOC_RW_DATABASE_URL,
    pat: process.env.SUPABASE_MGMT_PAT,
    ref: process.env.SUPABASE_PROJECT_REF,
  };
  delete process.env.DOC_RW_DATABASE_URL;
  delete process.env.SUPABASE_MGMT_PAT;
  delete process.env.SUPABASE_PROJECT_REF;
  try {
    assert.equal(docRwMode(), null);
    await assert.rejects(
      () => runDocRw("board-mcp", async () => ({ ok: true })),
      /require the doc_rw wiring|Refusing to run doc_\* as service_role/
    );
  } finally {
    if (saved.url) process.env.DOC_RW_DATABASE_URL = saved.url;
    if (saved.pat) process.env.SUPABASE_MGMT_PAT = saved.pat;
    if (saved.ref) process.env.SUPABASE_PROJECT_REF = saved.ref;
  }
});

test("docRwMode prefers pg over mgmt", () => {
  const saved = { ...process.env };
  process.env.DOC_RW_DATABASE_URL = "postgres://x";
  process.env.SUPABASE_MGMT_PAT = "pat";
  process.env.SUPABASE_PROJECT_REF = "ref";
  try {
    assert.equal(docRwMode(), "pg");
    delete process.env.DOC_RW_DATABASE_URL;
    assert.equal(docRwMode(), "mgmt");
  } finally {
    delete process.env.DOC_RW_DATABASE_URL;
    if (!saved.SUPABASE_MGMT_PAT) delete process.env.SUPABASE_MGMT_PAT;
    if (!saved.SUPABASE_PROJECT_REF) delete process.env.SUPABASE_PROJECT_REF;
  }
});

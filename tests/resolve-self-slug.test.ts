// Unit test for D-084 Fase 1(a) fallback path: resolveSelfSlug() when
// DATABASE_URL is unset must behave exactly like pre-Fase-1 (trust --agent,
// require it). The current_user-derivation path (DATABASE_URL set) needs a
// live Postgres role and is covered by the pilot-e2e/gardenstone e2e test
// (D-084 body), not here.
//
// Run: npx tsx --test tests/resolve-self-slug.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

process.env.SUPABASE_URL = "https://example.invalid.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
delete process.env.DATABASE_URL;

const { resolveSelfSlug, getBackend } = await import("../src/supabase.ts");

test("resolveSelfSlug: without DATABASE_URL, trusts and returns --agent (unchanged fallback)", async () => {
  const slug = await resolveSelfSlug("board-mcp");
  assert.equal(slug, "board-mcp");
  assert.equal(getBackend(), "supabase");
});

test("resolveSelfSlug: without DATABASE_URL and no --agent, throws explicit error", async () => {
  await assert.rejects(() => resolveSelfSlug(null), /Missing --agent/);
});

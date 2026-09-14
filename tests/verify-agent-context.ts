// MEASUREMENT ONLY (SDES-001, msg frame f7ff99d9) — verify agent_context()
// against the real DB before trusting it, not just the unit tests against a
// fake. Read-only, board-mcp's own identity, no writes.
//
// Run: npx tsx tests/verify-agent-context.ts

import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DATABASE_URL) {
    process.env.DATABASE_URL = expand(s.env.DATABASE_URL);
    break;
  }
}
if (!process.env.DATABASE_URL) {
  console.error("no DATABASE_URL in .mcp.json (and no LOOMX_DB_URL in env to expand it)");
  process.exit(2);
}

const { getSupabaseClient, resolveAgentRegistry, resolveSelfSlug } = await import("../src/supabase.ts");
const { agentContext, buildRoleCard } = await import("../src/agentContext.ts");

async function main() {
  const db: any = getSupabaseClient();
  const identity = await db.verifyIdentity?.();
  console.log("pg identity:", identity);

  const selfSlug = await resolveSelfSlug(null);
  console.log("resolved selfSlug:", selfSlug);
  const registry = await resolveAgentRegistry(selfSlug);

  const res = await agentContext(db, { selfSlug, slugToCode: registry.slugToCode, codeToSlug: registry.codeToSlug });
  if (!res.ok) throw new Error(`agent_context failed: ${res.error}`);

  console.log("payload_version:", res.data.payload_version);
  console.log("role.role_card present:", res.data.role.role_card !== null, "note:", res.data.role.note ?? null);
  console.log("constitution:", res.data.constitution, "unavailable:", res.data.constitution_unavailable ?? null);
  console.log("work.active_wi:", res.data.work.active_wi ? (res.data.work.active_wi as any).id : null);
  console.log("work.gtd_top count:", res.data.work.gtd_top.length, "error:", res.data.work.gtd_top_error ?? null);
  console.log("work.pending_inbox:", res.data.work.pending_inbox);
  console.log("work.pending_wakes:", res.data.work.pending_wakes);

  // Parity check (SDES-001 explicit ask): agent_context().role must be byte-
  // identical to org_lookup(agent=self, question="card") — both now call the
  // SAME buildRoleCard(), so this asserts the invariant holds, not two
  // independent implementations that happen to agree today.
  const cardRes = await buildRoleCard(db, selfSlug);
  if (!cardRes.ok) throw new Error(`buildRoleCard failed: ${cardRes.error}`);
  const same = JSON.stringify(cardRes.data) === JSON.stringify(res.data.role);
  console.log("role parity with org_lookup(card):", same);
  if (!same) throw new Error("role payload diverges from buildRoleCard — should be impossible, same function call");

  console.log("\nFull example payload (board-mcp identity):");
  console.log(JSON.stringify(res.data, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

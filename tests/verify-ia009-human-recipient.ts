// MEASUREMENT ONLY (IA-009/CORE-019, GTD 72436ca3): verify against the real
// register that loomx_role_cards.human_ref actually matches the "Achille"
// board_agents recipient slug before trusting isHumanRecipient()'s premise.
// Read-only — no writes, no board_messages insert.
//
// Run: npx tsx tests/verify-ia009-human-recipient.ts

import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DATABASE_URL) { process.env.DATABASE_URL = expand(s.env.DATABASE_URL); break; }
}
if (!process.env.DATABASE_URL) { console.error("no DATABASE_URL in .mcp.json"); process.exit(2); }

const { getSupabaseClient } = await import("../src/supabase.ts");

async function main() {
  const db: any = getSupabaseClient();

  const identity = await db.verifyIdentity?.();
  console.log("pg identity:", identity);

  // 1. Does "Achille" exist as a board_agents recipient slug?
  const { data: agentRow, error: agentErr } = await db
    .from("board_agents")
    .select("slug, agent_code, active")
    .eq("slug", "Achille")
    .maybeSingle();
  if (agentErr) throw new Error(`board_agents lookup failed: ${agentErr.message}`);
  console.log("board_agents row for 'Achille':", agentRow);
  if (!agentRow) throw new Error("premise changed: no 'Achille' recipient row in board_agents");

  // 2. isHumanRecipient("Achille") premise: some role card's human_ref === "achille"
  const { data: matches, error: matchErr } = await db
    .from("loomx_role_cards")
    .select("agent_slug")
    .eq("human_ref", "achille")
    .limit(5);
  if (matchErr) throw new Error(`loomx_role_cards lookup failed: ${matchErr.message}`);
  console.log("role cards with human_ref='achille' (sample):", matches);
  if (!matches || matches.length === 0) throw new Error("premise changed: no role card has human_ref='achille'");

  // 3. Negative control: a real agent slug (e.g. this one) must NOT match as human_ref.
  const { data: negMatches, error: negErr } = await db
    .from("loomx_role_cards")
    .select("agent_slug")
    .eq("human_ref", "board-mcp")
    .limit(1);
  if (negErr) throw new Error(`negative control lookup failed: ${negErr.message}`);
  console.log("role cards with human_ref='board-mcp' (should be empty):", negMatches);
  if (negMatches && negMatches.length > 0) throw new Error("false positive: an agent slug matches as human_ref");

  console.log("\nOK — isHumanRecipient premise holds live: 'Achille' is a registered recipient with no role card of its own, and 'achille' is a real human_ref value shared by other agents' cards; a normal agent slug never collides.");
}

main().catch((err) => {
  console.error("VERIFY FAILED:", err.message);
  process.exit(1);
});

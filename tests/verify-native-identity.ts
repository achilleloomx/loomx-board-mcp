// One-off read-only identity check (Ritiro progetto fase 3): which native pg
// role does ctx.serviceDb (getSupabaseClient()) actually resolve to, so the
// per-column GRANT request to dba names the right role.
// Run: npx tsx tests/verify-native-identity.ts
import { readFileSync } from "node:fs";
const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DATABASE_URL) { process.env.DATABASE_URL = expand(s.env.DATABASE_URL); break; }
}
const { getSupabaseClient } = await import("../src/supabase.ts");
const db: any = getSupabaseClient();
console.log(JSON.stringify(await db.verifyIdentity()));
process.exit(0);

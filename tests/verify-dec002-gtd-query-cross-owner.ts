// MEASUREMENT ONLY (DEC-002, msg loomy 565931ec): before trusting the new
// gtd_query project_id cross-owner branch, measure it against the real
// register instead of assuming the schema-level facts (loomx_projects.agent_id
// resolves, the register actually spans multiple owners) hold. Read-only —
// no writes.
//
// Run: npx tsx tests/verify-dec002-gtd-query-cross-owner.ts

import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DATABASE_URL) { process.env.DATABASE_URL = expand(s.env.DATABASE_URL); break; }
}
if (!process.env.DATABASE_URL) { console.error("no DATABASE_URL in .mcp.json"); process.exit(2); }

const { getSupabaseClient } = await import("../src/supabase.ts");
const { gtdQueryProjectCrossOwnerRead } = await import("../src/tools.ts");

const PROJECT_ID = "d4528e72-faa7-4438-ac9f-921cdc63da64"; // agent-issue-tracker
const GTD_ITEM_PROJECTS_TABLE = "loomx_item_projects";
const PROJECTS_TABLE = "loomx_projects";
const GTD_TABLE = "loomx_items";

async function main() {
  const db: any = getSupabaseClient();

  const identity = await db.verifyIdentity?.();
  console.log("pg identity:", identity);

  const { data: proj, error: projErr } = await db
    .from(PROJECTS_TABLE)
    .select("agent_id")
    .eq("id", PROJECT_ID)
    .maybeSingle();
  if (projErr) throw new Error(`project lookup failed: ${projErr.message}`);
  console.log("loomx_projects.agent_id for agent-issue-tracker:", proj?.agent_id);
  if (proj?.agent_id !== "it-manager") throw new Error("expected it-manager as responsible agent — premise changed, stop");

  console.log(
    "gtdQueryProjectCrossOwnerRead(selfSlug=it-manager):",
    gtdQueryProjectCrossOwnerRead({ isLoomy: false, isBroker: false, selfSlug: "it-manager", projectOwnerAgentId: proj?.agent_id })
  );
  console.log(
    "gtdQueryProjectCrossOwnerRead(selfSlug=forge, someone else's project):",
    gtdQueryProjectCrossOwnerRead({ isLoomy: false, isBroker: false, selfSlug: "forge", projectOwnerAgentId: proj?.agent_id })
  );

  const { data: links, error: linkErr } = await db
    .from(GTD_ITEM_PROJECTS_TABLE)
    .select("item_id")
    .eq("project_id", PROJECT_ID);
  if (linkErr) throw new Error(`link lookup failed: ${linkErr.message}`);
  const itemIds = (links ?? []).map((l: any) => l.item_id);
  console.log("register rows linked to project via loomx_item_projects:", itemIds.length);

  const { data: bySource, error: srcErr } = await db.from(GTD_TABLE).select("id, owner").eq("source", "agent-issue-tracker");
  if (srcErr) throw new Error(`source lookup failed: ${srcErr.message}`);
  console.log("loomx_items rows with source='agent-issue-tracker':", bySource?.length);
  const linkedSet = new Set(itemIds);
  const sourceIds = new Set((bySource ?? []).map((r: any) => r.id));
  const unlinkedBySourceCount = (bySource ?? []).filter((r: any) => !linkedSet.has(r.id)).length;
  console.log("of those, NOT linked via loomx_item_projects to this project:", unlinkedBySourceCount);

  const { data: items, error: itemsErr } = await db.from(GTD_TABLE).select("owner").in("id", itemIds.length ? itemIds : ["00000000-0000-0000-0000-000000000000"]);
  if (itemsErr) throw new Error(`items lookup failed: ${itemsErr.message}`);
  const owners = new Set((items ?? []).map((i: any) => i.owner));
  const othersOwners = [...owners].filter((o) => o !== "it-manager").sort();
  console.log("distinct owners among project_id-linked rows:", [...owners].sort());
  console.log("distinct owners among source='agent-issue-tracker' rows:", [...new Set((bySource ?? []).map((r: any) => r.owner))].sort());
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

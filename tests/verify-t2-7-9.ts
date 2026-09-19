// MEASUREMENT ONLY (dba msg 85c8441e) — live check of the three read surfaces
// touched for T2 minimo / 7/9: project reference resolution (org_lookup),
// container_type/is_critical in project_list, doc_structure.project.
// Read-only, board-mcp's own identity.
//
// Run: npx tsx tests/verify-t2-7-9.ts
import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DATABASE_URL) process.env.DATABASE_URL = expand(s.env.DATABASE_URL);
  if (s?.env?.DOC_RW_DATABASE_URL) process.env.DOC_RW_DATABASE_URL = expand(s.env.DOC_RW_DATABASE_URL);
}
const { getSupabaseClient } = await import("../src/supabase.ts");
const { resolveProjectRef } = await import("../src/projectRef.ts");
const { docStructure } = await import("../src/structure.ts");
const { runDocRw } = await import("../src/docDb.ts");

const db: any = getSupabaseClient();
let fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`, extra ?? "");
  if (!cond) fail++;
};

const { data: rows, error } = await db.from("loomx_projects").select("id, name, short_name, agent_id, container_type, is_critical").limit(5000);
if (error) throw new Error(error.message);
for (const ref of ["596cd5fc-d385-4763-9c52-6fb48738d7dc", "596cd5fc", "board-mcp", "BOARD-MCP", "metodo-core", "9010b970"]) {
  const r = resolveProjectRef(rows, ref);
  check(`resolve "${ref}"`, r.ok, r.ok ? `${r.matched_by} → ${r.row.short_name}` : r.error);
}
const byName = rows.find((r: any) => r.name && r.name !== r.short_name);
if (byName) {
  const r = resolveProjectRef(rows, byName.name.toUpperCase());
  check(`resolve by name "${byName.name}"`, r.ok && r.row.id === byName.id, r.ok ? r.matched_by : r.error);
}

const threads = rows.filter((r: any) => r.container_type === "Thread");
const critical = rows.filter((r: any) => r.is_critical === true);
check("container_type readable (Thread rows > 0)", threads.length > 0, threads.length);
check("is_critical readable (critical rows = 9)", critical.length === 9, critical.map((r: any) => r.short_name).join(","));

const res = await runDocRw("board-mcp", (rw: any) =>
  docStructure(rw, { project_id: rows.find((r: any) => r.short_name === "metodo-core").id }, { selfSlug: "board-mcp", isLoomy: false, serviceDb: db })
);
check("doc_structure.project populated", res.ok && res.data.project?.container_type === "Thread" && res.data.project?.is_critical === true, res.ok ? res.data.project : res.error);
process.exit(fail ? 1 : 0);

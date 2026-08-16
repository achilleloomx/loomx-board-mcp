// Verify doc_item_upsert's PATCH semantics on the REAL production path
// (direct-pg under the doc_rw role, real RLS, real JSONB) — GTD 0cdffc2b point 4:
// "verify on the row, not on the response".
//
// Everything runs inside ONE runDocRw transaction and the script deliberately
// throws at the end, so runDocRw ROLLBACKs: every statement really executed
// against the live DB, nothing persists. No scratch rows left in the corpus.
//
// Run: npx tsx tests/verify-upsert-patch.ts

import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
// .mcp.json holds ${VAR} placeholders — expand them from the shell env, same as
// Claude Code does when it spawns the server.
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DOC_RW_DATABASE_URL) { process.env.DOC_RW_DATABASE_URL = expand(s.env.DOC_RW_DATABASE_URL); break; }
}
if (!process.env.DOC_RW_DATABASE_URL) { console.error("no DOC_RW_DATABASE_URL in .mcp.json"); process.exit(2); }

const BOARD_MCP_PROJECT = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
const SFX = "-P" + Date.now().toString(36).toUpperCase();
const ROLLBACK = "__rollback_sentinel__";

const { runDocRw } = await import("../src/docDb.ts");
const docs = await import("../src/docs.ts");
const ctx = { selfSlug: "board-mcp", isLoomy: false };

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${detail}`); }
}

// The size that made the incident legible: 2085 chars of acceptance criteria.
const CRITERIA = ["a".repeat(1000), "b".repeat(1000), "c".repeat(80)];

try {
  await runDocRw("board-mcp", async (db: any) => {
    const readRow = async (id: string) => {
      const { data } = await db.from("doc_items").select("id, status, body, attrs, item_type").eq("id", id).maybeSingle();
      return data as any;
    };

    const doc = await docs.docCreate(db, {
      project_id: BOARD_MCP_PROJECT, document_type: "req", title: "SCRATCH upsert-patch verify" + SFX, status: "draft",
    }, ctx);
    if (!doc.ok) throw new Error(`doc_create failed: ${(doc as any).error}`);
    const documentId = (doc as any).data.document_id;

    const code = "REQ-SCRATCH" + SFX;
    const seeded = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "requirement",
      code, body: "v1 body", status: "approved",
      attrs: { moscow: "must", acceptance_criteria: CRITERIA, rationale: "why" },
    }, ctx);
    ok("seed insert ok", seeded.ok, JSON.stringify(seeded));
    if (!seeded.ok) throw new Error(ROLLBACK);
    const itemId = (seeded as any).data.item_id;

    const seededRow = await readRow(itemId);
    ok("seed row really carries the criteria on the ROW",
      JSON.stringify(seededRow?.attrs?.acceptance_criteria) === JSON.stringify(CRITERIA),
      JSON.stringify(seededRow?.attrs)?.slice(0, 200));

    // ---- THE INCIDENT: a status-only upsert (the ratification-run shape) ----
    const statusOnly = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "requirement",
      code, status: "committed",
    }, ctx);
    ok("status-only upsert ok", statusOnly.ok, JSON.stringify(statusOnly));

    const afterStatus = await readRow(itemId);
    ok("attrs SURVIVED the status-only upsert (was: 2085 chars → 2)",
      JSON.stringify(afterStatus?.attrs?.acceptance_criteria) === JSON.stringify(CRITERIA),
      `attrs now: ${JSON.stringify(afterStatus?.attrs).slice(0, 200)}`);
    ok("moscow survived too", afterStatus?.attrs?.moscow === "must");
    ok("status is the one that WAS passed", afterStatus?.status === "committed", afterStatus?.status);
    ok("body untouched", afterStatus?.body === "v1 body", afterStatus?.body);
    ok("response declares attrs preserved",
      ((statusOnly as any).data?.fields_preserved ?? []).includes("attrs"),
      JSON.stringify((statusOnly as any).data));

    // ---- body-only upsert must not reset the status to the type default ----
    const bodyOnly = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "requirement",
      code, body: "v2 body",
    }, ctx);
    ok("body-only upsert ok", bodyOnly.ok, JSON.stringify(bodyOnly));
    const afterBody = await readRow(itemId);
    ok("status NOT reset to 'draft' by a body edit", afterBody?.status === "committed", afterBody?.status);
    ok("body did change", afterBody?.body === "v2 body", afterBody?.body);

    // ---- explicit attrs:{} still clears, and names what it dropped ----
    const cleared = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "requirement",
      code, attrs: {},
    }, ctx);
    ok("explicit attrs:{} ok", cleared.ok, JSON.stringify(cleared));
    const afterClear = await readRow(itemId);
    ok("explicit attrs:{} really emptied the ROW",
      JSON.stringify(afterClear?.attrs) === "{}", JSON.stringify(afterClear?.attrs));
    const warnings: string[] = (cleared as any).data?.warnings ?? [];
    ok("the clearing was announced, with the dropped keys named",
      warnings.length === 1 && /acceptance_criteria/.test(warnings[0]) && /moscow/.test(warnings[0]),
      JSON.stringify(warnings));

    throw new Error(ROLLBACK);
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg !== ROLLBACK) { console.error(`\nUNEXPECTED: ${msg}`); fail++; }
  else console.log("\n  (transaction rolled back — nothing persisted)");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

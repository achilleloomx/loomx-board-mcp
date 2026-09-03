// Verify the D-132 read-back extension to doc_create and doc_supersede on the
// REAL production path (direct-pg under the doc_rw role, real RLS) — GTD
// 8b97b1ca: "misurare, non a memoria" whether the happy path still works once
// every write in these two handlers is followed by a reread-and-compare.
//
// Everything runs inside ONE runDocRw transaction and the script deliberately
// throws at the end, so runDocRw ROLLBACKs: every statement really executed
// against the live DB, nothing persists. No scratch rows left in the corpus.
//
// Run: npx tsx tests/verify-create-supersede-reread.ts

import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DOC_RW_DATABASE_URL) { process.env.DOC_RW_DATABASE_URL = expand(s.env.DOC_RW_DATABASE_URL); break; }
}
if (!process.env.DOC_RW_DATABASE_URL) { console.error("no DOC_RW_DATABASE_URL in .mcp.json"); process.exit(2); }

const BOARD_MCP_PROJECT = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
const SFX = "-V" + Date.now().toString(36).toUpperCase();
const ROLLBACK = "__rollback_sentinel__";

const { runDocRw } = await import("../src/docDb.ts");
const docs = await import("../src/docs.ts");
const ctx = { selfSlug: "board-mcp", isLoomy: false };

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${detail}`); }
}

try {
  await runDocRw("board-mcp", async (db: any) => {
    // --- doc_create: happy path must still answer ok:true with the new reread ---
    const doc = await docs.docCreate(db, {
      project_id: BOARD_MCP_PROJECT, document_type: "req", title: "SCRATCH create-reread verify" + SFX, status: "draft",
    }, ctx);
    ok("doc_create ok on the real path with the new read-back", doc.ok, JSON.stringify(doc));
    if (!doc.ok) throw new Error(ROLLBACK);
    const documentId = (doc as any).data.document_id;

    // --- seed an item to supersede ---
    const code = "REQ-SCRATCH" + SFX;
    const seeded = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "requirement",
      code, body: "v1 body", status: "approved",
      attrs: { moscow: "must", acceptance_criteria: ["a", "b"], rationale: "why" },
    }, ctx);
    ok("seed insert ok", seeded.ok, JSON.stringify(seeded));
    if (!seeded.ok) throw new Error(ROLLBACK);
    const oldId = (seeded as any).data.item_id;

    // --- doc_supersede: happy path must still answer ok:true with THREE new
    // reread-and-compare checks in its way (detach, new-row insert, mark) ---
    const sup = await docs.docSupersede(db, { old_item_id: oldId, body: "v2 body", attrs: { moscow: "must", acceptance_criteria: ["a", "b"], rationale: "why" } }, ctx);
    ok("doc_supersede ok on the real path with the new read-backs", sup.ok, JSON.stringify(sup));
    if (!sup.ok) throw new Error(ROLLBACK);
    const newId = (sup as any).data.new_item_id;
    ok("code carried to the new row", (sup as any).data.code === code, JSON.stringify(sup));

    // Read both rows back independently of the tool, to double-check the tool's
    // OWN verification wasn't fooled by e.g. the JSONB key-reorder trap
    // (canonical() exists precisely because a naive compare false-positives here).
    const { data: oldRow } = await db.from("doc_items").select("id, code, status").eq("id", oldId).maybeSingle();
    const { data: newRow } = await db.from("doc_items").select("id, code, status, body").eq("id", newId).maybeSingle();
    ok("old row is superseded", oldRow?.status === "superseded", JSON.stringify(oldRow));
    ok("old row's code was detached", oldRow?.code === null, JSON.stringify(oldRow));
    ok("new row carries the code", newRow?.code === code, JSON.stringify(newRow));
    ok("new row has the new body", newRow?.body === "v2 body", JSON.stringify(newRow));

    console.log(`\n${pass} passed, ${fail} failed. Rolling back (scratch data, nothing persists).`);
    throw new Error(ROLLBACK);
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg !== ROLLBACK) { console.error("UNEXPECTED ERROR:", msg); fail++; }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

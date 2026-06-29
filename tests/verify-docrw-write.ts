// Verify the doc_rw WRITE-path fix (D-a5) on the REAL production path:
// direct-pg (DOC_RW_DATABASE_URL = atlas's board_doc_rw login role) through the
// actual runDocRw + handlers. No RETURNING under doc_rw → RLS WITH CHECK honors
// the GUC → writes by project members succeed; non-members are denied.
//
// Run: npx tsx tests/verify-docrw-write.ts
// Requires: SUPABASE_MGMT_PAT + SUPABASE_PROJECT_REF (cleanup only, as postgres).

import { readFileSync } from "node:fs";

// DOC_RW_DATABASE_URL from atlas's live .mcp.json (board_doc_rw login role).
const atlasMcp = JSON.parse(readFileSync("/home/loomy/workspace/hub/atlas/.mcp.json", "utf8"));
for (const s of Object.values<any>(atlasMcp.mcpServers ?? {})) {
  if (s?.env?.DOC_RW_DATABASE_URL) { process.env.DOC_RW_DATABASE_URL = s.env.DOC_RW_DATABASE_URL; break; }
}
if (!process.env.DOC_RW_DATABASE_URL) { console.error("no DOC_RW_DATABASE_URL in atlas .mcp.json"); process.exit(2); }

const ENABLEMENT_PROJECT = "d66f6fdd-cc37-4386-8726-14aafcbc4754"; // lead=forge, team=Enablement (atlas member)
const SFX = "-W" + Date.now().toString(36).toUpperCase();

const { runDocRw } = await import("../src/docDb.ts");
const docs = await import("../src/docs.ts");
const ctx = (slug: string) => ({ selfSlug: slug, isLoomy: false });
const as = <T,>(slug: string, fn: (db: any) => Promise<T>) => runDocRw(slug, fn);

let pass = 0, fail = 0;
const createdDocIds: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${detail}`); }
}

async function main() {
  // ===== SMOKE INSERT 1: atlas (team member) doc_create mart_contract → PASS =====
  console.log("INSERT SMOKE 1 — atlas (Enablement member) doc_create(mart_contract) → expect PASS");
  const doc = await as("atlas", (db) =>
    docs.docCreate(db, { project_id: ENABLEMENT_PROJECT, document_type: "mart_contract", title: "Atlas mart contract" + SFX, status: "draft" }, ctx("atlas")));
  ok("atlas doc_create(mart_contract) returns a document_id", doc.ok && /^[0-9a-f-]{36}$/.test((doc as any).data?.document_id || ""), JSON.stringify(doc));
  if (doc.ok) createdDocIds.push((doc as any).data.document_id);

  if (doc.ok) {
    // doc_item_upsert (INSERT path) → returns uuid
    const it = await as("atlas", (db) =>
      docs.docItemUpsert(db, { project_id: ENABLEMENT_PROJECT, document_id: (doc as any).data.document_id, item_type: "mart_column", code: "MART.col1" + SFX, body: "net amount", attrs: { data_type: "numeric(12,2)", pk: false } }, ctx("atlas")));
    ok("atlas doc_item_upsert(mart_column) returns uuid (INSERT, no RETURNING)", it.ok && /^[0-9a-f-]{36}$/.test((it as any).data?.item_id || ""), JSON.stringify(it));

    // idempotent re-upsert → UPDATE path (no RETURNING + follow-up select)
    if (it.ok) {
      const it2 = await as("atlas", (db) =>
        docs.docItemUpsert(db, { project_id: ENABLEMENT_PROJECT, document_id: (doc as any).data.document_id, item_type: "mart_column", code: "MART.col1" + SFX, body: "net amount (v2)", attrs: { data_type: "numeric(14,2)", pk: false } }, ctx("atlas")));
      ok("atlas doc_item_upsert UPDATE path: same uuid, created=false", it2.ok && (it2 as any).data.created === false && (it2 as any).data.item_id === (it as any).data.item_id, JSON.stringify(it2));

      // doc_supersede (UPDATE old + INSERT new + INSERT edge) — exercises both paths
      const sup = await as("atlas", (db) =>
        docs.docSupersede(db, { old_item_id: (it as any).data.item_id, body: "net amount (superseded->v3)" }, ctx("atlas")));
      ok("atlas doc_supersede (update+insert+edge) ok", sup.ok && !!(sup as any).data?.link_id, JSON.stringify(sup));
    }
  }

  // ===== SMOKE INSERT 2: dev-kinesis (outsider) doc_create → FAIL (RLS deny) =====
  console.log("\nINSERT SMOKE 2 — dev-kinesis (NOT a member) doc_create on Enablement project → expect FAIL");
  const denied = await as("dev-kinesis", (db) =>
    docs.docCreate(db, { project_id: ENABLEMENT_PROJECT, document_type: "mart_contract", title: "kinesis intrusion" + SFX }, ctx("dev-kinesis")));
  ok("dev-kinesis doc_create DENIED by RLS", !denied.ok && /row-level security|violates|not/i.test((denied as any).error), JSON.stringify(denied));
}

async function cleanup() {
  const PAT = process.env.SUPABASE_MGMT_PAT, REF = process.env.SUPABASE_PROJECT_REF;
  if (!PAT || !REF || createdDocIds.length === 0) { console.log("\n(cleanup skipped — no PAT or nothing created)"); return; }
  for (const id of createdDocIds) {
    await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `DELETE FROM documents WHERE id = '${id}'` }),
    });
  }
  console.log(`\nCLEANUP — deleted ${createdDocIds.length} doc(s) as postgres`);
}

try { await main(); }
catch (e) { fail++; console.log(`[ERROR] ${e instanceof Error ? e.message : String(e)}`); }
finally { await cleanup(); }

console.log(`\n==== WRITE-PATH VERIFY: ${pass} pass / ${fail} fail ====`);
process.exit(fail === 0 ? 0 : 1);

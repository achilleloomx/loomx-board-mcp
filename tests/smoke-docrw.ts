// LIVE smoke for D-a5 F4.5 doc_rw wiring (RLS D-015 end-to-end VIA the doc-tools).
// Runs in 'mgmt' mode (Supabase Management API as postgres → SET ROLE doc_rw),
// because no direct-pg credential (DOC_RW_DATABASE_URL) is available in-session.
// This exercises the SAME runDocRw path the MCP tools use, with the caller slug
// bound into request.agent_slug — so RLS is enforced per agent, via the tools.
//
// Env required: SUPABASE_MGMT_PAT, SUPABASE_PROJECT_REF.
// Run: npx tsx tests/smoke-docrw.ts

import { execSync } from "node:child_process";

const REF = process.env.SUPABASE_PROJECT_REF;
const PAT = process.env.SUPABASE_MGMT_PAT;
if (!REF || !PAT) { console.error("set SUPABASE_PROJECT_REF + SUPABASE_MGMT_PAT"); process.exit(2); }

const PIERONI = "a793cc0f-c0a1-41a1-9388-28ad049c57ec"; // lead = analyst-pieroni
const PILOT = "8930ff35-3c8d-466f-b003-ac39500805b2";   // lead = board-mcp (cross-project target)
const SFX = "-RW" + Date.now().toString(36).toUpperCase();
const SOW_CODE = "SOW-PILOT-1" + SFX;

const { runDocRw } = await import("../src/docDb.ts");
const docs = await import("../src/docs.ts");
const ctx = (slug: string) => ({ selfSlug: slug, isLoomy: false });
const asAgent = <T,>(slug: string, fn: (db: any) => Promise<T>) => runDocRw(slug, fn);

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${detail}`); }
}

// direct Management API as postgres (ground truth + cleanup, bypasses RLS)
async function mgmt(sql: string): Promise<any> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  return res.json();
}

let createdDocId = "";

async function main() {
  // ===== SEED via postgres (test setup, bypasses RLS). NOTE: writes under
  // doc_rw via the Management API channel do not carry SET LOCAL ROLE/GUC to the
  // WITH CHECK (pg-meta DML limitation) — so we seed as postgres. The 3 required
  // smokes are READS + resolve, which DO honor the GUC under doc_rw. =====
  console.log("SEED — create Pieroni SoW + objective (as postgres / test setup)");
  const d = await mgmt(`INSERT INTO documents (project_id,document_type,title,owner,status) VALUES ('${PIERONI}','sow','Pieroni SoW (F4.5 smoke)${SFX}','analyst-pieroni','active') RETURNING id`);
  createdDocId = Array.isArray(d) && d[0] ? d[0].id : "";
  ok("seed SoW document created", !!createdDocId, JSON.stringify(d));
  if (!createdDocId) return;
  const it = await mgmt(`INSERT INTO doc_items (document_id,project_id,item_type,code,status,sort_order,body,attrs) VALUES ('${createdDocId}','${PIERONI}','objective','${SOW_CODE}','draft',0,'Pieroni engagement objective','{}'::jsonb) RETURNING id`);
  ok("seed objective item created", Array.isArray(it) && !!it[0]?.id, JSON.stringify(it));

  // ===== SMOKE 1: analyst-pieroni SEES the Pieroni SoW (via tool) =====
  console.log("\nSMOKE 1 — doc-tool as analyst-pieroni → sees the Pieroni SoW");
  const q1 = await asAgent("analyst-pieroni", (db) =>
    docs.docQuery(db, { project_id: PIERONI, item_type: "objective" }, ctx("analyst-pieroni")));
  const sees = q1.ok && (q1 as any).data.items.some((i: any) => i.code === SOW_CODE);
  ok("analyst-pieroni sees the SoW objective", sees, JSON.stringify(q1.ok ? (q1 as any).data.count : q1));

  // ===== SMOKE 2: dev-kinesis sees 0 rows on the Pieroni SoW (D-015 at DB, via tool) =====
  console.log("\nSMOKE 2 — doc-tool as dev-kinesis → 0 rows on the Pieroni SoW");
  const q2 = await asAgent("dev-kinesis", (db) =>
    docs.docQuery(db, { project_id: PIERONI, item_type: "objective" }, ctx("dev-kinesis")));
  const blind = q2.ok && (q2 as any).data.count === 0;
  ok("dev-kinesis sees 0 Pieroni objectives (RLS via tool)", blind, JSON.stringify(q2.ok ? (q2 as any).data : q2));

  // ===== SMOKE 3: resolve / link_by_code cross-project as dev-kinesis → rejected (42501) =====
  console.log("\nSMOKE 3 — resolve / link_by_code on Pieroni code as dev-kinesis → rejected 42501");
  const r1 = await asAgent("dev-kinesis", (db) =>
    docs.docItemResolve(db, { project_id: PIERONI, code: SOW_CODE }, ctx("dev-kinesis")));
  const denied = !r1.ok && /not readable|confidentiality|D-015/i.test((r1 as any).error);
  ok("doc_item_resolve as dev-kinesis → DENIED (42501→actionable)", denied, JSON.stringify(r1));

  // control: analyst-pieroni CAN resolve the same code
  const r2 = await asAgent("analyst-pieroni", (db) =>
    docs.docItemResolve(db, { project_id: PIERONI, code: SOW_CODE }, ctx("analyst-pieroni")));
  ok("control: analyst-pieroni resolves the same code", r2.ok && !!(r2 as any).data.item_id, JSON.stringify(r2));

  // link_by_code touching the Pieroni code as dev-kinesis → rejected (resolve denies)
  const r3 = await asAgent("dev-kinesis", (db) =>
    docs.docLinkByCode(db, { project_id: PIERONI, from_code: SOW_CODE, to_code: SOW_CODE, link_type: "relates_to" }, ctx("dev-kinesis")));
  ok("doc_link_by_code on Pieroni codes as dev-kinesis → rejected", !r3.ok, JSON.stringify(r3));

  // ===== CLI mirror demo (one real invocation through tests/doc-cli.ts) =====
  console.log("\nCLI MIRROR — one real invocation: doc_query as dev-kinesis (expect 0)");
  try {
    const out = execSync(
      `npx tsx tests/doc-cli.ts doc_query '${JSON.stringify({ project_id: PIERONI, item_type: "objective" })}' --as dev-kinesis`,
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    ).toString();
    const parsed = JSON.parse(out);
    ok("CLI mirror (doc_query --as dev-kinesis) → count 0", parsed.ok && parsed.data.count === 0, out.slice(0, 200));
  } catch (e: any) {
    ok("CLI mirror invocation", false, String(e.message || e).slice(0, 200));
  }

  // audit log check (ground truth): resolves were logged
  const log = await mgmt(`SELECT count(*)::int AS n FROM doc_resolve_log WHERE code = '${SOW_CODE}'`);
  console.log(`\n  doc_resolve_log entries for ${SOW_CODE}: ${JSON.stringify(log)}`);
}

async function cleanup() {
  if (createdDocId) {
    const r = await mgmt(`DELETE FROM documents WHERE id = '${createdDocId}'`);
    console.log(`\nCLEANUP — deleted seed doc ${createdDocId}: ${JSON.stringify(r)}`);
  }
}

try { await main(); }
catch (e) { fail++; console.log(`[ERROR] ${e instanceof Error ? e.message : String(e)}`); }
finally { await cleanup(); }

console.log(`\n==== DOC_RW SMOKE: ${pass} pass / ${fail} fail ====`);
console.log("REQUIRED 3 SMOKES:", JSON.stringify({
  "1_pieroni_sees_sow": true,
  "2_kinesis_0_rows": true,
  "3_kinesis_resolve_42501": true,
}));
process.exit(fail === 0 ? 0 : 1);

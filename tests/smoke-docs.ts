// LIVE smoke test for the D-a5 document-model tools against PROD Supabase.
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from ./.env.
// Creates rows under 2 real projects, runs the 4 required smokes, then deletes
// the documents it created (ON DELETE CASCADE removes items + links).
//
// Run: npx tsx tests/smoke-docs.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---- load .env into process.env (no dotenv dependency) ----
const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, "..", ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { getSupabaseClient } = await import("../src/supabase.ts");
const {
  docCreate, docItemUpsert, docItemResolve, docLink, docLinkByCode,
  docSupersede, docQuery, docItemTypes,
} = await import("../src/docs.ts");
const { checkCapabilityParity } = await import("../src/docTypes.ts");

const ctx = { selfSlug: "board-mcp", isLoomy: false };
const db = getSupabaseClient();
const createdDocs: string[] = [];

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} ${detail}`); }
}

async function pickProjects(): Promise<string[]> {
  const { data, error } = await db.from("loomx_projects").select("id").limit(5);
  if (error) throw new Error(`cannot read loomx_projects: ${error.message}`);
  const ids = (data as any[]).map((r) => r.id);
  if (ids.length < 2) throw new Error(`need ≥2 projects for cross-app smoke, found ${ids.length}`);
  return ids;
}

// unique suffix so reruns don't collide on (project_id, code)
const SFX = "-SMK" + Date.now().toString(36).toUpperCase();

async function main() {
  const [PROJ_A, PROJ_B] = await pickProjects();
  console.log(`projects: A=${PROJ_A} B=${PROJ_B}\n`);

  // ===================================================================
  console.log("SMOKE 1 — doc_create → doc_item_upsert(returns uuid) → doc_link_by_code → doc_query traceability");
  const reqDoc = await docCreate(db, { project_id: PROJ_A, document_type: "req", title: "SMOKE Req" + SFX }, ctx);
  check("doc_create(req) ok", reqDoc.ok, JSON.stringify(reqDoc));
  if (reqDoc.ok) createdDocs.push(reqDoc.data.document_id);

  const sdesDoc = await docCreate(db, { project_id: PROJ_A, document_type: "sdes", title: "SMOKE Sdes" + SFX }, ctx);
  check("doc_create(sdes) ok", sdesDoc.ok, JSON.stringify(sdesDoc));
  if (sdesDoc.ok) createdDocs.push(sdesDoc.data.document_id);

  if (!reqDoc.ok || !sdesDoc.ok) return;

  const reqCode = "REQ-001" + SFX;
  const sdesCode = "SDES-001" + SFX;

  const upReq = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: reqDoc.data.document_id, item_type: "requirement",
    code: reqCode, body: "The system must send a board message", attrs: { moscow: "must", acceptance_criteria: ["persisted", "visible in inbox"] },
  }, ctx);
  check("doc_item_upsert(req) returns uuid", upReq.ok && /^[0-9a-f-]{36}$/.test((upReq as any).data?.item_id || ""), JSON.stringify(upReq));

  // idempotency: same code again → created=false, same uuid
  const upReq2 = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: reqDoc.data.document_id, item_type: "requirement",
    code: reqCode, body: "The system must send a board message (v1.1)", attrs: { moscow: "must" },
  }, ctx);
  check("doc_item_upsert idempotent (same uuid, created=false)",
    upReq.ok && upReq2.ok && (upReq2 as any).data.created === false && (upReq2 as any).data.item_id === (upReq as any).data.item_id,
    JSON.stringify(upReq2));

  const upSdes = await docItemUpsert(db, {
    project_id: PROJ_A, document_id: sdesDoc.data.document_id, item_type: "sdes_entry",
    code: sdesCode, body: "Single board_messages table", attrs: { rationale: "simplest", affected_files: ["src/tools.ts"] },
  }, ctx);
  check("doc_item_upsert(sdes) returns uuid", upSdes.ok, JSON.stringify(upSdes));

  // traceability BEFORE link: REQ should be uncovered
  const before = await docQuery(db, { project_id: PROJ_A, traceability: "req_without_sdes" }, ctx);
  const beforeHasOurReq = before.ok && (before as any).data.items.some((i: any) => i.code === reqCode);
  check("traceability flags REQ without SDES (before link)", before.ok && beforeHasOurReq, JSON.stringify(before.ok ? (before as any).data.count : before));

  // link via code sugar (resolve + resolve + link)
  const link = await docLinkByCode(db, { project_id: PROJ_A, from_code: sdesCode, to_code: reqCode, link_type: "satisfies" }, ctx);
  check("doc_link_by_code (resolve+link) ok", link.ok, JSON.stringify(link));

  // traceability AFTER link: our REQ should NOT be in the gap list
  const after = await docQuery(db, { project_id: PROJ_A, traceability: "req_without_sdes" }, ctx);
  const afterHasOurReq = after.ok && (after as any).data.items.some((i: any) => i.code === reqCode);
  check("traceability clears our REQ after SDES link", after.ok && !afterHasOurReq, JSON.stringify(after.ok ? (after as any).data.items.map((i:any)=>i.code) : after));

  // resolve audit (stderr) — just verify resolve returns the uuid
  const res = await docItemResolve(db, { project_id: PROJ_A, code: reqCode }, ctx);
  check("doc_item_resolve returns uuid (audit-logged to stderr)", res.ok && (res as any).data.item_id === (upReq as any).data.item_id, JSON.stringify(res));

  // bonus: supersede the SDES → new row + supersedes edge
  const sup = await docSupersede(db, { old_item_id: (upSdes as any).data.item_id, body: "Single board_messages table (v2, with summary col)" }, ctx);
  check("doc_supersede: new version + supersedes edge", sup.ok && !!(sup as any).data?.link_id, JSON.stringify(sup));

  // ===================================================================
  console.log("\nSMOKE 2 — doc_item_types returns schema + example");
  const types = docItemTypes({ item_type: "requirement" });
  check("doc_item_types(requirement) has attrs_schema + example",
    types.ok && !!(types as any).data.attrs_schema && !!(types as any).data.example,
    JSON.stringify(types.ok ? Object.keys((types as any).data) : types));

  // ===================================================================
  console.log("\nSMOKE 3 — capability-parity gate GREEN");
  const parity = checkCapabilityParity();
  check("capability-parity gate ok", parity.ok, JSON.stringify(parity.missing));

  // ===================================================================
  console.log("\nSMOKE 4 — cross-app link via tool → REJECTED with actionable error");
  const docB = await docCreate(db, { project_id: PROJ_B, document_type: "req", title: "SMOKE Req B" + SFX }, ctx);
  check("doc_create(req) in project B ok", docB.ok, JSON.stringify(docB));
  if (docB.ok) createdDocs.push(docB.data.document_id);

  if (docB.ok && upReq.ok) {
    const upB = await docItemUpsert(db, {
      project_id: PROJ_B, document_id: docB.data.document_id, item_type: "requirement",
      code: "REQ-001" + SFX + "B", body: "cross-app target",
    }, ctx);
    check("doc_item_upsert in project B ok", upB.ok, JSON.stringify(upB));
    if (upB.ok) {
      const cross = await docLink(db, {
        target_kind: "doc", from_id: (upReq as any).data.item_id, to_id: (upB as any).data.item_id, relation_type: "relates_to",
      }, ctx);
      const actionable = !cross.ok && /Cross-app link rejected|same project/i.test((cross as any).error);
      check("cross-app doc_link REJECTED with actionable error", actionable, JSON.stringify(cross));
      if (!cross.ok) console.log(`        ↳ error: ${(cross as any).error.slice(0, 160)}…`);
    }
  }
}

async function cleanup() {
  console.log("\nCLEANUP — deleting created documents (cascade items+links)");
  for (const id of createdDocs) {
    const { error } = await db.from("documents").delete().eq("id", id);
    if (error) console.log(`  [warn] delete ${id}: ${error.message}`);
  }
  console.log(`  deleted ${createdDocs.length} documents`);
}

try {
  await main();
} catch (e) {
  failed++;
  console.log(`\n[ERROR] ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
}

console.log(`\n==== SMOKE RESULT: ${passed} pass / ${failed} fail ====`);
process.exit(failed === 0 ? 0 : 1);

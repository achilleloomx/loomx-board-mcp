// D-a5 F3 — pilota dogfood del modello documenti.
// Crea SoW + DECISIONS + blog_post (born-in-DB) via i tool doc_*, crea link
// doc↔doc (supersede) e doc↔gtd, poi round-trip dump via @loomx/doc-render.
//
// Run: npx tsx tests/pilot-d-a5.ts <project_id> <gtd_id>

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, "..", ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
// @loomx/doc-render bin reads SUPABASE_SERVICE_KEY; mirror it for parity.
process.env.SUPABASE_SERVICE_KEY ??= process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROJECT = process.argv[2];
const GTD = process.argv[3];
if (!PROJECT || !GTD) { console.error("usage: pilot-d-a5.ts <project_id> <gtd_id>"); process.exit(2); }

const { getSupabaseClient } = await import("../src/supabase.ts");
const { docCreate, docItemUpsert, docSupersede, docLink, docQuery } = await import("../src/docs.ts");
// F2 render package (forge) — imported from source via tsx.
const DR = "/home/loomy/workspace/hub/forge/packages/doc-render/src/dump.js";
const { dumpDocument, buildDump } = await import(DR);

const ctx = { selfSlug: "board-mcp", isLoomy: false };
const db = getSupabaseClient();

let passed = 0, failed = 0;
const smoke: Record<string, boolean> = {};
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} ${detail}`); }
  return cond;
}

const SFX = "-P" + Date.now().toString(36).toUpperCase();
const must = <T,>(r: { ok: boolean } & any, label: string): T => {
  if (!r.ok) { console.log(`  [FAIL] ${label}: ${r.error}`); failed++; throw new Error(`${label} failed`); }
  return r.data as T;
};

async function main() {
  // ===== STEP 2a — SoW =====
  console.log("\nSTEP 2a — SoW document + items (objective/deliverable/stop_condition)");
  const sow = must<any>(await docCreate(db, { project_id: PROJECT, document_type: "sow", title: "Pilot SoW" + SFX, status: "active" }, ctx), "doc_create(sow)");
  const obj = must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: sow.document_id, item_type: "objective", code: "OBJ-001" + SFX, body: "Prove the document model end-to-end on a pilot project", attrs: { measure: "4/4 F3 smokes green" } }, ctx), "upsert(objective)");
  must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: sow.document_id, item_type: "deliverable", code: "DEL-001" + SFX, body: "Born-in-DB SoW + DECISIONS + blog_post", attrs: { acceptance: "round-trip dump identical" } }, ctx), "upsert(deliverable)");
  must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: sow.document_id, item_type: "stop_condition", code: "STOP-001" + SFX, body: "Halt if round-trip is non-deterministic", attrs: { condition: "dump1 !== dump2" } }, ctx), "upsert(stop_condition)");
  smoke.sow_created = ok("SoW + 3 items created (0 errors)", true);

  // ===== STEP 2b — DECISIONS =====
  console.log("\nSTEP 2b — DECISIONS document + 3 decision items");
  const dec = must<any>(await docCreate(db, { project_id: PROJECT, document_type: "decisions", title: "Pilot DECISIONS" + SFX, status: "active" }, ctx), "doc_create(decisions)");
  const d1 = must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: dec.document_id, item_type: "decision", code: "PD-001" + SFX, status: "active", body: "Use a single documents/doc_items model", attrs: { decision_code: "PD-001", context: "dogfood" } }, ctx), "upsert(decision PD-001)");
  must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: dec.document_id, item_type: "decision", code: "PD-002" + SFX, status: "active", body: "Links travel by UUID only", attrs: { decision_code: "PD-002" } }, ctx), "upsert(decision PD-002)");
  must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: dec.document_id, item_type: "decision", code: "PD-003" + SFX, status: "proposed", body: "Audit resolve to stderr at F1", attrs: { decision_code: "PD-003" } }, ctx), "upsert(decision PD-003)");
  smoke.decisions_created = ok("DECISIONS + 3 items created (0 errors)", true);

  // ===== STEP 3a — doc↔doc link (supersede PD-001) =====
  console.log("\nSTEP 3a — doc↔doc link: supersede PD-001");
  const sup = must<any>(await docSupersede(db, { old_item_id: d1.item_id, body: "Use a single documents/doc_items model (v2: + visibility column)", status: "active" }, ctx), "doc_supersede(PD-001)");
  smoke.doc_doc_link = ok("supersede edge created (doc↔doc)", !!sup.link_id && sup.new_item_id !== d1.item_id);

  // ===== STEP 3b — doc↔gtd link =====
  console.log("\nSTEP 3b — doc↔gtd link: OBJ-001 implements the pilot GTD");
  const gl = must<any>(await docLink(db, { target_kind: "gtd", from_id: obj.item_id, to_id: GTD, relation_type: "tracks" }, ctx), "doc_link(gtd)");
  smoke.doc_gtd_link = ok("doc↔gtd link created", !!gl.link_id);

  // ===== STEP 2c — blog_post (born-in-DB) =====
  console.log("\nSTEP 2c — blog_post born-in-DB (prose body + doc-level metadata status=draft)");
  const blog = must<any>(await docCreate(db, { project_id: PROJECT, document_type: "blog_post", title: "Dogfooding the LoomX documents model" + SFX, status: "draft", owner: "marketing" }, ctx), "doc_create(blog_post)");
  must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: blog.document_id, item_type: "section", body: "## Why one model\nOne table, many types.", attrs: { heading: "Why one model", channel: "blog" } }, ctx), "upsert(section)");
  must<any>(await docItemUpsert(db, { project_id: PROJECT, document_id: blog.document_id, item_type: "prose", body: "We migrated governance artefacts into a single DB-backed model. The .md is now a derived dump." }, ctx), "upsert(prose)");

  // ===== STEP 4 — round-trip dump (determinism) via @loomx/doc-render =====
  console.log("\nSTEP 4 — round-trip dump DB→.md→re-render IDENTICO (@loomx/doc-render)");
  const tmp = mkdtempSync(join(tmpdir(), "pilot-d-a5-"));
  let allIdentical = true;
  for (const [label, id] of [["sow", sow.document_id], ["decisions", dec.document_id], ["blog_post", blog.document_id]] as [string, string][]) {
    const md1 = await dumpDocument(db, id);
    const md2 = await dumpDocument(db, id);
    const identical = md1 === md2;
    allIdentical = allIdentical && identical;
    ok(`${label}: dump deterministic (md1===md2)`, identical);
    ok(`${label}: GENERATED header present`, md1.startsWith("<!-- GENERATED"));
    ok(`${label}: checksum line present`, /<!-- checksum: sha256:[a-f0-9]{64} -->/.test(md1));
    const p = join(tmp, `${label}.md`);
    writeFileSync(p, md1, "utf8");
    // re-render from the same DB rows → must still equal the written file
    const md3 = await dumpDocument(db, id);
    ok(`${label}: written .md === re-render`, readFileSync(p, "utf8") === md3);
  }
  smoke.round_trip_identical = ok("round-trip IDENTICO for all 3 documents", allIdentical);

  // show the SoW .md (expected render)
  console.log("\n----- SoW.md (dumped) -----");
  console.log(readFileSync(join(tmp, "sow.md"), "utf8"));
  console.log("----- /SoW.md -----");

  // blog_post render = expected (born-in-DB)
  const blogMd = readFileSync(join(tmp, "blog_post.md"), "utf8");
  smoke.blog_render_ok = ok("blog_post render contains both items (section+prose)",
    /Why one model/.test(blogMd) && /derived dump/.test(blogMd));

  // emit a manifest the Haiku test can consume
  const manifest = {
    project_id: PROJECT,
    sow_document_id: sow.document_id,
    decisions_document_id: dec.document_id,
    blog_document_id: blog.document_id,
    existing_item_code_to_read: "OBJ-001" + SFX,
    suffix: SFX,
  };
  writeFileSync(join(here, "pilot-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("\nManifest → tests/pilot-manifest.json");

  // sanity: doc_query lists items
  const q = await docQuery(db, { project_id: PROJECT, document_type: "sow" }, ctx);
  ok("doc_query(sow) returns items", q.ok && (q as any).data.count >= 3);
}

try { await main(); }
catch (e) { failed++; console.log(`\n[ERROR] ${e instanceof Error ? e.message : String(e)}`); }

console.log(`\n==== PILOT RESULT: ${passed} pass / ${failed} fail ====`);
console.log("REQUIRED SMOKES:", JSON.stringify({
  "1_sow_decisions_created": smoke.sow_created && smoke.decisions_created,
  "2_blog_render_ok": smoke.blog_render_ok,
  "3_round_trip_identical": smoke.round_trip_identical,
  // smoke 4 (Haiku) is run separately
}, null, 0));
process.exit(failed === 0 ? 0 : 1);

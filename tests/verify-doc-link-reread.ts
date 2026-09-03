// MEASUREMENT ONLY (GTD b4e07ba6): before arming D-132 read-back on doc_link's
// 4 INSERT paths, measure whether a follow-up SELECT on each link table can
// actually see the just-inserted row under doc_rw. The DBA migration
// 20260816110000 revoked UPDATE (not SELECT/INSERT) on these 4 tables (msg
// 51ae3289) — but the link SELECT policy is anchored on the FROM item's
// document visibility (doc_query broken_refs note in CLAUDE.md), so this is
// measured, not assumed, exactly as the parent GTD (8b97b1ca) insisted for
// doc_create/doc_supersede.
//
// Uses two REAL existing rows as FK targets for the gtd/wi links (the current
// GTD and WI of this very task) — read-only references, never mutated, and
// the link rows themselves never persist (the whole probe rolls back).
//
// Run: npx tsx tests/verify-doc-link-reread.ts

import { readFileSync } from "node:fs";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DOC_RW_DATABASE_URL) { process.env.DOC_RW_DATABASE_URL = expand(s.env.DOC_RW_DATABASE_URL); break; }
}
if (!process.env.DOC_RW_DATABASE_URL) { console.error("no DOC_RW_DATABASE_URL in .mcp.json"); process.exit(2); }

const BOARD_MCP_PROJECT = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
const REAL_GTD_ID = "b4e07ba6-f857-47ca-bbd8-ba0ddfa6e1e5"; // this task's own GTD — read-only FK target
const REAL_WI_ID = process.argv[2]; // pass the active WI id as argv, so it always exists
const SFX = "-V" + Date.now().toString(36).toUpperCase();
const ROLLBACK = "__rollback_sentinel__";

if (!REAL_WI_ID) { console.error("usage: npx tsx tests/verify-doc-link-reread.ts <real-wi-id>"); process.exit(2); }

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
    const doc = await docs.docCreate(db, {
      project_id: BOARD_MCP_PROJECT, document_type: "sdes", title: "SCRATCH doc_link-reread verify" + SFX, status: "draft",
    }, ctx);
    ok("setup: doc_create ok", doc.ok, JSON.stringify(doc));
    if (!doc.ok) throw new Error(ROLLBACK);
    const documentId = (doc as any).data.document_id;

    const itemA = await docs.docItemUpsert(db, { project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "sdes_entry", code: "SDES-LNK-A" + SFX, body: "item A" }, ctx);
    ok("setup: item A ok", itemA.ok, JSON.stringify(itemA));
    if (!itemA.ok) throw new Error(ROLLBACK);
    const aId = (itemA as any).data.item_id;

    const itemB = await docs.docItemUpsert(db, { project_id: BOARD_MCP_PROJECT, document_id: documentId, item_type: "sdes_entry", code: "SDES-LNK-B" + SFX, body: "item B" }, ctx);
    ok("setup: item B ok", itemB.ok, JSON.stringify(itemB));
    if (!itemB.ok) throw new Error(ROLLBACK);
    const bId = (itemB as any).data.item_id;

    // --- 1. target_kind="gtd" -> doc_item_gtd_links ---------------------------
    const linkGtd = await docs.docLink(db, { target_kind: "gtd", from_id: aId, to_id: REAL_GTD_ID }, ctx);
    ok("doc_item_gtd_links: INSERT ok", linkGtd.ok, JSON.stringify(linkGtd));
    if (linkGtd.ok) {
      const { data, error } = await db.from("doc_item_gtd_links").select("id, doc_item_id, gtd_item_id").eq("id", (linkGtd as any).data.link_id).maybeSingle();
      ok("doc_item_gtd_links: follow-up SELECT sees the row", !error && !!data && data.doc_item_id === aId && data.gtd_item_id === REAL_GTD_ID, JSON.stringify({ data, error: error?.message }));
    }

    // --- 2. target_kind="wi" -> doc_item_wi_links -----------------------------
    const linkWi = await docs.docLink(db, { target_kind: "wi", from_id: aId, to_id: REAL_WI_ID }, ctx);
    ok("doc_item_wi_links: INSERT ok", linkWi.ok, JSON.stringify(linkWi));
    if (linkWi.ok) {
      const { data, error } = await db.from("doc_item_wi_links").select("id, doc_item_id, wi_id").eq("id", (linkWi as any).data.link_id).maybeSingle();
      ok("doc_item_wi_links: follow-up SELECT sees the row", !error && !!data && data.doc_item_id === aId && data.wi_id === REAL_WI_ID, JSON.stringify({ data, error: error?.message }));
    }

    // --- 3. target_kind="doc", intra-project -> doc_item_links ----------------
    const linkDoc = await docs.docLink(db, { target_kind: "doc", from_id: bId, to_id: aId, relation_type: "relates_to" }, ctx);
    ok("doc_item_links (intra-project): INSERT ok", linkDoc.ok, JSON.stringify(linkDoc));
    if (linkDoc.ok) {
      const { data, error } = await db.from("doc_item_links").select("id, from_item, to_item, relation_type").eq("id", (linkDoc as any).data.link_id).maybeSingle();
      ok("doc_item_links: follow-up SELECT sees the row", !error && !!data && data.from_item === bId && data.to_item === aId, JSON.stringify({ data, error: error?.message }));
    }

    // --- 4. target_kind="doc", relation_type="references" -> ALWAYS xproject --
    // (D-074: 'references' routes cross-project even when both items share a
    // project — this is the one path that reaches doc_item_xproject_links
    // without needing a second project.)
    const linkXproj = await docs.docLink(db, { target_kind: "doc", from_id: aId, to_id: bId, relation_type: "references" }, ctx);
    ok("doc_item_xproject_links (references): INSERT ok", linkXproj.ok, JSON.stringify(linkXproj));
    if (linkXproj.ok) {
      const { data, error } = await db.from("doc_item_xproject_links").select("id, from_item, to_item, relation_type").eq("id", (linkXproj as any).data.link_id).maybeSingle();
      ok("doc_item_xproject_links: follow-up SELECT sees the row", !error && !!data && data.from_item === aId && data.to_item === bId, JSON.stringify({ data, error: error?.message }));
    }

    console.log(`\n${pass} passed, ${fail} failed. Rolling back (scratch data, nothing persists — GTD/WI referenced but never mutated).`);
    throw new Error(ROLLBACK);
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg !== ROLLBACK) { console.error("UNEXPECTED ERROR:", msg); fail++; }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

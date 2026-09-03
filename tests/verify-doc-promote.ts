// MEASUREMENT ONLY (ISS-046, it-manager msg 2533b2a6): before trusting
// doc_promote's direct UPDATE on documents.status, measure whether doc_rw
// can actually write that column. documents.version had UPDATE revoked from
// doc_rw specifically (dba, session #105 — only gov.doc_publish() may touch
// it), so a column-level revoke on status too is a real possibility, not a
// theoretical one — this is exactly the kind of assumption D-136 §5 and the
// D-132 discipline forbid making without measuring.
//
// Scratch document, created and promoted inside a transaction that always
// rolls back — nothing persists either way.
//
// Run: npx tsx tests/verify-doc-promote.ts

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
    const doc = await docs.docCreate(db, {
      project_id: BOARD_MCP_PROJECT, document_type: "sdes", title: "SCRATCH doc_promote verify" + SFX, status: "draft",
    }, ctx);
    ok("setup: doc_create ok", doc.ok, JSON.stringify(doc));
    if (!doc.ok) throw new Error(ROLLBACK);
    const documentId = (doc as any).data.document_id;

    // The measurement: does doc_rw actually have UPDATE on documents.status,
    // or does it fail 42501 the way a bare .update({version}) would?
    const promoted = await docs.docPromote(db, { document_id: documentId, new_status: "in_review" }, ctx);
    ok("doc_promote draft->in_review: ok", promoted.ok, JSON.stringify(promoted));
    if (promoted.ok) {
      ok("doc_promote: old_status reported correctly", (promoted as any).data.old_status === "draft", JSON.stringify(promoted));
      ok("doc_promote: new_status reported correctly", (promoted as any).data.new_status === "in_review", JSON.stringify(promoted));
      const { data, error } = await db.from("documents").select("id, status").eq("id", documentId).maybeSingle();
      ok("documents: follow-up SELECT confirms status='in_review'", !error && data?.status === "in_review", JSON.stringify({ data, error: error?.message }));
    }

    // A second promote in the same transaction — confirms the write is a real
    // UPDATE (not a fluke of the row's insert-time state) by moving it again.
    const promoted2 = await docs.docPromote(db, { document_id: documentId, new_status: "approved" }, ctx);
    ok("doc_promote in_review->approved: ok (second real UPDATE)", promoted2.ok, JSON.stringify(promoted2));

    console.log(`\n${pass} passed, ${fail} failed. Rolling back (scratch document, nothing persists).`);
    throw new Error(ROLLBACK);
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg !== ROLLBACK) { console.error("UNEXPECTED ERROR:", msg); fail++; }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

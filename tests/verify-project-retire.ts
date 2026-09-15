// MEASUREMENT ONLY (Ritiro progetto fase 3, GTD 1061ce6e) — verify
// doc_item_retire against the REAL DB after dba's fase-2 apply (msg 9c2add8d,
// 2026-09-16), not just the fake-DB unit tests. Everything here runs inside a
// doc_rw transaction that always rolls back (same pattern as
// verify-doc-promote.ts) — scratch rows in board-mcp's own project, nothing
// persists.
//
// Deliberately NOT tested here: project_retire's tombstone write
// (loomx_projects.retired_at/reason/status) — that runs on ctx.serviceDb
// (native board-mcp role, no transaction control available from here) and
// dba's own message already measured it as permission-denied today (no
// per-column GRANT yet). Attempting it live against board-mcp's OWN real
// project row would be the wrong kind of measurement — reproducing a known,
// already-reported fact at the cost of a real write attempt against
// non-scratch data. Skipped on purpose, not by oversight.
//
// Run: npx tsx tests/verify-project-retire.ts

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
    // 1. gov.doc_m5_terminal_statuses() — real shape, real content.
    const term = await docs.fetchTerminalStatuses(db);
    console.log("fetchTerminalStatuses:", term);
    ok("terminal statuses source is 'gov' (RPC reachable, not the fallback)", term.source === "gov", JSON.stringify(term));
    ok("terminal set includes 'retired'", term.statuses.has("retired"), JSON.stringify([...term.statuses]));
    ok("terminal set EXCLUDES 'rejected' (dba's explicit correction)", !term.statuses.has("rejected"), JSON.stringify([...term.statuses]));

    // 2. Scratch fixture: a doc_item with a real incoming link (no heir).
    const doc = await docs.docCreate(db, {
      project_id: BOARD_MCP_PROJECT, document_type: "sdes", title: "SCRATCH project_retire verify" + SFX,
    }, ctx);
    ok("setup: doc_create ok", doc.ok, JSON.stringify(doc));
    if (!doc.ok) throw new Error(ROLLBACK);
    const docId = (doc as any).data.document_id;

    const target = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: docId, item_type: "sdes_entry", body: "scratch target" + SFX,
    }, ctx);
    ok("setup: target item created", target.ok, JSON.stringify(target));
    if (!target.ok) throw new Error(ROLLBACK);
    const targetId = (target as any).data.item_id;

    const uatDoc = await docs.docCreate(db, {
      project_id: BOARD_MCP_PROJECT, document_type: "uat", title: "SCRATCH project_retire verify (UAT)" + SFX,
    }, ctx);
    ok("setup: uat doc_create ok", uatDoc.ok, JSON.stringify(uatDoc));
    if (!uatDoc.ok) throw new Error(ROLLBACK);
    const uatDocId = (uatDoc as any).data.document_id;

    const referencer = await docs.docItemUpsert(db, {
      project_id: BOARD_MCP_PROJECT, document_id: uatDocId, item_type: "uat_case", body: "scratch referencer" + SFX,
    }, ctx);
    ok("setup: referencer item created", referencer.ok, JSON.stringify(referencer));
    if (!referencer.ok) throw new Error(ROLLBACK);
    const referencerId = (referencer as any).data.item_id;

    const link = await docs.docLink(db, { target_kind: "doc", from_id: referencerId, to_id: targetId, relation_type: "verifies" }, ctx);
    ok("setup: verifies link created", link.ok, JSON.stringify(link));

    // 3. The negative case dba already measured for a plain status flip — a
    // raw UPDATE with no heir and no no_successor_reason must be REFUSED by
    // the live trigger, using the same project this tool actually runs
    // against, not just dba's sandbox. SAVEPOINT around it: an EXPECTED
    // failure still aborts the transaction the same way the unexpected
    // permission-denied above did — same lesson, applied a second time in
    // the same script.
    await db.savepoint("neg_probe");
    const { error: rawErr } = await db.from("doc_items").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", targetId);
    ok("negative case: raw status flip WITHOUT no_successor_reason is refused by the live trigger", !!rawErr, JSON.stringify({ rawErr }));
    await db.rollbackToSavepoint("neg_probe");

    // 4. The actual tool: doc_item_retire on the SAME row — must succeed
    // (declares no_successor_reason) and report the real incoming link.
    const retired = await docs.docItemRetire(db, { project_id: BOARD_MCP_PROJECT, item_id: targetId, reason: "verify-project-retire scratch run" + SFX }, ctx);
    ok("doc_item_retire succeeds on a row WITH an incoming link (deliberate override)", retired.ok, JSON.stringify(retired));
    if (retired.ok) {
      ok("doc_item_retire reports the real incoming link", retired.data.incoming.links === 1, JSON.stringify(retired.data.incoming));
      const { data: after } = await db.from("doc_items").select("status, attrs").eq("id", targetId).maybeSingle();
      ok("row status is 'retired' after the call", after?.status === "retired", JSON.stringify(after));
      ok("attrs.no_successor_reason was written", typeof after?.attrs?.no_successor_reason === "string", JSON.stringify(after?.attrs));
    }

    // 5. Already-retired row: a second retire must be refused, not silently
    // re-applied.
    const second = await docs.docItemRetire(db, { project_id: BOARD_MCP_PROJECT, item_id: targetId, reason: "second attempt" }, ctx);
    ok("re-retiring an already-retired row is refused", !second.ok, JSON.stringify(second));

    console.log(`\n${pass} passed, ${fail} failed. Rolling back (scratch rows in board-mcp's own project, nothing persists).`);
    throw new Error(ROLLBACK);
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg !== ROLLBACK) { console.error("UNEXPECTED ERROR:", msg); fail++; }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);

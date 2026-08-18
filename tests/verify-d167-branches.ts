// Live verification of the D-167 extended branches (GTD dc4e943e) on the REAL
// production path: direct-pg doc_rw as board-mcp, through runDocRw + docItemUpsert.
// The unit tests in docs.test.ts drive a fake whose RLS is a hand-written mimic;
// this one asks the actual database, which is the only way to know the branch a
// caller really lands on. Every call below fails validation before any write.
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-d167-branches.ts

process.env.DOC_RW_DATABASE_URL ??= process.env.LOOMX_DOC_RW_URL;
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("need DOC_RW_DATABASE_URL (or LOOMX_DOC_RW_URL) — board_doc_rw login role");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const docs = await import("../src/docs.ts");

const ctx = { selfSlug: "board-mcp", isLoomy: false };
const HUB = "22ae4e79-1800-4975-ba46-cd2f86734257";        // board-mcp IS a member
const BOARD_MCP = "596cd5fc-d385-4763-9c52-6fb48738d7dc";  // board-mcp IS a member
const FOREIGN = "669fd07b-6e45-4137-89ad-00626633a0d7";    // board-mcp is NOT a member
const REAL_DOC = "794e873c-f72c-42a2-8ac0-fe1966d0b439";   // lives in FOREIGN, visibility=org
const ABSENT = "00000000-0000-4000-8000-000000000999";     // exists nowhere

const upsert = (project_id: string, document_id: string) =>
  runDocRw("board-mcp", (db: any) =>
    docs.docItemUpsert(db, { project_id, document_id, item_type: "requirement", code: "REQ-D167-PROBE" }, ctx));

const CASES: Array<[string, string, string, RegExp, RegExp?]> = [
  // (b) the CFG-090 shape — org-visible document reached by the non-scoped lookup
  ["(b) real document, wrong project_id", HUB, REAL_DOC, /project_id mismatch.*belongs to project 669fd07b.*Do NOT call doc_create/s],
  // D-167 point 4 (dba msg 25bb24d9, v0.16.8): ABSENT is genuinely absent — the
  // oracle now says so with certainty, regardless of the caller's own membership
  // on the named project. Both callers below get the SAME plain 404, no hedging.
  ["(404) absent id, caller IS a member", BOARD_MCP, ABSENT, /^document_id '.*' not found in project/, /create it first with doc_create/i],
  ["(404) absent id, caller NOT a member", FOREIGN, ABSENT, /^document_id '.*' not found in project/, /create it first with doc_create/i],
];

let fail = 0;
for (const [name, project, doc, want, mustNotMatch] of CASES) {
  const res: any = await upsert(project, doc);
  const msg = res.error ?? JSON.stringify(res.data);
  const good = res.ok === false && want.test(msg) && !(mustNotMatch?.test(msg) ?? false);
  if (!good) fail++;
  console.log(`\n[${good ? "PASS" : "FAIL"}] ${name}\n  ${msg}`);
}

// D-167 point 4: the oracle itself, ground truth vs the SQL the DBA measured with
// (SELECT direct → 0 rows / doc_document_exists → t on the same row).
const probe = (id: string) =>
  runDocRw("board-mcp", (db: any) => db.documentExists(id));
const ORACLE_CASES: Array<[string, string, boolean]> = [
  ["oracle on REAL_DOC (org-visible, exists)", REAL_DOC, true],
  ["oracle on ABSENT (exists nowhere)", ABSENT, false],
];
for (const [name, id, want] of ORACLE_CASES) {
  const got = await probe(id);
  const good = got === want;
  if (!good) fail++;
  console.log(`\n[${good ? "PASS" : "FAIL"}] ${name}\n  doc_document_exists → ${got} (want ${want})`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);

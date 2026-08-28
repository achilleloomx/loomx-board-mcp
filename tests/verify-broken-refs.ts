// Live verification of doc_query(traceability='broken_refs') against the REAL
// production DB, through the real runDocRw path — not the fake harness. The
// check is READ-ONLY, so nothing needs rolling back; what has to be proved is
// that the numbers it reports match the INDEPENDENT SQL measurement taken
// before any code was written (2026-08-29, scratchpad measure-links/measure2):
// 161 same-project + 5 cross-project links on board-mcp, 24 deprecated targets
// on project-governance. A check that only agrees with itself proves nothing
// (the lesson from #128: the fake can't see what node-pg does to types, and it
// can't see what RLS does to rows). The arithmetic identities are asserted too,
// so a miscount can't hide inside a plausible-looking total.
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-broken-refs.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docQuery } = await import("../src/docs.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };

const BOARD_MCP = "596cd5fc-d385-4763-9c52-6fb48738d7dc";   // our own project
const PROJECT_GOV = "669fd07b-6e45-4137-89ad-00626633a0d7"; // forge's UAT-PG-008 project
const NONEXISTENT = "00000000-0000-4000-8000-000000000000";

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "  ok  " : "FAIL  "} ${name} — ${detail}`);
  if (!cond) failures += 1;
}


const results = await runDocRw(SLUG, async (db) => {
  const out: Record<string, any> = {};
  for (const [label, pid] of [["board-mcp", BOARD_MCP], ["project-governance", PROJECT_GOV], ["nonexistent", NONEXISTENT]] as const) {
    out[label] = await docQuery(db as any, { project_id: pid, traceability: "broken_refs", limit: 500 }, ctx);
  }
  return out;
});

// --- board-mcp: our own corpus -------------------------------------------
{
  const r = results["board-mcp"];
  check("board-mcp: check runs", r.ok === true, JSON.stringify(r).slice(0, 200));
  const d = r.data;
  console.log("      coverage:", JSON.stringify(d.coverage));
  check(
    "board-mcp: arithmetic closes",
    d.coverage.ok + d.coverage.broken + d.coverage.abstained === d.coverage.classified,
    `${d.coverage.ok} ok + ${d.coverage.broken} broken + ${d.coverage.abstained} abstained === ${d.coverage.classified} classified`
  );
  check(
    "board-mcp: classified + skipped_supersedes === total scanned",
    d.coverage.classified + d.coverage.skipped_supersedes === d.coverage.total_links_scanned,
    `${d.coverage.classified} + ${d.coverage.skipped_supersedes} === ${d.coverage.total_links_scanned}`
  );
  check("board-mcp: dangling is structural, not measured", d.dangling.count === 0 && d.dangling.measured === false, JSON.stringify(d.dangling.count));
  check("board-mcp: scanned links match the 2026-08-29 measurement (161 same-project + 5 cross-out)",
    d.coverage.scanned_by_scope.same_project === 161 && d.coverage.scanned_by_scope.cross_project_out === 5,
    JSON.stringify(d.coverage.scanned_by_scope));
  check("board-mcp: no broken references in our own project (measured: every link target is draft/in_review/approved/active)",
    d.coverage.broken === 0, `broken=${d.coverage.broken}`);
}

// --- project-governance: forge's UAT-PG-008 corpus ------------------------
{
  const r = results["project-governance"];
  check("project-governance: check runs", r.ok === true, JSON.stringify(r).slice(0, 200));
  const d = r.data;
  console.log("      coverage:", JSON.stringify(d.coverage));
  check(
    "project-governance: arithmetic closes",
    d.coverage.ok + d.coverage.broken + d.coverage.abstained === d.coverage.classified,
    `${d.coverage.ok} + ${d.coverage.broken} + ${d.coverage.abstained} === ${d.coverage.classified}`
  );
  check(
    "project-governance: the 24 deprecated targets measured in SQL are reported as broken",
    d.coverage.broken_by.deprecated === 24,
    `deprecated=${d.coverage.broken_by.deprecated} (SQL said 24)`
  );
  check(
    "project-governance: UAT-PG-008 step 1 is now answerable with a real number",
    typeof d.count === "number" && Array.isArray(d.items),
    `count=${d.count}, items=${d.items.length}`
  );
  const sample = d.items[0];
  if (sample) console.log("      sample:", JSON.stringify(sample).slice(0, 300));
  check("project-governance: every broken row names both ends and the kind",
    d.items.every((i: any) => i.link_id && i.from?.id && i.to?.id && i.kind),
    `${d.items.length} rows`);
}

// --- a project that does not exist ---------------------------------------
{
  const r = results["nonexistent"];
  const d = r.data;
  check("nonexistent project: 0 rows, and the answer declares it may be a visibility block (D-167)",
    r.ok === true && d.count === 0,
    JSON.stringify({ count: d.count, visibility_gap: d.visibility_gap ?? false }));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// Live verification of gov.doc_frozen_row_touches (D-201, the "second defect" side
// of the M2 detector — a PUBLISHED row rewritten outside the publish act) against
// the REAL production DB, through the real runDocRw path. CLAUDE.md flagged this
// as "not yet verified live" (only read from the source) — this closes that gap
// the same way doc_repoint's cycle was closed in #127 (tests/verify-repoint.ts):
// built and destroyed inside ONE rolled-back transaction, nothing committed.
//
// Also re-measures whether doc_rw now has EXECUTE on gov.doc_item_substantive_diff
// directly (42501 measured 2026-08-29, docDb.ts substantiveDiff comment) — if the
// grant landed since, this gets an exact "which columns count as substantive"
// answer instead of a declared gap.
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-frozen-row-touches.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const docs = await import("../src/docs.ts");
const { docPublish } = await import("../src/subscriptions.ts");
const { docStalenessQuery } = await import("../src/staleness.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };
const BOARD_MCP = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
const ROLLBACK = Symbol("rollback");

async function probe<T>(fn: (db: any) => Promise<T>): Promise<T> {
  try {
    await runDocRw(SLUG, async (db) => {
      const value = await fn(db);
      throw Object.assign(new Error("rollback"), { [ROLLBACK]: true, value });
    });
    throw new Error("unreachable: probe did not roll back");
  } catch (e: any) {
    if (e?.[ROLLBACK]) return e.value as T;
    throw e;
  }
}

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  if (!cond) failures++;
}

// --- 1. build a temp document, publish it, then rewrite a row OUTSIDE publish -
const cycle = await probe(async (db) => {
  const out: Record<string, any> = {};

  const target = await docs.docCreate(db, { project_id: BOARD_MCP, document_type: "sdes", title: "TEMP frozen-row verify (rolled back)" }, ctx);
  if (!target.ok) return { setupFailed: `docCreate target: ${(target as any).error}` };
  const targetDocId = (target as any).data.document_id ?? (target as any).data.id;

  const chDoc = await docs.docCreate(db, { project_id: BOARD_MCP, document_type: "changelog", title: "TEMP changelog (rolled back)" }, ctx);
  if (!chDoc.ok) return { setupFailed: `docCreate changelog: ${(chDoc as any).error}` };
  const chDocId = (chDoc as any).data.document_id ?? (chDoc as any).data.id;

  const ch1 = await docs.docItemUpsert(db, {
    project_id: BOARD_MCP, document_id: chDocId, item_type: "changelog_entry",
    body: "temp entry 1.0", attrs: { version: "1.0" }, sort_order: 1,
  } as any, ctx);
  if (!ch1.ok) return { setupFailed: `changelog entry: ${(ch1 as any).error}` };
  const ch1Id = (ch1 as any).data.item_id ?? (ch1 as any).data.id;

  const rowA = await docs.docItemUpsert(db, {
    project_id: BOARD_MCP, document_id: targetDocId, item_type: "sdes_entry",
    code: `SDES-FRZ-${Date.now().toString(36)}`, body: "original body — published as part of 1.0", sort_order: 1,
  } as any, ctx);
  if (!rowA.ok) return { setupFailed: `upsert row A: ${(rowA as any).error}` };
  const rowAId = (rowA as any).data.item_id ?? (rowA as any).data.id;

  const pub1 = await docPublish(db, { document_id: targetDocId, new_version: "1.0", bump_class: "minor", changelog_entry_id: ch1Id, delta_summary: "temp" }, ctx);
  if (!pub1.ok) return { setupFailed: `publish 1.0: ${(pub1 as any).error}` };

  // Snapshot row A exactly as published, for the substantiveDiff probe below.
  const beforeSnap = await db.from("doc_items").select("*").eq("id", rowAId).maybeSingle();
  out.beforeSnap = beforeSnap.data;

  // THE ACT UNDER TEST: rewrite row A's body — a substantive field — OUTSIDE
  // any doc_publish call. If the M2 trigger fires on doc_items UPDATE for a
  // row belonging to a published document, gov.doc_frozen_row_touches gets a
  // new row for it.
  const touch = await docs.docItemUpsert(db, {
    project_id: BOARD_MCP, document_id: targetDocId, item_type: "sdes_entry",
    code: (rowA as any).data.code, body: "REWRITTEN after publish — outside the publish act",
  } as any, ctx);
  if (!touch.ok) return { setupFailed: `touch row A: ${(touch as any).error}` };

  const afterSnap = await db.from("doc_items").select("*").eq("id", rowAId).maybeSingle();
  out.afterSnap = afterSnap.data;

  const frozen = await db
    .from("gov.doc_frozen_row_touches")
    .select("id, doc_item_id, document_id, op, changed_columns, changed_at")
    .eq("doc_item_id", rowAId);
  out.frozenRows = frozen.data ?? [];
  out.frozenErr = frozen.error?.message ?? null;

  // Re-measure the substantiveDiff EXECUTE grant (42501 on 2026-08-29) with the
  // SAME two snapshots the trigger itself compared — an exact empirical answer
  // if the grant landed, a declared gap (unchanged) if not.
  const rw = db as { substantiveDiff?: (b: any, a: any) => Promise<string[]> };
  if (rw.substantiveDiff) {
    try {
      out.substantiveDiffResult = await rw.substantiveDiff(out.beforeSnap, out.afterSnap);
    } catch (e: any) {
      out.substantiveDiffError = e?.message ?? String(e);
    }
  }

  // Control: read via the doc_staleness_query TOOL surface too (separate code
  // path — resolves doc_item_code, scopes to project) — same touch must appear
  // there, not just in the raw table read above.
  const viaTool = await docStalenessQuery(db, { project_id: BOARD_MCP, status: "all" }, ctx);
  out.viaToolFrozen = viaTool.ok ? (viaTool as any).data.frozen_row_touches.filter((f: any) => f.doc_item_id === rowAId) : null;
  out.viaToolErr = viaTool.ok ? null : (viaTool as any).error;

  return out;
});

if (cycle.setupFailed) {
  check("build+publish+touch cycle", false, `setup failed: ${cycle.setupFailed}`);
} else {
  check(
    "gov.doc_frozen_row_touches fired on the post-publish rewrite (D-201, live — was only read from source before)",
    !cycle.frozenErr && cycle.frozenRows.length >= 1,
    cycle.frozenErr ? `read failed: ${cycle.frozenErr}` : `${cycle.frozenRows.length} row(s): ${JSON.stringify(cycle.frozenRows.map((r: any) => ({ op: r.op, changed_columns: r.changed_columns })))}`
  );
  check(
    "the touch names 'body' among changed_columns",
    !cycle.frozenErr && cycle.frozenRows.some((r: any) => Array.isArray(r.changed_columns) && r.changed_columns.includes("body")),
    JSON.stringify(cycle.frozenRows.map((r: any) => r.changed_columns))
  );
  check(
    "doc_staleness_query (tool surface) reports the SAME touch",
    Array.isArray(cycle.viaToolFrozen) && cycle.viaToolFrozen.length >= 1,
    cycle.viaToolErr ? `tool call failed: ${cycle.viaToolErr}` : `${cycle.viaToolFrozen?.length ?? 0} row(s) via doc_staleness_query`
  );
  if (cycle.substantiveDiffResult !== undefined) {
    check(
      "gov.doc_item_substantive_diff now EXECUTE-able from doc_rw directly (grant landed since 2026-08-29)",
      Array.isArray(cycle.substantiveDiffResult),
      `changed columns per the predicate itself: ${JSON.stringify(cycle.substantiveDiffResult)}`
    );
  } else {
    check(
      "gov.doc_item_substantive_diff direct EXECUTE from doc_rw — gap status",
      /42501|permission denied/i.test(cycle.substantiveDiffError ?? ""),
      cycle.substantiveDiffError
        ? `still 42501 (declared gap unchanged): ${cycle.substantiveDiffError.slice(0, 150)}`
        : "substantiveDiff probe not available on this db handle"
    );
  }
}

// --- 2. nothing was committed -------------------------------------------------
if (!cycle.setupFailed) {
  const after = await runDocRw(SLUG, async (db) => {
    const { data } = await db.from("gov.doc_frozen_row_touches").select("id").eq("doc_item_id", cycle.beforeSnap?.id ?? "00000000-0000-4000-8000-000000000000");
    return data as any[];
  });
  check(
    "rollback held — no frozen-row-touch row survives outside the probe transaction",
    Array.isArray(after) && after.length === 0,
    `${after?.length ?? "?"} row(s) found after rollback (expected 0)`
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

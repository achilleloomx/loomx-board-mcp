// Live verification of doc_version_delta and the doc_subscribe admission gate
// against the REAL production DB, through the real runDocRw path — not the fake
// harness. Read-only: this script never writes, so no rollback dance is needed
// (unlike verify-repoint.ts, which mutates and rolls back).
//
// It exists because the fake harness has already missed real bugs on exactly
// this seam: node-pg returns timestamptz as Date and numeric as a string, and
// only a live run sees that (see CLAUDE.md, staleness decay note).
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-version-delta.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docVersionDelta } = await import("../src/subscriptions.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures += 1;
}

await runDocRw(SLUG, async (db: any) => {
  // Pick a real document with at least 2 publications, straight from the ledger.
  const { data: vers } = await db
    .from("gov.doc_versions")
    .select("id, document_id, version_seq, version_label")
    .order("version_seq", { ascending: false });
  const rows = (vers ?? []) as Array<{ document_id: string; version_seq: number; version_label: string }>;
  const seqByDoc = new Map<string, number>();
  for (const r of rows) seqByDoc.set(r.document_id, (seqByDoc.get(r.document_id) ?? 0) + 1);
  const multi = [...seqByDoc.entries()].filter(([, n]) => n >= 2).map(([d]) => d);
  console.log(`ledger: ${rows.length} publications, ${seqByDoc.size} documents, ${multi.length} with 2+ versions`);

  if (multi.length === 0) {
    check("a multi-version document exists to diff", false, "no document has 2+ publications");
    return;
  }

  const docId = multi[0];
  const res = await docVersionDelta(db, { document_id: docId }, ctx);
  check("delta on a real multi-version document returns ok", res.ok, JSON.stringify(res).slice(0, 400));
  if (!res.ok) return;
  const d = (res as any).data;
  console.log(`  document ${docId.slice(0, 8)} ${d.baseline?.label} -> ${d.version.label}: ` +
    `${d.changes.length} changed, ${d.counts.unchanged} unchanged, ${d.counts.total_rows_in_version} rows`);
  console.log(`  changes: ${JSON.stringify(d.changes.map((c: any) => `${c.code ?? c.item_id.slice(0, 8)}:${c.change_kind}`))}`);

  check("baseline is a real earlier publication", d.baseline !== null && d.baseline.seq < d.version.seq,
    JSON.stringify(d.baseline));
  // published_at must be an ISO STRING in the tool's JSON contract — node-pg
  // hands back a Date, and a Date serialised by accident is the exact class of
  // bug the live run exists to catch.
  check("published_at is an ISO string, not a Date", typeof d.version.published_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(d.version.published_at), String(d.version.published_at));
  check("counts add up over the current version",
    d.counts.created + d.counts.modified + d.counts.superseded + d.counts.unchanged === d.counts.total_rows_in_version,
    JSON.stringify(d.counts));
  check("every change carries an item_id and a known kind",
    d.changes.every((c: any) => typeof c.item_id === "string" &&
      ["created", "modified", "superseded", "removed"].includes(c.change_kind)),
    JSON.stringify(d.changes.slice(0, 3)));

  // Cross-check the tool against SQL computed independently: the number of rows
  // whose content_sha256 differs between the two snapshots must match.
  const pgq = (db as any).query ?? null;
  if (pgq) {
    const sql = await pgq.call(db,
      `SELECT count(*)::int AS n FROM gov.doc_version_items c
         JOIN gov.doc_version_items p ON p.doc_item_id = c.doc_item_id AND p.publication_id = $2
        WHERE c.publication_id = $1 AND c.content_sha256 <> p.content_sha256`,
      [d.version.publication_id, d.baseline.publication_id]);
    const n = Number(sql?.rows?.[0]?.n ?? -1);
    const toolN = d.counts.modified + d.counts.superseded;
    check("tool's changed-row count matches an independent SQL diff", n === toolN, `sql=${n} tool=${toolN}`);
  } else {
    console.log("SKIP  independent SQL cross-check (no raw query handle on this db)");
  }

  // A never-published document must be an explicit error, not an empty delta.
  const { data: unpub } = await db.from("documents").select("id").limit(50);
  const published = new Set(rows.map((r) => r.document_id));
  const never = ((unpub ?? []) as Array<{ id: string }>).map((r) => r.id).find((id) => !published.has(id));
  if (never) {
    const r2 = await docVersionDelta(db, { document_id: never }, ctx);
    check("never-published document is an explicit error", !r2.ok && /never been published/.test((r2 as any).error),
      JSON.stringify(r2).slice(0, 200));
  } else {
    console.log("SKIP  never-published case (every readable document has a publication)");
  }

  // Admission gate: read the real parameter and report what is in force.
  const { data: param } = await db
    .from("loomx_governance_params")
    .select("param_key, value_numeric, owner_agent_code, deprecated_at")
    .eq("param_key", "sottoscrizioni_ammissione_sospesa");
  const p = ((param ?? []) as any[])[0];
  check("admission flag is readable from the registry under doc_rw", !!p, "row not readable");
  if (p) {
    console.log(`  sottoscrizioni_ammissione_sospesa = ${p.value_numeric} (${typeof p.value_numeric}), owner ${p.owner_agent_code}`);
    check("flag value coerces to a real number (node-pg returns numeric as string)",
      !Number.isNaN(Number(p.value_numeric)), String(p.value_numeric));
  }
});

console.log(failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} LIVE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

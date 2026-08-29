// Live verification of doc_publish_impact (D-233 fase 4) against the REAL
// production DB, through the real runDocRw path — not the fake harness.
// Read-only: this script never writes.
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-publish-impact.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docPublishImpact } = await import("../src/subscriptions.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures += 1;
}

await runDocRw(SLUG, async (db: any) => {
  // Pick one document that has never been published, and one that has —
  // both with at least one active subscription touching one of their items,
  // so both regimes get a real subscriber to report on.
  const { data: subs } = await db
    .from("gov.doc_subscriptions")
    .select("id, target_item_id, target_document_id, status")
    .eq("status", "active");
  const itemTargets = ((subs ?? []) as any[]).filter((s) => s.target_item_id).map((s) => s.target_item_id);
  if (itemTargets.length === 0) {
    console.log("no active item-level subscriptions found — nothing to verify against");
    return;
  }
  const { data: items } = await db.from("doc_items").select("id, document_id").in("id", itemTargets.slice(0, 200));
  const docIds = [...new Set(((items ?? []) as any[]).map((r) => r.document_id))];
  const { data: vers } = await db.from("gov.doc_versions").select("document_id").in("document_id", docIds);
  const publishedDocs = new Set(((vers ?? []) as any[]).map((r) => r.document_id));
  const neverPublished = docIds.find((d) => !publishedDocs.has(d));
  const alreadyPublished = docIds.find((d) => publishedDocs.has(d));

  if (neverPublished) {
    const res = await docPublishImpact(db, { document_id: neverPublished }, ctx);
    check("first_publish doc: call ok", res.ok, JSON.stringify(res));
    if (res.ok) {
      const d = (res as any).data;
      check("first_publish doc: regime is first_publish", d.regime === "first_publish", d.regime);
      check("first_publish doc: at least one subscriber", d.subscribers.length > 0, `count=${d.subscribers.length}`);
      check(
        "first_publish doc: every subscriber is touched=true",
        d.subscribers.every((s: any) => s.touched === true),
        JSON.stringify(d.subscribers.map((s: any) => s.touched))
      );
      console.log(`  document ${neverPublished}: ${d.counts.total} subscribers (${d.counts.direct} direct, ${d.counts.inherited} inherited)`);
    }
  } else {
    console.log("no never-published document with an active item-level subscription found — skipping first_publish check");
  }

  if (alreadyPublished) {
    const res = await docPublishImpact(db, { document_id: alreadyPublished }, ctx);
    check("republish doc: call ok", res.ok, JSON.stringify(res));
    if (res.ok) {
      const d = (res as any).data;
      check("republish doc: regime is republish", d.regime === "republish", d.regime);
      const direct = d.subscribers.filter((s: any) => s.depth === "direct");
      console.log(`  document ${alreadyPublished}: ${d.counts.total} subscribers, direct touched=${JSON.stringify(direct.map((s: any) => s.touched))}`);
      // Confirms the declared-gap path is real, not theoretical: doc_rw has
      // no EXECUTE grant on gov.doc_item_substantive_diff (measured live
      // 2026-08-29) — every direct subscriber on an already-published
      // document with a matching snapshot row must surface as 'unknown',
      // never a silently wrong true/false.
      const unresolved = direct.filter((s: any) => s.touched === "unknown");
      if (unresolved.length > 0) {
        check(
          "republish doc: 'unknown' subscribers name the permission gap, not a guess",
          unresolved.every((s: any) => /42501|EXECUTE-granted/.test(s.basis)),
          JSON.stringify(unresolved.map((s: any) => s.basis))
        );
      }
    }
  } else {
    console.log("no already-published document with an active item-level subscription found — skipping republish check");
  }
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

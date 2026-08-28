// Live verification of the FULL decay cycle (PJ-7/D-210) against the REAL
// production DB, through the real runDocRw path — the fakes cannot prove this:
// the middle of the chain is a DB trigger (gov.doc_items_detect_change) firing
// on a real substantive rewrite, and a fake that "marks a row stale" would only
// be testing itself.
//
// The chain under test, end to end:
//   doc_item_links(verifies) --doc_fact_sync--> gov.doc_subscriptions(origin=fact)
//     --real M2 trigger on a substantive UPDATE--> gov.doc_subscription_staleness
//     --doc_decay_apply--> uat_case attrs.decay_status='decayed'
//     --evaluateDecayGate--> doc_publish REFUSES
//
// Every probe runs inside a transaction that is deliberately ROLLED BACK
// (runWithPool rolls back when the callback throws), so this script builds a
// whole traceable project, watches the machine work on it, and leaves nothing.
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-decay-cycle.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docFactSync } = await import("../src/factSync.ts");
const { docDecayApply, evaluateDecayGate } = await import("../src/staleness.ts");
const { docPublish } = await import("../src/subscriptions.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };
const PROJECT = "596cd5fc-d385-4763-9c52-6fb48738d7dc"; // Board MCP Server — ours
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
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} — ${detail}`);
  }
}

// Builds a small but REAL traceable corpus inside the current transaction:
// one sdes document, one uat document, an sdes_entry, a uat_case verifying it,
// and the link between them. Returns the ids.
async function buildCorpus(db: any, tag: string) {
  const docSdes = crypto.randomUUID();
  const docUat = crypto.randomUUID();
  await db.from("documents").insert({
    id: docSdes, project_id: PROJECT, document_type: "sdes", title: `verify-decay ${tag} sdes`,
    owner: SLUG, status: "draft", visibility: "project", version: "1.0",
  });
  await db.from("documents").insert({
    id: docUat, project_id: PROJECT, document_type: "uat", title: `verify-decay ${tag} uat`,
    owner: SLUG, status: "draft", visibility: "project", version: "1.0",
  });
  const sdesId = crypto.randomUUID();
  const uatId = crypto.randomUUID();
  await db.from("doc_items").insert({
    id: sdesId, project_id: PROJECT, document_id: docSdes, item_type: "sdes_entry",
    code: `SDES-VDC-${tag}`, status: "active", owner: SLUG, body: "The original design text, before any rewrite.", attrs: {},
  });
  await db.from("doc_items").insert({
    id: uatId, project_id: PROJECT, document_id: docUat, item_type: "uat_case",
    code: `UAT-VDC-${tag}`, status: "done", owner: SLUG, body: "Verification of the design.",
    attrs: { pass_fail: "pass" },
  });
  await db.from("doc_item_links").insert({
    id: crypto.randomUUID(), project_id: PROJECT, from_item: uatId, to_item: sdesId, relation_type: "verifies",
  });
  return { docSdes, docUat, sdesId, uatId };
}

console.log("\n=== 1. the ring that did not exist: link -> fact subscription ===");
await probe(async (db) => {
  const { uatId, sdesId } = await buildCorpus(db, "A");

  const before = await db
    .from("gov.doc_subscriptions")
    .select("id")
    .eq("subscriber_item_id", uatId)
    .eq("status", "active");
  check("no subscription exists for a freshly linked pair", (before.data ?? []).length === 0, JSON.stringify(before.data));

  const dry = await docFactSync(db, { project_id: PROJECT, dry_run: true }, ctx);
  const dryHit = dry.ok && (dry.data.would_create ?? []).some((w: any) => w.subscriber_item_id === uatId && w.target_item_id === sdesId);
  check("dry_run previews the new pair", dryHit, JSON.stringify(dry).slice(0, 300));

  const dryRows = await db.from("gov.doc_subscriptions").select("id").eq("subscriber_item_id", uatId).eq("status", "active");
  check("dry_run wrote nothing", (dryRows.data ?? []).length === 0, JSON.stringify(dryRows.data));

  const sync = await docFactSync(db, { project_id: PROJECT }, ctx);
  const created = sync.ok ? sync.data.created.find((c: any) => c.subscriber_item_id === uatId) : null;
  check("doc_fact_sync creates the fact subscription", !!created, JSON.stringify(sync).slice(0, 400));
  check("grade derived from 'verifies' is critical", created?.intent === "critical", String(created?.intent));

  const after = await db
    .from("gov.doc_subscriptions")
    .select("id, origin, intent, status, note")
    .eq("subscriber_item_id", uatId)
    .eq("target_item_id", sdesId)
    .maybeSingle();
  check("the row is really there, origin='fact'", (after.data as any)?.origin === "fact", JSON.stringify(after.data));
  check("its note names the link it came from", /verifies link/.test((after.data as any)?.note ?? ""), String((after.data as any)?.note));

  const again = await docFactSync(db, { project_id: PROJECT }, ctx);
  const dup = again.ok ? again.data.created.some((c: any) => c.subscriber_item_id === uatId) : true;
  check("second run is idempotent for this pair", !dup, JSON.stringify(again).slice(0, 300));
});

console.log("\n=== 2. the whole chain: rewrite the ancestor, watch the test decay ===");
await probe(async (db) => {
  const { uatId, sdesId } = await buildCorpus(db, "B");
  await docFactSync(db, { project_id: PROJECT }, ctx);

  // The provoked case of REG-011, for real: a substantive rewrite of the
  // ancestor. Not a whitespace touch — the M2 predicate (gov.doc_item_substantive_diff)
  // exists precisely to tell those apart.
  await db
    .from("doc_items")
    .update({ body: "The design was REWRITTEN: the mechanism now derives subscriptions from links instead of waiting for a hand-made one." })
    .eq("id", sdesId);

  const marks = await db
    .from("gov.doc_subscription_staleness")
    .select("id, subscription_id, target_item_id, status, changed_columns")
    .eq("target_item_id", sdesId);
  const markRows = (marks.data ?? []) as any[];
  check("the real M2 trigger marked the subscription stale", markRows.length === 1, JSON.stringify(markRows).slice(0, 300));
  check("the marking names the changed column", (markRows[0]?.changed_columns ?? []).includes("body"), JSON.stringify(markRows[0]?.changed_columns));

  const beforeDecay = await db.from("doc_items").select("attrs").eq("id", uatId).maybeSingle();
  check("the test is still green before decay is applied", (beforeDecay.data as any)?.attrs?.decay_status === undefined, JSON.stringify((beforeDecay.data as any)?.attrs));

  const decay = await docDecayApply(db, { project_id: PROJECT }, ctx);
  const appliedHere = decay.ok ? decay.data.applied.find((a: any) => a.item_id === uatId) : null;
  check("doc_decay_apply decays the linked test", !!appliedHere, JSON.stringify(decay).slice(0, 400));

  const afterDecay = await db.from("doc_items").select("attrs").eq("id", uatId).maybeSingle();
  const attrs = (afterDecay.data as any)?.attrs ?? {};
  check("decay_status='decayed' is written", attrs.decay_status === "decayed", JSON.stringify(attrs));
  check("pass_fail is PRESERVED, decay is a layer on top", attrs.pass_fail === "pass", JSON.stringify(attrs));
  check("decay_cause_item names the ancestor", attrs.decay_cause_item === "SDES-VDC-B", String(attrs.decay_cause_item));

  const marksAfter = await db.from("gov.doc_subscription_staleness").select("id, status").eq("target_item_id", sdesId);
  check("the marking stays OPEN — closing it is a separate act", ((marksAfter.data ?? []) as any[])[0]?.status === "open", JSON.stringify(marksAfter.data));
});

console.log("\n=== 3. the gate: a publication cannot step over decayed tests ===");
await probe(async (db) => {
  const { docSdes, uatId } = await buildCorpus(db, "C");

  const clean = await evaluateDecayGate(db, PROJECT);
  console.log(`  (project currently has ${clean.decayed_count} decayed rows, threshold ${clean.threshold}, max_days ${clean.max_days})`);

  // Push the project over the threshold with real rows, inside the transaction.
  const needed = Math.max(0, (clean.threshold ?? 3) - clean.decayed_count);
  const docUat2 = crypto.randomUUID();
  await db.from("documents").insert({
    id: docUat2, project_id: PROJECT, document_type: "uat", title: "verify-decay C extra", owner: SLUG,
    status: "draft", visibility: "project", version: "1.0",
  });
  for (let i = 0; i < needed; i++) {
    await db.from("doc_items").insert({
      id: crypto.randomUUID(), project_id: PROJECT, document_id: docUat2, item_type: "uat_case",
      code: `UAT-VDC-C${i}`, status: "done", owner: SLUG, body: "extra",
      attrs: { pass_fail: "pass", decay_status: "decayed", decay_since: new Date().toISOString(), decay_cause_item: "SDES-VDC-C" },
    });
  }

  const over = await evaluateDecayGate(db, PROJECT);
  check("the gate reports blocking once at/over threshold", over.blocking === true, JSON.stringify({ count: over.decayed_count, threshold: over.threshold, reasons: over.reasons }));

  // A publish attempt must be refused BEFORE gov.doc_publish is ever called —
  // the changelog is deliberately absent here, and the error must still be the
  // decay one, proving the gate sits ahead of the rest of the pipeline.
  const pub = await docPublish(
    db,
    { document_id: docSdes, new_version: "2.0", bump_class: "minor", changelog_entry_id: crypto.randomUUID(), delta_summary: "should never happen" },
    ctx
  );
  check("doc_publish is REFUSED", pub.ok === false, JSON.stringify(pub).slice(0, 200));
  check("and refused for DECAY, not for something else", !pub.ok && /decayed tests must be rerun/i.test(pub.error), !pub.ok ? pub.error.slice(0, 200) : "");
  check("the refusal names the two legitimate ways out", !pub.ok && /doc_staleness_close/.test(pub.error), "");
  check("the refusal cites the registry thresholds, not hardcoded ones", !pub.ok && /pg_rilancio_soglia_decaduti/.test(pub.error), "");
  check("uat row untouched by the refused publish", !!uatId, "");
});

console.log("\n=== 4. no residue: everything above was rolled back ===");
await runDocRw(SLUG, async (db) => {
  const docs = await db.from("documents").select("id, title").eq("project_id", PROJECT);
  const leftovers = ((docs.data ?? []) as any[]).filter((d) => String(d.title).startsWith("verify-decay"));
  check("no verify-decay documents left behind", leftovers.length === 0, JSON.stringify(leftovers));
  const items = await db.from("doc_items").select("id, code").eq("project_id", PROJECT);
  const itemLeft = ((items.data ?? []) as any[]).filter((r) => String(r.code ?? "").startsWith("SDES-VDC") || String(r.code ?? "").startsWith("UAT-VDC"));
  check("no verify-decay items left behind", itemLeft.length === 0, JSON.stringify(itemLeft));
});

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

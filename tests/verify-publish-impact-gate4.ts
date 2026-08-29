// Gate 4 collaudo (D-233 fase 4, GTD c0bbe258): "la risposta prima [doc_publish_impact]
// coincide con ciò che l'atto poi produce davvero [doc_version_delta / target_changed_in_version]".
// Builds a real document -> publish v1 -> substantive edit -> doc_publish_impact
// (pre-act prediction) -> publish v2 -> doc_version_delta (post-act ground truth) ->
// compares the two classifications for the SAME item. Everything runs inside one
// transaction that is deliberately rolled back (same discipline as verify-repoint.ts).
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-publish-impact-gate4.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docPublishImpact, docPublish, docSubscribe } = await import("../src/subscriptions.ts");
const { docVersionDelta } = await import("../src/subscriptions.ts");
const docs = await import("../src/docs.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };
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

const BOARD = "596cd5fc-d385-4763-9c52-6fb48738d7dc";

const result = await probe(async (db) => {
  const out: Record<string, any> = {};

  const target = await docs.docCreate(db, { project_id: BOARD, document_type: "sdes", title: "TEMP gate4 verify (rolled back)" }, ctx);
  if (!target.ok) return { setupFailed: `docCreate target: ${(target as any).error}` };
  const targetDocId = (target as any).data.document_id ?? (target as any).data.id;

  const chDoc = await docs.docCreate(db, { project_id: BOARD, document_type: "changelog", title: "TEMP gate4 changelog (rolled back)" }, ctx);
  if (!chDoc.ok) return { setupFailed: `docCreate changelog: ${(chDoc as any).error}` };
  const chDocId = (chDoc as any).data.document_id ?? (chDoc as any).data.id;

  const mkChangelog = async (version: string, sort: number) => {
    const e = await docs.docItemUpsert(db, {
      project_id: BOARD, document_id: chDocId, item_type: "changelog_entry",
      body: `temp entry ${version}`, attrs: { version }, sort_order: sort,
    } as any, ctx);
    return e.ok ? ((e as any).data.item_id ?? (e as any).data.id) : null;
  };

  const item = await docs.docItemUpsert(db, {
    project_id: BOARD, document_id: targetDocId, item_type: "sdes_entry",
    code: `SDES-G4-${Date.now().toString(36)}`, body: "original body v1", sort_order: 10,
  } as any, ctx);
  if (!item.ok) return { setupFailed: `upsert item: ${(item as any).error}` };
  const itemId = (item as any).data.item_id ?? (item as any).data.id;

  const subscriberItem = await docs.docItemUpsert(db, {
    project_id: BOARD, document_id: targetDocId, item_type: "sdes_entry",
    code: `SDES-G4-SUB-${Date.now().toString(36)}`, body: "temp subscriber", sort_order: 11,
  } as any, ctx);
  if (!subscriberItem.ok) return { setupFailed: `upsert subscriber: ${(subscriberItem as any).error}` };
  const subscriberId = (subscriberItem as any).data.item_id ?? (subscriberItem as any).data.id;

  const ch1 = await mkChangelog("1.0", 1);
  if (!ch1) return { setupFailed: "changelog entry 1.0" };
  const pub1 = await docPublish(db, { document_id: targetDocId, new_version: "1.0", bump_class: "minor", changelog_entry_id: ch1, delta_summary: "temp baseline" }, ctx);
  if (!pub1.ok) return { setupFailed: `publish 1.0: ${(pub1 as any).error}` };

  const sub = await docSubscribe(db, { subscriber_item_id: subscriberId, target_item_id: itemId, intent: "module", note: "temp gate4 subscription" }, ctx);
  if (!sub.ok) return { setupFailed: `subscribe: ${(sub as any).error}` };

  // The substantive edit: this is what the pre-act tool must predict as touched.
  // docItemUpsert is idempotent on (project_id, code) — same code hits the same row.
  const edited = await docs.docItemUpsert(db, {
    project_id: BOARD, document_id: targetDocId, item_type: "sdes_entry",
    code: (item as any).data.code, body: "EDITED body — substantive change for gate4", sort_order: 10,
  } as any, ctx);
  if (!edited.ok) return { setupFailed: `edit item: ${(edited as any).error}` };

  // --- PRE-ACT: doc_publish_impact's prediction ---
  const preAct = await docPublishImpact(db, { document_id: targetDocId }, ctx);
  if (!preAct.ok) return { setupFailed: `doc_publish_impact: ${(preAct as any).error}` };
  const predicted = (preAct as any).data.subscribers.find((s: any) => s.target_item_id === itemId);

  // --- THE ACT: publish v1.1 for real ---
  const ch2 = await mkChangelog("1.1", 2);
  if (!ch2) return { setupFailed: "changelog entry 1.1" };
  const pub2 = await docPublish(db, { document_id: targetDocId, new_version: "1.1", bump_class: "minor", changelog_entry_id: ch2, delta_summary: "temp edit" }, ctx);
  if (!pub2.ok) return { setupFailed: `publish 1.1: ${(pub2 as any).error}` };

  // --- POST-ACT ground truth: doc_version_delta ---
  const delta = await docVersionDelta(db, { document_id: targetDocId }, ctx);
  if (!delta.ok) return { setupFailed: `doc_version_delta: ${(delta as any).error}` };
  const actual = (delta as any).data.changes.find((c: any) => c.item_id === itemId);

  out.regime = (preAct as any).data.regime;
  out.predictedTouched = predicted?.touched;
  out.predictedBasis = predicted?.basis;
  out.actualChangeKind = actual?.change_kind ?? "unchanged (not in changes[])";
  out.preActOk = preAct.ok;
  out.postActOk = delta.ok;
  return out;
});

if (result.setupFailed) {
  check("gate4 fixture setup", false, result.setupFailed);
} else {
  check("regime is republish (document already published once)", result.regime === "republish", `regime=${result.regime}`);
  check(
    "PRE-ACT predicted touched=true for the substantively-edited item",
    result.predictedTouched === true,
    `touched=${result.predictedTouched}, basis="${result.predictedBasis}"`
  );
  check(
    "POST-ACT ground truth: the SAME item is classified 'modified' by doc_version_delta",
    result.actualChangeKind === "modified",
    `change_kind=${result.actualChangeKind}`
  );
  check(
    "GATE 4: pre-act prediction COINCIDES with post-act reality",
    result.predictedTouched === true && result.actualChangeKind === "modified",
    "touched:true (pre) <=> change_kind:modified (post) — same underlying gov.doc_item_substantive_diff comparison"
  );
}

console.log(failures === 0 ? "\nALL PASS — nothing committed (rolled back)" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

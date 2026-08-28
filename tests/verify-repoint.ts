// Live verification of doc_repoint (UAT-GOV-029) against the REAL production
// DB, through the real runDocRw path — not the fake harness. Every case runs
// inside a transaction that is deliberately ROLLED BACK: runWithPool rolls back
// whenever the callback throws, so each probe does its work, gets observed, and
// then leaves nothing behind. Same discipline the dba used for the function
// itself (msg ac19e421: "10 prove, tutte in transazione annullata").
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-repoint.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docRepoint } = await import("../src/subscriptions.ts");
const { docStalenessQuery } = await import("../src/staleness.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };
const ROLLBACK = Symbol("rollback");

// Runs fn, then forces a rollback by throwing — the observed value is carried
// out on the thrown object, so nothing this script does is ever committed.
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

// --- 1. happy path: pin 0.1 -> 1.2 on a really repointable subscription ------
const REPOINTABLE = "acd8a353-efe3-4d1c-a005-670001775f88";
const r1 = await probe(async (db) => {
  const before = await db.from("gov.doc_subscriptions").select("id, subscribed_at_version, subscriber_project_id").eq("id", REPOINTABLE).maybeSingle();
  const projectId = (before.data as any)?.subscriber_project_id;
  const docRow = await db.from("gov.doc_subscriptions").select("target_item_id, target_document_id").eq("id", REPOINTABLE).maybeSingle();
  const tid = (docRow.data as any)?.target_item_id;
  const item = tid ? await db.from("doc_items").select("document_id").eq("id", tid).maybeSingle() : { data: null };
  const documentId = (docRow.data as any)?.target_document_id ?? (item.data as any)?.document_id;
  const versions = await db.from("gov.doc_versions").select("id, version_label, version_seq").eq("document_id", documentId).order("version_seq", { ascending: false });
  const current = ((versions.data ?? []) as any[])[0];
  const res = await docRepoint(db, { subscription_id: REPOINTABLE, seen_version_id: current.id, note: "live verify, rolled back" }, ctx);
  const after = await db.from("gov.doc_subscriptions").select("subscribed_at_version").eq("id", REPOINTABLE).maybeSingle();
  return { res, pinBefore: (before.data as any)?.subscribed_at_version, pinAfter: (after.data as any)?.subscribed_at_version, current, projectId };
});
check(
  "happy path OR a correctly-mapped authorization refusal",
  r1.res.ok
    ? r1.pinAfter === r1.current.version_label
    : /not legitimated|permission denied/i.test((r1.res as any).error),
  r1.res.ok
    ? `pin ${r1.pinBefore} -> ${r1.pinAfter} (version_id ${r1.current.id}), open_staleness=${(r1.res as any).data.open_staleness}`
    : `refused: ${(r1.res as any).error.slice(0, 150)}`
);

// --- 2/3. The full cycle, built and destroyed inside ONE rolled-back tx ------
// The probes above can only ever reach the authorization refusal: those
// subscriptions belong to other projects. To exercise the happy path, the stale
// read and the no-op, the scenario has to live in OUR project — so it gets
// built here (document -> changelog -> publish 1.0 -> subscribe -> publish 2.0)
// and rolled back with everything else. This also exercises the real
// doc_publish -> doc_repoint seam, which no fake can.
const cycle = await probe(async (db) => {
  const docs = await import("../src/docs.ts");
  const { docPublish } = await import("../src/subscriptions.ts");
  const { docSubscribe } = await import("../src/subscriptions.ts");
  const BOARD = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
  const out: Record<string, any> = {};

  const target = await docs.docCreate(db, { project_id: BOARD, document_type: "sdes", title: "TEMP repoint verify (rolled back)" }, ctx);
  if (!target.ok) return { setupFailed: `docCreate target: ${(target as any).error}` };
  const targetDocId = (target as any).data.document_id ?? (target as any).data.id;

  const chDoc = await docs.docCreate(db, { project_id: BOARD, document_type: "changelog", title: "TEMP changelog (rolled back)" }, ctx);
  if (!chDoc.ok) return { setupFailed: `docCreate changelog: ${(chDoc as any).error}` };
  const chDocId = (chDoc as any).data.document_id ?? (chDoc as any).data.id;

  const mkChangelog = async (version: string) => {
    const e = await docs.docItemUpsert(db, {
      project_id: BOARD, document_id: chDocId, item_type: "changelog_entry",
      body: `temp entry ${version}`, attrs: { version }, sort_order: version === "1.0" ? 1 : 2,
    } as any, ctx);
    return e.ok ? ((e as any).data.item_id ?? (e as any).data.id) : null;
  };
  const subscriberItem = await docs.docItemUpsert(db, {
    project_id: BOARD, document_id: targetDocId, item_type: "sdes_entry",
    code: `SDES-TMP-${Date.now().toString(36)}`, body: "temp subscriber", sort_order: 10,
  } as any, ctx);
  if (!subscriberItem.ok) return { setupFailed: `upsert subscriber: ${(subscriberItem as any).error}` };
  const subscriberId = (subscriberItem as any).data.item_id ?? (subscriberItem as any).data.id;

  const ch1 = await mkChangelog("1.0");
  if (!ch1) return { setupFailed: "changelog entry 1.0" };
  const pub1 = await docPublish(db, { document_id: targetDocId, new_version: "1.0", bump_class: "minor", changelog_entry_id: ch1, delta_summary: "temp" }, ctx);
  if (!pub1.ok) return { setupFailed: `publish 1.0: ${(pub1 as any).error}` };
  const v1 = (pub1 as any).data.publication_id;

  const sub = await docSubscribe(db, {
    subscriber_item_id: subscriberId, target_document_id: targetDocId,
    intent: "module", note: "temp verify subscription",
  }, ctx);
  if (!sub.ok) return { setupFailed: `subscribe: ${(sub as any).error}` };
  const subId = (sub as any).data.subscription_id;
  out.pinAtSubscribe = (sub as any).data.subscribed_at_version;

  // Already pinned to 1.0 -> a repoint to 1.0 must be a REFUSAL, not an ok.
  out.noop = await docRepoint(db, { subscription_id: subId, seen_version_id: v1 }, ctx);

  const ch2 = await mkChangelog("2.0");
  if (!ch2) return { setupFailed: "changelog entry 2.0" };
  const pub2 = await docPublish(db, { document_id: targetDocId, new_version: "2.0", bump_class: "major", changelog_entry_id: ch2, delta_summary: "temp" }, ctx);
  if (!pub2.ok) return { setupFailed: `publish 2.0: ${(pub2 as any).error}` };
  const v2 = (pub2 as any).data.publication_id;

  // Now pin=1.0 while current=2.0: the stale id must be refused...
  out.stale = await docRepoint(db, { subscription_id: subId, seen_version_id: v1 }, ctx);
  // ...and the current id must move the pin, confirmed by re-read (D-132).
  out.happy = await docRepoint(db, { subscription_id: subId, seen_version_id: v2, note: "live verify" }, ctx);
  const after = await db.from("gov.doc_subscriptions").select("subscribed_at_version, note").eq("id", subId).maybeSingle();
  out.pinAfter = (after.data as any)?.subscribed_at_version;
  out.noteAfter = (after.data as any)?.note;
  return out;
});

if (cycle.setupFailed) {
  check("in-project cycle (publish -> subscribe -> republish -> repoint)", false, `setup failed: ${cycle.setupFailed}`);
} else {
  check(
    "happy path: the pin moves to the current version, confirmed by re-read (D-132)",
    cycle.happy?.ok === true && cycle.pinAfter === "2.0",
    `pin ${cycle.pinAtSubscribe} -> ${cycle.pinAfter}; from=${cycle.happy?.data?.from_version} to=${cycle.happy?.data?.to_version}`
  );
  check(
    "the note is appended, never overwritten",
    typeof cycle.noteAfter === "string" && /temp verify subscription/.test(cycle.noteAfter) && /\[repointed 1\.0 -> 2\.0/.test(cycle.noteAfter),
    JSON.stringify(cycle.noteAfter)
  );
  check(
    "E_REPOINT_STALE_READ mapped (and the DETAIL passed through)",
    cycle.stale?.ok === false && /not the target's current one/.test(cycle.stale?.error ?? ""),
    (cycle.stale?.error ?? "unexpectedly ok").slice(0, 210)
  );
  check(
    "a no-op is a refusal, not a silent success",
    cycle.noop?.ok === false && /already pinned/i.test(cycle.noop?.error ?? ""),
    (cycle.noop?.error ?? "unexpectedly ok").slice(0, 190)
  );
}
const ALREADY_PINNED = "05f84ca9-3a53-455f-a492-ce883fc8fca3";

// --- 4. unknown subscription: never a mute success (REQ-GOV-102) -------------
const r4 = await probe(async (db) =>
  docRepoint(db, { subscription_id: "00000000-0000-4000-8000-000000000000", seen_version_id: "00000000-0000-4000-8000-000000000001" }, ctx)
);
check(
  "unknown subscription refused (REQ-GOV-102)",
  !r4.ok && /not readable|does not exist/.test((r4 as any).error),
  (r4 as any).error?.slice(0, 150) ?? "unexpectedly ok"
);

// --- 5. label instead of UUID -----------------------------------------------
const r5 = await probe(async (db) => docRepoint(db, { subscription_id: REPOINTABLE, seen_version_id: "1.2" }, ctx));
check("a version label is refused in place of the UUID", !r5.ok && /must be a UUID/.test((r5 as any).error), (r5 as any).error?.slice(0, 120));

// --- 6. the repoint triple on the real board-mcp project (read-only) ---------
const BOARD_MCP = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
const r6 = await probe(async (db) => docStalenessQuery(db, { project_id: BOARD_MCP, status: "all" }, ctx));
const marks = r6.ok ? (r6 as any).data.markings : [];
check(
  "doc_staleness_query carries the repoint triple on every marking",
  r6.ok && marks.every((m: any) => "target_current_version_id" in m && "repoint_applicable" in m && "subscribed_at_version" in m),
  `${marks.length} marking(s); ` +
    marks.slice(0, 3).map((m: any) => `${m.target_item_code ?? m.target_item_id.slice(0, 8)}: pin=${m.subscribed_at_version} cur=${m.target_current_version ?? "none"} applicable=${m.repoint_applicable}`).join(" | ")
);

// --- 7. nothing was committed ------------------------------------------------
const after = await runDocRw(SLUG, async (db) => {
  const { data } = await db.from("gov.doc_subscriptions").select("id, subscribed_at_version").in("id", [REPOINTABLE, ALREADY_PINNED]);
  return data as any[];
});
check(
  "every probe rolled back — production pins untouched",
  after.find((r) => r.id === REPOINTABLE)?.subscribed_at_version === r1.pinBefore,
  after.map((r) => `${r.id.slice(0, 8)}=${r.subscribed_at_version}`).join(" "),
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

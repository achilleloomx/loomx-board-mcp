// Live verification of the D-225/4bis doc_link hook against the REAL production
// DB, through the real runDocRw path. Every probe runs inside a transaction that
// is deliberately ROLLED BACK — same discipline as verify-repoint.ts.
//
// Three things here that NO unit test can establish, because the fake harness
// makes savepoint() a no-op and has no transaction semantics at all:
//
//   (1) the opt-in predicate measured on the real corpus;
//   (2) the full "first activation manual → maintenance automatic" cycle, built
//       and destroyed in one transaction;
//   (3) THE ONE THAT MATTERS: that a failing derivation cannot destroy the link
//       it was meant to enrich. Under doc_rw the whole tool call is ONE
//       transaction, so without the SAVEPOINT a failed INSERT inside the hook
//       would abort the caller's own INSERT at COMMIT. The probe forces a real
//       SQL error inside the hook and then checks the transaction is still
//       usable and the link row is still there.
//
// Run: LOOMX_DOC_RW_URL=... npx tsx tests/verify-fact-on-link.ts

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { runDocRw } = await import("../src/docDb.ts");
const { docLink } = await import("../src/docs.ts");
const { docFactSync, deriveFactOnLink, projectDecayOptIn } = await import("../src/factSync.ts");

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

function uuid(): string {
  return crypto.randomUUID();
}

// --- 0. The measure: which projects have actually opted in today -------------
const m = await probe(async (db) => {
  const subs = await db.from("gov.doc_subscriptions").select("id, subscriber_project_id, origin, status").eq("status", "active");
  const rows = (subs.data ?? []) as Array<{ subscriber_project_id: string; origin: string }>;
  const byProj = new Map<string, { fact: number; choice: number }>();
  for (const s of rows) {
    const e = byProj.get(s.subscriber_project_id) ?? { fact: 0, choice: 0 };
    if (s.origin === "fact") e.fact++;
    else e.choice++;
    byProj.set(s.subscriber_project_id, e);
  }
  const optIn = await projectDecayOptIn(db, BOARD_MCP);
  return { byProj: [...byProj.entries()], total: rows.length, optIn };
});
console.log(`\nactive subscriptions: ${m.total} across ${m.byProj.length} project(s)`);
for (const [p, e] of m.byProj) console.log(`  ${p}  fact=${e.fact} choice=${e.choice}`);
check(
  "opt-in probe agrees with the corpus for board-mcp",
  m.optIn.verified && m.optIn.opted_in === ((m.byProj.find(([p]) => p === BOARD_MCP)?.[1].fact ?? 0) > 0),
  `verified=${m.optIn.verified} opted_in=${m.optIn.opted_in}`
);

// --- 1. A new bond on the one project we belong to --------------------------
// NOTE, measured above: board-mcp already has 103 facts, i.e. it is already
// opted in, and it is the only project this agent is a member of. So this probe
// exercises the DERIVING branch live; the "no opt-in yet" branch cannot be
// reached from here without an opt-in-free project we are legitimated on — it
// stays covered by the unit tests only. Stated, not glossed over.
const r1 = await probe(async (db) => {
  const docId = uuid();
  await db.from("documents").insert({
    id: docId, project_id: BOARD_MCP, document_type: "sdes", title: "verify-fact-on-link scratch", status: "draft",
    version: "1.0", visibility: "project", owner: SLUG,
  });
  const uat = uuid(), sdes = uuid();
  await db.from("doc_items").insert({ id: uat, document_id: docId, project_id: BOARD_MCP, item_type: "uat_case", code: null, body: "scratch uat", status: "draft", owner: SLUG, sort_order: 1 });
  await db.from("doc_items").insert({ id: sdes, document_id: docId, project_id: BOARD_MCP, item_type: "sdes_entry", code: null, body: "scratch sdes", status: "draft", owner: SLUG, sort_order: 2 });
  const before = await projectDecayOptIn(db, BOARD_MCP);
  const res = await docLink(db, { target_kind: "doc", from_id: uat, to_id: sdes, relation_type: "verifies" }, ctx);
  const links = await db.from("doc_item_links").select("id").eq("from_item", uat);
  return { res, before, linkRows: (links.data ?? []).length, docId, uat, sdes };
});
check(
  "new bond on an opted-in project: link created AND the fact derived with it",
  r1.res.ok && r1.linkRows === 1 && r1.res.data.fact_subscription?.created === r1.before.opted_in,
  r1.res.ok
    ? `link rows=${r1.linkRows}, project_opted_in=${r1.res.data.fact_subscription?.project_opted_in}, note="${(r1.res.data.fact_subscription?.note ?? "").slice(0, 110)}…"`
    : `refused: ${(r1.res as any).error?.slice(0, 160)}`
);

// --- 2. The full cycle: manual activation, then automatic maintenance --------
const r2 = await probe(async (db) => {
  const docId = uuid();
  await db.from("documents").insert({
    id: docId, project_id: BOARD_MCP, document_type: "sdes", title: "verify-fact-on-link cycle", status: "draft",
    version: "1.0", visibility: "project", owner: SLUG,
  });
  const a1 = uuid(), b1 = uuid(), a2 = uuid(), b2 = uuid();
  for (const [id, type, n] of [[a1, "uat_case", 1], [b1, "sdes_entry", 2], [a2, "uat_case", 3], [b2, "sdes_entry", 4]] as const) {
    await db.from("doc_items").insert({ id, document_id: docId, project_id: BOARD_MCP, item_type: type, code: null, body: `cycle ${n}`, status: "draft", owner: SLUG, sort_order: n });
  }
  // First bond, made BEFORE any activation: no fact.
  const pre = await docLink(db, { target_kind: "doc", from_id: a1, to_id: b1, relation_type: "verifies" }, ctx);
  const optInBefore = await projectDecayOptIn(db, BOARD_MCP);

  // The manual activation act (this is doc_fact_sync, exactly as D-225 point 4
  // requires) — scoped by limit so it stays a bounded probe.
  const sync = await docFactSync(db, { project_id: BOARD_MCP }, ctx);
  const optInAfter = await projectDecayOptIn(db, BOARD_MCP);

  // Second bond, made AFTER activation: the hook must derive it by itself.
  const post = await docLink(db, { target_kind: "doc", from_id: a2, to_id: b2, relation_type: "verifies" }, ctx);
  const derived = await db.from("gov.doc_subscriptions").select("id, origin, intent, subscribed_at_version, status").eq("subscriber_item_id", a2).maybeSingle();
  return { pre, sync, post, optInBefore, optInAfter, derived: derived.data };
});
check(
  "manual activation then automatic maintenance, in one transaction",
  r2.sync.ok &&
    r2.optInAfter.opted_in === true &&
    r2.post.ok &&
    r2.post.data.fact_subscription?.created === true &&
    (r2.derived as any)?.origin === "fact" &&
    (r2.derived as any)?.intent === "critical",
  r2.sync.ok
    ? `sync created=${r2.sync.data.counts.created}; opt-in ${r2.optInBefore.opted_in}→${r2.optInAfter.opted_in}; ` +
      `post-link derived=${r2.post.ok ? r2.post.data.fact_subscription?.created : "n/a"} ` +
      `row=${JSON.stringify(r2.derived ?? null)}`
    : `sync refused: ${(r2.sync as any).error?.slice(0, 160)}`
);
check(
  "the bond made BEFORE activation is picked up by that activation, not left behind",
  r2.pre.ok && r2.sync.ok && r2.sync.data.counts.created >= 1,
  r2.pre.ok ? `pre-link fact=${r2.pre.data.fact_subscription?.created}, sync created=${r2.sync.ok ? r2.sync.data.counts.created : "n/a"}` : "pre-link refused"
);

// --- 3. THE ONE THAT MATTERS: a failing derivation must not poison the tx ----
// A real FK violation inside the hook (target_item_id pointing at a row that
// does not exist), then two questions: is the transaction still usable, and is
// the earlier work still there? Without the SAVEPOINT both answers are "no".
const r3 = await probe(async (db) => {
  const docId = uuid();
  await db.from("documents").insert({
    id: docId, project_id: BOARD_MCP, document_type: "sdes", title: "verify-fact-on-link savepoint", status: "draft",
    version: "1.0", visibility: "project", owner: SLUG,
  });
  const uat = uuid();
  await db.from("doc_items").insert({ id: uat, document_id: docId, project_id: BOARD_MCP, item_type: "uat_case", code: null, body: "sp", status: "draft", owner: SLUG, sort_order: 1 });

  const outcome = await deriveFactOnLink(db, {
    from_id: uat,
    from_project_id: BOARD_MCP,
    from_code: "SCRATCH",
    to_id: uuid(), // deliberately nonexistent → FK violation on insert
    to_project_id: BOARD_MCP,
    to_document_id: docId,
    to_code: null,
    relation_type: "verifies",
    cross_project: false,
  });
  // Is the transaction still alive after the hook blew up?
  const after = await db.from("doc_items").select("id").eq("id", uat).maybeSingle();
  return { outcome, txAlive: !after.error && (after.data as any)?.id === uat, err: after.error?.message };
});
check(
  "a failing derivation is contained: transaction survives, nothing is lost",
  r3.outcome?.created === false && r3.txAlive,
  `outcome.created=${r3.outcome?.created}, tx usable afterwards=${r3.txAlive}${r3.err ? ` (${r3.err})` : ""}, note="${(r3.outcome?.note ?? "").slice(0, 110)}…"`
);

// --- 4. Nothing was left behind ---------------------------------------------
const r4 = await probe(async (db) => {
  // pg-shim has no LIKE comparator — read the titles and filter here.
  const docs = await db.from("documents").select("id, title").eq("project_id", BOARD_MCP);
  const rows = (docs.data ?? []) as Array<{ title: string }>;
  return { leftovers: rows.filter((d) => (d.title ?? "").startsWith("verify-fact-on-link")).length };
});
check("no residue from any probe", r4.leftovers === 0, `documents matching 'verify-fact-on-link%': ${r4.leftovers}`);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

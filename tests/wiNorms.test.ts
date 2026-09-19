// T2 minimo — SDES-005 v1 / REQ-028 / REQ-032: due Decisions at wi_start as a
// DIFFERENCE against the session epoch, the whole due set per WI, the grace
// and hard phases, wi_resume, the flag. No DB: tiny supabase-js-shaped fake +
// the in-memory SessionStore.
//
// Run: npx tsx --test tests/wiNorms.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import { wiStart, wiResume, wiPause } from "../src/wi.ts";
import {
  diffAgainstEpoch,
  codesOf,
  resolveCurrentSession,
  fetchApplicableNorms,
  type Norm,
  type HostInfo,
} from "../src/sessionNorms.ts";
import { wiNormsEnabledFor, wiNormsHardGateFor } from "../src/flags.ts";
import { PgQuery, type PgExecutor } from "../src/pg-shim.ts";
import { makeMemoryStore } from "./memorySessionStore.ts";

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

const P_CRIT = "00000000-0000-4000-9000-00000000c001";
const P_T2 = "00000000-0000-4000-9000-00000000c002";
const P_T3 = "00000000-0000-4000-9000-00000000c003";
const WS_A = "00000000-0000-4000-9000-0000000000aa";
const WS_B = "00000000-0000-4000-9000-0000000000bb";

function norm(projectId: string, slug: string, code: string, version: string, sources: string[]): Norm {
  return { code, version, grade: 2, grade_source: "source", title: `t-${code}`, summary: null, source: { thread_slug: slug, project_id: projectId }, sources };
}
const CRIT = norm(P_CRIT, "thr-crit", "C-001", "1.0", ["critical"]);
const T2 = norm(P_T2, "thr-2", "D-001", "1.0", ["workspace_thread:thr-2"]);
const T3 = norm(P_T3, "thr-3", "D-001", "1.0", ["workspace_thread:thr-3"]); // homonym of T2 (D-167)

let seq = 0;
function makeDb(store: Store, dueByProject: Record<string, Norm[]>, rpcCalls: Row[] = []): SupabaseClient {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    let limitN: number | null = null;
    const run = async () => {
      store[table] ??= [];
      if (op === "insert") {
        const row = { id: `id-${++seq}`, ...payload };
        store[table]!.push(row);
        return { data: [row], error: null };
      }
      let rows = store[table]!.filter((r) => filters.every(([c, v]) => r[c] === v));
      if (op === "update") rows.forEach((r) => Object.assign(r, payload));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    const b: any = {
      select: () => b,
      insert: (d: Row) => ((op = "insert"), (payload = d), b),
      update: (d: Row) => ((op = "update"), (payload = d), b),
      eq: (c: string, v: unknown) => (filters.push([c, v]), b),
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: async () => {
        const r = await run();
        return { data: (r.data as Row[])[0] ?? null, error: null };
      },
      then: (res: any, rej: any) => run().then(res, rej),
    };
    return b;
  }
  return {
    from: query,
    rpc: async (fn: string, params: Row) => {
      rpcCalls.push({ fn, ...params });
      const key = (params.p_project_id as string | undefined) ?? "__critical__";
      const norms = dueByProject[key];
      if (!norms) return { data: null, error: { message: "boom" } };
      return {
        data: { norms, critical_threads: ["thr-crit"], critical_core_unpublished: [], critical_registry_empty: false, houses_unresolved: [] },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
}

const host: HostInfo = { hostPid: 4242, bootedAt: new Date(Date.now() - 1000), envSessionId: "ENV-S" };

function seedGtd(store: Store, id: string, projectId?: string) {
  (store.loomx_items ??= []).push({ id, owner: "dev-frame", gtd_status: "next_action" });
  if (projectId) (store.loomx_item_projects ??= []).push({ item_id: id, project_id: projectId });
}

async function closeWi(store: Store, wiId: string) {
  store.loomx_work_items!.find((w) => w.id === wiId)!.status = "done";
}

// ---- the flag: a non-pilot is untouched ----

test("no norms deps (agent not covered by the flag) -> wi_start response and side effects identical to today", async () => {
  const store: Store = {};
  const calls: Row[] = [];
  seedGtd(store, "g1", WS_A);
  const res = await wiStart(makeDb(store, {}, calls), { intent: "x", gtd_item_id: "g1" }, { selfSlug: "dev-frame", isLoomy: false });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(Object.keys(res.data).sort(), ["gtd_created", "gtd_item_id", "wi_id"]);
  assert.equal(calls.length, 0, "no RPC call at all");
  assert.equal(store.loomx_work_items![0]!.in_flight_state, undefined);
});

test("LOOMX_WI_NORMS: default pilots; off; all; custom list; a typo never widens the rollout; hard gate off by default", () => {
  const env = process.env;
  const saved = { a: env.LOOMX_WI_NORMS, b: env.LOOMX_WI_NORMS_PILOTS, c: env.LOOMX_WI_NORMS_HARD_SLUGS };
  try {
    delete env.LOOMX_WI_NORMS; delete env.LOOMX_WI_NORMS_PILOTS; delete env.LOOMX_WI_NORMS_HARD_SLUGS;
    assert.equal(wiNormsEnabledFor("dev-frame"), true);
    assert.equal(wiNormsEnabledFor("acme-lab"), true);
    assert.equal(wiNormsEnabledFor("analyst-pieroni"), true);
    assert.equal(wiNormsEnabledFor("board-mcp"), false);
    assert.equal(wiNormsHardGateFor("dev-frame"), false);
    env.LOOMX_WI_NORMS = "off"; assert.equal(wiNormsEnabledFor("dev-frame"), false);
    env.LOOMX_WI_NORMS = "al"; assert.equal(wiNormsEnabledFor("dev-frame"), false);
    env.LOOMX_WI_NORMS = "all"; assert.equal(wiNormsEnabledFor("board-mcp"), true);
    env.LOOMX_WI_NORMS = "pilots"; env.LOOMX_WI_NORMS_PILOTS = "pilot-e2e, dba";
    assert.equal(wiNormsEnabledFor("dba"), true); assert.equal(wiNormsEnabledFor("dev-frame"), false);
    env.LOOMX_WI_NORMS_HARD_SLUGS = "dba,dev-frame";
    assert.equal(wiNormsHardGateFor("dba"), true);
    assert.equal(wiNormsHardGateFor("dev-frame"), false, "hard gate never reaches an agent the norms flag does not cover");
  } finally {
    for (const [k, v] of [["LOOMX_WI_NORMS", saved.a], ["LOOMX_WI_NORMS_PILOTS", saved.b], ["LOOMX_WI_NORMS_HARD_SLUGS", saved.c]] as const) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
  }
});

// ---- UAT-017 / UAT-018 / UAT-020 shapes ----

test("two consecutive WIs, same epoch: WI-2 gets only the new Decisions; gov.wi_norms holds the WHOLE due set; homonyms stay two rows", async () => {
  const store: Store = {};
  const sess = makeMemoryStore();
  await sess.openEpoch("S1", "startup", 4242);
  await sess.recordDelivered({ id: "S1", epoch: 1 }, [CRIT], "compact"); // hook delivered the core
  seedGtd(store, "gA", WS_A);
  seedGtd(store, "gB", WS_B);
  const db = makeDb(store, { [WS_A]: [CRIT, T2], [WS_B]: [CRIT, T2, T3] });
  const ctx = { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: false } };

  const w1 = await wiStart(db, { intent: "one", gtd_item_id: "gA" }, ctx);
  if (!w1.ok) return assert.fail(w1.error);
  assert.deepEqual(w1.data.delivered!.map((n) => n.code), ["D-001"]);
  assert.deepEqual(w1.data.already_in_session, ["C-001"]);
  assert.equal(w1.data.critical_core_delivered_at_wi_start, false);
  assert.equal(w1.data.list_bytes, Buffer.byteLength(JSON.stringify(w1.data.delivered)));
  assert.deepEqual(w1.data.norms_session, { id: "S1", epoch: 1 });
  await closeWi(store, w1.data.wi_id);

  const w2 = await wiStart(db, { intent: "two", gtd_item_id: "gB" }, ctx);
  if (!w2.ok) return assert.fail(w2.error);
  assert.deepEqual(w2.data.delivered!.map((n) => n.source.thread_slug), ["thr-3"], "only T3 is new");
  assert.deepEqual(w2.data.already_in_session, ["C-001", "thr-2:D-001"], "homonym qualified, never merged");
  const rows = sess.wiNorms.filter((r) => r.wi_id === w2.data.wi_id);
  assert.equal(rows.length, 3, "whole due set, not the difference");
  assert.equal(new Set(rows.map((r) => r.key)).size, 3);
  assert.equal(JSON.stringify(w2.data).includes('"body"'), false);
});

test("REQ-032 grace: epoch without the core -> WI opens, core inside delivered, critical_core_delivered_at_wi_start:true", async () => {
  const store: Store = {};
  const sess = makeMemoryStore();
  seedGtd(store, "gA", WS_A);
  const db = makeDb(store, { [WS_A]: [CRIT, T2] });
  const res = await wiStart(db, { intent: "x", gtd_item_id: "gA" }, { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: false } });
  if (!res.ok) return assert.fail(res.error);
  assert.equal(res.data.critical_core_delivered_at_wi_start, true);
  assert.deepEqual(res.data.delivered!.map((n) => n.code), ["C-001", "D-001"]);
  assert.equal(sess.epochs[0]!.trigger, "mcp_implicit", "no hook -> the process opens its own epoch to record into");
  assert.equal(sess.epochs[0]!.id, "ENV-S");
});

test("REQ-032 hard (flag, off by default): core missing -> refused with explicit code, NOTHING written; after delivery the same wi_start opens", async () => {
  const store: Store = {};
  const sess = makeMemoryStore();
  seedGtd(store, "gA", WS_A);
  const db = makeDb(store, { [WS_A]: [CRIT, T2] });
  const ctx = { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: true } };
  const refused = await wiStart(db, { intent: "x", gtd_item_id: "gA" }, ctx);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /^E_CRITICAL_CORE_MISSING: .*C-001.*agent_context\(\)/);
  assert.equal((store.loomx_work_items ?? []).length, 0);
  assert.equal(store.loomx_items![0]!.gtd_status, "next_action", "GTD untouched by a refusal");
  assert.equal(sess.wiNorms.length, 0);

  await sess.recordDelivered({ id: sess.epochs[0]!.id, epoch: 1 }, [CRIT], "full"); // = agent_context()
  const ok = await wiStart(db, { intent: "x", gtd_item_id: "gA" }, ctx);
  assert.equal(ok.ok, true);
});

test("a Thread republishes between two WIs -> the changed Decision comes back in delivered at the new version", async () => {
  const store: Store = {};
  const sess = makeMemoryStore();
  await sess.openEpoch("S1", "startup", 4242);
  await sess.recordDelivered({ id: "S1", epoch: 1 }, [CRIT, T2], "compact");
  seedGtd(store, "gA", WS_A);
  const db = makeDb(store, { [WS_A]: [CRIT, { ...T2, version: "1.1" }] });
  const res = await wiStart(db, { intent: "x", gtd_item_id: "gA" }, { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: false } });
  if (!res.ok) return assert.fail(res.error);
  assert.deepEqual(res.data.delivered!.map((n) => `${n.code}@${n.version}`), ["D-001@1.1"]);
  assert.equal((await sess.readDelivered({ id: "S1", epoch: 1 })).has(`${P_T2}:D-001@1.1`), true);
});

test("GTD without project -> critical core only, houses_unresolved names it; no p_project_id sent", async () => {
  const store: Store = {};
  const calls: Row[] = [];
  const sess = makeMemoryStore();
  const db = makeDb(store, { __critical__: [CRIT] }, calls);
  const res = await wiStart(db, { intent: "auto-created GTD" }, { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: false } });
  if (!res.ok) return assert.fail(res.error);
  assert.deepEqual(res.data.houses_unresolved, ["<no project>"]);
  assert.deepEqual(calls, [{ fn: "gov.applicable_norms", p_agent: "dev-frame" }]);
});

test("RPC down -> norms_unavailable, the WI opens anyway; registry down -> whole set delivered + warning", async () => {
  const store: Store = {};
  seedGtd(store, "gA", WS_A);
  const sess = makeMemoryStore();
  const down = await wiStart(makeDb(store, {}), { intent: "x", gtd_item_id: "gA" }, { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: true } });
  if (!down.ok) return assert.fail(down.error);
  assert.equal(down.data.norms_unavailable, "boom");
  assert.equal(down.data.delivered, undefined);
  await closeWi(store, down.data.wi_id);

  const broken = makeMemoryStore();
  broken.findEpochs = async () => { throw new Error("relation gov.session_epochs does not exist"); };
  broken.writeWiNorms = async () => { throw new Error("relation gov.wi_norms does not exist"); };
  const res = await wiStart(makeDb(store, { [WS_A]: [CRIT, T2] }), { intent: "y", gtd_item_id: "gA" }, { selfSlug: "dev-frame", isLoomy: false, norms: { store: broken, host, hardGate: true } });
  if (!res.ok) return assert.fail(res.error);
  assert.equal(res.data.delivered!.length, 2);
  assert.equal(res.data.norms_session, null);
  assert.match(res.data.norms_registry_warning!, /session registry unavailable.*\| gov\.wi_norms not written/);
});

test("loomy opening a WI for another agent: no norms (the session is the caller's, not the target's)", async () => {
  const store: Store = {};
  const calls: Row[] = [];
  const res = await wiStart(makeDb(store, { __critical__: [CRIT] }, calls), { intent: "x", agent_slug: "dev-frame" }, { selfSlug: "loomy", isLoomy: true, norms: { store: makeMemoryStore(), host, hardGate: false } });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0);
});

// ---- wi_resume (dba Q1) ----

test("wi_resume: same epoch -> norms_epoch_unchanged, nothing re-delivered; after /clear (new epoch) -> difference recomputed; gov.wi_norms never rewritten", async () => {
  const store: Store = {};
  const sess = makeMemoryStore();
  await sess.openEpoch("S1", "startup", 4242);
  await sess.recordDelivered({ id: "S1", epoch: 1 }, [CRIT], "compact");
  seedGtd(store, "gA", WS_A);
  const db = makeDb(store, { [WS_A]: [CRIT, T2] });
  const ctx = { selfSlug: "dev-frame", isLoomy: false, norms: { store: sess, host, hardGate: false } };
  const w = await wiStart(db, { intent: "x", gtd_item_id: "gA" }, ctx);
  if (!w.ok) return assert.fail(w.error);
  const wiNormsBefore = JSON.stringify(sess.wiNorms);

  await wiPause(db, { wi_id: w.data.wi_id }, ctx);
  const same = await wiResume(db, { wi_id: w.data.wi_id }, ctx);
  if (!same.ok) return assert.fail(same.error);
  assert.equal(same.data.norms_epoch_unchanged, true);
  assert.equal(same.data.delivered, undefined);

  await wiPause(db, { wi_id: w.data.wi_id }, ctx);
  await sess.openEpoch("S2", "clear", 4242); // hook after /clear: new session id, same host pid
  await sess.recordDelivered({ id: "S2", epoch: 1 }, [CRIT], "compact");
  const after = await wiResume(db, { wi_id: w.data.wi_id }, ctx);
  if (!after.ok) return assert.fail(after.error);
  assert.deepEqual(after.data.delivered!.map((n) => n.code), ["D-001"], "non-critical Decision of the previous epoch comes back (UAT-019 p.3)");
  assert.deepEqual(after.data.already_in_session, ["C-001"]);
  assert.deepEqual(store.loomx_work_items![0]!.in_flight_state.norms_session, { id: "S2", epoch: 1 });
  assert.equal(JSON.stringify(sess.wiNorms), wiNormsBefore);
});

// ---- which session does this process serve? ----

test("resolveCurrentSession: own host_pid wins; a sibling session's epoch (different host_pid) is NEVER adopted", async () => {
  const sess = makeMemoryStore();
  await sess.openEpoch("MINE", "startup", 4242);
  await sess.openEpoch("SIBLING", "startup", 9999); // later, concurrent session of the same agent
  assert.deepEqual(await resolveCurrentSession(sess, "dev-frame", host), { id: "MINE", epoch: 1, implicit: false });

  const onlySibling = makeMemoryStore();
  await onlySibling.openEpoch("SIBLING", "startup", 9999);
  const r = await resolveCurrentSession(onlySibling, "dev-frame", host);
  assert.deepEqual(r, { id: "ENV-S", epoch: 1, implicit: true });
});

test("resolveCurrentSession: epochs older than this process are not its own; host_pid NULL is the declared fallback", async () => {
  const sess = makeMemoryStore();
  await sess.openEpoch("OLD", "startup", 4242);
  sess.epochs[0]!.opened_at = new Date(Date.now() - 3_600_000).toISOString();
  assert.equal((await resolveCurrentSession(sess, "dev-frame", host)).implicit, true);

  const nullPid = makeMemoryStore();
  await nullPid.openEpoch("H", "resume", null);
  assert.deepEqual(await resolveCurrentSession(nullPid, "dev-frame", host), { id: "H", epoch: 1, implicit: false });
});

// ---- pure pieces ----

test("diffAgainstEpoch keys on (project, code), never the bare code", () => {
  const d = diffAgainstEpoch([T2, T3], new Set([`${P_T2}:D-001@1.0`]));
  assert.deepEqual(d.already, [T2]);
  assert.deepEqual(d.delivered, [T3]);
  assert.deepEqual(codesOf([CRIT, T2], [CRIT, T2]), ["C-001", "D-001"], "unambiguous codes stay bare");
});

test("fetchApplicableNorms: a row that cannot be keyed fails the whole set (never a silently shorter list)", async () => {
  const db = { rpc: async () => ({ data: { norms: [{ code: "X", source: {} }] }, error: null }) } as unknown as SupabaseClient;
  const res = await fetchApplicableNorms(db, "dev-frame", null);
  assert.equal(res.ok, false);
});

// ---- pg-shim opt-ins used by the doc_rw store ----

test("pg-shim: noSyntheticId keeps `id` out of an id-less table; ignoreDuplicates emits DO NOTHING; defaults unchanged", async () => {
  const calls: string[] = [];
  const exec: PgExecutor = async (sql) => (calls.push(sql), { rows: [] });
  await new PgQuery(exec, "gov.session_epochs", { noReturning: true }).insert({ session_id: "s", epoch: 1 }, { noSyntheticId: true });
  await new PgQuery(exec, "gov.wi_norms", { noReturning: true }).upsert({ wi_id: "w", code: "c" }, { onConflict: "wi_id,code", ignoreDuplicates: true, noSyntheticId: true });
  await new PgQuery(exec, "t", { noReturning: true }).insert({ a: 1 });
  assert.equal(calls[0], 'INSERT INTO "gov"."session_epochs" ("session_id", "epoch") VALUES ($1, $2)');
  assert.equal(calls[1], 'INSERT INTO "gov"."wi_norms" ("wi_id", "code") VALUES ($1, $2) ON CONFLICT ("wi_id", "code") DO NOTHING');
  assert.match(calls[2]!, /^INSERT INTO "t" \("id", "a"\)/);
});

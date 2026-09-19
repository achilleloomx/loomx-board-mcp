// Unit tests for src/agentContext.ts — agent_context() (SDES-001, MaaS fase 0,
// msg frame f7ff99d9). No DB connection needed: hand-built fake mimicking the
// subset of supabase-js used (same pattern as tests/wi.test.ts).
//
// Run: npx tsx --test tests/agentContext.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import { agentContext, buildRoleCard, renderCompact } from "../src/agentContext.ts";
import { makeMemoryStore } from "./memorySessionStore.ts";

type Row = Record<string, unknown>;
type Store = { [table: string]: Row[] };

function makeDb(
  store: Store,
  opts: { rpc?: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> } = {}
): SupabaseClient {
  function query(table: string) {
    const filters: Array<{ col: string; val: unknown; op: string }> = [];
    const orders: string[] = [];
    let limitN: number | null = null;
    let cols: string[] | null = null; // null = "*" (no projection, real-world default)

    const applyFilters = (rows: Row[]): Row[] =>
      rows.filter((r) =>
        filters.every((f) => {
          if (f.op === "eq") return r[f.col] === f.val;
          if (f.op === "neq") return r[f.col] !== f.val;
          if (f.op === "is-null") return (r[f.col] ?? null) === null;
          if (f.op === "is-not-null") return (r[f.col] ?? null) !== null;
          if (f.op === "not-in") return !(f.val as unknown[]).includes(r[f.col]);
          return true;
        })
      );

    // Mirrors real Postgres/PostgREST select-projection: a `.select("a, b")`
    // returns ONLY those columns — this is exactly what agentContext.ts
    // relies on to keep body/JSONB blobs out of the payload, so the fake must
    // honor it, not just accept-and-ignore the column list.
    const project = (row: Row): Row => {
      if (!cols) return row;
      const out: Row = {};
      for (const c of cols) if (c in row) out[c] = row[c];
      return out;
    };

    const execute = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
      store[table] ??= [];
      let rows = applyFilters(store[table]);
      // priority_rank DESC, deadline ASC (nulls last) — matches gtd_inbox ordering,
      // good enough fidelity for these tests without a real ORDER BY.
      if (orders.includes("priority_rank")) {
        rows = [...rows].sort((a, b) => Number(b.priority_rank ?? 0) - Number(a.priority_rank ?? 0));
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows.map(project), error: null };
    };

    const builder: any = {
      select(colsArg?: string) {
        if (colsArg && colsArg.trim() !== "*") {
          cols = colsArg.split(",").map((c) => c.trim());
        }
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val, op: "eq" });
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push({ col, val, op: "neq" });
        return builder;
      },
      not(col: string, operator: string, val: unknown) {
        if (operator === "in" && typeof val === "string") {
          const items = val.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
          filters.push({ col, val: items, op: "not-in" });
        } else if (operator === "is" && val === null) {
          filters.push({ col, val, op: "is-not-null" });
        }
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push({ col, val, op: val === null ? "is-null" : "eq" });
        return builder;
      },
      order(col: string) {
        orders.push(col);
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        const r = await execute();
        if (r.error) return r;
        const row = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        return { data: row ?? null, error: null };
      },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void, reject?: (e: unknown) => void) {
        execute().then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from: (table: string) => query(table),
    rpc: opts.rpc ?? (async () => ({ data: null, error: { message: 'function "gov.applicable_norms" does not exist' } })),
  } as unknown as SupabaseClient;
}

const ctx = {
  selfSlug: "board-mcp",
  slugToCode: new Map([["board-mcp", "005"], ["loomy", "001"], ["frame", "052"]]),
  codeToSlug: new Map([["005", "board-mcp"], ["001", "loomy"], ["052", "frame"]]),
};

// ---- buildRoleCard (shared with org_lookup(agent=self, question="card")) ----

test("buildRoleCard: no org-registry data -> explicit note, never a silent empty shape", async () => {
  const db = makeDb({ loomx_role_cards: [], loomx_org_edges: [] });
  const res = await buildRoleCard(db, "board-mcp");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.role_card, null);
  assert.equal(res.data.note, "no org-registry data for this agent yet (F2 seed pending?)");
});

test("buildRoleCard: card + edges present -> reports_to/escalates_to/asks_help_from split correctly", async () => {
  const db = makeDb({
    loomx_role_cards: [{ agent_slug: "board-mcp", mission: "Board MCP dev", human_ref: "achille" }],
    loomx_org_edges: [
      { from_agent: "board-mcp", to_agent: "loomy", edge_type: "reports_to", domain: null, note: null },
      { from_agent: "board-mcp", to_agent: "dba", edge_type: "escalates_to", domain: "database", note: null },
      { from_agent: "board-mcp", to_agent: "forge", edge_type: "asks_help_from", domain: null, note: null },
    ],
  });
  const res = await buildRoleCard(db, "board-mcp");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.reports_to, "loomy");
  assert.equal(res.data.escalates_to.length, 1);
  assert.equal(res.data.asks_help_from.length, 1);
  assert.equal(res.data.role_card?.mission, "Board MCP dev");
});

// ---- constitution (single RPC, fail-open) ----

// ---- critical_core + session (SDES-001 v1) ----

const T_CRIT = "00000000-0000-4000-9000-00000000c001";

function v1Rpc(norms: unknown[], extra: Record<string, unknown> = {}) {
  return async (fn: string, params: Record<string, unknown>) => {
    assert.equal(fn, "gov.applicable_norms");
    assert.deepEqual(Object.keys(params), ["p_agent"], "critical core = every other parameter left NULL");
    assert.equal(params.p_agent, "board-mcp");
    return {
      data: { norms, critical_threads: ["thr-x"], critical_core_unpublished: [], critical_registry_empty: false, houses_unresolved: [], ...extra },
      error: null,
    };
  };
}

const NORM_A = {
  code: "X-001", version: "1.2", grade: 2, grade_source: "source", title: "Titolo", summary: "Riassunto",
  source: { thread_slug: "thr-x", project_id: T_CRIT, document_id: "doc-1" }, sources: ["critical"],
  body: "MUST NEVER LEAK",
};

test("agent_context v1: RPC missing -> critical_core:null + critical_core_unavailable, payload still useful", async () => {
  const res = await agentContext(makeDb({}), ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.payload_version, "1");
  assert.equal(res.data.critical_core, null);
  assert.match(res.data.critical_core_unavailable ?? "", /does not exist/);
  assert.deepEqual(res.data.constitution, { deprecated: true, see: "critical_core" });
  assert.ok(res.data.work);
});

test("agent_context v1: norms carry exactly the contract keys — no body at any level (UAT-005)", async () => {
  const res = await agentContext(makeDb({}, { rpc: v1Rpc([NORM_A]) }), ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const cc = res.data.critical_core!;
  assert.deepEqual(Object.keys(cc.norms[0]!).sort(), ["code", "grade", "grade_source", "source", "summary", "title", "version"]);
  assert.equal(JSON.stringify(res.data).includes("MUST NEVER LEAK"), false);
  assert.equal(JSON.stringify(res.data).includes('"body"'), false);
  assert.deepEqual(cc.critical_threads, ["thr-x"]);
  assert.equal(cc.core_bytes, Buffer.byteLength(JSON.stringify(cc.norms)));
  assert.equal(res.data.critical_core_unavailable, undefined);
});

test("agent_context v1: declared absences pass through (unpublished Threads, empty registry)", async () => {
  const res = await agentContext(
    makeDb({}, { rpc: v1Rpc([], { critical_core_unpublished: ["thr-x", "thr-y"], critical_registry_empty: true }) }),
    ctx
  );
  if (!res.ok) return assert.fail();
  assert.deepEqual(res.data.critical_core!.norms, []);
  assert.deepEqual(res.data.critical_core!.critical_core_unpublished, ["thr-x", "thr-y"]);
  assert.equal(res.data.critical_core!.critical_registry_empty, true);
});

test("agent_context v1: a live v0 RPC answer is DECLARED (rpc_contract_version), never read as 'v1 says empty'", async () => {
  const res = await agentContext(
    makeDb({}, { rpc: async () => ({ data: { contract_version: "v0", applicable_norms: [], constitution_unpublished: true }, error: null }) }),
    ctx
  );
  if (!res.ok) return assert.fail();
  assert.equal(res.data.critical_core!.rpc_contract_version, "v0");
});

test("agent_context v1: no session mode -> session:null + session_unavailable (declared)", async () => {
  const res = await agentContext(makeDb({}, { rpc: v1Rpc([NORM_A]) }), ctx);
  if (!res.ok) return assert.fail();
  assert.equal(res.data.session, null);
  assert.match(res.data.session_unavailable ?? "", /not configured/);
});

test("agent_context v1 'open' (board-cli): every run opens a NEW epoch and records what it delivered", async () => {
  const store = makeMemoryStore();
  const db = makeDb({}, { rpc: v1Rpc([NORM_A]) });
  const open = (trigger: "startup" | "clear") =>
    agentContext(db, ctx, { kind: "open", store, sessionId: "S1", trigger, hostPid: 4242 }, "compact");
  const r1 = await open("startup");
  const r2 = await open("clear");
  if (!r1.ok || !r2.ok) return assert.fail();
  assert.deepEqual(r1.data.session, { id: "S1", epoch: 1 });
  assert.deepEqual(r2.data.session, { id: "S1", epoch: 2 });
  assert.deepEqual(store.epochs.map((e) => e.trigger), ["startup", "clear"]);
  assert.deepEqual([...(await store.readDelivered({ id: "S1", epoch: 2 }))], [`${T_CRIT}:X-001@1.2`]);
  assert.equal(store.delivered.every((d) => d.form === "compact"), true);
});

test("agent_context v1 'current' (MCP tool): re-delivers inside the hook's epoch, never opens a new one", async () => {
  const store = makeMemoryStore();
  const db = makeDb({}, { rpc: v1Rpc([NORM_A]) });
  await agentContext(db, ctx, { kind: "open", store, sessionId: "S1", trigger: "startup", hostPid: 4242 });
  const host = { hostPid: 4242, bootedAt: new Date(Date.now() - 1000), envSessionId: "S1" };
  const a = await agentContext(db, ctx, { kind: "current", store, host });
  const b = await agentContext(db, ctx, { kind: "current", store, host });
  if (!a.ok || !b.ok) return assert.fail();
  assert.deepEqual(a.data.session, { id: "S1", epoch: 1 });
  assert.deepEqual(b.data.session, { id: "S1", epoch: 1 });
  assert.equal(store.epochs.length, 1);
  assert.equal(store.delivered.length, 1, "idempotent on (session, epoch, project, code)");
});

test("agent_context v1: registry write fails -> session:null + session_unavailable, core still delivered", async () => {
  const store = makeMemoryStore();
  store.openEpoch = async () => { throw new Error("relation gov.session_epochs does not exist"); };
  const res = await agentContext(makeDb({}, { rpc: v1Rpc([NORM_A]) }), ctx, { kind: "open", store, sessionId: "S1", trigger: "startup", hostPid: null });
  if (!res.ok) return assert.fail();
  assert.equal(res.data.session, null);
  assert.match(res.data.session_unavailable ?? "", /does not exist/);
  assert.equal(res.data.critical_core!.norms.length, 1);
});

test("renderCompact: role header (3 lines), one line per Decision, declared absences, no JSON", async () => {
  const store = makeMemoryStore();
  const db = makeDb(
    { loomx_role_cards: [{ agent_slug: "board-mcp", mission: "Board MCP dev", human_ref: "achille" }] },
    { rpc: v1Rpc([NORM_A], { critical_core_unpublished: ["thr-y"] }) }
  );
  const res = await agentContext(db, ctx, { kind: "open", store, sessionId: "S1", trigger: "compact", hostPid: null }, "compact");
  if (!res.ok) return assert.fail();
  const lines = renderCompact(res.data).split("\n");
  assert.match(lines[0]!, /board-mcp \(005\) — Board MCP dev/);
  assert.match(lines[2]!, /sessione S1 · epoca 1/);
  assert.ok(lines.includes("X-001 v1.2 [thr-x] Titolo — Riassunto"));
  assert.ok(lines.some((l) => /senza pubblicazione → thr-y/.test(l)));
  assert.equal(lines.some((l) => l.includes("{")), false);
});

// ---- work: active WI, GTD top-5, pending_inbox/wakes ----

test("agent_context: no active WI -> active_wi null (explicit, not omitted)", async () => {
  const db = makeDb({ loomx_work_items: [] });
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.work.active_wi, null);
});

test("agent_context: active WI present -> surfaced with no heavy JSONB fields", async () => {
  const db = makeDb({
    loomx_work_items: [
      { id: "wi-1", agent_slug: "board-mcp", status: "active", intent: "do the thing", template_name: "fix-bug", started_at: "2026-09-15T00:00:00Z", pre_conditions: { huge: true } },
    ],
  });
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal((res.data.work.active_wi as any)?.id, "wi-1");
  assert.equal((res.data.work.active_wi as any)?.pre_conditions, undefined, "no raw JSONB blob in the payload");
});

test("agent_context: armed_gtd/next_actions are two separate lists (autopilot=true vs gtd_status=next_action), excludes done/trash, no body field, each capped at 5", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      id: `g-armed-${i}`,
      owner: "board-mcp",
      title: `armed ${i}`,
      body: "should never appear",
      gtd_status: "waiting",
      autopilot: true,
      autopilot_model: "sonnet",
      priority_rank: 10 - i,
    });
  }
  rows.push({ id: "g-next", owner: "board-mcp", title: "next action", gtd_status: "next_action", autopilot: false, priority_rank: 1, deadline: null });
  rows.push({ id: "g-plain", owner: "board-mcp", title: "plain waiting", gtd_status: "waiting", autopilot: false, priority_rank: 20 });
  rows.push({ id: "g-done", owner: "board-mcp", title: "done", gtd_status: "done", autopilot: true, priority_rank: 99 });

  const db = makeDb({ loomx_items: rows });
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const armed = res.data.work.armed_gtd;
  const next = res.data.work.next_actions;
  assert.equal(armed.length, 5, "armed_gtd capped at top 5");
  assert.equal(next.length, 1, "next_actions has just the one next_action row");
  assert.ok(armed.every((r: any) => "body" in r === false), "no body field anywhere in armed_gtd");
  assert.ok(next.every((r: any) => "body" in r === false), "no body field anywhere in next_actions");
  assert.deepEqual(Object.keys(armed[0]).sort(), ["autopilot_model", "id", "priority", "title"], "armed_gtd rows are the narrow shape from SDES-001");
  assert.deepEqual(Object.keys(next[0]).sort(), ["deadline", "id", "priority", "title"], "next_actions rows are the narrow shape from SDES-001");
  assert.ok(!armed.some((r: any) => r.id === "g-done"), "done items excluded even if autopilot=true");
  assert.ok(!armed.some((r: any) => r.id === "g-plain"), "plain waiting (not armed) excluded from armed_gtd");
  assert.ok(!next.some((r: any) => r.id === "g-plain"), "plain waiting (not next_action) excluded from next_actions");
});

test("agent_context: agent is {slug, identity} (identity = agent_code), and session_hints is present", async () => {
  const db = makeDb({});
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.agent, { slug: "board-mcp", identity: "005" });
  assert.deepEqual(res.data.session_hints, { call_wi_start_before_writes: true, close_sequence: "AUTOPILOT_NORMS" });
});

test("agent_context: pending_inbox/pending_wakes are self-close (never the orphan-sweep undefined)", async () => {
  const db = makeDb({
    board_messages: [
      { id: "m1", from_agent: "001", to_agent: "005", type: "task", subject: "hi", status: "pending", created_at: "2026-09-15T00:00:00Z", archived_at: null, wake_priority: null },
    ],
  });
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.notEqual(res.data.work.pending_inbox, undefined);
  assert.equal(res.data.work.pending_inbox?.count, 1);
  assert.notEqual(res.data.work.pending_wakes, undefined);
});

// Unit tests for src/agentContext.ts — agent_context() (SDES-001, MaaS fase 0,
// msg frame f7ff99d9). No DB connection needed: hand-built fake mimicking the
// subset of supabase-js used (same pattern as tests/wi.test.ts).
//
// Run: npx tsx --test tests/agentContext.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import { agentContext, buildRoleCard } from "../src/agentContext.ts";

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

test("agent_context: gov.applicable_norms missing -> constitution:null + constitution_unavailable, never blocks the payload", async () => {
  const db = makeDb({});
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.constitution, null);
  assert.match(res.data.constitution_unavailable ?? "", /gov\.applicable_norms missing/);
  assert.equal(res.data.payload_version, "0");
});

test("agent_context: gov.applicable_norms present -> constitution populated, no _unavailable field", async () => {
  const db = makeDb(
    {},
    {
      rpc: async (fn, params) => {
        assert.equal(fn, "gov.applicable_norms");
        assert.equal(params.p_agent, "board-mcp");
        return { data: [{ code: "CORE-001", grade: 1, reason: "constitution" }], error: null };
      },
    }
  );
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.constitution, [{ code: "CORE-001", grade: 1, reason: "constitution" }]);
  assert.equal(res.data.constitution_unavailable, undefined);
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

test("agent_context: gtd_top includes only autopilot=true or next_action, excludes done/trash, no body field, capped at 5", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      id: `g-armed-${i}`,
      owner: "board-mcp",
      title: `armed ${i}`,
      body: "should never appear",
      gtd_status: "waiting",
      autopilot: true,
      priority_rank: 10 - i,
    });
  }
  rows.push({ id: "g-next", owner: "board-mcp", title: "next action", gtd_status: "next_action", autopilot: false, priority_rank: 1 });
  rows.push({ id: "g-plain", owner: "board-mcp", title: "plain waiting", gtd_status: "waiting", autopilot: false, priority_rank: 20 });
  rows.push({ id: "g-done", owner: "board-mcp", title: "done", gtd_status: "done", autopilot: true, priority_rank: 99 });

  const db = makeDb({ loomx_items: rows });
  const res = await agentContext(db, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const top = res.data.work.gtd_top;
  assert.equal(top.length, 5, "capped at top 5");
  assert.ok(top.every((r: any) => "body" in r === false), "no body field anywhere in gtd_top");
  assert.ok(top.every((r: any) => r.gtd_status !== "done"), "done items excluded even if autopilot=true");
  assert.ok(!top.some((r: any) => r.id === "g-plain"), "plain waiting (not armed, not next_action) excluded despite higher priority_rank");
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

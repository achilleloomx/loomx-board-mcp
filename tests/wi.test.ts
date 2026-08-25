// Unit tests for src/wi.ts Work Item handlers.
// Run with: npx tsx --test tests/wi.test.ts
//
// These tests drive the handlers with a hand-built fake DB client that mimics
// the subset of @supabase/supabase-js query-builder used by wi.ts. No Supabase
// connection is needed.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wiStart,
  wiEnd,
  wiStatus,
  wiQuery,
  wiCheckpoint,
  wiLinkTemplate,
  wiPause,
  wiResume,
  wiSwitch,
  deriveTemplateLayer,
  mapEndStatus,
  mapEndToGtdStatus,
  EPHEMERAL_TEMPLATES,
} from "../src/wi.ts";
import { refreshTemplateCatalog } from "../src/wiTemplates.ts";

// ---- Fake DB client -----------------------------------------------------

type Row = Record<string, unknown>;
type Store = { [table: string]: Row[] };

interface Behaviour {
  // Next N operations to fail with the given error (per table).
  failNext?: { [table: string]: { op: string; message: string }[] };
}

function makeDb(store: Store, behaviour: Behaviour = {}): SupabaseClient {
  function consumeFailure(table: string, op: string): string | null {
    const q = behaviour.failNext?.[table];
    if (!q || q.length === 0) return null;
    if (q[0].op === op || q[0].op === "*") {
      const f = q.shift()!;
      return f.message;
    }
    return null;
  }

  function query(table: string) {
    const filters: Array<{ col: string; val: unknown; op: string }> = [];
    let op: "select" | "insert" | "update" = "select";
    let insertData: Row | null = null;
    let updateData: Row | null = null;
    let limitN: number | null = null;

    const applyFilters = (rows: Row[]): Row[] =>
      rows.filter((r) =>
        filters.every((f) => {
          if (f.op === "eq") return r[f.col] === f.val;
          if (f.op === "gte") return (r[f.col] as string) >= (f.val as string);
          if (f.op === "in") return (f.val as unknown[]).includes(r[f.col]);
          return true;
        })
      );

    const execute = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
      const fail = consumeFailure(table, op);
      if (fail) return { data: null, error: { message: fail } };

      store[table] ??= [];
      if (op === "insert") {
        const id = (insertData!.id as string) ?? `${table}-${store[table].length + 1}`;
        const row: Row = { ...insertData, id };
        if (table === "loomx_work_items") {
          row.status ??= "active";
          row.started_at ??= new Date().toISOString();
          row.in_flight_state ??= { files_touched: [], tool_uses: 0 };
          row.side_effects_log ??= [];
        }
        store[table].push(row);
        return { data: row, error: null };
      }
      if (op === "update") {
        const matched = applyFilters(store[table]);
        matched.forEach((r) => Object.assign(r, updateData));
        const data = limitN != null ? matched.slice(0, limitN) : matched;
        return { data, error: null };
      }
      let rows = applyFilters(store[table]);
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };

    const builder: any = {
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val, op: "eq" });
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push({ col, val, op: "gte" });
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ col, val: vals, op: "in" });
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      insert(data: Row) {
        op = "insert";
        insertData = data;
        return builder;
      },
      update(data: Row) {
        op = "update";
        updateData = data;
        return builder;
      },
      async single() {
        const r = await execute();
        if (r.error) return r;
        const row = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        if (!row) return { data: null, error: { message: "no rows" } };
        return { data: row, error: null };
      },
      async maybeSingle() {
        const r = await execute();
        if (r.error) return r;
        const row = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        return { data: row ?? null, error: null };
      },
      then(
        resolve: (v: { data: unknown; error: { message: string } | null }) => void,
        reject?: (e: unknown) => void
      ) {
        execute().then(resolve, reject);
      },
    };

    return builder;
  }

  return {
    from: (table: string) => query(table),
    // rpc unused by WI handlers
  } as unknown as SupabaseClient;
}

const ctxOwn = { selfSlug: "app", isLoomy: false };
const ctxLoomy = { selfSlug: "loomy", isLoomy: true };

// D-118: registry-aware context for the (a+)/(a) reply-wake guards, which
// need slugToCode/codeToSlug to query board_messages (keyed by agent_code).
const ctxRw = {
  selfSlug: "app",
  isLoomy: false,
  slugToCode: new Map([
    ["app", "010"],
    ["it-manager", "045"],
    ["dba", "002"],
    ["loomy", "001"],
  ]),
  codeToSlug: new Map([
    ["010", "app"],
    ["045", "it-manager"],
    ["002", "dba"],
    ["001", "loomy"],
  ]),
};

// ---- Pure helpers -------------------------------------------------------

test("deriveTemplateLayer: name without suffix -> L1", () => {
  assert.equal(deriveTemplateLayer("fix-bug"), "L1");
  assert.equal(deriveTemplateLayer("menu-plan"), "L1");
});

test("deriveTemplateLayer: name with extra segment -> L2", () => {
  assert.equal(deriveTemplateLayer("fix-bug-frontend"), "L2");
  assert.equal(deriveTemplateLayer("deploy-vercel-staging"), "L2");
});

test("deriveTemplateLayer: undefined -> null", () => {
  assert.equal(deriveTemplateLayer(undefined), null);
  assert.equal(deriveTemplateLayer(null), null);
});

test("mapEndStatus: waiting -> paused (schema deviation)", () => {
  assert.equal(mapEndStatus("done"), "done");
  assert.equal(mapEndStatus("failed"), "failed");
  assert.equal(mapEndStatus("waiting"), "paused");
});

test("mapEndToGtdStatus: failed -> next_action (+ body blocker elsewhere)", () => {
  assert.equal(mapEndToGtdStatus("done"), "done");
  assert.equal(mapEndToGtdStatus("failed"), "next_action");
  assert.equal(mapEndToGtdStatus("waiting"), "waiting");
});

// ---- wi_start -----------------------------------------------------------

test("wi_start (happy): auto-creates GTD and opens WI", async () => {
  const store: Store = { loomx_items: [], loomx_work_items: [] };
  const db = makeDb(store);
  const res = await wiStart(db, { intent: "menu plan week 16-22" }, ctxOwn);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.data.wi_id);
  assert.ok(res.data.gtd_item_id);
  assert.equal(res.data.gtd_created, true);
  assert.equal(store.loomx_items.length, 1);
  assert.equal(store.loomx_items[0].gtd_status, "in_progress");
  assert.equal(store.loomx_items[0].owner, "app");
  assert.equal(store.loomx_work_items.length, 1);
  assert.equal(store.loomx_work_items[0].status, "active");
  assert.equal(store.loomx_work_items[0].template_layer, "on-the-fly");
});

test("wi_start (happy): reuses existing GTD, flips it to in_progress", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", title: "fix x", owner: "app", gtd_status: "next_action" }],
    loomx_work_items: [],
  };
  const db = makeDb(store);
  const res = await wiStart(
    db,
    { intent: "fix x", gtd_item_id: "gtd-1", template_name: "fix-bug", template_version: "1.0.0" },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.gtd_created, false);
  assert.equal(store.loomx_items[0].gtd_status, "in_progress");
  assert.equal(store.loomx_work_items[0].template_layer, "L1");
  assert.equal(store.loomx_work_items[0].template_name, "fix-bug");
});

test("wi_start (error): blocks if agent already has active WI", async () => {
  const store: Store = {
    loomx_items: [],
    loomx_work_items: [
      { id: "wi-existing", agent_slug: "app", status: "active", gtd_item_id: "x", intent: "x" },
    ],
  };
  const db = makeDb(store);
  const res = await wiStart(db, { intent: "second task" }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already has an active WI/);
});

test("wi_start (error): non-loomy cannot open WI for another agent", async () => {
  const store: Store = { loomx_items: [], loomx_work_items: [] };
  const db = makeDb(store);
  const res = await wiStart(db, { intent: "x", agent_slug: "dba" }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /Only loomy/);
});

// ---- wi_start template catalog validation (GTD f67f9524) ----------------

test("wi_start (template catalog): unset WI_TEMPLATES_PATH skips validation silently", async () => {
  delete process.env.WI_TEMPLATES_PATH;
  refreshTemplateCatalog();
  const store: Store = { loomx_items: [], loomx_work_items: [] };
  const db = makeDb(store);
  const res = await wiStart(db, { intent: "x", template_name: "totally-made-up" }, ctxOwn);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.template_warning, undefined);
});

test("wi_start (template catalog): unknown name soft-warns, WI still opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-templates-"));
  writeFileSync(join(dir, "fix-bug.yaml"), "template:\n  name: fix-bug\n");
  process.env.WI_TEMPLATES_PATH = dir;
  refreshTemplateCatalog();
  try {
    const store: Store = { loomx_items: [], loomx_work_items: [] };
    const db = makeDb(store);
    const res = await wiStart(db, { intent: "x", template_name: "made-up-name" }, ctxOwn);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.ok(res.data.wi_id);
    assert.match(res.data.template_warning ?? "", /not found in the WI templates catalog/);
  } finally {
    delete process.env.WI_TEMPLATES_PATH;
    refreshTemplateCatalog();
  }
});

test("wi_start (template catalog): known name has no warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-templates-"));
  writeFileSync(join(dir, "fix-bug.yaml"), "template:\n  name: fix-bug\n");
  process.env.WI_TEMPLATES_PATH = dir;
  refreshTemplateCatalog();
  try {
    const store: Store = { loomx_items: [], loomx_work_items: [] };
    const db = makeDb(store);
    const res = await wiStart(db, { intent: "x", template_name: "fix-bug" }, ctxOwn);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.data.template_warning, undefined);
  } finally {
    delete process.env.WI_TEMPLATES_PATH;
    refreshTemplateCatalog();
  }
});

// ---- wi_end -------------------------------------------------------------

test("wi_end (happy): done cascades to GTD done + completed_at", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(
    db,
    { wi_id: "wi-1", status: "done", side_effects_pending: [{ kind: "summary_loomy" }] },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.wi_status, "done");
  assert.equal(res.data.gtd_status, "done");
  assert.equal(store.loomx_work_items[0].status, "done");
  assert.ok(store.loomx_items[0].completed_at);
  const log = store.loomx_work_items[0].side_effects_log as Array<Record<string, unknown>>;
  assert.equal(log.length, 1);
  assert.equal(log[0].pending, true);
});

test("wi_end (happy): failed sets WI.failed + GTD next_action + blocker body", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "failed", failure_reason: "CI broken" }, ctxOwn);
  assert.equal(res.ok, true);
  assert.equal(store.loomx_work_items[0].status, "failed");
  assert.equal(store.loomx_work_items[0].failure_reason, "CI broken");
  assert.equal(store.loomx_items[0].gtd_status, "next_action");
  assert.match(String(store.loomx_items[0].body), /\[BLOCKER\] CI broken/);
});

test("wi_end (happy): failed appends [BLOCKER] to existing GTD body (#3)", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress", body: "prior context" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "failed", failure_reason: "CI broken" }, ctxOwn);
  assert.equal(res.ok, true);
  // Fix #3: must append, not overwrite. Existing body must be preserved.
  assert.match(String(store.loomx_items[0].body), /prior context/);
  assert.match(String(store.loomx_items[0].body), /\[BLOCKER\] CI broken/);
});

test("wi_end (happy): waiting maps WI->paused + GTD->waiting + no ended_at (#6)", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "waiting" }, ctxOwn);
  assert.equal(res.ok, true);
  assert.equal(store.loomx_work_items[0].status, "paused");
  assert.equal(store.loomx_items[0].gtd_status, "waiting");
  // Fix #6: paused WI must NOT have ended_at (suspension ≠ closure, consistent with wi_pause).
  assert.equal(store.loomx_work_items[0].ended_at, undefined);
});

test("wi_end (error): cannot close someone else's WI", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "dba", gtd_item_id: "gtd-1", status: "active", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /owned by dba/);
});

test("wi_end (error): status=failed without failure_reason is rejected, WI stays open (GTD 1a07aa26)", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "failed" }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /failure_reason is required/);
  assert.equal(store.loomx_work_items[0].status, "active");
  assert.equal(store.loomx_items[0].gtd_status, "in_progress");
});

test("wi_end (error): status=failed with blank failure_reason is rejected", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "failed", failure_reason: "   " }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /failure_reason is required/);
});

test("wi_end (error): cannot close already-closed WI", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "done", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn);
  assert.equal(res.ok, false);
});

// Regression (GTD ba022585/c29d6143, dev-hq 2026-08-09, board msg f5fcd912):
// post_runtime_request used to be dropped silently on this path — the early
// already-closed return happened 100+ lines before the runtime_request write,
// so a caller racing the reconciler's orphan-detection never got its
// continue/clear/kill posted and its window hung with request=none.
test("wi_end (error, already closed): post_runtime_request is still posted", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "failed", side_effects_log: [] },
    ],
    loomx_agent_runtime: [{ owner_slug: "app", request: "none" }],
  };
  const db = makeDb(store);
  const res = await wiEnd(
    db,
    { wi_id: "wi-1", status: "done", post_runtime_request: "clear" },
    ctxOwn
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already closed/);
  assert.equal(res.runtime_request_posted, true);
  assert.equal(store.loomx_agent_runtime[0].request, "clear");
});

test("wi_end (error, already closed): no post_runtime_request → unchanged behavior", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "failed", side_effects_log: [] },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.runtime_request_posted, undefined);
});

// ---- wi_status ----------------------------------------------------------

test("wi_status: returns active WI for self", async () => {
  const store: Store = {
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", status: "active", intent: "x" },
      { id: "wi-2", agent_slug: "app", status: "done", intent: "y" },
    ],
  };
  const db = makeDb(store);
  const res = await wiStatus(db, {}, ctxOwn);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.data.active);
  assert.equal((res.data.active as any).id, "wi-1");
});

test("wi_status: returns null when no active", async () => {
  const store: Store = {
    loomx_work_items: [{ id: "wi-1", agent_slug: "app", status: "done", intent: "x" }],
  };
  const db = makeDb(store);
  const res = await wiStatus(db, {}, ctxOwn);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.active, null);
});

// ---- wi_query -----------------------------------------------------------

test("wi_query (happy): non-loomy auto-scopes to self", async () => {
  const store: Store = {
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", status: "active", started_at: "2026-01-01" },
      { id: "wi-2", agent_slug: "dba", status: "active", started_at: "2026-01-02" },
    ],
  };
  const db = makeDb(store);
  const res = await wiQuery(db, { agent_slug: "dba" }, ctxOwn); // ignored
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.count, 1);
  assert.equal((res.data.items[0] as any).agent_slug, "app");
});

test("wi_query (happy): loomy sees other agents when filter set", async () => {
  const store: Store = {
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", status: "active", started_at: "2026-01-01" },
      { id: "wi-2", agent_slug: "dba", status: "active", started_at: "2026-01-02" },
    ],
  };
  const db = makeDb(store);
  const res = await wiQuery(db, { agent_slug: "dba" }, ctxLoomy);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.count, 1);
  assert.equal((res.data.items[0] as any).agent_slug, "dba");
});

test("wi_query (CV-8, D-203): count is the page size and truncated:true signals more beyond the cap (msg 2190b6ae)", async () => {
  const store: Store = {
    loomx_work_items: [
      { id: "wi-1", agent_slug: "loomy", status: "done", started_at: "2026-01-01" },
      { id: "wi-2", agent_slug: "loomy", status: "done", started_at: "2026-01-02" },
      { id: "wi-3", agent_slug: "loomy", status: "done", started_at: "2026-01-03" },
    ],
  };
  const db = makeDb(store);
  const capped = await wiQuery(db, { limit: 2 }, ctxLoomy);
  assert.equal(capped.ok, true);
  if (!capped.ok) return;
  assert.equal(capped.data.count, 2, "count is the page size, not the true total of 3");
  assert.equal(capped.data.items.length, 2);
  assert.equal(capped.data.truncated, true);

  const uncapped = await wiQuery(db, { limit: 3 }, ctxLoomy);
  assert.equal(uncapped.ok, true);
  if (!uncapped.ok) return;
  assert.equal(uncapped.data.count, 3);
  assert.equal(uncapped.data.truncated, undefined, "exactly at the cap — never a false sentinel");
});

// ---- wi_checkpoint ------------------------------------------------------

test("wi_checkpoint (happy): appends files + increments tool_uses", async () => {
  const store: Store = {
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        status: "active",
        in_flight_state: { files_touched: ["src/a.ts"], tool_uses: 5 },
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiCheckpoint(
    db,
    { wi_id: "wi-1", files_touched_delta: ["src/a.ts", "src/b.ts"], tool_use_count: 3, notes: "halfway" },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.files_touched, 2);
  assert.equal(res.data.tool_uses, 8);
  const state = store.loomx_work_items[0].in_flight_state as any;
  assert.deepEqual(state.files_touched.sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal(state.tool_uses, 8);
  assert.ok(Array.isArray(state.notes));
  assert.equal(state.notes.length, 1);
});

test("wi_checkpoint (error): cannot checkpoint another agent's WI", async () => {
  const store: Store = {
    loomx_work_items: [{ id: "wi-1", agent_slug: "dba", status: "active", in_flight_state: null }],
  };
  const db = makeDb(store);
  const res = await wiCheckpoint(db, { wi_id: "wi-1", tool_use_count: 1 }, ctxOwn);
  assert.equal(res.ok, false);
});

test("wi_checkpoint (error): fails loud on a WI already closed done/failed instead of silent ok:true", async () => {
  for (const status of ["done", "failed"] as const) {
    const store: Store = {
      loomx_work_items: [
        { id: "wi-1", agent_slug: "app", status, in_flight_state: { files_touched: [], tool_uses: 5 } },
      ],
    };
    const db = makeDb(store);
    const res = await wiCheckpoint(db, { wi_id: "wi-1", tool_use_count: 1 }, ctxOwn);
    assert.equal(res.ok, false);
    if (res.ok) continue;
    assert.match(res.error, new RegExp(`'wi-1'.*status=${status}`));
    // No silent write: in_flight_state must stay untouched.
    assert.equal((store.loomx_work_items[0].in_flight_state as any).tool_uses, 5);
  }
});

// ---- wi_link_template ---------------------------------------------------

test("wi_link_template (happy): derives layer when not provided", async () => {
  const store: Store = {
    loomx_work_items: [{ id: "wi-1", agent_slug: "app", status: "active" }],
  };
  const db = makeDb(store);
  const res = await wiLinkTemplate(
    db,
    { wi_id: "wi-1", template_name: "fix-bug-frontend", template_version: "1.0.0" },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.template_layer, "L2");
  assert.equal(store.loomx_work_items[0].template_name, "fix-bug-frontend");
});

test("wi_link_template (error): WI not found", async () => {
  const store: Store = { loomx_work_items: [] };
  const db = makeDb(store);
  const res = await wiLinkTemplate(
    db,
    { wi_id: "00000000-0000-0000-0000-000000000000", template_name: "x", template_version: "1" },
    ctxOwn
  );
  assert.equal(res.ok, false);
});

// ---- wi_pause / wi_resume ----------------------------------------------

test("wi_pause + wi_resume (happy) round-trip", async () => {
  const store: Store = {
    loomx_work_items: [{ id: "wi-1", agent_slug: "app", status: "active" }],
  };
  const db = makeDb(store);
  const p = await wiPause(db, { wi_id: "wi-1" }, ctxOwn);
  assert.equal(p.ok, true);
  assert.equal(store.loomx_work_items[0].status, "paused");
  const r = await wiResume(db, { wi_id: "wi-1" }, ctxOwn);
  assert.equal(r.ok, true);
  assert.equal(store.loomx_work_items[0].status, "active");
});

test("wi_pause (error): WI not active", async () => {
  const store: Store = {
    loomx_work_items: [{ id: "wi-1", agent_slug: "app", status: "paused" }],
  };
  const db = makeDb(store);
  const res = await wiPause(db, { wi_id: "wi-1" }, ctxOwn);
  assert.equal(res.ok, false);
});

test("wi_resume (error): blocked if another WI already active", async () => {
  const store: Store = {
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", status: "paused" },
      { id: "wi-2", agent_slug: "app", status: "active" },
    ],
  };
  const db = makeDb(store);
  const res = await wiResume(db, { wi_id: "wi-1" }, ctxOwn);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already has an active WI/);
});

// ---- wi_switch ----------------------------------------------------------

test("wi_switch (happy): closes old with marker + opens new + cascades old GTD (#4)", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-old", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-old",
        agent_slug: "app",
        gtd_item_id: "gtd-old",
        status: "active",
        in_flight_state: { files_touched: [], tool_uses: 2 },
        side_effects_log: [],
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiSwitch(
    db,
    { old_wi_id: "wi-old", new_intent: "pivot task", new_template: "fix-bug" },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(store.loomx_work_items.length, 2);
  const closed = store.loomx_work_items.find((r) => r.id === "wi-old")!;
  assert.equal(closed.status, "done");
  assert.equal((closed.in_flight_state as any).auto_closed_by_switch, true);
  const fresh = store.loomx_work_items.find((r) => r.id !== "wi-old")!;
  assert.equal(fresh.status, "active");
  assert.equal(fresh.template_name, "fix-bug");
  // Fix #4: old GTD must be cascaded to next_action (interrupted, not completed).
  assert.equal(store.loomx_items[0].gtd_status, "next_action");
});

test("wi_switch (error): only from active WI", async () => {
  const store: Store = {
    loomx_items: [],
    loomx_work_items: [{ id: "wi-1", agent_slug: "app", status: "paused", gtd_item_id: "g" }],
  };
  const db = makeDb(store);
  const res = await wiSwitch(db, { old_wi_id: "wi-1", new_intent: "x" }, ctxOwn);
  assert.equal(res.ok, false);
});

// ---- Phase 1 D-074: gate + arm + runtime_request ------------------------

test("EPHEMERAL_TEMPLATES: exported constant is non-empty", () => {
  assert.ok(EPHEMERAL_TEMPLATES.length > 0);
  assert.ok(EPHEMERAL_TEMPLATES.includes("session-meta"));
});

test("wi_end (D-074 gate): on-the-fly WI (no template) skips gate on done", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
    doc_item_wi_links: [], // no links — should be ignored for on-the-fly
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn);
  assert.equal(res.ok, true, "on-the-fly WI must skip gate even with no links");
});

test("wi_end (D-074 gate): ephemeral template skips gate on done", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "session-meta",
        template_layer: "L1",
      },
    ],
    doc_item_wi_links: [],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn);
  assert.equal(res.ok, true, "ephemeral template must skip gate");
});

test("wi_end (D-074 gate): durable WI with no links blocked on done", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "fix-bug",
        template_layer: "L1",
      },
    ],
    doc_item_wi_links: [],
  };
  const db = makeDb(store);
  const fakeRunDoc = async (_slug: string, fn: (db: SupabaseClient) => Promise<unknown>) => fn(db);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn, fakeRunDoc as never);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /requirement|sdes/i);
});

test("wi_end (D-074 gate): durable WI with REQ link passes gate", async () => {
  const reqId = "req-uuid-001";
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "fix-bug",
        template_layer: "L1",
      },
    ],
    doc_item_wi_links: [{ id: "link-1", wi_id: "wi-1", doc_item_id: reqId }],
    doc_items: [{ id: reqId, item_type: "requirement" }],
  };
  const db = makeDb(store);
  const fakeRunDoc = async (_slug: string, fn: (db: SupabaseClient) => Promise<unknown>) => fn(db);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn, fakeRunDoc as never);
  assert.equal(res.ok, true, "durable WI with linked REQ must pass gate");
});

test("wi_end (D-074 gate): durable WI with decision link passes gate (loomy msg 3fb74e48)", async () => {
  const decId = "decision-uuid-001";
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "decision-enforcement",
        template_layer: "L1",
      },
    ],
    doc_item_wi_links: [{ id: "link-1", wi_id: "wi-1", doc_item_id: decId }],
    doc_items: [{ id: decId, item_type: "decision" }],
  };
  const db = makeDb(store);
  const fakeRunDoc = async (_slug: string, fn: (db: SupabaseClient) => Promise<unknown>) => fn(db);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn, fakeRunDoc as never);
  assert.equal(res.ok, true, "durable WI with linked decision must pass gate — a governance WI's durable output is a decision, not a REQ/SDES");
});

test("wi_end (D-074 gate): gate reads go through runDoc keyed on the WI owner's slug, not the plain db", async () => {
  // Regression for the bug where checkDurableGate queried doc_item_wi_links/doc_items
  // with the plain board client — under RLS (D-015) that silently returns 0 rows even
  // when the links exist, because request.agent_slug is only set inside the doc_rw
  // transaction wrapper. A plain db with NO doc tables at all proves the gate never
  // falls back to it: it must only see links via the injected runDoc.
  const reqId = "req-uuid-002";
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "fix-bug",
        template_layer: "L1",
      },
    ],
    // Intentionally NOT populated on the plain db — only reachable via runDoc.
  };
  const docStore: Store = {
    doc_item_wi_links: [{ id: "link-1", wi_id: "wi-1", doc_item_id: reqId }],
    doc_items: [{ id: reqId, item_type: "requirement" }],
  };
  const docDb = makeDb(docStore);
  const db = makeDb(store);
  const slugsSeen: string[] = [];
  const runDoc = async (slug: string, fn: (db: SupabaseClient) => Promise<unknown>) => {
    slugsSeen.push(slug);
    return fn(docDb);
  };
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done" }, ctxOwn, runDoc as never);
  assert.equal(res.ok, true, "gate must resolve links via runDoc, not the plain db");
  assert.deepEqual(slugsSeen, ["app"], "runDoc must be called with the WI owner's slug");
});

test("wi_end (D-074 gate): force_ephemeral bypasses gate (gate_bypassed=true)", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "fix-bug",
        template_layer: "L1",
      },
    ],
    doc_item_wi_links: [],
  };
  const db = makeDb(store);
  const res = await wiEnd(
    db,
    { wi_id: "wi-1", status: "done", force_ephemeral: true, force_reason: "one-off hotfix" },
    ctxOwn
  );
  assert.equal(res.ok, true, "force_ephemeral must bypass gate");
  if (!res.ok) return;
  assert.equal(res.data.gate_bypassed, true);
});

test("wi_end (D-074 gate): durable WI on failed skips gate", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: "fix-bug",
        template_layer: "L1",
      },
    ],
    doc_item_wi_links: [],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "failed", failure_reason: "CI red" }, ctxOwn);
  assert.equal(res.ok, true, "gate must not block failed closures");
});

test("wi_end (D-074 REQ-034): arm_gtd_ids sets autopilot=true on own GTD (model already present)", async () => {
  const followOnId = "gtd-follow";
  const store: Store = {
    loomx_items: [
      { id: "gtd-1", owner: "app", gtd_status: "in_progress" },
      { id: followOnId, owner: "app", gtd_status: "next_action", autopilot: false, autopilot_model: "sonnet" },
    ],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", arm_gtd_ids: [followOnId] }, ctxOwn);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(store.loomx_items[1].autopilot, true);
  assert.equal(store.loomx_items[1].autopilot_model, "sonnet", "existing model must be preserved untouched");
  assert.equal(res.data.arm_warnings, undefined);
});

test("GTD 6bbc293b: arm_gtd_ids on a GTD with no autopilot_model warns instead of arming silently", async () => {
  const followOnId = "gtd-follow-no-model";
  const store: Store = {
    loomx_items: [
      { id: "gtd-1", owner: "app", gtd_status: "in_progress" },
      { id: followOnId, owner: "app", gtd_status: "next_action", autopilot: false },
    ],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", arm_gtd_ids: [followOnId] }, ctxOwn);
  assert.equal(res.ok, true, "must still arm — soft-warn, never blocks close");
  if (!res.ok) return;
  assert.equal(store.loomx_items[1].autopilot, true, "arming itself still happens");
  assert.equal(store.loomx_items[1].autopilot_model, undefined, "no model was invented");
  assert.ok(
    Array.isArray(res.data.arm_warnings) &&
      res.data.arm_warnings.some((w: string) => w.includes(followOnId) && w.includes("autopilot_model")),
    "must warn explicitly that the armed GTD has no dispatchable model"
  );
});

test("GTD 6bbc293b: arm_gtd_model fills a missing autopilot_model, no warning", async () => {
  const followOnId = "gtd-follow-fill";
  const store: Store = {
    loomx_items: [
      { id: "gtd-1", owner: "app", gtd_status: "in_progress" },
      { id: followOnId, owner: "app", gtd_status: "next_action", autopilot: false },
    ],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(
    db,
    { wi_id: "wi-1", status: "done", arm_gtd_ids: [followOnId], arm_gtd_model: "opus" },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(store.loomx_items[1].autopilot, true);
  assert.equal(store.loomx_items[1].autopilot_model, "opus");
  assert.equal(res.data.arm_warnings, undefined);
});

test("GTD 6bbc293b: arm_gtd_model never overwrites an already-set autopilot_model", async () => {
  const followOnId = "gtd-follow-keep";
  const store: Store = {
    loomx_items: [
      { id: "gtd-1", owner: "app", gtd_status: "in_progress" },
      { id: followOnId, owner: "app", gtd_status: "next_action", autopilot: false, autopilot_model: "haiku" },
    ],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(
    db,
    { wi_id: "wi-1", status: "done", arm_gtd_ids: [followOnId], arm_gtd_model: "opus" },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(store.loomx_items[1].autopilot_model, "haiku", "pre-existing model wins over arm_gtd_model");
});

test("wi_end (D-074 REQ-034): arm_gtd_ids soft-warns on missing GTD", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
  };
  const db = makeDb(store);
  const missingId = "00000000-0000-0000-0000-000000000000";
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", arm_gtd_ids: [missingId] }, ctxOwn);
  assert.equal(res.ok, true, "soft-warn must not block close");
  if (!res.ok) return;
  assert.ok(Array.isArray(res.data.arm_warnings) && res.data.arm_warnings.length > 0);
});

test("wi_end (D-074 REQ-035): platform_contribution_pending returned for pull enabler", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      {
        id: "wi-1",
        agent_slug: "app",
        gtd_item_id: "gtd-1",
        status: "active",
        side_effects_log: [],
        template_name: null,
        template_layer: "on-the-fly",
      },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(
    db,
    { wi_id: "wi-1", status: "done", platform_contribution: "Fixed null-dereference in parser." },
    ctxOwn
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.platform_contribution_pending, "Fixed null-dereference in parser.");
});

// ---- D-118 reply-wake structural guards ----------------------------------
// GTD 1aa130da, proposal it-manager msg 49a4177c, GO Achille 2026-08-10.
// E2E-RW-04/05/06/07/11/13 refer to the scenario IDs named in the GTD body.

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    process.stderr.write = orig;
  }
}

async function withRwGuardsEnabled<T>(fn: () => Promise<T>): Promise<T> {
  process.env.LOOMX_RW_GUARDS_ENABLED = "1";
  try {
    return await fn();
  } finally {
    delete process.env.LOOMX_RW_GUARDS_ENABLED;
  }
}

// D-118 (a+, checkInboxPendingGuard / inbox_pending_warning) removed
// (SDES-GOV-157, it-manager gate confirmation msg a3ce4b29) — fully superseded
// by D-205's pending_inbox. Former E2E-RW-06/07 coverage lived here.

test("D-118 (a, E2E-RW-05): auto-sets waiting_on+block_scope='reply-wake' on wi_end(waiting) for an unanswered outbound question", async () => {
  await withRwGuardsEnabled(async () => {
    const store: Store = {
      loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress", waiting_on: null }],
      loomx_work_items: [
        { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-10T08:00:00Z" },
      ],
      board_messages: [
        { id: "q1", from_agent: "010", to_agent: "045", type: "question", status: "pending", created_at: "2026-08-10T08:05:00Z", ref_id: null },
      ],
    };
    const db = makeDb(store);
    const res = await wiEnd(db, { wi_id: "wi-1", status: "waiting" }, ctxRw);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.data.waiting_on_auto_set, { waiting_on: "it-manager", block_scope: "reply-wake" });
    assert.equal(store.loomx_items[0].waiting_on, "it-manager");
    assert.equal(store.loomx_items[0].block_scope, "reply-wake");
  });
});

test("D-118 (a, E2E-RW-05 regression): a reply already in-thread -> nothing to auto-set", async () => {
  await withRwGuardsEnabled(async () => {
    const store: Store = {
      loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress", waiting_on: null }],
      loomx_work_items: [
        { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-10T08:00:00Z" },
      ],
      board_messages: [
        { id: "q1", from_agent: "010", to_agent: "045", type: "question", status: "pending", created_at: "2026-08-10T08:05:00Z", ref_id: null },
        { id: "r1", from_agent: "045", to_agent: "010", type: "done", status: "pending", created_at: "2026-08-10T08:10:00Z", ref_id: "q1" },
      ],
    };
    const db = makeDb(store);
    const res = await wiEnd(db, { wi_id: "wi-1", status: "waiting" }, ctxRw);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.data.waiting_on_auto_set, undefined);
    assert.equal(store.loomx_items[0].waiting_on, null);
  });
});

test("D-118 (a, E2E-RW-04 regression): never overrides an already-declared waiting_on", async () => {
  await withRwGuardsEnabled(async () => {
    const store: Store = {
      // Agent already declared it's waiting on loomy — a different, newer,
      // unanswered outbound to dba must NOT clobber that explicit choice.
      loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "waiting", waiting_on: "loomy", block_scope: "reply-wake" }],
      loomx_work_items: [
        { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-10T08:00:00Z" },
      ],
      board_messages: [
        { id: "q1", from_agent: "010", to_agent: "002", type: "task", status: "pending", created_at: "2026-08-10T09:00:00Z", ref_id: null },
      ],
    };
    const db = makeDb(store);
    const res = await wiEnd(db, { wi_id: "wi-1", status: "waiting" }, ctxRw);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.data.waiting_on_auto_set, undefined);
    assert.equal(store.loomx_items[0].waiting_on, "loomy");
  });
});

test("D-118 (a): tied unanswered outbounds -> warning instead of a guessed auto-set", async () => {
  await withRwGuardsEnabled(async () => {
    const store: Store = {
      loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress", waiting_on: null }],
      loomx_work_items: [
        { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-10T08:00:00Z" },
      ],
      board_messages: [
        { id: "q1", from_agent: "010", to_agent: "045", type: "task", status: "pending", created_at: "2026-08-10T09:00:00Z", ref_id: null },
        { id: "q2", from_agent: "010", to_agent: "002", type: "task", status: "pending", created_at: "2026-08-10T09:00:00Z", ref_id: null },
      ],
    };
    const db = makeDb(store);
    const res = await wiEnd(db, { wi_id: "wi-1", status: "waiting" }, ctxRw);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.data.waiting_on_auto_set, undefined);
    assert.match(res.data.waiting_on_warning ?? "", /ambiguous/);
    assert.equal(store.loomx_items[0].waiting_on, null);
  });
});

test("D-118 (E2E-RW-13, dry-run): flag OFF computes but never touches response or DB, logs would-set", async () => {
  // LOOMX_RW_GUARDS_ENABLED intentionally left unset (default OFF).
  delete process.env.LOOMX_RW_GUARDS_ENABLED;
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress", waiting_on: null }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-10T08:00:00Z" },
    ],
    board_messages: [
      { id: "q1", from_agent: "010", to_agent: "045", type: "question", status: "pending", created_at: "2026-08-10T08:05:00Z", ref_id: null },
    ],
  };
  const db = makeDb(store);
  const { result: res, logs } = await captureStderr(() => wiEnd(db, { wi_id: "wi-1", status: "waiting" }, ctxRw));

  assert.equal(res.ok, true);
  if (!res.ok) return;
  // No side-effect on the response...
  assert.equal(res.data.waiting_on_auto_set, undefined);
  assert.equal(res.data.waiting_on_warning, undefined);
  // ...nor on the DB.
  assert.equal(store.loomx_items[0].waiting_on, null);
  assert.equal(store.loomx_items[0].block_scope, undefined);
  // ...but the guard still ran and logged what it would have done.
  assert.ok(logs.some((l) => l.includes("[wi_end][dry-run] would-set") && l.includes("waiting_on=it-manager")));
});

test("D-118 (E2E-RW-11 regression, already covered above): wi_end on a closed WI still posts runtime_request unaffected by the D-118 guards", async () => {
  // Same fixture/assertions as "wi_end (error, already closed): post_runtime_request is still posted" —
  // re-run here under registry-aware ctxRw to confirm the D-118 guards (which
  // only run on the successful-close path) don't disturb the early-return path.
  const store: Store = {
    loomx_items: [{ id: "gtd-1" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "done", ended_at: "2026-08-01T00:00:00Z", side_effects_log: [] },
    ],
    loomx_agent_runtime: [{ owner_slug: "app", request: "none" }],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", post_runtime_request: "clear" }, ctxRw);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /already closed/);
  assert.equal(res.runtime_request_posted, true);
  assert.equal(store.loomx_agent_runtime[0].request, "clear");
});

// ---- D-205 pending_inbox on wi_end ---------------------------------------
// REQ-GOV-151..154 / SDES-GOV-156-157 (ratified msg 17051c14). Distinct from
// D-118's inbox_pending_warning: no flag, no warning framing, no DB write.

// SDES-GOV-156: none of these tests set LOOMX_RW_GUARDS_ENABLED — pending_inbox
// is ungated on purpose. D-118 shipped OFF and its warning stayed invisible for
// weeks; that is precisely the fate this feature must not inherit.
test("D-205 (REQ-GOV-151): wi_end returns pending_inbox with the owner's actionable queue", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-23T08:00:00Z" },
    ],
    board_messages: [
      { id: "m1", from_agent: "045", to_agent: "010", type: "task", subject: "still queued", status: "pending", created_at: "2026-08-23T09:00:00Z" },
      { id: "m2", from_agent: "002", to_agent: "010", type: "info", subject: "fyi", status: "pending", created_at: "2026-08-23T09:05:00Z" },
    ],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", force_ephemeral: true, force_reason: "test" }, ctxRw);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.pending_inbox?.count, 1);
  assert.equal(res.data.pending_inbox?.messages[0].subject, "still queued");
  assert.equal(res.data.pending_inbox?.messages[0].from, "it-manager");
});

test("D-205 (REQ-GOV-152): an empty queue is still reported (count 0), so 'kill' is an informed choice", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-23T08:00:00Z" },
    ],
    board_messages: [],
  };
  const db = makeDb(store);
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", force_ephemeral: true, force_reason: "test" }, ctxRw);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.pending_inbox?.count, 0);
});

test("D-205 (REQ-GOV-151): no pending_inbox when loomy closes another agent's WI (orphan sweep)", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-23T08:00:00Z" },
    ],
    board_messages: [
      { id: "m1", from_agent: "045", to_agent: "010", type: "task", subject: "still queued", status: "pending", created_at: "2026-08-23T09:00:00Z" },
    ],
  };
  const db = makeDb(store);
  const ctxLoomyRw = { ...ctxRw, selfSlug: "loomy", isLoomy: true };
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", force_ephemeral: true, force_reason: "test" }, ctxLoomyRw);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.pending_inbox, undefined);
});

test("D-205 (REQ-GOV-151): pending_inbox survives a GTD-sync failure — the WI still closed", async () => {
  const store: Store = {
    loomx_items: [{ id: "gtd-1", owner: "app", gtd_status: "in_progress" }],
    loomx_work_items: [
      { id: "wi-1", agent_slug: "app", gtd_item_id: "gtd-1", status: "active", side_effects_log: [], started_at: "2026-08-23T08:00:00Z" },
    ],
    board_messages: [
      { id: "m1", from_agent: "045", to_agent: "010", type: "question", subject: "unanswered", status: "pending", created_at: "2026-08-23T09:00:00Z" },
    ],
  };
  const db = makeDb(store, { failNext: { loomx_items: [{ op: "update", message: "row locked" }] } });
  const res = await wiEnd(db, { wi_id: "wi-1", status: "done", force_ephemeral: true, force_reason: "test" }, ctxRw);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.data.gtd_sync_warning ?? "", /GTD sync failed/);
  assert.equal(res.data.pending_inbox?.count, 1);
});

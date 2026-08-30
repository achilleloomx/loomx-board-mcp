// Unit tests for computePendingWakes in src/pendingInbox.ts — D-238 (GTD 4e25f4e4).
// Run with: npx tsx --test tests/pending-wakes.test.ts
//
// Sibling of tests/pending-inbox.test.ts (D-205): same undefined-vs-empty and
// orphan-sweep contract, different axis (wake_priority instead of type).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import { computePendingWakes } from "../src/pendingInbox.ts";

type Row = Record<string, unknown>;

function makeDb(rows: Row[], error?: string): SupabaseClient {
  const builder: any = {
    filters: [] as Array<{ col: string; val: unknown; op: string }>,
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      builder.filters.push({ col, val, op: "eq" });
      return builder;
    },
    neq(col: string, val: unknown) {
      builder.filters.push({ col, val, op: "neq" });
      return builder;
    },
    is(col: string, val: unknown) {
      builder.filters.push({ col, val, op: "is" });
      return builder;
    },
    not(col: string, operator: string, val: unknown) {
      if (operator === "is") builder.filters.push({ col, val, op: "not-is" });
      return builder;
    },
    then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
      if (error) {
        resolve({ data: null, error: { message: error } });
        return;
      }
      const data = rows.filter((r) =>
        builder.filters.every((f: { col: string; val: unknown; op: string }) => {
          if (f.op === "eq") return r[f.col] === f.val;
          if (f.op === "neq") return r[f.col] !== f.val;
          if (f.op === "is") return (r[f.col] ?? null) === f.val;
          if (f.op === "not-is") return (r[f.col] ?? null) !== f.val;
          return true;
        })
      );
      resolve({ data, error: null });
    },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const registry = {
  slugToCode: new Map([
    ["app", "010"],
    ["it-manager", "045"],
    ["dba", "002"],
  ]),
  codeToSlug: new Map([
    ["010", "app"],
    ["045", "it-manager"],
    ["002", "dba"],
  ]),
};

function msg(over: Row = {}): Row {
  return {
    id: "m1",
    from_agent: "045",
    to_agent: "010",
    type: "info",
    subject: "cold-wake ping",
    status: "pending",
    wake_priority: "urgent",
    archived_at: null,
    created_at: "2026-08-23T11:00:00.000Z",
    ...over,
  };
}

test("D-238: reports wake-marked un-acknowledged messages for the closing agent", async () => {
  const db = makeDb([msg()]);
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.count, 1);
  assert.equal(res.messages[0].id, "m1");
  assert.equal(res.messages[0].from, "it-manager");
  assert.equal(res.messages[0].subject, "cold-wake ping");
  assert.equal(res.messages[0].wake_priority, "urgent");
});

test("D-238: an empty queue is reported as count 0, not omitted", async () => {
  const db = makeDb([]);
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.count, 0);
  assert.deepEqual(res.messages, []);
});

test("D-238: any message type counts, as long as it carries wake_priority", async () => {
  const db = makeDb([
    msg({ id: "m1", type: "task" }),
    msg({ id: "m2", type: "question" }),
    msg({ id: "m3", type: "info" }),
  ]);
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.count, 3);
});

test("D-238: messages without a wake marker, already acknowledged, archived, or addressed elsewhere are excluded", async () => {
  const db = makeDb([
    msg({ id: "m1", wake_priority: null }), // no wake marker
    msg({ id: "m2", status: "acknowledged" }), // already delivered
    msg({ id: "m3", archived_at: "2026-08-24T00:00:00.000Z" }), // archived
    msg({ id: "m4", to_agent: "002" }), // someone else's queue
    msg({ id: "m5" }), // the one real match
  ]);
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.count, 1);
  assert.equal(res.messages[0].id, "m5");
});

test("D-238: status in_progress/pending/done (anything but acknowledged) still counts as undelivered", async () => {
  const db = makeDb([
    msg({ id: "m1", status: "pending" }),
    msg({ id: "m2", status: "in_progress" }),
    msg({ id: "m3", status: "done" }),
  ]);
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.count, 3);
});

test("D-238: messages come oldest-first, and a queue over the cap declares the truncation", async () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    msg({ id: `m${i}`, created_at: `2026-08-23T0${i}:00:00.000Z` })
  );
  const db = makeDb([...rows].reverse());
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.count, 7, "the count is exact even when the list is capped");
  assert.equal(res.messages.length, 5);
  assert.deepEqual(
    res.messages.map((m) => m.id),
    ["m0", "m1", "m2", "m3", "m4"]
  );
  assert.equal(res.truncated, true);
});

test("D-238: nothing is reported when closing on another agent's behalf (orphan sweep)", async () => {
  const db = makeDb([msg({ to_agent: "002" })]);
  const res = await computePendingWakes(db, registry, "dba", "loomy");
  assert.equal(res, undefined);
});

test("D-238: no registry / unmapped owner -> undefined, never a fake empty queue", async () => {
  const db = makeDb([msg()]);
  assert.equal(await computePendingWakes(db, {}, "app", "app"), undefined);
  assert.equal(await computePendingWakes(db, registry, "unknown-agent", "unknown-agent"), undefined);
});

test("D-238: a failing read is swallowed (undefined), never raised into the close", async () => {
  const db = makeDb([], "connection reset");
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.equal(res, undefined);
});

test("D-238: a message with no subject still reports, with an explicit placeholder", async () => {
  const db = makeDb([msg({ subject: null })]);
  const res = await computePendingWakes(db, registry, "app", "app");
  assert.ok(res);
  assert.equal(res.messages[0].subject, "(no subject)");
});

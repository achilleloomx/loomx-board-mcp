// Unit tests for src/pendingInbox.ts — D-205 (REQ-GOV-151..154, SDES-GOV-156).
// Run with: npx tsx --test tests/pending-inbox.test.ts
//
// The helper is shared by wi_end and gtd_complete; these tests drive it
// directly with a fake board_messages table. wi_end's wiring is covered in
// tests/wi.test.ts.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import { computePendingInbox } from "../src/pendingInbox.ts";

type Row = Record<string, unknown>;

function makeDb(rows: Row[], error?: string): SupabaseClient {
  const builder: any = {
    filters: [] as Array<{ col: string; val: unknown }>,
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      builder.filters.push({ col, val });
      return builder;
    },
    then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
      if (error) {
        resolve({ data: null, error: { message: error } });
        return;
      }
      const data = rows.filter((r) =>
        builder.filters.every((f: { col: string; val: unknown }) => r[f.col] === f.val)
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

const NOW = "2026-08-23T12:00:00.000Z";

function msg(over: Row = {}): Row {
  return {
    id: "m1",
    from_agent: "045",
    to_agent: "010",
    type: "task",
    subject: "process the queue",
    status: "pending",
    created_at: "2026-08-23T11:00:00.000Z",
    ...over,
  };
}

test("REQ-GOV-151: reports the pending actionable messages for the closing agent", async () => {
  const db = makeDb([msg()]);
  const res = await computePendingInbox(db, registry, "app", "app", NOW);
  assert.ok(res);
  assert.equal(res.count, 1);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].from, "it-manager"); // code resolved to slug
  assert.equal(res.messages[0].subject, "process the queue");
  assert.equal(res.messages[0].age_minutes, 60);
  assert.equal(res.truncated, undefined);
});

test("REQ-GOV-152: an empty queue is reported as count 0, not omitted", async () => {
  const db = makeDb([]);
  const res = await computePendingInbox(db, registry, "app", "app", NOW);
  assert.ok(res, "count 0 is a real input to the kill decision — must not be silent");
  assert.equal(res.count, 0);
  assert.deepEqual(res.messages, []);
});

test("only pending task/question/blocker addressed to the owner count", async () => {
  const db = makeDb([
    msg({ id: "m1", type: "info" }), // not actionable
    msg({ id: "m2", type: "task", status: "acknowledged" }), // already processed
    msg({ id: "m3", type: "task", to_agent: "002" }), // someone else's queue
    msg({ id: "m4", type: "question" }),
    msg({ id: "m5", type: "blocker" }),
  ]);
  const res = await computePendingInbox(db, registry, "app", "app", NOW);
  assert.ok(res);
  assert.equal(res.count, 2);
  assert.deepEqual(
    res.messages.map((m) => m.id),
    ["m4", "m5"]
  );
});

test("messages come oldest-first, and a queue over the cap declares the truncation", async () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    msg({ id: `m${i}`, created_at: `2026-08-23T0${i}:00:00.000Z` })
  );
  // Shuffled on the way in — ordering must come from created_at, not row order.
  const db = makeDb([...rows].reverse());
  const res = await computePendingInbox(db, registry, "app", "app", NOW);
  assert.ok(res);
  assert.equal(res.count, 7, "the count is exact even when the list is capped");
  assert.equal(res.messages.length, 5);
  assert.deepEqual(
    res.messages.map((m) => m.id),
    ["m0", "m1", "m2", "m3", "m4"]
  );
  assert.equal(res.truncated, true);
});

test("REQ-GOV-151: nothing is reported when closing on another agent's behalf (orphan sweep)", async () => {
  const db = makeDb([msg({ to_agent: "002" })]);
  const res = await computePendingInbox(db, registry, "dba", "loomy", NOW);
  assert.equal(res, undefined);
});

test("no registry / unmapped owner -> undefined, never a fake empty queue", async () => {
  const db = makeDb([msg()]);
  assert.equal(await computePendingInbox(db, {}, "app", "app", NOW), undefined);
  assert.equal(await computePendingInbox(db, registry, "unknown-agent", "unknown-agent", NOW), undefined);
});

test("REQ-GOV-152: a failing read is swallowed (undefined), never raised into the close", async () => {
  const db = makeDb([], "connection reset");
  const res = await computePendingInbox(db, registry, "app", "app", NOW);
  assert.equal(res, undefined);
});

test("a message with no subject still reports, with an explicit placeholder", async () => {
  const db = makeDb([msg({ subject: null })]);
  const res = await computePendingInbox(db, registry, "app", "app", NOW);
  assert.ok(res);
  assert.equal(res.messages[0].subject, "(no subject)");
});

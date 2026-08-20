// Unit tests for docItemChain — SDES-DOCM-020 / WI-G.2 (Piano Manifesti DEL-A4).
//
// STP-002 point 3 ("no repack before the chain resolver is TESTED") is why this
// file exists before anything reorganises the corpus.
//
// A dedicated fake instead of the one in docs.test.ts: that fake enforces RLS on
// `documents` only, and the hop-level visibility guarantee (REQ-DOCM-006 applies
// at EVERY hop) can only be exercised by hiding a `doc_items` row. `hidden` here
// models exactly that — a row that exists but which this caller cannot read.
//
// Run with: npx tsx --test tests/doc-chain.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";

import { docItemChain } from "../src/docs.ts";

type Row = Record<string, any>;

const PROJ = "10000000-0000-4000-8000-000000000001";
const OTHER_PROJ = "10000000-0000-4000-8000-000000000002";
const CTX = { selfSlug: "board-mcp", isLoomy: false };

function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function item(n: number, over: Partial<Row> = {}): Row {
  return {
    id: id(n),
    code: `D-${n}`,
    item_type: "decision",
    status: "superseded",
    document_id: id(900),
    project_id: PROJ,
    updated_at: `2026-08-0${n}T00:00:00.000Z`,
    ...over,
  };
}

// new --supersedes--> old (docSupersede's direction).
function edge(newer: number, older: number, project = PROJ): Row {
  return { from_item: id(newer), to_item: id(older), relation_type: "supersedes", project_id: project };
}

/** `hidden`: ids that exist in the store but are invisible to this caller (RLS). */
function makeDb(store: { doc_items: Row[]; doc_item_links: Row[] }, hidden: Set<string> = new Set()): SupabaseClient {
  function query(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    let maybeSingle = false;

    const builder: any = {
      select() { return builder; },
      eq(col: string, val: unknown) { filters.push({ col, val }); return builder; },
      maybeSingle() { maybeSingle = true; return builder; },
      then(resolve: (r: { data: unknown; error: { message: string } | null }) => void) {
        let rows = (store as any)[table].filter((r: Row) => filters.every((f) => r[f.col] === f.val));
        if (table === "doc_items") rows = rows.filter((r: Row) => !hidden.has(r.id));
        resolve(maybeSingle ? { data: rows[0] ?? null, error: null } : { data: rows, error: null });
      },
    };
    return builder;
  }
  return { from: (t: string) => query(t) } as unknown as SupabaseClient;
}

function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  assert.equal(r.ok, true, `expected ok, got error: ${r.ok === false ? r.error : ""}`);
  return (r as { ok: true; data: T }).data;
}

function errorOf(r: { ok: true } | { ok: false; error: string }): string {
  assert.equal(r.ok, false, "expected an error, got ok");
  return (r as { ok: false; error: string }).error;
}

// --- the happy path: walk a real chain forward -----------------------------

test("walks a multi-hop chain to the version in force", async () => {
  // 1 <- 2 <- 3 : 3 is current.
  const store = {
    doc_items: [item(1), item(2), item(3, { status: "active", updated_at: null })],
    doc_item_links: [edge(2, 1), edge(3, 2)],
  };
  const d = ok(await docItemChain(makeDb(store), { item_id: id(1) }, CTX));

  assert.equal(d.resolved_id, id(3));
  assert.equal(d.hops, 2);
  assert.equal(d.terminal_reason, "reached_current");
  // The path is inspectable, in order, and each superseded hop carries its instant.
  assert.deepEqual(d.chain.map((h) => h.item_id), [id(1), id(2), id(3)]);
  assert.equal(d.chain[0]!.superseded_at, "2026-08-01T00:00:00.000Z");
  assert.equal(d.chain[2]!.superseded_at, null, "the row in force is not superseded");
  assert.equal(d.chain[2]!.status, "active");
});

test("an item already in force resolves to itself with zero hops", async () => {
  const store = { doc_items: [item(1, { status: "active" })], doc_item_links: [] as Row[] };
  const d = ok(await docItemChain(makeDb(store), { item_id: id(1) }, CTX));

  assert.equal(d.resolved_id, id(1));
  assert.equal(d.hops, 0);
  assert.equal(d.terminal_reason, "already_current");
  assert.deepEqual(d.chain, []);
  // Honest about what a terminal actually proves.
  assert.match(d.note ?? "", /no successor VISIBLE|not "no successor"/i);
});

// --- the three terminations that must never be guessed ---------------------

test("a fork errs and lists the candidates instead of choosing", async () => {
  // Both 2 and 3 claim to supersede 1.
  const store = {
    doc_items: [item(1), item(2, { status: "active" }), item(3, { status: "active" })],
    doc_item_links: [edge(2, 1), edge(3, 1)],
  };
  const e = errorOf(await docItemChain(makeDb(store), { item_id: id(1) }, CTX));

  assert.match(e, /Ambiguous/i);
  assert.ok(e.includes(id(2)) && e.includes(id(3)), "both candidates must be named");
  assert.match(e, /never arbitrates/i);
});

test("a cycle is refused, not looped", async () => {
  const store = {
    doc_items: [item(1), item(2)],
    doc_item_links: [edge(2, 1), edge(1, 2)],
  };
  const e = errorOf(await docItemChain(makeDb(store), { item_id: id(1) }, CTX));
  assert.match(e, /Cycle detected/i);
});

test("an unreadable next hop stops the walk and says so", async () => {
  // 1 <- 2 <- 3, but 3 lives in a document this caller cannot read.
  const store = {
    doc_items: [item(1), item(2), item(3, { status: "active" })],
    doc_item_links: [edge(2, 1), edge(3, 2)],
  };
  const d = ok(await docItemChain(makeDb(store, new Set([id(3)])), { item_id: id(1) }, CTX));

  assert.equal(d.terminal_reason, "successor_not_readable");
  assert.equal(d.resolved_id, id(2), "the furthest READABLE row, not a claim about what is current");
  // The whole point: it must not pass 2 off as the version in force.
  assert.match(d.note ?? "", /NOT guaranteed to be the version in force/i);
  assert.ok(d.note!.includes(id(3)), "names the hop it could not follow");
});

// --- guards ----------------------------------------------------------------

test("max_hops is an explicit error, never a truncated answer", async () => {
  const store = {
    doc_items: [item(1), item(2), item(3), item(4, { status: "active" })],
    doc_item_links: [edge(2, 1), edge(3, 2), edge(4, 3)],
  };
  const e = errorOf(await docItemChain(makeDb(store), { item_id: id(1), max_hops: 2 }, CTX));

  assert.match(e, /exceeds max_hops=2/);
  assert.match(e, /Raise max_hops/, "tells the caller how to proceed");
});

test("rejects a non-UUID and points at the right tool for codes", async () => {
  const store = { doc_items: [] as Row[], doc_item_links: [] as Row[] };
  const e = errorOf(await docItemChain(makeDb(store), { item_id: "D-101" }, CTX));

  assert.match(e, /must be a UUID/i);
  assert.match(e, /doc_item_resolve/, "a code has its own tool — codes travel onto the current version");
});

test("an unreadable start asserts neither existence nor absence", async () => {
  const store = { doc_items: [item(1)], doc_item_links: [] as Row[] };
  const e = errorOf(await docItemChain(makeDb(store, new Set([id(1)])), { item_id: id(1) }, CTX));

  // REQ-DOCM-012: never let "doesn't exist" and "you can't see it" be confused.
  assert.match(e, /may not exist, or it may exist in a document you cannot read/i);
  assert.match(e, /asserts neither/i);
});

test("does not follow an edge belonging to another project", async () => {
  // The edge exists but is scoped to a different project: the composite FK keeps
  // a supersede chain inside one project, so this must not be walked.
  const store = {
    doc_items: [item(1), item(2, { status: "active", project_id: OTHER_PROJ })],
    doc_item_links: [edge(2, 1, OTHER_PROJ)],
  };
  const d = ok(await docItemChain(makeDb(store), { item_id: id(1) }, CTX));

  assert.equal(d.resolved_id, id(1));
  assert.equal(d.hops, 0);
});

test("duplicate identical edges are not a fork", async () => {
  // Same successor recorded twice: an ambiguity error here would be a false alarm.
  const store = {
    doc_items: [item(1), item(2, { status: "active" })],
    doc_item_links: [edge(2, 1), edge(2, 1)],
  };
  const d = ok(await docItemChain(makeDb(store), { item_id: id(1) }, CTX));

  assert.equal(d.resolved_id, id(2));
  assert.equal(d.hops, 1);
});

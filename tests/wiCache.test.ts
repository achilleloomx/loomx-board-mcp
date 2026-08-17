// Unit tests for src/wiCache.ts syncWiCache — regression coverage for the
// wi_resume cache bug (GTD 4f05821c / board msg b4ff5966, fixed 2026-08-17):
// "most recent by started_at" picked a newer closed WI over an older WI that
// had just been reactivated via wi_resume, since started_at is stamped once
// at wi_start and never bumped by wi_pause/wi_resume.
//
// Run with: npx tsx --test tests/wiCache.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncWiCache } from "../src/wiCache.ts";

type Row = Record<string, unknown>;

function makeDb(rows: Row[]): SupabaseClient {
  function query(_table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;

    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      then(
        resolve: (v: { data: unknown; error: null }) => void,
        reject?: (e: unknown) => void
      ) {
        let data = rows.filter((r) => filters.every((f) => r[f.col] === f.val));
        if (orderCol) {
          const col = orderCol;
          data = [...data].sort((a, b) => {
            const av = a[col] as string;
            const bv = b[col] as string;
            if (av < bv) return orderAsc ? -1 : 1;
            if (av > bv) return orderAsc ? 1 : -1;
            return 0;
          });
        }
        if (limitN != null) data = data.slice(0, limitN);
        Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };

    return builder;
  }

  return { from: (table: string) => query(table) } as unknown as SupabaseClient;
}

function setupProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wicache-test-"));
  mkdirSync(join(dir, ".claude"));
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

function readCache(dir: string): Row {
  const cachePath = join(dir, ".claude", "cache", "current-work-item.json");
  return JSON.parse(readFileSync(cachePath, "utf8"));
}

test("syncWiCache: prefers the active WI over a more recently started but closed one (wi_resume bug)", async () => {
  const dir = setupProjectDir();
  const db = makeDb([
    { id: "wi-old", agent_slug: "app", status: "active", started_at: "2026-08-17T10:00:00.000Z" },
    { id: "wi-new", agent_slug: "app", status: "done", started_at: "2026-08-17T11:00:00.000Z" },
  ]);

  await syncWiCache(db, "app");

  const cached = readCache(dir);
  assert.equal(cached.id, "wi-old");
  assert.equal(cached.status, "active");
});

test("syncWiCache: falls back to the most-recently-started row when nothing is active", async () => {
  const dir = setupProjectDir();
  const db = makeDb([
    { id: "wi-a", agent_slug: "app", status: "done", started_at: "2026-08-17T10:00:00.000Z" },
    { id: "wi-b", agent_slug: "app", status: "paused", started_at: "2026-08-17T11:00:00.000Z" },
  ]);

  await syncWiCache(db, "app");

  const cached = readCache(dir);
  assert.equal(cached.id, "wi-b");
  assert.equal(cached.status, "paused");
});

test("syncWiCache: removes the cache file when the agent has no WI at all", async () => {
  const dir = setupProjectDir();
  const db = makeDb([]);

  await syncWiCache(db, "app");

  const cachePath = join(dir, ".claude", "cache", "current-work-item.json");
  assert.equal(existsSync(cachePath), false);
});

test("syncWiCache: only matches rows for the given agent_slug", async () => {
  const dir = setupProjectDir();
  const db = makeDb([
    { id: "wi-other", agent_slug: "dba", status: "active", started_at: "2026-08-17T12:00:00.000Z" },
  ]);

  await syncWiCache(db, "app");

  const cachePath = join(dir, ".claude", "cache", "current-work-item.json");
  assert.equal(existsSync(cachePath), false);
});

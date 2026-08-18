// D-a5 F4.5 — doc_rw transaction wrapper.
//
// CONTRACT (docs/CONTRACT_doc_rw_board_mcp.md, loomx-home-DBA):
//   Every doc_* call runs in ONE transaction:
//     BEGIN;
//     SET LOCAL ROLE doc_rw;                               -- fixed literal, no input
//     SELECT loomx_set_agent_slug($1);                     -- $1 = CALLER slug; SECURITY DEFINER validates slug
//     <doc_* queries>;
//     COMMIT;                                               -- (ROLLBACK on error)
//   so RLS (D-015) is enforced at DB-floor for the agent path (doc_rw is NOBYPASSRLS).
//   The caller slug is the board-mcp instance's own identity (selfSlug), NEVER user input.
//
// Two backends:
//   - 'pg'   (PRODUCTION): DOC_RW_DATABASE_URL → direct Postgres (Supavisor session mode).
//            One checked-out client per call → the whole handler runs in ONE transaction.
//   - 'mgmt' (SMOKE/DEV):  SUPABASE_MGMT_PAT + SUPABASE_PROJECT_REF → Supabase Management API.
//            Runs as `postgres` (can SET ROLE doc_rw). Each query is its OWN doc_rw
//            transaction (NOT atomic across a handler's queries) → use only for smoke
//            validation when no direct-pg credential is available. The GUC is set on
//            every query, so RLS is consistent per call.

import pg from "pg";
import { PgQuery, type PgExecutor, getNativePool } from "./pg-shim.js";

const DOC_RW_ROLE = "doc_rw";
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export type DocRwMode = "pg" | "native" | "mgmt" | null;

// D-084 Fase 1(c): with a native DATABASE_URL connection (GRANT doc_rw TO
// <agent role> done by DBA) doc_* reuses that same connection/pool instead of
// requiring a second DOC_RW_DATABASE_URL — one URL per agent. DOC_RW_DATABASE_URL
// stays supported and takes priority (explicit opt-out of reuse, e.g. a
// dedicated doc_rw credential); mgmt stays the smoke/dev fallback.
export function docRwMode(): DocRwMode {
  if (process.env.DOC_RW_DATABASE_URL) return "pg";
  if (process.env.DATABASE_URL) return "native";
  if (process.env.SUPABASE_MGMT_PAT && process.env.SUPABASE_PROJECT_REF) return "mgmt";
  return null;
}

// A transaction-scoped DB handle with the same surface docs.ts uses, plus the
// DB-function resolver and a marker the handlers branch on.
export interface DocRwDb {
  __docRw: true;
  from: (table: string) => PgQuery;
  // RLS-aware code→uuid via the DB function (audited, raises 42501/P0002/22004).
  resolveDocItem: (projectId: string, code: string) => Promise<string>;
  // Atomic link repoint for doc_supersede (D-133, dba msg 2b4acbcc, migration
  // 20260816100000). SECURITY DEFINER — bypasses the RLS gap where doc_rw has no
  // UPDATE policy on doc_item_links/doc_item_gtd_links/doc_item_wi_links/
  // doc_item_xproject_links. Rejects (23514) unless old.status='superseded'.
  // Returns the total row count touched across all six directions.
  relinkSuperseded: (oldItemId: string, newItemId: string) => Promise<number>;
  // D-167: tells apart "row doesn't exist" from "row exists but RLS hides it" on a
  // 0-row SELECT — a plain doc_rw scan can't, since RLS filters silently either way.
  // loomx_agent_in_project is SECURITY DEFINER (reads loomx_projects/loomx_project_members
  // past the caller's own RLS) and already GRANTed to doc_rw, so this needs no new DB
  // object: true if selfSlug leads/shares-team/co-engages on the project (or is loomy/pmo).
  agentInProject: (projectId: string) => Promise<boolean>;
}

export function assertSlug(slug: string): void {
  if (!slug || !VALID_SLUG.test(slug)) {
    throw new Error(`doc_rw: refusing to set an invalid agent slug '${slug}' as identity`);
  }
}

// ---------------------------------------------------------------------------
// pg backend (production)
// ---------------------------------------------------------------------------

let pgPool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: process.env.DOC_RW_DATABASE_URL,
      max: 5,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

async function runWithPool<T>(
  pool: pg.Pool,
  slug: string,
  fn: (db: DocRwDb) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${DOC_RW_ROLE}`); // role is a fixed literal
    await client.query("SELECT loomx_set_agent_slug($1)", [slug]); // SECURITY DEFINER; validates slug
    const exec: PgExecutor = (sql, params) => client.query(sql, params);
    const db = makeDb(exec);
    const result = await fn(db);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function runPg<T>(slug: string, fn: (db: DocRwDb) => Promise<T>): Promise<T> {
  return runWithPool(getPool(), slug, fn);
}

// D-084 Fase 1(c): reuses the native DATABASE_URL pool (owned by pg-shim.ts /
// initialized via supabase.ts's resolveSelfSlug at boot). If it's somehow not
// initialized yet, fail loud rather than silently falling back to a bypass.
async function runNative<T>(slug: string, fn: (db: DocRwDb) => Promise<T>): Promise<T> {
  const pool = getNativePool();
  if (!pool) {
    throw new Error(
      "doc_rw native mode: DATABASE_URL pool not initialized. This should not happen — " +
        "the board client (supabase.ts) initializes it at startup whenever DATABASE_URL is set."
    );
  }
  return runWithPool(pool, slug, fn);
}

// ---------------------------------------------------------------------------
// mgmt backend (smoke/dev) — Supabase Management API /database/query
// ---------------------------------------------------------------------------

export function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    throw new Error("doc_rw mgmt mode: array params not supported (use DOC_RW_DATABASE_URL / pg backend)");
  }
  if (typeof v === "object") {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Inline $N placeholders as escaped literals (Management API has no bind params).
// Safe: only VALUES are inlined (escaped); SQL structure is built by PgQuery.
export function inlineParams(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n) => literal(params[Number(n) - 1]));
}

// Build the full doc_rw transaction block for the Management API path.
// The Management API returns the LAST *row-producing* statement's rows, so the
// slug must be set WITHOUT producing a result set (else a 0-row data query would
// be masked). A DO block PERFORMs loomx_set_agent_slug silently (SECURITY DEFINER,
// validates slug, sets the GUC) → the data statement is the only producer.
// The slug is escape-hardened; assertSlug() already rejects any non-[a-z0-9-] chars.
export function buildMgmtSql(slug: string, sql: string, params: unknown[]): string {
  const esc = slug.replace(/'/g, "''");
  return (
    `BEGIN; SET LOCAL ROLE ${DOC_RW_ROLE}; ` +
    `DO $docrw$ BEGIN PERFORM loomx_set_agent_slug('${esc}'); END $docrw$; ` +
    `${inlineParams(sql, params)}; COMMIT;`
  );
}

async function mgmtQuery(fullSql: string): Promise<Row[]> {
  const ref = process.env.SUPABASE_PROJECT_REF!;
  const pat = process.env.SUPABASE_MGMT_PAT!;
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: fullSql }),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    // Surface the DB error (incl. SQLSTATE) so handlers can map 42501/P0002/22004.
    const msg = typeof parsed === "object" && parsed
      ? JSON.stringify(parsed)
      : String(parsed);
    const err = new Error(msg) as Error & { code?: string };
    const m = msg.match(/\b(42501|P0002|22004|23505|23503)\b/) || msg.match(/insufficient_privilege|no_data_found|null_value_not_allowed/);
    if (m) err.code = m[0];
    throw err;
  }
  return Array.isArray(parsed) ? (parsed as Row[]) : [];
}

type Row = Record<string, unknown>;

function makeMgmtExecutor(slug: string): PgExecutor {
  return async (sql, params) => {
    const rows = await mgmtQuery(buildMgmtSql(slug, sql, params));
    return { rows };
  };
}

async function runMgmt<T>(slug: string, fn: (db: DocRwDb) => Promise<T>): Promise<T> {
  // No persistent transaction: each query carries its own SET LOCAL ROLE + GUC.
  return fn(makeDb(makeMgmtExecutor(slug)));
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function makeDb(exec: PgExecutor): DocRwDb {
  return {
    __docRw: true,
    // noReturning: under doc_rw, `… RETURNING` makes the RLS WITH CHECK wrongly
    // deny GUC-based writes (verified deterministically). See PgQuery docs.
    from: (table: string) => new PgQuery(exec, table, { noReturning: true }),
    resolveDocItem: async (projectId: string, code: string) => {
      const { rows } = await exec("SELECT doc_item_resolve($1::uuid, $2) AS item_id", [projectId, code]);
      const id = rows[0] && (rows[0] as Row).item_id;
      if (!id) {
        const e = new Error("doc_item_resolve returned no uuid") as Error & { code?: string };
        e.code = "P0002";
        throw e;
      }
      return id as string;
    },
    relinkSuperseded: async (oldItemId: string, newItemId: string) => {
      const { rows } = await exec("SELECT gov.relink_superseded($1::uuid, $2::uuid) AS n", [oldItemId, newItemId]);
      const n = rows[0] && (rows[0] as Row).n;
      return typeof n === "number" ? n : Number(n ?? 0);
    },
    agentInProject: async (projectId: string) => {
      const { rows } = await exec("SELECT loomx_agent_in_project($1::uuid) AS ok", [projectId]);
      const r = rows[0] as Row | undefined;
      return Boolean(r && r.ok);
    },
  };
}

/**
 * Run `fn` under the doc_rw role with the caller's slug bound into the GUC.
 * Throws if no doc_rw backend is configured (refuses to fall back to a
 * service_role/bypass path — contract rule #4).
 */
export async function runDocRw<T>(slug: string, fn: (db: DocRwDb) => Promise<T>): Promise<T> {
  assertSlug(slug);
  const mode = docRwMode();
  if (mode === "pg") return runPg(slug, fn);
  if (mode === "native") return runNative(slug, fn);
  if (mode === "mgmt") return runMgmt(slug, fn);
  throw new Error(
    "doc_* tools require the doc_rw wiring (D-a5 F4.5): set DOC_RW_DATABASE_URL " +
      "(direct Postgres, login role with `GRANT doc_rw`) — or, for smoke/dev, " +
      "SUPABASE_MGMT_PAT + SUPABASE_PROJECT_REF. Refusing to run doc_* as service_role " +
      "(it would bypass RLS and defeat D-015)."
  );
}

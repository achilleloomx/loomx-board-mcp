// Minimal Supabase-query-builder shim backed by node-postgres (pg).
// Implements only the subset of methods used by src/tools.ts so the backend
// can be swapped via DATABASE_URL without rewriting tool code.
//
// Supported: from().select/insert/update/upsert/eq/gte/lte/gt/lt/is/in/not/contains/or/order/limit/single/maybeSingle,
// and rpc(). Awaiting any chain returns { data, error } like supabase-js.

import pg from "pg";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type DbResult<T> = { data: T | null; error: { message: string } | null };

// Executor abstraction: PgQuery builds SQL and delegates execution. A pooled
// client runs each query on its own connection; a transaction-bound client (see
// src/docDb.ts) runs every query on ONE checked-out connection inside an open
// BEGIN…COMMIT — which is what `SET LOCAL ROLE doc_rw` requires (D-a5 F4.5).
export type PgExecutor = (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;

interface Filter {
  type: "eq" | "is" | "in" | "not" | "contains" | "or" | "gte" | "lte" | "gt" | "lt";
  col?: string;
  op?: string;
  val?: unknown;
  arr?: unknown[];
  str?: string;
}

interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

function ident(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

export class PgQuery<T = Row> implements PromiseLike<DbResult<T>> {
  private _op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private _cols = "*";
  private _filters: Filter[] = [];
  private _orders: OrderSpec[] = [];
  private _limit: number | null = null;
  private _insertData: Row | Row[] | null = null;
  private _updateData: Row | null = null;
  private _upsertOnConflict: string[] = [];
  private _returning: string | null = null;
  private _single = false;
  private _maybeSingle = false;

  // noReturning (D-a5 F4.5): under the doc_rw role, an `INSERT/UPDATE … RETURNING`
  // makes the RLS WITH CHECK policy evaluate its STABLE GUC-reading function
  // (loomx_get_owner_slug via request.agent_slug) as if the GUC were unset →
  // false → the write is wrongly denied (42501). Verified deterministically:
  // same write WITHOUT RETURNING passes. So in this mode we never emit RETURNING:
  // INSERTs get a client-generated id and synthesize the result row; UPDATEs do a
  // follow-up SELECT. (The proper long-term fix is DB-side — mark the policy
  // helpers VOLATILE — but this keeps the tools working today.)
  constructor(
    private exec: PgExecutor,
    private table: string,
    private opts: { noReturning?: boolean } = {}
  ) {}

  select(cols = "*"): this {
    if (this._op === "insert" || this._op === "update" || this._op === "delete" || this._op === "upsert") {
      this._returning = cols;
    } else {
      this._op = "select";
      this._cols = cols;
    }
    return this;
  }

  insert(data: Row | Row[]): this {
    this._op = "insert";
    this._insertData = data;
    return this;
  }

  update(data: Row): this {
    this._op = "update";
    this._updateData = data;
    return this;
  }

  upsert(data: Row | Row[], opts: { onConflict?: string } = {}): this {
    this._op = "upsert";
    this._insertData = data;
    this._upsertOnConflict = (opts.onConflict ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    return this;
  }

  delete(): this {
    this._op = "delete";
    return this;
  }

  eq(col: string, val: unknown): this {
    this._filters.push({ type: "eq", col, val });
    return this;
  }

  gte(col: string, val: unknown): this {
    this._filters.push({ type: "gte", col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this._filters.push({ type: "lte", col, val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this._filters.push({ type: "gt", col, val });
    return this;
  }

  lt(col: string, val: unknown): this {
    this._filters.push({ type: "lt", col, val });
    return this;
  }

  is(col: string, val: unknown): this {
    this._filters.push({ type: "is", col, val });
    return this;
  }

  in(col: string, arr: unknown[]): this {
    this._filters.push({ type: "in", col, arr });
    return this;
  }

  not(col: string, op: string, val: unknown): this {
    this._filters.push({ type: "not", col, op, val });
    return this;
  }

  contains(col: string, arr: unknown[]): this {
    this._filters.push({ type: "contains", col, arr });
    return this;
  }

  or(str: string): this {
    this._filters.push({ type: "or", str });
    return this;
  }

  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this._orders.push({
      col,
      ascending: opts.ascending !== false,
      nullsFirst: opts.nullsFirst,
    });
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  single(): this {
    this._single = true;
    return this;
  }

  maybeSingle(): this {
    this._maybeSingle = true;
    return this;
  }

  // PromiseLike: allow `await query` to trigger execution
  then<TResult1 = DbResult<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: DbResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
  ): PromiseLike<TResult1 | TResult2> {
    return this._execute().then(onfulfilled, onrejected);
  }

  private _buildWhere(params: unknown[]): string {
    if (this._filters.length === 0) return "";
    const clauses: string[] = [];
    for (const f of this._filters) {
      switch (f.type) {
        case "eq": {
          params.push(f.val);
          clauses.push(`${ident(f.col!)} = $${params.length}`);
          break;
        }
        case "gte": {
          params.push(f.val);
          clauses.push(`${ident(f.col!)} >= $${params.length}`);
          break;
        }
        case "lte": {
          params.push(f.val);
          clauses.push(`${ident(f.col!)} <= $${params.length}`);
          break;
        }
        case "gt": {
          params.push(f.val);
          clauses.push(`${ident(f.col!)} > $${params.length}`);
          break;
        }
        case "lt": {
          params.push(f.val);
          clauses.push(`${ident(f.col!)} < $${params.length}`);
          break;
        }
        case "is": {
          if (f.val === null) {
            clauses.push(`${ident(f.col!)} IS NULL`);
          } else {
            params.push(f.val);
            clauses.push(`${ident(f.col!)} IS $${params.length}`);
          }
          break;
        }
        case "in": {
          params.push(f.arr);
          clauses.push(`${ident(f.col!)} = ANY($${params.length})`);
          break;
        }
        case "not": {
          // "in" op: not(col, "in", "(done,trash)")
          if (f.op === "in" && typeof f.val === "string") {
            const items = f.val
              .replace(/^\(|\)$/g, "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            params.push(items);
            clauses.push(`${ident(f.col!)} <> ALL($${params.length})`);
          } else if (f.op === "is" && f.val === null) {
            // "is" op: not(col, "is", null) → col IS NOT NULL
            clauses.push(`${ident(f.col!)} IS NOT NULL`);
          } else {
            throw new Error(`Unsupported .not() form: ${f.op}`);
          }
          break;
        }
        case "contains": {
          // PostgREST .contains on array/jsonb → @> operator
          params.push(f.arr);
          clauses.push(`${ident(f.col!)} @> $${params.length}`);
          break;
        }
        case "or": {
          // Parse simple "col.eq.val,col.eq.val" syntax
          const parts = f.str!.split(",");
          const sub: string[] = [];
          for (const p of parts) {
            const m = p.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.eq\.(.+)$/);
            if (!m) throw new Error(`Unsupported .or() clause: ${p}`);
            params.push(m[2]);
            sub.push(`${ident(m[1]!)} = $${params.length}`);
          }
          clauses.push(`(${sub.join(" OR ")})`);
          break;
        }
      }
    }
    return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  }

  private _buildOrderLimit(): string {
    let out = "";
    if (this._orders.length) {
      const parts = this._orders.map((o) => {
        let s = `${ident(o.col)} ${o.ascending ? "ASC" : "DESC"}`;
        if (o.nullsFirst === true) s += " NULLS FIRST";
        else if (o.nullsFirst === false) s += " NULLS LAST";
        return s;
      });
      out += ` ORDER BY ${parts.join(", ")}`;
    }
    if (this._limit != null) out += ` LIMIT ${this._limit}`;
    return out;
  }

  private _buildReturning(): string {
    if (!this._returning) return "";
    if (this._returning === "*") return " RETURNING *";
    // Comma-separated column list
    const cols = this._returning
      .split(",")
      .map((c) => ident(c.trim()))
      .join(", ");
    return ` RETURNING ${cols}`;
  }

  private async _execute(): Promise<DbResult<T>> {
    try {
      let sql = "";
      const params: unknown[] = [];
      // When set, the executor returns no rows (no RETURNING) and these rows are
      // used as the synthesized result instead.
      let synthesizedRows: Row[] | null = null;

      if (this._op === "select") {
        const cols =
          this._cols === "*"
            ? "*"
            : this._cols
                .split(",")
                .map((c) => ident(c.trim()))
                .join(", ");
        sql = `SELECT ${cols} FROM ${ident(this.table)}`;
        sql += this._buildWhere(params);
        sql += this._buildOrderLimit();
      } else if (this._op === "insert") {
        let rows = Array.isArray(this._insertData)
          ? this._insertData
          : [this._insertData!];
        if (rows.length === 0) throw new Error("insert: no rows");
        // doc_rw: inject a client-side id so we can return it without RETURNING.
        if (this.opts.noReturning) {
          rows = rows.map((r) =>
            (r as Row).id === undefined ? { id: randomUUID(), ...(r as Row) } : r
          );
          synthesizedRows = rows as Row[];
        }
        const cols = Object.keys(rows[0]!);
        const colsSql = cols.map(ident).join(", ");
        const valuesSql = rows
          .map((r) => {
            const placeholders = cols.map((c) => {
              params.push((r as Row)[c]);
              return `$${params.length}`;
            });
            return `(${placeholders.join(", ")})`;
          })
          .join(", ");
        sql = `INSERT INTO ${ident(this.table)} (${colsSql}) VALUES ${valuesSql}`;
        if (!this.opts.noReturning) sql += this._buildReturning();
      } else if (this._op === "upsert") {
        let rows = Array.isArray(this._insertData)
          ? this._insertData
          : [this._insertData!];
        if (rows.length === 0) throw new Error("upsert: no rows");
        if (this.opts.noReturning) {
          rows = rows.map((r) =>
            (r as Row).id === undefined ? { id: randomUUID(), ...(r as Row) } : r
          );
          synthesizedRows = rows as Row[];
        }
        const cols = Object.keys(rows[0]!);
        const colsSql = cols.map(ident).join(", ");
        const valuesSql = rows
          .map((r) => {
            const placeholders = cols.map((c) => {
              params.push((r as Row)[c]);
              return `$${params.length}`;
            });
            return `(${placeholders.join(", ")})`;
          })
          .join(", ");
        sql = `INSERT INTO ${ident(this.table)} (${colsSql}) VALUES ${valuesSql}`;
        if (this._upsertOnConflict.length === 0) {
          throw new Error("upsert: onConflict is required");
        }
        const conflictCols = this._upsertOnConflict.map(ident).join(", ");
        // Mirror PostgREST's merge-duplicates upsert: always DO UPDATE (never DO
        // NOTHING) so RETURNING reliably yields the row even when the conflict
        // columns are the only columns being written (e.g. a pure link table).
        const updateCols = cols.filter((c) => !this._upsertOnConflict.includes(c));
        const setCols = updateCols.length > 0 ? updateCols : this._upsertOnConflict;
        const setSql = setCols
          .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`)
          .join(", ");
        sql += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setSql}`;
        if (!this.opts.noReturning) sql += this._buildReturning();
      } else if (this._op === "update") {
        const cols = Object.keys(this._updateData!);
        const sets = cols.map((c) => {
          params.push((this._updateData as Row)[c]);
          return `${ident(c)} = $${params.length}`;
        });
        sql = `UPDATE ${ident(this.table)} SET ${sets.join(", ")}`;
        sql += this._buildWhere(params);
        if (!this.opts.noReturning) sql += this._buildReturning();
      } else if (this._op === "delete") {
        sql = `DELETE FROM ${ident(this.table)}`;
        sql += this._buildWhere(params);
        sql += this._buildReturning();
      }

      // Execute, applying the doc_rw no-RETURNING strategy.
      let res: { rows: Row[] };
      if (this.opts.noReturning && (this._op === "insert" || this._op === "upsert")) {
        // Run the INSERT/UPSERT (no RETURNING); return the client-synthesized rows.
        await this.exec(sql, params);
        res = { rows: synthesizedRows ?? [] };
      } else if (this.opts.noReturning && this._op === "update" && this._returning) {
        // Run the UPDATE (no RETURNING), then a follow-up SELECT for the row(s).
        await this.exec(sql, params);
        const selParams: unknown[] = [];
        const selCols =
          this._returning === "*"
            ? "*"
            : this._returning.split(",").map((c) => ident(c.trim())).join(", ");
        const selSql =
          `SELECT ${selCols} FROM ${ident(this.table)}` + this._buildWhere(selParams);
        res = await this.exec(selSql, selParams);
      } else {
        res = await this.exec(sql, params);
      }
      let data: unknown = res.rows;
      if (this._single) {
        if (res.rows.length === 0) {
          return {
            data: null,
            error: { message: "No rows returned" },
          };
        }
        data = res.rows[0];
      } else if (this._maybeSingle) {
        // Like single() but returns { data: null, error: null } on 0 rows (not an error)
        data = res.rows.length > 0 ? res.rows[0] : null;
      }
      return { data: data as T, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { data: null, error: { message: msg } };
    }
  }
}

export class PgShimClient {
  constructor(private pool: pg.Pool) {}

  async verifyIdentity(): Promise<{ current_user: string; session_user: string }> {
    const res = await this.pool.query("SELECT current_user, session_user");
    return res.rows[0] as { current_user: string; session_user: string };
  }

  from(table: string): PgQuery {
    return new PgQuery((sql, params) => this.pool.query(sql, params), table);
  }

  async rpc(
    fn: string,
    params: Record<string, unknown>
  ): Promise<DbResult<unknown>> {
    try {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fn)) {
        throw new Error(`Invalid function name: ${fn}`);
      }
      const keys = Object.keys(params);
      const values = keys.map((k) => params[k]);
      const placeholders = keys.map((k, i) => `${k} => $${i + 1}`);
      const sql = `SELECT * FROM ${fn}(${placeholders.join(", ")})`;
      const res = await this.pool.query(sql, values);

      // Mirror supabase-js behavior: scalar-returning functions return the
      // raw scalar as `data`, set-returning functions return an array of rows.
      if (
        res.rows.length === 1 &&
        Object.keys(res.rows[0]!).length === 1 &&
        Object.prototype.hasOwnProperty.call(res.rows[0], fn)
      ) {
        return { data: (res.rows[0] as Row)[fn], error: null };
      }
      return { data: res.rows, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { data: null, error: { message: msg } };
    }
  }
}

let pool: pg.Pool | null = null;

export function createPgClient(databaseUrl: string): PgShimClient {
  if (!pool) {
    // connectionTimeoutMillis: node-postgres defaults to 0 (wait forever) — a
    // transient network/DB blip at boot would hang startServer() indefinitely
    // instead of failing, since nothing upstream imposes its own timeout
    // (RCA GTD c454dbd5: dev-pieroni window stuck with board MCP unreachable,
    // -32000 on the client side with nothing logged on ours).
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 8000 });
  }
  return new PgShimClient(pool);
}

// D-084 Fase 1(c): exposes the pool backing the native DATABASE_URL connection
// (if one was created) so docDb.ts can reuse it for doc_rw transactions
// (SET LOCAL ROLE doc_rw) instead of opening a second connection/URL per agent.
// Returns null if the pg backend was never initialized (e.g. DATABASE_URL unset).
export function getNativePool(): pg.Pool | null {
  return pool;
}


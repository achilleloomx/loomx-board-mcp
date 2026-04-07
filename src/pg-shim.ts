// Minimal Supabase-query-builder shim backed by node-postgres (pg).
// Implements only the subset of methods used by src/tools.ts so the backend
// can be swapped via DATABASE_URL without rewriting tool code.
//
// Supported: from().select/insert/update/eq/is/in/not/contains/or/order/limit/single,
// and rpc(). Awaiting any chain returns { data, error } like supabase-js.

import pg from "pg";

type Row = Record<string, unknown>;
type DbResult<T> = { data: T | null; error: { message: string } | null };

interface Filter {
  type: "eq" | "is" | "in" | "not" | "contains" | "or";
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

class PgQuery<T = Row> implements PromiseLike<DbResult<T>> {
  private _op: "select" | "insert" | "update" = "select";
  private _cols = "*";
  private _filters: Filter[] = [];
  private _orders: OrderSpec[] = [];
  private _limit: number | null = null;
  private _insertData: Row | Row[] | null = null;
  private _updateData: Row | null = null;
  private _returning: string | null = null;
  private _single = false;

  constructor(private pool: pg.Pool, private table: string) {}

  select(cols = "*"): this {
    if (this._op === "insert" || this._op === "update") {
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

  eq(col: string, val: unknown): this {
    this._filters.push({ type: "eq", col, val });
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
          // Only "in" op used in tools.ts: not(col, "in", "(done,trash)")
          if (f.op === "in" && typeof f.val === "string") {
            const items = f.val
              .replace(/^\(|\)$/g, "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            params.push(items);
            clauses.push(`${ident(f.col!)} <> ALL($${params.length})`);
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
        const rows = Array.isArray(this._insertData)
          ? this._insertData
          : [this._insertData!];
        if (rows.length === 0) throw new Error("insert: no rows");
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
        sql += this._buildReturning();
      } else if (this._op === "update") {
        const cols = Object.keys(this._updateData!);
        const sets = cols.map((c) => {
          params.push((this._updateData as Row)[c]);
          return `${ident(c)} = $${params.length}`;
        });
        sql = `UPDATE ${ident(this.table)} SET ${sets.join(", ")}`;
        sql += this._buildWhere(params);
        sql += this._buildReturning();
      }

      const res = await this.pool.query(sql, params);
      let data: unknown = res.rows;
      if (this._single) {
        if (res.rows.length === 0) {
          return {
            data: null,
            error: { message: "No rows returned" },
          };
        }
        data = res.rows[0];
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
    return new PgQuery(this.pool, table);
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
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  }
  return new PgShimClient(pool);
}


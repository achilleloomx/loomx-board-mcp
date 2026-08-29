// Shared fake-DB harness for docs.ts / subscriptions.ts unit tests. Mimics
// the subset of supabase-js (+ the DocRwDb probes: resolveDocItem,
// relinkSuperseded, agentInProject, documentExists) that the doc_* / gov.*
// handlers use. Plain module — no `test()` calls here, so importing it never
// registers or re-runs tests as a side effect (unlike importing a *.test.ts
// file directly, which would).

import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, any>;
export type Store = { [table: string]: Row[] };

let idSeq = 0;
export function uuid(): string {
  idSeq += 1;
  const n = idSeq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

// `rls: true` makes SELECTs on `documents` behave like production does (measured
// 2026-08-18 under doc_rw: documents_select USING loomx_document_visibility_predicate
// → visibility='org' readable from anywhere, 'project'/'team' only for members).
// Opt-in: the pre-existing tests seed documents into projects they hold no
// membership on, and enforcing RLS for them would test the fake, not the handler.
export function makeDb(store: Store, members: Set<string> = new Set(), opts: { rls?: boolean } = {}): SupabaseClient {
  store.documents ??= [];
  store.doc_items ??= [];
  store.doc_item_links ??= [];
  store.doc_item_gtd_links ??= [];
  store.doc_item_wi_links ??= [];
  store.doc_item_xproject_links ??= [];
  store.loomx_projects ??= [];

  // Mimics the real doc_rw contract (docDb.ts runWithPool): the whole handler runs
  // in ONE open transaction, so a constraint violation aborts it — every subsequent
  // query fails with "current transaction is aborted" until a ROLLBACK TO SAVEPOINT.
  // Bug d6a57035 (atlas): without this simulation, tests couldn't see the failure
  // mode that only showed up against the real DB.
  const txState = { aborted: false };

  function query(table: string) {
    const filters: Array<{ col: string; val: unknown; op: "eq" | "in" | "gte" | "lte" | "is" }> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let insertData: Row | null = null;
    let updateData: Row | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let single = false;
    let maybeSingle = false;

    const apply = (rows: Row[]): Row[] =>
      rows.filter((r) =>
        filters.every((f) => {
          if (f.op === "eq") return r[f.col] === f.val;
          if (f.op === "in") return (f.val as unknown[]).includes(r[f.col]);
          // gte/lte: string compare — correct for lowercase UUIDs (bytewise
          // order matches lexicographic on the canonical form), which is what
          // idResolve's range scan relies on.
          if (f.op === "gte") return typeof r[f.col] === "string" && (r[f.col] as string) >= (f.val as string);
          if (f.op === "lte") return typeof r[f.col] === "string" && (r[f.col] as string) <= (f.val as string);
          if (f.op === "is") return r[f.col] === f.val || (f.val === null && r[f.col] === undefined);
          return true;
        })
      );

    function checkConstraints(table: string, rowToInsert: Row): string | null {
      if (table === "doc_items" && rowToInsert.code != null) {
        const dup = store.doc_items.some(
          (r) => r.project_id === rowToInsert.project_id && r.code === rowToInsert.code
        );
        if (dup) return "duplicate key value violates unique constraint uq_doc_items_project_code";
      }
      if (table === "doc_item_links") {
        const from = store.doc_items.find((r) => r.id === rowToInsert.from_item);
        const to = store.doc_items.find((r) => r.id === rowToInsert.to_item);
        if (!from || from.project_id !== rowToInsert.project_id) {
          return 'insert violates foreign key constraint "doc_item_links_from_fk"';
        }
        if (!to || to.project_id !== rowToInsert.project_id) {
          return 'insert violates foreign key constraint "doc_item_links_to_fk"';
        }
        const dupLink = store.doc_item_links.some(
          (r) => r.from_item === rowToInsert.from_item && r.to_item === rowToInsert.to_item && r.relation_type === rowToInsert.relation_type
        );
        if (dupLink) return "duplicate key value violates unique constraint doc_item_links_unique";
        if (rowToInsert.from_item === rowToInsert.to_item) return "violates check constraint doc_item_links_no_self_link";
      }
      if (table === "doc_item_gtd_links") {
        const dup = store.doc_item_gtd_links.some(
          (r) => r.doc_item_id === rowToInsert.doc_item_id && r.gtd_item_id === rowToInsert.gtd_item_id
        );
        if (dup) return "duplicate key value violates unique constraint doc_item_gtd_links_unique";
      }
      // gov.doc_subscription_outcomes: UNIQUE (subscription_id, publication_id) —
      // mirrors the live constraint measured 2026-08-21 (DEL-002 subscriptions).
      if (table === "gov.doc_subscription_outcomes") {
        const rows = (store["gov.doc_subscription_outcomes"] ?? []) as Row[];
        const dup = rows.some(
          (r) => r.subscription_id === rowToInsert.subscription_id && r.publication_id === rowToInsert.publication_id
        );
        if (dup) return "duplicate key value violates unique constraint doc_subscription_outcomes_once";
      }
      return null;
    }

    const exec = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
      if (txState.aborted) {
        return {
          data: null,
          error: { message: "current transaction is aborted, commands ignored until end of transaction block" },
        };
      }
      store[table] ??= [];
      if (op === "insert") {
        const row: Row = { id: uuid(), ...insertData };
        if (table === "doc_items") {
          row.sort_order ??= 0;
          row.attrs ??= {};
        }
        const cerr = checkConstraints(table, row);
        if (cerr) {
          txState.aborted = true;
          return { data: null, error: { message: cerr } };
        }
        store[table].push(row);
        return finalize([row]);
      }
      if (op === "update") {
        const matched = apply(store[table]);
        matched.forEach((r) => Object.assign(r, updateData));
        // Mimics gov.doc_subscription_staleness_guard_update (DEL-008 migration
        // 20260822090000): the trigger stamps closed_at when status transitions to
        // 'closed' and the tool didn't set it itself — application code never sets
        // this column directly (see src/staleness.ts docStalenessClose).
        if (table === "gov.doc_subscription_staleness") {
          for (const r of matched) {
            if (r.status === "closed" && !r.closed_at) r.closed_at = "2026-08-25T00:00:00.000Z";
          }
        }
        return finalize(matched);
      }
      if (op === "delete") {
        const matched = apply(store[table]);
        store[table] = store[table].filter((r) => !matched.includes(r));
        return finalize(matched);
      }
      // select
      let rows = apply(store[table]);
      if (opts.rls && table === "documents") {
        rows = rows.filter((r) => r.visibility === "org" || members.has(r.project_id as string));
      }
      // doc_items RLS rides on the parent document's visibility (same
      // predicate as `documents`, SDES-DOCM-005) — production measured this
      // 2026-08-27 (msg loomy 31b5767e/aa43f599): a doc_items row is only
      // readable when its document is. doc_item_links has NO such filter here
      // (matches production: it's project_id-scoped only, not per-document —
      // that gap is exactly what the traceability fix above has to work around).
      if (opts.rls && table === "doc_items") {
        rows = rows.filter((r) => {
          const doc = (store.documents as Row[]).find((d) => d.id === r.document_id);
          if (!doc) return false;
          return doc.visibility === "org" || members.has(doc.project_id as string);
        });
      }
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = a[orderCol!], bv = b[orderCol!];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return finalize(rows);
    };

    function finalize(rows: Row[]): { data: unknown; error: { message: string } | null } {
      if (single) {
        if (rows.length === 0) return { data: null, error: { message: "No rows returned" } };
        return { data: rows[0], error: null };
      }
      if (maybeSingle) {
        return { data: rows.length > 0 ? rows[0] : null, error: null };
      }
      return { data: rows, error: null };
    }

    const builder: any = {
      select() { return builder; },
      eq(col: string, val: unknown) { filters.push({ col, val, op: "eq" }); return builder; },
      in(col: string, arr: unknown[]) { filters.push({ col, val: arr, op: "in" }); return builder; },
      gte(col: string, val: unknown) { filters.push({ col, val, op: "gte" }); return builder; },
      lte(col: string, val: unknown) { filters.push({ col, val, op: "lte" }); return builder; },
      is(col: string, val: unknown) { filters.push({ col, val, op: "is" }); return builder; },
      order(col: string, opts: { ascending?: boolean } = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      single() { single = true; return exec(); },
      maybeSingle() { maybeSingle = true; return exec(); },
      insert(data: Row) { op = "insert"; insertData = data; return builder; },
      update(data: Row) { op = "update"; updateData = data; return builder; },
      delete() { op = "delete"; return builder; },
      then(onF: any, onR: any) { return exec().then(onF, onR); },
    };
    return builder;
  }

  // REQ-GOV-016: fake must implement DocRwDb so docItemResolve uses the __docRw path
  // (the fallback direct-scan is now a throw). resolveDocItem mimics the DB function:
  // find by (project_id, code), throw P0002 if not found.
  const resolveDocItem = async (projectId: string, code: string): Promise<string> => {
    const item = (store.doc_items as Row[]).find(
      (r) => r.project_id === projectId && r.code === code
    );
    if (!item) {
      const e = new Error("no_data_found") as Error & { code?: string };
      e.code = "P0002";
      throw e;
    }
    return item.id as string;
  };

  // Mimics gov.relink_superseded (D-133): repoint every link direction across all
  // four tables from oldItemId → newItemId, return the total rows touched. The real
  // function is SECURITY DEFINER, so unlike a plain doc_rw .update() it can never
  // silently affect 0 rows on a missing RLS policy.
  const relinkSuperseded = async (oldItemId: string, newItemId: string): Promise<number> => {
    let n = 0;
    const repoint = (rows: Row[], col: string) => {
      for (const r of rows) {
        if (r[col] === oldItemId) { r[col] = newItemId; n++; }
      }
    };
    repoint(store.doc_item_links, "from_item");
    repoint(store.doc_item_links, "to_item");
    repoint(store.doc_item_gtd_links, "doc_item_id");
    repoint(store.doc_item_wi_links, "doc_item_id");
    repoint(store.doc_item_xproject_links, "from_item");
    repoint(store.doc_item_xproject_links, "to_item");
    return n;
  };

  // D-167: mimics loomx_agent_in_project (SECURITY DEFINER, granted to doc_rw) —
  // true iff selfSlug is in the caller-supplied `members` set for that project.
  const agentInProject = async (projectId: string): Promise<boolean> => members.has(projectId);

  // D-167 point 4: mimics doc_document_exists (SECURITY DEFINER, sees past RLS) —
  // a raw existence check against `documents`, ignoring visibility/membership
  // entirely (that's the whole point of the oracle).
  const documentExists = async (documentId: string): Promise<boolean> =>
    (store.documents as Row[]).some((r) => r.id === documentId);

  // D-233 fase 4: mimics gov.doc_publication_state — has this document EVER
  // been published, and what's its latest version.
  const publicationState = async (documentId: string) => {
    const versions = ((store["gov.doc_versions"] as Row[]) ?? [])
      .filter((r) => r.document_id === documentId)
      .sort((a, b) => Number(b.version_seq ?? 0) - Number(a.version_seq ?? 0));
    const latest = versions[0];
    return {
      is_published: versions.length > 0,
      version_count: versions.length,
      last_version_seq: latest ? Number(latest.version_seq ?? 0) : null,
      last_version_label: latest ? String(latest.version_label) : null,
      last_published_at: latest ? String(latest.published_at) : null,
    };
  };

  // D-233 fase 4: mimics gov.doc_item_substantive_diff on a NARROW column set
  // (title, summary, body, attrs, status) — good enough to exercise
  // docPublishImpact's branches, not a claim of byte-parity with the real
  // gov.doc_m2_significant_columns() registry (doc_rw has no read grant on
  // that helper either, so it cannot be introspected from here).
  const SUBSTANTIVE_DIFF_COLS = ["title", "summary", "body", "attrs", "status"];
  const substantiveDiff = async (
    before: Record<string, unknown> | null,
    after: Record<string, unknown>
  ): Promise<string[]> => {
    const changed: string[] = [];
    for (const col of SUBSTANTIVE_DIFF_COLS) {
      const b = before ? before[col] : undefined;
      const a = after[col];
      if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) changed.push(col);
    }
    return changed;
  };

  // Mimics gov.doc_publish (SDES-SUB-003): appends to gov.doc_versions, bumps
  // documents.version, returns (publication_id, version_seq, published_at).
  // Throws SQLSTATE-tagged errors on the same conditions the real SECURITY
  // DEFINER function does (unique_violation on a duplicate (document, version)).
  const docPublish = async (
    documentId: string,
    newVersion: string,
    bumpClass: string,
    changelogEntryId: string,
    deltaSummary: string
  ): Promise<{ publication_id: string; version_seq: number; published_at: string }> => {
    store["gov.doc_versions"] ??= [];
    const existing = (store["gov.doc_versions"] as Row[]).filter((r) => r.document_id === documentId);
    if (existing.some((r) => r.version_label === newVersion)) {
      const e = new Error("unique_violation") as Error & { code?: string };
      e.code = "23505";
      throw e;
    }
    const doc = (store.documents as Row[]).find((r) => r.id === documentId);
    if (!doc) {
      const e = new Error("no_data_found") as Error & { code?: string };
      e.code = "P0002";
      throw e;
    }
    const id = uuid();
    const publishedAt = "2026-08-21T21:00:00.000Z";
    store["gov.doc_versions"].push({
      id,
      document_id: documentId,
      version_seq: existing.length + 1,
      version_label: newVersion,
      bump_class: bumpClass,
      changelog_item_id: changelogEntryId,
      delta_summary: deltaSummary,
      published_at: publishedAt,
    });
    doc.version = newVersion;
    return { publication_id: id, version_seq: existing.length + 1, published_at: publishedAt };
  };

  // Mimics gov.doc_subscription_repoint (UAT-GOV-029, dba migration
  // 20260828065000) — including its refusals, which are the whole point: each
  // one RAISEs with the E_REPOINT_* marker the tool dispatches on. A fake that
  // only modelled the happy path would prove nothing about docRepoint.
  const subscriptionRepoint = async (
    subscriptionId: string,
    seenVersionId: string,
    note?: string
  ): Promise<{ subscription_id: string; from_version: string; to_version: string; version_id: string; rows: number; open_staleness: number }> => {
    const raise = (marker: string, code: string, detail?: string): never => {
      const e = new Error(`${marker}: raised by fake gov.doc_subscription_repoint`) as Error & { code?: string; detail?: string };
      e.code = code;
      if (detail) e.detail = detail;
      throw e;
    };
    const sub = ((store["gov.doc_subscriptions"] as Row[]) ?? []).find((r) => r.id === subscriptionId);
    if (!sub) raise("E_REPOINT_NO_SUB", "P0002");
    if (sub!.status !== "active") raise("E_REPOINT_NOT_ACTIVE", "23514");
    const documentId =
      (sub!.target_document_id as string | null) ??
      ((store.doc_items as Row[]) ?? []).find((r) => r.id === sub!.target_item_id)?.document_id;
    if (!documentId) raise("E_REPOINT_NO_TARGET_DOC", "P0002");
    const versions = ((store["gov.doc_versions"] as Row[]) ?? [])
      .filter((r) => r.document_id === documentId)
      .sort((a, b) => Number(b.version_seq ?? 0) - Number(a.version_seq ?? 0));
    const cur = versions[0];
    if (!cur) raise("E_REPOINT_NO_VERSION", "P0002");
    if (seenVersionId !== cur!.id) {
      raise("E_REPOINT_STALE_READ", "40001", `dichiarata=${seenVersionId}, corrente=${cur!.id}`);
    }
    if (sub!.subscribed_at_version === cur!.version_label) raise("E_REPOINT_NOOP", "23514");
    const from = String(sub!.subscribed_at_version);
    sub!.subscribed_at_version = cur!.version_label;
    if (note) sub!.note = `${sub!.note ?? ""}\n[repointed ${from} -> ${cur!.version_label}: ${note}]`;
    const openStaleness = ((store["gov.doc_subscription_staleness"] as Row[]) ?? []).filter(
      (r) => r.subscription_id === subscriptionId && r.status !== "closed"
    ).length;
    return {
      subscription_id: subscriptionId,
      from_version: from,
      to_version: String(cur!.version_label),
      version_id: String(cur!.id),
      rows: 1,
      open_staleness: openStaleness,
    };
  };

  // Mimics real SAVEPOINT/ROLLBACK TO SAVEPOINT (docDb.ts, persistentTx mode):
  // rollback clears the aborted flag, restoring a live transaction for whatever
  // query runs next — same as against the real DB.
  const savepoint = async (_name: string): Promise<void> => {};
  const rollbackToSavepoint = async (_name: string): Promise<void> => { txState.aborted = false; };
  const releaseSavepoint = async (_name: string): Promise<void> => {};

  return {
    from: (table: string) => query(table),
    __docRw: true,
    resolveDocItem,
    relinkSuperseded,
    agentInProject,
    documentExists,
    publicationState,
    substantiveDiff,
    docPublish,
    subscriptionRepoint,
    savepoint,
    rollbackToSavepoint,
    releaseSavepoint,
  } as unknown as SupabaseClient;
}

// Simulates gov.relink_superseded raising an error (e.g. the SECURITY DEFINER
// function's own guards, or a transient failure) — docSupersede must fail loud
// (not ok:true) rather than leave the new version's links untransferred.
export function makeDbWithFailingRelink(store: Store, errorMessage: string): SupabaseClient {
  const real = makeDb(store) as any;
  return {
    from: (table: string) => real.from(table),
    __docRw: true,
    resolveDocItem: real.resolveDocItem,
    relinkSuperseded: async () => { throw new Error(errorMessage); },
  } as unknown as SupabaseClient;
}

export const ctx = { selfSlug: "board-mcp", isLoomy: false };
export const PROJ_A = "00000000-0000-4000-9000-0000000000aa";
export const PROJ_B = "00000000-0000-4000-9000-0000000000bb";

export function seedProjects(store: Store) {
  store.loomx_projects = [{ id: PROJ_A }, { id: PROJ_B }];
}

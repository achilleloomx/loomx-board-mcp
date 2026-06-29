// Document model handlers (D-a5 §7 / §16) — pure functions over a supabase-js
// shaped client, so tests can drive them with a fake DB. registerTools() wraps
// each into an MCP tool with self-describing descriptions.
//
// Tables (migration 20260627020000): documents, doc_items, doc_item_links,
// doc_item_gtd_links, doc_item_wi_links.
//
// Floor guarantees enforced here (tool-floor; DB-floor is the FK/CHECK/trigger):
//  - attrs validated against per-item_type JSON-Schema (docTypes.ts)
//  - doc_item_resolve is project-scoped and AUDIT-LOGGED on every call (§4.3)
//  - link tools are UUID-only; doc_link_by_code is the resolve+resolve+link sugar
//  - cross-app links surface an ACTIONABLE error (the DB composite FK rejects them)

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_ITEM_TYPE_REGISTRY,
  DOCUMENT_TYPE_REGISTRY,
  LINK_TYPE_REGISTRY,
  validateAttrs,
  itemTypeAllowedForDocumentType,
  allowedStatusesForItemType,
  checkCapabilityParity,
  type ItemType,
  type DocumentType,
} from "./docTypes.js";

const DOCUMENTS = "documents";
const DOC_ITEMS = "doc_items";
const DOC_ITEM_LINKS = "doc_item_links";
const DOC_ITEM_GTD_LINKS = "doc_item_gtd_links"; // D-070: FK doc_items + loomx_items, no relation_type
const DOC_ITEM_WI_LINKS = "doc_item_wi_links";   // D-070: FK doc_items + loomx_work_items, no relation_type

export type DocResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DocContext {
  selfSlug: string;
  isLoomy: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function err(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}

// Recognise the composite-FK violation that a cross-app link triggers, and turn
// the raw Postgres error into an actionable message (§16 "errori azionabili").
function translateLinkError(message: string): string {
  const msg = message || "";
  if (/doc_item_links_(from|to)_fk|foreign key|violates foreign key/i.test(msg)) {
    return (
      "Cross-app link rejected: both endpoints must belong to the SAME project " +
      "(DB composite FK (item, project_id)). You are trying to link doc_items from " +
      "different projects, which is structurally forbidden (D-a5 §4). Fix: link only " +
      "items within one project_id. Original: " + msg
    );
  }
  return msg;
}

// ---------------------------------------------------------------------------
// doc_create
// ---------------------------------------------------------------------------

export interface DocCreateArgs {
  project_id: string;
  document_type: string;
  title: string;
  owner?: string;
  status?: string;
  version?: string;
  visibility?: "project" | "team" | "org";
}

export async function docCreate(
  db: SupabaseClient,
  args: DocCreateArgs,
  ctx: DocContext
): Promise<DocResult<{ document_id: string; document_type: string; title: string }>> {
  const spec = DOCUMENT_TYPE_REGISTRY[args.document_type as DocumentType];
  if (!spec) {
    return err(
      `Unknown document_type '${args.document_type}'. Valid: ${Object.keys(DOCUMENT_TYPE_REGISTRY).join(", ")}. ` +
      `Call doc_item_types to see each type's item_types + attrs schema.`
    );
  }
  if (args.status && !spec.statuses.includes(args.status)) {
    return err(`Invalid status '${args.status}' for document_type '${args.document_type}'. Allowed: ${spec.statuses.join(", ")}.`);
  }
  if (args.visibility && !["project", "team", "org"].includes(args.visibility)) {
    return err(`Invalid visibility '${args.visibility}'. Allowed: project, team, org (default: project = conservative D-015).`);
  }

  const payload: Record<string, unknown> = {
    project_id: args.project_id,
    document_type: args.document_type,
    title: args.title,
    owner: args.owner ?? ctx.selfSlug,
    status: args.status ?? "draft",
  };
  if (args.version) payload.version = args.version;
  if (args.visibility) payload.visibility = args.visibility;

  const { data, error } = await db
    .from(DOCUMENTS)
    .insert(payload)
    .select("id, document_type, title")
    .maybeSingle();

  if (error || !data) {
    const m = error?.message ?? "no row returned";
    if (/foreign key|loomx_projects/i.test(m)) {
      return err(`project_id '${args.project_id}' does not exist in loomx_projects. Pin a real project id. Original: ${m}`);
    }
    return err(`Failed to create document: ${m}`);
  }

  const row = data as { id: string; document_type: string; title: string };
  return { ok: true, data: { document_id: row.id, document_type: row.document_type, title: row.title } };
}

// ---------------------------------------------------------------------------
// doc_item_upsert — idempotent. Returns the item UUID (§16).
//   key WITH code:    (project_id, code)
//   key WITHOUT code: (document_id, client_token) else (document_id, sort_order)
// ---------------------------------------------------------------------------

export interface DocItemUpsertArgs {
  document_id: string;
  project_id: string;
  item_type: string;
  code?: string;
  status?: string;
  owner?: string;
  sort_order?: number;
  body?: string;
  priority?: string;
  attrs?: Record<string, unknown>;
  client_token?: string;
}

export async function docItemUpsert(
  db: SupabaseClient,
  args: DocItemUpsertArgs,
  ctx: DocContext
): Promise<DocResult<{ item_id: string; code: string | null; created: boolean; status: string }>> {
  const spec = DOC_ITEM_TYPE_REGISTRY[args.item_type as ItemType];
  if (!spec) {
    return err(
      `Unknown item_type '${args.item_type}'. Valid: ${Object.keys(DOC_ITEM_TYPE_REGISTRY).join(", ")}. ` +
      `Call doc_item_types('${args.item_type}') for its schema + example.`
    );
  }

  // Validate item_type belongs to the document's document_type.
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, project_id, document_type")
    .eq("id", args.document_id)
    .maybeSingle();
  if (docErr) return err(`Failed to load document ${args.document_id}: ${docErr.message}`);
  if (!docRow) return err(`document_id '${args.document_id}' not found. Create it first with doc_create.`);

  const doc = docRow as { id: string; project_id: string; document_type: string };
  if (doc.project_id !== args.project_id) {
    return err(
      `project_id mismatch: document ${args.document_id} belongs to project ${doc.project_id}, ` +
      `not ${args.project_id}. doc_items inherit the document's project (anti-divergence FK).`
    );
  }
  if (!itemTypeAllowedForDocumentType(args.item_type, doc.document_type)) {
    return err(
      `item_type '${args.item_type}' is not allowed in a '${doc.document_type}' document. ` +
      `Allowed here: ${DOCUMENT_TYPE_REGISTRY[doc.document_type as DocumentType]?.item_types.join(", ")}.`
    );
  }

  // Status (tool-floor: per item_type) — default sensible.
  const status = args.status ?? spec.default_status;
  if (!spec.statuses.includes(status)) {
    return err(
      `Invalid status '${status}' for item_type '${args.item_type}'. Allowed: ${spec.statuses.join(", ")} (default: ${spec.default_status}).`
    );
  }

  // attrs validation against JSON-Schema (§3.2).
  const attrs = args.attrs ?? {};
  const attrErrors = validateAttrs(spec.attrs_schema, attrs);
  if (attrErrors.length > 0) {
    return err(
      `attrs invalid for item_type '${args.item_type}':\n  - ${attrErrors.join("\n  - ")}\n` +
      `Expected schema: ${JSON.stringify(spec.attrs_schema)}\nExample: ${JSON.stringify(spec.example.attrs ?? {})}`
    );
  }

  // ---- Resolve idempotency target ----
  type ExistingDocItem = { id: string; status: string; attrs: Record<string, unknown> | null };
  let existing: ExistingDocItem | null = null;

  if (args.code) {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select("id, status, attrs")
      .eq("project_id", args.project_id)
      .eq("code", args.code)
      .maybeSingle();
    if (error) return err(`Lookup by code failed: ${error.message}`);
    existing = (data as ExistingDocItem | null) ?? null;
  } else if (args.client_token) {
    // client_token persisted into attrs._client_token for idempotency w/o a column.
    // No portable JSONB-eq helper across supabase-js + pg shim → fetch the
    // document's items and match in JS.
    const { data: rows, error } = await db
      .from(DOC_ITEMS)
      .select("id, status, attrs")
      .eq("document_id", args.document_id);
    if (error) return err(`Lookup by client_token failed: ${error.message}`);
    const match = (Array.isArray(rows) ? rows : []).find(
      (r) => (r as any).attrs && (r as any).attrs._client_token === args.client_token
    );
    existing = (match as ExistingDocItem | undefined) ?? null;
  } else if (args.sort_order !== undefined) {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select("id, status, attrs")
      .eq("document_id", args.document_id)
      .eq("sort_order", args.sort_order)
      .maybeSingle();
    if (error) return err(`Lookup by sort_order failed: ${error.message}`);
    existing = (data as ExistingDocItem | null) ?? null;
  }

  // Persist client_token inside attrs for future idempotent matching.
  const storedAttrs: Record<string, unknown> = { ...attrs };
  if (args.client_token) storedAttrs._client_token = args.client_token;

  const now = nowIso();

  if (existing) {
    // UPDATE the existing row (idempotent). Superseded rows are immutable (DB trigger).
    if (existing.status === "superseded") {
      return err(`doc_item ${existing.id} is superseded (immutable). Use doc_supersede to create a new version instead of editing.`);
    }
    const update: Record<string, unknown> = { item_type: args.item_type, status, updated_at: now };
    if (args.body !== undefined) update.body = args.body;
    if (args.priority !== undefined) update.priority = args.priority;
    if (args.owner !== undefined) update.owner = args.owner;
    if (args.sort_order !== undefined) update.sort_order = args.sort_order;
    update.attrs = storedAttrs;

    const { data, error } = await db
      .from(DOC_ITEMS)
      .update(update)
      .eq("id", existing.id)
      .select("id, code, status")
      .maybeSingle();
    if (error || !data) return err(`Failed to update doc_item '${existing.id}': ${error?.message ?? "item not found after update"}`);
    const r = data as { id: string; code: string | null; status: string };
    return { ok: true, data: { item_id: r.id, code: r.code, created: false, status: r.status } };
  }

  // INSERT — resolve sort_order (append) when not provided.
  let sortOrder = args.sort_order;
  if (sortOrder === undefined) {
    const { data: maxRows } = await db
      .from(DOC_ITEMS)
      .select("sort_order")
      .eq("document_id", args.document_id)
      .order("sort_order", { ascending: false })
      .limit(1);
    const top = Array.isArray(maxRows) && maxRows.length > 0 ? (maxRows[0] as any).sort_order : -1;
    sortOrder = (typeof top === "number" ? top : -1) + 1;
  }

  const insert: Record<string, unknown> = {
    document_id: args.document_id,
    project_id: args.project_id,
    item_type: args.item_type,
    code: args.code ?? null,
    status,
    owner: args.owner ?? ctx.selfSlug,
    sort_order: sortOrder,
    body: args.body ?? null,
    priority: args.priority ?? null,
    attrs: storedAttrs,
  };

  const { data, error } = await db
    .from(DOC_ITEMS)
    .insert(insert)
    .select("id, code, status")
    .maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row returned";
    if (/uq_doc_items_project_code|duplicate key/i.test(m)) {
      return err(`code '${args.code}' already exists in project ${args.project_id} (race). Retry — upsert will update it.`);
    }
    return err(`Failed to insert doc_item: ${m}`);
  }
  const r = data as { id: string; code: string | null; status: string };
  return { ok: true, data: { item_id: r.id, code: r.code, created: true, status: r.status } };
}

// ---------------------------------------------------------------------------
// doc_item_resolve — project-scoped, RLS-aware under doc_rw role (F4.5). AUDIT-LOGGED.
// In production the caller is always a DocRwDb from runDocRw (docDb.ts); the RLS-aware
// DB function doc_item_resolve is used, never a direct table scan.
// REQ-GOV-016: if db is not a DocRwDb, the call throws — no service_role fallback.
// ---------------------------------------------------------------------------

function auditResolve(
  ctx: DocContext,
  project_id: string,
  code: string,
  uuid: string | null
): void {
  // Fallback audit for error paths only. On success, doc_rw resolveDocItem already
  // writes to doc_resolve_log in the DB (REQ-023). On error, the transaction is
  // rolled back so the DB log is lost — stderr captures it as best-effort.
  const entry = {
    tag: "doc_resolve_audit",
    at: nowIso(),
    agent: ctx.selfSlug,
    project_id,
    code,
    uuid,
    outcome: uuid ? "resolved" : "not_found",
  };
  try {
    process.stderr.write(`[doc_resolve_audit] ${JSON.stringify(entry)}\n`);
  } catch {
    /* never let audit logging break a resolve */
  }
}

export interface DocItemResolveArgs {
  project_id: string;
  code: string;
}

export async function docItemResolve(
  db: SupabaseClient,
  args: DocItemResolveArgs,
  ctx: DocContext
): Promise<DocResult<{ item_id: string; project_id: string; code: string; item_type: string; document_id: string }>> {
  // Under doc_rw (F4.5): resolve via the RLS-aware DB function. It re-checks
  // loomx_can_read_document (confidentiality D-015), audits to doc_resolve_log,
  // and raises the contract SQLSTATEs (42501 / P0002 / 22004).
  const docRwDb = db as unknown as {
    __docRw?: boolean;
    resolveDocItem?: (p: string, c: string) => Promise<string>;
  };
  if (docRwDb.__docRw && docRwDb.resolveDocItem) {
    try {
      const itemId = await docRwDb.resolveDocItem(args.project_id, args.code);
      // Best-effort enrichment (RLS-safe: the item is readable since resolve passed).
      const { data: enr } = await db
        .from(DOC_ITEMS)
        .select("item_type, document_id")
        .eq("id", itemId)
        .maybeSingle();
      const e = (enr as { item_type?: string; document_id?: string } | null) ?? null;
      // Success: resolveDocItem already wrote to doc_resolve_log in the DB (REQ-023).
      // No stderr needed here.
      return {
        ok: true,
        data: {
          item_id: itemId,
          project_id: args.project_id,
          code: args.code,
          item_type: e?.item_type ?? "",
          document_id: e?.document_id ?? "",
        },
      };
    } catch (ex) {
      const code = (ex as { code?: string }).code ?? "";
      const msg = ex instanceof Error ? ex.message : String(ex);
      auditResolve(ctx, args.project_id, args.code, null);
      if (/42501|insufficient_privilege/.test(code) || /42501|insufficient_privilege/.test(msg)) {
        return err(
          `code '${args.code}' in project ${args.project_id} is not readable by '${ctx.selfSlug}' ` +
          `(confidentiality D-015). The code may exist but you are not a member of that project.`
        );
      }
      if (/P0002|no_data_found/.test(code) || /no_data_found|not found/i.test(msg)) {
        return err(`code '${args.code}' does not exist in project ${args.project_id} (no fuzzy match).`);
      }
      if (/22004|null_value/.test(code) || /null_value/i.test(msg)) {
        return err(`doc_item_resolve requires both project_id and code.`);
      }
      return err(`Resolve failed: ${msg}`);
    }
  }

  // REQ-GOV-016: db is not a DocRwDb — refuse rather than falling back to a direct
  // table scan that could bypass RLS if a service_role client were passed.
  // In production all doc_* calls are routed through runDocRw (docDb.ts) which
  // always provides a DocRwDb. Test fakes must implement __docRw + resolveDocItem.
  throw new Error(
    "docItemResolve: db is not a DocRwDb — refusing to bypass RLS. " +
    "Route doc_* calls through runDocRw (D-a5 F4.5 / REQ-GOV-016). " +
    "If writing tests, add __docRw: true and resolveDocItem to the fake."
  );
}

// ---------------------------------------------------------------------------
// doc_link — UUID-only, target_kind routes to the right table (§16 amendment).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocLinkArgs {
  target_kind: "doc" | "gtd" | "wi";
  from_id: string;     // doc_item uuid (always a doc_item on the "from" side)
  to_id: string;       // doc_item uuid (kind=doc) | gtd uuid (kind=gtd) | wi uuid (kind=wi)
  relation_type?: string; // required for kind=doc; unused for gtd/wi (tables have no relation_type column)
}

export async function docLink(
  db: SupabaseClient,
  args: DocLinkArgs,
  _ctx: DocContext
): Promise<DocResult<{ link_id: string; target_kind: string; relation_type: string | null }>> {
  const route = LINK_TYPE_REGISTRY[args.target_kind];
  if (!route) {
    return err(`Invalid target_kind '${args.target_kind}'. Valid: doc | gtd | wi.`);
  }
  // Reject non-UUID with a guiding error (§16: link tools have NO code param).
  if (!UUID_RE.test(args.from_id)) {
    return err(`from_id must be a UUID, got '${args.from_id}'. This tool is UUID-only — resolve codes first with doc_item_resolve, or use doc_link_by_code.`);
  }
  if (!UUID_RE.test(args.to_id)) {
    return err(`to_id must be a UUID, got '${args.to_id}'. Resolve codes first with doc_item_resolve, or use doc_link_by_code.`);
  }

  // D-070: gtd/wi tables have no relation_type column — only doc↔doc links need it.
  if (args.target_kind === "gtd") {
    const { data, error } = await db
      .from(DOC_ITEM_GTD_LINKS)
      .insert({ doc_item_id: args.from_id, gtd_item_id: args.to_id })
      .select("id")
      .maybeSingle();
    if (error || !data) {
      const m = error?.message ?? "no row";
      if (/duplicate key|doc_item_gtd_links_unique/i.test(m)) return err(`This doc↔gtd link already exists.`);
      if (/foreign key/i.test(m)) return err(`doc_item or gtd item not found (UUID wrong?). Original: ${m}`);
      return err(`Failed to create doc↔gtd link: ${m}`);
    }
    return { ok: true, data: { link_id: (data as any).id, target_kind: "gtd", relation_type: null } };
  }

  if (args.target_kind === "wi") {
    const { data, error } = await db
      .from(DOC_ITEM_WI_LINKS)
      .insert({ doc_item_id: args.from_id, wi_id: args.to_id })
      .select("id")
      .maybeSingle();
    if (error || !data) {
      const m = error?.message ?? "no row";
      if (/duplicate key|doc_item_wi_links_unique/i.test(m)) return err(`This doc↔wi link already exists.`);
      if (/foreign key/i.test(m)) return err(`doc_item or wi not found (UUID wrong?). Original: ${m}`);
      return err(`Failed to create doc↔wi link: ${m}`);
    }
    return { ok: true, data: { link_id: (data as any).id, target_kind: "wi", relation_type: null } };
  }

  // target_kind === "doc": relation_type is required and must be in the allowed set.
  if (!args.relation_type) {
    return err(`relation_type is required for target_kind='doc'. Allowed: ${route.relation_types.join(", ")}.`);
  }
  if (!route.relation_types.includes(args.relation_type)) {
    return err(`relation_type '${args.relation_type}' invalid for 'doc'. Allowed: ${route.relation_types.join(", ")}.`);
  }

  // Derive the common project_id from the FROM endpoint.
  const { data: fromRow, error: fromErr } = await db
    .from(DOC_ITEMS)
    .select("id, project_id")
    .eq("id", args.from_id)
    .maybeSingle();
  if (fromErr) return err(`Failed to load from_id: ${fromErr.message}`);
  if (!fromRow) return err(`from_id '${args.from_id}' is not an existing doc_item.`);
  const projectId = (fromRow as { project_id: string }).project_id;

  const { data, error } = await db
    .from(DOC_ITEM_LINKS)
    .insert({ from_item: args.from_id, to_item: args.to_id, project_id: projectId, relation_type: args.relation_type })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row";
    if (/duplicate key|doc_item_links_unique/i.test(m)) return err(`This doc↔doc link already exists (${args.relation_type}).`);
    if (/no_self_link/i.test(m)) return err(`Cannot link an item to itself.`);
    return err(translateLinkError(m));
  }
  return { ok: true, data: { link_id: (data as any).id, target_kind: "doc", relation_type: args.relation_type } };
}

// ---------------------------------------------------------------------------
// doc_link_by_code — sugar: resolve(from) + resolve(to) + doc_link, project-scoped.
// ---------------------------------------------------------------------------

export interface DocLinkByCodeArgs {
  project_id: string;
  from_code: string;
  to_code: string;
  link_type: string;
}

export async function docLinkByCode(
  db: SupabaseClient,
  args: DocLinkByCodeArgs,
  ctx: DocContext
): Promise<DocResult<{ link_id: string; from: { code: string; uuid: string }; to: { code: string; uuid: string }; relation_type: string }>> {
  const from = await docItemResolve(db, { project_id: args.project_id, code: args.from_code }, ctx);
  if (!from.ok) return err(`from_code: ${from.error}`);
  const to = await docItemResolve(db, { project_id: args.project_id, code: args.to_code }, ctx);
  if (!to.ok) return err(`to_code: ${to.error}`);

  const linked = await docLink(
    db,
    { target_kind: "doc", from_id: from.data.item_id, to_id: to.data.item_id, relation_type: args.link_type },
    ctx
  );
  if (!linked.ok) return err(linked.error);

  return {
    ok: true,
    data: {
      link_id: linked.data.link_id,
      from: { code: args.from_code, uuid: from.data.item_id },
      to: { code: args.to_code, uuid: to.data.item_id },
      relation_type: args.link_type,
    },
  };
}

// ---------------------------------------------------------------------------
// doc_supersede — new row + edge relation_type='supersedes' (§6).
// ---------------------------------------------------------------------------

export interface DocSupersedeArgs {
  old_item_id: string;
  body?: string;
  attrs?: Record<string, unknown>;
  status?: string;
  code?: string;          // default: carry the old code (only if old row is detached from it first)
}

export async function docSupersede(
  db: SupabaseClient,
  args: DocSupersedeArgs,
  ctx: DocContext
): Promise<DocResult<{ new_item_id: string; old_item_id: string; link_id: string; code: string | null }>> {
  const { data: oldRow, error: oldErr } = await db
    .from(DOC_ITEMS)
    .select("id, document_id, project_id, item_type, code, status, owner, sort_order, body, priority, attrs")
    .eq("id", args.old_item_id)
    .maybeSingle();
  if (oldErr) return err(`Failed to load old item: ${oldErr.message}`);
  if (!oldRow) return err(`old_item_id '${args.old_item_id}' not found.`);

  const old = oldRow as {
    id: string; document_id: string; project_id: string; item_type: string;
    code: string | null; status: string; owner: string | null; sort_order: number;
    body: string | null; priority: string | null; attrs: Record<string, unknown> | null;
  };

  if (old.status === "superseded") {
    return err(`doc_item ${old.id} is already superseded. Supersede the current (non-superseded) version instead.`);
  }

  const spec = DOC_ITEM_TYPE_REGISTRY[old.item_type as ItemType];
  const newStatus = args.status ?? (spec ? spec.default_status : "draft");
  if (spec && !spec.statuses.includes(newStatus)) {
    return err(`Invalid status '${newStatus}' for item_type '${old.item_type}'. Allowed: ${spec.statuses.join(", ")}.`);
  }
  const newAttrs = args.attrs ?? old.attrs ?? {};
  if (spec) {
    const e = validateAttrs(spec.attrs_schema, newAttrs);
    if (e.length) return err(`attrs invalid for new version:\n  - ${e.join("\n  - ")}`);
  }

  // The code is UNIQUE per project. To preserve it on the new (live) row, detach
  // it from the old row first, then mark the old row superseded.
  const carryCode = args.code !== undefined ? args.code : old.code;
  if (carryCode && carryCode === old.code) {
    const { error: detachErr } = await db
      .from(DOC_ITEMS)
      .update({ code: null, updated_at: nowIso() })
      .eq("id", old.id);
    if (detachErr) return err(`Failed to detach code from old item: ${detachErr.message}`);
  }

  // Mark old row superseded (immutable after this — trigger blocks body/attrs edits).
  const { error: supErr } = await db
    .from(DOC_ITEMS)
    .update({ status: "superseded", updated_at: nowIso() })
    .eq("id", old.id);
  if (supErr) return err(`Failed to mark old item superseded: ${supErr.message}`);

  // Insert the new version.
  const { data: newRow, error: insErr } = await db
    .from(DOC_ITEMS)
    .insert({
      document_id: old.document_id,
      project_id: old.project_id,
      item_type: old.item_type,
      code: carryCode ?? null,
      status: newStatus,
      owner: args.attrs ? old.owner : (old.owner ?? ctx.selfSlug),
      sort_order: old.sort_order,
      body: args.body !== undefined ? args.body : old.body,
      priority: old.priority,
      attrs: newAttrs,
    })
    .select("id, code")
    .maybeSingle();
  if (insErr || !newRow) return err(`Failed to insert new version: ${insErr?.message ?? "no row"}`);
  const created = newRow as { id: string; code: string | null };

  // Transfer doc_item_links: update rows where from_item = old → new (forward direction).
  const { error: fwdErr } = await db
    .from(DOC_ITEM_LINKS)
    .update({ from_item: created.id })
    .eq("from_item", old.id);
  if (fwdErr) return err(`Failed to transfer forward doc_item_links to new version: ${fwdErr.message}`);

  // Transfer doc_item_links: update rows where to_item = old → new (reverse direction).
  const { error: bwdErr } = await db
    .from(DOC_ITEM_LINKS)
    .update({ to_item: created.id })
    .eq("to_item", old.id);
  if (bwdErr) return err(`Failed to transfer reverse doc_item_links to new version: ${bwdErr.message}`);

  // Transfer doc_item_gtd_links (D-070 new table).
  const { error: gtdLinkErr } = await db
    .from(DOC_ITEM_GTD_LINKS)
    .update({ doc_item_id: created.id })
    .eq("doc_item_id", old.id);
  if (gtdLinkErr) return err(`Failed to transfer doc_item_gtd_links to new version: ${gtdLinkErr.message}`);

  // Transfer doc_item_wi_links (D-070 new table).
  const { error: wiLinkErr } = await db
    .from(DOC_ITEM_WI_LINKS)
    .update({ doc_item_id: created.id })
    .eq("doc_item_id", old.id);
  if (wiLinkErr) return err(`Failed to transfer doc_item_wi_links to new version: ${wiLinkErr.message}`);

  // Edge: new --supersedes--> old (same project → FK satisfied).
  const { data: linkRow, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .insert({ from_item: created.id, to_item: old.id, project_id: old.project_id, relation_type: "supersedes" })
    .select("id")
    .maybeSingle();
  if (linkErr || !linkRow) return err(`New version created (${created.id}) but supersede edge failed: ${linkErr?.message ?? "no row"}`);

  return { ok: true, data: { new_item_id: created.id, old_item_id: old.id, link_id: (linkRow as any).id, code: created.code } };
}

// ---------------------------------------------------------------------------
// doc_query — filter items + traceability checks (e.g. REQ without SDES).
// ---------------------------------------------------------------------------

export interface DocQueryArgs {
  project_id: string;
  document_type?: string;
  item_type?: string;
  status?: string;
  code?: string;
  traceability?: "req_without_sdes" | "sdes_without_uat";
  limit?: number;
}

export async function docQuery(
  db: SupabaseClient,
  args: DocQueryArgs,
  _ctx: DocContext
): Promise<DocResult<{ mode: string; count: number; items: unknown[] }>> {
  if (args.traceability) {
    return docTraceability(db, args);
  }

  let q = db
    .from(DOC_ITEMS)
    .select("id, document_id, project_id, item_type, code, status, sort_order, priority, body, attrs, updated_at")
    .eq("project_id", args.project_id)
    .order("sort_order", { ascending: true })
    .limit(args.limit ?? 50);

  if (args.item_type) q = q.eq("item_type", args.item_type);
  if (args.status) q = q.eq("status", args.status);
  if (args.code) q = q.eq("code", args.code);

  // document_type filter → resolve matching document ids first.
  if (args.document_type) {
    const { data: docs, error: de } = await db
      .from(DOCUMENTS)
      .select("id")
      .eq("project_id", args.project_id)
      .eq("document_type", args.document_type);
    if (de) return err(`Failed to filter by document_type: ${de.message}`);
    const ids = (Array.isArray(docs) ? docs : []).map((d) => (d as any).id);
    if (ids.length === 0) return { ok: true, data: { mode: "items", count: 0, items: [] } };
    q = q.in("document_id", ids);
  }

  const { data, error } = await q;
  if (error) return err(`Query failed: ${error.message}`);
  const items = Array.isArray(data) ? data : [];
  return { ok: true, data: { mode: "items", count: items.length, items } };
}

// Traceability: items of a "source" type in the project with no link to a
// "target" type. Computed in JS (portable across supabase-js + pg shim).
async function docTraceability(
  db: SupabaseClient,
  args: DocQueryArgs
): Promise<DocResult<{ mode: string; count: number; items: unknown[] }>> {
  const map: Record<string, { source: ItemType; target: ItemType; label: string }> = {
    req_without_sdes: { source: "requirement", target: "sdes_entry", label: "REQ without a linked SDES" },
    sdes_without_uat: { source: "sdes_entry", target: "uat_case", label: "SDES without a linked UAT" },
  };
  const cfg = map[args.traceability!];
  if (!cfg) return err(`Unknown traceability check '${args.traceability}'. Valid: ${Object.keys(map).join(", ")}.`);

  // Source items in the project.
  const { data: srcRows, error: srcErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, body, status, attrs")
    .eq("project_id", args.project_id)
    .eq("item_type", cfg.source);
  if (srcErr) return err(`Traceability source query failed: ${srcErr.message}`);
  const sources = Array.isArray(srcRows) ? (srcRows as any[]) : [];
  if (sources.length === 0) return { ok: true, data: { mode: `traceability:${args.traceability}`, count: 0, items: [] } };

  // Target item ids in the project.
  const { data: tgtRows, error: tgtErr } = await db
    .from(DOC_ITEMS)
    .select("id")
    .eq("project_id", args.project_id)
    .eq("item_type", cfg.target);
  if (tgtErr) return err(`Traceability target query failed: ${tgtErr.message}`);
  const targetIds = new Set((Array.isArray(tgtRows) ? (tgtRows as any[]) : []).map((r) => r.id));

  // All doc_item_links in the project.
  const { data: linkRows, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .select("from_item, to_item, relation_type")
    .eq("project_id", args.project_id);
  if (linkErr) return err(`Traceability link query failed: ${linkErr.message}`);
  const links = Array.isArray(linkRows) ? (linkRows as any[]) : [];

  // A source is "covered" if any link connects it (either direction) to a target item.
  const covered = new Set<string>();
  for (const l of links) {
    if (targetIds.has(l.to_item)) covered.add(l.from_item);
    if (targetIds.has(l.from_item)) covered.add(l.to_item);
  }

  const gaps = sources
    .filter((s) => !covered.has(s.id))
    .map((s) => ({ id: s.id, code: s.code, status: s.status, gap: cfg.label, body_preview: typeof s.body === "string" ? s.body.slice(0, 120) : null }));

  return { ok: true, data: { mode: `traceability:${args.traceability}`, count: gaps.length, items: gaps } };
}

// ---------------------------------------------------------------------------
// doc_item_types — introspect the registry (§7 / §16 self-describing).
// ---------------------------------------------------------------------------

export interface DocItemTypesArgs {
  item_type?: string;
  document_type?: string;
}

export function docItemTypes(args: DocItemTypesArgs): DocResult<unknown> {
  if (args.item_type) {
    const spec = DOC_ITEM_TYPE_REGISTRY[args.item_type as ItemType];
    if (!spec) return err(`Unknown item_type '${args.item_type}'. Valid: ${Object.keys(DOC_ITEM_TYPE_REGISTRY).join(", ")}.`);
    return { ok: true, data: spec };
  }
  if (args.document_type) {
    const spec = DOCUMENT_TYPE_REGISTRY[args.document_type as DocumentType];
    if (!spec) return err(`Unknown document_type '${args.document_type}'. Valid: ${Object.keys(DOCUMENT_TYPE_REGISTRY).join(", ")}.`);
    const items = spec.item_types.map((it) => DOC_ITEM_TYPE_REGISTRY[it]);
    return { ok: true, data: { document_type: spec, item_types: items } };
  }
  // Full introspection.
  return {
    ok: true,
    data: {
      document_types: DOCUMENT_TYPE_REGISTRY,
      item_types: DOC_ITEM_TYPE_REGISTRY,
      link_types: LINK_TYPE_REGISTRY,
      capability_parity: checkCapabilityParity(),
    },
  };
}

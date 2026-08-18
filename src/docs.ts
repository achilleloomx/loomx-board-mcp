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
const DOC_ITEM_XPROJECT_LINKS = "doc_item_xproject_links"; // D-074: cross-project references, no project_id FK
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

// D-167: a 0-row SELECT against `documents`/`doc_items` under doc_rw is ambiguous
// by construction — RLS filters out both "doesn't exist" and "exists but you can't
// see it" the same silent way, and the naive message ("not found, create it") used
// to push callers toward the second case as if it were the first, minting duplicates
// (dba hit this 2026-08-17, msg c692035a). loomx_agent_in_project is SECURITY DEFINER
// and already GRANTed to doc_rw (D-a5 F4.5 migration), so it can answer "does the
// caller have ANY standing on this project" without a new DB object: if not, the
// 0 rows could be either case and creating is unsafe; if yes, the caller's view of
// the project is authoritative and 0 rows really does mean "not found".
interface DocRwProbes {
  agentInProject?: (p: string) => Promise<boolean>;
  documentExists?: (id: string) => Promise<boolean>;
}

// Each probe is checked independently at its call site (not both required
// together) — a handle that only wires one of the two DB functions still serves
// the caller that needs the other.
function docRwHandle(db: SupabaseClient): DocRwProbes | null {
  const h = db as unknown as { __docRw?: boolean } & DocRwProbes;
  return h.__docRw ? { agentInProject: h.agentInProject, documentExists: h.documentExists } : null;
}

// D-167 extended (GTD dc4e943e): membership on the project the CALLER NAMED says
// nothing about a document living in a project they did not name, so "you can see
// project X" was never grounds for "…therefore this document is new".
//
// Measured 2026-08-18 against production RLS (`documents_select` USING
// loomx_document_visibility_predicate(project_id, visibility)), as board-mcp under
// doc_rw: visibility='org' rows are readable from every project (all 6 projects
// board-mcp has no membership on), while visibility='project'/'team' rows of those
// same projects evaluate false and are filtered out silently. So 0 rows means:
//   (a) the document does not exist                        → doc_create is safe
//   (b) it exists elsewhere, org-visible                   → detectable (probe below)
//   (c) it exists elsewhere, project/team-visible          → INDISTINGUISHABLE from (a)
//
// (b) needs no probe here: docItemUpsert's own lookup is already by id alone, in
// this same transaction and role, so anything a probe could see it has seen — the
// mismatch branch fires and documentNotFoundError is never reached. Adding the
// "non-scoped probe" the GTD proposed would be the identical query run twice and a
// branch no callsite can reach. What was actually missing on that path was the
// instruction, not the detection (see projectMismatchError).
// (c) is the case that minted the CFG-090 duplicate: loomy created 794e873c in
// project 669fd07b at 06:40 on 2026-08-16 (doc_create defaults to
// visibility='project'), board-mcp — not a member — was told "not found, create it
// first" at 07:15 and created its own document at 07:18; the row only became
// org-visible later that day. Nothing reachable from this tool can close (c)
// without a SECURITY DEFINER existence oracle (DBA-side DDL, D-005), so the member
// branch must stop asserting a safety it cannot verify.

// Shared diagnosis for "the document is real, the project_id isn't". The
// instruction matters as much as the diagnosis: learning that a document belongs to
// another project is exactly the moment an agent is tempted to create its own copy
// in the project it named (CFG-090, 2026-08-16).
function projectMismatchError(
  documentId: string,
  ownerProjectId: string,
  namedProjectId: string,
  title?: string
): string {
  return (
    `project_id mismatch (the document exists, the project_id doesn't match): document ${documentId} ` +
    `belongs to project ${ownerProjectId}${title ? ` ("${title}")` : ""}, not ${namedProjectId}. ` +
    `doc_items inherit the document's project (anti-divergence FK). Do NOT call doc_create — retry with ` +
    `project_id=${ownerProjectId}, or ask whoever gave you ${namedProjectId} which project they meant (D-167).`
  );
}

// D-167 point 4 (dba msg 25bb24d9, migration 20260818215000): the membership
// heuristic above (agentInProject on the NAMED project) could never close case (c)
// — a document living in a DIFFERENT project, invisible by RLS, looks identical to
// "doesn't exist" no matter what the caller's own standing is. doc_document_exists
// is a ground-truth oracle: SECURITY DEFINER, sees past RLS, returns ONLY
// true/false (by design — no project_id, no owner, so this function can neither
// leak them nor reconstruct them from elsewhere). It replaces the guess with a
// fact, so the two branches below are no longer probabilistic:
//   exists === false → genuinely not found, doc_create is the right answer
//   exists === true  → real document, hidden by RLS — do NOT create a duplicate
// The exists===true branch is deliberately the SAME text regardless of the
// caller's membership on the named project (dba's third, non-negotiable
// constraint): if the wording varied case by case, the wording itself would be an
// unaudited second oracle.
async function documentNotFoundError(
  db: SupabaseClient,
  documentId: string,
  projectId: string,
  selfSlug: string
): Promise<string> {
  const plain = `document_id '${documentId}' not found in project ${projectId}.`;
  const rw = docRwHandle(db);
  if (!rw || !rw.documentExists) return plain;

  try {
    const exists = await rw.documentExists(documentId);
    if (exists) {
      return (
        `document_id '${documentId}' exists but is not accessible with your current identity. ` +
        `Do NOT call doc_create — that would mint a duplicate. Request access from the project's ` +
        `owner, or ask an agent with visibility (e.g. loomy) to check it.`
      );
    }
    return plain;
  } catch {
    // Existence probe is a diagnostic aid, not load-bearing — on failure, don't
    // assert a certainty (found or not) the call didn't actually establish.
    return (
      `${plain} Its existence could not be confirmed (existence probe failed) — do not assume it's ` +
      `safe to call doc_create without checking with loomy or dba first.`
    );
  }
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
//
// UPDATE semantics = PATCH, declared (GTD 0cdffc2b, 2026-08-16). Until v0.16.2
// the update path wrote `attrs` and `status` UNCONDITIONALLY from defaulted
// values (`args.attrs ?? {}`, `args.status ?? spec.default_status`) while body /
// priority / owner / sort_order were patch-conditional. An upsert of "just the
// status" therefore wiped attrs to `{}` and answered ok:true — it cost
// REQ-GOV-037 its acceptance_criteria (2085 chars → 2) during a ~240-item
// ratification run, recovered only because doc_item_history keeps a pre-image.
// Same shape observed on UAT-GOV-104/213/215. Measured before designing (GTD
// point 1): every other write path in this server is already patch or merge
// (buildGtdUpdatePayload, wiCheckpoint, wiEnd, home_*) and doc_supersede already
// carries attrs over (`args.attrs ?? old.attrs`), so this was one tool's defect,
// not a layer convention — which is why the fix is here and not a layer rewrite.
//
// The rule now, for every optional field including attrs and status:
//   omitted  → PRESERVED (column not written at all)
//   supplied → written, and any destructive effect is REPORTED, never silent
// `attrs: {}` passed on purpose still clears — omission is the no-op, not `{}`
// (GTD point 3: an explicit way to empty must exist, or the problem just moves).
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

export interface DocItemUpsertResult {
  item_id: string;
  code: string | null;
  created: boolean;
  status: string;
  /** Columns this call actually wrote (update path). */
  fields_written?: string[];
  /** Optional columns omitted by the caller and therefore left untouched (update path). */
  fields_preserved?: string[];
  /** Destructive-but-requested effects, stated out loud. Never blocking. */
  warnings?: string[];
}

// Canonical JSON: object keys sorted recursively, array order preserved (it is
// meaningful — acceptance_criteria is a list). JSONB round-trips an object with
// its keys REORDERED, so a plain JSON.stringify compare reports a phantom
// mismatch on every attrs write; verified live against the doc_rw path.
function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// Cell-level comparison for the post-write read-back. Normalised so JSONB
// (attrs) and scalars go through the same path; null and undefined are the same
// absence as far as "did the write land" is concerned.
function sameCell(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return canonical(a) === canonical(b);
}

// D-132 applied to this tool: verify on the ROW, not on the response.
// Under doc_rw the write runs in no-RETURNING mode (F4.5 / v0.8.1), so an
// RLS-denied UPDATE affects 0 rows WITHOUT raising — the follow-up SELECT still
// hands back a row and the call would answer ok:true on a write that never
// happened. That is the D-133 class this tool exists to stop producing.
function diffAgainstRow(intended: Record<string, unknown>, row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [col, want] of Object.entries(intended)) {
    if (col === "updated_at") continue; // server clock / trigger may legitimately differ
    if (!(col in row)) continue;        // outside the read-back projection — nothing to compare
    if (!sameCell(want, row[col])) {
      const show = (v: unknown) => {
        const s = JSON.stringify(v ?? null) ?? "null";
        return s.length > 200 ? `${s.slice(0, 200)}… (${s.length} chars)` : s;
      };
      out.push(`${col}: wrote ${show(want)} but the row reads ${show(row[col])}`);
    }
  }
  return out;
}

export async function docItemUpsert(
  db: SupabaseClient,
  args: DocItemUpsertArgs,
  ctx: DocContext
): Promise<DocResult<DocItemUpsertResult>> {
  const spec = DOC_ITEM_TYPE_REGISTRY[args.item_type as ItemType];
  if (!spec) {
    return err(
      `Unknown item_type '${args.item_type}'. Valid: ${Object.keys(DOC_ITEM_TYPE_REGISTRY).join(", ")}. ` +
      `Call doc_item_types('${args.item_type}') for its schema + example.`
    );
  }

  // Validate item_type belongs to the document's document_type.
  // Not project-scoped, deliberately: a document that RLS lets us read but that
  // lives in another project must surface as a mismatch, never as "not found".
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, project_id, document_type, title")
    .eq("id", args.document_id)
    .maybeSingle();
  if (docErr) return err(`Failed to load document ${args.document_id}: ${docErr.message}`);
  if (!docRow) return err(await documentNotFoundError(db, args.document_id, args.project_id, ctx.selfSlug));

  const doc = docRow as { id: string; project_id: string; document_type: string; title?: string };
  if (doc.project_id !== args.project_id) {
    return err(projectMismatchError(args.document_id, doc.project_id, args.project_id, doc.title));
  }
  if (!itemTypeAllowedForDocumentType(args.item_type, doc.document_type)) {
    return err(
      `item_type '${args.item_type}' is not allowed in a '${doc.document_type}' document. ` +
      `Allowed here: ${DOCUMENT_TYPE_REGISTRY[doc.document_type as DocumentType]?.item_types.join(", ")}.`
    );
  }

  // Status (tool-floor: per item_type). Validated ONLY when supplied —
  // spec.default_status is an INSERT default, never an "unset" value to write
  // back over an existing row (that is how a plain body edit used to reset a
  // committed requirement to draft).
  if (args.status !== undefined && !spec.statuses.includes(args.status)) {
    return err(
      `Invalid status '${args.status}' for item_type '${args.item_type}'. Allowed: ${spec.statuses.join(", ")} (default on insert: ${spec.default_status}).`
    );
  }

  // attrs validation against JSON-Schema (§3.2) — only what the caller is
  // actually writing. Omitted attrs are preserved, so there is nothing to
  // validate (and validating the stored value would turn a stale row into a
  // hard failure on an unrelated field edit).
  if (args.attrs !== undefined) {
    const attrErrors = validateAttrs(spec.attrs_schema, args.attrs);
    if (attrErrors.length > 0) {
      return err(
        `attrs invalid for item_type '${args.item_type}':\n  - ${attrErrors.join("\n  - ")}\n` +
        `Expected schema: ${JSON.stringify(spec.attrs_schema)}\nExample: ${JSON.stringify(spec.example.attrs ?? {})}`
      );
    }
  }

  // ---- Resolve idempotency target ----
  type ExistingDocItem = { id: string; status: string; item_type: string; attrs: Record<string, unknown> | null };
  const EXISTING_COLS = "id, status, item_type, attrs";
  let existing: ExistingDocItem | null = null;

  if (args.code) {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select(EXISTING_COLS)
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
      .select(EXISTING_COLS)
      .eq("document_id", args.document_id);
    if (error) return err(`Lookup by client_token failed: ${error.message}`);
    const match = (Array.isArray(rows) ? rows : []).find(
      (r) => (r as any).attrs && (r as any).attrs._client_token === args.client_token
    );
    existing = (match as ExistingDocItem | undefined) ?? null;
  } else if (args.sort_order !== undefined) {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select(EXISTING_COLS)
      .eq("document_id", args.document_id)
      .eq("sort_order", args.sort_order)
      .maybeSingle();
    if (error) return err(`Lookup by sort_order failed: ${error.message}`);
    existing = (data as ExistingDocItem | null) ?? null;
  }

  const now = nowIso();

  if (existing) {
    // UPDATE the existing row (idempotent). Superseded rows are immutable (DB trigger).
    if (existing.status === "superseded") {
      return err(`doc_item ${existing.id} is superseded (immutable). Use doc_supersede to create a new version instead of editing.`);
    }

    const written: string[] = [];
    const preserved: string[] = [];
    const warnings: string[] = [];
    const update: Record<string, unknown> = { updated_at: now };

    // item_type is a required arg, so it is always written. Retyping a row in
    // place is legal but must not be silent — an item whose type changed is
    // validated against a different attrs schema from here on.
    update.item_type = args.item_type;
    written.push("item_type");
    if (existing.item_type && existing.item_type !== args.item_type) {
      warnings.push(
        `item_type changed in place on ${existing.id}: '${existing.item_type}' → '${args.item_type}'. ` +
        `attrs are now validated against the '${args.item_type}' schema. If you meant a new version, use doc_supersede.`
      );
    }

    if (args.status !== undefined) { update.status = args.status; written.push("status"); }
    else preserved.push("status");
    if (args.body !== undefined) { update.body = args.body; written.push("body"); }
    else preserved.push("body");
    if (args.priority !== undefined) { update.priority = args.priority; written.push("priority"); }
    else preserved.push("priority");
    if (args.owner !== undefined) { update.owner = args.owner; written.push("owner"); }
    else preserved.push("owner");
    if (args.sort_order !== undefined) { update.sort_order = args.sort_order; written.push("sort_order"); }
    else preserved.push("sort_order");

    const prevAttrs: Record<string, unknown> = existing.attrs ?? {};
    if (args.attrs !== undefined) {
      const next: Record<string, unknown> = { ...args.attrs };
      // Carry the idempotency token forward: dropping it would silently break
      // future (document_id, client_token) lookups and split one item in two.
      if (args.client_token) next._client_token = args.client_token;
      else if (prevAttrs._client_token !== undefined) next._client_token = prevAttrs._client_token;

      const dropped = Object.keys(prevAttrs).filter((k) => !(k in next));
      if (dropped.length > 0) {
        warnings.push(
          `attrs replaced on ${existing.id}: ${dropped.length} stored key(s) dropped (${dropped.join(", ")}). ` +
          `attrs is replaced wholesale, not merged — re-pass every key you want to keep, or omit attrs entirely to leave the stored value untouched.`
        );
      }
      update.attrs = next;
      written.push("attrs");
    } else if (args.client_token && prevAttrs._client_token !== args.client_token) {
      // Only touching attrs to stamp the token, never to replace the payload.
      update.attrs = { ...prevAttrs, _client_token: args.client_token };
      written.push("attrs._client_token");
    } else {
      preserved.push("attrs");
    }

    const { error } = await db
      .from(DOC_ITEMS)
      .update(update)
      .eq("id", existing.id)
      .select("id, code, status")
      .maybeSingle();
    if (error) return err(`Failed to update doc_item '${existing.id}': ${error.message}`);

    // Read the row back and compare (GTD point 4 / D-132). See diffAgainstRow.
    const { data: after, error: afterErr } = await db
      .from(DOC_ITEMS)
      .select("id, code, status, item_type, body, priority, owner, sort_order, attrs")
      .eq("id", existing.id)
      .maybeSingle();
    if (afterErr || !after) {
      return err(
        `doc_item '${existing.id}' was updated but could not be read back for verification: ` +
        `${afterErr?.message ?? "row not found"}. Treat the write as UNCONFIRMED and re-read the item.`
      );
    }
    const afterRow = after as Record<string, unknown>;
    const mismatches = diffAgainstRow(update, afterRow);
    if (mismatches.length > 0) {
      return err(
        `Write NOT applied to doc_item '${existing.id}' — the row does not match what was sent, and the DB raised no error ` +
        `(RLS denial under doc_rw affects 0 rows silently). Nothing was changed as requested:\n  - ${mismatches.join("\n  - ")}`
      );
    }

    return {
      ok: true,
      data: {
        item_id: existing.id,
        code: (afterRow.code as string | null) ?? null,
        created: false,
        status: afterRow.status as string,
        fields_written: written,
        fields_preserved: preserved,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
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

  // Insert-only default: an absent status means "start at the type default".
  const insertStatus = args.status ?? spec.default_status;

  // Persist client_token inside attrs for future idempotent matching.
  const storedAttrs: Record<string, unknown> = { ...(args.attrs ?? {}) };
  if (args.client_token) storedAttrs._client_token = args.client_token;

  const insert: Record<string, unknown> = {
    document_id: args.document_id,
    project_id: args.project_id,
    item_type: args.item_type,
    code: args.code ?? null,
    status: insertStatus,
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

  // Same read-back as the update path: under doc_rw the insert result is
  // synthesized client-side (no RETURNING), so `data` is not evidence of a row.
  const { data: afterIns, error: afterInsErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, status, item_type, body, priority, owner, sort_order, attrs")
    .eq("id", r.id)
    .maybeSingle();
  if (afterInsErr || !afterIns) {
    return err(
      `doc_item insert reported success but the row is not readable at id '${r.id}': ` +
      `${afterInsErr?.message ?? "row not found"}. Treat the write as UNCONFIRMED — nothing may have been persisted.`
    );
  }
  const insRow = afterIns as Record<string, unknown>;
  const insMismatches = diffAgainstRow(insert, insRow);
  if (insMismatches.length > 0) {
    return err(
      `doc_item '${r.id}' was inserted but does not match what was sent, and the DB raised no error:\n  - ${insMismatches.join("\n  - ")}`
    );
  }

  return {
    ok: true,
    data: {
      item_id: r.id,
      code: (insRow.code as string | null) ?? null,
      created: true,
      status: insRow.status as string,
    },
  };
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

  // D-074: 'references' is cross-project — routes to doc_item_xproject_links (no project_id column).
  // from_item and to_item can belong to different projects; UUIDs are globally unique.
  if (args.relation_type === "references") {
    const { data, error } = await db
      .from(DOC_ITEM_XPROJECT_LINKS)
      .insert({ from_item: args.from_id, to_item: args.to_id, relation_type: "references" })
      .select("id")
      .maybeSingle();
    if (error || !data) {
      const m = error?.message ?? "no row";
      if (/duplicate key|doc_item_xproject_links_unique/i.test(m)) return err(`This cross-project 'references' link already exists.`);
      if (/foreign key/i.test(m)) return err(`doc_item not found (UUID wrong?). Original: ${m}`);
      return err(`Failed to create cross-project reference link: ${m}`);
    }
    return { ok: true, data: { link_id: (data as any).id, target_kind: "doc", relation_type: "references" } };
  }

  // Derive the common project_id from the FROM endpoint (intra-project types only).
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
): Promise<DocResult<{ new_item_id: string; old_item_id: string; link_id: string; code: string | null; relinked_rows: number }>> {
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

  // Repoint every link direction (doc_item_links from/to, doc_item_gtd_links,
  // doc_item_wi_links, doc_item_xproject_links from/to) atomically via
  // gov.relink_superseded (D-133, dba msg 2b4acbcc, migration 20260816100000).
  // SECURITY DEFINER — bypasses the RLS gap where doc_rw has no UPDATE policy on
  // these tables (a direct .update() used to silently affect 0 rows, no error).
  // MUST run after old is marked superseded and new is inserted: the function
  // REJECTS (23514) unless old.status='superseded' — the "occasion" constraint
  // (a repoint outside a supersede has no meaning, loomy-decided).
  const relinkDb = db as unknown as {
    __docRw?: boolean;
    relinkSuperseded?: (oldItemId: string, newItemId: string) => Promise<number>;
  };
  if (!relinkDb.__docRw || !relinkDb.relinkSuperseded) {
    return err(
      `New version created (${created.id}) but link transfer could not run: db is not a DocRwDb. ` +
      `gov.relink_superseded lives in the gov schema and is only reachable via the doc_rw direct-pg ` +
      `path (runDocRw) — route doc_supersede through it. Test fakes must implement relinkSuperseded.`
    );
  }
  let relinkedRows: number;
  try {
    relinkedRows = await relinkDb.relinkSuperseded(old.id, created.id);
  } catch (ex) {
    const msg = ex instanceof Error ? ex.message : String(ex);
    return err(`New version created (${created.id}) but link transfer (gov.relink_superseded) failed: ${msg}`);
  }

  // Edge: new --supersedes--> old (same project → FK satisfied).
  const { data: linkRow, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .insert({ from_item: created.id, to_item: old.id, project_id: old.project_id, relation_type: "supersedes" })
    .select("id")
    .maybeSingle();
  if (linkErr || !linkRow) return err(`New version created (${created.id}) but supersede edge failed: ${linkErr?.message ?? "no row"}`);

  return { ok: true, data: { new_item_id: created.id, old_item_id: old.id, link_id: (linkRow as any).id, code: created.code, relinked_rows: relinkedRows } };
}

// ---------------------------------------------------------------------------
// doc_query — filter items + traceability checks (e.g. REQ without SDES).
// ---------------------------------------------------------------------------

// Columns a caller may project via `fields`. `id` is always included so every
// row stays referenceable for a follow-up doc_item_resolve / doc_link.
const QUERYABLE_FIELDS = [
  "id", "document_id", "project_id", "item_type", "code", "status",
  "sort_order", "priority", "body", "attrs", "updated_at",
] as const;

export interface DocQueryArgs {
  project_id: string;
  document_type?: string;
  item_type?: string;
  status?: string;
  code?: string;
  traceability?: "req_without_sdes" | "sdes_without_uat";
  summary?: boolean;
  fields?: string;
  limit?: number;
}

export interface VisibilityGap {
  visibility_gap: true;
  note: string;
}

// D-167: the auditor gap-check on 669fd07b sat "green" for days because a 0-row
// result from a query the caller has no project standing on is indistinguishable
// from a genuinely empty corpus (GTD 63142305 — the incident this helper closes).
// Same probe as documentNotFoundError, applied to the query path: not a certainty,
// a signal — attach it only when rows really are 0, never as noise on populated
// results.
async function visibilityGap(
  db: SupabaseClient,
  projectId: string,
  selfSlug: string
): Promise<VisibilityGap | undefined> {
  const rw = docRwHandle(db);
  if (!rw || !rw.agentInProject) return undefined;
  try {
    const member = await rw.agentInProject(projectId);
    if (member) return undefined;
    return {
      visibility_gap: true,
      note:
        `0 rows — '${selfSlug}' has no membership/visibility on project ${projectId}, so this could be an ` +
        `RLS block rather than an empty corpus (D-167). Verify via org_lookup({project:"${projectId}"}) or ` +
        `request project membership from dba if you expect data here.`,
    };
  } catch {
    return undefined;
  }
}

export async function docQuery(
  db: SupabaseClient,
  args: DocQueryArgs,
  ctx: DocContext
): Promise<DocResult<{ mode: string; count: number; items: unknown[]; visibility_gap?: true; note?: string }>> {
  if (args.traceability) {
    return docTraceability(db, args, ctx);
  }

  // Decide which columns to pull. summary needs body (for headline + char
  // count) but never returns it. `fields` builds a lean projection that can
  // skip body entirely. Default keeps the historical full row.
  let parsedFields: string[] | null = null;
  if (args.fields && !args.summary) {
    const requested = args.fields.split(",").map((f) => f.trim()).filter(Boolean);
    const invalid = requested.filter((f) => !(QUERYABLE_FIELDS as readonly string[]).includes(f));
    if (invalid.length > 0) {
      return err(`Unknown field(s) in fields=: ${invalid.join(", ")}. Allowed: ${QUERYABLE_FIELDS.join(", ")}.`);
    }
    parsedFields = Array.from(new Set(["id", ...requested]));
  }

  const selectCols = args.summary
    ? "id, document_id, item_type, code, status, body"
    : parsedFields
      ? parsedFields.join(", ")
      : "id, document_id, project_id, item_type, code, status, sort_order, priority, body, attrs, updated_at";

  let q = db
    .from(DOC_ITEMS)
    .select(selectCols)
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
    if (ids.length === 0) {
      const gap = await visibilityGap(db, args.project_id, ctx.selfSlug);
      return { ok: true, data: { mode: args.summary ? "summary" : "items", count: 0, items: [], ...gap } };
    }
    q = q.in("document_id", ids);
  }

  const { data, error } = await q;
  if (error) return err(`Query failed: ${error.message}`);
  const rows = Array.isArray(data) ? (data as any[]) : [];
  const gap = rows.length === 0 ? await visibilityGap(db, args.project_id, ctx.selfSlug) : undefined;

  if (args.summary) {
    const summarized = await docSummarize(db, args.project_id, rows);
    return { ok: true, data: { mode: "summary", count: summarized.length, items: summarized, ...gap } };
  }

  return { ok: true, data: { mode: "items", count: rows.length, items: rows, ...gap } };
}

// summary mode — compact, token-lean rows for review-at-scale. Returns code,
// status, body size + headline, and link counts (doc↔doc out/in, gtd, wi) so a
// reviewer can count orphans / coverage / quality WITHOUT dumping any body.
async function docSummarize(
  db: SupabaseClient,
  projectId: string,
  rows: any[]
): Promise<unknown[]> {
  const ids = rows.map((r) => r.id);
  const docOut = new Map<string, number>();
  const docIn = new Map<string, number>();
  const gtdCnt = new Map<string, number>();
  const wiCnt = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  if (ids.length > 0) {
    // doc↔doc links are project-scoped (project_id column present, D-a5).
    const { data: dl } = await db
      .from(DOC_ITEM_LINKS)
      .select("from_item, to_item")
      .eq("project_id", projectId);
    for (const l of (Array.isArray(dl) ? (dl as any[]) : [])) {
      bump(docOut, l.from_item);
      bump(docIn, l.to_item);
    }
    // gtd / wi links keyed by doc_item_id (D-070, no project_id column).
    const { data: gl } = await db
      .from(DOC_ITEM_GTD_LINKS)
      .select("doc_item_id")
      .in("doc_item_id", ids);
    for (const l of (Array.isArray(gl) ? (gl as any[]) : [])) bump(gtdCnt, l.doc_item_id);
    const { data: wl } = await db
      .from(DOC_ITEM_WI_LINKS)
      .select("doc_item_id")
      .in("doc_item_id", ids);
    for (const l of (Array.isArray(wl) ? (wl as any[]) : [])) bump(wiCnt, l.doc_item_id);
  }

  return rows.map((r) => {
    const body = typeof r.body === "string" ? r.body : "";
    return {
      id: r.id,
      code: r.code,
      item_type: r.item_type,
      status: r.status,
      body_chars: body.length,
      headline: body.replace(/\s+/g, " ").trim().slice(0, 120),
      links: {
        doc_out: docOut.get(r.id) ?? 0,
        doc_in: docIn.get(r.id) ?? 0,
        gtd: gtdCnt.get(r.id) ?? 0,
        wi: wiCnt.get(r.id) ?? 0,
      },
    };
  });
}

// Traceability: items of a "source" type in the project with no link to a
// "target" type. Computed in JS (portable across supabase-js + pg shim).
async function docTraceability(
  db: SupabaseClient,
  args: DocQueryArgs,
  ctx: DocContext
): Promise<DocResult<{ mode: string; count: number; items: unknown[]; visibility_gap?: true; note?: string }>> {
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
  if (sources.length === 0) {
    const gap = await visibilityGap(db, args.project_id, ctx.selfSlug);
    return { ok: true, data: { mode: `traceability:${args.traceability}`, count: 0, items: [], ...gap } };
  }

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

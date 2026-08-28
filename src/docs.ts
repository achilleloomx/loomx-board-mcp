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
import { paginate } from "./pagination.js";
import type { FactOnLinkInput, FactOnLinkOutcome } from "./factSync.js";

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
// doc_rename — the verb that was missing (PJ-5; dba msg 6583a8a8: "due agenti
// diversi me l'hanno chiesto a mano nella stessa settimana"). Renaming a
// document had no tool at all, so every rename was a hand-written UPDATE asked
// of the DBA — which is how a naming rule ends up unenforced: the corpus cannot
// obey a norm nobody has a verb for.
//
// Title ONLY. Not status, not visibility, not owner: each of those is a
// different act with a different legitimation, and bundling them into a
// "doc_update" that writes whatever it is handed is exactly the patch-semantics
// defect this codebase already paid for once (v0.16.3).
//
// The naming norm (PG-007, in the ratified project-governance manifesto D-209)
// says the separator is a hyphen with spaces, never a long dash — because a
// long dash breaks when a title is copied into a terminal, a filename or a path,
// producing two titles that look identical. Checked here as a WARNING, never a
// refusal: this server is not the owner of that norm, and a tool that enforces
// somebody else's rule as a hard floor decides for them (D-136 §5).
// ---------------------------------------------------------------------------

export interface DocRenameArgs {
  document_id: string;
  new_title: string;
}

export interface DocRenameResult {
  document_id: string;
  old_title: string;
  new_title: string;
  naming_warning?: string;
}

export async function docRename(
  db: SupabaseClient,
  args: DocRenameArgs,
  ctx: DocContext
): Promise<DocResult<DocRenameResult>> {
  const title = (args.new_title ?? "").trim();
  if (title === "") return err(`new_title is required and cannot be empty.`);
  if (title.length > 200) return err(`new_title is ${title.length} chars — too long for a document title.`);

  const { data: before, error: beforeErr } = await db
    .from(DOCUMENTS)
    .select("id, project_id, owner, title, document_type")
    .eq("id", args.document_id)
    .maybeSingle();
  if (beforeErr) return err(`Failed to load document: ${beforeErr.message}`);
  if (!before) {
    return err(`document_id '${args.document_id}' is not readable by '${ctx.selfSlug}' (not found, or hidden by RLS — D-167).`);
  }
  const doc = before as { id: string; project_id: string; owner: string | null; title: string; document_type: string };

  // Same legitimation as publishing: renaming a document changes how the whole
  // fleet refers to it, so it is the owner's act (or loomy's), not a member's.
  if (!ctx.isLoomy && doc.owner !== ctx.selfSlug) {
    return err(
      `Not legitimated to rename document '${doc.id}': you are not its owner ('${doc.owner ?? "none"}'), and only loomy ` +
      `can rename cross-agent. Ask its owner, or ask loomy.`
    );
  }

  // Captured BEFORE the update, by value. Same trap docSubscribe documents for
  // `existing.intent`: some DB clients hand back live row objects, so reading
  // `doc.title` after the write would report the NEW title as the old one — a
  // rename whose "before" is its "after" is a receipt that proves nothing.
  const oldTitle = String(doc.title);

  if (oldTitle === title) {
    return { ok: true, data: { document_id: doc.id, old_title: oldTitle, new_title: title } };
  }

  const { error: updErr } = await db.from(DOCUMENTS).update({ title }).eq("id", doc.id).select("id").maybeSingle();
  if (updErr) return err(`Failed to rename document: ${updErr.message}`);

  // D-132: an RLS denial under doc_rw affects 0 rows silently — a write that
  // "succeeded" is not a write that landed.
  const { data: after, error: afterErr } = await db.from(DOCUMENTS).select("id, title").eq("id", doc.id).maybeSingle();
  if (afterErr || !after) {
    return err(`Rename reported success but the document could not be re-read: ${afterErr?.message ?? "row not found"}. Treat as UNCONFIRMED.`);
  }
  if ((after as { title: string }).title !== title) {
    return err(
      `Write NOT applied to document '${doc.id}': title still reads '${(after as { title: string }).title}'. ` +
      `Treat as UNCONFIRMED (0 rows updated is what an RLS denial looks like here).`
    );
  }

  const result: DocRenameResult = { document_id: doc.id, old_title: oldTitle, new_title: title };
  if (/[—–]/.test(title)) {
    result.naming_warning =
      `The new title contains a long dash. PG-007 (ratified project-governance manifesto) prescribes a hyphen with ` +
      `spaces as the separator — a long dash breaks when the title is copied into a terminal, a filename or a path, ` +
      `and produces two titles that read as the same one. Not enforced here: this server does not own that norm.`;
  }
  return { ok: true, data: result };
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
  /**
   * Optional when `code` is given and the code already exists in the project:
   * the document is DEDUCED from the row (GTD 4a591cfe — the authoritative
   * identity of a coded row is (project_id, code); asking for the document too
   * is asking for information the system already holds, and a wrong answer
   * used to update a row on document A while the caller believed they were
   * writing to document B, silently). Required to CREATE a row.
   */
  document_id?: string;
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
  /** Short index title (DEC-01j / SDES-DOCM-022). Optional, patch semantics like every other field. */
  title?: string;
  /** One-two sentence index summary (DEC-01j / SDES-DOCM-022). Optional, patch semantics like every other field. */
  summary?: string;
}

export interface DocItemUpsertResult {
  item_id: string;
  code: string | null;
  created: boolean;
  status: string;
  /** The document the row actually lives on — deduced from code when they disagree. */
  document_id: string;
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

// DB CHECK constraints on doc_items (DBA schema) — measured via pg_constraint,
// GTD 6e82b3b6: an over-length title/summary used to surface as the raw
// "violates check constraint doc_items_title_len" from Postgres, which names
// neither the limit nor the length that was actually sent.
const DOC_ITEM_TITLE_MAX_LEN = 80;
const DOC_ITEM_SUMMARY_MAX_LEN = 280;

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

  // Tool-floor length checks, mirroring the DB constraints — validated before
  // any write so the caller learns WHICH field and HOW LONG, never the raw
  // CHECK-violation message. Never truncated silently (GTD 6e82b3b6: a
  // silently cut title is worse than a rejection).
  if (args.title !== undefined && args.title.length > DOC_ITEM_TITLE_MAX_LEN) {
    return err(`title is ${args.title.length} chars, max ${DOC_ITEM_TITLE_MAX_LEN} (DB constraint doc_items_title_len). Shorten it — titles are never truncated silently.`);
  }
  if (args.summary !== undefined && args.summary.length > DOC_ITEM_SUMMARY_MAX_LEN) {
    return err(`summary is ${args.summary.length} chars, max ${DOC_ITEM_SUMMARY_MAX_LEN} (DB constraint doc_items_summary_len). Shorten it — summaries are never truncated silently.`);
  }

  // ---- Resolve idempotency target: coded rows FIRST, before touching the
  // document. The authoritative identity of a coded row is (project_id, code)
  // — the DB enforces per-project uniqueness — so when the code already
  // exists the document is DEDUCED from the row instead of trusted from the
  // caller (GTD 4a591cfe). Until v0.17.x a wrong document_id on an existing
  // code updated the row on its REAL document while the caller believed they
  // were writing elsewhere, silently; and a missing-but-deducible document
  // forced every caller to re-supply information the system already holds.
  type ExistingDocItem = { id: string; status: string; item_type: string; attrs: Record<string, unknown> | null; document_id: string };
  const EXISTING_COLS = "id, status, item_type, attrs, document_id";
  let existing: ExistingDocItem | null = null;
  const preWarnings: string[] = [];

  if (args.code) {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select(EXISTING_COLS)
      .eq("project_id", args.project_id)
      .eq("code", args.code)
      .maybeSingle();
    if (error) return err(`Lookup by code failed: ${error.message}`);
    existing = (data as ExistingDocItem | null) ?? null;
  }

  let effectiveDocumentId: string;
  if (existing) {
    effectiveDocumentId = existing.document_id;
    if (args.document_id && args.document_id !== existing.document_id) {
      preWarnings.push(
        `document deduced from code: '${args.code}' lives on document ${existing.document_id}, not on the ` +
        `document_id you passed (${args.document_id}). The row was updated WHERE IT LIVES — no duplicate was ` +
        `created and the row was not moved. If you meant a different row, pick a different code.`
      );
    }
  } else {
    if (!args.document_id) {
      return err(
        args.code
          ? `code '${args.code}' does not exist in project ${args.project_id} yet — creating a new row requires ` +
            `document_id (deduction only works for existing codes). Pass the document_id from doc_create/doc_query, ` +
            `and double-check the code with doc_item_resolve if you expected it to exist.`
          : `document_id is required when no code is given (code-less rows are scoped by document).`
      );
    }
    effectiveDocumentId = args.document_id;
  }

  // Validate item_type belongs to the document's document_type.
  // Not project-scoped, deliberately: a document that RLS lets us read but that
  // lives in another project must surface as a mismatch, never as "not found".
  const { data: docRow, error: docErr } = await db
    .from(DOCUMENTS)
    .select("id, project_id, document_type, title")
    .eq("id", effectiveDocumentId)
    .maybeSingle();
  if (docErr) return err(`Failed to load document ${effectiveDocumentId}: ${docErr.message}`);
  if (!docRow) return err(await documentNotFoundError(db, effectiveDocumentId, args.project_id, ctx.selfSlug));

  const doc = docRow as { id: string; project_id: string; document_type: string; title?: string };
  if (doc.project_id !== args.project_id) {
    return err(projectMismatchError(effectiveDocumentId, doc.project_id, args.project_id, doc.title));
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

  // ---- Resolve idempotency target for CODE-LESS rows (coded rows were
  // resolved above, before the document load). Both keys are document-scoped.
  if (!args.code && args.client_token) {
    // client_token persisted into attrs._client_token for idempotency w/o a column.
    // No portable JSONB-eq helper across supabase-js + pg shim → fetch the
    // document's items and match in JS.
    const { data: rows, error } = await db
      .from(DOC_ITEMS)
      .select(EXISTING_COLS)
      .eq("document_id", effectiveDocumentId);
    if (error) return err(`Lookup by client_token failed: ${error.message}`);
    const match = (Array.isArray(rows) ? rows : []).find(
      (r) => (r as any).attrs && (r as any).attrs._client_token === args.client_token
    );
    existing = (match as ExistingDocItem | undefined) ?? null;
  } else if (!args.code && args.sort_order !== undefined) {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select(EXISTING_COLS)
      .eq("document_id", effectiveDocumentId)
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
    const warnings: string[] = [...preWarnings];
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
    if (args.title !== undefined) { update.title = args.title; written.push("title"); }
    else preserved.push("title");
    if (args.summary !== undefined) { update.summary = args.summary; written.push("summary"); }
    else preserved.push("summary");

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
      .select("id, code, status, item_type, body, priority, owner, sort_order, attrs, title, summary")
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
        document_id: effectiveDocumentId,
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
    document_id: effectiveDocumentId,
    project_id: args.project_id,
    item_type: args.item_type,
    code: args.code ?? null,
    status: insertStatus,
    owner: args.owner ?? ctx.selfSlug,
    sort_order: sortOrder,
    body: args.body ?? null,
    priority: args.priority ?? null,
    attrs: storedAttrs,
    title: args.title ?? null,
    summary: args.summary ?? null,
  };

  const { data, error } = await db
    .from(DOC_ITEMS)
    .insert(insert)
    .select("id, code, status")
    .maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row returned";
    // Index name uq_doc_items_project_code was dropped (DEL-C1, dba 2026-08-20);
    // 'duplicate key' is the live alternation for the per-project-code constraint.
    if (/duplicate key/i.test(m)) {
      return err(`code '${args.code}' already exists in project ${args.project_id} (race). Retry — upsert will update it.`);
    }
    return err(`Failed to insert doc_item: ${m}`);
  }
  const r = data as { id: string; code: string | null; status: string };

  // Same read-back as the update path: under doc_rw the insert result is
  // synthesized client-side (no RETURNING), so `data` is not evidence of a row.
  const { data: afterIns, error: afterInsErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, status, item_type, body, priority, owner, sort_order, attrs, title, summary")
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
      document_id: effectiveDocumentId,
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
// doc_item_chain — SDES-DOCM-020 (WI-G.2). Walk the `supersedes` edges FORWARD,
// from an old UUID to the version in force today.
//
// Why a tool and not a caller-side loop: D-170 makes references and item
// subscriptions UUID-bound, so a link created once stays pinned to the row that
// was current then. doc_item_resolve only helps when you hold a CODE (the code
// travels onto the new row, §6/D-a5) — a UUID reference has no code to resolve,
// and every consumer would otherwise re-implement this walk, each with its own
// idea of what to do at a fork.
//
// Edge direction (docSupersede, this file): new --supersedes--> old. Walking
// forward therefore means: find the link whose to_item is the current row, and
// step to its from_item.
//
// Three terminations, all explicit (never a silent "looks current to me"):
//  - fork    → ERROR listing the candidates. Same discipline as doc_item_resolve
//              (REQ-DOCM-007): a resolver that arbitrates produces wrong
//              references that look right.
//  - cycle   → ERROR. Must not happen; a resolver that loops is worse than one
//              that errs.
//  - unreadable next hop → STOP and say so. The visibility re-check of
//              REQ-DOCM-006 applies at EVERY hop, not just the first: the chain
//              must not become a side channel to reach what RLS hides.
// ---------------------------------------------------------------------------

// Hard ceiling on max_hops. A chain this long is a corpus pathology, not a
// legitimate history — refuse with a readable error rather than recurse on.
const CHAIN_MAX_HOPS_CEILING = 200;
const CHAIN_DEFAULT_MAX_HOPS = 32;

export interface DocItemChainArgs {
  item_id: string;
  max_hops?: number;
}

interface ChainHop {
  item_id: string;
  code: string | null;
  item_type: string;
  status: string;
  document_id: string;
  // Instant this row stopped being current (docSupersede stamps updated_at when
  // it flips the old row to superseded). Null on the row still in force.
  superseded_at: string | null;
}

type ChainTerminalReason = "already_current" | "reached_current" | "successor_not_readable";

export async function docItemChain(
  db: SupabaseClient,
  args: DocItemChainArgs,
  ctx: DocContext
): Promise<
  DocResult<{
    input_id: string;
    resolved_id: string;
    hops: number;
    chain: ChainHop[];
    terminal_reason: ChainTerminalReason;
    note?: string;
  }>
> {
  if (!UUID_RE.test(args.item_id)) {
    return err(
      `item_id must be a UUID, got '${args.item_id}'. This tool is UUID-only (D-170: references are UUID-bound). ` +
      `If you hold a code, resolve it first with doc_item_resolve — a code already travels onto the current version.`
    );
  }

  const maxHops = args.max_hops ?? CHAIN_DEFAULT_MAX_HOPS;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > CHAIN_MAX_HOPS_CEILING) {
    return err(`max_hops must be an integer between 1 and ${CHAIN_MAX_HOPS_CEILING} (got ${String(args.max_hops)}).`);
  }

  const loadRow = async (id: string) => {
    const { data, error } = await db
      .from(DOC_ITEMS)
      .select("id, code, item_type, status, document_id, project_id, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) return { row: null, error: error.message };
    return { row: (data as ChainRowRaw | null) ?? null, error: null as string | null };
  };

  const start = await loadRow(args.item_id);
  if (start.error) return err(`Failed to load item_id: ${start.error}`);
  if (!start.row) {
    // REQ-DOCM-012: under RLS a 0-row read is ambiguous by construction, and we
    // have no per-ITEM existence oracle (doc_document_exists answers for
    // documents only). Say what we cannot rule out instead of asserting either.
    return err(
      `doc_item '${args.item_id}' is not readable by '${ctx.selfSlug}'. It may not exist, or it may exist in a ` +
      `document you cannot read (D-015) — this tool cannot tell the two apart, so it asserts neither.`
    );
  }

  const projectId = start.row.project_id;
  const chain: ChainHop[] = [];
  const seen = new Set<string>([start.row.id]);
  let current: ChainRowRaw = start.row;
  let terminal: ChainTerminalReason = "already_current";
  let note: string | undefined;

  for (let hop = 0; ; hop++) {
    if (hop >= maxHops) {
      return err(
        `Supersede chain from '${args.item_id}' exceeds max_hops=${maxHops} (still not at the current version after ` +
        `${maxHops} hops). Raise max_hops (ceiling ${CHAIN_MAX_HOPS_CEILING}) if the history is genuinely this long.`
      );
    }

    // Forward step: who supersedes the current row? Project-scoped — doc↔doc
    // links carry project_id and the composite FK keeps a chain inside one project.
    const { data: succRows, error: succErr } = await db
      .from(DOC_ITEM_LINKS)
      .select("from_item")
      .eq("to_item", current.id)
      .eq("relation_type", "supersedes")
      .eq("project_id", projectId);
    if (succErr) return err(`Failed to walk supersede edges from '${current.id}': ${succErr.message}`);

    const successors = (Array.isArray(succRows) ? (succRows as { from_item: string }[]) : []).map((r) => r.from_item);
    const uniqueSuccessors = [...new Set(successors)];

    if (uniqueSuccessors.length === 0) {
      // Terminal. Note the honest limit: RLS could hide an edge as easily as an
      // item, so "no successor" is really "no successor visible to you".
      terminal = chain.length === 0 ? "already_current" : "reached_current";
      break;
    }

    if (uniqueSuccessors.length > 1) {
      return err(
        `Ambiguous supersede chain at '${current.id}'${current.code ? ` (${current.code})` : ""}: ` +
        `${uniqueSuccessors.length} rows claim to supersede it — ${uniqueSuccessors.join(", ")}. ` +
        `Not choosing one (REQ-DOCM-007: this model never arbitrates an ambiguity). ` +
        `Repair the corpus, then retry.`
      );
    }

    const nextId = uniqueSuccessors[0]!;
    if (seen.has(nextId)) {
      return err(
        `Cycle detected in the supersede chain: '${nextId}' was already visited ` +
        `(path: ${[...seen].join(" → ")} → ${nextId}). Refusing to loop — this is a corpus defect.`
      );
    }

    const next = await loadRow(nextId);
    if (next.error) return err(`Failed to load successor '${nextId}': ${next.error}`);
    if (!next.row) {
      // The edge is visible but the row behind it is not: stop here and DECLARE
      // it. Returning `current` as if it were in force would be a false answer
      // (REQ-DOCM-006 — the chain is not a channel to reach what RLS hides).
      chain.push(toChainHop(current, true));
      terminal = "successor_not_readable";
      note =
        `Stopped early: '${current.id}' is superseded by '${nextId}', which '${ctx.selfSlug}' cannot read (D-015). ` +
        `resolved_id is therefore NOT guaranteed to be the version in force — it is the furthest readable row.`;
      return {
        ok: true,
        data: {
          input_id: args.item_id,
          resolved_id: current.id,
          hops: chain.length,
          chain,
          terminal_reason: terminal,
          note,
        },
      };
    }

    chain.push(toChainHop(current, true));
    seen.add(nextId);
    current = next.row;
  }

  if (chain.length > 0) chain.push(toChainHop(current, false));

  return {
    ok: true,
    data: {
      input_id: args.item_id,
      resolved_id: current.id,
      hops: chain.length === 0 ? 0 : chain.length - 1,
      chain,
      terminal_reason: terminal,
      note:
        `No further supersede edge is VISIBLE to '${ctx.selfSlug}' from '${current.id}'. ` +
        `RLS can hide an edge as easily as an item, so this means "no visible successor", not "no successor".`,
    },
  };
}

interface ChainRowRaw {
  id: string;
  code: string | null;
  item_type: string;
  status: string;
  document_id: string;
  project_id: string;
  updated_at: string | null;
}

function toChainHop(row: ChainRowRaw, superseded: boolean): ChainHop {
  return {
    item_id: row.id,
    code: row.code ?? null,
    item_type: row.item_type,
    status: row.status,
    document_id: row.document_id,
    superseded_at: superseded ? row.updated_at ?? null : null,
  };
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
): Promise<DocResult<{ link_id: string; target_kind: string; relation_type: string | null; fact_subscription?: FactOnLinkOutcome }>> {
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

  // SDES-SUB-005 (D-155): routing is decided by the FACT of the two endpoints'
  // project_id, not by the relation_type label. 'references' is the one
  // exception — it always routes cross-project (D-074), even for two items
  // that happen to share a project, since doc_item_links' CHECK does not admit
  // it at all (measured: doc_item_links allows refines|satisfies|verifies|
  // relates_to|supersedes|amends; doc_item_xproject_links additionally allows
  // references — dba msg 41fa192b Q6).
  const { data: fromRow, error: fromErr } = await db
    .from(DOC_ITEMS)
    .select("id, project_id, code")
    .eq("id", args.from_id)
    .maybeSingle();
  if (fromErr) return err(`Failed to load from_id: ${fromErr.message}`);
  if (!fromRow) return err(`from_id '${args.from_id}' is not an existing doc_item.`);
  const fromProjectId = (fromRow as { project_id: string }).project_id;
  const fromCode = (fromRow as { code?: string | null }).code ?? null;

  let toProjectId: string | null = null;
  let toDocumentId: string | null = null;
  let toCode: string | null = null;
  if (args.relation_type !== "references") {
    const { data: toRow, error: toErr } = await db
      .from(DOC_ITEMS)
      .select("id, project_id, document_id, code")
      .eq("id", args.to_id)
      .maybeSingle();
    if (toErr) return err(`Failed to load to_id: ${toErr.message}`);
    if (!toRow) return err(`to_id '${args.to_id}' is not an existing doc_item.`);
    toProjectId = (toRow as { project_id: string }).project_id;
    toDocumentId = (toRow as { document_id?: string | null }).document_id ?? null;
    toCode = (toRow as { code?: string | null }).code ?? null;
  }

  const crossProject = args.relation_type === "references" || toProjectId !== fromProjectId;

  if (crossProject) {
    const { data, error } = await db
      .from(DOC_ITEM_XPROJECT_LINKS)
      .insert({ from_item: args.from_id, to_item: args.to_id, relation_type: args.relation_type })
      .select("id")
      .maybeSingle();
    if (error || !data) {
      const m = error?.message ?? "no row";
      if (/duplicate key|doc_item_xproject_links_unique/i.test(m)) return err(`This cross-project '${args.relation_type}' link already exists.`);
      if (/foreign key/i.test(m)) return err(`doc_item not found (UUID wrong?). Original: ${m}`);
      if (/check constraint|doc_item_xproject_links_relation_type/i.test(m)) return err(`relation_type '${args.relation_type}' is not allowed cross-project. Original: ${m}`);
      return err(`Failed to create cross-project link: ${m}`);
    }
    const xFact = await deriveFact(db, {
      from_id: args.from_id,
      from_project_id: fromProjectId,
      from_code: fromCode,
      to_id: args.to_id,
      to_project_id: toProjectId,
      to_document_id: toDocumentId,
      to_code: toCode,
      relation_type: args.relation_type,
      cross_project: true,
    });
    return {
      ok: true,
      data: { link_id: (data as any).id, target_kind: "doc", relation_type: args.relation_type, ...(xFact ? { fact_subscription: xFact } : {}) },
    };
  }

  const { data, error } = await db
    .from(DOC_ITEM_LINKS)
    .insert({ from_item: args.from_id, to_item: args.to_id, project_id: fromProjectId, relation_type: args.relation_type })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const m = error?.message ?? "no row";
    if (/duplicate key|doc_item_links_unique/i.test(m)) return err(`This doc↔doc link already exists (${args.relation_type}).`);
    if (/no_self_link/i.test(m)) return err(`Cannot link an item to itself.`);
    if (/check constraint|doc_item_links_relation_type/i.test(m)) return err(`relation_type '${args.relation_type}' is not allowed intra-project (it may be cross-project-only, e.g. 'references'). Original: ${m}`);
    return err(translateLinkError(m));
  }
  // D-225/4bis: on a project that has already opted into decay, a new
  // verifies/satisfies bond derives its own 'fact' subscription here and now.
  // Never blocking, never silent — see deriveFactOnLink for why both.
  const fact = await deriveFact(db, {
    from_id: args.from_id,
    from_project_id: fromProjectId,
    from_code: fromCode,
    to_id: args.to_id,
    to_project_id: toProjectId,
    to_document_id: toDocumentId,
    to_code: toCode,
    relation_type: args.relation_type,
    cross_project: false,
  });
  return {
    ok: true,
    data: { link_id: (data as any).id, target_kind: "doc", relation_type: args.relation_type, ...(fact ? { fact_subscription: fact } : {}) },
  };
}

// Dynamic import: factSync.ts → subscriptions.ts → staleness.ts all import types
// from here, and a static edge back would close a runtime cycle. Same pattern
// tools.ts uses for every doc surface.
async function deriveFact(db: SupabaseClient, link: FactOnLinkInput): Promise<FactOnLinkOutcome | null> {
  // The import itself is inside the guard, not just the call. Found live on
  // 2026-08-29: a running MCP process had this module from the NEW build and
  // factSync.js still from the OLD one (dist/ is shared and modules load
  // lazily, so rebuilding under a live window mixes versions rather than
  // leaving it wholly on the previous build — G4 is sharper than it reads).
  // The result was 'deriveFactOnLink is not a function' thrown OUTSIDE the
  // hook's own try/catch, which failed doc_link and rolled back the link —
  // exactly the thing this hook promises it can never do.
  try {
    const { deriveFactOnLink } = await import("./factSync.js");
    return await deriveFactOnLink(db, link);
  } catch (e) {
    return {
      created: false,
      project_opted_in: false,
      note:
        `the link was created; the automatic 'fact' derivation (D-225/4bis) could not be loaded or run: ` +
        `${e instanceof Error ? e.message : String(e)}. Reconcile with doc_fact_sync — it is idempotent.`,
    };
  }
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
): Promise<
  DocResult<{
    link_id: string;
    from: { code: string; uuid: string };
    to: { code: string; uuid: string };
    relation_type: string;
    fact_subscription?: FactOnLinkOutcome;
  }>
> {
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
      ...(linked.data.fact_subscription ? { fact_subscription: linked.data.fact_subscription } : {}),
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

  // Insert the new version FIRST (old row is untouched — still its original status).
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

  // Heir edge, new --supersedes--> old: needed TWICE, for two different DB-owned
  // mechanisms that conflict if the same row tries to satisfy both at once.
  //  (1) gov.doc_items_require_successor_on_terminal (migration 20260822091000) is
  //      a BEFORE UPDATE OF status trigger on doc_items that rejects the transition
  //      into a terminal status when the row has incoming references (e.g.
  //      "verifies") and no declared heir — it looks for this exact edge
  //      (relation_type='supersedes', to_item=old.id) at the moment of the
  //      transition. It must therefore exist BEFORE old is marked superseded.
  //  (2) gov.relink_superseded (migration 20260816100000) unconditionally repoints
  //      every doc_item_links row with to_item=old.id to new.id, no relation_type
  //      exclusion — so if the heir edge above is still around when relink runs,
  //      relink tries to rewrite it into a self-loop (from=new, to=new), which
  //      doc_item_links_no_self_link (CHECK from_item<>to_item) then rejects,
  //      aborting the whole transaction.
  // Resolution: insert a throwaway copy to satisfy (1), delete it right after the
  // status transition so relink in (2) never sees it, then insert the real,
  // permanent edge AFTER relink — same spot the original (pre-ISS-001) code used,
  // which is exactly why relink never used to touch it.
  const { data: placeholderLink, error: placeholderErr } = await db
    .from(DOC_ITEM_LINKS)
    .insert({ from_item: created.id, to_item: old.id, project_id: old.project_id, relation_type: "supersedes" })
    .select("id")
    .maybeSingle();
  if (placeholderErr || !placeholderLink) return err(`New version created (${created.id}) but supersede edge failed: ${placeholderErr?.message ?? "no row"}`);
  const placeholderId = (placeholderLink as any).id as string;

  // Mark old row superseded (immutable after this — trigger blocks body/attrs edits).
  // The placeholder heir edge above already exists, so
  // aa_doc_items_require_successor_on_terminal finds it and lets the transition through.
  const { error: supErr } = await db
    .from(DOC_ITEMS)
    .update({ status: "superseded", updated_at: nowIso() })
    .eq("id", old.id);
  if (supErr) return err(`New version created (${created.id}) and supersede edge (${placeholderId}) exist, but marking old item superseded failed: ${supErr.message}`);

  // Remove the placeholder now that its only job (satisfying the trigger above) is
  // done — it must be gone before relink runs, or relink corrupts it (see (2) above).
  const { error: placeholderDelErr } = await db.from(DOC_ITEM_LINKS).delete().eq("id", placeholderId);
  if (placeholderDelErr) {
    return err(
      `New version created (${created.id}) and old item marked superseded, but removing the placeholder ` +
      `supersede edge (${placeholderId}) before relink failed: ${placeholderDelErr.message}. Link transfer ` +
      `was NOT run to avoid corrupting it — retry not safe; needs manual repair.`
    );
  }

  // Repoint every OTHER link direction (doc_item_links from/to, doc_item_gtd_links,
  // doc_item_wi_links, doc_item_xproject_links from/to) atomically via
  // gov.relink_superseded (D-133, dba msg 2b4acbcc, migration 20260816100000).
  // SECURITY DEFINER — bypasses the RLS gap where doc_rw has no UPDATE policy on
  // these tables (a direct .update() used to silently affect 0 rows, no error).
  // MUST run after old is marked superseded: the function REJECTS (23514) unless
  // old.status='superseded' — the "occasion" constraint (a repoint outside a
  // supersede has no meaning, loomy-decided).
  const relinkDb = db as unknown as {
    __docRw?: boolean;
    relinkSuperseded?: (oldItemId: string, newItemId: string) => Promise<number>;
  };
  if (!relinkDb.__docRw || !relinkDb.relinkSuperseded) {
    return err(
      `New version created (${created.id}) and marked superseded but link transfer could not run: db is not a DocRwDb. ` +
      `gov.relink_superseded lives in the gov schema and is only reachable via the doc_rw direct-pg ` +
      `path (runDocRw) — route doc_supersede through it. Test fakes must implement relinkSuperseded.`
    );
  }
  let relinkedRows: number;
  try {
    relinkedRows = await relinkDb.relinkSuperseded(old.id, created.id);
  } catch (ex) {
    const msg = ex instanceof Error ? ex.message : String(ex);
    return err(`New version created (${created.id}) and marked superseded but link transfer (gov.relink_superseded) failed: ${msg}`);
  }

  // Insert the permanent heir edge now — after relink, so relink never sees (and
  // can't corrupt) it. This is the edge doc_item_chain walks (§6bis warning).
  const { data: linkRow, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .insert({ from_item: created.id, to_item: old.id, project_id: old.project_id, relation_type: "supersedes" })
    .select("id")
    .maybeSingle();
  if (linkErr || !linkRow) {
    return err(
      `New version created (${created.id}) and marked superseded, link transfer ran (${relinkedRows} rows), ` +
      `but re-creating the permanent supersede edge failed: ${linkErr?.message ?? "no row"}`
    );
  }

  return { ok: true, data: { new_item_id: created.id, old_item_id: old.id, link_id: (linkRow as any).id, code: created.code, relinked_rows: relinkedRows } };
}

// ---------------------------------------------------------------------------
// doc_query — filter items + traceability checks (e.g. REQ without SDES).
// ---------------------------------------------------------------------------

// Columns a caller may project via `fields`. `id` is always included so every
// row stays referenceable for a follow-up doc_item_resolve / doc_link.
const QUERYABLE_FIELDS = [
  "id", "document_id", "project_id", "item_type", "code", "status",
  "sort_order", "priority", "body", "attrs", "updated_at", "title", "summary",
] as const;

export interface DocQueryArgs {
  project_id: string;
  document_type?: string;
  item_type?: string;
  status?: string;
  code?: string;
  traceability?: "req_without_sdes" | "sdes_without_uat" | "req_without_origin" | "broken_refs";
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
//
// R3 fix (auditor msg d03ff4c8, verdetto-caso-zero v3, 2026-08-28):
// loomx_agent_in_project() tests MEMBERSHIP, not visibility. dba opened a read
// path deliberately separate from membership (loomx_document_visibility_predicate,
// SELECT-only by design — a membership grant would also hand out write). Once
// that diverged from membership, anchoring here on agentInProject() alone
// started producing false abstentions: 0 traceability rows + real visibility
// (2 rows readable via plain doc_query) still came back visibility_gap:true.
// Fix: probe with the SAME RLS-scoped connection first — if it can read ANY
// row in this project, the 0-count is a real "zero rows WITH visibility"
// answer (REQ-016: compliant), not "zero rows AND zero visibility" (the only
// case this note is for). Membership stays as the fallback signal for that
// remaining ambiguous case.
async function visibilityGap(
  db: SupabaseClient,
  projectId: string,
  selfSlug: string
): Promise<VisibilityGap | undefined> {
  const { data: probeRows, error: probeErr } = await db
    .from(DOC_ITEMS)
    .select("id")
    .eq("project_id", projectId)
    .limit(1);
  if (!probeErr && Array.isArray(probeRows) && probeRows.length > 0) return undefined;

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
): Promise<DocResult<{ mode: string; count: number; items: unknown[]; truncated?: true; documents?: Record<string, { title: string; document_type: string }>; visibility_gap?: true; note?: string }>> {
  if (args.traceability === "req_without_origin") {
    return docTraceabilityOrigin(db, args, ctx);
  }
  if (args.traceability === "broken_refs") {
    return docBrokenRefs(db, args, ctx);
  }
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
    ? "id, document_id, item_type, code, status, body, title, summary"
    : parsedFields
      ? parsedFields.join(", ")
      : "id, document_id, project_id, item_type, code, status, sort_order, priority, body, attrs, updated_at, title, summary";

  const effectiveLimit = args.limit ?? 50;
  let q = db
    .from(DOC_ITEMS)
    .select(selectCols)
    .eq("project_id", args.project_id)
    .order("sort_order", { ascending: true })
    .limit(effectiveLimit + 1);

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
  const rawRows = Array.isArray(data) ? (data as any[]) : [];
  // CV-8 (D-203, msg 2190b6ae): count is the page size, never a full-table
  // total — `truncated` is the honest signal that the cap actually cut rows.
  const { page: rows, truncated } = paginate(rawRows, effectiveLimit);
  const gap = rows.length === 0 ? await visibilityGap(db, args.project_id, ctx.selfSlug) : undefined;

  if (args.summary) {
    const summarized = await docSummarize(db, args.project_id, rows);
    // GTD 4a591cfe: a project can span several documents, and 27 rows with no
    // hint of that made the split invisible. Each summary row carries its
    // document_id; this legend maps them to titles without a second query.
    const documents = await documentLegend(db, rows);
    return { ok: true, data: { mode: "summary", count: summarized.length, items: summarized, ...(truncated ? { truncated } : {}), ...(documents ? { documents } : {}), ...gap } };
  }

  return { ok: true, data: { mode: "items", count: rows.length, items: rows, ...(truncated ? { truncated } : {}), ...gap } };
}

// GTD 4a591cfe: {document_id → title/type} for the documents the result rows
// actually span. Best-effort — a legend failure must never sink the query.
async function documentLegend(
  db: SupabaseClient,
  rows: any[]
): Promise<Record<string, { title: string; document_type: string }> | null> {
  const ids = Array.from(new Set(rows.map((r) => r.document_id).filter(Boolean)));
  if (ids.length === 0) return null;
  const { data, error } = await db
    .from(DOCUMENTS)
    .select("id, title, document_type")
    .in("id", ids);
  if (error || !Array.isArray(data)) return null;
  const out: Record<string, { title: string; document_type: string }> = {};
  for (const d of data as any[]) out[d.id] = { title: d.title, document_type: d.document_type };
  return Object.keys(out).length > 0 ? out : null;
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
    const curatedTitle = typeof r.title === "string" && r.title.trim().length > 0 ? r.title.trim() : null;
    const curatedSummary = typeof r.summary === "string" && r.summary.trim().length > 0 ? r.summary.trim() : null;
    // DEC-01j / SDES-DOCM-022: prefer the curated title/summary over the body-derived
    // headline, but never silently — an index that doesn't say whether it's curated
    // or derived induces misplaced trust. headline_source names which one it is.
    const curated = curatedTitle ?? curatedSummary;
    return {
      id: r.id,
      code: r.code,
      document_id: r.document_id,
      item_type: r.item_type,
      status: r.status,
      body_chars: body.length,
      headline: curated ?? body.replace(/\s+/g, " ").trim().slice(0, 120),
      headline_source: curatedTitle ? "title" : curatedSummary ? "summary" : "body",
      ...(curatedTitle ? { title: curatedTitle } : {}),
      ...(curatedSummary ? { summary: curatedSummary } : {}),
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
//
// GTD 1b793e87 (Ondata 0.2, D-206): a "satisfies"/"verifies" link between a
// source and target of these types is NOT necessarily same-project — routing
// (SDES-SUB-005, D-155) sends it to doc_item_xproject_links whenever the two
// endpoints live in different projects. The original version of this check
// only scanned doc_item_links (project-scoped by construction, `project_id`
// FK), so a source correctly linked to a cross-project target still showed as
// a gap. Fixed by scanning both tables; the two coverage paths are kept
// distinguishable in `coverage` (never merged into one opaque number) because
// they carry different meaning — same-project is the ordinary case, cross-
// project means the source subscribes to something owned elsewhere.
async function docTraceability(
  db: SupabaseClient,
  args: DocQueryArgs,
  ctx: DocContext
): Promise<DocResult<{
  mode: string;
  count: number;
  items: unknown[];
  abstained_items?: unknown[];
  coverage?: { total_sources: number; covered_same_project: number; covered_cross_project_only: number; covered_total: number; abstained: number };
  visibility_gap?: true;
  note?: string;
}>> {
  const map: Record<string, { source: ItemType; target: ItemType; label: string }> = {
    req_without_sdes: { source: "requirement", target: "sdes_entry", label: "REQ without a linked SDES" },
    sdes_without_uat: { source: "sdes_entry", target: "uat_case", label: "SDES without a linked UAT" },
  };
  const cfg = map[args.traceability!];
  if (!cfg) return err(`Unknown traceability check '${args.traceability}'. Valid: ${Object.keys(map).join(", ")}.`);

  // Source items in the project. Superseded rows are history, not gaps (msg
  // 040fe721): a superseded requirement/sdes_entry is retired, not "missing
  // coverage" — counting it as a gap is noise on every project that supersedes.
  const { data: srcRows, error: srcErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, body, status, attrs")
    .eq("project_id", args.project_id)
    .eq("item_type", cfg.source);
  if (srcErr) return err(`Traceability source query failed: ${srcErr.message}`);
  const sources = (Array.isArray(srcRows) ? (srcRows as any[]) : []).filter((s) => s.status !== "superseded");
  if (sources.length === 0) {
    const gap = await visibilityGap(db, args.project_id, ctx.selfSlug);
    return { ok: true, data: { mode: `traceability:${args.traceability}`, count: 0, items: [], ...gap } };
  }
  const sourceIds = new Set(sources.map((s) => s.id as string));

  // Type of EVERY doc_item in the project this identity can read (not just
  // cfg.target) — needed to tell "linked to something of a different type"
  // (genuinely not covering) apart from "linked to something invisible"
  // (msg loomy 31b5767e, finding auditor aa43f599: doc_item_links is scoped by
  // project_id only, not by the per-document visibility that gates a plain
  // doc_items SELECT — so a same-project link can point at a row this
  // identity cannot otherwise read at all, e.g. via doc_item_resolve).
  // Filtering the old cfg.target-only fetch by "is this id even IN targetIds"
  // could not distinguish the two cases and silently reported the second as
  // "not covered" — a gap that isn't real, exactly what REQ-DOCM-012/015
  // (vuoto ≠ negato) forbid presenting as a definitive count.
  const { data: typeRows, error: typeErr } = await db
    .from(DOC_ITEMS)
    .select("id, item_type")
    .eq("project_id", args.project_id);
  if (typeErr) return err(`Traceability item-type query failed: ${typeErr.message}`);
  const typeById = new Map<string, string>();
  for (const r of (Array.isArray(typeRows) ? (typeRows as any[]) : [])) typeById.set((r as any).id, (r as any).item_type);
  const targetIds = new Set(Array.from(typeById.entries()).filter(([, t]) => t === cfg.target).map(([id]) => id));

  // All doc_item_links in the project.
  const { data: linkRows, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .select("from_item, to_item, relation_type")
    .eq("project_id", args.project_id);
  if (linkErr) return err(`Traceability link query failed: ${linkErr.message}`);
  const links = Array.isArray(linkRows) ? (linkRows as any[]) : [];

  // A source is "covered" if any link connects it (either direction) to a target item.
  // If the other end of a source's link isn't in typeById at all, this identity
  // cannot read it — abstain, never count the source as an uncovered gap.
  const coveredSameProject = new Set<string>();
  const abstainedSources = new Set<string>();
  for (const l of links) {
    if (sourceIds.has(l.from_item)) {
      const otherType = typeById.get(l.to_item);
      if (otherType === cfg.target) coveredSameProject.add(l.from_item);
      else if (otherType === undefined) abstainedSources.add(l.from_item);
    }
    if (sourceIds.has(l.to_item)) {
      const otherType = typeById.get(l.from_item);
      if (otherType === cfg.target) coveredSameProject.add(l.to_item);
      else if (otherType === undefined) abstainedSources.add(l.to_item);
    }
  }

  // Cross-project coverage: doc_item_xproject_links has no project_id column
  // (D-074), so a target there can live in ANY project — fetch the item_type
  // of whatever is on the other end of each link that touches one of our
  // sources, rather than reusing the (same-project) targetIds set.
  const coveredCrossProject = new Set<string>();
  {
    const idList = Array.from(sourceIds);
    const [fromHits, toHits] = await Promise.all([
      db.from(DOC_ITEM_XPROJECT_LINKS).select("from_item, to_item").in("from_item", idList),
      db.from(DOC_ITEM_XPROJECT_LINKS).select("from_item, to_item").in("to_item", idList),
    ]);
    if (fromHits.error) return err(`Traceability cross-project link query failed: ${fromHits.error.message}`);
    if (toHits.error) return err(`Traceability cross-project link query failed: ${toHits.error.message}`);
    const xlinks = [...(fromHits.data ?? []), ...(toHits.data ?? [])] as { from_item: string; to_item: string }[];

    const otherIds = new Set<string>();
    for (const l of xlinks) {
      if (sourceIds.has(l.from_item) && !sourceIds.has(l.to_item)) otherIds.add(l.to_item);
      if (sourceIds.has(l.to_item) && !sourceIds.has(l.from_item)) otherIds.add(l.from_item);
    }
    if (otherIds.size > 0) {
      const { data: otherRows, error: oErr } = await db
        .from(DOC_ITEMS)
        .select("id, item_type")
        .in("id", Array.from(otherIds));
      if (oErr) return err(`Traceability cross-project target lookup failed: ${oErr.message}`);
      const targetTypeById = new Map<string, string>();
      for (const r of (Array.isArray(otherRows) ? (otherRows as any[]) : [])) targetTypeById.set((r as any).id, (r as any).item_type);
      for (const l of xlinks) {
        const srcId = sourceIds.has(l.from_item) ? l.from_item : (sourceIds.has(l.to_item) ? l.to_item : null);
        if (!srcId) continue;
        const otherId = srcId === l.from_item ? l.to_item : l.from_item;
        const otherType = targetTypeById.get(otherId);
        if (otherType === cfg.target) coveredCrossProject.add(srcId);
        // Link exists (readable, project-agnostic table) but the other end
        // didn't resolve — RLS-invisible from here. Same abstention discipline
        // as the same-project branch above and as docTraceabilityOrigin's
        // cross-project branch: never let an unreadable target read as "gap".
        else if (otherType === undefined) abstainedSources.add(srcId);
      }
    }
  }

  const coveredTotal = new Set([...coveredSameProject, ...coveredCrossProject]);
  const gaps = sources
    .filter((s) => !coveredTotal.has(s.id) && !abstainedSources.has(s.id))
    .map((s) => ({ id: s.id, code: s.code, status: s.status, gap: cfg.label, body_preview: typeof s.body === "string" ? s.body.slice(0, 120) : null }));
  const abstainedItems = sources
    .filter((s) => !coveredTotal.has(s.id) && abstainedSources.has(s.id))
    .map((s) => ({ id: s.id, code: s.code, status: s.status, reason: "a linked item exists but is not readable by this identity — coverage cannot be confirmed" }));

  const coveredCrossProjectOnly = Array.from(coveredCrossProject).filter((id) => !coveredSameProject.has(id)).length;

  return {
    ok: true,
    data: {
      mode: `traceability:${args.traceability}`,
      count: gaps.length,
      items: gaps,
      ...(abstainedItems.length > 0 ? { abstained_items: abstainedItems } : {}),
      coverage: {
        total_sources: sources.length,
        covered_same_project: coveredSameProject.size,
        covered_cross_project_only: coveredCrossProjectOnly,
        abstained: abstainedItems.length,
        covered_total: coveredTotal.size,
      },
    },
  };
}

// D-206 third traceability axis: requirement → ORIGIN (upstream), distinct
// from req_without_sdes/sdes_without_uat which check the DOWNSTREAM chain
// (req→sdes→uat). Four admitted origins: a SoW element (objective/
// deliverable/stop_condition — "il capitolato"), a cross-project decision, a
// project-local decision, or a document the requirement draws on (modeled as
// any item_type outside the downstream chain and the other three buckets —
// section/prose/etc., the item types used for narrative documents).
const CAPITOLATO_ORIGIN_TYPES = new Set(["objective", "deliverable", "stop_condition"]);
const DOWNSTREAM_CHAIN_TYPES = new Set(["requirement", "sdes_entry", "uat_case", "test_step"]);
type OriginBucket = "capitolato" | "decision_cross" | "decision_project" | "inspiration_document";

function classifyOrigin(itemType: string, crossProject: boolean): OriginBucket | null {
  if (CAPITOLATO_ORIGIN_TYPES.has(itemType)) return "capitolato";
  if (itemType === "decision") return crossProject ? "decision_cross" : "decision_project";
  if (DOWNSTREAM_CHAIN_TYPES.has(itemType)) return null; // never an origin — D-206 "non estende l'obbligo agli altri tipi"
  return "inspiration_document"; // any remaining item_type — recepisce qualcosa scritto altrove
}

// GTD 28e9aa98 (msg loomy, D-206 follow-on): three shape requirements from the
// mandate, all enforced here:
//  1. Origin distinguished BY TYPE in the result (`coverage.covered_by`), same
//     spirit as the same-project/cross-project split already kept apart on the
//     other two checks — never fused into one opaque number.
//  2. "No origin" (`items`, true gaps) kept distinct from "not measurable"
//     (`abstained_items`): a cross-project link whose target item_type can't
//     be resolved (RLS-invisible, or otherwise unreadable from here) is an
//     ABSTENTION, not a zero — counting it as a gap would repeat the exact
//     blindness-dressed-as-absence mistake D-206 itself names (two cases
//     measured in the same 24h window it was written).
//  3. Its own mode (`req_without_origin`), never merged with req_without_sdes
//     / sdes_without_uat — three distinct axes for the dashboard.
async function docTraceabilityOrigin(
  db: SupabaseClient,
  args: DocQueryArgs,
  ctx: DocContext
): Promise<DocResult<{
  mode: string;
  count: number;
  items: unknown[];
  abstained_items?: unknown[];
  coverage?: {
    total_sources: number;
    covered_total: number;
    covered_by: { capitolato: number; decision_cross: number; decision_project: number; inspiration_document: number };
    abstained: number;
    gap: number;
  };
  visibility_gap?: true;
  note?: string;
}>> {
  // Superseded rows are history, not gaps — same fix as req_without_sdes/
  // sdes_without_uat (msg 040fe721), applied here for the same reason.
  const { data: srcRows, error: srcErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, body, status, attrs")
    .eq("project_id", args.project_id)
    .eq("item_type", "requirement");
  if (srcErr) return err(`Traceability source query failed: ${srcErr.message}`);
  const sources = (Array.isArray(srcRows) ? (srcRows as any[]) : []).filter((s) => s.status !== "superseded");
  if (sources.length === 0) {
    const gap = await visibilityGap(db, args.project_id, ctx.selfSlug);
    return { ok: true, data: { mode: "traceability:req_without_origin", count: 0, items: [], ...gap } };
  }
  const sourceIds = new Set(sources.map((s) => s.id as string));

  // Same-project links: doc_item_links carries a project_id FK enforced on
  // BOTH endpoints (see fakeDb.ts checkConstraints / migration 20260627020000),
  // so the other end of any such link is guaranteed to live in this project —
  // a single project-scoped type lookup covers every same-project origin.
  const { data: sameTypeRows, error: sameTypeErr } = await db
    .from(DOC_ITEMS)
    .select("id, item_type")
    .eq("project_id", args.project_id);
  if (sameTypeErr) return err(`Traceability item-type query failed: ${sameTypeErr.message}`);
  const sameProjectTypeById = new Map<string, string>();
  for (const r of (Array.isArray(sameTypeRows) ? (sameTypeRows as any[]) : [])) {
    sameProjectTypeById.set((r as any).id, (r as any).item_type);
  }

  const { data: linkRows, error: linkErr } = await db
    .from(DOC_ITEM_LINKS)
    .select("from_item, to_item")
    .eq("project_id", args.project_id);
  if (linkErr) return err(`Traceability link query failed: ${linkErr.message}`);
  const links = Array.isArray(linkRows) ? (linkRows as any[]) : [];

  const originsBySource = new Map<string, Set<OriginBucket>>();
  const abstainedBySource = new Set<string>();
  const addOrigin = (srcId: string, bucket: OriginBucket | null) => {
    if (!bucket) return;
    if (!originsBySource.has(srcId)) originsBySource.set(srcId, new Set());
    originsBySource.get(srcId)!.add(bucket);
  };

  for (const l of links) {
    if (!sourceIds.has(l.from_item) && !sourceIds.has(l.to_item)) continue;
    const srcId = sourceIds.has(l.from_item) ? l.from_item : l.to_item;
    const otherId = srcId === l.from_item ? l.to_item : l.from_item;
    const otherType = sameProjectTypeById.get(otherId);
    if (!otherType) {
      // NOT dangling — the FK guarantees the row exists. Missing from the map
      // means RLS hid it from this identity (msg loomy 31b5767e/aa43f599:
      // doc_item_links is project_id-scoped, not per-document-visibility-scoped,
      // so a same-project link can point at a row this identity cannot
      // otherwise read). Abstain, same discipline as the cross-project branch
      // below — silently skipping would read as "no origin here", which isn't
      // known to be true.
      abstainedBySource.add(srcId);
      continue;
    }
    addOrigin(srcId, classifyOrigin(otherType, false));
  }

  // Cross-project links: doc_item_xproject_links has no project_id column
  // (D-074), so the other end can live in ANY project and — unlike the
  // req_without_sdes/sdes_without_uat check, which only cares whether the
  // target matches ONE fixed item_type — every resolvable other-end type
  // must be classified individually here.
  {
    const idList = Array.from(sourceIds);
    const [fromHits, toHits] = await Promise.all([
      db.from(DOC_ITEM_XPROJECT_LINKS).select("from_item, to_item").in("from_item", idList),
      db.from(DOC_ITEM_XPROJECT_LINKS).select("from_item, to_item").in("to_item", idList),
    ]);
    if (fromHits.error) return err(`Traceability cross-project link query failed: ${fromHits.error.message}`);
    if (toHits.error) return err(`Traceability cross-project link query failed: ${toHits.error.message}`);
    const xlinks = [...(fromHits.data ?? []), ...(toHits.data ?? [])] as { from_item: string; to_item: string }[];

    const otherIds = new Set<string>();
    for (const l of xlinks) {
      if (sourceIds.has(l.from_item) && !sourceIds.has(l.to_item)) otherIds.add(l.to_item);
      if (sourceIds.has(l.to_item) && !sourceIds.has(l.from_item)) otherIds.add(l.from_item);
    }
    const targetTypeById = new Map<string, string>();
    if (otherIds.size > 0) {
      const { data: otherRows, error: oErr } = await db
        .from(DOC_ITEMS)
        .select("id, item_type")
        .in("id", Array.from(otherIds));
      if (oErr) return err(`Traceability cross-project target lookup failed: ${oErr.message}`);
      for (const r of (Array.isArray(otherRows) ? (otherRows as any[]) : [])) {
        targetTypeById.set((r as any).id, (r as any).item_type);
      }
    }

    for (const l of xlinks) {
      const srcId = sourceIds.has(l.from_item) ? l.from_item : (sourceIds.has(l.to_item) ? l.to_item : null);
      if (!srcId) continue;
      const otherId = srcId === l.from_item ? l.to_item : l.from_item;
      const otherType = targetTypeById.get(otherId);
      if (!otherType) {
        // Link exists but the other end didn't come back — RLS-invisible, or
        // otherwise unreadable from here. Abstain: never let this read as "no origin".
        abstainedBySource.add(srcId);
        continue;
      }
      addOrigin(srcId, classifyOrigin(otherType, true));
    }
  }

  const coveredBy = { capitolato: 0, decision_cross: 0, decision_project: 0, inspiration_document: 0 };
  const gaps: unknown[] = [];
  const abstainedItems: unknown[] = [];
  let coveredTotal = 0;

  for (const s of sources) {
    const origins = originsBySource.get(s.id);
    if (origins && origins.size > 0) {
      coveredTotal += 1;
      for (const b of origins) coveredBy[b] += 1;
      continue;
    }
    if (abstainedBySource.has(s.id)) {
      abstainedItems.push({ id: s.id, code: s.code, status: s.status });
      continue;
    }
    gaps.push({
      id: s.id,
      code: s.code,
      status: s.status,
      gap: "requirement without a D-206 origin — per D-206 this marks the SoW as incomplete, not the requirement as defective",
      body_preview: typeof s.body === "string" ? s.body.slice(0, 120) : null,
    });
  }

  return {
    ok: true,
    data: {
      mode: "traceability:req_without_origin",
      count: gaps.length,
      items: gaps,
      ...(abstainedItems.length > 0 ? { abstained_items: abstainedItems } : {}),
      coverage: {
        total_sources: sources.length,
        covered_total: coveredTotal,
        covered_by: coveredBy,
        abstained: abstainedItems.length,
        gap: gaps.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// broken_refs — link integrity, fourth traceability axis.
//
// Asked for by forge (msg 162add27) because UAT-PG-008 step 1 ("no broken
// references") was not measurable: a direct SELECT on doc_item_links /
// doc_item_xproject_links is permission-denied under an agent's own native
// role, and doc_query(summary:true) exposes doc_out/doc_in as COUNTS only —
// a broken link counts exactly like a healthy one, so the step read a false
// "0 broken". Second consumer: the auditor's condition 11 (msg loomy
// c473e347), same question from the other side. Runs under doc_rw like every
// other doc_* handler, so each agent measures with its OWN identity.
//
// WHAT THIS CHECK CAN AND CANNOT SAY — measured on production 2026-08-29,
// because the shape of the answer follows from the schema, not from taste:
//
//  1. A dangling pointer (link → row that does not exist) is IMPOSSIBLE by
//     construction. Both tables carry FK ... ON DELETE CASCADE on BOTH ends:
//     doc_item_links_from_fk / _to_fk are composite (from_item, project_id) →
//     doc_items(id, project_id); doc_item_xproject_links_from_item_fkey /
//     _to_item_fkey → doc_items(id). Deleting an item deletes its links. So
//     `dangling: 0` is reported as a STRUCTURAL fact with its basis named —
//     never as a measurement this check performed, because no RLS-scoped
//     SELECT could tell "deleted" from "hidden" anyway (both come back as an
//     absent row). Presenting that as a measured zero is precisely the
//     blindness-dressed-as-absence that D-206 / REQ-DOCM-012/015 forbid.
//
//  2. What a caller CAN'T see is real and asymmetric: the SELECT policy on
//     both link tables is anchored on the FROM end only
//     (loomx_can_read_document(from_item.document_id)), so an identity can
//     read a link and NOT its target. Measured as board-mcp: 11 of 1214
//     same-project links and 2 of 283 cross-project links have an unreadable
//     to_item. Those are abstentions, never gaps.
//
//  3. What IS a real, actionable defect in this corpus: a live link pointing
//     at a RETIRED row. Measured globally: 4 links → superseded targets (none
//     with a visible successor), 24 → deprecated, 2 → archived. That is the
//     honest reading of "broken reference" here — the pointer resolves, but
//     to something no longer in force.
//
// Unit of analysis is the LINK, not the item: "which references are broken"
// is a question about edges, and rolling it up per item would hide which edge
// is at fault.
// ---------------------------------------------------------------------------

// Statuses that mean "this row is no longer in force". Drawn from the statuses
// the DB CHECKs actually admit (docTypes.ts + measured distribution), not
// invented: 'superseded' already carries this meaning across the codebase
// (req_without_sdes skips superseded sources — msg 040fe721), and
// deprecated/archived/rejected are the other three terminal-retired values.
// draft/proposed/in_review are IMMATURE, not retired — a reference to a draft
// is work in progress, not a broken link, and counting it as one would flood
// every young project with false defects. The set is echoed in the response
// (`retired_statuses`) so the rule is inspectable and correctable without
// anyone having to guess what the tool decided.
const RETIRED_STATUSES = ["superseded", "deprecated", "archived", "rejected"] as const;
const RETIRED_STATUS_SET = new Set<string>(RETIRED_STATUSES);

interface LinkRow {
  id: string;
  from_item: string;
  to_item: string;
  relation_type: string;
  scope: "same_project" | "cross_project_out" | "cross_project_in";
}

interface ItemFacts {
  code: string | null;
  item_type: string;
  status: string;
  project_id?: string;
}

async function docBrokenRefs(
  db: SupabaseClient,
  args: DocQueryArgs,
  ctx: DocContext
): Promise<DocResult<{
  mode: string;
  count: number;
  items: unknown[];
  truncated?: true;
  abstained_items?: unknown[];
  coverage?: unknown;
  dangling?: unknown;
  retired_statuses?: readonly string[];
  notes?: string[];
  visibility_gap?: true;
  note?: string;
}>> {
  const { data: itemRows, error: itemErr } = await db
    .from(DOC_ITEMS)
    .select("id, code, item_type, status")
    .eq("project_id", args.project_id);
  if (itemErr) return err(`broken_refs item query failed: ${itemErr.message}`);
  const projectItems = new Map<string, ItemFacts>();
  for (const r of (Array.isArray(itemRows) ? (itemRows as any[]) : [])) {
    projectItems.set(r.id, { code: r.code ?? null, item_type: r.item_type, status: r.status });
  }
  if (projectItems.size === 0) {
    const gap = await visibilityGap(db, args.project_id, ctx.selfSlug);
    return { ok: true, data: { mode: "traceability:broken_refs", count: 0, items: [], ...gap } };
  }
  const projectItemIds = Array.from(projectItems.keys());

  // Same-project edges: the composite FK pins BOTH ends to this project, so
  // every to_item here is guaranteed to be a row of this project — absence
  // from projectItems means RLS hid it, never that it is missing.
  const { data: sameRows, error: sameErr } = await db
    .from(DOC_ITEM_LINKS)
    .select("id, from_item, to_item, relation_type")
    .eq("project_id", args.project_id);
  if (sameErr) return err(`broken_refs link query failed: ${sameErr.message}`);

  const [outHits, inHits] = await Promise.all([
    db.from(DOC_ITEM_XPROJECT_LINKS).select("id, from_item, to_item, relation_type").in("from_item", projectItemIds),
    db.from(DOC_ITEM_XPROJECT_LINKS).select("id, from_item, to_item, relation_type").in("to_item", projectItemIds),
  ]);
  if (outHits.error) return err(`broken_refs cross-project link query failed: ${outHits.error.message}`);
  if (inHits.error) return err(`broken_refs cross-project link query failed: ${inHits.error.message}`);

  const links: LinkRow[] = [
    ...(Array.isArray(sameRows) ? (sameRows as any[]) : []).map((l) => ({ ...l, scope: "same_project" as const })),
    ...((outHits.data ?? []) as any[]).map((l) => ({ ...l, scope: "cross_project_out" as const })),
    ...((inHits.data ?? []) as any[]).map((l) => ({ ...l, scope: "cross_project_in" as const })),
  ];
  // An edge can legitimately be picked up by both cross-project queries when
  // both ends live in this project's item set; dedupe on the link id.
  const seenLinks = new Set<string>();
  const scanned = links.filter((l) => (seenLinks.has(l.id) ? false : (seenLinks.add(l.id), true)));

  // Foreign ends (cross-project) need their own lookup: doc_item_xproject_links
  // has no project_id column (D-074), so the other end can live in ANY project.
  const foreignIds = new Set<string>();
  for (const l of scanned) {
    if (l.scope === "same_project") continue;
    for (const end of [l.from_item, l.to_item]) {
      if (!projectItems.has(end)) foreignIds.add(end);
    }
  }
  const foreignItems = new Map<string, ItemFacts>();
  if (foreignIds.size > 0) {
    const { data: fRows, error: fErr } = await db
      .from(DOC_ITEMS)
      .select("id, code, item_type, status, project_id")
      .in("id", Array.from(foreignIds));
    if (fErr) return err(`broken_refs cross-project target lookup failed: ${fErr.message}`);
    for (const r of (Array.isArray(fRows) ? (fRows as any[]) : [])) {
      foreignItems.set(r.id, { code: r.code ?? null, item_type: r.item_type, status: r.status, project_id: r.project_id });
    }
  }
  const factsFor = (id: string): ItemFacts | undefined => projectItems.get(id) ?? foreignItems.get(id);

  // A 'supersedes' edge points from the retired row to its heir BY
  // CONSTRUCTION (doc_supersede writes old→new). Its from end being retired is
  // the whole point, and a multi-hop chain legitimately has retired rows at
  // both ends — classifying those as broken would turn every correctly
  // versioned item into a defect. Counted separately, never silently dropped.
  const supersedeEdges = scanned.filter((l) => l.relation_type === "supersedes");
  const classifiable = scanned.filter((l) => l.relation_type !== "supersedes");

  // For links onto a superseded target: is there a successor edge this identity
  // can see? If yes the reference is recoverable with doc_item_chain; if no,
  // the trail ends here — a materially worse case, kept distinct.
  const supersededTargets = Array.from(new Set(
    classifiable
      .map((l) => l.to_item)
      .filter((id) => factsFor(id)?.status === "superseded")
  ));
  const successorOf = new Map<string, string>();
  if (supersededTargets.length > 0) {
    const [sSame, sCross] = await Promise.all([
      db.from(DOC_ITEM_LINKS).select("from_item, to_item, relation_type").in("from_item", supersededTargets),
      db.from(DOC_ITEM_XPROJECT_LINKS).select("from_item, to_item, relation_type").in("from_item", supersededTargets),
    ]);
    if (sSame.error) return err(`broken_refs successor lookup failed: ${sSame.error.message}`);
    if (sCross.error) return err(`broken_refs successor lookup failed: ${sCross.error.message}`);
    for (const e of [...(sSame.data ?? []), ...(sCross.data ?? [])] as any[]) {
      if (e.relation_type === "supersedes") successorOf.set(e.from_item, e.to_item);
    }
  }

  const brokenBy: Record<string, number> = {
    superseded_no_successor: 0, superseded_with_successor: 0,
    deprecated: 0, archived: 0, rejected: 0,
  };
  const broken: unknown[] = [];
  const abstained: unknown[] = [];
  let okCount = 0;

  const endDescriptor = (id: string) => {
    const f = factsFor(id);
    return f
      ? { id, code: f.code, item_type: f.item_type, status: f.status, ...(f.project_id ? { project_id: f.project_id } : {}) }
      : { id };
  };

  for (const l of classifiable) {
    const target = factsFor(l.to_item);
    if (!target) {
      // The FK guarantees the row exists (see header). Not readable from here
      // means RLS, and RLS-invisible is NOT a defect of the corpus — it is a
      // limit of this identity's view, and saying otherwise would report the
      // reader's blindness as the project's fault.
      abstained.push({
        link_id: l.id,
        relation_type: l.relation_type,
        scope: l.scope,
        from: endDescriptor(l.from_item),
        to_item: l.to_item,
        reason:
          "target exists (FK-guaranteed) but is not readable by this identity — the link SELECT policy is anchored on the FROM end only, " +
          "so a readable link can point at an unreadable row. Not counted as broken.",
      });
      continue;
    }
    if (!RETIRED_STATUS_SET.has(target.status)) {
      okCount += 1;
      continue;
    }
    const successor = target.status === "superseded" ? successorOf.get(l.to_item) : undefined;
    const kind =
      target.status === "superseded"
        ? (successor ? "superseded_with_successor" : "superseded_no_successor")
        : target.status;
    brokenBy[kind] = (brokenBy[kind] ?? 0) + 1;
    broken.push({
      link_id: l.id,
      relation_type: l.relation_type,
      scope: l.scope,
      from: endDescriptor(l.from_item),
      to: endDescriptor(l.to_item),
      broken: `reference points at a retired row (status='${target.status}')`,
      kind,
      ...(successor
        ? {
            successor_id: successor,
            hint: `recoverable — doc_item_chain({item_id:"${l.to_item}"}) walks forward to the row in force`,
          }
        : target.status === "superseded"
          ? { hint: "no successor edge visible from here — the supersede trail ends at a retired row" }
          : {}),
    });
  }

  const effectiveLimit = args.limit ?? 50;
  const { page: brokenPage, truncated } = paginate(broken, effectiveLimit);
  const { page: abstainedPage } = paginate(abstained, effectiveLimit);
  const gap = scanned.length === 0 ? await visibilityGap(db, args.project_id, ctx.selfSlug) : undefined;

  return {
    ok: true,
    data: {
      mode: "traceability:broken_refs",
      count: brokenPage.length,
      items: brokenPage,
      ...(truncated ? { truncated } : {}),
      ...(abstainedPage.length > 0 ? { abstained_items: abstainedPage } : {}),
      coverage: {
        total_links_scanned: scanned.length,
        classified: classifiable.length,
        ok: okCount,
        broken: broken.length,
        abstained: abstained.length,
        broken_by: brokenBy,
        skipped_supersedes: supersedeEdges.length,
        scanned_by_scope: {
          same_project: scanned.filter((l) => l.scope === "same_project").length,
          cross_project_out: scanned.filter((l) => l.scope === "cross_project_out").length,
          cross_project_in: scanned.filter((l) => l.scope === "cross_project_in").length,
        },
      },
      dangling: {
        count: 0,
        measured: false,
        basis:
          "structural, not measured: both link tables FK both endpoints to doc_items(id) ON DELETE CASCADE " +
          "(doc_item_links_from_fk/_to_fk composite on (id, project_id); doc_item_xproject_links_from_item_fkey/_to_item_fkey). " +
          "Deleting an item deletes its links, so a link to a non-existent row cannot persist. " +
          "An RLS-scoped SELECT could not tell 'deleted' from 'hidden' in any case — that case is reported as abstained, never as zero.",
      },
      retired_statuses: RETIRED_STATUSES,
      notes: [
        "'broken' here means the pointer resolves to a RETIRED row, not a missing one — see `dangling.basis` for why a missing one cannot exist.",
        "'supersedes' edges are excluded from classification (counted in coverage.skipped_supersedes): they point from a retired row to its heir by construction, so scoring them would mark every correctly versioned item as defective.",
        "cross_project_in is structurally INCOMPLETE: the link SELECT policy is anchored on the FROM end, which lives in another project, so inbound references from projects this identity cannot read are invisible here. Treat that count as a floor, never as a total.",
      ],
      ...gap,
    },
  };
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

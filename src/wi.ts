// Work Items (loomx_work_items) — governance-compliance D-024 / hub design §5.2.
//
// Pure handlers that take a DB client (supabase-js shape) and params, and return
// a JSON-serialisable payload. registerTools() wraps each in an MCP tool.
// Keeping them standalone lets tests drive them with a fake client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WiStatus, WiEndStatus, WiTemplateLayer } from "./types.js";
import { checkTemplateName } from "./wiTemplates.js";
import { runDocRw, type DocRwDb } from "./docDb.js";
import { rwGuardsEnabled } from "./flags.js";

const WI_TABLE = "loomx_work_items";
const GTD_TABLE = "loomx_items";
const DOC_ITEM_WI_LINKS_TABLE = "doc_item_wi_links";
const DOC_ITEMS_TABLE = "doc_items";
const AGENT_RUNTIME_TABLE = "loomx_agent_runtime";
const BOARD_MESSAGES_TABLE = "board_messages";

// D-118 (a+): message types that count as "actionable" for the inbox-pending
// guard and (a) the auto-set waiting_on heuristic.
const ACTIONABLE_INBOX_TYPES = new Set(["task", "question", "blocker"]);
// D-118 (a): only question/task can be "the blocker" the WI is waiting on —
// narrower than the inbox guard (a blocker report isn't something *we* sent).
const OUTBOUND_WAIT_TYPES = new Set(["question", "task"]);

// Phase 1 D-074 (REQ-033): WIs with these template names are always ephemeral
// and skip the durable gate. on-the-fly WIs (template_name=null) are also ephemeral.
export const EPHEMERAL_TEMPLATES: readonly string[] = [
  "session-meta",
  "triage",
  "conversation",
  "audit-agent-alignment", // internal report, no REQ/SDES (loomy-approved, msg f7447db6)
];

function isEphemeralWi(
  templateName: string | null | undefined,
  templateLayer: string | null | undefined,
  forceEphemeral: boolean | undefined
): boolean {
  if (forceEphemeral) return true;
  if (!templateName || templateLayer === "on-the-fly") return true;
  return (EPHEMERAL_TEMPLATES as readonly string[]).includes(templateName);
}

// Same shape as docDb.ts's runDocRw — injectable so tests can drive the gate
// with a fake in-memory db instead of a real doc_rw backend.
export type DocRunner = <T>(slug: string, fn: (db: DocRwDb) => Promise<T>) => Promise<T>;

// Gate D-074 (REQ-033): durable WI must have at least one REQ or SDES linked
// via doc_item_wi_links before it can be closed as done.
//
// Must run through runDocRw (not the plain board client): doc_item_wi_links /
// doc_items are RLS-gated (D-015) on request.agent_slug, which is only set
// inside the doc_rw transaction wrapper. Querying them with the plain client
// silently returns 0 rows under RLS-enforcing backends (native DATABASE_URL,
// D-084) — a false "no links found" even when doc_link already succeeded.
async function checkDurableGate(
  runDoc: DocRunner,
  slug: string,
  wiId: string
): Promise<string | null> {
  return runDoc(slug, async (db) => {
    const { data: wiLinks } = await db
      .from(DOC_ITEM_WI_LINKS_TABLE)
      .select("doc_item_id")
      .eq("wi_id", wiId);

    if (!Array.isArray(wiLinks) || wiLinks.length === 0) {
      return (
        `Durable WI '${wiId}' must have ≥1 requirement, sdes_entry, or decision linked via doc_item_wi_links. ` +
        `Use doc_link(target_kind="wi", from_id=<req_uuid>, to_id="${wiId}") or ` +
        `doc_link_by_code(from_code="REQ-NNN", to_id="${wiId}", project_id=...). ` +
        `A governance/coordination WI whose durable output is a decision (D-074: Decisione is the top of the ` +
        `Decisione→REQ→SDES chain) may link the decision item directly instead. ` +
        `Bypass with force_ephemeral=true + force_reason if this WI has no durable artifacts.`
      );
    }

    const ids = (wiLinks as { doc_item_id: string }[]).map((l) => l.doc_item_id);
    const { data: docItems } = await db
      .from(DOC_ITEMS_TABLE)
      .select("id, item_type")
      .in("id", ids);

    const traced = Array.isArray(docItems)
      ? (docItems as { item_type: string }[]).filter(
          (d) =>
            d.item_type === "requirement" ||
            d.item_type === "sdes_entry" ||
            d.item_type === "decision"
        )
      : [];

    if (traced.length === 0) {
      return (
        `Durable WI '${wiId}' has ${ids.length} linked doc item(s) but none are requirement, sdes_entry, or decision. ` +
        `Ensure the linked items are typed correctly or link a proper REQ/SDES/decision.`
      );
    }

    return null; // gate passed
  });
}

// --- D-118 reply-wake structural guards -----------------------------------
// Proposal it-manager msg 49a4177c, GO Achille 2026-08-10 (GTD 1aa130da).
// Both guards are gated behind rwGuardsEnabled() (src/flags.ts): while OFF
// (default) they compute their result and log it to stderr ("would-warn" /
// "would-set") instead of touching the response or the DB — eval-first
// rollout, "niente flip senza suite verde".

interface BoardMsgRow {
  id: string;
  from_agent: string;
  to_agent: string;
  type: string;
  subject?: string;
  ref_id?: string | null;
  status?: string;
  created_at: string;
}

// (a+) At wi_end, warn (never block) if the WI owner has actionable
// (task/question/blocker) pending messages sitting in their board inbox —
// the class of bug behind the 2026-08-10 it-manager/board-mcp deadlock: two
// crossed messages, neither side declared a wait, nobody woke up. This is
// the one guard that would have caught exactly that case: at close time the
// agent is still alive and gets to decide with the information in front of it.
async function checkInboxPendingGuard(
  db: SupabaseClient,
  ctx: WiContext,
  ownerSlug: string,
  now: string
): Promise<string | undefined> {
  if (!ctx.slugToCode || !ctx.codeToSlug) return undefined;
  const ownerCode = ctx.slugToCode.get(ownerSlug);
  if (!ownerCode) return undefined;

  const { data } = await db
    .from(BOARD_MESSAGES_TABLE)
    .select("id, from_agent, to_agent, type, subject, status, created_at")
    .eq("to_agent", ownerCode)
    .eq("status", "pending");

  const rows = (Array.isArray(data) ? data : []) as BoardMsgRow[];
  const actionable = rows
    .filter((m) => ACTIONABLE_INBOX_TYPES.has(m.type))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  if (actionable.length === 0) return undefined;

  const oldest = actionable[0];
  const fromSlug = ctx.codeToSlug.get(oldest.from_agent) ?? oldest.from_agent;
  const ageMin = Math.max(0, Math.round((Date.parse(now) - Date.parse(oldest.created_at)) / 60000));
  const plural = actionable.length > 1 ? `${actionable.length} pending actionable messages` : "1 pending actionable message";
  const msg =
    `${plural} in inbox — oldest: "${oldest.subject ?? "(no subject)"}" (${oldest.type}) from ${fromSlug}, ${ageMin}m ago. ` +
    `Process it (board_get/board_ack) or declare waiting before closing (D-118 a+).`;

  if (!rwGuardsEnabled()) {
    process.stderr.write(`[wi_end][dry-run] would-warn (inbox-pending, D-118): ${msg}\n`);
    return undefined;
  }
  return msg;
}

export interface AutoWaitingOnResult {
  waiting_on?: string;
  block_scope?: string;
  warning?: string;
}

// (a) At wi_end(status=waiting), if the WI owner has an outbound question/task
// still without a reply in-thread since the WI started, auto-set
// waiting_on=<recipient> + block_scope='reply-wake' on the linked GTD instead
// of relying on the agent to remember to declare it. Heuristic for multiple
// candidates: pick the most-recent unanswered outbound; a genuine tie (same
// created_at) is reported as a warning instead of an auto-set (ambiguous —
// D-118 explicitly prefers a warning over a wrong guess). Never overrides an
// already-declared waiting_on (explicit beats inferred).
export async function resolveAutoWaitingOn(
  db: SupabaseClient,
  ctx: WiContext,
  ownerSlug: string,
  wiStartedAt: string | undefined,
  currentWaitingOn: unknown
): Promise<AutoWaitingOnResult> {
  if (currentWaitingOn) return {};
  if (!ctx.slugToCode || !ctx.codeToSlug) return {};
  if (!wiStartedAt) return {};
  const ownerCode = ctx.slugToCode.get(ownerSlug);
  if (!ownerCode) return {};

  const { data: outboundData } = await db
    .from(BOARD_MESSAGES_TABLE)
    .select("id, to_agent, type, created_at")
    .eq("from_agent", ownerCode)
    .gte("created_at", wiStartedAt);

  const outbound = (Array.isArray(outboundData) ? outboundData : []) as BoardMsgRow[];
  const actionable = outbound.filter((m) => OUTBOUND_WAIT_TYPES.has(m.type));
  if (actionable.length === 0) return {};

  const ids = actionable.map((m) => m.id);
  const { data: repliesData } = await db
    .from(BOARD_MESSAGES_TABLE)
    .select("ref_id")
    .in("ref_id", ids);
  const repliedIds = new Set(
    (Array.isArray(repliesData) ? repliesData : [])
      .map((r) => (r as { ref_id?: string | null }).ref_id)
      .filter((v): v is string => typeof v === "string")
  );

  const unanswered = actionable.filter((m) => !repliedIds.has(m.id));
  if (unanswered.length === 0) return {};

  unanswered.sort((a, b) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0));
  const top = unanswered[0];
  const tiedForTop = unanswered.filter((m) => m.created_at === top.created_at);

  if (tiedForTop.length > 1) {
    return {
      warning:
        `${tiedForTop.length} outbound question/task without reply tie at the same timestamp (${top.created_at}) — ` +
        `ambiguous which one is the blocker. Declare waiting_on manually via gtd_update (D-118 a).`,
    };
  }

  const targetSlug = ctx.codeToSlug.get(top.to_agent) ?? top.to_agent;
  return { waiting_on: targetSlug, block_scope: "reply-wake" };
}

export type WiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; runtime_request_posted?: boolean };

interface WiContext {
  selfSlug: string;
  isLoomy: boolean;
  // D-118: agent code<->slug maps, needed to query board_messages (keyed by
  // agent_code, not slug) for the (a+) inbox-pending guard and (a) auto-set
  // waiting_on heuristic. Optional — callers that omit them (existing tests,
  // any future non-board-aware caller) simply skip both features (no-op).
  slugToCode?: Map<string, string>;
  codeToSlug?: Map<string, string>;
}

// --- helpers -------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// Derive a template_layer when not explicitly provided.
// Heuristic: treated as on-the-fly when no template_name; L2 when the name
// contains a "-" segment that looks cluster-specific (e.g. fix-bug-frontend);
// otherwise L1 (universal). Callers can override via wi_link_template.
export function deriveTemplateLayer(
  templateName: string | undefined | null
): WiTemplateLayer | null {
  if (!templateName) return null;
  const parts = templateName.split("-");
  if (parts.length <= 2) return "L1";
  return "L2";
}

async function findActiveForAgent(
  db: SupabaseClient,
  agentSlug: string
): Promise<{ id: string } | null> {
  const { data } = await db
    .from(WI_TABLE)
    .select("id")
    .eq("agent_slug", agentSlug)
    .eq("status", "active")
    .limit(1);
  if (Array.isArray(data) && data.length > 0) {
    return { id: (data[0] as { id: string }).id };
  }
  return null;
}

// --- wi_start ------------------------------------------------------------

export interface WiStartArgs {
  agent_slug?: string;
  gtd_item_id?: string;
  intent: string;
  template_name?: string;
  template_version?: string;
  template_layer?: WiTemplateLayer;
  pre_conditions?: Record<string, unknown>;
  session_id?: string;
}

export async function wiStart(
  db: SupabaseClient,
  args: WiStartArgs,
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; gtd_item_id: string; gtd_created: boolean; template_warning?: string }>> {
  const agentSlug = args.agent_slug ?? ctx.selfSlug;
  if (agentSlug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Only loomy can open a WI for another agent (requested ${agentSlug}).` };
  }

  // Enforce one_active_wi_per_agent at application level (clear error before
  // hitting the EXCLUDE constraint).
  const active = await findActiveForAgent(db, agentSlug);
  if (active) {
    return {
      ok: false,
      error: `Agent "${agentSlug}" already has an active WI (${active.id}). Use wi_switch, wi_pause, or wi_end first.`,
    };
  }

  // Resolve or create the linked GTD item.
  let gtdId = args.gtd_item_id;
  let gtdCreated = false;
  if (gtdId) {
    const { error: updErr } = await db
      .from(GTD_TABLE)
      .update({ gtd_status: "in_progress", updated_at: nowIso() })
      .eq("id", gtdId);
    if (updErr) return { ok: false, error: `Failed to move GTD '${gtdId}' to in_progress: ${updErr.message}. Verify the GTD exists with gtd_get(id).` };
  } else {
    const { data: gtdRow, error: gtdErr } = await db
      .from(GTD_TABLE)
      .insert({
        title: args.intent,
        owner: agentSlug,
        gtd_status: "in_progress",
        priority: "normal",
        source: "wi_start",
      })
      .select("id")
      .maybeSingle();
    if (gtdErr || !gtdRow) {
      return { ok: false, error: `Failed to auto-create GTD item: ${gtdErr?.message ?? "no row returned"}` };
    }
    gtdId = (gtdRow as { id: string }).id;
    gtdCreated = true;
  }

  const templateWarning = checkTemplateName(args.template_name);

  const layer =
    args.template_layer ??
    (args.template_name ? deriveTemplateLayer(args.template_name) : "on-the-fly");

  const insertPayload: Record<string, unknown> = {
    gtd_item_id: gtdId,
    agent_slug: agentSlug,
    intent: args.intent,
    status: "active" as WiStatus,
    template_name: args.template_name ?? null,
    template_version: args.template_version ?? null,
    template_layer: layer,
    pre_conditions: args.pre_conditions ?? {},
    session_id: args.session_id ?? null,
  };

  const { data: wiRow, error: wiErr } = await db
    .from(WI_TABLE)
    .insert(insertPayload)
    .select("id, gtd_item_id, agent_slug, status, started_at")
    .maybeSingle();

  if (wiErr || !wiRow) {
    return { ok: false, error: `Failed to open WI: ${wiErr?.message ?? "no row returned"}` };
  }

  return {
    ok: true,
    data: {
      wi_id: (wiRow as { id: string }).id,
      gtd_item_id: gtdId!,
      gtd_created: gtdCreated,
      ...(templateWarning ? { template_warning: templateWarning } : {}),
    },
  };
}

// --- wi_end --------------------------------------------------------------

export interface WiEndArgs {
  wi_id: string;
  status: WiEndStatus; // 'done' | 'failed' | 'waiting'
  failure_reason?: string;
  post_conditions_state?: Record<string, unknown>;
  side_effects_pending?: unknown[];
  resume_hint?: string; // written to linked GTD — most useful when status=waiting
  // Phase 1 D-074 additions (REQ-033, REQ-034, REQ-035):
  force_ephemeral?: boolean;      // bypass durable gate — must include force_reason
  force_reason?: string;           // audit context for force_ephemeral
  arm_gtd_ids?: string[];          // GTDs to set autopilot=true after close (soft-warn on mismatch)
  post_runtime_request?: string;   // write to loomx_agent_runtime after close (optional)
  platform_contribution?: string;  // returned to caller for pull enabler D-045 (opt-in)
}

// Mapping WI.status from the end-status keyword.
// 'waiting' is not a valid WI DB status — WI goes to 'paused' while the GTD
// goes to 'waiting' (deviation documented in CLAUDE.md WI section).
export function mapEndStatus(endStatus: WiEndStatus): WiStatus {
  if (endStatus === "done") return "done";
  if (endStatus === "failed") return "failed";
  return "paused";
}

export function mapEndToGtdStatus(endStatus: WiEndStatus): string {
  if (endStatus === "done") return "done";
  if (endStatus === "failed") return "next_action";
  return "waiting";
}

export interface WiEndData {
  wi_id: string;
  wi_status: WiStatus;
  gtd_item_id: string;
  gtd_status: string | null;
  gtd_sync_warning?: string;
  gate_bypassed?: boolean;           // true when force_ephemeral was used
  arm_warnings?: string[];           // soft-warns from arm_gtd_ids
  platform_contribution_pending?: string; // content for pull enabler (caller must send)
  runtime_request_warning?: string;  // post_runtime_request write failed (see writeRuntimeRequest)
  // D-118 reply-wake structural guards (see resolveAutoWaitingOn / checkInboxPendingGuard):
  inbox_pending_warning?: string;              // (a+) actionable messages left unprocessed in inbox
  waiting_on_auto_set?: { waiting_on: string; block_scope: string }; // (a) auto-detected blocker
  waiting_on_warning?: string;                 // (a) ambiguous — caller must declare manually
}

// Bug fix (GTD ba022585/c29d6143, dev-hq 2026-08-09, board msg f5fcd912): the
// post_runtime_request write used to live ONLY on the success path, 100+ lines
// after the already-closed early-return below — a WI closed by a race (e.g. the
// reconciler's orphan-detection) before this call landed meant the runtime_request
// silently never got posted, leaving the caller's window with no pending request:
// exactly the state orphan-detection later misread as "hung". Extracted so both
// the early-return and the normal-close path can post it, independent of WI status.
async function writeRuntimeRequest(
  db: SupabaseClient,
  selfSlug: string,
  request: string,
  now: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db
    .from(AGENT_RUNTIME_TABLE)
    .update({ request, updated_at: now })
    .eq("owner_slug", selfSlug);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function wiEnd(
  db: SupabaseClient,
  args: WiEndArgs,
  ctx: WiContext,
  runDoc: DocRunner = runDocRw
): Promise<WiResult<WiEndData>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, gtd_item_id, status, side_effects_log, template_name, template_layer, started_at")
    .eq("id", args.wi_id)
    .maybeSingle();

  if (findErr || !wi) {
    return { ok: false, error: `WI '${args.wi_id}' not found. Use wi_status to check your active WI.` };
  }

  const row = wi as {
    id: string;
    agent_slug: string;
    gtd_item_id: string;
    status: WiStatus;
    side_effects_log: unknown[] | null;
    template_name: string | null;
    template_layer: string | null;
    started_at?: string;
  };

  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot close WI owned by ${row.agent_slug}.` };
  }

  if (row.status === "done" || row.status === "failed") {
    // See writeRuntimeRequest above: post the runtime_request even though the
    // WI is already closed — a stuck caller waiting on this call needs its
    // continue/clear/kill request to land regardless of the WI race outcome.
    if (args.post_runtime_request) {
      const rr = await writeRuntimeRequest(db, ctx.selfSlug, args.post_runtime_request, nowIso());
      return {
        ok: false,
        error: `WI already closed (status=${row.status}).`,
        runtime_request_posted: rr.ok,
      };
    }
    return { ok: false, error: `WI already closed (status=${row.status}).` };
  }

  // Phase 1 D-074 gate (REQ-033): durable WIs closing as 'done' must have ≥1 REQ/SDES linked.
  // Ephemeral WIs (on-the-fly, EPHEMERAL_TEMPLATES, or force_ephemeral) skip the gate.
  // Failed/waiting closures skip the gate (gate only enforces on successful completion).
  let gateBypassed = false;
  if (args.status === "done") {
    if (isEphemeralWi(row.template_name, row.template_layer, args.force_ephemeral)) {
      if (args.force_ephemeral) {
        gateBypassed = true;
      }
    } else {
      // Use the WI owner's slug (not the closer's) — doc_item_wi_links/doc_items
      // are RLS-scoped to the project the WI owner belongs to (loomy closing on
      // someone else's behalf must see that owner's links, not its own).
      const gateErr = await checkDurableGate(runDoc, row.agent_slug, args.wi_id);
      if (gateErr) return { ok: false, error: gateErr };
    }
  }

  const newWiStatus = mapEndStatus(args.status);
  const newGtdStatus = mapEndToGtdStatus(args.status);
  const now = nowIso();

  // Stash side-effects to execute later (skill session-manager v2 consumes these).
  // Deviation: schema column is `side_effects_log` (not `side_effects_pending`).
  // Pending entries carry `{pending: true, ...}`; skill v2 flips to executed.
  const existingLog = Array.isArray(row.side_effects_log) ? row.side_effects_log : [];
  const pending = (args.side_effects_pending ?? []).map((se) => ({
    pending: true,
    scheduled_at: now,
    payload: se,
  }));
  const newLog = [...existingLog, ...pending];

  const update: Record<string, unknown> = {
    status: newWiStatus,
    side_effects_log: newLog,
  };
  // Only set ended_at for terminal statuses. wi_end --waiting maps to paused,
  // which is a suspension not a closure — consistent with wi_pause (no ended_at).
  if (newWiStatus !== "paused") update.ended_at = now;
  if (args.post_conditions_state !== undefined) update.post_conditions_state = args.post_conditions_state;
  if (args.status === "failed" && args.failure_reason) update.failure_reason = args.failure_reason;

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update(update)
    .eq("id", args.wi_id);

  if (updErr) return { ok: false, error: `Failed to close WI: ${updErr.message}` };

  // Cascade to GTD. For 'failed', also stamp a blocker marker in body (tags are
  // a separate junction table loomx_item_tags, not updated here — deviation).
  const gtdUpdate: Record<string, unknown> = {
    gtd_status: newGtdStatus,
    updated_at: now,
  };
  if (args.status === "done") gtdUpdate.completed_at = now;
  if (args.status === "failed" && args.failure_reason) {
    // REQ-017: append [BLOCKER] to existing body rather than overwriting.
    // Fetch existing body first (separate SELECT — GTD is not loaded in wiEnd).
    const { data: gtdRow } = await db
      .from(GTD_TABLE)
      .select("body")
      .eq("id", row.gtd_item_id)
      .maybeSingle();
    const existingBody = (gtdRow as { body?: string | null } | null)?.body ?? "";
    gtdUpdate.body = existingBody
      ? `${existingBody}\n[BLOCKER] ${args.failure_reason}`
      : `[BLOCKER] ${args.failure_reason}`;
  }
  if (args.resume_hint !== undefined) gtdUpdate.resume_hint = args.resume_hint;

  // D-118 (a): auto-set waiting_on/block_scope on wi_end(status=waiting) when
  // the session has an outbound question/task without reply and the agent
  // hasn't already declared a wait. See resolveAutoWaitingOn for the heuristic.
  let waitingOnAutoSet: { waiting_on: string; block_scope: string } | undefined;
  let waitingOnWarning: string | undefined;
  if (args.status === "waiting") {
    const { data: gtdWaitRow } = await db
      .from(GTD_TABLE)
      .select("waiting_on")
      .eq("id", row.gtd_item_id)
      .maybeSingle();
    const currentWaitingOn = (gtdWaitRow as { waiting_on?: unknown } | null)?.waiting_on;
    const auto = await resolveAutoWaitingOn(db, ctx, row.agent_slug, row.started_at, currentWaitingOn);
    if (auto.waiting_on && auto.block_scope) {
      if (rwGuardsEnabled()) {
        gtdUpdate.waiting_on = auto.waiting_on;
        gtdUpdate.block_scope = auto.block_scope;
        waitingOnAutoSet = { waiting_on: auto.waiting_on, block_scope: auto.block_scope };
      } else {
        process.stderr.write(
          `[wi_end][dry-run] would-set (D-118 a): waiting_on=${auto.waiting_on} block_scope=${auto.block_scope} on GTD ${row.gtd_item_id}\n`
        );
      }
    } else if (auto.warning) {
      if (rwGuardsEnabled()) {
        waitingOnWarning = auto.warning;
      } else {
        process.stderr.write(`[wi_end][dry-run] would-warn (D-118 a, ambiguous): ${auto.warning}\n`);
      }
    }
  }

  const { error: gtdErr } = await db
    .from(GTD_TABLE)
    .update(gtdUpdate)
    .eq("id", row.gtd_item_id);

  if (gtdErr) {
    // WI is already closed — return ok with a warning rather than failing the
    // whole operation. The caller can use gtd_complete/gtd_update to repair
    // the GTD manually if needed.
    return {
      ok: true,
      data: {
        wi_id: args.wi_id,
        wi_status: newWiStatus,
        gtd_item_id: row.gtd_item_id,
        gtd_status: null,
        gtd_sync_warning: `GTD sync failed (WI is closed): ${gtdErr.message}`,
      },
    };
  }

  // Phase 1 D-074 (REQ-034): arm follow-on GTDs post-close. Soft-warn on mismatch.
  const armWarnings: string[] = [];
  if (args.arm_gtd_ids && args.arm_gtd_ids.length > 0) {
    for (const gtdId of args.arm_gtd_ids) {
      let armQ = db
        .from(GTD_TABLE)
        .update({ autopilot: true, updated_at: now })
        .eq("id", gtdId);
      // Ownership guard: non-loomy agents can only arm their own GTDs.
      if (!ctx.isLoomy) armQ = armQ.eq("owner", ctx.selfSlug);
      const { data: armData } = await armQ.select("id").maybeSingle();
      if (!armData) {
        armWarnings.push(
          `GTD '${gtdId}' not armed: not found or not owned by '${ctx.selfSlug}'.`
        );
      }
    }
  }

  // Phase 1 D-074 (REQ-034): write runtime_request after close if requested.
  // Fix (dev-hq 2026-08-09): the write's error was previously never checked —
  // a failed update was swallowed silently even on this success path.
  let runtimeRequestWarning: string | undefined;
  if (args.post_runtime_request) {
    const rr = await writeRuntimeRequest(db, ctx.selfSlug, args.post_runtime_request, now);
    if (!rr.ok) runtimeRequestWarning = `runtime_request not posted: ${rr.error}`;
  }

  // D-118 (a+): guard-inbox-pending — informational only, never blocks close.
  const inboxPendingWarning = await checkInboxPendingGuard(db, ctx, row.agent_slug, now);

  return {
    ok: true,
    data: {
      wi_id: args.wi_id,
      wi_status: newWiStatus,
      gtd_item_id: row.gtd_item_id,
      gtd_status: newGtdStatus,
      ...(gateBypassed ? { gate_bypassed: true } : {}),
      ...(armWarnings.length > 0 ? { arm_warnings: armWarnings } : {}),
      ...(args.platform_contribution ? { platform_contribution_pending: args.platform_contribution } : {}),
      ...(runtimeRequestWarning ? { runtime_request_warning: runtimeRequestWarning } : {}),
      ...(inboxPendingWarning ? { inbox_pending_warning: inboxPendingWarning } : {}),
      ...(waitingOnAutoSet ? { waiting_on_auto_set: waitingOnAutoSet } : {}),
      ...(waitingOnWarning ? { waiting_on_warning: waitingOnWarning } : {}),
    },
  };
}

// --- wi_status -----------------------------------------------------------

export interface WiStatusArgs {
  agent_slug?: string;
}

export async function wiStatus(
  db: SupabaseClient,
  args: WiStatusArgs,
  ctx: WiContext
): Promise<WiResult<{ agent_slug: string; active: unknown | null }>> {
  const agentSlug = args.agent_slug ?? ctx.selfSlug;
  const { data, error } = await db
    .from(WI_TABLE)
    .select("*")
    .eq("agent_slug", agentSlug)
    .eq("status", "active")
    .limit(1);

  if (error) return { ok: false, error: error.message };

  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
  return { ok: true, data: { agent_slug: agentSlug, active: row } };
}

// --- wi_query ------------------------------------------------------------

export interface WiQueryArgs {
  agent_slug?: string;
  status?: WiStatus;
  template_name?: string;
  since?: string;
  limit?: number;
}

export async function wiQuery(
  db: SupabaseClient,
  args: WiQueryArgs,
  ctx: WiContext
): Promise<WiResult<{ count: number; items: unknown[] }>> {
  let q = db.from(WI_TABLE).select("*").order("started_at", { ascending: false });

  // Scope: non-loomy agents can only query their own WIs.
  if (!ctx.isLoomy) {
    q = q.eq("agent_slug", ctx.selfSlug);
  } else if (args.agent_slug) {
    q = q.eq("agent_slug", args.agent_slug);
  }

  if (args.status) q = q.eq("status", args.status);
  if (args.template_name) q = q.eq("template_name", args.template_name);
  if (args.since) q = q.gte("started_at", args.since);
  q = q.limit(args.limit ?? 50);

  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  const items = Array.isArray(data) ? data : [];
  return { ok: true, data: { count: items.length, items } };
}

// --- wi_checkpoint -------------------------------------------------------

export interface WiCheckpointArgs {
  wi_id: string;
  files_touched_delta?: string[];
  tool_use_count?: number;
  notes?: string;
}

export async function wiCheckpoint(
  db: SupabaseClient,
  args: WiCheckpointArgs,
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; tool_uses: number; files_touched: number }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, status, in_flight_state")
    .eq("id", args.wi_id)
    .maybeSingle();

  if (findErr || !wi) return { ok: false, error: `WI '${args.wi_id}' not found. Use wi_status to check your active WI.` };

  const row = wi as {
    id: string;
    agent_slug: string;
    status: WiStatus;
    in_flight_state: {
      files_touched?: string[];
      tool_uses?: number;
      notes?: string[];
      [k: string]: unknown;
    } | null;
  };

  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot checkpoint WI owned by ${row.agent_slug}.` };
  }

  if (row.status === "done" || row.status === "failed") {
    // Silent ok:true here is the false positive nottolini escalated (df43c4c6,
    // 2026-08-09): the caller believes it is tracking progress on a WI the
    // reconciler already closed underneath it. Fail loud and name the real
    // status instead of writing a checkpoint nobody will read.
    return { ok: false, error: `WI already closed (status=${row.status}) — checkpoint not recorded. Use wi_status to check your active WI.` };
  }

  const state = row.in_flight_state ?? { files_touched: [], tool_uses: 0 };
  const filesPrev: string[] = Array.isArray(state.files_touched) ? state.files_touched : [];
  const filesSet = new Set(filesPrev);
  for (const f of args.files_touched_delta ?? []) filesSet.add(f);
  const files = Array.from(filesSet);
  const uses = (typeof state.tool_uses === "number" ? state.tool_uses : 0) + (args.tool_use_count ?? 0);
  const notes: string[] = Array.isArray(state.notes) ? [...state.notes] : [];
  if (args.notes) notes.push(`[${nowIso()}] ${args.notes}`);

  const newState = { ...state, files_touched: files, tool_uses: uses, notes };

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update({ in_flight_state: newState, last_checkpoint_at: nowIso() })
    .eq("id", args.wi_id);

  if (updErr) return { ok: false, error: updErr.message };

  return { ok: true, data: { wi_id: args.wi_id, tool_uses: uses, files_touched: files.length } };
}

// --- wi_link_template ----------------------------------------------------

export interface WiLinkTemplateArgs {
  wi_id: string;
  template_name: string;
  template_version: string;
  template_layer?: WiTemplateLayer;
}

export async function wiLinkTemplate(
  db: SupabaseClient,
  args: WiLinkTemplateArgs,
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; template_name: string; template_version: string; template_layer: WiTemplateLayer }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, status")
    .eq("id", args.wi_id)
    .maybeSingle();

  if (findErr || !wi) return { ok: false, error: `WI '${args.wi_id}' not found. Use wi_status to check your active WI.` };

  const row = wi as { agent_slug: string; status: WiStatus };
  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot link template on WI owned by ${row.agent_slug}.` };
  }

  const layer = args.template_layer ?? deriveTemplateLayer(args.template_name) ?? "L1";

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update({
      template_name: args.template_name,
      template_version: args.template_version,
      template_layer: layer,
    })
    .eq("id", args.wi_id);

  if (updErr) return { ok: false, error: updErr.message };

  return {
    ok: true,
    data: {
      wi_id: args.wi_id,
      template_name: args.template_name,
      template_version: args.template_version,
      template_layer: layer,
    },
  };
}

// --- wi_pause / wi_resume ------------------------------------------------

export async function wiPause(
  db: SupabaseClient,
  args: { wi_id: string; resume_hint?: string; block_scope?: string },
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; status: WiStatus; gtd_sync_warning?: string }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, gtd_item_id, status")
    .eq("id", args.wi_id)
    .maybeSingle();
  if (findErr || !wi) return { ok: false, error: `WI '${args.wi_id}' not found. Use wi_status to check your active WI.` };

  const row = wi as { agent_slug: string; gtd_item_id: string; status: WiStatus };
  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot pause WI owned by ${row.agent_slug}.` };
  }
  if (row.status !== "active") {
    return { ok: false, error: `Can only pause an active WI (current: ${row.status}).` };
  }

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update({ status: "paused" as WiStatus })
    .eq("id", args.wi_id);
  if (updErr) return { ok: false, error: updErr.message };

  // Propagate resume_hint / block_scope to linked GTD when provided
  if (args.resume_hint !== undefined || args.block_scope !== undefined) {
    const gtdUpdate: Record<string, unknown> = { updated_at: nowIso() };
    if (args.resume_hint !== undefined) gtdUpdate.resume_hint = args.resume_hint;
    if (args.block_scope !== undefined) gtdUpdate.block_scope = args.block_scope;
    const { error: gtdErr } = await db
      .from(GTD_TABLE)
      .update(gtdUpdate)
      .eq("id", row.gtd_item_id);
    if (gtdErr) {
      // WI is already paused — return ok with a warning, same pattern as wiEnd.
      return {
        ok: true,
        data: { wi_id: args.wi_id, status: "paused" as WiStatus, gtd_sync_warning: `GTD hint update failed (WI is paused): ${gtdErr.message}` },
      };
    }
  }

  return { ok: true, data: { wi_id: args.wi_id, status: "paused" } };
}

export async function wiResume(
  db: SupabaseClient,
  args: { wi_id: string },
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; status: WiStatus }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, status")
    .eq("id", args.wi_id)
    .maybeSingle();
  if (findErr || !wi) return { ok: false, error: `WI '${args.wi_id}' not found. Use wi_query to list your WIs.` };

  const row = wi as { agent_slug: string; status: WiStatus };
  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot resume WI owned by ${row.agent_slug}.` };
  }
  if (row.status !== "paused") {
    return { ok: false, error: `Can only resume a paused WI (current: ${row.status}).` };
  }

  // Enforce one_active at application level.
  const active = await findActiveForAgent(db, row.agent_slug);
  if (active) {
    return { ok: false, error: `Agent already has an active WI (${active.id}). Close or pause it first.` };
  }

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update({ status: "active" as WiStatus })
    .eq("id", args.wi_id);
  if (updErr) return { ok: false, error: updErr.message };

  return { ok: true, data: { wi_id: args.wi_id, status: "active" } };
}

// --- wi_switch -----------------------------------------------------------

export interface WiSwitchArgs {
  old_wi_id: string;
  new_intent: string;
  new_template?: string;
  new_template_version?: string;
  new_template_layer?: WiTemplateLayer;
}

export async function wiSwitch(
  db: SupabaseClient,
  args: WiSwitchArgs,
  ctx: WiContext
): Promise<WiResult<{ closed_wi_id: string; new_wi_id: string; new_gtd_item_id: string }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, gtd_item_id, status, in_flight_state")
    .eq("id", args.old_wi_id)
    .maybeSingle();
  if (findErr || !wi) return { ok: false, error: `WI '${args.old_wi_id}' not found. Use wi_status to check your active WI.` };

  const row = wi as {
    id: string;
    agent_slug: string;
    gtd_item_id: string;
    status: WiStatus;
    in_flight_state: Record<string, unknown> | null;
  };

  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot switch WI owned by ${row.agent_slug}.` };
  }
  if (row.status !== "active") {
    return { ok: false, error: `Can only switch from an active WI (current: ${row.status}).` };
  }

  const now = nowIso();
  // Close the old WI, stamping a deviation marker in in_flight_state
  // (no dedicated column exists for auto_closed_by_switch).
  const oldState = row.in_flight_state ?? {};
  const newOldState = { ...oldState, auto_closed_by_switch: true };

  const { error: closeErr } = await db
    .from(WI_TABLE)
    .update({
      status: "done" as WiStatus,
      ended_at: now,
      in_flight_state: newOldState,
    })
    .eq("id", args.old_wi_id);
  if (closeErr) return { ok: false, error: `Failed to close old WI: ${closeErr.message}` };

  // Cascade old GTD to next_action: it was interrupted, not completed.
  // Without this the old GTD stays in_progress with a closed WI (orphaned).
  await db
    .from(GTD_TABLE)
    .update({ gtd_status: "next_action", updated_at: now })
    .eq("id", row.gtd_item_id);

  // Open new WI (auto-creates its own GTD). Carry agent_slug from old WI.
  const startRes = await wiStart(
    db,
    {
      agent_slug: row.agent_slug,
      intent: args.new_intent,
      template_name: args.new_template,
      template_version: args.new_template_version,
      template_layer: args.new_template_layer,
    },
    ctx
  );

  if (!startRes.ok) {
    return { ok: false, error: `Old WI closed but new wi_start failed: ${startRes.error}` };
  }

  return {
    ok: true,
    data: {
      closed_wi_id: args.old_wi_id,
      new_wi_id: startRes.data.wi_id,
      new_gtd_item_id: startRes.data.gtd_item_id,
    },
  };
}

// Work Items (loomx_work_items) — governance-compliance D-024 / hub design §5.2.
//
// Pure handlers that take a DB client (supabase-js shape) and params, and return
// a JSON-serialisable payload. registerTools() wraps each in an MCP tool.
// Keeping them standalone lets tests drive them with a fake client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WiStatus, WiEndStatus, WiTemplateLayer } from "./types.js";

const WI_TABLE = "loomx_work_items";
const GTD_TABLE = "loomx_items";
const DOC_ITEM_WI_LINKS_TABLE = "doc_item_wi_links";
const DOC_ITEMS_TABLE = "doc_items";
const AGENT_RUNTIME_TABLE = "loomx_agent_runtime";

// Phase 1 D-074 (REQ-033): WIs with these template names are always ephemeral
// and skip the durable gate. on-the-fly WIs (template_name=null) are also ephemeral.
export const EPHEMERAL_TEMPLATES: readonly string[] = [
  "session-meta",
  "triage",
  "conversation",
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

// Gate D-074 (REQ-033): durable WI must have at least one REQ or SDES linked
// via doc_item_wi_links before it can be closed as done.
async function checkDurableGate(db: SupabaseClient, wiId: string): Promise<string | null> {
  const { data: wiLinks } = await db
    .from(DOC_ITEM_WI_LINKS_TABLE)
    .select("doc_item_id")
    .eq("wi_id", wiId);

  if (!Array.isArray(wiLinks) || wiLinks.length === 0) {
    return (
      `Durable WI '${wiId}' must have ≥1 requirement or sdes_entry linked via doc_item_wi_links. ` +
      `Use doc_link(target_kind="wi", from_id=<req_uuid>, to_id="${wiId}") or ` +
      `doc_link_by_code(from_code="REQ-NNN", to_id="${wiId}", project_id=...). ` +
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
        (d) => d.item_type === "requirement" || d.item_type === "sdes_entry"
      )
    : [];

  if (traced.length === 0) {
    return (
      `Durable WI '${wiId}' has ${ids.length} linked doc item(s) but none are requirement or sdes_entry. ` +
      `Ensure the linked items are typed correctly or link a proper REQ/SDES.`
    );
  }

  return null; // gate passed
}

export type WiResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface WiContext {
  selfSlug: string;
  isLoomy: boolean;
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
): Promise<WiResult<{ wi_id: string; gtd_item_id: string; gtd_created: boolean }>> {
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
}

export async function wiEnd(
  db: SupabaseClient,
  args: WiEndArgs,
  ctx: WiContext
): Promise<WiResult<WiEndData>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, gtd_item_id, status, side_effects_log, template_name, template_layer")
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
  };

  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot close WI owned by ${row.agent_slug}.` };
  }

  if (row.status === "done" || row.status === "failed") {
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
      const gateErr = await checkDurableGate(db, args.wi_id);
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
  if (args.post_runtime_request) {
    await db
      .from(AGENT_RUNTIME_TABLE)
      .update({ request: args.post_runtime_request, updated_at: now })
      .eq("owner_slug", ctx.selfSlug);
  }

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

// Work Items (loomx_work_items) — governance-compliance D-024 / hub design §5.2.
//
// Pure handlers that take a DB client (supabase-js shape) and params, and return
// a JSON-serialisable payload. registerTools() wraps each in an MCP tool.
// Keeping them standalone lets tests drive them with a fake client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WiStatus, WiEndStatus, WiTemplateLayer } from "./types.js";

const WI_TABLE = "loomx_work_items";
const GTD_TABLE = "loomx_items";

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
      .eq("id", gtdId)
      .select("id")
      .single();
    if (updErr) return { ok: false, error: `Failed to move GTD to in_progress: ${updErr.message}` };
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
      .single();
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
    .single();

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

export async function wiEnd(
  db: SupabaseClient,
  args: WiEndArgs,
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; wi_status: WiStatus; gtd_item_id: string; gtd_status: string }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, gtd_item_id, status, side_effects_log")
    .eq("id", args.wi_id)
    .single();

  if (findErr || !wi) {
    return { ok: false, error: `WI not found: ${findErr?.message ?? args.wi_id}` };
  }

  const row = wi as {
    id: string;
    agent_slug: string;
    gtd_item_id: string;
    status: WiStatus;
    side_effects_log: unknown[] | null;
  };

  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot close WI owned by ${row.agent_slug}.` };
  }

  if (row.status === "done" || row.status === "failed") {
    return { ok: false, error: `WI already closed (status=${row.status}).` };
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
    ended_at: now,
    side_effects_log: newLog,
  };
  if (args.post_conditions_state !== undefined) update.post_conditions_state = args.post_conditions_state;
  if (args.status === "failed" && args.failure_reason) update.failure_reason = args.failure_reason;

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update(update)
    .eq("id", args.wi_id)
    .select("id")
    .single();

  if (updErr) return { ok: false, error: `Failed to close WI: ${updErr.message}` };

  // Cascade to GTD. For 'failed', also stamp a blocker marker in body (tags are
  // a separate junction table loomx_item_tags, not updated here — deviation).
  const gtdUpdate: Record<string, unknown> = {
    gtd_status: newGtdStatus,
    updated_at: now,
  };
  if (args.status === "done") gtdUpdate.completed_at = now;
  if (args.status === "failed" && args.failure_reason) {
    gtdUpdate.body = `[BLOCKER] ${args.failure_reason}`;
  }

  const { error: gtdErr } = await db
    .from(GTD_TABLE)
    .update(gtdUpdate)
    .eq("id", row.gtd_item_id)
    .select("id")
    .single();

  if (gtdErr) {
    return { ok: false, error: `WI closed but GTD sync failed: ${gtdErr.message}` };
  }

  return {
    ok: true,
    data: {
      wi_id: args.wi_id,
      wi_status: newWiStatus,
      gtd_item_id: row.gtd_item_id,
      gtd_status: newGtdStatus,
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
    .single();

  if (findErr || !wi) return { ok: false, error: `WI not found: ${findErr?.message ?? args.wi_id}` };

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
    .eq("id", args.wi_id)
    .select("id")
    .single();

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
    .single();

  if (findErr || !wi) return { ok: false, error: `WI not found: ${findErr?.message ?? args.wi_id}` };

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
    .eq("id", args.wi_id)
    .select("id")
    .single();

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
  args: { wi_id: string },
  ctx: WiContext
): Promise<WiResult<{ wi_id: string; status: WiStatus }>> {
  const { data: wi, error: findErr } = await db
    .from(WI_TABLE)
    .select("id, agent_slug, status")
    .eq("id", args.wi_id)
    .single();
  if (findErr || !wi) return { ok: false, error: `WI not found: ${findErr?.message ?? args.wi_id}` };

  const row = wi as { agent_slug: string; status: WiStatus };
  if (row.agent_slug !== ctx.selfSlug && !ctx.isLoomy) {
    return { ok: false, error: `Cannot pause WI owned by ${row.agent_slug}.` };
  }
  if (row.status !== "active") {
    return { ok: false, error: `Can only pause an active WI (current: ${row.status}).` };
  }

  const { error: updErr } = await db
    .from(WI_TABLE)
    .update({ status: "paused" as WiStatus })
    .eq("id", args.wi_id)
    .select("id")
    .single();
  if (updErr) return { ok: false, error: updErr.message };

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
    .single();
  if (findErr || !wi) return { ok: false, error: `WI not found: ${findErr?.message ?? args.wi_id}` };

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
    .eq("id", args.wi_id)
    .select("id")
    .single();
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
    .single();
  if (findErr || !wi) return { ok: false, error: `WI not found: ${findErr?.message ?? args.old_wi_id}` };

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
    .eq("id", args.old_wi_id)
    .select("id")
    .single();
  if (closeErr) return { ok: false, error: `Failed to close old WI: ${closeErr.message}` };

  // The existing GTD is left as-is (in_progress) — the new WI will link a new
  // GTD via wiStart --new. Call wiStart with agent_slug carried from old WI.
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

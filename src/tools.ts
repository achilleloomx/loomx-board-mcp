import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient, refreshAgentRegistry } from "./supabase.js";
import { MESSAGE_TYPES, MESSAGE_STATUSES, GTD_STATUSES, GTD_PRIORITIES, MEAL_TYPES, MENU_STATUSES, WI_END_STATUSES, WI_TEMPLATE_LAYERS, RUNTIME_REQUEST_TYPES, WAKE_PRIORITIES } from "./types.js";
import type { AgentRegistry, MessageStatus } from "./types.js";
import {
  DB_DOCUMENT_TYPES,
  DB_ITEM_TYPES,
  DB_DOC_ITEM_LINK_TYPES,
} from "./docTypes.js";
import { rwGuardsEnabled, modelGuardsEnabled } from "./flags.js";
import { SUBSCRIBE_INTENTS, SUBSCRIPTION_OUTCOMES, BUMP_CLASSES } from "./subscriptions.js";

const TABLE = "board_messages";
const OVERVIEW_VIEW = "board_overview";
const GTD_TABLE = "loomx_items";
const GTD_ITEM_PROJECTS_TABLE = "loomx_item_projects";
const PROJECTS_TABLE = "loomx_projects";
const RUNTIME_TABLE = "loomx_agent_runtime";
const WI_TABLE = "loomx_work_items";
const ROLE_CARDS_TABLE = "loomx_role_cards";
const ORG_EDGES_TABLE = "loomx_org_edges";
const SOW_RACI_TABLE = "loomx_sow_raci";
const BOARD_AGENTS_TABLE = "board_agents";

// D-118 (c2, it-manager msg 49a4177c): board_send cold-recipient hint.
// Matches the "live" threshold humanTools.ts fleet_status already uses for
// heartbeat freshness — same signal, same cutoff, no new convention.
const COLD_HINT_THRESHOLD_MS = 10 * 60 * 1000;
const ACTIONABLE_HINT_TYPES = new Set(["task", "question", "blocker"]);

// Pure — extracted so it's unit-testable without a DB (D-118 c2). Never an
// error path: returns undefined whenever no hint applies.
export function buildColdRecipientHint(params: {
  toAgent: string;
  messageType: string;
  wakePriorityOmitted: boolean;
  heartbeatAt: string | null;
  nowMs: number;
}): string | undefined {
  const { toAgent, messageType, wakePriorityOmitted, heartbeatAt, nowMs } = params;
  if (!wakePriorityOmitted) return undefined;
  if (!ACTIONABLE_HINT_TYPES.has(messageType)) return undefined;
  const ageMs = heartbeatAt ? nowMs - new Date(heartbeatAt).getTime() : Infinity;
  if (ageMs <= COLD_HINT_THRESHOLD_MS) return undefined;
  const ageDesc = heartbeatAt ? `${Math.round(ageMs / 60000)}m senza heartbeat` : "nessun heartbeat registrato";
  return (
    `Destinatario '${toAgent}' sembra cold (${ageDesc}) e wake_priority non e' impostato — il messaggio ` +
    `potrebbe restare invisibile finche' non lo controlla attivamente. Valuta wake_priority='normal' o ` +
    `ping(target_agent='${toAgent}', ...) (D-118 c2, hint-only — il send e' comunque andato a buon fine).`
  );
}

// D-118 (GTD 41853607): model-switch contract guards on runtime_request.
// Pure — unit-testable without a DB, same pattern as buildColdRecipientHint.
// Ordinal tiers are a heuristic only (board-mcp owns no canonical model-cost
// registry — see DECISIONS D-118-model-switch-contract for why).
const MODEL_TIER: Record<string, number> = { haiku: 0, sonnet: 1, fable: 1, opus: 2 };

function modelTier(modelSlug: string | null | undefined): number | null {
  if (!modelSlug) return null;
  const lower = modelSlug.toLowerCase();
  for (const [alias, tier] of Object.entries(MODEL_TIER)) {
    if (lower.includes(alias)) return tier;
  }
  return null;
}

export function isHaikuModelSlug(modelSlug: string): boolean {
  return /haiku/i.test(modelSlug);
}

// AGENT-STANDARD §0quater: "MAI Haiku in autopilot — verificato che non regge
// la governance." Returns the rejection message, or undefined if the switch
// is allowed (any mode other than autopilot, or a non-Haiku model).
export function buildHaikuAutopilotBlock(params: {
  requestedModel: string;
  targetMode: string | null;
}): string | undefined {
  const { requestedModel, targetMode } = params;
  if (!isHaikuModelSlug(requestedModel)) return undefined;
  if (targetMode !== "autopilot") return undefined;
  return (
    `Haiku non e' ammesso in mode=autopilot (AGENT-STANDARD §0quater — non regge la governance). ` +
    `Richiedi sonnet (default) o opus per task pesanti.`
  );
}

// E2E-MODEL-08 cost-consent: never blocks, only flags — no silent cost
// increase when a switch moves to a strictly more expensive tier.
export function buildModelCostNotice(params: {
  currentModel: string | null;
  requestedModel: string;
}): string | undefined {
  const { currentModel, requestedModel } = params;
  const currentTier = modelTier(currentModel);
  const requestedTier = modelTier(requestedModel);
  if (currentTier === null || requestedTier === null) return undefined;
  if (requestedTier <= currentTier) return undefined;
  return `cost-consent: switch ${currentModel} -> ${requestedModel} e' un upgrade di tier (D-118, nessun aumento di costo silenzioso).`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// D-069 two-phase arm enforcement: reject autopilot=true while `owner` has an
// active WI — arming races the reconciler, which may evoke before wi_end closes
// the WI (per CLAUDE.md "Autopilot closure"). Returns an MCP error result if
// blocked, or null if the arm is allowed.
async function checkAutopilotArmGuard(
  db: ReturnType<typeof getSupabaseClient>,
  owner: string
): Promise<{ content: { type: "text"; text: string }[]; isError: true } | null> {
  const { data: activeWi } = await db
    .from(WI_TABLE)
    .select("id")
    .eq("agent_slug", owner)
    .eq("status", "active")
    .limit(1);
  if (Array.isArray(activeWi) && activeWi.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `Error: cannot arm autopilot=true — '${owner}' has an active WI ('${(activeWi[0] as { id: string }).id}'). Two-phase arm (D-069): call wi_end first, then arm autopilot.`,
        },
      ],
      isError: true,
    };
  }
  return null;
}

// Builds the `loomx_items` UPDATE payload for gtd_update — only fields the
// caller explicitly passed are included (regression guard: calling with just
// `body` must never flip `gtd_status` or other untouched fields; see
// docs/HISTORY.md "footgun gtd_update body-only" review, D-a5-P7).
export interface GtdUpdateFields {
  title?: string;
  body?: string;
  gtd_status?: string;
  priority?: string;
  deadline?: string | null;
  waiting_on?: string | null;
  owner?: string;
  autopilot?: boolean;
  autopilot_model?: string | null;
  recurrence_days?: number | null;
  block_scope?: string | null;
  resume_hint?: string | null;
  clarified_at?: string | null;
  no_auto_arm?: boolean;
}

// Broker may arm autopilot on another owner's GTD only while the owner has
// never acked it (clarified_at IS NULL). Once acked, that choice stands and
// the broker must escalate to loomy instead (D-093 hardening, 2026-07-07).
export function brokerAutopilotArmBlocked(params: {
  isBroker: boolean;
  isLoomy: boolean;
  selfSlug: string;
  targetOwner: string | undefined;
  targetClarifiedAt: string | null | undefined;
}): boolean {
  const { isBroker, isLoomy, selfSlug, targetOwner, targetClarifiedAt } = params;
  return Boolean(
    isBroker && !isLoomy && targetOwner && targetOwner !== selfSlug && targetClarifiedAt
  );
}

// D-093 broker cross-owner ack: loomy-assistant triages loomy's low-pri mail
// (design pillar C, GTD 983c0784), so it must be able to close (ack/update)
// messages addressed to loomy specifically — not to any agent — WITHOUT
// losing its own inbox (bug fixed 2026-08-01, msg 5df512b6: the previous
// single-code return replaced "own inbox" with "loomy only" instead of
// adding to it, so the broker could no longer ack its own mail). Returns the
// `to_agent` codes the query must filter on (IN), or null for no filter
// (full override, loomy only). Everyone else stays scoped to their own inbox.
export function resolveBoardActorFilterCode(params: {
  isLoomy: boolean;
  isBroker: boolean;
  selfCode: string;
  loomyCode: string | undefined;
}): string[] | null {
  const { isLoomy, isBroker, selfCode, loomyCode } = params;
  if (isLoomy) return null;
  if (isBroker && loomyCode) return [selfCode, loomyCode];
  return [selfCode];
}

export function buildGtdUpdatePayload(fields: GtdUpdateFields): Record<string, unknown> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.title !== undefined) updates.title = fields.title;
  if (fields.body !== undefined) updates.body = fields.body;
  if (fields.gtd_status !== undefined) updates.gtd_status = fields.gtd_status;
  if (fields.priority !== undefined) updates.priority = fields.priority;
  if (fields.deadline !== undefined) updates.deadline = fields.deadline;
  if (fields.waiting_on !== undefined) updates.waiting_on = fields.waiting_on;
  if (fields.owner !== undefined) updates.owner = fields.owner;
  if (fields.autopilot !== undefined) updates.autopilot = fields.autopilot;
  if (fields.autopilot_model !== undefined) updates.autopilot_model = fields.autopilot_model;
  if (fields.recurrence_days !== undefined) updates.recurrence_days = fields.recurrence_days;
  if (fields.block_scope !== undefined) updates.block_scope = fields.block_scope;
  if (fields.resume_hint !== undefined) updates.resume_hint = fields.resume_hint;
  if (fields.clarified_at !== undefined) updates.clarified_at = fields.clarified_at;
  if (fields.no_auto_arm !== undefined) updates.no_auto_arm = fields.no_auto_arm;
  return updates;
}

// GTD 994b3bbc (dedup broadcast, reassigned dev-hq->board-mcp 2026-07-21):
// board_send/board_broadcast never auto-created a GTD for the recipient(s) —
// the "N destinatari -> 1 GTD" symptom traced (dev-hq, 2026-07-04) to
// loomy-assistant's manual triage missing messages, not a code dedup bug
// (D-066 dedup is scoped per (owner, source_ref), so distinct recipients of
// the same broadcast never collide). Opt-in `auto_gtd` on both tools closes
// the actual gap: each recipient gets its own GTD, one per owner, deduped
// against re-sends of the same message via the same (owner, source_ref) rule
// gtd_add already uses.
export function buildAutoGtdInsertPayload(params: {
  owner: string;
  title: string;
  body: string | null;
  source_ref: string;
  priority?: "low" | "normal" | "high" | "urgent";
}): Record<string, unknown> {
  return {
    title: params.title,
    body: params.body,
    gtd_status: "inbox",
    owner: params.owner,
    priority: params.priority ?? "normal",
    source: "board",
    source_ref: params.source_ref,
  };
}

// Stream B-4 (GTD 3acb2328, D-136 §5): soft-warn only, gtd_add creates the
// item either way. A GTD with no project is an established valid state
// (AGENT-STANDARD §5 — cross-project or personal item), not an omission to
// punish — the warning offers that reading explicitly instead of just
// flagging the absence. Never derives a project from the active WI.
export function buildProjectWarning(project_id: string | undefined): string | undefined {
  if (project_id !== undefined) return undefined;
  return `No project_id given. If this GTD is cross-project or personal (coordination, meta-task, stall-triage), that's a valid state — no action needed. If it belongs to a project, add project_id (see project_list for the id).`;
}

const MessageTypeSchema = z.enum(MESSAGE_TYPES);
const StatusFilterSchema = z.enum(MESSAGE_STATUSES);
const WakePrioritySchema = z.enum(WAKE_PRIORITIES);

export function registerTools(
  server: McpServer,
  registry: AgentRegistry
): void {
  const { selfCode, selfSlug, slugToCode, codeToSlug } = registry;

  // Dynamic agent slug validation — no hardcoded enum
  const validSlugs = [...slugToCode.keys()];

  // Lazy-reload: the registry is snapshotted at boot (resolveAgentRegistry),
  // so an agent added to board_agents afterwards misses validation until this
  // re-queries once and retries. slugToCode/codeToSlug are mutated in place
  // (refreshAgentRegistry), so this call site's slugToCode reference sees it.
  const ensureAgentKnown = async (slug: string): Promise<boolean> => {
    if (slugToCode.has(slug)) return true;
    await refreshAgentRegistry(registry);
    return slugToCode.has(slug);
  };

  const validateRecipientSlug = async (slug: string): Promise<string | null> => {
    if (!(await ensureAgentKnown(slug))) return `Unknown agent "${slug}". Valid: ${[...slugToCode.keys()].join(", ")}`;
    if (slug === selfSlug) return "Cannot send a message to yourself";
    return null;
  };

  // Best-effort GTD auto-creation for a message recipient (GTD 994b3bbc,
  // auto_gtd opt-in on board_send/board_broadcast). Dedup mirrors gtd_add
  // (D-066): scoped (owner, source_ref) so this never collides across
  // recipients — only guards against re-sending the same message id twice.
  // Never throws: a GTD-creation failure must not fail the message send.
  const autoCreateGtdForRecipient = async (
    db: ReturnType<typeof getSupabaseClient>,
    params: { owner: string; title: string; body: string | null; source_ref: string; priority?: "low" | "normal" | "high" | "urgent" }
  ): Promise<string | null> => {
    try {
      const { data: existing } = await db
        .from(GTD_TABLE)
        .select("id")
        .eq("owner", params.owner)
        .eq("source_ref", params.source_ref)
        .not("gtd_status", "eq", "trash")
        .maybeSingle();
      if (existing) return null;

      const { error } = await db.from(GTD_TABLE).insert(buildAutoGtdInsertPayload(params));
      return error ? error.message : null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // --- board_send ---
  server.tool(
    "board_send",
    `Send a message to another agent. Valid recipients: ${validSlugs.filter(s => s !== selfSlug).join(", ")}`,
    {
      to_agent: z.string().min(1).describe(`Recipient agent slug (${validSlugs.filter(s => s !== selfSlug).join(", ")})`),
      type: MessageTypeSchema.describe("Message type"),
      subject: z.string().min(1).describe("Message subject"),
      body: z.string().min(1).describe("Message body"),
      summary: z.string().optional().describe("Short summary (saves tokens for recipient — they see this first)"),
      tags: z.array(z.string()).optional().describe("Tags for topic filtering (e.g. ['schema', 'urgent'])"),
      ref_id: z
        .string()
        .uuid()
        .optional()
        .describe("Reference message ID (for done/replies)"),
      wake_priority: WakePrioritySchema.optional().describe(
        "Cold-start wake marker (D-093/D-099): normal|high|urgent. ANY value (including normal) asks the reconciler to cold-wake a sleeping recipient — the priority only orders the wake queue (urgent>high>normal), it does not decide whether to wake. Omit (leave unset) for a regular message with no wake."
      ),
      requested_model: z.string().optional().describe(
        "D-098: model to launch the recipient with on this ping's cold-wake (e.g. 'sonnet', 'opus', 'fable'). Only meaningful together with wake_priority — ignored on a message with no wake. Omit = no preference (reconciler falls back to Sonnet; never Haiku in autopilot, §0quater)."
      ),
      auto_gtd: z.boolean().optional().describe(
        "GTD 994b3bbc: also create a GTD item (owner=recipient, source='board', source_ref=this message's id) so the recipient sees it in gtd_inbox without relying on manual triage. Default false (unchanged behavior). Deduped against re-sends of the same message."
      ),
    },
    async ({ to_agent, type, subject, body, summary, tags, ref_id, wake_priority, requested_model, auto_gtd }) => {
      const validationError = await validateRecipientSlug(to_agent);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
          isError: true,
        };
      }

      const toCode = slugToCode.get(to_agent)!;

      const db = getSupabaseClient();
      const { data, error } = await db
        .from(TABLE)
        .insert({
          from_agent: selfCode,
          to_agent: toCode,
          type,
          subject,
          body,
          summary: summary ?? null,
          tags: tags ?? [],
          ref_id: ref_id ?? null,
          status: "pending",
          ...(wake_priority !== undefined ? { wake_priority } : {}),
          ...(requested_model !== undefined ? { requested_model } : {}),
        })
        .select("id, created_at")
        .maybeSingle();

      if (error || !data) {
        return {
          content: [
            { type: "text", text: `Error sending message: ${error?.message ?? "no row returned (RLS?). Retry board_send with the same args."}` },
          ],
          isError: true,
        };
      }

      let gtdError: string | null = null;
      if (auto_gtd) {
        gtdError = await autoCreateGtdForRecipient(db, {
          owner: to_agent,
          title: subject,
          body: summary ?? body,
          source_ref: data.id,
          priority: wake_priority === "urgent" ? "urgent" : wake_priority === "high" ? "high" : "normal",
        });
      }

      // D-118 (c2): hint (never an error) when an actionable message is sent
      // to a recipient whose heartbeat looks stale and no wake_priority was
      // set — the sender can't otherwise tell the message might sit unseen.
      let coldHint: string | undefined;
      if (wake_priority === undefined && ACTIONABLE_HINT_TYPES.has(type)) {
        const { data: rtRow } = await db
          .from(RUNTIME_TABLE)
          .select("heartbeat_at")
          .eq("owner_slug", to_agent)
          .maybeSingle();
        const heartbeatAt = (rtRow as { heartbeat_at?: string | null } | null)?.heartbeat_at ?? null;
        const msg = buildColdRecipientHint({
          toAgent: to_agent,
          messageType: type,
          wakePriorityOmitted: true,
          heartbeatAt,
          nowMs: Date.now(),
        });
        if (msg) {
          if (rwGuardsEnabled()) {
            coldHint = msg;
          } else {
            process.stderr.write(`[board_send][dry-run] would-hint: ${msg}\n`);
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                id: data.id,
                created_at: data.created_at,
                ...(gtdError ? { gtd_creation_error: gtdError } : {}),
                ...(coldHint ? { hint: coldHint } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --- board_inbox ---
  server.tool(
    "board_inbox",
    "Read incoming messages for this agent (excludes archived). preview_only=true (default) omits body to save tokens — use board_get(id) for full content.",
    {
      status: StatusFilterSchema.optional().describe(
        "Filter by status (default: all)"
      ),
      tag: z.string().optional().describe("Filter by tag (e.g. 'schema')"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max messages to return (default: 20)"),
      preview_only: z
        .boolean()
        .optional()
        .describe("Omit body field (default: true). Set false to receive full body — avoid in batch."),
      wake_only: z
        .boolean()
        .optional()
        .describe("Filter to wake-marked messages only (wake_priority IS NOT NULL) — replaces the deprecated ping_inbox tool (D-093)."),
    },
    async ({ status, tag, limit, preview_only, wake_only }) => {
      const db = getSupabaseClient();
      let query = db
        .from(TABLE)
        .select("*")
        .eq("to_agent", selfCode)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(limit ?? 20);

      if (status) {
        query = query.eq("status", status);
      }

      if (tag) {
        query = query.contains("tags", [tag]);
      }

      if (wake_only) {
        query = query.not("wake_priority", "is", null);
      }

      const { data, error } = await query;

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading inbox: ${error.message}` },
          ],
          isError: true,
        };
      }

      const omitBody = preview_only !== false;
      // Enrich with slugs for readability; strip body in preview mode
      const enriched = (data ?? []).map((msg) => {
        const { body, ...meta } = msg;
        return {
          ...(omitBody ? meta : msg),
          from_agent_slug: codeToSlug.get(msg.from_agent) ?? msg.from_agent,
          to_agent_slug: codeToSlug.get(msg.to_agent) ?? msg.to_agent,
        };
      });

      return {
        content: [
          {
            type: "text",
            text:
              enriched.length === 0
                ? "No messages found."
                : JSON.stringify(enriched, null, 2),
          },
        ],
      };
    }
  );

  // --- board_ack ---
  server.tool(
    "board_ack",
    "Acknowledge receipt of a message",
    {
      message_id: z
        .string()
        .uuid()
        .describe("ID of the message to acknowledge"),
    },
    async ({ message_id }) => {
      const db = getSupabaseClient();

      let query = db
        .from(TABLE)
        .update({ status: "acknowledged" as MessageStatus })
        .eq("id", message_id);

      // Loomy: unrestricted. Broker: only loomy's mail (D-093 cross-owner ack,
      // GTD 983c0784). Everyone else: own inbox only.
      const ackFilterCode = resolveBoardActorFilterCode({
        isLoomy,
        isBroker,
        selfCode,
        loomyCode: slugToCode.get("loomy"),
      });
      if (ackFilterCode !== null) {
        query = query.in("to_agent", ackFilterCode);
      }

      const { data, error } = await query
        .select("id, status")
        .maybeSingle();

      if (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error acknowledging message: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: "Error: message not found or not addressable by you",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ...data }, null, 2),
          },
        ],
      };
    }
  );

  // --- board_broadcast ---
  server.tool(
    "board_broadcast",
    "Send a message to all other active agents at once",
    {
      type: MessageTypeSchema.describe("Message type"),
      subject: z.string().min(1).describe("Message subject"),
      body: z.string().min(1).describe("Message body"),
      summary: z.string().optional().describe("Short summary (saves tokens for recipients)"),
      tags: z.array(z.string()).optional().describe("Tags for topic filtering"),
      ref_id: z
        .string()
        .uuid()
        .optional()
        .describe("Reference message ID (optional)"),
      auto_gtd: z.boolean().optional().describe(
        "GTD 994b3bbc: also create one GTD item per recipient (owner=recipient, source='board', source_ref=that recipient's message id) instead of relying on each agent's manual triage to convert the broadcast into a GTD. Default false (unchanged behavior)."
      ),
    },
    async ({ type, subject, body, summary, tags, ref_id, auto_gtd }) => {
      const db = getSupabaseClient();
      const { data, error } = await db.rpc("board_broadcast", {
        p_from_agent: selfCode,
        p_type: type,
        p_subject: subject,
        p_body: body,
        p_ref_id: ref_id ?? null,
        p_summary: summary ?? null,
        p_tags: tags ?? [],
      });

      if (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error broadcasting message: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      const enriched = (data ?? []).map((msg: any) => ({
        ...msg,
        to_agent_slug: codeToSlug.get(msg.to_agent) ?? msg.to_agent,
      }));

      let gtdErrors: Array<{ to_agent_slug: string; error: string }> = [];
      if (auto_gtd) {
        const results = await Promise.all(
          enriched.map(async (msg: any) => ({
            to_agent_slug: msg.to_agent_slug,
            error: await autoCreateGtdForRecipient(db, {
              owner: msg.to_agent_slug,
              title: subject,
              body: summary ?? body,
              source_ref: msg.id,
              priority: "normal",
            }),
          }))
        );
        gtdErrors = results.filter((r) => r.error) as Array<{ to_agent_slug: string; error: string }>;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, sent_to: enriched.length, messages: enriched, ...(gtdErrors.length ? { gtd_creation_errors: gtdErrors } : {}) },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --- board_update_status ---
  server.tool(
    "board_update_status",
    "Update the status of a message",
    {
      message_id: z.string().uuid().describe("ID of the message to update"),
      status: z
        .enum(["in_progress", "done", "cancelled"])
        .describe("New status"),
    },
    async ({ message_id, status }) => {
      const db = getSupabaseClient();

      let query = db
        .from(TABLE)
        .update({ status: status as MessageStatus })
        .eq("id", message_id);

      // Loomy: unrestricted. Broker: only loomy's mail (D-093 cross-owner ack,
      // GTD 983c0784). Everyone else: own inbox only.
      const statusFilterCode = resolveBoardActorFilterCode({
        isLoomy,
        isBroker,
        selfCode,
        loomyCode: slugToCode.get("loomy"),
      });
      if (statusFilterCode !== null) {
        query = query.in("to_agent", statusFilterCode);
      }

      const { data, error } = await query
        .select("id, status")
        .maybeSingle();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error updating status: ${error.message}` },
          ],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: "Error: message not found or not addressable by you",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ...data }, null, 2),
          },
        ],
      };
    }
  );

  // --- board_overview ---
  server.tool(
    "board_overview",
    "View all board messages with enriched agent info. By default omits body to stay within token limits — use include_body=true or board_get(id) for full content.",
    {
      status: StatusFilterSchema.optional().describe(
        "Filter by status (default: all)"
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max messages to return (default: 20)"),
      include_body: z
        .boolean()
        .optional()
        .describe("Include full message body (default: false — meta only)"),
    },
    async ({ status, limit, include_body }) => {
      const db = getSupabaseClient();
      let query = db
        .from(OVERVIEW_VIEW)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit ?? 20);

      if (status) {
        query = query.eq("status", status);
      }

      const { data, error } = await query;

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading overview: ${error.message}` },
          ],
          isError: true,
        };
      }

      const omitBody = !include_body;
      const rows = omitBody
        ? (data ?? []).map(({ body, ...meta }: any) => meta)
        : (data ?? []);

      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "No messages found."
                : JSON.stringify(rows, null, 2),
          },
        ],
      };
    }
  );

  // --- board_get ---
  server.tool(
    "board_get",
    "Read a single message with full body. Use this after board_inbox/board_overview to load the full content of a specific message.",
    {
      message_id: z.string().uuid().describe("ID of the message to read"),
    },
    async ({ message_id }) => {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from(TABLE)
        .select("*")
        .eq("id", message_id)
        .maybeSingle();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading message: ${error.message}` },
          ],
          isError: true,
        };
      }
      if (!data) {
        return {
          content: [
            { type: "text", text: `Message id='${message_id}' not found or already archived. Use board_inbox to list available messages.` },
          ],
          isError: true,
        };
      }

      const enriched = {
        ...data,
        from_agent_slug: codeToSlug.get(data.from_agent) ?? data.from_agent,
        to_agent_slug: codeToSlug.get(data.to_agent) ?? data.to_agent,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }],
      };
    }
  );

  // --- board_thread ---
  server.tool(
    "board_thread",
    "Retrieve a conversation thread: the original message and all replies referencing it",
    {
      message_id: z
        .string()
        .uuid()
        .describe("ID of any message in the thread (original or reply)"),
    },
    async ({ message_id }) => {
      const db = getSupabaseClient();

      // First, find the root: if this message has a ref_id, the root is ref_id; otherwise it's the message itself
      const { data: anchor, error: anchorErr } = await db
        .from(TABLE)
        .select("id, ref_id")
        .eq("id", message_id)
        .maybeSingle();

      if (anchorErr) {
        return {
          content: [
            {
              type: "text",
              text: `Error finding message: ${anchorErr.message}`,
            },
          ],
          isError: true,
        };
      }
      if (!anchor) {
        return {
          content: [
            {
              type: "text",
              text: `Message id='${message_id}' not found. Use board_inbox to find valid message IDs.`,
            },
          ],
          isError: true,
        };
      }

      const rootId = anchor.ref_id ?? anchor.id;

      // Fetch root + all replies
      const { data, error } = await db
        .from(TABLE)
        .select("*")
        .or(`id.eq.${rootId},ref_id.eq.${rootId}`)
        .order("created_at", { ascending: true });

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading thread: ${error.message}` },
          ],
          isError: true,
        };
      }

      const enriched = (data ?? []).map((msg) => ({
        ...msg,
        from_agent_slug: codeToSlug.get(msg.from_agent) ?? msg.from_agent,
        to_agent_slug: codeToSlug.get(msg.to_agent) ?? msg.to_agent,
      }));

      return {
        content: [
          {
            type: "text",
            text:
              enriched.length === 0
                ? "No messages found in thread."
                : JSON.stringify(
                    { thread_root: rootId, count: enriched.length, messages: enriched },
                    null,
                    2
                  ),
          },
        ],
      };
    }
  );

  // --- board_archive ---
  server.tool(
    "board_archive",
    "Archive old done/cancelled messages (sets archived_at). Uses board_archive_old DB function.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Archive messages older than N days (default: 7)"),
    },
    async ({ days }) => {
      const db = getSupabaseClient();
      const { data, error } = await db.rpc("board_archive_old", {
        p_days: days ?? 7,
      });

      if (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error archiving messages: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, archived_count: data },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // =========================================================================
  // GTD Tools (loomx_items)
  // =========================================================================

  const GtdStatusSchema = z.enum(GTD_STATUSES);
  const GtdPrioritySchema = z.enum(GTD_PRIORITIES);
  const isLoomy = selfSlug === "loomy";
  // loomy-assistant acts as broker/PA: same cross-agent write rights as loomy
  // EXCEPT anagrafica (agents/clients/projects) and governance decisions (loomy-only)
  const isBroker = selfSlug === "loomy-assistant";

  // model_source: distinguishes "no model chosen" (falls to class-based default,
  // D-164, at dispatch) from "model chosen explicitly" on armed items — "not
  // ready to arm" and "armed with the default" were indistinguishable reading
  // the queue. Computed at read time, nothing persisted (it-manager coord,
  // GTD 08330e32; zero-write design proposed by it-manager, accepted as-is).
  const withModelSource = (row: any) => ({
    ...row,
    model_source: row.autopilot ? (row.autopilot_model ? "explicit" : "default") : null,
  });

  // --- gtd_inbox ---
  server.tool(
    "gtd_inbox",
    "Read GTD items owned by this agent, ordered by priority_rank DESC then deadline ASC. By default omits body and adds body_preview (200 chars) — use gtd_get(id) for full content. Every row carries model_source ('explicit'|'default', null when autopilot=false): 'default' means autopilot=true with no autopilot_model — it will resolve to the class-based default at dispatch, not that dispatch was skipped.",
    {
      status: GtdStatusSchema.optional().describe(
        "Filter by GTD status (default: all except done/trash)"
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max items to return (default: 20)"),
      preview_only: z
        .boolean()
        .optional()
        .describe("Omit body, include body_preview 200 chars (default: true). Set false for full body."),
    },
    async ({ status, limit, preview_only }) => {
      const db = getSupabaseClient();
      let query = db
        .from(GTD_TABLE)
        .select("*")
        .eq("owner", selfSlug)
        .order("priority_rank", { ascending: false })
        .order("deadline", { ascending: true, nullsFirst: false })
        .limit(limit ?? 20);

      if (status) {
        query = query.eq("gtd_status", status);
      } else {
        query = query.not("gtd_status", "in", "(done,trash)");
      }

      const { data, error } = await query;

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading GTD inbox: ${error.message}` },
          ],
          isError: true,
        };
      }

      const omitBody = preview_only !== false;
      const rows = omitBody
        ? (data ?? []).map(({ body, ...meta }: any) =>
            withModelSource({ ...meta, body_preview: body ? body.slice(0, 200) : null })
          )
        : (data ?? []).map(withModelSource);

      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "No GTD items found."
                : JSON.stringify(rows, null, 2),
          },
        ],
      };
    }
  );

  // --- gtd_add ---
  server.tool(
    "gtd_add",
    "Create a new GTD item. Omitting project_id returns a soft-warn (project_warning in response) — never blocks, item is created either way; a GTD with no project is a valid state (cross-project/personal).",
    {
      title: z.string().min(1).describe("Item title"),
      body: z.string().optional().describe("Item body/details"),
      gtd_status: GtdStatusSchema.optional().describe(
        "GTD status (default: inbox)"
      ),
      owner: z.string().optional().describe(
        `Owner agent slug (default: ${selfSlug})`
      ),
      priority: GtdPrioritySchema.optional().describe(
        "Priority level (default: normal)"
      ),
      deadline: z.string().optional().describe("Deadline (ISO 8601 date/datetime)"),
      source: z.string().optional().describe("Origin of this item (e.g. board, manual, sync)"),
      source_ref: z.string().optional().describe("Reference ID in the source system"),
      autopilot: z.boolean().optional().describe("Enable autopilot dispatch — agent manager will evoke this agent when the item becomes eligible"),
      autopilot_model: z.string().optional().describe("Model preference for autopilot evocation (e.g. sonnet, opus, haiku)"),
      recurrence_days: z.number().int().positive().optional().describe("Re-arm autopilot N days after completion (recurring task)"),
      block_scope: z.string().optional().describe("Scope tag constraining autopilot dispatch (e.g. 'dns', 'grocery') — agent manager only evokes for matching scope"),
      resume_hint: z.string().optional().describe("Free-text hint for the agent on how/where to resume this item"),
      no_auto_arm: z.boolean().optional().describe("D-100: permanently park this item from autopilot re-arming — the reconciler/broker will not flip autopilot back to true while this is set, even after autopilot=false. Set false to unpark."),
      project_id: z.string().uuid().optional().describe("Project ID (loomx_projects) — links the new item via loomx_item_projects in the same call. Optional. Validates the project exists (errors otherwise, no orphan GTD created). Never derived from the active WI — pass explicitly."),
    },
    async ({ title, body, gtd_status, owner, priority, deadline, source, source_ref, autopilot, autopilot_model, recurrence_days, block_scope, resume_hint, no_auto_arm, project_id }) => {
      const targetOwner = owner ?? selfSlug;

      // Only loomy/broker can create items for other agents
      if (targetOwner !== selfSlug && !(isLoomy || isBroker)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: only loomy can create items for other agents. You can only create items with owner="${selfSlug}".`,
            },
          ],
          isError: true,
        };
      }

      // no_auto_arm authority mirrors clarified_at/gtd_update (D-100 fix):
      // settable only when the caller is the item's own owner, or loomy — not
      // the broker creating an item on another agent's behalf.
      if (no_auto_arm !== undefined && targetOwner !== selfSlug && !isLoomy) {
        return {
          content: [
            { type: "text", text: `Error: only the item owner or loomy can set no_auto_arm.` },
          ],
          isError: true,
        };
      }

      const db = getSupabaseClient();

      if (autopilot === true) {
        const guardError = await checkAutopilotArmGuard(db, targetOwner);
        if (guardError) return guardError;
      }

      // Validate project_id BEFORE inserting the GTD item (G2: no half-created
      // orphan on a bad project_id) — mirrors item_project_link's FK expectations.
      if (project_id !== undefined) {
        const { data: project, error: projectErr } = await db
          .from(PROJECTS_TABLE)
          .select("id")
          .eq("id", project_id)
          .maybeSingle();
        if (projectErr || !project) {
          return {
            content: [
              { type: "text", text: `Error: project_id='${project_id}' not found in loomx_projects. Use project_list to discover a valid id.` },
            ],
            isError: true,
          };
        }
      }

      // D-066 dedup: if source_ref given, return existing GTD (owner+source_ref) instead of inserting
      if (source_ref) {
        const { data: existing } = await db
          .from(GTD_TABLE)
          .select("id, title, gtd_status, owner, created_at")
          .eq("owner", targetOwner)
          .eq("source_ref", source_ref)
          .not("gtd_status", "eq", "trash")
          .maybeSingle();
        if (existing) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, duplicate: true, ...existing }, null, 2),
            }],
          };
        }
      }

      const insertPayload: Record<string, unknown> = {
        title,
        body: body ?? null,
        gtd_status: gtd_status ?? "inbox",
        owner: targetOwner,
        priority: priority ?? "normal",
        deadline: deadline ?? null,
        source: source ?? null,
        source_ref: source_ref ?? null,
      };
      if (autopilot !== undefined) insertPayload.autopilot = autopilot;
      if (autopilot_model !== undefined) insertPayload.autopilot_model = autopilot_model;
      if (recurrence_days !== undefined) insertPayload.recurrence_days = recurrence_days;
      if (block_scope !== undefined) insertPayload.block_scope = block_scope;
      if (resume_hint !== undefined) insertPayload.resume_hint = resume_hint;
      if (no_auto_arm !== undefined) insertPayload.no_auto_arm = no_auto_arm;

      const { data, error } = await db
        .from(GTD_TABLE)
        .insert(insertPayload)
        .select("id, title, gtd_status, owner, created_at")
        .maybeSingle();

      // D-066 race backstop: the pre-INSERT SELECT above is not atomic, so concurrent
      // gtd_add calls with the same (owner, source_ref) can both pass the check and insert.
      // Once the DBA adds a partial UNIQUE (owner, source_ref) WHERE gtd_status <> 'trash',
      // the losing insert returns 23505 — re-select the winner and report it as a duplicate
      // instead of erroring. Harmless (never fires) until that index exists.
      if (error?.code === "23505" && source_ref) {
        const { data: winner } = await db
          .from(GTD_TABLE)
          .select("id, title, gtd_status, owner, created_at")
          .eq("owner", targetOwner)
          .eq("source_ref", source_ref)
          .not("gtd_status", "eq", "trash")
          .maybeSingle();
        if (winner) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, duplicate: true, ...winner }, null, 2),
            }],
          };
        }
      }

      if (error || !data) {
        return {
          content: [
            { type: "text", text: `Error creating GTD item: ${error?.message ?? "no row returned (RLS?). Check owner slug is valid and retry gtd_add."}` },
          ],
          isError: true,
        };
      }

      let project_link: { item_id: string; project_id: string } | undefined;
      if (project_id !== undefined) {
        const { data: linkData, error: linkErr } = await db
          .from(GTD_ITEM_PROJECTS_TABLE)
          .upsert({ item_id: data.id, project_id }, { onConflict: "item_id,project_id" })
          .select("item_id, project_id")
          .maybeSingle();
        if (linkErr || !linkData) {
          return {
            content: [
              { type: "text", text: `GTD item created (id=${data.id}) but project link failed: ${linkErr?.message ?? "no row returned"}. Retry with item_project_link(item_id="${data.id}", project_id="${project_id}").` },
            ],
            isError: true,
          };
        }
        project_link = linkData;
      }

      const project_warning = buildProjectWarning(project_id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ...data, ...(project_link ? { project_link } : {}), ...(project_warning ? { project_warning } : {}) }, null, 2),
          },
        ],
      };
    }
  );

  // --- gtd_update ---
  server.tool(
    "gtd_update",
    "Update an existing GTD item. Only the owner can update (loomy can update any item). Only loomy can reassign owner.",
    {
      id: z.string().uuid().describe("ID of the GTD item to update"),
      title: z.string().min(1).optional().describe("New title"),
      body: z.string().optional().describe("New body"),
      gtd_status: GtdStatusSchema.optional().describe("New GTD status"),
      priority: GtdPrioritySchema.optional().describe("New priority"),
      deadline: z.string().nullable().optional().describe("New deadline (ISO 8601, or null to clear)"),
      waiting_on: z.string().nullable().optional().describe("Agent slug this item is waiting on (or null to clear)"),
      owner: z.string().min(1).optional().describe("Reassign owner (loomy only)"),
      autopilot: z.boolean().optional().describe("Enable/disable autopilot dispatch"),
      autopilot_model: z.string().nullable().optional().describe("Model preference for autopilot (e.g. sonnet, opus, haiku — or null to clear)"),
      recurrence_days: z.number().int().positive().nullable().optional().describe("Recurrence interval in days (or null to clear)"),
      block_scope: z.string().nullable().optional().describe("Autopilot dispatch scope constraint (or null to clear)"),
      resume_hint: z.string().nullable().optional().describe("Hint for the agent on how to resume (or null to clear)"),
      clarified_at: z.union([z.literal(true), z.string(), z.null()]).optional().describe("Owner ack flag: true = set to now, ISO 8601 string = explicit timestamp, null = clear. NULL means the owner has never reviewed the item (loomy/broker may freely evaluate/arm autopilot); once set, the owner's autopilot choice is respected and must not be overridden by others. Settable by the GTD owner or loomy only (not broker on others' items)."),
      no_auto_arm: z.boolean().optional().describe("D-100: permanently park this item from autopilot re-arming — set true so the reconciler/broker stop flipping autopilot back to true on their cycle (autopilot=false alone is not sticky). Set false to unpark."),
    },
    async ({ id, title, body, gtd_status, priority, deadline, waiting_on, owner, autopilot, autopilot_model, recurrence_days, block_scope, resume_hint, clarified_at, no_auto_arm }) => {
      const db = getSupabaseClient();

      // Only loomy/broker can reassign owner
      if (owner !== undefined && !(isLoomy || isBroker)) {
        return {
          content: [
            { type: "text", text: `Error: only loomy can reassign item owner. You cannot change the owner field.` },
          ],
          isError: true,
        };
      }

      // clarified_at is the owner's ack — settable by the actual owner or
      // loomy only. Unlike other fields, the broker's cross-agent update
      // privilege does NOT extend here: if the broker could set it on behalf
      // of another agent, the ack flag would lose its meaning (D-091 follow-on,
      // see GTD task requested by Achille 2026-07-07).
      let resolvedClarifiedAt: string | null | undefined = undefined;
      if (clarified_at !== undefined) {
        resolvedClarifiedAt = clarified_at === true ? new Date().toISOString() : clarified_at;
        const { data: existing } = await db
          .from(GTD_TABLE)
          .select("owner")
          .eq("id", id)
          .maybeSingle();
        const currentOwner = (existing as { owner?: string } | null)?.owner;
        if (currentOwner && currentOwner !== selfSlug && !isLoomy) {
          return {
            content: [
              { type: "text", text: `Error: only the GTD owner ('${currentOwner}') or loomy can set clarified_at.` },
            ],
            isError: true,
          };
        }
      }

      // no_auto_arm authority mirrors clarified_at (D-100 fix): the DB trigger
      // no longer enforces "owner or loomy only" under service_role
      // (session_user is always 'authenticator'), so the check moves here.
      // Broker's general cross-agent update privilege does NOT extend to this
      // field — otherwise the broker could unpark/re-arm what it's meant to
      // be blocked from touching (GTD e21ba805, msg d599d81c from dba).
      if (no_auto_arm !== undefined) {
        const { data: existing } = await db
          .from(GTD_TABLE)
          .select("owner")
          .eq("id", id)
          .maybeSingle();
        const currentOwner = (existing as { owner?: string } | null)?.owner;
        if (currentOwner && currentOwner !== selfSlug && !isLoomy) {
          return {
            content: [
              { type: "text", text: `Error: only the GTD owner ('${currentOwner}') or loomy can set no_auto_arm.` },
            ],
            isError: true,
          };
        }
      }

      if (autopilot === true) {
        let targetOwner = owner;
        let targetClarifiedAt: string | null | undefined;
        if (targetOwner === undefined || (isBroker && !isLoomy)) {
          const { data: existing } = await db
            .from(GTD_TABLE)
            .select("owner, clarified_at")
            .eq("id", id)
            .maybeSingle();
          targetOwner = targetOwner ?? (existing as { owner?: string } | null)?.owner;
          targetClarifiedAt = (existing as { clarified_at?: string | null } | null)?.clarified_at;
        }

        if (brokerAutopilotArmBlocked({ isBroker, isLoomy, selfSlug, targetOwner, targetClarifiedAt })) {
          return {
            content: [
              { type: "text", text: `Error: GTD item id='${id}' has already been reviewed by its owner ('${targetOwner}', clarified_at=${targetClarifiedAt}) — the broker cannot arm autopilot on it. Escalate to loomy.` },
            ],
            isError: true,
          };
        }

        if (targetOwner) {
          const guardError = await checkAutopilotArmGuard(db, targetOwner);
          if (guardError) return guardError;
        }
      }

      const updates = buildGtdUpdatePayload({
        title, body, gtd_status, priority, deadline, waiting_on, owner,
        autopilot, autopilot_model, recurrence_days, block_scope, resume_hint,
        clarified_at: resolvedClarifiedAt, no_auto_arm,
      });

      let query = db
        .from(GTD_TABLE)
        .update(updates)
        .eq("id", id);

      // Ownership check: broker/loomy can update any agent's items
      if (!(isLoomy || isBroker)) {
        query = query.eq("owner", selfSlug);
      }

      const { data, error } = await query
        .select("id, title, gtd_status, priority, owner, updated_at")
        .maybeSingle();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error updating GTD item: ${error.message}` },
          ],
          isError: true,
        };
      }
      if (!data) {
        return {
          content: [
            { type: "text", text: `GTD item id='${id}' not found or not owned by you. Use gtd_inbox to verify the item exists and you are the owner.` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ...data }, null, 2),
          },
        ],
      };
    }
  );

  // --- gtd_query ---
  server.tool(
    "gtd_query",
    `Flexible query for GTD items. ${isLoomy || isBroker ? "Cross-agent read enabled (loomy/broker)." : "Filters to your own items."} By default omits body and adds body_preview (200 chars) — use gtd_get(id) for full content. Every row carries model_source ('explicit'|'default', null when autopilot=false): 'default' means autopilot=true with no autopilot_model — it will resolve to the class-based default at dispatch, not that dispatch was skipped.`,
    {
      owner: z.string().optional().describe("Filter by owner agent slug"),
      gtd_status: GtdStatusSchema.optional().describe("Filter by GTD status"),
      priority: GtdPrioritySchema.optional().describe("Filter by priority"),
      source_ref: z.string().optional().describe("Filter by source reference ID (D-066 dedup check — loomy/broker can query cross-owner)"),
      project_id: z.string().uuid().optional().describe("Filter by project ID (via loomx_item_projects)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max items to return (default: 20)"),
      preview_only: z
        .boolean()
        .optional()
        .describe("Omit body, include body_preview 200 chars (default: true). Set false for full body."),
    },
    async ({ owner, gtd_status, priority, source_ref, project_id, limit, preview_only }) => {
      const db = getSupabaseClient();

      // If project_id is specified, we need to join through loomx_item_projects
      if (project_id) {
        // First get item IDs linked to this project
        const { data: links, error: linkErr } = await db
          .from(GTD_ITEM_PROJECTS_TABLE)
          .select("item_id")
          .eq("project_id", project_id);

        if (linkErr) {
          return {
            content: [
              { type: "text", text: `Error querying project links: ${linkErr.message}` },
            ],
            isError: true,
          };
        }

        const itemIds = (links ?? []).map((l: any) => l.item_id);
        if (itemIds.length === 0) {
          return {
            content: [{ type: "text", text: "No GTD items found for this project." }],
          };
        }

        let query = db
          .from(GTD_TABLE)
          .select("*")
          .in("id", itemIds)
          .order("priority_rank", { ascending: false })
          .order("deadline", { ascending: true, nullsFirst: false })
          .limit(limit ?? 20);

        // Ownership filter: loomy/broker get cross-agent read; others scoped to self
        if (isLoomy || isBroker) {
          if (owner) query = query.eq("owner", owner);
        } else {
          query = query.eq("owner", selfSlug);
        }

        if (gtd_status) query = query.eq("gtd_status", gtd_status);
        if (priority) query = query.eq("priority", priority);
        if (source_ref) query = query.eq("source_ref", source_ref);

        const { data, error } = await query;

        if (error) {
          return {
            content: [
              { type: "text", text: `Error querying GTD items: ${error.message}` },
            ],
            isError: true,
          };
        }

        const omitBodyP = preview_only !== false;
        const rowsP = omitBodyP
          ? (data ?? []).map(({ body, ...meta }: any) =>
              withModelSource({ ...meta, body_preview: body ? body.slice(0, 200) : null })
            )
          : (data ?? []).map(withModelSource);

        return {
          content: [
            {
              type: "text",
              text:
                rowsP.length === 0
                  ? "No GTD items found."
                  : JSON.stringify(rowsP, null, 2),
            },
          ],
        };
      }

      // Standard query without project filter
      let query = db
        .from(GTD_TABLE)
        .select("*")
        .order("priority_rank", { ascending: false })
        .order("deadline", { ascending: true, nullsFirst: false })
        .limit(limit ?? 20);

      // Ownership filter: loomy/broker get cross-agent read; others scoped to self
      if (isLoomy || isBroker) {
        if (owner) query = query.eq("owner", owner);
      } else {
        query = query.eq("owner", selfSlug);
      }

      if (gtd_status) query = query.eq("gtd_status", gtd_status);
      if (priority) query = query.eq("priority", priority);
      if (source_ref) query = query.eq("source_ref", source_ref);

      const { data, error } = await query;

      if (error) {
        return {
          content: [
            { type: "text", text: `Error querying GTD items: ${error.message}` },
          ],
          isError: true,
        };
      }

      const omitBody = preview_only !== false;
      const rows = omitBody
        ? (data ?? []).map(({ body, ...meta }: any) =>
            withModelSource({ ...meta, body_preview: body ? body.slice(0, 200) : null })
          )
        : (data ?? []).map(withModelSource);

      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "No GTD items found."
                : JSON.stringify(rows, null, 2),
          },
        ],
      };
    }
  );

  // --- gtd_complete ---
  server.tool(
    "gtd_complete",
    "Mark a GTD item as done (shortcut). Only the owner can complete (loomy can complete any item).",
    {
      id: z.string().uuid().describe("ID of the GTD item to complete"),
    },
    async ({ id }) => {
      const db = getSupabaseClient();
      const now = new Date().toISOString();

      let query = db
        .from(GTD_TABLE)
        .update({
          gtd_status: "done",
          completed_at: now,
          updated_at: now,
        })
        .eq("id", id);

      // Ownership check
      if (!isLoomy) {
        query = query.eq("owner", selfSlug);
      }

      const { data, error } = await query
        .select("id, title, gtd_status, completed_at")
        .maybeSingle();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error completing GTD item: ${error.message}` },
          ],
          isError: true,
        };
      }
      if (!data) {
        return {
          content: [
            { type: "text", text: `GTD item id='${id}' not found or not owned by you. Use gtd_inbox to verify the item exists and you are the owner.` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ...data }, null, 2),
          },
        ],
      };
    }
  );

  // --- gtd_get ---
  server.tool(
    "gtd_get",
    "Read a single GTD item with full body. Only the owner can read (loomy can read any item).",
    {
      id: z.string().uuid().describe("GTD item ID"),
    },
    async ({ id }) => {
      const db = getSupabaseClient();
      let query = db
        .from(GTD_TABLE)
        .select("*")
        .eq("id", id);

      if (!isLoomy) {
        query = query.eq("owner", selfSlug);
      }

      const { data, error } = await query.maybeSingle();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading GTD item: ${error.message}` },
          ],
          isError: true,
        };
      }
      if (!data) {
        return {
          content: [
            { type: "text", text: `GTD item id='${id}' not found or not owned by you. Use gtd_inbox to list your items.` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  const GTD_ITEM_AGENTS_TABLE = "loomx_item_agents";

  // --- gtd_link_agent ---
  server.tool(
    "gtd_link_agent",
    "Add an agent as co-engaged on a GTD item (collaborator/watcher). Only the item owner or loomy can link agents.",
    {
      item_id: z.string().uuid().describe("GTD item ID"),
      agent_slug: z.string().min(1).describe("Slug of the agent to link"),
      role: z.string().optional().describe("Co-engagement role (default: collaborator). Suggested values: collaborator, watcher"),
    },
    async ({ item_id, agent_slug, role }) => {
      const db = getSupabaseClient();

      if (!isLoomy) {
        const { data: item, error: itemErr } = await db
          .from(GTD_TABLE)
          .select("owner")
          .eq("id", item_id)
          .maybeSingle();
        if (itemErr || !item) {
          return {
            content: [{ type: "text", text: `Error: GTD item id='${item_id}' not found or access denied. Use gtd_inbox to verify the item exists.` }],
            isError: true,
          };
        }
        if (item.owner !== selfSlug) {
          return {
            content: [{ type: "text", text: `Error: only the item owner (${item.owner}) or loomy can link agents` }],
            isError: true,
          };
        }
      }

      if (!(await ensureAgentKnown(agent_slug))) {
        return {
          content: [{ type: "text", text: `Error: unknown agent slug "${agent_slug}". Valid: ${[...slugToCode.keys()].join(", ")}` }],
          isError: true,
        };
      }

      const { data, error } = await db
        .from(GTD_ITEM_AGENTS_TABLE)
        .insert({
          item_id,
          agent_slug,
          role: role ?? "collaborator",
          added_by: selfSlug,
        })
        .select("item_id, agent_slug, role, added_by, added_at")
        .maybeSingle();

      if (error || !data) {
        return {
          content: [{ type: "text", text: `Error linking agent: ${error?.message ?? "no row returned. Check item_id and agent_slug are valid, then retry gtd_link_agent."}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }],
      };
    }
  );

  // --- gtd_unlink_agent ---
  server.tool(
    "gtd_unlink_agent",
    "Remove a co-engaged agent from a GTD item. Only the item owner or loomy can unlink agents.",
    {
      item_id: z.string().uuid().describe("GTD item ID"),
      agent_slug: z.string().min(1).describe("Slug of the agent to unlink"),
    },
    async ({ item_id, agent_slug }) => {
      const db = getSupabaseClient();

      if (!isLoomy) {
        const { data: item, error: itemErr } = await db
          .from(GTD_TABLE)
          .select("owner")
          .eq("id", item_id)
          .maybeSingle();
        if (itemErr || !item) {
          return {
            content: [{ type: "text", text: `Error: GTD item id='${item_id}' not found or access denied. Use gtd_inbox to verify the item exists.` }],
            isError: true,
          };
        }
        if (item.owner !== selfSlug) {
          return {
            content: [{ type: "text", text: `Error: only the item owner (${item.owner}) or loomy can unlink agents` }],
            isError: true,
          };
        }
      }

      const { data, error } = await db
        .from(GTD_ITEM_AGENTS_TABLE)
        .delete()
        .eq("item_id", item_id)
        .eq("agent_slug", agent_slug)
        .select("item_id, agent_slug")
        .maybeSingle();

      if (error) {
        return {
          content: [{ type: "text", text: `Error unlinking agent: ${error.message}` }],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [{ type: "text", text: `Error: no link found for item ${item_id} / agent ${agent_slug}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, unlinked: data }, null, 2) }],
      };
    }
  );

  // --- gtd_list_agents ---
  server.tool(
    "gtd_list_agents",
    "List all co-engaged agents on a GTD item. Accessible by the item owner, any co-engaged agent, or loomy.",
    {
      item_id: z.string().uuid().describe("GTD item ID"),
    },
    async ({ item_id }) => {
      const db = getSupabaseClient();

      if (!isLoomy) {
        // Verify the caller is the item owner OR is co-engaged on this item
        const { data: item } = await db
          .from(GTD_TABLE)
          .select("owner")
          .eq("id", item_id)
          .maybeSingle();

        const isOwner = item?.owner === selfSlug;

        if (!isOwner) {
          const { data: link } = await db
            .from(GTD_ITEM_AGENTS_TABLE)
            .select("agent_slug")
            .eq("item_id", item_id)
            .eq("agent_slug", selfSlug)
            .maybeSingle();

          if (!link) {
            return {
              content: [{ type: "text", text: `Error: access denied — you are neither the item owner nor co-engaged on this item` }],
              isError: true,
            };
          }
        }
      }

      const { data, error } = await db
        .from(GTD_ITEM_AGENTS_TABLE)
        .select("agent_slug, role, added_by, added_at")
        .eq("item_id", item_id)
        .order("added_at");

      if (error) {
        return {
          content: [{ type: "text", text: `Error listing agents: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ item_id, agents: data ?? [] }, null, 2) }],
      };
    }
  );

  // --- item_project_link ---
  server.tool(
    "item_project_link",
    "Link a GTD item to a project (loomx_item_projects). Only the item owner or loomy can link. Idempotent — re-linking an existing pair is a no-op.",
    {
      item_id: z.string().uuid().describe("GTD item ID"),
      project_id: z.string().uuid().describe("Project ID (loomx_projects)"),
    },
    async ({ item_id, project_id }) => {
      const db = getSupabaseClient();

      if (!isLoomy) {
        const { data: item, error: itemErr } = await db
          .from(GTD_TABLE)
          .select("owner")
          .eq("id", item_id)
          .maybeSingle();
        if (itemErr || !item) {
          return {
            content: [{ type: "text", text: `Error: GTD item id='${item_id}' not found or access denied. Use gtd_inbox to verify the item exists.` }],
            isError: true,
          };
        }
        if (item.owner !== selfSlug) {
          return {
            content: [{ type: "text", text: `Error: only the item owner (${item.owner}) or loomy can link projects` }],
            isError: true,
          };
        }
      }

      const { data, error } = await db
        .from(GTD_ITEM_PROJECTS_TABLE)
        .upsert({ item_id, project_id }, { onConflict: "item_id,project_id" })
        .select("item_id, project_id")
        .maybeSingle();

      if (error || !data) {
        return {
          content: [{ type: "text", text: `Error linking project: ${error?.message ?? "no row returned. Check item_id and project_id are valid UUIDs referencing existing rows, then retry item_project_link."}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }],
      };
    }
  );

  // --- project_list ---
  server.tool(
    "project_list",
    "Read-only list of projects (loomx_projects) — id, name, short_name, status, agent_id. Use to discover project_id without the Management API.",
    {
      status: z.string().optional().describe("Filter by status (default: all)"),
      agent_id: z.string().optional().describe("Filter by responsible agent slug"),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default: 50)"),
    },
    async ({ status, agent_id, limit }) => {
      const db = getSupabaseClient();
      let query = db
        .from(PROJECTS_TABLE)
        .select("id, name, short_name, status, agent_id")
        .order("name")
        .limit(limit ?? 50);
      if (status) query = query.eq("status", status);
      if (agent_id) query = query.eq("agent_id", agent_id);

      const { data, error } = await query;
      if (error) {
        return {
          content: [{ type: "text", text: `Error listing projects: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ projects: data ?? [] }, null, 2) }],
      };
    }
  );

  // --- org_lookup ---
  server.tool(
    "org_lookup",
    "Read-only org chart / RACI lookup (org-registry, D-090/D-091). agent -> role-card + reporting/escalation/help edges; project -> RACI matrix. Available to all agents (knowledge sharing, no slug restriction).",
    {
      agent: z.string().optional().describe("Agent slug — returns its role-card and org edges"),
      question: z.enum(["card", "chain", "escalation", "help"]).optional().describe("Query mode for `agent` (default: card)"),
      domain: z.string().optional().describe("Filter escalation/help edges by domain (e.g. 'infra')"),
      project: z.string().optional().describe("Project slug (short_name) or UUID — returns its RACI matrix"),
      sow: z.string().optional().describe("sow_document_id filter within a project (UUID of a documents row with document_type='sow')"),
      raci: z.enum(["R", "A", "C", "I"]).optional().describe("Filter the RACI matrix to one role (requires `project`)"),
    },
    async ({ agent, question, domain, project, sow, raci }) => {
      const db = getSupabaseClient();

      if (!agent && !project) {
        return {
          content: [{ type: "text", text: "Error: provide at least one of `agent` or `project`" }],
          isError: true,
        };
      }

      // --- project/SoW RACI mode ---
      if (project) {
        type ProjectRow = { id: string; name: string; short_name: string | null; agent_id: string | null };
        const projectFilterCol = UUID_RE.test(project) ? "id" : "short_name";
        const { data: projectData, error: projectErr } = await db
          .from(PROJECTS_TABLE)
          .select("id, name, short_name, agent_id")
          .eq(projectFilterCol, project)
          .maybeSingle();
        if (projectErr) {
          return { content: [{ type: "text", text: `Error resolving project: ${projectErr.message}` }], isError: true };
        }
        if (!projectData) {
          return {
            content: [{ type: "text", text: `Error: project "${project}" not found (looked up by ${projectFilterCol}). Use project_list to discover valid slugs/ids.` }],
            isError: true,
          };
        }
        const projectRow = projectData as ProjectRow;

        let raciQuery = db
          .from(SOW_RACI_TABLE)
          .select(
            "agent_slug, person_id, raci, scope_note, sow_document_id, status, ratified_by, ratified_at, ratification_kind, ratification_recorded_by, ratification_recorded_at, ratification_evidence"
          )
          .eq("project_id", projectRow.id);
        if (sow) raciQuery = raciQuery.eq("sow_document_id", sow);
        if (raci) raciQuery = raciQuery.eq("raci", raci);

        const { data: raciRows, error: raciErr } = await raciQuery;
        if (raciErr) {
          return { content: [{ type: "text", text: `Error reading RACI: ${raciErr.message}` }], isError: true };
        }

        const rows = raciRows ?? [];

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    project: { id: projectRow.id, name: projectRow.name, short_name: projectRow.short_name },
                    raci: null,
                    fallback: {
                      reason: "no RACI registered for this project (D-091 fallback)",
                      owner: projectRow.agent_id,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Resolve agent labels for agent-subject rows.
        const agentSlugs = [...new Set(rows.map((r) => r.agent_slug).filter((s): s is string => !!s))];
        const labelBySlug = new Map<string, string>();
        if (agentSlugs.length > 0) {
          const { data: agentRows } = await db
            .from(BOARD_AGENTS_TABLE)
            .select("slug, label")
            .in("slug", agentSlugs);
          for (const a of (agentRows ?? []) as { slug: string; label: string }[]) {
            labelBySlug.set(a.slug, a.label);
          }
        }

        // loomx_people does not exist yet (D-084 pending) — person subjects
        // surface as raw person_id until that table lands (per DBA migration
        // 20260706100000 note).
        const matrix: Record<string, { subject: string; type: "agent" | "person"; scope_note: string | null }[]> = {
          A: [],
          R: [],
          C: [],
          I: [],
        };
        for (const r of rows) {
          const entry = r.agent_slug
            ? { subject: labelBySlug.get(r.agent_slug) ?? r.agent_slug, type: "agent" as const, scope_note: r.scope_note }
            : { subject: `person:${r.person_id}`, type: "person" as const, scope_note: r.scope_note };
          matrix[r.raci].push(entry);
        }

        // D-091 step 3 (dba msg a442433b): first-level ratification marker —
        // consumers read `raci`/print it, not row-by-row status.
        const statuses = new Set(rows.map((r) => r.status ?? null));
        let state: "proposed" | "ratified" | "mixed" | "undeclared";
        if (statuses.size === 1) {
          const only = [...statuses][0];
          state = only === "proposed" ? "proposed" : only === "ratified" ? "ratified" : "undeclared";
        } else {
          state = "mixed";
        }

        const ratification: Record<string, unknown> = { state };
        if (state === "proposed" || state === "mixed" || state === "undeclared") {
          ratification.warning =
            state === "undeclared"
              ? "Matrice NON ratificata: nessuna dichiarazione di stato registrata."
              : state === "mixed"
                ? "Matrice PARZIALMENTE ratificata: righe con stato eterogeneo — verificare riga per riga."
                : "Matrice NON ratificata: proposta in attesa di ratifica.";
        }
        if (state === "ratified") {
          const ratifiedRows = rows.filter((r) => r.status === "ratified");
          const distinctBy = [
            ...new Set(
              ratifiedRows.map((r) =>
                JSON.stringify([r.ratified_by, r.ratified_at, r.ratification_kind, r.ratification_recorded_by])
              )
            ),
          ];
          if (distinctBy.length === 1) {
            const first = ratifiedRows[0];
            ratification.ratified_by = first.ratified_by;
            ratification.ratified_at = first.ratified_at;
            if (first.ratification_kind === "attested") {
              ratification.ratification_recorded_by = first.ratification_recorded_by;
            }
          } else {
            // Rows disagree on who/when — surface honestly instead of guessing one.
            ratification.by = ratifiedRows.map((r) => ({
              ratified_by: r.ratified_by,
              ratified_at: r.ratified_at,
              ratification_kind: r.ratification_kind,
              ...(r.ratification_kind === "attested" ? { ratification_recorded_by: r.ratification_recorded_by } : {}),
            }));
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  project: { id: projectRow.id, name: projectRow.name, short_name: projectRow.short_name },
                  ratification,
                  raci: matrix,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // --- agent card/chain/escalation/help mode ---
      const agentSlug = agent as string;
      const mode = question ?? "card";

      // D-118/F7: the reporting/escalation chain always terminates on a human
      // (loomx_role_cards.human_ref, migration 20260814180000) — never on an
      // agent. Shared by chain/escalation below.
      const fetchHumanRef = async (slug: string): Promise<{ humanRef: string | null; error: string | null }> => {
        const { data, error } = await db
          .from(ROLE_CARDS_TABLE)
          .select("human_ref")
          .eq("agent_slug", slug)
          .maybeSingle();
        if (error) return { humanRef: null, error: error.message };
        return { humanRef: (data as { human_ref: string } | null)?.human_ref ?? null, error: null };
      };

      if (mode === "chain") {
        const chain: string[] = [agentSlug];
        const visited = new Set<string>([agentSlug]);
        let current = agentSlug;
        for (let hop = 0; hop < 20; hop++) {
          const { data, error } = await db
            .from(ORG_EDGES_TABLE)
            .select("to_agent")
            .eq("from_agent", current)
            .eq("edge_type", "reports_to")
            .maybeSingle();
          if (error) {
            return { content: [{ type: "text", text: `Error walking reports_to chain: ${error.message}` }], isError: true };
          }
          if (!data) break;
          const next = (data as { to_agent: string }).to_agent;
          if (visited.has(next)) {
            return {
              content: [{ type: "text", text: `Error: cycle detected in reports_to chain at "${next}" (chain so far: ${chain.join(" -> ")})` }],
              isError: true,
            };
          }
          chain.push(next);
          visited.add(next);
          current = next;
        }
        const { humanRef, error: humanErr } = await fetchHumanRef(current);
        if (humanErr) {
          return { content: [{ type: "text", text: `Error resolving terminal human_ref for "${current}": ${humanErr}` }], isError: true };
        }
        if (humanRef) chain.push(`human:${humanRef}`);
        return { content: [{ type: "text", text: JSON.stringify({ agent: agentSlug, chain }, null, 2) }] };
      }

      if (mode === "escalation") {
        let query = db
          .from(ORG_EDGES_TABLE)
          .select("to_agent, domain, note")
          .eq("from_agent", agentSlug)
          .eq("edge_type", "escalates_to");
        if (domain) query = query.eq("domain", domain);
        const { data: edges, error } = await query;
        if (error) {
          return { content: [{ type: "text", text: `Error reading escalation edges: ${error.message}` }], isError: true };
        }

        if (domain) {
          const match = (edges ?? [])[0] as { to_agent: string; domain: string | null; note: string | null } | undefined;
          if (match) {
            const { humanRef, error: humanErr } = await fetchHumanRef(match.to_agent);
            if (humanErr) {
              return { content: [{ type: "text", text: `Error resolving target human_ref for "${match.to_agent}": ${humanErr}` }], isError: true };
            }
            return {
              content: [{ type: "text", text: JSON.stringify({ agent: agentSlug, domain, target: match.to_agent, source: "explicit", note: match.note, target_human_ref: humanRef }, null, 2) }],
            };
          }
          // Fallback: immediate reports_to.
          const { data: reportsTo, error: rtErr } = await db
            .from(ORG_EDGES_TABLE)
            .select("to_agent")
            .eq("from_agent", agentSlug)
            .eq("edge_type", "reports_to")
            .maybeSingle();
          if (rtErr) {
            return { content: [{ type: "text", text: `Error resolving escalation fallback: ${rtErr.message}` }], isError: true };
          }
          if (!reportsTo) {
            return {
              content: [{ type: "text", text: `Error: no explicit escalates_to edge for domain "${domain}" and no reports_to fallback for "${agentSlug}" (missing org data?)` }],
              isError: true,
            };
          }
          const fallbackTarget = (reportsTo as { to_agent: string }).to_agent;
          const { humanRef, error: humanErr } = await fetchHumanRef(fallbackTarget);
          if (humanErr) {
            return { content: [{ type: "text", text: `Error resolving target human_ref for "${fallbackTarget}": ${humanErr}` }], isError: true };
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ agent: agentSlug, domain, target: fallbackTarget, source: "fallback_reports_to", target_human_ref: humanRef }, null, 2) }],
          };
        }

        const edgeList = (edges ?? []) as { to_agent: string; domain: string | null; note: string | null }[];
        const toAgents = [...new Set(edgeList.map((e) => e.to_agent))];
        const humanRefBySlug = new Map<string, string | null>();
        if (toAgents.length > 0) {
          const { data: cardsData, error: cardsErr } = await db
            .from(ROLE_CARDS_TABLE)
            .select("agent_slug, human_ref")
            .in("agent_slug", toAgents);
          if (cardsErr) {
            return { content: [{ type: "text", text: `Error resolving target human_ref: ${cardsErr.message}` }], isError: true };
          }
          for (const c of (cardsData ?? []) as { agent_slug: string; human_ref: string }[]) {
            humanRefBySlug.set(c.agent_slug, c.human_ref);
          }
        }
        const enrichedEdges = edgeList.map((e) => ({ ...e, target_human_ref: humanRefBySlug.get(e.to_agent) ?? null }));
        return { content: [{ type: "text", text: JSON.stringify({ agent: agentSlug, escalation_edges: enrichedEdges }, null, 2) }] };
      }

      if (mode === "help") {
        let query = db
          .from(ORG_EDGES_TABLE)
          .select("to_agent, domain, note")
          .eq("from_agent", agentSlug)
          .eq("edge_type", "asks_help_from");
        if (domain) query = query.eq("domain", domain);
        const { data: edges, error } = await query;
        if (error) {
          return { content: [{ type: "text", text: `Error reading asks_help_from edges: ${error.message}` }], isError: true };
        }
        const edgeList = (edges ?? []) as { to_agent: string; domain: string | null; note: string | null }[];
        const toAgents = [...new Set(edgeList.map((e) => e.to_agent))];
        const humanRefBySlug = new Map<string, string | null>();
        if (toAgents.length > 0) {
          const { data: cardsData, error: cardsErr } = await db
            .from(ROLE_CARDS_TABLE)
            .select("agent_slug, human_ref")
            .in("agent_slug", toAgents);
          if (cardsErr) {
            return { content: [{ type: "text", text: `Error resolving target human_ref: ${cardsErr.message}` }], isError: true };
          }
          for (const c of (cardsData ?? []) as { agent_slug: string; human_ref: string }[]) {
            humanRefBySlug.set(c.agent_slug, c.human_ref);
          }
        }
        const enrichedEdges = edgeList.map((e) => ({ ...e, target_human_ref: humanRefBySlug.get(e.to_agent) ?? null }));
        return { content: [{ type: "text", text: JSON.stringify({ agent: agentSlug, domain: domain ?? null, help_edges: enrichedEdges }, null, 2) }] };
      }

      // mode === "card" (default)
      const { data: card, error: cardErr } = await db
        .from(ROLE_CARDS_TABLE)
        .select("mission, does, does_not, scope_notes, human_ref, updated_at")
        .eq("agent_slug", agentSlug)
        .maybeSingle();
      if (cardErr) {
        return { content: [{ type: "text", text: `Error reading role card: ${cardErr.message}` }], isError: true };
      }

      const { data: edges, error: edgesErr } = await db
        .from(ORG_EDGES_TABLE)
        .select("to_agent, edge_type, domain, note")
        .eq("from_agent", agentSlug);
      if (edgesErr) {
        return { content: [{ type: "text", text: `Error reading org edges: ${edgesErr.message}` }], isError: true };
      }

      const edgeRows = (edges ?? []) as { to_agent: string; edge_type: string; domain: string | null; note: string | null }[];
      const reportsTo = edgeRows.find((e) => e.edge_type === "reports_to")?.to_agent ?? null;
      const escalatesTo = edgeRows.filter((e) => e.edge_type === "escalates_to");
      const asksHelpFrom = edgeRows.filter((e) => e.edge_type === "asks_help_from");
      const cardHumanRef = card ? (card as { human_ref: string }).human_ref : null;

      if (!card && edgeRows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ agent: agentSlug, role_card: null, reports_to: null, human_ref: null, escalates_to: [], asks_help_from: [], note: "no org-registry data for this agent yet (F2 seed pending?)" }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                agent: agentSlug,
                role_card: card ?? null,
                reports_to: reportsTo,
                human_ref: cardHumanRef,
                escalates_to: escalatesTo,
                asks_help_from: asksHelpFrom,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --- gtd_overview ---
  server.tool(
    "gtd_overview",
    "Cross-agent GTD read (coordinator-only). Returns active GTD items across all agents — id, owner, title, gtd_status, priority, priority_rank, deadline, autopilot, autopilot_model. Restricted to loomy and loomy-assistant.",
    {
      gtd_status: GtdStatusSchema.optional().describe("Filter by GTD status (default: all except done/trash)"),
      owner: z.string().optional().describe("Filter by agent slug (default: all agents)"),
      priority: GtdPrioritySchema.optional().describe("Filter by priority"),
      autopilot: z.boolean().optional().describe("Filter by autopilot flag"),
      limit: z.number().int().min(1).max(200).optional().describe("Max items (default: 50)"),
    },
    async ({ gtd_status, owner, priority, autopilot, limit }) => {
      const COORDINATOR_SLUGS = ["loomy", "loomy-assistant"];
      if (!COORDINATOR_SLUGS.includes(selfSlug)) {
        return {
          content: [{ type: "text", text: `Access denied: gtd_overview is restricted to coordinator agents (${COORDINATOR_SLUGS.join(", ")}). Caller: ${selfSlug}` }],
          isError: true,
        };
      }

      const db = getSupabaseClient();
      let query = db
        .from(GTD_TABLE)
        .select("id, owner, title, gtd_status, priority, priority_rank, deadline, autopilot, autopilot_model")
        .order("priority_rank", { ascending: false })
        .order("deadline", { ascending: true, nullsFirst: false })
        .limit(limit ?? 50);

      if (gtd_status) {
        query = query.eq("gtd_status", gtd_status);
      } else {
        query = query.not("gtd_status", "in", "(done,trash)");
      }
      if (owner) query = query.eq("owner", owner);
      if (priority) query = query.eq("priority", priority);
      if (autopilot !== undefined) query = query.eq("autopilot", autopilot);

      const { data, error } = await query;
      if (error) {
        return {
          content: [{ type: "text", text: `Error reading GTD overview: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: (data ?? []).length === 0 ? "No GTD items found." : JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  // =========================================================================
  // Home Tools (home_* tables — family data for Evaristo / Home Assistant)
  // Scoped by HOME_FAMILY_ID + HOME_USER_ID env vars.
  // =========================================================================

  const homeFamily = process.env.HOME_FAMILY_ID;
  const homeUser = process.env.HOME_USER_ID;

  if (homeFamily && homeUser) {
    const HOME_SHOPPING_LISTS = "home_shopping_lists";
    const HOME_SHOPPING_ITEMS = "home_shopping_items";
    const HOME_SHOPPING_CATEGORIES = "home_shopping_categories";
    const HOME_WEEKLY_MENUS = "home_weekly_menus";
    const HOME_MENU_ITEMS = "home_menu_items";
    const HOME_SCHOOL_MENUS = "home_school_menus";

    const MealTypeSchema = z.enum(MEAL_TYPES);
    const MenuStatusSchema = z.enum(MENU_STATUSES);

    // Helper: translate FK violations on added_by/checked_by into actionable
    // error messages. These fields reference auth.users(id); the most common
    // misconfiguration is HOME_USER_ID pointing to a home_family_members(id)
    // or another table's pk instead of the real auth user_id (see D-017).
    function translateHomeFkError(message: string): string {
      const msg = message || "";
      const userPrefix = homeUser ? `${homeUser.substring(0, 8)}…` : "<unset>";
      if (/added_by|checked_by/i.test(msg) && /violat|foreign key/i.test(msg)) {
        return (
          `FK violation on added_by/checked_by — HOME_USER_ID (${userPrefix}) ` +
          `is not a valid auth.users(id). Fix: in the agent's .mcp.json set ` +
          `HOME_USER_ID to the Supabase auth user_id (NOT a family member_id ` +
          `or profile id). Original error: ${msg}`
        );
      }
      return msg;
    }

    // Helper: find or create active shopping list for the family
    async function resolveActiveList(): Promise<{ id: string } | { error: string }> {
      const db = getSupabaseClient();
      const { data: lists, error: listErr } = await db
        .from(HOME_SHOPPING_LISTS)
        .select("id")
        .eq("family_id", homeFamily!)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1);

      if (listErr) return { error: listErr.message };
      if (lists && lists.length > 0) return { id: (lists[0] as any).id };

      // Auto-create an active list
      const { data: newList, error: createErr } = await db
        .from(HOME_SHOPPING_LISTS)
        .insert({ family_id: homeFamily!, name: "Lista della spesa", is_active: true })
        .select("id")
        .maybeSingle();

      if (createErr) return { error: createErr.message };
      if (!newList) return { error: "Shopping list created but no row returned (RLS issue?). Retry home_grocery_add." };
      return { id: (newList as any).id };
    }

    // Helper: find or create weekly menu for the family
    async function resolveWeeklyMenu(weekStart: string): Promise<{ id: string } | { error: string }> {
      const db = getSupabaseClient();
      const { data: menus, error: menuErr } = await db
        .from(HOME_WEEKLY_MENUS)
        .select("id")
        .eq("family_id", homeFamily!)
        .eq("week_start", weekStart)
        .limit(1);

      if (menuErr) return { error: menuErr.message };
      if (menus && menus.length > 0) return { id: (menus[0] as any).id };

      const { data: newMenu, error: createErr } = await db
        .from(HOME_WEEKLY_MENUS)
        .insert({ family_id: homeFamily!, week_start: weekStart, status: "draft" })
        .select("id")
        .maybeSingle();

      if (createErr) return { error: createErr.message };
      if (!newMenu) return { error: "Weekly menu created but no row returned (RLS issue?). Retry home_menu_write." };
      return { id: (newMenu as any).id };
    }

    process.stderr.write(
      `[board-mcp] Home tools enabled (family=${homeFamily.substring(0, 8)}…, user=${homeUser.substring(0, 8)}…)\n`
    );
    process.stderr.write(
      `[board-mcp] Note: HOME_USER_ID must be a valid auth.users(id) — it's written into home_shopping_items.added_by / checked_by (see D-017)\n`
    );

    // --- home_grocery_categories ---
    server.tool(
      "home_grocery_categories",
      "List shopping categories for the family (use category IDs when adding items)",
      {},
      async () => {
        const db = getSupabaseClient();
        const { data, error } = await db
          .from(HOME_SHOPPING_CATEGORIES)
          .select("*")
          .eq("family_id", homeFamily!)
          .order("sort_order", { ascending: true });

        if (error) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }] };
      }
    );

    // --- home_grocery_list ---
    server.tool(
      "home_grocery_list",
      "List shopping items from the active grocery list",
      {
        list_id: z.string().uuid().optional().describe("Shopping list ID (default: active list)"),
        checked: z.boolean().optional().describe("Filter: true = purchased, false = pending"),
        limit: z.number().int().min(1).max(200).optional().describe("Max items (default: 100)"),
      },
      async ({ list_id, checked, limit }) => {
        const db = getSupabaseClient();

        let targetListId = list_id;
        if (!targetListId) {
          const result = await resolveActiveList();
          if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
          }
          targetListId = result.id;
        }

        let query = db
          .from(HOME_SHOPPING_ITEMS)
          .select("*")
          .eq("list_id", targetListId)
          .order("created_at", { ascending: false })
          .limit(limit ?? 100);

        if (checked !== undefined) {
          query = query.eq("is_checked", checked);
        }

        const { data, error } = await query;

        if (error) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: (data ?? []).length === 0
              ? "No shopping items found."
              : JSON.stringify(data, null, 2),
          }],
        };
      }
    );

    // --- home_grocery_add ---
    server.tool(
      "home_grocery_add",
      "Add an item to the shopping list",
      {
        product_name: z.string().min(1).describe("Product name"),
        quantity: z.number().optional().describe("Quantity (default: 1)"),
        unit: z.string().optional().describe("Unit of measure (default: 'pz'). Common: pz, kg, g, l, ml"),
        category_id: z.string().uuid().optional().describe("Shopping category ID (use home_grocery_categories to list)"),
        notes: z.string().optional().describe("Notes"),
        list_id: z.string().uuid().optional().describe("Shopping list ID (default: active list)"),
      },
      async ({ product_name, quantity, unit, category_id, notes, list_id }) => {
        const db = getSupabaseClient();

        let targetListId = list_id;
        if (!targetListId) {
          const result = await resolveActiveList();
          if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
          }
          targetListId = result.id;
        }

        const insertData: Record<string, unknown> = {
          list_id: targetListId,
          product_name,
          quantity: quantity ?? 1,
          unit: unit ?? "pz",
          added_by: homeUser!,
          is_checked: false,
        };
        if (category_id) insertData.category_id = category_id;
        if (notes) insertData.notes = notes;

        const { data, error } = await db
          .from(HOME_SHOPPING_ITEMS)
          .insert(insertData)
          .select("id, product_name, quantity, unit, created_at")
          .maybeSingle();

        if (error || !data) {
          return {
            content: [{ type: "text", text: `Error adding item: ${error ? translateHomeFkError(error.message) : "no row returned (RLS issue?). Check HOME_USER_ID is a valid auth.users(id) — see D-017."}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
      }
    );

    // --- home_grocery_update ---
    server.tool(
      "home_grocery_update",
      "Update a shopping item (quantity, checked status, etc.)",
      {
        id: z.string().uuid().describe("Shopping item ID"),
        product_name: z.string().min(1).optional().describe("New product name"),
        quantity: z.number().optional().describe("New quantity"),
        unit: z.string().optional().describe("New unit"),
        category_id: z.string().uuid().optional().describe("New category ID"),
        notes: z.string().optional().describe("New notes"),
        is_checked: z.boolean().optional().describe("Mark as purchased (true) or pending (false)"),
      },
      async ({ id, product_name, quantity, unit, category_id, notes, is_checked }) => {
        const db = getSupabaseClient();

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (product_name !== undefined) updates.product_name = product_name;
        if (quantity !== undefined) updates.quantity = quantity;
        if (unit !== undefined) updates.unit = unit;
        if (category_id !== undefined) updates.category_id = category_id;
        if (notes !== undefined) updates.notes = notes;
        if (is_checked !== undefined) {
          updates.is_checked = is_checked;
          if (is_checked) {
            updates.checked_at = new Date().toISOString();
            updates.checked_by = homeUser!;
          } else {
            updates.checked_at = null;
            updates.checked_by = null;
          }
        }

        const { data, error } = await db
          .from(HOME_SHOPPING_ITEMS)
          .update(updates)
          .eq("id", id)
          .select("id, product_name, quantity, unit, is_checked, updated_at")
          .maybeSingle();

        if (error) {
          return {
            content: [{ type: "text", text: `Error updating item: ${translateHomeFkError(error.message)}` }],
            isError: true,
          };
        }
        if (!data) {
          return {
            content: [{ type: "text", text: `Shopping item id='${id}' not found. Use home_grocery_list to check available items.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
      }
    );

    // --- home_grocery_remove ---
    server.tool(
      "home_grocery_remove",
      "Remove an item from the shopping list",
      {
        id: z.string().uuid().describe("Shopping item ID to remove"),
      },
      async ({ id }) => {
        const db = getSupabaseClient();
        const { data, error } = await (db as any)
          .from(HOME_SHOPPING_ITEMS)
          .delete()
          .eq("id", id)
          .select("id, product_name")
          .maybeSingle();

        if (error) {
          return { content: [{ type: "text", text: `Error removing item: ${error.message}` }], isError: true };
        }
        if (!data) {
          return { content: [{ type: "text", text: `Shopping item id='${id}' not found. Use home_grocery_list to check available items.` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed: data }, null, 2) }] };
      }
    );

    // --- home_menu_read ---
    server.tool(
      "home_menu_read",
      "Read the weekly family menu with all meal items. Returns menu metadata + items grouped by day.",
      {
        week_start: z.string().describe("Monday of the week (ISO date YYYY-MM-DD)"),
      },
      async ({ week_start }) => {
        const db = getSupabaseClient();

        // Find the weekly menu
        const { data: menus, error: menuErr } = await db
          .from(HOME_WEEKLY_MENUS)
          .select("*")
          .eq("family_id", homeFamily!)
          .eq("week_start", week_start)
          .limit(1);

        if (menuErr) {
          return { content: [{ type: "text", text: `Error: ${menuErr.message}` }], isError: true };
        }
        if (!menus || menus.length === 0) {
          return { content: [{ type: "text", text: `No menu found for week starting ${week_start}.` }] };
        }

        const menu = menus[0] as any;

        // Fetch all items for this menu
        const { data: items, error: itemErr } = await db
          .from(HOME_MENU_ITEMS)
          .select("*")
          .eq("menu_id", menu.id)
          .order("day_of_week", { ascending: true });

        if (itemErr) {
          return { content: [{ type: "text", text: `Error reading items: ${itemErr.message}` }], isError: true };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ menu, items: items ?? [] }, null, 2),
          }],
        };
      }
    );

    // --- home_menu_write ---
    server.tool(
      "home_menu_write",
      "Create or update a meal item in the weekly menu. Auto-creates the weekly menu if it doesn't exist.",
      {
        week_start: z.string().describe("Monday of the week (ISO date YYYY-MM-DD)"),
        id: z.string().uuid().optional().describe("Menu item ID — provide to UPDATE an existing item, omit to INSERT"),
        day_of_week: z.number().int().min(1).max(7).describe("ISO day: 1=Mon, 2=Tue, … 7=Sun"),
        meal_type: MealTypeSchema.describe("Meal type"),
        dish_name: z.string().min(1).describe("Dish/meal name"),
        ingredients: z.any().optional().describe("Ingredients (JSONB)"),
        member_ids: z.array(z.string().uuid()).optional().describe("Family members this meal is for"),
        guest_names: z.array(z.string()).optional().describe("Guest names (free text)"),
        notes: z.string().optional().describe("Notes"),
        covered_by_school: z.boolean().optional().describe("Meal provided by school (default: false)"),
      },
      async ({ week_start, id, day_of_week, meal_type, dish_name, ingredients, member_ids, guest_names, notes, covered_by_school }) => {
        const db = getSupabaseClient();

        if (id) {
          // UPDATE existing item
          const updates: Record<string, unknown> = {};
          if (day_of_week !== undefined) updates.day_of_week = day_of_week;
          if (meal_type !== undefined) updates.meal_type = meal_type;
          if (dish_name !== undefined) updates.dish_name = dish_name;
          if (ingredients !== undefined) updates.ingredients = ingredients;
          if (member_ids !== undefined) updates.member_ids = member_ids;
          if (guest_names !== undefined) updates.guest_names = guest_names;
          if (notes !== undefined) updates.notes = notes;
          if (covered_by_school !== undefined) updates.covered_by_school = covered_by_school;

          const { data, error } = await db
            .from(HOME_MENU_ITEMS)
            .update(updates)
            .eq("id", id)
            .select("id, day_of_week, meal_type, dish_name")
            .maybeSingle();

          if (error) {
            return { content: [{ type: "text", text: `Error updating menu item: ${error.message}` }], isError: true };
          }
          if (!data) {
            return { content: [{ type: "text", text: `Menu item id='${id}' not found. Use home_menu_read(week_start) to list items for the week.` }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "updated", ...data }, null, 2) }] };
        }

        // INSERT — ensure weekly menu exists
        const menuResult = await resolveWeeklyMenu(week_start);
        if ("error" in menuResult) {
          return { content: [{ type: "text", text: `Error: ${menuResult.error}` }], isError: true };
        }

        const insertData: Record<string, unknown> = {
          menu_id: menuResult.id,
          day_of_week,
          meal_type,
          dish_name,
          covered_by_school: covered_by_school ?? false,
        };
        if (ingredients !== undefined) insertData.ingredients = ingredients;
        if (member_ids) insertData.member_ids = member_ids;
        if (guest_names) insertData.guest_names = guest_names;
        if (notes) insertData.notes = notes;

        const { data, error } = await db
          .from(HOME_MENU_ITEMS)
          .insert(insertData)
          .select("id, day_of_week, meal_type, dish_name, created_at")
          .maybeSingle();

        if (error || !data) {
          return { content: [{ type: "text", text: `Error creating menu item: ${error?.message ?? "no row returned (RLS issue?). Retry home_menu_write."}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "created", menu_id: menuResult.id, ...data }, null, 2) }] };
      }
    );

    // --- home_school_menu_read ---
    server.tool(
      "home_school_menu_read",
      "Read school lunch menus for a family member (child). Returns entries for a given week.",
      {
        member_id: z.string().uuid().describe("Family member ID (child)"),
        week_start: z.string().optional().describe("Monday of the week (ISO date YYYY-MM-DD). Default: all available."),
        limit: z.number().int().min(1).max(100).optional().describe("Max entries (default: 50)"),
      },
      async ({ member_id, week_start, limit }) => {
        const db = getSupabaseClient();

        let query = db
          .from(HOME_SCHOOL_MENUS)
          .select("*")
          .eq("family_id", homeFamily!)
          .eq("member_id", member_id)
          .order("week_start", { ascending: false })
          .order("day_of_week", { ascending: true })
          .limit(limit ?? 50);

        if (week_start) {
          query = query.eq("week_start", week_start);
        }

        const { data, error } = await query;

        if (error) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: (data ?? []).length === 0
              ? "No school menu entries found."
              : JSON.stringify(data, null, 2),
          }],
        };
      }
    );
  } else {
    process.stderr.write(
      "[board-mcp] Home tools disabled (HOME_FAMILY_ID/HOME_USER_ID not set)\n"
    );
  }

  // =========================================================================
  // Work Item Tools (loomx_work_items — governance-compliance D-024)
  // =========================================================================

  const WiStatusSchema = z.enum([
    "active",
    "paused",
    "done",
    "emergency",
    "exempt",
    "failed",
  ]);
  const WiEndStatusSchema = z.enum(WI_END_STATUSES);
  const WiLayerSchema = z.enum(WI_TEMPLATE_LAYERS);

  const toText = <T,>(res: import("./wi.js").WiResult<T>) => {
    if (!res.ok) {
      return {
        content: [{ type: "text" as const, text: `Error: ${res.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ok: true, ...res.data }, null, 2) },
      ],
    };
  };

  // D-118: slugToCode/codeToSlug let wi.ts's inbox-pending guard (a+) and
  // auto-set waiting_on heuristic (a) query board_messages (keyed by agent
  // code) without duplicating the registry lookup.
  const wiCtx = { selfSlug, isLoomy, slugToCode, codeToSlug };

  // --- wi_start ---
  server.tool(
    "wi_start",
    "Open a new Work Item. If gtd_item_id is given, the linked GTD moves to in_progress; otherwise a GTD is auto-created with owner=agent_slug and title=intent. " +
      "template_name is soft-warn validated against the WI templates catalog when WI_TEMPLATES_PATH is configured (template_warning in response) — never blocks (grace period, GTD f67f9524).",
    {
      intent: z.string().min(1).describe("Human-readable intent (becomes GTD title if none provided)"),
      agent_slug: z.string().optional().describe(`Agent slug (default: ${selfSlug}). Only loomy can open for another agent.`),
      gtd_item_id: z.string().uuid().optional().describe("Existing GTD to link (else auto-create)"),
      template_name: z.string().optional().describe("Template name (e.g. fix-bug, menu-plan)"),
      template_version: z.string().optional().describe("Template version (semver)"),
      template_layer: WiLayerSchema.optional().describe("Override layer — L1/L2/on-the-fly"),
      pre_conditions: z.record(z.any()).optional().describe("JSONB pre-conditions state"),
      session_id: z.string().optional().describe("Session tag for multi-WI correlation"),
    },
    async (args) => {
      const { wiStart } = await import("./wi.js");
      const { syncWiCache } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiStart(db, args, wiCtx);
      if (res.ok) await syncWiCache(db, args.agent_slug ?? selfSlug);
      return toText(res);
    }
  );

  // --- wi_end ---
  server.tool(
    "wi_end",
    [
      "Close a Work Item. status='done'|'failed'|'waiting'. GTD status cascades (done→done, waiting→waiting, failed→next_action).",
      "'waiting' maps to WI.status='paused' (DB CHECK constraint — see CLAUDE.md WI section).",
      "Phase 1 D-074 gate (REQ-033): durable WIs (non-ephemeral template) closing as 'done' require ≥1 REQ/SDES/decision linked via doc_item_wi_links (decision covers governance/coordination WIs whose durable output is itself a decision).",
      "Use force_ephemeral=true to bypass (audit-logged). Phase 1 D-074: arm_gtd_ids arms follow-on GTDs post-close (soft-warn). GTD 6bbc293b: arming preserves an existing autopilot_model, fills it from arm_gtd_model when absent, and otherwise warns explicitly (never a silent undispatchable arm). platform_contribution triggers pull enabler D-045.",
    ].join(" "),
    {
      wi_id: z.string().uuid().describe("Work Item id"),
      status: WiEndStatusSchema.describe("End keyword: done | failed | waiting"),
      failure_reason: z.string().optional().describe("Required when status=failed"),
      post_conditions_state: z.record(z.any()).optional().describe("JSONB post-conditions result"),
      side_effects_pending: z.array(z.any()).optional().describe("Side-effects queued for skill v2 executor"),
      resume_hint: z.string().optional().describe("Written to the linked GTD — most useful when status=waiting so the agent knows where to resume"),
      // Phase 1 D-074 additions:
      force_ephemeral: z.boolean().optional().describe("[D-074 gate bypass] Skip durable gate — use when WI has no durable artifacts (on-the-fly, session tasks). Must include force_reason."),
      force_reason: z.string().optional().describe("Audit context for force_ephemeral (required when force_ephemeral=true)"),
      arm_gtd_ids: z.array(z.string().uuid()).optional().describe("[D-074 REQ-034] GTD UUIDs to set autopilot=true after close (two-phase arm D-069). Soft-warns on mismatch, and on any armed GTD left without a dispatchable autopilot_model (GTD 6bbc293b)."),
      arm_gtd_model: z.string().optional().describe("[GTD 6bbc293b] Fallback autopilot_model applied only to armed GTDs that don't already have one — never overwrites an existing model."),
      post_runtime_request: z.enum(["continue", "clear", "kill", "model", "none"]).optional().describe("[D-074 REQ-034] Write to loomx_agent_runtime after close (optional; alternative to separate runtime_request call)."),
      platform_contribution: z.string().optional().describe("[D-074 REQ-035 / D-045] Content to share with forge (dev-*) or atlas (analyst-*) as platform contribution. Opt-in."),
    },
    async (args) => {
      const { wiEnd } = await import("./wi.js");
      const { syncWiCache, archiveWiToHistory } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiEnd(db, args, wiCtx);
      if (res.ok) {
        await archiveWiToHistory(db, args.wi_id);
        await syncWiCache(db, selfSlug);

        // Pull enabler D-045 (REQ-035): auto-send platform contribution to forge/atlas.
        // Handled here (not in wi.ts) so the agent registry is available.
        const contrib = res.data.platform_contribution_pending;
        if (contrib && args.status === "done") {
          const target: string | null = selfSlug.startsWith("dev-")
            ? "forge"
            : selfSlug.startsWith("analyst-")
            ? "atlas"
            : null;
          const targetCode = target ? slugToCode.get(target) : undefined;
          if (targetCode !== undefined) {
            const BOARD_MSG_TABLE = "board_messages";
            await db.from(BOARD_MSG_TABLE).insert({
              from_agent: selfCode,
              to_agent: targetCode,
              type: "info",
              subject: `[platform contribution] ${selfSlug}`,
              body: contrib,
              status: "pending",
            });
            (res.data as unknown as Record<string, unknown>).platform_contribution_sent = true;
          }
        }
      }
      return toText(res);
    }
  );

  // --- wi_status ---
  server.tool(
    "wi_status",
    "Return the currently active WI for an agent (default: self).",
    {
      agent_slug: z.string().optional().describe(`Agent slug (default: ${selfSlug})`),
    },
    async (args) => {
      const { wiStatus } = await import("./wi.js");
      const db = getSupabaseClient();
      return toText(await wiStatus(db, args, wiCtx));
    }
  );

  // --- wi_query ---
  server.tool(
    "wi_query",
    `Query WIs with optional filters. ${isLoomy ? "As loomy you see all agents." : "Filtered to your own WIs."}`,
    {
      agent_slug: z.string().optional().describe("Filter by agent (loomy only; other agents are auto-filtered to self)"),
      status: WiStatusSchema.optional().describe("Filter by lifecycle status"),
      template_name: z.string().optional().describe("Filter by template"),
      since: z.string().optional().describe("ISO timestamp — only WIs started at/after this time"),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default: 50)"),
    },
    async (args) => {
      const { wiQuery } = await import("./wi.js");
      const db = getSupabaseClient();
      return toText(await wiQuery(db, args, wiCtx));
    }
  );

  // --- wi_checkpoint ---
  server.tool(
    "wi_checkpoint",
    "Append a mid-flight checkpoint: merge files_touched, increment tool_use_count, stamp notes. Bumps last_checkpoint_at.",
    {
      wi_id: z.string().uuid().describe("Work Item id"),
      files_touched_delta: z.array(z.string()).optional().describe("Files to append to files_touched (deduped)"),
      tool_use_count: z.number().int().nonnegative().optional().describe("Tool uses to add to the running total"),
      notes: z.string().optional().describe("Freeform checkpoint note"),
    },
    async (args) => {
      const { wiCheckpoint } = await import("./wi.js");
      const { syncWiCache } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiCheckpoint(db, args, wiCtx);
      if (res.ok) await syncWiCache(db, selfSlug);
      return toText(res);
    }
  );

  // --- wi_link_template ---
  server.tool(
    "wi_link_template",
    "Attach or change template metadata on an existing WI. template_layer is derived from the name when not provided.",
    {
      wi_id: z.string().uuid().describe("Work Item id"),
      template_name: z.string().min(1).describe("Template name"),
      template_version: z.string().min(1).describe("Template version"),
      template_layer: WiLayerSchema.optional().describe("Override layer (else derived)"),
    },
    async (args) => {
      const { wiLinkTemplate } = await import("./wi.js");
      const { syncWiCache } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiLinkTemplate(db, args, wiCtx);
      if (res.ok) await syncWiCache(db, selfSlug);
      return toText(res);
    }
  );

  // --- wi_pause ---
  server.tool(
    "wi_pause",
    "Pause the active WI (frees the one-active slot for the agent). Optionally propagates resume_hint and block_scope to the linked GTD.",
    {
      wi_id: z.string().uuid().describe("Work Item id"),
      resume_hint: z.string().optional().describe("Hint written to the linked GTD — picked up by the agent on next evocation"),
      block_scope: z.string().optional().describe("Scope constraint written to the linked GTD for autopilot dispatch (e.g. 'dns', 'grocery')"),
    },
    async (args) => {
      const { wiPause } = await import("./wi.js");
      const { syncWiCache } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiPause(db, args, wiCtx);
      if (res.ok) await syncWiCache(db, selfSlug);
      return toText(res);
    }
  );

  // --- wi_resume ---
  server.tool(
    "wi_resume",
    "Resume a paused WI. Fails if another active WI already exists for the agent.",
    { wi_id: z.string().uuid().describe("Work Item id") },
    async (args) => {
      const { wiResume } = await import("./wi.js");
      const { syncWiCache } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiResume(db, args, wiCtx);
      if (res.ok) await syncWiCache(db, selfSlug);
      return toText(res);
    }
  );

  // --- wi_switch ---
  server.tool(
    "wi_switch",
    "Close the current active WI (status=done, auto_closed_by_switch) and open a new one. Explicit scope change — forces the agent to acknowledge the context shift.",
    {
      old_wi_id: z.string().uuid().describe("WI id to close"),
      new_intent: z.string().min(1).describe("Intent for the new WI"),
      new_template: z.string().optional().describe("Template name"),
      new_template_version: z.string().optional().describe("Template version"),
      new_template_layer: WiLayerSchema.optional().describe("Template layer"),
    },
    async (args) => {
      const { wiSwitch } = await import("./wi.js");
      const { syncWiCache, archiveWiToHistory } = await import("./wiCache.js");
      const db = getSupabaseClient();
      const res = await wiSwitch(db, args, wiCtx);
      if (res.ok) {
        await archiveWiToHistory(db, args.old_wi_id);
        await syncWiCache(db, selfSlug);
      }
      return toText(res);
    }
  );

  // --- runtime_request ---
  server.tool(
    "runtime_request",
    "Write a control-plane lifecycle request on a loomx_agent_runtime row (D-058, D-059). By default writes to this agent's own row. Broker (loomy-assistant) and loomy can pass agent_slug to write on behalf of another agent (fallback-stall D-058). The reconciler (dev-hq) reads it and acts deterministically. Semantics: continue = lightweight, context <65%, want next task in-place WITHOUT /clear (warm cache); clear = saturated ≥65% or cache unhelpful → /clear then next task; kill = queue empty or done → close window; model = switch to requested_model; none = cancel pending request.",
    {
      request: z.enum(RUNTIME_REQUEST_TYPES).describe("continue = context <65%, next task in-place (no /clear); clear = context ≥65%, /clear then next task; kill = stop/queue empty; model = switch model (requires requested_model); none = cancel pending"),
      requested_model: z.string().optional().describe("Target model slug — required when request=model (e.g. 'sonnet', 'opus', 'haiku')"),
      agent_slug: z.string().optional().describe("Target agent slug — broker/loomy only. Writes request on behalf of another agent (fallback-stall). Non-broker callers get an error if they try to use this."),
    },
    async ({ request, requested_model, agent_slug }) => {
      if (request === "model" && !requested_model) {
        return {
          content: [{ type: "text", text: "Error: requested_model is required when request=model" }],
          isError: true,
        };
      }

      // Determine target: broker/loomy can override via agent_slug
      let targetSlug = selfSlug;
      if (agent_slug && agent_slug !== selfSlug) {
        if (!(isLoomy || isBroker)) {
          return {
            content: [{ type: "text", text: `Error: only loomy or loomy-assistant can write runtime_request for another agent. Omit agent_slug to write your own row.` }],
            isError: true,
          };
        }
        if (!(await ensureAgentKnown(agent_slug))) {
          return {
            content: [{ type: "text", text: `Error: unknown agent slug "${agent_slug}". Valid: ${[...slugToCode.keys()].join(", ")}` }],
            isError: true,
          };
        }
        targetSlug = agent_slug;
      }

      const db = getSupabaseClient();

      // D-118 (GTD 41853607) model-switch contract guards — gated behind
      // LOOMX_MODEL_GUARDS_ENABLED (eval-first, same discipline as the
      // reply-wake guards). OFF by default: computed and logged, never
      // blocking or added to the response, until the E2E-MODEL suite is
      // green. Needs the pre-write row (mode + model_current) to decide.
      let costNotice: string | undefined;
      if (request === "model" && requested_model) {
        const { data: preRow, error: preErr } = await db
          .from(RUNTIME_TABLE)
          .select("mode, model_current")
          .eq("owner_slug", targetSlug)
          .maybeSingle();
        if (preErr) {
          return {
            content: [{ type: "text", text: `Error reading runtime row for '${targetSlug}': ${preErr.message}` }],
            isError: true,
          };
        }
        if (!preRow) {
          return {
            content: [{
              type: "text",
              text: `No runtime row found for agent '${targetSlug}'. The agent must register a heartbeat before runtime_request can be used. Check loomx_agent_runtime to verify the row exists.`,
            }],
            isError: true,
          };
        }
        const preMode = (preRow as Record<string, unknown>).mode as string | null;
        const preModelCurrent = (preRow as Record<string, unknown>).model_current as string | null;

        const haikuBlock = buildHaikuAutopilotBlock({ requestedModel: requested_model, targetMode: preMode });
        if (haikuBlock) {
          if (modelGuardsEnabled()) {
            return { content: [{ type: "text", text: `Error: ${haikuBlock}` }], isError: true };
          }
          process.stderr.write(`[runtime_request][dry-run] would-reject: ${haikuBlock}\n`);
        }

        const notice = buildModelCostNotice({ currentModel: preModelCurrent, requestedModel: requested_model });
        if (notice) {
          if (modelGuardsEnabled()) {
            costNotice = notice;
          } else {
            process.stderr.write(`[runtime_request][dry-run] would-notice: ${notice}\n`);
          }
        }
      }

      const payload: Record<string, unknown> = { request };
      payload.requested_model = request === "model" ? requested_model! : null;

      const { data, error } = await db
        .from(RUNTIME_TABLE)
        .update(payload)
        .eq("owner_slug", targetSlug)
        .select("owner_slug, request, requested_model")
        .maybeSingle();

      if (error) {
        // E2E-MODEL-02/10: never surface a raw DB constraint violation —
        // wrap it so the caller gets an actionable message even if the
        // allowed request/requested_model set drifts from this tool's enum.
        const isConstraintViolation = /constraint/i.test(error.message);
        const text = isConstraintViolation
          ? `Error: valore non ammesso per la scrittura su loomx_agent_runtime (constraint violation) — ${error.message}`
          : `Error writing runtime request: ${error.message}`;
        return {
          content: [{ type: "text", text }],
          isError: true,
        };
      }
      if (!data) {
        return {
          content: [{
            type: "text",
            text: `No runtime row found for agent '${targetSlug}'. The agent must register a heartbeat before runtime_request can be used. Check loomx_agent_runtime to verify the row exists.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            ...(costNotice ? { cost_notice: costNotice } : {}),
            agent: targetSlug,
            request: (data as Record<string, unknown>).request,
            requested_model: (data as Record<string, unknown>).requested_model ?? null,
          }, null, 2),
        }],
      };
    }
  );

  // --- runtime_status ---
  const RUNTIME_STATUS_COLUMNS =
    "owner_slug, mode, request, requested_model, model_current, context_pct, rate_5h_pct, rate_7d_pct, heartbeat_at, coordinator_active";

  server.tool(
    "runtime_status",
    "Read-only view of loomx_agent_runtime (D-058 stall-triage telemetry). Without agent_slug returns the whole fleet (ordered by heartbeat_at desc); with agent_slug returns a single row. Fields: mode, request, requested_model, model_current, context_pct, rate_5h_pct, rate_7d_pct, heartbeat_at, coordinator_active. Anyone can read their own row; loomy and loomy-assistant (broker) can read any row or the full fleet.",
    {
      agent_slug: z.string().optional().describe("Target agent slug. Omit for the full fleet (loomy/broker only) or to read your own row."),
    },
    async ({ agent_slug }) => {
      const db = getSupabaseClient();

      if (!agent_slug) {
        if (isLoomy || isBroker) {
          const { data, error } = await db
            .from(RUNTIME_TABLE)
            .select(RUNTIME_STATUS_COLUMNS)
            .order("heartbeat_at", { ascending: false, nullsFirst: false });
          if (error) {
            return { content: [{ type: "text", text: `Error reading runtime status: ${error.message}` }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, rows: data ?? [] }, null, 2) }] };
        }
        agent_slug = selfSlug;
      }

      if (agent_slug !== selfSlug && !(isLoomy || isBroker)) {
        return {
          content: [{ type: "text", text: `Error: only loomy or loomy-assistant can read another agent's runtime row. Omit agent_slug to read your own.` }],
          isError: true,
        };
      }
      if (!(await ensureAgentKnown(agent_slug))) {
        return {
          content: [{ type: "text", text: `Error: unknown agent slug "${agent_slug}". Valid: ${[...slugToCode.keys()].join(", ")}` }],
          isError: true,
        };
      }

      const { data, error } = await db
        .from(RUNTIME_TABLE)
        .select(RUNTIME_STATUS_COLUMNS)
        .eq("owner_slug", agent_slug)
        .maybeSingle();
      if (error) {
        return { content: [{ type: "text", text: `Error reading runtime status: ${error.message}` }], isError: true };
      }
      if (!data) {
        return {
          content: [{ type: "text", text: `No runtime row found for agent '${agent_slug}'. The agent must register a heartbeat first.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
    }
  );

  // =========================================================================
  // Ping (cross-agent cold-start wake, D-093 — hooked on board_send/board_ack)
  // Supersedes the separate-table build (loomx_agent_pings, D-092/dev-hq):
  // Loomy ratified the pivot (msg 58c130be) — no dedicated storage/inbox.
  // `ping` is a thin alias over board_send carrying wake_priority; there is
  // no ping_inbox/ping_ack tool — use board_inbox(wake_only=true) / board_ack.
  // Design: hub/it-manager/design/ping-cold-start.md.
  // =========================================================================

  // --- ping ---
  server.tool(
    "ping",
    "Ergonomic alias for board_send(type='info', wake_priority=priority) — NOT a separate storage/tool (D-093). Sends a lightweight cross-agent message marked for cold-start wake. ANY priority (normal included, D-099) asks the reconciler to cold-wake a sleeping target — priority only orders the wake queue (urgent>high>normal). Use board_ack to close it, board_inbox(wake_only=true) to list wake-marked messages.",
    {
      target_agent: z.string().min(1).describe("Recipient agent slug"),
      message: z.string().min(1).describe("Ping message"),
      priority: WakePrioritySchema.optional().describe("Wake priority (default: normal). Any priority cold-wakes the target via the reconciler — priority only orders the wake queue (urgent>high>normal), it doesn't gate whether the wake happens (D-099)."),
      requested_model: z.string().optional().describe(
        "D-098: model to launch the target with on this cold-wake (e.g. 'sonnet', 'opus', 'fable'). Omit = no preference (reconciler falls back to Sonnet; never Haiku in autopilot, §0quater)."
      ),
    },
    async ({ target_agent, message, priority, requested_model }) => {
      const validationError = await validateRecipientSlug(target_agent);
      if (validationError) {
        return { content: [{ type: "text", text: `Error: ${validationError}` }], isError: true };
      }

      const toCode = slugToCode.get(target_agent)!;
      const db = getSupabaseClient();
      const { data, error } = await db
        .from(TABLE)
        .insert({
          from_agent: selfCode,
          to_agent: toCode,
          type: "info",
          subject: `[ping] ${message.slice(0, 80)}`,
          body: message,
          summary: null,
          tags: [],
          ref_id: null,
          status: "pending",
          wake_priority: priority ?? "normal",
          ...(requested_model !== undefined ? { requested_model } : {}),
        })
        .select("id, created_at")
        .maybeSingle();

      if (error || !data) {
        return {
          content: [
            { type: "text", text: `Error sending ping: ${error?.message ?? "no row returned (RLS?). Retry ping with the same args."}` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: data.id, created_at: data.created_at }, null, 2) }] };
    }
  );

  // =========================================================================
  // Eval Tools (loomx_eval_runs — D-105 attribution gap, GTD 289954a0)
  // dba applied loomx_evals/loomx_eval_runs 1:1 with D-105 (migration
  // 20260729020000) but flagged that "owner writes their own runs" isn't
  // enforceable at DB-floor: every agent but loomy writes via literal
  // service_role, which bypasses RLS by definition (D-084). The real
  // enforcement lands here: eval_run_add always sets triggered_by from
  // selfSlug (native-role identity where D-084 has rolled out, --agent
  // identity otherwise) instead of trusting a self-declared field. Only
  // loomy may override it (matches the cross-owner INSERT grant dba already
  // gave loomy on this table for coordination).
  // =========================================================================

  const EVALS_TABLE = "loomx_evals";
  const EVAL_RUNS_TABLE = "loomx_eval_runs";
  const EVAL_VERDICTS = ["pass", "fail", "advisory", "not_run"] as const;

  server.tool(
    "eval_run_add",
    "Record a run in loomx_eval_runs (D-105). triggered_by is never taken as free text from the caller — it is always your own agent identity (selfSlug). Only loomy may attribute a run to a different agent. Link the run via eval_id (uuid) or eval_code (loomx_evals.code, resolved server-side).",
    {
      eval_id: z.string().uuid().optional().describe("UUID of the loomx_evals row. Omit if passing eval_code."),
      eval_code: z.string().optional().describe("loomx_evals.code — resolved to eval_id server-side. Omit if passing eval_id."),
      area: z.string().optional(),
      behavior: z.string().optional(),
      model: z.string().min(1).describe("Model under test (NOT NULL in schema)"),
      judge_model: z.string().optional(),
      score: z.number().optional(),
      verdict: z.enum(EVAL_VERDICTS).optional().describe("pass | fail | advisory | not_run"),
      comment: z.string().optional(),
      scenario_ref: z.string().optional(),
      actual_ref: z.string().optional(),
      eval_version: z.string().optional(),
      git_sha: z.string().optional(),
      tokens: z.number().int().optional(),
      triggered_by: z.string().optional().describe("Attribution override — loomy only. Any other caller gets an error if this differs from their own slug; omit to default to yourself."),
    },
    async ({ eval_id, eval_code, area, behavior, model, judge_model, score, verdict, comment, scenario_ref, actual_ref, eval_version, git_sha, tokens, triggered_by }) => {
      if (triggered_by && triggered_by !== selfSlug && !isLoomy) {
        return {
          content: [{ type: "text", text: `Error: only loomy can attribute a run to another agent (triggered_by="${triggered_by}"). You can only record runs as yourself ("${selfSlug}") — omit triggered_by.` }],
          isError: true,
        };
      }
      if (!eval_id && !eval_code) {
        return { content: [{ type: "text", text: "Error: pass eval_id or eval_code to link the run to a loomx_evals row." }], isError: true };
      }

      const db = getSupabaseClient();
      let resolvedEvalId = eval_id ?? null;

      if (!resolvedEvalId && eval_code) {
        const { data, error } = await db.from(EVALS_TABLE).select("id").eq("code", eval_code).maybeSingle();
        if (error) {
          return { content: [{ type: "text", text: `Error resolving eval_code "${eval_code}": ${error.message}` }], isError: true };
        }
        if (!data) {
          return { content: [{ type: "text", text: `Error: no loomx_evals row with code "${eval_code}".` }], isError: true };
        }
        resolvedEvalId = (data as { id: string }).id;
      }

      const payload: Record<string, unknown> = {
        eval_id: resolvedEvalId,
        area: area ?? null,
        behavior: behavior ?? null,
        model,
        judge_model: judge_model ?? null,
        score: score ?? null,
        verdict: verdict ?? null,
        comment: comment ?? null,
        scenario_ref: scenario_ref ?? null,
        actual_ref: actual_ref ?? null,
        eval_version: eval_version ?? null,
        git_sha: git_sha ?? null,
        tokens: tokens ?? null,
        triggered_by: triggered_by ?? selfSlug,
      };

      const { data, error } = await db
        .from(EVAL_RUNS_TABLE)
        .insert(payload)
        .select("id, eval_id, triggered_by, run_at")
        .maybeSingle();

      if (error || !data) {
        return {
          content: [{ type: "text", text: `Error recording eval run: ${error?.message ?? "no row returned (RLS?). Retry with the same args."}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
    }
  );

  // =========================================================================
  // Document model Tools (documents / doc_items / links — D-a5 §7 / §16)
  // Self-describing for Haiku: copy-pasteable examples, sensible defaults
  // (status auto, sort_order append), actionable errors. doc_item_types is the
  // primary how-to surface (introspect schema + example per type).
  // =========================================================================

  const docCtx = { selfSlug, isLoomy };
  const DOC_TYPES_LIST = DB_DOCUMENT_TYPES.join(", ");
  const ITEM_TYPES_LIST = DB_ITEM_TYPES.join(", ");
  const DOC_LINK_TYPES_LIST = DB_DOC_ITEM_LINK_TYPES.join(", ");

  // D-a5 F4.5 — every doc_* call runs under the doc_rw role with this agent's slug
  // bound via loomx_set_agent_slug() (SECURITY DEFINER, never user input) so RLS (D-015)
  // is enforced at DB-floor. No doc_rw backend configured → the call refuses (no service_role bypass).
  const runDocTool = async (fn: (db: any) => Promise<{ ok: boolean; error?: string; data?: unknown }>) => {
    const { runDocRw } = await import("./docDb.js");
    try {
      return toText(await runDocRw(selfSlug, (db) => fn(db)) as any);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  };

  // --- doc_create ---
  server.tool(
    "doc_create",
    `Create a governance document (header; content lives in doc_items). document_type ∈ {${DOC_TYPES_LIST}}. ` +
      `Defaults: status=draft, version=1.0, visibility=project (conservative D-015), owner=you. ` +
      `Example: doc_create({project_id:"<uuid>", document_type:"req", title:"Requirements — MyApp"}). ` +
      `Then add rows with doc_item_upsert. Call doc_item_types to discover each type's item_types + attrs schema.`,
    {
      project_id: z.string().uuid().describe("Owning project (loomx_projects.id) — pinned, never inferred"),
      document_type: z.string().describe(`Document type: ${DOC_TYPES_LIST}`),
      title: z.string().min(1).describe("Human title"),
      owner: z.string().optional().describe(`Owner agent slug (default: ${selfSlug})`),
      status: z.string().optional().describe("draft|in_review|approved|active|superseded|archived|deprecated (default: draft)"),
      version: z.string().optional().describe("Document version (default: 1.0)"),
      visibility: z.enum(["project", "team", "org"]).optional().describe("project (default, conservative) | team | org (broad, cross-client templates)"),
    },
    async (args) => {
      const { docCreate } = await import("./docs.js");
      return runDocTool((db) => docCreate(db, args, docCtx));
    }
  );

  // --- doc_item_upsert ---
  server.tool(
    "doc_item_upsert",
    `Insert or update a typed row of a document. IDEMPOTENT and RETURNS the item UUID. ` +
      `Idempotency key: (project_id, code) for coded items; else (document_id, client_token) or (document_id, sort_order). ` +
      `DOCUMENT DEDUCED FROM CODE (GTD 4a591cfe): when the code already exists in the project, document_id is OPTIONAL — ` +
      `the row is updated on the document it actually lives on; a document_id that disagrees with the row comes back as a ` +
      `warning (the row is neither moved nor duplicated). Creating a NEW row still requires document_id. ` +
      `The response always carries document_id = where the row actually lives. ` +
      `UPDATE IS A PATCH: every optional field you OMIT is left untouched — attrs and status included. ` +
      `A field you DO pass is written, and attrs is REPLACED wholesale (never merged), so re-pass every key you want to keep; ` +
      `pass attrs:{} to empty it on purpose. Dropped attrs keys and in-place item_type changes come back in 'warnings'; ` +
      `the response also reports fields_written / fields_preserved, and the row is re-read and compared before answering ok. ` +
      `attrs is validated against the item_type's JSON-Schema (call doc_item_types('<item_type>') for schema + example). ` +
      `Insert-only defaults: status=type default (usually draft), sort_order=append. item_type ∈ {${ITEM_TYPES_LIST}}. ` +
      `Example: doc_item_upsert({project_id:"<uuid>", document_id:"<uuid>", item_type:"requirement", code:"REQ-001", body:"The system must…", attrs:{moscow:"must", acceptance_criteria:["x"]}}).`,
    {
      project_id: z.string().uuid().describe("Must equal the document's project (anti-divergence FK)"),
      document_id: z.string().uuid().optional().describe("Parent document (from doc_create). Optional when `code` already exists in the project — deduced from the row. Required to create a new row."),
      item_type: z.string().describe(`Item type: ${ITEM_TYPES_LIST}`),
      code: z.string().optional().describe("Per-project code (e.g. REQ-001). Omit for prose/exec items. Idempotency key when present."),
      body: z.string().optional().describe("Markdown content of the item. Omit on update = keep the stored body."),
      status: z.string().optional().describe("Per-item_type status. Omit on update = keep the stored status (the type default applies to INSERT only). doc_item_types shows allowed values."),
      owner: z.string().optional().describe(`Owner slug (insert default: ${selfSlug}). Omit on update = keep the stored owner.`),
      priority: z.string().optional().describe("Free-text priority tag. Omit on update = keep the stored priority."),
      sort_order: z.number().int().optional().describe("Position in the document (insert default: append). Omit on update = keep the stored position. Idempotency key for code-less items."),
      attrs: z.record(z.any()).optional().describe("Type-specific structured fields — validated vs JSON-Schema (see doc_item_types). Omit on update = keep the stored attrs UNTOUCHED; pass it and it REPLACES the stored object wholesale (dropped keys are reported in warnings); pass {} to empty it deliberately."),
      client_token: z.string().optional().describe("Idempotency token for code-less items (stored in attrs._client_token)"),
    },
    async (args) => {
      const { docItemUpsert } = await import("./docs.js");
      return runDocTool((db) => docItemUpsert(db, args, docCtx));
    }
  );

  // --- doc_item_resolve ---
  server.tool(
    "doc_item_resolve",
    `Resolve a per-project code → UUID. project_id is REQUIRED (codes are unique per project, never global). ` +
      `Never guesses on ambiguity; returns an actionable error if the code does not exist in that project. Every call is audit-logged. ` +
      `Example: doc_item_resolve({project_id:"<uuid>", code:"REQ-001"}).`,
    {
      project_id: z.string().uuid().describe("Project scope — mandatory"),
      code: z.string().min(1).describe("Item code, e.g. REQ-001 / SDES-012"),
    },
    async (args) => {
      const { docItemResolve } = await import("./docs.js");
      return runDocTool((db) => docItemResolve(db, args, docCtx));
    }
  );

  // --- doc_item_chain ---
  server.tool(
    "doc_item_chain",
    `Walk the 'supersedes' chain FORWARD from an old item UUID to the version in force today (SDES-DOCM-020). ` +
      `Use when you hold a UUID reference — a subscription, a link, a citation (D-170: references are UUID-bound) — and need ` +
      `the row that is current now: a UUID stays pinned to the version that was current when it was created. ` +
      `If you hold a CODE instead, use doc_item_resolve — codes already travel onto the current version. ` +
      `Returns resolved_id + the hops walked (code, status, superseded_at) so the path is inspectable, never a magic jump. ` +
      `NEVER guesses: a fork (two rows claiming to supersede the same item) is an ERROR listing the candidates, not a choice; ` +
      `a cycle is an ERROR. The visibility re-check applies at EVERY hop — if the next version is not readable by you, the walk ` +
      `stops and says so (terminal_reason='successor_not_readable') rather than passing off the last readable row as current. ` +
      `Note "no successor" always means "no successor VISIBLE to you": RLS can hide an edge as easily as an item. ` +
      `Example: doc_item_chain({item_id:"<old-uuid>"}).`,
    {
      item_id: z.string().uuid().describe("UUID of the (possibly superseded) item to walk forward from"),
      max_hops: z.number().int().min(1).max(200).optional().describe("Walk depth limit (default 32, ceiling 200) — exceeding it is an explicit error, never a truncated answer"),
    },
    async (args) => {
      const { docItemChain } = await import("./docs.js");
      return runDocTool((db) => docItemChain(db, args, docCtx));
    }
  );

  // --- doc_link ---
  server.tool(
    "doc_link",
    `Create a link. UUID-ONLY (no code param — resolve first, or use doc_link_by_code). target_kind routes the link: ` +
      `'doc' → doc_item↔doc_item traceability (relation_type required: ${DOC_LINK_TYPES_LIST}). ` +
      `  'references' = CROSS-PROJECT (D-074): routes to doc_item_xproject_links; UUIDs are globally unique, no project_id constraint. ` +
      `  All other types = intra-project only: same-project FK enforced (translateLinkError on cross-project attempt). ` +
      `'gtd' → doc_item↔GTD actionability (doc_item_gtd_links, no relation_type — D-070); ` +
      `'wi'  → doc_item↔WI execution link (doc_item_wi_links, no relation_type — D-070). ` +
      `Example (doc, intra): doc_link({target_kind:"doc", from_id:"<sdes-uuid>", to_id:"<req-uuid>", relation_type:"satisfies"}). ` +
      `Example (doc, cross-project): doc_link({target_kind:"doc", from_id:"<req-uuid>", to_id:"<hub-decision-uuid>", relation_type:"references"}). ` +
      `Example (gtd): doc_link({target_kind:"gtd", from_id:"<doc_item-uuid>", to_id:"<gtd-uuid>"}). ` +
      `Example (wi): doc_link({target_kind:"wi", from_id:"<doc_item-uuid>", to_id:"<wi-uuid>"}).`,
    {
      target_kind: z.enum(["doc", "gtd", "wi"]).describe("doc = doc_item↔doc_item | gtd = doc_item↔GTD | wi = doc_item↔WI"),
      from_id: z.string().uuid().describe("FROM doc_item UUID (always a doc_item)"),
      to_id: z.string().uuid().describe("TO UUID — a doc_item (kind=doc), GTD item (kind=gtd), or WI (kind=wi)"),
      relation_type: z.string().optional().describe(`Required for kind=doc: ${DOC_LINK_TYPES_LIST}. Unused for gtd/wi (tables have no relation_type column, D-070).`),
    },
    async (args) => {
      const { docLink } = await import("./docs.js");
      return runDocTool((db) => docLink(db, args, docCtx));
    }
  );

  // --- doc_link_by_code ---
  server.tool(
    "doc_link_by_code",
    `Sugar: resolve(from_code) + resolve(to_code) + doc_link in ONE call, project-scoped + audit-logged. ` +
      `Safe-by-construction (sits on the UUID-only floor). For doc_item↔doc_item links only. ` +
      `Example: doc_link_by_code({project_id:"<uuid>", from_code:"SDES-001", to_code:"REQ-001", link_type:"satisfies"}).`,
    {
      project_id: z.string().uuid().describe("Project scope for BOTH codes — cross-app is impossible here"),
      from_code: z.string().min(1).describe("Source item code (e.g. SDES-001)"),
      to_code: z.string().min(1).describe("Target item code (e.g. REQ-001)"),
      link_type: z.string().describe(`Relation: ${DOC_LINK_TYPES_LIST}`),
    },
    async (args) => {
      const { docLinkByCode } = await import("./docs.js");
      return runDocTool((db) => docLinkByCode(db, args, docCtx));
    }
  );

  // --- doc_supersede ---
  server.tool(
    "doc_supersede",
    `Version an item: mark the old row superseded (immutable) + insert a NEW row + a 'supersedes' edge. ` +
      `The per-project code carries to the new (live) row by default. Never edit a superseded row (DB trigger blocks it). ` +
      `Example: doc_supersede({old_item_id:"<uuid>", body:"updated text", attrs:{moscow:"should"}}).`,
    {
      old_item_id: z.string().uuid().describe("The current (non-superseded) item UUID to supersede"),
      body: z.string().optional().describe("New body (default: carry old body)"),
      attrs: z.record(z.any()).optional().describe("New attrs (default: carry old attrs) — validated vs schema"),
      status: z.string().optional().describe("Status of the new version (default: item_type default)"),
      code: z.string().optional().describe("Override the carried code (default: reuse the old item's code)"),
    },
    async (args) => {
      const { docSupersede } = await import("./docs.js");
      return runDocTool((db) => docSupersede(db, args, docCtx));
    }
  );

  // --- doc_query ---
  server.tool(
    "doc_query",
    `Query doc_items in a project, or run a traceability check. ` +
      `Filter mode: by document_type / item_type / status / code. ` +
      `Lean modes (avoid dumping bodies on large docs): summary=true → per item {code,document_id,status,body_chars,headline,links:{doc_out,doc_in,gtd,wi}} plus a top-level documents legend {document_id→title,type} — a project can span several documents, and the legend makes the split visible at a glance (GTD 4a591cfe); or fields="code,status,..." → projection over chosen columns only. ` +
      `Traceability mode: traceability='req_without_sdes' (REQ rows with no linked SDES) or 'sdes_without_uat'. ` +
      `D-167: a 0-row result carries visibility_gap:true + a note when you have no membership/visibility on project_id — ` +
      `that 0 may be an RLS block, not an empty corpus (verify before treating it as a clean gap-check pass). ` +
      `Example (filter): doc_query({project_id:"<uuid>", item_type:"requirement"}). ` +
      `Example (lean): doc_query({project_id:"<uuid>", document_type:"req", summary:true}). ` +
      `Example (gap): doc_query({project_id:"<uuid>", traceability:"req_without_sdes"}).`,
    {
      project_id: z.string().uuid().describe("Project scope — mandatory"),
      document_type: z.string().optional().describe(`Filter by document type: ${DOC_TYPES_LIST}`),
      item_type: z.string().optional().describe(`Filter by item type: ${ITEM_TYPES_LIST}`),
      status: z.string().optional().describe("Filter by item status"),
      code: z.string().optional().describe("Filter by exact code"),
      traceability: z.enum(["req_without_sdes", "sdes_without_uat"]).optional().describe("Run a traceability gap check instead of a plain filter"),
      summary: z.boolean().optional().describe("Lean output: code+status+body_chars+headline(120c)+link counts (doc_out/doc_in/gtd/wi), no full body. For review-at-scale."),
      fields: z.string().optional().describe("Comma-separated projection, e.g. 'code,status'. Returns only those columns (id always included). Skips body when not listed. Ignored if summary=true."),
      limit: z.number().int().min(1).max(500).optional().describe("Max rows (default: 50)"),
    },
    async (args) => {
      const { docQuery } = await import("./docs.js");
      return runDocTool((db) => docQuery(db, args, docCtx));
    }
  );

  // --- doc_item_types ---
  server.tool(
    "doc_item_types",
    `Introspect the document model registry (self-describing). No args = full registry (document_types, item_types, link_types, capability_parity). ` +
      `item_type='<type>' = that item_type's allowed statuses + attrs JSON-Schema + a copy-pasteable example. ` +
      `document_type='<type>' = that document's legal item_types (expanded). ` +
      `Example: doc_item_types({item_type:"requirement"}).`,
    {
      item_type: z.string().optional().describe(`Drill into one item_type: ${ITEM_TYPES_LIST}`),
      document_type: z.string().optional().describe(`Drill into one document_type: ${DOC_TYPES_LIST}`),
    },
    async (args) => {
      const { docItemTypes } = await import("./docs.js");
      return toText(docItemTypes(args));
    }
  );

  // =========================================================================
  // Subscription Tools (gov.doc_subscriptions / gov.doc_subscription_outcomes
  // / gov.doc_versions — DEL-002, design ratified D-186 SDES-SUB-000..007).
  // All 4 tools live: doc_publish calls gov.doc_publish() (dba msg 401811d8,
  // live 2026-08-21), the only writer gov.doc_versions will ever grant.
  // =========================================================================

  const SUB_INTENTS_LIST = SUBSCRIBE_INTENTS.join("|");
  const SUB_OUTCOMES_LIST = SUBSCRIPTION_OUTCOMES.join("|");
  const BUMP_CLASSES_LIST = BUMP_CLASSES.join("|");

  // --- doc_subscribe ---
  server.tool(
    "doc_subscribe",
    `Subscribe a doc_item to a row or a document (CHOICE origins only — voluntary/topic; FACT origins are automatic, ` +
      `never via this tool). Exactly one of target_item_id (row-level) / target_document_id (document-level watch) is ` +
      `required. intent ∈ {${SUB_INTENTS_LIST}}. note is REQUIRED (why you're subscribing). ` +
      `'critical' across two different projects is REFUSED in v1 (D-186 Q2) — use board_send to the target's owner instead. ` +
      `Idempotent: re-calling with the same intent is a no-op (created:false); a DIFFERENT intent is a grade change ` +
      `(intent_changed in the response), never a duplicate row. ` +
      `Example: doc_subscribe({subscriber_item_id:"<uuid>", target_item_id:"<uuid>", intent:"module", note:"tracks the schema this SDES depends on"}).`,
    {
      subscriber_item_id: z.string().uuid().describe("The doc_item that depends (your own project's row)"),
      target_item_id: z.string().uuid().optional().describe("Row-level target — XOR with target_document_id"),
      target_document_id: z.string().uuid().optional().describe("Document-level (header) watch — XOR with target_item_id"),
      intent: z.enum(SUBSCRIBE_INTENTS).describe(`Grade: ${SUB_INTENTS_LIST}`),
      note: z.string().min(1).describe("Required — why you're subscribing"),
    },
    async (args) => {
      const { docSubscribe } = await import("./subscriptions.js");
      return runDocTool((db) => docSubscribe(db, args, docCtx));
    }
  );

  // --- doc_unsubscribe ---
  server.tool(
    "doc_unsubscribe",
    `Tombstone a subscription (never DELETE — DB trigger rejects it unconditionally). Only for CHOICE-origin ` +
      `subscriptions: a 'fact' origin (constitutive link, role/matrix) is refused — exit by removing the underlying ` +
      `link/role instead (SEC-011). Already-tombstoned is a no-op (already_tombstoned:true), not an error. ` +
      `reason is optional and appended to the stored note (no dedicated column — schema gap, never silently dropped). ` +
      `Example: doc_unsubscribe({subscription_id:"<uuid>", reason:"topic resolved, no longer relevant"}).`,
    {
      subscription_id: z.string().uuid().describe("The subscription to tombstone"),
      reason: z.string().optional().describe("Optional — why you're exiting (appended to note, not a separate column)"),
    },
    async (args) => {
      const { docUnsubscribe } = await import("./subscriptions.js");
      return runDocTool((db) => docUnsubscribe(db, args, docCtx));
    }
  );

  // --- doc_subscription_outcome ---
  server.tool(
    "doc_subscription_outcome",
    `Record the outcome of an impact analysis for (subscription × published version) — an ACT, not a state: ` +
      `'no_impact' does NOT carry forward to the next version (D-151). outcome ∈ {${SUB_OUTCOMES_LIST}}. ` +
      `note is REQUIRED for no_impact (why) and feedback_sent (the reference). version must already be PUBLISHED on ` +
      `the subscription's target document (gov.doc_versions) — an outcome on an unpublished version is an error. ` +
      `Append-only: re-calling with an IDENTICAL payload is a no-op (created:false); a DIFFERENT payload for the same ` +
      `(subscription, version) is refused — the ledger integrates, it never corrects (send a follow-up via board_send). ` +
      `Example: doc_subscription_outcome({subscription_id:"<uuid>", version:"2.1", outcome:"no_impact", note:"reviewed, no change needed on my side"}).`,
    {
      subscription_id: z.string().uuid().describe("The subscription this outcome answers"),
      version: z.string().min(1).describe("The published version_label this outcome responds to"),
      outcome: z.enum(SUBSCRIPTION_OUTCOMES).describe(`Outcome: ${SUB_OUTCOMES_LIST}`),
      note: z.string().optional().describe("Required for no_impact/feedback_sent — the motivation or feedback reference"),
      wi_id: z.string().uuid().optional().describe("The Work Item (subscription-impact-analysis) that produced this outcome"),
      message_id: z.string().uuid().optional().describe("The board message of the feedback (for outcome=feedback_sent)"),
    },
    async (args) => {
      const { docSubscriptionOutcome } = await import("./subscriptions.js");
      return runDocTool((db) => docSubscriptionOutcome(db, args, docCtx));
    }
  );

  // --- doc_publish ---
  server.tool(
    "doc_publish",
    `The explicit act of publication (SDES-SUB-003): verifies the changelog, bumps documents.version, appends to ` +
      `the gov.doc_versions ledger via gov.doc_publish() — the only writer that ledger will ever grant, never an ` +
      `INSERT. No fan-out starts on a plain edit; it starts HERE. Legitimation: document owner or loomy. ` +
      `changelog_entry_id MUST already exist as a 'changelog_entry' in a document_type='changelog' document of the ` +
      `SAME project, with attrs.version === new_version (changelog-by-construction — pubblicare senza changelog è ` +
      `impossibile by-construction). bump_class ∈ {${BUMP_CLASSES_LIST}}. new_version must be dotted-numeric semver-like ` +
      `and order after the last published version. Republishing the same (document_id, new_version) is a REFUSAL, not ` +
      `a no-op. Example: doc_publish({document_id:"<uuid>", new_version:"2.1", bump_class:"minor", changelog_entry_id:"<uuid>", delta_summary:"..."}).`,
    {
      document_id: z.string().uuid().describe("The document to publish"),
      new_version: z.string().min(1).describe("The version that is born, e.g. '2.1' — must order after documents.version"),
      bump_class: z.enum(BUMP_CLASSES).describe(`Change severity: ${BUMP_CLASSES_LIST}`),
      changelog_entry_id: z.string().uuid().describe("The changelog_entry doc_item for this version — no deduction, explicit UUID"),
      delta_summary: z.string().min(1).describe("The delta summary the ledger stores and the notification carries"),
    },
    async (args) => {
      const { docPublish } = await import("./subscriptions.js");
      return runDocTool((db) => docPublish(db, args, docCtx));
    }
  );
}

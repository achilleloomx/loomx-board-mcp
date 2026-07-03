import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "./supabase.js";
import { MESSAGE_TYPES, MESSAGE_STATUSES, GTD_STATUSES, GTD_PRIORITIES, MEAL_TYPES, MENU_STATUSES, WI_END_STATUSES, WI_TEMPLATE_LAYERS, RUNTIME_REQUEST_TYPES } from "./types.js";
import type { AgentRegistry, MessageStatus } from "./types.js";
import {
  DB_DOCUMENT_TYPES,
  DB_ITEM_TYPES,
  DB_DOC_ITEM_LINK_TYPES,
} from "./docTypes.js";

const TABLE = "board_messages";
const OVERVIEW_VIEW = "board_overview";
const GTD_TABLE = "loomx_items";
const GTD_ITEM_PROJECTS_TABLE = "loomx_item_projects";
const RUNTIME_TABLE = "loomx_agent_runtime";
const WI_TABLE = "loomx_work_items";

const MessageTypeSchema = z.enum(MESSAGE_TYPES);
const StatusFilterSchema = z.enum(MESSAGE_STATUSES);

export function registerTools(
  server: McpServer,
  registry: AgentRegistry
): void {
  const { selfCode, selfSlug, slugToCode, codeToSlug } = registry;

  // Dynamic agent slug validation — no hardcoded enum
  const validSlugs = [...slugToCode.keys()];
  const validateRecipientSlug = (slug: string): string | null => {
    if (!slugToCode.has(slug)) return `Unknown agent "${slug}". Valid: ${validSlugs.join(", ")}`;
    if (slug === selfSlug) return "Cannot send a message to yourself";
    return null;
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
    },
    async ({ to_agent, type, subject, body, summary, tags, ref_id }) => {
      const validationError = validateRecipientSlug(to_agent);
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, id: data.id, created_at: data.created_at },
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
    },
    async ({ status, tag, limit, preview_only }) => {
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

      // Broker/loomy can ack messages addressed to any agent; others only their own
      if (!isLoomy && !isBroker) {
        query = query.eq("to_agent", selfCode);
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
    },
    async ({ type, subject, body, summary, tags, ref_id }) => {
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, sent_to: enriched.length, messages: enriched },
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

      // Broker/loomy can update messages addressed to any agent; others only their own
      if (!isLoomy && !isBroker) {
        query = query.eq("to_agent", selfCode);
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

  // --- gtd_inbox ---
  server.tool(
    "gtd_inbox",
    "Read GTD items owned by this agent, ordered by priority_rank DESC then deadline ASC. By default omits body and adds body_preview (200 chars) — use gtd_get(id) for full content.",
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
        ? (data ?? []).map(({ body, ...meta }: any) => ({
            ...meta,
            body_preview: body ? body.slice(0, 200) : null,
          }))
        : (data ?? []);

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
    "Create a new GTD item",
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
    },
    async ({ title, body, gtd_status, owner, priority, deadline, source, source_ref, autopilot, autopilot_model, recurrence_days, block_scope, resume_hint }) => {
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

      const db = getSupabaseClient();

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
    },
    async ({ id, title, body, gtd_status, priority, deadline, waiting_on, owner, autopilot, autopilot_model, recurrence_days, block_scope, resume_hint }) => {
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

      // D-069 two-phase arm enforcement: arming autopilot=true while the owner
      // still has an active WI races the reconciler (it may evoke before wi_end
      // closes). Reject — arm AFTER wi_end, per CLAUDE.md "Autopilot closure".
      if (autopilot === true) {
        let targetOwner = owner;
        if (targetOwner === undefined) {
          const { data: existing } = await db
            .from(GTD_TABLE)
            .select("owner")
            .eq("id", id)
            .maybeSingle();
          targetOwner = (existing as { owner?: string } | null)?.owner;
        }
        if (targetOwner) {
          const { data: activeWi } = await db
            .from(WI_TABLE)
            .select("id")
            .eq("agent_slug", targetOwner)
            .eq("status", "active")
            .limit(1);
          if (Array.isArray(activeWi) && activeWi.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: cannot arm autopilot=true — '${targetOwner}' has an active WI ('${(activeWi[0] as { id: string }).id}'). Two-phase arm (D-069): call wi_end first, then gtd_update(autopilot=true).`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      // Build update payload — only include provided fields
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (title !== undefined) updates.title = title;
      if (body !== undefined) updates.body = body;
      if (gtd_status !== undefined) updates.gtd_status = gtd_status;
      if (priority !== undefined) updates.priority = priority;
      if (deadline !== undefined) updates.deadline = deadline;
      if (waiting_on !== undefined) updates.waiting_on = waiting_on;
      if (owner !== undefined) updates.owner = owner;
      if (autopilot !== undefined) updates.autopilot = autopilot;
      if (autopilot_model !== undefined) updates.autopilot_model = autopilot_model;
      if (recurrence_days !== undefined) updates.recurrence_days = recurrence_days;
      if (block_scope !== undefined) updates.block_scope = block_scope;
      if (resume_hint !== undefined) updates.resume_hint = resume_hint;

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
    `Flexible query for GTD items. ${isLoomy || isBroker ? "Cross-agent read enabled (loomy/broker)." : "Filters to your own items."} By default omits body and adds body_preview (200 chars) — use gtd_get(id) for full content.`,
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
          ? (data ?? []).map(({ body, ...meta }: any) => ({ ...meta, body_preview: body ? body.slice(0, 200) : null }))
          : (data ?? []);

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
        ? (data ?? []).map(({ body, ...meta }: any) => ({ ...meta, body_preview: body ? body.slice(0, 200) : null }))
        : (data ?? []);

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

      if (!slugToCode.has(agent_slug)) {
        return {
          content: [{ type: "text", text: `Error: unknown agent slug "${agent_slug}". Valid: ${validSlugs.join(", ")}` }],
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

  const wiCtx = { selfSlug, isLoomy };

  // --- wi_start ---
  server.tool(
    "wi_start",
    "Open a new Work Item. If gtd_item_id is given, the linked GTD moves to in_progress; otherwise a GTD is auto-created with owner=agent_slug and title=intent.",
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
      "Phase 1 D-074 gate (REQ-033): durable WIs (non-ephemeral template) closing as 'done' require ≥1 REQ/SDES linked via doc_item_wi_links.",
      "Use force_ephemeral=true to bypass (audit-logged). Phase 1 D-074: arm_gtd_ids arms follow-on GTDs post-close (soft-warn). platform_contribution triggers pull enabler D-045.",
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
      arm_gtd_ids: z.array(z.string().uuid()).optional().describe("[D-074 REQ-034] GTD UUIDs to set autopilot=true after close (two-phase arm D-069). Soft-warns on mismatch."),
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
        if (!slugToCode.has(agent_slug)) {
          return {
            content: [{ type: "text", text: `Error: unknown agent slug "${agent_slug}". Valid: ${validSlugs.join(", ")}` }],
            isError: true,
          };
        }
        targetSlug = agent_slug;
      }

      const payload: Record<string, unknown> = { request };
      payload.requested_model = request === "model" ? requested_model! : null;

      const db = getSupabaseClient();
      const { data, error } = await db
        .from(RUNTIME_TABLE)
        .update(payload)
        .eq("owner_slug", targetSlug)
        .select("owner_slug, request, requested_model")
        .maybeSingle();

      if (error) {
        return {
          content: [{ type: "text", text: `Error writing runtime request: ${error.message}` }],
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
            agent: targetSlug,
            request: (data as Record<string, unknown>).request,
            requested_model: (data as Record<string, unknown>).requested_model ?? null,
          }, null, 2),
        }],
      };
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
      `attrs is validated against the item_type's JSON-Schema (call doc_item_types('<item_type>') for schema + example). ` +
      `Defaults: status=type default (usually draft), sort_order=append. item_type ∈ {${ITEM_TYPES_LIST}}. ` +
      `Example: doc_item_upsert({project_id:"<uuid>", document_id:"<uuid>", item_type:"requirement", code:"REQ-001", body:"The system must…", attrs:{moscow:"must", acceptance_criteria:["x"]}}).`,
    {
      project_id: z.string().uuid().describe("Must equal the document's project (anti-divergence FK)"),
      document_id: z.string().uuid().describe("Parent document (from doc_create)"),
      item_type: z.string().describe(`Item type: ${ITEM_TYPES_LIST}`),
      code: z.string().optional().describe("Per-project code (e.g. REQ-001). Omit for prose/exec items. Idempotency key when present."),
      body: z.string().optional().describe("Markdown content of the item"),
      status: z.string().optional().describe("Per-item_type status (default: type default). doc_item_types shows allowed values."),
      owner: z.string().optional().describe(`Owner slug (default: ${selfSlug})`),
      priority: z.string().optional().describe("Free-text priority tag"),
      sort_order: z.number().int().optional().describe("Position in the document (default: append). Idempotency key for code-less items."),
      attrs: z.record(z.any()).optional().describe("Type-specific structured fields — validated vs JSON-Schema (see doc_item_types)"),
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
      `Lean modes (avoid dumping bodies on large docs): summary=true → per item {code,status,body_chars,headline,links:{doc_out,doc_in,gtd,wi}}; or fields="code,status,..." → projection over chosen columns only. ` +
      `Traceability mode: traceability='req_without_sdes' (REQ rows with no linked SDES) or 'sdes_without_uat'. ` +
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
}

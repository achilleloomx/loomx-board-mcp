import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "./supabase.js";
import { MESSAGE_TYPES, MESSAGE_STATUSES, GTD_STATUSES, GTD_PRIORITIES, MEAL_TYPES, MENU_STATUSES, WI_END_STATUSES, WI_TEMPLATE_LAYERS } from "./types.js";
import type { AgentRegistry, MessageStatus } from "./types.js";

const TABLE = "board_messages";
const OVERVIEW_VIEW = "board_overview";
const GTD_TABLE = "loomx_items";
const GTD_ITEM_PROJECTS_TABLE = "loomx_item_projects";

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
        .single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error sending message: ${error.message}` },
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

      const { data, error } = await db
        .from(TABLE)
        .update({ status: "acknowledged" as MessageStatus })
        .eq("id", message_id)
        .eq("to_agent", selfCode)
        .select("id, status")
        .single();

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

      const { data, error } = await db
        .from(TABLE)
        .update({ status: status as MessageStatus })
        .eq("id", message_id)
        .eq("to_agent", selfCode)
        .select("id, status")
        .single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error updating status: ${error.message}` },
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
        .single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading message: ${error.message}` },
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
        .single();

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

  // --- gtd_inbox ---
  server.tool(
    "gtd_inbox",
    "Read GTD items owned by this agent, ordered by priority DESC then deadline ASC. By default omits body and adds body_preview (200 chars) — use gtd_get(id) for full content.",
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
        .order("priority", { ascending: false })
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
    },
    async ({ title, body, gtd_status, owner, priority, deadline, source, source_ref }) => {
      const targetOwner = owner ?? selfSlug;

      // Only loomy can create items for other agents
      if (targetOwner !== selfSlug && !isLoomy) {
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
      const { data, error } = await db
        .from(GTD_TABLE)
        .insert({
          title,
          body: body ?? null,
          gtd_status: gtd_status ?? "inbox",
          owner: targetOwner,
          priority: priority ?? "normal",
          deadline: deadline ?? null,
          source: source ?? null,
          source_ref: source_ref ?? null,
        })
        .select("id, title, gtd_status, owner, created_at")
        .single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error creating GTD item: ${error.message}` },
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
    },
    async ({ id, title, body, gtd_status, priority, deadline, waiting_on, owner }) => {
      const db = getSupabaseClient();

      // Only loomy can reassign owner
      if (owner !== undefined && !isLoomy) {
        return {
          content: [
            { type: "text", text: `Error: only loomy can reassign item owner. You cannot change the owner field.` },
          ],
          isError: true,
        };
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

      let query = db
        .from(GTD_TABLE)
        .update(updates)
        .eq("id", id);

      // Ownership check: non-loomy agents can only update their own items
      if (!isLoomy) {
        query = query.eq("owner", selfSlug);
      }

      const { data, error } = await query
        .select("id, title, gtd_status, priority, owner, updated_at")
        .single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error updating GTD item: ${error.message}` },
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
    `Flexible query for GTD items. ${isLoomy ? "As loomy, you can see all agents' items." : "Filters to your own items unless loomy."} By default omits body and adds body_preview (200 chars) — use gtd_get(id) for full content.`,
    {
      owner: z.string().optional().describe("Filter by owner agent slug"),
      gtd_status: GtdStatusSchema.optional().describe("Filter by GTD status"),
      priority: GtdPrioritySchema.optional().describe("Filter by priority"),
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
    async ({ owner, gtd_status, priority, project_id, limit, preview_only }) => {
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
          .order("priority", { ascending: false })
          .order("deadline", { ascending: true, nullsFirst: false })
          .limit(limit ?? 20);

        // Ownership filter
        if (!isLoomy) {
          query = query.eq("owner", selfSlug);
        } else if (owner) {
          query = query.eq("owner", owner);
        }

        if (gtd_status) query = query.eq("gtd_status", gtd_status);
        if (priority) query = query.eq("priority", priority);

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
        .order("priority", { ascending: false })
        .order("deadline", { ascending: true, nullsFirst: false })
        .limit(limit ?? 20);

      // Ownership filter
      if (!isLoomy) {
        query = query.eq("owner", selfSlug);
      } else if (owner) {
        query = query.eq("owner", owner);
      }

      if (gtd_status) query = query.eq("gtd_status", gtd_status);
      if (priority) query = query.eq("priority", priority);

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
        .single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error completing GTD item: ${error.message}` },
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

      const { data, error } = await query.single();

      if (error) {
        return {
          content: [
            { type: "text", text: `Error reading GTD item: ${error.message}` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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
        .single();

      if (createErr) return { error: createErr.message };
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
        .single();

      if (createErr) return { error: createErr.message };
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
          .single();

        if (error) {
          return {
            content: [{ type: "text", text: `Error adding item: ${translateHomeFkError(error.message)}` }],
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
          .single();

        if (error) {
          return {
            content: [{ type: "text", text: `Error updating item: ${translateHomeFkError(error.message)}` }],
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
          .single();

        if (error) {
          return { content: [{ type: "text", text: `Error removing item: ${error.message}` }], isError: true };
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
            .single();

          if (error) {
            return { content: [{ type: "text", text: `Error updating menu item: ${error.message}` }], isError: true };
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
          .single();

        if (error) {
          return { content: [{ type: "text", text: `Error creating menu item: ${error.message}` }], isError: true };
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
      const db = getSupabaseClient();
      return toText(await wiStart(db, args, wiCtx));
    }
  );

  // --- wi_end ---
  server.tool(
    "wi_end",
    "Close a Work Item. status='done'|'failed'|'waiting'. GTD status cascades (done→done, waiting→waiting, failed→next_action). 'waiting' maps to WI.status='paused' (DB CHECK constraint — see CLAUDE.md WI section).",
    {
      wi_id: z.string().uuid().describe("Work Item id"),
      status: WiEndStatusSchema.describe("End keyword: done | failed | waiting"),
      failure_reason: z.string().optional().describe("Required when status=failed"),
      post_conditions_state: z.record(z.any()).optional().describe("JSONB post-conditions result"),
      side_effects_pending: z.array(z.any()).optional().describe("Side-effects queued for skill v2 executor"),
    },
    async (args) => {
      const { wiEnd } = await import("./wi.js");
      const db = getSupabaseClient();
      return toText(await wiEnd(db, args, wiCtx));
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
      const db = getSupabaseClient();
      return toText(await wiCheckpoint(db, args, wiCtx));
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
      const db = getSupabaseClient();
      return toText(await wiLinkTemplate(db, args, wiCtx));
    }
  );

  // --- wi_pause ---
  server.tool(
    "wi_pause",
    "Pause the active WI (frees the one-active slot for the agent).",
    { wi_id: z.string().uuid().describe("Work Item id") },
    async (args) => {
      const { wiPause } = await import("./wi.js");
      const db = getSupabaseClient();
      return toText(await wiPause(db, args, wiCtx));
    }
  );

  // --- wi_resume ---
  server.tool(
    "wi_resume",
    "Resume a paused WI. Fails if another active WI already exists for the agent.",
    { wi_id: z.string().uuid().describe("Work Item id") },
    async (args) => {
      const { wiResume } = await import("./wi.js");
      const db = getSupabaseClient();
      return toText(await wiResume(db, args, wiCtx));
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
      const db = getSupabaseClient();
      return toText(await wiSwitch(db, args, wiCtx));
    }
  );
}

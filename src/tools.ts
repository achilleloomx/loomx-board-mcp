import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "./supabase.js";
import { MESSAGE_TYPES, MESSAGE_STATUSES, GTD_STATUSES, GTD_PRIORITIES } from "./types.js";
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
    "Read incoming messages for this agent (excludes archived)",
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
    },
    async ({ status, tag, limit }) => {
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

      // Enrich with slugs for readability
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
    "View all board messages with enriched agent info (slugs, names)",
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
        .describe("Max messages to return (default: 50)"),
    },
    async ({ status, limit }) => {
      const db = getSupabaseClient();
      let query = db
        .from(OVERVIEW_VIEW)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit ?? 50);

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

      return {
        content: [
          {
            type: "text",
            text:
              (data ?? []).length === 0
                ? "No messages found."
                : JSON.stringify(data, null, 2),
          },
        ],
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
    "Read GTD items owned by this agent, ordered by priority DESC then deadline ASC",
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
    },
    async ({ status, limit }) => {
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

      return {
        content: [
          {
            type: "text",
            text:
              (data ?? []).length === 0
                ? "No GTD items found."
                : JSON.stringify(data, null, 2),
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
    "Update an existing GTD item. Only the owner can update (loomy can update any item).",
    {
      id: z.string().uuid().describe("ID of the GTD item to update"),
      title: z.string().min(1).optional().describe("New title"),
      body: z.string().optional().describe("New body"),
      gtd_status: GtdStatusSchema.optional().describe("New GTD status"),
      priority: GtdPrioritySchema.optional().describe("New priority"),
      deadline: z.string().nullable().optional().describe("New deadline (ISO 8601, or null to clear)"),
      waiting_on: z.string().nullable().optional().describe("Agent slug this item is waiting on (or null to clear)"),
    },
    async ({ id, title, body, gtd_status, priority, deadline, waiting_on }) => {
      const db = getSupabaseClient();

      // Build update payload — only include provided fields
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (title !== undefined) updates.title = title;
      if (body !== undefined) updates.body = body;
      if (gtd_status !== undefined) updates.gtd_status = gtd_status;
      if (priority !== undefined) updates.priority = priority;
      if (deadline !== undefined) updates.deadline = deadline;
      if (waiting_on !== undefined) updates.waiting_on = waiting_on;

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
    `Flexible query for GTD items. ${isLoomy ? "As loomy, you can see all agents' items." : "Filters to your own items unless loomy."}`,
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
        .describe("Max items to return (default: 50)"),
    },
    async ({ owner, gtd_status, priority, project_id, limit }) => {
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
          .limit(limit ?? 50);

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

        return {
          content: [
            {
              type: "text",
              text:
                (data ?? []).length === 0
                  ? "No GTD items found."
                  : JSON.stringify(data, null, 2),
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
        .limit(limit ?? 50);

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

      return {
        content: [
          {
            type: "text",
            text:
              (data ?? []).length === 0
                ? "No GTD items found."
                : JSON.stringify(data, null, 2),
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
}

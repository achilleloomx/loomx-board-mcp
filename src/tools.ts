import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "./supabase.js";
import { AGENT_IDS, MESSAGE_TYPES, MESSAGE_STATUSES } from "./types.js";
import type { AgentId, MessageStatus } from "./types.js";

const TABLE = "board_messages";

const AgentIdSchema = z.enum(AGENT_IDS);
const MessageTypeSchema = z.enum(MESSAGE_TYPES);
const StatusFilterSchema = z.enum(MESSAGE_STATUSES);

export function registerTools(server: McpServer, selfAgent: AgentId): void {
  // --- board_send ---
  server.tool(
    "board_send",
    "Send a message to another agent",
    {
      to_agent: AgentIdSchema.describe("Recipient agent ID"),
      type: MessageTypeSchema.describe("Message type"),
      subject: z.string().min(1).describe("Message subject"),
      body: z.string().min(1).describe("Message body"),
      ref_id: z
        .string()
        .uuid()
        .optional()
        .describe("Reference message ID (for done/replies)"),
    },
    async ({ to_agent, type, subject, body, ref_id }) => {
      if (to_agent === selfAgent) {
        return {
          content: [
            { type: "text", text: "Error: cannot send a message to yourself" },
          ],
          isError: true,
        };
      }

      const db = getSupabaseClient();
      const { data, error } = await db
        .from(TABLE)
        .insert({
          from_agent: selfAgent,
          to_agent,
          type,
          subject,
          body,
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
    "Read incoming messages for this agent",
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
    },
    async ({ status, limit }) => {
      const db = getSupabaseClient();
      let query = db
        .from(TABLE)
        .select("*")
        .eq("to_agent", selfAgent)
        .order("created_at", { ascending: false })
        .limit(limit ?? 20);

      if (status) {
        query = query.eq("status", status);
      }

      const { data, error } = await query;

      if (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading inbox: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              data.length === 0
                ? "No messages found."
                : JSON.stringify(data, null, 2),
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
      message_id: z.string().uuid().describe("ID of the message to acknowledge"),
    },
    async ({ message_id }) => {
      const db = getSupabaseClient();

      const { data, error } = await db
        .from(TABLE)
        .update({ status: "acknowledged" as MessageStatus })
        .eq("id", message_id)
        .eq("to_agent", selfAgent)
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
          { type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) },
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
        .eq("to_agent", selfAgent)
        .select("id, status")
        .single();

      if (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating status: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) },
        ],
      };
    }
  );
}

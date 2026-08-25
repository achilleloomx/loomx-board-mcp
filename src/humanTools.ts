// LoomX Chat — human-first MCP tools (MVP, GTD 7edbcc72 / approach C hybrid).
//
// A thin, human-facing layer over the same data the agents use
// (loomx_agent_runtime, board_messages, loomx_items). Exposed via the REMOTE
// transport (src/remote.ts) so Achille can talk to Loomy / the LoomX fleet
// from claude.ai (web + phone).
//
// Identity note: there is no `achille` row in board_agents (a new agent slug is
// a Loomy/DBA decision — D-005), so for the MVP the bridge runs under the
// board-mcp identity and is disambiguated by tags (from-achille / for-loomy /
// for-achille). See docs/DECISIONS.md (D-049-chat) and the board_send to loomy.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "./supabase.js";
import { paginate } from "./pagination.js";

// Tag conventions for the Achille <-> Loomy bridge.
const TAG_CHAT = "loomx-chat";
const TAG_FROM_ACHILLE = "from-achille";
const TAG_FOR_LOOMY = "for-loomy";
const TAG_FOR_ACHILLE = "for-achille";

// A runtime heartbeat newer than this is considered "live".
const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

// GTD statuses that count as "open work" for the fleet summary.
const OPEN_GTD_STATUSES = [
  "inbox",
  "next_action",
  "waiting",
  "in_progress",
] as const;

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function firstLine(text: string, max = 80): string {
  const line = text.trim().split("\n")[0] ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface HumanToolsContext {
  /** Code of the identity the bridge writes as (board-mcp = "005"). */
  selfCode: string;
  /** Code of the loomy agent (recipient of ask_loomy). */
  loomyCode: string;
}

export function registerHumanTools(
  server: McpServer,
  ctx: HumanToolsContext
): void {
  const { selfCode, loomyCode } = ctx;

  // --- fleet_status ------------------------------------------------------
  server.tool(
    "fleet_status",
    "Panoramica della flotta LoomX per Achille: agenti live/idle, modello, context %, consumo rate-limit 5h/7d, costo, eventuali richieste pendenti, e conteggio GTD aperti. Dati da loomx_agent_runtime + loomx_items.",
    {
      include_idle: z
        .boolean()
        .optional()
        .describe("Includi anche gli agenti senza heartbeat recente (default: true)"),
    },
    async ({ include_idle }) => {
      const db = getSupabaseClient();
      const showIdle = include_idle ?? true;

      const { data: runtime, error: rtErr } = await db
        .from("loomx_agent_runtime")
        .select(
          "owner_slug, mode, model_current, context_pct, rate_5h_pct, rate_5h_resets_at, rate_7d_pct, cost_usd, heartbeat_at, mandate, request, requested_model"
        );
      if (rtErr) return fail(`runtime read: ${rtErr.message}`);

      const now = Date.now();
      const agents = (runtime ?? [])
        .map((r) => {
          const hb = r.heartbeat_at ? new Date(r.heartbeat_at).getTime() : 0;
          const ageMs = hb ? now - hb : Infinity;
          const live = ageMs <= HEARTBEAT_FRESH_MS;
          return {
            agent: r.owner_slug,
            live,
            state: live ? "live" : "idle",
            mode: r.mode,
            model: r.model_current,
            context_pct: r.context_pct,
            rate_5h_pct: r.rate_5h_pct,
            rate_7d_pct: r.rate_7d_pct,
            cost_usd: r.cost_usd,
            heartbeat_at: r.heartbeat_at,
            heartbeat_age_min:
              ageMs === Infinity ? null : Math.round(ageMs / 60000),
            request: r.request && r.request !== "none" ? r.request : null,
            requested_model: r.requested_model,
            mandate: r.mandate,
          };
        })
        .sort((a, b) => Number(b.live) - Number(a.live));

      const visible = showIdle ? agents : agents.filter((a) => a.live);

      // Open GTD count across the fleet.
      const { count: openGtd, error: gtdErr } = await db
        .from("loomx_items")
        .select("id", { count: "exact", head: true })
        .in("gtd_status", OPEN_GTD_STATUSES as unknown as string[])
        .is("deleted_at", null);
      if (gtdErr) return fail(`gtd count: ${gtdErr.message}`);

      const liveCount = agents.filter((a) => a.live).length;
      const totalCost = agents.reduce(
        (s, a) => s + (typeof a.cost_usd === "number" ? a.cost_usd : 0),
        0
      );
      const pendingRequests = agents.filter((a) => a.request).length;
      const maxRate5h = agents.reduce(
        (m, a) => Math.max(m, a.rate_5h_pct ?? 0),
        0
      );

      return ok({
        ok: true,
        summary: {
          agents_total: agents.length,
          agents_live: liveCount,
          agents_idle: agents.length - liveCount,
          pending_requests: pendingRequests,
          open_gtd: openGtd ?? null,
          fleet_cost_usd: Math.round(totalCost * 100) / 100,
          max_rate_5h_pct: maxRate5h,
        },
        agents: visible,
        generated_at: new Date().toISOString(),
      });
    }
  );

  // --- ask_loomy ---------------------------------------------------------
  server.tool(
    "ask_loomy",
    "Invia una domanda o istruzione a Loomy (async, via board). Loomy la legge al prossimo tick del suo loop e risponde; rileggi con loomy_replies. Latenza = cadenza del loop (minuti).",
    {
      text: z.string().min(1).describe("Cosa vuoi chiedere/dire a Loomy"),
      subject: z
        .string()
        .optional()
        .describe("Oggetto opzionale (default: prima riga del testo)"),
    },
    async ({ text, subject }) => {
      const db = getSupabaseClient();
      const subj = `[Achille→Loomy] ${subject ?? firstLine(text)}`;
      // Footer telling Loomy how to reply so loomy_replies can find it.
      const body =
        `${text}\n\n` +
        `— inviato da Achille via LoomX Chat (claude.ai). ` +
        `Per rispondere: board_send to_agent=board-mcp, ref_id=<id di questo messaggio>, tag 'for-achille'.`;

      const { data, error } = await db
        .from("board_messages")
        .insert({
          from_agent: selfCode,
          to_agent: loomyCode,
          type: "question",
          subject: subj,
          body,
          summary: firstLine(text, 120),
          tags: [TAG_CHAT, TAG_FROM_ACHILLE, TAG_FOR_LOOMY],
          status: "pending",
        })
        .select("id, created_at")
        .maybeSingle();

      if (error || !data) return fail(`ask_loomy insert: ${error?.message ?? "no row returned (RLS?). Retry ask_loomy."}`);

      return ok({
        ok: true,
        id: data.id,
        created_at: data.created_at,
        note: "Domanda consegnata a Loomy. Rileggi con loomy_replies tra qualche minuto.",
      });
    }
  );

  // --- loomy_replies -----------------------------------------------------
  server.tool(
    "loomy_replies",
    "Leggi le risposte di Loomy alle tue domande (ask_loomy). Mostra i messaggi di Loomy indirizzati ad Achille (ref alle domande o taggati 'for-achille').",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Numero massimo di risposte (default: 10)"),
    },
    async ({ limit }) => {
      const db = getSupabaseClient();
      const max = limit ?? 10;

      // ids of Achille's questions (so we can match replies by ref_id)
      const { data: asks, error: askErr } = await db
        .from("board_messages")
        .select("id, subject")
        .eq("from_agent", selfCode)
        .eq("to_agent", loomyCode)
        .contains("tags", [TAG_FROM_ACHILLE])
        .order("created_at", { ascending: false })
        .limit(100);
      if (askErr) return fail(`ask lookup: ${askErr.message}`);

      const askIds = (asks ?? []).map((a) => a.id);
      const askSubject = new Map((asks ?? []).map((a) => [a.id, a.subject]));

      // Replies = Loomy -> board-mcp, either ref to an ask OR tagged for-achille.
      let query = db
        .from("board_messages")
        .select("id, subject, body, summary, ref_id, created_at, tags")
        .eq("from_agent", loomyCode)
        .eq("to_agent", selfCode)
        .order("created_at", { ascending: false })
        .limit(max + 1);

      const orParts: string[] = [`tags.cs.{${TAG_FOR_ACHILLE}}`];
      if (askIds.length > 0) {
        orParts.push(`ref_id.in.(${askIds.join(",")})`);
      }
      query = query.or(orParts.join(","));

      const { data: replies, error: repErr } = await query;
      if (repErr) return fail(`replies read: ${repErr.message}`);

      // CV-8 (D-203, msg 2190b6ae): count is the page size, truncated is the
      // honest signal that the cap actually cut rows — same pattern as
      // pendingInbox.ts (D-205), never a false sentinel.
      const { page, truncated } = paginate(replies ?? [], max);
      return ok({
        ok: true,
        count: page.length,
        replies: page.map((r) => ({
          id: r.id,
          subject: r.subject,
          summary: r.summary,
          body: r.body,
          in_reply_to: r.ref_id
            ? askSubject.get(r.ref_id) ?? r.ref_id
            : null,
          created_at: r.created_at,
        })),
        ...(truncated ? { truncated } : {}),
      });
    }
  );

  // --- decisions_inbox ---------------------------------------------------
  server.tool(
    "decisions_inbox",
    "Coda decisionale di Achille: cose che aspettano una sua decisione — blocchi/domande/alignment aperti sul board e GTD ad alta priorità da chiarire. Euristica MVP (raffinabile).",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Massimo elementi per sezione (default: 15)"),
    },
    async ({ limit }) => {
      const db = getSupabaseClient();
      const max = limit ?? 15;

      // 1) Open board items that signal a needed decision.
      const { data: msgs, error: msgErr } = await db
        .from("board_messages")
        .select("id, from_agent, to_agent, type, subject, summary, status, created_at, tags")
        .in("type", ["blocker", "question", "alignment_issue"])
        .in("status", ["pending", "acknowledged", "in_progress"])
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(max + 1);
      if (msgErr) return fail(`board read: ${msgErr.message}`);

      // 2) High/urgent GTD still to clarify or waiting.
      const { data: gtd, error: gtdErr } = await db
        .from("loomx_items")
        .select("id, title, gtd_status, owner, priority, waiting_on, created_at")
        .in("priority", ["high", "urgent"])
        .in("gtd_status", ["inbox", "next_action", "waiting"])
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(max + 1);
      if (gtdErr) return fail(`gtd read: ${gtdErr.message}`);

      // CV-8 (D-203, msg 2190b6ae): two independent capped lists, each gets
      // its own honest truncated signal — never fused into one flag.
      const { page: msgPage, truncated: boardTruncated } = paginate(msgs ?? [], max);
      const { page: gtdPage, truncated: gtdTruncated } = paginate(gtd ?? [], max);

      return ok({
        ok: true,
        note: "Euristica MVP: board (blocker/question/alignment aperti) + GTD high/urgent da chiarire.",
        board_decisions: msgPage.map((m) => ({
          id: m.id,
          type: m.type,
          subject: m.subject,
          summary: m.summary,
          status: m.status,
          created_at: m.created_at,
        })),
        ...(boardTruncated ? { board_truncated: boardTruncated } : {}),
        gtd_to_clarify: gtdPage.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.gtd_status,
          owner: g.owner,
          priority: g.priority,
          waiting_on: g.waiting_on,
        })),
        ...(gtdTruncated ? { gtd_truncated: gtdTruncated } : {}),
      });
    }
  );

  // --- quick_gtd ---------------------------------------------------------
  server.tool(
    "quick_gtd",
    "Cattura rapida di un task nell'inbox GTD (per triage di Loomy). Owner default: loomy.",
    {
      text: z.string().min(1).describe("Il task da catturare (prima riga = titolo)"),
      owner: z
        .string()
        .optional()
        .describe("Slug agente owner (default: loomy — lo smista lui)"),
      priority: z
        .enum(["low", "normal", "high", "urgent"])
        .optional()
        .describe("Priorità (default: normal)"),
    },
    async ({ text, owner, priority }) => {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from("loomx_items")
        .insert({
          title: firstLine(text, 120),
          body: text,
          gtd_status: "inbox",
          owner: owner ?? "loomy",
          priority: priority ?? "normal",
          source: "loomx-chat-achille",
        })
        .select("id, title, created_at")
        .maybeSingle();

      if (error || !data) return fail(`quick_gtd insert: ${error?.message ?? "no row returned (RLS?). Retry quick_gtd."}`);

      return ok({
        ok: true,
        id: data.id,
        title: data.title,
        owner: owner ?? "loomy",
        created_at: data.created_at,
        note: "Task catturato in inbox GTD.",
      });
    }
  );
}

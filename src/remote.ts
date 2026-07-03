// LoomX Chat — REMOTE entrypoint (Streamable HTTP transport) for claude.ai.
//
// Exposes the human-first tools (src/humanTools.ts) over HTTP/SSE so Achille can
// add this as a custom connector in claude.ai (web + phone) and talk to Loomy /
// the LoomX fleet. Auth is a bearer token (defense-in-depth on top of the
// Tailscale-only default network posture). See GTD 7edbcc72 / design note
// 2026-06-24-loomx-chat-mcp-design.md (approach C hybrid).
//
// Hosting (coordinated with forge): systemd unit + Caddy reverse-proxy +
// Tailscale on VPS loomx-hq. Default bind 127.0.0.1 behind Caddy.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveAgentRegistry } from "./supabase.js";
import { registerHumanTools } from "./humanTools.js";
import { PACKAGE_VERSION } from "./version.js";

const SELF_SLUG = "board-mcp";
const LOOMY_SLUG = "loomy";
const MCP_PATH = "/mcp";

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer token from header / x-loomx-token / ?token= query. */
function extractToken(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const headerTok = req.headers["x-loomx-token"];
  if (typeof headerTok === "string" && headerTok.length > 0) return headerTok;
  const q = url.searchParams.get("token");
  if (q) return q;
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, x-loomx-token, mcp-protocol-version"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export async function startRemoteServer(): Promise<void> {
  const token = process.env.LOOMX_CHAT_TOKEN;
  const allowNoAuth = process.env.LOOMX_CHAT_ALLOW_NOAUTH === "1";
  if (!token && !allowNoAuth) {
    throw new Error(
      "LOOMX_CHAT_TOKEN not set. Set a strong bearer token, or LOOMX_CHAT_ALLOW_NOAUTH=1 for tailscale-only local testing."
    );
  }

  // Resolve agent codes once at startup (board-mcp identity + loomy recipient).
  const registry = await resolveAgentRegistry(SELF_SLUG);
  const loomyCode = registry.slugToCode.get(LOOMY_SLUG);
  if (!loomyCode) {
    throw new Error(`Agent "${LOOMY_SLUG}" not found in board_agents — cannot wire ask_loomy`);
  }
  const ctx = { selfCode: registry.selfCode, loomyCode };

  const port = Number(process.env.LOOMX_CHAT_PORT ?? 8787);
  const host = process.env.LOOMX_CHAT_HOST ?? "127.0.0.1";

  // Stateful session map: one transport (+ server) per MCP session id.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  function newServer(): McpServer {
    const server = new McpServer({ name: "loomx-chat", version: PACKAGE_VERSION });
    registerHumanTools(server, ctx);
    return server;
  }

  const httpServer = createServer(async (req, res) => {
    setCors(res);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — no auth, for systemd/Caddy/uptime probes.
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "loomx-chat", transport: "streamable-http" });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // --- auth gate ---
    if (token) {
      const provided = extractToken(req, url);
      if (!provided || !constantTimeEqual(provided, token)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="loomx-chat"');
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sessionId ? transports[sessionId] : undefined;

        if (!transport) {
          if (!isInitializeRequest(body)) {
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: { code: -32000, message: "No valid session id and not an initialize request" },
              id: null,
            });
            return;
          }
          // New session: spin up a fresh transport + server.
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport!;
            },
          });
          transport.onclose = () => {
            if (transport!.sessionId) delete transports[transport!.sessionId];
          };
          await newServer().connect(transport);
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        // SSE stream / session termination — require an existing session.
        const transport = sessionId ? transports[sessionId] : undefined;
        if (!transport) {
          sendJson(res, 400, { error: "missing or unknown mcp-session-id" });
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "method not allowed" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[loomx-chat] request error: ${msg}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      }
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(
      `[loomx-chat] Remote MCP listening on http://${host}:${port}${MCP_PATH} ` +
        `(auth: ${token ? "bearer-token" : "NONE (dev)"}) — self=${ctx.selfCode} loomy=${ctx.loomyCode}\n`
    );
  });
}

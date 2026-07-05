import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAgentRegistry, resolveSelfSlug } from "./supabase.js";
import { registerTools } from "./tools.js";
import { PACKAGE_VERSION } from "./version.js";

// Bounds the DB round-trips below (identity + registry resolution) so a
// transient DB/network blip at boot fails fast with a clear stderr message
// instead of hanging startServer() indefinitely — an indefinite hang here
// left the MCP client waiting until it gave up on its own with an opaque
// -32000, with nothing logged on our side to diagnose it (RCA GTD c454dbd5).
const BOOT_TIMEOUT_MS = 15_000;

function withBootTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out after ${BOOT_TIMEOUT_MS}ms waiting for ${label}`)),
        BOOT_TIMEOUT_MS
      )
    ),
  ]);
}

// cliSlug: value of --agent, or null if omitted (D-084 Fase 1 — only valid
// when DATABASE_URL is set; resolveSelfSlug enforces that).
export async function startServer(cliSlug: string | null): Promise<void> {
  const slug = await withBootTimeout("identity resolution (resolveSelfSlug)", resolveSelfSlug(cliSlug));
  const registry = await withBootTimeout("agent registry load (resolveAgentRegistry)", resolveAgentRegistry(slug));

  process.stderr.write(
    `[board-mcp] Agent "${slug}" resolved to code "${registry.selfCode}"\n`
  );

  const server = new McpServer({
    name: `board-mcp-${slug}`,
    version: PACKAGE_VERSION,
  });

  registerTools(server, registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[board-mcp] Server started for agent "${slug}" (stdio)\n`
  );
}

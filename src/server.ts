import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAgentRegistry, resolveSelfSlug } from "./supabase.js";
import { registerTools } from "./tools.js";
import { PACKAGE_VERSION } from "./version.js";

// cliSlug: value of --agent, or null if omitted (D-084 Fase 1 — only valid
// when DATABASE_URL is set; resolveSelfSlug enforces that).
export async function startServer(cliSlug: string | null): Promise<void> {
  const slug = await resolveSelfSlug(cliSlug);
  const registry = await resolveAgentRegistry(slug);

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

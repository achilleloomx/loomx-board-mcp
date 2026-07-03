import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAgentRegistry } from "./supabase.js";
import { registerTools } from "./tools.js";
import { PACKAGE_VERSION } from "./version.js";
export async function startServer(slug: string): Promise<void> {
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import type { AgentId } from "./types.js";

export async function startServer(agentId: AgentId): Promise<void> {
  const server = new McpServer({
    name: `board-mcp-${agentId}`,
    version: "0.1.0",
  });

  registerTools(server, agentId);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[board-mcp] Server started for agent "${agentId}" (stdio)\n`
  );
}

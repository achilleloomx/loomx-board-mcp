import { AGENT_IDS } from "./types.js";
import type { AgentId } from "./types.js";
import { startServer } from "./server.js";

function parseArgs(): AgentId {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf("--agent");

  if (agentIdx === -1 || agentIdx + 1 >= args.length) {
    process.stderr.write("Usage: board-mcp --agent <agent-id>\n");
    process.stderr.write(`Valid agent IDs: ${AGENT_IDS.join(", ")}\n`);
    process.exit(1);
  }

  const agentId = args[agentIdx + 1] as string;

  if (!AGENT_IDS.includes(agentId as AgentId)) {
    process.stderr.write(`Invalid agent ID: "${agentId}"\n`);
    process.stderr.write(`Valid agent IDs: ${AGENT_IDS.join(", ")}\n`);
    process.exit(1);
  }

  return agentId as AgentId;
}

const agentId = parseArgs();
startServer(agentId).catch((err) => {
  process.stderr.write(`[board-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});

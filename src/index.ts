import { AGENT_SLUGS } from "./types.js";
import type { AgentSlug } from "./types.js";
import { startServer } from "./server.js";

function parseArgs(): AgentSlug {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf("--agent");

  if (agentIdx === -1 || agentIdx + 1 >= args.length) {
    process.stderr.write("Usage: board-mcp --agent <agent-slug>\n");
    process.stderr.write(`Valid slugs: ${AGENT_SLUGS.join(", ")}\n`);
    process.exit(1);
  }

  const slug = args[agentIdx + 1] as string;

  if (!AGENT_SLUGS.includes(slug as AgentSlug)) {
    process.stderr.write(`Invalid agent slug: "${slug}"\n`);
    process.stderr.write(`Valid slugs: ${AGENT_SLUGS.join(", ")}\n`);
    process.exit(1);
  }

  return slug as AgentSlug;
}

const slug = parseArgs();
startServer(slug).catch((err) => {
  process.stderr.write(`[board-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});

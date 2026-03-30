import { startServer } from "./server.js";

function parseArgs(): string {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf("--agent");

  if (agentIdx === -1 || agentIdx + 1 >= args.length) {
    process.stderr.write("Usage: board-mcp --agent <agent-slug>\n");
    process.exit(1);
  }

  return args[agentIdx + 1] as string;
}

const slug = parseArgs();
startServer(slug).catch((err) => {
  process.stderr.write(`[board-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});

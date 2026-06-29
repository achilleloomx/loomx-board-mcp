import { startServer } from "./server.js";
import { startRemoteServer } from "./remote.js";

function parseArgs(): { remote: boolean; slug: string | null } {
  const args = process.argv.slice(2);

  // Remote (LoomX Chat) mode: HTTP/SSE transport for claude.ai.
  if (args.includes("--remote")) {
    return { remote: true, slug: null };
  }

  const agentIdx = args.indexOf("--agent");
  if (agentIdx === -1 || agentIdx + 1 >= args.length) {
    process.stderr.write(
      "Usage: board-mcp --agent <agent-slug>   (stdio, per-agent)\n" +
        "       board-mcp --remote               (LoomX Chat, HTTP/SSE for claude.ai)\n"
    );
    process.exit(1);
  }

  return { remote: false, slug: args[agentIdx + 1] as string };
}

const { remote, slug } = parseArgs();

const boot = remote ? startRemoteServer() : startServer(slug as string);

boot.catch((err) => {
  process.stderr.write(`[board-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});

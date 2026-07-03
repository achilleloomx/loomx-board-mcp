import { startServer } from "./server.js";
import { startRemoteServer } from "./remote.js";

function parseArgs(): { remote: boolean; slug: string | null } {
  const args = process.argv.slice(2);

  // Remote (LoomX Chat) mode: HTTP/SSE transport for claude.ai.
  if (args.includes("--remote")) {
    return { remote: true, slug: null };
  }

  const agentIdx = args.indexOf("--agent");
  const hasAgentFlag = agentIdx !== -1;

  if (hasAgentFlag && agentIdx + 1 >= args.length) {
    process.stderr.write("Usage: board-mcp --agent <agent-slug>   (--agent value missing)\n");
    process.exit(1);
  }

  // D-084 Fase 1: --agent is only mandatory when DATABASE_URL is unset (no
  // native identity to derive a slug from — resolveSelfSlug enforces this).
  // With DATABASE_URL, --agent is optional and used only as a cross-check.
  if (!hasAgentFlag && !process.env.DATABASE_URL) {
    process.stderr.write(
      "Usage: board-mcp --agent <agent-slug>   (stdio, per-agent; required without DATABASE_URL)\n" +
        "       board-mcp                        (stdio; slug derived from native DB role when DATABASE_URL is set)\n" +
        "       board-mcp --remote               (LoomX Chat, HTTP/SSE for claude.ai)\n"
    );
    process.exit(1);
  }

  return { remote: false, slug: hasAgentFlag ? (args[agentIdx + 1] as string) : null };
}

const { remote, slug } = parseArgs();

const boot = remote ? startRemoteServer() : startServer(slug);

boot.catch((err) => {
  process.stderr.write(`[board-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});

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

// G4 mix-of-builds fix (GTD 8471a512). tools.ts loads its handler modules via
// `await import(...)` INSIDE each tool call, not at the top of the file — so
// each module only enters Node's ESM cache the first time some agent actually
// invokes the tool that needs it. If `npm run build` rewrites dist/ while this
// process is alive, modules already cached keep their pre-rebuild content
// (Node never invalidates an ESM cache entry on file change) but any module
// not yet touched loads the POST-rebuild file on its first call — a live
// process can end up running an internally-inconsistent mix of old and new
// code (observed: new docs.js calling a function factSync.js, still cached
// from the old build, didn't export). Eagerly importing every lazy-loaded
// module once here, before the server accepts any tool call, pins the whole
// set to whatever dist/ is on disk at boot — later rewrites can no longer
// produce a mix, only the already-documented and accepted "this window stays
// on the build it booted with" (G4, CLAUDE.md "Rollout di un nuovo build").
const LAZY_MODULES = [
  "./wi.js",
  "./wiCache.js",
  "./pendingInbox.js",
  "./docDb.js",
  "./docs.js",
  "./subscriptions.js",
  "./staleness.js",
  "./factSync.js",
  "./idResolve.js",
  "./structure.js",
] as const;

async function preloadLazyModules(): Promise<void> {
  await Promise.all(LAZY_MODULES.map((m) => import(m)));
}

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
  await withBootTimeout("lazy module preload (G4 mix-of-builds fix)", preloadLazyModules());

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

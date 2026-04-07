import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createPgClient, PgShimClient } from "./pg-shim.js";
import type { AgentRegistry, BoardAgent } from "./types.js";

// Client type is a structural union of supabase-js and our pg shim. Both
// expose the subset of methods used by src/tools.ts (`from`, `rpc`). The
// return type is cast to SupabaseClient so downstream call sites keep their
// existing types without changes.
type DbClient = SupabaseClient | PgShimClient;

let client: DbClient | null = null;
let backend: "supabase" | "pg" | null = null;

function initClient(): DbClient {
  if (client) return client;

  const databaseUrl = process.env.DATABASE_URL;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (databaseUrl && key) {
    throw new Error(
      "Conflicting DB credentials: DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set. Pick one backend."
    );
  }

  if (databaseUrl) {
    const pgClient = createPgClient(databaseUrl);
    client = pgClient;
    backend = "pg";
    process.stderr.write("[board-mcp] DB backend: direct-postgres (DATABASE_URL)\n");
    // Fire-and-log identity verification; any error is surfaced via stderr.
    pgClient
      .verifyIdentity()
      .then((id) =>
        process.stderr.write(
          `[board-mcp] pg identity: current_user=${id.current_user} session_user=${id.session_user}\n`
        )
      )
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[board-mcp] pg identity check failed: ${msg}\n`);
      });
    return client;
  }

  if (!url || !key) {
    throw new Error(
      "Missing DB credentials: set DATABASE_URL, or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  client = createClient(url, key);
  backend = "supabase";
  process.stderr.write("[board-mcp] DB backend: supabase-js (service_role)\n");
  return client;
}

export function getSupabaseClient(): SupabaseClient {
  // Cast: the pg shim structurally implements the subset of SupabaseClient
  // that tools.ts uses. See src/pg-shim.ts for the covered surface.
  return initClient() as unknown as SupabaseClient;
}

export function getBackend(): "supabase" | "pg" | null {
  return backend;
}

export async function resolveAgentRegistry(
  slug: string
): Promise<AgentRegistry> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from("board_agents")
    .select("agent_code, slug, label, nickname, active")
    .eq("active", true);

  if (error) {
    throw new Error(`Failed to load agent registry: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Agent registry is empty");
  }

  const agents = data as BoardAgent[];
  const self = agents.find((a) => a.slug === slug);

  if (!self) {
    throw new Error(
      `Agent "${slug}" not found in board_agents registry`
    );
  }

  const slugToCode = new Map<string, string>();
  const codeToSlug = new Map<string, string>();

  for (const agent of agents) {
    slugToCode.set(agent.slug, agent.agent_code);
    codeToSlug.set(agent.agent_code, agent.slug);
  }

  return {
    selfCode: self.agent_code,
    selfSlug: slug,
    slugToCode,
    codeToSlug,
  };
}

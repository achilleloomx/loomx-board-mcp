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

// D-084 Fase 1(a) — identity resolution.
//
// Convention (coordinated with DBA, D-084): the native Postgres role name for
// an agent equals its board_agents.slug (same convention as the vault secret
// path `loomx/agents/<slug>`). When DATABASE_URL is set, we trust current_user
// (the DB session's own identity) over the --agent CLI flag: --agent becomes a
// cross-check only, and any mismatch is an explicit startup error rather than
// silently trusting the flag. Without DATABASE_URL (service_role fallback) there
// is no native identity to derive from, so behavior is unchanged: --agent is
// required and trusted, exactly as before Fase 1 (rollout stays opt-in/gradual,
// D-084 Fase 2).
export async function resolveSelfSlug(cliSlug: string | null): Promise<string> {
  initClient();

  if (backend !== "pg") {
    if (!cliSlug) {
      throw new Error(
        "Missing --agent: required when DATABASE_URL is not set (service_role backend has no native identity to derive a slug from)"
      );
    }
    return cliSlug;
  }

  const pgClient = client as unknown as PgShimClient;
  const identity = await pgClient.verifyIdentity();
  const nativeRole = identity.current_user;

  const db = getSupabaseClient();
  const { data, error } = await db
    .from("board_agents")
    .select("slug")
    .eq("slug", nativeRole)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    throw new Error(
      `board_agents lookup failed while resolving native DB role "${nativeRole}" to an agent slug: ${error.message}`
    );
  }
  if (!data) {
    throw new Error(
      `Native DB role "${nativeRole}" has no matching active slug in board_agents (D-084 convention: role name === agent slug). ` +
        `Refusing to fall back to --agent as identity — fix the role/slug mismatch (DBA) or unset DATABASE_URL.`
    );
  }

  const resolvedSlug = (data as { slug: string }).slug;

  if (cliSlug && cliSlug !== resolvedSlug) {
    throw new Error(
      `Identity mismatch: native DB role "${nativeRole}" resolves to slug "${resolvedSlug}", but --agent was "${cliSlug}". ` +
        `Refusing to start with conflicting identity (D-084 Fase 1: --agent is cross-check only, never trusted over the native role).`
    );
  }

  process.stderr.write(
    `[board-mcp] Identity from native role: current_user="${nativeRole}" -> slug="${resolvedSlug}"` +
      (cliSlug ? " (--agent cross-check OK)" : " (--agent not provided, using native identity)") +
      "\n"
  );

  return resolvedSlug;
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

// Re-queries board_agents and repopulates the registry's maps in place (same
// Map instances — tool closures hold a reference, not a copy). Used as a
// lazy-reload fallback when a slug misses validation: a newly added agent is
// invisible until this runs once, since the registry is otherwise snapshotted
// at boot (see startServer in server.ts).
export async function refreshAgentRegistry(registry: AgentRegistry): Promise<void> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from("board_agents")
    .select("agent_code, slug, label, nickname, active")
    .eq("active", true);

  if (error || !data) return;

  registry.slugToCode.clear();
  registry.codeToSlug.clear();
  for (const agent of data as BoardAgent[]) {
    registry.slugToCode.set(agent.slug, agent.agent_code);
    registry.codeToSlug.set(agent.agent_code, agent.slug);
  }
}

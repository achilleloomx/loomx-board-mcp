import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { AgentSlug, AgentRegistry, BoardAgent } from "./types.js";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables"
    );
  }

  client = createClient(url, key);
  return client;
}

export async function resolveAgentRegistry(
  slug: AgentSlug
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

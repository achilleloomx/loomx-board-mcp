// Local WI cache mirror for the PreToolUse governance gate (D-024).
//
// The governance-gate.sh hook reads `.claude/cache/current-work-item.json`
// to decide whether to allow writes. Design spec: hub/initiatives/
// governance-compliance/design.md §3.3 — "wi-start writes DB + cache
// atomically; wi-end writes DB + cache + moves history". Writing from the
// MCP server removes the dependency on the (not-yet-active) session-manager
// skill v2 without breaking wi.ts purity — cache is a tools.ts wrapper
// concern.
//
// Project dir resolution: Claude Code sets CLAUDE_PROJECT_DIR for hooks and
// MCP stdio servers. We honor it; otherwise we fall back to process.cwd(),
// which matches the agent repo when the server is spawned via .mcp.json.
// We only write when .claude/ already exists in the target directory, to
// avoid polluting unrelated working directories shared across agents.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const WI_TABLE = "loomx_work_items";
const CACHE_REL_DIR = path.join(".claude", "cache");
const CACHE_FILE = "current-work-item.json";
const HISTORY_REL_DIR = path.join(".claude", "cache", "wi-history");

function resolveProjectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

async function claudeDirExists(projectDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(projectDir, ".claude"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function writeAtomic(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, absPath);
}

// Fetch the agent's active WI (if any) and mirror it to the cache file.
// If no active WI exists, the cache is removed so the gate blocks again.
export async function syncWiCache(
  db: SupabaseClient,
  agentSlug: string
): Promise<void> {
  try {
    const projectDir = resolveProjectDir();
    if (!(await claudeDirExists(projectDir))) return;

    const cacheDir = path.join(projectDir, CACHE_REL_DIR);
    await fs.mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, CACHE_FILE);

    const { data, error } = await db
      .from(WI_TABLE)
      .select("*")
      .eq("agent_slug", agentSlug)
      .eq("status", "active")
      .limit(1);

    if (error) {
      process.stderr.write(
        `[board-mcp wiCache] sync failed: ${error.message}\n`
      );
      return;
    }

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (row) {
      await writeAtomic(cachePath, JSON.stringify(row, null, 2));
    } else {
      try {
        await fs.unlink(cachePath);
      } catch {
        // already absent — fine
      }
    }
  } catch (err) {
    process.stderr.write(
      `[board-mcp wiCache] unexpected error: ${(err as Error).message}\n`
    );
  }
}

// Archive a closed WI row to wi-history/<id>.json (best-effort, audit trail).
export async function archiveWiToHistory(
  db: SupabaseClient,
  wiId: string
): Promise<void> {
  try {
    const projectDir = resolveProjectDir();
    if (!(await claudeDirExists(projectDir))) return;

    const histDir = path.join(projectDir, HISTORY_REL_DIR);
    await fs.mkdir(histDir, { recursive: true });

    const { data, error } = await db
      .from(WI_TABLE)
      .select("*")
      .eq("id", wiId)
      .maybeSingle();

    if (error || !data) return;

    const histPath = path.join(histDir, `${wiId}.json`);
    await writeAtomic(histPath, JSON.stringify(data, null, 2));
  } catch (err) {
    process.stderr.write(
      `[board-mcp wiCache] history archive failed: ${(err as Error).message}\n`
    );
  }
}

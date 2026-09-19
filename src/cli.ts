#!/usr/bin/env node
// board-cli — command-line twin of the MCP tools that a runtime hook needs
// (SDES-001 v1, project frame-method-as-service; task frame msg 1a7ed39d).
//
//   board-cli agent-context [--compact] [--session-id <id>] [--trigger <startup|resume|clear|compact>] [--agent <slug>]
//
// Why a CLI at all: the stdio MCP server outlives /clear and compaction and
// cannot see them. The runtime can — Claude Code fires SessionStart on
// startup/resume/clear/compact. The hook runs this command and prints its
// output into the context: every run OPENS A NEW EPOCH for that session_id
// and records what it delivered. Same native identity (resolveSelfSlug), same
// module (agentContext) as the MCP tool — not a second implementation.
//
// Hook contract: NEVER blocks a session start. Whatever goes wrong (DB down,
// bad args, registry missing) → a one-line notice on stdout and exit 0.
//
// session_id/trigger may also come from the hook's JSON payload on stdin
// ({session_id, source}) when the flags are omitted — so the hook entry can be
// the bare command, with no jq/shell parsing around it.

import { EPOCH_TRIGGERS, type EpochTrigger } from "./sessionNorms.js";

interface CliArgs {
  compact: boolean;
  sessionId: string | null;
  trigger: string | null;
  agent: string | null;
}

function parse(argv: string[]): CliArgs {
  const out: CliArgs = { compact: false, sessionId: null, trigger: null, agent: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--compact") out.compact = true;
    else if (a === "--session-id") out.sessionId = argv[++i] ?? null;
    else if (a === "--trigger") out.trigger = argv[++i] ?? null;
    else if (a === "--agent") out.agent = argv[++i] ?? null;
    else throw new Error(`unknown argument '${a}'`);
  }
  return out;
}

async function readHookStdin(): Promise<{ session_id?: unknown; source?: unknown }> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", () => resolve());
  });
  // A hook always closes stdin; a bare shell with an inherited open pipe must
  // not hang a session start.
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, 1500))]);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// The Claude Code process hosting this session — the value the MCP server of
// the same session sees as process.ppid. CLAUDE_PID when the runtime exports
// it; else null (the MCP side then falls back, see resolveCurrentSession).
function hostPid(): number | null {
  const n = Number(process.env.CLAUDE_PID);
  return Number.isInteger(n) && n > 1 ? n : null;
}

async function agentContextCommand(argv: string[]): Promise<string> {
  const args = parse(argv);

  // Same env contract as .mcp.json, which maps these from the agent's shell.
  process.env.DATABASE_URL ||= process.env.LOOMX_DB_URL ?? "";
  process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
  if (!process.env.DATABASE_URL) delete process.env.DATABASE_URL;
  if (!process.env.DOC_RW_DATABASE_URL) delete process.env.DOC_RW_DATABASE_URL;

  let sessionId = args.sessionId;
  let trigger = args.trigger;
  if (!sessionId || !trigger) {
    const hook = await readHookStdin();
    if (!sessionId && typeof hook.session_id === "string") sessionId = hook.session_id;
    if (!trigger && typeof hook.source === "string") trigger = hook.source;
  }
  sessionId ||= process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!sessionId) throw new Error("no session id (pass --session-id, or the hook JSON on stdin)");
  if (!trigger || !(EPOCH_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new Error(`--trigger must be one of ${EPOCH_TRIGGERS.join("|")} (got '${trigger ?? ""}')`);
  }

  const { resolveSelfSlug, resolveAgentRegistry, getSupabaseClient } = await import("./supabase.js");
  const { runDocRw } = await import("./docDb.js");
  const { makeDocRwSessionStore } = await import("./sessionNorms.js");
  const { agentContext, renderCompact } = await import("./agentContext.js");

  const slug = await resolveSelfSlug(args.agent ?? process.env.LOOMX_AGENT_SLUG ?? null);
  const registry = await resolveAgentRegistry(slug);
  const res = await agentContext(
    getSupabaseClient(),
    { selfSlug: slug, slugToCode: registry.slugToCode, codeToSlug: registry.codeToSlug },
    {
      kind: "open",
      store: makeDocRwSessionStore(slug, runDocRw),
      sessionId,
      trigger: trigger as EpochTrigger,
      hostPid: hostPid(),
    },
    args.compact ? "compact" : "full"
  );
  if (!res.ok) throw new Error(res.error);
  return args.compact ? renderCompact(res.data) : JSON.stringify({ ok: true, ...res.data }, null, 2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // supabase.ts/docDb.ts log their backend choice on stderr; a hook prints
  // only stdout into the context, so nothing to silence here.
  try {
    if (command !== "agent-context") throw new Error(`unknown command '${command ?? ""}' (available: agent-context)`);
    process.stdout.write((await agentContextCommand(rest)) + "\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(
      `[board] contesto di avvio NON consegnato (${msg}). La sessione prosegue: chiama agent_context() appena il board è raggiungibile.\n`
    );
  }
}

// Hard ceiling, inside the hook's own 5 s timeout (frame msg 61fda155): a hung
// DB connection must not hold a session start hostage, and the notice has to
// reach stdout before the runtime kills the hook.
const WATCHDOG_MS = 4_500;
const watchdog = setTimeout(() => {
  process.stdout.write(`[board] contesto di avvio NON consegnato (timeout ${WATCHDOG_MS} ms). La sessione prosegue: chiama agent_context().\n`);
  process.exit(0);
}, WATCHDOG_MS);

main().finally(() => {
  clearTimeout(watchdog);
  process.exit(0);
});

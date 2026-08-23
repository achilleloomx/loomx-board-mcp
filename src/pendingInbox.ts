// pending_inbox (D-205, ratified by loomy msg 17051c14 — REQ-GOV-151..154,
// SDES-GOV-156..157; requirement/design in project 85d81454-5b38-40bb-b8c6-9d5188ef1a34).
//
// What the closing agent still has waiting for it, handed over at the moment it
// decides continue/clear/kill. It is NOT a guard: no block, no DB write, no
// separate warning string (REQ-GOV-152). Just the facts, on every real close
// path — wi_end() and gtd_complete() (REQ-GOV-151).
//
// Naming (REQ-GOV-153): `pending_inbox`, deliberately distinct from D-118's
// `inbox_pending_warning`. D-118's checkInboxPendingGuard is superseded and
// declared dead (REQ-GOV-154); its code is removed in a separate commit AFTER
// this one is live (SDES-GOV-157), never bundled here.

import type { SupabaseClient } from "@supabase/supabase-js";

const BOARD_MESSAGES_TABLE = "board_messages";

// Same three types D-118 called "actionable": a message the recipient is
// expected to do something about. info/done/alignment_issue are not queue work.
const ACTIONABLE_INBOX_TYPES = new Set(["task", "question", "blocker"]);

// How many messages travel in the payload. The count is always exact; beyond
// this cap the list is explicitly marked truncated rather than silently short.
const MAX_LISTED = 5;

export interface PendingInboxRegistry {
  slugToCode?: Map<string, string>;
  codeToSlug?: Map<string, string>;
}

export interface PendingInboxMessage {
  id: string;
  from: string; // sender slug (falls back to the raw agent code if unmapped)
  type: string;
  subject: string;
  age_minutes: number;
}

export interface PendingInboxInfo {
  count: number;
  messages: PendingInboxMessage[]; // oldest first, at most MAX_LISTED
  truncated?: boolean; // count > MAX_LISTED — the list is a head, not the whole queue
}

interface BoardMsgRow {
  id: string;
  from_agent: string;
  type: string;
  subject?: string | null;
  status?: string;
  created_at: string;
}

/**
 * Read-only snapshot of the actionable messages still pending for `ownerSlug`.
 *
 * Returns undefined — no field at all, never an empty stand-in — when the
 * information would be about someone other than the live caller:
 *   - `callerSlug !== ownerSlug`: closing on another agent's behalf. This is
 *     the orphan sweep REQ-GOV-151 excludes: the reconciler (or loomy) tidying
 *     up an abandoned WI is not a close by the agent whose queue this is, and
 *     nobody alive is making a continue/clear/kill choice from it.
 *   - registry unavailable, or the owner has no agent code: board_messages is
 *     keyed by code, so the queue cannot be resolved. Say nothing rather than
 *     report an empty queue we never actually read.
 *   - the read errors: logged to stderr, never surfaced as a failure — this is
 *     additive information and must not affect the close (REQ-GOV-152).
 *
 * A count of 0 IS reported (with an empty list): "your queue is empty" is a
 * real input to the kill decision, and distinguishing it from "not computed"
 * is the whole point of the undefined cases above.
 */
export async function computePendingInbox(
  db: SupabaseClient,
  registry: PendingInboxRegistry,
  ownerSlug: string,
  callerSlug: string,
  now: string
): Promise<PendingInboxInfo | undefined> {
  if (callerSlug !== ownerSlug) return undefined;
  if (!registry.slugToCode || !registry.codeToSlug) return undefined;
  const ownerCode = registry.slugToCode.get(ownerSlug);
  if (!ownerCode) return undefined;

  const { data, error } = await db
    .from(BOARD_MESSAGES_TABLE)
    .select("id, from_agent, type, subject, status, created_at")
    .eq("to_agent", ownerCode)
    .eq("status", "pending");

  if (error) {
    process.stderr.write(`[pending_inbox] read failed (non-blocking): ${error.message}\n`);
    return undefined;
  }

  const rows = (Array.isArray(data) ? data : []) as BoardMsgRow[];
  const actionable = rows
    .filter((m) => ACTIONABLE_INBOX_TYPES.has(m.type))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const nowMs = Date.parse(now);
  const messages: PendingInboxMessage[] = actionable.slice(0, MAX_LISTED).map((m) => ({
    id: m.id,
    from: registry.codeToSlug!.get(m.from_agent) ?? m.from_agent,
    type: m.type,
    subject: m.subject ?? "(no subject)",
    age_minutes: Math.max(0, Math.round((nowMs - Date.parse(m.created_at)) / 60000)),
  }));

  return {
    count: actionable.length,
    messages,
    ...(actionable.length > MAX_LISTED ? { truncated: true } : {}),
  };
}

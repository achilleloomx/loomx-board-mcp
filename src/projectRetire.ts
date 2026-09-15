// project_retire — SDES-DOCM-030/031/032/033/035 (Ritiro progetto fase 3,
// mandato Achille 15/09, GTD 1061ce6e).
//
// Iterates doc_item_retire (docs.ts) over every non-terminal doc_item of a
// project — never doc_promote, which EVAL-PG-007 measured bypassing the
// row-grain guard entirely because it only touches documents.status, never
// doc_items.status (see docs.ts doc_item_retire header). Two-phase: dry_run=
// true (default) previews every block, dry_run=false only executes when a
// FRESH recomputation (not a client-trusted stale dry_run) finds zero blocks
// project-wide — REQ-DOCM-025's "same guard, never bypassed" read at project
// grain: a bulk operation that quietly threads no_successor_reason through
// every row regardless of what it orphans would be exactly the aggiramento
// the requirement forbids, so it doesn't.
//
// KNOWN LIMITATION, declared not hidden (D-136 §5 / REQ-DOCM-029 /
// SDES-DOCM-034): blocks are computed on RAW incoming reference counts,
// counting a referencer regardless of ITS OWN status. REQ-DOCM-029 proposes
// excluding non-"in vigore" referencers (same filter already ratified for
// traceability, REQ-DOCM-015), but that change lives in a DB trigger
// (gov.doc_items_require_successor_on_terminal) this server does not own, and
// SDES-DOCM-034 is explicit that it "cambia un comportamento già live" and
// needs Achille's ratification first (D-136 §5) — NOT applied here. Until
// then, project_retire will report a block on essentially any project with a
// live internal REQ→SDES→UAT chain, even where every referencer is itself
// about to be retired in the same sweep. Flagged to loomy at delivery, not
// routed around silently.
//
// project_id-scoped, not document-scoped: mirrors doc_structure's census
// (every doc_items row across every document of the project).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocResult, DocContext } from "./docs.js";
import { docItemRetire } from "./docs.js";

const DOC_ITEMS = "doc_items";
const DOC_ITEM_LINKS = "doc_item_links";
const DOC_ITEM_XPROJECT_LINKS = "doc_item_xproject_links";
const GOV_DOC_SUBSCRIPTIONS = "gov.doc_subscriptions";
const PROJECTS_TABLE = "loomx_projects";
const GTD_TABLE = "loomx_items";
const GTD_ITEM_PROJECTS_TABLE = "loomx_item_projects";
const BOARD_MESSAGES_TABLE = "board_messages";
const BOARD_AGENTS_TABLE = "board_agents";

const TERMINAL_STATUSES = new Set(["superseded", "deprecated", "archived", "rejected", "retired"]);

function err(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}
function nowIso(): string {
  return new Date().toISOString();
}

export interface ProjectRetireArgs {
  project_id: string;
  reason: string;
  dry_run?: boolean; // default true
}

export interface ProjectRetireBlock {
  item_id: string;
  code: string | null;
  document_id: string;
  item_type: string;
  status: string;
  links_in: number;
  xproject_links_in: number;
  subscriptions_in: number;
}

export interface ProjectRetireGtdEntry {
  id: string;
  title: string;
  gtd_status: string;
}

export interface ProjectRetireResult {
  project_id: string;
  dry_run: boolean;
  rows_considered: number;
  rows_already_terminal: number;
  blocks: ProjectRetireBlock[];
  retired: Array<{ item_id: string; code: string | null }>;
  retire_errors: Array<{ item_id: string; code: string | null; error: string }>;
  notify_sent: Array<{ to_slug: string; item_id: string; code: string | null }>;
  notify_warnings: string[];
  gtd_closed: ProjectRetireGtdEntry[];
  gtd_needs_reassignment: ProjectRetireGtdEntry[];
  wi_scoping_gap: string;
  project_tombstone_written: boolean;
  project_tombstone_note?: string;
  atomicity_note: string;
  in_vigore_filter_note: string;
  warnings: string[];
}

async function resolveProjectAgentId(
  serviceDb: SupabaseClient,
  projectId: string
): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  const { data, error } = await serviceDb.from(PROJECTS_TABLE).select("agent_id").eq("id", projectId).maybeSingle();
  if (error) return { ok: false, error: `Failed to load project '${projectId}': ${error.message}` };
  if (!data) return { ok: false, error: `project_id '${projectId}' does not exist in ${PROJECTS_TABLE}.` };
  return { ok: true, agentId: (data as { agent_id: string }).agent_id };
}

const WI_SCOPING_GAP_NOTE =
  `wi_query has no project_id scoping today (verified 2026-09-16, SDES-DOCM-035 open question) — Work Items ` +
  `intestati a questo progetto NON sono enumerati/controllati da questo tool. Only GTD (via loomx_item_projects) is checked.`;

export async function projectRetire(
  db: SupabaseClient,
  args: ProjectRetireArgs,
  ctx: DocContext
): Promise<DocResult<ProjectRetireResult>> {
  const reason = (args.reason ?? "").trim();
  if (!reason) return err(`reason is required — a project-grain tombstone (SDES-DOCM-031) always carries one.`);
  const dryRun = args.dry_run ?? true;

  if (!ctx.serviceDb) {
    return err(
      `project_retire needs the service-role client (loomx_projects/loomx_item_projects/board_messages are ` +
      `outside doc_rw's grants) — not wired in this context.`
    );
  }
  const serviceDb = ctx.serviceDb;

  // REQ-DOCM-030 legitimacy: the project's responsible agent, or loomy — same
  // scoping rule already in force for gtd_query(project_id) cross-owner read
  // (DEC-002). Never an arbitrary caller.
  const projectAgent = await resolveProjectAgentId(serviceDb, args.project_id);
  if (!projectAgent.ok) return projectAgent;
  if (!ctx.isLoomy && projectAgent.agentId !== ctx.selfSlug) {
    return err(
      `'${ctx.selfSlug}' is not legitimated to retire project '${args.project_id}': only its responsible agent ` +
      `('${projectAgent.agentId}') or loomy can (same rule as gtd_query(project_id) cross-owner read, DEC-002).`
    );
  }

  // Census — every doc_items row in the project, mirroring doc_structure.
  const { data: itemRows, error: itemErr } = await db
    .from(DOC_ITEMS)
    .select("id, document_id, item_type, code, status")
    .eq("project_id", args.project_id);
  if (itemErr) return err(`Failed to read doc_items: ${itemErr.message}`);
  const items = (Array.isArray(itemRows) ? itemRows : []) as Array<{
    id: string; document_id: string; item_type: string; code: string | null; status: string;
  }>;
  const nonTerminal = items.filter((i) => !TERMINAL_STATUSES.has(i.status));
  const alreadyTerminal = items.length - nonTerminal.length;

  const warnings: string[] = [];
  const blocks: ProjectRetireBlock[] = [];
  if (nonTerminal.length > 0) {
    const ids = nonTerminal.map((i) => i.id);
    const { data: linkRows, error: linkErr } = await db.from(DOC_ITEM_LINKS).select("to_item").in("to_item", ids);
    if (linkErr) return err(`Failed to read ${DOC_ITEM_LINKS}: ${linkErr.message}`);
    const { data: xlinkRows, error: xlinkErr } = await db.from(DOC_ITEM_XPROJECT_LINKS).select("to_item").in("to_item", ids);
    if (xlinkErr) return err(`Failed to read ${DOC_ITEM_XPROJECT_LINKS}: ${xlinkErr.message}`);
    const { data: subRows, error: subErr } = await db
      .from(GOV_DOC_SUBSCRIPTIONS)
      .select("target_item_id")
      .in("target_item_id", ids)
      .eq("status", "active");
    if (subErr) return err(`Failed to read ${GOV_DOC_SUBSCRIPTIONS}: ${subErr.message}`);

    const linkCount = new Map<string, number>();
    for (const r of (Array.isArray(linkRows) ? linkRows : []) as Array<{ to_item: string }>) {
      linkCount.set(r.to_item, (linkCount.get(r.to_item) ?? 0) + 1);
    }
    const xlinkCount = new Map<string, number>();
    for (const r of (Array.isArray(xlinkRows) ? xlinkRows : []) as Array<{ to_item: string }>) {
      xlinkCount.set(r.to_item, (xlinkCount.get(r.to_item) ?? 0) + 1);
    }
    const subCount = new Map<string, number>();
    for (const r of (Array.isArray(subRows) ? subRows : []) as Array<{ target_item_id: string }>) {
      subCount.set(r.target_item_id, (subCount.get(r.target_item_id) ?? 0) + 1);
    }

    for (const it of nonTerminal) {
      const l = linkCount.get(it.id) ?? 0;
      const x = xlinkCount.get(it.id) ?? 0;
      const s = subCount.get(it.id) ?? 0;
      if (l > 0 || x > 0 || s > 0) {
        blocks.push({
          item_id: it.id, code: it.code, document_id: it.document_id, item_type: it.item_type,
          status: it.status, links_in: l, xproject_links_in: x, subscriptions_in: s,
        });
      }
    }
  }

  const inVigoreNote =
    `Blocks count RAW incoming references — a referencer's own status is not checked (REQ-DOCM-029/` +
    `SDES-DOCM-034 proposes excluding non-"in vigore" referencers but is NOT applied: it changes a live DB ` +
    `trigger and needs Achille's ratification first, D-136 §5). A project with a live internal REQ→SDES→UAT ` +
    `chain will show blocks here even where every referencer is itself being retired in this same sweep.`;

  if (dryRun) {
    return {
      ok: true,
      data: {
        project_id: args.project_id,
        dry_run: true,
        rows_considered: nonTerminal.length,
        rows_already_terminal: alreadyTerminal,
        blocks,
        retired: [],
        retire_errors: [],
        notify_sent: [],
        notify_warnings: [],
        gtd_closed: [],
        gtd_needs_reassignment: [],
        wi_scoping_gap: WI_SCOPING_GAP_NOTE,
        project_tombstone_written: false,
        atomicity_note:
          `Not atomic across the whole project — each row lives in its own doc_rw transaction (as-built limit of ` +
          `the rest of the model, STOP-001). A dry_run=false run that fails partway reports exactly which rows ` +
          `were retired and which were not, never a bare count.`,
        in_vigore_filter_note: inVigoreNote,
        warnings,
      },
    };
  }

  // dry_run=false: the fresh recomputation above already ran. GATING is
  // narrower than the full preview above: only structural traceability
  // references (links/xproject_links) refuse the bulk execute — an orphaned
  // "verifies"/"references" pointer has no remedy this tool can apply, so
  // zero of THOSE is required project-wide (REQ-DOCM-025's guard, never
  // bypassed in bulk). Active SUBSCRIPTIONS do NOT gate execution: their
  // declared remedy is notification (REQ-DOCM-027), which the execute path
  // below actually performs — gating on their mere existence would make the
  // notify-on-success flow SDES-DOCM-032 asks for structurally unreachable
  // (a subscription that blocks can never reach the "successful retirement"
  // branch that notifies it). `blocks` above still reports subscription
  // counts for full transparency; they just don't refuse.
  const gatingBlocks = blocks.filter((b) => b.links_in > 0 || b.xproject_links_in > 0);
  if (gatingBlocks.length > 0) {
    return err(
      `Refusing to execute: ${gatingBlocks.length} row(s) still have unresolved incoming traceability ` +
      `links/xproject_links (call with dry_run=true for the list). Zero such blocks project-wide is required ` +
      `before dry_run=false can run (REQ-DOCM-025 — the guard applies at project grain too, never bypassed in ` +
      `bulk). Active subscriptions alone do not gate execution — they are notified instead (SDES-DOCM-032).`
    );
  }

  // Execute — reuse doc_item_retire per row for its own re-read/attrs
  // discipline (D-132); more round-trips than a bulk UPDATE, one source of
  // truth for what "retired" means.
  const retired: Array<{ item_id: string; code: string | null }> = [];
  const retireErrors: Array<{ item_id: string; code: string | null; error: string }> = [];
  const allNotify: Array<{ item_id: string; code: string | null; subscriber_owner: string | null }> = [];
  for (const it of nonTerminal) {
    const res = await docItemRetire(db, { project_id: args.project_id, item_id: it.id, reason }, ctx);
    if (!res.ok) {
      retireErrors.push({ item_id: it.id, code: it.code, error: res.error });
      continue;
    }
    retired.push({ item_id: it.id, code: it.code });
    for (const n of res.data.notify) {
      allNotify.push({ item_id: it.id, code: it.code, subscriber_owner: n.subscriber_owner });
    }
    if (res.data.warnings.length) warnings.push(...res.data.warnings.map((w) => `${it.id}: ${w}`));
  }

  // Notify (SDES-DOCM-032) — resolve agent codes and send board_messages
  // directly (regular service-role client, not doc_rw: board_messages is
  // outside doc_rw's grants, same wall as loomx_projects).
  const notifySent: Array<{ to_slug: string; item_id: string; code: string | null }> = [];
  const notifyWarnings: string[] = [];
  const ownersToNotify = Array.from(
    new Set(allNotify.map((n) => n.subscriber_owner).filter((o): o is string => !!o))
  );
  if (ownersToNotify.length > 0) {
    const { data: agentRows, error: agentErr } = await serviceDb
      .from(BOARD_AGENTS_TABLE)
      .select("agent_code, slug")
      .in("slug", [...ownersToNotify, ctx.selfSlug]);
    if (agentErr) {
      notifyWarnings.push(`Could not resolve agent codes for notification: ${agentErr.message}`);
    } else {
      const codeBySlug = new Map(
        ((agentRows ?? []) as Array<{ agent_code: string; slug: string }>).map((a) => [a.slug, a.agent_code])
      );
      const fromCode = codeBySlug.get(ctx.selfSlug);
      for (const n of allNotify) {
        const owner = n.subscriber_owner;
        if (!owner) continue;
        const toCode = codeBySlug.get(owner);
        if (!fromCode || !toCode) {
          notifyWarnings.push(`Owner '${owner}' unresolved in board_agents — no notification sent for item '${n.item_id}'.`);
          continue;
        }
        const { error: msgErr } = await serviceDb.from(BOARD_MESSAGES_TABLE).insert({
          from_agent: fromCode,
          to_agent: toCode,
          type: "info",
          subject: `Project retired: item ${n.code ?? n.item_id} you subscribed to`,
          body: `Project '${args.project_id}' was retired (reason: ${reason}). Item ${n.code ?? n.item_id} you subscribed to is now status='retired', no successor declared.`,
          status: "pending",
        });
        if (msgErr) {
          notifyWarnings.push(`Notification to '${owner}' for item '${n.item_id}' not sent: ${msgErr.message}`);
        } else {
          notifySent.push({ to_slug: owner, item_id: n.item_id, code: n.code });
        }
      }
    }
  }

  // GTD scoping (SDES-DOCM-035) — same cross-owner mechanism already in force
  // for gtd_query(project_id) (DEC-002): loomx_item_projects → loomx_items.
  const { data: gtdLinks, error: gtdLinkErr } = await serviceDb
    .from(GTD_ITEM_PROJECTS_TABLE)
    .select("item_id")
    .eq("project_id", args.project_id);
  if (gtdLinkErr) warnings.push(`GTD scoping could not be read: ${gtdLinkErr.message} — GTD closure/reassignment skipped.`);
  const gtdIds = (Array.isArray(gtdLinks) ? gtdLinks : []).map((r) => (r as { item_id: string }).item_id);
  const gtdClosed: ProjectRetireGtdEntry[] = [];
  const gtdNeedsReassignment: ProjectRetireGtdEntry[] = [];
  if (gtdIds.length > 0) {
    const { data: gtdRows, error: gtdErr } = await serviceDb
      .from(GTD_TABLE)
      .select("id, title, gtd_status")
      .in("id", gtdIds);
    if (gtdErr) {
      warnings.push(`GTD rows could not be read: ${gtdErr.message} — closure/reassignment skipped.`);
    } else {
      const CLOSABLE_UNAMBIGUOUS = new Set(["someday", "waiting"]);
      for (const g of (Array.isArray(gtdRows) ? gtdRows : []) as Array<{ id: string; title: string; gtd_status: string }>) {
        if (g.gtd_status === "done" || g.gtd_status === "trash") continue;
        if (CLOSABLE_UNAMBIGUOUS.has(g.gtd_status)) {
          const { error: closeErr } = await serviceDb
            .from(GTD_TABLE)
            .update({ gtd_status: "done", completed_at: nowIso(), updated_at: nowIso() })
            .eq("id", g.id);
          if (closeErr) {
            warnings.push(`GTD '${g.id}' not closed: ${closeErr.message}`);
            gtdNeedsReassignment.push({ id: g.id, title: g.title, gtd_status: g.gtd_status });
          } else {
            gtdClosed.push({ id: g.id, title: g.title, gtd_status: g.gtd_status });
          }
        } else {
          gtdNeedsReassignment.push({ id: g.id, title: g.title, gtd_status: g.gtd_status });
        }
      }
    }
  }

  // Tombstone (SDES-DOCM-031) — ONLY after rows are clean AND no open
  // needs_reassignment, tassative ordering per SDES-DOCM-031. DBA dependency,
  // NOT yet confirmed live: loomx_projects.retired_at/retired_reason.
  let tombstoneWritten = false;
  let tombstoneNote: string | undefined;
  if (retireErrors.length > 0) {
    tombstoneNote = `Tombstone not written: ${retireErrors.length} row(s) failed to retire — see retire_errors.`;
  } else if (gtdNeedsReassignment.length > 0) {
    tombstoneNote = `Tombstone not written: ${gtdNeedsReassignment.length} GTD item(s) need loomy's reassignment decision first (see gtd_needs_reassignment).`;
  } else {
    const { error: tombErr } = await serviceDb
      .from(PROJECTS_TABLE)
      .update({ retired_at: nowIso(), retired_reason: reason })
      .eq("id", args.project_id);
    if (tombErr) {
      tombstoneNote = `Tombstone write failed (likely loomx_projects.retired_at/retired_reason not yet added by dba, SDES-DOCM-031): ${tombErr.message}`;
    } else {
      tombstoneWritten = true;
    }
  }

  return {
    ok: true,
    data: {
      project_id: args.project_id,
      dry_run: false,
      rows_considered: nonTerminal.length,
      rows_already_terminal: alreadyTerminal,
      blocks: [],
      retired,
      retire_errors: retireErrors,
      notify_sent: notifySent,
      notify_warnings: notifyWarnings,
      gtd_closed: gtdClosed,
      gtd_needs_reassignment: gtdNeedsReassignment,
      wi_scoping_gap: WI_SCOPING_GAP_NOTE,
      project_tombstone_written: tombstoneWritten,
      project_tombstone_note: tombstoneNote,
      atomicity_note:
        `Not atomic across the whole project — each row was retired in its own doc_rw transaction (as-built limit ` +
        `of the rest of the model, STOP-001). retired/retire_errors above are the exact ledger of what landed.`,
      in_vigore_filter_note: inVigoreNote,
      warnings,
    },
  };
}

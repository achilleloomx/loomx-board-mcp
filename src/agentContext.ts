// agent_context() — SDES-001 (project frame-method-as-service, MaaS fase 0).
// Mandate: msg frame f7ff99d9 (2026-09-14), R assigned to board-mcp in the
// project's RACI (SoW DEL-000). Full SDES-001 not readable from this agent's
// identity (D-015 confidentiality — board-mcp has no loomx_project_members
// row on c0f419d8, see board_send c9d8d991 to frame) — built strictly from
// the contract frame's message states, with every field frame did not spell
// out declared explicitly rather than guessed (D-136 §5).
//
// Contract (per frame, subject to frame's review at delivery):
//   - no parameters, identity = ctx.selfSlug (never an input).
//   - role: SAME module org_lookup(agent=self, question="card") uses —
//     buildRoleCard below, shared by both call sites, not a duplicate.
//   - constitution: ONE call to gov.applicable_norms(p_agent := self), every
//     other parameter left to its SQL-side DEFAULT (NULL). dba is building
//     this function in parallel (session #172 findings folded into SDES-005/
//     006 per frame's message) — until it exists, fail-open and SAY SO:
//     constitution: null, constitution_unavailable: "gov.applicable_norms missing: <detail>".
//     Never a query built in TS against decision rows directly (REQ-009).
//   - work: active WI (findActiveForAgent) + GTD armed/next_action (top 5,
//     no body — same omission the rest of the payload follows) +
//     pending_inbox/pending_wakes (D-205/D-238, self-close semantics: caller
//     IS the owner here by construction, so these are never the orphan-sweep
//     `undefined`).
//   - payload_version: "0". No free-text body anywhere in the response.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WiResult } from "./wi.js";
import type { PendingInboxInfo, PendingWakesInfo, PendingInboxRegistry } from "./pendingInbox.js";

const ROLE_CARDS_TABLE = "loomx_role_cards";
const ORG_EDGES_TABLE = "loomx_org_edges";
const WI_TABLE = "loomx_work_items";
const GTD_TABLE = "loomx_items";

// GTD fetch is bounded then filtered/sorted in JS (never `.or("autopilot.eq.true,...")`
// against the pg-shim: its `.or()` parser pushes the raw string as the bound
// param, and a boolean column compared to a text param is exactly the kind of
// implicit-coercion behavior this repo doesn't trust without a live check —
// same caution as D-119). 100 is a soft cap: rows already arrive priority_rank
// DESC / deadline ASC, so a top-5 slice after the JS filter never drops a
// higher-priority armed/next_action item ahead of a lower one still inside
// the fetched page.
const GTD_FETCH_CAP = 100;
const GTD_TOP_N = 5;

export interface RoleCardResult {
  agent: string;
  role_card: {
    mission?: string;
    does?: unknown;
    does_not?: unknown;
    scope_notes?: unknown;
    human_ref?: string | null;
    updated_at?: string;
  } | null;
  reports_to: string | null;
  human_ref: string | null;
  escalates_to: unknown[];
  asks_help_from: unknown[];
  note?: string;
}

// Shared by org_lookup(agent=self, question="card") and agent_context().role —
// ONE implementation, per SDES-001's explicit ask ("stesso modulo").
export async function buildRoleCard(db: SupabaseClient, agentSlug: string): Promise<WiResult<RoleCardResult>> {
  const { data: card, error: cardErr } = await db
    .from(ROLE_CARDS_TABLE)
    .select("mission, does, does_not, scope_notes, human_ref, updated_at")
    .eq("agent_slug", agentSlug)
    .maybeSingle();
  if (cardErr) return { ok: false, error: `Error reading role card: ${cardErr.message}` };

  const { data: edges, error: edgesErr } = await db
    .from(ORG_EDGES_TABLE)
    .select("to_agent, edge_type, domain, note")
    .eq("from_agent", agentSlug);
  if (edgesErr) return { ok: false, error: `Error reading org edges: ${edgesErr.message}` };

  const edgeRows = (edges ?? []) as { to_agent: string; edge_type: string; domain: string | null; note: string | null }[];
  const reportsTo = edgeRows.find((e) => e.edge_type === "reports_to")?.to_agent ?? null;
  const escalatesTo = edgeRows.filter((e) => e.edge_type === "escalates_to");
  const asksHelpFrom = edgeRows.filter((e) => e.edge_type === "asks_help_from");
  const cardHumanRef = card ? (card as { human_ref: string | null }).human_ref : null;

  if (!card && edgeRows.length === 0) {
    return {
      ok: true,
      data: {
        agent: agentSlug,
        role_card: null,
        reports_to: null,
        human_ref: null,
        escalates_to: [],
        asks_help_from: [],
        note: "no org-registry data for this agent yet (F2 seed pending?)",
      },
    };
  }

  return {
    ok: true,
    data: {
      agent: agentSlug,
      role_card: (card as RoleCardResult["role_card"]) ?? null,
      reports_to: reportsTo,
      human_ref: cardHumanRef,
      escalates_to: escalatesTo,
      asks_help_from: asksHelpFrom,
    },
  };
}

// Single RPC, fail-open (SDES-001/005 contract per frame): the function may not
// exist yet (dba building it in parallel) — never throws, never blocks the rest
// of the payload, always names what happened.
async function fetchConstitution(
  db: SupabaseClient,
  selfSlug: string
): Promise<{ constitution: unknown[] | null; constitution_unavailable?: string }> {
  try {
    const { data, error } = await db.rpc("gov.applicable_norms", { p_agent: selfSlug });
    if (error) {
      process.stderr.write(`[agent_context] gov.applicable_norms unavailable (non-blocking): ${error.message}\n`);
      return { constitution: null, constitution_unavailable: `gov.applicable_norms missing: ${error.message}` };
    }
    return { constitution: Array.isArray(data) ? data : data == null ? [] : [data] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[agent_context] gov.applicable_norms threw (non-blocking): ${msg}\n`);
    return { constitution: null, constitution_unavailable: `gov.applicable_norms missing: ${msg}` };
  }
}

interface WorkResult {
  active_wi: Record<string, unknown> | null;
  gtd_top: Record<string, unknown>[];
  gtd_top_error?: string;
  pending_inbox: PendingInboxInfo | undefined;
  pending_wakes: PendingWakesInfo | undefined;
}

async function fetchWork(
  db: SupabaseClient,
  registry: PendingInboxRegistry,
  selfSlug: string,
  now: string
): Promise<WorkResult> {
  const { data: wiRows, error: wiErr } = await db
    .from(WI_TABLE)
    .select("id, gtd_item_id, intent, status, template_name, started_at, last_checkpoint_at")
    .eq("agent_slug", selfSlug)
    .eq("status", "active")
    .limit(1);
  const activeWi = !wiErr && Array.isArray(wiRows) && wiRows.length > 0 ? (wiRows[0] as Record<string, unknown>) : null;
  if (wiErr) process.stderr.write(`[agent_context] active WI read failed (non-blocking): ${wiErr.message}\n`);

  const { data: gtdRows, error: gtdErr } = await db
    .from(GTD_TABLE)
    .select("id,title,gtd_status,priority,priority_rank,deadline,waiting_on,autopilot,autopilot_model,project_id,updated_at")
    .eq("owner", selfSlug)
    .not("gtd_status", "in", "(done,trash)")
    .order("priority_rank", { ascending: false })
    .order("deadline", { ascending: true, nullsFirst: false })
    .limit(GTD_FETCH_CAP);

  let gtdTop: Record<string, unknown>[] = [];
  let gtdTopError: string | undefined;
  if (gtdErr) {
    gtdTopError = gtdErr.message;
    process.stderr.write(`[agent_context] GTD read failed (non-blocking): ${gtdErr.message}\n`);
  } else {
    const rows = (gtdRows ?? []) as Record<string, unknown>[];
    gtdTop = rows.filter((r) => r.autopilot === true || r.gtd_status === "next_action").slice(0, GTD_TOP_N);
  }

  const { computePendingInbox, computePendingWakes } = await import("./pendingInbox.js");
  const pendingInbox = await computePendingInbox(db, registry, selfSlug, selfSlug, now);
  const pendingWakes = await computePendingWakes(db, registry, selfSlug, selfSlug);

  return {
    active_wi: activeWi,
    gtd_top: gtdTop,
    ...(gtdTopError ? { gtd_top_error: gtdTopError } : {}),
    pending_inbox: pendingInbox,
    pending_wakes: pendingWakes,
  };
}

export interface AgentContextPayload {
  payload_version: "0";
  agent: string;
  role: RoleCardResult;
  constitution: unknown[] | null;
  constitution_unavailable?: string;
  work: WorkResult;
}

export interface AgentContextCtx {
  selfSlug: string;
  slugToCode: Map<string, string>;
  codeToSlug: Map<string, string>;
}

export async function agentContext(db: SupabaseClient, ctx: AgentContextCtx): Promise<WiResult<AgentContextPayload>> {
  const roleRes = await buildRoleCard(db, ctx.selfSlug);
  if (!roleRes.ok) return roleRes;

  const now = new Date().toISOString();
  const [constitutionRes, work] = await Promise.all([
    fetchConstitution(db, ctx.selfSlug),
    fetchWork(db, ctx, ctx.selfSlug, now),
  ]);

  return {
    ok: true,
    data: {
      payload_version: "0",
      agent: ctx.selfSlug,
      role: roleRes.data,
      constitution: constitutionRes.constitution,
      ...(constitutionRes.constitution_unavailable ? { constitution_unavailable: constitutionRes.constitution_unavailable } : {}),
      work,
    },
  };
}

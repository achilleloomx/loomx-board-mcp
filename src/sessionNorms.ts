// T2 minimo (P2-P3) — SDES-001 v1 / SDES-005 v1, project frame-method-as-service
// (c0f419d8). Task frame msg 1a7ed39d, delega GM-001.
//
// Three things live here, and ONLY here:
//   1. THE call to the norms-derivation RPC (REQ-009: one implementation of the
//      computation, two consumers — agent_context and wi_start/wi_resume both go
//      through fetchApplicableNorms below; nothing in this repo computes a norm
//      set in TypeScript, it only diffs what the RPC returned against what the
//      session already holds).
//   2. The session registry (epochs + delivered Decisions) and the per-WI due set.
//   3. How a long-lived stdio process learns which session/epoch it is serving.
//
// The schema (gov.session_epochs / gov.session_norms / gov.wi_norms) is dba's,
// landing in ONE migration (task 7/9). Table and column names are isolated in
// the constants + makeDocRwSessionStore below. Contract: dba msg af4c0e19
// (answer to 87601fc3) — epochs opened only by gov.session_epoch_open,
// `agent_code` derived DB-side, source_project_id inside both keys, `version`
// inside the session_norms key (insert-only table), form ∈ {compact, full}.
//
// No Thread slug, project id or Decision code is hardcoded anywhere in this
// file (UAT-002 ramo C greps src/ for it): which Threads are critical is
// decided by the container registry behind the RPC, never here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocRwDb } from "./docDb.js";

export const SESSION_EPOCHS_TABLE = "gov.session_epochs";
export const SESSION_NORMS_TABLE = "gov.session_norms";
export const WI_NORMS_TABLE = "gov.wi_norms";
const NORMS_RPC = "gov.applicable_norms";

// An epoch opened earlier than this before the process booted cannot be the
// one this process is serving (SessionStart hook and MCP spawn are roughly
// concurrent at startup; the tolerance covers their ordering, nothing more).
const BOOT_TOLERANCE_MS = 120_000;

export const EPOCH_TRIGGERS = ["startup", "resume", "clear", "compact"] as const;
export type EpochTrigger = (typeof EPOCH_TRIGGERS)[number] | "mcp_implicit";

export interface NormSource {
  thread_slug?: string;
  project_slug?: string;
  project_id: string;
  document_id?: string;
}

export interface Norm {
  code: string;
  version: string;
  grade: number | null;
  grade_source: string | null;
  title: string | null;
  summary: string | null;
  source: NormSource;
  sources: string[];
}

export interface ApplicableNorms {
  norms: Norm[];
  critical_threads: string[];
  critical_core_unpublished: string[];
  critical_registry_empty: boolean;
  houses_unresolved: string[];
  // Declared, never hidden: until dba's v1 migration is applied the live
  // function still answers with the v0 contract (no `norms` key, no registry
  // of containers) — the consumer must be able to tell "v1 says empty" from
  // "v0 is still answering".
  rpc_contract_version: string | null;
}

export type NormsResult = { ok: true; data: ApplicableNorms } | { ok: false; error: string };

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Whitelist projection: a `body` (or any key the contract does not name) that
// the RPC might one day carry can never reach a payload through here (UAT-005).
function toNorm(raw: unknown): Norm | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const src = (r.source && typeof r.source === "object" ? r.source : {}) as Record<string, unknown>;
  if (typeof r.code !== "string" || typeof src.project_id !== "string") return null;
  const source: NormSource = { project_id: src.project_id };
  if (typeof src.thread_slug === "string") source.thread_slug = src.thread_slug;
  if (typeof src.project_slug === "string") source.project_slug = src.project_slug;
  if (typeof src.document_id === "string") source.document_id = src.document_id;
  return {
    code: r.code,
    version: r.version == null ? "" : String(r.version),
    grade: typeof r.grade === "number" ? r.grade : r.grade == null ? null : Number(r.grade),
    grade_source: typeof r.grade_source === "string" ? r.grade_source : null,
    title: typeof r.title === "string" ? r.title : null,
    summary: typeof r.summary === "string" ? r.summary : null,
    source,
    sources: asStringArray(r.sources),
  };
}

// The single RPC call site. projectId=null → every other parameter stays at
// its SQL DEFAULT (NULL) → the function returns the critical core only.
export async function fetchApplicableNorms(
  db: SupabaseClient,
  agentSlug: string,
  projectId: string | null
): Promise<NormsResult> {
  try {
    const params: Record<string, unknown> = { p_agent: agentSlug };
    if (projectId) params.p_project_id = projectId;
    const { data, error } = await db.rpc(NORMS_RPC, params);
    if (error) return { ok: false, error: error.message };
    const obj = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    if (!obj || typeof obj !== "object") return { ok: false, error: "RPC returned no object" };

    const rawNorms = Array.isArray(obj.norms) ? obj.norms : [];
    const dropped: unknown[] = [];
    const norms: Norm[] = [];
    for (const raw of rawNorms) {
      const n = toNorm(raw);
      if (n) norms.push(n);
      else dropped.push(raw);
    }
    if (dropped.length > 0) {
      // A row without code/source.project_id cannot be keyed (D-167) — refusing
      // the whole set is safer than silently delivering a shorter one.
      return { ok: false, error: `RPC returned ${dropped.length} norm row(s) without code/source.project_id` };
    }
    return {
      ok: true,
      data: {
        norms,
        critical_threads: asStringArray(obj.critical_threads),
        critical_core_unpublished: asStringArray(obj.critical_core_unpublished),
        critical_registry_empty: obj.critical_registry_empty === true,
        houses_unresolved: asStringArray(obj.houses_unresolved),
        rpc_contract_version:
          typeof obj.contract_version === "string" ? obj.contract_version : Array.isArray(obj.norms) ? null : "v0",
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Codes are unique per project, never globally (D-167): two Threads may both
// own a "DEC-001". The identity of a Decision is (owning project, code).
export function normKey(n: { code: string; source: { project_id: string } }): string {
  return `${n.source.project_id}:${n.code}`;
}

export function isCritical(n: Norm): boolean {
  return n.sources.includes("critical");
}

function originLabel(n: Norm): string {
  return n.source.thread_slug ?? n.source.project_slug ?? n.source.project_id;
}

// "CODE vN [thread] titolo — riassunto" (SDES-001 v1, forma --compact).
export function compactNormLine(n: Norm): string {
  const head = `${n.code} v${n.version || "?"} [${originLabel(n)}]`;
  const title = n.title ?? "";
  return n.summary ? `${head} ${title} — ${n.summary}`.trim() : `${head} ${title}`.trim();
}

export function bytesOf(v: unknown): number {
  return Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");
}

// --- diff ----------------------------------------------------------------

export interface NormsDiff {
  delivered: Norm[];
  already: Norm[];
}

export function deliveryKey(n: { code: string; version: string; source: { project_id: string } }): string {
  return `${normKey(n)}@${n.version}`;
}

// delivered = not in this epoch AT THIS VERSION (UAT-017 last bullet: a Thread
// that republished comes back with the new version). The registry is
// insert-only with the version inside its key, so an epoch may hold several
// versions of one Decision — hence a set of (project, code, version), not a
// code→version map.
export function diffAgainstEpoch(due: Norm[], inEpoch: Set<string>): NormsDiff {
  const delivered: Norm[] = [];
  const already: Norm[] = [];
  for (const n of due) {
    if (inEpoch.has(deliveryKey(n))) already.push(n);
    else delivered.push(n);
  }
  return { delivered, already };
}

// SDES-005: `already_in_session` = codes only. A bare code is qualified with
// its origin ONLY when the same code appears twice in the due set (UAT-018
// homonyms) — otherwise two different Decisions would read as one.
export function codesOf(list: Norm[], universe: Norm[]): string[] {
  const seen = new Map<string, number>();
  for (const n of universe) seen.set(n.code, (seen.get(n.code) ?? 0) + 1);
  return list.map((n) => ((seen.get(n.code) ?? 0) > 1 ? `${originLabel(n)}:${n.code}` : n.code));
}

// --- session store -------------------------------------------------------

// dba CHECK on gov.session_norms.form. "compact" = one line / no-body row (the
// hook text, the wi_start delivered[] list); "full" = the agent_context payload.
export type DeliveryForm = "compact" | "full";

export interface SessionRef {
  id: string;
  epoch: number;
}

export interface SessionStore {
  openEpoch(sessionId: string, trigger: EpochTrigger, hostPid: number | null): Promise<SessionRef>;
  // Latest epoch this process can legitimately call its own — see resolveCurrentSession.
  findEpochs(sinceIso: string): Promise<Array<SessionRef & { host_pid: number | null }>>;
  // Set of deliveryKey() — (project, code, version) triples held by the epoch.
  readDelivered(session: SessionRef): Promise<Set<string>>;
  recordDelivered(session: SessionRef, norms: Norm[], form: DeliveryForm): Promise<void>;
  writeWiNorms(wiId: string, norms: Norm[]): Promise<void>;
}

type Runner = <T>(slug: string, fn: (db: DocRwDb) => Promise<T>) => Promise<T>;

function check(res: { error: { message: string } | null }, what: string): void {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
}

// Writes go under doc_rw with the caller's slug in the GUC (same path as every
// doc_*/gov.* write in this server) — `agent` is the instance's own slug, a
// bound value, never tool input.
export function makeDocRwSessionStore(selfSlug: string, run: Runner): SessionStore {
  return {
    async openEpoch(sessionId, trigger, hostPid) {
      return run(selfSlug, async (db) => ({ id: sessionId, epoch: await db.sessionEpochOpen(sessionId, trigger, hostPid) }));
    },

    // No agent filter: RLS shows this caller its own epochs only.
    async findEpochs(sinceIso) {
      return run(selfSlug, async (db) => {
        const res = await db
          .from(SESSION_EPOCHS_TABLE)
          .select("session_id, epoch, host_pid, opened_at")
          .gte("opened_at", sinceIso)
          .order("opened_at", { ascending: false })
          .limit(20);
        check(res, "read epochs");
        return ((res.data ?? []) as Array<{ session_id: string; epoch: unknown; host_pid: unknown }>).map((r) => ({
          id: r.session_id,
          epoch: Number(r.epoch),
          host_pid: r.host_pid == null ? null : Number(r.host_pid),
        }));
      });
    },

    async readDelivered(session) {
      return run(selfSlug, async (db) => {
        const res = await db
          .from(SESSION_NORMS_TABLE)
          .select("source_project_id, code, version")
          .eq("session_id", session.id)
          .eq("epoch", session.epoch);
        check(res, "read session norms");
        const held = new Set<string>();
        for (const r of (res.data ?? []) as Array<{ source_project_id: string; code: string; version: unknown }>) {
          held.add(`${r.source_project_id}:${r.code}@${r.version == null ? "" : String(r.version)}`);
        }
        return held;
      });
    },

    // Insert-only table, version inside the key: DO NOTHING makes a re-delivery
    // idempotent, and a changed version is simply a new row. agent_code is
    // read from the epoch row (the composite FK proves the epoch is ours; an
    // epoch that does not exist is a 23503, never a silent success).
    async recordDelivered(session, norms, form) {
      if (norms.length === 0) return;
      await run(selfSlug, async (db) => {
        const ep = await db
          .from(SESSION_EPOCHS_TABLE)
          .select("agent_code")
          .eq("session_id", session.id)
          .eq("epoch", session.epoch)
          .maybeSingle();
        check(ep, "read epoch row");
        const agentCode = (ep.data as { agent_code?: string } | null)?.agent_code;
        if (!agentCode) throw new Error(`epoch ${session.id}/${session.epoch} not found (or not this agent's)`);
        const res = await db.from(SESSION_NORMS_TABLE).upsert(
          norms.map((n) => ({
            session_id: session.id,
            epoch: session.epoch,
            agent_code: agentCode,
            source_project_id: n.source.project_id,
            code: n.code,
            version: n.version,
            form,
          })),
          { onConflict: "session_id,epoch,source_project_id,code,version", ignoreDuplicates: true, noSyntheticId: true }
        );
        check(res, "write session norms");
      });
    },

    // The WHOLE due set, not the delivered difference (SDES-005). DO NOTHING:
    // delivery facts are immutable, a resume must never rewrite them (dba Q1).
    async writeWiNorms(wiId, norms) {
      if (norms.length === 0) return;
      await run(selfSlug, async (db) => {
        const res = await db.from(WI_NORMS_TABLE).upsert(
          norms.map((n) => ({
            wi_id: wiId,
            source_project_id: n.source.project_id,
            code: n.code,
            version: n.version,
            grade: n.grade,
            sources: n.sources,
          })),
          { onConflict: "wi_id,source_project_id,code", ignoreDuplicates: true, noSyntheticId: true }
        );
        check(res, "write wi norms");
      });
    },
  };
}

// --- which session is this process serving? ------------------------------
//
// A stdio MCP server outlives /clear and compaction and never sees them; the
// runtime does. The SessionStart hook (board-cli) opens the epochs; this
// process has to find "its" one. Measured 2026-09-19 on Claude Code 2.1.277:
//   - the MCP server is a DIRECT child of the Claude Code process (process.ppid
//     is Claude's pid) and the hook environment carries CLAUDE_PID — same value,
//     stable across /clear (where session_id changes) → exact binding;
//   - the MCP env carries CLAUDE_CODE_SESSION_ID, but frozen at spawn: after a
//     /clear it names a session that no longer exists. Used only to NAME an
//     implicit session, never to look one up.
// Order:
//   1. latest epoch of this agent, opened since boot, with host_pid == my ppid;
//   2. else latest epoch of this agent, opened since boot, with host_pid NULL
//      (hook could not tell its host) — an epoch carrying a DIFFERENT host_pid
//      is another concurrent session of the same agent and is never adopted;
//   3. else this process opens an implicit epoch itself (agent without hook,
//      or hook failed: the REQ-032 grace path needs somewhere to record).
// Declared limit (two concurrent sessions of one agent, both with host_pid
// NULL): rule 2 may adopt the sibling's epoch, so a non-critical Decision the
// sibling received can be reported `already_in_session` here. gov.wi_norms
// still holds the whole due set, so the audit can see it; the critical core
// is unaffected (both sessions received it at their own start).

export interface HostInfo {
  hostPid: number | null;
  bootedAt: Date;
  envSessionId: string | null;
}

export function processHostInfo(): HostInfo {
  return {
    hostPid: Number.isInteger(process.ppid) && process.ppid > 1 ? process.ppid : null,
    bootedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)),
    envSessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
  };
}

export async function resolveCurrentSession(
  store: SessionStore,
  selfSlug: string,
  host: HostInfo
): Promise<SessionRef & { implicit: boolean }> {
  const since = new Date(host.bootedAt.getTime() - BOOT_TOLERANCE_MS).toISOString();
  const epochs = await store.findEpochs(since);
  const mine = host.hostPid != null ? epochs.find((e) => e.host_pid === host.hostPid) : undefined;
  const chosen = mine ?? epochs.find((e) => e.host_pid == null);
  if (chosen) return { id: chosen.id, epoch: chosen.epoch, implicit: false };

  const sessionId = host.envSessionId ?? `mcp-${selfSlug}-${process.pid}-${host.bootedAt.getTime()}`;
  const opened = await store.openEpoch(sessionId, "mcp_implicit", host.hostPid);
  return { ...opened, implicit: true };
}

// --- wi_start / wi_resume (SDES-005 v1) ----------------------------------

const GTD_ITEM_PROJECTS_TABLE = "loomx_item_projects";
export const NO_PROJECT_HOUSE = "<no project>";
export const E_CRITICAL_CORE_MISSING = "E_CRITICAL_CORE_MISSING";

export interface WiNormsDeps {
  store: SessionStore;
  host: HostInfo;
  // REQ-032 hard phase — off unless the flag names this slug.
  hardGate: boolean;
}

// Keys added to the wi_start / wi_resume response. Flat on purpose: SDES-005
// and UAT-009/017/020 name them as top-level response fields.
export interface WiNormsFields {
  delivered?: Norm[];
  already_in_session?: string[];
  critical_core_delivered_at_wi_start?: boolean;
  houses_unresolved?: string[];
  critical_core_unpublished?: string[];
  critical_registry_empty?: boolean;
  list_bytes?: number;
  norms_session?: SessionRef | null;
  norms_project_id?: string | null;
  norms_project_note?: string;
  norms_registry_warning?: string;
  norms_unavailable?: string;
}

export type PreparedWiNorms =
  | { kind: "unavailable"; fields: WiNormsFields }
  | { kind: "refused"; error: string }
  | { kind: "ready"; due: Norm[]; delivered: Norm[]; session: SessionRef | null; fields: WiNormsFields };

async function projectOfGtd(
  db: SupabaseClient,
  gtdId: string | undefined
): Promise<{ projectId: string | null; note?: string }> {
  if (!gtdId) return { projectId: null };
  const { data, error } = await db.from(GTD_ITEM_PROJECTS_TABLE).select("project_id").eq("item_id", gtdId);
  if (error) return { projectId: null, note: `project lookup failed: ${error.message}` };
  const ids = ((data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id).sort();
  if (ids.length === 0) return { projectId: null };
  if (ids.length > 1) {
    // The RPC takes ONE project and the union is its job, not ours (REQ-009):
    // never merged here. Deterministic pick, declared.
    return {
      projectId: ids[0]!,
      note: `GTD linked to ${ids.length} projects (${ids.join(", ")}); due set computed for ${ids[0]} only`,
    };
  }
  return { projectId: ids[0]! };
}

// Everything that can be decided BEFORE the WI row exists: the due set, the
// difference against the current epoch, and (hard phase only) the refusal.
// Computed first so a refusal never leaves a half-opened WI behind; the two
// writes that need the wi_id happen in commitWiNorms.
export async function prepareWiNorms(
  db: SupabaseClient,
  deps: WiNormsDeps,
  agentSlug: string,
  gtdId: string | undefined
): Promise<PreparedWiNorms> {
  const { projectId, note } = await projectOfGtd(db, gtdId);
  const res = await fetchApplicableNorms(db, agentSlug, projectId);
  if (!res.ok) {
    process.stderr.write(`[wi_norms] norms RPC unavailable (non-blocking): ${res.error}\n`);
    return { kind: "unavailable", fields: { norms_unavailable: res.error } };
  }
  const due = res.data.norms;

  let session: SessionRef | null = null;
  let inEpoch = new Set<string>();
  let registryWarning: string | undefined;
  try {
    const ref = await resolveCurrentSession(deps.store, agentSlug, deps.host);
    session = { id: ref.id, epoch: ref.epoch };
    inEpoch = await deps.store.readDelivered(session);
  } catch (e) {
    // Registry unreadable → nothing can be proven held → deliver everything.
    // Over-delivery is the safe direction; it is declared, never silent.
    session = null;
    registryWarning = `session registry unavailable, whole due set delivered: ${e instanceof Error ? e.message : String(e)}`;
    process.stderr.write(`[wi_norms] ${registryWarning}\n`);
  }

  const diff = diffAgainstEpoch(due, inEpoch);
  const criticalMissing = diff.delivered.filter(isCritical);

  if (deps.hardGate && session && criticalMissing.length > 0) {
    return {
      kind: "refused",
      error:
        `${E_CRITICAL_CORE_MISSING}: session ${session.id} epoch ${session.epoch} has not received ` +
        `${criticalMissing.length} critical Decision(s) at their current version ` +
        `(${codesOf(criticalMissing, due).join(", ")}). Call agent_context() and retry wi_start.`,
    };
  }

  const housesUnresolved = [...res.data.houses_unresolved];
  if (!projectId && !housesUnresolved.includes(NO_PROJECT_HOUSE)) housesUnresolved.push(NO_PROJECT_HOUSE);

  return {
    kind: "ready",
    due,
    delivered: diff.delivered,
    session,
    fields: {
      delivered: diff.delivered,
      already_in_session: codesOf(diff.already, due),
      critical_core_delivered_at_wi_start: criticalMissing.length > 0,
      houses_unresolved: housesUnresolved,
      critical_core_unpublished: res.data.critical_core_unpublished,
      critical_registry_empty: res.data.critical_registry_empty,
      list_bytes: bytesOf(diff.delivered),
      norms_session: session,
      norms_project_id: projectId,
      ...(note ? { norms_project_note: note } : {}),
      ...(registryWarning ? { norms_registry_warning: registryWarning } : {}),
    },
  };
}

// writeDueSet=false on wi_resume: gov.wi_norms is written once, at wi_start.
export async function commitWiNorms(
  deps: WiNormsDeps,
  prepared: Extract<PreparedWiNorms, { kind: "ready" }>,
  wiId: string,
  writeDueSet: boolean
): Promise<WiNormsFields> {
  const warnings: string[] = prepared.fields.norms_registry_warning ? [prepared.fields.norms_registry_warning] : [];
  if (writeDueSet) {
    try {
      await deps.store.writeWiNorms(wiId, prepared.due);
    } catch (e) {
      warnings.push(`gov.wi_norms not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (prepared.session) {
    try {
      await deps.store.recordDelivered(prepared.session, prepared.delivered, "compact");
    } catch (e) {
      warnings.push(`gov.session_norms not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const w of warnings) process.stderr.write(`[wi_norms] ${w}\n`);
  return { ...prepared.fields, ...(warnings.length > 0 ? { norms_registry_warning: warnings.join(" | ") } : {}) };
}

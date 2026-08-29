// id_resolve — prefix → full-UUID resolution as a service (REQ-039 / SDES-ID-002).
//
// Origin: mandate Achille 29/08 → D-241. Measured that same day: three ids
// hand-completed from 8-char prefixes (padded with zeros — two blocked by
// tools, one caught by review), plus one CONTAMINATION (the tail of one UUID
// glued to the head of another). All of them born in jq distillates of
// over-limit tool outputs. The behavioural norm ("an identifier is copied
// whole or resolved with a tool, never completed or recomposed by hand" —
// environment-domain manifesto, posa C3) needs the tool to exist. This is it.
//
// Mechanism — range scan, zero DDL: a normalized hex prefix defines a closed
// UUID interval [prefix padded with '0', prefix padded with 'f']. Comparing
// id >= lower AND id <= upper on a uuid column IS the prefix match (uuid
// ordering is bytewise), and both PostgREST (gte/lte) and plain SQL support
// it. No DB function, no unsupported cast, no DBA dependency.
//
// Visibility is the caller's own — never a bypass:
//   gtd_item      loomx_items (service role), owner=self unless loomy/broker
//                 (mirror of gtd_query's cross-agent rule), soft-deleted excluded
//   board_message board_messages, from/to=self unless loomy (broker also sees
//                 loomy's inbox — mirror of resolveBoardActorFilterCode)
//   project       loomx_projects, unscoped (mirror of project_list)
//   doc_item      via doc_rw (RLS-aware, D-a5 F4.5)
//   document      via doc_rw (RLS-aware)
// A kind that cannot be searched from this instance's configuration (e.g. no
// doc_rw backend) is DECLARED in the response/error — never silently skipped
// (REQ-038: silence dressed as absence is the defect class this cantiere closes).

import type { SupabaseClient } from "@supabase/supabase-js";

export const ID_KINDS = ["gtd_item", "board_message", "project", "doc_item", "document"] as const;
export type IdKind = (typeof ID_KINDS)[number];

// Enough to prove ambiguity and list it; never meant to page through a range.
export const PER_KIND_CANDIDATE_LIMIT = 6;

export interface IdResolveScope {
  selfSlug: string;
  selfCode: string;
  isLoomy: boolean;
  isBroker: boolean;
  loomyCode?: string;
}

export interface IdCandidate {
  kind: IdKind;
  id: string;
  label: string | null;
}

export interface IdResolveData {
  id: string;
  kind: IdKind;
  label: string | null;
  prefix: string;
  kinds_searched: IdKind[];
  kinds_not_searched?: Array<{ kind: IdKind; reason: string }>;
}

export type IdResolveResult = { ok: true; data: IdResolveData } | { ok: false; error: string };

export function normalizeIdPrefix(input: string): { ok: true; hex: string } | { ok: false; error: string } {
  const raw = String(input ?? "").trim().toLowerCase();
  const hex = raw.replace(/-/g, "");
  if (!/^[0-9a-f]+$/.test(hex)) {
    return {
      ok: false,
      error: `prefix '${input}' is not hexadecimal (after removing dashes). An id prefix contains only 0-9a-f — if this came from a distillate, re-copy the id whole instead of reassembling it.`,
    };
  }
  if (hex.length < 8) {
    return {
      ok: false,
      error: `prefix '${input}' is ${hex.length} hex chars — at least 8 are required (REQ-039). Below that a candidate list is noise, not resolution.`,
    };
  }
  if (hex.length > 32) {
    return { ok: false, error: `prefix '${input}' is ${hex.length} hex chars — a full UUID has 32. Check for contamination (two ids glued together).` };
  }
  return { ok: true, hex };
}

export function prefixToUuidRange(hex: string): { lower: string; upper: string } {
  const fmt = (s: string) => `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  return { lower: fmt(hex.padEnd(32, "0")), upper: fmt(hex.padEnd(32, "f")) };
}

interface KindSearchOutcome {
  candidates: IdCandidate[];
  error?: string;
}

async function searchGtdItems(db: SupabaseClient, range: { lower: string; upper: string }, scope: IdResolveScope): Promise<KindSearchOutcome> {
  let q = db
    .from("loomx_items")
    .select("id, title, owner")
    .gte("id", range.lower)
    .lte("id", range.upper)
    .is("deleted_at", null)
    .limit(PER_KIND_CANDIDATE_LIMIT);
  if (!scope.isLoomy && !scope.isBroker) q = q.eq("owner", scope.selfSlug);
  const { data, error } = await q;
  if (error) return { candidates: [], error: error.message };
  return {
    candidates: ((data ?? []) as Array<{ id: string; title: string | null }>).map((r) => ({
      kind: "gtd_item",
      id: r.id,
      label: r.title ?? null,
    })),
  };
}

async function searchBoardMessages(db: SupabaseClient, range: { lower: string; upper: string }, scope: IdResolveScope): Promise<KindSearchOutcome> {
  // Two scoped queries (to / from) instead of a PostgREST `or` filter: simpler
  // to mirror in tests, and the merge dedupes on id anyway.
  const codes = scope.isBroker && scope.loomyCode ? [scope.selfCode, scope.loomyCode] : [scope.selfCode];
  const byId = new Map<string, IdCandidate>();
  const directions: Array<"to_agent" | "from_agent"> = ["to_agent", "from_agent"];
  for (const dir of directions) {
    let q = db
      .from("board_messages")
      .select("id, subject")
      .gte("id", range.lower)
      .lte("id", range.upper)
      .limit(PER_KIND_CANDIDATE_LIMIT);
    if (!scope.isLoomy) q = q.in(dir, codes);
    const { data, error } = await q;
    if (error) return { candidates: [], error: error.message };
    for (const r of (data ?? []) as Array<{ id: string; subject: string | null }>) {
      byId.set(r.id, { kind: "board_message", id: r.id, label: r.subject ?? null });
    }
    // Loomy's unscoped query already saw everything — the second direction
    // would be the identical query again.
    if (scope.isLoomy) break;
  }
  return { candidates: [...byId.values()].slice(0, PER_KIND_CANDIDATE_LIMIT) };
}

async function searchProjects(db: SupabaseClient, range: { lower: string; upper: string }): Promise<KindSearchOutcome> {
  const { data, error } = await db
    .from("loomx_projects")
    .select("id, name")
    .gte("id", range.lower)
    .lte("id", range.upper)
    .limit(PER_KIND_CANDIDATE_LIMIT);
  if (error) return { candidates: [], error: error.message };
  return {
    candidates: ((data ?? []) as Array<{ id: string; name: string | null }>).map((r) => ({
      kind: "project",
      id: r.id,
      label: r.name ?? null,
    })),
  };
}

async function searchDocKind(db: SupabaseClient, kind: "doc_item" | "document", range: { lower: string; upper: string }): Promise<KindSearchOutcome> {
  if (kind === "doc_item") {
    const { data, error } = await db
      .from("doc_items")
      .select("id, code, item_type")
      .gte("id", range.lower)
      .lte("id", range.upper)
      .limit(PER_KIND_CANDIDATE_LIMIT);
    if (error) return { candidates: [], error: error.message };
    return {
      candidates: ((data ?? []) as Array<{ id: string; code: string | null; item_type: string }>).map((r) => ({
        kind: "doc_item",
        id: r.id,
        label: r.code ?? r.item_type ?? null,
      })),
    };
  }
  const { data, error } = await db
    .from("documents")
    .select("id, title")
    .gte("id", range.lower)
    .lte("id", range.upper)
    .limit(PER_KIND_CANDIDATE_LIMIT);
  if (error) return { candidates: [], error: error.message };
  return {
    candidates: ((data ?? []) as Array<{ id: string; title: string | null }>).map((r) => ({
      kind: "document",
      id: r.id,
      label: r.title ?? null,
    })),
  };
}

export interface IdResolveArgs {
  prefix: string;
  kinds?: string[];
}

export async function idResolve(
  db: SupabaseClient,
  args: IdResolveArgs,
  scope: IdResolveScope,
  docRunner?: <T>(fn: (docDb: SupabaseClient) => Promise<T>) => Promise<T>
): Promise<IdResolveResult> {
  const norm = normalizeIdPrefix(args.prefix);
  if (!norm.ok) return { ok: false, error: norm.error };
  const range = prefixToUuidRange(norm.hex);

  let kinds: IdKind[];
  if (args.kinds && args.kinds.length > 0) {
    const unknown = args.kinds.filter((k) => !(ID_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      // Same defect class as REQ-038: a filter accepted and ignored lies about
      // what was searched.
      return { ok: false, error: `unknown kind(s) ${JSON.stringify(unknown)}. Valid kinds: ${ID_KINDS.join(", ")}.` };
    }
    kinds = [...new Set(args.kinds)] as IdKind[];
  } else {
    kinds = [...ID_KINDS];
  }

  const candidates: IdCandidate[] = [];
  const searched: IdKind[] = [];
  const notSearched: Array<{ kind: IdKind; reason: string }> = [];

  for (const kind of kinds) {
    let outcome: KindSearchOutcome;
    if (kind === "doc_item" || kind === "document") {
      if (!docRunner) {
        notSearched.push({ kind, reason: "no doc_rw backend available from this instance (DOC_RW_DATABASE_URL not configured)" });
        continue;
      }
      try {
        outcome = await docRunner((docDb) => searchDocKind(docDb, kind, range));
      } catch (e) {
        notSearched.push({ kind, reason: `doc_rw backend failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
    } else if (kind === "gtd_item") {
      outcome = await searchGtdItems(db, range, scope);
    } else if (kind === "board_message") {
      outcome = await searchBoardMessages(db, range, scope);
    } else {
      outcome = await searchProjects(db, range);
    }
    if (outcome.error) {
      notSearched.push({ kind, reason: `query failed: ${outcome.error}` });
      continue;
    }
    searched.push(kind);
    candidates.push(...outcome.candidates);
  }

  const notSearchedNote =
    notSearched.length > 0
      ? ` NOT searched (declared, never silent): ${notSearched.map((n) => `${n.kind} (${n.reason})`).join("; ")}.`
      : "";

  if (searched.length === 0) {
    return { ok: false, error: `prefix '${norm.hex}' could not be searched in ANY of the requested kinds.${notSearchedNote}` };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        `prefix '${norm.hex}' matches NOTHING visible to '${scope.selfSlug}' in: ${searched.join(", ")}.` +
        notSearchedNote +
        ` If this id came from a distillate it may be contaminated (two ids merged) — re-copy it whole from the source; never complete it by hand.`,
    };
  }

  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.kind} ${c.id}${c.label ? ` — ${c.label}` : ""}`).join("\n  ");
    return {
      ok: false,
      error:
        `prefix '${norm.hex}' is AMBIGUOUS — ${candidates.length} matches (never guessed at, REQ-039):\n  ${list}\n` +
        `Use a longer prefix or the full UUID.${notSearchedNote}`,
    };
  }

  const only = candidates[0];
  const data: IdResolveData = {
    id: only.id,
    kind: only.kind,
    label: only.label,
    prefix: norm.hex,
    kinds_searched: searched,
  };
  if (notSearched.length > 0) data.kinds_not_searched = notSearched;
  return { ok: true, data };
}

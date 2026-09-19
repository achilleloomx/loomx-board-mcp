// D-118 (GTD 1aa130da, proposta it-manager msg 49a4177c): dry-run gate shared by
// the three reply-wake structural guards — (a+) guard-inbox-pending in wi_end,
// (a) auto-set waiting_on/block_scope in wi_end(waiting), (c2) cold-recipient
// hint in board_send. Mandate (Achille, D-118): "niente flip senza suite verde"
// — ship the code OFF (log-only, zero side-effect) and flip only after the
// E2E-RW eval suite is green. See docs/HISTORY.md for rollout status.
export function rwGuardsEnabled(): boolean {
  return process.env.LOOMX_RW_GUARDS_ENABLED === "1";
}

// D-118 (GTD 41853607, mandate Achille 2026-08-10): same eval-first discipline
// applied to the model-switch contract guards on runtime_request — Haiku-in-
// autopilot rejection (§0quater) and the cost-consent notice.
//
// FLIPPED ON by default (CP-2/CV-6, registro loomx-ai-governance doc 34aef3d4,
// loomy msg 1bd39554, 2026-09-16): these are the ONLY two call sites gated by
// this flag (grep-verified, src/tools.ts runtime_request handler) — both have
// registered `pass` verdicts (E2E-MODEL-06/08, re-verified on HEAD `a19da81`
// via tests/model-switch-guards.test.ts, docs/HISTORY.md session #66/#98).
// Neither behavior is retroactive/disruptive: the Haiku block only stops a
// FUTURE switch-to-haiku while mode=autopilot (no effect on an agent already
// running Haiku), and the cost notice is advisory-only, never blocking.
// Escape hatch kept for ops: LOOMX_MODEL_GUARDS_ENABLED=0 forces it back off.
//
// NOT claimed green by this flip: the broader E2E-MODEL-* catalog (11 codes)
// has real open gaps unrelated to these two behaviors — E2E-MODEL-05 (reconciler-
// side propagation of requested_model, not_run) and E2E-MODEL-01/04/07/09
// (it-manager's side, never confirmed here) remain open. E2E-MODEL-03/10
// (alias↔ID roster, deprecated-model validation) are excluded by an explicit
// DBA design decision (requested_model stays free-text pass-through, D-101),
// not a pending failure. None of the four touch this flag's two call sites.
export function modelGuardsEnabled(): boolean {
  return process.env.LOOMX_MODEL_GUARDS_ENABLED !== "0";
}

// T2 minimo (SDES-005 v1, REQ-032; task frame 1a7ed39d): delivery of the due
// Decisions at wi_start/wi_resume. LOOMX_WI_NORMS = off | pilots | all,
// default `pilots`; the pilot list is LOOMX_WI_NORMS_PILOTS (comma-separated
// slugs). An agent the flag does not cover gets EXACTLY today's wi_start —
// no RPC call, no extra keys, no registry write.
const DEFAULT_WI_NORMS_PILOTS = ["dev-frame", "acme-lab", "analyst-pieroni"];

function slugList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function wiNormsEnabledFor(slug: string): boolean {
  const mode = (process.env.LOOMX_WI_NORMS ?? "pilots").trim().toLowerCase();
  if (mode === "all") return true;
  if (mode === "pilots") return slugList(process.env.LOOMX_WI_NORMS_PILOTS, DEFAULT_WI_NORMS_PILOTS).includes(slug);
  // "off" and any unrecognized value: off (a typo must never widen a rollout).
  return false;
}

// REQ-032 hard phase (T2-P6): wi_start REFUSES when the current epoch lacks the
// critical core. Shipped OFF — empty list by default, named slugs only, and
// only meaningful where wiNormsEnabledFor is already true. Grace is the default.
export function wiNormsHardGateFor(slug: string): boolean {
  return wiNormsEnabledFor(slug) && slugList(process.env.LOOMX_WI_NORMS_HARD_SLUGS, []).includes(slug);
}

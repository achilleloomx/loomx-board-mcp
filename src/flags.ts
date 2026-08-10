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
// autopilot rejection (§0quater) and the cost-consent notice. OFF by default
// (log-only, zero side-effect) until the E2E-MODEL eval suite is green
// (blocked on loomx_evals catalog seeding, DBA-side — see docs/HISTORY.md).
export function modelGuardsEnabled(): boolean {
  return process.env.LOOMX_MODEL_GUARDS_ENABLED === "1";
}

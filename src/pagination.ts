// CV-8 (D-203, registry REG-002; loomy msgs 2190b6ae/73aef27b): shared shape for
// every list tool that caps its result set. Extends the pattern already live in
// pendingInbox.ts (D-205) — count is the page size (never a full-table total),
// `truncated` is present ONLY when the cap actually cut something off (never a
// sentinel `false`). Fetch with `limit(N+1)`: if N+1 rows come back, the cap bit,
// slice to N and say so; otherwise the page IS the whole result.

export function paginate<T>(rows: T[], limit: number): { page: T[]; truncated?: true } {
  if (rows.length > limit) {
    return { page: rows.slice(0, limit), truncated: true };
  }
  return { page: rows };
}

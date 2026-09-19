// Project reference resolution for org_lookup(project=...) (dba msg 85c8441e,
// loomy msg a8f83a59 — gate for the second half of the project rename).
//
// Before: a non-UUID was matched on short_name ONLY. The rename moves `name`
// first and `short_name` later, so a caller holding either the new name or an
// 8-char id prefix (the form ids travel in across the fleet) got "not found".
//
// Order, first unique hit wins, each step declared in `matched_by`:
//   1. full UUID            → id
//   2. hex prefix >= 8 chars → id prefix (dashes ignored)
//   3. short_name           → exact
//   4. short_name           → case-insensitive
//   5. name                 → case-insensitive
// Ambiguity at any step is an ERROR listing the candidates, never a guess
// (same rule as id_resolve, D-241). A step with zero hits falls through.

export interface ProjectRefRow {
  id: string;
  name: string;
  short_name: string | null;
  agent_id: string | null;
}

export type ProjectMatchedBy = "id" | "id_prefix" | "short_name" | "short_name_ci" | "name_ci";

export type ProjectRefResult<T extends ProjectRefRow> =
  | { ok: true; row: T; matched_by: ProjectMatchedBy }
  | { ok: false; error: string };

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_PREFIX_RE = /^[0-9a-f-]+$/i;
const MIN_PREFIX = 8;

function describe(r: ProjectRefRow): string {
  return `${r.id} (short_name=${r.short_name ?? "null"}, name="${r.name}")`;
}

export function resolveProjectRef<T extends ProjectRefRow>(rows: T[], ref: string): ProjectRefResult<T> {
  const raw = ref.trim();
  if (!raw) return { ok: false, error: "project reference is empty" };

  const steps: Array<[ProjectMatchedBy, (r: T) => boolean]> = [];
  if (FULL_UUID_RE.test(raw)) {
    const id = raw.toLowerCase();
    steps.push(["id", (r) => r.id.toLowerCase() === id]);
  } else {
    const hex = raw.replace(/-/g, "").toLowerCase();
    if (HEX_PREFIX_RE.test(raw) && hex.length >= MIN_PREFIX) {
      steps.push(["id_prefix", (r) => r.id.replace(/-/g, "").toLowerCase().startsWith(hex)]);
    }
    const lower = raw.toLowerCase();
    steps.push(["short_name", (r) => r.short_name === raw]);
    steps.push(["short_name_ci", (r) => (r.short_name ?? "").toLowerCase() === lower]);
    steps.push(["name_ci", (r) => r.name.trim().toLowerCase() === lower]);
  }

  for (const [by, pred] of steps) {
    const hits = rows.filter(pred);
    if (hits.length === 1) return { ok: true, row: hits[0], matched_by: by };
    if (hits.length > 1) {
      return {
        ok: false,
        error:
          `project "${raw}" is ambiguous (${by}, ${hits.length} matches) — pass the full id. Candidates: ` +
          hits.map(describe).join("; "),
      };
    }
  }
  return {
    ok: false,
    error:
      `project "${raw}" not found (tried: ${steps.map(([by]) => by).join(", ")}). ` +
      `Use project_list to discover valid ids/short_names.`,
  };
}

// WI template catalog validation (GTD f67f9524, review governance round 2).
//
// The catalog lives as YAML files in hub/templates/work-items/ (a sibling repo,
// not something board-mcp owns or bundles). Path is opt-in via WI_TEMPLATES_PATH
// so agents that haven't configured it are unaffected — soft-warn only, never a
// hard dependency. Hard-fail is deferred to a grace period agreed with Loomy
// (not yet scheduled — see GTD f67f9524 body).

import { readdirSync } from "node:fs";

let cache: Set<string> | null | undefined; // undefined = not loaded yet, null = unavailable

function loadCatalog(): Set<string> | null {
  const dir = process.env.WI_TEMPLATES_PATH;
  if (!dir) return null;
  try {
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .filter((f) => !f.startsWith("_")); // e.g. _SCHEMA.md-like conventions
    return new Set(names);
  } catch {
    return null; // dir missing/unreadable — treat as "no catalog configured"
  }
}

// Lazy-load once per process; callers that want a fresh read (e.g. after a
// template was just added) can call refreshTemplateCatalog().
function getCatalog(): Set<string> | null {
  if (cache === undefined) cache = loadCatalog();
  return cache;
}

export function refreshTemplateCatalog(): Set<string> | null {
  cache = loadCatalog();
  return cache;
}

// Returns a soft-warn message if the catalog is configured and the name is
// unknown; null if the catalog isn't configured (nothing to check) or the
// name is valid. Never blocks wi_start — see module header.
export function checkTemplateName(templateName: string | undefined | null): string | null {
  if (!templateName) return null;
  let catalog = getCatalog();
  if (catalog === null) return null;
  if (catalog.has(templateName)) return null;
  catalog = refreshTemplateCatalog();
  if (catalog === null || catalog.has(templateName)) return null;
  return (
    `template_name "${templateName}" not found in the WI templates catalog (${[...catalog].length} known). ` +
    `Soft-warn only (grace period, GTD f67f9524) — WI opened anyway. Check hub/templates/work-items/ for the correct name.`
  );
}

#!/usr/bin/env bash
# doc-lint.sh — PreToolUse hook per wi_end (D-a5 enforcement plumbing)
#
# Esegue il lint @loomx/doc-render prima che l'agente chiuda il WI.
# Controlla:
#   A) link-by-string: riferimenti REQ-NNN/SDES-NNN/... senza .governance.json
#   B) frozen-md-edited: .md GENERATED con checksum mismatch (hand-edit)
#
# Non blocca (exit 0 sempre): è un avviso pre-wi_end. Il gate reale è la CI.
# Per bloccare su violation, cambia `|| true` in `|| exit 1` nel chiamante
# (settings.json.template — richiede decisione Achille/Loomy).
#
# Richiede: tsx installato (globale o in hub/forge/packages/doc-render/node_modules/.bin)

set -euo pipefail

# Trova il bin/lint.ts del pacchetto @loomx/doc-render
FORGE_LINT="$( cd "$(dirname "${BASH_SOURCE[0]}")" && pwd )"
# Path relativo al workspace root (funziona sia da workdir agente che da forge)
WORKSPACE_ROOT="${LOOMX_WORKSPACE:-/home/loomy/workspace}"
LINT_BIN="$WORKSPACE_ROOT/hub/forge/packages/doc-render/bin/lint.ts"
TSX_BIN="$WORKSPACE_ROOT/hub/forge/packages/doc-render/node_modules/.bin/tsx"

if [[ ! -f "$LINT_BIN" ]]; then
  echo "[doc-lint] @loomx/doc-render non trovato ($LINT_BIN) — skip" >&2
  exit 0
fi

if [[ ! -f "$TSX_BIN" ]]; then
  # Fallback: tsx globale
  TSX_BIN=$(which tsx 2>/dev/null || echo "")
fi

if [[ -z "$TSX_BIN" || ! -f "$TSX_BIN" ]]; then
  echo "[doc-lint] tsx non trovato — skip (installa: npm install -g tsx)" >&2
  exit 0
fi

REPO_ROOT="${PWD}"
echo "[doc-lint] Lint governance docs: $REPO_ROOT" >&2

"$TSX_BIN" "$LINT_BIN" --repo-root "$REPO_ROOT" 2>&1
STATUS=$?

if [[ $STATUS -ne 0 ]]; then
  echo "" >&2
  echo "[doc-lint] ⚠ Violazioni trovate — correggi prima di considerare il lavoro done." >&2
  echo "           Rigenera i .md con: loomx-doc-dump --document-id <uuid> --output <file>" >&2
  echo "           Aggiorna .governance.json per coprire tutti i path con code-ref." >&2
fi

# Exit 0: avviso non bloccante. Modifica a exit \$STATUS per gate hard.
exit 0

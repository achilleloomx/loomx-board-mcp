#!/usr/bin/env bash
# governance-gate.sh — PreToolUse hook per enforcement Work Items (D-024)
#
# Uso:
#   bash governance-gate.sh --agent <slug> [--mcp-mode] [--external] [--bash]
#
# Letto da .claude/settings.json PreToolUse. Viene invocato prima di ogni
# Edit/Write/MultiEdit/NotebookEdit, di ogni MCP write, e di ogni Bash (--bash:
# il gate ispeziona il comando e applica il WI check solo a write/external).
#
# Exit codes (spec hook Claude Code — SOLO exit 2 blocca il tool):
#   0 = OK, tool puo procedere
#   2 = BLOCK, tool non procede (stderr mostrato all'agente)
#   1 = errore non-bloccante (mai usato per enforcement)
#
# v1.1 (2026-07-02, remediation governance WI afd24663):
#   - exit 1 -> exit 2 su tutti i branch di blocco (prima il gate era fail-open)
#   - modalita --bash: enforcement bash_commands external + scritture via shell
#   - tool_uses counter best-effort (non aborta il gate sotto set -e)
#
# Spec: hub/initiatives/governance-compliance/design.md sezione 6
#
# NOTE sulla versione iniziale:
# - Implementazione minimale-ma-funzionale (no parsing YAML complesso, no dipendenze esterne oltre jq)
# - Richiede jq installato (gia presente in ambiente Windows/Git Bash standard LoomX)
# - Politica: legge SOLO la cache locale (no round-trip DB per latency)
# - La skill session-manager v2 scrive la cache a wi-start / wi-end / wi-checkpoint

set -euo pipefail

# ------------------------------------------------------------------------------
# Hook payload (Claude Code passes tool_name + tool_input as JSON via stdin)
# Read once here; used later for GENERATED .md guard (section 5.5).
# Non-blocking: if stdin is a TTY (manual call) or empty, HOOK_INPUT stays "".
# ------------------------------------------------------------------------------
HOOK_INPUT=""
if [[ ! -t 0 ]]; then
  HOOK_INPUT=$(timeout 1 cat 2>/dev/null) || HOOK_INPUT=""
fi

# ------------------------------------------------------------------------------
# Args parsing
# ------------------------------------------------------------------------------
AGENT_SLUG=""
MCP_MODE=false
EXTERNAL=false
BASH_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT_SLUG="$2"
      shift 2
      ;;
    --mcp-mode)
      MCP_MODE=true
      shift
      ;;
    --external)
      EXTERNAL=true
      shift
      ;;
    --bash)
      BASH_MODE=true
      shift
      ;;
    *)
      echo "governance-gate: arg sconosciuto: $1" >&2
      shift
      ;;
  esac
done

if [[ -z "$AGENT_SLUG" ]]; then
  echo "governance-gate: --agent <slug> obbligatorio (settings.json malconfigurato)" >&2
  exit 2
fi

# ------------------------------------------------------------------------------
# 0. Bash mode: applica il gate solo a comandi write/external
# ------------------------------------------------------------------------------
# I comandi bash di sola lettura (ls, cat, grep, git status...) passano senza WI.
# Il WI check scatta per: comandi external (deploy/push/publish, da
# hub/governance-policy.yaml sezione external.bash_commands) e scritture shell
# (redirect, sed -i, rm/mv/cp, tee, psql/curl mutanti).
if [[ "$BASH_MODE" == "true" ]]; then
  BASH_CMD=""
  if command -v jq &>/dev/null && [[ -n "$HOOK_INPUT" ]]; then
    BASH_CMD=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
  fi
  # Senza comando ispezionabile: permissive (non possiamo giudicare)
  [[ -z "$BASH_CMD" ]] && exit 0

  EXTERNAL_RE='git push|git push --force|supabase (db push|functions deploy|secrets set)|vercel (--prod|deploy)|npm publish|gh release|systemctl (restart|stop|disable)|docker (push|rm)'
  WRITE_RE='(^|[^>])>>?[[:space:]]*[^&[:space:]]|sed[[:space:]]+-i|\btee\b|\brm[[:space:]]|\bmv[[:space:]]|\bcp[[:space:]]|mkdir|chmod|chown|truncate|\bln[[:space:]]|psql .*(-c|-f)|curl .*-(X[[:space:]]*(POST|PUT|PATCH|DELETE)|d[[:space:]])|python[0-9.]*[[:space:]].*(setup|install)|pip[0-9.]*[[:space:]]+install|npm[[:space:]]+(install|ci)|git[[:space:]]+(commit|merge|rebase|reset|checkout[[:space:]]+-b|cherry-pick|tag)'

  if echo "$BASH_CMD" | grep -qE "$EXTERNAL_RE"; then
    EXTERNAL=true   # prosegue: richiede WI attivo + segnala external
  elif echo "$BASH_CMD" | grep -qE "$WRITE_RE"; then
    :               # scrittura via shell: prosegue col WI check standard
  else
    exit 0          # bash read-only: nessun gate
  fi
fi

# ------------------------------------------------------------------------------
# Paths
# ------------------------------------------------------------------------------
CACHE_DIR=".claude/cache"
WI_CACHE="$CACHE_DIR/current-work-item.json"

# ------------------------------------------------------------------------------
# 1. Verifica WI cache esiste
# ------------------------------------------------------------------------------
if [[ ! -f "$WI_CACHE" ]]; then
  cat >&2 <<EOF
[governance-gate BLOCK]

Nessun Work Item attivo per agente '$AGENT_SLUG'.

Prima di eseguire scritture persistenti (codice, docs, DB, messaggi), DEVI
aprire un Work Item:

  wi-start --gtd-id <uuid>                    # se il GTD esiste gia'
  wi-start --new --intent "..." --template <name>   # nuovo GTD + WI
  wi-start --emergency --reason "..."         # bypass per emergenze (audit follow-up)
  wi-start --read-only-session                # dichiara sessione esplorativa

Vedi: hub/initiatives/governance-compliance/design.md sezione 5.
Spec governance: D-024.
EOF
  exit 2
fi

# ------------------------------------------------------------------------------
# 2. Verifica WI status attivo
# ------------------------------------------------------------------------------
if ! command -v jq &> /dev/null; then
  echo "[governance-gate WARN] jq non installato — skip validazione cache (permissive)" >&2
  exit 0
fi

WI_STATUS=$(jq -r '.status // "unknown"' "$WI_CACHE" 2>/dev/null || echo "unknown")
WI_ID=$(jq -r '.id // "unknown"' "$WI_CACHE" 2>/dev/null || echo "unknown")
WI_INTENT=$(jq -r '.intent // ""' "$WI_CACHE" 2>/dev/null || echo "")

case "$WI_STATUS" in
  active|emergency|exempt)
    # OK, procede a verifica pre-conditions
    ;;
  paused)
    cat >&2 <<EOF
[governance-gate BLOCK]

Work Item corrente e in pausa (status=paused).

WI id: $WI_ID
Intent: $WI_INTENT

Prima di scrivere, riprendi il WI con:
  wi-resume $WI_ID

Oppure aprine uno nuovo con wi-start.
EOF
    exit 2
    ;;
  done|failed)
    # Whitelist post-chiusura (D-069 two-phase close + summary D-014):
    # dopo wi_end sono legittimi SOLO gli step di chiusura — arm GTD, summary
    # a loomy, runtime_request. Tutto il resto resta bloccato.
    POST_CLOSE_TOOL=""
    if command -v jq &>/dev/null && [[ -n "$HOOK_INPUT" ]]; then
      POST_CLOSE_TOOL=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
    fi
    case "$POST_CLOSE_TOOL" in
      mcp__board__gtd_update|mcp__board__gtd_complete|mcp__board__board_send|mcp__board__runtime_request|mcp__board__wi_start)
        echo "[governance-gate] WI chiuso ($WI_STATUS) — consentito solo step di chiusura D-069/D-014: $POST_CLOSE_TOOL" >&2
        exit 0
        ;;
    esac
    cat >&2 <<EOF
[governance-gate BLOCK]

Work Item corrente e gia chiuso (status=$WI_STATUS).

La cache non e stata aggiornata correttamente dalla skill session-manager v2.
Apri un nuovo WI con:
  wi-start --new --intent "..."
EOF
    exit 2
    ;;
  *)
    echo "[governance-gate BLOCK] WI cache ha status sconosciuto: $WI_STATUS" >&2
    exit 2
    ;;
esac

# ------------------------------------------------------------------------------
# 3. Verifica agent_slug della cache coincide con --agent
# ------------------------------------------------------------------------------
WI_AGENT=$(jq -r '.agent_slug // ""' "$WI_CACHE" 2>/dev/null || echo "")
if [[ -n "$WI_AGENT" && "$WI_AGENT" != "$AGENT_SLUG" ]]; then
  cat >&2 <<EOF
[governance-gate BLOCK]

Mismatch agent_slug: WI cache dice '$WI_AGENT', hook invocato per '$AGENT_SLUG'.

Possibile causa: cache stale da altra sessione. Esegui:
  wi-status         # per verificare
  wi-end            # se il WI non e piu rilevante
  wi-start --new    # per aprirne uno nuovo
EOF
  exit 2
fi

# ------------------------------------------------------------------------------
# 4. Verifica pre_conditions required (se status=active)
# ------------------------------------------------------------------------------
# Emergency / exempt bypassano questo check.
if [[ "$WI_STATUS" == "active" ]]; then
  # Lista required da pre_conditions.required (array di stringhe)
  REQUIRED_LIST=$(jq -r '.pre_conditions.required // [] | .[]' "$WI_CACHE" 2>/dev/null || echo "")

  MISSING=()
  while IFS= read -r field; do
    [[ -z "$field" ]] && continue
    VAL=$(jq -r --arg f "$field" '.pre_conditions[$f] // empty' "$WI_CACHE" 2>/dev/null || echo "")
    if [[ -z "$VAL" || "$VAL" == "null" ]]; then
      MISSING+=("$field")
    fi
  done <<< "$REQUIRED_LIST"

  if [[ ${#MISSING[@]} -gt 0 ]]; then
    cat >&2 <<EOF
[governance-gate BLOCK]

Pre-conditions mancanti per il WI attivo:
$(printf '  - %s\n' "${MISSING[@]}")

WI id: $WI_ID
Intent: $WI_INTENT

Compila le pre-conditions PRIMA di scrivere. Usa:
  wi-update <field> <value>

Oppure, se l'urgenza lo giustifica:
  wi-start --emergency --reason "..."   # bypass con audit follow-up
EOF
    exit 2
  fi
fi

# ------------------------------------------------------------------------------
# 5. External actions: richiedi conferma utente (marker per Claude Code)
# ------------------------------------------------------------------------------
# Claude Code ha gia il permission system per --external. Il hook qui segnala
# al modello che siamo in modalita external perche compaia nella UX.
if [[ "$EXTERNAL" == "true" ]]; then
  echo "[governance-gate] Azione external detected (WI attivo $WI_ID). Richiedo conferma utente." >&2
  # NON blocco, lascio che il permission prompt del harness gestisca.
fi

# ------------------------------------------------------------------------------
# 5.5. GENERATED .md guard (D-a5 — avvisa su scritture dirette a mirror DB)
# Non blocca: è un avviso educational. Il lint CI (@loomx/doc-render) è il gate.
# ------------------------------------------------------------------------------
if command -v jq &>/dev/null && [[ -n "$HOOK_INPUT" ]]; then
  HOOK_FILE=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
  if [[ -n "$HOOK_FILE" && -f "$HOOK_FILE" ]]; then
    FIRST_LINE=$(head -1 "$HOOK_FILE" 2>/dev/null || echo "")
    if [[ "$FIRST_LINE" == "<!-- GENERATED"* ]]; then
      cat >&2 <<'GENERATED_WARN'
[governance-gate WARN] ⚠ File GENERATED rilevato (D-a5 — mirror DB).

Questo file è generato da @loomx/doc-render. NON modificarlo direttamente:
il lint CI rileverà il checksum mismatch e fallirà.

Per aggiornare il contenuto:
  1. Scrivi nel DB → doc_item_upsert(project_id, code, body, ...) via board-mcp
  2. Rigenera il mirror → loomx-doc-dump --document-id <uuid> --output <file>

Il lint puoi eseguirlo ora: npx tsx hub/forge/packages/doc-render/bin/lint.ts
GENERATED_WARN
    fi
  fi
fi

# ------------------------------------------------------------------------------
# 6. Append a in_flight_state.files_touched (best-effort)
# ------------------------------------------------------------------------------
# L'hook non conosce il path del file che sta per essere scritto (Claude Code
# non lo passa in $* per ora). La skill session-manager v2 popola questo campo
# in Mode 3 (Checkpoint) leggendo la conversazione. Qui incrementiamo solo
# tool_uses counter come euristica per checkpoint periodico.
TMP=$(mktemp) || true
if [[ -n "${TMP:-}" ]]; then
  { jq '.in_flight_state.tool_uses = ((.in_flight_state.tool_uses // 0) + 1)' "$WI_CACHE" > "$TMP" && mv "$TMP" "$WI_CACHE"; } 2>/dev/null || rm -f "$TMP" 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 7. OK
# ------------------------------------------------------------------------------
exit 0

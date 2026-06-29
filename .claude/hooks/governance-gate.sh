#!/usr/bin/env bash
# governance-gate.sh — PreToolUse hook per enforcement Work Items (D-024)
#
# Uso:
#   bash governance-gate.sh --agent <slug> [--mcp-mode] [--external]
#
# Letto da .claude/settings.json PreToolUse. Viene invocato prima di ogni
# Edit/Write/MultiEdit/NotebookEdit, di ogni MCP write, e di ogni Bash external.
#
# Exit codes:
#   0 = OK, tool puo procedere
#   1 = block, tool non deve procedere (stdout mostra messaggio all'agente)
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
# Args parsing
# ------------------------------------------------------------------------------
AGENT_SLUG=""
MCP_MODE=false
EXTERNAL=false

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
    *)
      echo "governance-gate: arg sconosciuto: $1" >&2
      shift
      ;;
  esac
done

if [[ -z "$AGENT_SLUG" ]]; then
  echo "governance-gate: --agent <slug> obbligatorio" >&2
  exit 1
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
  exit 1
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
    exit 1
    ;;
  done|failed)
    cat >&2 <<EOF
[governance-gate BLOCK]

Work Item corrente e gia chiuso (status=$WI_STATUS).

La cache non e stata aggiornata correttamente dalla skill session-manager v2.
Apri un nuovo WI con:
  wi-start --new --intent "..."
EOF
    exit 1
    ;;
  *)
    echo "[governance-gate BLOCK] WI cache ha status sconosciuto: $WI_STATUS" >&2
    exit 1
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
  exit 1
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
    exit 1
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
# 6. Append a in_flight_state.files_touched (best-effort)
# ------------------------------------------------------------------------------
# L'hook non conosce il path del file che sta per essere scritto (Claude Code
# non lo passa in $* per ora). La skill session-manager v2 popola questo campo
# in Mode 3 (Checkpoint) leggendo la conversazione. Qui incrementiamo solo
# tool_uses counter come euristica per checkpoint periodico.
TMP=$(mktemp)
jq '.in_flight_state.tool_uses = ((.in_flight_state.tool_uses // 0) + 1)' "$WI_CACHE" > "$TMP" && mv "$TMP" "$WI_CACHE"

# ------------------------------------------------------------------------------
# 7. OK
# ------------------------------------------------------------------------------
exit 0

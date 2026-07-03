#!/usr/bin/env bash
# session-end-gate.sh — SessionEnd hook per WI closure reminder (D-024 F2)
#
# Uso (automatico tramite .claude/settings.json SessionEnd):
#   Claude Code lo invoca a fine sessione (clear/logout/prompt_input_exit/other).
#
# Comportamento:
#   - Se WI attivo in cache → inietta additionalContext con alert chiusura WI
#   - Se nessun WI attivo o cache assente → exit 0 silenzioso
#
# Output: JSON {"additionalContext": "..."} su stdout (formato Claude Code hooks)

CACHE_DIR=".claude/cache"
WI_CACHE="$CACHE_DIR/current-work-item.json"

if [[ ! -f "$WI_CACHE" ]]; then
  exit 0
fi

if ! command -v jq &>/dev/null; then
  exit 0
fi

WI_STATUS=$(jq -r '.status // "unknown"' "$WI_CACHE" 2>/dev/null || echo "unknown")

# Solo WI attivi/emergenza: paused/done/failed non richiedono alert
if [[ "$WI_STATUS" != "active" && "$WI_STATUS" != "emergency" ]]; then
  exit 0
fi

WI_ID=$(jq -r '.id // ""' "$WI_CACHE" 2>/dev/null || echo "")
WI_INTENT=$(jq -r '.intent // ""' "$WI_CACHE" 2>/dev/null | cut -c1-80)

jq -n \
  --arg wi_id "$WI_ID" \
  --arg intent "$WI_INTENT" \
  '{additionalContext: ("[governance D-024 ALERT] Work Item ANCORA APERTO a fine sessione.\n\nEsegui PRIMA di terminare:\n  1. wi_end --status done|waiting|failed\n  2. board_send a loomy (summary D-014)\n  3. runtime_request (se autopilot)\n\nWI attivo: " + $wi_id + "\nIntent: " + $intent)}'

exit 0

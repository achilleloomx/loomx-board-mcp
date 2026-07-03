#!/usr/bin/env bash
# session-start-hint.sh — SessionStart hook: correzione guidata lanci manuali (D-084 Fase 3)
#
# Uso (settings.json SessionStart): bash .claude/hooks/session-start-hint.sh --agent <slug>
#
# Se la sessione NON è partita dal launcher/wrapper (LOOMX_AGENT_SLUG assente),
# stampa la guida col comando giusto per QUESTA workdir. Requisito Achille
# 2026-07-03: "se apro un terminale sbagliando, aiutami a correggere" — mai muto.
#
# Modalità SOFT (pre-Fase 2 D-084): informa e lascia proseguire (le credenziali
# sono ancora nei .mcp.json). Con la Fase 3 (placeholder ${LOOMX_DB_URL}) la
# stessa guida diventa il messaggio di recovery del fail-closed.
# Exit SEMPRE 0: questo hook non blocca mai.

AGENT_SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT_SLUG="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -n "${LOOMX_AGENT_SLUG:-}" ]]; then
  # Lancio gestito (wrapper claude/env, window launcher, invoke): nessun hint.
  exit 0
fi

cat <<EOF
[LoomX D-084] Sessione avviata SENZA il wrapper in una workdir-agente.
Questa e' la workdir di: ${AGENT_SLUG:-<slug ignoto>}
Per la prossima volta (workdir + identita' + credenziali corrette in un comando):
  python3 /home/loomy/workspace/hub/agent_manager.py claude ${AGENT_SLUG:-<slug>}
Da PC Windows: python hub\\agent_manager.py claude ${AGENT_SLUG:-<slug>}  (da "00. LoomX Consulting")
Guida completa: LoomX HQ -> /howto (porta 4400).
Per ORA la sessione funziona comunque (credenziali ancora nei .mcp.json, pre-Fase 2 D-084);
dopo la Fase 3 il wrapper sara' NECESSARIO e questo messaggio ti dira' come recuperare.
EOF
exit 0

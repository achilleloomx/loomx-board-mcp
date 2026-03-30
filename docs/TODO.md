# TODO — Board MCP Server

> Task dello sviluppatore MCP.

---

## In corso

(nessuno)

## Backlog

- [ ] Creare `.mcp.json.example` per ogni repo agente
- [ ] Fase 2: push mode via Claude Code Channels (quando disponibile)

## Done

- [x] Setup progetto (package.json, tsconfig, dipendenze)
- [x] Implementare i 4 tool MCP (board_send, board_inbox, board_ack, board_update_status)
- [x] Richiedere al DBA la migrazione `board_messages`
- [x] Adattare codice a schema board_agents (slug→agent_code)
- [x] Test end-to-end su Supabase live (send, inbox, cleanup)

---

*Ultimo aggiornamento: 2026-03-30*

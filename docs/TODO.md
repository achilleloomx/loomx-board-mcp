# TODO — Board MCP Server

> Task dello sviluppatore MCP.

---

## In corso

(nessuno)

## Backlog

- [ ] Creare `.mcp.json.example` per ogni repo agente
- [ ] Fase 2: push mode via Claude Code Channels (quando disponibile)
- [ ] Staging area — spazio file condiviso tra agenti (Supabase Storage o path locale)
- [ ] Aggiornare RPC `board_broadcast` per supportare summary e tags (richiesta al DBA)

## Done

- [x] Setup progetto (package.json, tsconfig, dipendenze)
- [x] Implementare i 4 tool MCP (board_send, board_inbox, board_ack, board_update_status)
- [x] Richiedere al DBA la migrazione `board_messages`
- [x] Adattare codice a schema board_agents (slug→agent_code)
- [x] Test end-to-end su Supabase live (send, inbox, cleanup)
- [x] Registrazione agente board-mcp (code 005, nickname Postman) su board_agents
- [x] Implementare board_overview (view globale messaggi)
- [x] Implementare board_broadcast (RPC broadcast a tutti)
- [x] Sostituire AGENT_SLUGS hardcoded con validazione dinamica da board_agents
- [x] Implementare board_thread (navigazione conversazioni per ref_id)
- [x] Aggiungere supporto tags a board_send e board_inbox (filtro)
- [x] Aggiungere supporto summary a board_send
- [x] Implementare board_archive (RPC board_archive_old per TTL/archivio)

---

*Ultimo aggiornamento: 2026-03-31*

# DECISIONS — Board MCP Server

> Decisioni architetturali del server MCP. Status vuoto = attiva. `superseded` = sostituita.

---

## D-001 — Zod per validazione input tool MCP

Usare `zod` per definire gli schema dei parametri dei tool MCP, sfruttando l'integrazione nativa con `McpServer.tool()`.

**Motivazione:** L'MCP SDK accetta direttamente schema Zod, eliminando la necessità di JSON Schema manuali e garantendo type-safety end-to-end.

---

## D-002 — Supabase client singleton

Il client Supabase viene creato una sola volta (lazy init) e riutilizzato per tutte le query.

**Motivazione:** Evita la creazione di connessioni multiple per ogni tool call. Il client viene inizializzato al primo uso, fallendo immediatamente se le env vars mancano.

---

## D-003 — Self-send prevention

`board_send` rifiuta messaggi dove `to_agent === selfAgent` a livello applicativo.

**Motivazione:** Un agente che parla con sé stesso non ha senso nel modello di comunicazione. Il check è nel tool, non nel DB, per dare errori immediati e chiari.

---

## D-004 — Service role key per accesso DB

Il Board MCP usa la service role key di Supabase (bypassa RLS) anziché token per-agente.

**Motivazione:** In Fase 1 ogni istanza MCP gira localmente in stdio con un singolo operatore. La sicurezza è garantita dal fatto che ogni istanza filtra per il proprio `agentId` a livello applicativo. RLS rimane abilitato come difesa in profondità.

---

## D-005 — Slug→code resolution da board_agents

Il CLI accetta slug (`--agent pm-home`) ma le query DB usano `agent_code` (es. `001`). All'avvio il server carica il registry da `board_agents` e costruisce le mappe slug↔code.

**Motivazione:** Il DBA ha normalizzato `from_agent`/`to_agent` come FK verso `board_agents(agent_code)` anziché slug testuali hardcoded. Risolvere all'avvio mantiene il codice dei tool semplice e rispetta `board_agents` come source of truth.

---

## D-006 — Enrichment slug nei risultati board_inbox

`board_inbox` arricchisce ogni messaggio con `from_agent_slug` e `to_agent_slug` per leggibilità, mantenendo i codici originali.

**Motivazione:** Gli agenti ragionano per slug, non per codici numerici. L'enrichment avviene lato applicativo senza query aggiuntive (usa la mappa in memoria).

---

## D-007 — Validazione dinamica slug da board_agents

Rimosso `AGENT_SLUGS` hardcoded da `types.ts`. Ora `board_send` valida i destinatari a runtime usando la mappa `slugToCode` costruita all'avvio da `board_agents`. Anche `index.ts` accetta qualsiasi stringa come `--agent` e delega la validazione a `resolveAgentRegistry`.

**Motivazione:** Con l'aggiunta di nuovi agenti (es. board-mcp/005) l'enum statico richiedeva rilasci. La validazione dinamica rende il sistema zero-config per nuovi agenti.

---

## D-008 — Board MCP agent come product owner della piattaforma di comunicazione

Recepita decisione PM D-008. Il Board MCP agent è responsabile di: tool MCP, formato messaggi, logica applicativa. Il DBA resta fornitore schema su richiesta. Il PM definisce governance d'uso.

**Motivazione:** La piattaforma board sta evolvendo (tags, summary, thread, archive, staging area). Serve un owner chiaro per la roadmap feature.

---

## D-009 — Inbox esclude messaggi archiviati di default

`board_inbox` filtra automaticamente `WHERE archived_at IS NULL`. I messaggi archiviati sono visibili solo tramite `board_overview` o query dirette.

**Motivazione:** Riduce il rumore nell'inbox degli agenti. I messaggi completati e vecchi non servono nel flusso quotidiano.

---

*Watermark: D-009*

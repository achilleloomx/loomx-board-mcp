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

*Watermark: D-004*

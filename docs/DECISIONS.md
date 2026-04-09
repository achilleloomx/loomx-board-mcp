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

## D-010 — Governance dei tag: Loomy owner, Postman enforcer

I tag sui messaggi board seguono una tassonomia ufficiale. L'owner della lista tag è il root coordinator — **Loomy** (`loomy`).

- **Loomy:** definisce e mantiene la lista di tag approvati
- **Postman (board-mcp):** fa rispettare la lista (validazione nei tool) e comunica a tutti gli agenti la lista aggiornata e le regole d'uso
- I tag non nella lista ufficiale vengono rifiutati da `board_send` e `board_broadcast`

**Motivazione:** Tag free-form diventano caotici rapidamente. Serve un owner con visione d'insieme per mantenere coerenza. Il Postman, come infrastruttura di comunicazione, è il punto naturale di enforcement.

> *Aggiornato 2026-04-05: owner passato da PM (`pm-home`, rimosso) a Loomy (`loomy`) come root coordinator.*

---

## D-011 — GTD tools: ownership enforcement applicativo

I tool GTD (`gtd_inbox`, `gtd_add`, `gtd_update`, `gtd_query`, `gtd_complete`) operano su `loomx_items` con ownership enforcement a livello applicativo (come D-004 per board). Ogni agente puo' modificare solo item dove `owner = selfSlug`. Eccezione: `loomy` ha accesso in lettura e scrittura su tutti gli item.

**Motivazione:** Loomy, come root coordinator, ha bisogno di visibilita' e controllo su tutti gli item GTD per coordinamento cross-agente. Gli altri agenti devono operare solo nel proprio scope. Il check avviene aggiungendo `.eq("owner", selfSlug)` alle query per agenti non-loomy, stesso pattern di `board_inbox`/`board_ack`.

---

## D-012 — GTD tools usano slug come owner (non agent_code)

A differenza dei board tools che usano `agent_code` (FK numerica), i GTD tools usano direttamente lo `slug` come valore di `owner` in `loomx_items`.

**Motivazione:** La tabella `loomx_items` (migration 20260405100000) usa `owner TEXT` con slug leggibili. Questo e' coerente con il design del DBA per il namespace `loomx_*` e rende i dati piu' leggibili senza enrichment.

---

## D-013 — Dual DB backend: direct-postgres via DATABASE_URL con fallback service_role

Il Board MCP supporta due backend DB selezionabili via environment:

1. **Direct postgres** — se `DATABASE_URL` è settato, usa `pg.Pool` (node-postgres) direttamente contro Postgres (pooler Supabase, DB locale, o qualsiasi Postgres).
2. **Supabase service_role** (legacy, backwards-compatible) — fallback se `DATABASE_URL` non è settato, usa `@supabase/supabase-js` con `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` come in D-004.

L'implementazione usa un thin shim (`src/pg-shim.ts`) che espone il sottoinsieme dell'API query-builder di supabase-js usato da `tools.ts` (from/select/insert/update/eq/is/in/not/contains/or/order/limit/single, rpc con named args). Questo permette **zero modifiche a `tools.ts`**: tutti i 14 tool funzionano identicamente in entrambe le modalità.

**Motivazione:** Recepita decisione DBA D-023 (validazione pre-implementazione). I vantaggi:
- Possibilità di puntare il Board MCP a un Postgres locale in dev senza dipendenza da Supabase cloud.
- Connessione diretta al pooler Supabase (pgbouncer) senza il round-trip REST di PostgREST → latenza più bassa.
- Backwards-compatibility totale: repository agente che non impostano `DATABASE_URL` continuano a funzionare esattamente come prima.

**Sicurezza:** La connection string viene letta esclusivamente da env (mai in codice, mai in log). Su stderr viene loggato solo il nome del backend ("direct-postgres" o "supabase-js"), mai le credenziali. `.env` resta in `.gitignore`.

**Limiti dello shim:** copre solo i metodi usati oggi. Se `tools.ts` in futuro usa nuovi operatori (es. `.gte`, `.like`, `.match`), vanno aggiunti a `pg-shim.ts`.

---

## D-014 — Home tools: family scoping via HOME_FAMILY_ID + HOME_USER_ID

I tool `home_*` (grocery, menu, school menu) operano su tabelle `home_*` scoped a una famiglia. Il family_id e lo user_id (per i campi `added_by`/`checked_by`) vengono letti da env vars `HOME_FAMILY_ID` e `HOME_USER_ID` all'avvio. Se non presenti, i tool home_* non vengono registrati.

**Motivazione:** Il Board MCP usa service_role (bypassa RLS), quindi il family scoping deve avvenire a livello applicativo (stesso pattern di D-004/D-011 per board/GTD). Le env vars permettono di configurare quali agenti hanno accesso ai dati famiglia senza modifiche al codice. Solo gli agenti che operano nel contesto famiglia (es. Evaristo/assistant) impostano queste variabili.

---

## D-015 — Delete support in pg-shim per grocery_remove

Aggiunto metodo `delete()` a `PgQuery` in `pg-shim.ts` per supportare `DELETE FROM ... WHERE ... RETURNING ...`. Necessario per `home_grocery_remove`.

**Motivazione:** Il shim copriva solo select/insert/update (D-013). La rimozione di prodotti dalla lista spesa richiede DELETE effettivo (non soft-delete, la tabella non ha campo `is_active`).

---

*Watermark: D-015*

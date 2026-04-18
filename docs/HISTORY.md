# HISTORY — Board MCP Server

> Storico sessioni dello sviluppatore MCP.

---

## Sessione #9 — 2026-04-19

**Obiettivo:** Rename slug agente `loomx-commercialisti` → `loomx-tracker` (task Loomy msg 77c30e65, DBA migration già applicata con 29 righe rinominate e via libera esplicita).
**Completato:**
- Grep integrale del sorgente (`src/`, `dist/`) per `loomx-commercialisti`: **0 occorrenze**. Unica occorrenza nel repo: `CLAUDE.md:167` (tabella Agent IDs documentativa).
- Confermato che D-007 (validazione dinamica slug da `board_agents`) rende lo slug rename zero-code — il registry viene ricostruito al runtime dal DB ad ogni avvio del server.
- `CLAUDE.md:167`: aggiornata tabella Agent IDs (`loomx-commercialisti` → `loomx-tracker`, label "PO Tracker (ex-Commercialisti)").
- Build TypeScript pulita (`npm run build`): zero errori.
- Version bump patch: `package.json` 0.1.0 → 0.1.1 + lockfile aggiornato.
- `docs/DECISIONS.md`: aggiunta D-018 con contesto rename, impatto zero sul sorgente, e azioni cross-repo necessarie.
**Decisioni prese:** D-018
**Blocchi / note:**
- MCP board non connesso in questa sessione — non è stato possibile eseguire `board_inbox`/`gtd_inbox` né smoke test live (invio a `loomx-tracker` deve passare, a `loomx-commercialisti` deve fallire). Il task è stato eseguito sulla base della descrizione nel prompt di Loomy. Smoke test delegato al prossimo avvio del server da parte di un consumer connesso.
- "Publish package" interpretato come commit + push: il pacchetto è consumato localmente via filesystem path (`../loomx-board-mcp/dist/index.js`), non esiste registry npm attivo per questo package.
- Occorrenza `LoomXCommercialisti` in `.skills/CHANGELOG.md` ignorata: è un riferimento al repo storico del branch di migrazione skill, non al nuovo slug agente (submodule).
**Prossima sessione:** Smoke test live del rename via consumer connesso; implementare gtd_link_agent/gtd_unlink_agent (backlog GTD).

---

## Sessione #8 — 2026-04-11

**Obiettivo:** Fix urgente segnalato da Evaristo — `home_grocery_add` fallisce con FK violation su `home_shopping_items.added_by` (task da Loomy, root cause confermato dal DBA msg 7d7fa363).
**Completato:**
- Investigato: il codice `home_grocery_add` è corretto — usa `process.env.HOME_USER_ID` come `added_by`. La causa della FK violation è che `HOME_USER_ID` in `.mcp.json` di Evaristo punta a un id che non è un `auth.users(id)` valido. Il valore corretto (dal DBA) è `5a2df80b-aa01-4b68-976e-192d6ca4227e`.
- `src/tools.ts`: aggiunto helper `translateHomeFkError()` che traduce FK violations su `added_by`/`checked_by` in messaggi d'errore self-diagnosticanti (indica HOME_USER_ID + come ripararlo). Applicato a `home_grocery_add` e `home_grocery_update`.
- `src/tools.ts`: lo startup log dei home tools stampa ora anche il prefix di `HOME_USER_ID` + una nota che deve essere un `auth.users(id)` (visibilità al primo avvio).
- `.env.example`: documentato esplicitamente che `HOME_USER_ID` deve essere un `auth.users(id)` e non un family member_id / profile id.
- `CLAUDE.md`: aggiunto alert sotto la tabella Home Tools e sotto l'esempio `.mcp.json` con il valore corretto per Evaristo.
- `docs/DECISIONS.md`: aggiunta D-017 con contesto incidente, implementazione, e alternativa scartata (probe startup contro auth.users).
**Decisioni prese:** D-017
**Blocchi / note:** MCP board non connesso in questa sessione — non è stato possibile eseguire `board_inbox`/`gtd_inbox` né inviare board_send live. Il fix su `.mcp.json` di Evaristo deve essere applicato nel repo `loomx-home-assistant` (non in questo repo) — sta all'agente assistant / a Loomy fare quella modifica.
**Prossima sessione:** Verificare con Evaristo che dopo aver aggiornato HOME_USER_ID il tool `home_grocery_add` passa; test live home_menu_write. Implementare gtd_link_agent/gtd_unlink_agent (backlog GTD).

---

## Sessione #7 — 2026-04-09

**Obiettivo:** Aggiungere campo owner opzionale a gtd_update (task da Loomy via board)
**Completato:**
- Aggiunto parametro opzionale `owner` a `gtd_update` in tools.ts
- Validazione applicativa: solo loomy può reassegnare owner, errore esplicito per altri agenti
- Il campo owner viene incluso nel payload di update solo se fornito
- Build TypeScript pulita, push su master (dd032df)
**Decisioni prese:** D-016
**Blocchi / note:** MCP board non connesso in questa sessione — task eseguito da descrizione nel prompt. board_inbox/gtd_inbox non verificabili live.
**Prossima sessione:** Implementare gtd_link_agent/gtd_unlink_agent (backlog GTD), test live home_* tools

---

## Sessione #6 — 2026-04-09

**Obiettivo:** Estendere Board MCP con tool home_* per Evaristo (task da Loomy)
**Completato:**
- Implementati 8 tool home_*: home_grocery_categories, home_grocery_list, home_grocery_add, home_grocery_update, home_grocery_remove, home_menu_read, home_menu_write, home_school_menu_read
- Tool condizionali: registrati solo se HOME_FAMILY_ID + HOME_USER_ID sono in env (D-014)
- Aggiunto delete() a pg-shim.ts per supportare grocery_remove (D-015)
- Tipi Home aggiunti a types.ts: MealType, MenuStatus, SchoolMenuSource
- Auto-creazione lista spesa e weekly menu quando non esistono
- Build TypeScript pulita, zero errori
- CLAUDE.md aggiornato con tabella Home Tools e configurazione env
**Decisioni prese:** D-014, D-015
**Blocchi / note:** Nessun blocco. Test live non eseguiti (serve HOME_FAMILY_ID/HOME_USER_ID reali).
**Prossima sessione:** Test live con Evaristo, implementare gtd_link_agent/gtd_unlink_agent (GTD backlog)

---

## Sessione #5b — 2026-04-09

**Obiettivo:** Eseguire task pendente "Registrare agente mcpromo in board_agents" + chiusura messaggi board
**Completato:**
- Verificato che mcpromo era gia' registrato (agent_code=023, inserito in sessione #5)
- Chiuso messaggio board 9b820bfe (task Loomy → board-mcp) come done
- Chiuso messaggio board 405e90e3 (direct-postgres task) come done
- Inviato summary a Loomy con ref al task originale
**Decisioni prese:** nessuna
**Blocchi / note:** Nessuno
**Prossima sessione:** Implementare gtd_link_agent/gtd_unlink_agent/gtd_list_agents (GTD item 94d193ba, next_action), design staging area (GTD item 91435dfc, high priority)

---

## Sessione #5 — 2026-04-09

**Obiettivo:** Registrare agente mcpromo in board_agents (task da Loomy)
**Completato:**
- Inserito agente mcpromo in board_agents: slug=mcpromo, agent_code=023, label="Consulting — MCpromo (Antonelli)", repo="01. Progetti/20. MCpromo", scope=consulting, active=true
- Aggiornato CLAUDE.md: aggiunta riga mcpromo nella tabella Agent IDs
**Decisioni prese:** nessuna (operazione CRUD standard)
**Blocchi / note:** Nessuno
**Prossima sessione:** Verificare che mcpromo possa usare il board (configurare .mcp.json nel repo MCpromo)

---

## Sessione #4 — 2026-04-07

**Obiettivo:** Supporto backend direct-postgres via `DATABASE_URL`, backwards-compat service_role (D-023 DBA validato)
**Completato:**
- Aggiunto `src/pg-shim.ts`: shim minimale che implementa il sottoinsieme di `supabase-js` query builder usato in `tools.ts` (from/select/insert/update/eq/is/in/not/contains/or/order/limit/single + rpc con named args)
- Dispatch in `src/supabase.ts`: se `DATABASE_URL` è settato usa pg, altrimenti fallback a `SUPABASE_URL`+`SERVICE_ROLE_KEY` (backwards-compat totale)
- Zero modifiche a `src/tools.ts` — tutti i 14 tool funzionano in entrambe le modalità grazie al cast strutturale
- `pg.Pool` singleton (lazy-init), parallelo a D-002 per supabase-js
- Connection string letta solo da env, mai logica né in log (no credential leak — solo "DB backend: direct-postgres/supabase-js" su stderr)
- Aggiornato `.env.example` con entrambe le modalità documentate
- Aggiunte deps `pg ^8.13.1` + `@types/pg ^8.11.10`
- Build TypeScript pulita
**Decisioni prese:** D-013 (dual backend via DATABASE_URL)
**Blocchi / note:**
- `.mcp.json` in questa working directory ha credenziali placeholder: non è stato possibile eseguire `board_inbox`/`gtd_inbox`/`board_send`/`board_ack` live in questa sessione. Il task è stato eseguito sulla base della descrizione completa fornita nel prompt di Loomy.
- Test end-to-end dei 7 step del task NON eseguiti per mancanza credenziali live. Proposto: il DBA esegua smoke test su branch `feat/direct-postgres-backend` con un `DATABASE_URL` reale prima del merge.
- Branch: `feat/direct-postgres-backend` — non ancora merged, in attesa di review DBA (pre-merge review richiesta esplicitamente dal task).
**Prossima sessione:** Ack del task in board_inbox, summary a Loomy, richiesta review DBA via board, merge a valle di approvazione.

---

## Sessione #3 — 2026-04-05

**Obiettivo:** GTD tools, governance update (PM Home → Loomy), deprecazione TODO.md
**Completato:**
- Implementati 5 tool GTD: gtd_inbox, gtd_add, gtd_update, gtd_query, gtd_complete (D-011, D-012)
- Ownership enforcement applicativo: ogni agente modifica solo i propri item, loomy ha accesso globale
- Aggiornata governance: PM Home rimosso, coordinatore ora è Loomy (root coordinator)
- D-010 aggiornata: owner tag governance da PM a Loomy
- CLAUDE.md aggiornato: blocco Agente, tabella agenti completa con nuovi consulting, riferimento a Loomy
- Deprecato docs/TODO.md — i task board-mcp sono migrati in loomx_items (Supabase)
- Fix parametri RPC con prefisso p_ (commit c81e8d4)
**Decisioni prese:** D-011, D-012
**Blocchi / note:** Nessuno
**Prossima sessione:** Verificare task GTD migrati, .mcp.json.example per repo agenti, staging area

---

## Sessione #2 — 2026-03-31

**Obiettivo:** Evoluzione Board MCP da 4 a 9 tool, registrazione agente, recepimento D-008
**Completato:**
- Registrazione board-mcp (code 005, nickname Postman) su board_agents
- Implementati 5 nuovi tool: board_overview, board_broadcast, board_thread, board_archive
- Validazione dinamica slug (rimosso AGENT_SLUGS hardcoded)
- Supporto tags (invio + filtro inbox), summary (invio), archived_at (esclusione inbox)
- Recepita D-008: board-mcp è product owner della piattaforma di comunicazione
- Comunicazione con DBA per schema changes (tags, summary, archived_at) — tutto applicato
- Notificato PM e tutti gli agenti della registrazione e del nickname Postman
**Decisioni prese:** D-007, D-008, D-009
**Blocchi / note:** RPC board_broadcast non supporta ancora summary/tags (richiesta al DBA in backlog)
**Prossima sessione:** Staging area, aggiornamento RPC broadcast, .mcp.json.example per i repo agenti

---

## Sessione #1 — 2026-03-30

**Obiettivo:** Setup iniziale del progetto e implementazione completa dei tool MCP
**Completato:**
- Setup progetto: package.json, tsconfig.json (strict, ESM, Node16), dipendenze installate
- Implementati tutti i file sorgente: types.ts, supabase.ts, tools.ts, server.ts, index.ts
- 4 tool MCP funzionanti: board_send, board_inbox, board_ack, board_update_status
- Build TypeScript senza errori, CLI con validazione --agent
- Inviata richiesta migrazione `board_messages` al DBA (REQUEST_board_messages.md)
**Decisioni prese:** D-001, D-002, D-003, D-004
**Blocchi / note:** In attesa della migrazione DB dal DBA — senza tabella `board_messages` i tool non possono operare
**Prossima sessione:** Verificare risposta DBA, test end-to-end una volta che la tabella è disponibile

## Sessione #1b — 2026-03-30

**Obiettivo:** Adattare il codice allo schema effettivo del DBA (board_agents + agent_code FK)
**Completato:**
- Refactor completo: slug (CLI) → agent_code (DB) con resolution all'avvio da `board_agents`
- Rinominato AgentId → AgentSlug, aggiunto AgentRegistry e BoardAgent types
- `board_inbox` arricchisce risultati con slug per leggibilità
- Build e test CLI OK
**Decisioni prese:** D-005, D-006
**Blocchi / note:** Serve la service role key dalla dashboard Supabase per il .env
**Prossima sessione:** Configurare .env con credenziali reali, test end-to-end su Supabase live

## Sessione #1c — 2026-03-30

**Obiettivo:** Connessione a Supabase e test end-to-end
**Completato:**
- Configurato .env con service role key
- Test connessione: board_agents query OK (4 agenti)
- Test end-to-end: INSERT (send pm→dba), SELECT (inbox dba), DELETE (cleanup) — tutto OK
- Board MCP operativo su Supabase live (fvoxccwfysazwpchudwp, EU West Paris)
**Decisioni prese:** nessuna
**Blocchi / note:** nessuno
**Prossima sessione:** Creare .mcp.json.example per i repo agenti, primo uso reale tra agenti

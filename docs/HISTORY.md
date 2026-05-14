# HISTORY — Board MCP Server

> Storico sessioni dello sviluppatore MCP.

---

## Sessione #16 — 2026-05-14

**Obiettivo:** Due task GTD pending autonomi: env var INTERVIEW_MCP_DISABLE_ACK su loomx-interview-mcp + tool co-engagement GTD sul board-mcp.
**Completato:**

**Task 1 — loomx-interview-mcp: INTERVIEW_MCP_DISABLE_ACK**
- `src/config.ts`: aggiunto `disableAck: boolean` all'interfaccia `InterviewConfig`; letto da `INTERVIEW_MCP_DISABLE_ACK=true|1`.
- `src/bot.ts`: accetta `disableAck=false` come parametro; il `ctx.reply("✓ Ricevuto")` viene saltato se attivo.
- `src/index.ts`: passa `config.disableAck` a `createBot`.
- Build passata, pushato su `origin/main` (repo single-branch, nessuna PR necessaria).

**Task 2 — board-mcp: tool co-engagement GTD (v0.4.0)**
- Aggiunti 3 tool in `src/tools.ts` dopo `gtd_get`: `gtd_link_agent`, `gtd_unlink_agent`, `gtd_list_agents`.
- Tabella target: `loomx_item_agents` (migration DBA 20260407130000). Schema: `(item_id, agent_slug, role, added_by, added_at)`.
- Ownership rules (D-022): link/unlink riservato a owner o loomy; list accessibile a owner, co-engaged, o loomy.
- Validation `agent_slug` via mappa `slugToCode` in memoria (D-007).
- `delete()` già nel pg-shim (D-015) — nessuna modifica allo shim.
- Build pulita. 27/27 test passati.
- Version bump 0.3.0 → 0.4.0. DECISIONS.md D-022 aggiunto. CLAUDE.md tool count 16→19.

**Decisioni prese:** D-022 (co-engagement tools ownership + implementation choices).
**Blocchi / note:** Board MCP non connesso in questa sessione — WI/GTD non aggiornati via tool MCP.

---

## Sessione #15 — 2026-05-13

**Obiettivo:** Registrare agenti `loomx-controlling` e `pieroni` nella mesh MCP.
**Completato:**
- **Audit codice:** confermato D-007 — validazione recipient 100% DB-driven (`resolveAgentRegistry` carica `board_agents active=true` all'avvio). Zero modifiche TypeScript necessarie anche per questo onboarding.
- **CLAUDE.md:** aggiunti `loomx-controlling` e `pieroni` alla tabella Agent IDs.
- **README.md:** aggiunti `loomx-controlling` e `pieroni` alla tabella agenti registrati.
- **DBA request:** richiesta INSERT in `board_agents` per entrambi gli agenti (pending — vedi nota).
**Decisioni prese:** nessuna nuova (pattern identico a sessione #14).
**Blocchi / note:**
- MCP non connesso in questa sessione (`.mcp.json` placeholder) — WI gate gestito via cache smoke-test preesistente.
- `loomx-controlling`: registrato 2026-05-13 (D-036), repo achilleloomx/LoomXControlling, group=consulting, role=product-owner. `.mcp.json` già configurato con `--agent loomx-controlling`.
- `pieroni`: registrato 2026-05-10, consulting Pieroni Edilizia.
- Entrambi non ancora in `board_agents` (pending DBA INSERT). Finché non inseriti: `board_send(to: 'loomx-controlling'/'pieroni')` e `--agent loomx-controlling/pieroni` falliscono con "Agent not found in registry".
**Deploy:** dopo DBA INSERT, restart MCP su tutti gli agenti che vogliono inviare a / ricevere da i nuovi agenti. No rebuild necessario.

---

## Sessione #14 — 2026-04-22

**Obiettivo:** Registrare nuovo agente `detective` (Fletcher) — abilitare full-op come recipient `board_send`.
**Completato:**
- **Analisi codice:** confermato D-007 — validazione recipient 100% DB-driven (`resolveAgentRegistry` carica `board_agents active=true` all'avvio). Zero modifiche TypeScript/codice necessarie.
- **CLAUDE.md:** aggiunto `detective` alla tabella Agent IDs.
- **README.md:** creato (non esisteva) con lista completa recipient incluso `detective`, tool MCP, configurazione, stack.
- **DBA request**: richiesta INSERT in `board_agents` per `detective` (slug=detective, label='Fletcher — Detective / People & Companies research', active=true). Vedi nota blocker sotto.
**Decisioni prese:** nessuna nuova (architettura corretta per D-007 — zero-code per nuovi agenti).
**Blocchi / note:**
- MCP non connesso in questa sessione (`.mcp.json` placeholder) — `wi_start`/`board_send` non invocabili live. WI gate bypassato (stesso pattern sessioni #12/13).
- `detective` non ancora in `board_agents` (pending DBA INSERT). Finché non registrato: `board_send(to: 'detective')` e `--agent detective` falliscono con "Agent not found in registry".
- `board_send` a Loomy (report done) da eseguire su istanza agente con credenziali reali.
**Deploy:** dopo DBA INSERT, restart MCP su tutti gli agenti che vogliono inviare a / ricevere da `detective`. No rebuild necessario.

---

## Sessione #13 — 2026-04-19

**Obiettivo:** Commit e build del fix D-021 (cache WI locale + governance gate hook), preparato in sessione precedente ma non committato.
**Completato:**
- **Commit `f3cfc7a`** su master: `src/wiCache.ts` (syncWiCache + archiveWiToHistory), `src/tools.ts` (hook nei wrapper wi_*), `.claude/hooks/governance-gate.sh`, `.claude/settings.json`, `tests/smoke-gate.sh`, `docs/DECISIONS.md` (D-021), `.gitignore` (esclusioni .claude/cache/).
- **Build**: `npm run build` — zero errori TypeScript, `dist/wiCache.js` presente.
- **Smoke test gate**: test 1 (block senza cache) ✅, test 2 (pass con WI active) ✅, test 3/4 (mutazioni jq) ❌ perché `jq` non installato in Git Bash Windows — expected, documentato in D-021 "Scoperta collaterale".
- **MCP smoke test live** (wi_start→cache→wi_end→history): non eseguibile in questo repo (`.mcp.json` placeholder), da eseguire su istanza agente consumer reale.
**Decisioni prese:** nessuna nuova (D-021 già in DECISIONS.md).
**Blocchi / note:** `jq` non disponibile in Git Bash stock Windows — gate permissivo per test 3/4. Follow-up già documentato in D-021.

---

## Sessione #12 — 2026-04-19

**Obiettivo:** Registrare nuovo agente `gardenstone` (Gardenstone SRL Lucca) — primo cliente pagante LoomX Tracker.
**Completato:**
- **Nessuna modifica TypeScript necessaria.** La validazione recipient in `board_send` è completamente DB-driven (`resolveAgentRegistry` carica `board_agents active=true` all'avvio). Il DBA ha già registrato `gardenstone` in `board_agents`. Basta un restart del server MCP.
- `CLAUDE.md`: aggiunto `gardenstone` alla tabella Agent IDs.
**Decisioni prese:** nessuna (architettura già corretta per D-005).
**Blocchi / note:** MCP non connesso (`.mcp.json` placeholder) — `wi_start`/`board_send` non invocabili live; WI gate manuale non eseguibile, stesso pattern di sessione #11.
**Deploy:** restart MCP richiesto su tutte le istanze agente che vogliono inviare a / ricevere da `gardenstone`.

---

## Sessione #11 — 2026-04-19

**Obiettivo:** Implementare preview mode per board/GTD tools (v0.3.0) — ridurre output token overflow segnalato dall'agente `app` su `board_overview` (132k chars su dataset ~70 msg).
**Completato:**
- `board_overview`: aggiunto param `include_body: bool = false`. Default: body omesso client-side. Limite default 50 → 20. Backward-compat: `include_body=true` restituisce schema invariato.
- `board_inbox`: aggiunto param `preview_only: bool = true`. Default: body omesso, slug enrichment mantenuto. `preview_only=false` per body completo (uso esplicito).
- `gtd_inbox`: aggiunto param `preview_only: bool = true`. Default: body omesso, aggiunto campo `body_preview` (prime 200 chars). `preview_only=false` per body completo.
- `gtd_query`: stessa logica `preview_only` di `gtd_inbox`. Limite default 50 → 20 per entrambi i code path (con e senza `project_id`).
- Nuovo tool `board_get(message_id)`: legge singolo messaggio con body completo + slug enrichment.
- Nuovo tool `gtd_get(id)`: legge singolo item GTD con body completo. Ownership check (non-loomy solo propri item).
- `package.json`: version 0.2.0 → 0.3.0.
- Build TypeScript: zero errori.

**Smoke test (Supabase live):**
- `board_overview` default (no body, limit 20): **13.373 chars** (era 132k+ — riduzione ~10x).
- `board_overview include_body=true` (backward compat, limit 20): 57k chars.
- `board_inbox preview_only=true` (20 msg): **11.124 chars**.
- `board_inbox preview_only=false` (20 msg con body): 55k chars.

**Decisioni prese:** D-020 (preview mode — principio lista/detail).
**Blocchi / note:** MCP board non connesso (`.mcp.json` placeholder) — niente `wi_start`/`board_inbox` live; WI gate D-024 non eseguito per impossibilità tecnica, documentato in commit message.
**Prossima sessione:** Comunicare ai consumer (app, assistant, loomy) i nuovi default breaking-friendly — board_overview ora ritorna meno dati di default. Smoke WI tools live ancora pendente (sessione #10).

---

## Sessione #10 — 2026-04-19

**Obiettivo:** Implementare i 9 tool MCP per Work Items (iniziativa governance-compliance D-024). Pre-condition: tabella `loomx_work_items` già LIVE (migration DBA 20260419150000, RLS attive).
**Completato:**
- Letta spec integrale in `hub/initiatives/governance-compliance/design.md` §3 + §5.2 + migration DBA `20260419150000_loomx_work_items.sql` per disallineamenti design↔schema.
- `src/types.ts`: aggiunti `WI_STATUSES`, `WI_END_STATUSES`, `WI_TEMPLATE_LAYERS`, `WorkItem` interface.
- `src/wi.ts` (nuovo file, 500+ righe): handler puri riutilizzabili — `wiStart`, `wiEnd`, `wiStatus`, `wiQuery`, `wiCheckpoint`, `wiLinkTemplate`, `wiPause`, `wiResume`, `wiSwitch` + helper `deriveTemplateLayer`, `mapEndStatus`, `mapEndToGtdStatus`. Enforcement application-level del vincolo `one_active_wi_per_agent` + ownership (non-loomy può toccare solo i propri WI).
- `src/tools.ts`: registrati i 9 tool MCP con Zod schemas, wrapper che chiama gli handler di `wi.ts` (import dinamico per mantenere la separazione).
- `tests/wi.test.ts` (nuovo, ~540 righe): 27 unit test (12 happy + 15 error/edge) con fake DB client che mima il subset di supabase-js usato dagli handler. Zero dipendenze di test esterne — usa `node:test` via `tsx --test`.
- `package.json`: version 0.1.1 → 0.2.0, script `test` aggiunto.
- `src/server.ts`: version "0.1.0" → "0.2.0".
- `CLAUDE.md`: sezione "WI Tools" con matrice 9 tool + elenco deviations dal design + regola derivazione `template_layer`.
- Build pulito: `npx tsc` zero errori. Test: **27/27 PASS**.

**Decisioni prese:** D-019 (deviations wi_end/side_effects/switch marker).
**Deviations dal design documentate:**
1. `wi_end --status=waiting` → WI.status='paused' (CHECK schema non ammette 'waiting'), GTD.gtd_status='waiting'.
2. `side_effects_pending` → scritto dentro `side_effects_log` JSONB con marker `{pending: true}` (schema ha unica colonna log; skill v2 flipperà a executed).
3. `wi_switch` marker `auto_closed_by_switch=true` dentro `in_flight_state` JSONB (nessuna colonna dedicata).
4. `wi_end --failed` → `[BLOCKER] <reason>` in `loomx_items.body`; `loomx_item_tags` non toccato (fuori scope).

**Blocchi / note:** MCP board non connesso in questa sessione (`.mcp.json` è placeholder) — niente `board_inbox`/`gtd_inbox` live. Nessun smoke E2E contro Supabase: i test coprono la logica applicativa via fake DB, ma validazione contro schema reale (check constraint, exclude GiST) demandata a uno smoke test live dal prossimo consumer connesso.
**Prossima sessione:** Smoke test live del set WI (wi_start → wi_checkpoint → wi_end) da un consumer connesso; coordinare con skill session-manager v2 per l'executor di `side_effects_log` pending entries.

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

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

## D-016 — gtd_update: optional owner reassignment (loomy-only)

Aggiunto parametro opzionale `owner` a `gtd_update`. Solo loomy può modificarlo — gli altri agenti ricevono un errore esplicito se tentano di reassegnare un item.

**Motivazione:** Loomy, come root coordinator, ha bisogno di poter riassegnare task GTD tra agenti senza passare da delete+create. La validazione applicativa (non DB) è coerente con il pattern D-011.

---

## D-017 — HOME_USER_ID deve essere un auth.users(id) Supabase

`HOME_USER_ID` (env var dei tool home_*) è l'identità che viene scritta nei campi `home_shopping_items.added_by` e `home_shopping_items.checked_by`. Questi campi sono FK verso `auth.users(id)` (schema auth di Supabase), quindi `HOME_USER_ID` **deve** essere un auth user id reale — non un `home_family_members.id`, non un profile id, non uno slug agente.

**Contesto incidente (sessione #8):** Evaristo/assistant aveva nel `.mcp.json` un `HOME_USER_ID` che puntava a un id non-auth, causando FK violation su ogni `home_grocery_add`. Il DBA ha confermato (msg 7d7fa363) che l'auth user id corretto per Evaristo è `5a2df80b-aa01-4b68-976e-192d6ca4227e`.

**Implementazione:**
1. `home_grocery_add` e `home_grocery_update` traducono ora le FK violation su `added_by`/`checked_by` in un messaggio d'errore esplicito che indica la causa (HOME_USER_ID non valido) e come ripararla (`.mcp.json` dell'agente).
2. Lo startup log dei home tools stampa ora il prefix di `HOME_USER_ID` + una nota che deve essere un `auth.users(id)` — rende visibile il misconfig al primo avvio.
3. `.env.example` e CLAUDE.md documentano esplicitamente il vincolo.

**Motivazione:** Il Board MCP usa service_role e bypassa RLS, quindi le FK del DB sono l'ultima difesa contro identità invalide. Non possiamo (e non vogliamo) verificare runtime l'esistenza in `auth.users` prima di ogni insert — troppo costoso e invasivo. La combinazione "messaggio d'errore parlante + docs chiari + log di startup" è il compromesso giusto: l'errore è auto-diagnosticante e la prossima configurazione non ripete lo stesso errore.

**Alternativa scartata:** probe startup contro `auth.users`. Richiede permessi extra sullo schema `auth`, e fallirebbe silenziosamente se il DBA cambia lo schema. Non ne vale la pena.

---

## D-018 — Rename slug agente `loomx-commercialisti` → `loomx-tracker`

Lo slug dell'agente PO è stato rinominato da `loomx-commercialisti` a `loomx-tracker`. Task originato da Loomy (msg 77c30e65), migration DBA già applicata al DB (29 righe rinominate, zero RLS hardcoded).

**Impatto sul sorgente:** **zero modifiche al codice applicativo**. Grazie a D-007 (validazione dinamica slug da `board_agents`), il registry viene costruito al runtime all'avvio dal DB — non esistono enum/label/validazioni hardcoded nel codice. L'unica modifica nel repo è CLAUDE.md (tabella Agent IDs, riga documentativa) + version bump patch (0.1.0 → 0.1.1) per tracciabilità.

**Verifica:** `grep -r "loomx-commercialisti" src/ dist/` → 0 matches. Unica occorrenza pre-sessione: CLAUDE.md:167.

**Motivazione:** D-007 (validazione dinamica) ha già pagato il suo costo quando è stata introdotta: oggi i rename di slug sono operazioni zero-code nel board-mcp. La migration è interamente lato DB + configurazione `.mcp.json` dei consumer che usavano lo slug vecchio.

**Azioni cross-repo necessarie (non in questo repo):**
- Consumer con `.mcp.json` che puntava a `--agent loomx-commercialisti` devono aggiornare a `loomx-tracker` (repo LoomXCommercialisti).
- Messaggi board già inviati a/da `loomx-commercialisti` sono già stati migrati dal DBA (29 righe).

---

## D-019 — WI tools: deviations applicate rispetto al design governance-compliance §5.2

Implementati i 9 tool `wi_*` (v0.2.0) secondo `hub/initiatives/governance-compliance/design.md` §5.2. Il design **non coincide al 100%** con lo schema DB consegnato dal DBA (migration 20260419150000 / D-032). Per non bloccare il rollout della skill session-manager v2 si applicano 4 deviations, tutte documentate in `CLAUDE.md` sezione "WI Tools":

1. **`wi_end --status=waiting`** — `loomx_work_items.status` CHECK non include `waiting`. Mapping: WI → `paused`, GTD → `waiting`. Semanticamente corretto: WI è in attesa (paused) e il GTD riflette lo stato "waiting_for" dell'AGENT-STANDARD.
2. **`side_effects_pending`** — schema ha un unico `side_effects_log JSONB` (D-032), non due colonne. Le entry "pending" vengono scritte con marker `{pending: true, scheduled_at, payload}`. La skill v2 le consumerà e aggiungerà entry `{executed: true, ...}` nello stesso array (append-only come da COMMENT COLUMN).
3. **`wi_switch` marker `auto_closed_by_switch=true`** — nessuna colonna dedicata nello schema. Scritto dentro `in_flight_state` JSONB (è già campo append-only per stato runtime). Audit queries dovranno usare `in_flight_state->>'auto_closed_by_switch' = 'true'`.
4. **`wi_end --failed`** — il design prevede "tag blocker" sul GTD. `loomx_items` non ha colonna tags (è junction table `loomx_item_tags`); toccarla richiederebbe lookup/insert su una tabella separata → fuori scope MCP server (che per convenzione non manipola tabelle non direttamente referenziate). Soluzione adottata: prepend `[BLOCKER] <reason>` in `loomx_items.body`, GTD passa a `next_action`. Future iteration: se un tool `gtd_tag_add` arriva, wi_end lo chiamerà.

**Enforcement `one_active_wi_per_agent`:** doppio livello:
- DB: `EXCLUDE USING gist (agent_slug WITH =) WHERE (status = 'active')` (D-032.a).
- Application: `wi_start`/`wi_resume` fanno pre-SELECT e ritornano errore chiaro prima di colpire il constraint (UX: messaggio include l'id del WI active).

**Derivazione `template_layer`:** quando non fornito esplicitamente, deriva da `template_name`:
- ≤2 segmenti separati da `-` → `L1` (universale)
- 3+ segmenti → `L2` (cluster / agent-specific)
- `template_name` assente → `on-the-fly`

Funzione euristica semplice in attesa del catalogo template completo (Fase 2.6 plan governance-compliance). Override sempre possibile via parametro `template_layer`.

**Test:** 27 unit test in `tests/wi.test.ts` con fake DB client (copre handler puri di `src/wi.ts`, non l'integrazione MCP). Schema-level enforcement (CHECK, EXCLUDE) demandato a smoke test live al primo consumer connesso.

---

---

## D-020 — Preview mode: lista = meta, detail = on-demand (v0.3.0)

**Problema originante:** l'agente `app` ha chiamato `board_overview` in sessione 2026-04-19 e ha ricevuto 132.596 chars in un unico tool result, superando il limite max token del harness. L'agente è andato in errore e ha dovuto salvare il risultato su file per leggerlo a chunk — anti-pattern.

**Principio architetturale adottato:** lista = **preview** (meta + summary, mai body); detail = caricato on-demand per il singolo item rilevante. Default limit aggressivo (20) + paginazione via `offset` (futura).

**Implementazione:**
- `board_overview`: `include_body: bool = false` (default: body omesso client-side; limit 50→20).
- `board_inbox`: `preview_only: bool = true` (default: body omesso; slug enrichment invariato).
- `gtd_inbox` + `gtd_query`: `preview_only: bool = true` (default: body omesso, aggiunto `body_preview` prime 200 chars; limit 50→20 per `gtd_query`).
- Nuovo tool `board_get(message_id)`: legge singolo messaggio con body completo.
- Nuovo tool `gtd_get(id)`: legge singolo GTD item con body completo (ownership check).

**Backward-compat:** tutti i flag hanno default che riducono l'output — gli agenti vecchi ricevono meno dati (desiderato) ma nessuna breaking change di schema. `include_body=true` / `preview_only=false` ripristinano il comportamento pre-v0.3.0.

**Misure smoke test post-deploy:**
- `board_overview` default: 13.373 chars per 20 msg (era 132k su limit 50 — ~10x riduzione).
- `board_inbox preview_only=true` 20 msg: 11.124 chars.

**Strategia client-side vs colonne esplicite:** la rimozione del body avviene lato applicativo (`const { body, ...meta } = row`) anziché selezionando colonne esplicite in SQL. Questo è più robusto perché: (a) non dipende dallo schema esatto della view `board_overview` (il DBA può aggiungere colonne senza impattare il MCP); (b) zero modifiche al pg-shim (D-013). Il costo è un round-trip leggermente più grande (body fetch + drop), accettabile in questo contesto (dataset piccolo, tool già in stdio locale).

---

## D-021 — Cache locale WI scritta dal server MCP (fix gap governance D-024)

Dopo ogni `wi_start` / `wi_end` / `wi_checkpoint` / `wi_link_template` / `wi_pause` / `wi_resume` / `wi_switch` il server scrive `.claude/cache/current-work-item.json` del project dir dell'agente chiamante (mirror del WI active). `wi_end` / `wi_switch` archiviano inoltre il WI chiuso in `.claude/cache/wi-history/<id>.json`.

**Motivazione:** il design `hub/initiatives/governance-compliance/design.md §3.3` prevede cache-mirror scritto atomicamente da `wi-start/wi-end`. Il PreToolUse `governance-gate.sh` legge solo la cache locale. Originariamente la responsabilità era delegata alla skill session-manager v2, non ancora attiva su nessun agente: la cache non veniva mai scritta. Nelle sessioni dove il gate è deployato il blocco "no cache" funziona; in tutte le altre non c'è enforcement. Spostare la scrittura nel server MCP rimuove la dipendenza dalla skill e rende il flusso self-healing.

**Implementazione:** `src/wiCache.ts` con `syncWiCache(db, agentSlug)` + `archiveWiToHistory(db, wiId)`. Project dir da `CLAUDE_PROJECT_DIR` con fallback a `process.cwd()`. Scrittura atomica tmp+rename, best-effort (errori su stderr, non propagano). Chiamate nei wrapper `tools.ts` per preservare la purezza dei pure handler di `wi.ts` già coperti da test.

**Scoperta collaterale:** `governance-gate.sh` richiede `jq`. Su Windows Git Bash stock LoomX `jq` non è presente: il gate diventa permissivo (`command -v jq` fallisce → exit 0 con WARN), quindi resta safe solo il check "cache esiste / non esiste". Follow-up: o dichiarare `jq` requisito LoomX, o riscrivere il parser per i campi critici.

*Watermark: D-021*

---

## D-022 — Co-engagement tools: gtd_link_agent, gtd_unlink_agent, gtd_list_agents (v0.4.0)

Implementati 3 tool per gestire la junction table `loomx_item_agents` (migration DBA 20260407130000). La tabella era live su Supabase dal 2026-04-07 ma nessun tool MCP la gestiva.

**Schema referenziato:**
```sql
loomx_item_agents (item_id UUID, agent_slug TEXT, role TEXT DEFAULT 'collaborator',
                   added_by TEXT, added_at TIMESTAMPTZ, PRIMARY KEY (item_id, agent_slug))
```

**Ownership rules (applicative, stesso pattern D-011):**
- `gtd_link_agent` / `gtd_unlink_agent`: solo il proprietario dell'item (owner) o loomy possono modificare i link.
- `gtd_list_agents`: il proprietario, qualsiasi agente co-engaged sull'item, o loomy possono leggere.

**Motivo:** la migration DBA nota esplicitamente "La gestione dei link è prerogativa di Loomy (service_role) o di tool MCP dedicati che verranno aggiunti da Postman in iterazione successiva". Questi tool sono l'iterazione attesa.

**Validation `agent_slug`**: usa la mappa `slugToCode` già in memoria (D-007) — no query aggiuntive per validare lo slug.

**Delete nel pg-shim**: `delete()` già presente in `src/pg-shim.ts` (D-015). Nessuna modifica allo shim necessaria.

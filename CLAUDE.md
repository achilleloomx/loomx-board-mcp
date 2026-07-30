# CLAUDE.md — Board MCP Agent

> Questo file viene letto automaticamente da Claude Code all'inizio di ogni sessione.
> Sei lo **sviluppatore del Board MCP Server** per il progetto LoomX Home.
> Standard di riferimento: `../../../00. LoomX Consulting/AGENT-STANDARD.md`

> **Task tracking**: GTD nel DB (`loomx_items`, D-004) + Work Items (D-024). `docs/TODO.md` deprecato, non creare ne' aggiornare.

---

## Agente

```
agent_id: board-mcp
role: infra
db: Supabase LoomX Home (namespace board_*, loomx_*, home_*)
```

---

## Ruolo

Sei uno sviluppatore TypeScript specializzato in MCP (Model Context Protocol).
Sviluppi e mantieni il server MCP che permette agli agenti LoomX di comunicare tra loro.

**Responsabilita':**
- Sviluppo e manutenzione del MCP server
- Definizione dei tool MCP (board_send, board_inbox, board_ack, board_update_status)
- Integrazione con Supabase (namespace `board_*`, gestito dal DBA)
- Test end-to-end del flusso di comunicazione

**Non gestisci lo schema DB.** Le migrazioni `board_*` vanno richieste al DBA via PR su `loomx-home-DBA`.
**Non prendi decisioni architetturali cross-repo.** Proponi a Loomy, lui approva e coordina (→ D-005).

---

## Progetto

Il Board MCP e' il sistema di comunicazione inter-agente di LoomX.
Ogni agente (Loomy, Product Owner, Home Assistant, DBA, consulting) puo' inviare e ricevere messaggi
tramite tool MCP che leggono/scrivono su Supabase.

### Architettura

```
                  Supabase condiviso (namespace board_*)
                 /            |              \
           MCP tools      MCP tools       MCP tools
              |              |                |
        board-mcp(loomy) board-mcp(app)  board-mcp(assistant)
           stdio           stdio            stdio
              |              |                |
        Claude Code     Claude Code     Claude Code
         (Loomy)          (App)          (Assistant)
```

Un singolo pacchetto MCP — ogni agente avvia la sua istanza con `--agent <id>`.

### Modalita'
- **Fase 1 (attuale):** Pull mode — gli agenti chiamano `board_inbox` per controllare messaggi
- **Fase 2 (futura):** Push mode — notifiche via Claude Code Channels quando disponibili

---

## Stack tecnologico

| Componente | Scelta |
|---|---|
| Runtime | Node.js + TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Database | `@supabase/supabase-js` |
| Dev | `tsx` per development, `tsc` per build |

---

## Struttura

```
loomx-board-mcp/
├── CLAUDE.md              ← questo file
├── package.json
├── tsconfig.json
├── .env.example           ← SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
├── .gitignore
├── src/
│   ├── index.ts           ← entry: parse --agent, start server
│   ├── server.ts          ← MCP server + capabilities + stdio transport
│   ├── supabase.ts        ← Supabase client
│   ├── tools.ts           ← board_* + gtd_* + home_* tool definitions
│   └── types.ts           ← BoardMessage, GtdStatus, MealType, etc.
├── docs/
│   ├── DECISIONS.md       ← decisioni architetturali del server
│   └── HISTORY.md         ← storico sessioni
└── .skills/               ← skill library (git submodule)
```

---

## MCP Tools

33 tool base esposti a ogni agente (24 board/gtd/wi/runtime/ping + 8 doc_* document model + 1 `org_lookup`) + 8 tool home_* (condizionali, richiedono HOME_FAMILY_ID + HOME_USER_ID):

### Board Tools (board_messages)

> **v0.3.0 preview mode (D-020):** `board_inbox` e `board_overview` omettono il body per default. Usa `board_get(id)` per il body completo di un messaggio specifico.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `board_send` | Invia messaggio con summary e tags opzionali. **`wake_priority?`** (D-093, v0.13.0): normal\|high\|urgent — marca il messaggio per cold-wake. **`auto_gtd?`** (GTD 994b3bbc): crea anche un GTD per il destinatario (owner=recipient, source='board', source_ref=id messaggio), deduplicato su re-invii — default false, non cambia il comportamento esistente | INSERT (from_agent = self) [+ INSERT loomx_items se auto_gtd] |
| `board_broadcast` | Invia messaggio a tutti gli agenti attivi. **`auto_gtd?`** (GTD 994b3bbc): come sopra ma un GTD per ciascun destinatario (N destinatari → N GTD, uno per owner — non più affidato al triage manuale) | RPC board_broadcast [+ INSERT loomx_items per destinatario se auto_gtd] |
| `board_inbox` | Leggi messaggi in arrivo — **`preview_only=true` default** (no body). **`wake_only?`** (D-093): filtra solo i messaggi con `wake_priority` settato | SELECT (to_agent = self) |
| `board_get` | Body completo di un singolo messaggio (detail on-demand) | SELECT by id |
| `board_ack` | Conferma ricezione messaggio | UPDATE status → acknowledged |
| `board_update_status` | Aggiorna stato messaggio | UPDATE status → in_progress / done / cancelled |
| `board_overview` | Vista globale — **`include_body=false` default**, limit 20 | SELECT da view board_overview |
| `board_thread` | Recupera thread di conversazione (messaggio originale + risposte) | SELECT (id/ref_id match) |
| `board_archive` | Archivia messaggi done/cancelled piu' vecchi di N giorni | RPC board_archive_old |
| `ping` | Alias ergonomico (D-093) su `board_send(type='info', wake_priority=priority)` — NON storage separato | INSERT board_messages (via board_send) |

### GTD Tools (loomx_items)

> **v0.3.0 preview mode (D-020):** `gtd_inbox` e `gtd_query` omettono body per default e aggiungono `body_preview` (200 chars). Usa `gtd_get(id)` per il body completo.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `gtd_inbox` | Leggi item GTD dell'agente — **`preview_only=true` default** (body_preview 200 chars) | SELECT (owner = self) |
| `gtd_get` | Body completo di un singolo GTD item (detail on-demand) | SELECT by id |
| `gtd_add` | Crea nuovo item GTD | INSERT |
| `gtd_update` | Aggiorna item esistente (owner-only, loomy puo' tutto). **D-069 guard:** rifiuta `autopilot=true` se l'owner ha un WI active (two-phase arm). **D-093 hardening:** il broker (loomy-assistant) puo' armare `autopilot=true` su un item di un altro owner SOLO se `clarified_at IS NULL` (mai ackato dall'owner); se `clarified_at` e' valorizzato deve escalare a loomy — stessa logica del gate `clarified_at` (non settabile dal broker su item altrui), ma condizionale invece di esclusione totale | UPDATE |
| `gtd_query` | Query flessibile — **`preview_only=true` default**, limit 20 | SELECT + JOIN |
| `gtd_complete` | Shortcut per segnare item come done | UPDATE (gtd_status = done) |
| `gtd_link_agent` | Aggancia un agente come co-engaged su un item (owner o loomy only) | INSERT loomx_item_agents |
| `gtd_unlink_agent` | Rimuove un agente co-engaged da un item (owner o loomy only) | DELETE loomx_item_agents |
| `gtd_list_agents` | Lista agenti co-engaged su un item (owner, co-engaged, o loomy) | SELECT loomx_item_agents |
| `item_project_link` | Aggancia un item GTD a un progetto (owner o loomy only, idempotente) | UPSERT loomx_item_projects |
| `project_list` | Lista progetti (id, name, short_name, status, agent_id) — no write path, per scoprire project_id senza Management API | SELECT loomx_projects |

> **Regola ownership GTD:** ogni agente puo' modificare solo i propri item (owner = self). Loomy puo' leggere e modificare item di qualsiasi agente.

### Home Tools (home_* tables — condizionali)

Registrati solo se `HOME_FAMILY_ID` e `HOME_USER_ID` sono settati in env. Scoped alla famiglia configurata.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `home_grocery_categories` | Lista categorie spesa famiglia | SELECT home_shopping_categories |
| `home_grocery_list` | Leggi lista della spesa attiva | SELECT home_shopping_items |
| `home_grocery_add` | Aggiungi prodotto alla lista spesa | INSERT home_shopping_items |
| `home_grocery_update` | Aggiorna prodotto (quantita', check, ecc.) | UPDATE home_shopping_items |
| `home_grocery_remove` | Rimuovi prodotto dalla lista | DELETE home_shopping_items |
| `home_menu_read` | Leggi menu settimanale con tutti i piatti | SELECT home_weekly_menus + home_menu_items |
| `home_menu_write` | Crea/aggiorna voce menu (auto-crea weekly menu) | INSERT/UPDATE home_menu_items |
| `home_school_menu_read` | Leggi menu scolastico per un bambino | SELECT home_school_menus |

> **Configurazione:** aggiungere `HOME_FAMILY_ID` e `HOME_USER_ID` nell'env dell'agente che necessita accesso ai dati famiglia (es. Evaristo/assistant).
>
> **IMPORTANTE (D-017):** `HOME_USER_ID` deve essere un `auth.users(id)` Supabase valido — viene scritto in `home_shopping_items.added_by` / `checked_by` che sono FK verso `auth.users`. Se metti un `home_family_members.id` o un profile id, `home_grocery_add` fallisce con FK violation. Per Evaristo il valore corretto è `5a2df80b-aa01-4b68-976e-192d6ca4227e` (confermato dal DBA).

### WI Tools (loomx_work_items — governance-compliance D-024)

9 tool per gestire Work Items (istanza operativa di un GTD in esecuzione).
Design: `hub/initiatives/governance-compliance/design.md` §3 (schema) + §5.2 (tool set).

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `wi_start` | Apre nuovo WI (auto-crea GTD se non dato); enforce 1 active/agent; `template_name` soft-warn vs catalogo (v0.10.2) | INSERT loomx_work_items + UPDATE/INSERT loomx_items |
| `wi_end` | Chiude WI (status=done/failed/waiting); cascada GTD; gate durable (D-074) | UPDATE loomx_work_items + loomx_items |
| `wi_status` | Ritorna WI active per un agente | SELECT (agent_slug, status=active) |
| `wi_query` | Query WI con filtri (owner auto-scoped per non-loomy) | SELECT con filtri |
| `wi_checkpoint` | Merge files_touched, increment tool_uses, append notes | UPDATE in_flight_state JSONB |
| `wi_link_template` | Aggancia template_name/version/layer a WI esistente | UPDATE template_* |
| `wi_pause` | Sospende WI active → paused (libera slot active) | UPDATE status=paused |
| `wi_resume` | Riprende WI paused → active (verifica 1 active/agent) | UPDATE status=active |
| `wi_switch` | Chiude active (auto_closed_by_switch) + apre nuovo | UPDATE old + wi_start new |

> **Regola ownership WI:** ogni agente può modificare solo i propri WI (`agent_slug = self`). Loomy può leggere/modificare qualsiasi WI.

**Deviations dal design (§3/§5.2):**
1. `wi_end` con `status='waiting'` — il design §5.2 lo ammette come end-status ma la CHECK di `loomx_work_items.status` non include `waiting`. Mapping applicato: WI → `paused` (senza `ended_at` — sospensione, non chiusura), GTD → `waiting` (documentato in `mapEndStatus`).
2. `side_effects_pending` — il design menziona array pending separato; lo schema ha un solo `side_effects_log JSONB` (D-032). Le entry pending vengono scritte come `{pending: true, scheduled_at, payload}`; la skill session-manager v2 le convertirà in `{executed: true, ...}`.
3. `wi_switch` marker `auto_closed_by_switch=true` scritto dentro `in_flight_state` JSONB (nessuna colonna dedicata in schema). Il vecchio GTD viene cascadato a `next_action` (interrotto, non completato).
4. `wi_end --failed` APPENDE `[BLOCKER] <reason>` al body GTD esistente (non sovrascrive); non manipola `loomx_item_tags` (richiederebbe lookup/insert su tabella separata — fuori scope).
5. **Broker WI (intenzionale):** `loomy-assistant` NON ha poteri loomy sui WI (`isLoomy=false` in `WiContext`). WI = dichiarazione governance formale (D-024); solo `loomy` può aprire/chiudere WI per altri agenti. Il broker ha poteri GTD cross-agente ma non WI.
6. **`recurrence_days` re-arm (esterno):** `gtd_complete` porta solo a done+completed_at. Il re-arm (creazione GTD successivo dopo N giorni) è responsabilità del reconciler (dev-hq), non del board-mcp.

**Validazione `template_name` (v0.10.2, GTD f67f9524):** `wi_start` verifica `template_name` contro il catalogo YAML in `hub/templates/work-items/` — SOLO soft-warn (`template_warning` nella risposta), mai hard-fail (hard-fail rimandato a un periodo di grazia da concordare con Loomy). Opt-in via env `WI_TEMPLATES_PATH` (path al catalogo): se non settato, validazione skippata silenziosamente — nessun impatto sugli agenti che non l'hanno configurato. Lazy-reload on-miss (stesso pattern del registry agenti, vedi sotto).

**Refresh registry `board_agents` (v0.10.2, GTD f67f9524):** prima gli slug agente erano risolti una volta al boot (`resolveAgentRegistry`) — un agente aggiunto a `board_agents` dopo il boot risultava "Unknown agent" sulle window già aperte, senza restart. Ora ogni validazione slug (`board_send`, `wi_start --agent_slug`, ecc.) fa lazy-reload (`refreshAgentRegistry`) quando lo slug non è nella mappa in-memory, prima di rispondere con errore.

**`wi_end` params Phase 1 D-074/D-075 (v0.9.0):**
| Param | Tipo | Effetto |
|---|---|---|
| `force_ephemeral` | `boolean?` | Bypassa gate durable (gate_bypassed=true in risposta) |
| `force_reason` | `string?` | Motivazione del bypass (log) |
| `arm_gtd_ids` | `string[]?` | UUID GTD da armare (autopilot=true) dopo close; soft-warn su missing/unowned |
| `post_runtime_request` | `enum?` | Scrive runtime request atomicamente dopo close (continue/clear/kill/model/none) |
| `platform_contribution` | `string?` | Testo contributo piattaforma: dev-* → forge, analyst-* → atlas via board_message info |

**Gate durable (D-074):** `wi_end(status='done')` su WI con `template_name` NON in `EPHEMERAL_TEMPLATES` e layer ≠ `on-the-fly` richiede ≥1 link `doc_item_wi_links` verso un `requirement` o `sdes_entry`. Fallisce con errore se il gate non passa.
`EPHEMERAL_TEMPLATES = ['session-meta', 'triage', 'conversation']` — questi WI e quelli on-the-fly bypassano automaticamente il gate.

**Derivazione `template_layer`:** se non fornito esplicitamente (`wi_start` / `wi_link_template`), viene derivato da `template_name`:
- ≤2 segmenti (`fix-bug`, `menu-plan`) → `L1`
- 3+ segmenti (`fix-bug-frontend`, `deploy-vercel-staging`) → `L2`
- `template_name` assente → `on-the-fly`

### Runtime Tools (loomx_agent_runtime — control-plane D-053)

2 tool per il control-plane lifecycle. Il reconciler (dev-hq) è il consumatore principale della scrittura; il broker (loomy-assistant) è il consumatore principale della lettura (stall-triage D-058).

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `runtime_request` | Scrive request=clear\|kill\|model\|none sulla propria riga runtime (owner_slug=self) | UPDATE loomx_agent_runtime |
| `runtime_status` | Read-only: riga singola (`agent_slug`) o intera flotta (solo loomy/broker); campi mode/request/model_current/context_pct/rate_5h_pct/rate_7d_pct/heartbeat_at/coordinator_active | SELECT loomx_agent_runtime |

> **Uso tipico autopilot:** a `wi_end`, se l'agente vuole rientrare nella coda di dispatch, chiama `runtime_request(request="clear")` prima di chiudere il WI.
>
> **Uso tipico broker (D-058):** in stall-triage, `runtime_status(agent_slug=<agente in stallo>)` prima di decidere `continue/clear/kill` al posto suo via `runtime_request(agent_slug=...)`.
>
> **Regola ownership:** ogni agente scrive/legge la propria riga senza restrizioni; lettura di righe altrui o della flotta intera è riservata a loomy/loomy-assistant. La riga deve esistere (agente già heartbeated), altrimenti ritorna errore esplicito.

**Enum `request`:**
| Valore | Significato |
|---|---|
| `continue` | Prossimo task in-place senza /clear (context <65%, cache calda) |
| `clear` | /clear poi prossimo task (context ≥65% o cache fredda) |
| `kill` | Stop agente (il reconciler non ri-schedula) |
| `model` | Cambia modello (richiede `requested_model` es. `sonnet`, `opus`) |
| `none` | Annulla richiesta pendente |

### Eval Tools (loomx_eval_runs — D-105 attribution gap, v0.14.0)

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `eval_run_add` | Registra un run in `loomx_eval_runs`. **`triggered_by`** non è mai accettato come testo libero dal chiamante — viene forzato a `selfSlug` (identità nativa D-084 dove il rollout è arrivato, altrimenti `--agent`). Solo loomy può attribuire un run a un altro agente. Link via `eval_id` (uuid) o `eval_code` (`loomx_evals.code`, risolto server-side) | INSERT loomx_eval_runs |

> **Gap chiuso (D-105, GTD 289954a0):** dba aveva applicato lo schema `loomx_evals`/`loomx_eval_runs` 1:1 col design ma segnalato che "l'owner scrive i propri run" non è enforceable a floor DB — tutta la flotta tranne loomy scrive via `service_role` letterale (bypassa RLS per definizione, D-084). L'enforcement reale (non-ripudiabilità di chi ha lanciato un run) è qui: solo loomy può override `triggered_by`. Stesso gap noto per `loomx_agent_consumption` (nessun tool board-mcp la scrive, fuori scope) e `loomx_agent_pings` (tabella droppata, superseduta da `ping`/D-093 — vedi sotto).

### Ping (cold-start cross-agente, D-093 — hooked su board_send/board_ack)

**Pivot ratificato (D-093, Loomy msg 58c130be):** il build separate-table `loomx_agent_pings` (D-092, dev-hq) è stato **abbandonato** — tabella mai popolata, `DROP TABLE` proposto a DBA. Il ping si aggancia al meccanismo esistente `board_send`/`board_ack`: un ping è un `board_send(type='info')` con il marcatore `wake_priority` (colonna additiva su `board_messages`, nullable — NULL = messaggio normale, comportamento invariato). Nessuna tabella/inbox/tool di ack dedicati. Design completo: `hub/it-manager/design/ping-cold-start.md`.

- `ping(target_agent, message, priority?)` → thin wrapper su `board_send` (vedi tabella Board Tools sopra)
- Lettura ping: `board_inbox(wake_only=true)` (non esiste `ping_inbox`)
- Ack: `board_ack` esistente (non esiste `ping_ack`)
- Enum `wake_priority`: `normal` / `high` / `urgent` (niente `low` — assenza di wake = campo NULL)

> **Colonna pending (D-093):** `board_messages.wake_priority` è da aggiungere lato DBA (coordinamento it-manager↔DBA, ordine: colonna prima del pass-through). `board_send`/`ping` passano già il campo — falliranno a runtime finché la migration non è live (stesso pattern di `loomx_work_items`/`loomx_agent_runtime` pre-DDL).
>
> **L2 cold-wake (ownership it-manager/reconciler, D-099):** il reconciler scansiona `board_messages WHERE wake_priority IS NOT NULL AND status='pending'` per il cold-wake del target — QUALSIASI valore (anche `normal`) sveglia, la priorità ordina solo la coda (`urgent`>`high`>`normal`), non decide se svegliare (verificato in `loomx_agent_manager.py:2375`). Fuori scope board-mcp, riusa ~90% del motore `process_pings` di dev-hq (repoint della query).

### Org Registry Tool (loomx_role_cards / loomx_org_edges / loomx_sow_raci — D-090/D-091)

1 tool read-only sopra le 3 tabelle org-registry (migration DBA `20260706100000`, design `hub/initiatives/org-registry/design.md` §2/§3). Disponibile a **tutti** gli agenti (knowledge sharing, nessuna restrizione per slug) — vincolo read-only: le scritture su card/archi/RACI passano da Loomy.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `org_lookup` | `agent?` → role-card + archi (reports_to/escalates_to/asks_help_from); `question` seleziona `card`\|`chain`\|`escalation`\|`help` (default `card`); `domain?` filtra escalation/help; `project?` (slug o UUID `loomx_projects`) → matrice RACI; `sow?` filtra per SoW (WIP); `raci?` filtra la matrice per ruolo | SELECT loomx_role_cards / loomx_org_edges / loomx_sow_raci |

> **Fallback escalation:** se manca un arco `escalates_to` esplicito per il `domain` richiesto, `org_lookup` risale la catena `reports_to` di un hop (`source: "fallback_reports_to"` nella risposta).
>
> **Fallback RACI:** se il progetto non ha righe in `loomx_sow_raci`, la risposta ritorna `raci: null` + `fallback.owner = loomx_projects.agent_id` (comportamento attuale, D-091).
>
> **Nota persone in RACI:** `loomx_sow_raci.person_id` non ha ancora FK verso `loomx_people` (tabella non esiste, D-084 pending) — i soggetti persona vengono ritornati come `person:<uuid>` finché la tabella non atterra.
>
> **Gap noto (bloccante per `project=`):** il ruolo nativo `board-mcp` (backend `DATABASE_URL`, D-084) non ha GRANT SELECT su `loomx_projects` — stesso stesso gap di `loomx_item_projects` risolto ieri, ma esteso a `loomx_projects` stessa. `project_list` e `org_lookup(project=...)` falliscono con `permission denied for table loomx_projects` per qualunque agente diverso da loomy. Segnalato a DBA (GTD + board_send), non risolvibile lato board-mcp.

### Document Model Tools (documents / doc_items — D-a5 F1)

8 tool sopra lo schema F0 del DBA (migration `20260627020000`). Modello documento UNICO riusabile (`documents` + `doc_items` tipati) per tutti gli artefatti governance (SoW, REQ, SDES, UAT, DECISIONS, KPI-catalog, mart-contract…). DB = SSOT. Self-describing: `doc_item_types` è la superficie how-to primaria. Spec: `hub/docs/design-D-a5-documents-model.md` §7 + §16.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `doc_create` | Crea documento (default status=draft, version=1.0, visibility=project, owner=self) | INSERT documents |
| `doc_item_upsert` | Insert/update riga tipata; idempotente `(project_id,code)` / `(document_id,client_token|sort_order)`; valida `attrs` vs JSON-Schema; **RITORNA UUID** | UPSERT doc_items |
| `doc_item_resolve` | `(project_id,code)→uuid`; project_id obbligatorio; mai sceglie su ambiguità; **audit-log** ogni chiamata | SELECT doc_items |
| `doc_link` | UUID-only, enum `target_kind doc\|gtd\|wi` instrada alle 3 tabelle (nessun param code) | INSERT doc_item_links / doc_item_gtd_links / doc_item_wi_links |
| `doc_link_by_code` | Sugar resolve+resolve+link project-scoped (stesso resolver loggato) | SELECT×2 + INSERT |
| `doc_supersede` | Old→superseded (immutabile) + nuova riga + edge `supersedes`; codice trasportato | UPDATE + INSERT×2 |
| `doc_query` | Filtro item + traceability (`req_without_sdes`, `sdes_without_uat`) | SELECT + JOIN in JS |
| `doc_item_types` | Introspect registry: per type schema+status+esempio; full-mode include `capability_parity` | — (registry in-code) |

> **Capability-parity gate (§16):** `checkCapabilityParity()` (`src/docTypes.ts`) asserisce che ogni enum DB (`item_type`/`status`/`relation_type`) abbia un tool-path → **build rossa** se manca. CI: `tests/capability-parity.test.ts`.
>
> **Regole:** schema `doc_*` resta del DBA (D-005) — i tool sono solo il layer MCP.
>
> **F4.5 (D-a5-F4.5, v0.8.0):** i doc_* NON girano più in `service_role`. Ogni call apre `BEGIN; SET LOCAL ROLE doc_rw; SELECT set_config('request.agent_slug', <selfSlug>, true); …; COMMIT;` → RLS (D-015) imposta a DB-floor per-agente. Lo slug è quello dell'istanza (`selfSlug`), bound param, mai input utente. `code→uuid` SOLO via la DB function `doc_item_resolve` (RLS-aware, audita `doc_resolve_log` su successo, errori 42501/P0002/22004). Audit: su successo, `resolveDocItem` scrive in DB (no stderr ridondante); su errore, la tx è rolled back → stderr best-effort (`auditResolve`). **Connessione:** `DOC_RW_DATABASE_URL` (direct-pg, login role con `GRANT doc_rw`) in produzione; senza un backend doc_rw i doc_* **rifiutano** di girare (niente bypass). Smoke/dev: `SUPABASE_MGMT_PAT`+`SUPABASE_PROJECT_REF` (Management API). `runDocRw` in `src/docDb.ts`.
>
> **Write-path fix (v0.8.1):** sotto doc_rw un `INSERT/UPDATE … RETURNING` fa valutare la RLS WITH CHECK col GUC come NULL → write negate (42501). Il path doc_rw gira quindi in "no-RETURNING mode" (`PgQuery` opts): INSERT con id client-side + risultato sintetizzato, UPDATE + follow-up SELECT. Fix DB definitivo (al DBA): helper policy `loomx_*` → VOLATILE invece di STABLE.

### Tipi di messaggio

| Type | Uso |
|---|---|
| `task` | Delega di un task da un agente all'altro |
| `question` | Richiesta di informazione |
| `blocker` | Segnalazione di blocco |
| `done` | Notifica di completamento (ref_id → messaggio originale) |
| `alignment_issue` | Inconsistenza governance rilevata |
| `info` | Messaggio informativo generico (es. status update, notifica) |

### Agenti — DB-first (D-104)

Niente più roster narrativo qui: era una tabella duplicata (31 slug, includeva `sintesi-impianti` e `marketing`/Muse — entrambi offboarded) scambiata in una scansione precedente per "lista destinatari `board_send`" — non lo è. Fonti live:

| Cosa serve | Dove |
|---|---|
| Ruolo/confini/riporti di un agente | `org_lookup(agent="<slug>")` |
| Chi esiste ed è attivo | `board_agents` (via `org_lookup` o query diretta) |
| Dove sta il repo/dir di un agente | `hub/agents.yaml` |

**Confine (non è duplicazione):** l'**enum dei destinatari** di `board_send`/`ping` resta di proprietà board-mcp e va tenuto allineato a `board_agents` — è il contratto del tool (AGENT-STANDARD §0), non questa tabella descrittiva.

---

## Configurazione agenti

Ogni repo agente ha un `.mcp.json` (in `.gitignore`) + `.mcp.json.example`:

```json
{
  "mcpServers": {
    "board": {
      "type": "stdio",
      "command": "node",
      "args": ["../loomx-board-mcp/dist/index.js", "--agent", "<agent-id>"],
      "env": {
        "SUPABASE_URL": "https://xxxxx.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
      }
    }
  }
}
```

Per agenti con accesso ai dati famiglia (es. assistant/Evaristo), aggiungere:

```json
"env": {
  "SUPABASE_URL": "...",
  "SUPABASE_SERVICE_ROLE_KEY": "...",
  "HOME_FAMILY_ID": "<uuid famiglia>",
  "HOME_USER_ID": "<uuid auth.users(id) — NON family member_id>"
}
```

> `HOME_USER_ID` deve essere un `auth.users(id)` valido (vedi D-017). Valore corretto per Evaristo: `5a2df80b-aa01-4b68-976e-192d6ca4227e`.

---

## Documenti governance (DB-first, D-a5) §6bis

I documenti governance (DECISIONS e futuri SoW/req/sdes/uat) sono **DB-first** (D-a5). Il DB (`documents`/`doc_items`) è la SSOT; i `.md` in `docs/` sono **mirror GENERATI** (dump da DB).

| Operazione | Come fare | MAI fare |
|---|---|---|
| Leggi un documento | `doc_query(project_id="596cd5fc-d385-4763-9c52-6fb48738d7dc")` via board-mcp | aprire il .md per editarlo |
| Scrivi/aggiorna un item | `doc_item_upsert(project_id, document_id, item_type, code, body, ...)` | editare il .md direttamente |
| Crea un link | `doc_link(target_kind, from_id, to_id, relation_type)` | scrivere a mano nel .md |
| Risolvi un codice | `doc_item_resolve(project_id, code="D-001")` | cercare il codice per testo |

I `.md` in `docs/` con header `<!-- GENERATED — do not edit, source=DB -->` non vanno editati: il lint (`doc-lint.sh`) fallisce con `frozen-md-edited`. Per rigenerare il mirror: `loomx-doc-dump --document-id <uuid> --output docs/<file>.md`.

- **project_id board-mcp:** `596cd5fc-d385-4763-9c52-6fb48738d7dc`
- **DECISIONS document_id:** `1da8642c-cfe2-48b9-be55-701e26d89b07`
- **NB doc_rw (F4.5):** i doc_* girano sotto ruolo `doc_rw`. Per board-mcp serve `DOC_RW_DATABASE_URL` nel `.mcp.json` (oggi non presente → restart pendente per esporre i doc_* live via MCP; vedi DECISIONS D-a5-F4.5).

**Cross-decisions (D-065):** decisioni valide per tutti i progetti LoomX risiedono nel progetto hub.

| Operazione | Come fare |
|---|---|
| Leggi cross-decisions | `doc_query(project_id="22ae4e79-1800-4975-ba46-cd2f86734257", document_id="368fafde-a880-46bd-bf8c-c2ed9c5d9029")` |
| Leggi decisioni progetto | `doc_query(project_id="596cd5fc-d385-4763-9c52-6fb48738d7dc", document_type="decisions")` |
| Proposta cross-decision | `board_send(to_agent="loomy", type="question", tags=["cross-decision-proposal"])` |

> **HISTORY.md resta .md hand-edited** (storico sessioni, non documento governance strutturato). Solo DECISIONS è migrato.

---

## Regole operative

### Sviluppo
- TypeScript strict mode
- Nessuna dipendenza non necessaria
- Gestione errori esplicita — mai fallire silenziosamente
- Log su stderr (MCP usa stdout per il protocollo)

### Sicurezza
- Service role key MAI nel codice — solo via env
- `.env` in `.gitignore`
- Validare input di ogni tool (agent ID, message type, etc.)

### Cross-impact (D-005)
- Modifiche allo schema `board_*` → PR al DBA (`loomx-home-DBA`)
- Modifiche ai tool names/signatures → notificare Loomy prima
- Nuovi agent IDs → approvazione Loomy

### Lingua
- Risposte: **italiano**
- Codice, commenti, commit: **inglese**

### Autopilot closure (D-069)
GTD follow-on: crea con `autopilot=false` → `wi_end` → `gtd_update(autopilot=true)` → `runtime_request(request=...)`.
NON armare GTD prima di `wi_end` — il reconciler li vede con WI ancora aperto (race condition).

---

## Coordinamento

- **Loomy** → `../../../00. LoomX Consulting/` (coordinatore root LoomX)
- **DBA** → `../loomx-home-DBA/` (schema Supabase — migrazioni `board_*` via PR)
- **Tutti gli agenti** → consumer del board

---

## Skill

```
SKILL_ROOT = .skills/skills
```

| Skill | Path | Quando invocare |
|---|---|---|
| `session-manager` | `$SKILL_ROOT/session-manager/SKILL.md` | Inizio/fine sessione, checkpoint, status report |
| `security-auditor` | `$SKILL_ROOT/security-auditor/SKILL.md` | Review sicurezza prima di release |
| `requirements-engineer` | `$SKILL_ROOT/requirements-engineer/SKILL.md` | Formalizzare requisiti prima di implementare |
| `audit` | `$SKILL_ROOT/audit/SKILL.md` | Validare codice e PR prima del merge |
| `sprint-manager` | `$SKILL_ROOT/sprint-manager/SKILL.md` | Pianificazione sprint, tracking, gate verification |

Quando una situazione matcha il trigger di una skill:
1. **Leggi** il file SKILL.md corrispondente
2. **Segui** le istruzioni passo-passo
3. **Non improvvisare** — la skill definisce il processo

---

*Creato: 2026-03-30 | Allineato: 2026-07-06 (tool org_lookup, org-registry F3, D-091)*

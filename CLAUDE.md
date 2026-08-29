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
└── .skills/               ← legacy, non usare (sede reale: ~/.claude/skills, §9)
```

---

## MCP Tools

46 tool base esposti a ogni agente (24 board/gtd/wi/runtime/ping + 11 doc_* document model — incl. `doc_rename` e `doc_structure`, v0.25.0 — + 7 subscription tool — incl. `doc_fact_sync` — + 3 staleness/decay tool + 1 `org_lookup`) + 8 tool home_* (condizionali, richiedono HOME_FAMILY_ID + HOME_USER_ID):

### Board Tools (board_messages)

> **v0.3.0 preview mode (D-020):** `board_inbox` e `board_overview` omettono il body per default. Usa `board_get(id)` per il body completo di un messaggio specifico.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `board_send` | Invia messaggio con summary e tags opzionali. **`wake_priority?`** (D-093, v0.13.0): normal\|high\|urgent — marca il messaggio per cold-wake. **`requested_model?`** (D-098/D-101, v0.16.0): modello per il lancio del destinatario sul cold-wake (es. `sonnet`, `opus`) — significativo solo insieme a `wake_priority`, scritto su `board_messages.requested_model`, free-text pass-through (nessun default/normalizzazione lato tool). **`auto_gtd?`** (GTD 994b3bbc): crea anche un GTD per il destinatario (owner=recipient, source='board', source_ref=id messaggio), deduplicato su re-invii — default false, non cambia il comportamento esistente. **Hint cold-recipient (D-118 c2, v0.15.0):** se `type∈{task,question,blocker}` e `wake_priority` omesso e il destinatario risulta cold (`loomx_agent_runtime.heartbeat_at` stale/assente, soglia 10'), la risposta include `hint` — mai un errore, il send va comunque a buon fine. Gated da `LOOMX_RW_GUARDS_ENABLED` (default off: log-only su stderr, nessun campo in risposta finché il flag non è `1` — eval-first, vedi HISTORY) | INSERT (from_agent = self) [+ INSERT loomx_items se auto_gtd] |
| `board_broadcast` | Invia messaggio a tutti gli agenti attivi. **`auto_gtd?`** (GTD 994b3bbc): come sopra ma un GTD per ciascun destinatario (N destinatari → N GTD, uno per owner — non più affidato al triage manuale) | RPC board_broadcast [+ INSERT loomx_items per destinatario se auto_gtd] |
| `board_inbox` | Leggi messaggi in arrivo — **`preview_only=true` default** (no body). **`wake_only?`** (D-093): filtra solo i messaggi con `wake_priority` settato | SELECT (to_agent = self) |
| `board_get` | Body completo di un singolo messaggio (detail on-demand) | SELECT by id |
| `board_ack` | Conferma ricezione messaggio | UPDATE status → acknowledged |
| `board_update_status` | Aggiorna stato messaggio | UPDATE status → in_progress / done / cancelled |
| `board_overview` | Vista globale — **`include_body=false` default**, limit 20 | SELECT da view board_overview |
| `board_thread` | Recupera thread di conversazione (messaggio originale + risposte) | SELECT (id/ref_id match) |
| `board_archive` | Archivia messaggi done/cancelled piu' vecchi di N giorni | RPC board_archive_old |
| `ping` | Alias ergonomico (D-093) su `board_send(type='info', wake_priority=priority)` — NON storage separato. **`requested_model?`** (D-098/D-101, v0.16.0): come su `board_send`, modello per il lancio sul cold-wake | INSERT board_messages (via board_send) |

### GTD Tools (loomx_items)

> **v0.3.0 preview mode (D-020):** `gtd_inbox` e `gtd_query` omettono body per default e aggiungono `body_preview` (200 chars). Usa `gtd_get(id)` per il body completo.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `gtd_inbox` | Leggi item GTD dell'agente — **`preview_only=true` default** (body_preview 200 chars) | SELECT (owner = self) |
| `gtd_get` | Body completo di un singolo GTD item (detail on-demand) | SELECT by id |
| `gtd_add` | Crea nuovo item GTD. **`project_id?`** (D-102, v0.16.0): UUID `loomx_projects` opzionale — valida l'esistenza (errore esplicito se non trovato, nessun GTD orfano) e crea il link `loomx_item_projects` nella stessa chiamata (`project_link` in risposta). Opzionale in questa fase, mai derivato dal WI attivo. **Soft-warn `project_id` assente (Stream B-4, GTD 3acb2328, v0.16.1):** se omesso, la risposta include `project_warning` — mai un errore, il GTD viene creato comunque. Non è un rimprovero: un item senza progetto è uno stato valido (cross-progetto/personale, AGENT-STANDARD §5) — il messaggio lo dichiara esplicitamente invece di limitarsi a segnalare l'assenza. Nessun valore sentinella introdotto per "nessun progetto, deliberato" — l'omissione è già lo stato valido esistente (D-136 §5: niente contratto inventato senza passare da Loomy) | INSERT [+ UPSERT loomx_item_projects se project_id] |
| `gtd_update` | Aggiorna item esistente (owner-only, loomy puo' tutto). **D-069 guard:** rifiuta `autopilot=true` se l'owner ha un WI active (two-phase arm). **D-093 hardening:** il broker (loomy-assistant) puo' armare `autopilot=true` su un item di un altro owner SOLO se `clarified_at IS NULL` (mai ackato dall'owner); se `clarified_at` e' valorizzato deve escalare a loomy — stessa logica del gate `clarified_at` (non settabile dal broker su item altrui), ma condizionale invece di esclusione totale | UPDATE |
| `gtd_query` | Query flessibile — **`preview_only=true` default**, limit 20 | SELECT + JOIN |
| `gtd_complete` | Shortcut per segnare item come done. **`pending_inbox` (D-205, v0.21.0):** completando un item proprio, la risposta porta la coda ancora pendente (vedi sotto) — informativo puro, mai bloccante; assente quando loomy completa l'item di un altro | UPDATE (gtd_status = done) |
| `gtd_link_agent` | Aggancia un agente come co-engaged su un item (owner o loomy only) | INSERT loomx_item_agents |
| `gtd_unlink_agent` | Rimuove un agente co-engaged da un item (owner o loomy only) | DELETE loomx_item_agents |
| `gtd_list_agents` | Lista agenti co-engaged su un item (owner, co-engaged, o loomy) | SELECT loomx_item_agents |
| `item_project_link` | Aggancia un item GTD a un progetto (owner o loomy only, idempotente) | UPSERT loomx_item_projects |
| `project_list` | Lista progetti (id, name, short_name, status, agent_id, `is_sandbox`) — no write path, per scoprire project_id senza Management API. **`is_sandbox` (v0.22.2, DEL-003/SDES-009, msg forge 162add27):** i progetti sandbox sono esclusi per difetto dai conteggi (`is_sandbox=false` implicito) — `include_sandbox=true` per vederli | SELECT loomx_projects |

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
| `wi_end` | Chiude WI (status=done/failed/waiting/escalated); cascada GTD; gate durable (D-074); `escalated` → `escalation_pending` + destinatario da organigramma (D-135, vedi sotto) | UPDATE loomx_work_items + loomx_items [+ INSERT board_messages best-effort se escalated] |
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
| `arm_gtd_ids` | `string[]?` | UUID GTD da armare (autopilot=true) dopo close; soft-warn su missing/unowned e su GTD armato senza `autopilot_model` (v0.20.3, GTD 6bbc293b — vedi sotto) |
| `arm_gtd_model` | `string?` | (v0.20.3) Modello di fallback applicato SOLO ai GTD armati che non ne hanno già uno — non sovrascrive mai un `autopilot_model` esistente |
| `post_runtime_request` | `enum?` | Scrive runtime request atomicamente dopo close (continue/clear/kill/model/none) |
| `platform_contribution` | `string?` | Testo contributo piattaforma: dev-* → forge, analyst-* → atlas via board_message info |

**Fix `arm_gtd_ids` senza modello dispacciabile (v0.20.3, GTD 6bbc293b):** prima l'arm settava `autopilot=true` ma non toccava `autopilot_model` — un GTD senza modello risultava "armato" e non veniva mai dispacciato dal reconciler, in silenzio (risposta `ok`, nessun errore). Probabile causa reale, mai trovata prima, del caso 17/08 (`f135aae4`, attribuito all'epoca al re-arm del reconciler). Ora: il modello esistente è sempre preservato (mai sovrascritto); se assente viene riempito da `arm_gtd_model` se fornito; se resta assente, `arm_warnings` lo dichiara esplicitamente invece di armare in silenzio — pattern soft-warn coerente col resto di `wi_end` (mai bloccante).

**`pending_inbox` (D-205, v0.21.0, REQ-GOV-151..154 / SDES-GOV-156-157, progetto `85d81454-5b38-40bb-b8c6-9d5188ef1a34`):** su OGNI percorso di chiusura reale — `wi_end` (qualsiasi status, incluso il ramo con GTD-sync fallito: il WI è comunque chiuso) e `gtd_complete` — la risposta porta `pending_inbox`: `{count, messages[≤5]{id, from, type, subject, age_minutes}, truncated?}`, i messaggi `task`/`question`/`blocker` ancora `pending` per il proprietario. **Additivo e informativo puro** (REQ-GOV-152): nessun blocco, nessuna scrittura, nessun avviso separato — serve a entrare nella scelta `continue`/`clear`/`kill`. **`count: 0` viene riportato**, non omesso: «coda vuota» è un input reale alla decisione di `kill`. Il campo è invece **assente** (mai un finto vuoto) quando chi chiude non è il proprietario — la raccolta orfani è esclusa da REQ-GOV-151: non è una chiusura, e nessun agente vivo sta decidendo — o quando il registry non risolve lo slug. **Nessun flag** (SDES-GOV-156): a differenza di D-118 il rischio è diverso — read-only e non bloccante. **Naming** (REQ-GOV-153): `pending_inbox`, distinto da `inbox_pending_warning` di D-118, che è **superseduto** (REQ-GOV-154). `checkInboxPendingGuard` **rimossa** (SDES-GOV-157, gate confermato da it-manager msg a3ce4b29, commit separato come da mandato — mai bundlata con la release che ha portato `pending_inbox` live). `resolveAutoWaitingOn` (guard (a), stesso flag) **non è stata toccata**: funzione diversa, spegnerla per adiacenza sarebbe stato l'errore che D-205 corregge.

**D-118 reply-wake structural guards (v0.15.0, GTD 1aa130da, proposta it-manager msg 49a4177c):** nessun nuovo param — `wi_end` ora rileva e riporta automaticamente in risposta (mai bloccante):
- **(a+) `inbox_pending_warning?`** — se il proprietario del WI ha in inbox messaggi `task`/`question`/`blocker` ancora `pending`, un warning testuale (subject/mittente/età del più vecchio). È la rete che avrebbe intercettato il deadlock it-manager↔board-mcp del 2026-08-10 (due messaggi incrociati, nessuno con `ref_id`, nessuno con wait dichiarato): alla chiusura l'agente è ancora vivo e vede l'informazione.
- **(a) `waiting_on_auto_set?` / `waiting_on_warning?`** — solo su `status='waiting'` e solo se il GTD linkato non ha già un `waiting_on` esplicito: se c'è un outbound `question`/`task` del WI owner (dal `started_at` del WI) senza reply nel thread, setta `waiting_on=<destinatario>` + `block_scope='reply-wake'` sul GTD (euristica: il più recente; un pareggio esatto di timestamp → `waiting_on_warning` invece di un auto-set indovinato).
- **Gate rollout (`LOOMX_RW_GUARDS_ENABLED`, default off, `src/flags.ts`):** con flag OFF entrambi i guard **calcolano** il risultato ma non toccano risposta né DB — solo log stderr `[wi_end][dry-run] would-warn/would-set`. Stesso gate su `board_send` (hint c2, vedi Board Tools). Mandato Achille D-118: "niente flip senza suite verde" — vedi HISTORY per lo stato del catalogo eval `E2E-RW-*` (loomx_evals, gap DBA-side alla release v0.15.0).

**Gate durable (D-074):** `wi_end(status='done')` su WI con `template_name` NON in `EPHEMERAL_TEMPLATES` e layer ≠ `on-the-fly` richiede ≥1 link `doc_item_wi_links` verso un `requirement`, `sdes_entry` o `decision`. Fallisce con errore se il gate non passa. **`decision` accettato (v0.16.2, msg loomy 3fb74e48, GTD f5562c40):** D-074 stesso descrive la catena come `Decisione → REQ → SDES → Config/Schema` — un WI di governance/coordinamento il cui artefatto durevole È la decisione (non un REQ/SDES a valle) può linkarla direttamente invece di dichiarare `force_ephemeral=true` (che affermerebbe il falso: "nessun artefatto durevole").
`EPHEMERAL_TEMPLATES = ['session-meta', 'triage', 'conversation', 'audit-agent-alignment']` — questi WI e quelli on-the-fly bypassano automaticamente il gate. (`audit-agent-alignment`: report interno, nessun REQ/SDES a valle — loomy-approved, msg f7447db6.)

**`wi_end(status='escalated')` — D-135, v0.28.0, REQ-GOV-085/086/087, GTD c82a33d8:** "percorso anticipato" — richiede `escalation_reason`; `escalation_domain?` opzionale per lo `escalates_to` (fallback `reports_to` se assente/senza match). Nella STESSA `UPDATE` del verdetto: WI → `escalation_pending` (mai `escalated` direttamente — lo scrive solo il trigger DB, `loomx_wi_escalation_pending_terminal`/`loomx_wi_promote_to_escalated`, migration dba `20260828140000`), `escalation_target` letto **a runtime** dall'organigramma (`loomx_org_edges`, mai un campo cacheato), `escalated_at`, `ended_at` resta NULL (il WI è "consegnato", non chiuso). Lo stato **non dipende** da nessuna azione successiva: la risposta ritorna `escalation_target`/`escalation_target_source` per il messaggio "ricco" dell'operatore, ma questa stessa chiamata invia già, best-effort, il messaggio interno che soddisfa il predicato di promozione (`board_messages.wi_ref=<wi_id> AND to_agent=escalation_target` — **non** solo `wi_ref IS NOT NULL`, altrimenti chiunque potrebbe promuovere il WI di chiunque, vedi board thread `4adb7818`/`b23fd91d` con dba). `wi_ref` **non** è un parametro di `board_send`: lo scrive solo questo percorso interno. Fallimento dell'invio → `escalation_message_warning`, mai bloccante (il WI resta comunque `escalation_pending`). **Self-escalation (REQ-GOV-087):** se il target risolto coincide con l'owner del WI, devia sull'`auditor` (terzo indipendente, D-016); se è l'auditor stesso a escalare, il target diventa il suo `human_ref` (`escalation_note` lo dichiara — nessun agente board dispatchabile per un umano, gap noto SDES-GOV-152, `waiting_on`/messaggio interno skippati in quel caso). GTD del proprietario → `waiting`, `waiting_on=escalation_target`, `block_scope='reply-wake'` (stessa convenzione del guard D-118 (a), qui deterministica). **Pending lato dba:** la colonna `board_messages.wi_ref` e il trigger `AFTER INSERT` che chiama `loomx_wi_promote_to_escalated` non sono ancora applicati (coordinamento concluso, dba in attesa che il lato board-mcp fosse pronto) — finché non atterrano, l'INSERT del messaggio interno fallisce a runtime (stesso pattern pre-DDL di `wake_priority`/D-093) e resta solo `escalation_message_warning` a dirlo.

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
>
> **Contratto cambio-modello (D-101, v0.16.0):** `request=model` è legittimo in QUALSIASI mode (interactive/autopilot/chat/dream), non solo autopilot — bug storico 69f39997 era un CHECK constraint DB mancante `'model'` nell'enum, già fixato dal DBA il 2026-07-21, verificato live. Guard aggiuntivi gated `LOOMX_MODEL_GUARDS_ENABLED` (default off, eval-first come D-118): Haiku **mai** ammesso quando la riga target ha `mode=autopilot` (§0quater) → rifiutato esplicitamente a flag ON, solo log dry-run a flag OFF; `cost_notice` (mai bloccante) su upgrade di tier verso un modello più costoso. `requested_model` resta free-text pass-through (nessun registro alias canonico — scelta DBA, vedi D-101) — niente normalizzazione, niente validazione di esistenza.

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

### Document Model Tools (documents / doc_items — D-a5 F1)

9 tool sopra lo schema F0 del DBA (migration `20260627020000`). Modello documento UNICO riusabile (`documents` + `doc_items` tipati) per tutti gli artefatti governance (SoW, REQ, SDES, UAT, DECISIONS, KPI-catalog, mart-contract…). DB = SSOT. Self-describing: `doc_item_types` è la superficie how-to primaria. Spec: `hub/docs/design-D-a5-documents-model.md` §7 + §16.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `doc_create` | Crea documento (default status=draft, version=1.0, visibility=project, owner=self) | INSERT documents |
| `doc_item_upsert` | Insert/update riga tipata; idempotente `(project_id,code)` / `(document_id,client_token|sort_order)`; valida `attrs` vs JSON-Schema; **RITORNA UUID**. **PATCH dichiarato (v0.16.3, D-a5-upsert-patch-semantics):** ogni campo opzionale omesso è **conservato** — `attrs` e `status` inclusi (prima venivano riscritti dai default: un upsert del solo `status` azzerava gli `attrs` rispondendo `ok:true`). `attrs` passato **sostituisce** l'oggetto per intero (mai fuso) e `attrs:{}` svuota apposta; chiavi scartate e cambi di `item_type` in place escono in `warnings`, e la risposta porta `fields_written`/`fields_preserved`. Prima di rispondere `ok` la riga viene **riletta e confrontata** (D-132): mismatch → `ok:false`. **404 vs 403 (D-167, v0.16.5):** su `document_id` non trovato, invece del vecchio "not found. Create it first" (fuorviante quando la causa è RLS/membership mancante — spingeva a creare duplicati), l'errore ora distingue in base a `loomx_agent_in_project` (SECURITY DEFINER, già grantata a `doc_rw`, nessuna nuova DDL): se il chiamante non ha alcuna legittimazione sul progetto → errore access-denied esplicito ("may exist but can't be confirmed — do NOT doc_create"); se ce l'ha → messaggio "not found" originale (safe to create). **Esteso (v0.16.7, GTD dc4e943e):** il ramo "membro → safe to create" era falso — la membership sul progetto *nominato* non dice nulla su un documento che vive in un *altro* progetto. Misurato live: con `visibility='org'` il lookup by-id (non project-scoped by design) raggiunge il documento e risponde `project_id mismatch` + istruzione esplicita ("Do NOT call doc_create — retry with project_id=Y"); con `visibility='project'/'team'` su progetto non-membro la riga resta invisibile e il caso è **indistinguibile** da "non esiste" (è così che è nato il duplicato CFG-090 il 2026-08-16) → il messaggio non promette più sicurezza, dichiara cosa non può escludere. **Terzo ramo chiuso (v0.16.8, D-167 punto 4, msg dba 25bb24d9):** l'oracolo `doc_document_exists(uuid)` (SECURITY DEFINER, DBA migration `20260818215000`, ritorna SOLO true/false — mai project_id/owner) sostituisce l'euristica di membership. `documentNotFoundError` ora è deterministico: `exists=false` → 404 semplice invariato ("not found", doc_create è la risposta giusta); `exists=true` → 403 con testo **uniforme** indipendente dalla membership del chiamante sul progetto nominato ("exists but is not accessible... Do NOT call doc_create... request access from the project's owner"), mai il progetto/owner reale. Probe fallito → non asserisce nessuna delle due certezze. Non chiamato dentro una policy RLS (solo tool-layer, per mandato dba) | UPSERT doc_items |
| `doc_item_resolve` | `(project_id,code)→uuid`; project_id obbligatorio; mai sceglie su ambiguità; **audit-log** ogni chiamata | SELECT doc_items |
| `doc_item_chain` | **(v0.17.0, SDES-DOCM-020 / WI-G.2)** Percorre gli edge `supersedes` **in avanti** da un UUID vecchio alla versione in vigore. Serve dove `doc_item_resolve` non arriva: un **codice** viaggia già sulla riga nuova, un **riferimento a UUID** (norma D-170 per sottoscrizioni/citazioni) resta inchiodato alla versione corrente al momento del link. Ritorna `resolved_id` + `chain` (i salti con codice/status/`superseded_at`) + `hops` — il percorso è ispezionabile, mai un salto magico. **Non indovina mai:** fork (due righe che superseriscono lo stesso item) → errore che ELENCA i candidati (REQ-DOCM-007); ciclo → errore. **Visibilità ri-controllata a OGNI salto** (REQ-DOCM-006): se il successore non è leggibile la camminata si ferma con `terminal_reason='successor_not_readable'` e dichiara che `resolved_id` NON è garantito essere la versione in vigore — mai spacciare l'ultima riga leggibile per corrente. `max_hops` (default 32, ceiling 200): superarlo è errore esplicito, mai risposta troncata. **Nota di onestà nel contratto:** «nessun successore» significa sempre «nessun successore *visibile*» — la RLS può nascondere un edge quanto un item | SELECT doc_item_links + doc_items |
| `doc_link` | UUID-only, enum `target_kind doc\|gtd\|wi` instrada alle 3 tabelle (nessun param code). **Hook `fact_subscription` (v0.26.0, D-225/4bis, SDES-DECAY-003):** su un legame `verifies`/`satisfies` la risposta dichiara sempre cosa è successo al decadimento — derivata (il progetto aveva già l'opt-in: il legame porta decadimento dall'istante in cui nasce), oppure **perché no**: progetto senza opt-in (il legame è dichiarato ma non fa decadere nulla — la forma esatta di REG-011, detta invece che taciuta), cross-progetto (mai derivata: nessun pin di versione lì, debito R6), ammissione sospesa, già coperta, opt-in non verificabile (**si astiene** — una scrittura irreversibile non si fa su una precondizione non verificata). **Mai bloccante e mai distruttivo:** sotto `doc_rw` la chiamata è una sola transazione, quindi l'hook gira dentro un `SAVEPOINT` — senza, una sua query fallita aborterebbe l'INSERT del link (misurato dal vivo il 2026-08-29) | INSERT doc_item_links / doc_item_gtd_links / doc_item_wi_links [+ INSERT gov.doc_subscriptions se derivabile] |
| `doc_link_by_code` | Sugar resolve+resolve+link project-scoped (stesso resolver loggato) | SELECT×2 + INSERT |
| `doc_supersede` | Old→superseded (immutabile) + nuova riga + edge `supersedes`; codice trasportato | UPDATE + INSERT×2 |
| `doc_query` | Filtro item + traceability (`req_without_sdes`, `sdes_without_uat`, **`req_without_origin`**, **`broken_refs`**). **`broken_refs` (v0.27.0, msg forge `162add27` / loomy `c473e347` — UAT-PG-008 passo 1, condizione 11 dell'auditor):** quarta verifica, asse **integrità dei legami**, su **entrambe** le tabelle generiche (`doc_item_links` + `doc_item_xproject_links`), sotto `doc_rw` — ogni agente misura con la **propria** identità (il `permission denied` di forge era sul suo ruolo nativo, non su `doc_rw`). Unità di analisi: il **legame**, non la riga. Tre esiti mai fusi: `items` = legami verso una riga **ritirata** (`retired_statuses` = superseded/deprecated/archived/rejected, restituito in risposta perché la regola resti ispezionabile), ciascuno con `kind` e — se l'erede è visibile — `successor_id` + il rimando a `doc_item_chain`; `abstained_items` = bersaglio illeggibile da questa identità (la policy SELECT dei legami è ancorata al **solo** estremo FROM: si legge il legame e non il bersaglio — 11/1214 e 2/283 misurati); il resto `ok`. **Il puntatore a vuoto è impossibile per costruzione** (FK `ON DELETE CASCADE` su entrambi gli estremi di entrambe le tabelle) → `dangling:{count:0, measured:false, basis}`: un fatto strutturale con la sua base dichiarata, **mai** uno zero misurato — sotto RLS «cancellato» e «nascosto» tornano identici, e spacciare quello per zero sarebbe la cecità-vestita-da-assenza vietata da D-206/REQ-DOCM-012. Gli archi `supersedes` sono **esclusi** dalla classificazione (`coverage.skipped_supersedes`): puntano dal ritirato al suo erede per costruzione, valutarli marcherebbe come difettoso ogni item correttamente versionato. `cross_project_in` è un **pavimento**, non un totale (i riferimenti in entrata da progetti illeggibili sono invisibili), e lo dichiara. Misurato dal vivo 2026-08-29: board-mcp 151 classificati/0 rotti; project-governance 724/**26** (24 `deprecated` + 2 `superseded` senza erede). Fuori copertura, dichiarato: `doc_item_gtd_links`/`doc_item_wi_links` (`doc_rw` non può leggere `loomx_items`/`loomx_work_items`, `42501` misurato — un legame verso un GTD soft-deleted resta invisibile). **`visibility_gap` (D-167, v0.16.5):** 0 righe + chiamante senza `loomx_agent_in_project` sul progetto → risposta porta `visibility_gap:true` + `note` — il conteggio nudo era indistinguibile da corpus vuoto e ha mascherato per giorni un gap-check RLS-bloccato (GTD 63142305). **`req_without_origin` (v0.22.0, D-206, GTD 1b793e87 follow-on, msg loomy 28e9aa98):** terza verifica di tracciabilità, asse UPSTREAM (requisito→origine) — distinta dalle prime due che coprono la catena a valle (req→sdes→uat). Le 4 origini ammesse da D-206: elemento capitolato (`objective`/`deliverable`/`stop_condition`), decisione cross-progetto, decisione di progetto, documento a cui si ispira (qualsiasi altro `item_type` fuori dalla catena a valle, es. `section`/`prose`). Risposta: `coverage.covered_by` spacchetta il totale per tipo di origine (mai fuso in un numero solo); un legame cross-progetto il cui `item_type` non è risolvibile (RLS-invisibile da qui) **non** conta come "nessuna origine" — finisce in `abstained_items`/`coverage.abstained`, distinto dal vero gap in `items`/`coverage.gap` (per D-206 un gap vero significa capitolato incompleto, non requisito difettoso) | SELECT + JOIN in JS |
| `doc_item_types` | Introspect registry: per type schema+status+esempio; full-mode include `capability_parity` | — (registry in-code) |
| `doc_rename` | (v0.25.0, PJ-5, dba msg `6583a8a8`) Rinomina un documento — **solo il titolo**: status/visibility/owner sono atti diversi con legittimazioni diverse, e un `doc_update` che scrive qualunque cosa gli venga passata è il difetto di semantica-patch già pagato in v0.16.3. Legittimazione: owner o loomy (stessa soglia del publish — una rinomina cambia come tutta la flotta si riferisce al documento). Rilettura D-132; `old_title` catturato **per valore** prima della scrittura (alcuni client ritornano la riga viva: una ricevuta il cui «prima» è il «dopo» non prova nulla — difetto colto dal collaudo). Lineetta lunga nel nuovo titolo → **avvertimento** che cita PG-007, mai un rifiuto: quella norma è del manifesto project-governance, non di questo server (D-136 §5) | UPDATE documents.title |
| `doc_structure` | (v0.25.0, PJ-8) Legge la **struttura** di un progetto: documenti (tipo, titolo, stato, owner, visibility, versione dichiarata **e** pubblicazioni reali nel ledger — non sono la stessa cosa, e la differenza è il debito di pubblicazione), righe per stato e per tipo, legami per relazione, legami cross-progetto contati a parte, sottoscrizioni per origine **e** grado, marcature aperte. Chiude il gap annotato in #126/#130: `doc_query` filtra gli **item**, quindi un documento vuoto era indistinguibile da uno inesistente e nessuna superficie elencava i documenti. Uno zero dichiara **quale** zero è (`visibility.member` + nota: non-membro → «non misurabile da qui», mai «vuoto»). **Nessun fallimento tollerato:** ogni errore di lettura ritorna errore — la prima stesura degradava con una nota e, sotto `doc_rw` (una sola transazione, un errore la aborta), ha risposto «0 sottoscrizioni, 0 marcature» per un progetto che ne aveva 104 e 1 | SELECT documents/doc_items/link/gov.* |

> **Capability-parity gate (§16):** `checkCapabilityParity()` (`src/docTypes.ts`) asserisce che ogni enum DB (`item_type`/`status`/`relation_type`) abbia un tool-path → **build rossa** se manca. CI: `tests/capability-parity.test.ts`.
>
> **Regole:** schema `doc_*` resta del DBA (D-005) — i tool sono solo il layer MCP.
>
> **F4.5 (D-a5-F4.5, v0.8.0):** i doc_* NON girano più in `service_role`. Ogni call apre `BEGIN; SET LOCAL ROLE doc_rw; SELECT set_config('request.agent_slug', <selfSlug>, true); …; COMMIT;` → RLS (D-015) imposta a DB-floor per-agente. Lo slug è quello dell'istanza (`selfSlug`), bound param, mai input utente. `code→uuid` SOLO via la DB function `doc_item_resolve` (RLS-aware, audita `doc_resolve_log` su successo, errori 42501/P0002/22004). Audit: su successo, `resolveDocItem` scrive in DB (no stderr ridondante); su errore, la tx è rolled back → stderr best-effort (`auditResolve`). **Connessione:** `DOC_RW_DATABASE_URL` (direct-pg, login role con `GRANT doc_rw`) in produzione; senza un backend doc_rw i doc_* **rifiutano** di girare (niente bypass). Smoke/dev: `SUPABASE_MGMT_PAT`+`SUPABASE_PROJECT_REF` (Management API). `runDocRw` in `src/docDb.ts`.
>
> **Write-path fix (v0.8.1):** sotto doc_rw un `INSERT/UPDATE … RETURNING` fa valutare la RLS WITH CHECK col GUC come NULL → write negate (42501). Il path doc_rw gira quindi in "no-RETURNING mode" (`PgQuery` opts): INSERT con id client-side + risultato sintetizzato, UPDATE + follow-up SELECT. Fix DB definitivo (al DBA): helper policy `loomx_*` → VOLATILE invece di STABLE.

### Subscription Tools (gov.doc_subscriptions / gov.doc_subscription_outcomes / gov.doc_versions — DEL-002, v0.20.0)

4/4 tool ratificati in D-186 live (design SDES-SUB-000..007, doc `714d3313`, progetto board-mcp `596cd5fc`), **+1 `doc_repoint`** (v0.24.2, UAT-GOV-029 — non in D-186, nasce dalla migrazione dba `20260828065000`) **+1 `doc_version_delta`** (v0.24.3, SDES-SUB-008 — non in D-186, nasce dal blocker forge `05ba7c9e`). Girano sotto `doc_rw` come i `doc_*` (stesso `runDocRw`, `src/subscriptions.ts`).

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `doc_subscribe` | Crea sottoscrizione origin='choice' (le origini 'fact' sono automatiche, fuori da questo tool). Esattamente uno tra `target_item_id`/`target_document_id`. Idempotente su stesso intent (`created:false`); intent diverso = cambio di grado (`intent_changed`). `critical` cross-progetto **rifiutato in v1** (D-186 Q2). **Gate ammissione sospesa (v0.24.3, SDES-SUB-009, REQ-SUB-013 c.3, ask SDES-SUB-CP-004 §4 — msg forge `05ba7c9e`):** legge `loomx_governance_params.sottoscrizioni_ammissione_sospesa` e mentre vale ≠0 **rifiuta** le ammissioni nuove con errore parlante. Il gate sta **dopo** i rami idempotenza/cambio-grado, di proposito: ri-chiamare su una sottoscrizione che già hai non ammette nulla, e un cambio di grado agisce su un bersaglio già ammesso — congelare anche quelli sarebbe un allargamento della regola, che appartiene a chi la governa (D-136 §5). Flag illeggibile/assente/deprecato → **ammette ma lo dichiara** (`admission_gate: "NOT VERIFIED — …"`): murare la flotta per un parametro mancante è peggio del guasto prevenuto, tacerlo farebbe passare per verificata un'ammissione che nessuno ha verificato | INSERT/UPDATE gov.doc_subscriptions |
| `doc_version_delta` | (v0.24.3, SDES-SUB-008, msg forge `05ba7c9e` — sblocca UAT-SUB-003/REQ-SUB-003 c.2 e UAT-SUB-011) Il delta **strutturato** di una pubblicazione: quali righe `created`/`modified`/`superseded`/`removed` fra due versioni. `delta_summary` di `doc_publish` resta prosa per il ledger; **questo** è l'elenco su cui si filtra e si conta. **Derivato, non dichiarato:** `gov.doc_publish` scrive già uno snapshot per riga in `gov.doc_version_items` con `content_sha256` (misurato: 237 righe su 29 pubblicazioni), quindi il delta è un diff di snapshot consecutivi — **completo per costruzione** (non esiste un elenco che qualcuno compila e che possa troncare in silenzio, CV-8/D-203; oltre `MAX_VERSION_DELTA_ROWS` **rifiuta**, mai accorcia) e **retroattivo** sulle pubblicazioni già esistenti. `counts` porta `unchanged` e `total_rows_in_version` apposta: l'aritmetica è verificabile da fuori. Casi limite tutti espliciti: mai pubblicato → errore; snapshot mancante → errore («NON è un delta vuoto»); etichetta ambigua → elenca le reali, mai una scelta indovinata; baseline più recente del bersaglio → rifiuto; prima pubblicazione → `baseline:null` **dichiarato**. Read-only. **SDES-SUB-003 va aggiornato** (la sua scelta — elenco negli `attrs` del changelog da `doc_item_history` — è superata, e la dipendenza verso SDES-DOCM-025 cade): segnalato a forge/loomy, non riscritto qui (documento di items-subscription) | SELECT gov.doc_versions + gov.doc_version_items |
| `doc_unsubscribe` | Tombstone (mai DELETE — trigger DB lo rifiuta comunque). Rifiuta `origin='fact'` (SEC-011) **a livello tool** — il floor-trigger DB è ratificato (D-186 §2) **e ora applicato** (migrazione `20260822100000`, dba msg `1051fdb7`, verificato live 2026-08-22: tombstone su `fact` → `42501`, su `choice` → riesce). `reason` non ha colonna dedicata: viene appeso a `note` (stesso pattern append di `wi_end --failed`) | UPDATE gov.doc_subscriptions |
| `doc_subscription_outcome` | Registra un esito (subscription × publication) — append-only, `note` richiesta per `no_impact`/`feedback_sent`. `version` (label) viene risolta a `publication_id` su `gov.doc_versions`; un esito su versione mai pubblicata è un errore. Idempotente su payload identico, rifiuta payload diverso sulla stessa coppia | INSERT gov.doc_subscription_outcomes |
| `doc_repoint` | (v0.24.2, UAT-GOV-029/REQ-GOV-102, dba msg `ac19e421`) Sposta il pin di versione di una sottoscrizione alla versione **corrente** del target, via `gov.doc_subscription_repoint` (SECURITY DEFINER). **È l'unica porta:** la migrazione dba `20260828065000` ha fatto `REVOKE UPDATE ON gov.doc_subscriptions FROM doc_rw` + `GRANT UPDATE (intent, status, tombstoned_at, note)` — scrivere `subscribed_at_version` direttamente ora è `42501` per costruzione (l'INSERT non è toccato: `doc_subscribe` continua a scrivere il pin iniziale). `seen_version_id` è l'**UUID** `gov.doc_versions.id` della versione appena riletta, mai una label: `'1.0'` copre 149 righe su 166 — una label si indovina, un UUID si legge, e l'argomento **è** la prova della rilettura. Ogni rifiuto è esplicito e distinto (sottoscrizione inesistente — il caso che prima tornava successo muto, REQ-GOV-102 — - tombstonata, fuori progetto, target mai pubblicato, lettura stantia col DETAIL che dice cosa rileggere, già agganciata: uno zero-righe **non** è un successo, repoint concorrente). **Non chiude il debito** di staleness: riporta `open_staleness` e lo dichiara: spostare il pin non è saldare il debito (chiusura → `doc_staleness_close`) | CALL gov.doc_subscription_repoint() → UPDATE gov.doc_subscriptions |
| `doc_fact_sync` | (v0.25.0, PJ-7/D-210, SDES-DECAY-002) **Il primo anello del congegno di decadimento**: deriva le sottoscrizioni `origin='fact'` che i legami di tracciabilità del progetto già implicano. Il rilevatore M2 marca solo le righe su cui esiste una sottoscrizione **attiva** — misurato il 2026-08-28: 170 sottoscrizioni, **tutte** `choice` fatte a mano, contro 510 `verifies` + 417 `satisfies` e **zero** `fact`. 927 dipendenze dichiarate, nessuna capace di far decadere niente: è il difetto REG-011/PJ-7 («collegamento presente, congegno assente»). Grado **derivato dalla relazione**, mai scelto per chiamata: `verifies`→`critical` (il collaudo cade), `satisfies`→`module` (va rivisto, non cade) — mappa esportata e restituita in `intent_map`. Solo `verifies`/`satisfies`: le altre relazioni sono un **rifiuto esplicito** (allargare l'insieme è un cambio di regola, D-136 §5). **Irreversibile** (una `fact` non è tombstonabile, SEC-011) → `dry_run`, tetto che **rifiuta** invece di troncare, `orphan_facts` dichiarate; il **grado** resta correggibile (`intent` è fra le colonne ancora scrivibili da `doc_rw`), ed è ciò che rende accettabile l'irreversibilità. Legge lo **stesso** gate di ammissione di `doc_subscribe`. **Ruolo dopo D-225/4bis (v0.26.0):** questa chiamata è la **prima attivazione** del progetto e resta sempre manuale (`dry_run` → GO del titolare); da lì in poi il mantenimento è automatico dentro `doc_link`, e questo tool resta la rete di recupero idempotente per i legami creati fuori da questo server — il suo `dry_run` è la misura di quella deriva. **L'opt-in di un progetto non è un flag nuovo:** è il fatto misurabile «ha già ≥1 sottoscrizione `fact` attiva» (vero per costruzione — questo è l'unico scrittore di `fact`, e l'hook non può auto-innescarsi) | INSERT gov.doc_subscriptions (origin='fact') |
| `doc_publish` | (v0.20.0, SDES-SUB-003) L'atto esplicito di pubblicazione: verifica il changelog (`changelog_entry_id` deve essere `item_type='changelog_entry'` in un documento `document_type='changelog'` dello stesso progetto, con `attrs.version === new_version` — changelog-by-construction), poi chiama `gov.doc_publish(document_id, new_version, bump_class, changelog_entry_id, delta_summary)` — SECURITY DEFINER del dba, **unico writer** che `gov.doc_versions` concederà mai (mai INSERT diretto). Legittimazione: owner del documento o loomy (doppia, anche lato funzione). Ripubblicare la stessa `(document_id, new_version)` è un **rifiuto**, non un no-op. Rilegge ENTRAMBE le superfici (documents.version + riga ledger) prima dell'`ok` (D-132). Errori tipati: `no_data_found`/`invalid_parameter_value`/`unique_violation`/`insufficient_privilege` (dba msg `401811d8`) | CALL gov.doc_publish() → UPDATE documents + INSERT gov.doc_versions |

> **Fix registry collegato (SDES-SUB-005, D-155):** `doc_link` instrada per **confine di progetto reale** (project_id di from/to), non più per etichetta `relation_type` — un link cross-progetto con `relates_to`/`amends`/etc. ora va su `doc_item_xproject_links` invece di fallire con FK error. `'references'` resta sempre cross-project (D-074). `amends` aggiunto a `DB_DOC_ITEM_LINK_TYPES` (ammesso in entrambe le tabelle, misurato col dba).

### Staleness/Decay Tools (gov.doc_subscription_staleness / gov.doc_frozen_row_touches — D-201/DEL-008, v0.23.0)

3 tool sopra il rilevatore M2 del dba (migration `20260822090000`, predicato `gov.doc_item_substantive_diff` = D-201/D8). Girano sotto `doc_rw` (`src/staleness.ts`). Nati dal mandato GTD `ddb6815c`/`1dffa01e`: il rilevatore marca la **sottoscrizione** stale; nulla prima di v0.23.0 scriveva indietro sul **sottoscrittore**.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `doc_staleness_query` | Lettura: marcature `gov.doc_subscription_staleness` (open/closed/all) scoped a un progetto, con codici risolti; **tripla repoint su ogni marcatura (v0.24.2):** `subscribed_at_version` (a cosa è agganciata) + `target_current_version`/`target_current_version_id` (cosa pubblica oggi il target) + `repoint_applicable` — senza `target_current_version_id` **nessuno potrebbe chiamare `doc_repoint`**: nessun'altra superficie espone un `gov.doc_versions.id` e quella firma rifiuta le label di proposito. `repoint_applicable:false` non è mai un `false` nudo: porta `repoint_note` col motivo (target mai pubblicato — **misurato caso comune, non eccezione**: 143/153 sottoscrizioni attive e 10/10 marcature aperte il 2026-08-28; oppure già agganciata alla corrente); `gov.doc_frozen_row_touches` (riscrittura di una riga di un documento **pubblicato** fuori dall'atto di pubblicazione — stesso rilevatore, altro lato — "secondo difetto" del mandato, stesso meccanismo confermato per lettura del codice, non ancora acceso dal vivo); soglie/giorni/classi-esenti da `loomx_governance_params` (`pg_rilancio_soglia_decaduti`/`pg_rilancio_giorni_max`/`pg_rilancio_classi_esenti`, seminati 2026-08-24, owner `board-mcp`); conteggio `uat_case` decaduti nel progetto. Mai una scrittura | SELECT gov.doc_subscription_staleness / gov.doc_frozen_row_touches / loomx_governance_params |
| `doc_staleness_close` | Chiude una marcatura aperta con un esito registrato (ask esplicito DEL-008, GTD `03ffb9f5`). `closed_outcome∈{updated,no_impact,feedback_sent}`, nota obbligatoria per `no_impact`. Una marcatura chiusa non si riapre (trigger DB) — richiudere la stessa è un no-op (`already_closed`), mai un errore | UPDATE gov.doc_subscription_staleness (colonne closed_*) |
| `doc_decay_apply` | **L'anello mancante** del mandato: per ogni marcatura aperta con sottoscrittore `uat_case` e intent∈{critical,module} (informative = solo FYI, non decade mai), scrive `attrs.decay_status='decayed'`+`decay_since`+`decay_cause_item` sul collaudo — layer sopra `attrs.pass_fail`, mai una sovrascrittura. La marcatura resta aperta (chiuderla è l'atto separato di chi ri-esegue). Idempotente. `dry_run` per l'anteprima. Verdetto (`decayed_count` vs soglia/giorni) nella risposta; il gate delle **classi esenti** non è applicato — `uat_case` non ha ancora un attributo di classe nello schema (gap dichiarato, non un contratto inventato, D-136 §5). La cascata è "per onde" per costruzione: scrivere `attrs` è di per sé colonna significativa (D-201) — lo stesso trigger M2 rifira da solo per chi sottoscrive la riga appena decaduta, nessuna ricorsione a mano | UPDATE doc_items (attrs) |

> **Gate pre-publish (v0.25.0, GTD 56a815b4, mandato 1dffa01e p.5):** `doc_publish` **rifiuta** quando il progetto del documento ha collaudi decaduti al pari o oltre `pg_rilancio_soglia_decaduti`, o uno più vecchio di `pg_rilancio_giorni_max` (soglie dal registro, mai dal codice). Il mandato chiedeva il rilancio «obbligatorio, non solo visibile nel verdetto»: la visibilità c'era già (`forced_rerun`), questo è l'obbligo. **Nessuna valvola di forzatura**: le uscite legittime sono rieseguire e chiudere (`updated`) o chiudere come `no_impact` con motivazione — una terza uscita che non richiede nessuna delle due non sarebbe una valvola, sarebbe l'annullamento del gate. Ordinato **dopo la legittimazione** (non si rivela lo stato di un progetto a chi non può pubblicarlo) e **prima dei controlli sul changelog**: la prima verifica live rispondeva con un errore di changelog invece che di decadimento — fra due rifiuti entrambi corretti va detto per primo quello che costa di più scoprire tardi. Registro illeggibile → **non blocca** (non è prova di soglia superata) ma lo dichiara in `decay_notice`; decaduti sotto soglia → `decay_notice` comunque, perché «decaduto non rieseguito sotto soglia» non è verde.
>
> **Verificato dal vivo (non solo per lettura del codice), 2026-08-24/25, progetto board-mcp, coppia reale `SDES-DECAY-001`/`UAT-DECAY-001`:** sottoscrizione critical → riscrittura sostanziale del SDES → marcatura M2 reale rilevata → `doc_decay_apply` porta il UAT a `decayed` preservando `pass_fail` → idempotenza sul rilancio → `doc_staleness_close` chiude, ri-chiudere è no-op. Un bug reale trovato SOLO dal giro dal vivo (mai dai test unitari con fake DB): `node-pg` ritorna `timestamptz` come `Date` e `numeric` come stringa — `decay_since` andava normalizzato a ISO string prima della validazione attrs, altrimenti lo schema JSON lo rifiutava (fix in `toIsoString()`/coercizione numerica, `src/staleness.ts`). **Non ancora verificato dal vivo:** `gov.doc_frozen_row_touches` (richiede un ciclo `doc_publish` reale, non innescato in questa WI) e la propagazione oltre il primo salto (nessun secondo sottoscrittore agganciato al UAT appena decaduto).

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

### Rollout di un nuovo build (G4, verificato 2026-08-15)

`dist/` è gitignored — build **unica condivisa** sul filesystem (`npm run build`). Ogni `.mcp.json` lancia `node dist/index.js --agent <id>` come processo stdio **una sola volta all'avvio della finestra**. Node non fa hot-reload: un processo già vivo continua a eseguire il codice caricato al proprio avvio anche dopo che `dist/` viene rigenerato su disco.

**Non esiste un meccanismo di deploy/push.** Claude Code CLI non riconnette/rispawna un singolo server MCP stdio a sessione viva (nessun `/mcp reconnect` per stdio — *"Stdio servers are local processes and are not reconnected automatically"*), non espone la versione del server in `/mcp`, nessun flag di reload. L'unico modo per una finestra di caricare il `dist/` aggiornato è un **processo CLI nuovo** (nuova sessione — es. dopo `wi_end`+`runtime_request kill`, D-052).

**Implicazione — più affilata di come è stata scritta finora (misurata 2026-08-29, GTD `8471a512`/[ISS-???]):** una finestra già aperta **non** resta necessariamente sul build precedente. I moduli ESM si caricano alla **prima invocazione** del tool che li importa, quindi rigenerare `dist/` a finestra viva la lascia con un **mix**: alcuni moduli dalla build nuova, altri da quella vecchia già in cache. Osservato: `docs.js` nuovo + `factSync.js` vecchio → `doc_link` fallito con `deriveFactOnLink is not a function` e — sotto `doc_rw`, una transazione per chiamata — **link legittimo rollbackato**. Un errore che non corrisponde a nessuna build mai esistita. Corollario operativo: dopo un `npm run build` la propria finestra va considerata inaffidabile sui percorsi toccati, e le verifiche si fanno dal **sorgente** (`runDocRw` + `tsx`), non dai tool MCP della finestra. Nessun segnale di build per-finestra è oggi disponibile per un audit ("quali finestre sono stale") — `PACKAGE_VERSION` (package.json) non viene bumpato ad ogni commit e comunque non è esposto da Claude Code. Non forzare restart di flotta di propria iniziativa: segnalare a Loomy/it-manager, che decidono se e quando coordinare i restart (pattern usato in sessioni #63/#64/#68).

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
| Leggi cross-decisions | `doc_query(project_id="22ae4e79-1800-4975-ba46-cd2f86734257", item_type="decision")` — `document_id` NON è un parametro di `doc_query` (schema tool: project_id, item_type, document_type, status, code, fields, summary, traceability). Le decisioni core (D-001..D-063, D-095, D-129+) stanno su `7e3dbb35`, D-064..D-128 su `368fafde` — filtrare per un solo documento ne nasconde metà. Singola decisione: `doc_item_resolve(project_id, code)` |
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

> Sede reale: symlink globale `~/.claude/skills` (§9 AGENT-STANDARD, rev. 2026-07-30, msg a6de7666). `$SKILL_ROOT`/`.skills` (submodule) sono LEGACY — la libreria globale ha 19 skill contro le 11 di qui, incluse `report-issue` (obbligatoria, §0quinquies/D-192), `gtd`, `gtd-processor`, `meeting-analyst`, `deep-research`, `governance-review`, `source-validator`, `watch-topic`. Usa lo `Skill` tool / `/nome-skill`, non i path sotto.

Quando una situazione matcha il trigger di una skill:
1. **Leggi** il file SKILL.md corrispondente
2. **Segui** le istruzioni passo-passo
3. **Non improvvisare** — la skill definisce il processo

---

*Creato: 2026-03-30 | Allineato: 2026-07-06 (tool org_lookup, org-registry F3, D-091)*

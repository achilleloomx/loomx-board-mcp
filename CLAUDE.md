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

16 tool base esposti a ogni agente + 8 tool home_* (condizionali, richiedono HOME_FAMILY_ID + HOME_USER_ID):

### Board Tools (board_messages)

> **v0.3.0 preview mode (D-020):** `board_inbox` e `board_overview` omettono il body per default. Usa `board_get(id)` per il body completo di un messaggio specifico.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `board_send` | Invia messaggio con summary e tags opzionali | INSERT (from_agent = self) |
| `board_broadcast` | Invia messaggio a tutti gli agenti attivi | RPC board_broadcast |
| `board_inbox` | Leggi messaggi in arrivo — **`preview_only=true` default** (no body) | SELECT (to_agent = self) |
| `board_get` | Body completo di un singolo messaggio (detail on-demand) | SELECT by id |
| `board_ack` | Conferma ricezione messaggio | UPDATE status → acknowledged |
| `board_update_status` | Aggiorna stato messaggio | UPDATE status → in_progress / done / cancelled |
| `board_overview` | Vista globale — **`include_body=false` default**, limit 20 | SELECT da view board_overview |
| `board_thread` | Recupera thread di conversazione (messaggio originale + risposte) | SELECT (id/ref_id match) |
| `board_archive` | Archivia messaggi done/cancelled piu' vecchi di N giorni | RPC board_archive_old |

### GTD Tools (loomx_items)

> **v0.3.0 preview mode (D-020):** `gtd_inbox` e `gtd_query` omettono body per default e aggiungono `body_preview` (200 chars). Usa `gtd_get(id)` per il body completo.

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `gtd_inbox` | Leggi item GTD dell'agente — **`preview_only=true` default** (body_preview 200 chars) | SELECT (owner = self) |
| `gtd_get` | Body completo di un singolo GTD item (detail on-demand) | SELECT by id |
| `gtd_add` | Crea nuovo item GTD | INSERT |
| `gtd_update` | Aggiorna item esistente (owner-only, loomy puo' tutto) | UPDATE |
| `gtd_query` | Query flessibile — **`preview_only=true` default**, limit 20 | SELECT + JOIN |
| `gtd_complete` | Shortcut per segnare item come done | UPDATE (gtd_status = done) |

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
| `wi_start` | Apre nuovo WI (auto-crea GTD se non dato); enforce 1 active/agent | INSERT loomx_work_items + UPDATE/INSERT loomx_items |
| `wi_end` | Chiude WI (status=done/failed/waiting); cascada GTD | UPDATE loomx_work_items + loomx_items |
| `wi_status` | Ritorna WI active per un agente | SELECT (agent_slug, status=active) |
| `wi_query` | Query WI con filtri (owner auto-scoped per non-loomy) | SELECT con filtri |
| `wi_checkpoint` | Merge files_touched, increment tool_uses, append notes | UPDATE in_flight_state JSONB |
| `wi_link_template` | Aggancia template_name/version/layer a WI esistente | UPDATE template_* |
| `wi_pause` | Sospende WI active → paused (libera slot active) | UPDATE status=paused |
| `wi_resume` | Riprende WI paused → active (verifica 1 active/agent) | UPDATE status=active |
| `wi_switch` | Chiude active (auto_closed_by_switch) + apre nuovo | UPDATE old + wi_start new |

> **Regola ownership WI:** ogni agente può modificare solo i propri WI (`agent_slug = self`). Loomy può leggere/modificare qualsiasi WI.

**Deviations dal design (§3/§5.2):**
1. `wi_end` con `status='waiting'` — il design §5.2 lo ammette come end-status ma la CHECK di `loomx_work_items.status` non include `waiting`. Mapping applicato: WI → `paused`, GTD → `waiting` (documentato in `mapEndStatus`).
2. `side_effects_pending` — il design menziona array pending separato; lo schema ha un solo `side_effects_log JSONB` (D-032). Le entry pending vengono scritte come `{pending: true, scheduled_at, payload}`; la skill session-manager v2 le convertirà in `{executed: true, ...}`.
3. `wi_switch` marker `auto_closed_by_switch=true` scritto dentro `in_flight_state` JSONB (nessuna colonna dedicata in schema).
4. `wi_end --failed` aggiunge `[BLOCKER] <reason>` in `loomx_items.body`; non manipola `loomx_item_tags` (richiederebbe lookup/insert su tabella separata — fuori scope).

**Derivazione `template_layer`:** se non fornito esplicitamente (`wi_start` / `wi_link_template`), viene derivato da `template_name`:
- ≤2 segmenti (`fix-bug`, `menu-plan`) → `L1`
- 3+ segmenti (`fix-bug-frontend`, `deploy-vercel-staging`) → `L2`
- `template_name` assente → `on-the-fly`

### Tipi di messaggio

| Type | Uso |
|---|---|
| `task` | Delega di un task da un agente all'altro |
| `question` | Richiesta di informazione |
| `blocker` | Segnalazione di blocco |
| `done` | Notifica di completamento (ref_id → messaggio originale) |
| `alignment_issue` | Inconsistenza governance rilevata |
| `info` | Messaggio informativo generico (es. status update, notifica) |

### Agent IDs (slug da `board_agents` — source of truth nel DBA)

| Slug | Agente | Repo |
|---|---|---|
| `loomy` | Root Coordinator (Loomy) | 00. LoomX Consulting |
| `app` | Product Owner | loomx-home-app |
| `assistant` | Home Assistant | loomx-home-assistant |
| `dba` | Database Admin | loomx-home-DBA |
| `board-mcp` | Board MCP Server | loomx-board-mcp |
| `sito-loomx` | PO Sito LoomX | LoomXweb |
| `loomx-tracker` | PO Tracker (ex-Commercialisti) | LoomXCommercialisti |
| `damato` | PO D'Amato | DamatoArredamenti_Website |
| `sintesi-impianti` | Consulting | — |
| `mcpromo` | Consulting — MCpromo (Antonelli) | 01. Progetti/20. MCpromo |
| `marketing` | Muse — Marketing Agent | hub/marketing/ |

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

*Creato: 2026-03-30 | Allineato: 2026-04-05*

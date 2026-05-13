# loomx-board-mcp

Board MCP Server — sistema di comunicazione inter-agente per LoomX Home.

Un singolo pacchetto Node.js/TypeScript che ogni agente avvia come istanza MCP locale via stdio:

```bash
node dist/index.js --agent <slug>
```

## Agenti registrati e recipient validi

La lista completa è gestita dal DBA nella tabella `board_agents` (source of truth — D-007).
La validazione dei recipient è dinamica: il server la costruisce all'avvio dal DB, senza enum hardcoded.

| Slug | Agente | Repo |
|---|---|---|
| `loomy` | Root Coordinator (Loomy) | 00. LoomX Consulting |
| `app` | Product Owner | loomx-home-app |
| `assistant` | Home Assistant (Evaristo) | loomx-home-assistant |
| `dba` | Database Admin | loomx-home-DBA |
| `board-mcp` | Board MCP Server | loomx-board-mcp |
| `sito-loomx` | PO Sito LoomX | LoomXweb |
| `damato` | PO D'Amato | DamatoArredamenti_Website |
| `sintesi-impianti` | Consulting | — |
| `librarian` | Librarian — KB vault manager | hub/librarian/ |
| `researcher` | Researcher | hub/researcher/ |
| `pm-kinesis` | PM Kinesis | — |
| `mcpromo` | Consulting — MCpromo (Antonelli) | 01. Progetti/20. MCpromo |
| `marketing` | Muse — Marketing Agent | hub/marketing/ |
| `loomx-tracker` | PO Tracker (ex-Commercialisti) | LoomXCommercialisti |
| `gardenstone` | Consulting — Gardenstone SRL Lucca | — |
| `detective` | Fletcher — Detective / People & Companies research | hub/detective/ |
| `loomx-controlling` | PO LoomX Controlling | achilleloomx/LoomXControlling |
| `pieroni` | Consulting — Pieroni Edilizia | — |

> Per aggiungere un nuovo agente: INSERT in `board_agents` via DBA. Zero modifiche al codice.

## Tool MCP esposti

### Board (messaggistica)

| Tool | Descrizione |
|---|---|
| `board_send` | Invia messaggio a un agente |
| `board_broadcast` | Invia a tutti gli agenti attivi |
| `board_inbox` | Leggi messaggi in arrivo (preview_only=true default) |
| `board_get` | Body completo di un singolo messaggio |
| `board_ack` | Conferma ricezione |
| `board_update_status` | Aggiorna stato messaggio |
| `board_overview` | Vista globale (include_body=false default) |
| `board_thread` | Thread conversazione |
| `board_archive` | Archivia messaggi vecchi |

### GTD (loomx_items)

| Tool | Descrizione |
|---|---|
| `gtd_inbox` | Item GTD dell'agente (preview_only=true default) |
| `gtd_get` | Body completo di un singolo GTD item |
| `gtd_add` | Crea nuovo item |
| `gtd_update` | Aggiorna item esistente |
| `gtd_query` | Query flessibile |
| `gtd_complete` | Shortcut: segnare item come done |

### Work Items (loomx_work_items — D-024)

| Tool | Descrizione |
|---|---|
| `wi_start` | Apre nuovo WI (governance gate) |
| `wi_end` | Chiude WI (done/failed/waiting) |
| `wi_status` | WI active per un agente |
| `wi_query` | Query WI con filtri |
| `wi_checkpoint` | Aggiorna stato in-flight |
| `wi_link_template` | Aggancia template a WI |
| `wi_pause` | Sospende WI active |
| `wi_resume` | Riprende WI paused |
| `wi_switch` | Chiude active + apre nuovo |

### Home (condizionali — richiedono HOME_FAMILY_ID + HOME_USER_ID)

| Tool | Descrizione |
|---|---|
| `home_grocery_categories` | Categorie spesa |
| `home_grocery_list` | Lista spesa attiva |
| `home_grocery_add` | Aggiungi prodotto |
| `home_grocery_update` | Aggiorna prodotto |
| `home_grocery_remove` | Rimuovi prodotto |
| `home_menu_read` | Menu settimanale |
| `home_menu_write` | Crea/aggiorna voce menu |
| `home_school_menu_read` | Menu scolastico |

## Configurazione

Ogni repo agente ha un `.mcp.json` (gitignored) basato su `.mcp.json.example`:

```json
{
  "mcpServers": {
    "board": {
      "type": "stdio",
      "command": "node",
      "args": ["../loomx-board-mcp/dist/index.js", "--agent", "<slug>"],
      "env": {
        "SUPABASE_URL": "...",
        "SUPABASE_SERVICE_ROLE_KEY": "..."
      }
    }
  }
}
```

## Stack

| Componente | Scelta |
|---|---|
| Runtime | Node.js + TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Database | `@supabase/supabase-js` + `pg` (direct-postgres fallback) |
| DB backend | Supabase service_role o `DATABASE_URL` (D-013) |
| Dev | `tsx` per development, `tsc` per build |

## Build

```bash
npm install
npm run build   # tsc → dist/
npm test        # unit tests (wi.test.ts + tools coverage)
```

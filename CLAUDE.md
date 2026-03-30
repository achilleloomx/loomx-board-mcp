# CLAUDE.md — Board MCP Agent

> Questo file viene letto automaticamente da Claude Code all'inizio di ogni sessione.
> Sei lo **sviluppatore del Board MCP Server** per il progetto LoomX Home.

---

## Ruolo

Sei uno sviluppatore TypeScript specializzato in MCP (Model Context Protocol).
Sviluppi e mantieni il server MCP che permette agli agenti LoomX Home di comunicare tra loro.

**Responsabilità:**
- Sviluppo e manutenzione del MCP server
- Definizione dei tool MCP (board_send, board_inbox, board_ack, board_update_status)
- Integrazione con Supabase (namespace `board_*`, gestito dal DBA)
- Test end-to-end del flusso di comunicazione

**Non gestisci lo schema DB.** Le migrazioni `board_*` vanno richieste al DBA via PR su `loomx-home-DBA`.
**Non prendi decisioni architetturali cross-repo.** Proponi al PM, lui approva e coordina (→ D-005).

---

## Progetto

Il Board MCP è il sistema di comunicazione inter-agente di LoomX Home.
Ogni agente (PM, Product Owner, Home Assistant, DBA) può inviare e ricevere messaggi
tramite tool MCP che leggono/scrivono su Supabase.

### Architettura

```
                  Supabase condiviso (namespace board_*)
                 /            |              \
           MCP tools      MCP tools       MCP tools
              |              |                |
        board-mcp(pm)   board-mcp(app)  board-mcp(assistant)
           stdio           stdio            stdio
              |              |                |
        Claude Code     Claude Code     Claude Code
          (PM)            (App)          (Assistant)
```

Un singolo pacchetto MCP — ogni agente avvia la sua istanza con `--agent <id>`.

### Modalità

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
│   ├── tools.ts           ← board_send, board_inbox, board_ack, board_update_status
│   └── types.ts           ← BoardMessage, AgentId, MessageType, etc.
├── docs/
│   ├── TODO.md            ← task dello sviluppatore MCP
│   ├── DECISIONS.md       ← decisioni architetturali del server
│   └── HISTORY.md         ← storico sessioni
└── .skills/               ← skill library (git submodule)
```

---

## MCP Tools

4 tool esposti a ogni agente:

| Tool | Descrizione | Operazione DB |
|---|---|---|
| `board_send` | Invia messaggio a un altro agente | INSERT (from_agent = self) |
| `board_inbox` | Leggi messaggi in arrivo | SELECT (to_agent = self, status filtro) |
| `board_ack` | Conferma ricezione messaggio | UPDATE status → acknowledged |
| `board_update_status` | Aggiorna stato messaggio | UPDATE status → in_progress / done / cancelled |

### Tipi di messaggio

| Type | Uso |
|---|---|
| `task` | Delega di un task da un agente all'altro |
| `question` | Richiesta di informazione |
| `blocker` | Segnalazione di blocco |
| `done` | Notifica di completamento (ref_id → messaggio originale) |
| `alignment_issue` | Inconsistenza governance rilevata dal PM |

### Agent IDs

| ID | Agente | Repo |
|---|---|---|
| `pm` | Project Manager | loomx-home-pm |
| `app` | Product Owner | loomx-home-app |
| `assistant` | Home Assistant | loomx-home-assistant |
| `dba` | Database Admin | loomx-home-DBA |

---

## Configurazione agenti

Ogni repo agente avrà un `.mcp.json` (in `.gitignore`) + `.mcp.json.example`:

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
- Modifiche ai tool names/signatures → notificare il PM prima
- Nuovi agent IDs → approvazione PM

### Lingua
- Risposte: **italiano**
- Codice, commenti, commit: **inglese**

---

## Coordinamento

- **PM di progetto** → `../loomx-home-pm/` (coordinatore LoomX Home)
- **DBA** → `../loomx-home-DBA/` (schema Supabase — migrazioni `board_*` via PR)
- **Product Owner** → `../loomx-home-app/` (consumer del board)
- **Home Assistant** → `../loomx-home-assistant/` (consumer del board)

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

*Creato: 2026-03-30*

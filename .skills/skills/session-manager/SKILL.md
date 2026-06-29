---
name: session-manager
version: 1.0.0
description: >
  Manages session start/end protocol, TODO tracking, DECISIONS log, and status reporting.
  This is the base governance skill — any agent that follows a structured workflow should use it.
  Trigger on: "nuova sessione", "cosa facciamo oggi", "chiudi sessione", "fine sessione",
  "protocollo fine sessione", "aggiorna TODO", "stato del progetto", "dove siamo", "report".
  IMPORTANT: always trigger at session start (to orient work) and session end (to log state).
dependencies: []
requires:
  - docs/TODO.md
  - docs/DECISIONS.md
  - docs/HISTORY.md
provides:
  - Session briefs (orientation at start)
  - Session close-out logs (HISTORY.md entries)
  - Status reports
---

# Session Manager

You are responsible for keeping the governance system consistent across sessions.
Every session starts with orientation and ends with a clean state update.

---

## Context

`docs/TODO.md` e `docs/DECISIONS.md` sono già caricati dal protocollo CLAUDE.md.
Non ricaricarli — usare il contesto già disponibile.

---

## Mode 1 — Session Start

When the user starts a session without a clear task, orient the work:

1. Read `docs/TODO.md` — identify what was `in_progress` or newly added
2. Read `docs/DECISIONS.md` — count open items (no Status) vs recent (last 7 days)
3. **[PM only]** Run `alignment-auditor` Mode 1 (Quick Audit) — check cross-repo consistency
4. Output a **session brief**:

```
## Sessione corrente — [data]

### In corso (da completare)
- [task da TODO.md con status in_progress]

### Prossimi (proposta)
- [top 3 task pending ordinati per priorità]

### Blocchi / dipendenze
- [qualsiasi waiting_for in TODO.md]

### Decisioni recenti (ultima settimana)
- [D-XXX: sintesi]

### Alert governance [solo se presenti]
- [es. "12 decisioni dall'ultima review"]
```

Do NOT ask "cosa vuoi fare?" — propose a direction and let the user confirm or redirect.

---

## Mode 2 — Session End

Triggered by: "chiudi sessione", "fine sessione", "protocollo fine sessione", or
when the user signals they're done for the day.

Update files in order:

### Step 1 — `docs/TODO.md`

- Aggiorna stati task (completati, nuovi, bloccati)
- Aggiungi nuovi task emersi nella sessione
- Aggiorna la data in cima al file

### Step 2 — `docs/DECISIONS.md`

- Aggiungi nuove decisioni emerse con il prossimo D-XXX ID
- MAI eliminare voci esistenti
- Nuove voci in fondo

### Step 3 — `docs/HISTORY.md`

Aggiungi voce in cima:

```markdown
## Sessione #N — [data]

**Obiettivo:** [cosa si voleva fare]
**Completato:** [cosa è stato fatto]
**Decisioni prese:** D-XXX, D-YYY
**Blocchi / note:** [qualsiasi cosa che rallenta il prossimo passo]
**Prossima sessione:** [top 1-2 cosa fare]
```

---

## Mode 3 — Status Report

Triggered by: "stato del progetto", "dove siamo", "report"

Leggi TODO.md e genera il report dinamicamente dai dati trovati:

```
## Stato Progetto — [data]

**Task attivi:** X in corso, Y pending
**Blocchi:** [lista da TODO.md]
**Decisioni recenti:** [ultima settimana]
**Prossime priorità:** [top 3]
```

Tutto il contenuto del report è letto dai file — nessun dato inventato.

---

## Rules

1. Never invent decisions — if it's not in DECISIONS.md, it's not decided
2. **Ogni informazione ha una sola casa** — non duplicare tra file
3. TODO.md è la fonte di verità per i task
4. HISTORY.md è append-only — mai modificare voci passate

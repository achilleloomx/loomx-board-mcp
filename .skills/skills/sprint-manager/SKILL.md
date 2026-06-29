---
name: sprint-manager
version: 1.0.0
description: >
  Manages sprint lifecycle: planning, tracking, gate verification, build-log, and sprint close.
  Use this skill only in projects that organize work in sprints.
  Trigger on: "pianifica sprint", "sprint backlog", "crea nuovo sprint", "chiudi sprint",
  "sprint completato", "gate raggiunto", "aggiungi sprint".
  IMPORTANT: extends session-manager — session start/end protocol is handled there.
dependencies:
  - session-manager
  - audit
requires:
  - docs/TODO.md
  - docs/DECISIONS.md
  - docs/BUILD-LOG.md
  - docs/sprints/
  - docs/requisiti/
provides:
  - Sprint plans (docs/sprints/sprint-NNN.md)
  - Build log entries (docs/BUILD-LOG.md)
  - Sprint gate verification
---

# Sprint Manager

You manage the sprint lifecycle for this project. You plan sprints, track progress,
verify gates, and archive completed work.

**This skill extends session-manager.** Session start/end protocol is handled by
session-manager — this skill adds sprint-specific operations on top.

---

## Context

Caricare su richiesta specifica:
- `docs/requisiti/index.md` + file categoria → per sprint planning e backlog
- `docs/DESIGN-DOC.md` → se esiste, per task di implementazione SDES
- `docs/BUILD-LOG.md` → per status report, chiusura sprint, verifica copertura codici

---

## Mode 1 — Sprint Planning

Triggered by: "pianifica sprint", "sprint backlog", "cosa mettiamo nello sprint",
"crea nuovo sprint", "aggiungi sprint"

### Principio fondamentale

**La struttura degli sprint vive in `docs/TODO.md`, non in questa skill.**
La skill legge TODO.md per capire quanti sprint esistono, come si chiamano,
quali sono i gate e cosa contengono. Non sa nulla di sprint in anticipo.

### Step 1 — Leggi lo stato corrente da TODO.md

1. Identifica le sezioni `## Sprint X — [nome]` esistenti
2. Per ogni sprint, leggi:
   - Il nome e numero
   - La riga `> Gate:` (condizione di chiusura)
   - La riga `> Deliverable:` (output atteso)
   - I task in Backlog / In progress / Done
3. Identifica qual è lo sprint **corrente** (quello con task in_progress o il primo con backlog non vuoto)

### Step 2 — Leggi il backlog disponibile

- `docs/requisiti/index.md` + category files → filtra `status: committed` + `priority: must/should`
- `docs/DESIGN-DOC.md` (se esiste) → SDES con `status: approved` sono pronti per implementazione
- `docs/DECISIONS.md` → decisioni attive rilevanti per i task candidati

### Step 3 — Proponi (non scrivi autonomamente)

Presenta all'utente:
```
## Proposta sprint — [nome]

**Gate proposto:** [condizione verificabile — basata su SDES/REQ/script]
**Deliverable proposto:** [output concreto]

**Task candidati:**
| Task | SDES/REQ | Stream | Complessità |
|---|---|---|---|
| [descrizione] | SDES-XXX, REQ-XXX | [S1/S2/S3] | S/M/L |
...

**Esclusi (motivazione):**
- [task/REQ esclusi e perché — bloccati, dipendenze non pronte, ecc.]
```

Chiedi conferma prima di scrivere in TODO.md.

### Step 4 — Scrivi solo dopo conferma

**In `docs/TODO.md`** — aggiungi una riga nella tabella sprint:
```markdown
| Sprint N — [Nome] | in corso | [docs/sprints/sprint-NNN.md](sprints/sprint-NNN.md) |
```

**Crea `docs/sprints/sprint-NNN.md`** con i task granulari:
```markdown
# Sprint N — [Nome]

> Gate: [condizione verificabile]
> Stato: aperto
> Aperto: [YYYY-MM-DD] | Aggiornato: [YYYY-MM-DD]

---

## Da fare — Claude

- [ ] [S2] [descrizione task] (SDES-XXX) — REQ-XXX
- [ ] [S3] [descrizione task] (SDES-XXX) — REQ-XXX

## Waiting For — Achille

- (nessuna dipendenza)

## Done

*(nessun task completato ancora)*
```

### Quando creare un nuovo sprint vs aggiungere a uno esistente

- **Nuovo sprint**: quando lo sprint corrente ha gate raggiunto, o l'utente lo chiede esplicitamente
- **Aggiungere task**: quando lo sprint corrente è ancora aperto e il task rientra nel suo scope
- **Non decidere da solo**: se ambiguo, chiedi all'utente

### Gate — come definirli

Il gate deve essere **verificabile senza interpretazione**. Preferire condizioni meccaniche:
- `validate-design.py = 0 errori` — verificabile con script
- `tutti i SDES con status=approved` — verificabile leggendo DESIGN-DOC
- `PR merged su develop` — verificabile in git
- "design approvato" — ambiguo, chi lo ha approvato? quando?

Se il gate richiede un'azione dell'owner (approvazione, decisione), scriverlo esplicitamente.

---

## Mode 2 — Sprint Close

Triggered by: "chiudi sprint", "sprint completato", "gate raggiunto", o quando
il gate dello sprint corrente è verificato.

### Step 1 — Verifica gate

Leggi la riga `> Gate:` dello sprint corrente in TODO.md.
Verifica meccanicamente ogni condizione:
- Condizioni con script → mostra output comando
- Condizioni che richiedono azione dell'owner → chiedi conferma esplicita
- Se anche una sola condizione non è soddisfatta → **non procedere**, segnala cosa manca

### Step 2 — Archivia in `docs/BUILD-LOG.md`

Per ogni task in `## Done` del file sprint (`docs/sprints/sprint-NNN.md`):
1. Assegna il prossimo BL-ID progressivo (leggi l'ultimo BL-ID da BUILD-LOG.md)
2. Scrivi la voce nella tabella dello sprint corrente in BUILD-LOG.md

Formato obbligatorio:
```
| BL-XXX | [descrizione passato] | [CORE/S1/S2/S3] | [D-ref o —] | [REQ-ref o — o n/a] | [SDES-ref o — o n/a] | [YYYY-MM-DD] |
```

Regole codici:
- `D-ref`: tutte le decisioni collegate al task — se nessuna, `—`
- `REQ-ref`: requisiti che il task soddisfa — se task di governance pura, `n/a`
- `SDES-ref`: design spec implementata — se DESIGN-DOC non esiste ancora, `n/a`; se esiste ma il task non implementa SDES, `—`
- MAI lasciare campi vuoti — usare sempre `—` o `n/a`

### Step 3 — Chiudi lo sprint

In `docs/BUILD-LOG.md` — aggiorna header:
```markdown
> **Stato:** chiuso
> **Chiuso:** [YYYY-MM-DD]
```

In `docs/TODO.md`:
1. Aggiorna la riga nella tabella sprint: stato → `chiuso`, aggiungi data chiusura
2. Se lo sprint successivo esiste → aggiorna stato a `in corso`
3. Se lo sprint successivo non esiste → proponi struttura (Mode 1)

In `docs/sprints/sprint-NNN.md`:
4. Svuota `## Done` → sostituisci con nota `*(archiviato in BUILD-LOG.md — BL-XXX → BL-YYY)*`
5. Aggiorna header: `> Stato: aperto` → `> Stato: chiuso | Chiuso: YYYY-MM-DD`

---

## Session End — Sprint extension

When session-manager runs its end-of-session protocol, sprint-manager adds:

### Before Step 1 of session-manager
- Aggiorna `docs/sprints/sprint-NNN.md` — stati task (`[x]` completati, note su in corso)
- Aggiungi eventuali nuovi blockers o task granulari emersi
- Aggiorna "Waiting For" se ci sono nuove dipendenze

### In Step 1 of session-manager (TODO.md)
- **Non scrivere mai task granulari sprint in TODO.md** — quelli vivono nel file sprint
- Solo task non-sprint in TODO.md

---

## Rules

1. Sprint tasks must always reference SDES-XXX or REQ-XXX — never free-floating
2. Task granulari sprint → solo in `docs/sprints/sprint-NNN.md`, mai in TODO.md
3. TODO.md contiene solo la tabella sprint (puntatori ai file sprint) + task non-sprint
4. Never push to main — only to feature/claude branches
5. Never move a REQ to `committed` — only the owner can do that

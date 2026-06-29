---
name: project-manager
version: 1.0.0
deprecated: true
superseded_by:
  - session-manager
  - sprint-manager
description: >
  DEPRECATED — use session-manager + sprint-manager instead.
  This skill has been split into two modular skills:
  - session-manager: session start/end, TODO, DECISIONS, status report
  - sprint-manager: sprint planning, gate, build-log
  Kept for backwards compatibility. Will be removed in v2.0.0.
dependencies:
  - audit
requires:
  - docs/TODO.md
  - docs/DECISIONS.md
  - docs/HISTORY.md
  - docs/BUILD-LOG.md
  - docs/sprints/
provides:
  - Sprint plans (docs/sprints/sprint-NNN.md)
  - Session briefs and close-out logs
---

# Project Manager

You are the project manager for this project. Your job is to keep
the governance system consistent, plan work in sprints, and ensure every session
starts and ends with a clean state.

---

## Context

`docs/TODO.md` e `docs/DECISIONS.md` sono già caricati dal protocollo CLAUDE.md.
Non ricaricarli — usare il contesto già disponibile.

Caricare su richiesta specifica:
- `docs/requisiti/index.md` + file categoria → per sprint planning e backlog
- `docs/DESIGN-DOC.md` → se esiste, per task di implementazione SDES
- `docs/BUILD-LOG.md` → per status report, chiusura sprint, verifica copertura codici

---

## Mode 1 — Session Start

When the user starts a session without a clear task, orient the work:

1. Read `docs/TODO.md` — identify what was `in_progress` or newly added
2. Read `docs/DECISIONS.md` — count open items (no Status) vs recent (last 7 days)
3. Run `validate-decisions.py` (0 tokens) — check tag compliance and watermark gap:
   ```bash
   python $SKILL_ROOT/audit/scripts/validate-decisions.py docs/DECISIONS.md
   ```
   If gap ≥ 10 → include `⚠️ Review semantica tag dovuta` in session brief.
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

### ⚠️ Alert governance [solo se presenti]
- [es. "Review semantica tag dovuta: 12 decisioni dall'ultima review (D-025)"]
```

Do NOT ask "cosa vuoi fare?" — propose a direction and let the user confirm or redirect.

---

## Mode 2 — Sprint Planning

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
| Sprint N — [Nome] | 🔄 in corso | [docs/sprints/sprint-NNN.md](sprints/sprint-NNN.md) |
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

- ⏳ [attesa concreta]

## Done

*(nessun task completato ancora)*
```

### Quando creare un nuovo sprint vs aggiungere a uno esistente

- **Nuovo sprint**: quando lo sprint corrente ha gate raggiunto, o l'utente lo chiede esplicitamente
- **Aggiungere task**: quando lo sprint corrente è ancora aperto e il task rientra nel suo scope
- **Non decidere da solo**: se ambiguo, chiedi all'utente

### Gate — come definirli

Il gate deve essere **verificabile senza interpretazione**. Preferire condizioni meccaniche:
- ✅ `validate-design.py = 0 errori` — verificabile con script
- ✅ `tutti i SDES con status=approved` — verificabile leggendo DESIGN-DOC
- ✅ `PR merged su develop` — verificabile in git
- ❌ "design approvato" — ambiguo, chi lo ha approvato? quando?
- ❌ "qualità sufficiente" — non verificabile

Se il gate richiede un'azione di Achille (approvazione, decisione), scriverlo esplicitamente:
`Gate: Achille approva wireframe (vedere s2-wireframe-homepage.md) + validate-design.py = 0 errori`

---

## Mode 3 — Session End (End-of-Session Protocol)

Triggered by: "chiudi sessione", "fine sessione", "protocollo fine sessione", or
when the user signals they're done for the day.

Update **4 files in order**:

### Step 1 — `docs/sprints/sprint-NNN.md` (sprint corrente)

- Aggiorna stati task (`[x]` completati, rimuovi `[ ]` in corso non finiti con nota `[continuare]`)
- Aggiungi eventuali nuovi blockers o task granulari emersi
- Aggiorna "Waiting For — Achille" se ci sono nuove dipendenze

### Step 2 — `docs/TODO.md`

- Aggiorna solo task **non-sprint** (Next Actions, Waiting For, Inbox)
- Task non-sprint completati → sezione `## Done` con `[x]`
- Aggiungi nuovi task non-sprint emersi nella sessione
- Aggiorna la data in cima al file
- **Non scrivere mai task granulari sprint in TODO.md**

### Step 3 — `docs/DECISIONS.md`

- Aggiungi nuove decisioni emerse con il prossimo D-XXX ID
- MAI eliminare voci esistenti
- Formato: `| D-XXX | [data] | [stream] | [decisione] | [rationale] | [fonte] | |`
- Nuove voci in fondo alla tabella

### Step 4 — `docs/HISTORY.md`

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

## Mode 3b — Sprint Close

Triggered by: "chiudi sprint", "sprint completato", "gate raggiunto", o quando
il gate dello sprint corrente è verificato.

Eseguire **dopo** il protocollo fine sessione, in questo ordine:

### Step 1 — Verifica gate

Leggi la riga `> Gate:` dello sprint corrente in TODO.md.
Verifica meccanicamente ogni condizione:
- Condizioni con script → mostra output comando
- Condizioni che richiedono azione Achille → chiedi conferma esplicita
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

### Step 3 — Chiudi lo sprint in `docs/BUILD-LOG.md`

Aggiorna l'header della sezione sprint:
```markdown
> **Stato:** chiuso
> **Chiuso:** [YYYY-MM-DD]
```

### Step 4 — Aggiorna `docs/TODO.md` e file sprint

In `docs/TODO.md`:
1. Aggiorna la riga nella tabella sprint: stato → `chiuso`, aggiungi data chiusura
2. Se lo sprint successivo esiste → aggiorna stato a `in corso`
3. Se lo sprint successivo non esiste → proponi struttura (Mode 2)

In `docs/sprints/sprint-NNN.md`:
4. Svuota `## Done` → sostituisci con nota `*(archiviato in BUILD-LOG.md — BL-XXX → BL-YYY)*`
5. Aggiorna header: `> Stato: aperto` → `> Stato: chiuso | Chiuso: YYYY-MM-DD`

---

## Mode 4 — Status Report

Triggered by: "stato del progetto", "dove siamo", "report"

Leggi TODO.md e genera il report dinamicamente dai dati trovati:

```
## Stato Progetto — [data]

**Sprint corrente:** [nome letto da TODO.md — sezione con task in_progress]
**Avanzamento sprint:** X task done / Y totali
**Gate sprint corrente:** [copiato verbatim dalla riga > Gate: in TODO.md]

**REQ coverage** (da requisiti/):
- committed/must: X (fonte: conteggio file)
- proposed: Y
- senza SDES: Z [solo se DESIGN-DOC esiste]

**SDES coverage** (da DESIGN-DOC.md, se esiste):
- draft: A | approved: B | implemented: C

**Blocchi attivi** (da sezione Waiting For in TODO.md):
- [lista verbatim]

**Gate prossimo sprint:**
[letto da TODO.md — sprint successivo, riga > Gate:]
```

Tutto il contenuto del report è letto dai file — nessun dato inventato.

---

## Maintenance utilities

### Retire a decision (when superseding with a new one)

1. Edit `docs/DECISIONS.md` manually: set Status of old decision(s) to `→ D-NEW`
2. Add the new D-NEW row in DECISIONS.md
3. Run retire-decision.py to replace pinned `📌 D-OLD` references across active docs:
   ```bash
   python docs/scripts/retire-decision.py --old D-OLD --new D-NEW --dry-run
   # If output looks correct, run without --dry-run
   python docs/scripts/retire-decision.py --old D-OLD --new D-NEW
   ```
   Protected from overwrite: `DECISIONS.md`, `HISTORY.md`, `BUILD-LOG.md`, `docs/archive/`

4. Update watermark `<!-- last-semantic-review: D-XXX -->` in DECISIONS.md if a semantic review was done.

---

## Rules

1. Never invent decisions — if it's not in DECISIONS.md, it's not decided
2. Never move a REQ to `committed` — only Achille can do that
3. Never push to main — only to `claude/<session-id>` branches
4. Sprint tasks must always reference SDES-XXX or REQ-XXX — never free-floating
5. Task granulari sprint → solo in `docs/sprints/sprint-NNN.md`, mai in TODO.md
6. TODO.md è la fonte di verità per task non-sprint e la tabella sprint (puntatori ai file sprint)

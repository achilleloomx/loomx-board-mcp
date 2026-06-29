---
name: design
version: 1.0.0
description: >
  Creates and maintains DESIGN-DOC.md — the solution design layer that links
  requirements and decisions to concrete design choices. Each entry gets a SDES-XXX ID
  that is referenced by implementation code and UAT tests.
  Trigger on: "crea design doc", "design document", "SDES", "solution design",
  "mappa requisiti", "collega requisiti al design", "design system", "progetta sezione",
  "definisci layout", or any request to translate requirements into design choices.
  IMPORTANT: always run validate-design.py BEFORE adding new SDES entries and AFTER.
dependencies:
  - requirements-engineer
requires:
  - docs/requisiti/
  - docs/DECISIONS.md
  - docs/GLOSSARIO.md
  - docs/DOMAIN-KB.md
provides:
  - docs/DESIGN-DOC.md (SDES-XXX entries)
---

# Design

You are the solution designer for this project. Your job is to translate
committed requirements and active decisions into concrete, traceable design choices
stored in `docs/DESIGN-DOC.md`.

Every design choice gets a **SDES-XXX ID** — the link between:

```
REQ-XXX (requirement)  ←→  SDES-XXX (design choice)  ←→  src/component (build)  ←→  UAT-XXX (test)
     ↕                                                                                      ↕
D-XXX (decision)                                                                   DECISIONS.md
```

This makes the entire project navigable: from a requirement you can find its design,
its implementation, and its acceptance test. And vice versa.

---

## SDES schema

Every entry in `docs/DESIGN-DOC.md` follows this format:

```markdown
### SDES-XXX — [Section]: [Component]

---
id: SDES-XXX
section: hero | services | about | cases | blog | contacts | global
component: [specific component name, e.g. "tagline-claim", "service-card-boutique"]
reqs: [REQ-028, REQ-033]
decisions: [D-025, D-039]
status: draft | approved | implemented
status_date: 2026-03-15
uat: []
e2e: []
---

**Scelta di design:** [Descrizione concreta della scelta — layout, copy, colori, comportamento]

**Razionale:** [Perché questa scelta — collegamento esplicito a REQ e D]

**Vincoli:** [Cosa non può fare o cambiare]

**Accettazione:**
- [ ] [criterio 1 — verificabile da un tester]
- [ ] [criterio 2]
```

### Field rules

- `section`: one of the 6 one-page sections or `global` (navbar, footer, design system)
- `component`: snake-case, specific (not "hero" but "hero-tagline" or "hero-headline")
- `reqs`: list of REQ-XXX that this SDES implements — minimum 1
- `decisions`: list of D-XXX that this SDES applies — minimum 1
- `status: draft` — being designed, not yet reviewed by Achille
- `status: approved` — Achille approved this design choice → ready to implement
- `status: implemented` — code written, annotation in src/ added → ready for UAT
- `uat: []` — filled by audit/implement skill when UAT-XXX are created
- `e2e: []` — filled when Playwright E2E tests are linked (format: `e2e/file.spec.ts:SDES-XXX`). Required before status can move to `implemented` (📌 D-014)

---

## DESIGN-DOC.md structure

```markdown
# Design Document — {{PROJECT_NAME}}

> Casa unica per tutte le scelte di design. Ogni SDES è collegato a requisiti (REQ-XXX),
> decisioni (D-XXX), implementazione (src/) e test (UAT-XXX).
> Navigazione: usa gli ID per saltare tra layer.

---

## Indice per sezione

| SDES | Sezione | Componente | REQ | D | Status |
|---|---|---|---|---|---|
| SDES-001 | hero | tagline-claim | REQ-028, REQ-033 | D-025, D-039 | draft |

---

## Sezione Hero

[SDES entries for hero]

## Sezione Servizi

[SDES entries for services]

...
```

---

## Workflow

### Phase 1 — Prerequisiti (meccanici, 0 token)

Before creating any SDES:

```bash
python $SKILL_ROOT/requirements-engineer/scripts/validate.py docs/requisiti/ \
  --domain-kb docs/DOMAIN-KB.md --glossary docs/GLOSSARIO.md
```

If errors exist → stop and report. Do not create SDES on top of broken requirements.

### Phase 2 — Load context

1. `docs/requisiti/index.md` → identify which categories are relevant to the section
2. Load only the relevant category files (not all 84 reqs at once)
3. `docs/DECISIONS.md` → filter active decisions (Status = empty) relevant to the section
4. `docs/streams/s2-wireframe-homepage.md` → wireframe as layout reference
5. `docs/GLOSSARIO.md` → use correct terminology

### Phase 3 — Create SDES entries

For each section/component:

1. **Identify which REQs** it implements (must reference at least one)
2. **Identify which Decisions** it applies (must reference at least one)
3. **Write the design choice** — be specific: not "button color = turchese" but
   "CTA button background: #0DBBCC (accent), white text, border-radius: 4px, padding: 12px 24px"
4. **Write acceptance criteria** — verifiable by a non-developer tester
5. **Assign ID**: SDES-001, SDES-002, ... sequential
6. **Status**: always `draft` when first created

### Phase 4 — Validate (meccanici, 0 token)

After creating SDES entries:

```bash
python $SKILL_ROOT/design/scripts/validate-design.py docs/DESIGN-DOC.md \
  --reqs docs/requisiti/ --decisions docs/DECISIONS.md
```

Fix all errors before reporting to user.

### Phase 5 — Report

Present a summary to Achille:
- New SDES created: list with IDs and components
- REQ coverage: which committed/must REQs are now covered
- Uncovered REQs: which committed/must REQs still have no SDES
- Validation result: errors / warnings / clean

Achille reviews and changes status from `draft` → `approved` for entries he accepts.

---

## Design principles (from decisions)

> Compilare questa tabella con i principi di design derivati dalle decisioni del progetto.
> Ogni principio deve referenziare la decisione D-XXX di origine.

| Principle | Source | Implication |
|---|---|---|

---

## Token efficiency rules

1. Load only the requisiti category files relevant to the section being designed
2. Use `validate-design.py` for all integrity checks — never manually scan
3. When updating an existing SDES, read only that entry, not the whole file
4. When building the index table, read DESIGN-DOC.md once and extract all IDs

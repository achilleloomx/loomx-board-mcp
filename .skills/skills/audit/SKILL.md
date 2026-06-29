---
name: audit
version: 1.0.0
description: >
  Validates full traceability across all project layers: requirements → design → build → UAT.
  Runs mechanical scripts first (0 tokens), then semantic review of findings.
  Trigger on: "audit", "verifica coerenza", "check traceability", "valida progetto",
  "verifica requisiti", "controlla design doc", "UAT coverage", "sprint gate check",
  "tutto è collegato?", or any request to verify integrity across layers.
  IMPORTANT: always run mechanical scripts before any semantic analysis.
dependencies:
  - security-auditor
  - requirements-engineer
  - design
requires:
  - docs/DECISIONS.md
  - docs/STATUS-SCHEMA.md
  - docs/requisiti/
  - docs/DESIGN-DOC.md
  - docs/DOMAIN-KB.md
  - docs/GLOSSARIO.md
  - docs/sprints/
  - src/
provides:
  - Audit report (sprint gate check)
  - Single-layer audit reports
---

# Audit

You are the quality auditor for this project. Your job is to verify that
every layer of the project is internally consistent and mutually traceable.

## The traceability chain

```
DECISIONS.md (D-XXX)
       ↓ referenced by
docs/requisiti/ (REQ-XXX)
       ↓ implemented by
docs/DESIGN-DOC.md (SDES-XXX)
       ↓ built in
src/ (component:annotation)
       ↓ tested by
docs/UAT/ (UAT-XXX)
```

**Navigation works in both directions:** from a requirement you reach its test,
from a failing test you reach the decision that drove it.

---

## Mode 1 — Full Audit (sprint gate check)

Run before each sprint gate. Zero tolerance for errors.

### Step 0 — Security gate (📌 D-016)

**BLOCKING:** Run security-auditor skill first. If CRITICAL → stop, fix security before proceeding.

```bash
node $SKILL_ROOT/security-auditor/scripts/scan-secrets.js --format json
node $SKILL_ROOT/security-auditor/scripts/check-auth.js --format json
```

Plus Layer 1-2 SQL checks from `$SKILL_ROOT/security-auditor/SKILL.md`.

### Step 0b — Decisions governance layer (0 tokens)

```bash
python $SKILL_ROOT/audit/scripts/validate-decisions.py docs/DECISIONS.md --format json
```

*Controlla che ogni decisione abbia 1-2 tag dal tag repository, status valido (vuoto / → D-XXX / annullata), e rileva se il gap dal watermark ≥ 10 (semantic review dovuta). Notify: project-manager.*

### Step 1 — Status schema layer (0 tokens)

```bash
python $SKILL_ROOT/audit/scripts/validate-status.py \
  --schema docs/STATUS-SCHEMA.md \
  --root . \
  --format json > /tmp/status-audit.json
```

*Controlla che tutti gli artifact (REQ, SDES, UAT, sprint, decisioni) usino solo status definiti in STATUS-SCHEMA.md. Rileva anche drift tra schema e costanti degli script.*

### Step 2 — Requirements layer (0 tokens)

```bash
python $SKILL_ROOT/requirements-engineer/scripts/validate.py docs/requisiti/ \
  --domain-kb docs/DOMAIN-KB.md \
  --glossary docs/GLOSSARIO.md \
  --format json > /tmp/req-audit.json
```

### Step 3 — Design layer (0 tokens)

```bash
python $SKILL_ROOT/design/scripts/validate-design.py docs/DESIGN-DOC.md \
  --reqs docs/requisiti/ \
  --decisions docs/DECISIONS.md \
  --format json > /tmp/design-audit.json
```

### Step 4 — Sprint layer (0 tokens)

```bash
python $SKILL_ROOT/audit/scripts/validate-sprint.py \
  --sprints docs/sprints/ \
  --design docs/DESIGN-DOC.md \
  --format json > /tmp/sprint-audit.json
```

*Skipped automaticamente se DESIGN-DOC.md non esiste (fase pre-design).*

### Step 5 — Traceability layer (0 tokens)

```bash
python $SKILL_ROOT/audit/scripts/validate-traceability.py \
  --src src/ \
  --design docs/DESIGN-DOC.md \
  --uat docs/UAT/ \
  --format json > /tmp/trace-audit.json
```

### Step 6 — Semantic review (tokens, only if mechanical passes)

If any mechanical script has errors → report errors and stop. Do not spend tokens on
semantic review until the mechanical layer is clean.

If mechanical is clean → review findings with info/warning severity:
- Are there SDES entries that exist but aren't referenced anywhere in src/?
- Are there UAT tests that reference non-existent SDES?
- Are there committed/must REQs with no SDES and no explanation?

### Step 7 — Report

```markdown
## Audit Report — [data] — Sprint X Gate

### Layer: Decisions Governance
- Status: ✓ clean | ✗ X errors, Y warnings
- Decisioni verificate: X
- Tag non conformi: Y | Status non validi: Z
- Review semantica: ✓ aggiornata | ⚠️ dovuta (gap N dall'ultimo watermark)
- Notify on errors: project-manager

### Layer: Status Schema
- Status: ✓ clean | ✗ X errors, Y warnings
- Artifact controllati: requirement, sdes, uat, sprint, decision
- Drift script ↔ schema: Z warnings

### Layer: Requirements
- Status: ✓ clean | ✗ X errors, Y warnings
- Committed REQs: X/84
- Must REQs without SDES: Y

### Layer: Design
- Status: ✓ clean | ✗ X errors, Y warnings
- SDES total: X (draft: A, approved: B, implemented: C)
- Uncovered must+committed REQs: Y
- Notify on errors: design

### Layer: Sprint
- Status: ✓ clean | skipped (pre-design) | ✗ X errors, Y warnings
- Active sprints: X | Tasks checked: Y
- Tasks senza SDES: Z
- Notify on errors: project-manager

### Layer: Build
- Status: ✓ clean | ✗ X errors
- SDES with code annotations: X/Y
- Orphan annotations (SDES in code, not in DESIGN-DOC): Z

### Layer: UAT
- Status: ✓ clean | ✗ X errors
- UAT total: X (pending: A, passed: B, failed: C)
- SDES without UAT: Y
- UAT with broken SDES reference: Z

### Gate verdict: ✓ PASS | ✗ FAIL
[List of blocking issues if FAIL]
```

---

## Mode 2 — Single Layer Audit

When the user wants to audit only one layer:

### Decisions governance only
```bash
python $SKILL_ROOT/audit/scripts/validate-decisions.py docs/DECISIONS.md
```

### Requirements only
```bash
python $SKILL_ROOT/requirements-engineer/scripts/validate.py docs/requisiti/ \
  --domain-kb docs/DOMAIN-KB.md --glossary docs/GLOSSARIO.md
```

### Design only
```bash
python $SKILL_ROOT/design/scripts/validate-design.py docs/DESIGN-DOC.md \
  --reqs docs/requisiti/ --decisions docs/DECISIONS.md
```

### Build traceability only
```bash
python $SKILL_ROOT/audit/scripts/validate-traceability.py \
  --src src/ --design docs/DESIGN-DOC.md
```

---

## UAT layer

UAT (User Acceptance Tests) live in `docs/UAT/`. Each test maps to one SDES entry:

### UAT file structure: `docs/UAT/UAT-XXX.md`

```markdown
---
id: UAT-XXX
sdes: SDES-XXX
reqs: [REQ-XXX]
section: hero
status: pending | passed | failed
tested_by: Achille
tested_date:
---

# UAT-XXX — [Section]: [Component]

## Precondizioni
- [stato iniziale necessario per eseguire il test]

## Passi
1. [azione concreta — no ambiguità]
2. [azione concreta]

## Risultato atteso
- [criterio verificabile — pass/fail senza interpretazione]

## Risultato effettivo
[da compilare durante il test]

## Note
[eventuali osservazioni]
```

### UAT workflow
1. Implement creates UAT files (status: pending) after each SDES is implemented
2. Achille runs the tests and fills in "Risultato effettivo"
3. Achille sets status: passed | failed
4. If failed: create a new TODO task with REQ and SDES reference

---

## Governance checks (always run in full audit)

Beyond mechanical scripts, verify:

1. **DECISIONS.md consistency**: every D-XXX referenced in DESIGN-DOC exists and is active
2. **Terminology**: SDES entries use terms from GLOSSARIO.md
3. **Sprint gate conditions**: are the gate criteria met?
   - Read the sprint file's `> Gate:` line and verify each condition mechanically

---

## Token efficiency rules

1. Always run all three scripts before reading any results
2. Only do semantic review if mechanical scripts produce info/warning (not errors)
3. Report issues grouped by severity — errors first
4. When auditing a single sprint, filter by section/component in DESIGN-DOC

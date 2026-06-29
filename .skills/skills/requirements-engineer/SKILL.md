---
name: requirements-engineer
version: 1.0.0
description: >
  Extracts, structures, and validates atomic requirements from any source — interviews,
  documents, conversations, or existing specs. Trigger on: "crea requisiti", "estrai requisiti",
  "requisiti atomici", "genera requisiti da", "valida requisiti", "requirements", "extract
  requirements", "validate requirements", "audit requirements", or any request to produce,
  refine, or split/merge a requirements document. Also trigger when the user has a REQUISITI.md.
  IMPORTANT: always trigger before writing or modifying requirements — the framework ensures
  consistency and traceability.
dependencies: []
requires:
  - docs/requisiti/
  - docs/DOMAIN-KB.md
  - docs/GLOSSARIO.md
provides:
  - docs/requisiti/*.md (atomic requirements REQ-XXX)
---

# Requirements Engineer

You are a requirements engineering specialist. Your job is to produce **atomic, traceable, testable** requirements from any source material — and to maintain them over time.

## What makes a good atomic requirement

An atomic requirement captures **exactly one capability, constraint, or quality** that the system must satisfy. The test: can someone implement and verify this requirement without reading any other requirement? If yes, it's atomic.

- ✅ **Atomic**: "Il form di contatto deve includere i campi Nome, Cognome, Azienda, Email, Dimensione azienda — tutti obbligatori"
- ❌ **Not atomic**: "Il sito deve avere un form di contatto e una newsletter e deve essere GDPR compliant" (three distinct requirements)
- ❌ **Not atomic**: "Gestione contatti" (this is a feature area, not a requirement)

A requirement that references another requirement for context is fine — what matters is that it can be **implemented and tested independently**.

---

## Requirement schema

Every requirement uses YAML frontmatter + markdown body. This is the canonical format:

```markdown
### REQ-XXX — Headline

The headline is a single sentence that captures the essence of the requirement.
It must be self-explanatory: reading only the headline, you understand what is required.
Headlines are the primary key for semantic comparison — duplicates are detected here.

---
id: REQ-XXX
headline: "The same headline as the title — repeated here for machine parsing"
type: funzionale | non-funzionale | contenuto | ux | vincolo | business-rule | integrazione
priority: must | should | could | wont
stream: "[S1]" | "[S2]" | "[S3]" | "[CORE]" | "[S1][S3]"
source: interview:D2 | document:brief:REQ-045 | domain-kb | conversation:2026-03-13 | derived:REQ-012
depends: REQ-012, REQ-045
status: draft | proposed | committed
status_date: 2026-03-13
---

Full description: one clear paragraph, self-contained.
Include enough context that someone reading only this requirement
understands what must be built and why.

**Accettazione:** One or more concrete, testable criteria.
How do you know this requirement is satisfied?
```

### Headline rules

The headline is the most important field. It drives semantic comparison and deduplication.

- **One sentence, imperative mood**: "Il sito deve mostrare i servizi in 3 card distinte"
- **Self-explanatory**: someone who reads only this headline understands the requirement
- **Specific enough to detect overlap**: "Form di contatto con 5 campi obbligatori" (not "Form di contatto")
- **No jargon without context**: "CMS per aggiornamento autonomo contenuti" (not "CMS necessario")

### Status workflow

Requirements follow a lifecycle with explicit transitions. Each status change records the date.

```
DRAFT ──→ PROPOSED ──→ COMMITTED
  ↑           │            │
  └───────────┘            │    (rework: back to DRAFT)
  └────────────────────────┘    (rework: back to DRAFT)
```

| Status | Meaning | Who transitions |
|---|---|---|
| `draft` | Being created or refined — may be incomplete, may have duplicates | Claude during extraction |
| `proposed` | Complete and ready for review — headline, description, acceptance criteria all present | Claude after validation |
| `committed` | Accepted by the stakeholder — this requirement WILL be implemented | The user (Achille) explicitly |

**Rules:**
- Only the user can move a requirement to `committed`. Claude can propose, never commit.
- A requirement can go back to `draft` from any status (rework).
- `status_date` records the date of the last status change.
- When comparing for duplicates, `draft` requirements are checked against `proposed` and `committed` ones — not the other way around. This protects already-approved requirements from being destabilized by new drafts.

### Type taxonomy

| Type | What it describes | Example |
|---|---|---|
| `funzionale` | What the system does | "Form sends email notification" |
| `non-funzionale` | How well it does it | "Page loads in < 3s on 3G" |
| `contenuto` | What it says/shows | "Hero speaks to the problem, not the solution" |
| `ux` | How the user feels/interacts | "CTA is reachable without scrolling" |
| `vincolo` | Non-negotiable limit | "GDPR compliant, Iubenda" |
| `business-rule` | Domain rule to enforce | "No pricing shown on site" |
| `integrazione` | External system connection | "Form data sent to CRM via webhook" |

### Priority (MoSCoW)

| Tag | Meaning |
|---|---|
| `must` | Without this, the project is not acceptable |
| `should` | Important but launch can happen without |
| `could` | Nice-to-have, only if time/budget allows |
| `wont` | Explicitly out of scope (but documented to prevent scope creep) |

### Source traceability

Every requirement traces back to where it came from. Format: `<source-type>:<reference>`.

| Source type | Example | When to use |
|---|---|---|
| `interview:<id>` | `interview:D2` | Extracted from interview answer |
| `document:<name>` | `document:brief:REQ-045` | From existing document |
| `domain-kb` | `domain-kb:seo` | Inferred from domain knowledge |
| `conversation:<date>` | `conversation:2026-03-13` | From a session discussion |
| `derived:<req-id>` | `derived:REQ-012` | Logically derived from another req |

---

## Workflow

### Phase 0 — Check for Domain KB and Glossary

Before extracting requirements, check for two foundational documents:

#### DOMAIN-KB.md

The Domain KB describes **the domain being implemented** — not the project goals (that's GOAL.md), but the domain expertise needed to build it well. Examples:

- For a website: what makes a good consulting website, SEO fundamentals, CMS patterns, accessibility standards, conversion optimization principles
- For an ERP: how ERP systems work, common modules, data flows, integration patterns
- For commission plans: how variable compensation works, common structures, legal constraints

**If DOMAIN-KB.md exists:** read it. It informs gap analysis and requirement generation.

**If DOMAIN-KB.md does NOT exist:** tell the user:

> "Non ho trovato un DOMAIN-KB.md nel workspace. Questo documento descrive la conoscenza di dominio necessaria per generare requisiti completi — ad esempio, per un sito web conterrebbe best practice SEO, accessibilità, conversion patterns ecc. Vuoi che ne creiamo uno prima di procedere con i requisiti?"

If the user says yes, generate it from:
1. The project context (GOAL.md, existing docs)
2. Your own domain knowledge
3. Web research if needed

Save it as `DOMAIN-KB.md` in the workspace root. Keep it focused (~200-400 lines) on what's needed for requirement completeness — not a textbook.

#### GLOSSARIO.md

The Glossary is a **living dictionary** of project and domain terms. It ensures that everyone (human and AI) uses the same words with the same meaning. This prevents ambiguity in requirements — when a requirement says "controller", the glossary defines exactly what that means in this project.

**Structure:**

```markdown
# Glossario — <ProjectName>

> Dizionario dei termini di progetto e di dominio.
> Ogni termine usato nei requisiti deve avere una definizione qui.

---

## Termini di progetto

### Controller fractional
Professionista esterno che svolge le funzioni di un controller aziendale
su base parziale (non full-time), tipicamente per PMI che non possono
sostenere il costo di una risorsa dedicata.

### CTA
Call to Action — elemento del sito che invita il visitatore a compiere
un'azione specifica (es. compilare un form, prenotare una call).

## Termini di dominio

### Controllo di gestione
Attività di pianificazione, monitoraggio e analisi delle performance
economico-finanziarie di un'azienda. Include budget, analisi dei margini,
forecast e reporting direzionale.

### Revenue operations
Insieme di processi e strumenti per gestire il ciclo di vendita:
sales funnel, pipeline, compensazione venditori, gestione ARR.
```

**If GLOSSARIO.md does NOT exist:** tell the user:

> "Non ho trovato un GLOSSARIO.md nel workspace. Il glossario è un dizionario dei termini di progetto e dominio — assicura che i requisiti usino un linguaggio univoco. Vuoi che ne creiamo uno come base di partenza?"

If the user says yes, generate it from the project context + domain KB, with terms grouped in "Termini di progetto" and "Termini di dominio".

**Maintenance rule:** when extracting requirements, if a term is used that is not in the glossary, add it. `scripts/validate.py --glossary GLOSSARIO.md` flags terms used in requirements but not defined in the glossary.

### Phase 1 — Init

Read the project context:
1. `GOAL.md` — objectives, constraints, success criteria
2. `INTERVIEW.md` — if exists, the elicitation responses
3. `DOMAIN-KB.md` — domain expertise
4. Existing `REQUISITI.md` or `requisiti/*.md` — if requirements already exist

Identify:
- What sources are available
- What has already been captured as requirements
- What gaps exist (areas in the domain KB not covered by existing requirements)

### Phase 2 — Extract

For each source (interview, document, conversation):

1. **Decompose** into atomic candidate requirements — status: `draft`
2. **Apply atomicity test**: does this requirement stand alone? If it bundles multiple concerns, split it
3. **Write the headline first** — it must be self-explanatory and specific
4. **Classify**: assign type, priority, stream, source
5. **Assign ID**: sequential within the file (REQ-001, REQ-002...) or within the category file
6. **Write acceptance criteria**: how do you verify this is done?
7. **Link dependencies**: if this requirement assumes another, make it explicit with `depends:`

### Phase 3 — Organize output

**File strategy** — the skill adapts based on volume:

| # Requirements | Strategy | Structure |
|---|---|---|
| < 50 | Single file | `REQUISITI.md` |
| 50–150 | Split by macro-category | `requisiti/contesto.md`, `requisiti/funzionali.md`, ... |
| > 150 | Split by category + index | `requisiti/index.md` + one file per category |

When splitting, create an `index.md` that lists all files with requirement count and coverage summary.

Category grouping follows the project's own taxonomy (e.g., the Type field, or the stream tags, or a domain-specific grouping). Ask the user if unsure.

### Phase 4 — Validate (two levels)

Validation has two levels: mechanical (free) and semantic (token-controlled).

#### Level 1 — Mechanical validation (`scripts/validate.py`, 0 tokens)

Run `scripts/validate.py` to check:
- **ID uniqueness**: no duplicate IDs across all files
- **Required fields**: every requirement has id, headline, type, priority, source, status, status_date
- **Dependency integrity**: every `depends: REQ-XXX` reference exists
- **Headline similarity**: TF-IDF cosine similarity on all headlines — flags pairs above threshold (0.6)
- **Draft vs existing overlap**: specifically checks `draft` headlines against `proposed`/`committed`
- **Atomicity heuristic**: flags headlines/descriptions with conjunction signals
- **Gap analysis**: cross-reference with DOMAIN-KB.md sections to find uncovered areas

#### Level 2 — Semantic review (`scripts/review.py` → Claude, controlled tokens)

Run `scripts/review.py` to prepare a review payload. The script:
1. Reads `validate.py` output (flagged items)
2. Selects all requirements with warnings + a random sample of clean ones
3. Groups them into a compact review prompt
4. Outputs a JSON file (`review-payload.json`) ready for Claude

Claude then processes the payload and evaluates each flagged requirement on:

- **Atomicity**: does this requirement really capture one concept? If not, propose specific splits with draft headlines for each resulting requirement
- **Headline quality**: is the headline self-explanatory? Specific enough? Would you detect overlap from the headline alone?
- **Overlap verdict**: for pairs flagged by TF-IDF, are they true duplicates, partial overlaps (merge candidate), or false positives?
- **Acceptance testability**: are the acceptance criteria concrete and verifiable by a developer/tester?
- **Ambiguity**: flag vague terms ("adeguato", "efficiente", "buono", "appropriato") and suggest replacements
- **Completeness**: is anything missing for implementation?

Claude outputs a structured review with actions: `split`, `merge`, `rewrite-headline`, `rewrite-acceptance`, `ok`.

Report findings to the user. Do NOT auto-fix — present the issues and let the user decide.

### Phase 5 — Refine (iterative)

Based on validation results and user feedback:
- Merge true duplicates (keep the more detailed version, redirect the other ID)
- Split non-atomic requirements — create new REQ-IDs, link via `derived:REQ-xxx`
- Promote clean `draft` requirements to `proposed`
- Fill gaps suggested by domain KB
- Update priorities after discussion
- Re-run validate.py after changes to verify fixes

---

## Token efficiency rules

1. **Never re-read the entire requirements file to add one requirement.** Append or edit surgically.
2. **Use `scripts/validate.py` for mechanical checks** — don't manually scan for broken dependencies or missing fields.
3. **Use `scripts/review.py` to select only flagged items for semantic review** — never pass the entire requirements file to Claude for review.
4. **Load DOMAIN-KB.md only in Phase 0/1** — don't re-read it for every requirement.
5. **When splitting files**, work on one category file at a time.

---

## Quality checklist

Before finalizing a batch of requirements, verify:

- [ ] Every requirement has complete YAML frontmatter (id, headline, type, priority, stream, source, status, status_date)
- [ ] Every requirement has acceptance criteria
- [ ] Every requirement passes the atomicity test (one concern per requirement)
- [ ] Every headline is self-explanatory and specific
- [ ] Every `depends:` reference points to an existing requirement
- [ ] Every requirement traces to a source (no orphan requirements)
- [ ] No duplicate IDs across all files
- [ ] `scripts/validate.py` returns 0 errors and 0 unresolved warnings
- [ ] `scripts/review.py` + Claude semantic review returns no critical findings
- [ ] Domain KB areas are covered (gap analysis clean or gaps acknowledged as `wont`)
- [ ] No `draft` requirements remain — all are `proposed` or `committed`

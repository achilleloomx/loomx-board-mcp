# LoomX Skill Library

Repository centralizzata di skill modulari per agenti Claude Code.

## Cos'è una skill

Una skill è un modulo auto-contenuto che specializza il comportamento di Claude Code per un compito specifico. Ogni skill ha:

- `SKILL.md` — istruzioni + frontmatter con metadati
- `VERSION` — versione semantica (semver)
- `assets/` — template, esempi (opzionale)
- `scripts/` — script di automazione (opzionale)

### Frontmatter SKILL.md

Ogni skill dichiara nel frontmatter YAML:

```yaml
---
name: nome-skill
version: 1.0.0
description: >
  Cosa fa la skill e quando attivarla.
dependencies:        # altre skill richieste ([] se nessuna)
  - requirements-engineer
requires:            # file/risorse che il progetto ospitante deve avere
  - docs/DECISIONS.md
  - src/
provides:            # cosa produce la skill
  - Audit report
---
```

| Campo | Significato |
|---|---|
| `dependencies` | Altre skill che devono essere disponibili (la skill le invoca) |
| `requires` | File/cartelle che il progetto ospitante deve avere |
| `provides` | Output prodotti dalla skill |

## Skill disponibili

### Governance (qualsiasi agente)
| Skill | Versione | Dipendenze | Descrizione |
|---|---|---|---|
| `session-manager` | 1.0.0 | — | Sessioni start/end, TODO, DECISIONS, status report |
| `sprint-manager` | 1.0.0 | session-manager, audit | Sprint planning, gate, build-log |
| `coordinator` | 1.0.0 | session-manager | Delega cross-repo, roadmap, dipendenze (per orchestratori) |

### Software development
| Skill | Versione | Dipendenze | Descrizione |
|---|---|---|---|
| `requirements-engineer` | 1.0.0 | — | Crea, estrai, valida requisiti atomici |
| `interviewer` | 1.0.0 | requirements-engineer | Intervista stakeholder per raccolta requisiti |
| `design` | 1.0.0 | requirements-engineer | Crea/aggiorna design doc (SDES) |
| `implement` | 1.0.0 | audit | Traduce design approvati in codice |
| `audit` | 1.0.0 | security-auditor, requirements-engineer, design | Verifica traceability tra layer |
| `security-auditor` | 1.0.0 | — | Audit sicurezza DB e codice |

### Deprecated
| Skill | Sostituita da |
|---|---|
| `project-manager` | `session-manager` + `sprint-manager` |

### Grafo dipendenze

```
                    coordinator
                        │
                        ▼
interviewer ──→ requirements-engineer ←── design
                                            ↑
security-auditor ←── audit ←── implement
                       ↑
                 sprint-manager
                       ↑
                 session-manager ←── coordinator
```

## Come usare le skill in un progetto

### Convenzione `$SKILL_ROOT`

Le skill usano `$SKILL_ROOT` come prefisso nei comandi (es: `python $SKILL_ROOT/audit/scripts/validate-decisions.py`).
Ogni progetto deve definire `SKILL_ROOT` nel proprio CLAUDE.md:

```markdown
## Skill
SKILL_ROOT = ../../loomx-skill-library/skills
```

Gli script JS/Python accettano `REPO_ROOT` come variabile d'ambiente (fallback: `cwd`).

### Importazione

Il CLAUDE.md del progetto referenzia le skill via path relativo a `$SKILL_ROOT`.
Esempio dalla tabella skill di un CLAUDE.md:

```markdown
| `audit` | `$SKILL_ROOT/audit/SKILL.md` | Verifica traceability tra layer |
```

Un progetto importa solo le skill che serve. Le dipendenze sono dichiarate nel frontmatter — se importi `audit`, devi avere anche `security-auditor`, `requirements-engineer` e `design`.

## Versionamento

- Versione in `VERSION` file + campo `version` nel frontmatter SKILL.md
- MAJOR: breaking change nel comportamento della skill
- MINOR: nuova funzionalità retrocompatibile
- PATCH: fix o miglioramento minore
- Tag git: `skill-name/vX.Y.Z` (es: `audit/v1.0.0`)

## Struttura

```
loomx-skill-library/
├── README.md
├── CHANGELOG.md
├── skills/
│   ├── PRINCIPI-DESIGN.md      ← principi condivisi
│   ├── requirements-engineer/
│   │   ├── SKILL.md            ← istruzioni + frontmatter modulare
│   │   ├── VERSION
│   │   ├── assets/
│   │   └── scripts/
│   ├── design/
│   ├── implement/
│   ├── audit/
│   ├── project-manager/
│   ├── security-auditor/
│   └── interviewer/
```

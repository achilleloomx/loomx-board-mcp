---
name: alignment-auditor
version: 1.0.0
description: >
  Audits cross-repo consistency across all LoomX Home agents.
  Checks CLAUDE.md alignment, skill submodule versions, namespace conventions,
  coordinamento references, and governance compliance.
  Trigger on: "alignment check", "controlla agenti", "audit allineamento",
  session start (PM only), or after cross-repo decisions.
dependencies: [session-manager]
requires:
  - docs/DECISIONS.md
provides:
  - Alignment audit report with issues per repo
  - Automatic fixes for simple inconsistencies
  - Notifications for issues requiring agent intervention
---

# Alignment Auditor

Verifica la coerenza tra tutti gli agenti LoomX Home.
Solo il PM usa questa skill — è parte del suo ruolo di coordinamento.

---

## Context

Il PM legge i CLAUDE.md di tutti gli agenti e li confronta con la governance
centrale (DECISIONS.md, tabella agenti, risorse condivise).

---

## Mode 1 — Quick Audit (session start)

Eseguito automaticamente dal session-manager Mode 1, dopo il session brief.

### Cosa controllare

1. **Coordinamento sections** — ogni agente lista tutti gli altri agenti?
2. **Schema references** — nessun agente punta a location obsolete per il DB?
3. **Skill submodule** — stesso commit across all repos?
4. **Decisioni recenti** — le ultime D-XXX sono riflesse nei CLAUDE.md impattati?

### Come fare

Per ogni repo agente (`loomx-home-app`, `loomx-home-assistant`, `loomx-home-DBA`):
1. Leggi il CLAUDE.md
2. Confronta con la tabella agenti del PM
3. Verifica i path cross-repo (Coordinamento, schema, risorse)
4. Controlla `git submodule status .skills` per la versione skill

### Output

```
### Alignment check — [data]
- ✅ home-app: allineato
- ⚠️ home-assistant: [descrizione problema]
- ✅ home-DBA: allineato
```

Se tutto OK → una riga nel session brief sotto "Alert governance".
Se ci sono problemi → lista dettagliata con severità.

---

## Mode 2 — Full Audit (su richiesta)

Audit completo con correzioni. Invocato manualmente o dal trigger schedulato.

### Checklist completa

#### A — Struttura agenti
- [ ] Tabella agenti nel PM CLAUDE.md corrisponde alle repo esistenti
- [ ] Ogni agente ha sezione Coordinamento con tutti i sibling
- [ ] Path nei Coordinamento sono corretti (non puntano a path obsoleti)

#### B — Governance DB (D-004)
- [ ] Nessun agente dichiara ownership su `supabase/migrations/` tranne il DBA
- [ ] Tutti i riferimenti allo schema puntano a `loomx-home-DBA`
- [ ] Namespace table del DBA copre tutti i domini attivi

#### C — Skill library
- [ ] Tutti i repo hanno `.skills/` submodule
- [ ] Tutti puntano allo stesso commit
- [ ] Skill dichiarate nei CLAUDE.md esistono su disco
- [ ] Nessuna skill deprecata referenziata

#### D — Decisioni
- [ ] Ultime 3 decisioni del PM riflesse nei CLAUDE.md impattati
- [ ] Nessun CLAUDE.md contraddice una decisione attiva

#### E — Risorse condivise
- [ ] Tabella risorse del PM aggiornata
- [ ] Nessuna risorsa duplicata tra repo

### Output

Report dettagliato per sezione:

```
## Alignment Audit Report — [data]

### A — Struttura agenti
[risultati]

### B — Governance DB
[risultati]

### C — Skill library
[risultati]

### D — Decisioni
[risultati]

### E — Risorse condivise
[risultati]

### Azioni
- 🔧 Fix automatici applicati: [lista]
- 📩 Notifiche da inviare: [agente → problema]
- ⏳ Richiede intervento umano: [lista]
```

### Fix automatici

Per inconsistenze semplici (path sbagliati, agente mancante dal Coordinamento):
1. Applica la correzione al CLAUDE.md
2. Commit con messaggio: `docs: alignment fix — [descrizione]`
3. Push

Per inconsistenze complesse (decisioni contraddittorie, schema conflicts):
1. NON correggere automaticamente
2. Segnalare nel report
3. Quando Board MCP disponibile → `board_send type=alignment_issue`
4. Altrimenti → aprire GitHub Issue sulla repo dell'agente

---

## Mode 3 — Change Impact Assessment

Invocato **prima** di applicare una decisione cross-repo.
Serve a capire quali agenti sono impattati e cosa va aggiornato.

### Input
- Decisione proposta (es. "spostare schema da X a Y")

### Processo
1. Identifica tutti i CLAUDE.md che referenziano l'area impattata
2. Lista le sezioni specifiche da aggiornare
3. Stima effort (quanti file, quanti repo)

### Output

```
### Impact Assessment — [decisione]

**Repo impattate:** N
| Repo | File | Sezione | Cambiamento |
|---|---|---|---|
| home-app | CLAUDE.md | Coordinamento | Aggiungere nuovo agente |
| ... | ... | ... | ... |

**Rischio:** basso/medio/alto
**Proposta:** applicare subito / aspettare approvazione
```

---

## Rules

1. Mai modificare la logica o il ruolo di un agente — solo allineamento governance
2. In caso di dubbio, segnalare e chiedere ad Achille
3. Fix automatici solo per inconsistenze oggettive (path, riferimenti)
4. L'audit non modifica DECISIONS.md — quello è compito del session-manager
5. Ogni fix automatico deve essere committato e pushato immediatamente

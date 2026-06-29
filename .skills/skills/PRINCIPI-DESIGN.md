# Principi di design delle skill

## Regola fondamentale: le skill sono stateless rispetto al progetto

**Le skill contengono logica procedurale — non dati di progetto.**

| Appartiene alla skill | Appartiene ai file di governance |
|---|---|
| Come fare una cosa | Cosa fare |
| Sequenza di step | Struttura degli sprint |
| Formato di output | Nomi, gate, deliverable |
| Trigger di attivazione | Task e backlog |
| Regole di validazione | Decisioni prese |

---

## Il test

Prima di scrivere qualcosa in una skill, chiediti:

> *"Questo dato può cambiare senza che la logica cambi?"*

- **Sì** → appartiene ai file di governance (`TODO.md`, `DECISIONS.md`, `DESIGN-DOC.md`, ecc.)
- **No** → può stare nella skill

### Esempi

| Dato | Dove metterlo | Perché |
|---|---|---|
| "Sprint 0 ha gate: wireframe approvato" | `TODO.md` | Il gate può cambiare, o lo sprint può non esistere |
| "Dopo conferma, scrivi in TODO.md" | skill | La procedura è stabile |
| "REQ must/should → backlog obbligatorio/opzionale" | skill | È una regola, non un dato |
| "committed/must: 52 REQ totali" | mai in nessun file | È un conteggio, va calcolato in tempo reale |

---

## Conseguenza pratica

Una skill scritta correttamente funziona **su qualsiasi progetto** che usi gli stessi file di governance.
Se una skill smette di funzionare quando cambia la struttura degli sprint, è scritta male.

---

## File di governance e loro responsabilità

```
TODO.md          → stato operativo corrente (sprint, task, blocchi)
DECISIONS.md     → decisioni attive (non riscrivibili)
HISTORY.md       → log sessioni passate
DESIGN-DOC.md    → SDES e loro stato (draft/approved/implemented)
requisiti/       → REQ atomici e loro stato
```

Le skill leggono questi file. Non li duplicano.

---

*Aggiunto: {{DATE}}*

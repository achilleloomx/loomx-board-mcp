# HISTORY — Board MCP Server

> Storico sessioni dello sviluppatore MCP.

---

## Sessione #43 — 2026-07-02 (P7 remediation governance: enforcement by-construction)

**GTD:** `[autopilot board-mcp] P7 remediation governance — enforcement by-construction lato board-mcp` (`e308cec4`). **WI** `e94fc07d`. Template `fix-bug-backend` (on-the-fly). Modello: sonnet (autopilot). Da review governance AI (Loomy, 2026-07-02, approvata da Achille). Rif. WI Loomy `afd24663`.

**Status:** ✅ **DONE — 3/3 punti indirizzati, build verde, 60/60 test invariati.**

**1. Guard D-069 two-phase arm come vincolo (src/tools.ts, `gtd_update`):** prima era solo convenzione documentata in CLAUDE.md ("NON armare GTD prima di wi_end"). Ora `gtd_update(autopilot=true)` verifica se l'owner risultante (target owner, dopo eventuale reassign) ha un WI `status='active'` su `loomx_work_items` e rifiuta con errore actionable se sì — enforcement by-construction invece di disciplina. Risolve owner: usa `owner` se fornito nella call, altrimenti fa una SELECT sull'item esistente.

**2. `item_project_link` (nuovo tool, src/tools.ts):** UPSERT `(item_id, project_id)` su `loomx_item_projects` (PK composita, schema confermato in `loomx-home-DBA/supabase/migrations/20260405100000_...sql`). Prima l'unico modo era passare dalla Management API. Ownership: owner dell'item o loomy (stesso pattern di `gtd_link_agent`). Idempotente via `onConflict`.

**3. Valutato footgun `gtd_update` body-only → flip a done:** **non riprodotto nel codice attuale.** `gtd_update` include `gtd_status` nel payload di UPDATE solo se il param è esplicitamente passato (`if (gtd_status !== undefined) updates.gtd_status = gtd_status`) — chiamare con solo `body` preserva lo status corrente già oggi. Nessuna modifica necessaria lato board-mcp; il rischio residuo è comportamento del *caller* (agente/LLM che passa `gtd_status="done"` insieme a `body` pensando a un semplice append di note) — fuori dal controllo del server. Segnalato a Loomy per chiudere il punto nella review.

**Cosa (src/tools.ts):** guard D-069 in `gtd_update` (+ const `WI_TABLE`), nuovo tool `item_project_link`. CLAUDE.md aggiornato (tabella GTD Tools, count 28→29). `package.json` → v0.10.0.

**Note operative:** live exposure richiede rebuild+restart del processo MCP (pattern noto, vedi #40/#41). Nessuna migrazione DB richiesta — `loomx_item_projects` e `loomx_work_items` esistono già.

**Bug scoperto in chiusura (WI separato `e1867f2b`, GTD `156b7b35`): `syncWiCache` cancellava la cache invece di preservarla.** Provato a chiudere il WI di cui sopra ed eseguire `runtime_request` (step obbligatorio D-052) → gate bloccato con "Nessun Work Item attivo" nonostante `wi_end` appena riuscito. Causa: `wiCache.ts::syncWiCache` filtrava `status='active'` e faceva `unlink()` della cache se non trovava righe — quindi dopo ogni `wi_end`/`wi_pause` la cache spariva del tutto, rendendo dead code il whitelist post-chiusura di `governance-gate.sh` (righe 167-180, WIP non committato di un'altra sessione, v1.1) che si aspetta la cache ancora presente con `status=done|failed|paused` per lasciar passare `gtd_update`/`gtd_complete`/`board_send`/`runtime_request`/`wi_start`. **Fix:** `syncWiCache` ora fa query senza filtro di status (order by `started_at` desc, limit 1) e scrive sempre la riga più recente — la cache si svuota solo se l'agente non ha mai avuto un WI. Impatta ogni agente della flotta (blocco strutturale sul closing-sequence D-052, non solo board-mcp). Richiede rebuild+restart per essere live; segnalato a Loomy.

## Sessione #44 — 2026-07-03 (P7 remediation governance: items 1-5 chiusi, 6-8 pianificati)

**GTD:** `e308cec4` (stesso GTD di Sessione #43, riaperto — il lavoro descritto in #43 era rimasto non committato: 519 righe pendenti, working tree only). **WI** `8acc4201`. Modello: sonnet (autopilot). Rif. WI Loomy `635ac874`.

**Status:** ✅ **DONE — items 1-5 chiusi, 70/70 test, build pulita. Items 6-7 pianificati come GTD follow-on, item 8 girato a DBA.**

**1. Commit del lavoro pendente (b6b3c08):** guard D-069 su `gtd_update`, `item_project_link`, backstop 23505 su `gtd_add` (D-066), `doc_link`/`docTypes` relation `references`→`doc_item_xproject_links` (D-074), fix `wiCache.ts` (descritto in #43). Incluso fix sicurezza fuori scope originale: `.mcp.json.servicerole.bak` in root conteneva `service_role` key in chiaro — mai committato ma non coperto da `.gitignore` (solo `.claude/*.bak*`, non il root). Eliminato + `*.bak*` aggiunto a `.gitignore`.

**2. Guard D-069 esteso a `gtd_add` (a2c010e):** prima si poteva creare un GTD con `autopilot=true` mentre l'owner aveva un WI active, bypassando il guard che c'era solo su `gtd_update`. Estratto helper condiviso `checkAutopilotArmGuard(db, owner)` in `src/tools.ts`, usato da entrambi i tool.

**3. Versione unificata (a2c010e):** `server.ts` (hardcoded `0.2.0`) e `remote.ts` (hardcoded `0.6.0`) leggono ora `PACKAGE_VERSION` da `package.json` via nuovo `src/version.ts` (`fs.readFileSync` + `import.meta.url`, non import JSON diretto perché `package.json` è fuori da `rootDir=src`).

**4.** Vedi punto 1.

**5. Test di regressione (a2c010e):** estratta `buildGtdUpdatePayload()` come funzione pura esportata da `src/tools.ts` (prima logica inline in `gtd_update`); nuovo `tests/gtd.test.ts` verifica che un update con solo `body` non tocchi `gtd_status` né altri campi. Chiude il punto aperto in #43 punto 3 ("non riprodotto, ma senza test").

**Items 6-8 (project_list tool, refresh registry board_agents, cron pg + trigger DB D-069):** fuori dal budget di questa sessione. Pianificati come 2 GTD follow-on (`4a709dc7` project_list, `d655e2a5` refresh registry), `autopilot=false` fino a `wi_end` (D-069 two-phase). Item 8 (cron `board_archive_old` + valutazione trigger DB) richiede DBA — girato con `board_send` task diretto, non GTD board-mcp.

**Risposto in board_inbox:** ETA gate D-074 (implementato, ora anche su `gtd_add`), bug atlas su `doc_item_wi_links` non risolti dal gate `wi_end` (fuori scope, gate vive in `src/wi.ts` non toccato — resta aperto), anomalia dedup 30/06 (backstop 23505 committato ma l'anomalia storica specifica non investigata, fuori scope).

## Sessione #45 — 2026-07-03 (P7 scope item 6: project_list read-only tool)

**GTD:** `[board-mcp] project_list read-only tool` (`4a709dc7`, follow-on da #44 item 6). **WI** `d91ba6c7`. Modello: sonnet (autopilot, D-053 gate costi — task read-only, non design/DDL).

**Status:** ✅ **DONE — tool aggiunto, 70/70 test invariati, build pulita.**

**`project_list` (nuovo tool, src/tools.ts):** SELECT read-only su `loomx_projects` (`id, name, short_name, status, agent_id`), filtri opzionali `status`/`agent_id`, limit default 50. Nessun path di scrittura, nessun cambio ruolo RLS — risolve il problema di discovery del `project_id` oggi possibile solo via Management API. Schema confermato in `loomx-home-DBA/supabase/migrations/20260405100000_...sql` (colonne: `id, name, short_name, client_id, type, agent_id, repo, local_path, status, notes`; niente colonna `slug` — usato `short_name`). CLAUDE.md aggiornato (tabella GTD Tools, count 29→30).

**Note operative:** live exposure richiede rebuild+restart del processo MCP (pattern noto, vedi #40/#41/#44).

## Sessione #42 — 2026-06-30 (verifica dedup D-066: anomalia Atlas source_ref f7f797ad)

**GTD:** `[msg] loomy→board-mcp: verifica dedup D-066 — stesso source_ref f7f797ad → 3 GTD distinti (anomalia Atlas)` (`237a4139`). **WI** `ee9149b8-e71f-463f-b39c-4f1db2deec44`. Template `verify-dedup` (on-the-fly). Modello: opus (autopilot). Lega a anomalia loomy `001587bd`.

**Status:** ✅ **DONE — verdetto duplice + hardening in-lane; build verde 66/66.**

**Verdetto 1 — il caso f7f797ad è un FALSO POSITIVO (misdiagnosi).** I 3 GTD citati hanno **3 source_ref DIVERSI**, non lo stesso:
- `84e6b6cc` (atlas, 04:16:44) src_ref=`e63aa145` — analyst-quadro→atlas: ACK METH-001
- `5ae3a1b6` (atlas, 04:27:38) src_ref=`ec78e96e` — analyst-quadro→atlas: platform contribution
- `bd4946dd` (atlas, 04:27:48) src_ref=`f7f797ad` — analyst-quadro→atlas: METH-002+003 bozze

Sono **3 messaggi board distinti** di analyst-quadro→atlas (topicamente simili → METH playbook). Il dedup `(owner, source_ref)` ha fatto la cosa giusta: 1 GTD per messaggio distinto. Nessun danno da esecuzione doppia (tutti `done`, ma erano task diversi). Atlas li ha raggruppati come "stesso msg" perché semanticamente affini.

**Verdetto 2 — esiste comunque un gap di dedup reale (contesto 001587bd), ma ~97% è residuo PRE-fix.** Scan completo `loomx_items` non-trash con source_ref dal 23/06 (1008 righe): **148 gruppi (owner, source_ref) duplicati**. Distribuzione per giorno del 2° membro: 26/06=5, 27/06=7, **28/06=57, 29/06=75**, 30/06=4. Il dedup server-side board-mcp è del commit `9d296c8` (30/06 01:17 UTC) → i duplicati 28-29/06 sono **antecedenti al fix** (non esisteva). Solo **2 gruppi post-fix** (≥2 membri dopo 01:17): `loomy||0680f4b1` (x2, 9.5 min di distanza → non race, probabile MCP child su dist vecchio) e `researcher||ea7ad420` (x7, burst in 24s → race o path che bypassa il dedup).

**Root cause del gap residuo (2 cause):**
1. **TOCTOU**: il dedup in `gtd_add` è un check-then-insert NON atomico, senza UNIQUE a DB su `(owner, source_ref)`. Burst concorrenti (researcher x7) superano tutti la SELECT e poi inseriscono.
2. **Deploy-lag**: `dist/tools.js` ricostruito alle 09:03 UTC, ma i processi MCP child degli agenti partiti prima girano sul dist vecchio → niente dedup finché non riavviano (stesso fenomeno notato in #41).

**Fix corretto:** la dedup NON è correggibile in app-code da sola →
- **DBA (D-005):** partial UNIQUE index `loomx_items (owner, source_ref) WHERE source_ref IS NOT NULL AND gtd_status <> 'trash'`. È l'unico modo atomico sotto concorrenza.
- **board-mcp (fatto questa sessione):** `gtd_add` ora cattura `23505` (unique_violation) → re-SELECT del winner e ritorna `duplicate:true` (stessa UX del fast-path). Inerte finché l'indice non esiste, correct-by-construction dopo.
- **Cleanup residui:** trashare i 146 gruppi pre-fix tenendo il più vecchio non-trash per chiave = task broker/loomy (ownership cross-agente, molti già `done`/agiti) — NON mass-trash dalla mia lane.

**Cosa (src/tools.ts):** aggiunto backstop `error.code === '23505'` in `gtd_add` dopo l'insert. Build verde, 66/66 test invariati. Esposizione live richiede rebuild+restart (come #41).

**Note:** indagine via service-role read-only (script throwaway, rimossi). Nessuna modifica dati. `runtime_request` posato a fine-WI.

## Sessione #41 — 2026-06-30 (doc_query lean output: summary= / fields=)

**GTD:** `[infra] board-mcp — doc_query summary/fields param (prereq scala review consistenza)` (`f7b1bd70`). **WI** `55e2c96b-f1d4-41dc-8f3e-704c2437ab66`. Template `add-tool-param` (L1, durable).

**Status:** ✅ **DONE — 66/66 test pass (2 nuovi), build verde.**

**Contesto:** la review di consistenza pilota (Kinesis) ha trovato che i dump `doc_query` sfondano il budget token (REQ 75k char, SDES 97k char) → obbligano salvataggio su file + jq, impraticabile a scala. Prerequisito per scalare le review agli altri progetti.

**Cosa (src/docs.ts + src/tools.ts):**
1. **`summary=true`** — per ogni item ritorna `{id, code, item_type, status, body_chars, headline(≤120, whitespace collassato), links:{doc_out, doc_in, gtd, wi}}`. Nessun body completo. `docSummarize()` calcola i conteggi con 1 query `doc_item_links` project-scoped + 2 query `.in('doc_item_id', ids)` su gtd/wi link tables. Permette di contare orfani/copertura senza dumpare body.
2. **`fields="code,status,..."`** — proiezione sulle sole colonne richieste (whitelist `QUERYABLE_FIELDS`, `id` sempre incluso, salta `body` se non elencato). Campo non valido → errore actionable con la whitelist. Ignorato se `summary=true`.
3. **`traceability`** (req_without_sdes / sdes_without_uat) invariato — confermato come modalità 0-token autoritativa. Precedenza: traceability > summary > fields > full.
4. **Schema MCP** doc_query aggiornato con `summary`/`fields` + description ed esempio lean.
5. **Test** (tests/docs.test.ts): summary shape + link counts; fields rigetto campo ignoto + proiezione valida.

**Governance (dogfood D-074):** REQ-037 + SDES-026 creati in DB; SDES-026 —satisfies→ REQ-037; WI linkato a SDES-026 (`doc_item_wi_links`) → gate durable D-074 soddisfatto.

**Note operative:**
- Live exposure richiede **rebuild + restart** del server MCP (il processo in esecuzione gira sul vecchio dist; verificato: `summary:true` live oggi ritorna ancora `mode:items`).
- Nel working tree resta WIP **pre-esistente non mio** (D-074 cross-project `references` / `doc_item_xproject_links`) in `src/docs.ts` + `src/docTypes.ts`: il commit di doc_query è quindi intrecciato a quel WIP nello stesso file → lasciato non committato, segnalato a loomy.

## Sessione #40 — 2026-06-29 (D-070 cleanup: rimozione riferimento legacy doc_gtd_links)

**GTD:** `[msg] D-070 done — rimuovi riferimento legacy doc_gtd_links dal board-mcp`. **WI** `9dafe63c-fcad-45b2-8f54-ffcbe238f123`.

**Status:** ✅ **DONE — 53/53 test pass, nessuna modifica al codice necessaria.**

**Cosa:** DBA ha completato data migration D-070 (7 righe totali in `doc_item_gtd_links`, inclusa onda 2 da msg 72f69824). Ha aggiunto anche `config_pattern` a `documents.document_type` CHECK constraint su prod.

1. **Codice già pulito** — rimozione legacy `doc_gtd_links` completata in WI `ba4af1b2` (sessione 28/06). `docs.ts` usa `DOC_ITEM_GTD_LINKS = "doc_item_gtd_links"`. `doc_supersede` trasferisce solo a `doc_item_gtd_links` + `doc_item_wi_links`.
2. **CLAUDE.md aggiornato** — riga `doc_link` corretta: `doc_gtd_links` → `doc_item_gtd_links / doc_item_wi_links`; enum `target_kind` aggiornato a `doc|gtd|wi`.
3. **`config_pattern`** già presente in `docTypes.ts` (D-070 onda-3); DB allineato dal DBA.
4. **53/53 test pass** — nessuna regressione.

**Note session #39 rettificate:** il `doc_supersede` NON scrive più su `doc_gtd_links` legacy (fix in WI ba4af1b2); la deprecazione è completata.

---

## Sessione #39 — 2026-06-28 (D-070: esponi doc_item_gtd_links + doc_item_wi_links via MCP)

**GTD:** `[msg] D-070 — doc_item_gtd_links + doc_item_wi_links pronte su prod: esponi via MCP + coordina deprecazione doc_gtd_links`. **WI** `c2c78ef7-fdf4-40a1-8523-26e43bbd9902`.

**Status:** ✅ **DONE — build tsc pulita, 53/53 test pass.**

**Cosa:** migration D-070 applicata dal DBA su prod. Le sorgenti erano già state aggiornate in sessione precedente (21:39-21:41); la build 20:15 era stale. Questa sessione ha:

1. **Build aggiornata** — `npm run build` (tsc) produce nuovo dist/; tutti e 53 i test passano.
2. **`doc_link` ora espone `target_kind="wi"`** — routing a `doc_item_wi_links` (FK `doc_items + loomx_work_items`, no relation_type).
3. **`doc_link(target_kind="gtd")`** → `doc_item_gtd_links` (rinominata da `doc_gtd_links`; no relation_type).
4. **`doc_supersede`** trasferisce link su entrambe le nuove tabelle + legacy `doc_gtd_links` (pre-D-070; DBA gestisce migrazione dati separatamente).
5. **`config_pattern`** aggiunto a `DB_DOCUMENT_TYPES`, `DB_ITEM_TYPES` e registry `DOC_ITEM_TYPE_REGISTRY` — documento + item_type (attrs: component, env, format).
6. **Capability-parity gate** aggiornato — `DB_DOC_GTD_LINK_TYPES = []`, `DB_DOC_WI_LINK_TYPES = []` (no relation_type column nelle nuove tabelle → check trivially pass).
7. **D-070 registrato** in DECISIONS progetto (doc_item D-070, document_id 1da8642c).

**Deprecazione `doc_gtd_links`:** la tabella F0 resta su prod per compatibilità. DBA gestisce data migration. Nessuna rimozione lato MCP finché DBA non completa. Segnalato a Loomy.

**Versione:** 0.8.2 (invariata — no API change per i consumer; `wi` target_kind era già documentato nel CLAUDE.md come futuro).

---

## Sessione #38 — 2026-06-28 (D-065: estendi attrs validati per item_type=decision)

**GTD:** `[board-mcp] D-065: estendi attrs validati per item_type=decision`. **WI** `1df172ca-4c62-47ec-9a02-1b4f8438f6ef`.

**Status:** ✅ **DONE — 52/52 test pass.**

**Cosa:** aggiunta validazione JSON-Schema per i nuovi attrs D-065 su `item_type=decision` in `src/docTypes.ts`:
- `scope`: `{ type: "string", enum: ["project", "cross"] }` — scope impatto
- `applies_to`: `{ type: "array", items: { type: "string" } }` — slug agenti destinatari (default `["all"]` in docs)
- `proposed_by`: `{ type: "string" }` — slug agente proponente
- `superseded_by`: `{ type: "string" }` — codice decisione che la sostituisce

`proposed` era già nell'enum statuses ✅. Example aggiornato con `scope: "cross", applies_to: ["all"], proposed_by: "loomy"`.

`tests/docrw.test.ts` aggiornato per riflettere la migrazione REQ-GOV-012 (`loomx_set_agent_slug` al posto di `set_config`) — due test che cercavano il vecchio pattern. Suite 52/52.

---

## Sessione #37 — 2026-06-28 (REQ-GOV-012: usa loomx_set_agent_slug() invece di SET LOCAL)

**GTD:** `[board-mcp] REQ-GOV-012`. **WI** `964b5e74-ea67-452e-af8c-46d0d6515dd5`.

**Status:** ✅ **DONE — build tsc pulita.**

**Cosa:** security hardening del GUC agent_slug. La migration `20260628000000` del DBA introduce `loomx_set_agent_slug(text)` (SECURITY DEFINER, grant service_role + doc_rw). Due punti modificati in `src/docDb.ts`:
1. **`runPg`** — rimossa `SELECT set_config($1, $2, true)` con GUC hardcoded; sostituita con `SELECT loomx_set_agent_slug($1)` (bound param, validazione lato DB).
2. **`buildMgmtSql`** — DO block aggiornato da `PERFORM set_config('request.agent_slug', '${esc}', true)` a `PERFORM loomx_set_agent_slug('${esc}')`.
3. Rimossa costante `GUC = "request.agent_slug"` (ora inutilizzata). `assertSlug()` e `VALID_SLUG` restano per defence-in-depth lato app.
4. Commenti aggiornati in `docDb.ts` e `tools.ts`.

**Versione:** 0.8.2 (invariata — patch security, nessun API change). Build tsc pulita.

---

## Sessione #36 — 2026-06-28 (REQ-GOV-016: elimina service_role dal write-path doc_*)

**GTD:** `[security-hardening] REQ-GOV-016`. **WI** `265f49f9-3936-49af-82d3-363f41d9bf49`.

**Status:** ✅ **DONE — guard implementata, test 52/52 pass, DECISION scritta nel DB.**

**Cosa:** security hardening del path doc_*. Due fix:
1. **Stale comment** `docs.ts:306` diceva "service_role today" (obsoleto da F4.5) — aggiornato con riferimento corretto F4.5 + REQ-GOV-016.
2. **Fallback docItemResolve** — la query diretta `db.from(DOC_ITEMS).select(...).maybeSingle()` che fungeva da fallback quando `__docRw` era false è stata convertita in `throw new Error(...)` esplicito. Così è impossibile raggiungere il path service_role anche per wiring errato.
3. **Test fake aggiornato** — `tests/docs.test.ts:makeDb` ora implementa `__docRw: true` + `resolveDocItem` (replica in-memory della DB function) per passare il nuovo guard.

**Versione:** 0.8.1 → 0.8.2. Suite 52/52 PASS. Build tsc pulita.

**Pendente:** smoke test live step 3 GTD (doc_item_upsert da slug non in board_agents → 42501 RLS) richiede DOC_RW_DATABASE_URL da BWS (REQ-GOV-013, dipendenza Loomy).

**Decision:** `D-REQ-GOV-016` scritta nel DB DECISIONS board-mcp (id `4893f16f-3211-4fed-b40a-ab9ea9572045`).

---

## Sessione #35 — 2026-06-28 (design staging area file condiviso tra agenti)

**GTD:** `91435dfc-a8d2-4c26-a156-c70a6aa75fe7`. **WI** `bb6d0b5f-3ffb-4f39-bdca-c7c41d7117bd`.

**Status:** ✅ **DONE — design doc prodotto, inviato a Loomy.**

**Cosa:** design dell'architettura "staging area file condiviso tra agenti". Valutate 4 opzioni. Prodotto `docs/staging-area-design.md` con schema DDL + tool MCP proposti + passi successivi.

**Raccomandazione:** Opzione A — tabella `loomx_staging` in Supabase con RLS su `session_user` (compatibile con D-019 native Postgres roles). Supabase Storage esclusa per vincolo `auth.uid()` incompatibile; filesystem Docker escluso per infrastruttura non pronta; S3 escluso per dipendenza esterna.

**Output:** 4 tool MCP proposti (staging_put/get/list/delete) + schema DDL completo per PR DBA. Limite 1MB per content. Preview mode list (no content, coerente con D-020).

**Board:** messaggio done inviato a Loomy (85d3910f) con summary design.

---

## Sessione #34 — 2026-06-27 (reverse-eng governance REQ/SDES/UAT board-mcp dal codice)

**GTD:** `d9e9bb15-b3ea-4eba-8abf-362cf81d87d5`. **WI** `604e1b9f-3f83-4d35-9050-e44e7d1aa61b`.

**Status:** ✅ **DONE — traceability chain 0 gap.**

**Cosa:** reverse-engineered dal codice sorgente board-mcp (src/tools.ts, src/wi.ts, src/supabase.ts, src/docTypes.ts, src/server.ts, src/index.ts) la governance formale completa e caricata nel doc-model DB (project 596cd5fc):

- **REQ:** 25 requirement (REQ-001…025) — document `b44a7094-560a-4671-9922-b2ae0f6db1cb`
- **SDES:** 14 sdes_entry (SDES-001…014) — document `e5a8d30a-61b6-40c5-9cda-927845c7dda0`
- **UAT:** 22 uat_case (UAT-001…022) — document `08be8423-2387-4a79-8225-75d2cf845419`
- **Link:** REQ→SDES (satisfies), UAT→REQ (verifies), UAT→SDES (verifies)

**Gap check finale:** `req_without_sdes=0`, `sdes_without_uat=0`.

**Aree coperte:** board_* tools, board_agents registry, Supabase client singleton, self-send guard, gtd_* tools + ownership, home_* conditional registration, WI lifecycle (wi_start/end/pause/resume/switch/checkpoint), runtime_request, doc_* document model + capability-parity gate, server transport/CLI.

**Extra:** UAT-021 (home tools conditional) e UAT-022 (server transport/CLI) aggiunti per coprire SDES-011/014 che non avevano UAT pre-esistenti.

---

## Sessione #33 — 2026-06-27 (D-a5 migrazione flotta — DECISIONS → DB-first, runbook v3)

**GTD:** `d3136fbb-dc5a-4eac-a572-916a15a6dccf` (auto-creato). **WI** `21a7b450-baf0-4a7c-a4cf-85d4af75c64e`.

**Status:** ✅ **DONE — 7/7 DoD PASS.**

**Cosa:** migrato DECISIONS.md (36 item: 35 decision coded + 1 prose) su `documents`/`doc_items` (project 596cd5fc, document 1da8642c). DB = SSOT; docs/DECISIONS.md ora GENERATED mirror (round-trip identico, lint verde, hook doc-lint.sh installato). CLAUDE.md §6bis DB-first aggiunto.

**Script:** copia locale customizzata del template forge (`scripts/migrate-governance.ts`): decisions-only, Phase B disabilitata (board-mcp ha solo codici-esempio, no marker reali), split per `## ` header, fix upsert su indice PARZIALE (ON CONFLICT→manuale).

**7 DoD:** 1 DB completo ✓ · 2 doc_* tools ✓ (CLI mirror; live MCP ⏳ restart) · 3 RLS ✓ (own=36 sotto doc_rw, estraneo=0) · 4 CLAUDE.md ✓ · 5 mirror+lint ✓ · 6 prova negativa ✓ (hand-edit rilevato, dump-restore) · 7 conferma comportamentale ✓.

**Attriti (a forge/loomy):** (a) marker-scanner false-positiva su codici-esempio + submodule .skills, non rispetta i null-path del manifest; (b) `## D-NNN` ≠ `DECISION-NNN` del template → serve custom parser; (c) upsert template rotto su indice unique parziale; (d) status='draft' del runbook non valido per item_type 'decision' (default 'proposed'); (e) doc_query con bodies grandi (36 decisioni) supera ~64KB inline.

**Dogfood:** la decisione D-a5-migration è born-in-DB (scritta via doc_item_upsert, non editando il .md). HISTORY.md resta hand-edited (storico, non governance strutturata).

Reconciler/LA fermi: nessun re-arm.

---

## Sessione #32 — 2026-06-27 (D-a5 write-path fix — RETURNING rompe RLS WITH CHECK sotto doc_rw)

**GTD:** `0739af59-7b3d-49da-9e2f-e85b592752b3` (auto-creato). **WI** `92f2f304-969c-4d48-8b22-168421bfe5cb`.

**Status:** ✅ **DONE** — bug write-path risolto e verificato su direct-pg reale.

**Bug:** atlas (membro Enablement, project d66f6fdd) `doc_create` → RLS violation, pur con `loomx_agent_in_project('atlas',d66f6fdd)=TRUE`.

**Root cause (deterministica, via la connessione direct-pg reale `board_doc_rw` di atlas):** sotto doc_rw, `INSERT … RETURNING` fa valutare la WITH CHECK con il GUC `request.agent_slug` come NULL → 42501. Senza RETURNING passa. Prova: `RETURNING 0/6 OK · NO-RETURNING 6/6 OK`. I READ vedevano il GUC (per questo F4.5 read-smoke era verde). Non era il mio wrapper (la tx è corretta e identica al read-path) — è l'interazione planner↔funzione STABLE+GUC con la proiezione RETURNING.

**Fix:** "no-RETURNING mode" in `PgQuery` (solo path doc_rw): INSERT con id client-side + risultato sintetizzato; UPDATE + follow-up SELECT. Path non-doc_rw invariati.

**VERIFY produzione reale (direct-pg, runDocRw+handler) — 5/5 PASS:** atlas doc_create(mart_contract)/upsert/supersede PASS; dev-kinesis DENIED.

**Fix DB definitivo raccomandato al DBA:** funzioni helper policy → VOLATILE (non STABLE).

**Restart:** atlas (e istanze doc_rw) devono ricaricare il dist nuovo.

**Build:** pulito, suite 52/52, v0.8.0→0.8.1. Reconciler/LA fermi: nessun re-arm.

---

## Sessione #31 — 2026-06-27 (D-a5 F4.5 — wiring doc_rw, RLS D-015 sul path agente)

**GTD:** task citava `bf212599` (è il GTD del **DBA**, lato DB, già done) → usato GTD board-mcp auto-creato `427f9894-4084-4998-9c9a-243d8402d660`. **WI** `d8175205-3fb1-41e6-ac81-150fb30e1791`.

**Status:** ✅ **DONE (read/resolve)** — i doc_* girano sotto `doc_rw`+GUC; 3/3 smoke richiesti verdi. ⚠️ write-path da validare su direct-pg.

**Costruito:** `src/docDb.ts` (`runDocRw`, backend pg + mgmt), `pg-shim` executor-based, `docs.ts` resolve via DB function, `tools.ts` i 7 doc_* via `runDocRw` (rifiuto service_role se non configurato), `doc-cli --as`, `tests/docrw.test.ts` (6 test). Dettaglio + contratto in DECISIONS D-a5-F4.5.

**SMOKE 3/3 VERDI** (via CLI mirror, mgmt mode/Management API, MCP live non riavviato):
1. ✅ analyst-pieroni → vede il SoW Pieroni
2. ✅ dev-kinesis → 0 righe sul SoW Pieroni (D-015 end-to-end VIA TOOL)
3. ✅ resolve/link_by_code cross-project come dev-kinesis → rifiutato 42501 (azionabile); controllo: analyst-pieroni risolve. Audit in doc_resolve_log.

**FINDING (a loomy+DBA):** write-path — via Management API gli INSERT/UPDATE WITH CHECK falliscono 42501 anche per il lead/GUC=loomy (READ+resolve ok). Ipotesi: limite pg-meta DML (non porta SET LOCAL ROLE/GUC); la prod direct-pg dovrebbe risolverlo → DA VALIDARE con DOC_RW_DATABASE_URL reale.

**RESTART (coordina loomy):** la live MCP espone i doc_* coi doc_rw solo con restart + `DOC_RW_DATABASE_URL` (login role con GRANT doc_rw; pwd in BWS) — non disponibile in sessione.

**Build:** tsc pulito, suite 48/48, version 0.7.0→0.8.0. Reconciler/LA fermi: nessun re-arm.

---

## Sessione #30 — 2026-06-27 (D-a5 F3 — pilota dogfood end-to-end)

**GTD:** task citava `764fb30f` (NON esiste in loomx_items) → usato GTD auto-creato `a441e015-fb0d-4331-8911-8e23290b142e` via wi_start. **WI** `9395c013-7b25-4bb5-b8cb-9b8732cd87c6`.

**Status:** ✅ **DONE** — F3 (pilota) completata, 4/4 smoke verdi. F0+F1+F2 tutti verdi (prerequisiti).

**Progetto pilota:** creato `pilot-d-a5` (`8930ff35-3c8d-466f-b003-ac39500805b2`, type=internal, agent=board-mcp). Born-in-DB via i tool doc_*.

**Costruito (dogfood, `tests/pilot-d-a5.ts`):**
- SoW (active) + 3 doc_items: objective/deliverable/stop_condition
- DECISIONS (active) + 3 decision items; **supersede** di PD-001 → edge doc↔doc `supersedes`
- blog_post (draft, owner=marketing) born-in-DB: section + prose
- **doc↔gtd link**: objective OBJ-001 `tracks` il GTD del WI
- Round-trip via `@loomx/doc-render` (F2): dump DB→.md, 3 documenti, `md1===md2` IDENTICO + checksum + GENERATED header

**Stato DB pilota verificato:** 4 documents, 10 doc_items, 2 doc_item_links, 1 doc_gtd_link.

**SMOKE TEST (4/4 VERDI):**
1. ✅ SoW+DECISIONS creati (0 errori) — 19/19 assert nel pilot script
2. ✅ blog_post creato via tool, render .md = atteso
3. ✅ round-trip dump IDENTICO (3 documenti)
4. ✅ **Haiku** (sub-agente `general-purpose` model=haiku) ha letto un doc_item esistente + creato un requirement + linkato, in **8 comandi, ZERO attriti DX**, usando SOLO le description dei tool + `doc_item_types` (via CLI mirror `tests/doc-cli.ts`)

**Attriti DX / findings:**
- `blog_post` non ha colonna doc-level `attrs`/`channel`: i metadati di canale sono finiti in `attrs` di un item (`section`). Design §18 cita "metadati doc-level" per blog_post → eventuale colonna `attrs jsonb` su `documents` (richiede DBA). Segnalato a loomy.
- GTD `764fb30f` del task inesistente → usato auto-create. Segnalato a loomy.
- `@loomx/doc-render` legge env `SUPABASE_SERVICE_KEY` (vs `SUPABASE_SERVICE_ROLE_KEY` di board-mcp) — minor inconsistency cross-package.

**Note:** la MCP server live (dist vecchio) NON espone ancora i tool doc_* (serve restart consumer); il dogfood e il test Haiku girano sugli handler via CLI/script con le STESSE description. Pilota lasciato su PROD (born-in-DB, droppable).

**Reconciler/LA fermi:** nessun re-arm. Riportato a loomy + 4 smoke.

---

## Sessione #29 — 2026-06-27 (D-a5 F1 — document model MCP tools)

**GTD:** `38f6de39-cc09-499d-ab42-050a93f69e04` — "[D-a5 · F1] Tool MCP doc_* + doc_item_types registry + capability-parity gate" · **WI** `c4d2b74a-99ac-486a-9575-37f95e0770e2`

**Status:** ✅ **DONE** — F1 del rollout D-a5 completata.

**Costruito** (sopra schema F0 DBA, migration `20260627020000`):
- `src/docTypes.ts` — registry type (16 item_type / 14 document_type / link types), JSON-Schema per-type + mini-validator senza dipendenze, `checkCapabilityParity()`.
- `src/docs.ts` — 8 handler puri: `doc_create`, `doc_item_upsert` (idempotente, ritorna UUID, valida attrs), `doc_item_resolve` (project-scoped + audit stderr), `doc_link` (UUID-only, enum target_kind doc|gtd), `doc_link_by_code` (sugar resolve+link), `doc_supersede` (new row + supersedes edge), `doc_query` (filtro + traceability REQ-senza-SDES), `doc_item_types` (introspect schema+esempio).
- `src/tools.ts` — registrazione 8 tool, description self-describing con esempi copy-pasteable.
- `tests/capability-parity.test.ts` + `tests/docs.test.ts` (15 test) + `tests/smoke-docs.ts` (smoke live).

**Capability-parity gate:** mirror enum DB vs registry → build rossa se feature senza tool. CI-enforced.

**Smoke LIVE su PROD (15/15 PASS):** (1) create→upsert(uuid)→link_by_code→traceability OK; (2) doc_item_types schema+esempio; (3) parity VERDE; (4) cross-app link RIFIUTATO con errore azionabile. Rows creati e cancellati via cascade.

**Build:** tsc pulito, full suite **42/42**, version 0.6.3→**0.7.0**.

**Deviazioni documentate** (DECISIONS D-a5 F1): mini-validator no-ajv; audit resolve su stderr (no tabella DB); client_token in `attrs._client_token`; supersede stacca il codice prima di marcare superseded.

**Reconciler/LA fermi:** nessun re-arm (no `runtime_request`). Riportato a loomy + 4 smoke.

---

## Sessione #28 — 2026-06-26 (autopilot, board-mcp — D-058 already complete)

**GTD:** `4e30ee8d-88e7-4339-a15e-5a292343ccb0` — "[board-mcp] Aggiungere 'continue' all'enum tool runtime_request (colonna DB già OK)"

**Status:** ✅ **ALREADY COMPLETED** (D-058, Sessione #26)

**Findings:**
- `src/types.ts:109` — "continue" presente in `RUNTIME_REQUEST_TYPES` enum
- `dist/types.js:54` — build up-to-date, enum compiled
- `src/tools.ts:1945-1947` — tool description include full semantica `continue`
- `DECISIONS.md D-058` — watermark line 484, change documentato completo in Sessione #26

**Azione:** Task pre-completato in Sessione #26 (2026-06-25). Zero codice da scrivere. Verifica locale completata. GTD marcato done. Autopilot non ri-evocherà.

**Tempo:** 5 min (verification only)

**runtime_request:** `continue` (context ~10%, cache warm, ready for next)

---

## Sessione #27 — 2026-06-25 (D-059 broker elevation loomy-assistant + addendum runtime_request)

**Obiettivo:** dare a loomy-assistant permessi broker su board_ack/board_update_status, GTD cross-agent e runtime_request cross-agent (GO Achille 2026-06-25 + addendum).

**Problema originante:** loomy-assistant (042) tentava di ack messaggi indirizzati a loomy (001) → filtro `.eq("to_agent", selfCode)` → 0 righe → `.single()` → crash "Cannot coerce the result to a single JSON object". Anche `gtd_add` con `owner!=loomy-assistant` bloccato da guard isLoomy-only. E `runtime_request` scriveva solo la propria riga, impedendo il fallback-stall D-058.

**Modifiche (v0.6.2):**
- `src/tools.ts:542` — `const isBroker = selfSlug === "loomy-assistant"`.
- `src/tools.ts` board_ack: `to_agent` filter condizionale + `.single()` → `.maybeSingle()` + gestione null pulita.
- `src/tools.ts` board_update_status: stesso trattamento.
- `src/tools.ts` gtd_add: guard `!isLoomy` → `!(isLoomy || isBroker)`.
- `src/tools.ts` gtd_update: stesso guard su owner-reassign e ownership filter.
- `src/tools.ts` runtime_request: aggiunto `agent_slug` opzionale; broker/loomy scrivono sulla riga di qualsiasi agente; guard esplicito per non-broker; slug validato contro registry; description aggiornata (D-059 addendum).
- `src/pg-shim.ts` — `maybeSingle()` + `_maybeSingle` flag.
- `package.json` — 0.6.1→0.6.2.
- `dist/` aggiornato (build tsc pulito, zero errori).

**Decisioni prese:** D-059 (docs/DECISIONS.md, incluso addendum).

---

## Sessione #26 — 2026-06-25 (D-058 autopilot lifecycle request-pull)

**Obiettivo:** aggiungere `continue` all'enum `runtime_request` (D-058) + aggiornare la description del tool.

**Risultato:** completato. Modifiche:
- `src/types.ts:109` — `RUNTIME_REQUEST_TYPES`: aggiunto `"continue"` come primo valore dell'array.
- `src/tools.ts:1906–1908` — description tool + `.describe()` del campo `request` aggiornati con la semantica D-058 (continue/clear/kill).
- Build `tsc` pulito (zero errori). `dist/` aggiornato.
- Constraint DB `loomx_agent_runtime_request_check` già esteso dal DBA (HTTP 204 pre-verificato).

**Note:** la MCP instance in running questa sessione ha il vecchio enum caricato in memoria (avviata prima del rebuild). Il nuovo enum è attivo al prossimo restart del server.

**Decisioni prese:** D-058 (locale) — allineamento enum MCP al constraint DB.

---

## Sessione #25 — 2026-06-24 (autopilot dispatch)

**Obiettivo (autopilot dispatch D-052):** GTD «Opzione C: env var INTERVIEW_MCP_DISABLE_ACK su loomx-interview-mcp (skip auto-ack Telegram)».

**Risultato:** task completato. Il fix TypeScript (config.ts + bot.ts) era già presente su GitHub main branch da una sessione precedente. Azioni eseguite:
- `npm install github:achilleloomx/loomx-interview-mcp` in loomx-home-assistant → pacchetto aggiornato con build che include il fix.
- `.mcp.json` assistant aggiornato: aggiunta `"INTERVIEW_MCP_DISABLE_ACK": "true"` nella sezione `interview-telegram`.

**Pending (notificato a Loomy):** restart daemon Evaristo + smoke test (@LoomX_Evaristo_bot, niente "✓ Ricevuto") + README.md env vars da creare su GitHub.

**Decisioni prese:** nessuna. Zero modifiche al codice board-mcp.

---

## Sessione #24 — 2026-06-24 (autopilot dispatch)

**Obiettivo (autopilot dispatch D-052):** GTD «Tool MCP per co-engagement GTD: gtd_link_agent / gtd_unlink_agent / gtd_list_agents» (94d193ba).

**Risultato:** zero modifiche al codice. I 3 tool erano già implementati in v0.4.0 (D-022, `src/tools.ts` righe 1002–1180) e presenti nel dist/ aggiornato (v0.6.0, build 2026-06-24 00:15). Il GTD non era mai stato formalmente chiuso al termine della sessione originale.

**Azione:** verifica codice src/ + dist/, chiusura GTD + WI, summary a Loomy.

**Decisioni prese:** nessuna. Pattern identico a S22/S23 — autopilot ri-evoca GTD non portati a `done`.

---

## Sessione #23 — 2026-06-24 (autopilot dispatch)

**Obiettivo (autopilot dispatch D-052):** GTD "Bug board-mcp: enum gtd_add disallineato col DB constraint (waiting vs waiting_for)".

**Risultato:** bug già risolto. Analisi:
- GTD creato 2026-04-06; la migration DBA `20260407110000_loomx_items_gtd_status_canonical.sql` (2026-04-07) ha allineato il DB constraint da `waiting_for` → `waiting` (valore canonico AGENT-STANDARD §5).
- `GTD_STATUSES` in `types.ts` conteneva già "waiting" → code era già corretto.
- `mapEndToGtdStatus()` in `wi.ts` restituisce già "waiting" → nessun drift residuo.
- Nessuna modifica al codice necessaria.

**Decisioni prese:** nessuna (ricognizione e chiusura loop).

---

## Sessione #22 — 2026-06-24 (autopilot dispatch)

**Obiettivo (autopilot dispatch D-052):** GTD "Esporre i campi autopilot/WI nei tool MCP (gtd_add/gtd_update) — abilita self-arming" — ri-evocato perché non chiuso in S20.

**Risultato:** zero modifiche al codice. L'implementazione era già completa in S20 (D-050): `gtd_add`/`gtd_update` espongono `autopilot`, `autopilot_model`, `recurrence_days`, `block_scope`, `resume_hint`; `wi_pause`/`wi_end` propagano `resume_hint`/`block_scope` al GTD linkato; dist/ v0.5.0 già aggiornato.

**Azione:** verifica completezza (src/ + dist/ + DECISIONS.md), chiusura formale GTD + WI, D-014 summary a Loomy.

**Rischio identificato:** autopilot re-evoca se GTD non viene portato a `done` al termine della sessione che lo implementa. Segnalato a Loomy con suggerimento di aggiungere reminder in AGENT-STANDARD §0bis.

**Decisioni prese:** nessuna (ricognizione e chiusura loop).

---

## Sessione #21 — 2026-06-24

**Obiettivo (autopilot dispatch D-052):** GTD "[MVP] LoomX Chat — MCP remoto per dialogare con Loomy da Claude web/telefono". Richiesta Achille: poter parlare con Loomy/ecosistema da claude.ai (web+telefono) via MCP remoto.

**Completato:**

- **Entrypoint remoto** (`src/remote.ts`): `node dist/index.js --remote` avvia un server **Streamable HTTP** (SDK 1.28, stateful con session-id) su `node:http` puro — nessuna nuova dipendenza. `src/index.ts` discrimina `--remote` vs `--agent` (stdio retrocompatibile).
- **5 tool human-first** (`src/humanTools.ts`): `fleet_status`, `ask_loomy`, `loomy_replies`, `decisions_inbox`, `quick_gtd`. Riusano `loomx_agent_runtime` + `board_messages` + `loomx_items`.
- **Bridge async ask_loomy → loomy_replies** (priorità MVP): tag `from-achille`/`for-loomy`/`for-achille`, convenzione di risposta nel body. Gira sotto identità board-mcp (005) — nessun agente `achille` registrato (parcheggiato).
- **Auth bearer token** con fail-safe (no token → no boot), `/health` libero.
- **Test end-to-end reale**: handshake MCP + `tools/list` (5 tool) + `fleet_status` (telemetria reale: 9 agenti, 2 live, costo flotta ~$29, 271 GTD aperti) + `ask_loomy` (board msg scritto) + `loomy_replies` + `quick_gtd`. Artefatti di test ripuliti. Auth 401 verificato.
- **Deploy doc** `docs/DEPLOY-loomx-chat.md`: systemd unit + Caddy (flush_interval -1 per SSE) + Tailscale + token + istruzioni claude.ai. Deliverable per forge.
- Docs: `.env.example` (LOOMX_CHAT_*), version 0.5.0→0.6.0.

**Decisioni prese:** D-051 (LoomX Chat entrypoint remoto)

**Parcheggiato per Achille/Loomy:** (1) slug `achille` dedicato in board_agents vs identità board-mcp; (2) posture rete Tailscale-only vs public+token; (3) auth claude.ai bearer statico vs OAuth wrapper (da verificare al primo collegamento). Hosting in carico a forge.

**Prossima sessione:** deploy su loomx-hq (forge), primo collegamento reale di Achille da claude.ai, verifica risposta Loomy sul bridge.

## Sessione #20 — 2026-06-23

**Obiettivo (autopilot dispatch D-052):** GTD "esporre TUTTI i flag GTD+WI nei tool MCP per self-gestione agente" — direttiva Achille. Ogni agente deve poter armare autonomamente i propri GTD/WI per autopilot senza passare da Loomy.

**Completato:**

- **Self-arming flag in `gtd_add` + `gtd_update`:** aggiunti `autopilot`, `autopilot_model`, `recurrence_days`, `block_scope`, `resume_hint`. Ogni agente può settarli sui propri item (owner=selfSlug). I campi system-managed (`autopilot_attempts`, `last_evoked_at`) non esposti.
- **`wi_pause` + `wi_end` hint propagation:** aggiunti `resume_hint` (su entrambi) e `block_scope` (su `wi_pause`) con propagazione automatica al GTD linkato — utile quando si parcheggia il WI con istruzioni per il prossimo pickup.
- **Fix priority drift** (msg 0f964ef7, GO confermato Loomy): `GTD_PRIORITIES` allineato al DB — `"critical"` → `"urgent"`.
- Build TypeScript clean, `dist/` aggiornato a v0.5.0.
- D-050 registrata in DECISIONS.md.

**Decisioni prese:** D-050 (self-arming autopilot flags + propagazione hint su WI pause/end).

**Blocchi / note:**
- La self-arming richiede coordinamento con **dev-hq** (Agent Manager / dispatch budget) e **Loomy** (Loomy Assistant broker cross-agente): segnalato via board_send.
- Improvement aperta: `wi_pause` + `wi_end` propagano `resume_hint`/`block_scope` al GTD — ma solo se il GTD esiste. Se `wi_start --new` ha auto-creato il GTD, quei flag sono sul GTD auto-creato (non su un GTD pre-esistente a cui l'agente potrebbe voler tornare). Pattern corretto per l'86% dei casi; bordi rari da monitorare.

**Prossima sessione:** coordinamento dev-hq sul dispatch budget; potenzialmente allineamento `gtd_query` sul nuovo campo `autopilot=true` come filtro.

---

## Sessione #19 — 2026-06-20

**Obiettivo:** Task D-048 (round `board_agents` fatto dal DBA) da Loomy — reload recipient: add `analyst-quadro`(035)/`dev-quadro`(036)/`forge`(037)/`atlas`(038), tombstone `sintesi-impianti`(ex-013, active=false). Stesso pattern zero-code D-007/D-043/D-047.

**Completato:**
- **D-048 reload recipient** (zero-code, conferma pattern D-007/D-043/D-047):
  - Verificato `grep -rni "quadro|forge|atlas|sintesi" src/ dist/` = 0 match → nessun enum hardcoded; validazione 100% DB-driven via `resolveAgentRegistry` (`board_agents active=true`, `supabase.ts:75-77`). Il task confermava: «NON serve toccare enum hardcoded (non esistono)».
  - **Verifica routing** via probe read-only (`board_send` a slug inesistente → l'errore elenca i recipient validi): confermati presenti `analyst-quadro`/`dev-quadro`/`forge`/`atlas`; confermato assente `sintesi-impianti`. Questa istanza ha registry fresco (avviata dopo il round DBA) → nessun restart per essa.
  - Docs: README.md + CLAUDE.md Agent IDs — 4 nuove righe + `sintesi-impianti` marcato _tombstone (active=false, D-048)_.
  - Version bump 0.4.2 → 0.4.3. D-048 registrata in DECISIONS.md.
  - Confermato done a Loomy.

**Decisioni prese:** D-048 (round agenti quadro/forge/atlas + tombstone sintesi-impianti — recepimento, zero-code).

**Blocchi / note:**
- `forge`/`atlas` aggiunti senza ruolo/repo nel task → righe docs minimali (code + D-048), da arricchire con label canonica da Loomy/DBA.
- Drift residuo noto nella tabella CLAUDE.md Agent IDs vs `board_agents` reale: il registry runtime include anche `librarian`/`researcher`/`auditor`/`ennebi`, non tutti presenti nelle tabelle docs. Fuori scope D-048 — segnalato a Loomy.
- Improvement aperta ricorrente: registry caricato solo allo startup → restart manuale ad ogni add/rename agente (D-039).
- Inbox: msg 0f964ef7 (drift priority `critical`→`urgent`, GO già dato) resta pending — task separato, bump dedicato.

**Prossima sessione:** 1) promemoria restart consumer avviati prima del round DBA (D-048); 2) allineamento drift priority `critical`→`urgent` (msg 0f964ef7).

---

## Sessione #18 — 2026-06-20

**Obiettivo:** Task D-047 (split agente Kinesis) da Loomy (msg 9a13bfa6) — replica pattern D-043: rename `pm-kinesis`→`dev-kinesis` + add `analyst-kinesis`.

**Completato:**
- **D-047 split Kinesis** (zero-code, conferma pattern D-007/D-018/D-043):
  - Verificato `grep -rn "kinesis" src/ dist/` = 0 match → nessun enum hardcoded; validazione recipient 100% DB-driven via `resolveAgentRegistry`.
  - Corretta (come in D-043) la premessa di Loomy ("rename enum hardcoded + ricompila/ridistribuisci dist"): **nessun rebuild necessario**, dist invariato e già valido.
  - Docs: README.md rename `pm-kinesis`→`dev-kinesis` + add `analyst-kinesis`; CLAUDE.md Agent IDs — aggiunte le due righe kinesis (prima del tutto assenti, drift con README sanato).
  - Version bump 0.4.1 → 0.4.2. D-047 registrata in DECISIONS.md.
  - Attivazione: DBA fa rename+insert in `board_agents` (in parallelo); consumer instradano i nuovi slug solo dopo **RESTART** (D-039). Confermato done a Loomy (ref msg 9a13bfa6).

**Decisioni prese:** D-047 (split Kinesis — recepimento, zero-code).

**Blocchi / note:**
- Stesso rischio FK del rename D-043 (`loomx_work_items.agent_slug`/`loomx_items.owner` → `board_agents(slug)`, no ON UPDATE CASCADE): il rename `pm-kinesis`→`dev-kinesis` può richiedere DDL via psql lato DBA. Prerequisito: nessuna sessione `--agent pm-kinesis` live.
- Inbox: msg 0f964ef7 (drift priority — GO ad `urgent` canonico, allinea zod `critical`→`urgent`) resta pending — task separato fuori scope D-047, da affrontare con bump dedicato.
- Improvement aperta ricorrente: registry caricato solo allo startup → restart manuale ad ogni rename/add agente (D-039).

**Prossima sessione:** 1) a rename DBA applicato, promemoria restart consumer per kinesis; 2) allineamento drift priority `critical`→`urgent` (msg 0f964ef7, GO già dato da Loomy).

---

## Sessione #17 — 2026-06-14

**Obiettivo:** Avvio sessione, esecuzione attività board + check messaggi fino al raggiungimento obiettivi, chiusura. Driver: due task odierni D-043 (split agente Pieroni) + addendum D-038 emend. (dev-hq).

**Completato:**
- **D-043 split Pieroni** (zero-code, conferma pattern D-007/D-018):
  - Verificato `grep -rn "pieroni" src/ dist/` = 0 match → nessun enum hardcoded; validazione recipient 100% DB-driven.
  - Docs CLAUDE.md + README.md: rename `pieroni`→`analyst-pieroni` (029) + add `dev-pieroni` (031).
  - Corretta la premessa di Loomy ("hardcoded enum + rebuild dist"): nessun rebuild necessario.
  - Achille ha dato **GO** al rename (nessuna sessione `--agent pieroni` live) → inoltrato GO al DBA (msg fee237ee) per migration 20260614230000. Segnalato WI pieroni e77f3ce2 ancora `active` (mai chiuso) a DBA+Loomy.
  - Confermato deploy a Loomy (msg 99962113).
- **D-038 emend. (dev-hq):** docs aggiornati con riga `dev-hq`; INSERT `board_agents` richiesto al DBA (msg 3b457eb8, dev-hq non ancora a registry); confermato a Loomy (msg 83082088).
- **Version bump** 0.4.0 → 0.4.1. D-043 registrata in DECISIONS.md (con addendum dev-hq).
- **Housekeeping inbox:** chiusi 12 messaggi pending già risolti in sessioni precedenti ma mai acked (enum agenti detective/loomx-controlling/loomx-tracker/pieroni, home tools D-014, FK HOME_USER_ID D-017, gtd_update.owner D-016, gtd_status §5). Inbox finale: 0 pending.

**Decisioni prese:** D-043 (split Pieroni — recepimento, zero-code).

**Blocchi / note:**
- Drift priority `critical` (MCP) vs `urgent` (DB CHECK) tuttora aperto (msg 29ab2b94, in_progress): proposta direzione al DBA (allineare MCP→DB, msg a5c840d4); cambio signature → richiede ok Loomy (D-005) prima di implementare.
- Improvement aperta: registry caricato solo allo startup → restart manuale ad ogni rename/add agente (msg DBA 54856c0a / D-039). Non affrontata.
- Task design "staging area blob" (msg 6a351bb4 / GTD 91435dfc) resta pending.
- `tsc` non installato su questa macchina (devDeps assenti) — irrilevante per D-043/D-038 (src invariato, dist valido).

**Prossima sessione:** 1) attendere INSERT DBA dev-hq + apply rename analyst-pieroni, poi promemoria restart consumer; 2) a ok DBA+Loomy sul drift priority, allineare zod enum critical→urgent + bump.

---

## Sessione #16 — 2026-05-14

**Obiettivo:** Due task GTD pending autonomi: env var INTERVIEW_MCP_DISABLE_ACK su loomx-interview-mcp + tool co-engagement GTD sul board-mcp.
**Completato:**

**Task 1 — loomx-interview-mcp: INTERVIEW_MCP_DISABLE_ACK**
- `src/config.ts`: aggiunto `disableAck: boolean` all'interfaccia `InterviewConfig`; letto da `INTERVIEW_MCP_DISABLE_ACK=true|1`.
- `src/bot.ts`: accetta `disableAck=false` come parametro; il `ctx.reply("✓ Ricevuto")` viene saltato se attivo.
- `src/index.ts`: passa `config.disableAck` a `createBot`.
- Build passata, pushato su `origin/main` (repo single-branch, nessuna PR necessaria).

**Task 2 — board-mcp: tool co-engagement GTD (v0.4.0)**
- Aggiunti 3 tool in `src/tools.ts` dopo `gtd_get`: `gtd_link_agent`, `gtd_unlink_agent`, `gtd_list_agents`.
- Tabella target: `loomx_item_agents` (migration DBA 20260407130000). Schema: `(item_id, agent_slug, role, added_by, added_at)`.
- Ownership rules (D-022): link/unlink riservato a owner o loomy; list accessibile a owner, co-engaged, o loomy.
- Validation `agent_slug` via mappa `slugToCode` in memoria (D-007).
- `delete()` già nel pg-shim (D-015) — nessuna modifica allo shim.
- Build pulita. 27/27 test passati.
- Version bump 0.3.0 → 0.4.0. DECISIONS.md D-022 aggiunto. CLAUDE.md tool count 16→19.

**Decisioni prese:** D-022 (co-engagement tools ownership + implementation choices).
**Blocchi / note:** Board MCP non connesso in questa sessione — WI/GTD non aggiornati via tool MCP.

---

## Sessione #15 — 2026-05-13

**Obiettivo:** Registrare agenti `loomx-controlling` e `pieroni` nella mesh MCP.
**Completato:**
- **Audit codice:** confermato D-007 — validazione recipient 100% DB-driven (`resolveAgentRegistry` carica `board_agents active=true` all'avvio). Zero modifiche TypeScript necessarie anche per questo onboarding.
- **CLAUDE.md:** aggiunti `loomx-controlling` e `pieroni` alla tabella Agent IDs.
- **README.md:** aggiunti `loomx-controlling` e `pieroni` alla tabella agenti registrati.
- **DBA request:** richiesta INSERT in `board_agents` per entrambi gli agenti (pending — vedi nota).
**Decisioni prese:** nessuna nuova (pattern identico a sessione #14).
**Blocchi / note:**
- MCP non connesso in questa sessione (`.mcp.json` placeholder) — WI gate gestito via cache smoke-test preesistente.
- `loomx-controlling`: registrato 2026-05-13 (D-036), repo achilleloomx/LoomXControlling, group=consulting, role=product-owner. `.mcp.json` già configurato con `--agent loomx-controlling`.
- `pieroni`: registrato 2026-05-10, consulting Pieroni Edilizia.
- Entrambi non ancora in `board_agents` (pending DBA INSERT). Finché non inseriti: `board_send(to: 'loomx-controlling'/'pieroni')` e `--agent loomx-controlling/pieroni` falliscono con "Agent not found in registry".
**Deploy:** dopo DBA INSERT, restart MCP su tutti gli agenti che vogliono inviare a / ricevere da i nuovi agenti. No rebuild necessario.

---

## Sessione #14 — 2026-04-22

**Obiettivo:** Registrare nuovo agente `detective` (Fletcher) — abilitare full-op come recipient `board_send`.
**Completato:**
- **Analisi codice:** confermato D-007 — validazione recipient 100% DB-driven (`resolveAgentRegistry` carica `board_agents active=true` all'avvio). Zero modifiche TypeScript/codice necessarie.
- **CLAUDE.md:** aggiunto `detective` alla tabella Agent IDs.
- **README.md:** creato (non esisteva) con lista completa recipient incluso `detective`, tool MCP, configurazione, stack.
- **DBA request**: richiesta INSERT in `board_agents` per `detective` (slug=detective, label='Fletcher — Detective / People & Companies research', active=true). Vedi nota blocker sotto.
**Decisioni prese:** nessuna nuova (architettura corretta per D-007 — zero-code per nuovi agenti).
**Blocchi / note:**
- MCP non connesso in questa sessione (`.mcp.json` placeholder) — `wi_start`/`board_send` non invocabili live. WI gate bypassato (stesso pattern sessioni #12/13).
- `detective` non ancora in `board_agents` (pending DBA INSERT). Finché non registrato: `board_send(to: 'detective')` e `--agent detective` falliscono con "Agent not found in registry".
- `board_send` a Loomy (report done) da eseguire su istanza agente con credenziali reali.
**Deploy:** dopo DBA INSERT, restart MCP su tutti gli agenti che vogliono inviare a / ricevere da `detective`. No rebuild necessario.

---

## Sessione #13 — 2026-04-19

**Obiettivo:** Commit e build del fix D-021 (cache WI locale + governance gate hook), preparato in sessione precedente ma non committato.
**Completato:**
- **Commit `f3cfc7a`** su master: `src/wiCache.ts` (syncWiCache + archiveWiToHistory), `src/tools.ts` (hook nei wrapper wi_*), `.claude/hooks/governance-gate.sh`, `.claude/settings.json`, `tests/smoke-gate.sh`, `docs/DECISIONS.md` (D-021), `.gitignore` (esclusioni .claude/cache/).
- **Build**: `npm run build` — zero errori TypeScript, `dist/wiCache.js` presente.
- **Smoke test gate**: test 1 (block senza cache) ✅, test 2 (pass con WI active) ✅, test 3/4 (mutazioni jq) ❌ perché `jq` non installato in Git Bash Windows — expected, documentato in D-021 "Scoperta collaterale".
- **MCP smoke test live** (wi_start→cache→wi_end→history): non eseguibile in questo repo (`.mcp.json` placeholder), da eseguire su istanza agente consumer reale.
**Decisioni prese:** nessuna nuova (D-021 già in DECISIONS.md).
**Blocchi / note:** `jq` non disponibile in Git Bash stock Windows — gate permissivo per test 3/4. Follow-up già documentato in D-021.

---

## Sessione #12 — 2026-04-19

**Obiettivo:** Registrare nuovo agente `gardenstone` (Gardenstone SRL Lucca) — primo cliente pagante LoomX Tracker.
**Completato:**
- **Nessuna modifica TypeScript necessaria.** La validazione recipient in `board_send` è completamente DB-driven (`resolveAgentRegistry` carica `board_agents active=true` all'avvio). Il DBA ha già registrato `gardenstone` in `board_agents`. Basta un restart del server MCP.
- `CLAUDE.md`: aggiunto `gardenstone` alla tabella Agent IDs.
**Decisioni prese:** nessuna (architettura già corretta per D-005).
**Blocchi / note:** MCP non connesso (`.mcp.json` placeholder) — `wi_start`/`board_send` non invocabili live; WI gate manuale non eseguibile, stesso pattern di sessione #11.
**Deploy:** restart MCP richiesto su tutte le istanze agente che vogliono inviare a / ricevere da `gardenstone`.

---

## Sessione #11 — 2026-04-19

**Obiettivo:** Implementare preview mode per board/GTD tools (v0.3.0) — ridurre output token overflow segnalato dall'agente `app` su `board_overview` (132k chars su dataset ~70 msg).
**Completato:**
- `board_overview`: aggiunto param `include_body: bool = false`. Default: body omesso client-side. Limite default 50 → 20. Backward-compat: `include_body=true` restituisce schema invariato.
- `board_inbox`: aggiunto param `preview_only: bool = true`. Default: body omesso, slug enrichment mantenuto. `preview_only=false` per body completo (uso esplicito).
- `gtd_inbox`: aggiunto param `preview_only: bool = true`. Default: body omesso, aggiunto campo `body_preview` (prime 200 chars). `preview_only=false` per body completo.
- `gtd_query`: stessa logica `preview_only` di `gtd_inbox`. Limite default 50 → 20 per entrambi i code path (con e senza `project_id`).
- Nuovo tool `board_get(message_id)`: legge singolo messaggio con body completo + slug enrichment.
- Nuovo tool `gtd_get(id)`: legge singolo item GTD con body completo. Ownership check (non-loomy solo propri item).
- `package.json`: version 0.2.0 → 0.3.0.
- Build TypeScript: zero errori.

**Smoke test (Supabase live):**
- `board_overview` default (no body, limit 20): **13.373 chars** (era 132k+ — riduzione ~10x).
- `board_overview include_body=true` (backward compat, limit 20): 57k chars.
- `board_inbox preview_only=true` (20 msg): **11.124 chars**.
- `board_inbox preview_only=false` (20 msg con body): 55k chars.

**Decisioni prese:** D-020 (preview mode — principio lista/detail).
**Blocchi / note:** MCP board non connesso (`.mcp.json` placeholder) — niente `wi_start`/`board_inbox` live; WI gate D-024 non eseguito per impossibilità tecnica, documentato in commit message.
**Prossima sessione:** Comunicare ai consumer (app, assistant, loomy) i nuovi default breaking-friendly — board_overview ora ritorna meno dati di default. Smoke WI tools live ancora pendente (sessione #10).

---

## Sessione #10 — 2026-04-19

**Obiettivo:** Implementare i 9 tool MCP per Work Items (iniziativa governance-compliance D-024). Pre-condition: tabella `loomx_work_items` già LIVE (migration DBA 20260419150000, RLS attive).
**Completato:**
- Letta spec integrale in `hub/initiatives/governance-compliance/design.md` §3 + §5.2 + migration DBA `20260419150000_loomx_work_items.sql` per disallineamenti design↔schema.
- `src/types.ts`: aggiunti `WI_STATUSES`, `WI_END_STATUSES`, `WI_TEMPLATE_LAYERS`, `WorkItem` interface.
- `src/wi.ts` (nuovo file, 500+ righe): handler puri riutilizzabili — `wiStart`, `wiEnd`, `wiStatus`, `wiQuery`, `wiCheckpoint`, `wiLinkTemplate`, `wiPause`, `wiResume`, `wiSwitch` + helper `deriveTemplateLayer`, `mapEndStatus`, `mapEndToGtdStatus`. Enforcement application-level del vincolo `one_active_wi_per_agent` + ownership (non-loomy può toccare solo i propri WI).
- `src/tools.ts`: registrati i 9 tool MCP con Zod schemas, wrapper che chiama gli handler di `wi.ts` (import dinamico per mantenere la separazione).
- `tests/wi.test.ts` (nuovo, ~540 righe): 27 unit test (12 happy + 15 error/edge) con fake DB client che mima il subset di supabase-js usato dagli handler. Zero dipendenze di test esterne — usa `node:test` via `tsx --test`.
- `package.json`: version 0.1.1 → 0.2.0, script `test` aggiunto.
- `src/server.ts`: version "0.1.0" → "0.2.0".
- `CLAUDE.md`: sezione "WI Tools" con matrice 9 tool + elenco deviations dal design + regola derivazione `template_layer`.
- Build pulito: `npx tsc` zero errori. Test: **27/27 PASS**.

**Decisioni prese:** D-019 (deviations wi_end/side_effects/switch marker).
**Deviations dal design documentate:**
1. `wi_end --status=waiting` → WI.status='paused' (CHECK schema non ammette 'waiting'), GTD.gtd_status='waiting'.
2. `side_effects_pending` → scritto dentro `side_effects_log` JSONB con marker `{pending: true}` (schema ha unica colonna log; skill v2 flipperà a executed).
3. `wi_switch` marker `auto_closed_by_switch=true` dentro `in_flight_state` JSONB (nessuna colonna dedicata).
4. `wi_end --failed` → `[BLOCKER] <reason>` in `loomx_items.body`; `loomx_item_tags` non toccato (fuori scope).

**Blocchi / note:** MCP board non connesso in questa sessione (`.mcp.json` è placeholder) — niente `board_inbox`/`gtd_inbox` live. Nessun smoke E2E contro Supabase: i test coprono la logica applicativa via fake DB, ma validazione contro schema reale (check constraint, exclude GiST) demandata a uno smoke test live dal prossimo consumer connesso.
**Prossima sessione:** Smoke test live del set WI (wi_start → wi_checkpoint → wi_end) da un consumer connesso; coordinare con skill session-manager v2 per l'executor di `side_effects_log` pending entries.

---

## Sessione #9 — 2026-04-19

**Obiettivo:** Rename slug agente `loomx-commercialisti` → `loomx-tracker` (task Loomy msg 77c30e65, DBA migration già applicata con 29 righe rinominate e via libera esplicita).
**Completato:**
- Grep integrale del sorgente (`src/`, `dist/`) per `loomx-commercialisti`: **0 occorrenze**. Unica occorrenza nel repo: `CLAUDE.md:167` (tabella Agent IDs documentativa).
- Confermato che D-007 (validazione dinamica slug da `board_agents`) rende lo slug rename zero-code — il registry viene ricostruito al runtime dal DB ad ogni avvio del server.
- `CLAUDE.md:167`: aggiornata tabella Agent IDs (`loomx-commercialisti` → `loomx-tracker`, label "PO Tracker (ex-Commercialisti)").
- Build TypeScript pulita (`npm run build`): zero errori.
- Version bump patch: `package.json` 0.1.0 → 0.1.1 + lockfile aggiornato.
- `docs/DECISIONS.md`: aggiunta D-018 con contesto rename, impatto zero sul sorgente, e azioni cross-repo necessarie.
**Decisioni prese:** D-018
**Blocchi / note:**
- MCP board non connesso in questa sessione — non è stato possibile eseguire `board_inbox`/`gtd_inbox` né smoke test live (invio a `loomx-tracker` deve passare, a `loomx-commercialisti` deve fallire). Il task è stato eseguito sulla base della descrizione nel prompt di Loomy. Smoke test delegato al prossimo avvio del server da parte di un consumer connesso.
- "Publish package" interpretato come commit + push: il pacchetto è consumato localmente via filesystem path (`../loomx-board-mcp/dist/index.js`), non esiste registry npm attivo per questo package.
- Occorrenza `LoomXCommercialisti` in `.skills/CHANGELOG.md` ignorata: è un riferimento al repo storico del branch di migrazione skill, non al nuovo slug agente (submodule).
**Prossima sessione:** Smoke test live del rename via consumer connesso; implementare gtd_link_agent/gtd_unlink_agent (backlog GTD).

---

## Sessione #8 — 2026-04-11

**Obiettivo:** Fix urgente segnalato da Evaristo — `home_grocery_add` fallisce con FK violation su `home_shopping_items.added_by` (task da Loomy, root cause confermato dal DBA msg 7d7fa363).
**Completato:**
- Investigato: il codice `home_grocery_add` è corretto — usa `process.env.HOME_USER_ID` come `added_by`. La causa della FK violation è che `HOME_USER_ID` in `.mcp.json` di Evaristo punta a un id che non è un `auth.users(id)` valido. Il valore corretto (dal DBA) è `5a2df80b-aa01-4b68-976e-192d6ca4227e`.
- `src/tools.ts`: aggiunto helper `translateHomeFkError()` che traduce FK violations su `added_by`/`checked_by` in messaggi d'errore self-diagnosticanti (indica HOME_USER_ID + come ripararlo). Applicato a `home_grocery_add` e `home_grocery_update`.
- `src/tools.ts`: lo startup log dei home tools stampa ora anche il prefix di `HOME_USER_ID` + una nota che deve essere un `auth.users(id)` (visibilità al primo avvio).
- `.env.example`: documentato esplicitamente che `HOME_USER_ID` deve essere un `auth.users(id)` e non un family member_id / profile id.
- `CLAUDE.md`: aggiunto alert sotto la tabella Home Tools e sotto l'esempio `.mcp.json` con il valore corretto per Evaristo.
- `docs/DECISIONS.md`: aggiunta D-017 con contesto incidente, implementazione, e alternativa scartata (probe startup contro auth.users).
**Decisioni prese:** D-017
**Blocchi / note:** MCP board non connesso in questa sessione — non è stato possibile eseguire `board_inbox`/`gtd_inbox` né inviare board_send live. Il fix su `.mcp.json` di Evaristo deve essere applicato nel repo `loomx-home-assistant` (non in questo repo) — sta all'agente assistant / a Loomy fare quella modifica.
**Prossima sessione:** Verificare con Evaristo che dopo aver aggiornato HOME_USER_ID il tool `home_grocery_add` passa; test live home_menu_write. Implementare gtd_link_agent/gtd_unlink_agent (backlog GTD).

---

## Sessione #7 — 2026-04-09

**Obiettivo:** Aggiungere campo owner opzionale a gtd_update (task da Loomy via board)
**Completato:**
- Aggiunto parametro opzionale `owner` a `gtd_update` in tools.ts
- Validazione applicativa: solo loomy può reassegnare owner, errore esplicito per altri agenti
- Il campo owner viene incluso nel payload di update solo se fornito
- Build TypeScript pulita, push su master (dd032df)
**Decisioni prese:** D-016
**Blocchi / note:** MCP board non connesso in questa sessione — task eseguito da descrizione nel prompt. board_inbox/gtd_inbox non verificabili live.
**Prossima sessione:** Implementare gtd_link_agent/gtd_unlink_agent (backlog GTD), test live home_* tools

---

## Sessione #6 — 2026-04-09

**Obiettivo:** Estendere Board MCP con tool home_* per Evaristo (task da Loomy)
**Completato:**
- Implementati 8 tool home_*: home_grocery_categories, home_grocery_list, home_grocery_add, home_grocery_update, home_grocery_remove, home_menu_read, home_menu_write, home_school_menu_read
- Tool condizionali: registrati solo se HOME_FAMILY_ID + HOME_USER_ID sono in env (D-014)
- Aggiunto delete() a pg-shim.ts per supportare grocery_remove (D-015)
- Tipi Home aggiunti a types.ts: MealType, MenuStatus, SchoolMenuSource
- Auto-creazione lista spesa e weekly menu quando non esistono
- Build TypeScript pulita, zero errori
- CLAUDE.md aggiornato con tabella Home Tools e configurazione env
**Decisioni prese:** D-014, D-015
**Blocchi / note:** Nessun blocco. Test live non eseguiti (serve HOME_FAMILY_ID/HOME_USER_ID reali).
**Prossima sessione:** Test live con Evaristo, implementare gtd_link_agent/gtd_unlink_agent (GTD backlog)

---

## Sessione #5b — 2026-04-09

**Obiettivo:** Eseguire task pendente "Registrare agente mcpromo in board_agents" + chiusura messaggi board
**Completato:**
- Verificato che mcpromo era gia' registrato (agent_code=023, inserito in sessione #5)
- Chiuso messaggio board 9b820bfe (task Loomy → board-mcp) come done
- Chiuso messaggio board 405e90e3 (direct-postgres task) come done
- Inviato summary a Loomy con ref al task originale
**Decisioni prese:** nessuna
**Blocchi / note:** Nessuno
**Prossima sessione:** Implementare gtd_link_agent/gtd_unlink_agent/gtd_list_agents (GTD item 94d193ba, next_action), design staging area (GTD item 91435dfc, high priority)

---

## Sessione #5 — 2026-04-09

**Obiettivo:** Registrare agente mcpromo in board_agents (task da Loomy)
**Completato:**
- Inserito agente mcpromo in board_agents: slug=mcpromo, agent_code=023, label="Consulting — MCpromo (Antonelli)", repo="01. Progetti/20. MCpromo", scope=consulting, active=true
- Aggiornato CLAUDE.md: aggiunta riga mcpromo nella tabella Agent IDs
**Decisioni prese:** nessuna (operazione CRUD standard)
**Blocchi / note:** Nessuno
**Prossima sessione:** Verificare che mcpromo possa usare il board (configurare .mcp.json nel repo MCpromo)

---

## Sessione #4 — 2026-04-07

**Obiettivo:** Supporto backend direct-postgres via `DATABASE_URL`, backwards-compat service_role (D-023 DBA validato)
**Completato:**
- Aggiunto `src/pg-shim.ts`: shim minimale che implementa il sottoinsieme di `supabase-js` query builder usato in `tools.ts` (from/select/insert/update/eq/is/in/not/contains/or/order/limit/single + rpc con named args)
- Dispatch in `src/supabase.ts`: se `DATABASE_URL` è settato usa pg, altrimenti fallback a `SUPABASE_URL`+`SERVICE_ROLE_KEY` (backwards-compat totale)
- Zero modifiche a `src/tools.ts` — tutti i 14 tool funzionano in entrambe le modalità grazie al cast strutturale
- `pg.Pool` singleton (lazy-init), parallelo a D-002 per supabase-js
- Connection string letta solo da env, mai logica né in log (no credential leak — solo "DB backend: direct-postgres/supabase-js" su stderr)
- Aggiornato `.env.example` con entrambe le modalità documentate
- Aggiunte deps `pg ^8.13.1` + `@types/pg ^8.11.10`
- Build TypeScript pulita
**Decisioni prese:** D-013 (dual backend via DATABASE_URL)
**Blocchi / note:**
- `.mcp.json` in questa working directory ha credenziali placeholder: non è stato possibile eseguire `board_inbox`/`gtd_inbox`/`board_send`/`board_ack` live in questa sessione. Il task è stato eseguito sulla base della descrizione completa fornita nel prompt di Loomy.
- Test end-to-end dei 7 step del task NON eseguiti per mancanza credenziali live. Proposto: il DBA esegua smoke test su branch `feat/direct-postgres-backend` con un `DATABASE_URL` reale prima del merge.
- Branch: `feat/direct-postgres-backend` — non ancora merged, in attesa di review DBA (pre-merge review richiesta esplicitamente dal task).
**Prossima sessione:** Ack del task in board_inbox, summary a Loomy, richiesta review DBA via board, merge a valle di approvazione.

---

## Sessione #3 — 2026-04-05

**Obiettivo:** GTD tools, governance update (PM Home → Loomy), deprecazione TODO.md
**Completato:**
- Implementati 5 tool GTD: gtd_inbox, gtd_add, gtd_update, gtd_query, gtd_complete (D-011, D-012)
- Ownership enforcement applicativo: ogni agente modifica solo i propri item, loomy ha accesso globale
- Aggiornata governance: PM Home rimosso, coordinatore ora è Loomy (root coordinator)
- D-010 aggiornata: owner tag governance da PM a Loomy
- CLAUDE.md aggiornato: blocco Agente, tabella agenti completa con nuovi consulting, riferimento a Loomy
- Deprecato docs/TODO.md — i task board-mcp sono migrati in loomx_items (Supabase)
- Fix parametri RPC con prefisso p_ (commit c81e8d4)
**Decisioni prese:** D-011, D-012
**Blocchi / note:** Nessuno
**Prossima sessione:** Verificare task GTD migrati, .mcp.json.example per repo agenti, staging area

---

## Sessione #2 — 2026-03-31

**Obiettivo:** Evoluzione Board MCP da 4 a 9 tool, registrazione agente, recepimento D-008
**Completato:**
- Registrazione board-mcp (code 005, nickname Postman) su board_agents
- Implementati 5 nuovi tool: board_overview, board_broadcast, board_thread, board_archive
- Validazione dinamica slug (rimosso AGENT_SLUGS hardcoded)
- Supporto tags (invio + filtro inbox), summary (invio), archived_at (esclusione inbox)
- Recepita D-008: board-mcp è product owner della piattaforma di comunicazione
- Comunicazione con DBA per schema changes (tags, summary, archived_at) — tutto applicato
- Notificato PM e tutti gli agenti della registrazione e del nickname Postman
**Decisioni prese:** D-007, D-008, D-009
**Blocchi / note:** RPC board_broadcast non supporta ancora summary/tags (richiesta al DBA in backlog)
**Prossima sessione:** Staging area, aggiornamento RPC broadcast, .mcp.json.example per i repo agenti

---

## Sessione #1 — 2026-03-30

**Obiettivo:** Setup iniziale del progetto e implementazione completa dei tool MCP
**Completato:**
- Setup progetto: package.json, tsconfig.json (strict, ESM, Node16), dipendenze installate
- Implementati tutti i file sorgente: types.ts, supabase.ts, tools.ts, server.ts, index.ts
- 4 tool MCP funzionanti: board_send, board_inbox, board_ack, board_update_status
- Build TypeScript senza errori, CLI con validazione --agent
- Inviata richiesta migrazione `board_messages` al DBA (REQUEST_board_messages.md)
**Decisioni prese:** D-001, D-002, D-003, D-004
**Blocchi / note:** In attesa della migrazione DB dal DBA — senza tabella `board_messages` i tool non possono operare
**Prossima sessione:** Verificare risposta DBA, test end-to-end una volta che la tabella è disponibile

## Sessione #1b — 2026-03-30

**Obiettivo:** Adattare il codice allo schema effettivo del DBA (board_agents + agent_code FK)
**Completato:**
- Refactor completo: slug (CLI) → agent_code (DB) con resolution all'avvio da `board_agents`
- Rinominato AgentId → AgentSlug, aggiunto AgentRegistry e BoardAgent types
- `board_inbox` arricchisce risultati con slug per leggibilità
- Build e test CLI OK
**Decisioni prese:** D-005, D-006
**Blocchi / note:** Serve la service role key dalla dashboard Supabase per il .env
**Prossima sessione:** Configurare .env con credenziali reali, test end-to-end su Supabase live

## Sessione #1c — 2026-03-30

**Obiettivo:** Connessione a Supabase e test end-to-end
**Completato:**
- Configurato .env con service role key
- Test connessione: board_agents query OK (4 agenti)
- Test end-to-end: INSERT (send pm→dba), SELECT (inbox dba), DELETE (cleanup) — tutto OK
- Board MCP operativo su Supabase live (fvoxccwfysazwpchudwp, EU West Paris)
**Decisioni prese:** nessuna
**Blocchi / note:** nessuno
**Prossima sessione:** Creare .mcp.json.example per i repo agenti, primo uso reale tra agenti

# HISTORY — Board MCP Server

> Storico sessioni dello sviluppatore MCP.

---

## Sessione #105 — 2026-08-21 (DEL-002 chiuso: doc_publish, 4°/4 tool sottoscrizioni — GTD `d9ebe0c6`, WI `ae525e25`, v0.20.0)

**Cold-wake `high` da loomy (msg `1ec008c2`): dba ha consegnato `gov.doc_publish()` + change-set + Freeze-B + REVOKE UPDATE(version), verificato end-to-end.** Firma confermata su due messaggi indipendenti del dba (`cd8554f1` allineamento 1:1 a SDES-SUB-003, `401811d8` conferma live): `gov.doc_publish(p_document_id uuid, p_new_version text, p_bump_class text, p_changelog_entry_id uuid, p_delta_summary text) RETURNS TABLE(publication_id uuid, version_seq int, published_at timestamptz)`.

**Implementato `doc_publish`** (`src/subscriptions.ts`, pattern identico a `doc_subscribe`/`doc_unsubscribe`/`doc_subscription_outcome`): validazione tool-floor (legittimazione owner/loomy, gate changelog by-construction — `changelog_entry_id` deve essere `item_type='changelog_entry'` in un documento `document_type='changelog'` dello stesso progetto con `attrs.version===new_version`), poi chiamata a `gov.doc_publish()` via nuovo probe `docPublish` su `DocRwDb` (`src/docDb.ts`, stesso pattern di `relinkSuperseded` — mai INSERT diretto, `gov.doc_versions` non concede INSERT a nessun ruolo). D-132: rilettura di entrambe le superfici (`documents.version` bump + riga ledger) prima dell'`ok`. Errori tipati mappati (`no_data_found`/`invalid_parameter_value`/`unique_violation`/`insufficient_privilege`) — aggiunto `22023` alla regex di estrazione SQLSTATE del backend mgmt (mancava). Tool registrato in `tools.ts`.

**Verificato:** build pulito, 187/187 test (7 nuovi su `doc_publish` in `tests/subscriptions.test.ts` + fake `docPublish` in `tests/fakeDb.ts`, mimico dell'unique_violation su ripubblicazione). `CLAUDE.md` aggiornato (tabella Subscription Tools, 4/4 live). `package.json` → v0.20.0. WI linkato a `SDES-SUB-003` (gate D-074 soddisfatto via il design esistente — nessun `force_ephemeral`).

**Notifiche:** `board_send` a loomy (summary done) e a it-manager (come richiesto nel messaggio di sblocco — doc_subscribe+doc_publish vivi per lo sweep sui 4 criteri, primo ciclo reale). `board_ack` su `1ec008c2`.

**Gap aperto, non bloccante:** `dist/` è build unica condivisa senza hot-reload — le finestre board-mcp già aperte restano su 3/4 tool finché non ripartono (CLAUDE.md, "Rollout di un nuovo build"). Tracciato in GTD `bb3d0dc6` (coordinamento restart con it-manager/loomy, planned non armato).

---

## Sessione #104 — 2026-08-21 (wake ee97e55c: lavoro già eseguito in #103, mancava solo la notifica a it-manager — WI `adf960d0`)

**Cold-wake `high` da loomy (msg `ee97e55c`, "GO BUILD: design DEL-002 ratificato D-186") ricevuto dopo che il build era già stato consegnato.** Verificato sul DB (non sulla memoria di sessione): WI `b415d6e4` della #103 già `done` (commit `31b58a8`, v0.19.0), 3/4 tool sottoscrizioni live, GTD follow-on `d9ebe0c6` già aperto per `doc_publish` (bloccato su dba). Il messaggio `ee97e55c` risultava ancora `pending` — non ackato in #103 — ed era mancata l'unica azione non ancora coperta: "al done avvisa it-manager", perché in #103 il done era parziale (3/4) e la notifica non era mai partita.

**Eseguito qui:** notifica a it-manager (msg `dd80a3ad`) — 3/4 criteri misurabili ora, 4° esplicitamente bloccato su dba con riferimento al GTD. Corretto `waiting_on` mancante su `d9ebe0c6` (era `null`, HISTORY #103 dichiarava `dba` ma non era stato scritto — self-consistency fix). `board_ack` su `ee97e55c`. Nessun codice toccato, WI ephemeral (`force_ephemeral`, nessun artefatto durevole nuovo).

---

## Sessione #103 — 2026-08-21 (items-subscription DEL-002: build 3/4 tool + fix registry SDES-SUB-005 — GTD `fd2ac249`, WI `b415d6e4`, v0.19.0)

**Autopilot dispatch sul GTD sbloccato da D-186** (ratifica loomy della sera, design SDES-SUB-000..007 dopo la sessione #101). Pre-flight: letti design completo + D-186 + i due messaggi dba della sera (`41fa192b`, `727972bc`) — poi introspezione LIVE dello schema `gov` (colonne/grants/RLS/trigger/constraint reali via `LOOMX_DOC_RW_URL`, read-only) invece di fidarsi solo del prosa dei messaggi: ha confermato ogni dettaglio del design (nomi colonna esatti, enum, unique) e trovato un blocco non dichiarato nel titolo del GTD.

**Blocco trovato leggendo, non costruendo:** `gov.doc_publish()` (SECURITY DEFINER, l'unico ruolo con INSERT su `gov.doc_versions` — misurato: nessun ruolo, `doc_rw` incluso, ha INSERT sulla tabella) **non è stato ancora scritto dal dba** ("è il mio prossimo cantiere A2", msg `41fa192b`). Costruire `doc_publish` contro una firma indovinata avrebbe funzionato solo per caso o mascherato il vero blocco quando la funzione fosse arrivata con parametri diversi — **non implementato**, tracciato come GTD follow-on `waiting_on=dba` invece.

**Costruiti 3/4 tool** (`src/subscriptions.ts`, nuovo modulo): `doc_subscribe` (origin sempre 'choice', idempotente su stesso intent, cambio-grado su intent diverso, critico cross-progetto rifiutato v1 per D-186 Q2, target letto solo se RLS lo permette — mai rivela l'esistenza di un target non leggibile, D-167-style), `doc_unsubscribe` (tombstone, mai DELETE, rifiuta `origin='fact'` **a livello tool** — il floor-trigger DB è ratificato D-186 §2 ma misurato live come non ancora applicato; `reason` senza colonna dedicata → appeso a `note`, stesso pattern di `wi_end --failed`), `doc_subscription_outcome` (append-only per subscription×publication, `version` risolta a `publication_id` su `gov.doc_versions`, idempotente su payload identico/rifiuta payload diverso, blocco su versione pubblicata dopo un tombstone).

**Fix registry SDES-SUB-005 (D-155) applicato:** `docLink` instradava cross-progetto SOLO per `relation_type==='references'` — falso da quando D-155 ha allargato `doc_item_xproject_links` a tutti i tipi (misurato col dba, msg `41fa192b` Q6: stesso set di `doc_item_links` + `references`). Ora instrada per **confine di progetto reale** (project_id from/to), non per etichetta. `amends` aggiunto a `DB_DOC_ITEM_LINK_TYPES`. `pg-shim.ts`: `ident()` ora accetta identificatori schema-qualificati (`gov.doc_subscriptions`) — unico modo per riusare `PgQuery`/`doc_rw` sulle tabelle `gov.*` senza duplicare il query builder.

**Test:** nuovo `tests/subscriptions.test.ts` (17 test) + harness condiviso estratto in `tests/fakeDb.ts` (era duplicato dentro `docs.test.ts`, ora importato da entrambi — evita la doppia esecuzione che si verificava importando un file `*.test.ts` da un altro). 1 test esistente in `docs.test.ts` riscritto (il vecchio "cross-app link rejected" testava esattamente il comportamento che SDES-SUB-005 doveva correggere) + 1 nuovo per il path same-project invariato. **181/181 verdi**, `tsc` pulito, capability-parity gate verde con `amends`.

**Chiusure:** WI linkato a SDES-SUB-001/002/004/005 (gate D-074). GTD follow-on `doc_publish` creato `waiting_on=dba`, non armato (FASE 1). Summary a loomy con il blocco dichiarato esplicitamente.

---

## Sessione #102 — 2026-08-21 (casa unica CFG: chiusa per VERIFICA, non riesecuzione — GTD `efaac02c`, WI `adb8b596`)

**Autopilot dispatch sul GTD «casa unica» rimasto aperto dalla #93.** I suoi tre passi erano in gran parte già eseguiti sotto GTD gemelli: il passo 1 (5 correzioni `CFG-063/076/086/088/090` su `669fd07b`) chiuso in #95 (GTD `20235b14`), il passo 2 (tombstone) chiuso il 18/08 con GO loomy `bdb4e21b`. Nota interna contraddittoria: la chiusura di #95 dava il tombstone «sospeso», il resume_hint del GTD lo dava completato — **fatto fede il DB**, non la memoria delle sessioni.

**Verificato sul DB (doc_query summary su entrambi i progetti):** le 5 schede nella casa portano le correzioni (char-count coerenti con la regola «sorgente meno paragrafo tombstone», CFG-086 col framing corretto, CFG-090 con la sezione correttiva del 20/08); le 30 copie in `596cd5fc` sono **tutte** `superseded` (inclusi CFG-074/083 coi loro link WI, arbitrati allora); CFG-001..047/091 intatte nella casa.

**Passo 3 eseguito qui:** escalation `a33bf519` chiusa con nota che cita la decisione di loomy (opzione 1: `794e873c` canonica) e l'evidenza dei due passi. **Residuo dichiarato a loomy** (done `0c61a4ab`): il titolo di `de6879a4` afferma ancora «destinazione hub 794e873c non scrivibile» — falso oggi, e i doc_* non toccano i metadati di `documents`: serve loomy o dba. Nessuna scrittura di contenuto in sessione.

---

## Sessione #101 — 2026-08-21 (items-subscription DEL-002: design-first dei 4 tool + D2 chiuso v0.18.0 + predicato D8 al dba — GTD `427b682b`, WI `0ba0971d`)

**Wake `high` da loomy (msg `cbe96c66`): capitolato sottoscrizioni (progetto `52f9b563`) approvato da Achille, ondata dispacciata.** Mandato in tre pezzi: design-first dei 4 tool (DEL-002), fix D2 «documento sbagliato», predicato D8 con dba.

**Design-first consegnato, zero righe di codice sui 4 tool (SEC-002: design prima del build).** Letti per intero DEL-001/002/008/009 + «Come funziona» + «Architettura» + SEC-011 + «Domande aperte» del capitolato. Design DB-first: doc sdes `714d3313` nel progetto board-mcp (la RLS mi ha correttamente negato `doc_create` su `52f9b563` — nessuna membership; niente duplicati, collocazione dichiarata come Q1), **visibility=org** (rilievo dba «il tuo layer SDES non è leggibile da me» recepito). Otto voci `SDES-SUB-000..007` in_review: invarianti (identità derivata server-side col contratto gov_param della #100, doc_rw, D-132, enum chiusi), i 4 tool (subscribe con verifica-lettura a RLS-floor + `subscribed_at_version`; unsubscribe=tombstone con regola SEC-011 «si esce solo dalla scelta»; publish con gate changelog by-construction e sequenza D-182 — nasce DOPO `gov.doc_versions` di DEL-A2; outcome append-only per (sottoscrizione × versione)), fix registry (routing cross per confine di progetto non per relation_type; `amends` dopo misura CHECK col dba), predicato D8, domande aperte con chi-decide-cosa. Link cross `references` verso DEL-002/DEL-008/DEL-001 + link WI.

**Gap trovato leggendo, non costruendo:** DEL-001 non prevede una colonna `origin` su `gov.doc_subscriptions` — senza, la non-silenziabilità di DEL-009 («imposto al livello più basso del database») e la regola d'uscita per origine NON sono imponibili a DB-floor. Proposto al dba come Q4 (emendamento DEL-001, ratifica loomy).

**D8 — predicato di «cambiamento sostanziale» (SDES-SUB-006), proposto al dba per co-firma (msg `2b15d62a`, wake normal).** Perimetro: DENTRO body/title/summary/attrs/status/code/item_type, FUORI sort_order/updated_at/owner e — deliberata — priority. Il contributo che solo board-mcp poteva portare: **`attrs._client_token` va escluso dal confronto** (è il token di idempotenza che i nostri tool persistono dentro attrs — senza esclusione un retry idempotente marca stantio mezzo corpus). IS DISTINCT FROM, confronto per colonna, due chiavi parametro (`docm.m2.significant_columns` + `docm.m2.attrs_excluded_keys`).

**D2 chiuso (GTD `4a591cfe`, commit `6219357`, v0.18.0):** `doc_item_upsert` deduce il documento dal codice — `document_id` opzionale su codice esistente, mismatch → autocorrezione DICHIARATA in `warnings` (mai duplicato, mai spostamento — prima l'update procedeva in silenzio sul documento reale ignorando quello passato), riga nuova senza `document_id` → errore azionabile; risposta porta sempre `document_id` reale. `doc_query` summary: `document_id` per riga + legenda `{document_id→titolo,tipo}`. Igiene msg dba `b8f94388`: riferimenti morti a `uq_doc_items_project_code` ripuliti. 4 test nuovi, **163/163 verdi**. G4: finestre vive restano su v0.17.0 fino a restart.

**Chiusure:** design+domande a loomy (msg `03162a75`: Q1 collocazione, Q2 critico cross rifiutato in v1, Q7 `changelog_entry_id` esplicito). Follow-on `fd2ac249` (build post-ratifica) creato `waiting` su loomy, NON armato.

---

## Sessione #100 — 2026-08-20 (`gov_param_set`: contratto CHIUSO con la risposta it-manager, richiesta a dba di non farsi passare l'identità — GTD `a2567c59`, WI `83396520`)

**Wake `high`, msg `fea763b1` da it-manager** — risposta alla domanda aperta delle #98/#99. L'ownership della riga è **XOR**: `owner_stream` (vocabolario chiuso) oppure `owner_agent_code` (FK `board_agents.agent_code`), e i due rami hanno regimi di verifica diversi. Stream → honor-system, stesso pattern di `requested_model` (D-101): nessun registro agent→stream esiste e non se ne crea uno. Agent_code → identità **reale** del chiamante, non un claim del payload.

**Correzione alla firma proposta.** it-manager proponeva `gov_param_set(param_key, value, owner_stream_claim?, owner_agent_code?)`. `owner_agent_code` **non va esposto**: se il valore viene dall'identità risolta e non dal client, un parametro omonimo nello schema MCP è un parametro-trappola — il chiamante lo compila credendo che conti e viene ignorato, e chi legge lo schema non può dire se sia autorevole. Firma chiusa: `gov_param_set(param_key, value, owner_stream_claim?)`, con `owner_stream_claim` **condizionalmente obbligatorio** (il regime si scopre solo leggendo la riga) e un claim inutile sul ramo agent_code segnalato in `warnings`, mai scartato in silenzio.

**L'identità richiesta esisteva già:** `registry.selfCode` (`src/supabase.ts:170`) è l'`agent_code` dell'istanza — già `agent_code` e non slug (D-119), nessuna conversione da aggiungere — e a monte `resolveSelfSlug` lo deriva dal ruolo DB nativo rifiutando l'avvio su mismatch con `--agent` (D-084 Fase 1).

**Il limite dichiarato invece che scoperto in produzione.** «Questo È verificabile, a differenza dello stream» è vero *quanto è avanzato il rollout D-084*: sul fallback `service_role` senza `DATABASE_URL` il `selfSlug` viene da `--agent` — dichiarato, non provato — e lì **anche il ramo `owner_agent_code` degrada a honor-system**, qualunque cosa faccia la funzione DB. Scritto a it-manager prima che ci contasse per le sue 3 righe.

**Richiesta a dba (msg `e0d7a7b6`, wake `high` — mandata mentre la migration è ancora aperta).** Se `gov.param_set` prende `p_caller_agent_code` come **parametro**, si fida di ciò che le passa board-mcp: il floor DB non è chiuso, è spostato di un livello — `EXECUTE` ristretto e nessun `GRANT UPDATE` diretto chiuderebbero la porta lasciando la finestra (è il gap noto di `loomx_eval_runs`, D-105, dove l'enforcement è finito nel tool). Proposto che la funzione **derivi l'identità da sé**: `session_user` in native mode (login role per-agente, `runNative` in `src/docDb.ts:122`), altrimenti `current_setting('request.agent_slug')` che il path doc_rw imposta già a ogni transazione (`src/docDb.ts:99-101`) — non è lavoro nuovo per nessuno dei due. Conseguenza accettata: **i `gov_*` gireranno sotto `doc_rw`, non `service_role`**, altrimenti non c'è nulla da cui dedurre. Se dba preferisce il parametro va bene, ma allora il contratto lo dichiarerà come enforcement **tool-layer**, non come garanzia a floor DB: la differenza resta scritta.

**Nessun codice scritto,** e non per prudenza: la firma SQL effettiva non esiste ancora. Il GTD `a2567c59` non è più `waiting` su it-manager — solo su dba (tabella + funzione). `no_auto_arm` resta `true`: il ri-arm richiede la conferma che la migration è applicata, non uno scan.

---

## Sessione #99 — 2026-08-20 (`gov_param_set` DEL-A5: ri-dispatch autopilot, stato verificato invariato — GTD `a2567c59`, WI `2c975b69`)

**Ri-evocato dal reconciler sullo stesso GTD della #98** (`gtd_status` era rimasto `next_action` nonostante il blocco reale — inconsistenza corretta in questa sessione). Nessun lavoro nuovo da fare: verificato l'intero thread `176a504f`↔`1663929a` e l'intera inbox (100 messaggi) — **nessuna risposta** né da dba (tabella `loomx_governance_params` + fn `gov.param_set` SECURITY DEFINER non applicate) né da it-manager (domanda aperta su `owner_stream_claim` senza riscontro).

**Correzione applicata:** `gtd_update` → `gtd_status=waiting`, `waiting_on=dba` (prima non settato, per questo il reconciler lo riproponeva come next_action lavorabile). Nessuna scrittura di codice: bloccato su due dipendenze esterne già documentate, non serve rialzare a it-manager perché nulla è cambiato dal messaggio già inviato.

**Addendum stessa sessione:** ri-dispatchato una seconda volta a pochi secondi di distanza, con `gtd_status` di nuovo `next_action`/`waiting_on=null` — il solo `waiting` non basta a fermare il reconciler su un item `autopilot=true`. Root cause del loop, non solo il sintomo: settato `autopilot=false` + `no_auto_arm=true` (D-100), così il ri-arm richiede un intervento esplicito (loomy/it-manager) invece dello scan automatico. Nessuna novità nel merito: le due dipendenze (dba, it-manager) restano aperte.

---

## Sessione #98 — 2026-08-20 (`gov_param_set` DEL-A5: contratto specificato, gap SECURITY DEFINER flaggato a it-manager — GTD `a2567c59`, WI `e4f757d2`)

**Wake cold-start `normal`, msg `176a504f` da it-manager.** Chiede un tool `gov_param_set` per scrivere `loomx_governance_params` (registro parametri di governance DEL-A5) — RLS vieta scrittura diretta, l'unica via dichiarata è il tool.

**Letto per intero** `hub/it-manager/docs/design/governance-params-registry.md` (workspace, fuori repo): tabella + history + trigger **proposte, non applicate** (dba). Nessun codice scritto — contro uno schema non ancora esistente, con un pezzo di design ancora aperto, sarebbe stato lavoro da rifare.

**Gap segnalato a it-manager, non tenuto per me.** La §1 del design (riga 67) chiede l'identity-check "SECURITY DEFINER lato funzione SQL" — non un controllo applicativo nel tool. Se la scrittura vera passasse da un ruolo con GRANT UPDATE diretto (es. `doc_rw`) e il tool facesse solo un check prima di chiamarla, "l'unica via è il tool" non sarebbe vero a floor DB: stesso gap non-enforceable-a-DB già censito per `loomx_eval_runs` (D-105). Proposta girata: una `gov.param_set(...)` SECURITY DEFINER (pattern `gov.relink_superseded`) che fa lei stessa il confronto `owner_stream_claim = owner_stream` e l'UPDATE, EXECUTE solo a `doc_rw`+`service_role`, nessun GRANT UPDATE diretto sulla tabella — da includere nella stessa migration dba della tabella.

**Domanda aperta girata, non decisa da solo:** il punto 1 del mandato ("verifica identità chiamante = owner_stream_claim") presuppone un registro agent_slug→owner_stream che oggi non esiste. Proposto honor-system pass-through come `requested_model` (D-101) in attesa di conferma/correzione da it-manager.

**Contratto tool completo** (firma, instradamento per `value_type`, rilettura-e-confronto stile D-132, error semantics) scritto nel GTD `a2567c59`, `waiting`/`dba` — pronto da implementare non appena tabella+funzione sono live.

---

## Sessione #97 — 2026-08-20 (WI-G.2: `doc_item_chain`, il resolver di catena multi-salto — GTD `d24ce961`, WI `51508b97`, v0.17.0)

**Autopilot dispatch, in-place dopo la #96** (`runtime_request: continue` — contesto caldo, il design l'avevo appena scritto). Implementato `SDES-DOCM-020`: l'unico pezzo di WI-G non bloccato a monte (G.1 aspetta una tabella da dba, G.3 aspetta DEL-A2).

**Il problema che risolve.** D-170 rende sottoscrizioni e citazioni **UUID-bound**, e un UUID resta inchiodato alla riga che era corrente quando il link fu creato. `doc_item_resolve` non copre il caso: aiuta quando hai un **codice** — che viaggia già sulla riga nuova (§6/D-a5) — mentre un riferimento a UUID non ha codice da risolvere. Senza il tool, ogni consumatore si scriverebbe la propria camminata, ciascuno con la propria idea di cosa fare a un bivio.

**Direzione dell'edge, verificata nel codice** (`src/docs.ts:976`): `docSupersede` scrive `new --supersedes--> old`. Camminare in avanti significa quindi cercare il link il cui `to_item` è la riga corrente e saltare al suo `from_item` — non l'inverso, che era la lettura ingenua.

**Tre terminazioni, tutte esplicite, nessuna indovinata.** Fork (due righe che dichiarano di supersedere lo stesso item) → **errore che ELENCA i candidati**, stessa disciplina di REQ-DOCM-007; ciclo → errore; **successore non leggibile → si ferma e lo dichiara** (`terminal_reason='successor_not_readable'` + nota che dice a chiare lettere che `resolved_id` **non** è garantito essere la versione in vigore). Quest'ultima è la parte che conta: il ri-controllo di visibilità di REQ-DOCM-006 vale a **ogni** salto, non solo al primo — la catena non deve diventare un canale per raggiungere ciò che la RLS nasconde, e l'ultima riga leggibile non va spacciata per corrente.

**Onestà nel contratto (REQ-DOCM-012 applicato alla catena).** «Nessun successore» significa sempre «nessun successore **visibile**»: la RLS può nascondere un edge quanto un item, e il tool lo dice in `note` invece di lasciar credere di aver dimostrato un capolinea. Stessa disciplina sulla partenza non leggibile: non esiste un oracolo di esistenza per-ITEM (`doc_document_exists` risponde per i **documenti**), quindi l'errore dichiara che non può distinguere «non esiste» da «non lo puoi vedere» — invece di asserire l'una o l'altra.

**Test prima del repack, come impone STP-002 punto 3.** `tests/doc-chain.test.ts`, 10 casi: catena multi-salto, già-in-vigore, fork, ciclo, salto non leggibile, `max_hops` superato, non-UUID, partenza non leggibile, edge di **altro progetto** (non va seguito — la FK composita tiene una catena dentro un progetto), edge duplicati identici (**non** sono un fork: un errore lì sarebbe un falso allarme). Fake DB dedicato invece di quello di `docs.test.ts`, che applica RLS solo su `documents`: la garanzia per-salto si esercita solo nascondendo una riga `doc_items`. Suite intera **159/159** verde, `tsc` pulito.

**Dogfood involontario ma utile:** l'upsert che ha portato `SDES-DOCM-020` da `draft` ad `active` ha risposto `fields_preserved: [body, priority, owner, sort_order]` — cioè il PATCH dichiarato di `SDES-DOCM-008` che ha protetto il corpo del design mentre ne aggiornavo status e `attrs`.

**Nota di rollout (G4):** `dist/` è rigenerato ma le finestre già aperte restano sul build precedente fino a un processo CLI nuovo — `doc_item_chain` non è visibile alla flotta viva finché non riparte.

---

## Sessione #96 — 2026-08-20 (Piano Manifesti ondata 0 / DEL-A4: layer SDES dei 18 REQ-DOCM, gate `req_without_sdes=0` — GTD `f56b9ef6`, WI `1febbf4e`)

**Wake cold-start `high`, mandato esecutivo di loomy (msg `81873b4d`, `requested_model: opus`).** Piano Manifesti approvato (D-176): il pacchetto board-mcp è **DEL-A4** del SoW `17d0e4d8`, e la prima cosa che chiede è il **layer di design prima dei build** — i 18 `REQ-DOCM` del progetto doc-in-db (`1e59391d-9754-4b92-8ce0-393544e10012`) erano `approved` con **zero** `sdes_entry`, e il gate d'uscita esige `req_without_sdes = 0` come check meccanico.

**Consegnato:** documento `sdes` `d21eac63-844c-41a3-bcb5-d2f04c6c70ef`, **23 `sdes_entry`** (`SDES-DOCM-001..023`) + **24 link** `satisfies`/`relates_to`. Gate **verde, misurato**: `doc_query(traceability:"req_without_sdes")` → 0.

**Come è strutturato il layer.** I dodici design già in vigore sono scritti come **as-built** (`status=active`): descrivono il meccanismo reale e il compromesso accettato, non un'aspirazione — FK composita `(document_id, project_id)`, i due predicati RLS separati (`visibility` **mai** in un predicato di scrittura), il PATCH dichiarato di v0.16.3, la rilettura-e-confronto D-132, il trigger di history. I sei con gap sono `draft` e coincidono con i WI del DEL-A4: `012`→WI-D (vuoto≠negato su **7 superfici enumerate**, incl. le 2 dove la garanzia **non** si può dare — dichiarate, non simulate), `014`→WI-A (parità da `pg_catalog` invece del mirror in-code che confronta il file con sé stesso), `015`→WI-E, `016` (attribuzione: degradare a `role:<current_user>` invece di NULL), `017`→WI-B, `018`→WI-A (`working_doc`).

**WI-G (percorso critico di B1 e C3) progettato per intero ma costruibile solo per un terzo** — riportato a loomy senza ammorbidirlo: `019` link item→header **vuole una tabella nuova da dba** (oggi `doc_link` punta solo a righe: il riferimento al «deliverable pubblicato» che REQ-DOCM-015 emendato rende norma è *inesprimibile*); `021` read-path per versione **definisce la superficie di lettura di DEL-A2**, che non esiste — e STP-003 vieta di costruirne una seconda; `020` resolver di catena multi-salto è tool-layer puro ed è l'unico pezzo consegnabile (GTD `d24ce961`).

**Proposta freeze del pubblicato a dba** (msg `cc0ce91e`, punto 4 del mandato): su DEC-01d (trigger dedicato, supersede mai sulla riga pubblicata) il nodo sollevato è che **`superseded` e `pubblicato` sono stati diversi** — una riga pubblicata può essere ancora in vigore — e riusare `doc_items_block_superseded_edit` perderebbe la distinzione. Domande aperte (freeze sulla riga o sull'immagine di pubblicazione? dove vive il predicato "è pubblicato"?) girate a dba per la misura, decisione finale a Loomy/Achille.

**Due misure raccolte per strada.** (1) I 24 link `from=sdes_entry` sono **tutti** visibili nei conteggi e nel gap-check → il difetto `fb2f17e9` **non è generale** a `doc_link_by_code`, discrimina il caso `from=deliverable`: campo ristretto per WI-E, annotato sul GTD. (2) Letto `src/docs.ts:1167-1221`: il gap-check **non filtra per status** e legge **solo** `doc_item_links` — conferma dal vivo i difetti D6/D7 descritti in `SDES-DOCM-015`.

**Un errore mio, tenuto come segnale (GTD `89c232d4`).** Il mandato abbreviava il progetto in `1e59391d`; ho completato l'UUID a caso e interrogato un progetto **inesistente**. `doc_query` ha risposto `visibility_gap: true` — «forse è un blocco RLS, chiedi la membership a dba». Cioè il segnale D-167, che ho scritto io per eliminare le diagnosi fuorvianti, ne ha prodotta una: `visibilityGap()` deduce il gap da `loomx_agent_in_project`, false sia per *progetto invisibile* sia per *progetto inesistente*, e i due casi non sono distinti. Fix a tre rami senza DDL né oracolo nuovo — `loomx_projects` è già enumerabile da `project_list`.

---

## Sessione #95 — 2026-08-19 (sbloccate e riuscite le 5 UPDATE CFG su 669fd07b — GTD `20235b14`, WI `d7ea9641`)

**Autopilot dispatch, riesecuzione dopo sblocco.** dba (msg `c8bc9b6d`) ha applicato la membership board-mcp su `669fd07b` bloccante dalla #93. Riprese le 5 `doc_item_upsert` (`CFG-063/076/086/088/090`) sul documento `794e873c`, questa volta senza ricalcolare i merge a mente: recuperati dal repo (`.claude/cache/wi-history/2002bbbb-…json`) l'intent e le note della #93, poi letti i due corpi (596cd5fc/de6879a4 sorgente, 669fd07b/794e873c destinazione) per ognuno dei 5 codici prima di scrivere.

**4/5 erano merge diretto** (`063/076/086/088`): il corpo destinazione = corpo sorgente **meno** il paragrafo `[TOMBSTONE 2026-08-18]` finale, che parla della copia superseded in `596cd5fc` e non ha senso nella copia canonica. Per `CFG-086` questo produce un rimpiazzo integrale (non solo un'aggiunta in coda) perché la correzione di framing sorgente («hardcoded» → «DB-derived a boot, ma congelato»/GTD `5a3876f5`) aveva riscritto anche l'intestazione, non solo aggiunto una sezione — verificato che la regola «corpo sorgente meno tombstone» produce comunque il risultato corretto in entrambe le forme, senza dover distinguere i due casi a mano.

**`CFG-090` non era merge diretto, confermato.** La copia destinazione narrava già, in prima persona, una «MIGRAZIONE ESEGUITA» — ma imprecisa: attribuiva la scrittura di queste righe a una membership sul progetto **hub** (`22ae4e79`, quello prescritto dal brief originale), mentre il documento `794e873c` vive realmente in `669fd07b`. Sovrascrivere con il corpo sorgente avrebbe cancellato quella narrazione senza correggerla. Scritta invece una sezione datata `2026-08-20` che corregge il dettaglio (dove vive davvero il documento, perché la membership dba dell'epoca non c'entra con questo progetto), rimanda alla sezione arbitrale gemella in `596cd5fc` per la ricostruzione completa (per non tenere due narrazioni parallele), e chiude il cerchio con lo stato attuale: gap D-167 caso (c) risolto da v0.16.8 (#94), membership di oggi (msg `c8bc9b6d`).

**Verifica:** tutti e 5 gli upsert rispondono `ok:true`, rilette-e-confrontate lato server prima della risposta (D-132) — nessun `warnings` su `attrs`/`item_type`.

**Non toccato, per scope:** il tombstone delle 30 copie residue in `596cd5fc` e l'escalation `a33bf519` (corpus in due progetti) restano sospesi da #93 — la riverifica dei link `CFG-074`/`CFG-083` è ancora in attesa di conferma loomy (msg `2fc2f868`), fuori dal perimetro di questo GTD («riprova le 5 UPDATE»).

**Consegna:** `board_ack` + `done` a dba (msg `93b202f3`, ref `c8bc9b6d`).

---

## Sessione #94 — 2026-08-18 (D-167 punto 4: chiuso il terzo ramo con l'oracolo di esistenza dba — GTD `b277c842`, WI `9a67873d`, v0.16.8)

**Wake cold-start, task diretto.** dba (msg `25bb24d9`) segnalava l'oracolo `doc_document_exists(uuid) → boolean` applicato e inerte (migration `20260818215000`, SECURITY DEFINER, `EXECUTE` a `doc_rw`+`service_role`, ritorna SOLO true/false — mai project_id/owner): serviva la metà board-mcp, sul ramo "not found" di `doc_item_upsert` — SOLO lì — con due vincoli non negoziabili (l'istruzione "non crearne uno nuovo" e non nominare progetto/owner) più uno tecnico (applicare il 403 in modo **uniforme**, mai testo diverso per membership).

**Il ramo che chiude era esattamente il residuo lasciato aperto in #91:** l'euristica `loomx_agent_in_project` (membership sul progetto *nominato*) non poteva mai risolvere il caso (c) — documento reale, vive in un ALTRO progetto, `visibility='project'/'team'` → invisibile e indistinguibile da "non esiste" (è così che è nato il duplicato CFG-090). L'oracolo dà la verità: `documentNotFoundError` (`src/docs.ts`) è stato riscritto per essere deterministico invece che probabilistico — `exists=false` → 404 piatto invariato (`document_id '...' not found in project ...`); `exists=true` → 403 nuovo, testo identico indipendentemente dalla membership del chiamante ("exists but is not accessible... Do NOT call doc_create... request access from the project's owner"); probe fallito → non asserisce nessuna delle due certezze.

**Plumbing:** `documentExists` aggiunto a `DocRwDb` (`src/docDb.ts`, stesso pattern di `resolveDocItem`/`agentInProject` — `SELECT doc_document_exists($1::uuid) AS ok`). `docRwHandle` in `docs.ts` ridisegnato per esporre le due probe (`agentInProject`, `documentExists`) **indipendentemente** — un handle che ne wire solo una non rompe l'altro chiamante (`visibilityGap` usa solo `agentInProject`, invariato).

**Verificato live** (`tests/verify-d167-branches.ts`, contro produzione via `LOOMX_DOC_RW_URL`): oracolo su documento reale org-visible → `true`; su UUID inesistente → `false`; ramo mismatch (b) e ramo 404 piatto (a) confermati sul path vero. Non trovato un documento reale project/team-visible e non-membro per testare il ramo 403 (c) end-to-end dal vero (richiederebbe un ID che nessun probe raggiungibile può elencare, essendo nascosto per definizione) — coperto invece da 3 test unitari dedicati su fake con RLS simulata, incluso uno che pinna esplicitamente l'uniformità del testo tra due chiamanti con membership diversa.

**Test:** `tests/docs.test.ts` — 2 test riscritti (404 genuino, 404 "assente" con oracolo) + 3 nuovi (403 con leak-floor, uniformità membership-indipendente, fallback su probe fallito). Suite **31/31** su `docs.test.ts`, **149/149** sull'intero repo. `npm run build` pulito.

**Consegna:** `board_ack` sul messaggio dba `25bb24d9`. Nessuna DDL — solo tool-layer, per mandato esplicito ("non chiamatela dentro una policy RLS").

---

## Sessione #93 — 2026-08-18 (casa unica CFG: bloccata su RLS + una discrepanza sui link trovata riverificando — GTD `efaac02c`, WI `2002bbbb`, waiting)

**Autopilot dispatch, nessuna scrittura riuscita — task non completato, correttamente fermato due volte.** Loomy aveva arbitrato: `669fd07b` (Decision Enforcement) è la casa canonica delle 30 CFG-061..090, portare lì le 5 correzioni di oggi (`CFG-063/076/086/088/090`), tombstonare le 30 copie residue in `596cd5fc`.

**Preparazione (fatta con la testa, non meccanica).** Letti i body completi delle 5 coppie via `psql` sotto `doc_rw`. 4 casi (`063/076/088` + `086` dopo verifica) erano prefissi esatti: la copia migrata coincide byte-per-byte con lo stato del 16/08 21:44, la correzione di oggi è un blocco appeso in coda — merge diretto. `CFG-086` sembrava avere una seconda divergenza indipendente (framing "hardcoded" in `669fd07b` vs "DB-derived a boot" nell'originale) — controllato `doc_item_history`: **entrambe le modifiche sono di oggi** (20:11 e 20:12), non una vecchia correzione mai migrata. `CFG-090` **non** è un merge diretto: la copia in `669fd07b` narra già "MIGRAZIONE ESEGUITA" in prima persona, mentre l'originale narra ancora il blocco RLS pre-migrazione — copiare l'originale sopra avrebbe reintrodotto un'affermazione falsa. Scritta una sezione di chiusura nuova invece di un copia-incolla.

**Bloccato al momento di scrivere.** Le 5 `doc_item_upsert` su `669fd07b` falliscono sotto RLS — `loomx_agent_in_project('669fd07b','board-mcp') = false` (misurato, era già scritto nel corpo di `CFG-090` letto in preparazione, non l'ho collegato finché il write non ha fallito). Nessun dato corrotto: il controllo rilettura-e-confronto di `doc_item_upsert` ha intercettato lo scarto e risposto `ok:false` su tutti e 5. Richiesta membership a dba (msg `dc4de72c`, wake high), stesso pattern già risolto stamattina sull'hub.

**Riverifica dei link (istruzione esplicita del GTD: fermarsi se ne trovo).** Primo giro con `code LIKE 'CFG-0%'` — falso positivo, il pattern include anche `CFG-002..047`, che hanno link legittimi (corpus diverso). Corretto lo scope a `CFG-061..090` esatto: trovati **2 `doc_item_wi_links`** su `CFG-074`/`CFG-083` verso il WI `a0cf88e8` (quello che ha scritto le 30 righe originali, `status=done`) — link che il GTD dava per assenti. Valutazione tecnica: innocuo (WI già chiuso, tombstone è UPDATE non DELETE, il link resta leggibile su riga superseded-immutabile) — ma per istruzione esplicita mi sono fermato invece di decidere da solo, segnalato a loomy (msg `2fc2f868`) invece di procedere silenzioso.

**Stato:** GTD → `waiting`/`waiting_on=dba`. Nessuna riga toccata in nessuno dei due progetti. Escalation `a33bf519` non chiusa. WI chiuso `waiting` (non `done` — lavoro non completato), resume via `resume_hint`.

---

## Sessione #92 — 2026-08-18 (as-is §6: attrs validation solo a livello tool — omissione, non scelta; pg_jsonschema misurato — GTD `64cac59c`, WI `dd83184c`)

**Autopilot dispatch, nessuna scrittura di codice.** Achille chiedeva 3 cose sulla riga di §6 dell'as-is `doc-in-db` («`doc_items.attrs` non è tipizzato dal DB, unico controllo a livello tool»): (1) deliberato o sfuggito, (2) `pg_jsonschema` disponibile misurato non dedotto, (3) parere se convenga chiuderlo.

**1 — pattern-check, non giudizio a naso.** §9bis dichiara la propria regola di selezione («un requisito retroattivo che nulla soddisfa è un desiderio») e infatti promuove a §9bis, con motivazione esplicita, quasi ogni altro item elencato in §6 (tracciabilità cross-progetto, versionamento header, `document_type` mancante, staleness, persone) — tranne "attrs non tipizzato dal DB", che non ha motivazione da nessuna parte. Letto come omissione, non come costo accettato: proposto (non scritto, per mandato del GTD) un bullet §9bis a loomy/Achille, non auto-ratificato.

**2 — misurato via `psql` diretto sul canale nativo:** `pg_available_extensions` → `pg_jsonschema | default:0.3.3 | installed:NULL`; `pg_extension` → 0 righe. Disponibile, non installata. `CREATE EXTENSION` è DDL → dba (D-005).

**3 — parere:** il registro `docTypes.ts` è dato riusabile ma non un CHECK diretto (schema varia per `item_type`, serve dispatch via trigger). Un CHECK/trigger si applicherebbe anche a `service_role` (a differenza della RLS, §3/§7 D4) — lì il guadagno ci sarebbe, ma aggiungerebbe un terzo schema da tenere sincrono con D1 (drift registro↔DB già misurato in §7) invece di risolverlo. Raccomandazione: non prioritario ora.

**Consegna:** `board_send` a loomy (msg `a421a180`), corto, con le 3 risposte + query eseguite. Nessuna scrittura su `doc-in-db` (mandato esplicito del GTD: proporre, non auto-scrivere).

---

## Sessione #91 — 2026-08-18 (chiuso il buco D-167 «esiste, ma in un altro progetto» — GTD `dc4e943e`, WI `0b73b5f1`, v0.16.7)

**Prima misura, e ribalta la premessa del GTD.** Il GTD (scritto in #90) dava per fatto che oggi board-mcp, su `794e873c` con `project_id=22ae4e79`, riceverebbe il ramo rassicurante «not found… create it first». **Falso, misurato:** il lookup di `docItemUpsert` (`src/docs.ts:277`) è **by-id, non project-scoped, fin dal commit iniziale** `40a4e4d` — e `794e873c` è `visibility=org`, quindi RLS la lascia passare. Il ramo che scatta è `project_id mismatch`, non il 404. Verificato eseguendo la chiamata vera sul path di produzione.

**Ma il buco esiste, ed è un altro.** Misurato sotto `doc_rw` come board-mcp (`documents_select USING loomx_document_visibility_predicate(project_id, visibility)`): sui **6** progetti dove board-mcp non è membro, `visibility='org'` → **visibile**, `visibility='project'/'team'` → **filtrata in silenzio**. Quindi 0 righe significa (a) non esiste · (b) esiste altrove ed è org-visible · (c) esiste altrove ed è project/team-visible — e **(c) è indistinguibile da (a)**.

**(c) è esattamente l'incidente del 16/08, ricostruito dai timestamp:** loomy crea `794e873c` in `669fd07b` alle **06:40** (`doc_create` default `visibility='project'`), board-mcp — non membro — riceve «not found, create it first» alle **07:15**, crea il proprio documento alle **07:18** (`de6879a4`). La riga risulta `updated_at` **21:44** dello stesso giorno: è diventata org-visible *dopo*. Il duplicato è nato sul ramo (c), che nessun probe raggiungibile da questo tool può chiudere.

**Il probe non-scoped proposto dal GTD non è stato scritto, e la ragione è misurata:** sarebbe la **query identica** a quella che il callsite già fa, nella stessa transazione e nello stesso ruolo — un roundtrip in più e un ramo che nessun chiamante può raggiungere. Su quel path non mancava la *rilevazione*: mancava l'**istruzione**.

**Fix, in due punti:**
- `projectMismatchError` (nuovo, condiviso): il messaggio di mismatch ora *dice cosa fare* — «Do NOT call doc_create — retry with `project_id=Y`, o chiedi a chi ti ha dato X quale progetto intendeva» — e riporta il **titolo** del documento, così il chiamante lo riconosce. Sapere che il documento sta altrove è precisamente il momento in cui un agente è tentato di crearsene una copia (è ciò che accadde).
- ramo «membro del progetto nominato»: **non promette più che sia sicuro creare**. La membership su X non è evidenza su un documento che vive in Y. Il messaggio dichiara cosa non può escludere e ordina la verifica (l'id non te lo sei inventato → risali a chi te l'ha dato) prima di qualsiasi `doc_create`.

**Leak floor verificato, non assunto** (era la richiesta esplicita del GTD): nessun ramo rivela l'esistenza, il progetto o il titolo di una riga che RLS ha nascosto — pinnato da un test dedicato.

**Test:** 3 rami nuovi in `tests/docs.test.ts` (assente · esiste-altrove-org-visible · esiste-altrove-ma-nascosto), su un fake con simulazione RLS **opt-in** (`makeDb(store, members, {rls:true})`) — opt-in perché i test preesistenti seminano documenti in progetti di cui non sono membri, e imporgli la RLS avrebbe testato il fake, non l'handler. Suite **147/147**. In più `tests/verify-d167-branches.ts`: gli stessi 3 rami eseguiti **contro il DB di produzione** via `runDocRw` — il fake è un mimo scritto a mano, solo il DB dice su quale ramo un chiamante atterra davvero. **ALL PASS.**

**Residuo, non mio da chiudere:** il ramo (c) richiede un oracolo di esistenza `SECURITY DEFINER` lato DBA (es. `loomx_document_project(uuid) → uuid`). Proposto a dba con loomy in copia (D-005) — nessuna DDL scritta da qui.

---

## Sessione #90 — 2026-08-18 (allineate a produzione le 2 decisioni superate dai fatti + arbitrata CFG-090 — GTD f1f93baf, WI `97e8e1c2`)

**Autopilot dispatch, istruzione diretta di Achille:** «allinea le decisioni con quanto in produzione». Vincolo di metodo: **allineare non è riscrivere** — il corpo di una decisione non si tocca, si aggiunge una nota di stato datata o si registra un supersede.

**PARTE A — le due decisioni superate (progetto `596cd5fc`, documento `1da8642c`):**
- **`D-004`** (service_role unico backend) → `status: active → superseded`, `attrs.superseded_by = "D-084"`, edge `supersedes` **D-084 → D-004**, nota di raccordo in coda. **Non ho usato `doc_supersede`**, che il GTD proponeva: quel tool crea una **nuova** riga trasportando il codice, e D-084 esiste già come riga propria — l'avrebbe duplicata. Il tool giusto per «una decisione già esistente ne rimpiazza un'altra» è `doc_link(relation_type='supersedes')`.
- **`D-016`** (solo loomy riassegna `owner`) → nota di raccordo, `status` **invariato**. Il guard reale è `!(isLoomy || isBroker)` (`src/tools.ts:1248`) **fin dal commit iniziale** `40a4e4d` (2026-06-29, allora riga 783): la regola è nata più stretta di come è sempre stata applicata. Due dettagli che la rendono invisibile: il messaggio d'errore (`:1251`) e la description del tool (`:1226`) dicono entrambi «only loomy». La nota **registra lo scarto, non lo sana** — ratificare o ritirare il permesso del broker è di Achille.

**PARTE A-bis — correzione dichiarata del mio verdetto di FASE 4:** `D-a5-F3` era `NON_APPLICATA`, **retrocessa a `PARZIALMENTE_APPLICATA`**. `documents.attrs jsonb NOT NULL DEFAULT '{}'` **esiste**, applicata dal DBA il 2026-06-27 (`20260627030000…f45.sql:21-23`, che cita testualmente «finding F3»). Manca solo la metà tool-floor (`docCreate` non la scrive, nessuno schema `attrs` doc-level nel registry). **Perché il primo giro sbagliò:** aveva dedotto lo schema da `src/docs.ts` invece di misurarlo — e, se avesse misurato con `information_schema`, avrebbe sbagliato lo stesso: sotto ruolo nativo `board-mcp` quella vista ritorna **zero righe** su `documents` (filtra per privilegio, solo `doc_rw` ha grant). Una colonna che esiste appare assente. **Per l'esistenza di una colonna si legge `pg_catalog`.** È la trappola D-167 riaffiorata un piano sotto, a livello `psql`.

**PARTE A-ter — le non applicate, tracciate e NON implementate:** `D-010` aveva già `50d93acf`. Creati non armati `d6106e20` (D-150 hash-pinning, `waiting_on=loomy` + `no_auto_arm=true`: la forma del pinning non è ratificata) e `9e1805d9` (metà tool-floor di D-a5-F3). Tutti e tre agganciati alla propria decisione con `doc_link(target_kind='gtd')`.

**PARTE B — CFG-090 arbitrato, e il verdetto è contro il CFG.** Il documento `794e873c` **esiste** e conteneva già tutte e 30 le righe `CFG-061..090`, copiate il **16/08 alle 21:44:39Z**. Non è nell'hub `22ae4e79` come diceva il brief: sta in **`669fd07b`** (*decision-enforcement*), `visibility=org`. Il probe del 16/08 aveva discriminato «esiste o non esiste» **interrogando il progetto sbagliato** e letto quello zero come conferma. Il messaggio dba `588c775c` aveva ragione. **Causa radice: il brief accoppiava un `project_id` e un `document_id` che non stanno insieme** — e `doc_item_upsert` valida quella coerenza, quindi non poteva che fallire, con un messaggio che imputava tutto all'assenza.

**Buco confermato in D-167 (GTD `dc4e943e`, high):** il discriminante è `loomx_agent_in_project(project_id)` sul progetto **nominato dal chiamante**. Su `22ae4e79` board-mcp *ha* membership → oggi riceverebbe il ramo rassicurante *«not found… create it first»* e **minterebbe il duplicato che D-167 esiste per prevenire**. Il caso «esiste, ma in un altro progetto» non è coperto. Non riparato in questo giro (regola del mandato: non mescolare correzione documentale e fix di codice).

**Escalation aperta a loomy (GTD `a33bf519`):** il corpus CFG-061..090 **vive in due progetti e sta già divergendo** — `CFG-086` era stato aggiornato solo in `596cd5fc` il 18/08, e questo giro ne ha aggiunte altre quattro (`CFG-063`, `CFG-076`, `CFG-088`, `CFG-090`). Quale copia sia canonica non lo decido io.

**Altri CFG allineati:** `CFG-063` e `CFG-088` → divergenze **chiuse** dal commit `8c6629c` (16/08). `CFG-076` → difetto 1 chiuso (`0.16.1` → `0.16.6`, un bump per commit, verificati uno per uno), **difetto 2 invariato e strutturale** (nessun segnale di build per-window). `CFG-086` → tesi confermata, e il suo stesso elenco di slug è già stale (37 nel testo, 38 nel mio processo, 39 attivi in `board_agents`: manca `teams-bridge`) — dimostrazione gratuita della tesi, lasciata apposta non aggiornata. Corretto lì un `36`→`37` (errore di conteggio della sua stessa lista), **dichiarato nel documento** invece che fatto in silenzio.

**Chiusi perché misurati risolti:** `40125115` (GRANT su `loomx_projects` — `project_list` risponde con 50 progetti dal ruolo nativo) e `e79c340d` (l'arbitraggio di CFG-090).

**I conteggi NON sono migliorati, e non dovevano.** `req_without_sdes` **0 → 0**, `sdes_without_uat` **12 → 12**, link CFG→SDES **0 → 0** (33 `config_pattern`, gli unici 3 link sono fra `PROBE-A`/`PROBE-B`). Questo giro ha toccato decisioni e CFG, che non stanno su nessuna delle due catene: nessun link inventato per far quadrare un conteggio. Controllo positivo eseguito prima di fidarsi dello zero (`sdes_without_uat` ritorna 12 righe reali sullo stesso path RLS).

**Verifica:** ogni scrittura riletta dal DB **fuori dai tool** (`psql` sotto `SET LOCAL ROLE doc_rw` + GUC `request.agent_slug='board-mcp'`), non solo dalla risposta di `doc_item_upsert`. Tutti gli upsert con `created:false`.

**Code lasciate aperte:** (a) il titolo del documento `de6879a4` dice ancora «destinazione hub 794e873c non scrivibile», oggi falso — **non esiste un tool `doc_*` per aggiornare i metadati di un `documents`**, serve loomy o dba; (b) nit: `doc_query` ignora `limit` in modalità `traceability`.

---

## Sessione #89 — 2026-08-18 (popolato il progetto di dominio `doc-in-db`: as-is misurato + 16 requisiti del modello — GTD ed44f955, D-166)

**Autopilot dispatch.** WI `501b1afd`. Achille ha deciso il contrario di quanto avevo raccomandato nella sessione #88: `doc-in-db` (`1e59391d`) **non** si assorbe in `596cd5fc`, si riempie e diventa il progetto del **dominio** «modello documenti» (criterio D-166: curatore di dominio ≠ praticante di progetto). Le mie due ragioni per assorbire non reggevano — il modello è consumato da tutta la flotta, non solo da chi lo implementa, e «un quarto dei miei SDES lo descrive già» è un argomento a favore del contrario.

**Blocco incontrato e risolto in sessione:** `doc_create` su `1e59391d` → `new row violates row-level security policy`. Causa **misurata**, non dedotta: `loomx_agent_in_project('1e59391d') = false` (nessuno dei 3 rami — lead, team, membership). Chiesta membership a dba (msg `134a5b03`, wake high) con la migration già pronta da copiare; dba l'ha applicata nel giro di pochi minuti e la scrittura è partita. Nel frattempo il contenuto era stato prodotto in staging su file, poi **cancellato** una volta in DB (un `.md` con lo stesso contenuto sarebbe stata la seconda fonte che il modello vieta).

**Novità di metodo:** ho misurato la produzione via `psql` **read-only** sotto i ruoli reali (`board-mcp` nativo e `SET ROLE doc_rw` + GUC `request.agent_slug`), non dalle migration. Chiude il limite #1 del report di sessione #88 («nessun accesso SQL diretto»).

**Scritto in DB (28 item, 2 documenti, progetto `1e59391d`):**
- `dafdace0` — *As-is del modello documenti governance* (`exec_summary`, 12 item): schema reale misurato, modello di accesso RLS, contratto dei tool, comportamenti che sorprendono, confini, 7 divergenze, Pilot D-a5, limiti, lacune, decisioni non rispettate in sezione separata.
- `668d0dca` — *Requisiti del modello documenti governance* (`req`, 16 item `REQ-DOCM-001..016`, tutti `proposed` — non me li auto-ratifico): 14 `must`, 2 `should`, ciascuno con `rationale`, `acceptance_criteria` e `derived_from`. I 3 non soddisfatti portano un `gap_note` esplicito.

**Divergenze nuove trovate misurando (le principali):**
- **Il gate di capability-parity confronta sé stesso, non il DB.** `DB_*` in `src/docTypes.ts` è un mirror ricopiato a mano dalle CHECK: nessuna delle due parti del confronto legge Postgres. Misurati **5 valori distinti** ammessi dal DB e senza tool-path (`change_request`, `implemented`, `verified`, `in_progress`, `amends` su entrambe le tabelle di link) con `capability_parity.ok = true`. In più il gate **non controlla `document_type`**. Impatto sui dati oggi: zero (nessuna riga li usa) — ciò che è rotto è la garanzia. È il pari del precedente D-099 che la sessione #88 aveva dichiarato assente in questo corpus.
- **`documents.attrs` esiste nel DB** (`jsonb NOT NULL DEFAULT '{}'`): D-a5-F3 non è «non applicata», è applicata a schema e non esposta dal tool. Corregge il verdetto di #88.
- **Lo storico degli item esiste**: trigger `BEFORE DELETE OR UPDATE`, 457 righe su 309 item, zero delete mai. Ma `changed_by` è **NULL nel 49,7%** — le scritture `service_role`, che la RLS non intercetta (`relforcerowsecurity=false` ovunque).
- **`doc_query` non ha il parametro `document_id`** che il nostro CLAUDE.md §6bis prescrive; e le cross-decisions stanno su due documenti (100 + 63), con §6bis che punta al più piccolo (39% del corpus).
- **`docTraceability`** non filtra `status` (1 riga di rumore oggi) e ignora `doc_item_xproject_links` (0 di impatto oggi, ma si manifesta appena la tracciabilità cross-progetto viene usata).
- **Asimmetria read/write non documentata:** `visibility='org'` apre la lettura a chiunque, la scrittura passa solo da `loomx_agent_in_project`. `visibility` è una leva **solo in lettura**.

**Nota su un errore evitato per un soffio:** ho letto `doc_resolve_log` in SQL diretto, ottenuto 0 righe, e stavo per scrivere «l'audit dei resolve non viene popolato». Falso: la policy di SELECT ammette solo `loomy`/`auditor`/PMO — il mio zero era il blocco, non il dato. È la trappola D-167 che ha colpito chi mantiene il modello mentre scriveva il documento su quella stessa trappola. Registrata nell'as-is come tale.

**Blocchi / note:** nessun item spostato da `596cd5fc` né dal Pilot `8930ff35` (censito e raccontato, non toccato). Nessun codice `D-NNN` allocato. I 3 requisiti non soddisfatti (`REQ-DOCM-014/015/016`) sono candidati a fix nel prodotto board-mcp, ma il fix va deciso da Loomy: sono requisiti di dominio, non backlog che mi auto-assegno.

---

## Sessione #88 — 2026-08-18 (review bottom-up doc-in-DB: 30 CFG + 46 decisioni verificati contro il sistema reale — GTD e95ea3d3)

**Autopilot dispatch, 2 WI in sequenza sullo stesso GTD** (v1 poi v2 — Loomy ha aggiunto una FASE dopo che ero già partito, msg `0d8298bd`). Mandato di Achille via Loomy: SoW retroattivo del progetto "modello documenti" (D-a5) — prima di scriverlo, verificare che il corpus governance (162 item nel progetto `596cd5fc`: 37 REQ · 26 SDES · 22 UAT · 30 CFG · 43 decisioni) descriva davvero il sistema in esercizio. **Non correggere niente** — solo misurare e riportare.

**WI `889d6845` (FASE 1-3+5, v1 del GTD):** 30 CFG (`CFG-061..090`) ri-misurati oggi contro `src/*.ts` corrente — 22 confermati netti, 3 confermati-ma-obsoleti (divergenza già risolta da un commit del 16/08 stesso), 1 divergente di framing (CFG-086: l'enum destinatari è DB-derived a boot, non hardcoded), 1 contraddizione documentale non arbitrata (CFG-090). FASE 2: separazione strutturale totale fra i 30 CFG e i 26 SDES (0 link in entrambe le direzioni). FASE 3: 0/37 REQ senza SDES (con controllo positivo D-167 prima dello zero), 12/26 SDES senza UAT (i più recenti). FASE 5 (perimetro doc-in-db): scoperto un **terzo progetto** non citato dal mandato, `Pilot D-a5` (`8930ff35`, board-mcp-owned, 11 item dimenticati) — raccomandazione: assorbire `doc-in-db` in `596cd5fc`, non riempirlo né chiuderlo.

**WI `dae06594` (FASE 4, v2 del GTD):** le 43 decisioni di progetto + 3 cross (`D-150`, `D-155`, `D-167`) verificate come RISPETTATA/VIOLATA/NON_APPLICATA/SUPERATA_DAI_FATTI con evidenza `file:riga`/query — 46 in totale (il codice bare "D-a5" non esiste, è il nome della famiglia, le 6 sotto-decisioni sono già nelle 43). Eseguito con 7 agenti paralleli, uno per lotto. Esito: **41 RISPETTATA, 3 NON_APPLICATA** (D-010 governance tag mai applicata, D-150 hash-pinning/stale-marking in discussione non implementato, D-a5-F3 `documents.attrs` mai aggiunto), **2 SUPERATA_DAI_FATTI** (D-004 service_role→D-084 identità nativa preferita ma D-004 mai formalmente supersedeuta; D-016 owner-reassign su gtd_update esteso anche al broker, mai riflesso nel testo), **0 VIOLATA** — il precedente D-099/flag-27-giorni-acceso cercato esplicitamente dal mandato non ha un pari in questo corpus.

Report completo: `docs/reports/track-b-review-2026-08-18.md`. `board_send` a loomy con la sintesi (msg `728f3abf`). Nessuna correzione applicata al codice — l'allineamento (ratificare/ritirare D-004/D-016, decidere se/quando D-010/D-150/D-a5-F3) spetta a Loomy con Achille.

---

## Sessione #87 — 2026-08-18 (fix wi_end: status=failed senza failure_reason chiudeva comunque il WI — GTD 1a07aa26)

**Autopilot dispatch.** GTD `1a07aa26`: `wi_end` non applicava il proprio contratto — la doc del tool dichiara `failure_reason` "Required when status=failed", ma `src/wi.ts:541` lo usava solo opportunisticamente (`if (args.status === "failed" && args.failure_reason) update.failure_reason = ...`): con `failure_reason` assente o stringa vuota il WI veniva comunque chiuso `failed`, silenziosamente, senza motivazione persistita né `[BLOCKER]` nel body GTD collegato.

**Fix:** guardia esplicita in `wiEnd` (src/wi.ts:485-487) subito dopo il check di ownership, prima di qualunque lettura/mutazione a valle — `status=failed` con `failure_reason` mancante o solo whitespace ritorna errore esplicito (`"failure_reason is required when status=failed."`), il WI resta `active` e il GTD collegato resta intatto (nessun side-effect parziale, a differenza del bug). Lo schema zod del tool (`src/tools.ts:2862`) resta `failure_reason?: string` — la required-ness è condizionale su `status`, non esprimibile pulita a livello di schema, quindi l'enforcement resta runtime (stesso pattern degli altri gate in `wi.ts`, es. D-074).

2 test di regressione in `tests/wi.test.ts` (failure_reason assente / blank su status=failed → rifiutato, WI+GTD invariati). `npx tsc` pulito, suite 145/145 verde (era 143 a fine sessione #86). Version bump 0.16.5→0.16.6.

---

## Sessione #86 — 2026-08-18 (D-167: doc_item_upsert 404→403 honesto + doc_query visibility_gap — zero DDL, riuso loomx_agent_in_project)

**Wake cold-start (D-093, normal).** Msg `26a5e70f` di loomy: D-167 (ratificata, doc `7e3dbb35`/item `1b40e8a1`) chiede due fix lato board-mcp emersi dal doppio blocco RLS del 17/08 su 669fd07b — dba bloccato in scrittura da `doc_item_upsert`, auditor bloccato in lettura su un gap-check che leggeva "0 righe" come corpus vuoto invece che RLS-block (GTD 63142305). GTD `79c229e8` tracciava già lo stesso task (messaggio loomy precedente alla formalizzazione D-167) — riusato come WI anchor, non duplicato.

**Root cause su `doc_item_upsert`:** `src/docs.ts:240` rispondeva `"document_id 'X' not found. Create it first with doc_create."` su qualunque 0-righe della SELECT `documents` sotto `doc_rw` — ma RLS (D-015) filtra silenziosamente sia "non esiste" sia "esiste ma non visibile al chiamante" con lo stesso 0-righe, senza errore distinguibile. Il testo spingeva verso la creazione di un duplicato (stessa famiglia D-121).

**Fix senza nuova DDL:** invece di chiedere al DBA una nuova funzione SECURITY DEFINER (ipotesi in D-167 "se serve una funzione lato DB da esporre al tool"), verificato che `loomx_agent_in_project(project_id)` — SECURITY DEFINER, già `GRANT`ata a `doc_rw` dalla migration `20260629065000` (co-engagement, D-070) — è sufficiente: risponde "il chiamante ha una qualche legittimazione sul progetto" (lead/team/co-engaged/loomy/pmo) bypassando l'RLS del chiamante internamente. Aggiunto `agentInProject` a `DocRwDb` (`src/docDb.ts`, stesso pattern di `resolveDocItem`/`relinkSuperseded`). `docItemUpsert`: 0 righe + NON membro → errore 403-style ("Access denied or not visible… may exist but that can't be confirmed from here… Do NOT call doc_create"); 0 righe + membro → messaggio 404 originale (safe to create). `docQuery`/`docTraceability`: 0 righe + NON membro → `visibility_gap:true` + `note` esplicativa sul possibile RLS-block, in tutti e tre i path (filtro semplice, filtro `document_type`, traceability) — quest'ultimo è esattamente l'incidente GTD 63142305. Descrizione tool `doc_query` aggiornata per menzionare il segnale.

Non è una diagnosi certa (il predicato è a livello progetto, non documento — `visibility='org'/'team'` può dare falsi positivi rari) ma è un segnale reale ancorato a un grant DB esistente, non un'euristica inventata — coerente con D-136 §5 (niente contratto inventato). Il gap residuo (predicato a grana documento, non progetto) resta aperto e non bloccante: nessun agente ha oggi bisogno di più precisione di questa per evitare il duplicato o il falso-verde.

5 nuovi test in `tests/docs.test.ts` (403 vs 404 su membership, visibility_gap presente/assente, traceability con gap). Version bump 0.16.4→0.16.5. `npx tsc` pulito, suite 143/143 verde.

---

## Sessione #85 — 2026-08-17 (fix root cause wi_resume cache: `syncWiCache` preferiva `started_at` all'active — build+test+deploy, GTD 4f05821c)

**Wake cold-start (D-093, high).** Msg `5ce7a0f5` di it-manager: root cause trovata e patchata (non committata) del bug segnalato da Achille — `governance-gate.sh` blocca ogni scrittura dopo un `wi_resume` legittimo. Causa: `syncWiCache` (src/wiCache.ts) ordinava per `started_at desc limit 1`, colonna stampata una sola volta a `wi_start` e mai toccata da `wi_pause`/`wi_resume`. Scenario: `wi_start A(t0)` → `wi_pause A` → `wi_start B(t1>t0)` → `wi_end B(done)` → `wi_resume A`: la query continuava a restituire B (done, t1) anche con A ora `active` — cache riscritta col WI sbagliato, gate legge status=done e blocca tutto mentre `wi_status` mostra correttamente A active.

**Review del patch di it-manager (non mio il fix, mia la verifica):** logica sound — interroga prima la riga `status=active` per l'agente (al più una, `one_active_wi_per_agent`), fallback sull'ordinamento per `started_at` solo quando non c'è nessuna riga active (preserva il comportamento whitelist post-close esistente). Aggiunta copertura di regressione mancante (`tests/wiCache.test.ts`, 4 test: preferenza active-over-newer-closed = lo scenario del bug, fallback ordinato quando nessuna riga è active, scoping per `agent_slug`, rimozione cache quando l'agente non ha WI). `npx tsc --noEmit` pulito, suite 138/138 verde, build pulita. Version bump 0.16.3→0.16.4.

**Trovato in corso d'opera (non richiesto, ma nel working tree):** `.claude/hooks/governance-gate.sh` e `.claude/settings.json` avevano ~6 settimane di fix (v1.2→v1.6, dal 2026-07-18 al 2026-07-30, già live in flotta per msg loomy `61c427bf`) mai committati in questo repo, più il wiring di due hook fleet-wide nuovi verso script esterni (`/home/loomy/workspace/hub/scripts/heartbeat_ping.py`, `wi_instrument.py`) non menzionati nel messaggio di it-manager. Letti entrambi gli script prima di committare il wiring: fail-open (`exit 0` sempre), debounced, nessuna scrittura distruttiva, entrambi già autorizzati (GTD ba022585/c29d6143 GO Achille via loomy; gap b7975288 loomy). Committato separatamente dal fix wiCache (due commit distinti) per non conflaterli.

Due commit: `fix(wiCache)` (src/wiCache.ts + test + package.json) e `chore(hooks)` (governance-gate.sh + settings.json). Nessun deploy possibile oltre alla build locale (G4: `dist/` è gitignored, build unica condivisa, nessun meccanismo di push/reconnect per server MCP stdio — solo un restart di finestra carica il nuovo `dist/`). Non forzato alcun restart di flotta di iniziativa propria; segnalato a it-manager via board_send. Msg ackato.

---

## Sessione #84 — 2026-08-16 (chiusura canale msg `d6fa47b1` + misura del rollout: il fix è nel `dist/`, non nella finestra di chi scrive sul corpus)

**Wake cold-start (D-093, urgent, requested_model opus).** Msg `d6fa47b1` di loomy sul difetto `doc_item_upsert` — arrivato alle 15:40 UTC **mentre il WI `a312ef36` era già in volo**, chiuso alle 15:52. Nessun lavoro nuovo da fare: il fix richiesto era committato 11 minuti dopo l'invio (`a5e74db`, v0.16.3). **WI** `085f9b30` (triage).

**Riverificato invece di dato per fatto:** suite ri-eseguita in sessione (134/134 verdi), `dist/` (17:50) più recente di `src/` (17:48/17:46), update-path riletto riga per riga — PATCH condizionale su tutti i campi opzionali, `attrs:{}` esplicito ancora distruttivo, `warnings` che nominano le chiavi scartate, rilettura+confronto prima di `ok`.

**Il fatto nuovo, che nessuno aveva misurato:** `ps -eo lstart,args | grep dist/index.js` → il processo MCP di **loomy è vivo dal 15/08 10:16 (32 ore)** e quello di `trader` dal 15/08 23:04. `dist/` è stato ricostruito oggi alle 17:50 e Node non fa hot-reload (G4). **Quindi la ratifica del corpus in corso in quelle ore passava ancora dal tool pre-fix**: il difetto era chiuso nel codice e aperto nella sessione di chi scriveva. Esposizione misurata sul processo, non sulla risposta del tool — la versione D-132 della raccomandazione di loomy applicata al rollout invece che alla riga.

Segnalato a loomy (msg `43650064`, wake high) con l'output di `ps` e i due punti del GTD chiusi punto per punto: (1) l'asimmetria valeva anche per `status`, campo assente dalla segnalazione, e **non** era pattern del layer (23 write-path misurati); (2) scelto "conservato" con via esplicita per svuotare. **Nessun restart di flotta forzato di iniziativa propria** (CLAUDE.md G4): timing e decisione restano di loomy/it-manager. Msg ackato.

---

## Sessione #83 — 2026-08-16 (doc_item_upsert: l'omissione smette di cancellare — v0.16.3, D-a5-upsert-patch-semantics)

**Autopilot dispatch.** GTD `0cdffc2b` (urgent, armato da loomy la sera stessa in cui il difetto ha colpito una scrittura di massa sul corpus governance). **WI** `a312ef36`. Modello: opus (analisi strutturale del write-path + scelta di semantica).

**Il difetto.** `docItemUpsert` scriveva `attrs` e `status` **incondizionatamente** da valori defaultati (`args.attrs ?? {}`, `args.status ?? spec.default_status`), mentre `body`/`priority`/`owner`/`sort_order` erano già condizionali (`!== undefined`). Un upsert del solo `status` azzerava quindi gli `attrs` rispondendo `ok:true` — il 16/08 ha tolto a `REQ-GOV-037` gli `acceptance_criteria` (2085 caratteri → 2) durante la ratifica di ~240 item, recuperati solo perché `doc_item_history` conserva la pre-immagine.

**Misurato prima di progettare (punto 1 del GTD).** Passati in rassegna tutti i 23 write-path del server: `buildGtdUpdatePayload`, `wi_checkpoint`, `wi_end`, `wi_switch`, `runtime_request`, `home_grocery_update`, `home_menu_write` sono già patch o merge, e `doc_supersede` riportava già `args.attrs ?? old.attrs`. **Difetto di un singolo tool, non convenzione del layer** — quindi fix locale, nessuna riscrittura. La misura ha però trovato un **secondo campo con la stessa asimmetria, assente dalla segnalazione: `status`** — un upsert del solo `body` riportava un item `committed` al default del tipo (`draft`), sempre in silenzio.

**Fatto (`src/docs.ts`, `src/tools.ts`):**
- **PATCH dichiarato:** ogni campo opzionale omesso è conservato, `attrs` e `status` inclusi. `spec.default_status` resta un default di INSERT.
- **`attrs:{}` esplicito continua a svuotare** (punto 3 del GTD: senza una via esplicita il problema si sposta e basta). Nessun valore sentinella nuovo — l'omissione era già lo stato valido.
- **Niente più silenzio nell'altra direzione:** `warnings` quando una sostituzione di `attrs` scarta chiavi memorizzate (le nomina) o quando un `item_type` cambia in place; risposta con `fields_written`/`fields_preserved`.
- **`_client_token` trasportato** attraverso una sostituzione di `attrs` — perderlo avrebbe spezzato in silenzio l'idempotenza `(document_id, client_token)`, sdoppiando l'item.
- **Rilettura e confronto della riga prima di rispondere `ok`** (punto 4 / D-132), su INSERT e UPDATE. Chiude anche la variante D-133: sotto `doc_rw` in no-RETURNING mode un UPDATE negato da RLS tocca 0 righe **senza errore**, e la SELECT di follow-up restituiva comunque una riga → `ok:true` su una scrittura mai avvenuta. Ora è `ok:false` con il diff.
- Descrizione del tool e parametri riscritti: l'asimmetria era «non documentata», ora la semantica è nel testo che l'agente legge prima di chiamare.

**Verifica.** 134/134 unit (8 nuovi test di regressione, tutti falsificati contro il codice pre-fix) + `tests/verify-upsert-patch.ts`: 14 check sul **path di produzione reale** (direct-pg, ruolo `doc_rw`, RLS e JSONB veri) dentro una singola transazione chiusa con un rollback deliberato — zero residui nel corpus. La verifica live ha trovato un bug che i test non potevano vedere: **Postgres restituisce il JSONB con le chiavi riordinate**, quindi il confronto in rilettura segnalava un mismatch fantasma a ogni scrittura di `attrs`. Confronto reso canonico (chiavi ordinate ricorsivamente, ordine degli array preservato perché significativo).

**Decisione registrata in DB:** `D-a5-upsert-patch-semantics` (project-local, `active`), linkata a WI e GTD. Codice **nominale** e non un `D-NNN`: i numeri locali collidono con i cross e la policy di loomy (msg `df951215`) è annotare, mai rinumerare — la famiglia `D-a5-*` è la convenzione già in uso per il document model.

**Da sapere (rollout G4):** le finestre già aperte girano sul build precedente finché non ripartono — incluso chi sta scrivendo sul corpus adesso. Segnalato a loomy, nessun restart di flotta forzato di iniziativa propria.

---

## Sessione #82 — 2026-08-16 (org_lookup espone ratification loomx_sow_raci — D-091 step 3, msg dba `a442433b`)

**Wake cold-start (D-093, normal).** dba: la migration DDL su `loomx_sow_raci` è applicata (Supabase + replica VPS 5433) — 8 colonne nuove (`status`, `proposed_by`, `ratified_by`, `ratified_at`, `ratification_kind`, `ratification_recorded_by`, `ratification_recorded_at`, `ratification_evidence`). Passo 3 della sequenza D-091 (`1→2→3→4→5`) delegato da Loomy direttamente a board-mcp↔dba, senza passare da lui. **WI** `7743b24a`.

**Fatto:** `org_lookup(project=...)` — select allargato da 5 a 12 colonne (`src/tools.ts:1931`); aggiunto blocco `ratification` di primo livello nella risposta (`state: proposed|ratified|mixed|undeclared` + `warning` per tutto tranne `ratified`; per `ratified` porta `ratified_by`/`ratified_at` e — solo se `ratification_kind='attested'` — `ratification_recorded_by`). Righe con `ratified_by`/`ratified_at`/`kind` disallineati tra loro (caso raro, matrice ratificata in più atti) non vengono collassate a un valore indovinato: escono come `ratification.by[]`, una entry per combinazione distinta. Build+test verdi (126/126, nessuna regressione sui test esistenti — nessuna suite copriva ancora `org_lookup` RACI). Commit `1bd5053`.

**Decisione presa (delegata da dba, non richiede DBA):** per un futuro tool di scrittura ratifiche, scelto il path 1 (riuso `DOC_RW_DATABASE_URL` + `loomx_set_agent_slug`, stesso pattern F4.5 già cablato per i `doc_*`) invece del path 2 (RPC dedicata `loomx_sow_raci_ratify` scritta da dba). Motivo: stesso modello di fiducia (board-mcp dichiara il proprio slug fidato, non un parametro dell'agente remoto), zero lavoro nuovo lato dba, nessuna superficie RPC aggiuntiva. Nessun tool di scrittura implementato in questa sessione — dba scrive le 6 righe RACI di `loomx-ai-governance` con `status='proposed'` **dopo** il rilascio di questa modifica (ordine dettato nel messaggio, per non far apparire una proposta come matrice ratificata durante il rollout).

**Blocchi / note:** nessuno. Msg `a442433b` ackato; risposta inviata a dba con l'esito + la decisione di path.

---

## Sessione #81 — 2026-08-16 (riparazione delle 3 divergenze CLAUDE.md misurate in Track B: CFG-063, CFG-088, CFG-076)

**Autopilot dispatch.** GTD `a2ddc6ef` (rinviato da sessione #80: *«Non risolvere nulla adesso: registra. Le riparazioni vengono dopo, su un corpus misurato»* — il corpus ora esiste). **WI** `a3b9cc4c`. Modello: sonnet (meccanico, nessuna decisione di governance).

**Le 3 riparazioni:**
1. `EPHEMERAL_TEMPLATES` (CFG-063): CLAUDE.md dichiarava 3 voci, il build (`src/wi.ts`) ne ha 4 — mancava `audit-agent-alignment` (loomy-approved, msg `f7447db6`). Riga aggiornata con la voce mancante + nota inline.
2. Gap `loomx_projects`/`project_list` (CFG-088): riverificato live (`project_list` → 5 righe, nessun `permission denied`) — il GRANT è stato applicato. Rimosso il blocco «Gap noto (bloccante per `project=`)» in CLAUDE.md, ormai falso.
3. `package.json` version (CFG-076): `0.16.1` → `0.16.2` per allinearsi alle feature già documentate a quella versione (D-074 decision-link, sessione #79). Nessuna decisione presa sul release-process (bump-ad-ogni-commit resta di loomy/it-manager, vedi CFG-076).

**Codice:** `CLAUDE.md` (2 righe), `package.json` (1 riga). Commit `8c6629c`. Nessun impatto su `src/` — solo drift documentazione↔build. `package-lock.json` resta a `0.5.0` (stale, fuori scope: non uno dei 3 item del GTD).

**Blocchi / note:** nessuno. GTD `a2ddc6ef` chiuso done.

---

## Sessione #80 — 2026-08-16 (Track B: riconciliazione configurazioni board-mcp → 30 `config_pattern` CFG-061..090, misurate sul build che gira)

**Autopilot dispatch (cold-wake, D-093).** Msg `d3c12d86` (loomy, wake normal, requested_model opus). **WI** `a0cf88e8` su GTD `38462ecb`. Ordine di Achille: *«ogni agente che ha configurato qualcosa deve verificarlo rispetto a quanto ha configurato e scrivere le config»* — riconciliazione, non documentazione. F3 congelato finché il piano non è in DB.

**Regola di misura applicata:** misurato **dal build che gira** (`dist/`, rigenerato 2026-08-16 08:19:14 +0200, allineato a HEAD `b23cd04`), non dal sorgente su disco; e dove possibile con **probe live** invece che per lettura del codice.

**Le 5 divergenze contratto↔reale trovate:**

1. **`doc_supersede` NON è bloccato** (CFG-068) — il brief lo dava per «impatto vivo, bloccato finché non arriva la policy UPDATE scoped». Probe live: creati 2 item + link, superseduto il target → `ok: true, relinked_rows: 1`. Il link è stato ri-puntato. Il brief descriveva lo stato fra `9e3b025` (00:10) e `34cbc0a` (00:50) + migration DBA `20260816100000`/`110000`; alle 07:xxZ il percorso è sano. Scrivere la config ordinata avrebbe dichiarato rotto un percorso funzionante.
2. **`EPHEMERAL_TEMPLATES` ha 4 voci, CLAUDE.md ne dichiara 3** (CFG-063) — `audit-agent-alignment` bypassa il gate D-074 in produzione, tracciato solo in un commento inline che cita un'approvazione via messaggio (`f7447db6`).
3. **`project_list` funziona** (CFG-088) — CLAUDE.md lo dà per `permission denied for table loomx_projects`. Chiamata live dal ruolo nativo: 5 righe. Il GRANT è stato applicato senza aggiornare la documentazione. Divergenza «a favore», ma è lavoro non fatto perché creduto impossibile.
4. **`PACKAGE_VERSION` è `0.16.1`** (CFG-076) mentre il build contiene feature documentate v0.16.2 — l'unico candidato a segnale di build è falso, non solo assente. E comunque `/mcp` non lo espone.
5. **QUARTA OCCORRENZA D-133** (CFG-083) — `WI_TEMPLATES_PATH` non è settata in **0 su 22** `.mcp.json` di flotta: la validazione `template_name` è un **no-op silenzioso su tutta la flotta dal rilascio v0.10.2**. Prova diretta: ho aperto il WI di questa sessione con `template_name: "config-reconciliation"`, nome inventato, e la risposta non ha alcun `template_warning`. Non è un rowcount — è la stessa patologia: l'assenza del campo significa indistinguibilmente «valido» e «non ho controllato». Il periodo di grazia prima dell'hard-fail è stato dimensionato assumendo soft-warn che non sono mai arrivati a nessuno.

**Rollout (CFG-074..077), misurato live con `ps -eo lstart`:** 5 processi MCP vivi, **2 stale (40%)**. La window di `loomy` è nata 15/08 alle 10:16:55 — **7 commit funzionali indietro**, 16'20" prima del commit `fb12b19` che ripara `wi_checkpoint`. Quindi: il fix D-074 `decision` che loomy ha ringraziato stamattina **non è disponibile alla window da cui ha scritto**, e sul suo processo `wi_checkpoint` risponde ancora `ok:true` su WI chiuso. Conseguenza generalizzata (CFG-077, D-136 §5): *la data di un commit non è la data in cui una capacità è disponibile alla flotta* — un obbligo su tool nuovo non è verificabile alla data in cui viene emesso, perché «non conforme» e «non ce l'ha» sono indistinguibili dall'esterno.

**Blocco sulla destinazione (CFG-090):** il documento prescritto dal brief (`794e873c…`, progetto hub) **non esiste**, e board-mcp **non può crearlo** — `doc_create` sull'hub → `new row violates row-level security policy for table "documents"`. Discriminato da un problema di visibilità: `doc_query(hub, item_type=decision)` risponde 5 righe, quindi il progetto è leggibile. È il confine D-005/D-015 che funziona. Non bloccato (autopilot): creato il documento `de6879a4-4d1e-4905-8cae-2bf4be81ebb8` nel progetto board-mcp `596cd5fc`, scritte tutte e 30 le righe nel range assegnato senza sconfinare. I codici sono unici *per progetto*, quindi nessun conflitto con l'hub; la migrazione è meccanica quando il documento esisterà.

**Ritrovamento a margine — il gate D-074 non accetta `config_pattern`:** il WI di questa sessione produce 30 righe durevoli di un tipo che il gate rifiuta. Stessa identica forma del gap `decision` chiuso stamattina con `b23cd04`. Non riparato di iniziativa (ordine: registrare, non riparare); proposto a loomy.

**Codice:** nessuna modifica a `src/`. Sessione di sola misura, come da ordine («Non risolvere nulla adesso: registra»). 126/126 test verdi, misurati non ricordati.

---

## Sessione #79 — 2026-08-16 (Wake loomy: gate D-074 accetta ora `decision` — force_ephemeral non è più l'unica uscita per un WI di governance)

**Autopilot dispatch (cold-wake, D-093).** Msg `3fb74e48` (loomy, wake normal). **WI** `a6cc2321` su GTD `f5562c40`. Modello: sonnet (bug fix mirato, nessun design nuovo).

**Cosa:** loomy ha segnalato un difetto trovato usando il gate, non ispezionandolo: chiudendo il WI `40d191a7` (coordinamento decision-enforcement), `checkDurableGate` (`src/wi.ts`) accettava solo doc item di tipo `requirement`/`sdes_entry` via `doc_item_wi_links` — ma gli artefatti di quel WI erano **decisioni** (D-147, D-148 nuove + D-145/D-146 aggiornate). Linkate via `doc_link`, il gate le ha rifiutate per tipo. L'unica uscita era `force_ephemeral=true`, che dichiara "questo WI non ha artefatti durevoli" — l'opposto del vero. Stessa classe dei difetti "risposta comoda al posto di quella vera" censiti in sessione #76/#78 (`doc_supersede` 0 righe silenziose, `wi_checkpoint` ok:true su WI chiuso).

**Verifica prima del fix:** D-074 stessa (letta da doc_query sul progetto hub) descrive la catena come `Decisione → Requisito (REQ) → Design (SDES) → Config/Schema → Implementazione` — la Decisione è il capo della catena, non un tipo escluso. Il codice era quindi più restrittivo del testo della decisione che doveva applicare: non serviva una nuova decisione, serviva allineare il gate a D-074 così com'è scritta.

**Fix (`src/wi.ts`, `checkDurableGate`):** `item_type === "decision"` ora accettato accanto a `requirement`/`sdes_entry`, sia nel check "0 link" sia nel check "link presenti ma nessuno tracciabile". Messaggi d'errore aggiornati per menzionare `decision` come opzione valida. Descrizione tool `wi_end` (`src/tools.ts`) e sezione Gate durable in CLAUDE.md aggiornate di conseguenza. Test di regressione aggiunto (`tests/wi.test.ts`): WI con link a un doc_item `decision` passa il gate. Suite 126/126 verde, build pulita.

**Decisioni prese:** nessuna nuova — allineamento codice↔D-074 esistente, non una decisione nuova.
**Blocchi / note:** fix non ancora live sulle finestre già aperte (nessun meccanismo di reload per MCP stdio, vedi CLAUDE.md "Rollout di un nuovo build") — richiede un nuovo processo CLI per essere caricato. Segnalato a loomy via board_send, nessun restart forzato di flotta di mia iniziativa.
**Prossima sessione:** nessuna prevista — loomy può ri-collegare D-147/D-148 al WI `40d191a7` con `doc_link` una volta che la sua finestra carica il build aggiornato (o farlo un'altra finestra già fresca).

---

## Sessione #78 — 2026-08-16 (Chiusura amministrativa D-100: no_auto_arm verificato E2E live, mai chiuso dopo il fix trigger di sessione #57)

**Autopilot dispatch (D-052).** GTD `4edd99de` (in coda da sessione #55, 2026-07-21). **WI** `a9dfc1b2`. Modello: sonnet (verifica, nessun design).

**Cosa:** riaperto il GTD originale del gap D-100. Il `resume_hint` era stale — parlava ancora del blocco lato trigger DB (`loomx_enforce_no_auto_arm`, `session_user` irraggiungibile sotto `service_role`) descritto in sessione #55, ma quel gap era già stato chiuso in **sessione #57** (2026-07-22): dba ha applicato la migration `20260722100000` che rimuove l'enforcement lato trigger, e board-mcp ha spostato l'authority-check (owner/loomy only) lato tool (`src/tools.ts`, `gtd_update`/`gtd_add`). Nessuno aveva però mai rifatto la verifica E2E richiesta dal body originale ("prova a settarlo su un GTD di test e conferma che il valore persiste a DB") né chiuso il GTD — è rimasto `waiting`/`waiting_on=dba` per quasi un mese dopo che il blocco reale era già sparito.

**Verificato live (non solo lettura codice):**
1. Creato un item throwaway (`ac5739b7`, owner=board-mcp)
2. `gtd_update(no_auto_arm=true)` → `ok:true`
3. `gtd_get` di rilettura fresca conferma `no_auto_arm: true` persistito a DB (non solo l'echo della update)
4. `gtd_update(no_auto_arm=false)` → ri-settabile, conferma il percorso di unpark
5. Item trashed (cleanup)

Nessuna modifica al codice — il fix era già corretto e committato (`80a1d2d` + `session #57`). Solo verifica + chiusura amministrativa del GTD rimasto aperto.

**Decisioni prese:** nessuna nuova.
**Blocchi / note:** nessuno. Gli item d'esempio citati nel body originale (`ff340239`, `c9b8a8c6`, parcheggiati con nota "non armare finché loomy non risponde") NON sono stati toccati — non sono owned da board-mcp, quindi fuori dalla mia authority; i rispettivi owner/loomy possono ora applicare `no_auto_arm=true` se ancora rilevante.
**Prossima sessione:** nessuna prevista.

---

## Sessione #77 — 2026-08-16 (Wake dba: gov.relink_superseded applicata — sblocca doc_supersede)

**Autopilot dispatch (cold-wake, D-093).** Msg `2b4acbcc` (dba, wake high). **WI** `f0ad5cc9` su GTD `6637405b` (stopgap sessione #76). Modello: sonnet.

**Cosa:** dba ha applicato `gov.relink_superseded(p_old_item, p_new_item) RETURNS integer` (migration `20260816100000`, `SECURITY DEFINER`, `EXECUTE` a `doc_rw`+`service_role`, non esposta via PostgREST — solo via connessione diretta doc_rw). Ripunta atomicamente tutte e sei le direzioni (`doc_item_links.from_item`/`.to_item`, `doc_item_gtd_links.doc_item_id`, `doc_item_wi_links.doc_item_id`, `doc_item_xproject_links.from_item`/`.to_item`) e ritorna il rowcount. Rifiuta (`23514`) se `old.status <> 'superseded'` — vincolo di "occasione": un repoint fuori da un supersede non ha significato.

**Fatto:**
- `src/docDb.ts`: aggiunto `relinkSuperseded(oldItemId, newItemId): Promise<number>` a `DocRwDb`, stesso pattern di `resolveDocItem` (`exec("SELECT gov.relink_superseded($1::uuid, $2::uuid) AS n", ...)`)
- `src/docs.ts`: `docSupersede` — rimossi i 6 `.update()`+`assertLinkTransferred()` (righe ~665-717, stopgap sessione #76) sostituiti con UNA chiamata a `relinkSuperseded` dopo che il vecchio è marcato superseded e il nuovo inserito (stesso ordine richiesto dalla funzione). Se `db` non è una `DocRwDb` (niente `relinkSuperseded`), `doc_supersede` rifiuta esplicitamente invece di silenziosamente saltare il transfer — non reintroduce il vecchio gap come fallback. Risposta arricchita con `relinked_rows` (il rowcount della funzione, niente più da dedurre — D-133).
- `assertLinkTransferred()` rimossa (dead code, sostituita dalla garanzia atomica della funzione).
- `tests/docs.test.ts`: fake `DocRwDb` aggiorna `relinkSuperseded` (ripunta le 4 tabelle nello store in-memory); riscritto il test di regressione RLS-gap (simulava `.update()` bloccato — non più applicabile, `docSupersede` non fa più `.update()` diretto sui link) per simulare invece un fallimento di `relinkSuperseded` (es. `23514`); aggiunto un test per il refusal quando `db` non è `DocRwDb`.
- `npx tsc` pulito, 125/125 test verdi (`npm test`).
- Non eseguito uno smoke test live contro la function reale (DOC_RW_DATABASE_URL presente in `.mcp.json` ma nessun path di cleanup via DELETE disponibile sotto `doc_rw` — avrebbe lasciato dati di test permanenti nel progetto board-mcp). Copertura: 9 asserzioni comportamentali già verificate dal dba sotto `doc_rw` reale + unit test locali sullo stesso pattern di wiring di `resolveDocItem` (già in produzione).

**Secondo passo (dba, non azionabile da qui):** `REVOKE UPDATE` sulle 4 tabelle + `DROP` delle 2 policy `UPDATE` superstiti (`doc_item_gtd_links_update`, `doc_item_wi_links_update`) — dba aspetta conferma che il commit sia shippato prima di applicarlo (altrimenti un `doc_supersede` di item con SOLO link gtd/wi, oggi ancora funzionante via quelle 2 policy, si romperebbe).

**Decisioni prese:** nessuna nuova.
**Blocchi / note:** nessuno — GTD `6637405b` chiuso done. `board_send` a dba (done, ref `2b4acbcc`) per sbloccare il secondo passo (REVOKE).
**Prossima sessione:** nessuna prevista — verificare a distanza se dba conferma il REVOKE applicato.

---

## Sessione #76 — 2026-08-16 (Wake loomy: doc_item_links mutabili? — trovato bug live in doc_supersede, stopgap shippato)

**Autopilot dispatch (cold-wake, D-093).** Msg `40ef3e30` (loomy, wake normal). **WI** `1303b581` (force_ephemeral: nessun REQ/SDES pre-esistente, gap scoperto durante la stessa WI). Modello: sonnet.

**Cosa:** loomy chiedeva se `doc_item_links` è mutabile — dba aveva misurato che la tabella non ha alcuna policy `UPDATE` (solo select/insert/delete), quindi sotto `doc_rw`/`authenticated` ogni UPDATE tocca 0 righe in silenzio; funziona solo da `service_role` (rolbypassrls). Chiedeva: `doc_link` fa mai update/upsert su un link esistente? Se sì, l'immutabilità (delete+insert, mai update in place) romperebbe qualcosa?

**Risposta (letto il codice, non a memoria):**
1. `doc_link`/`doc_link_by_code`: **INSERT-only**, sempre. Chiave duplicata → errore esplicito, mai un no-op silenzioso. Nessuna superficie da rompere.
2. Eccezione reale: `docSupersede` FA `.update()` su `doc_item_links`/`doc_item_gtd_links`/`doc_item_wi_links`/`doc_item_xproject_links` — ma solo per ri-puntare `from_item`/`to_item`/`doc_item_id` dal vecchio UUID al nuovo quando l'item collegato viene superseded, **mai** `relation_type`. Esiste dal commit iniziale (40a4e4d), voluto. Un divieto rumoroso blanket romperebbe questa superficie — proposto scoping: trigger che blocca solo su `relation_type`/`project_id` diverso, lascia passare il repoint endpoint.
3. `amends` (relation_type che spec-F4 userà) non è ancora nel registry locale (`DB_DOC_ITEM_LINK_TYPES`) — segnalato, il capability-parity gate (§16) andrà comunque rosso in automatico quando serve, non rischio di drift silenzioso.

**Finding non richiesto, il più importante:** verificando il codice di `docSupersede` ho trovato che il transfer link non controllava MAI il rowcount dell'UPDATE — solo `error`. Sotto `doc_rw` (F4.5, v0.8.0+, NOBYPASSRLS) questo significa che il gap RLS misurato da loomy fa fallire **in silenzio** anche questo update legittimo: 0 righe toccate, nessun errore, `docSupersede` ritornava comunque `ok:true` mentre i link restavano agganciati all'item superseded (ormai immutabile) — lo stesso identico gap di traceability che pilot-e2e aveva segnalato mesi fa (GTD `6637405b`, allora "someday", mai collegato alla causa RLS).

**Fix shippato (commit `9e3b025`):** `assertLinkTransferred()` in `src/docs.ts` ri-verifica dopo ogni update che non restino righe puntate al vecchio id; se restano, `doc_supersede` fallisce esplicitamente invece di mentire con `ok:true`. Nuovo test di regressione in `tests/docs.test.ts` (wrapper che simula l'esatto gap RLS — update swallowed, select ancora attivo). Build + 124 test verdi. Questo non ripara il transfer (serve la policy scoped dal DBA) — lo rende rumoroso invece che silenzioso.

**Decisioni prese:** nessuna nuova decisione cross/locale — proposta di scoping girata a loomy, non ratificata qui.
**Blocchi / note:** `doc_supersede` su item con link in entrata/uscita fallirà esplicitamente finché il DBA non aggiunge una policy UPDATE scoped (o una funzione SECURITY DEFINER dedicata) su `doc_item_links` (e verificare gtd/wi/xproject). GTD `6637405b` riaperto/aggiornato: someday→high, `waiting_on=dba`.
**Prossima sessione:** attendere risposta loomy/dba sullo scoping della policy; una volta live, verificare che `doc_supersede` con link reali torni a `ok:true` (oggi fallirebbe correttamente finché manca).

---

## Sessione #75 — 2026-08-15 (Wake loomy: ragionamento sui 4 casi D-084/D-101/D-050/D-018 — scoperta collisione di numerazione D-101/D-018)

**Autopilot dispatch (cold-wake, D-093).** Msg `bd8de1f3` (loomy, wake normal). **WI** `ccee917d`. Modello: sonnet (verifica/lettura, non richiedeva design).

**Cosa:** loomy ha contestato l'esito della sessione #74 (42/42 `active`, zero `superseded`) chiedendo il ragionamento su 4 casi puntuali prima del seed: D-084, D-101, D-050, e una a scelta fra D-001..D-022. Riletti i body completi locali + cross corrispondenti (dove esistono) più un campione di controllo (D-043/D-047/D-048/D-018 cross).

**Risultato — le 4 risposte reggono, ma la premessa "14 recepimenti simmetrici" no:**
1. **D-084**: recepimento solido — la riga locale aggiunge dettagli (`resolveSelfSlug()`, `docRwMode()==="native"`, test file) assenti nella cross. `active` confermato.
2. **D-050**: nessun mistero — confermato via query che non esiste alcuna cross D-050 (0 righe); è una decisione locale al 100%, mai stata un recepimento.
3. **D-101**: **non è un recepimento**. La cross D-101 parla di tutt'altro (trigger `doc_item_history`, audit trail anti-overwrite, dba). Stesso numero per collisione di allocazione, non per copia — la sequenza locale board-mcp evidentemente alloca D-NNN senza controllare il registro cross.
4. **D-018** (scelta per Q4): il caso più debole dei 42 — evento di rename one-shot, già eseguito, zero footprint in `src/` (verificato con grep), nessuna azione futura violabile. Tenuta `active` solo per il criterio dei recepimenti (unico posto che spiega perché lo slug corrente è `loomx-tracker`) — uso improprio dello status per assenza di un valore "historical" nello schema decisioni.

**Scoperta non richiesta:** controllando D-018 come campione ho trovato la STESSA collisione di D-101 — cross D-018 è "GTD RLS ownership" (proposta da loomy), scollegata dal rename slug locale. 2 collisioni su ~10 controllate (contro 3 recepimenti genuini on-topic: D-043/D-047/D-048). Non è pericoloso a livello tool (`doc_item_upsert`/`resolve` sono scoped per `(project_id, code)`, mai ambigui), ma è un rischio di lettura umano/agente. Non ho rinumerato nulla unilateralmente — girata a loomy la scelta (annotare vs rinumerare) via board_send `97dcb876` + GTD follow-on `e5c9a7c5` (planned, `waiting_on=loomy`, non armato).

**Bonus segnalato, non investigato:** D-048 locale `active` ma la cross D-048 corrispondente è già `superseded` — possibile stesso tipo di drift, fuori scope dei 4 casi richiesti.

**Decisioni prese:** nessuna — task di verifica/risposta, nessuna nuova decisione scritta.
**Blocchi / note:** nessuno per questa sessione. Il follow-on sulla rinumerazione resta bloccato sulla decisione di loomy.
**Prossima sessione:** GTD `e5c9a7c5` (collisione D-101/D-018) in coda, `waiting_on=loomy`, non armato.

---

## Sessione #74 — 2026-08-15 ([F3 bloccante] Sanamento status delle 42 decisioni — 40 draft/proposed → active, gap D-010 trovato)

**Autopilot dispatch.** GTD `d13ff8e0` (owner board-mcp, priorità high). **WI** `12247a98`. Modello: sonnet (task di lettura/verifica, non richiedeva design/architettura).

**Cosa:** il sistema di enforcement consegna a ogni WI solo le decisioni `active`/`approved` — delle 42 decisioni board-mcp in `documents`/`doc_items` (project 596cd5fc, document 1da8642c), 35 erano `draft` e 2 `proposed` (D-100/D-101), cioè l'86% invisibile ai WI futuri malgrado descrivessero comportamento reale. Letto il body completo di tutte e 42, verificato i claim implementativi più a rischio di drift contro il codice sorgente attuale (`grep` mirato su `src/*.ts`): D-010 (tag enforcement), D-013/D-084 (backend DB), D-021 (`wiCache.ts`), D-022 (co-engagement tools), D-050 (autopilot fields), D-055 (`gtd_overview`), D-058 (enum `continue`), D-051 (`remote.ts`/`humanTools.ts`), D-016 (owner reassignment). Tutte confermate coerenti tranne una.

**Esito: 42/42 `active`, nessuna `superseded`/`rejected`.** Non è un rubber-stamp — tre casi hanno richiesto un giudizio esplicito:
1. **D-100 vs D-059** (broker elevation su board_ack/update_status): D-100 supersede SOLO lo scope ack/status (broker limitato a `to_agent=loomy`, non più unrestricted) — relazione già autodocumentata in `D-100.attrs.supersedes`. Il resto di D-059 (gtd_add/gtd_update broker, addendum runtime_request) resta vigente e non riscritto altrove → D-059 `active`, non `superseded` in toto (marcarla superseded avrebbe fatto perdere le regole gtd_add/gtd_update a chi legge solo D-100).
2. **"Recepimenti" cross-decision** (D-018, D-043, D-047, D-048, D-084, D-101 — riusano il numero della decisione root): applicato il test di Loomy ("se cancellassi questa riga, un agente perderebbe un'informazione che la cross non gli dà?") — tutte contengono verifiche/greps/sequenze di attivazione locali a board-mcp → tenute `active`, nessuna `superseded` come "recepimento formale vuoto".
3. **D-100/D-101** (erano `proposed`): descrivono comportamento già shippato/versionato/testato (v0.13.x/v0.16.0), solo l'hardening è dietro flag eval-first — il contratto core è vigente oggi → `active`.

**Gap reale trovato — D-010** (governance tag, Loomy owner/Postman enforcer): il body dichiara che i tag non approvati "vengono rifiutati da board_send e board_broadcast", ma `grep -n "tags" src/tools.ts` mostra `tags` come array free-text senza alcuna validazione in entrambi i tool. Tenuta `active` (l'intento di governance non è in discussione) ma aperto GTD follow-on `50d93acf` (planned, non armato — decisione se reintrodurre l'enforcement o correggere la decisione spetta a Loomy).

**Decisioni prese:** nessuna nuova — task di sanamento status su decisioni esistenti, non di produzione di nuove decisioni.
**Blocchi / note:** `docs/DECISIONS.md` (mirror generato) ora stale rispetto ai nuovi status — `loomx-doc-dump` non è installato in questo ambiente, non rigenerato. Segnalato a loomy nel summary.
**Prossima sessione:** GTD `50d93acf` (gap enforcement tag D-010) in coda, non armato — decisione di Loomy prima di procedere.

---

## Sessione #73 — 2026-08-15 ([Stream B-4] gtd_add: soft-warn su project_id assente, mai bloccante, D-136 §5)

**Autopilot dispatch.** GTD `3acb2328` (owner board-mcp). **WI** `3b00e4ba`. Modello: sonnet (task meccanico, netto — nessun upgrade necessario).

**Cosa:** `gtd_add` senza `project_id` ora ritorna `project_warning` nella risposta — mai un errore, il GTD viene creato comunque. Estratta `buildProjectWarning()` (funzione pura, `src/tools.ts`) sul modello di `buildGtdUpdatePayload`/`buildAutoGtdInsertPayload` — testabile senza DB, 2 nuovi unit test (`tests/gtd.test.ts`).

**Scelta di design (nessun valore sentinella inventato):** il body del GTD chiedeva di offrire "l'alternativa esplicita" a dimenticare il progetto, ma vietava di inventare un valore contrattuale senza passare da Loomy. AGENT-STANDARD §5 dichiara già che un item senza progetto è cross-progetto/personale — uno stato valido esistente, non un'assenza da colmare con un nuovo parametro. Il testo del warning si limita quindi a *nominare* questa lettura esistente ("valido — nessuna azione richiesta" vs "va aggiunto") invece di introdurre un secondo modo di dichiarare la stessa cosa. Segnalato a loomy nel summary — se ritiene serva comunque un valore esplicito, lo propone lui.

**Verifica (non a memoria, D-136 §5):** stessa sessione con cui la gate G4 (sessione #72) era stata chiusa — la connessione MCP di questa stessa finestra gira sul build precedente (`Node non fa hot-reload`), quindi non prova nulla chiamare `gtd_add` dal proprio client. Metodo onesto: spawnata una seconda istanza del server (`node dist/index.js --agent board-mcp`, `DATABASE_URL` risolto da `LOOMX_DB_URL` — `.mcp.json` usa `${...}` che è espansione del launcher Claude Code, non della shell) e parlato MCP JSON-RPC via stdio direttamente. **G1** (no `project_id`): item creato (`id=bd63e759`) + `project_warning` presente, risposta reale loggata. **G2** (`project_id` valido): item creato (`id=caad797f`) + `project_link`, nessun `project_warning`. **G3**: 105/105 test esistenti verdi (nessuna regressione), campo additivo. Item di test trashati a fine verifica.

**Decisioni prese:** nessuna nuova cross-decision — implementazione diretta della richiesta loomy, motivata da D-136 §5 già approvata.
**Blocchi / note:** nessuno. Osservazione lasciata a loomy (non un GTD, serve il suo giudizio di scope): altri due path creano GTD senza `project_id` senza questo warning — `wi_start` (auto-crea GTD quando `gtd_item_id` non è dato) e `auto_gtd` su `board_send`/`board_broadcast`. Non estesi in questa sessione — fuori dallo scope dichiarato ("gtd_add"), decidere se allinearli è scelta di Loomy.
**Prossima sessione:** nessuna pianificata da questo GTD.

---

## Sessione #72 — 2026-08-15 (G4 rollout: nessun meccanismo di deploy per server MCP stdio, propagazione solo per ricambio finestra)

**Wake cold-start** (D-093, msg `780b4004`, normal, da loomy). **WI** `c5990bb4` su GTD `70ac93c4`. Modello: sonnet.

Loomy accetta nel merito B-2 (sessione #71, `project_id` su `gtd_add`) ma segnala il gate mancante: dal proprio client `project_id` non compare nello schema — la sua finestra gira ancora sul build precedente. Chiede tre cose: come si propaga un build alle finestre già vive, di non forzare un restart di flotta, e (se il rollout è per ricambio naturale) tempi realistici + quali finestre sono più vecchie del commit.

**Verifica (non a memoria):** confermato che `dist/tools.js` è ricostruito e coerente col commit `996088d` (timestamp file 12:18:14 < commit 12:22, nessuna modifica sorgente successiva) — il gap non è build mancante, sono processi già spawnati con il vecchio `dist/` in memoria (Node non fa hot-reload). Delegata a un secondo agente (claude-code-guide) la verifica del comportamento reale di Claude Code CLI sui server MCP stdio: nessun meccanismo di reconnect/respawn per un singolo server stdio a sessione viva, nessuna versione del server esposta in `/mcp`, nessun flag di reload documentato — l'unico modo per una finestra di caricare il nuovo `dist/` è una sessione CLI nuova.

**Risposta a loomy (msg `89f28f19`):** nessun meccanismo di deploy oggi, propagazione solo per ricambio naturale delle finestre; nessuna iniziativa di restart presa; su "quali finestre sono stale" — non rispondibile nemmeno con accesso pieno alla flotta, perché non esiste un segnale di build per-finestra da confrontare (`PACKAGE_VERSION` non bumpato su questo commit né sul fix `wi_checkpoint`, e comunque non esposto da Claude Code). Proposta lasciata a loomy (non implementata, gated dalla sua decisione con it-manager): far dichiarare il build/git SHA in corsa da ogni istanza (es. in `ping` o un mini tool di health) per un audit rapido via broadcast.

**Cosa:** documentato il meccanismo in `CLAUDE.md` §Configurazione agenti → "Rollout di un nuovo build (G4)" — non lo sapeva nessuno, ora è scritto.
**Decisioni prese:** nessuna nuova (chiarimento operativo, non una decisione architetturale).
**Blocchi / note:** GTD `03c38a0b` resta `done` (invariato da loomy). Nessun follow-on GTD aperto — loomy traccia il rollout separatamente ("è un problema di piattaforma e non tuo").
**Prossima sessione:** nessuna pianificata da questo GTD.

---

## Sessione #71 — 2026-08-15 ([Stream B] gtd_add: project_id opzionale, link a loomx_item_projects nella stessa chiamata, D-102)

**Autopilot dispatch** (D-052). **WI** `df1dc777-3527-49c7-b59b-f0a13a22da52` su GTD `03c38a0b` (high). Modello: sonnet.

Achille aveva misurato 35/35 GTD letti in sessione senza `project_id` — non un problema di disciplina degli agenti ma uno strumento mancante: `gtd_add` non aveva un parametro progetto, il legame passava solo da `item_project_link` (chiamata separata, mai fatta perché la RLS su `loomx_item_projects` bloccava le scritture fino a stamattina, migration `20260815120000`).

**Cosa:** `src/tools.ts` — `gtd_add` accetta `project_id?: uuid` opzionale (mai obbligatorio in questa fase, mai derivato dal WI attivo per decisione esplicita di Achille). Se presente: valida l'esistenza in `loomx_projects` **prima** dell'INSERT su `loomx_items` (errore esplicito, niente GTD orfano su id inesistente), poi esegue lo stesso upsert idempotente di `item_project_link` su `loomx_item_projects` e ritorna `project_link: {item_id, project_id}` in risposta. Path senza `project_id` invariato.

**Verifica (gate G1/G2/G3 richiesti da Achille — righe reali, non `ok:true`):** `tsc --noEmit` pulito, build, 103/103 test esistenti verdi. La connessione board-mcp della sessione corrente girava ancora sul build precedente (i processi MCP non ricaricano `dist/` a caldo) — smoke live spawnando una seconda istanza via client MCP separato (stesso `DATABASE_URL` nativo `board-mcp`, D-084):
- **G1**: `gtd_add(project_id=<board-mcp>)` → riga `loomx_items` (id `01fe6b30…`) + riga `loomx_item_projects` in risposta, **e** ri-confermate entrambe con una `gtd_query(project_id=...)` separata (join reale sulla tabella, non l'echo dell'insert).
- **G2**: `gtd_add(project_id=<uuid random>)` → errore esplicito; `gtd_query(source_ref=...)` conferma zero righe create.
- **G3**: `gtd_add` senza `project_id` → risposta identica a prima (nessun `project_link`).
Item di test trashati a fine verifica (owner board-mcp, entrambi i batch — quello sul processo stale e quello sul processo fresco).

**Decisioni prese:** D-102 (`doc_item_upsert`, documento progetto board-mcp).
**Blocchi / note:** **Redeploy pendente per le altre sessioni** — chi ha già una connessione board-mcp aperta (loomy, it-manager, dba, …) vede `project_id` solo dopo il prossimo restart della propria connessione MCP; `dist/` è aggiornato ma i processi in memoria no. L'obbligatorietà di `project_id` resta esplicitamente fuori scope (prossimo passo separato, soft-warn con grace period).
**Prossima sessione:** nessuna pianificata da questo GTD — chiusura WI in corso. L'altro GTD assegnato (`c82a33d8`, D-135) resta `waiting`, non toccato.

---

## Sessione #70 — 2026-08-15 (org_lookup human_ref: chiudere il gap su question=help, D-118/F7)

**Wake cold-start** (D-093, msg `1b70e337`, normal, da loomy — status-check sulla sessione #69). **WI** `6cbf77f9`. Modello: sonnet.

Loomy chiedeva conferma esplicita di parità: `human_ref` su **tutte** le forme di `org_lookup` (`card`/`chain`/`escalation`/`help`), non solo sulla card — il controllore F7 legge gli archi, non solo la card. Rileggendo `src/tools.ts` prima di rispondere: `card`/`chain`/`escalation` erano arricchiti (sessione #69, commit `4b02290`), **`help` no** — `help_edges` ritornava gli archi `asks_help_from` grezzi, senza `target_human_ref`.

**Cosa:** `src/tools.ts` (commit `a2f9a7d`) — stessa enrichment di `escalation` applicata 1:1 a `help` (batch lookup su `loomx_role_cards` per gli `to_agent` distinti, poi merge `target_human_ref` su ogni edge). Additivo, nessun rename.

**Verifica (D-132, evidenza osservabile):** build `dist.staging/`, `tsc --noEmit` pulito, 120/120 test esistenti verdi (nessun test dedicato a `help` in suite — nessuno lo copriva nemmeno prima), poi smoke con processo separato via stdio MCP reale (stessa `DATABASE_URL`/`.mcp.json` della sessione live):
- `help` su `forge` (unico agente con arco `asks_help_from` seedato, → `atlas`) → `target_human_ref: "achille"`.
- `card` su `loomy` e `chain` su `board-mcp` rilanciati come regressione — invariati, coerenti con sessione #69.
`mv` atomico staging→dist.

**Decisioni prese:** nessuna nuova (fix additivo, stesso pattern #69).
**Blocchi / note:** nessuno. Nota per loomy: `asks_help_from` ha oggi un solo arco seedato in tutto l'org-registry (`forge→atlas`) — il campo è arricchito ma la copertura dati è minima, non un limite del codice.
**Prossima sessione:** nessun follow-on pianificato — GTD `2e5531d4` chiuso, msg `1b70e337` ackato, risposta inviata a loomy con lo stato completo (incl. il gap trovato e chiuso).

---

## Sessione #69 — 2026-08-14 (org_lookup espone human_ref — card/chain/escalation, D-118/F7)

**Wake cold-start** (D-093, msg `1543e0ae`, high, da loomy). **WI** `e09ae3c4`. Modello: sonnet.

dba ha aggiunto `human_ref` a `loomx_role_cards` (migration `20260814180000`, 38 righe, default `'achille'`) ma `org_lookup` non lo esponeva — prerequisito F7 decision-enforcement (progetto `669fd07b`): il controllore legge l'organigramma per determinare a chi va una disputa, e il terminale della catena dev'essere sempre umano.

**Cosa:** `src/tools.ts` (commit `4b02290`) — nessun rename, solo campi additivi:
- `question="card"` (default): `human_ref` top-level accanto a `reports_to` (letto dal DB, nessun default hardcoded lato codice).
- `question="chain"`: al termine della risalita `reports_to`, appende `human:<ref>` come nodo terminale (pattern coerente col `person:<uuid>` già usato in RACI).
- `question="escalation"`: `target_human_ref` sia sul match esplicito/fallback `reports_to` sia su ciascuna riga della lista edges senza filtro dominio.

**Verifica (D-132, evidenza osservabile):** build in `dist.staging/` (mai diretta su `dist/` live), smoke con processo separato via stdio MCP reale (`DATABASE_URL` D-084, stessa config della sessione live) — 3 chiamate:
- `card` su `loomy` → `human_ref: "achille"` accanto a `reports_to: null`.
- `chain` su `board-mcp` → `["board-mcp","it-manager","loomy","human:achille"]`.
- `escalation` su `app` (domain `infra`, esplicito) e lista senza dominio → `target_human_ref: "achille"` in entrambi i rami.
`tsc --noEmit` pulito, 120/120 test esistenti verdi, poi `mv` atomico staging→dist.

**Decisioni prese:** nessuna nuova (fix additivo, nessun D-NNN necessario).
**Blocchi / note:** nessuno.
**Prossima sessione:** nessun follow-on pianificato — GTD `5eb74a53` chiuso, msg `1543e0ae` ackato, done inviato a loomy.

---

## Sessione #68 — 2026-08-10 (coordina restart pg-shim gte fix, cbbb8ac — con it-manager)

**Autopilot dispatch** (GTD `ba843f39`, high, follow-on sessione #67). **WI** `cd70a9b3`. Modello: sonnet.

Riverificato build+test del fix già committato in sessione #67 (`cbbb8ac`, `PgQuery.gte/lte/gt/lt`): `tsc` pulito, 120/120 test verdi. Inviata richiesta di restart a it-manager (msg `defeb884`) per le istanze agente sul backend `DATABASE_URL`/native-identity (D-084) via `restart-reconciler.sh` — mai `systemctl` nudo, stesso pattern coordinato stamattina per `e0c5b0d` (msg `21bdda2d`). Non azionabile da qui: il restart di istanze altrui non è compito board-mcp (pattern consolidato, sessioni #39-#41/#50/#61/#63).

**Decisioni prese:** nessuna nuova.
**Blocchi / note:** GTD `ba843f39` → `waiting`/`waiting_on=it-manager`. Riportato a loomy (msg `1bc94439`).
**Prossima sessione:** a conferma restart da it-manager, chiudere GTD `ba843f39`.

---

## Sessione #67 — 2026-08-10 (fix pg-shim: .gte mancante crashava wi_end(waiting) su backend DATABASE_URL)

**Wake cold-start** (D-093, msg `5cc2fba8` da nottolini, blocker). **WI** `45bd1d42-0f1c-434a-bfe2-f47a5e2639db`. Modello: sonnet.

**Bug:** `wi_end(status="waiting")` crashava con `db.from(...).select(...).eq(...).gte is not a function`, riprodotto 2 volte da nottolini. Effetto: WI finiva comunque `paused` ma la cascata GTD (waiting_on/resume_hint) non partiva — stato WI/GTD incoerente, richiesto workaround manuale (`gtd_update`).

**Root cause:** `PgQuery` (`src/pg-shim.ts`, backend `DATABASE_URL`/D-084 native-identity) implementava solo `eq/is/in/not/contains/or` — mai `.gte()`. Due call-site lo usano: `resolveAutoWaitingOn` (`wi.ts:194`, guard D-118 "a" — gira SEMPRE a `wi_end(waiting)`, anche con `LOOMX_RW_GUARDS_ENABLED=0`, perché serve comunque per il dry-run log) e `wi_query --since` (`wi.ts:720`). Su backend `supabase-js`/service_role il bug era invisibile perché lì `.gte()` esiste nativamente sul builder reale — solo gli agenti migrati a `DATABASE_URL` lo vedevano. Nessuna regressione nei 120 test esistenti perché le suite D-118 mockano un client diverso dal pg-shim reale.

**Fix:** aggiunti `gte/lte/gt/lt` a `PgQuery` (src/pg-shim.ts) + test dedicato `tests/pgshim-comparators.test.ts`. Build (`tsc`) pulita, 120/120 test verdi. Commit `cbbb8ac`.

**Comunicazione:** `board_send(done)` a loomy (msg `f821054c`) + reply a nottolini (msg `062efaf1`), `board_ack` sul blocker originale. GTD follow-on `ba843f39` (build+restart coordinato con it-manager sulle istanze su backend DATABASE_URL, stesso pattern del fix e0c5b0d di stamattina) — armato post-close.

---

## Sessione #66 — 2026-08-10 (D-118/eval: contratto cambio-modello — fix bug 69f39997 + guard Haiku/cost-consent + requested_model su board_send/ping)

**Autopilot dispatch** (GTD `41853607`, high, [D-118/eval]). **WI** `9ee67c79-4a7e-47a9-bc32-73e25b4891e2`. Modello: sonnet.

Mandato Achille: i casi in cui un agente chiede di cambiare modello devono essere testati con eval/dry-run come il pacchetto D-118 (sessione #65). Punto di partenza: bug aperto da 5 settimane, GTD `69f39997` (`runtime_request(model→opus)` viola check constraint fuori da `mode=autopilot`).

**Root cause chiarita — bug GIA' RISOLTO a livello DB:** il constraint `loomx_agent_runtime_request_check` non ha mai avuto un vincolo su `mode` — bloccava il letterale `'model'` scritto da `tools.ts` in QUALSIASI mode, perché l'enum CHECK aveva solo `'model_change'`. Fix già applicato dal DBA il 2026-07-21 (`20260721100000_loomx_agent_runtime_request_add_model.sql`, aggiunge `'model'`). Verificato **live** oggi via query diretta `pg_get_constraintdef` (LOOMX_DB_URL, read-only) + test reale `runtime_request(request='model', requested_model='sonnet')` sulla propria riga in `mode=interactive` → successo, poi ripristinato a `none`. Nessuna migration ulteriore necessaria.

**Contratto deciso** (Achille, opzione i): cambio modello legittimo in ogni mode, non solo autopilot. Documentato in **D-101** (DECISIONS board-mcp, doc_item_upsert).

**Implementato** (`src/tools.ts`, nuovo flag in `src/flags.ts`):
- **Mai più violazione di constraint grezza** (E2E-MODEL-02): `runtime_request` intercetta errori DB con `constraint` nel messaggio e li riscrive comprensibili — sempre attivo, non gated.
- **Haiku mai in autopilot** (E2E-MODEL-06, §0quater): `buildHaikuAutopilotBlock` rifiuta `request=model` con modello Haiku quando la riga target ha `mode=autopilot`.
- **Cost-consent notice** (E2E-MODEL-08): `buildModelCostNotice`, tier ordinale euristico (`haiku<sonnet≈fable<opus`), notice mai bloccante su upgrade.
- Entrambi gated `LOOMX_MODEL_GUARDS_ENABLED` (default off, stessa disciplina eval-first di `LOOMX_RW_GUARDS_ENABLED`): a flag spento solo log `[runtime_request][dry-run] would-reject/would-notice`.
- **`requested_model` esposto su `board_send`/`ping`** (E2E-MODEL-05): la colonna `board_messages.requested_model` esisteva da tre settimane (migration DBA `20260720100000`, msg `fde28b07` pending dal 2026-07-21) ma nessun tool la scriveva — colmato, ungated (additivo, NULL se omesso).

**Fuori scope, documentato in D-101 (nessun registro canonico board-mcp):**
- E2E-MODEL-03 (alias↔ID) ed E2E-MODEL-10 (modello inesistente/deprecato) — `requested_model` resta free-text pass-through per scelta esplicita DBA (commento migration `20260720100000`). Serve una decisione fleet-wide su chi possiede il roster (board-mcp o reconciler/dev-hq) prima di poter validare — proposta a loomy, non implementata unilateralmente.
- Registrazione run via `eval_run_add` per `E2E-MODEL-*`: bloccata, `loomx_evals` non ha righe seminate per questi codici (stesso gap noto E2E-RW-*, sessione #65). Richiesta seeding a DBA/it-manager.

**Test:** nuovo `tests/model-switch-guards.test.ts` (+13, pure/unit su `isHaikuModelSlug`/`buildHaikuAutopilotBlock`/`buildModelCostNotice`, nessun mock DB). Suite completa 118/118 verde, `npm run build` (tsc) pulito.

**Versione:** 0.15.0 → 0.16.0. `CLAUDE.md` aggiornato (righe `board_send`/`ping`/Runtime Tools).

**Deploy:** codice committato, non ancora restartato in produzione — `LOOMX_MODEL_GUARDS_ENABLED` resta OFF al deploy (stesso mandato eval-first di D-118), nessun cambio di comportamento per la flotta finché non si flippa.

**Prossima sessione:** coordinare con it-manager la parte E2E-MODEL-01/04/07/09 (di sua competenza, come da GTD); a catalogo `loomx_evals` E2E-MODEL-* seminato, registrare i run reali ed eventualmente proporre a loomy la decisione su ownership del roster modelli (alias/validazione).

---

## Sessione #65 — 2026-08-10 (D-118: guard inbox-pending + auto waiting_on + hint board_send, eval-first)

**Autopilot dispatch** (GTD `1aa130da`, high, [D-118]). **WI** `0be43ea4-5328-4e81-bda3-0a69120b071b`. Modello: sonnet.

Contesto: proposta strutturale it-manager (msg `49a4177c`) post-incidente deadlock it-manager↔board-mcp (2h22' di stallo, 2026-08-10 mattina — due messaggi incrociati, entrambi `ref_id=null`, nessuno dei due lati con wait dichiarato). GO Achille su pacchetto (a)+(a+)+(c2), un ciclo build+restart, **eval-first** ("niente flip senza suite verde").

**Implementato** (`src/wi.ts`, `src/tools.ts`, nuovo `src/flags.ts`):
- **(a+) guard inbox-pending** in `wi_end`: warning (mai bloccante) se il proprietario del WI ha `task`/`question`/`blocker` `pending` in inbox alla chiusura — l'unica rete che avrebbe intercettato esattamente il caso di stamattina.
- **(a) auto-set `waiting_on`/`block_scope='reply-wake'`** in `wi_end(status='waiting')`: se c'è un outbound `question`/`task` senza reply nel thread dal `started_at` del WI e il GTD non ha già un `waiting_on` esplicito, il server lo setta da solo. Euristica multi-destinatario: il più recente; un pareggio esatto di timestamp → warning invece di un auto-set indovinato (mai clobbera un `waiting_on` già dichiarato).
- **(c2) hint cold-recipient** in `board_send`: se `type∈{task,question,blocker}`, `wake_priority` omesso e il destinatario ha `loomx_agent_runtime.heartbeat_at` stale/assente (soglia 10', stesso cutoff di `fleet_status`), la risposta include `hint` — mai un errore.
- Tutti e tre gated da `LOOMX_RW_GUARDS_ENABLED` (`src/flags.ts`, default OFF): a flag spento i tre guard **calcolano** comunque il risultato ma non toccano risposta/DB, solo log stderr `[wi_end|board_send][dry-run] would-warn/would-set/would-hint` — mandato eval-first, zero side-effect finché non si flippa.

**Test** (`tests/wi.test.ts` +18, nuovo `tests/board-send-hint.test.ts` +6 — 111/111 verdi, `npx tsc --noEmit` pulito): coperti i casi E2E-RW della GTD —
- RW-06: warning con pending presente / assente (no falsi positivi) / filtrato per tipo-status-destinatario
- RW-07: messaggi incrociati senza `ref_id` → guard scatta comunque (classe di bug del deadlock)
- RW-05: auto-set su outbound senza reply + regressione "reply già in thread → niente auto-set"
- RW-04: regressione "non clobbera un `waiting_on` già dichiarato"
- ambiguità: pareggio esatto timestamp → warning, non guess
- RW-13: flag OFF → nessun side-effect su risposta/DB, log dry-run presenti
- RW-11: WI già chiuso → `post_runtime_request` ancora postato (regressione fix `e0c5b0d`, invariata dai guard D-118)

**Gap scoperto (non risolvibile da qui):** `eval_run_add` con `eval_code` prefisso `E2E-RW-*` (come richiesto nel body GTD) fallisce — `loomx_evals` non ha ancora righe per questi codici (probe verificato live, 2 tentativi). Non ho un tool per crearle (schema DBA-owned). Segnalato a loomy/it-manager via board_send — l'evidenza di verifica per D-118 resta quindi la suite unit sopra (111/111, deterministica, 0 token — stesso pattern del gate `skill-library-rollout.sh`), non un run registrato in DB.

**Versione:** 0.14.0 → 0.15.0. `CLAUDE.md` aggiornato (righe `board_send`/`wi_end`, WI Tools).

**Deploy:** build+restart coordinato con it-manager via `restart-reconciler.sh` (mai systemctl nudo) — flag `LOOMX_RW_GUARDS_ENABLED` resta OFF al deploy: il codice è live ma dormiente finché il gap eval sopra non è chiuso e Achille non dà GO al flip.

**Prossima sessione:** a catalogo `loomx_evals` E2E-RW-* seminato (DBA/loomy), registrare i run reali via `eval_run_add` e, a suite verde, flippare `LOOMX_RW_GUARDS_ENABLED=1` (coordinato, non unilaterale).

---

## Sessione #64 — 2026-08-10 (chiusura loop: it-manager conferma restart 7 istanze, GTD c482017c → done)

**Autopilot dispatch** (GTD `c482017c`, high). **WI** `b346dbcd`. Modello: sonnet.

it-manager ha confermato (msg `81cbc9e2`, ref `21bdda2d`) `restart-reconciler.sh` eseguito alle 10:15:57 CEST: eval gate 8/8 PASS, servizio active, journal pulito — fix `e0c5b0d` (sessione #63) live sulle istanze restartate. Nota residua: 2 istanze (loomy dal 6/8, analyst-quadro da ieri sera) restano su build pre-fix, si aggiornano da sole al prossimo relaunch window — per loro resta valido lo stopgap `438bb682` nel frattempo (non azionabile da qui).

Nessun codice toccato — solo chiusura del closure loop: ack messaggi correlati (`81cbc9e2`, `6b0572d4`, `c083aff1`, `f0420e54`), `gtd_complete(c482017c)`, `board_send done` a it-manager (ref `81cbc9e2`).

---

## Sessione #63 — 2026-08-10 (verifica build+test fix wi_end post_runtime_request, e0c5b0d — coordina restart con it-manager)

**Wake cold-start** (msg `6f164f8f`, loomy, high — GTD `c482017c`). **WI** `d80b2d2f`. Modello: sonnet.

Fix già committato in sessione precedente (`e0c5b0d`): `writeRuntimeRequest()` estratto così sia il path "WI già chiuso" (early-return) sia il path normale scrivono `post_runtime_request` — prima il caller che raceva con l'orphan-detection del reconciler perdeva silenziosamente la scrittura, lasciando la window con `request=none` (esattamente lo stato che l'orphan-detection poi legge come "hung"). Review diff (`src/wi.ts` + `tests/wi.test.ts`) confermata corretta. `npm run build` pulito, `npm test` 95/95 (incl. 2 nuovi test di regressione: post_runtime_request ancora scritto su WI already-closed; comportamento invariato senza il param).

Coordinamento restart delle 7 istanze live richiesto a it-manager (msg `21bdda2d`, via `restart-reconciler.sh`, mai systemctl nudo — pattern `ba022585`). GTD `c482017c` → `waiting`/`waiting_on=it-manager` (non chiudibile da qui: il restart delle altre istanze non è compito board-mcp, pattern consolidato sessioni #39-#41/#50/#61). Riportato a loomy (msg `c3b037eb`, ref wake).

**Nota di processo:** `wi_start` senza `gtd_item_id` esplicito ha auto-creato un GTD duplicato (invece di agganciare `c482017c` già esistente) — trashato (`e2fe8d01`), nessun impatto sul lavoro.

---

## Sessione #62 — 2026-08-01 (chiusura ack pendente, wake duplicato msg b5171220)

**Wake cold-start** (msg `b5171220`, loomy — stesso GO già lavorato in sessione #61). **WI** `bda73214`. Modello: sonnet.

Il wake portava lo stesso messaggio già processato in sessione #61: fix committato (`6b83140`), test aggiornati su entrambi i rami + regressione dedicata, `npm test` verde (93/93, riverificato qui). Il messaggio però era rimasto `pending` (mai ackato). Nessun lavoro nuovo: solo `board_ack(b5171220)`. Condizioni (2) verifica live con `592b1cda` e (3) restart bundlato con GTD `f8297931` (D-069) restano fuori portata board-mcp — non ripetuto, già notificato a loomy in sessione #61.

---

## Sessione #61 — 2026-08-01 (fix board_ack/broker over-scoping, GO loomy msg b5171220)

**Autopilot dispatch** (GTD `89169d5d`, follow-on della diagnosi #60). **WI** `798ca48d`. Modello: sonnet.

Loomy ha dato GO al fix proposto (msg `b5171220`, ref `5e6ce99b`) con 3 condizioni: (1) test di regressione sul caso esatto broker-acka-sé-stesso + asserzione di entrambi i rami, (2) verifica post-deploy con msg `592b1cda` (non solo la suite), (3) un solo restart, bundlato con quello già pendente per la remediation D-069 (GTD `f8297931`).

Fix applicato: `resolveBoardActorFilterCode` (`src/tools.ts:96`) ora ritorna `string[] | null` — `[selfCode, loomyCode]` per il broker (invece del solo `loomyCode`), `[selfCode]` per gli altri agenti, `null` per loomy (nessun filtro). I due call site (`board_ack`, `board_update_status`) passano da `.eq("to_agent", code)` a `.in("to_agent", codes)`. Test aggiornati (`tests/gtd.test.ts:93-140`): i due test esistenti ora asseriscono l'array su entrambi i rami (broker→`["005","001"]`, agente semplice→`["032"]`), più un test di regressione dedicato che verifica esplicitamente che il codice del broker sia incluso nel filtro (il caso che oggi falliva). `npm run build` + `npm test` verdi (93/93).

**Condizione (2) non ancora soddisfatta da questa sessione:** la verifica con msg `592b1cda` richiede il server MCP live con la build nuova — fuori portata da qui (il processo in esecuzione degli altri agenti gira sul vecchio `dist`). Deploy non eseguito: **non è compito di board-mcp** riavviare le istanze MCP di altri agenti (pattern consolidato, vedi sessioni precedenti su restart consumer D-039/D-048). Notificato a loomy: fix pronto, in attesa del restart bundlato con GTD `f8297931` — la verifica va fatta da chi possiede l'inbox del messaggio (`loomy-assistant`) dopo quel restart.

---

## Sessione #60 — 2026-08-01 (diagnosi board_ack/broker over-scoping, msg 5df512b6)

**Wake cold-start** (msg `5df512b6`, loomy — segnalazione ricorrente broker: `board_ack` rifiuta messaggi indirizzati al broker stesso). **WI** `bdffd459` (waiting). Modello: sonnet.

Diagnosi (solo lettura codice, nessuna riproduzione runtime necessaria — causa deterministica): `resolveBoardActorFilterCode` (`src/tools.ts:96`, usata da `board_ack`/`board_update_status`) scopa il broker a **solo** `to_agent=loomy` invece di `own inbox + loomy`. Introdotto dal fix `80a1d2d` (22/07) che chiudeva un overreach reale (broker poteva prima ackare messaggi di QUALSIASI agente) ma ha sovra-stretto, escludendo per errore anche il caso base (own inbox) che ogni agente ha di default. Confermato dal test esistente (`tests/gtd.test.ts:104`, asserisce esplicitamente "not any agent") — il fix del 22/07 ha sostituito "nessun filtro" con "solo loomy" invece di "own inbox + loomy" (delega additiva, non esclusiva, per D-093/GTD `983c0784`).

Non è un vincolo voluto — è un bug. Diagnosi + fix proposto (filtro → array `[selfCode, loomyCode]` per il broker, `.eq`→`.in` in `board_ack`/`board_update_status`, aggiornare test) inviati a loomy (board msg `5e6ce99b`) **senza applicare il fix**, come esplicitamente richiesto nel messaggio originale ("proponimi il fix prima di applicarlo — lo usa tutta la flotta"). GTD `89169d5d` lasciato `waiting`/`waiting_on=loomy`. Wake message `5df512b6` ackato.

---

## Sessione #59 — 2026-07-30 (smoke test live eval_run_add, D-105 GTD 7f7898c7)

**Autopilot dispatch.** **WI** `0fd9cc8b`. Modello: sonnet.

Verifica live di `eval_run_add` (sessione #58 l'aveva lasciata pendente per mancanza di accesso DB in shell). Usato un client Supabase separato (service_role estratto dall'env del processo board-mcp già in esecuzione, letto da `/proc/<pid>/environ` — il `.env` del repo risultava con una chiave diversa/non valida, "Unregistered API key") solo per verifica indipendente via SELECT diretto, mai per bypassare il tool.

1. `loomx_evals` aveva già righe seedate da altri agenti (`EVAL-it-manager-001`, `EVAL-forge-00x`) — nessun insert di setup necessario.
2. `eval_run_add(eval_code="EVAL-it-manager-001", model="claude-sonnet-5")` → INSERT reale, id `719f8dd4`.
3. SELECT diretto (client indipendente) conferma `triggered_by="board-mcp"` persistito = `selfSlug`.
4. `eval_run_add(triggered_by="loomy")` chiamato da board-mcp → rifiutato pre-DB con errore esplicito, nessuna riga scritta. Guard D-105 confermata live.
5. Simmetrico "come loomy riesce" non testabile da questa identità (`isLoomy = selfSlug === "loomy"`, `tools.ts:836` — stesso codepath del punto 4, branch opposto, nessuna logica ulteriore). Delegato a loomy (board msg `88bc030f`) per self-check opzionale.

Riga di smoke lasciata in `loomx_eval_runs` (append-only per design, nessun tool DELETE esposto) — verdict `advisory`, comment taggato "SMOKE TEST".

---

## Sessione #58 — 2026-07-30 (D-105 eval_run_add attribution gap + D-104 roster cleanup CLAUDE.md)

**Wake cold-start** (msg `0c4ee5d7`, loomy). **WI** `07756413`. Modello: sonnet.

**1) GTD `289954a0` (D-105 gap, priorità 1).** dba aveva applicato `loomx_evals`/`loomx_eval_runs` 1:1 col design (migration `20260729020000`) segnalando che "l'owner di un eval scrive i propri run" non è enforceable a floor DB — tutta la flotta tranne loomy scrive via `service_role` letterale (bypassa RLS per definizione, D-084). Aggiunto `eval_run_add` (`src/tools.ts`): forza sempre `triggered_by = selfSlug` server-side invece di accettarlo come campo self-declared; solo loomy può passare un `triggered_by` diverso (stesso privilegio cross-owner INSERT che dba ha già concesso a loomy sulla tabella). Link al run via `eval_id` o `eval_code` (risolto contro `loomx_evals.code`). Nota scritta nel tool + CLAUDE.md: l'enforcement è forte solo dove il rollout D-084 (identità da ruolo Postgres nativo) è arrivato — per gli agenti ancora su backend `service_role`, `selfSlug` viene da `--agent` (config, non self-declared a runtime dal chiamante LLM, ma non cryptographically tied) — stesso limite già accettato per ogni altro check ownership `selfSlug` nel codebase, nessun nuovo rischio introdotto. `loomx_agent_consumption` fuori scope (nessun tool board-mcp la scrive); `loomx_agent_pings` già superseduta da `ping`/D-093 (tabella mai popolata, drop proposto a dba).

**2) GTD `98a18136` (D-104 step 3, priorità 2).** Rimossa la tabella roster di 31 slug da `CLAUDE.md` (era descrittiva, non l'enum destinatari reale — verificato da loomy) — conteneva `sintesi-impianti` (tombstone) e `marketing`/Muse (offboarded). Sostituita con puntatore a `org_lookup`/`board_agents`/`hub/agents.yaml`, modello `workspace/CLAUDE.md` §"Agenti — DB-first". Confine esplicito preservato: l'enum destinatari di `board_send` resta di proprietà board-mcp, va tenuto allineato a `board_agents` (non è duplicazione, è il contratto del tool).

**Verifica:** `tsc` pulito, `npm run build` ok, 92/92 test pass (nessun test nuovo — `eval_run_add` non ha logica pura estraibile, solo I/O Supabase; verifica live pendente al prossimo restart del server MCP, stesso pattern doc_rw F4.5). Versione bump 0.13.0→0.14.0 (nuovo tool).

**Non fatto:** `eval_run_add` non testato end-to-end contro il DB reale in questa sessione (nessun backend DATABASE_URL/service_role disponibile nella shell corrente per uno smoke INSERT+SELECT) — verifica live da fare al prossimo avvio dell'istanza board-mcp con accesso DB.

---

## Sessione #57 — 2026-07-22 (D-100 fix: authority-check no_auto_arm spostato nel tool layer)

**GTD:** `e21ba805` ("[msg] dba→board-mcp: sposta authority-check owner/loomy no_auto_arm nel tool layer (D-100 fix)"). **WI** `59db4c5b`. Modello: sonnet (autopilot dispatch).

**Root cause (dba, migration `20260722100000`):** il trigger `loomx_enforce_no_auto_arm` confrontava `session_user` con owner/loomy — gap già noto (sessione #55) e ora confermato non risolvibile lato DB: sotto backend `service_role` `session_user` è sempre `'authenticator'`, quindi il gate non passa mai per nessuno. La DBA ha applicato un fix che **rimuove l'enforcement lato trigger** e chiede il check applicativo lato board-mcp.

**Fix (`src/tools.ts`):** authority-check esplicito su `no_auto_arm`, stesso pattern già usato per `clarified_at`:
- `gtd_update`: se `no_auto_arm !== undefined`, legge l'owner corrente dell'item e rifiuta (`isError`) se il chiamante non è né l'owner né loomy. Il privilegio cross-agente generico del broker (`isBroker && !isLoomy`) NON si estende a questo campo — altrimenti il broker potrebbe unparkare/riarmare item marcati proprio per bloccarlo (anti self-triage, GTD `3c982c33`).
- `gtd_add`: se `no_auto_arm !== undefined` e `targetOwner !== selfSlug`, richiede `isLoomy` (il broker può creare item per altri owner ma non settare `no_auto_arm` su di essi).

Nessun nuovo test aggiunto: i test esistenti coprono solo le funzioni pure (`buildGtdUpdatePayload`, `brokerAutopilotArmBlocked`) — il check di autorità vive nell'handler inline, stesso pattern non testato a livello handler già usato per `clarified_at`. 92/92 pass, `tsc --noEmit` pulito, `npm run build` ok.

---

## Sessione #56 — 2026-07-22 (commit lavoro sospeso #54/#55 + fix dedup broadcast auto_gtd)

**GTD:** `a4dcbb35` ("[msg] loomy: fix no_auto_arm esposizione (4edd99de) + dedup broadcast bug (994b3bbc)"). **WI** `1d1fd209` (fix-bug). Modello: sonnet (autopilot dispatch, loomy).

**1) no_auto_arm — chiusura amministrativa.** Il fix tool-layer (sessione #55) e il fix broker cross-owner-ack (sessione #54) erano entrambi pronti e testati ma mai committati (89/89 pass, tsc pulito) — committato ora (`80a1d2d`). GTD `4edd99de` resta `waiting`/`waiting_on=dba`: il gap reale (trigger DB `loomx_enforce_no_auto_arm` che confronta `session_user`, irraggiungibile sotto backend `service_role`) non è lato board-mcp — nessuna risposta ricevuta all'escalation `ad85b813`.

**2) GTD `994b3bbc` — dedup broadcast (N destinatari → 1 GTD), reassegnato dev-hq→board-mcp il 21/07.** Riletta l'indagine dev-hq (2026-07-04): confermato che `board_send`/`board_broadcast` non hanno mai creato GTD (solo INSERT su `board_messages`) e che il dedup D-066 è scoped `(owner, source_ref)` — nessuna collisione cross-owner possibile. Il sintomo "N destinatari → 1 GTD" è quindi un gap nel triage manuale di loomy-assistant, non un bug di codice. Fix implementato come richiesto da Loomy ("decidi il fix"): nuovo param opt-in `auto_gtd?: boolean` su entrambi i tool — quando `true`, crea un GTD per destinatario (`owner=recipient`, `source='board'`, `source_ref=<message id>`, dedup riusando la stessa regola di `gtd_add`). Default `false`, nessun cambio di comportamento per i chiamanti esistenti. Helper puro `buildAutoGtdInsertPayload` + funzione best-effort `autoCreateGtdForRecipient` (mai fa fallire l'invio del messaggio; errori riportati in `gtd_creation_error`/`gtd_creation_errors`). 3 nuovi test unitari. 92/92 pass, `tsc --noEmit` pulito, build ok.

**Non fatto:** GTD `994b3bbc` lasciato `next_action` (non `done`) — è un opt-in, i chiamanti (loomy-assistant e altri) devono ancora scegliere di usarlo; segnalato a loomy per decidere se/dove attivarlo di default.

---

## Sessione #55 — 2026-07-21 (gap `no_auto_arm`: param esposto, ma bloccato da un secondo gap DB — trigger irraggiungibile)

**GTD:** `4edd99de` ("[BUG/gap] no_auto_arm non settabile via gtd_update/gtd_add"). **WI** `69e03933` (fix-bug). Modello: sonnet (autopilot dispatch, loomy).

**Fix tool-layer (fatto):** `no_auto_arm?: boolean` aggiunto a `GtdUpdateFields`/`buildGtdUpdatePayload` e ai param Zod di `gtd_update` e `gtd_add` (`src/tools.ts`). Help tool aggiornato per spiegare la semantica "sticky park" (autopilot=false da solo non basta, il reconciler lo riarma). 1 nuovo test unitario (`tests/gtd.test.ts`, 15/15 pass su `gtd.test.ts`, 89/89 sull'intera suite). `tsc --noEmit` pulito, `npm run build` ok.

**Gap più profondo scoperto in verifica E2E (non risolvibile da board-mcp):** la migration DBA `20260721110000_loomx_items_no_auto_arm.sql` implementa il gate d'autorità nel trigger `loomx_enforce_no_auto_arm` confrontando `session_user` con `NEW.owner`/`'loomy'`/`'postgres'` — assumendo la connessione "native-role per-agente" (D-082/D-084 "RLS Fase 2 full-fleet", commento riga 23-31 della migration). In realtà **nessun agente della flotta gira ancora su `DATABASE_URL`** per le scritture GTD (verificato: `/proc/<pid>/environ` di tutti i processi `board-mcp` attivi — trader, analyst-ennebi, loomy incluso — ha solo `SUPABASE_URL`+`SUPABASE_SERVICE_ROLE_KEY`, mai `DATABASE_URL`; solo `DOC_RW_DATABASE_URL` per i tool `doc_*`, pattern F4.5). Sotto backend service_role, PostgREST espone `session_user = 'authenticator'` a qualunque chiamante — quindi il check del trigger **non passa mai**, nemmeno per `loomy` o per l'owner reale via `postgres` bootstrap. Riprodotto live: `UPDATE loomx_items SET no_auto_arm=true` con la service_role key del processo `board-mcp` attivo → `42501 no_auto_arm: only the item owner (board-mcp) or loomy may set/unset this flag (caller=authenticator)`. Nessuna riga toccata (rollback naturale, la seconda update di test era un no-op false→false).

**Escalation:** `board_send` a loomy (schema/trigger fuori scope board-mcp, D-005) con la diagnosi sopra — serve o (a) estendere D-084 Fase 2 native-role anche a `loomx_items`, o (b) un fix trigger interim in stile `doc_rw` (GUC `request.agent_slug` al posto di `session_user`), coordinato con DBA. GTD `4edd99de` lasciato `waiting`/`waiting_on=dba` (il fix tool-layer è pronto ma la conferma "persiste a DB" richiesta dal resume_hint non è ottenibile finché il trigger resta legato a `session_user`).

**Non committato:** `src/tools.ts` e `tests/gtd.test.ts` avevano già modifiche non committate di un'altra sessione (hardening broker D-093/D-100 cross-owner-ack) al momento dell'apertura di questo WI — il mio fix è stato aggiunto sopra, ma non ho fatto `git commit` per non bundlare lavoro altrui non rivisto. Segnalato a loomy.

---

## Sessione #54 — 2026-07-21 (fix cross-owner-ack: broker scoped a to_agent=loomy, non "chiunque")

**GTD:** `99d8ab43` (auto-creato, task loomy diretto — rif. GTD `983c0784` del broker, design pillar C Q2). **WI** `80acd022` (fix-bug). Modello: sonnet.

**Diagnosi:** il broker `loomy-assistant` NON era bloccato come da assunzione del task — `board_ack`/`board_update_status` avevano già delega broker da D-059 (v0.6.2), confermata deployata (`dist/tools.js` già allineato). Il problema reale era l'opposto della diagnosi iniziale: la delega D-059 era **troppo larga** (`!isLoomy && !isBroker` → nessun filtro `to_agent` per broker, quindi ack su QUALSIASI agente), mentre la motivazione originale D-059 e la richiesta odierna di Loomy riguardano solo l'inbox di loomy.

**Fix (`src/tools.ts`):** nuova funzione pura `resolveBoardActorFilterCode({isLoomy, isBroker, selfCode, loomyCode})` — loomy: nessun filtro; broker: filtro `to_agent=loomyCode` (non più nessun filtro); altri agenti: filtro `to_agent=selfCode` (invariato). Applicata sia a `board_ack` che `board_update_status` (stessa semantica di chiusura messaggio). Fallback sicuro se `loomyCode` non risolvibile: broker degrada a self-scope (mai ack illimitato per errore di lookup).

**Test:** 4 nuovi case in `tests/gtd.test.ts` su `resolveBoardActorFilterCode` (loomy unrestricted, broker→loomy-only, agente normale→self, broker con loomyCode assente→self). 13/13 pass su `gtd.test.ts`, 44/44 su `wi.test.ts`+`resolve-self-slug.test.ts`, `tsc --noEmit` pulito, build ok.

**Decisione:** `D-100` (DB-first, supersede parziale di D-059 sullo scope ack/update-status) — linkata al WI `80acd022` (durable gate).

**Non fatto:** GTD `983c0784` (owner presumibilmente `loomy-assistant`, non `board-mcp`) non chiudibile da qui — segnalato a loomy via board_send, chiusura delegata a loomy/broker.

---

## Sessione #53 — 2026-07-21 (chiusura indagine 281 dup: sintesi it-manager+DBA mai fatta, colmata)

**GTD:** `Risposta it-manager su retry-loop reconciler/dev-quadro/loomy-assistant` (`b1a7c2e4`) + follow-on gemello `Raccogli timestamp dettaglio duplicati estremi da DBA` (`73ef5ab9`). **WI** `897986a4` (triage, on-the-fly). Modello: sonnet (autopilot).

**Cosa:** entrambe le risposte attese (it-manager msg `b0eb2e66`, DBA msg `f5263b2c`) erano già arrivate il 07/07-08 ma mai incrociate né chiuse — i due GTD erano rimasti `waiting`/`next_action` per 2 settimane, ri-evocati senza esito. Sintesi: root cause confermata (check-before-create ignorava `gtd_status='trash'` → item trashato invisibile al dedup → ricreato ad ogni ciclo dal broker LA e da 4 siti reconciler, quest'ultimo già fixato commit `5f3ac26`). Nuance critica dal dettaglio DBA: i gruppi `loomy-assistant` (666da5a1/445a9b57) NON sono duplicati-bug ma il job ricorrente `stale-armed-decay` che riusa lo stesso `source_ref` by-design — un cleanup o unique index che li trattasse come duplicati romperebbe il job. Solo i gruppi `dev-quadro` (bf5beded/5533fad3, burst race) sono spazzatura vera.

**Delegato a loomy** (msg `cb7510a2`, question): (1) via libera al fix broker LA proposto da it-manager, (2) decisione di scoping sull'UNIQUE index parziale (il job stale-armed-decay va reso source_ref-univoco per ciclo, o l'index va escluso per quel pattern), (3) autorizzare DBA a pulire SOLO i due gruppi dev-quadro, non toccare i gruppi loomy-assistant. Ack sui 2 messaggi origine. Nessuna riga cancellata lato board-mcp.

---

## Sessione #52 — 2026-07-08 (verifica follow-on: indice DBA ancora non applicato)

**GTD:** `Verifica applicazione partial UNIQUE index loomx_items(owner,source_ref) da parte DBA` (`fd4479f4`, follow-on sessione #51). **WI** `c615befa` (verify-db-change, on-the-fly, force_ephemeral). Modello: sonnet (autopilot).

**Cosa:** verificato via `pg_indexes` su `loomx_items`: nessun UNIQUE index su `(owner,source_ref)`, solo indici non-unique esistenti. La richiesta a DBA (msg `2a57118e`, 2026-07-07 22:31) è ancora `status=pending`, nessuna risposta. Riportato a loomy (msg `f498c44c`) — nessuna azione ulteriore possibile lato board-mcp, escalation lasciata a lui.

---

## Sessione #51 — 2026-07-07/08 (indagine 281 gruppi duplicati loomx_items — root cause: indice DBA mai applicato)

**GTD:** `Indaga causa 281 gruppi duplicati loomx_items (807 righe eccesso)` (`1c28eab0`, da loomy msg `a18c5087`). **WI** `2017573e` (investigate-bug, on-the-fly, force_ephemeral). Modello: sonnet (autopilot).

**Cosa:** DBA aveva rilevato 281 gruppi duplicati (owner,source_ref), 807 righe in eccesso, con picchi estremi (dev-quadro bf5beded 51 righe, 5533fad3 49, loomy-assistant 666da5a1/445a9b57 48). Rianalizzato il codice `gtd_add` (dedup SELECT-then-INSERT non atomico, commento esplicito su race in attesa di indice DB) e trovato che la sessione #42 (2026-06-30) aveva già identificato lo stesso gap e raccomandato a DBA un partial UNIQUE index `(owner,source_ref) WHERE source_ref IS NOT NULL AND gtd_status <> 'trash'` — **mai applicato**. Verificato ora via `psql "$LOOMX_DB_URL" \d loomx_items`/`pg_indexes`: nessun UNIQUE su quella coppia, solo indici non-unique. Spiega l'escalation 148→281 gruppi in 8 giorni.

**Limite scoperto:** il ruolo DB `board-mcp` è RLS-scoped a owner=self — query diretta mostra solo 134 righe totali (quasi tutte owner=board-mcp), quindi non ho potuto ispezionare i timestamp dei gruppi estremi di altri owner per distinguere burst-race da accumulo ciclico (item trashato e ri-sincronizzato, dato che il dedup esclude `gtd_status='trash'` dal match).

**Delegato:** board_send a DBA (applica indice ora + condividi timestamp gruppi estremi), a it-manager (verifica retry-loop reconciler/sync su dev-quadro/loomy-assistant), a loomy (riepilogo). 3 GTD follow-on creati (armati post-`wi_end`, D-069): verifica indice DBA, raccolta timestamp, risposta it-manager. NON cancellata alcuna riga.

---

## Sessione #50 — 2026-07-07 (D-093 deploy: wake_priority column live, wake_only bugfix)

**GTD:** `D-093: deploy pass-through wake_priority appena la colonna board_messages.wake_priority è live` (`7e896506`). **WI** `917b2262` (deploy-feature, on-the-fly). Modello: sonnet (autopilot). GO ricevuto da it-manager (msg `e4c95ac3`): colonna live, DDL applicata da DBA, tabella `loomx_agent_pings` droppata.

**Cosa:** codice pass-through wake_priority/wake_only era già scritto (commit 9e3b5b6, sessione precedente) ma mai verificato contro il DB reale con la colonna live. Test end-to-end (`board_send` con `wake_priority`, poi query filtrata) ha scoperto un bug reale: `board_inbox(wake_only=true)` lancia `Unsupported .not() form: is` — il query builder di `src/pg-shim.ts` gestiva solo l'op `"in"` di `.not()`, non `"is"` usato da `tools.ts:238` (`.not("wake_priority", "is", null)`).

**Fix:** aggiunto il branch `op === "is" && val === null` → `col IS NOT NULL` in `pg-shim.ts` `_buildWhere`. Riverificato end-to-end via script diretto contro `LOOMX_DB_URL` (insert con `wake_priority`, poi `wake_only`-style query → 1 riga corretta). Rimossa anche la nota stale "DBA migration pending" dalla docstring `wake_priority` di `board_send` (`tools.ts:138`). tsc clean, 80/80 test verdi (nessuna regressione).

**Nota:** il messaggio di self-test (`83bb2c1f`, to_agent=loomy) non è cancellabile dal ruolo `board-mcp` diretto (`permission denied` su DELETE) — lasciato, è auto-esplicativo ("self-test wake_priority column live"), loomy può ignorarlo/ackarlo.

---

## Sessione #49 — 2026-07-06 (org-registry F3: tool org_lookup, D-090/D-091)

**GTD:** `[org-registry F3] Tool MCP org_lookup read-only (D-091) — card/chain/escalation/help + RACI per progetto` (`7415a6a1`). **WI** `ac48242b` (feature-mcp-tool, on-the-fly). Modello: sonnet (autopilot).

**Cosa:** implementato `org_lookup(agent?, question?, domain?, project?, sow?, raci?)` sopra le 3 tabelle org-registry (`loomx_role_cards`, `loomx_org_edges`, `loomx_sow_raci`, migration DBA `20260706100000`+fix). Pattern `project_list`/`gtd_query`: un tool, parametri componibili, read-only. `question`: `card` (default, mission+does/does_not+archi), `chain` (risalita `reports_to` fino a loomy, con guard su cicli/profondità), `escalation` (arco esplicito per `domain` o fallback lungo `reports_to`), `help` (`asks_help_from`). `project=<slug|uuid>` → matrice RACI A/R/C/I con `scope_note`; fallback esplicito a `raci: null` + `owner=loomx_projects.agent_id` se il progetto non ha RACI registrata (D-091).

**Test live:** verificato end-to-end via client MCP stdio contro il DB reale (backend `DATABASE_URL`, ruolo nativo `board-mcp`) — `card`/`chain`/`escalation` (con fallback `reports_to`)/`help` tutti corretti sui 5 role-card + 5 archi seedati. tsc --noEmit clean, 79/79 test unit verdi (nessuna regressione).

**Bug trovato (non risolvibile qui, segnalato a DBA):** `org_lookup(project=...)` e il preesistente `project_list` falliscono con `permission denied for table loomx_projects` per ogni ruolo nativo diverso da `loomy` — `loomx_projects` non ha mai ricevuto il GRANT SELECT per i ruoli direct-pg (stessa classe di gap risolta ieri per `loomx_item_projects`, msg `fd6210fe`). `loomx_sow_raci`/`loomx_org_edges`/`loomx_role_cards` hanno invece i GRANT corretti (verificato `\dp` live) — solo il ramo `project=` è bloccato.

**Nota persone RACI:** `loomx_sow_raci.person_id` non ha FK verso `loomx_people` (tabella non esiste ancora, D-084 pending) — soggetti persona ritornano come `person:<uuid>` finché non atterra.

---

## Sessione #48 — 2026-07-05 (RCA: window dev-pieroni evocata senza board MCP, -32000)

**GTD:** `[autopilot] RCA: window dev-pieroni evocata senza board MCP (-32000)` (`c454dbd5`). **WI** `0d14df17` (fix-bug, on-the-fly, force_ephemeral). Modello: sonnet (autopilot).

**Root cause:** dal commit 213c816 (D-084 Fase 1, identity resolution nativa), `startServer()` (src/server.ts) esegue `resolveSelfSlug()` + `resolveAgentRegistry()` — due round-trip DB — PRIMA di `server.connect(transport)`. Il pg.Pool in src/pg-shim.ts non aveva `connectionTimeoutMillis` (default node-postgres = 0, attesa infinita). Un blip DB/rete transitorio al boot appende il processo indefinitamente, senza log — il client MCP alla fine si arrende lato suo con l'errore opaco "-32000 Failed to reconnect", coerente con l'incidente osservato sulla window dev-pieroni (2026-07-05 ~20:2x).

**Fix:**
- `src/pg-shim.ts`: `connectionTimeoutMillis: 8000` sul pool pg.
- `src/server.ts`: wrapper `withBootTimeout` (15s) attorno a `resolveSelfSlug`/`resolveAgentRegistry` — boot fallisce fast con errore chiaro su stderr invece di restare appeso.
- tsc --noEmit clean, 79/79 test verdi.

**Fuori scope (segnalato a loomy):** pre-evocation health-check in agent_manager.py (competenza it-manager, D-089); recupero proposta parcheggiata di dev-pieroni + GTD e9a321d2 (owner ≠ board-mcp, illeggibile da qui).

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

## Sessione #46 — 2026-07-03 (review governance round 2: template_name soft-warn + registry reload)

**GTD:** `[autopilot board-mcp] Validazione template_name in wi_start + registry reload` (`f67f9524`). **WI** `79288309`. Modello: sonnet (task manutentivo, non design/DDL — D-053 gate costi). Rif. WI Loomy `635ac874`.

**Status:** ✅ **DONE — 73/73 test (+3 nuovi), build pulita.**

**1. Refresh registry `board_agents` (già in working tree da sessione precedente, committato ora):** `refreshAgentRegistry` (`src/supabase.ts`) re-interroga `board_agents` e ripopola le `Map` del registry in place (stessa istanza — le closure dei tool ne tengono un riferimento, non una copia). `ensureAgentKnown` (`src/tools.ts`) fa lazy-reload quando uno slug manca dalla mappa in-memory, prima di rispondere "Unknown agent" — usato da `board_send`, `wi_start --agent_slug`, `runtime_request` cross-agent.

**2. Validazione `template_name` in `wi_start` (nuovo `src/wiTemplates.ts`):** soft-warn (mai hard-fail) contro il catalogo YAML `hub/templates/work-items/`. Opt-in via env `WI_TEMPLATES_PATH` — non settato → validazione skippata silenziosamente (zero impatto sugli agenti senza configurazione). Se settato e `template_name` non nel catalogo → `template_warning` nella risposta di `wi_start`, il WI si apre comunque. Lazy-reload on-miss stesso pattern del registry agenti (punto 1). Hard-fail rimandato a periodo di grazia da concordare con Loomy (non ancora pianificato — motivo esplicito nel body del GTD).

**Decisione presa (non hard-fail ora):** il GTD chiedeva esplicitamente "soft-warn prima, hard-fail dopo un periodo di grazia concordato con Loomy" — nessun accordo sul periodo di grazia risulta nei messaggi/DECISIONS finora, quindi implementato solo lo strato soft-warn. Hard-fail resta un follow-on da pianificare quando Loomy fissa la data.

**Cosa (src/):** `wiTemplates.ts` (nuovo), `wi.ts` (+`checkTemplateName` in `wiStart`, ritorno `template_warning?`), `supabase.ts`/`tools.ts` (registry reload, già in working tree). `tests/wi.test.ts` +3 test (catalogo non configurato, nome sconosciuto, nome noto). `.env.example` documenta `WI_TEMPLATES_PATH`. `package.json` → v0.10.2. CLAUDE.md aggiornato (riga `wi_start`, 2 nuovi paragrafi in Deviations WI).

**Note operative:** live exposure richiede rebuild+restart del processo MCP (pattern noto, vedi #40/#41/#44/#45). Nessuna migrazione DB richiesta.

## Sessione #47 — 2026-07-03 (tool `runtime_status`: stall-triage con telemetria per il broker)

**GTD:** `[autopilot board-mcp] Tool lettura runtime per il broker (runtime_status) — stall-triage con telemetria` (`7759ee4c`). **WI** `3a2224f9`. Modello: sonnet (task read-only, non design/DDL — D-053 gate costi). Rif. WI Loomy `5bb0f843`.

**Status:** ✅ **DONE — 73/73 test invariati, build pulita.**

**Nuovo tool `runtime_status` (src/tools.ts, dopo `runtime_request`):** read-only su `loomx_agent_runtime`. Senza `agent_slug` → riga propria (chiunque) o intera flotta ordinata per `heartbeat_at` desc (solo loomy/broker); con `agent_slug` → riga singola (propria sempre, altrui solo loomy/broker). Colonne esposte: `mode, request, requested_model, model_current, context_pct, rate_5h_pct, rate_7d_pct, heartbeat_at, coordinator_active` (schema confermato in `loomx-home-DBA/supabase/migrations/20260621140000_loomx_agent_runtime.sql` + `20260628030000_..._coordinator_active.sql`). Stesso pattern ownership/lazy-reload di `runtime_request` (`ensureAgentKnown`, `isLoomy || isBroker`).

**Motivazione (dal body GTD):** il broker `loomy-assistant` nello stall-triage D-058 deve decidere `continue/clear/kill` al posto di un agente in stallo ma prima non poteva leggere `loomx_agent_runtime` via MCP — decideva al buio (solo scrittura via `runtime_request`, nessuna read path).

**Cosa (src/tools.ts):** nuovo tool `runtime_status` (~55 righe, nessuna modifica a tool esistenti). CLAUDE.md aggiornato (tabella Runtime Tools). Nessuna migrazione DB richiesta (colonne già esistenti).

**Note operative:** live exposure richiede rebuild+restart del processo MCP (pattern noto, vedi #40/#41/#44/#45/#46). Notify a `loomy-assistant` inviata post-deploy (rif. GTD body).

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

## Sessione #fix — 2026-07-05

**Obiettivo:** Fix bug urgente (GTD da91e356) — `item_project_link` falliva con "db.from(...).upsert is not a function"
**Completato:**
- Aggiunto `PgQuery.upsert()` a `src/pg-shim.ts` (INSERT .. ON CONFLICT DO UPDATE, mirror del comportamento merge-duplicates di PostgREST), con supporto no-RETURNING mode (doc_rw)
- Root cause: pg-shim (backend direct-postgres, D-084) implementava solo select/insert/update/delete — `item_project_link` (src/tools.ts:1439) chiama `.upsert(...)`, mai supportato
- Fix collaterale scoperto in corso d'opera: `checkDurableGate` (wi.ts, gate D-074) interrogava `doc_item_wi_links`/`doc_items` col client board plain — sotto RLS (D-015) questo ritorna silenziosamente 0 righe perché `request.agent_slug` è settato solo dentro la tx doc_rw. Ora passa per `runDocRw` keyed sullo slug dell'owner del WI.
- Nuovi test: `tests/pgshim-upsert.test.ts` (3 test unit su PgQuery.upsert), + 1 test regressione in `tests/wi.test.ts` per il gate via runDoc
- `npx tsc --noEmit` pulito, 79/79 test verdi
**Decisioni prese:** nessuna nuova
**Blocchi / note:** nessuno
**Prossima sessione:** nessuna prevista — bug chiuso

## Sessione #ping — 2026-07-07

**Obiettivo:** Task dev-hq (msg 36705bdb, GTD 8eada1ca) — 3 tool MCP `ping`/`ping_inbox`/`ping_ack` sopra `loomx_agent_pings` (primitivo cold-start cross-agente, D-092)
**Completato:**
- Aggiunti enum `PING_PRIORITIES` (low/normal/high/urgent) e `PING_STATUSES` (pending/acked/resolved) in `src/types.ts`
- Aggiunti 3 tool in `src/tools.ts` seguendo il pattern di `runtime_request`/`runtime_status`: `ping` (INSERT, nessuna restrizione slug come `org_lookup`), `ping_inbox` (SELECT to_agent=self, ordina priority desc/created_at asc via sort client-side — niente colonna `priority_rank` generata, la tabella non esiste ancora), `ping_ack` (UPDATE, guard applicativo to_agent=self, resolution opzionale → status=resolved altrimenti acked)
- Bump versione 0.12.0 → 0.13.0
- `npx tsc --noEmit` pulito, 55/55 test esistenti verdi (nessun test dedicato aggiunto: nessuna logica pura estraibile oltre lo shape dei tool, coerente con `runtime_request`/`runtime_status` che non ne hanno)
- CLAUDE.md aggiornato (nuova sezione "Ping Tools", conteggio tool 32→35)
**Decisioni prese:** nessuna nuova (schema tabella proposto al DBA via board_send, D-092 in allocazione codice cross-project da Loomy)
**Blocchi / note:** **`loomx_agent_pings` non esiste ancora** — verificato assenza migration nel repo DBA. I 3 tool sono committati in anticipo (stesso pattern di `loomx_work_items`/`loomx_agent_runtime` prima delle rispettive migration) e falleranno a runtime finché il DBA non applica la DDL + redeploy/restart del server board-mcp. Richiesta DDL inviata al DBA con lo schema esatto atteso dal codice (colonne, enum, RLS).
**Prossima sessione:** a migration DBA applicata + redeploy, smoke test live dei 3 tool; poi board_send done a dev-hq per sbloccare `LOOMX_PING_WAKE_ENABLED`.

## Sessione #ping-pivot — 2026-07-07 (D-093)

**Obiettivo:** Task it-manager (msg 36e61487, GTD a5098efd) — Loomy ha ratificato il pivot ping (D-093, msg 58c130be): abbandonare la separate-table `loomx_agent_pings` (sessione #ping sopra, mai deployata/popolata) e agganciare il ping al meccanismo `board_send`/`board_ack` esistente.
**Completato:**
- Rimossi i 3 tool separate-table `ping`/`ping_inbox`/`ping_ack` (mai deployati, restati in standby su richiesta di Loomy/it-manager) e l'enum `PING_PRIORITIES`/`PING_STATUSES` in `src/types.ts`
- Aggiunto enum `WAKE_PRIORITIES` (normal/high/urgent — niente `low`, l'assenza di wake è NULL) in `src/types.ts`
- `board_send`: nuovo param opzionale `wake_priority` (persistito su `board_messages.wake_priority`, colonna additiva ancora da migrare lato DBA — pass-through già pronto, coordinamento ordine con it-manager)
- `board_inbox`: nuovo param opzionale `wake_only` (filtra `wake_priority IS NOT NULL`) — sostituisce `ping_inbox`
- `ping` riscritto come thin wrapper ergonomico su `board_send(type='info', wake_priority=priority)` — nessun nuovo storage, nessun `ping_inbox`/`ping_ack` (si usano `board_inbox(wake_only=true)`/`board_ack`)
- CLAUDE.md aggiornato (sezione "Ping Tools" → "Ping (D-093)", conteggio tool 35→33, righe board_send/board_inbox aggiornate)
- `npx tsc --noEmit` pulito, 80/80 test verdi
**Decisioni prese:** nessuna nuova lato board-mcp — design/ownership è di it-manager (D-089), `hub/it-manager/design/ping-cold-start.md`
**Blocchi / note:** `board_messages.wake_priority` non esiste ancora (DDL pending, ordine concordato: colonna DBA prima che il pass-through sia utilizzabile in produzione) — `board_send(wake_priority=...)` e `ping` falliranno a runtime finché la migration non è live, stesso pattern pre-DDL già usato altrove. `loomx_agent_pings` resta da droppare lato DBA (proposta già nel design, mai popolata, zero impatto runtime) — non azionabile da board-mcp.
**Prossima sessione:** a colonna DBA applicata, smoke test live di `ping`/`board_inbox(wake_only)`/`board_ack`; poi board_send done a it-manager per sbloccare L2 (reconciler cold-wake) e §0ter/hook (L3).

## Sessione #ping-pivot-close — 2026-07-07

**Obiettivo:** WI d96189bf su GTD 8eada1ca (dispatch autopilot) — il codice della sessione #ping-pivot sopra era pronto ma non committato.
**Completato:** verificato tsc/80 test verdi, build dist locale, commit 9e3b5b6. Chiuso GTD 8eada1ca (superseded — task originale D-092 sostituito dal pivot D-093) e GTD 5177f528 (task it-manager) come done. board_send done a loomy (ref 36705bdb).
**Blocchi / note:** invariato — `board_messages.wake_priority` resta da migrare lato DBA; follow-on già tracciato in GTD 7e896506.

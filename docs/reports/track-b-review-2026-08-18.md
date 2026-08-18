# Review bottom-up: 30 CFG + 46 decisioni doc-in-DB — misurato, non dedotto

**Data:** 2026-08-18 | **WI FASE 1-3+5:** `889d6845-98df-41f5-8d8c-5baf019d75b6` | **WI FASE 4:** `dae06594-aa7c-4166-8d08-6c39bbb8a191` | **GTD:** `e95ea3d3-7332-40cd-bda8-d228d2dba36a`
**Autore:** board-mcp (autopilot) | **Mandato:** Achille via loomy, GTD sopra citato (v2, FASE 4 aggiunta dopo l'avvio del primo WI — vedi nota in FASE 4)

Metodo: ogni claim verificato leggendo `src/*.ts` corrente (non `dist/`, salvo dove citato per confronto), i log git dal 2026-08-16, e con chiamate live ai tool `doc_*`/`project_list`. Fleet census (.mcp.json) ri-eseguito da zero in questa sessione, non riletto dai CFG. Dove non ho potuto misurare, è dichiarato esplicitamente in fondo.

---

## FASE 1 — I 30 CFG trovano riscontro nella realtà?

I 30 CFG (`CFG-061`..`CFG-090`) sono stati scritti il 16/08 (sessione #80) come misurazioni "live" con citazioni file:riga. Da allora sono passati 2 giorni e 8 commit (`b23cd04`→`fe6d364`, package.json `0.16.1`→`0.16.6`). Il mio compito non era ri-leggere il loro testo come prova, ma ri-misurare oggi.

| CFG | Esito | Evidenza (oggi, 18/08) |
|---|---|---|
| CFG-061 | **CONFERMATO** | `src/wi.ts:58-104` — `checkDurableGate` filtra esattamente su `requirement`/`sdes_entry`/`decision`, nessun filtro su `status`. Codice invariato dal 16/08. |
| CFG-062 | **CONFERMATO** | `src/wi.ts:69-100` — due messaggi di rifiuto distinti (zero-link vs tipo-sbagliato) confermati parola per parola. |
| CFG-063 | **CONFERMATO ma OBSOLETO come divergenza** | `src/wi.ts:29-34` ha tuttora 4 `EPHEMERAL_TEMPLATES`. **Ma** la divergenza segnalata (CLAUDE.md ne documentava 3) è stata **già risolta** dal commit `8c6629c` (16/08 09:30, ~1-2h dopo la scrittura del CFG): CLAUDE.md oggi documenta tutti e 4. Il CFG descrive uno stato che non esiste più. |
| CFG-064 | **CONFERMATO** | `src/wiTemplates.ts` e `src/wi.ts:36-44` — `isEphemeralWi` con le 3 vie di bypass (force_ephemeral, EPHEMERAL_TEMPLATES, omissione→on-the-fly) identiche. |
| CFG-065 | **CONFERMATO** | `checkDurableGate` gira dentro `runDoc` (doc_rw); fleet census ripetuto oggi conferma le stesse 2 configurazioni senza backend doc_rw (vedi CFG-080). |
| CFG-066 | **CONFERMATO** | `src/tools.ts:1100-1116` — validazione `project_id` PRIMA dell'INSERT del GTD, identica. |
| CFG-067 | **CONFERMATO** | `src/tools.ts:1210,240` — `buildProjectWarning`, spread condizionale, `ok:true` sempre. Nessun valore sentinella introdotto. |
| CFG-068 | **CONFERMATO (storico)** | Il probe live del 16/08 è irripetibile (ha mutato stato), ma il codice che lo rende vero (`gov.relink_superseded` via `docDb.ts`) è tuttora presente e invariato. |
| CFG-069 | **CONFERMATO** | `src/docs.ts` — ordine imposto (detach code → superseded → insert nuova riga → relink → edge) confermato leggendo la sequenza in `docSupersede`. |
| CFG-070 | **CONFERMATO** | `src/docs.ts:891-895` — messaggio d'errore con id della nuova versione già creata, identico testualmente. |
| CFG-071 | **CONFERMATO** | Nessun `.update()` aggiunto alle 4 tabelle di link dal 16/08. Le uniche `.update()` in `docs.ts` restano 3 (righe 424, 847, 855) — la prima è `doc_item_upsert` su `doc_items` (fuori scope della claim), le altre due sono `doc_supersede`. |
| CFG-072 | **CONFERMATO** | `src/docs.ts:847,855` — esattamente 2 `.update()` in `doc_supersede`, entrambe su `doc_items` (`code:null` poi `status:superseded`), nessuna sulle tabelle di link. |
| CFG-073 | **CONFERMATO (struttura)** — grant DB **NON_VERIFICABILE** | Il codice che dipende dal REVOKE (routing esclusivo via `gov.relink_superseded`) è confermato; non ho accesso SQL diretto per rileggere `information_schema.role_table_grants` e confermare che il REVOKE sia ancora in piedi lato DB. |
| CFG-074 | **CONFERMATO (struttura)** — campione live processi **NON_VERIFICABILE** | `dist/` gitignored, singolo build condiviso, un solo processo stdio per window: confermato da CLAUDE.md + struttura repo. Il campione "5 processi vivi, 2 stale" era uno snapshot del 16/08, non riproducibile senza accesso host (`ps -eo lstart`) che non ho in questa sessione. |
| CFG-075 | **CONFERMATO** | Claim strutturale su Claude Code (nessun `/mcp reconnect` per stdio) — stabile, nessuna evidenza di contrario. |
| CFG-076 | **PARZIALMENTE OBSOLETO** | Al 16/08 `package.json` dichiarava `0.16.1` con feature `0.16.2` già nel build. **Da allora la disciplina è stata rispettata**: `0.16.2`→`0.16.3`→`0.16.4`→`0.16.5`→`0.16.6`, un bump per ognuno degli 8 commit successivi, verificato via `git log`. Il difetto "nessuno bumpa la versione" non si osserva più nella finestra misurata. Resta vero (invariato) che `/mcp` non espone la versione — limite di Claude Code, non di board-mcp. |
| CFG-077 | **CONFERMATO** | Conseguenza logica di 074/075/076, claim di processo/policy, coerente con lo stato misurato. |
| CFG-078 | **CONFERMATO** | `.mcp.json` di board-mcp letto ora: `DATABASE_URL` + `DOC_RW_DATABASE_URL`, nessuna `SUPABASE_SERVICE_ROLE_KEY`. `src/supabase.ts` — mutua esclusività (riga 23), identità da `current_user` (riga 94), rifiuto fallback (riga 112) tutti confermati testualmente. |
| CFG-079 | **CONFERMATO ESATTO** | Fleet census ripetuto da zero oggi (22 `.mcp.json`, non riletto dal CFG): stessi **5** agenti su `service_role` — `04. Sintesi Impianti`, `loomx-home-DBA`, `loomx-home-pm`, `19. Kinesis`, `23. LoomX Controlling`. 17 nativi. Nomi e conteggio identici al 16/08. |
| CFG-080 | **CONFERMATO ESATTO** | Stesso census: **2** configurazioni senza `DOC_RW_DATABASE_URL` — `19. Kinesis`, `23. LoomX Controlling`. `SUPABASE_MGMT_PAT` in **0/22**. Identico. |
| CFG-081 | **CONFERMATO** | `src/wi.ts:781` — messaggio `WI already closed (status=...) — checkpoint not recorded. Use wi_status to check your active WI.` identico oggi. |
| CFG-082 | **CONFERMATO** | 7 `.update()` in `tools.ts` (righe 522, 671, 1340, 1539, 2573, 2700, 3130 nel src attuale — la numerazione cambia rispetto a `dist.js` ma il conteggio e il pattern no): tutti seguiti da `.select()+.maybeSingle()` e check `!data`/`error`. Nessuna eccezione. |
| CFG-083 | **CONFERMATO ESATTO** | `src/wiTemplates.ts` invariato riga per riga. Census ripetuto oggi: `WI_TEMPLATES_PATH` in **0/22** `.mcp.json` — stesso zero del 16/08, non è drift, è assenza strutturale del prerequisito. |
| CFG-084 | **CONFERMATO ESATTO** | `LOOMX_RW_GUARDS_ENABLED` in **0/22** oggi, confronto stretto `"1"` confermato nel codice. |
| CFG-085 | **CONFERMATO ESATTO** | `LOOMX_MODEL_GUARDS_ENABLED` in **0/22** oggi. |
| CFG-086 | **DIVERGENTE (framing, non sostanza)** | Il CFG dice "l'enum è hardcoded". Misurato: `validSlugs` (src/tools.ts:256) deriva da `resolveAgentRegistry()` (src/supabase.ts:134), che **interroga `board_agents` a boot** — non è un array letterale nel sorgente. È la *description* del tool MCP (fissata una sola volta quando `server.tool()` viene chiamato in avvio) a restare statica per la vita del processo — quello è vero e la conseguenza pratica descritta (nuovo agente non indirizzabile dalle window vecchie) resta corretta. Ma "hardcoded" implica un array in sorgente che non esiste: la fonte è il DB, congelata dal boot. |
| CFG-087 | **CONFERMATO ESATTO** | `src/tools.ts:3328` — guardia `triggered_by` identica al carattere. |
| CFG-088 | **CONFERMATO ma OBSOLETO come divergenza** | `project_list` live oggi: **funziona**, nessun `permission denied`. La divergenza segnalata (CLAUDE.md dava il gap per bloccante) era **già stata rimossa** dallo stesso commit `8c6629c` che ha risolto CFG-063, poche ore dopo che il CFG era stato scritto. |
| CFG-089 | **CONFERMATO ESATTO** | `doc_item_types('config_pattern')` chiamato live oggi: schema `attrs` (component/env/format) identico, stessi enum. |
| CFG-090 | **CONFERMATO in parte + 1 contraddizione non risolta** | Ri-verificato oggi, indipendentemente: `doc_item_resolve(project=22ae4e79, code="CFG-061")` → non esiste nel hub. `doc_query(project=22ae4e79, document_type=config_pattern)` → 0 righe. **Le 30 righe restano solo in `596cd5fc`, non migrate.** Confermato. **Ma** ho trovato una contraddizione che il CFG stesso non registra: il messaggio DBA `588c775c` (16/08 07:57Z) dichiara che il documento `794e873c` era stato sbloccato e un INSERT reale era stato verificato con successo (in transazione ROLLBACK) — **prima** che CFG-090 (scritto più tardi lo stesso giorno) riportasse 5 tentativi falliti con "document not found". Non ho potuto arbitrare la causa: al momento del probe, la distinzione RLS-block vs vera-assenza (D-167, shippata solo oggi con `e5d9db0`) non esisteva ancora — l'errore generico non discriminava. Non ho ripetuto il tentativo di scrittura per non violare il mandato "non spostare/duplicare" del GTD. **Segnalo, non arbitro.** |

**Conteggio finale FASE 1:** 22 CONFERMATO netti · 3 CONFERMATO-ma-obsoleti (la divergenza segnalata è stata risolta nel frattempo: CFG-063, CFG-076 parziale, CFG-088) · 1 DIVERGENTE di framing (CFG-086) · 1 con contraddizione documentale non arbitrabile (CFG-090) · 0 OBSOLETO puro · 0 casi in cui il sistema reale abbia smentito il codice dichiarato. **Nessun CFG dei 30 si è rivelato falso nella sostanza tecnica.** Il tasso di errore reale è sulla *freschezza*, non sulla *misura*: 3 CFG descrivono correttamente uno stato del 16/08 mattina che è stato corretto nello stesso giorno, poche ore dopo — un artefatto del fatto che Track B e la sua correzione sono corse in parallelo, non un difetto di misura.

---

## FASE 2 — Da CFG a SDES

Misurato direttamente dai contatori `links.doc_out`/`links.doc_in` restituiti da `doc_query(summary:true)` (non dedotto): **tutti i 30 CFG hanno `doc_out:0` e `doc_in:0`** (eccetto CFG-074 e CFG-083, che hanno un link `wi:1` verso il proprio Work Item di scrittura — non verso un SDES). Specularmente, i 26 SDES esistenti hanno tutti `doc_out≥1` (verso REQ) ma **nessuno linka un CFG**.

**Non è un caso di "alcuni CFG orfani" o "alcuni SDES senza CFG": è una separazione strutturale totale.** I due corpora — REQ→SDES→UAT (progettato, D-070 onda-3) e CFG-061..090 (Track B, scoperte operative del 16/08) — non si toccano nel grafo di tracciabilità. Non è necessariamente un difetto: i CFG documentano stato-di-fatto misurato (gate, guard, rollout), non specifiche di design; ma se l'intento è che un CFG *motivi* un SDES, oggi quell'intento non è realizzato in nessuno dei 30 casi.

---

## FASE 3 — Da SDES a REQ

**Controllo positivo prima dello zero** (richiesto esplicitamente dal GTD, D-167): ho lanciato `sdes_without_uat` sullo stesso meccanismo/path RLS di `req_without_sdes` — ha restituito **12 righe reali** (non un errore, non un vuoto). Questo dimostra che il path traceability funziona e non sta silenziosamente fallendo per RLS. Sullo stesso path:

- **`req_without_sdes` → 0 righe.** Con il controllo positivo sopra, questo zero è affidabile: **copertura REQ→SDES completa**, tutti i 37 REQ hanno almeno uno SDES.
- **`sdes_without_uat` → 12/26 (46%).** Gli SDES scoperti: `SDES-015` fino a `SDES-026` (contigui) — `wi_end side-effects staging`, `WI filesystem cache`, `wi_checkpoint accumulation`, `template_layer derivation`, `doc_item_upsert idempotency`, `doc_link routing`, `gate wi_end durable`, `atomic autopilot arm`, `pull enabler`, `cross-project references`, `doc_query lean output`. Non è un gap distribuito a caso: sono gli SDES **più recenti** (numerazione alta), coerente con "il lavoro nuovo non ha ancora UAT", non con "il lavoro vecchio ha perso copertura".

---

## FASE 4 — Le 42 (46) decisioni: sono RISPETTATE?

**Aggiunta da Loomy dopo l'avvio del WI originale** (msg `0d8298bd`, GTD `e95ea3d3` v2) — round separato (WI `dae06594`), stesso mandato bottom-up, stesso metodo "misurare non dedurre". Perimetro: le **43 decisioni** del progetto `596cd5fc` (che includono già le 6 sotto-decisioni `D-a5-*`/`D-REQ-GOV-016` sul modello documenti) + le **3** decisioni core/cross esplicitamente citate dal GTD che governano il modello documenti (`D-150`, `D-155`, `D-167`). **`D-a5` come codice a sé non esiste**: risolto oggi con `doc_item_resolve` su entrambi i progetti candidati, 0 risultati in entrambi — è il nome della famiglia/iniziativa (F1, F3, F4.5, write-path-fix, migration, upsert-patch-semantics, REQ-GOV-016), non una decisione autonoma; le 6 sotto-decisioni sono già nel conteggio dei 43. Totale verificato: **46**, non 42 — il GTD arrotondava.

Metodo di esecuzione: 7 agenti paralleli (6 sul corpus di progetto in lotti da 6-9, 1 sulle 3 cross-decision), ciascuno con il testo integrale della decisione e il mandato di leggere `src/*.ts` corrente, interrogare il DB via i tool MCP, e citare `file:riga` o query+risultato — mai il testo della decisione come prova di sé stessa. Un solo agente (lotto E) ha eseguito una `doc_item_upsert` idempotente in PATCH-mode su una riga già esistente per confermare che il path `doc_rw` scrive davvero (non solo legge); dichiarato qui per trasparenza — non ha toccato dati diversi da quelli già presenti.

**Le VIOLATE/NON_APPLICATE/SUPERATE_DAI_FATTI per prime**, come richiesto dal mandato.

| Decisione | Esito | Evidenza |
|---|---|---|
| **D-010** — Governance dei tag: Loomy owner, Postman enforcer | **NON_APPLICATA** | `board_send`/`board_broadcast` (`src/tools.ts:310,585`) accettano `tags: z.array(z.string())` libero, nessuna whitelist/enum, nessuna logica di rifiuto in tutto `tools.ts`. Confermato anche in `docs/HISTORY.md:243` di una sessione precedente. GTD follow-on `50d93acf` già aperto e non armato, in attesa di Loomy — non è una regressione di oggi, è un divario mai chiuso. |
| **D-150** — Riferimenti nelle decisioni pinnano un hash; artefatto modificato marca `stale` i riferimenti via GTD armato | **NON_APPLICATA** | Nessuna colonna hash, nessun meccanismo di staleness, nessun `content_hash`/`ref_hash` in `src/` né nelle migration DBA. `loomx-home-DBA/docs/HISTORY.md:39` conferma: la generalizzazione (progetto "LoomX Items Subscription") è **ancora in discussione con Achille**, esplicitamente "non partire a implementare". Decisione ratificata il 16/08, a oggi (18/08) solo una proposta. |
| **D-a5-F3** — pilota dogfood: `documents.attrs jsonb` proposto per metadati doc-level | **NON_APPLICATA** | `docCreate` (`src/docs.ts:121-166`) non scrive/legge alcun campo `attrs` su `documents`; il workaround descritto nella decisione stessa (metadati dentro l'`attrs` di un item `content_slot`/`section`) resta la via in uso (`src/docTypes.ts:319-324`). La decisione la marca esplicitamente "non bloccante" — coerente con non-applicata, non con violata. |
| **D-004** — Service role key come unico backend DB | **SUPERATA_DAI_FATTI** | `src/supabase.ts:17-57` supporta ORA due backend: `DATABASE_URL` (pg diretto, identità nativa per-agente via `resolveSelfSlug`, D-084) come via preferita (`.env.example` la marca "preferred"), `SUPABASE_SERVICE_ROLE_KEY` degradato a "legacy mode". `D-084` (verificata sotto, RISPETTATA) implementa esattamente l'identità per-agente che D-004 escludeva. **D-004 resta `status=active` in DB, nessun `doc_supersede` verso D-084** — decisione mai formalmente ritirata/aggiornata nonostante il sistema abbia preso un'altra strada. |
| **D-016** — `gtd_update`: solo loomy può riassegnare `owner`, altri agenti ricevono errore | **SUPERATA_DAI_FATTI** | `src/tools.ts:1247-1249`: il guard è `!(isLoomy \|\| isBroker)`, quindi anche `loomy-assistant` (broker) può riassegnare owner senza errore — un "altro agente" per il testo letterale di D-016. Pattern `isLoomy \|\| isBroker` pervasivo e consistente in tutto `tools.ts` (7+ occorrenze), presente già dal commit iniziale del broker — non un bug isolato ma un'estensione architetturale mai riflessa nel testo della decisione. |

**Le RISPETTATE (41/46)** — materiale per il SoW, elenco compatto per codice (evidenza completa nei transcript degli agenti, disponibile su richiesta):

`D-001` (Zod), `D-002` (Supabase singleton), `D-003` (self-send prevention), `D-005` (slug→code resolution), `D-006` (enrichment slug in board_inbox), `D-007` (validazione dinamica slug), `D-008` (board-mcp product owner comunicazione), `D-009` (inbox esclude archiviati), `D-011` (GTD ownership enforcement), `D-012` (GTD owner=slug), `D-013` (dual DB backend con fallback), `D-014` (home scoping), `D-015` (delete in pg-shim), `D-017` (HOME_USER_ID = auth.users id), `D-018` (rename loomx-tracker), `D-019` (WI deviations §5.2), `D-020` (preview mode), `D-021` (cache locale WI), `D-022` (co-engagement tools), `D-043`/`D-047`/`D-048` (split/rename agenti — verificati anche live via `board_send`/`org_lookup`), `D-050` (GTD+WI self-arming), `D-051` (LoomX Chat remote MCP), `D-053` (runtime_request control-plane), `D-055` (gtd_overview), `D-058` (enum `continue`), `D-059` (broker elevation — nota sotto), `D-070` (doc_item_gtd/wi_links), `D-084` (identità da current_user), `D-100` (broker ack scoping — nota sotto), `D-101` (contratto cambio-modello + guard Haiku gated), `D-102` (project_id opzionale su gtd_add), `D-a5-F1` (8 tool doc_* + capability-parity), `D-a5-F4.5` (wiring doc_rw, verificato anche live), `D-a5-write-path-fix` (no-RETURNING mode, verificato anche live), `D-a5-migration` (DECISIONS.md mirror DB-first), `D-REQ-GOV-016` (niente service_role fallback), `D-a5-upsert-patch-semantics` (PATCH semantics, verificato claim per claim), `D-155` (CHECK `doc_item_xproject_links` allargato — DDL + applicazione live confermate su Supabase e VPS), `D-167` (tutte e 4 le sotto-clausole: membership dba+auditor su `669fd07b`, `auditor_select_all` su `documents` applicato lo stesso 18/08, `visibility_gap`, 403-vs-404).

**Note su 2 "RISPETTATE" con drift testuale non sostanziale** (segnalate dagli agenti, non abbastanza gravi da retrocedere il verdetto):
- **D-059**: il testo originale descrive il broker su `board_ack` come "filtro rimosso" (accesso illimitato); il codice attuale lo scopa a `[selfCode, loomyCode]` — un commit successivo dichiara esplicitamente che questo *è* l'intento originale di D-059 (fix di una regressione). La clausola su `gtd_query` (esclusa esplicitamente da D-059) è invece stata volutamente riaperta da una decisione successiva (D-066, non in questo lotto) — superseduta, non violata per negligenza.
- **D-100**: il testo dice "filtro diventa `to_agent=loomyCode`" (singolo valore); il codice ritorna `[selfCode, loomyCode]` (inbox propria + di loomy) per una fix documentata post-D-100 che correggeva una regressione sull'inbox del broker. L'invariante centrale — il broker non è mai allargato ad agenti arbitrari — è preservato e testato (`tests/gtd.test.ts:94-148`).

**Conteggio FASE 4:** 41 RISPETTATA · 3 NON_APPLICATA (D-010, D-150, D-a5-F3) · 2 SUPERATA_DAI_FATTI (D-004, D-016) · 0 VIOLATA. **Nessuna decisione fa il contrario di ciò che prescrive** — il precedente D-099/flag-acceso-27-giorni cercato esplicitamente dal mandato **non ha un pari in questo corpus**: i 3 gap trovati sono trasparenti (GTD/HISTORY che li documentano già come aperti), non flag che mentono silenziosamente sul proprio stato.

---

## FASE 5 — La domanda di perimetro

**Misura diretta, non prevista dal GTD:** esistono **tre** progetti nel dominio "modello documenti", non due.

| Progetto | id | owner | Contenuto misurato |
|---|---|---|---|
| `board-mcp` | `596cd5fc` | board-mcp | 162 item: 37 REQ · 26 SDES · 22 UAT · 30 CFG · ~42 decisioni (prodotto + parte del modello) |
| `doc-in-db` | `1e59391d-9754-4b92-8ce0-393544e10012` | loomy | 0 item — **ma board-mcp non ha visibilità/membership sul progetto** (`visibility_gap:true` alla mia query), quindi il mio "0" non è una misura indipendente: eredito il numero dichiarato dal GTD, non l'ho potuto ri-verificare da qui |
| `Pilot D-a5 (document model dogfood)` | `8930ff35-3c8d-466f-b003-ac39500805b2` | **board-mcp** | **11 item, non citato dal GTD**: 4 decisioni (incl. `PD-001..003-PMQWI9I9V`), 1 REQ (`REQ-HAIKU-1`), 1 objective, 1 deliverable, 1 stop_condition, 1 section, 1 prose — artefatti F0/F1 del pilot originale che ha "provato" il modello documenti end-to-end |

Il terzo progetto è la scoperta più rilevante di questa fase: è **board-mcp-owned**, contiene esattamente il tipo di governance artifacts (decisioni, REQ, obiettivo, deliverable, stop-condition) che ci si aspetterebbe in un "SoW retroattivo del modello documenti" — e non è né `596cd5fc` né `1e59391d`. Sembra il pilot originale da cui il modello D-a5 è nato, dimenticato dopo che l'implementazione è confluita nel prodotto board-mcp.

**Classificazione D-a5 vs prodotto, sui 26 SDES di `596cd5fc`** (REQ e UAT non classificati — vedi limiti): **7/26 (27%)** riguardano esplicitamente il modello documenti — `SDES-009` (doc_rw+GUC), `SDES-010` (capability-parity gate), `SDES-012` (tool self-describing doc_*), `SDES-019` (doc_item_upsert idempotency), `SDES-020` (doc_link routing), `SDES-025` (cross-project references), `SDES-026` (doc_query lean output). I restanti **19/26 (73%)** riguardano il prodotto MCP in senso stretto (board, GTD, WI, runtime, home). I 30 CFG di Track B sono quasi tutti nel dominio D-a5/gate D-074/RLS — cioè descrivono *come il prodotto board-mcp implementa* il modello, non il modello in astratto.

**Raccomandazione (non decisione — spetta a Loomy):** dato che (a) il modello D-a5 è oggi consumato **solo** da board-mcp — nessun altro agente scrive `doc_*` direttamente, tutti passano dai tool MCP di board-mcp — (b) un quarto abbondante del corpus SDES esistente già descrive il modello dentro `596cd5fc` senza attrito, e (c) esiste già un terzo progetto dimenticato che frammenterebbe ulteriormente la storia se ignorato: **assorbire** mi pare la scelta con meno debito. Se in futuro il modello servirà ad altri consumer (altri agenti che scrivono `doc_*` senza passare da board-mcp), allora avrà senso "riempire" `doc-in-db` con le sole decisioni/REQ cross-cutting non ancora scritte, senza spostare lo storico. "Chiuderlo" pare la scelta peggiore: il progetto è referenziato dal GTD stesso e dal Pilot D-a5, cancellarlo perderebbe quel filo.

---

## Cosa NON ho potuto verificare

1. **Grant/REVOKE reali lato DB per CFG-073** — nessun accesso SQL diretto da questa sessione; mi affido al codice (routing esclusivo via `gov.relink_superseded`) e alla migration committata, non a una rilettura di `information_schema`.
2. **Età reale dei processi MCP vivi (CFG-074/081)** — richiede `ps -eo lstart` sull'host, non disponibile da qui. Il campione "5 vivi, 2 stale" del 16/08 non è riproducibile a posteriori: è uno snapshot del momento, non una proprietà stabile.
3. **Conteggio "0 doc_items" di `doc-in-db`** — board-mcp non ha membership su quel progetto (`visibility_gap:true` misurato). Non l'ho potuto verificare indipendentemente: ho ereditato il numero dal GTD.
4. **Contraddizione CFG-090 vs msg `588c775c`** — non arbitrata. Non ho ripetuto la scrittura live per rispettare il mandato "non spostare/duplicare"; servirebbe DBA per rileggere l'ordine temporale esatto entro la sessione del 16/08.
5. **Classificazione REQ (37) e UAT (22) per la domanda di perimetro** — ho classificato solo i 26 SDES (per headline). Estendere a REQ/UAT richiederebbe leggere 59 body aggiuntivi; non l'ho fatto per contenimento di scope, dichiarato qui invece che spacciato per completo.
6. **CFG-086, conteggio esatto degli slug attivi oggi** — ho verificato il *meccanismo* (DB-derived a boot), non ho ri-contato le righe attive in `board_agents` per confermare che siano ancora 36.
7. **D-084, claim (b) "selfSlug già fluisce in runDocRw→loomx_set_agent_slug, nessun cambio separato necessario"** — è un'affermazione negativa (assenza di codice aggiuntivo), verificata per coerenza ma non falsificabile oltre la conferma che `selfSlug` è l'identità usata ovunque.
8. **D-101, causa radice del bug storico `69f39997`** (CHECK constraint DB mancante il valore `'model'`) — non ri-verificata via query diretta su `information_schema`/`pg_get_constraintdef`; il testo CLAUDE.md la dichiara fixata dal DBA il 21/07, non contraddetta da nulla osservato ma nemmeno ri-controllata alla fonte in questo giro.
9. **D-a5-migration, conteggio esatto "36 item / 7/7 DoD"** del runbook storico — non ri-eseguibile senza riprodurre l'intera migrazione; verificato solo che l'assetto DB-first + mirror generato sia tuttora in vigore.
10. **D-167, sottoclausola `visibility_gap`** — verificata staticamente sul codice (branch a 0 righe → `visibility_gap:true`), non con un test end-to-end che riproduca davvero un RLS-block (avrebbe richiesto costruire uno scenario di accesso negato, non giustificato per una probe).
11. **D-150, generalizzazione in corso ("LoomX Items Subscription")** — misurato solo che è "in discussione", non ho letto il design doc del progetto candidato per capire quanto sia vicino a un'implementazione.

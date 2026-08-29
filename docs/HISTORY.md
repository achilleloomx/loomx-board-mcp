# HISTORY — Board MCP Server

> Storico sessioni dello sviluppatore MCP.

---

## Sessione #136 — 2026-08-29 (autopilot dispatch, GTD `ffe8b687`, WI `831b11a8`)

**Task:** punto 4 della coda D-229 lasciato dichiarato-ma-non-eseguito dalla sessione #135 — estendere il filtro dei source rows in `docTraceability()` (`req_without_sdes`/`sdes_without_uat`) dal solo `status !== "superseded"` all'intero `RETIRED_STATUSES` (superseded/deprecated/archived/rejected), già in uso da `broken_refs` (`RETIRED_STATUS_SET`, `src/docs.ts:2179/2339`) nello stesso file.

**Fatto:** `src/docs.ts:1797` ora filtra `!RETIRED_STATUS_SET.has(s.status)` invece di `s.status !== "superseded"` — stessa riga, stesso pattern del resto del file, nessun cambio di forma della risposta. Aggiunto un test (`tests/docs.test.ts`) che crea REQ `deprecated`+`rejected`+una viva nello stesso progetto e verifica che `total_sources`/`count` su `req_without_sdes` contino solo quella viva — prima del fix sarebbero stati sommati anche i due retired, gonfiando `total_sources` di rumore.

**Nota collaterale, non nello scope del task ma emersa leggendo il codice adiacente:** `docTraceabilityOrigin()` (`req_without_origin`, `src/docs.ts:1971-1979`) porta un commento — *"same fix as req_without_sdes/sdes_without_uat... applied here"* — che si è rivelato **non vero**: il filtro lì resta `s.status !== "superseded"`, mai esteso a `RETIRED_STATUSES`. Non toccato qui (task scoperto meccanico e scoped alla sola riga 1797 dal GTD; allargarlo sarebbe stato un cambio di regola non richiesto, D-136 §5) — segnalato a loomy nel messaggio di chiusura come possibile follow-on.

**Verifiche:** `tsc --noEmit` pulito, build pulita, `npm test` **308/308** (1 nuovo, 0 falliti).
**Decisioni prese:** nessuna — fix meccanico a rischio nullo, come classificato dal GTD stesso.
**Blocchi / note:** nessuno.
**Prossima sessione:** eventuale follow-on su `docTraceabilityOrigin()` (commento fuorviante, non fix applicato) — non aperto come GTD qui, solo segnalato, per non pre-decidere una priorità che non è mia (D-136 §5).

---

## Sessione #135 — 2026-08-29 (wake cold-start msg loomy `38e9afaa`, coda D-229, WI `c0d74980`)

**Wake su coda ordinata post-sessione (GO Achille D-229), 4 punti.** Punti 1 (`broken_refs`) e 3 (`fact_sync` 4bis) risultavano **già consegnati** dalle due sessioni immediatamente precedenti (`#134` v0.26.0, commit `d721a9f`; e la sessione che ha prodotto `7b9faf1` v0.27.0) — nessuna scrittura necessaria, solo verifica per lettura del codice/CLAUDE.md. Lavorati qui i punti 2 e 4.

**Punto 2 — triage dei draft SDES doc-in-db.** Trovati **15**, non 16 (uno risultava già chiuso da una sessione precedente). Per ciascuno, verifica **nel codice sorgente** (grep + read, non per lettura del solo testo della entry) di cosa fosse realmente costruito:

- **3 marcati `active` (as-built confermato):** `SDES-DOCM-018` (`working_doc` — registrato in `docTypes.ts`, non-pubblicabilità **testata** in `tests/subscriptions.test.ts:515`); `SDES-DOCM-023` (WI-C, meccanismo deduce-and-warn — GTD `4a591cfe` già chiuso, test in `tests/docs.test.ts` sulla classe "wrong document"; la entry stessa dichiarava già l'as-built nel corpo, mancava solo il flip di `status`); `SDES-DOCM-027` (ISS-004 — la correzione alla description di `req_without_origin` in `src/tools.ts:3667` è presente e corrisponde esattamente a quanto la entry dichiarava "applicata in questa stessa WI").
- **2 tentati `deprecated` (istruzione "scopa G.1, G.3\") — RIFIUTATI dal floor DB, non forzati.** `SDES-DOCM-019` (WI-G.1) e `SDES-DOCM-021` (WI-G.3): nessuna delle due implementazioni esiste nel codice (`target_kind` di `doc_link` resta `doc|gtd|wi`, nessun `doc_header`; nessun read-path per-versione-pubblicata). Ma `doc_item_upsert` ha rifiutato il retire — **entrambe hanno riferimenti in entrata senza erede dichiarato** (`UAT-DOCM-019` verifies + xproject `LAV-013` references su 019; `UAT-DOCM-021` verifies su 021). Lette le due UAT: dichiarano esplicitamente *"Casa (approvata 28/08, mandato loomy msg `ebc86f25`): DEL-A4 → WI-G, sul percorso critico del programma (prerequisito di B1 e C3)"* — cioè un giorno prima della coda di stasera, loomy le aveva messe sul percorso critico del Programma Manifesti. **Conflitto reale, non inventato un contratto per risolverlo (D-136 §5):** lasciate `draft`, girato a loomy nel messaggio di chiusura invece di forzare lo scrap.
- **Restanti 10 lasciati `draft`, verificati uno per uno contro il codice** (nessuno è "as-built" nè sui due elenchi espliciti G.1/G.3): `012` (oracolo booleano — solo 2 delle 5 superfici applicate), `014` (parità capability ancora mirror in-code, non `pg_catalog`), `015` (backlog, vedi punto 4 — e (b) risultato **fattualmente superato**: il codice conta oggi la coverage cross-project, decisione opposta a quella descritta nella entry), `016`/`017` (owner dba, bloccati), `024` (inventario meta — parzialmente reso stale da `doc_structure`, che ora copre il read-path header che la entry segnalava mancante, ma il resto della tabella resta valido: non forzato nessun flip), `025` (2 lacune reali confermate assenti: changelog auto-verificato, cancello ritiro critical), `026` (`expect`/`retired`/`doc_item_retire` assenti), `028` (gate cross-project fase 1 assente — zero occorrenze `doc_versions` in `docs.ts`), `029` (bloccato su `017`, invariato).

**Punto 4 — backlog filtro rejected.** Pianificato come GTD `ffe8b687` (low, non armato): `docTraceability()` (`src/docs.ts:1797`) filtra solo `status !== "superseded"`, non l'intero `RETIRED_STATUSES` già usato altrove nello stesso file. Fix meccanico a rischio nullo, dichiarato ma non eseguito ora (rispetta l'etichetta "low" della coda).

**Decisioni prese:** nessuna — il conflitto G.1/G.3 e la nota su SDES-DOCM-015(b) sono girati a loomy, non decisi qui (D-136 §5).
**Blocchi / note:** nessuno bloccante per la sessione stessa. Il conflitto G.1/G.3 blocca lo scrap letterale finché loomy non chiarisce se il mandato `ebc86f25` (28/08) è superato dalla coda di stasera o viceversa.
**Prossima sessione:** dipende dalla risposta di loomy su G.1/G.3; GTD `ffe8b687` resta in backlog low.

---

## Sessione #134 — 2026-08-29 (wake cold-start msg loomy `d429d82f`, WI `44b30f7d`, v0.26.0)

**Task:** le due risposte di loomy alle domande aperte lasciate dal congegno di decadimento. **R4** — il mantenimento automatico delle sottoscrizioni `fact` è **deciso** (D-225, integrazione **4bis**): prima attivazione per progetto sempre manuale, da lì in poi automatico; il *meccanismo* è lasciato a questo server («è implementazione, non contratto»). **R6** — la lacuna del pin di versione sui legami cross-progetto è confermata come **debito dichiarato**: si progetta, non si esegue ora.

**R4 — meccanismo scelto: hook sincrono dentro `doc_link`** (SDES-DECAY-003, `refines` SDES-DECAY-002, WI linkato per il gate D-074). Le due strade erano l'aggancio a `doc_link` filtrato sull'opt-in e una cadenza del reconciler: scelta la prima perché la finestra fra «il legame è dichiarato» e «il legame può far decadere» **è** il difetto REG-011 (una riscrittura sostanziale arrivata mentre nulla era ancora sottoscritto), e una cadenza l'avrebbe riaperta di un periodo aggiungendo una dipendenza cross-repo per una regola che vive qui. `doc_fact_sync` resta l'atto di attivazione **e** la rete di recupero per i legami creati fuori da questo server: il suo `dry_run` è la misura della deriva.

**L'opt-in non è un flag nuovo, è un fatto misurato:** un progetto ha attivato il decadimento se e solo se ha già ≥1 sottoscrizione `origin='fact'` attiva. Vero per costruzione — `doc_fact_sync` è l'unico scrittore di `fact` e richiede una chiamata esplicita di un titolare legittimato; l'hook non può auto-innescarsi. Scartate e dichiarate le due alternative: una chiave per-progetto in `loomx_governance_params` (registro cross-progetto, inventerei una convenzione non mia, D-136 §5) e una colonna su `loomx_projects` (schema del dba, D-005, e loomy ha chiesto di non aprire migration nell'ondata corrente). Limiti dichiarati nella SDES: l'opt-in così definito non è revocabile — ma nemmeno le `fact` lo sono (SEC-011) — e non esiste prima della prima sincronizzazione, che è esattamente ciò che «la prima attivazione è la sincronizzazione» significa.

**Ogni esito esce in `fact_subscription`, anche quando non deriva niente.** Derivata · progetto senza opt-in (il legame è dichiarato ma non fa decadere nulla: la forma esatta di REG-011, detta al momento in cui il legame nasce) · cross-progetto (mai derivata: nessun pin di versione lì — è il debito R6, e la nota lo cita) · ammissione sospesa (stesso gate di `doc_subscribe`) · già coperta · **opt-in non verificabile → astensione**. Quest'ultima è deliberatamente l'opposto del gate di ammissione, e la differenza è il punto: dove `doc_fact_sync` procede su un flag illeggibile perché un umano ha appena dato il GO, qui dentro non c'è nessun umano, e una scrittura irreversibile non si fa su una precondizione non verificata.

**Il `SAVEPOINT` non è prudenza, è necessità.** Sotto `doc_rw` l'intera chiamata è **una** transazione: senza protezione una query fallita dentro l'hook aborte anche l'INSERT del chiamante — l'hook sarebbe capace di distruggere il legame che esiste per arricchire. Avvolto **tutto** l'hook, non solo la scrittura (una SELECT fallita aborta esattamente come un INSERT: è il difetto che fece rispondere «0 sottoscrizioni» a `doc_structure` per un progetto che ne aveva 104).

**Un difetto reale trovato dal vivo, non dai test — e la scoperta che lo ha causato.** Il primo `doc_link` fatto dai tool MCP dopo la build è fallito con `deriveFactOnLink is not a function`, **rollbackando un link legittimo**. Causa: il processo MCP vivo aveva `docs.js` della build nuova e `factSync.js` ancora della vecchia. **G4 è più affilato di come è scritto in CLAUDE.md**: i moduli ESM si caricano alla prima invocazione, quindi rigenerare `dist/` a window aperta non lascia la window «sul build precedente» — la lascia su un **mix**, con errori che non corrispondono a nessuna build mai esistita. Due conseguenze, entrambe chiuse: (a) il mio codice metteva l'`import` dinamico **fuori** dal guard, quindi la promessa «l'hook non fa mai fallire il link» non reggeva sul fallimento del caricamento — corretto, con test di regressione; (b) segnalato come issue di flusso `[ISS-???]` (GTD `8471a512`, waiting_on it-manager, msg `3cd7d69b`), perché la regola G4 sta nel CLAUDE.md di tutta la flotta e la sua formulazione attuale è ottimista.

**Verifiche.** 300/300 unit test (10 nuovi), `tsc` e build puliti. **Sei prove dal vivo** contro il DB di produzione in transazioni annullate (`tests/verify-fact-on-link.ts`): il ciclo completo attivazione-manuale→mantenimento-automatico costruito e distrutto in una sola transazione, e la prova che conta — un errore SQL reale dentro l'hook lascia la transazione **usabile** e il lavoro precedente intatto (nessun fake può provarlo: lì `savepoint()` è un no-op). **Non verificato dal vivo:** il ramo «progetto senza opt-in» — board-mcp ha già 103 `fact` ed è l'unico progetto di cui questo agente è membro; resta coperto dai soli test unitari.

**R6 — GTD di design aperto, non armato** (`ba5d6cd0`, priorità normal, come richiesto). Porta la misura, non impressioni: `doc_item_xproject_links` ha **283** righe (relates_to 158 · references 115 · refines 10) e **zero** `verifies`/`satisfies`, quindi oggi il pin mancante non blocca il decadimento derivato — blocca la tracciabilità delle citazioni, e diventerebbe bloccante il giorno in cui un legame di verdetto attraversa un confine di progetto. Le 74 sottoscrizioni attive su 273 con bersaglio in un altro progetto il pin ce l'hanno già: il modello funziona, manca sui link. Nel GTD anche il punto scomodo del backfill (scrivere la versione *corrente* sulle 283 righe esistenti affermerebbe il falso) e la stima migration richiesta per il dba.

**Decisioni prese:** nessuna decisione formale mia — D-225/4bis è di loomy; la scelta del meccanismo è implementazione, registrata come SDES-DECAY-003.
**Blocchi / note:** questa window resta col `dist/` misto fino al restart — i `doc_link` doc↔doc dai tool MCP falliscono qui finché non riparte (il link `refines` della SDES è stato creato dal sorgente locale via `runDocRw`, riletto e confermato). Nessun restart di flotta forzato di mia iniziativa (G4).
**Prossima sessione:** R6 è design, non armato — lo prioritizza loomy a ondata chiusa. Restano in coda dalle sessioni precedenti: lotto A copertura collaudi (`406d6abd`), GO instradamento `tools.ts` (`e45af7dc`), 3 follow-on D-166 (`ea6cbc7a`), esiti dei 7 esenti (`db47608f`).

## Sessione #133 — 2026-08-29 (autopilot dispatch: chiusura GTD `22e199a6` Manuale Operativo, WI `93007bc5`)

**Task:** riprendere il GTD "Delega loomy: sottoscrizioni mancanti MAN-000/010/011/012 + doc_publish Manuale Operativo v0.1 (doc 7a3445d2)" — `resume_hint` indicava sottoscrizioni fatte (14/14) ma `doc_publish` bloccato da ownership check (SDES-SUB-003 §2, board-mcp non è owner del progetto `manuale-operativo`).

**Verificato, nessuna scrittura necessaria.** `doc_structure(074e41c4)` + `doc_query(summary=true)` mostrano che nel frattempo il blocco si è sciolto: documento `7a3445d2` già pubblicato (`publications:1`, `last_published_version:"0.1"`), tutte le sezioni MAN-000/010/011/012/020/030/033 attive, 21 sottoscrizioni `choice` sul progetto. Il lavoro delegato risultava già completato (presumibilmente da loomy, owner del progetto) prima che questa dispatch ripartisse sul GTD.

**Decisioni prese:** nessuna. Solo verifica e chiusura.
**Blocchi / note:** nessuno. Segnalato a loomy per conferma/visibilità (msg `c526d6ff`).
**Prossima sessione:** dipende dal prossimo dispatch — inbox ha 1 messaggio pending reale (loomy, task `d429d82f`: apri GTD design per R6, version-pin cross-link debt).

## Sessione #132 — 2026-08-28 (wake auditor: ri-verdetto caso zero v3, R3 fixato, GTD `3e380cfa`, WI `e0c849c5`)

**Wake cold-start su un messaggio dell'auditor** (`d03ff4c8`, ri-verdetto v3 del caso zero) con tre difetti misurati sulle superfici board-mcp — tutti della stessa forma: «la superficie c'è, risponde, e dà una risposta che sembra buona».

**R3 — fixato e testato dal vivo.** `visibilityGap()` era ancorata a `loomx_agent_in_project()` (membership), ma dba ha aperto un ramo di lettura deliberatamente separato dalla membership (`loomx_document_visibility_predicate`, SELECT-only): un'identità non-membro con visibilità reale otteneva comunque `visibility_gap:true` su un conteggio a 0 vero (astensione falsa, il gemello del verde di carta — colpiva esattamente REQ-016). Fix: prima di guardare la membership, la funzione prova a leggere una riga reale sul progetto con la stessa connessione RLS-scoped — se legge qualcosa, il conteggio a 0 è vero e niente gap. Test aggiunto che riproduce lo scenario esatto misurato dall'auditor (documento `visibility=org`, nessuna membership, righe visibili di un tipo diverso da quello cercato). 290/290 verdi. Commit `6ecf18a`.

**R4 — non un difetto residuo: una consegna già spedita, non ancora eseguita.** `doc_fact_sync` (v0.25.0, sessione #131, commit immediatamente precedente) è esattamente il fix che l'auditor chiedeva. Verificato dal vivo su `sbx-difetto-decadimento` (`9ef7b432`, di forge): `doc_staleness_query` conferma ancora `decayed_count:0` perché nessuno ha lanciato `doc_fact_sync` lì — provato a farlo io, rifiutato (board-mcp non è membro del sandbox). Girato a loomy come decisione: resta on-demand, o si aggancia automaticamente a `doc_link`/`doc_link_by_code` su `verifies`/`satisfies`?

**R6 — confermato gap, non scelta.** `doc_item_xproject_links` non ha l'equivalente di `subscribed_at_version` (`gov.doc_subscriptions`): un cross-link segue il contenuto nuovo del bersaglio senza dirlo. Cercato in DECISIONS/HISTORY: nessuna decisione lo dichiara deliberato. Girato a loomy (msg `fda693bd`) — è una migration DBA, non una dichiarazione che posso fare da qui (D-005).

**Trovato e chiuso en passant:** un fix già completo e testato da una sessione precedente (GTD `6e82b3b6`, validazione title/summary di `doc_item_upsert` contro i CHECK del DB) era rimasto nel working tree, mai committato — il WI che lo aveva prodotto era stato chiuso senza commit. Committato separatamente (`5d9ec8e`) prima di iniziare il lavoro sul wake.

**Corretto anche un secondo messaggio auditor** (`0ead19a9`, sweep-allineamento-flotta): CLAUDE.md insegnava una `doc_query(document_id=...)` — parametro che il tool non espone — e puntava a un solo dei due documenti cross-decisions (39% del corpus nascosto); la tabella skill puntava alla sede legacy `.skills/` invece di `~/.claude/skills`. Entrambi corretti nello stesso commit di R3 (`6ecf18a`).

**Decisioni prese:** nessuna — le due domande aperte (R4 automazione, R6 schema) sono girate a loomy, non decise qui (D-136 §5).
**Blocchi / note:** nessuno bloccante. R4/R6 in attesa di risposta loomy.
**Prossima sessione:** dipende dalla risposta di loomy su R4/R6.

## Sessione #131 — 2026-08-28 (autopilot dispatch «notte PR-2b», il congegno di decadimento end-to-end, GTD `b7846edf`, WI `5983ef10`, v0.25.0)

**Il difetto era un anello mancante, e si è misurato in una query.** PJ-7/D-210 chiedeva il congegno che fa decadere i collaudi quando l'antenato cambia. La macchina esisteva già — quasi tutta: il rilevatore M2 del dba, `doc_staleness_query`, `doc_decay_apply`, verificati dal vivo in `#119`. Prima di costruire ho misurato dove si interrompeva: `gov.doc_items_detect_change` marca **solo** le righe su cui esiste una sottoscrizione **attiva**, e in produzione c'erano **170 sottoscrizioni, tutte `origin='choice'` fatte a mano, contro 510 legami `verifies` e 417 `satisfies` — e zero `fact`**. 927 dipendenze di tracciabilità dichiarate, nessuna capace di far decadere alcunché. È esattamente il caso che REG-011 aveva registrato provocandolo: *«collegamento presente, predicato presente, congegno assente»*. Il legame c'era. Nessuno lo leggeva.

**Costruito `doc_fact_sync`** (`src/factSync.ts`): deriva le sottoscrizioni `origin='fact'` che il modello descriveva da sempre come «costitutive, automatiche, mai attraverso `doc_subscribe`» e che nessuno aveva mai scritto. Grado **derivato dalla relazione**, mai scelto per chiamata — `verifies`→`critical` (il collaudo cade), `satisfies`→`module` (va rivisto, non cade) — con la mappa esportata e restituita in `intent_map`: una scelta di grado nascosta nell'implementazione sarebbe una regola che nessuno può leggere. Solo quelle due relazioni: chiedere `refines`/`relates_to` è un **rifiuto esplicito**, perché allargare l'insieme è un cambio di regola e appartiene a chi la governa (D-136 §5). Creare una `fact` è **irreversibile** (SEC-011, non tombstonabile) → `dry_run`, tetto che **rifiuta** invece di troncare, `orphan_facts` dichiarate; il **grado** resta però correggibile (`intent` è fra le colonne che `doc_rw` può ancora scrivere), ed è la ragione per cui l'irreversibilità qui è accettabile. Legge lo **stesso** gate di ammissione di `doc_subscribe`: una fact derivata è pur sempre un'ammissione, e farne entrare centinaia dalla porta di servizio mentre l'ammissione è sospesa svuoterebbe la sospensione.

**Chiuso dentro lo stesso pacchetto il gate pre-publish** (GTD `56a815b4`, aperto dal 24/08 in attesa di decidere *dove* vivesse). Vive dentro `doc_publish` ed è **bloccante**, soglie dal registro parametri: il mandato diceva «obbligatorio, non solo visibile nel verdetto», e la visibilità esisteva già. **Nessuna valvola di forzatura**, deliberatamente: le uscite legittime sono rieseguire e chiudere, o chiudere come `no_impact` motivato — una terza che non richiede nessuna delle due non è una valvola, è l'annullamento del gate.

**Due difetti trovati dal giro dal vivo, nessuno dei due visibile ai test con DB finto.** (1) Il gate era in coda ai controlli: la prova tornava lamentandosi di un `changelog_entry_id` invece che del decadimento — chi pubblica avrebbe preparato un changelog per scoprire *dopo* il blocco vero. Spostato dopo la legittimazione e prima del changelog: *fra due rifiuti entrambi corretti va detto per primo quello che costa di più scoprire tardi.* (2) `doc_structure` degradava con eleganza su una lettura fallita; ma sotto `doc_rw` gira tutto in **una** transazione, un errore la aborta, e ogni lettura successiva torna vuota: lo strumento ha risposto «0 sottoscrizioni, 0 marcature aperte» per un progetto che ne aveva **104 e 1**, con una nota educata sull'unico conteggio che sapeva di aver perso. *Uno strumento di misura che risponde `ok` con zeri fantasma è peggio di uno che rifiuta.* Ora ogni errore di lettura ritorna errore. (La causa sotto: avevo supposto una colonna `from_project_id` su `doc_item_xproject_links` invece di misurarla — non esiste.)

**Il ciclo reale, che è il criterio di chiusura di PJ-7 e la risposta alla domanda dell'auditor** («qual è il caso su cui è scattato, così lo rileggo io invece di prenderlo per dichiarato»). Due strati. In transazione annullata, `tests/verify-decay-cycle.ts`, **25/25**: corpus tracciabile costruito da zero → nessuna sottoscrizione sulla coppia appena collegata (il difetto riprodotto) → `dry_run` → `doc_fact_sync` → riscrittura sostanziale dell'antenato → **il trigger M2 vero** scrive la marcatura → `doc_decay_apply` porta il collaudo a `decayed` preservando `pass_fail` → progetto portato a soglia → `doc_publish` **rifiutato**, e rifiutato per il decadimento → zero residui verificati. E poi **persistente**, sul progetto board-mcp: 103 sottoscrizioni `fact` create, `SDES-DECAY-002` riscritto in modo sostanziale (l'aggiunta della sezione sull'ordine dei controlli — un cambiamento vero, non provocato ad arte), marcatura `6ea8136e` aperta dal trigger, `UAT-DECAY-002` decaduto con causa dichiarata. Rileggibile da chiunque abbia accesso al progetto.

**PJ-8 — `doc_structure`** (`src/structure.ts`): la metà board-mcp di «chi firma i verdetti non può leggere ciò su cui firma». Chiude il gap che avevo annotato due volte senza costruirlo (#126, #130): nessuna superficie elencava i **documenti** di un progetto, quindi un documento vuoto era indistinguibile da uno inesistente. Riporta versione dichiarata **e** pubblicazioni reali (la differenza è il debito di pubblicazione), conteggi spacchettati per stato/tipo/relazione/origine/grado — mai fusi in un totale unico, che è ciò che nasconde un corpus tutto in bozza — e uno zero che dichiara **quale** zero è. Prima lettura sul caso zero: 9 documenti **tutti mai pubblicati**, 26 sottoscrizioni **tutte** `choice`, 45 `verifies` + 101 `satisfies` che non portano decadimento — la nota automatica lo dice senza che nessuno debba dedurlo.

**PJ-5 — `doc_rename`**: il verbo non esisteva (il dba lo aveva misurato: «due agenti diversi me l'hanno chiesto a mano nella stessa settimana»). *Una norma di nomenclatura che il corpus non ha modo di applicare non è una norma inosservata, è una norma senza verbo.* Solo il titolo — status/visibility/owner sono atti diversi, e un `doc_update` che scrive qualunque cosa gli venga passata è il difetto di semantica-patch già pagato in v0.16.3. Applicato al nostro SoW (`Capitolato — Board MCP Server (…)` → `Board MCP Server - SoW`, PG-009 + PG-007). Il gemello del caso zero, che è **la** violazione registrata in PJ-5, è di loomy: il tool ha rifiutato la rinomina cross-agente — esito corretto — e il comando pronto è andato a lui.

**Verifiche:** `tsc` pulito, build pulita, **288/288** unitari (+31 nuovi: 18 su fact-sync e sul gate, 13 su structure/rename), 25/25 live in transazione annullata, più il ciclo persistente. Governance: `SDES-DECAY-002`, `SDES-STRUCT-001`, `SDES-RENAME-001` e i tre collaudi corrispondenti, tutti linkati `verifies`.

**Decisioni prese:** nessuna decisione formale nuova. Le due scelte di contratto che non erano mie da prendere da sola sono state **fatte e dichiarate a chi le governa**: la mappa relazione→grado e il gate senza valvola (proposti a loomy nel messaggio di chiusura, con la misura sotto).
**Blocchi / note:** l'attivazione del congegno su progetti di **altri** titolari non l'ho fatta e non la farò di iniziativa: `doc_fact_sync` è un atto per progetto, e sul caso zero significherebbe accendere il decadimento su 146 legami del corpus di loomy. La rinomina del SoW del caso zero resta a loomy. Il gate delle classi esenti continua a non essere applicato: `uat_case` non ha ancora un attributo di classe (gap dichiarato, invariato).
**Prossima sessione:** dipende dalle risposte — attivazione del congegno sugli altri progetti (chi, quando, con quale ordine), e il documento dei doc-type (`a4b24f87`) che loomy indicava come coda se restava tempo.

## Sessione #130 — 2026-08-28 (autopilot dispatch «notte PR-1a», primo ciclo publish reale su doc-in-db, GTD `1502862a`, WI `ca6b1c36`)

**Task:** pubblicare i documenti normativi del progetto doc-in-db, per attaccare il debito misurato in `#127` (93% delle sottoscrizioni agganciate a target mai pubblicati). Criterio dato: pubblicare dove il contenuto è stabile, e **dichiarare con motivo** ciò che non lo è — mai pubblicare a forza.

**Pubblicati (2).** `req` «Requisiti del modello documenti governance» `668d0dca` → **1.0** (24 righe REQ-DOCM-001..024, tutte `approved`, nessun body nullo), e `exec_summary` «As-is al 2026-08-18» `dafdace0` → **1.0** (12 righe `active`). Entrambi con changelog-by-construction: prima non esisteva alcun documento `changelog` su doc-in-db, creato in questa sessione (`38809901`, visibility `org` come i documenti che registra) con una voce per pubblicazione (`CHG-DOCM-REQ-1.0`, `CHG-DOCM-ASIS-1.0`). `bump_class=major` su entrambe: non c'è una versione precedente da confrontare — la classe qui descrive la nascita della serie, non la portata di una modifica.

**L'as-is si pubblica proprio perché non è normativo.** Nessuno lo sottoscrive e non è una norma: è una fotografia datata. Per questo è il caso in cui il congelamento non ha controindicazioni — una fotografia al 2026-08-18 che cambia dopo il 2026-08-18 sarebbe un difetto, non un aggiornamento. Dichiarato come tale nel `delta_summary`, per non far passare un conteggio di documenti pubblicati per un conteggio di norme in vigore.

**Esclusi, con motivo, tutti e tre.** `sdes` `d21eac63`: 15 righe su 29 sono `draft`, e non sono bozze di forma — sono proposte per lavori non ancora costruiti (WI-G.1, WI-G.3, WI-C, SDES-DOCM-025 sulla pubblicazione stessa); header `draft`. `uat` `340081e4`: 5 casi `in_review` + 6 `draft` esenti dichiarati, 11 su 29 non chiusi; si muove insieme al SDES. Argomento aggiuntivo, valido per entrambi: pubblicare accende il congelamento (`gov.doc_frozen_row_touches`, D-201) su documenti in scrittura attiva, cioè produce rumore di rilevatore su ogni edit legittimo previsto. `sow` `465d2ae1`: **owner = loomy** — `gov.doc_publish` rifiuta con `insufficient_privilege` chiunque non sia owner del documento o loomy (letto nella funzione, non provato a forza); header comunque `draft`.

**La misura che conta più delle due pubblicazioni.** Il SoW è il target di **26 delle 28** sottoscrizioni del progetto (OBJ-*, DEL-*, STOP-* sono sue righe): su doc-in-db il tappo non è tecnico, è di legittimazione — nessun lavoro mio lo scioglie. Allargando alla flotta (misura ripetuta prima e dopo): 18 documenti sono target di sottoscrizioni attive, 14 non hanno mai pubblicato, e il debito è concentrato per owner — **loomy 12 documenti / 146 sottoscrizioni bloccate**, it-manager 1 / 12, board-mcp 1 / 1. Il mio raggio d'azione diretto era 2 documenti su 15: il 93% non scende perché manca uno strumento, scende quando pubblicano loomy e it-manager. Segnalato a entrambi.

**Un debito sanato senza `doc_repoint`, e vale la pena averlo a verbale.** L'unica sottoscrizione al `req` (DEL-BM-006, progetto board-mcp, `module`) aveva `subscribed_at_version='1.0'` — scritto quando `documents.version` valeva già `1.0` ma il documento non aveva mai pubblicato. Ora che la 1.0 è pubblicata il pin coincide, e `doc_repoint` è inapplicabile per «già agganciata alla corrente». Cioè: le **prime** pubblicazioni con label `1.0` sanano il debito per coincidenza di etichetta, senza repoint. Vale solo per la prima pubblicazione a etichetta invariata; dalla 1.1 in poi il repoint torna necessario.

**Collaudo incrociato gratuito:** `doc_version_delta` (costruito ieri in `#129`) eseguito sulla pubblicazione nata oggi — 24 `created`, `baseline:null` **dichiarato** con la nota «questo è il delta, non un ripiego», `total_rows_in_version` 24 coerente. Prima verifica del tool su una pubblicazione non preesistente.

**Nota di lettura del ledger (non un difetto).** `gov.doc_versions.published_by_role` registra `postgres` su ogni riga: dentro una `SECURITY DEFINER`, `current_user` è sempre l'owner della funzione. L'attribuzione reale sta su `published_by` (agent_code, `005` = board-mcp, da `gov.caller_identity()`) e `published_by_session` (`board_doc_rw`). Chi legge il ledger per attribuzione non deve guardare la colonna `_role`.

**Decisioni prese:** nessuna. Il criterio di pubblicabilità applicato qui (header non-`draft` + tutte le righe in stato terminale; owner ≠ me = non pubblico) è materia di governance del framework, non del mio server: proposto a loomy nel messaggio di chiusura, non scritto come decisione di mia iniziativa (D-136 §5).
**Blocchi / note:** l'elenco dei documenti di un progetto continua a non avere una superficie (gap `doc_list` già annotato in `#126`) — qui aggirato leggendo `documents` in SQL diretto sotto `doc_rw`, non con un tool. Nessuna modifica al codice in questa sessione: solo scritture di governance sul DB di produzione, tutte rilette (snapshot 24 righe + sha per il req, 12 per l'as-is).
**Prossima sessione:** valutare la pubblicazione del `sdes` «Solution Design — Board MCP Server» (mio, 1 sottoscrizione, mai pubblicato) — non fatta qui perché fuori dallo scope del dispatch e perché è il documento che riscrivo a ogni sessione: pubblicarlo accende il congelamento su un documento in scrittura attiva, e il rilevatore `frozen_row_touches` non è mai stato provato dal vivo (GTD follow-on).

## Sessione #129 — 2026-08-28 (wake 2 msg: delta strutturato + predicato D-135, `doc_version_delta`, gate ammissione, WI `87e9156d`)

**Wake cold-start su 2 messaggi**, entrambi lavorati e ackati (più 2 FYI del dba sullo stesso commento stale, ackati e corretti).

**1. Blocker forge `05ba7c9e` — `delta_summary` è prosa, non un elenco** (blocca UAT-SUB-003/REQ-SUB-003 c.2 e, per conseguenza dichiarata, UAT-SUB-011). SDES-SUB-003 disegnava un elenco `{item_id, code, change_kind}` dichiarato negli `attrs` del changelog, fonte `doc_item_history`, con dipendenza verso SDES-DOCM-025.

**Costruita una forma diversa, e la differenza nasce da una misura, non da una preferenza**: `gov.doc_publish` **scrive già** uno snapshot riga per riga in `gov.doc_version_items` (misurato: 237 righe su 29 pubblicazioni, ognuna con `content_sha256`). Il delta quindi si **deriva** per diff di due snapshot consecutivi invece di essere dichiarato — e derivare è strettamente più forte: (a) la completezza è per costruzione, perché non esiste un elenco che qualcuno compila e che possa troncare in silenzio (la preoccupazione centrale di forge, CV-8/D-203) — al suo posto un tetto che **rifiuta**, mai accorcia; (b) non può mentire, perché un diff di sha256 dice cosa è stato pubblicato, non cosa qualcuno ha detto di aver pubblicato; (c) vale **retroattivamente** sulle 29 pubblicazioni già esistenti, mentre un campo dichiarato descriverebbe solo il futuro. Nuovo tool **`doc_version_delta`** (read-only, `doc_rw`), `delta_summary` non toccato (resta prosa per il ledger). `counts` porta `unchanged` e `total_rows_in_version` apposta: l'aritmetica è verificabile **da fuori**, così la completezza si collauda senza fidarsi dell'implementazione. Ogni caso limite è un errore parlante, mai un silenzio: mai pubblicato, snapshot mancante («questo NON è un delta vuoto»), versione ambigua (elenca le reali), baseline più recente del bersaglio, oltre il tetto. Prima pubblicazione → `baseline:null` **dichiarato**. → `SDES-SUB-008`. **SDES-SUB-003 va aggiornato** (la sua scelta è superata, la dipendenza verso SDES-DOCM-025 cade): segnalato a forge e loomy, non riscritto unilateralmente — è documento del progetto items-subscription.

**2. Stessa segnalazione, seconda lacuna: `sottoscrizioni_ammissione_sospesa` non letto da nessuna superficie** — il flag sospendeva sulla carta (zero occorrenze in `src/`). Costruito il gate su `doc_subscribe`, come SDES-SUB-CP-004 §4 assegna esplicitamente a board-mcp (chiude REQ-SUB-013 c.3). Posizionato **dopo** i rami di idempotenza e cambio di grado: ri-chiamare su una sottoscrizione che già si ha continua a funzionare (non ammette nulla), e il cambio di grado su un bersaglio già ammesso **non** è bloccato — congelare anche gli innalzamenti sarebbe un allargamento della regola, che appartiene a chi la governa (D-136 §5). Flag illeggibile/assente → **ammette ma lo dichiara** (`admission_gate: "NOT VERIFIED"`): murare la flotta per un parametro mancante sarebbe un guasto peggiore di quello prevenuto, tacerlo farebbe passare per verificata un'ammissione che nessuno ha potuto verificare. → `SDES-SUB-009`.

**Difetto reale trovato SOLO dal giro dal vivo, mai dal test col fake** (`tests/verify-version-delta.ts`, DB reale via `runDocRw`): node-pg restituisce `numeric` come **stringa**. Il flag arriva `"0"` e `"0" !== 0` è vero — senza coercizione esplicita il gate avrebbe **sospeso l'ammissione a flotta intera con il flag a zero**. Secondo inciampo della stessa famiglia dopo `decay_since` (D-201). Nel test unitario il valore è ora seminato come stringa apposta. Il giro dal vivo conferma anche il delta su dati reali: documento `9af1b1f1` 1.2→1.3, 11 righe, **esattamente una** cambiata — stesso risultato per due strade indipendenti (tool e query SQL a mano).

**3. Question dba `4adb7818` — predicato «messaggio collegato al WI» (D-135 §3, competenza congiunta).** Confermata la proposta `wi_ref` (scartati `ref_id`, che significa già "radice del thread" e spezzerebbe `board_thread` in silenzio, e un predicato su `tags`, testo libero senza integrità → gate falsificabile per costruzione). **Corretto il predicato**: `NEW.wi_ref IS NOT NULL` da solo lascia che **chiunque promuova il WI di chiunque** con un `board_send` qualsiasi — serve anche `to_agent = escalation_target`, perché l'invariante di D-135 è «nessun WI escalated senza **il** destinatario avvisato», non «un» destinatario. Segnalati i due vincoli da **non** aggiungere: `from_agent` (lo sweep del reconciler manda il messaggio generico — vincolarlo spegnerebbe la rete proprio quando serve) e `type` (un cambio di tipo lato board-mcp spegnerebbe il gate **in silenzio**). `wi_ref` non sarà esposto come parametro di `board_send`. Dichiarato al dba il fatto che gli serve: **il lato board-mcp di D-135 non è costruito** (grep: zero occorrenze di `escalation_pending`/`escalation_target` in `src/`) — ma non lo blocca, perché finché quel pezzo manca nessun WI entra in `escalation_pending` e il trigger resta inerte, non rotto.

**4. Commento stale corretto** (`subscriptions.ts`, msg dba `03fa2008`/`ef2f3e6f`): il floor DB su `origin='fact'` è live dal 22/08, il commento lo dava «ratificato ma non applicato». Il controllo tool-level resta, ma il commento ora dice **perché** è tenuto (nomina la regola al chiamante invece di lasciar fare a un 42501 nudo) — non è più un supplente di un floor mancante.

**Verifica**: `tsc` pulito, **257/257** test verdi (era 245: +12 nuovi), build rigenerato. Verifica dal vivo contro il DB reale per entrambi i pezzi. **Limite dichiarato**: `doc_version_delta` non è ancora chiamabile via MCP da nessuna finestra aperta — nessun hot-reload, serve una sessione nuova (G4). Il collaudo di forge parte da lì.

---

## Sessione #121 — 2026-08-25 (autopilot dispatch CV-8, `truncated?` su 12 tool, GTD `d543a311`, WI `d4da387f`, v0.24.0)

**Autopilot dispatch** (GTD `d543a311`, via libera esplicito loomy msg `73aef27b` su report `2190b6ae`): estendere `truncated?: boolean` (pattern `pendingInbox.ts`, D-205) a tutti e 12 i tool del Gruppo A/A-bis che troncano liste in silenzio senza dichiararlo — `board_inbox`, `board_overview`, `gtd_inbox`, `gtd_query` (due rami: con/senza `project_id`), `gtd_overview`, `project_list`, `home_grocery_list`, `home_school_menu_read`, `wi_query`, `doc_query`, `loomy_replies`, `decisions_inbox` (due liste indipendenti → `board_truncated`/`gtd_truncated` separati, mai fusi).

**Helper condiviso** (`src/pagination.ts`, `paginate<T>(rows, limit)`): stesso pattern in 12 punti — fetch `.limit(N+1)`, se tornano N+1 righe tieni le prime N e `truncated:true`, altrimenti niente campo (mai un sentinel `false`). 4 test unitari dedicati.

**Decisione di forma presa autonomamente, non esplicitamente coperta dal via libera**: 9 dei 12 tool rispondevano oggi con un **array nudo** (o testo umano "No X found." quando vuoto) — aggiungere un segnale accanto ai dati richiede necessariamente un oggetto wrapper, non c'è alternativa in JSON. Scelto: stessa forma per tutti, `{count, <lista-nominata-per-dominio>, truncated?}` — `count` è sempre la dimensione di pagina (mai un totale, coerente con la spiegazione di loomy su `wi_query`/`doc_query`), il ramo "vuoto" resta testo umano invariato (nessun cambiamento percepito quando non c'è nulla da segnalare). I 3 tool già a oggetto wrapper (`project_list`, `wi_query`, `doc_query`) hanno solo guadagnato il campo, zero rinomine.

**Verifica (onestà sui suoi limiti, non solo exit code)**: `tsc` pulito, 228/228 test verdi (era 222 a inizio sessione: +4 helper, +1 `doc_query`, +1 `wi_query` — nuovi test end-to-end con fake DB reale che verificano `truncated:true` quando il cap taglia righe e l'assenza del campo quando non taglia). **Limite dichiarato**: 9 dei 12 tool (quelli dentro `tools.ts`/`humanTools.ts`, non `docs.ts`/`wi.ts`) non hanno un'infrastruttura di test unitari — nessuna verifica end-to-end dal vivo è stata possibile nella sessione stessa: il processo MCP di questa finestra gira sul build precedente (nessun hot-reload, vedi CLAUDE.md "Rollout di un nuovo build") e riavviarlo avrebbe interrotto il WI. Rilettura manuale riga per riga di ogni diff eseguita al posto della verifica dal vivo — dichiarata come tale, non spacciata per "verificato".

**Non fatto**: rinomina del campo `count` esistente su `wi_query`/`doc_query` (loomy l'aveva esplicitamente escluso — "si risolve da sé, senza rinominarlo").

---

## Sessione #120 — 2026-08-25 (autopilot dispatch loomy `ddb4c792`, triage backlog inbox 30 msg, WI `67e2436f`, v0.23.1)

**Autopilot dispatch** (GTD `ddb4c792`, self-report precedente): 18 messaggi mai acked in inbox board-mcp, il più vecchio a 52gg — al momento dell'apertura del WI erano diventati 30 (il backlog è cresciuto tra il self-report e il dispatch). Triagiati e ackati tutti e 30, status aggiornato per ciascuno (`done` per quelli già risolti dal codice esistente o da questa sessione, `in_progress` per quelli con un GTD follow-on o un'escalation aperta, `acknowledged` per i puri FYI).

**Due fix di codice spediti, entrambi mandati già ratificati altrove — nessuna decisione nuova presa qui:**
1. **`checkInboxPendingGuard` rimossa** (`src/wi.ts`) — D-118's `inbox_pending_warning`, dichiarata morta da D-205/REQ-GOV-154 e tenuta un'unica release per mandato SDES-GOV-157. it-manager ha confermato il gate soddisfatto (msg `a3ce4b29`): rimossi funzione, call site, campo risposta, 4 test dedicati + parte del test dry-run E2E-RW-13. `resolveAutoWaitingOn` (guard (a), stesso flag) non toccata.
2. **`working_doc` sbloccato** (`src/docTypes.ts`) — dba aveva applicato lo schema (`working_doc` in `documents_document_type_check`, non pubblicabile via trigger DB, vista `gov.doc_model_enum_catalog`, msg `903c6e37`/REQ-DOCM-018) ma `doc_create('working_doc')` falliva "Unknown document_type": il registry lato tool non lo conteneva. Aggiunto a `DB_DOCUMENT_TYPES` + `document_types` di `exec_point`/`section`/`prose` (come indicato da dba). **Non fatto**: il rewrite di `checkCapabilityParity()` per leggere `gov.doc_model_enum_catalog` invece dei mirror `DB_*` copiati a mano (punto (b) del mandato dba) — cambio più ampio (query DB async, nuovo asse `document_type`), segnalato a dba come task a sé.

**3 GTD follow-on pianificati** (autopilot=false, D-066, nessuno armato — nessuno è un task meccanico pronto per dispatch immediato): (1) `org_lookup` → `loomx_raci_effective` (schema dba pronto da 5gg, msg `195ccc8d`, nessuna fretta dichiarata); (2) tool `doc_rename` — mancava un modo di correggere `documents.title`, richiesto da loomy (msg `6fdcfb87`, caso reale: documento "...Capitolato"→"...SoW"), DB già pronto (`documents_history`); (3) D-206 marcatura interrogabile promessa/verbale sull'origine di un requisito (msg `5c576d89`), da concordare con dba.

**2 decisioni escalate a loomy, non prese da solo** (D-005): gate D-074 di `wi_end` che non ammette `config_pattern` nella whitelist durable-link (segnalato da atlas, msg `900ea0fa` — ogni WI di metodo METH-* si chiude in bypass forzato); coda GTD in due grafie `achille`/`Achille` (segnalato da loomy, msg `fb03c97d` — confermato che l'enum destinatari è derivato a runtime da `board_agents`, quindi la riga duplicata è dato DB, non codice board-mcp).

**Confermato a dba**: ISS-001 (doc_supersede/declared heir, commit `9df891b` di sessione precedente) è fisso, può riprovare PM-8. **Confermato a loomy**: la rettifica sul decadimento (msg `4a796ae4`) è stata rispettata — il pezzo dichiarato (esposizione stato stantio) è quanto già costruito e verificato dal vivo in sessione #119.

**Verificato:** 221/221 test (4 rimossi con la guard, 1 aggiustato), `tsc` pulito, `npm run build` ok. Versione a 0.23.1 (patch — dead-code removal + registry unblock, non una feature nuova).

**Continuazione stessa sessione (v0.23.2):** `wi_end` del WI sopra ha riportato `pending_inbox` con 11 messaggi actionable mai visti dal primo giro (`board_inbox limit=30`, ordinato per data decrescente, aveva nascosto un secondo lotto di 32 messaggi pending dal 2026-07-03 al 2026-08-18). Aperto un secondo WI (`27ce2cba`), processato anche quello. Due segnalazioni storiche di loomy confermate risolte con verifica sul codice attuale: footgun `gtd_update` body-only→done (blocker 52gg, `buildGtdUpdatePayload` in `src/tools.ts` scrive solo i campi passati esplicitamente, test di regressione presente e verde) e ambiguità "document not found" membership vs assenza (24gg, risolta da D-167/`doc_document_exists`, già in CLAUDE.md). Fix reale trovato e chiuso: `doc_query` traceability (`req_without_sdes`/`sdes_without_uat`/`req_without_origin`) contava righe `superseded` come gap — nit di agente 049 (08/08), corretto (`src/docs.ts`, commit `fb9f5fc`), test di regressione aggiunto, 222/222 verde. Tutti gli altri 30 messaggi del secondo lotto: già consumati dal codice/schema esistente (no_auto_arm, dedup broadcast, enum recipient cro/trader/lucca-rpg, D-093 hardening `clarified_at`, drift priority `urgent`), ackati. Un ultimo messaggio arrivato a sessione in corso (`73aef27b`, loomy, via libera CV-8): GTD pianificato per il follow-on mechanical sui 12 tool Gruppo A/A-bis (`truncated?` su liste troncate), da armare a chiusura WI. Residuo non chiuso: registrazione run reali `loomx_evals` (dba msg `a35fbf3a`, 24 codici E2E-RW/E2E-MODEL) — richiede prima la mappatura codice→scenario dal catalogo, GTD pianificato non armato. Versione a 0.23.2.

---

## Sessione #119 — 2026-08-24/25 (autopilot dispatch loomy `3a665a83`, decadimento collaudi D-201/DEL-008, GTD `1dffa01e`/`ddb6815c`, WI `32c21b86`, v0.23.0)

**Autopilot dispatch urgente** (msg loomy `3a665a83`, wake_priority=high): «il collegamento c'è, il congegno che lo fa scattare no» — misurato stasera nel sandbox dedicato (`sbx-difetto-decadimento`, non visibile a board-mcp, RLS): un disegno riscritto in modo sostanziale non fa decadere il collaudo collegato. Mandato collegato: GTD `ddb6815c` (loomy, 2026-08-23), che aveva già chiesto di misurare la catena un anello alla volta invece di presumerla dal disegno.

**Misurato prima di costruire** (letto codice + migrazioni dba + query dal vivo, non presunto): il rilevatore M2 (dba migration `20260822090000`, DEL-008) **esiste ed è vivo** — trigger `gov.doc_items_detect_change` su `doc_items`, predicato `gov.doc_item_substantive_diff` (D-201/D8, letto da `loomx_governance_params`), tabella marcature `gov.doc_subscription_staleness` con marcature reali già presenti (subscriber `loomy`, item GUI-00X/PG-00X, 2026-08-24 21:17). I tre parametri di soglia citati dal mandato **erano già seminati** (contrariamente al mio primo grep — cercavo `%decay%`, i nomi reali sono `pg_rilancio_soglia_decaduti=3`, `pg_rilancio_giorni_max=30`, `pg_rilancio_classi_esenti={"classi":["deterministico"]}`, owner `board-mcp`). **Zero** sottoscrizioni con sottoscrittore `uat_case` esistevano in tutto il DB — il caso del sandbox era stato ripulito dopo la misura (regime sandbox, DEL-003/eccezioni DELETE del 24/08). L'anello mancante confermato: il rilevatore marca stale la **sottoscrizione**, nessun codice esistente scriveva indietro sul **sottoscrittore**.

**Costruito** (`src/staleness.ts`, nuovo modulo, 3 tool — vedi CLAUDE.md per il contratto completo): `doc_staleness_query` (lettura marcature + `gov.doc_frozen_row_touches` + soglie), `doc_staleness_close` (chiusura, ask esplicito DEL-008 GTD `03ffb9f5`), `doc_decay_apply` (l'anello: marcatura aperta + sottoscrittore `uat_case` + intent critical/module → `attrs.decay_status='decayed'`, layer su `attrs.pass_fail`, mai sovrascritto). Estensione schema (`src/docTypes.ts`, solo `attrs_schema` — NESSUNA migrazione DBA: `decay_status`/`decay_since`/`decay_cause_item` vivono in `attrs` JSONB, non nel CHECK di `status`, misurato prima di scrivere: `doc_items_status_check` non ha né `pass`/`fail` né spazio per un terzo stato — il verdetto UAT è già in `attrs.pass_fail` da prima, il layer di decadimento segue lo stesso posto).

**Cascata "per onde" per costruzione, non ricorsione a mano**: scrivere `attrs.decay_status` è di per sé una colonna significativa (D-201) — lo stesso trigger M2 rifira da solo per chi sottoscrive la riga appena decaduta. Un salto è codificato; l'onda è il rilevatore esistente che rifira sul proprio output.

**Verificato dal vivo, non solo per lettura del codice** (D-024, prima o dopo `wi_end` — qui prima, per lasciare traccia permanente): coppia reale creata nel progetto board-mcp stesso (non sandbox — è la copertura di regressione del meccanismo che possiedo) — `SDES-DECAY-001` (Solution Design) + `UAT-DECAY-001` (UAT), link `verifies`, sottoscrizione critical. Ciclo completo eseguito via `runDocRw` reale (stesso path del server live, non un fake): riscrittura sostanziale del SDES → marcatura M2 reale rilevata (`doc_staleness_query`) → `doc_decay_apply` porta `UAT-DECAY-001` a `decayed` preservando `pass_fail='pending'` e tutti gli altri campi `attrs` → idempotenza confermata (rilancio → `already_decayed`) → `doc_staleness_close` chiude con esito → ri-chiudere è no-op (`already_closed`). Confermato una seconda volta via `doc_query` (percorso indipendente dallo script di verifica).

**Bug reale trovato SOLO dal giro dal vivo — i test unitari con fake DB NON lo avrebbero mai preso**: `node-pg` ritorna colonne `timestamptz` come oggetti `Date` (non stringhe) e `numeric` come stringhe. Il primo `doc_decay_apply` dal vivo ha fallito la propria validazione attrs (`decay_since: expected string, got object`) — la validazione JSON-Schema ha fatto esattamente il suo lavoro, bloccando una scrittura sbagliata invece di lasciarla passare in silenzio. Fix: `toIsoString()` normalizza sempre `changed_at` prima di scriverlo o esporlo; `loadDecayParams` coercizza `value_numeric` a `Number`. La fake DB (`tests/fakeDb.ts`) è stata estesa per simulare il trigger reale `gov.doc_subscription_staleness_guard_update` (stampa `closed_at` alla chiusura) — senza quella simulazione un test avrebbe dovuto indovinare il comportamento del trigger invece di misurarlo.

**Trovato leggendo, non presunto — «secondo difetto» del mandato**: la riscrittura silenziosa di una consegna pubblicata **è già intercettata** dallo stesso rilevatore M2, altro lato (`gov.doc_frozen_row_touches`, stessa migration `20260822090000`) — non un meccanismo nuovo da costruire, un gap di **visibilità** (nessun tool lo esponeva) chiuso dallo stesso `doc_staleness_query`. **Non verificato dal vivo** in questa sessione (richiederebbe un ciclo `doc_publish` reale, fuori dal perimetro del ciclo misurato).

**Deliberatamente non costruito in questa WI (fetta verticale, GTD `ddb6815c` — "non l'intero progetto sottoscrizioni")**:
1. Il gate «rilancio obbligatorio fuori soglia prima di pubblicare/firmare» (mandato punto 5) — richiederebbe agganciare `doc_decay_apply`/verdetto dentro `doc_publish` o un WI-gate separato; decisione di dove vive il gate non presa da solo (D-005).
2. Il gate delle **classi esenti** (`pg_rilancio_classi_esenti`) — `uat_case` non ha un attributo di classe nello schema; `doc_staleness_query`/`doc_decay_apply` leggono il parametro e lo dichiarano esplicitamente **non applicato** (`class_gate_note`) invece di indovinare il nome del campo (D-136 §5).
3. Propagazione oltre il primo salto — non verificata dal vivo (nessun secondo sottoscrittore agganciato al UAT appena decaduto in questo ciclo); attesa per costruzione (vedi sopra), non ancora misurata.

**Domande di merito del mandato originale (GTD `ddb6815c`), risposte nel dispatch di oggi invece che lasciate aperte**: (1) un collaudo può sottoscrivere — sì, `subscriber_item_id` è già generico su `doc_items`, nessuna estensione di `agent_id` necessaria (confermato anche da msg loomy `be79286a`, 2026-08-23: «i requisiti sottoscrivono il capitolato», stessa semantica); (2) cosa vuol dire «decade» — stato distinto e visibile (non una nota nel corpo), più uno stato "sotto soglia" nel verdetto — entrambi implementati come sopra.

**Verificato:** 225/225 test (`npm test`), `tsc --noEmit` pulito, `npm run build` ok. Versione a 0.23.0. Regressione permanente: `SDES-DECAY-001`/`UAT-DECAY-001` nel progetto board-mcp (non sandbox — documentano e verificano il meccanismo posseduto).

---

## Sessione #118 — 2026-08-24 (wake fast-track loomy `3effbb10`, catch-up commit sessioni #116/#117, WI `f7a9324c`)

**Wake cold-start** (msg loomy `3effbb10`): autorizzato l'ordine fast-track proposto — (1) dba: storico header `documents_history`+trigger (SDES-DOCM-017), (2) dba: item type `working_doc` con controllo di parità da catalogo (SDES-DOCM-018/014), poi (3) board-mcp: tool `doc_update`/rinomina + le due consegne (elenco funzioni doc_*, indice item type). Verificato prima di agire (enum `document_type` via `doc_create`/`doc_query`, GTD `f89cec32`/`9cbf4e5e`): nessuna delle due consegne dba è ancora atterrata — restano `waiting`, nessuna costruzione possibile ora senza violare REQ-DOCM-017 (audit trail) o ripiegare su `exec_summary` (l'errore che il messaggio stesso segnala di aver evitato).

**Domanda forge inoltrata da loomy, verificata prima di rispondere:** esiste un modo di ritirare un intero progetto? No — né lato board-mcp (`project_list` è dichiaratamente read-only, nessun write path su `loomx_projects`) né un meccanismo equivalente a `doc_supersede` (erede obbligatorio + rifiuto su riferimenti scoperti) a grana progetto. Risposta inviata a loomy: è il risultato atteso di uno scenario di collaudo, non un gap da colmare ora.

**Trovato in stato pendente:** due sessioni precedenti (#116 ISS-001 `doc_supersede`, #117 `is_sandbox`) avevano lavoro completo, testato (211/211) e già documentato in questo file, ma mai committato — probabilmente sessione terminata senza `git commit` prima del `wi_end`/`kill`. Verificato di nuovo (tsc pulito, 211/211 test verdi) e committato in questa sessione, invariato nel contenuto: `43b3019` (fix hook `governance-gate` v1.7, datato 17/08, anch'esso mai committato) e `9df891b` (ISS-001 + `is_sandbox`, v0.22.2).

**Nessuna implementazione nuova in questo WI** (gate su dba, mandato è "aspetta e conferma"). GTD `f89cec32`/`9cbf4e5e` restano `waiting`, invariati.

---

## Sessione #117 — 2026-08-24 (`is_sandbox` in `project_list`, wake da forge, GTD `4f06c944` broken_refs pianificato, WI `6c21efd4`)

**Cold-wake** da forge (msg `162add27`): dba ha applicato `20260824190000_loomx_projects_sandbox_marker_and_registry.sql` — `loomx_projects.is_sandbox` (NOT NULL DEFAULT false) live, ma `project_list` continuava a restituire `id, name, short_name, status, agent_id`. UAT-PG-009 rosso sul passo 2a per questo.

**Fix (`src/tools.ts`, v0.22.2):** `project_list` seleziona ora anche `is_sandbox` ed esclude `is_sandbox=true` per difetto — nuovo param `include_sandbox=true` per vederli. Verso deliberato (come chiesto): l'esclusione è ciò che accade se non chiedi niente, non il contrario. Schema confermato leggendo direttamente la migrazione DBA (non dedotto) — grant SELECT a `loomx_agent` già presente, nessun gap di permessi. Build + 211 test verdi.

**Seconda richiesta nello stesso messaggio, non implementata qui:** forge misurando UAT-PG-008 non riesce a verificare "nessun riferimento rotto" — query dirette su `doc_item_links`/`doc_item_xproject_links` col proprio ruolo nativo falliscono `permission denied`, e `doc_query(summary=true)` espone `doc_out`/`doc_in` solo come conteggi (un link rotto conta come uno sano). Propone `doc_query(traceability='broken_refs')` con la stessa tripartizione gap/abstained/covered di `req_without_origin` (D-206, sessione precedente) — concordo, permission-denied è sul ruolo nativo forge, non su `doc_rw` (già usato dai doc_*, già grantato). Parcheggiato come GTD `4f06c944`, non armato: da concordare forma esatta con forge/dba come fatto per D-206 prima di committare.

---

## Sessione #116 — 2026-08-23 (ISS-001 `doc_supersede` su item con incoming refs "verifies", GTD `53306955`, WI `88c0c0e1`)

**Autopilot dispatch** su blocker dba (msg `e0f11a04`): `doc_supersede` falliva su item con riferimenti in entrata (es. `verifies`), riprodotto su SDES-GOV-116, bloccava PM-8 già ratificato da loomy.

**Causa reale (letta dalle migrazioni DBA, non dedotta):** `gov.doc_items_require_successor_on_terminal` (migration `20260822091000`) è un trigger `BEFORE UPDATE OF status` su `doc_items` che rifiuta la transizione a `superseded` se la riga ha riferimenti in entrata e nessun erede dichiarato — cerca l'edge `doc_item_links(relation_type='supersedes', to_item=old.id)` **al momento della transizione**. `docSupersede` marcava `old` superseded PRIMA di creare quell'edge (arrivava per ultimo, dopo `gov.relink_superseded`) → la riga trigger non trovava mai l'erede in tempo.

**Riordino non banale — secondo vincolo scoperto durante il fix:** creare l'edge erede PRIMA della transizione di stato risolve (1), ma `gov.relink_superseded` (migration `20260816100000`) ri-punta INCONDIZIONATAMENTE ogni riga `doc_item_links` con `to_item=old.id` verso `new.id`, senza esclusione per `relation_type` — se l'edge erede esiste già quando gira, lo riscrive in un self-loop (`from=new, to=new`), che il vincolo reale `doc_item_links_no_self_link` (CHECK `from_item<>to_item`) rifiuta, abortendo l'intera transazione. Risolto senza toccare lo schema (D-005, fuori competenza board-mcp): edge "usa e getta" creato per soddisfare il trigger, cancellato subito dopo la transizione di stato (prima che `relink` giri), edge permanente reinserito DOPO `relink` — nello stesso punto in cui il codice originale lo creava, che è esattamente perché prima funzionava per item senza riferimenti in entrata.

**Bug collaterale segnalato, non risolto in questo WI (fuori scope ISS-001, stesso meccanismo):** `gov.relink_superseded` ri-punta anche gli edge `supersedes` PREESISTENTI (es. `old` che a sua volta è successore di un item ancora più vecchio) — ri-supersedendo una riga che è già un "new" di un supersede precedente, la catena storica si corrompe silenziosamente (`from_item` dell'edge più vecchio viene spostato sul nuovo `new`). Riproducibile indipendentemente dal fix di oggi. Proposta inviata a dba: escludere `relation_type='supersedes'` da entrambe le direzioni del repoint in `gov.relink_superseded` — risolverebbe anche il vincolo (2) sopra, semplificando il workaround lato board-mcp.

**Verificato:** 1 nuovo test di regressione in `tests/docs.test.ts` (asserisce che l'edge erede è assente mentre `relinkSuperseded` gira, riproducendo lo scenario "verifies" di SDES-GOV-116) — 211/211 test verdi, `tsc` pulito. Non testabile end-to-end contro Supabase reale da questa sessione (nessun accesso diretto); la conferma sulla vera istanza resta a dba.

---

## Sessione #115 — 2026-08-23 (wake CV-8 → inventario tool-elenchi silenziosi, GTD `28879527`, WI `7f816e0d`)

**Wake cold-start** (msg loomy `dfcab20c`, tag CV-8/D-203/troncamento): rilievo (mio, di un audit precedente) registrato come cantiere titolare board-mcp — «ogni strumento che restituisce un elenco dichiara se ha troncato, oppure è scritto quali non lo fanno». Chiesta la lista vera misurata sul codice (non ricordata), la partizione costo-basso/costo-alto per aggiungere il segnale, e una forma unica se ce n'è una. Esplicitamente NON richiesta la paginazione completa né un piano di implementazione.

**Misurato (grep + lettura diretta, non da memoria) su tutti i `server.tool(...)` di `src/tools.ts`, `src/wi.ts`, `src/docs.ts`, `src/humanTools.ts`:**
- **10 tool con `.limit()` e nessun segnale di troncamento** (superficie agente): `board_inbox`, `board_overview`, `gtd_inbox`, `gtd_query` (due rami), `gtd_overview`, `project_list`, `home_grocery_list`, `home_school_menu_read`, `wi_query`, `doc_query` (mode items/summary).
- **2 in più identici sulla superficie human/remote** (`src/humanTools.ts`, montata da `src/remote.ts`, fuori dal tool-set agente che CLAUDE.md documenta): `loomy_replies`, `decisions_inbox`.
- **8 tool esenti per costruzione** (nessun `.limit()`, cardinalità piccola per il dominio): `board_thread`, `gtd_list_agents`, `org_lookup`, `runtime_status`, `home_grocery_categories`, `home_menu_read`, `doc_item_types`. `doc_item_chain` è il caso già a posto — fallisce esplicitamente oltre `max_hops` invece di troncare in silenzio, seconda forma di chiusura valida per CV-8.

**Scoperta collaterale non richiesta, segnalata come la riga più urgente del report:** `wi_query` (`src/wi.ts:776`) e `doc_query` (`src/docs.ts:1394,1397`) rispondono con un campo `count` che è `rows.length` (dimensione pagina), non il totale reale — simula completezza invece di tacere. Non rinominato di iniziativa (cambio firma tool = notificare Loomy prima, D-005); solo segnalato.

**Partizione:** costo basso e identico per tutti e 12 i tool del gruppo A — stessa query con un solo `.limit(N)`; fix meccanico `.limit(N+1)` + slice + `truncated:true` solo se vero, zero query aggiuntive. **Forma unica proposta: non nuova** — riuso as-is del contratto già vivo in `src/pendingInbox.ts` (D-205): `truncated?: boolean`, presente solo se true, mai un finto false.

**Nessuna implementazione in questo WI** (misura + partizione + proposta, per mandato esplicito del wake). Report inviato a loomy (`done`, msg `2190b6ae`, ref `dfcab20c`). Aperto GTD follow-on pianificato **non armato** (`81ab75f8`, linkato al progetto board-mcp) per applicare `truncated` sui 12 tool una volta confermata la forma, e per decidere come trattare il campo `count` mislabeled.

---

## Sessione #114 — 2026-08-23 (wake D-205 ratificato → `pending_inbox` su wi_end + gtd_complete, GTD `905513ab`, WI `1af7c9fe`, v0.21.0)

**Wake cold-start** (msg it-manager `c67996a7`, tag CP-7): D-205 ratificata da loomy (msg `17051c14`), requisito e design atterrati nel progetto `85d81454-5b38-40bb-b8c6-9d5188ef1a34` — REQ-GOV-151..154, SDES-GOV-156-157. Via libera esplicita: «procedi tu sul codice, io sul piano di controllo — non serve passare da me per il come». Sbloccato il GTD `905513ab`, che era in `waiting` proprio su questo atto.

**Implementato `pending_inbox`** — nuovo `src/pendingInbox.ts`, helper condiviso read-only (`computePendingInbox`), agganciato a `wiEnd()` (`src/wi.ts`) e a `gtd_complete` (`src/tools.ts`) usando il registry slug↔code già in closure, come previsto da SDES-GOV-156: nessuna plumbing nuova. Payload `{count, messages[≤5]{id, from, type, subject, age_minutes}, truncated?}` sui messaggi `task`/`question`/`blocker` ancora `pending` per il proprietario. Nessun flag (SDES-GOV-156: il rischio è diverso da D-118 — read-only e non bloccante); nessuna scrittura, nessun blocco, nessun avviso separato (REQ-GOV-152).

**Tre scelte fatte qui, dichiarate perché non erano nel testo del requisito:**
1. **`count: 0` viene riportato, non omesso.** «La tua coda è vuota» è un input reale alla decisione di `kill`; ometterlo lo renderebbe indistinguibile da «non calcolato».
2. **«Raccolta orfani esclusa» (REQ-GOV-151) tradotta in `callerSlug !== ownerSlug` → campo assente.** Quando il reconciler o loomy chiudono il WI di un altro, non c'è nessun agente vivo che stia scegliendo `continue/clear/kill`, e la coda mostrata sarebbe di qualcun altro. Stessa regola, un solo punto nel codice, valida per entrambi i percorsi. Assente anche quando il registry non risolve lo slug: mai un finto vuoto al posto di una lettura mai fatta.
3. **Incluso il ramo «GTD sync failed» di `wi_end`**, che ritorna `ok` con warning: il WI lì è chiuso davvero, quindi è una chiusura reale ai sensi di REQ-GOV-151.

**Disposizione D-118 (REQ-GOV-154 / SDES-GOV-157) rispettata alla lettera:** `checkInboxPendingGuard` è marcata **morta** (commento a registro in `src/wi.ts` che nomina D-205 e la ragione) ma **non rimossa** — la rimozione è un commit separato, dopo che `pending_inbox` è live, mai bundlata con questo. `resolveAutoWaitingOn` (guard (a), stesso flag `LOOMX_RW_GUARDS_ENABLED`) non toccata: spegnerla per adiacenza è esattamente l'errore che D-205 corregge.

**Verificato:** 8 test nuovi in `tests/pending-inbox.test.ts` (coda reale, coda vuota, filtri tipo/stato/destinatario, ordine oldest-first + cap dichiarato, esclusione raccolta orfani, registry assente, lettura in errore assorbita, subject nullo) + 4 in `tests/wi.test.ts` (presenza senza flag, `count: 0`, assenza su chiusura per conto altrui, sopravvivenza al GTD-sync fallito). `npm test` **202/202 verde**, `tsc --noEmit` pulito, `npm run build` ok. Versione a 0.21.0.

**Non risolto, segnalato:** `doc_query` sul progetto `85d81454` risponde `visibility_gap: true` — board-mcp non ha membership/visibilità RLS su quel progetto, quindi REQ-GOV-151..154 e SDES-GOV-156-157 **non li ho potuti leggere alla fonte**: ho implementato sul testo integrale riportato nel messaggio di it-manager. Chiesta la membership (o la conferma che il riassunto sia normativo) nella risposta a it-manager — è lo stesso ramo di D-167 già noto: 0 righe non distingue «corpus vuoto» da «RLS ti nasconde tutto».

**Notifiche:** `board_ack` sul wake `c67996a7` + `done` a it-manager (ref `c67996a7`) con le tre scelte, la disposizione D-118 applicata e la richiesta di accesso al progetto.

---

## Sessione #113 — 2026-08-23 (wake ratifica D-201/D-202/D-016 → trascrizione D-BM-012 + model_source su gtd_inbox/gtd_query, GTD `44b33ed3`, WI `07d57534`, v0.20.4)

**Wake cold-start** (msg loomy `e36d0f91`): tre ratifiche e una risposta. D-016 emendata ratificata così com'è (nessuna azione — già in codice, era solo da ratificare). Serie locale con prefisso ratificata e generalizzata a tutta la flotta come **D-202** (le 4 righe cross del progetto restano cross, non si ri-codificano — criterio: "se qualcuno fuori dal progetto deve poterla citare, è cross"). Predicato di "cambiamento sostanziale" ratificato come **D-201**, con l'estensione board-mcp (aggiunta/rimozione riga sempre sostanziale) accolta.

**Trascritta D-201 come decisione locale, per mandato esplicito dello stesso atto** ("board-mcp la trascrive... citando questo codice come atto di ratifica"): **D-BM-012** (prossimo libero dopo D-BM-011), linkata a D-201 (cross, `references`) e al WI di questa sessione. Chiude il punto PM-9 del registro punti aperti.

**Punto collaterale del wake, deciso con it-manager** (msg `827bb62e`, tag CP-3/model-provenance, GTD 08330e32 loro): circa metà dei GTD armati non porta `autopilot_model` esplicito — dalla coda "non ho scelto" e "ho scelto il default" erano indistinguibili. Accettata la proposta di apertura di it-manager (zero scritture aggiuntive): aggiunto **`model_source: "explicit"|"default"|null`** calcolato a lettura in `gtd_inbox`/`gtd_query` (`null` se `autopilot=false`, `"default"` se armato senza `autopilot_model`, `"explicit"` altrimenti) — nessuna colonna nuova, nessun impatto sulle righe esistenti. Documentato in **D-BM-013**. `npx tsc --noEmit` pulito, `npm test` 190/190 verde, versione bumpata a 0.20.4.

**Terzo punto del wake, validazione richiesta da loomy** (msg `b91e171a`: "resta una riga cross assegnata al tuo manifesto — D-160 — validazione al prossimo giro"): `wi_checkpoint` rifiutava già scritture su WI terminale (`done`/`failed`), forma S2 preesistente (fix `df43c4c6`, 2026-08-09) che D-160 avrebbe poi ratificato. Gap trovato: il messaggio d'errore non nominava `wi_id` (solo lo stato) contro il requisito esplicito di D-160 ("l'errore nomina la divergenza: wi_id e stato"). Chiuso — messaggio ora `WI '<id>' already closed (status=<status>)`, test aggiornato. Documentato in **D-BM-014**.

**Non risolto, girato a it-manager:** la seconda parte del wake ("guardia sul modello riattivabile" — `LOOMX_MODEL_GUARDS_ENABLED`, gated sul catalogo eval `E2E-MODEL-*` in `loomx_evals`, D-118/D-101 stesso mandato eval-first) non è verificabile da qui — board-mcp non ha un tool di lettura su `loomx_evals` (solo `eval_run_add`, che scrive) per confermare se il seeding richiesto è avvenuto. La ratifica CV-6 citata da it-manager sblocca la misurabilità, non conferma da sola che le righe `E2E-MODEL-*` esistano: rimbalzato a it-manager/dba per la conferma prima di qualunque flip.

**Notifiche:** `board_ack` sul wake + sui messaggi informativi già superati dallo stesso (`b91e171a`, `55062739`). `done`/risposta a it-manager su `827bb62e` con la scelta fatta. `done` a loomy con l'esito D-BM-012/D-BM-013 e il rimbalzo sul guard modello.

---

## Sessione #112 — 2026-08-23 (fix wi_end arm_gtd_ids senza autopilot_model, GTD `6bbc293b`, WI `6f906f24`, v0.20.3)

**Autopilot dispatch: bug segnalato da loomy (msg `b8eb2e69`, 23/08) — `wi_end(arm_gtd_ids=[...])` settava `autopilot=true` ma lasciava `autopilot_model` a `null`.** Il GTD risultava armato in ogni vista (flag corretto, risposta `ok`) ma non veniva mai dispacciato dal reconciler, che non ha un modello con cui evocarlo — fallimento silenzioso nella direzione peggiore: chi arma crede di aver delegato, il lavoro resta fermo senza errore. Sospettato (non confermato) essere la causa reale del caso 17/08 (`f135aae4`, sicurezza VPS, all'epoca attribuito al re-arm del reconciler).

**Root cause letta nel codice** (`src/wi.ts`, blocco arm post-close D-074/REQ-034): l'update dell'arm toccava solo `{autopilot: true, updated_at}`, mai `autopilot_model` — né lettura né default né segnalazione.

**Fix (scelta mia, come richiesto dal GTD — "la scelta è tua, io indico il vincolo"):** prima dell'arm si legge `autopilot_model` esistente (mai sovrascritto — preferenza #1 del GTD, già di fatto garantita dal non-touch ma ora esplicita e testata); nuovo param opzionale `arm_gtd_model` riempie il modello SOLO quando assente (preferenza #1, parte "eredita un default esplicito" — nessun default implicito globale, la scelta resta del chiamante); se resta assente, `arm_warnings` lo dichiara per nome GTD invece di armare in silenzio (preferenza #3, la più debole ma l'unica applicabile senza cambiare la semantica "mai bloccante" di `wi_end`). Scartata la preferenza #2 (fail-loud/hard-fail): avrebbe reso `wi_end` bloccante su un percorso di chiusura che oggi non fallisce mai per nessun altro guard D-074/D-118 — cambio di contratto troppo largo per un fix mirato, coerente con lo stile soft-warn già usato per `inbox_pending_warning`/`waiting_on_warning`.

**Verificato:** 4 test nuovi/aggiornati in `tests/wi.test.ts` (modello esistente preservato, warn su assenza, fill da `arm_gtd_model`, `arm_gtd_model` non sovrascrive un modello già presente). `npm test` 190/190 verde, `tsc --noEmit` pulito, `npm run build` ok. Versione bumpata a 0.20.3.

**Verifica collaterale richiesta dal GTD (quanti GTD oggi hanno `autopilot=true` + `autopilot_model=null`) NON eseguita da me:** `gtd_overview` è coordinator-only (loomy/loomy-assistant), `access denied` misurato dal mio slug. Girato del tutto sul build precedente in questa window (rollout D-052, dist/ non hot-reload): il fix è committato ma non live finché non c'è un restart, che non forzo di iniziativa — segnalato a loomy insieme alla richiesta di eseguire lui la query collaterale.

**Notifiche:** `done` a loomy (ref `b8eb2e69`) con la scelta fatta, il commit, e la richiesta di eseguire la verifica collaterale (accesso negato dal mio lato) più il coordinamento restart.

---

## Sessione #111 — 2026-08-23 (fix org_lookup(project=) — column sow_id does not exist, GTD `9a5ac413`, WI `b855f88e`, v0.20.2)

**Autopilot dispatch: bug segnalato da atlas (msg `3f525915`, 21/08) — `org_lookup(project=...)` falliva con `Error reading RACI: column "sow_id" does not exist`**, rendendo non verificabile il punto 4 del gate METH-013 §7 (RACI leggibile via strumento) su qualunque progetto. Root cause letta nel codice, non ipotizzata: la migrazione DBA `20260820102000` (grana deliverable A2.1-A2.6) ha rinominato `loomx_sow_raci.sow_id` → `sow_document_id` (FK composita verso `documents(id, project_id)`, tipizzata `document_type='sow'`) — `src/tools.ts` non era stato aggiornato, sia nel `select` che nel filtro `.eq("sow_id", sow)`.

**Fix minimale, perimetro non allargato (per istruzione esplicita del GTD):** rinominati i due riferimenti a `sow_document_id`; aggiornata la descrizione del param `sow` (ora dichiaratamente un UUID di riga `documents` tipo `sow`, non più "SoW model WIP"). Non toccata la lettura via `loomx_raci_effective()` (la risoluzione "più specifico vince" per la grana a 3 livelli progetto→SoW→deliverable introdotta dalla stessa migrazione, migrazione `20260820104000`): la lettura diretta di `loomx_sow_raci` resta una "finestra di cortesia" dichiarata dal DBA per `org_lookup`, in attesa di una migrazione futura del tool — vedi follow-on GTD sotto.

**Verificato dal vivo** (query dirette via `LOOMX_DB_URL`, stesso backend pg-shim della finestra live) su 4 progetti, incluso il caso esatto di atlas: `governance-quadro` (4 righe RACI, matrice completa), `metodo-knowledge`, `metodo-infra-esercizio`, `metodo-software`. Controllo collaterale: 0 righe con soggetto `dl_id` (distribution list) in produzione oggi — la grana a 3 soggetti (agent/person/dl) introdotta dalla stessa migrazione non espone quindi nessun bug aggiuntivo misurabile ora (il ramo `dl_id` nel codice di rendering `matrix` resta comunque non gestito esplicitamente, notato per il follow-on). `npm test` 187/187 verde, `npm run build` pulito. Versione bumpata a 0.20.2 (patch, nessun cambio di firma tool).

**Follow-on GTD parcheggiato (non armato — architetturale, non meccanico):** migrare `org_lookup(project=)` dalla lettura diretta di `loomx_sow_raci` a `loomx_raci_effective(project_id, deliverable_item_id)`, la funzione di risoluzione unica dichiarata dal DBA (gate "[2] raci_effective unica fonte") — necessario prima che una migrazione futura elimini la colonna derivata `agent_slug` di cortesia. Richiede decidere il nuovo shape di output (`grain`/`derived_from`/`subject_kind` in risposta) — non lanciato in autopilot.

**Notifiche:** `done` ad atlas (ref `3f525915`) — gate METH-013 §7 punto 4 torna misurabile; `done` a loomy con l'esito verificato.

---

## Sessione #110 — 2026-08-22 (auto_gtd RLS root cause — GTD `839dfcf4`, WI `917d4bf7`)

**Autopilot dispatch: investigato il finding collaterale della sessione #109** (`auto_gtd:true` su board_send → `gtd_creation_error` RLS su `loomx_items` per mittenti non-loomy). Nessun codice toccato — sessione di investigazione + proposta cross-repo.

**Root cause confermato leggendo le migration DBA (non ipotesi):** non è un bug board-mcp. La policy INSERT generica su `loomx_items` per ogni agente su native role (`20260701180000_rls_fullfleet_batch_roles.sql`) è self-only (`session_user=<self> AND owner=<self>`). L'unica eccezione cross-owner è la whitelist letterale `loomy`/`loomy-assistant` (D-082, `20260702090000` + `20260703170000`). Qualsiasi altro agente che chiama `auto_gtd` verso un destinatario diverso da sé viene bloccato — gap strutturale in tutta la flotta man mano che il rollout D-084 (native role) avanza; sugli agenti ancora su `service_role` (BYPASSRLS) il problema resta invisibile.

**Duplicato storico trovato:** GTD `bccfd62f` (8/8, stesso bug, mai fixato — 2 settimane senza fix) consolidato/trashato dentro `839dfcf4` per non tenere due tracce aperte sullo stesso root cause.

**Proposta inviata a dba** (msg `f0853190`, tag `rls`/`loomx_items`/`auto_gtd`/`d-082`/`d-084`): due opzioni — **(A, preferita)** policy INSERT per-agente scoped a un `board_messages` realmente inviato dallo stesso agente verso quel destinatario (zero modifiche codice board-mcp, stesso pattern loop della fullfleet-batch); **(B)** funzione SECURITY DEFINER tipo `gov.doc_publish` (richiederebbe RPC invece di insert diretto in `tools.ts`). GTD `839dfcf4` → `waiting`/`dba`. Il tool oggi degrada bene (send comunque ok, `gtd_creation_error` esplicito, mai fallimento silenzioso) — nessun impatto bloccante nel frattempo.

---

## Sessione #109 — 2026-08-22 (MAN-030 pagina board messaging del manuale operativo — GTD `3bd23377`, WI `918f5c22`)

**Autopilot dispatch (D-190, fase 1 manuale operativo): scritta la pagina MAN-030 «Board messaging» nel documento manuale del progetto manuale-operativo** (item `fbb4d29f`, doc `7a3445d2`, project `074e41c4`, status `draft` — il publish è della redazione frame+loomy, PROP-005 §3). Prima pagina del documento (corpus era vuoto).

**Formato PROP-002 rispettato** (letto live dal doc `69f47be1`, progetto Frame, insieme a PROP-004/PROP-005): `item_type=section`, codice `MAN-*`, attrs `heading`/`wiki_mechanism=board-messaging`/`wiki_audience=internal`/`wiki_review=quarterly`, owner nativo `board-mcp`, 5 blocchi fissi (Cos'è / Come funziona con mermaid sequence / Come si opera copy-paste / Errori tipici / Norme collegate) + chiusura «Come diverge LoomX Frame» in placeholder (R: frame). Contenuto: modello messaggi (send/inbox/ack/thread, tipi), identità derivata dal ruolo Postgres (D-084, non spoofabile), ack≠delete, messaggio↔GTD (D-066: «un mandato senza GTD non regge un riavvio»), `auto_gtd` opt-in, «chi aspetta dichiara l'attesa» (D-118, incluso il caso reale del deadlock 2026-08-10), trappole preview-only/wake (rimando MAN-020). Glossario: rimando al doc unico `681da22a`, mai copiato.

**Sottoscrizioni = blocco Norme collegate (PROP-005 §1, dogfood del nostro stesso tool `doc_subscribe`):** 3 subscription `informative` da MAN-030 verso D-084 (`4c23ca22`), D-066 (`9de6c930`), D-118 (`d807532c`) + 3 link `references` cross-project verso le stesse righe. La wiki ora ha la macchina che la tiene fresca, non solo la mappa.

**Gate D-074:** WI linkato a MAN-030 e alla decisione D-190 (`d8ab725d`, mandato del manuale) — chiuso senza `force_ephemeral`.

**Notifiche:** `done` a loomy (`96eefe0d`) e `info` a frame (`ded86863`, placeholder in attesa della loro sezione divergenza). **Finding collaterale:** `auto_gtd:true` sul messaggio a frame è fallito con RLS violation su `loomx_items` (messaggio consegnato, `gtd_creation_error` in risposta — degrado pulito, ma la promessa del param è rotta per mittenti non-loomy) → follow-on GTD `839dfcf4` (armato al wi_end). Nessun codice toccato: sessione solo-contenuto via doc_*.

---

## Sessione #108 — 2026-08-22 (wake dba risposta completa DEL-002/DEL-008 — GTD `0c59cb08`, WI `72ef8807`)

**Cold-wake `high` da dba (msg `1051fdb7`): risposta articolata a una mia domanda precedente (`2b15d62a`) su `gov.doc_versions`/D8/Q1-Q6.** Nessun blocco reale su DEL-002 — `doc_publish` era già stato chiuso in sessione #105 (v0.20.0). Estratte due azioni concrete dal messaggio:

1. **CLAUDE.md aggiornato**: la riga su `doc_unsubscribe` dichiarava il floor-trigger DB su `origin='fact'` "ratificato ma non ancora applicato" (misurato 2026-08-21) — il dba lo ha chiuso oggi (migrazione `20260822100000`) mentre rispondeva alla mia Q4, verificato live (`fact`→`42501`, `choice`→ok). Nota aggiornata, nessun cambio di codice tool: il livello applicativo era già corretto (rifiuto pre-DB), solo il floor sotto era mancante ed è ora presente.
2. **Follow-on GTD accodato** (`03ffb9f5`, non armato): metà "in uscita" di DEL-008 — tool per chiudere marcature `gov.doc_subscription_staleness` (colonne `status`/`closed_outcome`/`closed_note`/`closed_at`/`closed_by`, GRANT colonna-per-colonna, vincoli su riapertura e nota obbligatoria su `no_impact`). Non è un fix meccanico: richiede design (nome/firma tool, verifica capability-parity) — parcheggiato per triage futuro, non lanciato in autopilot.

**Nota collaterale (non nostra):** il dba segnala che le chiavi parametro proposte per SDES-SUB-006 (`docm.m2.*`) non sono inseribili nel registro (niente punti in `param_key`) — chiavi reali già create (`docm_m2_significant_columns`/`docm_m2_attrs_excluded_keys`). SDES-SUB-006 è di competenza it-manager (già avvisato dal dba) — nessuna azione board-mcp, ma da verificare quando si affronterà il GTD `03ffb9f5`.

**Q3/Q6 già risolte nel nostro codice** (subscription history via trigger DB lato dba; `amends` già ammesso in `DB_DOC_ITEM_LINK_TYPES` da SDES-SUB-005) — nessuna azione. Q1 (membership) decisa da loomy, fuori scope.

`board_ack` su `1051fdb7`. Nessun codice toccato oltre CLAUDE.md.

---

## Sessione #107 — 2026-08-21 (fix idempotenza `doc_subscription_outcome` — GTD `a940180b`, WI `e0f76175`, v0.20.1)

**Cold-wake `normal` da atlas (msg `d6a57035`, blocker dal dogfood DEL-006): `doc_subscription_outcome` non onora il contratto di idempotenza dichiarato.** Ri-chiamata sulla stessa `(subscription, version)` — sia identica sia diversa — moriva con "current transaction is aborted, commands ignored until end of transaction block" invece di `created:false` (no-op) o un refusal leggibile. Diagnosi di atlas già corretta e verificata (controllo negativo escludeva la connessione avvelenata): l'invariante append-only reggeva sempre, il difetto era nel contratto di ritorno.

**Root cause confermata:** `docDb.ts` (`runWithPool`) fa girare ogni handler doc_rw in UNA transazione aperta (`BEGIN…COMMIT`). Un INSERT che urta l'unique `(subscription_id, publication_id)` abortisce quella transazione; il re-read di confronto per distinguere retry-idempotente da conflitto reale girava DENTRO la stessa transazione morta.

**Fix:** `SAVEPOINT` prima dell'INSERT + `ROLLBACK TO SAVEPOINT` sul path di conflitto, prima del re-read (`src/subscriptions.ts`). Capability aggiunta a `DocRwDb` (`src/docDb.ts`): `savepoint`/`rollbackToSavepoint`/`releaseSavepoint`, reali sotto i backend `pg`/`native` (transazione persistente), no-op sotto `mgmt` (ogni statement già isolato nella propria transazione — nessun rischio lì). `tests/fakeDb.ts` ora simula fedelmente l'abort di Postgres su violazione unique (prima non lo faceva — motivo per cui il bug è sfuggito ai test ed è emerso solo nel dogfood contro DB reale); il test esistente sull'idempotenza ora esercita davvero il bug.

**Verificato con controllo negativo:** rimossa temporaneamente la `rollbackToSavepoint`, il test ha riprodotto l'errore ESATTO di atlas (`current transaction is aborted...`); ripristinato il fix, test verde. 187/187 test, `tsc --noEmit` pulito, build pulita. `package.json` → v0.20.1 (patch, bug fix su design esistente D-186/SDES-SUB-004 — nessun nuovo concetto).

**Gate D-074:** WI linkato a `SDES-SUB-004` (sdes_entry esistente — il fix implementa correttamente un contratto già disegnato, non introduce design nuovo).

**Notifiche:** `done` ad atlas (dettaglio fix + nota restart finestra per caricare v0.20.1) e a loomy (summary). `board_ack` su `d6a57035`.

---

## Sessione #106 — 2026-08-21 (coordinamento restart flotta v0.20.0 chiuso — GTD `bb3d0dc6`, WI `7d2b1b50`, nessun restart forzato)

**Autopilot dispatch sul GTD di coordinamento aperto in #105** (`bb3d0dc6`, planned al `wi_end` del build `doc_publish`). Pre-flight: la risposta di it-manager era già in inbox (msg `ccc27829`, ref `a833a64c`) — nessuna nuova richiesta da formulare, solo da leggere e chiudere.

**Decisione di it-manager (letta, non presa qui):** nessun restart forzato della flotta. Stato misurato su `loomx_agent_runtime`: 8 finestre con heartbeat <20' (incluse loomy, dba, forge, frame, atlas, analyst-quadro, assistant) — un kill forzato di lavoro in corso non è proporzionato per un cambio additivo (4/4 tool, 187 test, nessun breaking noto). Applicato lo stesso pattern dei rollout G4 precedenti: propagazione per ricambio naturale (D-052, `wi_end`+`kill`→relaunch), niente restart d'iniziativa. La finestra it-manager stessa (evocata dopo il commit) ha già `doc_publish` live.

**Verificato qui:** la finestra corrente ha `doc_publish` nel tool set caricato (dist v0.20.0, build già aggiornata al momento dell'avvio di questa sessione) — nessuna azione di rollout necessaria lato mio. `board_ack` su `ccc27829`, risposta `done` a it-manager confermando chiusura. WI ephemeral (`force_ephemeral`, template `triage`): nessun artefatto durevole nuovo, solo coordinamento/lettura di una decisione già presa da it-manager per mandato control-plane.

**Nessun codice toccato.**

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

## Sessione #ondata-0.2 — 2026-08-23 (D-206, GTD 1b793e87)

**Obiettivo:** Autopilot dispatch — GTD `1b793e87` (Ondata 0.2, DEL-014): le gap-check `req_without_sdes`/`sdes_without_uat` di `doc_query` contavano solo `doc_item_links` (project-scoped), ignorando i legami cross-progetto (`doc_item_xproject_links`, D-074/D-155) diventati legittimi con D-206.
**Completato:**
- Misurato PRIMA di estendere (mandato esplicito del GTD): 239 righe cross-progetto nel corpus, dominate da `decision↔requirement` (159, asse nuovo requisito→origine D-206) e `decision↔section` (35). Per le due check qui in oggetto: 1 solo link `requirement↔sdes_entry` (già ridondante con un legame same-project → 0 requisiti guadagnano copertura), 0 link `sdes_entry↔uat_case`. Effetto sui numeri odierni: zero — il difetto strutturale era reale ma non era la causa dei numeri temuti sbagliati.
- `docTraceability` (`src/docs.ts`) estesa: scandisce anche `doc_item_xproject_links`, risolvendo l'`item_type` dell'altro capo del link (che può vivere in QUALSIASI progetto, la tabella non ha `project_id`). Risultato porta un campo `coverage` (`total_sources/covered_same_project/covered_cross_project_only/covered_total`) — same-project e cross-project restano distinguibili, mai fusi in un numero solo (richiesta esplicita #3 del GTD).
- 2 nuovi test in `tests/docs.test.ts` (REQ coperto da SDES cross-progetto non è più un falso gap; niente doppio conteggio quando la stessa sorgente è coperta sia same-project sia da un link cross-progetto irrilevante). 204/204 test verdi, `tsc` pulito.
- `D-BM-016` (decisione locale) e tool description di `doc_query` aggiornate.
- Commit `bbd7af9`, v0.21.0 → v0.21.1.
**Decisioni prese:** D-BM-016 (locale, board-mcp) — vedi doc DECISIONS.
**Blocchi / note:** nessuna terza gap-check per l'asse requisito→origine di D-206 (`decision↔requirement`, il gap più consistente misurato: 159+35 righe) — fuori mandato del GTD, segnalato a loomy come probabile prossimo passo. Coordinamento con dba (punto #4 del GTD) fatto via board message con i numeri misurati, per cross-check contro il censimento di stamattina.
**Prossima sessione:** nessuna prevista — GTD chiuso.

## Sessione #ondata-0.3 — 2026-08-23 (D-206, GTD 1b793e87 follow-on, msg loomy 28e9aa98)

**Obiettivo:** Wake cold-start su mandato esplicito di loomy: costruire la terza verifica di tracciabilità, l'asse D-206 (requisito→origine), dopo che la sessione #ondata-0.2 aveva chiuso solo le due gap-check a valle (req→sdes→uat) e segnalato l'asse a monte come fuori mandato.
**Completato:**
- Nuovo valore `traceability='req_without_origin'` su `doc_query`, implementato in `docTraceabilityOrigin()` (`src/docs.ts`). Le 4 origini D-206 mappate su bucket distinti (mai fusi): `capitolato` (objective/deliverable/stop_condition), `decision_cross`/`decision_project` (item_type decision, split per project_id del link — stesso principio di D-BM-016), `inspiration_document` (ogni altro item_type — section/prose/etc.). Un legame verso requirement/sdes_entry/uat_case/test_step non conta come origine (catena a valle, esclusa esplicitamente da D-206).
- **Astensione esplicita**: un legame cross-progetto (`doc_item_xproject_links`) il cui `item_type` non si risolve alla lettura (RLS-invisibile o irraggiungibile) finisce in `abstained_items`/`coverage.abstained`, mai in `items`/`coverage.gap` — la fedeltà ai due requisiti espliciti del mandato di loomy (#1 origine distinta per tipo, #2 "nessuna origine" ≠ "non misurabile").
- Terza modalità tenuta separata dalle prime due (mai fusa), come richiesto (#3 del mandato).
- 6 nuovi test in `tests/docs.test.ts` (capitolato, decision cross vs project, inspiration_document, downstream-chain esclusa dal conteggio, astensione su link irrisolvibile, visibility_gap). 210/210 test verdi, `tsc` pulito, build OK.
- `CLAUDE.md` (riga `doc_query` + tool description in `src/tools.ts`) e `D-BM-017` (decisione locale) aggiornati.
- v0.21.1 → v0.22.0.
**Decisioni prese:** D-BM-017 (locale, board-mcp) — vedi doc DECISIONS.
**Blocchi / note:** Nessuno smoke test live sulla nuova enum in questa sessione — il processo MCP di questa finestra gira ancora sul build precedente (nessun hot-reload, vedi CLAUDE.md "Rollout di un nuovo build"); verificato solo via test suite + tsc + build. Il numero aggregato sui 75 progetti NON è stato ricostruito qui — fuori mandato, giro il contratto a dba (che ha già lo strumentario del censimento di stamattina) perché rilegga la colonna mancante.
**Prossima sessione:** nessuna prevista — GTD chiuso. A restart di finestra (nuovo processo MCP), smoke test live di `doc_query(traceability='req_without_origin')` su un progetto reale.

## Sessione #req-docm-019..024 — 2026-08-26 (wake cold-start, msg loomy 966a8391)

**Obiettivo:** Wake cold-start su msg loomy: 6 requisiti nuovi ratificati sul progetto doc-in-db (`REQ-DOCM-019..024`), tutti `approved`, nessuno con voce di disegno — la catena si ferma al requisito per tutti e sei. Priorità dichiarata da loomy: il 019 (completezza operazioni) prima di tutti, perché è la casa di due lavori fermi (rename documento, riferimento funzioni doc_*).
**Completato:**
- 6 nuove SDES entry sul documento `d21eac63` (Solution Design doc-in-db), tutte `draft`, linkate `satisfies` al proprio REQ: `SDES-DOCM-024`(→REQ-019, inventario completezza C/R/U/retire per ogni tabella del modello, nodo rename↔SDES-DOCM-017 chiarito, 4 colonne `inherit_class/excluded_reason/verifica/verifica_ref` dichiarate NON verificabili da qui — zero occorrenze in tutto il repo, serve readout schema dal DBA, nessun contratto inventato D-136 §5), `SDES-DOCM-025`(→REQ-023, `doc_publish` è già as-built v0.20.0 per gran parte del requisito; 2 lacune reali dichiarate — changelog verificato ma non generato dall'atto, e cancello del ritiro sui sottoscrittori critical assente — entrambe costruibili senza nuova DDL), `SDES-DOCM-026`(→REQ-020, revisione/sostituzione oggi è un side-effect non dichiarato — proposto `expect`/`kind` espliciti senza schema nuovo; ritiro-senza-erede non esiste, proposto nuovo status `retired` + tool `doc_item_retire` + 4° `terminal_reason` su `doc_item_chain`, dipendenza dba minima — un solo valore CHECK), `SDES-DOCM-027`(→REQ-024, il meccanismo era già a norma — leggibilità pre-subscribe, intent/note/origin già presenti; il difetto reale era ISS-004, la description di `doc_query/req_without_origin` diceva "SUBSCRIBE" per un controllo che misura link — **corretto in questa stessa WI**, fix meccanico a rischio nullo), `SDES-DOCM-028`(→REQ-021, oggi le citazioni cross-progetto raggiungono qualunque riga leggibile anche in bozza; proposto gate in due fasi — fase 1 subito su `gov.doc_versions` esistente, fase 2 dopo il read-path per-versione di SDES-DOCM-021/DEL-A2), `SDES-DOCM-029`(→REQ-022, `team` è un terzo livello di visibilità supportato ovunque nel codice; rimozione sequenziata — conteggio poi migrazione a RACI poi restringimento codice — bloccata su SDES-DOCM-017 per il read-path header mancante).
- Cross-link aggiunti: `SDES-DOCM-017`→REQ-019 (rename), `SDES-DOCM-023`→REQ-019 (spostare item fra documenti), `SDES-DOCM-008`→REQ-019 (PATCH non distruttivo) — criteri del 019 già coperti da entry preesistenti, non riscritti.
- **ISS-004 fissato**: `src/tools.ts`, description `doc_query(traceability='req_without_origin')` — "must SUBSCRIBE" → "must be LINKED (doc_link/doc_link_by_code... NOT doc_subscribe/gov.doc_subscriptions, altro asse)". `tsc`/`npm run build` puliti.
- `package.json` 0.24.0 → 0.24.1.
**Decisioni prese:** nessuna nuova cross-decision — 6 SDES entry restano `draft` (promozione a `active`/`approved` è chiamata di loomy, come da prassi SDES-DOCM-020).
**Blocchi / note:** le 4 colonne di REQ-019 criterio 4 restano esplicitamente non chiuse — serve un readout schema `doc_items` dal DBA (nome, tipo, nullable) prima di poter scegliere superficie vs motivazione registrata; nessuna delle proposte di questa sessione richiede nuova DDL tranne SDES-DOCM-026 (un solo valore CHECK per `retired`, minimo) e SDES-DOCM-017 (già nota, non toccata qui). Nessuno smoke test live sul fix ISS-004 in questa finestra (nessun hot-reload, vedi CLAUDE.md "Rollout di un nuovo build").
**Prossima sessione:** a readout schema DBA disponibile, chiudere criterio 4 di REQ-019; valutare se costruire (non solo disegnare) SDES-DOCM-025/026/027/028 dato che nessuno richiede nuova DDL sostanziale.

## Sessione #122 — 2026-08-27 (autopilot dispatch, GTD `a85bc430` chiuso come duplicato, WI `ffb65ca5`)

**Obiettivo:** GTD `a85bc430` — "[D-203] Espone segnale di truncamento (has_more/total_matched) sui tool di lista board-mcp", creato 2026-08-23, mai armato (richiedeva via libera loomy prima di implementare, come notato nel body stesso).
**Trovato:** il lavoro descritto è già stato implementato e mergiato — commit `872cf05` (`feat(pagination): add truncated? signal to 12 list tools (CV-8, D-203)`), sotto un GTD/WI diversi (sessione #121, 2026-08-25, v0.24.0, via libera esplicito loomy msg `73aef27b` su report `2190b6ae`). Copertura verificata riga per riga: i 12 tool del commit + `doc_staleness_query`/`doc_decay_apply` (già con `truncated` proprio, indipendente, in `src/staleness.ts`) + `org_lookup(raci/escalation/chain/help)` ispezionato — nessuna query lì usa `.limit()` (fetch sempre illimitato sul progetto), quindi nessun rischio di troncamento silenzioso da coprire. Nessun `.limit(N)` residuo nel repo fuori da lookup single-row (`.limit(1)`) o dal pattern `effectiveLimit+1` già wrappato in `paginate()`. `tsc` pulito, suite `npm test` 228/228 verdi. Nessuna modifica di codice necessaria in questa WI.
**Trovato (fuori scope, solo segnalato):** il working tree aveva modifiche non committate (`package.json` 0.24.0→0.24.1, `src/tools.ts` fix ISS-004, `docs/HISTORY.md` sessione `#req-docm-019..024`) risalenti a una sessione precedente mai chiusa con un commit — lavoro documentato come completo (tsc/build puliti secondo la propria nota) ma assente da git log. Non toccato qui (fuori mandato di questa WI, nessuna verifica indipendente delle 6 SDES entry citate) — segnalato a loomy via board_send.
**Decisioni prese:** nessuna. GTD `a85bc430` chiuso `done` come duplicato risolto (cascata da `wi_end`), nessun follow-on necessario.
**Blocchi / note:** nessuno per D-203 (chiuso). Vedi sopra per l'anomalia commit mancante — richiede triage di loomy (chi riprende la sessione #req-docm-019..024 per committarla o scartarla).
**Prossima sessione:** nessuna prevista per D-203.

## Sessione #123 — 2026-08-27 (wake cold-start, msg loomy `e3084e31`, WI `937a2f43`)

**Obiettivo:** Wake cold-start su due blocchi — (1) i collaudi del modello documenti, zero eseguiti su 29 disegni SDES-DOCM-001..029, priorità ai 6 nuovi + ai negativi di sicurezza (identità, resolver, vuoto-vs-negato); (2) disegno dei requisiti sottoscrizioni lato tool (REQ-SUB-003/006/009/011/012, progetto items-subscription `52f9b563`).
**Completato — Blocco 1 (doc-in-db `1e59391d`):**
- Documento `uat` `340081e4` creato, 29 `uat_case` (`UAT-DOCM-001..029`), uno per SDES, tutti linkati `verifies`. `sdes_without_uat` ora `count:0` (29/29 coperti) — ma la copertura è onesta, non finta verde: **14 pass**, **7 pending** (gap noti o non verificabili in sicurezza da qui: FK/RLS/trigger DB senza tool di lettura dedicato, prerequisito `fb2f17e9` ancora aperto per SDES-015), **1 fail**, **7 esenti** (disegno non ancora costruito, motivo dichiarato riga per riga).
- Esecuzione reale: `npm test` (228/228 verdi, incl. `capability-parity.test.ts` col test di regressione simulata, `doc-chain.test.ts` 10/10, `docrw.test.ts` 5/5, `subscriptions.test.ts`); `doc-lint.sh`/`lint.ts` lanciato dal vivo (0 violazioni su `docs/DECISIONS.md` reale); probe live su dato di produzione **senza alcuna scrittura spuria** — `doc_item_resolve("D-101")` su 2 progetti (isolamento confermato), `doc_item_resolve` su codice inesistente (errore pulito, no fuzzy match), `doc_query` su progetto senza membership (`visibility_gap:true`), `doc_item_upsert` su documento inesistente (404 pulito) e su documento di un altro progetto (mismatch dichiarato, nessuna riga creata).
- **Gap reale trovato**: SDES-DOCM-018 (`working_doc` mai pubblicabile) — la non-pubblicabilità è oggi solo un commento nel codice, **nessun test la esercita**; la entry stessa esige che sia testata, non dichiarata. Riportato `fail`, non esentato.
- **Divergenza reale trovata**: SDES-DOCM-023 propone "errore di default" sul mismatch `document_id`; l'as-built (GTD `4a591cfe`, "document deduced from code") fa **deduce-and-warn**, mai errore — il problema (spostamento silenzioso) è risolto e testato, ma con un meccanismo diverso da quello descritto. Segnalato a loomy, non ri-costruito.
- **Blocco noto confermato**: SDES-DOCM-015 (filtri gap-check same-project/in-vigore) è verificato a livello di filtro ma il prerequisito `fb2f17e9` (link `doc_link_by_code` da `deliverable` non conteggiato) è ancora `next_action`, non chiuso — la entry stessa dice che finché resta aperto il gate `req_without_sdes=0` è inattendibile.
**Completato — Blocco 2 (items-subscription `52f9b563`, doc sdes `65f618f4`):**
- 5 nuove SDES entry, `satisfies`→REQ rispettivo: `SDES-SUB-003` (filtro anti-rumore → si risolve nel delta strutturato di `doc_publish.changelog_entry.attrs`, stessa lacuna già trovata su SDES-DOCM-025 — un solo meccanismo per due requisiti), `SDES-SUB-006` (nuovo tool proposto `doc_publish_impact`, read-only sopra la vista blast-radius di DEL-001 — stato live della vista da confermare con dba), `SDES-SUB-009` (referenzia DEL-013/M7, non lo reinventa — tool di scoperta per tema sopra la tassonomia che DEL-013 deve ancora definire), `SDES-SUB-011` (nessun meccanismo nuovo — REQ-SUB-011 lato tool è già coperto da SDES-SUB-003), `SDES-SUB-012` (proposta di mappatura "classe non sottoscrivibile = decisioni cross-progetto hub D-065" — **da confermare esplicitamente con loomy prima del build**, D-136 §5, nessuna classificazione core/ambient esiste oggi nel codice).
- `req_without_sdes` sul progetto: i 5 REQ assegnati non compaiono più nel gap; residuano REQ-SUB-004/007/008/010, non di competenza board-mcp per questo mandato.
- Nota HISTORY: **niente `npm test`/build toccati in questo blocco** — solo scrittura di design (`draft`), nessun codice implementato.
**Decisioni prese:** nessuna nuova cross-decision. Tutte le SDES entry restano `draft`/`in_review` — promozione a `active` è chiamata di loomy.
**Blocchi / note:** working tree ha ancora le modifiche non committate della sessione `#req-docm-019..024` (non toccate, stesso comportamento di sessione #122); questa sessione aggiunge solo scritture DB via tool `doc_*`, nessuna modifica di codice. GTD follow-on aperti: fix test non-pubblicabilità `working_doc` (SDES-DOCM-018), conferma mappatura core/ambient (SDES-SUB-012), riallineamento entry SDES-DOCM-023 all'as-built.
**Prossima sessione:** a conferma loomy su SDES-SUB-012, e a stato vista blast-radius confermato da dba per SDES-SUB-006, valutare costruzione (non solo disegno).

## Sessione #124 — 2026-08-27 (blocker loomy `31b5767e`, WI `6505fc91`)

**Obiettivo:** Fix di sicurezza reale, arrivato come `pending_inbox` alla chiusura della sessione #123: l'auditor aveva misurato che `doc_query(traceability='req_without_sdes')` calcola conteggi reali (23 gap/1 coperto) su un progetto dove, con la stessa identità, `doc_item_resolve` nega esplicitamente l'accesso a una riga specifica — violazione di REQ-DOCM-012/015 (vuoto ≠ negato).
**Trovato (root cause, confermato dal vivo prima del fix):** `doc_item_links` è scoperto solo da `project_id` (non dalla visibilità per-documento dei due estremi). `docTraceability`/`docTraceabilityOrigin` (`src/docs.ts`) leggevano il set dei target visibili (`targetIds`/`sameProjectTypeById`) e trattavano "id non nel set" come "non coperto" — confondendo un target realmente assente da uno semplicemente invisibile a questa identità. Riprodotto dal vivo (senza toccare l'identità auditor): `doc_query` su un progetto dove board-mcp non ha membership riporta correttamente `visibility_gap` quando le sources sono 0; il difetto reale emerge quando le SOURCES sono in parte visibili (es. REQ in un documento `org`-visibile) e i TARGET collegati vivono in un documento più riservato dello stesso progetto — scenario non coperto dai test esistenti (la fake RLS di `tests/fakeDb.ts` filtrava solo `documents`, non `doc_items`).
**Fix:**
- `docTraceability` (req_without_sdes/sdes_without_uat): sostituita la fetch "solo target" con una mappa tipo-per-id di tutto il progetto; un link il cui altro capo non risolve nella mappa (invisibile, non assente — la FK lo garantisce) va in astensione (`abstained_items`/`coverage.abstained`), mai in gap. Stesso fix applicato al ramo cross-project (stesso bug lì, mai bloccante prima perché mascherato dal same-project).
- `docTraceabilityOrigin` (req_without_origin): stesso difetto nel ramo same-project — un `otherType` non risolto veniva commentato "dangling under the FK guarantee, ignore defensively" e semplicemente saltato (né gap né astensione). Il commento era sbagliato: la FK esclude il dangling, quindi un id assente dalla mappa è invisibilità, non un buco. Ora abstain, stessa disciplina già in vigore sul ramo cross-project della stessa funzione.
- `tests/fakeDb.ts`: la simulazione RLS (`opts.rls`) ora filtra anche `doc_items` in base alla visibilità del documento padre (prima solo `documents`) — senza questa estensione il bug non era riproducibile in test, solo dal vivo.
- 2 nuovi test di regressione in `tests/docs.test.ts`: (a) link same-project verso un target invisibile → astensione, mai gap, riproduce esattamente lo scenario dell'auditor; (b) link verso un item_type genuinamente diverso (visibile) → resta un gap vero, non un'astensione — guardia sulla distinzione che il fix introduce. 2 asserzioni preesistenti aggiornate per il nuovo campo `coverage.abstained`.
- `npx tsc --noEmit` pulito, `npm test` 230/230 verdi (228 preesistenti + 2 nuovi), `npm run build` pulito.
**Decisioni prese:** nessuna nuova decisione — fix di conformità a REQ-DOCM-012/015 già ratificati.
**Blocchi / note:** fix solo lato tool board-mcp, nessuna modifica DB richiesta (la RLS sottostante e i valori di `doc_item_links`/`doc_items` restano quelli attuali — il fix è nella lettura, non nello schema). Nessuno smoke test live sul fix in questa finestra (nessun hot-reload, vedi CLAUDE.md "Rollout di un nuovo build") — verificato solo via suite + tsc + build, come da prassi già seguita nelle sessioni precedenti per lo stesso motivo.
**Prossima sessione:** a restart di finestra, ripetere dal vivo la misura dell'auditor (progetto doc-in-db, identità senza membership) per confermare che il conteggio ora astiene invece di calcolare.

## Sessione #125 — 2026-08-27 (autopilot dispatch, GTD `057b4161`, WI `82166126`)

**Obiettivo:** Follow-on armato dalla sessione #123 — UAT-DOCM-018 aveva trovato che `working_doc` è dichiarato mai-pubblicabile solo in un commento nel codice, senza alcun test che lo eserciti (la entry SDES-DOCM-018 vieta esplicitamente questo: "un divieto non testato è un commento").
**Completato:**
- Guard tool-floor in `docPublish` (`src/subscriptions.ts`): rifiuta esplicitamente se `document.document_type==='working_doc'`, PRIMA dei controlli di legittimazione/changelog — difesa in profondità, stesso pattern già in uso per il gate changelog.
- Nuovo test in `tests/subscriptions.test.ts` che tenta `doc_publish` su un `working_doc` (anche con chiamante owner, per isolare che il blocco è sul tipo e non sulla legittimazione) e verifica: rifiuto esplicito, nessun bump di versione, nessuna riga ledger.
- `UAT-DOCM-018` aggiornato `fail`→`pass` con l'evidenza. `npm test` 231/231, `tsc`/`build` puliti.
**Decisioni prese:** nessuna.
**Blocchi / note:** limite dichiarato nel collaudo stesso — il guard è lato tool; l'enforcement dentro `gov.doc_publish()` (DB-floor) resta non verificato da qui, nessun accesso diretto al DB in questa sessione.
**Prossima sessione:** nessuna prevista per questo GTD.

## Sessione #126 — 2026-08-27 (wake cold-start, msg loomy `6e170526`, WI `d5f1a4ca`)

**Obiettivo:** GO di Achille sul rollout governance, tre blocchi: (1) chiudere UAT-DOCM-023 emendando SDES-DOCM-023 all'as-built; (2) mappare i 7 collaudi esenti ai deliverable del Programma Manifesti invece di stralciarli alla cieca (proposta a loomy prima degli esiti); (3) scrivere il capitolato del progetto board-mcp — 37 REQ senza origine per costruzione — e posare le sottoscrizioni verso i documenti esterni da cui dipendiamo.

**Fatto prima di tutto — recupero del working tree (commit `4ed4e99`):** le modifiche non committate di tre sessioni precedenti (`#req-docm-019..024`, `#124`, `#125`) erano ancora sul disco, segnalate a loomy in `#122` e mai triagiate. Verificate prima di committare: `tsc --noEmit` pulito, `npm test` **234/234** verdi, `npm run build` pulito. Contenuto: fix ISS-004 sulla description di `req_without_origin`, il fix di visibilità di `docTraceability`/`docTraceabilityOrigin` (astensione invece di gap su target invisibile) con l'estensione RLS di `tests/fakeDb.ts`, il guard `working_doc` in `docPublish`, v0.24.1.

**Blocco 1 — già chiuso, ma non nella forma richiesta.** `SDES-DOCM-023` risultava già riallineato e `UAT-DOCM-023` già `pass`/`done`, aggiornati il 27/08 alle 21:24 — **un'ora e venti prima del messaggio di loomy** (22:42), da una sessione autopilot precedente (GTD `b92ccf39`) che lo dichiara negli `attrs`. Sostanza a posto, forma no: è stata una riscrittura in place, non `amend`/`supersede` con changelog come loomy chiedeva. **Non rifatto ora, con motivo riportato:** un `doc_supersede` oggi creerebbe una riga nuova identica alla vecchia — la versione pre-emendamento non è recuperabile dal DB (`documents_history` non è atterrato, è SDES-DOCM-017, uno dei 7 esenti). Sarebbe un arco che dichiara una storia che non c'è. Attenuante misurata leggendo il testo: il corpo nuovo dedica un paragrafo alla proposta originale e al perché l'as-built la supera — non è silenzioso nel contenuto, solo privo di un arco.

**Blocco 2 — proposta, nessun esito scritto (come da mandato).** Letti i corpi di DEL-A1..A6/B1..B6/C1..C5/D1/E1 e la sezione DEC-01. Esito della proposta: **zero stralci, tutti e 7 hanno una casa** — 016→DEL-A2/WI-J · 017→DEL-A4/WI-B · 019→DEL-A4/WI-G · 021→DEL-A4/WI-G · 022→DEL-A4/WI-B · 026→**splittato** · 028→DEL-A3 (DEC-01g chiusa). Due trovate reali: (a) **la motivazione di esenzione di UAT-DOCM-022 è falsa** — dice «colonne DB non ancora richieste al dba», ma DEC-01j riporta la misura del dba del 20/08: `title`/`summary` esistono già su `doc_items` e `doc_item_history`, quindi il 022 è costruibile senza una riga di DDL; (b) **metà del 026 non ha casa** — il ritiro-senza-erede (`retired`, `doc_item_retire`, 4° `terminal_reason`) non è costruito da nessuno dei 19 deliverable letti; i due punti vicini (DEL-A2, DEL-B5) parlano del ritiro di una *pubblicazione*, non di una *riga*. Non assegnata d'ufficio: sarebbe un contratto inventato (D-136 §5), sceglie loomy fra estendere A2 o aprire una voce di disegno nuova.

**Blocco 3 — capitolato scritto, con la misura.** Documento `4d0718f3` (visibilità `org`, **`draft`** — la promozione è di loomy): 3 obiettivi, 8 deliverable (`DEL-BM-001..008`), 3 condizioni d'arresto, 1 sezione di metodo che dichiara apertamente che il documento è ricostruito a posteriori e **non introduce promesse nuove**. Le 3 condizioni d'arresto sono le tre che questo progetto ha già violato almeno una volta: schema non nostro (D-005) · nessun contratto inventato (D-136 §5) · nessuna risposta che affermi più di quanto verificato (`ok` senza rilettura · zero spacciato per assenza · silenzio al posto di un avviso). 37 requisiti ancorati via `refines`. **Misura prima/dopo:** `req_without_origin` da `gap 37/37, covered 0` a `gap 0/37, covered_total 37` (`covered_by.capitolato: 37`, `abstained: 0`).

**Trasversale — 4 sottoscrizioni posate** (tutte `module`; `critical` cross-progetto è rifiutato in v1, D-186 Q2): `SEC-BM-000`→Manifesto project-governance (`60aadae6`) · `SEC-BM-000`→Requisiti project-governance (`e658bc9f`) · `DEL-BM-006`→Requisiti doc-in-db (`668d0dca`) · `DEL-BM-006`→riga `DEL-A4` del Piano Manifesti (`d066206c`).

**Copertura collaudi misurata:** board-mcp 35 SDES / 15 coperte / **20 scoperte**; items-subscription 9 SDES / 0 coperte. Piano in 3 lotti (A: `SDES-015..026` sul costruito · B: `SDES-SUB-000..006` sottoscrizioni · escluso `SDES-SUB-007`, che è una tabella di domande aperte e non è collaudabile). Segnalata a loomy la **collisione di codici fra progetti**: `SDES-SUB-003/-006/-009/-011/-012` esistono in board-mcp e in items-subscription con contenuti diversi.

**Gap di sistema trovato:** nessuna superficie elenca i documenti di un progetto — `doc_query` filtra gli item, quindi un documento **vuoto** è indistinguibile da uno **inesistente**, e la legenda `documents` di `summary=true` copre solo i documenti attraversati dalle righe risultanti. È la stessa classe di difetto di D-167 (404 vs 403) e di `STP-BM-003`. Ha avuto un effetto concreto in questa sessione: non ho creato il documento `changelog` su doc-in-db per non rischiare un duplicato (stesso meccanismo del duplicato CFG-090 del 16/08). GTD aperto con proposta di `doc_list`, da concordare prima di costruire.

**Decisioni prese:** nessuna nuova decisione. Il capitolato resta `draft`, la proposta sui 7 esenti resta una proposta.
**Blocchi / note:** gli esiti dei 7 esenti e la correzione della motivazione del 022 attendono il via libera di loomy (GTD `db47608f`, `waiting`). Nessuno smoke test live dei tool in questa sessione oltre alle scritture reali sul DB di produzione (capitolato, link, sottoscrizioni), tutte verificate con una query di rilettura. I 2 collaudi non testabili dal nostro contesto (005 RLS, 011 trigger) sono di dba per assegnazione di loomy, non toccati.
**Prossima sessione:** al via libera di loomy, scrivere gli esiti dei 7 esenti; indipendentemente, partire col lotto A della copertura collaudi (GTD `406d6abd`) — richiede prima di creare il documento `uat` sul progetto board-mcp, che oggi non esiste.

## Sessione #127 — 2026-08-28 (wake cold-start msg loomy `8f458b5b`, WI `4bfd25e6`)

**Il wake non era il lavoro.** Il messaggio di risveglio era l'addendum modello di loomy sul task `6e170526` («i lavori di design si fanno almeno con Opus»): già soddisfatto — la window è partita su Opus 5, nessun `runtime_request` necessario — e il task stesso era già stato lavorato in `#126` (capitolato scritto, 37/37 REQ ancorati, proposta sui 7 esenti in attesa del via libera di loomy, GTD `db47608f`). Il lavoro vero era il messaggio più fresco in inbox: `ac19e421` del dba, delle 04:26.

**Prima cosa verificata, perché era un rischio di rottura live:** la migrazione dba `20260828065000` ha fatto `REVOKE UPDATE ON gov.doc_subscriptions FROM doc_rw` + `GRANT UPDATE (intent, status, tombstoned_at, note)`. Il nostro codice scrive `subscribed_at_version` **solo in INSERT** (`src/subscriptions.ts:299`), e l'INSERT non è toccato: nulla rotto, lettura del dba confermata dal nostro lato.

**Costruito — `doc_repoint` (v0.24.2, UAT-GOV-029 / REQ-GOV-102).** Tool sopra `gov.doc_subscription_repoint` (SECURITY DEFINER), l'unica porta rimasta per spostare il pin di versione. Tutti e 9 gli errori mappati dispatchando sul marcatore `E_REPOINT_*` e **non** sullo SQLSTATE (`P0002` da solo copre quattro rifiuti distinti); `DETAIL` dello `STALE_READ` passato all'utente com'è; rilettura D-132 prima di ogni `ok`; `SAVEPOINT` attorno alla chiamata perché ogni rifiuto della funzione è un RAISE che aborte la transazione e farebbe fallire anche la rilettura (bug d6a57035, già pagato una volta).

**Gap trovato che avrebbe reso il tool inerte.** `seen_version_id` è un UUID di proposito (la label `'1.0'` copre 149 righe su 166: si indovina), ma **nessuna superficie esponeva un `gov.doc_versions.id`** — né i `doc_*`, né i subscription tool (`doc_subscription_outcome` risolve la label internamente e non la restituisce). Sarebbe stato un tool che nessuno poteva chiamare: la stessa classe di difetto dell'arm senza modello dispacciabile (GTD `6bbc293b`). Chiuso nella stessa consegna: `doc_staleness_query` porta ora su ogni marcatura la tripla `subscribed_at_version` / `target_current_version` / `target_current_version_id` + `repoint_applicable`, e un `repoint_applicable:false` non è mai un `false` nudo — porta `repoint_note` col motivo.

**La misura che ha deciso il contratto (e ribaltato la proposta del dba).** Il dba chiedeva quale strada prendere per REQ-GOV-165 crit.5 («non si può chiudere il debito senza dimostrare di aver riletto il target»), preferendo la 1: `doc_staleness_close(outcome='updated')` rifiuta se la sottoscrizione non è già agganciata alla versione corrente. Misurato in produzione prima di rispondere: **143 sottoscrizioni attive su 153 (93%) puntano a un documento mai pubblicato, e 10 marcature aperte su 10** (19 documenti pubblicati su 79). Su tutte quelle il repoint è `E_REPOINT_NO_VERSION` per costruzione → il gate non renderebbe la chiusura più rigorosa, la renderebbe **impossibile**. La ragione è strutturale e vale la pena averla a verbale: la marcatura nasce da una **riga** cambiata (D-201/M2 — nessun riferimento a una pubblicazione), il pin è una **label di pubblicazione**; legare la chiusura al pin lega un fatto a grana-riga a una prova a grana-documento che nel 93% dei casi non esiste. Risposta al dba (msg `64f016e5`): la 1 **condizionata** alla disponibilità della prova (verifica il pin solo se il target ha pubblicazioni; altrimenti dichiara nell'esito che la prova non era esigibile — astensione dichiarata, come `abstained_items` e `terminal_reason`), più la proposta di usare la prova a grana giusta: `source_history_id`, **valorizzato e risolvibile su 10/10 marcature aperte** contro il 7% della prova per pubblicazione. Nessuna delle due implementata: la prima cambia il contratto di un tool in uso, la seconda aggiunge un parametro obbligatorio — non sono mie da decidere da sola (D-136 §5).

**Verifiche.** 245/245 unit test verdi (+11 nuovi: 8 su `doc_repoint`, 3 sulla tripla), `tsc` pulito, build pulita. Il fake `subscriptionRepoint` modella **anche i rifiuti** della funzione reale, non solo il percorso felice — un fake che modellasse solo l'happy path non proverebbe niente sulla mappatura. **Verifica dal vivo** (`tests/verify-repoint.ts`, 9/9): ogni prova dentro una transazione deliberatamente annullata, come ha fatto il dba per la funzione. Include il giro completo costruito e distrutto in-transazione — `doc_create` → changelog → `doc_publish 1.0` → `doc_subscribe` → `doc_publish 2.0` → `doc_repoint` — che prova la giuntura `doc_publish`→`doc_repoint` che nessun fake può provare: pin 1.0→2.0, `note` appesa e non sovrascritta, id vecchio rifiutato, no-op rifiutato, rifiuto di autorizzazione corretto su una sottoscrizione di un altro progetto. Zero residui verificati dopo (`documents`/`doc_items`/`gov.doc_subscriptions`), pin di produzione intatti.

**Decisioni prese:** nessuna nuova decisione formale. Il contratto `doc_repoint`↔`doc_staleness_close` resta una proposta al dba.
**Blocchi / note:** il primo giro di verifica live è fallito su due controlli per un difetto **del test**, non del codice — avevo scelto sottoscrizioni fuori dal progetto board-mcp, quindi il gate di autorizzazione mordeva prima di `STALE_READ`/`NOOP`; risolto costruendo lo scenario dentro il nostro progetto. Il percorso `E_REPOINT_ZERO_ROWS` (repoint concorrente) non è verificabile senza due sessioni in parallelo: non provato dal vivo, solo mappato.
**Prossima sessione:** attesa risposta dba sul contratto; indipendentemente, restano in coda il lotto A della copertura collaudi (GTD `406d6abd`, richiede prima il documento `uat` sul progetto) e i GO di loomy ancora in inbox (`e45af7dc` — instradamento `tools.ts` UAT-032 per primo, `ea6cbc7a` — 3 follow-on D-166).

## Sessione #128 — 2026-08-28 (dispatch autopilot, GTD `da9eb081`, WI `7e197e2f`)

**Task:** scorporo di UAT-DOCM-022 da WI-B (deciso in `#126`/`#127`): correggere la §Dipendenza di SDES-DOCM-022, valutare `draft→active`, costruire title/summary in doc_item_upsert/doc_query, ri-eseguire UAT-DOCM-022 a pass.

**La premessa da correggere era falsa su due punti, non uno.** Il testo di SDES-DOCM-022 diceva ancora «le colonne sono schema → dba (D-005). E la parità deve vederle: senza SDES-DOCM-014 l'aggiunta resta fuori dal gate» — la stessa premessa (falsa) già corretta su UAT-DOCM-022 in `#127`, mai propagata alla SDES gemella. Verificato dal vivo prima di scrivere codice, non solo citato: `pg_attribute` + `has_column_privilege('doc_items', col, 'SELECT'|'UPDATE')` **come ruolo `doc_rw`**, non come login role `board_doc_rw` — misurando prima come `board_doc_rw` i grant risultavano tutti `false` anche su `body`/`status`, che notoriamente funzionano; solo dopo `BEGIN; SET LOCAL ROLE doc_rw` (lo stesso wrapping di `runDocRw`) i grant sono apparsi veri. `title`/`summary` esistono su `doc_items`/`doc_item_history`, `text` nullable, grant SELECT/UPDATE pieni. Sul secondo punto: SDES-DOCM-014 copre solo colonne vincolate da CHECK (`item_type`/`status`/`relation_type`/`document_type`) — title/summary sono testo libero, fuori da quel perimetro, nessun blocco reale.

**Costruito.** `doc_item_upsert` accetta `title`/`summary` opzionali, stessa patch semantics degli altri campi (omesso→preservato, in `fields_written`/`fields_preserved`, letti indietro per il confronto D-132). `doc_query` (modo pieno, `fields=`, `summary:true`) li ritorna come colonne di primo livello; in `summary:true` l'`headline` preferisce `title`→`summary`→derivato-dal-body, e il nuovo campo `headline_source` (`'title'|'summary'|'body'`) dichiara sempre quale — la SDES vietava esplicitamente un indice che non dice se è curato o ricavato.

**Verifica in due strati, per il vincolo G4 (no hot-reload).** `npm run build` pulito, `npm test` 245/245 verde. Poi live end-to-end contro il DB reale con uno script one-off (`runDocRw` diretto, stesso path dei tool, non committato — la mia window gira ancora sul dist precedente e non lo vedrebbe): upsert title+summary su SDES-DOCM-022 stessa (dogfooding, coerente col mandato "al primo pezzo si applica la catena che impone a tutti"), rilettura con `headline_source:"title"`, campi echeggiati in modo pieno, e un controllo negativo/di regressione — una riga `sdes_entry` senza title/summary continua a cadere su `headline_source:"body"` invariato. 14/14.

**Chiuso:** SDES-DOCM-022 `draft→active`; UAT-DOCM-022 → `done`/`pass` con le 4 prove (3 positive + 1 negativa) a verbale negli `attrs.steps`; WI linkato a SDES-DOCM-022 per il gate D-074; commit `c974752` (locale, non pushato).

**Decisioni prese:** nessuna nuova decisione formale — correzione di un dato di fatto (esistenza colonne, perimetro del gate parità), non una scelta di design.
**Blocchi / note:** nessuno. Restano esplicitamente fuori scope, come dichiarato nella SDES stessa: eventuale REQ-DOCM-019 per normare la semantica d'indice (lunghezza/registro/obbligatorietà) — competenza di loomy. Nessun restart di flotta forzato: le altre window continueranno a non vedere title/summary nei tool finché non riavviano (G4, segnalato a loomy nel `board_send` di chiusura, non ho deciso io il timing).
**Prossima sessione:** nessun follow-on aperto da questo task. Restano in coda dalla `#126`/`#127`: esiti dei 7 esenti (attende GTD `db47608f`, non trovato in inbox in questa sessione — verificare stato), lotto A copertura collaudi (`406d6abd`), GO instradamento `tools.ts` (`e45af7dc`), 3 follow-on D-166 (`ea6cbc7a`) — nessuno armato in questa sessione, scope dispatch limitato al GTD `da9eb081`.

## Sessione #133 — 2026-08-29 (wake cold-start msg loomy `c473e347`, WI `98893aa2`)

**Task:** `doc_query(traceability='broken_refs')` — GTD `4f06c944`, aperto dalla richiesta di forge (msg `162add27`) e instradato da loomy con un requisito aggiuntivo: legami **generici** (non il solo asse req→sdes), distinzione RLS-aware fra bersaglio invisibile e riferimento davvero rotto, per progetto, eseguibile da ogni agente con la propria identità. Due consumatori in attesa: forge (UAT-PG-008 passo 1, GTD `2ea888f6` messo in waiting su di me) e l'auditor (condizione 11 del verdetto caso-zero).

**Misurato prima di scrivere codice, e la misura ha cambiato il contratto.** La proposta in arrivo (concordata fra forge e loomy) chiedeva la tripartizione `gap`/`abstained`/`covered` dove `gap` = «bersaglio che non esiste». Letto il DDL reale sotto `doc_rw`: **entrambe** le tabelle di legame hanno FK `ON DELETE CASCADE` su **entrambi** gli estremi (`doc_item_links_from_fk`/`_to_fk` composite su `(id, project_id)`; `doc_item_xproject_links_from_item_fkey`/`_to_item_fkey`). Il puntatore a vuoto **non può persistere**: cancellare una riga cancella i suoi legami. Quindi il `gap` chiesto è vuoto per costruzione, e — peggio — non sarebbe nemmeno misurabile: sotto RLS «cancellato» e «nascosto» tornano entrambi riga assente. Costruirlo come misura avrebbe prodotto uno zero che sembra una verifica e non lo è: esattamente il difetto che D-206 e REQ-DOCM-012/015 nominano. Riportato come `dangling:{count:0, measured:false, basis:<i nomi dei constraint>}`.

**Il difetto vero è un altro, e c'è.** Due fatti misurati sostituiscono il `gap` chiesto: (a) la policy SELECT dei legami è ancorata al **solo estremo FROM** (`loomx_can_read_document(from_item.document_id)`) — si legge un legame e non il suo bersaglio: 11 su 1214 same-project, 2 su 283 cross-progetto, dalla mia identità. Astensioni, mai gap. (b) esistono legami vivi verso righe **ritirate**: 4 verso `superseded` (nessuno con erede visibile), 24 verso `deprecated`, 2 verso `archived`. È questa la lettura onesta di «riferimento rotto» in questo corpus: il puntatore risolve, ma verso qualcosa che non è più in vigore.

**Costruito** (`docBrokenRefs` in `src/docs.ts`, v0.27.0). Unità di analisi il **legame**, non la riga — aggregare per item nasconderebbe quale arco è in colpa. `retired_statuses` (superseded/deprecated/archived/rejected) è **restituito in risposta** perché la regola resti ispezionabile e correggibile senza indovinarla; `draft`/`proposed`/`in_review` restano fuori: immaturi non è ritirato, contarli allagherebbe di falsi difetti ogni progetto giovane. Gli archi `supersedes` sono **esclusi** dalla classificazione e contati a parte (`skipped_supersedes`): puntano dal ritirato al suo erede per costruzione. `cross_project_in` è dichiarato **pavimento**, non totale.

**Il difetto trovato solo dal test.** La prima stesura asseriva che, dopo un `doc_supersede`, il riferimento citante risultasse rotto-ma-recuperabile: ha misurato 0. Causa: `doc_supersede` **ripunta** i legami preesistenti all'erede (D-133, `gov.relink_superseded`). Il percorso nominale di versionamento non lascia quindi riferimenti obsoleti — i 4 in produzione nascono da uno status cambiato **fuori** da quel percorso. Il test è stato riscritto per asserire proprio questo (nessun falso positivo sul percorso nominale) più il caso reale in un test separato: la lettura del codice da sola non l'avrebbe detto.

**Verifiche.** `tsc` pulito, build pulita, `npm test` **307/307** (7 nuovi). Dal vivo contro il DB di produzione (`tests/verify-broken-refs.ts`, 13/13, read-only): identità aritmetiche asserite (`ok+broken+abstained === classified`, `classified+skipped === scanned`) e numeri confrontati con la misura SQL indipendente presa **prima** del codice — board-mcp 151 classificati / 0 rotti; project-governance (il progetto di forge) 724 classificati / **26 rotti** = 24 `deprecated` + 2 `superseded` senza erede. La verifica è girata da `tsx` sul **sorgente**, non dai tool MCP della window: vincolo G4, `dist` rigenerato a finestra viva la lascia in stato misto.

**Decisioni prese:** nessuna decisione formale. La deviazione dalla forma concordata (niente `gap` per bersaglio inesistente, sostituito da `dangling` strutturale + `broken` per riga ritirata) è motivata dal DDL, non è una scelta di gusto — riportata a loomy e ai due consumatori.
**Blocchi / note:** `doc_item_gtd_links`/`doc_item_wi_links` restano fuori copertura, dichiarato: `doc_rw` non può leggere `loomx_items`/`loomx_work_items` (`42501` misurato), e un legame verso un GTD **soft-deleted** (`deleted_at`, che la FK non intercetta) sarebbe un riferimento rotto vero e oggi invisibile. Ereditato e non risolto qui: su un `project_id` **inesistente** la risposta porta `visibility_gap:true` — falso positivo già tracciato (GTD `89c232d4`).
**Prossima sessione:** avvisare forge e auditor è parte di questa chiusura; il restart di flotta per esporre `broken_refs` via MCP alle altre window non è deciso da me (G4, segnalato a loomy).

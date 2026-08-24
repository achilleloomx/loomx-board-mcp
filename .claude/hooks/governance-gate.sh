#!/usr/bin/env bash
# governance-gate.sh — PreToolUse hook per enforcement Work Items (D-024)
#
# Uso:
#   bash governance-gate.sh --agent <slug> [--mcp-mode] [--external] [--bash]
#
# Letto da .claude/settings.json PreToolUse. Viene invocato prima di ogni
# Edit/Write/MultiEdit/NotebookEdit, di ogni MCP write, e di ogni Bash (--bash:
# il gate ispeziona il comando e applica il WI check solo a write/external).
#
# Exit codes (spec hook Claude Code — SOLO exit 2 blocca il tool):
#   0 = OK, tool puo procedere
#   2 = BLOCK, tool non procede (stderr mostrato all'agente)
#   1 = errore non-bloccante (mai usato per enforcement)
#
# v1.1 (2026-07-02, remediation governance WI afd24663):
#   - exit 1 -> exit 2 su tutti i branch di blocco (prima il gate era fail-open)
#   - modalita --bash: enforcement bash_commands external + scritture via shell
#   - tool_uses counter best-effort (non aborta il gate sotto set -e)
# v1.2 (2026-07-18, fix WI ccde9d50 — race self-modifica cache):
#   - flock sull'intera esecuzione del gate: serializza hook paralleli, elimina
#     i falsi BLOCK "status=done" da letture concorrenti della cache
#   - mktemp nella STESSA directory di WI_CACHE (prima era /tmp: su filesystem
#     diverso `mv` degrada a copy+unlink NON atomico -> finestra di file vuoto/
#     troncato leggibile dagli hook concorrenti)
#   - WRITE_RE non triggera piu su redirezioni innocue (2>/dev/null, 2>&1, ecc.)
# v1.3 (2026-07-22, fix GTD 138a9e59 — clobber cross-window):
#   - whitelist post-chiusura (sezione 2) estesa a wi_checkpoint/wi_end/
#     doc_item_upsert: WI_CACHE e' keyed solo per agent_slug (non per WI/
#     sessione), quindi due window dello stesso agente si clobberano la cache.
#     Se una window chiude il proprio WI (status=done in cache) mentre
#     un'altra window, con un WI DIVERSO regolarmente active a DB, prova a
#     chiudere IL PROPRIO, veniva bloccata perche' questi 3 tool non erano
#     nella whitelist post-close. Fix minimale (non DB round-trip): questi
#     tool sono di per se' azioni di chiusura/checkpoint — lasciarli passare
#     su cache stale e' innocuo (nel caso peggiore un checkpoint/end ridondante
#     sul WI sbagliato in cache, non una scrittura di governance saltata) ed
#     e' lo stesso principio gia' applicato a gtd_update/board_send/wi_start.
#     Root cause strutturale (cache non per-sessione) resta aperta — tracciata
#     separatamente, non risolta da questa patch.
# v1.4 (2026-07-23, fix P1 Achille — CACHE_DIR relativo, blocco forge b575b2e1):
#   - CACHE_DIR era ".claude/cache" (path RELATIVO alla cwd della bash
#     persistente). Un agente che fa `cd` fuori dalla project root (es. forge
#     in packages/app-kit) fa perdere al hook il file WI_CACHE al path
#     relativo -> crash prima degli echo -> harness tratta come errore/block
#     -> tutte le write bloccate. Fix: CACHE_DIR ora risolto come ASSOLUTO da
#     CLAUDE_PROJECT_DIR se presente, altrimenti self-locating dalla posizione
#     dello script stesso (hooks/ -> .. -> project root). Il hook funziona
#     ora indipendentemente dalla cwd del chiamante.
#   - Effetto collaterale voluto: chiude anche il buco no-op silenzioso su
#     window con CLAUDE_PROJECT_DIR vuoto (GTD 582de253) — con path
#     self-locating il gate torna a trovare la cache e ad enforceare davvero.
# v1.5 (2026-07-30, EVAL-it-manager-002 / §6b stress-test 2026-07-29, GO+sign-off
#   loomy msg 82ba0efd/fd40bfeb, D-105):
#   - sezione 2, ramo "jq non installato": WARN+exit 0 (fail-open) -> BLOCK+exit 2
#     (fail-closed). Se jq manca il gate non puo' validare le pre_conditions del
#     WI attivo (sezione 4 dipende da jq) e quindi non puo' garantire enforcement:
#     lasciar passare era un bypass totale indipendente dal contenuto della
#     cache, residuo mai convertito dall'intento dichiarato in v1.1 ("prima il
#     gate era fail-open"). Nessun agente della flotta impattato al deploy (jq
#     presente ovunque, verificato) — chiude un fail-mode teorico/futuro.
# v1.6 (2026-07-30, EVAL-forge-005 + verifica loomy msg 391ed53c, GTD afe3e5c7):
#   il v1.5 aveva chiuso il path edit/write (37/37 verificato) ma introdotto/
#   lasciato scoperti due difetti nuovi, entrambi isolati da forge (74 casi):
#   - difetto A (sezione 0.5, LIVE su tutti i 37 gate): `exec 9>"$LOCK_FILE"
#     2>/dev/null` e' `exec` senza comando -> il redirect di stderr diventa
#     PERMANENTE per il resto dello script, quindi ogni cat >&2 di BLOCK (incl.
#     il fail-closed appena aggiunto in v1.5) veniva scritto nel nulla. Fix:
#     testa la scrivibilita' del lock file con un redirect scoped alla riga
#     (`: > "$LOCK_FILE" 2>/dev/null`), poi fai l'exec vero senza sopprimere
#     stderr.
#   - difetto B (sezione 0, modalita' --bash): senza jq, BASH_CMD restava
#     sempre vuoto e l'early-exit "permissive" scattava PRIMA di arrivare al
#     fail-closed di sezione 2 -> passavano ungoverned i comandi external
#     (git push, npm publish, supabase db push, vercel --prod) proprio quando
#     mancava la capacita' di giudicarli. Fix: jq assente -> BLOCK immediato in
#     sezione 0 (stesso principio v1.5); solo un payload vuoto/non ispezionabile
#     con jq presente resta permissive.
# v1.7 (2026-08-17, fix testo GTD 4f05821c / board msg b4ff5966, it-manager):
#   il messaggio di BLOCK sul ramo done/failed attribuiva SEMPRE la causa alla
#   skill session-manager v2 ("la cache non e' stata aggiornata correttamente
#   dalla skill session-manager v2") anche quando l'agente chiamava i tool
#   wi_* direttamente (nessuna skill in gioco) — diagnosi fuorviante, stessa
#   famiglia dell'errore "document not found, crealo" girato a board-mcp lo
#   stesso giorno. Root cause vera (fixata separatamente in loomx-board-mcp
#   src/wiCache.ts): syncWiCache mirrava il WI piu' recente per started_at,
#   non quello effettivamente active — un wi_resume su un WI piu' vecchio di
#   un WI gia' chiuso restava scavalcato dal chiuso. Testo ora generico
#   (rimanda a wi-status/wi-resume/wi-switch), niente colpa pre-assegnata.
#
# Spec: hub/initiatives/governance-compliance/design.md sezione 6
#
# NOTE sulla versione iniziale:
# - Implementazione minimale-ma-funzionale (no parsing YAML complesso, no dipendenze esterne oltre jq)
# - Richiede jq installato (gia presente in ambiente Windows/Git Bash standard LoomX)
# - Politica: legge SOLO la cache locale (no round-trip DB per latency)
# - La cache e' scritta da board-mcp (src/wiCache.ts) su ogni wi_start/wi_end/
#   wi_pause/wi_resume/wi_checkpoint/wi_link_template/wi_switch, indipendentemente
#   da quale skill (se alcuna) ha chiamato il tool.

set -euo pipefail

# ------------------------------------------------------------------------------
# Hook payload (Claude Code passes tool_name + tool_input as JSON via stdin)
# Read once here; used later for GENERATED .md guard (section 5.5).
# Non-blocking: if stdin is a TTY (manual call) or empty, HOOK_INPUT stays "".
# ------------------------------------------------------------------------------
HOOK_INPUT=""
if [[ ! -t 0 ]]; then
  HOOK_INPUT=$(timeout 1 cat 2>/dev/null) || HOOK_INPUT=""
fi

# ------------------------------------------------------------------------------
# Args parsing
# ------------------------------------------------------------------------------
AGENT_SLUG=""
MCP_MODE=false
EXTERNAL=false
BASH_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT_SLUG="$2"
      shift 2
      ;;
    --mcp-mode)
      MCP_MODE=true
      shift
      ;;
    --external)
      EXTERNAL=true
      shift
      ;;
    --bash)
      BASH_MODE=true
      shift
      ;;
    *)
      echo "governance-gate: arg sconosciuto: $1" >&2
      shift
      ;;
  esac
done

if [[ -z "$AGENT_SLUG" ]]; then
  echo "governance-gate: --agent <slug> obbligatorio (settings.json malconfigurato)" >&2
  exit 2
fi

# ------------------------------------------------------------------------------
# 0. Bash mode: applica il gate solo a comandi write/external
# ------------------------------------------------------------------------------
# I comandi bash di sola lettura (ls, cat, grep, git status...) passano senza WI.
# Il WI check scatta per: comandi external (deploy/push/publish, da
# hub/governance-policy.yaml sezione external.bash_commands) e scritture shell
# (redirect, sed -i, rm/mv/cp, tee, psql/curl mutanti).
if [[ "$BASH_MODE" == "true" ]]; then
  # v1.6 (2026-07-30, fix defect B — GTD afe3e5c7, segnalato loomy msg 391ed53c):
  # senza jq, BASH_CMD restava sempre vuoto e la riga sotto usciva 0 PRIMA del
  # fail-closed di sezione 2 -> con jq assente passavano ungoverned esattamente
  # i comandi external (git push, npm publish, supabase db push, vercel --prod)
  # che questa sezione esiste per intercettare. jq assente e payload vuoto sono
  # due casi diversi: solo il secondo resta permissive.
  if ! command -v jq &>/dev/null; then
    cat >&2 <<'EOF'
[governance-gate BLOCK]

jq non installato — modalita' --bash non puo' ispezionare tool_input.command,
quindi non puo' distinguere un comando read-only da uno external/write (git
push, npm publish, supabase db push, vercel --prod, ...). Fail-closed (non
fail-open): installa jq oppure segnala it-manager/DBA se l'ambiente e'
strutturalmente privo di jq.
EOF
    exit 2
  fi

  BASH_CMD=""
  if [[ -n "$HOOK_INPUT" ]]; then
    BASH_CMD=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
  fi
  # Payload vuoto/non ispezionabile (jq presente, ma niente da leggere): permissive
  [[ -z "$BASH_CMD" ]] && exit 0

  EXTERNAL_RE='git push|git push --force|supabase (db push|functions deploy|secrets set)|vercel (--prod|deploy)|npm publish|gh release|systemctl (restart|stop|disable)|docker (push|rm)'
  WRITE_RE='(^|[^>])>>?[[:space:]]*[^&[:space:]]|sed[[:space:]]+-i|\btee\b|\brm[[:space:]]|\bmv[[:space:]]|\bcp[[:space:]]|mkdir|chmod|chown|truncate|\bln[[:space:]]|psql .*(-c|-f)|curl .*-(X[[:space:]]*(POST|PUT|PATCH|DELETE)|d[[:space:]])|python[0-9.]*[[:space:]].*(setup|install)|pip[0-9.]*[[:space:]]+install|npm[[:space:]]+(install|ci)|git[[:space:]]+(commit|merge|rebase|reset|checkout[[:space:]]+-b|cherry-pick|tag)'
  # Redirezioni innocue (fd-dup, /dev/null) NON sono scritture "gated": ripulisci
  # prima di matchare WRITE_RE, altrimenti `2>/dev/null` triggera un falso BLOCK.
  NOISE_RE='[0-9]?>>?&?[0-9]?[[:space:]]*/dev/null|[0-9]>&[0-9]'
  BASH_CMD_CLEAN=$(echo "$BASH_CMD" | sed -E "s#$NOISE_RE##g")

  if echo "$BASH_CMD" | grep -qE "$EXTERNAL_RE"; then
    EXTERNAL=true   # prosegue: richiede WI attivo + segnala external
  elif echo "$BASH_CMD_CLEAN" | grep -qE "$WRITE_RE"; then
    :               # scrittura via shell: prosegue col WI check standard
  else
    exit 0          # bash read-only: nessun gate
  fi
fi

# ------------------------------------------------------------------------------
# Paths — risolti come ASSOLUTI, indipendenti dalla cwd del chiamante (v1.4).
# Priorita': CLAUDE_PROJECT_DIR (se valorizzato dall'harness) > self-locating
# dalla posizione dello script (questo file vive in <project-root>/.claude/hooks/).
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$SCRIPT_DIR}"
CACHE_DIR="$PROJECT_ROOT/.claude/cache"
WI_CACHE="$CACHE_DIR/current-work-item.json"

# ------------------------------------------------------------------------------
# 0.5 Lock: serializza le esecuzioni concorrenti del gate (fix WI ccde9d50).
# Senza questo, due tool gated in parallelo possono leggere/scrivere WI_CACHE
# a cavallo l'uno dell'altro (self-modifica non atomica in sezione 6) e vedere
# uno stato transitoriamente vuoto/stale -> falso BLOCK "status=done" col DB
# active. flock sull'intero gate (fd 9, rilasciato all'uscita del processo)
# rende read-status + increment-counter una sezione critica unica. Timeout
# breve: se flock non e disponibile o il lock e contended troppo a lungo, il
# gate prosegue permissivo invece di bloccare in deadlock.
# ------------------------------------------------------------------------------
mkdir -p "$CACHE_DIR" 2>/dev/null || true
LOCK_FILE="$CACHE_DIR/.governance-gate.lock"
if command -v flock &>/dev/null; then
  # v1.6 (2026-07-30, fix defect A — GTD afe3e5c7, segnalato loomy msg 391ed53c):
  # `exec 9>"$LOCK_FILE" 2>/dev/null` ridirigeva stderr in modo PERMANENTE per
  # tutto il resto dello script (exec senza comando applica i redirect alla
  # shell corrente) -> ogni BLOCK successivo (sezioni 1-4) veniva scritto nel
  # nulla, su tutti i gate deployati. Il fd 9 sul lock file DEVE restare aperto
  # per tutta l'esecuzione (e' il punto della flock) ma stderr no: si testa
  # prima la scrivibilita' del lock file con un redirect scoped alla singola
  # riga (non exec), poi si fa l'exec vero senza sopprimere stderr.
  if : > "$LOCK_FILE" 2>/dev/null; then
    exec 9>"$LOCK_FILE"
    flock -w 2 9 2>/dev/null || true
  fi
fi

# ------------------------------------------------------------------------------
# 1. Verifica WI cache esiste
# ------------------------------------------------------------------------------
if [[ ! -f "$WI_CACHE" ]]; then
  cat >&2 <<EOF
[governance-gate BLOCK]

Nessun Work Item attivo per agente '$AGENT_SLUG'.

Prima di eseguire scritture persistenti (codice, docs, DB, messaggi), DEVI
aprire un Work Item:

  wi-start --gtd-id <uuid>                    # se il GTD esiste gia'
  wi-start --new --intent "..." --template <name>   # nuovo GTD + WI
  wi-start --emergency --reason "..."         # bypass per emergenze (audit follow-up)
  wi-start --read-only-session                # dichiara sessione esplorativa

Vedi: hub/initiatives/governance-compliance/design.md sezione 5.
Spec governance: D-024.
EOF
  exit 2
fi

# ------------------------------------------------------------------------------
# 2. Verifica WI status attivo
# ------------------------------------------------------------------------------
if ! command -v jq &> /dev/null; then
  cat >&2 <<'EOF'
[governance-gate BLOCK]

jq non installato — il gate non puo' validare le pre_conditions del Work Item
attivo, quindi non puo' garantire che le scritture siano governate. Fail-closed
(non fail-open): installa jq oppure segnala it-manager/DBA se l'ambiente e'
strutturalmente privo di jq.
EOF
  exit 2
fi

# Difesa in profondita' oltre al lock: se jq non riesce a parsare la cache
# (letta a meta' scrittura da un hook concorrente pre-fix, o su ambienti senza
# flock), ritenta un paio di volte prima di trattare lo stato come "unknown"
# e bloccare. Un file valido si stabilizza in pochi ms.
WI_STATUS="unknown"
for _attempt in 1 2 3; do
  if WI_STATUS=$(jq -r '.status // "unknown"' "$WI_CACHE" 2>/dev/null); then
    [[ "$WI_STATUS" != "unknown" || $_attempt == 3 ]] && break
  else
    WI_STATUS="unknown"
  fi
  sleep 0.05
done
WI_ID=$(jq -r '.id // "unknown"' "$WI_CACHE" 2>/dev/null || echo "unknown")
WI_INTENT=$(jq -r '.intent // ""' "$WI_CACHE" 2>/dev/null || echo "")

case "$WI_STATUS" in
  active|emergency|exempt)
    # OK, procede a verifica pre-conditions
    ;;
  paused|done|failed)
    # Whitelist post-chiusura (D-069 two-phase close + summary D-014):
    # dopo wi_end (incl. status=waiting -> WI.status=paused) o wi_pause sono
    # legittimi SOLO gli step di chiusura/segnalazione — arm GTD, summary a
    # loomy, runtime_request. Tutto il resto resta bloccato. Fix GTD 8056c224
    # (2026-07-21): il ramo 'paused' bloccava runtime_request/board_send anche
    # subito dopo un wi_end(status=waiting) regolare, rompendo la sequenza di
    # chiusura obbligatoria D-058/§0ter (la window restava appesa).
    # Fix GTD 138a9e59 (2026-07-22, v1.3): aggiunti wi_checkpoint/wi_end/
    # doc_item_upsert — clobber cross-window della cache (keyed solo per
    # agent_slug) bloccava la chiusura pulita del PROPRIO WI (active a DB)
    # quando un'altra window dello stesso agente aveva appena scritto
    # status=done/paused nella cache condivisa.
    POST_CLOSE_TOOL=""
    if command -v jq &>/dev/null && [[ -n "$HOOK_INPUT" ]]; then
      POST_CLOSE_TOOL=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
    fi
    case "$POST_CLOSE_TOOL" in
      mcp__board__gtd_update|mcp__board__gtd_complete|mcp__board__board_send|mcp__board__runtime_request|mcp__board__wi_start|mcp__board__wi_checkpoint|mcp__board__wi_end|mcp__board__doc_item_upsert)
        echo "[governance-gate] WI $WI_STATUS — consentito solo step di chiusura D-069/D-014: $POST_CLOSE_TOOL" >&2
        exit 0
        ;;
    esac
    if [[ "$WI_STATUS" == "paused" ]]; then
      cat >&2 <<EOF
[governance-gate BLOCK]

Work Item corrente e in pausa (status=paused).

WI id: $WI_ID
Intent: $WI_INTENT

Prima di scrivere, riprendi il WI con:
  wi-resume $WI_ID

Oppure aprine uno nuovo con wi-start.
EOF
    else
      cat >&2 <<EOF
[governance-gate BLOCK]

Work Item corrente e gia chiuso (status=$WI_STATUS).

La cache locale (.claude/cache/current-work-item.json) non riflette lo stato
reale in DB. Verifica con:
  wi-status

Se in DB risulta un WI diverso attivo o in pausa, riallinea con:
  wi-resume <id>      # se paused
  wi-switch <id> ...   # per riallineare la cache al volo

Altrimenti apri un nuovo WI con:
  wi-start --new --intent "..."

Se wi-status mostra un WI 'active' MENTRE questo messaggio appare (cache e DB
in disaccordo), e' un falso positivo noto (GTD 4f05821c) — segnala a it-manager.
EOF
    fi
    exit 2
    ;;
  *)
    echo "[governance-gate BLOCK] WI cache ha status sconosciuto: $WI_STATUS" >&2
    exit 2
    ;;
esac

# ------------------------------------------------------------------------------
# 3. Verifica agent_slug della cache coincide con --agent
# ------------------------------------------------------------------------------
WI_AGENT=$(jq -r '.agent_slug // ""' "$WI_CACHE" 2>/dev/null || echo "")
if [[ -n "$WI_AGENT" && "$WI_AGENT" != "$AGENT_SLUG" ]]; then
  cat >&2 <<EOF
[governance-gate BLOCK]

Mismatch agent_slug: WI cache dice '$WI_AGENT', hook invocato per '$AGENT_SLUG'.

Possibile causa: cache stale da altra sessione. Esegui:
  wi-status         # per verificare
  wi-end            # se il WI non e piu rilevante
  wi-start --new    # per aprirne uno nuovo
EOF
  exit 2
fi

# ------------------------------------------------------------------------------
# 4. Verifica pre_conditions required (se status=active)
# ------------------------------------------------------------------------------
# Emergency / exempt bypassano questo check.
if [[ "$WI_STATUS" == "active" ]]; then
  # Lista required da pre_conditions.required (array di stringhe)
  REQUIRED_LIST=$(jq -r '.pre_conditions.required // [] | .[]' "$WI_CACHE" 2>/dev/null || echo "")

  MISSING=()
  while IFS= read -r field; do
    [[ -z "$field" ]] && continue
    VAL=$(jq -r --arg f "$field" '.pre_conditions[$f] // empty' "$WI_CACHE" 2>/dev/null || echo "")
    if [[ -z "$VAL" || "$VAL" == "null" ]]; then
      MISSING+=("$field")
    fi
  done <<< "$REQUIRED_LIST"

  if [[ ${#MISSING[@]} -gt 0 ]]; then
    cat >&2 <<EOF
[governance-gate BLOCK]

Pre-conditions mancanti per il WI attivo:
$(printf '  - %s\n' "${MISSING[@]}")

WI id: $WI_ID
Intent: $WI_INTENT

Compila le pre-conditions PRIMA di scrivere. Usa:
  wi-update <field> <value>

Oppure, se l'urgenza lo giustifica:
  wi-start --emergency --reason "..."   # bypass con audit follow-up
EOF
    exit 2
  fi
fi

# ------------------------------------------------------------------------------
# 5. External actions: richiedi conferma utente (marker per Claude Code)
# ------------------------------------------------------------------------------
# Claude Code ha gia il permission system per --external. Il hook qui segnala
# al modello che siamo in modalita external perche compaia nella UX.
if [[ "$EXTERNAL" == "true" ]]; then
  echo "[governance-gate] Azione external detected (WI attivo $WI_ID). Richiedo conferma utente." >&2
  # NON blocco, lascio che il permission prompt del harness gestisca.
fi

# ------------------------------------------------------------------------------
# 5.5. GENERATED .md guard (D-a5 — avvisa su scritture dirette a mirror DB)
# Non blocca: è un avviso educational. Il lint CI (@loomx/doc-render) è il gate.
# ------------------------------------------------------------------------------
if command -v jq &>/dev/null && [[ -n "$HOOK_INPUT" ]]; then
  HOOK_FILE=$(printf '%s' "$HOOK_INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
  if [[ -n "$HOOK_FILE" && -f "$HOOK_FILE" ]]; then
    FIRST_LINE=$(head -1 "$HOOK_FILE" 2>/dev/null || echo "")
    if [[ "$FIRST_LINE" == "<!-- GENERATED"* ]]; then
      cat >&2 <<'GENERATED_WARN'
[governance-gate WARN] ⚠ File GENERATED rilevato (D-a5 — mirror DB).

Questo file è generato da @loomx/doc-render. NON modificarlo direttamente:
il lint CI rileverà il checksum mismatch e fallirà.

Per aggiornare il contenuto:
  1. Scrivi nel DB → doc_item_upsert(project_id, code, body, ...) via board-mcp
  2. Rigenera il mirror → loomx-doc-dump --document-id <uuid> --output <file>

Il lint puoi eseguirlo ora: npx tsx hub/forge/packages/doc-render/bin/lint.ts
GENERATED_WARN
    fi
  fi
fi

# ------------------------------------------------------------------------------
# 6. Increment in_flight_state.tool_uses (best-effort)
# ------------------------------------------------------------------------------
# tool_uses conta OGNI chiamata gated (Edit/Write/MultiEdit/NotebookEdit + MCP
# write + Bash write) — un'euristica di attivita', volutamente piu' larga di
# files_touched. files_touched/lines_changed NON sono piu' a discrezione
# dell'agente (F1 decision-enforcement, loomy msg b7975288, 2026-08-14): li
# popola automaticamente wi_instrument.py, un hook separato — PostToolUse su
# Edit/Write/MultiEdit/NotebookEdit (record, legge tool_input.file_path/
# notebook_path dal payload che l'hook RICEVE GIA' — usato qui sotto in 5.5 per
# il GENERATED guard) e PreToolUse su wi_checkpoint/wi_end/wi_pause (sync,
# spinge la cache locale nel DB prima che il WI chiuda). Vedi hub/scripts/
# wi_instrument.py. Questo script resta cosi' com'e' — non duplica quella
# logica, aggiunge solo il counter qui sotto.
# mktemp NELLA STESSA DIRECTORY di WI_CACHE (non /tmp): garantisce che la `mv`
# sia una rename atomica sullo stesso filesystem, non un copy+unlink cross-device
# (che lascerebbe una finestra di file parziale/assente leggibile da un altro
# hook in corsa). Combinato col lock in 0.5, l'intera read+increment+write e'
# ora una sezione critica.
TMP=$(mktemp "$CACHE_DIR/.current-work-item.XXXXXX.json") || true
if [[ -n "${TMP:-}" ]]; then
  { jq '.in_flight_state.tool_uses = ((.in_flight_state.tool_uses // 0) + 1)' "$WI_CACHE" > "$TMP" && mv "$TMP" "$WI_CACHE"; } 2>/dev/null || rm -f "$TMP" 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 7. OK
# ------------------------------------------------------------------------------
exit 0

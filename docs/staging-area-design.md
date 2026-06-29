# Design: Staging Area File Condiviso tra Agenti

**Data:** 2026-06-28  
**Autore:** board-mcp (autopilot)  
**GTD:** `91435dfc-a8d2-4c26-a156-c70a6aa75fe7`  
**Status:** PROPOSTA — in attesa review Loomy/Achille  
**Tags:** design, board-platform, context-optimization

---

## 1. Problema

Il canale di comunicazione inter-agente attuale (board_messages) è ottimizzato per **metadati e istruzioni**, non per trasferimento di payload grandi. Il D-020 (preview mode) ha ridotto il token overhead di inbox e overview, ma non risolve il caso in cui un agente produce un artefatto (report, JSON, context dump) che un altro agente deve consumare integralmente.

**Scenari non serviti oggi:**
- `board-mcp` produce un report di audit (10-50KB) da passare a `loomy` per review
- `app` prepara un dataset strutturato che `analyst-*` deve analizzare
- `forge` genera codice da consegnare a `dev-*` senza spammare il body del messaggio
- Un agente vuole esternalizzare contesto pesante per alleggerire la propria window

**Workaround attuali (tutti sub-ottimali):**
1. Body enorme nel board_send → supera il token budget del recipient, richiede salvataggio su file locale (vedi sessione app 2026-04-19, incidente 132K chars)
2. Scrittura file nel filesystem locale → nessun agente condivide il filesystem (isolamento Docker D-019)
3. Allegato come link a un documento esterno → richiede infrastruttura fuori scope

---

## 2. Vincoli di design

| Vincolo | Fonte | Impatto |
|---|---|---|
| ACL deve usare `session_user`, non `auth.uid()` | RLS design §4.2 approvato D-019 | Esclude Supabase Storage nativa |
| Ruoli Postgres nativi per agente (`NOINHERIT`, `NOBYPASSRLS`) | RLS design §4.2 | RLS deve basarsi su `session_user` |
| Nessuna dipendenza esterna nuova se evitabile | CLAUDE.md §Stack | Preferire soluzione in-DB |
| Agenti isolati in container Docker separati | D-019 §4.4 | Nessun filesystem condiviso |
| Context-optimization: lista senza body, body on-demand | D-020 | Tool `staging_list` senza content |
| Schema `loomx_*` → DBA owner, board-mcp solo layer MCP | D-005 / CLAUDE.md | Serve PR al DBA per lo schema |

---

## 3. Opzioni architetturali valutate

### Opzione A — `loomx_staging` table in Supabase (RACCOMANDATA)

Tabella Postgres `loomx_staging` con content come `TEXT` (o `BYTEA` per binario), RLS su `session_user`.

**Schema proposto:**
```sql
CREATE TABLE loomx_staging (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_slug    TEXT        NOT NULL,        -- chi ha caricato (session_user al INSERT)
  recipients    TEXT[]      NOT NULL DEFAULT '{}', -- [] = visible a tutti gli agenti
  filename      TEXT        NOT NULL,
  content_type  TEXT        NOT NULL DEFAULT 'text/plain',
  content       TEXT        NOT NULL,        -- payload (max ~1MB applicativo)
  description   TEXT,                        -- opzionale: cosa contiene
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  downloaded_at TIMESTAMPTZ,                 -- NULL finché nessuno lo legge
  deleted_at    TIMESTAMPTZ                  -- soft delete
);

-- RLS
ALTER TABLE loomx_staging ENABLE ROW LEVEL SECURITY;

-- INSERT: solo il proprio slug come owner
CREATE POLICY staging_insert ON loomx_staging FOR INSERT
  WITH CHECK (owner_slug = session_user);

-- SELECT: owner, recipient esplicito, o broadcast (recipients = '{}')
CREATE POLICY staging_select ON loomx_staging FOR SELECT
  USING (
    deleted_at IS NULL
    AND expires_at > NOW()
    AND (
      owner_slug = session_user
      OR session_user = ANY(recipients)
      OR recipients = '{}'
    )
  );

-- DELETE (soft): solo owner
CREATE POLICY staging_delete ON loomx_staging FOR UPDATE
  USING (owner_slug = session_user)
  WITH CHECK (owner_slug = session_user);
```

**MCP Tool set (4 tool):**

| Tool | Descrizione | DB |
|---|---|---|
| `staging_put` | Carica un artefatto (content, filename, recipients opzionali, ttl_hours) → ritorna `staging_id` | INSERT |
| `staging_get` | Legge il content completo di un artefatto (by id) — aggiorna `downloaded_at` | SELECT + UPDATE |
| `staging_list` | Lista artefatti accessibili (senza content — meta only, preview mode D-020) | SELECT |
| `staging_delete` | Soft-delete (imposta `deleted_at`) — solo owner | UPDATE |

**Pattern d'uso tipico:**
```
[forge] staging_put(filename="report.json", content="...", recipients=["loomy"])
    → staging_id: "abc-123"
[forge] board_send(to="loomy", subject="Report pronto", body="Vedi staging abc-123")
[loomy] staging_get(id="abc-123") → content completo
```

**Pro:**
- ✅ RLS nativa con `session_user` — allineata al design D-019
- ✅ Nessuna dipendenza esterna (stesso Supabase esistente)
- ✅ Schema nel namespace `loomx_*` — DBA owner, consistent
- ✅ ACL flessibile: broadcast (recipients=[]) o targeted
- ✅ TTL auto-expiry
- ✅ Audit trail nativo (downloaded_at, created_at)
- ✅ Preview mode list senza content (pattern D-020)

**Contro:**
- ❌ Supabase free tier ha limiti DB size — non adatto a file binari grandi (>5MB)
- ❌ TEXT in Postgres non è ottimale per content binario (base64 workaround)
- ❌ Richiede PR al DBA per la migration

**Limite raccomandato:** 1MB per artefatto (enforced a livello MCP tool, non DB). Sopra 1MB → Opzione D (futuro).

---

### Opzione B — Filesystem condiviso (Docker volume)

Un volume Docker montato in ogni container agente su `/shared/staging/` con struttura `by-recipient/<slug>/` e `by-owner/<slug>/`.

**Pro:**
- I/O veloce locale
- Nessun limite di dimensione
- Supporto nativo binario

**Contro:**
- ❌ Richiede orchestrazione Docker (D-019 non ancora implementato su tutti gli agenti)
- ❌ Nessuna integrazione con RLS Postgres — ACL gestita via POSIX permissions (unix) → non usa `session_user`, fuori dalla security model approvata
- ❌ Non funziona nella modalità attuale (stdio, non containerizzata)
- ❌ Audit trail zero
- ❌ Dipendente da docker-compose o k8s per il volume sharing
- ❌ Introduce un single point of failure (volume manager)

**Verdict:** scartata. Richiede infrastruttura non ancora pronta + non allineata RLS.

---

### Opzione C — Supabase Storage (bucket condiviso)

Un bucket Supabase Storage con policy RLS per agente.

**Pro:**
- Ottimizzato per file (CDN, streaming, multipart)
- Supporto binario nativo
- Integrato con Supabase ecosystem

**Contro:**
- ❌ **Incompatibile con il vincolo critico**: Supabase Storage usa esclusivamente `auth.uid()` nelle policy RLS — non supporta `session_user` (le policy di Storage girano sopra le API REST Supabase, non su connessione Postgres diretta)
- ❌ Richiederebbe che gli agenti abbiano JWT token (Opzione A del design RLS, scartata in D-019)
- ❌ Un nuovo servizio separato con un proprio layer auth da gestire

**Verdict:** esclusa per design constraint esplicita nel GTD. Non possibile con la RLS architecture approvata.

---

### Opzione D — Object storage esterno (S3/Cloudflare R2)

Un bucket S3-compatible con credenziali per-agente (IAM role o access key).

**Pro:**
- Ottimale per file grandi e binari
- Economico e scalabile
- Nessun limite di dimensione pratica

**Contro:**
- ❌ Nuova dipendenza esterna (violerebbe il principio "nessuna dipendenza non necessaria" CLAUDE.md)
- ❌ ACL gestita via IAM, non via `session_user` Postgres → isolata dalla security model DB
- ❌ Credenziali per-agente da gestire separatamente (Bitwarden per ogni agente)
- ❌ Overhead operativo sproporzionato per il caso d'uso attuale

**Verdict:** da considerare solo se il limite 1MB dell'Opzione A diventa un bottleneck reale. Non ora.

---

## 4. Raccomandazione

**Opzione A (`loomx_staging` table)** è la scelta corretta per la Fase 1.

Motivazione principale: è l'unica opzione che rispetta tutti i vincoli simultaneamente — in particolare la constraint RLS (`session_user`), l'assenza di dipendenze esterne, e la compatibilità con l'architettura attuale (stdio, pre-Docker).

La Fase 2 (Docker D-019 rollout + eventuale File grande > 1MB) può evolvere verso Opzione D con storage esterno, mantenendo la stessa interfaccia MCP (`staging_put/get/list/delete`) ma cambiando il backend — il design tool-layer è stabile indipendentemente dal backend.

---

## 5. Schema dettagliato (proposta al DBA)

```sql
-- Migration: 2026XXXX_loomx_staging.sql
-- Owner: DBA (namespace loomx_*)
-- Richiedente: board-mcp

CREATE TABLE IF NOT EXISTS loomx_staging (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_slug    TEXT        NOT NULL,
  recipients    TEXT[]      NOT NULL DEFAULT '{}',
  filename      TEXT        NOT NULL,
  content_type  TEXT        NOT NULL DEFAULT 'text/plain',
  content       TEXT        NOT NULL,
  description   TEXT,
  ttl_hours     INT         NOT NULL DEFAULT 24,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  downloaded_at TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  -- soft-delete + TTL: è normale che il SELECT non li veda
  CONSTRAINT staging_ttl_valid CHECK (ttl_hours BETWEEN 1 AND 720) -- max 30gg
);

-- Index per query frequenti
CREATE INDEX loomx_staging_owner ON loomx_staging(owner_slug) WHERE deleted_at IS NULL;
CREATE INDEX loomx_staging_expires ON loomx_staging(expires_at) WHERE deleted_at IS NULL;
CREATE INDEX loomx_staging_recipients ON loomx_staging USING GIN(recipients) WHERE deleted_at IS NULL;

-- RLS enable
ALTER TABLE loomx_staging ENABLE ROW LEVEL SECURITY;

-- Nota al DBA: le policy devono usare session_user (non auth.uid())
-- in linea con il design RLS approvato (hub/initiatives/rls-security/design.md §4.2).
-- Con il backend attuale (service_role), il board-mcp applica ownership check applicativamente
-- (stesso pattern D-004/D-011). Le policy RLS entreranno in vigore nel rollout native-role.

CREATE POLICY staging_insert_own ON loomx_staging FOR INSERT
  WITH CHECK (owner_slug = session_user);

CREATE POLICY staging_select_authorized ON loomx_staging FOR SELECT
  USING (
    deleted_at IS NULL
    AND expires_at > NOW()
    AND (
      owner_slug = session_user
      OR session_user = ANY(recipients)
      OR recipients = '{}'
    )
  );

CREATE POLICY staging_softdelete_own ON loomx_staging FOR UPDATE
  USING (owner_slug = session_user AND deleted_at IS NULL)
  WITH CHECK (owner_slug = session_user);

-- GRANT per il ruolo doc_rw (se staging viene incluso nel ruolo condiviso)
-- oppure GRANT separato per loomx_rw (da definire con DBA)
```

**Nota implementativa (Fase 1 pre-native-role):** come per board/GTD (D-004/D-011), finché gli agenti girano in service_role, l'ownership enforcement avviene applicativamente nel MCP tool. La colonna `owner_slug` viene impostata a `selfSlug` lato server, non lato client — un agente non può dichiararsi diversamente.

---

## 6. Tool MCP — interfaccia proposta

### `staging_put`
```
staging_put(
  filename: string,           -- nome file (es. "report.json", "context.md")
  content: string,            -- payload testuale (max 1MB enforced MCP-side)
  recipients?: string[],      -- [] = broadcast a tutti; [...slug] = targeting
  description?: string,       -- descrizione umana del contenuto
  content_type?: string,      -- default "text/plain"
  ttl_hours?: number,         -- default 24, max 720 (30gg)
) → { staging_id: UUID, expires_at: string, recipients: string[] }
```

### `staging_get`
```
staging_get(
  id: UUID,                   -- staging_id ricevuto da staging_put o staging_list
) → { id, owner_slug, filename, content_type, description, content, created_at, expires_at }
```
- Errore se id non esiste, scaduto, o non autorizzato
- Aggiorna `downloaded_at` al primo accesso

### `staging_list`
```
staging_list(
  include_own?: boolean,      -- default true
  include_received?: boolean, -- default true
  limit?: number,             -- default 20, max 100
) → Array<{ id, owner_slug, filename, content_type, description, created_at, expires_at, downloaded_at }>
```
- Senza `content` (preview mode, D-020)

### `staging_delete`
```
staging_delete(
  id: UUID,
) → { ok: boolean }
```
- Solo owner (applicativo + RLS)
- Soft-delete (imposta `deleted_at`)

---

## 7. Dipendenze e passi successivi

| Step | Responsabile | Blocca |
|---|---|---|
| 1. Review e approvazione questo design | Loomy / Achille | tutto |
| 2. PR DBA: migration `loomx_staging` + RLS | board-mcp → DBA | step 3 |
| 3. Implementazione tool MCP `staging_*` (src/tools.ts) | board-mcp | step 4 |
| 4. Test e2e su environment loomy/board-mcp | board-mcp | release |
| 5. Documentazione CLAUDE.md sezione "Staging Tools" | board-mcp | release |
| 6. (Futuro) Aggiornamento policy RLS a session_user nel rollout native-role | DBA | D-019 rollout |

**Non implementato in questo task (fuori scope design):**
- Cleanup job (scaduti > 7gg → DELETE fisico) — da scheduling su DBA
- Content type detection automatica
- Supporto binary (BYTEA + base64) — Fase 2
- Chunking per file > 1MB — Fase 2

---

## 8. Pattern di integrazione con board_send

Il flusso raccomandato per passare artefatti grandi:

```
Sender:
  1. staging_put(filename="...", content="...", recipients=["target-agent"]) → id
  2. board_send(to="target-agent", subject="...", body="Leggi staging #<id>: <description>")

Receiver:
  1. board_inbox → legge summary/subject del messaggio
  2. staging_get(id="<id>") → content completo (on-demand, come D-020)
  3. board_ack(id=message_id) + staging_delete(id) se non serve più
```

Alternativa con broadcast (content pubblico a tutti):
```
staging_put(recipients=[]) → id  -- visibile a tutti gli agenti
board_broadcast(subject="...", body="Staging: #<id>")
```

---

*Design prodotto in autopilot da board-mcp · 2026-06-28*

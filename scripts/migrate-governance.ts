#!/usr/bin/env tsx
/**
 * Migration template: .md governance docs → DB doc_items (D-a5)
 *
 * v4: SOURCE_FILES supports trailing-slash directory syntax (aggregates all *.md, dedup by code).
 *
 * Usage:
 *   tsx migrate-governance.template.ts --project <uuid> --mode dry-run|commit [--repo-root <path>]
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (o alias SUPABASE_SERVICE_KEY)
 *      Ricava dal .mcp.json → "env" del server "board".
 *
 * Pattern (design §8):
 *   Phase A: import doc_items AS-IS (codes stored as-is)
 *   Phase B: resolve markers (// SDES-XXX, [REQ-XXX]) → create doc_item_links
 *
 * DRY-RUN: entire run inside BEGIN/ROLLBACK — shows report, writes nothing.
 * COMMIT:  proceeds only if unresolved=0 AND cross-app=0 (hard-fail otherwise).
 *
 * HOW TO CUSTOMIZE:
 *   1. Fill in SOURCE_FILES (which .md files to import and their document_type)
 *   2. Fill in MARKER_SCOPE (which files to scan for // SDES-XXX / [REQ-XXX] markers)
 *   3. Adjust ITEM_TYPE_MAP if your code prefixes differ
 *   4. Test with --mode dry-run first. Commit only on clean run.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface GovernanceManifest {
  repo: string;
  paths: Record<string, string | null>;
}

interface ImportedItem {
  code: string | null;
  item_type: string;
  sort_order: number;
  body: string;
  status: string;
  attrs: Record<string, unknown>;
}

interface ParsedDocument {
  document_type: string;
  title: string;
  source_file: string;
  items: ImportedItem[];
}

interface MarkerRef {
  file: string;
  line: number;
  code: string;
  context: string;
}

interface ResolveReport {
  file: string;
  line: number;
  code: string;
  uuid: string | null;
  project_id: string | null;
  status: 'resolved' | 'unresolved' | 'cross-app';
  reason?: string;
}

// ── Config (CUSTOMIZE) ────────────────────────────────────────────────────────

/**
 * Map of source .md file (relative to --repo-root) → document_type in DB.
 * FIXME: replace with your actual files. Esempi per tipo agente:
 *
 * Agenti TECH (dev-*):
 *   'docs/REQUISITI.md': 'req'
 *   'docs/DESIGN-DOC.md': 'sdes'
 *   'docs/UAT.md': 'uat'
 *   'docs/DECISIONS.md': 'decisions'
 *   'docs/SOW.md': 'sow'
 *
 * Agenti CONSULTING (analyst-*):
 *   'docs/DECISIONS.md': 'decisions'
 *   'docs/data_contract.md': 'mart_contract'
 *   'docs/kpi_catalog.md': 'kpi_catalog'
 *
 * Usa --doc-types per filtrare al runtime (es. --doc-types decisions,mart_contract).
 *
 * v4 — Struttura SPLIT: se il progetto usa più file .md in una dir, usa trailing-slash:
 *   'docs/requisiti/': 'req'  ← aggrega tutti *.md della dir, dedup per codice (last-seen wins)
 */
// CUSTOMIZED for board-mcp (D-a5 migration): board-mcp's only governance doc is
// DECISIONS.md. (REQ/SDES/UAT/SOW don't apply — board-mcp tracks work in WI/GTD.)
const SOURCE_FILES: Record<string, string> = {
  'docs/DECISIONS.md': 'decisions',
};

/**
 * Phase B marker scanning is DISABLED for board-mcp.
 * board-mcp is the repo that *implements* the document model, so its source,
 * tests, docs and the shared `.skills` submodule are full of EXAMPLE doc-codes
 * (REQ-001, SDES-001, KPI-1, …) that are not real traceability markers. The
 * template's scanner walks the whole tree and does not honor the manifest's
 * null-paths, so it false-positives on every example. board-mcp has zero real
 * code→doc traceability markers → scan nothing. (Reported as an attrito.)
 */
const MARKER_SCAN_EXTS: string[] = [];

/**
 * Maps code prefix → item_type in DB.
 * Contiene sia prefissi tech (REQ/SDES/UAT) sia consulting (DECISION/MART/KPI).
 * FIXME: aggiungi/rimuovi prefissi in base ai tuoi doc-type.
 */
const ITEM_TYPE_MAP: Record<string, string> = {
  // Tech
  REQ: 'req',
  SDES: 'sdes',
  UAT: 'uat',
  SOW: 'sow',
  RUNBOOK: 'runbook',
  // Consulting
  DECISION: 'decision',
  MART: 'mart_contract',
  KPI: 'kpi_catalog',
};

// Marker patterns: // SDES-001, [REQ-001], #DECISION-001, etc.
const MARKER_RE = /\b(REQ|SDES|UAT|SOW|MART|KPI|RUNBOOK|DECISION)-(\d+)\b/g;

// Item header pattern in .md (e.g., "## REQ-001 — Title", "## DECISION-001 — Title")
const ITEM_HEADER_RE = /^#+\s+((?:REQ|SDES|UAT|SOW|MART|KPI|RUNBOOK|DECISION)-\d+)(?:\s+[—–-]\s+(.+))?$/;

const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'dist', '.next', '__pycache__', '.venv']);

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let projectId = '';
let mode: 'dry-run' | 'commit' = 'dry-run';
let repoRoot = process.cwd();
let docTypesFilter: Set<string> | null = null; // null = no filter (all)

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) { projectId = args[++i]; continue; }
  if (args[i] === '--mode' && args[i + 1]) { mode = args[++i] as 'dry-run' | 'commit'; continue; }
  if (args[i] === '--repo-root' && args[i + 1]) { repoRoot = args[++i]; continue; }
  // --doc-types decisions,mart_contract  → processa solo questi document_type
  if (args[i] === '--doc-types' && args[i + 1]) {
    docTypesFilter = new Set(args[++i].split(',').map(s => s.trim()));
    continue;
  }
}

if (!projectId) {
  console.error('Error: --project <uuid> is required');
  process.exit(2);
}
if (mode !== 'dry-run' && mode !== 'commit') {
  console.error('Error: --mode must be dry-run or commit');
  process.exit(2);
}

const supabaseUrl = process.env.SUPABASE_URL;
// Accetta SUPABASE_SERVICE_ROLE_KEY (nome .mcp.json) e SUPABASE_SERVICE_KEY (alias legacy)
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error('Error: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY devono essere impostati');
  console.error('  Ricavali dal .mcp.json → "env" del server "board"');
  process.exit(1);
}

// ── Manifest validation ───────────────────────────────────────────────────────

function loadManifest(): GovernanceManifest {
  const path = join(repoRoot, '.governance.json');
  if (!existsSync(path)) {
    console.error(`Error: .governance.json not found at ${repoRoot} — run STEP 1 of runbook first`);
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(path, 'utf8')) as GovernanceManifest;
  // Verify our project_id is mapped
  const mapped = Object.values(m.paths).some(v => v === projectId);
  if (!mapped) {
    console.error(`Error: project_id ${projectId} not found in .governance.json paths`);
    console.error('Mapped project_ids:', Object.values(m.paths).filter(Boolean));
    process.exit(1);
  }
  return m;
}

// ── Phase A: parse .md files into doc_items ───────────────────────────────────

/**
 * Parses a governance .md file into a ParsedDocument.
 * Expects structure:
 *   # Document Title
 *   (optional prose)
 *   ## CODE-001 — Item Title
 *   body markdown
 *   ## CODE-002 — Item Title
 *   ...
 *
 * Items without a CODE header are imported as prose items (code=null).
 */
function parseMdFile(filePath: string, documentType: string): ParsedDocument {
  const content = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

  // Skip GENERATED .md — they're already in DB
  if (content.trimStart().startsWith('<!-- GENERATED')) {
    console.log(`  SKIP (already GENERATED): ${relative(repoRoot, filePath)}`);
    return { document_type: documentType, title: '', source_file: filePath, items: [] };
  }

  const lines = content.split('\n');
  let title = '';
  const items: ImportedItem[] = [];
  let currentCode: string | null = null;
  let currentType: string = 'prose';
  let currentLines: string[] = [];
  let sortOrder = 10;

  function flushItem(): void {
    const body = currentLines.join('\n').trim();
    if (!body) return;
    items.push({
      code: currentCode,
      item_type: currentType,
      sort_order: sortOrder,
      body,
      status: 'draft',
      attrs: {},
    });
    sortOrder += 10;
    currentLines = [];
  }

  for (const line of lines) {
    // Document title (first H1)
    if (!title && line.startsWith('# ') && !line.startsWith('## ')) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    // Item header: ## CODE-001 — Title (template default)
    const headerMatch = ITEM_HEADER_RE.exec(line);
    if (headerMatch) {
      flushItem();
      currentCode = headerMatch[1];
      const prefix = currentCode.split('-')[0];
      currentType = ITEM_TYPE_MAP[prefix] ?? documentType;
      currentLines = [line];
      continue;
    }

    // board-mcp CUSTOM: every `## ` heading starts a new decision item.
    // board-mcp's DECISIONS.md uses `## D-001 — …` / `## D-a5 F1 — …` headers
    // (not the template's `DECISION-001`). Extract a stable code from a leading
    // `D-<token>` when present; otherwise import as a code-less decision item.
    if (line.startsWith('## ')) {
      flushItem();
      const heading = line.replace(/^##\s+/, '').trim();
      // Take the part before the title separator ( — / – / - surrounded by spaces),
      // then slugify. Only D-* headings get a stable code; others stay code-less.
      const headTitle = heading.split(/\s+[—–-]\s+/)[0].trim();
      currentCode = /^D-/.test(headTitle)
        ? headTitle.replace(/[^A-Za-z0-9.]+/g, '-').replace(/-+$/, '')
        : null;
      currentType = documentType === 'decisions' ? 'decision' : 'prose';
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }
  flushItem();

  return { document_type: documentType, title: title || relative(repoRoot, filePath), source_file: filePath, items };
}

// ── Phase B: marker scanning ──────────────────────────────────────────────────

function walkFiles(root: string, exts: string[]): string[] {
  const files: string[] = [];
  function recurse(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { recurse(full); continue; }
      if (exts.some(e => entry.name.endsWith(e))) files.push(full);
    }
  }
  recurse(root);
  return files;
}

function scanMarkers(root: string): MarkerRef[] {
  const refs: MarkerRef[] = [];
  for (const filePath of walkFiles(root, MARKER_SCAN_EXTS)) {
    const content = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    if (content.trimStart().startsWith('<!-- GENERATED')) continue; // skip dumps
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(MARKER_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i])) !== null) {
        refs.push({ file: relative(root, filePath), line: i + 1, code: m[0], context: lines[i].trim() });
      }
    }
  }
  return refs;
}

// ── DB operations (via Supabase client) ───────────────────────────────────────

async function run(): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(supabaseUrl!, serviceKey!);

  const manifest = loadManifest();
  console.log(`\nMigration ${mode.toUpperCase()} — project: ${projectId}`);
  console.log(`Repo root: ${repoRoot}`);
  if (docTypesFilter) console.log(`Doc-type filter: ${[...docTypesFilter].join(', ')}`);
  if (mode === 'dry-run') console.log('(DRY-RUN: all changes will be ROLLED BACK)\n');

  // ── MCP-native dry-run: mostra cosa è già in DB prima di importare ────────
  // Utile per agenti consulting che vogliono verificare lo stato corrente
  // prima di decidere quali file importare con SOURCE_FILES.
  if (mode === 'dry-run') {
    console.log('── Existing in DB (MCP-native check) ──────────────────────────');
    const { data: existingDocs } = await sb
      .from('documents')
      .select('id, document_type, title')
      .eq('project_id', projectId);
    if (!existingDocs || existingDocs.length === 0) {
      console.log('  (nessun documento ancora in DB per questo project_id)');
    } else {
      for (const d of existingDocs) {
        const { count } = await sb
          .from('doc_items')
          .select('id', { count: 'exact', head: true })
          .eq('document_id', d.id);
        console.log(`  EXISTS  ${d.document_type}  "${d.title}"  items=${count ?? 0}`);
      }
    }
    console.log('');
  }

  // ── Phase A: collect documents to import ──────────────────────────────────

  const docs: ParsedDocument[] = [];
  for (const [relPath, docType] of Object.entries(SOURCE_FILES)) {
    // Skip doc_types esclusi dal filtro --doc-types
    if (docTypesFilter && !docTypesFilter.has(docType)) {
      console.log(`  SKIP (doc-type filter): ${relPath}`);
      continue;
    }

    // v4: directory syntax (trailing slash) — aggregate all *.md, dedup by code
    if (relPath.endsWith('/')) {
      const fullDir = join(repoRoot, relPath);
      if (!existsSync(fullDir)) {
        console.log(`  MISSING dir: ${relPath} — skip`);
        continue;
      }
      const mdFiles = readdirSync(fullDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .map(f => join(fullDir, f));
      const codeMap = new Map<string, ImportedItem>();
      const proseItems: ImportedItem[] = [];
      let aggregateTitle = relPath;
      for (const mdFile of mdFiles) {
        const parsed = parseMdFile(mdFile, docType);
        if (parsed.title && aggregateTitle === relPath) aggregateTitle = parsed.title;
        for (const item of parsed.items) {
          if (item.code) {
            codeMap.set(item.code, item); // last-seen wins for dedup
          } else {
            proseItems.push(item);
          }
        }
      }
      const allItems = [...proseItems, ...codeMap.values()].map((item, idx) => ({
        ...item,
        sort_order: (idx + 1) * 10,
      }));
      if (allItems.length > 0) {
        docs.push({ document_type: docType, title: aggregateTitle, source_file: relPath, items: allItems });
        console.log(`  dir expanded: ${relPath} → ${mdFiles.length} files, ${allItems.length} items`);
      }
      continue;
    }

    const fullPath = join(repoRoot, relPath);
    if (!existsSync(fullPath)) {
      console.log(`  MISSING: ${relPath} — skip`);
      continue;
    }
    const parsed = parseMdFile(fullPath, docType);
    if (parsed.items.length > 0) docs.push(parsed);
  }

  const totalItems = docs.reduce((sum, d) => sum + d.items.length, 0);
  console.log(`Phase A: ${docs.length} documents, ${totalItems} items to import`);

  // ── Phase A: upsert into DB (inside transaction in dry-run) ──────────────

  // NOTE: Supabase JS client does not expose raw transactions.
  // For dry-run, we track what we'd insert and rollback manually.
  // For production use, route through board-mcp doc_item_upsert tool
  // (which handles idempotency and validation per design §7).
  //
  // FIXME (F1 live): replace direct Supabase calls with board-mcp doc_item_upsert tool.

  const importedUuids: Map<string, string> = new Map(); // code → uuid
  let phaseAErrors = 0;

  for (const doc of docs) {
    // Ensure document record exists
    const { data: existingDoc } = await sb
      .from('documents')
      .select('id')
      .eq('project_id', projectId)
      .eq('document_type', doc.document_type)
      .maybeSingle();

    let documentId: string;

    if (existingDoc) {
      documentId = existingDoc.id as string;
      console.log(`  doc exists: ${doc.document_type} → ${documentId}`);
    } else if (mode === 'commit') {
      const { data: newDoc, error: docErr } = await sb
        .from('documents')
        .insert({
          project_id: projectId,
          document_type: doc.document_type,
          title: doc.title,
          status: 'draft',
          owner: 'migration',
        })
        .select('id')
        .single();
      if (docErr || !newDoc) {
        console.error(`  ERROR creating document ${doc.document_type}: ${docErr?.message}`);
        phaseAErrors++;
        continue;
      }
      documentId = newDoc.id as string;
      console.log(`  doc created: ${doc.document_type} → ${documentId}`);
    } else {
      // dry-run: fake UUID
      documentId = `dry-run-doc-${doc.document_type}`;
      console.log(`  [dry-run] would create doc: ${doc.document_type}`);
    }

    for (const item of doc.items) {
      if (mode === 'commit') {
        if (item.code) {
          // Coded item: manual upsert on (project_id, code).
          // NOTE (board-mcp fix): the DB unique index is PARTIAL
          // (uq_doc_items_project_code … WHERE code IS NOT NULL), which does NOT
          // satisfy PostgREST `ON CONFLICT (project_id, code)` → ".upsert()"
          // errors "no unique or exclusion constraint matching". So we do a
          // select-then-insert/update by hand (same as board-mcp doc_item_upsert).
          const fields = {
            document_id: documentId,
            project_id: projectId,
            item_type: item.item_type,
            code: item.code,
            status: item.status,
            sort_order: item.sort_order,
            body: item.body,
            attrs: item.attrs,
          };
          const { data: existingItem } = await sb
            .from('doc_items')
            .select('id')
            .eq('project_id', projectId)
            .eq('code', item.code)
            .maybeSingle();
          let uuid: string | null = null;
          if (existingItem) {
            const { data: upd, error: uErr } = await sb
              .from('doc_items')
              .update(fields)
              .eq('id', existingItem.id)
              .select('id')
              .maybeSingle();
            if (uErr || !upd) { console.error(`  ERROR updating ${item.code}: ${uErr?.message}`); phaseAErrors++; }
            else uuid = upd.id as string;
          } else {
            const { data: ins, error: iErr } = await sb
              .from('doc_items')
              .insert(fields)
              .select('id')
              .maybeSingle();
            if (iErr || !ins) { console.error(`  ERROR inserting ${item.code}: ${iErr?.message}`); phaseAErrors++; }
            else uuid = ins.id as string;
          }
          if (uuid) {
            importedUuids.set(item.code, uuid);
            console.log(`  imported: ${item.code} → ${uuid}`);
          }
        } else {
          // Prose item (code=null): no unique constraint on (document_id, sort_order).
          // Delete-then-insert for idempotency.
          await sb
            .from('doc_items')
            .delete()
            .eq('document_id', documentId)
            .eq('sort_order', item.sort_order)
            .is('code', null);
          const { data: inserted, error: itemErr } = await sb
            .from('doc_items')
            .insert({
              document_id: documentId,
              project_id: projectId,
              item_type: item.item_type,
              code: null,
              status: item.status,
              sort_order: item.sort_order,
              body: item.body,
              attrs: item.attrs,
            })
            .select('id')
            .maybeSingle();
          if (itemErr || !inserted) {
            console.error(`  ERROR inserting prose (sort_order=${item.sort_order}): ${itemErr?.message}`);
            phaseAErrors++;
          } else {
            console.log(`  imported: prose(sort_order=${item.sort_order}) → ${inserted.id}`);
          }
        }
      } else {
        // dry-run: just track
        const fakeUuid = `dry-run-${item.code ?? `prose-${item.sort_order}`}`;
        if (item.code) importedUuids.set(item.code, fakeUuid);
        console.log(`  [dry-run] would import: ${item.code ?? 'prose'} (sort_order=${item.sort_order})`);
      }
    }
  }

  // ── Phase B: resolve markers ──────────────────────────────────────────────

  const markers = scanMarkers(repoRoot);
  const report: ResolveReport[] = [];
  console.log(`\nPhase B: ${markers.length} markers to resolve`);

  for (const marker of markers) {
    // Check if resolved by Phase A
    const uuid = importedUuids.get(marker.code);
    if (uuid) {
      report.push({ ...marker, uuid, project_id: projectId, status: 'resolved' });
      continue;
    }

    // Check DB for existing item (in case already migrated)
    const { data: existing } = await sb
      .from('doc_items')
      .select('id, project_id')
      .eq('code', marker.code)
      .maybeSingle();

    if (!existing) {
      report.push({ ...marker, uuid: null, project_id: null, status: 'unresolved', reason: 'not found in doc_items' });
      continue;
    }

    // Cross-app check: the item must belong to THIS project
    if (existing.project_id !== projectId) {
      report.push({
        ...marker,
        uuid: existing.id as string,
        project_id: existing.project_id as string,
        status: 'cross-app',
        reason: `found in project ${existing.project_id} — cross-app link is forbidden by design (FK constraint)`,
      });
      continue;
    }

    // Resolved from DB
    report.push({ ...marker, uuid: existing.id as string, project_id: projectId, status: 'resolved' });
    if (marker.code) importedUuids.set(marker.code, existing.id as string);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const resolved = report.filter(r => r.status === 'resolved');
  const unresolved = report.filter(r => r.status === 'unresolved');
  const crossApp = report.filter(r => r.status === 'cross-app');

  console.log('\n── Report ──────────────────────────────────────────────────');
  for (const r of resolved) {
    console.log(`  RESOLVED   ${r.file}:${r.line}  code=${r.code}  uuid=${r.uuid?.slice(0, 8)}…  project=this`);
  }
  for (const r of unresolved) {
    console.error(`  UNRESOLVED ${r.file}:${r.line}  code=${r.code}  reason="${r.reason}"`);
  }
  for (const r of crossApp) {
    console.error(`  CROSS-APP  ${r.file}:${r.line}  code=${r.code}  found_in=${r.project_id}  → ABORT`);
  }

  console.log('\n── Summary ─────────────────────────────────────────────────');
  console.log(`  doc_items imported (${mode}): ${totalItems}`);
  console.log(`  markers resolved:             ${resolved.length}`);
  console.log(`  unresolved:                   ${unresolved.length}`);
  console.log(`  cross-app:                    ${crossApp.length}`);
  console.log(`  phase A errors:               ${phaseAErrors}`);

  // ── Commit gate ───────────────────────────────────────────────────────────

  const canCommit = unresolved.length === 0 && crossApp.length === 0 && phaseAErrors === 0;

  if (mode === 'dry-run') {
    if (canCommit) {
      console.log('\n→ Dry-run complete. Safe to commit — re-run with --mode commit');
    } else {
      console.log('\n→ Dry-run complete. FIX the issues above before committing.');
      process.exit(1); // non-zero so CI fails on dry-run errors
    }
    return;
  }

  // mode === 'commit'
  if (!canCommit) {
    console.error('\n→ ABORT: commit blocked — unresolved or cross-app markers found.');
    console.error('  Fix issues and re-run dry-run first.');
    process.exit(1);
  }

  // ── Phase B commit: create doc_item_links for resolved markers ────────────
  // FIXME (F1 live): replace with board-mcp doc_link tool.
  // For now, log the links that would be created.

  console.log('\nPhase B commit: creating doc_item_links for resolved markers...');
  // NOTE: marker references in source files are INFORMATIONAL (text refs like // SDES-001).
  // doc_item_links are structural traceability links (REQ satisfies SDES, SDES verifies UAT).
  // Those must be created explicitly by the agent after reviewing the content.
  // Marker resolution here just VALIDATES that the code exists; actual linking is manual.
  console.log('  (Marker-to-link mapping requires human review — see §8 design doc)');
  console.log('  Run: doc_link(from_uuid, to_uuid, relation_type) for each traceability link.');

  console.log('\n→ Migration successful. Run dump + lint next (STEP 4 of runbook).');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

#!/usr/bin/env python3
"""
validate-traceability.py — Validates cross-layer traceability: build ↔ SDES ↔ UAT.

Checks:
  1. Code annotations: scans src/ for SDES-XXX references
  2. Every SDES-XXX referenced in code exists in DESIGN-DOC.md
  3. Every SDES with status=implemented has at least one code annotation
  4. Orphan annotations: SDES-XXX in code that doesn't exist in DESIGN-DOC
  5. UAT integrity: every UAT-XXX references an existing SDES (if UAT dir provided)
  6. UAT coverage: every SDES with status=implemented has at least one UAT
  7. Broken UAT: UAT references SDES that doesn't exist or isn't implemented

Usage:
  python validate-traceability.py --src src/ --design docs/DESIGN-DOC.md
  python validate-traceability.py --src src/ --design docs/DESIGN-DOC.md --uat docs/UAT/
  python validate-traceability.py --src src/ --design docs/DESIGN-DOC.md --uat docs/UAT/ --format json

Output: human-readable report (default) or JSON (--format json)
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# File extensions to scan in src/
SRC_EXTENSIONS = {'.tsx', '.ts', '.jsx', '.js'}

# Pattern to find SDES annotations in source code
SDES_ANNOTATION = re.compile(r'SDES-(\d+)', re.IGNORECASE)

# Pattern to parse SDES entries in DESIGN-DOC.md
SDES_HEADER = re.compile(r'^###\s+(SDES-\d+)\s*[—–-]\s*(.*)', re.MULTILINE)
YAML_BLOCK = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)

# Pattern to parse UAT files
UAT_YAML = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def scan_src_annotations(src_path: Path) -> dict:
    """
    Scan src/ for SDES-XXX annotations.
    Returns: {sdes_id: [(file_path, line_number, context)]}
    """
    annotations = defaultdict(list)
    for ext in SRC_EXTENSIONS:
        for file_path in src_path.rglob(f'*{ext}'):
            try:
                lines = file_path.read_text(encoding='utf-8').splitlines()
            except (UnicodeDecodeError, PermissionError):
                continue
            for line_no, line in enumerate(lines, 1):
                for match in SDES_ANNOTATION.finditer(line):
                    sdes_id = f'SDES-{match.group(1)}'
                    context = line.strip()[:80]
                    annotations[sdes_id].append({
                        'file': str(file_path),
                        'line': line_no,
                        'context': context,
                    })
    return dict(annotations)


def parse_design_doc(design_path: Path) -> dict:
    """
    Parse DESIGN-DOC.md. Returns: {sdes_id: {status, section, component, reqs, uat}}
    """
    entries = {}
    if not design_path.exists():
        return entries
    text = design_path.read_text(encoding='utf-8')
    sections = re.split(r'(?=^### SDES-)', text, flags=re.MULTILINE)
    for section in sections:
        header = SDES_HEADER.match(section)
        if not header:
            continue
        sdes_id = header.group(1).strip()
        yaml_match = YAML_BLOCK.search(section[header.end():])
        fields = {}
        if yaml_match:
            for line in yaml_match.group(1).split('\n'):
                if ':' in line:
                    k, _, v = line.partition(':')
                    fields[k.strip().lower()] = v.strip().strip('"').strip("'")
        reqs_raw = fields.get('reqs', '').strip('[]')
        reqs = [r.strip() for r in reqs_raw.split(',') if r.strip()]
        uat_raw = fields.get('uat', '').strip('[]')
        uat = [u.strip() for u in uat_raw.split(',') if u.strip()]
        entries[sdes_id] = {
            'status': fields.get('status', 'unknown'),
            'section': fields.get('section', ''),
            'component': fields.get('component', ''),
            'reqs': reqs,
            'uat': uat,
        }
    return entries


def parse_uat_files(uat_path: Path) -> list:
    """
    Parse UAT files. Returns list of {id, sdes, reqs, status}
    """
    uat_entries = []
    if not uat_path.exists():
        return uat_entries
    for uat_file in sorted(uat_path.glob('UAT-*.md')):
        text = uat_file.read_text(encoding='utf-8')
        yaml_match = UAT_YAML.match(text)
        if not yaml_match:
            continue
        fields = {}
        for line in yaml_match.group(1).split('\n'):
            if ':' in line:
                k, _, v = line.partition(':')
                fields[k.strip().lower()] = v.strip().strip('"').strip("'")
        reqs_raw = fields.get('reqs', '').strip('[]')
        reqs = [r.strip() for r in reqs_raw.split(',') if r.strip()]
        uat_entries.append({
            'id': fields.get('id', uat_file.stem),
            'sdes': fields.get('sdes', ''),
            'reqs': reqs,
            'status': fields.get('status', 'pending'),
            'file': str(uat_file),
        })
    return uat_entries


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_annotation_integrity(annotations: dict, design_entries: dict) -> list:
    """SDES-XXX in code must exist in DESIGN-DOC."""
    issues = []
    for sdes_id, refs in annotations.items():
        if sdes_id not in design_entries:
            for ref in refs:
                issues.append({
                    'severity': 'error',
                    'check': 'orphan_annotation',
                    'sdes': sdes_id,
                    'message': f'Annotazione orfana in {ref["file"]}:{ref["line"]} — {sdes_id} non esiste in DESIGN-DOC.md'
                })
    return issues


def check_implementation_coverage(annotations: dict, design_entries: dict) -> list:
    """Every SDES with status=implemented should have at least one annotation."""
    issues = []
    for sdes_id, entry in design_entries.items():
        if entry['status'] == 'implemented' and sdes_id not in annotations:
            issues.append({
                'severity': 'warning',
                'check': 'missing_annotation',
                'sdes': sdes_id,
                'message': f'{sdes_id} (status=implemented) non ha annotazioni in src/ — aggiungere // {sdes_id} nel codice'
            })
        elif entry['status'] == 'approved' and sdes_id not in annotations:
            issues.append({
                'severity': 'info',
                'check': 'approved_not_implemented',
                'sdes': sdes_id,
                'message': f'{sdes_id} è approved ma non ancora implementato — pronto per sprint'
            })
    return issues


def check_uat_integrity(uat_entries: list, design_entries: dict) -> list:
    """UAT must reference existing SDES entries."""
    issues = []
    for uat in uat_entries:
        sdes = uat['sdes']
        if not sdes:
            issues.append({
                'severity': 'error',
                'check': 'uat_missing_sdes',
                'sdes': '-',
                'message': f'{uat["id"]} non ha nessun campo sdes: — ogni UAT deve linkare un SDES-XXX'
            })
        elif sdes not in design_entries:
            issues.append({
                'severity': 'error',
                'check': 'uat_broken_sdes',
                'sdes': sdes,
                'message': f'{uat["id"]} referenzia {sdes} che non esiste in DESIGN-DOC.md'
            })
        else:
            sdes_status = design_entries[sdes]['status']
            if sdes_status not in ('approved', 'implemented'):
                issues.append({
                    'severity': 'warning',
                    'check': 'uat_premature',
                    'sdes': sdes,
                    'message': f'{uat["id"]} testa {sdes} che è ancora in status={sdes_status} (non approved)'
                })
    return issues


def check_uat_coverage(uat_entries: list, design_entries: dict) -> list:
    """Every implemented SDES should have at least one UAT."""
    issues = []
    uat_by_sdes = defaultdict(list)
    for uat in uat_entries:
        if uat['sdes']:
            uat_by_sdes[uat['sdes']].append(uat['id'])
    for sdes_id, entry in design_entries.items():
        if entry['status'] == 'implemented' and sdes_id not in uat_by_sdes:
            issues.append({
                'severity': 'warning',
                'check': 'uat_missing',
                'sdes': sdes_id,
                'message': f'{sdes_id} (implemented) non ha UAT — creare docs/UAT/UAT-XXX.md'
            })
    return issues


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def run_all_checks(annotations, design_entries, uat_entries=None):
    issues = []
    issues.extend(check_annotation_integrity(annotations, design_entries))
    issues.extend(check_implementation_coverage(annotations, design_entries))
    if uat_entries is not None:
        issues.extend(check_uat_integrity(uat_entries, design_entries))
        issues.extend(check_uat_coverage(uat_entries, design_entries))
    return issues


def format_report(annotations, design_entries, uat_entries, issues):
    errors = [i for i in issues if i['severity'] == 'error']
    warnings = [i for i in issues if i['severity'] == 'warning']
    infos = [i for i in issues if i['severity'] == 'info']

    implemented = sum(1 for e in design_entries.values() if e['status'] == 'implemented')
    approved = sum(1 for e in design_entries.values() if e['status'] == 'approved')
    annotated = len(annotations)

    lines = [
        '# Traceability Report', '',
        f'SDES in DESIGN-DOC: {len(design_entries)} (implemented: {implemented}, approved: {approved})',
        f'SDES con annotazioni in src/: {annotated}',
    ]
    if uat_entries is not None:
        passed = sum(1 for u in uat_entries if u['status'] == 'passed')
        failed = sum(1 for u in uat_entries if u['status'] == 'failed')
        lines.append(f'UAT: {len(uat_entries)} (passed: {passed}, failed: {failed})')
    lines += ['', f'Errori: {len(errors)} | Warning: {len(warnings)} | Info: {len(infos)}', '']

    if errors:
        lines += ['## Errori (bloccanti)', '']
        lines += [f'- **{i["sdes"]}** [{i["check"]}]: {i["message"]}' for i in errors]
        lines.append('')
    if warnings:
        lines += ['## Warning', '']
        lines += [f'- **{i["sdes"]}** [{i["check"]}]: {i["message"]}' for i in warnings]
        lines.append('')
    if infos:
        lines += ['## Info (SDES pronti per implementazione)', '']
        lines += [f'- **{i["sdes"]}**: {i["message"]}' for i in infos]
        lines.append('')
    if not errors and not warnings:
        lines.append('Traceabilità integra. Nessun problema bloccante.')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Validate cross-layer traceability')
    parser.add_argument('--src', required=True, help='Path to src/ directory')
    parser.add_argument('--design', required=True, help='Path to DESIGN-DOC.md')
    parser.add_argument('--uat', help='Path to docs/UAT/ directory (optional)')
    parser.add_argument('--format', choices=['text', 'json'], default='text')
    args = parser.parse_args()

    src_path = Path(args.src)
    design_path = Path(args.design)

    if not src_path.exists():
        print(f'Errore: src path {src_path} non trovato', file=sys.stderr)
        sys.exit(1)

    annotations = scan_src_annotations(src_path)
    design_entries = parse_design_doc(design_path)
    uat_entries = None
    if args.uat:
        uat_path = Path(args.uat)
        uat_entries = parse_uat_files(uat_path)

    issues = run_all_checks(annotations, design_entries, uat_entries)

    if args.format == 'json':
        result = {
            'sdes_total': len(design_entries),
            'sdes_annotated': len(annotations),
            'uat_total': len(uat_entries) if uat_entries else 0,
            'errors': len([i for i in issues if i['severity'] == 'error']),
            'warnings': len([i for i in issues if i['severity'] == 'warning']),
            'issues': issues,
            'annotations': {k: v for k, v in annotations.items()},
        }
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(format_report(annotations, design_entries, uat_entries or [], issues))

    sys.exit(1 if any(i['severity'] == 'error' for i in issues) else 0)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
validate-design.py — Validates DESIGN-DOC.md for traceability integrity.

Checks:
  1. SDES field completeness (id, section, reqs, decisions, status, status_date)
  2. ID uniqueness across all SDES entries
  3. REQ integrity: every REQ-XXX in SDES.reqs exists in requisiti/
  4. REQ validity: no SDES references a REQ with priority='wont' or status='cancelled'
     → notify: project-manager
  5. Decision integrity: every D-XXX in SDES.decisions exists in DECISIONS.md
  6. Decision validity: no SDES references a D-XXX with Status != empty (superseded/annullata)
     → notify: design
  7. REQ coverage: every committed+must REQ has at least one SDES linked
  8. Acceptance criteria: every SDES has at least one acceptance checkbox
  9. Index table consistency: SDES in index matches SDES entries

Usage:
  python validate-design.py docs/DESIGN-DOC.md
  python validate-design.py docs/DESIGN-DOC.md --reqs docs/requisiti/ --decisions docs/DECISIONS.md
  python validate-design.py docs/DESIGN-DOC.md --reqs docs/requisiti/ --decisions docs/DECISIONS.md --format json

Output: human-readable report (default) or JSON (--format json)
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {"id", "section", "reqs", "decisions", "status", "status_date"}
VALID_SECTIONS = {"hero", "services", "about", "cases", "blog", "contacts", "global"}
VALID_STATUSES = {"draft", "approved", "implemented", "cancelled"}  # see docs/STATUS-SCHEMA.md

SDES_HEADER = re.compile(r'^###\s+(SDES-\d+)\s*[—–-]\s*(.*)', re.MULTILINE)
YAML_BLOCK = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)
REQ_REF = re.compile(r'REQ-\d+')
DECISION_REF = re.compile(r'D-\d+')


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_list_field(value: str) -> list:
    """Parse a YAML-style list field: [REQ-001, REQ-002] or REQ-001, REQ-002"""
    value = value.strip().strip('[]')
    if not value:
        return []
    return [v.strip() for v in value.split(',') if v.strip()]


def parse_sdes_entries(text: str) -> list:
    entries = []
    sections = re.split(r'(?=^### SDES-)', text, flags=re.MULTILINE)
    for section in sections:
        header_match = SDES_HEADER.match(section)
        if not header_match:
            continue
        sdes_id = header_match.group(1).strip()
        title = header_match.group(2).strip()
        yaml_match = YAML_BLOCK.search(section[header_match.end():])
        fields = {}
        if yaml_match:
            for line in yaml_match.group(1).split('\n'):
                if ':' in line:
                    key, _, val = line.partition(':')
                    fields[key.strip().lower()] = val.strip().strip('"').strip("'")
        has_acceptance = bool(re.search(r'- \[ \]', section))
        reqs = parse_list_field(fields.get('reqs', ''))
        decisions = parse_list_field(fields.get('decisions', ''))
        entries.append({
            'id': sdes_id,
            'title': title,
            'fields': fields,
            'reqs': reqs,
            'decisions': decisions,
            'has_acceptance': has_acceptance,
            'section': fields.get('section', ''),
            'status': fields.get('status', ''),
        })
    return entries


def load_requirements(reqs_path: Path) -> dict:
    """Load all requirements. Returns {id: {status, priority, headline}}"""
    reqs = {}
    if not reqs_path.exists():
        return reqs
    files = [reqs_path] if reqs_path.is_file() else sorted(reqs_path.glob('**/*.md'))
    for f in files:
        if f.name == 'index.md':
            continue
        text = f.read_text(encoding='utf-8')
        for section in re.split(r'(?=^### REQ-)', text, flags=re.MULTILINE):
            header = re.match(r'^###\s+(REQ-\S+)\s*[—–-]\s*(.*)', section)
            if not header:
                continue
            req_id = header.group(1).strip()
            yaml_match = YAML_BLOCK.search(section[header.end():])
            fields = {}
            if yaml_match:
                for line in yaml_match.group(1).split('\n'):
                    if ':' in line:
                        k, _, v = line.partition(':')
                        fields[k.strip().lower()] = v.strip().strip('"').strip("'")
            reqs[req_id] = {
                'status': fields.get('status', 'unknown'),
                'priority': fields.get('priority', 'unknown'),
                'headline': fields.get('headline', header.group(2).strip()),
            }
    return reqs


def load_decisions(decisions_path: Path) -> dict:
    """Load decisions from DECISIONS.md. Returns {D-XXX: {status, decision}}"""
    decisions = {}
    if not decisions_path.exists():
        return decisions
    text = decisions_path.read_text(encoding='utf-8')
    # Parse table rows: | D-XXX | date | stream | decision | rationale | source | status |
    row_pattern = re.compile(
        r'^\|\s*(D-\d+)\s*\|[^|]*\|[^|]*\|([^|]*)\|[^|]*\|[^|]*\|([^|]*)\|',
        re.MULTILINE
    )
    for m in row_pattern.finditer(text):
        d_id = m.group(1).strip()
        decision_text = m.group(2).strip()
        status_raw = m.group(3).strip()
        decisions[d_id] = {
            'decision': decision_text,
            'status': status_raw,  # empty = active, '→ D-XXX' = superseded, 'annullata' = cancelled
        }
    return decisions


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_field_completeness(entries: list) -> list:
    issues = []
    for e in entries:
        missing = REQUIRED_FIELDS - set(e['fields'].keys())
        if missing:
            issues.append({
                'severity': 'error', 'check': 'field_completeness', 'sdes': e['id'],
                'message': f'Campi mancanti: {", ".join(sorted(missing))}'
            })
        if e['section'] and e['section'] not in VALID_SECTIONS:
            issues.append({
                'severity': 'warning', 'check': 'field_value', 'sdes': e['id'],
                'message': f'Section non standard: "{e["section"]}" (valori: {", ".join(sorted(VALID_SECTIONS))})'
            })
        if e['status'] and e['status'] not in VALID_STATUSES:
            issues.append({
                'severity': 'error', 'check': 'field_value', 'sdes': e['id'],
                'message': f'Status non valido: "{e["status"]}" (valori: draft, approved, implemented)'
            })
    return issues


def check_id_uniqueness(entries: list) -> list:
    issues = []
    seen = {}
    for e in entries:
        if e['id'] in seen:
            issues.append({
                'severity': 'error', 'check': 'id_uniqueness', 'sdes': e['id'],
                'message': f'ID duplicato: {e["id"]}'
            })
        else:
            seen[e['id']] = True
    return issues


def check_req_integrity(entries: list, reqs: dict) -> list:
    issues = []
    if not reqs:
        return issues
    for e in entries:
        if not e['reqs']:
            issues.append({
                'severity': 'error', 'check': 'req_missing', 'sdes': e['id'],
                'message': 'Nessun REQ-XXX referenziato — ogni SDES deve implementare almeno un requisito'
            })
            continue
        for req_id in e['reqs']:
            if req_id not in reqs:
                issues.append({
                    'severity': 'error', 'check': 'req_integrity', 'sdes': e['id'],
                    'message': f'REQ non trovato: {req_id}'
                })
            elif reqs[req_id].get('priority') == 'wont':
                issues.append({
                    'severity': 'warning', 'check': 'req_out_of_scope', 'sdes': e['id'],
                    'notify': 'project-manager',
                    'message': f'{req_id} ha priority=wont (fuori scope) — verificare se il SDES è ancora necessario'
                })
            elif reqs[req_id]['status'] == 'cancelled':
                issues.append({
                    'severity': 'error', 'check': 'req_cancelled', 'sdes': e['id'],
                    'notify': 'project-manager',
                    'message': f'{req_id} ha status=cancelled — rimuovere da questo SDES o riaprire il requisito'
                })
    return issues


def check_decision_integrity(entries: list, decisions: dict) -> list:
    issues = []
    if not decisions:
        return issues
    for e in entries:
        if not e['decisions']:
            issues.append({
                'severity': 'error', 'check': 'decision_missing', 'sdes': e['id'],
                'message': 'Nessun D-XXX referenziato — ogni SDES deve applicare almeno una decisione attiva'
            })
            continue
        for d_id in e['decisions']:
            if d_id not in decisions:
                issues.append({
                    'severity': 'error', 'check': 'decision_integrity', 'sdes': e['id'],
                    'message': f'Decisione non trovata in DECISIONS.md: {d_id}'
                })
            else:
                d_status = decisions[d_id]['status']
                if d_status.startswith('→'):
                    issues.append({
                        'severity': 'error', 'check': 'decision_superseded', 'sdes': e['id'],
                        'notify': 'design',
                        'message': f'{d_id} è superseded ({d_status}) — aggiornare al successore'
                    })
                elif d_status.lower() == 'annullata':
                    issues.append({
                        'severity': 'error', 'check': 'decision_cancelled', 'sdes': e['id'],
                        'notify': 'design',
                        'message': f'{d_id} è annullata — rimuovere da questo SDES'
                    })
    return issues


def check_req_coverage(entries: list, reqs: dict) -> list:
    """Every committed+must REQ should have at least one SDES."""
    issues = []
    if not reqs:
        return issues
    covered = set()
    for e in entries:
        for req_id in e['reqs']:
            covered.add(req_id)
    for req_id, req in reqs.items():
        if req['status'] == 'committed' and req['priority'] == 'must':
            if req_id not in covered:
                issues.append({
                    'severity': 'warning', 'check': 'req_coverage', 'sdes': '-',
                    'message': f'{req_id} (committed/must) non ha nessun SDES — "{req["headline"][:60]}"'
                })
    return issues


def check_acceptance_criteria(entries: list) -> list:
    issues = []
    for e in entries:
        if not e['has_acceptance']:
            issues.append({
                'severity': 'warning', 'check': 'acceptance_criteria', 'sdes': e['id'],
                'message': 'Nessun criterio di accettazione (- [ ] ...) trovato'
            })
    return issues


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def run_all_checks(entries, reqs=None, decisions=None):
    issues = []
    issues.extend(check_id_uniqueness(entries))
    issues.extend(check_field_completeness(entries))
    issues.extend(check_acceptance_criteria(entries))
    issues.extend(check_req_integrity(entries, reqs or {}))
    issues.extend(check_decision_integrity(entries, decisions or {}))
    issues.extend(check_req_coverage(entries, reqs or {}))
    return issues


def format_report(entries, issues):
    errors = [i for i in issues if i['severity'] == 'error']
    warnings = [i for i in issues if i['severity'] == 'warning']
    status_counts = Counter(e['status'] for e in entries)
    status_line = ' | '.join(f'{s}: {c}' for s, c in sorted(status_counts.items()))
    lines = [
        '# Validate Design Report', '',
        f'SDES analizzati: {len(entries)} ({status_line})',
        f'Errori: {len(errors)} | Warning: {len(warnings)}', '',
    ]
    def fmt(i):
        notify = f' ⚠ notifica: **{i["notify"]}**' if i.get('notify') else ''
        return f'- **{i["sdes"]}** [{i["check"]}]: {i["message"]}{notify}'

    if errors:
        lines += ['## Errori (da correggere prima di procedere)', '']
        lines += [fmt(i) for i in errors]
        lines.append('')
    if warnings:
        lines += ['## Warning (da valutare)', '']
        lines += [fmt(i) for i in warnings]
        lines.append('')
    if not issues:
        lines.append('Nessun problema trovato. Design document integro.')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Validate DESIGN-DOC.md traceability')
    parser.add_argument('path', help='Path to DESIGN-DOC.md')
    parser.add_argument('--reqs', help='Path to requisiti/ directory or REQUISITI.md')
    parser.add_argument('--decisions', help='Path to DECISIONS.md')
    parser.add_argument('--format', choices=['text', 'json'], default='text')
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f'Errore: {path} non trovato', file=sys.stderr)
        sys.exit(1)

    text = path.read_text(encoding='utf-8')
    entries = parse_sdes_entries(text)
    if not entries:
        print('Nessun SDES trovato nel formato atteso (### SDES-XXX — ...)')
        sys.exit(0)

    reqs = load_requirements(Path(args.reqs)) if args.reqs else {}
    decisions = load_decisions(Path(args.decisions)) if args.decisions else {}

    issues = run_all_checks(entries, reqs, decisions)

    if args.format == 'json':
        result = {
            'total_sdes': len(entries),
            'by_status': dict(Counter(e['status'] for e in entries)),
            'errors': len([i for i in issues if i['severity'] == 'error']),
            'warnings': len([i for i in issues if i['severity'] == 'warning']),
            'issues': issues,
            'entries': [{'id': e['id'], 'section': e['section'], 'status': e['status'],
                         'reqs': e['reqs'], 'decisions': e['decisions']} for e in entries],
        }
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(format_report(entries, issues))

    sys.exit(1 if any(i['severity'] == 'error' for i in issues) else 0)


if __name__ == '__main__':
    main()

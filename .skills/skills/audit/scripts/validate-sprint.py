#!/usr/bin/env python3
"""
validate-sprint.py — Validates that tasks in active sprints reference existing SDES entries.

Checks:
  1. Every task line in active sprints that contains (SDES-XXX) references a SDES
     that exists in DESIGN-DOC.md with a valid status (draft/approved/implemented).
     → notify: project-manager
  2. Every task line in active sprints has at least one SDES reference.
     → notify: project-manager

Precondition:
  If DESIGN-DOC.md does not exist, all checks are skipped (Sprint 0 / pre-design phase).

Active sprint detection:
  A sprint file is considered active if it does NOT contain the string "Stato: chiuso".

Usage:
  python validate-sprint.py --sprints docs/sprints/ --design docs/DESIGN-DOC.md
  python validate-sprint.py --sprints docs/sprints/ --design docs/DESIGN-DOC.md --format json

Output: human-readable report (default) or JSON (--format json)
"""

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SDES_REF = re.compile(r'SDES-\d+')
TASK_LINE = re.compile(r'^\s*-\s+\[[ x]\]')
VALID_SDES_STATUSES = {'draft', 'approved', 'implemented'}  # cancelled non ammesso — vedi STATUS-SCHEMA.md

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def is_active_sprint(text: str) -> bool:
    return 'Stato: chiuso' not in text


def parse_sprint_tasks(text: str, sprint_name: str) -> list:
    """
    Extract task lines from a sprint file.
    Returns list of {sprint, line_no, text, sdes_refs}.
    Only parses the "Da fare" / "Done" sections — skips "Waiting For".
    """
    tasks = []
    in_waiting = False
    for line_no, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        # Track section headers to skip "Waiting For"
        if stripped.startswith('## '):
            in_waiting = 'Waiting For' in stripped or 'Waiting' in stripped
            continue
        if in_waiting:
            continue
        if not TASK_LINE.match(line):
            continue
        sdes_refs = SDES_REF.findall(line)
        tasks.append({
            'sprint': sprint_name,
            'line_no': line_no,
            'text': stripped[:100],
            'sdes_refs': sdes_refs,
        })
    return tasks


def parse_design_doc(design_path: Path) -> dict:
    """Parse DESIGN-DOC.md. Returns {sdes_id: status}"""
    entries = {}
    if not design_path.exists():
        return entries
    text = design_path.read_text(encoding='utf-8')
    yaml_block = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)
    sdes_header = re.compile(r'^###\s+(SDES-\d+)\s*[—–-]\s*(.*)', re.MULTILINE)
    sections = re.split(r'(?=^### SDES-)', text, flags=re.MULTILINE)
    for section in sections:
        header = sdes_header.match(section)
        if not header:
            continue
        sdes_id = header.group(1).strip()
        yaml_match = yaml_block.search(section[header.end():])
        status = 'unknown'
        if yaml_match:
            for line in yaml_match.group(1).split('\n'):
                if line.strip().startswith('status:'):
                    _, _, v = line.partition(':')
                    status = v.strip().strip('"').strip("'")
                    break
        entries[sdes_id] = status
    return entries


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_sprint_tasks(tasks: list, design_entries: dict) -> list:
    issues = []
    for task in tasks:
        if not task['sdes_refs']:
            issues.append({
                'severity': 'warning',
                'check': 'task_no_sdes',
                'sprint': task['sprint'],
                'line': task['line_no'],
                'notify': 'project-manager',
                'message': f'Task senza riferimento SDES: "{task["text"]}"',
            })
            continue
        for sdes_id in task['sdes_refs']:
            if sdes_id not in design_entries:
                issues.append({
                    'severity': 'error',
                    'check': 'sdes_not_found',
                    'sprint': task['sprint'],
                    'line': task['line_no'],
                    'notify': 'project-manager',
                    'message': f'{sdes_id} non trovato in DESIGN-DOC.md — "{task["text"]}"',
                })
            elif design_entries[sdes_id] == 'cancelled':
                issues.append({
                    'severity': 'error',
                    'check': 'sdes_cancelled',
                    'sprint': task['sprint'],
                    'line': task['line_no'],
                    'notify': 'project-manager',
                    'message': f'{sdes_id} è cancelled — rimuovere il task o aggiornare il riferimento SDES: "{task["text"]}"',
                })
            elif design_entries[sdes_id] not in VALID_SDES_STATUSES:
                issues.append({
                    'severity': 'error',
                    'check': 'sdes_invalid_status',
                    'sprint': task['sprint'],
                    'line': task['line_no'],
                    'notify': 'project-manager',
                    'message': f'{sdes_id} ha status="{design_entries[sdes_id]}" (non valido) — "{task["text"]}"',
                })
    return issues


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def format_report(active_sprints: list, tasks: list, issues: list) -> str:
    errors = [i for i in issues if i['severity'] == 'error']
    warnings = [i for i in issues if i['severity'] == 'warning']

    lines = [
        '# Validate Sprint Report', '',
        f'Sprint attivi analizzati: {len(active_sprints)} ({", ".join(active_sprints)})',
        f'Task analizzati: {len(tasks)}',
        f'Errori: {len(errors)} | Warning: {len(warnings)}', '',
    ]

    def fmt(i):
        notify = f' ⚠ notifica: **{i["notify"]}**' if i.get('notify') else ''
        return f'- **[{i["sprint"]} L{i["line"]}]** [{i["check"]}]: {i["message"]}{notify}'

    if errors:
        lines += ['## Errori (task con SDES non esistente)', '']
        lines += [fmt(i) for i in errors]
        lines.append('')
    if warnings:
        lines += ['## Warning (task senza SDES)', '']
        lines += [fmt(i) for i in warnings]
        lines.append('')
    if not issues:
        lines.append('Tutti i task degli sprint attivi sono collegati a SDES validi.')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Validate sprint tasks → SDES traceability')
    parser.add_argument('--sprints', required=True, help='Path to docs/sprints/ directory')
    parser.add_argument('--design', required=True, help='Path to DESIGN-DOC.md')
    parser.add_argument('--format', choices=['text', 'json'], default='text')
    args = parser.parse_args()

    sprints_path = Path(args.sprints)
    design_path = Path(args.design)

    if not sprints_path.exists():
        print(f'Errore: {sprints_path} non trovata', file=sys.stderr)
        sys.exit(1)

    if not design_path.exists():
        msg = 'DESIGN-DOC.md non ancora creato — check saltato (fase pre-design, Sprint 0)'
        if args.format == 'json':
            print(json.dumps({'skipped': True, 'reason': msg}))
        else:
            print(f'INFO: {msg}')
        sys.exit(0)

    design_entries = parse_design_doc(design_path)

    all_tasks = []
    active_sprint_names = []

    for sprint_file in sorted(sprints_path.glob('sprint-*.md')):
        text = sprint_file.read_text(encoding='utf-8')
        if not is_active_sprint(text):
            continue
        sprint_name = sprint_file.stem
        active_sprint_names.append(sprint_name)
        tasks = parse_sprint_tasks(text, sprint_name)
        all_tasks.extend(tasks)

    if not active_sprint_names:
        msg = 'Nessuno sprint attivo trovato.'
        if args.format == 'json':
            print(json.dumps({'skipped': True, 'reason': msg}))
        else:
            print(f'INFO: {msg}')
        sys.exit(0)

    issues = check_sprint_tasks(all_tasks, design_entries)

    if args.format == 'json':
        result = {
            'active_sprints': active_sprint_names,
            'tasks_checked': len(all_tasks),
            'errors': len([i for i in issues if i['severity'] == 'error']),
            'warnings': len([i for i in issues if i['severity'] == 'warning']),
            'issues': issues,
        }
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(format_report(active_sprint_names, all_tasks, issues))

    sys.exit(1 if any(i['severity'] == 'error' for i in issues) else 0)


if __name__ == '__main__':
    main()

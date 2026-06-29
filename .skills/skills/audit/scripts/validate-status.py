#!/usr/bin/env python3
"""
validate-status.py — Validates that all artifact status values conform to STATUS-SCHEMA.md.

Reads valid status values from docs/STATUS-SCHEMA.md (source of truth), then checks:
  1. Requirements (docs/requisiti/): field 'status' in YAML frontmatter
  2. SDES (docs/DESIGN-DOC.md): field 'status' in YAML frontmatter
  3. UAT (docs/UAT/): field 'status' in YAML frontmatter
  4. Sprints (docs/sprints/): '> Stato: VALUE' in header
  5. Decisions (docs/DECISIONS.md): Status column pattern validity

Also detects drift between STATUS-SCHEMA.md and the constants hardcoded in
validate.py and validate-design.py — alerts if a script uses a status value
not declared in STATUS-SCHEMA.md.

Usage:
  python validate-status.py --schema docs/STATUS-SCHEMA.md --root .
  python validate-status.py --schema docs/STATUS-SCHEMA.md --root . --format json

Output: human-readable report (default) or JSON (--format json)
"""

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Schema parsing
# ---------------------------------------------------------------------------

ARTIFACT_HEADER = re.compile(r'^###\s+artifact:(\S+)', re.MULTILINE)
STATUS_VALUE = re.compile(r'^\|\s*`([^`]+)`', re.MULTILINE)


def parse_schema(schema_path: Path) -> dict:
    """
    Parse STATUS-SCHEMA.md.
    Returns: {artifact_name: set_of_valid_status_values}
    Handles the special case of decision status '*(vuoto)*' → represented as ''
    """
    text = schema_path.read_text(encoding='utf-8')
    schema = {}
    sections = ARTIFACT_HEADER.split(text)
    # sections[0] = preamble, then pairs: (artifact_name, section_text)
    it = iter(sections[1:])
    for artifact_name in it:
        section_text = next(it, '')
        # Extract status values (backtick-quoted in table rows)
        values = set(STATUS_VALUE.findall(section_text))
        # Handle decision empty status: look for '*(vuoto)*' row
        if artifact_name == 'decision' and '*(vuoto)*' in section_text:
            values.add('')
        schema[artifact_name] = values
    return schema


# ---------------------------------------------------------------------------
# Artifact parsers
# ---------------------------------------------------------------------------

YAML_BLOCK = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)


def parse_yaml_field(text: str, field: str) -> str:
    m = YAML_BLOCK.search(text)
    if not m:
        return ''
    for line in m.group(1).split('\n'):
        if line.strip().startswith(f'{field}:'):
            _, _, v = line.partition(':')
            return v.strip().strip('"').strip("'")
    return ''


def load_requirements(reqs_path: Path) -> list:
    """Returns list of {id, status, file}"""
    results = []
    if not reqs_path.exists():
        return results
    req_header = re.compile(r'^###\s+(REQ-\S+)', re.MULTILINE)
    for f in sorted(reqs_path.glob('**/*.md')):
        text = f.read_text(encoding='utf-8')
        sections = re.split(r'(?=^### REQ-)', text, flags=re.MULTILINE)
        for section in sections:
            header = req_header.match(section)
            if not header:
                continue
            req_id = header.group(1).strip()
            status = parse_yaml_field(section[header.end():], 'status')
            results.append({'id': req_id, 'status': status, 'file': str(f)})
    return results


def load_sdes(design_path: Path) -> list:
    """Returns list of {id, status, file}"""
    results = []
    if not design_path.exists():
        return results
    text = design_path.read_text(encoding='utf-8')
    sdes_header = re.compile(r'^###\s+(SDES-\d+)', re.MULTILINE)
    sections = re.split(r'(?=^### SDES-)', text, flags=re.MULTILINE)
    for section in sections:
        header = sdes_header.match(section)
        if not header:
            continue
        sdes_id = header.group(1).strip()
        status = parse_yaml_field(section[header.end():], 'status')
        results.append({'id': sdes_id, 'status': status, 'file': str(design_path)})
    return results


def load_uat(uat_path: Path) -> list:
    """Returns list of {id, status, file}"""
    results = []
    if not uat_path.exists():
        return results
    for f in sorted(uat_path.glob('UAT-*.md')):
        text = f.read_text(encoding='utf-8')
        status = parse_yaml_field(text, 'status')
        uat_id = parse_yaml_field(text, 'id') or f.stem
        results.append({'id': uat_id, 'status': status, 'file': str(f)})
    return results


SPRINT_STATO = re.compile(r'>\s*Stato:\s*(\S+)', re.IGNORECASE)


def load_sprints(sprints_path: Path) -> list:
    """Returns list of {id, status, file}"""
    results = []
    if not sprints_path.exists():
        return results
    for f in sorted(sprints_path.glob('sprint-*.md')):
        text = f.read_text(encoding='utf-8')
        # Read only first 10 lines for header
        header_text = '\n'.join(text.splitlines()[:10])
        m = SPRINT_STATO.search(header_text)
        status = m.group(1).rstrip('|').strip() if m else ''
        results.append({'id': f.stem, 'status': status, 'file': str(f)})
    return results


DECISION_ROW = re.compile(r'^\|\s*(D-\d+)\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([^|]*?)\s*\|', re.MULTILINE)


def load_decisions(decisions_path: Path) -> list:
    """Returns list of {id, status, file}"""
    results = []
    if not decisions_path.exists():
        return results
    text = decisions_path.read_text(encoding='utf-8')
    for m in DECISION_ROW.finditer(text):
        d_id = m.group(1).strip()
        raw_status = m.group(2).strip()
        # Normalize: '→ D-XXX' stays as is, 'annullata' stays, empty → ''
        results.append({'id': d_id, 'status': raw_status, 'file': str(decisions_path)})
    return results


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_artifact(artifacts: list, valid_statuses: set, artifact_type: str) -> list:
    """Check each artifact's status against the schema."""
    issues = []
    for a in artifacts:
        status = a['status']
        # For decisions: superseded values start with '→'
        normalized = status if artifact_type != 'decision' else (
            '→ D-XXX' if status.startswith('→') else status
        )
        if normalized not in valid_statuses:
            issues.append({
                'severity': 'error',
                'check': 'invalid_status',
                'artifact': artifact_type,
                'id': a['id'],
                'file': a['file'],
                'message': f'Status non valido: "{status}" — valori ammessi: {sorted(str(s) for s in valid_statuses)}',
            })
    return issues


def validate_missing_status(artifacts: list, artifact_type: str) -> list:
    """Flag artifacts with empty status (not allowed for non-decision artifacts)."""
    if artifact_type == 'decision':
        return []  # empty is valid for active decisions
    issues = []
    for a in artifacts:
        if not a['status']:
            issues.append({
                'severity': 'error',
                'check': 'missing_status',
                'artifact': artifact_type,
                'id': a['id'],
                'file': a['file'],
                'message': 'Campo status mancante o vuoto',
            })
    return issues


# ---------------------------------------------------------------------------
# Script drift detection
# ---------------------------------------------------------------------------

def _resolve_skill_root():
    """Resolve SKILL_ROOT from env var, falling back to docs/_skills/ for legacy."""
    return os.environ.get('SKILL_ROOT', 'docs/_skills')

SCRIPT_CONSTANTS = {
    'requirement': {
        'file': lambda: f'{_resolve_skill_root()}/requirements-engineer/scripts/validate.py',
        'pattern': re.compile(r'VALID_STATUSES\s*=\s*\{([^}]+)\}'),
    },
    'sdes': {
        'file': lambda: f'{_resolve_skill_root()}/design/scripts/validate-design.py',
        'pattern': re.compile(r'VALID_STATUSES\s*=\s*\{([^}]+)\}'),
    },
}


def check_script_drift(schema: dict, root: Path) -> list:
    """
    Compare schema status values against constants hardcoded in validation scripts.
    Flags values present in scripts but absent from schema, and vice versa.
    """
    issues = []
    for artifact, info in SCRIPT_CONSTANTS.items():
        file_path = info['file']() if callable(info['file']) else info['file']
        script_path = root / file_path
        if not script_path.exists():
            continue
        text = script_path.read_text(encoding='utf-8')
        m = info['pattern'].search(text)
        if not m:
            continue
        # Extract quoted string values from the set literal
        script_values = set(re.findall(r'["\']([^"\']+)["\']', m.group(1)))
        schema_values = schema.get(artifact, set())
        in_script_not_schema = script_values - schema_values
        in_schema_not_script = schema_values - script_values - {''}
        for v in in_script_not_schema:
            issues.append({
                'severity': 'warning',
                'check': 'schema_drift',
                'artifact': artifact,
                'id': '-',
                'file': str(script_path),
                'message': f'Valore "{v}" presente nello script ma non in STATUS-SCHEMA.md — aggiornare lo schema',
            })
        for v in in_schema_not_script:
            issues.append({
                'severity': 'warning',
                'check': 'schema_drift',
                'artifact': artifact,
                'id': '-',
                'file': str(script_path),
                'message': f'Valore "{v}" presente in STATUS-SCHEMA.md ma non nello script — aggiornare lo script',
            })
    return issues


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def format_report(results: dict, issues: list) -> str:
    errors = [i for i in issues if i['severity'] == 'error']
    warnings = [i for i in issues if i['severity'] == 'warning']

    lines = ['# Status Schema Validation Report', '']
    for artifact, items in results.items():
        lines.append(f'- **{artifact}**: {len(items)} artifact analizzati')
    lines += ['', f'Errori: {len(errors)} | Warning: {len(warnings)}', '']

    def fmt(i):
        return f'- **{i["artifact"]}/{i["id"]}** [{i["check"]}]: {i["message"]}\n  `{i["file"]}`'

    if errors:
        lines += ['## Errori (status non valido)', '']
        lines += [fmt(i) for i in errors]
        lines.append('')
    if warnings:
        lines += ['## Warning (drift schema ↔ script)', '']
        lines += [fmt(i) for i in warnings]
        lines.append('')
    if not issues:
        lines.append('Tutti gli artifact rispettano lo schema. Nessun drift rilevato.')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Validate artifact status values against STATUS-SCHEMA.md')
    parser.add_argument('--schema', required=True, help='Path to STATUS-SCHEMA.md')
    parser.add_argument('--root', default='.', help='Root of the repository (default: .)')
    parser.add_argument('--format', choices=['text', 'json'], default='text')
    args = parser.parse_args()

    schema_path = Path(args.schema)
    root = Path(args.root)

    if not schema_path.exists():
        print(f'Errore: {schema_path} non trovato', file=sys.stderr)
        sys.exit(1)

    schema = parse_schema(schema_path)

    loaders = {
        'requirement': lambda: load_requirements(root / 'docs/requisiti'),
        'sdes':        lambda: load_sdes(root / 'docs/DESIGN-DOC.md'),
        'uat':         lambda: load_uat(root / 'docs/UAT'),
        'sprint':      lambda: load_sprints(root / 'docs/sprints'),
        'decision':    lambda: load_decisions(root / 'docs/DECISIONS.md'),
    }

    results = {}
    all_issues = []

    for artifact, loader in loaders.items():
        items = loader()
        results[artifact] = items
        if artifact not in schema:
            continue
        valid = schema[artifact]
        all_issues.extend(validate_missing_status(items, artifact))
        all_issues.extend(validate_artifact(items, valid, artifact))

    # Drift detection
    all_issues.extend(check_script_drift(schema, root))

    if args.format == 'json':
        output = {
            'schema_artifacts': list(schema.keys()),
            'artifact_counts': {k: len(v) for k, v in results.items()},
            'errors': len([i for i in all_issues if i['severity'] == 'error']),
            'warnings': len([i for i in all_issues if i['severity'] == 'warning']),
            'issues': all_issues,
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        print(format_report(results, all_issues))

    sys.exit(1 if any(i['severity'] == 'error' for i in all_issues) else 0)


if __name__ == '__main__':
    main()

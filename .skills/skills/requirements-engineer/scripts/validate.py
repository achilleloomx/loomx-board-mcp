#!/usr/bin/env python3
"""
validate.py — Validates atomic requirements files.

Checks:
  1. ID uniqueness across all files
  2. Required YAML fields present (id, headline, type, priority, source, status, status_date)
  3. Dependency integrity (every depends: REQ-XXX exists)
  4. Headline similarity via TF-IDF cosine (flags pairs > threshold)
  5. Draft vs existing overlap (draft headlines checked against proposed/committed)
  6. Atomicity heuristic (conjunction signals in headline + body)
  7. Gap analysis vs DOMAIN-KB.md sections (if present)
  8. Glossary coverage (checks terms used in requirements against GLOSSARIO.md)

Usage:
  python validate.py REQUISITI.md
  python validate.py requisiti/
  python validate.py REQUISITI.md --domain-kb DOMAIN-KB.md --glossary GLOSSARIO.md
  python validate.py requisiti/ --domain-kb DOMAIN-KB.md --format json

Output: human-readable report (default) or JSON (--format json)
"""

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {"id", "headline", "type", "priority", "source", "status", "status_date"}
VALID_TYPES = {"funzionale", "non-funzionale", "contenuto", "ux", "vincolo", "business-rule", "integrazione"}
VALID_PRIORITIES = {"must", "should", "could", "wont"}
VALID_STATUSES = {"draft", "proposed", "committed", "cancelled"}  # see docs/STATUS-SCHEMA.md

SIMILARITY_THRESHOLD = 0.6
DRAFT_VS_EXISTING_THRESHOLD = 0.5  # lower threshold for draft-vs-committed

ATOMICITY_SIGNALS = re.compile(
    r'\b(e inoltre|e anche|inoltre|nonché|and also|as well as|in addition)\b',
    re.IGNORECASE
)
MULTI_AND = re.compile(r'(?:^|\. )[^.]*\b(?:e|and)\b[^.]*\b(?:e|and)\b', re.IGNORECASE)

REQ_HEADER = re.compile(r'^###\s+(REQ-\S+)\s*[—–-]\s*(.*)', re.MULTILINE)
YAML_BLOCK = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)

# Italian stop words for TF-IDF
STOP_WORDS = {
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da",
    "in", "con", "su", "per", "tra", "fra", "del", "dello", "della", "dei",
    "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle", "dal",
    "dallo", "dalla", "dai", "dagli", "dalle", "nel", "nello", "nella",
    "nei", "negli", "nelle", "sul", "sullo", "sulla", "sui", "sugli",
    "sulle", "che", "non", "è", "sono", "essere", "deve", "devono",
    "e", "o", "ma", "se", "come", "più", "anche", "questo", "questa",
    "questi", "queste", "the", "a", "an", "is", "are", "and", "or",
    "of", "to", "in", "for", "with", "on", "must", "should", "be",
}


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_requirements(text: str, filepath: str) -> list:
    reqs = []
    sections = re.split(r'(?=^### REQ-)', text, flags=re.MULTILINE)
    for section in sections:
        header_match = REQ_HEADER.match(section)
        if not header_match:
            continue
        req_id = header_match.group(1).strip()
        title = header_match.group(2).strip()
        yaml_match = YAML_BLOCK.search(section[header_match.end():])
        fields = {}
        if yaml_match:
            for line in yaml_match.group(1).split('\n'):
                if ':' in line:
                    key, _, val = line.partition(':')
                    fields[key.strip().lower()] = val.strip().strip('"').strip("'")
        body_start = header_match.end()
        if yaml_match:
            body_start += yaml_match.end()
        body = section[body_start:].strip()
        has_acceptance = bool(re.search(r'\*\*Accettazione', section, re.IGNORECASE))
        headline = fields.get("headline", title)
        reqs.append({
            "id": req_id,
            "title": title,
            "headline": headline,
            "fields": fields,
            "body": body,
            "has_acceptance": has_acceptance,
            "file": filepath,
            "raw": section,
        })
    return reqs


def load_requirements(path: Path) -> list:
    all_reqs = []
    if path.is_file():
        text = path.read_text(encoding="utf-8")
        all_reqs.extend(parse_requirements(text, str(path)))
    elif path.is_dir():
        for f in sorted(path.glob("**/*.md")):
            text = f.read_text(encoding="utf-8")
            all_reqs.extend(parse_requirements(text, str(f)))
    return all_reqs


def load_domain_sections(domain_kb_path: Path) -> list:
    if not domain_kb_path.exists():
        return []
    text = domain_kb_path.read_text(encoding="utf-8")
    return re.findall(r'^##\s+(.+)', text, re.MULTILINE)


def load_glossary_terms(glossary_path: Path) -> list:
    if not glossary_path.exists():
        return []
    text = glossary_path.read_text(encoding="utf-8")
    # Parse terms from ### headers in glossary
    return [m.strip().lower() for m in re.findall(r'^###\s+(.+)', text, re.MULTILINE)]


# ---------------------------------------------------------------------------
# TF-IDF similarity (pure Python, no dependencies)
# ---------------------------------------------------------------------------

def tokenize(text: str) -> list:
    words = re.findall(r'\b[a-zA-ZàèéìòùÀÈÉÌÒÙ]{2,}\b', text.lower())
    return [w for w in words if w not in STOP_WORDS]


def compute_tfidf(docs: list) -> list:
    tokenized = [tokenize(d) for d in docs]
    # Document frequency
    df = Counter()
    for tokens in tokenized:
        for t in set(tokens):
            df[t] += 1
    n = len(docs)
    tfidf_vectors = []
    for tokens in tokenized:
        tf = Counter(tokens)
        total = len(tokens) if tokens else 1
        vec = {}
        for t, count in tf.items():
            idf = math.log((n + 1) / (df[t] + 1)) + 1
            vec[t] = (count / total) * idf
        tfidf_vectors.append(vec)
    return tfidf_vectors


def cosine_sim(v1: dict, v2: dict) -> float:
    common = set(v1.keys()) & set(v2.keys())
    if not common:
        return 0.0
    dot = sum(v1[k] * v2[k] for k in common)
    mag1 = math.sqrt(sum(v ** 2 for v in v1.values()))
    mag2 = math.sqrt(sum(v ** 2 for v in v2.values()))
    if mag1 == 0 or mag2 == 0:
        return 0.0
    return dot / (mag1 * mag2)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_id_uniqueness(reqs):
    issues = []
    seen = {}
    for r in reqs:
        if r["id"] in seen:
            issues.append({
                "severity": "error",
                "check": "id_uniqueness",
                "req": r["id"],
                "message": f'ID duplicato: {r["id"]} appare in {seen[r["id"]]} e {r["file"]}'
            })
        else:
            seen[r["id"]] = r["file"]
    return issues


def check_required_fields(reqs):
    issues = []
    for r in reqs:
        missing = REQUIRED_FIELDS - set(r["fields"].keys())
        if missing:
            issues.append({
                "severity": "error",
                "check": "required_fields",
                "req": r["id"],
                "message": f'Campi mancanti: {", ".join(sorted(missing))}'
            })
        t = r["fields"].get("type", "")
        if t and t not in VALID_TYPES:
            issues.append({
                "severity": "warning", "check": "field_value", "req": r["id"],
                "message": f'Type non standard: "{t}"'
            })
        p = r["fields"].get("priority", "")
        if p and p not in VALID_PRIORITIES:
            issues.append({
                "severity": "warning", "check": "field_value", "req": r["id"],
                "message": f'Priority non standard: "{p}"'
            })
        s = r["fields"].get("status", "")
        if s and s not in VALID_STATUSES:
            issues.append({
                "severity": "warning", "check": "field_value", "req": r["id"],
                "message": f'Status non standard: "{s}"'
            })
    return issues


def check_acceptance(reqs):
    issues = []
    for r in reqs:
        if not r["has_acceptance"]:
            issues.append({
                "severity": "warning", "check": "acceptance_criteria",
                "req": r["id"], "message": "Criteri di accettazione mancanti"
            })
    return issues


def check_dependencies(reqs):
    issues = []
    all_ids = {r["id"] for r in reqs}
    for r in reqs:
        deps_str = r["fields"].get("depends", "")
        if not deps_str:
            continue
        for dep in [d.strip() for d in deps_str.split(",") if d.strip()]:
            if dep not in all_ids:
                issues.append({
                    "severity": "error", "check": "dependency_integrity",
                    "req": r["id"], "message": f'Dipendenza rotta: {dep} non esiste'
                })
    return issues


def check_atomicity(reqs):
    issues = []
    for r in reqs:
        # Check both headline and body
        for field, label in [("headline", "headline"), ("body", "descrizione")]:
            text = r.get(field, "")
            if ATOMICITY_SIGNALS.search(text):
                issues.append({
                    "severity": "warning", "check": "atomicity", "req": r["id"],
                    "message": f'Possibile requisito non atomico nella {label} (congiunzioni multiple)'
                })
                break
            elif MULTI_AND.search(text):
                issues.append({
                    "severity": "info", "check": "atomicity", "req": r["id"],
                    "message": f'Possibile requisito composito nella {label}'
                })
                break
    return issues


def check_headline_similarity(reqs):
    issues = []
    if len(reqs) < 2:
        return issues
    headlines = [r["headline"] for r in reqs]
    vectors = compute_tfidf(headlines)

    # All-pairs similarity
    for i in range(len(reqs)):
        for j in range(i + 1, len(reqs)):
            sim = cosine_sim(vectors[i], vectors[j])
            if sim >= SIMILARITY_THRESHOLD:
                issues.append({
                    "severity": "warning",
                    "check": "headline_similarity",
                    "req": f'{reqs[i]["id"]} ↔ {reqs[j]["id"]}',
                    "message": f'Headline simili (cosine={sim:.2f}): "{reqs[i]["headline"]}" ↔ "{reqs[j]["headline"]}"'
                })
    return issues


def check_draft_vs_existing(reqs):
    issues = []
    drafts = [r for r in reqs if r["fields"].get("status") == "draft"]
    existing = [r for r in reqs if r["fields"].get("status") in ("proposed", "committed")]
    if not drafts or not existing:
        return issues
    all_headlines = [r["headline"] for r in drafts + existing]
    vectors = compute_tfidf(all_headlines)
    n_drafts = len(drafts)
    for i in range(n_drafts):
        for j in range(n_drafts, len(all_headlines)):
            sim = cosine_sim(vectors[i], vectors[j])
            if sim >= DRAFT_VS_EXISTING_THRESHOLD:
                existing_req = existing[j - n_drafts]
                status = existing_req["fields"].get("status", "?")
                issues.append({
                    "severity": "warning",
                    "check": "draft_vs_existing",
                    "req": f'{drafts[i]["id"]} → {existing_req["id"]}',
                    "message": f'DRAFT {drafts[i]["id"]} simile a {status.upper()} {existing_req["id"]} (cosine={sim:.2f}): "{drafts[i]["headline"]}" ↔ "{existing_req["headline"]}"'
                })
    return issues


def check_domain_coverage(reqs, domain_sections):
    if not domain_sections:
        return []
    issues = []
    all_text = " ".join(r["body"].lower() + " " + r["headline"].lower() for r in reqs)
    for section in domain_sections:
        keywords = section.lower().split()
        if not any(kw in all_text for kw in keywords if len(kw) > 3):
            issues.append({
                "severity": "info", "check": "domain_coverage", "req": "-",
                "message": f'Area del dominio potenzialmente non coperta: "{section}"'
            })
    return issues


def check_glossary_usage(reqs, glossary_terms):
    """Flag requirements that use terms not in the glossary."""
    if not glossary_terms:
        return []
    issues = []
    # Extract all unique nouns/terms from requirements that look like domain terms
    # (capitalized or in quotes) and check against glossary
    term_set = set(glossary_terms)
    undefined_terms = Counter()
    for r in reqs:
        text = r["headline"] + " " + r["body"]
        # Find terms in quotes or backticks that might be domain terms
        quoted = re.findall(r'["`]([^"`]+)["`]', text)
        for term in quoted:
            if term.lower() not in term_set and len(term.split()) <= 3:
                undefined_terms[term.lower()] += 1
    for term, count in undefined_terms.most_common():
        if count >= 2:  # only flag if used in 2+ requirements
            issues.append({
                "severity": "info", "check": "glossary_coverage", "req": "-",
                "message": f'Termine usato {count} volte ma non nel glossario: "{term}"'
            })
    return issues


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def run_all_checks(reqs, domain_sections=None, glossary_terms=None):
    issues = []
    issues.extend(check_id_uniqueness(reqs))
    issues.extend(check_required_fields(reqs))
    issues.extend(check_acceptance(reqs))
    issues.extend(check_dependencies(reqs))
    issues.extend(check_atomicity(reqs))
    issues.extend(check_headline_similarity(reqs))
    issues.extend(check_draft_vs_existing(reqs))
    if domain_sections:
        issues.extend(check_domain_coverage(reqs, domain_sections))
    if glossary_terms:
        issues.extend(check_glossary_usage(reqs, glossary_terms))
    return issues


def format_report(reqs, issues):
    errors = [i for i in issues if i["severity"] == "error"]
    warnings = [i for i in issues if i["severity"] == "warning"]
    infos = [i for i in issues if i["severity"] == "info"]

    # Status summary
    status_counts = Counter(r["fields"].get("status", "unknown") for r in reqs)
    status_line = " | ".join(f"{s}: {c}" for s, c in sorted(status_counts.items()))

    lines = [
        "# Validation Report", "",
        f"Requisiti analizzati: {len(reqs)} ({status_line})",
        f"Errori: {len(errors)} | Warning: {len(warnings)} | Info: {len(infos)}", "",
    ]
    if errors:
        lines += ["## Errori (da correggere)", ""]
        lines += [f"- **{i['req']}** [{i['check']}]: {i['message']}" for i in errors]
        lines.append("")
    if warnings:
        lines += ["## Warning (da valutare)", ""]
        lines += [f"- **{i['req']}** [{i['check']}]: {i['message']}" for i in warnings]
        lines.append("")
    if infos:
        lines += ["## Info", ""]
        lines += [f"- **{i['req']}** [{i['check']}]: {i['message']}" for i in infos]
        lines.append("")
    if not issues:
        lines.append("Nessun problema trovato.")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Validate atomic requirements files")
    parser.add_argument("path", help="File .md or directory with .md files")
    parser.add_argument("--domain-kb", help="Path to DOMAIN-KB.md for gap analysis")
    parser.add_argument("--glossary", help="Path to GLOSSARIO.md for term coverage")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"Errore: {path} non trovato", file=sys.stderr)
        sys.exit(1)

    reqs = load_requirements(path)
    if not reqs:
        print("Nessun requisito trovato nel formato atteso (### REQ-XXX — ...)")
        sys.exit(0)

    domain_sections = load_domain_sections(Path(args.domain_kb)) if args.domain_kb else []
    glossary_terms = load_glossary_terms(Path(args.glossary)) if args.glossary else []

    issues = run_all_checks(reqs, domain_sections, glossary_terms)

    if args.format == "json":
        result = {
            "total_requirements": len(reqs),
            "by_status": dict(Counter(r["fields"].get("status", "unknown") for r in reqs)),
            "errors": len([i for i in issues if i["severity"] == "error"]),
            "warnings": len([i for i in issues if i["severity"] == "warning"]),
            "info": len([i for i in issues if i["severity"] == "info"]),
            "issues": issues,
            "requirements": [{"id": r["id"], "headline": r["headline"],
                              "status": r["fields"].get("status", ""),
                              "file": r["file"]} for r in reqs],
        }
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(format_report(reqs, issues))

    sys.exit(1 if any(i["severity"] == "error" for i in issues) else 0)


if __name__ == "__main__":
    main()

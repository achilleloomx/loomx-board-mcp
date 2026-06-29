#!/usr/bin/env python3
"""
review.py — Prepares a compact review payload for Claude semantic review.

Takes validate.py JSON output and the requirements files, selects flagged items
plus a random sample of clean ones, and outputs a review-payload.json ready for
Claude to process.

Usage:
  python validate.py REQUISITI.md --format json > validation.json
  python review.py validation.json REQUISITI.md
  python review.py validation.json requisiti/ --sample-size 5

The output (review-payload.json) is a compact JSON that Claude reads and
uses to perform semantic review: atomicity, overlap, headline quality,
acceptance testability, ambiguity, completeness, and split proposals.
"""

import argparse
import json
import random
import re
import sys
from pathlib import Path

REQ_HEADER = re.compile(r'^###\s+(REQ-\S+)\s*[—–-]\s*(.*)', re.MULTILINE)
YAML_BLOCK = re.compile(r'^---\s*\n(.*?)\n---', re.MULTILINE | re.DOTALL)

DEFAULT_SAMPLE_SIZE = 5
MAX_PAYLOAD_ITEMS = 30  # hard cap to control token usage


def parse_requirements(text: str, filepath: str) -> dict:
    reqs = {}
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
        reqs[req_id] = {
            "id": req_id,
            "headline": fields.get("headline", title),
            "type": fields.get("type", ""),
            "priority": fields.get("priority", ""),
            "status": fields.get("status", ""),
            "body": body[:500],  # truncate to save tokens
        }
    return reqs


def load_all_requirements(path: Path) -> dict:
    all_reqs = {}
    if path.is_file():
        text = path.read_text(encoding="utf-8")
        all_reqs.update(parse_requirements(text, str(path)))
    elif path.is_dir():
        for f in sorted(path.glob("**/*.md")):
            text = f.read_text(encoding="utf-8")
            all_reqs.update(parse_requirements(text, str(f)))
    return all_reqs


def select_for_review(validation: dict, all_reqs: dict, sample_size: int) -> dict:
    """Select requirements for semantic review based on validation output."""
    flagged_ids = set()
    similarity_pairs = []

    for issue in validation.get("issues", []):
        req_field = issue.get("req", "")
        check = issue.get("check", "")

        # Extract IDs from various formats
        if "↔" in req_field:
            ids = [r.strip() for r in req_field.split("↔")]
            flagged_ids.update(ids)
            if check in ("headline_similarity", "draft_vs_existing"):
                similarity_pairs.append({
                    "ids": ids,
                    "check": check,
                    "message": issue["message"],
                })
        elif "→" in req_field:
            ids = [r.strip() for r in req_field.split("→")]
            flagged_ids.update(ids)
            if check in ("headline_similarity", "draft_vs_existing"):
                similarity_pairs.append({
                    "ids": ids,
                    "check": check,
                    "message": issue["message"],
                })
        elif req_field in all_reqs:
            flagged_ids.add(req_field)

    # Build flagged items with their issues
    flagged_items = []
    for req_id in flagged_ids:
        if req_id not in all_reqs:
            continue
        req = all_reqs[req_id]
        req_issues = [
            i for i in validation["issues"]
            if req_id in i.get("req", "")
        ]
        flagged_items.append({
            **req,
            "issues": [{"check": i["check"], "message": i["message"]} for i in req_issues],
        })

    # Random sample of clean items (no issues)
    clean_ids = [rid for rid in all_reqs if rid not in flagged_ids]
    sample_count = min(sample_size, len(clean_ids))
    sampled_ids = random.sample(clean_ids, sample_count) if clean_ids else []
    sampled_items = [
        {**all_reqs[rid], "issues": []}
        for rid in sampled_ids
    ]

    # Cap total
    total = flagged_items + sampled_items
    if len(total) > MAX_PAYLOAD_ITEMS:
        # Keep all flagged, reduce sample
        total = flagged_items[:MAX_PAYLOAD_ITEMS - sample_count] + sampled_items

    return {
        "review_items": total,
        "similarity_pairs": similarity_pairs,
        "stats": {
            "total_requirements": validation.get("total_requirements", 0),
            "flagged_for_review": len(flagged_items),
            "random_sample": len(sampled_items),
            "total_in_payload": len(total),
        },
    }


REVIEW_INSTRUCTIONS = """
Review each requirement below. For each item, evaluate:

1. ATOMICITY: Does it capture exactly ONE capability/constraint? If not, propose specific splits.
   Output: "atomic" | "split" (with proposed sub-headlines)

2. HEADLINE QUALITY: Is the headline self-explanatory and specific enough to detect overlaps?
   Output: "good" | "rewrite" (with proposed new headline)

3. ACCEPTANCE TESTABILITY: Are the acceptance criteria concrete and verifiable?
   Output: "testable" | "vague" (with specific improvement)

4. AMBIGUITY: Any vague terms ("adeguato", "efficiente", "buono", "appropriato")?
   Output: "clear" | "ambiguous" (list the vague terms + suggested replacements)

5. COMPLETENESS: Is anything missing for implementation?
   Output: "complete" | "incomplete" (what's missing)

For SIMILARITY PAIRS: are they true duplicates (merge), partial overlaps (refactor), or false positives (ok)?
   Output: "merge" | "refactor" (explain how) | "ok"

Return a JSON array with one object per reviewed item:
{
  "id": "REQ-XXX",
  "atomicity": {"verdict": "split", "proposed": ["headline 1", "headline 2"]},
  "headline": {"verdict": "good"},
  "acceptance": {"verdict": "vague", "suggestion": "..."},
  "ambiguity": {"verdict": "clear"},
  "completeness": {"verdict": "complete"},
  "action": "split | merge:REQ-YYY | rewrite | ok"
}
""".strip()


def main():
    parser = argparse.ArgumentParser(description="Prepare semantic review payload")
    parser.add_argument("validation_json", help="Output of validate.py --format json")
    parser.add_argument("requirements_path", help="REQUISITI.md or requisiti/ directory")
    parser.add_argument("--sample-size", type=int, default=DEFAULT_SAMPLE_SIZE)
    parser.add_argument("--output", default="review-payload.json")
    args = parser.parse_args()

    validation = json.loads(Path(args.validation_json).read_text(encoding="utf-8"))
    all_reqs = load_all_requirements(Path(args.requirements_path))

    payload = select_for_review(validation, all_reqs, args.sample_size)
    payload["instructions"] = REVIEW_INSTRUCTIONS

    output_path = Path(args.output)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Review payload: {output_path}")
    print(f"  Flagged: {payload['stats']['flagged_for_review']}")
    print(f"  Random sample: {payload['stats']['random_sample']}")
    print(f"  Total in payload: {payload['stats']['total_in_payload']}")
    print(f"  Similarity pairs: {len(payload['similarity_pairs'])}")


if __name__ == "__main__":
    main()

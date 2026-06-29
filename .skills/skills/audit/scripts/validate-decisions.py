#!/usr/bin/env python3
"""
validate-decisions.py — Validates DECISIONS.md tag and status compliance.

Reads the tag repository from the Legenda section of DECISIONS.md (source of truth)
and checks every decision row for:
  1. Tags present (at least 1, max 2 per D-034)
  2. Tags from allowlist only (tag repository in Legenda)
  3. Status value is valid (empty = active, → D-XXX = superseded, annullata = cancelled)
  4. Watermark check: if current last ID - watermark ID >= 10, alerts for semantic review

Usage:
  python $SKILL_ROOT/audit/scripts/validate-decisions.py docs/DECISIONS.md
  python $SKILL_ROOT/audit/scripts/validate-decisions.py docs/DECISIONS.md --format json

Output: human-readable report (default) or JSON with notify field per error.
Exit codes: 0 = OK, 1 = errors found, 2 = file not found.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Valid status patterns (per D-032 + D-035)
_STATUS_PATTERNS = [
    re.compile(r"^$"),              # active (empty cell)
    re.compile(r"^→ D-\d+"),       # superseded by another decision
    re.compile(r"^annullata$"),     # cancelled, no replacement
]

MAX_TAGS = 2  # per D-034


def _parse_tag_repository(content: str) -> set[str]:
    """Extract valid tags from the '## Legenda > ### Tag repository' section."""
    tags: set[str] = set()
    in_legenda = False
    in_tag_repo = False

    for line in content.splitlines():
        # Enter Legenda section
        if re.match(r"^## Legenda", line):
            in_legenda = True
            continue
        if not in_legenda:
            continue

        # Within Legenda: detect Tag repository sub-section
        if re.match(r"^### Tag repository", line):
            in_tag_repo = True
            continue

        if in_tag_repo:
            # Another ### heading closes this sub-section
            if re.match(r"^### ", line):
                break
            # Table rows containing backtick-wrapped tags: | `#tagname` | ... |
            if line.startswith("|") and "`#" in line:
                for m in re.finditer(r"`(#\w+)`", line):
                    tags.add(m.group(1))

    return tags


def _parse_watermark(content: str) -> str | None:
    """Extract last-semantic-review decision ID from HTML comment watermark."""
    m = re.search(r"<!--\s*last-semantic-review:\s*(D-\d+)\s*-->", content)
    return m.group(1) if m else None


def _parse_decisions(content: str) -> list[dict]:
    """Parse decision rows from the main table."""
    decisions = []
    for line in content.splitlines():
        if not line.startswith("| D-"):
            continue
        parts = [p.strip() for p in line.split("|")]
        # Expected cols: '' | ID | Date | Stream | Tags | Decisione | Razionale | Fonte | Status | ''
        if len(parts) < 9:
            continue
        d_id = parts[1]
        if not re.match(r"^D-\d+$", d_id):
            continue
        decisions.append(
            {
                "id": d_id,
                "tags_raw": parts[4],
                "status": parts[8] if len(parts) > 8 else "",
            }
        )
    return decisions


def validate(decisions_path: Path, fmt: str = "human") -> int:
    content = decisions_path.read_text(encoding="utf-8")

    valid_tags = _parse_tag_repository(content)
    watermark = _parse_watermark(content)
    decisions = _parse_decisions(content)

    errors: list[dict] = []
    warnings: list[dict] = []

    for d in decisions:
        did = d["id"]
        raw = d["tags_raw"]
        status = d["status"]

        # --- Tag checks ---
        if not raw or raw in ("-", "—"):
            errors.append(
                {
                    "id": did,
                    "type": "missing_tags",
                    "msg": f"{did}: nessun tag assegnato",
                    "notify": "project-manager",
                }
            )
        else:
            tag_list = re.findall(r"#\w+", raw)
            if len(tag_list) > MAX_TAGS:
                errors.append(
                    {
                        "id": did,
                        "type": "too_many_tags",
                        "msg": f"{did}: {len(tag_list)} tag (max {MAX_TAGS}): {raw}",
                        "notify": "project-manager",
                    }
                )
            for tag in tag_list:
                if tag not in valid_tags:
                    errors.append(
                        {
                            "id": did,
                            "type": "unknown_tag",
                            "msg": f"{did}: tag '{tag}' non presente nel tag repository (Legenda)",
                            "notify": "project-manager",
                        }
                    )

        # --- Status check ---
        # Strip surrounding backticks (legacy formatting: `→ D-XXX`)
        status = status.strip("`")
        if not any(p.match(status) for p in _STATUS_PATTERNS):
            errors.append(
                {
                    "id": did,
                    "type": "invalid_status",
                    "msg": f"{did}: status '{status}' non valido (attesi: vuoto | → D-XXX | annullata)",
                    "notify": "project-manager",
                }
            )

    # --- Watermark check ---
    if not watermark:
        warnings.append(
            {
                "type": "no_watermark",
                "msg": "Watermark last-semantic-review mancante in DECISIONS.md",
                "notify": "project-manager",
            }
        )
    elif decisions:
        last_num = max(int(d["id"][2:]) for d in decisions)
        wm_num = int(watermark[2:])
        gap = last_num - wm_num
        if gap >= 10:
            warnings.append(
                {
                    "type": "semantic_review_due",
                    "msg": (
                        f"Review semantica dovuta: {gap} decisioni dall'ultima review "
                        f"({watermark} → D-{last_num:03d}). Aggiornare il watermark dopo la review."
                    ),
                    "notify": "project-manager",
                }
            )

    # --- Output ---
    if fmt == "json":
        print(
            json.dumps(
                {
                    "errors": errors,
                    "warnings": warnings,
                    "decisions_checked": len(decisions),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        if not errors and not warnings:
            print(f"OK — {len(decisions)} decisioni validate, nessun errore.")
        else:
            if errors:
                print(f"ERRORI ({len(errors)}):")
                for e in errors:
                    print(f"  [notify:{e['notify']}] {e['msg']}")
            if warnings:
                print(f"\nAVVISI ({len(warnings)}):")
                for w in warnings:
                    print(f"  [notify:{w['notify']}] {w['msg']}")
            print(f"\n{len(decisions)} decisioni verificate.")

    return 1 if errors else 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate DECISIONS.md tag and status compliance"
    )
    parser.add_argument("decisions", type=Path, help="Path to DECISIONS.md")
    parser.add_argument(
        "--format",
        choices=["human", "json"],
        default="human",
        dest="fmt",
        help="Output format (default: human)",
    )
    args = parser.parse_args()

    if not args.decisions.exists():
        print(f"Errore: file non trovato: {args.decisions}", file=sys.stderr)
        sys.exit(2)

    sys.exit(validate(args.decisions, args.fmt))


if __name__ == "__main__":
    main()

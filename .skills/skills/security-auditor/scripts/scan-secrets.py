#!/usr/bin/env python3
"""
Scan repository for leaked secrets, API keys, and sensitive data.
Part of the security-auditor skill (D-016).

Usage:
  python scan-secrets.py <repo_root> [--format json|text]
"""

import argparse
import json
import os
import re
import subprocess
import sys

# Patterns that indicate secrets in source code
SECRET_PATTERNS = [
    (r'sb_secret_[A-Za-z0-9_-]+', 'Supabase service_role key'),
    (r'service_role["\s:=]+[A-Za-z0-9_.-]{20,}', 'service_role key assignment'),
    (r'(?i)password\s*[=:]\s*["\'][^"\']{4,}', 'Hardcoded password'),
    (r'(?i)api[_-]?key\s*[=:]\s*["\'][^"\']{10,}', 'API key'),
    (r'Bearer\s+[A-Za-z0-9_.-]{20,}', 'Bearer token'),
    (r'(?i)secret[_-]?key\s*[=:]\s*["\'][^"\']{10,}', 'Secret key'),
    (r'eyJhbGciOi[A-Za-z0-9_-]{50,}', 'JWT token'),
]

# Files/dirs to skip
SKIP_DIRS = {
    'node_modules', '.next', '.git', 'test-results', 'playwright-report',
    '__pycache__', '.cache', 'dist', 'build', '.vercel'
}
SKIP_EXTENSIONS = {
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2',
    '.ttf', '.eot', '.mp4', '.mp3', '.zip', '.tar', '.gz', '.lock'
}
# Files that are EXPECTED to contain keys (not tracked by git)
ALLOWED_FILES = {'.env.local', '.env.development.local', '.env.production.local'}


def get_tracked_files(repo_root):
    """Get list of files tracked by git."""
    try:
        result = subprocess.run(
            ['git', 'ls-files'],
            cwd=repo_root, capture_output=True, text=True, check=True
        )
        return set(result.stdout.strip().split('\n'))
    except subprocess.CalledProcessError:
        return set()


def scan_file(filepath, tracked_files, repo_root):
    """Scan a single file for secret patterns."""
    findings = []
    rel_path = os.path.relpath(filepath, repo_root).replace('\\', '/')

    # Skip if not tracked by git (secrets in .env.local are expected)
    if rel_path not in tracked_files:
        return findings

    # Skip binary/media files
    _, ext = os.path.splitext(filepath)
    if ext.lower() in SKIP_EXTENSIONS:
        return findings

    # Skip allowed files
    basename = os.path.basename(filepath)
    if basename in ALLOWED_FILES:
        return findings

    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except (OSError, UnicodeDecodeError):
        return findings

    for pattern, description in SECRET_PATTERNS:
        for match in re.finditer(pattern, content):
            # Get line number
            line_num = content[:match.start()].count('\n') + 1
            # Truncate the match for display (don't show full secrets)
            matched_text = match.group()
            if len(matched_text) > 20:
                matched_text = matched_text[:10] + '...' + matched_text[-5:]
            findings.append({
                'file': rel_path,
                'line': line_num,
                'type': description,
                'match': matched_text,
                'severity': 'CRITICAL'
            })

    return findings


def check_gitignore(repo_root):
    """Verify .env.local is in .gitignore."""
    gitignore_path = os.path.join(repo_root, '.gitignore')
    if not os.path.exists(gitignore_path):
        return {'status': 'FAIL', 'reason': '.gitignore not found'}

    with open(gitignore_path, 'r') as f:
        content = f.read()

    patterns_to_check = ['.env.local', '.env*.local']
    for pattern in patterns_to_check:
        if pattern in content:
            return {'status': 'PASS', 'pattern': pattern}

    return {'status': 'FAIL', 'reason': '.env.local not found in .gitignore'}


def check_env_in_git_history(repo_root):
    """Check if .env files were ever committed."""
    try:
        result = subprocess.run(
            ['git', 'log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:', '--', '*.env*'],
            cwd=repo_root, capture_output=True, text=True, check=True
        )
        files = [f.strip() for f in result.stdout.strip().split('\n') if f.strip()]
        # Filter out .env.example which is expected
        suspicious = [f for f in files if f and not f.endswith('.example') and not f.endswith('.localecho')]
        return suspicious
    except subprocess.CalledProcessError:
        return []


def main():
    parser = argparse.ArgumentParser(description='Scan for secrets in repository')
    parser.add_argument('repo_root', help='Path to repository root')
    parser.add_argument('--format', choices=['json', 'text'], default='text')
    args = parser.parse_args()

    repo_root = os.path.abspath(args.repo_root)
    tracked_files = get_tracked_files(repo_root)
    all_findings = []
    files_scanned = 0

    # Scan all tracked files
    for root, dirs, files in os.walk(repo_root):
        # Skip excluded directories
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        for filename in files:
            filepath = os.path.join(root, filename)
            findings = scan_file(filepath, tracked_files, repo_root)
            if findings:
                all_findings.extend(findings)
            rel = os.path.relpath(filepath, repo_root).replace('\\', '/')
            if rel in tracked_files:
                files_scanned += 1

    # Check .gitignore
    gitignore_check = check_gitignore(repo_root)

    # Check git history
    env_in_history = check_env_in_git_history(repo_root)

    result = {
        'files_scanned': files_scanned,
        'secrets_found': len(all_findings),
        'findings': all_findings,
        'gitignore': gitignore_check,
        'env_in_history': env_in_history,
        'status': 'CRITICAL' if all_findings or gitignore_check['status'] == 'FAIL' else 'PASS'
    }

    if args.format == 'json':
        print(json.dumps(result, indent=2))
    else:
        print(f"Files scanned: {files_scanned}")
        print(f"Secrets found: {len(all_findings)}")
        print(f".gitignore: {gitignore_check['status']}")
        print(f"Env files in git history: {len(env_in_history)}")
        if all_findings:
            print("\n--- FINDINGS ---")
            for f in all_findings:
                print(f"  CRITICAL: {f['file']}:{f['line']} — {f['type']} ({f['match']})")
        if env_in_history:
            print(f"\n--- ENV FILES IN HISTORY ---")
            for f in env_in_history:
                print(f"  WARNING: {f}")
        print(f"\nVerdict: {result['status']}")

    sys.exit(0 if result['status'] == 'PASS' else 1)


if __name__ == '__main__':
    main()

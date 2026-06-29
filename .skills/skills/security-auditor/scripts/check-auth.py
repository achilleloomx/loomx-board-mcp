#!/usr/bin/env python3
"""
Check authentication flow security.
Part of the security-auditor skill (D-016).

Usage:
  python check-auth.py <repo_root> [--format json|text]
"""

import argparse
import json
import os
import re
import subprocess
import sys


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


def check_bypass_in_code(repo_root, tracked_files):
    """Check if DEV_BYPASS_AUTH=true appears in any tracked file."""
    findings = []
    for rel_path in tracked_files:
        if rel_path.endswith(('.ts', '.tsx', '.js', '.jsx', '.env', '.env.example')):
            filepath = os.path.join(repo_root, rel_path)
            if not os.path.exists(filepath):
                continue
            try:
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    for i, line in enumerate(f, 1):
                        # Check for hardcoded bypass
                        if 'DEV_BYPASS_AUTH' in line and 'true' in line.lower():
                            # Ignore comments and environment variable reads
                            stripped = line.strip()
                            if stripped.startswith('//') or stripped.startswith('#'):
                                continue
                            # process.env.DEV_BYPASS_AUTH === "true" is OK (reads from env)
                            if 'process.env' in line:
                                continue
                            findings.append({
                                'file': rel_path,
                                'line': i,
                                'content': stripped[:100],
                                'severity': 'CRITICAL',
                                'type': 'DEV_BYPASS_AUTH hardcoded to true'
                            })
            except (OSError, UnicodeDecodeError):
                continue
    return findings


def check_middleware_protection(repo_root):
    """Verify middleware.ts protects routes correctly."""
    findings = []
    middleware_path = os.path.join(repo_root, 'src', 'middleware.ts')

    if not os.path.exists(middleware_path):
        return [{'type': 'Missing middleware', 'severity': 'CRITICAL',
                 'detail': 'src/middleware.ts not found — routes are unprotected'}]

    with open(middleware_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Check for getUser (server-side validation) vs getSession (client-side, less secure)
    if 'getUser' not in content:
        findings.append({
            'type': 'JWT validation',
            'severity': 'WARNING',
            'detail': 'middleware.ts does not use getUser() — consider server-side JWT validation'
        })

    if 'getSession' in content and 'getUser' not in content:
        findings.append({
            'type': 'JWT validation',
            'severity': 'CRITICAL',
            'detail': 'middleware.ts uses getSession() without getUser() — JWT not validated server-side'
        })

    # Check matcher config exists
    if 'matcher' not in content:
        findings.append({
            'type': 'Route matcher',
            'severity': 'WARNING',
            'detail': 'No route matcher configured — middleware may not protect all routes'
        })

    # Check redirect to login for unauthenticated users
    if '/login' not in content:
        findings.append({
            'type': 'Login redirect',
            'severity': 'CRITICAL',
            'detail': 'No redirect to /login for unauthenticated users'
        })

    return findings


def check_xss_vectors(repo_root, tracked_files):
    """Scan for XSS vulnerabilities."""
    findings = []
    dangerous_patterns = [
        (r'dangerouslySetInnerHTML', 'dangerouslySetInnerHTML usage'),
        (r'(?<![\w.])eval\s*\(', 'eval() usage'),
        (r'new\s+Function\s*\(', 'Function constructor'),
        (r'\.innerHTML\s*=', 'innerHTML assignment'),
        (r'document\.write\s*\(', 'document.write usage'),
    ]

    for rel_path in tracked_files:
        if not rel_path.startswith('src/') or not rel_path.endswith(('.ts', '.tsx', '.js', '.jsx')):
            continue
        filepath = os.path.join(repo_root, rel_path)
        if not os.path.exists(filepath):
            continue
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            for pattern, description in dangerous_patterns:
                for match in re.finditer(pattern, content):
                    line_num = content[:match.start()].count('\n') + 1
                    findings.append({
                        'file': rel_path,
                        'line': line_num,
                        'type': description,
                        'severity': 'CRITICAL'
                    })
        except (OSError, UnicodeDecodeError):
            continue

    return findings


def check_sql_injection(repo_root, tracked_files):
    """Check for raw SQL string concatenation in query files."""
    findings = []
    # Patterns that suggest SQL injection risk
    sql_patterns = [
        (r'`[^`]*\$\{[^}]+\}[^`]*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)', 'Template literal SQL with interpolation'),
        (r'["\'][^"\']*\'\s*\+\s*\w+\s*\+\s*["\'].*(?:SELECT|INSERT|UPDATE|DELETE)', 'String concatenation in SQL'),
    ]

    for rel_path in tracked_files:
        if not rel_path.startswith('src/') or not rel_path.endswith(('.ts', '.tsx', '.js', '.jsx')):
            continue
        filepath = os.path.join(repo_root, rel_path)
        if not os.path.exists(filepath):
            continue
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            for pattern, description in sql_patterns:
                for match in re.finditer(pattern, content, re.IGNORECASE):
                    line_num = content[:match.start()].count('\n') + 1
                    findings.append({
                        'file': rel_path,
                        'line': line_num,
                        'type': description,
                        'severity': 'CRITICAL'
                    })
        except (OSError, UnicodeDecodeError):
            continue

    return findings


def main():
    parser = argparse.ArgumentParser(description='Check auth flow security')
    parser.add_argument('repo_root', help='Path to repository root')
    parser.add_argument('--format', choices=['json', 'text'], default='text')
    args = parser.parse_args()

    repo_root = os.path.abspath(args.repo_root)
    tracked_files = get_tracked_files(repo_root)

    bypass_findings = check_bypass_in_code(repo_root, tracked_files)
    middleware_findings = check_middleware_protection(repo_root)
    xss_findings = check_xss_vectors(repo_root, tracked_files)
    sql_findings = check_sql_injection(repo_root, tracked_files)

    all_findings = bypass_findings + middleware_findings + xss_findings + sql_findings
    critical_count = sum(1 for f in all_findings if f.get('severity') == 'CRITICAL')
    warning_count = sum(1 for f in all_findings if f.get('severity') == 'WARNING')

    status = 'CRITICAL' if critical_count > 0 else ('WARNING' if warning_count > 0 else 'PASS')

    result = {
        'bypass_auth': {'findings': bypass_findings, 'count': len(bypass_findings)},
        'middleware': {'findings': middleware_findings, 'count': len(middleware_findings)},
        'xss': {'findings': xss_findings, 'count': len(xss_findings)},
        'sql_injection': {'findings': sql_findings, 'count': len(sql_findings)},
        'total_findings': len(all_findings),
        'critical': critical_count,
        'warnings': warning_count,
        'status': status
    }

    if args.format == 'json':
        print(json.dumps(result, indent=2))
    else:
        print(f"Auth bypass in code: {len(bypass_findings)} findings")
        print(f"Middleware: {len(middleware_findings)} findings")
        print(f"XSS vectors: {len(xss_findings)} findings")
        print(f"SQL injection: {len(sql_findings)} findings")
        if all_findings:
            print("\n--- FINDINGS ---")
            for f in all_findings:
                loc = f"{f.get('file', '')}:{f.get('line', '')}" if 'file' in f else ''
                detail = f.get('detail', f.get('type', ''))
                print(f"  {f['severity']}: {loc} — {detail}")
        print(f"\nVerdict: {status}")

    sys.exit(0 if status == 'PASS' else 1)


if __name__ == '__main__':
    main()

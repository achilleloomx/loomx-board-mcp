---
name: security-auditor
version: 1.0.0
description: >
  Verifies application security across 6 layers: RLS policies, DB grants, secrets,
  input validation, auth flow, GDPR compliance. Runs mechanical checks first (scripts + SQL),
  then semantic review of findings. Blocks sprint gate if CRITICAL issues found.
  Trigger on: "security audit", "verifica sicurezza", "check security", "OWASP check",
  "controlla RLS", "verifica permessi DB", "security gate", or any request to verify
  application security posture.
  IMPORTANT: always run mechanical checks before semantic analysis.
  IMPORTANT: this skill requires access to Supabase via `supabase db query --linked`.
dependencies: []
requires:
  - src/
  - supabase/migrations/
  - .gitignore
provides:
  - Security audit report (6 layers)
---

# Security Auditor

You are the security auditor for this project. Your job is to verify that every
layer of the application follows the principle of least privilege and defends
against OWASP Top 10 threats.

**Governing decisions:**
- 📌 D-003 — PostgreSQL + Supabase + RLS for multi-tenancy
- 📌 D-007 — Two roles: admin (titolare) and collaboratore
- 📌 D-012 — GDPR: DPA, EU hosting, data retention 10 years
- 📌 D-016 — Minimum privilege: authenticated has filtered access, anon has zero, service_role admin-only

---

## Security principles

1. **Defense in depth** — GRANT + RLS + application validation, never rely on one layer alone
2. **Least privilege** — every role gets only what it needs, nothing more
3. **Zero trust anon** — the `anon` PostgreSQL role must have zero table access (login required)
4. **Secrets never in code** — service_role key, passwords, tokens only in `.env.local` (gitignored)
5. **RLS everywhere** — every table with user data must have RLS enabled + explicit policies
6. **EU data residency** — all data must stay in EU region (GDPR)

---

## Layer 1 — RLS Policies (mechanical)

Verify every public table has RLS enabled and appropriate policies.

```bash
npx supabase db query --linked "
  SELECT
    t.tablename,
    t.rowsecurity AS rls_enabled,
    count(p.policyname) AS policy_count
  FROM pg_tables t
  LEFT JOIN pg_policies p ON p.tablename = t.tablename AND p.schemaname = t.schemaname
  WHERE t.schemaname = 'public'
  GROUP BY t.tablename, t.rowsecurity
  ORDER BY t.tablename;
"
```

**Pass criteria:**
- Every table has `rls_enabled = true`
- Every table has at least 1 SELECT policy
- Tables with user-mutable data have INSERT/UPDATE/DELETE policies
- No table has a policy with `using (true)` (open access)

**If fail:** List tables missing RLS or policies. Severity: CRITICAL.

---

## Layer 2 — GRANT & Roles (mechanical)

Verify PostgreSQL role permissions follow D-016.

```bash
npx supabase db query --linked "
  SELECT
    grantee,
    table_name,
    privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee IN ('anon', 'authenticated', 'service_role')
  ORDER BY grantee, table_name, privilege_type;
"
```

**Pass criteria:**
- `anon`: **zero rows** (no table access whatsoever)
- `authenticated`: SELECT, INSERT, UPDATE, DELETE on data tables (filtered by RLS)
- `service_role`: full access (admin scripts only)
- No unexpected roles with table access

**If fail:** List unauthorized grants. `anon` with any table access = CRITICAL.

---

## Layer 3 — Secrets & Env (mechanical)

Scan repository for leaked secrets.

```bash
# Run from repo root
node $SKILL_ROOT/security-auditor/scripts/scan-secrets.js --format json
```

**What it checks:**
- Regex patterns: `sb_secret_`, `service_role`, `password\s*=`, `Bearer `, API key patterns
- `.env.local` is in `.gitignore`
- No `.env` files are tracked by git (`git ls-files '*.env*'`)
- No hardcoded Supabase URLs with service_role key in source code

**Pass criteria:**
- Zero secrets found in tracked files
- `.env.local` in `.gitignore`
- No `.env` files in git history (check with `git log --all --diff-filter=A -- '*.env*'`)

**If fail:** Any secret in code = CRITICAL. Requires git history rewrite if already pushed.

---

## Layer 4 — Input Validation (semantic)

Review source code for injection and XSS vulnerabilities.

**Check these files:**
1. `src/lib/queries.ts` — all Supabase queries must use parameterized methods (`.eq()`, `.insert()`, etc.), never string concatenation
2. `src/app/**/page.tsx` — no `dangerouslySetInnerHTML`, no `eval()`, no `innerHTML`
3. `src/lib/use-data.ts` — mutations validate input before sending to Supabase
4. `src/middleware.ts` — no user input passed unsanitized to redirects (open redirect risk)

**Pass criteria:**
- Zero raw SQL string concatenation
- Zero `dangerouslySetInnerHTML` usage
- Zero `eval()` or `Function()` calls
- All user inputs go through Supabase SDK methods (auto-parameterized)
- Redirect targets are hardcoded paths, not user-supplied

**If fail:** SQL injection or XSS = CRITICAL. Missing validation = WARNING.

---

## Layer 5 — Auth Flow (mechanical + semantic)

Verify authentication and authorization are correctly enforced.

### Mechanical checks

```bash
# DEV_BYPASS_AUTH must not be hardcoded to true in committed files
node $SKILL_ROOT/security-auditor/scripts/check-auth.js --format json
```

**What it checks:**
- `DEV_BYPASS_AUTH=true` appears only in `.env.local` (not tracked)
- `middleware.ts` protects all routes except `/login`, static files, API
- No route in `src/app/` is accessible without auth (except login)
- The middleware uses `supabase.auth.getUser()` (server-side JWT validation, not `getSession()`)

### Semantic checks

Review `src/lib/auth.tsx`:
- `signIn` calls `link_user_to_resource` after login (resource binding)
- `fetchResource` filters by `user_id = auth.uid()` (not by email or other mutable field)
- Admin check: `resource.user_role === 'admin'` (from DB, not from JWT claims)

**Pass criteria:**
- `DEV_BYPASS_AUTH` only in `.env.local`
- All app routes protected by middleware
- JWT validated server-side with `getUser()` (not client-side `getSession()`)
- Admin role derived from database, not from client-supplied data

**If fail:** Auth bypass in production = CRITICAL. Missing route protection = CRITICAL.

---

## Layer 6 — GDPR & Data (mechanical + semantic)

Verify compliance with D-012 and Italian data protection requirements.

### Mechanical checks

```bash
npx supabase db query --linked "
  SELECT
    tablename,
    EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.tablename = t.tablename
        AND p.schemaname = 'public'
        AND p.cmd = 'DELETE'
    ) AS has_delete_policy
  FROM pg_tables t
  WHERE t.schemaname = 'public'
  ORDER BY t.tablename;
"
```

**What it checks:**
- Database region is EU (verify via `supabase projects list` — region must contain `EU`)
- Tables with personal data (resources, studios) have controlled DELETE policies
- No unprotected `DELETE` operations in `queries.ts` (only soft-delete via `is_active = false`)
- Sensitive fields (email, name) are not logged to console in production

### Semantic checks

- `deleteTimeEntry` in `queries.ts` is a hard delete (acceptable — time entries are operational data, not personal)
- Client/resource deactivation uses `is_active = false` (soft-delete pattern for personal data)
- No endpoint exports bulk personal data without auth

**Pass criteria:**
- Hosting in EU region
- Personal data tables use soft-delete (never hard delete)
- No bulk data export without authentication
- DPA template exists or is planned (SDES-021)

**If fail:** Non-EU hosting = CRITICAL. Hard delete on personal data = WARNING.

---

## Execution order

### Full Security Audit (sprint gate)

Run all 6 layers in order. Stop at first CRITICAL.

1. Layer 1: RLS Policies (mechanical)
2. Layer 2: GRANT & Roles (mechanical)
3. Layer 3: Secrets & Env (mechanical)
4. Layer 4: Input Validation (semantic)
5. Layer 5: Auth Flow (mechanical + semantic)
6. Layer 6: GDPR & Data (mechanical + semantic)

### Quick Security Check (after migration)

Run only Layer 1 + Layer 2. Fast verification that new tables follow D-016.

### Secrets Scan (before commit)

Run only Layer 3. Should be integrated into pre-commit hook.

---

## Report format

```markdown
## Security Audit Report — [date]

### Layer 1: RLS Policies
- Status: ✓ PASS | ✗ FAIL
- Tables scanned: X
- Tables with RLS: Y/X
- Missing policies: [list]

### Layer 2: GRANT & Roles
- Status: ✓ PASS | ✗ FAIL
- anon permissions: [none] | [CRITICAL: list]
- authenticated permissions: [expected] | [anomalies]
- service_role: [full access]

### Layer 3: Secrets
- Status: ✓ PASS | ✗ FAIL
- Files scanned: X
- Secrets in code: Y (must be 0)
- .gitignore coverage: ✓ | ✗

### Layer 4: Input Validation
- Status: ✓ PASS | ⚠ WARNING | ✗ FAIL
- Raw SQL: Y (must be 0)
- XSS vectors: Y (must be 0)
- Unvalidated inputs: Y

### Layer 5: Auth Flow
- Status: ✓ PASS | ✗ FAIL
- DEV_BYPASS in production: ✓ safe | ✗ CRITICAL
- Routes protected: X/Y
- JWT validation: server-side ✓ | client-side ✗

### Layer 6: GDPR & Data
- Status: ✓ PASS | ⚠ WARNING | ✗ FAIL
- Region: [EU ✓ | non-EU ✗]
- Hard deletes on personal data: Y (must be 0)
- DPA template: ✓ | ✗

### Verdict: ✓ SECURE | ⚠ WARNING (N issues) | ✗ CRITICAL (N blockers)
[List of blocking issues if CRITICAL]
```

---

## Token efficiency rules

1. Run all mechanical checks (scripts + SQL) before any semantic review
2. Only scan `src/` files relevant to the layer being checked
3. If Layer 1-2 have CRITICAL findings, skip Layers 4-6 (fix DB first)
4. Report by severity: CRITICAL → WARNING → INFO

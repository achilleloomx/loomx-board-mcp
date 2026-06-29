#!/usr/bin/env node
/**
 * Check authentication flow security.
 * Part of the security-auditor skill (D-016).
 *
 * Usage: node check-auth.js [--format json|text]
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

function getTrackedFiles() {
  try {
    const out = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf-8" });
    return new Set(out.trim().split("\n").filter(Boolean));
  } catch { return new Set(); }
}

function checkBypassInCode(trackedFiles) {
  const findings = [];
  for (const relPath of trackedFiles) {
    if (!/\.(ts|tsx|js|jsx|env|env\.example)$/.test(relPath)) continue;
    const filePath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(filePath)) continue;

    let lines;
    try { lines = fs.readFileSync(filePath, "utf-8").split("\n"); }
    catch { continue; }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("DEV_BYPASS_AUTH") || !line.toLowerCase().includes("true")) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
      if (line.includes("process.env")) continue; // Reading from env is OK
      findings.push({
        file: relPath, line: i + 1, content: trimmed.substring(0, 100),
        severity: "CRITICAL", type: "DEV_BYPASS_AUTH hardcoded to true"
      });
    }
  }
  return findings;
}

function checkMiddleware() {
  const findings = [];
  const middlewarePath = path.join(REPO_ROOT, "src", "middleware.ts");

  if (!fs.existsSync(middlewarePath)) {
    return [{ type: "Missing middleware", severity: "CRITICAL",
      detail: "src/middleware.ts not found — routes are unprotected" }];
  }

  const content = fs.readFileSync(middlewarePath, "utf-8");

  if (!content.includes("getUser")) {
    findings.push({ type: "JWT validation", severity: "WARNING",
      detail: "middleware.ts does not use getUser() — consider server-side JWT validation" });
  }
  if (content.includes("getSession") && !content.includes("getUser")) {
    findings.push({ type: "JWT validation", severity: "CRITICAL",
      detail: "middleware.ts uses getSession() without getUser() — JWT not validated server-side" });
  }
  if (!content.includes("matcher")) {
    findings.push({ type: "Route matcher", severity: "WARNING",
      detail: "No route matcher configured — middleware may not protect all routes" });
  }
  if (!content.includes("/login")) {
    findings.push({ type: "Login redirect", severity: "CRITICAL",
      detail: "No redirect to /login for unauthenticated users" });
  }
  return findings;
}

function checkXssVectors(trackedFiles) {
  const findings = [];
  const patterns = [
    [/dangerouslySetInnerHTML/g, "dangerouslySetInnerHTML usage"],
    [/(?<![.\w])eval\s*\(/g, "eval() usage"],
    [/new\s+Function\s*\(/g, "Function constructor"],
    [/\.innerHTML\s*=/g, "innerHTML assignment"],
    [/document\.write\s*\(/g, "document.write usage"],
  ];

  for (const relPath of trackedFiles) {
    if (!relPath.startsWith("src/") || !/\.(ts|tsx|js|jsx)$/.test(relPath)) continue;
    const filePath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(filePath)) continue;

    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); }
    catch { continue; }

    for (const [pattern, description] of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split("\n").length;
        findings.push({ file: relPath, line, type: description, severity: "CRITICAL" });
      }
    }
  }
  return findings;
}

function checkSqlInjection(trackedFiles) {
  const findings = [];
  const patterns = [
    [/`[^`]*\$\{[^}]+\}[^`]*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/gi, "Template literal SQL with interpolation"],
    [/["'][^"']*'\s*\+\s*\w+\s*\+\s*["'].*(?:SELECT|INSERT|UPDATE|DELETE)/gi, "String concatenation in SQL"],
  ];

  for (const relPath of trackedFiles) {
    if (!relPath.startsWith("src/") || !/\.(ts|tsx|js|jsx)$/.test(relPath)) continue;
    const filePath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(filePath)) continue;

    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); }
    catch { continue; }

    for (const [pattern, description] of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split("\n").length;
        findings.push({ file: relPath, line, type: description, severity: "CRITICAL" });
      }
    }
  }
  return findings;
}

// --- Main ---
const format = process.argv.includes("--format")
  ? process.argv[process.argv.indexOf("--format") + 1]
  : "text";

const trackedFiles = getTrackedFiles();
const bypass = checkBypassInCode(trackedFiles);
const middleware = checkMiddleware();
const xss = checkXssVectors(trackedFiles);
const sql = checkSqlInjection(trackedFiles);

const all = [...bypass, ...middleware, ...xss, ...sql];
const critical = all.filter(f => f.severity === "CRITICAL").length;
const warnings = all.filter(f => f.severity === "WARNING").length;
const status = critical > 0 ? "CRITICAL" : warnings > 0 ? "WARNING" : "PASS";

const result = {
  bypass_auth: { findings: bypass, count: bypass.length },
  middleware: { findings: middleware, count: middleware.length },
  xss: { findings: xss, count: xss.length },
  sql_injection: { findings: sql, count: sql.length },
  total_findings: all.length, critical, warnings, status
};

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Auth bypass in code: ${bypass.length} findings`);
  console.log(`Middleware: ${middleware.length} findings`);
  console.log(`XSS vectors: ${xss.length} findings`);
  console.log(`SQL injection: ${sql.length} findings`);
  if (all.length) {
    console.log("\n--- FINDINGS ---");
    for (const f of all) {
      const loc = f.file ? `${f.file}:${f.line}` : "";
      const detail = f.detail || f.type;
      console.log(`  ${f.severity}: ${loc} — ${detail}`);
    }
  }
  console.log(`\nVerdict: ${status}`);
}

process.exit(status === "PASS" ? 0 : 1);

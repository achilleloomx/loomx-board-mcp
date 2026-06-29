#!/usr/bin/env node
/**
 * Scan repository for leaked secrets, API keys, and sensitive data.
 * Part of the security-auditor skill (D-016).
 *
 * Usage: node scan-secrets.js [--format json|text]
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

const SECRET_PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]+/g, "Supabase service_role key"],
  [/service_role["'\s:=]+[A-Za-z0-9_.+-]{20,}/g, "service_role key assignment"],
  [/(?:password|passwd|pwd)\s*[=:]\s*["'][^"']{4,}/gi, "Hardcoded password"],
  [/(?:api[_-]?key)\s*[=:]\s*["'][^"']{10,}/gi, "API key"],
  [/Bearer\s+[A-Za-z0-9_.-]{20,}/g, "Bearer token"],
  [/eyJhbGciOi[A-Za-z0-9_-]{50,}/g, "JWT token"],
];

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "test-results", "playwright-report",
  "__pycache__", ".cache", "dist", "build", ".vercel",
]);
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
  ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".tar", ".gz", ".lock",
]);
const ALLOWED_FILES = new Set([".env.local", ".env.development.local", ".env.production.local"]);

function getTrackedFiles() {
  try {
    const out = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf-8" });
    return new Set(out.trim().split("\n").filter(Boolean));
  } catch { return new Set(); }
}

function scanFile(filePath, trackedFiles) {
  const findings = [];
  const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");

  if (!trackedFiles.has(relPath)) return findings;
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return findings;
  if (ALLOWED_FILES.has(path.basename(filePath))) return findings;

  let content;
  try { content = fs.readFileSync(filePath, "utf-8"); }
  catch { return findings; }

  for (const [pattern, description] of SECRET_PATTERNS) {
    // Reset regex lastIndex
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      const matched = match[0];
      const display = matched.length > 20
        ? matched.substring(0, 10) + "..." + matched.substring(matched.length - 5)
        : matched;
      findings.push({ file: relPath, line, type: description, match: display, severity: "CRITICAL" });
    }
  }
  return findings;
}

function walkDir(dir, trackedFiles) {
  let findings = [];
  let filesScanned = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkDir(fullPath, trackedFiles);
      findings = findings.concat(sub.findings);
      filesScanned += sub.filesScanned;
    } else {
      const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, "/");
      if (trackedFiles.has(relPath)) filesScanned++;
      findings = findings.concat(scanFile(fullPath, trackedFiles));
    }
  }
  return { findings, filesScanned };
}

function checkGitignore() {
  const gitignorePath = path.join(REPO_ROOT, ".gitignore");
  if (!fs.existsSync(gitignorePath))
    return { status: "FAIL", reason: ".gitignore not found" };
  const content = fs.readFileSync(gitignorePath, "utf-8");
  if (content.includes(".env.local") || content.includes(".env*.local"))
    return { status: "PASS" };
  return { status: "FAIL", reason: ".env.local not in .gitignore" };
}

function checkEnvInHistory() {
  try {
    const out = execSync(
      "git log --all --diff-filter=A --name-only --pretty=format: -- \"*.env*\"",
      { cwd: REPO_ROOT, encoding: "utf-8" }
    );
    return out.trim().split("\n")
      .filter(f => f.trim() && !f.endsWith(".example") && !f.endsWith(".localecho"))
      .map(f => f.trim());
  } catch { return []; }
}

// --- Main ---
const format = process.argv.includes("--format")
  ? process.argv[process.argv.indexOf("--format") + 1]
  : "text";

const trackedFiles = getTrackedFiles();
const { findings, filesScanned } = walkDir(REPO_ROOT, trackedFiles);
const gitignore = checkGitignore();
const envInHistory = checkEnvInHistory();
const status = findings.length > 0 || gitignore.status === "FAIL" ? "CRITICAL" : "PASS";

const result = { files_scanned: filesScanned, secrets_found: findings.length, findings, gitignore, env_in_history: envInHistory, status };

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Files scanned: ${filesScanned}`);
  console.log(`Secrets found: ${findings.length}`);
  console.log(`.gitignore: ${gitignore.status}`);
  console.log(`Env files in git history: ${envInHistory.length}`);
  if (findings.length) {
    console.log("\n--- FINDINGS ---");
    for (const f of findings) console.log(`  CRITICAL: ${f.file}:${f.line} — ${f.type} (${f.match})`);
  }
  if (envInHistory.length) {
    console.log("\n--- ENV FILES IN HISTORY ---");
    for (const f of envInHistory) console.log(`  WARNING: ${f}`);
  }
  console.log(`\nVerdict: ${status}`);
}

process.exit(status === "PASS" ? 0 : 1);

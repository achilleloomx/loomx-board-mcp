#!/usr/bin/env node
/**
 * Validate E2E traceability between test files and DESIGN-DOC.md.
 * Part of the audit skill (D-014).
 *
 * Checks:
 *   1. Every [SDES-XXX] tag in e2e/*.spec.ts maps to an SDES in DESIGN-DOC.md
 *   2. Every SDES with e2e:[] (empty) in DESIGN-DOC has no orphan tests
 *   3. Every SDES with e2e:[...] entries has matching tests
 *   4. Reports uncovered SDES (no tests at all)
 *
 * Usage: node $SKILL_ROOT/audit/scripts/validate-e2e.js
 * Exit:  0 = consistent, 1 = mismatches found
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const E2E_DIR = path.join(REPO_ROOT, "e2e");
const DESIGN_DOC = path.join(REPO_ROOT, "docs", "DESIGN-DOC.md");

// ---------------------------------------------------------------------------
// 1. Scan e2e/*.spec.ts for [SDES-XXX] tags
// ---------------------------------------------------------------------------

function scanE2eFiles() {
  /** @type {Map<string, {file: string, line: number, title: string}[]>} */
  const tagMap = new Map(); // SDES-XXX -> [{file, line, title}]

  if (!fs.existsSync(E2E_DIR)) {
    console.error("ERROR: e2e/ directory not found");
    process.exit(1);
  }

  const files = fs.readdirSync(E2E_DIR).filter(f => f.endsWith(".spec.ts"));

  for (const file of files) {
    const filePath = path.join(E2E_DIR, file);
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match test(...) or test.only(...) lines containing [SDES-XXX]
      const sdesMatches = line.match(/\[SDES-\d+\]/g);
      if (!sdesMatches) continue;

      for (const match of sdesMatches) {
        const sdes = match.slice(1, -1); // Remove brackets
        if (!tagMap.has(sdes)) tagMap.set(sdes, []);
        tagMap.get(sdes).push({
          file: `e2e/${file}`,
          line: i + 1,
          title: line.trim(),
        });
      }
    }
  }

  return { tagMap, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// 2. Parse DESIGN-DOC.md for SDES entries and their e2e fields
// ---------------------------------------------------------------------------

function parseDesignDoc() {
  if (!fs.existsSync(DESIGN_DOC)) {
    console.error("ERROR: docs/DESIGN-DOC.md not found");
    process.exit(1);
  }

  const content = fs.readFileSync(DESIGN_DOC, "utf-8");
  const lines = content.split("\n");

  /** @type {Map<string, {section: string, component: string, e2eRefs: string[]}>} */
  const sdesMap = new Map();

  let currentId = null;
  let currentSection = "";
  let currentComponent = "";

  for (const line of lines) {
    // Match SDES header: ### SDES-001 — ...
    const headerMatch = line.match(/^###\s+(SDES-\d+)\s+/);
    if (headerMatch) {
      currentId = headerMatch[1];
      continue;
    }

    // Match id: SDES-XXX in frontmatter block
    const idMatch = line.match(/^id:\s+(SDES-\d+)/);
    if (idMatch) {
      currentId = idMatch[1];
      continue;
    }

    // Match section field
    const sectionMatch = line.match(/^section:\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Match component field
    const componentMatch = line.match(/^component:\s+(.+)/);
    if (componentMatch) {
      currentComponent = componentMatch[1].trim();
      continue;
    }

    // Match e2e field
    const e2eMatch = line.match(/^e2e:\s*\[([^\]]*)\]/);
    if (e2eMatch && currentId) {
      const raw = e2eMatch[1].trim();
      const refs = raw ? raw.split(",").map(r => r.trim()).filter(Boolean) : [];
      sdesMap.set(currentId, {
        section: currentSection,
        component: currentComponent,
        e2eRefs: refs,
      });
      currentId = null;
      currentSection = "";
      currentComponent = "";
    }
  }

  return sdesMap;
}

// ---------------------------------------------------------------------------
// 3. Cross-check
// ---------------------------------------------------------------------------

function crossCheck(tagMap, sdesMap) {
  const issues = [];

  // 3a. SDES referenced in tests but not in DESIGN-DOC at all
  for (const sdes of tagMap.keys()) {
    if (!sdesMap.has(sdes)) {
      issues.push({
        type: "ORPHAN_TAG",
        severity: "ERROR",
        sdes,
        message: `${sdes} referenced in tests but not found in DESIGN-DOC.md`,
        tests: tagMap.get(sdes).map(t => `${t.file}:${t.line}`),
      });
    }
  }

  // 3b. SDES with e2e:[] (empty) in DESIGN-DOC but has tests
  for (const [sdes, info] of sdesMap.entries()) {
    const hasTests = tagMap.has(sdes);
    if (info.e2eRefs.length === 0 && hasTests) {
      issues.push({
        type: "UNDECLARED_TESTS",
        severity: "WARNING",
        sdes,
        message: `${sdes} has e2e:[] in DESIGN-DOC but ${tagMap.get(sdes).length} test(s) exist — update e2e field`,
        tests: tagMap.get(sdes).map(t => `${t.file}:${t.line}`),
      });
    }
  }

  // 3c. SDES with e2e refs in DESIGN-DOC but no matching tests
  for (const [sdes, info] of sdesMap.entries()) {
    if (info.e2eRefs.length > 0 && !tagMap.has(sdes)) {
      issues.push({
        type: "MISSING_TESTS",
        severity: "ERROR",
        sdes,
        message: `${sdes} declares e2e refs in DESIGN-DOC but no [${sdes}] tags found in tests`,
        declared: info.e2eRefs,
      });
    }
  }

  // 3d. SDES with no tests at all (e2e:[] and no test tags)
  const uncovered = [];
  for (const [sdes, info] of sdesMap.entries()) {
    if (info.e2eRefs.length === 0 && !tagMap.has(sdes)) {
      uncovered.push(sdes);
    }
  }

  return { issues, uncovered };
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------

function report(tagMap, sdesMap, issues, uncovered, fileCount) {
  const totalSdes = sdesMap.size;
  const coveredSdes = new Set();

  // An SDES is "covered" if it has tests OR declared e2e refs
  for (const sdes of tagMap.keys()) {
    if (sdesMap.has(sdes)) coveredSdes.add(sdes);
  }
  for (const [sdes, info] of sdesMap.entries()) {
    if (info.e2eRefs.length > 0) coveredSdes.add(sdes);
  }

  const coveredCount = coveredSdes.size;
  const uncoveredCount = uncovered.length;
  const errorCount = issues.filter(i => i.severity === "ERROR").length;
  const warningCount = issues.filter(i => i.severity === "WARNING").length;

  console.log("=== E2E Traceability Report ===\n");
  console.log(`E2E spec files scanned:  ${fileCount}`);
  console.log(`Total SDES in DESIGN-DOC: ${totalSdes}`);
  console.log(`SDES with E2E coverage:   ${coveredCount}/${totalSdes}`);
  console.log(`SDES without any E2E:     ${uncoveredCount}/${totalSdes}`);

  if (uncovered.length > 0) {
    console.log("\n--- Uncovered SDES (no tests) ---");
    for (const sdes of uncovered) {
      const info = sdesMap.get(sdes);
      console.log(`  ${sdes}  [${info.section}/${info.component}]`);
    }
  }

  if (issues.length > 0) {
    console.log("\n--- Issues ---");
    for (const issue of issues) {
      const prefix = issue.severity === "ERROR" ? "ERROR" : "WARN ";
      console.log(`  ${prefix}: ${issue.message}`);
      if (issue.tests) {
        for (const t of issue.tests) console.log(`         -> ${t}`);
      }
      if (issue.declared) {
        for (const d of issue.declared) console.log(`         declared: ${d}`);
      }
    }
  }

  // Summary of per-SDES test counts
  console.log("\n--- Coverage Detail ---");
  const allSdes = [...sdesMap.keys()].sort();
  for (const sdes of allSdes) {
    const info = sdesMap.get(sdes);
    const testCount = tagMap.has(sdes) ? tagMap.get(sdes).length : 0;
    const declared = info.e2eRefs.length;
    const status = testCount > 0 ? "OK" : (declared > 0 ? "DECLARED_NO_TESTS" : "--");
    console.log(`  ${sdes}  tests:${testCount}  declared:${declared}  [${status}]`);
  }

  console.log(`\nErrors: ${errorCount}  Warnings: ${warningCount}`);
  const verdict = errorCount === 0 && warningCount === 0 ? "PASS" : "FAIL";
  console.log(`Verdict: ${verdict}`);

  return verdict === "PASS" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { tagMap, fileCount } = scanE2eFiles();
const sdesMap = parseDesignDoc();
const { issues, uncovered } = crossCheck(tagMap, sdesMap);
const exitCode = report(tagMap, sdesMap, issues, uncovered, fileCount);
process.exit(exitCode);

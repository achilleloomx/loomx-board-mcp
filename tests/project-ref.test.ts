import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProjectRef } from "../src/projectRef.ts";

const rows = [
  { id: "596cd5fc-d385-4763-9c52-6fb48738d7dc", name: "Board MCP", short_name: "board-mcp", agent_id: "board-mcp" },
  { id: "22ae4e79-1800-4975-ba46-cd2f86734257", name: "LoomX AI Governance", short_name: "loomx-ai-governance", agent_id: "loomy" },
  { id: "22ae4e79-ffff-4975-ba46-cd2f86734258", name: "Twin", short_name: "twin", agent_id: null },
  { id: "9010b970-0000-4000-8000-000000000000", name: "Metodo Core", short_name: null, agent_id: "loomy" },
  { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Dup", short_name: "Dup", agent_id: null },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "dup", short_name: "dup-2", agent_id: null },
];

test("full uuid, case-insensitive", () => {
  const r = resolveProjectRef(rows, "596CD5FC-D385-4763-9C52-6FB48738D7DC");
  assert.ok(r.ok && r.row.short_name === "board-mcp" && r.matched_by === "id");
});

test("8-char prefix resolves", () => {
  const r = resolveProjectRef(rows, "596cd5fc");
  assert.ok(r.ok && r.matched_by === "id_prefix" && r.row.id.startsWith("596cd5fc"));
});

test("ambiguous prefix lists candidates, never guesses", () => {
  const r = resolveProjectRef(rows, "22ae4e79");
  assert.ok(!r.ok && /ambiguous/.test(r.error) && /22ae4e79-1800/.test(r.error) && /22ae4e79-ffff/.test(r.error));
  const r2 = resolveProjectRef(rows, "22ae4e79-18");
  assert.ok(r2.ok && r2.row.short_name === "loomx-ai-governance");
});

test("short prefix (<8) is not treated as an id", () => {
  const r = resolveProjectRef(rows, "596cd5f");
  assert.ok(!r.ok && !/id_prefix/.test(r.error));
});

test("short_name exact, then case-insensitive", () => {
  assert.equal((resolveProjectRef(rows, "board-mcp") as any).matched_by, "short_name");
  const r = resolveProjectRef(rows, "BOARD-MCP");
  assert.ok(r.ok && r.matched_by === "short_name_ci");
});

test("exact short_name wins over case-insensitive name collision", () => {
  const r = resolveProjectRef(rows, "Dup");
  assert.ok(r.ok && r.row.id.endsWith("001") && r.matched_by === "short_name");
});

test("name, case-insensitive (rename moves name first)", () => {
  const r = resolveProjectRef(rows, "metodo core");
  assert.ok(r.ok && r.matched_by === "name_ci" && r.row.id.startsWith("9010b970"));
});

test("ambiguous name is an error", () => {
  const extra = [...rows, { id: "bbbbbbbb-0000-4000-8000-000000000003", name: "Metodo Core", short_name: "x", agent_id: null }];
  const r = resolveProjectRef(extra, "Metodo Core");
  assert.ok(!r.ok && /ambiguous \(name_ci, 2 matches\)/.test(r.error));
});

test("not found names the steps tried", () => {
  const r = resolveProjectRef(rows, "nope");
  assert.ok(!r.ok && /short_name, short_name_ci, name_ci/.test(r.error));
  assert.ok(!resolveProjectRef(rows, "  ").ok);
});

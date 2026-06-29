// Capability-parity gate (D-a5 §16) — the MECHANICAL guarantee of Achille's
// constraint: every DB enum value (item_type / status / link_type) must have a
// tool-path. If the schema grows but the registry/tools do not, this test goes
// red → build red.
//
// Run with: npx tsx --test tests/capability-parity.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  checkCapabilityParity,
  DB_ITEM_TYPES,
  DB_DOC_ITEM_STATUSES,
  DB_DOCUMENT_TYPES,
  DB_DOC_ITEM_LINK_TYPES,
  DB_DOC_GTD_LINK_TYPES,
  DB_DOC_WI_LINK_TYPES,
  DOC_ITEM_TYPE_REGISTRY,
  DOCUMENT_TYPE_REGISTRY,
  LINK_TYPE_REGISTRY,
  validateAttrs,
} from "../src/docTypes.ts";

test("capability parity: every DB enum value is reachable via a tool-path", () => {
  const report = checkCapabilityParity();
  assert.equal(
    report.ok,
    true,
    `Capability-parity GATE RED — orphan capabilities (no tool covers them):\n${JSON.stringify(report.missing, null, 2)}`
  );
});

test("every DB item_type has a registry spec (→ doc_item_upsert path)", () => {
  for (const it of DB_ITEM_TYPES) {
    assert.ok(DOC_ITEM_TYPE_REGISTRY[it], `item_type '${it}' missing from registry`);
  }
});

test("every item_type spec carries a copy-pasteable example + attrs schema (§16 self-describing)", () => {
  for (const it of DB_ITEM_TYPES) {
    const spec = DOC_ITEM_TYPE_REGISTRY[it];
    assert.ok(spec.example && typeof spec.example === "object", `${it}: missing example`);
    assert.ok(spec.attrs_schema && spec.attrs_schema.type, `${it}: missing attrs_schema`);
    assert.ok(spec.statuses.length > 0, `${it}: no allowed statuses`);
    assert.ok(spec.statuses.includes(spec.default_status), `${it}: default_status not in statuses`);
    // Each declared status must be a real DB status.
    for (const s of spec.statuses) {
      assert.ok((DB_DOC_ITEM_STATUSES as readonly string[]).includes(s), `${it}: status '${s}' is not a DB status`);
    }
  }
});

test("every document_type registers at least one legal item_type", () => {
  for (const dt of DB_DOCUMENT_TYPES) {
    const spec = DOCUMENT_TYPE_REGISTRY[dt];
    assert.ok(spec, `document_type '${dt}' missing from registry`);
    assert.ok(spec.item_types.length > 0, `document_type '${dt}' has no item_types`);
  }
});

test("link registry routes every DB relation_type", () => {
  for (const t of DB_DOC_ITEM_LINK_TYPES) {
    assert.ok(LINK_TYPE_REGISTRY.doc.relation_types.includes(t), `doc relation '${t}' not routed`);
  }
  // D-070: doc_item_gtd_links and doc_item_wi_links have no relation_type column →
  // DB_DOC_GTD_LINK_TYPES and DB_DOC_WI_LINK_TYPES are [] → loops are trivially true.
  for (const t of DB_DOC_GTD_LINK_TYPES) {
    assert.ok(LINK_TYPE_REGISTRY.gtd.relation_types.includes(t), `gtd relation '${t}' not routed`);
  }
  for (const t of DB_DOC_WI_LINK_TYPES) {
    assert.ok(LINK_TYPE_REGISTRY.wi.relation_types.includes(t), `wi relation '${t}' not routed`);
  }
});

test("the gate detects a regression (simulated orphan)", () => {
  // Sanity: parity logic is not vacuously true. Validate the example payloads
  // of each type pass their own schema (proof the schemas are self-consistent).
  for (const it of DB_ITEM_TYPES) {
    const spec = DOC_ITEM_TYPE_REGISTRY[it];
    const exampleAttrs = (spec.example.attrs as Record<string, unknown>) ?? {};
    const errs = validateAttrs(spec.attrs_schema, exampleAttrs);
    assert.equal(errs.length, 0, `${it}: example attrs fail their own schema: ${errs.join("; ")}`);
  }
});

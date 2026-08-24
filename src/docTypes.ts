// Document model type registry (D-a5 §3.2 / §7 / §16).
//
// Single source of truth for the *tool-floor*: per item_type allowed statuses,
// the JSON-Schema that governs `attrs`, and a copy-pasteable example payload.
// The DB CHECK constraints (migration 20260627020000) are the permissive union;
// this registry is the narrower, self-describing layer that doc_item_types
// introspects and the capability-parity gate verifies.
//
// IMPORTANT: DB_* enums below MIRROR the migration CHECK constraints. When the
// DBA extends an enum, this file MUST be updated in the same change — the
// capability-parity gate (checkCapabilityParity) turns the build red otherwise.

// ---------------------------------------------------------------------------
// DB enum mirrors — keep in sync with migration 20260627020000.
// ---------------------------------------------------------------------------

export const DB_DOCUMENT_TYPES = [
  "sow", "decisions", "req", "sdes", "uat", "exec_summary",
  "mart_contract", "data_contract", "kpi_catalog",
  "release_notes", "changelog", "test_scenario",
  "editorial_calendar", "blog_post",
  "config_pattern",      // D-070 onda-3
] as const;

export const DB_DOCUMENT_STATUSES = [
  "draft", "in_review", "approved", "active", "superseded", "archived", "deprecated",
] as const;

export const DB_ITEM_TYPES = [
  "objective", "deliverable", "stop_condition",
  "requirement",
  "sdes_entry",
  "uat_case", "test_step",
  "decision",
  "exec_point",
  "kpi",
  "mart_column",
  "content_slot",
  "changelog_entry", "release_note",
  "section", "prose",
  "config_pattern",      // D-070 onda-3
] as const;

export const DB_DOC_ITEM_STATUSES = [
  "draft", "proposed", "in_review", "approved", "committed",
  "active", "superseded", "deprecated", "rejected", "archived", "done",
] as const;

export const DB_DOC_ITEM_LINK_TYPES = [
  "refines", "satisfies", "verifies", "relates_to", "supersedes", "amends",
  "references", // D-074: cross-project; routes to doc_item_xproject_links (no same-project FK)
] as const;

// D-070: doc_item_gtd_links and doc_item_wi_links have NO relation_type column —
// the link tables are binary (existence = the actionability fact).
export const DB_DOC_GTD_LINK_TYPES = [] as const;
export const DB_DOC_WI_LINK_TYPES = [] as const;

export type DocumentType = (typeof DB_DOCUMENT_TYPES)[number];
export type ItemType = (typeof DB_ITEM_TYPES)[number];
export type DocItemLinkType = (typeof DB_DOC_ITEM_LINK_TYPES)[number];
export type DocGtdLinkType = (typeof DB_DOC_GTD_LINK_TYPES)[number];
export type DocWiLinkType = (typeof DB_DOC_WI_LINK_TYPES)[number];

// ---------------------------------------------------------------------------
// Minimal JSON-Schema subset (no external dependency — see CLAUDE.md "nessuna
// dipendenza non necessaria"). Supports: type, properties, required, items, enum.
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
}

function typeOk(t: JsonSchema["type"], v: unknown): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    default: return true;
  }
}

// Validate a value against a JsonSchema. Returns a list of actionable error
// strings (empty = valid). Extra/unknown properties are tolerated (additive,
// forward-compatible); declared property types and `required` are enforced.
export function validateAttrs(schema: JsonSchema, value: unknown, path = "attrs"): string[] {
  const errors: string[] = [];

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)})`);
    return errors;
  }

  if (schema.type && !typeOk(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, got ${Array.isArray(value) ? "array" : typeof value}`);
    return errors;
  }

  if (schema.type === "object" && typeOk("object", value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined || obj[req] === null) {
        errors.push(`${path}.${req}: required`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined && obj[key] !== null) {
        errors.push(...validateAttrs(sub, obj[key], `${path}.${key}`));
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((el, i) => {
      errors.push(...validateAttrs(schema.items!, el, `${path}[${i}]`));
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Item-type registry — the tool-floor.
// ---------------------------------------------------------------------------

export interface ItemTypeSpec {
  item_type: ItemType;
  document_types: DocumentType[];       // which document_type(s) this item lives under
  statuses: string[];                   // allowed status values (subset of DB_DOC_ITEM_STATUSES)
  default_status: string;
  attrs_schema: JsonSchema;             // governs `attrs` (validated at write-path)
  example: Record<string, unknown>;     // copy-pasteable doc_item_upsert payload
  description: string;
}

const S_GENERIC = ["draft", "in_review", "approved", "active", "superseded", "archived", "done"];

export const DOC_ITEM_TYPE_REGISTRY: Record<ItemType, ItemTypeSpec> = {
  // ---- sow ----
  objective: {
    item_type: "objective",
    document_types: ["sow"],
    statuses: ["draft", "in_review", "approved", "active", "superseded", "archived"],
    default_status: "draft",
    attrs_schema: { type: "object", properties: { measure: { type: "string", description: "How the objective is measured" } } },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "objective", code: "OBJ-001", body: "Reduce onboarding time to <1 day", attrs: { measure: "median days from signup to first value" } },
    description: "SoW objective — a goal of the engagement.",
  },
  deliverable: {
    item_type: "deliverable",
    document_types: ["sow"],
    statuses: ["draft", "in_review", "approved", "active", "done", "superseded", "archived"],
    default_status: "draft",
    attrs_schema: { type: "object", properties: { acceptance: { type: "string" }, due: { type: "string", description: "ISO date" } } },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "deliverable", code: "DEL-001", body: "Semantic layer v1 with 5 marts", attrs: { acceptance: "Pact contract green", due: "2026-07-15" } },
    description: "SoW deliverable — a concrete output with acceptance.",
  },
  stop_condition: {
    item_type: "stop_condition",
    document_types: ["sow"],
    statuses: ["draft", "in_review", "approved", "active", "superseded", "archived"],
    default_status: "draft",
    attrs_schema: { type: "object", properties: { condition: { type: "string" } }, required: ["condition"] },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "stop_condition", code: "STOP-001", body: "Scope freeze breached", attrs: { condition: "Any new mart not in the agreed list" } },
    description: "SoW stop-condition — when work must halt/re-scope.",
  },
  // ---- req ----
  requirement: {
    item_type: "requirement",
    document_types: ["req"],
    statuses: ["draft", "proposed", "in_review", "approved", "committed", "superseded", "deprecated", "rejected"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        acceptance_criteria: { type: "array", items: { type: "string" } },
        moscow: { type: "string", enum: ["must", "should", "could", "wont"] },
        rationale: { type: "string" },
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "requirement", code: "REQ-001", body: "The system must let an agent send a board message", attrs: { moscow: "must", acceptance_criteria: ["message persisted", "recipient sees it in inbox"] } },
    description: "Atomic requirement. Linked to sdes_entry via 'satisfies' and to uat_case via 'verifies'.",
  },
  // ---- sdes ----
  sdes_entry: {
    item_type: "sdes_entry",
    document_types: ["sdes"],
    statuses: ["draft", "in_review", "approved", "active", "superseded", "deprecated"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        rationale: { type: "string" },
        affected_files: { type: "array", items: { type: "string" } },
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "sdes_entry", code: "SDES-001", body: "Use a single board_messages table with from/to agent codes", attrs: { rationale: "Simplest model that satisfies REQ-001", affected_files: ["src/tools.ts"] } },
    description: "Solution-design entry. 'satisfies' a requirement; source code is annotated with its code.",
  },
  // ---- uat / test_scenario ----
  uat_case: {
    item_type: "uat_case",
    document_types: ["uat", "test_scenario"],
    statuses: ["draft", "in_review", "approved", "active", "done", "superseded", "rejected"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" } },
        expected: { type: "string" },
        pass_fail: { type: "string", enum: ["pass", "fail", "pending"] },
        // D-201/DEL-008 decay (GTD 1dffa01e, ddb6815c): decay_status is a layer on TOP
        // of pass_fail, never a rewrite of it — the historical verdict stays true, it is
        // just no longer trustworthy. Absent = current; only "decayed" is a valid value
        // written here (doc_decay_apply) — a rerun that supersedes the finding clears it
        // by omitting the key, never by inventing a third pass_fail value.
        decay_status: { type: "string", enum: ["decayed"] },
        decay_since: { type: "string" },      // gov.doc_subscription_staleness.changed_at that caused it
        decay_cause_item: { type: "string" }, // code of the row whose substantive change triggered it
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "uat_case", code: "UAT-001", body: "Send a board message and read it back", attrs: { steps: ["call board_send", "call board_inbox"], expected: "message appears", pass_fail: "pending" } },
    description: "UAT case. 'verifies' a requirement or sdes_entry.",
  },
  test_step: {
    item_type: "test_step",
    document_types: ["uat", "test_scenario"],
    statuses: ["draft", "active", "done", "superseded"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        step_no: { type: "integer" },
        action: { type: "string" },
        expected: { type: "string" },
      },
      required: ["action"],
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "test_step", body: "Open the inbox", attrs: { step_no: 1, action: "call board_inbox", expected: "200 + message list" } },
    description: "A single step within a test scenario.",
  },
  // ---- decisions ----
  decision: {
    item_type: "decision",
    document_types: ["decisions"],
    statuses: ["proposed", "approved", "active", "superseded", "deprecated", "rejected"],
    default_status: "proposed",
    attrs_schema: {
      type: "object",
      properties: {
        decision_code: { type: "string", description: "e.g. D-062" },
        context: { type: "string" },
        scope: { type: "string", enum: ["project", "cross"], description: "Impact scope: project-local or cross-project (D-065)" },
        applies_to: { type: "array", items: { type: "string" }, description: "Agent slugs this decision applies to; use [\"all\"] for universal (D-065)" },
        proposed_by: { type: "string", description: "Slug of the agent that proposed the decision (D-065)" },
        superseded_by: { type: "string", description: "Code of the superseding decision, e.g. D-070 (D-065)" },
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "decision", code: "D-062", body: "Ratify the unified documents model", attrs: { decision_code: "D-062", context: "Brainstorm 5 rounds, consensus", scope: "cross", applies_to: ["all"], proposed_by: "loomy" } },
    description: "An architectural/governance decision (DECISIONS log). D-065 attrs: scope (project|cross), applies_to (slugs), proposed_by, superseded_by.",
  },
  // ---- exec_summary ----
  exec_point: {
    item_type: "exec_point",
    document_types: ["exec_summary"],
    statuses: ["draft", "active", "archived"],
    default_status: "draft",
    attrs_schema: { type: "object", properties: { highlight: { type: "boolean" } } },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "exec_point", body: "Q2 revenue up 18% QoQ", attrs: { highlight: true } },
    description: "A bullet in an executive summary.",
  },
  // ---- kpi_catalog ----
  kpi: {
    item_type: "kpi",
    document_types: ["kpi_catalog"],
    statuses: ["draft", "approved", "active", "superseded", "deprecated"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        formula: { type: "string" },
        unit: { type: "string" },
        grain: { type: "string" },
        polarity: { type: "string", enum: ["higher_better", "lower_better", "neutral"] },
      },
      required: ["formula"],
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "kpi", code: "KPI-REVENUE", body: "Monthly recurring revenue", attrs: { formula: "sum(active_subscriptions.amount)", unit: "EUR", grain: "month", polarity: "higher_better" } },
    description: "A catalog KPI definition (semantic, not the computed value).",
  },
  // ---- mart_contract / data_contract ----
  mart_column: {
    item_type: "mart_column",
    document_types: ["mart_contract", "data_contract"],
    statuses: ["draft", "approved", "active", "superseded", "deprecated"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        data_type: { type: "string" },
        pk: { type: "boolean" },
        semantic_mapping: { type: "string" },
        nullable: { type: "boolean" },
      },
      required: ["data_type"],
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "mart_column", code: "MART.fct_sales.amount", body: "Net sales amount", attrs: { data_type: "numeric(12,2)", pk: false, nullable: false, semantic_mapping: "source.invoice.net" } },
    description: "A column in a mart/data contract (analyst↔dev, D-043).",
  },
  // ---- editorial_calendar ----
  content_slot: {
    item_type: "content_slot",
    document_types: ["editorial_calendar"],
    statuses: ["draft", "approved", "active", "done", "archived"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        scheduled_for: { type: "string", description: "ISO date" },
        slot_status: { type: "string", enum: ["idea", "drafting", "scheduled", "published"] },
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "content_slot", code: "SLOT-2026-W27-1", body: "Blog: the unified documents model", attrs: { channel: "blog", scheduled_for: "2026-07-01", slot_status: "idea" } },
    description: "A slot in an editorial calendar.",
  },
  // ---- changelog / release_notes ----
  changelog_entry: {
    item_type: "changelog_entry",
    document_types: ["changelog"],
    statuses: ["draft", "approved", "active", "archived"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        change_type: { type: "string", enum: ["added", "changed", "fixed", "removed", "deprecated", "security"] },
        version: { type: "string" },
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "changelog_entry", body: "Add doc_* MCP tools", attrs: { change_type: "added", version: "0.7.0" } },
    description: "A changelog line (keep-a-changelog style).",
  },
  release_note: {
    item_type: "release_note",
    document_types: ["release_notes"],
    statuses: ["draft", "approved", "active", "archived"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: { version: { type: "string" }, audience: { type: "string" } },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "release_note", body: "v0.7.0 ships the documents model tools", attrs: { version: "0.7.0", audience: "agents" } },
    description: "A user-facing release note.",
  },
  // ---- generic (blog_post, prose) ----
  section: {
    item_type: "section",
    document_types: ["blog_post", "sow", "exec_summary"],
    statuses: S_GENERIC,
    default_status: "draft",
    attrs_schema: { type: "object", properties: { heading: { type: "string" } } },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "section", body: "## Why a single model", attrs: { heading: "Why a single model" } },
    description: "A generic titled section (prose with a heading).",
  },
  prose: {
    item_type: "prose",
    document_types: ["blog_post", "exec_summary", "sow"],
    statuses: S_GENERIC,
    default_status: "draft",
    attrs_schema: { type: "object", properties: {} },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "prose", body: "Free-flowing markdown paragraph...", attrs: {} },
    description: "A generic prose block (no structure).",
  },
  // ---- config_pattern (D-070 onda-3) ----
  config_pattern: {
    item_type: "config_pattern",
    document_types: ["config_pattern"],
    statuses: ["draft", "in_review", "approved", "active", "superseded", "deprecated"],
    default_status: "draft",
    attrs_schema: {
      type: "object",
      properties: {
        component: { type: "string", description: "System component or service this pattern applies to" },
        env: { type: "string", enum: ["dev", "staging", "prod", "all"], description: "Target environment" },
        format: { type: "string", enum: ["yaml", "json", "toml", "env"], description: "Config file format" },
      },
    },
    example: { project_id: "<uuid>", document_id: "<uuid>", item_type: "config_pattern", code: "CFG-001", body: "Database connection pool settings for production", attrs: { component: "api-server", env: "prod", format: "yaml" } },
    description: "A reusable configuration pattern or template for a system component (D-070 onda-3).",
  },
};

// ---------------------------------------------------------------------------
// Document-type registry — which item_types are legal under each document_type.
// ---------------------------------------------------------------------------

export interface DocumentTypeSpec {
  document_type: DocumentType;
  item_types: ItemType[];
  statuses: string[];
  example: Record<string, unknown>;
  description: string;
}

function itemTypesFor(dt: DocumentType): ItemType[] {
  return (Object.values(DOC_ITEM_TYPE_REGISTRY) as ItemTypeSpec[])
    .filter((s) => s.document_types.includes(dt))
    .map((s) => s.item_type);
}

export const DOCUMENT_TYPE_REGISTRY: Record<DocumentType, DocumentTypeSpec> = Object.fromEntries(
  DB_DOCUMENT_TYPES.map((dt) => [
    dt,
    {
      document_type: dt,
      item_types: itemTypesFor(dt),
      statuses: [...DB_DOCUMENT_STATUSES],
      example: { project_id: "<uuid>", document_type: dt, title: `${dt} for <project>`, owner: "<agent-slug>" },
      description: `Document of type '${dt}'.`,
    },
  ])
) as unknown as Record<DocumentType, DocumentTypeSpec>;

// ---------------------------------------------------------------------------
// Link-type registry — routing for the single doc_link tool (target_kind enum).
// ---------------------------------------------------------------------------

export interface LinkTypeSpec {
  target_kind: "doc" | "gtd" | "wi";
  table: "doc_item_links" | "doc_item_gtd_links" | "doc_item_wi_links";
  relation_types: string[];
  description: string;
}

export const LINK_TYPE_REGISTRY: Record<"doc" | "gtd" | "wi", LinkTypeSpec> = {
  doc: {
    target_kind: "doc",
    table: "doc_item_links",
    relation_types: [...DB_DOC_ITEM_LINK_TYPES],
    description:
      "doc_item ↔ doc_item traceability (REQ→SDES→UAT, supersede). " +
      "Routing (SDES-SUB-005, D-155): decided by the FACT of the two endpoints' project_id, not by relation_type label — " +
      "different projects → doc_item_xproject_links (cross-project, no project_id constraint); same project → doc_item_links " +
      "(same-project FK enforced). 'references' always routes cross-project regardless of endpoint projects (D-074).",
  },
  gtd: {
    target_kind: "gtd",
    table: "doc_item_gtd_links",   // D-070: renamed from doc_gtd_links; no relation_type column
    relation_types: [...DB_DOC_GTD_LINK_TYPES],
    description: "doc_item ↔ GTD actionability. UUID-only. FK doc_items + loomx_items (D-070).",
  },
  wi: {
    target_kind: "wi",
    table: "doc_item_wi_links",    // D-070: new table; no relation_type column
    relation_types: [...DB_DOC_WI_LINK_TYPES],
    description: "doc_item ↔ WI execution link. UUID-only. FK doc_items + loomx_work_items (D-070).",
  },
};

export function allowedStatusesForItemType(itemType: string): string[] | null {
  const spec = DOC_ITEM_TYPE_REGISTRY[itemType as ItemType];
  return spec ? spec.statuses : null;
}

export function itemTypeAllowedForDocumentType(itemType: string, documentType: string): boolean {
  const spec = DOC_ITEM_TYPE_REGISTRY[itemType as ItemType];
  return !!spec && spec.document_types.includes(documentType as DocumentType);
}

// ---------------------------------------------------------------------------
// Capability-parity gate (§16) — every DB enum value must be reachable via a
// tool-path. Build red if the schema grows but the registry/tools do not.
// ---------------------------------------------------------------------------

export interface ParityReport {
  ok: boolean;
  missing: {
    item_types: string[];     // DB item_types with no registry spec → no doc_item_upsert path
    statuses: string[];       // DB doc_item statuses not reachable from any item_type's allowed set
    doc_link_types: string[]; // doc_item_links relation_types not routed by doc_link/doc_supersede
    gtd_link_types: string[]; // doc_item_gtd_links relation_types (D-070: empty — no relation_type column)
    wi_link_types: string[];  // doc_item_wi_links relation_types (D-070: empty — no relation_type column)
  };
}

export function checkCapabilityParity(): ParityReport {
  // 1. Every DB item_type has a registry spec (→ creatable via doc_item_upsert).
  const coveredItemTypes = new Set(Object.keys(DOC_ITEM_TYPE_REGISTRY));
  const missingItemTypes = DB_ITEM_TYPES.filter((t) => !coveredItemTypes.has(t));

  // 2. Every DB doc_item status is reachable from at least one item_type's
  //    allowed set (→ settable via doc_item_upsert; 'superseded' also via doc_supersede).
  const reachableStatuses = new Set<string>();
  for (const spec of Object.values(DOC_ITEM_TYPE_REGISTRY)) {
    for (const s of spec.statuses) reachableStatuses.add(s);
  }
  reachableStatuses.add("superseded"); // doc_supersede guarantees this path
  const missingStatuses = DB_DOC_ITEM_STATUSES.filter((s) => !reachableStatuses.has(s));

  // 3. Every link relation_type is routed by doc_link (target_kind) / doc_supersede.
  //    D-070: doc_item_gtd_links and doc_item_wi_links have no relation_type column →
  //    DB_DOC_GTD_LINK_TYPES and DB_DOC_WI_LINK_TYPES are [] → checks trivially pass.
  const docRouted = new Set(LINK_TYPE_REGISTRY.doc.relation_types);
  const gtdRouted = new Set(LINK_TYPE_REGISTRY.gtd.relation_types);
  const wiRouted = new Set(LINK_TYPE_REGISTRY.wi.relation_types);
  const missingDocLink = DB_DOC_ITEM_LINK_TYPES.filter((t) => !docRouted.has(t));
  const missingGtdLink = DB_DOC_GTD_LINK_TYPES.filter((t) => !gtdRouted.has(t));
  const missingWiLink = DB_DOC_WI_LINK_TYPES.filter((t) => !wiRouted.has(t));

  const ok =
    missingItemTypes.length === 0 &&
    missingStatuses.length === 0 &&
    missingDocLink.length === 0 &&
    missingGtdLink.length === 0 &&
    missingWiLink.length === 0;

  return {
    ok,
    missing: {
      item_types: missingItemTypes,
      statuses: missingStatuses,
      doc_link_types: missingDocLink,
      gtd_link_types: missingGtdLink,
      wi_link_types: missingWiLink,
    },
  };
}

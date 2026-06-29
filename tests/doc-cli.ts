// Thin CLI exposing the doc_* tools 1:1 with the SAME descriptions registered
// in src/tools.ts. Used to test Haiku-usability of the tool descriptions when
// the live MCP server (old dist) has not been reloaded with the new tools.
//
//   npx tsx tests/doc-cli.ts help
//   npx tsx tests/doc-cli.ts <tool> '<json-args>'
//
// Tools: doc_create, doc_item_upsert, doc_item_resolve, doc_link,
//        doc_link_by_code, doc_supersede, doc_query, doc_item_types

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, "..", ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const HELP = `LoomX document-model tools (CLI mirror of the MCP tool descriptions).
Usage: npx tsx tests/doc-cli.ts <tool> '<json-args>'

- doc_item_types  Introspect the registry (self-describing). No args = full registry
                  (document_types, item_types, link_types, capability_parity).
                  {item_type:'<type>'} = that type's allowed statuses + attrs JSON-Schema + example.
                  {document_type:'<type>'} = that document's legal item_types.
                  Example: doc_item_types {"item_type":"requirement"}

- doc_create      Create a governance document (header; content lives in doc_items).
                  Defaults: status=draft, version=1.0, visibility=project, owner=you.
                  Example: doc_create {"project_id":"<uuid>","document_type":"req","title":"Requirements"}

- doc_item_upsert Insert/update a typed row. IDEMPOTENT, RETURNS the item UUID. Idempotency
                  key (project_id,code) for coded items. attrs validated vs the item_type schema
                  (call doc_item_types {"item_type":"..."}). Defaults: status=type default, sort_order=append.
                  Example: doc_item_upsert {"project_id":"<uuid>","document_id":"<uuid>","item_type":"requirement","code":"REQ-9","body":"The system must X","attrs":{"moscow":"must"}}

- doc_item_resolve  Resolve a per-project code → UUID. project_id REQUIRED (codes are per-project).
                  Example: doc_item_resolve {"project_id":"<uuid>","code":"REQ-9"}

- doc_query       Query items, or run a traceability check (traceability:'req_without_sdes').
                  Example: doc_query {"project_id":"<uuid>","item_type":"requirement"}

- doc_link        Create a link. UUID-ONLY (no code). target_kind 'doc' (doc_item↔doc_item) or
                  'gtd' (doc_item↔GTD). Example:
                  doc_link {"target_kind":"doc","from_id":"<uuid>","to_id":"<uuid>","relation_type":"satisfies"}

- doc_link_by_code  Sugar: resolve(from_code)+resolve(to_code)+doc_link in ONE call, project-scoped.
                  Example: doc_link_by_code {"project_id":"<uuid>","from_code":"SDES-1","to_code":"REQ-1","link_type":"satisfies"}

- doc_supersede   New version of an item: old→superseded (immutable) + new row + 'supersedes' edge.
                  Example: doc_supersede {"old_item_id":"<uuid>","body":"updated"}
`;

async function run() {
  // Parse: <tool> '<json>' [--as <slug>]
  // --as overrides the CALLER slug (TEST HARNESS ONLY — in production the slug is
  // the board-mcp instance's selfSlug, never a CLI/user input). Used to simulate
  // different agents for the F4.5 RLS smoke.
  const argv = process.argv.slice(2);
  const asIdx = argv.indexOf("--as");
  const callerSlug = asIdx !== -1 ? argv[asIdx + 1] : "board-mcp";
  if (asIdx !== -1) argv.splice(asIdx, 2);

  const tool = argv[0];
  if (!tool || tool === "help" || tool === "--help") { console.log(HELP); return; }
  let args: any = {};
  if (argv[1]) {
    try { args = JSON.parse(argv[1]); }
    catch { console.error(`Error: args must be valid JSON. Got: ${argv[1]}`); process.exit(2); }
  }

  const docs = await import("../src/docs.ts");
  const ctx = { selfSlug: callerSlug, isLoomy: callerSlug === "loomy" };

  // doc_item_types is pure (no DB) — answer directly.
  if (tool === "doc_item_types") {
    const res = docs.docItemTypes(args);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  // All other doc_* run under the doc_rw role with callerSlug bound into the GUC.
  const { runDocRw } = await import("../src/docDb.ts");
  const dispatch = (db: any): Promise<any> => {
    switch (tool) {
      case "doc_create": return docs.docCreate(db, args, ctx);
      case "doc_item_upsert": return docs.docItemUpsert(db, args, ctx);
      case "doc_item_resolve": return docs.docItemResolve(db, args, ctx);
      case "doc_link": return docs.docLink(db, args, ctx);
      case "doc_link_by_code": return docs.docLinkByCode(db, args, ctx);
      case "doc_supersede": return docs.docSupersede(db, args, ctx);
      case "doc_query": return docs.docQuery(db, args, ctx);
      default: console.error(`Unknown tool '${tool}'. Run: npx tsx tests/doc-cli.ts help`); process.exit(2);
    }
  };

  let res: any;
  try {
    res = await runDocRw(callerSlug, (db) => dispatch(db));
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

await run();

// Proof that hardening runtime validation did NOT change the published contract:
// dump every tool's JSON Schema from the pre-fix build (dist/, loose) and from
// the fixed source (src/, strict) and diff them. Also exercises a real tool
// end-to-end. Run: npx tsx tests/verify-strict-contract.ts
//
// BASELINE NOTE: this compares dist/ (as built) against src/. It was run while
// dist/ still held the PRE-fix build, which is what made it a proof; once
// `npm run build` runs, dist/ holds the fixed code and this compares after
// against after (0 diffs, vacuously). The recorded result of the real run is in
// docs/HISTORY.md. The living guarantee is tests/strict-tool-args.test.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const registry = {
  selfCode: "005",
  selfSlug: "board-mcp",
  slugToCode: new Map([["board-mcp", "005"], ["loomy", "001"], ["forge", "037"]]),
  codeToSlug: new Map([["005", "board-mcp"], ["001", "loomy"], ["037", "forge"]]),
} as never;

async function dump(mod: string, label: string) {
  const { registerTools } = await import(mod);
  const server = new McpServer({ name: label, version: "0" });
  registerTools(server, registry);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools;
  const map = new Map(tools.map((t) => [t.name, JSON.stringify(t.inputSchema)]));
  return { map, client, server, tools };
}

const before = await dump("../dist/tools.js", "before");
const after = await dump("../src/tools.js", "after");

console.log(`tool count  before=${before.map.size}  after=${after.map.size}`);
const names = new Set([...before.map.keys(), ...after.map.keys()]);
// The ONE expected delta: home_grocery_categories is declared with `{}` (no
// parameters) and therefore published no additionalProperties claim at all,
// while accepting any key. Hardening it adds "additionalProperties": false —
// the schema now states what the tool always meant. Every other tool's schema
// must be byte-identical.
const EXPECTED_DELTA = new Set(["home_grocery_categories"]);
let unexpected = 0;
for (const n of [...names].sort()) {
  const b = before.map.get(n);
  const a = after.map.get(n);
  if (b === a) continue;
  const expected = EXPECTED_DELTA.has(n);
  if (!expected) unexpected++;
  console.log(`SCHEMA DIFF${expected ? " (expected)" : " — UNEXPECTED"}: ${n}\n  before: ${b}\n  after : ${a}`);
}
console.log(
  `unexpected schema diffs: ${unexpected}  ` +
    (unexpected === 0 ? "=> PUBLISHED CONTRACT UNCHANGED except the declared delta" : "=> CONTRACT CHANGED")
);

// End-to-end on a real tool, both builds.
for (const [label, h] of [["before(loose)", before], ["after(strict)", after]] as const) {
  const res = (await h.client.callTool({
    name: "wi_start",
    arguments: { intent: "repro", gtd_id: "8d4c1330-0000-4000-8000-000000000000" },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = res.content?.[0]?.text ?? "";
  console.log(`\n[wi_start ${label}] isError=${res.isError === true}`);
  console.log(`[wi_start ${label}] ${text.slice(0, 200).replace(/\n\s*/g, " ")}`);
}

for (const h of [before, after]) { await h.client.close(); await h.server.close(); }

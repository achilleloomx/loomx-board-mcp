// Strict-args gate (forge msg 0b7ef2ae, GTD 9856f4ce) — the MECHANICAL guarantee
// that no tool is registered with loose argument validation. Every tool publishes
// "additionalProperties": false; before this gate the runtime silently DROPPED
// unknown keys instead, so a typo changed branch and the caller was told ok
// (wi_start: gtd_id for gtd_item_id -> duplicate GTD auto-created).
//
// If a tool is ever registered outside withStrictToolArgs, this goes red.
//
// Run with: npx tsx --test tests/strict-tool-args.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { withStrictToolArgs } from "../src/strictTools.ts";

const UNKNOWN_KEY = "definitely_not_a_real_param";

async function connect(build: (server: McpServer) => void) {
  const server = new McpServer({ name: "strict-test", version: "0" });
  build(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

test("strict wrapper rejects an unknown key and names it", async () => {
  const h = await connect((server) => {
    withStrictToolArgs(server).tool(
      "sample",
      "desc",
      { intent: z.string(), gtd_item_id: z.string().uuid().optional() },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] })
    );
  });
  const res = (await h.client.callTool({
    name: "sample",
    arguments: { intent: "x", [UNKNOWN_KEY]: "v" },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };

  assert.equal(res.isError, true, "an unknown key must be rejected, not silently dropped");
  assert.match(res.content?.[0]?.text ?? "", new RegExp(UNKNOWN_KEY),
    "the error must name the offending key — that is what makes a typo self-correctable");
  await h.close();
});

test("strict wrapper leaves valid calls and the published schema untouched", async () => {
  const shape = { intent: z.string(), gtd_item_id: z.string().uuid().optional() };
  const cb = async (args: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(args) }] });

  const loose = await connect((s) => { s.tool("sample", "desc", shape, cb); });
  const strict = await connect((s) => { withStrictToolArgs(s).tool("sample", "desc", shape, cb); });

  const looseSchema = (await loose.client.listTools()).tools.find((t) => t.name === "sample")!;
  const strictSchema = (await strict.client.listTools()).tools.find((t) => t.name === "sample")!;
  assert.deepEqual(strictSchema.inputSchema, looseSchema.inputSchema,
    "hardening the runtime must not change the contract published to clients");
  assert.equal(strictSchema.description, looseSchema.description);

  const id = "8d4c1330-0000-4000-8000-000000000000";
  const res = (await strict.client.callTool({
    name: "sample",
    arguments: { intent: "x", gtd_item_id: id },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.notEqual(res.isError, true, "a valid call must still pass");
  assert.deepEqual(JSON.parse(res.content?.[0]?.text ?? "{}"), { intent: "x", gtd_item_id: id });

  await loose.close();
  await strict.close();
});

test("GATE: every registered tool rejects unknown arguments", async () => {
  // Registration touches getSupabaseClient (client construction only, no query).
  process.env.SUPABASE_URL ??= "https://dummy.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";
  // The home_* tools are registered only when these are set (CLAUDE.md). Without
  // them the gate would silently skip 8 tools — the exact shape of blind spot
  // this gate exists to prevent.
  process.env.HOME_FAMILY_ID ??= "00000000-0000-4000-8000-000000000001";
  process.env.HOME_USER_ID ??= "00000000-0000-4000-8000-000000000002";
  const { registerTools } = await import("../src/tools.ts");
  const { registerHumanTools } = await import("../src/humanTools.ts");

  const h = await connect((server) => {
    registerTools(server, {
      selfCode: "005",
      selfSlug: "board-mcp",
      slugToCode: new Map([["board-mcp", "005"], ["loomy", "001"]]),
      codeToSlug: new Map([["005", "board-mcp"], ["001", "loomy"]]),
    } as never);
    // The remote transport (src/remote.ts) registers these 5 alongside the rest.
    registerHumanTools(server, { selfCode: "005", loomyCode: "001" });
  });

  const tools = (await h.client.listTools()).tools;
  assert.ok(tools.length > 0, "no tools registered — the gate would pass vacuously");

  const loose: string[] = [];
  for (const tool of tools) {
    // Send ONLY the unknown key: a strict schema rejects on the unknown key,
    // a loose one falls through to missing-required-field errors or execution.
    // Either way the assertion is on the message naming the key.
    const res = (await h.client.callTool({
      name: tool.name,
      arguments: { [UNKNOWN_KEY]: "v" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    const text = res.content?.[0]?.text ?? "";
    if (!(res.isError === true && text.includes(UNKNOWN_KEY))) {
      loose.push(`${tool.name}: ${text.slice(0, 120)}`);
    }
  }

  assert.deepEqual(loose, [],
    `STRICT-ARGS GATE RED — these tools accepted an unknown argument without naming it ` +
    `(registered outside withStrictToolArgs?):\n${loose.join("\n")}`);
  console.log(`  strict-args gate: ${tools.length} tools verified`);
  await h.close();
});

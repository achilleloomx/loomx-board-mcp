// Does registerTool(name, {inputSchema: z.object(shape).strict()}, cb) publish the
// SAME JSON Schema as the current server.tool(name, desc, shape, cb) form, while
// actually rejecting unknown keys at runtime? Measured, not assumed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const shape = {
  intent: z.string().min(1),
  gtd_item_id: z.string().uuid().optional(),
  pre_conditions: z.record(z.any()).optional(),
};
const DESC = "repro";

const server = new McpServer({ name: "repro", version: "0" });
server.tool("loose", DESC, shape, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
server.registerTool(
  "strict",
  { description: DESC, inputSchema: z.object(shape).strict() },
  async () => ({ content: [{ type: "text" as const, text: "ok" }] })
);

const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "c", version: "0" });
await Promise.all([server.connect(st), client.connect(ct)]);

const tools = (await client.listTools()).tools;
const loose = tools.find((t) => t.name === "loose")!;
const strict = tools.find((t) => t.name === "strict")!;
console.log("loose  schema:", JSON.stringify(loose.inputSchema));
console.log("strict schema:", JSON.stringify(strict.inputSchema));
console.log("SCHEMAS IDENTICAL:", JSON.stringify(loose.inputSchema) === JSON.stringify(strict.inputSchema));
console.log("descriptions equal:", loose.description === strict.description, JSON.stringify(strict.description));

for (const name of ["loose", "strict"]) {
  const res = (await client.callTool({
    name,
    arguments: { intent: "x", gtd_id: "8d4c1330-0000-4000-8000-000000000000" },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  console.log(`\n[${name}] isError=${res.isError === true}`);
  console.log(`[${name}] client sees: ${res.content?.[0]?.text}`);
}
// A valid call must still pass unchanged.
const good = (await client.callTool({
  name: "strict",
  arguments: { intent: "x", gtd_item_id: "8d4c1330-0000-4000-8000-000000000000" },
})) as { isError?: boolean };
console.log("\n[strict] valid call still ok:", good.isError !== true);
await client.close();
await server.close();

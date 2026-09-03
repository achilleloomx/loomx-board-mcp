// Live repro (forge msg 0b7ef2ae): the published JSON Schema declares
// additionalProperties:false, but server.tool(name, desc, rawShape, cb) builds a
// NON-strict z.object — zod silently drops unknown keys. On wi_start a typo
// (gtd_id for gtd_item_id) therefore changes BRANCH: the link is lost and a
// duplicate GTD is auto-created, with ok:true. Run: npx tsx tests/verify-strict-args.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const shape = {
  intent: z.string().min(1),
  gtd_item_id: z.string().uuid().optional(),
};

let seen: unknown = null;

const server = new McpServer({ name: "repro", version: "0" });
// EXACTLY the registration form used 67 times in src/tools.ts
server.tool("wi_start_like", "repro", shape, async (args: unknown) => {
  seen = args;
  return { content: [{ type: "text" as const, text: "ok" }] };
});

const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "c", version: "0" });
await Promise.all([server.connect(st), client.connect(ct)]);

const tool = (await client.listTools()).tools.find((t) => t.name === "wi_start_like")!;
console.log("PUBLISHED SCHEMA :", JSON.stringify(tool.inputSchema));

const res = (await client.callTool({
  name: "wi_start_like",
  arguments: { intent: "x", gtd_id: "8d4c1330-0000-4000-8000-000000000000" },
})) as { isError?: boolean };

console.log("call isError    :", res.isError === true);
console.log("HANDLER GOT     :", JSON.stringify(seen));
console.log("gtd_item_id set :", seen !== null && "gtd_item_id" in (seen as object));
await client.close();
await server.close();

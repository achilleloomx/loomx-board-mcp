// Strict tool-argument validation (forge msg 0b7ef2ae, GTD 9856f4ce).
//
// THE DEFECT. Every tool in this server is registered as
// `server.tool(name, description, rawShape, cb)`. The SDK turns that raw shape
// into a NON-strict `z.object(shape)`, and zod's default for an unknown key is
// to drop it silently. The JSON Schema published to clients, however, is
// generated from the same object and declares `"additionalProperties": false`.
// Schema and runtime therefore said two different things: the client was told
// unknown keys are rejected, and the server quietly accepted and discarded
// them.
//
// WHY IT COSTS. On most tools a dropped key is a lost nuance. On a few it
// changes BRANCH, and the caller is told `ok`:
//   - wi_start: `gtd_id` instead of `gtd_item_id` -> the link is lost and the
//     auto-create branch runs, producing a duplicate GTD (measured: 8d4c1330).
//   - board_send: a typo'd `wake_priority` -> the message ships with no wake.
//     Nobody is woken; the sender believes they pinged. That is exactly the
//     D-118 class of deadlock — a wait that exists only in the head of the
//     agent doing the waiting.
//   - gtd_update: a typo'd `autopilot` -> the GTD is never armed, so the
//     reconciler never dispatches it, and nothing says so.
//
// THE FIX, AND WHY IT IS HERE AND NOT AT THE CALL SITES. Registration is
// routed through `registerTool` with `z.object(shape).strict()`. Hardening the
// registration POINT rather than the ~72 call sites means a tool added
// tomorrow is strict by construction instead of re-opening the defect. It also
// caught 5 registrations in humanTools.ts that a call-site sweep scoped to the
// reported "67 in tools.ts" would have missed.
//
// THIS DOES NOT CHANGE THE PUBLISHED CONTRACT. Measured with
// tests/verify-strict-fix.ts: the JSON Schema emitted for a strict ZodObject is
// byte-identical to the one emitted for the raw shape — `additionalProperties:
// false` in both. Clients are told exactly what they were told before. What
// changes is only that the server now honours it: an unknown key becomes a
// loud -32602 naming the offending key, instead of silent success down the
// wrong branch.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain object whose values are all Zod schemas — the SDK's raw-shape form. */
function isRawShape(value: unknown): value is z.ZodRawShape {
  if (!isPlainObject(value)) return false;
  const values = Object.values(value);
  // An empty object is ambiguous (empty shape vs empty annotations) — handled
  // by the caller, not guessed here.
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { parse?: unknown }).parse === "function"
  );
}

/**
 * Wrap an McpServer so every `.tool()` registration validates its arguments
 * strictly. Returns a Proxy typed as McpServer, so call sites keep the SDK's
 * exact typing and argument inference and need no edit.
 */
export function withStrictToolArgs(server: McpServer): McpServer {
  const registerTool = server.registerTool.bind(server);
  const originalTool = server.tool.bind(server);

  const strictTool = ((...args: unknown[]) => {
    const name = args[0];
    const cb = args[args.length - 1];
    const middle = args.slice(1, -1);

    if (typeof name !== "string" || typeof cb !== "function") {
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    const shapeIndex = middle.findIndex(isRawShape);
    // A tool declared with no parameters (home_grocery_categories passes `{}`)
    // gets an EMPTY strict schema rather than being waved through: "takes no
    // arguments" should mean arguments are refused, not ignored. Measured: this
    // leaves today's behaviour untouched for both a no-`arguments` call (already
    // an error before this change) and an `arguments:{}` call (still fine); the
    // only delta is that an unknown key is now named instead of accepted.
    const shape: z.ZodRawShape = shapeIndex === -1 ? {} : (middle[shapeIndex] as z.ZodRawShape);
    const description = middle.find((a) => typeof a === "string") as string | undefined;
    // Any remaining NON-empty plain object is the annotations argument. Empty
    // objects carry nothing either way, so they never need disambiguating.
    const annotations = middle.find(
      (a, i) => i !== shapeIndex && isPlainObject(a) && Object.keys(a).length > 0
    ) as Record<string, unknown> | undefined;

    return registerTool(
      name,
      {
        ...(description !== undefined ? { description } : {}),
        inputSchema: z.object(shape).strict(),
        ...(annotations !== undefined ? { annotations } : {}),
      } as Parameters<typeof registerTool>[1],
      cb as Parameters<typeof registerTool>[2]
    );
  }) as McpServer["tool"];

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") return strictTool;
      return Reflect.get(target, prop, receiver);
    },
  });
}

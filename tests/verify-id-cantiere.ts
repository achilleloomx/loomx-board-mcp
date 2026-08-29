// Live verification of the cantiere id (D-241) fixes against the REAL DB,
// through the real runDocRw path — the constructed-negative side of
// UAT-ID-001..004. Every doc_rw probe that writes runs inside a transaction
// that is deliberately ROLLED BACK (same discipline as verify-repoint.ts):
// the ambiguity injection for UAT-ID-003 is literally "iniettata e annullata".
//
// Run: npx tsx tests/verify-id-cantiere.ts
//   (needs SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — read from .env if absent —
//    and LOOMX_DOC_RW_URL or DOC_RW_DATABASE_URL)

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

process.env.DOC_RW_DATABASE_URL ||= process.env.LOOMX_DOC_RW_URL ?? "";
// Same backend the real .mcp.json uses: direct-postgres (DATABASE_URL, D-084).
// The local .env service key is stale ("Unregistered API key" measured) — and
// getSupabaseClient refuses conflicting credentials, so drop the SUPABASE pair.
process.env.DATABASE_URL ||= process.env.LOOMX_DB_URL ?? "";
if (process.env.DATABASE_URL) {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
} else {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* .env optional when env is already set */ }
}
if (!process.env.DOC_RW_DATABASE_URL) {
  console.error("set LOOMX_DOC_RW_URL (or DOC_RW_DATABASE_URL)");
  process.exit(2);
}

const { getSupabaseClient } = await import("../src/supabase.ts");
const { runDocRw } = await import("../src/docDb.ts");
const { verifyProjectExists, docFactSync } = await import("../src/factSync.ts");
const { docSubscriptionOutcome } = await import("../src/subscriptions.ts");
const { idResolve } = await import("../src/idResolve.ts");

const SLUG = "board-mcp";
const ctx = { selfSlug: SLUG, isLoomy: false };
const BOARD_MCP = "596cd5fc-d385-4763-9c52-6fb48738d7dc";
const PROBE_DOC = "54e18376-8c5b-472c-bb16-1ce3d4af05ed"; // "[probe] Track B" scratch document
const CANTIERE_GTD = "a5a81b7e-94ee-4f98-8fb3-84141c24e808";
const SDES_ID_001 = "0d68f4bb-2bb2-41e6-8289-e9686d87c563"; // subscriber of a real fact
const REQ_038 = "17730ba8-c714-4b87-9956-254da30644fc"; // its target

const service = getSupabaseClient();
const SCOPE = { selfSlug: SLUG, selfCode: "005", isLoomy: false, isBroker: false, loomyCode: "001" };

const ROLLBACK = Symbol("rollback");
async function probe<T>(fn: (db: any) => Promise<T>): Promise<T> {
  try {
    await runDocRw(SLUG, async (db) => {
      const value = await fn(db);
      throw Object.assign(new Error("rollback"), { [ROLLBACK]: true, value });
    });
  } catch (e: any) {
    if (e && e[ROLLBACK]) return e.value as T;
    throw e;
  }
  throw new Error("unreachable");
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

// --- UAT-ID-001: nonexistent project_id → explicit error citing the id -------
{
  const ghost = randomUUID();
  const gRes = await verifyProjectExists(service as any, ghost);
  check("UAT-ID-001a ghost project refused, id cited", !gRes.ok && (gRes as any).error.includes(ghost), (gRes as any).error?.slice(0, 100));
  const real = await verifyProjectExists(service as any, BOARD_MCP);
  check("UAT-ID-001b real project passes", real.ok === true);
}

// --- UAT-ID-002: relation filter produces NO false orphans -------------------
{
  const res = await probe((db) => docFactSync(db, { project_id: BOARD_MCP, relation_types: ["verifies"], dry_run: true }, ctx));
  if (!res.ok) {
    check("UAT-ID-002 verifies-filtered dry_run runs", false, (res as any).error);
  } else {
    const d = (res as any).data;
    const orphans = d.orphan_facts ?? [];
    // Pre-fix, EVERY satisfies-derived fact showed up here (~40+ on this corpus).
    check(
      "UAT-ID-002a no false orphans under relation filter",
      orphans.length === 0,
      `links_examined=${d.counts.links_examined}, orphans=${orphans.length}${orphans.length ? ` e.g. ${orphans[0].subscriber_code}→${orphans[0].target_code}` : ""}`
    );
    const res2 = await probe((db) => docFactSync(db, { project_id: BOARD_MCP, relation_types: ["satisfies"], dry_run: true }, ctx));
    const o2 = res2.ok ? ((res2 as any).data.orphan_facts ?? []) : null;
    check("UAT-ID-002b symmetric satisfies filter also clean", o2 !== null && o2.length === 0, `orphans=${o2?.length}`);
  }
}

// --- UAT-ID-003: id_resolve — unique / nonexistent / constructed ambiguity ---
{
  // (a) unique: this cantiere's own GTD by 8-char prefix
  const uniq = await idResolve(service as any, { prefix: CANTIERE_GTD.slice(0, 8) }, SCOPE, (fn) => probe(fn));
  check("UAT-ID-003a unique prefix → full uuid", uniq.ok && (uniq as any).data.id === CANTIERE_GTD, uniq.ok ? `${(uniq as any).data.kind}: ${(uniq as any).data.id}` : (uniq as any).error?.slice(0, 120));

  // (b) nonexistent (constructed): 12 random hex — collision odds ~2^-48
  const ghostPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
  const zero = await idResolve(service as any, { prefix: ghostPrefix }, SCOPE, (fn) => probe(fn));
  check("UAT-ID-003b nonexistent prefix → error citing it", !zero.ok && (zero as any).error.includes(ghostPrefix), (zero as any).error?.slice(0, 110));

  // (c) ambiguity, constructed and annulled: two rows sharing an 8-hex prefix,
  // injected into the probe document INSIDE a rolled-back transaction.
  const sharedPrefix = randomUUID().replace(/-/g, "").slice(0, 8);
  const idA = `${sharedPrefix}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const idB = `${sharedPrefix}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
  const amb = await probe(async (db) => {
    for (const [id, tag] of [[idA, "A"], [idB, "B"]] as const) {
      const { error } = await db.from("doc_items").insert({
        id,
        project_id: BOARD_MCP,
        document_id: PROBE_DOC,
        item_type: "config_pattern",
        body: `[UAT-ID-003 ambiguity injection ${tag} — never committed]`,
        status: "draft",
        owner: SLUG,
        sort_order: 9000 + (tag === "A" ? 1 : 2),
        attrs: {},
      });
      if (error) throw new Error(`injection ${tag} failed: ${error.message}`);
    }
    return idResolve(service as any, { prefix: sharedPrefix, kinds: ["doc_item"] }, SCOPE, (fn) => fn(db));
  });
  check(
    "UAT-ID-003c constructed ambiguity → error listing BOTH candidates",
    !amb.ok && (amb as any).error.includes(idA) && (amb as any).error.includes(idB),
    (amb as any).error?.slice(0, 140).replace(/\n/g, " | ")
  );
  // annulled: the transaction rolled back — prove no residue
  const { data: residue } = await probe((db) => db.from("doc_items").select("id").gte("id", `${sharedPrefix}-0000-0000-0000-000000000000`).lte("id", `${sharedPrefix}-ffff-ffff-ffff-ffffffffffff`));
  check("UAT-ID-003d injection annulled (zero residue)", Array.isArray(residue) && residue.length === 0, `rows=${(residue as any[])?.length}`);

  // (e) malformed inputs
  const short = await idResolve(service as any, { prefix: "a5a81b7" }, SCOPE);
  const nonhex = await idResolve(service as any, { prefix: "zzzzzzzz" }, SCOPE);
  check("UAT-ID-003e short/non-hex prefixes refused", !short.ok && !nonhex.ok);
}

// --- UAT-ID-004 (safe branches): natural key resolves; ghost pair cited ------
{
  // Real pair (a fact created today: SDES-ID-001 → REQ-038). Target document has
  // never been published, so the expected refusal is "never been published" —
  // which PROVES the natural key resolved and the flow reached the version step.
  const real = await probe((db) =>
    docSubscriptionOutcome(db, { subscriber_item_id: SDES_ID_001, target_item_id: REQ_038, version: "1.0", outcome: "updated" }, ctx)
  );
  check(
    "UAT-ID-004a natural key resolves a real pair (refusal is at the VERSION step, not the key)",
    !real.ok && /never been published/.test((real as any).error),
    (real as any).error?.slice(0, 120)
  );
  const ghostTarget = randomUUID();
  const ghost = await probe((db) =>
    docSubscriptionOutcome(db, { subscriber_item_id: SDES_ID_001, target_item_id: ghostTarget, version: "1.0", outcome: "updated" }, ctx)
  );
  check("UAT-ID-004b ghost pair → error citing the values", !ghost.ok && (ghost as any).error.includes(ghostTarget), (ghost as any).error?.slice(0, 110));
}

// --- UAT-ID-005 (projection substrate): projected select keeps full ids ------
{
  const { data, error } = await (service as any).from("loomx_items").select("id,title,gtd_status").eq("owner", SLUG).limit(5);
  const allFull = Array.isArray(data) && data.length > 0 && data.every((r: any) => typeof r.id === "string" && r.id.length === 36 && Object.keys(r).length === 3);
  check("UAT-ID-005 projected select returns full 36-char ids, only asked columns", !error && allFull, `rows=${data?.length}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

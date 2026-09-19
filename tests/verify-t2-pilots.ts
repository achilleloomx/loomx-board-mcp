// MEASUREMENT ONLY (loomy msg e2530af8, post-apply dba 20260919013000) —
// T2 minimo on the three pilots, with the REAL modules (fetchApplicableNorms,
// makeDocRwSessionStore, prepareWiNorms/commitWiNorms), under doc_rw with the
// pilot's own slug in the GUC. Each pilot runs inside ONE transaction that is
// deliberately rolled back: nothing lands. Two scenarios per pilot:
//   A) hook cabled: epoch opened ("startup", host_pid) + critical core recorded
//      full → wi_start must deliver only the non-critical difference;
//   B) no hook: wi_start opens an mcp_implicit epoch and delivers the core
//      (REQ-032 grace) → critical_core_delivered_at_wi_start=true.
// Plus: idempotent re-record, RLS isolation (board-mcp cannot see the pilot's
// epoch), wi_norms written = whole due set.
//
// Run: npx tsx tests/verify-t2-pilots.ts
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const mcp = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const expand = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, n) => process.env[n] ?? "");
for (const s of Object.values<any>(mcp.mcpServers ?? {})) {
  if (s?.env?.DATABASE_URL) process.env.DATABASE_URL = expand(s.env.DATABASE_URL);
  if (s?.env?.DOC_RW_DATABASE_URL) process.env.DOC_RW_DATABASE_URL = expand(s.env.DOC_RW_DATABASE_URL);
}
const { getSupabaseClient } = await import("../src/supabase.ts");
const { runDocRw } = await import("../src/docDb.ts");
const S = await import("../src/sessionNorms.ts");
const { wiNormsEnabledFor } = await import("../src/flags.ts");

const db: any = getSupabaseClient();
let fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`, extra ?? "");
  if (!cond) fail++;
};
class Rollback extends Error {}
const T0 = new Date(Date.now() - 60_000).toISOString();

const PILOTS = ["dev-frame", "acme-lab", "analyst-pieroni"];
const OWN_WI = process.env.VERIFY_OWN_WI!; // board-mcp's active WI
const { data: projs } = await db.from("loomx_projects").select("id, short_name, agent_id").limit(5000);
const byShort = (s: string) => projs.find((p: any) => p.short_name === s)?.id;
const PILOT_PROJECT: Record<string, string> = {
  "dev-frame": byShort("frame-method-as-service"),
  "acme-lab": projs.find((p: any) => p.agent_id === "acme-lab" || /acme/i.test(p.short_name ?? ""))?.id,
  "analyst-pieroni": byShort("pieroni-consulting"),
};
console.log("pilot projects:", PILOT_PROJECT);

for (const pilot of PILOTS) {
  console.log(`\n=== ${pilot} ===`);
  check(`${pilot}: covered by LOOMX_WI_NORMS default`, wiNormsEnabledFor(pilot));

  // The native board-mcp role cannot read another agent's WI/GTD (RLS,
  // measured: 0 rows), so the pilot's project is taken from loomx_projects
  // and handed to prepareWiNorms through a GTD→project stub. The wi_norms
  // write is exercised on board-mcp's own active WI (happy path, below) and,
  // under the pilot's slug, on a WI that is NOT the pilot's (must be refused).
  const projectId = PILOT_PROJECT[pilot]!;
  const fakeGtd = randomUUID();
  const dbForPrep: any = new Proxy(db, { get(t, k) {
    if (k === "from") return (table: string) => table === "loomx_item_projects"
      ? { select: () => ({ eq: async () => ({ data: [{ project_id: projectId }], error: null }) }) }
      : t.from(table);
    const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
  console.log(`   project ${projectId.slice(0, 8)}`);

  const core = await S.fetchApplicableNorms(db, pilot, null);
  check(`${pilot}: RPC core ok`, core.ok, core.ok ? `contract ${core.data.rpc_contract_version}` : core.error);
  if (!core.ok) continue;
  const coreNorms = core.data.norms;
  const coreBytes = S.bytesOf(coreNorms);
  const compactBytes = S.bytesOf(coreNorms.map(S.compactNormLine).join("\n"));
  console.log(`   core: ${coreNorms.length} norms, ${coreBytes} B full / ${compactBytes} B compact, threads ${core.data.critical_threads.length}, unpublished ${core.data.critical_core_unpublished.length}, registry_empty ${core.data.critical_registry_empty}`);
  check(`${pilot}: core non-empty & all critical`, coreNorms.length > 0 && coreNorms.every(S.isCritical));

  const due = await S.fetchApplicableNorms(db, pilot, projectId);
  check(`${pilot}: RPC project ok`, due.ok, due.ok ? `${due.data.norms.length} due, houses_unresolved=${JSON.stringify(due.data.houses_unresolved)}` : due.error);

  for (const scenario of ["A-hook", "B-nohook"] as const) {
    try {
      await runDocRw(pilot, async (rw) => {
        const run = (<T>(_slug: string, fn: (d: any) => Promise<T>) => fn(rw)) as any;
        const store = S.makeDocRwSessionStore(pilot, run);
        const hostPid = 900000 + Math.floor(Math.random() * 90000);
        const host = { hostPid, bootedAt: new Date(), envSessionId: `verify-${scenario}-${randomUUID()}` };

        if (scenario === "A-hook") {
          const ep = await store.openEpoch(host.envSessionId!, "startup", hostPid);
          check(`${pilot}/A: epoch opened`, ep.epoch >= 1, ep);
          await store.recordDelivered(ep, coreNorms, "full");
          await store.recordDelivered(ep, coreNorms, "full"); // idempotent
          const held = await store.readDelivered(ep);
          check(`${pilot}/A: core recorded, re-record idempotent`, held.size === coreNorms.length, `${held.size}/${coreNorms.length}`);
        }

        const prep = await S.prepareWiNorms(dbForPrep, { store, host, hardGate: false }, pilot, fakeGtd);
        check(`${pilot}/${scenario}: prepare ready`, prep.kind === "ready", prep.kind === "unavailable" ? prep.fields : prep.kind);
        if (prep.kind !== "ready") throw new Rollback();
        const f = await S.commitWiNorms({ store, host, hardGate: false }, prep, OWN_WI, false);
        const deliveredCrit = (f.delivered ?? []).filter(S.isCritical).length;
        console.log(`   ${scenario}: due ${prep.due.length}, delivered ${f.delivered?.length} (critical ${deliveredCrit}), already ${f.already_in_session?.length}, list_bytes ${f.list_bytes}, core_at_wi_start ${f.critical_core_delivered_at_wi_start}, warn ${f.norms_registry_warning ?? "-"}`);
        check(`${pilot}/${scenario}: no registry warning`, !f.norms_registry_warning, f.norms_registry_warning);
        if (scenario === "A-hook") {
          check(`${pilot}/A: core not re-delivered at wi_start`, deliveredCrit === 0 && f.critical_core_delivered_at_wi_start === false);
        } else {
          check(`${pilot}/B: implicit epoch + core delivered (grace)`, f.critical_core_delivered_at_wi_start === true && deliveredCrit === coreNorms.length);
        }
        if (scenario === "B-nohook") {
          await rw.savepoint("wn");
          let refused = "";
          try { await store.writeWiNorms(OWN_WI, prep.due); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
          await rw.rollbackToSavepoint("wn");
          check(`${pilot}/B: wi_norms on a WI not the pilot's → refused by RLS`, /row-level security|42501|permission/i.test(refused), refused.slice(0, 90));
        }
        const sn = await rw.from(S.SESSION_NORMS_TABLE).select("form").eq("session_id", prep.session!.id).eq("epoch", prep.session!.epoch);
        const expectRows = (scenario === "A-hook" ? coreNorms.length : 0) + (f.delivered?.length ?? 0);
        check(`${pilot}/${scenario}: gov.session_norms rows`, !sn.error && (sn.data ?? []).length === expectRows, sn.error?.message ?? `${sn.data?.length}/${expectRows}`);

        // Second wi_start in the same epoch → nothing new.
        const prep2 = await S.prepareWiNorms(dbForPrep, { store, host, hardGate: false }, pilot, fakeGtd);
        check(`${pilot}/${scenario}: 2nd wi_start same epoch delivers 0`, prep2.kind === "ready" && prep2.delivered.length === 0, prep2.kind === "ready" ? prep2.delivered.length : prep2.kind);

        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) check(`${pilot}/${scenario}: no exception`, false, e instanceof Error ? e.message : e);
    }
  }
}

// Happy path of the wi_norms write under RLS, on board-mcp's OWN WI, rolled back.
{
  const core = await S.fetchApplicableNorms(db, "board-mcp", null);
  try {
    await runDocRw("board-mcp", async (rw: any) => {
      const store = S.makeDocRwSessionStore("board-mcp", ((_s: string, fn: any) => fn(rw)) as any);
      const due = core.ok ? core.data.norms : [];
      await store.writeWiNorms(OWN_WI, due);
      await store.writeWiNorms(OWN_WI, due); // ON CONFLICT DO NOTHING
      const wn = await rw.from(S.WI_NORMS_TABLE).select("code, grade, sources").eq("wi_id", OWN_WI);
      check("board-mcp: gov.wi_norms insert under RLS + idempotent re-insert", !wn.error && wn.data.length === due.length && due.length > 0, wn.error?.message ?? `${wn.data.length}/${due.length}`);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) check("board-mcp: wi_norms happy path", false, e instanceof Error ? e.message : e); }
}

// Nothing landed.
for (const pilot of PILOTS) {
  const n = await runDocRw(pilot, async (rw: any) => (await rw.from(S.SESSION_EPOCHS_TABLE).select("session_id").gte("opened_at", T0)).data?.filter((r: any) => String(r.session_id).startsWith("verify-")).length ?? -1);
  check(`${pilot}: zero residue after rollback`, n === 0, n);
}
process.exit(fail ? 1 : 0);

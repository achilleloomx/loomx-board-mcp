// In-memory SessionStore for unit tests — same contract as
// makeDocRwSessionStore (src/sessionNorms.ts), keyed the same way.
import type { SessionStore, SessionRef, Norm, EpochTrigger } from "../src/sessionNorms.ts";

export interface MemoryStore extends SessionStore {
  epochs: Array<{ id: string; epoch: number; trigger: EpochTrigger; host_pid: number | null; opened_at: string }>;
  delivered: Array<{ session_id: string; epoch: number; key: string; version: string; form: string }>;
  wiNorms: Array<{ wi_id: string; key: string; code: string; version: string; sources: string[] }>;
}

export function makeMemoryStore(): MemoryStore {
  const store: MemoryStore = {
    epochs: [],
    delivered: [],
    wiNorms: [],
    async openEpoch(sessionId, trigger, hostPid) {
      const last = Math.max(0, ...store.epochs.filter((e) => e.id === sessionId).map((e) => e.epoch));
      const row = { id: sessionId, epoch: last + 1, trigger, host_pid: hostPid, opened_at: new Date().toISOString() };
      store.epochs.push(row);
      return { id: row.id, epoch: row.epoch };
    },
    async findEpochs(sinceIso) {
      return store.epochs
        .filter((e) => e.opened_at >= sinceIso)
        .map((e, i) => ({ ...e, i }))
        .sort((a, b) => (a.opened_at === b.opened_at ? b.i - a.i : a.opened_at < b.opened_at ? 1 : -1))
        .map((e) => ({ id: e.id, epoch: e.epoch, host_pid: e.host_pid }));
    },
    async readDelivered(s: SessionRef) {
      const held = new Set<string>();
      for (const d of store.delivered) if (d.session_id === s.id && d.epoch === s.epoch) held.add(`${d.key}@${d.version}`);
      return held;
    },
    async recordDelivered(s: SessionRef, norms: Norm[], form: "compact" | "full") {
      for (const n of norms) {
        const key = `${n.source.project_id}:${n.code}`;
        // insert-only, version inside the key, DO NOTHING on conflict
        const hit = store.delivered.find((d) => d.session_id === s.id && d.epoch === s.epoch && d.key === key && d.version === n.version);
        if (!hit) store.delivered.push({ session_id: s.id, epoch: s.epoch, key, version: n.version, form });
      }
    },
    async writeWiNorms(wiId: string, norms: Norm[]) {
      for (const n of norms) {
        const key = `${n.source.project_id}:${n.code}`;
        if (store.wiNorms.some((w) => w.wi_id === wiId && w.key === key)) continue; // DO NOTHING
        store.wiNorms.push({ wi_id: wiId, key, code: n.code, version: n.version, sources: n.sources });
      }
    },
  };
  return store;
}

/**
 * 2026-11-02 (.online tournament broadcast, P5) — a broadcast rig with the DELAYED
 * hole-card feed on (env BROADCAST_HOLECARD_POLICY=delayed, the owner allowlisted),
 * the index.ts table hooks wired on the REAL PokerTables (handStarted, handResult,
 * tableChanged), a controllable clock, a producer key whose switch can be turned
 * on, delayed keys, and a recorder that stamps every packet a client receives
 * with the (server) time of the step that released it.
 */
import { broadcastRig, settle, type Rig } from './broadcastRig';
import type { Packet, RawClient } from './rawSocketClient';

export const OWNER = { masterUserId: 'm-owner', userId: 1, username: 'owner' };
export const DELAY = 5 * 60_000;
export const HOLECARD_ENV = { BROADCAST_HOLECARD_POLICY: 'delayed', BROADCAST_HOLECARD_ISSUERS: 'm-owner' };

export interface Stamped { at: number; p: Packet }

export interface DelayedRig {
  r: Rig;
  clock(): number;
  adv(ms: number): void;
  /** The live end of each hand, as the handResult hook saw it: `${tableId}#${handNumber}` → server ms. */
  ended: Map<string, number>;
  /** adv(ms), then the wire's 1 s flush (records the program + frames), the delayed release, a settle. */
  step(ms?: number): Promise<void>;
  /** Every packet each watched client got, stamped with the step time that released it. */
  watch(c: RawClient): Stamped[];
  producer(who?: typeof OWNER): Promise<RawClient>;
  mint(req: Record<string, unknown>, who?: typeof OWNER): Promise<any>;
  delayedKey(who?: typeof OWNER, extra?: Record<string, unknown>): Promise<any>;
  /** A connected + subscribed delayed client (its ack). */
  delayedClient(token: string, sub?: Record<string, unknown>): Promise<{ c: RawClient; ack: any; log: Stamped[] }>;
  /** One action at a table (check, else call, else fold), the tableChanged hook. */
  act(tableId: string, kind?: 'passive' | 'fold' | 'allin'): void;
  close(): Promise<void>;
}

export async function delayedRig(o: { env?: Record<string, string>; tables?: number; names?: string[] } = {}): Promise<DelayedRig> {
  const r = await broadcastRig({ env: { ...HOLECARD_ENV, ...(o.env || {}) }, tables: o.tables ?? 2, ...(o.names ? { names: o.names } : {}) });
  const h = r.handle;
  let T = Date.now();
  r.clock.t = T;
  const ended = new Map<string, number>();
  for (const [id, t] of r.w.tables) {
    t.on('handStarted', () => h.hooks.handStarted(id, t));
    t.on('handResult', (d: any) => { ended.set(`${id}#${t.handNumber}`, T); h.hooks.handResult(id, t, d.results); });
  }
  const watched: Array<{ c: RawClient; log: Stamped[]; seen: number }> = [];
  const sweep = () => { for (const w of watched) for (; w.seen < w.c.packets.length; w.seen++) w.log.push({ at: T, p: w.c.packets[w.seen] }); };
  const dr: DelayedRig = {
    r,
    clock: () => T,
    adv: (ms) => { T += ms; r.clock.t = T; },
    ended,
    async step(ms = 0) {
      sweep();
      T += ms;
      r.clock.t = T;
      h.tick();
      h.releaseTick();
      await settle(15);
      sweep();
    },
    watch(c) {
      const w = { c, log: [] as Stamped[], seen: c.packets.length };
      watched.push(w);
      return w.log;
    },
    async producer(who = OWNER) {
      const k = await h.mintToken({ ev: 'ch:*', scopes: ['producer'], label: 'Producer panel', ttlHours: 12 }, who);
      if (!k.ok) throw new Error(`producer key: ${k.code}`);
      const p = r.client('/broadcast', { auth: { key: k.token } });
      if (!(await p.ready).ok) throw new Error('producer handshake');
      return p;
    },
    mint: (req, who = OWNER) => h.mintToken(req as any, who),
    delayedKey: (who = OWNER, extra = {}) => h.mintToken({ ev: `q:${r.w.qualId}`, scopes: ['delayed', 'output'], label: 'OBS delayed', ...extra } as any, who),
    async delayedClient(token, sub = {}) {
      const c = r.client('/broadcast', { auth: { key: token } });
      if (!(await c.ready).ok) throw new Error('delayed handshake');
      const log = dr.watch(c);
      const ack = await c.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9', role: 'output', ...sub });
      return { c, ack, log };
    },
    act(tableId, kind = 'passive') {
      const t = r.w.tables.get(tableId)!;
      const a = t.activeSeatIndex;
      if (kind === 'fold') t.playerFold(a);
      else if (kind === 'allin') { if (!t.playerAllIn(a)) { if (!t.playerCall(a)) t.playerCheck(a); } }
      else if (!t.playerCheck(a) && !t.playerCall(a)) t.playerFold(a);
      h.hooks.tableChanged(tableId);
    },
    close: () => r.close(),
  };
  return dr;
}

/** The bc:frame / bc:snapshot / bc:heartbeat payloads of a stamped log. */
export const payloads = (log: Stamped[], event: string) => log.filter((x) => x.p.type === 2 && x.p.data[0] === event).map((x) => ({ at: x.at, d: x.p.data[1] }));

export { settle };

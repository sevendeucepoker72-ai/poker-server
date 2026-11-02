/**
 * 2026-11-02 (.online tournament broadcast, P2-S9) — THE PRODUCER API and THE
 * PROGRAM STORE on a REAL in-process socket.io server:
 *  - a viewer or an output key gets not_producer (every bc:producer:* call);
 *  - an issuer registered in the channel's event gets producer_is_entrant;
 *  - scene / lower-third changes reach BOTH layouts with the same seq;
 *  - on air auto-clears (9 h after set; 2 h after the event finished);
 *  - every mutation writes auditLog (BROADCAST_PRODUCER_ACTION / BROADCAST_TOKEN_*);
 *  - a channel binding survives a store reload (Postgres broadcast_channels);
 *  - feature locks / releases the featured table (followers re-pointed), refusals,
 *    keys (output only; never a token string in a list), bc:command, the watch push
 *    (public data only).
 */
import { createProgramStore } from '../src/broadcast/programStore';
import { ON_AIR_AFTER_FINISH_MS, ON_AIR_MAX_MS, PRODUCER_EVENTS } from '../src/broadcast/contract';
import { broadcastRig, settle, framesOf, type Rig } from './helpers/broadcastRig';
import { deepScanBroadcast, fakeBroadcastDb } from './helpers/broadcastWorld';

async function producerKey(r: Rig, who: { masterUserId: string | null; userId: number | null; username: string } = { masterUserId: 'm-owner', userId: 1, username: 'owner' }, ev = 'ch:*') {
  const t = await r.handle.mintToken({ ev, scopes: ['producer'], label: 'Producer panel', ttlHours: 12 }, who);
  if (!t.ok) throw new Error(`mint refused: ${t.code}`);
  return t;
}
async function producer(r: Rig, ev = 'ch:*') {
  const t = await producerKey(r, undefined, ev);
  const p = r.client('/broadcast', { auth: { key: t.token } });
  expect((await p.ready).ok).toBe(true);
  return p;
}
const MUTATIONS: Array<[string, Record<string, unknown>]> = [
  ['setEvent', { channel: 'weekly', event: 'next:weekly' }],
  ['setScene', { channel: 'weekly', scene: 'break' }],
  ['setAuto', { channel: 'weekly', scene: true }],
  ['feature', { channel: 'weekly', tableId: null }],
  ['lowerThird', { channel: 'weekly', op: 'show', item: { id: 'lt1', kind: 'host', title: 'Hi' } }],
  ['setFeed', { channel: 'weekly', mode: 'public', delayMin: 0 }],
  ['onAir', { channel: 'weekly', onAir: true, rehearsal: false }],
  ['command', { channel: 'weekly', cmd: 'identify' }],
];

describe('P2-S9 producer — who may produce', () => {
  it('a viewer (no key) and an OUTPUT key get not_producer on every producer call', async () => {
    const r = await broadcastRig();
    try {
      const out = await r.handle.mintToken({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS' }, { masterUserId: 'm-owner', userId: 1, username: 'owner' });
      if (!out.ok) throw new Error('mint');
      const v = r.client('/broadcast');
      const o = r.client('/broadcast', { auth: { key: out.token } });
      await v.ready; await o.ready;
      for (const c of [v, o]) {
        for (const ev of ['hello', 'watch', 'listKeys', 'mintKey', 'revokeKey', ...MUTATIONS.map(([m]) => m)]) {
          expect({ ev, r: await c.request(`bc:producer:${ev}`, { channel: 'weekly' }) }).toEqual({ ev, r: { ok: false, code: 'not_producer' } });
        }
      }
      expect(r.audits.filter((a) => a.action === 'BROADCAST_PRODUCER_ACTION')).toEqual([]);
    } finally { await r.close(); }
  });

  it('an issuer registered in the channel\'s event gets producer_is_entrant (watch and every mutation); a key bound to another channel gets wrong_event', async () => {
    const r = await broadcastRig();
    try {
      const t = await producerKey(r);
      r.w.qt.players.push({ playerId: 'user-owner', masterPlayerId: 'm-owner', localUserId: 1, playerName: 'Owner Person', phone: '', socketId: '' });
      const p = r.client('/broadcast', { auth: { key: t.token } });
      await p.ready;
      expect(await p.request('bc:producer:watch', { channel: 'weekly' })).toEqual({ ok: false, code: 'producer_is_entrant' });
      for (const [m, d] of MUTATIONS.filter(([m]) => m !== 'setEvent')) {
        expect({ m, r: await p.request(`bc:producer:${m}`, d) }).toEqual({ m, r: { ok: false, code: 'producer_is_entrant' } });
      }
      expect(await p.request('bc:producer:setEvent', { channel: 'main', event: `q:${r.w.qualId}` })).toEqual({ ok: false, code: 'producer_is_entrant' });
      expect((await p.request('bc:producer:watch', { channel: 'monthly' })).ok).toBe(true);    // nothing he plays
      r.w.qt.players.pop();
      const w = await producer(r, 'ch:monthly');
      expect(await w.request('bc:producer:onAir', { channel: 'weekly', onAir: true })).toEqual({ ok: false, code: 'wrong_event' });
      expect((await w.request('bc:producer:onAir', { channel: 'monthly', onAir: true })).ok).toBe(true);
    } finally { await r.close(); }
  });
});

describe('P2-S9 producer — the program', () => {
  it('scene + lower third: both layouts get the SAME frames with the same seq; auto back; recap / junk refused; every mutation audited (actor user:<id>)', async () => {
    const r = await broadcastRig();
    try {
      const a = r.client('/broadcast');
      const b = r.client('/broadcast');
      await a.ready; await b.ready;
      await a.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '16x9', follow: 'none' });
      await b.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '9x16', follow: 'none' });
      const p = await producer(r);
      expect(await p.request('bc:producer:setScene', { channel: 'weekly', scene: 'break', params: { note: 'Back soon' } })).toEqual({ ok: true, channel: 'weekly', scene: 'break', auto: false });
      expect(await p.request('bc:producer:lowerThird', { channel: 'weekly', op: 'show', item: { id: 'host1', kind: 'host', title: '  Your host <b>Josh</b>\u0000', sub: 'American Pub Poker', until: null } })).toMatchObject({ ok: true });
      r.handle.tick();
      await settle();
      const fa = framesOf(a).filter((f: any) => f.kind === 'program');
      const fb = framesOf(b).filter((f: any) => f.kind === 'program');
      expect(fa).toHaveLength(1);
      expect(fb.map((f: any) => f.seq)).toEqual(fa.map((f: any) => f.seq));
      expect(fa[0].program.scene).toMatchObject({ id: 'break', auto: false, params: { note: 'Back soon' } });
      expect(fa[0].program.lowerThirds).toEqual([{ id: 'host1', kind: 'host', title: 'Your host <b>Josh</b>', sub: 'American Pub Poker', until: null }]);
      expect(JSON.stringify(fb[0].program)).toBe(JSON.stringify(fa[0].program));
      expect(await p.request('bc:producer:setAuto', { channel: 'weekly', scene: true })).toMatchObject({ ok: true, scene: true });
      expect(await p.request('bc:producer:lowerThird', { channel: 'weekly', op: 'hide', item: { id: 'host1' } })).toMatchObject({ ok: true, lowerThirds: [] });
      r.handle.tick();
      await settle();
      const last = framesOf(a).filter((f: any) => f.kind === 'program').pop();
      expect(last.program.scene).toMatchObject({ id: 'table', auto: true });
      expect(last.program.lowerThirds).toEqual([]);
      expect(await p.request('bc:producer:setScene', { channel: 'weekly', scene: 'recap' })).toEqual({ ok: false, code: 'scene_not_allowed' });
      expect(await p.request('bc:producer:setScene', { channel: 'weekly', scene: 'dance' })).toEqual({ ok: false, code: 'scene_not_allowed' });
      expect(await p.request('bc:producer:setScene', { channel: 'weekly', scene: 'table', params: { a: { deep: 1 } } })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await p.request('bc:producer:lowerThird', { channel: 'weekly', op: 'show', item: { id: 'x', kind: 'evil', title: 't' } })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await p.request('bc:producer:setScene', { channel: 'tv', scene: 'table' })).toEqual({ ok: false, code: 'channel_unknown' });
      const acts = r.audits.filter((x) => x.action === 'BROADCAST_PRODUCER_ACTION');
      expect(acts.map((x) => x.details.action)).toEqual(['setScene', 'lowerThird', 'setAuto', 'lowerThird']);
      for (const x of acts) expect(x).toMatchObject({ actor: 'user:1', details: { channel: 'weekly', jti: expect.any(String) } });
    } finally { await r.close(); }
  });

  it('every mutation (setEvent, setScene, setAuto, feature, lowerThird, setFeed, onAir, command, mintKey, revokeKey) writes auditLog', async () => {
    const r = await broadcastRig();
    try {
      const p = await producer(r);
      for (const [m, d] of MUTATIONS) expect({ m, ok: (await p.request(`bc:producer:${m}`, d)).ok }).toEqual({ m, ok: true });
      const k = await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly', ttlHours: 6 });
      expect(k).toMatchObject({ ok: true, jti: expect.any(String), scopes: ['output'] });
      expect((await p.request('bc:producer:revokeKey', { jti: k.jti })).ok).toBe(true);
      const prod = r.audits.filter((x) => x.action === 'BROADCAST_PRODUCER_ACTION').map((x) => x.details.action);
      expect(prod).toEqual(MUTATIONS.map(([m]) => m));
      expect(r.audits.filter((x) => x.action === 'BROADCAST_TOKEN_ISSUED').map((x) => x.details.ev)).toEqual(['ch:*', 'ch:weekly']);
      expect(r.audits.filter((x) => x.action === 'BROADCAST_TOKEN_REVOKED')).toEqual([expect.objectContaining({ actor: 'user:1', details: expect.objectContaining({ jti: k.jti }) })]);
      expect(JSON.stringify(r.audits)).not.toContain(k.token);
      expect((r.handle.health() as any).producer.mutations).toBe(MUTATIONS.length + 2);
    } finally { await r.close(); }
  });

  it('feature: a lock re-points the followers at once (producer mode; a featured event); null releases it; a table outside the event → table_not_in_event; lockMinutes 0..240', async () => {
    const r = await broadcastRig({ tables: 3 });
    try {
      const a = r.client('/broadcast');
      await a.ready;
      const first = (await a.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '16x9' })).snapshot.table.tableId as string;
      const other = r.w.tableIds.find((x) => x !== first)!;
      const p = await producer(r);
      expect(await p.request('bc:producer:feature', { channel: 'weekly', tableId: 'NOPE' })).toEqual({ ok: false, code: 'table_not_in_event' });
      expect(await p.request('bc:producer:feature', { channel: 'weekly', tableId: other, lockMinutes: 241 })).toEqual({ ok: false, code: 'invalid_request' });
      const res = await p.request('bc:producer:feature', { channel: 'weekly', tableId: other, lockMinutes: 15 });
      expect(res).toMatchObject({ ok: true, tableId: other, mode: 'producer', lockedUntil: expect.any(Number) });
      r.handle.flushTables();
      r.handle.tick();
      await settle();
      const fr = framesOf(a);
      expect(fr.find((f: any) => f.kind === 'event' && f.event.kind === 'featured')).toBeDefined();
      expect(fr.filter((f: any) => f.kind === 'table').pop().table).toMatchObject({ tableId: other, featured: true });
      expect(fr.filter((f: any) => f.kind === 'program').pop().program.featured).toMatchObject({ tableId: other, mode: 'producer', reason: 'producer' });
      expect((r.handle.health() as any).featuredSwitches.producer).toBe(1);
      expect(await p.request('bc:producer:feature', { channel: 'weekly', tableId: null })).toMatchObject({ ok: true, mode: 'auto' });
      r.handle.flushTables();
      r.handle.tick();
      await settle();
      expect(framesOf(a).filter((f: any) => f.kind === 'program').pop().program.featured).toMatchObject({ tableId: other, mode: 'auto' });
    } finally { await r.close(); }
  });

  it('on air: on the program, the heartbeat and GET /api/broadcast/on-air (source producer); auto-clears 9 h after it was set, and 2 h after the event finished', async () => {
    const r = await broadcastRig();
    try {
      const a = r.client('/broadcast');
      await a.ready;
      await a.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '16x9', follow: 'none' });
      const p = await producer(r);
      const t0 = Date.now();
      r.clock.t = t0;
      expect(await p.request('bc:producer:onAir', { channel: 'weekly', onAir: true, rehearsal: true })).toEqual({ ok: true, channel: 'weekly', onAir: true, rehearsal: true, since: t0 });
      r.handle.tick();
      r.handle.heartbeat();
      await settle();
      expect(framesOf(a).filter((f: any) => f.kind === 'program').pop().program).toMatchObject({ onAir: true, rehearsal: true });
      expect(a.events('bc:heartbeat').pop()).toMatchObject({ onAir: true });
      expect(r.handle.onAirView().channels.find((c) => c.channel === 'weekly')).toEqual({ channel: 'weekly', onAir: true, since: t0, eventKey: `q:${r.w.qualId}`, source: 'producer' });
      r.clock.t = t0 + ON_AIR_MAX_MS - 1;
      r.handle.tick();
      expect(r.handle.onAirView().onAir).toBe(true);
      r.clock.t = t0 + ON_AIR_MAX_MS;
      r.handle.tick();
      expect(r.handle.onAirView().onAir).toBe(false);
      expect(r.audits.find((x) => x.details?.action === 'onAirExpired')).toMatchObject({ actor: 'system:broadcast', details: { channel: 'weekly', reason: 'max_age' } });
      // On again; the event finishes; 2 h later it clears.
      r.clock.t = t0 + ON_AIR_MAX_MS + 1000;
      expect((await p.request('bc:producer:onAir', { channel: 'weekly', onAir: true })).ok).toBe(true);
      r.w.qt.status = 'finished';
      r.w.qt.finishedAt = r.clock.t + 60_000;
      r.clock.t += 60_000 + ON_AIR_AFTER_FINISH_MS - 1;
      r.handle.tick();
      expect(r.handle.onAirView().channels.find((c) => c.channel === 'weekly')!.onAir).toBe(true);
      r.clock.t += 1;
      r.handle.tick();
      expect(r.handle.onAirView().channels.find((c) => c.channel === 'weekly')!.onAir).toBe(false);
      expect(r.audits.filter((x) => x.details?.action === 'onAirExpired').map((x) => x.details.reason)).toEqual(['max_age', 'event_finished']);
    } finally { await r.close(); }
  });

  it('setFeed: public ok; delayed under 5 minutes → delay_below_minimum; delayed at 5+ → holecards_off (P5 built dark)', async () => {
    const r = await broadcastRig();
    try {
      const p = await producer(r);
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'public', delayMin: 0 })).toEqual({ ok: true, channel: 'weekly', mode: 'public', delayMs: 0 });
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'delayed', delayMin: 4 })).toEqual({ ok: false, code: 'delay_below_minimum', minDelayMin: 5 });
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'delayed', delayMin: 5 })).toEqual({ ok: false, code: 'holecards_off', policy: 'off' });
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'live' })).toEqual({ ok: false, code: 'invalid_request' });
    } finally { await r.close(); }
  });
});

describe('P2-S9 producer — bindings, keys, commands, the watch push', () => {
  it('setEvent binds a channel (Postgres broadcast_channels); a NEW store loading the same DB has the binding (a redeploy); the channel\'s sources switch with a snapshot', async () => {
    const db = fakeBroadcastDb();
    const r = await broadcastRig({ db });
    try {
      const a = r.client('/broadcast');
      await a.ready;
      expect(await a.request('bc:subscribe', { v: 1, channel: 'sitgo', layout: '16x9', follow: 'none' })).toEqual({ ok: false, code: 'event_not_found', parked: true });
      const p = await producer(r);
      expect(await p.request('bc:producer:setEvent', { channel: 'sitgo', event: 'q:nope' })).toEqual({ ok: false, code: 'event_not_found' });
      const res = await p.request('bc:producer:setEvent', { channel: 'sitgo', event: `q:${r.w.qualId}` });
      expect(res).toEqual({ ok: true, channel: 'sitgo', binding: `q:${r.w.qualId}`, eventKey: `q:${r.w.qualId}`, persisted: true });
      expect(db.channels.get('sitgo')).toMatchObject({ channel: 'sitgo', event_key: `q:${r.w.qualId}`, updated_by: 'user:1' });
      r.handle.tick();
      const snap = await a.next((x) => x.type === 2 && x.data[0] === 'bc:snapshot');
      expect(snap!.data[1].program).toMatchObject({ channel: 'sitgo', eventKey: `q:${r.w.qualId}` });
      const reloaded = createProgramStore({ db, log: () => {} });
      expect(reloaded.bindingOf('sitgo')).toBeNull();
      expect(await reloaded.load()).toEqual({ loaded: 1 });
      expect(reloaded.bindingOf('sitgo')).toBe(`q:${r.w.qualId}`);
      expect(reloaded.bindingOf('weekly')).toBe('next:weekly');
      // Back to the default (null).
      expect((await p.request('bc:producer:setEvent', { channel: 'sitgo', event: null })).binding).toBeNull();
      const again = createProgramStore({ db, log: () => {} });
      await again.load();
      expect(again.bindingOf('sitgo')).toBeNull();
    } finally { await r.close(); }
  });

  it('keys: mintKey output only (producer → scope_not_allowed, delayed → holecards_off); listKeys never returns a token; revokeKey drops its sessions (bc:authExpired)', async () => {
    const r = await broadcastRig();
    try {
      const p = await producer(r);
      expect(await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['producer'], label: 'x' })).toEqual({ ok: false, code: 'scope_not_allowed' });
      expect(await p.request('bc:producer:mintKey', { ev: `q:${r.w.qualId}`, scopes: ['delayed', 'output'], label: 'x' })).toEqual({ ok: false, code: 'holecards_off' });
      const k = await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly', ttlHours: 4 });
      expect(k).toMatchObject({ ok: true, token: expect.any(String), scopes: ['output'] });
      const o = r.client('/broadcast', { auth: { key: k.token } });
      expect((await o.ready).ok).toBe(true);
      const list = await p.request('bc:producer:listKeys', {});
      expect(list.ok).toBe(true);
      expect(list.keys.map((x: any) => [x.label, x.scopes, x.revoked, x.connected])).toEqual([['OBS weekly', ['output'], false, 1], ['Producer panel', ['producer'], false, 1]]);
      expect(JSON.stringify(list)).not.toContain(k.token);
      expect((await p.request('bc:producer:listKeys', { ev: 'ch:weekly' })).keys).toHaveLength(1);
      expect(await p.request('bc:producer:revokeKey', { jti: 'nope' })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await p.request('bc:producer:revokeKey', { jti: k.jti })).toMatchObject({ ok: true, dropped: 1 });
      expect((await o.next((x) => x.type === 2 && x.data[0] === 'bc:authExpired'))!.data[1]).toEqual({ code: 'revoked' });
      const after = await p.request('bc:producer:listKeys', {});
      expect(after.keys.find((x: any) => x.jti === k.jti)).toMatchObject({ revoked: true, connected: 0 });
    } finally { await r.close(); }
  });

  it('command → bc:command {cmd, id} to every source of the channel only; hello counts sources per layout; watch pushes bc:producer:state (public data, at most twice a second)', async () => {
    const r = await broadcastRig();
    try {
      const a = r.client('/broadcast');
      const b = r.client('/broadcast');
      const m = r.client('/broadcast');
      await a.ready; await b.ready; await m.ready;
      await a.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '16x9' });
      await b.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '9x16', follow: 'none' });
      await m.request('bc:subscribe', { v: 1, channel: 'main', layout: '16x9' });
      const p = await producer(r);
      const hello = await p.request('bc:producer:hello', {});
      expect(hello.channels.find((c: any) => c.channel === 'weekly')).toMatchObject({ subscribers: { '16x9': 1, '9x16': 1 }, outputs: 0, eventKey: `q:${r.w.qualId}`, eventName: 'Sunday Weekly Qualifier' });
      expect(hello.events.map((e: any) => e.eventKey)).toEqual([`q:${r.w.qualId}`]);
      const cmd = await p.request('bc:producer:command', { channel: 'weekly', cmd: 'reload' });
      expect(cmd).toMatchObject({ ok: true, id: expect.any(String) });
      await settle();
      expect(a.events('bc:command')).toEqual([{ cmd: 'reload', id: cmd.id }]);
      expect(b.events('bc:command')).toEqual([{ cmd: 'reload', id: cmd.id }]);
      expect(m.events('bc:command')).toEqual([]);
      expect(await p.request('bc:producer:command', { channel: 'weekly', cmd: 'shutdown' })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await p.request(PRODUCER_EVENTS.watch.replace('bc:producer:', 'bc:producer:'), { channel: 'weekly' })).toEqual({ ok: true, channel: 'weekly' });
      const st = await p.next((x) => x.type === 2 && x.data[0] === 'bc:producer:state');
      const state = st!.data[1];
      expect(state.program).toMatchObject({ v: 1, program: { channel: 'weekly', eventKey: `q:${r.w.qualId}` }, feed: { mode: 'public', holeCards: false } });
      expect(state.live).toMatchObject({ tables: expect.any(Array), bufferMs: 0, featuredLive: { tableId: state.program.program.featured.tableId } });
      expect(deepScanBroadcast(state, r.w.players.flatMap((x) => [x.playerId, x.masterId]))).toEqual([]);
      r.clock.t = Date.now();
      r.handle.flushTables();
      r.clock.t += 100;
      r.handle.flushTables();
      await settle();
      expect(p.events('bc:producer:state')).toHaveLength(1);                     // nothing changed, < 5 s: no repeat
      r.w.tables.get(state.program.program.featured.tableId)!.startNewHand();
      r.clock.t += 600;
      r.handle.flushTables();
      await settle();
      expect(p.events('bc:producer:state')).toHaveLength(2);
    } finally { await r.close(); }
  });
});

/**
 * 2026-11-02 (.online tournament broadcast, P2-NS) — THE /broadcast NAMESPACE on
 * a REAL socket.io Server (in process) with raw websocket clients:
 *  - a /broadcast socket cannot spectate / joinTable / stopSpectating (no such
 *    handler there: the game's handlers never run), and never receives the
 *    default namespace's global traffic (activityFeed, serverAnnouncement,
 *    maintenanceMode) nor a table room's gameState — the controls show a default
 *    socket DOES get them;
 *  - the per-connection guards are re-applied: per-IP cap, banned IP, a presented
 *    key (no token support yet → secret_unset), the crash guard;
 *  - the kill switch: POST /api/broadcast/feed (X-Internal-Token, fails closed)
 *    disconnects every /broadcast socket; handshakes are refused `feed_off`;
 *  - subscribe / snapshot / program frames on change only / event frames /
 *    heartbeat / resync, refusal codes, a parked channel.
 */
import { createServer, Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { registerBroadcast, type BroadcastHandle } from '../src/broadcast/wire';
import { clientIpFromHandshake } from '../src/net/clientIp';
import { qualifierWorld, deepScanPublic, type BroadcastTestWorld } from './helpers/broadcastWorld';
import { rawClient, type RawClient } from './helpers/rawSocketClient';

interface Rig {
  http: HttpServer; io: Server; port: number; w: BroadcastTestWorld; handle: BroadcastHandle;
  banned: Set<string>; defaultCalls: string[]; routes: Record<string, (req: any, res: any) => void>; logs: string[]; audits: any[];
  clients: RawClient[]; client(nsp: string, opts?: Parameters<typeof rawClient>[2]): RawClient;
}

async function rig(env: Record<string, string> = {}): Promise<Rig> {
  const http = createServer();
  const io = new Server(http);
  const defaultCalls: string[] = [];
  // The game's default namespace, as far as this test needs it.
  io.on('connection', (s) => {
    s.on('spectate', () => { defaultCalls.push('spectate'); s.join('table:QT1'); });
    s.on('joinTable', () => { defaultCalls.push('joinTable'); });
    s.on('stopSpectating', () => { defaultCalls.push('stopSpectating'); });
  });
  const w = qualifierWorld();
  const banned = new Set<string>();
  const routes: Record<string, (req: any, res: any) => void> = {};
  const logs: string[] = [];
  const audits: any[] = [];
  const handle = registerBroadcast(io, {
    world: w.world,
    realClientIp: (s) => clientIpFromHandshake(s.handshake as any),
    bannedIPs: banned,
    env,
    internalTokenMatches: (given) => given === 'secret-token',
    auditLog: (actor, action, details) => audits.push({ actor, action, details }),
    commit: () => 'abc1234',
    app: { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } },
    log: (l) => logs.push(l),
    timers: false,
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as any).port;
  const clients: RawClient[] = [];
  return {
    http, io, port, w, handle, banned, defaultCalls, routes, logs, audits, clients,
    client: (nsp, opts) => { const c = rawClient(port, nsp, opts); clients.push(c); return c; },
  };
}
async function close(r: Rig) {
  for (const c of r.clients) c.close();
  r.handle.stop();
  await new Promise<void>((done) => r.io.close(() => done()));
}
function res() {
  const out: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  out.set = (k: string, v: string) => { out.headers[k] = v; return out; };
  out.status = (c: number) => { out.statusCode = c; return out; };
  out.json = (b: unknown) => { out.body = b; return out; };
  return out;
}
// 2026-11-02 (P2-S3) — follow 'none': these cases are about the PROGRAM stream (its seq,
// frames, refusals); the featured-table frames of follow 'program' have their own tests
// (broadcastFeatured / broadcastFrame / broadcastE2E) with a frame-aware deep scan.
const SUB = { v: 1, channel: 'weekly', layout: '16x9', follow: 'none' };
const settle = () => new Promise((r) => setTimeout(r, 250));

describe('P2-NS — namespace isolation: a /broadcast socket is not a game socket', () => {
  let r: Rig;
  beforeAll(async () => { r = await rig(); });
  afterAll(async () => { await close(r); });

  it('spectate / joinTable / stopSpectating on /broadcast never reach the game handlers (CONTROL: on the default namespace they do)', async () => {
    const b = r.client('/broadcast');
    expect(await b.ready).toEqual({ ok: true });
    b.emit('spectate', { tableId: 'QT1' });
    b.emit('joinTable', { tableId: 'QT1', seatIndex: 0, buyIn: 5000 });
    b.emit('stopSpectating', {});
    await settle();
    expect(r.defaultCalls).toEqual([]);
    const sockets = await r.io.of('/broadcast').fetchSockets();
    expect(sockets).toHaveLength(1);
    expect([...sockets[0].rooms].filter((x) => x.startsWith('table:'))).toEqual([]);
    const g = r.client('/');
    expect(await g.ready).toEqual({ ok: true });
    g.emit('spectate', { tableId: 'QT1' });
    await settle();
    expect(r.defaultCalls).toEqual(['spectate']);
  });

  it('never receives activityFeed / serverAnnouncement / maintenanceMode (io.emit) nor a table room\'s gameState; the game socket does', async () => {
    const b = r.client('/broadcast');
    const g = r.client('/');
    expect((await b.ready).ok).toBe(true);
    expect((await g.ready).ok).toBe(true);
    g.emit('spectate', { tableId: 'QT1' });
    await settle();
    expect(await b.request('bc:subscribe', SUB)).toMatchObject({ ok: true });
    r.io.emit('activityFeed', ['Kim won a 50,000 pot']);
    r.io.emit('serverAnnouncement', { message: 'late reg closed', kind: 'late_reg_closed' });
    r.io.emit('maintenanceMode', { enabled: true });
    r.io.to('table:QT1').emit('gameState', { pot: 100, players: [] });
    await settle();
    for (const ev of ['activityFeed', 'serverAnnouncement', 'maintenanceMode', 'gameState']) {
      expect({ ev, n: b.events(ev).length }).toEqual({ ev, n: 0 });
      expect({ ev, n: g.events(ev).length }).toEqual({ ev, n: 1 });
    }
  });

  it('a payload-less frame is refused by the crash guard (no crash; the socket keeps answering)', async () => {
    const b = r.client('/broadcast');
    expect((await b.ready).ok).toBe(true);
    b.sendRaw('2/broadcast,["bc:subscribe"]');
    b.sendRaw('2/broadcast,7["bc:subscribe","not an object"]');
    const ack = await b.next((p) => p.type === 3 && p.id === 7);
    expect(ack!.data[0]).toEqual({ success: false, error: 'invalid_payload' });
    expect(await b.request('bc:subscribe', SUB)).toMatchObject({ ok: true });
    expect(r.logs.some((l) => l.includes('[socket-payload-rejected]') && l.includes('bc:subscribe'))).toBe(true);
  });
});

describe('P2-NS — the per-connection guards are re-applied', () => {
  it('per-IP cap (BCAST_MAX_PER_IP) → too_many_connections; another address is fine; a disconnect frees the slot', async () => {
    const r = await rig({ BCAST_MAX_PER_IP: '2' });
    try {
      const ip = { headers: { 'x-real-ip': '203.0.113.9' } };
      const a = r.client('/broadcast', ip);
      const b = r.client('/broadcast', ip);
      expect((await a.ready).ok).toBe(true);
      expect((await b.ready).ok).toBe(true);
      const c = r.client('/broadcast', ip);
      expect(await c.ready).toEqual({ ok: false, error: { message: 'too_many_connections', data: { code: 'too_many_connections' } } });
      const d = r.client('/broadcast', { headers: { 'x-real-ip': '203.0.113.10' } });
      expect((await d.ready).ok).toBe(true);
      a.close();
      await settle();
      const e = r.client('/broadcast', ip);
      expect((await e.ready).ok).toBe(true);
      expect((r.handle.health() as any).refusals).toEqual({ too_many_connections: 1 });
    } finally { await close(r); }
  });

  it('a banned address → banned; a presented key (no token support in this build) → secret_unset, never a silent viewer', async () => {
    const r = await rig();
    try {
      r.banned.add('198.51.100.7');
      const a = r.client('/broadcast', { headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } });
      expect(await a.ready).toEqual({ ok: false, error: { message: 'banned', data: { code: 'banned' } } });
      const k = r.client('/broadcast', { auth: { key: 'eyJhbGciOi.fake.token' } });
      expect(await k.ready).toEqual({ ok: false, error: { message: 'secret_unset', data: { code: 'secret_unset' } } });
      const ok = r.client('/broadcast', { auth: {} });
      expect((await ok.ready).ok).toBe(true);
    } finally { await close(r); }
  });

  it('kill switch: POST /api/broadcast/feed — no / wrong token 403 (fails closed), bad body 400; {on:0} disconnects every /broadcast socket and refuses feed_off; {on:1} back; env BROADCAST_FEED=0 starts off', async () => {
    const r = await rig();
    try {
      const b = r.client('/broadcast');
      expect((await b.ready).ok).toBe(true);
      const post = r.routes['POST /api/broadcast/feed'];
      let x = res(); post({ headers: {}, body: { on: 0 } }, x);
      expect(x.statusCode).toBe(403);
      x = res(); post({ headers: { 'x-internal-token': 'nope' }, body: { on: 0 } }, x);
      expect(x.statusCode).toBe(403);
      x = res(); post({ headers: { 'x-internal-token': 'secret-token' }, body: { on: 'off' } }, x);
      expect(x.statusCode).toBe(400);
      x = res(); post({ headers: { 'x-internal-token': 'secret-token' }, body: { on: 0 } }, x);
      expect(x.body).toEqual({ success: true, previous: true, on: false, disconnected: 1 });
      expect(await b.next((p) => p.type === 1)).not.toBeNull();
      const c = r.client('/broadcast');
      expect(await c.ready).toEqual({ ok: false, error: { message: 'feed_off', data: { code: 'feed_off' } } });
      expect(r.audits).toEqual([{ actor: 'internal:broadcast_feed', action: 'BROADCAST_FEED_SET', details: { previous: true, on: false, disconnected: 1 } }]);
      x = res(); post({ headers: { 'x-internal-token': 'secret-token' }, body: { on: true } }, x);
      expect(x.body).toMatchObject({ success: true, on: true });
      const d = r.client('/broadcast');
      expect((await d.ready).ok).toBe(true);
    } finally { await close(r); }
    const off = await rig({ BROADCAST_FEED: '0' });
    try {
      expect(off.handle.feedOn()).toBe(false);
      const c = off.client('/broadcast');
      expect((await c.ready).error.data).toEqual({ code: 'feed_off' });
    } finally { await close(off); }
  });
});

describe('P2-NS / P2-S2 — subscribe, snapshot, frames, heartbeat', () => {
  it('subscribe {channel:weekly} → ack {ok, snapshot}: v1, the event, the public feed (no hole cards), tables; deep-scanned clean', async () => {
    const r = await rig();
    try {
      const b = r.client('/broadcast');
      expect((await b.ready).ok).toBe(true);
      r.w.tables.get('QT1')!.startNewHand();                       // hole cards dealt at a table
      const ack = await b.request('bc:subscribe', SUB);
      expect(ack.ok).toBe(true);
      const snap = ack.snapshot;
      expect(snap).toMatchObject({ v: 1, seq: 0, feed: { mode: 'public', delayMs: 0, holeCards: false, policy: 'off' }, table: null });
      expect(snap.program).toMatchObject({ v: 1, channel: 'weekly', eventKey: `q:${r.w.qualId}`, onAir: false, event: { kind: 'weekly', status: 'running' } });
      expect(snap.tables.map((t: any) => t.tableNo)).toEqual([1, 2]);
      expect(deepScanPublic(snap, r.w.players.flatMap((p) => [p.playerId, p.masterId]))).toEqual([]);
      // the same event by key, and the 9:16 layout: the same program
      const v = r.client('/broadcast');
      expect((await v.ready).ok).toBe(true);
      const ack2 = await v.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '9x16' });
      expect(ack2.snapshot.program.event).toEqual(snap.program.event);
      expect((r.handle.health() as any)).toMatchObject({ commit: 'abc1234', feedOn: true, policy: 'off', delayMin: 5, subscribers: 2, subscribersByLayout: { '16x9': 1, '9x16': 1 } });
    } finally { await close(r); }
  });

  it('refusals: version_unsupported, channel_unknown, event_not_found, not_broadcastable, wrong_event, a parked channel, rate_limited', async () => {
    const r = await rig();
    try {
      const b = r.client('/broadcast');
      expect((await b.ready).ok).toBe(true);
      expect(await b.request('bc:subscribe', { v: 2, channel: 'weekly', layout: '16x9' })).toEqual({ ok: false, code: 'version_unsupported' });
      expect(await b.request('bc:subscribe', { v: 1, channel: 'tv', layout: '16x9' })).toEqual({ ok: false, code: 'channel_unknown' });
      expect(await b.request('bc:subscribe', { v: 1, layout: '16x9' })).toEqual({ ok: false, code: 'channel_unknown' });
      expect(await b.request('bc:subscribe', { v: 1, event: 'q:nope', layout: '16x9' })).toEqual({ ok: false, code: 'event_not_found' });
      const custom = r.w.tm.createTournament({ name: 'Home', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 1, bb: 2, ante: 0, duration: 60 }] } as any);
      expect(await b.request('bc:subscribe', { v: 1, event: `t:${custom}`, layout: '16x9' })).toEqual({ ok: false, code: 'not_broadcastable' });
      expect(await b.request('bc:subscribe', { v: 1, channel: 'monthly', event: `q:${r.w.qualId}`, layout: '16x9' })).toEqual({ ok: false, code: 'wrong_event' });
      expect(await b.request('bc:subscribe', { v: 1, channel: 'sitgo', layout: '16x9' })).toEqual({ ok: false, code: 'event_not_found', parked: true });
      let last: any = null;
      for (let i = 0; i < 4; i++) last = await b.request('bc:subscribe', SUB);
      expect(last).toEqual({ ok: false, code: 'rate_limited' });
    } finally { await close(r); }
  });

  it('a parked channel gets bc:snapshot the moment it resolves (a fixed OBS URL)', async () => {
    const r = await rig();
    try {
      const saved = r.w.qualifiers.get(r.w.qualId);
      r.w.qualifiers.clear();
      const b = r.client('/broadcast');
      expect((await b.ready).ok).toBe(true);
      expect(await b.request('bc:subscribe', SUB)).toEqual({ ok: false, code: 'event_not_found', parked: true });
      r.handle.tick();
      await settle();
      expect(b.events('bc:snapshot')).toEqual([]);
      r.w.qualifiers.set(r.w.qualId, saved);
      r.handle.tick();
      const snap = await b.next((p) => p.type === 2 && p.data[0] === 'bc:snapshot');
      expect(snap!.data[1]).toMatchObject({ v: 1, seq: 1, program: { eventKey: `q:${r.w.qualId}`, channel: 'weekly' } });
    } finally { await close(r); }
  });

  it('program frames only on change (one seq per stream, both layouts the same seq); event frames at once; heartbeat every call; resync → bc:snapshot', async () => {
    const r = await rig();
    try {
      const a = r.client('/broadcast');
      const v = r.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      expect((await v.ready).ok).toBe(true);
      await a.request('bc:subscribe', SUB);
      await v.request('bc:subscribe', { ...SUB, layout: '9x16' });
      r.handle.tick();
      await settle();
      expect(a.events('bc:frame')).toEqual([]);                   // nothing changed: no frame
      // A stack changes at table 1: the dirty mark (broadcastGameState's hook) + the 1 s flush.
      [...r.w.tables.values()].flatMap((t) => t.seats).find((s) => s.playerName === 'Zed')!.chipCount = 12_000;
      r.handle.hooks.tableChanged('QT1');
      r.handle.tick();
      const fa = await a.next((p) => p.type === 2 && p.data[0] === 'bc:frame');
      const fv = await v.next((p) => p.type === 2 && p.data[0] === 'bc:frame');
      expect(fa!.data[1]).toMatchObject({ v: 1, seq: 1, kind: 'program' });
      expect(fv!.data[1].seq).toBe(1);
      expect(fa!.data[1].program.standings.leaders[0]).toMatchObject({ name: 'Zed', chips: 12_000 });
      r.handle.tick();
      await settle();
      expect(a.events('bc:frame')).toHaveLength(1);
      // A level up (the onEvent hook): an event frame at once (next tick of the loop), seq 2.
      r.handle.hooks.tournamentEvent(r.w.tid, 'blindLevelUp', { level: 2, sb: 50, bb: 100, ante: 0 });
      const ev = await a.next((p) => p.type === 2 && p.data[0] === 'bc:frame' && p.data[1].kind === 'event');
      expect(ev!.data[1]).toMatchObject({ v: 1, seq: 2, kind: 'event', event: { kind: 'levelUp', level: 2 } });
      r.handle.heartbeat();
      const hb = await a.next((p) => p.type === 2 && p.data[0] === 'bc:heartbeat');
      expect(hb!.data[1]).toMatchObject({ seq: 2, delayMs: 0, onAir: false });
      expect(hb!.data[1].programNow).toBe(hb!.data[1].serverNow);
      a.emit('bc:resync', {});
      const rs = await a.next((p) => p.type === 2 && p.data[0] === 'bc:snapshot');
      expect(rs!.data[1]).toMatchObject({ v: 1, seq: 2 });
      expect(rs!.data[1].program.ticker.map((t: any) => t.kind)).toEqual(['levelUp']);
    } finally { await close(r); }
  });

  it('nothing is marked dirty while nobody watches (the broadcastGameState hook is a no-op), and a hook never throws', async () => {
    const r = await rig();
    try {
      r.handle.hooks.tableChanged('QT1');
      expect((r.handle.health() as any).counters.hookErrors).toBe(0);
      const bad = registerBroadcast(new Server(), {
        world: { ...r.w.world, tournament: () => { throw new Error('boom'); }, qualifiers: () => { throw new Error('boom'); } } as any,
        realClientIp: () => '1.1.1.1', bannedIPs: new Set(), internalTokenMatches: () => false, timers: false, log: () => {},
      });
      expect(() => bad.hooks.tournamentEvent('T', 'playerEliminated', { playerId: 'x', position: 3 })).not.toThrow();
      expect(() => bad.hooks.handResult('QT1', { config: { tableName: 'x' }, handNumber: 1, startChips: new Map(), seats: [] }, [{ seatIndex: 0 }])).not.toThrow();
      expect(() => bad.hooks.tableBroken('T', 'QT1')).not.toThrow();
      expect(() => bad.tick()).not.toThrow();
      bad.stop();
    } finally { await close(r); }
  });
});

describe('P2-S2 — REST: events, on-air, results', () => {
  it('GET /api/broadcast/events and /on-air are no-store; results 404 until finished, then the public results', async () => {
    const r = await rig();
    try {
      let x = res(); r.routes['GET /api/broadcast/events']({}, x);
      expect(x.headers['Cache-Control']).toBe('no-store');
      expect(x.body).toEqual([{ eventKey: `q:${r.w.qualId}`, name: 'Sunday Weekly Qualifier', kind: 'weekly', scheduledAt: expect.any(Number), phase: 'running', playersLeft: 8, registered: 8 }]);
      x = res(); r.routes['GET /api/broadcast/on-air']({}, x);
      expect(x.body.onAir).toBe(false);
      expect(x.body.channels.map((c: any) => [c.channel, c.eventKey])).toEqual([['main', `q:${r.w.qualId}`], ['weekly', `q:${r.w.qualId}`], ['monthly', null], ['sitgo', null]]);
      x = res(); r.routes['GET /api/broadcast/:eventKey/results']({ params: { eventKey: `q:${r.w.qualId}` } }, x);
      expect(x.statusCode).toBe(404);
      r.w.qt.status = 'finished';
      r.w.qt.finishedAt = Date.now();
      r.w.qt.results = [{ masterUserId: 'm-0000-101', playerName: 'John Smith', place: 1, wonSeat: true, seats: 3 }];
      await new Promise((d) => setTimeout(d, 1100));             // past the 1 s memo
      x = res(); r.routes['GET /api/broadcast/:eventKey/results']({ params: { eventKey: `q:${r.w.qualId}` } }, x);
      expect(x.statusCode).toBe(200);
      expect(x.body).toEqual({ results: [{ place: 1, pid: expect.stringMatching(/^b-[0-9a-f]{16}$/), name: 'John S.', seatsWon: 3 }] });
    } finally { await close(r); }
  });
});

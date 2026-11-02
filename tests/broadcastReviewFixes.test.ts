/**
 * 2026-11-02 (.online tournament broadcast, review round 1) — regression guards for
 * the poker-server fixes of the phase-1 review. Each block reproduces the reported
 * state and asserts the fixed behaviour (each failed on the pre-fix code):
 *  F8  bc:resync is metered per socket, a stream's resync snapshot is reused, and a
 *      socket past its packet budget is disconnected (one anonymous socket used to
 *      rebuild + send a full snapshot per packet);
 *  F2  the whole-feed kill switch LATCHES the hole-card switch off (audited);
 *  F1  a delayed feed armed while the qualifier is still registering (tournamentId
 *      null) merges faces and accepts a delayedPin once the tables open;
 *  F3  a showdown's tabled cards are not shown under a player moved into the seat;
 *  F4  after a restart a keyed handshake waits for the persisted key list (it used to
 *      be refused 'revoked', and the page dropped its key); a failed load is retried;
 *  F7/F9 keyed sessions have their own budget (anonymous sockets cannot lock OBS /
 *      the producer out) and a keyless browser handshake must come from the page's origin;
 *  F5  with the feed off the hooks capture nothing;
 *  F10 a key minted from a producer key is capped at its parent's exp, cannot start
 *      after it, is revoked with it, and is audited with the parent jti;
 *  F12 a scoped producer key lists / revokes only the keys it covers;
 *  F13 the panel's 'ch:*' key bars its holder from an event only while connected and
 *      a channel shows that event; the ch:* mint is refused only for an event a channel shows;
 *  F14 adminSetBroadcastOptOut needs the login's admin claim; both admin paths ask the
 *      master again (false = refused, unknown = the claim stands);
 *  F11 'john.smith' / 'Mary_Jones' / 'josh.hall2' → First L.
 */
import { GamePhase, PokerTable } from '../src/game/PokerTable';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { toBroadcastTableFrame } from '../src/broadcast/broadcastFrame';
import { broadcastNameOf } from '../src/broadcast/broadcastNames';
import { createBroadcastOptOutHandlers, createBroadcastOptOutStore } from '../src/broadcast/broadcastNames';
import { createBroadcastIssueHandler } from '../src/broadcast/broadcastToken';
import { registerBroadcast } from '../src/broadcast/wire';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { broadcastRig, settle, TEST_SECRET, type Rig } from './helpers/broadcastRig';
import { fakeBroadcastDb, qualifierWorld } from './helpers/broadcastWorld';
import { DELAY, OWNER, delayedRig, payloads, type DelayedRig } from './helpers/delayedRig';

jest.setTimeout(60_000);

const PRODUCER = { ev: 'ch:*', scopes: ['producer'], label: 'Producer panel', ttlHours: 12 };

async function producerClient(r: Rig, who = OWNER, req: Record<string, unknown> = PRODUCER) {
  const k = await r.handle.mintToken(req as any, who);
  if (!k.ok) throw new Error(`producer key: ${k.code}`);
  const p = r.client('/broadcast', { auth: { key: k.token } });
  const ready = await p.ready;
  return { p, k, ready };
}

// ================================================================ F8 (P1)
describe('F8 — bc:resync is metered; a stream reuses its resync snapshot; a socket past its packet budget is dropped', () => {
  it('150 resyncs in a burst (under the packet budget): 2 snapshots, the rest dropped silently, still connected; 1000 packets: disconnected, nothing dispatched past the budget', async () => {
    const r = await broadcastRig();
    try {
      const a = r.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      expect((await a.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9' })).ok).toBe(true);
      for (let i = 0; i < 150; i++) a.emit('bc:resync', {});
      await settle(300);
      expect(a.events('bc:snapshot').length).toBe(2);
      expect(a.disconnected()).toBe(false);
      let h = r.handle.health() as any;
      expect(h.counters.resyncsDropped).toBe(148);
      expect(h.counters.snapshotsSent).toBe(3);    // the subscribe ack + 2 resyncs (one reused)
      expect(h.counters.builds).toBe(1);           // no rebuild per resync
      // A flood past the budget (200 packets / 10 s): the socket is dropped; nothing past it runs.
      const b = r.client('/broadcast');
      expect((await b.ready).ok).toBe(true);
      expect((await b.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9' })).ok).toBe(true);
      for (let i = 0; i < 1000; i++) b.emit('bc:resync', {});
      await settle(300);
      expect(b.disconnected()).toBe(true);
      expect(b.events('bc:snapshot').length).toBeLessThanOrEqual(2);
      h = r.handle.health() as any;
      expect(h.counters.overBudget).toBe(1);
      expect(h.refusals.packet_budget).toBe(1);
      expect(h.counters.snapshotsSent).toBeLessThanOrEqual(6);
      // Another viewer is served normally.
      const c = r.client('/broadcast');
      expect((await c.ready).ok).toBe(true);
      expect((await c.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9' })).ok).toBe(true);
    } finally { await r.close(); }
  });

  it('a page at its own pace (one resync per 2 s) is answered every time; two pages of one stream within 1 s share one build (reused)', async () => {
    const r = await broadcastRig();
    try {
      let T = Date.now();
      r.clock.t = T;
      const a = r.client('/broadcast');
      const b = r.client('/broadcast');
      await a.ready; await b.ready;
      for (const c of [a, b]) expect((await c.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9' })).ok).toBe(true);
      for (let i = 0; i < 4; i++) {
        a.emit('bc:resync', {});
        await settle(40);
        T += 2000; r.clock.t = T;
      }
      expect(a.events('bc:snapshot').length).toBe(4);
      // Same seq, same build, within 1 s: b's snapshot is a's, with its own serverNow.
      a.emit('bc:resync', {});
      await settle(40);
      r.clock.t = T + 300;
      b.emit('bc:resync', {});
      await settle(60);
      const sa = a.events('bc:snapshot').pop();
      const sb = b.events('bc:snapshot').pop();
      expect(sb.serverNow).toBe(T + 300);
      expect({ ...sb, serverNow: 0 }).toEqual({ ...sa, serverNow: 0 });
      expect((r.handle.health() as any).counters.resyncsReused).toBeGreaterThanOrEqual(1);
    } finally { await r.close(); }
  });
});

// ================================================================ F2
describe('F2 — the whole-feed kill switch latches the hole-card switch off', () => {
  it('switch on → feed off → feed on: the switch is OFF (audited via feed_off); the same delayed key is refused holecards_off', async () => {
    const d = await delayedRig();
    try {
      const h = d.r.handle;
      const p = await d.producer();
      expect(await p.request('bc:producer:holeCardsSwitch', { on: true })).toMatchObject({ ok: true, on: true });
      const k = await d.delayedKey();
      expect(k.ok).toBe(true);
      h.setFeedOn(false, 'internal:test');
      expect(h.delayed.switchOn()).toBe(false);
      h.setFeedOn(true, 'internal:test');
      expect(h.delayed.switchOn()).toBe(false);
      const sets = d.r.audits.filter((a) => a.action === 'BROADCAST_HOLECARDS_SET');
      expect(sets.map((a) => [a.details.on, a.details.via])).toEqual([[true, 'producer'], [false, 'feed_off']]);
      const again = await d.delayedClient(k.token);
      expect(again.ack).toEqual({ ok: false, code: 'holecards_off' });
      expect(h.delayBuffer.armedEvents()).toEqual([]);
    } finally { await d.close(); }
  });
});

// ================================================================ F1
/** One hand at a table, folded round (kind 'fold'), stepping the rig `everyMs` per action. */
async function playHand(d: DelayedRig, tableId: string, everyMs: number, kind: 'passive' | 'fold' = 'fold') {
  const t = d.r.w.tables.get(tableId)!;
  for (const s of t.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = 5000; s.eliminated = false; }
  expect(t.startNewHand()).toBe(true);
  d.r.handle.hooks.tableChanged(tableId);
  await d.step(everyMs);
  for (let g = 0; g < 60 && t.isHandInProgress(); g++) {
    d.act(tableId, kind);
    if (t.isHandInProgress()) await d.step(everyMs);
  }
  return t.handNumber;
}

describe('F1 — a delayed feed armed while the qualifier is still registering', () => {
  it('armed with tournamentId null; tables open: delayedPin works, frame pids = hand-record pids, faces are released after the delay', async () => {
    const d = await delayedRig();
    try {
      const { r } = d;
      const w = r.w;
      // The normal setup: the delayed source connects while the qualifier registers.
      w.qt.tournamentId = null;
      w.qt.status = 'registering';
      const p = await d.producer();
      expect(await p.request('bc:producer:holeCardsSwitch', { on: true })).toMatchObject({ ok: true });
      const k = await d.delayedKey();
      expect(k.ok).toBe(true);
      const s = await d.delayedClient(k.token);
      expect(s.ack).toEqual({ ok: false, code: 'event_not_found', parked: true });
      expect(r.handle.delayBuffer.eventOf(`q:${w.qualId}`)!.tournamentId).toBeNull();
      expect(await p.request('bc:producer:delayedPin', { tableId: 'QT1' })).toEqual({ ok: false, code: 'not_captured' });
      // The tables open (index.ts sets qt.tournamentId), the event runs.
      w.qt.tournamentId = w.tid;
      w.qt.status = 'running';
      await d.step(1000);
      expect(r.handle.delayBuffer.eventOf(`q:${w.qualId}`)!.tournamentId).toBe(w.tid);
      expect(await p.request('bc:producer:delayedPin', { tableId: 'QT1' })).toMatchObject({ ok: true, tableId: 'QT1' });
      const hn = await playHand(d, 'QT1', 1000);
      // The hand record and the recorded frames key every seat by the SAME pid.
      const rec = r.handle.delayBuffer.hand(`q:${w.qualId}`, 'QT1', hn)!;
      expect(rec).toBeDefined();
      for (let i = 0; i < 7; i++) await d.step(60_000);
      const frames = payloads(s.log, 'bc:frame').filter((f) => f.d.kind === 'table' && f.d.table.tableId === 'QT1' && f.d.table.handNumber === hn);
      expect(frames.length).toBeGreaterThan(0);
      const framePids = new Set(frames.flatMap((f) => f.d.table.seats.map((x: any) => x.pid)));
      for (const v of rec.seats.values()) expect(framePids.has(v.pid)).toBe(true);
      const faced = frames.filter((f) => f.d.table.seats.some((x: any) => x.holeCards));
      expect(faced.length).toBeGreaterThan(0);
      for (const f of faced) {
        expect(f.d.table.holeCardsReleasedAt).toBeGreaterThanOrEqual(f.d.table.t + DELAY);
        expect(f.d.table.holeCardsReleasedAt).toBeLessThanOrEqual(f.at);
      }
      expect((r.handle.health() as any).delayedFeed.facesReleased).toBeGreaterThan(0);
    } finally { await d.close(); }
  });
});

// ================================================================ F3
describe('F3 — a showdown\'s tabled cards stay with the player who tabled them', () => {
  it('a tabled seat re-filled before the next deal shows nothing under the newcomer (cards, hand name, showdownSeats)', () => {
    const t = new PokerTable({ tableId: 'T1', tableName: 'Qualifier Table 1', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000, maxPlayers: 9 } as any);
    ['a', 'b', 'c'].forEach((pid, i) => t.sitDown(i, `Player ${pid.toUpperCase()}`, 5000, pid, false));
    expect(t.startNewHand()).toBe(true);
    const folder = t.activeSeatIndex;
    expect(t.playerFold(folder)).toBe(true);
    expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) if (!t.playerCall(t.activeSeatIndex)) t.playerFold(t.activeSeatIndex);
    expect(t.wentToShowdown).toBe(true);
    expect([GamePhase.Showdown, GamePhase.HandComplete]).toContain(t.currentPhase);
    const tabled = t.lastHandResult!.showdownHands.map((h) => h.seatIndex).filter((i) => i !== folder);
    expect(tabled.length).toBe(2);
    for (const h of t.lastHandResult!.showdownHands) expect(h.playerId).toBe(t.seats[h.seatIndex].playerId);
    const ctx = { now: 1, tableNo: 1, featured: true, identityOf: (s: { playerId: string; playerName: string }) => ({ pid: `b-${s.playerId}`, name: s.playerName }) };
    const before = toBroadcastTableFrame(t, ctx);
    expect(before.handResult!.showdownSeats).toEqual([...tabled].sort((x, y) => x - y));
    // A move seats someone else in a tabled seat before the next deal.
    const k = tabled[1];
    expect(t.standUp(k)).toBe(true);
    expect(t.sitDown(k, 'Zed Moved', 5000, 'zed', false)).toBe(true);
    const after = toBroadcastTableFrame(t, ctx);
    const moved = after.seats.find((s) => s.seatIndex === k)!;
    expect(moved).toMatchObject({ name: 'Zed Moved', holeCards: null });
    expect(moved).not.toHaveProperty('handName');
    expect(after.handResult!.showdownSeats).toEqual([tabled[0]]);
    expect(after.seats.find((s) => s.seatIndex === tabled[0])!.holeCards).not.toBeNull();
  });
});

// ================================================================ F4
describe('F4 — after a restart a keyed handshake waits for the persisted key list', () => {
  it('a key minted before the "restart" is admitted once the list loads (not refused revoked); a load that cannot finish → registry_loading (retryable)', async () => {
    const db = fakeBroadcastDb();
    const before = await broadcastRig({ db });
    let token = '';
    try {
      await before.handle.loadPersisted();
      const k = await before.handle.mintToken({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly' } as any, OWNER);
      if (!k.ok) throw new Error('mint');
      token = k.token;
    } finally { await before.close(); }
    // The new process: the key list is not read yet.
    const r = await broadcastRig({ db, env: { BCAST_KEY_LIST_WAIT_MS: '3000' } });
    try {
      expect(r.handle.tokens.isLoaded()).toBe(false);
      const c = r.client('/broadcast', { auth: { key: token } });
      await settle(80);
      void r.handle.loadPersisted();
      expect(await c.ready).toEqual({ ok: true });
      expect((r.handle.health() as any).counters.keyWaits).toBe(1);
      // Once loaded, an unknown jti is still refused 'revoked' at once (fail-closed).
      const other = await broadcastRig({ db: fakeBroadcastDb() });
      const foreign = await other.handle.mintToken({ ev: 'ch:weekly', scopes: ['output'], label: 'x' } as any, OWNER);
      await other.close();
      const f = r.client('/broadcast', { auth: { key: (foreign as any).token } });
      expect((await f.ready).error.data).toEqual({ code: 'revoked' });
    } finally { await r.close(); }
    // The DB stays down: the handshake gives up after the wait with a RETRYABLE code.
    const down = fakeBroadcastDb();
    down.fail = true;
    const r2 = await broadcastRig({ db: down, env: { BCAST_KEY_LIST_WAIT_MS: '150' } });
    try {
      await r2.handle.loadPersisted();
      const c = r2.client('/broadcast', { auth: { key: token } });
      // Fix round 2: the retryable code is 'registry_loading' (it was 'starting'; poker-3d keeps its key on it).
      expect((await c.ready).error.data).toEqual({ code: 'registry_loading' });
    } finally { await r2.close(); }
  });

  it('a failed load is retried with backoff until it succeeds (timers on)', async () => {
    const http = createServer();
    const io = new Server(http);
    const w = qualifierWorld();
    const db = fakeBroadcastDb();
    db.fail = true;
    const logs: string[] = [];
    const handle = registerBroadcast(io, {
      world: w.world, realClientIp: () => '127.0.0.1', bannedIPs: new Set(),
      env: { BROADCAST_TOKEN_SECRET: TEST_SECRET, BCAST_PERSISTED_RETRY_MS: '20' },
      internalTokenMatches: () => false, db, log: (l) => logs.push(l), timers: true,
    });
    try {
      await handle.loadPersisted();
      expect(handle.tokens.isLoaded()).toBe(false);
      db.fail = false;
      for (let i = 0; i < 40 && !handle.tokens.isLoaded(); i++) await settle(25);
      expect(handle.tokens.isLoaded()).toBe(true);
      expect((handle.health() as any).counters.persistedRetries).toBeGreaterThan(0);
    } finally {
      handle.stop();
      await new Promise<void>((done) => io.close(() => done()));
    }
  });
});

// ================================================================ F7 / F9
describe('F7/F9 — keyed sessions have their own budget; keyless browser pages must come from the broadcast origin', () => {
  it('a full anonymous pool still admits a keyed producer and output; the keyed budget is separate; the per-IP cap is for keyless sockets', async () => {
    const r = await broadcastRig({ env: { BCAST_MAX_SOCKETS: '2', BCAST_MAX_PER_IP: '2', BCAST_MAX_KEYED: '2' } });
    try {
      const a = r.client('/broadcast'); const b = r.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      expect((await b.ready).ok).toBe(true);
      const c = r.client('/broadcast');
      expect((await c.ready).error.data).toEqual({ code: 'too_many_connections' });
      const { ready } = await producerClient(r);
      expect(ready).toEqual({ ok: true });
      const out = await r.handle.mintToken({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS' } as any, OWNER);
      const o = r.client('/broadcast', { auth: { key: (out as any).token } });
      expect((await o.ready).ok).toBe(true);
      // The keyed budget (2) is its own.
      const third = r.client('/broadcast', { auth: { key: (out as any).token } });
      expect((await third.ready).error.data).toEqual({ code: 'too_many_connections' });
      expect((r.handle.health() as any).connectionsNow).toEqual({ keyless: 2, keyed: 2 });
    } finally { await r.close(); }
  });

  it('Origin: another site → origin_not_allowed; the .online page, localhost dev and no Origin → admitted; a keyed handshake is not origin-checked; BCAST_ALLOWED_ORIGINS=* turns it off', async () => {
    const r = await broadcastRig();
    try {
      const evil = r.client('/broadcast', { headers: { Origin: 'https://evil.example' } });
      expect((await evil.ready).error.data).toEqual({ code: 'origin_not_allowed' });
      for (const origin of ['https://americanpubpoker.online', 'https://www.americanpubpoker.online', 'http://localhost:5173']) {
        const ok = r.client('/broadcast', { headers: { Origin: origin } });
        expect({ origin, ok: (await ok.ready).ok }).toEqual({ origin, ok: true });
      }
      const k = await r.handle.mintToken(PRODUCER as any, OWNER);
      const keyed = r.client('/broadcast', { headers: { Origin: 'https://evil.example' }, auth: { key: (k as any).token } });
      expect((await keyed.ready).ok).toBe(true);
    } finally { await r.close(); }
    const open = await broadcastRig({ env: { BCAST_ALLOWED_ORIGINS: '*' } });
    try {
      const any = open.client('/broadcast', { headers: { Origin: 'https://evil.example' } });
      expect((await any.ready).ok).toBe(true);
    } finally { await open.close(); }
  });
});

// ================================================================ F5
describe('F5 — with the feed off the hooks capture nothing', () => {
  it('tournament events / table breaks / hand results while off: no capture, no deferred work; back on: captured again', async () => {
    const r = await broadcastRig();
    try {
      const h = r.handle;
      h.setFeedOn(false, 'internal:test');
      const before = (h.health() as any).counters.eventsCaptured;
      for (let i = 0; i < 50; i++) {
        h.hooks.tournamentEvent(r.w.tid, 'blindLevelUp', { level: 2 + i, sb: 50, bb: 100, ante: 0 });
        h.hooks.tableBroken(r.w.tid, 'QT2');
        h.hooks.handForHandBust(r.w.tid, { playerId: 'user-104', position: 8 });
      }
      await settle(40);
      h.tick();
      expect((h.health() as any).counters.eventsCaptured).toBe(before);
      h.setFeedOn(true, 'internal:test');
      h.hooks.tournamentEvent(r.w.tid, 'blindLevelUp', { level: 2, sb: 50, bb: 100, ante: 0 });
      await settle(40);
      expect((h.health() as any).counters.eventsCaptured).toBe(before + 1);
    } finally { await r.close(); }
  });
});

// ================================================================ F10 / F12
describe('F10 — keys minted from a producer key are bound to it', () => {
  it('must start before the parent ends (no week-ahead keys); parent jti stored, audited, listed; retiring the panel key keeps its OBS keys; revoke withChildren takes them (sessions dropped); survives a restart', async () => {
    const db = fakeBroadcastDb();
    const r = await broadcastRig({ db });
    let parentJti = '';
    try {
      const { p, k: parent } = await producerClient(r, OWNER, { ...PRODUCER, ttlHours: 2 });
      if (!parent.ok) throw new Error('parent');
      parentJti = parent.jti;
      // A week ahead (the old 7-day notBefore) or at the parent's end: refused. Just before: fine.
      expect(await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'week', notBefore: Date.now() + 6.9 * 86_400_000 })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'later', notBefore: parent.exp })).toEqual({ ok: false, code: 'invalid_request' });
      expect((await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'soon', notBefore: parent.exp - 60_000 })).ok).toBe(true);
      // An OBS key for the event: its own 12 h (the panel key is short-lived and retired).
      const child = await p.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly', ttlHours: 12 });
      expect(child).toMatchObject({ ok: true });
      expect(child.exp - child.nbf).toBe(12 * 3_600_000);
      expect(r.handle.tokens.row(child.jti)!.parentJti).toBe(parent.jti);
      const issued = r.audits.filter((a) => a.action === 'BROADCAST_TOKEN_ISSUED');
      expect(issued[issued.length - 1].details).toMatchObject({ jti: child.jti, parentJti: parent.jti, via: 'producer_key' });
      expect(issued[0].details).toMatchObject({ jti: parent.jti, parentJti: null, via: 'admin' });
      expect(db.tokens.get(child.jti).parent_jti).toBe(parent.jti);
      const listed = (await p.request('bc:producer:listKeys', {})).keys;
      expect(listed.find((x: any) => x.jti === child.jti)).toMatchObject({ parentJti: parent.jti, children: 0 });
      expect(listed.find((x: any) => x.jti === parent.jti)).toMatchObject({ parentJti: null, children: 2 });
      const o = r.client('/broadcast', { auth: { key: child.token } });
      expect((await o.ready).ok).toBe(true);
      // The panel retires ITS OWN key (Close / renewal): answered ok, then its session is
      // dropped; the OBS key keeps working.
      expect(await p.request('bc:producer:revokeKey', { jti: parent.jti })).toMatchObject({ ok: true, dropped: 1 });
      expect(await p.next((x) => x.type === 2 && x.data[0] === 'bc:authExpired')).not.toBeNull();
      expect(r.handle.tokens.stillValid(parent.jti)).toEqual({ ok: false, code: 'revoked' });
      expect(r.handle.tokens.stillValid(child.jti)).toEqual({ ok: true });
      await settle(40);
      expect(o.disconnected()).toBe(false);
    } finally { await r.close(); }
    // After a restart the link is known; a leak response takes the parent's keys with it.
    const r2 = await broadcastRig({ db });
    try {
      await r2.handle.loadPersisted();
      const kids = r2.handle.tokens.list().filter((x) => x.parentJti === parentJti);
      expect(kids.length).toBe(2);
      const { p: admin } = await producerClient(r2);
      expect(await admin.request('bc:producer:revokeKey', { jti: parentJti, withChildren: true })).toMatchObject({ ok: true, children: 2 });
      for (const k of kids) expect(r2.handle.tokens.stillValid(k.jti)).toEqual({ ok: false, code: 'revoked' });
      for (const k of kids) expect(db.tokens.get(k.jti).revoked_at).not.toBeNull();
    } finally { await r2.close(); }
  });

  it('revoke withChildren drops the children\'s live sessions (bc:authExpired)', async () => {
    const r = await broadcastRig();
    try {
      const { p: panel } = await producerClient(r);
      const child = await panel.request('bc:producer:mintKey', { ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly' });
      const o = r.client('/broadcast', { auth: { key: child.token } });
      expect((await o.ready).ok).toBe(true);
      const own = r.handle.tokens.row(child.jti)!.parentJti!;
      const { p: other } = await producerClient(r);
      expect(await other.request('bc:producer:revokeKey', { jti: own, withChildren: true })).toMatchObject({ ok: true, children: 1 });
      expect((await o.next((x) => x.type === 2 && x.data[0] === 'bc:authExpired'))!.data[1]).toEqual({ code: 'revoked' });
    } finally { await r.close(); }
  });
});

describe('F12 — a scoped producer key lists and revokes only the keys it covers', () => {
  it('a ch:sitgo producer key never sees or revokes the owner\'s ch:* panel key nor a weekly key; it may revoke its own channel\'s keys', async () => {
    const r = await broadcastRig();
    try {
      const { p: owner, k: ownerKey } = await producerClient(r);
      const weekly = await r.handle.mintToken({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly' } as any, OWNER);
      const sitgoOut = await r.handle.mintToken({ ev: 'ch:sitgo', scopes: ['output'], label: 'OBS sitgo' } as any, OWNER);
      const { p: helper } = await producerClient(r, { masterUserId: 'm-helper', userId: 77, username: 'helper' }, { ev: 'ch:sitgo', scopes: ['producer'], label: 'Sit & Go helper' });
      const listed = (await helper.request('bc:producer:listKeys', {})).keys.map((x: any) => x.jti);
      expect(listed).toContain((sitgoOut as any).jti);
      expect(listed).not.toContain((ownerKey as any).jti);
      expect(listed).not.toContain((weekly as any).jti);
      expect(await helper.request('bc:producer:revokeKey', { jti: (ownerKey as any).jti })).toEqual({ ok: false, code: 'wrong_event' });
      expect(await helper.request('bc:producer:revokeKey', { jti: (weekly as any).jti })).toEqual({ ok: false, code: 'wrong_event' });
      expect(r.handle.tokens.stillValid((ownerKey as any).jti)).toEqual({ ok: true });
      expect((await helper.request('bc:producer:revokeKey', { jti: (sitgoOut as any).jti })).ok).toBe(true);
      // The owner's ch:* key keeps seeing everything.
      const all = (await owner.request('bc:producer:listKeys', {})).keys.map((x: any) => x.jti);
      expect(all).toEqual(expect.arrayContaining([(ownerKey as any).jti, (weekly as any).jti, (sitgoOut as any).jti]));
    } finally { await r.close(); }
  });
});

// ================================================================ F13
describe('F13 — the panel\'s ch:* key bars its holder only from an event he is broadcasting', () => {
  it('a ch:* key not connected → false; connected and a channel shows the event → true; registered in a qualifier no channel shows → the panel may still be minted', async () => {
    const r = await broadcastRig();
    try {
      const target = { qualifierId: r.w.qualId, tournamentId: r.w.tid };
      const k = await r.handle.mintToken(PRODUCER as any, OWNER);
      expect(k.ok).toBe(true);
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(false);          // opened once, closed
      const p = r.client('/broadcast', { auth: { key: (k as any).token } });
      expect((await p.ready).ok).toBe(true);
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(true);           // panel open; weekly shows it
      expect(r.handle.staffHoldsKeyFor('m-owner', { qualifierId: 'Q-other', tournamentId: 'T-other' })).toBe(false);
      p.close();
      await settle(100);
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(false);
      // He registers for NEXT week's weekly (no channel shows it: this week's is running).
      r.w.qualifiers.set('Q-weekly-2', {
        qualifierType: 'weekly', qualifierName: 'Next Weekly', scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        startingStack: 5000, masterQualifierId: 'Q-weekly-2', status: 'registering', tournamentId: null, finishedAt: null, results: null,
        players: [{ playerId: 'user-owner', masterPlayerId: 'm-owner', localUserId: 1, playerName: 'Owner Person', phone: '', socketId: '' }],
      });
      const again = await r.handle.mintToken(PRODUCER as any, OWNER);
      expect(again.ok).toBe(true);
      // But he can never produce that event: a channel bound to it refuses him.
      const p2 = r.client('/broadcast', { auth: { key: (again as any).token } });
      expect((await p2.ready).ok).toBe(true);
      expect(await p2.request('bc:producer:setEvent', { channel: 'sitgo', event: 'q:Q-weekly-2' })).toEqual({ ok: false, code: 'producer_is_entrant' });
    } finally { await r.close(); }
  });
});

// ================================================================ F14
describe('F14 — broadcast admin actions: the login\'s claim AND the master\'s answer now', () => {
  function optOutHarness(o: { claim?: boolean; recheck?: boolean | null }) {
    const audits: any[] = [];
    const out: Array<[string, any]> = [];
    const h = createBroadcastOptOutHandlers({
      store: createBroadcastOptOutStore({ load: async () => [{ id: 102, masterUserId: 'm-102', optOut: true }], schedule: () => {}, log: () => {} }),
      authOf: () => ({ userId: 9, username: 'admin', masterUserId: 'm-admin', ...(o.claim !== undefined ? { isAdminClaim: o.claim } : {}) }),
      mergeUserStats: async () => {},
      isUserAdmin: async () => true,
      auditLog: (actor, action, details) => audits.push({ actor, action, details }),
      limiter: createWindowRateLimiter(10, 60_000),
      log: () => {},
      ...(o.recheck !== undefined ? { recheckAdmin: async () => o.recheck as boolean | null } : {}),
    });
    const sock = { id: 'SA', emit: (ev: string, d: any) => { out.push([ev, d]); return true; } };
    return { h, sock, out, audits };
  }

  it('adminSetBroadcastOptOut: a grant-only local admin without the login\'s claim → not_admin; master says no → not_admin; master unknown → done', async () => {
    let x = optOutHarness({});
    await x.h.adminSet(x.sock, { userId: 102, optOut: false });
    expect(x.out).toEqual([['adminBroadcastOptOutResult', { ok: false, code: 'not_admin' }]]);
    expect(x.audits).toEqual([]);
    x = optOutHarness({ claim: true, recheck: false });
    await x.h.adminSet(x.sock, { userId: 102, optOut: false });
    expect(x.out).toEqual([['adminBroadcastOptOutResult', { ok: false, code: 'not_admin' }]]);
    x = optOutHarness({ claim: true, recheck: null });
    await x.h.adminSet(x.sock, { userId: 102, optOut: false });
    expect(x.out.pop()![1]).toMatchObject({ ok: true, userId: 102, optOut: false });
  });

  it('broadcastIssueToken: master says no → not_admin; unknown → issued (the claim stands)', async () => {
    const r = await broadcastRig();
    try {
      const mk = (recheck: boolean | null) => createBroadcastIssueHandler({
        authOf: () => ({ userId: 1, username: 'owner', masterUserId: 'm-owner', isAdminClaim: true }),
        isUserAdmin: async () => true,
        mint: (req, who) => r.handle.mintToken(req, who),
        limiter: createWindowRateLimiter(50, 60_000),
        log: () => {},
        recheckAdmin: async () => recheck,
      });
      const ask = async (recheck: boolean | null) => {
        let acked: any = null;
        await mk(recheck).issue({ id: 's1', emit: () => true }, PRODUCER, (x: unknown) => { acked = x; });
        return acked;
      };
      expect(await ask(false)).toEqual({ ok: false, code: 'not_admin' });
      expect((await ask(null)).ok).toBe(true);
      expect((await ask(true)).ok).toBe(true);
    } finally { await r.close(); }
  });
});

// ================================================================ F11
describe('F11 — handles joined with "." or "_" go on air as First L.', () => {
  it('john.smith / Mary_Jones / josh.hall2 → First L.; aliases with no surname part, initials and hyphens stay', () => {
    expect(broadcastNameOf('john.smith', false)).toBe('john S.');
    expect(broadcastNameOf('Mary_Jones', false)).toBe('Mary J.');
    expect(broadcastNameOf('josh.hall2', false)).toBe('josh H.');
    expect(broadcastNameOf('j.smith', false)).toBe('j. S.');            // fix round 4: a 1-letter first segment is an initial
    expect(broadcastNameOf('john.smith jr', false)).toBe('john J.');
    expect(broadcastNameOf('AcesUp_77', false)).toBe('Aces U.');        // fix round 4: two joined words + digits
    expect(broadcastNameOf('A.J.', false)).toBe('A.J.');
    expect(broadcastNameOf('A.J. Smith', false)).toBe('A.J. S.');
    expect(broadcastNameOf('Jean-Luc', false)).toBe('Jean-Luc');
    expect(broadcastNameOf('John Smith', false)).toBe('John S.');
    expect(broadcastNameOf('Zed', false)).toBe('Zed');
  });
});

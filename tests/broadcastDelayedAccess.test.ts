/**
 * 2026-11-02 (.online tournament broadcast, P5-S5 / S4-delayed; owner 2026-11-02) —
 * WHO GETS THE DELAYED HOLE-CARD FEED, AND WHEN, end to end on a REAL in-process
 * socket.io server with REAL PokerTables (the index.ts hooks wired: handStarted,
 * handResult, tableChanged) and a controllable clock:
 *  - built dark: with the default policy ('off') every door is shut (mint, switch,
 *    pin, setFeed delayed, subscribe) and nothing is recorded;
 *  - with the policy on: only an allowlisted issuer mints a delayed key or turns
 *    the producer switch on; the switch starts off; REST can only turn it OFF;
 *  - a delayed session is parked until 5 minutes are recorded, then gets the
 *    stream as it was 5 minutes ago (feed delayed, programNow = now - 5 min), by
 *    direct emit (it sits in no room); a hand's cards only once that hand ended
 *    live — a hand longer than the delay shows backs, then faces at its live end
 *    exactly;
 *  - an anonymous viewer, a producer and an output key never get any of it;
 *  - one live session per key, at most 4 per event;
 *  - revoke, expiry, the kill switch (producer or REST), an issuer turned entrant:
 *    bc:authExpired, dropped, nothing more at the next tick, the buffer wiped;
 *  - a draw / stud table refuses to arm; a frame never carries a seed / deck / id;
 *  - delayedPin, setFeed delayed (a longer delay), the event's end, an idle disarm;
 *  - index.ts: the handStarted hook, the durable audit action.
 */
import fs from 'fs';
import path from 'path';
import { SRC } from './helpers/indexSource';
import { broadcastRig, fakeRes } from './helpers/broadcastRig';
import { DELAY, OWNER, delayedRig, payloads, settle, type DelayedRig } from './helpers/delayedRig';
import { deepScanBroadcast } from './helpers/broadcastWorld';
import { checkFrameMsg, checkSnapshot } from './helpers/broadcastContractShape';

// Real sockets + many simulated minutes of hands: well past jest's 5 s default under a full-suite load.
jest.setTimeout(60_000);

const OTHER_ADMIN = { masterUserId: 'm-other', userId: 7, username: 'other' };
const SHOW = new Set(['Showdown', 'HandComplete']);

/** Faces a public frame may carry: a contested showdown's tabled hands. */
const publicFaces = (f: any) => SHOW.has(f.phase) && !!f.handResult && f.handResult.showdownSeats.length >= 2;

/** Turn the switch on (owner's producer key). */
async function switchOn(d: DelayedRig) {
  const p = await d.producer();
  const r = await p.request('bc:producer:holeCardsSwitch', { on: true });
  expect(r).toMatchObject({ ok: true, on: true, policy: 'delayed' });
  return p;
}

/** Play one hand at a table: `actions` steps of `everyMs` each (passive: check / call), until it ends. */
async function playHand(d: DelayedRig, tableId: string, everyMs: number, kind: 'passive' | 'fold' = 'passive') {
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

describe('P5 built dark — the default policy (off) shuts every door', () => {
  it('mint delayed → holecards_off; switch / pin / setFeed delayed → holecards_off (under 5 min: delay_below_minimum); REST kill switch 403 without the token, ON refused; nothing recorded', async () => {
    const r = await broadcastRig();
    try {
      const h = r.handle;
      expect(await h.mintToken({ ev: `q:${r.w.qualId}`, scopes: ['delayed', 'output'], label: 'x' }, OWNER)).toEqual({ ok: false, code: 'holecards_off' });
      const k = await h.mintToken({ ev: 'ch:*', scopes: ['producer'], label: 'p' }, OWNER);
      const p = r.client('/broadcast', { auth: { key: (k as any).token } });
      expect((await p.ready).ok).toBe(true);
      expect(await p.request('bc:producer:holeCardsSwitch', { on: true })).toMatchObject({ ok: false, code: 'holecards_off', policy: 'off' });
      expect(await p.request('bc:producer:delayedPin', { tableId: 'QT1' })).toMatchObject({ ok: false, code: 'holecards_off' });
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'delayed', delayMin: 5 })).toMatchObject({ ok: false, code: 'holecards_off' });
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'delayed', delayMin: 4 })).toMatchObject({ ok: false, code: 'delay_below_minimum', minDelayMin: 5 });
      expect((await p.request('bc:producer:hello', {})).delayed).toMatchObject({ policy: 'off', on: false, delayMin: 5, minDelayMin: 5 });
      let res = fakeRes();
      r.routes['POST /api/broadcast/holecards']({ headers: {}, body: { on: 0 } }, res);
      expect(res.statusCode).toBe(403);
      res = fakeRes();
      r.routes['POST /api/broadcast/holecards']({ headers: { 'x-internal-token': 'secret-token' }, body: { on: 1 } }, res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'issuer_not_allowlisted', on: false, policy: 'off' });
      res = fakeRes();
      r.routes['POST /api/broadcast/holecards']({ headers: { 'x-internal-token': 'secret-token' }, body: { on: 0 } }, res);
      expect(res.body).toMatchObject({ success: true, on: false, previous: false, dropped: 0 });
      // The hooks see no armed event: a deal records nothing.
      const t = r.w.tables.get('QT1')!;
      t.on('handStarted', () => h.hooks.handStarted('QT1', t));
      expect(t.startNewHand()).toBe(true);
      const health = h.health() as any;
      expect(health).toMatchObject({ policy: 'off', delayMin: 5, delayedSessions: 0, handsBuffered: 0, approxBytes: 0, releaseStalls: 0, droppedAtCap: 0 });
      expect(health.delayedFeed).toMatchObject({ switchOn: false, armedEvents: 0, handsCaptured: 0, issuers: 0 });
    } finally { await r.close(); }
  });
});

describe('P5 issuers — the allowlist (BROADCAST_HOLECARD_ISSUERS) is the only way in', () => {
  it('a delayed key: q: / t: only, the allowlisted issuer only; the switch: on only by an allowlisted issuer\'s key (audited, durable), off by any producer', async () => {
    const d = await delayedRig();
    try {
      const { r } = d;
      expect(await d.delayedKey(OTHER_ADMIN)).toEqual({ ok: false, code: 'issuer_not_allowlisted' });
      expect(await d.mint({ ev: 'ch:weekly', scopes: ['delayed'], label: 'x' })).toEqual({ ok: false, code: 'invalid_request' });
      const k = await d.delayedKey();
      expect(k).toMatchObject({ ok: true, scopes: ['delayed', 'output'] });
      // A key from before the switch is on: refused (the client then drops the key and goes public).
      const early = await d.delayedClient(k.token);
      expect(early.ack).toEqual({ ok: false, code: 'holecards_off' });
      const other = await d.producer(OTHER_ADMIN);
      expect(await other.request('bc:producer:holeCardsSwitch', { on: true })).toMatchObject({ ok: false, code: 'issuer_not_allowlisted' });
      // The panel's own delayed key (KeyManager): the producer key's issuer must be allowlisted too.
      expect(await other.request('bc:producer:mintKey', { ev: `q:${r.w.qualId}`, scopes: ['delayed', 'output'], label: 'x' })).toMatchObject({ ok: false, code: 'issuer_not_allowlisted' });
      const p = await switchOn(d);
      expect((await p.request('bc:producer:mintKey', { ev: `q:${r.w.qualId}`, scopes: ['delayed', 'output'], label: 'OBS delayed' })).ok).toBe(true);
      expect((await p.request('bc:producer:hello', {})).delayed).toMatchObject({ policy: 'delayed', on: true });
      expect(await other.request('bc:producer:holeCardsSwitch', { on: false })).toMatchObject({ ok: true, on: false });
      const sets = r.audits.filter((a) => a.action === 'BROADCAST_HOLECARDS_SET');
      expect(sets.map((a) => [a.details.on, a.details.via])).toEqual([[true, 'producer'], [false, 'producer']]);
      expect(sets[0].actor).toBe('user:1');
      expect(JSON.stringify(r.audits)).not.toContain(k.token);
    } finally { await d.close(); }
  });
});

describe('P5 a delayed session — 5 minutes behind, faces only once a hand ended live', () => {
  it('parked → snapshot at +5 min (feed delayed); every frame is >= 5 min old; a long hand shows backs until it ends live, then faces at that instant; heartbeat programNow = now - 5 min; in no room', async () => {
    const d = await delayedRig();
    try {
      const { r } = d;
      const h = r.handle;
      await switchOn(d);
      const k = await d.delayedKey();
      const T0 = d.clock();
      const { c, ack, log } = await d.delayedClient(k.token);
      expect(ack).toEqual({ ok: false, code: 'event_not_found', parked: true });
      // A public viewer and an output key watch the same event, live.
      const pub = r.client('/broadcast');
      await pub.ready;
      const pubLog = d.watch(pub);
      expect((await pub.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9' })).ok).toBe(true);
      await d.step(1000);
      expect((h.health() as any).delayedFeed).toMatchObject({ switchOn: true, armedEvents: 1, parked: 1 });
      // The delayed socket sits in no broadcast room (direct emit only).
      const nsp = r.io.of('/broadcast');
      const dsock = [...nsp.sockets.values()].find((s) => (s.data as any).bc?.scopes.includes('delayed'))!;
      expect([...dsock.rooms].filter((x) => x !== dsock.id)).toEqual([]);

      // Hand 1 at the featured table (QT1): folded round in seconds.
      const h1 = await playHand(d, 'QT1', 1000, 'fold');
      // Hand 2 at QT1: LONGER than the delay (a passive action every 40 s, about 10 minutes).
      await d.step(30_000);
      const t1 = r.w.tables.get('QT1')!;
      for (const s of t1.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = 5000; s.eliminated = false; }
      expect(t1.startNewHand()).toBe(true);
      const h2 = t1.handNumber;
      const h2Start = d.clock();
      h.hooks.tableChanged('QT1');
      await d.step(1000);
      let snapAt: number | null = null;
      while (t1.isHandInProgress()) {
        if (snapAt === null && payloads(log, 'bc:snapshot').length > 0) snapAt = payloads(log, 'bc:snapshot')[0].at;
        // While hand 2 is live: nothing of hand 2 face up, ever.
        for (const f of payloads(log, 'bc:frame').filter((x) => x.d.kind === 'table' && x.d.table.handNumber === h2)) {
          expect({ faces: f.d.table.seats.some((s: any) => s.holeCards), rel: f.d.table.holeCardsReleasedAt, ended: f.d.table.liveHandEndedAt }).toEqual({ faces: false, rel: null, ended: null });
        }
        d.act('QT1');
        if (t1.isHandInProgress()) await d.step(40_000);
      }
      const E2 = d.ended.get(`QT1#${h2}`)!;
      expect(E2 - h2Start).toBeGreaterThan(DELAY);
      // The release tick AT the live end: the frame on screen (hand 2, 5 minutes ago) comes again face up.
      const before = log.length;
      h.releaseTick();
      await settle(30);
      await d.step(0);
      const after = payloads(log.slice(before), 'bc:frame').filter((x) => x.d.kind === 'table' && x.d.table.handNumber === h2);
      expect(after.length).toBeGreaterThan(0);
      expect(after[0].d.table).toMatchObject({ featured: true, liveHandEndedAt: E2, holeCardsReleasedAt: E2 });
      expect(after[0].d.table.seats.filter((s: any) => s.holeCards).length).toBe(4);
      expect(after[0].d.table.t).toBeLessThanOrEqual(E2 - DELAY);
      // Play on past hand 2's delay; then check the whole delayed log.
      await playHand(d, 'QT1', 2000, 'fold');
      for (let i = 0; i < 8; i++) await d.step(60_000);
      h.heartbeat();
      await settle(30);
      await d.step(0);

      // The snapshot: 5 minutes after the event was armed.
      expect(snapAt).not.toBeNull();
      const snap = payloads(log, 'bc:snapshot')[0];
      expect(snap.at).toBeGreaterThanOrEqual(T0 + DELAY);
      expect(snap.d.feed).toEqual({ mode: 'delayed', delayMs: DELAY, holeCards: true, policy: 'delayed' });
      expect(snap.d.program.programNow).toBeLessThanOrEqual(snap.at - DELAY);
      expect(checkSnapshot(snap.d)).toEqual([]);
      // Every frame: at most "now - 5 min"; one seq per session, no gap after the snapshot.
      const frames = payloads(log, 'bc:frame');
      expect(frames.length).toBeGreaterThan(20);
      for (const f of frames) {
        expect({ at: f.d.at, ok: f.d.at <= f.at - DELAY }).toEqual({ at: f.d.at, ok: true });
        expect(checkFrameMsg(f.d)).toEqual([]);
      }
      const seqs = [snap.d.seq, ...frames.filter((f) => f.at >= snap.at).map((f) => f.d.seq)];
      expect(seqs).toEqual(seqs.map((_, i) => snap.d.seq + i));
      // Faces: only ever with the hand ended live before the release and its delay passed.
      let faceFrames = 0;
      for (const f of frames.filter((x) => x.d.kind === 'table')) {
        const tb = f.d.table;
        if (!tb.seats.some((s: any) => s.holeCards) || publicFaces(tb)) continue;
        faceFrames++;
        const end = d.ended.get(`${tb.tableId}#${tb.handNumber}`);
        expect(end).toBeDefined();
        expect(tb.liveHandEndedAt).toBe(end);
        expect(tb.holeCardsReleasedAt).toBeGreaterThanOrEqual(Math.max(end!, tb.t + DELAY));
        expect(tb.holeCardsReleasedAt).toBeLessThanOrEqual(f.at);
        expect(tb.featured).toBe(true);
      }
      expect(faceFrames).toBeGreaterThan(1);
      // Hand 1 (folded round, ended long before its delay): faces as soon as its frames were 5 minutes old.
      expect(frames.some((f) => f.d.kind === 'table' && f.d.table.handNumber === h1 && f.d.table.seats.some((s: any) => s.holeCards))).toBe(true);
      // The heartbeat runs 5 minutes behind.
      const hb = payloads(log, 'bc:heartbeat').pop()!.d;
      expect(hb).toMatchObject({ delayMs: DELAY, onAir: false });
      expect(hb.serverNow - hb.programNow).toBe(DELAY);
      // The public viewer got the live feed only: no delayed field, faces only at a contested showdown.
      expect(deepScanBroadcast(pubLog.map((x) => x.p.data))).toEqual([]);
      expect(JSON.stringify(pubLog.map((x) => x.p.data))).not.toMatch(/holeCardsReleasedAt|"mode":"delayed"/);
      // A frame never carries a seed, the deck or an id.
      expect(JSON.stringify(log.map((x) => x.p.data))).not.toMatch(/"(seed|deck|burn|burnCards|playerId|masterUserId|userId|publicId|playerName|showdownHands|communityCards|yourCards)"/);
      expect((h.health() as any)).toMatchObject({ delayedSessions: 1, outputs: 1 });
      expect((h.health() as any).delayedFeed.facesReleased).toBeGreaterThan(0);
      expect((h.health() as any).releaseStalls).toBeGreaterThan(0);
      expect(h.onAirView().onAir).toBe(true);   // a delayed OUTPUT source counts for the deploy freeze
      c.close();
    } finally { await d.close(); }
  });
});

describe('P5 sessions — one per key, four per event; who never gets the delayed feed', () => {
  it('a second page on the same key replaces the first (bc:sessionReplaced); the 5th session of an event → too_many_sessions; a producer / output / anonymous session never gets a delayed frame', async () => {
    const d = await delayedRig();
    try {
      const { r } = d;
      const p = await switchOn(d);
      const k1 = await d.delayedKey();
      const a = await d.delayedClient(k1.token);
      expect(a.ack).toMatchObject({ ok: false, parked: true });
      const b = await d.delayedClient(k1.token);
      expect(b.ack).toMatchObject({ ok: false, parked: true });
      expect(await a.c.next((x) => x.type === 2 && x.data[0] === 'bc:sessionReplaced')).not.toBeNull();
      await settle(60);
      expect(a.c.disconnected()).toBe(true);
      const more = [];
      for (let i = 0; i < 3; i++) more.push(await d.delayedClient((await d.delayedKey(OWNER, { label: `k${i}` })).token));
      expect(more.every((x) => x.ack.parked === true)).toBe(true);
      const fifth = await d.delayedClient((await d.delayedKey(OWNER, { label: 'k5' })).token);
      expect(fifth.ack).toEqual({ ok: false, code: 'too_many_sessions' });
      // Others: an output key (no delayed scope), the producer, an anonymous page.
      const out = await d.mint({ ev: `q:${r.w.qualId}`, scopes: ['output'], label: 'OBS' });
      const o = r.client('/broadcast', { auth: { key: out.token } });
      await o.ready;
      const oLog = d.watch(o);
      expect((await o.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9', role: 'output' })).ok).toBe(true);
      const anon = r.client('/broadcast');
      await anon.ready;
      const aLog = d.watch(anon);
      expect((await anon.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '9x16' })).ok).toBe(true);
      const pLog = d.watch(p);
      expect((await p.request('bc:producer:watch', { channel: 'weekly' })).ok).toBe(true);
      await d.step(1000);
      await playHand(d, 'QT1', 1000, 'fold');
      for (let i = 0; i < 7; i++) { await playHand(d, 'QT1', 10_000); await playHand(d, 'QT2', 10_000, 'fold'); }
      expect(payloads(b.log, 'bc:snapshot').length).toBe(1);
      for (const lg of [oLog, aLog, pLog]) {
        const json = JSON.stringify(lg.map((x) => x.p.data));
        expect(json).not.toMatch(/holeCardsReleasedAt|"mode":"delayed"/);
        expect(deepScanBroadcast(lg.map((x) => x.p.data))).toEqual([]);
      }
      // The producer's state shows the channel's feed setting, never a card.
      expect(payloads(pLog, 'bc:producer:state').pop()!.d.program.feed).toEqual({ mode: 'public', delayMs: 0, holeCards: false, policy: 'delayed' });
      expect((r.handle.health() as any).delayedSessions).toBe(4);
    } finally { await d.close(); }
  });
});

describe('P5 drops — revoke, expiry, the kill switch, an entrant: dropped at once, nothing more, the buffer wiped', () => {
  async function armedWithSession(d: DelayedRig, extra: Record<string, unknown> = {}) {
    const p = await switchOn(d);
    const k = await d.delayedKey(OWNER, extra);
    const s = await d.delayedClient(k.token);
    await d.step(1000);
    await playHand(d, 'QT1', 1000, 'fold');
    for (let i = 0; i < 6; i++) await d.step(60_000);
    expect(payloads(s.log, 'bc:snapshot').length).toBe(1);
    return { p, k, ...s };
  }
  const dropCode = async (c: any) => (await c.next((x: any) => x.type === 2 && x.data[0] === 'bc:authExpired'))?.data[1];

  it('revoked (producer revokeKey) → bc:authExpired revoked at the next tick; disconnected; the next tick sends nothing', async () => {
    const d = await delayedRig();
    try {
      const s = await armedWithSession(d);
      expect((await s.p.request('bc:producer:revokeKey', { jti: s.k.jti })).ok).toBe(true);
      await d.step(250);
      expect(await dropCode(s.c)).toEqual({ code: 'revoked' });
      await settle(40);
      expect(s.c.disconnected()).toBe(true);
      const n = s.log.length;
      await d.step(60_000);
      expect(s.log.length).toBe(n);
      expect((d.r.handle.health() as any).delayedSessions).toBe(0);
    } finally { await d.close(); }
  });

  it('expired mid-stream → expired', async () => {
    const d = await delayedRig();
    try {
      const s = await armedWithSession(d, { ttlHours: 1 });
      await d.step(3_600_000);
      expect(await dropCode(s.c)).toEqual({ code: 'expired' });
    } finally { await d.close(); }
  });

  it('the producer kill switch → holecards_off for every delayed session, the buffer wiped (0 hands, 0 cards held), purge logged', async () => {
    const d = await delayedRig();
    try {
      const s = await armedWithSession(d);
      const h = d.r.handle;
      expect(h.delayBuffer.cardsHeld()).toBeGreaterThan(0);
      expect(await s.p.request('bc:producer:holeCardsSwitch', { on: false })).toMatchObject({ ok: true, on: false, dropped: 1 });
      expect(await dropCode(s.c)).toEqual({ code: 'holecards_off' });
      expect(h.delayBuffer.stats()).toMatchObject({ armedEvents: 0, handsBuffered: 0, entries: 0 });
      expect(h.delayBuffer.cardsHeld()).toBe(0);
      expect(d.r.logs.some((l) => l.includes('holecard_delay_purged') && l.includes('switch_off'))).toBe(true);
      // Re-subscribing with the same key while the switch is off: refused.
      const again = await d.delayedClient(s.k.token);
      expect(again.ack).toEqual({ ok: false, code: 'holecards_off' });
    } finally { await d.close(); }
  });

  it('REST kill switch {on:0} (X-Internal-Token) → the same; audited BROADCAST_HOLECARDS_SET via rest', async () => {
    const d = await delayedRig();
    try {
      const s = await armedWithSession(d);
      const res = fakeRes();
      d.r.routes['POST /api/broadcast/holecards']({ headers: { 'x-internal-token': 'secret-token' }, body: { on: 0 } }, res);
      expect(res.body).toMatchObject({ success: true, on: false, previous: true, dropped: 1 });
      expect(await dropCode(s.c)).toEqual({ code: 'holecards_off' });
      expect(d.r.handle.delayBuffer.cardsHeld()).toBe(0);
      expect(d.r.audits.filter((a) => a.action === 'BROADCAST_HOLECARDS_SET').pop()).toMatchObject({ actor: 'internal:broadcast_holecards', details: { on: false, via: 'rest' } });
    } finally { await d.close(); }
  });

  it('the key\'s issuer registers in the event → entrant at the next tick', async () => {
    const d = await delayedRig();
    try {
      const s = await armedWithSession(d);
      d.r.w.qt.players.push({ playerId: 'user-owner', masterPlayerId: 'm-owner', localUserId: 1, playerName: 'Owner Person', phone: '', socketId: '' });
      await d.step(250);
      expect(await dropCode(s.c)).toEqual({ code: 'entrant' });
    } finally { await d.close(); }
  });
});

describe('P5 arming, the pin, the delay, the end', () => {
  it('a draw or stud table refuses to arm (holecards_off, nothing armed)', async () => {
    for (const variant of ['five-card-draw', 'seven-stud']) {
      const d = await delayedRig();
      try {
        await switchOn(d);
        (d.r.w.tables.get('QT2') as any).variantId = variant;
        const s = await d.delayedClient((await d.delayedKey()).token);
        expect({ variant, ack: s.ack }).toEqual({ variant, ack: { ok: false, code: 'holecards_off' } });
        expect(d.r.handle.delayBuffer.stats().armedEvents).toBe(0);
      } finally { await d.close(); }
    }
  });

  it('delayedPin: the pinned table becomes the delayed featured table (mode producer, featured frames); unknown table → not_captured; null → back', async () => {
    const d = await delayedRig();
    try {
      const p = await switchOn(d);
      const s = await d.delayedClient((await d.delayedKey()).token);
      await d.step(1000);
      await playHand(d, 'QT2', 1000, 'fold');
      for (let i = 0; i < 6; i++) await d.step(60_000);
      const snap = payloads(s.log, 'bc:snapshot')[0].d;
      expect(snap.table.tableId).toBe('QT1');
      expect(await p.request('bc:producer:delayedPin', { tableId: 'nope' })).toMatchObject({ ok: false, code: 'not_captured' });
      expect(await p.request('bc:producer:delayedPin', { tableId: 7 })).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await p.request('bc:producer:delayedPin', { tableId: 'QT2' })).toEqual({ ok: true, tableId: 'QT2', events: [`q:${d.r.w.qualId}`] });
      const n = s.log.length;
      await d.step(250);
      const got = payloads(s.log.slice(n), 'bc:frame').map((f) => f.d);
      expect(got.find((f) => f.kind === 'event')!.event).toMatchObject({ kind: 'featured', tableNo: 2 });
      expect(got.find((f) => f.kind === 'table')!.table).toMatchObject({ tableId: 'QT2', featured: true });
      await d.step(1000);
      const prog = payloads(s.log, 'bc:frame').map((f) => f.d).filter((f) => f.kind === 'program').pop()!.program;
      expect(prog.featured).toMatchObject({ tableId: 'QT2', mode: 'producer', reason: 'producer' });
      expect(await p.request('bc:producer:delayedPin', { tableId: null })).toEqual({ ok: true, tableId: null, events: [`q:${d.r.w.qualId}`] });
      await d.step(250);
      expect(payloads(s.log, 'bc:frame').map((f) => f.d).filter((f) => f.kind === 'table').pop()!.table.tableId).toBe('QT1');
      expect(d.r.audits.filter((a) => a.details?.action === 'delayedPin').length).toBe(2);
    } finally { await d.close(); }
  });

  it('setFeed delayed 10 on the channel showing the event: the session re-snapshots 10 minutes behind (parked until 10 minutes are recorded); 3 → delay_below_minimum', async () => {
    const d = await delayedRig();
    try {
      const p = await switchOn(d);
      const s = await d.delayedClient((await d.delayedKey()).token);
      await d.step(1000);
      for (let i = 0; i < 6; i++) await d.step(60_000);
      expect(payloads(s.log, 'bc:snapshot').length).toBe(1);
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'delayed', delayMin: 3 })).toMatchObject({ ok: false, code: 'delay_below_minimum' });
      expect(await p.request('bc:producer:setFeed', { channel: 'weekly', mode: 'delayed', delayMin: 10 })).toEqual({ ok: true, channel: 'weekly', mode: 'delayed', delayMs: 600_000 });
      await d.step(250);
      expect(payloads(s.log, 'bc:snapshot').length).toBe(1);   // parked: not 10 minutes recorded yet
      for (let i = 0; i < 5; i++) await d.step(60_000);
      const snaps = payloads(s.log, 'bc:snapshot');
      expect(snaps.length).toBe(2);
      expect(snaps[1].d.feed).toMatchObject({ mode: 'delayed', delayMs: 600_000 });
      expect(snaps[1].d.program.programNow).toBeLessThanOrEqual(snaps[1].at - 600_000);
      d.r.handle.heartbeat();
      await settle(30);
      await d.step(0);
      expect(payloads(s.log, 'bc:heartbeat').pop()!.d.delayMs).toBe(600_000);
      expect((d.r.handle.delayed.delayMsFor(`q:${d.r.w.qualId}`))).toBe(600_000);
    } finally { await d.close(); }
  });

  it('the event ends: sessions replay to the end, then at end + delay + 5 min they are dropped and the buffer purged (event_end); a session that left is disarmed after the same window (idle)', async () => {
    const d = await delayedRig();
    try {
      await switchOn(d);
      const s = await d.delayedClient((await d.delayedKey()).token);
      await d.step(1000);
      for (let i = 0; i < 6; i++) await d.step(60_000);
      d.r.w.qt.status = 'finished';
      d.r.w.qt.finishedAt = d.clock();
      await d.step(9 * 60_000);
      expect(s.c.disconnected()).toBe(false);
      await d.step(60_000 + 1000);
      expect((await s.c.next((x) => x.type === 2 && x.data[0] === 'bc:authExpired'))!.data[1]).toEqual({ code: 'expired' });
      expect(d.r.logs.some((l) => l.includes('holecard_delay_purged') && l.includes('event_end'))).toBe(true);
      expect(d.r.handle.delayBuffer.stats().armedEvents).toBe(0);
    } finally { await d.close(); }
    const e = await delayedRig();
    try {
      await switchOn(e);
      const s = await e.delayedClient((await e.delayedKey()).token);
      await e.step(1000);
      s.c.close();
      await settle(60);
      await e.step(5 * 60_000);
      expect(e.r.handle.delayBuffer.stats().armedEvents).toBe(1);
      await e.step(5 * 60_000 + 1000);
      expect(e.r.handle.delayBuffer.stats().armedEvents).toBe(0);
      expect(e.r.logs.some((l) => l.includes('holecard_delay_purged') && l.includes('idle'))).toBe(true);
    } finally { await e.close(); }
  });

  it('the hooks never throw into the game: a broken table view / a null table on an armed event is counted, not thrown', async () => {
    const d = await delayedRig();
    try {
      await switchOn(d);
      await d.delayedClient((await d.delayedKey()).token);
      await d.step(1000);
      const h = d.r.handle;
      const before = (h.health() as any).counters.hookErrors;
      const broken = { handNumber: 1, variantId: 'holdem', get seats(): any { throw new Error('boom'); } };
      expect(() => h.hooks.handStarted('QT1', broken as any)).not.toThrow();
      expect(() => h.hooks.handResult('QT1', null as any, [])).not.toThrow();
      expect(() => h.hooks.tableChanged('QT1')).not.toThrow();
      expect((h.health() as any).counters.hookErrors).toBeGreaterThan(before);
    } finally { await d.close(); }
  });
});

describe('P5 fixture — showdown-delayed.json (the page\'s delayed HoleCam, recorded from the real server)', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'broadcast', 'showdown-delayed.json');
  const MARK = 'FIXTURE-ONLY-bc-7f3a';
  /** The delayed rule on a recorded fixture: faces only with the hand over and the delay passed, never ahead of the replay clock. */
  function delayedProblems(fx: any): string[] {
    const out = [...checkSnapshot(fx.snapshot), ...fx.frames.flatMap((f: any, i: number) => checkFrameMsg(f.msg, i))];
    const delay = fx.snapshot.feed.delayMs;
    if (!(fx.snapshot.feed.mode === 'delayed' && delay >= DELAY && fx.snapshot.feed.holeCards === true)) out.push('feed');
    const tables = [{ t: fx.snapshot.table, now: fx.snapshot.serverNow }, ...fx.frames.filter((f: any) => f.msg.kind === 'table').map((f: any) => ({ t: f.msg.table, now: fx.snapshot.serverNow + f.afterMs }))];
    for (const { t, now } of tables) {
      if (!t || !t.seats.some((s: any) => s.holeCards) || publicFaces(t)) continue;
      const rel = t.holeCardsReleasedAt;
      if (!(typeof rel === 'number' && rel >= t.liveHandEndedAt && rel >= t.t + delay && rel <= now && t.featured === true)) out.push(`faces outside the delayed rule (hand ${t.handNumber}, t ${t.t})`);
    }
    const json = JSON.stringify(fx);
    if (/"(seed|deck|burn|playerId|masterUserId|userId|publicId|playerName|showdownHands)"/.test(json)) out.push('forbidden key');
    for (const n of ['John Smith', 'Mary Ann Lee', 'Kim Park', 'Opt Out Guy']) if (json.includes(n)) out.push(`raw name ${n}`);
    return out;
  }

  it('a hand longer than the delay: the snapshot shows it 5 minutes back with BACKS (still live); at its live end the same frame face up; then its next frames face up', async () => {
    const d = await delayedRig();
    try {
      const { r } = d;
      const h = r.handle;
      await switchOn(d);
      const base = d.clock();
      const s = await d.delayedClient((await d.delayedKey()).token);
      await d.step(1000);
      const t1 = r.w.tables.get('QT1')!;
      expect(t1.startNewHand()).toBe(true);
      h.hooks.tableChanged('QT1');
      await d.step(25_000);
      let snapshot: any = null;
      let from = 0;
      for (let g = 0; g < 60 && t1.isHandInProgress(); g++) {
        if (d.clock() - base > DELAY + 30_000 && !snapshot && t1.currentPhase === 'River') {
          // One action before the end: the page (re)connects now — its snapshot.
          s.c.emit('bc:resync', {});
          await settle(40);
          await d.step(0);
          snapshot = payloads(s.log, 'bc:snapshot').pop()!;
          from = s.log.length;
          d.adv(1000);
        }
        d.act('QT1');
        if (t1.isHandInProgress()) await d.step(snapshot ? 1000 : 25_000);
      }
      expect(snapshot).not.toBeNull();
      h.releaseTick();
      await settle(30);
      for (let i = 0; i < 12; i++) await d.step(5000);
      const frames = s.log.slice(from).filter((x) => x.p.type === 2 && x.p.data[0] === 'bc:frame').map((x) => {
        const { v: _v, seq: _s, at: _a, ...msg } = x.p.data[1];
        return { afterMs: x.at - snapshot.d.serverNow, msg };
      });
      const fx = {
        name: 'showdown-delayed',
        note: `${MARK}: Delayed feed (5 min, policy delayed, hole cards on), recorded by poker-server tests/broadcastDelayedAccess.test.ts: the snapshot shows a hand that is STILL LIVE (card backs, liveHandEndedAt null); it ends live 1 s later and that frame comes again face up (holeCardsReleasedAt = its live end); its later frames are face up.`,
        base,
        snapshot: snapshot.d,
        frames,
      };
      expect(fx.snapshot.table.seats.every((x: any) => x.holeCards === null)).toBe(true);
      expect(fx.snapshot.table).toMatchObject({ liveHandEndedAt: null, holeCardsReleasedAt: null });
      const end = d.ended.get(`QT1#${t1.handNumber}`)!;
      expect(end).toBeGreaterThan(snapshot.d.serverNow);
      const firstFaces = fx.frames.find((f: any) => f.msg.kind === 'table' && f.msg.table.seats.some((x: any) => x.holeCards))!;
      expect(firstFaces.msg.table).toMatchObject({ handNumber: t1.handNumber, liveHandEndedAt: end, holeCardsReleasedAt: end });
      expect(firstFaces.afterMs).toBe(end - snapshot.d.serverNow);
      // Before it: that hand's frames only with backs.
      for (const f of fx.frames.slice(0, fx.frames.indexOf(firstFaces))) if (f.msg.kind === 'table') expect(f.msg.table.seats.every((x: any) => x.holeCards === null)).toBe(true);
      expect(fx.frames.filter((f: any) => f.msg.kind === 'table' && f.msg.table.seats.some((x: any) => x.holeCards)).length).toBeGreaterThan(1);
      expect(delayedProblems(fx)).toEqual([]);
      if (process.env.BROADCAST_FIXTURES === 'write') fs.writeFileSync(FIXTURE, `${JSON.stringify(fx, null, 2)}\n`);
      // The committed file: present, valid under the delayed rule, the same field set as a fresh recording.
      expect(fs.existsSync(FIXTURE)).toBe(true);
      const committed = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
      expect(delayedProblems(committed)).toEqual([]);
      expect(committed.note.startsWith(MARK)).toBe(true);
      const keys = (o: any) => Object.keys(o || {}).sort();
      expect(keys(committed.snapshot)).toEqual(keys(fx.snapshot));
      expect(keys(committed.snapshot.program)).toEqual(keys(fx.snapshot.program));
      const strip = (o: any) => keys(o).filter((k) => k !== 'lastAction' && k !== 'pots');
      expect(strip(committed.snapshot.table)).toEqual(strip(fx.snapshot.table));
    } finally { await d.close(); }
  });
});

describe('P5 index.ts wiring', () => {
  it('the handStarted hook sits in ensureTableProgressListener inside try/catch; BROADCAST_HOLECARDS_SET is a durable audit action', () => {
    const at = SRC.indexOf('function ensureTableProgressListener(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, SRC.indexOf("table.on('handResult'", at));
    expect(body).toContain("table.on('handStarted', () => {\n    try { broadcastFeed?.hooks.handStarted(tableId, table); } catch (_) { /* never into the deal */ }\n  });");
    const durable = SRC.slice(SRC.indexOf('const DURABLE_AUDIT_ACTIONS'), SRC.indexOf(']);', SRC.indexOf('const DURABLE_AUDIT_ACTIONS')));
    expect(durable).toContain("'BROADCAST_HOLECARDS_SET'");
  });
});

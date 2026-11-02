/**
 * 2026-11-02 (.online tournament broadcast, P5; HARD RULE: a hole-card leak on any
 * public path is a P0) — 50 SEEDED HANDS on REAL PokerTables with the delayed
 * hole-card feed ARMED and RELEASING (policy delayed, the producer switch on, a
 * delayed session subscribed and getting faces), while every other kind of
 * /broadcast session watches the same event live:
 *   - a keyless viewer on the channel (follow the featured table, 16:9),
 *   - a keyless viewer on the event key with no table (9:16),
 *   - a keyless viewer pinned to the OTHER table,
 *   - an OUTPUT key on the channel,
 *   - the PRODUCER (bc:producer:state, a delayed pin, a lower third).
 * EVERY payload any of them received is deep-scanned: a card object only in a
 * table frame's board or, at a CONTESTED showdown, a tabled seat (the public
 * rule); no id / seed / deck / name key; never a delayed field (feed mode
 * delayed, holeCardsReleasedAt); every PROGRAM payload carries no card at all;
 * the public REST answers likewise; no log or audit line carries a card. The
 * delayed session really did get faces (the scan is not vacuous).
 */
import { DELAY, delayedRig, payloads, settle, type DelayedRig } from './helpers/delayedRig';
import { deepScanBroadcast, deepScanPublic } from './helpers/broadcastWorld';
import { fakeRes } from './helpers/broadcastRig';

const SHOW = new Set(['Showdown', 'HandComplete']);

describe('P5 — 50 hands with the delayed feed armed: no hole card on any public path', () => {
  let d: DelayedRig;
  afterAll(async () => { await d?.close(); });

  it('every public / output / producer payload scans clean; every program payload has no card at all; the delayed session got faces', async () => {
    d = await delayedRig();
    const { r } = d;
    const h = r.handle;
    const w = r.w;
    // The producer: switch on, watch the channel.
    const producerKey = await h.mintToken({ ev: 'ch:*', scopes: ['producer'], label: 'Producer panel' }, { masterUserId: 'm-owner', userId: 1, username: 'owner' });
    const prod = r.client('/broadcast', { auth: { key: (producerKey as any).token } });
    expect((await prod.ready).ok).toBe(true);
    const prodLog = d.watch(prod);
    expect(await prod.request('bc:producer:holeCardsSwitch', { on: true })).toMatchObject({ ok: true, on: true });
    expect((await prod.request('bc:producer:watch', { channel: 'weekly' })).ok).toBe(true);
    // The delayed session (the only one entitled to faces).
    const dk = await d.delayedKey();
    const delayed = await d.delayedClient(dk.token);
    expect(delayed.ack).toMatchObject({ ok: false, parked: true });
    // Every other kind of session.
    const subs: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [
      ['channel', { v: 1, channel: 'weekly', layout: '16x9' }, undefined],
      ['event-none', { v: 1, event: `q:${w.qualId}`, layout: '9x16', follow: 'none' }, undefined],
      ['event-QT2', { v: 1, event: `q:${w.qualId}`, layout: '16x9', follow: { tableId: 'QT2' } }, undefined],
    ];
    const outKey = await d.mint({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly' });
    subs.push(['output', { v: 1, channel: 'weekly', layout: '16x9', role: 'output' }, { key: outKey.token }]);
    const logs: Array<{ name: string; log: ReturnType<DelayedRig['watch']> }> = [];
    for (const [name, sub, auth] of subs) {
      const c = r.client('/broadcast', auth ? { auth } : {});
      expect((await c.ready).ok).toBe(true);
      const log = d.watch(c);
      const ack = await c.request('bc:subscribe', sub);
      expect({ name, ok: ack.ok }).toEqual({ name, ok: true });
      log.push({ at: d.clock(), p: { type: 3, nsp: '/broadcast', id: 0, data: [ack] } });   // the ack's snapshot is scanned too
      logs.push({ name, log });
    }
    await d.step(1000);

    // ---------------------------------------------------------------- 50 seeded hands
    let seed = 20261102;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    let hands = 0;
    let showdowns = 0;
    for (let n = 0; n < 50; n++) {
      const id = n % 3 === 2 ? 'QT2' : 'QT1';
      const t = w.tables.get(id)!;
      for (const s of t.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = 5000; s.eliminated = false; }
      if (!t.startNewHand()) continue;
      hands++;
      h.hooks.tableChanged(id);
      await d.step(1000 + Math.floor(rnd() * 4000));
      for (let g = 0; g < 60 && t.isHandInProgress(); g++) {
        const x = rnd();
        d.act(id, x < 0.15 ? 'fold' : x < 0.27 ? 'allin' : 'passive');
        await d.step(2000 + Math.floor(rnd() * 9000));
      }
      if (t.wentToShowdown) showdowns++;
      if (n === 20) {
        expect((await prod.request('bc:producer:delayedPin', { tableId: 'QT2' })).ok).toBe(true);
        expect((await prod.request('bc:producer:lowerThird', { channel: 'weekly', op: 'show', item: { id: 'cards', kind: 'info', title: 'Hole cards on the delayed feed' } })).ok).toBe(true);
      }
      if (n === 35) expect((await prod.request('bc:producer:delayedPin', { tableId: null })).ok).toBe(true);
    }
    expect(hands).toBe(50);
    expect(showdowns).toBeGreaterThan(5);
    // Let the delayed feed catch up past the last hand.
    for (let i = 0; i < 7; i++) await d.step(60_000);
    h.heartbeat();
    await settle(30);
    await d.step(0);

    // ---------------------------------------------------------------- the scan
    const forbidden = [...w.players.flatMap((p) => [p.playerId, p.masterId]), 'John Smith', 'Mary Ann Lee', 'Opt Out Guy', '720-555-1234', 'm-owner'];
    const all = [...logs, { name: 'producer', log: prodLog }];
    let publicTableFrames = 0;
    let publicShowdownFaces = 0;
    for (const { name, log } of all) {
      const data = log.map((x) => x.p.data);
      expect({ name, problems: deepScanBroadcast(data, forbidden) }).toEqual({ name, problems: [] });
      const json = JSON.stringify(data);
      expect({ name, delayedField: /holeCardsReleasedAt|"mode":"delayed"/.test(json) }).toEqual({ name, delayedField: false });
      // Programs: no card object of any kind (no hole card, no board).
      const programs = [
        ...payloads(log, 'bc:frame').filter((f) => f.d.kind === 'program').map((f) => f.d.program),
        ...payloads(log, 'bc:snapshot').map((f) => f.d.program),
        ...data.filter((x: any) => Array.isArray(x) && x[0]?.snapshot).map((x: any) => x[0].snapshot.program),
        ...payloads(log, 'bc:producer:state').map((f) => f.d.program?.program).filter(Boolean),
      ];
      for (const p of programs) expect({ name, problems: deepScanPublic(p, forbidden) }).toEqual({ name, problems: [] });
      for (const hb of payloads(log, 'bc:heartbeat')) expect({ name, delayMs: hb.d.delayMs }).toEqual({ name, delayMs: 0 });
      for (const f of payloads(log, 'bc:frame').filter((x) => x.d.kind === 'table')) {
        publicTableFrames++;
        const tb = f.d.table;
        if (tb.seats.some((s: any) => s.holeCards)) {
          // A CONTESTED showdown: >= 2 hands reached it (tabled, or tabled-and-mucked: a loser who need not show).
          expect({ name, phase: SHOW.has(tb.phase), contested: (tb.handResult?.showdownSeats.length ?? 0) + (tb.handResult?.muckedSeats.length ?? 0) >= 2 }).toEqual({ name, phase: true, contested: true });
          publicShowdownFaces++;
        }
      }
    }
    expect(publicTableFrames).toBeGreaterThan(100);
    expect(publicShowdownFaces).toBeGreaterThan(0);                  // the scan saw real cards where they are public
    // The public REST answers.
    for (const route of ['GET /api/broadcast/events', 'GET /api/broadcast/on-air']) {
      const res = fakeRes();
      r.routes[route]({ params: {} }, res);
      expect({ route, problems: deepScanPublic(res.body, forbidden) }).toEqual({ route, problems: [] });
    }
    // No log line or audit carries a card (or the delayed key).
    const text = r.logs.join('\n') + JSON.stringify(r.audits);
    expect(text).not.toMatch(/"rank"|"suit"/);
    expect(text).not.toContain(dk.token);

    // ---------------------------------------------------------------- not vacuous: the delayed session got faces
    const dFrames = payloads(delayed.log, 'bc:frame').filter((f) => f.d.kind === 'table');
    const withFaces = dFrames.filter((f) => f.d.table.holeCardsReleasedAt !== null && f.d.table.seats.some((s: any) => s.holeCards));
    expect(withFaces.length).toBeGreaterThan(10);
    for (const f of withFaces) {
      const tb = f.d.table;
      const end = d.ended.get(`${tb.tableId}#${tb.handNumber}`)!;
      expect(tb.liveHandEndedAt).toBe(end);
      expect(tb.holeCardsReleasedAt).toBeGreaterThanOrEqual(Math.max(end, tb.t + DELAY));
      expect(tb.holeCardsReleasedAt).toBeLessThanOrEqual(f.at);
    }
    expect(dFrames.some((f) => f.d.table.tableId === 'QT2' && f.d.table.featured === true)).toBe(true);   // the pin
    const health = h.health() as any;
    expect(health.counters).toMatchObject({ hookErrors: 0, buildErrors: 0, frameErrors: 0 });
    expect(health.delayedFeed.releaseErrors).toBe(0);
  }, 120_000);
});

/**
 * 2026-11-02 (.online tournament broadcast, P2-S7a) — END TO END on a REAL
 * in-process socket.io server, the REAL TournamentManager and REAL PokerTables:
 * a weekly qualifier of 3 tables from its early rooms down to the final table
 * and the finish — public sessions (one per scene, plus a witness from start to
 * finish), a producer session (on air, a lower third, a featured lock), the
 * featured table switching, a table break, hand-for-hand busts (deferred, told at
 * the settle with their final place), a contested showdown, and the results.
 *
 * It RECORDS the stream each scene's source receives as the page's fixtures,
 * tests/fixtures/broadcast/{starting,midgame,break,hfh,finalTable,showdown-public,
 * results}.json — {name, note, base, snapshot, frames:[{afterMs, msg}]}, the
 * format of poker-3d src/broadcast/dev/fixtureIo.js (CLA copies them into
 * src/broadcast/dev/fixtures/; spec §2 hand-off).
 *
 * The files are written only with BROADCAST_FIXTURES=write (pids are random per
 * process and times move, so a plain `npm test` would dirty the working tree on
 * every run and trip ship.sh's clean-tree check). Every run checks that each
 * committed fixture exists and passes the page's contract shape check, and that
 * a freshly recorded one has the same field set (contract drift fails here).
 *
 * Checked on everything any public / producer session received: the page's v1
 * shape, no forbidden key (ids, seeds, raw names), no card outside a board or a
 * contested showdown, names First L. / 'Player' (opt-out), one seq per stream
 * with no gap, the results.
 */
import fs from 'fs';
import path from 'path';
import { broadcastRig, settle, type Rig } from './helpers/broadcastRig';
import { deepScanBroadcast } from './helpers/broadcastWorld';
import { checkSnapshot, checkFrameMsg, forbiddenKeyPaths } from './helpers/broadcastContractShape';
import type { RawClient } from './helpers/rawSocketClient';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'broadcast');
const FIXTURE_NAMES = ['starting', 'midgame', 'break', 'hfh', 'finalTable', 'showdown-public', 'results'] as const;
const WRITE = process.env.BROADCAST_FIXTURES === 'write';
const MARK = 'FIXTURE-ONLY-bc-7f3a';
const NAMES = ['John Smith', 'Mary Ann Lee', 'Zed', 'Kim Park', 'Opt Out Guy', 'Ann Bell', 'Bo Diaz', 'Cy Endo', 'Di Fox', 'Ed Gray', 'Fay Hill', 'Gus Ives'];
const SUB = { v: 1, channel: 'weekly', layout: '16x9' };
/** The established entry wording (2026-11-02) the How-to-enter lower third carries; the old line must never come back. */
const ENTER_SUB = 'Top 5 in any game gets you in · Free to play at americanpubpoker.online';
const STALE_ENTER_SUB = 'Play free at americanpubpoker.online';

interface Fixture { name: string; note: string; base: number; snapshot: any; frames: Array<{ afterMs: number; msg: any }> }

/** The scene source's recording: its snapshot + every bc:frame after it (seq-checked). */
function fixtureOf(name: string, note: string, base: number, c: RawClient, snapshot: any): Fixture {
  const frames = c.events('bc:frame');
  frames.forEach((f: any, i: number) => expect({ name, i, seq: f.seq }).toEqual({ name, i, seq: snapshot.seq + i + 1 }));
  let last = 0;
  return {
    name,
    note: `${MARK}: ${note} Recorded by poker-server tests/broadcastE2E.test.ts (real engine, /broadcast namespace).`,
    base,
    snapshot,
    frames: frames.map((f: any) => {
      const afterMs = Math.max(last, f.at - snapshot.serverNow, 0);
      last = afterMs;
      const { v: _v, seq: _seq, at: _at, ...msg } = f;
      return { afterMs, msg };
    }),
  };
}

/** The page's own checks on a fixture (shape, forbidden keys) + the server's frame-aware deep scan. */
function fixtureProblems(fx: Fixture, forbidden: string[]): string[] {
  return [
    ...checkSnapshot(fx.snapshot),
    ...fx.frames.flatMap((f, i) => checkFrameMsg(f.msg, i)),
    ...forbiddenKeyPaths(fx),
    ...deepScanBroadcast({ snapshot: fx.snapshot, frames: fx.frames }, forbidden),
  ];
}

describe('P2-S7a — a qualifier end to end on /broadcast (recorded as the page fixtures)', () => {
  let r: Rig;
  const deferred = new Set<string>();
  const recorded: Record<string, Fixture> = {};
  let T = 0;
  let base = 0;

  beforeAll(async () => {
    // The world's seat package is {1: 3, 2: 2, 3: 1}: the top 3 win championship seats.
    r = await broadcastRig({ tables: 3, names: NAMES, deferred });
  });
  afterAll(async () => { await r.close(); });

  it('plays the event and records every scene', async () => {
    const w = r.w;
    const h = r.handle;
    T = Date.now();
    base = T;
    r.clock.t = T;
    const adv = (ms: number) => { T += ms; r.clock.t = T; };
    const tour = w.tm.getTournament(w.tid)!;
    // The index.ts hooks, on the real engine and tables.
    w.tm.onEvent(w.tid, (e, d) => h.hooks.tournamentEvent(w.tid, e, d));
    for (const [id, t] of w.tables) t.on('handResult', (d: any) => h.hooks.handResult(id, t, d.results));
    const changed = (id: string) => h.hooks.tableChanged(id);
    const frames = async (ms = 250) => { adv(ms); h.flushTables(); await settle(25); };
    const second = async () => { adv(1000); h.tick(); h.flushTables(); h.heartbeat(); await settle(25); };
    const clockNow = (over: Record<string, unknown> = {}) => {
      const c = w.tm.getLevelClock(w.tid)!;
      return {
        level: c.level, levels: c.levels, sb: c.sb, bb: c.bb, ante: c.ante, next: c.next, levelEndsAt: c.levelEndsAt, serverNow: T,
        paused: c.paused, pauseReason: c.pauseReason, breakUntil: c.breakUntil, dealsAt: null, playersLeft: c.alive, entries: c.entries,
        avgStack: c.alive > 0 ? Math.round((c.entries * 5000) / c.alive) : null, paidPlaces: 3,
        levelDurationMs: c.durationSec * 1000, levelRemainingMs: c.paused ? c.remainingMs : null, resumesAt: c.breakUntil, ...over,
      };
    };
    const alive = () => w.tm.getTournament(w.tid)!.players.filter((p) => !p.eliminated).map((p) => p.playerId);
    const tableOfPlayer = (pid: string) => [...w.tables.entries()].find(([, t]) => t.seats.some((s) => s.playerId === pid && s.state === 'occupied' && !s.eliminated))?.[0];
    const playHand = async (id: string, script: 'call' | 'allin' | 'fold', followed: boolean) => {
      const t = w.tables.get(id)!;
      if (!t.startNewHand()) return false;
      changed(id); await frames();
      if (script === 'allin') { t.playerAllIn(t.activeSeatIndex); changed(id); await frames(); }
      for (let g = 0; g < 40 && t.isHandInProgress(); g++) {
        const a = t.activeSeatIndex;
        if (script === 'fold') t.playerFold(a);
        else if (!t.playerCheck(a)) t.playerCall(a);
        changed(id);
        if (followed) await frames(); else adv(100);
      }
      changed(id);
      await frames();
      return true;
    };
    w.qt.scheduledAt = new Date(T - 20 * 60_000).toISOString();

    // The witness: one public source from the early rooms to the results.
    const witness = r.client('/broadcast');
    expect((await witness.ready).ok).toBe(true);
    // The producer (a ch:* key minted for the owner, who plays nothing).
    const key = await h.mintToken({ ev: 'ch:*', scopes: ['producer'], label: 'Producer panel', ttlHours: 12 }, { masterUserId: 'm-owner', userId: 1, username: 'owner' });
    if (!key.ok) throw new Error(key.code);
    const producer = r.client('/broadcast', { auth: { key: key.token } });
    expect((await producer.ready).ok).toBe(true);

    // ---------------------------------------------------------------- 1. starting (the early rooms: tables open, dealing at T+10 min)
    tour.paused = true;
    tour.pauseReason = 'prestart';
    w.clock.value = clockNow({ dealsAt: T + 10 * 60_000 });
    const sStart = r.client('/broadcast');
    await sStart.ready;
    const startSnap = (await sStart.request('bc:subscribe', SUB)).snapshot;
    const witnessAck = await witness.request('bc:subscribe', SUB);
    expect(witnessAck.ok).toBe(true);
    expect(startSnap.program).toMatchObject({ channel: 'weekly', eventKey: `q:${w.qualId}`, event: { status: 'tables_open' }, scene: { id: 'starting', auto: true } });
    expect(await producer.request('bc:producer:watch', { channel: 'weekly' })).toEqual({ ok: true, channel: 'weekly' });
    expect((await producer.request('bc:producer:onAir', { channel: 'weekly', onAir: true, rehearsal: false })).ok).toBe(true);
    expect((await producer.request('bc:producer:lowerThird', { channel: 'weekly', op: 'show', item: { id: 'enter', kind: 'info', title: 'How to enter', sub: ENTER_SUB, until: null } })).ok).toBe(true);
    await second();
    // The deal: play starts.
    tour.paused = false;
    tour.pauseReason = null;
    w.clock.value = clockNow();
    adv(10 * 60_000);
    await second();
    recorded.starting = fixtureOf('starting', 'Tables open, dealing in 10 minutes; the producer goes on air and shows How to enter; then the deal.', base, sStart, startSnap);
    expect(recorded.starting.frames.map((f) => f.msg.program?.scene?.id).filter(Boolean).pop()).toBe('table');
    sStart.close();

    // ---------------------------------------------------------------- 2. midgame (hands at every table, a level up, a featured lock)
    const sMid = r.client('/broadcast');
    await sMid.ready;
    const midSnap = (await sMid.request('bc:subscribe', SUB)).snapshot;
    expect(midSnap.program.event.status).toBe('running');
    const featured0 = midSnap.table.tableId as string;
    for (const id of w.tableIds) if (id !== featured0) { await playHand(id, 'fold', false); }
    await playHand(featured0, 'call', true);
    tour.currentBlindLevel = 1;
    w.clock.value = clockNow();
    h.hooks.tournamentEvent(w.tid, 'blindLevelUp', { level: 2, sb: 50, bb: 100, ante: 0 });
    await settle(25);
    await second();
    const locked = w.tableIds.find((x) => x !== featured0)!;
    expect(await producer.request('bc:producer:feature', { channel: 'weekly', tableId: locked, lockMinutes: 5 })).toMatchObject({ ok: true, mode: 'producer' });
    await frames();
    await second();
    await playHand(locked, 'call', true);
    expect((await producer.request('bc:producer:feature', { channel: 'weekly', tableId: null })).ok).toBe(true);
    await second();
    const midFrames = sMid.events('bc:frame');
    expect(midFrames.some((f: any) => f.kind === 'event' && f.event.kind === 'featured')).toBe(true);
    expect(midFrames.some((f: any) => f.kind === 'event' && f.event.kind === 'levelUp')).toBe(true);
    expect(midFrames.filter((f: any) => f.kind === 'table').map((f: any) => f.table.tableId)).toContain(locked);
    recorded.midgame = fixtureOf('midgame', 'Three tables in play: a hand at the featured table, a level up, the producer locks another table for 5 minutes, then back to auto.', base, sMid, midSnap);
    sMid.close();

    // ---------------------------------------------------------------- 3. break (5 minutes; 9 minutes left in the level)
    tour.paused = true;
    tour.pauseReason = 'break';
    tour.breakUntil = T + 5 * 60_000;
    tour.levelRemainingMs = 9 * 60_000;
    tour.advanceOnResume = false;
    w.clock.value = clockNow();
    h.hooks.tournamentEvent(w.tid, 'tournamentBreak', { afterLevel: 2, resumesAt: tour.breakUntil });
    await settle(25);
    await second();
    const sBreak = r.client('/broadcast');
    await sBreak.ready;
    const breakSnap = (await sBreak.request('bc:subscribe', SUB)).snapshot;
    expect(breakSnap.program.scene.id).toBe('break');
    expect(breakSnap.program.clock).toMatchObject({ paused: true, pauseReason: 'break', levelRemainingMs: 540_000 });
    expect((await producer.request('bc:producer:lowerThird', { channel: 'weekly', op: 'show', item: { id: 'back', kind: 'host', title: 'Back in 5 minutes', until: T + 5 * 60_000 } })).ok).toBe(true);
    await second();
    adv(5 * 60_000);
    tour.paused = false;
    tour.pauseReason = null;
    tour.breakUntil = null;
    tour.levelEndsAt = T + 9 * 60_000;
    w.clock.value = clockNow();
    h.hooks.tournamentEvent(w.tid, 'tournamentBreakEnded', { level: 2 });
    await settle(25);
    await second();
    recorded.break = fixtureOf('break', 'A 5-minute break with 9 minutes left in level 2; a Back in 5 minutes lower third; then play resumes.', base, sBreak, breakSnap);
    expect(recorded.break.frames.some((f) => f.msg.kind === 'event' && f.msg.event.kind === 'breakEnd')).toBe(true);
    sBreak.close();

    // ---------------------------------------------------------------- busts down to 6, a table break
    // Tables: QT1 = John, Kim, Bo, Ed; QT2 = Mary, Opt Out Guy, Cy, Fay; QT3 = Zed, Ann, Di, Gus.
    const id = (name: string) => w.players.find((p) => p.name === name)!.playerId;
    for (const name of ['Ann Bell', 'Di Fox', 'Gus Ives', 'Cy Endo', 'Fay Hill', 'Ed Gray']) {
      const tid = tableOfPlayer(id(name))!;
      w.bust(id(name), id('Kim Park'));
      changed(tid);
      await settle(15);
      await frames(400);
    }
    await second();
    expect(alive()).toHaveLength(6);
    // QT3 (Zed alone) breaks: he moves to QT2's empty seat, the table leaves the event.
    const zedSeat = w.tables.get('QT3')!.seats.find((s) => s.playerId === id('Zed'))!;
    const qt1 = w.tables.get('QT1')!;
    const qt2 = w.tables.get('QT2')!;
    const free = qt2.seats.find((s) => s.state === 'empty')!.seatIndex;
    qt2.sitDown(free, 'Zed', zedSeat.chipCount, id('Zed'), false);
    w.tm.setPlayerTable(w.tid, id('Zed'), 'QT2');
    w.tm.removeTable(w.tid, 'QT3');
    h.hooks.tableBroken(w.tid, 'QT3');
    changed('QT2');
    await settle(25);
    await frames();
    await second();
    const witnessEvents = () => witness.events('bc:frame').filter((f: any) => f.kind === 'event').map((f: any) => f.event);
    expect(witnessEvents().filter((e: any) => e.kind === 'tableBroken').map((e: any) => e.tableNo)).toEqual([3]);

    // ---------------------------------------------------------------- 4. hand-for-hand (the seat bubble: 4 left, 3 win seats)
    w.bust(id('Bo Diaz'), id('John Smith'));
    changed('QT1');
    await settle(15);
    w.bust(id('Opt Out Guy'), id('Mary Ann Lee'));
    changed('QT2');
    await settle(15);
    expect(alive()).toHaveLength(4);
    w.hfh.set(w.tid, { round: { no: 2, base: new Map([['QT1', qt1.handNumber], ['QT2', w.tables.get('QT2')!.handNumber]]), attempted: new Set(['QT1', 'QT2']) } });
    w.clock.value = clockNow({ handForHand: true, handForHandRound: 2 });
    await second();
    const sHfh = r.client('/broadcast');
    await sHfh.ready;
    const hfhSnap = (await sHfh.request('bc:subscribe', SUB)).snapshot;
    expect(hfhSnap.program.scene.id).toBe('hfh');
    expect(hfhSnap.program.handForHand).toMatchObject({ on: true, round: 2 });
    expect(hfhSnap.program.event.prizes).toMatchObject({ bubblePlace: 4, onBubble: true });
    // Round 2: one hand at each table (2 + 2 left); Mary busts at QT2 (deferred: told at the settle, 4th).
    await playHand('QT1', 'fold', hfhSnap.table.tableId === 'QT1');
    await playHand('QT2', 'fold', hfhSnap.table.tableId === 'QT2');
    deferred.add(id('Mary Ann Lee'));
    w.bust(id('Mary Ann Lee'), id('Kim Park'));
    changed('QT2');
    await settle(25);
    expect(witnessEvents().filter((e: any) => e.kind === 'bust' && e.place === 4)).toEqual([]);
    h.hooks.handForHandBust(w.tid, { playerId: id('Mary Ann Lee'), position: 4, eliminatorId: id('Kim Park') });
    await settle(25);
    w.hfh.delete(w.tid);
    w.clock.value = clockNow();
    await second();
    recorded.hfh = fixtureOf('hfh', 'Hand-for-hand round 2 on the seat bubble (4 left, top 3 win seats); the bubble bursts: 4th is told at the round settle; hand-for-hand ends.', base, sHfh, hfhSnap);
    const hfhBust = recorded.hfh.frames.find((f) => f.msg.kind === 'event' && f.msg.event.kind === 'bust');
    expect(hfhBust!.msg.event).toMatchObject({ place: 4, name: 'Mary L.', byName: 'Kim P.', handForHand: true });
    expect(recorded.hfh.frames.some((f) => f.msg.kind === 'event' && f.msg.event.kind === 'hfhOff')).toBe(true);
    sHfh.close();

    // ---------------------------------------------------------------- 5. the final table (QT2 breaks; 3 left at QT1)
    for (const s of qt2.seats.filter((x) => x.state === 'occupied' && !x.eliminated && x.chipCount > 0)) {
      const seatAt = qt1.seats.find((x) => x.state === 'empty')!.seatIndex;
      qt1.sitDown(seatAt, s.playerName, s.chipCount, s.playerId, false);
      w.tm.setPlayerTable(w.tid, s.playerId, 'QT1');
    }
    w.tm.removeTable(w.tid, 'QT2');
    h.hooks.tableBroken(w.tid, 'QT2');
    changed('QT1');
    await settle(25);
    await frames();
    await second();
    expect(alive()).toHaveLength(3);
    const sFinal = r.client('/broadcast');
    await sFinal.ready;
    const finalSnap = (await sFinal.request('bc:subscribe', SUB)).snapshot;
    expect(finalSnap.program.featured).toMatchObject({ tableId: 'QT1', mode: 'final_table', reason: 'final_table' });
    expect(finalSnap.program.finalTable.seats.map((s: any) => s.name).sort()).toEqual(['John S.', 'Kim P.', 'Zed']);
    expect(finalSnap.program.ticker.map((e: any) => e.kind)).toContain('finalTable');
    await playHand('QT1', 'call', true);
    await second();
    recorded.finalTable = fixtureOf('finalTable', 'The final table (3 left, all win seats): the featured table is forced; one hand checked down.', base, sFinal, finalSnap);
    sFinal.close();

    // ---------------------------------------------------------------- 6. a contested all-in showdown (public: the tabled hands, once the pot is awarded)
    const sShow = r.client('/broadcast');
    await sShow.ready;
    const showSnap = (await sShow.request('bc:subscribe', SUB)).snapshot;
    await playHand('QT1', 'allin', true);
    await second();
    const showFrames = sShow.events('bc:frame').filter((f: any) => f.kind === 'table');
    const end = showFrames[showFrames.length - 1].table;
    expect(end.phase).toBe('HandComplete');
    expect(end.handResult.showdownSeats.length).toBeGreaterThanOrEqual(2);
    expect(end.seats.filter((s: any) => s.holeCards).map((s: any) => s.seatIndex).sort()).toEqual([...end.handResult.showdownSeats].sort());
    expect(end.liveHandEndedAt).toEqual(expect.any(Number));
    for (const f of showFrames.slice(0, -1)) {
      if (f.table.phase !== 'HandComplete' && f.table.phase !== 'Showdown') expect(f.table.seats.every((s: any) => s.holeCards === null)).toBe(true);
    }
    recorded['showdown-public'] = fixtureOf('showdown-public', 'An all-in at the final table, called: the tabled hands are shown once the pot is awarded (public feed).', base, sShow, showSnap);
    sShow.close();

    // ---------------------------------------------------------------- 7. the finish
    for (const s of qt1.seats.filter((x) => x.state === 'occupied' && !x.eliminated && x.chipCount <= 0)) { w.bust(s.playerId); await settle(15); }
    while (alive().length > 1) {
      const loser = qt1.seats.filter((x) => x.state === 'occupied' && !x.eliminated && alive().includes(x.playerId)).sort((a, b) => a.chipCount - b.chipCount)[0];
      w.bust(loser.playerId, alive().find((p) => p !== loser.playerId));
      await settle(15);
    }
    changed('QT1');
    const finals = w.tm.getTournament(w.tid)!.finalResults || [];
    expect(finals.length).toBeGreaterThan(0);
    w.qt.status = 'finished';
    w.qt.finishedAt = T;
    w.qt.results = finals.filter((f) => f.position > 0 && f.position <= 3).map((f) => {
      const reg = w.qt.players.find((p: any) => p.playerId === f.playerId) as any;
      return { masterUserId: String(reg.masterPlayerId), playerName: String(reg.playerName), place: f.position, wonSeat: true, seats: ({ 1: 3, 2: 2, 3: 1 } as Record<number, number>)[f.position] };
    });
    await settle(25);
    await second();
    const sRes = r.client('/broadcast');
    await sRes.ready;
    const resSnap = (await sRes.request('bc:subscribe', SUB)).snapshot;
    expect(resSnap.program.scene.id).toBe('results');
    expect(resSnap.program.results.map((x: any) => [x.place, x.seatsWon])).toEqual([[1, 3], [2, 2], [3, 1]]);
    expect(resSnap.program.ticker.map((e: any) => e.kind)).toContain('finished');
    expect((await producer.request('bc:producer:lowerThird', { channel: 'weekly', op: 'show', item: { id: 'congrats', kind: 'info', title: 'Congratulations to our seat winners', until: null } })).ok).toBe(true);
    await second();
    expect((await producer.request('bc:producer:onAir', { channel: 'weekly', onAir: false })).ok).toBe(true);
    await second();
    recorded.results = fixtureOf('results', 'The finish: places 1-3 win 3, 2 and 1 championship seats; a congratulations lower third; the producer goes off air.', base, sRes, resSnap);
    sRes.close();

    // ---------------------------------------------------------------- the whole run, as the witness and the producer saw it
    const forbidden = [...w.players.flatMap((p) => [p.playerId, p.masterId]), 'John Smith', 'Mary Ann Lee', 'Kim Park', 'Opt Out Guy', 'm-owner'];
    expect(deepScanBroadcast(witness.packets.map((p) => p.data), forbidden)).toEqual([]);
    expect(deepScanBroadcast(producer.packets.map((p) => p.data), forbidden)).toEqual([]);
    const wf = witness.events('bc:frame');
    expect(wf.map((f: any) => f.seq)).toEqual(wf.map((_: unknown, i: number) => witnessAck.snapshot.seq + i + 1));
    expect(witness.events('bc:snapshot')).toEqual([]);                        // never a resync needed
    const busts = witnessEvents().filter((e: any) => e.kind === 'bust');
    expect(busts.map((b: any) => b.place)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(busts.find((b: any) => b.place === 5).name).toBe('Player');          // Opt Out Guy, opted out
    expect(busts.filter((b: any) => b.seatsWon > 0).map((b: any) => [b.place, b.seatsWon])).toEqual([[3, 1], [2, 2]]);
    expect(witnessEvents().map((e: any) => e.kind)).toEqual(expect.arrayContaining(['levelUp', 'breakStart', 'breakEnd', 'tableBroken', 'hfhOn', 'hfhOff', 'finalTable', 'featured', 'finished']));
    expect(producer.events('bc:producer:state').length).toBeGreaterThan(3);
    const health = h.health() as any;
    expect(health.counters).toMatchObject({ hookErrors: 0, buildErrors: 0, frameErrors: 0 });
    expect(health.featuredSwitches.producer).toBe(1);
    expect(health.featuredSwitches.final_table + health.featuredSwitches.auto).toBeGreaterThanOrEqual(1);
    expect(r.audits.filter((a) => a.action === 'BROADCAST_PRODUCER_ACTION').map((a) => a.details.action)).toEqual(
      ['onAir', 'lowerThird', 'feature', 'feature', 'lowerThird', 'lowerThird', 'onAir']);
  }, 60_000);   // 2026-11-02 (P5) — ~3.4 s of real settles alone: past jest's 5 s default under a full-suite load

  it('each recorded scene passes the page\'s contract check, carries no forbidden key and no card outside a board or a contested showdown', () => {
    const forbidden = [...r.w.players.flatMap((p) => [p.playerId, p.masterId]), 'John Smith', 'Mary Ann Lee', 'Kim Park', 'Opt Out Guy'];
    for (const name of FIXTURE_NAMES) {
      const fx = recorded[name];
      expect({ name, recorded: !!fx }).toEqual({ name, recorded: true });
      expect({ name, problems: fixtureProblems(fx, forbidden) }).toEqual({ name, problems: [] });
      expect(fx.snapshot.program.channel).toBe('weekly');
      expect(fx.snapshot.feed).toEqual({ mode: 'public', delayMs: 0, holeCards: false, policy: 'off' });
    }
    expect(recorded['showdown-public'].frames.some((f) => f.msg.kind === 'table' && f.msg.table.seats.some((s: any) => s.holeCards))).toBe(true);
    expect(recorded.midgame.snapshot.table).not.toBeNull();
  });

  it('the fixture files: written with BROADCAST_FIXTURES=write; otherwise each committed file is valid and has the field set of a fresh recording', () => {
    if (WRITE) {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      for (const name of FIXTURE_NAMES) fs.writeFileSync(path.join(FIXTURE_DIR, `${name}.json`), `${JSON.stringify(recorded[name], null, 2)}\n`);
    }
    const keysOf = (o: any) => (o && typeof o === 'object' ? Object.keys(o).sort() : []);
    for (const name of FIXTURE_NAMES) {
      const file = path.join(FIXTURE_DIR, `${name}.json`);
      expect({ name, exists: fs.existsSync(file) }).toEqual({ name, exists: true });
      const fx: Fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect({ name, problems: fixtureProblems(fx, ['John Smith', 'Mary Ann Lee', 'Kim Park', 'Opt Out Guy']) }).toEqual({ name, problems: [] });
      expect(fx.note.startsWith(MARK)).toBe(true);
      const fresh = recorded[name];
      expect({ name, top: keysOf(fx) }).toEqual({ name, top: keysOf(fresh) });
      expect({ name, snapshot: keysOf(fx.snapshot) }).toEqual({ name, snapshot: keysOf(fresh.snapshot) });
      expect({ name, program: keysOf(fx.snapshot.program) }).toEqual({ name, program: keysOf(fresh.snapshot.program) });
      expect({ name, event: keysOf(fx.snapshot.program.event) }).toEqual({ name, event: keysOf(fresh.snapshot.program.event) });
      if (fx.snapshot.table && fresh.snapshot.table) {
        const optional = new Set(['lastAction', 'pots']);
        const strip = (o: any) => keysOf(o).filter((k) => !optional.has(k));
        expect({ name, table: strip(fx.snapshot.table) }).toEqual({ name, table: strip(fresh.snapshot.table) });
      }
    }
  });

  it('the How-to-enter lower third carries the established entry wording, in the recording and in every committed fixture; the old line is nowhere', () => {
    const enterSubs = (fx: Fixture): unknown[] => [fx.snapshot, ...fx.frames.map((f) => f.msg)]
      .flatMap((m: any) => (Array.isArray(m?.program?.lowerThirds) ? m.program.lowerThirds : []))
      .filter((lt: any) => lt?.id === 'enter')
      .map((lt: any) => lt.sub);
    for (const name of FIXTURE_NAMES) {
      const fresh = enterSubs(recorded[name]);
      expect({ name, recordedHasEnter: fresh.length > 0 }).toEqual({ name, recordedHasEnter: true });
      expect({ name, recorded: [...new Set(fresh)] }).toEqual({ name, recorded: [ENTER_SUB] });
      const text = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
      const committed = enterSubs(JSON.parse(text));
      expect({ name, committedHasEnter: committed.length > 0 }).toEqual({ name, committedHasEnter: true });
      expect({ name, committed: [...new Set(committed)] }).toEqual({ name, committed: [ENTER_SUB] });
      expect({ name, stale: text.includes(STALE_ENTER_SUB) }).toEqual({ name, stale: false });
    }
    for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
      expect({ file, stale: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8').includes(STALE_ENTER_SUB) }).toEqual({ file, stale: false });
    }
  });
});

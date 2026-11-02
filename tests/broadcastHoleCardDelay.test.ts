/**
 * 2026-11-02 (.online tournament broadcast, P5-S5; owner 2026-11-02) — THE DELAYED
 * HOLE-CARD BUFFER and its RELEASE RULE (src/broadcast/holeCardDelay.ts), pure,
 * on REAL PokerTable hands with a fake clock.
 *
 * The owner's HARD RULE: a hand's hole cards are NEVER released while that hand
 * is still being played live — only once (a) it has ended live AND (b) at least
 * the delay (5 minutes at least) has passed since the frame shown. A hand the
 * delayed feed reaches while it is still live shows card BACKS until it ends.
 * So the first face-up release of a frame of time t is exactly max(t + delay,
 * the hand's live end).
 *
 * Also: the policy knobs (off by default; 5-minute floor; allowlist empty =
 * nobody), the featured / final-table / after_event / vpip gates, a release never
 * mutates what was captured, purge + caps + wipe leave no card behind, names are
 * downgraded at release (an opt-out mid-delay shows 'Player'), Hold'em / Omaha
 * only, and the module imports nothing that persists (no redisStore, no pg).
 */
import fs from 'fs';
import path from 'path';
import { GamePhase, PokerTable } from '../src/game/PokerTable';
import { broadcastPid } from '../src/broadcast/broadcastNames';
import { toBroadcastTableFrame } from '../src/broadcast/broadcastFrame';
import {
  createHoleCardDelayBuffer, downgradeNames, faceUpDecision, holeCardConfigOf, holeCardVariantOk, releaseTableFrame, vpipSeatsOf,
  type ReleaseContext,
} from '../src/broadcast/holeCardDelay';
import { HOLECARD_MIN_DELAY_MS, type BroadcastTableFrame, type ProgramState } from '../src/broadcast/contract';
import type { ResolvedEvent } from '../src/broadcast/eventKey';

const N = 5 * 60_000;
const TID = 'T-delay-1';
const EV: ResolvedEvent = { key: 'q:Q-delay', kind: 'weekly', qualifierId: 'Q-delay', tournamentId: TID, qt: null };
const NAMES: Record<string, string> = { a: 'John Smith', b: 'Mary Ann Lee', c: 'Zed', d: 'Kim Park' };
const identityOf = (s: { playerId: string }) => ({ pid: broadcastPid(TID, s.playerId), name: s.playerId === 'c' ? 'Zed' : `${NAMES[s.playerId].split(' ')[0]} ${NAMES[s.playerId].split(' ').pop()![0]}.` });

function table4(id = 'QT1'): PokerTable {
  const t = new PokerTable({ tableId: id, tableName: 'Qualifier Table 1', smallBlind: 25, bigBlind: 50, minBuyIn: 5000, maxBuyIn: 5000, maxPlayers: 9 } as any);
  ['a', 'b', 'c', 'd'].forEach((pid, i) => t.sitDown(i, NAMES[pid], 5000, pid, false));
  return t;
}
const frameAt = (t: PokerTable, at: number): BroadcastTableFrame => toBroadcastTableFrame(t, { now: at, tableNo: 1, featured: true, identityOf });
const ctxAt = (now: number, over: Partial<ReleaseContext> = {}): ReleaseContext => ({
  now, delayMs: N, policy: 'delayed', show: 'all', tables: 'featured', featured: true, finalTable: false, eventFinished: false, ...over,
});
/** The real hole cards of each dealt seat, as {rank, suit}. */
const realCards = (t: PokerTable) => new Map(t.seats.filter((s) => s.holeCards.length > 0).map((s) => [s.seatIndex, s.holeCards.map((c) => ({ rank: c.rank, suit: c.suit }))]));
const faceSeats = (f: BroadcastTableFrame) => f.seats.filter((s) => Array.isArray(s.holeCards) && s.holeCards.length > 0).map((s) => s.seatIndex);

function armed(caps?: { handsPerTable?: number; eventBytes?: number }) {
  const logs: string[] = [];
  const buf = createHoleCardDelayBuffer({ log: (l) => logs.push(l), caps });
  buf.arm(EV);
  buf.setTables(EV.key, ['QT1', 'QT2'], TID);
  return { buf, logs };
}

describe('P5 policy knobs (env, read once) — built dark', () => {
  it('defaults: policy off, delay 5 min, featured table, all hands, NOBODY allowlisted', () => {
    expect(holeCardConfigOf({})).toEqual({ policy: 'off', defaultDelayMs: N, tables: 'featured', show: 'all', issuers: new Set() });
    expect(holeCardConfigOf(undefined).policy).toBe('off');
  });

  it('the delay never goes under 5 minutes (no env can lower it), at most 240; junk = 5; policy only delayed / after_event; issuers comma-separated', () => {
    const d = (v: string) => holeCardConfigOf({ BROADCAST_HOLECARD_DELAY_MIN: v }).defaultDelayMs / 60_000;
    expect([d('1'), d('0'), d('-3'), d('4.9'), d('5'), d('30'), d('999'), d('abc'), d('')]).toEqual([5, 5, 5, 5, 5, 30, 240, 5, 5]);
    const p = (v: string) => holeCardConfigOf({ BROADCAST_HOLECARD_POLICY: v }).policy;
    expect([p('delayed'), p('DELAYED'), p(' after_event '), p('on'), p('1'), p('any')]).toEqual(['delayed', 'delayed', 'after_event', 'off', 'off', 'off']);
    expect([...holeCardConfigOf({ BROADCAST_HOLECARD_ISSUERS: ' m-owner , ,m-2 ' }).issuers]).toEqual(['m-owner', 'm-2']);
    expect(holeCardConfigOf({ BROADCAST_HOLECARD_TABLES: 'final_table', BROADCAST_HOLECARD_SHOW: 'vpip' })).toMatchObject({ tables: 'final_table', show: 'vpip' });
    expect(holeCardConfigOf({ BROADCAST_HOLECARD_TABLES: 'any', BROADCAST_HOLECARD_SHOW: 'none' })).toMatchObject({ tables: 'featured', show: 'all' });
  });

  it("Hold'em and Omaha only (draw, stud and pineapple change hole cards mid-hand)", () => {
    expect(['holdem', 'omaha', 'omaha-hi-lo', 'omaha-5', 'omaha-6'].every(holeCardVariantOk)).toBe(true);
    expect(['five-card-draw', 'triple-draw', 'seven-stud', 'seven-card-stud-hi-lo', 'razz', 'badugi', 'pineapple', 'crazy-pineapple', 'short-deck', undefined, ''].some(holeCardVariantOk)).toBe(false);
  });
});

describe('P5 release rule — max(t + delay, the hand\'s live end), never earlier', () => {
  it('a frame is never face up before t + N; at t + N exactly (its hand long over) the dealt seats show their real cards', () => {
    const { buf } = armed();
    const t = table4();
    const t0 = 1_000_000;
    expect(t.startNewHand()).toBe(true);
    expect(buf.captureHandStart(EV.key, 'QT1', t, t0)).toBe(true);
    const f = frameAt(t, t0 + 500);
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    buf.markHandEnded(EV.key, 'QT1', t.handNumber, t0 + 2000);
    const hand = buf.hand(EV.key, 'QT1', t.handNumber);
    const early = releaseTableFrame(f, hand, ctxAt(f.t + N - 1));
    expect(early).toMatchObject({ faces: false, held: 'delay_pending' });
    expect(faceSeats(early.frame)).toEqual([]);
    expect(early.frame.holeCardsReleasedAt).toBeNull();
    const on = releaseTableFrame(f, hand, ctxAt(f.t + N));
    expect(on).toMatchObject({ faces: true, held: null });
    expect(on.frame.holeCardsReleasedAt).toBe(f.t + N);
    expect(on.frame.liveHandEndedAt).toBe(t0 + 2000);
    const real = realCards(t);
    expect(faceSeats(on.frame)).toEqual([...real.keys()]);
    for (const s of on.frame.seats) expect(s.holeCards).toEqual(real.get(s.seatIndex));
  });

  it('a hand LONGER than the delay never leaks faces before it ends live (backs, liveHandEndedAt null); faces exactly at its live end', () => {
    const { buf } = armed();
    const t = table4();
    const t0 = 5_000_000;
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, t0);
    const frames: BroadcastTableFrame[] = [];
    // The hand runs 12 minutes: a frame every 30 s, nobody folds (checks / calls).
    let clock = t0;
    while (clock < t0 + 12 * 60_000 && t.isHandInProgress() && t.currentPhase !== GamePhase.River) {
      frames.push(frameAt(t, clock));
      const a = t.activeSeatIndex;
      if (!t.playerCheck(a)) t.playerCall(a);
      clock += 30_000;
    }
    clock = Math.max(clock, t0 + 12 * 60_000);
    frames.push(frameAt(t, clock));
    expect(t.isHandInProgress()).toBe(true);
    const hand = buf.hand(EV.key, 'QT1', t.handNumber)!;
    // Every release before the live end, every 250 ms from t0 to the end: backs only.
    for (let now = t0; now < clock + 1; now += 250) {
      for (const f of frames) {
        const r = releaseTableFrame(f, hand, ctxAt(now));
        if (r.faces || faceSeats(r.frame).length > 0 || r.frame.holeCardsReleasedAt !== null || r.frame.liveHandEndedAt !== null) throw new Error(`leak at ${now - t0} ms (frame ${f.t - t0})`);
        if (now >= f.t + N) expect(r.held).toBe('hand_live');
      }
    }
    // It ends live at E (12 min in): the first frame (t0) is released face up at E exactly, not a ms before.
    const E = clock;
    while (t.isHandInProgress()) { const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a); }
    buf.markHandEnded(EV.key, 'QT1', hand.handNumber, E);
    expect(releaseTableFrame(frames[0], hand, ctxAt(E - 1))).toMatchObject({ faces: false, held: 'hand_live' });
    const r = releaseTableFrame(frames[0], hand, ctxAt(E));
    expect(r).toMatchObject({ faces: true });
    expect(r.frame).toMatchObject({ liveHandEndedAt: E, holeCardsReleasedAt: E });
    // A frame from the last minute of the hand still waits for ITS delay.
    const lateFrame = frames[frames.length - 1];
    expect(releaseTableFrame(lateFrame, hand, ctxAt(E)).held).toBe('delay_pending');
    expect(releaseTableFrame(lateFrame, hand, ctxAt(lateFrame.t + N)).faces).toBe(true);
  });

  it('release time = max(t + N, end) for ends before, at and after t + N (scanned on the 250 ms tick)', () => {
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    const t0 = 9_000_000;
    for (const endOffset of [1_000, 60_000, N - 250, N, N + 250, N + 45_000, 2 * N + 1_000]) {
      const { buf } = armed();
      buf.captureHandStart(EV.key, 'QT1', t, t0 - 1000);
      const f = frameAt(t, t0);
      const E = t0 + endOffset;
      let first: number | null = null;
      for (let now = t0; now <= t0 + 3 * N; now += 250) {
        if (now === E) buf.markHandEnded(EV.key, 'QT1', t.handNumber, E);
        const r = releaseTableFrame(f, buf.hand(EV.key, 'QT1', t.handNumber), ctxAt(now));
        if (r.faces && first === null) first = now;
        if (now < E || now < t0 + N) expect({ endOffset, now: now - t0, faces: r.faces }).toEqual({ endOffset, now: now - t0, faces: false });
      }
      expect({ endOffset, first: first! - t0 }).toEqual({ endOffset, first: Math.max(N, endOffset) });
    }
  });

  it('a release never mutates the captured frame; the buffer\'s frames carry no face', () => {
    const { buf } = armed();
    const t = table4();
    const t0 = 2_000_000;
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, t0);
    const f = frameAt(t, t0);
    buf.captureTable(EV.key, f, JSON.stringify(f), t0);
    const before = JSON.stringify(f);
    buf.markHandEnded(EV.key, 'QT1', t.handNumber, t0 + 1);
    const r = releaseTableFrame(f, buf.hand(EV.key, 'QT1', t.handNumber), ctxAt(t0 + N));
    expect(r.faces).toBe(true);
    r.frame.seats[0].holeCards!.push({ rank: 2, suit: 0 });
    expect(JSON.stringify(f)).toBe(before);
    expect(buf.latestTable(EV.key, 'QT1', t0 + N)!.frame.seats.every((s) => s.holeCards === null)).toBe(true);
    expect(f).not.toHaveProperty('holeCardsReleasedAt');
  });

  it('gates: not the featured table, policy off, after_event while running, the final-table setting, a delay under the floor, another hand\'s record, a seat whose occupant changed, between hands', () => {
    const { buf } = armed();
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, 0);
    const f = frameAt(t, 10);
    buf.markHandEnded(EV.key, 'QT1', t.handNumber, 20);
    const h = buf.hand(EV.key, 'QT1', t.handNumber);
    const at = 10 + 3 * N;
    expect(faceUpDecision(f, h, ctxAt(at))).toBeNull();
    expect(faceUpDecision(f, h, ctxAt(at, { featured: false }))).toBe('not_featured');
    expect(faceUpDecision(f, h, ctxAt(at, { policy: 'off' }))).toBe('policy');
    expect(faceUpDecision(f, h, ctxAt(at, { policy: 'after_event' }))).toBe('policy');
    expect(faceUpDecision(f, h, ctxAt(at, { policy: 'after_event', eventFinished: true }))).toBeNull();
    expect(faceUpDecision(f, h, ctxAt(at, { tables: 'final_table' }))).toBe('not_featured');
    expect(faceUpDecision(f, h, ctxAt(at, { tables: 'final_table', finalTable: true }))).toBeNull();
    expect(faceUpDecision(f, h, ctxAt(at, { delayMs: HOLECARD_MIN_DELAY_MS - 1 }))).toBe('delay_pending');
    expect(faceUpDecision(f, h, ctxAt(at, { delayMs: 0 }))).toBe('delay_pending');
    expect(faceUpDecision({ ...f, handNumber: f.handNumber + 1 }, h, ctxAt(at))).toBe('no_record');
    expect(faceUpDecision(f, undefined, ctxAt(at))).toBe('no_record');
    expect(faceUpDecision({ ...f, phase: 'WaitingForPlayers' }, h, ctxAt(at))).toBe('not_in_hand');
    // A seat whose pid is not the one dealt in: nothing for that seat.
    const swapped = { ...f, seats: f.seats.map((s, i) => (i === 0 ? { ...s, pid: 'b-0000000000000000' } : s)) };
    const r = releaseTableFrame(swapped, h, ctxAt(at));
    expect(r.faces).toBe(true);
    expect(r.frame.seats[0].holeCards).toBeNull();
    expect(r.frame.seats.slice(1).every((s) => Array.isArray(s.holeCards))).toBe(true);
  });

  it("SHOW 'vpip': a seat that never put chips in voluntarily keeps backs; a caller / raiser shows (and 'all' shows every dealt hand)", () => {
    const { buf } = armed();
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, 0);
    const f0 = frameAt(t, 1);
    const folder = t.activeSeatIndex;
    expect(t.playerFold(folder)).toBe(true);
    const caller = t.activeSeatIndex;
    expect(t.playerCall(caller)).toBe(true);
    for (let g = 0; g < 30 && t.isHandInProgress(); g++) { const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a); }
    expect(vpipSeatsOf(t.actionLog).has(folder)).toBe(false);
    expect(vpipSeatsOf(t.actionLog).has(caller)).toBe(true);
    expect([...vpipSeatsOf([{ seatIndex: 1, action: 'posted BB 50' }, { seatIndex: 2, action: 'posted ante 5' }, { seatIndex: 3, action: 'checked' }])]).toEqual([]);
    buf.markHandEnded(EV.key, 'QT1', t.handNumber, 5, t.actionLog);
    const h = buf.hand(EV.key, 'QT1', t.handNumber);
    const vp = releaseTableFrame(f0, h, ctxAt(1 + N, { show: 'vpip' })).frame;
    expect(vp.seats.find((s) => s.seatIndex === folder)!.holeCards).toBeNull();
    expect(vp.seats.find((s) => s.seatIndex === caller)!.holeCards).toEqual(realCards(t).get(caller));
    const all = releaseTableFrame(f0, h, ctxAt(1 + N, { show: 'all' })).frame;
    expect(faceSeats(all)).toEqual([...realCards(t).keys()]);
  });
});

describe('P5 buffer — capture, purge, caps, wipe (nothing outlives its window)', () => {
  it("captureHandStart: Hold'em / Omaha only; one record per hand (seat pid + clones); an unarmed event captures nothing", () => {
    const { buf } = armed();
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    expect(buf.captureHandStart('q:not-armed', 'QT1', t, 0)).toBe(false);
    expect(buf.captureHandStart(EV.key, 'QT1', { ...t, seats: t.seats, handNumber: t.handNumber, variantId: 'five-card-draw' }, 0)).toBe(false);
    expect(buf.captureHandStart(EV.key, 'QT1', { seats: t.seats, handNumber: t.handNumber, variantId: 'seven-stud' }, 0)).toBe(false);
    expect(buf.captureHandStart(EV.key, 'QT1', { seats: t.seats, handNumber: t.handNumber }, 0)).toBe(false);   // unknown variant: refused
    expect(buf.stats()).toMatchObject({ variantRefused: 3, handsCaptured: 0 });
    expect(buf.captureHandStart(EV.key, 'QT1', t, 0)).toBe(true);
    const h = buf.hand(EV.key, 'QT1', t.handNumber)!;
    expect([...h.seats.values()].map((s) => s.pid)).toEqual(['a', 'b', 'c', 'd'].map((p) => broadcastPid(TID, p)));
    // Clones: the engine's arrays are not held.
    t.seats[0].holeCards[0] = { rank: 2, suit: 0 } as any;
    expect(h.seats.get(0)!.cards[0]).not.toBe(t.seats[0].holeCards[0]);
    expect(buf.eventOfTable('QT1')).toBe(EV.key);
    expect(buf.eventOfTournament(TID)).toBe(EV.key);
  });

  it('purge: older than the window goes (hands by deal AND end; entries keep the state AT the cutoff: the newest older program and each table\'s newest older frame)', () => {
    const { buf } = armed();
    const t = table4();
    const p = (n: number) => ({ v: 1, programNow: n } as unknown as ProgramState);
    buf.captureProgram(EV.key, p(1), [], 'p1', 1_000);
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, 1_000);
    const f1 = frameAt(t, 2_000);
    buf.captureTable(EV.key, f1, 'f1', 2_000);
    buf.captureTable(EV.key, { ...f1, tableId: 'QT2' }, 'g1', 2_500);
    buf.markHandEnded(EV.key, 'QT1', t.handNumber, 3_000);
    buf.captureProgram(EV.key, p(2), [], 'p2', 4_000);
    buf.captureTable(EV.key, { ...f1, pot: 999 }, 'f2', 5_000);
    buf.captureEvent(EV.key, { id: 'k1', t: 5_500, kind: 'levelUp' } as any);
    buf.captureProgram(EV.key, p(3), [], 'p3', 50_000);
    const window = 10_000;
    buf.purge(5_500 + window + 1, window);
    // At the cutoff (5.5 s): program p2, QT1's f2, QT2's g1 stay; p1, f1 and the event go; the hand (dealt 1 s, ended 3 s) goes.
    const kept = buf.entriesAfter(EV.key, -1, Infinity);
    expect(kept.map((e) => (e.kind === 'program' ? `p${(e.program as any).programNow}` : e.kind === 'table' ? `${e.tableId}@${e.t}` : `ev@${e.t}`)))
      .toEqual(['QT2@2500', 'p2', 'QT1@5000', 'p3']);
    expect(buf.stats().handsBuffered).toBe(0);
    expect(buf.cardsHeld()).toBe(0);
    // A hand dealt inside the window stays.
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, 49_000);
    buf.purge(5_500 + window + 1, window);
    expect(buf.stats().handsBuffered).toBe(1);
    // A hand STILL LIVE past the window keeps its record (its cards show once it ends) …
    const live = t.handNumber;
    buf.purge(49_000 + 3 * window, window);
    expect(!!buf.hand(EV.key, 'QT1', live)).toBe(true);
    // … until a newer hand is dealt at its table (it was abandoned: it never ends) …
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, 49_000 + 3 * window);
    buf.purge(49_000 + 3 * window + 1, window);
    expect([!!buf.hand(EV.key, 'QT1', live), !!buf.hand(EV.key, 'QT1', t.handNumber)]).toEqual([false, true]);
    // … or it is an hour past the window.
    buf.purge(49_000 + 3 * window + window + 60 * 60_000 + 1, window);
    expect(buf.stats().handsBuffered).toBe(0);
  });

  it('caps drop the oldest: hands per table, then bytes (counted droppedAtCap)', () => {
    const { buf } = armed({ handsPerTable: 3, eventBytes: 6_000 });
    const t = table4();
    for (let i = 0; i < 5; i++) {
      for (const s of t.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = 5000; s.eliminated = false; }
      expect(t.startNewHand()).toBe(true);
      buf.captureHandStart(EV.key, 'QT1', t, i * 1000);
      for (let g = 0; g < 8 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    }
    const hn = t.handNumber;
    expect([hn - 4, hn - 3, hn - 2, hn - 1, hn].map((n) => !!buf.hand(EV.key, 'QT1', n))).toEqual([false, false, true, true, true]);
    expect(buf.stats().droppedAtCap).toBe(2);
    const f = frameAt(t, 1);
    for (let i = 0; i < 10; i++) buf.captureTable(EV.key, { ...f, pot: i }, 'x'.repeat(1500) + i, 10_000 + i);
    expect(buf.stats().approxBytes).toBeLessThanOrEqual(6_000);
    expect(buf.stats().droppedAtCap).toBeGreaterThan(2);
    expect(buf.entriesAfter(EV.key, -1, Infinity).map((e) => (e.kind === 'table' ? e.frame.pot : -1)).pop()).toBe(9);
  });

  it('the kill switch (wipe) leaves nothing: 0 hands, 0 entries, 0 card objects; the purge log carries counts only (no card, no pid, no player id)', () => {
    const { buf, logs } = armed();
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    buf.captureHandStart(EV.key, 'QT1', t, 0);
    buf.captureTable(EV.key, frameAt(t, 1), 'f', 1);
    expect(buf.cardsHeld()).toBeGreaterThan(0);
    buf.wipeAll('switch_off');
    expect(buf.stats()).toMatchObject({ armedEvents: 0, handsBuffered: 0, entries: 0, approxBytes: 0, purges: 1 });
    expect(buf.cardsHeld()).toBe(0);
    expect(buf.eventOfTable('QT1')).toBeUndefined();
    expect(buf.captureHandStart(EV.key, 'QT1', t, 2)).toBe(false);   // disarmed: nothing is captured any more
    const purged = logs.find((l) => l.includes('holecard_delay_purged'))!;
    expect(JSON.parse(purged.replace('[broadcast] ', ''))).toEqual({ event: 'holecard_delay_purged', eventKey: EV.key, reason: 'switch_off', hands: 1, entries: 1 });
    const all = logs.join('\n');
    for (const bad of ['"rank"', '"suit"', broadcastPid(TID, 'a'), 'John Smith', '"a"']) expect(all).not.toContain(bad);
  });
});

describe('P5 names at release — an opt-out taken during the delay shows Player (never the other way)', () => {
  it('pid/name pairs, a ticker byName (through its eliminator pid), a table winner (through its seat); the input is not touched', () => {
    const john = broadcastPid(TID, 'a');
    const kim = broadcastPid(TID, 'd');
    const program = {
      standings: { leaders: [{ pid: john, name: 'John S.', chips: 9000 }, { pid: kim, name: 'Kim P.', chips: 1000 }] },
      ticker: [{ id: 'k1', t: 1, kind: 'bust', pid: kim, name: 'Kim P.', byName: 'John S.' }],
      finalTable: { seats: [{ seatIndex: 0, pid: john, name: 'John S.', chips: 9000 }] },
      lowerThirds: [{ id: 'x', kind: 'host', title: 'John S. on the mic' }],
    };
    const out = downgradeNames(program, new Set([john]), new Map([['k1', john]]));
    expect(out.standings.leaders.map((l) => l.name)).toEqual(['Player', 'Kim P.']);
    expect(out.ticker[0]).toMatchObject({ name: 'Kim P.', byName: 'Player' });
    expect(out.finalTable.seats[0].name).toBe('Player');
    expect(out.lowerThirds[0].title).toBe('John S. on the mic');          // producer text is not an entrant name
    expect(program.standings.leaders[0].name).toBe('John S.');
    const frame = { tableId: 'QT1', seats: [{ seatIndex: 0, pid: john, name: 'John S.' }, { seatIndex: 1, pid: kim, name: 'Player' }], handResult: { winners: [{ seatIndex: 0, name: 'John S.', amount: 100 }], showdownSeats: [], muckedSeats: [] } };
    const f = downgradeNames(frame, new Set([john]), new Map());
    expect(f.seats.map((s) => s.name)).toEqual(['Player', 'Player']);
    expect(f.handResult.winners[0].name).toBe('Player');
    // Never upgraded: 'Player' stays when the pid is not opted out.
    expect(downgradeNames(frame, new Set(), new Map()).seats[1].name).toBe('Player');
  });
});

describe('P5 sources — nothing persisted, only this module reads a seat\'s hole cards', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
  const src = (f: string) => strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'broadcast', f), 'utf8'));

  it('holeCardDelay.ts and delayedFeed.ts import nothing from redisStore or pg (nor fs / net / http / child_process / Sentry)', () => {
    for (const f of ['holeCardDelay.ts', 'delayedFeed.ts']) {
      const imports = [...src(f).matchAll(/(?:import[^;]*?from\s*|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect({ f, bad: imports.filter((m) => /redis|(^|\/)pg$|^pg\b|^fs$|^net$|^http|child_process|sentry|authManager|redisStore/i.test(m)) }).toEqual({ f, bad: [] });
      expect(src(f)).not.toMatch(/getPool|\.query\(|redisStore|writeFile|appendFile|Sentry/);
    }
  });

  it('a SEAT\'s hole cards are read in holeCardDelay.ts only (the capture); wire.ts / delayedFeed.ts / producer.ts read none', () => {
    const dir = path.join(__dirname, '..', 'src', 'broadcast');
    const readers: Record<string, string[]> = {};
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const hits = [...src(f).matchAll(/(\w+)\??\.holeCards\b/g)].map((m) => m[1]);
      if (hits.length > 0) readers[f] = [...new Set(hits)].sort();
    }
    // broadcastFrame.ts: h = the engine's showdown record (public at a contested showdown).
    // holeCardDelay.ts: s = a seat at the deal (capture) / a captured PUBLIC frame's seat (release
    // copies it); out = the released copy's seat (written, for a delayed session only).
    expect(readers).toEqual({ 'broadcastFrame.ts': ['h'], 'holeCardDelay.ts': ['out', 's'] });
    // delayedFeed.ts only says its Feed flag (holeCards: true) — never a read.
    expect(src('delayedFeed.ts').match(/holeCards/g)).toEqual(['holeCards']);
    expect(src('delayedFeed.ts')).toContain('holeCards: true');
  });
});

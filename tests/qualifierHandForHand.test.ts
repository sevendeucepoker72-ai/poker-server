/**
 * 2026-10-24 (owner 2026-10-23: "Build it for Sunday") — HAND-FOR-HAND at an
 * online qualifier's SEAT BUBBLE, and the TDA companion: players busted in the
 * SAME hand-for-hand hand (at the same or different tables) are placed by their
 * chip count at the START of that hand (the bigger stack takes the better place).
 *
 * The pure parts, on the REAL modules (no index.ts slicing):
 *  - qualifierSchedule.handForHandApplies — when hand-for-hand engages;
 *  - qualifierHandForHandWatchdogMs / qualifierHandForHandOnAtBoot — the
 *    watchdog's length (rig time scale, forced 1 in production) and the boot switch;
 *  - TournamentManager.placeSimultaneousBusts — the same-hand busts re-placed
 *    among their OWN place numbers by starting stack (places stay 1..N).
 *
 * Before (5b8ad77) none of these existed: busts in the same moment at two tables
 * were placed by whichever table's bust check ran first.
 */
import {
  handForHandApplies, qualifierHandForHandWatchdogMs, qualifierHandForHandOnAtBoot, qualifierTestTimeScale,
  qualifierHandForHandOnText, QUALIFIER_HAND_FOR_HAND_TEXT, QUALIFIER_HAND_FOR_HAND_OFF_TEXT,
  QUALIFIER_HAND_FOR_HAND_WATCHDOG_MS, QUALIFIER_HAND_FOR_HAND_MIN_WATCHDOG_MS, QUALIFIER_TABLE_SEATS,
  seatsForTopWith, qualifierWindows,
  // Review fix-up — the watchdog's hard cap and stall window.
  qualifierHandForHandHardCapMs, QUALIFIER_HAND_FOR_HAND_HARD_CAP_MS, QUALIFIER_HAND_FOR_HAND_STALL_MS,
} from '../src/game/qualifierSchedule';
import { TournamentManager } from '../src/game/TournamentManager';

const SUNDAY_PACKAGE = { 1: 3, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 };

describe('HP1 — handForHandApplies: engages ONLY after the late close, with 2+ tables, at alive === seatsForTop + 1, above one table', () => {
  const late = Date.parse('2026-10-25T20:00:00.000Z');   // Sunday 2:00 PM Denver
  const base = { now: late + 1, lateRegUntil: late, alive: 11, seatsForTop: 10, tablesInPlay: 2 };

  it('the Sunday bubble: late registration closed, 2 tables, 11 alive, top 10 → true', () => {
    expect(handForHandApplies(base)).toBe(true);
    expect(handForHandApplies({ ...base, tablesInPlay: 3 })).toBe(true);
  });

  it('the late window: now === lateRegUntil (strict) or before it → false', () => {
    expect(handForHandApplies({ ...base, now: late })).toBe(false);
    expect(handForHandApplies({ ...base, now: late - 60_000 })).toBe(false);
  });

  it('one table in play → false (the final table never plays hand-for-hand)', () => {
    expect(handForHandApplies({ ...base, tablesInPlay: 1 })).toBe(false);
    expect(handForHandApplies({ ...base, tablesInPlay: 0 })).toBe(false);
  });

  it('not the bubble: alive 12 or 10 → false', () => {
    expect(handForHandApplies({ ...base, alive: 12 })).toBe(false);
    expect(handForHandApplies({ ...base, alive: 10 })).toBe(false);
  });

  it('a bad seat count: 0 / NaN / fractional → false', () => {
    expect(handForHandApplies({ ...base, seatsForTop: 0, alive: 1 })).toBe(false);
    expect(handForHandApplies({ ...base, seatsForTop: NaN })).toBe(false);
    expect(handForHandApplies({ ...base, seatsForTop: 9.5, alive: 10.5 })).toBe(false);
  });

  it('a field that fits ONE table (alive 9, top 8) → false: Rule 1 merges it', () => {
    expect(QUALIFIER_TABLE_SEATS).toBe(9);
    expect(handForHandApplies({ ...base, alive: 9, seatsForTop: 8 })).toBe(false);
    expect(handForHandApplies({ ...base, alive: 10, seatsForTop: 9 })).toBe(true);
  });

  it('no schedule (lateRegUntil NaN — the S2 / S4 worlds, a non-qualifier) → false; garbage input → false', () => {
    expect(handForHandApplies({ ...base, lateRegUntil: NaN })).toBe(false);
    expect(handForHandApplies({ ...base, lateRegUntil: qualifierWindows(new Date(undefined as any).getTime()).lateRegUntil })).toBe(false);
    expect(handForHandApplies({ ...base, now: NaN })).toBe(false);
    expect(handForHandApplies(null as any)).toBe(false);
  });

  it('the Sunday package\'s bubble is 11 (seatsForTopWith 10); the weekly default (top 3) and the monthly (top 6) never engage', () => {
    expect(seatsForTopWith('weekly', SUNDAY_PACKAGE)).toBe(10);
    expect(handForHandApplies({ ...base, seatsForTop: seatsForTopWith('weekly', SUNDAY_PACKAGE), alive: 11 })).toBe(true);
    expect(handForHandApplies({ ...base, seatsForTop: seatsForTopWith('weekly', null), alive: 4 })).toBe(false);
    expect(handForHandApplies({ ...base, seatsForTop: seatsForTopWith('monthly', null), alive: 7 })).toBe(false);
  });
});

describe('HP2 — the watchdog length and the boot switch', () => {
  it('qualifierHandForHandWatchdogMs: 4 minutes at real time, divided by the rig scale, never under 5 s; garbage → 4 minutes', () => {
    expect(QUALIFIER_HAND_FOR_HAND_WATCHDOG_MS).toBe(240_000);
    expect(QUALIFIER_HAND_FOR_HAND_MIN_WATCHDOG_MS).toBe(5_000);
    expect(qualifierHandForHandWatchdogMs()).toBe(240_000);
    expect(qualifierHandForHandWatchdogMs(1)).toBe(240_000);
    expect(qualifierHandForHandWatchdogMs(12)).toBe(20_000);
    expect(qualifierHandForHandWatchdogMs(60)).toBe(5_000);
    expect(qualifierHandForHandWatchdogMs(120)).toBe(5_000);
    for (const g of [NaN, -3, 0, 'x', null, undefined, Infinity]) expect(qualifierHandForHandWatchdogMs(g as any)).toBe(240_000);
  });

  it('production is ALWAYS 4 minutes: the rig scale is forced to 1 by NODE_ENV=production or any Railway variable', () => {
    expect(qualifierHandForHandWatchdogMs(qualifierTestTimeScale({ NODE_ENV: 'production', QUALIFIER_TEST_TIME_SCALE: '60' }))).toBe(240_000);
    expect(qualifierHandForHandWatchdogMs(qualifierTestTimeScale({ RAILWAY_ENVIRONMENT: 'production', QUALIFIER_TEST_TIME_SCALE: '60' }))).toBe(240_000);
    expect(qualifierHandForHandWatchdogMs(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '12' }))).toBe(20_000);
  });

  it('review fix-up — qualifierHandForHandHardCapMs: 10 minutes at real time (a slow but MOVING round may run past the 4-minute watchdog up to it), divided by the rig scale, never under the watchdog; garbage → 10 minutes; production always 10 minutes; the stall window is 90 s and never scaled', () => {
    expect(QUALIFIER_HAND_FOR_HAND_HARD_CAP_MS).toBe(600_000);
    expect(qualifierHandForHandHardCapMs()).toBe(600_000);
    expect(qualifierHandForHandHardCapMs(12)).toBe(50_000);
    expect(qualifierHandForHandHardCapMs(60)).toBe(10_000);
    expect(qualifierHandForHandHardCapMs(120)).toBe(5_000);   // = the watchdog's floor, never below it
    for (const s of [1, 12, 60, 120]) expect(qualifierHandForHandHardCapMs(s)).toBeGreaterThanOrEqual(qualifierHandForHandWatchdogMs(s));
    for (const g of [NaN, -3, 0, 'x', null, undefined, Infinity]) expect(qualifierHandForHandHardCapMs(g as any)).toBe(600_000);
    expect(qualifierHandForHandHardCapMs(qualifierTestTimeScale({ NODE_ENV: 'production', QUALIFIER_TEST_TIME_SCALE: '60' }))).toBe(600_000);
    expect(qualifierHandForHandHardCapMs(qualifierTestTimeScale({ RAILWAY_SERVICE_ID: 'x', QUALIFIER_TEST_TIME_SCALE: '60' }))).toBe(600_000);
    // 90 s > the longest legitimate gap between two actions (30 s clock + 15 s grace + a 15 s wedge sample).
    expect(QUALIFIER_HAND_FOR_HAND_STALL_MS).toBe(90_000);
  });

  it('qualifierHandForHandOnAtBoot: unset / "1" / anything else → ON; "0" → OFF', () => {
    expect(qualifierHandForHandOnAtBoot(undefined)).toBe(true);
    expect(qualifierHandForHandOnAtBoot('1')).toBe(true);
    expect(qualifierHandForHandOnAtBoot('x')).toBe(true);
    expect(qualifierHandForHandOnAtBoot('0')).toBe(false);
  });

  it('the player-facing texts: the engage announcement names the field and the paid places; the banner and the end text', () => {
    expect(qualifierHandForHandOnText(11, 10)).toBe('Hand-for-hand: 11 players left and the top 10 win seats. Every table now plays one hand at a time; your table waits for the others between hands.');
    expect(QUALIFIER_HAND_FOR_HAND_TEXT).toBe('Hand-for-hand: waiting for the other tables to finish their hand');
    expect(QUALIFIER_HAND_FOR_HAND_OFF_TEXT).toBe('Hand-for-hand is over: normal play resumes.');
    for (const s of [qualifierHandForHandOnText(11, 10), QUALIFIER_HAND_FOR_HAND_TEXT, QUALIFIER_HAND_FOR_HAND_OFF_TEXT]) {
      expect(s.length).toBeLessThanOrEqual(200);
      expect(/^[\x20-\x7e]+$/.test(s)).toBe(true);                     // plain ASCII
    }
  });
});

// ═══════════════════════════════ placeSimultaneousBusts ══
/** A running tournament of `n` entrants p0..p{n-1}, every bust through the REAL eliminatePlayer. */
function tmWorld(n: number) {
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: [{ sb: 100, bb: 200, ante: 0, duration: 600 }], startingChips: 50_000,
  } as any);
  for (let i = 0; i < n; i++) tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, undefined, `m-${i}`);
  expect(tm.startTournament(tid)).toBeTruthy();
  const t = tm.getTournament(tid)!;
  const place = (id: string) => t.players.find((p) => p.playerId === id)!.finishPosition;
  const places = () => t.players.map((p) => p.finishPosition).filter((x) => x > 0).sort((a, b) => a - b);
  return { tm, tid, t, place, places };
}
afterEach(() => { jest.useRealTimers(); });

describe('HP3 — placeSimultaneousBusts: two tables, one hand-for-hand hand — the bigger STARTING stack takes the better place', () => {
  it('a0 (start 9,000, Table 1) is eliminated FIRST (provisional 11th), b0 (start 3,000, Table 2) second (provisional 10th): a0 → 10th, b0 → 11th', () => {
    const w = tmWorld(13);
    // Two earlier busts (13th, 12th), then the round's two: 11 alive → 9.
    w.tm.eliminatePlayer(w.tid, 'p11');
    w.tm.eliminatePlayer(w.tid, 'p12');
    expect(w.tm.getAliveCount(w.tid)).toBe(11);
    w.tm.eliminatePlayer(w.tid, 'p0');   // "a0" — his table's bust check ran first
    w.tm.eliminatePlayer(w.tid, 'p1');   // "b0"
    expect([w.place('p0'), w.place('p1')]).toEqual([11, 10]);         // the old order: by whose check ran first
    const out = w.tm.placeSimultaneousBusts(w.tid, [
      { playerId: 'p0', startStack: 9000, order: 0 * 9 + 3 },          // Table 1 (order 0), seat 3
      { playerId: 'p1', startStack: 3000, order: 1 * 9 + 0 },          // Table 2 (order 1), seat 0
    ]);
    expect(out).toEqual([{ playerId: 'p0', from: 11, to: 10 }, { playerId: 'p1', from: 10, to: 11 }]);
    expect([w.place('p0'), w.place('p1')]).toEqual([10, 11]);
    expect([w.place('p11'), w.place('p12')]).toEqual([13, 12]);        // earlier busts untouched
    expect(w.t.eliminationOrder).toEqual(['p11', 'p12', 'p1', 'p0']);  // worst first: b0's slot, then a0's
    // Play out: places are a permutation of 1..13, each player once.
    for (const p of [...w.t.players]) if (!p.eliminated && p.playerId !== 'p2') w.tm.eliminatePlayer(w.tid, p.playerId);
    expect(w.t.status).toBe('finished');
    expect(w.places()).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  });

  it('nothing to change: already in starting-stack order → every entry from === to; no chips, no tie group', () => {
    const w = tmWorld(11);
    w.tm.eliminatePlayer(w.tid, 'p0');   // the SHORT stack first (worse place)
    w.tm.eliminatePlayer(w.tid, 'p1');
    const chips = w.t.players.map((p) => [p.playerId, p.chips]);
    const out = w.tm.placeSimultaneousBusts(w.tid, [{ playerId: 'p0', startStack: 1000, order: 0 }, { playerId: 'p1', startStack: 8000, order: 10 }]);
    expect(out).toEqual([{ playerId: 'p1', from: 10, to: 10 }, { playerId: 'p0', from: 11, to: 11 }]);
    expect(w.t.players.some((p) => p.tieGroup !== undefined)).toBe(false);
    expect(w.t.players.map((p) => [p.playerId, p.chips])).toEqual(chips);   // no chip moves
  });
});

describe('HP4 — only the members\' OWN numbers are permuted (a disqualification between them, unknown / alive / duplicate ids ignored)', () => {
  it('three busts with a disqualified entrant placed between them: his place and every non-member stay; ids that are not eliminated members are ignored', () => {
    const w = tmWorld(14);
    w.tm.eliminatePlayer(w.tid, 'p10');                     // 14th (earlier)
    w.tm.eliminatePlayer(w.tid, 'p0');                      // 13th — start 2,000
    w.tm.disqualifyPlayer(w.tid, 'p13');                    // 12th — the hand-start gate, not a member
    w.tm.eliminatePlayer(w.tid, 'p1');                      // 11th — start 9,000
    w.tm.eliminatePlayer(w.tid, 'p2');                      // 10th — start 5,000
    const before = new Map(w.t.players.map((p) => [p.playerId, p.finishPosition]));
    const out = w.tm.placeSimultaneousBusts(w.tid, [
      { playerId: 'p0', startStack: 2000, order: 1 },
      { playerId: 'p1', startStack: 9000, order: 2 },
      { playerId: 'p2', startStack: 5000, order: 3 },
      { playerId: 'p13', startStack: 99_000, order: 4 },   // disqualified: never a member
      { playerId: 'p5', startStack: 99_000, order: 5 },    // alive: ignored
      { playerId: 'nobody', startStack: 99_000, order: 6 },
      { playerId: 'p1', startStack: 1, order: 0 },         // duplicate: the first entry counts
    ]);
    expect(out).toEqual([
      { playerId: 'p1', from: 11, to: 10 },
      { playerId: 'p2', from: 10, to: 11 },
      { playerId: 'p0', from: 13, to: 13 },
    ]);
    for (const [id, pos] of before) if (!['p0', 'p1', 'p2'].includes(id)) expect({ id, pos: w.place(id) }).toEqual({ id, pos });
    expect(w.place('p13')).toBe(12);
    expect(w.t.players.find((p) => p.playerId === 'p13')!.disqualified).toBe(true);
    expect(w.t.eliminationOrder).toEqual(['p10', 'p0', 'p13', 'p2', 'p1']);
    expect(w.places()).toEqual([10, 11, 12, 13, 14]);
  });
});

describe('HP5 — an EXACT tie across tables: one shared tie group (the existing tie rule); the distinct numbers by table, then seat (the lower one takes the WORSE place)', () => {
  it('equal starting stacks at two tables (one already in an in-table tie group): ONE new tie group; Table 1 seat 4 is worse than Table 2 seat 1; finishTournament marks them tied; places unique 1..N', () => {
    const w = tmWorld(12);
    w.tm.eliminatePlayer(w.tid, 'p11');                                    // 12th
    // Table 1 had an in-table tie (seat 4 and seat 6, equal stacks) — marked before their eliminations.
    expect(w.tm.markSimultaneousBustTie(w.tid, ['p0', 'p3'])).toBe(true);
    const inTable = w.t.players.find((p) => p.playerId === 'p0')!.tieGroup;
    w.tm.eliminatePlayer(w.tid, 'p0');                                     // 11th (Table 1 seat 4)
    w.tm.eliminatePlayer(w.tid, 'p3');                                     // 10th (Table 1 seat 6)
    w.tm.eliminatePlayer(w.tid, 'p1');                                     // 9th  (Table 2 seat 1)
    const out = w.tm.placeSimultaneousBusts(w.tid, [
      { playerId: 'p0', startStack: 4000, order: 0 * 9 + 4 },
      { playerId: 'p3', startStack: 4000, order: 0 * 9 + 6 },
      { playerId: 'p1', startStack: 4000, order: 1 * 9 + 1 },
    ]);
    // Highest (table, seat) gets the best number: Table 2 seat 1 → 9th, Table 1 seat 6 → 10th, Table 1 seat 4 → 11th.
    expect(out).toEqual([{ playerId: 'p1', from: 9, to: 9 }, { playerId: 'p3', from: 10, to: 10 }, { playerId: 'p0', from: 11, to: 11 }]);
    const groups = ['p0', 'p3', 'p1'].map((id) => w.t.players.find((p) => p.playerId === id)!.tieGroup);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).not.toBe(inTable);
    expect(groups[0]).toBeDefined();
    for (const p of [...w.t.players]) if (!p.eliminated && p.playerId !== 'p2') w.tm.eliminatePlayer(w.tid, p.playerId);
    expect(w.t.status).toBe('finished');
    expect(w.places()).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('a partial tie: the equal pair shares a group, the bigger stack is not in it', () => {
    const w = tmWorld(11);
    w.tm.eliminatePlayer(w.tid, 'p0');   // 11th
    w.tm.eliminatePlayer(w.tid, 'p1');   // 10th
    w.tm.eliminatePlayer(w.tid, 'p2');   // 9th
    const out = w.tm.placeSimultaneousBusts(w.tid, [
      { playerId: 'p0', startStack: 7000, order: 2 },
      { playerId: 'p1', startStack: 3000, order: 9 },
      { playerId: 'p2', startStack: 3000, order: 4 },
    ]);
    expect(out).toEqual([{ playerId: 'p0', from: 11, to: 9 }, { playerId: 'p1', from: 10, to: 10 }, { playerId: 'p2', from: 9, to: 11 }]);
    const g = (id: string) => w.t.players.find((p) => p.playerId === id)!.tieGroup;
    expect(g('p1')).toBeDefined();
    expect(g('p1')).toBe(g('p2'));
    expect(g('p0')).toBeUndefined();
  });

  it('finishTournament: the tied places\' money is split (a qualifier\'s pool is 0: nothing moves) and both carry tied:true', () => {
    const w = tmWorld(4);
    const done: any[] = [];
    w.tm.onEvent(w.tid, (ev, d) => { if (ev === 'tournamentFinished') done.push(d); });
    w.tm.eliminatePlayer(w.tid, 'p0');
    w.tm.eliminatePlayer(w.tid, 'p1');
    w.tm.placeSimultaneousBusts(w.tid, [{ playerId: 'p0', startStack: 500, order: 1 }, { playerId: 'p1', startStack: 500, order: 2 }]);
    w.tm.eliminatePlayer(w.tid, 'p2');
    expect(done).toHaveLength(1);
    const r = Object.fromEntries(done[0].results.map((x: any) => [x.playerId, x]));
    expect(r.p0).toMatchObject({ position: 4, payout: 0, tied: true });
    expect(r.p1).toMatchObject({ position: 3, payout: 0, tied: true });
    expect(r.p2.tied).toBeUndefined();
    expect(done[0].results.map((x: any) => x.position).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('HP6 — guards: never a tournament that is not running; fewer than two valid members → [] and nothing changes', () => {
  it('registering / finished / cancelled / unknown tournament → []', () => {
    const tm = new TournamentManager();
    const tid = tm.createTournament({ name: 'Q', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 1, bb: 2, ante: 0, duration: 60 }] } as any);
    tm.registerPlayer(tid, 'x', 'X', 'sx');
    expect(tm.placeSimultaneousBusts(tid, [{ playerId: 'x', startStack: 1, order: 0 }, { playerId: 'y', startStack: 2, order: 1 }])).toEqual([]);
    expect(tm.placeSimultaneousBusts('nope', [])).toEqual([]);
    const w = tmWorld(3);
    w.tm.eliminatePlayer(w.tid, 'p0');
    w.tm.eliminatePlayer(w.tid, 'p1');                                     // finished
    expect(w.t.status).toBe('finished');
    const snap = w.t.players.map((p) => [p.playerId, p.finishPosition, p.tieGroup]);
    expect(w.tm.placeSimultaneousBusts(w.tid, [{ playerId: 'p0', startStack: 9000, order: 0 }, { playerId: 'p1', startStack: 1, order: 1 }])).toEqual([]);
    expect(w.t.players.map((p) => [p.playerId, p.finishPosition, p.tieGroup])).toEqual(snap);
  });

  it('one valid member (the rest alive / unknown / duplicates) → [] and nothing changes; a non-array → []', () => {
    const w = tmWorld(6);
    w.tm.eliminatePlayer(w.tid, 'p0');
    const order = [...w.t.eliminationOrder];
    expect(w.tm.placeSimultaneousBusts(w.tid, [
      { playerId: 'p0', startStack: 1, order: 0 }, { playerId: 'p0', startStack: 9, order: 1 }, { playerId: 'p4', startStack: 9, order: 2 }, { playerId: 'zz', startStack: 9, order: 3 },
    ])).toEqual([]);
    expect(w.place('p0')).toBe(6);
    expect(w.t.eliminationOrder).toEqual(order);
    expect(w.tm.placeSimultaneousBusts(w.tid, null as any)).toEqual([]);
  });
});

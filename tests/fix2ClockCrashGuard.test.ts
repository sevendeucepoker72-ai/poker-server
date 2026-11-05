/**
 * Bots review fix round 2 (2026-11-05, critic) — the turn clock and the 30 s draw
 * clock are game timers too.
 *
 * The bots review guarded the bot action / draw timers and every deal timer, but a
 * throw on the TURN clock (armTurnTimer's timeout: autoActForSeat, the engine, a
 * 'playerAction' listener, the tournament sit-out, a broadcast) or the DRAW clock
 * (the 30 s stand-pat — since bots review SD7(b) it also stands pat a bot whose own
 * draw timer was lost) still reached processGuards: flush, then exit(1), voiding
 * every running qualifier. Now both catch, log `[game-timer-error]`
 * (kind turn_clock / draw_clock), count (crashSafety.gameTimers turnClockThrows /
 * drawClockThrows) and move the hand on exactly like a bot's timer: a timed-out
 * seat that never acted is checked / folded for (stamped auto 'timeout'), one that
 * acted has its turn advanced, every undrawn seat is stood pat, and a hand found in
 * Showdown is settled from the stake mark taken before the clock acted.
 *
 * The REAL armTurnTimer + autoActForSeat block, scheduleAIAction (whose draw-round
 * branch arms the draw clock), scheduleAutoStart and the guard block are sliced
 * from src/index.ts and run on the REAL engine on a manual clock.
 *
 * Fails on d1ec56a: the clocks have no try/catch there — every injected throw
 * escapes the timer (`escaped` 1), the turn / draw round is left as it was.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { studDrawKindOf, chooseBotDiscards } from '../src/ai/studDrawStrength';
import { slice, fnSrc, load } from './helpers/indexSource';

const T = 'T';
const TURN_MS = 30000;
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const SAS = fnSrc('function scheduleAutoStart(');
const total = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : 0), 0);

/** A manual clock + the scope every world shares; `run` executes due jobs, counting what escapes. */
function clock(t: PokerTable) {
  let now = 1_000_000;
  let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
  const errors: string[] = [];
  const c = { escaped: 0, escapes: [] as string[], broadcasts: 0, handResults: 0 };
  const pendingAutoStartTimers = new Map<string, any>();
  const base: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
    GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
    pendingAutoStartTimers, clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null,
    broadcastGameState: () => { c.broadcasts++; }, scheduleAIAction() {},
    setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    Date: class FakeDate extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error: (m: unknown) => errors.push(String(m)) },
  };
  t.on('handResult', () => { c.handResults++; });
  /** Run every job due within `ms` (in time order). */
  const advance = (ms: number) => {
    const until = now + ms;
    for (let g = 0; g < 10_000; g++) {
      jobs.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!jobs.length || jobs[0].at > until) break;
      const j = jobs.shift()!;
      now = j.at;
      try { j.fn(); } catch (e) { c.escaped++; c.escapes.push(String((e as Error)?.message || e)); }
    }
    now = until;
  };
  const tagged = () => errors.filter((l) => l.startsWith('[game-timer-error] ')).map((l) => JSON.parse(l.slice('[game-timer-error] '.length)));
  return { base, c, advance, tagged, pendingAutoStartTimers, jobs, now: () => now };
}

// ---------------------------------------------------------------- turn clock ----

function turnWorld(t: PokerTable) {
  const k = clock(t);
  const scope: Record<string, unknown> = {
    ...k.base,
    tournamentTables: new Map(), brokenTournamentTables: new Map(), playerSessions: new Map(), sitOutTracker: new Map(), reservedSeats: new Map(),
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000,
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0, log: { debug() {}, info() {} },
    isTournamentTable: () => false, isAbsentTournamentSeatPastHandLimit: () => false,
    absentSeatOnShortClock: () => false, clearAbsentTimeoutStreak() {}, noteAbsentTimeout() {},
    sitOutTournamentSeatAfterTimeout: () => false, tournamentTimeoutSitOutStats: { shortClockRearmed: 0 },
  };
  const code = [
    slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
    fnSrc('function armTurnTimer('),
    GUARD, SAS,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ armTurnTimer, scheduleAutoStart, gameTimerGuardStats }');
  scope.scheduleAutoStart = m.scheduleAutoStart;
  return { ...k, m, stubbed };
}
/** Two players at a table nobody plays (no session): every turn is the clock's. */
function humans(n: number, chips = 5000): PokerTable {
  const t = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
  for (let i = 0; i < n; i++) t.sitDown(i, `H${i}`, chips, `player-${i}`, false);
  return t;
}

describe('the turn clock — a throw is recovered, never left to the process crash handler', () => {
  it("(t1) a 'playerAction' listener throws on the clock's fold: nothing escapes, ONE fold stamped auto 'timeout', the turn moves on (turnAdvanced 1), chips conserved", () => {
    const t = humans(3);
    expect(t.startNewHand()).toBe(true);
    const seat = t.activeSeatIndex;
    let armed = true;
    t.on('playerAction', () => { if (armed) { armed = false; throw new TypeError('injected playerAction listener fault'); } });
    const w = turnWorld(t);
    const before = total(t);
    w.m.armTurnTimer(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    const mine = t.actionLog.filter((e: any) => e.seatIndex === seat && e.street === GamePhase.PreFlop);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: 'folded', auto: 'timeout' });
    expect(t.activeSeatIndex).not.toBe(seat);
    expect(t.isHandInProgress()).toBe(true);
    expect(total(t)).toBe(before);
    expect(w.m.gameTimerGuardStats).toMatchObject({ turnClockThrows: 1, turnAdvanced: 1, actedFor: 0, recoveryThrows: 0 });
    expect(w.tagged()[0]).toMatchObject({ kind: 'turn_clock', tableId: T, seatIndex: seat, error: 'injected playerAction listener fault' });
    expect(w.c.broadcasts).toBeGreaterThanOrEqual(1);                 // the clients see the new turn
    expect([...w.stubbed].filter((n) => /recover|gameTimer|logGameTimerError|settleShowdown|continueAfter|autoActForSeat|armTurnTimer/.test(n))).toEqual([]);
  });

  it("(t2) the clock throws BEFORE it acted (markAutoAction): the recovery folds for the seat itself, stamped auto 'timeout' (actedFor 1); the hand goes on", () => {
    const t = humans(3);
    expect(t.startNewHand()).toBe(true);
    const seat = t.activeSeatIndex;
    const real = t.markAutoAction.bind(t);
    let armed = true;
    t.markAutoAction = (i: number, r: any) => { if (armed) { armed = false; throw new TypeError('injected markAutoAction fault'); } return real(i, r); };
    const w = turnWorld(t);
    const before = total(t);
    w.m.armTurnTimer(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    const mine = t.actionLog.filter((e: any) => e.seatIndex === seat && e.street === GamePhase.PreFlop);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: 'folded', auto: 'timeout' });
    expect(t.activeSeatIndex).not.toBe(seat);
    expect(total(t)).toBe(before);
    expect(w.m.gameTimerGuardStats).toMatchObject({ turnClockThrows: 1, actedFor: 1, turnAdvanced: 0 });
  });

  it("(t3) the clock's check closes the river and the payout throws once: the hand found in Showdown is settled (RESOLVED, paid once), the next deal scheduled", () => {
    const t = humans(2);
    expect(t.startNewHand()).toBe(true);
    // both check / call down to the river; the river's last actor is the clock's
    for (let g = 0; g < 40 && t.currentPhase !== GamePhase.River; g++) { const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a); }
    expect(t.currentPhase).toBe(GamePhase.River);
    expect(t.playerCheck(t.activeSeatIndex)).toBe(true);
    const spm = (t as any).sidePotManager; const realAward = spm.awardPots.bind(spm);
    let left = 1;
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return realAward(...a); };
    const w = turnWorld(t);
    w.m.armTurnTimer(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0)).toBe(10000);
    expect(t.seats.every((s) => (s.totalInvestedThisHand || 0) === 0)).toBe(true);
    expect(w.c.handResults).toBe(1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.m.gameTimerGuardStats).toMatchObject({ turnClockThrows: 1, showdownFaults: 1, showdownResolved: 1, showdownHeld: 0 });
  });
});

// ---------------------------------------------------------------- draw clock ----

function drawWorld(t: FiveCardDrawTable) {
  const k = clock(t);
  const drawStart = { at: 0 };
  const scope: Record<string, unknown> = {
    ...k.base,
    drawTimers: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), drawClockStart: () => drawStart.at,
    armAbsentDrawerStandPat() {}, studDrawKindOf, chooseBotDiscards,
    fastModeTables: new Map(), tableWantsFastBots: () => true, getThinkingDelay: () => 500, executeAIAction() {},
  };
  const { exports: m, stubbed } = load(`${fnSrc('function scheduleAIAction(')}\n${GUARD}\n${SAS}`, scope, '{ scheduleAIAction, scheduleAutoStart, gameTimerGuardStats }');
  scope.scheduleAIAction = m.scheduleAIAction;
  scope.scheduleAutoStart = m.scheduleAutoStart;
  return { ...k, m, stubbed, drawStart };
}
function drawTable(n: number, chips = 5000): FiveCardDrawTable {
  const t = new FiveCardDrawTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any, false);
  for (let i = 0; i < n; i++) t.sitDown(i, `H${i}`, chips, `player-${i}`, false, true);
  return t;
}
/** playerDraw of `seat` throws `times` times. */
function drawFault(t: FiveCardDrawTable, seat: number, times: number) {
  const real = t.playerDraw.bind(t);
  let left = times;
  t.playerDraw = (s: number, idx: number[]) => { if (s === seat && left > 0) { left--; throw new TypeError('injected draw fault'); } return real(s, idx); };
}

describe('the 30 s draw clock — a throw is recovered, never left to the process crash handler', () => {
  it('(d1) standing the undrawn seats pat throws once at one seat: nothing escapes, the recovery stands it pat, the draw round completes, chips conserved', () => {
    const t = drawTable(3);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    const w = drawWorld(t);
    w.drawStart.at = w.now();
    drawFault(t, 1, 1);
    const before = total(t);
    w.m.scheduleAIAction(T);                                          // arms the draw clock (nobody draws)
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);
    expect(t.isHandInProgress()).toBe(true);
    expect(total(t)).toBe(before);
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawClockThrows: 1, recoveryThrows: 0 });
    expect(w.m.gameTimerGuardStats.stoodPat).toBeGreaterThanOrEqual(1);
    expect(w.tagged()[0]).toMatchObject({ kind: 'draw_clock', tableId: T, error: 'injected draw fault' });
    expect([...w.stubbed].filter((n) => /recover|gameTimer|logGameTimerError|settleShowdown|continueAfter|playerDraw|drawsCompleted/.test(n))).toEqual([]);
  });

  it('(d2) both players all-in before the draw: the clock\'s last stand-pat runs the hand to its payout, which throws once: settled from the mark (RESOLVED), paid once', () => {
    const t = drawTable(2, 1000);
    expect(t.startNewHand()).toBe(true);
    expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    expect(t.playerCall(t.activeSeatIndex)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    const spm = (t as any).sidePotManager; const realAward = spm.awardPots.bind(spm);
    let left = 1;
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return realAward(...a); };
    const w = drawWorld(t);
    w.drawStart.at = w.now();
    w.m.scheduleAIAction(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0)).toBe(2000);
    expect(w.c.handResults).toBe(1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawClockThrows: 1, showdownFaults: 1, showdownResolved: 1, showdownHeld: 0 });
  });

  it('(d3) a seat whose stand-pat throws EVERY time: nothing escapes (the recovery\'s own retry is counted), the other seats are stood pat, the round waits on that seat', () => {
    const t = drawTable(3);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    const w = drawWorld(t);
    w.drawStart.at = w.now();
    drawFault(t, 0, 1_000);
    w.m.scheduleAIAction(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(t.drawsCompleted.has(0)).toBe(false);
    expect(t.drawsCompleted.has(1) && t.drawsCompleted.has(2)).toBe(true);
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawClockThrows: 1, recoveryThrows: 1 });
  });
});

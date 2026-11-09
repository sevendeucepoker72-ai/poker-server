/**
 * Bots review fix round 3 (2026-11-05) — EVERY timer that reaches the engine is guarded.
 *
 * Round 2 guarded the bot action / draw timers, the deal timers, the heartbeat, the turn
 * clock and the 30 s draw clock. These still reached processGuards on a throw (flush, then
 * exit(1): every running qualifier voided) — the critic's list:
 *   - the 500 ms auto-act for a sitting-out / orphan seat (broadcastGameState),
 *   - the absent-drawer stand-pat (armAbsentDrawerStandPat -> standPatAbsentDrawers),
 *   - the Crazy Pineapple discard window and the insurance window releases,
 *   - the Spin & Go first deal (3.5 s after the spin),
 *   - the tournament rebalance cascade (500 ms) and the 5 s rebalance sweep,
 * and, found by the enumeration (fix3 timers.js, an AST walk of every setTimeout /
 * setInterval / setImmediate callback in src/: 27 reach the engine, 0 unguarded now;
 * 2b5ac52: 8 unguarded, 0dc1b96: 17), a seat reservation's expiry (its teardown folds).
 * Each now catches, logs `[game-timer-error]`, counts (crashSafety.gameTimers) and recovers;
 * a draw round a recovery left open is stood pat again 3 s later (a double transient
 * stand-pat throw used to leave the round stuck: the 30 s clock is one-shot and the wedge
 * watchdog skips draw rounds), and a round whose completion threw is completed.
 *
 * REAL code sliced from src/index.ts on the REAL engine, on a manual clock (an escape is
 * counted); the child-process cases run the guarded callbacks under the REAL processGuards.
 *
 * Fails on 2b5ac52: every injected throw escapes its timer (production: exit 1), the
 * double transient / completion-throw draw rounds stay stuck, and the sweep stops at the
 * first tournament that throws.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import { studDrawKindOf, chooseBotDiscards } from '../src/ai/studDrawStrength';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const T = 'T';
const TURN_MS = 30000;
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const SAS = fnSrc('function scheduleAutoStart(');
const AUTO_ACT = slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n");
const ORPHAN_BLOCK = slice('    if (shouldAutoAct) {', '      }, 500);\n    }\n');
const ORPHAN = `function orphanAct(tableId, activeIdx) {\n  const shouldAutoAct = true;\n${ORPHAN_BLOCK}}\n`;
const ABSENT_DRAWERS = slice('// ===== Absent drawers (gameplay S3 fix-up, 2026-10-21) =====', '// ===== end absent drawers =====\n');
const PINEAPPLE = SRC.slice(SRC.indexOf('const PINEAPPLE_DISCARD_WINDOW_MS = '), SRC.indexOf('\n}\n', SRC.indexOf('function releasePineappleDiscardHoldIfDecided(')) + 3);
const SPIN_GO = `function spinGoDeal(tableId, socket) {\n${slice('    // Start hand after reveal delay (3 seconds)', '    setTimeout(() => spinGoFirstDeal(true), 3500);\n')}}\n`;
const total = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : 0), 0);
const stacks = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0);

function clock(t: PokerTable, extra: Record<string, unknown> = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
  const errors: string[] = [];
  const c = { escaped: 0, escapes: [] as string[], broadcasts: 0, handResults: 0 };
  const pendingAutoStartTimers = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
    GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
    pendingAutoStartTimers, clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null,
    broadcastGameState: () => { c.broadcasts++; }, scheduleAIAction() {},
    setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    Date: class FakeDate extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error: (m: unknown) => errors.push(String(m)) },
    log: { debug() {}, info() {} },
    ...extra,
  };
  t.on('handResult', () => { c.handResults++; });
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
  return { scope, c, advance, tagged, pendingAutoStartTimers, now: () => now };
}
function humans(n: number, chips = 5000): PokerTable {
  const t = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
  for (let i = 0; i < n; i++) t.sitDown(i, `H${i}`, chips, `player-${i}`, false);
  return t;
}
/** Heads-up at 50/100 with 50 chips each: the deal puts both blinds all-in and runs the hand out to its payout. */
function shortHeadsUp(): PokerTable {
  const t = humans(2);
  for (const s of t.seats) if (s.state === 'occupied') s.chipCount = 50;
  return t;
}
function drawTable(n: number, chips = 5000): FiveCardDrawTable {
  const t = new FiveCardDrawTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any, false);
  for (let i = 0; i < n; i++) t.sitDown(i, `H${i}`, chips, `player-${i}`, false, true);
  return t;
}
/** Limp / check every seat into the first draw round. */
function toDraw1(t: FiveCardDrawTable) {
  expect(t.startNewHand()).toBe(true);
  for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
  expect(t.currentPhase).toBe(GamePhase.Draw1);
}
/** playerDraw of `seat` throws `times` times, BEFORE drawing. */
function drawFault(t: FiveCardDrawTable, seat: number, times: number) {
  const real = t.playerDraw.bind(t);
  let left = times;
  t.playerDraw = (s: number, idx: number[]) => { if (s === seat && left > 0) { left--; throw new TypeError('injected draw fault'); } return real(s, idx); };
}
/** A 'playerDrew' listener throws once when the round's LAST undrawn seat draws (the draw is recorded, the round not completed). */
function lastDrewFault(t: FiveCardDrawTable) {
  let armed = true;
  t.on('playerDrew', () => {
    if (!armed) return;
    const undrawn = t.seats.filter((s) => s.state === 'occupied' && !s.folded && s.holeCards.length > 0 && !t.drawsCompleted.has(s.seatIndex));
    if (undrawn.length === 0) { armed = false; throw new TypeError('injected playerDrew listener fault'); }
  });
}

describe('the 500 ms auto-act for a sitting-out / orphan seat', () => {
  function orphanWorld(t: PokerTable) {
    const k = clock(t, {
      seatHasAnySession: () => false, seatHasAnyPlayingSession: () => false, reservedSeats: new Map(), isTournamentTable: () => false,
      tournamentTables: new Map(), brokenTournamentTables: new Map(), playerSessions: new Map(), sitOutTracker: new Map(),
      tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000,
      turnTimers: new Map(), turnStartedSeatMap: new Map(),
      noteAbsentTimeout() {}, sitOutTournamentSeatAfterTimeout: () => false, armTurnTimer() {}, tournamentTimeoutSitOutStats: { shortClockRearmed: 0 },
    });
    const { exports: m, stubbed } = load(`${AUTO_ACT}\n${ORPHAN}\n${GUARD}\n${SAS}`, k.scope, '{ orphanAct, scheduleAutoStart, gameTimerGuardStats }');
    k.scope.scheduleAutoStart = m.scheduleAutoStart;
    return { ...k, m, stubbed };
  }

  it("a 'playerAction' listener throws on the auto-act's fold: nothing escapes, ONE fold stamped auto 'away', the turn moves on, chips conserved", () => {
    const t = humans(3);
    expect(t.startNewHand()).toBe(true);
    const seat = t.activeSeatIndex;
    let armed = true;
    t.on('playerAction', () => { if (armed) { armed = false; throw new TypeError('injected playerAction listener fault'); } });
    const w = orphanWorld(t);
    const before = total(t);
    w.m.orphanAct(T, seat);
    w.advance(600);
    expect(w.c.escaped).toBe(0);                                         // 2b5ac52: 1 (exit 1 in production)
    const mine = t.actionLog.filter((e: any) => e.seatIndex === seat);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: 'folded', auto: 'away' });
    expect(t.activeSeatIndex).not.toBe(seat);
    expect(total(t)).toBe(before);
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentActThrows: 1, turnAdvanced: 1, actedFor: 0, recoveryThrows: 0 });
    expect(w.tagged()[0]).toMatchObject({ kind: 'absent_act', seatIndex: seat, error: 'injected playerAction listener fault' });
    expect([...w.stubbed].filter((n) => /recover|gameTimer|settle|continueAfter|autoActForSeat|actForTurn/.test(n))).toEqual([]);
  });

  it("the auto-act throws BEFORE acting (markAutoAction): the recovery folds for the seat itself, stamped auto 'away' (actedFor 1)", () => {
    const t = humans(3);
    expect(t.startNewHand()).toBe(true);
    const seat = t.activeSeatIndex;
    const real = t.markAutoAction.bind(t);
    let armed = true;
    t.markAutoAction = (i: number, r: any) => { if (armed) { armed = false; throw new TypeError('injected markAutoAction fault'); } return real(i, r); };
    const w = orphanWorld(t);
    w.m.orphanAct(T, seat);
    w.advance(600);
    expect(w.c.escaped).toBe(0);
    const mine = t.actionLog.filter((e: any) => e.seatIndex === seat);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: 'folded', auto: 'away' });
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentActThrows: 1, actedFor: 1, turnAdvanced: 0 });
  });
});

describe('the draw rounds: the absent-drawer stand-pat, the 30 s draw clock retry, a round whose completion threw', () => {
  function absentWorld(t: FiveCardDrawTable) {
    const k = clock(t);
    const roundStart = { at: 0 };
    Object.assign(k.scope, {
      seatHasAnyPlayingSession: () => false, isAbsentTournamentSeatPastHandLimit: () => false, tournamentSeatSitsOut: () => false,
      reservedSeats: new Map(), ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000, drawClockStart: () => roundStart.at,
    });
    const { exports: m, stubbed } = load(`${ABSENT_DRAWERS}\n${GUARD}\n${SAS}`, k.scope, '{ armAbsentDrawerStandPat, scheduleAutoStart, gameTimerGuardStats }');
    k.scope.scheduleAutoStart = m.scheduleAutoStart;
    return { ...k, m, stubbed, roundStart };
  }
  function drawClockWorld(t: FiveCardDrawTable) {
    const k = clock(t);
    const drawStart = { at: 0 };
    Object.assign(k.scope, {
      drawTimers: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), drawClockStart: () => drawStart.at,
      armAbsentDrawerStandPat() {}, studDrawKindOf, chooseBotDiscards,
      fastModeTables: new Map(), tableWantsFastBots: () => true, getThinkingDelay: () => 500, executeAIAction() {},
    });
    const { exports: m, stubbed } = load(`${fnSrc('function scheduleAIAction(')}\n${GUARD}\n${SAS}`, k.scope, '{ scheduleAIAction, scheduleAutoStart, gameTimerGuardStats }');
    k.scope.scheduleAIAction = m.scheduleAIAction;
    k.scope.scheduleAutoStart = m.scheduleAutoStart;
    return { ...k, m, stubbed, drawStart };
  }

  it('absent stand-pat: one seat\'s stand-pat throws once -> nothing escapes, the recovery stands it pat, the round completes', () => {
    const t = drawTable(3);
    toDraw1(t);
    const w = absentWorld(t);
    w.roundStart.at = w.now();
    drawFault(t, 1, 1);
    const before = total(t);
    w.m.armAbsentDrawerStandPat(T, 500);
    w.advance(600);
    expect(w.c.escaped).toBe(0);                                         // 2b5ac52: 1
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);
    expect(total(t)).toBe(before);
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentStandPatThrows: 1, recoveryThrows: 0 });
    expect(w.tagged()[0]).toMatchObject({ kind: 'absent_stand_pat', error: 'injected draw fault' });
  });

  it("absent stand-pat: the LAST stand-pat's 'playerDrew' listener throws (the round full, not completed) -> the recovery completes it", () => {
    const t = drawTable(3);
    toDraw1(t);
    const w = absentWorld(t);
    w.roundStart.at = w.now();
    lastDrewFault(t);
    w.m.armAbsentDrawerStandPat(T, 500);
    w.advance(600);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentStandPatThrows: 1 });
  });

  it('30 s draw clock, a DOUBLE transient stand-pat throw (the clock and its recovery): the round is stood pat again 3 s later and completes', () => {
    const t = drawTable(3);
    toDraw1(t);
    const w = drawClockWorld(t);
    w.drawStart.at = w.now();
    drawFault(t, 1, 2);
    const before = total(t);
    w.m.scheduleAIAction(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.Draw1);                       // the clock + its recovery both threw
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawClockThrows: 1, recoveryThrows: 1, drawRoundRetries: 1 });
    w.advance(3000);
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);                   // 2b5ac52: stuck in Draw1 for good
    expect(t.isHandInProgress()).toBe(true);
    expect(total(t)).toBe(before);
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawRoundRetries: 1, recoveryThrows: 1 });
  });

  it("30 s draw clock: the last stand-pat's 'playerDrew' listener throws -> the recovery completes the full round at once", () => {
    const t = drawTable(3);
    toDraw1(t);
    const w = drawClockWorld(t);
    w.drawStart.at = w.now();
    lastDrewFault(t);
    w.m.scheduleAIAction(T);
    w.advance(TURN_MS + 5);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);                   // 2b5ac52: every seat drawn, the round never completed
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawClockThrows: 1, drawRoundRetries: 0 });
  });

  it('30 s draw clock, a STICKY stand-pat fault: retried 5 times (3 s apart), then the round waits on that seat (disclosed residual); nothing escapes', () => {
    const t = drawTable(3);
    toDraw1(t);
    const w = drawClockWorld(t);
    w.drawStart.at = w.now();
    drawFault(t, 0, 1_000);
    w.m.scheduleAIAction(T);
    w.advance(TURN_MS + 60_000);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(t.drawsCompleted.has(1) && t.drawsCompleted.has(2)).toBe(true);
    expect(w.m.gameTimerGuardStats).toMatchObject({ drawClockThrows: 1, drawRoundRetries: 5, recoveryThrows: 6 });
  });
});

describe('the runout-hold releases: the Crazy Pineapple discard window', () => {
  it('the window ends, the runout\'s payout throws after paying -> nothing escapes, settled from the payout mark (paid_finished), chips conserved', () => {
    const t = new PineappleTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any, true);
    t.sitDown(0, 'H0', 1000, 'player-0', false, true);
    t.sitDown(1, 'H1', 1000, 'player-1', false, true);
    const k = clock(t, { seatHasAnySession: () => true });
    const { exports: m, stubbed } = load(`${PINEAPPLE}\n${GUARD}\n${SAS}`, k.scope, '{ decidePineappleDiscardHold, scheduleAutoStart, gameTimerGuardStats }');
    k.scope.scheduleAutoStart = m.scheduleAutoStart;
    t.discardHoldDecider = (tb: PineappleTable) => m.decidePineappleDiscardHold(T, tb);
    expect(t.startNewHand()).toBe(true);
    expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    expect(t.playerCall(t.activeSeatIndex)).toBe(true);
    expect(t.isDiscardHeld()).toBe(true);                               // held on the flop for the discards
    const real = (t as any).buildPotBreakdown.bind(t);
    let left = 1;
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left-- > 0) throw new TypeError('injected post-payment fault'); return real(...a); };
    k.advance(10_001);
    expect(k.c.escaped).toBe(0);                                         // 2b5ac52: 1 (exit 1 in production)
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacks(t)).toBe(2000);
    expect(total(t)).toBe(2000);
    expect(k.c.handResults).toBe(1);
    expect(m.gameTimerGuardStats).toMatchObject({ holdReleaseThrows: 1, showdownFaults: 1, showdownPaidFinished: 1, showdownHeld: 0 });
    expect(k.tagged()[0]).toMatchObject({ kind: 'pineapple_release', error: 'injected post-payment fault' });
    expect(k.pendingAutoStartTimers.has(T)).toBe(true);
    expect([...stubbed].filter((n) => /settle|gameTimer|continueAfter|recover/.test(n))).toEqual([]);
  });
});

describe('the Spin & Go first deal (3.5 s after the spin)', () => {
  function spinWorld(t: PokerTable, broadcast?: () => void) {
    const k = clock(t, { sendProgressToPlayer() {} });
    if (broadcast) k.scope.broadcastGameState = broadcast;
    const { exports: m } = load(`${SPIN_GO}\n${GUARD}\n${SAS}`, k.scope, '{ spinGoDeal, scheduleAutoStart, gameTimerGuardStats }');
    k.scope.scheduleAutoStart = m.scheduleAutoStart;
    return { ...k, m };
  }
  it('the deal runs both blinds all-in to a payout that throws once -> settled (RESOLVED, paid once), the next deal scheduled', () => {
    const t = shortHeadsUp();
    const spm = (t as any).sidePotManager; const realAward = spm.awardPots.bind(spm);
    let left = 1;
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return realAward(...a); };
    const w = spinWorld(t);
    w.m.spinGoDeal(T, { id: 'S' });
    w.advance(3600);
    expect(w.c.escaped).toBe(0);                                         // 2b5ac52: 1
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacks(t)).toBe(100);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealPayoutFaults: 1, showdownResolved: 1, dealThrows: 0 });
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
  });
  it('any other throw in the timer (its broadcast): logged and counted, the dealt hand goes on', () => {
    const t = humans(3);
    let armed = true;
    const w = spinWorld(t, () => { if (armed) { armed = false; throw new TypeError('injected broadcast fault'); } });
    w.m.spinGoDeal(T, { id: 'S' });
    w.advance(3600);
    expect(w.c.escaped).toBe(0);
    expect(t.isHandInProgress()).toBe(true);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealThrows: 1, dealPayoutFaults: 0 });
    expect(w.tagged()[0]).toMatchObject({ kind: 'spin_go_deal', error: 'injected broadcast fault' });
  });
});

describe('the 5 s rebalance sweep', () => {
  it('one tournament\'s rebalance throws: counted, and the sweep still services every other tournament (2b5ac52: the throw aborted the sweep)', () => {
    const k = clock(humans(2));
    const serviced: string[] = [];
    Object.assign(k.scope, {
      tournamentTables: new Map([['ta', 'T-1'], ['tb', 'T-2']]),
      tournamentManager: { getTournament: () => ({ status: 'running', tableIds: ['x', 'y'] }) },
      qualifierPreStartHolds: new Map(), planTournamentRebalance: () => true,
      handleTableRebalance: (tid: string) => { serviced.push(tid); if (tid === 'T-1') throw new TypeError('injected rebalance fault'); },
      tournamentBustChecksPending: new Map(), tournamentDealsHeldForBustCheck: new Set(), tournamentBreaksAwaitingHandEnd: new Map(),
    });
    const { exports: m } = load(`${fnSrc('function sweepTournamentRebalances(')}\n${GUARD}`, k.scope, '{ sweepTournamentRebalances, gameTimerGuardStats }');
    expect(() => m.sweepTournamentRebalances()).not.toThrow();
    expect(serviced).toEqual(['T-1', 'T-2']);
    expect(m.gameTimerGuardStats).toMatchObject({ tournamentTimerThrows: 1 });
    expect(k.tagged()[0]).toMatchObject({ kind: 'rebalance_sweep', error: 'injected rebalance fault' });
  });
});

describe('every deal site settles a deal-time payout fault (requirement 4)', () => {
  it('source: every startNewHand() call is in autoStartNextHand / ensureCashTableRunning (settled by their callers\' guards) or wrapped so its catch hands the throw to settleDealThrow', () => {
    const sf = ts.createSourceFile('index.ts', SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const sites: Array<{ line: number; fn: string; how: string }> = [];
    const visit = (node: any) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'startNewHand') {
        let fn = '(top)'; let how = 'UNGUARDED';
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isTryStatement(p) && p.catchClause && p.catchClause.block.getText(sf).includes('settleDealThrow(') && how === 'UNGUARDED') how = 'settleDealThrow';
          if (ts.isFunctionDeclaration(p) && p.name) { fn = p.name.text; break; }
        }
        if (how === 'UNGUARDED' && (fn === 'autoStartNextHand' || fn === 'ensureCashTableRunning')) how = 'caller guard';
        sites.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn, how });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(sites.length).toBe(14);
    expect(sites.filter((s) => s.how === 'UNGUARDED')).toEqual([]);
    expect(sites.filter((s) => s.how === 'caller guard').map((s) => s.fn).sort()).toEqual(['autoStartNextHand', 'ensureCashTableRunning']);
    // the callers of those two: the 4 deal timers + 'startHand' (try { autoStartNextHand(…) }), the heartbeat (try { ensureCashTableRunning(…) })
    expect(SRC.split('try { autoStartNextHand(').length - 1).toBe(5);
    expect(SRC).toContain('try { ensureCashTableRunning(t.tableId); } catch (err) { gameTimerGuardStats.heartbeatThrows++;');
  });

  it('dealAfterJoin: a join that deals a hand running out to a payout that throws -> settled (paid_finished), true, chips conserved, the next deal scheduled', () => {
    const t = shortHeadsUp();
    const real = (t as any).buildPotBreakdown.bind(t);
    let left = 1;
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left-- > 0) throw new TypeError('injected post-payment fault'); return real(...a); };
    const k = clock(t, { activateBombPotIfPending: () => false });
    const { exports: m } = load(`${fnSrc('function dealAfterJoin(')}\n${GUARD}\n${SAS}`, k.scope, '{ dealAfterJoin, scheduleAutoStart, gameTimerGuardStats }');
    k.scope.scheduleAutoStart = m.scheduleAutoStart;
    expect(m.dealAfterJoin(T, t)).toBe(true);                           // 2b5ac52: the throw reaches the join's caller, the hand rests in Showdown
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacks(t)).toBe(100);
    expect(total(t)).toBe(100);
    expect(m.gameTimerGuardStats).toMatchObject({ dealPayoutFaults: 1, showdownPaidFinished: 1, showdownHeld: 0 });
    expect(k.tagged()[0]).toMatchObject({ kind: 'deal', where: 'deal_after_join' });
    expect(k.pendingAutoStartTimers.has(T)).toBe(true);
  });

  it('a deal throw that is NOT a payout fault is rethrown to the caller, as before', () => {
    const t = humans(2);
    t.startNewHand = () => { throw new TypeError('injected pre-deal fault'); };
    const k = clock(t, { activateBombPotIfPending: () => false });
    const { exports: m } = load(`${fnSrc('function dealAfterJoin(')}\n${GUARD}\n${SAS}`, k.scope, '{ dealAfterJoin, gameTimerGuardStats }');
    expect(() => m.dealAfterJoin(T, t)).toThrow('injected pre-deal fault');
    expect(m.gameTimerGuardStats.dealPayoutFaults).toBe(0);
  });
});

describe('a child process with the REAL processGuards: every newly guarded timer throws once', () => {
  const CHILD_TIMEOUT_MS = 30_000;
  let dir = '';
  const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
    .outputText.replace(/^"use strict";\s*/m, '');
  // Sliced lazily (inside the case): on a tree without these guards the slices do not exist and the case fails alone.
  const guardedCode = (): string => {
    const RESERVE = fnSrc('function reserveSeatForDeparture(');
    const INSURANCE = fnSrc('function decideInsuranceHold(');
    const PINE_DECIDE = fnSrc('function decidePineappleDiscardHold(');
    const CASCADE = `function cascade(tournamentId) {\n${slice('    setTimeout(() => {\n      try { handleTableRebalance(tournamentId); }', '    }, 500);\n')}}\n`;
    // the 5 s sweep: per tournament (its interval stays `setInterval(sweepTournamentRebalances, 5000);`)
    const SWEEP = fnSrc('function sweepTournamentRebalances(');
    const ARM_ABSENT = fnSrc('function armAbsentDrawerStandPat(');
    return [GUARD, ORPHAN, ARM_ABSENT, INSURANCE, PINE_DECIDE, SPIN_GO, RESERVE, CASCADE, SWEEP].join('\n');
  };
  // The 2b5ac52 shape of one of them (the rebalance cascade timer, bare) — the CONTROL.
  const BARE_CASCADE = 'function cascade(tournamentId) {\n  setTimeout(() => handleTableRebalance(tournamentId), 500);\n}\n';
  const CHILD = (code: string, exportsList: string, calls: string) => `
const path = require('path');
const { installProcessCrashHandlers, processCrashStats } = require(path.join(__dirname, 'processGuards.js'));
installProcessCrashHandlers({ flush: async () => { console.log('FLUSHED'); }, flushTimeoutMs: 2000, log: (l) => console.log(l) });
const boom = (what) => () => { throw new TypeError('injected ' + what + ' fault'); };
const table = {
  handNumber: 1, stateVersion: 1, actionLog: [], currentPhase: 'PreFlop', activeSeatIndex: 0,
  seats: [{ seatIndex: 0, state: 'occupied', isAI: false, playerId: 'p0', playerName: 'P0', chipCount: 1000, totalInvestedThisHand: 0, folded: false, holeCards: [1, 2] }],
  isHandInProgress() { return true; }, withAutoAction(i, r, fn) { return fn(); },
  playerCheck(i) { this.actionLog.push({ seatIndex: i, action: 'checked' }); this.activeSeatIndex = -1; this.stateVersion++; return true; }, playerFold() { return false; },
};
const used = new Set();
const inert = (name) => new Proxy(function () {}, { get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : inert(name + '.' + String(p))), apply: () => undefined });
const scope = {
  console, Sentry: null, Date, Math, JSON, Map, Set, WeakMap, WeakSet, Error, TypeError, Promise, Object, Array, String, Number, Boolean,
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 50)), clearTimeout, setInterval: (fn) => setTimeout(fn, 10),
  // one live table every timer finds: mid-turn on seat 0, not a draw round, not Showdown
  tableManager: { getTable: () => table },
  log: { debug() {}, info() {} },
  // the engine / the work each timer runs: all throw
  autoActForSeat: boom('autoAct'), seatHasAnySession: () => false, seatHasAnyPlayingSession: () => false, isTournamentTable: () => false,
  reservedSeats: new Map(), DrawPhases: [],
  standPatAbsentDrawers: boom('standPat'), absentDrawerChecks: new Map(), ABSENT_DRAWER_STAND_PAT_MS: 10,
  insuranceCandidates: () => [{ seatIndex: 0, opponent: 1 }], priceInsuranceQuote: () => ({}), insuranceContestedPot: () => 0, insuranceBoardKey: () => 'k',
  clearInsuranceOffer() {}, insuranceOffers: new Map(), insuranceStats: { windows: 0, quotes: 0 }, INSURANCE_DECISION_MS: 10, releaseInsuranceHold: boom('insurance release'),
  pineappleDiscardWaitsFor: () => [0], clearPineappleDiscardHold() {}, pineappleDiscardHolds: new Map(), PINEAPPLE_DISCARD_WINDOW_MS: 10, releasePineappleDiscardHold: boom('pineapple release'),
  isDeadTournamentSeat: () => false, isTournamentReservation: () => false, shutdownFlushActive: () => false, SEAT_RESERVE_MS: 10, DISCONNECT_HANDS_LIMIT: 20,
  endCashReservation: boom('reservation teardown'),
  handleTableRebalance: boom('rebalance'),
  // the sweep's two running tournaments, both due a rebalance (each one's throw counted, neither stops the sweep)
  tournamentTables: new Map([['ta', 'T-1'], ['tb', 'T-2']]), tournamentManager: { getTournament: () => ({ status: 'running', tableIds: ['ta', 'tb'] }) },
  qualifierPreStartHolds: new Map(), planTournamentRebalance: () => true,
  tournamentBustChecksPending: new Map(), tournamentDealsHeldForBustCheck: new Set(), tournamentBreaksAwaitingHandEnd: new Map(),
};
const env = new Proxy(scope, {
  has: (t, k) => typeof k === 'string' && !['module', 'exports', 'require', '__env'].includes(k),
  get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : (k in globalThis ? globalThis[k] : (used.add(k), inert(k)))),
});
const mod = { exports: {} };
new Function('__env', 'module', 'exports', 'require', 'with (__env) {\\n' + ${JSON.stringify(transpile(`${code}\nmodule.exports = { ${exportsList} };`))} + '\\n}')(env, mod, mod.exports, require);
const m = mod.exports;
${calls}
setTimeout(() => {
  console.log('RESULT ' + JSON.stringify({ uncaught: processCrashStats.uncaughtExceptions, guard: m.gameTimerGuardStats || null }));
  process.exit(0);
}, 400);
`;
  function runChild(code: string, exportsList: string, calls: string): Promise<{ code: number | null; out: string }> {
    const file = path.join(dir, `child-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, CHILD(code, exportsList, calls));
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout!.on('data', (d) => { out += String(d); });
      p.stderr!.on('data', (d) => { out += String(d); });
      p.on('exit', (c) => resolve({ code: c, out }));
    });
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-timer-guards-'));
    fs.writeFileSync(path.join(dir, 'processGuards.js'), transpile(fs.readFileSync(path.join(__dirname, '..', 'src', 'processGuards.ts'), 'utf8')));
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('the guarded timers: the process keeps running (exit 0, uncaughtExceptions 0) and each throw is counted', async () => {
    const calls = [
      "m.orphanAct('T', 0);",
      "m.armAbsentDrawerStandPat('T', 1);",
      "m.decideInsuranceHold('T', { handNumber: 1, seats: [{ holeCards: [] }, { holeCards: [] }], communityCards: [] });",
      "m.decidePineappleDiscardHold('T', { handNumber: 1 });",
      "m.spinGoDeal('T', { id: 'S' });",
      "m.reserveSeatForDeparture({ userId: 7, username: 'u' }, { tableId: 'T', seatIndex: 0, playerName: 'P', sittingOut: false }, { isHandInProgress: () => false, seats: [] }, { chipCount: 1 }, {});",
      "m.cascade('T-1');",
      'm.sweepTournamentRebalances();',
    ].join('\n');
    const r = await runChild(guardedCode(), 'orphanAct, armAbsentDrawerStandPat, decideInsuranceHold, decidePineappleDiscardHold, spinGoDeal, reserveSeatForDeparture, cascade, sweepTournamentRebalances, gameTimerGuardStats', calls);
    expect(r.out).toContain('RESULT ');
    expect(r.code).toBe(0);
    const res = JSON.parse(/RESULT (.*)/.exec(r.out)![1]);
    expect(res.uncaught).toBe(0);
    expect(res.guard).toMatchObject({
      absentActThrows: 1, actedFor: 1,
      absentStandPatThrows: 1, holdReleaseThrows: 2, dealThrows: 1, reservationTimerThrows: 1, tournamentTimerThrows: 3,
    });
    expect(r.out).not.toContain('flush_then_exit');
    for (const kind of ['absent_act', 'absent_stand_pat', 'insurance_release', 'pineapple_release', 'spin_go_deal', 'reservation_expiry', 'rebalance', 'rebalance_sweep']) {
      expect(r.out).toContain(`[game-timer-error] {"kind":"${kind}"`);
    }
  }, CHILD_TIMEOUT_MS);

  it("CONTROL — the 2b5ac52 shape (the rebalance cascade timer bare): the same throw exits 1 after 'flush_then_exit'", async () => {
    const r = await runChild(`${GUARD}\n${BARE_CASCADE}`, 'cascade, gameTimerGuardStats', "m.cascade('T-1');");
    expect(r.code).toBe(1);
    expect(r.out).toContain('"action":"flush_then_exit"');
    expect(r.out).toContain('FLUSHED');
    expect(r.out).not.toContain('RESULT ');
  }, CHILD_TIMEOUT_MS);
});

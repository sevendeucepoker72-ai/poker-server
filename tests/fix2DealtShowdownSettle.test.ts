/**
 * Bots review fix round 2 (2026-11-05, SS-1) — a hand the DEAL itself runs out to
 * its payout, whose payout throws.
 *
 * PokerTable.startNewHand runs the board out at the deal whenever the forced bets
 * leave nobody able to act (both heads-up blinds all-in — the end of a Spin & Go or
 * a short-stacked heads-up cash game — or a bomb pot every stack is all-in on). If
 * determineWinners throws there, the scheduled deal's guard (recoverAutoStartThrow)
 * used to HOLD the table in Showdown with no settle, no broadcast and no next deal:
 * nothing released it (the wedge watchdog skips held hands, the heartbeat acts only
 * on HandComplete, a leaver's seat was deferred to a hand end that never came) until
 * a restart. Now the deal path is settled exactly like a bot's turn, from the
 * engine's own pre-blind capture (table.startChips): retried once if nothing was
 * paid, finished if paid in full, voided (every stake back) otherwise; then one
 * broadcast and the next deal. The heartbeat's own deal is settled the same way.
 *
 * The REAL guard block, scheduleAutoStart, autoStartNextHand, activateBombPotIfPending,
 * ensureCashTableRunning, the heartbeat tick, the seat teardown and
 * processPendingSeatRemovals are sliced from src/index.ts and run on the REAL engine,
 * on a manual clock; faults are injected where the guard tests inject them
 * (sidePotManager.awardPots before the payment, buildPotBreakdown after it).
 *
 * Fails on d1ec56a: every case below ends HELD in Showdown there (phase Showdown,
 * 0 broadcasts, no next deal; the leaver's seat 'deferred').
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { slice, fnSrc, load, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const T = 'T';
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const CODE = [
  fnSrc('function scheduleAutoStart('),
  fnSrc('function autoStartNextHand('),
  fnSrc('function activateBombPotIfPending('),
  fnSrc('function ensureCashTableRunning('),
  fnSrc('function processPendingSeatRemovals('),
  GUARD,
  SEAT_TEARDOWN_SRC,
].join('\n');
const HEARTBEAT = slice("console.log('[LiveRoom] heartbeat installed", '}, 12000);');
const WATCHDOG = slice('const WEDGE_TURN_GRACE_MS', '}, 15000);');

type Fault = { where: 'awardPots' | 'buildPotBreakdown'; times: number } | null;
const stacksOnly = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0);
const total = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : 0), 0);

/** A heads-up table resting in HandComplete after a normal hand 1, the stacks then set for hand 2. */
function headsUp(sb: number, bb: number, stacks: [number, number]): PokerTable {
  const t = new PokerTable({ tableId: T, tableName: T, smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: 100 } as any);
  t.sitDown(0, 'Human', 5000, 'player-h', false, true);
  t.sitDown(1, 'Bot', 5000, 'ai-b', true, true);
  expect(t.startNewHand()).toBe(true);
  for (let g = 0; g < 60 && t.isHandInProgress(); g++) { const a = t.activeSeatIndex; if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a); }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
  t.seats[0].chipCount = stacks[0];
  t.seats[1].chipCount = stacks[1];
  return t;
}

function injectFault(t: PokerTable, f: Fault): () => number {
  if (!f) return () => 0;
  let left = f.times;
  if (f.where === 'awardPots') {
    const spm = (t as any).sidePotManager; const real = spm.awardPots.bind(spm);
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return real(...a); };
  } else {
    const real = (t as any).buildPotBreakdown.bind(t);
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected post-payment fault'); } return real(...a); };
  }
  return () => left;
}

function world(t: PokerTable, opts: { quick?: boolean; bombPot?: boolean } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
  const setTimeoutF = (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; };
  const clearTimeoutF = (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); };
  const pendingAutoStartTimers = new Map<string, any>();
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const quick = !!opts.quick;
  const c = { broadcasts: 0, handResults: 0, seeds: 0, escaped: 0, credits: [] as Array<[number, number, string]>, errors: [] as string[] };
  let heartbeatTick: (() => void) | null = null;
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }] },
    MAX_SEATS, GamePhase, FiveCardDrawTable, DrawPhases: DRAWS,
    pendingAutoStartTimers, pendingSeatRemovalAfterHand,
    quickTables: new Set<string>(quick ? [T] : []), quickGames: new Map(),
    tournamentTables: new Map(), brokenTournamentTables: new Set(), playerSessions: new Map(), multiTableSessions: new Map(),
    dealersChoiceState: new Map(), clubTableIds: new Set(), privateTableIds: new Set(),
    clubTableRuntimeStats: { idleDealsSkipped: 0 }, heartbeatRestarts: { handComplete: 0 }, heartbeatRestartsWithHuman: { handComplete: 0 },
    CASH_TABLE_TARGET_OCCUPIED: 2, LIVE_ROOM_MIN_OCCUPIED: 2,
    aiProfiles: new Map(), aiTimeouts: new Map(), sitOutTracker: new Map(), reservedSeats: new Map(),
    bombPotPending: new Map<string, boolean>(opts.bombPot ? [[T, true]] : []), bombPotActive: new Map(),
    bombPotStats: { dealt: 0, refusedAtTrigger: 0, refusedAtActivation: 0 }, bombPotAllowedAt: () => true,
    ensureTableProgressListener() {}, reloadAndCapBotStacks() {}, trimExcessAI() {}, fillWithAI() {}, backfillAIToMin() {},
    noteRefusedCashStart() {}, isFixedRosterQuickTable: () => quick,
    tableHasHumanSeat: (tb: PokerTable) => tb.seats.some((s) => s.state === 'occupied' && !s.isAI),
    clearHandSnapshot: async () => {}, Sentry: null,
    broadcastGameState: () => { c.broadcasts++; }, scheduleAIAction() {}, syncSitOutToTable() {},
    isTournamentTable: () => false, isPrizeFormatTable: () => false, noteBotStackRemoved() {}, endStaleSessionsAtSeat() {},
    creditSeatStackToWallet: (userId: number, _u: string, _tid: string, seat: any, reason: string) => { c.credits.push([userId, seat.chipCount, reason]); return Promise.resolve(true); },
    log: { debug() {} },
    setTimeout: setTimeoutF, clearTimeout: clearTimeoutF,
    setInterval: (fn: () => void) => { heartbeatTick = fn; return 1; },
    console: { log() {}, warn() {}, error: (m: unknown) => c.errors.push(String(m)) },
  };
  const { exports: m, stubbed } = load(`${CODE}\n${HEARTBEAT}`, scope,
    '{ scheduleAutoStart, ensureCashTableRunning, processPendingSeatRemovals, teardownSeat, gameTimerGuardStats, gameShowdownHeld, settleDealtShowdownAfterFault }');
  // index.ts's 'handResult' listener: the pending seat removals, then the next deal.
  t.on('handResult', () => { c.handResults++; m.processPendingSeatRemovals(T); m.scheduleAutoStart(T); });
  t.on('deckSeedRevealed', () => { c.seeds++; });
  const step = (): boolean => {
    if (!jobs.length) return false;
    jobs.sort((a, b) => a.at - b.at || a.id - b.id);
    const j = jobs.shift()!;
    now = j.at;
    try { j.fn(); } catch (e) { c.escaped++; c.errors.push(`ESCAPED ${String((e as Error)?.message || e)}`); }
    return true;
  };
  const stats = () => { const s = { ...m.gameTimerGuardStats }; delete s.lastAt; return s; };
  const tagged = () => c.errors.filter((l) => l.startsWith('[game-timer-error] ')).map((l) => JSON.parse(l.slice('[game-timer-error] '.length)));
  const heartbeat = () => { try { heartbeatTick!(); } catch (e) { c.escaped++; } };
  return { m, c, stubbed, step, stats, tagged, pendingAutoStartTimers, pendingSeatRemovalAfterHand, heartbeat, jobs };
}

/** The scheduled deal (scheduleAutoStart's guarded timer) of hand 2. */
function guardedDeal(w: ReturnType<typeof world>) {
  w.m.scheduleAutoStart(T);
  expect(w.jobs).toHaveLength(1);
  expect(w.step()).toBe(true);
}

describe('SS-1 — a deal-time payout fault is settled from the pre-blind capture, never held', () => {
  it.each([[true], [false]])('(1) quick=%s: heads-up 50/50 at 50/100, awardPots throws once: RESOLVED — paid once, chips conserved, 1 broadcast, the next deal scheduled', (quick) => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick });
    const left = injectFault(t, { where: 'awardPots', times: 1 });
    guardedDeal(w);
    expect(w.c.escaped).toBe(0);
    expect(left()).toBe(0);
    expect(t.handNumber).toBe(2);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.m.gameShowdownHeld(t)).toBe(false);
    expect(stacksOnly(t)).toBe(100);                                  // paid once, nothing minted or lost
    expect(t.seats.every((s) => (s.totalInvestedThisHand || 0) === 0)).toBe(true);
    expect([[0, 100], [50, 50]]).toContainEqual(t.seats.map((s) => s.chipCount).slice(0, 2).sort((a, b) => a - b));   // a winner, or a chop
    expect(w.c.handResults).toBe(1);
    expect(w.c.seeds).toBe(1);
    expect(w.c.broadcasts).toBe(1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);              // the next deal
    expect(w.stats()).toMatchObject({ autoStartThrows: 1, showdownFaults: 1, showdownResolved: 1, showdownVoided: 0, showdownPaidFinished: 0, showdownHeld: 0, recoveryThrows: 0 });
    expect(w.tagged().map((l) => l.kind)).toEqual(['autostart', 'showdown']);
    expect(w.tagged()[1]).toMatchObject({ outcome: 'resolved', credited: 0 });
    expect([...w.stubbed]).toEqual([]);
  });

  it('(2) awardPots throws twice (the retry fails too): VOIDED — both stacks back to 50 (their stacks before the blinds), 1 handResult, the next deal scheduled', () => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick: true });
    injectFault(t, { where: 'awardPots', times: 2 });
    guardedDeal(w);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount).toBe(50);
    expect(t.seats[1].chipCount).toBe(50);
    expect(total(t)).toBe(100);
    expect(w.c.handResults).toBe(1);
    expect(w.c.broadcasts).toBe(1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.stats()).toMatchObject({ showdownFaults: 1, showdownVoided: 1, showdownResolved: 0, showdownHeld: 0 });
    expect(w.tagged().find((l) => l.kind === 'showdown')).toMatchObject({ outcome: 'voided', credited: 0 });
  });

  it('(3) buildPotBreakdown throws AFTER the payment: PAID_FINISHED — the pot is never paid twice (100 stays 100), the hand announced once', () => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick: true });
    injectFault(t, { where: 'buildPotBreakdown', times: 1 });
    guardedDeal(w);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacksOnly(t)).toBe(100);
    expect(total(t)).toBe(100);                                      // d1ec56a held 100 paid + 100 still "in the pot": a 200 flush
    expect(w.c.handResults).toBe(1);
    expect(w.c.seeds).toBe(1);                                       // hand 2's deck seed revealed exactly once
    expect(w.c.broadcasts).toBe(1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.stats()).toMatchObject({ showdownFaults: 1, showdownPaidFinished: 1, showdownResolved: 0, showdownVoided: 0, showdownHeld: 0 });
    expect(w.tagged().find((l) => l.kind === 'showdown')).toMatchObject({ outcome: 'paid_finished', credited: 100, pot: 100 });
  });

  it('(4) the human leaves after the faulted deal: stood up at once and his settled stack credited ONCE (d1ec56a: deferred to a hand end that never came)', () => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick: false });
    injectFault(t, { where: 'awardPots', times: 2 });                // voided: he gets his 50 back
    guardedDeal(w);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    const out = w.m.teardownSeat(T, t, 0, { userId: 7, username: 'human' }, 'handlePlayerLeave');
    expect(out).toBe('stood_up');
    expect(t.seats[0].state).toBe('empty');
    expect(w.c.credits).toEqual([[7, 50, 'handlePlayerLeave']]);
    expect(w.pendingSeatRemovalAfterHand.get(T)?.size ?? 0).toBe(0);
  });

  it('(5) a seat deferred INSIDE the faulted deal (a leave landing while the hand was in progress) is released by the settle\'s hand end, credited once', () => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick: false });
    injectFault(t, { where: 'awardPots', times: 2 });
    let left = false;
    t.on('handStarted', () => {
      if (left) return;
      left = true;
      // his chips are in the pot (the blind): the stand-up waits for the hand's end
      expect(w.m.teardownSeat(T, t, 0, { userId: 7, username: 'human' }, 'handlePlayerLeave')).toBe('deferred');
    });
    guardedDeal(w);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].state).toBe('empty');
    expect(w.c.credits).toEqual([[7, 50, 'leave_after_hand']]);     // the voided hand's stake, once
    expect(w.pendingSeatRemovalAfterHand.has(T)).toBe(false);
    expect(total(t) + 50).toBe(100);                                  // his 50 left with him; the bot's 50 stayed
  });

  it('(6) a BOMB POT every stack is all-in on, its runout throwing twice: VOIDED to the pre-deal stacks; a dead blind posted at the deal is owed ONCE again (never twice)', () => {
    const t = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
    for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 5000, i === 0 ? 'player-h' : `ai-${i}`, i !== 0, true);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 60 && t.isHandInProgress(); g++) { const a = t.activeSeatIndex; if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a); }
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    const before = [150, 150, 300];
    for (let i = 0; i < 3; i++) {
      t.seats[i].chipCount = before[i];
      // every seat owes a dead big blind: the one that is neither blind posts it at the deal
      // (refunded by the bomb pot, owed again); the big blind's live blind settles its debt (F5).
      (t.seats[i] as any).missedBlind = 'big';
      (t.seats[i] as any).deadBlindOwedChips = 100;
    }
    const w0 = world(t, { bombPot: true });
    injectFault(t, { where: 'awardPots', times: 2 });
    let deadSeat = -1;
    t.on('handStarted', () => {
      for (const s of t.seats) if (s.state === 'occupied' && (s.deadMoneyThisHand || 0) > 0) deadSeat = s.seatIndex;
    });
    w0.m.scheduleAutoStart(T);
    w0.step();
    expect(w0.c.escaped).toBe(0);
    expect(deadSeat).toBeGreaterThanOrEqual(0);                      // a dead blind really was posted at this deal
    expect(w0.m.gameTimerGuardStats.showdownFaults).toBe(1);         // the bomb pot's runout faulted
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats.slice(0, 3).map((s) => s.chipCount)).toEqual(before);
    expect(total(t)).toBe(600);
    expect(t.seats[deadSeat].deadBlindOwedChips).toBe(100);          // owed again ONCE (applyBombPot and the void both restore it)
    expect(t.seats[deadSeat].missedBlind).not.toBe('none');
    expect(w0.stats()).toMatchObject({ showdownVoided: 1, showdownHeld: 0 });
    expect(w0.c.handResults).toBe(1);
    expect(w0.pendingAutoStartTimers.has(T)).toBe(true);
  });

  it('(7) the HEARTBEAT\'s own deal (a ring table resting in HandComplete, no deal pending) is settled too — it used to rest un-held, where the wedge watchdog re-ran the payout', () => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick: false });
    injectFault(t, { where: 'buildPotBreakdown', times: 1 });        // paid, then the throw
    w.heartbeat();
    expect(w.c.escaped).toBe(0);
    expect(t.handNumber).toBe(2);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacksOnly(t)).toBe(100);
    expect(total(t)).toBe(100);
    expect(w.c.handResults).toBe(1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.stats()).toMatchObject({ heartbeatThrows: 1, showdownPaidFinished: 1, showdownHeld: 0 });
  });

  it('(8) CONTROL — no pre-blind capture (startChips empty): HELD as before, and the wedge watchdog never advances it', () => {
    const t = headsUp(50, 100, [50, 50]);
    const w = world(t, { quick: true });
    injectFault(t, { where: 'awardPots', times: 2 });
    // the engine's capture is lost before the settle reads it (as for a table restored without one)
    t.on('handStarted', () => { t.startChips = new Map(); });
    guardedDeal(w);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(w.m.gameShowdownHeld(t)).toBe(true);
    expect(w.stats()).toMatchObject({ showdownHeld: 1, showdownFaults: 0 });
    expect(total(t)).toBe(100);
    let tick: (() => void) | null = null;
    let wnow = 2_000_000;
    let advanced = 0;
    const realAdvance = (t as any).advanceTurn.bind(t);
    (t as any).advanceTurn = () => { advanced++; return realAdvance(); };
    load(WATCHDOG, {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }] },
      GamePhase, DrawPhases: DRAWS, gameShowdownHeld: w.m.gameShowdownHeld,
      turnTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(), turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(),
      TURN_TIMEOUT_MS: 30000, broadcastGameState() {}, scheduleAIAction() {},
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      Date: class FakeDate extends Date { static now() { return wnow; } },
      console: { log() {}, warn() {}, error() {} },
    }, '{}');
    for (let i = 0; i < 5; i++) { wnow += 15_000; tick!(); }
    expect(advanced).toBe(0);
    expect(total(t)).toBe(100);
  });
});

describe('SS-1 — the pre-blind capture is each dealt seat\'s stake through the deal (chipCount + totalInvestedThisHand === startChips)', () => {
  const invariant = (t: PokerTable) => {
    const bad: string[] = [];
    for (const s of t.seats) {
      if (s.state !== 'occupied' || !t.startChips.has(s.seatIndex)) continue;
      const sum = s.chipCount + (s.totalInvestedThisHand || 0);
      if (sum !== t.startChips.get(s.seatIndex)) bad.push(`${s.seatIndex}:${sum}!=${t.startChips.get(s.seatIndex)}`);
    }
    return bad;
  };
  it('blinds, antes, a dead blind, a bomb pot, a UTG straddle and a Stud bring-in only move chips between the two fields of the same seat', () => {
    // antes + blinds + a dead big blind, 5-handed
    const t = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 10, minBuyIn: 100 } as any);
    for (let i = 0; i < 5; i++) t.sitDown(i, `P${i}`, 2000 + i * 37, `ai-${i}`, true, true);
    (t.seats[3] as any).missedBlind = 'big'; (t.seats[3] as any).deadBlindOwedChips = 100;
    expect(t.startNewHand()).toBe(true);
    expect(invariant(t)).toEqual([]);
    expect(t.seats.some((s) => (s.deadMoneyThisHand || 0) > 0 || (s.totalInvestedThisHand || 0) === 10)).toBe(true);
    // the bomb pot on top of that deal (refund + equal antes + the flop)
    expect(t.applyBombPot(200)).toBe(true);
    expect(invariant(t)).toEqual([]);

    // a UTG straddle, then calls
    const s2 = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
    for (let i = 0; i < 4; i++) s2.sitDown(i, `P${i}`, 3000, `ai-${i}`, true, true);
    expect(s2.startNewHand()).toBe(true);
    expect(s2.straddle(s2.activeSeatIndex)).toBe(true);
    expect(invariant(s2)).toEqual([]);
    for (let g = 0; g < 3; g++) s2.playerCall(s2.activeSeatIndex);
    expect(invariant(s2)).toEqual([]);

    // Seven Card Stud: antes + the bring-in
    const st = new SevenStudTable({ tableId: T, tableName: T, smallBlind: 10, bigBlind: 20, ante: 5, minBuyIn: 100 } as any, false, false);
    for (let i = 0; i < 4; i++) st.sitDown(i, `P${i}`, 1000, `ai-${i}`, true, true);
    expect(st.startNewHand()).toBe(true);
    expect(invariant(st)).toEqual([]);
  });
});

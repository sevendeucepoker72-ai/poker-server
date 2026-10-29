/**
 * 2026-10-28 (error sweep, game-server: "cash tables still freeze in
 * HandComplete and are only revived by the 12 s heartbeat") — when
 * autoStartNextHand's startNewHand() REFUSES the deal on a ring CASH table,
 * noteRefusedCashStart logs ONE structured line (`cash_hand_start_refused`:
 * occupied / withChips / active / sittingOut / humans + the refusal kind) per
 * refusal streak and RESCHEDULES the step (1.5 s, then every 3 s) while the
 * heartbeat would revive the table too. Before, nothing was logged or
 * scheduled: the table rested in HandComplete until the 12 s heartbeat ran the
 * step again (heartbeatRestarts.handComplete, "should stay ~0", read 29).
 *  - The deal itself is unchanged (autoStartNextHand / startNewHand).
 *  - An emptied table (fewer than 2 seated) is NOT rescheduled: the heartbeat
 *    re-seeds it, as before, and only that path counts it.
 *  - Tournament and fixed-roster quick tables: never.
 *  - heartbeatRestartsWithHuman: the heartbeat revivals of a table a human sits at.
 *  - Review fixes 2026-10-28: a table that stops being one the heartbeat keeps
 *    running ends the streak (the next episode logs its first line); an emptied
 *    table with no human is counted (`emptied`) but not logged.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { generateRandomProfile } from '../src/ai/AIPlayer';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const T = 'cash-1';

const AUTO_START = fnSrc('function autoStartNextHand(');
const REFUSED = slice('const CASH_START_RETRY_FIRST_MS = 1500;', '\n}\n');
const CODE = [
  slice('const LIVE_ROOM_MIN_OCCUPIED = 3;', 'const heartbeatRestarts = { handComplete: 0 };'),
  slice('const heartbeatRestartsWithHuman = ', ';\n'),
  fnSrc('function backfillAIToMin('),
  fnSrc('function ensureCashTableRunning('),
  fnSrc('function trimExcessAI('),
  fnSrc('function fillWithAI('),
  fnSrc('function aiSeatsMutableNow('),
  fnSrc('function tableHasHumanSeat('),
  slice('const BOT_STACK_CAP_BUYINS: number = ', '  return isFixedRosterTable(tableId);\n}\n'),
  fnSrc('function isFixedRosterTable('),
  AUTO_START,
  REFUSED,
].join('\n');

/** autoStartNextHand exactly as it was before 2026-10-28 (no refused-deal branch). */
const AUTO_START_PRE_FIX = AUTO_START.replace(
  /\n {2}\} else if \(!tId\) \{\n(?: {4}\/\/.*\n)* {4}noteRefusedCashStart\(tableId, table\);\n {2}\}\n\}\n$/,
  '\n  }\n}\n',
);

const playOut = (t: PokerTable) => {
  let g = 0;
  while (t.isHandInProgress() && g++ < 200) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
};

function world(opts: { code?: string; tournament?: boolean; quick?: boolean; privateTable?: boolean; seatCap?: number } = {}) {
  const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
  if (opts.seatCap) table.maxOccupiableSeats = opts.seatCap;
  const pendingAutoStartTimers = new Map<string, NodeJS.Timeout>();
  const logs: string[] = [];
  const quickTables = new Set<string>(opts.quick ? [T] : []);
  const privateTableIds = new Set<string>(opts.privateTable ? [T] : []);
  const tournamentTables = new Map<string, string>(opts.tournament ? [[T, 'TOURN-1']] : []);
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
    pendingAutoStartTimers, quickTables, privateTableIds, careerTables: new Map(), spinGoMultipliers: new Map(),
    allInOrFoldTables: new Set(), challengeTables: new Map(), tournamentTables, brokenTournamentTables: new Map(),
    isTournamentTable: (id: string) => tournamentTables.has(id), aiProfiles: new Map(), playerSessions: new Map(), multiTableSessions: new Map(),
    dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], tournamentManager: { getTournament: () => undefined },
    tournamentDealWaitsForBustCheck: () => false, tournamentBreaksAwaitingHandEnd: new Map(), planTournamentRebalance: () => null,
    handForHandHoldsDeal: () => false, feedLoneQualifierTable: () => true, balanceQualifierTables: () => false,
    CASH_TABLE_TARGET_OCCUPIED: 5, MAX_SEATS, GamePhase, generateRandomProfile, uuidv4: () => Math.random().toString(36).slice(2),
    ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {}, activateBombPotIfPending() {},
    log: { debug() {}, info() {} },
    console: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`), error: (m: string) => logs.push(`ERR ${m}`) },
  };
  const { exports: m, stubbed } = load(opts.code ?? CODE, scope,
    '{ autoStartNextHand, ensureCashTableRunning, noteRefusedCashStart, heartbeatRestarts, heartbeatRestartsWithHuman, cashStartRefusals }');
  const refusedLines = () => logs.filter((l) => l.includes('cash_hand_start_refused')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  return { table, m, stubbed, logs, refusedLines, pendingAutoStartTimers };
}

/** A 2-seat home game: A and B play a hand to its end, then B sits out (nothing else can be seated). */
function homeGameAfterHand(w: ReturnType<typeof world>) {
  w.table.sitDown(0, 'Alice', 5000, 'h-a', false);
  w.table.sitDown(1, 'Bob', 5000, 'h-b', false);
  expect(w.table.startNewHand()).toBe(true);
  playOut(w.table);
  expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
  w.table.setSittingOutSeats([1]);
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('a refused cash deal is logged once and re-tried — not left to the 12 s heartbeat', () => {
  it('the harness slices everything it relies on (nothing silently stubbed)', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    homeGameAfterHand(w);
    w.m.autoStartNextHand(T);
    expect([...w.stubbed].filter((s) => /noteRefusedCashStart|cashStart|sittingOut|privateTableIds|pendingAutoStart|tableHasHumanSeat/.test(s))).toEqual([]);
  });

  it('home game, one player sitting out: ONE structured line with the counts, the step re-tried (1.5 s, then 3 s), dealt within 3 s of him sitting back in', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    homeGameAfterHand(w);
    const hand = w.table.handNumber;
    w.m.autoStartNextHand(T);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);                // refused: 1 active
    expect(w.refusedLines()).toEqual([{
      event: 'cash_hand_start_refused', tableId: T, handNumber: hand, streak: 1, reason: 'fewer_than_2_active',
      occupied: 2, withChips: 2, active: 1, sittingOut: 1, humans: 2, retryInMs: 1500,
    }]);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);                       // pre-fix: nothing scheduled
    jest.advanceTimersByTime(1500);                                           // re-tried: still refused
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.refusedLines()).toHaveLength(1);                                 // one line per streak
    expect(w.m.cashStartRefusals).toEqual({ refused: 2, rescheduled: 2, notRescheduled: 0, emptied: 0 });
    w.table.setSittingOutSeats([]);                                           // Bob is back
    jest.advanceTimersByTime(3000);
    expect(w.table.isHandInProgress()).toBe(true);                            // dealt by the re-try
    expect(w.table.handNumber).toBe(hand + 1);
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    expect(w.m.heartbeatRestarts.handComplete).toBe(0);                       // the heartbeat never had to
  });

  it('CONTROL — pre-fix autoStartNextHand: refused silently, nothing scheduled; only the heartbeat deals (and counts it)', () => {
    expect(AUTO_START_PRE_FIX).not.toBe(AUTO_START);
    expect(AUTO_START_PRE_FIX).not.toContain('noteRefusedCashStart');
    const w = world({ privateTable: true, seatCap: 2, code: CODE.replace(AUTO_START, AUTO_START_PRE_FIX) });
    homeGameAfterHand(w);
    w.m.autoStartNextHand(T);
    expect(w.refusedLines()).toEqual([]);
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    w.table.setSittingOutSeats([]);
    jest.advanceTimersByTime(11_000);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);               // still frozen
    w.m.ensureCashTableRunning(T);                                            // the 12 s heartbeat
    expect(w.table.isHandInProgress()).toBe(true);
    expect(w.m.heartbeatRestarts.handComplete).toBe(1);
    expect(w.m.heartbeatRestartsWithHuman.handComplete).toBe(1);              // a player waited
  });

  it('while a re-try is pending the heartbeat does not count a revival', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    homeGameAfterHand(w);
    w.m.autoStartNextHand(T);
    w.m.ensureCashTableRunning(T);
    expect(w.m.heartbeatRestarts.handComplete).toBe(0);
    expect(w.m.heartbeatRestartsWithHuman.handComplete).toBe(0);
  });

  it('a long streak logs again every 100th refusal; a dealt hand starts a new streak', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    homeGameAfterHand(w);
    for (let k = 0; k < 100; k++) w.m.autoStartNextHand(T);                   // direct calls (client Auto Deal) while a re-try is pending
    expect(w.refusedLines().map((l) => l.streak)).toEqual([1, 100]);
    expect(w.m.cashStartRefusals).toEqual({ refused: 100, rescheduled: 1, notRescheduled: 99, emptied: 0 });   // a pending start never ends the streak
    w.table.setSittingOutSeats([]);
    jest.advanceTimersByTime(1500);
    expect(w.table.isHandInProgress()).toBe(true);
    playOut(w.table);
    w.table.setSittingOutSeats([1]);
    w.m.autoStartNextHand(T);
    expect(w.refusedLines().map((l) => l.streak)).toEqual([1, 100, 1]);
    expect(w.refusedLines()[2].retryInMs).toBe(1500);
  });

  it('busted human (0 chips, never reloaded) + one stack: withChips 1, re-tried; dealt once he rebuys', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    w.table.sitDown(0, 'Alice', 5000, 'h-a', false);
    w.table.sitDown(1, 'Bob', 5000, 'h-b', false);
    expect(w.table.startNewHand()).toBe(true);
    playOut(w.table);
    w.table.seats[1].chipCount = 0;                                           // Bob busted (cash: no free reload)
    w.m.autoStartNextHand(T);
    expect(w.refusedLines()[0]).toMatchObject({ occupied: 2, withChips: 1, active: 1, sittingOut: 0, humans: 2, retryInMs: 1500 });
    expect(w.table.seats[1].chipCount).toBe(0);                               // chips untouched
    w.table.seats[1].chipCount = 1000;                                        // his rebuy (wallet path, not modelled)
    jest.advanceTimersByTime(1500);
    expect(w.table.isHandInProgress()).toBe(true);
  });

  it('an EMPTIED public table (last human left, bots stripped): counted as emptied, NOT logged, NOT rescheduled; the heartbeat re-seeds it as before (not a human revival)', () => {
    const w = world();
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    expect(w.table.startNewHand()).toBe(true);
    playOut(w.table);
    for (let i = 0; i < 3; i++) w.table.standUp(i);
    w.m.autoStartNextHand(T);
    expect(w.refusedLines()).toEqual([]);                                     // benign: no noise on the freeze line
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    expect(w.m.cashStartRefusals).toEqual({ refused: 1, rescheduled: 0, notRescheduled: 1, emptied: 1 });
    w.m.ensureCashTableRunning(T);
    expect(w.table.isHandInProgress()).toBe(true);
    expect(w.m.heartbeatRestarts.handComplete).toBe(1);
    expect(w.m.heartbeatRestartsWithHuman.handComplete).toBe(0);
  });

  it('a private table nobody sits at is not kept running (ensureCashTableRunning\'s rule): no re-try; emptied, not logged', () => {
    const w = world({ privateTable: true });
    w.table.sitDown(0, 'BotA', 5000, 'ai-a', true);
    w.table.sitDown(1, 'BotB', 5000, 'ai-b', true);
    expect(w.table.startNewHand()).toBe(true);
    playOut(w.table);
    w.table.seats[1].chipCount = 0;
    w.m.noteRefusedCashStart(T, w.table);
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    expect(w.refusedLines()).toEqual([]);
    expect(w.m.cashStartRefusals).toEqual({ refused: 1, rescheduled: 0, notRescheduled: 1, emptied: 1 });
  });

  it('a NEW refusal episode with no deal in between logs its first line (B sits out, leaves; C joins and sits out)', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    homeGameAfterHand(w);
    const hand = w.table.handNumber;
    w.m.autoStartNextHand(T);                                                 // episode 1: Bob sitting out
    expect(w.refusedLines().map((l) => [l.streak, l.occupied, l.retryInMs])).toEqual([[1, 2, 1500]]);
    w.table.standUp(1);                                                       // Bob leaves; Alice alone
    jest.advanceTimersByTime(1500);                                           // the re-try: refused, nothing to deal
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);                      // not kept: not rescheduled
    expect(w.refusedLines()).toHaveLength(1);                                 // (streak 2 of episode 1: not logged)
    w.table.sitDown(1, 'Cara', 5000, 'h-c', false);                           // Cara joins and sits out
    w.table.setSittingOutSeats([1]);
    w.m.autoStartNextHand(T);                                                 // her join's start
    expect(w.table.handNumber).toBe(hand);                                    // still no deal in between
    expect(w.refusedLines().map((l) => [l.streak, l.occupied, l.sittingOut, l.retryInMs])).toEqual([[1, 2, 1, 1500], [1, 2, 1, 1500]]);
    // Pre-review: the streak ran on from episode 1 -> streak 3, no line until the 100th.
    expect(w.m.cashStartRefusals).toEqual({ refused: 3, rescheduled: 2, notRescheduled: 1, emptied: 0 });
    w.table.setSittingOutSeats([]);                                           // Cara sits in
    jest.advanceTimersByTime(1500);
    expect(w.table.isHandInProgress()).toBe(true);
  });

  it('tournament and fixed-roster quick tables: never (their own flows own the deal)', () => {
    for (const o of [{ tournament: true }, { quick: true }]) {
      const w = world(o);
      w.table.sitDown(0, 'A', 5000, 'h-a', false);
      w.table.sitDown(1, 'B', 5000, 'h-b', false);
      expect(w.table.startNewHand()).toBe(true);
      playOut(w.table);
      w.table.setSittingOutSeats([1]);
      w.m.noteRefusedCashStart(T, w.table);
      if (o.tournament) w.m.autoStartNextHand(T);
      expect(w.refusedLines()).toEqual([]);
      expect(w.pendingAutoStartTimers.has(T)).toBe(false);
      expect(w.m.cashStartRefusals.refused).toBe(0);
    }
  });

  it('an already-pending start is never doubled', () => {
    const w = world({ privateTable: true, seatCap: 2 });
    homeGameAfterHand(w);
    const existing = setTimeout(() => {}, 60_000);
    w.pendingAutoStartTimers.set(T, existing);
    w.m.autoStartNextHand(T);
    expect(w.pendingAutoStartTimers.get(T)).toBe(existing);
    expect(w.refusedLines()[0].retryInMs).toBeNull();
  });

  it('wiring: only the cash branch of autoStartNextHand calls it; the deal path and the health counters are in place', () => {
    expect(AUTO_START).toContain('} else if (!tId) {');
    expect(AUTO_START).toContain('noteRefusedCashStart(tableId, table);');
    expect(SRC).toContain('heartbeatRestarts.handComplete++;');              // canonical-features lock
    expect(SRC).toContain('cashStartRefusals: { ...cashStartRefusals },');
    expect(SRC).toContain('handCompleteWithHuman: heartbeatRestartsWithHuman.handComplete');
  });
});

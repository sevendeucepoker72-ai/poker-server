/**
 * .online R2 (2026-10-11) — S2 table lifecycle, running the REAL src/index.ts
 * text (sliced + transpiled — index.ts boots a server on import) against the
 * REAL PokerTable engine:
 *   GAME-15 + Addendum  ONE seat teardown (teardownSeat): chips in a live pot
 *           (a FOLDED seat's too) wait for the hand's end; an ALL-IN leaver keeps
 *           his hand (and an accepted insurance its settlement); never an AI
 *           seat taken mid-hand (takeAiSeatForJoin)
 *   GAME-16 every fold / leave path hands the turn on (scheduleAIAction), a
 *           draw round completes, a hand left with one player is awarded
 *   GAME-17 bots are stripped only at the hand's end; the heartbeat revives a
 *           HandComplete table nothing will deal
 *   GAME-18 bot stacks uncapped by default (owner 2026-10-24); the
 *           BOT_STACK_CAP_BUYINS env turns the reset back on; reloads skipped
 *           on fixed-roster quick tables
 *   APPUI-21 a second departure of the same account never strands the first
 *           reservation's seat
 * Each has a CONTROL that reproduces the pre-R2 behaviour.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { insuranceSettlementDelta } from '../src/game/insurance';
import { generateRandomProfile } from '../src/ai/AIPlayer';
import { SRC, slice, fnSrc, load, flush, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const T = 'cash-1';
const quiet = { log() {}, warn() {}, error() {} };
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];

/** The teardown helpers + processPendingSeatRemovals + settleInsuranceForHand on one real table. */
function teardownWorld(mk: () => PokerTable = () => new PokerTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any), extraScope: Record<string, unknown> = {}) {
  const table = mk();
  const credits: Array<{ userId: number; chips: number; reason: string }> = [];
  const scheduled: string[] = [];
  const audits: Array<{ action: string; d: any }> = [];
  const insuranceCashouts = new Map<string, any[]>();
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
    pendingSeatRemovalAfterHand, sitOutTracker: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(),
    pendingAutoStartTimers: new Map(), insuranceCashouts, playerSessions: new Map(), multiTableSessions: new Map(),
    authSessions: new Map(),
    creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ userId, chips: seat.chipCount, reason }),
    scheduleAIAction: (id: string) => scheduled.push(id),
    syncSitOutToTable() {}, broadcastGameState() {},
    auditLog: (_a: string, action: string, d: any) => audits.push({ action, d }),
    insuranceStats: { settled: 0, voided: 0 }, insuranceSettlementDelta,
    io: { sockets: { sockets: new Map() } },
    DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    ...extraScope,
  };
  const code = fnSrc('function processPendingSeatRemovals(') + SEAT_TEARDOWN_SRC + fnSrc('function settleInsuranceForHand(')
    + fnSrc('function seatPlayedByAnotherAccount(');
  const { exports: m } = load(code, scope,
    '{ teardownSeat, processPendingSeatRemovals, settleInsuranceForHand, takeAiSeatForJoin, aiSeatTakeableNow, stripBotsWhenNoHumans, stripBotsAfterHandIfMarked, botStripAfterHand, seatTeardownStats }');
  // The handResult listener's order: the insurance settlement (handleHandComplete), then the deferred stand-ups.
  table.on('handResult', (d: any) => {
    const won = new Map<number, number>();
    for (const r of d.results) won.set(r.seatIndex, (won.get(r.seatIndex) || 0) + r.amount);
    m.settleInsuranceForHand(T, table, won);
    m.processPendingSeatRemovals(T);
  });
  const chipsOnTable = () => table.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (table.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0);
  const credited = () => credits.reduce((s, c) => s + c.chips, 0);
  return { table, m, credits, scheduled, audits, insuranceCashouts, pendingSeatRemovalAfterHand, chipsOnTable, credited };
}

const playOut = (t: PokerTable) => {
  let g = 0;
  while (t.isHandInProgress() && g++ < 200) {
    if (DRAWS.includes(t.currentPhase)) {
      const d = t as FiveCardDrawTable;
      // gameplay S3 F27 (2026-10-21): an all-in seat draws too (the engine waits for it).
      for (const s of d.seats) if (s.state === 'occupied' && !s.folded && s.holeCards.length > 0 && !d.drawsCompleted.has(s.seatIndex)) d.playerDraw(s.seatIndex, []);
      continue;
    }
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
};

describe('GAME-15 — a FOLDED leaver\'s chips stay in the pot until the hand ends', () => {
  function foldedSmallBlind(w: ReturnType<typeof teardownWorld>) {
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    w.table.startNewHand();
    const sb = w.table.seats.findIndex((s) => s.currentBet === 25);
    let g = 0;
    while (w.table.activeSeatIndex !== sb && g++ < 5) w.table.playerCall(w.table.activeSeatIndex);
    expect(w.table.playerFold(sb)).toBe(true);
    expect(w.table.isHandInProgress()).toBe(true);
    return sb;
  }

  it('teardownSeat defers the stand-up; the pot keeps the 25; at the hand\'s end the stack is credited ONCE; nothing destroyed', () => {
    const w = teardownWorld();
    const sb = foldedSmallBlind(w);
    expect(w.m.teardownSeat(T, w.table, sb, { userId: 7, username: 'u7' }, 'leave')).toBe('deferred');
    expect(w.table.seats[sb].state).toBe('occupied');
    expect(w.credits).toEqual([]);
    playOut(w.table);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.table.seats[sb].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 7, chips: 4975, reason: 'leave_after_hand' }]);
    expect(w.chipsOnTable() + w.credited()).toBe(15000);
  });

  it('CONTROL — the pre-R2 leave stood a folded seat up at once: its blind left the pot (chips destroyed)', () => {
    const w = teardownWorld();
    const sb = foldedSmallBlind(w);
    w.credits.push({ userId: 7, chips: w.table.seats[sb].chipCount, reason: 'handlePlayerLeave' });
    w.table.standUp(sb);                                         // the old non-deferred branch
    playOut(w.table);
    expect(w.chipsOnTable() + w.credited()).toBe(15000 - 25);
  });
});

describe('Addendum — an ALL-IN player leaving during the insurance hold does not forfeit', () => {
  function heldAllIn(w: ReturnType<typeof teardownWorld>) {
    w.table.sitDown(0, 'Ins', 3000, 'p-ins', false);
    w.table.sitDown(1, 'Opp', 9000, 'p-opp', false);
    w.table.runoutHoldDecider = () => true;                     // index.ts holds for the insurance window
    w.table.startNewHand();
    let g = 0;
    while (!w.table.seats[0].allIn && g++ < 5) {
      const a = w.table.activeSeatIndex;
      if (a === 0) w.table.playerAllIn(0); else w.table.playerCall(a) || w.table.playerCheck(a);
    }
    g = 0;
    while (!w.table.isRunoutHeld() && w.table.isHandInProgress() && g++ < 5) w.table.playerCall(w.table.activeSeatIndex);
    expect(w.table.isRunoutHeld()).toBe(true);
    // He accepted the quote (R1: the record the settlement uses).
    w.insuranceCashouts.set(T, [{ seatIndex: 0, playerId: 'p-ins', cashout: 2500, handNumber: w.table.handNumber, equityPct: 50, pot: 6000 }]);
  }

  it('his seat stays IN the hand (not folded); the board runs out; the insurance SETTLES (not voided); his final stack is credited once', () => {
    const w = teardownWorld();
    heldAllIn(w);
    expect(w.m.teardownSeat(T, w.table, 0, { userId: 7, username: 'u7' }, 'leave')).toBe('deferred');
    expect(w.table.seats[0].folded).toBe(false);
    expect(w.table.releaseRunoutHold()).toBe(true);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.table.wentToShowdown).toBe(true);                  // he contested the pot
    expect(w.audits.map((a) => a.action)).toEqual([expect.stringMatching(/^INSURANCE_(PAYOUT|COLLECT)$/)]);
    expect(w.credits).toEqual([{ userId: 7, chips: 2500, reason: 'leave_after_hand' }]);   // exactly his cashout
    expect(w.table.seats[0].state).toBe('empty');
  });

  it('CONTROL — the pre-R2 leave force-folded him: the opponent took the pot uncontested and the insurance was VOIDED', () => {
    const w = teardownWorld();
    heldAllIn(w);
    w.table.forceFoldSeat(0);                                    // the old deferred-leave fold
    w.table.releaseRunoutHold();
    expect(w.table.wentToShowdown).toBe(false);
    expect(w.audits).toEqual([expect.objectContaining({ action: 'INSURANCE_VOID', d: expect.objectContaining({ reason: 'forfeited' }) })]);
  });
});

describe('R3 (S2-1) — the COVERING caller leaving during the insurance hold keeps his hand too', () => {
  /** The teardown condition before R3: only the ALL-IN seat kept its hand. */
  const PRE_R3 = 'if (seat.allIn && leaverKeepsAllInHand(tableId)) {';
  const R3 = 'if ((seat.allIn || table.isRunoutHeld()) && leaverKeepsAllInHand(tableId)) {';
  const ring = { isTournamentTable: () => false, isFixedRosterQuickTable: () => false };

  /**
   * Heads-up cash: the shover (seat 0, 3000, 7c 2s) is all-in, the caller
   * (seat 1, 9000, Ah Ad) called — 3000 each in the pot, 6000 behind him, the
   * runout HELD for the shover's insurance window. The board is rigged
   * (Kh 9d 4c 3s Jh): aces win.
   */
  function heldCoveringCall(w: ReturnType<typeof teardownWorld>, insureShover = false) {
    w.table.sitDown(0, 'Shover', 3000, 'p-short', false);
    w.table.sitDown(1, 'Caller', 9000, 'p-cover', false);
    w.table.runoutHoldDecider = () => true;                     // index.ts holds for the insurance window
    w.table.startNewHand();
    let g = 0;
    while (!w.table.seats[0].allIn && g++ < 6) {
      const a = w.table.activeSeatIndex;
      if (a === 0) w.table.playerAllIn(0); else w.table.playerCall(a) || w.table.playerCheck(a);
    }
    w.table.seats[0].holeCards = [{ rank: 7, suit: 2 }, { rank: 2, suit: 3 }] as any;
    w.table.seats[1].holeCards = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }] as any;
    const deck = (w.table as any).deck;
    const dealOne = deck.dealOne.bind(deck);
    const runout = [[5, 0], [13, 0], [9, 1], [4, 2], [6, 0], [3, 3], [8, 0], [11, 0]].map(([rank, suit]) => ({ rank, suit }));
    deck.dealOne = () => (runout.length ? runout.shift() : dealOne());   // burn, flop, burn, turn, burn, river
    g = 0;
    while (!w.table.isRunoutHeld() && w.table.isHandInProgress() && g++ < 6) w.table.playerCall(w.table.activeSeatIndex);
    expect(w.table.isRunoutHeld()).toBe(true);
    expect(w.table.seats[1].allIn).toBe(false);
    expect(w.table.seats[1].chipCount).toBe(6000);
    expect(w.table.activeSeatIndex).toBe(-1);                  // nobody can be asked to act
    if (insureShover) {
      w.insuranceCashouts.set(T, [{ seatIndex: 0, playerId: 'p-short', cashout: 900, handNumber: w.table.handNumber, equityPct: 15, pot: 6000 }]);
    }
  }

  it('wiring: the teardown keeps a seat when it is all-in OR the runout is held', () => {
    expect(SEAT_TEARDOWN_SRC).toContain(R3);
    expect(SEAT_TEARDOWN_SRC).not.toContain(PRE_R3);
  });

  it('the covering seat stays IN the hand; the board runs out; the aces win the 6000; his final stack (12,000) is credited once', () => {
    const w = teardownWorld(undefined, ring);
    heldCoveringCall(w);
    expect(w.m.teardownSeat(T, w.table, 1, { userId: 21, username: 'u21' }, 'leave')).toBe('deferred');
    expect(w.table.seats[1].folded).toBe(false);
    expect(w.table.isRunoutHeld()).toBe(true);                 // the window goes on for the shover
    expect(w.table.releaseRunoutHold()).toBe(true);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.table.wentToShowdown).toBe(true);
    expect(w.credits).toEqual([{ userId: 21, chips: 12000, reason: 'leave_after_hand' }]);
    expect(w.table.seats[1].state).toBe('empty');
    expect(w.chipsOnTable() + w.credited()).toBe(12000);       // nothing created or destroyed
  });

  it('the shover insured: the insurance SETTLES against the real result (a payout), and the leaver is still paid his 12,000', () => {
    const w = teardownWorld(undefined, ring);
    heldCoveringCall(w, true);
    expect(w.m.teardownSeat(T, w.table, 1, { userId: 21, username: 'u21' }, 'leave')).toBe('deferred');
    w.table.releaseRunoutHold();
    expect(w.audits).toEqual([expect.objectContaining({ action: 'INSURANCE_PAYOUT', d: expect.objectContaining({ delta: 900 }) })]);
    expect(w.credits).toEqual([{ userId: 21, chips: 12000, reason: 'leave_after_hand' }]);
  });

  it('a tournament seat is still folded out (no wallet chips) — the hold never happens there, the rule stays ring-only', () => {
    const w = teardownWorld(undefined, { isTournamentTable: () => true, isFixedRosterQuickTable: () => false });
    heldCoveringCall(w);
    w.m.teardownSeat(T, w.table, 1, null, 'admin_kick');
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);  // folded out: awarded at once, uncontested
    expect(w.table.wentToShowdown).toBe(false);
    expect(w.table.lastHandResult?.winners.map((x: any) => [x.seatIndex, x.chipsWon])).toEqual([[0, 6000]]);
  });

  it('CONTROL — pre-R3 (only seat.allIn kept): the covering caller was folded; the 72o took the 6000 "by fold"; he got only his 6000 behind', () => {
    const w = teardownWorld(undefined, ring);
    heldCoveringCall(w);
    const code = SEAT_TEARDOWN_SRC.replace(R3, PRE_R3);
    expect(code).not.toBe(SEAT_TEARDOWN_SRC);
    const { exports: old } = load(code, {
      pendingSeatRemovalAfterHand: w.pendingSeatRemovalAfterHand, sitOutTracker: new Map(), scheduleAIAction() {}, syncSitOutToTable() {},
      creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => w.credits.push({ userId, chips: seat.chipCount, reason }),
      ...ring, DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    }, '{ teardownSeat }');
    expect(old.teardownSeat(T, w.table, 1, { userId: 21, username: 'u21' }, 'leave')).toBe('deferred');
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);  // folded: awarded at once, uncontested
    expect(w.table.wentToShowdown).toBe(false);
    expect(w.table.lastHandResult?.winners.map((x: any) => [x.seatIndex, x.chipsWon])).toEqual([[0, 6000]]);
    expect(w.credits).toEqual([{ userId: 21, chips: 6000, reason: 'leave_after_hand' }]);
  });
});

describe('GAME-16 — every teardown hands the turn on; a draw round completes; a lone player is paid at once', () => {
  it('a leaver ON his turn: folded, and scheduleAIAction runs (the next bot acts now, not after its 30s clock)', () => {
    const w = teardownWorld();
    w.table.sitDown(0, 'Human', 5000, 'h', false);
    w.table.sitDown(1, 'Bot1', 5000, 'ai-1', true);
    w.table.sitDown(2, 'Bot2', 5000, 'ai-2', true);
    w.table.startNewHand();
    let g = 0;
    while (w.table.activeSeatIndex !== 0 && g++ < 5) w.table.playerCall(w.table.activeSeatIndex) || w.table.playerCheck(w.table.activeSeatIndex);
    expect(w.table.activeSeatIndex).toBe(0);
    w.m.teardownSeat(T, w.table, 0, { userId: 7, username: 'u7' }, 'leave');
    expect(w.table.seats[0].folded || w.table.seats[0].state === 'empty').toBe(true);
    expect(w.scheduled).toContain(T);
    expect(w.table.seats[w.table.activeSeatIndex]?.isAI).toBe(true);
  });

  it('a leaver during a DRAW round who had not drawn: the round no longer waits for him', () => {
    const w = teardownWorld(() => new FiveCardDrawTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any, false));
    const t = w.table as FiveCardDrawTable;
    for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    t.startNewHand();
    let g = 0;
    while (t.currentPhase === GamePhase.PreFlop && g++ < 10) t.playerCall(t.activeSeatIndex) || t.playerCheck(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    t.playerDraw(0, []);
    t.playerDraw(1, []);
    expect(w.m.teardownSeat(T, t, 2, { userId: 7, username: 'u7' }, 'leave')).toBe('deferred');   // he posted / called
    expect(t.currentPhase).toBe(GamePhase.Bet2);
    playOut(t);
    expect(w.credits).toEqual([{ userId: 7, chips: 4950, reason: 'leave_after_hand' }]);
    expect(w.chipsOnTable() + w.credited()).toBe(15000);
  });

  it('the last opponent leaves out of turn: the remaining player is paid at once (no need to call the leaver\'s bet)', () => {
    const w = teardownWorld();
    w.table.sitDown(0, 'A', 5000, 'a', false);
    w.table.sitDown(1, 'B', 5000, 'b', false);
    w.table.sitDown(2, 'C', 5000, 'c', false);
    w.table.startNewHand();
    const raiser = w.table.activeSeatIndex;
    w.table.playerRaise(raiser, 400);
    const actor = w.table.activeSeatIndex;
    const third = [0, 1, 2].find((i) => i !== raiser && i !== actor)!;
    w.m.teardownSeat(T, w.table, third, { userId: 3, username: 'u3' }, 'leave');
    expect(w.table.isHandInProgress()).toBe(true);
    w.m.teardownSeat(T, w.table, raiser, { userId: 1, username: 'u1' }, 'leave');
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);   // awarded at once
    expect(w.table.lastHandResult!.winners.map((x) => x.seatIndex)).toEqual([actor]);
    expect(w.chipsOnTable() + w.credited()).toBe(15000);
  });
});

describe('GAME-15 — a join never takes an AI seat that is in the hand being played', () => {
  it('mid-hand: a bot still in the hand (or with chips in the pot) is not takeable; a folded bot with nothing in is; between hands any bot is', () => {
    const w = teardownWorld();
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `Bot${i}`, 5000, `ai-${i}`, true);
    w.table.startNewHand();
    for (let i = 0; i < 3; i++) expect(w.m.aiSeatTakeableNow(w.table, i)).toBe(false);   // all dealt in (blinds / live)
    const utg = w.table.activeSeatIndex;
    w.table.playerFold(utg);                                     // folded with nothing in the pot
    expect(w.m.aiSeatTakeableNow(w.table, utg)).toBe(true);
    expect(w.m.takeAiSeatForJoin(w.table, T)).toBe(utg);
    expect(w.table.seats[utg].state).toBe('empty');
    expect(w.m.takeAiSeatForJoin(w.table, T)).toBe(-1);         // the rest are in the hand
    playOut(w.table);
    expect(w.m.takeAiSeatForJoin(w.table, T)).toBeGreaterThanOrEqual(0);   // between hands
  });
});

describe('GAME-17 — the last human leaving never strips the bots mid-hand', () => {
  function botsMidHand(w: ReturnType<typeof teardownWorld>) {
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `Bot${i}`, 5000, `ai-${i}`, true);
    w.table.startNewHand();
  }

  it('mid-hand the strip is MARKED; the hand plays on; at the hand\'s end the bots go (no orphan hand)', () => {
    const w = teardownWorld();
    botsMidHand(w);
    w.m.stripBotsWhenNoHumans(T, w.table);
    expect(w.m.botStripAfterHand.has(T)).toBe(true);
    expect(w.table.getOccupiedSeatCount()).toBe(3);
    playOut(w.table);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    w.m.stripBotsAfterHandIfMarked(T);
    expect(w.table.getOccupiedSeatCount()).toBe(0);
    expect(w.m.botStripAfterHand.has(T)).toBe(false);
  });

  it('a human who sat down before the hand ended keeps the bots', () => {
    const w = teardownWorld();
    botsMidHand(w);
    w.m.stripBotsWhenNoHumans(T, w.table);
    w.table.sitDown(5, 'Human', 5000, 'h', false);
    playOut(w.table);
    w.m.stripBotsAfterHandIfMarked(T);
    expect(w.table.getOccupiedSeatCount()).toBe(4);
  });

  it('CONTROL — the pre-R2 strip mid-hand left an ORPHAN hand: in progress, nobody seated, nobody to act', () => {
    const w = teardownWorld();
    botsMidHand(w);
    for (let i = 0; i < 3; i++) w.table.standUp(i);              // the old immediate strip
    expect(w.table.isHandInProgress()).toBe(true);
    expect(w.table.getOccupiedSeatCount()).toBe(0);
  });
});

describe('GAME-17 — the heartbeat revives a HandComplete table nothing will deal', () => {
  const HEARTBEAT = [
    slice('const LIVE_ROOM_MIN_OCCUPIED = 3;', 'const heartbeatRestarts = { handComplete: 0 };'),
    fnSrc('function backfillAIToMin('),
    fnSrc('function ensureCashTableRunning('),
    fnSrc('function trimExcessAI('),
    fnSrc('function fillWithAI('),
    fnSrc('function aiSeatsMutableNow('),
    slice('const BOT_STACK_CAP_BUYINS: number = ', '  return isFixedRosterTable(tableId);\n}\n'),
    fnSrc('function isFixedRosterTable('),   // the merged predicate (S1) isFixedRosterQuickTable delegates to
    fnSrc('function autoStartNextHand('),
  ].join('\n');

  function heartbeatWorld(code = HEARTBEAT) {
    const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
      pendingAutoStartTimers: new Map(), quickTables: new Set(), careerTables: new Map(), spinGoMultipliers: new Map(),
      allInOrFoldTables: new Set(), challengeTables: new Map(), tournamentTables: new Map(), brokenTournamentTables: new Map(),
      isTournamentTable: () => false, aiProfiles: new Map(), playerSessions: new Map(), multiTableSessions: new Map(),
      dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], tournamentManager: { getTournament: () => undefined },
      CASH_TABLE_TARGET_OCCUPIED: 5, MAX_SEATS, GamePhase, generateRandomProfile, uuidv4: () => Math.random().toString(36).slice(2),
      ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {}, activateBombPotIfPending() {},
      log: { debug() {}, info() {} }, console: quiet,
    };
    const { exports: m } = load(code, scope, '{ ensureCashTableRunning, heartbeatRestarts }');
    return { table, m };
  }

  /** The table after its last hand: HandComplete, the last human gone, the bots stripped. */
  function frozen(w: ReturnType<typeof heartbeatWorld>) {
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    w.table.startNewHand();
    playOut(w.table);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    for (let i = 0; i < 3; i++) w.table.standUp(i);
  }

  it('one heartbeat: re-seeded with bots AND dealt (it used to deal WaitingForPlayers tables only)', () => {
    const w = heartbeatWorld();
    frozen(w);
    w.m.ensureCashTableRunning(T);
    expect(w.table.getOccupiedSeatCount()).toBeGreaterThanOrEqual(3);
    expect(w.table.isHandInProgress()).toBe(true);
    expect(w.m.heartbeatRestarts.handComplete).toBe(1);
  });

  it('CONTROL — without the restart: re-seeded, but the table never deals again (three heartbeats)', () => {
    const start = HEARTBEAT.indexOf('  if (\n    table.currentPhase === GamePhase.HandComplete &&');
    const end = HEARTBEAT.indexOf('    return;\n  }\n', start) + '    return;\n  }\n'.length;
    expect(start).toBeGreaterThan(-1);
    const w = heartbeatWorld(HEARTBEAT.slice(0, start) + HEARTBEAT.slice(end));
    frozen(w);
    for (let k = 0; k < 3; k++) w.m.ensureCashTableRunning(T);
    expect(w.table.getOccupiedSeatCount()).toBeGreaterThanOrEqual(3);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
  });
});

describe('GAME-18 — bot stacks uncapped by default (owner 2026-10-24), env cap optional; fixed-roster quick tables never reload', () => {
  const RELOAD = [
    slice('const BOT_STACK_CAP_BUYINS: number = ', '  return isFixedRosterTable(tableId);\n}\n'),
    fnSrc('function isFixedRosterTable('),   // the merged predicate (S1) isFixedRosterQuickTable delegates to
  ].join('\n');
  function reloadWorld(env: Record<string, string> = {}) {
    const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 } as any);
    const debug: string[] = [];
    const info: string[] = [];
    const scope = {
      MAX_SEATS, quickTables: new Set<string>(), careerTables: new Map(), spinGoMultipliers: new Map(), allInOrFoldTables: new Set(),
      challengeTables: new Map(), log: { debug: (m: string) => debug.push(m), info: (m: string) => info.push(m) }, console: { log: (m: string) => info.push(m) },
      process: { env },
    };
    const { exports: m } = load(RELOAD, scope, '{ reloadAndCapBotStacks, isFixedRosterQuickTable, botStackStats, BOT_STACK_CAP_BUYINS }');
    return { table, m, scope, debug, info };
  }

  it('DEFAULT (owner 2026-10-24: no limit): a busted bot reloads to one buy-in; a bot at 54x keeps every chip; a human is never touched', () => {
    const w = reloadWorld();
    expect(w.m.BOT_STACK_CAP_BUYINS).toBe(0);
    w.table.sitDown(0, 'Busted', 10000, 'ai-0', true);
    w.table.sitDown(1, 'Fat', 10000, 'ai-1', true);
    w.table.sitDown(2, 'Fine', 10000, 'ai-2', true);
    w.table.sitDown(3, 'Human', 10000, 'h', false);
    w.table.seats[0].chipCount = 0;
    w.table.seats[1].chipCount = 540_000;                         // 54x buy-in: kept
    w.table.seats[2].chipCount = 30_000;
    w.table.seats[3].chipCount = 90_000;                          // a human: never
    const r = w.m.reloadAndCapBotStacks(w.table, T, false);
    expect(r).toEqual({ reloaded: 1, minted: 10000, capped: 0, burned: 0 });
    expect(w.table.seats.slice(0, 4).map((s) => s.chipCount)).toEqual([10000, 540_000, 30_000, 90_000]);
    expect(w.m.botStackStats.caps).toBe(0);
    expect(w.m.botStackStats.burned).toBe(0);
    expect(w.debug.filter((l) => l.includes('over'))).toEqual([]);
  });

  it('the env switch: unset, 0, negative, fractional or junk = no cap; a whole number >= 1 turns the reset on', () => {
    for (const v of ['', '0', '-3', '2.5', 'abc', 'Infinity']) expect(reloadWorld({ BOT_STACK_CAP_BUYINS: v }).m.BOT_STACK_CAP_BUYINS).toBe(0);
    expect(reloadWorld({ BOT_STACK_CAP_BUYINS: '1' }).m.BOT_STACK_CAP_BUYINS).toBe(1);
    expect(reloadWorld({ BOT_STACK_CAP_BUYINS: '3' }).m.BOT_STACK_CAP_BUYINS).toBe(3);
    expect(reloadWorld({ BOT_STACK_CAP_BUYINS: '10' }).m.BOT_STACK_CAP_BUYINS).toBe(10);
  });

  it('ENV CAP ON (BOT_STACK_CAP_BUYINS=3): a busted bot reloads to one buy-in; a bot above 3 buy-ins is reset to one; a human is never touched; logs at DEBUG', () => {
    const w = reloadWorld({ BOT_STACK_CAP_BUYINS: '3' });
    expect(w.m.BOT_STACK_CAP_BUYINS).toBe(3);
    w.table.sitDown(0, 'Busted', 10000, 'ai-0', true);
    w.table.sitDown(1, 'Fat', 10000, 'ai-1', true);
    w.table.sitDown(2, 'Fine', 10000, 'ai-2', true);
    w.table.sitDown(3, 'Human', 10000, 'h', false);
    w.table.seats[0].chipCount = 0;
    w.table.seats[1].chipCount = 54_000;                          // the measured pre-R2 drift: 54x buy-in
    w.table.seats[2].chipCount = 30_000;                          // exactly 3x — kept
    w.table.seats[3].chipCount = 90_000;                          // a human: never
    const r = w.m.reloadAndCapBotStacks(w.table, T, false);
    expect(r).toEqual({ reloaded: 1, minted: 10000, capped: 1, burned: 44000 });
    expect(w.table.seats.slice(0, 4).map((s) => s.chipCount)).toEqual([10000, 10000, 30000, 90000]);
    expect(w.debug.some((l) => l.startsWith('[Reload] AI Busted busted'))).toBe(true);
    expect(w.info).toEqual([]);                                   // Addendum: not at info / console.log
  });

  it('a fixed-roster quick table: nothing reloaded, nothing capped (S1 ends the game)', () => {
    const w = reloadWorld();
    (w.scope.quickTables as Set<string>).add(T);
    expect(w.m.isFixedRosterQuickTable(T)).toBe(true);
    w.table.sitDown(0, 'Bot', 10000, 'ai-0', true);
    w.table.seats[0].chipCount = 0;
    expect(w.m.reloadAndCapBotStacks(w.table, T, w.m.isFixedRosterQuickTable(T))).toEqual({ reloaded: 0, minted: 0, capped: 0, burned: 0 });
    expect(w.table.seats[0].chipCount).toBe(0);
    expect(w.m.botStackStats.fixedRosterReloadsSkipped).toBe(1);
  });

  it('wiring: autoStartNextHand runs it on every non-tournament table with the fixed-roster predicate', () => {
    const auto = fnSrc('function autoStartNextHand(');
    expect(auto).toContain('reloadAndCapBotStacks(table, tableId, isFixedRosterQuickTable(tableId));');
    expect(SRC).not.toMatch(/console\.log\(`\[Reload\] AI/);
  });
});

describe('APPUI-21 — a second departure of the same account never strands the first reservation', () => {
  const RESERVE = [
    fnSrc('function reserveSeatForDeparture('),
    slice('const reservationsDisplaced = { count: 0 };', '\n}\n'),
    fnSrc('function isTournamentReservation('),
    fnSrc('function processPendingSeatRemovals('),
    SEAT_TEARDOWN_SRC,
    fnSrc('function seatPlayedByAnotherAccount('),
  ].join('\n');

  function reserveWorld(code = RESERVE) {
    const tables = new Map<string, PokerTable>();
    for (const id of ['T1', 'T2']) tables.set(id, new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any));
    const credits: Array<{ userId: number; chips: number; reason: string }> = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const reservedSeats = new Map<number, any>();
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => tables.get(id) }, reservedSeats, playerSessions: new Map(), multiTableSessions: new Map(),
      authSessions: new Map(), pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(),
      pendingAutoStartTimers: new Map(), tournamentTables: new Map(), isTournamentTable: () => false,
      creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ userId, chips: seat.chipCount, reason }),
      addChipsToUser: async () => true, auditLog() {}, scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {},
      DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, SEAT_RESERVE_MS: 6 * 3600_000, DISCONNECT_HANDS_LIMIT: 20,
      setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (t: any) => { if (t) t.cleared = true; },
      console: quiet,
    };
    const { exports: m } = load(code, scope, '{ reserveSeatForDeparture, reservationsDisplaced }');
    const auth = { userId: 101, username: 'alice' };
    const sit = (id: string, chips: number) => {
      const t = tables.get(id)!;
      t.sitDown(0, 'Alice', chips, 'user_101', false);
      t.sitDown(1, 'Bob', 5000, 'p-bob', false);
      return { socketId: `S-${id}`, tableId: id, seatIndex: 0, playerName: 'Alice', playerId: 'user_101', sittingOut: false };
    };
    const expireAll = () => { for (const t of timers) if (!t.cleared) { t.cleared = true; t.fn(); } };
    return { tables, m, credits, reservedSeats, auth, sit, expireAll };
  }

  it('the first reservation is ENDED properly (its seat credited and stood up) — not overwritten and stranded; the second reserves normally', async () => {
    const w = reserveWorld();
    const s1 = w.sit('T1', 7000);
    const s2 = w.sit('T2', 3000);
    w.m.reserveSeatForDeparture(w.auth, s1, w.tables.get('T1')!, w.tables.get('T1')!.seats[0]);
    w.m.reserveSeatForDeparture(w.auth, s2, w.tables.get('T2')!, w.tables.get('T2')!.seats[0]);
    expect(w.tables.get('T1')!.seats[0].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 101, chips: 7000, reason: 'reserve_displaced' }]);
    expect(w.reservedSeats.get(101)).toMatchObject({ tableId: 'T2', seatIndex: 0 });
    expect(w.m.reservationsDisplaced.count).toBe(1);
    w.expireAll();                                               // T2's own expiry
    await flush();
    expect(w.credits).toEqual([
      { userId: 101, chips: 7000, reason: 'reserve_displaced' },
      { userId: 101, chips: 3000, reason: 'reserve_expiry' },
    ]);
  });

  it('CONTROL — pre-R2 (overwrite): the first seat stays occupied, never credited, even after the second expires — 7,000 stranded', async () => {
    const code = RESERVE.replace('if (existing && (existing.tableId !== session.tableId || existing.seatIndex !== session.seatIndex)) {', 'if (false) {');
    expect(code).not.toBe(RESERVE);
    const w = reserveWorld(code);
    const s1 = w.sit('T1', 7000);
    const s2 = w.sit('T2', 3000);
    w.m.reserveSeatForDeparture(w.auth, s1, w.tables.get('T1')!, w.tables.get('T1')!.seats[0]);
    w.m.reserveSeatForDeparture(w.auth, s2, w.tables.get('T2')!, w.tables.get('T2')!.seats[0]);
    w.expireAll();
    await flush();
    expect(w.tables.get('T1')!.seats[0].state).toBe('occupied');
    expect(w.credits).toEqual([{ userId: 101, chips: 3000, reason: 'reserve_expiry' }]);
  });

  it('a reservation expiring MID-HAND waits for the hand\'s end (the pot keeps the seat\'s chips)', () => {
    const w = reserveWorld();
    const s1 = w.sit('T1', 7000);
    const t1 = w.tables.get('T1')!;
    t1.on('handResult', () => {});
    w.m.reserveSeatForDeparture(w.auth, s1, t1, t1.seats[0]);
    t1.startNewHand();
    expect(t1.seats[0].totalInvestedThisHand).toBeGreaterThan(0);   // a blind
    w.expireAll();
    expect(t1.seats[0].state).toBe('occupied');                     // deferred, not erased
    expect(w.credits).toEqual([]);
  });
});

describe('GAME-15 / GAME-16 — the guest-claim pre-step tears seats down through the ONE helper', () => {
  const GUEST = 501;
  const GUEST_SRC = [
    fnSrc('async function cashOutSeatsBeforeGuestClaim('),
    fnSrc('function standUpRefusedSeat('),
    fnSrc('function processPendingSeatRemovals('),
    SEAT_TEARDOWN_SRC,
  ].join('\n');

  /** `players` seated on one real table; the guest's live session points at whichever seat `pick` chooses after the deal. */
  function guestWorld(players: number, code = GUEST_SRC) {
    const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
    for (let i = 0; i < players; i++) table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    const walletCredits: Array<{ uid: number; amount: number }> = [];   // addChipsToUser — the AWAITED path
    const deferredCredits: Array<{ uid: number; chips: number; reason: string }> = [];   // the hand's-end path
    const scheduled: string[] = [];
    const playerSessions = new Map<string, any>();
    const authSessions = new Map<string, any>([['SG', { userId: GUEST, username: 'guest' }]]);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
      pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(),
      pendingAutoStartTimers: new Map(), reservedSeats: new Map(), playerSessions, multiTableSessions: new Map(), authSessions,
      io: { sockets: { sockets: new Map() } }, releaseSeatedSlot() {},
      isTournamentTable: () => false, isTournamentReservation: () => false,
      addChipsToUser: async (uid: number, amount: number) => { walletCredits.push({ uid, amount }); return true; },
      creditSeatStackToWallet: (uid: number, _u: string, _t: string, seat: any, reason: string) => deferredCredits.push({ uid, chips: seat.chipCount, reason }),
      auditLog() {}, scheduleAIAction: (id: string) => scheduled.push(id), syncSitOutToTable() {}, broadcastGameState() {},
      DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    };
    const { exports: m } = load(code, scope, '{ cashOutSeatsBeforeGuestClaim, processPendingSeatRemovals }');
    table.on('handResult', () => m.processPendingSeatRemovals(T));
    const guestAt = (seatIndex: number) => playerSessions.set('SG', { socketId: 'SG', tableId: T, seatIndex, playerName: `P${seatIndex}`, playerId: `p${seatIndex}` });
    const conserved = () => table.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (table.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0)
      + walletCredits.reduce((s, c) => s + c.amount, 0) + deferredCredits.reduce((s, c) => s + c.chips, 0);
    return { table, m, walletCredits, deferredCredits, scheduled, guestAt, conserved };
  }

  /** 3-handed: the small blind calls nothing — it FOLDS with its 25 in the pot. */
  function foldedSmallBlind(w: ReturnType<typeof guestWorld>) {
    w.table.startNewHand();
    const sb = w.table.seats.findIndex((s) => s.currentBet === 25);
    let g = 0;
    while (w.table.activeSeatIndex !== sb && g++ < 5) w.table.playerCall(w.table.activeSeatIndex);
    expect(w.table.playerFold(sb)).toBe(true);
    expect(w.table.isHandInProgress()).toBe(true);
    return sb;
  }

  it('a FOLDED guest seat with chips in the live pot waits for the hand\'s end (credited once, nothing destroyed)', async () => {
    const w = guestWorld(3);
    const sb = foldedSmallBlind(w);
    w.guestAt(sb);
    await w.m.cashOutSeatsBeforeGuestClaim(GUEST);
    expect(w.table.seats[sb].state).toBe('occupied');              // the pot still holds its 25
    expect(w.walletCredits).toEqual([]);
    playOut(w.table);
    expect(w.table.seats[sb].state).toBe('empty');
    expect(w.deferredCredits).toEqual([{ uid: GUEST, chips: 4975, reason: 'leave_after_hand' }]);
    expect(w.conserved()).toBe(15000);
  });

  it('CONTROL — pre-R2 (only a NON-folded seat deferred, else stood up at once): the folded guest\'s 25 left the pot', async () => {
    const code = GUEST_SRC
      .replace('if (table.isHandInProgress() && (seat.totalInvestedThisHand || 0) > 0) {',
        'if (table.isHandInProgress() && !seat.folded && (seat.totalInvestedThisHand || 0) > 0) {')
      .replace("if (teardownSeat(tableId, table, seatIndex, null, reason) !== 'stood_up') return true;",
        "if (table.isHandInProgress() && table.activeSeatIndex === seatIndex) table.playerFold(seatIndex); sitOutTracker.get(tableId)?.delete(seatIndex); table.standUp(seatIndex); syncSitOutToTable(tableId);");
    expect(code).not.toBe(GUEST_SRC);
    const w = guestWorld(3, code);
    const sb = foldedSmallBlind(w);
    w.guestAt(sb);
    await w.m.cashOutSeatsBeforeGuestClaim(GUEST);
    expect(w.table.seats[sb].state).toBe('empty');
    playOut(w.table);
    expect(w.conserved()).toBe(15000 - 25);
  });

  it('the guest ON THE CLOCK with nothing in the pot is folded, the next bot is scheduled now, the stack credited (awaited)', async () => {
    const w = guestWorld(4);
    w.table.startNewHand();
    const utg = w.table.activeSeatIndex;
    expect(w.table.seats[utg].totalInvestedThisHand).toBe(0);
    w.guestAt(utg);
    await w.m.cashOutSeatsBeforeGuestClaim(GUEST);
    expect(w.table.seats[utg].state).toBe('empty');
    expect(w.table.activeSeatIndex).not.toBe(utg);
    expect(w.scheduled).toContain(T);                                 // GAME-16: was never scheduled here
    expect(w.walletCredits).toEqual([{ uid: GUEST, amount: 5000 }]);
    playOut(w.table);
    expect(w.conserved()).toBe(20000);
  });

  it('a guest seat dealt in but NOT on the clock is folded out of turn (not left live while stood up); the hand plays on', async () => {
    const w = guestWorld(4);
    w.table.startNewHand();
    const utg = w.table.activeSeatIndex;
    const idle = w.table.seats.findIndex((s) => s.state === 'occupied' && s.seatIndex !== utg && s.totalInvestedThisHand === 0);
    expect(idle).toBeGreaterThanOrEqual(0);
    w.guestAt(idle);
    await w.m.cashOutSeatsBeforeGuestClaim(GUEST);
    expect(w.table.seats[idle].state).toBe('empty');
    expect(w.table.activeSeatIndex).toBe(utg);                        // the real actor keeps the action
    expect(w.walletCredits).toEqual([{ uid: GUEST, amount: 5000 }]);
    playOut(w.table);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.conserved()).toBe(20000);
  });
});

describe('R2 — a seat torn down while ALL-IN keeps its hand only at a ring table (wallet chips)', () => {
  /** 3-handed, 5000 each; the first actor shoves and is torn down while the other two still have to act. */
  function shoveThenTeardown(w: ReturnType<typeof teardownWorld>) {
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    w.table.startNewHand();
    const shover = w.table.activeSeatIndex;
    expect(w.table.playerAllIn(shover)).toBe(true);
    expect(w.table.seats[shover].allIn).toBe(true);
    expect(w.m.teardownSeat(T, w.table, shover, { userId: 7, username: 'u7' }, 'admin_kick')).toBe('deferred');
    return shover;
  }

  it('a TOURNAMENT seat: its hand is dead (folded) — its 5000 stays in the pot for the players still in it, nothing leaves play with the seat', () => {
    const w = teardownWorld(undefined, { isTournamentTable: () => true });
    const shover = shoveThenTeardown(w);
    expect(w.table.seats[shover].folded).toBe(true);
    expect(w.m.seatTeardownStats.allInKept).toBe(0);
    playOut(w.table);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.table.seats[shover].state).toBe('empty');
    expect(w.credited()).toBe(0);
    expect(w.table.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount : 0), 0)).toBe(15000);
  });

  it('a fixed-roster QUICK table seat (the leaver concedes): folded the same way', () => {
    const w = teardownWorld(undefined, { isFixedRosterQuickTable: () => true });
    const shover = shoveThenTeardown(w);
    expect(w.table.seats[shover].folded).toBe(true);
  });

  it('a RING (cash) seat keeps its all-in hand (Addendum): it is paid what it wins at the hand\'s end', () => {
    const w = teardownWorld(undefined, { isTournamentTable: () => false, isFixedRosterQuickTable: () => false });
    const shover = shoveThenTeardown(w);
    expect(w.table.seats[shover].folded).toBe(false);
    expect(w.m.seatTeardownStats.allInKept).toBe(1);
    playOut(w.table);
    expect(w.table.seats[shover].state).toBe('empty');
    expect(w.chipsOnTable() + w.credited()).toBe(15000);
  });

  it('CONTROL — every all-in kept (the first R2 cut): a disqualified tournament seat stayed IN the pot; anything it won would leave play with it', () => {
    const w = teardownWorld(undefined, { isTournamentTable: () => true });
    const code = SEAT_TEARDOWN_SRC.replace('if ((seat.allIn || table.isRunoutHeld()) && leaverKeepsAllInHand(tableId)) {', 'if (seat.allIn) {');
    expect(code).not.toBe(SEAT_TEARDOWN_SRC);
    const scope: Record<string, unknown> = {
      pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), scheduleAIAction() {}, syncSitOutToTable() {},
      creditSeatStackToWallet() {}, isTournamentTable: () => true, DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    };
    const { exports: old } = load(code, scope, '{ teardownSeat }');
    for (let i = 0; i < 3; i++) w.table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    w.table.startNewHand();
    const shover = w.table.activeSeatIndex;
    w.table.playerAllIn(shover);
    expect(old.teardownSeat(T, w.table, shover, { userId: 7, username: 'u7' }, 'admin_kick')).toBe('deferred');
    expect(w.table.seats[shover].folded).toBe(false);
  });
});

describe('GAME-15 / GAME-16 — an admin-disqualified ABSENT tournament seat goes through the ONE teardown', () => {
  const DQ_CALL = 'teardownSeat(tableId, table, seatIndex,\n    { userId: account.userId, username: account.username || String(account.userId) }, `${via}_away_disqualified`);';
  const PRE_R2 = [
    'const inPot = table.isHandInProgress() && !seat.folded && (seat.totalInvestedThisHand || 0) > 0;',
    'if (inPot) {',
    '  let m = pendingSeatRemovalAfterHand.get(tableId);',
    '  if (!m) { m = new Map(); pendingSeatRemovalAfterHand.set(tableId, m); }',
    '  m.set(seatIndex, { userId: account.userId, username: account.username || String(account.userId) });',
    '}',
    'if (table.isHandInProgress()) {',
    '  if (table.activeSeatIndex === seatIndex) table.playerFold(seatIndex);',
    '  else if (inPot) table.forceFoldSeat(seatIndex);',
    '}',
    "if (!inPot && seat.state === 'occupied') {",
    '  if (seat.chipCount > 0) {',
    "    auditLog(account.username || String(account.userId), 'TOURNAMENT_STACK_NOT_CASHED', {",
    '      userId: account.userId, tableId, amount: seat.chipCount, reason: `${via}_away_disqualified`,',
    '    });',
    '  }',
    '  table.standUp(seatIndex);',
    '}',
  ].join('\n');
  const DQ_SRC = [
    fnSrc('function standUpAdminDisqualifiedAbsentSeat('),
    fnSrc('function processPendingSeatRemovals('),
    fnSrc('function creditSeatStackToWallet('),
    SEAT_TEARDOWN_SRC,
  ].join('\n');

  function dqWorld(players: number, code = DQ_SRC) {
    const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
    for (let i = 0; i < players; i++) table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    const audits: Array<{ action: string; d: any }> = [];
    const walletCredits: number[] = [];
    const scheduled: string[] = [];
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
      pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), reservedSeats: new Map(), playerSessions: new Map(),
      aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(),
      isTournamentTable: () => true, Sentry: null,
      addChipsToUser: async (_u: number, amount: number) => { walletCredits.push(amount); return true; },
      auditLog: (_a: string, action: string, d: any) => audits.push({ action, d }),
      scheduleAIAction: (id: string) => scheduled.push(id), syncSitOutToTable() {}, broadcastGameState() {},
      DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    };
    const { exports: m } = load(code, scope, '{ standUpAdminDisqualifiedAbsentSeat, processPendingSeatRemovals }');
    table.on('handResult', () => m.processPendingSeatRemovals(T));
    const dq = (seatIndex: number) => m.standUpAdminDisqualifiedAbsentSeat(table, T, seatIndex, { userId: 202, username: 'u202' }, 'admin_ip_ban');
    const onTable = () => table.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (table.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0);
    return { table, dq, audits, walletCredits, scheduled, onTable };
  }

  function foldedSmallBlind(w: ReturnType<typeof dqWorld>) {
    w.table.startNewHand();
    const sb = w.table.seats.findIndex((s) => s.currentBet === 25);
    let g = 0;
    while (w.table.activeSeatIndex !== sb && g++ < 5) w.table.playerCall(w.table.activeSeatIndex);
    expect(w.table.playerFold(sb)).toBe(true);
    return sb;
  }

  it('a FOLDED seat with chips in the live pot: left for the hand\'s end (the pot keeps its 25); never credited, audited at the end', () => {
    const w = dqWorld(3);
    const sb = foldedSmallBlind(w);
    w.dq(sb);
    expect(w.table.seats[sb].state).toBe('occupied');
    playOut(w.table);
    expect(w.table.seats[sb].state).toBe('empty');
    expect(w.walletCredits).toEqual([]);
    expect(w.audits).toEqual([expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ amount: 4975, reason: 'leave_after_hand' }) })]);
    expect(w.onTable()).toBe(15000 - 4975);                          // only HIS stack left play
  });

  it('CONTROL — pre-R2 (only a NON-folded seat deferred): the folded seat was stood up at once and its 25 left the pot too', () => {
    const code = DQ_SRC.replace(DQ_CALL, PRE_R2);
    expect(code).not.toBe(DQ_SRC);
    const w = dqWorld(3, code);
    const sb = foldedSmallBlind(w);
    w.dq(sb);
    expect(w.table.seats[sb].state).toBe('empty');
    playOut(w.table);
    expect(w.onTable()).toBe(15000 - 4975 - 25);
  });

  it('a seat ON THE CLOCK: folded, the next actor is scheduled now, stood up at once; audited <via>_away_disqualified, never credited', () => {
    const w = dqWorld(4);
    w.table.startNewHand();
    const utg = w.table.activeSeatIndex;
    w.dq(utg);
    expect(w.table.seats[utg].state).toBe('empty');
    expect(w.table.activeSeatIndex).not.toBe(utg);
    expect(w.scheduled).toContain(T);
    expect(w.walletCredits).toEqual([]);
    expect(w.audits).toEqual([expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ amount: 5000, reason: 'admin_ip_ban_away_disqualified' }) })]);
  });

  it('CONTROL — pre-R2: the on-the-clock fold never scheduled the next actor (it sat until its turn clock)', () => {
    const w = dqWorld(4, DQ_SRC.replace(DQ_CALL, PRE_R2));
    w.table.startNewHand();
    w.dq(w.table.activeSeatIndex);
    expect(w.scheduled).toEqual([]);
  });

  it('an ALL-IN seat: its hand is dead; the 5000 it shoved stays with the players still in the hand (nothing leaves play)', () => {
    const w = dqWorld(3);
    w.table.startNewHand();
    const shover = w.table.activeSeatIndex;
    expect(w.table.playerAllIn(shover)).toBe(true);
    w.dq(shover);
    expect(w.table.seats[shover].folded).toBe(true);
    playOut(w.table);
    expect(w.table.seats[shover].state).toBe('empty');
    expect(w.walletCredits).toEqual([]);
    expect(w.onTable()).toBe(15000);
  });
});

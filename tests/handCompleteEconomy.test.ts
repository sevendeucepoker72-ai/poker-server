/**
 * .online R2 (S3, 2026-10-11) — the REAL table progress listener + hand-complete
 * handler (sliced from src/index.ts) on a REAL PokerTable hand, with the real
 * ProgressionManager:
 *   C10 / APPUI-10  a preflop CALL that closes the betting round counts for VPIP
 *                   (it used to be recorded after the engine advanced the
 *                   street, reading 'Flop' — never counted);
 *   ECON-13         a seat that was NOT dealt in (sitting out) earns nothing:
 *                   no hand, no XP, no scratch tick, no chips-won row;
 *   C9 / APPUI-50   the dealt-in human's NET result goes to the Denver-day
 *                   chips-won bucket (cash tables);
 *   ECON-10         the hand-complete save MERGES the counters (monotonic);
 *   Addendum        the activity ticker shows public names only.
 */
jest.mock('../src/economy/economyDb', () => ({
  loadProgressBundle: jest.fn(async (userId: number) => ({
    userId, displayName: `P${userId}`, publicId: null, chips: 50000, level: 3, xp: 0, stars: 0, stats: {}, achievements: [],
    lifetimeLedger: [], loginStreak: 0, lastLoginClaimDate: null, scratchCardsAvailable: 0, inventory: [], dailyAchievementIds: [],
    weeklyAchievementIds: [], missionClaims: [], spinClaimedToday: false, vipMonthlyClaimed: false, battlePassPremium: false,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    denverToday: require('../src/economy/denverTime').denverDateKey(), denverMonth: '2026-10',
  })),
  settleAchievementReward: jest.fn(async () => ({ status: 'already', chips: 0, stars: 0, balances: null })),
  settleLevelUps: jest.fn(async () => ({ paidLevels: [], chips: 0, stars: 0, balances: { chips: 0, stars: 0, scratchCardsAvailable: 0 } })),
}));
jest.mock('../src/auth/authManager', () => ({
  addChipsToUser: jest.fn(async () => true), addStarsToUser: jest.fn(async () => true), mergeUserStats: jest.fn(async () => {}),
}));

import { fnSrc, load, flush, SEAT_IDENTITY_SRC, INSURANCE_HISTORY_SRC } from './helpers/indexSource';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { HandRank } from '../src/game/HandEvaluator';
import { ProgressionManager } from '../src/progression/ProgressionManager';
import { denverDateKey } from '../src/economy/denverTime';
import { publicNameOf, PUBLIC_NAME_FALLBACK } from '../src/social/publicIdentity';
import { opponentModelKey } from '../src/ai/AIPlayer';
import { progressionHandRank } from '../src/progression/progressionHandRank';

const LISTENER = fnSrc('function ensureTableProgressListener(');
const HAND_COMPLETE = fnSrc('async function handleHandComplete(');
// R3 (S3-2 / H1) — the per-seat chips-won resolution and the viewer fields of each handHistory copy.
const R3_HELPERS = [
  fnSrc('function chipsWonSeatsOfHand('), fnSrc('function dealtInSeatAccount('), fnSrc('function handHistoryViewerOf('), SEAT_IDENTITY_SRC,
  fnSrc('function seatPlayedByAnotherAccount('),
  INSURANCE_HISTORY_SRC,   // G165 — the listener's player rows go through withInsuranceSettlement
].join('\n');

function world(opts: { tableKind?: string; humanName?: string } = {}) {
  const pm = new ProgressionManager();
  pm.hydrateBackoffMs = [0];
  pm.hydrateRetryDelaysMs = [];
  const table = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
  const humanName = opts.humanName ?? 'Josh';
  // The first hand's button is the first occupied seat: the bot (button) acts first pre-flop, A is the big blind.
  table.sitDown(0, 'Bot', 2000, 'ai-1', true);
  table.sitDown(1, 'Sitter', 2000, 'player-B', false);
  table.sitDown(2, humanName, 2000, 'player-A', false);
  const playerSessions = new Map<string, any>([
    ['SA', { socketId: 'SA', tableId: 'T1', seatIndex: 2, playerId: 'player-A', playerName: humanName, sittingOut: false }],
    ['SB', { socketId: 'SB', tableId: 'T1', seatIndex: 1, playerId: 'player-B', playerName: 'Sitter', sittingOut: true }],
  ]);
  const authSessions = new Map<string, any>([['SA', { userId: 7, username: 'u7' }], ['SB', { userId: 8, username: 'u8' }]]);
  pm.getOrCreateProgress('player-A', humanName, 7);
  pm.getOrCreateProgress('player-B', 'Sitter', 8);
  const chipsWon: Array<[number, string, number]> = [];
  const merges: Array<[number, any, any]> = [];
  const saves: Array<[number, any]> = [];
  const ticks: number[] = [];
  const activity: string[] = [];
  const pushes: Array<[string, any]> = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: () => table }, playerSessions, authSessions, progressionManager: pm,
    tableProgressListeners: new Set<string>(), bombPotActive: new Map(), GamePhase, PlayerAction, HandRank,
    // R3 (GAME-P3-10): the listener keys the AI read by player id (opponentModelKey).
    recordOpponentObservation() {}, opponentModelKey, incrementHandsPlayed() {}, settlePredictionsForHand: async () => {}, processPendingSeatRemovals() {},
    scheduleAutoStart() {}, chipVelocity: new Map(), getUserChips: async () => 0, standUpSuspendedSeatsBeforeDeal() {},
    tickReservedSeatHands() {}, settleInsuranceForHand() {}, captureTournamentBustCheck: () => null,
    runTournamentBustCheck() {}, rekickTournamentDealAfterBustCheck() {}, runPendingTournamentBustChecks() {}, broadcastGameState() {},
    tableCountsForChipsWon: () => (opts.tableKind ?? 'cash') === 'cash', denverDateKey, economyStats: { chipsWonWrites: 0, chipsWonWriteFailures: 0 },
    recordChipWins: async (uid: number, day: string, net: number) => { chipsWon.push([uid, day, net]); },
    recordClubHand() {}, publicNameOf, PUBLIC_NAME_FALLBACK, recordHand: async () => {},
    progressionHandRank,   // F42 (2026-10-21) — the real rank normaliser
    pushActivity: (t: string) => { activity.push(t); },
    mergeUserStats: async (uid: number, patch: any, o: any) => { merges.push([uid, patch, o]); },
    saveProgress: async (uid: number, d: any) => { saves.push([uid, d]); return true; },
    tickScratchProgress: async (uid: number) => { ticks.push(uid); return { awarded: false, chips: 1, stars: 2, scratchCardsAvailable: 0 }; },
    sendProgressToPlayer: (sid: string, o: any) => { pushes.push([sid, o]); },
    io: { sockets: { sockets: new Map() }, to: () => ({ emit() {} }), emit() {} },
    multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
  };
  const { exports: m } = load(`${LISTENER}\n${HAND_COMPLETE}\n${R3_HELPERS}`, scope, '{ ensureTableProgressListener, handleHandComplete }');
  return { m, pm, table, chipsWon, merges, saves, ticks, activity, pushes };
}

/** Play: Bot raises pre-flop, A CALLS (closing the round), then the flop actor folds. */
async function playHand(w: ReturnType<typeof world>) {
  w.table.setSittingOutSeats([1]);                         // B sits out: not dealt in
  w.m.ensureTableProgressListener(w.table, 'T1');
  await flush();                                            // records hydrate
  expect(w.table.startNewHand()).toBe(true);
  expect(w.table.seats[1].holeCards.length).toBe(0);
  let guard = 0;
  let aActions = 0;
  while (w.table.currentPhase === GamePhase.PreFlop && guard++ < 10) {
    const a = w.table.activeSeatIndex;
    if (a === 0) {
      if (!w.table.playerRaise(0, w.table.currentBetToMatch + 40)) w.table.playerCall(0) || w.table.playerCheck(0);
    } else if (a === 2) {
      aActions++;
      if (w.table.currentBetToMatch > w.table.seats[2].currentBet) w.table.playerCall(2); else w.table.playerCheck(2);
    }
  }
  expect(w.table.currentPhase).toBe(GamePhase.Flop);
  expect(aActions).toBe(1);                                  // A's ONLY pre-flop action is the call that closed the round
  const a = w.table.activeSeatIndex;
  w.table.playerFold(a);
  await flush();
  return a;
}

describe('hand-complete economy on a real hand', () => {
  it('VPIP counts the preflop call that CLOSED the round; the sitting-out seat earns nothing; the dealt-in seat\'s net goes to chips-won; counters merged monotonic', async () => {
    const w = world();
    const folder = await playHand(w);
    const A = w.pm.getProgress('player-A')!;
    const B = w.pm.getProgress('player-B')!;
    expect(A.totalHandsPlayed).toBe(1);
    expect(A.vpipHands).toBe(1);
    expect(B.totalHandsPlayed).toBe(0);                     // ECON-13
    expect(B.xp).toBe(0);
    expect(w.ticks).toEqual([7]);                           // scratch tick: the dealt-in seat only
    const netA = w.table.seats[2].chipCount - 2000;
    expect(w.chipsWon).toEqual([[7, denverDateKey(), netA]]);
    expect(netA).not.toBe(0);
    expect(folder === 2 ? netA < 0 : netA > 0).toBe(true);
    const mergeA = w.merges.find(([uid]) => uid === 7)!;
    expect(mergeA[2]).toEqual({ monotonic: true });
    expect(mergeA[1]).toMatchObject({ handsPlayed: 1, vpipHands: 1 });
    expect(w.saves.find(([uid]) => uid === 7)![1]).toEqual(expect.objectContaining({ xp: expect.any(Number), level: expect.any(Number), achievements: expect.any(Array) }));
    expect(w.saves.find(([uid]) => uid === 7)![1].stats).toBeUndefined();   // counters go through the merge only
    // The push follows the writes, DB-fresh from the tick's wallet.
    expect(w.pushes).toEqual(expect.arrayContaining([['SA', { fresh: false }], ['SB', { fresh: true }]]));
  });

  it('CONTROL — recording after the action (the pre-R2 order) reads the already-advanced street: the closing call is NOT VPIP', async () => {
    const pm = new ProgressionManager();
    const t = new PokerTable({ tableId: 'T2', tableName: 'T2', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
    t.sitDown(0, 'C', 2000, 'pc', true);
    t.sitDown(1, 'A', 2000, 'pa', false);
    const rec = pm.getOrCreateProgress('pa', 'A');
    expect(t.startNewHand()).toBe(true);
    let guard = 0;
    while (t.currentPhase === GamePhase.PreFlop && guard++ < 10) {
      const a = t.activeSeatIndex;
      if (a === 0) { if (!t.playerRaise(0, t.currentBetToMatch + 40)) t.playerCall(0) || t.playerCheck(0); continue; }
      const closing = t.currentBetToMatch > t.seats[1].currentBet;
      if (closing) t.playerCall(1); else t.playerCheck(1);
      pm.recordAction('pa', closing ? 'call' : 'check', { phase: t.currentPhase === GamePhase.PreFlop ? 'PreFlop' : undefined });   // old order
    }
    pm.recordHandPlayed('pa');
    expect(rec.vpipHands).toBe(0);
  });

  it('the activity ticker announces only a PUBLIC name — a phone-like seat name is never shown', async () => {
    for (const [name, announced] of [['Josh', true], ['7205551234', false]] as Array<[string, boolean]>) {
      const w = world({ humanName: name });
      w.table.setSittingOutSeats([1]);
      w.m.ensureTableProgressListener(w.table, 'T1');
      await flush();
      w.table.startNewHand();
      // Give A a 10,000+ pot win directly through the handler.
      w.table.seats[2].chipCount += 12000;
      await w.m.handleHandComplete('T1', [{ seatIndex: 2, amount: 12000, handResult: { handRank: 1 } }]);
      expect([name, w.activity.some((t) => t.includes(name))]).toEqual([name, announced]);
      expect(w.activity.some((t) => /\d{7,}/.test(t.replace(/[,\s]/g, '')) && t.includes(name))).toBe(false);
    }
  });

  it('no chips-won row at a table that is not a wallet-chip table (tournament / quick game)', async () => {
    const w = world({ tableKind: 'spingo' });
    await playHand(w);
    expect(w.chipsWon).toEqual([]);
    expect(w.pm.getProgress('player-A')!.totalHandsPlayed).toBe(1);
  });
});

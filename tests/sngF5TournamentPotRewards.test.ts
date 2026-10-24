/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F5) — TOURNAMENT
 * pots do not feed the chip-amount rewards that pay wallet chips / XP: pot
 * missions (win_pot_over), the lifetime / daily / weekly pot achievements
 * (biggestPot, d_pot_* / w_pot_*), the XP pot bonus, and the lobby ticker
 * "won N chips". A tournament stack is not wallet money: one 50,000-chip
 * qualifier pot paid like a 50,000 cash pot. Count-based rewards (hands played
 * / won, streaks, rare hands, the 10 base win XP) are unchanged.
 *
 * potCountsForWalletRewards(tableId) = !isTournamentTable && !isPrizeFormatTable:
 * every tournament table (qualifier, Sit & Go, scheduled, club; broken tables
 * included) and Spin & Go stop; cash, club challenges and heads-up / career
 * games (wallet stacks) keep counting.
 *
 * The REAL handleHandComplete (sliced) with the REAL ProgressionManager.
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

import { fnSrc, load, flush } from './helpers/indexSource';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { HandRank } from '../src/game/HandEvaluator';
import { ProgressionManager } from '../src/progression/ProgressionManager';
import { denverDateKey } from '../src/economy/denverTime';
import { publicNameOf, PUBLIC_NAME_FALLBACK } from '../src/social/publicIdentity';
import { progressionHandRank } from '../src/progression/progressionHandRank';

type Kind = 'cash' | 'sitngo' | 'qualifier' | 'spingo' | 'broken';

function world(kind: Kind) {
  const pm = new ProgressionManager();
  pm.hydrateBackoffMs = [0];
  pm.hydrateRetryDelaysMs = [];
  const table = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: 100, bigBlind: 200, ante: 0, minBuyIn: 400, maxBuyIn: 1_000_000 } as any);
  table.sitDown(0, 'Other', 50_000, 'player-B', false);
  table.sitDown(2, 'Josh', 50_000, 'player-A', false);
  const playerSessions = new Map<string, any>([
    ['SA', { socketId: 'SA', tableId: 'T1', seatIndex: 2, playerId: 'player-A', playerName: 'Josh', sittingOut: false }],
  ]);
  const authSessions = new Map<string, any>([['SA', { userId: 7, username: 'u7' }]]);
  pm.getOrCreateProgress('player-A', 'Josh', 7);
  const tournamentTables = new Map<string, string>();
  const brokenTournamentTables = new Map<string, string>();
  const spinGoMultipliers = new Map<string, number>();
  if (kind === 'sitngo' || kind === 'qualifier') tournamentTables.set('T1', 'TOURN');
  if (kind === 'broken') brokenTournamentTables.set('T1', 'TOURN');
  if (kind === 'spingo') spinGoMultipliers.set('T1', 2);
  const won: Array<[string, number, any, any]> = [];
  const realWon = pm.recordHandWon.bind(pm);
  pm.recordHandWon = (pid: string, pot: number, rank?: number, allIn?: boolean) => { won.push([pid, pot, rank, allIn]); realWon(pid, pot, rank, allIn); };
  const activity: string[] = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: () => table }, playerSessions, authSessions, progressionManager: pm,
    bombPotActive: new Map(), GamePhase, PlayerAction, HandRank,
    tickReservedSeatHands() {}, settleInsuranceForHand() {}, captureTournamentBustCheck: () => null,
    runTournamentBustCheck() {}, rekickTournamentDealAfterBustCheck() {}, runPendingTournamentBustChecks() {}, broadcastGameState() {},
    tableCountsForChipsWon: () => kind === 'cash', tableFeedsClubStats: () => false, chipsWonSeatsOfHand: () => [],
    denverDateKey, economyStats: { chipsWonWrites: 0, chipsWonWriteFailures: 0 }, recordChipWins: async () => {},
    recordClubHand() {}, publicNameOf, PUBLIC_NAME_FALLBACK, progressionHandRank,
    pushActivity: (t: string) => { activity.push(t); },
    mergeUserStats: async () => {}, saveProgress: async () => true,
    tickScratchProgress: async () => ({ awarded: false, chips: 1, stars: 2, scratchCardsAvailable: 0 }),
    sendProgressToPlayer() {}, io: { sockets: { sockets: new Map() }, to: () => ({ emit() {} }), emit() {} },
    isTournamentTable: (id: string) => tournamentTables.has(id) || brokenTournamentTables.has(id),
    isPrizeFormatTable: (id: string) => spinGoMultipliers.has(id),
  };
  const { exports: m, stubbed } = load(`${fnSrc('async function handleHandComplete(')}\n${fnSrc('function potCountsForWalletRewards(')}`, scope, '{ handleHandComplete, potCountsForWalletRewards }');
  return { m, pm, table, won, activity, stubbed };
}

async function bigWin(w: ReturnType<typeof world>, pot = 50_000): Promise<void> {
  await flush();
  expect(w.table.startNewHand()).toBe(true);
  w.table.seats[2].chipCount += pot;
  await w.m.handleHandComplete('T1', [{ seatIndex: 2, amount: pot, handResult: { handRank: 2 } }]);
  await flush();
}

describe('F5 — tournament pots do not feed wallet-paying pot rewards', () => {
  test.each(['sitngo', 'qualifier', 'broken', 'spingo'] as Kind[])('%s table: recordHandWon gets pot 0 (count rewards kept), no "won N chips" ticker', async (kind) => {
    const w = world(kind);
    await bigWin(w);
    expect(w.won.map((x) => [x[0], x[1]])).toEqual([['player-A', 0]]);        // e038f7b: 50,000
    expect(w.activity.filter((a) => /won .* chips/.test(a))).toEqual([]);
    const A = w.pm.getProgress('player-A')!;
    expect(A.handsWon).toBe(1);                                               // count reward kept
    expect(A.totalHandsPlayed).toBe(1);
    expect(A.biggestPot).toBe(0);                                             // no 'biggest pot' / pot achievements
    expect([...w.stubbed].filter((n) => /potCounts|isTournament|isPrizeFormat/.test(n))).toEqual([]);
  });

  it('cash table: the real pot size, and the ticker fires for 10,000+', async () => {
    const w = world('cash');
    await bigWin(w);
    expect(w.won.map((x) => [x[0], x[1]])).toEqual([['player-A', 50_000]]);
    expect(w.activity.some((a) => a.includes('won 50,000 chips'))).toBe(true);
    expect(w.pm.getProgress('player-A')!.biggestPot).toBe(50_000);
  });

  it('ProgressionManager: recordHandWon(pid, 0) adds only the 10 base XP, keeps biggestPot, advances no pot mission; handsWon still counts', () => {
    const pm = new ProgressionManager();
    const p = pm.getOrCreateProgress('x', 'X', 9);
    const xp0 = p.xp;
    pm.recordHandWon('x', 0, HandRank.TwoPair, false);
    expect(p.handsWon).toBe(1);
    expect(p.biggestPot).toBe(0);
    expect(p.xp - xp0).toBe(10);
    const pm2 = new ProgressionManager();
    const q = pm2.getOrCreateProgress('y', 'Y', 10);
    const xq = q.xp;
    pm2.recordHandWon('y', 50_000, HandRank.TwoPair, false);
    expect(q.xp - xq).toBe(30);   // the pot bonus a tournament pot no longer pays
  });
});

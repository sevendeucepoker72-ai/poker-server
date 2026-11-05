/**
 * Bots review 2026-11-04 (economy-farming E5 / E6 / E7 notice / E12) — the
 * per-hand reward gate, on the REAL table progress listener + hand-complete
 * handler + the hand-rewards block (tests/helpers/indexSource.ts
 * HAND_REWARDS_SRC), the REAL ProgressionManager and REAL PokerTable hands.
 *
 * At 0dc1b96 every dealt-in hand paid its per-hand rewards (5 hand XP, a
 * scratch-card tick, the 'played' daily / weekly windows and missions) whether
 * or not the player ever put a chip in: a fold-only account farmed about
 * 100k-380k chips an hour, and a fold-only big blind that everyone folded to
 * (a WALK) was a won hand for every win reward. Now:
 *   E5  the IDLE_HANDS_REWARD_LIMIT-th (30th) dealt-in hand in a row with no
 *       VOLUNTARY chip (a call, bet, raise or all-in; never a blind, an ante, a
 *       bring-in or a server auto-action) earns nothing, until a voluntary chip;
 *   E6  a walk is not a won hand for rewards (a contested showdown still is);
 *   E7  a scratch tick capped by the daily limit is told ONCE per Denver day
 *       (serverAnnouncement kind 'scratch_daily_limit');
 *   E12 the hand's XP comes from ProgressionManager.handXpFor.
 * (The ProgressionManager unit cases — group cases 8-10 — are the economy
 * lane's tests/econProgressionIdle.test.ts.)
 *
 * Fails on 0dc1b96: no hand-rewards block (HAND_REWARDS_SRC cannot be sliced)
 * and 40 fold-only hands tick 40 times (case 7 shows the HEAD behaviour a world
 * without the block still gets).
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

import { fnSrc, load, flush, SEAT_IDENTITY_SRC, INSURANCE_HISTORY_SRC, HAND_REWARDS_SRC } from './helpers/indexSource';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { Card } from '../src/game/Card';
import { HandRank } from '../src/game/HandEvaluator';
import { ProgressionManager, HAND_XP, IDLE_HANDS_REWARD_LIMIT } from '../src/progression/ProgressionManager';
import { publicNameOf, PUBLIC_NAME_FALLBACK } from '../src/social/publicIdentity';
import { opponentModelKey } from '../src/ai/AIPlayer';
import { progressionHandRank } from '../src/progression/progressionHandRank';

const LISTENER = fnSrc('function ensureTableProgressListener(');
const HAND_COMPLETE = fnSrc('async function handleHandComplete(');
const R3_HELPERS = [
  fnSrc('function chipsWonSeatsOfHand('), fnSrc('function dealtInSeatAccount('), fnSrc('function handHistoryViewerOf('), SEAT_IDENTITY_SRC,
  fnSrc('function seatPlayedByAnotherAccount('), INSURANCE_HISTORY_SRC,
].join('\n');
const HUMAN = 2;

interface Opts { block?: boolean; stud?: boolean; capped?: boolean }
function world(opts: Opts = {}) {
  const block = opts.block !== false;
  const pm = new ProgressionManager();
  pm.hydrateBackoffMs = [0];
  pm.hydrateRetryDelaysMs = [];
  const cfg = { tableId: 'T1', tableName: 'T1', smallBlind: 10, bigBlind: 20, ante: opts.stud ? 5 : 0, minBuyIn: 400 } as any;
  const table: PokerTable = opts.stud ? new SevenStudTable(cfg, false, false) : new PokerTable(cfg);
  table.sitDown(0, 'Bot0', 100_000, 'ai-0', true);
  table.sitDown(1, 'Bot1', 100_000, 'ai-1', true);
  table.sitDown(HUMAN, 'Josh', 100_000, 'player-A', false);
  const playerSessions = new Map<string, any>([['SA', { socketId: 'SA', tableId: 'T1', seatIndex: HUMAN, playerId: 'player-A', playerName: 'Josh', sittingOut: false }]]);
  const authSessions = new Map<string, any>([['SA', { userId: 7, username: 'u7' }]]);
  pm.getOrCreateProgress('player-A', 'Josh', 7);
  const ticks: number[] = [];
  const handXp: number[] = [];
  const realHandXpFor = pm.handXpFor.bind(pm);
  pm.handXpFor = (id: string, full: number) => { const x = realHandXpFor(id, full); handXp.push(x); return x; };
  const announcements: any[] = [];
  const sock = { id: 'SA', connected: true, emit: (ev: string, d: any) => { if (ev === 'serverAnnouncement') announcements.push(d); } };
  let day = '2026-11-04';
  const scope: Record<string, unknown> = {
    tableManager: { getTable: () => table }, playerSessions, authSessions, progressionManager: pm,
    tableProgressListeners: new Set<string>(), bombPotActive: new Map(), GamePhase, PlayerAction, HandRank,
    recordOpponentObservation() {}, opponentModelKey, incrementHandsPlayed() {}, settlePredictionsForHand: async () => {}, processPendingSeatRemovals() {},
    scheduleAutoStart() {}, chipVelocity: new Map(), getUserChips: async () => 0, standUpSuspendedSeatsBeforeDeal() {},
    tickReservedSeatHands() {}, settleInsuranceForHand() {}, captureTournamentBustCheck: () => null,
    runTournamentBustCheck() {}, rekickTournamentDealAfterBustCheck() {}, runPendingTournamentBustChecks() {}, broadcastGameState() {},
    tableCountsForChipsWon: () => true, denverDateKey: () => day, economyStats: { chipsWonWrites: 0, chipsWonWriteFailures: 0 },
    potCountsForWalletRewards: () => true,
    recordChipWins: async () => {}, recordClubHand() {}, publicNameOf, PUBLIC_NAME_FALLBACK, recordHand: async () => {},
    progressionHandRank, pushActivity() {},
    mergeUserStats: async () => {}, saveProgress: async () => true,
    tickScratchProgress: async (uid: number) => { ticks.push(uid); return { awarded: false, chips: 1, stars: 2, scratchCardsAvailable: 0, capped: !!opts.capped }; },
    sendProgressToPlayer() {},
    io: { sockets: { sockets: new Map([['SA', sock]]) }, to: () => ({ emit() {} }), emit() {} },
    multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
    // the hand-rewards block's reads
    HAND_XP, IDLE_HANDS_REWARD_LIMIT, SCRATCH_CARDS_PER_DAY: 10, tableKindOf: () => 'cash',
    console: { log() {}, warn() {}, error() {} },
  };
  const code = `${LISTENER}\n${HAND_COMPLETE}\n${R3_HELPERS}${block ? `\n${HAND_REWARDS_SRC}` : ''}`;
  const { exports: m, stubbed } = load(code, scope, block ? '{ ensureTableProgressListener, handleHandComplete, handRewardStats, botFlowStats }' : '{ ensureTableProgressListener, handleHandComplete }');
  m.ensureTableProgressListener(table, 'T1');
  return { m, pm, table, ticks, handXp, announcements, stubbed, setDay: (d: string) => { day = d; } };
}
type W = ReturnType<typeof world>;

/**
 * One real hand. Bots: the first bot to act raises once (a fixed-limit / Stud bot completes),
 * then every bot calls / checks. The human: 'idle' checks when free, else folds; 'call' calls
 * once when facing a bet; 'auto' is a server auto-action call (markAutoAction, then playerCall).
 */
async function hand(w: W, human: 'idle' | 'call' | 'auto' = 'idle', bots: 'raise' | 'fold' | 'limp' = 'raise'): Promise<void> {
  const t = w.table;
  expect(t.startNewHand()).toBe(true);
  let raised = false;
  let humanActed = false;
  for (let g = 0; g < 300 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    const seat = t.seats[a];
    const owe = t.getCallAmount(seat);
    if (seat.isAI) {
      if (bots === 'fold' && owe > 0) { t.playerFold(a); continue; }
      if (bots === 'raise' && !raised) {
        raised = true;
        if (t.playerRaise(a, t.currentBetToMatch + t.config.bigBlind * 2)) continue;
      }
      if (owe > 0) { if (!t.playerCall(a)) t.playerFold(a); } else if (!t.playerCheck(a)) t.playerFold(a);
    } else if (owe > 0 && human === 'call' && !humanActed) {
      humanActed = true;
      expect(t.playerCall(a)).toBe(true);
    } else if (owe > 0 && human === 'auto' && !humanActed) {
      humanActed = true;
      t.markAutoAction(a, 'away');
      expect(t.playerCall(a)).toBe(true);
    } else if (owe > 0) t.playerFold(a);
    else t.playerCheck(a);
  }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
  await flush();
}
async function hands(w: W, n: number, human: 'idle' | 'call' | 'auto' = 'idle') { for (let i = 0; i < n; i++) await hand(w, human); }
const A = (w: W) => w.pm.getProgress('player-A')! as any;

describe('E5 — the 30th idle hand in a row earns nothing until a voluntary chip', () => {
  it('(1) fold-only for 40 hands: 29 scratch ticks (0dc1b96: 40), hand XP 5 x 29, weeklyStats.handsPlayed 29, xpSkipped 11', async () => {
    const w = world();
    await flush();
    await hands(w, 40);
    expect(w.ticks).toHaveLength(29);
    expect(w.handXp).toEqual(new Array(29).fill(5));
    expect(A(w).weeklyStats.handsPlayed).toBe(29);
    expect(A(w).dailyStats.handsPlayed).toBe(29);
    expect(A(w).totalHandsPlayed).toBe(29);                    // E13 (economy lane): the lifetime count stops too
    expect(w.m.handRewardStats).toMatchObject({ xpSkipped: 11, scratchTicksSkipped: 11, walksNotCounted: 0 });
    // the human really posted blinds in those hands — and blinds are never participation
    expect(w.table.seats[HUMAN].chipCount).toBeLessThan(100_000);
    // E9 wiring: handleHandComplete fed every hand's bot flow (what he lost went to the bots)
    expect(w.m.botFlowStats.formats.get('cash:holdem')).toMatchObject({ hands: 40, humanNet: w.table.seats[HUMAN].chipCount - 100_000, accountNet: w.table.seats[HUMAN].chipCount - 100_000 });
    // nothing the gate relies on is an inert stub (only side monitors this world does not wire are)
    expect([...w.stubbed].filter((n) => /articipation|handRewardStats|handXp|HAND_XP|IDLE_HANDS|scratchCap|SCRATCH_|BotFlow|botFlow|tickScratchProgress|progressionManager|denverDateKey|tableKindOf|dealtInSeatAccount/.test(n))).toEqual([]);
  }, 60_000);

  it('(2) reset: after 35 idle hands one CALL earns, and so do the next 29 idle hands (the 30th does not)', async () => {
    const w = world();
    await flush();
    await hands(w, 35);
    expect(w.ticks).toHaveLength(29);
    await hand(w, 'call');
    expect(w.ticks).toHaveLength(30);
    await hands(w, 29);
    expect(w.ticks).toHaveLength(59);
    await hand(w);
    expect(w.ticks).toHaveLength(59);
  }, 60_000);

  it('(3) eviction does not reset the run: the record evicted (31 min idle) and re-created, the next idle hand still earns nothing', async () => {
    const w = world();
    await flush();
    await hands(w, 29);
    expect(w.ticks).toHaveLength(29);
    const t0 = Date.now();
    w.pm.now = () => t0 + 31 * 60_000;
    expect(w.pm.evictIdle(() => false)).toHaveLength(1);
    expect(w.pm.getProgress('player-A')).toBeUndefined();
    w.pm.getOrCreateProgress('player-A', 'Josh', 7);
    await flush();
    await hand(w);
    expect(w.ticks).toHaveLength(29);
    expect(w.m.handRewardStats.xpSkipped).toBe(1);
  }, 60_000);

  it('(4) a server AUTO-action call (markAutoAction, then playerCall) is not participation', async () => {
    const w = world();
    await flush();
    await hands(w, 29);
    await hand(w, 'auto');
    expect(w.table.actionLog.some((e: any) => e.seatIndex === HUMAN && /^called/.test(e.action) && e.auto)).toBe(true);
    expect(w.ticks).toHaveLength(29);
    // CONTROL: his own call the hand after does reset it
    await hand(w, 'call');
    expect(w.ticks).toHaveLength(30);
  }, 60_000);

  it('(5) Seven Card Stud: the antes and the bring-in are never participation', async () => {
    const w = world({ stud: true });
    const bringIns: number[] = [];
    w.table.on('blindPosted', (d: any) => { if (d.type === 'bring-in' && d.seatIndex === HUMAN) bringIns.push(d.amount); });
    await flush();
    await hands(w, 30);
    expect(w.table.seats[HUMAN].chipCount).toBeLessThan(100_000);    // antes posted every hand
    expect(bringIns.length).toBeGreaterThan(0);                       // and he posted the bring-in in some of them
    expect(w.ticks).toHaveLength(29);
    expect(w.m.handRewardStats.xpSkipped).toBe(1);
  }, 60_000);
});

/** Deal hands (the human idle) until the NEXT deal makes him the big blind; returns with that hand dealt. */
async function dealHumanBigBlind(w: W): Promise<void> {
  for (let g = 0; g < 6; g++) {
    expect(w.table.startNewHand()).toBe(true);
    if (w.table.seats[HUMAN].totalInvestedThisHand === w.table.config.bigBlind) return;
    // not his big blind: finish this hand idle
    let raised = false;
    for (let k = 0; k < 300 && w.table.isHandInProgress(); k++) {
      const a = w.table.activeSeatIndex; const s = w.table.seats[a]; const owe = w.table.getCallAmount(s);
      if (s.isAI) {
        if (!raised) { raised = true; if (w.table.playerRaise(a, w.table.currentBetToMatch + 40)) continue; }
        if (owe > 0) w.table.playerCall(a); else w.table.playerCheck(a);
      } else if (owe > 0) w.table.playerFold(a); else w.table.playerCheck(a);
    }
    await flush();
  }
  throw new Error('the human never got the big blind');
}
const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).map((x) => ({ rank: RANKS[x[0]], suit: SUITS[x[1]] } as Card));
/** The human holds AA, the bots 7-2 and 8-3; the board (burn, flop, burn, turn, burn, river) gives them nothing. */
function rigHumanWins(t: PokerTable) {
  t.seats[HUMAN].holeCards = cs('As Ah');
  t.seats[0].holeCards = cs('7c 2d');
  t.seats[1].holeCards = cs('8h 3s');
  const b = cs('Kd 9h 5c Js Qd');
  const used = new Set([...t.seats[0].holeCards, ...t.seats[1].holeCards, ...t.seats[HUMAN].holeCards, ...b].map((c) => c.suit * 16 + c.rank));
  const rest: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) if (!used.has(suit * 16 + rank)) rest.push({ suit, rank } as Card);
  const deck = (t as any).deck;
  deck.cards = [rest[0], b[0], b[1], b[2], rest[1], b[3], rest[2], b[4], ...rest.slice(3)];
  deck.currentIndex = 0;
}
/** Finish the dealt hand: bots `bots`, the human checks when free (folds when not). */
async function finish(w: W, bots: 'fold' | 'limp') {
  for (let k = 0; k < 300 && w.table.isHandInProgress(); k++) {
    const a = w.table.activeSeatIndex; const s = w.table.seats[a]; const owe = w.table.getCallAmount(s);
    if (s.isAI) {
      if (owe > 0) { if (bots === 'fold') w.table.playerFold(a); else w.table.playerCall(a); } else w.table.playerCheck(a);
    } else if (owe > 0) w.table.playerFold(a); else w.table.playerCheck(a);
  }
  expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
  await flush();
}
const won = (w: W) => ({ total: A(w).handsWon, weekly: A(w).weeklyStats.handsWon, daily: A(w).dailyStats.handsWon });

describe('E6 — a walk is not a won hand for rewards', () => {
  it('(6) everyone folds to the human\'s big blind: handsWon / weekly / daily unchanged, walksNotCounted 1 (0dc1b96: +1); chips still won', async () => {
    const w = world();
    await flush();
    await dealHumanBigBlind(w);
    const before = won(w);
    const stack = w.table.seats[HUMAN].chipCount + w.table.seats[HUMAN].totalInvestedThisHand;
    await finish(w, 'fold');
    expect(w.table.seats[HUMAN].chipCount).toBe(stack + 10);   // he took the small blind
    expect((w.table as any).wentToShowdown).toBe(false);
    expect(won(w)).toEqual(before);
    expect(w.m.handRewardStats.walksNotCounted).toBe(1);
  }, 60_000);

  it('(6) CONTROL — a contested showdown won with no voluntary chip (a checked-down big blind) counts +1', async () => {
    const w = world();
    await flush();
    await dealHumanBigBlind(w);
    rigHumanWins(w.table);
    const before = won(w);
    await finish(w, 'limp');
    expect((w.table as any).wentToShowdown).toBe(true);
    expect(w.table.seats[HUMAN].chipCount).toBeGreaterThan(100_000 - 20);
    expect(won(w)).toEqual({ total: before.total + 1, weekly: before.weekly + 1, daily: before.daily + 1 });
    expect(w.m.handRewardStats.walksNotCounted).toBe(0);
  }, 60_000);
});

describe('E5 / E6 — a world without the hand-rewards block keeps the 0dc1b96 behaviour', () => {
  it('(7) takeHandParticipation stubbed: 40 fold-only hands tick 40 times at 5 XP; a walk is a won hand', async () => {
    const w = world({ block: false });
    await flush();
    await hands(w, 40);
    expect(w.ticks).toHaveLength(40);
    expect(A(w).weeklyStats.handsPlayed).toBe(40);
    expect([...w.stubbed]).toEqual(expect.arrayContaining(['takeHandParticipation', 'handXpForHand']));
    await dealHumanBigBlind(w);
    const before = won(w);
    await finish(w, 'fold');
    expect(won(w).total).toBe(before.total + 1);
  }, 60_000);
});

describe('E7 — the daily scratch-card limit is told once per Denver day', () => {
  it('a capped tick twice on one day -> ONE serverAnnouncement {kind: scratch_daily_limit}; the next day -> one more', async () => {
    const w = world({ capped: true });
    await flush();
    await hands(w, 2);
    expect(w.ticks).toHaveLength(2);
    expect(w.announcements).toHaveLength(1);
    expect(w.announcements[0]).toMatchObject({ kind: 'scratch_daily_limit' });
    expect(w.announcements[0].message).toBe('Daily scratch card limit reached: 10 cards from hands today. Hands bank cards again tomorrow.');
    w.setDay('2026-11-05');
    await hand(w);
    expect(w.announcements).toHaveLength(2);
    expect(w.m.handRewardStats).toMatchObject({ scratchCapped: 3, capNotices: 2, scratchAwarded: 0 });
  }, 60_000);
});

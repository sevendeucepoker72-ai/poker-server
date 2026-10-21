/**
 * .online R3 fixes (SF-B, 2026-10-11) — economy / progression / season / hand
 * history storage, on the REAL code (src/index.ts slices on a real PokerTable,
 * the real economyDb settlements on a scripted client):
 *   S3-1  Battle Pass premium = the R2 purchase row or the TOP-LEVEL pre-R2
 *         stats flag — never a substring of the stats text (a client-written
 *         stats.clientData.battlePassPremium unlocked every premium tier);
 *   S3-2  chips won is recorded per dealt-in human SEAT, by account: a player
 *         who LEAVES or DROPS during the runout still gets his negative row;
 *   S3-3  users.chips → BIGINT only after the previous container is gone;
 *   XL-2  a season that ended before the chips-won ledger existed is never
 *         awarded and never MARKED awarded (the admin gets a clear status);
 *   H1    each recipient's handHistory names the table, his seat and his own
 *         cards; a stored record never carries a hidden hand's name.
 * (S3-4 is in progressionPerUser.test.ts; E1 in economyCatalog / economyHandlers.)
 */
import fs from 'fs';
import path from 'path';
import { SRC, fnSrc, handlerSrc, load, flush, deferred, SEAT_TEARDOWN_SRC, SEAT_IDENTITY_SRC, INSURANCE_HISTORY_SRC } from './helpers/indexSource';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { HandRank } from '../src/game/HandEvaluator';
import { Card, cardToString } from '../src/game/Card';
import { publicNameOf, PUBLIC_NAME_FALLBACK } from '../src/social/publicIdentity';
import { sanitizeClientProgressSave } from '../src/progression/clientProgressSave';
import { mergeProgressStats } from '../src/progression/progressMerge';
import { FIRST_CHIPS_WON_SEASON } from '../src/economy/catalog';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-r3-economy';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const edb = require('../src/economy/economyDb') as typeof import('../src/economy/economyDb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const am = require('../src/auth/authManager') as typeof import('../src/auth/authManager');

const quiet = { log() {}, warn() {}, error() {} };

/** A scripted pg client / pool: every statement is logged (whitespace-collapsed) and answered by `answer`. */
type Reply = { rows?: any[]; rowCount?: number } | Error;
function scripted(answer: (sql: string, params: unknown[]) => Reply = () => ({})) {
  const log: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const head = sql.replace(/\s+/g, ' ').trim();
      log.push(head);
      const r = answer(head, params);
      if (r instanceof Error) throw r;
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? (r.rows ? r.rows.length : 0) };
    },
    release: () => {},
  };
  const pool = { connect: async () => client, query: client.query } as unknown as import('../src/economy/economyDb').TxPool;
  return { log, pool };
}

// ─────────────────────────────── S3-1 ───────────────────────────────

describe('S3-1 — Battle Pass premium is never unlocked by a client-written stats value', () => {
  /** users.stats TEXT + the premium table; answers EVERY column either version of the query selects. */
  const premiumDb = (statsText: string, owned = false) => ({
    query: async (_sql: string) => ({
      rows: [{ owned, stats: statsText, legacy: statsText.includes('"battlePassPremium":true') }],
    }),
  });
  /** The real D4 save path, then a COMPACT stats rewrite (mergeUserStats after the next hand). */
  const exploitedStatsText = (): string => {
    const save = sanitizeClientProgressSave({ stats: { clientData: { battlePassPremium: true } } });
    expect(save.data).toEqual({ stats: { clientData: { battlePassPremium: true } } });   // D4 lets clientData through
    // saveProgress: `stats || $1::jsonb` (Postgres jsonb text, spaced), then the hand-complete merge (compact):
    const jsonbText = JSON.stringify({ handsPlayed: 812, ...save.data.stats }).replace(/":/g, '": ');
    return JSON.stringify(mergeProgressStats(JSON.parse(jsonbText), { handsPlayed: 813 }));
  };

  it('stats {clientData:{battlePassPremium:true}} compact-serialized, no premium row → NOT premium', async () => {
    const text = exploitedStatsText();
    expect(text).toContain('"battlePassPremium":true');     // what the old substring test matched
    expect(await edb.hasBattlePassPremium(7, 'season_1_the_river', premiumDb(text))).toBe(false);
  });

  it('CONTROL — the pre-R3 substring clause (position(...) > 0 AS legacy) unlocked it', async () => {
    const PRE_R3 = async (userId: number, seasonId: string, db: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => {
      const { rows } = await db.query(
        `SELECT EXISTS (SELECT 1 FROM user_battle_pass_premium WHERE user_id = $1 AND season_id = $2) AS owned,
                position('"battlePassPremium":true' in COALESCE((SELECT stats::text FROM users WHERE id = $1), '')) > 0 AS legacy`,
        [userId, seasonId],
      );
      return !!(rows[0]?.owned || rows[0]?.legacy);
    };
    expect(await PRE_R3(7, 'season_1_the_river', premiumDb(exploitedStatsText()))).toBe(true);
  });

  it('the purchase row, or the TOP-LEVEL pre-R2 flag, still count; corrupt stats text is not premium (never throws)', async () => {
    expect(await edb.hasBattlePassPremium(7, 's', premiumDb('{}', true))).toBe(true);
    expect(await edb.hasBattlePassPremium(7, 's', premiumDb('{"handsPlayed":3,"battlePassPremium":true}'))).toBe(true);
    expect(await edb.hasBattlePassPremium(7, 's', premiumDb('{"battlePassPremium":"true"}'))).toBe(false);
    expect(await edb.hasBattlePassPremium(7, 's', premiumDb('{oops'))).toBe(false);
    expect(await edb.hasBattlePassPremium(7, 's', premiumDb(''))).toBe(false);
  });

  it('no server path tests an entitlement by a substring of the stats text any more', () => {
    const econ = fs.readFileSync(path.join(__dirname, '..', 'src', 'economy', 'economyDb.ts'), 'utf8');
    expect(econ).not.toContain(`position('"battlePassPremium":true'`);
    expect(SRC).not.toContain(`position('"battlePassPremium"`);
  });
});

// ─────────────────────────────── XL-2 ───────────────────────────────

describe('XL-2 — a season before the chips-won ledger is never awarded or marked', () => {
  /** A fresh R2 DB: empty ledger, no run marker, no legacy award rows. */
  const freshDb = () => scripted((h) => {
    if (h.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (h.startsWith('SELECT 1 FROM season_award_runs')) return { rows: [] };
    if (h.startsWith('SELECT 1 FROM season_leaderboard_awards')) return { rows: [] };
    if (h.startsWith('SELECT w.user_id')) return { rows: [] };            // chipsWonStandings over the empty ledger
    if (h.startsWith('INSERT INTO season_award_runs')) return { rowCount: 1 };
    return {};
  });

  it(`the first ledger season is ${FIRST_CHIPS_WON_SEASON}`, () => {
    expect(FIRST_CHIPS_WON_SEASON).toBe('2026-10');
  });

  it('awardSeason(2026-09) on the first R2 boot → pre_ledger, and NOT ONE statement (no season_award_runs marker)', async () => {
    const { log, pool } = freshDb();
    expect(await edb.awardSeason('2026-09', 'boot', pool)).toEqual({ status: 'pre_ledger', seasonKey: '2026-09', winners: [] });
    expect(await edb.awardSeason('2025-12', 'admin:1', pool)).toMatchObject({ status: 'pre_ledger' });
    expect(log).toEqual([]);
  });

  it('CONTROL — a ledger month with no eligible winner IS marked (that rule still holds from 2026-10 on)', async () => {
    const { log, pool } = freshDb();
    expect(await edb.awardSeason('2026-10', 'sweep', pool)).toEqual({ status: 'awarded', seasonKey: '2026-10', winners: [] });
    expect(log.filter((h) => h.startsWith('INSERT INTO season_award_runs'))).toHaveLength(1);
  });

  it('the boot / 10-minute sweep: September is reported pre_ledger, nothing announced, nothing written', async () => {
    const { log, pool } = freshDb();
    const announceSeasonAward = jest.fn();
    const economyStats = { seasonSweeps: 0, seasonAwards: 0, seasonSweepErrors: 0, lastSeasonSweep: null as any };
    const sweep = load(fnSrc('async function sweepSeasonAwards('), {
      previousDenverMonthKey: () => '2026-09', awardSeason: (k: string, t: string) => edb.awardSeason(k, t, pool),
      economyStats, announceSeasonAward, console: quiet,
    }, 'sweepSeasonAwards').exports;
    await sweep('boot');
    await sweep('sweep');
    expect(economyStats.lastSeasonSweep).toMatchObject({ seasonKey: '2026-09', status: 'pre_ledger' });
    expect(economyStats.seasonAwards).toBe(0);
    expect(announceSeasonAward).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('the admin runSeasonLeaderboardAward answers pre_ledger_season for a pre-ledger month (and it stays payable later)', async () => {
    const { log, pool } = freshDb();
    const emitted: Array<[string, any]> = [];
    const handlers: Record<string, (d?: any) => Promise<void>> = {};
    const socket = { id: 'adm', emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { handlers[ev] = fn; } };
    const announceSeasonAward = jest.fn();
    const wire = load(`function wire(socket) {\n${handlerSrc('runSeasonLeaderboardAward', '\n  });\n')}\n}`, {
      authSessions: new Map([['adm', { userId: 1, username: 'admin' }]]), isUserAdmin: async () => true,
      denverMonthKey: () => '2026-10', previousDenverMonthKey: () => '2026-09',
      awardSeason: (k: string, t: string) => edb.awardSeason(k, t, pool), FIRST_CHIPS_WON_SEASON,
      announceSeasonAward, seasonAwardPublicResults: () => [], console: quiet,
    }, 'wire').exports;
    wire(socket);
    await handlers.runSeasonLeaderboardAward({});
    await handlers.runSeasonLeaderboardAward({ seasonKey: '2026-08' });
    expect(emitted).toEqual([
      ['seasonLeaderboardAwarded', { success: false, error: 'pre_ledger_season', seasonKey: '2026-09', firstSeason: '2026-10' }],
      ['seasonLeaderboardAwarded', { success: false, error: 'pre_ledger_season', seasonKey: '2026-08', firstSeason: '2026-10' }],
    ]);
    expect(announceSeasonAward).not.toHaveBeenCalled();
    expect(log).toEqual([]);   // no run marker: an owner-approved rule can still pay September later
  });
});

// ─────────────────────────────── S3-3 ───────────────────────────────

describe('S3-3 — the users.chips BIGINT migration waits for the previous container', () => {
  function migrationWorld(results: string[], otherServers: number[] = []) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const wait = deferred();
    const migrate = jest.fn(async () => results.shift() ?? 'already_bigint');
    const waitForPreviousInstanceGone = jest.fn(() => wait.p);
    // R3 review (SF-B-2) — the narrowed "another poker-server is connected" check.
    const countOtherPokerServerSessions = jest.fn(async () => otherServers.shift() ?? 0);
    const economyStats = { bigintMigration: 'pending' };
    const schedule = load(fnSrc('function scheduleChipsBigintMigration('), {
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return { unref() {} }; },
      MERGE_START_DELAY_MS: 20_000, waitForPreviousInstanceGone, migrateUsersChipsToBigint: migrate,
      countOtherPokerServerSessions, BIGINT_GATE_POLL_MS: 30_000,
      getPool: () => ({}), economyStats, console: quiet,
    }, 'scheduleChipsBigintMigration').exports;
    return { schedule, timers, wait, migrate, waitForPreviousInstanceGone, countOtherPokerServerSessions, economyStats };
  }

  it('R3 review (SF-B-2): the old build still connected after the 60s wait → NO ALTER; re-checked every 30s, migrated only once it is gone', async () => {
    const w = migrationWorld(['migrated'], [2, 1, 0]);
    w.schedule();
    w.timers[0].fn();
    (w.wait.resolve as (v: unknown) => void)({ olderConnections: 4, waitedMs: 60_000 });   // the wait gave up with the old container's sessions open
    await flush();
    expect(w.migrate).not.toHaveBeenCalled();
    expect(w.economyStats.bigintMigration).toBe('waiting_for_previous_instance');
    expect(w.countOtherPokerServerSessions).toHaveBeenCalledTimes(1);
    expect(w.timers.map((t) => t.ms)).toEqual([20_000, 30_000]);
    w.timers[1].fn();                                             // still 1 other server session
    await flush();
    expect(w.migrate).not.toHaveBeenCalled();
    w.timers[2].fn();                                             // gone
    await flush();
    expect(w.migrate).toHaveBeenCalledTimes(1);
    expect(w.economyStats.bigintMigration).toBe('migrated');
  });

  it('CONTROL — the pre-review scheduler (wait result discarded) ALTERs while the old build is still connected', async () => {
    const fn = fnSrc('function scheduleChipsBigintMigration(');
    const gate = 'if (older > 0) { await recheck(); return; }';
    expect(fn).toContain(gate);
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const wait = deferred();
    const migrate = jest.fn(async () => 'migrated');
    const schedule = load(fn.split(gate).join(''), {
      setTimeout: (f: () => void, ms: number) => { timers.push({ fn: f, ms }); return { unref() {} }; },
      MERGE_START_DELAY_MS: 20_000, waitForPreviousInstanceGone: () => wait.p, migrateUsersChipsToBigint: migrate,
      countOtherPokerServerSessions: async () => 4, BIGINT_GATE_POLL_MS: 30_000,
      getPool: () => ({}), economyStats: { bigintMigration: 'pending' }, console: quiet,
    }, 'scheduleChipsBigintMigration').exports;
    schedule();
    timers[0].fn();
    (wait.resolve as (v: unknown) => void)({ olderConnections: 4, waitedMs: 60_000 });
    await flush();
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('nothing at boot; MERGE_START_DELAY_MS later it waits for the old instance; only then the ALTER', async () => {
    const w = migrationWorld(['migrated']);
    w.schedule();
    expect(w.migrate).not.toHaveBeenCalled();
    expect(w.economyStats.bigintMigration).toBe('waiting_for_previous_instance');
    expect(w.timers.map((t) => t.ms)).toEqual([20_000]);
    w.timers[0].fn();
    await flush();
    expect(w.waitForPreviousInstanceGone).toHaveBeenCalledTimes(1);
    expect(w.migrate).not.toHaveBeenCalled();               // the old build may still be serving
    w.wait.resolve();
    await flush();
    expect(w.migrate).toHaveBeenCalledTimes(1);
    expect(w.economyStats.bigintMigration).toBe('migrated');
  });

  it('a busy table lock is retried a minute later (10 tries)', async () => {
    const w = migrationWorld(['lock_timeout', 'migrated']);
    w.schedule();
    w.timers[0].fn();
    w.wait.resolve();
    await flush();
    expect(w.economyStats.bigintMigration).toBe('lock_timeout');
    expect(w.timers.map((t) => t.ms)).toEqual([20_000, 60_000]);
    w.timers[1].fn();
    await flush();
    expect(w.migrate).toHaveBeenCalledTimes(2);
    expect(w.economyStats.bigintMigration).toBe('migrated');
  });

  it('wiring: the boot chain only schedules it; the one migrateUsersChipsToBigint call is behind the wait', () => {
    const boot = SRC.slice(SRC.indexOf('initDB().then(async () => {'));
    expect(boot).toContain('scheduleChipsBigintMigration();');
    expect(SRC.split('migrateUsersChipsToBigint(').length - 1).toBe(1);
    const fn = fnSrc('function scheduleChipsBigintMigration(');
    expect(fn.indexOf('await waitForPreviousInstanceGone(')).toBeGreaterThan(-1);
    expect(fn.lastIndexOf('await run(1);')).toBeGreaterThan(fn.indexOf('await waitForPreviousInstanceGone('));
    // R3 review (SF-B-2): the recheck path migrates only when no other poker-server session is left
    expect(fn).toContain('if (others === 0) { await run(1); return; }');
    expect(fn).toContain('delayMs: number = MERGE_START_DELAY_MS');
  });

  it('AGENT.md Rollback says how to go back below R2 (chips → INTEGER, the trigger dropped and re-created)', () => {
    const agent = fs.readFileSync(path.join(__dirname, '..', 'AGENT.md'), 'utf8');
    const rollback = agent.slice(agent.indexOf('## Rollback'), agent.indexOf('## Common workflows'));
    expect(rollback).toContain('ALTER TABLE users ALTER COLUMN chips TYPE INTEGER;');
    expect(rollback).toContain('DROP TRIGGER trg_redirect_merged_account_credit ON users;');
    expect(rollback).toContain('EXECUTE FUNCTION redirect_merged_account_credit();');
    expect(rollback).toContain('2147483647');
  });
});

// ─────────────────────────────── S3-2 + H1 (a real hand) ───────────────────────────────

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const cardKey = (c: Card) => c.suit * 16 + c.rank;
const ser = (c: Card) => ({ suit: c.suit, rank: c.rank, display: cardToString(c) });
/** Fix both humans' hole cards and the board (burn, flop, burn, turn, burn, river) after the deal. */
function rig(t: PokerTable, alice: string, bob: string, board: string) {
  t.seats[1].holeCards = cs(alice);
  t.seats[2].holeCards = cs(bob);
  const b = cs(board);
  const used = new Set([...t.seats[0].holeCards, ...t.seats[1].holeCards, ...t.seats[2].holeCards, ...b].map(cardKey));
  const rest: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) if (!used.has(suit * 16 + rank)) rest.push({ suit, rank } as Card);
  const deck = (t as any).deck;
  deck.cards = [rest[0], b[0], b[1], b[2], rest[1], b[3], rest[2], b[4], ...rest.slice(3)];
  deck.currentIndex = 0;
}

const HAND_CODE = [
  SEAT_TEARDOWN_SRC,
  fnSrc('function processPendingSeatRemovals('),
  fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind'),
  fnSrc('function reserveSeatForDeparture('),
  fnSrc('function seatPlayedByAnotherAccount('),
  fnSrc('function chipsWonSeatsOfHand('),
  fnSrc('function dealtInSeatAccount('),
  fnSrc('function handHistoryViewerOf('),
  fnSrc('function ensureTableProgressListener('),
  INSURANCE_HISTORY_SRC,   // G165 — the listener's player rows go through withInsuranceSettlement
  fnSrc('async function handleHandComplete('),
].join('\n');

/**
 * Public cash table T1 (SB 10 / BB 20): Bot (button, seat 0), Alice (SB, seat 1,
 * user 7), Bob (BB, seat 2, user 8), 2,000 each. The REAL seat teardown, leave,
 * departure reservation, table listener and hand-complete handler.
 */
function handWorld(kind: 'cash' | 'club' = 'cash') {
  const table = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
  table.sitDown(0, 'Bot', 2000, 'ai-1', true);
  table.sitDown(1, 'Alice', 2000, 'player-A', false);
  table.sitDown(2, 'Bob', 2000, 'player-B', false);
  const playerSessions = new Map<string, any>([
    ['SA', { socketId: 'SA', tableId: 'T1', seatIndex: 1, playerId: 'player-A', playerName: 'Alice', sittingOut: false }],
    ['SB', { socketId: 'SB', tableId: 'T1', seatIndex: 2, playerId: 'player-B', playerName: 'Bob', sittingOut: false }],
  ]);
  const authSessions = new Map<string, any>([['SA', { userId: 7, username: 'u7' }], ['SB', { userId: 8, username: 'u8' }]]);
  const reservedSeats = new Map<number, any>();
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const sockets = new Map<string, any>();
  const mkSock = (id: string) => {
    const s = { id, emitted: [] as Array<[string, any]>, emit: (ev: string, d: any) => s.emitted.push([ev, d]), leave() {}, join() {} };
    sockets.set(id, s);
    return s;
  };
  const chipsWon: Array<{ userId: number; net: number }> = [];
  const club: Array<{ userId: number; net: number; pot: number }> = [];
  const stored: Array<{ userId: number; handId: string; data: any }> = [];
  const credited: Array<{ userId: number; chips: number }> = [];
  let handDone: () => void = () => {};
  const done = new Promise<void>((r) => { handDone = r; });
  const progressionManager = new Proxy({}, {
    get: (_t, k) => (k === 'getClientProgress' ? () => ({ hydrated: true, xp: 1, level: 1, achievements: [] })
      : k === 'getProgress' ? () => ({}) : () => undefined),
  });
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 'T1' ? table : undefined) },
    playerSessions, authSessions, multiTableSessions: new Map(), reservedSeats, pendingSeatRemovalAfterHand,
    progressionManager, tableProgressListeners: new Set(), bombPotActive: new Map(), GamePhase, PlayerAction, HandRank, cardToString,
    recordOpponentObservation() {}, incrementHandsPlayed() {}, settlePredictionsForHand: async () => {}, scheduleAutoStart() {},
    standUpSuspendedSeatsBeforeDeal() {}, tickReservedSeatHands() {}, settleInsuranceForHand() {}, captureTournamentBustCheck: () => null,
    runTournamentBustCheck: () => { handDone(); }, rekickTournamentDealAfterBustCheck() {}, runPendingTournamentBustChecks() {},
    broadcastGameState() {}, tableCountsForChipsWon: () => kind === 'cash', tableFeedsClubStats: () => kind === 'club',
    denverDateKey: () => '2026-10-11', economyStats: { chipsWonWrites: 0, chipsWonWriteFailures: 0 },
    recordChipWins: async (userId: number, _day: string, net: number) => { chipsWon.push({ userId, net }); },
    recordClubHand: (_t: string, entries: any[]) => { club.push(...entries); },
    publicNameOf, PUBLIC_NAME_FALLBACK, pushActivity() {},
    recordHand: async (userId: number, handId: string, data: any) => { stored.push({ userId, handId, data }); },
    mergeUserStats: async () => {}, saveProgress: async () => true, tickScratchProgress: async () => false, sendProgressToPlayer() {},
    io: { sockets: { sockets }, to: () => ({ emit() {} }), emit() {} },
    sitOutTracker: new Map(), isTournamentTable: () => false, isFixedRosterQuickTable: () => false,
    creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any) => { credited.push({ userId, chips: seat.chipCount }); },
    scheduleAIAction() {}, syncSitOutToTable() {}, leavePrizeFormatSeat: () => false, keepTournamentSeatOnLeave: () => false,
    releaseSeatedSlot() {}, quickTables: new Set(), spectators: new Map(), lastEmoteTime: new Map(), lastReactionTime: new Map(),
    lastChatTime: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), botStripAfterHand: new Set(),
    DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], FiveCardDrawTable: class {},
    SEAT_RESERVE_MS: 600_000, DISCONNECT_HANDS_LIMIT: 20, reservationsDisplaced: { count: 0 }, shutdownFlushActive: () => false,
    setTimeout: (fn: () => void, ms: number) => ({ fn, ms, unref() {} }), clearTimeout() {},
    console: quiet,
  };
  const { exports: m, stubbed } = load(HAND_CODE, scope,
    '{ handlePlayerLeave, reserveSeatForDeparture, ensureTableProgressListener, handleHandComplete, dealtInSeatAccount }');
  m.ensureTableProgressListener(table, 'T1');
  const finished = async () => {
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done, new Promise((r) => { t = setTimeout(r, 3000); })]);
    clearTimeout(t);
    await flush();
  };
  return { table, m, stubbed, playerSessions, authSessions, reservedSeats, pendingSeatRemovalAfterHand, chipsWon, club, stored, credited, sockets, mkSock, finished };
}

/** Bot folds, Alice (AA) shoves, Bob (72) calls: both all-in, the runout HELD (the R1 insurance window). Alice wins. */
function allInHeld(w: ReturnType<typeof handWorld>) {
  w.table.runoutHoldDecider = () => true;
  expect(w.table.startNewHand()).toBe(true);
  rig(w.table, 'As Ah', '7c 2d', 'Ks 9h 5c 3s Jd');
  for (let g = 0; g < 10 && w.table.currentPhase === GamePhase.PreFlop && !w.table.isRunoutHeld(); g++) {
    const a = w.table.activeSeatIndex;
    if (a === 0) expect(w.table.playerFold(0)).toBe(true);
    else if (a === 1) expect(w.table.playerAllIn(1)).toBe(true);
    else if (a === 2) expect(w.table.playerCall(2)).toBe(true);
  }
  expect(w.table.isRunoutHeld()).toBe(true);
  expect([w.table.seats[1].allIn, w.table.seats[2].allIn]).toEqual([true, true]);
}

describe('S3-2 — chips won is recorded per dealt-in human SEAT, by account', () => {
  it('CONTROL — both stay: Alice +2,000, Bob −2,000', async () => {
    const w = handWorld();
    allInHeld(w);
    w.table.releaseRunoutHold();
    await w.finished();
    expect([w.table.seats[1].chipCount, w.table.seats[2].chipCount]).toEqual([4000, 0]);
    expect(w.chipsWon).toEqual([{ userId: 7, net: 2000 }, { userId: 8, net: -2000 }]);
    // only the side monitors are inert in this world — every path the assertions rely on is real
    expect([...w.stubbed].filter((n) => !n.includes('.')).sort()).toEqual(['opponentModelKey', 'recordChipVelocity', 'recordRevealedCommitment', 'standUpSeatsPastSitOutLimit']);   // + the AI opponent-model key (R3 GAME-P3-10, imported from AIPlayer)
  });

  it('Bob taps Leave during the runout hold (his seat kept for the hand): his −2,000 is STILL recorded', async () => {
    const w = handWorld();
    allInHeld(w);
    w.m.handlePlayerLeave({ id: 'SB', leave() {}, emit() {} });
    expect(w.playerSessions.has('SB')).toBe(false);                       // his session is gone at once
    expect([...(w.pendingSeatRemovalAfterHand.get('T1')?.keys() ?? [])]).toEqual([2]);   // the seat waits for the hand's end
    w.table.releaseRunoutHold();
    await w.finished();
    expect(w.table.seats[2].state).toBe('empty');                        // stood up after the pot was awarded
    expect(w.chipsWon).toEqual([{ userId: 7, net: 2000 }, { userId: 8, net: -2000 }]);
  });

  it('Bob DROPS during the runout (disconnect: seat reserved, session and sign-in gone): recorded by his reservation', async () => {
    const w = handWorld();
    allInHeld(w);
    w.m.reserveSeatForDeparture(w.authSessions.get('SB'), w.playerSessions.get('SB'), w.table, w.table.seats[2]);
    w.playerSessions.delete('SB');
    w.authSessions.delete('SB');
    expect(w.reservedSeats.get(8)).toMatchObject({ tableId: 'T1', seatIndex: 2, playerName: 'Bob', playerId: 'player-B' });
    w.table.releaseRunoutHold();
    await w.finished();
    expect(w.chipsWon).toEqual([{ userId: 7, net: 2000 }, { userId: 8, net: -2000 }]);
  });

  it('a club table: no season row, the club stats get both results (the leaver\'s loss included)', async () => {
    const w = handWorld('club');
    allInHeld(w);
    w.m.handlePlayerLeave({ id: 'SB', leave() {}, emit() {} });
    w.table.releaseRunoutHold();
    await w.finished();
    expect(w.chipsWon).toEqual([]);
    expect(w.club).toEqual([{ userId: 7, net: 2000, pot: 4000 }, { userId: 8, net: -2000, pot: 0 }]);
  });

  it('dealtInSeatAccount: by session (main or extra table, same occupant), else the hand-end removal, else the reservation — never another occupant\'s', () => {
    const w = handWorld();
    const seat = (i: number) => w.table.seats[i];
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBe(7);
    // a stale pointer: a session at the seat for ANOTHER occupant is not his
    w.playerSessions.get('SA').playerId = 'player-OLD';
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBeNull();
    w.playerSessions.get('SA').playerId = 'player-A';
    // an extra-table session (multiTableSessions) of the same occupant
    w.playerSessions.delete('SA');
    const multi = new Map([['SX', [{ tableId: 'T1', seatIndex: 1, playerId: 'player-A' }]]]);
    w.authSessions.set('SX', { userId: 70 });
    const m2 = load(`${fnSrc('function dealtInSeatAccount(')}\n${fnSrc('function seatPlayedByAnotherAccount(')}\n${SEAT_IDENTITY_SRC}`, {
      playerSessions: w.playerSessions, multiTableSessions: multi, authSessions: w.authSessions,
      pendingSeatRemovalAfterHand: w.pendingSeatRemovalAfterHand, reservedSeats: w.reservedSeats,
    }, 'dealtInSeatAccount').exports;
    expect(m2('T1', seat(1))).toBe(70);
    // a hand-end removal: his, or one that credits nobody
    w.pendingSeatRemovalAfterHand.set('T1', new Map([[1, { userId: 7, username: 'u7', playerId: 'player-A' }]]));
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBe(7);
    w.pendingSeatRemovalAfterHand.set('T1', new Map([[1, { userId: 0, username: '', noCredit: true, playerId: 'player-A' }]]));
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBeNull();
    w.pendingSeatRemovalAfterHand.set('T1', new Map([[1, { userId: 9, username: 'u9', playerId: 'player-SOMEONE-ELSE' }]]));
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBeNull();
    w.pendingSeatRemovalAfterHand.clear();
    // a reservation: the reserved occupant, never a later one; never a seat another account plays
    w.reservedSeats.set(7, { tableId: 'T1', seatIndex: 1, playerName: 'Alice', playerId: 'player-A' });
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBe(7);
    w.reservedSeats.set(7, { tableId: 'T1', seatIndex: 1, playerName: 'Alice', playerId: 'player-NEW' });
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBeNull();
    w.reservedSeats.set(7, { tableId: 'T1', seatIndex: 1, playerName: 'Alice' });   // synthetic (no snapshot): by seat name
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBe(7);
    w.playerSessions.set('SZ', { socketId: 'SZ', tableId: 'T1', seatIndex: 1, playerId: 'player-Z', playerName: 'Zed' });
    w.authSessions.set('SZ', { userId: 99 });
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBeNull();
    // a live session playing the seat decides alone — a GUEST's (no account) never falls back to an older claim
    w.playerSessions.delete('SZ');
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBe(7);
    w.playerSessions.set('SG', { socketId: 'SG', tableId: 'T1', seatIndex: 1, playerId: 'player-A', playerName: 'Alice' });
    expect(w.m.dealtInSeatAccount('T1', seat(1))).toBeNull();
    // the bot seat: nobody
    expect(w.m.dealtInSeatAccount('T1', seat(0))).toBeNull();
  });
});

describe('H1 — each recipient\'s handHistory: tableId, viewerSeat, his own viewerHoleCards (TABLEUI-6 / APPUI-16 / K2-6)', () => {
  it('a folded seat and an uncontested winner: each gets ONLY his own cards; the record still masks both', async () => {
    const w = handWorld();
    const sa = w.mkSock('SA');
    const sb = w.mkSock('SB');
    const sc = w.mkSock('SC');
    // a session at the table whose seat was not in the hand (omitted keys)
    w.playerSessions.set('SC', { socketId: 'SC', tableId: 'T1', seatIndex: 5, playerId: 'player-C', playerName: 'Cat', sittingOut: false });
    w.authSessions.set('SC', { userId: 9, username: 'u9' });
    expect(w.table.startNewHand()).toBe(true);
    rig(w.table, 'As Ah', '7c 2d', 'Ks 9h 5c 3s Jd');
    expect(w.table.playerFold(0)).toBe(true);             // bot (button)
    expect(w.table.playerFold(1)).toBe(true);             // Alice (SB) folds
    await w.finished();                                    // Bob (BB) wins uncontested
    const last = (s: any) => [...s.emitted].reverse().find(([e]: [string]) => e === 'handHistory')?.[1];
    const a = last(sa);
    const b = last(sb);
    const c = last(sc);
    for (const h of [a, b, c]) {
      expect(h.tableId).toBe('T1');
      expect(h.players.find((p: any) => p.seatIndex === 1)).toMatchObject({ holeCards: null, handName: null });
      expect(h.players.find((p: any) => p.seatIndex === 2)).toMatchObject({ holeCards: null, handName: null });
    }
    expect(a.viewerSeat).toBe(1);
    expect(a.viewerHoleCards).toEqual(cs('As Ah').map(ser));
    expect(b.viewerSeat).toBe(2);
    expect(b.viewerHoleCards).toEqual(cs('7c 2d').map(ser));
    for (const bobCard of cs('7c 2d').map(ser)) expect(JSON.stringify(a)).not.toContain(JSON.stringify(bobCard));
    for (const aliceCard of cs('As Ah').map(ser)) expect(JSON.stringify(b)).not.toContain(JSON.stringify(aliceCard));
    expect('viewerSeat' in c).toBe(false);
    expect('viewerHoleCards' in c).toBe(false);
    // the stored per-user row is that user's own copy
    expect(w.stored.map((s) => s.userId).sort()).toEqual([7, 8, 9]);
    expect(w.stored.find((s) => s.userId === 7)!.data).toEqual(a);
    expect(w.stored.find((s) => s.userId === 8)!.data).toEqual(b);
    expect(w.stored.find((s) => s.userId === 9)!.data).toEqual(c);
  });

  it('a session whose seat now holds ANOTHER player gets no viewer fields (never someone else\'s cards)', async () => {
    const w = handWorld();
    const sa = w.mkSock('SA');
    w.playerSessions.get('SA').playerId = 'player-OLD';
    w.playerSessions.get('SA').playerName = 'Old Alice';
    expect(w.table.startNewHand()).toBe(true);
    expect(w.table.playerFold(0)).toBe(true);
    expect(w.table.playerFold(1)).toBe(true);
    await w.finished();
    const h = [...sa.emitted].reverse().find(([e]) => e === 'handHistory')![1];
    expect(h.tableId).toBe('T1');
    expect('viewerSeat' in h).toBe(false);
    expect('viewerHoleCards' in h).toBe(false);
  });

  it('loadHandHistory: a stored record never carries the hand name of a player whose cards are not shown', () => {
    const leaking = {
      handNumber: 7, tableId: 'T1', viewerSeat: 1, viewerHoleCards: [{ suit: 0, rank: 14, display: 'A' }],
      players: [
        { seatIndex: 1, name: 'Alice', holeCards: null, handName: 'Two Pair, Kings and 7s', folded: false },
        { seatIndex: 2, name: 'Bob', holeCards: [], handName: 'High Card', folded: true },
        { seatIndex: 3, name: 'Cat', holeCards: [{ suit: 1, rank: 13 }, { suit: 2, rank: 13 }], handName: 'Pair of Kings', folded: false },
      ],
      winners: [{ seatIndex: 1, name: 'Alice', chipsWon: 400, handName: 'Won by fold' }],
    };
    const out = am.maskUnshownHandNames(leaking);
    expect(out.players.map((p: any) => p.handName)).toEqual([null, null, 'Pair of Kings']);
    expect(out.viewerHoleCards).toEqual(leaking.viewerHoleCards);   // his own cards stay
    expect(leaking.players[0].handName).toBe('Two Pair, Kings and 7s');   // pure: the input is untouched
    expect(am.maskUnshownHandNames(JSON.stringify(leaking)).players[0].handName).toBeNull();   // a TEXT row too
    expect(am.maskUnshownHandNames({ handNumber: 1 })).toEqual({ handNumber: 1 });
    expect(am.maskUnshownHandNames(null)).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'authManager.ts'), 'utf8');
    const loader = src.slice(src.indexOf('export async function loadHandHistory('), src.indexOf('\n}\n', src.indexOf('export async function loadHandHistory(')));
    expect(loader).toContain('...maskUnshownHandNames(r.data)');
  });

  it('wiring: the handHistory emit and the stored row are the recipient\'s own copy', () => {
    const listener = fnSrc('function ensureTableProgressListener(');
    expect(listener).toContain('const viewer = handHistoryViewerOf(table, history, session);');
    expect(listener).toContain("socket.emit('handHistory', forViewer);");
    expect(listener).toContain('recordHand(auth.userId, handId, forViewer)');
    expect(listener).not.toContain("socket.emit('handHistory', serializedHistory);");
  });
});

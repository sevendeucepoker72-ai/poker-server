/**
 * R2 (2026-10-11, S1) — item 1: the shutdown / crash flush (GAME-3 P0, OPS-2,
 * TOURNEY-4, the sign-in reviewer's race).
 *
 * Before: the flush credited the main seats and the reservations one await at
 * a time; extra-table (multi-table) seats and seats waiting for their
 * after-hand removal were never credited (a redeploy destroyed those stacks),
 * buy-in tournament entry fees and consumed qualifier credits died with the
 * process, and while the flush awaited, a leaveTable / a reservation expiry
 * could credit the same seat again. Now the flush CLAIMS everything
 * synchronously (seats zeroed, claims ended, every other cash-out path stands
 * down), then settles the wallet credits in ONE ledger settlement, refunds the
 * fees / credits / escrow, all inside a bounded budget.
 *
 * The REAL src/index.ts flush (sliced + transpiled) against real PokerTables /
 * TournamentManager and the prize ledger on an in-memory Postgres stand-in.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
import { createPrizeLedger } from '../src/game/prizeLedger';
import { SRC, slice, fnSrc, load, flush } from './helpers/indexSource';
import { createFakePokerDb } from './helpers/fakePokerDb';

const FLUSH = slice('let shutdownInProgress = false;', '    setTimeout(() => process.exit(shutdownExitCode), 500);\n  }\n}\n');
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const IS_TOURNAMENT_RESERVATION = fnSrc('function isTournamentReservation(');
const CREDIT_SEAT = fnSrc('function creditSeatStackToWallet(');
const RELEASE_QUALIFIER = fnSrc('function releaseQualifierRegistration(');
const BUY_IN_GONE = slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n');

const A = 101;
const B = 102;
const C = 103;

function world(opts: { stuckStakingRefund?: boolean } = {}) {
  const db = createFakePokerDb({ [A]: 0, [B]: 0, [C]: 0 });
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const mk = (id: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 1000, maxBuyIn: 10_000 } as any);
    (t as any).variantId = 'texas-holdem';
    tables.set(id, t);
    return t;
  };
  const exits: number[] = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const told: Array<[string, string]> = [];
  const stakes: string[] = [];
  const clubRefunds: any[] = [];
  const quickRefunds: string[] = [];
  const quickFinished: Array<[string, any]> = [];
  const creditRefunds: string[] = [];
  const saved: number[] = [];
  const directCredits: Array<[number, number]> = [];
  const ledger = createPrizeLedger({ connect: () => db.pool.connect() as any, sleep: async () => {}, log: () => {}, backoffMs: [0] });
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id), getTableList: () => [...tables.keys()].map((tableId) => ({ tableId })) },
    tournamentManager: tm, tournamentTables: new Map<string, string>(),
    playerSessions: new Map<string, any>(), multiTableSessions: new Map<string, any[]>(), reservedSeats: new Map<number, any>(),
    pendingSeatRemovalAfterHand: new Map<string, Map<number, any>>(), authSessions: new Map<string, any>(),
    spinGoMultipliers: new Map<string, number>(), isPrizeFormatTable: (id: string) => (scope.spinGoMultipliers as Map<string, number>).has(id),
    clubLiveTournaments: new Map<string, number>(), quickGames: new Map<string, any>(), qualifierTournaments: new Map<string, any>(),
    prizeLedger: ledger, uuidv4: () => 'INST',
    tellTournamentCancelled: (tid: string, r: any) => told.push([tid, r.playerId]),
    refundStakesOf: (tid: string) => { stakes.push(tid); return opts.stuckStakingRefund ? new Promise(() => {}) : Promise.resolve(0); },
    refundClubTournamentEntrants: async (clubTid: number, liveId: string, entrants: any[]) => { clubRefunds.push({ clubTid, liveId, entrants }); return 'committed'; },
    refundQuickEntryFee: async (tableId: string, qg: any) => { qg.settlement = 'refunded'; quickRefunds.push(tableId); },
    finishQuickGame: (tableId: string, outcome: any) => { quickFinished.push([tableId, outcome]); },
    refundQualifierCreditOnMaster: async (id: string) => { creditRefunds.push(id); return true; },
    progressionManager: { getClientProgress: (pid: string) => ({ hydrated: true, xp: 10, level: 2, achievements: [], pid }) },
    saveProgress: async (uid: number) => { saved.push(uid); },
    snapshotHand() {}, flushAllHandSnapshots: async () => {},
    addChipsToUser: async (uid: number, amt: number) => { directCredits.push([uid, amt]); return true; },
    auditLog: (actor: string, action: string, d: any) => audits.push({ actor, action, d }),
    fetch: async () => ({ ok: true }),
    process: { exit: (c: number) => exits.push(c), env: {} },
    Sentry: null,
    console: { log() {}, warn() {}, error() {} },
  };
  const code = `${BROKEN}\n${IS_TOURNAMENT_RESERVATION}\n${CREDIT_SEAT}\n${RELEASE_QUALIFIER}\n${BUY_IN_GONE}\n${FLUSH}`;
  const { exports: m } = load(code, scope, '{ gracefulShutdown, shutdownFlushActive, shutdownFlushStats, creditSeatStackToWallet, buyInSocketGone }');
  return { db, tm, tables, mk, scope, m, exits, audits, told, stakes, clubRefunds, quickRefunds, quickFinished, creditRefunds, saved, directCredits };
}

const S = (w: ReturnType<typeof world>) => w.scope as any;

describe('item 1 — every seat is cashed out ONCE (main, extra-table, reserved, after-hand removal); never a tournament or Spin & Go stack', () => {
  function seated() {
    const w = world();
    const cash = w.mk('cash');
    const extra = w.mk('extra');
    const hand = w.mk('hand');
    const tour = w.mk('tour');
    const spin = w.mk('spin');
    cash.sitDown(0, 'A', 4000, 'pA', false);
    cash.sitDown(1, 'Bot', 3000, 'ai-1', true);
    extra.sitDown(2, 'A', 2500, 'pA2', false);
    cash.sitDown(3, 'B', 1500, 'pB', false);                                   // B disconnected: reserved
    tour.sitDown(0, 'C', 9000, 'pC', false);
    spin.sitDown(0, 'A', 500, 'pA3', false, true);
    S(w).tournamentTables.set('tour', 'T1');
    S(w).spinGoMultipliers.set('spin', 3);
    S(w).authSessions.set('SA', { userId: A, username: 'a' });
    S(w).authSessions.set('SC', { userId: C, username: 'c' });
    S(w).playerSessions.set('SA', { socketId: 'SA', tableId: 'cash', seatIndex: 0, playerId: 'pA' });
    S(w).playerSessions.set('SC', { socketId: 'SC', tableId: 'tour', seatIndex: 0, playerId: 'pC' });
    S(w).multiTableSessions.set('SA', [{ socketId: 'SA', tableId: 'extra', seatIndex: 2, playerId: 'pA2' }]);
    const timer = setTimeout(() => {}, 1e9);
    S(w).reservedSeats.set(B, { tableId: 'cash', seatIndex: 3, chips: 1500, cleanupTimer: timer });
    // "hand": C folded mid-hand with 300 in the pot (an after-hand removal); a noCredit entry; a stale playerId entry.
    hand.sitDown(4, 'C', 700, 'pC2', false, true);
    hand.sitDown(5, 'X', 900, 'pX', false, true);
    hand.sitDown(6, 'Y', 800, 'pY', false, true);
    (hand as any).currentPhase = GamePhase.Flop;
    hand.seats[4].totalInvestedThisHand = 300;
    S(w).pendingSeatRemovalAfterHand.set('hand', new Map<number, any>([
      [4, { userId: C, username: 'c', playerId: 'pC2' }],
      [5, { userId: B, username: 'b', noCredit: true }],
      [6, { userId: A, username: 'a', playerId: 'someone-else' }],
    ]));
    return { w, cash, extra, hand, tour, spin, timer };
  }

  it('one ledger settlement: the main seat, the extra-table seat, the reservation, the after-hand removal (stack + this hand\'s investment)', async () => {
    const { w, cash, extra, hand, tour, spin } = seated();
    await w.m.gracefulShutdown('SIGTERM');
    expect(w.db.wallets.get(A)).toBe(4000 + 2500);
    expect(w.db.wallets.get(B)).toBe(1500);
    expect(w.db.wallets.get(C)).toBe(700 + 300);
    expect([...w.db.payouts.keys()].sort()).toEqual(['shutdown:INST:cash:0', 'shutdown:INST:cash:3', 'shutdown:INST:extra:2', 'shutdown:INST:hand:4']);
    // Never cashed: the tournament stack, the Spin & Go stack, the bot, a noCredit entry, an entry whose seat is someone else's.
    expect(tour.seats[0].chipCount).toBe(9000);
    expect(spin.seats[0].chipCount).toBe(500);
    expect(hand.seats[5].chipCount).toBe(900);
    expect(hand.seats[6].chipCount).toBe(800);
    // Every claimed seat is left with nothing; every claim on it is gone.
    expect([cash.seats[0].chipCount, extra.seats[2].chipCount, cash.seats[3].chipCount, hand.seats[4].chipCount]).toEqual([0, 0, 0, 0]);
    expect([S(w).playerSessions.size, S(w).multiTableSessions.size, S(w).reservedSeats.size, S(w).pendingSeatRemovalAfterHand.size]).toEqual([0, 0, 0, 0]);
    expect(w.m.shutdownFlushStats).toMatchObject({ seatsCashedOut: 4, chipsCashedOut: 4000 + 2500 + 1500 + 1000, ledgerStatus: 'committed' });
    expect(w.saved).toEqual([A, C]);
    expect(w.audits.find((a) => a.action === 'SHUTDOWN_FLUSH')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 600));
    expect(w.exits).toEqual([0]);
  });

  it('a seat referenced twice (a live session + a reservation) is credited once', async () => {
    const w = world();
    const t = w.mk('cash');
    t.sitDown(0, 'A', 4000, 'pA', false);
    S(w).authSessions.set('SA', { userId: A, username: 'a' });
    S(w).authSessions.set('SA2', { userId: A, username: 'a' });
    S(w).playerSessions.set('SA', { socketId: 'SA', tableId: 'cash', seatIndex: 0, playerId: 'pA' });
    S(w).playerSessions.set('SA2', { socketId: 'SA2', tableId: 'cash', seatIndex: 0, playerId: 'pA' });
    S(w).reservedSeats.set(A, { tableId: 'cash', seatIndex: 0, chips: 4000, cleanupTimer: setTimeout(() => {}, 1e9) });
    await w.m.gracefulShutdown('SIGTERM');
    expect(w.db.wallets.get(A)).toBe(4000);
  });

  it('RACE — while the flush awaits, a leave / a reservation expiry / a ghost-seat scan cannot credit a claimed seat again (it stands down)', async () => {
    const { w, cash } = seated();
    const done = w.m.gracefulShutdown('SIGTERM');                         // claims synchronously, then awaits the ledger
    expect(w.m.shutdownFlushActive()).toBe(true);
    cash.seats[0].chipCount = 777;                                         // e.g. a hand that ended after the claim
    w.m.creditSeatStackToWallet(A, 'a', 'cash', cash.seats[0], 'leave');
    await done;
    await flush();
    expect(w.directCredits).toEqual([]);
    expect(w.audits.filter((a) => a.action === 'CASH_OUT_LEFT_TO_SHUTDOWN_FLUSH')).toHaveLength(1);
    expect(w.db.wallets.get(A)).toBe(4000 + 2500);
  });

  it('a buy-in still awaiting its deduct when the flush starts seats nothing: refunded once (server_restarting)', async () => {
    const w = world();
    void w.m.gracefulShutdown('SIGTERM');
    const sock = { id: 'SX', connected: true, emit: jest.fn() };
    S(w).authSessions.set('SX', { userId: A, username: 'a' });
    const gone = await w.m.buyInSocketGone(sock, 'joinTable', 'deduct', { userId: A, username: 'a', amount: 2000 }, { userId: A });
    expect(gone).toBe(true);
    expect(w.directCredits).toEqual([[A, 2000]]);
    expect(w.audits.find((a) => a.action === 'BUY_IN_REFUND')?.d).toMatchObject({ reason: 'server_restarting' });
  });

  it('wiring: new buy-ins refuse while the flush runs; creditSeatStackToWallet and the reservation expiry stand down', () => {
    expect(fnSrc('function blockedByMaintenance(')).toContain("if (shutdownFlushActive()) {\n    socket.emit('error', { message: 'The server is restarting — please try again in a moment.', code: 'server_restarting' });");
    expect(CREDIT_SEAT).toContain('if (shutdownFlushActive()) {');
    expect(fnSrc('function reserveSeatForDeparture(')).toContain('if (shutdownFlushActive()) return;   // R2 — the shutdown flush credits reserved seats (once)');
    // The flush claims BEFORE its first await.
    const run = fnSrc('async function runGracefulShutdown(');
    const claim = run.slice(run.indexOf('// 0. CLAIM'), run.indexOf("await bounded('cash-outs'"));
    expect(claim).toContain('shutdownFlushing = true;');
    expect(claim).toContain('seats = claimSeatsForShutdown();');
    expect(claim).toContain('tourneys = claimTournamentRefundsForShutdown();');
    // No await in the claim (comments aside): nothing else can run between the claim and the zeroed seats.
    const claimCode = claim.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(claimCode).toContain('claimSeatsForShutdown()');
    expect(claimCode).not.toMatch(/\bawait\b/);
  });
});

describe('item 1 — the money that lives only in this process: entry fees, club tournaments, staking escrow, Spin & Go fees, qualifier credits', () => {
  it('a REGISTERING buy-in tournament is cancelled and a RUNNING one voided: every paying entrant refunded once (a disqualified one never); registrants told; no finish can follow', async () => {
    const w = world();
    const reg = w.tm.createTournament({ name: 'Reg Cup', buyIn: 500, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    w.tm.registerPlayer(reg, 'user-101', 'A', 's', A);
    w.tm.registerPlayer(reg, 'user-102', 'B', 's', B);
    const run = w.tm.createTournament({ name: 'Run Cup', buyIn: 1000, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    w.tm.registerPlayer(run, 'user-101', 'A', 's', A);
    w.tm.registerPlayer(run, 'user-102', 'B', 's', B);
    w.tm.registerPlayer(run, 'user-103', 'C', 's', C);
    w.tm.registerPlayer(run, 'ai-x', 'Bot', 's');
    w.tm.startTournament(run);
    w.tm.eliminatePlayer(run, 'user-102');                                  // busted: still refunded (the event is void)
    w.tm.getTournament(run)!.players.find((p) => p.playerId === 'user-103')!.disqualified = true;
    let finished = false;
    w.tm.onEvent(run, (ev) => { if (ev === 'tournamentFinished') finished = true; });
    await w.m.gracefulShutdown('SIGTERM');
    expect([w.db.wallets.get(A), w.db.wallets.get(B), w.db.wallets.get(C)]).toEqual([500 + 1000, 500 + 1000, 0]);
    expect([...w.db.payouts.keys()].filter((k) => k.startsWith('tfee:')).sort()).toEqual([
      `tfee:${reg}:user-101`, `tfee:${reg}:user-102`, `tfee:${run}:user-101`, `tfee:${run}:user-102`,
    ].sort());
    expect(w.told.filter(([tid]) => tid === reg)).toEqual([[reg, 'user-101'], [reg, 'user-102']]);
    expect(w.stakes).toEqual(expect.arrayContaining([reg, run]));
    expect(w.tm.eliminatePlayer(run, 'ai-x')).toBeNull();
    expect(finished).toBe(false);
  });

  it('a CLUB tournament goes through its own settlement (one outcome), not the main one', async () => {
    const w = world();
    const live = w.tm.createTournament({ name: '[Pub] Cup', buyIn: 300, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS, unlisted: true } as any);
    w.tm.registerPlayer(live, 'user-101', 'A', 's', A);
    w.tm.registerPlayer(live, 'user-102', 'B', 's', B);
    w.tm.startTournament(live);
    S(w).clubLiveTournaments.set(live, 42);
    await w.m.gracefulShutdown('SIGTERM');
    expect(w.clubRefunds).toEqual([{ clubTid: 42, liveId: live, entrants: [{ userId: A, amount: 300 }, { userId: B, amount: 300 }] }]);
    expect([...w.db.payouts.keys()].some((k) => k.startsWith(`tfee:${live}`))).toBe(false);
  });

  it('Spin & Go: an undecided game refunds its fee; a decided one settles at once (its prize or nothing)', async () => {
    const w = world();
    S(w).quickGames.set('sg1', { format: 'spinGo', settlement: 'open', ended: false });
    S(w).quickGames.set('sg2', { format: 'spinGo', settlement: 'open', ended: true, decided: { winnerSeat: 0, humanWon: true } });
    S(w).quickGames.set('hu', { format: 'headsUp', settlement: 'open', ended: false });
    await w.m.gracefulShutdown('SIGTERM');
    expect(w.quickRefunds).toEqual(['sg1']);
    expect(w.quickFinished).toEqual([['sg2', { winnerSeat: 0, humanWon: true }]]);
  });

  it('qualifiers: every registration of an event that dies with the process is released — entry AND re-entry credits refunded on the master — and the event closed', async () => {
    const w = world();
    S(w).qualifierTournaments.set('q1', {
      qualifierId: 'q1', masterQualifierId: 'mq1', status: 'running', tournamentId: null, buyIn: 0,
      players: [
        { playerId: 'user-101', masterPlayerId: 'm-a', playerName: 'A', phone: '', socketId: 's', consumedCreditId: 'c1', reentryCreditIds: ['r1'], reEntries: 1, localUserId: A },
        { playerId: 'user-102', masterPlayerId: 'm-b', playerName: 'B', phone: '', socketId: 's', consumedCreditId: 'c2', localUserId: B },
      ],
    });
    S(w).qualifierTournaments.set('q0', { qualifierId: 'q0', status: 'finished', players: [{ playerId: 'x', consumedCreditId: 'old' }] });
    await w.m.gracefulShutdown('SIGTERM');
    expect(w.creditRefunds.sort()).toEqual(['c1', 'c2', 'r1']);
    expect(S(w).qualifierTournaments.get('q1')).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.m.shutdownFlushStats.qualifierRegistrationsReleased).toBe(2);
  });

  it('a phase that hangs is cut short by the flush budget — the process still exits (crash flush: code 1); a second request gets the same flush', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world({ stuckStakingRefund: true });
      w.tm.createTournament({ name: 'Reg', buyIn: 100, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
      const p1 = w.m.gracefulShutdown('uncaughtException', 1);
      const p2 = w.m.gracefulShutdown('SIGTERM');
      expect(p2).toBe(p1);
      for (let i = 0; i < 10; i++) { await flush(); jest.advanceTimersByTime(2_000); }
      await p1;
      jest.advanceTimersByTime(600);
      expect(w.m.shutdownFlushStats.phasesCutShort).toBe(1);
      expect(w.exits).toEqual([1]);
    } finally { jest.useRealTimers(); }
  });
});

describe('wiring', () => {
  it('the crash handler still flushes through gracefulShutdown (exit 1), and the flush keeps the T1 / F2 rules', () => {
    expect(SRC).toContain("installProcessCrashHandlers({\n  flush: () => gracefulShutdown('uncaughtException', 1),");
    expect(FLUSH).toContain('!creditedSeats.has(seatKey) && !isTournamentTable(session.tableId)');
    expect(FLUSH).toContain('if (isTournamentReservation(reserved)) { shutdownFlushStats.seatsNotCashed++; continue; }');
  });
});

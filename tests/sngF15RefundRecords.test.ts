/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F15) — restart /
 * refund RECORDS.
 *  - The SHUTDOWN_FLUSH audit row says WHAT its counts are: voidedTournaments /
 *    cancelledTournaments [{tournamentId, name, entrants|registrants, refunds}]
 *    and seatsSkipped [{tableId, seatIndex, tournamentId, playerId, playerName,
 *    userId, reason}] (the audit could not explain "tournamentsVoided 1,
 *    seatsNotCashed 1" of the 9c37499 deploy).
 *  - A restart refund of an entry fee gets its durable audit row (it was only
 *    in prize_payouts).
 *  - Every fee row (deduct, unregister, the start screen, stall-cancel, restart
 *    refund) has ONE shape: actor = his login, details {userId, entryFee,
 *    amount, reason, tournamentId}.
 *
 * The REAL flush (sliced, as r2Shutdown.test.ts) on a REAL TournamentManager,
 * PokerTables and the prize ledger on the in-memory Postgres stand-in.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { createPrizeLedger } from '../src/game/prizeLedger';
import { SRC, slice, fnSrc, load, flush } from './helpers/indexSource';
import { createFakePokerDb } from './helpers/fakePokerDb';

const FLUSH = slice('let shutdownInProgress = false;', '    setTimeout(() => process.exit(shutdownExitCode), 500);\n  }\n}\n');
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');

function world() {
  const db = createFakePokerDb({ 101: 0, 102: 0, 103: 0, 104: 0 });
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const voided: string[][] = [];
  const ledger = createPrizeLedger({ connect: () => db.pool.connect() as any, sleep: async () => {}, log: () => {}, backoffMs: [0] });
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id), getTableList: () => [...tables.keys()].map((tableId) => ({ tableId })) },
    tournamentManager: tm, tournamentTables: new Map<string, string>(),
    playerSessions: new Map<string, any>(), multiTableSessions: new Map<string, any[]>(), reservedSeats: new Map<number, any>(),
    pendingSeatRemovalAfterHand: new Map(), authSessions: new Map<string, any>(),
    spinGoMultipliers: new Map<string, number>(), isPrizeFormatTable: () => false,
    clubLiveTournaments: new Map<string, number>(), quickGames: new Map(), qualifierTournaments: new Map(),
    prizeLedger: ledger, uuidv4: () => 'INST',
    tellTournamentCancelled() {}, refundStakesOf: () => Promise.resolve(0), refundClubTournamentEntrants: async () => 'committed',
    refundQuickEntryFee: async () => {}, finishQuickGame() {}, refundQualifierCreditOnMaster: async () => true,
    progressionManager: { getClientProgress: () => null, getProgress: () => undefined },
    socketsOfMaster: () => [], io: { emit() {} }, saveProgress: async () => {}, snapshotHand() {}, flushAllHandSnapshots: async () => {},
    addChipsToUser: async () => true, fetch: async () => ({ ok: true }), process: { exit() {}, env: {} }, Sentry: null,
    auditLog: (actor: string, action: string, d: any) => audits.push({ actor, action, d }),
    tournamentResults: { markVoided: (ids: string[]) => { voided.push(ids); return Promise.resolve(); } },
    tournamentIdOfTable: (id: string) => (scope.tournamentTables as Map<string, string>).get(id),
    console: { log() {}, warn() {}, error() {} },
  };
  const code = `${BROKEN}\n${fnSrc('function isTournamentReservation(')}\n${fnSrc('function creditSeatStackToWallet(')}\n${fnSrc('function releaseQualifierRegistration(')}\n${slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n')}\n${fnSrc('function tournamentFeeAudit(')}\n${FLUSH}`;
  const { exports: m } = load(code, scope, '{ gracefulShutdown, shutdownFlushStats }');
  return { db, tm, tables, scope, m, audits, voided };
}

describe('F15 — the SHUTDOWN_FLUSH row names what it voided, cancelled and skipped', () => {
  it('a registering Sit & Go (3 paid), a running custom event, a tournament seat + a tournament reservation: lists with ids / names / seats; restart refunds audited in the one fee shape', async () => {
    const w = world();
    const S = w.scope as any;
    // A registering 100-chip Sit & Go: 3 paying registrants (logins recorded at registration).
    const sng = (w.tm.getTournamentList() as any[]).find((x) => x.name === 'Sit & Go').tournamentId;
    for (const [pid, uid, login] of [['user-101', 101, 'andy'], ['user-102', 102, 'katie'], ['user-103', 103, 'josh']] as const) {
      w.tm.registerPlayer(sng, pid, pid, `s-${uid}`, uid);
      w.tm.getTournament(sng)!.players.find((p) => p.playerId === pid)!.login = login;
    }
    // A running custom freeroll with a seated entrant and a reserved (disconnected) entrant.
    const cup = w.tm.createTournament({ name: 'Cup', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, minPlayers: 2, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 600 }] } as any);
    w.tm.registerPlayer(cup, 'user-104', 'Dom', 'SD', 104);
    w.tm.registerPlayer(cup, 'user-105', 'Eve', 'SE');
    w.tm.startTournament(cup);
    const t = new PokerTable({ tableId: 'TC', tableName: 'TC', smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 100000 } as any);
    t.sitDown(0, 'Dom', 1000, 'user-104', false);
    t.sitDown(1, 'Eve', 1000, 'user-105', false);
    w.tables.set('TC', t);
    S.tournamentTables.set('TC', cup);
    S.authSessions.set('SD', { userId: 104, username: 'dom' });
    S.playerSessions.set('SD', { socketId: 'SD', tableId: 'TC', seatIndex: 0, playerId: 'user-104' });
    S.reservedSeats.set(105, { tableId: 'TC', seatIndex: 1, chips: 1000, tournament: true, cleanupTimer: setTimeout(() => {}, 1e9) });
    await w.m.gracefulShutdown('SIGTERM');
    await flush();
    const row = w.audits.find((a) => a.action === 'SHUTDOWN_FLUSH')!.d;
    expect(row).toMatchObject({ tournamentsCancelled: 1, tournamentsVoided: 1, entryFeesRefunded: 3, seatsNotCashed: 1 });   // the counter: the reservation
    // e038f7b: the counts only.
    expect(row.cancelledTournaments).toEqual([{ tournamentId: sng, name: 'Sit & Go', registrants: 3, refunds: 3 }]);
    expect(row.voidedTournaments).toEqual([{ tournamentId: cup, name: 'Cup', entrants: 2, refunds: 0 }]);
    expect(row.seatsSkipped).toEqual(expect.arrayContaining([
      { tableId: 'TC', seatIndex: 0, tournamentId: cup, playerId: 'user-104', playerName: 'Dom', userId: 104, reason: 'tournament_stack_seated' },
      { tableId: 'TC', seatIndex: 1, tournamentId: cup, playerId: 'user-105', playerName: 'Eve', userId: 105, reason: 'tournament_reservation' },
    ]));
    // The restart refunds: one durable row each, the one fee shape, actor = his login.
    const refunds = w.audits.filter((a) => a.action === 'TOURNAMENT_ENTRY_REFUND');
    expect(refunds.map((a) => a.actor).sort()).toEqual(['andy', 'josh', 'katie']);
    for (const a of refunds) {
      expect(a.d).toEqual({ userId: expect.any(Number), entryFee: 100, amount: 100, reason: 'server_restart', tournamentId: sng, ledgerKey: `tfee:${sng}:user-${a.d.userId}` });
    }
    expect([...w.db.wallets.entries()].filter(([, v]) => v > 0).map(([k, v]) => [k, v]).sort()).toEqual([[101, 100], [102, 100], [103, 100]]);
    // The voided event is marked so in the durable results (never told as a result).
    expect(w.voided).toEqual([[cup]]);
  });
});

describe('F15 — one shape for every fee row', () => {
  it('tournamentFeeAudit: actor = login (user:<id> when unknown), details {userId, entryFee, amount, reason, tournamentId}', () => {
    const audits: any[] = [];
    const { exports: m } = load(fnSrc('function tournamentFeeAudit('), { auditLog: (actor: string, action: string, d: any) => audits.push([actor, action, d]) }, '{ tournamentFeeAudit }');
    m.tournamentFeeAudit('TOURNAMENT_ENTRY_DEDUCT', { login: 'andy', userId: 7, tournamentId: 'T', entryFee: 100, amount: 100, reason: 'register' });
    m.tournamentFeeAudit('TOURNAMENT_ENTRY_REFUND', { userId: 8, tournamentId: 'T', entryFee: 100, amount: 100, reason: 'stall_cancelled' });
    expect(audits).toEqual([
      ['andy', 'TOURNAMENT_ENTRY_DEDUCT', { userId: 7, entryFee: 100, amount: 100, reason: 'register', tournamentId: 'T' }],
      ['user:8', 'TOURNAMENT_ENTRY_REFUND', { userId: 8, entryFee: 100, amount: 100, reason: 'stall_cancelled', tournamentId: 'T' }],
    ]);
  });

  it('every fee-row site goes through it (registration deduct + its refunds, unregister, start screen, cancel refunds, restart refunds); no raw fee auditLog is left', () => {
    const raw = SRC.match(/auditLog\([^;]*'TOURNAMENT_ENTRY_(DEDUCT|REFUND|REFUND_FAILED)'/g) || [];
    expect(raw).toEqual([]);
    expect((SRC.match(/tournamentFeeAudit\(/g) || []).length).toBeGreaterThanOrEqual(9);   // the helper + every site
    expect(SRC).toContain("extra: { entryFee, tournamentId: data.tournamentId },   // F15 — the fee row's shape");
  });
});

/**
 * R2 (2026-10-11, S1) — club tournaments played for real (TOURNEY-14) and club
 * tables that survive a redeploy (CLUBS-4).
 *
 * Before: registerClubTournament toggled a row and charged NOTHING;
 * startClubTournament flipped `status` to 'running' and dealt nothing — no
 * tournament ever existed. A club table's runtime table died with every
 * redeploy while its row kept the dead id ("Table not yet created" forever).
 * Now: the buy-in is charged with the registration (one transaction),
 * refunded exactly once on unregister / cancel; the start creates a real,
 * unlisted TournamentManager tournament for the paid members (their buy-ins
 * are its prize pool); a club tournament has ONE outcome — its prizes or its
 * refunds — enforced in the settling transaction; a tournament orphaned by a
 * restart is refunded by the boot sweep; club tables are re-created on demand.
 *
 * clubManager runs against an in-memory Postgres stand-in (fakePokerDb);
 * index.ts paths are the REAL source (sliced + transpiled).
 */
import { TournamentManager } from '../src/game/TournamentManager';
import { clubTournamentBlindLevels, clubTournamentNumbers } from '../src/game/clubTournaments';
import { createPrizeLedger } from '../src/game/prizeLedger';
import { normalizeBackers, planEscrowRefund, planCashedSettlement } from '../src/game/stakingEscrow';
import { validateTableConfig } from '../src/game/tableConfigValidation';
import { SRC, slice, fnSrc, handlerSrc, load, flush } from './helpers/indexSource';
import { createFakePokerDb } from './helpers/fakePokerDb';

// clubManager reads its pool from authManager.getPool — the fake DB here.
const mockDb: { current: any } = { current: null };
jest.mock('../src/auth/authManager', () => ({ getPool: () => mockDb.current.pool }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const clubs = require('../src/clubs/clubManager');

const OWNER = 1;
const A = 101;
const B = 102;
const C = 103;

function db(wallets: Record<number, number> = { [OWNER]: 10_000, [A]: 10_000, [B]: 10_000, [C]: 10_000 }) {
  const d = createFakePokerDb(wallets);
  d.clubs.set(7, { id: 7, name: 'Pub Club' });
  d.members.push(
    { clubid: 7, userid: OWNER, role: 'owner', status: 'active' },
    { clubid: 7, userid: A, role: 'member', status: 'active' },
    { clubid: 7, userid: B, role: 'member', status: 'active' },
    { clubid: 7, userid: C, role: 'member', status: 'active' },
  );
  mockDb.current = d;
  return d;
}

describe('club tournament structure + numbers (pure)', () => {
  it('the stored levels (minutes) run as seconds and are CONTINUED until a big blind is four stacks — the default three levels used to top out at 100/200', () => {
    const stored = JSON.stringify([
      { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, duration: 15 },
      { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, duration: 15 },
      { level: 3, smallBlind: 100, bigBlind: 200, ante: 25, duration: 15 },
    ]);
    const levels = clubTournamentBlindLevels(stored, 5000);
    expect(levels.slice(0, 3)).toEqual([{ sb: 25, bb: 50, ante: 0, duration: 900 }, { sb: 50, bb: 100, ante: 0, duration: 900 }, { sb: 100, bb: 200, ante: 25, duration: 900 }]);
    expect(levels[levels.length - 1].bb).toBeGreaterThanOrEqual(4 * 5000);
    expect(levels[3]).toEqual({ sb: 200, bb: 400, ante: 50, duration: 900 });
  });
  it('an invalid level is skipped; nothing valid → the default levels', () => {
    expect(clubTournamentBlindLevels([{ smallBlind: 50, bigBlind: 60, duration: 10 }, { smallBlind: 10, bigBlind: 20, ante: 0, duration: 5 }], 1000)[0]).toEqual({ sb: 10, bb: 20, ante: 0, duration: 300 });
    expect(clubTournamentBlindLevels('not json', 5000)[0]).toEqual({ sb: 25, bb: 50, ante: 0, duration: 900 });
  });
  it('a free club tournament (buyIn 0) is real — it used to become 100; bad numbers fall back', () => {
    expect(clubTournamentNumbers({ buyIn: 0, startingChips: 3000, maxPlayers: 6 })).toEqual({ buyIn: 0, startingChips: 3000, maxPlayers: 6 });
    expect(clubTournamentNumbers({ buyIn: -5, startingChips: 10, maxPlayers: 900 })).toEqual({ buyIn: 100, startingChips: 5000, maxPlayers: 200 });
    expect(clubTournamentNumbers({ buyIn: 2.5 })).toMatchObject({ buyIn: 100 });
  });
});

describe('clubManager — the buy-in is charged with the registration, refunded exactly once', () => {
  async function created(buyIn = 500) {
    const d = db();
    const r = await clubs.createClubTournament(7, OWNER, { name: 'Friday Freezeout', buyIn, startingChips: 5000, maxPlayers: 9, scheduledAt: '2026-10-17T19:00' });
    expect(r.success).toBe(true);
    return { d, id: r.tournament.id as number };
  }

  it('register charges the buy-in (same transaction as the row); the toggle refunds exactly what it paid', async () => {
    const { d, id } = await created();
    expect(await clubs.registerForClubTournament(id, A)).toEqual({ success: true, registered: true, charged: 500 });
    expect(d.wallets.get(A)).toBe(9_500);
    expect(d.clubRegs).toEqual([{ tournamentid: id, userid: A, paid: 500, transferredat: null }]);
    expect(await clubs.registerForClubTournament(id, A)).toEqual({ success: true, registered: false, refunded: 500 });
    expect(d.wallets.get(A)).toBe(10_000);
    expect(d.clubRegs).toEqual([]);
  });

  it('not enough chips → no row, nothing moved; a non-member → refused', async () => {
    const { d, id } = await created(20_000);
    expect(await clubs.registerForClubTournament(id, A)).toMatchObject({ success: false, code: 'insufficient_chips' });
    expect(d.clubRegs).toEqual([]);
    expect(d.wallets.get(A)).toBe(10_000);
    d.wallets.set(999, 50_000);
    expect(await clubs.registerForClubTournament(id, 999)).toMatchObject({ success: false, code: 'not_a_member' });
    expect(d.wallets.get(999)).toBe(50_000);
  });

  it('the start (owner / manager only) claims the row and transfers every paid registration — needs two', async () => {
    const { d, id } = await created();
    await clubs.registerForClubTournament(id, A);
    expect(await clubs.startClubTournament(id, OWNER)).toMatchObject({ success: false, code: 'not_enough_players' });
    expect(d.clubTournaments.get(id)!.status).toBe('registering');          // rolled back
    await clubs.registerForClubTournament(id, B);
    expect(await clubs.startClubTournament(id, A)).toMatchObject({ success: false, code: 'not_allowed' });
    const s = await clubs.startClubTournament(id, OWNER);
    expect(s).toMatchObject({ success: true, entrants: [{ userId: A, paid: 500 }, { userId: B, paid: 500 }], refunded: [] });
    expect(d.clubTournaments.get(id)!.status).toBe('running');
    expect(d.clubRegs.every((r) => r.transferredat !== null)).toBe(true);
    // Too late to unregister (or to start again).
    expect(await clubs.registerForClubTournament(id, A)).toMatchObject({ success: false, code: 'registration_closed' });
    expect(await clubs.startClubTournament(id, OWNER)).toMatchObject({ success: false });
  });

  it('cancel BEFORE the start refunds every registration once; a second cancel refunds nothing', async () => {
    const { d, id } = await created();
    await clubs.registerForClubTournament(id, A);
    await clubs.registerForClubTournament(id, B);
    expect(await clubs.cancelClubTournament(id, OWNER)).toMatchObject({ success: true, refunded: [{ userId: A, paid: 500 }, { userId: B, paid: 500 }] });
    expect(await clubs.cancelClubTournament(id, OWNER)).toMatchObject({ success: false, code: 'registration_closed' });
    expect([d.wallets.get(A), d.wallets.get(B)]).toEqual([10_000, 10_000]);
    expect(d.clubTournaments.get(id)!.status).toBe('cancelled');
  });
});

// ─────────────────────────── the real index.ts paths ───────────────────────────
const CLUB = slice('// ========== Club tournaments played for real (R2, TOURNEY-14) ==========', "    if (st === 'committed') clubTournamentStats.strandedSwept++;\n  }\n}\n");
const REFUND_CANCELLED = fnSrc('function refundCancelledTournamentEntrants(');
const PRIZES = slice('const paidOutTournaments = new Set<string>();', '    tournamentsSettlingStakes.delete(tid);\n  }\n}\n');
const ENTRANT_ID = fnSrc('function tournamentEntrantPlayerId(');
const CLUB_TABLES = slice('// ========== Club tables survive a redeploy (R2, CLUBS-4) ==========', '\n  return job;\n}\n');
// 2026-10-21 (gameplay F103 / F104): + deleteClub and the scheduled-table handlers.
const HANDLERS = ['registerClubTournament', 'startClubTournament', 'cancelClubTournament', 'joinClubTable', 'getClubTables',
  'deleteClub', 'scheduleClubTable', 'activateScheduledClubTable']
  .map((ev) => handlerSrc(ev, '\n  });\n')).join('\n  ');
// F104 — a scheduled table fires as a REAL club table (the Activate button and the auto-fire sweep).
const SCHEDULED = fnSrc('function validateScheduledTableConfig(') + fnSrc('async function createTableFromScheduledConfig(')
  + slice('let sweepScheduledInFlight = false;', '    sweepScheduledInFlight = false;\n  }\n}\n');

function world() {
  const d = db();
  const tm = new TournamentManager();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const screened: Array<[string, string]> = [];
  const authSessions = new Map<string, any>();
  const sockets = new Map<string, any>();
  const runtime = new Map<string, any>();
  const created: any[] = [];
  const clubTableIds = new Set<string>();
  const clubIdByTable = new Map<string, number>();
  const globalEmits: Array<[string, any]> = [];
  let n = 0;
  const ledger = createPrizeLedger({ connect: () => d.pool.connect() as any, sleep: async () => {}, log: () => {}, backoffMs: [0, 0] });
  const scope: Record<string, unknown> = {
    ...clubs,                                   // the real club data layer (on the fake DB); the fakes below win
    tournamentManager: tm, authSessions, prizeLedger: ledger, getPool: () => d.pool,
    io: { emit: (ev: string, p: any) => globalEmits.push([ev, p]), to: () => ({ emit() {} }), sockets: { sockets } },
    auditLog: (actor: string, action: string, det: any) => audits.push({ actor, action, d: det }),
    addChipsToUser: async (uid: number, amt: number) => { d.wallets.set(uid, (d.wallets.get(uid) ?? 0) + amt); return true; },
    screenAndStartTournament: async (tid: string, via: string) => { screened.push([tid, via]); },
    progressionManager: { getOrCreateProgress() {}, recordTournamentResult() {} },
    getPublicNames: async (ids: number[]) => new Map(ids.map((i) => [i, `P${i}`])),
    getClubInfo: async () => ({ club: { name: 'Pub Club' } }),
    PUBLIC_NAME_FALLBACK: 'Player', clubTournamentBlindLevels,
    tellTournamentCancelled() {}, refundStakesOf: async () => 0, broadcastTournamentList() {}, broadcastStakingOffers() {},
    pushActivity() {}, normalizeBackers, planEscrowRefund, planCashedSettlement,
    // club tables
    tableManager: {
      getTable: (id: string) => runtime.get(id),
      createTable: (cfg: any) => { const id = `rt${++n}`; created.push(cfg); runtime.set(id, { maxOccupiableSeats: 9, seats: [] }); return id; },
      createVariantTable: (cfg: any) => { const id = `rv${++n}`; created.push(cfg); runtime.set(id, { maxOccupiableSeats: 9, seats: [] }); return id; },
      // F104 fix-up: a runtime table no club_tables row points at is closed.
      removeTable: (id: string) => runtime.delete(id),
    },
    tableHasHumanSeat: (t: any) => t.seats.some((s: any) => s.state === 'occupied' && !s.isAI),
    clubTableIds, clubIdByTable, validateTableConfig, clubJoinGrants: new WeakSet(),
    assertPlayable: async () => null, emitPlayRefusal: (s: any, r: any) => s.emit('error', r),
    console: { log() {}, warn() {}, error() {} },
  };
  const code = `${ENTRANT_ID}\n${CLUB}\n${REFUND_CANCELLED}\n${PRIZES}\n${CLUB_TABLES}\n${SCHEDULED}\nfunction wire(socket) {\n  ${HANDLERS}\n}`;
  const { exports: m } = load(code, scope, `{ wire, clubLiveTournaments, clubTournamentStats, refundCancelledTournamentEntrants, payTournamentPrizes,
    refundClubTournamentEntrants, bootSweepStrandedClubTournaments, ensureClubRuntimeTable, clubTableRuntimeStats, sweepScheduledClubTables }`);
  const emitted: Array<[string, string, any]> = [];
  const joins: any[] = [];
  const mkSocket = (id: string, userId: number) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers, rooms: new Set<string>(),
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      emit: (ev: string, p: any) => emitted.push([id, ev, p]),
      listeners: (ev: string) => (ev === 'joinTable' ? [(p: any) => joins.push(p)] : []),
      join() {}, leave() {},
    };
    sockets.set(id, s);
    authSessions.set(id, { userId, username: `u${userId}`, displayName: `P${userId}` });
    m.wire(s);
    return s;
  };
  const of = (sid: string, ev: string) => emitted.filter(([s, e]) => s === sid && e === ev).map(([, , p]) => p);
  return { d, tm, m, audits, screened, runtime, created, clubTableIds, clubIdByTable, globalEmits, joins, mkSocket, of };
}

async function startedClubTournament(w: ReturnType<typeof world>, buyIn = 500) {
  const r = await clubs.createClubTournament(7, OWNER, { name: 'Friday Freezeout', buyIn, startingChips: 5000, maxPlayers: 9, scheduledAt: '2026-10-17T19:00' });
  const id = r.tournament.id as number;
  const owner = w.mkSocket('SO', OWNER);
  const a = w.mkSocket('SA', A);
  const b = w.mkSocket('SB', B);
  const c = w.mkSocket('SC', C);
  await a.handlers.registerClubTournament({ tournamentId: id });
  await b.handlers.registerClubTournament({ tournamentId: id });
  await owner.handlers.startClubTournament({ tournamentId: id });
  const liveId = w.of('SO', 'clubTournamentStarted')[0]?.liveTournamentId as string;
  return { id, liveId, owner, a, b, c };
}

describe('the club START is real: a live, unlisted tournament of the paid members', () => {
  it('registerClubTournament keeps its event + payload (clubTournamentRegistered {tournamentId, registered}) and audits the buy-in', async () => {
    const w = world();
    const r = await clubs.createClubTournament(7, OWNER, { name: 'Cup', buyIn: 300, scheduledAt: 'x' });
    const a = w.mkSocket('SA', A);
    await a.handlers.registerClubTournament({ tournamentId: r.tournament.id });
    await a.handlers.registerClubTournament({ tournamentId: r.tournament.id });
    expect(w.of('SA', 'clubTournamentRegistered')).toEqual([
      { tournamentId: r.tournament.id, registered: true, charged: 300 },
      { tournamentId: r.tournament.id, registered: false, refunded: 300 },
    ]);
    expect(w.audits.map((x) => x.action)).toEqual(['CLUB_TOURNAMENT_BUYIN', 'CLUB_TOURNAMENT_REFUND']);
    expect(w.d.wallets.get(A)).toBe(10_000);
  });

  it('start → a TournamentManager tournament with both members as entrants, its pool = their buy-ins, through the shared start path; listed only to its entrants', async () => {
    const w = world();
    const { id, liveId } = await startedClubTournament(w);
    expect(liveId).toEqual(expect.any(String));
    const t = w.tm.getTournament(liveId)!;
    expect(t.config).toMatchObject({ name: '[Pub Club] Friday Freezeout', buyIn: 500, unlisted: true, startingChips: 5000, minPlayers: 2 });
    expect(t.players.map((p) => [p.playerId, p.userId])).toEqual([['user-101', A], ['user-102', B]]);
    expect(t.collectedEntryFees).toBe(1000);
    expect(t.config.blindLevels[0]).toEqual({ sb: 25, bb: 50, ante: 0, duration: 900 });
    expect(w.screened).toEqual([[liveId, 'club']]);
    expect(w.d.clubTournaments.get(id)).toMatchObject({ status: 'running', livetournamentid: liveId });
    expect(w.m.clubLiveTournaments.get(liveId)).toBe(id);
    expect((w.tm.getTournamentList({ userId: C }) as any[]).some((x) => x.tournamentId === liveId)).toBe(false);
    expect((w.tm.getTournamentList(null) as any[]).some((x) => x.tournamentId === liveId)).toBe(false);
    expect((w.tm.getTournamentList({ userId: A }) as any[]).find((x) => x.tournamentId === liveId)).toMatchObject({ registered: true });
    expect(w.of('SO', 'clubTournamentStarted')).toEqual([{ tournamentId: id, liveTournamentId: liveId, entrants: 2 }]);
    // registerTournament never takes a club tournament (its members are entered by the club).
    expect(handlerSrc('registerTournament', '\n  });\n')).toContain('if (!tourn || tourn.config.unlisted) {');
  });

  it('FINISHED: prizes through the ledger AND the club row → finished in the same transaction; no refund path can follow (one outcome)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world();
      const { id, liveId } = await startedClubTournament(w);
      let data: any = null;
      w.tm.onEvent(liveId, (ev, dd) => { if (ev === 'tournamentFinished') data = dd; });
      w.tm.startTournament(liveId);
      w.tm.eliminatePlayer(liveId, 'user-102');
      await w.m.payTournamentPrizes(data);
      expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([9_500 + 625, 9_500 + 375]);
      expect(w.d.clubTournaments.get(id)!.status).toBe('finished');
      expect(await w.m.refundClubTournamentEntrants(id, liveId, [{ userId: A, amount: 500 }, { userId: B, amount: 500 }], 'late')).toBe('conflict');
      await w.m.bootSweepStrandedClubTournaments();
      expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([9_500 + 625, 9_500 + 375]);
    } finally { jest.useRealTimers(); }
  });

  it('CANCELLED at its start (the screen left < 2): ONE settlement refunds every buy-in under the club keys and moves the row → cancelled; never twice, and no prizes after', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world();
      const { id, liveId } = await startedClubTournament(w);
      const regs = w.tm.cancelTournament(liveId);
      w.m.refundCancelledTournamentEntrants(liveId, regs, 'cancelled_too_few_eligible_at_start');
      for (let i = 0; i < 4; i++) await flush();
      expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([10_000, 10_000]);
      expect([...w.d.payouts.keys()].sort()).toEqual([`clubfee:${id}:${A}`, `clubfee:${id}:${B}`]);
      expect(w.d.clubTournaments.get(id)!.status).toBe('cancelled');
      w.m.refundCancelledTournamentEntrants(liveId, regs, 'again');
      await w.m.bootSweepStrandedClubTournaments();
      for (let i = 0; i < 4; i++) await flush();
      expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([10_000, 10_000]);
      // A finish that somehow followed pays nothing (the row is no longer running).
      await w.m.payTournamentPrizes({ tournamentId: liveId, results: [{ playerId: 'user-101', playerName: 'A', position: 1, payout: 1000, userId: A }] });
      expect(w.d.wallets.get(A)).toBe(10_000);
    } finally { jest.useRealTimers(); }
  });

  it('a club tournament orphaned by a restart is refunded by the boot sweep — once; one whose prizes were paid is only marked finished', async () => {
    const w = world();
    const { id } = await startedClubTournament(w);
    w.m.clubLiveTournaments.clear();
    w.d.clubTournaments.get(id)!.livetournamentid = 'from-the-old-process';
    await w.m.bootSweepStrandedClubTournaments();
    await w.m.bootSweepStrandedClubTournaments();
    expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([10_000, 10_000]);
    expect(w.d.clubTournaments.get(id)!.status).toBe('cancelled');
    // Another one whose prizes WERE paid before the restart.
    const w2 = world();
    const s2 = await startedClubTournament(w2);
    w2.m.clubLiveTournaments.clear();
    (w2.tm as any).tournaments.delete(s2.liveId);                             // the restart: gone from memory
    w2.d.payouts.set(`tprize:${s2.liveId}:e1`, { userId: A, amount: 625, kind: 'TOURNAMENT_PRIZE', credited: true });
    await w2.m.bootSweepStrandedClubTournaments();
    expect(w2.d.clubTournaments.get(s2.id)!.status).toBe('finished');
    expect(w2.d.wallets.get(A)).toBe(9_500);
  });

  it('cancelClubTournament (before the start) refunds every member and tells each (clubTournamentCancelled)', async () => {
    const w = world();
    const r = await clubs.createClubTournament(7, OWNER, { name: 'Cup', buyIn: 400, scheduledAt: 'x' });
    const owner = w.mkSocket('SO', OWNER);
    const a = w.mkSocket('SA', A);
    await a.handlers.registerClubTournament({ tournamentId: r.tournament.id });
    await owner.handlers.cancelClubTournament({ tournamentId: r.tournament.id });
    expect(w.d.wallets.get(A)).toBe(10_000);
    expect(w.of('SA', 'clubTournamentCancelled')).toEqual([{ tournamentId: r.tournament.id, clubId: 7, refunded: 400, reason: 'cancelled_by_club' }]);
    expect(w.of('SO', 'clubTournamentCancelled')).toEqual([expect.objectContaining({ tournamentId: r.tournament.id, refundedPlayers: 1 })]);
  });

  it('wiring: the start goes through the shared suspension screen (no direct deal from the club path)', () => {
    expect(CLUB).toContain("void screenAndStartTournament(liveId, 'club');");
    expect(SRC.split('startTournamentGame(').length - 1).toBe(3);
  });
});

describe('CLUBS-4 — a club table survives a redeploy (its runtime table re-created on demand)', () => {
  function seedTable(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
    w.d.clubTables.set(11, {
      id: 11, clubid: 7, tablename: 'Friday Night', variant: 'texas-holdem', smallblind: 25, bigblind: 50, minbuyin: 1000,
      maxbuyin: 5000, maxseats: 6, isactive: 1, tableid: 'dead-after-redeploy', ...over,
    } as any);
  }

  it('a member\'s join finds the runtime table gone: re-created from the stored config (club kind, its seats), the row re-pointed, the join goes on with the NEW id', async () => {
    const w = world();
    seedTable(w);
    const a = w.mkSocket('SA', A);
    await a.handlers.joinClubTable({ clubTableId: 11, playerName: 'x', seatIndex: 2, buyIn: 2000 });
    const newId = w.d.clubTables.get(11)!.tableid as string;
    expect(newId).not.toBe('dead-after-redeploy');
    expect(w.created).toEqual([{ tableName: '[Pub Club] Friday Night', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 }]);
    expect(w.clubTableIds.has(newId)).toBe(true);
    expect(w.runtime.get(newId).maxOccupiableSeats).toBe(6);
    expect(w.joins).toEqual([expect.objectContaining({ tableId: newId, seatIndex: 2, buyIn: 2000 })]);
    // A second join uses it (no new table).
    await a.handlers.joinClubTable({ clubTableId: 11, playerName: 'x', seatIndex: 3, buyIn: 2000 });
    expect(w.created).toHaveLength(1);
    expect(w.m.clubTableRuntimeStats.recreated).toBe(1);
  });

  it('two joins at once create ONE table', async () => {
    const w = world();
    seedTable(w);
    const a = w.mkSocket('SA', A);
    const b = w.mkSocket('SB', B);
    await Promise.all([
      a.handlers.joinClubTable({ clubTableId: 11, playerName: 'x', seatIndex: 2, buyIn: 2000 }),
      b.handlers.joinClubTable({ clubTableId: 11, playerName: 'y', seatIndex: 3, buyIn: 2000 }),
    ]);
    expect(w.created).toHaveLength(1);
    expect(new Set(w.joins.map((j) => j.tableId)).size).toBe(1);
  });

  it('a CLOSED (inactive) club table is not re-created: the join is refused', async () => {
    const w = world();
    seedTable(w, { isactive: 0 });
    const a = w.mkSocket('SA', A);
    await a.handlers.joinClubTable({ clubTableId: 11, playerName: 'x', seatIndex: 2, buyIn: 2000 });
    expect(w.created).toEqual([]);
    expect(w.joins).toEqual([]);
    expect(w.of('SA', 'error')).toEqual([expect.objectContaining({ code: 'club_table_unavailable' })]);
  });

  it('the club\'s table list re-creates them too (every listed table has a joinable id)', async () => {
    const w = world();
    seedTable(w);
    const a = w.mkSocket('SA', A);
    await a.handlers.getClubTables({ clubId: 7 });
    const listed = w.of('SA', 'clubTables')[0].tables[0];
    expect(w.runtime.has(listed.tableId)).toBe(true);
  });
});

// ═══════════════════════════════════════════ F103 (gameplay audit 2026-10-21) ══
describe('F103 — deleting a club never destroys its club tournaments\' buy-ins', () => {
  it('a club tournament still REGISTERING is cancelled and every registration refunded in the delete; audited + told (club_deleted)', async () => {
    const w = world();
    const r = await clubs.createClubTournament(7, OWNER, { name: 'Friday Freezeout', buyIn: 500, startingChips: 5000, maxPlayers: 9, scheduledAt: 'x' });
    const id = r.tournament.id as number;
    const owner = w.mkSocket('SO', OWNER);
    const a = w.mkSocket('SA', A);
    const b = w.mkSocket('SB', B);
    await a.handlers.registerClubTournament({ tournamentId: id });
    await b.handlers.registerClubTournament({ tournamentId: id });
    expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([9_500, 9_500]);
    await owner.handlers.deleteClub({ clubId: 7 });
    expect(w.of('SO', 'clubDeleted')).toEqual([{ clubId: 7 }]);
    expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([10_000, 10_000]);       // pre-F103: 9,500 / 9,500 — lost with the cascade
    expect(w.d.clubs.has(7)).toBe(false);
    expect(w.d.clubTournaments.has(id)).toBe(false);
    expect(w.d.clubRegs).toEqual([]);
    expect(w.audits.filter((x) => x.action === 'CLUB_TOURNAMENT_REFUND').map((x) => [x.actor, x.d.amount, x.d.reason]))
      .toEqual([[String(A), 500, 'club_deleted'], [String(B), 500, 'club_deleted']]);
    expect(w.of('SA', 'clubTournamentCancelled')).toEqual([{ tournamentId: id, clubId: 7, refunded: 500, reason: 'club_deleted' }]);
    expect(w.m.clubTournamentStats.cancelledBeforeStart).toBe(1);
  });

  it('a RUNNING club tournament refuses the delete (club_tournament_running) — nothing changes and its prizes are still paid', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world();
      const { id, liveId, owner } = await startedClubTournament(w);
      await owner.handlers.deleteClub({ clubId: 7 });
      expect(w.of('SO', 'clubDeleted')).toEqual([]);
      expect(w.of('SO', 'error')).toEqual([expect.objectContaining({ code: 'club_tournament_running' })]);
      expect(w.d.clubs.has(7)).toBe(true);
      expect(w.d.clubTournaments.get(id)!.status).toBe('running');
      // It still finishes and pays (the outcome guard's row is there).
      let data: any = null;
      w.tm.onEvent(liveId, (ev, dd) => { if (ev === 'tournamentFinished') data = dd; });
      w.tm.startTournament(liveId);
      w.tm.eliminatePlayer(liveId, 'user-102');
      await w.m.payTournamentPrizes(data);
      expect([w.d.wallets.get(A), w.d.wallets.get(B)]).toEqual([9_500 + 625, 9_500 + 375]);   // pre-F103: TOURNAMENT_PRIZE_CONFLICT_UNRESOLVED, 9,500 each
    } finally { jest.useRealTimers(); }
  });

  it('only the owner deletes (a member is refused, nothing moves); a club without tournaments is deleted as before', async () => {
    const w = world();
    const r = await clubs.createClubTournament(7, OWNER, { name: 'Cup', buyIn: 300, scheduledAt: 'x' });
    const a = w.mkSocket('SA', A);
    await a.handlers.registerClubTournament({ tournamentId: r.tournament.id });
    await a.handlers.deleteClub({ clubId: 7 });
    expect(w.of('SA', 'error')).toEqual([expect.objectContaining({ message: 'Only the club owner can delete the club' })]);
    expect(w.d.wallets.get(A)).toBe(9_700);
    expect(w.d.clubs.has(7)).toBe(true);
    const w2 = world();
    const o2 = w2.mkSocket('SO', OWNER);
    await o2.handlers.deleteClub({ clubId: 7 });
    expect(w2.of('SO', 'clubDeleted')).toEqual([{ clubId: 7 }]);
    expect(w2.d.members.filter((m) => m.clubid === 7)).toEqual([]);
  });
});

// ═══════════════════════════════════════════ F104 (gameplay audit 2026-10-21) ══
describe('F104 — a scheduled club table fires as a REAL club table members can see and join', () => {
  const past = () => new Date(Date.now() - 60_000).toISOString();

  it('Activate Now: a club_tables row of the SCHEDULE\'s club, pointed at the runtime table — listed, and joinable through joinClubTable', async () => {
    const w = world();
    const owner = w.mkSocket('SO', OWNER);
    await owner.handlers.scheduleClubTable({ clubId: 7, config: { tableName: 'Sunday Game', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxSeats: 6 }, scheduledTime: past(), recurring: false });
    const sid = w.of('SO', 'clubTableScheduled')[0].scheduledTable.id as number;
    // The client's clubId (8) is not the row's (7): the row's wins.
    await owner.handlers.activateScheduledClubTable({ id: sid, clubId: 8 });
    const act = w.of('SO', 'scheduledClubTableActivated')[0];
    expect(act).toMatchObject({ success: true, clubId: 7 });
    const rows = [...w.d.clubTables.values()];
    expect(rows).toEqual([expect.objectContaining({ clubid: 7, tablename: 'Sunday Game', maxseats: 6, isactive: 1, tableid: act.tableId })]);   // pre-F104: []
    expect(rows[0].maxbuyin).toBeGreaterThanOrEqual(1000);
    expect(w.clubTableIds.has(act.tableId)).toBe(true);
    expect(w.clubIdByTable.get(act.tableId)).toBe(7);
    expect(w.created).toEqual([{ tableName: '[Pub Club] Sunday Game', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 }]);
    expect(w.runtime.get(act.tableId).maxOccupiableSeats).toBe(6);
    const a = w.mkSocket('SA', A);
    await a.handlers.getClubTables({ clubId: 7 });
    expect(w.of('SA', 'clubTables')[0].tables).toEqual([expect.objectContaining({ id: rows[0].id, tableId: act.tableId })]);
    await a.handlers.joinClubTable({ clubTableId: rows[0].id, playerName: 'x', seatIndex: 2, buyIn: 2000 });
    expect(w.joins).toEqual([expect.objectContaining({ tableId: act.tableId, seatIndex: 2, buyIn: 2000 })]);
  });

  it('a RECURRING schedule keeps ONE club table: the next occurrence reuses it (no new row, no new runtime table)', async () => {
    const w = world();
    const owner = w.mkSocket('SO', OWNER);
    await owner.handlers.scheduleClubTable({ clubId: 7, config: { tableName: 'Daily', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 }, scheduledTime: past(), recurring: true, recurrencePattern: 'daily' });
    await w.m.sweepScheduledClubTables();
    expect(w.d.clubTables.size).toBe(1);
    const row = [...w.d.clubTables.values()][0];
    const next = [...w.d.scheduledTables.values()].find((t) => t.status === 'scheduled')!;
    expect(next.clubtableid).toBe(row.id);                                // carried to the next occurrence
    expect(w.globalEmits.filter(([ev]) => ev === 'scheduledClubTableActivated')).toEqual([[
      'scheduledClubTableActivated', { success: true, tableId: row.tableid, clubId: 7 },
    ]]);
    next.scheduledtime = past();                                          // the next day comes
    await w.m.sweepScheduledClubTables();
    expect(w.d.clubTables.size).toBe(1);                                  // pre-F104: one more bots-only orphan per day
    expect(w.created).toHaveLength(1);
    // Closed by a manager meanwhile: the next occurrence makes a new one.
    row.isactive = 0;
    const third = [...w.d.scheduledTables.values()].find((t) => t.status === 'scheduled')!;
    third.scheduledtime = past();
    await w.m.sweepScheduledClubTables();
    expect(w.d.clubTables.size).toBe(2);
  });

  it('a DB error while making the club table puts the claimed row back to scheduled: the next sweep makes it (the occurrence is not lost)', async () => {
    const w = world();
    const owner = w.mkSocket('SO', OWNER);
    await owner.handlers.scheduleClubTable({ clubId: 7, config: { tableName: 'Blip', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 }, scheduledTime: past(), recurring: false });
    const sid = w.of('SO', 'clubTableScheduled')[0].scheduledTable.id as number;
    w.d.failNext(/INSERT INTO club_tables/);
    await w.m.sweepScheduledClubTables();
    expect(w.d.clubTables.size).toBe(0);
    expect(w.d.scheduledTables.get(sid)!.status).toBe('scheduled');
    expect(w.created).toEqual([]);                                        // never a bare runtime table
    await w.m.sweepScheduledClubTables();
    expect(w.d.clubTables.size).toBe(1);
    expect(w.d.scheduledTables.get(sid)!.status).toBe('active');
  });

  // F104 fix-up (review) — the SECOND step (pointing the row at its runtime
  // table, updateClubTableId) failed past every caller: the claimed row stayed
  // 'active', a recurring series stopped, an unlisted bots-only runtime table
  // was left behind, and Activate answered nothing (the handler rejected).
  const RETRY = { message: 'Could not open the table right now — please try again.', code: 'scheduled_table_retry' };

  it('fix-up — a DB error POINTING the row at its runtime table (Activate): "try again" (not invalid settings), the row is put back, the unreachable table is closed; Activate again makes ONE table', async () => {
    const w = world();
    const owner = w.mkSocket('SO', OWNER);
    await owner.handlers.scheduleClubTable({ clubId: 7, config: { tableName: 'Blip', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 }, scheduledTime: past(), recurring: false });
    const sid = w.of('SO', 'clubTableScheduled')[0].scheduledTable.id as number;
    w.d.failNext(/UPDATE club_tables SET tableId/);
    await owner.handlers.activateScheduledClubTable({ id: sid, clubId: 7 });   // pre-fix-up: rejected — no answer at all
    expect(w.of('SO', 'error')).toEqual([RETRY]);
    expect(w.d.scheduledTables.get(sid)!.status).toBe('scheduled');      // pre-fix-up: stuck 'active'
    expect(w.created).toHaveLength(1);
    expect(w.runtime.size).toBe(0);                                       // pre-fix-up: an unlisted bots-only table kept dealing
    expect(w.clubTableIds.size).toBe(0);
    expect(w.clubIdByTable.size).toBe(0);
    expect(w.m.clubTableRuntimeStats.closedUnbound).toBe(1);
    await owner.handlers.activateScheduledClubTable({ id: sid, clubId: 7 });
    const act = w.of('SO', 'scheduledClubTableActivated')[0];
    expect(act).toMatchObject({ success: true, clubId: 7 });
    expect(w.d.clubTables.size).toBe(1);                                  // the row made the first time is reused
    expect([...w.d.clubTables.values()][0].tableid).toBe(act.tableId);
    expect([...w.runtime.keys()]).toEqual([act.tableId]);
  });

  it('fix-up — the same DB error at the AUTO-FIRE: the row goes back to scheduled, the next sweep fires it and the RECURRING series keeps going', async () => {
    const w = world();
    const owner = w.mkSocket('SO', OWNER);
    await owner.handlers.scheduleClubTable({ clubId: 7, config: { tableName: 'Daily', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 }, scheduledTime: past(), recurring: true, recurrencePattern: 'daily' });
    const sid = w.of('SO', 'clubTableScheduled')[0].scheduledTable.id as number;
    w.d.failNext(/UPDATE club_tables SET tableId/);
    await w.m.sweepScheduledClubTables();
    expect(w.d.scheduledTables.get(sid)!.status).toBe('scheduled');      // pre-fix-up: 'active' and no next occurrence — the series ended
    expect(w.d.scheduledTables.size).toBe(1);
    expect(w.runtime.size).toBe(0);
    expect(w.globalEmits.filter(([ev]) => ev === 'scheduledClubTableActivated')).toEqual([]);
    await w.m.sweepScheduledClubTables();
    expect(w.d.scheduledTables.get(sid)!.status).toBe('active');
    expect([...w.d.scheduledTables.values()].filter((t) => t.status === 'scheduled')).toHaveLength(1);   // the next occurrence
    expect(w.d.clubTables.size).toBe(1);
    expect(w.runtime.size).toBe(1);
  });

  it('fix-up — Activate tells a DB failure making the club table row ("try again") from settings that can never make a table ("Invalid table settings")', async () => {
    const w = world();
    const owner = w.mkSocket('SO', OWNER);
    await owner.handlers.scheduleClubTable({ clubId: 7, config: { tableName: 'Blip', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 }, scheduledTime: past(), recurring: false });
    const sid = w.of('SO', 'clubTableScheduled')[0].scheduledTable.id as number;
    w.d.failNext(/INSERT INTO club_tables/);
    await owner.handlers.activateScheduledClubTable({ id: sid, clubId: 7 });
    expect(w.of('SO', 'error')).toEqual([RETRY]);                        // pre-fix-up: 'Invalid table settings…' (invalid_table_config)
    expect(w.d.scheduledTables.get(sid)!.status).toBe('scheduled');
    // A stored config that can never make a table (older than the schedule-time check) keeps its answer.
    w.d.scheduledTables.get(sid)!.tableconfig = JSON.stringify({ tableName: 'Bad', smallBlind: 25, bigBlind: 50, minBuyIn: -1_000_000 });
    await owner.handlers.activateScheduledClubTable({ id: sid, clubId: 7 });
    expect(w.of('SO', 'error')[1]).toEqual({ message: 'Invalid table settings for this scheduled table', code: 'invalid_table_config' });
    expect(w.runtime.size).toBe(0);
  });
});

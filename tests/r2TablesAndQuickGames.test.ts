/**
 * R2 (2026-10-11, S1) — who may sit where, and quick games that END.
 *
 * C1 (TOURNEY-11 / APPUI-40 / GAME-4 / R1REV-MONEY-3): the lobby list and
 * /api/tables carry ONLY joinable public cash tables (with seats / phase / pot),
 * and joinTable / joinAdditionalTable / quickPlay / an invite code refuse every
 * other kind (`table_not_joinable`) before any side effect — except a private
 * game by its invite code, a club table through joinClubTable and a club
 * challenge for its two players.
 * C12 (APPUI-20 / GAME-4): a private home game honours maxSeats, is never
 * listed, its creation is rate-limited, and it is removed 10 minutes after the
 * last human left.
 * TOURNEY-6 / GAME-7 / ECON-8 / CLUBS-1 + the money reviewer's P2: quick tables
 * never reload a busted bot; heads-up / all-in-or-fold / career / club
 * challenges END (bust = game over, stack cashed out once); a Spin & Go is a
 * prize format (win = multiplier x fee through the prize ledger, a leave
 * forfeits, a forced removal refunds the fee, its stack is never cashed).
 * TOURNEY-11: a finished tournament's tables are removed after the result.
 *
 * Every handler / helper below is the REAL source of src/index.ts (sliced and
 * transpiled), with the REAL PokerTable, quickGameOutcome and prize ledger.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { quickGameOutcome, spinGoMultiplierFor } from '../src/game/quickGames';
import { createPrizeLedger } from '../src/game/prizeLedger';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { validateTableConfig } from '../src/game/tableConfigValidation';
import { accountDisplayName } from '../src/auth/displayName';
import { CAREER_VENUE_LEVELS } from '../src/economy/catalog';
import { SRC, slice, fnSrc, handlerSrc, load, flush, JOIN_PRECHECK_SRC } from './helpers/indexSource';
import { createFakeLedgerDb } from './helpers/fakeLedgerDb';

const ALICE = 101;
const BOB = 102;

const WHO = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', '}, 60_000).unref?.();\n');
const QUICK = slice('// R2 (ECON-17) — every prize / refund settlement', '\n// ========== Socket.io Events ==========');
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const RETIRE = slice('const FINISHED_TOURNAMENT_TABLE_RETIRE_MS', '\n// Periodically check for timed tournaments');
const H = {
  getTableList: handlerSrc('getTableList', '\n  });\n'),
  joinTable: handlerSrc('joinTable', '\n    })(); }\n  );'),
  quickPlay: handlerSrc('quickPlay', '\n    })(); }\n  );'),
  joinClubTable: handlerSrc('joinClubTable', '\n  });\n'),
  joinAdditionalTable: handlerSrc('joinAdditionalTable', '\n  });\n'),
  createPrivateTable: handlerSrc('createPrivateTable', '\n  });\n'),
  joinByInviteCode: handlerSrc('joinByInviteCode', '\n  });\n'),
  quickHeadsUp: handlerSrc('quickHeadsUp', '\n  });\n'),
  quickSpinGo: handlerSrc('quickSpinGo', '\n  });\n'),
  quickAllInOrFold: handlerSrc('quickAllInOrFold', '\n  });\n'),
  startCareerGame: handlerSrc('startCareerGame', '\n  });\n'),
  leaveTable: handlerSrc('leaveTable', '\n  });\n'),
};
const LEAVE = fnSrc('function handlePlayerLeave(');
const AUTOSTART = fnSrc('function autoStartNextHand(');
// R2 merge (S2, GAME-18): autoStartNextHand's bot step (reload + cap) asks the fixed-roster predicate.
const BOT_STACKS = slice('const BOT_STACK_CAP_BUYINS: number = ', '  return isFixedRosterTable(tableId);\n}\n');
const IS_TOURNAMENT_RESERVATION = fnSrc('function isTournamentReservation(');
// R2 (CLUBS-4): joinClubTable finds (or re-creates) the club table's runtime table.
const CLUB_RUNTIME = slice('const clubTablesRecreating = new Map', '\n  return job;\n}\n');
// F109 fix-up (2026-10-21): startCareerGame answers a record that cannot load with the economy's progress_loading text.
const ECONOMY_MESSAGE = fnSrc('function economyMessage(');

function world(opts: { wallets?: Record<number, number> } = {}) {
  const db = createFakeLedgerDb(opts.wallets ?? { [ALICE]: 1_000_000, [BOB]: 1_000_000 });
  const credits: Array<{ uid: number; amount: number }> = [];
  const deductions: Array<{ uid: number; amount: number }> = [];
  const audits: Array<{ action: string; d: any }> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const challengesResolved: Array<[number, number | null]> = [];
  const tables = new Map<string, PokerTable>();
  let created = 0;
  let uid = 0;
  let botN = 0;
  const mkTable =(id: string, opts2: { sb?: number; bb?: number; minBuyIn?: number; name?: string } = {}) => {
    const t = new PokerTable({ tableId: id, tableName: opts2.name ?? id, smallBlind: opts2.sb ?? 25, bigBlind: opts2.bb ?? 50, ante: 0, minBuyIn: opts2.minBuyIn ?? 1000 } as any);
    tables.set(id, t);
    return t;
  };
  const sockets = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const scope: Record<string, unknown> = {
    MAX_SEATS: 9, GamePhase, SEAT_RESERVE_MS: 6 * 3600_000,
    tableManager: {
      getTable: (id: string) => tables.get(id),
      removeTable: (id: string) => tables.delete(id),
      getTableList: () => [...tables.entries()].map(([tableId, t]) => ({
        tableId, tableName: t.config.tableName, smallBlind: t.config.smallBlind, bigBlind: t.config.bigBlind,
        minBuyIn: t.config.minBuyIn, playerCount: t.getOccupiedSeatCount(), maxSeats: t.maxOccupiableSeats, ante: 0,
        variant: 'texas-holdem', variantName: "Texas Hold'em",
      })),
      createHeadsUpTable: (name: string) => { const id = `hu${++created}`; mkTable(id, { name, minBuyIn: 1000 }); return id; },
      createQuickTable: (name: string, _max: number, sb: number, bb: number, minBuyIn: number) => { const id = `qt${++created}`; mkTable(id, { name, sb, bb, minBuyIn }); return id; },
      createVariantTable: (cfg: any) => { const id = `${(0xa0000000 + (++created)).toString(16)}-0000-4000-8000-000000000000`; mkTable(id, { name: cfg.tableName, sb: cfg.smallBlind, bb: cfg.bigBlind, minBuyIn: cfg.minBuyIn }); return id; },
      createTable: (cfg: any) => { const id = `ct${++created}`; mkTable(id, { name: cfg.tableName, sb: cfg.smallBlind, bb: cfg.bigBlind, minBuyIn: cfg.minBuyIn }); return id; },
    },
    io: {
      to: (room: string) => ({ emit: (ev: string, p: any) => roomEmits.push([room, ev, p]), except: () => ({ emit() {} }) }),
      emit() {}, sockets: { sockets },
    },
    authSessions, playerSessions,
    multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
    spectators: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(), quickTables: new Set(),
    spinGoMultipliers: new Map(), allInOrFoldTables: new Set(), careerTables: new Map(), challengeTables: new Map(),
    quickGameTimers: new Map(), turnTimers: new Map(), turnWarningTimers: new Map(), pendingAutoStartTimers: new Map(),
    aiTimeouts: new Map(), insuranceCashouts: new Map(), tableProgressListeners: new Set(), lastSentState: new Map(),
    lastSentJson: new Map(), bombPotPending: new Map(), fastModeTables: new Map(), tournamentTables: new Map(),
    ipSeatedSlots: new Map(), clientIp: '203.0.113.9', dealersChoiceState: new Map(),
    tournamentManager: new TournamentManager(),
    clearInsuranceOffer() {}, releaseSeatedSlot() {}, syncSitOutToTable() {}, broadcastGameState() {}, scheduleAIAction() {},
    sendProgressToPlayer() {}, ensureTableProgressListener() {}, detachSocketFromOtherTables() {}, clearGhostSeatsForUser() {},
    keepTournamentSeatOnLeave: () => false, activateBombPotIfPending() {}, executePendingMove: () => false, trimExcessAI() {},
    fillWithAI() {}, tournamentDealWaitsForBustCheck: () => false,
    emitGameState() {}, getGameStateForPlayer: () => ({}), sanitizeSeatAvatar: () => undefined,
    // F109 (2026-10-21): startCareerGame reads the account's level (none loaded here = level 1).
    progressionManager: { getOrCreateProgress() {}, getClientProgress: () => null, userRecord: () => undefined },
    // F109 fix-up: ...from the HYDRATED record — ensureHydrated (connection-scoped in index.ts) awaits the load.
    ensureHydrated: async (s: any) => {
      const a = authSessions.get(s.id);
      return a ? { userId: a.userId, playerId: `user-${a.userId}`, username: a.username, hydrated: true } : null;
    },
    assertPlayable: async () => null, emitPlayRefusal: (s: any, r: any) => s.emit('error', { code: r.code }),
    isUserBanned: async () => false, buyInSocketGone: async () => false, blockedByMaintenance: () => false,
    quickPlayRateLimited: () => false, refuseCashJoinAtTournamentTable: (s: any) => s.emit('error', { code: 'tournament_table' }),
    seatNameForSocket: (s: any, n?: unknown) => accountDisplayName(authSessions.get(s.id)?.displayName ?? n),
    publicNameOf: (n: unknown) => String(n ?? ''),
    uuidv4: () => `u${++uid}`,
    generateRandomProfile: () => ({ botName: `Bot${++botN}` }),
    ensureChipsForBuyIn: async (uid: number) => db.wallets.get(uid) ?? 0,
    getUserChips: async (uid: number) => db.wallets.get(uid) ?? 0,
    UNLIMITED_CHIPS_TESTING: false,
    deductChips: async (uid: number, amount: number) => {
      const have = db.wallets.get(uid) ?? 0;
      if (have < amount) return false;
      db.wallets.set(uid, have - amount);
      deductions.push({ uid, amount });
      return true;
    },
    addChipsToUser: async (uid: number, amount: number) => {
      db.wallets.set(uid, (db.wallets.get(uid) ?? 0) + amount);
      credits.push({ uid, amount });
      return true;
    },
    auditLog: (_actor: string, action: string, d: any) => { audits.push({ action, d }); },
    resolveChallenge: async (id: number, w: number | null) => { challengesResolved.push([id, w]); },
    getClubTableById: async () => ({ clubId: 7, tableId: 'club1' }),
    isClubMember: async (_c: number, uid: number) => uid === ALICE,
    upsertCareerProgress: async () => {}, claimCareerReward: async () => false, CAREER_VENUE_LEVELS,   // F109
    getPool: () => ({ connect: () => db.connect() }),
    createPrizeLedger, quickGameOutcome, spinGoMultiplierFor, createWindowRateLimiter, validateTableConfig,
    console: { log() {}, warn() {}, error() {} },
    log: { debug() {}, info() {}, warn() {} },
  };
  const code = `
${BROKEN}
${WHO}
${QUICK}
${RETIRE}
${IS_TOURNAMENT_RESERVATION}
${CLUB_RUNTIME}
${ECONOMY_MESSAGE}
${LEAVE}
${BOT_STACKS}
${AUTOSTART}
${JOIN_PRECHECK_SRC}
function wire(socket) {
  ${Object.values(H).join('\n  ')}
}`;
  const { exports: m } = load(code, scope, `{ wire, publicTableList, isPublicCashTable, tableKindOf, isFixedRosterTable, quickGames, quickGameStats,
    cleanupQuickTable, sweepQuickTables, quickGameEndCheck, sweepIdlePrivateTables, privateTableIds, privateTableMeta, clubTableIds,
    retireFinishedTournamentTable, isTournamentTable, brokenTournamentTables, isTournamentReservation, handlePlayerLeave, autoStartNextHand,
    prizeLedger, tableJoinRefusals, privateTableStats, PRIVATE_TABLE_IDLE_MS }`);

  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (id: string, userId: number | null = ALICE, name = 'Alice') => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const rooms = new Set<string>();
    const s: any = {
      id, connected: true, handlers, rooms, handshake: { address: '100.64.0.1', headers: {} },
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      listeners: (ev: string) => (handlers[ev] ? [handlers[ev]] : []),
      emit: (ev: string, p: any) => { emitted.push([id, ev, p]); },
      join: (r: string) => rooms.add(r), leave: (r: string) => rooms.delete(r),
    };
    sockets.set(id, s);
    if (userId !== null) authSessions.set(id, { userId, username: `${name.toLowerCase()}.player`, masterUserId: `m-${userId}`, displayName: name });
    m.wire(s);
    return s;
  };
  const errorsOf = (id: string, ev = 'error') => emitted.filter(([sid, e]) => sid === id && e === ev).map(([, , p]) => p);
  return { m, scope, db, credits, deductions, audits, roomEmits, challengesResolved, tables, mkTable, mkSocket, emitted, errorsOf, playerSessions, authSessions };
}

/** End the hand in progress with these final stacks (seat -> chips), then emit handResult like determineWinners. */
function finishHand(t: PokerTable, stacks: Record<number, number>): void {
  for (const [i, c] of Object.entries(stacks)) { t.seats[Number(i)].chipCount = c; t.seats[Number(i)].totalInvestedThisHand = 0; }
  (t as any).currentPhase = GamePhase.HandComplete;
  t.emit('handResult', { results: [], handNumber: t.handNumber });
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.useRealTimers(); });

describe('C1 — the lobby list carries ONLY joinable public cash tables, with seats / phase / pot', () => {
  it('quick / career / Spin & Go / heads-up / all-in-or-fold / tournament / private / club / challenge tables are never listed', () => {
    const w = world();
    const cash = w.mkTable('cash1', { name: "Beginner's" });
    cash.sitDown(0, 'Alice', 5000, 'p-a', false);
    cash.sitDown(3, 'BotX', 5000, 'ai-x', true);
    for (const id of ['hu', 'sng', 'car', 'aof', 'tour', 'priv', 'club', 'chal']) w.mkTable(id);
    (w.scope.quickTables as Set<string>).add('hu');
    (w.scope.spinGoMultipliers as Map<string, number>).set('sng', 2); (w.scope.quickTables as Set<string>).add('sng');
    (w.scope.careerTables as Map<string, any>).set('car', {}); (w.scope.quickTables as Set<string>).add('car');
    (w.scope.allInOrFoldTables as Set<string>).add('aof'); (w.scope.quickTables as Set<string>).add('aof');
    (w.scope.tournamentTables as Map<string, string>).set('tour', 'T1');
    w.m.privateTableIds.add('priv'); w.m.clubTableIds.add('club');
    (w.scope.challengeTables as Map<string, any>).set('chal', { challengeId: 1, challengerId: ALICE, challengedId: BOB });
    (w.scope.quickTables as Set<string>).add('chal');
    const list = w.m.publicTableList();
    expect(list.map((t: any) => t.tableId)).toEqual(['cash1']);
    expect(list[0]).toMatchObject({
      kind: 'cash', tableId: 'cash1', maxSeats: 9, seatsTaken: 2, phase: GamePhase.WaitingForPlayers, pot: 0, variant: 'texas-holdem',
    });
    expect(list[0].seats).toHaveLength(9);
    expect(list[0].seats[0]).toEqual({ index: 0, occupied: true, name: 'Alice' });
    expect(list[0].seats[1]).toEqual({ index: 1, occupied: false, name: null });
    expect(list[0].seats[3]).toEqual({ index: 3, occupied: true, name: 'BotX' });
    // The socket list answers the same thing.
    const s = w.mkSocket('S1');
    s.handlers.getTableList();
    expect(w.emitted.find(([, ev]) => ev === 'tableList')![2].map((t: any) => t.tableId)).toEqual(['cash1']);
  });

  it('a club challenge table stays tableKind club (R1 contract #2) although it is a fixed-roster quick table now', () => {
    const w = world();
    w.mkTable('chal');
    (w.scope.challengeTables as Map<string, any>).set('chal', { challengeId: 1, challengerId: ALICE, challengedId: BOB });
    (w.scope.quickTables as Set<string>).add('chal');
    expect(w.m.tableKindOf('chal')).toBe('club');
    expect(w.m.isFixedRosterTable('chal')).toBe(true);
  });

  it('REST /api/tables and the socket list are the same function', () => {
    expect(SRC).toContain("app.get('/api/tables', (_req, res) => {\n  res.json(publicTableList());\n});");
    expect(H.getTableList).toContain("socket.emit('tableList', publicTableList());");
  });
});

describe('C1 — joinTable refuses every table that is not a joinable public cash table, before any side effect', () => {
  const kinds: Array<[string, (w: ReturnType<typeof world>) => void, string]> = [
    ['heads-up', (w) => (w.scope.quickTables as Set<string>).add('x'), 'quick_game_table'],
    ['Spin & Go', (w) => { (w.scope.quickTables as Set<string>).add('x'); (w.scope.spinGoMultipliers as Map<string, number>).set('x', 3); }, 'quick_game_table'],
    ['career', (w) => { (w.scope.quickTables as Set<string>).add('x'); (w.scope.careerTables as Map<string, any>).set('x', {}); }, 'quick_game_table'],
    ['all-in-or-fold', (w) => { (w.scope.quickTables as Set<string>).add('x'); (w.scope.allInOrFoldTables as Set<string>).add('x'); }, 'quick_game_table'],
    ['private', (w) => w.m.privateTableIds.add('x'), 'invite_code_only'],
    ['club', (w) => w.m.clubTableIds.add('x'), 'club_members_via_club'],
    ['club challenge (a stranger)', (w) => {
      (w.scope.challengeTables as Map<string, any>).set('x', { challengeId: 9, challengerId: 555, challengedId: 556 }); (w.scope.quickTables as Set<string>).add('x');
    }, 'challenge_players_only'],
  ];
  it.each(kinds)('%s: table_not_joinable, nothing deducted, nobody seated, no bot bumped', async (_name, mark, reason) => {
    const w = world();
    const t = w.mkTable('x');
    t.sitDown(1, 'Bot', 1000, 'ai-1', true);
    mark(w);
    const s = w.mkSocket('S1');
    await s.handlers.joinTable({ tableId: 'x', playerName: 'Alice', seatIndex: 1, buyIn: 1000 });
    expect(w.errorsOf('S1')).toEqual([expect.objectContaining({ code: 'table_not_joinable', reason })]);
    expect(w.deductions).toEqual([]);
    expect(t.seats[1]).toMatchObject({ state: 'occupied', isAI: true });
    expect(w.playerSessions.has('S1')).toBe(false);
  });

  it('control — a public cash table seats him (one deduct)', async () => {
    const w = world();
    const t = w.mkTable('cash1');
    const s = w.mkSocket('S1');
    await s.handlers.joinTable({ tableId: 'cash1', playerName: 'Alice', seatIndex: 2, buyIn: 1000 });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(t.seats[2]).toMatchObject({ state: 'occupied', playerName: 'Alice' });
  });

  it('a club table through joinClubTable (membership checked, the grant object) seats a member; a direct joinTable never does', async () => {
    const w = world();
    const t = w.mkTable('club1');
    w.m.clubTableIds.add('club1');
    const s = w.mkSocket('S1');
    await s.handlers.joinTable({ tableId: 'club1', playerName: 'Alice', seatIndex: 0, buyIn: 1000 });
    expect(w.errorsOf('S1')).toEqual([expect.objectContaining({ code: 'table_not_joinable' })]);
    // A forged "grant" key in a client frame is just data.
    await s.handlers.joinTable({ tableId: 'club1', playerName: 'Alice', seatIndex: 0, buyIn: 1000, viaClub: true, clubJoinGrant: true });
    expect(t.seats[0].state).toBe('empty');
    await s.handlers.joinClubTable({ clubTableId: 3, playerName: 'Alice', seatIndex: 0, buyIn: 1000 });
    await flush();
    expect(t.seats[0]).toMatchObject({ state: 'occupied', playerName: 'Alice' });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
  });

  it('a club challenge table: its two players buy in for EXACTLY the stakes; nobody else; no bot is ever added', async () => {
    const w = world();
    const t = w.mkTable('chal', { minBuyIn: 2000 });
    t.maxOccupiableSeats = 2;
    (w.scope.challengeTables as Map<string, any>).set('chal', { challengeId: 4, challengerId: ALICE, challengedId: BOB });
    (w.scope.quickTables as Set<string>).add('chal');
    let filled = 0;
    w.scope.fillWithAI = () => { filled++; };
    const a = w.mkSocket('SA', ALICE, 'Alice');
    await a.handlers.joinTable({ tableId: 'chal', playerName: 'Alice', seatIndex: -1, buyIn: 20000 });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 2000 }]);   // not 20,000
    const c = w.mkSocket('SC', 777, 'Carl');
    await c.handlers.joinTable({ tableId: 'chal', playerName: 'Carl', seatIndex: -1, buyIn: 2000 });
    expect(w.errorsOf('SC')).toEqual([expect.objectContaining({ code: 'table_not_joinable', reason: 'challenge_players_only' })]);
    const b = w.mkSocket('SB', BOB, 'Bob');
    w.scope.clientIp = '198.51.100.7';                            // Bob's own network
    await b.handlers.joinTable({ tableId: 'chal', playerName: 'Bob', seatIndex: -1, buyIn: 2000 });
    expect(t.seats.filter((x) => x.state === 'occupied').map((x) => x.playerName)).toEqual(['Alice', 'Bob']);
    expect(filled).toBe(0);
  });

  it('joinAdditionalTable: only at a public cash table (a quick / private / club table is refused before the AI stand-up)', async () => {
    const w = world();
    const t = w.mkTable('priv');
    t.sitDown(0, 'Bot', 1000, 'ai-0', true);
    w.m.privateTableIds.add('priv');
    const s = w.mkSocket('S1');
    await s.handlers.joinAdditionalTable({ tableId: 'priv', playerName: 'Alice', buyIn: 1000 });
    expect(w.errorsOf('S1')).toEqual([expect.objectContaining({ code: 'table_not_joinable' })]);
    expect(t.seats[0]).toMatchObject({ state: 'occupied', isAI: true });
    expect(w.deductions).toEqual([]);
  });
});

describe('C1 / GAME-4 — Quick Play picks only public cash tables it can afford', () => {
  it('never a private home game or a quick table — even the emptiest, cheapest one', async () => {
    const w = world();
    const cash = w.mkTable('cash1', { sb: 25, bb: 50, minBuyIn: 1000 });
    cash.sitDown(0, 'Bot0', 1000, 'ai-0', true); cash.sitDown(1, 'Bot1', 1000, 'ai-1', true);
    w.mkTable('priv', { sb: 1, bb: 2, minBuyIn: 40 }); w.m.privateTableIds.add('priv');
    w.mkTable('hu', { sb: 1, bb: 2, minBuyIn: 40 }); (w.scope.quickTables as Set<string>).add('hu');
    const s = w.mkSocket('S1');
    await s.handlers.quickPlay({ playerName: 'Alice' });
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1' });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
  });

  it('an EMPTIER table he cannot afford is skipped for one he can (it used to error "Insufficient chips")', async () => {
    const w = world({ wallets: { [ALICE]: 6000 } });
    const shark = w.mkTable('shark', { sb: 100, bb: 200, minBuyIn: 20000 });
    const beginner = w.mkTable('beg', { sb: 25, bb: 50, minBuyIn: 5000 });
    beginner.sitDown(0, 'Bot0', 5000, 'ai-0', true); beginner.sitDown(1, 'Bot1', 5000, 'ai-1', true);
    const s = w.mkSocket('S1');
    await s.handlers.quickPlay({ playerName: 'Alice' });
    expect(shark.seats.every((x) => x.state === 'empty')).toBe(true);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'beg' });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 5000 }]);
  });

  it('none affordable → insufficient_chips, nothing touched', async () => {
    const w = world({ wallets: { [ALICE]: 100 } });
    w.mkTable('beg', { minBuyIn: 5000 });
    const s = w.mkSocket('S1');
    await s.handlers.quickPlay({ playerName: 'Alice' });
    expect(w.errorsOf('S1')).toEqual([expect.objectContaining({ code: 'insufficient_chips' })]);
    expect(w.deductions).toEqual([]);
  });
});

describe('C12 — private home games', () => {
  it('created with maxSeats honoured, the invite code returned, never listed', async () => {
    const w = world();
    w.mkTable('cash1');
    const s = w.mkSocket('S1');
    await s.handlers.createPrivateTable({ tableName: 'Home', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxSeats: 4 });
    const created = w.emitted.find(([, ev]) => ev === 'privateTableCreated')![2];
    expect(created.inviteCode).toBe(created.tableId.slice(0, 8).toUpperCase());
    const t = w.tables.get(created.tableId)!;
    expect(t.maxOccupiableSeats).toBe(4);
    expect(t.sitDown(4, 'X', 1000, 'p-x', false)).toBe(false);        // seat 5 does not exist at a 4-seat game
    expect(w.m.publicTableList().map((x: any) => x.tableId)).toEqual(['cash1']);
  });

  it('creation is rate-limited per account and capped at 2 live games per account', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    const make = () => s.handlers.createPrivateTable({ tableName: 'Home', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxSeats: 6 });
    await make(); await make();
    await make();                                                   // a third live game: refused (not counted)
    expect(w.errorsOf('S1').map((e) => e.code)).toEqual(['private_table_limit']);
    // Both close (nobody sat for 10 minutes): one more is allowed (the 3rd this window), a 4th is rate-limited.
    w.m.sweepIdlePrivateTables(Date.now() + w.m.PRIVATE_TABLE_IDLE_MS + 1);
    expect(w.m.privateTableIds.size).toBe(0);
    await make();
    expect(w.m.privateTableIds.size).toBe(1);
    await make();
    expect(w.errorsOf('S1').map((e) => e.code)).toEqual(['private_table_limit', 'rate_limited']);
    expect(w.m.privateTableIds.size).toBe(1);
  });

  it('an invite code opens a PRIVATE table only (never a public / quick table), and seats the invitee', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    await s.handlers.createPrivateTable({ tableName: 'Home', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxSeats: 6 });
    const { tableId, inviteCode } = w.emitted.find(([, ev]) => ev === 'privateTableCreated')![2];
    // A quick table whose id starts with the same 8 characters is never matched by a code.
    const quickId = `${tableId.slice(0, 8)}-quick`;
    w.mkTable(quickId); (w.scope.quickTables as Set<string>).add(quickId);
    const b = w.mkSocket('SB', BOB, 'Bob');
    await b.handlers.joinByInviteCode({ inviteCode: 'cash1xyz', playerName: 'Bob', buyIn: 1000 });
    expect(w.errorsOf('SB', 'joinError')).toEqual([expect.objectContaining({ code: 'invite_code_not_found' })]);
    await b.handlers.joinByInviteCode({ inviteCode: inviteCode.toLowerCase(), playerName: 'Bob', buyIn: 1000 });
    expect(w.playerSessions.get('SB')).toMatchObject({ tableId });
    expect(w.tables.get(quickId)!.seats.every((x) => x.state === 'empty')).toBe(true);
  });

  it('removed 10 minutes after the last human left (bots never keep it alive); a human back in time resets the clock', () => {
    const w = world();
    const t = w.mkTable('priv'); w.m.privateTableIds.add('priv');
    t.sitDown(0, 'Alice', 1000, 'p-a', false); t.sitDown(1, 'Bot', 1000, 'ai-1', true);
    const t0 = 1_000_000;
    w.m.sweepIdlePrivateTables(t0);
    expect(w.tables.has('priv')).toBe(true);
    t.standUp(0);                                                   // the last human left
    w.m.sweepIdlePrivateTables(t0 + 1000);                          // empty since now
    w.m.sweepIdlePrivateTables(t0 + 1000 + 9 * 60_000);
    expect(w.tables.has('priv')).toBe(true);
    t.sitDown(0, 'Alice', 1000, 'p-a', false);                      // back in time
    w.m.sweepIdlePrivateTables(t0 + 1000 + 11 * 60_000);
    expect(w.tables.has('priv')).toBe(true);
    t.standUp(0);
    w.m.sweepIdlePrivateTables(t0 + 20 * 60_000);
    w.m.sweepIdlePrivateTables(t0 + 31 * 60_000);
    expect(w.tables.has('priv')).toBe(false);
    expect(w.m.privateTableIds.has('priv')).toBe(false);
    expect(w.roomEmits).toContainEqual(['table:priv', 'tableClosed', { tableId: 'priv', reason: 'private_table_idle' }]);
  });

  it('the live-room heartbeat never backfills bots at a private table nobody sits at (wiring)', () => {
    const body = fnSrc('function ensureCashTableRunning(');
    expect(body).toContain('if (privateTableIds.has(tableId) && !tableHasHumanSeat(table)) return;');
    expect(body.indexOf('if (privateTableIds.has(tableId) && !tableHasHumanSeat(table)) return;')).toBeLessThan(body.indexOf('backfillAIToMin('));
  });
});

describe('TOURNEY-6 / GAME-7 — a fixed-roster table never reloads a busted bot', () => {
  const bustBot = (w: ReturnType<typeof world>, id: string) => {
    const t = w.mkTable(id, { minBuyIn: 1000 });
    t.sitDown(0, 'Alice', 3000, 'p-a', false); t.sitDown(1, 'Bot1', 0, 'ai-1', true, true); t.sitDown(2, 'Bot2', 2000, 'ai-2', true);
    (t as any).currentPhase = GamePhase.HandComplete;
    return t;
  };
  it('quick table: the busted bot stays at 0 (and is out)', () => {
    const w = world();
    const t = bustBot(w, 'q');
    (w.scope.quickTables as Set<string>).add('q');
    w.m.autoStartNextHand('q');
    expect(t.seats[1].chipCount).toBe(0);
  });
  it('club challenge table: same', () => {
    const w = world();
    const t = bustBot(w, 'c');
    (w.scope.challengeTables as Map<string, any>).set('c', { challengeId: 1, challengerId: ALICE, challengedId: BOB });
    w.m.autoStartNextHand('c');
    expect(t.seats[1].chipCount).toBe(0);
  });
  it('control — a cash ring table still reloads its busted bot', () => {
    const w = world();
    const t = bustBot(w, 'cash');
    w.m.autoStartNextHand('cash');
    expect(t.seats[1].chipCount + t.seats[1].totalInvestedThisHand).toBe(1000);   // reloaded (then blinds posted)
  });
});

describe('quick games END — heads-up / all-in-or-fold / career cash out once; the Spin & Go is a prize format', () => {
  const startHU = async (w: ReturnType<typeof world>) => {
    const s = w.mkSocket('S1');
    await s.handlers.quickHeadsUp({ playerName: 'Alice' });
    const tableId = w.playerSessions.get('S1').tableId;
    return { s, tableId, t: w.tables.get(tableId)! };
  };

  it('heads-up: the bot busts → game over: the result shown, the stack (2,000) cashed out EXACTLY once, the table gone', async () => {
    const w = world();
    const { tableId, t } = await startHU(w);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    finishHand(t, { 0: 2000, 1: 0 });
    expect(w.m.quickGames.get(tableId).ended).toBe(true);
    expect(t.seats[1].state).toBe('empty');                        // the bot never plays again
    expect(t.startNewHand()).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(w.roomEmits.find(([, ev]) => ev === 'quickGameOver')![2]).toMatchObject({ type: 'headsUp', won: true, chips: 2000, winner: 'Alice' });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(w.tables.has(tableId)).toBe(false);
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.roomEmits).toContainEqual([`table:${tableId}`, 'tableClosed', { tableId, reason: 'quick_game_over' }]);
  });

  it('heads-up: the human busts → game over, nothing credited (0 chips), the bot stood up at once', async () => {
    const w = world();
    const { tableId, t } = await startHU(w);
    finishHand(t, { 0: 0, 1: 2000 });
    expect(t.seats[1].state).toBe('empty');
    jest.advanceTimersByTime(6000);
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.roomEmits.find(([, ev]) => ev === 'quickGameOver')![2]).toMatchObject({ won: false });
    expect(w.tables.has(tableId)).toBe(false);
  });

  it("heads-up: the 5-minute clock decides by chips at a hand boundary (mid-hand it waits for the hand's end)", async () => {
    const w = world();
    const { tableId, t } = await startHU(w);
    expect(t.isHandInProgress()).toBe(true);
    jest.advanceTimersByTime(5 * 60_000);
    expect(w.m.quickGames.get(tableId).ended).toBe(false);           // mid-hand: not decided yet
    finishHand(t, { 0: 1300, 1: 700 });
    expect(w.m.quickGames.get(tableId).ended).toBe(true);
    jest.advanceTimersByTime(6000);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 1300 }]);
    expect(w.roomEmits.find(([, ev]) => ev === 'quickGameOver')![2]).toMatchObject({ won: true, chips: 1300 });
  });

  it('all-in-or-fold: the human busts while bots still hold chips → over at once (bots stood up), nothing credited', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    await s.handlers.quickAllInOrFold({ playerName: 'Alice' });
    const tableId = w.playerSessions.get('S1').tableId;
    const t = w.tables.get(tableId)!;
    finishHand(t, { 0: 0, 1: 2000, 2: 1000, 3: 1000, 4: 1000, 5: 1000 });
    expect(t.seats.filter((x) => x.state === 'occupied').map((x) => x.seatIndex)).toEqual([0]);
    jest.advanceTimersByTime(6000);
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.tables.has(tableId)).toBe(false);
  });

  it('career: every bot busts → the stage is WON (careerGameComplete won:true) and the whole stack is cashed out once', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    await s.handlers.startCareerGame({ venue: 0, stage: 0 });
    const tableId = w.playerSessions.get('S1').tableId;
    const t = w.tables.get(tableId)!;
    finishHand(t, { 0: 4000, 1: 0, 2: 0, 3: 0 });
    jest.advanceTimersByTime(1000);
    expect(w.emitted.find(([, ev]) => ev === 'careerGameComplete')![2]).toMatchObject({ venue: 0, stage: 0, won: true, stars: 3 });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 4000 }]);
  });

  it('a DISCONNECTED human (reserved seat) is cashed out by the cleanup once — his reservation ends there, no stale expiry credit', async () => {
    const w = world();
    const { tableId, t } = await startHU(w);
    w.playerSessions.delete('S1');
    const reserved = w.scope.reservedSeats as Map<number, any>;
    let expiryFired = 0;
    reserved.set(ALICE, { tableId, seatIndex: 0, chips: 1000, cleanupTimer: setTimeout(() => { expiryFired++; }, 6 * 3600_000), expiresAt: Date.now() + 1e9, handsRemaining: 10 });
    finishHand(t, { 0: 2000, 1: 0 });
    jest.advanceTimersByTime(6000);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(reserved.has(ALICE)).toBe(false);
    jest.advanceTimersByTime(7 * 3600_000);
    expect(expiryFired).toBe(0);
  });

  it('the sweep removes a quick table nobody (human) sits at any more — bots never play on alone', async () => {
    const w = world();
    const { tableId, t } = await startHU(w);
    t.standUp(0);                                               // e.g. his reservation ended and stood him up
    w.m.sweepQuickTables();
    expect(w.tables.has(tableId)).toBe(false);
    expect(w.m.quickGameStats.cleanedNoHuman).toBeGreaterThan(0);
  });

  describe('Spin & Go — a prize format (ECON-8)', () => {
    const startSNG = async (w: ReturnType<typeof world>) => {
      const s = w.mkSocket('S1');
      jest.spyOn(Math, 'random').mockReturnValue(0.5);           // roll 50 → 2x
      await s.handlers.quickSpinGo({ playerName: 'Alice' });
      (Math.random as any).mockRestore?.();
      const tableId = w.playerSessions.get('S1').tableId;
      jest.advanceTimersByTime(3500);                            // the reveal, then the first hand
      return { s, tableId, t: w.tables.get(tableId)! };
    };

    it('a human WIN pays multiplier x entry fee ONCE through the prize ledger — the stack is never cashed out', async () => {
      const w = world();
      const { tableId, t } = await startSNG(w);
      expect(w.deductions).toEqual([{ uid: ALICE, amount: 500 }]);
      finishHand(t, { 0: 1500, 1: 0, 2: 0 });
      jest.advanceTimersByTime(1000);
      await flush();
      expect(w.db.payouts.get(`spingo:${tableId}:prize`)).toMatchObject({ userId: ALICE, amount: 1000, kind: 'SPINGO_PRIZE' });
      expect(w.roomEmits.find(([, ev]) => ev === 'quickGameOver')![2]).toMatchObject({ type: 'spinGo', won: true, prize: 1000, multiplier: 2 });
      jest.advanceTimersByTime(5000);
      await flush();
      expect(w.credits).toEqual([]);                             // the 1,500 stack is NOT cashed
      expect(w.db.wallets.get(ALICE)).toBe(1_000_000 - 500 + 1000);
      expect(w.audits.map((a) => a.action)).toContain('SPINGO_STACK_NOT_CASHED');
    });

    it('a bust pays nothing; the bots never play on alone', async () => {
      const w = world();
      const { tableId, t } = await startSNG(w);
      finishHand(t, { 0: 0, 1: 900, 2: 600 });
      expect(t.seats.filter((x) => x.state === 'occupied')).toHaveLength(1);
      jest.advanceTimersByTime(6000);
      await flush();
      expect(w.db.payouts.size).toBe(0);
      expect(w.credits).toEqual([]);
      expect(w.tables.has(tableId)).toBe(false);
    });

    it('a VOLUNTARY leave forfeits — nothing credited (it used to cash out up to 3x, more than a 2x win paid)', async () => {
      const w = world();
      const { s, tableId, t } = await startSNG(w);
      t.seats[0].chipCount = 1400;                               // ahead after busting one bot
      await s.handlers.leaveTable();
      await flush();
      jest.advanceTimersByTime(6000);
      await flush();
      expect(w.credits).toEqual([]);
      expect(w.db.payouts.size).toBe(0);
      expect(w.audits.map((a) => a.action)).toContain('SPINGO_FORFEIT');
      expect(w.tables.has(tableId)).toBe(false);
    });

    it("a FORCED removal ('kept': suspension / admin) refunds the entry fee once — never the stack", async () => {
      const w = world();
      const { s, tableId, t } = await startSNG(w);
      t.seats[0].chipCount = 1400;
      w.m.handlePlayerLeave(s, 'kept');
      w.m.handlePlayerLeave(s, 'kept');
      await flush();
      expect(w.db.payouts.get(`quickfee:${tableId}`)).toMatchObject({ userId: ALICE, amount: 500, kind: 'QUICK_ENTRY_REFUND' });
      expect(w.db.payouts.size).toBe(1);
      expect(w.credits).toEqual([]);
    });

    it("a Spin & Go seat's reservation is never cashed out (isTournamentReservation)", () => {
      const w = world();
      w.mkTable('sng'); (w.scope.spinGoMultipliers as Map<string, number>).set('sng', 3);
      expect(w.m.isTournamentReservation({ tableId: 'sng' })).toBe(true);
      expect(w.m.isTournamentReservation({ tableId: 'cash' })).toBe(false);
    });
  });

  describe('club challenge — a fixed-roster heads-up between its two players (CLUBS-1)', () => {
    const challengeWorld = () => {
      const w = world();
      const t = w.mkTable('chal', { minBuyIn: 2000 });
      t.maxOccupiableSeats = 2;
      (w.scope.challengeTables as Map<string, any>).set('chal', { challengeId: 4, challengerId: ALICE, challengedId: BOB });
      (w.scope.quickTables as Set<string>).add('chal');
      return { w, t };
    };

    it('not decided by who sat first; resolved on a bust (winner = the one with chips); stacks cashed out once', async () => {
      const { w, t } = challengeWorld();
      (w.m as any).quickGames.set('chal', { format: 'challenge', ownerUserId: null, ownerName: 'Club Challenge', entryFee: 0, challengeId: 4, ended: false, settlement: 'open', createdAt: Date.now(), started: false });
      t.on('handResult', () => w.m.quickGameEndCheck('chal', 'hand_result'));
      const a = w.mkSocket('SA', ALICE, 'Alice');
      await a.handlers.joinTable({ tableId: 'chal', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
      expect(w.m.quickGameEndCheck('chal', 'sweep')).toBe(false);   // alone — waiting for Bob
      const b = w.mkSocket('SB', BOB, 'Bob');
      w.scope.clientIp = '198.51.100.7';
      await b.handlers.joinTable({ tableId: 'chal', playerName: 'Bob', seatIndex: -1, buyIn: 2000 });
      finishHand(t, { 0: 4000, 1: 0 });
      jest.advanceTimersByTime(1000);
      expect(w.challengesResolved).toEqual([[4, ALICE]]);
      jest.advanceTimersByTime(5000);
      await flush();
      expect(w.credits).toEqual([{ uid: ALICE, amount: 4000 }]);
    });

    it('nobody shows up in time → void (no winner); the one who sat gets his buy-in back', async () => {
      const { w } = challengeWorld();
      (w.m as any).quickGames.set('chal', { format: 'challenge', ownerUserId: null, ownerName: 'Club Challenge', entryFee: 0, challengeId: 4, ended: false, settlement: 'open', createdAt: Date.now(), started: false });
      const a = w.mkSocket('SA', ALICE, 'Alice');
      await a.handlers.joinTable({ tableId: 'chal', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
      jest.advanceTimersByTime(3 * 60_000 + 1);
      w.m.sweepQuickTables();
      jest.advanceTimersByTime(6000);
      await flush();
      expect(w.challengesResolved).toEqual([[4, null]]);
      expect(w.credits).toEqual([{ uid: ALICE, amount: 2000 }]);
    });

    it('F102 (2026-10-21) — a started challenge resting at a hand end with no deal scheduled (both sat out, one came back) is dealt again by the sweep', () => {
      const { w, t } = challengeWorld();
      (w.m as any).quickGames.set('chal', { format: 'challenge', ownerUserId: null, ownerName: 'Club Challenge', entryFee: 0, challengeId: 4, ended: false, settlement: 'open', createdAt: Date.now(), started: true });
      t.sitDown(0, 'Alice', 2000, 'user_101', false);
      t.sitDown(1, 'Bob', 2000, 'user_102', false);
      expect(t.startNewHand()).toBe(true);
      finishHand(t, { 0: 1500, 1: 2500 });                                  // undecided: both have chips
      const kicks: string[] = [];
      w.scope.scheduleAutoStart = (id: string) => kicks.push(id);
      w.m.sweepQuickTables();
      expect(kicks).toEqual(['chal']);                                      // pre-F102: nothing — the challenge sat there
      (w.scope.pendingAutoStartTimers as Map<string, any>).set('chal', 1);  // a deal already scheduled: left alone
      w.m.sweepQuickTables();
      expect(kicks).toEqual(['chal']);
    });

    // F102 fix-up (review) — a Sit Out tapped while ALONE at the challenge, and
    // a challenge that never dealt. The REAL syncSitOutToTable replaces the stub.
    const withRealSitOutSync = (w: ReturnType<typeof world>) => {
      const { exports: sync } = load(fnSrc('function syncSitOutToTable('), {
        tableManager: w.scope.tableManager, sitOutTracker: w.scope.sitOutTracker, challengeTables: w.scope.challengeTables,
        isTournamentTable: () => false,
      }, 'syncSitOutToTable');
      w.scope.syncSitOutToTable = sync;
      return sync as (id: string) => void;
    };
    const sitOutAt = (w: ReturnType<typeof world>, seats: number[]) => {   // the 'sitOut' handler's tracker write + sync
      (w.scope.sitOutTracker as Map<string, Set<number>>).set('chal', new Set(seats));
      (w.scope.syncSitOutToTable as (id: string) => void)('chal');
    };

    it("F102 fix-up — Alice sits out while ALONE (before Bob sits): Bob's join deals the first hand, and she is dealt in", async () => {
      const { w, t } = challengeWorld();
      withRealSitOutSync(w);
      // joinTable's inline deal is the REAL dealAfterJoin (F50) here, not the harness stub.
      w.scope.dealAfterJoin = load(fnSrc('function dealAfterJoin('), {
        GamePhase, pendingAutoStartTimers: w.scope.pendingAutoStartTimers, activateBombPotIfPending() {}, scheduleAutoStart() {},
      }, 'dealAfterJoin').exports;
      (w.m as any).quickGames.set('chal', { format: 'challenge', ownerUserId: null, ownerName: 'Club Challenge', entryFee: 0, challengeId: 4, ended: false, settlement: 'open', createdAt: Date.now(), started: false });
      const a = w.mkSocket('SA', ALICE, 'Alice');
      await a.handlers.joinTable({ tableId: 'chal', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
      const seatA = w.playerSessions.get('SA').seatIndex as number;
      sitOutAt(w, [seatA]);                                                 // inside CHALLENGE_JOIN_GRACE_MS, Bob not there yet
      const b = w.mkSocket('SB', BOB, 'Bob');
      w.scope.clientIp = '198.51.100.7';
      await b.handlers.joinTable({ tableId: 'chal', playerName: 'Bob', seatIndex: -1, buyIn: 2000 });
      expect(t.isHandInProgress()).toBe(true);                              // pre-fix-up: WaitingForPlayers for good
      expect(t.seats[seatA].holeCards).toHaveLength(2);
      expect(t.seats[seatA].folded).toBe(false);                            // dealt in (acted for while away), not pre-folded
    });

    it('F102 fix-up — a started challenge that never dealt (both sat out first) is dealt by the sweep once one comes back; while both sit out nothing is dealt', () => {
      const { w, t } = challengeWorld();
      withRealSitOutSync(w);
      const dealt: string[] = [];
      w.scope.broadcastGameState = (id: string) => dealt.push(id);
      (w.m as any).quickGames.set('chal', { format: 'challenge', ownerUserId: null, ownerName: 'Club Challenge', entryFee: 0, challengeId: 4, ended: false, settlement: 'open', createdAt: Date.now(), started: false });
      t.sitDown(0, 'Alice', 2000, 'user_101', false);
      t.sitDown(1, 'Bob', 2000, 'user_102', false);
      sitOutAt(w, [0, 1]);                                                  // both away before the first deal
      w.m.sweepQuickTables();
      expect(w.m.quickGames.get('chal').started).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.WaitingForPlayers);            // no endless blind swap
      expect(dealt).toEqual([]);
      sitOutAt(w, [0]);                                                     // Bob comes back: that path deals nothing itself
      expect(t.currentPhase).toBe(GamePhase.WaitingForPlayers);
      (w.scope.pendingAutoStartTimers as Map<string, any>).set('chal', 1);  // a deal already scheduled: left alone
      w.m.sweepQuickTables();
      expect(t.currentPhase).toBe(GamePhase.WaitingForPlayers);
      (w.scope.pendingAutoStartTimers as Map<string, any>).delete('chal');
      w.m.sweepQuickTables();
      expect(t.isHandInProgress()).toBe(true);                              // pre-fix-up: the sweep re-kicked HandComplete only
      expect(t.seats[0].holeCards).toHaveLength(2);                         // Alice (still away) is dealt in and blinded
      expect(dealt).toEqual(['chal']);
    });

    it('F102 fix-up — the sweep re-applies the deal-in rule first: a sit-out set left on the engine by an older sync does not block the deal', () => {
      const { w, t } = challengeWorld();
      withRealSitOutSync(w);
      (w.m as any).quickGames.set('chal', { format: 'challenge', ownerUserId: null, ownerName: 'Club Challenge', entryFee: 0, challengeId: 4, ended: false, settlement: 'open', createdAt: Date.now(), started: true });
      t.sitDown(0, 'Alice', 2000, 'user_101', false);
      t.sitDown(1, 'Bob', 2000, 'user_102', false);
      (w.scope.sitOutTracker as Map<string, Set<number>>).set('chal', new Set([0]));
      t.setSittingOutSeats([0]);                                            // what the pre-fix-up sync left (Alice alone)
      expect(t.startNewHand()).toBe(false);
      w.m.sweepQuickTables();
      expect(t.isHandInProgress()).toBe(true);
    });
  });

  it('quickGameOutcome (pure)', () => {
    const seat = (i: number, chips: number, ai: boolean, state = 'occupied') => ({ seatIndex: i, chipCount: chips, isAI: ai, state });
    expect(quickGameOutcome('headsUp', [seat(0, 1000, false), seat(1, 1000, true)])).toEqual({ over: false });
    expect(quickGameOutcome('headsUp', [seat(0, 2000, false), seat(1, 0, true)])).toMatchObject({ over: true, winnerSeat: 0, humanWon: true });
    expect(quickGameOutcome('allInOrFold', [seat(0, 0, false), seat(1, 900, true), seat(2, 100, true)])).toMatchObject({ over: true, humanWon: false, reason: 'humans_busted' });
    expect(quickGameOutcome('spinGo', [seat(0, 0, false, 'empty'), seat(1, 900, true), seat(2, 600, true)])).toMatchObject({ over: true, humanWon: false });
    expect(quickGameOutcome('challenge', [seat(0, 4000, false), seat(1, 0, false)])).toMatchObject({ over: true, winnerSeat: 0, humanWon: true });
    expect(quickGameOutcome('challenge', [seat(0, 4000, false), seat(1, 0, false, 'empty')])).toMatchObject({ over: true, winnerSeat: 0 });
    expect(spinGoMultiplierFor(0.5)).toBe(25);
    expect(spinGoMultiplierFor(4.9)).toBe(10);
    expect(spinGoMultiplierFor(14)).toBe(5);
    expect(spinGoMultiplierFor(39)).toBe(3);
    expect(spinGoMultiplierFor(99)).toBe(2);
  });
});

describe('TOURNEY-11 — a finished tournament table is removed after the result', () => {
  it('its sessions / spectators / reservations end, nothing is credited, and it stays a tournament table to chip decisions for its window', () => {
    const w = world();
    const t = w.mkTable('ft');
    t.sitDown(0, 'Alice', 9000, 'user-101', false, true);
    (w.scope.tournamentTables as Map<string, string>).set('ft', 'T9');
    const s = w.mkSocket('S1');
    w.playerSessions.set('S1', { socketId: 'S1', tableId: 'ft', seatIndex: 0, playerName: 'Alice', playerId: 'user-101' });
    (w.scope.reservedSeats as Map<number, any>).set(BOB, { tableId: 'ft', seatIndex: 3, cleanupTimer: setTimeout(() => {}, 1e9) });
    w.m.retireFinishedTournamentTable('ft', 'T9');
    expect(w.tables.has('ft')).toBe(false);
    expect(w.playerSessions.has('S1')).toBe(false);
    expect((w.scope.reservedSeats as Map<number, any>).has(BOB)).toBe(false);
    expect(w.credits).toEqual([]);
    expect(w.m.isTournamentTable('ft')).toBe(true);
    expect(w.roomEmits).toContainEqual(['table:ft', 'tableClosed', { tableId: 'ft', reason: 'tournament_finished', tournamentId: 'T9' }]);
    void s;
  });

  it('never a table of a RUNNING tournament, never another tournament\'s table', () => {
    const w = world();
    const tm = w.scope.tournamentManager as TournamentManager;
    const tid = tm.createTournament({ name: 'Live', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 60 }] });
    tm.registerPlayer(tid, 'a', 'A', 's1'); tm.registerPlayer(tid, 'b', 'B', 's2'); tm.startTournament(tid);
    w.mkTable('lt'); (w.scope.tournamentTables as Map<string, string>).set('lt', tid);
    w.m.retireFinishedTournamentTable('lt', tid);
    expect(w.tables.has('lt')).toBe(true);
    w.m.retireFinishedTournamentTable('lt', 'other');
    expect(w.tables.has('lt')).toBe(true);
  });

  it('wiring: both tournamentFinished handlers schedule the retirement', () => {
    expect(SRC.split('scheduleFinishedTournamentTablesRetirement(tournamentId,').length - 1).toBe(2);
  });
});

describe('wiring — every quick format registers its end; the challenge table is fixed-roster from its creation', () => {
  it('quickHeadsUp / quickSpinGo / quickAllInOrFold / startCareerGame register the quick game', () => {
    expect(H.quickHeadsUp).toContain("format: 'headsUp'");
    expect(H.quickSpinGo).toContain("format: 'spinGo'");
    expect(H.quickAllInOrFold).toContain("format: 'allInOrFold'");
    expect(H.startCareerGame).toContain("format: 'career'");
    // the old per-mode listeners (a Spin & Go that zeroed the stack before crediting) are gone
    expect(H.quickSpinGo).not.toContain('winner.chipCount = 0');
  });
  it('acceptClubChallenge: quickTables + seats 0-1 + the challenge registration, all BEFORE its first await', () => {
    const body = handlerSrc('acceptClubChallenge', '\n  });\n');
    const reg = body.indexOf("registerQuickGame(tableId, t, { format: 'challenge'");
    expect(body.indexOf('quickTables.add(tableId);')).toBeGreaterThan(-1);
    expect(body).toContain('t.maxOccupiableSeats = Math.min(t.maxOccupiableSeats, 2);');
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(body.indexOf('await setChallengeTable(challengeId, tableId);'));
  });
  it('joinTable never fills bots at a fixed-roster table; a challenge buy-in is exactly the stakes', () => {
    expect(H.joinTable).toContain('if (!isFixedRosterTable(tableId)) fillWithAI(table, tableId);');
    expect(H.joinTable).toContain('if (challengeTables.has(tableId)) buyIn = table.config.minBuyIn;');
  });
  it("autoStartNextHand's AI reload skips fixed-roster tables (the predicate S2's loop calls)", () => {
    // R2 merge: S2's capped bot step, with the one fixed-roster predicate.
    expect(AUTOSTART).toContain('reloadAndCapBotStacks(table, tableId, isFixedRosterQuickTable(tableId));');
    expect(BOT_STACKS).toContain('function isFixedRosterQuickTable(tableId: string): boolean {\n  return isFixedRosterTable(tableId);\n}');
  });
});

// ════════════════════════════ gameplay audit 2026-10-21 — S9 (F105 / F108 / F109) ══
describe('S9 — quick-game results and the career entry', () => {
  const startHU = async (w: ReturnType<typeof world>) => {
    const s = w.mkSocket('S1');
    await s.handlers.quickHeadsUp({ playerName: 'Alice' });
    const tableId = w.playerSessions.get('S1').tableId;
    return { s, tableId, t: w.tables.get(tableId)! };
  };

  it("F105 — Heads-Up Snap's clock decides FOR THE BOT: the result names the bot and its stack (it said \"Nobody wins with 0 chips!\")", async () => {
    const w = world();
    const { tableId, t } = await startHU(w);
    const bot = t.seats[1].playerName;
    jest.advanceTimersByTime(5 * 60_000);
    finishHand(t, { 0: 975, 1: 1025 });
    expect(w.m.quickGames.get(tableId).decided).toEqual({ winnerSeat: 1, humanWon: false, winnerName: bot, winnerChips: 1025 });
    expect(t.seats[1].state).toBe('empty');                              // stood up at the decision, before the result
    jest.advanceTimersByTime(6000);
    await flush();
    expect(w.roomEmits.find(([, ev]) => ev === 'quickGameOver')![2]).toEqual({
      type: 'headsUp', tableId, winner: bot, chips: 1025, won: false, message: `Time's up! ${bot} wins with 1,025 chips!`,
    });
    expect(w.credits).toEqual([{ uid: ALICE, amount: 975 }]);           // settlement unchanged
  });

  it('F105 — a heads-up bust loss names the bot (it fell back to "The house"); a human win is unchanged', async () => {
    const w = world();
    const { t } = await startHU(w);
    const bot = t.seats[1].playerName;
    finishHand(t, { 0: 0, 1: 2000 });
    jest.advanceTimersByTime(1000);
    expect(w.roomEmits.find(([, ev]) => ev === 'quickGameOver')![2]).toMatchObject({ won: false, winner: bot, chips: 2000, message: `${bot} wins — better luck next time.` });
  });

  it('F108 — the career result goes to the socket holding the seat NOW (a restore re-bound it), with tableId — never to the dead starting socket', async () => {
    const w = world();
    const s1 = w.mkSocket('S1');
    await s1.handlers.startCareerGame({ venue: 0, stage: 0 });
    const tableId = w.playerSessions.get('S1').tableId;
    const t = w.tables.get(tableId)!;
    // A page reload: S1 is gone, the sign-in restores his seat on S2 (oauthLogin (b) / resumeSession).
    const session = w.playerSessions.get('S1');
    s1.connected = false;
    w.playerSessions.delete('S1');
    w.authSessions.delete('S1');
    const s2 = w.mkSocket('S2');
    w.playerSessions.set('S2', { ...session, socketId: 'S2' });
    finishHand(t, { 0: 4000, 1: 0, 2: 0, 3: 0 });
    jest.advanceTimersByTime(1000);
    const career = w.emitted.filter(([, ev]) => ev === 'careerGameComplete');
    expect(career).toEqual([['S2', 'careerGameComplete', { venue: 0, stage: 0, won: true, stars: 3, tableId }]]);   // pre-F108: [['S1', …]] only
    expect(s2.connected).toBe(true);
  });

  it('F109 — a non-integer venue / a stage outside 0..2 is refused BEFORE his current seat is left (no leave, no cash-out)', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    await s.handlers.startCareerGame({ venue: 0, stage: 0 });
    const tableId = w.playerSessions.get('S1').tableId;
    for (const bad of [{ venue: 1.5, stage: 0 }, { venue: 0, stage: 9 }, { venue: 0, stage: 0.5 }, { venue: 6, stage: 0 }, { venue: '1', stage: 0 }]) {
      await s.handlers.startCareerGame(bad);
    }
    expect(w.errorsOf('S1').map((e) => e.message)).toEqual(Array(5).fill('Invalid venue'));
    expect(w.playerSessions.get('S1')?.tableId).toBe(tableId);          // pre-F109: venue 1.5 left this table, then threw
    expect(w.credits).toEqual([]);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);         // only the first (valid) start paid
  });

  it("F109 — the venue's LEVEL unlock is the server's too: a level-1 account cannot start the WSOP; level 50 can", async () => {
    const w = world();
    const s = w.mkSocket('S1');
    let level: { hydrated: boolean; level: number } | undefined = { hydrated: true, level: 1 };
    w.scope.progressionManager = { getOrCreateProgress() {}, getClientProgress: () => null, userRecord: () => level };
    await s.handlers.startCareerGame({ venue: 5, stage: 2 });
    expect(w.errorsOf('S1')).toEqual([{ message: 'WSOP Main Event unlocks at level 50.', code: 'career_venue_locked', venue: 5, level: 50 }]);
    expect(w.deductions).toEqual([]);
    expect(w.playerSessions.has('S1')).toBe(false);
    level = { hydrated: true, level: 50 };
    await s.handlers.startCareerGame({ venue: 5, stage: 2 });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 500_000 }]);
  });

  // F109 fix-up (review) — the gate used to be skipped whenever the record was
  // not hydrated yet: a level-1 account could start a locked venue right after
  // sign-in (oauthLogin hydrates fire-and-forget), or for a whole session when
  // the hydrate read failed.
  it('F109 fix-up — the level comes from the HYDRATED record: a record still loading is loaded first (its real level decides); one that cannot load is refused progress_loading, never let through', async () => {
    const w = world();
    // The account's record as index.ts keeps it: un-hydrated right after sign-in, filled by the load ensureHydrated awaits.
    const rec = { hydrated: false, level: 1 };
    let dbLevel = 1;
    let loadOk = true;
    const loads: number[] = [];
    w.scope.progressionManager = { getOrCreateProgress() {}, getClientProgress: () => null, userRecord: () => rec };
    w.scope.ensureHydrated = async (sock: any) => {
      const a = w.authSessions.get(sock.id);
      if (!a) return null;
      loads.push(a.userId);
      if (!rec.hydrated && loadOk) { rec.hydrated = true; rec.level = dbLevel; }
      return { userId: a.userId, playerId: `user-${a.userId}`, username: a.username, hydrated: rec.hydrated };
    };
    const s = w.mkSocket('S1');
    await s.handlers.startCareerGame({ venue: 0, stage: 0 });              // a level-1 venue: no level read at all
    expect(loads).toEqual([]);
    const homeTable = w.playerSessions.get('S1').tableId;
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);

    // 1) A level-1 account right after sign-in (record still loading): the load lands first, then he is refused.
    await s.handlers.startCareerGame({ venue: 5, stage: 2 });
    expect(w.errorsOf('S1')).toEqual([{ message: 'WSOP Main Event unlocks at level 50.', code: 'career_venue_locked', venue: 5, level: 50 }]);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);          // pre-fix-up: + 500,000 — the WSOP boss stage was his
    expect(w.playerSessions.get('S1')?.tableId).toBe(homeTable);           // his seat was never left

    // 2) The read FAILS (hydrated stays false): refused progress_loading — no leave, no deduct.
    rec.hydrated = false;
    loadOk = false;
    await s.handlers.startCareerGame({ venue: 5, stage: 2 });
    expect(w.errorsOf('S1')[1]).toEqual({ message: 'Your progress is still loading — try again in a moment.', code: 'progress_loading' });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.playerSessions.get('S1')?.tableId).toBe(homeTable);

    // 3) A real level-50 player right after sign-in: the load gives his REAL level — never refused wrongly.
    loadOk = true;
    dbLevel = 50;
    await s.handlers.startCareerGame({ venue: 5, stage: 2 });
    expect(w.errorsOf('S1')).toHaveLength(2);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }, { uid: ALICE, amount: 500_000 }]);
    expect(loads).toEqual([ALICE, ALICE, ALICE]);
  });
});

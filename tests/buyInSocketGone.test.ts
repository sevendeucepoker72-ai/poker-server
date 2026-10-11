/**
 * 2026-10-10 (F3) — a BUY-IN that outlives its socket.
 *
 * Every seat-buying handler awaits (the play gate, the ban check, the balance
 * read, the deduct). If the socket drops meanwhile, the `disconnect` handler
 * has ALREADY run — there was no seat yet to reserve — and never runs again.
 * Before F3 the handler went on: it seated the player on the dead socket (no
 * reservation, no cash-out timer) and the wallet chips the deduct had just
 * taken were never cashed out. Now every buy-in path checks the socket after
 * each await (buyInSocketGone) and, once the deduct has succeeded, refunds the
 * buy-in through the additive path exactly once and seats nothing.
 *
 * Every handler below is the REAL source text of src/index.ts (sliced and
 * transpiled; index.ts boots a server on import) against the REAL PokerTable
 * and TournamentManager, with an in-memory wallet.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { SRC, slice, fnSrc, handlerSrc, load, flush, deferred } from './helpers/indexSource';
// R1 contract #3 (2026-10-11): the seat paths name the seat from the ACCOUNT and allowlist the avatar.
import { accountDisplayName } from '../src/auth/displayName';
import { sanitizeSeatAvatar } from '../src/seatProfile';
// R2 (C3, 2026-10-11): qualifier windows / list item / structure (registerQualifierTournament reads the registry by master id).
import { qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, QUALIFIER_BASE_STACK } from '../src/game/qualifierSchedule';

const ALICE = 101;
const BOB = 102;
const START_WALLET = 100_000;

const H = {
  joinTable: handlerSrc('joinTable', '\n    })(); }\n  );'),
  quickPlay: handlerSrc('quickPlay', '\n    })(); }\n  );'),
  waitlist: handlerSrc('joinWithWaitlistContext', '\n    }\n  );'),
  rebuy: handlerSrc('rebuy', '\n  })(); });'),
  quickHeadsUp: handlerSrc('quickHeadsUp', '\n  });\n'),
  quickSpinGo: handlerSrc('quickSpinGo', '\n  });\n'),
  quickAllInOrFold: handlerSrc('quickAllInOrFold', '\n  });\n'),
  startCareerGame: handlerSrc('startCareerGame', '\n  });\n'),
  registerTournament: handlerSrc('registerTournament', '\n  });\n'),
  joinAdditionalTable: handlerSrc('joinAdditionalTable', '\n  });\n'),
  joinByInviteCode: handlerSrc('joinByInviteCode', '\n  });\n'),
  joinClubTable: handlerSrc('joinClubTable', '\n  });\n'),
  registerQualifierTournament: handlerSrc('registerQualifierTournament', '\n  });\n'),
  // P5 (2026-10-10): a broken tournament table never deals again — the socket 'startHand' refuses it.
  startHand: handlerSrc('startHand', '\n  });\n'),
};
// P3 (2026-10-10): + BuyInExpectation, buyInsOnStaleState, buyInStateChanged — through buyInSocketGone's end.
const BUY_IN_GONE = slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n');
const LOGIN_GONE = slice('const loginsOnDeadSocket = { abandoned: 0 };', '\n}\n');
const BROKEN_TABLES = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
// P5 / P4 (2026-10-10): the tournament-table refusal and the waitlist account-mismatch constants.
const CASH_JOIN_REFUSAL = slice('const TOURNAMENT_TABLE_JOIN_MESSAGE', '\n}\n');
const WAITLIST_MISMATCH = slice('const WAITLIST_ACCOUNT_MISMATCH_MESSAGE', 'const waitlistAccountMismatches = { refused: 0 };');
const SEAT_NAME = slice('function seatNameForSocket(', '\n}\n');
// R2 (C3 / TOURNEY-3 / TOURNEY-9, 2026-10-11): the registry lookup, the C3 list item, the seat-or-refund helpers and the live-seat check.
const QUALIFIER_HELPERS = [
  fnSrc('function qualifierEventFor('),
  fnSrc('function qualifierListItem('),
  slice('/** R2 (TOURNEY-9) — the answer when a qualifier seat would take over', '\n  return null;\n}\n'),
  fnSrc('function socketPlaysLiveSeatElsewhere('),
  // R2 (CLUBS-4): joinClubTable finds (or re-creates) the club table's runtime table.
  slice('const clubTablesRecreating = new Map', '\n  return job;\n}\n'),
].join('\n');
// R2 (C1, 2026-10-11): table kinds + who may sit where (joinTable / quickPlay / extra seat / waitlist refusals).
const WHO_SITS = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', "  socket.emit(channel, { message: TABLE_NOT_JOINABLE_MESSAGE, code: 'table_not_joinable', reason });\n}\n");

/** Neutralise every F3 check (the pre-F3 behaviour) — for the CONTROL tests. */
const withoutF3 = (s: string) => s.split('await buyInSocketGone(').join('await (async (..._a: any[]) => false)(');

type Gate = 'balance' | 'deduct' | 'consume' | 'me' | null;

function world(opts: { handlers?: Partial<typeof H>; tournament?: 'buyin' | 'qualifier' } = {}) {
  const wallet = new Map<number, number>([[ALICE, START_WALLET], [BOB, START_WALLET]]);
  const deductions: Array<{ uid: number; amount: number }> = [];
  const credits: Array<{ uid: number; amount: number }> = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const creditRefunds: string[] = [];
  const calls = { consume: 0 };
  const gates: Record<string, Promise<void> | null> = { balance: null, deduct: null, consume: null, me: null };
  const tables = new Map<string, PokerTable>();
  const mkTable = (id: string, minBuyIn = 1000, maxPlayers = 9) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, minBuyIn, maxBuyIn: minBuyIn * 10, maxPlayers } as any);
    (t as any).variantId = 'texas-holdem';
    tables.set(id, t);
    return t;
  };
  let created = 0;
  const cash = mkTable('cash1');
  cash.sitDown(0, 'Bob', 5000, 'p-bob', false);
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const sockets = new Map<string, any>();
  const tournamentTables = new Map<string, string>();
  const tm = new TournamentManager();
  const qualifierTournaments = new Map<string, any>();
  let tournamentId = '';
  if (opts.tournament === 'buyin') {
    tournamentId = tm.createTournament({ name: 'F3 Cup', buyIn: 500, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 600 }] } as any);
  }
  if (opts.tournament === 'qualifier') {
    tournamentId = tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 600 }] } as any);
    for (const [pid, name] of [['alice.player', 'Alice'], ['bob.player', 'Bob'], ['carl.player', 'Carl']]) tm.registerPlayer(tournamentId, pid, name, `reg-${pid}`);
    tm.startTournament(tournamentId);
    const qt1 = mkTable('q1', 50000);
    qt1.sitDown(1, 'Bob', 50000, 'bob.player', false, true);
    qt1.sitDown(2, 'Carl', 50000, 'carl.player', false, true);
    tournamentTables.set('q1', tournamentId);
    tm.setTableIds(tournamentId, ['q1']);
    tm.eliminatePlayer(tournamentId, 'alice.player');               // Alice busted: re-entry
    qualifierTournaments.set('weekly-qualifier', {
      qualifierId: 'weekly-qualifier', qualifierType: 'weekly', qualifierName: 'Weekly', startingStack: 50000, maxPlayers: 999,
      scheduledAt: new Date(Date.now() - 10 * 60_000).toISOString(), status: 'running', tournamentId,
      buyIn: 1000, requiresQualifierCredit: true, blindStructure: [],
      players: [{ playerId: 'alice.player', masterPlayerId: 'm-alice', playerName: 'Alice', phone: '', socketId: 'old', reEntries: 0 }],
    });
  }

  const scope: Record<string, unknown> = {
    tableManager: {
      getTable: (id: string) => tables.get(id),
      getTableList: () => [...tables.entries()].map(([tableId, t]) => ({
        tableId, variant: 'texas-holdem', playerCount: t.getOccupiedSeatCount(), smallBlind: t.config.smallBlind,
      })),
      createHeadsUpTable: (name: string) => { const id = `hu${++created}`; mkTable(id, 1000, 2).config.tableName = name; return id; },
      createQuickTable: (name: string, maxPlayers: number, _sb: number, _bb: number, minBuyIn: number) => {
        const id = `qt${++created}`; mkTable(id, minBuyIn, maxPlayers).config.tableName = name; return id;
      },
      getTableByInviteCode: (code: string) => (code === 'cash1' ? { tableId: 'cash1', table: tables.get('cash1') } : null),
    },
    authSessions, playerSessions, multiTableSessions, reservedSeats, tournamentTables, qualifierTournaments,
    tournamentManager: tm,
    spectators: new Map(), aiProfiles: new Map(), ipSeatedSlots: new Map(), quickTables: new Set(), quickGameTimers: new Map(),
    spinGoMultipliers: new Map(), allInOrFoldTables: new Set(), careerTables: new Map(), challengeTables: new Map(),
    MAX_SEATS: 9, clientIp: '10.0.0.1', SEAT_RESERVE_MS: 6 * 3600_000,
    io: { emit() {}, to: () => ({ emit() {} }), sockets: { sockets } },
    uuidv4: () => `u${Math.random().toString(36).slice(2, 10)}`,
    generateRandomProfile: () => ({ botName: `Bot${Math.random().toString(36).slice(2, 7)}` }),
    blockedByMaintenance: () => false, quickPlayRateLimited: () => false,
    assertPlayable: async () => null, emitPlayRefusal: (s: any, r: any) => s.emit('error', { message: r.message, code: r.code }),
    isUserBanned: async () => false,
    ensureChipsForBuyIn: async (uid: number) => { if (gates.balance) await gates.balance; return wallet.get(uid) ?? 0; },
    deductChips: async (uid: number, amount: number) => {
      if (gates.deduct) await gates.deduct;
      const have = wallet.get(uid) ?? 0;
      if (have < amount) return false;
      wallet.set(uid, have - amount);
      deductions.push({ uid, amount });
      return true;
    },
    addChipsToUser: async (uid: number, amount: number) => {
      wallet.set(uid, (wallet.get(uid) ?? 0) + amount);
      credits.push({ uid, amount });
      return true;
    },
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    Sentry: null,
    console: { log() {}, warn() {}, error() {} },
    log: { debug() {}, warn() {}, info() {} },
    // waitlist
    normalizeRequestId: (x: unknown) => (typeof x === 'string' ? x : undefined),
    failLogin: (s: any, f: any) => s.emit('loginResult', { success: false, code: f.code, ...(f.extra || {}) }),
    markTicketUsed: () => true,
    reportAuthEvent() {},
    loginTracker: { begin: () => () => {}, forget() {} },
    fetch: async (url: string) => {
      if (url.endsWith('/online-link-token/verify')) {
        return { ok: true, json: async () => ({ valid: true, payload: { userId: 'm-alice', gameId: 'g1' } }) };
      }
      if (gates.me) await gates.me;
      return { ok: true, json: async () => ({ phoneNumber: '5550101' }) };
    },
    getPool: () => ({ query: async () => ({ rows: [{ id: ALICE, username: '5550101' }] }) }),
    resumeFieldsFor: () => ({}),
    // clubs
    getClubTableById: async () => ({ clubId: 7, tableId: 'cash1' }),
    isClubMember: async () => true,
    // tournaments / qualifiers
    screenAndStartTournament: async () => {},
    isPlayerQualified: async () => true,
    consumeQualifierCreditOnMaster: async () => { calls.consume++; if (gates.consume) await gates.consume; return { consumed: true, creditId: 'credit-1' }; },
    refundQualifierCreditOnMaster: async (id: string) => { creditRefunds.push(id); return true; },
    PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED',
    accountDisplayName, sanitizeSeatAvatar,
    qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, QUALIFIER_BASE_STACK,
    // R2 (C1 / C12): Quick Play reads the wallet first (affordable tables only); an invite code opens a PRIVATE table.
    getUserChips: async (uid: number) => { if (gates.balance) await gates.balance; return wallet.get(uid) ?? 0; },
    UNLIMITED_CHIPS_TESTING: false,
    publicNameOf: (n: unknown) => String(n ?? ''),
    privateTableByInviteCode: (code: string) => (code === 'cash1' ? { tableId: 'cash1', table: tables.get('cash1') } : null),
  };

  const h = { ...H, ...(opts.handlers || {}) };
  const code = `
${BUY_IN_GONE}
${LOGIN_GONE}
${BROKEN_TABLES}
${CASH_JOIN_REFUSAL}
${WAITLIST_MISMATCH}
${SEAT_NAME}
${WHO_SITS}
${QUALIFIER_HELPERS}
function wire(socket) {
  ${Object.values(h).join('\n  ')}
}`;
  const { exports: m, stubbed } = load(code, scope, '{ wire, buyInsOnDeadSocket, buyInsOnStaleState, loginsOnDeadSocket, noteBrokenTournamentTable, cashJoinsAtTournamentTable, waitlistAccountMismatches }');

  const emitted: Array<[string, any]> = [];
  const mkSocket = (id: string, signedIn = true) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers, handshake: { address: '10.0.0.1' },
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      listeners: (ev: string) => (handlers[ev] ? [handlers[ev]] : []),
      emit: (ev: string, p: any) => { emitted.push([ev, p]); },
      join() {}, leave() {},
    };
    sockets.set(id, s);
    // R1 contract #3 (2026-10-11): a signed-in session carries the account display name the seat shows.
    if (signedIn) authSessions.set(id, { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice', displayName: 'Alice' });
    m.wire(s);
    return s;
  };
  /**
   * socket.io order: `connected=false` first, then 'disconnect' — whose
   * handler (no seat yet) tears the socket's auth session down. A socket that
   * already had a seat (rebuy) is reserved by it instead.
   */
  const drop = (s: any) => {
    s.connected = false;
    sockets.delete(s.id);
    const ps = playerSessions.get(s.id);
    if (ps) {
      reservedSeats.set(ALICE, { tableId: ps.tableId, seatIndex: ps.seatIndex, chips: tables.get(ps.tableId)!.seats[ps.seatIndex].chipCount });
      playerSessions.delete(s.id);
    }
    multiTableSessions.delete(s.id);
    authSessions.delete(s.id);
  };
  /** Every seat anywhere that holds Alice's buy-in (by name; the quick modes name the seat after the request). */
  const aliceSeats = () => {
    const out: Array<{ tableId: string; seatIndex: number; chips: number }> = [];
    for (const [tableId, t] of tables) {
      t.seats.forEach((s, i) => {
        if (s.state === 'occupied' && !s.isAI && /alice|Player-m-alic/i.test(s.playerName || '') && tableId !== 'q1') {
          out.push({ tableId, seatIndex: i, chips: s.chipCount });
        }
      });
    }
    return out;
  };
  return {
    m, stubbed, wallet, deductions, credits, audits, creditRefunds, calls, gates, tables, cash, tm, tournamentId,
    qualifierTournaments, playerSessions, multiTableSessions, authSessions, reservedSeats, emitted, mkSocket, drop, aliceSeats,
    tournamentTables, mkTable,
  };
}

interface PathSpec {
  event: keyof typeof H;
  payload: any;
  amount: number;
  refundAction: string;
  /** Extra set-up on the world before the request (e.g. a seated session for rebuy). */
  setup?: (w: ReturnType<typeof world>, s: any) => void;
  tournament?: 'buyin' | 'qualifier';
  /** What "not seated / not registered" means for this path. */
  notSeated: (w: ReturnType<typeof world>, sid: string) => void;
}

const notSeatedAnywhere = (w: ReturnType<typeof world>, sid: string) => {
  expect(w.playerSessions.has(sid)).toBe(false);
  expect(w.multiTableSessions.has(sid)).toBe(false);
  expect(w.aliceSeats()).toEqual([]);
};

const PATHS: PathSpec[] = [
  { event: 'joinTable', payload: { tableId: 'cash1', playerName: 'Alice', seatIndex: 3, buyIn: 2000 }, amount: 2000, refundAction: 'BUY_IN_REFUND', notSeated: notSeatedAnywhere },
  { event: 'joinClubTable', payload: { clubTableId: 1, playerName: 'Alice', seatIndex: 3, buyIn: 2000 }, amount: 2000, refundAction: 'BUY_IN_REFUND', notSeated: notSeatedAnywhere },
  { event: 'quickPlay', payload: { playerName: 'Alice' }, amount: 1000, refundAction: 'QUICKPLAY_REFUND', notSeated: notSeatedAnywhere },
  { event: 'joinByInviteCode', payload: { inviteCode: 'cash1', playerName: 'Alice', buyIn: 3000 }, amount: 3000, refundAction: 'INVITE_REFUND', notSeated: notSeatedAnywhere },
  { event: 'joinAdditionalTable', payload: { tableId: 'cash1', playerName: 'Alice', buyIn: 1500 }, amount: 1500, refundAction: 'ADDITIONAL_TABLE_BUYIN_REFUND', notSeated: notSeatedAnywhere },
  { event: 'quickHeadsUp', payload: { playerName: 'Alice' }, amount: 1000, refundAction: 'QUICK_BUYIN_REFUND', notSeated: notSeatedAnywhere },
  { event: 'quickSpinGo', payload: { playerName: 'Alice' }, amount: 500, refundAction: 'QUICK_BUYIN_REFUND', notSeated: notSeatedAnywhere },
  { event: 'quickAllInOrFold', payload: { playerName: 'Alice' }, amount: 1000, refundAction: 'QUICK_BUYIN_REFUND', notSeated: notSeatedAnywhere },
  {
    event: 'startCareerGame', payload: { venue: 1, stage: 0 }, amount: 5000, refundAction: 'QUICK_BUYIN_REFUND',
    // Career names the seat after the existing session (none here: 'Player').
    notSeated: (w, sid) => {
      expect(w.playerSessions.has(sid)).toBe(false);
      for (const [id, t] of w.tables) if (id.startsWith('qt')) expect(t.seats.some((s) => s.state === 'occupied' && !s.isAI)).toBe(false);
    },
  },
  {
    event: 'waitlist' as any, payload: { token: 'tkt', context: {} }, amount: 1000, refundAction: 'BUY_IN_REFUND',
    notSeated: (w, sid) => {
      expect(w.playerSessions.has(sid)).toBe(false);
      expect(w.cash.seats.filter((s) => s.state === 'occupied' && !s.isAI).map((s) => s.playerName)).toEqual(['Bob']);
    },
  },
  {
    event: 'rebuy', payload: { amount: 8000 }, amount: 6000, refundAction: 'REBUY_REFUND',
    setup: (w, s) => {
      expect(w.cash.sitDown(4, 'Alice', 2000, 'p-alice', false)).toBe(true);
      w.playerSessions.set(s.id, { socketId: s.id, tableId: 'cash1', seatIndex: 4, playerName: 'Alice', playerId: 'p-alice', sittingOut: false });
    },
    // The seat is the disconnect's reservation now: its stack is NOT topped up.
    notSeated: (w) => { expect(w.cash.seats[4]).toMatchObject({ state: 'occupied', chipCount: 2000 }); },
  },
  {
    event: 'registerTournament', tournament: 'buyin', payload: { tournamentId: '', playerName: 'Alice' }, amount: 500, refundAction: 'TOURNAMENT_ENTRY_REFUND',
    notSeated: (w) => {
      const t = w.tm.getTournament(w.tournamentId)!;
      expect(t.players).toEqual([]);                    // not registered
      expect(t.collectedEntryFees).toBe(0);             // the pool stays in lockstep with real chips
    },
  },
];

/** The socket's handler name (the waitlist deep link is registered as joinWithWaitlistContext). */
const evName = (p: PathSpec) => ((p.event as string) === 'waitlist' ? 'joinWithWaitlistContext' : p.event);

async function run(w: ReturnType<typeof world>, p: PathSpec, s: any) {
  const payload = p.event === 'registerTournament' ? { ...p.payload, tournamentId: w.tournamentId } : p.payload;
  // Not awaited: the handler may be parked on a gate the test resolves after this returns.
  void s.handlers[evName(p)](payload);
  await flush();
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('F3 — a buy-in whose socket drops during the deduct is refunded EXACTLY ONCE and seats nothing', () => {
  it.each(PATHS.map((p) => [evName(p), p] as const))('%s', async (_name, p) => {
    const w = world({ tournament: p.tournament });
    const s = w.mkSocket('S1');
    p.setup?.(w, s);
    const gate = deferred();
    w.gates.deduct = gate.p;
    await run(w, p, s);
    w.drop(s);                                         // dropped while the deduct awaits
    gate.resolve();
    await flush();
    jest.advanceTimersByTime(10_000);                  // e.g. Spin & Go's delayed deal: nothing to deal
    await flush();

    expect(w.deductions).toEqual([{ uid: ALICE, amount: p.amount }]);
    expect(w.credits).toEqual([{ uid: ALICE, amount: p.amount }]);   // refunded exactly once
    expect(w.wallet.get(ALICE)).toBe(START_WALLET);
    p.notSeated(w, 'S1');
    expect(w.m.buyInsOnDeadSocket).toEqual({ abandoned: 1, refunded: 1, refundFailed: 0 });
    const refund = w.audits.filter((a) => a.action === p.refundAction);
    expect(refund).toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'socket_gone', amount: p.amount, via: expect.any(String) }) })]);
    // The safety net must not have been the inert stub.
    expect([...w.stubbed].filter((n) => /buyInSocketGone|addChipsToUser|deductChips|ensureChipsForBuyIn/.test(n))).toEqual([]);
  });
});

describe('F3 — a socket that drops during the BALANCE READ is stopped before anything is deducted', () => {
  it.each(PATHS.map((p) => [evName(p), p] as const))('%s', async (_name, p) => {
    const w = world({ tournament: p.tournament });
    const s = w.mkSocket('S1');
    p.setup?.(w, s);
    const gate = deferred();
    w.gates.balance = gate.p;
    await run(w, p, s);
    w.drop(s);
    gate.resolve();
    await flush();
    expect(w.deductions).toEqual([]);
    expect(w.credits).toEqual([]);
    expect(w.wallet.get(ALICE)).toBe(START_WALLET);
    p.notSeated(w, 'S1');
    expect(w.m.buyInsOnDeadSocket).toEqual({ abandoned: 1, refunded: 0, refundFailed: 0 });
  });
});

describe('F3 — a LIVE socket is unaffected: one deduct, no refund, seated/registered as before', () => {
  it.each(PATHS.filter((p) => p.event !== 'rebuy').map((p) => [evName(p), p] as const))('%s', async (_name, p) => {
    const w = world({ tournament: p.tournament });
    const s = w.mkSocket('S1');
    p.setup?.(w, s);
    await run(w, p, s);
    jest.advanceTimersByTime(4000);
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: p.amount }]);
    expect(w.credits).toEqual([]);
    expect(w.m.buyInsOnDeadSocket).toEqual({ abandoned: 0, refunded: 0, refundFailed: 0 });
    if (p.event === 'registerTournament') {
      expect(w.tm.getTournament(w.tournamentId)!.players.map((x) => x.userId)).toEqual([ALICE]);
    } else if (p.event === 'joinAdditionalTable') {
      expect(w.multiTableSessions.get('S1')).toEqual([expect.objectContaining({ tableId: 'cash1' })]);
    } else {
      expect(w.playerSessions.get('S1')).toBeTruthy();
    }
  });

  it('rebuy: the top-up lands on the live seat once', async () => {
    const p = PATHS.find((x) => x.event === 'rebuy')!;
    const w = world();
    const s = w.mkSocket('S1');
    p.setup!(w, s);
    await run(w, p, s);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 6000 }]);
    expect(w.credits).toEqual([]);
    expect(w.cash.seats[4].chipCount).toBe(8000);
  });
});

describe('F3 — qualifier RE-ENTRY (chip buy-in + a qualifier credit)', () => {
  const p = (): any => ({ qualifierId: 'weekly-qualifier', playerName: 'Alice', phone: '' });

  it('dropped during the credit consume: chips refunded ONCE, the credit refunded, NOT re-seated, still eliminated', async () => {
    const w = world({ tournament: 'qualifier' });
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.consume = gate.p;
    s.handlers.registerQualifierTournament(p());
    await flush();
    w.drop(s);
    gate.resolve();
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['QUALIFIER_REENTRY_BUYIN_REFUND', 'QUALIFIER_REENTRY_CREDIT_REFUND']));
    expect(w.tables.get('q1')!.seats.filter((x) => x.state === 'occupied').map((x) => x.playerId)).toEqual(['bob.player', 'carl.player']);
    expect(w.tm.getTournament(w.tournamentId)!.players.find((x) => x.playerId === 'alice.player')!.eliminated).toBe(true);
    expect(w.emitted.filter(([ev, r]) => ev === 'qualifierRegistrationResult' && r.success)).toEqual([]);
  });

  it('dropped during the deduct: chips refunded once, NO credit consumed, not re-seated', async () => {
    const w = world({ tournament: 'qualifier' });
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.deduct = gate.p;
    s.handlers.registerQualifierTournament(p());
    await flush();
    w.drop(s);
    gate.resolve();
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.audits.filter((a) => a.action === 'QUALIFIER_REENTRY_CREDIT_CONSUME')).toEqual([]);
    expect(w.calls.consume).toBe(0);
    expect(w.tables.get('q1')!.seats.filter((x) => x.state === 'occupied')).toHaveLength(2);
  });

  it('live socket: re-seated with one deduct + one credit, nothing refunded', async () => {
    const w = world({ tournament: 'qualifier' });
    const s = w.mkSocket('S1');
    s.handlers.registerQualifierTournament(p());
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.credits).toEqual([]);
    expect(w.creditRefunds).toEqual([]);
    expect(w.tables.get('q1')!.seats.filter((x) => x.state === 'occupied').map((x) => x.playerId).sort())
      .toEqual(['alice.player', 'bob.player', 'carl.player']);
  });
});

describe('F3 — waitlist deep link: a socket that drops during the auth bootstrap leaves no session on the dead socket and deducts nothing', () => {
  it('bootstrap /me in flight → dropped → no session, no deduct, no seat', async () => {
    const w = world();
    const s = w.mkSocket('S1', false);                 // the deep link arrives on a not-signed-in socket
    const gate = deferred();
    w.gates.me = gate.p;
    s.handlers.joinWithWaitlistContext({ token: 'tkt', context: {} });
    await flush();
    w.drop(s);
    gate.resolve();
    await flush();
    expect(w.authSessions.has('S1')).toBe(false);      // the bootstrap's session was not left behind
    expect(w.m.loginsOnDeadSocket.abandoned).toBe(1);
    expect(w.deductions).toEqual([]);
    expect(w.playerSessions.has('S1')).toBe(false);
  });
});

describe('F3 — CONTROL: without the checks the dead socket is SEATED and the buy-in is never refunded (the pre-F3 bug)', () => {
  it.each(['joinTable', 'quickPlay', 'joinAdditionalTable'] as const)('%s', async (event) => {
    const p = PATHS.find((x) => x.event === event)!;
    const w = world({ handlers: { [event]: withoutF3(H[event]) } as any });
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.deduct = gate.p;
    await run(w, p, s);
    w.drop(s);
    gate.resolve();
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: p.amount }]);
    expect(w.credits).toEqual([]);                     // never refunded…
    expect(w.aliceSeats()).toHaveLength(1);            // …and seated on a socket that no longer exists
  });
});

describe('F3 — wiring', () => {
  it('every buy-in path checks the socket after its deduct, before it seats / registers / tops up', () => {
    const after = (body: string, needle: string, check: string) => {
      const at = body.indexOf(needle);
      expect({ needle, found: at > -1 }).toEqual({ needle, found: true });
      const next = body.indexOf('await ', at + needle.length);
      const checkAt = body.indexOf(check, at);
      expect({ needle, checkedBeforeNextAwait: checkAt > at && (next < 0 || checkAt <= next) }).toEqual({ needle, checkedBeforeNextAwait: true });
    };
    for (const [event, body] of Object.entries(H)) {
      if (event === 'joinClubTable') continue;           // re-dispatches into joinTable
      if (!body.includes('deductChips(')) continue;
      after(body, 'deductChips(', 'await buyInSocketGone(socket,');
      after(body, 'ensureChipsForBuyIn(', 'await buyInSocketGone(socket,');
    }
    expect(H.registerQualifierTournament).toContain("await buyInSocketGone(socket, 'registerQualifierTournament_reentry', 'credit_consume'");
    expect(H.waitlist).toContain("loginSocketGone(socket, 'joinWithWaitlistContext', 'auth_bootstrap'");
    // The health counter is exposed.
    expect(SRC).toContain('buyInsAbandonedSocketGone: { ...buyInsOnDeadSocket },');
  });
});

/* ───────────────────────── 2026-10-10 follow-up (owner: "fix all") ───────────────────────── */

describe('P3 — a buy-in on a LIVE socket whose ACCOUNT changed during the deduct is refunded to the payer once and seats nothing', () => {
  it.each(PATHS.map((p) => [evName(p), p] as const))('%s', async (_name, p) => {
    const w = world({ tournament: p.tournament });
    const s = w.mkSocket('S1');
    p.setup?.(w, s);
    const gate = deferred();
    w.gates.deduct = gate.p;
    await run(w, p, s);
    // Another account's sign-in lands on this socket (P4's switch has already reserved / left Alice's seat).
    w.authSessions.set('S1', { userId: BOB, username: 'bob.player', masterUserId: 'm-bob', displayName: 'Bob' });
    if (p.event === 'rebuy') w.playerSessions.delete('S1');
    gate.resolve();
    await flush();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: p.amount }]);
    expect(w.credits).toEqual([{ uid: ALICE, amount: p.amount }]);            // back to the account that paid — once
    expect(w.wallet.get(ALICE)).toBe(START_WALLET);
    expect(w.wallet.get(BOB)).toBe(START_WALLET);                             // never charged, never credited
    p.notSeated(w, 'S1');
    expect(w.m.buyInsOnStaleState).toEqual({ abandoned: 1, refunded: 1, refundFailed: 0 });
    expect(w.m.buyInsOnDeadSocket).toEqual({ abandoned: 0, refunded: 0, refundFailed: 0 });
    expect(w.audits.filter((a) => a.action === p.refundAction))
      .toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'user_changed', amount: p.amount }) })]);
    // The live socket is answered (deep link: loginResult; invite: joinError; otherwise error buy_in_cancelled).
    const answered = w.emitted.filter(([ev, d]) => ((ev === 'error' || ev === 'joinError') && d?.code === 'buy_in_cancelled')
      || (ev === 'loginResult' && d?.success === false));
    expect(answered.length).toBeGreaterThan(0);
  });
});

describe('P3 — rebuy: the seat stood up during the deduct on a LIVE socket (leaveTable, another device, the hand-start gate…)', () => {
  const sitAlice = (w: ReturnType<typeof world>, s: any) => {
    expect(w.cash.sitDown(4, 'Alice', 2000, 'p-alice', false)).toBe(true);
    w.playerSessions.set(s.id, { socketId: s.id, tableId: 'cash1', seatIndex: 4, playerName: 'Alice', playerId: 'p-alice', sittingOut: false });
  };
  /** handlePlayerLeave's effect on a cash seat: the 2,000 stack credited, the seat stood up, the session gone. */
  const leave = (w: ReturnType<typeof world>) => {
    w.wallet.set(ALICE, (w.wallet.get(ALICE) ?? 0) + 2000);
    w.cash.standUp(4);
    w.playerSessions.delete('S1');
  };

  it('leave lands while the rebuy is parked in deductChips: the 6,000 top-up is refunded once (REBUY_REFUND seat_gone) — wallet 102,000', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    sitAlice(w, s);
    const gate = deferred();
    w.gates.deduct = gate.p;
    void s.handlers.rebuy({ amount: 8000 });
    await flush();
    leave(w);
    gate.resolve();
    await flush();
    expect(w.wallet.get(ALICE)).toBe(102_000);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 6000 }]);
    expect(w.cash.seats[4]).toMatchObject({ state: 'empty', chipCount: 0 });
    expect(w.audits.filter((a) => a.action === 'REBUY_REFUND')).toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'seat_gone', amount: 6000 }) })]);
    expect(w.emitted.filter(([ev]) => ev === 'rebuyComplete')).toEqual([]);
    expect(w.emitted).toContainEqual(['error', expect.objectContaining({ code: 'buy_in_cancelled' })]);
  });

  it('the seat stood up and RE-OCCUPIED by someone else (same index) while the session still points at it: refunded, the new occupant untouched', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    sitAlice(w, s);
    const gate = deferred();
    w.gates.deduct = gate.p;
    void s.handlers.rebuy({ amount: 8000 });
    await flush();
    w.wallet.set(ALICE, (w.wallet.get(ALICE) ?? 0) + 2000);
    w.cash.standUp(4);                                                         // e.g. the ghost-seat clear of another device's join
    expect(w.cash.sitDown(4, 'Zed', 3000, 'p-zed', false)).toBe(true);
    gate.resolve();
    await flush();
    expect(w.cash.seats[4]).toMatchObject({ playerName: 'Zed', chipCount: 3000 });
    expect(w.wallet.get(ALICE)).toBe(102_000);
    expect(w.audits.filter((a) => a.action === 'REBUY_REFUND')).toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'seat_gone' }) })]);
  });

  it('CONTROL — without the P3 re-validation the top-up lands on the detached seat object: 6,000 lost (wallet 96,000)', async () => {
    const NEEDLE = '}, rebuyState)) return;';
    expect(H.rebuy).toContain(NEEDLE);
    const w = world({ handlers: { rebuy: H.rebuy.replace(NEEDLE, '})) return;') } });
    const s = w.mkSocket('S1');
    sitAlice(w, s);
    const gate = deferred();
    w.gates.deduct = gate.p;
    void s.handlers.rebuy({ amount: 8000 });
    await flush();
    leave(w);
    gate.resolve();
    await flush();
    expect(w.wallet.get(ALICE)).toBe(96_000);                                  // the loss
    expect(w.credits).toEqual([]);
    expect(w.emitted).toContainEqual(['rebuyComplete', { success: true, newStack: 8000, added: 6000 }]);
  });
});

describe('P3 — joins: the socket\'s seat or the table changed during the deduct', () => {
  it('joinTable: a second buy-in seated this socket meanwhile → this one refunded (session_changed); that seat untouched', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.deduct = gate.p;
    void s.handlers.joinTable({ tableId: 'cash1', playerName: 'Alice', seatIndex: 3, buyIn: 2000 });
    await flush();
    const other = { socketId: 'S1', tableId: 'cash1', seatIndex: 6, playerName: 'Alice', playerId: 'p-other', sittingOut: false };
    w.cash.sitDown(6, 'Alice', 1000, 'p-other', false);
    w.playerSessions.set('S1', other);
    gate.resolve();
    await flush();
    expect(w.playerSessions.get('S1')).toBe(other);
    expect(w.cash.seats[3].state).toBe('empty');
    expect(w.credits).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(w.audits.filter((a) => a.action === 'BUY_IN_REFUND')).toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'session_changed' }) })]);
  });

  it('joinTable: the table was removed meanwhile → refunded (table_gone), nothing seated on the detached table', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.deduct = gate.p;
    void s.handlers.joinTable({ tableId: 'cash1', playerName: 'Alice', seatIndex: 3, buyIn: 2000 });
    await flush();
    const detached = w.tables.get('cash1')!;
    w.tables.delete('cash1');
    gate.resolve();
    await flush();
    expect(detached.seats[3].state).toBe('empty');
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(w.audits.filter((a) => a.action === 'BUY_IN_REFUND')).toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'table_gone' }) })]);
  });

  it('qualifier RE-ENTRY: the account changed during the credit consume → chips refunded once AND the credit refunded; not re-seated', async () => {
    const w = world({ tournament: 'qualifier' });
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.consume = gate.p;
    s.handlers.registerQualifierTournament({ qualifierId: 'weekly-qualifier', playerName: 'Alice', phone: '' });
    await flush();
    w.authSessions.set('S1', { userId: BOB, username: 'bob.player', masterUserId: 'm-bob', displayName: 'Bob' });
    gate.resolve();
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.audits.filter((a) => a.action === 'QUALIFIER_REENTRY_CREDIT_REFUND')).toEqual([expect.objectContaining({ d: expect.objectContaining({ reason: 'user_changed' }) })]);
    expect(w.tables.get('q1')!.seats.filter((x) => x.state === 'occupied')).toHaveLength(2);
    expect(w.emitted).toContainEqual(['qualifierRegistrationResult', expect.objectContaining({ success: false, code: 'buy_in_cancelled' })]);
  });

  it('wiring: every buy-in path passes its expected state to the check right after its deduct', () => {
    for (const [event, body] of Object.entries(H)) {
      if (event === 'joinClubTable' || !body.includes('deductChips(')) continue;
      const at = body.indexOf('deductChips(');
      const check = body.indexOf('await buyInSocketGone(socket,', at);
      const close = body.indexOf('))', body.indexOf("'deduct'", check));
      expect({ event, passesState: /State\s*$/.test(body.slice(check, close)) }).toEqual({ event, passesState: true });
    }
    expect(SRC).toContain('buyInsAbandonedStateChanged: { ...buyInsOnStaleState },');
  });
});

describe('P5 — a CASH buy-in never lands on a tournament table (live or just broken)', () => {
  const tournamentTable = (w: ReturnType<typeof world>, id = 'tt', live = true) => {
    const t = w.mkTable(id, 5000);
    if (live) w.tournamentTables.set(id, 'T-1');
    else w.m.noteBrokenTournamentTable(id, 'T-1');
    return t;
  };
  const refusedWith = (w: ReturnType<typeof world>, ev = 'error') =>
    expect(w.emitted).toContainEqual([ev, expect.objectContaining({ code: 'tournament_table' })]);
  const joinTt = { event: 'joinTable', payload: { tableId: 'tt', playerName: 'Alice', seatIndex: 2, buyIn: 5000 } } as any;

  it.each([['live', true], ['broken', false]] as const)('joinTable at a %s tournament table: refused before any side effect — nothing deducted or seated', async (_k, live) => {
    const w = world();
    const s = w.mkSocket('S1');
    const t = tournamentTable(w, 'tt', live);
    await run(w, joinTt, s);
    refusedWith(w);
    expect(w.deductions).toEqual([]);
    expect(t.seats.every((x) => x.state === 'empty')).toBe(true);
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.m.cashJoinsAtTournamentTable.refused).toBe(1);
  });

  it('CONTROL — without the refusal (pre-P5) joinTable deducts 5,000 and seats the cash player on the tournament table', async () => {
    const REFUSE = "      if (isTournamentTable(tableId)) {\n        refuseCashJoinAtTournamentTable(socket, 'joinTable', tableId);\n        return;\n      }\n";
    expect(H.joinTable).toContain(REFUSE);
    const w = world({ handlers: { joinTable: H.joinTable.replace(REFUSE, '') } });
    const s = w.mkSocket('S1');
    const t = tournamentTable(w);
    await run(w, joinTt, s);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 5000 }]);
    expect(t.seats[2]).toMatchObject({ state: 'occupied', playerName: 'Alice' });
  });

  it('quickPlay skips an EMPTIER tournament table and seats at the cash table', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    const t = tournamentTable(w);                                              // 0 players: Quick Play's first pick before P5
    await run(w, PATHS.find((x) => x.event === 'quickPlay')!, s);
    expect(t.seats.every((x) => x.state === 'empty')).toBe(true);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1' });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
  });

  it('joinAdditionalTable / joinByInviteCode at a tournament table: refused (the invite on joinError)', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    tournamentTable(w);
    await run(w, { event: 'joinAdditionalTable', payload: { tableId: 'tt', playerName: 'Alice', buyIn: 5000 } } as any, s);
    refusedWith(w);
    expect(w.deductions).toEqual([]);
    const w2 = world();
    const s2 = w2.mkSocket('S1');
    w2.tournamentTables.set('cash1', 'T-1');                                   // the invite code resolves to a tournament table
    await run(w2, PATHS.find((x) => x.event === 'joinByInviteCode')!, s2);
    refusedWith(w2, 'joinError');
    expect(w2.deductions).toEqual([]);
  });

  it('waitlist deep link: a tournament table is never the seat — the cash table is', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    const t = tournamentTable(w, 'tt');
    t.config.smallBlind = 1;                                                   // the "lowest stakes" Hold'em table
    await run(w, PATHS.find((x) => (x.event as string) === 'waitlist')!, s);
    expect(t.seats.every((x) => x.state === 'empty')).toBe(true);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1' });
  });

  it('startHand on a BROKEN tournament table is refused (table_closed); on a cash table it deals', async () => {
    const w = world();
    const s = w.mkSocket('S1');
    const t = tournamentTable(w, 'tb', false);
    t.sitDown(0, 'Alice', 5000, 'p-alice', false, true);
    t.sitDown(1, 'Bot', 5000, 'p-bot', true, true);
    w.playerSessions.set('S1', { socketId: 'S1', tableId: 'tb', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice', sittingOut: false });
    const start = jest.spyOn(t, 'startNewHand');
    await s.handlers.startHand();
    expect(start).not.toHaveBeenCalled();
    expect(w.emitted).toContainEqual(['error', expect.objectContaining({ code: 'table_closed' })]);
    w.cash.sitDown(4, 'Alice', 2000, 'p-alice2', false);
    w.playerSessions.set('S1', { socketId: 'S1', tableId: 'cash1', seatIndex: 4, playerName: 'Alice', playerId: 'p-alice2', sittingOut: false });
    await s.handlers.startHand();
    expect(w.cash.handNumber).toBe(1);
  });
});

describe('P4 — a waitlist link never seats or charges the OTHER account signed in on the socket', () => {
  const link = PATHS.find((x) => (x.event as string) === 'waitlist')!;
  const signedInAs = (w: ReturnType<typeof world>, session: any = { userId: BOB, username: 'bob.player', masterUserId: 'm-bob', displayName: 'Bob' }) => {
    const s = w.mkSocket('S1', false);
    w.authSessions.set('S1', session);
    return s;
  };

  it('signed in as Bob, Alice\'s link: refused account_mismatch — nothing deducted from anyone, nobody seated, Bob\'s session untouched', async () => {
    const w = world();
    const s = signedInAs(w);
    await run(w, link, s);
    expect(w.emitted).toContainEqual(['loginResult', expect.objectContaining({ success: false, code: 'account_mismatch' })]);
    expect(w.emitted).toContainEqual(['error', expect.objectContaining({ code: 'account_mismatch' })]);
    expect(w.deductions).toEqual([]);
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.authSessions.get('S1')).toMatchObject({ userId: BOB });
    expect(w.m.waitlistAccountMismatches.refused).toBe(1);
  });

  it('an UNPROVABLE session (no master id resolved — e.g. a legacy guest row) counts as another account', async () => {
    const w = world();
    const s = signedInAs(w, { userId: BOB, username: 'Guest42', statsMasterUserId: null });
    await run(w, link, s);
    expect(w.emitted).toContainEqual(['loginResult', expect.objectContaining({ code: 'account_mismatch' })]);
    expect(w.deductions).toEqual([]);
  });

  it('the SAME account through a legacy login (the gate-resolved stats stamp) proceeds as before', async () => {
    const w = world();
    const s = signedInAs(w, { userId: ALICE, username: 'alice.player', statsMasterUserId: 'm-alice' });
    await run(w, link, s);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1' });
  });

  it('a sign-in that LANDS during the bootstrap is never overwritten — and then refused as another account', async () => {
    const w = world();
    const s = w.mkSocket('S1', false);
    const gate = deferred();
    w.gates.me = gate.p;
    void s.handlers.joinWithWaitlistContext({ token: 'tkt', context: {} });
    await flush();
    w.authSessions.set('S1', { userId: BOB, username: 'bob.player', masterUserId: 'm-bob', displayName: 'Bob' });   // Bob's oauthLogin finished meanwhile
    gate.resolve();
    await flush();
    expect(w.authSessions.get('S1')).toMatchObject({ userId: BOB });
    expect(w.emitted).toContainEqual(['loginResult', expect.objectContaining({ code: 'account_mismatch' })]);
    expect(w.deductions).toEqual([]);
  });

  it('CONTROL — without the check (pre-P4) Alice\'s link seats BOB and charges BOB\'s wallet', async () => {
    const at = H.waitlist.indexOf('        // P4 (2026-10-10) — the seat this link buys is the TICKET');
    const end = H.waitlist.indexOf('        // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.', at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const w = world({ handlers: { waitlist: H.waitlist.slice(0, at) + H.waitlist.slice(end) } as any });
    const s = signedInAs(w);
    await run(w, link, s);
    expect(w.deductions).toEqual([{ uid: BOB, amount: 1000 }]);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1' });
  });
});

// ── pe3 minor (2026-10-10) — the waitlist buy-in cancellation carries a machine-readable cancelCode ──
describe('pe3 minor — the waitlist link\'s buy-in cancellation says so on BOTH frames: cancelCode buy_in_cancelled', () => {
  it('the account changed during the deduct on a LIVE socket: refunded once; error AND loginResult carry cancelCode \'buy_in_cancelled\' and the "chips were returned … tap Play Online again" sentence', async () => {
    const p = PATHS.find((x) => (x.event as string) === 'waitlist')!;
    const w = world();
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.deduct = gate.p;
    await run(w, p, s);
    w.authSessions.set('S1', { userId: BOB, username: 'bob.player', masterUserId: 'm-bob', displayName: 'Bob' });
    gate.resolve();
    await flush();
    const err = w.emitted.find(([ev, d]) => ev === 'error' && d?.cancelCode);
    expect(err![1]).toEqual({ code: 'handler_exception', cancelCode: 'buy_in_cancelled', message: expect.stringContaining('any chips taken were returned') });
    expect(err![1].message).toContain('Tap Play Online in the American Pub Poker app again for a new link');
    expect(w.emitted.find(([ev, d]) => ev === 'loginResult' && d?.success === false)![1]).toMatchObject({ code: 'handler_exception', cancelCode: 'buy_in_cancelled' });
    expect(w.credits).toEqual([{ uid: ALICE, amount: p.amount }]);
  });

  it('other waitlist failures carry no cancelCode (e.g. no tables)', async () => {
    const p = PATHS.find((x) => (x.event as string) === 'waitlist')!;
    const w = world();
    w.tables.delete('cash1');
    const s = w.mkSocket('S1');
    await run(w, p, s);
    await flush();
    const errs = w.emitted.filter(([ev]) => ev === 'error');
    expect(errs.length).toBeGreaterThan(0);
    for (const [, d] of errs) expect(d.cancelCode).toBeUndefined();
  });

  it('the REAL failLogin merges `extra` into the loginResult failure frame (additive; older clients ignore it)', () => {
    const sent: any[] = [];
    const { exports } = load(slice('function failLogin(', '\n}\n'), {
      normalizeRequestId: (x: unknown) => (typeof x === 'string' ? x : undefined),
      buildLoginFailure: (code: string, message: string, rid?: string) => ({ success: false, error: message, code, ...(rid ? { requestId: rid } : {}) }),
      authTelemetry: { suppressedNoType: 0 }, LOGIN_FAILURE_EVENT_TYPE: '', reportAuthEvent() {}, _warnedLoginFailureTypeUnset: true,
      console: { warn() {}, log() {}, error() {} },
    }, '{ failLogin }');
    const sock = { emit: (ev: string, d: any) => sent.push([ev, d]) };
    exports.failLogin(sock, { code: 'handler_exception', message: 'M', via: 'joinWithWaitlistContext', requestId: 'r1', extra: { cancelCode: 'buy_in_cancelled' } });
    exports.failLogin(sock, { code: 'ticket_missing', message: 'N', via: 'joinWithWaitlistContext' });
    expect(sent).toEqual([
      ['loginResult', { success: false, error: 'M', code: 'handler_exception', requestId: 'r1', cancelCode: 'buy_in_cancelled' }],
      ['loginResult', { success: false, error: 'N', code: 'ticket_missing' }],
    ]);
  });
});

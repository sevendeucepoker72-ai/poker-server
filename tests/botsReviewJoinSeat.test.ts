/**
 * Bots review 2026-11-04 (A-vanish) — a join that takes a BOT's seat mid-hand
 * plans it at the pick and frees it at the commit.
 *
 * Before: every join path (joinTable, quickPlay, the waitlist link,
 * joinAdditionalTable, an invite) stood the bot up — and deleted its profile —
 * at the PICK, before the awaited balance read and deduct. Any refusal during
 * those awaits (not enough chips, a failed deduct, a dropped socket) left an
 * empty seat in the middle of a hand with the bot gone; an under-funded
 * joinAdditionalTable removed a bot per request.
 * Now: planAiSeatForJoin stands the bot up at the pick only BETWEEN hands (no
 * hand affected, as before); mid-hand it only plans the seat, and
 * takePlannedAiSeat frees it at the commit (the last statement before sitDown).
 * joinAdditionalTable checks the seat (a pure lookup) and the wallet before it
 * touches any bot.
 *
 * The helpers run on the REAL seat-teardown block (SEAT_TEARDOWN_SRC); the
 * handlers are the REAL src/index.ts text (sliced + transpiled) against the
 * REAL PokerTable, with an in-memory wallet.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { accountDisplayName } from '../src/auth/displayName';
import { sanitizeSeatAvatar } from '../src/seatProfile';
import { qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, QUALIFIER_BASE_STACK } from '../src/game/qualifierSchedule';
import {
  slice, fnSrc, handlerSrc, load, flush, deferred, SEAT_SESSION_FOR_SRC, JOIN_PRECHECK_SRC, SEAT_TEARDOWN_SRC,
} from './helpers/indexSource';

const ALICE = 101;
const quiet = { log() {}, warn() {}, error() {} };
const occ = (t: PokerTable) => t.seats.map((s) => (s.state !== 'occupied' ? '.' : s.isAI ? 'B' : 'H')).join('');
const stake = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : 0), 0);
function playOut(t: PokerTable): void {
  for (let g = 0; g < 400 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
}

// ─────────────────────────────── the helpers (unit) ───────────────────────────────
describe('planAiSeatForJoin / takePlannedAiSeat on the real seat-teardown block', () => {
  function unit() {
    const T = 'T';
    const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 } as any);
    const aiProfiles = new Map<string, Map<number, any>>([[T, new Map()]]);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? table : undefined) }, MAX_SEATS, GamePhase, FiveCardDrawTable,
      DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], aiProfiles, aiTimeouts: new Map(), pendingAutoStartTimers: new Map(),
      pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), quickTables: new Set(), scheduleAIAction() {}, syncSitOutToTable() {},
      isTournamentTable: () => false, isFixedRosterQuickTable: () => false, console: quiet,
    };
    const { exports: m, stubbed } = load(SEAT_TEARDOWN_SRC, scope,
      '{ planAiSeatForJoin, takePlannedAiSeat, takeAiSeatForJoin, aiSeatTakeableNow, joinSeatStats }');
    const bot = (i: number) => { expect(table.sitDown(i, `Bot${i}`, 10000, `ai-${i}`, true)).toBe(true); aiProfiles.get(T)!.set(i, { botName: `Bot${i}` }); };
    /** 2 humans + 7 bots, a hand dealt, the first bot to act (nothing invested) folds. */
    const fullMidHandFold = () => {
      table.sitDown(0, 'H0', 10000, 'h0', false); table.sitDown(1, 'H1', 10000, 'h1', false);
      for (let i = 2; i < 9; i++) bot(i);
      expect(table.startNewHand()).toBe(true);
      for (let g = 0; g < 9 && !(table.seats[table.activeSeatIndex].isAI && (table.seats[table.activeSeatIndex].totalInvestedThisHand || 0) === 0); g++) {
        const a = table.activeSeatIndex;
        expect(table.playerCall(a) || table.playerCheck(a)).toBe(true);
      }
      const folder = table.activeSeatIndex;
      expect(table.playerFold(folder)).toBe(true);
      return folder;
    };
    return { T, table, aiProfiles, m, stubbed, bot, fullMidHandFold };
  }

  it('mid-hand: the plan returns the folded, nothing-invested bot\'s seat and leaves the bot seated with its profile; the commit stands it up', () => {
    const u = unit();
    const folder = u.fullMidHandFold();
    const pick = u.m.planAiSeatForJoin(u.table, u.T);
    expect(pick).toBe(folder);
    expect(u.table.seats[pick]).toMatchObject({ state: 'occupied', isAI: true, playerId: `ai-${folder}` });
    expect(u.aiProfiles.get(u.T)!.has(pick)).toBe(true);
    expect(occ(u.table)).toBe('HHBBBBBBB');
    expect(u.m.takePlannedAiSeat(u.table, u.T, pick)).toBe(true);
    expect(u.table.seats[pick].state).toBe('empty');
    expect(u.aiProfiles.get(u.T)!.has(pick)).toBe(false);
    expect(u.m.joinSeatStats).toEqual({ plannedBotTaken: 1, plannedBotLost: 0, preCheckRefused: 0 });
    expect([...u.stubbed].filter((n) => /Seat|aiProfiles|GamePhase/.test(n))).toEqual([]);
  });

  it('the hand ended AND the next one dealt the bot in during the awaits → false, the bot stays (plannedBotLost)', () => {
    const u = unit();
    u.fullMidHandFold();
    const pick = u.m.planAiSeatForJoin(u.table, u.T);
    playOut(u.table);
    expect(u.table.startNewHand()).toBe(true);
    expect(u.table.seats[pick].holeCards.length).toBeGreaterThan(0);
    expect(u.m.takePlannedAiSeat(u.table, u.T, pick)).toBe(false);
    expect(u.table.seats[pick]).toMatchObject({ state: 'occupied', isAI: true, playerId: `ai-${pick}` });
    expect(u.aiProfiles.get(u.T)!.has(pick)).toBe(true);
    expect(u.m.joinSeatStats).toEqual({ plannedBotTaken: 0, plannedBotLost: 1, preCheckRefused: 0 });
  });

  it('only the hand ended (HandComplete) during the awaits → still takeable: true', () => {
    const u = unit();
    u.fullMidHandFold();
    const pick = u.m.planAiSeatForJoin(u.table, u.T);
    playOut(u.table);
    expect(u.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(u.m.takePlannedAiSeat(u.table, u.T, pick)).toBe(true);
    expect(u.table.seats[pick].state).toBe('empty');
  });

  it('between hands the plan stands the bot up at once (as before); an empty planned seat commits as true', () => {
    const u = unit();
    u.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 9; i++) u.bot(i);
    expect(u.table.currentPhase).toBe(GamePhase.WaitingForPlayers);
    const pick = u.m.planAiSeatForJoin(u.table, u.T);
    expect(pick).toBe(1);
    expect(u.table.seats[1].state).toBe('empty');
    expect(u.aiProfiles.get(u.T)!.has(1)).toBe(false);
    expect(u.m.takePlannedAiSeat(u.table, u.T, pick)).toBe(true);
    expect(u.m.joinSeatStats).toEqual({ plannedBotTaken: 0, plannedBotLost: 0, preCheckRefused: 0 });
  });

  it('mid-hand with every bot still in the hand → -1 (nothing planned, nothing touched)', () => {
    const u = unit();
    u.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 9; i++) u.bot(i);
    expect(u.table.startNewHand()).toBe(true);
    expect(u.m.planAiSeatForJoin(u.table, u.T)).toBe(-1);
    expect(occ(u.table)).toBe('HBBBBBBBB');
  });
});

// ─────────────────────────────── the join handlers ───────────────────────────────
const H = {
  joinTable: handlerSrc('joinTable', '\n    })(); }\n  );'),
  quickPlay: handlerSrc('quickPlay', '\n    })(); }\n  );'),
  waitlist: handlerSrc('joinWithWaitlistContext', '\n    }\n  );'),
  joinAdditionalTable: handlerSrc('joinAdditionalTable', '\n  });\n'),
  joinByInviteCode: handlerSrc('joinByInviteCode', '\n  });\n'),
};
const BUY_IN_GONE = slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n') + fnSrc('function socketHasSessionAt(');
const LOGIN_GONE = slice('const loginsOnDeadSocket = { abandoned: 0 };', '\n}\n');
const BROKEN_TABLES = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const CASH_JOIN_REFUSAL = slice('const TOURNAMENT_TABLE_JOIN_MESSAGE', '\n}\n');
const WAITLIST_MISMATCH = slice('const WAITLIST_ACCOUNT_MISMATCH_MESSAGE', 'const waitlistAccountMismatches = { refused: 0 };');
const SEAT_NAME = slice('function seatNameForSocket(', '\n}\n');
const WHO_SITS = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', "  socket.emit(channel, { message: TABLE_NOT_JOINABLE_MESSAGE, code: 'table_not_joinable', reason });\n}\n");

function world(opts: { wallet?: number } = {}) {
  const wallet = new Map<number, number>([[ALICE, opts.wallet ?? 100_000]]);
  const deductions: Array<{ uid: number; amount: number }> = [];
  const credits: Array<{ uid: number; amount: number }> = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const gates: { balance: Promise<void> | null; balanceAt: number; failDeduct: boolean } = { balance: null, balanceAt: 0, failDeduct: false };
  const calls = { balance: 0 };
  const tables = new Map<string, PokerTable>();
  const cash = new PokerTable({ tableId: 'cash1', tableName: 'cash1', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
  (cash as any).variantId = 'texas-holdem';
  tables.set('cash1', cash);
  const aiProfiles = new Map<string, Map<number, any>>([['cash1', new Map()]]);
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const sockets = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tableManager: {
      getTable: (id: string) => tables.get(id),
      getTableList: () => [...tables.entries()].map(([tableId, t]) => ({
        tableId, variant: 'texas-holdem', playerCount: t.getOccupiedSeatCount(), smallBlind: t.config.smallBlind, minBuyIn: t.config.minBuyIn,
      })),
    },
    authSessions, playerSessions, multiTableSessions, reservedSeats: new Map(), tournamentTables: new Map(), qualifierTournaments: new Map(),
    tournamentManager: new TournamentManager(), spectators: new Map(), aiProfiles, ipSeatedSlots: new Map(), quickTables: new Set(),
    quickGameTimers: new Map(), spinGoMultipliers: new Map(), allInOrFoldTables: new Set(), careerTables: new Map(), challengeTables: new Map(),
    MAX_SEATS, GamePhase, FiveCardDrawTable, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3],
    clientIp: '10.0.0.1', SEAT_RESERVE_MS: 6 * 3600_000,
    pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(),
    io: { emit() {}, to: () => ({ emit() {} }), sockets: { sockets } },
    uuidv4: () => `u${Math.random().toString(36).slice(2, 10)}`,
    blockedByMaintenance: () => false, quickPlayRateLimited: () => false, shutdownFlushActive: () => false,
    assertPlayable: async () => null, emitPlayRefusal: (s: any, r: any) => s.emit('error', { message: r.message, code: r.code }),
    isUserBanned: async () => false,
    ensureChipsForBuyIn: async (uid: number) => {
      calls.balance++;
      if (gates.balance && calls.balance === gates.balanceAt) await gates.balance;
      return wallet.get(uid) ?? 0;
    },
    getUserChips: async (uid: number) => wallet.get(uid) ?? 0,
    UNLIMITED_CHIPS_TESTING: false,
    deductChips: async (uid: number, amount: number) => {
      if (gates.failDeduct) return false;
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
    Sentry: null, console: quiet, log: { debug() {}, warn() {}, info() {} },
    // the waitlist deep link
    normalizeRequestId: (x: unknown) => (typeof x === 'string' ? x : undefined),
    failLogin: (s: any, f: any) => s.emit('loginResult', { success: false, code: f.code, ...(f.extra || {}) }),
    markTicketUsed: () => true, reportAuthEvent() {}, loginTracker: { begin: () => () => {}, forget() {} },
    fetch: async (url: string) => {
      if (url.endsWith('/online-link-token/verify')) return { ok: true, json: async () => ({ valid: true, payload: { userId: 'm-alice', gameId: 'g1' } }) };
      return { ok: true, json: async () => ({ phoneNumber: '5550101' }) };
    },
    getPool: () => ({ query: async () => ({ rows: [{ id: ALICE, username: '5550101' }] }) }),
    resumeFieldsFor: () => ({}),
    accountDisplayName, sanitizeSeatAvatar, publicNameOf: (n: unknown) => String(n ?? ''),
    qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, QUALIFIER_BASE_STACK,
    // an invite code opens a PRIVATE home game: here, cash1
    privateTableByInviteCode: (code: string) => (code === 'cash1' ? { tableId: 'cash1', table: tables.get('cash1') } : null),
  };
  const code = `
${BUY_IN_GONE}
${LOGIN_GONE}
${BROKEN_TABLES}
${CASH_JOIN_REFUSAL}
${WAITLIST_MISMATCH}
${SEAT_NAME}
${WHO_SITS}
${JOIN_PRECHECK_SRC}
${SEAT_TEARDOWN_SRC}
function wire(socket) {
${SEAT_SESSION_FOR_SRC}
  ${Object.values(H).join('\n  ')}
}`;
  const { exports: m, stubbed } = load(code, scope, '{ wire, joinSeatStats }');
  const emitted: Array<[string, any]> = [];
  const mkSocket = (id: string) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers, handshake: { address: '10.0.0.1' },
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      listeners: (ev: string) => (handlers[ev] ? [handlers[ev]] : []),
      emit: (ev: string, p: any) => { emitted.push([ev, p]); },
      join() {}, leave() {},
    };
    sockets.set(id, s);
    authSessions.set(id, { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice', displayName: 'Alice' });
    m.wire(s);
    return s;
  };
  const drop = (s: any) => { s.connected = false; sockets.delete(s.id); authSessions.delete(s.id); };
  const bot = (i: number) => { expect(cash.sitDown(i, `Bot${i}`, 5000, `ai-${i}`, true)).toBe(true); aiProfiles.get('cash1')!.set(i, { botName: `Bot${i}` }); };
  /** Two humans (Bob, Carl) + 7 bots; with `foldOne`, a hand is dealt and the first bot to act (nothing invested) folds. */
  const fullTable = (o: { deal?: boolean; foldOne?: boolean } = {}) => {
    expect(cash.sitDown(0, 'Bob', 5000, 'p-bob', false)).toBe(true);
    expect(cash.sitDown(1, 'Carl', 5000, 'p-carl', false)).toBe(true);
    for (let i = 2; i < 9; i++) bot(i);
    if (!o.deal && !o.foldOne) return -1;
    expect(cash.startNewHand()).toBe(true);
    if (!o.foldOne) return -1;
    for (let g = 0; g < 9 && !(cash.seats[cash.activeSeatIndex].isAI && (cash.seats[cash.activeSeatIndex].totalInvestedThisHand || 0) === 0); g++) {
      const a = cash.activeSeatIndex;
      expect(cash.playerCall(a) || cash.playerCheck(a)).toBe(true);
    }
    const folder = cash.activeSeatIndex;
    expect(cash.playerFold(folder)).toBe(true);
    return folder;
  };
  const roster = () => cash.seats.map((s) => (s.state === 'occupied' ? s.playerId : null));
  const errors = (ev = 'error') => emitted.filter(([e]) => e === ev).map(([, p]) => p);
  return { m, stubbed, wallet, deductions, credits, audits, gates, calls, cash, aiProfiles, playerSessions, multiTableSessions, emitted, mkSocket, drop, fullTable, roster, errors };
}

async function send(s: any, ev: string, payload: any) {
  void s.handlers[ev](payload);
  await flush();
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('A-vanish — a refused mid-hand join leaves the bot it planned to replace seated (profile kept)', () => {
  it('(1) joinTable, the deduct fails: refused, the bot still sits there with the same playerId and profile, no seat emptied (0dc1b96: the seat was empty, the profile gone)', async () => {
    const w = world();
    const folder = w.fullTable({ foldOne: true });
    const before = w.roster();
    w.gates.failDeduct = true;
    const s = w.mkSocket('S1');
    await send(s, 'joinTable', { tableId: 'cash1', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    expect(w.errors()).toEqual([{ message: 'Could not deduct chips — try again' }]);
    expect(w.roster()).toEqual(before);
    expect(occ(w.cash)).toBe('HHBBBBBBB');
    expect(w.aiProfiles.get('cash1')!.has(folder)).toBe(true);
    expect(w.playerSessions.has('S1')).toBe(false);
    expect([...w.stubbed].filter((n) => /planAiSeatForJoin|takePlannedAiSeat|aiSeatTakeableNow|buyInSocketGone|deductChips/.test(n))).toEqual([]);
  });

  it('(2) joinTable, the socket drops during the balance read after the pick: nothing deducted, the bot still seated', async () => {
    const w = world();
    const folder = w.fullTable({ foldOne: true });
    const before = w.roster();
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.balance = gate.p;
    w.gates.balanceAt = 2;                                   // the post-leave read (the pre-leave F143 read is #1)
    await send(s, 'joinTable', { tableId: 'cash1', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    expect(w.calls.balance).toBe(2);                         // parked on the read after the pick
    w.drop(s);
    gate.resolve();
    await flush();
    expect(w.deductions).toEqual([]);
    expect(w.roster()).toEqual(before);
    expect(w.aiProfiles.get('cash1')!.has(folder)).toBe(true);
  });

  it('(5) quickPlay, the waitlist link and an invite: a failed deduct leaves the bot seated', async () => {
    for (const [ev, payload, channel] of [
      ['quickPlay', { playerName: 'Alice' }, 'error'],
      ['joinWithWaitlistContext', { token: 'tkt', context: {} }, 'error'],   // failWaitlist: 'error' {message} + loginResult
      ['joinByInviteCode', { inviteCode: 'cash1', playerName: 'Alice', buyIn: 2000 }, 'joinError'],
    ] as const) {
      const w = world();
      const folder = w.fullTable({ foldOne: true });
      const before = w.roster();
      w.gates.failDeduct = true;
      const s = w.mkSocket('S1');
      await send(s, ev, payload);
      expect([ev, w.errors(channel).length]).toEqual([ev, 1]);
      expect([ev, JSON.stringify(w.errors(channel))]).toEqual([ev, expect.stringMatching(/Could not deduct chips/)]);
      expect([ev, w.roster()]).toEqual([ev, before]);
      expect([ev, w.aiProfiles.get('cash1')!.has(folder)]).toEqual([ev, true]);
      expect([ev, w.deductions]).toEqual([ev, []]);
      expect([ev, w.playerSessions.has('S1')]).toEqual([ev, false]);
    }
  });
});

describe('A-vanish — joinAdditionalTable checks the seat and the wallet BEFORE it touches a bot', () => {
  it('(3) a wallet below the minimum, 3× mid-hand and 3× between hands: 0 bots removed, 0 deducts, the existing refusal text (0dc1b96: a bot stood up per request until a seat sat empty)', async () => {
    const w = world({ wallet: 500 });
    w.fullTable({ foldOne: true });
    const before = w.roster();
    const s = w.mkSocket('S1');
    for (let k = 0; k < 3; k++) await send(s, 'joinAdditionalTable', { tableId: 'cash1', playerName: 'Alice', buyIn: 1000 });
    expect(w.roster()).toEqual(before);
    playOut(w.cash);
    expect(w.cash.currentPhase).toBe(GamePhase.HandComplete);       // between hands: any bot is takeable
    for (let k = 0; k < 3; k++) await send(s, 'joinAdditionalTable', { tableId: 'cash1', playerName: 'Alice', buyIn: 1000 });
    expect(w.roster()).toEqual(before);
    expect(occ(w.cash)).toBe('HHBBBBBBB');
    expect(w.deductions).toEqual([]);
    expect(w.errors()).toEqual(Array(6).fill({ message: 'Insufficient chips for the additional-table buy-in' }));
    expect(w.m.joinSeatStats.preCheckRefused).toBe(6);
    expect(w.multiTableSessions.has('S1')).toBe(false);
  });

  it('(4) GUARD (passes at 0dc1b96 too) — no empty or takeable seat: "No seats available" with no wallet read', async () => {
    const w = world();
    w.fullTable({ deal: true });                             // every bot is in the hand
    const s = w.mkSocket('S1');
    await send(s, 'joinAdditionalTable', { tableId: 'cash1', playerName: 'Alice', buyIn: 1000 });
    expect(w.errors()).toEqual([{ message: 'No seats available' }]);
    expect(w.calls.balance).toBe(0);
    expect(occ(w.cash)).toBe('HHBBBBBBB');
  });

  it('a funded extra-table join mid-hand takes the planned bot seat at the commit (one deduct, seated)', async () => {
    const w = world();
    const folder = w.fullTable({ foldOne: true });
    const s = w.mkSocket('S1');
    await send(s, 'joinAdditionalTable', { tableId: 'cash1', playerName: 'Alice', buyIn: 1000 });
    expect(w.errors()).toEqual([]);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.multiTableSessions.get('S1')).toEqual([expect.objectContaining({ tableId: 'cash1', seatIndex: folder })]);
    expect(w.cash.seats[folder]).toMatchObject({ state: 'occupied', isAI: false, chipCount: 1000 });
    expect(w.m.joinSeatStats.plannedBotTaken).toBe(1);
  });
});

describe('A-vanish — the commit', () => {
  it('(6) a successful mid-hand joinTable: seated folded with no cards at the planned seat, chips conserved, dealt the next hand', async () => {
    const w = world();
    const folder = w.fullTable({ foldOne: true });
    const botChips = w.cash.seats[folder].chipCount;
    const s0 = stake(w.cash);
    const s = w.mkSocket('S1');
    await send(s, 'joinTable', { tableId: 'cash1', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    expect(w.errors()).toEqual([]);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1', seatIndex: folder });
    const seat = w.cash.seats[folder];
    expect(seat).toMatchObject({ state: 'occupied', isAI: false, chipCount: 2000, folded: true });
    expect(seat.holeCards).toEqual([]);
    expect(w.aiProfiles.get('cash1')!.has(folder)).toBe(false);
    expect(stake(w.cash)).toBe(s0 - botChips + 2000);       // the bot's stack left with it, the joiner's buy-in came in
    playOut(w.cash);
    expect(stake(w.cash)).toBe(s0 - botChips + 2000);
    expect(w.cash.startNewHand()).toBe(true);
    expect(w.cash.seats[folder].holeCards.length).toBe(2);
    expect(w.m.joinSeatStats).toEqual({ plannedBotTaken: 1, plannedBotLost: 0, preCheckRefused: 0 });
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(w.credits).toEqual([]);
  });

  it('(7) race — the hand ends and the next deals the bot in during the balance read: "No seats available" / no_seat_available, refunded once (planned_seat_lost), the bot stays', async () => {
    const w = world();
    const folder = w.fullTable({ foldOne: true });
    const s = w.mkSocket('S1');
    const gate = deferred();
    w.gates.balance = gate.p;
    w.gates.balanceAt = 2;
    await send(s, 'joinTable', { tableId: 'cash1', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    playOut(w.cash);
    expect(w.cash.startNewHand()).toBe(true);
    expect(w.cash.seats[folder].holeCards.length).toBe(2);   // the planned bot was dealt in
    gate.resolve();
    await flush();
    expect(w.errors()).toEqual([{ message: 'No seats available', code: 'no_seat_available' }]);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(w.audits.filter((a) => a.action === 'BUY_IN_REFUND')).toEqual([
      expect.objectContaining({ d: expect.objectContaining({ reason: 'planned_seat_lost', buyIn: 2000 }) }),
    ]);
    expect(w.cash.seats[folder]).toMatchObject({ state: 'occupied', isAI: true, playerId: `ai-${folder}` });
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.m.joinSeatStats.plannedBotLost).toBe(1);
  });

  it('GUARD (passes at 0dc1b96 too) — between hands a full-table join still frees a bot\'s seat at the pick and seats the player (unchanged)', async () => {
    const w = world();
    w.fullTable();
    const s = w.mkSocket('S1');
    await send(s, 'joinTable', { tableId: 'cash1', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    expect(w.errors()).toEqual([]);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'cash1', seatIndex: 2 });
    expect(occ(w.cash)).toBe('HHHBBBBBB');
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 2000 }]);
  });
});

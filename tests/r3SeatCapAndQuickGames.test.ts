/**
 * R3 (2026-10-11, SF-A) — seats inside a table's cap, and quick games whose
 * result is never thrown away.
 *
 * S1-1 / XL-1 / K3-1 (P1): R2 honoured a home game's maxSeats (2-9) and a club
 * table's seat count, but the bot fill, the heartbeat backfill and the join
 * seat-picks still walked all nine seats: fillWithAI's "leave one seat open"
 * counted seats PAST the cap (sitDown refuses them), so bots filled every seat
 * inside it; joinByInviteCode / joinTable then "found" seat N past the cap,
 * deducted the buy-in, had sitDown refuse it and refunded — a 2-5 seat home
 * game or a 2-3 seat club table could NEVER seat an invitee / member. Now only
 * seats below the cap count (one of them always left open), a capped table
 * trims to cap - 1 at the hand boundary, and a join takes an empty seat below
 * the cap or frees a bot's (takeAiSeatForJoin) BEFORE any chip moves.
 *
 * S1-4 (P2): a quick game DECIDED by its last hand waits QUICK_GAME_RESULT_DELAY_MS
 * before its result; a leave inside that second removed the game first — a
 * Spin & Go win became a forfeit (no prize), a career stage win was never
 * recorded or rewarded. Now the decided game is settled before the leaving
 * seat (or the cleanup) tears anything down.
 *
 * The REAL src/index.ts handlers / helpers (sliced + transpiled) with the REAL
 * PokerTable, quickGameOutcome and prize ledger.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { quickGameOutcome, spinGoMultiplierFor } from '../src/game/quickGames';
import { createPrizeLedger } from '../src/game/prizeLedger';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { validateTableConfig } from '../src/game/tableConfigValidation';
import { accountDisplayName } from '../src/auth/displayName';
import { CAREER_VENUE_LEVELS } from '../src/economy/catalog';
import { slice, fnSrc, handlerSrc, load, flush, SEAT_TEARDOWN_SRC, JOIN_PRECHECK_SRC } from './helpers/indexSource';
import { createFakeLedgerDb } from './helpers/fakeLedgerDb';

const HOST = 101;
const FRIENDS = [102, 103, 104, 105, 106, 107, 108, 109];

const WHO = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', '}, 60_000).unref?.();\n');
const QUICK = slice('// R2 (ECON-17) — every prize / refund settlement', '\n// ========== Socket.io Events ==========');
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const H = {
  joinTable: handlerSrc('joinTable', '\n    })(); }\n  );'),
  joinClubTable: handlerSrc('joinClubTable', '\n  });\n'),
  createPrivateTable: handlerSrc('createPrivateTable', '\n  });\n'),
  joinByInviteCode: handlerSrc('joinByInviteCode', '\n  });\n'),
  quickSpinGo: handlerSrc('quickSpinGo', '\n  });\n'),
  startCareerGame: handlerSrc('startCareerGame', '\n  });\n'),
  leaveTable: handlerSrc('leaveTable', '\n  });\n'),
};
const FILL = [fnSrc('function fillWithAI('), fnSrc('function trimExcessAI('), fnSrc('function backfillAIToMin(')].join('\n');
const HEARTBEAT = [
  slice('const LIVE_ROOM_MIN_OCCUPIED = 3;', 'const heartbeatRestarts = { handComplete: 0 };'),
  fnSrc('function ensureCashTableRunning('),
].join('\n');
const LEAVE = fnSrc('function handlePlayerLeave(');
const CREDIT_SEAT = fnSrc('function creditSeatStackToWallet(');
const IS_TOURNAMENT_RESERVATION = fnSrc('function isTournamentReservation(');
const CLUB_RUNTIME = slice('const clubTablesRecreating = new Map', '\n  return job;\n}\n');

function world(opts: { joinByInviteCode?: string; fill?: string; leave?: string; quick?: string } = {}) {
  const wallets: Record<number, number> = { [HOST]: 1_000_000 };
  for (const f of FRIENDS) wallets[f] = 1_000_000;
  const db = createFakeLedgerDb(wallets);
  const credits: Array<{ uid: number; amount: number }> = [];
  const deductions: Array<{ uid: number; amount: number }> = [];
  const audits: Array<{ action: string; d: any }> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const careerProgress: Array<[number, number, number, number]> = [];
  const tables = new Map<string, PokerTable>();
  let created = 0;
  let uid = 0;
  let botN = 0;
  const mkTable = (id: string, o: { sb?: number; bb?: number; minBuyIn?: number; name?: string } = {}) => {
    const t = new PokerTable({ tableId: id, tableName: o.name ?? id, smallBlind: o.sb ?? 25, bigBlind: o.bb ?? 50, ante: 0, minBuyIn: o.minBuyIn ?? 1000 } as any);
    tables.set(id, t);
    return t;
  };
  const sockets = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const scope: Record<string, unknown> = {
    MAX_SEATS: 9, GamePhase, SEAT_RESERVE_MS: 6 * 3600_000, CASH_TABLE_TARGET_OCCUPIED: 5, DrawPhases: [], FiveCardDrawTable,
    tableManager: {
      getTable: (id: string) => tables.get(id),
      removeTable: (id: string) => tables.delete(id),
      getTableList: () => [...tables.keys()].map((tableId) => ({ tableId })),
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
    keepTournamentSeatOnLeave: () => false, shutdownFlushActive: () => false, Sentry: null, activateBombPotIfPending() {},
    tournamentDealWaitsForBustCheck: () => false,
    emitGameState() {}, getGameStateForPlayer: () => ({}), sanitizeSeatAvatar: () => undefined,
    // F109 (2026-10-21): startCareerGame reads the account's level (none loaded here = not refused).
    progressionManager: { getOrCreateProgress() {}, getClientProgress: () => null, userRecord: () => undefined },
    assertPlayable: async () => null, emitPlayRefusal: (s: any, r: any) => s.emit('error', { code: r.code }),
    isUserBanned: async () => false, buyInSocketGone: async () => false, blockedByMaintenance: () => false,
    quickPlayRateLimited: () => false, refuseCashJoinAtTournamentTable: (s: any) => s.emit('error', { code: 'tournament_table' }),
    seatNameForSocket: (s: any, n?: unknown) => accountDisplayName(authSessions.get(s.id)?.displayName ?? n),
    publicNameOf: (n: unknown) => String(n ?? ''),
    uuidv4: () => `u${++uid}`,
    generateRandomProfile: () => ({ botName: `Bot${++botN}` }),
    ensureChipsForBuyIn: async (u: number) => db.wallets.get(u) ?? 0,
    getUserChips: async (u: number) => db.wallets.get(u) ?? 0,
    UNLIMITED_CHIPS_TESTING: false,
    deductChips: async (u: number, amount: number) => {
      const have = db.wallets.get(u) ?? 0;
      if (have < amount) return false;
      db.wallets.set(u, have - amount);
      deductions.push({ uid: u, amount });
      return true;
    },
    addChipsToUser: async (u: number, amount: number) => {
      db.wallets.set(u, (db.wallets.get(u) ?? 0) + amount);
      credits.push({ uid: u, amount });
      return true;
    },
    auditLog: (_actor: string, action: string, d: any) => { audits.push({ action, d }); },
    resolveChallenge: async () => {},
    getClubTableById: async (id: number) => ({ id, clubId: 7, tableName: 'Club', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxSeats: 3, isActive: true, tableId: 'club1' }),
    isClubMember: async () => true,
    upsertCareerProgress: async (u: number, venue: number, stage: number, stars: number) => { careerProgress.push([u, venue, stage, stars]); },
    CAREER_VENUE_LEVELS,   // F109 (2026-10-21)
    claimCareerReward: async () => false,
    getPool: () => ({ connect: () => db.connect() }),
    createPrizeLedger, quickGameOutcome, spinGoMultiplierFor, createWindowRateLimiter, validateTableConfig,
    console: { log() {}, warn() {}, error() {} },
    log: { debug() {}, info() {}, warn() {} },
  };
  const handlers = { ...H, ...(opts.joinByInviteCode ? { joinByInviteCode: opts.joinByInviteCode } : {}) };
  const code = `
${BROKEN}
${WHO}
${opts.quick ?? QUICK}
${IS_TOURNAMENT_RESERVATION}
${CLUB_RUNTIME}
${opts.leave ?? LEAVE}
${SEAT_TEARDOWN_SRC}
${CREDIT_SEAT}
${opts.fill ?? FILL}
${HEARTBEAT}
${JOIN_PRECHECK_SRC}
function wire(socket) {
  ${Object.values(handlers).join('\n  ')}
}`;
  const { exports: m } = load(code, scope, `{ wire, quickGames, privateTableIds, clubTableIds, handlePlayerLeave, cleanupQuickTable,
    fillWithAI, trimExcessAI, ensureCashTableRunning, prizeLedger }`);

  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (id: string, userId: number, name: string) => {
    const handlersOf: Record<string, (...a: any[]) => any> = {};
    const rooms = new Set<string>();
    const s: any = {
      id, connected: true, handlers: handlersOf, rooms, handshake: { address: '100.64.0.1', headers: {} },
      on: (ev: string, fn: any) => { handlersOf[ev] = fn; },
      listeners: (ev: string) => (handlersOf[ev] ? [handlersOf[ev]] : []),
      emit: (ev: string, p: any) => { emitted.push([id, ev, p]); },
      join: (r: string) => rooms.add(r), leave: (r: string) => rooms.delete(r),
    };
    sockets.set(id, s);
    authSessions.set(id, { userId, username: `${name.toLowerCase()}.player`, masterUserId: `m-${userId}`, displayName: name });
    m.wire(s);
    return s;
  };
  const of = (id: string, ev: string) => emitted.filter(([sid, e]) => sid === id && e === ev).map(([, , p]) => p);
  return { m, scope, db, credits, deductions, audits, roomEmits, careerProgress, tables, mkTable, mkSocket, emitted, of, playerSessions };
}

/** Play the hand in progress out (every actor checks / calls, else folds). */
function playOut(t: PokerTable): void {
  for (let g = 0; g < 300 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
}
/** The hand boundary's bot step, as autoStartNextHand runs it on a ring table (trim, then fill). */
function handBoundary(w: ReturnType<typeof world>, tableId: string): void {
  const t = w.tables.get(tableId)!;
  playOut(t);
  w.m.trimExcessAI(t, tableId, 5);
  w.m.fillWithAI(t, tableId);
}
const seatMap = (t: PokerTable) => t.seats.map((s) => (s.state !== 'occupied' ? '.' : s.isAI ? 'B' : 'H')).join('');

/** The host creates a home game of `maxSeats` and takes his seat with its invite code (CreateTableModal's flow). */
async function hostHomeGame(w: ReturnType<typeof world>, maxSeats: number) {
  const host = w.mkSocket('SH', HOST, 'Host');
  await host.handlers.createPrivateTable({ tableName: 'Home', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxSeats });
  const { tableId, inviteCode } = w.of('SH', 'privateTableCreated')[0];
  await host.handlers.joinByInviteCode({ inviteCode, playerName: 'Host', buyIn: 1000 });
  return { tableId, inviteCode, t: w.tables.get(tableId)! };
}

describe('S1-1 / XL-1 / K3-1 — a home game seats its invitees up to its maxSeats (bots never take the last seat inside the cap)', () => {
  it.each([2, 3, 4, 5, 6])('maxSeats %i: the host sits, then every invitee is seated up to the cap — never refused for good, never a deduct-then-refund', async (maxSeats) => {
    const w = world();
    const { tableId, inviteCode, t } = await hostHomeGame(w, maxSeats);
    // The fill left a seat inside the cap open (a 2-seat game: no bot at all).
    expect(t.seats.slice(0, maxSeats).some((s) => s.state === 'empty')).toBe(true);
    expect(t.seats.slice(maxSeats).every((s) => s.state === 'empty')).toBe(true);
    for (let k = 0; k < maxSeats - 1; k++) {
      const sid = `SF${k}`;
      const f = w.mkSocket(sid, FRIENDS[k], `Friend${k}`);
      await f.handlers.joinByInviteCode({ inviteCode, playerName: `Friend${k}`, buyIn: 1000 });
      if (!w.playerSessions.has(sid)) {
        // Only ever "a seat opens when this hand ends" (every bot inside the cap is in the hand) — then it does.
        expect(w.of(sid, 'joinError')).toEqual([expect.objectContaining({ code: 'seat_opens_after_hand' })]);
        handBoundary(w, tableId);
        await f.handlers.joinByInviteCode({ inviteCode, playerName: `Friend${k}`, buyIn: 1000 });
      }
      expect(w.playerSessions.get(sid)).toMatchObject({ tableId });
      expect(w.playerSessions.get(sid).seatIndex).toBeLessThan(maxSeats);
    }
    // Host + every invitee seated inside the cap; nobody past it; no bot left.
    expect(seatMap(t).slice(0, maxSeats)).toBe('H'.repeat(maxSeats));
    expect(seatMap(t).slice(maxSeats)).toBe('.'.repeat(9 - maxSeats));
    // Each buy-in taken exactly once, none refunded; no refusal of a seat that could not be taken.
    expect(w.deductions).toHaveLength(maxSeats);
    expect(w.credits).toEqual([]);
    expect(w.emitted.filter(([, ev, p]) => ev === 'joinError' && /Could not seat you|Table is full/.test(p?.message))).toEqual([]);
    // One more is refused BEFORE any chip moves: 'Table is full.' (nothing can be freed).
    const extra = w.mkSocket('SX', FRIENDS[maxSeats], 'Extra');
    await extra.handlers.joinByInviteCode({ inviteCode, playerName: 'Extra', buyIn: 1000 });
    expect(w.of('SX', 'joinError')).toEqual([{ message: 'Table is full.', code: 'table_full' }]);
    expect(w.deductions).toHaveLength(maxSeats);
  });

  it('a capped table trims to cap - 1 at the hand boundary (one seat inside the cap stays free); a 9-seat table still keeps 5', () => {
    const w = world();
    const small = w.mkTable('s4'); small.maxOccupiableSeats = 4;
    small.sitDown(0, 'Host', 1000, 'p-h', false);
    for (let i = 1; i < 4; i++) small.sitDown(i, `Bot${i}`, 1000, `ai-${i}`, true);
    w.m.trimExcessAI(small, 's4', 5);
    expect(seatMap(small).slice(0, 4).split('').filter((c) => c !== '.').length).toBe(3);
    const big = w.mkTable('b9');
    big.sitDown(0, 'Human', 1000, 'p-x', false);
    w.m.fillWithAI(big, 'b9');
    expect(big.getOccupiedSeatCount()).toBe(5);
    w.m.trimExcessAI(big, 'b9', 5);
    expect(big.getOccupiedSeatCount()).toBe(5);
  });

  it('a 3-seat CLUB table: the no-human heartbeat leaves a seat open, and two members are both seated through joinClubTable', async () => {
    const w = world();
    const t = w.mkTable('club1'); t.maxOccupiableSeats = 3;
    w.m.clubTableIds.add('club1');
    w.m.ensureCashTableRunning('club1');                         // heartbeat floor of 3 — never fills the cap solid
    expect(t.seats.slice(0, 3).filter((s) => s.state === 'occupied').length).toBe(2);
    for (const [k, uidK] of [[0, FRIENDS[0]], [1, FRIENDS[1]]] as const) {
      w.scope.clientIp = `198.51.100.${k + 1}`;                     // two members, two networks
      const sid = `SM${k}`;
      const s = w.mkSocket(sid, uidK, `Member${k}`);
      await s.handlers.joinClubTable({ clubTableId: 3, playerName: `Member${k}`, seatIndex: -1, buyIn: 0 });
      await flush();
      if (!w.playerSessions.has(sid)) {
        expect(w.of(sid, 'error')).toEqual([expect.objectContaining({ code: 'no_seat_available' })]);
        handBoundary(w, 'club1');
        await s.handlers.joinClubTable({ clubTableId: 3, playerName: `Member${k}`, seatIndex: -1, buyIn: 0 });
        await flush();
      }
      expect(w.playerSessions.get(sid)).toMatchObject({ tableId: 'club1' });
      expect(w.playerSessions.get(sid).seatIndex).toBeLessThan(3);
    }
    expect(w.credits).toEqual([]);                                  // no deduct-then-refund
    expect(w.deductions.map((d) => d.amount)).toEqual([1000, 1000]); // buyIn 0 = the table minimum
  });

  it('CONTROL — the pre-R3 fill and seat pick: a 4-seat home game fills with bots and its invitee is deducted, refused and refunded', async () => {
    const preFill = FILL
      .split('for (let i = 0; i < seatCap; i++)').join('for (let i = 0; i < MAX_SEATS; i++)')
      .replace(/\n  targetMaxOccupied = Math\.max\(0, Math\.min\(targetMaxOccupied, [^\n]*\n/, '\n')
      .replace('emptySeats.slice(0, Math.min(needed, Math.max(0, emptySeats.length - 1)))', 'emptySeats.slice(0, needed)');
    const prePick = H.joinByInviteCode.replace(
      "let openSeat = table.seats.findIndex((s, i) => s.state === 'empty' && i < inviteSeatCap);\n    if (openSeat === -1) openSeat = takeAiSeatForJoin(table, tableId);",
      "let openSeat = table.seats.findIndex((s) => s.state === 'empty');",
    // 2026-10-21 (gameplay F143) — the pre-leave seat lookup (inside the cap) is the R3 rule too: not in the pre-R3 text.
    ).replace(
      "    if (!table.seats.some((s, i) => i < inviteSeatCap && (s.state === 'empty' || aiSeatTakeableNow(table, i)))\n        && !accountHoldsSeatAt(socket.id, authAtInvite?.userId, tableId)) {",
      '    if (false) {',
    );
    expect(prePick).not.toBe(H.joinByInviteCode);
    expect(prePick).toContain('    if (false) {');
    const w = world({ fill: preFill, joinByInviteCode: prePick });
    const { inviteCode, t } = await hostHomeGame(w, 4);
    expect(seatMap(t).slice(0, 4)).toBe('HBBB');                    // every seat inside the cap taken
    const f = w.mkSocket('SF', FRIENDS[0], 'Friend');
    await f.handlers.joinByInviteCode({ inviteCode, playerName: 'Friend', buyIn: 1000 });
    expect(w.of('SF', 'joinError')).toEqual([{ message: 'Could not seat you at that table.' }]);
    expect(w.deductions.filter((d) => d.uid === FRIENDS[0])).toEqual([{ uid: FRIENDS[0], amount: 1000 }]);
    expect(w.credits).toEqual([{ uid: FRIENDS[0], amount: 1000 }]);
  });
});

/** End the hand in progress with these final stacks (seat -> chips), then emit handResult like determineWinners. */
function finishHand(t: PokerTable, stacks: Record<number, number>): void {
  for (const [i, c] of Object.entries(stacks)) { t.seats[Number(i)].chipCount = c; t.seats[Number(i)].totalInvestedThisHand = 0; }
  (t as any).currentPhase = GamePhase.HandComplete;
  t.emit('handResult', { results: [], handNumber: t.handNumber });
}

describe('S1-4 — a DECIDED quick game is settled before the leaving seat (or the cleanup) tears it down', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.useRealTimers(); });

  async function decidedSpinGo(w: ReturnType<typeof world>) {
    const s = w.mkSocket('S1', HOST, 'Host');
    jest.spyOn(Math, 'random').mockReturnValue(0.5);                  // 2x
    await s.handlers.quickSpinGo({ playerName: 'Host' });
    (Math.random as any).mockRestore?.();
    const tableId = w.playerSessions.get('S1').tableId;
    jest.advanceTimersByTime(3500);
    finishHand(w.tables.get(tableId)!, { 0: 1500, 1: 0, 2: 0 });     // he busts both bots: decided, won
    expect(w.m.quickGames.get(tableId)).toMatchObject({ decided: { winnerSeat: 0, humanWon: true }, settlement: 'open' });
    jest.advanceTimersByTime(300);                                   // inside the 1 s result delay
    return { s, tableId };
  }

  it('Spin & Go: he wins the last hand and taps Leave within 1 s → the prize is PAID (no forfeit), the result shown', async () => {
    const w = world();
    const { s, tableId } = await decidedSpinGo(w);
    await s.handlers.leaveTable();
    await flush();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect([...w.db.payouts.keys()]).toEqual([`spingo:${tableId}:prize`]);
    expect(w.db.payouts.get(`spingo:${tableId}:prize`)).toMatchObject({ userId: HOST, amount: 1000, kind: 'SPINGO_PRIZE' });
    expect(w.audits.map((a) => a.action)).not.toContain('SPINGO_FORFEIT');
    expect(w.roomEmits.filter(([, ev]) => ev === 'quickGameOver').map(([, , p]) => p)).toEqual([expect.objectContaining({ type: 'spinGo', won: true, prize: 1000 })]);
    expect(w.tables.has(tableId)).toBe(false);                       // the table still goes
  });

  it('CONTROL — without the settle-first step the same leave FORFEITS the won Spin & Go: no prize, no result', async () => {
    const preLeave = LEAVE.replace('  settleDecidedQuickGame(session.tableId);\n', '');
    const preQuick = QUICK.replace('  settleDecidedQuickGame(tableId);\n  const table = tableManager.getTable(tableId);', '  const table = tableManager.getTable(tableId);');
    expect([preLeave === LEAVE, preQuick === QUICK]).toEqual([false, false]);
    const w = world({ leave: preLeave, quick: preQuick });
    const { s } = await decidedSpinGo(w);
    await s.handlers.leaveTable();
    await flush();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(w.db.payouts.size).toBe(0);
    expect(w.audits.map((a) => a.action)).toContain('SPINGO_FORFEIT');
    expect(w.roomEmits.filter(([, ev]) => ev === 'quickGameOver')).toEqual([]);
  });

  it('Spin & Go: the cleanup backstop settles a decided game first (paid once, even with its own timer later)', async () => {
    const w = world();
    const { tableId } = await decidedSpinGo(w);
    w.m.cleanupQuickTable(tableId);
    await flush();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect([...w.db.payouts.keys()]).toEqual([`spingo:${tableId}:prize`]);
    expect(w.db.wallets.get(HOST)).toBe(1_000_000 - 500 + 1000);
  });

  it('career: he wins the stage and taps Leave within 1 s → the stage win is recorded (careerGameComplete, progress) AND his stack cashed once', async () => {
    const w = world();
    const s = w.mkSocket('S1', HOST, 'Host');
    await s.handlers.startCareerGame({ venue: 0, stage: 0 });
    const tableId = w.playerSessions.get('S1').tableId;
    const t = w.tables.get(tableId)!;
    const bots = t.seats.filter((x) => x.state === 'occupied' && x.isAI).map((x) => x.seatIndex);
    finishHand(t, { 0: 4000, ...Object.fromEntries(bots.map((i) => [i, 0])) });
    // F105 (2026-10-21): the decision carries the winner's name + stack read before any seat is stood up.
    expect(w.m.quickGames.get(tableId)?.decided).toEqual({ winnerSeat: 0, humanWon: true, winnerName: 'Host', winnerChips: 4000 });
    jest.advanceTimersByTime(300);
    await s.handlers.leaveTable();
    await flush();
    jest.advanceTimersByTime(10_000);
    await flush();
    // F108 (2026-10-21): + tableId (the client marks THAT table left).
    expect(w.of('S1', 'careerGameComplete')).toEqual([{ venue: 0, stage: 0, won: true, stars: 3, tableId }]);
    expect(w.careerProgress).toEqual([[HOST, 0, 0, 3]]);
    expect(w.credits).toEqual([{ uid: HOST, amount: 4000 }]);      // cashed exactly once
  });
});

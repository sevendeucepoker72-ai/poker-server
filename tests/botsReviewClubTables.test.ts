/**
 * Bots review 2026-11-04 — club runtime tables.
 *
 * C7: 'getClubTables' had no auth / membership check, and it (re)created every
 *     listed club table's runtime table and re-pointed club_tables.tableid
 *     (ensureClubRuntimeTable → updateClubTableId). Any socket, signed in or
 *     not, could spin up a club's tables — each then sat at the heartbeat's bot
 *     floor. The LIST stays open (owner call: low sensitivity, no caller needs
 *     it closed; the only caller, poker-3d ClubsPanel, opens clubs from
 *     getMyClubs); only the re-create side effect is gated to active members.
 * C8: a club table nobody sits at keeps its bot floor (a member who sits down
 *     finds the same table) but is never DEALT bots-only — not by the 12 s
 *     heartbeat (ensureCashTableRunning) and not by a loop already running
 *     (autoStartNextHand). A member's join deals as before.
 *
 * REAL src/index.ts text (sliced + transpiled) on the REAL PokerTable; the club
 * data layer is the real clubManager on an in-memory Postgres stand-in.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { generateRandomProfile } from '../src/ai/AIPlayer';
import { validateTableConfig } from '../src/game/tableConfigValidation';
import { slice, fnSrc, handlerSrc, load, flush } from './helpers/indexSource';
import { createFakePokerDb } from './helpers/fakePokerDb';

const mockDb: { current: any } = { current: null };
jest.mock('../src/auth/authManager', () => ({ getPool: () => mockDb.current.pool }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const clubs = require('../src/clubs/clubManager');

const OWNER = 1;
const MEMBER = 101;
const OUTSIDER = 999;
const quiet = { log() {}, warn() {}, error() {} };

// ───────────────────────────── C7 — getClubTables ─────────────────────────────
const CLUB_TABLES = slice('// ========== Club tables survive a redeploy (R2, CLUBS-4) ==========', '\n  return job;\n}\n');
const GET_CLUB_TABLES = handlerSrc('getClubTables', '\n  });\n');

function listWorld() {
  const d = createFakePokerDb({ [OWNER]: 10_000, [MEMBER]: 10_000, [OUTSIDER]: 10_000 });
  d.clubs.set(7, { id: 7, name: 'Pub Club' });
  d.members.push({ clubid: 7, userid: OWNER, role: 'owner', status: 'active' }, { clubid: 7, userid: MEMBER, role: 'member', status: 'active' });
  d.clubTables.set(11, {
    id: 11, clubid: 7, tablename: 'Friday Night', variant: 'texas-holdem', smallblind: 25, bigblind: 50, minbuyin: 1000,
    maxbuyin: 5000, maxseats: 6, isactive: 1, tableid: 'dead-after-redeploy',
  } as any);
  mockDb.current = d;
  const runtime = new Map<string, any>();
  const created: any[] = [];
  const authSessions = new Map<string, any>();
  let n = 0;
  const updates: Array<[number, string]> = [];
  const scope: Record<string, unknown> = {
    ...clubs,
    updateClubTableId: async (id: number, tid: string) => { updates.push([id, tid]); return clubs.updateClubTableId(id, tid); },
    authSessions,
    tableManager: {
      getTable: (id: string) => runtime.get(id),
      createTable: (cfg: any) => { const id = `rt${++n}`; created.push(cfg); runtime.set(id, { maxOccupiableSeats: 9, seats: [] }); return id; },
      createVariantTable: (cfg: any) => { const id = `rv${++n}`; created.push(cfg); runtime.set(id, { maxOccupiableSeats: 9, seats: [] }); return id; },
      removeTable: (id: string) => runtime.delete(id),
    },
    tableHasHumanSeat: (t: any) => t.seats.some((s: any) => s.state === 'occupied' && !s.isAI),
    clubTableIds: new Set<string>(), clubIdByTable: new Map<string, number>(), validateTableConfig, console: quiet,
  };
  const { exports: m, stubbed } = load(`${CLUB_TABLES}\nfunction wire(socket) {\n  ${GET_CLUB_TABLES}\n}`, scope,
    '{ wire, clubTableRuntimeStats }');
  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (id: string, userId: number | null) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = { id, handlers, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, p: any) => emitted.push([id, ev, p]) };
    if (userId !== null) authSessions.set(id, { userId, username: `u${userId}` });
    m.wire(s);
    return s;
  };
  const of = (sid: string, ev: string) => emitted.filter(([s, e]) => s === sid && e === ev).map(([, , p]) => p);
  return { d, m, stubbed, runtime, created, updates, mkSocket, of };
}

describe('C7 — getClubTables re-creates runtime tables for active MEMBERS only; the list stays open', () => {
  it('(1) a signed-in non-member and a signed-out socket get the same list, with 0 runtime tables created and no club_tables re-point (0dc1b96: they created them)', async () => {
    const w = listWorld();
    const outsider = w.mkSocket('SX', OUTSIDER);
    const anon = w.mkSocket('SN', null);
    await outsider.handlers.getClubTables({ clubId: 7 });
    await anon.handlers.getClubTables({ clubId: 7 });
    await flush();
    const listX = w.of('SX', 'clubTables');
    const listN = w.of('SN', 'clubTables');
    expect(listX).toHaveLength(1);
    expect(listX[0]).toMatchObject({ success: true, tables: [expect.objectContaining({ id: 11, tableName: 'Friday Night', smallBlind: 25, bigBlind: 50 })] });
    expect(listN).toEqual(listX);
    expect(w.created).toEqual([]);
    expect(w.runtime.size).toBe(0);
    expect(w.updates).toEqual([]);
    expect(w.d.clubTables.get(11)!.tableid).toBe('dead-after-redeploy');
    expect(w.m.clubTableRuntimeStats).toMatchObject({ recreated: 0, recreateSkippedNotMember: 2 });
    expect([...w.stubbed].filter((s) => /isClubMember|authSessions|clubTableRuntimeStats|ensureClubRuntimeTable/.test(s))).toEqual([]);
  });

  it('GUARD (passes at 0dc1b96 too) — an active member still re-creates the table for the list (a joinable id), as before', async () => {
    const w = listWorld();
    const member = w.mkSocket('SM', MEMBER);
    await member.handlers.getClubTables({ clubId: 7 });
    await flush();
    const listed = w.of('SM', 'clubTables')[0].tables[0];
    expect(w.runtime.has(listed.tableId)).toBe(true);
    expect(w.created).toHaveLength(1);
    expect(w.updates).toEqual([[11, listed.tableId]]);
    expect(w.m.clubTableRuntimeStats.recreated).toBe(1);
  });

  it('a non-member whose club tables are all live: nothing counted (nothing would have been created)', async () => {
    const w = listWorld();
    const member = w.mkSocket('SM', MEMBER);
    await member.handlers.getClubTables({ clubId: 7 });
    const outsider = w.mkSocket('SX', OUTSIDER);
    await outsider.handlers.getClubTables({ clubId: 7 });
    await flush();
    expect(w.created).toHaveLength(1);
    expect(w.m.clubTableRuntimeStats.recreateSkippedNotMember).toBe(0);
  });
});

// ─────────────────────── C8 — an idle club table is not dealt ───────────────────────
const T = 'club-1';
const AUTO_START = fnSrc('function autoStartNextHand(');
const CODE = [
  slice('const LIVE_ROOM_MIN_OCCUPIED = 3;', 'const heartbeatRestarts = { handComplete: 0 };'),
  slice('const heartbeatRestartsWithHuman = ', ';\n'),
  slice('const clubTableRuntimeStats = ', ';\n'),
  fnSrc('function backfillAIToMin('),
  fnSrc('function ensureCashTableRunning('),
  fnSrc('function trimExcessAI('),
  fnSrc('function fillWithAI('),
  fnSrc('function aiSeatsMutableNow('),
  fnSrc('function tableHasHumanSeat('),
  slice('const BOT_STACK_CAP_BUYINS: number = ', '  return isFixedRosterTable(tableId);\n}\n'),
  fnSrc('function isFixedRosterTable('),
  AUTO_START,
  slice('const CASH_START_RETRY_FIRST_MS = 1500;', '\n}\n'),
].join('\n');

function dealWorld(kind: 'club' | 'public' | 'private', seatCap = 3) {
  const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
  table.maxOccupiableSeats = seatCap;
  const pendingAutoStartTimers = new Map<string, NodeJS.Timeout>();
  const logs: string[] = [];
  let deals = 0;
  const realStart = table.startNewHand.bind(table);
  (table as any).startNewHand = () => { deals++; return realStart(); };
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
    pendingAutoStartTimers, quickTables: new Set(), privateTableIds: new Set(kind === 'private' ? [T] : []),
    clubTableIds: new Set(kind === 'club' ? [T] : []),
    careerTables: new Map(), spinGoMultipliers: new Map(), allInOrFoldTables: new Set(), challengeTables: new Map(),
    tournamentTables: new Map(), brokenTournamentTables: new Map(), isTournamentTable: () => false, aiProfiles: new Map(),
    playerSessions: new Map(), multiTableSessions: new Map(), dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [],
    tournamentManager: { getTournament: () => undefined }, CASH_TABLE_TARGET_OCCUPIED: 5, MAX_SEATS, GamePhase, generateRandomProfile,
    uuidv4: () => Math.random().toString(36).slice(2), ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {},
    activateBombPotIfPending() {}, log: { debug() {}, info() {} },
    console: { log: (s: string) => logs.push(s), warn: (s: string) => logs.push(`WARN ${s}`), error: (s: string) => logs.push(`ERR ${s}`) },
  };
  const { exports: m, stubbed } = load(CODE, scope,
    '{ autoStartNextHand, ensureCashTableRunning, clubTableRuntimeStats, cashStartRefusals, heartbeatRestarts }');
  return { table, m, stubbed, logs, pendingAutoStartTimers, deals: () => deals };
}
const seats = (t: PokerTable) => t.seats.map((s) => (s.state !== 'occupied' ? '.' : s.isAI ? 'B' : 'H')).join('');
const playOut = (t: PokerTable) => {
  for (let g = 0; g < 400 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
};

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('C8 — a club table nobody sits at keeps its bot floor but is never dealt bots-only', () => {
  it('(2) the heartbeat on an empty 3-seat club table (WaitingForPlayers): bots backfilled inside cap-1, NOT dealt (0dc1b96: it dealt)', () => {
    const w = dealWorld('club', 3);
    w.m.ensureCashTableRunning(T);
    expect(seats(w.table)).toBe('BB.......');                 // the floor, one seat kept free for a member
    expect(w.deals()).toBe(0);
    expect(w.table.currentPhase).toBe(GamePhase.WaitingForPlayers);
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    w.m.ensureCashTableRunning(T);
    expect(w.deals()).toBe(0);
    expect([...w.stubbed].filter((s) => /clubTable|tableHasHumanSeat|startNewHand|autoStart/.test(s))).toEqual([]);
  });

  it('(2) the heartbeat on a bot-only club table resting in HandComplete: no autoStartNextHand, no deal', () => {
    const w = dealWorld('club', 3);
    w.table.sitDown(0, 'Bot0', 1000, 'ai-0', true);
    w.table.sitDown(1, 'Bot1', 1000, 'ai-1', true);
    expect(w.table.startNewHand()).toBe(true);
    playOut(w.table);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    const before = w.deals();
    w.m.ensureCashTableRunning(T);
    expect(w.deals()).toBe(before);
    expect(w.m.heartbeatRestarts.handComplete).toBe(0);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
  });

  it('(3) a running bot-only loop (the last human was admin-removed): autoStartNextHand at HandComplete does not deal, idleDealsSkipped=1, no refusal logged or re-tried (0dc1b96: it dealt bots-only)', () => {
    const w = dealWorld('club', 3);
    w.table.sitDown(0, 'Alice', 5000, 'h-a', false);
    w.table.sitDown(1, 'Bot1', 1000, 'ai-1', true);
    expect(w.table.startNewHand()).toBe(true);
    playOut(w.table);
    w.table.standUp(0);                                         // admin removal: no bot strip on that path
    const before = w.deals();
    w.m.autoStartNextHand(T);
    expect(w.deals()).toBe(before);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.m.clubTableRuntimeStats.idleDealsSkipped).toBe(1);
    expect(w.m.cashStartRefusals).toMatchObject({ refused: 0, rescheduled: 0 });
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    expect(w.logs.filter((l) => l.includes('cash_hand_start_refused'))).toEqual([]);
  });

  it('GUARD (passes at 0dc1b96 too) — (3)/(4) with a member seated the same step deals; the heartbeat deals a club table a human sits at', () => {
    const w = dealWorld('club', 3);
    w.table.sitDown(0, 'Alice', 5000, 'h-a', false);
    w.table.sitDown(1, 'Bot1', 1000, 'ai-1', true);
    expect(w.table.startNewHand()).toBe(true);
    playOut(w.table);
    const before = w.deals();
    w.m.autoStartNextHand(T);
    expect(w.deals()).toBe(before + 1);
    expect(w.table.isHandInProgress()).toBe(true);
    const w2 = dealWorld('club', 3);
    w2.table.sitDown(0, 'Alice', 5000, 'h-a', false);
    w2.m.ensureCashTableRunning(T);                             // backfill to the floor, then the deal
    expect(w2.deals()).toBe(1);
    expect(w2.table.isHandInProgress()).toBe(true);
  });

  it('GUARD (passes at 0dc1b96 too) — (5) a PUBLIC table with no human is still dealt by the heartbeat (unchanged)', () => {
    const w = dealWorld('public', 9);
    w.m.ensureCashTableRunning(T);
    expect(w.deals()).toBe(1);
    expect(w.table.isHandInProgress()).toBe(true);
  });

  it('GUARD (passes at 0dc1b96 too) — (6) a PRIVATE table nobody sits at: the existing rule (no bots, no deal) is unchanged', () => {
    const w = dealWorld('private', 6);
    w.m.ensureCashTableRunning(T);
    expect(seats(w.table)).toBe('.........');
    expect(w.deals()).toBe(0);
  });
});

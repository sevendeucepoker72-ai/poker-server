/**
 * Gameplay audit 2026-10-21 — cluster S8 (tournaments), on the REAL engine,
 * TournamentManager / TableManager and the real index.ts source (sliced).
 *
 *   F90  a single-table tournament (startTournamentGame, 9 or fewer entrants:
 *        every lobby template) deals again after a director Pause + Resume —
 *        the resume loop read `tableIds`, which only multi-table starts fill.
 *   F94  the Live Bracket of a single-table tournament shows the LIVE stacks
 *        (its players are not in playerTableMap: the table is `tableId`).
 *   F96  a custom / club structure's LEVEL-1 ante is posted from hand 1
 *        (tables were created with ante 0 until the first level-up).
 *   F97  the Live Bracket reads a re-entered player's LIVE seat, never his old
 *        busted seat with the same playerId.
 *   F99  the last human leaving a tournament table never strips its bots (they
 *        are entrants with stacks the tournament counts alive).
 *   G185 Admin Force Close is refused on a running tournament table (it stood
 *        every alive entrant up without eliminating him: the event wedged).
 *   (F95 lives in r2Qualifiers.test.ts; F92, F98, G186 and an end-to-end F99
 *   in rebalanceSafety.test.ts — their harnesses are there.)
 *
 * Every test fails on the pre-fix code (the old outcome is quoted inline, or
 * a CONTROL runs the pre-fix source).
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { TableManager } from '../src/game/TableManager';
import { SRC, slice, fnSrc, handlerSrc, load, flush, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };

type FakeSocket = {
  id: string; connected: boolean; rooms: Set<string>; handlers: Record<string, (...a: any[]) => any>;
  emitted: Array<[string, any]>; emit: (ev: string, p?: any) => void; on: (ev: string, fn: any) => void;
  join: (r: string) => void; leave: (r: string) => void;
};
function fakeSocket(id: string): FakeSocket {
  const s: FakeSocket = {
    id, connected: true, rooms: new Set(), handlers: {}, emitted: [],
    emit: (ev, p) => { s.emitted.push([ev, p]); },
    on: (ev, fn) => { s.handlers[ev] = fn; },
    join: (r) => { s.rooms.add(r); }, leave: (r) => { s.rooms.delete(r); },
  };
  return s;
}
const events = (s: FakeSocket, ev: string) => s.emitted.filter(([e]) => e === ev).map(([, p]) => p);
function without(src: string, part: string, by = ''): string {
  expect(src).toContain(part);
  return src.replace(part, by);
}
function foldOut(t: PokerTable): void {
  for (let g = 0; g < 20 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// ═════════════════════════════════════════ tournament start + director pause ══
// 2026-10-24 (Sit & Go fix-all F6) — + drawSeatOrder (the random seat draw; the scope's randomInt is the real crypto one).
const START = fnSrc('function startTournamentGame(') + '\n' + fnSrc('function startRegisteredTournamentTables(') + '\n' + fnSrc('function drawSeatOrder(');
// 2026-10-23 (qualifier lifecycle S3) — the handler's body is applyDirectorPause
// (shared with POST /api/qualifiers/pause): the slice carries both, and the
// F90 loop now sits in the top-level helper (two-space indent).
const PAUSE = fnSrc('function applyDirectorPause(') + '\n' + handlerSrc('pauseTournament', '\n  });\n');
const NEW_PAUSE_LOOP = '  const pauseTableIds = tourn?.tableIds?.length ? tourn.tableIds : (tourn?.tableId ? [tourn.tableId] : []);\n  for (const tid of pauseTableIds) {';
const OLD_PAUSE_LOOP = '  for (const tid of tourn?.tableIds || []) {';

const LEVELS = [{ sb: 10, bb: 20, ante: 0, duration: 600 }, { sb: 20, bb: 40, ante: 0, duration: 600 }];

function startWorld(opts: { pause?: string; levels?: any[]; entrants?: number; maxPlayers?: number } = {}) {
  const tm = new TournamentManager();
  const tableManager = new TableManager();
  const tournamentTables = new Map<string, string>();
  const roomEmits: Array<[string, string, any]> = [];
  const scheduled: string[] = [];
  const authSessions = new Map<string, any>([['ADMIN', { userId: 1, username: 'admin' }]]);
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tableManager, tournamentTables, authSessions,
    isUserAdmin: async () => true, auditLog() {}, broadcastTournamentList() {},
    io: { to: (room: string) => ({ emit: (ev: string, d: any) => roomEmits.push([room, ev, d]) }), sockets: { sockets: new Map() } },
    bindRegistrantSocket: () => '',   // every start seat absent (no live socket) — the table still deals
    notifyPlayer: async () => {}, ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {},
    bootstrapTournamentTables() {}, scheduleAutoStart: (id: string) => { scheduled.push(id); },
    userIdForSeat: () => undefined, console: quiet,
    randomInt: require('crypto').randomInt,   // F6
  };
  const pause = opts.pause ?? PAUSE;
  const { exports: m } = load(`${START}\nfunction wire(socket) {\n${pause}\n}`, scope, '{ startTournamentGame, wire }');
  const tid = tm.createTournament({
    name: 'Sit & Go', buyIn: 0, prizePool: 0, maxPlayers: opts.maxPlayers ?? 9, startInterval: 0, blindLevels: opts.levels ?? LEVELS,
  } as any);
  const n = opts.entrants ?? 3;
  for (let i = 0; i < n; i++) expect(tm.registerPlayer(tid, `p${i}`, `P${i}`, `reg-${i}`)).toBeTruthy();
  m.startTournamentGame(tid);
  const admin = fakeSocket('ADMIN');
  m.wire(admin);
  return { tm, tid, tableManager, tournamentTables, roomEmits, scheduled, admin };
}

describe('F90 — a single-table tournament deals again after a director Pause + Resume', () => {
  async function pauseHandResume(pause?: string) {
    const w = startWorld({ pause });
    const t = w.tm.getTournament(w.tid)!;
    // The single-table start: tableId only — tableIds stays empty (unchanged).
    expect(t.tableIds).toEqual([]);
    const T = w.tableManager.getTable(t.tableId!)!;
    expect(T.isHandInProgress()).toBe(true);
    await w.admin.handlers.pauseTournament({ tournamentId: w.tid, paused: true });
    foldOut(T);                                                                  // the hand ends while paused: held at the boundary
    await w.admin.handlers.pauseTournament({ tournamentId: w.tid, paused: false });
    return { w, T, tableId: t.tableId! };
  }

  it('Resume re-kicks the table (scheduleAutoStart) and its room is told paused, then resumed', async () => {
    const { w, tableId } = await pauseHandResume();
    expect(w.tm.getTournament(w.tid)!.paused).toBe(false);
    expect(w.scheduled).toEqual([tableId]);
    expect(w.roomEmits.map(([room, ev]) => [room, ev])).toEqual([
      [`table:${tableId}`, 'tournamentPaused'], [`table:${tableId}`, 'tournamentResumed'],
    ]);
  });

  it('CONTROL — the pre-F90 loop over tableIds: nothing re-kicked, nobody told (the table sat in HandComplete for good)', async () => {
    const { w, T } = await pauseHandResume(without(PAUSE, NEW_PAUSE_LOOP, OLD_PAUSE_LOOP));
    expect(w.scheduled).toEqual([]);
    expect(w.roomEmits).toEqual([]);
    expect(T.currentPhase).toBe(GamePhase.HandComplete);
  });
});

describe('F94 — the Live Bracket of a single-table tournament shows the live stacks', () => {
  it('after a hand, every alive player\'s chipCount is his seat\'s stack (it was the starting 1000 for everyone)', () => {
    const w = startWorld();
    const t = w.tm.getTournament(w.tid)!;
    const T = w.tableManager.getTable(t.tableId!)!;
    foldOut(T);
    const live = new Map(T.seats.filter((s) => s.state === 'occupied').map((s) => [s.playerId, s.chipCount]));
    expect(new Set(live.values()).size).toBeGreaterThan(1);                     // the blinds moved chips
    const st = w.tm.getTournamentStandings(w.tid, w.tableManager)!;
    expect(st.players.map((p) => [p.playerId, p.chipCount])).toEqual(t.players.map((p) => [p.playerId, live.get(p.playerId)]));
    // Old: [['p0', 1000], ['p1', 1000], ['p2', 1000]].
    expect(st.players.every((p) => p.chipCount === 1000)).toBe(false);
  });
});

describe('F96 — a structure\'s LEVEL-1 ante is posted from the first hand', () => {
  const ANTE_LEVELS = [{ sb: 25, bb: 50, ante: 50, duration: 600 }, { sb: 50, bb: 100, ante: 100, duration: 600 }];

  it('single-table start: the table carries ante 50 and hand 1 takes it from every seat (old: ante 0, only the blinds: 75 in the pot)', () => {
    const w = startWorld({ levels: ANTE_LEVELS });
    const T = w.tableManager.getTable(w.tm.getTournament(w.tid)!.tableId!)!;
    expect(T.config.ante).toBe(50);
    expect(T.isHandInProgress()).toBe(true);
    const invested = T.seats.filter((s) => s.state === 'occupied').map((s) => s.totalInvestedThisHand);
    expect(invested.reduce((a, b) => a + b, 0)).toBe(3 * 50 + 25 + 50);
    expect(invested.every((x) => x >= 50)).toBe(true);
  });

  it('multi-table start (more than 9 registrants): every table carries the level-1 ante', () => {
    const w = startWorld({ levels: ANTE_LEVELS, entrants: 12, maxPlayers: 18 });
    const t = w.tm.getTournament(w.tid)!;
    expect(t.tableIds).toHaveLength(2);
    expect(t.tableIds.map((id) => w.tableManager.getTable(id)!.config.ante)).toEqual([50, 50]);
  });

  it('every other createQuickTable caller (quick / cash) keeps ante 0; a variant table gets the ante too', () => {
    const tm = new TableManager();
    expect(tm.getTable(tm.createQuickTable('Heads-Up', 2, 10, 20, 1000))!.config.ante).toBe(0);
    expect(tm.getTable(tm.createQuickTable('T', 9, 25, 50, 1000, undefined, 50))!.config.ante).toBe(50);
    expect(tm.getTable(tm.createQuickTable('O', 9, 25, 50, 1000, 'omaha', 25))!.config.ante).toBe(25);
    expect(tm.getTable(tm.createQuickTable('N', 9, 25, 50, 1000, undefined, -5))!.config.ante).toBe(0);
  });

  it('wiring: all four tournament starts pass the level-1 ante', () => {
    for (const sig of ['function startTournamentGame(', 'function startRegisteredTournamentTables(', 'function startQualifierTournament(', 'function startMultiTableTournament(']) {
      const body = fnSrc(sig);
      expect(body).toMatch(/createQuickTable\([\s\S]*?undefined,\s*blinds\.ante/);
    }
  });
});

describe('F97 — the Live Bracket reads a re-entered player\'s LIVE seat', () => {
  it('re-entered at seat 3 of the same table (his busted seat 0 still occupied, 0 chips): 50,000, not 0', () => {
    const tm = new TournamentManager();
    const tid = tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: LEVELS, startingChips: 50_000 } as any);
    for (const [id, n] of [['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl']]) tm.registerPlayer(tid, id, n, `s-${id}`);
    tm.startTournament(tid);
    const Q1 = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    Q1.sitDown(0, 'Alice', 50_000, 'alice', false, true);
    Q1.sitDown(1, 'Bob', 100_000, 'bob', false, true);
    Q1.sitDown(2, 'Carl', 50_000, 'carl', false, true);
    tm.setTableIds(tid, ['Q1']);
    for (const id of ['alice', 'bob', 'carl']) tm.setPlayerTable(tid, id, 'Q1');
    // Alice busts: her seat stays occupied, eliminated, 0 chips (the bust check's end state).
    Q1.seats[0].chipCount = 0;
    Q1.seats[0].eliminated = true;
    tm.eliminatePlayer(tid, 'alice');
    // …and re-enters on the first empty seat of the same table.
    expect(Q1.sitDown(3, 'Alice', 50_000, 'alice', false)).toBe(true);
    tm.setPlayerTable(tid, 'alice', 'Q1');
    expect(tm.reinstateForReentry(tid, 'alice', 50_000)).toBe(true);
    const tables = { getTable: (id: string) => (id === 'Q1' ? Q1 : undefined) };
    const st = tm.getTournamentStandings(tid, tables)!;
    // Old: [['alice', 0, null], …].
    expect(st.players.map((p) => [p.playerId, p.chipCount, p.finishPosition])).toEqual([['alice', 50_000, null], ['bob', 100_000, null], ['carl', 50_000, null]]);
    // A bust the check has not settled yet (0 chips, not eliminated) still shows 0.
    Q1.seats[2].chipCount = 0;
    expect(tm.getTournamentStandings(tid, tables)!.players.find((p) => p.playerId === 'carl')!.chipCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════ bots strip ══
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const STRIP_GUARD = '  if (isTournamentTable(tableId)) {\n    botStripAfterHand.delete(tableId);\n';
const STRIP_GUARD_OFF = '  if (false) {\n    botStripAfterHand.delete(tableId);\n';

describe('F99 — the last human leaving a TOURNAMENT table never strips its bots (they are entrants)', () => {
  function stripWorld(teardown = SEAT_TEARDOWN_SRC) {
    const tables = new Map<string, PokerTable>();
    const tournamentTables = new Map<string, string>([['T1', 'tour-1']]);
    const scope: Record<string, unknown> = {
      tournamentTables, tableManager: { getTable: (id: string) => tables.get(id) }, GamePhase, MAX_SEATS,
      aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), SEAT_RESERVE_MS: 6 * 3600_000,
      console: quiet,
    };
    const { exports: m } = load(`${BROKEN}\n${teardown}`, scope, '{ stripBotsWhenNoHumans, stripBotsAfterHandIfMarked, botStripAfterHand, noteBrokenTournamentTable }');
    const mk = (id: string) => {
      const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 100, bigBlind: 200, minBuyIn: 5000, maxPlayers: 9 } as any);
      for (let i = 1; i <= 4; i++) expect(t.sitDown(i, `Bot${i}`, 5000, `ai-${i}`, true)).toBe(true);   // the human's seat 0 was stood up
      tables.set(id, t);
      return t;
    };
    return { m, tables, tournamentTables, mk };
  }
  const bots = (t: PokerTable) => t.seats.filter((s) => s.state === 'occupied' && s.isAI).length;

  it('a simulated tournament table keeps its 4 bots; a cash table is still stripped (GAME-17 unchanged)', () => {
    const w = stripWorld();
    const T1 = w.mk('T1');
    const C1 = w.mk('C1');
    w.m.stripBotsWhenNoHumans('T1', T1);
    w.m.stripBotsWhenNoHumans('C1', C1);
    expect(bots(T1)).toBe(4);
    expect(bots(C1)).toBe(0);
  });

  it('a table a rebalance broke seconds ago is still a tournament table; a mark left from mid-hand is dropped, the bots stay', () => {
    const w = stripWorld();
    const T2 = w.mk('T2');
    w.m.noteBrokenTournamentTable('T2', 'tour-1');
    w.m.botStripAfterHand.add('T1');
    const T1 = w.mk('T1');
    w.m.stripBotsAfterHandIfMarked('T1');
    w.m.stripBotsWhenNoHumans('T2', T2);
    expect([bots(T1), bots(T2)]).toEqual([4, 4]);
    expect(w.m.botStripAfterHand.has('T1')).toBe(false);
  });

  it('CONTROL — without the guard: every bot of the tournament table is stood up (its stacks gone from the tournament)', () => {
    const w = stripWorld(without(SEAT_TEARDOWN_SRC, STRIP_GUARD, STRIP_GUARD_OFF));
    const T1 = w.mk('T1');
    w.m.stripBotsWhenNoHumans('T1', T1);
    expect(bots(T1)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════ admin force-close ══
const FORCE_CLOSE = handlerSrc('adminForceCloseTable', '\n  });\n');
const REFUSAL_START = '    const runningTournamentId = tournamentTables.get(data.tableId);\n';
function withoutRefusal(handler: string): string {
  const at = handler.indexOf(REFUSAL_START);
  expect(at).toBeGreaterThan(0);
  const end = handler.indexOf('      return;\n    }\n', at) + '      return;\n    }\n'.length;
  return handler.slice(0, at) + handler.slice(end);
}

describe('G185 — Admin Force Close is refused on a RUNNING tournament table', () => {
  function closeWorld(handler = FORCE_CLOSE) {
    const tm = new TournamentManager();
    const tid = tm.createTournament({ name: 'Sit & Go', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: LEVELS } as any);
    for (let i = 0; i < 3; i++) tm.registerPlayer(tid, `p${i}`, `P${i}`, `S${i}`);
    tm.startTournament(tid);
    const T = new PokerTable({ tableId: 'T', tableName: 'T', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxPlayers: 9 } as any);
    for (let i = 0; i < 3; i++) T.sitDown(i, `P${i}`, 1000, `p${i}`, false);
    tm.setTableId(tid, 'T');
    const tables = new Map<string, PokerTable>([['T', T]]);
    const tournamentTables = new Map<string, string>([['T', tid]]);
    const playerSessions = new Map<string, any>();
    const sockets = new Map<string, FakeSocket>();
    const authSessions = new Map<string, any>([['ADMIN', { userId: 1, username: 'admin' }]]);
    const roomEmits: Array<[string, string, any]> = [];
    const audits: string[] = [];
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id) },
      tournamentTables, tournamentManager: tm, authSessions, playerSessions, multiTableSessions: new Map(), reservedSeats: new Map(),
      pendingSeatRemovalAfterHand: new Map(), isUserAdmin: async () => true, auditLog: (_a: string, action: string) => { audits.push(action); },
      quickTables: new Set(), quickGames: new Map(), isPrizeFormatTable: () => false,
      isTournamentTable: (id: string) => id === 'T', MAX_SEATS, spectators: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(),
      turnTimers: new Map(), turnWarningTimers: new Map(), pendingAutoStartTimers: new Map(), aiTimeouts: new Map(),
      insuranceCashouts: new Map(), lastInsuranceSettlement: new Map(), drawStartedAtMap: new Map(), lastSentState: new Map(),
      lastSentJson: new Map(), tableProgressListeners: new Set(), privateTableIds: new Set(), privateTableMeta: new Map(),
      bombPotPending: new Map(), releaseSeatedSlot() {}, clearInsuranceOffer() {}, clearPineappleDiscardHold() {}, dropPendingMuckShows() {},
      addChipsToUser: async () => true,
      io: { to: (room: string) => ({ emit: (ev: string, p: any) => roomEmits.push([room, ev, p]) }), sockets: { sockets } },
      console: quiet,
    };
    const code = [
      fnSrc('function userIdForSeat('), fnSrc('function quickSeatOwner('), fnSrc('function endQuickSeatClaims('),
      fnSrc('function endTableViewsAndTimers('), `function wire(socket) {\n${handler}\n}`,
    ].join('\n');
    const { exports: m } = load(code, scope, '{ wire }');
    const admin = fakeSocket('ADMIN');
    sockets.set('ADMIN', admin);
    m.wire(admin);
    const p0 = fakeSocket('S0');
    sockets.set('S0', p0);
    p0.join('table:T');
    playerSessions.set('S0', { socketId: 'S0', tableId: 'T', seatIndex: 0, playerName: 'P0', playerId: 'p0' });
    return { tm, tid, T, tables, tournamentTables, playerSessions, roomEmits, audits, admin };
  }
  const seated = (T: PokerTable) => T.seats.filter((s) => s.state === 'occupied').map((s) => s.playerId);

  it('refused before any side effect: table, seats, sessions and the tournament untouched; the admin is told why (code tournament_table)', async () => {
    const w = closeWorld();
    await w.admin.handlers.adminForceCloseTable({ tableId: 'T' });
    await flush();
    expect(events(w.admin, 'adminForceCloseTableResult')).toEqual([expect.objectContaining({ success: false, code: 'tournament_table', tableId: 'T' })]);
    expect(w.tables.has('T')).toBe(true);
    expect(seated(w.T)).toEqual(['p0', 'p1', 'p2']);
    expect(w.playerSessions.get('S0')).toMatchObject({ tableId: 'T' });
    expect(w.roomEmits).toEqual([]);
    expect(w.audits).toEqual(['ADMIN_FORCE_CLOSE_TABLE_REFUSED']);
    expect(w.tm.getTournament(w.tid)!.status).toBe('running');
  });

  it('a table a rebalance already BROKE (out of tournamentTables) still closes', async () => {
    const w = closeWorld();
    w.tournamentTables.delete('T');
    await w.admin.handlers.adminForceCloseTable({ tableId: 'T' });
    await flush();
    expect(events(w.admin, 'adminForceCloseTableResult')).toEqual([{ success: true, tableId: 'T' }]);
    expect(w.tables.has('T')).toBe(false);
  });

  it('CONTROL — pre-G185: the table is removed and every entrant stood up while the tournament keeps 3 alive with no table (it can never finish)', async () => {
    const w = closeWorld(withoutRefusal(FORCE_CLOSE));
    await w.admin.handlers.adminForceCloseTable({ tableId: 'T' });
    await flush();
    expect(w.tables.has('T')).toBe(false);
    expect(seated(w.T)).toEqual([]);
    const t = w.tm.getTournament(w.tid)!;
    expect(t.status).toBe('running');
    expect(t.players.filter((p) => !p.eliminated)).toHaveLength(3);
  });

  it('wiring: the refusal comes before the audit, the quick-table branch and any stand-up', () => {
    const at = FORCE_CLOSE.indexOf(REFUSAL_START);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(FORCE_CLOSE.indexOf("auditLog(auth.username, 'ADMIN_FORCE_CLOSE_TABLE', { tableId: data.tableId });"));
    expect(at).toBeLessThan(FORCE_CLOSE.indexOf('if (quickTables.has(data.tableId)) {'));
    expect(at).toBeLessThan(FORCE_CLOSE.indexOf('table.standUp(i);'));
  });
});

// The source the tests above slice is the deployed one.
it('S8 locks are in src/index.ts', () => {
  expect(SRC).toContain('scheduleDealAfterTournamentSeat(tid);   // F95');
  expect(SRC).toContain('rehomeBrokenTableWatchers(tournamentId, breakTableId);');
  expect(SRC).toContain('function watchesFromDeadTournamentSeat(');
});

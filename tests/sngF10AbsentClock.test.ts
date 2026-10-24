/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F10) — ABSENT
 * players at (non-qualifier) tournament tables.
 *  - After 2 hands in which an absent seat (no session PLAYING it) timed out,
 *    it gets the SHORT clock (ABSENT_TOURNAMENT_SEAT_TURN_MS) until it returns;
 *    a session playing the seat again resets the streak (full clock). The
 *    audit: absent players kept the 30 s clock for 20 hands (13 timeouts = 28%
 *    of the event's time).
 *  - A registrant absent at the very start (no session, no reservation) is no
 *    longer acted for 500 ms into his turn (the orphan auto-act): he gets the
 *    normal clock, like a disconnect.
 *  - Scope: isTournamentTable && !qualifierIdOfTable — qualifier tables keep
 *    their rules exactly (U4 hand limit, P-j sit-out short clock, the 500 ms
 *    orphan act, no-show release, early rooms). Cash tables unchanged.
 *
 * The REAL armTurnTimer / autoActForSeat / helpers and broadcastGameState's
 * auto-act block (sliced from src/index.ts) on a REAL PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const constOf = (name: string): number => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return Number(m[1].replace(/_/g, ''));
};
const TURN = constOf('TURN_TIMEOUT_MS');
const SHORT = constOf('ABSENT_TOURNAMENT_SEAT_TURN_MS');

function world(opts: { qualifier?: boolean; cash?: boolean } = {}) {
  const table = new PokerTable({ tableId: 't1', tableName: 't1', smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 100000, maxPlayers: 9 } as any);
  for (let i = 0; i < 3; i++) table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
  const tournamentTables = new Map<string, string>();
  if (!opts.cash) tournamentTables.set('t1', 'TOURN');
  const playerSessions = new Map<string, any>([
    ['S1', { socketId: 'S1', tableId: 't1', seatIndex: 1, playerName: 'P1', playerId: 'p1', sittingOut: false }],
    ['S2', { socketId: 'S2', tableId: 't1', seatIndex: 2, playerName: 'P2', playerId: 'p2', sittingOut: false }],
  ]);
  const reservedSeats = new Map<number, any>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
    tournamentTables, playerSessions, reservedSeats, multiTableSessions: new Map(), sitOutTracker: new Map(),
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), MAX_SEATS: 9,
    TURN_TIMEOUT_MS: TURN, ABSENT_TOURNAMENT_SEAT_TURN_MS: SHORT, DrawPhases: [], GamePhase,
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    broadcastGameState() {}, scheduleAIAction() {}, log: { debug() {}, info() {} },
    qualifierIdOfTable: () => (opts.qualifier ? 'Q-weekly' : null),
  };
  const code = [
    slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
    fnSrc('function isTournamentReservation('),
    fnSrc('function seatHasLiveSession('),
    fnSrc('function isAbsentTournamentSeatPastHandLimit('),
    slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
    slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n'),
    fnSrc('function armTurnTimer('),
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ armTurnTimer, absentShortClockScope, absentTimeoutStreaks }');
  return { m, stubbed, table, playerSessions, reservedSeats };
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

/** One hand: the present seats call / check; seat 0's turn runs on the armed clock. Returns how long seat 0's first turn took. */
function handClock(w: ReturnType<typeof world>): number {
  expect(w.table.startNewHand()).toBe(true);
  let first = -1;
  for (let g = 0; g < 60 && w.table.isHandInProgress(); g++) {
    const a = w.table.activeSeatIndex;
    if (a === 0) {
      const hand = w.table.handNumber;
      const before = w.table.actionLog.length;
      w.m.armTurnTimer('t1');
      let waited = 0;
      while (w.table.actionLog.length === before && waited < TURN + 1000) { jest.advanceTimersByTime(250); waited += 250; }
      expect(w.table.handNumber).toBe(hand);
      if (first < 0) first = waited;
      continue;
    }
    if (!w.table.playerCheck(a)) w.table.playerCall(a);
  }
  return first;
}
const isShort = (ms: number) => ms <= SHORT + 250;
const isFull = (ms: number) => ms >= TURN - 250;

describe('F10 — after 2 timed-out hands an absent seat gets the short clock (non-qualifier tournaments)', () => {
  it(`Sit & Go table: hands 1 and 2 on the ${TURN} ms clock, hand 3 on ${SHORT} ms (e038f7b: ${TURN} for 20 hands)`, () => {
    const w = world();
    expect(isFull(handClock(w))).toBe(true);
    expect(isFull(handClock(w))).toBe(true);
    expect(isShort(handClock(w))).toBe(true);
    expect(isShort(handClock(w))).toBe(true);
    expect([...w.stubbed].filter((s) => /absent|Streak|qualifierIdOfTable|seatHas/i.test(s))).toEqual([]);
  });

  it('he comes back (a session PLAYING the seat): the full clock again and the streak is reset', () => {
    const w = world();
    handClock(w); handClock(w);
    expect(isShort(handClock(w))).toBe(true);
    w.playerSessions.set('S0', { socketId: 'S0', tableId: 't1', seatIndex: 0, playerName: 'P0', playerId: 'p0', sittingOut: false });
    expect(isFull(handClock(w))).toBe(true);
    w.playerSessions.delete('S0');
    expect(isFull(handClock(w))).toBe(true);   // the streak starts again from 0
  });

  it('a QUALIFIER table is unchanged: hand 3 is still the full clock (U4 still gives the short clock past the reservation\'s hand limit)', () => {
    const w = world({ qualifier: true });
    handClock(w); handClock(w);
    expect(isFull(handClock(w))).toBe(true);
    w.reservedSeats.set(77, { tableId: 't1', seatIndex: 0, playerId: 'p0', expiresAt: Date.now() + 3_600_000, handsRemaining: 0, tournament: true });
    expect(isShort(handClock(w))).toBe(true);
  });

  it('a cash table is unchanged (the full clock every hand)', () => {
    const w = world({ cash: true });
    for (let h = 0; h < 3; h++) expect(isFull(handClock(w))).toBe(true);
  });
});

describe('F10 — a registrant absent at the start gets a normal seat hold, not the 500 ms orphan act', () => {
  const BLOCK = slice("  // Auto-fold sitting-out players when it's their turn\n  if (table.isHandInProgress()) {", '      }, 500);\n    }\n  }\n');
  function blockWorld(kind: 'sng' | 'qualifier' | 'cash') {
    const table = new PokerTable({ tableId: 't1', tableName: 't1', smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 100000, maxPlayers: 9 } as any);
    for (let i = 0; i < 3; i++) table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    const acted: number[] = [];
    const tournamentTables = new Map<string, string>(kind === 'cash' ? [] : [['t1', 'TOURN']]);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: () => table }, playerSessions: new Map(), multiTableSessions: new Map(), reservedSeats: new Map(),
      DrawPhases: [], tournamentTables, brokenTournamentTables: new Map(),
      isTournamentTable: (id: string) => tournamentTables.has(id), qualifierIdOfTable: () => (kind === 'qualifier' ? 'Q' : null),
      seatHasAnySession: () => false, seatHasAnyPlayingSession: () => false,
      autoActForSeat: (_id: string, t: PokerTable, i: number) => { acted.push(i); t.playerFold(i); return 'fold'; },
      broadcastGameState() {}, scheduleAIAction() {},
    };
    const code = `${slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n')}\nfunction autoActBlock(tableId, table) {\n${BLOCK}\n}`;
    const { exports: m } = load(code, scope, '{ autoActBlock }');
    return { table, acted, m };
  }
  it('Sit & Go: an orphan active seat (no session, no reservation) is NOT acted for at 500 ms (e038f7b: acted)', () => {
    const w = blockWorld('sng');
    expect(w.table.startNewHand()).toBe(true);
    w.m.autoActBlock('t1', w.table);
    jest.advanceTimersByTime(600);
    expect(w.acted).toEqual([]);
  });
  test.each(['qualifier', 'cash'] as const)('%s table: still acted for at 500 ms (unchanged)', (kind) => {
    const w = blockWorld(kind);
    expect(w.table.startNewHand()).toBe(true);
    const a = w.table.activeSeatIndex;
    w.m.autoActBlock('t1', w.table);
    jest.advanceTimersByTime(600);
    expect(w.acted).toEqual([a]);
  });
});

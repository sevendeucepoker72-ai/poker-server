/**
 * 2026-10-26 — the FIRST turn of a table dealt before its first broadcast
 * carried turnStartedAt 0 to every seated player (pre-existing since b347ae4,
 * found by the "After 1" rig: a brand-new qualifier table's first actor saw a
 * frozen 30, no countdown, no warning — then the clock folded him and, since
 * 2026-10-26, sat him out).
 *
 * Root cause: the 'turnChanged' -> armTurnTimer listener is wired lazily by
 * broadcastGameState (ensureTurnTimerWired). bootstrapTournamentTables,
 * startTournamentGame and the quick games deal hand 1 (startNewHand ->
 * turnChanged, no listener yet) and THEN broadcast; the broadcast built every
 * seated frame before its tail armTurnTimer set turnStartedAtMap.
 * Fix: broadcastGameState arms the turn clock BEFORE it builds the frames
 * (idempotent: the seatChanged guard).
 *
 * Runs the REAL source of src/index.ts (sliced + transpiled) — bootstrap,
 * broadcast, the delta encoder, getGameStateForPlayer, armTurnTimer — against
 * the REAL PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const constOf = (name: string): number => Number(new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC)![1].replace(/_/g, ''));
const TURN_TIMEOUT_MS = constOf('TURN_TIMEOUT_MS');
const SHORT_MS = constOf('ABSENT_TOURNAMENT_SEAT_TURN_MS');

const P = {
  broken: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  isTournamentReservation: fnSrc('function isTournamentReservation('),
  sync: fnSrc('function syncSitOutToTable('),
  liveSession: fnSrc('function seatHasLiveSession('),
  pastLimit: fnSrc('function isAbsentTournamentSeatPastHandLimit('),
  autoAct: slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
  absentClock: slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n'),
  armTurnTimer: fnSrc('function armTurnTimer('),
  wired: slice('const wiredTurnListeners = new WeakSet<object>();', '\n}\n'),
  anySession: fnSrc('function seatHasAnySession('),
  anyPlaying: fnSrc('function seatHasAnyPlayingSession('),
  deadSeat: fnSrc('function watchesFromDeadTournamentSeat('),
  broadcast: fnSrc('function broadcastGameState('),
  delta: slice('const lastSentState = new Map', 'lastSentState.set(socket.id, { ...prev, ...forceKeys });\n    }\n  }\n}\n'),
  getState: fnSrc('function getGameStateForPlayer('),
  bootstrap: fnSrc('function bootstrapTournamentTables('),
};

type Frame = { sid: string; full: boolean; state: any };

function world(opts: { seats?: number } = {}) {
  const n = opts.seats ?? 5;
  const table = new PokerTable({ tableId: 't1', tableName: 'Qualifier Table 1', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 100000, maxPlayers: 9 } as any);
  const playerSessions = new Map<string, any>();
  const sockets = new Map<string, any>();
  const frames: Frame[] = [];
  const capture = (sid: string) => (ev: string, d: any) => { if (ev === 'gameState') frames.push({ sid, full: !!d.full, state: d.full ? d.state : d.delta }); };
  for (let i = 0; i < n; i++) {
    expect(table.sitDown(i, `P${i}`, 50000, `p-${i}`, false, true)).toBe(true);
    const sid = `S-${i}`;
    playerSessions.set(sid, { socketId: sid, tableId: 't1', seatIndex: i, playerName: `P${i}`, playerId: `p-${i}`, sittingOut: false, trainingEnabled: false });
    sockets.set(sid, { id: sid, connected: true, emit: capture(sid) });
  }
  const spectators = new Map<string, Set<string>>([['t1', new Set(['SPEC'])]]);
  sockets.set('SPEC', { id: 'SPEC', connected: true, emit: capture('SPEC') });
  const turnTimers = new Map<string, any>();
  const turnStartedAtMap = new Map<string, number>();
  const sitOutTracker = new Map<string, Set<number>>();
  const infos: string[] = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
    tournamentTables: new Map([['t1', 'T-1']]), playerSessions, multiTableSessions: new Map(), sitOutTracker,
    reservedSeats: new Map(), spectators,
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(),
    MAX_SEATS: 9, TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS: SHORT_MS, DrawPhases: [], GamePhase,
    turnTimers, turnWarningTimers: new Map(), turnStartedAtMap, turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    qualifierIdOfTable: () => 'wq-1',
    io: { sockets: { sockets }, to: () => ({ emit() {} }) },
    log: { debug() {}, info: (m: string) => infos.push(m), warn() {} },
    scheduleAIAction() {}, ensureInsuranceHoldWired() {}, isHandStoreReady: () => false,
    // The REAL ensureTableProgressListener never wires 'turnChanged' (static test below).
    ensureTableProgressListener() {},
    tournamentManager: { onEvent() {}, getTournament: () => undefined },
    tournamentBootstrapStats: { tableFailures: 0 }, Sentry: undefined,
    getVariantInfo: () => ({ variant: 'texas-holdem', variantName: "Texas Hold'em", holeCardCount: 2, hasDrawPhase: false, isStudGame: false, isPineapple: false, pineappleDiscardActive: false }),
    cardToString: (c: any) => `${c.rank}${c.suit}`,
    progressionManager: { getProgress: () => null, seatCosmetics: () => null, userRecord: () => null },
    seatAccountsOfTable: () => new Map(),
  };
  const code = [P.broken, P.isTournamentReservation, P.sync, P.liveSession, P.pastLimit, P.autoAct, P.absentClock,
    P.armTurnTimer, P.wired, P.anySession, P.anyPlaying, P.deadSeat, P.broadcast, P.delta, P.getState, P.bootstrap].join('\n');
  const { exports: m, stubbed } = load(code, scope,
    '{ bootstrapTournamentTables, broadcastGameState, armTurnTimer, ensureTurnTimerWired, getGameStateForPlayer, currentTurnTimeoutMs }');
  const framesOf = (sid: string) => frames.filter((f) => f.sid === sid);
  /** What a client holding full + shallow-delta frames sees now. */
  const merged = (sid: string) => framesOf(sid).reduce((acc: any, f) => (f.full ? { ...f.state } : { ...acc, ...f.state }), {} as any);
  return { m, stubbed, table, playerSessions, sitOutTracker, framesOf, merged, turnTimers, turnStartedAtMap, infos };
}

const sidOf = (seat: number) => `S-${seat}`;

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); jest.setSystemTime(1_793_056_974_000); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('2026-10-26 — the first turn of a table dealt BEFORE its first broadcast', () => {
  it('nothing the harness relies on was stubbed', () => {
    const w = world();
    w.m.bootstrapTournamentTables('T-1', ['t1']);
    const critical = ['armTurnTimer', 'ensureTurnTimerWired', 'getGameStateForPlayer', 'emitGameState', 'seatHasAnySession',
      'seatHasPlayingSession', 'currentTurnTimeoutMs', 'turnStartedAtMap', 'turnTimers', 'tableManager', 'playerSessions', 'spectators'];
    for (const c of critical) expect([...w.stubbed].some((s) => s === c || s.startsWith(`${c}.`))).toBe(false);
  });

  it('bootstrapTournamentTables deals hand 1 then broadcasts: EVERY frame (seated + spectator) carries the real turnStartedAt; one timer, the full 30 s deadline', () => {
    const w = world();
    const t0 = Date.now();
    w.m.bootstrapTournamentTables('T-1', ['t1']);   // the qualifier non-held start / registered MTT / multi-table sim
    expect(w.table.handNumber).toBe(1);
    const first = w.table.activeSeatIndex;
    expect(first).toBeGreaterThanOrEqual(0);
    for (let s = 0; s < 5; s++) {
      const f = w.framesOf(sidOf(s));
      expect(f).toHaveLength(1);
      expect(f[0].state.activeSeatIndex).toBe(first);
      expect(f[0].state.turnStartedAt).toBe(t0);                 // was 0 (a frozen countdown)
      expect(f[0].state.turnTimeout).toBe(TURN_TIMEOUT_MS);
    }
    expect(w.framesOf('SPEC')[0].state.turnStartedAt).toBe(t0);
    const entry = w.turnTimers.get('t1');
    w.m.broadcastGameState('t1');                                 // the tail / a later broadcast: no re-arm
    expect(w.turnTimers.get('t1')).toBe(entry);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1);
    expect(w.table.activeSeatIndex).toBe(first);
    jest.advanceTimersByTime(1);
    expect(w.table.seats[first].folded).toBe(true);
    expect(w.infos.filter((l) => l.includes(`Seat ${first} (P${first}) timed out`))).toHaveLength(1);
  });

  it('later turns and hands are unchanged (armed by the listener; the broadcast\'s early arm no-ops)', () => {
    const w = world();
    w.m.bootstrapTournamentTables('T-1', ['t1']);
    const first = w.table.activeSeatIndex;
    jest.advanceTimersByTime(4000);
    expect(w.table.playerFold(first)).toBe(true);                 // turnChanged -> armTurnTimer (listener)
    const armedByListener = w.turnTimers.get('t1');
    w.m.broadcastGameState('t1');
    expect(w.turnTimers.get('t1')).toBe(armedByListener);
    const second = w.table.activeSeatIndex;
    expect(w.merged(sidOf(second)).turnStartedAt).toBe(Date.now());
    for (let g = 0; g < 20 && w.table.isHandInProgress(); g++) w.table.playerFold(w.table.activeSeatIndex);
    jest.advanceTimersByTime(3000);
    expect(w.table.startNewHand()).toBe(true);
    w.m.broadcastGameState('t1');
    expect(w.merged(sidOf(w.table.activeSeatIndex)).turnStartedAt).toBe(Date.now());
  });

  it('the generic quick-game sequence (startNewHand on a never-broadcast table, then broadcast): the heads-up human first to act sees the real clock', () => {
    const w = world({ seats: 2 });
    expect(w.table.startNewHand()).toBe(true);
    w.m.broadcastGameState('t1');
    expect(w.table.activeSeatIndex).toBe(0);
    expect(w.framesOf('S-0')[0].state.turnStartedAt).toBe(Date.now());
  });

  it('a sat-out (P-j) first actor: the very first frame shows the table his SHORT clock', () => {
    const w = world();
    w.playerSessions.get('S-3').sittingOut = true;                // button 0, SB 1, BB 2 -> UTG 3 acts first
    w.sitOutTracker.set('t1', new Set([3]));
    w.m.bootstrapTournamentTables('T-1', ['t1']);
    expect(w.table.activeSeatIndex).toBe(3);
    expect(w.turnTimers.get('t1')?.short).toBe(true);
    const seen = w.framesOf('S-0')[0].state;
    expect(seen.turnStartedAt).toBe(Date.now());
    expect(seen.turnTimeout).toBe(SHORT_MS);
  });

  it('static: broadcastGameState arms BEFORE it builds the first frame; the deal-before-first-broadcast paths rely on it', () => {
    const arm = P.broadcast.indexOf('  armTurnTimer(tableId);');
    expect(arm).toBeGreaterThan(0);
    expect(arm).toBeLessThan(P.broadcast.indexOf('getGameStateForPlayer(table, session.seatIndex'));
    const handler = (ev: string) => { const at = SRC.indexOf(`socket.on('${ev}'`); return SRC.slice(at, SRC.indexOf('\n  });\n', at)); };
    for (const b of [fnSrc('function bootstrapTournamentTables('), fnSrc('function startTournamentGame('),
      handler('quickHeadsUp'), handler('quickSpinGo'), handler('quickAllInOrFold'), handler('startCareerGame')]) {
      const deal = b.search(/\.startNewHand\(\)/);
      expect(deal).toBeGreaterThan(0);
      expect(b.indexOf('broadcastGameState(')).toBeGreaterThan(deal);
    }
  });
});

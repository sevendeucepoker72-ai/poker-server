/**
 * 2026-10-26 (owner, after the Sun Oct 25 weekly qualifier: "players who had
 * their turn timer expire without acting didn't sit out and the sitout button
 * didn't work" -> "After 1").
 *
 * Measured on Oct 25: 707 timeouts by 36 players in 317 of 470 hands; a
 * connected player who did not act kept the full TURN_TIMEOUT_MS on every turn
 * (a timeout never changed his state), so hands with a timeout took 95-178 s
 * against 79 s.
 *
 *   - ONE timeout at a TOURNAMENT table sits a PLAYING session out (as his own
 *     Sit Out: P-j — dealt in, blinds posted), tells his socket
 *     (sitOutToggled reason 'timeout'), and his next turn runs on the SHORT
 *     absent clock until I'm back ('playerBack') or he acts himself.
 *   - Sit Out / I'm back naming a table the socket holds no seat at, from a
 *     socket whose ONLY seat is at a tournament table (moved by a rebalance
 *     while its app still named the old table): that seat. Counted + logged.
 *   - Cash tables, absent seats (no session) and multi-seat sockets: unchanged.
 *
 * Runs the REAL source of src/index.ts (sliced + transpiled) against the REAL
 * PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SRC, slice, fnSrc, handlerSrc, load, SEAT_SESSION_FOR_SRC } from './helpers/indexSource';

const constOf = (name: string): number => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return Number(m[1].replace(/_/g, ''));
};
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
  sitOut: handlerSrc('sitOut', '\n  });\n'),
  playerBack: handlerSrc('playerBack', '\n  });\n'),
};

type Emitted = Array<[string, string, any]>;   // [socketId, event, payload]

function world(opts: { tournament: boolean }) {
  const table = new PokerTable({ tableId: 't1', tableName: 't1', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
  expect(table.sitDown(0, 'Alice', 7000, 'p-alice', false, true)).toBe(true);
  expect(table.sitDown(1, 'Bob', 5000, 'p-bob', false, true)).toBe(true);
  const tournamentTables = new Map<string, string>();
  if (opts.tournament) tournamentTables.set('t1', 'T-1');
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const sitOutTracker = new Map<string, Set<number>>();
  const reservedSeats = new Map<number, any>();
  const turnTimers = new Map<string, any>();
  const emitted: Emitted = [];
  const sockets = new Map<string, any>();
  const sock = (sid: string) => {
    if (!sockets.has(sid)) sockets.set(sid, { id: sid, connected: true, emit: (ev: string, d: any) => emitted.push([sid, ev, d]) });
    return sockets.get(sid);
  };
  const infos: string[] = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
    tournamentTables, playerSessions, multiTableSessions, sitOutTracker, reservedSeats,
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(),
    MAX_SEATS: 9, TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS: SHORT_MS, DrawPhases: [], GamePhase,
    turnTimers, turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    qualifierIdOfTable: () => null,
    io: { sockets: { sockets } },
    broadcastGameState() {}, scheduleAIAction() {},
    log: { debug() {}, info: (m: string) => infos.push(m) },
  };
  const code = `${P.broken}\n${P.isTournamentReservation}\n${P.sync}\n${P.liveSession}\n${P.pastLimit}\n${P.autoAct}\n${P.absentClock}\n${P.armTurnTimer}\n`
    + `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${P.sitOut}\n${P.playerBack}\n}`;
  const { exports: m, stubbed } = load(code, scope,
    '{ armTurnTimer, syncSitOutToTable, tournamentSeatSitsOut, isAbsentTournamentSeatPastHandLimit, sitOutTournamentSeatAfterTimeout, returnTournamentSessionFromSitOut, currentTurnTimeoutMs, tournamentTimeoutSitOutStats, wire }');
  /** A socket with handlers wired: the main session, optionally extra seats. */
  const wireSocket = (sid: string) => {
    const handlers: Record<string, (d?: any) => any> = {};
    const s = sock(sid);
    m.wire({ ...s, on: (ev: string, fn: any) => { handlers[ev] = fn; } });
    return handlers;
  };
  playerSessions.set('S-A', { socketId: 'S-A', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice', sittingOut: false });
  playerSessions.set('S-B', { socketId: 'S-B', tableId: 't1', seatIndex: 1, playerName: 'Bob', playerId: 'p-bob', sittingOut: false });
  sock('S-A'); sock('S-B');
  return { m, stubbed, table, playerSessions, multiTableSessions, sitOutTracker, reservedSeats, turnTimers, emitted, infos, wireSocket };
}

/** Alice's live tournament reservation (her socket dropped: reserveSeatForDeparture's snapshot). */
function aliceDisconnects(w: ReturnType<typeof world>, sittingOut: boolean) {
  const s = w.playerSessions.get('S-A');
  w.playerSessions.delete('S-A');
  const r: Record<string, any> = { tableId: 't1', seatIndex: 0, playerName: 'Alice', chips: 7000, sittingOut, expiresAt: Date.now() + 600_000, handsRemaining: 20, tournament: true, playerId: 'p-alice' };
  w.reservedSeats.set(101, r);
  return { s, r };
}

/** Play out the current hand (Alice on whatever clock she has), deal the next one. */
function nextHand(w: ReturnType<typeof world>) {
  for (let g = 0; g < 40 && w.table.isHandInProgress(); g++) {
    const a = w.table.activeSeatIndex;
    if (a === 0) { w.m.armTurnTimer('t1'); jest.advanceTimersByTime(TURN_TIMEOUT_MS); continue; }
    if (!w.table.playerCheck(a)) w.table.playerCall(a);
  }
  expect(w.table.startNewHand()).toBe(true);
}

/** Deal until Alice is the BIG BLIND (heads-up: she is first after the flop); Bob (button / SB) limps. */
function aliceBigBlindWithFreeCheck(w: ReturnType<typeof world>) {
  for (let g = 0; g < 4; g++) {
    if (!w.table.isHandInProgress()) expect(w.table.startNewHand()).toBe(true);
    if (w.table.activeSeatIndex === 1 && w.table.currentPhase === GamePhase.PreFlop) break;   // Bob first pre-flop = Alice is BB
    w.table.playerFold(w.table.activeSeatIndex);
  }
  expect(w.table.activeSeatIndex).toBe(1);
  expect(w.table.playerCall(1)).toBe(true);
  expect(w.table.activeSeatIndex).toBe(0);
  expect(w.table.currentBetToMatch - w.table.seats[0].currentBet).toBe(0);   // her option: a free check
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

/** Deal and bring the action to Alice (Bob calls / checks to her); arm her clock. */
function aliceToAct(w: ReturnType<typeof world>) {
  if (!w.table.isHandInProgress()) expect(w.table.startNewHand()).toBe(true);
  for (let g = 0; g < 8 && w.table.activeSeatIndex !== 0 && w.table.isHandInProgress(); g++) {
    const a = w.table.activeSeatIndex;
    if (!w.table.playerCall(a)) w.table.playerCheck(a);
  }
  expect(w.table.activeSeatIndex).toBe(0);
  const phase0 = w.table.currentPhase;
  const hand0 = w.table.handNumber;
  w.m.armTurnTimer('t1');
  return () => w.table.currentPhase !== phase0 || w.table.activeSeatIndex !== 0 || w.table.handNumber !== hand0 || !w.table.isHandInProgress();
}

describe('2026-10-26 — ONE timeout sits a tournament player out (owner: "After 1")', () => {
  it('tournament: Alice (connected) lets her clock run out -> acted for at the FULL clock, then sat out + told (reason timeout)', () => {
    const w = world({ tournament: true });
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1);
    expect(acted()).toBe(false);                                   // the full clock, as before
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(true);
    expect(w.emitted).toContainEqual(['S-A', 'sitOutToggled', { sittingOut: true, reason: 'timeout', tableId: 't1' }]);
    expect(w.m.tournamentTimeoutSitOutStats).toMatchObject({ satOut: 1, sessionsMarked: 1 });
    expect(w.infos.some((l) => l.includes('"event":"tournament_timeout_sit_out"'))).toBe(true);
    expect(w.playerSessions.get('S-B').sittingOut).toBe(false);   // Bob untouched
    expect([...w.stubbed].filter((n) => /sync|SitOut|Session|autoAct|isTournament|absent|Absent/.test(n))).toEqual([]);
  });

  it(`…and her NEXT turn runs on the short absent clock (${SHORT_MS} ms), she stays dealt in`, () => {
    const w = world({ tournament: true });
    let acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    // finish the hand (Bob plays it out), deal the next, bring it to Alice
    for (let g = 0; g < 20 && w.table.isHandInProgress(); g++) {
      const a = w.table.activeSeatIndex;
      if (a === 0) { jest.advanceTimersByTime(SHORT_MS); continue; }
      if (!w.table.playerCheck(a)) w.table.playerCall(a);
    }
    expect(w.table.startNewHand()).toBe(true);
    expect(w.table.seats[0].holeCards).toHaveLength(2);             // P-j: still dealt in
    acted = aliceToAct(w);
    jest.advanceTimersByTime(SHORT_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);                                     // 3 s, not 30 s
    expect(w.m.tournamentTimeoutSitOutStats.satOut).toBe(1);        // already out: not counted again
    expect(w.emitted.filter(([s, ev, d]) => s === 'S-A' && ev === 'sitOutToggled' && d.reason === 'timeout')).toHaveLength(1);
  });

  it("I'm back ('playerBack') ends it: the next turn has the full clock again", () => {
    const w = world({ tournament: true });
    const h = w.wireSocket('S-A');
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    h.playerBack({ tableId: 't1' });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(false);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(false);
    expect(w.m.tournamentSeatSitsOut('t1', 0)).toBe(false);
    expect(w.emitted).toContainEqual(['S-A', 'sitOutToggled', { sittingOut: false, reason: 'back', tableId: 't1' }]);
  });

  it('acting herself while sat out also brings her back (returnTournamentSessionFromSitOut, reason action)', () => {
    const w = world({ tournament: true });
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    const s = w.playerSessions.get('S-A');
    w.m.returnTournamentSessionFromSitOut({ emit: (ev: string, d: any) => w.emitted.push(['S-A', ev, d]) }, s, 'action');
    expect(s.sittingOut).toBe(false);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(false);
    expect(w.emitted).toContainEqual(['S-A', 'sitOutToggled', { sittingOut: false, reason: 'action', tableId: 't1' }]);
    expect(w.m.tournamentTimeoutSitOutStats.backByAction).toBe(1);
    // wiring: the action handler calls it after a successful action, for a tournament table only
    const action = handlerSrc('action', '\n  );\n');
    const success = action.indexOf("socket.emit('error', { message: `Invalid action: ${data.type}` });");
    const back = action.indexOf("if (session.sittingOut && isTournamentTable(session.tableId)) returnTournamentSessionFromSitOut(socket, session, 'action');");
    expect(success).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(success);
  });

  it('CASH table: a timeout folds her and she is NOT sat out (unchanged)', () => {
    const w = world({ tournament: false });
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    expect(w.playerSessions.get('S-A').sittingOut).toBe(false);
    expect(w.emitted.filter(([, ev]) => ev === 'sitOutToggled')).toEqual([]);
    expect(w.m.tournamentTimeoutSitOutStats.satOut).toBe(0);
  });

  it('an ABSENT tournament seat (no session, no reservation) times out: nothing to mark (the orphan act / F10 own it)', () => {
    const w = world({ tournament: true });
    w.playerSessions.delete('S-A');
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    expect(w.m.tournamentTimeoutSitOutStats.satOut).toBe(0);
    expect(w.emitted.filter(([, ev]) => ev === 'sitOutToggled')).toEqual([]);
  });

  it('an extra multi-table seat at the tournament table is marked too (defensive: joinAdditionalTable refuses tournament tables today)', () => {
    const w = world({ tournament: true });
    const main = w.playerSessions.get('S-A');
    w.playerSessions.set('S-A', { ...main, tableId: 'cash-x', seatIndex: 3 });
    w.multiTableSessions.set('S-A', [{ socketId: 'S-A', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice', sittingOut: false }]);
    expect(w.m.sitOutTournamentSeatAfterTimeout('t1', 0)).toBe(true);
    expect(w.multiTableSessions.get('S-A')![0].sittingOut).toBe(true);
    expect(w.playerSessions.get('S-A').sittingOut).toBe(false);   // his cash seat elsewhere: untouched
  });
});

describe('2026-10-26 review fix-ups — the short clock from the VERY next turn, through a disconnect', () => {
  it('heads-up: her timed-out CHECK closes pre-flop and hands her the flop at once -> that turn is re-armed SHORT', () => {
    const w = world({ tournament: true });
    w.table.on('turnChanged', () => w.m.armTurnTimer('t1'));   // as production (table listener)
    aliceBigBlindWithFreeCheck(w);
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);                    // her pre-flop clock runs out: checked
    expect(w.table.currentPhase).toBe(GamePhase.Flop);
    expect(w.table.activeSeatIndex).toBe(0);                      // first to act on the flop
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);
    expect(w.turnTimers.get('t1')).toMatchObject({ seatIndex: 0, short: true });
    expect(w.m.tournamentTimeoutSitOutStats.shortClockRearmed).toBe(1);
    jest.advanceTimersByTime(SHORT_MS - 1);
    expect(w.table.currentPhase === GamePhase.Flop && w.table.activeSeatIndex === 0).toBe(true);
    jest.advanceTimersByTime(1);
    expect(w.table.activeSeatIndex).toBe(1);                      // checked for her at 3 s, not 30 s
  });

  it('CONTROL — handed back a turn ALREADY on the short clock (Back to Lobby keep, handsRemaining 0): not re-armed, not counted', () => {
    const w = world({ tournament: true });
    aliceBigBlindWithFreeCheck(w);
    const { r } = aliceDisconnects(w, false);
    r.handsRemaining = 0; r.voluntary = true;
    w.table.on('turnChanged', () => w.m.armTurnTimer('t1'));     // wired once she is away (her turn not armed yet)
    w.m.armTurnTimer('t1');
    expect(w.turnTimers.get('t1')).toMatchObject({ seatIndex: 0, short: true });
    jest.advanceTimersByTime(SHORT_MS);                           // checked at 3 s: the flop is hers, armed short already
    expect(w.table.currentPhase).toBe(GamePhase.Flop);
    expect(w.table.activeSeatIndex).toBe(0);
    expect(w.turnTimers.get('t1')).toMatchObject({ seatIndex: 0, short: true });
    expect(w.m.tournamentTimeoutSitOutStats.shortClockRearmed).toBe(0);
    expect(r.sittingOut).toBe(true);                              // AWAY badge now (reservationsMarked counts it)
  });

  it('CONTROL — the timeout hands the turn to someone else: nothing is re-armed', () => {
    const w = world({ tournament: true });
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    if (w.table.isHandInProgress()) expect(w.table.activeSeatIndex).not.toBe(0);
    expect(w.m.tournamentTimeoutSitOutStats.shortClockRearmed).toBe(0);
  });

  it('sat out by a timeout, then her socket drops: her reservation keeps the SHORT clock (was: full clock for 20 hands)', () => {
    const w = world({ tournament: true });
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    aliceDisconnects(w, true);                                    // reserveSeatForDeparture snapshots sittingOut: true
    expect(w.m.isAbsentTournamentSeatPastHandLimit('t1', 0)).toBe(true);
    nextHand(w);
    const acted2 = aliceToAct(w);
    jest.advanceTimersByTime(SHORT_MS - 1);
    expect(acted2()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted2()).toBe(true);
  });

  it('away on a reservation (NOT sat out): first turn on the FULL clock (he may be reconnecting), then the reservation is sat out -> short', () => {
    const w = world({ tournament: true });
    const { r } = aliceDisconnects(w, false);
    expect(w.m.isAbsentTournamentSeatPastHandLimit('t1', 0)).toBe(false);
    const acted = aliceToAct(w);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);
    expect(r.sittingOut).toBe(true);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(true);         // AWAY badge
    expect(w.m.tournamentTimeoutSitOutStats).toMatchObject({ satOut: 1, sessionsMarked: 0, reservationsMarked: 1 });
    expect(w.infos.some((l) => l.includes('"event":"tournament_timeout_sit_out"') && l.includes('"reservation":true'))).toBe(true);
    nextHand(w);
    const acted2 = aliceToAct(w);
    jest.advanceTimersByTime(SHORT_MS);
    expect(acted2()).toBe(true);
    expect(w.m.tournamentTimeoutSitOutStats.satOut).toBe(1);      // not counted again
  });

  it('CONTROL — a CASH reservation, or an expired one, is never marked', () => {
    const cash = world({ tournament: false });
    const { r } = aliceDisconnects(cash, false);
    r.tournament = false;
    expect(cash.m.sitOutTournamentSeatAfterTimeout('t1', 0)).toBe(false);
    expect(r.sittingOut).toBe(false);
    const w = world({ tournament: true });
    const { r: old } = aliceDisconnects(w, false);
    old.expiresAt = Date.now() - 1;
    expect(w.m.sitOutTournamentSeatAfterTimeout('t1', 0)).toBe(false);
    expect(old.sittingOut).toBe(false);
  });

  it("the countdown shows the clock the turn is really on: 3 s while she is away, 30 s after I'm back or for anyone else", () => {
    const w = world({ tournament: true });
    const h = w.wireSocket('S-A');
    expect(w.m.currentTurnTimeoutMs('t1')).toBe(TURN_TIMEOUT_MS);   // no turn armed
    w.wireSocket('S-B');
    let acted = aliceToAct(w);
    expect(w.m.currentTurnTimeoutMs('t1')).toBe(TURN_TIMEOUT_MS);   // she plays: full clock
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(acted()).toBe(true);
    nextHand(w);
    acted = aliceToAct(w);
    expect(w.m.currentTurnTimeoutMs('t1')).toBe(SHORT_MS);          // sat out: the 3 s she really has
    h.playerBack({ tableId: 't1' });
    expect(w.m.currentTurnTimeoutMs('t1')).toBe(TURN_TIMEOUT_MS);   // back: the fire-time re-check gives her the rest of 30 s
    jest.advanceTimersByTime(SHORT_MS);
    expect(acted()).toBe(false);
    expect(w.turnTimers.get('t1')).toMatchObject({ short: false });
    // wiring: every state stamps it
    expect(fnSrc('function getGameStateForPlayer(')).toContain('turnTimeout: currentTurnTimeoutMs(table.config.tableId),');
  });
});

describe('2026-10-26 review fix-up — a MOVED sat-out player stays AWAY at the new table', () => {
  function moveWorld() {
    const mk = (id: string) => new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    const tables = new Map<string, PokerTable>([['t1', mk('t1')], ['t2', mk('t2')]]);
    tables.get('t1')!.sitDown(0, 'Alice', 7000, 'p-alice', false, true);
    tables.get('t2')!.sitDown(4, 'Alice', 7000, 'p-alice', false, true);   // the move sits her down first (moveTournamentStack / the break)
    const playerSessions = new Map<string, any>();
    const reservedSeats = new Map<number, any>();
    const sitOutTracker = new Map<string, Set<number>>();
    const sockets = new Map<string, any>([['S-A', { id: 'S-A', connected: true, emit() {}, join() {}, leave() {} }]]);
    const code = `${P.sync}\n${P.absentClock}\n${fnSrc('function moveTournamentSeatPointers(')}\n${fnSrc('function carryAwayStateOnMove(')}`;
    const { exports: m } = load(code, {
      tableManager: { getTable: (id: string) => tables.get(id) },
      tournamentTables: new Map([['t1', 'T-1'], ['t2', 'T-1']]), challengeTables: new Map(),
      playerSessions, multiTableSessions: new Map(), reservedSeats, sitOutTracker, authSessions: new Map(),
      io: { sockets: { sockets } }, lastSentState: new Map(), lastSentJson: new Map(),
      tournamentHandStartSafety: { reconnectedSessionsMoved: 0, reservationsMoved: 0 },
      qualifierIdOfTable: () => null, noteAbsentTournamentSeatMoved() {},
    }, '{ moveTournamentSeatPointers, tournamentTimeoutSitOutStats }');
    const tp = { playerId: 'p-alice', socketId: 'S-A', userId: 101 };
    return { m, playerSessions, reservedSeats, sitOutTracker, tp };
  }

  it('a live session sitting out: t1:0 AWAY -> t2:4 AWAY, the old entry gone, she keeps sittingOut', () => {
    const w = moveWorld();
    w.playerSessions.set('S-A', { socketId: 'S-A', tableId: 't1', seatIndex: 0, sittingOut: true });
    w.sitOutTracker.set('t1', new Set([0]));
    w.m.moveTournamentSeatPointers(w.tp, 't1', 0, 't2', 4, 'T-1');
    expect(w.playerSessions.get('S-A')).toMatchObject({ tableId: 't2', seatIndex: 4, sittingOut: true });
    expect(w.sitOutTracker.get('t2')?.has(4)).toBe(true);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(false);
    expect(w.m.tournamentTimeoutSitOutStats.awayMoved).toBe(1);
  });

  it('a live session PLAYING: not away at the new seat (a stale entry there goes too)', () => {
    const w = moveWorld();
    w.playerSessions.set('S-A', { socketId: 'S-A', tableId: 't1', seatIndex: 0, sittingOut: false });
    w.sitOutTracker.set('t2', new Set([4]));
    w.m.moveTournamentSeatPointers(w.tp, 't1', 0, 't2', 4, 'T-1');
    expect(w.sitOutTracker.get('t2')?.has(4)).toBe(false);
    expect(w.m.tournamentTimeoutSitOutStats.awayMoved).toBe(0);
  });

  it('nobody live (socket dropped): a sat-out reservation, or an AWAY old seat, carries over', () => {
    const w = moveWorld();
    w.reservedSeats.set(101, { tableId: 't1', seatIndex: 0, sittingOut: true, tournament: true, expiresAt: Date.now() + 600_000, handsRemaining: 20 });
    w.m.moveTournamentSeatPointers(w.tp, 't1', 0, 't2', 4, 'T-1');
    expect(w.reservedSeats.get(101)).toMatchObject({ tableId: 't2', seatIndex: 4, sittingOut: true });
    expect(w.sitOutTracker.get('t2')?.has(4)).toBe(true);
    const v = moveWorld();
    v.sitOutTracker.set('t1', new Set([0]));
    v.m.moveTournamentSeatPointers(v.tp, 't1', 0, 't2', 4, 'T-1');
    expect(v.sitOutTracker.get('t2')?.has(4)).toBe(true);
  });
});

describe('2026-10-26 — Sit Out / I\'m back with a STALE tournament table id (owner: "the sitout button didn\'t work")', () => {
  it('his only seat is at tournament table t1, his app names the old table: Sit Out applies to t1 and the reply names t1', () => {
    const w = world({ tournament: true });
    const h = w.wireSocket('S-A');
    h.sitOut({ sittingOut: true, tableId: 'old-broken-table' });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(true);
    expect(w.emitted).toContainEqual(['S-A', 'sitOutToggled', { sittingOut: true, tableId: 't1' }]);
    expect(w.emitted.filter(([, ev]) => ev === 'error')).toEqual([]);
    expect(w.m.tournamentTimeoutSitOutStats).toMatchObject({ sitOutFallbacks: 1, sitOutRefusals: 0 });
    expect(w.infos.some((l) => l.includes('"event":"sit_out_stale_table_fallback"'))).toBe(true);
    h.playerBack({ tableId: 'old-broken-table' });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(false);
    expect(w.m.tournamentTimeoutSitOutStats.backFallbacks).toBe(1);
  });

  it('CONTROL — cash seat: a stale table id is still refused (not_at_table), and counted', () => {
    const w = world({ tournament: false });
    const h = w.wireSocket('S-A');
    h.sitOut({ sittingOut: true, tableId: 'other-table' });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(false);
    expect(w.emitted).toContainEqual(['S-A', 'error', { message: 'You are not seated at that table.', code: 'not_at_table', tableId: 'other-table' }]);
    expect(w.m.tournamentTimeoutSitOutStats).toMatchObject({ sitOutFallbacks: 0, sitOutRefusals: 1 });
    expect(w.infos.some((l) => l.includes('"event":"sit_out_not_at_table"'))).toBe(true);
  });

  it('CONTROL — a socket holding extra seats is refused (ambiguous which seat)', () => {
    const w = world({ tournament: true });
    w.multiTableSessions.set('S-A', [{ socketId: 'S-A', tableId: 'cash-x', seatIndex: 2, sittingOut: false }]);
    const h = w.wireSocket('S-A');
    h.sitOut({ sittingOut: true, tableId: 'old-broken-table' });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(false);
    expect(w.m.tournamentTimeoutSitOutStats.sitOutRefusals).toBe(1);
  });

  it('the right table id works exactly as before (no fallback counted)', () => {
    const w = world({ tournament: true });
    const h = w.wireSocket('S-A');
    h.sitOut({ sittingOut: true, tableId: 't1' });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);
    expect(w.m.tournamentTimeoutSitOutStats).toMatchObject({ sitOutFallbacks: 0, sitOutRefusals: 0 });
  });

  it('wiring: playerAFK uses the same fallback; health reports the counters', () => {
    expect(handlerSrc('playerAFK', '\n  });\n')).toContain("seatSessionFor(data?.tableId) ?? tournamentSeatForStaleTable(data?.tableId, 'sitOut')");
    expect(SRC).toContain('tournamentTimeoutSitOut: { ...tournamentTimeoutSitOutStats },');
    expect(SRC).toMatch(/satOut: 0, sessionsMarked: 0, reservationsMarked: 0, backByAction: 0, shortClockRearmed: 0, awayMoved: 0,/);
  });
});

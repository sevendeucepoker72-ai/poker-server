/**
 * 2026-10-10 (round 6, S2 protocol P-j) — SITTING OUT on a TOURNAMENT table is
 * being ABSENT.
 *
 * pe5 X3 [major]: a sitting-out seat (Sit Out, or the client's 10-minute AFK
 * tracker) was taken out of the deal on every table: PokerTable refuses a hand
 * with fewer than two non-sitting-out seats, deals a sitting-out seat in
 * already folded and posts no live blind for it. On a tournament table that
 * seat was never blinded off — it always survived to heads-up, and a heads-up
 * with it never dealt again: the tournament could not finish. With S2, Back to
 * Lobby while sitting out made it permanent (nobody but a Return clears the
 * sit-out). Now, on a tournament table (cash tables unchanged):
 *   - syncSitOutToTable gives the engine NO sitting-out seat, so the seat is
 *     dealt in and posts its blinds / antes live;
 *   - its turn is acted for as ABSENT (autoActForSeat — P-i) on the SHORT
 *     absent clock (tournamentSeatSitsOut); sitting back in during that clock
 *     gives the player the rest of the normal clock;
 *   - a Sit Out / AFK tapped on his own turn checks when nothing is owed
 *     (P-i) instead of a needless fold.
 *
 * Runs the REAL source of src/index.ts (sliced + transpiled) against the REAL
 * PokerTable.
 */
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { SRC, slice, fnSrc, handlerSrc, load } from './helpers/indexSource';

const constOf = (name: string): number => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return Number(m[1].replace(/_/g, ''));
};
const TURN_TIMEOUT_MS = constOf('TURN_TIMEOUT_MS');
const ABSENT_TOURNAMENT_SEAT_TURN_MS = constOf('ABSENT_TOURNAMENT_SEAT_TURN_MS');

const P = {
  broken: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  isTournamentReservation: fnSrc('function isTournamentReservation('),
  sync: fnSrc('function syncSitOutToTable('),
  liveSession: fnSrc('function seatHasLiveSession('),
  pastLimit: fnSrc('function isAbsentTournamentSeatPastHandLimit('),
  autoAct: slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
  armTurnTimer: fnSrc('function armTurnTimer('),
  sitOut: handlerSrc('sitOut', '\n  });\n'),
};
/** The P-j line; the controls put back the engine sit-out set every table had before (the cash rule). */
const PJ = 'table.setSittingOutSeats(isTournamentTable(tableId) ? [] : set);';

function world(opts: { tournament: boolean; over?: Partial<typeof P> }) {
  const p = { ...P, ...(opts.over || {}) };
  const table = new PokerTable({ tableId: 't1', tableName: 't1', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
  expect(table.sitDown(0, 'Alice', 7000, 'p-alice', false, true)).toBe(true);
  expect(table.sitDown(1, 'Bob', 5000, 'p-bob', false, true)).toBe(true);
  const tournamentTables = new Map<string, string>();
  if (opts.tournament) tournamentTables.set('t1', 'T-1');
  const playerSessions = new Map<string, any>();
  const sitOutTracker = new Map<string, Set<number>>();
  const reservedSeats = new Map<number, any>();
  const tournamentHandStartSafety = { allAbsentAutoCalls: 0 };
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
    tournamentTables, playerSessions, sitOutTracker, reservedSeats, tournamentHandStartSafety,
    MAX_SEATS: 9, TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS, DrawPhases: [], GamePhase,
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    broadcastGameState() {}, scheduleAIAction() {}, log: { debug() {}, info() {} },
  };
  const code = `${p.broken}\n${p.isTournamentReservation}\n${p.sync}\n${p.liveSession}\n${p.pastLimit}\n${p.autoAct}\n${p.armTurnTimer}\nfunction wire(socket) {\n${p.sitOut}\n}`;
  const { exports: m, stubbed } = load(code, scope, '{ syncSitOutToTable, armTurnTimer, autoActForSeat, tournamentSeatSitsOut, wire }');
  /** Alice's live session (S-A) sitting out, as 'sitOut' / 'playerAFK' leave it. */
  const aliceSitsOut = () => {
    playerSessions.set('S-A', { socketId: 'S-A', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice', sittingOut: true });
    sitOutTracker.set('t1', new Set([0]));
    m.syncSitOutToTable('t1');
  };
  playerSessions.set('S-B', { socketId: 'S-B', tableId: 't1', seatIndex: 1, playerName: 'Bob', playerId: 'p-bob', sittingOut: false });
  return { m, stubbed, table, playerSessions, sitOutTracker, tournamentHandStartSafety, aliceSitsOut };
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('P-j (round 6) — sitting out on a TOURNAMENT table never takes the seat out of the deal', () => {
  it('heads-up, Alice sits out: the hand still deals; she is dealt in (not pre-folded) and posts her blind LIVE (no dead-blind debt)', () => {
    const w = world({ tournament: true });
    w.aliceSitsOut();
    expect(w.table.startNewHand()).toBe(true);
    expect(w.table.seats[0].holeCards).toHaveLength(2);
    expect(w.table.seats[0].folded).toBe(false);
    expect(w.table.seats[0].currentBet).toBeGreaterThan(0);                  // her small / big blind is in the pot
    expect(w.table.seats[0].chipCount).toBeLessThan(7000);
    expect(w.table.seats[0].deadBlindOwedChips || 0).toBe(0);
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(true);                     // she is still "sitting out" to herself (the UI)
    expect([...w.stubbed].filter((n) => /sync|SitOut|Session|autoAct|isTournament/.test(n))).toEqual([]);
  });

  it('CONTROL — the pre-P-j sit-out (the engine sees her sitting out, as on a cash table): no hand can ever start heads-up (pe5 X3: the tournament never finishes)', () => {
    expect(P.sync).toContain(PJ);
    const w = world({ tournament: true, over: { sync: P.sync.replace(PJ, 'table.setSittingOutSeats(set);') } });
    w.aliceSitsOut();
    for (let i = 0; i < 5; i++) expect(w.table.startNewHand()).toBe(false);
  });

  it('Back to Lobby while sitting out (no session left, the tracker still holds her seat): still dealt in, blinds posted', () => {
    const w = world({ tournament: true });
    w.aliceSitsOut();
    w.playerSessions.delete('S-A');
    expect(w.table.startNewHand()).toBe(true);
    expect(w.table.seats[0].holeCards).toHaveLength(2);
    expect(w.table.seats[0].folded).toBe(false);
  });

  it('a CASH table is unchanged: a sitting-out seat is not dealt (heads-up — no hand)', () => {
    const w = world({ tournament: false });
    w.aliceSitsOut();
    expect(w.table.startNewHand()).toBe(false);
  });

  /** Deal, and bring the action to Alice (Bob, present, calls / checks to her). */
  function aliceToAct(w: ReturnType<typeof world>) {
    expect(w.table.startNewHand()).toBe(true);
    for (let g = 0; g < 6 && w.table.activeSeatIndex !== 0; g++) {
      const a = w.table.activeSeatIndex;
      if (!w.table.playerCall(a)) w.table.playerCheck(a);
    }
    expect(w.table.activeSeatIndex).toBe(0);
    const phase0 = w.table.currentPhase;
    const actions: Array<[number, PlayerAction]> = [];
    w.table.on('playerAction', (d: { seatIndex: number; action: PlayerAction }) => actions.push([d.seatIndex, d.action]));
    w.m.armTurnTimer('t1');
    const acted = () => w.table.currentPhase !== phase0 || w.table.activeSeatIndex !== 0 || !w.table.isHandInProgress();
    return { acted, actions };
  }

  it(`her turn is acted for on the SHORT absent clock (${ABSENT_TOURNAMENT_SEAT_TURN_MS}ms, not ${TURN_TIMEOUT_MS}ms), as P-i says (Bob is present: check when free, else fold)`, () => {
    const w = world({ tournament: true });
    w.aliceSitsOut();
    expect(w.m.tournamentSeatSitsOut('t1', 0)).toBe(true);
    const { acted, actions } = aliceToAct(w);
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);
    expect([PlayerAction.Check, PlayerAction.Fold]).toContain(actions[0][1]);
    expect(actions[0][1]).not.toBe(PlayerAction.Call);                        // Bob is present: never a call for her
  });

  it('she sits back in during the short clock: she gets the REST of the normal clock, not an auto-action', () => {
    const w = world({ tournament: true });
    w.aliceSitsOut();
    const { acted } = aliceToAct(w);
    jest.advanceTimersByTime(1000);
    w.playerSessions.get('S-A').sittingOut = false;                           // 'sitOut' toggled back / 'playerBack'
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1000 - ABSENT_TOURNAMENT_SEAT_TURN_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);
  });

  it('CONTROL — without the P-j clock a sitting-out tournament seat waits the full turn clock', () => {
    const SHORT = 'const shortClock = isAbsentTournamentSeatPastHandLimit(tableId, activeSeat) || tournamentSeatSitsOut(tableId, activeSeat);';
    expect(P.armTurnTimer).toContain(SHORT);
    const w = world({ tournament: true, over: { armTurnTimer: P.armTurnTimer.replace(SHORT, 'const shortClock = isAbsentTournamentSeatPastHandLimit(tableId, activeSeat);') } });
    w.aliceSitsOut();
    const { acted } = aliceToAct(w);
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - ABSENT_TOURNAMENT_SEAT_TURN_MS);
    expect(acted()).toBe(true);
  });
});

describe('round 6 — a seat that acts LAST on one street and FIRST on the next gets a fresh turn clock (heads-up big blind: pre-flop → flop)', () => {
  const STREET = '    const seatChanged = priorSeatForStart !== activeSeat || handChanged || streetChanged;';
  /** Heads-up with Alice (sitting out — absent, short clock) as the BIG BLIND; Bob (present) completes the small blind. */
  function bigBlindToFlop(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, over });
    w.aliceSitsOut();
    for (let h = 0; h < 4; h++) {                                             // until Alice is the big blind (Bob, the button, acts first)
      expect(w.table.startNewHand()).toBe(true);
      if (w.table.activeSeatIndex === 1) break;
      for (let g = 0; g < 40 && w.table.isHandInProgress(); g++) {
        const a = w.table.activeSeatIndex;
        if (!w.table.playerFold(a)) w.table.playerCheck(a);
      }
    }
    expect(w.table.activeSeatIndex).toBe(1);
    expect(w.table.playerCall(1)).toBe(true);                                 // Bob completes
    expect(w.table.activeSeatIndex).toBe(0);
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS);                 // Alice: checks her option (P-i)
    expect(w.table.currentPhase).toBe('Flop');
    expect(w.table.activeSeatIndex).toBe(0);                                  // …and is FIRST to act on the flop
    w.m.armTurnTimer('t1');                                                   // what the street change's broadcast does
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS);
    return w;
  }
  it('the flop turn is armed again: Alice is acted for on the short clock (she checks), the hand moves on', () => {
    const w = bigBlindToFlop();
    expect(w.table.activeSeatIndex).toBe(1);                                  // Bob to act — no stall
    expect(w.table.seats[0].lastAction).toBe(PlayerAction.Check);
  });
  it('CONTROL — the seat + hand guard alone (HEAD): no clock on the flop — the table waits for the wedge watchdog', () => {
    expect(P.armTurnTimer).toContain(STREET);
    const w = bigBlindToFlop({ armTurnTimer: P.armTurnTimer.replace(STREET, '    const seatChanged = priorSeatForStart !== activeSeat || handChanged;') });
    expect(w.table.activeSeatIndex).toBe(0);                                  // still Alice, still the flop
    jest.advanceTimersByTime(TURN_TIMEOUT_MS * 2);
    expect(w.table.activeSeatIndex).toBe(0);
  });
});

describe('P-j / P-i — Sit Out tapped on his own turn at a tournament table', () => {
  /** Both just call / check until Alice, present, is to act with NOTHING owed (a free check). */
  function sitOutOnTurn(tournament: boolean) {
    const w = world({ tournament });
    w.playerSessions.set('S-A', { socketId: 'S-A', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice', sittingOut: false });
    expect(w.table.startNewHand()).toBe(true);
    const owedNow = () => w.table.currentBetToMatch - w.table.seats[0].currentBet;
    for (let g = 0; g < 10 && !(w.table.activeSeatIndex === 0 && owedNow() === 0); g++) {
      const a = w.table.activeSeatIndex;
      if (!w.table.playerCall(a)) w.table.playerCheck(a);
    }
    expect(w.table.activeSeatIndex).toBe(0);
    const owed = owedNow();
    expect(owed).toBe(0);
    const actions: Array<[number, PlayerAction]> = [];
    w.table.on('playerAction', (d: { seatIndex: number; action: PlayerAction }) => actions.push([d.seatIndex, d.action]));
    const sock: any = { id: 'S-A', handlers: {}, emit() {}, on(ev: string, fn: any) { this.handlers[ev] = fn; } };
    w.m.wire(sock);
    return { w, sock, owed, actions };
  }
  it('tournament: a free check is CHECKED for him (P-i) — his seat stays in the hand, never a needless fold', async () => {
    const { w, sock, actions } = sitOutOnTurn(true);
    await sock.handlers.sitOut();
    expect(actions[0]).toEqual([0, PlayerAction.Check]);
    expect(w.table.seats[0].folded).toBe(false);
  });
  it('cash: unchanged — Sit Out on his turn folds (even a free check)', async () => {
    const { sock, actions } = sitOutOnTurn(false);
    await sock.handlers.sitOut();
    expect(actions[0]).toEqual([0, PlayerAction.Fold]);
  });
});

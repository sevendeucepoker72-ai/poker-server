/**
 * Bots review fix round 3 (2026-11-05) — the turn clock's own recovery.
 *
 * SR2-1. A human's own river check closes the hand and the payout throws AFTER paying
 * (buildPotBreakdown). Nothing on that path settled (socketGuard only logs), so the
 * hand rested in Showdown with the chips paid and totalInvestedThisHand not reset,
 * and his River turn clock was still armed. When it fired, onTurnTimeout took its
 * stake mark IN Showdown (isHandInProgress() is true there); a throw in its body sent
 * the hand to recoverTurnClockThrow, which saw "nothing credited since the mark" and
 * ran determineWinners again: the pot paid twice. It never checked gameShowdownHeld,
 * so a HELD hand was re-paid too. Now onTurnTimeout returns in Showdown (as
 * executeAIAction), and a recovery settles from its own mark only when that mark was
 * taken before the payout and the hand is not held.
 *
 * Requirement 5. recoverTurnClockThrow acted for the seat but skipped the timeout's
 * own consequences: noteAbsentTimeout (F10) and, at a tournament table, the owner's
 * "1 timeout = sat out" (sitOutTournamentSeatAfterTimeout). The mark is taken only
 * after every check of a REAL timeout, so the recovery now applies them too.
 *
 * REAL armTurnTimer + autoActForSeat, the absent tournament seat clock section and the
 * guard block, sliced from src/index.ts, on the REAL engine.
 *
 * Fails on 2b5ac52: SR2-1 (a) ends at 10200 with a second determineWinners, (b) unholds
 * the hand at 10200; requirement 5 leaves the seat playing and its streak unrecorded.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const T = 'T';
const TURN_MS = 30000;
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const SAS = fnSrc('function scheduleAutoStart(');
const chips = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0);

// ------------------------------------------------------------------ SR2-1 ----

function world(throwOnFire: number | null) {
  let now = 1_000_000; let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
  const c = { escaped: 0, fires: 0, determineWinners: 0, handResults: 0 };
  const t = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
  t.sitDown(0, 'H0', 5000, 'player-0', false);
  t.sitDown(1, 'H1', 5000, 'player-1', false);
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
    GamePhase, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
    pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null, scheduleAIAction() {},
    setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    Date: class FakeDate extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error() {} },
    tournamentTables: new Map(), brokenTournamentTables: new Map(), playerSessions: new Map(), sitOutTracker: new Map(), reservedSeats: new Map(),
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000,
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    log: { debug() {}, info: (m: string) => { if (String(m).includes('timed out')) c.fires++; } },
    isTournamentTable: () => false, isAbsentTournamentSeatPastHandLimit: () => false,
    absentSeatOnShortClock: () => false, clearAbsentTimeoutStreak() {}, noteAbsentTimeout() {},
    sitOutTournamentSeatAfterTimeout: () => false, tournamentTimeoutSitOutStats: { shortClockRearmed: 0 },
  };
  const code = [slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"), fnSrc('function armTurnTimer('), GUARD, SAS].join('\n');
  const { exports: m } = load(code, scope, '{ armTurnTimer, scheduleAutoStart, gameTimerGuardStats, gameShowdownHold, gameShowdownHeld }');
  scope.scheduleAutoStart = m.scheduleAutoStart;
  // index.ts broadcastGameState arms the turn clock first (armTurnTimer), then sends frames.
  scope.broadcastGameState = () => { m.armTurnTimer(T); if (throwOnFire !== null && c.fires === throwOnFire) { throwOnFire = null; throw new TypeError('injected broadcast fault'); } };
  t.on('turnChanged', () => m.armTurnTimer(T));   // ensureTurnTimerWired
  t.on('handResult', () => { c.handResults++; });
  const realDW = (t as any).determineWinners.bind(t);
  (t as any).determineWinners = () => { c.determineWinners++; return realDW(); };
  const advance = (ms: number) => {
    const until = now + ms;
    for (let g = 0; g < 1000; g++) {
      jobs.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!jobs.length || jobs[0].at > until) break;
      const j = jobs.shift()!; now = j.at;
      try { j.fn(); } catch { c.escaped++; }
    }
    now = until;
  };
  /** Both humans act themselves to the river; the closing river check's payout throws after paying. */
  const faultedRiver = () => {
    expect(t.startNewHand()).toBe(true);
    m.armTurnTimer(T);
    for (let g = 0; g < 40 && t.currentPhase !== GamePhase.River; g++) { const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a); }
    expect(t.playerCheck(t.activeSeatIndex)).toBe(true);
    const real = (t as any).buildPotBreakdown.bind(t);
    let left = 1;
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left-- > 0) throw new TypeError('injected post-payment fault'); return real(...a); };
    expect(() => t.playerCheck(t.activeSeatIndex)).toThrow('injected post-payment fault');   // socketGuard's catch
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(chips(t)).toBe(10000);                      // the 200 pot is already paid
    c.determineWinners = 0;
  };
  return { t, m, c, advance, faultedRiver };
}

describe('SR2-1 — the turn clock never re-pays a hand already resting in Showdown', () => {
  it('un-held: the clock fires on the Showdown table and its broadcast throws -> no second payout', () => {
    const w = world(1);
    w.faultedRiver();
    w.advance(TURN_MS + 500);
    expect(w.c.escaped).toBe(0);
    expect(w.c.determineWinners).toBe(0);
    expect(w.c.handResults).toBe(0);
    expect(chips(w.t)).toBe(10000);                    // 2b5ac52: 10200
  });

  it('HELD: neither the River clock nor a clock armed in Showdown settles a held hand, even when they throw', () => {
    for (const fire of [1, 2]) {
      const w = world(fire);
      w.faultedRiver();
      w.m.gameShowdownHold.set(w.t, w.t.handNumber);
      w.advance(5 * 60_000);
      expect(w.c.escaped).toBe(0);
      expect(w.m.gameShowdownHeld(w.t)).toBe(true);    // 2b5ac52: false
      expect(w.c.determineWinners).toBe(0);
      expect(chips(w.t)).toBe(10000);                  // 2b5ac52: 10200
    }
  });

  it('source: onTurnTimeout returns in Showdown before its mark; every timer recovery settles from its own mark only when taken before the payout and the hand is not held', () => {
    const arm = fnSrc('function armTurnTimer(');
    const ret = arm.indexOf('if (t.currentPhase === GamePhase.Showdown) return;');
    expect(ret).toBeGreaterThan(0);
    expect(ret).toBeLessThan(arm.indexOf('const mark = {'));
    expect(GUARD).toContain('if (mark && t.handNumber === mark.hand && mark.phase !== GamePhase.Showdown && !gameShowdownHeld(t)) settleShowdownAfterFault(tableId, t, mark);');
    // no recovery settles from a timer's mark any other way
    expect(GUARD.split('settleShowdownAfterFault(tableId, t, mark)').length - 1).toBe(1);
    expect(GUARD).not.toContain('settleShowdownAfterFault(tableId, drawTable, mark)');
  });
});

// ---------------------------------------------------------- requirement 5 ----

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
};

function tournamentWorld(opts: { broadcast?: () => void } = {}) {
  const table = new PokerTable({ tableId: 't1', tableName: 't1', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
  expect(table.sitDown(0, 'Alice', 7000, 'p-alice', false, true)).toBe(true);
  expect(table.sitDown(1, 'Bob', 5000, 'p-bob', false, true)).toBe(true);
  const tournamentTables = new Map<string, string>([['t1', 'T-1']]);
  const playerSessions = new Map<string, any>();
  const sitOutTracker = new Map<string, Set<number>>();
  const emitted: Array<[string, string, any]> = [];
  const sockets = new Map<string, any>();
  const errors: string[] = [];
  for (const sid of ['S-A', 'S-B']) sockets.set(sid, { id: sid, connected: true, emit: (ev: string, d: any) => emitted.push([sid, ev, d]) });
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
    tournamentTables, playerSessions, multiTableSessions: new Map(), sitOutTracker, reservedSeats: new Map(),
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(),
    MAX_SEATS: 9, TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS: SHORT_MS, DrawPhases: [], GamePhase, FiveCardDrawTable,
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    qualifierIdOfTable: () => null, tournamentIdOfTable: () => 'T-1',
    io: { sockets: { sockets } },
    broadcastGameState: () => { if (opts.broadcast) opts.broadcast(); }, scheduleAIAction() {}, pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {},
    Sentry: null, console: { log() {}, warn() {}, error: (m: unknown) => errors.push(String(m)) },
    log: { debug() {}, info() {} },
  };
  const code = `${P.broken}\n${P.isTournamentReservation}\n${P.sync}\n${P.liveSession}\n${P.pastLimit}\n${P.autoAct}\n${P.absentClock}\n${P.armTurnTimer}\n${GUARD}\n${SAS}`;
  const { exports: m, stubbed } = load(code, scope,
    '{ armTurnTimer, scheduleAutoStart, tournamentTimeoutSitOutStats, absentTimeoutStreaks, gameTimerGuardStats }');
  scope.scheduleAutoStart = m.scheduleAutoStart;
  playerSessions.set('S-A', { socketId: 'S-A', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice', sittingOut: false });
  playerSessions.set('S-B', { socketId: 'S-B', tableId: 't1', seatIndex: 1, playerName: 'Bob', playerId: 'p-bob', sittingOut: false });
  /** Deal and bring the action to Alice (Bob calls / checks to her); arm her clock. */
  const aliceToAct = () => {
    expect(table.startNewHand()).toBe(true);
    for (let g = 0; g < 8 && table.activeSeatIndex !== 0 && table.isHandInProgress(); g++) {
      const a = table.activeSeatIndex;
      if (!table.playerCall(a)) table.playerCheck(a);
    }
    expect(table.activeSeatIndex).toBe(0);
    m.armTurnTimer('t1');
  };
  /** The clock's own action for Alice throws once, inside the engine (a 'playerAction' listener). */
  const throwOnAlicesTimedOutAction = () => {
    let armed = true;
    table.on('playerAction', (e: any) => { if (armed && e?.seatIndex === 0) { armed = false; throw new TypeError('injected playerAction listener fault'); } });
  };
  const tagged = () => errors.filter((l) => l.startsWith('[game-timer-error] ')).map((l) => JSON.parse(l.slice('[game-timer-error] '.length)));
  return { m, stubbed, table, playerSessions, sitOutTracker, emitted, aliceToAct, throwOnAlicesTimedOutAction, tagged };
}

describe('requirement 5 — a turn clock that threw still applies the timeout\'s consequences', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('tournament, Alice connected: her timed-out action throws inside the engine -> recovered AND she is sat out (owner "After 1")', () => {
    const w = tournamentWorld();
    w.aliceToAct();
    w.throwOnAlicesTimedOutAction();
    expect(() => jest.advanceTimersByTime(TURN_TIMEOUT_MS)).not.toThrow();
    expect(w.m.gameTimerGuardStats).toMatchObject({ turnClockThrows: 1, recoveryThrows: 0 });
    expect(w.tagged()[0]).toMatchObject({ kind: 'turn_clock', tableId: 't1', seatIndex: 0, error: 'injected playerAction listener fault' });
    expect(w.table.activeSeatIndex).not.toBe(0);                          // the turn moved on
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);           // 2b5ac52: false
    expect(w.sitOutTracker.get('t1')?.has(0)).toBe(true);
    // + the league first-hour fields (review fix 2026-11-26): not a league night -> null / false.
    expect(w.emitted).toContainEqual(['S-A', 'sitOutToggled', { sittingOut: true, reason: 'timeout', tableId: 't1', protectedUntil: null, noShowDue: false }]);
    expect(w.m.tournamentTimeoutSitOutStats).toMatchObject({ satOut: 1, sessionsMarked: 1 });
    expect(w.playerSessions.get('S-B').sittingOut).toBe(false);
    expect([...w.stubbed].filter((n) => /noteAbsentTimeout|sitOutTournamentSeatAfterTimeout|armTurnTimer|turnTimers|turnStartedSeatMap|tournamentTimeoutSitOutStats/.test(n))).toEqual([]);
  });

  it('tournament, Alice ABSENT (no session): the throw still records her timed-out hand (F10 streak), once per hand', () => {
    const w = tournamentWorld();
    w.playerSessions.delete('S-A');
    w.aliceToAct();
    w.throwOnAlicesTimedOutAction();
    expect(() => jest.advanceTimersByTime(TURN_TIMEOUT_MS)).not.toThrow();
    expect(w.m.gameTimerGuardStats.turnClockThrows).toBe(1);
    const rec = w.m.absentTimeoutStreaks.get(`t1:0:p-alice`);
    expect(rec).toEqual({ hand: w.table.handNumber, streak: 1 });        // 2b5ac52: undefined
  });

  it('CONTROL — a clock that does not throw: the same consequences, exactly once', () => {
    const w = tournamentWorld();
    w.aliceToAct();
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(w.m.gameTimerGuardStats.turnClockThrows).toBe(0);
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);
    expect(w.emitted.filter(([s, ev]) => s === 'S-A' && ev === 'sitOutToggled')).toHaveLength(1);
    expect(w.m.tournamentTimeoutSitOutStats.satOut).toBe(1);
  });

  it('the consequences are idempotent: a throw AFTER the normal path ran them (its broadcast) does not sit him out twice', () => {
    let armed = true;
    const w = tournamentWorld({ broadcast: () => { if (armed) { armed = false; throw new TypeError('injected broadcast fault'); } } });
    w.aliceToAct();
    expect(() => jest.advanceTimersByTime(TURN_TIMEOUT_MS)).not.toThrow();
    expect(w.m.gameTimerGuardStats).toMatchObject({ turnClockThrows: 1, recoveryThrows: 0 });
    expect(w.playerSessions.get('S-A').sittingOut).toBe(true);
    expect(w.m.tournamentTimeoutSitOutStats.satOut).toBe(1);
    expect(w.emitted.filter(([sid, ev, d]) => sid === 'S-A' && ev === 'sitOutToggled' && d.reason === 'timeout')).toHaveLength(1);
  });
});

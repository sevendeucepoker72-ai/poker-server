/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F3) — actions the
 * SERVER takes for a player are marked in the hand history: an additive
 * actionLog field `auto` — 'timeout' (the turn clock ran out: normal or short
 * clock) or 'away' (the 500 ms orphan act, a Sit Out / AFK on his own turn, a
 * departure acted for on the clock). The replay / history shows '(timed out)'.
 * A voluntary action has no `auto` key; entries for OTHER seats pushed during
 * the auto action (an uncalled bet returned to the winner) are never stamped;
 * players[].actions strings are unchanged.
 *
 * Engine: PokerTable.markAutoAction (one shot, expires at the next decision
 * point) / withAutoAction (scoped). index.ts: autoActForSeat(…, reason) — the
 * turn clock passes 'timeout'. The REAL index.ts source (sliced) on the REAL PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const constOf = (name: string): number => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return Number(m[1].replace(/_/g, ''));
};
const TURN_TIMEOUT_MS = constOf('TURN_TIMEOUT_MS');

function table(n = 2, chips = 5000): PokerTable {
  const t = new PokerTable({ tableId: 't1', tableName: 't1', smallBlind: 25, bigBlind: 50, minBuyIn: 100, maxBuyIn: 100000, maxPlayers: 9 } as any);
  for (let i = 0; i < n; i++) t.sitDown(i, `P${i}`, chips, `p${i}`, false);
  return t;
}
const last = (t: PokerTable) => t.actionLog[t.actionLog.length - 1] as any;

describe('F3 — the engine stamps a server-taken action', () => {
  it("withAutoAction(s, 'timeout', fold) → the fold entry carries auto:'timeout'; a voluntary fold has no auto key", () => {
    const t = table(3);
    expect(t.startNewHand()).toBe(true);
    const a = t.activeSeatIndex;
    (t as any).withAutoAction(a, 'timeout', () => t.playerFold(a));
    expect(last(t)).toMatchObject({ seatIndex: a, action: 'folded', auto: 'timeout' });
    const b = t.activeSeatIndex;
    t.playerFold(b);
    const mine = t.actionLog.filter((e) => e.seatIndex === b && e.action === 'folded');
    expect(mine).toHaveLength(1);
    expect('auto' in mine[0]).toBe(false);
  });

  it("markAutoAction is one shot: the next action of THAT seat is stamped, nothing after it; another seat's action is never stamped", () => {
    const t = table(3);
    expect(t.startNewHand()).toBe(true);
    const a = t.activeSeatIndex;
    (t as any).markAutoAction(a, 'away');
    t.playerCall(a);
    expect(last(t)).toMatchObject({ seatIndex: a, auto: 'away' });
    const b = t.activeSeatIndex;
    t.playerCall(b);
    expect('auto' in last(t)).toBe(false);
    // A mark for a seat that is not to act expires at the next decision point.
    const c = t.activeSeatIndex;
    (t as any).markAutoAction(a, 'away');
    t.playerCheck(c);   // the big blind checks: a new street (a new decision point)
    expect(t.currentPhase).toBe(GamePhase.Flop);
    const firstFlop = t.activeSeatIndex;
    t.playerCheck(firstFlop);
    expect('auto' in last(t)).toBe(false);
  });

  it("a heads-up timeout fold that ends the hand: the saved hand's actionLog has auto:'timeout' on the fold, none on the winner's uncalled-bet line", () => {
    const t = table(2);
    let hh: any = null;
    t.on('handHistory', (h: any) => { hh = h; });
    expect(t.startNewHand()).toBe(true);
    const a = t.activeSeatIndex;
    expect(t.playerRaise(a, 200)).toBe(true);
    const b = t.activeSeatIndex;
    (t as any).withAutoAction(b, 'timeout', () => t.playerFold(b));
    expect(hh).toBeTruthy();
    const fold = hh.actionLog.find((e: any) => e.seatIndex === b && e.action === 'folded');
    expect(fold.auto).toBe('timeout');
    const unc = hh.actionLog.find((e: any) => /^uncalled bet/.test(e.action));
    expect(unc).toBeTruthy();
    expect('auto' in unc).toBe(false);
    // players[].actions strings are unchanged.
    expect(hh.players.find((p: any) => p.seatIndex === b).actions).toContain('folded');
  });
});

describe("F3 — index.ts: the server's action for a seat is stamped (autoActForSeat), the turn clock as 'timeout'", () => {
  function world() {
    const t = table(3);
    const tournamentTables = new Map<string, string>();
    const playerSessions = new Map<string, any>();
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 't1' ? t : undefined) },
      tournamentTables, brokenTournamentTables: new Map(), playerSessions, sitOutTracker: new Map(), reservedSeats: new Map(),
      tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), MAX_SEATS: 9,
      TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000, DrawPhases: [], GamePhase,
      turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
      turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
      broadcastGameState() {}, scheduleAIAction() {}, log: { debug() {}, info() {} },
      isTournamentTable: (id: string) => tournamentTables.has(id),
      isAbsentTournamentSeatPastHandLimit: () => false, tournamentSeatSitsOut: () => false,
    };
    const code = [
      slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
      fnSrc('function armTurnTimer('),
    ].join('\n');
    const { exports: m, stubbed } = load(code, scope, '{ autoActForSeat, armTurnTimer }');
    return { t, m, stubbed, scope };
  }
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("autoActForSeat(..., 'timeout'): a free check logs 'checked' with auto:'timeout'; a fold facing a bet the same; the default reason is 'away'", () => {
    const w = world();
    expect(w.t.startNewHand()).toBe(true);
    // Pre-flop: the first actor faces the big blind -> fold, stamped.
    const a = w.t.activeSeatIndex;
    expect(w.m.autoActForSeat('t1', w.t, a, 'timeout')).toBe('fold');
    expect(last(w.t)).toMatchObject({ seatIndex: a, action: 'folded', auto: 'timeout' });
    const b = w.t.activeSeatIndex;
    w.t.playerCall(b);
    // The big blind with the option: a free check, stamped (default reason 'away').
    const c = w.t.activeSeatIndex;
    expect(w.m.autoActForSeat('t1', w.t, c)).toBe('check');
    expect(last(w.t)).toMatchObject({ seatIndex: c, action: 'checked', auto: 'away' });
  });

  it(`armTurnTimer: the ${TURN_TIMEOUT_MS} ms clock running out stamps 'timeout' (e038f7b: no stamp)`, () => {
    const w = world();
    expect(w.t.startNewHand()).toBe(true);
    const a = w.t.activeSeatIndex;
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(TURN_TIMEOUT_MS + 10);
    const e = w.t.actionLog.find((x) => x.seatIndex === a && x.street === GamePhase.PreFlop) as any;
    expect(e).toMatchObject({ action: 'folded', auto: 'timeout' });
    expect(SRC).toContain("const did = autoActForSeat(tableId, t, activeSeat, 'timeout');");
  });

  it("wiring: the 500 ms orphan act and the departure / Sit Out paths act as 'away'", () => {
    const bc = slice('function broadcastGameState(', '\n}\n');
    expect(bc).toContain('autoActForSeat(tableId, t, activeIdx);');
    expect(fnSrc('function autoActForSeat(')).toContain("reason: 'timeout' | 'away' = 'away'");
    // Every departure / cash sit-out fold on the clock is marked 'away'.
    expect((SRC.match(/markAutoAction\([^)]*'away'\)/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});

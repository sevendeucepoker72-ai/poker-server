/**
 * Bots review fix round 4 — the server lane after the adversarial reviews of c97254b (2026-11-08).
 *
 * SERVER-R3-REG-PAYABLE-1 (P2) — payoutStartMark.payable marked a BUSTED seat (eliminated, 0 chips,
 *   no cards, nothing in) payable; its leave while the hand waited for the watchdog's settle HELD the
 *   hand for good (the table frozen; the shutdown flush then credited the paid pot a second time).
 *   Now: payable is exactly determineWinners' own exclusions; a seat of the mark stood up while the
 *   payout rests is recorded on the mark (`left`, whatever path stood it up) and read by the settle;
 *   the shutdown flush / a forced close / a quick game's cleanup cash a resting Showdown out as its
 *   payout mark reads it (restingShowdownHoldings: never stack + invested on a paid pot); a hand
 *   still unreadable stays HELD (no automatic choice is chip-safe there — see resolveHeldShowdown),
 *   visible in health (crashSafety.heldShowdowns) and ended by an admin ('adminResolveHeldHand').
 *   The engine never folds a leaver in Showdown (forceFoldSeat), so a settle's retry pays him.
 * SERVER-R3-REG-3 (P3) — a sticky check / fold throw looped the 500 ms orphan / sit-out auto-act at
 *   2 Hz without end, and every broadcast added one more chain; the same loop ran for a bot's action
 *   at its think delay. Now one pending auto-act per (table, seat), and neither actor is re-armed for
 *   a turn on which it threw 3 times (absentActGiveUps / botActionGiveUps): the turn is then its turn
 *   clock's and the wedge watchdog's.
 * SERVER-R3-FAULT-LENS-1 (P3) — a pending bomb pot's all-in runout ran OUTSIDE the guarded deal at
 *   dealAfterJoin / 'startHand' / the club challenge sweep: its payout fault rested in Showdown until
 *   the watchdog's tick, and a settled deal then dropped the pending bomb pot. Now inside it.
 *
 * REAL code sliced from src/index.ts (socket handlers behind the REAL socketGuard, the turn clock, the
 * guard block, the seat teardown, the wedge watchdog, the 500 ms auto-act, scheduleAIAction,
 * dealAfterJoin + activateBombPotIfPending, claimSeatsForShutdown, the admin handler) on the REAL
 * engine, on a manual clock. Each regression describe fails on c97254b.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { installSocketListenerGuard } from '../src/socketGuard';
import { SRC, slice, fnSrc, load, handlerSrc, SEAT_SESSION_FOR_SRC, SEAT_TEARDOWN_SRC } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const T = 'T';
const TURN_MS = 30000;
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const SAS = fnSrc('function scheduleAutoStart(');
const CLOCK = [slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"), fnSrc('function armTurnTimer(')].join('\n');
const WATCHDOG = slice('const WEDGE_TURN_GRACE_MS', '}, 15000);');
const ON_ERR = slice('    onHandlerError: (event, err) => {', '    },\n');
const HANDLERS = handlerSrc('action', '\n  );\n');
const AUTO_ACT = slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n");
const ORPHAN_BLOCK = slice('    if (shouldAutoAct) {', '      }, 500);\n    }\n');
const ORPHAN = `function orphanAct(tableId, activeIdx) {\n  const shouldAutoAct = true;\n${ORPHAN_BLOCK}}\n`;
const SCHEDULE_AI = fnSrc('function scheduleAIAction(');

type Fault = 'pre' | 'post' | 'mid' | 'sticky';
const stacks = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0);
const invested = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? (s.totalInvestedThisHand || 0) : 0), 0);
const total = (t: PokerTable) => stacks(t) + invested(t);
const cfg = { tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any;

/** pre = awardPots throws before any chip moves; post / sticky = buildPotBreakdown throws after every chip is paid; mid = the credit loop pays half the first winner's chips, then throws. */
function injectFault(t: PokerTable, f: Fault): void {
  const spm = (t as any).sidePotManager;
  if (f === 'pre') {
    const real = spm.awardPots.bind(spm); let left = 1;
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return real(...a); };
  } else if (f === 'mid') {
    const real = spm.awardPots.bind(spm); let left = 1;
    spm.awardPots = (...a: any[]) => {
      const r = real(...a);
      if (left <= 0) return r;
      left--;
      const first = [...r.winnings][0];
      return { ...r, winnings: { *[Symbol.iterator]() { yield [first[0], Math.floor(first[1] / 2)]; throw new TypeError('injected part-paid fault'); } } };
    };
  } else {
    const real = (t as any).buildPotBreakdown.bind(t);
    let left = f === 'post' ? 1 : Infinity;
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected post-payment fault'); } return real(...a); };
  }
}
const OUTCOME: Record<Fault, string> = { pre: 'showdownResolved', post: 'showdownPaidFinished', mid: 'showdownVoided', sticky: 'showdownPaidFinished' };

/** The socket / watchdog world (as fix3ReviewFixups'), with the teardown and the round-4 helpers exported. */
function world(table: PokerTable, nSessions: number) {
  const t = table;
  let now = 1_000_000; let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void; every?: number }> = [];
  const c = { handResults: 0, errors: [] as string[], escaped: 0, advancedInShowdown: 0, credits: [] as Array<[number, number, string]>, sentry: 0 };
  t.on('handResult', () => { c.handResults++; });
  const realAdvance = (t as any).advanceTurn.bind(t);
  (t as any).advanceTurn = () => { if (t.currentPhase === GamePhase.Showdown) c.advancedInShowdown++; return realAdvance(); };
  const playerSessions = new Map<string, any>();
  for (let i = 0; i < nSessions; i++) playerSessions.set(`sock-${i}`, { tableId: T, seatIndex: i, playerId: `player-${i}`, playerName: `H${i}`, sittingOut: false });
  const pendingAutoStartTimers = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }], getAllTableIds: () => [T] },
    GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
    pendingAutoStartTimers, pendingSeatRemovalAfterHand: new Map(), Sentry: null,
    playerSessions, multiTableSessions: new Map(), actionNonces: new Map(), actionTimings: new Map(),
    allInOrFoldTables: new Set(), allInOrFoldAllows: () => true,
    getGameStateForPlayer: () => ({}), emitGameState() {}, returnTournamentSessionFromSitOut() {},
    scheduleAIAction() {}, clearHandSnapshot: async () => {}, syncSitOutToTable() {},
    autoStartNextHand: () => { if (t.currentPhase === GamePhase.HandComplete && t.startNewHand()) (scope.broadcastGameState as any)(T); },
    setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    setInterval: (fn: () => void, ms: number) => { const id = nextId++; jobs.push({ id, at: now + ms, fn, every: ms }); return id; },
    Date: class FakeDate extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error: (m: unknown) => c.errors.push(String(m)) },
    tournamentTables: new Map(), brokenTournamentTables: new Map(), sitOutTracker: new Map(), reservedSeats: new Map(),
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000,
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    log: { debug() {}, info() {} },
    isTournamentTable: () => false, isAbsentTournamentSeatPastHandLimit: () => false, absentSeatOnShortClock: () => false,
    clearAbsentTimeoutStreak() {}, noteAbsentTimeout() {}, sitOutTournamentSeatAfterTimeout: () => false,
    tournamentTimeoutSitOutStats: { shortClockRearmed: 0 }, tournamentSeatForStaleTable: () => undefined,
    isFixedRosterQuickTable: () => false, isPrizeFormatTable: () => false, noteBotStackRemoved() {}, endStaleSessionsAtSeat() {},
    aiProfiles: new Map(), aiTimeouts: new Map(), quickTables: new Set(), dealersChoiceState: new Map(),
    creditSeatStackToWallet: (userId: number, _u: string, _tid: string, seat: any, reason: string) => { c.credits.push([userId, seat.chipCount, reason]); return Promise.resolve(true); },
    isDeadTournamentSeat: () => false, SEAT_RESERVE_MS: 600_000, DISCONNECT_HANDS_LIMIT: 20, shutdownFlushActive: () => false,
    seatHasAnySession: (_tid: string, i: number) => i < nSessions,
    authSessions: new Map(), auditLog() {},
  };
  const code = [
    CLOCK, GUARD, SAS, fnSrc('function processPendingSeatRemovals('), SEAT_TEARDOWN_SRC,
    `function makeGuardOpts() { return { log: (line) => console.error(line),\n${ON_ERR} }; }`,
    `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${HANDLERS}\n}`,
    WATCHDOG,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope,
    '{ armTurnTimer, scheduleAutoStart, processPendingSeatRemovals, teardownSeat, gameTimerGuardStats, gameShowdownHeld, wire, makeGuardOpts, restingShowdownHoldings, heldShowdownsNow, resolveHeldShowdown }');
  scope.scheduleAutoStart = m.scheduleAutoStart;
  const wired = new Set<any>();
  scope.broadcastGameState = (id: string) => {
    if (!wired.has(t)) { wired.add(t); t.on('turnChanged', () => m.armTurnTimer(id)); }
    m.armTurnTimer(id);
  };
  t.on('handResult', () => { m.processPendingSeatRemovals(T); m.scheduleAutoStart(T); });
  const socks = [...playerSessions.keys()].map((id) => {
    const handlers = new Map<string, (d: unknown) => unknown>();
    const s: any = {
      id, connected: true,
      on(ev: string, fn: (d: unknown) => unknown) { handlers.set(ev, fn); return s; },
      emit() { return true; },
      receive(ev: string, payload: unknown) { const r: any = handlers.get(ev)?.(payload); if (r && typeof r.then === 'function') r.then(() => {}, () => {}); return r; },
    };
    const opts = m.makeGuardOpts();
    const orig = opts.onHandlerError;
    opts.onHandlerError = (ev: string, err: unknown) => { c.sentry++; orig(ev, err); };
    installSocketListenerGuard(s, opts);
    m.wire(s);
    return s;
  });
  let nonce = 0;
  const act = (seat: number, type: string, amount?: number) => socks[seat].receive('action', { type, amount, nonce: `n${++nonce}` });
  const advance = (ms: number) => {
    const until = now + ms;
    for (let g = 0; g < 100_000; g++) {
      jobs.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!jobs.length || jobs[0].at > until) break;
      const j = jobs.shift()!;
      now = j.at;
      if (j.every) jobs.push({ id: nextId++, at: now + j.every, fn: j.fn, every: j.every });
      try { j.fn(); } catch (e) { c.escaped++; c.errors.push(`ESCAPED ${String((e as Error)?.message || e)}`); }
    }
    now = until;
  };
  const stats = () => { const s = { ...m.gameTimerGuardStats }; delete s.lastAt; return s; };
  const deal = () => { expect(t.startNewHand()).toBe(true); (scope.broadcastGameState as any)(T); };
  const credited = () => c.credits.reduce((a, x) => a + x[1], 0);
  return { t, m, c, stubbed, socks, act, advance, stats, deal, scope, credited };
}
type W = ReturnType<typeof world>;

/** The live seats check / call to the river through the socket handler; returns the seat whose check closes it. */
function toRiver(w: W): number {
  for (let g = 0; g < 60 && w.t.currentPhase !== GamePhase.River; g++) {
    w.advance(500);
    const a = w.t.activeSeatIndex;
    w.act(a, w.t.currentBetToMatch - (w.t.seats[a].currentBet || 0) > 0 ? 'call' : 'check');
  }
  expect(w.t.currentPhase).toBe(GamePhase.River);
  for (let g = 0; g < 6; g++) {
    const live = w.t.seats.filter((s) => s.state === 'occupied' && !s.folded && s.holeCards.length > 0 && !s.allIn);
    const toAct = live.filter((s) => !s.hasActedSinceLastFullRaise);
    if (toAct.length <= 1) break;
    w.advance(500);
    w.act(w.t.activeSeatIndex, 'check');
  }
  return w.t.activeSeatIndex;
}

/** A hand left resting in Showdown by a path with no settle of its own (the engine called bare, as a pending bomb pot's runout was): the watchdog's. */
function restingShowdown(fault: Fault, opts: { busted?: boolean; seats?: number } = {}) {
  const t = new PokerTable(cfg);
  const n = opts.seats ?? 2;
  for (let i = 0; i < n; i++) t.sitDown(i, `H${i}`, 5000, `player-${i}`, false);
  if (opts.busted) { expect(t.sitDown(n, `H${n}`, 100, `player-${n}`, false)).toBe(true); t.seats[n].chipCount = 0; }   // a cash seat at 0, waiting to rebuy / leave
  const w = world(t, n + (opts.busted ? 1 : 0));
  w.deal();
  const start = total(t);
  const closer = toRiver(w);
  injectFault(t, fault);
  expect(() => t.playerCheck(closer)).toThrow();
  expect(t.currentPhase).toBe(GamePhase.Showdown);
  return { w, t, start };
}

describe('SERVER-R3-REG-PAYABLE-1 — the engine: payoutStartMark.payable is exactly what determineWinners can credit', () => {
  it('a BUSTED seat (eliminated at the deal: 0 chips, no cards, nothing in) is not payable (c97254b: payable); the two contesting seats are', () => {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 5000, 'player-0', false);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(t.sitDown(2, 'H2', 100, 'player-2', false)).toBe(true);
    t.seats[2].chipCount = 0;
    expect(t.startNewHand()).toBe(true);
    expect(t.seats[2]).toMatchObject({ eliminated: true, folded: false, holeCards: [], totalInvestedThisHand: 0 });
    for (let g = 0; g < 40 && t.isHandInProgress(); g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.payoutStartMark!.payable.slice(0, 3)).toEqual([true, true, false]);
    expect(t.payoutStartMark!.left.every((x) => x === null)).toBe(true);
  });

  it('a seat of the mark stood up while the payout rests in Showdown is recorded on the mark (what it held); outside Showdown nothing is recorded', () => {
    const { t } = restingShowdown('post');
    const holding = t.seats[1].chipCount + t.seats[1].totalInvestedThisHand;
    const inv = t.seats[1].totalInvestedThisHand;
    expect(t.standUp(1)).toBe(true);
    expect(t.payoutStartMark!.left[1]).toEqual({ holding, invested: inv });
    expect(t.sitDown(1, 'J', 777, 'joiner', false)).toBe(true);
    expect(t.standUp(1)).toBe(true);                                     // a later occupant's leave never overwrites it
    expect(t.payoutStartMark!.left[1]).toEqual({ holding, invested: inv });
    const u = new PokerTable(cfg);
    u.sitDown(0, 'H0', 5000, 'player-0', false); u.sitDown(1, 'H1', 5000, 'player-1', false); u.sitDown(2, 'H2', 5000, 'player-2', false);
    expect(u.startNewHand()).toBe(true);
    expect(u.standUp(2)).toBe(true);
    expect(u.payoutStartMark).toBeNull();
  });

  it('forceFoldSeat refuses in Showdown (a leaver keeps his tabled hand for the settle); CONTROL: it folds mid-hand', () => {
    const { t } = restingShowdown('pre');
    expect(t.forceFoldSeat(0)).toBe(false);
    expect(t.seats[0].folded).toBe(false);
    const u = new PokerTable(cfg);
    u.sitDown(0, 'H0', 5000, 'player-0', false); u.sitDown(1, 'H1', 5000, 'player-1', false); u.sitDown(2, 'H2', 5000, 'player-2', false);
    expect(u.startNewHand()).toBe(true);
    const off = [0, 1, 2].find((i) => i !== u.activeSeatIndex)!;
    expect(u.forceFoldSeat(off)).toBe(true);
  });
});

describe('SERVER-R3-REG-PAYABLE-1 — the reviewer\'s probe: a busted seat leaves while the hand waits for the watchdog settle (c97254b: HELD for good)', () => {
  it.each<[Fault]>([['pre'], ['post'], ['mid']])('%s-payment fault: settled at the first tick, never held, chips conserved for 10 minutes, play goes on', (fault) => {
    const { w, t, start } = restingShowdown(fault, { busted: true });
    expect(t.payoutStartMark!.payable[2]).toBe(false);
    w.m.teardownSeat(T, t, 2, { userId: 9, username: 'b' }, 'handlePlayerLeave');
    expect(t.seats[2].state).toBe('empty');
    w.advance(15_000);
    expect(t.currentPhase).not.toBe(GamePhase.Showdown);
    expect(w.m.gameShowdownHeld(t)).toBe(false);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 0, [OUTCOME[fault]]: 1 });
    w.advance(600_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(total(t) + w.credited()).toBe(start);
    expect(t.handNumber).toBeGreaterThan(5);
  });

  it('CONTROL — the busted seat stays: settled at the first tick as before', () => {
    const { w, t, start } = restingShowdown('post', { busted: true });
    w.advance(15_000);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 0, showdownPaidFinished: 1 });
    expect(total(t)).toBe(start);
  });
});

describe('SERVER-R3-REG-PAYABLE-1 (a) — a PAYABLE seat stood up in the wait (an unnamed path that cashes it out as the flush would) is read from the mark: settled, never held', () => {
  /** Heads-up; `who` (the winner / the loser of the faulted payout) is stood up 5 s into the wait, cashed out what restingShowdownHoldings says. */
  function leaves(fault: Fault, who: 'winner' | 'loser') {
    const { w, t, start } = restingShowdown(fault);
    const p = t.payoutStartMark!;
    const gained = [0, 1].map((i) => t.seats[i].chipCount + t.seats[i].totalInvestedThisHand - p.stakes[i]);
    // pre: nothing paid (both 0); post / mid: the winner gained.
    const winner = gained[0] > gained[1] ? 0 : gained[1] > gained[0] ? 1 : (t.seats[0].holeCards.length ? 0 : 1);
    const j = who === 'winner' ? winner : 1 - winner;
    w.advance(5000);
    const out = w.m.restingShowdownHoldings(t)[j];
    expect(t.standUp(j)).toBe(true);
    return { w, t, start, j, out };
  }

  it.each<[Fault, 'winner' | 'loser']>([['pre', 'winner'], ['pre', 'loser'], ['post', 'winner'], ['post', 'loser'], ['mid', 'loser']])(
    '%s-payment fault, the %s leaves: the watchdog settles it (c97254b: HELD), chips conserved counting what he took', (fault, who) => {
      const { w, t, start, out } = leaves(fault, who);
      w.advance(10_000);
      expect(w.m.gameShowdownHeld(t)).toBe(false);
      expect(t.currentPhase).not.toBe(GamePhase.Showdown);
      expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 0, [OUTCOME[fault]]: 1 });
      expect(total(t) + out).toBe(start);
      expect(w.c.advancedInShowdown).toBe(0);
    });

  it('mid-payment fault and the part-paid WINNER leaves with more than his stake: a void cannot take it back -> HELD (listed in health), never minted', () => {
    const { w, t, start, out } = leaves('mid', 'winner');
    w.advance(10_000);
    expect(w.m.gameShowdownHeld(t)).toBe(true);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 1 });
    expect(w.m.heldShowdownsNow()).toEqual([{ tableId: T, handNumber: t.handNumber, since: expect.any(String), reason: 'departed_gain' }]);
    expect(total(t) + out).toBe(start);                                  // nothing minted while it waits
    // he took his stake (the flush rule); the admin's void puts the other payable seat back to his: exact
    expect(w.m.resolveHeldShowdown(T, t, 'void')).not.toBeNull();
    expect(total(t) + out).toBe(start);
  });
});

describe('SERVER-R3-REG-PAYABLE-1 (a) — a hand still unreadable stays HELD (no automatic choice is chip-safe), visible, and an admin ends it', () => {
  /** post-payment fault; then 300 chips leave the WINNER's stack by an unknown path: the mark cannot say what was paid. */
  function unreadable() {
    const { w, t, start } = restingShowdown('post');
    const p = t.payoutStartMark!;
    const winner = [0, 1].find((i) => t.seats[i].chipCount + t.seats[i].totalInvestedThisHand > p.stakes[i])!;
    const pot = t.seats[0].totalInvestedThisHand + t.seats[1].totalInvestedThisHand;
    t.seats[winner].chipCount -= pot + 300;                              // now BELOW his stake: d < 0
    return { w, t, start, winner, pot };
  }

  it('held at the first tick, still held 10 minutes later, listed in heldShowdowns with its reason', () => {
    const { w, t } = unreadable();
    w.advance(15_000);
    expect(w.m.gameShowdownHeld(t)).toBe(true);
    w.advance(600_000);
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 1 });
    expect(w.m.heldShowdownsNow()).toEqual([{ tableId: T, handNumber: 1, since: expect.any(String), reason: 'unreadable_stakes' }]);
    expect(w.c.advancedInShowdown).toBe(0);
  });

  it("the admin's 'finish': the stacks stand as they are (no chip created), the hand ends, the next deal follows", () => {
    const { w, t } = unreadable();
    w.advance(15_000);
    const chips = stacks(t);
    const r = w.m.resolveHeldShowdown(T, t, 'finish');
    expect(r).toMatchObject({ after: [t.seats[0].chipCount, t.seats[1].chipCount, -1, -1, -1, -1, -1, -1, -1] });
    expect(stacks(t)).toBe(chips);
    expect(invested(t)).toBe(0);
    expect(w.stats()).toMatchObject({ heldResolvedByAdmin: 1 });
    expect(w.m.heldShowdownsNow()).toEqual([]);
    w.advance(5000);
    expect(t.handNumber).toBe(2);
  });

  it("the admin's 'void': each payable seat still the mark's back to its stake; a second call is refused (not held)", () => {
    const { w, t } = unreadable();
    w.advance(15_000);
    const p = t.payoutStartMark!;
    const r = w.m.resolveHeldShowdown(T, t, 'void');
    expect(r.after.slice(0, 2)).toEqual([p.stakes[0], p.stakes[1]]);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.m.resolveHeldShowdown(T, t, 'void')).toBeNull();
  });

  it('the socket handler: admins only, a resolution and a held hand required, audited', async () => {
    const { w, t } = unreadable();
    w.advance(15_000);
    const emits: Array<[string, any]> = [];
    const audits: Array<[string, string, any]> = [];
    let admin = false;
    const scope: Record<string, unknown> = {
      authSessions: new Map([['A', { userId: 1, username: 'admin' }]]),
      isUserAdmin: async () => admin, auditLog: (u: string, a: string, d: any) => { audits.push([u, a, d]); },
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      gameShowdownHeld: w.m.gameShowdownHeld, resolveHeldShowdown: w.m.resolveHeldShowdown,
    };
    const { exports: h } = load(`function wire(socket) {\n${handlerSrc('adminResolveHeldHand', '\n  });\n')}\n}`, scope, '{ wire }');
    const handlers = new Map<string, (d: any) => Promise<void>>();
    h.wire({ id: 'A', on: (ev: string, fn: any) => handlers.set(ev, fn), emit: (ev: string, d: any) => emits.push([ev, d]) });
    const send = (d: any) => handlers.get('adminResolveHeldHand')!(d);
    await send({ tableId: T, resolution: 'finish' });
    expect(emits.pop()).toEqual(['error', { message: 'Access denied' }]);
    admin = true;
    await send({ tableId: T, resolution: 'refund' });
    expect(emits.pop()).toMatchObject(['adminResolveHeldHandResult', { success: false, code: 'bad_resolution' }]);
    await send({ tableId: 'nope', resolution: 'finish' });
    expect(emits.pop()).toMatchObject(['adminResolveHeldHandResult', { success: false, code: 'not_held' }]);
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    await send({ tableId: T, resolution: 'finish' });
    expect(emits.pop()).toEqual(['adminResolveHeldHandResult', { success: true, tableId: T, handNumber: 1, resolution: 'finish' }]);
    expect(audits).toEqual([['admin', 'ADMIN_RESOLVE_HELD_HAND', expect.objectContaining({ tableId: T, handNumber: 1, resolution: 'finish' })]]);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    await send({ tableId: T, resolution: 'finish' });
    expect(emits.pop()).toMatchObject(['adminResolveHeldHandResult', { success: false, code: 'not_held' }]);
    expect(SRC).toContain("'ADMIN_RESOLVE_HELD_HAND',");                // a durable audit row
  });
});

describe('SERVER-R3-REG-PAYABLE-1 (b) — the shutdown flush never credits a pot a second time (c97254b: stack + invested of every seat)', () => {
  /** claimSeatsForShutdown (REAL) over a heads-up table whose two seats have signed-in sessions. */
  function flush(t: PokerTable) {
    const sessions = new Map<string, any>([['s0', { tableId: T, seatIndex: 0, playerId: 'player-0' }], ['s1', { tableId: T, seatIndex: 1, playerId: 'player-1' }]]);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }], getAllTableIds: () => [T] },
      playerSessions: sessions, multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
      authSessions: new Map([['s0', { userId: 10, username: 'a' }], ['s1', { userId: 11, username: 'b' }]]),
      isTournamentTable: () => false, isPrizeFormatTable: () => false, isTournamentReservation: () => false,
      shutdownFlushStats: { seatsNotCashed: 0, unclaimedSeatsCredited: 0, unclaimedSeatsUnowned: 0 }, noteShutdownSeatSkipped() {},
      progressionManager: { getProgress: () => undefined }, auditLog() {}, GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS,
      console: { log() {}, warn() {}, error() {} }, Sentry: null,
    };
    const { exports: m } = load(`${GUARD}\n${fnSrc('function claimSeatsForShutdown(')}`, scope, '{ claimSeatsForShutdown }');
    const r = m.claimSeatsForShutdown();
    return r.credits.reduce((a: number, x: any) => a + x.amount, 0);
  }

  it.each<[Fault]>([['post'], ['sticky'], ['mid'], ['pre']])('%s-payment fault, the hand resting in Showdown at the restart: 10000 credited, never more', (fault) => {
    const { t, start } = restingShowdown(fault);
    expect(start).toBe(10000);
    expect(flush(t)).toBe(10000);                                        // c97254b: post 10200, mid 10100
  });

  it('an UNREADABLE hand (a seat below its stake): never more than the chips on its seats (c97254b: those plus every invested chip)', () => {
    const { t } = restingShowdown('post');
    const p = t.payoutStartMark!;
    const winner = [0, 1].find((i) => t.seats[i].chipCount + t.seats[i].totalInvestedThisHand > p.stakes[i])!;
    const pot = invested(t);
    t.seats[winner].chipCount -= pot + 300;                              // pot + 300 left his stack by an unknown path
    const onTable = stacks(t);
    expect(flush(t)).toBe(onTable);                                      // c97254b: onTable + pot
  });

  it('CONTROL — a live hand (not Showdown) is abandoned as before: stack + invested', () => {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 5000, 'player-0', false);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(t.startNewHand()).toBe(true);
    expect(invested(t)).toBe(150);
    expect(flush(t)).toBe(10000);
  });

  it('source: the forced close and the quick-game cleanup cash a resting Showdown out the same way', () => {
    const close = handlerSrc('adminForceCloseTable', '\n  });\n');
    expect(close).toContain('const settledHoldings = restingShowdownHoldings(table);');
    expect(close).toContain('const refund = settledHoldings ? settledHoldings[i] : seat.chipCount + (inHand ? (seat.totalInvestedThisHand || 0) : 0);');
    const quick = fnSrc('function cleanupQuickTable(');
    expect(quick).toContain('const settledHoldings = restingShowdownHoldings(table);');
    expect(quick).toContain('const refund = settledHoldings ? settledHoldings[i] : seat.chipCount + (inHand ? (seat.totalInvestedThisHand || 0) : 0);');
  });
});

describe('SERVER-R3-REG-3 — a sticky check / fold throw: the 500 ms auto-act is bounded and never stacks (the reviewer\'s probe; c97254b: 1200 throws / 10 min, 21 chains after 20 broadcasts)', () => {
  function run(extraBroadcasts: number, minutes: number, faults = Infinity) {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 5000, 'player-0', false);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(t.startNewHand()).toBe(true);
    const orphan = t.activeSeatIndex;
    const realFold = t.playerFold.bind(t); const realCheck = t.playerCheck.bind(t);
    let engineThrows = 0; let left = faults;
    t.playerFold = (i: number) => { if (i === orphan && left > 0) { left--; engineThrows++; throw new TypeError('sticky fold fault'); } return realFold(i); };
    t.playerCheck = (i: number) => { if (i === orphan && left > 0) { left--; engineThrows++; throw new TypeError('sticky check fault'); } return realCheck(i); };
    let now = 1_000_000; let nextId = 1;
    const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
    const c = { escaped: 0, broadcasts: 0, sentry: 0, maxPending: 0 };
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
      pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {},
      Sentry: { captureException: () => { c.sentry++; } }, scheduleAIAction() {},
      setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error() {} }, log: { debug() {}, info() {} },
      seatHasAnySession: () => false, seatHasAnyPlayingSession: () => false, isTournamentTable: () => false, reservedSeats: new Map(),
      tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), absentTournamentSeatMayLimp: () => false,
      turnTimers: new Map(), turnStartedSeatMap: new Map(), noteAbsentTimeout() {}, sitOutTournamentSeatAfterTimeout: () => false,
      armTurnTimer() {}, tournamentTimeoutSitOutStats: { shortClockRearmed: 0 },
    };
    const { exports: m } = load(`${AUTO_ACT}\n${ORPHAN}\n${GUARD}\n${SAS}`, scope, '{ orphanAct, gameTimerGuardStats }');
    scope.scheduleAutoStart = m.scheduleAutoStart;
    // The real broadcastGameState: an absent active seat gets a 500 ms auto-act on EVERY broadcast.
    scope.broadcastGameState = (id: string) => { c.broadcasts++; if (t.isHandInProgress() && t.activeSeatIndex >= 0) m.orphanAct(id, t.activeSeatIndex); };
    (scope.broadcastGameState as any)(T);
    const advance = (ms: number) => {
      const until = now + ms;
      for (let g = 0; g < 2_000_000; g++) {
        jobs.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!jobs.length || jobs[0].at > until) break;
        const j = jobs.shift()!; now = j.at;
        try { j.fn(); } catch { c.escaped++; }
        c.maxPending = Math.max(c.maxPending, jobs.length);
      }
      now = until;
    };
    const per = (minutes * 60_000) / (extraBroadcasts + 1);
    for (let k = 0; k <= extraBroadcasts; k++) { advance(per); if (k < extraBroadcasts) (scope.broadcastGameState as any)(T); }
    return { t, orphan, engineThrows, g: m.gameTimerGuardStats, c, pendingAtEnd: jobs.length };
  }

  it('no extra broadcast: 3 auto-act throws, then nothing for 10 minutes (the turn is the clock\'s / the watchdog\'s)', () => {
    const r = run(0, 10);
    expect(r.c.escaped).toBe(0);
    expect(r.g).toMatchObject({ absentActThrows: 3, absentActGiveUps: 1 });
    expect(r.engineThrows).toBe(6);                                       // each auto-act and its recovery's check / fold
    expect(r.c.sentry).toBe(6);                                           // each throw's line + its recovery's (c97254b: 600, the 60/min cap)
    expect(r.pendingAtEnd).toBe(0);
    expect(r.t.activeSeatIndex).toBe(r.orphan);                            // the sticky seat still holds the turn (disclosed)
  });

  it('20 extra broadcasts: never more than one pending auto-act, still 3 throws in all', () => {
    const r = run(20, 10);
    expect(r.c.escaped).toBe(0);
    expect(r.c.maxPending).toBeLessThanOrEqual(1);                         // c97254b: 21
    expect(r.g).toMatchObject({ absentActThrows: 3, absentActGiveUps: 1 });
    expect(r.c.broadcasts).toBe(1 + 20 + 3);
  });

  it('CONTROL — one transient throw: its recovery acts (checks / folds) and the turn moves on', () => {
    const r = run(0, 1, 1);
    expect(r.c.escaped).toBe(0);
    expect(r.engineThrows).toBe(1);
    expect(r.g).toMatchObject({ absentActThrows: 1, absentActGiveUps: 0, actedFor: 1 });
  });
});

describe('SERVER-R3-REG-3 — the same loop for a BOT whose check / fold throws every time (c97254b: re-armed at its think delay without end)', () => {
  function botRun(minutes: number) {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'B0', 5000, 'bot-0', true);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(t.startNewHand()).toBe(true);
    if (t.activeSeatIndex !== 0) expect(t.playerCall(t.activeSeatIndex) || t.playerCheck(t.activeSeatIndex)).toBe(true);
    expect(t.activeSeatIndex).toBe(0);
    const realFold = t.playerFold.bind(t); const realCheck = t.playerCheck.bind(t);
    let engineThrows = 0;
    t.playerFold = (i: number) => { if (i === 0) { engineThrows++; throw new TypeError('sticky fold fault'); } return realFold(i); };
    t.playerCheck = (i: number) => { if (i === 0) { engineThrows++; throw new TypeError('sticky check fault'); } return realCheck(i); };
    let now = 1_000_000; let nextId = 1;
    const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
    const c = { escaped: 0, executes: 0 };
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
      pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null,
      broadcastGameState() {},
      setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error() {} }, log: { debug() {}, info() {} },
      aiProfiles: new Map([[T, new Map([[0, { botName: 'B0', difficulty: 'medium' }]])]]), aiTimeouts: new Map(),
      fastModeTables: new Map(), tableWantsFastBots: () => true, getThinkingDelay: () => 500,
      // the bot's decision itself acts through the engine: check, else fold — both throw for seat 0
      executeAIAction: (_id: string, seat: number) => { c.executes++; if (!t.playerCheck(seat)) t.playerFold(seat); },
    };
    const { exports: m } = load(`${SCHEDULE_AI}\n${GUARD}\n${SAS}`, scope, '{ scheduleAIAction, scheduleAutoStart, gameTimerGuardStats }');
    scope.scheduleAIAction = m.scheduleAIAction;
    scope.scheduleAutoStart = m.scheduleAutoStart;
    m.scheduleAIAction(T);
    const until = now + minutes * 60_000;
    for (let g = 0; g < 1_000_000; g++) {
      jobs.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!jobs.length || jobs[0].at > until) break;
      const j = jobs.shift()!; now = j.at;
      try { j.fn(); } catch { c.escaped++; }
    }
    return { t, c, g: m.gameTimerGuardStats, engineThrows };
  }

  it('3 throws, then the bot is not re-armed for that turn (botActionGiveUps); nothing escapes in 10 minutes', () => {
    const r = botRun(10);
    expect(r.c.escaped).toBe(0);
    expect(r.c.executes).toBe(3);                                          // c97254b: ~4800 (one per 120 ms)
    expect(r.g).toMatchObject({ actionThrows: 3, botActionGiveUps: 1 });
    expect(r.t.activeSeatIndex).toBe(0);
  });
});

describe('SERVER-R3-FAULT-LENS-1 — a pending bomb pot\'s all-in runout is inside the guarded deal: its payout fault is settled AT the deal (c97254b: rested in Showdown until the watchdog)', () => {
  const BOMB = [fnSrc('function dealAfterJoin('), fnSrc('function activateBombPotIfPending(')].join('\n');
  function bombWorld(fault: Fault | 'deal') {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 150, 'player-0', false);                            // a 200 bomb ante puts both stacks all-in: the board runs out to the payout
    t.sitDown(1, 'H1', 150, 'player-1', false);
    if (fault === 'deal') for (const s of t.seats) if (s.state === 'occupied') s.chipCount = 50;   // the blinds alone run it out: the deal's own payout
    let now = 1_000_000; let nextId = 1;
    const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
    const bombPotPending = new Map<string, boolean>([[T, true]]);
    const c = { handResults: 0 };
    t.on('handResult', () => { c.handResults++; });
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
      pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null,
      broadcastGameState() {}, scheduleAIAction() {},
      setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error() {} }, log: { debug() {}, info() {} },
      bombPotPending, bombPotActive: new Map(), bombPotAllowedAt: () => true, bombPotStats: { dealt: 0, refusedAtActivation: 0 },
    };
    if (fault !== 'deal') {
      const realApply = t.applyBombPot.bind(t);
      t.applyBombPot = (ante: number) => { injectFault(t, fault); return realApply(ante); };
    } else injectFault(t, 'post');
    const { exports: m } = load(`${BOMB}\n${GUARD}\n${SAS}`, scope, '{ dealAfterJoin, scheduleAutoStart, gameTimerGuardStats }');
    scope.scheduleAutoStart = m.scheduleAutoStart;
    return { t, m, c, bombPotPending, scope };
  }

  it.each<[Fault]>([['pre'], ['post'], ['mid'], ['sticky']])('%s-payment fault in the bomb pot runout at dealAfterJoin: settled at the deal, true, chips conserved', (fault) => {
    const w = bombWorld(fault);
    expect(w.m.dealAfterJoin(T, w.t)).toBe(true);                         // c97254b: the throw escaped to the join's caller
    expect(w.t.currentPhase).not.toBe(GamePhase.Showdown);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealPayoutFaults: 1, showdownHeld: 0, [OUTCOME[fault]]: 1 });
    expect(total(w.t)).toBe(300);
    expect(w.bombPotPending.has(T)).toBe(false);                          // this deal's bomb pot was played
  });

  it('a deal-time fault in the deal ITSELF (heads-up blinds all-in): settled, and the pending bomb pot is KEPT for the next deal (c97254b: dropped on the finished hand)', () => {
    const w = bombWorld('deal');
    expect(w.m.dealAfterJoin(T, w.t)).toBe(true);
    expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealPayoutFaults: 1, showdownPaidFinished: 1 });
    expect(w.bombPotPending.get(T)).toBe(true);
  });

  it('source: every activateBombPotIfPending call is in autoStartNextHand / ensureCashTableRunning (their callers settle) or inside a try whose catch hands the throw to settleDealThrow', () => {
    const sf = ts.createSourceFile('index.ts', SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const sites: Array<{ fn: string; how: string }> = [];
    const visit = (node: any) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'activateBombPotIfPending') {
        let fn = '(top)'; let how = 'UNGUARDED';
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isTryStatement(p) && p.catchClause && p.catchClause.block.getText(sf).includes('settleDealThrow(') && how === 'UNGUARDED') how = 'settleDealThrow';
          if (ts.isFunctionDeclaration(p) && p.name) { fn = p.name.text; break; }
        }
        if (how === 'UNGUARDED' && (fn === 'autoStartNextHand' || fn === 'ensureCashTableRunning')) how = 'caller guard';
        sites.push({ fn, how });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(sites.length).toBe(5);
    expect(sites.filter((s) => s.how === 'UNGUARDED')).toEqual([]);       // c97254b: dealAfterJoin, the club challenge sweep, 'startHand'
  });
});

/**
 * Bots review fix round 3 (2026-11-05, SR2-2) — a payout fault on a HUMAN path is never paid twice.
 *
 * Rule 35's guard covered game TIMERS. A hand-ending human action (a river check, a call,
 * a fold that leaves one player) reaches determineWinners through the socket handler; when
 * it threw there AFTER paying, socketGuard only logged it and the hand rested in Showdown
 * un-held: the pot already paid, totalInvestedThisHand not reset. The wedge watchdog then
 * folded / checked (refused in Showdown) and called advanceTurn, which ran determineWinners
 * again — the pot paid twice (~37 s later); with a sticky fault, once per 15 s tick without
 * end. The same held for the 'playerDraw' handler, the seat-teardown folds (leave), the
 * sit-out / AFK folds and the departure folds.
 *
 * The fix, both halves:
 *   - a choke point: the engine records each hand's payout-start stakes
 *     (PokerTable.payoutStartMark, taken once per hand on the first entry into
 *     determineWinners); the wedge watchdog never folds / checks / advances a Showdown — seen
 *     there at two ticks it settles it from that mark (resolved / paid_finished / voided /
 *     held), so ANY path, named or not, is safe;
 *   - promptness: each named human path catches its throw, settles a Showdown at once from the
 *     same mark (settleHumanPathThrow), then RETHROWS so socketGuard still logs and reports it.
 * A wedged hand whose payout never started is still recovered by the watchdog as before.
 *
 * REAL code sliced from src/index.ts: the 'action', 'playerDraw', 'sitOut' and 'playerAFK'
 * handlers registered behind the REAL installSocketListenerGuard (src/socketGuard.ts), the
 * seat teardown block, processPendingSeatRemovals, reserveSeatForDeparture, the turn clock,
 * the guard block and the wedge watchdog interval, on the REAL engine and a manual clock.
 *
 * Fails on 2b5ac52: every human-path fault ends with the pot paid twice by the watchdog
 * (10000 -> 10200 / 10100, or growing per tick for a sticky fault), and the Stud 8 fold-won
 * pot's payout fault leaves the hand on its street.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { installSocketListenerGuard } from '../src/socketGuard';
import { slice, fnSrc, load, handlerSrc, flush, SEAT_SESSION_FOR_SRC, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const T = 'T';
const TURN_MS = 30000;
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const CLOCK = [slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"), fnSrc('function armTurnTimer(')].join('\n');
const WATCHDOG = slice('const WEDGE_TURN_GRACE_MS', '}, 15000);');
const ON_ERR = slice('    onHandlerError: (event, err) => {', '    },\n');
const HANDLERS = [
  handlerSrc('action', '\n  );\n'),
  handlerSrc('playerDraw', '\n  });\n'),
  handlerSrc('sitOut', '\n  });\n'),
  handlerSrc('playerAFK', '\n  });\n'),
].join('\n');

type Fault = 'post' | 'pre' | 'sticky' | null;
const stacks = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount : 0), 0);
const invested = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? (s.totalInvestedThisHand || 0) : 0), 0);

function injectFault(t: PokerTable, f: Fault): void {
  if (f === 'post' || f === 'sticky') {
    const real = (t as any).buildPotBreakdown.bind(t);
    let left = f === 'post' ? 1 : Infinity;
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected post-payment fault'); } return real(...a); };
  } else if (f === 'pre') {
    const spm = (t as any).sidePotManager; const real = spm.awardPots.bind(spm); let left = 1;
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return real(...a); };
  }
}

function world(table: PokerTable) {
  const t = table;
  let now = 1_000_000; let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void; every?: number }> = [];
  const c = { handResults: 0, errors: [] as string[], warns: [] as string[], sentry: 0, escaped: 0, advancedInShowdown: 0, credits: [] as Array<[number, number, string]>, deals: 0, rejections: 0 };
  t.on('handResult', () => { c.handResults++; });
  const realAdvance = (t as any).advanceTurn.bind(t);
  (t as any).advanceTurn = () => { if (t.currentPhase === GamePhase.Showdown) c.advancedInShowdown++; return realAdvance(); };
  const playerSessions = new Map<string, any>([
    ['sock-0', { tableId: T, seatIndex: 0, playerId: 'player-0', playerName: 'H0', sittingOut: false }],
    ['sock-1', { tableId: T, seatIndex: 1, playerId: 'player-1', playerName: 'H1', sittingOut: false }],
  ]);
  const pendingAutoStartTimers = new Map<string, any>();
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }] },
    GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
    pendingAutoStartTimers, pendingSeatRemovalAfterHand, Sentry: null,
    playerSessions, multiTableSessions: new Map(), actionNonces: new Map(), actionTimings: new Map(),
    allInOrFoldTables: new Set(), allInOrFoldAllows: () => true,
    getGameStateForPlayer: () => ({}), emitGameState() {}, returnTournamentSessionFromSitOut() {},
    scheduleAIAction() {}, clearHandSnapshot: async () => {}, syncSitOutToTable() {},
    autoStartNextHand: () => { if (t.currentPhase === GamePhase.HandComplete && t.startNewHand()) { c.deals++; (scope.broadcastGameState as any)(T); } },
    setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    setInterval: (fn: () => void, ms: number) => { const id = nextId++; jobs.push({ id, at: now + ms, fn, every: ms }); return id; },
    Date: class FakeDate extends Date { static now() { return now; } },
    console: { log() {}, warn: (m: unknown) => c.warns.push(String(m)), error: (m: unknown) => c.errors.push(String(m)) },
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
    isDeadTournamentSeat: () => false, SEAT_RESERVE_MS: 600_000, DISCONNECT_HANDS_LIMIT: 20,
    shutdownFlushActive: () => false,
  };
  const code = [
    CLOCK, GUARD, fnSrc('function scheduleAutoStart('), fnSrc('function processPendingSeatRemovals('), SEAT_TEARDOWN_SRC,
    fnSrc('function reserveSeatForDeparture('),
    `function makeGuardOpts() { return { log: (line) => console.error(line),\n${ON_ERR} }; }`,
    `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${HANDLERS}\n}`,
    WATCHDOG,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope,
    '{ armTurnTimer, scheduleAutoStart, processPendingSeatRemovals, teardownSeat, reserveSeatForDeparture, gameTimerGuardStats, gameShowdownHeld, wire, makeGuardOpts }');
  scope.scheduleAutoStart = m.scheduleAutoStart;
  const wired = new Set<any>();
  scope.broadcastGameState = (id: string) => {
    if (!wired.has(t)) { wired.add(t); t.on('turnChanged', () => m.armTurnTimer(id)); }
    m.armTurnTimer(id);
  };
  // index.ts's 'handResult' listener: the pending seat removals, then the next deal.
  t.on('handResult', () => { m.processPendingSeatRemovals(T); m.scheduleAutoStart(T); });
  const mkSocket = (id: string) => {
    const handlers = new Map<string, (d: unknown) => unknown>();
    const s: any = {
      id, connected: true,
      on(ev: string, fn: (d: unknown) => unknown) { handlers.set(ev, fn); return s; },
      emit() { return true; },
      receive(ev: string, payload: unknown) {
        const h = handlers.get(ev);
        const r: any = h ? h(payload) : undefined;
        if (r && typeof r.then === 'function') r.then(() => {}, () => { c.rejections++; });
        return r;
      },
    };
    const opts = m.makeGuardOpts();
    const orig = opts.onHandlerError;
    opts.onHandlerError = (ev: string, err: unknown) => { c.sentry++; orig(ev, err); };
    installSocketListenerGuard(s, opts);
    m.wire(s);
    return s;
  };
  const socks = [mkSocket('sock-0'), mkSocket('sock-1')];
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
  const socketErrors = () => c.errors.filter((l) => l.startsWith('[socket-handler-error]')).map((l) => JSON.parse(l.slice('[socket-handler-error] '.length)));
  const watchdogFired = () => c.errors.filter((l) => l.startsWith('{"event":"wedge_watchdog_fired"')).length;
  const deal = () => { expect(t.startNewHand()).toBe(true); (scope.broadcastGameState as any)(T); };
  return { t, m, c, stubbed, socks, act, advance, stats, socketErrors, watchdogFired, deal, scope, pendingAutoStartTimers, playerSessions };
}

const holdem = () => {
  const t = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
  t.sitDown(0, 'H0', 5000, 'player-0', false);
  t.sitDown(1, 'H1', 5000, 'player-1', false);
  return t;
};

/** Both humans check / call to the river through the socket handler; returns the seat whose check closes it. */
function toRiver(w: ReturnType<typeof world>): number {
  for (let g = 0; g < 40 && w.t.currentPhase !== GamePhase.River; g++) {
    w.advance(1000);
    const a = w.t.activeSeatIndex;
    w.act(a, w.t.currentBetToMatch - (w.t.seats[a].currentBet || 0) > 0 ? 'call' : 'check');
  }
  expect(w.t.currentPhase).toBe(GamePhase.River);
  w.advance(1000);
  w.act(w.t.activeSeatIndex, 'check');
  w.advance(1000);
  return w.t.activeSeatIndex;
}

/** After the human path's fault: settled at once, never paid twice, the next hand dealt; nothing escapes. */
function expectSettledOnce(w: ReturnType<typeof world>, total: number, outcome: 'paid_finished' | 'resolved', nextHand = true) {
  expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
  expect(stacks(w.t)).toBe(total);
  expect(invested(w.t)).toBe(0);
  expect(w.c.handResults).toBe(1);
  expect(w.m.gameShowdownHeld(w.t)).toBe(false);
  expect(w.stats()).toMatchObject({ humanPathShowdowns: 1, showdownFaults: 1, [outcome === 'paid_finished' ? 'showdownPaidFinished' : 'showdownResolved']: 1, showdownHeld: 0, showdownVoided: 0, recoveryThrows: 0 });
  expect(w.pendingAutoStartTimers.has(T)).toBe(true);           // the next deal
  // the server runs on for 2 minutes: the next hand is dealt, chips stay conserved, the watchdog never re-pays
  const hand = w.t.handNumber;
  w.advance(120_000);
  expect(w.c.escaped).toBe(0);
  if (nextHand) expect(w.t.handNumber).toBeGreaterThan(hand);
  expect(stacks(w.t) + invested(w.t)).toBe(total);
  expect(w.stats().watchdogShowdowns).toBe(0);
  expect(w.watchdogFired()).toBe(0);
}

describe('SR2-2 — the socket action: a payout that throws inside a hand-ending human action', () => {
  it.each<[Fault, 'paid_finished' | 'resolved']>([['post', 'paid_finished'], ['pre', 'resolved'], ['sticky', 'paid_finished']])(
    'river check, %s-payment fault: logged by socketGuard (rethrown), settled at once (%s), never paid twice', (fault, outcome) => {
      const w = world(holdem());
      w.deal();
      const closer = toRiver(w);
      injectFault(w.t, fault);
      w.act(closer, 'check');
      expect(w.socketErrors()).toEqual([expect.objectContaining({ event: 'action', kind: 'sync' })]);
      expect(w.c.sentry).toBe(1);                                  // index.ts's onHandlerError ran (Sentry null here)
      expectSettledOnce(w, 10000, outcome);
      expect([...w.stubbed].filter((n) => /settle|gameTimer|gameShowdown|continueAfter|scheduleAutoStart|installSocketListenerGuard/.test(n))).toEqual([]);
    });

  it('a fold that leaves one player, post-payment fault: settled at once (paid_finished), 10000 stays 10000', () => {
    const w = world(holdem());
    w.deal();
    w.advance(1000);
    injectFault(w.t, 'post');
    w.act(w.t.activeSeatIndex, 'fold');
    expect(w.socketErrors()).toHaveLength(1);
    expectSettledOnce(w, 10000, 'paid_finished');
  });

  it('CONTROL — no fault: the hand ends normally, no counter moves', () => {
    const w = world(holdem());
    w.deal();
    const closer = toRiver(w);
    w.act(closer, 'check');
    expect(w.socketErrors()).toEqual([]);
    expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacks(w.t)).toBe(10000);
    expect(w.stats()).toMatchObject({ humanPathShowdowns: 0, showdownFaults: 0, watchdogShowdowns: 0 });
  });
});

describe('SR2-2 — the other human paths: draw, sit out, AFK, leave (teardown), departure', () => {
  it("'playerDraw': the last draw runs both all-in players to the payout, which throws after paying -> settled at once", async () => {
    const t = new FiveCardDrawTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any, false);
    t.sitDown(0, 'H0', 1000, 'player-0', false, true);
    t.sitDown(1, 'H1', 1000, 'player-1', false, true);
    const w = world(t);
    w.deal();
    w.act(t.activeSeatIndex, 'allIn');
    w.act(t.activeSeatIndex, 'call');
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    w.socks[0].receive('playerDraw', { discardIndices: [] });
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    injectFault(t, 'post');
    await Promise.resolve(w.socks[1].receive('playerDraw', { discardIndices: [] })).catch(() => {});
    await new Promise((res) => setImmediate(res));
    expect(w.socketErrors()).toEqual([expect.objectContaining({ event: 'playerDraw', kind: 'async' })]);
    expectSettledOnce(w, 2000, 'paid_finished', false);   // an all-in loser is busted: heads-up, no next hand
  });

  it.each([['sitOut'], ['playerAFK']])("'%s' on his turn facing a bet: the fold ends the hand, the payout throws -> settled at once", async (ev) => {
    const w = world(holdem());
    w.deal();
    const seat = w.t.activeSeatIndex;                           // the small blind, facing the big blind
    injectFault(w.t, 'post');
    const r = w.socks[seat].receive(ev, { tableId: T, sittingOut: true });
    await Promise.resolve(r).catch(() => {});
    await new Promise((res) => setImmediate(res));
    expect(w.socketErrors()).toEqual([expect.objectContaining({ event: ev, kind: 'async' })]);
    expectSettledOnce(w, 10000, 'paid_finished');
  });

  it('a LEAVE (teardownSeat) on his turn facing a bet: the fold throws after paying -> rethrown, settled at once, his seat credited ONCE at the hand end', () => {
    const w = world(holdem());
    w.deal();
    const seat = w.t.activeSeatIndex;
    const before = w.t.seats[seat].chipCount + (w.t.seats[seat].totalInvestedThisHand || 0);
    injectFault(w.t, 'post');
    expect(() => w.m.teardownSeat(T, w.t, seat, { userId: 7, username: 'h' }, 'handlePlayerLeave')).toThrow('injected post-payment fault');
    expect(w.t.seats[seat].state).toBe('empty');                 // stood up by the settled hand's end
    expect(w.c.credits).toEqual([[7, before - 50, 'leave_after_hand']]);   // he lost his small blind, credited once
    expect(stacks(w.t) + 4950).toBe(10000);
    expect(w.stats()).toMatchObject({ humanPathShowdowns: 1, showdownPaidFinished: 1, showdownHeld: 0 });
    w.advance(120_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.credits).toHaveLength(1);
    expect(stacks(w.t) + invested(w.t) + 4950).toBe(10000);
    expect(w.stats().watchdogShowdowns).toBe(0);
  });

  it('a chosen DEPARTURE (reserveSeatForDeparture actNow) on his turn facing a bet: the fold throws after paying -> rethrown, settled at once', () => {
    const w = world(holdem());
    w.deal();
    const seat = w.t.activeSeatIndex;
    injectFault(w.t, 'post');
    const session = w.playerSessions.get(`sock-${seat}`);
    expect(() => w.m.reserveSeatForDeparture({ userId: 7, username: 'h' }, session, w.t, w.t.seats[seat], { actNow: true })).toThrow('injected post-payment fault');
    expectSettledOnce(w, 10000, 'paid_finished');
  });
});

describe("a seat reservation's EXPIRY timer: its teardown's fold ends the hand and the payout throws", () => {
  it('nothing escapes the timer (2b5ac52: exit 1), the hand is settled at once, his seat credited ONCE, chips conserved', () => {
    const w = world(holdem());
    w.deal();
    const away = 1 - w.t.activeSeatIndex;                         // the seat NOT on the clock drops
    const session = w.playerSessions.get(`sock-${away}`);
    w.scope.SEAT_RESERVE_MS = 1000;
    expect(w.m.reserveSeatForDeparture({ userId: 7, username: 'h' }, session, w.t, w.t.seats[away], {})).toBe(true);
    w.playerSessions.delete(`sock-${away}`);                       // the disconnect handler drops his session
    const before = w.t.seats[away].chipCount + (w.t.seats[away].totalInvestedThisHand || 0);
    injectFault(w.t, 'post');
    w.advance(1100);                                              // the reservation expires: teardown -> fold out of turn -> uncontested -> payout throws
    expect(w.c.escaped).toBe(0);
    expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.t.seats[away].state).toBe('empty');
    expect(w.c.credits).toHaveLength(1);
    expect(w.c.credits[0][0]).toBe(7);
    expect(w.c.credits[0][2]).toBe('leave_after_hand');
    expect([before - 100, before - 50]).toContain(w.c.credits[0][1]);   // his blind lost, nothing else
    expect(stacks(w.t) + w.c.credits[0][1]).toBe(10000);
    expect(w.stats()).toMatchObject({ reservationTimerThrows: 1, humanPathShowdowns: 1, showdownPaidFinished: 1, showdownHeld: 0 });
    w.advance(120_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.credits).toHaveLength(1);
    expect(stacks(w.t) + invested(w.t) + w.c.credits[0][1]).toBe(10000);
  });
});

describe('SR2-2 — the choke point: the wedge watchdog never runs a Showdown payout again', () => {
  /** An un-held Showdown left by a path that has no catch (the engine called bare). */
  function bareFault(fault: Fault) {
    const w = world(holdem());
    w.deal();
    const closer = toRiver(w);
    injectFault(w.t, fault);
    expect(() => w.t.playerCheck(closer)).toThrow();
    expect(w.t.currentPhase).toBe(GamePhase.Showdown);
    expect(w.m.gameShowdownHeld(w.t)).toBe(false);
    return w;
  }

  it('sticky post-payment fault, 5 minutes of watchdog ticks: 0 advances, settled ONCE from the payout mark (paid_finished), 10000 stays 10000', () => {
    const w = bareFault('sticky');
    expect(stacks(w.t)).toBe(10000);                             // paid, the 200 still counted in the pot
    w.advance(15_000);                                           // the watchdog's first tick (fix round 3 review: settled at once)
    expect(w.t.currentPhase).not.toBe(GamePhase.Showdown);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownPaidFinished: 1, showdownResolved: 0, showdownVoided: 0 });
    expect(stacks(w.t) + invested(w.t)).toBe(10000);
    w.advance(285_000);                                          // the sticky fault faults every later payout too (each settled by its own path)
    expect(w.c.escaped).toBe(0);
    expect(w.c.advancedInShowdown).toBe(0);                      // 2b5ac52: advanced every tick, +200 each
    expect(w.watchdogFired()).toBe(0);
    expect(stacks(w.t) + invested(w.t)).toBe(10000);             // 2b5ac52: 13600 after 300 s
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownResolved: 0, showdownHeld: 0 });
    expect(w.t.handNumber).toBeGreaterThan(1);                   // play went on
  });

  it('post-payment fault once: settled at the FIRST tick that sees the Showdown (fix round 3 review, SERVER-R3-FAULT-1; 3691a70: the second, 15-30 s)', () => {
    const w = bareFault('post');
    const tick = w.c.errors.length;
    w.advance(15_000);
    expect(w.t.currentPhase).not.toBe(GamePhase.Showdown);
    expect(w.c.errors.slice(tick).filter((l) => l.startsWith('{"event":"wedge_watchdog_showdown"'))).toHaveLength(1);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(stacks(w.t) + invested(w.t)).toBe(10000);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownPaidFinished: 1 });
  });

  it('the legitimate recovery stays: a PRE-payment fault (payout started, nothing credited) -> RESOLVED, paid exactly once', () => {
    const w = bareFault('pre');
    expect(stacks(w.t)).toBe(9800);
    w.advance(15_000);
    expect(w.c.escaped).toBe(0);
    expect(stacks(w.t) + invested(w.t)).toBe(10000);
    expect(w.c.handResults).toBe(1);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownResolved: 1, showdownPaidFinished: 0, showdownVoided: 0 });
  });

  it('the legitimate recovery stays: a BETTING-round wedge (no turn clock) is still forced on by the watchdog', () => {
    const w = world(holdem());
    expect(w.t.startNewHand()).toBe(true);                      // dealt with no broadcast: no turn clock armed
    const seat = w.t.activeSeatIndex;
    w.advance(50_000);
    expect(w.c.escaped).toBe(0);
    expect(w.watchdogFired()).toBeGreaterThanOrEqual(1);
    expect(w.t.actionLog.some((e: any) => e.seatIndex === seat)).toBe(true);
    expect(stacks(w.t) + invested(w.t)).toBe(10000);
    expect(w.stats().watchdogShowdowns).toBe(0);
  });

  it('a HELD hand is still skipped (never settled, never advanced)', () => {
    const w = bareFault('post');
    // a seat changes hands while the hand rests: the settle cannot account for it -> HELD
    w.t.seats[1].playerId = 'someone-else';
    w.advance(45_000);                                          // the watchdog's settle finds the seats changed -> HELD
    expect(w.m.gameShowdownHeld(w.t)).toBe(true);
    const chipsNow = stacks(w.t);
    w.advance(120_000);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(stacks(w.t)).toBe(chipsNow);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 1, showdownPaidFinished: 0 });
  });
});

describe('the engine: PokerTable.payoutStartMark, and a Stud 8 fold-won pot paid IN Showdown', () => {
  it('taken once per hand at the payout start (pre-payout stakes), cleared at the next deal', () => {
    const t = holdem();
    expect(t.startNewHand()).toBe(true);
    expect(t.payoutStartMark).toBeNull();
    const pre = t.seats.slice(0, 2).map((s) => s.chipCount + s.totalInvestedThisHand);
    const real = (t as any).buildPotBreakdown.bind(t);
    let left = 1;
    (t as any).buildPotBreakdown = (...a: any[]) => { if (left-- > 0) throw new TypeError('x'); return real(...a); };
    expect(() => t.playerFold(t.activeSeatIndex)).toThrow('x');
    expect(t.payoutStartMark).toMatchObject({ hand: t.handNumber, ids: expect.arrayContaining(['player-0', 'player-1']) });
    expect(t.payoutStartMark!.stakes.slice(0, 2)).toEqual(pre);
    // a second payout entry (a blind re-run) never moves it
    try { (t as any).determineWinners(); } catch { /* */ }
    expect(t.payoutStartMark!.stakes.slice(0, 2)).toEqual(pre);
    expect(t.completeHandAfterFault()).toBe(false);              // already HandComplete after the re-run
    expect(t.startNewHand()).toBe(true);
    expect(t.payoutStartMark).toBeNull();
  });

  it('Stud 8: a fold-won pot whose payout throws after paying rests in SHOWDOWN (2b5ac52: on its street), and the watchdog settles it once', () => {
    const t = new SevenStudTable({ tableId: T, tableName: T, smallBlind: 10, bigBlind: 20, ante: 5, minBuyIn: 100 } as any, false, true);
    t.sitDown(0, 'H0', 1000, 'player-0', false, true);
    t.sitDown(1, 'H1', 1000, 'player-1', false, true);
    const w = world(t);
    w.deal();
    injectFault(t, 'post');
    expect(() => t.playerFold(t.activeSeatIndex)).toThrow('injected post-payment fault');
    expect(t.currentPhase).toBe(GamePhase.Showdown);             // 2b5ac52: ThirdStreet
    expect(t.payoutStartMark?.hand).toBe(t.handNumber);
    expect(stacks(t)).toBe(2000);
    w.advance(45_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(stacks(t) + invested(t)).toBe(2000);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownPaidFinished: 1 });
  });
});

describe('a folded seat cannot top up into a faulted payout resting in Showdown (its settle reads every stake)', () => {
  const KIND = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', "    code: 'rebuy_not_allowed',\n  };\n}\n");
  const REBUY = handlerSrc('rebuy', '\n  })(); });');
  function rebuyWorld() {
    const t = new PokerTable({ tableId: 'lobby', tableName: 'lobby', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 500 } as any);
    for (let i = 0; i < 3; i++) expect(t.sitDown(i, `P${i}`, 500, `p-${i}`, false)).toBe(true);
    const deducts: Array<[number, number]> = [];
    const playerSessions = new Map<string, any>([['S1', { socketId: 'S1', tableId: 'lobby', seatIndex: 0, playerName: 'P0', playerId: 'p-0' }]]);
    const scope: Record<string, unknown> = {
      isTournamentTable: () => false, quickTables: new Set(), spinGoMultipliers: new Map(), careerTables: new Map(), allInOrFoldTables: new Set(), challengeTables: new Map(),
      tableManager: { getTable: (id: string) => (id === 'lobby' ? t : undefined) },
      playerSessions, authSessions: new Map([['S1', { userId: 7, username: 'hero' }]]), multiTableSessions: new Map(),
      assertPlayable: async () => null, emitPlayRefusal() {}, buyInSocketGone: async () => false,
      ensureChipsForBuyIn: async () => 1_000_000,
      deductChips: async (uid: number, n: number) => { deducts.push([uid, n]); return true; },
      addChipsToUser: async () => true, auditLog() {}, broadcastGameState() {},
      log: { debug() {}, info() {}, warn() {} },
    };
    const { exports: m } = load(KIND + `\nfunction registerRebuy(socket) {\n${SEAT_SESSION_FOR_SRC}\n${REBUY}\n}\n`, scope, '{ registerRebuy }');
    const emitted: Array<[string, any]> = [];
    const handlers: Record<string, (d?: any) => void> = {};
    m.registerRebuy({ id: 'S1', emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { handlers[ev] = fn; } });
    // P0 folds; the other two play on
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 6 && !t.seats[0].folded; g++) { const a = t.activeSeatIndex; if (a === 0) t.playerFold(0); else if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.seats[0].folded).toBe(true);
    t.seats[0].chipCount = 100;
    return { t, deducts, emitted, handlers };
  }

  it('the hand rests in Showdown after a post-payment fault: the folded seat\'s rebuy is refused, nothing deducted, its stack unchanged', async () => {
    const w = rebuyWorld();
    const real = (w.t as any).buildPotBreakdown.bind(w.t);
    let left = 1;
    (w.t as any).buildPotBreakdown = (...a: any[]) => { if (left-- > 0) throw new TypeError('injected post-payment fault'); return real(...a); };
    for (let g = 0; g < 40 && w.t.currentPhase !== GamePhase.Showdown; g++) {
      const a = w.t.activeSeatIndex;
      try { if (!w.t.playerCheck(a)) w.t.playerCall(a); } catch { /* the faulted payout */ }
    }
    expect(w.t.currentPhase).toBe(GamePhase.Showdown);
    w.handlers.rebuy({ amount: 500 });
    await flush();
    expect(w.deducts).toEqual([]);                                     // 2b5ac52: [[7, 400]] — the top-up landed in the faulted hand
    expect(w.t.seats[0].chipCount).toBe(100);
    expect(w.emitted).toContainEqual(['error', expect.objectContaining({ message: expect.stringContaining('Cannot rebuy while in a live hand') })]);
  });

  it('CONTROL — the same folded seat mid-hand (no fault): the top-up is allowed, as before', async () => {
    const w = rebuyWorld();
    expect(w.t.isHandInProgress()).toBe(true);
    w.handlers.rebuy({ amount: 500 });
    await flush();
    expect(w.deducts).toEqual([[7, 400]]);
    expect(w.t.seats[0].chipCount).toBe(500);
  });
});

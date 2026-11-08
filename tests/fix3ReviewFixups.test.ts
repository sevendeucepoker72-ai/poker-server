/**
 * Bots review fix round 3 — fix-up pass 1 after the adversarial reviews of 3691a70 (2026-11-08).
 *
 * SERVER-R3-FAULT-1 (P2) — the wedge watchdog settled a hand resting in Showdown from the
 * engine's payout-start mark only at its SECOND sighting (15-30 s), and its stake check HELD the
 * hand (frozen until a restart; a paid pot credited again by the shutdown flush) when ANY seat of
 * the mark changed — a joiner sat out of the hand, a fold with nothing in, both paid nothing.
 * And three human paths ran a payout with no settle of their own: the Crazy Pineapple discard
 * pick ('selectPineappleDiscard'), the insurance accept / decline, and the watchdog's own forced
 * action. Now:
 *   - the payout mark says which seats the payout can credit at all (payable); a seat it cannot
 *     is skipped by the settle (and a void puts back only the payable stakes);
 *   - the watchdog settles at the FIRST tick that sees the Showdown;
 *   - the three paths settle at once (the human ones rethrow, so socketGuard still reports);
 *   - a dead blind is never posted into a pot whose payout began (Showdown).
 * SERVER-R3-REG-1 (P3) — a sticky absent-drawer stand-pat fault re-armed itself through
 *   scheduleAIAction every 500 ms without end (2 Hz; 60 Sentry events a minute). Now bounded
 *   per (hand, draw round); the round is then the 30 s draw clock's.
 * SERVER-R3-REG-2 (P3) — the 500 ms sit-out / orphan auto-act acted on a hand resting in
 *   Showdown, and only a source pin covered the settle's mark-phase guard that kept it from
 *   re-paying. It now skips Showdown (as the turn clock and a bot's turn), and the guard has a
 *   behavioural test.
 * SERVER-R3-MEAS-1 (P3) — a Spin & Go first deal that threw BEFORE dealing was never retried
 *   (the table waited for the player's Deal now). Now retried once, 3 s later.
 *
 * REAL code sliced from src/index.ts (socket handlers behind the REAL socketGuard, the turn
 * clock, the guard block, the seat teardown, the hold releases, the wedge watchdog, the absent
 * drawers, scheduleAIAction, the 500 ms auto-act, the Spin & Go first deal) on the REAL engine,
 * on a manual clock. Each describe fails on 3691a70 (and on 2b5ac52).
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import { studDrawKindOf, chooseBotDiscards } from '../src/ai/studDrawStrength';
import { installSocketListenerGuard } from '../src/socketGuard';
import { SRC, slice, fnSrc, load, handlerSrc, SEAT_SESSION_FOR_SRC, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const T = 'T';
const TURN_MS = 30000;
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const SAS = fnSrc('function scheduleAutoStart(');
const CLOCK = [slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"), fnSrc('function armTurnTimer(')].join('\n');
const WATCHDOG = slice('const WEDGE_TURN_GRACE_MS', '}, 15000);');
const ON_ERR = slice('    onHandlerError: (event, err) => {', '    },\n');
const PINEAPPLE = SRC.slice(SRC.indexOf('const PINEAPPLE_DISCARD_WINDOW_MS = '), SRC.indexOf('\n}\n', SRC.indexOf('function releasePineappleDiscardHoldIfDecided(')) + 3);
const INSURANCE = [fnSrc('function clearInsuranceOffer('), fnSrc('function releaseInsuranceHold('), fnSrc('function releaseInsuranceHoldIfDecided(')].join('\n');
const INSURANCE_SESSION_FOR = slice('  const insuranceSessionFor = ', ';\n');
const HANDLERS = [
  handlerSrc('action', '\n  );\n'),
  handlerSrc('selectPineappleDiscard', '\n  });\n'),
  handlerSrc('acceptInsurance', '\n  });\n'),
  handlerSrc('declineInsurance', '\n  });\n'),
].join('\n');
const ABSENT_DRAWERS = slice('// ===== Absent drawers (gameplay S3 fix-up, 2026-10-21) =====', '// ===== end absent drawers =====\n');
const SCHEDULE_AI = fnSrc('function scheduleAIAction(');
const AUTO_ACT = slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n");
const ORPHAN_BLOCK = slice('    if (shouldAutoAct) {', '      }, 500);\n    }\n');
const ORPHAN = `function orphanAct(tableId, activeIdx) {\n  const shouldAutoAct = true;\n${ORPHAN_BLOCK}}\n`;
const SPIN_GO = `function spinGoDeal(tableId, socket) {\n${slice('    // Start hand after reveal delay (3 seconds)', '    setTimeout(() => spinGoFirstDeal(true), 3500);\n')}}\n`;

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

/** The socket / watchdog world (as fix3HumanPathShowdown's), with the hold releases and three sessions. */
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
  const insuranceOffers = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }] },
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
    seatHasAnySession: (_tid: string, i: number) => i < 2,
    insuranceOffers, insuranceStats: { refused: 0, accepted: 0, declined: 0, releasedTimeout: 0, releasedDecided: 0 },
    insuranceCashouts: new Map(), authSessions: new Map(), auditLog() {},
    insuranceQuoteForSeat: () => ({ cashout: 100, equityPct: 50, pot: 200 }), insuranceExclusivePot: () => 0,
  };
  const code = [
    CLOCK, GUARD, SAS, fnSrc('function processPendingSeatRemovals('), SEAT_TEARDOWN_SRC, PINEAPPLE, INSURANCE,
    `function makeGuardOpts() { return { log: (line) => console.error(line),\n${ON_ERR} }; }`,
    `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${INSURANCE_SESSION_FOR}\n${HANDLERS}\n}`,
    WATCHDOG,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope,
    '{ armTurnTimer, scheduleAutoStart, processPendingSeatRemovals, teardownSeat, decidePineappleDiscardHold, gameTimerGuardStats, gameShowdownHeld, wire, makeGuardOpts }');
  scope.scheduleAutoStart = m.scheduleAutoStart;
  if ('discardHoldDecider' in t) (t as any).discardHoldDecider = (tb: any) => m.decidePineappleDiscardHold(T, tb);
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
  const socketErrors = () => c.errors.filter((l) => l.startsWith('[socket-handler-error]')).map((l) => JSON.parse(l.slice('[socket-handler-error] '.length)));
  const watchdogFired = () => c.errors.filter((l) => l.startsWith('{"event":"wedge_watchdog_fired"')).length;
  const deal = () => { expect(t.startNewHand()).toBe(true); (scope.broadcastGameState as any)(T); };
  const credited = () => c.credits.reduce((a, x) => a + x[1], 0);
  return { t, m, c, stubbed, socks, act, advance, stats, socketErrors, watchdogFired, deal, scope, credited, insuranceOffers, playerSessions };
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

describe('SERVER-R3-FAULT-1 — the Crazy Pineapple discard pick: a runout payout that throws is settled AT ONCE (3691a70: left for the watchdog, then HELD when anyone left)', () => {
  function pineappleRunout(fault: Fault) {
    const t = new PineappleTable(cfg, true);
    t.sitDown(0, 'H0', 1000, 'player-0', false, true);
    t.sitDown(1, 'H1', 1000, 'player-1', false, true);
    const w = world(t, 3);
    w.deal();
    expect(t.sitDown(2, 'H2', 3000, 'player-2', false, true)).toBe(true);   // a mid-hand join: folded, no cards, nothing in the pot
    w.act(t.activeSeatIndex, 'allIn');
    w.act(t.activeSeatIndex, 'call');
    expect(t.isDiscardHeld()).toBe(true);
    w.socks[0].receive('selectPineappleDiscard', { cardIndex: 0, tableId: T });
    injectFault(t, fault);
    w.socks[1].receive('selectPineappleDiscard', { cardIndex: 0, tableId: T });   // the last pick releases the runout -> payout throws
    return w;
  }

  it.each<[Fault]>([['pre'], ['post'], ['mid'], ['sticky']])('%s-payment fault: rethrown to socketGuard, settled at once (the outcome the payout mark reads), the bystander then leaves, chips conserved for 2 minutes', (fault) => {
    const w = pineappleRunout(fault);
    expect(w.socketErrors()).toEqual([expect.objectContaining({ event: 'selectPineappleDiscard', kind: 'sync' })]);
    expect(w.c.sentry).toBe(1);
    expect(w.t.currentPhase).toBe(GamePhase.HandComplete);             // 3691a70: Showdown (no settle of its own)
    expect(w.stats()).toMatchObject({ humanPathShowdowns: 1, showdownFaults: 1, [OUTCOME[fault]]: 1, showdownHeld: 0 });
    expect(stacks(w.t)).toBe(5000);
    expect(invested(w.t)).toBe(0);
    w.m.teardownSeat(T, w.t, 2, { userId: 9, username: 'h2' }, 'handlePlayerLeave');   // the bystander leaves with his 3000
    expect(w.c.credits).toEqual([[9, 3000, 'handlePlayerLeave']]);
    w.advance(120_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(w.t.currentPhase).not.toBe(GamePhase.Showdown);
    expect(total(w.t) + w.credited()).toBe(5000);
    expect(w.stats()).toMatchObject({ showdownHeld: 0, watchdogShowdowns: 0 });
  });
});

describe('SERVER-R3-FAULT-1 — the watchdog settle skips a seat the payout cannot credit (3691a70: such a seat changing in the wait HELD the hand)', () => {
  /** A hand left resting in Showdown by a path with no settle of its own (the engine called bare), while a seat with nothing in the pot changes. */
  function bare(fault: Fault, change: 'joiner_leaves' | 'seat_taken' | 'folder_leaves') {
    const t = new PokerTable(cfg);
    const n = change === 'folder_leaves' ? 3 : 2;
    for (let i = 0; i < n; i++) t.sitDown(i, `H${i}`, 5000, `player-${i}`, false);
    const w = world(t, 3);
    w.deal();
    let bystander = 2;
    if (change === 'folder_leaves') {
      bystander = t.activeSeatIndex;                                     // first to act pre-flop: nothing in the pot
      expect(t.seats[bystander].totalInvestedThisHand || 0).toBe(0);
      w.act(bystander, 'fold');
    } else {
      expect(t.sitDown(2, 'H2', 3000, 'player-2', false)).toBe(true);    // a mid-hand join: folded, no cards, nothing in the pot
    }
    const start = total(t);
    const closer = toRiver(w);
    injectFault(t, fault);
    expect(() => t.playerCheck(closer)).toThrow();
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(t.payoutStartMark?.payable[bystander]).toBe(false);
    if (change === 'seat_taken') {
      expect(t.standUp(2)).toBe(true);                                   // someone else takes the seat with his own buy-in
      expect(t.sitDown(2, 'J', 777, 'joiner', false)).toBe(true);
    } else {
      w.m.teardownSeat(T, t, bystander, { userId: 9, username: 'b' }, 'handlePlayerLeave');
    }
    return { w, start, bystander };
  }

  it.each<[Fault, 'joiner_leaves' | 'folder_leaves']>([
    ['pre', 'joiner_leaves'], ['post', 'joiner_leaves'], ['mid', 'joiner_leaves'],
    ['pre', 'folder_leaves'], ['post', 'folder_leaves'], ['mid', 'folder_leaves'],
  ])('%s-payment fault, %s: settled at the watchdog\'s first tick (never held, never paid twice), chips conserved', (fault, change) => {
    const { w, start } = bare(fault, change);
    w.advance(15_000);
    expect(w.t.currentPhase).not.toBe(GamePhase.Showdown);             // 3691a70: HELD in Showdown for good
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 0, [OUTCOME[fault]]: 1 });
    expect(w.m.gameShowdownHeld(w.t)).toBe(false);
    w.advance(120_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(total(w.t) + w.credited()).toBe(start);
    expect(w.t.handNumber).toBeGreaterThan(1);                           // play went on
  });

  it('a part-paid hand whose bystander seat was TAKEN in the wait: VOIDED — only the payable seats go back to their stakes, the new occupant keeps his own 777', () => {
    const { w } = bare('mid', 'seat_taken');
    w.advance(15_000);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownVoided: 1, showdownHeld: 0 });
    expect(w.t.seats[2].playerId).toBe('joiner');
    const stake = (i: number) => w.t.seats[i].chipCount + (w.t.seats[i].totalInvestedThisHand || 0);   // (the next hand may be dealt)
    expect(stake(2)).toBe(777);                                          // never the old occupant's 3000
    expect(stake(0) + stake(1)).toBe(10000);
  });

  it('CONTROL — a PAYABLE seat that changed hands still makes the settle HOLD (it cannot be read)', () => {
    const { w } = bare('post', 'joiner_leaves');
    w.t.seats[1].playerId = 'someone-else';
    w.advance(15_000);
    expect(w.m.gameShowdownHeld(w.t)).toBe(true);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 1 });
  });
});

describe("SERVER-R3-FAULT-1 — the watchdog's own forced action: a payout it ran that throws is settled in the same tick", () => {
  it.each<[Fault]>([['post'], ['sticky']])('%s-payment fault on the forced fold of a wedged turn (no clock): HandComplete at the firing tick (3691a70: Showdown until later ticks)', (fault) => {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 5000, 'player-0', false);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    const w = world(t, 2);
    expect(t.startNewHand()).toBe(true);                                 // dealt with no broadcast: no turn clock
    injectFault(t, fault);
    let fired = 0;
    for (let i = 0; i < 60 && !fired; i++) { w.advance(1000); fired = w.watchdogFired(); }
    expect(fired).toBe(1);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.stats()).toMatchObject({ watchdogShowdowns: 1, showdownHeld: 0, [OUTCOME[fault]]: 1 });
    expect(total(t)).toBe(10000);
    w.advance(60_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.advancedInShowdown).toBe(0);
    expect(total(t)).toBe(10000);
  });
});

describe('SERVER-R3-FAULT-1 — the insurance decision: the last accept / decline releases the runout; a payout that throws is settled at once, then rethrown', () => {
  it.each([['declineInsurance'], ['acceptInsurance']])('%s', (ev) => {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 1000, 'player-0', false);
    t.sitDown(1, 'H1', 1000, 'player-1', false);
    const w = world(t, 2);
    t.runoutHoldDecider = (tb: PokerTable) => {
      w.insuranceOffers.set(T, { handNumber: tb.handNumber, boardKey: '', expiresAt: 0, timer: null, quotes: new Map([[0, {}], [1, {}]]), decided: new Set() });
      return true;
    };
    w.deal();
    w.act(t.activeSeatIndex, 'allIn');
    w.act(t.activeSeatIndex, 'call');
    expect(t.isRunoutHeld()).toBe(true);
    w.socks[0].receive('declineInsurance', { tableId: T, handNumber: t.handNumber });
    expect(t.isRunoutHeld()).toBe(true);
    injectFault(t, 'post');
    w.socks[1].receive(ev, { tableId: T, handNumber: t.handNumber });
    expect(w.socketErrors()).toEqual([expect.objectContaining({ event: ev, kind: 'sync' })]);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);                // 3691a70: Showdown, the watchdog's
    expect(w.stats()).toMatchObject({ humanPathShowdowns: 1, showdownPaidFinished: 1, showdownHeld: 0 });
    expect(total(t)).toBe(2000);
    w.advance(60_000);
    expect(w.c.escaped).toBe(0);
    expect(total(t)).toBe(2000);
    expect(w.stats().watchdogShowdowns).toBe(0);
  });
});

describe('SERVER-R3-FAULT-1 — the engine', () => {
  it('payoutStartMark.payable: true for a seat with chips in the pot or still contesting it; false for a 0-invested fold and a mid-hand joiner', () => {
    const t = new PokerTable(cfg);
    for (let i = 0; i < 3; i++) t.sitDown(i, `H${i}`, 5000, `player-${i}`, false);
    expect(t.startNewHand()).toBe(true);
    const folder = t.activeSeatIndex;
    expect(t.playerFold(folder)).toBe(true);
    expect(t.sitDown(3, 'J', 3000, 'joiner', false)).toBe(true);
    for (let g = 0; g < 40 && t.isHandInProgress(); g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    const p = t.payoutStartMark!;
    expect(p.payable.slice(0, 4)).toEqual([0, 1, 2, 3].map((i) => i !== folder && i !== 3));
    expect(p.payable.slice(4).every((x) => x === false)).toBe(true);
  });

  it('a dead blind is never posted into a pot whose payout began (a hand resting in Showdown); CONTROL: mid-hand it still posts', () => {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 5000, 'player-0', false);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(t.startNewHand()).toBe(true);
    expect(t.sitDown(2, 'J', 3000, 'joiner', false)).toBe(true);
    t.seats[2].deadBlindOwedChips = 100;
    t.seats[2].missedBlind = 'big';
    injectFault(t, 'post');
    for (let g = 0; g < 40 && t.currentPhase !== GamePhase.Showdown; g++) {
      const a = t.activeSeatIndex;
      try { if (!t.playerCall(a)) t.playerCheck(a); } catch { /* the faulted payout */ }
    }
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(t.postOwedBlindsNow(2)).toEqual({ ok: false, reason: 'not_in_hand' });   // 3691a70: posted into the paid pot
    expect(t.seats[2].chipCount).toBe(3000);
    expect(t.seats[2].deadBlindOwedChips).toBe(100);
    const u = new PokerTable(cfg);
    u.sitDown(0, 'H0', 5000, 'player-0', false);
    u.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(u.startNewHand()).toBe(true);
    expect(u.sitDown(2, 'J', 3000, 'joiner', false)).toBe(true);
    u.seats[2].deadBlindOwedChips = 100;
    u.seats[2].missedBlind = 'big';
    expect(u.postOwedBlindsNow(2)).toEqual({ ok: true, amount: 100 });
  });
});

describe('SERVER-R3-REG-1 — a sticky absent-drawer stand-pat fault is bounded (3691a70: re-armed every 500 ms without end)', () => {
  function absentWorld(faults: number) {
    const t = new FiveCardDrawTable(cfg, false);
    for (let i = 0; i < 3; i++) t.sitDown(i, `H${i}`, 5000, `player-${i}`, false, true);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(t.playerDraw(0, [])).toBe(true);
    expect(t.playerDraw(2, [])).toBe(true);
    const real = t.playerDraw.bind(t);
    let left = faults;
    t.playerDraw = (s: number, idx: number[]) => { if (s === 1 && left > 0) { left--; throw new TypeError('injected draw fault'); } return real(s, idx); };
    let now = 1_000_000; let nextId = 1;
    const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
    const c = { escaped: 0, broadcasts: 0, sentry: 0, errLines: 0 };
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
      pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {},
      Sentry: { captureException: () => { c.sentry++; } },
      broadcastGameState: () => { c.broadcasts++; },
      setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error: (m: unknown) => { if (String(m).startsWith('[game-timer-error]')) c.errLines++; } },
      log: { debug() {}, info() {} },
      drawTimers: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), drawClockStart: () => 1_000_000,
      studDrawKindOf, chooseBotDiscards, fastModeTables: new Map(), tableWantsFastBots: () => true, getThinkingDelay: () => 500, executeAIAction() {},
      seatHasAnyPlayingSession: (_tid: string, seat: number) => seat !== 1,   // seat 1 is ABSENT
      isAbsentTournamentSeatPastHandLimit: () => false, tournamentSeatSitsOut: () => false,
      reservedSeats: new Map(), ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000,
    };
    const { exports: m } = load(`${SCHEDULE_AI}\n${ABSENT_DRAWERS}\n${GUARD}\n${SAS}`, scope, '{ scheduleAIAction, armAbsentDrawerStandPat, scheduleAutoStart, gameTimerGuardStats }');
    scope.scheduleAIAction = m.scheduleAIAction;
    scope.armAbsentDrawerStandPat = m.armAbsentDrawerStandPat;
    scope.scheduleAutoStart = m.scheduleAutoStart;
    const advance = (ms: number) => {
      const until = now + ms;
      for (let g = 0; g < 1_000_000; g++) {
        jobs.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!jobs.length || jobs[0].at > until) break;
        const j = jobs.shift()!; now = j.at;
        try { j.fn(); } catch { c.escaped++; }
      }
      now = until;
    };
    return { t, m, c, advance };
  }

  it('the REAL scheduleAIAction / armAbsentDrawerStandPat: 4 throws, then the round is the 30 s draw clock\'s (5 retries); nothing after that for 10 minutes', () => {
    const w = absentWorld(Infinity);
    w.m.scheduleAIAction(T);
    w.advance(60_000);
    const atMin1 = { ...w.m.gameTimerGuardStats, sentry: w.c.sentry, broadcasts: w.c.broadcasts };
    expect(atMin1).toMatchObject({ absentStandPatThrows: 4, absentStandPatGiveUps: 1, drawClockThrows: 1, drawRoundRetries: 5 });   // 3691a70: 120 absent throws a minute
    expect(w.c.sentry).toBeLessThan(30);
    w.advance(540_000);
    expect(w.c.escaped).toBe(0);
    expect(w.t.currentPhase).toBe(GamePhase.Draw1);                    // the sticky seat still waits (disclosed residual)
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentStandPatThrows: 4, absentStandPatGiveUps: 1, drawClockThrows: 1, drawRoundRetries: 5 });
    expect(w.c.sentry).toBe(atMin1.sentry);                             // 3691a70: 600 Sentry events in 10 minutes
    expect(w.c.broadcasts).toBe(atMin1.broadcasts);
    expect(w.m.gameTimerGuardStats.logLinesSuppressed).toBe(0);
  });

  it('a DOUBLE transient stand-pat throw (the timer and its recovery) still completes the round within a second', () => {
    const w = absentWorld(2);
    w.m.scheduleAIAction(T);
    w.advance(1100);
    expect(w.c.escaped).toBe(0);
    expect(w.t.currentPhase).not.toBe(GamePhase.Draw1);
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentStandPatThrows: 1, absentStandPatGiveUps: 0, recoveryThrows: 1 });
  });
});

describe('SERVER-R3-REG-2 — the 500 ms sit-out / orphan auto-act and a hand resting in Showdown', () => {
  /** Heads-up, the river's last check (a path with no settle) throws after paying: the hand rests un-held in Showdown, stacks 10000. */
  function restingPaidShowdown() {
    const t = new PokerTable(cfg);
    t.sitDown(0, 'H0', 5000, 'player-0', false);
    t.sitDown(1, 'H1', 5000, 'player-1', false);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 20 && t.currentPhase !== GamePhase.River; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.playerCheck(t.activeSeatIndex)).toBe(true);
    const last = t.activeSeatIndex;
    injectFault(t, 'post');
    expect(() => t.playerCheck(last)).toThrow('injected post-payment fault');
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(stacks(t)).toBe(10000);
    return t;
  }
  function orphanWorld(t: PokerTable) {
    let now = 1_000_000; let nextId = 1;
    const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
    const c = { escaped: 0, broadcasts: 0, acted: 0 };
    let bThrow = 1;
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
      pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null,
      broadcastGameState: () => { c.broadcasts++; if (bThrow > 0) { bThrow--; throw new TypeError('injected broadcast fault'); } }, scheduleAIAction() {},
      setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error() {} }, log: { debug() {}, info() {} },
      seatHasAnySession: () => false, seatHasAnyPlayingSession: () => false, isTournamentTable: () => false, reservedSeats: new Map(),
      tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, challengeTables: new Map(), absentTournamentSeatMayLimp: () => false,
      turnTimers: new Map(), turnStartedSeatMap: new Map(), noteAbsentTimeout() {}, sitOutTournamentSeatAfterTimeout: () => false,
      armTurnTimer() {}, tournamentTimeoutSitOutStats: { shortClockRearmed: 0 },
    };
    const realMark = t.markAutoAction.bind(t);
    t.markAutoAction = (...a: [number, any]) => { c.acted++; return realMark(...a); };
    const { exports: m } = load(`${AUTO_ACT}\n${ORPHAN}\n${GUARD}\n${SAS}`, scope, '{ orphanAct, recoverAbsentActThrow, scheduleAutoStart, gameTimerGuardStats }');
    scope.scheduleAutoStart = m.scheduleAutoStart;
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
    return { m, c, advance };
  }

  it('the auto-act never acts in Showdown (as the turn clock and a bot turn): no act, no broadcast, no throw; the hand is left to its settle (3691a70: acted, its broadcast threw into a re-settle)', () => {
    const t = restingPaidShowdown();
    const w = orphanWorld(t);
    w.m.orphanAct(T, t.activeSeatIndex);
    w.advance(1000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.acted).toBe(0);
    expect(w.c.broadcasts).toBe(0);
    expect(w.m.gameTimerGuardStats).toMatchObject({ absentActThrows: 0, showdownFaults: 0 });
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(stacks(t)).toBe(10000);
  });

  it("the settle's mark-phase guard, behaviourally: a timer whose stake mark was taken IN Showdown is settled from the payout mark — paid_finished, never paid a second time (reverted guard: 10200)", () => {
    const t = restingPaidShowdown();
    const w = orphanWorld(t);
    const inShowdown = {
      hand: t.handNumber, version: t.stateVersion, log: t.actionLog.length, phase: t.currentPhase,
      stakes: t.seats.map((s) => (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : -1)),
      ids: t.seats.map((s) => s.playerId),
    };
    expect(inShowdown.phase).toBe(GamePhase.Showdown);
    w.m.recoverAbsentActThrow(T, t.activeSeatIndex, inShowdown, new TypeError('injected broadcast fault'));
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(stacks(t)).toBe(10000);
    expect(invested(t)).toBe(0);
    expect(w.m.gameTimerGuardStats).toMatchObject({ showdownPaidFinished: 1, showdownResolved: 0, showdownHeld: 0 });
  });
});

describe('SERVER-R3-MEAS-1 — the Spin & Go first deal: a throw BEFORE dealing is retried once, 3 s later (3691a70: waited for the player\'s Deal now)', () => {
  function spinWorld(throws: number) {
    const t = new PokerTable(cfg);
    for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 500, `player-${i}`, i > 0);
    const realDeal = t.startNewHand.bind(t);
    const c = { attempts: 0, escaped: 0 };
    let left = throws;
    t.startNewHand = () => { c.attempts++; if (left > 0) { left--; throw new TypeError('injected deal fault (before dealing)'); } return realDeal(); };
    let now = 1_000_000; let nextId = 1;
    const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, TURN_TIMEOUT_MS: TURN_MS,
      pendingAutoStartTimers: new Map(), clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null,
      broadcastGameState() {}, scheduleAIAction() {}, sendProgressToPlayer() {},
      setTimeout: (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error() {} }, log: { debug() {}, info() {} },
    };
    const { exports: m } = load(`${SPIN_GO}\n${GUARD}\n${SAS}`, scope, '{ spinGoDeal, scheduleAutoStart, gameTimerGuardStats }');
    scope.scheduleAutoStart = m.scheduleAutoStart;
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
    return { t, m, c, advance };
  }

  it('one throw: the retry 3 s later deals hand 1', () => {
    const w = spinWorld(1);
    w.m.spinGoDeal(T, { id: 'S' });
    w.advance(3600);
    expect(w.t.currentPhase).toBe(GamePhase.WaitingForPlayers);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealThrows: 1, spinGoDealRetries: 1 });
    w.advance(3000);
    expect(w.c.escaped).toBe(0);
    expect(w.t.handNumber).toBe(1);
    expect(w.t.isHandInProgress()).toBe(true);                          // 3691a70: still waiting, hand 0
    expect(w.c.attempts).toBe(2);
  });

  it('a throw every time: retried ONCE only, then the table waits for Deal now (nothing escapes, no loop)', () => {
    const w = spinWorld(Infinity);
    w.m.spinGoDeal(T, { id: 'S' });
    w.advance(60_000);
    expect(w.c.escaped).toBe(0);
    expect(w.c.attempts).toBe(2);
    expect(w.t.currentPhase).toBe(GamePhase.WaitingForPlayers);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealThrows: 2, spinGoDealRetries: 1 });
  });

  it('CONTROL — no throw: dealt once at 3.5 s, no retry', () => {
    const w = spinWorld(0);
    w.m.spinGoDeal(T, { id: 'S' });
    w.advance(10_000);
    expect(w.c.attempts).toBe(1);
    expect(w.t.handNumber).toBe(1);
    expect(w.m.gameTimerGuardStats).toMatchObject({ dealThrows: 0, spinGoDealRetries: 0 });
  });
});

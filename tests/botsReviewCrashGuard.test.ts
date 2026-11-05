/**
 * Bots review 2026-11-04 (server-stability C1, A-crash) — the game timer crash guard.
 *
 * At 0dc1b96 a throw on a game TIMER path (a bot's action or draw, a scheduled
 * deal) was uncaught: it reached processGuards (flush, then exit(1)), which
 * voids every running qualifier. The same code reached by a human is caught by
 * socketGuard. Now each of those timers catches, logs `[game-timer-error]`,
 * counts (health crashSafety.gameTimers) and moves the table on, and a hand
 * found resting in Showdown (a faulted determineWinners) is retried, finished,
 * voided or held — never paid twice.
 *
 * The REAL guard block, scheduleAIAction, executeAIAction and scheduleAutoStart
 * are sliced from src/index.ts and run on the REAL engine with the REAL
 * decideAction (seeded Math.random). Timers run on a manual clock injected into
 * the slice's scope (setTimeout / clearTimeout / Date), the way the design
 * harness (server-stability v2 guard_v2) measured: the sliced code sees the
 * manual clock, while AIPlayer's own Monte Carlo budget keeps real time. Faults
 * are injected the way guard_v2 injected them.
 *
 * Fails on 0dc1b96: the guard block, PokerTable.completeHandAfterFault and the
 * timers' try/catch do not exist there (CONTROL cases (g) and (k) run the
 * 0dc1b96 behaviour and show the exit / the double payment).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { PokerTable, GamePhase, PlayerAction, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { decideAction, generateRandomProfile, getThinkingDelay } from '../src/ai/AIPlayer';
import { studDrawKindOf, chooseBotDiscards } from '../src/ai/studDrawStrength';
import { slice, fnSrc, load } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const T = 'T';
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: T, tableName: 'T', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000, ...over } as any);

const GUARD = slice('// ===== Game timer crash guard (bots review 2026-11-04, A-crash) =====', '// ===== end game timer crash guard =====\n');
const SCHED = fnSrc('function scheduleAIAction(');
const EXEC = fnSrc('function executeAIAction(');
const SAS = fnSrc('function scheduleAutoStart(');
const AOF = `${fnSrc('function allInOrFoldAllows(')}\n${fnSrc('function allInOrFoldDecision(')}`;

/** Seeded Math.random for the bots' choices (the deck stays crypto-random). */
function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}
const total = (t: PokerTable) => t.seats.reduce((a, s) => a + (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : 0), 0);
const COUNTERS = ['actionThrows', 'drawThrows', 'autoStartThrows', 'heartbeatThrows', 'turnClockThrows', 'drawClockThrows', 'actedFor', 'turnAdvanced', 'stoodPat', 'autoStartRetried',
  'showdownFaults', 'showdownResolved', 'showdownPaidFinished', 'showdownVoided', 'showdownHeld', 'recoveryThrows', 'logLinesSuppressed'];

interface WorldOpts {
  /** decideAction stand-in (default: the real one). */
  decide?: (...a: any[]) => any;
  broadcast?: (id: string) => void;
  /** autoStartNextHand stand-in (default: reload busted stacks, deal, broadcast, schedule the bots, up to maxHands). */
  autoStart?: () => void;
  maxHands?: number;
  aof?: boolean;
  difficulty?: 'medium' | 'hard';
  bots?: number;
  /** the index.ts handResult listener's scheduleAutoStart (default on) */
  wireHandResult?: boolean;
}

/** The REAL timer code on a manual clock. */
function world(table: PokerTable, opts: WorldOpts = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
  const setTimeoutF = (fn: () => void, ms?: number) => { const id = nextId++; jobs.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; };
  const clearTimeoutF = (id: number) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); };
  const profiles = new Map<number, any>();
  const bots = opts.bots ?? 0;
  for (let i = 0; i < bots; i++) {
    const p = generateRandomProfile(opts.difficulty ?? 'medium');
    profiles.set(i, p);
    expect(table.sitDown(i, `${p.botName}${i}`, table.config.minBuyIn, `ai-${i}`, true)).toBe(true);
  }
  const errors: string[] = [];
  const pendingAutoStartTimers = new Map<string, any>();
  const aiTimeouts = new Map<string, any>();
  const c = { hands: 0, reloads: 0, escaped: 0, escapes: [] as string[], handResults: 0, decide: 0 };
  const maxHands = opts.maxHands ?? 1;
  const scope: any = {
    tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
    aiProfiles: new Map([[T, profiles]]), aiTimeouts, drawTimers: new Map(), DrawPhases: DRAWS,
    GamePhase, PlayerAction, FiveCardDrawTable, MAX_SEATS,
    decideAction: (...a: any[]) => { c.decide++; return (opts.decide || (decideAction as any))(...a); },
    allInOrFoldTables: new Set(opts.aof ? [T] : []),
    broadcastGameState: (id: string) => { if (opts.broadcast) opts.broadcast(id); },
    clearHandSnapshot: async () => {}, pendingAutoStartTimers, fastModeTables: new Map(), tableWantsFastBots: () => false,
    getThinkingDelay, TURN_TIMEOUT_MS: 30000, drawClockStart: () => now, armAbsentDrawerStandPat: () => {},
    studDrawKindOf, chooseBotDiscards, Sentry: null,
    setTimeout: setTimeoutF, clearTimeout: clearTimeoutF,
    console: { log() {}, warn() {}, error: (m: unknown) => errors.push(String(m)) },
    Date: class FakeDate extends Date { static now() { return now; } },
  };
  scope.autoStartNextHand = opts.autoStart || (() => {
    if (table.currentPhase !== GamePhase.HandComplete) return;
    if (c.hands >= maxHands) return;
    for (const st of table.seats) if (st.state === 'occupied' && st.chipCount <= 0) { st.chipCount = table.config.minBuyIn; st.eliminated = false; c.reloads++; }
    if (table.startNewHand()) { c.hands++; scope.broadcastGameState(T); scope.scheduleAIAction(T); }
  });
  table.on('handResult', () => { c.handResults++; });
  if (opts.wireHandResult !== false) table.on('handResult', () => scope.scheduleAutoStart(T));
  const { exports: m, stubbed } = load(`${GUARD}\n${AOF}\n${SAS}\n${SCHED}\n${EXEC}`, scope,
    '{ scheduleAIAction, executeAIAction, scheduleAutoStart, gameTimerGuardStats, gameShowdownHeld, settleShowdownAfterFault, recoverAutoStartThrow }');
  scope.scheduleAIAction = m.scheduleAIAction;
  scope.scheduleAutoStart = m.scheduleAutoStart;
  const step = (): boolean => {
    if (!jobs.length) return false;
    jobs.sort((a, b) => a.at - b.at || a.id - b.id);
    const j = jobs.shift()!;
    now = j.at;
    try { j.fn(); } catch (e) { c.escaped++; c.escapes.push(String((e as Error)?.message || e)); }
    return true;
  };
  /** Run jobs until `until()` holds or the queue empties (bounded). */
  const run = (until: () => boolean = () => false, max = 200_000) => { for (let g = 0; g < max && !until() && step(); g++) { /* run */ } };
  const deal = () => { expect(table.startNewHand()).toBe(true); c.hands++; };
  const stats = () => { const s = { ...m.gameTimerGuardStats }; delete s.lastAt; return s; };
  const tagged = () => errors.filter((l) => l.startsWith('[game-timer-error] ')).map((l) => JSON.parse(l.slice('[game-timer-error] '.length)));
  return { m, scope, stubbed, c, step, run, deal, stats, tagged, jobs, pendingAutoStartTimers, aiTimeouts, now: () => now };
}

const zeroStats = () => Object.fromEntries(COUNTERS.map((k) => [k, 0]));

describe('C1 — a throw on a bot timer is recovered, never left to the process crash handler', () => {
  let restore: () => void;
  beforeEach(() => { restore = seedRandom(20261104); });
  afterEach(() => restore());

  it("(a) decideAction throws once at a Hold'em bot turn: nothing escapes, the bot is checked or folded once, the turn moves on", () => {
    const t = new PokerTable(cfg());
    let thrown = false;
    const w = world(t, { bots: 3, decide: (...a: any[]) => { if (!thrown) { thrown = true; throw new TypeError('injected decideAction fault'); } return (decideAction as any)(...a); } });
    w.deal();
    const seat = t.activeSeatIndex;
    const entries = () => t.actionLog.filter((e) => e.seatIndex === seat && e.street === GamePhase.PreFlop);
    expect(entries()).toHaveLength(0);
    const before = total(t);
    w.m.scheduleAIAction(T);
    expect(w.step()).toBe(true);                       // the bot's action timer
    expect(w.c.escaped).toBe(0);
    expect(entries()).toHaveLength(1);
    expect(['checked', 'folded']).toContain(entries()[0].action);
    expect(t.activeSeatIndex).not.toBe(seat);
    expect(total(t)).toBe(before);
    expect(w.stats()).toEqual({ ...zeroStats(), actionThrows: 1, actedFor: 1 });
    const line = w.tagged()[0];
    expect(line).toMatchObject({ kind: 'action', tableId: T, seatIndex: seat, error: 'injected decideAction fault' });
    expect(typeof line.where).toBe('string');
    expect(w.aiTimeouts.has(T)).toBe(true);           // the next bot is scheduled
    expect([...w.stubbed]).toEqual([]);
  });

  it('(b) a playerAction listener throws after a bot\'s call: one entry for that decision, the next seat active, turnAdvanced=1, chips conserved', () => {
    const t = new PokerTable(cfg());
    const w = world(t, { bots: 3, decide: () => ({ action: PlayerAction.Call, raiseAmount: 0 }) });
    let armed = true;
    t.on('playerAction', () => { if (armed) { armed = false; throw new TypeError('injected playerAction listener fault'); } });
    w.deal();
    const seat = t.activeSeatIndex;
    const before = total(t);
    w.m.scheduleAIAction(T);
    w.step();
    expect(w.c.escaped).toBe(0);
    const mine = t.actionLog.filter((e) => e.seatIndex === seat && e.street === GamePhase.PreFlop);
    expect(mine).toHaveLength(1);
    expect(mine[0].action).toMatch(/^called/);
    expect(t.activeSeatIndex).not.toBe(seat);
    expect(t.activeSeatIndex).toBeGreaterThanOrEqual(0);
    expect(total(t)).toBe(before);
    expect(w.stats()).toEqual({ ...zeroStats(), actionThrows: 1, turnAdvanced: 1 });
  });

  it('(c) broadcastGameState throws on the hand-ending action: nothing escapes, a deal is pending and the next hand is dealt', () => {
    const t = new PokerTable(cfg());
    let hot = false;
    const w = world(t, {
      bots: 2, maxHands: 2,
      decide: () => { hot = true; return { action: PlayerAction.Fold, raiseAmount: 0 }; },
      broadcast: () => { if (hot) { hot = false; throw new TypeError('injected broadcast fault'); } },
    });
    w.deal();
    w.m.scheduleAIAction(T);
    w.step();
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    w.run(() => t.handNumber === 2);
    expect(t.handNumber).toBe(2);
    expect(t.isHandInProgress()).toBe(true);
    expect(w.c.escaped).toBe(0);
    expect(w.stats().actionThrows).toBe(1);
    expect(total(t)).toBe(20000);
  });

  it('(d) Five Card Draw: one bot\'s holeCards throws inside its draw timer: that bot stands pat, the round completes', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    const w = world(t, { bots: 3, decide: () => ({ action: PlayerAction.Call, raiseAmount: 0 }) });
    w.deal();
    for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    const victim = 1;
    const seat = t.seats[victim] as any;
    let cards = seat.holeCards;
    let armed = false;
    Object.defineProperty(seat, 'holeCards', {
      configurable: true,
      get() { if (armed) { armed = false; throw new TypeError('injected draw fault'); } return cards; },
      set(v) { cards = v; },
    });
    const drawn = new Map<number, number[]>();
    const real = t.playerDraw.bind(t);
    t.playerDraw = (s: number, idx: number[]) => { drawn.set(s, [...idx]); return real(s, idx); };
    w.m.scheduleAIAction(T);                        // arms the three draw timers (reads holeCards: not armed yet)
    armed = true;                                   // the victim's own draw timer throws once
    expect(w.jobs.length).toBeGreaterThanOrEqual(3);  // three draw timers + the draw clock
    w.run(() => t.currentPhase !== GamePhase.Draw1, 50);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);
    const st = w.stats();
    expect(st.drawThrows).toBe(1);
    expect(st.stoodPat).toBe(1);
    // whichever bot's timer read holeCards first was the one that threw; it stood pat ([])
    const thrower = w.tagged().find((l) => l.kind === 'draw')!.seatIndex;
    expect(drawn.get(thrower)).toEqual([]);
    expect([...w.stubbed]).toEqual([]);
  });

  it('(e) All-In or Fold: the recovery folds a bot facing a bet and checks only a FREE check — never calls or raises', () => {
    // facing the big blind: folded
    const t = new PokerTable(cfg());
    const w = world(t, { bots: 3, aof: true, decide: () => { throw new TypeError('injected decideAction fault'); } });
    w.deal();
    const seat = t.activeSeatIndex;
    const stack = t.seats[seat].chipCount;
    w.m.scheduleAIAction(T);
    w.step();
    expect(w.c.escaped).toBe(0);
    const mine = t.actionLog.filter((e) => e.seatIndex === seat && e.street === GamePhase.PreFlop);
    expect(mine.map((e) => e.action)).toEqual(['folded']);
    expect(t.seats[seat].chipCount).toBe(stack);
    expect(w.stats()).toMatchObject({ actionThrows: 1, actedFor: 1, turnAdvanced: 0 });

    // a free check (the engine walked to a limped big blind by hand): checked, no chips move
    const t2 = new PokerTable(cfg());
    const w2 = world(t2, { bots: 3, aof: true, decide: () => { throw new TypeError('injected decideAction fault'); } });
    w2.deal();
    expect(t2.playerFold(t2.activeSeatIndex)).toBe(true);   // UTG folds
    expect(t2.playerCall(t2.activeSeatIndex)).toBe(true);   // the small blind completes
    const bb = t2.activeSeatIndex;
    const bbStack = t2.seats[bb].chipCount;
    const before2 = total(t2);
    w2.m.scheduleAIAction(T);
    w2.step();
    const bbActs = t2.actionLog.filter((e) => e.seatIndex === bb && e.street === GamePhase.PreFlop && !/^posted /.test(e.action));
    expect(bbActs.map((e) => e.action)).toEqual(['checked']);
    expect(t2.seats[bb].chipCount).toBe(bbStack);
    expect(total(t2)).toBe(before2);
    expect(w2.c.escaped).toBe(0);
    expect(w2.stats()).toMatchObject({ actionThrows: 1, actedFor: 1, turnAdvanced: 0 });
  });

  const RING: Array<[string, () => PokerTable, number]> = [
    ["Hold'em", () => new PokerTable(cfg()), 200],
    ['PLO-4', () => new OmahaTable(cfg(), false, 4), 200],
    ['Omaha Hi-Lo', () => new OmahaTable(cfg(), true, 4), 200],
    ['Seven Card Stud', () => new SevenStudTable(cfg({ ante: 10 }), false, false), 60],
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true), 60],
  ];
  it.each(RING)('(f) %s: fault-free hands — every counter stays 0, no hand is stuck, chips exact at every hand end', (_n, mk, hands) => {
    const t = mk();
    const w = world(t, { bots: 4, maxHands: hands });
    w.deal();
    w.m.scheduleAIAction(T);
    const start = total(t);
    let lastSig = '', lastProgress = w.now(), stuck = false, drift = 0;
    for (let g = 0; g < 400_000 && w.step(); g++) {
      const sig = `${t.handNumber}|${t.currentPhase}|${t.activeSeatIndex}|${t.actionLog.length}|${(t as any).drawsCompleted ? (t as any).drawsCompleted.size : 0}`;
      if (sig !== lastSig) { lastSig = sig; lastProgress = w.now(); }
      if (w.now() - lastProgress > 40_000) { stuck = true; break; }
      if (t.currentPhase === GamePhase.HandComplete) drift = Math.max(drift, Math.abs(total(t) - w.c.reloads * t.config.minBuyIn - start));
    }
    expect(stuck).toBe(false);
    expect(w.c.escaped).toBe(0);
    expect(w.c.hands).toBe(hands);
    expect(w.c.handResults).toBe(hands);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(drift).toBe(0);
    expect(w.stats()).toEqual(zeroStats());
    expect(w.tagged()).toEqual([]);
    expect([...w.stubbed]).toEqual([]);
  }, 180_000);

  it('(h) REVIEW fold_mint: a fold-won pot whose first buildPotBreakdown throws ends paid_finished; Σ chips never rises (20000 stays 20000); exactly one handResult', () => {
    const t = new PokerTable(cfg());
    const w = world(t, { bots: 2, decide: () => ({ action: PlayerAction.Fold, raiseAmount: 0 }), wireHandResult: false });
    let calls = 0;
    const realB = (t as any).buildPotBreakdown.bind(t);
    (t as any).buildPotBreakdown = (...a: any[]) => { calls++; if (calls === 1) throw new TypeError('injected post-payment fault'); return realB(...a); };
    w.deal();
    expect(total(t)).toBe(20000);
    w.m.scheduleAIAction(T);
    w.run(() => t.currentPhase === GamePhase.HandComplete, 20);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats.reduce((a, s) => a + s.chipCount, 0)).toBe(20000);
    expect(t.seats.every((s) => (s.totalInvestedThisHand || 0) === 0)).toBe(true);
    expect(w.c.handResults).toBe(1);
    expect(w.stats()).toMatchObject({ actionThrows: 1, showdownFaults: 1, showdownPaidFinished: 1, showdownResolved: 0, showdownVoided: 0, showdownHeld: 0 });
    expect(w.tagged().find((l) => l.kind === 'showdown')).toMatchObject({ outcome: 'paid_finished', credited: 100, pot: 100 });   // the big blind's uncalled 50 went back first
    // the next timer pass never pays it again
    w.run(() => false, 20);
    expect(t.seats.reduce((a, s) => a + s.chipCount, 0)).toBe(20000);
  });

  it('(i) a turnChanged listener throws during the deal executeAIAction\'s inline 1.5 s timer runs: nothing escapes, the next bot is scheduled', () => {
    const t = new PokerTable(cfg());
    let armed = false;
    t.on('turnChanged', () => { if (armed) { armed = false; throw new TypeError('injected turnChanged listener fault'); } });
    const w = world(t, { bots: 2, maxHands: 2, wireHandResult: false, decide: () => ({ action: PlayerAction.Fold, raiseAmount: 0 }) });
    w.deal();
    w.m.scheduleAIAction(T);
    w.step();                                   // the fold ends the hand; the inline 1.5 s deal is armed
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    w.aiTimeouts.clear();
    armed = true;
    w.step();                                   // the deal: turnChanged throws inside startNewHand
    expect(w.c.escaped).toBe(0);
    expect(t.handNumber).toBe(2);
    expect(t.isHandInProgress()).toBe(true);
    expect(w.stats()).toMatchObject({ autoStartThrows: 1, autoStartRetried: 0 });
    expect(w.aiTimeouts.has(T)).toBe(true);    // the next bot is scheduled
  });

  it('(i) the same through scheduleAutoStart', () => {
    const t = new PokerTable(cfg());
    let armed = false;
    t.on('turnChanged', () => { if (armed) { armed = false; throw new TypeError('injected turnChanged listener fault'); } });
    const w = world(t, { bots: 2, maxHands: 2, wireHandResult: false, decide: () => ({ action: PlayerAction.Fold, raiseAmount: 0 }) });
    w.deal();
    expect(t.playerFold(t.activeSeatIndex)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    w.m.scheduleAutoStart(T);
    armed = true;
    w.step();
    expect(w.c.escaped).toBe(0);
    expect(t.handNumber).toBe(2);
    expect(w.stats()).toMatchObject({ autoStartThrows: 1 });
    expect(w.aiTimeouts.has(T)).toBe(true);
  });

  it('(i) a PRE-deal throw is retried exactly once, 3 s later; a repeat throw is not retried again', () => {
    const t = new PokerTable(cfg());
    let throws = 2;
    let dealt = 0;
    const w = world(t, {
      bots: 2, wireHandResult: false,
      autoStart: () => { if (throws > 0) { throws--; throw new TypeError('injected autostart (pre-deal) fault'); } dealt++; },
    });
    w.deal();
    expect(t.playerFold(t.activeSeatIndex)).toBe(true);
    w.m.scheduleAutoStart(T);
    const t0 = w.now();
    w.step();                                  // first deal throws
    expect(w.stats()).toMatchObject({ autoStartThrows: 1, autoStartRetried: 1 });
    expect(w.pendingAutoStartTimers.has(T)).toBe(true);
    expect(w.jobs.map((j) => j.at - w.now())).toEqual([3000]);
    w.step();                                  // the retry, 3 s later, throws too
    expect(w.now() - t0).toBe(1500 + 3000);
    expect(w.c.escaped).toBe(0);
    expect(w.stats()).toMatchObject({ autoStartThrows: 2, autoStartRetried: 1 });
    expect(w.jobs).toHaveLength(0);            // no second retry: the heartbeat owns it now
    expect(dealt).toBe(0);
  });

  function toShowdownWorld(awardThrows: number) {
    const t = new PokerTable(cfg());
    const w = world(t, {
      bots: 2, wireHandResult: false,
      decide: (tb: PokerTable, s: number) => ({ action: tb.getCallAmount(tb.seats[s]) > 0 ? PlayerAction.Call : PlayerAction.Check, raiseAmount: 0 }),
    });
    const spm = (t as any).sidePotManager;
    const real = spm.awardPots.bind(spm);
    let left = awardThrows;
    spm.awardPots = (...a: any[]) => { if (left > 0) { left--; throw new TypeError('injected pre-payment fault'); } return real(...a); };
    return { t, w };
  }
  it('(j) awardPots throws once: the engine\'s own showdown is retried once — resolved, paid once, chips conserved', () => {
    const { t, w } = toShowdownWorld(1);
    w.deal();
    w.m.scheduleAIAction(T);
    w.run(() => t.currentPhase === GamePhase.HandComplete, 200);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.c.handResults).toBe(1);
    expect(total(t)).toBe(20000);
    expect(t.seats.reduce((a, s) => a + s.chipCount, 0)).toBe(20000);
    expect(w.stats()).toMatchObject({ showdownFaults: 1, showdownResolved: 1, showdownVoided: 0, showdownPaidFinished: 0 });
  });
  it('(j) awardPots throws twice (the retry fails too): VOIDED — every stack back to its stake before the faulted action', () => {
    const { t, w } = toShowdownWorld(2);
    w.deal();
    w.m.scheduleAIAction(T);
    w.run(() => t.currentPhase === GamePhase.HandComplete, 200);
    expect(w.c.escaped).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount).toBe(10000);
    expect(t.seats[1].chipCount).toBe(10000);
    expect(t.seats.every((s) => (s.totalInvestedThisHand || 0) === 0)).toBe(true);
    expect(w.c.handResults).toBe(1);
    expect(w.stats()).toMatchObject({ showdownFaults: 1, showdownVoided: 1, showdownResolved: 0 });
    expect(w.tagged().find((l) => l.kind === 'showdown')).toMatchObject({ outcome: 'voided', credited: 0 });
  });

  /** The fold_mint rest: a fold-won pot PAID, then buildPotBreakdown threw — Showdown, totals not reset. */
  function faultedFoldShowdown() {
    const t = new PokerTable(cfg());
    const w = world(t, { bots: 2, wireHandResult: false });
    let calls = 0;
    const realB = (t as any).buildPotBreakdown.bind(t);
    (t as any).buildPotBreakdown = (...a: any[]) => { calls++; if (calls === 1) throw new TypeError('injected post-payment fault'); return realB(...a); };
    w.deal();
    const mark = { hand: t.handNumber, version: t.stateVersion, log: t.actionLog.length, phase: t.currentPhase,
      stakes: t.seats.map((s) => (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : -1)), ids: t.seats.map((s) => s.playerId) };
    expect(() => t.playerFold(t.activeSeatIndex)).toThrow('injected post-payment fault');
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(t.seats.reduce((a, s) => a + s.chipCount, 0)).toBe(20000);   // paid once
    return { t, w, mark };
  }
  const WATCHDOG = slice('const WEDGE_TURN_GRACE_MS', '}, 15000);');
  function watchdogTicks(t: PokerTable, held: (tb: PokerTable) => boolean, ticks: number) {
    let tick: (() => void) | null = null;
    let now = 2_000_000;
    let advanced = 0;
    const realAdvance = (t as any).advanceTurn.bind(t);
    (t as any).advanceTurn = () => { advanced++; return realAdvance(); };
    const scope: any = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined), getTableList: () => [{ tableId: T }] },
      GamePhase, DrawPhases: DRAWS, gameShowdownHeld: held,
      turnTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(), turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(),
      TURN_TIMEOUT_MS: 30000, broadcastGameState() {}, scheduleAIAction() {},
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      Date: class FakeDate extends Date { static now() { return now; } },
      console: { log() {}, warn() {}, error() {} },
    };
    load(WATCHDOG, scope, '{}');
    for (let i = 0; i < ticks; i++) { now += 15_000; tick!(); }
    return advanced;
  }

  it('(k) a seat changed under the mark: HELD — the wedge watchdog never advances it, executeAIAction returns at once (CONTROL: un-held, the watchdog re-pays)', () => {
    const { t, w, mark } = faultedFoldShowdown();
    t.seats[1].playerId = 'someone-else';         // the seat is not the one the mark saw
    w.m.settleShowdownAfterFault(T, t, mark);
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    expect(w.m.gameShowdownHeld(t)).toBe(true);
    expect(w.stats()).toMatchObject({ showdownFaults: 1, showdownHeld: 1, showdownPaidFinished: 0, showdownVoided: 0 });
    const chips = t.seats.map((s) => s.chipCount);
    expect(watchdogTicks(t, w.m.gameShowdownHeld, 3)).toBe(0);
    expect(t.seats.map((s) => s.chipCount)).toEqual(chips);
    expect(t.currentPhase).toBe(GamePhase.Showdown);
    const decides = w.c.decide;
    t.activeSeatIndex = 0;
    w.m.executeAIAction(T, 0, { difficulty: 'medium' });
    expect(w.c.decide).toBe(decides);           // returned before deciding
    expect(t.seats.map((s) => s.chipCount)).toEqual(chips);

    // CONTROL (the pre-existing hazard): the same resting Showdown NOT held — the watchdog advances it and pays the pot AGAIN
    const c2 = faultedFoldShowdown();
    expect(watchdogTicks(c2.t, () => false, 3)).toBeGreaterThan(0);
    expect(c2.t.seats.reduce((a, s) => a + s.chipCount, 0)).toBeGreaterThan(20000);
  });

  it('(l) heartbeat: the first table\'s ensureCashTableRunning throws, the second table is still processed (0dc1b96: the tick aborted)', () => {
    const HEARTBEAT = slice("console.log('[LiveRoom] heartbeat installed", '}, 12000);');
    let tick: (() => void) | null = null;
    const ran: string[] = [];
    const scope: any = {
      tableManager: { getTableList: () => [{ tableId: 'A' }, { tableId: 'B' }], getTable: () => ({ getOccupiedSeatCount: () => 2 }) },
      ensureCashTableRunning: (id: string) => { ran.push(id); if (id === 'A') throw new TypeError('injected heartbeat fault'); },
      CASH_TABLE_TARGET_OCCUPIED: 6, log: { debug() {} },
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      console: { log() {}, warn() {}, error() {} },
      Sentry: null,
    };
    const { exports: m } = load(`${GUARD}\n${HEARTBEAT}`, scope, '{ gameTimerGuardStats }');
    tick!();
    expect(ran).toEqual(['A', 'B']);
    expect(m.gameTimerGuardStats.heartbeatThrows).toBe(1);
  });

  it('GUARD — every timer that runs autoStartNextHand catches its throw; the wedge watchdog skips a held Showdown; health reports the counts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src.split('try { autoStartNextHand(').length - 1).toBe(4);
    expect(src).toContain('if (table.currentPhase === GamePhase.Showdown && gameShowdownHeld(table)) {');
    expect(src).toContain('gameTimers: { ...gameTimerGuardStats },');
    expect(src).toContain("try { ensureCashTableRunning(t.tableId); } catch (err) { gameTimerGuardStats.heartbeatThrows++;");
  });
});

describe('(m) PokerTable.completeHandAfterFault — the end of a faulted showdown, never a payment', () => {
  function inShowdown() {
    const t = new PokerTable(cfg());
    for (let i = 0; i < 3; i++) t.sitDown(i, `B${i}`, 10000, `ai-${i}`, true);
    expect(t.startNewHand()).toBe(true);
    return t;
  }
  it('outside Showdown: false, nothing changed', () => {
    const t = inShowdown();
    const snap = JSON.stringify(t.seats.map((s) => [s.chipCount, s.totalInvestedThisHand]));
    const phase = t.currentPhase;
    expect(t.completeHandAfterFault()).toBe(false);
    expect(t.completeHandAfterFault([10000, 10000, 10000])).toBe(false);
    expect(t.currentPhase).toBe(phase);
    expect(JSON.stringify(t.seats.map((s) => [s.chipCount, s.totalInvestedThisHand]))).toBe(snap);
  });
  it('paid case: stacks kept, totals 0, HandComplete, one handResult with results [], the deck seed revealed', () => {
    const t = inShowdown();
    const pot = t.seats.reduce((a, s) => a + s.totalInvestedThisHand, 0);
    t.currentPhase = GamePhase.Showdown;
    t.seats[1].chipCount += pot;                  // the pot was paid, then a throw
    const stacks = t.seats.slice(0, 3).map((s) => s.chipCount);
    const results: any[] = [];
    const seeds: any[] = [];
    t.on('handResult', (r: any) => results.push(r));
    t.on('deckSeedRevealed', (r: any) => seeds.push(r));
    expect(t.completeHandAfterFault()).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.activeSeatIndex).toBe(-1);
    expect(t.seats.slice(0, 3).map((s) => s.chipCount)).toEqual(stacks);
    expect(t.seats.every((s) => s.totalInvestedThisHand === 0 && (s.deadMoneyThisHand || 0) === 0 && s.currentBet === 0)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].results).toEqual([]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].handNumber).toBe(t.handNumber);
    expect(t.lastHandResult).toMatchObject({ handNumber: t.handNumber, winners: [], pots: [] });
    expect(t.seats.reduce((a, s) => a + s.chipCount, 0)).toBe(30000);
  });
  it('refundTo case: stacks set to their stakes, a posted dead blind owed again, Σ conserved', () => {
    const t = new PokerTable(cfg());
    for (let i = 0; i < 4; i++) t.sitDown(i, `B${i}`, 10000, `ai-${i}`, true);
    // seat 3 owes a dead big blind and posts it on this deal
    (t.seats[3] as any).missedBlind = 'big';
    (t.seats[3] as any).deadBlindOwedChips = 100;
    expect(t.startNewHand()).toBe(true);
    const deadPosted = t.seats[3].deadMoneyThisHand || 0;
    const stakes = t.seats.map((s) => (s.state === 'occupied' ? s.chipCount + (s.totalInvestedThisHand || 0) : -1));
    const before = total(t);
    t.currentPhase = GamePhase.Showdown;
    t.seats[0].chipCount += 75;                    // part-paid, then a throw
    expect(t.completeHandAfterFault(stakes)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats.slice(0, 4).map((s) => s.chipCount)).toEqual(stakes.slice(0, 4));
    expect(total(t)).toBe(before);
    expect(deadPosted).toBeGreaterThan(0);
    expect(t.seats[3].deadBlindOwedChips).toBeGreaterThanOrEqual(deadPosted);
    expect(t.seats[3].missedBlind).not.toBe('none');
  });
});

describe('(g) a child process with the REAL processGuards: a throwing decideAction on the bot timer', () => {
  const CHILD_TIMEOUT_MS = 25_000;
  let dir = '';
  const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
    .outputText.replace(/^"use strict";\s*/m, '');
  // The 0dc1b96 timer body, reconstructed from the live one (the guarded try replaced by the bare call).
  const GUARDED_BODY = SCHED.slice(SCHED.indexOf('    // A-crash (bots review 2026-11-04): a throw here used to exit the process'), SCHED.indexOf('  }, delay);\n\n  aiTimeouts.set('));
  const HEAD_SCHED = SCHED.replace(GUARDED_BODY, '    executeAIAction(tableId, activeSeat, profile);\n');
  const CHILD = (code: string) => `
const path = require('path');
const { installProcessCrashHandlers, processCrashStats } = require(path.join(__dirname, 'processGuards.js'));
installProcessCrashHandlers({ flush: async () => { console.log('FLUSHED'); }, flushTimeoutMs: 2000, log: (l) => console.log(l) });
const GamePhase = ${JSON.stringify(GamePhase)};
const PlayerAction = ${JSON.stringify(PlayerAction)};
const seat = (i, ai) => ({ seatIndex: i, isAI: ai, state: 'occupied', playerId: (ai ? 'ai-' : 'p') + i, playerName: 'S' + i, chipCount: 1000, totalInvestedThisHand: 0, folded: false, eliminated: false, holeCards: [1, 2] });
const table = {
  handNumber: 1, stateVersion: 1, actionLog: [], currentPhase: GamePhase.PreFlop, activeSeatIndex: 0,
  seats: [seat(0, true), seat(1, false)],
  isHandInProgress() { return true; },
  playerCheck(i) { this.actionLog.push({ seatIndex: i, action: 'checked', street: this.currentPhase }); this.activeSeatIndex = 1; this.stateVersion++; return true; },
  playerFold(i) { return false; },
};
const scope = {
  tableManager: { getTable: () => table }, GamePhase, PlayerAction, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], MAX_SEATS: 9,
  FiveCardDrawTable: class {}, aiProfiles: new Map([['T', new Map([[0, { difficulty: 'medium' }]])]]), aiTimeouts: new Map(), drawTimers: new Map(),
  pendingAutoStartTimers: new Map(), fastModeTables: new Map(), tableWantsFastBots: () => true, getThinkingDelay: () => 10,
  decideAction: () => { throw new TypeError('injected decideAction fault'); }, allInOrFoldTables: new Set(), allInOrFoldDecision: (t, s, d) => d,
  broadcastGameState() {}, clearHandSnapshot: async () => {}, autoStartNextHand() {}, Sentry: null, console,
};
const env = new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t, get: (t, k) => t[k] });
const mod = { exports: {} };
new Function('__env', 'module', 'exports', 'require', 'with (__env) {\\n' + ${JSON.stringify(transpile(code))} + '\\n}')(env, mod, mod.exports, require);
mod.exports.scheduleAIAction('T');
setTimeout(() => {
  console.log('RESULT ' + JSON.stringify({ uncaught: processCrashStats.uncaughtExceptions, guard: mod.exports.gameTimerGuardStats || null, log: table.actionLog.map((e) => e.action) }));
  process.exit(0);
}, 600);
`;
  function runChild(code: string): Promise<{ code: number | null; out: string }> {
    const file = path.join(dir, `child-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, CHILD(code));
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout!.on('data', (d) => { out += String(d); });
      p.stderr!.on('data', (d) => { out += String(d); });
      p.on('exit', (c) => resolve({ code: c, out }));
    });
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-crash-guard-'));
    fs.writeFileSync(path.join(dir, 'processGuards.js'), transpile(fs.readFileSync(path.join(__dirname, '..', 'src', 'processGuards.ts'), 'utf8')));
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('the guarded timer: the process keeps running (exit 0, uncaughtExceptions 0) and the bot was checked for', async () => {
    const r = await runChild(`${GUARD}\n${SCHED}\n${EXEC}\nmodule.exports = { scheduleAIAction, gameTimerGuardStats };`);
    expect(r.code).toBe(0);
    const res = JSON.parse(/RESULT (.*)/.exec(r.out)![1]);
    expect(res.uncaught).toBe(0);
    expect(res.guard).toMatchObject({ actionThrows: 1, actedFor: 1 });
    expect(res.log).toEqual(['checked']);
    expect(r.out).toContain('[game-timer-error] {"kind":"action"');
    expect(r.out).not.toContain('flush_then_exit');
  }, CHILD_TIMEOUT_MS);

  it("CONTROL — the 0dc1b96 timer body: the same throw exits 1 after 'flush_then_exit'", async () => {
    expect(HEAD_SCHED).not.toBe(SCHED);
    expect(HEAD_SCHED).not.toContain('recoverBotActionThrow');
    const r = await runChild(`${HEAD_SCHED}\n${EXEC}\nmodule.exports = { scheduleAIAction };`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('"action":"flush_then_exit"');
    expect(r.out).toContain('FLUSHED');
    expect(r.out).not.toContain('RESULT ');
  }, CHILD_TIMEOUT_MS);
});

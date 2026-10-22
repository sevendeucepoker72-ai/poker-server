/**
 * Gameplay audit 2026-10-21 — cluster S9 (quick modes, clubs challenge sit-out,
 * auto-deal, sit-out turns, deck commitment), on the REAL engine (PokerTable,
 * decideAction) and the real index.ts source (sliced).
 *
 *   F49  All-In or Fold: the bots are held to the format (shove / fold / a free
 *        check only — they limped, opened to 3 BB and bet post-flop while the
 *        human was refused every call); the human may check when nothing is owed.
 *   F50  a client 'startHand' at a hand END deals through the hand-boundary step
 *        (bot stack cap, bomb pot, seat moves); a join deals inline only from
 *        WaitingForPlayers.
 *   F56  a cash seat whose player SITS OUT mid-hand is acted for 500ms into each
 *        later turn of that hand (the sit-out auto-act was dead code: 30s waits).
 *   F102 a club challenge deals a sitting-out seat in (blinded out, acted for):
 *        a Sit Out no longer freezes the freezeout for good.
 *   F162 'deckCommitment' names its table; the seed reveal is NOT broadcast
 *        (owner decision pending — see index.ts).
 *   (F103 / F104 live in r2Clubs.test.ts, F105 / F108 / F109 in
 *   r2TablesAndQuickGames.test.ts — their harnesses are there.)
 *
 * Every test fails on the pre-fix code (a CONTROL runs the pre-fix source, or
 * the pre-fix outcome is quoted inline).
 */
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { decideAction, generateRandomProfile, Difficulty } from '../src/ai/AIPlayer';
import { quickGameOutcome } from '../src/game/quickGames';
import { SRC, slice, fnSrc, handlerSrc, load, SEAT_SESSION_FOR_SRC } from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const cfg = (id: string, over: Record<string, unknown> = {}) =>
  ({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 1000, ...over } as any);

/** Seeded Math.random for the bots' choices (the deck stays crypto-random). */
function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}

/** Replace `from` (which must be present) in a source slice — the CONTROLs' pre-fix text. */
function without(src: string, from: string, to = ''): string {
  expect(src).toContain(from);
  return src.split(from).join(to);
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// ═══════════════════════════════════════════════════════════════════ F49 ══
describe('F49 — All-In or Fold holds the BOTS to the format too', () => {
  const EXEC = fnSrc('function executeAIAction(');
  const AOF = fnSrc('function allInOrFoldAllows(') + fnSrc('function allInOrFoldDecision(');
  const PRE_F49 = without(EXEC,
    `  const decision = allInOrFoldTables.has(tableId)
    ? allInOrFoldDecision(table, seatIndex, decideAction(table, seatIndex, profile, { allInOrFold: true }))
    : decideAction(table, seatIndex, profile);`,
    '  const decision = decideAction(table, seatIndex, profile);');

  /** Every successful TOP-LEVEL action (a call made inside playerAllIn is not one), with what the seat owed. */
  function spyActions(t: PokerTable) {
    const log: Array<{ seat: number; kind: string; owed: number }> = [];
    let depth = 0;
    for (const k of ['playerFold', 'playerCheck', 'playerCall', 'playerRaise', 'playerAllIn'] as const) {
      const orig = (t as any)[k].bind(t);
      (t as any)[k] = (seat: number, ...rest: any[]) => {
        const owed = t.getCallAmount(t.seats[seat]);
        depth++;
        try {
          const ok = orig(seat, ...rest);
          if (ok && depth === 1) log.push({ seat, kind: k, owed });
          return ok;
        } finally { depth--; }
      };
    }
    return log;
  }

  /** 6 bots at the quickAllInOrFold numbers (10/20, 1000 = 50 BB) through the REAL executeAIAction. */
  function play(exec: string, aof: boolean, hands: number) {
    const table = new PokerTable(cfg('aof'));
    const diffs: Difficulty[] = ['easy', 'medium', 'medium', 'hard', 'easy', 'hard'];
    const restore = seedRandom(4242);
    try {
      const profiles = new Map<number, any>();
      for (let i = 0; i < 6; i++) {
        profiles.set(i, generateRandomProfile(diffs[i]));
        expect(table.sitDown(i, `Bot${i}`, 1000, `ai-${i}`, true)).toBe(true);
      }
      const log = spyActions(table);
      const { exports: run, stubbed } = load(exec + AOF, {
        tableManager: { getTable: () => table }, decideAction, PlayerAction, GamePhase,
        broadcastGameState() {}, scheduleAIAction() {}, clearHandSnapshot: async () => {}, autoStartNextHand() {},
        pendingAutoStartTimers: new Map(), console: quiet, allInOrFoldTables: new Set(aof ? ['aof'] : []),
      }, 'executeAIAction');
      let stuck = 0;
      for (let h = 0; h < hands; h++) {
        // A busted bot is topped up so play goes on (this test is about the ACTIONS, not the game's end).
        for (const s of table.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = 1000; s.eliminated = false; }
        if (!table.startNewHand()) { stuck++; break; }
        let guard = 0;
        while (table.isHandInProgress() && guard++ < 500) {
          const a = table.activeSeatIndex;
          if (a < 0) break;
          run('aof', a, profiles.get(a));
        }
        if (table.isHandInProgress()) stuck++;
      }
      return { log, stuck, stubbed };
    } finally { restore(); }
  }

  it('every bot action at an All-In or Fold table is a fold, an all-in or a FREE check — never a call, a bet or a raise', () => {
    const r = play(EXEC, true, 40);
    expect(r.stuck).toBe(0);
    expect([...r.stubbed]).toEqual([]);
    const illegal = r.log.filter((e) => !(e.kind === 'playerFold' || e.kind === 'playerAllIn' || (e.kind === 'playerCheck' && e.owed === 0)));
    expect(illegal).toEqual([]);
    // Real shove-or-fold play (push / fold ranges), not "shove everything" or "fold everything".
    expect(r.log.filter((e) => e.kind === 'playerAllIn').length).toBeGreaterThan(0);
    expect(r.log.filter((e) => e.kind === 'playerFold').length).toBeGreaterThan(r.log.filter((e) => e.kind === 'playerAllIn').length);
  });

  it('CONTROL — pre-F49 executeAIAction (no format rule for bots): the same table limps, calls and raises', () => {
    const r = play(PRE_F49, true, 40);
    const illegal = r.log.filter((e) => e.kind === 'playerCall' || e.kind === 'playerRaise' || (e.kind === 'playerCheck' && e.owed > 0));
    expect(illegal.length).toBeGreaterThan(0);
  });

  it('decideAction allInOrFold mode: pre-flop at 50 BB every archetype answers fold / all-in / a free check', () => {
    const restore = seedRandom(77);
    try {
      const seen = new Set<string>();
      for (let n = 0; n < 60; n++) {
        const t = new PokerTable(cfg(`d${n}`));
        for (let i = 0; i < 6; i++) t.sitDown(i, `B${i}`, 1000, `ai-${i}`, true);
        expect(t.startNewHand()).toBe(true);
        for (let k = 0; k < 3 && t.isHandInProgress(); k++) {
          const a = t.activeSeatIndex;
          const d = decideAction(t, a, generateRandomProfile((['easy', 'medium', 'hard', 'expert'] as Difficulty[])[n % 4]), { allInOrFold: true });
          seen.add(d.action);
          const owed = t.getCallAmount(t.seats[a]);
          expect([PlayerAction.Fold, PlayerAction.AllIn, ...(owed === 0 ? [PlayerAction.Check] : [])]).toContain(d.action);
          if (d.action === PlayerAction.AllIn) t.playerAllIn(a); else t.playerFold(a);
        }
      }
      expect(seen.has(PlayerAction.AllIn)).toBe(true);
      expect(seen.has(PlayerAction.Fold)).toBe(true);
    } finally { restore(); }
  });

  it('the human gate and the bots share ONE rule: fold / all-in always, a check only when nothing is owed, never call / raise', () => {
    const { exports: m } = load(fnSrc('function allInOrFoldAllows('), {}, '{ allInOrFoldAllows }');
    const t = new PokerTable(cfg('h'));
    t.sitDown(0, 'Hero', 1000, 'user_1', false);
    t.sitDown(1, 'Bot', 1000, 'ai-1', true);
    expect(t.startNewHand()).toBe(true);
    const sb = t.activeSeatIndex;                         // heads-up: the small blind acts first, owing half a blind
    for (const [type, ok] of [['fold', true], ['allIn', true], ['check', false], ['call', false], ['raise', false]] as const) {
      expect(m.allInOrFoldAllows(t, sb, type)).toBe(ok);
    }
    expect(t.playerCall(sb)).toBe(true);                  // (engine-level) completes: the big blind owes nothing now
    const bb = t.activeSeatIndex;
    expect(m.allInOrFoldAllows(t, bb, 'check')).toBe(true);   // it used to be refused: fold the posted blind or shove 50 BB
    expect(m.allInOrFoldAllows(t, bb, 'raise')).toBe(false);
    expect(SRC).toContain('if (allInOrFoldTables.has(session.tableId) && !allInOrFoldAllows(table, session.seatIndex, data.type)) {');
  });
});

// ═══════════════════════════════════════════════════════════════════ F50 ══
describe('F50 — a client deal at a hand END runs the hand-boundary step; a join deals only from WaitingForPlayers', () => {
  const START_HAND = handlerSrc('startHand', '\n  });\n');
  const F50_ROUTE = slice('    // 2026-10-21 (gameplay F50) — at a hand END every table', '      return;\n    }\n', SRC.indexOf("socket.on('startHand'"));
  const PRE_F50 = without(without(START_HAND, F50_ROUTE),
    '      // F50 — a bomb pot triggered while the table waited fires on this deal (E6).\n      activateBombPotIfPending(session.tableId, table);\n');
  const AUTOSTART = fnSrc('function autoStartNextHand(');
  const BOT_STACKS = slice('const BOT_STACK_CAP_BUYINS = 3;', '  return isFixedRosterTable(tableId);\n}\n');

  function world(startHand = START_HAND) {
    const table = new PokerTable(cfg('t1'));
    expect(table.sitDown(0, 'Hero', 5000, 'user_1', false)).toBe(true);
    expect(table.sitDown(1, 'BotA', 1000, 'ai-a', true)).toBe(true);
    expect(table.sitDown(2, 'BotB', 1000, 'ai-b', true)).toBe(true);
    const bombs: string[] = [];
    const pendingAutoStartTimers = new Map<string, any>();
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
      playerSessions: new Map([['S1', { socketId: 'S1', tableId: 't1', seatIndex: 0, sittingOut: false }]]),
      multiTableSessions: new Map(), brokenTournamentTables: new Map(), tournamentTables: new Map(),
      tournamentHandStartSafety: { clientHandStartsRouted: 0 }, tournamentDealHoldReason: () => null,
      pendingAutoStartTimers, GamePhase, MAX_SEATS: 9, CASH_TABLE_TARGET_OCCUPIED: 5,
      ensureTableProgressListener() {}, executePendingMove: () => false, trimExcessAI() {}, fillWithAI() {},
      dealersChoiceState: new Map(), quickTables: new Set(), isFixedRosterTable: () => false,
      activateBombPotIfPending: (id: string) => { bombs.push(id); return false; },
      broadcastGameState() {}, scheduleAIAction() {}, io: { sockets: { sockets: new Map() } },
      tournamentManager: { getTournament: () => undefined }, clearHandSnapshot: async () => {},
      log: { debug() {}, info() {} }, console: quiet,
    };
    const code = `${BOT_STACKS}\n${AUTOSTART}\n${fnSrc('function scheduleAutoStart(')}\n${fnSrc('function dealAfterJoin(')}\n`
      + `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${startHand}\n}`;
    const { exports: m, stubbed } = load(code, scope, '{ wire, dealAfterJoin, botStackStats }');
    const handlers: Record<string, (...a: any[]) => any> = {};
    const emitted: Array<[string, any]> = [];
    m.wire({ id: 'S1', on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, p: any) => emitted.push([ev, p]) });
    return { table, m, stubbed, bombs, pendingAutoStartTimers, handlers, emitted };
  }
  /** Hand 1 to its end by folds, then a bot sits at 30x the buy-in (what it won from humans). */
  function toHandEnd(w: ReturnType<typeof world>) {
    expect(w.table.startNewHand()).toBe(true);
    while (w.table.isHandInProgress()) expect(w.table.playerFold(w.table.activeSeatIndex)).toBe(true);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    w.table.seats[1].chipCount = 30_000;
  }
  const stackOf = (t: PokerTable, i: number) => t.seats[i].chipCount + (t.seats[i].totalInvestedThisHand || 0);

  it("Auto Deal's startHand at HandComplete: the bot above 3 buy-ins is reset to one, a pending bomb pot is honoured, the hand is dealt", async () => {
    const w = world();
    toHandEnd(w);
    w.pendingAutoStartTimers.set('t1', setTimeout(() => {}, 3000));      // the action handler's 3s boundary timer
    await w.handlers.startHand({});
    expect(w.table.isHandInProgress()).toBe(true);
    expect(stackOf(w.table, 1)).toBe(1000);                               // GAME-18 cap
    expect(w.m.botStackStats.caps).toBe(1);
    expect(w.bombs).toEqual(['t1']);
    expect(w.pendingAutoStartTimers.has('t1')).toBe(false);               // its timer would only no-op now
    expect(w.emitted).toEqual([]);
    expect([...w.stubbed].filter((n) => /autoStart|reloadAndCap|activateBomb|seatSession|Timers/.test(n))).toEqual([]);
  });

  it('CONTROL — pre-F50 startHand: the bare startNewHand deals with the bot still at 30,000 and no bomb pot', async () => {
    const w = world(PRE_F50);
    toHandEnd(w);
    await w.handlers.startHand({});
    expect(w.table.isHandInProgress()).toBe(true);
    expect(stackOf(w.table, 1)).toBe(30_000);
    expect(w.m.botStackStats.caps).toBe(0);
    expect(w.bombs).toEqual([]);
  });

  it('a startHand from WaitingForPlayers deals at once and honours a pending bomb pot', async () => {
    const w = world();
    await w.handlers.startHand({});
    expect(w.table.isHandInProgress()).toBe(true);
    expect(w.bombs).toEqual(['t1']);
  });

  it('a JOIN during HandComplete deals nothing inline — the boundary timer deals (with the cap); from WaitingForPlayers it deals', () => {
    const w = world();
    toHandEnd(w);
    expect(w.m.dealAfterJoin('t1', w.table)).toBe(false);
    expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.pendingAutoStartTimers.has('t1')).toBe(true);               // no timer was pending: one is scheduled
    jest.advanceTimersByTime(1500);
    expect(w.table.isHandInProgress()).toBe(true);
    expect(stackOf(w.table, 1)).toBe(1000);
    const fresh = world();
    expect(fresh.m.dealAfterJoin('t1', fresh.table)).toBe(true);
    expect(fresh.table.isHandInProgress()).toBe(true);
    expect(fresh.bombs).toEqual(['t1']);
  });

  it('every join path deals through dealAfterJoin (joinTable, quickPlay, the waitlist seat, an invite code) — no bare deal at a hand end', () => {
    expect(SRC.split('dealAfterJoin(').length - 1).toBeGreaterThanOrEqual(5);   // the helper + four join paths
    expect(SRC).not.toContain('if (!table.isHandInProgress() && table.getOccupiedSeatCount() >= 2) {\n        table.startNewHand();');
    expect(SRC).not.toContain('if (!table.isHandInProgress() && table.getOccupiedSeatCount() >= 2) {\n          table.startNewHand();');
    expect(SRC).not.toContain('table.getOccupiedSeatCount() >= 2 && table.startNewHand()');
    expect(handlerSrc('quickPlay', '\n    })(); }\n  );')).toContain('const started = dealAfterJoin(chosenTableId, table);');
  });
});

// ═══════════════════════════════════════════════════════════════════ F56 ══
describe('F56 — a cash seat SITTING OUT mid-hand is acted for 500ms into each later turn (not after the 30s clock)', () => {
  const BC = fnSrc('function broadcastGameState(');
  const PRE_F56 = without(BC,
    'const sparedBySession = nowHasLiveSession && (isTournamentTable(tableId) || seatHasAnyPlayingSession(tableId, activeIdx));\n          if (sparedBySession || seatReserved) return;',
    'if (nowHasLiveSession || seatReserved) return;');

  function world(bc: string, hero: 'main' | 'extra', opts: { tournament?: boolean; sittingOut?: boolean } = {}) {
    const table = new PokerTable(cfg('A'));
    for (let i = 0; i < 3; i++) expect(table.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
    expect(table.startNewHand()).toBe(true);
    const seat = table.activeSeatIndex;                                   // first to act, facing the big blind
    const playerSessions = new Map<string, any>();
    const multiTableSessions = new Map<string, any[]>();
    for (let i = 0; i < 3; i++) if (i !== seat) playerSessions.set(`S${i}`, { socketId: `S${i}`, tableId: 'A', seatIndex: i, sittingOut: false });
    const heroSession = { socketId: 'SH', tableId: 'A', seatIndex: seat, sittingOut: opts.sittingOut !== false };
    if (hero === 'main') playerSessions.set('SH', heroSession);
    else {
      playerSessions.set('SH', { socketId: 'SH', tableId: 'B', seatIndex: 4, sittingOut: false });   // his MAIN seat elsewhere
      multiTableSessions.set('SH', [heroSession]);
    }
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 'A' ? table : undefined) },
      playerSessions, multiTableSessions, reservedSeats: new Map(), spectators: new Map(),
      io: { to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
      getGameStateForPlayer: () => ({}), emitGameState() {}, DrawPhases: DRAWS, isHandStoreReady: () => false,
      armTurnTimer() {}, ensureTurnTimerWired() {}, ensureInsuranceHoldWired() {}, scheduleAIAction() {},
      absentTournamentSeatMayLimp: () => false, tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, console: quiet,
      isTournamentTable: () => opts.tournament === true, watchesFromDeadTournamentSeat: () => false,
    };
    const code = bc + fnSrc('function seatHasLiveSession(') + fnSrc('function seatHasAnySession(')
      + fnSrc('function seatHasPlayingSession(') + fnSrc('function seatHasAnyPlayingSession(') + fnSrc('function autoActForSeat(');
    const { exports: m, stubbed } = load(code, scope, '{ broadcastGameState }');
    return { table, seat, m, stubbed, heroSession };
  }

  it('his MAIN session sits out (Sit Out / AFK off his turn) and the action reaches him: folded (facing a bet) ~500ms in', () => {
    const w = world(BC, 'main');
    w.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(w.table.seats[w.seat].folded).toBe(true);
    expect(w.table.activeSeatIndex).not.toBe(w.seat);
    expect([...w.stubbed].filter((n) => /seatHas|autoAct|Sessions|isTournament/.test(n))).toEqual([]);
  });

  it('CONTROL — pre-F56 bail ("any live session"): his own sitting-out session spared him; the turn waited for the 30s clock', () => {
    const w = world(PRE_F56, 'main');
    w.m.broadcastGameState('A');
    jest.advanceTimersByTime(29_000);
    expect(w.table.seats[w.seat].folded).toBe(false);
    expect(w.table.activeSeatIndex).toBe(w.seat);
  });

  it('an extra-table (multi-table) session that sits out is acted for the same way', () => {
    const w = world(BC, 'extra');
    w.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(w.table.seats[w.seat].folded).toBe(true);
  });

  it('sitting back in within the 500ms spares him; a TOURNAMENT seat keeps the absent short clock (never acted for at 500ms)', () => {
    const back = world(BC, 'main');
    back.m.broadcastGameState('A');
    back.heroSession.sittingOut = false;
    jest.advanceTimersByTime(600);
    expect(back.table.seats[back.seat].folded).toBe(false);
    const tour = world(BC, 'main', { tournament: true });
    tour.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(tour.table.seats[tour.seat].folded).toBe(false);
    expect(tour.table.activeSeatIndex).toBe(tour.seat);
  });
});

// ══════════════════════════════════════════════════════════════════ F102 ══
describe('F102 — a club challenge deals a sitting-out seat in: the freezeout ends with the right winner', () => {
  const SYNC = fnSrc('function syncSitOutToTable(');

  function world(opts: { challenge: boolean }) {
    const table = new PokerTable(cfg('c1', { smallBlind: 20, bigBlind: 40, minBuyIn: 2000 }));
    expect(table.sitDown(0, 'Alice', 400, 'user_1', false, true)).toBe(true);
    expect(table.sitDown(1, 'Bob', 3600, 'user_2', false, true)).toBe(true);
    const sitOutTracker = new Map<string, Set<number>>();
    const challengeTables = new Map<string, any>(opts.challenge ? [['c1', { challengeId: 4, challengerId: 1, challengedId: 2 }]] : []);
    const { exports: m, stubbed } = load(SYNC + fnSrc('function autoActForSeat('), {
      tableManager: { getTable: () => table }, sitOutTracker, challengeTables, isTournamentTable: () => false,
      absentTournamentSeatMayLimp: () => false, tournamentHandStartSafety: { allAbsentAutoCalls: 0 },
    }, '{ syncSitOutToTable, autoActForSeat }');
    const sitOut = (seat: number) => {
      if (!sitOutTracker.has('c1')) sitOutTracker.set('c1', new Set());
      sitOutTracker.get('c1')!.add(seat);
      m.syncSitOutToTable('c1');
    };
    return { table, m, stubbed, sitOut };
  }

  it('Alice (behind) taps Sit Out between hands: the next hand is STILL dealt — she is in it and posts her blind', () => {
    const w = world({ challenge: true });
    w.sitOut(0);
    expect(w.table.startNewHand()).toBe(true);                              // pre-F102: false, for good (no clock, no stand-up)
    expect(w.table.seats[0].holeCards).toHaveLength(2);
    expect(w.table.seats[0].totalInvestedThisHand).toBeGreaterThan(0);
    expect([...w.stubbed].filter((n) => /challenge|sitOut|isTournament/i.test(n))).toEqual([]);
  });

  it('CONTROL — the same at a plain cash table (unchanged): a heads-up with one seat sitting out deals nothing', () => {
    const w = world({ challenge: false });
    w.sitOut(0);
    expect(w.table.startNewHand()).toBe(false);
  });

  it('BOTH sitting out: nothing is dealt (no endless blind swap) until one of them comes back', () => {
    const w = world({ challenge: true });
    w.sitOut(0);
    w.sitOut(1);
    expect(w.table.startNewHand()).toBe(false);
  });

  // F102 fix-up (review) — the Sit Out tapped while still ALONE at the challenge
  // (inside CHALLENGE_JOIN_GRACE_MS, before the opponent sits). No join path
  // re-ran the sync, so the engine kept her seat sitting out and the opponent's
  // join dealt nothing: the table rested at WaitingForPlayers for good.
  const PRE_FIXUP_SYNC = without(SYNC,
    `  const challengeSeated = table.seats.filter((s) => s.state === 'occupied' && !s.eliminated);
  const challengeDealsIn = challengeTables.has(tableId)
    && !(challengeSeated.length >= 2 && challengeSeated.every((s) => set.has(s.seatIndex)));`,
    `  const challengeDealsIn = challengeTables.has(tableId)
    && table.seats.some((s) => s.state === 'occupied' && !s.eliminated && !set.has(s.seatIndex));`);

  function aloneThenJoin(src: string) {
    const table = new PokerTable(cfg('c1', { smallBlind: 20, bigBlind: 40, minBuyIn: 2000 }));
    expect(table.sitDown(0, 'Alice', 2000, 'user_1', false, true)).toBe(true);
    const sitOutTracker = new Map<string, Set<number>>([['c1', new Set([0])]]);   // Alice taps Sit Out, alone
    const { exports: syncSitOutToTable } = load(src, {
      tableManager: { getTable: () => table }, sitOutTracker,
      challengeTables: new Map([['c1', { challengeId: 4, challengerId: 1, challengedId: 2 }]]), isTournamentTable: () => false,
    }, 'syncSitOutToTable');
    syncSitOutToTable('c1');
    expect(table.sitDown(1, 'Bob', 2000, 'user_2', false, true)).toBe(true);    // Bob sits (no re-sync on this path)
    return table;
  }

  it('fix-up — Alice taps Sit Out while still ALONE, then Bob sits: the first hand is dealt and Alice is in it', () => {
    const table = aloneThenJoin(SYNC);
    expect(table.startNewHand()).toBe(true);
    expect(table.seats[0].holeCards).toHaveLength(2);
    expect(table.seats[1].holeCards).toHaveLength(2);
  });

  it('CONTROL — pre-fix-up rule ("someone else there still plays"): with Alice alone her seat stayed out, Bob\'s join dealt nothing', () => {
    const table = aloneThenJoin(PRE_FIXUP_SYNC);
    expect(table.startNewHand()).toBe(false);
    expect(table.currentPhase).toBe(GamePhase.WaitingForPlayers);
  });

  it('played out: Alice sitting out is acted for (check / fold) and blinded out — the challenge is decided for BOB (it went to Alice when Bob had to leave)', () => {
    const w = world({ challenge: true });
    w.sitOut(0);
    let hands = 0;
    while (hands < 400 && quickGameOutcome('challenge', w.table.seats as any).over === false) {
      expect(w.table.startNewHand()).toBe(true);
      hands++;
      let guard = 0;
      while (w.table.isHandInProgress() && guard++ < 50) {
        const a = w.table.activeSeatIndex;
        if (a === 0) w.m.autoActForSeat('c1', w.table, 0);                 // the server acts for the absent seat
        else if (!w.table.playerAllIn(1)) w.table.playerCheck(1);           // Bob plays: shoves
      }
      expect(w.table.isHandInProgress()).toBe(false);
    }
    const out = quickGameOutcome('challenge', w.table.seats as any);
    expect(out).toMatchObject({ over: true, winnerSeat: 1 });
    expect(w.table.seats[0].chipCount + w.table.seats[1].chipCount).toBe(4000);   // conserved
  });
});

// ══════════════════════════════════════════════════════════════════ F162 ══
describe('F162 — deck commitment names its table; the seed reveal waits on the owner', () => {
  const LISTENERS = slice("  table.on('deckSeedRevealed',", "committedAt: Date.now(), tableId });\n  });\n");

  it("'deckCommitment' reaches the room WITH tableId; the revealed seed is recorded for /api/fairness and not broadcast", () => {
    const room: Array<[string, string, any]> = [];
    const recorded: any[] = [];
    const { exports: wireFairness } = load(`function wireFairness(table, tableId) {\n${LISTENERS}\n}`, {
      io: { to: (r: string) => ({ emit: (ev: string, p: any) => room.push([r, ev, p]) }) },
      recordRevealedCommitment: (tid: string, c: any) => recorded.push([tid, c]),
    }, 'wireFairness');
    const t = new PokerTable(cfg('f1'));
    t.sitDown(0, 'A', 1000, 'pa', false);
    t.sitDown(1, 'B', 1000, 'pb', false);
    wireFairness(t, 'f1');
    expect(t.startNewHand()).toBe(true);
    const commit = room.find(([, ev]) => ev === 'deckCommitment')!;
    expect(commit[0]).toBe('table:f1');
    expect(commit[2]).toMatchObject({ handNumber: t.handNumber, tableId: 'f1', hash: expect.any(String) });   // pre-F162: no tableId
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(recorded).toHaveLength(1);
    expect(recorded[0][1]).toMatchObject({ handNumber: commit[2].handNumber, hash: commit[2].hash, seed: expect.any(String) });
    // OWNER DECISION PENDING (index.ts F162 note): the seed rebuilds every folded hand — not pushed to the room.
    expect(room.filter(([, ev]) => ev === 'deckSeedRevealed')).toEqual([]);
  });
});

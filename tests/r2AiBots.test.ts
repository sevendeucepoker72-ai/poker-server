/**
 * .online R2 (2026-10-11) — S2 bots, on the REAL engine + REAL decideAction +
 * the REAL executeAIAction fallback chain (sliced from src/index.ts):
 *   GAME-8  plain Seven Card Stud ('seven-stud') bots take the Stud path — the
 *           Hold'em Monte Carlo is never given more than 2 hole cards — and a
 *           decision's equity work is time-budgeted (BOT_EQUITY_BUDGET_MS);
 *   GAME-9  no endless raise wars: per-street raises from the table's own
 *           count, re-raises sized off the bet faced, the fixed-limit cap, and
 *           a cap on bot re-raising (limitBotRaiseWar).
 * Before R2 (measured with the same loop, scratchpad r2s2/botwar.cjs, 300
 * hands of 5 hard bots): Hold'em max 87 raises in one betting round and a
 * 146-action hand; Omaha Hi-Lo 536 raises / an 806-action hand; 2-7 Triple
 * Draw 657 raises / an 838-action hand; Stud ~1s of CPU per bot decision.
 */
import { PokerTable, GamePhase, PlayerAction, MAX_SEATS, FIXED_LIMIT_MAX_BET_LEVELS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { BadugiTable } from '../src/game/variants/BadugiTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import * as TE from '../src/training/TrainingEngine';
import {
  decideAction, generateRandomProfile, limitBotRaiseWar, holdemHoleCards, BOT_EQUITY_BUDGET_MS,
  BOT_MAX_STREET_RAISES_PREFLOP, BOT_MAX_STREET_RAISES_POSTFLOP, STUD_VARIANT_IDS,
} from '../src/ai/AIPlayer';
import { fnSrc, load } from './helpers/indexSource';

const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: 'sim', tableName: 'Sim', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000, ...over } as any);
const card = (rank: number, suit: number) => ({ rank, suit });

/** Seeded Math.random for the bots' choices (the deck stays crypto-random). */
function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}

/** index.ts's executeAIAction (the bot's fallback chain), sliced and run against the given table. */
function executorFor(table: PokerTable) {
  const { exports } = load(fnSrc('function executeAIAction('), {
    tableManager: { getTable: () => table }, decideAction, PlayerAction, GamePhase,
    broadcastGameState() {}, scheduleAIAction() {}, clearHandSnapshot: async () => {}, autoStartNextHand() {},
    pendingAutoStartTimers: new Map(), console: { log() {}, warn() {}, error() {} },
  }, 'executeAIAction');
  return exports as (tableId: string, seat: number, profile: any) => void;
}

/** Play `hands` bot-only hands; returns per-hand action counts, per-street raise maxima and fixed-limit levels. */
function playBotHands(table: PokerTable, bots: number, hands: number, difficulty: 'medium' | 'hard' = 'hard') {
  const profiles = new Map<number, any>();
  for (let i = 0; i < bots; i++) {
    const p = generateRandomProfile(difficulty);
    profiles.set(i, p);
    expect(table.sitDown(i, `${p.botName}${i}`, table.config.minBuyIn, `ai-${i}`, true)).toBe(true);
  }
  const exec = executorFor(table);
  const out = { actions: [] as number[], streetRaises: [] as number[], maxLevels: 0, stuck: 0 };
  for (let h = 0; h < hands; h++) {
    for (const s of table.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = table.config.minBuyIn; s.eliminated = false; }
    if (!table.startNewHand()) { out.stuck++; break; }
    let actions = 0, guard = 0;
    const raisesBy = new Map<string, number>();
    while (table.isHandInProgress() && guard++ < 2000) {
      if ([GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3].includes(table.currentPhase)) {
        const d = table as FiveCardDrawTable;
        for (const s of d.seats) if (s.isAI && s.state === 'occupied' && !s.folded && !s.allIn && s.holeCards.length > 0 && !d.drawsCompleted.has(s.seatIndex)) d.playerDraw(s.seatIndex, []);
        continue;
      }
      const a = table.activeSeatIndex;
      if (a < 0) { out.stuck++; break; }
      const before = table.raisesThisStreet;
      exec('sim', a, profiles.get(a));
      actions++;
      out.maxLevels = Math.max(out.maxLevels, table.betLevelsThisStreet);
      if (table.raisesThisStreet > before) raisesBy.set(String(table.currentPhase), table.raisesThisStreet);
    }
    if (guard >= 2000) out.stuck++;
    out.actions.push(actions);
    out.streetRaises.push(Math.max(0, ...raisesBy.values()));
  }
  return out;
}

describe('GAME-8 — every Stud variant takes the Stud path; the Hold\'em equity never sees more than 2 hole cards', () => {
  afterEach(() => jest.restoreAllMocks());

  it('plain Seven Card Stud\'s id is recognised (it was missing)', () => {
    expect(new SevenStudTable(cfg(), false, false).variantId).toBe('seven-stud');
    for (const [razz, hilo] of [[false, false], [true, false], [false, true]] as const) {
      expect(STUD_VARIANT_IDS.has(new SevenStudTable(cfg(), razz, hilo).variantId)).toBe(true);
    }
  });

  it.each([
    ['Seven Card Stud', () => new SevenStudTable(cfg({ ante: 10 }), false, false)],
    ['Razz', () => new SevenStudTable(cfg({ ante: 10 }), true, false)],
    ['Stud Hi-Lo', () => new SevenStudTable(cfg({ ante: 10 }), false, true)],
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true)],
    ['Badugi', () => new BadugiTable(cfg())],
  ])('%s: 40 bot hands never call calculateEquity (no community cards to price)', (_n, mk) => {
    const spy = jest.spyOn(TE, 'calculateEquity');
    const restore = seedRandom(11);
    try {
      const r = playBotHands((mk as () => PokerTable)(), 4, 40);
      expect(r.stuck).toBe(0);
    } finally { restore(); }
    expect(spy).not.toHaveBeenCalled();
  });

  it('Crazy Pineapple / every Hold\'em-style table: calculateEquity is only ever given 2 hole cards (the 2 a Pineapple seat keeps)', () => {
    const spy = jest.spyOn(TE, 'calculateEquity');
    const { PineappleTable } = require('../src/game/variants/PineappleTable');
    const restore = seedRandom(12);
    try {
      playBotHands(new PineappleTable(cfg(), true), 3, 6);
      playBotHands(new PokerTable(cfg()), 3, 3);
    } finally { restore(); }
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      const [hole, , , omaha] = call as any[];
      if (!omaha) expect(hole).toHaveLength(2);
    }
  });

  it('holdemHoleCards keeps all but the weakest card (the engine\'s own auto-discard)', () => {
    expect(holdemHoleCards([card(14, 0), card(2, 1), card(13, 2)] as any)).toEqual([card(14, 0), card(13, 2)]);
    expect(holdemHoleCards([card(9, 3), card(9, 0), card(4, 2)] as any)).toEqual([card(9, 3), card(9, 0)]);
  });

  it('calculateEquity itself never runs a 7-card Hold\'em hand (CPU) and honours its time budget', () => {
    const seven = [card(14, 0), card(13, 0), card(12, 1), card(5, 2), card(4, 3), card(3, 1), card(2, 2)] as any;
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const eq = TE.calculateEquity(seven, [], 2, false);
      expect(eq).toBeGreaterThanOrEqual(0);
      expect(eq).toBeLessThanOrEqual(100);
    }
    expect(Date.now() - t0).toBeLessThan(1500);              // 5 x 500 sims of a 2-card hand (was ~1s EACH)
    const hole = [card(14, 0), card(13, 0), card(12, 1), card(11, 2), card(10, 3), card(9, 1)] as any;
    const t1 = Date.now();
    TE.calculateEquity(hole, [card(2, 0), card(7, 1), card(9, 2)] as any, 7, true, 0, false, 5);
    expect(Date.now() - t1).toBeLessThan(250);                // stops soon after its 5ms budget (>= 64 sims)
  });

  it('bot think time is bounded: a Stud decision is a cheap heuristic (no Monte Carlo — was ~1s of CPU); generous bound for a loaded CI box', () => {
    const restore = seedRandom(13);
    try {
      const stud = new SevenStudTable(cfg({ ante: 10 }), false, false);
      for (let i = 0; i < 5; i++) stud.sitDown(i, `B${i}`, 10000, `ai-${i}`, true);
      stud.startNewHand();
      let g = 0;
      while (stud.currentPhase === GamePhase.ThirdStreet && g++ < 20) stud.playerCall(stud.activeSeatIndex) || stud.playerCheck(stud.activeSeatIndex);
      expect(stud.currentPhase).toBe(GamePhase.FourthStreet);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 20; i++) decideAction(stud, stud.activeSeatIndex, generateRandomProfile('expert'));
      expect(Number(process.hrtime.bigint() - t0) / 1e6 / 20).toBeLessThan(150);
    } finally { restore(); }
  });

  it(`the equity budget (BOT_EQUITY_BUDGET_MS = ${BOT_EQUITY_BUDGET_MS}) stops a heavy spot after the minimum simulations — measured in WORK, not wall time`, () => {
    const hole = [card(14, 0), card(13, 0), card(12, 1), card(11, 2), card(10, 3), card(9, 1)] as any;
    const board = [card(2, 0), card(7, 1), card(9, 2)] as any;
    const draws = (maxMs: number, clockJump: number) => {
      const origRandom = Math.random;
      let n = 0;
      Math.random = () => { n++; return origRandom(); };
      let calls = 0;
      const realNow = Date.now;
      const base = realNow();
      Date.now = () => base + (calls++ === 0 ? 0 : clockJump);   // every read after the first is "past the deadline"
      try { TE.calculateEquity(hole, board, 7, true, 0, false, maxMs); } finally { Math.random = origRandom; Date.now = realNow; }
      return n;
    };
    const unbudgeted = draws(0, 0);
    const budgeted = draws(BOT_EQUITY_BUDGET_MS, BOT_EQUITY_BUDGET_MS * 10);
    const inTime = draws(BOT_EQUITY_BUDGET_MS, 0);
    expect(budgeted * 5).toBeLessThan(unbudgeted);   // 64 of 500 simulations
    expect(inTime).toBe(unbudgeted);                 // a spot that finishes inside the budget runs all 500
  });
});

describe('GAME-9 — limitBotRaiseWar', () => {
  const t = () => {
    const x = new PokerTable(cfg());
    for (let i = 0; i < 4; i++) x.sitDown(i, `B${i}`, 100000, `ai-${i}`, true);
    x.startNewHand();
    return x;
  };
  const raise = { action: PlayerAction.Raise, raiseAmount: 10_000 };

  it('below the street cap a raise is left alone', () => {
    const x = t();
    expect(limitBotRaiseWar(x, x.seats[x.activeSeatIndex], raise, true, 0.99)).toBe(raise);
  });

  it(`at ${BOT_MAX_STREET_RAISES_PREFLOP} raises pre-flop: a non-premium raise becomes a CALL; a premium no-limit hand may shove (one action — the war ends)`, () => {
    const x = t();
    for (let r = 0; r < BOT_MAX_STREET_RAISES_PREFLOP; r++) expect(x.playerRaise(x.activeSeatIndex, x.getMinRaise())).toBe(true);
    const seat = x.seats[x.activeSeatIndex];
    expect(limitBotRaiseWar(x, seat, raise, true, 0.80)).toEqual({ action: PlayerAction.Call, raiseAmount: 0 });
    expect(limitBotRaiseWar(x, seat, raise, true, 0.95)).toEqual({ action: PlayerAction.AllIn, raiseAmount: 0 });
    expect(limitBotRaiseWar(x, seat, { action: PlayerAction.Fold, raiseAmount: 0 }, true, 0.1).action).toBe(PlayerAction.Fold);
  });

  it(`after the flop the cap is ${BOT_MAX_STREET_RAISES_POSTFLOP} (a bet and one raise); checking spots stay checks`, () => {
    const x = t();
    let g = 0;
    while (x.currentPhase === GamePhase.PreFlop && g++ < 10) x.playerCall(x.activeSeatIndex) || x.playerCheck(x.activeSeatIndex);
    expect(x.currentPhase).toBe(GamePhase.Flop);
    for (let r = 0; r < BOT_MAX_STREET_RAISES_POSTFLOP; r++) expect(x.playerRaise(x.activeSeatIndex, Math.max(100, x.getMinRaise()))).toBe(true);
    expect(limitBotRaiseWar(x, x.seats[x.activeSeatIndex], raise, false, 0.5).action).toBe(PlayerAction.Call);
  });

  it('fixed limit at its cap: never a raise (passive), even a premium hand', () => {
    const x = new FiveCardDrawTable(cfg(), true);
    for (let i = 0; i < 5; i++) x.sitDown(i, `B${i}`, 100000, `ai-${i}`, true);
    x.startNewHand();
    for (let r = 0; r < 3; r++) x.playerRaise(x.activeSeatIndex, x.getMinRaise());
    expect(x.isRaiseCapped()).toBe(true);
    expect(limitBotRaiseWar(x, x.seats[x.activeSeatIndex], raise, true, 1).action).toBe(PlayerAction.Call);
  });

  it('a bot that already raised twice this street stops raising (own cap) even under the street cap', () => {
    const x = new PokerTable(cfg());
    for (let i = 0; i < 2; i++) x.sitDown(i, `B${i}`, 1_000_000, `ai-${i}`, true);
    x.startNewHand();
    let g = 0;
    while (x.currentPhase === GamePhase.PreFlop && g++ < 10) x.playerCall(x.activeSeatIndex) || x.playerCheck(x.activeSeatIndex);
    const me = x.activeSeatIndex;
    x.actionLog.push({ seatIndex: me, playerName: 'B', action: 'raised to 300', street: x.currentPhase });
    x.actionLog.push({ seatIndex: me, playerName: 'B', action: 'raised to 900', street: x.currentPhase });
    expect(limitBotRaiseWar(x, x.seats[me], raise, false, 0.5).action).toBe(PlayerAction.Check);
  });
});

describe('GAME-9 — the war is gone: real engine + decideAction + executeAIAction, 5 hard bots', () => {
  // medium bots (no Monte Carlo — the limiter is the same at every difficulty) keep this fast; one short
  // hard-bot run below covers the equity path.
  const variants: Array<[string, () => PokerTable, number, 'medium' | 'hard']> = [
    ["No-Limit Hold'em", () => new PokerTable(cfg()), 300, 'medium'],
    ["No-Limit Hold'em (hard bots)", () => new PokerTable(cfg()), 15, 'hard'],
    ['Pot-Limit Omaha Hi-Lo', () => new OmahaTable(cfg(), true, 4), 200, 'medium'],
    ['2-7 Triple Draw (fixed limit)', () => new FiveCardDrawTable(cfg(), true), 200, 'hard'],
    ['Badugi (fixed limit)', () => new BadugiTable(cfg()), 150, 'hard'],
    ['Seven Card Stud (fixed limit)', () => new SevenStudTable(cfg({ ante: 10 }), false, false), 150, 'hard'],
  ];
  it.each(variants)('%s: no betting round over 6 raises, no hand over 60 actions, fixed limit never past 4 bet levels', (_n, mk, hands, difficulty) => {
    const restore = seedRandom(2026);
    try {
      const table = mk();
      const r = playBotHands(table, Math.min(5, table.maxOccupiableSeats), hands, difficulty);
      expect(r.stuck).toBe(0);
      expect(r.actions).toHaveLength(hands);
      expect(Math.max(...r.streetRaises)).toBeLessThanOrEqual(6);
      expect(Math.max(...r.actions)).toBeLessThanOrEqual(60);
      if (table.bettingStructure === 'fixed-limit') expect(r.maxLevels).toBeLessThanOrEqual(FIXED_LIMIT_MAX_BET_LEVELS);
    } finally { restore(); }
  });

  it('sanity: MAX_SEATS', () => { expect(MAX_SEATS).toBe(9); });
});

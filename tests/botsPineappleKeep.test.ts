/**
 * .online bots review 2026-11-04 (equity-variants C3, finding B7) — the ONE
 * Pineapple keep rule, pineappleDiscardIndex, shared by the engine's no-pick
 * fallback (PineappleTable.fallbackDiscardIndex) and the bots' pricing
 * (TrainingEngine.keptHoldemHoleCards).
 *
 * Before: the bots priced (and the engine kept) all but the lowest-rank card
 * before the flop: 77K kept K7 and 55K kept K5, breaking 50% of dealt pairs.
 *
 * The no-board rule reads the Hold'em pre-flop percentile, which is the
 * committed table (holdem-preflop B10, src/ai/preflopTable.ts): a Map lookup,
 * identical on every boot, no Math.random. The engine-fallback cases below run
 * the REAL PineappleTable (helpers copied from gameplay_S3).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import { Card } from '../src/game/Card';
import { evaluateHand, compareTo, HandResult } from '../src/game/HandEvaluator';
import { pineappleDiscardIndex } from '../src/game/variants/pineappleKeep';
import * as TE from '../src/training/TrainingEngine';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const key = (c: Card) => c.suit * 16 + c.rank;
const same = (a: Card[], b: Card[]) => a.map(key).sort((x, y) => x - y).join() === b.map(key).sort((x, y) => x - y).join();

const T = 't';
const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: T, tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 100, ...over } as any);
const seatAt = (t: PokerTable, stacks: Record<number, number>, ai = false) => {
  for (const [i, chips] of Object.entries(stacks)) expect(t.sitDown(Number(i), `P${i}`, chips, ai ? `ai-${i}` : `p${i}`, ai, true)).toBe(true);
};
/** Everyone calls / checks while `more()` holds. */
function callAround(t: PokerTable, more: () => boolean): void {
  for (let g = 0; g < 80 && more(); g++) {
    const a = t.activeSeatIndex;
    expect(a).toBeGreaterThanOrEqual(0);
    const owes = t.currentBetToMatch > t.seats[a].currentBet;
    expect(owes ? t.playerCall(a) : t.playerCheck(a)).toBe(true);
  }
}
/** Fix the hole cards of the given seats and the board (burn, flop, burn, turn, burn, river). */
function rig(t: PokerTable, holes: Record<number, string>, board: string): void {
  const h: Record<number, Card[]> = {};
  for (const [i, x] of Object.entries(holes)) h[Number(i)] = cs(x);
  rigCards(t, h, cs(board));
}
function rigCards(t: PokerTable, holes: Record<number, Card[]>, b: Card[]): void {
  const used = new Set<number>();
  for (const [i, h] of Object.entries(holes)) {
    t.seats[Number(i)].holeCards = h.slice();
    for (const c of h) used.add(key(c));
  }
  for (const c of b) used.add(key(c));
  const rest: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) if (!used.has(suit * 16 + rank)) rest.push({ suit, rank } as Card);
  const deck = (t as any).deck;
  deck.cards = [rest[0], b[0], b[1], b[2], rest[1], b[3], rest[2], b[4], ...rest.slice(3)];
  deck.currentIndex = 0;
}

function seeded<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  try { return fn(); } finally { Math.random = orig; }
}
/** A deterministic deal from an LCG: three 3-card hands and a 5-card board (the engine deals with crypto). */
function lcgDeal(seed: number): { holes: Record<number, Card[]>; board: Card[] } {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const deck: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) deck.push({ suit, rank } as Card);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return { holes: { 0: deck.slice(0, 3), 1: deck.slice(3, 6), 2: deck.slice(6, 9) }, board: deck.slice(9, 14) };
}

describe('C3 — pineappleDiscardIndex before the flop keeps the best pre-flop pair', () => {
  it('77K keeps 77, 55K keeps 55, AA3 keeps AA (the rank rule kept K7 and K5)', () => {
    expect(pineappleDiscardIndex(cs('7h 7d Kc'))).toBe(2);
    expect(pineappleDiscardIndex(cs('5h 5d Kc'))).toBe(2);
    expect(pineappleDiscardIndex(cs('Ah As 3d'))).toBe(2);
    expect(pineappleDiscardIndex(cs('Kc 7h 7d'))).toBe(0);
  }, 60_000);

  it('keptHoldemHoleCards prices exactly the two cards the keep rule keeps, in their dealt order', () => {
    expect(TE.keptHoldemHoleCards(cs('7h 7d Kc'))).toEqual(cs('7h 7d'));
    expect(TE.keptHoldemHoleCards(cs('5h 5d Kc'))).toEqual(cs('5h 5d'));
    expect(TE.keptHoldemHoleCards(cs('Kc 7h 7d'), [])).toEqual(cs('7h 7d'));
  }, 60_000);

  it('calculateEquity on a 3-card Hold\'em hand is the equity of the kept pair (same draws, same answer)', () => {
    const three = seeded(51, () => TE.calculateEquity(cs('7h 7d Kc'), [], 2, false));
    const kept = seeded(51, () => TE.calculateEquity(cs('7h 7d'), [], 2, false));
    expect(three).toBe(kept);
  }, 60_000);

  it('reads the committed table: no Math.random call, the same keep every time', () => {
    const orig = Math.random;
    let calls = 0;
    Math.random = () => { calls++; return orig(); };
    try {
      for (let i = 0; i < 3; i++) expect(pineappleDiscardIndex(cs('2h 2d As'))).toBe(0);
    } finally { Math.random = orig; }
    expect(calls).toBe(0);
  }, 60_000);
});

describe('C3 #1 — the engine fallback (no pick) keeps the same pair, plain Pineapple', () => {
  /** 3-handed plain Pineapple, seat 0 rigged to `hand`, called around to the flop with no pick. */
  function toFlop(hand: string, ai: boolean): PineappleTable {
    const t = new PineappleTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 }, ai);
    t.startNewHand();
    rig(t, { 0: hand }, '9c 8s 3d Jh 4c');
    expect(t.hasDiscardChoice(0)).toBe(false);
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    return t;
  }

  it.each([
    // hand,        kept,      HEAD kept (lowest rank dropped)
    ['7h 7d Kc', '7h 7d', '7d Kc'],
    ['5h 5d Kc', '5h 5d', '5d Kc'],
    ['Kc 7h 7d', '7h 7d', 'Kc 7d'],
  ])('%s keeps %s (HEAD kept %s); logged as an auto-discard', (hand, kept) => {
    const t = toFlop(hand, false);
    expect(t.seats[0].holeCards).toHaveLength(2);
    expect(same(t.seats[0].holeCards, cs(kept))).toBe(true);
    expect(t.actionLog.find((a) => a.seatIndex === 0 && /discarded/.test(a.action))!.action).toBe('auto-discarded a card');
  }, 60_000);

  it.each([
    ['2h 2d As', '2d As'],   // A2o (0.683) over 22 (0.527): the rank rule's keep, unchanged
    ['7h Tc 2c', '7h Tc'],   // the gameplay_S3 F17 spot, unchanged
    ['Ah As 3d', 'Ah As'],
  ])('GUARD (same as HEAD): %s keeps %s', (hand, kept) => {
    const t = toFlop(hand, false);
    expect(same(t.seats[0].holeCards, cs(kept))).toBe(true);
    expect(t.actionLog.find((a) => a.seatIndex === 0 && /discarded/.test(a.action))!.action).toBe('auto-discarded a card');
  }, 60_000);

  it('a bot seat and a human seat with no pick get the same keep; the discard event says auto', () => {
    for (const ai of [false, true]) {
      const t = new PineappleTable(cfg(), false);
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 }, ai);
      const events: any[] = [];
      t.on('pineappleDiscarded', (e) => events.push(e));
      t.startNewHand();
      rig(t, { 0: '7h 7d Kc' }, '9c 8s 3d Jh 4c');
      expect(t.seats[0].isAI).toBe(ai);
      callAround(t, () => t.currentPhase === GamePhase.PreFlop);
      expect(same(t.seats[0].holeCards, cs('7h 7d'))).toBe(true);
      expect(t.discardOf(0)).toEqual(cs('Kc')[0]);
      expect(events.find((e) => e.seatIndex === 0)).toEqual({ seatIndex: 0, card: cs('Kc')[0], auto: true });
    }
  }, 60_000);

  it('a pick still wins over the fallback (the player throws a 7 from 77K)', () => {
    const t = new PineappleTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    rig(t, { 0: '7h 7d Kc' }, '9c 8s 3d Jh 4c');
    expect(t.selectPineappleDiscard(0, 0)).toBe(true);
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(same(t.seats[0].holeCards, cs('7d Kc'))).toBe(true);
    expect(t.actionLog.find((a) => a.seatIndex === 0 && /discarded/.test(a.action))!.action).toBe('discarded a card');
  }, 60_000);

  it('the engine keeps exactly what keptHoldemHoleCards prices: 100 seeded 3-handed deals (300 seats)', () => {
    let seats = 0;
    let differsFromRankRule = 0;
    for (let n = 0; n < 100; n++) {
      const { holes, board } = lcgDeal(20261105 + n);
      const t = new PineappleTable(cfg(), false);
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 }, true);
      t.startNewHand();
      rigCards(t, holes, board);
      const priced = [0, 1, 2].map((s) => TE.keptHoldemHoleCards(t.seats[s].holeCards));
      callAround(t, () => t.currentPhase === GamePhase.PreFlop);
      expect(t.currentPhase).toBe(GamePhase.Flop);
      for (let s = 0; s < 3; s++) {
        expect(same(t.seats[s].holeCards, priced[s])).toBe(true);
        const lowest = holes[s].reduce((w, c) => (c.rank < w.rank || (c.rank === w.rank && c.suit < w.suit) ? c : w));
        if (t.seats[s].holeCards.some((c) => key(c) === key(lowest))) differsFromRankRule++;
        seats++;
      }
    }
    expect(seats).toBe(300);
    expect(differsFromRankRule).toBeGreaterThan(0);   // the keep is not the old rank rule on every hand
  }, 60_000);
});

describe('C3 — with a board (the Crazy Pineapple flop) the F16 rule is unchanged', () => {
  it('drops the card whose loss leaves the best hand: 7s 7h Kd on 7d 3s 9c discards Kd', () => {
    expect(pineappleDiscardIndex(cs('7s 7h Kd'), cs('7d 3s 9c'))).toBe(2);
    expect(TE.keptHoldemHoleCards(cs('7s 7h Kd'), cs('7d 3s 9c'))).toEqual(cs('7s 7h'));
    expect(pineappleDiscardIndex(cs('Ah 2c Kh'), cs('Qh Jh 4s'))).toBe(1);   // keeps the flush draw's A K
  }, 60_000);

  it('a tie keeps the rank rule (lowest rank, ties to the lowest suit)', () => {
    // Without 2h or without 2d the hand is the same (four aces, 2 kicker) and better than
    // dropping the Ac (aces full of twos): on the tie the weakest card (2h) goes.
    expect(pineappleDiscardIndex(cs('2h 2d Ac'), cs('Ad Ah As'))).toBe(0);
    // ...and with the two deuces in the other order, the 2h is still the one dropped.
    expect(pineappleDiscardIndex(cs('2d 2h Ac'), cs('Ad Ah As'))).toBe(1);
  }, 60_000);

  it('uses the evaluator and comparator it is given (the engine passes its own)', () => {
    let evals = 0;
    const evalHand = (h: Card[], b: Card[]): HandResult => { evals++; return evaluateHand([...h, ...b]); };
    let cmps = 0;
    const cmp = (a: HandResult, b: HandResult) => { cmps++; return compareTo(a, b); };
    expect(pineappleDiscardIndex(cs('7s 7h Kd'), cs('7d 3s 9c'), evalHand, cmp)).toBe(2);
    expect(evals).toBe(3);
    expect(cmps).toBe(2);
  }, 60_000);
});

describe('C3 #2 — GUARD (same as HEAD): the engine\'s Crazy Pineapple fallback with the flop out', () => {
  /** 3-handed Crazy Pineapple, seat 0 rigged, called around to the turn with no pick. */
  function toTurn(hand: string, board: string): PineappleTable {
    const t = new PineappleTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    rig(t, { 0: hand }, board);
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.seats[0].holeCards).toHaveLength(3);        // Crazy: no discard before the flop
    callAround(t, () => t.currentPhase === GamePhase.Flop);
    expect(t.currentPhase).toBe(GamePhase.Turn);
    return t;
  }

  it('7s 7h Kd on 7d 3s 9c keeps the set (drops Kd), as pineappleDiscardIndex with the flop', () => {
    const t = toTurn('7s 7h Kd', '7d 3s 9c Jh 4d');
    expect(same(t.seats[0].holeCards, cs('7s 7h'))).toBe(true);
    expect(pineappleDiscardIndex(cs('7s 7h Kd'), cs('7d 3s 9c'))).toBe(2);
    expect(t.actionLog.find((a) => a.seatIndex === 0 && /discarded/.test(a.action))!.action).toBe('auto-discarded a card');
  }, 60_000);

  it('a tie keeps the rank rule: 2h 2d Ac on Ad Ah As drops the 2h', () => {
    const t = toTurn('2h 2d Ac', 'Ad Ah As Kc Qd');
    expect(same(t.seats[0].holeCards, cs('2d Ac'))).toBe(true);
  }, 60_000);

  it('the pair kept on the turn is the pair keptHoldemHoleCards(hole, flop) prices on the flop: 100 seeded deals (300 seats)', () => {
    let seats = 0;
    for (let n = 0; n < 100; n++) {
      const { holes, board } = lcgDeal(20261106 + n);
      const t = new PineappleTable(cfg(), true);
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 }, true);
      t.startNewHand();
      rigCards(t, holes, board);
      callAround(t, () => t.currentPhase === GamePhase.PreFlop);
      const flop = t.communityCards.slice();
      expect(same(flop, board.slice(0, 3))).toBe(true);
      const priced = [0, 1, 2].map((s) => TE.keptHoldemHoleCards(t.seats[s].holeCards, flop));
      callAround(t, () => t.currentPhase === GamePhase.Flop);
      expect(t.currentPhase).toBe(GamePhase.Turn);
      for (let s = 0; s < 3; s++) { expect(same(t.seats[s].holeCards, priced[s])).toBe(true); seats++; }
    }
    expect(seats).toBe(300);
  }, 60_000);
});

describe('C3 — other hand sizes (GUARD: same as before)', () => {
  it('fewer than 2 cards → 0; 2 or 4+ cards → the weakest card; keptHoldemHoleCards of 7 cards keeps the two highest', () => {
    expect(pineappleDiscardIndex([])).toBe(0);
    expect(pineappleDiscardIndex(cs('Ah'))).toBe(0);
    expect(pineappleDiscardIndex(cs('Ah 2c'))).toBe(1);
    expect(pineappleDiscardIndex(cs('Ah 2c 2d Kc'))).toBe(2); // 2d: the lowest rank, then the lowest suit (h < d < c < s)
    const seven = cs('Ah Kh Qd 5c 4s 3d 2c');
    expect(TE.keptHoldemHoleCards(seven).map((c) => c.rank)).toEqual([14, 13]);
    expect(TE.keptHoldemHoleCards(cs('9s 4c'))).toEqual(cs('9s 4c'));
  }, 60_000);
});

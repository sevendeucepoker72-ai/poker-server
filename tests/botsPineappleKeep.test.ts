/**
 * .online bots review 2026-11-04 (equity-variants C3, finding B7) — the ONE
 * Pineapple keep rule, pineappleDiscardIndex, shared by the engine's no-pick
 * fallback and the bots' pricing (TrainingEngine.keptHoldemHoleCards).
 *
 * Before: the bots priced (and the engine kept) all but the lowest-rank card
 * before the flop: 77K kept K7 and 55K kept K5, breaking 50% of dealt pairs.
 *
 * The no-board rule reads the Hold'em pre-flop percentile. Until the committed
 * table lands (holdem-preflop B10) that table is built lazily from Math.random
 * on first use (several seconds), so it is built once here under a fixed seed
 * with an explicit timeout; with the committed table that is a no-op.
 */
import { Card } from '../src/game/Card';
import { evaluateHand, compareTo, HandResult } from '../src/game/HandEvaluator';
import { percentileByRanks } from '../src/ai/preflopRanges';
import { pineappleDiscardIndex } from '../src/game/variants/pineappleKeep';
import * as TE from '../src/training/TrainingEngine';

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const SU: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] =>
  s.trim() ? s.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] } as Card)) : [];

function seeded<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  try { return fn(); } finally { Math.random = orig; }
}

beforeAll(() => {
  seeded(20261104, () => percentileByRanks(14, 14, false));
}, 120_000);

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

/**
 * R1 (2026-10-11) — ECON-1 / TABLEUI-1: all-in insurance is priced against the
 * opponent's ACTUAL cards, as a 0..1 fraction.
 *
 * The live bug: acceptInsurance fed calculateEquity's PERCENT (0-100, against a
 * RANDOM hand) to insuranceCashoutAmount, which clamps to [0,1] — every quote
 * paid 90% of the pot (1,467,310 chips minted 09-12..10-07). These tests pin:
 *   - fastHandScore orders hands EXACTLY like the engine's showdown evaluator
 *     (evaluateHand + compareTo) — random deals + edge cases;
 *   - headsUpEquity is EXACT (every runout) with <= 2 board cards to come and
 *     equals a brute force over the engine evaluator; pre-flop it is a seeded,
 *     deterministic Monte Carlo close to the known numbers;
 *   - priceInsuranceQuote = round(0.9 * equity * contested pot), never 90% of
 *     the pot for a losing hand.
 */
import { Card } from '../src/game/Card';
import { evaluateHand, compareTo } from '../src/game/HandEvaluator';
import { fastHandScore, headsUpEquity, mulberry32 } from '../src/game/handEquity';
import { priceInsuranceQuote, insuranceCashoutAmount } from '../src/game/insurance';
import { calculateEquity } from '../src/training/TrainingEngine';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
/** 'Ah Kd' -> cards */
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const fullDeck = (): Card[] => {
  const d: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) d.push({ suit, rank } as Card);
  return d;
};
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

describe('fastHandScore orders hands exactly like the engine showdown (evaluateHand + compareTo)', () => {
  test('30,000 random heads-up showdowns on a shared 5-card board agree on the winner (and every split)', () => {
    const rand = mulberry32(12345);
    let splits = 0;
    for (let n = 0; n < 30_000; n++) {
      const deck = fullDeck();
      for (let i = 0; i < 9; i++) {
        const j = i + Math.floor(rand() * (deck.length - i));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const board = deck.slice(4, 9);
      const a = [deck[0], deck[1], ...board];
      const b = [deck[2], deck[3], ...board];
      const engine = sign(compareTo(evaluateHand(a), evaluateHand(b)));
      const fast = sign(fastHandScore(a) - fastHandScore(b));
      if (engine !== fast) throw new Error(`disagree on ${JSON.stringify({ a, b, engine, fast })}`);
      if (engine === 0) splits++;
    }
    expect(splits).toBeGreaterThan(0); // the tie path was exercised
  });

  test('edge cases: wheel, steel wheel, royal, two trips, three pairs, quads kicker, 6-card flush, board plays', () => {
    const pairs: Array<[string, string, number]> = [
      // [hand A (7 cards), hand B (7 cards), expected sign A vs B]
      ['Ah 2d 3c 4s 5h Kd Kc', '6h 2d 3c 4s 5h Kd Kc', -1],        // wheel loses to the 6-high straight
      ['Ah 2h 3h 4h 5h Kd Kc', '6s 7s 8s 9s Ts Kd Kc', -1],        // steel wheel < 10-high straight flush
      ['Ah Kh Qh Jh Th 2c 3d', '9s 8s 7s 6s 5s 4d 4c', 1],         // royal > 9-high straight flush
      ['Kh Kd Kc 7s 7h 7d 2c', 'Kh Kd Kc Qs Qh 2d 3c', -1],        // KKK77 < KKKQQ (second trips plays as the pair)
      ['Ah Ad Kc Ks Qh Qd 2c', 'Ah Ad Kc Ks Jh Jd Qc', 0],         // AAKK+Q both (third pair vs Q kicker)
      ['9h 9d 9c 9s Ah 2d 3c', '9h 9d 9c 9s Kh Kd Kc', 1],         // quads, A kicker > K kicker
      ['Ah 9h 7h 5h 3h 2h Kd', 'Kh Qh Jh 9h 2h 4c 5d', 1],         // 6-card flush: best five A-9-7-5-3 vs K-Q-J-9-2
      ['2c 3d Ah Kh Qh Jh Th', '4c 5d Ah Kh Qh Jh Th', 0],         // board royal plays for both
      ['Ah Kd Qc Js 9h 3d 2c', 'Ah Kd Qc Js 8h 3d 2c', 1],         // high card, 5th kicker decides
      ['Th Td 4c 4s 9h 2d 2c', 'Th Td 4c 4s 8h 3d 3c', 1],         // three pairs: TT44 + 9 kicker > TT44 + 8 kicker (the 33 never plays)
    ];
    for (const [a, b, want] of pairs) {
      const A = cs(a), B = cs(b);
      expect(sign(compareTo(evaluateHand(A), evaluateHand(B)))).toBe(want); // the engine's own verdict
      expect(sign(fastHandScore(A) - fastHandScore(B))).toBe(want);
    }
  });
});

describe('headsUpEquity — against the opponent\'s ACTUAL hole cards', () => {
  /** Brute force with the ENGINE evaluator, for comparison. */
  const bruteForce = (hero: Card[], villain: Card[], board: Card[]): number => {
    const used = new Set([...hero, ...villain, ...board].map((c) => c.suit * 16 + c.rank));
    const rest = fullDeck().filter((c) => !used.has(c.suit * 16 + c.rank));
    const need = 5 - board.length;
    let w = 0, t = 0, n = 0;
    const runs: Card[][] = [];
    if (need === 1) for (const c of rest) runs.push([c]);
    if (need === 2) for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) runs.push([rest[i], rest[j]]);
    for (const extra of runs) {
      const cmp = compareTo(evaluateHand([...hero, ...board, ...extra]), evaluateHand([...villain, ...board, ...extra]));
      if (cmp > 0) w++; else if (cmp === 0) t++;
      n++;
    }
    return (w + t / 2) / n;
  };

  test('flop (2 to come) is EXACT: 990 runouts, equal to a brute force over the engine evaluator', () => {
    const hero = cs('Ah Kh'), villain = cs('Qs Qd'), board = cs('2h 7h Jc');
    const r = headsUpEquity(hero, villain, board);
    expect(r.exact).toBe(true);
    expect(r.total).toBe(990);
    expect(r.equity).toBeCloseTo(bruteForce(hero, villain, board), 12);
  });

  test('turn (1 to come) is EXACT: 44 runouts; set vs flush draw', () => {
    const hero = cs('9c 9d'), villain = cs('Ah Th'), board = cs('9h 4h 2s Kc');
    const r = headsUpEquity(hero, villain, board);
    expect(r.exact).toBe(true);
    expect(r.total).toBe(44);
    expect(r.equity).toBeCloseTo(bruteForce(hero, villain, board), 12);
    // 9 hearts + no redraw for the set beyond the board pairing: villain wins on 9 (flush) minus none
    expect(r.losses + r.ties).toBeGreaterThan(0);
  });

  test('pre-flop is a SEEDED Monte Carlo: deterministic, and close to the known equities', () => {
    const aa = cs('As Ah'), kk = cs('Ks Kh');
    const one = headsUpEquity(aa, kk, [], { seed: 99, samples: 20_000 });
    const two = headsUpEquity(aa, kk, [], { seed: 99, samples: 20_000 });
    expect(one.exact).toBe(false);
    expect(one).toEqual(two);                       // same seed -> same quote
    expect(one.equity).toBeGreaterThan(0.79);        // AA vs KK ~ 81-82%
    expect(one.equity).toBeLessThan(0.845);
    const weak = headsUpEquity(cs('7h 2c'), aa, [], { seed: 7, samples: 20_000 });
    expect(weak.equity).toBeGreaterThan(0.09);       // 72o vs AA ~ 12%
    expect(weak.equity).toBeLessThan(0.16);
  });

  test('a malformed deal throws (callers treat it as "no quote")', () => {
    expect(() => headsUpEquity(cs('Ah Kh'), cs('Ah Qd'), [])).toThrow();      // duplicate card
    expect(() => headsUpEquity(cs('Ah'), cs('Qs Qd'), [])).toThrow();         // one hole card
  });
});

describe('priceInsuranceQuote — R1 contract #1 shape and pricing', () => {
  const base = { tableId: 'T', handNumber: 7, contestedPot: 20_000, expiresAt: 1_700_000_000_000 };

  test('ECON-1 regression: a 12% hand is priced at 12%, never at 90% of the pot', () => {
    const q = priceInsuranceQuote({ ...base, hero: cs('7h 2c'), villain: cs('As Ah'), board: [] })!;
    expect(q).not.toBeNull();
    expect(q.equityPct).toBeGreaterThanOrEqual(9);
    expect(q.equityPct).toBeLessThanOrEqual(16);
    expect(q.cashout).toBeLessThan(0.9 * 20_000 * 0.2);
    // The old code: training-engine PERCENT read as a fraction -> clamped to 1.
    const oldEquity = calculateEquity(cs('7h 2c'), [], 1, false); // e.g. 34.6 (a percent, vs a RANDOM hand)
    expect(oldEquity).toBeGreaterThan(1);
    expect(insuranceCashoutAmount(20_000, oldEquity)).toBe(18_000); // what prod paid for any hand
  });

  test('exact price = round(0.9 * equity * contested pot); integers; equityPct 0-100', () => {
    const hero = cs('Ah Kh'), villain = cs('Qs Qd'), board = cs('2h 7h Jc');
    const eq = headsUpEquity(hero, villain, board).equity;
    const q = priceInsuranceQuote({ ...base, hero, villain, board })!;
    expect(q).toEqual({ handNumber: 7, cashout: Math.round(20_000 * eq * 0.9), equityPct: Math.round(eq * 100), pot: 20_000, expiresAt: base.expiresAt });
    for (const k of ['handNumber', 'cashout', 'equityPct', 'pot', 'expiresAt'] as const) expect(Number.isInteger(q[k])).toBe(true);
  });

  test('nothing to insure -> null: drawing dead, a lock, an empty pot, a bad deal', () => {
    // Villain holds the nut straight flush on the turn; hero is drawing dead.
    expect(priceInsuranceQuote({ ...base, hero: cs('2c 3d'), villain: cs('Ah Kh'), board: cs('Qh Jh Th 4s') })).toBeNull();
    // ... and the other way round: a lock (insuring it could only cost the player).
    expect(priceInsuranceQuote({ ...base, hero: cs('Ah Kh'), villain: cs('2c 3d'), board: cs('Qh Jh Th 4s') })).toBeNull();
    expect(priceInsuranceQuote({ ...base, contestedPot: 0, hero: cs('Ah Kh'), villain: cs('Qs Qd'), board: [] })).toBeNull();
    expect(priceInsuranceQuote({ ...base, hero: cs('Ah Kh'), villain: cs('Ah Qd'), board: [] })).toBeNull();
  });
});

/**
 * Bots review 2026-11-04 (stud-draw-lowball SD1 / SD2): the Stud / Razz / Stud 8 /
 * Five Card Draw / 2-7 Triple Draw / Badugi bot hand values in src/ai/studDrawStrength.ts.
 *
 * B1 / B2: at 0dc1b96 the bots scored these games with a Hold'em-scale number in the
 * wrong order (2-7 23456 scored like the nuts, Badugi pairs / suits barely penalised,
 * Razz wheel+KK below 87654, Stud 8 high-only), so 5 of 7 archetypes folded 99-100%
 * of first rounds. The new value functions must order hands EXACTLY like the engine's
 * own evaluator + comparator (the showdown), and the first-round percentile must put
 * the canonical premium / trash hands in the right bands.
 *
 * Fails on 0dc1b96: src/ai/studDrawStrength.ts and src/ai/studDrawCdf.ts do not exist.
 */
import { Card } from '../src/game/Card';
import { evaluateHand, compareTo } from '../src/game/HandEvaluator';
import {
  evaluateRazzHand, compareRazzHands, evaluateLowHand, compareLowHands,
  evaluate27LowHand, compare27Hands, evaluateBadugiHand, compareBadugiHands,
} from '../src/game/HandEvaluatorExtensions';
import {
  StudDrawKind, hiValue, razzValue, low8Value, deuce7Value, badugiValue,
  firstRoundEquity, equityToPercentile, drawsLeftAt, FIRST_ROUND_CDF,
} from '../src/ai/studDrawStrength';

const SUIT: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const RANK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
/** 'Ah Kd 7c' -> cards. */
const C = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ rank: RANK[t[0]] ?? Number(t[0]), suit: SUIT[t[1]] } as Card));

const DECK: Card[] = [];
for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) DECK.push({ rank: r, suit: s } as Card);

/** Seeded LCG deal (deterministic: the same pairs every run). */
function dealer(seed: number) {
  let x = seed >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  return (n: number, pool: Card[] = DECK): Card[] => {
    const d = pool.slice();
    for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (d.length - i)); const t = d[i]; d[i] = d[j]; d[j] = t; }
    return d.slice(0, n);
  };
}
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Random pairs: sign(engine compare) must equal sign(value(a) - value(b)). Returns the mismatch count + first example. */
function mismatches(seed: number, n: number, pairs: number, engine: (a: Card[], b: Card[]) => number, value: (c: Card[]) => number, pool: Card[] = DECK) {
  const deal = dealer(seed);
  let bad = 0;
  let example = '';
  for (let i = 0; i < pairs; i++) {
    const a = deal(n, pool), b = deal(n, pool);
    if (sgn(engine(a, b)) !== sgn(value(a) - value(b))) { bad++; if (!example) example = JSON.stringify({ a, b }); }
  }
  return { bad, example };
}

// Pools with few distinct ranks stress pairs / trips / quads / full houses.
const FEW_RANKS = DECK.filter((c) => [14, 2, 3, 4, 13].includes(c.rank));
const LOW_RANKS = DECK.filter((c) => c.rank <= 7);

const hiEngine = (a: Card[], b: Card[]) => compareTo(evaluateHand(a), evaluateHand(b));
const razzEngine = (a: Card[], b: Card[]) => -compareRazzHands(evaluateRazzHand(a), evaluateRazzHand(b));
const low8Engine = (a: Card[], b: Card[]) => -compareLowHands(evaluateLowHand(a), evaluateLowHand(b));
const deuce7Engine = (a: Card[], b: Card[]) => -compare27Hands(evaluate27LowHand(a), evaluate27LowHand(b));
const badugiEngine = (a: Card[], b: Card[]) => compareBadugiHands(evaluateBadugiHand(a), evaluateBadugiHand(b));

describe('studDrawStrength value functions order hands exactly like the engine (T1)', () => {
  const PAIRS = 20000, FEW = 5000;

  test.each([5, 6, 7])('hiValue == compareTo(evaluateHand), %i cards', (n) => {
    expect(mismatches(1000 + n, n, PAIRS, hiEngine, hiValue)).toEqual({ bad: 0, example: '' });
  }, 60000);
  test('hiValue == compareTo(evaluateHand), 7 cards from a few-rank pool', () => {
    expect(mismatches(1100, 7, FEW, hiEngine, hiValue, FEW_RANKS)).toEqual({ bad: 0, example: '' });
  }, 60000);

  test.each([5, 6, 7])('razzValue == -compareRazzHands(evaluateRazzHand), %i cards', (n) => {
    expect(mismatches(2000 + n, n, PAIRS, razzEngine, razzValue)).toEqual({ bad: 0, example: '' });
  }, 60000);
  test('razzValue == -compareRazzHands, 7 cards from a few-rank pool', () => {
    expect(mismatches(2100, 7, FEW, razzEngine, razzValue, FEW_RANKS)).toEqual({ bad: 0, example: '' });
  }, 60000);

  test.each([5, 6, 7])('low8Value == -compareLowHands(evaluateLowHand), %i cards', (n) => {
    expect(mismatches(3000 + n, n, PAIRS, low8Engine, low8Value)).toEqual({ bad: 0, example: '' });
  }, 60000);
  test('low8Value == -compareLowHands, 7 cards from a few-rank pool', () => {
    expect(mismatches(3100, 7, FEW, low8Engine, low8Value, FEW_RANKS)).toEqual({ bad: 0, example: '' });
  }, 60000);

  test('deuce7Value == -compare27Hands(evaluate27LowHand), 5 cards', () => {
    expect(mismatches(4005, 5, PAIRS, deuce7Engine, deuce7Value)).toEqual({ bad: 0, example: '' });
  }, 60000);
  test('deuce7Value == -compare27Hands, 5 cards from ranks 2-7 (pairs, straights, flushes)', () => {
    expect(mismatches(4100, 5, FEW, deuce7Engine, deuce7Value, LOW_RANKS)).toEqual({ bad: 0, example: '' });
  }, 60000);

  test('badugiValue == compareBadugiHands(evaluateBadugiHand), 4 cards', () => {
    expect(mismatches(5004, 4, PAIRS, badugiEngine, badugiValue)).toEqual({ bad: 0, example: '' });
  }, 60000);
  test('badugiValue == compareBadugiHands, 4 cards from a few-rank pool', () => {
    expect(mismatches(5100, 4, FEW, badugiEngine, badugiValue, FEW_RANKS)).toEqual({ bad: 0, example: '' });
  }, 60000);
});

describe('B2: the orders 0dc1b96 got wrong are pinned', () => {
  test('2-7: 75432 > 86532 > 97532 > 22345 > 23456 (a straight is worse than a pair)', () => {
    const order = ['7h 5d 4c 3s 2h', '8h 6d 5c 3s 2h', '9h 7d 5c 3s 2h', '2h 2d 3c 4s 5h', '2h 3d 4c 5s 6h'].map(C);
    for (let i = 0; i + 1 < order.length; i++) {
      expect(deuce7Value(order[i])).toBeGreaterThan(deuce7Value(order[i + 1]));
      expect(deuce7Engine(order[i], order[i + 1])).toBeGreaterThan(0);   // the engine agrees
    }
  });

  test('Badugi: A234 rainbow > KQJT badugi > A23 3-card > A234 one suit', () => {
    const order = ['Ah 2d 3c 4s', 'Kh Qd Jc Ts', 'Ah 2d 3c 4c', 'Ah 2h 3h 4h'].map(C);
    for (let i = 0; i + 1 < order.length; i++) {
      expect(badugiValue(order[i])).toBeGreaterThan(badugiValue(order[i + 1]));
      expect(badugiEngine(order[i], order[i + 1])).toBeGreaterThan(0);
    }
  });

  test('Razz: wheel + KK beats 87654 + KQ', () => {
    const wheel = C('Ah 2d 3c 4s 5h Kd Kc'), eight = C('8h 7d 6c 5s 4h Kd Qc');
    expect(razzValue(wheel)).toBeGreaterThan(razzValue(eight));
    expect(razzEngine(wheel, eight)).toBeGreaterThan(0);
  });

  test('Stud 8: A2345 has a low half; a hand with no 8-or-better low has none', () => {
    expect(low8Value(C('Ah 2d 3c 4s 5h Kd Kc'))).toBeGreaterThan(0);
    expect(low8Value(C('Ah 2d 3c Ks Qh Jd Tc'))).toBe(0);
  });
});

describe('SD2: the baked first-round CDF (src/ai/studDrawCdf.ts)', () => {
  const KINDS: StudDrawKind[] = ['stud-hi', 'stud8', 'razz', 'draw-hi', 'deuce7', 'badugi'];
  test.each(KINDS)('%s: 101 non-decreasing quantiles in [0, 1]', (kind) => {
    const q = FIRST_ROUND_CDF[kind];
    expect(q).toHaveLength(101);
    for (let i = 0; i < q.length; i++) {
      expect(q[i]).toBeGreaterThanOrEqual(0);
      expect(q[i]).toBeLessThanOrEqual(1);
      if (i > 0) expect(q[i]).toBeGreaterThanOrEqual(q[i - 1]);
    }
  });
  test('equityToPercentile clamps to [0, 1] and is monotone', () => {
    for (const kind of KINDS) {
      expect(equityToPercentile(kind, 0)).toBe(0);
      expect(equityToPercentile(kind, 1)).toBe(1);
      let prev = -1;
      for (let e = 0; e <= 1.0001; e += 0.01) { const p = equityToPercentile(kind, e); expect(p).toBeGreaterThanOrEqual(prev); prev = p; }
    }
  });
});

describe('first-round percentile bands (heads-up equity vs one random holding, budget 0 = deterministic)', () => {
  /** Stud: mine = 2 down + door card, dead = four other door cards (5-handed). Draw games: the dealt hand. */
  const pct = (kind: StudDrawKind, mine: string, dead = '') =>
    equityToPercentile(kind, firstRoundEquity(kind, C(mine), dead ? C(dead) : [], drawsLeftAt(kind, 'PreFlop'), 0));
  const DOORS = 'Kd 9c 6s 2c';

  test.each<[string, StudDrawKind, string, string]>([
    ['Stud rolled-up aces', 'stud-hi', 'Ah Ad Ac', DOORS],
    ['5CD pat flush', 'draw-hi', 'Kc Tc 7c 4c 3c', ''],
    ['Triple Draw 75432', 'deuce7', '7h 5d 4c 3s 2h', ''],
    ['Badugi A234', 'badugi', 'Ah 2d 3c 4s', ''],
  ])('%s >= 0.97', (_name, kind, mine, dead) => {
    expect(pct(kind, mine, dead)).toBeGreaterThanOrEqual(0.97);
  }, 30000);

  test('Razz A-2-3 >= 0.90', () => {
    expect(pct('razz', 'Ah 2d 3c', DOORS)).toBeGreaterThanOrEqual(0.9);
  }, 30000);

  test('5CD AA-K-7-3 lies in [0.88, 0.95] (measured 0.915)', () => {
    const p = pct('draw-hi', 'Ah Ad Kc 7s 3h');
    expect(p).toBeGreaterThanOrEqual(0.88);
    expect(p).toBeLessThanOrEqual(0.95);
  }, 30000);

  test.each<[string, StudDrawKind, string, string]>([
    ['Stud 2-7-9 offsuit', 'stud-hi', '2h 7d 9s', ''],
    ['5CD 2-4-7-9-J', 'draw-hi', '2h 4d 7c 9s Jh', ''],
  ])('%s <= 0.35', (_name, kind, mine, dead) => {
    expect(pct(kind, mine, dead)).toBeLessThanOrEqual(0.35);
  }, 30000);
});

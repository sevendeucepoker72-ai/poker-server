/**
 * .online bots review 2026-11-04 (equity-variants C1 + C2) — Omaha equity.
 *
 *   B6     5- and 6-card Omaha opponents were modelled with 4 cards: the bots'
 *          equity ran +9 points (5-card) and +16 points (6-card) too high.
 *   Hi-Lo  Omaha Hi-Lo equity was high-only: A-2-3-K holding the nut low on
 *          5-6-8 was valued at 25.0 / 9.7 / 7.5% against 1 / 2 / 3 opponents
 *          (its real pot share is about 62 / 53 / 49%).
 *   B14    (module level) the exact Omaha draw outs, countOmahaDrawOuts.
 *   CPU    the allocation-free fastOmahaEval scorer replaces the engine
 *          evaluator in the simulation loop.
 *
 * Every equity value is computed under a seeded Math.random (the r2AiBots LCG),
 * so no assertion depends on Monte Carlo luck. The engine-evaluator reference
 * runs are slow on a loaded box: every test sets an explicit timeout.
 */
import { Card } from '../src/game/Card';
import { evaluateHand, compareTo, HandRank } from '../src/game/HandEvaluator';
import * as HX from '../src/game/HandEvaluatorExtensions';
import { fastHandScore } from '../src/game/handEquity';
import * as TE from '../src/training/TrainingEngine';
import {
  cardCode, score5, omahaHighScore, omahaLowScore, NO_LOW, boardAllowsLow, countOmahaDrawOuts,
} from '../src/training/fastOmahaEval';
import { OMAHA5_KNOTS, OMAHA6_KNOTS, calibrateOmahaPreflop } from '../src/ai/omahaPreflopCalibration';

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const SU: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] =>
  s.trim() ? s.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] } as Card)) : [];

/** Seeded Math.random (the r2AiBots LCG) around fn. */
function seeded<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  try { return fn(); } finally { Math.random = orig; }
}
/** A local LCG for dealing test hands (never touches Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const DECK: Card[] = [];
for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) DECK.push({ rank: r, suit: s } as Card);
/** n distinct random cards (partial Fisher-Yates on a fresh deck copy). */
function deal(rnd: () => number, n: number): Card[] {
  const d = DECK.slice();
  for (let k = 0; k < n; k++) { const j = k + Math.floor(rnd() * (d.length - k)); const t = d[k]; d[k] = d[j]; d[j] = t; }
  return d.slice(0, n);
}
const codes = (cards: Card[]) => cards.map(cardCode);
const s5 = (h: Card[]) => score5(cardCode(h[0]), cardCode(h[1]), cardCode(h[2]), cardCode(h[3]), cardCode(h[4]));

describe('C1 — score5 is fastHandScore\'s encoding, and orders hands like the engine', () => {
  it('score5 === handEquity.fastHandScore on 200,000 seeded hands plus every straight flush, quads, full house, flush and straight', () => {
    const rnd = lcg(5001);
    let mismatches = 0;
    for (let i = 0; i < 200000; i++) {
      const h = deal(rnd, 5);
      if (s5(h) !== fastHandScore(h)) mismatches++;
    }
    const edge: Card[][] = [];
    for (let suit = 0; suit < 4; suit++) {
      edge.push([14, 2, 3, 4, 5].map((rank) => ({ rank, suit } as Card)));                       // the A-5 wheels
      for (let hi = 6; hi <= 14; hi++) edge.push([0, 1, 2, 3, 4].map((k) => ({ rank: hi - k, suit } as Card))); // royals included
    }
    expect(edge).toHaveLength(40);
    for (let a = 2; a <= 14; a++) for (let b = 2; b <= 14; b++) {
      if (a === b) continue;
      edge.push([0, 1, 2, 3].map((suit) => ({ rank: a, suit } as Card)).concat([{ rank: b, suit: 0 } as Card])); // quads
      edge.push([{ rank: a, suit: 0 }, { rank: a, suit: 1 }, { rank: a, suit: 2 }, { rank: b, suit: 0 }, { rank: b, suit: 3 }] as Card[]); // full house
    }
    for (let hi = 5; hi <= 14; hi++) {
      const ranks = hi === 5 ? [14, 2, 3, 4, 5] : [0, 1, 2, 3, 4].map((k) => hi - k);
      edge.push(ranks.map((rank, i) => ({ rank, suit: i % 2 } as Card)));                            // straights (no flush)
    }
    for (let mask = 0; mask < 1 << 13; mask++) {
      let bits = 0; for (let m = mask; m; m &= m - 1) bits++;
      if (bits !== 5) continue;
      const ranks: number[] = []; for (let r = 0; r < 13; r++) if (mask & (1 << r)) ranks.push(r + 2);
      edge.push(ranks.map((rank) => ({ rank, suit: 2 } as Card)));                                    // every flush / straight flush in one suit
    }
    for (const h of edge) if (s5(h) !== fastHandScore(h)) mismatches++;
    expect(mismatches).toBe(0);
    // The royal flush is the 14-high straight flush, as in fastHandScore.
    expect(s5(cs('Ah Kh Qh Jh Th'))).toBe(8 * 16 ** 5 + 14 * 16 ** 4);
  }, 120_000);

  it('sign(score5 difference) === sign(compareTo(evaluateHand)) on 50,000 seeded pairs', () => {
    const rnd = lcg(5002);
    let mismatches = 0;
    for (let i = 0; i < 50000; i++) {
      const ten = deal(rnd, 10);
      const a = ten.slice(0, 5), b = ten.slice(5);
      if (Math.sign(s5(a) - s5(b)) !== Math.sign(compareTo(evaluateHand(a), evaluateHand(b)))) mismatches++;
    }
    expect(mismatches).toBe(0);
  }, 120_000);
});

describe('C1 — omahaHighScore / omahaLowScore match the engine\'s Omaha evaluators', () => {
  it.each([4, 5, 6])('%i-card holes: high and low order equal evaluateOmahaHand / evaluateOmahaLowHand over 5,000 seeded pairs', (hn) => {
    const rnd = lcg(6000 + hn);
    let hiBad = 0, loBad = 0, nullBad = 0, deadBoardLow = 0;
    for (let i = 0; i < 5000; i++) {
      const cards = deal(rnd, 2 * hn + 5);
      const A = cards.slice(0, hn), B = cards.slice(hn, 2 * hn), board = cards.slice(2 * hn);
      const bc = codes(board);
      const hA = omahaHighScore(codes(A), hn, bc), hB = omahaHighScore(codes(B), hn, bc);
      if (Math.sign(hA - hB) !== Math.sign(compareTo(HX.evaluateOmahaHand(A, board), HX.evaluateOmahaHand(B, board)))) hiBad++;
      const lA = omahaLowScore(codes(A), hn, bc), lB = omahaLowScore(codes(B), hn, bc);
      const eA = HX.evaluateOmahaLowHand(A, board), eB = HX.evaluateOmahaLowHand(B, board);
      if ((eA === null) !== (lA === NO_LOW) || (eB === null) !== (lB === NO_LOW)) nullBad++;
      if (Math.sign(lA - lB) !== Math.sign(HX.compareLowHands(eA, eB))) loBad++;
      if (!boardAllowsLow(bc) && (eA !== null || eB !== null)) deadBoardLow++;
    }
    expect({ hiBad, loBad, nullBad, deadBoardLow }).toEqual({ hiBad: 0, loBad: 0, nullBad: 0, deadBoardLow: 0 });
  }, 180_000);

  it('flop and turn boards (bn = 3 and 4): omahaHighScore orders like evaluateOmahaHand', () => {
    const rnd = lcg(6100);
    let bad = 0;
    for (const hn of [4, 5, 6]) for (const bn of [3, 4]) for (let i = 0; i < 400; i++) {
      const cards = deal(rnd, 2 * hn + bn);
      const A = cards.slice(0, hn), B = cards.slice(hn, 2 * hn), board = cards.slice(2 * hn);
      const d = omahaHighScore(codes(A), hn, codes(board), bn) - omahaHighScore(codes(B), hn, codes(board), bn);
      if (Math.sign(d) !== Math.sign(compareTo(HX.evaluateOmahaHand(A, board), HX.evaluateOmahaHand(B, board)))) bad++;
    }
    expect(bad).toBe(0);
  }, 120_000);
});

describe('C1 / B14 — countOmahaDrawOuts is an exact count', () => {
  /** Brute force over the engine: unseen cards (deck - own hole - board) that make a straight or better draw category above the current one. */
  function bruteOuts(hole: Card[], board: Card[]): number {
    const DRAW = [HandRank.Straight, HandRank.Flush, HandRank.StraightFlush, HandRank.RoyalFlush];
    const now = HX.evaluateOmahaHand(hole, board).handRank;
    const seen = new Set([...hole, ...board].map((c) => `${c.rank}_${c.suit}`));
    let outs = 0;
    for (const c of DECK) {
      if (seen.has(`${c.rank}_${c.suit}`)) continue;
      const r = HX.evaluateOmahaHand(hole, [...board, c]).handRank;
      if (DRAW.includes(r) && r > now) outs++;
    }
    return outs;
  }

  it('equals an engine brute force on seeded flops and turns for 4-, 5- and 6-card holes', () => {
    const rnd = lcg(7000);
    let bad = 0, spots = 0;
    for (const hn of [4, 5, 6]) for (const bn of [3, 4]) for (let i = 0; i < (bn === 3 ? 60 : 30); i++) {
      const cards = deal(rnd, hn + bn);
      const hole = cards.slice(0, hn), board = cards.slice(hn);
      spots++;
      if (countOmahaDrawOuts(hole, board) !== bruteOuts(hole, board)) bad++;
    }
    expect(spots).toBe(270);
    expect(bad).toBe(0);
  }, 180_000);

  it('named spots: no Hold\'em overcard or 4-suited inflation; a straight flush to royal counts; 0 off the flop/turn', () => {
    expect(countOmahaDrawOuts(cs('Ah Kh Qh Jh'), cs('2s 7c 9d'))).toBe(0);      // Hold'em-style counting gave 27
    expect(countOmahaDrawOuts(cs('Ah Kd Qs Jh 9c 8d'), cs('2s 3c 4d'))).toBe(0); // 26
    expect(countOmahaDrawOuts(cs('Ah Kh 7h 6h'), cs('Qh Jh 2c'))).toBe(10);
    // A J-high straight flush now (9h 8h + Th Jh 7h); the Qh gives Ah Kh + Qh Jh Th, a royal.
    const sfHole = cs('9h 8h Ah Kh'), sfBoard = cs('Th Jh 7h');
    expect(countOmahaDrawOuts(sfHole, sfBoard)).toBe(bruteOuts(sfHole, sfBoard));
    expect(countOmahaDrawOuts(sfHole, sfBoard)).toBeGreaterThan(0);
    expect(countOmahaDrawOuts(cs('Ah Kh 7h 6h'), [])).toBe(0);
    expect(countOmahaDrawOuts(cs('Ah Kh 7h 6h'), cs('Qh Jh 2c 3d 4s'))).toBe(0);
  }, 60_000);
});

/** Test-local reference: the engine evaluators, consuming Math.random exactly like calculateEquity. */
function referenceEquity(hole: Card[], board: Card[], opps: number, hiLo: boolean): number {
  const key = (c: Card) => `${c.rank}_${c.suit}`;
  const known = new Set([...hole, ...board].map(key));
  const rem: Card[] = DECK.filter((c) => !known.has(key(c)));          // buildFullDeck order
  const per = Math.max(4, hole.length);
  const need = 5 - board.length + opps * per;
  let sims = 0, wins = 0, ties = 0, share = 0;
  for (let sim = 0; sim < 500; sim++) {
    for (let i = rem.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rem[i], rem[j]] = [rem[j], rem[i]]; }
    if (rem.length < need) break;
    sims++;
    let idx = 0;
    const b = [...board];
    while (b.length < 5) b.push(rem[idx++]);
    const oh: Card[][] = [];
    for (let o = 0; o < opps; o++) { oh.push(rem.slice(idx, idx + per)); idx += per; }
    if (!hiLo) {
      const me = HX.evaluateOmahaHand(hole, b);
      let win = true, tie = false;
      for (const h of oh) {
        const c = compareTo(me, HX.evaluateOmahaHand(h, b));
        if (c < 0) { win = false; tie = false; break; }
        if (c === 0) tie = true;
      }
      if (win && !tie) wins++; else if (win && tie) ties++;
    } else {
      const all = [hole, ...oh].map((h) => HX.evaluateOmahaHiLo(h, b));
      let bestHi = all[0].high;
      for (const r of all) if (compareTo(r.high, bestHi) > 0) bestHi = r.high;
      const nHi = all.filter((r) => compareTo(r.high, bestHi) === 0).length;
      let bestLo: any = null;
      for (const r of all) if (r.low !== null && (bestLo === null || HX.compareLowHands(r.low, bestLo) < 0)) bestLo = r.low;
      const nLo = bestLo ? all.filter((r) => r.low !== null && HX.compareLowHands(r.low, bestLo) === 0).length : 0;
      const heroHi = compareTo(all[0].high, bestHi) === 0 ? 1 / nHi : 0;
      const heroLo = bestLo !== null && all[0].low !== null && HX.compareLowHands(all[0].low, bestLo) === 0;
      share += bestLo === null ? heroHi : 0.5 * heroHi + (heroLo ? 0.5 / nLo : 0);
    }
  }
  if (sims === 0) return 50;
  const equity = hiLo ? (share / sims) * 100 : ((wins + ties / 2) / sims) * 100;
  return Math.round(equity * 10) / 10;
}

describe('C2 — calculateEquity\'s Omaha path equals an engine-evaluator reference (B6 + Hi-Lo)', () => {
  const HANDS: Record<number, string> = { 4: 'Ah 2d 3c Ks', 5: 'Ah 2d 3c Ks Qh', 6: 'Ah 2d 3c Ks Qh 9d' };
  const BOARDS = ['', '5h 6c Jd', '5h 6c Jd 8s'];
  // 3 hands x 3 boards x 3 opponent counts x 2 modes = 54 spots; every hi-lo spot can make a low.
  it.each([4, 5, 6])('%i-card hero: 18 seeded spots equal the reference exactly', (n) => {
    const out: string[] = [];
    for (const bd of BOARDS) for (const o of [1, 3, 5]) for (const hiLo of [false, true]) {
      const seed = n * 1000 + bd.length * 10 + o + (hiLo ? 7 : 0);
      const ref = seeded(seed, () => referenceEquity(cs(HANDS[n]), cs(bd), o, hiLo));
      const got = seeded(seed, () => TE.calculateEquity(cs(HANDS[n]), cs(bd), o, true, 0, false, 0, hiLo));
      if (got !== ref) out.push(`${n}c/${bd || 'preflop'}/${o}opp/${hiLo ? 'hilo' : 'hi'}: got ${got}, reference ${ref}`);
    }
    expect(out).toEqual([]);
  }, 240_000);

  it('B6: AhKdQsJh9c8d on Kh7c2s against 3 opponents is 23-38% (truth 30.1-30.7; 4-card opponents gave 51-52)', () => {
    const eq = seeded(4242, () => TE.calculateEquity(cs('Ah Kd Qs Jh 9c 8d'), cs('Kh 7c 2s'), 3, true));
    expect(eq).toBeGreaterThanOrEqual(23);
    expect(eq).toBeLessThanOrEqual(38);
  }, 60_000);

  it('Hi-Lo: Ah2d3cKs on 5h6c8d (nut low) is its pot share against 1 / 2 / 3 opponents (high-only gave 25.0 / 9.7 / 7.5)', () => {
    const expected: Record<number, number> = { 1: 62.0, 2: 53.3, 3: 49.0 };
    for (const n of [1, 2, 3]) {
      const eq = seeded(900 + n, () => TE.calculateEquity(cs('Ah 2d 3c Ks'), cs('5h 6c 8d'), n, true, 0, false, 0, true));
      expect(Math.abs(eq - expected[n])).toBeLessThanOrEqual(4);
    }
    // High-only is unchanged by the new parameter's default.
    const hiOnly = seeded(901, () => TE.calculateEquity(cs('Ah 2d 3c Ks'), cs('5h 6c 8d'), 1, true));
    expect(hiOnly).toBeLessThan(40);
  }, 60_000);

  it('Hi-Lo: AsAdKhKc on Qs7d2c (no low possible for it) against 2 is 25-38% (truth 31-33; high-only gave 45.8)', () => {
    const eq = seeded(77, () => TE.calculateEquity(cs('As Ad Kh Kc'), cs('Qs 7d 2c'), 2, true, 0, false, 0, true));
    expect(eq).toBeGreaterThanOrEqual(25);
    expect(eq).toBeLessThanOrEqual(38);
  }, 60_000);

  it('CPU: the Omaha path never calls the engine\'s Omaha evaluators (it made 500 x (1 + opponents) calls)', () => {
    const spies = [
      jest.spyOn(HX, 'evaluateOmahaHand'),
      jest.spyOn(HX, 'evaluateOmahaHiLo'),
      jest.spyOn(HX, 'evaluateOmahaLowHand'),
    ];
    try {
      seeded(31, () => TE.calculateEquity(cs('Ah 2d 3c Ks 9h'), cs('5h 6c 8d'), 3, true));
      seeded(32, () => TE.calculateEquity(cs('Ah 2d 3c Ks'), cs('5h 6c 8d'), 2, true, 0, false, 0, true));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { for (const s of spies) s.mockRestore(); }
  }, 60_000);

  it('GUARD (passes before and after): the time budget stops a 6-card hero against 5 opponents after the minimum simulations, measured in work', () => {
    const BUDGET_MS = 40; // AIPlayer.BOT_EQUITY_BUDGET_MS
    const hole = cs('Ah Kh Qd Jc Ts 9d');
    const board = cs('2h 7d 9c');
    const draws = (maxMs: number, clockJump: number) => {
      const origRandom = Math.random;
      let n = 0;
      Math.random = () => { n++; return origRandom(); };
      let calls = 0;
      const realNow = Date.now;
      const base = realNow();
      Date.now = () => base + (calls++ === 0 ? 0 : clockJump); // every read after the first is "past the deadline"
      try { TE.calculateEquity(hole, board, 5, true, 0, false, maxMs); } finally { Math.random = origRandom; Date.now = realNow; }
      return n;
    };
    const unbudgeted = draws(0, 0);
    const budgeted = draws(BUDGET_MS, BUDGET_MS * 10);
    const inTime = draws(BUDGET_MS, 0);
    expect(unbudgeted).toBe(500 * (52 - 9 - 1));   // all 500 simulations dealt (6 + 5 * 6 + 5 = 41 cards fit)
    expect(budgeted * 5).toBeLessThan(unbudgeted); // 64 of 500 simulations
    expect(inTime).toBe(unbudgeted);               // a spot that finishes inside the budget runs all 500
  }, 60_000);
});

describe('C2(g) — the coach passes Hi-Lo through to the equity', () => {
  it('getFullTrainingData(..., isOmaha, isHiLo = true) shows the nut low\'s pot share (about 62%, not the high-only 25%)', () => {
    const hole = cs('Ah 2d 3c Ks'), board = cs('5h 6c 8d');
    const hiLo = seeded(61, () => TE.getFullTrainingData(hole, board, 1, 0, 300, 5000, 'flop', true, true));
    const hiOnly = seeded(61, () => TE.getFullTrainingData(hole, board, 1, 0, 300, 5000, 'flop', true));
    expect(Math.abs(hiLo.equity - 62)).toBeLessThanOrEqual(5);
    expect(hiOnly.equity).toBeLessThan(40);
    expect(hiLo.equity).toBe(seeded(61, () => TE.calculateEquity(hole, board, 1, true, 0, false, 0, true)));
  }, 60_000);
});

describe('C6 — the 5/6-card Omaha pre-flop knots', () => {
  it.each([[5, OMAHA5_KNOTS], [6, OMAHA6_KNOTS]] as const)('%i-card knots: x strictly increasing, y non-decreasing, ending at 1', (_n, kn) => {
    for (let i = 1; i < kn.length; i++) {
      expect(kn[i][0]).toBeGreaterThan(kn[i - 1][0]);
      expect(kn[i][1]).toBeGreaterThanOrEqual(kn[i - 1][1]);
    }
    expect(kn[0]).toEqual([0.261, 0.307]);
    expect(kn[kn.length - 1][1]).toBe(1);
    expect(kn.filter((k) => k[1] >= 1)).toHaveLength(1);
  }, 60_000);

  it('calibrateOmahaPreflop interpolates, clamps to the end knots, picks the table by card count, and is monotone', () => {
    expect(calibrateOmahaPreflop(5, NaN)).toBeNaN();
    expect(calibrateOmahaPreflop(6, Infinity)).toBeNaN();
    expect(calibrateOmahaPreflop(5, 0)).toBe(0.307);
    expect(calibrateOmahaPreflop(5, 5)).toBe(1);
    expect(calibrateOmahaPreflop(6, 1.1629)).toBe(1);
    for (const [x, y] of OMAHA5_KNOTS) expect(calibrateOmahaPreflop(5, x)).toBeCloseTo(y, 12);
    for (const [x, y] of OMAHA6_KNOTS) expect(calibrateOmahaPreflop(6, x)).toBeCloseTo(y, 12);
    expect(calibrateOmahaPreflop(5, 0.4105)).toBeCloseTo(0.399 + (0.445 - 0.399) * (0.4105 - 0.399) / (0.422 - 0.399), 12);
    expect(calibrateOmahaPreflop(6, 0.4105)).toBeCloseTo(0.422, 12);
    expect(calibrateOmahaPreflop(7, 0.4105)).toBe(calibrateOmahaPreflop(6, 0.4105));
    for (const n of [5, 6]) {
      let prev = -1;
      for (let u = 0.2; u <= 1.25; u += 0.0005) {
        const v = calibrateOmahaPreflop(n, u);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  }, 60_000);
});

/**
 * .online bots review 2026-11-04 (equity-variants C5 + C2, finding B13) —
 * Short Deck (6+ Hold'em) pre-flop table and equity.
 *
 * Before: Short Deck pre-flop read the FULL-deck Hold'em percentile (28-32% of
 * combos cleared the early-position open threshold, 69-73% the button's), and
 * calculateEquity compared hands with a private helper that swapped only flush
 * and full house — the engine also ranks trips above a straight — so a set of
 * kings on K-Q-J against 2 opponents read 73% (the engine's value is 98%),
 * and its range sampler read the full-deck table.
 *
 * Every equity value is computed under a seeded Math.random. Explicit timeouts.
 */
import { Card } from '../src/game/Card';
import { compareTo } from '../src/game/HandEvaluator';
import { evaluateShortDeckHand } from '../src/game/HandEvaluatorExtensions';
import { handCodeFrom } from '../src/ai/preflopRanges';
import {
  SHORT_DECK_PREFLOP_PCTILE, getShortDeckPreflopPercentile, shortDeckPercentileByRanks,
} from '../src/ai/shortDeckPreflop';
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
const combosOf = (code: string) => (code.length === 2 ? 6 : code.endsWith('s') ? 4 : 12);

describe('C5 — the committed Short Deck pre-flop table', () => {
  it('has exactly the 81 short-deck classes (630 combos) and a sane order', () => {
    const want = new Set<string>();
    for (let hi = 6; hi <= 14; hi++) for (let lo = 6; lo <= hi; lo++) {
      if (hi === lo) want.add(handCodeFrom(hi, lo, false));
      else { want.add(handCodeFrom(hi, lo, true)); want.add(handCodeFrom(hi, lo, false)); }
    }
    const codes = Object.keys(SHORT_DECK_PREFLOP_PCTILE);
    expect(codes).toHaveLength(81);
    expect(new Set(codes)).toEqual(want);
    expect(codes.reduce((s, c) => s + combosOf(c), 0)).toBe(630);
    const T = SHORT_DECK_PREFLOP_PCTILE;
    expect(Math.max(...Object.values(T))).toBe(T.AA);
    const pairs = ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66'];
    for (let i = 1; i < pairs.length; i++) expect(T[pairs[i - 1]]).toBeGreaterThan(T[pairs[i]]);
    let suitedPairs = 0;
    for (let hi = 7; hi <= 14; hi++) for (let lo = 6; lo < hi; lo++) {
      expect(T[handCodeFrom(hi, lo, true)]).toBeGreaterThan(T[handCodeFrom(hi, lo, false)]);
      suitedPairs++;
    }
    expect(suitedPairs).toBe(36);
    for (const v of Object.values(T)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
  }, 60_000);

  it('option (a): the shared thresholds clear Hold\'em-sized shares (0.85 → 14.5-16.0%, 0.55 → 43-46%; the full-deck table gave 28-32% and 69-73%)', () => {
    const share = (th: number) =>
      (100 * Object.entries(SHORT_DECK_PREFLOP_PCTILE).filter(([, v]) => v >= th).reduce((s, [c]) => s + combosOf(c), 0)) / 630;
    expect(share(0.85)).toBeGreaterThanOrEqual(14.5);
    expect(share(0.85)).toBeLessThanOrEqual(16.0);
    expect(share(0.55)).toBeGreaterThanOrEqual(43);
    expect(share(0.55)).toBeLessThanOrEqual(46);
  }, 60_000);

  it('lookups: by hole cards and by ranks agree; unknown hands are 0', () => {
    expect(getShortDeckPreflopPercentile(cs('Ah As'))).toBe(SHORT_DECK_PREFLOP_PCTILE.AA);
    expect(getShortDeckPreflopPercentile(cs('7c 6d'))).toBe(SHORT_DECK_PREFLOP_PCTILE['76o']);
    expect(getShortDeckPreflopPercentile(cs('Kh Qh'))).toBe(shortDeckPercentileByRanks(12, 13, true));
    expect(shortDeckPercentileByRanks(14, 9, false)).toBe(SHORT_DECK_PREFLOP_PCTILE.A9o);
    expect(getShortDeckPreflopPercentile(cs('Ah 5d'))).toBe(0); // no 5 in a short deck
    expect(getShortDeckPreflopPercentile(cs('Ah'))).toBe(0);
    expect(getShortDeckPreflopPercentile([])).toBe(0);
  }, 60_000);
});

/** Test-local reference: the 36-card deck, the engine's evaluateShortDeckHand + compareTo, and the
 * range sampler on the Short Deck table, consuming Math.random exactly like calculateEquity. */
function referenceShortDeck(hole: Card[], board: Card[], opps: number, oppMinPctile: number): number {
  const key = (c: Card) => `${c.rank}_${c.suit}`;
  const known = new Set([...hole, ...board].map(key));
  const rem: Card[] = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) if (r >= 6 && !known.has(`${r}_${s}`)) rem.push({ rank: r, suit: s } as Card);
  const need = 5 - board.length + opps * 2;
  let sims = 0, wins = 0, ties = 0;
  for (let sim = 0; sim < 500; sim++) {
    for (let i = rem.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rem[i], rem[j]] = [rem[j], rem[i]]; }
    if (rem.length < need) break;
    sims++;
    let idx = 0;
    const b = [...board];
    while (b.length < 5) b.push(rem[idx++]);
    const me = evaluateShortDeckHand([...hole, ...b]);
    let win = true, tie = false;
    for (let o = 0; o < opps; o++) {
      if (oppMinPctile > 0) {
        const len = rem.length;
        let ok = false;
        for (let t = 0; t < 32; t++) {
          const i = idx + Math.floor(Math.random() * (len - idx));
          [rem[idx], rem[i]] = [rem[i], rem[idx]];
          const j = (idx + 1) + Math.floor(Math.random() * (len - idx - 1));
          [rem[idx + 1], rem[j]] = [rem[j], rem[idx + 1]];
          if (shortDeckPercentileByRanks(rem[idx].rank, rem[idx + 1].rank, rem[idx].suit === rem[idx + 1].suit) >= oppMinPctile) { ok = true; break; }
        }
        if (!ok) {
          let hi1 = idx, hi2 = idx + 1;
          if (rem[hi2].rank > rem[hi1].rank) { const s = hi1; hi1 = hi2; hi2 = s; }
          for (let k = idx + 2; k < len; k++) {
            if (rem[k].rank > rem[hi1].rank) { hi2 = hi1; hi1 = k; } else if (rem[k].rank > rem[hi2].rank) hi2 = k;
          }
          const a = rem[idx]; rem[idx] = rem[hi1]; rem[hi1] = a;
          if (hi2 === idx) hi2 = hi1;
          const c = rem[idx + 1]; rem[idx + 1] = rem[hi2]; rem[hi2] = c;
        }
      }
      const opp = [rem[idx++], rem[idx++]];
      const cmp = compareTo(me, evaluateShortDeckHand([...opp, ...b]));
      if (cmp < 0) { win = false; tie = false; break; }
      if (cmp === 0) tie = true;
    }
    if (win && !tie) wins++; else if (win && tie) ties++;
  }
  if (sims === 0) return 50;
  return Math.round(((wins + ties / 2) / sims) * 100 * 10) / 10;
}

describe('C2 — Short Deck equity uses the engine\'s Short Deck evaluator and table', () => {
  const SPOTS: [string, string, number][] = [
    ['Kh Kd', 'Ks Qd Jc', 2], ['7h 7d', '7s 8d 9c', 1], ['Jh Td', 'Qs 9d 8c', 3], ['Ah 6d', '7s 8d 9c', 1],
    ['Ah Kh', 'Qh 9h 6h', 2], ['Qs Qd', 'Qh 9c 9s', 2], ['As Ks', '', 2], ['9c 9d', '', 3],
    ['Th 9h', 'Jh 8c 6d 7s', 2], ['Ad Kc', 'Ah 7c 7d Jh', 1],
  ];
  it.each([0, 0.62, 0.8])('10 seeded spots at oppMinPctile %p equal the engine-evaluator reference exactly', (opp) => {
    const out: string[] = [];
    SPOTS.forEach(([h, b, n], k) => {
      const seed = 3100 + k * 7 + Math.round(opp * 100);
      const ref = seeded(seed, () => referenceShortDeck(cs(h), cs(b), n, opp));
      const got = seeded(seed, () => TE.calculateEquity(cs(h), cs(b), n, false, opp, true, 0));
      if (got !== ref) out.push(`${h} | ${b || 'preflop'} vs ${n} @${opp}: got ${got}, reference ${ref}`);
    });
    expect(out).toEqual([]);
  }, 180_000);

  it('spot values: a set beats a straight, a set of kings on K-Q-J is near-certain, a straight on Q-9-8 is not', () => {
    const kk = seeded(11, () => TE.calculateEquity(cs('Kh Kd'), cs('Ks Qd Jc'), 2, false, 0, true));
    const sevens = seeded(12, () => TE.calculateEquity(cs('7h 7d'), cs('7s 8d 9c'), 1, false, 0, true));
    const jt = seeded(13, () => TE.calculateEquity(cs('Jh Td'), cs('Qs 9d 8c'), 3, false, 0, true));
    expect(kk).toBeGreaterThanOrEqual(93);      // engine Monte Carlo 98.4; the old helper gave 73.1
    expect(sevens).toBeGreaterThanOrEqual(90);  // 95.2; was 73.3
    expect(jt).toBeLessThanOrEqual(64);         // 57.8; was 71.5
  }, 60_000);
});

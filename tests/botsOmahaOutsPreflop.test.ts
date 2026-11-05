/**
 * tests/botsOmahaOutsPreflop.test.ts (2026-11 bots review, equity-variants C4 / C8 wired
 * into AIPlayer; ai-core lane).
 *
 *   B14  the bots' outs counter pooled all 4-6 Omaha hole cards (a mean of 5.9 / 7.7 /
 *        9.4 outs against 2.9 / 3.9 / 5.0 true): countOuts(..., omaha = true) now counts
 *        exactly 2 hole + 3 board cards (countOmahaDrawOuts).
 *   C6   5- and 6-card Omaha pre-flop strengths are calibrated onto the 4-card scale.
 *   C8   Stud / draw never count community-card outs (an 8-handed Stud run-out card
 *        made a dead 4-flush look like a live draw on 7th street).
 *
 * Hold'em countOuts (omaha = false) is pinned to the holdem-preflop C11 values (a gutshot
 * is 4 outs; the overcard term is unchanged). Every case fails on 0dc1b96 except the
 * Hold'em pins that C11 did not move and the 4-card pre-flop pins (GUARDS, marked).
 */
import { Card } from '../src/game/Card';
import { HandRank } from '../src/game/HandEvaluator';
import * as HX from '../src/game/HandEvaluatorExtensions';
import { GamePhase, PlayerAction } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { countOuts, getOmahaPreflopStrength, decideAction } from '../src/ai/AIPlayer';
import { OMAHA5_KNOTS, OMAHA6_KNOTS } from '../src/ai/omahaPreflopCalibration';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const SU: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] =>
  s.trim() ? s.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] } as Card)) : [];
/** A local LCG for dealing test hands (never touches Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const DECK: Card[] = [];
for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) DECK.push({ rank: r, suit: s } as Card);
function deal(rnd: () => number, n: number): Card[] {
  const d = DECK.slice();
  for (let k = 0; k < n; k++) { const j = k + Math.floor(rnd() * (d.length - k)); const t = d[k]; d[k] = d[j]; d[j] = t; }
  return d.slice(0, n);
}
/**
 * Deterministic environment: seeded Math.random, a frozen clock (every budgeted Monte Carlo
 * runs its full simulation count) and a deterministic crypto.randomBytes (the deck's own
 * seeded shuffle repeats exactly).
 */
function detEnv<T>(seed: number, fn: () => T): T {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`det-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  try { return fn(); } finally { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; }
}
const prof = (archetype: string) =>
  ({ botName: 'B', difficulty: 'hard', personality: 'tight', archetype, vpip: 0.22, pfr: 0.18, aggressionFactor: 2.75, bluffFrequency: 0.15 } as any);

describe('B14 (1) — countOuts(..., omaha = true) on named spots', () => {
  it.each([
    ['Ah Kh Qh Jh', '2s 7c 9d', 0],            // 0dc1b96: 27
    ['Ah Kd Qs Jh 9c 8d', '2s 3c 4d', 0],      // 26
    ['Ah Kh 7h 6h', 'Qh Jh 2c', 10],           // 8
    ['Ah Kh Qh 2c', 'Jh 5d 4s', 4],            // 24
    ['9h 8c 6d 5s', '7h 4c Kd', 13],           // 8
    ['Ah 2h 3c 4d', '5h 6h Kd Qc', 19],        // 15
  ] as const)('%s on %s = %i outs', (h, b, n) => {
    expect(countOuts(cs(h), cs(b), true)).toBe(n);
  });
});

describe('B14 (2) — countOuts(..., omaha = true) equals an engine brute force', () => {
  /** Unseen cards (deck - own hole - board) that make a straight-or-better draw category above the current one, by evaluateOmahaHand. */
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
  it.each([4, 5, 6])('%i-card holes: 400 seeded flops and 200 seeded turns, 100%% equal', (hn) => {
    const rnd = lcg(8100 + hn);
    let bad = 0, spots = 0;
    for (const bn of [3, 4]) for (let i = 0; i < (bn === 3 ? 400 : 200); i++) {
      const cards = deal(rnd, hn + bn);
      const hole = cards.slice(0, hn), board = cards.slice(hn);
      spots++;
      if (countOuts(hole, board, true) !== bruteOuts(hole, board)) bad++;
    }
    expect(spots).toBe(600);
    expect(bad).toBe(0);
  }, 300_000);
});

describe('B14 (3) — Hold\'em countOuts (omaha = false), pinned to the holdem-preflop C11 values', () => {
  it.each([
    ['9h 8c', 'Jd 7s 2c', 4],     // gutshot (0dc1b96: 8)
    ['Qh Jh', 'As Kd 4s', 4],     // gutshot (0dc1b96: 8)
    ['Ah Kh', '2h 7h 9c', 15],    // GUARD: flush draw + two overcards (unchanged)
    ['7c 6c', '8c 9d Kh', 8],     // GUARD: open-ender (unchanged)
    ['As Ks', 'Qd Jc 2h 3s', 10], // gutshot + two overcards (0dc1b96: 14)
    ['5d 5c', 'Ks 8h 2d', 0],     // GUARD: no draw (unchanged)
  ] as const)('%s on %s = %i outs', (h, b, n) => {
    expect(countOuts(cs(h), cs(b))).toBe(n);
    expect(countOuts(cs(h), cs(b), false)).toBe(n);
  });
});

describe('B14 (4) — wiring: a 4-card Omaha bot with no draw is not kept in by phantom outs', () => {
  it('AhKhQhJh on 2s7c9d, 4-handed, facing a half-pot bet: TAG calls <= 10% and folds >= 70% (0dc1b96 called 100%)', () => {
    const tally: Record<string, number> = {};
    const N = 200;
    for (let i = 0; i < N; i++) {
      const d = detEnv(6000 + i, () => {
        const t = new OmahaTable({ tableId: 'o', tableName: 'o', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 } as any, false, 4);
        for (let s = 0; s < 4; s++) t.sitDown(s, 'B' + s, 10000, 'ai-o' + s, true);
        t.startNewHand();
        let g = 0;
        while (t.currentPhase === GamePhase.PreFlop && g++ < 40) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
        expect(t.currentPhase).toBe(GamePhase.Flop);
        t.communityCards = cs('2s 7c 9d');
        const bettor = t.activeSeatIndex;
        expect(t.playerRaise(bettor, Math.round(t.getTotalPot() * 0.5 / 100) * 100)).toBe(true);
        const me = t.activeSeatIndex;
        t.seats[me].holeCards = cs('Ah Kh Qh Jh');
        return decideAction(t, me, prof('TAG'));
      });
      tally[d.action] = (tally[d.action] || 0) + 1;
    }
    expect(tally[PlayerAction.Call] || 0).toBeLessThanOrEqual(0.10 * N);
    expect(tally[PlayerAction.Fold] || 0).toBeGreaterThanOrEqual(0.70 * N);
  }, 120_000);
});

describe('C6 (5) — getOmahaPreflopStrength', () => {
  it.each([
    ['As Ad Ks Kd', 1.0],
    ['Ah Kh Qd Jd', 0.9165],
    ['9h 8h 7d 6d', 0.767],
    ['Ks Kh 7c 2d', 0.72757],
    ['7h 2c 9s 4d', 0.4795],
    ['Ah Ad Ac 2s', 0.376],
    ['Jh Th 9h 8h', 0.583],
  ] as const)('GUARD: 4-card %s is unchanged (%d)', (h, v) => {
    expect(getOmahaPreflopStrength(cs(h))).toBeCloseTo(v, 4);
  });
  it.each([5, 6])('%i-card hands clear the shared thresholds as often as 4-card hands (0dc1b96: 12.5 / 16.0% at >= 0.85)', (n) => {
    const rnd = lcg(9100 + n);
    const N = 100_000;
    let a85 = 0, a72 = 0, a55 = 0;
    for (let i = 0; i < N; i++) {
      const v = getOmahaPreflopStrength(deal(rnd, n));
      if (v >= 0.85) a85++;
      if (v >= 0.72) a72++;
      if (v >= 0.55) a55++;
    }
    const pct = (x: number) => (100 * x) / N;
    expect(pct(a85)).toBeGreaterThanOrEqual(5.5); expect(pct(a85)).toBeLessThanOrEqual(7.5);
    expect(pct(a72)).toBeGreaterThanOrEqual(19); expect(pct(a72)).toBeLessThanOrEqual(22.5);
    expect(pct(a55)).toBeGreaterThanOrEqual(66); expect(pct(a55)).toBeLessThanOrEqual(74);
  }, 120_000);
  it('knot tables: x strictly increasing, y non-decreasing', () => {
    for (const kn of [OMAHA5_KNOTS, OMAHA6_KNOTS]) {
      for (let i = 1; i < kn.length; i++) {
        expect(kn[i][0]).toBeGreaterThan(kn[i - 1][0]);
        expect(kn[i][1]).toBeGreaterThanOrEqual(kn[i - 1][1]);
      }
    }
  });
});

describe('C8 (6) — a Stud run-out community card never makes a dead flush draw', () => {
  /** 8 bots call / check to Seventh Street; with all 8 in, the deck runs out and 7th is one shared card. */
  function spot(community: string): { t: SevenStudTable; me: number } | null {
    const t = new SevenStudTable({ tableId: 's', tableName: 's', smallBlind: 50, bigBlind: 100, ante: 10, minBuyIn: 10000 } as any, false, false);
    for (let i = 0; i < 8; i++) t.sitDown(i, 'B' + i, 10000, 'ai-s' + i, true);
    t.startNewHand();
    let g = 0;
    while (t.isHandInProgress() && t.currentPhase !== GamePhase.SeventhStreet && g++ < 200) {
      const a = t.activeSeatIndex; if (a < 0) break;
      if (!t.playerCall(a)) t.playerCheck(a);
    }
    if (t.currentPhase !== GamePhase.SeventhStreet || t.communityCards.length !== 1) return null;
    const bettor = t.activeSeatIndex;
    if (!t.playerRaise(bettor, t.getMinRaise())) return null;
    const me = t.activeSeatIndex;
    if (me < 0 || me === bettor) return null;
    t.seats[me].holeCards = cs('2h 5h 9h 3c 7d Jc');   // no pair, three hearts, J-high
    t.communityCards = cs(community);                  // Kh: a "4-flush" across 7 cards; Ks: none
    return { t, me };
  }
  it.each(['Kh', 'Ks'])('TAG with 2h 5h 9h 3c 7d Jc + %s facing a 7th-street bet never calls (0dc1b96 called 100%% with Kh)', (comm) => {
    let n = 0;
    const tally: Record<string, number> = {};
    for (let k = 0; k < 60; k++) {
      const d = detEnv(500 + k, () => {
        const sp = spot(comm);
        return sp ? decideAction(sp.t, sp.me, prof('TAG')) : null;
      });
      if (!d) continue;
      n++;
      tally[d.action] = (tally[d.action] || 0) + 1;
    }
    expect(n).toBeGreaterThanOrEqual(30);
    expect(tally[PlayerAction.Call] || 0).toBe(0);
  }, 180_000);
});

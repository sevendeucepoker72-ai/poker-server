// OFFLINE preflop push/fold Nash solver (Level-2 blueprint). Computes a 169x169
// all-in equity matrix, then solves the heads-up shove/fold equilibrium by
// fixed-point iteration for a grid of effective stack depths. Prints a table of
// {stackBB: {sbPushPctile, bbCallPctile}} that gets BAKED into ai/pushFoldSolver
// as a runtime lookup (zero online compute). Deleted after use.
import { Card, Suit } from './src/game/Card';
import { evaluateHand, compareTo } from './src/game/HandEvaluator';

const RC: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };
interface HT { code: string; r1: number; r2: number; suited: boolean; combos: number; }
const HANDS: HT[] = [];
for (let hi = 14; hi >= 2; hi--) {
  for (let lo = hi; lo >= 2; lo--) {
    if (hi === lo) HANDS.push({ code: RC[hi] + RC[hi], r1: hi, r2: lo, suited: false, combos: 6 });
    else {
      HANDS.push({ code: RC[hi] + RC[lo] + 's', r1: hi, r2: lo, suited: true, combos: 4 });
      HANDS.push({ code: RC[hi] + RC[lo] + 'o', r1: hi, r2: lo, suited: false, combos: 12 });
    }
  }
}
const N = HANDS.length; // 169

function assign(h: HT, used: Set<string>): Card[] | null {
  const suits = [Suit.Hearts, Suit.Diamonds, Suit.Clubs, Suit.Spades];
  if (h.r1 === h.r2) {
    const avail = suits.filter((s) => !used.has(`${h.r1}_${s}`));
    if (avail.length < 2) return null;
    return [{ rank: h.r1, suit: avail[0] }, { rank: h.r1, suit: avail[1] }];
  }
  if (h.suited) {
    for (const s of suits) if (!used.has(`${h.r1}_${s}`) && !used.has(`${h.r2}_${s}`)) return [{ rank: h.r1, suit: s }, { rank: h.r2, suit: s }];
    return null;
  }
  for (const s1 of suits) {
    if (used.has(`${h.r1}_${s1}`)) continue;
    for (const s2 of suits) { if (s2 === s1) continue; if (!used.has(`${h.r2}_${s2}`)) return [{ rank: h.r1, suit: s1 }, { rank: h.r2, suit: s2 }]; }
  }
  return null;
}
function buildDeck(): Card[] { const d: Card[] = []; for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ suit: s, rank: r }); return d; }

function equity(a: HT, b: HT, sims: number): number {
  const used = new Set<string>();
  const ca = assign(a, used); if (!ca) return 0.5; ca.forEach((c) => used.add(`${c.rank}_${c.suit}`));
  const cb = assign(b, used); if (!cb) return 0.5; cb.forEach((c) => used.add(`${c.rank}_${c.suit}`));
  const deck = buildDeck().filter((c) => !used.has(`${c.rank}_${c.suit}`));
  let win = 0, tie = 0;
  for (let i = 0; i < sims; i++) {
    for (let k = 0; k < 5; k++) { const j = k + Math.floor(Math.random() * (deck.length - k)); const t = deck[k]; deck[k] = deck[j]; deck[j] = t; }
    const board = deck.slice(0, 5);
    const cmp = compareTo(evaluateHand([...ca, ...board]), evaluateHand([...cb, ...board]));
    if (cmp > 0) win++; else if (cmp === 0) tie++;
  }
  return (win + tie / 2) / sims;
}

console.error('Building 169x169 equity matrix...');
const SIMS = 130;
const M: number[][] = Array.from({ length: N }, () => new Array(N).fill(0.5));
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) { const e = equity(HANDS[i], HANDS[j], SIMS); M[i][j] = e; M[j][i] = 1 - e; }
}
console.error('Matrix done. Solving Nash...');

// equity of hand i vs a FREQUENCY-weighted opponent range (combos * freq[j]).
function eqVsFreq(i: number, freq: number[]): number {
  let num = 0, den = 0;
  for (let j = 0; j < N; j++) { const w = HANDS[j].combos * freq[j]; if (w <= 0) continue; num += M[i][j] * w; den += w; }
  return den > 0 ? num / den : 0.5;
}
function fracFreq(freq: number[]): number { let c = 0; for (let j = 0; j < N; j++) c += HANDS[j].combos * freq[j]; return c / 1326; }

// Heads-up push/fold via FICTITIOUS PLAY (best-response oscillates; the
// time-average converges to Nash). SB shoves S or folds (loses 0.5 SB); BB
// calls (pot 2S, wins with equity) or folds (loses 1 BB).
function solve(S: number): { pushFrac: number; callFrac: number; pushAvg: number[]; callAvg: number[] } {
  const pushCnt = new Array<number>(N).fill(0);
  const callCnt = new Array<number>(N).fill(0);
  let pushAvg = HANDS.map(() => 0.5);
  let callAvg = HANDS.map(() => 0.4);
  const callTh = (S - 1) / (2 * S); // BB calls if eq*2S - S > -1  =>  eq > (S-1)/2S
  const T = 500;
  for (let it = 1; it <= T; it++) {
    const pCall = fracFreq(callAvg);
    const sbBR = HANDS.map((_, i) => {
      const eq = eqVsFreq(i, callAvg);
      const evPush = (1 - pCall) * 1 + pCall * (S * (2 * eq - 1));
      return evPush > -0.5 ? 1 : 0;
    });
    const bbBR = HANDS.map((_, i) => (eqVsFreq(i, pushAvg) > callTh ? 1 : 0));
    for (let j = 0; j < N; j++) { pushCnt[j] += sbBR[j]; callCnt[j] += bbBR[j]; }
    pushAvg = pushCnt.map((c) => c / it);
    callAvg = callCnt.map((c) => c / it);
  }
  return { pushFrac: fracFreq(pushAvg), callFrac: fracFreq(callAvg), pushAvg, callAvg };
}

const table: Record<number, { push: number; call: number }> = {};
for (let S = 2; S <= 25; S++) { const r = solve(S); table[S] = { push: +(1 - r.pushFrac).toFixed(3), call: +(1 - r.callFrac).toFixed(3) }; }
console.log('TABLE_JSON=' + JSON.stringify(table));
console.error('\nSanity vs known Nash (SB push% / BB call%):');
for (const S of [5, 8, 10, 12, 15, 20]) { const r = solve(S); console.error(`  ${S}bb: SB push top ${(r.pushFrac * 100).toFixed(0)}%  BB call top ${(r.callFrac * 100).toFixed(0)}%`); }

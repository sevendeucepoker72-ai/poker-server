// OFFLINE generator of the committed Short Deck pre-flop percentile table,
// src/ai/shortDeckPreflop.ts SHORT_DECK_PREFLOP_PCTILE (bots review
// 2026-11-04, equity-variants C5, finding B13). Not compiled, not run by Jest.
//
//   npx ts-node -T gen-short-deck-preflop.ts            prints the table literal
//   VERIFY=1 npx ts-node -T gen-short-deck-preflop.ts   exits 1 unless it equals the committed table
//   SIMS=<n> overrides the 400,000 simulations per class (the committed table uses 400,000)
//
// Same metric and formula as the Hold'em percentile (preflopRanges): heads-up
// equity of each of the 81 classes against one random hand, ranked strongest
// first, percentile = 1 - (running + combos / 2) / total, rounded to 4 places.
// Played under the ENGINE's Short Deck rules: the 36-card deck and
// evaluateShortDeckHand (trips beat a straight, a flush beats a full house,
// A-6-7-8-9 is a straight). Deterministic: class i draws from
// mulberry32(20261104 + i), classes in a fixed order. A fast scorer does the
// work; it is first checked against evaluateShortDeckHand on 40,000 random
// 7-card pairs and the run aborts on any mismatch.
import { evaluateShortDeckHand } from './src/game/HandEvaluatorExtensions';
import { compareTo } from './src/game/HandEvaluator';
import { SHORT_DECK_PREFLOP_PCTILE, shortDeckPercentileByRanks } from './src/ai/shortDeckPreflop';

const SIMS = Number(process.env.SIMS || 400000);
const VERIFY = process.env.VERIFY === '1';

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Short Deck packed score: category * 16^5 + ranks, in the ShortDeckHandRank
// category order (straight 3 < trips 4 < full house 5 < flush 6).
const C5 = 1048576, C4 = 65536, C3 = 4096, C2 = 256, C1 = 16;
const MUL = [1, C1, C2, C3, C4];
const SD_WHEEL = (1 << 14) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9);
const ROYAL = 0b11111 << 10;
const CNT = new Int8Array(15);
function packDesc(mask: number) { let s = 0, k = 4, mm = mask; while (mm) { const hi = 31 - Math.clz32(mm); s += hi * MUL[k--]; mm &= ~(1 << hi); } return s; }
function sdScore5(a: number, b: number, c: number, d: number, e: number): number {
  const ra = a & 15, rb = b & 15, rc = c & 15, rd = d & 15, re = e & 15;
  const mask = (1 << ra) | (1 << rb) | (1 << rc) | (1 << rd) | (1 << re);
  let m = mask, n = 0; while (m) { m &= m - 1; n++; }
  if (n === 5) {
    const flush = (((a ^ b) | (a ^ c) | (a ^ d) | (a ^ e)) >> 4) === 0;
    let sh = 0; if (mask === SD_WHEEL) sh = 9; else { const low = mask & -mask; if (mask === low * 31) sh = 31 - Math.clz32(mask); }
    if (sh) { if (flush) return mask === ROYAL ? 9 * C5 + 14 * C4 : 8 * C5 + sh * C4; return 3 * C5 + sh * C4; }
    return (flush ? 6 * C5 : 0) + packDesc(mask);
  }
  CNT[ra]++; CNT[rb]++; CNT[rc]++; CNT[rd]++; CNT[re]++;
  let quad = 0, trip = 0, pHi = 0, pLo = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let r = 14; r >= 2; r--) { const k = CNT[r]; if (!k) continue; CNT[r] = 0; if (k === 4) quad = r; else if (k === 3) trip = r; else if (k === 2) { if (!pHi) pHi = r; else pLo = r; } else { if (!s1) s1 = r; else if (!s2) s2 = r; else s3 = r; } }
  if (quad) return 7 * C5 + quad * C4 + s1 * C3;
  if (trip && pHi) return 5 * C5 + trip * C4 + pHi * C3;
  if (trip) return 4 * C5 + trip * C4 + s1 * C3 + s2 * C2;
  if (pLo) return 2 * C5 + pHi * C4 + pLo * C3 + s1 * C2;
  return 1 * C5 + pHi * C4 + s1 * C3 + s2 * C2 + s3 * C1;
}
const COMB7: number[][] = [];
for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++) for (let d = c + 1; d < 7; d++) for (let e = d + 1; e < 7; e++) COMB7.push([a, b, c, d, e]);
function sd7(x: number[]) { let best = -1; for (const q of COMB7) { const s = sdScore5(x[q[0]], x[q[1]], x[q[2]], x[q[3]], x[q[4]]); if (s > best) best = s; } return best; }

type C = { rank: number; suit: number };
const deck36: C[] = [];
for (let s = 0; s < 4; s++) for (let r = 6; r <= 14; r++) deck36.push({ rank: r, suit: s });
const code = (c: C) => (c.suit << 4) | c.rank;

// (a) The fast scorer orders 7-card Short Deck hands exactly like the engine.
{
  const rnd = mulberry32(7);
  let bad = 0;
  const N = 40000;
  for (let k = 0; k < N; k++) {
    const d = deck36.slice();
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    const A = d.slice(0, 7), B = d.slice(7, 14);
    const e = Math.sign(compareTo(evaluateShortDeckHand(A as any), evaluateShortDeckHand(B as any)));
    const f = Math.sign(sd7(A.map(code)) - sd7(B.map(code)));
    if (e !== f) { bad++; if (bad < 4) console.log('MISMATCH', JSON.stringify(A), JSON.stringify(B), e, f); }
  }
  console.log(`fast scorer vs evaluateShortDeckHand: ${N} pairs, ${bad} mismatches`);
  if (bad) process.exit(1);
}

// (b) Heads-up equity of each class against one random Short Deck hand.
const RC: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7', 6: '6' };
const classes: { code: string; combos: number; hole: number[] }[] = [];
for (let hi = 6; hi <= 14; hi++) for (let lo = 6; lo <= hi; lo++) {
  if (hi === lo) classes.push({ code: RC[hi] + RC[hi], combos: 6, hole: [(0 << 4) | hi, (3 << 4) | hi] });
  else {
    classes.push({ code: RC[hi] + RC[lo] + 's', combos: 4, hole: [(0 << 4) | hi, (0 << 4) | lo] });
    classes.push({ code: RC[hi] + RC[lo] + 'o', combos: 12, hole: [(0 << 4) | hi, (3 << 4) | lo] });
  }
}
const t0 = Date.now();
const rows: { code: string; combos: number; eq: number }[] = [];
const me = new Array(7), op = new Array(7);
for (let ci = 0; ci < classes.length; ci++) {
  const cl = classes[ci];
  const rnd = mulberry32(20261104 + ci);
  const rest = deck36.map(code).filter((x) => x !== cl.hole[0] && x !== cl.hole[1]);
  let w = 0, t = 0;
  for (let s = 0; s < SIMS; s++) {
    for (let k = 0; k < 7; k++) { const j = k + Math.floor(rnd() * (rest.length - k)); const tmp = rest[k]; rest[k] = rest[j]; rest[j] = tmp; }
    me[0] = cl.hole[0]; me[1] = cl.hole[1]; op[0] = rest[5]; op[1] = rest[6];
    for (let b = 0; b < 5; b++) { me[2 + b] = rest[b]; op[2 + b] = rest[b]; }
    const a = sd7(me), o = sd7(op);
    if (a > o) w++; else if (a === o) t++;
  }
  rows.push({ code: cl.code, combos: cl.combos, eq: (w + t / 2) / SIMS });
}
console.log(`${rows.length} classes x ${SIMS} simulations in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// (c) Rank and percentile (strongest first; a stable sort keeps class order on equal equity).
rows.sort((a, b) => b.eq - a.eq);
const total = rows.reduce((s, r) => s + r.combos, 0);
let run = 0;
const table: Record<string, number> = {};
for (const r of rows) { table[r.code] = Math.round((1 - (run + r.combos / 2) / total) * 10000) / 10000; run += r.combos; }

const entries = rows.map((r) => `'${r.code}': ${table[r.code]}`);
const lines: string[] = [];
for (let i = 0; i < entries.length; i += 8) lines.push('  ' + entries.slice(i, i + 8).join(', ') + ',');
console.log(`total combos ${total}`);
console.log(lines.join('\n'));

if (VERIFY) {
  const committed = SHORT_DECK_PREFLOP_PCTILE;
  const keys = Object.keys(committed);
  let bad = keys.length !== rows.length ? 1 : 0;
  for (const r of rows) if (committed[r.code] !== table[r.code]) { bad++; console.log(`DIFF ${r.code}: generated ${table[r.code]} committed ${committed[r.code]}`); }
  if (shortDeckPercentileByRanks(14, 14, false) !== table.AA) bad++;
  console.log(bad ? `VERIFY FAILED (${bad})` : 'VERIFY OK: the committed table is reproduced exactly');
  process.exit(bad ? 1 : 0);
}

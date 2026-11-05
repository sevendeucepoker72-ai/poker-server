// OFFLINE generator of the committed 5- and 6-card Omaha pre-flop calibration
// knots, src/ai/omahaPreflopCalibration.ts OMAHA5_KNOTS / OMAHA6_KNOTS (bots
// review 2026-11-04, equity-variants C6). Not compiled, not run by Jest.
//
//   npx ts-node -T gen-omaha-preflop-knots.ts            prints both knot literals
//   VERIFY=1 npx ts-node -T gen-omaha-preflop-knots.ts   exits 1 unless they equal the committed knots
//
// Method: exact enumeration of every 4-, 5- and 6-card hand (270,725 /
// 2,598,960 / 20,358,520) through AIPlayer.getOmahaPreflopStrength's heuristic,
// sliced from src/ai/AIPlayer.ts with only its final clamp removed, giving the
// UNCLAMPED u = score * 1.15 + 0.10 (mapping the clamped value would merge the
// large mass clamped at 1.0). The target is the 4-card OUTPUT distribution
// (clamp(u) for 4 cards — 4-card Omaha itself is not recalibrated). Quantile
// grid: 2% steps to 90%, 0.5% steps to 99%, then 0.1%; each knot is [u at
// quantile p, 4-card output at quantile p], both rounded to 4 places, x kept
// strictly increasing, trimmed once the output reaches 1. Takes a few minutes.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Rank } from './src/game/Card';
import { OMAHA5_KNOTS, OMAHA6_KNOTS, calibrateOmahaPreflop } from './src/ai/omahaPreflopCalibration';

const VERIFY = process.env.VERIFY === '1';
type Hand = { rank: number; suit: number }[];

// ── Slice the heuristic. Works on both the 0dc1b96 form (`return Math.max(0.10,
// Math.min(1, score * 1.15 + 0.10));`) and the calibrated form (`const u = score
// * 1.15 + 0.10; ...`): everything from the last line that computes
// `score * 1.15 + 0.10` to the end of the function is replaced by `return u`.
const src = fs.readFileSync(path.join(__dirname, 'src/ai/AIPlayer.ts'), 'utf8');
const start = src.indexOf('function getOmahaPreflopStrength(');
if (start < 0) throw new Error('getOmahaPreflopStrength not found in src/ai/AIPlayer.ts');
const end = src.indexOf('\n}\n', start);
const fullBody = src.slice(start, end + 3);
const U_EXPR = 'score * 1.15 + 0.10';
const uLine = fullBody.lastIndexOf('\n', fullBody.lastIndexOf(U_EXPR));
if (fullBody.lastIndexOf(U_EXPR) < 0 || uLine < 0) throw new Error(`'${U_EXPR}' not found in getOmahaPreflopStrength`);
const uBody = fullBody.slice(0, uLine + 1) + `  return ${U_EXPR};\n}\n`;
function compile(code: string): (hole: Hand) => number {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  // The heuristic falls back to getPreFlopHandRank only for fewer than 4 cards (never here).
  return new Function('Rank', 'getPreFlopHandRank', 'calibrateOmahaPreflop', 'exports', `${js}\nreturn getOmahaPreflopStrength;`)(
    Rank, () => 0.3, calibrateOmahaPreflop, {},
  );
}
const uOf = compile(uBody);
const outOf = compile(fullBody);
const clamp = (x: number) => Math.max(0.10, Math.min(1, x));

const deck: Hand = [];
for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });

/** Histogram of f over every n-card hand (values rounded to 1e-6). */
function enumerate(n: number, f: (h: Hand) => number): Map<number, number> {
  const h = new Map<number, number>();
  const idx = Array.from({ length: n }, (_, i) => i);
  const hand: Hand = new Array(n);
  for (;;) {
    for (let i = 0; i < n; i++) hand[i] = deck[idx[i]];
    const v = Math.round(f(hand) * 1e6) / 1e6;
    h.set(v, (h.get(v) || 0) + 1);
    let i = n - 1;
    while (i >= 0 && idx[i] === 52 - n + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < n; j++) idx[j] = idx[j - 1] + 1;
  }
  return h;
}

const t0 = Date.now();
const U: Record<number, Map<number, number>> = { 4: enumerate(4, uOf), 5: enumerate(5, uOf), 6: enumerate(6, uOf) };
const tot = (h: Map<number, number>) => [...h.values()].reduce((x, y) => x + y, 0);
console.log(`exact enumeration in ${((Date.now() - t0) / 1000).toFixed(0)} s (4: ${tot(U[4])}, 5: ${tot(U[5])}, 6: ${tot(U[6])} hands)`);
// Sanity: for 4 cards the sliced heuristic's output is clamp(u).
for (let k = 0; k + 4 <= deck.length; k += 4) {
  const d = deck.slice(k, k + 4);
  if (Math.abs(clamp(uOf(d)) - outOf(d)) > 1e-12) throw new Error('slice mismatch: 4-card output is not clamp(u)');
}

const sorted = (h: Map<number, number>) => [...h.entries()].sort((x, y) => x[0] - y[0]);
/** Lower-CDF quantile: the value v with P(X < v) <= p < P(X <= v). */
function quant(h: Map<number, number>, p: number) {
  const T = tot(h);
  let run = 0;
  const s = sorted(h);
  for (const [v, k] of s) { run += k; if (run / T > p) return v; }
  return s[s.length - 1][0];
}
const T4 = new Map<number, number>();
for (const [v, k] of U[4]) { const y = Math.round(clamp(v) * 1e6) / 1e6; T4.set(y, (T4.get(y) || 0) + k); }

const G: number[] = [];
for (let p = 0; p < 0.90 - 1e-9; p += 0.02) G.push(p);
for (let p = 0.90; p < 0.99 - 1e-9; p += 0.005) G.push(p);
for (let p = 0.99; p <= 1.0000001; p += 0.001) G.push(Math.min(p, 0.9999));
function knots(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of G) {
    const x = Math.round(quant(U[n], p) * 1e4) / 1e4;
    const y = Math.round(quant(T4, p) * 1e4) / 1e4;
    if (out.length && out[out.length - 1][0] >= x) { out[out.length - 1][1] = Math.max(out[out.length - 1][1], y); continue; }
    out.push([x, y]);
  }
  const i = out.findIndex((k) => k[1] >= 1);
  return i >= 0 ? out.slice(0, i + 1) : out;
}

const K: Record<number, [number, number][]> = { 5: knots(5), 6: knots(6) };
for (const n of [5, 6]) {
  const lines: string[] = [];
  for (let i = 0; i < K[n].length; i += 6) lines.push('  ' + K[n].slice(i, i + 6).map(([x, y]) => `[${x}, ${y}]`).join(', ') + ',');
  console.log(`OMAHA${n}_KNOTS (${K[n].length} knots)`);
  console.log(lines.join('\n'));
}

if (VERIFY) {
  const same = (a: ReadonlyArray<readonly [number, number]>, b: [number, number][]) =>
    a.length === b.length && a.every((k, i) => k[0] === b[i][0] && k[1] === b[i][1]);
  const ok5 = same(OMAHA5_KNOTS, K[5]);
  const ok6 = same(OMAHA6_KNOTS, K[6]);
  console.log(ok5 && ok6 ? 'VERIFY OK: both committed knot tables are reproduced exactly' : `VERIFY FAILED (5-card ${ok5 ? 'ok' : 'DIFF'}, 6-card ${ok6 ? 'ok' : 'DIFF'})`);
  process.exit(ok5 && ok6 ? 0 : 1);
}

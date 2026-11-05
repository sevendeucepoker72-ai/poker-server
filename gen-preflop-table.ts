// OFFLINE generator for src/ai/preflopTable.ts (bots review 2026-11-04, holdem-preflop C1 / B10 / NEW-2).
//
// The bots' Hold'em pre-flop percentile table used to be Monte-Carlo-built lazily, synchronously and with
// Math.random on the first bot decision after every boot (preflopRanges.ts ensureTable): a 7-21 s whole-server
// freeze, and ranges that reshuffled on every deploy. It is now generated ONCE, here, and committed.
//
// Two columns per hand class (all 169: pair = suits 0,3; suited = 0,0; offsuit = 0,3):
//   pctile   - combo-weighted percentile of heads-up equity vs ONE random hand (the scale every open / call /
//              3-bet / push-fold threshold was tuned on; the exact formula of the old ensureTable).
//   stackOff - the same percentile, but of equity vs a combo drawn uniformly from the top STRONG_TOP of the
//              pctile column (4-bets and deep stack-offs, where vs-random puts 77-88 above AK).
// equity = (win + tie/2) / SIMS with the repo's evaluateHand / compareTo. Sorted by equity descending (ties by
// code), pctile = 1 - (runningCombos + combos/2) / 1326, rounded to 5 dp.
//
// Deterministic: integer-only mulberry32, RE-SEEDED with SEED at the start of every hand class (common random
// numbers), so the output is bit-identical on every machine and a single class can be recomputed alone.
//
// Usage (repo root; outside tsconfig include and jest testMatch, so it is neither built nor run by CI):
//   SIMS=50000 npx ts-node -T -P tsconfig.json gen-preflop-table.ts            (~35-50 min; writes OUT)
//   VERIFY=1   npx ts-node -T -P tsconfig.json gen-preflop-table.ts            (~1-3 min; exit 0 = committed rows reproduce)
// Environment: SIMS (default 50000), SEED (default 0x5eed2026), STRONG_TOP (default 0.15),
//              OUT (default src/ai/preflopTable.ts), VERIFY=1.
// VERIFY=1 recomputes AA, AKo and 72o in both columns and exits non-zero unless (a) their equities equal the
// anchors the generator wrote into OUT's header, (b) each one sorts strictly between its committed neighbours
// (whose equities it also recomputes), and (c) its committed percentile is the formula's value at its slot.
// The file is written only after every equity is computed, with LF line endings, ASCII only.
import fs from 'fs';
import path from 'path';
import { evaluateHand, compareTo } from './src/game/HandEvaluator';
import { Card } from './src/game/Card';

const SIMS = Number(process.env.SIMS || 50000);
const STRONG_TOP = Number(process.env.STRONG_TOP || 0.15);
const SEED = Number(process.env.SEED || 0x5eed2026);
const OUT = path.resolve(__dirname, process.env.OUT || path.join('src', 'ai', 'preflopTable.ts'));
const VERIFY_CODES = ['AA', 'AKo', '72o'];

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RC = 'xx23456789TJQKA';
function code(hi: number, lo: number, suited: boolean): string { return hi === lo ? RC[hi] + RC[hi] : RC[hi] + RC[lo] + (suited ? 's' : 'o'); }
const DECK: Card[] = [];
for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) DECK.push({ rank: r, suit: s } as Card);
const key = (c: Card): number => c.rank * 4 + c.suit;

interface HandClass { code: string; combos: number; hole: Card[] }
const classes: HandClass[] = [];
for (let hi = 2; hi <= 14; hi++) for (let lo = 2; lo <= hi; lo++) {
  if (hi === lo) classes.push({ code: code(hi, lo, false), combos: 6, hole: [{ rank: hi, suit: 0 } as Card, { rank: hi, suit: 3 } as Card] });
  else {
    classes.push({ code: code(hi, lo, true), combos: 4, hole: [{ rank: hi, suit: 0 } as Card, { rank: lo, suit: 0 } as Card] });
    classes.push({ code: code(hi, lo, false), combos: 12, hole: [{ rank: hi, suit: 0 } as Card, { rank: lo, suit: 3 } as Card] });
  }
}
const classByCode = new Map(classes.map((c) => [c.code, c]));
function classOf(a: Card, b: Card): string { const hi = Math.max(a.rank, b.rank), lo = Math.min(a.rank, b.rank); return code(hi, lo, a.suit === b.suit && hi !== lo); }

/** Heads-up equity of `hole` vs one random hand (oppPool null) or vs a uniformly drawn combo of `oppPool`. */
function equity(hole: Card[], oppPool: Card[][] | null): number {
  const rnd = mulberry32(SEED);                                     // per-class re-seed (common random numbers)
  const known = new Set(hole.map(key));
  const rest = DECK.filter((c) => !known.has(key(c)));
  const pool = oppPool ? oppPool.filter(([a, b]) => !known.has(key(a)) && !known.has(key(b))) : null;
  let win = 0, tie = 0;
  const me: Card[] = [hole[0], hole[1], hole[0], hole[0], hole[0], hole[0], hole[0]];
  const op: Card[] = [hole[0], hole[0], hole[0], hole[0], hole[0], hole[0], hole[0]];
  for (let i = 0; i < SIMS; i++) {
    let o1: Card, o2: Card, deck = rest;
    if (pool) {
      const [a, b] = pool[Math.floor(rnd() * pool.length)];
      o1 = a; o2 = b;
      const ka = key(a), kb = key(b);
      deck = rest.filter((c) => key(c) !== ka && key(c) !== kb);
      for (let k = 0; k < 5; k++) { const j = k + Math.floor(rnd() * (deck.length - k)); const t = deck[k]; deck[k] = deck[j]; deck[j] = t; }
    } else {
      // NB: shuffles `rest` in place, so each simulation starts from the previous permutation (as generated).
      for (let k = 0; k < 7; k++) { const j = k + Math.floor(rnd() * (deck.length - k)); const t = deck[k]; deck[k] = deck[j]; deck[j] = t; }
      o1 = deck[5]; o2 = deck[6];
    }
    for (let k = 0; k < 5; k++) { me[2 + k] = deck[k]; op[2 + k] = deck[k]; }
    op[0] = o1; op[1] = o2;
    const cmp = compareTo(evaluateHand(me), evaluateHand(op));
    if (cmp > 0) win++; else if (cmp === 0) tie++;
  }
  return (win + tie / 2) / SIMS;
}

/** Equity descending, ties by code (deterministic); the generator's sort comparator. */
const byEquity = (a: { code: string; eq: number }, b: { code: string; eq: number }): number => b.eq - a.eq || (a.code < b.code ? -1 : 1);

function pctiles(eqs: Map<string, number>): Map<string, number> {
  const hs = classes.map((c) => ({ code: c.code, combos: c.combos, eq: eqs.get(c.code)! }));
  hs.sort(byEquity);
  const m = new Map<string, number>(); let run = 0;
  for (const h of hs) { m.set(h.code, 1 - (run + h.combos / 2) / 1326); run += h.combos; }
  return m;
}

/** Every specific combo whose class is in the top STRONG_TOP by pctile. */
function strongPoolFrom(pctileOf: (code: string) => number): Card[][] {
  const pool: Card[][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) {
    const A = DECK[a], B = DECK[b];
    if (pctileOf(classOf(A, B)) >= 1 - STRONG_TOP) pool.push([A, B]);
  }
  return pool;
}

export interface PreflopRow { code: string; combos: number; eqRandom: number; pctile: number; eqStrong: number; stackOff: number }
export interface PreflopRun { SIMS: number; SEED: number; STRONG_TOP: number; strongPoolCombos: number; rows: PreflopRow[] }

/** The committed module's text for a run (rows already sorted by pctile descending, values rounded to 5 dp). */
export function emitModule(run: PreflopRun): string {
  const hex = '0x' + (run.SEED >>> 0).toString(16);
  const anchors = VERIFY_CODES.map((c) => {
    const r = run.rows.find((x) => x.code === c)!;
    return `${c} ${r.eqRandom.toFixed(5)} ${r.eqStrong.toFixed(5)}`;
  }).join(' | ');
  return [
    '// GENERATED by gen-preflop-table.ts (repo root) - do not edit by hand. Re-run the script to change it:',
    `//   SIMS=${run.SIMS} npx ts-node -T -P tsconfig.json gen-preflop-table.ts   (VERIFY=1 re-checks AA, AKo, 72o)`,
    `// SIMS=${run.SIMS} per hand class, SEED=${hex}, STRONG_TOP=${run.STRONG_TOP} (${run.strongPoolCombos} combos).`,
    '// [code, combos, pctile = combo-weighted percentile of equity vs ONE random hand,',
    `//  stackOff = combo-weighted percentile of equity vs a random hand from the top ${Math.round(run.STRONG_TOP * 100)}% (by pctile)]`,
    `// VERIFY anchors (eqRandom eqStrong): ${anchors}`,
    `export const PREFLOP_TABLE_VERSION = 'preflop-table-v1 sims=${run.SIMS} seed=${hex} strongTop=${run.STRONG_TOP}';`,
    `export const PREFLOP_TABLE_META = { sims: ${run.SIMS}, seed: ${hex}, strongTop: ${run.STRONG_TOP} } as const;`,
    'export const PREFLOP_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [',
    ...run.rows.map((r) => `  ['${r.code}', ${r.combos}, ${r.pctile.toFixed(5)}, ${r.stackOff.toFixed(5)}],`),
    '];',
    '',
  ].join('\n');                                                     // LF only, ASCII only
}

function generate(): void {
  const t0 = Date.now();
  const eqR = new Map<string, number>();
  for (const c of classes) eqR.set(c.code, equity(c.hole, null));
  const pR = pctiles(eqR);
  const t1 = Date.now();
  const strongPool = strongPoolFrom((c) => pR.get(c)!);
  const eqS = new Map<string, number>();
  for (const c of classes) eqS.set(c.code, equity(c.hole, strongPool));
  const pS = pctiles(eqS);
  const t2 = Date.now();
  const rows: PreflopRow[] = classes.map((c) => ({
    code: c.code, combos: c.combos,
    eqRandom: +eqR.get(c.code)!.toFixed(5), pctile: +pR.get(c.code)!.toFixed(5),
    eqStrong: +eqS.get(c.code)!.toFixed(5), stackOff: +pS.get(c.code)!.toFixed(5),
  }));
  rows.sort((a, b) => b.pctile - a.pctile);
  fs.writeFileSync(OUT, emitModule({ SIMS, SEED, STRONG_TOP, strongPoolCombos: strongPool.length, rows }), 'utf8');
  console.log(`SIMS=${SIMS} col1 ${t1 - t0} ms, col2 ${t2 - t1} ms, strong pool ${strongPool.length} combos -> ${OUT}`);
}

function verify(): number {
  const text = fs.readFileSync(OUT, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(OUT) as { PREFLOP_TABLE: ReadonlyArray<readonly [string, number, number, number]>; PREFLOP_TABLE_META: { sims: number; seed: number; strongTop: number } };
  const fail: string[] = [];
  const meta = mod.PREFLOP_TABLE_META;
  if (meta.sims !== SIMS || meta.seed !== SEED || meta.strongTop !== STRONG_TOP) {
    console.error(`VERIFY: ${OUT} was generated with sims=${meta.sims} seed=0x${(meta.seed >>> 0).toString(16)} strongTop=${meta.strongTop}; ` +
      `this run uses SIMS=${SIMS} SEED=0x${(SEED >>> 0).toString(16)} STRONG_TOP=${STRONG_TOP}. Set the same environment.`);
    return 2;
  }
  const rows = mod.PREFLOP_TABLE.map(([c, combos, pctile, stackOff]) => ({ code: c, combos, pctile, stackOff }));
  if (rows.length !== 169 || rows.reduce((s, r) => s + r.combos, 0) !== 1326) fail.push('table shape: expected 169 rows / 1326 combos');
  const committed = new Map(rows.map((r) => [r.code, r]));

  // The strong pool from the COMMITTED pctile column (the generator built it from the same column, unrounded).
  const strongPool = strongPoolFrom((c) => committed.get(c)?.pctile ?? 0);
  const hdr = /STRONG_TOP=[\d.]+ \((\d+) combos\)/.exec(text);
  if (!hdr || Number(hdr[1]) !== strongPool.length) fail.push(`strong pool: ${strongPool.length} combos from the committed pctile column, header says ${hdr ? hdr[1] : '?'}`);

  const anchorLine = /VERIFY anchors \(eqRandom eqStrong\): (.*)/.exec(text);
  const anchors = new Map<string, [string, string]>();
  if (anchorLine) for (const part of anchorLine[1].split('|')) { const [c, r, s] = part.trim().split(/\s+/); anchors.set(c, [r, s]); }

  const cache = new Map<string, number>();
  const eqOf = (c: string, col: 'pctile' | 'stackOff'): number => {
    const k = c + '|' + col;
    if (!cache.has(k)) cache.set(k, equity(classByCode.get(c)!.hole, col === 'pctile' ? null : strongPool));
    return cache.get(k)!;
  };
  for (const col of ['pctile', 'stackOff'] as const) {
    const order = rows.slice().sort((a, b) => b[col] - a[col]);
    for (const c of VERIFY_CODES) {
      const i = order.findIndex((r) => r.code === c);
      if (i < 0) { fail.push(`${c}: missing from the table`); continue; }
      const eq = eqOf(c, col);
      const anchor = anchors.get(c)?.[col === 'pctile' ? 0 : 1];
      if (anchor !== eq.toFixed(5)) fail.push(`${c} ${col}: recomputed equity ${eq.toFixed(5)}, header anchor ${anchor ?? 'missing'}`);
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= order.length) continue;
        const n = order[j].code;
        const s = Math.sign(byEquity({ code: c, eq }, { code: n, eq: eqOf(n, col) }));
        if (s !== Math.sign(i - j)) fail.push(`${c} ${col}: recomputed equity does not sort ${j < i ? 'below' : 'above'} its committed neighbour ${n}`);
      }
      const above = order.slice(0, i).reduce((s, r) => s + r.combos, 0);
      const expect = +(1 - (above + order[i].combos / 2) / 1326).toFixed(5);
      if (order[i][col] !== expect) fail.push(`${c} ${col}: committed ${order[i][col]}, its slot gives ${expect}`);
      console.log(`${c.padEnd(4)} ${col.padEnd(8)} equity ${eq.toFixed(5)} (anchor ${anchor})  committed ${order[i][col].toFixed(5)}  rank ${i + 1}/169`);
    }
  }
  if (fail.length) { console.error('VERIFY FAILED:\n  ' + fail.join('\n  ')); return 1; }
  console.log(`VERIFY OK: AA, AKo and 72o recomputed identical to ${path.relative(process.cwd(), OUT)} (${SIMS} sims, seed 0x${(SEED >>> 0).toString(16)}).`);
  return 0;
}

if (require.main === module) {
  if (process.env.VERIFY === '1') process.exit(verify());
  generate();
}

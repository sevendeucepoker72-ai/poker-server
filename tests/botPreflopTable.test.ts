/**
 * B10 / NEW-2 (bots review 2026-11-04, holdem-preflop C1): the committed, deterministic pre-flop table.
 *
 * At 0dc1b96 preflopRanges.ts built its percentile table lazily, synchronously and with Math.random
 * (169 hand classes x 600 Monte Carlo runs, ~710k Math.random calls) on the FIRST bot decision after
 * every boot: a 7-21 s whole-server freeze, and bot ranges that reshuffled on every deploy. The table is
 * now generated offline by gen-preflop-table.ts (fixed seed) and committed as src/ai/preflopTable.ts.
 *
 * Fails on 0dc1b96: src/ai/preflopTable.ts and getStackOffPercentile / FOURBET_STACKOFF_THRESHOLD do
 * not exist, the first read calls Math.random ~710k times and takes seconds, and two fresh loads
 * disagree on the percentiles.
 */
import { Card } from '../src/game/Card';

const PR_PATH = '../src/ai/preflopRanges';
const TABLE_PATH = '../src/ai/preflopTable';

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const CODES: string[] = [];
{
  const ch = 'AKQJT98765432';
  for (let i = 0; i < 13; i++) for (let j = i; j < 13; j++) {
    if (i === j) CODES.push(ch[i] + ch[i]);
    else { CODES.push(ch[i] + ch[j] + 's'); CODES.push(ch[i] + ch[j] + 'o'); }
  }
}
/** A concrete two-card hand of a 169-class code. */
const handOf = (code: string): Card[] => [
  { rank: RK[code[0]] ?? Number(code[0]), suit: 0 } as Card,
  { rank: RK[code[1]] ?? Number(code[1]), suit: code[2] === 's' ? 0 : 1 } as Card,
];

describe('B10 / NEW-2: the pre-flop table is committed and deterministic', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the first read after a fresh load draws no random numbers and is instant (was ~710k Math.random calls, a 7-21 s freeze)', () => {
    const spy = jest.spyOn(Math, 'random');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PR = require(PR_PATH);
      const t0 = Date.now();
      expect(PR.getPreflopPercentile(handOf('AA'))).toBeGreaterThan(0.99);
      expect(PR.percentileByRanks(7, 2, false)).toBeLessThan(0.15);
      expect(PR.getStackOffPercentile(handOf('AKs'))).toBeGreaterThan(0.95);
      expect(Date.now() - t0).toBeLessThan(200);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('two fresh loads give identical percentiles for all 169 hands, on both scales', () => {
    let a: number[][] = [], b: number[][] = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PR = require(PR_PATH);
      a = CODES.map((c) => [PR.getPreflopPercentile(handOf(c)), PR.getStackOffPercentile(handOf(c))]);
    });
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PR = require(PR_PATH);
      b = CODES.map((c) => [PR.getPreflopPercentile(handOf(c)), PR.getStackOffPercentile(handOf(c))]);
    });
    expect(a).toEqual(b);
  });

  it('shape: version, 169 distinct hands, 1326 combos, AA top, pairs in order, AKs above AKo', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PR = require(PR_PATH);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PREFLOP_TABLE, PREFLOP_TABLE_VERSION, PREFLOP_TABLE_META } = require(TABLE_PATH);
    expect(String(PREFLOP_TABLE_VERSION).startsWith('preflop-table-v1')).toBe(true);
    expect(PREFLOP_TABLE_META).toEqual({ sims: 50000, seed: 0x5eed2026, strongTop: 0.15 });
    expect(PREFLOP_TABLE).toHaveLength(169);
    expect(new Set(PREFLOP_TABLE.map((r: readonly [string, number, number, number]) => r[0]))).toEqual(new Set(CODES));
    expect(PREFLOP_TABLE.reduce((s: number, r: readonly [string, number, number, number]) => s + r[1], 0)).toBe(1326);
    const p = (c: string): number => PR.getPreflopPercentile(handOf(c));
    expect(Math.max(...CODES.map(p))).toBe(p('AA'));
    const pairs = 'AKQJT98765432'.split('').map((r) => p(r + r));
    for (let i = 1; i < pairs.length; i++) expect(pairs[i]).toBeLessThan(pairs[i - 1]);
    expect(p('AKs')).toBeGreaterThan(p('AKo'));
    // The signatures the range-aware equity sampler (TrainingEngine) and the equity lane rely on.
    expect(PR.percentileByRanks(14, 13, true)).toBe(p('AKs'));
    expect(PR.percentileByRanks(13, 14, false)).toBe(p('AKo'));
    expect(PR.getHandCode(handOf('T9s'))).toBe('T9s');
    expect(PR.handCodeFrom(9, 10, false)).toBe('T9o');
    expect(PR.getPreflopPercentile([])).toBe(0);
    expect(PR.getStackOffPercentile([])).toBe(0);
  });

  it('the 4-bet line on the stack-off scale is exactly JJ+ and AK, 40 combos (on the vs-random scale 0.965 is AA-88 + AKs)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PR = require(PR_PATH);
    const set = CODES.filter((c) => PR.getStackOffPercentile(handOf(c)) >= PR.FOURBET_STACKOFF_THRESHOLD).sort();
    expect(set).toEqual(['AA', 'AKo', 'AKs', 'JJ', 'KK', 'QQ']);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PREFLOP_TABLE } = require(TABLE_PATH);
    const combos = PREFLOP_TABLE.filter((r: readonly [string, number, number, number]) => set.includes(r[0])).reduce((s: number, r: readonly [string, number, number, number]) => s + r[1], 0);
    expect(combos).toBe(40);
    // FOURBET_THRESHOLD (kept for Omaha strengths) means AA-88 + AKs on the equity-vs-random scale.
    const old = CODES.filter((c) => PR.getPreflopPercentile(handOf(c)) >= PR.FOURBET_THRESHOLD).sort();
    expect(old).toEqual(['88', '99', 'AA', 'AKs', 'JJ', 'KK', 'QQ', 'TT']);
  });
});

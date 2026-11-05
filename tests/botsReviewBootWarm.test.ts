/**
 * tests/botsReviewBootWarm.test.ts (2026-11 bots review, server-stability C10, Option A).
 *
 * At 0dc1b96 the FIRST bot decision after every boot built the pre-flop percentile table
 * synchronously: 169 hand classes x 600 Monte Carlo runs, 202,800 evaluateHand calls and
 * ~710k Math.random calls, a 7-21 s freeze of every table, socket and turn clock. The
 * table is now committed (holdem-preflop C1, src/ai/preflopTable.ts), so a fresh process
 * needs no warm-up: Option A ships this test and no index.ts code.
 *
 * Each case loads a FRESH module registry (jest.isolateModules) with HandEvaluator's
 * evaluateHand spied BEFORE preflopRanges / AIPlayer load. Fails on 0dc1b96 (202,800
 * evaluations on the first read).
 */
import { Card } from '../src/game/Card';

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const handOf = (code: string): Card[] => [
  { rank: RK[code[0]] ?? Number(code[0]), suit: 0 } as Card,
  { rank: RK[code[1]] ?? Number(code[1]), suit: code[2] === 's' ? 0 : 1 } as Card,
];

/** Runs fn in a fresh registry with evaluateHand counted from before the bot modules load. */
function coldStart<T>(fn: (req: (p: string) => any) => T): { out: T; evals: number; randoms: number } {
  let out!: T;
  let evals = 0, randoms = 0;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const HE = require('../src/game/HandEvaluator');
    const realEval = HE.evaluateHand;
    const evalSpy = jest.spyOn(HE, 'evaluateHand').mockImplementation((...a: any[]) => realEval(...a));
    const rndSpy = jest.spyOn(Math, 'random');
    try {
      out = fn((p: string) => require(p));
      evals = evalSpy.mock.calls.length;
      randoms = rndSpy.mock.calls.length;
    } finally {
      evalSpy.mockRestore();
      rndSpy.mockRestore();
    }
  });
  return { out, evals, randoms };
}

describe('C10 (Option A) — no boot-time pre-flop table build', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the first getPreflopPercentile in a fresh process makes 0 evaluations and 0 Math.random calls; AA >= 0.99', () => {
    const { out, evals, randoms } = coldStart((req) => {
      const PR = req('../src/ai/preflopRanges');
      const t0 = Date.now();
      const aa = PR.getPreflopPercentile(handOf('AA'));
      const ms = Date.now() - t0;
      return { aa, ms, sevenTwo: PR.getPreflopPercentile(handOf('72o')) };
    });
    expect(evals).toBe(0);
    expect(randoms).toBe(0);
    expect(out.aa).toBeGreaterThanOrEqual(0.99);
    expect(out.sevenTwo).toBeLessThan(0.1);
    expect(out.ms).toBeLessThan(200);   // a table read (was 7-21 s); generous for a loaded CI box
  });

  it.each([
    ['Hold\'em', 'PokerTable', ''],
    ['Pineapple (3 hole cards)', 'PineappleTable', '../src/game/variants/PineappleTable'],
  ])('the first pre-flop bot decision on a fresh %s table makes 0 evaluations', (_name, cls, mod) => {
    const { out, evals } = coldStart((req) => {
      const PT = req('../src/game/PokerTable');
      const Table = mod ? req(mod)[cls] : PT.PokerTable;
      const AI = req('../src/ai/AIPlayer');
      const t = new Table({ tableId: 'w', tableName: 'w', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 });
      for (let i = 0; i < 6; i++) t.sitDown(i, 'B' + i, 10000, 'ai-w' + i, true);
      t.startNewHand();
      const t0 = Date.now();
      const d = AI.decideAction(t, t.activeSeatIndex, { ...AI.generateRandomProfile('hard'), archetype: 'TAG' });
      return { d, ms: Date.now() - t0, phase: t.currentPhase, PreFlop: PT.GamePhase.PreFlop };
    });
    expect(out.phase).toBe(out.PreFlop);
    expect(typeof out.d.action).toBe('string');
    expect(evals).toBe(0);
    expect(out.ms).toBeLessThan(250);
  });
});

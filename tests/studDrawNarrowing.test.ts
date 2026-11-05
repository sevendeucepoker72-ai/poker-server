/**
 * tests/studDrawNarrowing.test.ts (2026-11 bots review, fix round 2, VA-2).
 * studDrawEquity narrows each opponent's start to his range by rejection sampling, at most MAX_TRIES
 * deals. On d1ec56a, when every try missed, the last rejected (random) deal was scored anyway: about 7%
 * of the opponents at floor 0.90 and 12% at 0.92 were unconditioned hands, and the bot's pot share came
 * out 3-5 points too high against a tight range. Now that simulation is dropped.
 * The reference is independent of studDrawEquity: Five Card Draw after the draw (Bet2, no draws to come),
 * the opponent's dealt hand drawn by plain rejection (no cap) from the cards the bot cannot see until it
 * reaches the FLOOR quantile of hiValue among such hands, then one draw by the bots' keep rule. Seeded.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const SDS = require('../src/ai/studDrawStrength');
export {};   // a module: its top-level names stay file-scoped

function biasPoints(floor: number, spots: number, refN: number, seed: number): number {
  let st = seed >>> 0; const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  const DECK: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) DECK.push({ rank: r, suit: su });
  const shuffled = (d: any[], k: number) => { const x = d.slice(); for (let i = 0; i < k; i++) { const j = i + Math.floor(rnd() * (x.length - i)); const z = x[i]; x[i] = x[j]; x[j] = z; } return x; };
  let sum = 0;
  for (let k = 0; k < spots; k++) {
    const mine = shuffled(DECK, 5).slice(0, 5);
    const rest = DECK.filter((c) => !mine.some((m: any) => m.rank === c.rank && m.suit === c.suit));
    // the range's floor score: the FLOOR quantile of hiValue over the unseen cards (studDrawEquity's warm-up rule, 20k deals)
    const sc: number[] = []; for (let i = 0; i < 20000; i++) sc.push(SDS.hiValue(shuffled(rest, 5).slice(0, 5)));
    sc.sort((a, b) => a - b); const thr = sc[Math.floor(floor * sc.length)];
    const eq = SDS.studDrawEquity({ kind: 'draw-hi', mine, dead: [], shared: [], opps: [{ known: [], total: 5, floor }], drawsLeft: 0 }, 400, 0);
    let tot = 0;
    for (let n = 0; n < refN; n++) {
      let d: any[];
      do { d = shuffled(rest, 10); } while (SDS.hiValue(d.slice(0, 5)) < thr);
      const start = d.slice(0, 5); const keep = SDS.keepForDraw('draw-hi', start, 1);
      const fin = keep.map((i: number) => start[i]).concat(d.slice(5, 5 + (5 - keep.length)));
      const mv = SDS.hiValue(mine), ov = SDS.hiValue(fin);
      tot += mv > ov ? 1 : mv === ov ? 0.5 : 0;
    }
    sum += eq - tot / refN;
  }
  return (100 * sum) / spots;
}

describe('VA-2: range narrowing never scores a start outside the range', () => {
  it('vs a nit\'s re-raise (floor 0.92) the narrowed pot share is not above an exact reference (d1ec56a: +4.9 points)', () => {
    const b = biasPoints(0.92, 40, 3000, 4242);
    process.stdout.write(`VA-2 floor 0.92: studDrawEquity - reference = ${b.toFixed(2)} points\n`);
    expect(b).toBeLessThan(1.0);
  }, 120_000);
  it('GUARD: no narrowing (floor 0) is untouched: the same spot gives the same pot share, and a lone opponent at floor 0 is never dropped', () => {
    const spot = { kind: 'draw-hi', mine: [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }, { rank: 13, suit: 2 }, { rank: 7, suit: 3 }, { rank: 3, suit: 0 }], dead: [], shared: [], opps: [{ known: [], total: 5, floor: 0 }], drawsLeft: 1 };
    const st1 = { sims: 0 }, st2 = { sims: 0 };
    expect(SDS.studDrawEquity(spot, 400, 0, st1)).toBe(SDS.studDrawEquity(spot, 400, 0, st2));
    expect(st1.sims).toBe(400);
  });
});

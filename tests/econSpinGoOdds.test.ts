/**
 * Bots review 2026-11-04 (economy-farming E1) — the Spin & Go prize odds.
 * Owner call: 2x 67 / 3x 22 / 5x 7 / 10x 3 / 25x 1, mean 2.90x = 1 / 34.4%
 * (the best simple strategy's win rate against the merged bots). HEAD
 * (0dc1b96) was 60 / 25 / 10 / 4 / 1, mean 3.10x, and had no exported table:
 * this suite fails there (no SPIN_GO_MULTIPLIER_ODDS; mean 3.10).
 * The multipliers {2, 3, 5, 10, 25} and the 1% top prize the lobby shows
 * ("Random prize up to 25x") are unchanged.
 */
import { SPIN_GO_MULTIPLIER_ODDS, spinGoMultiplierFor } from '../src/game/quickGames';

/** spinGoMultiplierFor over 100,000 evenly spaced rolls in [0, 100). */
function integrate(): { mean: number; freq: Map<number, number> } {
  const N = 100_000;
  const freq = new Map<number, number>();
  let sum = 0;
  for (let k = 0; k < N; k++) {
    const m = spinGoMultiplierFor((k + 0.5) / 1000);
    sum += m;
    freq.set(m, (freq.get(m) || 0) + 1);
  }
  return { mean: sum / N, freq };
}

describe('E1 — Spin & Go prize odds', () => {
  it('the mean multiplier is 2.90x (HEAD 3.10x)', () => {
    expect(integrate().mean).toBeCloseTo(2.9, 3);
  });

  it('the result set is {2, 3, 5, 10, 25} with P(25)=1%, P(10)=3%, P(5)=7%, P(3)=22%, P(2)=67%', () => {
    const { freq } = integrate();
    expect([...freq.keys()].sort((a, b) => a - b)).toEqual([2, 3, 5, 10, 25]);
    expect(freq.get(25)).toBe(1_000);
    expect(freq.get(10)).toBe(3_000);
    expect(freq.get(5)).toBe(7_000);
    expect(freq.get(3)).toBe(22_000);
    expect(freq.get(2)).toBe(67_000);
  });

  it('SPIN_GO_MULTIPLIER_ODDS is the one table: pct sums to 100, top prize first, and its mean is the integrated mean', () => {
    expect(SPIN_GO_MULTIPLIER_ODDS.reduce((s, o) => s + o.pct, 0)).toBe(100);
    expect(SPIN_GO_MULTIPLIER_ODDS.map((o) => o.multiplier)).toEqual([25, 10, 5, 3, 2]);
    expect(SPIN_GO_MULTIPLIER_ODDS.map((o) => o.pct)).toEqual([1, 3, 7, 22, 67]);
    const tableMean = SPIN_GO_MULTIPLIER_ODDS.reduce((s, o) => s + (o.multiplier * o.pct) / 100, 0);
    expect(tableMean).toBeCloseTo(2.9, 10);
    // Break-even win rate 1 / 2.90 = 34.5% >= the measured 34.4% of a Nash push/fold player.
    expect(1 / tableMean).toBeGreaterThanOrEqual(0.344);
  });

  it('cut-offs at the edges (below 1, 4, 11, 33) and the [0, 100) bounds', () => {
    expect(spinGoMultiplierFor(0)).toBe(25);
    expect(spinGoMultiplierFor(0.999)).toBe(25);
    expect(spinGoMultiplierFor(1)).toBe(10);
    expect(spinGoMultiplierFor(3.999)).toBe(10);
    expect(spinGoMultiplierFor(4)).toBe(5);
    expect(spinGoMultiplierFor(10.999)).toBe(5);
    expect(spinGoMultiplierFor(11)).toBe(3);
    expect(spinGoMultiplierFor(32.999)).toBe(3);
    expect(spinGoMultiplierFor(33)).toBe(2);
    expect(spinGoMultiplierFor(99.999)).toBe(2);
    expect(spinGoMultiplierFor(100)).toBe(2);   // out of range: the smallest prize, never more
  });
});

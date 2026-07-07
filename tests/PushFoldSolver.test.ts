import { inPushFoldZone, nashPushPctile, nashCallPctile, PUSH_FOLD_MAX_BB } from '../src/ai/pushFoldSolver';

// Guards the baked offline Nash push/fold table (pushFoldSolver.ts). If someone
// re-solves and re-bakes, these invariants must still hold or the AI's short-
// stack play silently breaks.
describe('push/fold Nash lookup', () => {
  it('is monotonic: shorter stacks shove WIDER (lower percentile threshold)', () => {
    let prev = -1;
    for (let bb = 2; bb <= PUSH_FOLD_MAX_BB; bb++) {
      const th = nashPushPctile(bb, 1)!;
      expect(th).not.toBeNull();
      // deeper stack => threshold non-decreasing (tighter). Allow tiny noise.
      expect(th).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = th;
    }
  });

  it('matches the validated HU anchors within tolerance', () => {
    // pctile threshold = 1 - (range fraction). 10bb HU ~ push top 56% => ~0.44.
    expect(nashPushPctile(10, 1)!).toBeGreaterThan(0.40);
    expect(nashPushPctile(10, 1)!).toBeLessThan(0.50);
    // 20bb HU ~ push top 40% => ~0.60.
    expect(nashPushPctile(20, 1)!).toBeGreaterThan(0.55);
    expect(nashPushPctile(20, 1)!).toBeLessThan(0.66);
  });

  it('tightens the shove range with more players yet to act', () => {
    const hu = nashPushPctile(10, 1)!;
    const three = nashPushPctile(10, 3)!;
    expect(three).toBeGreaterThan(hu);
  });

  it('returns null above the push/fold zone (defer to open-raise logic)', () => {
    expect(nashPushPctile(PUSH_FOLD_MAX_BB + 1, 1)).toBeNull();
  });

  it('call threshold is tighter than push threshold at the same stack', () => {
    // You call a shove tighter than you open-shove (no fold equity when calling).
    expect(nashCallPctile(10, 1)).toBeGreaterThan(nashPushPctile(10, 1)!);
  });

  it('zone engages only when genuinely short; deeper HU-vs-multiway cutoffs differ', () => {
    expect(inPushFoldZone(8, 1)).toBe(true);
    expect(inPushFoldZone(16, 1)).toBe(true); // HU cutoff
    expect(inPushFoldZone(16, 3)).toBe(false); // multiway breaks down sooner
    expect(inPushFoldZone(40, 1)).toBe(false); // deep => normal play
  });
});

/**
 * Preflop push/fold Nash lookup (Level-2 "offline blueprint → cheap online
 * lookup" pattern). The BAKED table below was computed OFFLINE by
 * `pushfold-solve.ts` (a fictitious-play solver over a 169x169 Monte-Carlo
 * all-in equity matrix) and validated against published heads-up Nash charts:
 *
 *   eff.stack   SB push   BB call        (published Nash for reference)
 *      5bb       ~72%      ~60%          (~78% / ~53%)
 *      8bb       ~62%      ~43%          (~65% / ~47%)
 *     10bb       ~56%      ~37%          (~59% / ~43%)
 *     15bb       ~46%      ~26%          (~45% / ~33%)
 *     20bb       ~40%      ~21%          (~37% / ~27%)
 *
 * The push side matches closely; the call side is a touch tight (a safe leak —
 * folding marginally too much when short is tiny -EV and reads as human).
 *
 * Values are PERCENTILE thresholds against `getPreflopPercentile` (equity-vs-
 * random), so they compose directly with the rest of the range model. Runtime
 * cost is a single array lookup + lerp — zero Monte-Carlo, safe on the hot path.
 */

// effBB -> { push: pctile to shove (SB / open-shove), call: pctile to call a shove }
const NASH: Record<number, { push: number; call: number }> = {
  2: { push: 0.117, call: 0.0 },
  3: { push: 0.214, call: 0.093 },
  4: { push: 0.253, call: 0.294 },
  5: { push: 0.283, call: 0.4 },
  6: { push: 0.334, call: 0.472 },
  7: { push: 0.352, call: 0.527 },
  8: { push: 0.383, call: 0.571 },
  9: { push: 0.423, call: 0.606 },
  10: { push: 0.44, call: 0.635 },
  11: { push: 0.46, call: 0.658 },
  12: { push: 0.49, call: 0.682 },
  13: { push: 0.511, call: 0.7 },
  14: { push: 0.525, call: 0.716 },
  15: { push: 0.543, call: 0.737 },
  16: { push: 0.567, call: 0.751 },
  17: { push: 0.576, call: 0.761 },
  18: { push: 0.586, call: 0.773 },
  19: { push: 0.595, call: 0.788 },
  20: { push: 0.602, call: 0.795 },
  21: { push: 0.623, call: 0.803 },
  22: { push: 0.631, call: 0.811 },
  23: { push: 0.633, call: 0.82 },
  24: { push: 0.638, call: 0.827 },
  25: { push: 0.647, call: 0.83 },
};

const MIN_BB = 2;
/** Above this effective stack, push/fold no longer dominates — use normal
 * (open-raise, keep-behind) strategy instead. */
export const PUSH_FOLD_MAX_BB = 25;

function lookup(effBB: number): { push: number; call: number } {
  const clamped = Math.max(MIN_BB, Math.min(PUSH_FOLD_MAX_BB, effBB));
  const lo = Math.floor(clamped);
  const hi = Math.ceil(clamped);
  const a = NASH[lo];
  const b = NASH[hi];
  if (!a) return NASH[MIN_BB];
  if (lo === hi || !b) return a;
  const t = clamped - lo;
  return { push: a.push + (b.push - a.push) * t, call: a.call + (b.call - a.call) * t };
}

/** True when the effective stack is shallow enough that shove-or-fold is the
 * right preflop game (roughly <= 12-15bb depending on how many still act). */
export function inPushFoldZone(effBB: number, playersYetToAct: number): boolean {
  // Deeper cutoff heads-up (shove/fold stays sound short-handed), shallower
  // multiway (more callers behind = shove/fold breaks down sooner). Kept
  // conservative so normal (deep) stacks still play postflop — this only
  // engages when a stack is genuinely short (mostly tournament spots).
  const cutoff = playersYetToAct <= 1 ? 16 : playersYetToAct === 2 ? 12 : 10;
  return effBB <= cutoff;
}

/**
 * Nash percentile threshold to OPEN-SHOVE at this effective stack. Heads-up is
 * the baked HU value; with more players yet to act the range tightens (each
 * extra live player behind ~ +0.045 pctile — the standard multiway direction).
 * Returns null above the push/fold zone (caller falls back to open-raise logic).
 */
export function nashPushPctile(effBB: number, playersYetToAct: number): number | null {
  if (effBB > PUSH_FOLD_MAX_BB) return null;
  const base = lookup(effBB).push;
  const extra = Math.max(0, playersYetToAct - 1);
  return Math.min(0.99, base + extra * 0.045);
}

/**
 * Nash percentile threshold to CALL an all-in shove at this effective stack.
 * More shovers/players still to act behind you => call tighter.
 */
export function nashCallPctile(effBB: number, playersYetToAct: number = 1): number {
  const base = lookup(effBB).call;
  const extra = Math.max(0, playersYetToAct - 1);
  return Math.min(0.99, base + extra * 0.05);
}

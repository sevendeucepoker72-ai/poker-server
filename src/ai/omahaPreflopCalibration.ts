// ============================================================================
// 5- and 6-card Omaha pre-flop calibration
// (.online bots review 2026-11-04, equity-variants C6).
//
// AIPlayer.getOmahaPreflopStrength's heuristic score was calibrated on 4-card
// Omaha (u = score * 1.15 + 0.10, clamped to [0.10, 1]) and the same mapping
// ran on 5- and 6-card hands, which score higher: early position cleared 12.6%
// and 16.0% of hands against 6.6% for 4-card Omaha, and the 3-bet and 4-bet
// lines cleared 2-5 times the 4-card share. These knots quantile-match the
// UNCLAMPED 5- and 6-card u onto the 4-card OUTPUT distribution, so every
// shared threshold clears the same share of dealt hands as 4-card Omaha
// (measured: >=0.85 6.5% / 6.5% / 6.9%, >=0.72 20.5% / 20.7% / 20.9% for 4, 5
// and 6 cards). 4-card Omaha does not use them and is unchanged.
//
// Built by exact enumeration of every 4-, 5- and 6-card hand (270,725 /
// 2,598,960 / 20,358,520) through the heuristic with its clamp removed; grid
// 2% steps to 90%, 0.5% to 99%, then 0.1%; each knot is [u at quantile p,
// 4-card output at quantile p], trimmed once the output reaches 1. Committed
// literals: deterministic, about 1 µs per call. Regenerate with
// `npx ts-node -T gen-omaha-preflop-knots.ts` (repo root; `VERIFY=1` checks).
// The mapping is monotone, so the order of hands within 5- and 6-card Omaha
// is unchanged.
// ============================================================================

/** [u, calibrated strength] knots for 5-card Omaha; x strictly increasing, y non-decreasing. */
export const OMAHA5_KNOTS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0.261, 0.307], [0.399, 0.399], [0.422, 0.445], [0.4335, 0.4565], [0.445, 0.468], [0.4565, 0.4795],
  [0.4713, 0.491], [0.4795, 0.514], [0.4877, 0.5288], [0.5025, 0.537], [0.5222, 0.537], [0.537, 0.537],
  [0.5452, 0.5403], [0.56, 0.56], [0.5715, 0.56], [0.583, 0.56], [0.5945, 0.5715], [0.606, 0.5715],
  [0.6175, 0.5715], [0.629, 0.583], [0.6323, 0.5929], [0.6421, 0.5945], [0.652, 0.6044], [0.6602, 0.6076],
  [0.6651, 0.6175], [0.675, 0.6175], [0.6849, 0.629], [0.6865, 0.6405], [0.6996, 0.6504], [0.7095, 0.6635],
  [0.7243, 0.675], [0.7325, 0.6783], [0.7424, 0.6865], [0.7555, 0.6996], [0.7686, 0.7095], [0.7851, 0.7243],
  [0.7982, 0.7424], [0.8146, 0.7539], [0.8327, 0.7703], [0.8574, 0.7867], [0.8771, 0.8048], [0.8836, 0.8114],
  [0.8886, 0.8146], [0.8935, 0.8212], [0.8968, 0.8261], [0.905, 0.8344], [0.9116, 0.8393], [0.9181, 0.8524],
  [0.9264, 0.8557], [0.9346, 0.8689], [0.9461, 0.8705], [0.9543, 0.8787], [0.9625, 0.8902], [0.9756, 0.8951],
  [0.9855, 0.9083], [0.9937, 0.9231], [1.0101, 0.9346], [1.0348, 0.9625], [1.0676, 0.9855], [1.0808, 0.9871],
  [1.0906, 0.997], [1.1021, 1],
] as const);

/** [u, calibrated strength] knots for 6-card Omaha; x strictly increasing, y non-decreasing. */
export const OMAHA6_KNOTS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0.261, 0.307], [0.399, 0.399], [0.4105, 0.422], [0.422, 0.445], [0.4335, 0.4565], [0.445, 0.468],
  [0.4549, 0.4795], [0.468, 0.491], [0.4795, 0.5288], [0.4943, 0.537], [0.5025, 0.537], [0.5206, 0.5403],
  [0.5271, 0.5485], [0.5403, 0.56], [0.5551, 0.56], [0.5682, 0.56], [0.5781, 0.5715], [0.5945, 0.5715],
  [0.6159, 0.5715], [0.629, 0.583], [0.6421, 0.5929], [0.652, 0.5945], [0.6635, 0.6044], [0.675, 0.6076],
  [0.6816, 0.6175], [0.6865, 0.6175], [0.7013, 0.629], [0.7095, 0.6405], [0.7161, 0.6504], [0.7309, 0.652],
  [0.7325, 0.6635], [0.7456, 0.675], [0.7555, 0.6783], [0.767, 0.6865], [0.7801, 0.6996], [0.7916, 0.7095],
  [0.8081, 0.7243], [0.8245, 0.7424], [0.8508, 0.7539], [0.8738, 0.7703], [0.8951, 0.7867], [0.9132, 0.8048],
  [0.9198, 0.8114], [0.928, 0.8146], [0.9346, 0.8212], [0.9411, 0.8261], [0.9494, 0.8344], [0.9592, 0.8393],
  [0.9625, 0.8524], [0.9724, 0.8557], [0.9839, 0.8689], [0.9855, 0.8705], [0.9937, 0.8787], [1.0085, 0.8902],
  [1.0134, 0.8951], [1.0282, 0.9083], [1.043, 0.9231], [1.0644, 0.9346], [1.0906, 0.9625], [1.135, 0.9855],
  [1.1416, 0.9871], [1.1564, 0.997], [1.1629, 1],
] as const);

/**
 * Calibrated pre-flop strength of an n-card Omaha hand (n >= 6 uses the
 * 6-card knots, otherwise the 5-card knots) from its UNCLAMPED u = score *
 * 1.15 + 0.10. Piecewise-linear between knots; below the first knot the first
 * y, above the last the last y. NaN for a non-finite u (the caller then keeps
 * the old clamp).
 */
export function calibrateOmahaPreflop(n: number, u: number): number {
  if (!Number.isFinite(u)) return NaN;
  const kn = n >= 6 ? OMAHA6_KNOTS : OMAHA5_KNOTS;
  if (u <= kn[0][0]) return kn[0][1];
  const last = kn[kn.length - 1];
  if (u >= last[0]) return last[1];
  let lo = 0;
  let hi = kn.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kn[mid][0] <= u) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = kn[lo];
  const [x1, y1] = kn[hi];
  return y0 + ((y1 - y0) * (u - x0)) / (x1 - x0);
}

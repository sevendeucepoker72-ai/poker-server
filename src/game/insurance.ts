/**
 * All-in insurance (cashout) — pure pricing + settlement math.
 *
 * When a player is all-in with cards still to come, they may "lock in" a
 * guaranteed cashout instead of gambling on the runout. The house is the
 * counterparty: it buys the player's equity at a 10% discount, so the feature
 * is +EV for the house over time while giving the player variance reduction.
 *
 * These are pure functions so the money math can be unit-tested independently
 * of the socket/engine plumbing (see tests/InsuranceSettlement.test.ts).
 */

/**
 * Cashout price = 90% of the player's equity share of the pot. `equity` is a
 * probability in [0,1]; `pot` is the total pot the player is eligible for
 * (v1 offers insurance only heads-up, so eligible pot === total pot — no side
 * pots to mis-price). The 10% haircut is the house margin.
 */
export function insuranceCashoutAmount(pot: number, equity: number): number {
  const p = Math.max(0, Math.floor(Number(pot) || 0));
  const e = Math.min(1, Math.max(0, Number(equity) || 0));
  return Math.round(p * e * 0.9);
}

/**
 * Post-hand settlement delta applied to the insured player's live stack. After
 * normal pot distribution the player has received `actualWon` (0 if they lost);
 * insurance guarantees they instead end with exactly `cashout` from the pot, so
 * the adjustment is (cashout - actualWon):
 *   - delta > 0  → they were outdrawn (or won less than the lock-in); the house
 *                  pays the difference (a play-money mint).
 *   - delta < 0  → they won more than the lock-in; the house collects the margin
 *                  (a play-money sink).
 *   - delta = 0  → the runout matched the lock-in exactly.
 */
export function insuranceSettlementDelta(cashout: number, actualWon: number): number {
  return Math.round((Number(cashout) || 0) - (Number(actualWon) || 0));
}

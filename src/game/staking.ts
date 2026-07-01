/**
 * Staking settlement math (Batch 5c, 2026-07-01 .online audit).
 *
 * A player can SELL a percentage of their tournament action via a staking
 * offer; backers pay upfront (handled at buy time) and are entitled to their
 * pct of the seller's eventual prize. Before this existed, backers paid real
 * chips and NEVER received winnings.
 *
 * The split must conserve chips exactly: the seller keeps whatever share of the
 * prize was not sold, and each payable backer receives their pct. This module
 * is the pure, deterministic core (no DB / no I/O) so it can be unit-tested.
 */

export interface StakingBacker {
  userId: number; // resolved local user id; 0/negative = unresolvable
  name: string;
  pct: number;    // percentage of the seller's action this backer holds
}

export interface StakingSplit {
  sellerAmount: number;
  backerPayouts: { userId: number; name: string; pct: number; amount: number }[];
}

/**
 * Split a tournament `payout` between the seller and their backers.
 *
 * HARD INVARIANT: `sellerAmount + Σ backerPayouts.amount === payout` for ANY
 * input — no chips are minted or destroyed. Properties:
 *  - Backer amounts are floored; the seller receives the exact remainder.
 *  - Oversold action (Σpct > 100) is scaled down to 100% so backers can never
 *    collectively receive more than the whole prize.
 *  - An unresolvable backer (userId <= 0) or a zero/rounded-to-zero share is
 *    NOT paid; that portion stays with the seller (still conserved).
 */
export function computeStakingSplit(payout: number, backers: StakingBacker[]): StakingSplit {
  const safePayout = Math.max(0, Math.floor(Number(payout) || 0));
  const soldPct = backers.reduce((s, b) => s + Math.max(0, Number(b.pct) || 0), 0);
  const scale = soldPct > 100 ? 100 / soldPct : 1;
  const backerPayouts: StakingSplit['backerPayouts'] = [];
  let paidToBackers = 0;
  for (const b of backers) {
    const pct = Math.max(0, Number(b.pct) || 0);
    if (b.userId <= 0 || pct <= 0) continue; // unresolvable/zero → stays with seller
    const amount = Math.floor(safePayout * (pct * scale) / 100);
    if (amount <= 0) continue;
    backerPayouts.push({ userId: b.userId, name: b.name, pct, amount });
    paidToBackers += amount;
  }
  return { sellerAmount: safePayout - paidToBackers, backerPayouts };
}

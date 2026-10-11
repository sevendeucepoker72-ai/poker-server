/**
 * 2026-10-11 (.online R2, S1) — staking with ESCROW (TOURNEY-8 / ECON-15 /
 * APPUI-22, contract C4). Pure planning: no DB, no I/O.
 *
 * Before: createStake took a free-text tournament NAME; buyStake paid the
 * SELLER immediately; settlement matched offers by tournament UUID + winner
 * only — so a backer's chips went to the seller at once and the backer was
 * never paid (the names never matched), and nothing was ever refunded.
 *
 * Now (C4): an offer names the UUID of a tournament the seller is REGISTERED
 * in; a backer's payment is ESCROWED (deducted from him, credited to nobody);
 * at settlement:
 *   - the seller CASHES (payout > 0): each backer is paid his share of the
 *     payout (the computeStakingSplit rule — conservation-exact) and the escrow is
 *     RELEASED to the seller (he sold that action);
 *   - otherwise — the tournament cancelled, the seller unregistered / never
 *     made the field (no-show), busted out of the money, or the tournament
 *     died with the process — every backer gets his escrow back.
 * Every credit carries an idempotency key for the prize ledger (paid once).
 */

export interface EscrowBacker {
  userId: number;
  name: string;
  pct: number;
  /** Chips he paid into escrow for this share. */
  paid: number;
}

export interface EscrowOffer {
  id: string;
  sellerId: number;
  backers: EscrowBacker[];
}

export interface PlannedCredit {
  key: string;
  userId: number;
  amount: number;
  kind: 'STAKING_PAYOUT' | 'STAKING_ESCROW_RELEASE' | 'STAKING_REFUND';
  details: Record<string, unknown>;
}

const whole = (n: unknown): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** A backers JSON array as stored (legacy rows lack `paid` / `userId`): only well-formed entries. */
export function normalizeBackers(raw: unknown): EscrowBacker[] {
  if (!Array.isArray(raw)) return [];
  const out: EscrowBacker[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const r = b as Record<string, unknown>;
    out.push({ userId: Number(r.userId) || 0, name: String(r.name || ''), pct: Number(r.pct) || 0, paid: whole(r.paid) });
  }
  return out;
}

/** Every backer's escrow back (cancel / no-show / unregister / bust out of the money / died with the process). */
export function planEscrowRefund(offer: EscrowOffer, reason: string): PlannedCredit[] {
  return offer.backers
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.userId > 0 && b.paid > 0)
    .map(({ b, i }) => ({
      key: `stake:${offer.id}:refund:${i}`,
      userId: b.userId,
      amount: b.paid,
      kind: 'STAKING_REFUND' as const,
      details: { offerId: offer.id, sellerId: offer.sellerId, pct: b.pct, reason },
    }));
}

/**
 * The seller CASHED for `sellerPayout` with these offers: what each backer
 * gets (his share of the payout), what the seller gets of his OWN payout (the
 * unsold remainder) and the escrow released to him. Σ = payout + Σ escrow
 * (nothing minted, nothing lost). `sellerPrizeKey` keys the seller's prize.
 */
export function planCashedSettlement(
  offers: EscrowOffer[], sellerId: number, sellerPayout: number, sellerPrizeKey: string,
  ctx: Record<string, unknown> = {},
): { sellerPrize: PlannedCredit | null; credits: PlannedCredit[] } {
  const payout = whole(sellerPayout);
  const backers = offers.flatMap((o) => o.backers.map((b, i) => ({ o, b, i })));
  // The SAME conservation-exact rule as computeStakingSplit (tested in
  // TournamentEconomy.test.ts): oversold action scaled to 100%, backer amounts
  // floored, an unresolvable / zero share left with the seller. Done per
  // backer here so each credit keeps its own idempotency key.
  const soldPct = backers.reduce((s, { b }) => s + Math.max(0, Number(b.pct) || 0), 0);
  const scale = soldPct > 100 ? 100 / soldPct : 1;
  const credits: PlannedCredit[] = [];
  let paidToBackers = 0;
  for (const { o, b, i } of backers) {
    const pct = Math.max(0, Number(b.pct) || 0);
    if (b.userId <= 0 || pct <= 0) continue;
    const amount = Math.floor(payout * (pct * scale) / 100);
    if (amount <= 0) continue;
    paidToBackers += amount;
    credits.push({
      key: `stake:${o.id}:share:${i}`, userId: b.userId, amount, kind: 'STAKING_PAYOUT',
      details: { ...ctx, offerId: o.id, sellerId, pct: b.pct },
    });
  }
  // Identical to computeStakingSplit's seller remainder (asserted in tests).
  const sellerAmount = payout - paidToBackers;
  for (const o of offers) {
    const escrow = o.backers.reduce((s, b) => s + (b.userId > 0 ? b.paid : 0), 0);
    if (escrow > 0) {
      credits.push({
        key: `stake:${o.id}:release`, userId: sellerId, amount: escrow, kind: 'STAKING_ESCROW_RELEASE',
        details: { ...ctx, offerId: o.id },
      });
    }
  }
  const sellerPrize = sellerAmount > 0
    ? { key: sellerPrizeKey, userId: sellerId, amount: sellerAmount, kind: 'STAKING_PAYOUT' as const, details: { ...ctx, staked: credits.length > 0 } }
    : null;
  return { sellerPrize, credits };
}

/** C4 — an offer the seller may create: percent 1..100 (whole), price 1..1,000,000 per percent (whole). */
export function validateStakeOffer(input: { percent?: unknown; pricePerPercent?: unknown; totalPct?: unknown; pricePerPct?: unknown }):
  { ok: true; percent: number; pricePerPercent: number } | { ok: false; code: 'stake_invalid_offer' | 'stake_invalid_price' } {
  const pctRaw = input.percent !== undefined ? input.percent : input.totalPct;
  const priceRaw = input.pricePerPercent !== undefined ? input.pricePerPercent : input.pricePerPct;
  const percent = Number(pctRaw);
  const price = Number(priceRaw);
  if (typeof pctRaw !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 100) return { ok: false, code: 'stake_invalid_offer' };
  if (typeof priceRaw !== 'number' || !Number.isInteger(price) || price < 1 || price > 1_000_000) return { ok: false, code: 'stake_invalid_price' };
  return { ok: true, percent, pricePerPercent: price };
}

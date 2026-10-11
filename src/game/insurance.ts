/**
 * All-in insurance (cashout) — pure pricing + settlement math.
 *
 * When a player is all-in with cards still to come, they may "lock in" a
 * guaranteed cashout instead of gambling on the runout. The house is the
 * counterparty: it buys the player's equity at a 10% discount, so the feature
 * is +EV for the house over time while giving the player variance reduction.
 *
 * These are pure functions so the money math can be unit-tested independently
 * of the socket/engine plumbing (see tests/InsuranceSettlement.test.ts and the
 * end-to-end tests/insuranceEquity.test.ts).
 */
import { Card } from './Card';
import { headsUpEquity, hashSeed } from './handEquity';

/**
 * Cashout price = 90% of the player's equity share of the pot. `equity` is a
 * probability in [0,1] — NEVER a percent (2026-10-11 ECON-1: a 0-100 value was
 * clamped to 1 and every quote paid 90% of the pot); `pot` is the CONTESTED
 * pot (the pots both remaining players are eligible for). The 10% haircut is
 * the house margin.
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

/**
 * The per-player game-state quote (R1 contract #1): `insuranceQuote` is
 * `null` or exactly this (integers; equityPct 0-100). `expiresAt` (epoch ms)
 * is additive — when the decision window closes and the board is run out.
 */
export interface InsuranceQuote {
  handNumber: number;
  cashout: number;
  equityPct: number;
  pot: number;
  expiresAt: number;
}

/** Monte-Carlo runouts for a pre-flop quote (exact enumeration needs none). */
export const INSURANCE_PREFLOP_SAMPLES = 20_000;

/**
 * Price the insured seat's equity against the opponent's ACTUAL hole cards on
 * the current board: exact enumeration with <= 2 board cards to come, a
 * DETERMINISTIC Monte Carlo pre-flop (seeded by table + hand + the cards, so
 * the same spot always gets the same quote). Returns null when there is nothing
 * worth insuring: a malformed deal, an empty contested pot, a cashout of 0 or
 * a hand that cannot lose (100% — insuring it could only cost the player).
 */
export function priceInsuranceQuote(args: {
  tableId: string;
  handNumber: number;
  hero: readonly Card[];
  villain: readonly Card[];
  board: readonly Card[];
  contestedPot: number;
  expiresAt: number;
}): InsuranceQuote | null {
  const { tableId, handNumber, hero, villain, board, contestedPot, expiresAt } = args;
  const pot = Math.max(0, Math.floor(Number(contestedPot) || 0));
  if (pot <= 0) return null;
  let equity: number;
  try {
    const seed = hashSeed(`${tableId}|${handNumber}|${[...hero, ...villain, ...board].map((c) => `${c.rank}.${c.suit}`).join(',')}`);
    equity = headsUpEquity(hero, villain, board, { seed, samples: INSURANCE_PREFLOP_SAMPLES }).equity;
  } catch {
    return null;
  }
  if (!(equity > 0) || equity >= 1) return null;
  const cashout = insuranceCashoutAmount(pot, equity);
  if (cashout <= 0) return null;
  return {
    handNumber,
    cashout,
    equityPct: Math.max(0, Math.min(100, Math.round(equity * 100))),
    pot,
    expiresAt: Math.floor(expiresAt),
  };
}

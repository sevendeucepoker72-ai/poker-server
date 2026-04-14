import { Card } from './Card';
import { evaluateHand, compareTo, HandResult } from './HandEvaluator';

/** Physical seat capacity of the table — used for clockwise modulo math.
 *  Must match MAX_SEATS in PokerTable.ts. Hardcoded here to avoid a circular import. */
export const TABLE_SEAT_COUNT = 9;

export interface SeatInfo {
  seatIndex: number;
  chipCount: number;
  totalInvestedThisHand: number;
  folded: boolean;
  allIn: boolean;
  holeCards: Card[];
  state: 'empty' | 'occupied' | 'sitting_out';
}

export interface Pot {
  amount: number;
  eligibleSeatIndices: number[];
  name: string;
}

export interface PotWinResult {
  seatIndex: number;
  amount: number;
  potName: string;
  handResult?: HandResult;
}

export interface AwardPotsResult {
  /** Total chips won per seat (across all pots) */
  winnings: Map<number, number>;
  /** Per-pot breakdown: who won what from which pot */
  perPot: PotWinResult[];
}

/**
 * TDA Rules 42-43: Side pot management.
 * - Multiple all-ins at different amounts create separate pots.
 * - Folded players' contributions go to the correct pot as dead money.
 * - Odd chip goes to first player clockwise from dealer (TDA Rule 43).
 */
export class SidePotManager {
  /**
   * Calculate pots based on each seat's totalInvestedThisHand.
   *
   * TDA-correct algorithm: side pots are created ONLY by all-in players.
   * Folded players who invested partial amounts (e.g., posted blinds and then
   * folded) do NOT create new tier boundaries — their dead money flows into
   * the lowest tier they belong to. This avoids the bug where 4 players each
   * folding at different invested amounts produces 4 phantom side pots.
   *
   * Tier (cap) levels = unique all-in amounts of NON-FOLDED players, plus the
   * highest invested amount among non-folded players (the top of the live
   * action). Folded players contribute their chips to whichever tier their
   * total investment falls into, but never create a new tier themselves.
   */
  calculatePots(seats: SeatInfo[]): Pot[] {
    const investedSeats = seats.filter(
      s => s.state === 'occupied' && s.totalInvestedThisHand > 0
    );

    if (investedSeats.length === 0) return [];

    // Cap levels come from all-in (non-folded) players + the highest non-folded
    // investment. Folded players DO NOT create cap levels.
    const allInCaps = investedSeats
      .filter(s => s.allIn && !s.folded)
      .map(s => s.totalInvestedThisHand);

    const nonFolded = investedSeats.filter(s => !s.folded);

    // topCap must cover ALL invested chips — including folded players' dead money.
    // A folded player who raised 114 then folded still has 114 chips in the pot
    // that need a tier to flow into. Using only non-folded max would lose those chips.
    const topCap = Math.max(...investedSeats.map(s => s.totalInvestedThisHand));

    const capLevels = [...new Set([...allInCaps, topCap])].sort((a, b) => a - b);

    const pots: Pot[] = [];
    let previousLevel = 0;

    for (let i = 0; i < capLevels.length; i++) {
      const currentLevel = capLevels[i];
      const increment = currentLevel - previousLevel;

      if (increment <= 0) continue;

      let potAmount = 0;
      const eligible: number[] = [];

      for (const seat of investedSeats) {
        // Each seat contributes up to 'increment' for this tier (capped by
        // their actual investment minus what they've already put into lower
        // tiers).
        const seatContribution = Math.min(
          Math.max(0, seat.totalInvestedThisHand - previousLevel),
          increment
        );
        if (seatContribution > 0) {
          potAmount += seatContribution;
          // Only non-folded players are eligible to win.
          // A player is also only eligible for tiers they actually filled —
          // i.e., their totalInvestedThisHand >= currentLevel.
          if (!seat.folded && seat.totalInvestedThisHand >= currentLevel) {
            eligible.push(seat.seatIndex);
          }
        }
      }

      // If no one is eligible (all contributors folded), award the dead money
      // to ALL non-folded players still in the hand — they inherit it.
      if (potAmount > 0 && eligible.length === 0) {
        const nonFoldedInHand = investedSeats
          .filter(s => !s.folded)
          .map(s => s.seatIndex);
        eligible.push(...nonFoldedInHand);
      }

      if (potAmount > 0) {
        const potName = pots.length === 0 ? 'Main Pot' : `Side Pot ${pots.length}`;
        pots.push({
          amount: potAmount,
          eligibleSeatIndices: eligible,
          name: potName,
        });
      }

      previousLevel = currentLevel;
    }

    // Merge adjacent pots with identical eligible player sets.
    // Multiple all-in tiers can produce separate pots that share the same
    // eligible players (e.g., after other players fold). Merging them avoids
    // confusing displays like "5 side pots" when logically there are only 2.
    const merged: Pot[] = [];
    for (const pot of pots) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.eligibleSeatIndices.length === pot.eligibleSeatIndices.length &&
        prev.eligibleSeatIndices.every(idx => pot.eligibleSeatIndices.includes(idx))
      ) {
        prev.amount += pot.amount;
      } else {
        merged.push({ ...pot, eligibleSeatIndices: [...pot.eligibleSeatIndices] });
      }
    }
    // Re-name after merging
    merged.forEach((p, i) => {
      p.name = i === 0 ? 'Main Pot' : `Side Pot ${i}`;
    });

    // Consistency check: total of pots must equal total invested
    const potTotal = merged.reduce((sum, p) => sum + p.amount, 0);
    const expectedTotal = investedSeats.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
    if (potTotal !== expectedTotal) {
      console.error(
        `[SidePotManager] Pot total mismatch: calculated ${potTotal} but expected ${expectedTotal}. ` +
        `Seats: ${JSON.stringify(investedSeats.map(s => ({ idx: s.seatIndex, invested: s.totalInvestedThisHand, folded: s.folded, allIn: s.allIn })))}`
      );
      // Adjust the last pot to absorb the difference rather than crashing
      const diff = expectedTotal - potTotal;
      if (merged.length > 0 && diff > 0) {
        merged[merged.length - 1].amount += diff;
      }
    }

    return merged;
  }

  /**
   * Award pots to winners.
   * For each pot, evaluate hands of eligible players.
   * Split ties evenly, odd chip goes to first winner clockwise from dealer.
   */
  awardPots(
    seats: SeatInfo[],
    communityCards: Card[],
    dealerSeat: number,
    evaluator?: (hole: Card[], community: Card[]) => HandResult
  ): AwardPotsResult {
    const winnings = new Map<number, number>();
    const perPot: PotWinResult[] = [];
    const pots = this.calculatePots(seats);

    // Use provided evaluator or default to standard evaluateHand
    const evalFn = evaluator || ((hole: Card[], community: Card[]): HandResult => {
      const allCards = [...hole, ...community];
      return evaluateHand(allCards);
    });

    // Memoize evaluations per seatIndex — a player's hand rank doesn't change
    // between pots, so re-evaluating for every side pot is wasteful.
    const evalCache = new Map<number, HandResult>();
    const cachedEval = (seatIdx: number, hole: Card[]): HandResult => {
      if (!evalCache.has(seatIdx)) {
        evalCache.set(seatIdx, evalFn(hole, communityCards));
      }
      return evalCache.get(seatIdx)!;
    };

    // Carry-over for orphaned (zero-eligible) pot amounts
    let orphanedCarry = 0;
    for (const pot of pots) {
      if (pot.eligibleSeatIndices.length === 0) {
        // Defensive: should never occur during normal play because
        // determineWinners() short-circuits the single-non-folded case.
        // Log it (so the bug is visible) and roll the chips into the next
        // pot rather than crashing or silently dropping them.
        console.error(
          `[SidePotManager] Orphaned pot "${pot.name}" with ${pot.amount} chips and no eligible players — ` +
          `rolling forward. seats: ${JSON.stringify(seats.map(s => ({
            idx: s.seatIndex, invested: s.totalInvestedThisHand, folded: s.folded, allIn: s.allIn
          })))}`
        );
        orphanedCarry += pot.amount;
        continue;
      }
      // Apply any carried-over orphan chips to the first eligible pot we hit
      const effectiveAmount = pot.amount + orphanedCarry;
      orphanedCarry = 0;
      // Use a local copy of the pot with the boosted amount
      const workPot: Pot = effectiveAmount === pot.amount ? pot : {
        ...pot,
        amount: effectiveAmount,
      };

      if (workPot.eligibleSeatIndices.length === 1) {
        // Only one eligible player, they win the pot
        const winner = workPot.eligibleSeatIndices[0];
        winnings.set(winner, (winnings.get(winner) || 0) + workPot.amount);
        perPot.push({ seatIndex: winner, amount: workPot.amount, potName: workPot.name });
        continue;
      }

      // Evaluate hands for all eligible players (using per-seat cache)
      const handResults: { seatIndex: number; result: HandResult }[] = [];
      for (const seatIdx of workPot.eligibleSeatIndices) {
        const seat = seats.find(s => s.seatIndex === seatIdx);
        if (!seat || seat.holeCards.length === 0) continue;

        const result = cachedEval(seatIdx, seat.holeCards);
        handResults.push({ seatIndex: seatIdx, result });
      }

      if (handResults.length === 0) {
        // No evaluable hands — roll forward like an orphan
        orphanedCarry += workPot.amount;
        continue;
      }

      // Find the best hand
      handResults.sort((a, b) => compareTo(b.result, a.result));
      const bestResult = handResults[0].result;

      // Find all players who tie with the best hand
      const winners = handResults.filter(
        hr => compareTo(hr.result, bestResult) === 0
      );

      // Split pot among winners
      const share = Math.floor(workPot.amount / winners.length);
      let remainder = workPot.amount - share * winners.length;

      // TDA Rule 60: Odd chip goes to first winner clockwise from dealer.
      // Use the physical seat count (TABLE_SEAT_COUNT), NOT seats.length —
      // `seats` is filtered to occupied/non-eliminated, and using its length
      // for modulo math against raw seat indices would corrupt the ordering
      // on sparse seating.
      const orderedWinners = SidePotManager.orderClockwiseFromDealer(
        winners.map(w => w.seatIndex),
        dealerSeat,
        TABLE_SEAT_COUNT
      );

      for (const winnerIdx of orderedWinners) {
        let amount = share;
        if (remainder > 0) {
          amount += 1;
          remainder--;
        }
        winnings.set(winnerIdx, (winnings.get(winnerIdx) || 0) + amount);
        perPot.push({ seatIndex: winnerIdx, amount, potName: workPot.name });
      }
    }

    // If chips are still orphaned after processing all pots, log loudly.
    // This indicates an upstream invariant violation but at least we don't crash.
    if (orphanedCarry > 0) {
      console.error(`[SidePotManager] ${orphanedCarry} chips orphaned after all pots processed.`);
    }

    return { winnings, perPot };
  }

  /**
   * Order seat indices clockwise from dealer position.
   * `totalSeats` MUST be the physical capacity (TABLE_SEAT_COUNT), not a
   * filtered length. Exposed as `static` so variant code (e.g., OmahaTable)
   * can reuse it for hi-lo split distribution.
   */
  public static orderClockwiseFromDealer(
    seatIndices: number[],
    dealerSeat: number,
    totalSeats: number = TABLE_SEAT_COUNT
  ): number[] {
    return [...seatIndices].sort((a, b) => {
      const distA = (a - dealerSeat + totalSeats) % totalSeats;
      const distB = (b - dealerSeat + totalSeats) % totalSeats;
      return distA - distB;
    });
  }

  /**
   * Get pot details for display.
   */
  getPotsForDisplay(seats: SeatInfo[]): Pot[] {
    return this.calculatePots(seats);
  }
}

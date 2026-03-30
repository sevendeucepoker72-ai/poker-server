import { Card } from './Card';
import { evaluateHand, compareTo, HandResult } from './HandEvaluator';

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

/**
 * TDA Rules 42-43: Side pot management.
 * - Multiple all-ins at different amounts create separate pots.
 * - Folded players' contributions go to the correct pot as dead money.
 * - Odd chip goes to first player clockwise from dealer (TDA Rule 43).
 */
export class SidePotManager {
  /**
   * Calculate pots based on each seat's totalInvestedThisHand.
   * Collects all unique investment levels, builds a pot for each level.
   * Folded players contribute dead money but are not eligible to win.
   */
  calculatePots(seats: SeatInfo[]): Pot[] {
    // Collect all unique non-zero investment levels from non-empty seats
    const investedSeats = seats.filter(
      s => s.state === 'occupied' && s.totalInvestedThisHand > 0
    );

    if (investedSeats.length === 0) return [];

    // Get unique investment levels sorted ascending
    const levels = [...new Set(investedSeats.map(s => s.totalInvestedThisHand))].sort(
      (a, b) => a - b
    );

    const pots: Pot[] = [];
    let previousLevel = 0;

    for (let i = 0; i < levels.length; i++) {
      const currentLevel = levels[i];
      const increment = currentLevel - previousLevel;

      if (increment <= 0) continue;

      let potAmount = 0;
      const eligible: number[] = [];

      for (const seat of investedSeats) {
        // Each seat contributes up to 'increment' for this pot level
        const seatContribution = Math.min(
          seat.totalInvestedThisHand - previousLevel,
          increment
        );
        if (seatContribution > 0) {
          potAmount += seatContribution;
          // Only non-folded players are eligible to win
          if (!seat.folded) {
            eligible.push(seat.seatIndex);
          }
        }
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

    return pots;
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
  ): Map<number, number> {
    const winnings = new Map<number, number>();
    const pots = this.calculatePots(seats);

    // Use provided evaluator or default to standard evaluateHand
    const evalFn = evaluator || ((hole: Card[], community: Card[]): HandResult => {
      const allCards = [...hole, ...community];
      return evaluateHand(allCards);
    });

    for (const pot of pots) {
      if (pot.eligibleSeatIndices.length === 0) {
        // Dead money - no one eligible, shouldn't happen normally
        continue;
      }

      if (pot.eligibleSeatIndices.length === 1) {
        // Only one eligible player, they win the pot
        const winner = pot.eligibleSeatIndices[0];
        winnings.set(winner, (winnings.get(winner) || 0) + pot.amount);
        continue;
      }

      // Evaluate hands for all eligible players
      const handResults: { seatIndex: number; result: HandResult }[] = [];
      for (const seatIdx of pot.eligibleSeatIndices) {
        const seat = seats.find(s => s.seatIndex === seatIdx);
        if (!seat || seat.holeCards.length === 0) continue;

        const result = evalFn(seat.holeCards, communityCards);
        handResults.push({ seatIndex: seatIdx, result });
      }

      if (handResults.length === 0) continue;

      // Find the best hand
      handResults.sort((a, b) => compareTo(b.result, a.result));
      const bestResult = handResults[0].result;

      // Find all players who tie with the best hand
      const winners = handResults.filter(
        hr => compareTo(hr.result, bestResult) === 0
      );

      // Split pot among winners
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;

      // TDA Rule 43: Odd chip goes to first winner clockwise from dealer
      const orderedWinners = this.orderClockwiseFromDealer(
        winners.map(w => w.seatIndex),
        dealerSeat,
        seats.length
      );

      for (const winnerIdx of orderedWinners) {
        let amount = share;
        if (remainder > 0) {
          amount += 1;
          remainder--;
        }
        winnings.set(winnerIdx, (winnings.get(winnerIdx) || 0) + amount);
      }
    }

    return winnings;
  }

  /**
   * Order seat indices clockwise from dealer position.
   */
  private orderClockwiseFromDealer(
    seatIndices: number[],
    dealerSeat: number,
    totalSeats: number
  ): number[] {
    return seatIndices.sort((a, b) => {
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

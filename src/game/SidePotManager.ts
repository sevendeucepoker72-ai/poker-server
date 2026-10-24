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
  /**
   * 2026-10-21 (gameplay F1/F2) — the part of totalInvestedThisHand that is a
   * DEAD blind (missed-blind debt posted at the deal or by Post Blinds): it is
   * in the pot but is not a bet. Optional (absent = 0). See calculatePots.
   */
  deadMoney?: number;
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
   * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F4) — the chips a
   * FOLDED seat put in that no seat still in the hand can ever win: when EVERY
   * contender (occupied, not folded — PokerTable passes a seat with no cards
   * as folded, as determineWinners does) is ALL-IN, each folded seat's LIVE investment (total - dead money) above
   * the largest contender's live investment is an uncalled bet and goes back
   * to it. Evidence hand 11 (9-player Sit & Go): the big blind folded with a
   * free check facing two short all-ins; the 105 of his big blind nobody
   * matched went to the bigger all-in's side pot (calculatePots' orphan rule).
   * A contender that is NOT all-in can win every tier (F1/F2 eligibility), so
   * nothing is returned then (the F22 leaver rule: his unmatched bet stays
   * dead money for the live seat). Dead money always stays in the pot.
   * Pure: returns [{seatIndex, amount}] (amount > 0), the caller moves the chips.
   *
   * Review fix-up (2026-10-24) — ONLY the part no other seat matched: the
   * refund is the folded seat's live investment above the LARGER of the top
   * contender's live investment and every OTHER folded seat's live investment.
   * Chips another folded seat matched were CALLED (two deep players built a
   * side pot on the flop, then both folded on the turn with all-ins left): they
   * stay with calculatePots' existing rule (the orphan tier to the
   * most-invested contender, as on e038f7b) and are never logged 'uncalled'.
   * Hand 11 is unchanged (the big blind is the only seat above the all-ins).
   */
  static unmatchedFoldedExcess(seats: SeatInfo[]): Array<{ seatIndex: number; amount: number }> {
    const occupied = seats.filter((s) => s.state === 'occupied');
    const isFolded = (s: SeatInfo) => !!s.folded;
    const deadOf = (s: SeatInfo): number =>
      Math.max(0, Math.min(s.totalInvestedThisHand, Math.floor(Number(s.deadMoney) || 0)));
    const liveOf = (s: SeatInfo): number => s.totalInvestedThisHand - deadOf(s);
    const contenders = occupied.filter((s) => !isFolded(s));
    if (contenders.length === 0 || contenders.some((s) => !s.allIn)) return [];
    const top = Math.max(...contenders.map(liveOf));
    const folded = occupied.filter(isFolded);
    const out: Array<{ seatIndex: number; amount: number }> = [];
    for (const s of folded) {
      // The highest live bet of any OTHER folded seat: what of his bet was matched (called) by a folder.
      let matchedByFolder = 0;
      for (const o of folded) if (o !== s) matchedByFolder = Math.max(matchedByFolder, liveOf(o));
      const excess = liveOf(s) - Math.max(top, matchedByFolder);
      if (excess > 0) out.push({ seatIndex: s.seatIndex, amount: excess });
    }
    return out;
  }

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
   *
   * 2026-10-21 (gameplay F1/F2) — three rules fixed:
   *  - ELIGIBILITY: a live seat that is NOT all-in is never capped — it has
   *    matched every bet (or can still), so it contests EVERY tier, including
   *    one built only from a folded seat's chips above it. Only an all-in seat
   *    is capped at its own amount. The old test (`invested >= tier level`,
   *    and only for a seat that put chips INTO that tier) made a returning
   *    player whose dead blind lifted his total above everyone else's the ONLY
   *    eligible seat of the top (= only) tier: he won every showdown unseen.
   *  - DEAD BLINDS (`deadMoney`) are not bets: tiers, caps and eligibility are
   *    built from each seat's LIVE investment (total - dead), and all dead
   *    money forms a first pot every non-folded seat contests (the "main pot"
   *    convention — it was in the middle before anyone went all-in). It
   *    merges into the main pot whenever the eligible sets agree.
   *  - ORPHAN tier (nobody eligible = every live seat is all-in below it):
   *    only the live seat(s) that invested the most inherit it, never a short
   *    all-in that never covered it (it used to go to EVERY live seat).
   */
  calculatePots(seats: SeatInfo[], dealerSeat?: number): Pot[] {
    const investedSeats = seats.filter(
      s => s.state === 'occupied' && s.totalInvestedThisHand > 0
    );

    if (investedSeats.length === 0) return [];

    // F1/F2 — the dead part of a seat's investment (never more than it put in).
    const deadOf = (s: SeatInfo): number =>
      Math.max(0, Math.min(s.totalInvestedThisHand, Math.floor(Number(s.deadMoney) || 0)));
    const liveOf = (s: SeatInfo): number => s.totalInvestedThisHand - deadOf(s);
    // Every seat still contesting the pot (not only the ones that invested).
    const contenders = seats.filter(s => s.state === 'occupied' && !s.folded);
    const deadTotal = investedSeats.reduce((sum, s) => sum + deadOf(s), 0);

    // Cap levels come from all-in (non-folded) players + the highest non-folded
    // investment. Folded players DO NOT create cap levels.
    const allInCaps = investedSeats
      .filter(s => s.allIn && !s.folded)
      .map(s => liveOf(s));

    // topCap must cover ALL invested chips — including folded players' dead money.
    // A folded player who raised 114 then folded still has 114 chips in the pot
    // that need a tier to flow into. Using only non-folded max would lose those chips.
    const topCap = Math.max(...investedSeats.map(s => liveOf(s)));

    const capLevels = [...new Set([...allInCaps, topCap])].sort((a, b) => a - b);

    const pots: Pot[] = [];
    let previousLevel = 0;

    // F1/F2 — dead blinds: one pot, contested by every seat still in the hand.
    if (deadTotal > 0) {
      pots.push({
        amount: deadTotal,
        eligibleSeatIndices: contenders.map(s => s.seatIndex),
        name: 'Main Pot',
      });
    }

    for (let i = 0; i < capLevels.length; i++) {
      const currentLevel = capLevels[i];
      const increment = currentLevel - previousLevel;

      if (increment <= 0) continue;

      let potAmount = 0;

      for (const seat of investedSeats) {
        // Each seat contributes up to 'increment' for this tier (capped by
        // their actual LIVE investment minus what they've already put into
        // lower tiers).
        const seatContribution = Math.min(
          Math.max(0, liveOf(seat) - previousLevel),
          increment
        );
        if (seatContribution > 0) potAmount += seatContribution;
      }

      // F1 — only non-folded players are eligible to win; an ALL-IN one only
      // for tiers it filled (live investment >= this level); a live seat that
      // is not all-in for every tier (whether or not it put chips into it).
      const eligible: number[] = contenders
        .filter(s => !s.allIn || liveOf(s) >= currentLevel)
        .map(s => s.seatIndex);

      // If no one is eligible (every live seat is all-in below this level —
      // its chips came from seats that folded), the live seat(s) that invested
      // the MOST inherit it (F2: never a shorter all-in that did not cover it).
      // TDA Rule 43: orphan / odd chip goes clockwise from dealer. Order the
      // candidates clockwise so a single effectively-eligible player gets the
      // pot outright, and multi-candidate inheritance lists are consistently
      // ordered for downstream split math.
      if (potAmount > 0 && eligible.length === 0 && contenders.length > 0) {
        const most = Math.max(...contenders.map(s => liveOf(s)));
        const heirs = contenders.filter(s => liveOf(s) === most).map(s => s.seatIndex);
        const ordered = dealerSeat !== undefined
          ? SidePotManager.orderClockwiseFromDealer(heirs, dealerSeat, TABLE_SEAT_COUNT)
          : heirs;
        eligible.push(...ordered);
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
    evaluator?: (hole: Card[], community: Card[]) => HandResult,
    comparator?: (a: HandResult, b: HandResult) => number
  ): AwardPotsResult {
    const winnings = new Map<number, number>();
    const perPot: PotWinResult[] = [];
    const pots = this.calculatePots(seats, dealerSeat);

    // Use provided evaluator or default to standard evaluateHand
    const evalFn = evaluator || ((hole: Card[], community: Card[]): HandResult => {
      const allCards = [...hole, ...community];
      return evaluateHand(allCards);
    });

    // 2026-06-11 audit G2/G3: ranking comparator. Contract matches compareTo —
    // returns POSITIVE when `a` is the better (winning) hand. Default is
    // high-hand-wins. Lowball variants (2-7 Triple Draw, Razz, Badugi) inject
    // a low comparator so the best LOW hand sorts first. Previously this was
    // hardcoded to compareTo: lowball tables evaluated the low hand correctly
    // (via the evaluator) but ranked it high-wins, awarding the WORST hand.
    const cmp = comparator || compareTo;

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
        // No evaluable hands — award to first eligible player rather than orphaning
        if (workPot.eligibleSeatIndices.length > 0) {
          const fallbackWinner = workPot.eligibleSeatIndices[0];
          winnings.set(fallbackWinner, (winnings.get(fallbackWinner) || 0) + workPot.amount);
          perPot.push({ seatIndex: fallbackWinner, amount: workPot.amount, potName: workPot.name });
        } else {
          orphanedCarry += workPot.amount;
        }
        continue;
      }

      // Find the best hand (cmp: positive = better, so descending sort puts best first)
      handResults.sort((a, b) => cmp(b.result, a.result));
      const bestResult = handResults[0].result;

      // Find all players who tie with the best hand
      const winners = handResults.filter(
        hr => cmp(hr.result, bestResult) === 0
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
   * Order seat indices clockwise starting with the FIRST SEAT LEFT OF THE
   * BUTTON (the button itself is last). `totalSeats` MUST be the physical
   * capacity (TABLE_SEAT_COUNT), not a filtered length. Exposed as `static` so
   * variant code (e.g., OmahaTable) can reuse it for hi-lo split distribution.
   * 2026-10-11 (.online R2, GAME P3) — the odd chip goes to the first winner
   * left of the button (TDA); the old distance put the BUTTON first, so a
   * button that split a pot always took the odd chip.
   */
  public static orderClockwiseFromDealer(
    seatIndices: number[],
    dealerSeat: number,
    totalSeats: number = TABLE_SEAT_COUNT
  ): number[] {
    const leftOfButton = (seat: number) => (((seat - dealerSeat - 1) % totalSeats) + totalSeats) % totalSeats;
    return [...seatIndices].sort((a, b) => leftOfButton(a) - leftOfButton(b));
  }

  /**
   * Get pot details for display.
   */
  getPotsForDisplay(seats: SeatInfo[]): Pot[] {
    return this.calculatePots(seats);
  }
}

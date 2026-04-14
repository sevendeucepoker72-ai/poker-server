import { Card } from '../Card';
import { HandResult, compareTo } from '../HandEvaluator';
import { evaluateOmahaHand, evaluateOmahaHiLo, compareLowHands } from '../HandEvaluatorExtensions';
import { SeatInfo, SidePotManager, TABLE_SEAT_COUNT } from '../SidePotManager';
import {
  PokerTable,
  MAX_SEATS,
  GamePhase,
  Seat,
  TableConfig,
  HandWinResult,
  ShowdownHandInfo,
  WinnerInfo,
  LastHandResult,
  HandHistoryRecord,
} from '../PokerTable';
import { OmahaVariant } from './OmahaVariant';
import { OmahaHiLoVariant } from './OmahaHiLoVariant';
import { PokerVariant } from './PokerVariant';

/**
 * OmahaTable extends PokerTable, overriding deal and evaluation for 4 hole cards.
 * Supports both PLO and PLO8 (Hi-Lo) via the variant config.
 *
 * Key differences from standard Hold'em table:
 * - Deals 4 hole cards instead of 2
 * - Uses Omaha evaluation (must use exactly 2 hole + 3 community)
 * - Pot-limit betting (max raise = pot size)
 * - For Hi-Lo: split pot between best high and best qualifying low
 */
export class OmahaTable extends PokerTable {
  public variant: PokerVariant;
  private isHiLo: boolean;
  private numHoleCards: number;

  constructor(config: TableConfig, isHiLo: boolean = false, numHoleCards: number = 4) {
    super(config);
    this.isHiLo = isHiLo;
    this.numHoleCards = numHoleCards;
    this.variant = isHiLo ? new OmahaHiLoVariant() : new OmahaVariant();

    // Set variant properties
    if (numHoleCards === 5) {
      this.variantId = 'omaha-5';
      this.variantName = isHiLo ? '5-Card Omaha Hi-Lo' : '5-Card Omaha';
    } else if (numHoleCards === 6) {
      this.variantId = 'omaha-6';
      this.variantName = isHiLo ? '6-Card Omaha Hi-Lo' : '6-Card Omaha';
    } else {
      this.variantId = isHiLo ? 'omaha-hi-lo' : 'omaha';
      this.variantName = isHiLo ? 'Omaha Hi-Lo' : 'Pot-Limit Omaha';
    }
    this.holeCardCount = numHoleCards;
    this.bettingStructure = 'pot-limit';
  }

  /**
   * Override: deal numHoleCards (4, 5, or 6) instead of 2.
   */
  protected getHoleCardCount(): number {
    return this.numHoleCards;
  }

  /**
   * Override: use Omaha hand evaluation (exactly 2 hole + 3 community).
   */
  protected evaluatePlayerHand(holeCards: Card[], communityCards: Card[]): HandResult {
    if (communityCards.length < 3) {
      // Not enough community cards yet, use basic evaluation
      const allCards = [...holeCards, ...communityCards];
      const { evaluateHand } = require('../HandEvaluator');
      return evaluateHand(allCards);
    }
    return evaluateOmahaHand(holeCards, communityCards);
  }

  /**
   * Override: enforce pot-limit betting.
   * Max raise = current pot + call amount.
   */
  protected getMaxRaise(seatIndex: number): number {
    const seat = this.seats[seatIndex];
    const callAmount = Math.max(0, this.currentBetToMatch - seat.currentBet);
    const potAfterCall = this.getTotalPot() + callAmount;
    const maxTotal = this.currentBetToMatch + potAfterCall;
    return Math.min(maxTotal, seat.chipCount + seat.currentBet);
  }

  /**
   * Override determineWinners for Hi-Lo: split pot between high and low.
   */
  protected determineWinners(): void {
    if (!this.isHiLo) {
      // Standard Omaha (PLO) - use parent logic with our evaluatePlayerHand override
      super.determineWinners();
      return;
    }

    // Omaha Hi-Lo: split pots between best high and best qualifying low
    this.currentPhase = GamePhase.Showdown;

    // TDA Rule 41: refund uncalled top-stack excess before pot calculation
    this.refundUncalledBets();

    const seatInfos: SeatInfo[] = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated)
      .map(s => ({
        seatIndex: s.seatIndex,
        chipCount: s.chipCount,
        totalInvestedThisHand: s.totalInvestedThisHand,
        folded: s.folded,
        allIn: s.allIn,
        holeCards: s.holeCards,
        state: s.state,
      }));

    const nonFolded = seatInfos.filter(s => !s.folded);
    const results: HandWinResult[] = [];
    const showdownHands: ShowdownHandInfo[] = [];
    const winnerInfos: WinnerInfo[] = [];

    if (nonFolded.length === 1) {
      // Last player standing wins everything
      const totalPot = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      const winner = nonFolded[0];
      this.seats[winner.seatIndex].chipCount += totalPot;

      const winnerSeat = this.seats[winner.seatIndex];
      results.push({
        seatIndex: winner.seatIndex,
        playerName: winnerSeat.playerName,
        amount: totalPot,
        potName: 'Main Pot',
      });

      winnerInfos.push({
        seatIndex: winner.seatIndex,
        playerName: winnerSeat.playerName,
        chipsWon: totalPot,
        handName: 'Won by fold',
        bestFiveCards: [],
      });
    } else {
      // Evaluate all hands for showdown display
      for (const info of nonFolded) {
        const seat = this.seats[info.seatIndex];
        if (seat.holeCards.length >= 4 && this.communityCards.length >= 3) {
          const hiLo = evaluateOmahaHiLo(seat.holeCards, this.communityCards);
          const handName = hiLo.low
            ? `${hiLo.high.handName} / ${hiLo.low.handName}`
            : hiLo.high.handName;
          showdownHands.push({
            seatIndex: info.seatIndex,
            playerName: seat.playerName,
            handName,
            bestFiveCards: hiLo.high.bestFiveCards,
            holeCards: [...seat.holeCards],
          });
        }
      }

      // Calculate pots
      const pots = this.sidePotManager.calculatePots(seatInfos);

      // Carry-over for orphaned (zero-eligible) pot amounts — matches the
      // canonical SidePotManager.awardPots behaviour so chips are never lost.
      let orphanedCarry = 0;
      for (const rawPot of pots) {
        if (rawPot.eligibleSeatIndices.length === 0) {
          console.error(
            `[OmahaTable] Orphaned pot "${rawPot.name}" with ${rawPot.amount} chips and no eligible players — rolling forward.`
          );
          orphanedCarry += rawPot.amount;
          continue;
        }
        const effectiveAmount = rawPot.amount + orphanedCarry;
        orphanedCarry = 0;
        const pot = effectiveAmount === rawPot.amount ? rawPot : { ...rawPot, amount: effectiveAmount };

        if (pot.eligibleSeatIndices.length === 1) {
          const winIdx = pot.eligibleSeatIndices[0];
          this.seats[winIdx].chipCount += pot.amount;
          const existing = winnerInfos.find(w => w.seatIndex === winIdx);
          if (existing) {
            existing.chipsWon += pot.amount;
          } else {
            winnerInfos.push({
              seatIndex: winIdx,
              playerName: this.seats[winIdx].playerName,
              chipsWon: pot.amount,
              handName: 'Won uncontested',
              bestFiveCards: [],
            });
          }
          results.push({
            seatIndex: winIdx,
            playerName: this.seats[winIdx].playerName,
            amount: pot.amount,
            potName: pot.name,
          });
          continue;
        }

        // Evaluate hi-lo for all eligible players
        const hiLoResults: {
          seatIndex: number;
          high: HandResult;
          low: HandResult | null;
        }[] = [];

        for (const seatIdx of pot.eligibleSeatIndices) {
          const seat = this.seats[seatIdx];
          if (seat.holeCards.length < 4 || this.communityCards.length < 3) continue;
          const hiLo = evaluateOmahaHiLo(seat.holeCards, this.communityCards);
          hiLoResults.push({
            seatIndex: seatIdx,
            high: hiLo.high,
            low: hiLo.low,
          });
        }

        if (hiLoResults.length === 0) continue;

        // Find best high hand
        hiLoResults.sort((a, b) => compareTo(b.high, a.high));
        const bestHigh = hiLoResults[0].high;
        const highWinners = hiLoResults.filter(hr => compareTo(hr.high, bestHigh) === 0);

        // Find best qualifying low hand
        const lowCandidates = hiLoResults.filter(hr => hr.low !== null);
        let lowWinners: typeof hiLoResults = [];
        if (lowCandidates.length > 0) {
          lowCandidates.sort((a, b) => compareLowHands(a.low!, b.low!));
          const bestLow = lowCandidates[0].low!;
          lowWinners = lowCandidates.filter(hr => compareLowHands(hr.low!, bestLow) === 0);
        }

        // Split pot — TDA Rule 60: when a hi/lo split has an odd chip,
        // the odd chip goes to the HIGH side (low side gets the floor).
        let highPot: number;
        let lowPot: number;
        if (lowWinners.length > 0) {
          lowPot  = Math.floor(pot.amount / 2);
          highPot = pot.amount - lowPot; // odd chip → high
        } else {
          highPot = pot.amount;
          lowPot = 0;
        }

        // Order winners clockwise from dealer (TDA Rule 60).
        const orderedHighSeats = SidePotManager.orderClockwiseFromDealer(
          highWinners.map(w => w.seatIndex),
          this.dealerButtonSeat,
          TABLE_SEAT_COUNT
        );
        const orderedLowSeats = SidePotManager.orderClockwiseFromDealer(
          lowWinners.map(w => w.seatIndex),
          this.dealerButtonSeat,
          TABLE_SEAT_COUNT
        );

        // Award high pot in clockwise order so odd chip lands on first seat after button
        const highShare = Math.floor(highPot / highWinners.length);
        let highRemainder = highPot - highShare * highWinners.length;
        for (const seatIdx of orderedHighSeats) {
          const hw = highWinners.find(w => w.seatIndex === seatIdx)!;
          let amt = highShare;
          if (highRemainder > 0) { amt++; highRemainder--; }
          this.seats[seatIdx].chipCount += amt;
          results.push({
            seatIndex: seatIdx,
            playerName: this.seats[seatIdx].playerName,
            amount: amt,
            handResult: hw.high,
            potName: `${pot.name} (High)`,
          });
          const existing = winnerInfos.find(w => w.seatIndex === seatIdx);
          if (existing) {
            existing.chipsWon += amt;
          } else {
            winnerInfos.push({
              seatIndex: seatIdx,
              playerName: this.seats[seatIdx].playerName,
              chipsWon: amt,
              handName: hw.high.handName,
              bestFiveCards: hw.high.bestFiveCards,
            });
          }
        }

        // Award low pot in clockwise order
        if (lowPot > 0 && lowWinners.length > 0) {
          const lowShare = Math.floor(lowPot / lowWinners.length);
          let lowRemainder = lowPot - lowShare * lowWinners.length;
          for (const seatIdx of orderedLowSeats) {
            const lw = lowWinners.find(w => w.seatIndex === seatIdx)!;
            let amt = lowShare;
            if (lowRemainder > 0) { amt++; lowRemainder--; }
            this.seats[seatIdx].chipCount += amt;
            results.push({
              seatIndex: seatIdx,
              playerName: this.seats[seatIdx].playerName,
              amount: amt,
              handResult: lw.low!,
              potName: `${pot.name} (Low)`,
            });
            const existing = winnerInfos.find(w => w.seatIndex === seatIdx);
            if (existing) {
              existing.chipsWon += amt;
            } else {
              winnerInfos.push({
                seatIndex: seatIdx,
                playerName: this.seats[seatIdx].playerName,
                chipsWon: amt,
                handName: lw.low!.handName,
                bestFiveCards: lw.low!.bestFiveCards,
              });
            }
          }
        }
      }

      if (orphanedCarry > 0) {
        console.error(`[OmahaTable] ${orphanedCarry} chips orphaned after all pots processed.`);
      }
    }

    // Calculate pot breakdown for hand history
    const pots = this.sidePotManager.calculatePots(seatInfos);
    const potBreakdown = pots.map(p => {
      const potResults = results.filter(r => r.potName === p.name);
      const winnerAmounts = potResults.map(r => ({ seatIndex: r.seatIndex, amount: r.amount }));
      return {
        name: p.name,
        amount: p.amount,
        winners: [...new Set(potResults.map(r => r.seatIndex))],
        winnerAmounts,
      };
    });
    if (potBreakdown.length === 0 && winnerInfos.length > 0) {
      const totalPot = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      potBreakdown.push({
        name: 'Main Pot',
        amount: totalPot,
        winners: winnerInfos.map(w => w.seatIndex),
        winnerAmounts: winnerInfos.map(w => ({ seatIndex: w.seatIndex, amount: w.chipsWon })),
      });
    }

    // Store lastHandResult
    this.lastHandResult = {
      handNumber: this.handNumber,
      winners: winnerInfos,
      showdownHands,
      communityCards: [...this.communityCards],
      pots: potBreakdown,
    };

    // Build hand history record
    const handHistory: HandHistoryRecord = {
      handNumber: this.handNumber,
      communityCards: [...this.communityCards],
      players: this.seats
        .filter(s => s.state === 'occupied' && !s.eliminated)
        .map(s => {
          let handRes: { handName: string } | null = null;
          if (!s.folded && s.holeCards.length >= 4 && this.communityCards.length >= 3) {
            const hiLo = evaluateOmahaHiLo(s.holeCards, this.communityCards);
            handRes = { handName: hiLo.high.handName };
          }
          return {
            seatIndex: s.seatIndex,
            name: s.playerName,
            holeCards: s.folded ? null : (s.holeCards.length > 0 ? [...s.holeCards] : null),
            startChips: this.startChips.get(s.seatIndex) || 0,
            endChips: s.chipCount,
            actions: this.actionLog
              .filter(a => a.seatIndex === s.seatIndex)
              .map(a => a.action),
            folded: s.folded,
            handName: handRes?.handName || null,
          };
        }),
      winners: winnerInfos.map(w => ({
        seatIndex: w.seatIndex,
        name: w.playerName,
        chipsWon: w.chipsWon,
        handName: w.handName,
      })),
      pots: potBreakdown,
    };

    // Reset totalInvestedThisHand
    for (const seat of this.seats) {
      seat.totalInvestedThisHand = 0;
    }

    this.currentPhase = GamePhase.HandComplete;
    this.activeSeatIndex = -1;

    this.emit('handResult', { results, handNumber: this.handNumber });
    this.emit('handHistory', handHistory);
    this.emit('phaseChanged', { phase: this.currentPhase });
  }
}

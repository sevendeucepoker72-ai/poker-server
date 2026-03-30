import { Card } from '../Card';
import { HandResult, compareTo } from '../HandEvaluator';
import { evaluateOmahaHand, evaluateOmahaHiLo, compareLowHands } from '../HandEvaluatorExtensions';
import { SeatInfo } from '../SidePotManager';
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

  constructor(config: TableConfig, isHiLo: boolean = false) {
    super(config);
    this.isHiLo = isHiLo;
    this.variant = isHiLo ? new OmahaHiLoVariant() : new OmahaVariant();

    // Set variant properties
    this.variantId = isHiLo ? 'omaha-hi-lo' : 'omaha';
    this.variantName = isHiLo ? 'Omaha Hi-Lo' : 'Pot-Limit Omaha';
    this.holeCardCount = 4;
    this.bettingStructure = 'pot-limit';
  }

  /**
   * Override: deal 4 hole cards instead of 2.
   */
  protected getHoleCardCount(): number {
    return 4;
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

      for (const pot of pots) {
        if (pot.eligibleSeatIndices.length === 0) continue;

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

        // Split pot
        let highPot: number;
        let lowPot: number;
        if (lowWinners.length > 0) {
          // Split 50/50 between high and low
          highPot = Math.floor(pot.amount / 2);
          lowPot = pot.amount - highPot;
        } else {
          // No qualifying low - high scoops
          highPot = pot.amount;
          lowPot = 0;
        }

        // Award high pot
        const highShare = Math.floor(highPot / highWinners.length);
        let highRemainder = highPot - highShare * highWinners.length;
        for (const hw of highWinners) {
          let amt = highShare;
          if (highRemainder > 0) { amt++; highRemainder--; }
          this.seats[hw.seatIndex].chipCount += amt;
          results.push({
            seatIndex: hw.seatIndex,
            playerName: this.seats[hw.seatIndex].playerName,
            amount: amt,
            handResult: hw.high,
            potName: `${pot.name} (High)`,
          });
          const existing = winnerInfos.find(w => w.seatIndex === hw.seatIndex);
          if (existing) {
            existing.chipsWon += amt;
          } else {
            winnerInfos.push({
              seatIndex: hw.seatIndex,
              playerName: this.seats[hw.seatIndex].playerName,
              chipsWon: amt,
              handName: hw.high.handName,
              bestFiveCards: hw.high.bestFiveCards,
            });
          }
        }

        // Award low pot
        if (lowPot > 0 && lowWinners.length > 0) {
          const lowShare = Math.floor(lowPot / lowWinners.length);
          let lowRemainder = lowPot - lowShare * lowWinners.length;
          for (const lw of lowWinners) {
            let amt = lowShare;
            if (lowRemainder > 0) { amt++; lowRemainder--; }
            this.seats[lw.seatIndex].chipCount += amt;
            results.push({
              seatIndex: lw.seatIndex,
              playerName: this.seats[lw.seatIndex].playerName,
              amount: amt,
              handResult: lw.low!,
              potName: `${pot.name} (Low)`,
            });
            const existing = winnerInfos.find(w => w.seatIndex === lw.seatIndex);
            if (existing) {
              existing.chipsWon += amt;
            } else {
              winnerInfos.push({
                seatIndex: lw.seatIndex,
                playerName: this.seats[lw.seatIndex].playerName,
                chipsWon: amt,
                handName: lw.low!.handName,
                bestFiveCards: lw.low!.bestFiveCards,
              });
            }
          }
        }
      }
    }

    // Calculate pot breakdown for hand history
    const pots = this.sidePotManager.calculatePots(seatInfos);
    const potBreakdown = pots.map(p => ({
      amount: p.amount,
      winners: winnerInfos
        .filter(w => p.eligibleSeatIndices.includes(w.seatIndex))
        .map(w => w.seatIndex),
    }));
    if (potBreakdown.length === 0 && winnerInfos.length > 0) {
      const totalPot = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      potBreakdown.push({
        amount: totalPot,
        winners: winnerInfos.map(w => w.seatIndex),
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

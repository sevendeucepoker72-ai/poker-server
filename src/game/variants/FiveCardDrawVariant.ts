import { Card, Suit, Rank } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import { evaluate27LowHand, compare27Hands } from '../HandEvaluatorExtensions';
import {
  PokerVariant,
  VariantPhase,
  VariantHandResult,
  BettingStructure,
  VariantType,
} from './PokerVariant';

/**
 * Five Card Draw.
 * 5 hole cards, no community cards.
 * Phases: Deal -> Bet1 -> Draw1 -> Bet2 -> Showdown
 * Fixed-limit or no-limit betting.
 *
 * Can also be configured as Triple Draw (2-7 Lowball):
 * - isTripleDraw: true => 3 draw rounds, evaluate as 2-7 lowball
 * - Phases: Deal -> Bet1 -> Draw1 -> Bet2 -> Draw2 -> Bet3 -> Draw3 -> Bet4 -> Showdown
 */
export class FiveCardDrawVariant implements PokerVariant {
  name: string;
  shortName: string;
  type: VariantType;
  maxPlayers = 6;
  holeCardCount = 5;
  communityCardCount = 0;
  deckSize = 52;
  bettingStructure: BettingStructure;
  usesCommunityCards = false;
  hasDrawPhase = true;
  isStudGame = false;
  isHiLo = false;

  /** If true, this is 2-7 Triple Draw (lowball) */
  isTripleDraw: boolean;

  constructor(isTripleDraw: boolean = false) {
    this.isTripleDraw = isTripleDraw;
    if (isTripleDraw) {
      this.name = '2-7 Triple Draw';
      this.shortName = '27TD';
      this.type = 'triple-draw';
      this.bettingStructure = 'fixed-limit';
    } else {
      this.name = 'Five Card Draw';
      this.shortName = '5CD';
      this.type = 'five-card-draw';
      this.bettingStructure = 'no-limit';
    }
  }

  createDeck(): Card[] {
    const cards: Card[] = [];
    for (let suit = Suit.Hearts; suit <= Suit.Spades; suit++) {
      for (let rank = Rank.Two; rank <= Rank.Ace; rank++) {
        cards.push({ suit, rank });
      }
    }
    return cards;
  }

  getPhases(): VariantPhase[] {
    if (this.isTripleDraw) {
      return ['Deal', 'Bet1', 'Draw1', 'Bet2', 'Draw2', 'Bet3', 'Draw3', 'Bet4', 'Showdown'];
    }
    return ['Deal', 'Bet1', 'Draw1', 'Bet2', 'Showdown'];
  }

  getNextPhase(currentPhase: VariantPhase): VariantPhase | null {
    const phases = this.getPhases();
    const idx = phases.indexOf(currentPhase);
    if (idx === -1 || idx >= phases.length - 1) return null;
    return phases[idx + 1];
  }

  getCommunityCardCount(_phase: VariantPhase): number {
    return 0; // No community cards in draw games
  }

  evaluateHand(holeCards: Card[], _communityCards: Card[]): VariantHandResult {
    if (this.isTripleDraw) {
      // 2-7 Lowball: lowest hand wins
      const high = evaluate27LowHand(holeCards);
      return { high };
    }
    // Standard draw: best 5-card hand
    const high = evaluateHand(holeCards);
    return { high };
  }

  getMaxRaise(
    potSize: number,
    currentBet: number,
    playerChips: number,
    bigBlind: number,
    phase: VariantPhase
  ): number {
    if (this.bettingStructure === 'fixed-limit') {
      // Fixed limit: small bet on early rounds, big bet on later rounds
      const isLateRound = ['Bet3', 'Bet4'].includes(phase);
      const betSize = isLateRound ? bigBlind * 2 : bigBlind;
      return Math.min(currentBet + betSize, playerChips);
    }
    // No-limit
    return playerChips;
  }

  isBettingPhase(phase: VariantPhase): boolean {
    return ['Bet1', 'Bet2', 'Bet3', 'Bet4'].includes(phase);
  }

  isDrawPhase(phase: VariantPhase): boolean {
    return ['Draw1', 'Draw2', 'Draw3'].includes(phase);
  }
}

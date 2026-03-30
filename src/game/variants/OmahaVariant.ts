import { Card, Suit, Rank } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import { evaluateOmahaHand } from '../HandEvaluatorExtensions';
import {
  PokerVariant,
  VariantPhase,
  VariantHandResult,
  BettingStructure,
  VariantType,
} from './PokerVariant';

/**
 * Pot-Limit Omaha (PLO).
 * 4 hole cards, must use exactly 2 hole + 3 community.
 * Pot-limit betting structure.
 */
export class OmahaVariant implements PokerVariant {
  name = 'Pot-Limit Omaha';
  shortName = 'PLO';
  type: VariantType = 'omaha';
  maxPlayers = 9;
  holeCardCount = 4;
  communityCardCount = 5;
  deckSize = 52;
  bettingStructure: BettingStructure = 'pot-limit';
  usesCommunityCards = true;
  hasDrawPhase = false;
  isStudGame = false;
  isHiLo = false;

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
    return ['PreFlop', 'Flop', 'Turn', 'River', 'Showdown'];
  }

  getNextPhase(currentPhase: VariantPhase): VariantPhase | null {
    const map: Record<string, VariantPhase> = {
      PreFlop: 'Flop',
      Flop: 'Turn',
      Turn: 'River',
      River: 'Showdown',
    };
    return map[currentPhase] || null;
  }

  getCommunityCardCount(phase: VariantPhase): number {
    if (phase === 'Flop') return 3;
    if (phase === 'Turn') return 1;
    if (phase === 'River') return 1;
    return 0;
  }

  evaluateHand(holeCards: Card[], communityCards: Card[]): VariantHandResult {
    const high = evaluateOmahaHand(holeCards, communityCards);
    return { high };
  }

  getMaxRaise(
    potSize: number,
    currentBet: number,
    playerChips: number,
    _bigBlind: number,
    _phase: VariantPhase
  ): number {
    // Pot-limit: max raise = current pot + what it would cost to call
    // The "pot" for pot-limit calculation = pot + all bets on table + call amount
    const potLimitMax = potSize + currentBet;
    return Math.min(potLimitMax, playerChips);
  }

  isBettingPhase(phase: VariantPhase): boolean {
    return ['PreFlop', 'Flop', 'Turn', 'River'].includes(phase);
  }

  isDrawPhase(_phase: VariantPhase): boolean {
    return false;
  }
}

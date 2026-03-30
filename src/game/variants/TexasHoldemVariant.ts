import { Card, Suit, Rank } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import {
  PokerVariant,
  VariantPhase,
  VariantHandResult,
  BettingStructure,
  VariantType,
} from './PokerVariant';

/**
 * Texas Hold'em - the default variant.
 * 2 hole cards, 5 community cards, no-limit betting.
 */
export class TexasHoldemVariant implements PokerVariant {
  name = "Texas Hold'em";
  shortName = 'NLH';
  type: VariantType = 'texas-holdem';
  maxPlayers = 9;
  holeCardCount = 2;
  communityCardCount = 5;
  deckSize = 52;
  bettingStructure: BettingStructure = 'no-limit';
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
    const allCards = [...holeCards, ...communityCards];
    const high = evaluateHand(allCards);
    return { high };
  }

  getMaxRaise(
    _potSize: number,
    _currentBet: number,
    playerChips: number,
    _bigBlind: number,
    _phase: VariantPhase
  ): number {
    // No-limit: can bet up to entire stack
    return playerChips;
  }

  isBettingPhase(phase: VariantPhase): boolean {
    return ['PreFlop', 'Flop', 'Turn', 'River'].includes(phase);
  }

  isDrawPhase(_phase: VariantPhase): boolean {
    return false;
  }
}

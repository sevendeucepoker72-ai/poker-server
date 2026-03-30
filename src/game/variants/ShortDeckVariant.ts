import { Card, Suit, Rank } from '../Card';
import { evaluateShortDeckHand } from '../HandEvaluatorExtensions';
import {
  PokerVariant,
  VariantPhase,
  VariantHandResult,
  BettingStructure,
  VariantType,
} from './PokerVariant';

/**
 * Short Deck Hold'em (6+ Hold'em / Triton).
 * 36-card deck (remove 2-5), modified hand rankings:
 * Flush > Full House, Three of a Kind > Straight.
 * A-6-7-8-9 is the lowest straight (ace wraps low).
 * No-limit betting.
 */
export class ShortDeckVariant implements PokerVariant {
  name = 'Short Deck';
  shortName = '6+';
  type: VariantType = 'short-deck';
  maxPlayers = 9;
  holeCardCount = 2;
  communityCardCount = 5;
  deckSize = 36;
  bettingStructure: BettingStructure = 'no-limit';
  usesCommunityCards = true;
  hasDrawPhase = false;
  isStudGame = false;
  isHiLo = false;

  createDeck(): Card[] {
    const cards: Card[] = [];
    for (let suit = Suit.Hearts; suit <= Suit.Spades; suit++) {
      // Only 6 through Ace (skip 2-5)
      for (let rank = Rank.Six; rank <= Rank.Ace; rank++) {
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
    const high = evaluateShortDeckHand(allCards);
    return { high };
  }

  getMaxRaise(
    _potSize: number,
    _currentBet: number,
    playerChips: number,
    _bigBlind: number,
    _phase: VariantPhase
  ): number {
    return playerChips;
  }

  isBettingPhase(phase: VariantPhase): boolean {
    return ['PreFlop', 'Flop', 'Turn', 'River'].includes(phase);
  }

  isDrawPhase(_phase: VariantPhase): boolean {
    return false;
  }
}

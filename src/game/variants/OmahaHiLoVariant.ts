import { Card, Suit, Rank } from '../Card';
import { evaluateOmahaHand, evaluateOmahaLowHand } from '../HandEvaluatorExtensions';
import {
  PokerVariant,
  VariantPhase,
  VariantHandResult,
  BettingStructure,
  VariantType,
} from './PokerVariant';

/**
 * Omaha Hi-Lo (PLO8 / Omaha Eight-or-Better).
 * Same as PLO but pot split between best high and best qualifying low hand.
 * Low hand: 5 unpaired cards 8 or below; straights/flushes don't count against low.
 * A-2-3-4-5 is the best low ("the wheel").
 * If no qualifying low, high hand scoops the entire pot.
 */
export class OmahaHiLoVariant implements PokerVariant {
  name = 'Omaha Hi-Lo';
  shortName = 'PLO8';
  type: VariantType = 'omaha-hi-lo';
  maxPlayers = 9;
  holeCardCount = 4;
  communityCardCount = 5;
  deckSize = 52;
  bettingStructure: BettingStructure = 'pot-limit';
  usesCommunityCards = true;
  hasDrawPhase = false;
  isStudGame = false;
  isHiLo = true;

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
    const low = evaluateOmahaLowHand(holeCards, communityCards);
    return { high, low };
  }

  getMaxRaise(
    potSize: number,
    currentBet: number,
    playerChips: number,
    _bigBlind: number,
    _phase: VariantPhase
  ): number {
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

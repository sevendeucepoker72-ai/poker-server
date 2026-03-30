import { Card, Suit, Rank } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import { evaluateRazzHand, compareRazzHands } from '../HandEvaluatorExtensions';
import {
  PokerVariant,
  VariantPhase,
  VariantHandResult,
  BettingStructure,
  VariantType,
} from './PokerVariant';

/**
 * Seven Card Stud.
 * No community cards - each player gets 7 cards total:
 *   - 2 face-down (hole) + 1 face-up (door) on ThirdStreet
 *   - 1 face-up each on FourthStreet, FifthStreet, SixthStreet
 *   - 1 face-down on SeventhStreet
 *
 * Fixed-limit betting. Bring-in: lowest showing card.
 *
 * Can also be configured as Razz (isRazz: true):
 *   - Same deal structure but lowest hand wins
 *   - Bring-in: highest showing card (worst low)
 */
export class SevenCardStudVariant implements PokerVariant {
  name: string;
  shortName: string;
  type: VariantType;
  maxPlayers = 8;
  holeCardCount = 7; // Total cards each player receives over the hand
  communityCardCount = 0;
  deckSize = 52;
  bettingStructure: BettingStructure = 'fixed-limit';
  usesCommunityCards = false;
  hasDrawPhase = false;
  isStudGame = true;
  isHiLo = false;

  /** If true, this is Razz (lowest hand wins) */
  isRazz: boolean;

  constructor(isRazz: boolean = false) {
    this.isRazz = isRazz;
    if (isRazz) {
      this.name = 'Razz';
      this.shortName = 'Razz';
      this.type = 'razz';
    } else {
      this.name = 'Seven Card Stud';
      this.shortName = '7CS';
      this.type = 'seven-card-stud';
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
    return [
      'ThirdStreet',
      'FourthStreet',
      'FifthStreet',
      'SixthStreet',
      'SeventhStreet',
      'Showdown',
    ];
  }

  getNextPhase(currentPhase: VariantPhase): VariantPhase | null {
    const map: Record<string, VariantPhase> = {
      ThirdStreet: 'FourthStreet',
      FourthStreet: 'FifthStreet',
      FifthStreet: 'SixthStreet',
      SixthStreet: 'SeventhStreet',
      SeventhStreet: 'Showdown',
    };
    return map[currentPhase] || null;
  }

  getCommunityCardCount(_phase: VariantPhase): number {
    return 0; // No community cards in stud
  }

  /**
   * Returns how many cards to deal to each player for a given phase.
   */
  getPlayerCardCount(phase: VariantPhase): number {
    if (phase === 'ThirdStreet') return 3; // 2 down + 1 up
    if (['FourthStreet', 'FifthStreet', 'SixthStreet', 'SeventhStreet'].includes(phase)) return 1;
    return 0;
  }

  /**
   * Returns whether the card dealt in a given phase is face-up.
   */
  isCardFaceUp(phase: VariantPhase, cardIndex: number): boolean {
    if (phase === 'ThirdStreet') {
      // First 2 cards face-down, 3rd face-up
      return cardIndex === 2;
    }
    if (phase === 'SeventhStreet') {
      // Last card is face-down
      return false;
    }
    // FourthStreet, FifthStreet, SixthStreet are face-up
    return true;
  }

  evaluateHand(holeCards: Card[], _communityCards: Card[]): VariantHandResult {
    if (this.isRazz) {
      const high = evaluateRazzHand(holeCards);
      return { high };
    }
    const high = evaluateHand(holeCards);
    return { high };
  }

  getMaxRaise(
    _potSize: number,
    currentBet: number,
    playerChips: number,
    bigBlind: number,
    phase: VariantPhase
  ): number {
    // Fixed limit: small bet on 3rd/4th street, big bet on 5th/6th/7th
    const isLateRound = ['FifthStreet', 'SixthStreet', 'SeventhStreet'].includes(phase);
    const betSize = isLateRound ? bigBlind * 2 : bigBlind;
    return Math.min(currentBet + betSize, playerChips);
  }

  isBettingPhase(phase: VariantPhase): boolean {
    return [
      'ThirdStreet',
      'FourthStreet',
      'FifthStreet',
      'SixthStreet',
      'SeventhStreet',
    ].includes(phase);
  }

  isDrawPhase(_phase: VariantPhase): boolean {
    return false;
  }
}

import { Card } from '../Card';
import { HandResult } from '../HandEvaluator';

/**
 * Phases that a poker game can go through.
 * Different variants use different subsets of these phases.
 */
export type VariantPhase =
  | 'WaitingForPlayers'
  | 'PreFlop'
  | 'Flop'
  | 'Turn'
  | 'River'
  | 'Showdown'
  | 'HandComplete'
  // Draw game phases
  | 'Deal'
  | 'Bet1'
  | 'Draw1'
  | 'Bet2'
  | 'Draw2'
  | 'Bet3'
  | 'Draw3'
  | 'Bet4'
  // Stud game phases
  | 'ThirdStreet'
  | 'FourthStreet'
  | 'FifthStreet'
  | 'SixthStreet'
  | 'SeventhStreet';

export type BettingStructure = 'no-limit' | 'pot-limit' | 'fixed-limit';

export type VariantType =
  | 'texas-holdem'
  | 'omaha'
  | 'omaha-hi-lo'
  | 'short-deck'
  | 'five-card-draw'
  | 'seven-card-stud'
  | 'razz'
  | 'triple-draw'
  | 'mixed-horse';

/**
 * Result of hand evaluation that may include both high and low hands (for Hi-Lo variants).
 */
export interface VariantHandResult {
  high: HandResult;
  low?: HandResult | null;
}

/**
 * Describes a card's visibility in stud games.
 */
export interface StudCardInfo {
  card: Card;
  faceUp: boolean;
}

/**
 * Interface that all poker variants implement.
 * The main PokerTable delegates variant-specific behavior to these methods.
 */
export interface PokerVariant {
  /** Full display name */
  name: string;
  /** Short identifier */
  shortName: string;
  /** Variant type key */
  type: VariantType;
  /** Maximum players this variant supports */
  maxPlayers: number;
  /** Number of hole cards dealt to each player */
  holeCardCount: number;
  /** Number of community cards (0 for stud/draw games) */
  communityCardCount: number;
  /** Number of cards in the deck */
  deckSize: number;
  /** Betting structure */
  bettingStructure: BettingStructure;
  /** Whether this variant uses community cards */
  usesCommunityCards: boolean;
  /** Whether this variant has draw phases */
  hasDrawPhase: boolean;
  /** Whether this variant is a stud game */
  isStudGame: boolean;
  /** Whether this variant splits the pot (hi-lo) */
  isHiLo: boolean;

  /**
   * Create the deck of cards for this variant.
   * Short Deck removes 2-5, standard variants use full 52.
   */
  createDeck(): Card[];

  /**
   * Get the ordered phases for this variant's hand.
   */
  getPhases(): VariantPhase[];

  /**
   * Get the next phase after the given phase.
   * Returns null if no next phase (hand is complete or at showdown).
   */
  getNextPhase(currentPhase: VariantPhase): VariantPhase | null;

  /**
   * How many community cards to deal when entering a given phase.
   * Returns 0 for phases that don't deal community cards.
   */
  getCommunityCardCount(phase: VariantPhase): number;

  /**
   * Evaluate a player's hand given their hole cards and community cards.
   * For stud games, communityCards will be empty; all cards are in holeCards.
   * For hi-lo, returns both high and low results.
   */
  evaluateHand(holeCards: Card[], communityCards: Card[]): VariantHandResult;

  /**
   * Calculate the maximum allowed raise for pot-limit or fixed-limit games.
   * For no-limit, returns Infinity (or the player's stack).
   * @param potSize Current total pot
   * @param currentBet Current bet to match
   * @param playerChips Player's remaining chips
   * @param bigBlind Big blind amount (for fixed-limit sizing)
   * @param phase Current game phase
   */
  getMaxRaise(
    potSize: number,
    currentBet: number,
    playerChips: number,
    bigBlind: number,
    phase: VariantPhase
  ): number;

  /**
   * Whether a given phase is a betting phase (as opposed to deal/draw).
   */
  isBettingPhase(phase: VariantPhase): boolean;

  /**
   * Whether a given phase is a draw phase.
   */
  isDrawPhase(phase: VariantPhase): boolean;
}

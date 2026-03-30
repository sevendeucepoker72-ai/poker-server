import { Card, Suit, Rank } from '../Card';
import { CardDeck } from '../CardDeck';
import { HandResult } from '../HandEvaluator';
import { evaluateShortDeckHand } from '../HandEvaluatorExtensions';
import {
  PokerTable,
  TableConfig,
} from '../PokerTable';
import { ShortDeckVariant } from './ShortDeckVariant';
import { PokerVariant } from './PokerVariant';

/**
 * ShortDeckTable extends PokerTable for Short Deck (6+) Hold'em.
 *
 * Key differences:
 * - 36-card deck (remove 2-5)
 * - Modified hand rankings (Flush > Full House, Trips > Straight)
 * - A-6-7-8-9 is the lowest straight
 * - Standard no-limit betting
 */
export class ShortDeckTable extends PokerTable {
  public variant: PokerVariant;

  constructor(config: TableConfig) {
    super(config);
    this.variant = new ShortDeckVariant();

    // Set variant properties
    this.variantId = 'short-deck';
    this.variantName = 'Short Deck (6+)';
    this.holeCardCount = 2;
    this.bettingStructure = 'no-limit';
  }

  /**
   * Override: reset the deck with only 36 cards (6-A, no 2-5).
   */
  protected resetDeck(): void {
    // We need to manually build the short deck since CardDeck always builds 52 cards
    // Use the deck's reset and then override the cards by dealing through them
    this.deck.reset();

    // Build short deck cards: only 6 through Ace
    const shortDeckCards: Card[] = [];
    for (let suit = Suit.Hearts; suit <= Suit.Spades; suit++) {
      for (let rank = Rank.Six; rank <= Rank.Ace; rank++) {
        shortDeckCards.push({ suit, rank });
      }
    }

    // Fisher-Yates shuffle
    for (let i = shortDeckCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shortDeckCards[i], shortDeckCards[j]] = [shortDeckCards[j], shortDeckCards[i]];
    }

    // Store shuffled short deck cards for dealing
    this._shortDeckCards = shortDeckCards;
    this._shortDeckIndex = 0;
  }

  private _shortDeckCards: Card[] = [];
  private _shortDeckIndex: number = 0;

  /**
   * Override deal hole cards to use our short deck.
   */
  protected dealHoleCardsImpl(): void {
    const startSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
    if (startSeat === -1) return;

    for (let round = 0; round < 2; round++) {
      let seat = startSeat;
      do {
        if (
          this.seats[seat].state === 'occupied' &&
          !this.seats[seat].eliminated &&
          this.seats[seat].chipCount >= 0
        ) {
          const card = this.dealShortDeckCard();
          if (card) {
            this.seats[seat].holeCards.push(card);
            this.emit('cardDealt', { seatIndex: seat, round });
          }
        }
        seat = this.getNextOccupiedSeat(seat + 1);
      } while (seat !== startSeat);
    }
  }

  /**
   * Override community card dealing to use short deck.
   */
  protected dealCommunityCards(count: number): void {
    // Burn one card
    this.dealShortDeckCard();

    for (let i = 0; i < count; i++) {
      const card = this.dealShortDeckCard();
      if (card) {
        this.communityCards.push(card);
        this.emit('communityCard', { card, total: this.communityCards.length });
      }
    }
  }

  private dealShortDeckCard(): Card | null {
    if (this._shortDeckIndex >= this._shortDeckCards.length) return null;
    return this._shortDeckCards[this._shortDeckIndex++];
  }

  /**
   * Override: use Short Deck hand evaluation (modified rankings).
   */
  protected evaluatePlayerHand(holeCards: Card[], communityCards: Card[]): HandResult {
    const allCards = [...holeCards, ...communityCards];
    return evaluateShortDeckHand(allCards);
  }
}

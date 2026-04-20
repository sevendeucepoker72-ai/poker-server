import { Card, Rank } from '../Card';
import {
  PokerTable,
  GamePhase,
  TableConfig,
} from '../PokerTable';
import { TexasHoldemVariant } from './TexasHoldemVariant';
import { PokerVariant } from './PokerVariant';

/**
 * PineappleTable — Pineapple and Crazy Pineapple variants of Hold'em.
 *
 * Pineapple:        3 hole cards dealt; players must discard 1 BEFORE the flop.
 * Crazy Pineapple:  3 hole cards dealt; players must discard 1 AFTER the flop.
 *
 * Standard Hold'em board, betting structure, and showdown otherwise.
 *
 * Discard policy: MANUAL with server-side fallback. When the discard deadline
 * arrives, each seat's chosen card (via `selectPineappleDiscard`) is dropped.
 * If no choice was made in time, the weakest card is auto-discarded so the
 * hand can proceed.
 */
export class PineappleTable extends PokerTable {
  public variant: PokerVariant;
  public isCrazyPineapple: boolean;
  /** Pending player-chosen discard index per seat. Cleared after each discard phase. */
  private pendingDiscardIndex: Map<number, number> = new Map();

  constructor(config: TableConfig, isCrazyPineapple: boolean = false) {
    super(config);
    this.isCrazyPineapple = isCrazyPineapple;
    // Reuses the Hold'em variant for phase progression / community card dealing
    this.variant = new TexasHoldemVariant();

    this.variantId = isCrazyPineapple ? 'crazy-pineapple' : 'pineapple';
    this.variantName = isCrazyPineapple ? 'Crazy Pineapple' : 'Pineapple';
    this.holeCardCount = 3;
    this.bettingStructure = 'no-limit';
  }

  /**
   * Register a player's chosen discard index (0, 1, or 2 — index into their
   * holeCards array at the moment of choice). Call from the socket handler.
   * Returns true if recorded, false if invalid.
   */
  public selectPineappleDiscard(seatIndex: number, cardIndex: number): boolean {
    const seat = this.seats[seatIndex];
    if (!seat || seat.state !== 'occupied' || seat.folded || seat.eliminated) return false;
    if (seat.holeCards.length <= 2) return false; // already discarded
    if (cardIndex < 0 || cardIndex >= seat.holeCards.length) return false;
    this.pendingDiscardIndex.set(seatIndex, cardIndex);
    return true;
  }

  /** Override: deal 3 hole cards instead of 2. */
  protected getHoleCardCount(): number {
    return 3;
  }

  /**
   * Override: deal community cards for a phase. Adds the auto-discard step
   * at the appropriate boundary (before flop for Pineapple, before turn for
   * Crazy Pineapple).
   */
  protected dealCommunityCardsForPhase(phase: GamePhase): void {
    // Auto-discard timing
    if (!this.isCrazyPineapple && phase === GamePhase.Flop) {
      // Pineapple: discard before flop is dealt
      this.autoDiscardOne();
    }
    if (this.isCrazyPineapple && phase === GamePhase.Turn) {
      // Crazy Pineapple: discard before turn is dealt
      this.autoDiscardOne();
    }
    super.dealCommunityCardsForPhase(phase);
  }

  /**
   * Drop one hole card from each non-folded, non-eliminated occupied seat.
   * Uses the player's pending choice if they made one; otherwise falls back
   * to weakest-card auto-discard so the hand never stalls.
   */
  private autoDiscardOne(): void {
    for (const seat of this.seats) {
      if (seat.state !== 'occupied') continue;
      if (seat.folded || seat.eliminated) continue;
      if (seat.holeCards.length <= 2) continue;

      let chosenIdx = this.pendingDiscardIndex.get(seat.seatIndex);
      let auto = false;
      if (chosenIdx == null || chosenIdx < 0 || chosenIdx >= seat.holeCards.length) {
        // Fallback: pick weakest card by rank, ties → lowest suit
        auto = true;
        chosenIdx = 0;
        for (let i = 1; i < seat.holeCards.length; i++) {
          const c = seat.holeCards[i];
          const w = seat.holeCards[chosenIdx];
          if (c.rank < w.rank || (c.rank === w.rank && c.suit < w.suit)) {
            chosenIdx = i;
          }
        }
      }
      const [removed] = seat.holeCards.splice(chosenIdx, 1);
      this.actionLog.push({
        seatIndex: seat.seatIndex,
        playerName: seat.playerName,
        action: `${auto ? 'auto-discarded' : 'discarded'} ${this.cardLabel(removed)}`,
      });
      this.emit('pineappleDiscarded', { seatIndex: seat.seatIndex, card: removed, auto });
    }
    this.pendingDiscardIndex.clear();
  }

  private cardLabel(c: Card): string {
    const rankNames: Record<number, string> = {
      2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
      11: 'J', 12: 'Q', 13: 'K', 14: 'A',
    };
    const suitNames: Record<number, string> = { 0: '♥', 1: '♦', 2: '♣', 3: '♠' };
    return `${rankNames[c.rank] || c.rank}${suitNames[c.suit] || ''}`;
  }
}

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
 * Discard policy: AUTO. The server picks the player's weakest card to discard
 * (lowest rank, breaking ties arbitrarily). Manual discard selection requires
 * a UI flow not yet built; auto-discard preserves variant playability.
 */
export class PineappleTable extends PokerTable {
  public variant: PokerVariant;
  public isCrazyPineapple: boolean;

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
   * Picks the lowest-rank card; ties broken by suit (lowest suit value drops).
   */
  private autoDiscardOne(): void {
    for (const seat of this.seats) {
      if (seat.state !== 'occupied') continue;
      if (seat.folded || seat.eliminated) continue;
      if (seat.holeCards.length <= 2) continue;

      // Pick weakest card by rank, ties → lowest suit
      let worstIdx = 0;
      for (let i = 1; i < seat.holeCards.length; i++) {
        const c = seat.holeCards[i];
        const w = seat.holeCards[worstIdx];
        if (c.rank < w.rank || (c.rank === w.rank && c.suit < w.suit)) {
          worstIdx = i;
        }
      }
      const [removed] = seat.holeCards.splice(worstIdx, 1);
      this.actionLog.push({
        seatIndex: seat.seatIndex,
        playerName: seat.playerName,
        action: `auto-discarded ${this.cardLabel(removed)}`,
      });
      this.emit('pineappleDiscarded', { seatIndex: seat.seatIndex, card: removed });
    }
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

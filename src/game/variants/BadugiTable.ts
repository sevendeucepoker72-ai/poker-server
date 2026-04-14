import { Card } from '../Card';
import { HandResult } from '../HandEvaluator';
import { evaluateBadugiHand } from '../HandEvaluatorExtensions';
import { TableConfig } from '../PokerTable';
import { FiveCardDrawTable } from './FiveCardDrawTable';

/**
 * BadugiTable — Badugi 4-card lowball with 3 draw rounds.
 *
 * Best hand: A-2-3-4 of four different suits ("perfect badugi").
 * Smaller "rainbow" sets count too: a 4-card badugi always beats a 3-card
 * hand, which always beats a 2-card hand. Within the same size, lower wins.
 *
 * Aces are LOW. Pairs and same-suit duplicates are dropped from the hand.
 * Fixed-limit betting structure (small bet on Bet1, big bet on Bet2-Bet4).
 *
 * Reuses FiveCardDrawTable's draw infrastructure (3 draw rounds, discard
 * reshuffle, etc.) but with 4 hole cards instead of 5 and a Badugi evaluator.
 */
export class BadugiTable extends FiveCardDrawTable {
  constructor(config: TableConfig) {
    // Triple-draw format (3 draws, 4 betting rounds) with 4 hole cards.
    super(config, true);

    // Override variant labels set by FiveCardDrawTable
    this.variantId = 'badugi';
    this.variantName = 'Badugi';
    this.holeCardCount = 4;
  }

  /** Override: deal 4 hole cards instead of 5. */
  protected getHoleCardCount(): number {
    return 4;
  }

  /** Override: use Badugi evaluation. */
  protected evaluatePlayerHand(holeCards: Card[], _communityCards: Card[]): HandResult {
    return evaluateBadugiHand(holeCards);
  }
}

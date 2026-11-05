// ============================================================================
// The ONE Pineapple keep rule (.online bots review 2026-11-04, equity-variants
// C3, finding B7) — shared by the engine's no-pick fallback
// (PineappleTable.fallbackDiscardIndex) and the bots' pricing
// (TrainingEngine.keptHoldemHoleCards, AIPlayer.holdemHoleCards), so a bot
// always prices exactly the two cards it will keep.
//
// Before: no bot ever chose a discard, and the engine fallback dropped the
// lowest rank before the flop — it broke 50% of dealt pairs (77K kept K7) and
// lost 1.2 equity points on average; at Crazy Pineapple the bot priced the
// lowest-rank pair while the engine kept the board-aware best pair (a
// mismatch on 22.4% of flops).
// ============================================================================
import { Card } from '../Card';
import { evaluateHand, compareTo, HandResult } from '../HandEvaluator';
import { percentileByRanks } from '../../ai/preflopRanges';

/**
 * Index of the card to discard from a Pineapple hand.
 *
 * - The rank rule picks the weakest card: lowest rank, ties to the lowest suit.
 *   Fewer than 2 cards → 0; any count other than 3 → the weakest card.
 * - With a board of 3 or more cards (the Crazy Pineapple discard, gameplay
 *   F16): drop the card whose loss leaves the BEST hand with the board under
 *   `evalHand` / `cmp`; only a strictly better hand replaces the weakest card.
 * - With no board (the Pineapple pre-flop discard): keep the pair with the
 *   highest full-deck Hold'em pre-flop percentile (preflopRanges); only a
 *   strictly higher percentile replaces the weakest card, so ties keep the
 *   rank rule. 77K keeps 77, 55K keeps 55, 22A keeps A2.
 *
 * Pure: reads only its arguments and the committed percentile; no Math.random.
 */
export function pineappleDiscardIndex(
  cards: Card[],
  board: Card[] = [],
  evalHand: (hole: Card[], board: Card[]) => HandResult = (h, b) => evaluateHand([...h, ...b]),
  cmp: (a: HandResult, b: HandResult) => number = compareTo,
): number {
  if (!cards || cards.length < 2) return 0;
  let weakest = 0;
  for (let i = 1; i < cards.length; i++) {
    const c = cards[i];
    const w = cards[weakest];
    if (c.rank < w.rank || (c.rank === w.rank && c.suit < w.suit)) weakest = i;
  }
  if (cards.length !== 3) return weakest;
  const without = (i: number): Card[] => cards.filter((_c, j) => j !== i);
  let best = weakest;
  if (board && board.length >= 3) {
    let bestHand = evalHand(without(weakest), board);
    for (let i = 0; i < cards.length; i++) {
      if (i === weakest) continue;
      const hand = evalHand(without(i), board);
      if (cmp(hand, bestHand) > 0) { best = i; bestHand = hand; }
    }
    return best;
  }
  const pctile = (i: number): number => {
    const k = without(i);
    return percentileByRanks(k[0].rank, k[1].rank, k[0].suit === k[1].suit);
  };
  let bestP = pctile(weakest);
  for (let i = 0; i < cards.length; i++) {
    if (i === weakest) continue;
    const p = pctile(i);
    if (p > bestP) { best = i; bestP = p; }
  }
  return best;
}

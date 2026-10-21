/**
 * 2026-10-21 (gameplay F42) — the hand rank a hand WIN feeds progression with
 * (ProgressionManager.recordHandWon: bluff wins, rare-hand counters,
 * handsPerRank, the daily windows; missions' bluff_win / flush_plus; the
 * activity ticker and the royal-flush achievement in handleHandComplete).
 *
 * Those all read a STANDARD high-hand HandRank (HandEvaluator: 0 = high card
 * ... 6 = full house ... 9 = royal flush). The engine's handResult.handRank is
 * variant-specific and was passed through raw:
 *   - Razz / 2-7 Triple Draw: a lowball "badness" (0 = no pair — nearly every
 *     win), so almost every lowball win counted as a BLUFF (d_bluff 1,000/day,
 *     bluff_10 / bluff_50, the bluff_1 mission);
 *   - Badugi: the hand SIZE (4 = a 4-card badugi, filed as a straight);
 *   - a hi-lo LOW half (Omaha / Stud 8): the 8-or-better low, always rank 0;
 *   - Short Deck: ShortDeckHandRank (Flush 6 / Full House 5, trips 4 /
 *     straight 3), so a flush paid the full-house rewards and vice versa;
 *   - a Stud 8 pot won uncontested carried its high hand (a fold win counted
 *     as a bluff — elsewhere a fold win carries no hand).
 *
 * Returns a standard HandRank, or undefined — "no hand to count": the win
 * itself (handsWon, pot, streak, all-in, XP) still counts.
 */
import { HandRank } from '../game/HandEvaluator';
import { ShortDeckHandRank } from '../game/HandEvaluatorExtensions';

/** Lowball games: no high-hand rank exists (variantId as the tables set it). */
export const LOWBALL_PROGRESSION_VARIANTS: ReadonlySet<string> = new Set(['razz', 'triple-draw', 'badugi']);

const SHORT_DECK_TO_STANDARD: Record<number, HandRank> = {
  [ShortDeckHandRank.HighCard]: HandRank.HighCard,
  [ShortDeckHandRank.OnePair]: HandRank.OnePair,
  [ShortDeckHandRank.TwoPair]: HandRank.TwoPair,
  [ShortDeckHandRank.Straight]: HandRank.Straight,
  [ShortDeckHandRank.ThreeOfAKind]: HandRank.ThreeOfAKind,
  [ShortDeckHandRank.FullHouse]: HandRank.FullHouse,
  [ShortDeckHandRank.Flush]: HandRank.Flush,
  [ShortDeckHandRank.FourOfAKind]: HandRank.FourOfAKind,
  [ShortDeckHandRank.StraightFlush]: HandRank.StraightFlush,
  [ShortDeckHandRank.RoyalFlush]: HandRank.RoyalFlush,
};

/**
 * @param variantId     the table's own variantId (PokerTable.variantId: 'holdem',
 *                      'razz', 'triple-draw', 'badugi', 'short-deck', 'omaha-hi-lo', ...)
 * @param seatResults   this seat's entries of the hand's `results` (handResult + potName)
 * @param wentToShowdown the table's wentToShowdown (a CONTESTED showdown)
 */
export function progressionHandRank(
  variantId: string | undefined,
  seatResults: ReadonlyArray<{ handResult?: { handRank?: number } | null; potName?: string }>,
  wentToShowdown: boolean,
): number | undefined {
  if (!wentToShowdown) return undefined;                       // won uncontested: no hand shown
  if (variantId && LOWBALL_PROGRESSION_VARIANTS.has(variantId)) return undefined;
  // A hi-lo LOW half is never a high hand: the seat's first non-low entry
  // (a seat that won only low halves has none).
  const high = seatResults.find((r) => !(typeof r.potName === 'string' && r.potName.endsWith('(Low)')));
  const rank = high?.handResult?.handRank;
  if (typeof rank !== 'number' || !Number.isFinite(rank)) return undefined;
  if (variantId === 'short-deck') return SHORT_DECK_TO_STANDARD[rank];
  return rank;
}

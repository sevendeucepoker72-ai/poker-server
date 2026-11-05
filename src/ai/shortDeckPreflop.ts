// ============================================================================
// Short Deck (6+ Hold'em) pre-flop percentile table
// (.online bots review 2026-11-04, equity-variants C5, finding B13).
//
// Short Deck used to read the FULL-deck Hold'em percentile, where every
// short-deck hand looks strong: 28-32% of combos cleared the early-position
// open threshold (0.85) and 69-73% the button's (0.55), and the hand order was
// not short-deck aware. This is the same metric and the same formula as the
// Hold'em percentile in preflopRanges (heads-up equity against one random
// hand, ranked strongest first, percentile = 1 - (running + combos / 2) /
// total), played under the engine's Short Deck rules: the 36-card deck and
// HandEvaluatorExtensions.evaluateShortDeckHand (trips beat a straight, a
// flush beats a full house, A-6-7-8-9 is a straight).
//
// 81 classes, 630 combos. A committed literal: deterministic, no Math.random,
// no build at load. Regenerate with `npx ts-node -T gen-short-deck-preflop.ts`
// (repo root; seeds mulberry32(20261104 + classIndex), 400,000 simulations per
// class); `VERIFY=1` checks it reproduces this table exactly. Shares at the
// shared thresholds: 0.85 15.2%, 0.80 21.0%, 0.72 27.9%, 0.55 44.1%,
// 0.965 3.8% (AA-JJ). Short Deck has no stack-off column: its 4-bet and
// stack-off decisions fall back to this percentile.
// ============================================================================
import { Card } from '../game/Card';
import { getHandCode, handCodeFrom } from './preflopRanges';

/** Short Deck pre-flop percentile by preflopRanges hand code ("AA", "AKs", "76o", ...), strongest first. */
export const SHORT_DECK_PREFLOP_PCTILE: Readonly<Record<string, number>> = Object.freeze({
  'AA': 0.9952, 'KK': 0.9857, 'QQ': 0.9762, 'JJ': 0.9667, 'TT': 0.9571, 'AKs': 0.9492, 'AQs': 0.9429, '99': 0.9349,
  'AKo': 0.9206, 'AJs': 0.9079, 'KQs': 0.9016, 'AQo': 0.8889, 'ATs': 0.8762, 'KJs': 0.8698, 'AJo': 0.8571, 'QJs': 0.8444,
  'KTs': 0.8381, 'KQo': 0.8254, 'QTs': 0.8127, 'ATo': 0.8, 'A9s': 0.7873, 'JTs': 0.781, 'KJo': 0.7683, 'QJo': 0.7492,
  'KTo': 0.7302, 'QTo': 0.7111, 'A8s': 0.6984, 'A9o': 0.6857, 'JTo': 0.6667, '88': 0.6524, 'K9s': 0.6444, 'A8o': 0.6317,
  'A7s': 0.619, 'Q9s': 0.6127, 'J9s': 0.6063, 'T9s': 0.6, 'K9o': 0.5873, 'Q9o': 0.5683, 'A7o': 0.5492, 'A6s': 0.5365,
  'J9o': 0.5238, 'T9o': 0.5048, 'K8s': 0.4921, 'Q8s': 0.4857, 'J8s': 0.4794, 'K7s': 0.473, 'T8s': 0.4667, '98s': 0.4603,
  'A6o': 0.4476, 'K8o': 0.4286, '77': 0.4143, 'Q8o': 0.4, 'J8o': 0.381, 'T8o': 0.3619, 'K6s': 0.3492, '98o': 0.3365,
  'K7o': 0.3175, 'Q7s': 0.3048, '97s': 0.2984, 'J7s': 0.2921, 'T7s': 0.2857, 'Q6s': 0.2794, 'K6o': 0.2667, 'Q7o': 0.2476,
  'J7o': 0.2286, '97o': 0.2095, 'T7o': 0.1905, '87s': 0.1778, 'Q6o': 0.1651, '96s': 0.1524, 'J6s': 0.146, 'T6s': 0.1397,
  '66': 0.1317, '87o': 0.1175, '96o': 0.0984, '86s': 0.0857, 'T6o': 0.073, 'J6o': 0.054, '86o': 0.0349, '76s': 0.0222,
  '76o': 0.0095,
});

/** Short Deck pre-flop percentile of the first two hole cards; 0 when unknown (fewer than 2 cards, or a rank below 6). */
export function getShortDeckPreflopPercentile(hole: Card[]): number {
  if (!hole || hole.length < 2) return 0;
  return SHORT_DECK_PREFLOP_PCTILE[getHandCode(hole)] ?? 0;
}

/** Short Deck percentile by (rank, rank, suited) — the Short Deck range-aware equity sampler. 0 when unknown. */
export function shortDeckPercentileByRanks(r1: number, r2: number, suited: boolean): number {
  return SHORT_DECK_PREFLOP_PCTILE[handCodeFrom(r1, r2, suited)] ?? 0;
}

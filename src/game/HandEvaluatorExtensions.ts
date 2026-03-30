import { Card, Rank, Suit } from './Card';
import { HandRank, HandResult, evaluateHand, compareTo } from './HandEvaluator';

// ============================================================
// Utility: generate all C(n,k) combinations
// ============================================================
function combinations<T>(arr: T[], k: number): T[][] {
  const result: T[][] = [];
  const combo: T[] = [];
  function backtrack(start: number) {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      backtrack(i + 1);
      combo.pop();
    }
  }
  backtrack(0);
  return result;
}

// ============================================================
// Short Deck Hand Ranking
// ============================================================

/**
 * Short Deck modified hand rankings:
 * Flush (6) beats Full House (5), Three of a Kind (4) beats Straight (3).
 */
export enum ShortDeckHandRank {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  Straight = 3,
  ThreeOfAKind = 4,
  FullHouse = 5,
  Flush = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

const SHORT_DECK_HAND_NAMES: Record<ShortDeckHandRank, string> = {
  [ShortDeckHandRank.HighCard]: 'High Card',
  [ShortDeckHandRank.OnePair]: 'One Pair',
  [ShortDeckHandRank.TwoPair]: 'Two Pair',
  [ShortDeckHandRank.Straight]: 'Straight',
  [ShortDeckHandRank.ThreeOfAKind]: 'Three of a Kind',
  [ShortDeckHandRank.FullHouse]: 'Full House',
  [ShortDeckHandRank.Flush]: 'Flush',
  [ShortDeckHandRank.FourOfAKind]: 'Four of a Kind',
  [ShortDeckHandRank.StraightFlush]: 'Straight Flush',
  [ShortDeckHandRank.RoyalFlush]: 'Royal Flush',
};

// ============================================================
// Internal helpers
// ============================================================

function getRankCounts(cards: Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  return counts;
}

function isFlush(cards: Card[]): boolean {
  if (cards.length === 0) return false;
  const suit = cards[0].suit;
  return cards.every(c => c.suit === suit);
}

function isStraight(cards: Card[]): { straight: boolean; highCard: Rank } {
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);
  // Check wheel (A-2-3-4-5)
  if (
    ranks[0] === Rank.Two &&
    ranks[1] === Rank.Three &&
    ranks[2] === Rank.Four &&
    ranks[3] === Rank.Five &&
    ranks[4] === Rank.Ace
  ) {
    return { straight: true, highCard: Rank.Five };
  }
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) {
      return { straight: false, highCard: ranks[ranks.length - 1] };
    }
  }
  return { straight: true, highCard: ranks[ranks.length - 1] };
}

/**
 * Short Deck straight check: A-6-7-8-9 is the lowest straight (ace wraps to 5 position).
 * Deck has 6-A only, no 2-5.
 */
function isShortDeckStraight(cards: Card[]): { straight: boolean; highCard: Rank } {
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);

  // Check A-6-7-8-9 wrap (ace plays low as 5)
  if (
    ranks[0] === Rank.Six &&
    ranks[1] === Rank.Seven &&
    ranks[2] === Rank.Eight &&
    ranks[3] === Rank.Nine &&
    ranks[4] === Rank.Ace
  ) {
    return { straight: true, highCard: Rank.Nine };
  }

  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) {
      return { straight: false, highCard: ranks[ranks.length - 1] };
    }
  }
  return { straight: true, highCard: ranks[ranks.length - 1] };
}

function evaluateFiveCards(cards: Card[]): HandResult {
  const flush = isFlush(cards);
  const straightResult = isStraight(cards);
  const straight = straightResult.straight;
  const rankCounts = getRankCounts(cards);
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);

  if (flush && straight) {
    if (straightResult.highCard === Rank.Ace && sorted[sorted.length - 1].rank === Rank.Ten) {
      return {
        handRank: HandRank.RoyalFlush,
        primaryValue: Rank.Ace,
        kickers: [],
        bestFiveCards: sorted,
        handName: 'Royal Flush',
      };
    }
    return {
      handRank: HandRank.StraightFlush,
      primaryValue: straightResult.highCard,
      kickers: [],
      bestFiveCards: sorted,
      handName: 'Straight Flush',
    };
  }

  const fours: Rank[] = [];
  const threes: Rank[] = [];
  const pairs: Rank[] = [];
  const singles: Rank[] = [];

  for (const [rank, count] of rankCounts) {
    switch (count) {
      case 4: fours.push(rank); break;
      case 3: threes.push(rank); break;
      case 2: pairs.push(rank); break;
      case 1: singles.push(rank); break;
    }
  }
  fours.sort((a, b) => b - a);
  threes.sort((a, b) => b - a);
  pairs.sort((a, b) => b - a);
  singles.sort((a, b) => b - a);

  if (fours.length === 1) {
    const kicker = [...pairs, ...threes, ...singles].sort((a, b) => b - a);
    return {
      handRank: HandRank.FourOfAKind,
      primaryValue: fours[0],
      kickers: kicker.slice(0, 1),
      bestFiveCards: sorted,
      handName: 'Four of a Kind',
    };
  }
  if (threes.length >= 1 && pairs.length >= 1) {
    return {
      handRank: HandRank.FullHouse,
      primaryValue: threes[0],
      kickers: [pairs[0]],
      bestFiveCards: sorted,
      handName: 'Full House',
    };
  }
  if (flush) {
    const ranks = sorted.map(c => c.rank);
    return {
      handRank: HandRank.Flush,
      primaryValue: ranks[0],
      kickers: ranks.slice(1),
      bestFiveCards: sorted,
      handName: 'Flush',
    };
  }
  if (straight) {
    return {
      handRank: HandRank.Straight,
      primaryValue: straightResult.highCard,
      kickers: [],
      bestFiveCards: sorted,
      handName: 'Straight',
    };
  }
  if (threes.length === 1 && pairs.length === 0) {
    return {
      handRank: HandRank.ThreeOfAKind,
      primaryValue: threes[0],
      kickers: singles.slice(0, 2),
      bestFiveCards: sorted,
      handName: 'Three of a Kind',
    };
  }
  if (pairs.length >= 2) {
    const kicker = [...singles, ...threes].sort((a, b) => b - a);
    return {
      handRank: HandRank.TwoPair,
      primaryValue: pairs[0],
      kickers: [pairs[1], ...kicker.slice(0, 1)],
      bestFiveCards: sorted,
      handName: 'Two Pair',
    };
  }
  if (pairs.length === 1) {
    return {
      handRank: HandRank.OnePair,
      primaryValue: pairs[0],
      kickers: singles.slice(0, 3),
      bestFiveCards: sorted,
      handName: 'One Pair',
    };
  }

  const ranks = sorted.map(c => c.rank);
  return {
    handRank: HandRank.HighCard,
    primaryValue: ranks[0],
    kickers: ranks.slice(1),
    bestFiveCards: sorted,
    handName: 'High Card',
  };
}

// ============================================================
// Omaha Hand Evaluation
// ============================================================

/**
 * Omaha: must use exactly 2 of 4 hole cards + exactly 3 of 5 community.
 * Generate all C(4,2)=6 hole combos x C(5,3)=10 community combos = 60.
 * Evaluate each 5-card hand, return the best.
 */
export function evaluateOmahaHand(holeCards: Card[], communityCards: Card[]): HandResult {
  const holeCombos = combinations(holeCards, 2);
  const commCombos = combinations(communityCards, 3);

  let bestResult: HandResult | null = null;

  for (const hole of holeCombos) {
    for (const comm of commCombos) {
      const fiveCards = [...hole, ...comm];
      const result = evaluateFiveCards(fiveCards);
      if (bestResult === null || compareTo(result, bestResult) > 0) {
        bestResult = result;
      }
    }
  }

  return bestResult!;
}

// ============================================================
// Low Hand Evaluation (for Hi-Lo games)
// ============================================================

/**
 * Low hand for Hi-Lo: best 5-card low (8 or better qualifier).
 * Aces are low (value 1), straights/flushes don't count against low.
 * Returns null if no qualifying low hand can be made.
 *
 * A "low hand" is 5 unpaired cards all ranked 8 or below.
 * A-2-3-4-5 ("the wheel") is the best low.
 * Compare lows by highest card first descending.
 */
export function evaluateLowHand(cards: Card[]): HandResult | null {
  // Map ranks to low values: Ace = 1, 2=2, ..., 8=8
  // Cards ranked 9+ don't qualify
  const lowCards = cards.filter(c => c.rank <= Rank.Eight || c.rank === Rank.Ace);

  // Need at least 5 qualifying cards
  if (lowCards.length < 5) return null;

  // Get unique ranks only (no pairs allowed in low hands)
  const uniqueRankMap = new Map<number, Card>();
  for (const card of lowCards) {
    const lowRank = card.rank === Rank.Ace ? 1 : card.rank;
    if (!uniqueRankMap.has(lowRank)) {
      uniqueRankMap.set(lowRank, card);
    }
  }

  if (uniqueRankMap.size < 5) return null;

  // Sort by low rank ascending, take first 5
  const sortedEntries = [...uniqueRankMap.entries()].sort((a, b) => a[0] - b[0]);
  const bestFive = sortedEntries.slice(0, 5);
  const bestFiveCards = bestFive.map(e => e[1]);
  const lowRanks = bestFive.map(e => e[0]);

  // For comparison: kickers are the ranks sorted highest-first (for comparing lows)
  // Lower is better, so we use negative values so standard compareTo works inversely
  const highestFirst = [...lowRanks].sort((a, b) => b - a);

  return {
    handRank: HandRank.HighCard, // Low hands don't really use HandRank for ranking
    primaryValue: highestFirst[0],
    kickers: highestFirst.slice(1),
    bestFiveCards,
    handName: `Low: ${lowRanks.join('-')}`,
  };
}

/**
 * Compare two low hand results. Lower is better.
 * Returns negative if a is better (lower), positive if b is better, 0 for tie.
 */
export function compareLowHands(a: HandResult | null, b: HandResult | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // b is better (has a qualifying low)
  if (b === null) return -1; // a is better

  // Compare highest card first (lower is better)
  if (a.primaryValue !== b.primaryValue) {
    return a.primaryValue - b.primaryValue; // lower wins
  }
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) {
      return a.kickers[i] - b.kickers[i]; // lower wins
    }
  }
  return 0;
}

/**
 * Omaha Hi-Lo: evaluate both high and low hands.
 * Must use exactly 2 hole cards + 3 community cards for EACH evaluation.
 */
export function evaluateOmahaHiLo(
  holeCards: Card[],
  communityCards: Card[]
): { high: HandResult; low: HandResult | null } {
  const holeCombos = combinations(holeCards, 2);
  const commCombos = combinations(communityCards, 3);

  let bestHigh: HandResult | null = null;
  let bestLow: HandResult | null = null;

  for (const hole of holeCombos) {
    for (const comm of commCombos) {
      const fiveCards = [...hole, ...comm];

      // Evaluate high
      const highResult = evaluateFiveCards(fiveCards);
      if (bestHigh === null || compareTo(highResult, bestHigh) > 0) {
        bestHigh = highResult;
      }

      // Evaluate low
      const lowResult = evaluateLowHand(fiveCards);
      if (lowResult !== null) {
        if (bestLow === null || compareLowHands(lowResult, bestLow) < 0) {
          bestLow = lowResult;
        }
      }
    }
  }

  return { high: bestHigh!, low: bestLow };
}

/**
 * Omaha low hand evaluation helper used by OmahaHiLoVariant.
 * Returns null if no qualifying low.
 */
export function evaluateOmahaLowHand(holeCards: Card[], communityCards: Card[]): HandResult | null {
  const holeCombos = combinations(holeCards, 2);
  const commCombos = combinations(communityCards, 3);

  let bestLow: HandResult | null = null;

  for (const hole of holeCombos) {
    for (const comm of commCombos) {
      const fiveCards = [...hole, ...comm];
      const lowResult = evaluateLowHand(fiveCards);
      if (lowResult !== null) {
        if (bestLow === null || compareLowHands(lowResult, bestLow) < 0) {
          bestLow = lowResult;
        }
      }
    }
  }

  return bestLow;
}

// ============================================================
// Short Deck Hand Evaluation
// ============================================================

/**
 * Evaluate a 5-card hand using Short Deck rankings.
 * Modified: Flush > Full House, Three of a Kind > Straight.
 * Uses ShortDeckHandRank for ordering but returns standard HandResult
 * with the handRank field remapped.
 */
function evaluateShortDeckFiveCards(cards: Card[]): HandResult {
  const flush = isFlush(cards);
  const straightResult = isShortDeckStraight(cards);
  const straight = straightResult.straight;
  const rankCounts = getRankCounts(cards);
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);

  const fours: Rank[] = [];
  const threes: Rank[] = [];
  const pairs: Rank[] = [];
  const singles: Rank[] = [];

  for (const [rank, count] of rankCounts) {
    switch (count) {
      case 4: fours.push(rank); break;
      case 3: threes.push(rank); break;
      case 2: pairs.push(rank); break;
      case 1: singles.push(rank); break;
    }
  }
  fours.sort((a, b) => b - a);
  threes.sort((a, b) => b - a);
  pairs.sort((a, b) => b - a);
  singles.sort((a, b) => b - a);

  // Straight Flush / Royal Flush (highest)
  if (flush && straight) {
    if (straightResult.highCard === Rank.Ace && sorted[sorted.length - 1].rank === Rank.Ten) {
      return {
        handRank: ShortDeckHandRank.RoyalFlush as number,
        primaryValue: Rank.Ace,
        kickers: [],
        bestFiveCards: sorted,
        handName: 'Royal Flush',
      };
    }
    return {
      handRank: ShortDeckHandRank.StraightFlush as number,
      primaryValue: straightResult.highCard,
      kickers: [],
      bestFiveCards: sorted,
      handName: 'Straight Flush',
    };
  }

  // Four of a Kind
  if (fours.length === 1) {
    const kicker = [...pairs, ...threes, ...singles].sort((a, b) => b - a);
    return {
      handRank: ShortDeckHandRank.FourOfAKind as number,
      primaryValue: fours[0],
      kickers: kicker.slice(0, 1),
      bestFiveCards: sorted,
      handName: 'Four of a Kind',
    };
  }

  // Flush beats Full House in short deck
  if (flush) {
    const ranks = sorted.map(c => c.rank);
    return {
      handRank: ShortDeckHandRank.Flush as number,
      primaryValue: ranks[0],
      kickers: ranks.slice(1),
      bestFiveCards: sorted,
      handName: 'Flush',
    };
  }

  // Full House
  if (threes.length >= 1 && pairs.length >= 1) {
    return {
      handRank: ShortDeckHandRank.FullHouse as number,
      primaryValue: threes[0],
      kickers: [pairs[0]],
      bestFiveCards: sorted,
      handName: 'Full House',
    };
  }

  // Three of a Kind beats Straight in short deck
  if (threes.length === 1 && pairs.length === 0) {
    return {
      handRank: ShortDeckHandRank.ThreeOfAKind as number,
      primaryValue: threes[0],
      kickers: singles.slice(0, 2),
      bestFiveCards: sorted,
      handName: 'Three of a Kind',
    };
  }

  // Straight
  if (straight) {
    return {
      handRank: ShortDeckHandRank.Straight as number,
      primaryValue: straightResult.highCard,
      kickers: [],
      bestFiveCards: sorted,
      handName: 'Straight',
    };
  }

  // Two Pair
  if (pairs.length >= 2) {
    const kicker = [...singles, ...threes].sort((a, b) => b - a);
    return {
      handRank: ShortDeckHandRank.TwoPair as number,
      primaryValue: pairs[0],
      kickers: [pairs[1], ...kicker.slice(0, 1)],
      bestFiveCards: sorted,
      handName: 'Two Pair',
    };
  }

  // One Pair
  if (pairs.length === 1) {
    return {
      handRank: ShortDeckHandRank.OnePair as number,
      primaryValue: pairs[0],
      kickers: singles.slice(0, 3),
      bestFiveCards: sorted,
      handName: 'One Pair',
    };
  }

  // High Card
  const ranks = sorted.map(c => c.rank);
  return {
    handRank: ShortDeckHandRank.HighCard as number,
    primaryValue: ranks[0],
    kickers: ranks.slice(1),
    bestFiveCards: sorted,
    handName: 'High Card',
  };
}

/**
 * Short Deck: evaluate best 5-card hand from available cards.
 * Uses modified hand rankings where Flush > Full House and Trips > Straight.
 */
export function evaluateShortDeckHand(cards: Card[]): HandResult {
  if (cards.length <= 5) {
    return evaluateShortDeckFiveCards(cards);
  }

  const allCombos = combinations(cards, 5);
  let bestResult: HandResult | null = null;

  for (const combo of allCombos) {
    const result = evaluateShortDeckFiveCards(combo);
    if (bestResult === null || compareTo(result, bestResult) > 0) {
      bestResult = result;
    }
  }

  return bestResult!;
}

// ============================================================
// Razz (7-Card Stud Low) Evaluation
// ============================================================

/**
 * Razz / Stud Lo: lowest hand wins.
 * Aces are LOW (value 1). Straights and flushes DO NOT count against you.
 * Best hand is A-2-3-4-5.
 * Pairs are bad (higher rank = worse).
 *
 * We evaluate by assigning a "badness" score:
 * - Start with an inverted rank value for comparison
 * - Higher cards = worse, pairs = worse
 *
 * Returns a HandResult where lower handRank/primaryValue/kickers is better.
 */
export function evaluateRazzHand(cards: Card[]): HandResult {
  if (cards.length < 5) {
    return evaluateRazzFiveCards(cards);
  }

  const allCombos = combinations(cards, 5);
  let bestResult: HandResult | null = null;

  for (const combo of allCombos) {
    const result = evaluateRazzFiveCards(combo);
    if (bestResult === null || compareRazzHands(result, bestResult) < 0) {
      bestResult = result;
    }
  }

  return bestResult!;
}

function razzRankValue(rank: Rank): number {
  // Ace = 1 (best/lowest), rest as face value
  return rank === Rank.Ace ? 1 : rank;
}

function evaluateRazzFiveCards(cards: Card[]): HandResult {
  const razzValues = cards.map(c => razzRankValue(c.rank)).sort((a, b) => a - b);

  // Check for pairs (bad in razz)
  const counts = new Map<number, number>();
  for (const v of razzValues) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  let hasPair = false;
  let hasTrips = false;
  let hasQuads = false;
  for (const count of counts.values()) {
    if (count >= 4) hasQuads = true;
    else if (count >= 3) hasTrips = true;
    else if (count >= 2) hasPair = true;
  }

  // Assign a "badness" handRank: no pairs is best (0), pair (1), two pair (2), trips (3), etc.
  let badnessRank = 0;
  if (hasQuads) badnessRank = 4;
  else if (hasTrips && hasPair) badnessRank = 3; // full house equivalent
  else if (hasTrips) badnessRank = 3;
  else if (hasPair) {
    const pairCount = [...counts.values()].filter(c => c >= 2).length;
    badnessRank = pairCount >= 2 ? 2 : 1;
  }

  // For comparison: sort values highest first
  const highestFirst = [...razzValues].sort((a, b) => b - a);

  const sorted = [...cards].sort((a, b) => razzRankValue(a.rank) - razzRankValue(b.rank));

  return {
    handRank: badnessRank as HandRank,
    primaryValue: highestFirst[0],
    kickers: highestFirst.slice(1),
    bestFiveCards: sorted,
    handName: `Low: ${razzValues.join('-')}`,
  };
}

/**
 * Compare razz hands. Lower is better.
 * Returns negative if a is better, positive if b is better, 0 for tie.
 */
export function compareRazzHands(a: HandResult, b: HandResult): number {
  // Lower handRank = better (fewer pairs)
  if (a.handRank !== b.handRank) return a.handRank - b.handRank;
  // Lower primaryValue = better
  if (a.primaryValue !== b.primaryValue) return a.primaryValue - b.primaryValue;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

// ============================================================
// 2-7 Lowball (Triple Draw) Evaluation
// ============================================================

/**
 * 2-7 lowball: lowest hand wins. Aces are HIGH (14).
 * Straights and flushes count AGAINST you (they are bad).
 * Best hand is 2-3-4-5-7 (not suited, since flush would count against).
 *
 * We score: if hand has flush or straight, it's worse.
 * Pairs also bad. Otherwise compare by highest card descending.
 */
export function evaluate27LowHand(cards: Card[]): HandResult {
  if (cards.length < 5) {
    return evaluate27FiveCards(cards);
  }

  const allCombos = combinations(cards, 5);
  let bestResult: HandResult | null = null;

  for (const combo of allCombos) {
    const result = evaluate27FiveCards(combo);
    if (bestResult === null || compare27Hands(result, bestResult) < 0) {
      bestResult = result;
    }
  }

  return bestResult!;
}

function evaluate27FiveCards(cards: Card[]): HandResult {
  // In 2-7, aces are HIGH (14), all ranks at face value
  const values = cards.map(c => c.rank).sort((a, b) => a - b);

  // Check for flush (bad)
  const flushCheck = isFlush(cards);

  // Check for straight (bad) - aces are high, no ace-low straight
  let straightCheck = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1] + 1) {
      straightCheck = false;
      break;
    }
  }

  // Check for pairs
  const counts = new Map<number, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  let hasPair = false;
  let pairCount = 0;
  let hasTrips = false;
  let hasQuads = false;
  for (const count of counts.values()) {
    if (count >= 4) hasQuads = true;
    else if (count >= 3) hasTrips = true;
    else if (count >= 2) { hasPair = true; pairCount++; }
  }

  // Assign badness: lower = better
  // 0 = no made hand (best), 1 = pair, 2 = two pair, 3 = trips/full house, 4 = quads
  // 5 = straight, 6 = flush, 7 = full house, 8 = straight flush
  let badnessRank = 0;
  if (hasQuads) badnessRank = 7;
  else if (hasTrips && hasPair) badnessRank = 6; // full house
  else if (flushCheck && straightCheck) badnessRank = 8; // straight flush
  else if (hasTrips) badnessRank = 5;
  else if (flushCheck) badnessRank = 4;
  else if (straightCheck) badnessRank = 3;
  else if (pairCount >= 2) badnessRank = 2;
  else if (hasPair) badnessRank = 1;

  const highestFirst = [...values].sort((a, b) => b - a);
  const sorted = [...cards].sort((a, b) => a.rank - b.rank);

  return {
    handRank: badnessRank as HandRank,
    primaryValue: highestFirst[0],
    kickers: highestFirst.slice(1),
    bestFiveCards: sorted,
    handName: `${values.join('-')}${flushCheck ? ' (flush)' : ''}${straightCheck ? ' (straight)' : ''}`,
  };
}

/**
 * Compare 2-7 hands. Lower is better.
 */
export function compare27Hands(a: HandResult, b: HandResult): number {
  if (a.handRank !== b.handRank) return a.handRank - b.handRank;
  if (a.primaryValue !== b.primaryValue) return a.primaryValue - b.primaryValue;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

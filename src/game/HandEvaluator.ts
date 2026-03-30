import { Card, Rank, Suit, cardToString } from './Card';

export enum HandRank {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

const HAND_NAMES: Record<HandRank, string> = {
  [HandRank.HighCard]: 'High Card',
  [HandRank.OnePair]: 'One Pair',
  [HandRank.TwoPair]: 'Two Pair',
  [HandRank.ThreeOfAKind]: 'Three of a Kind',
  [HandRank.Straight]: 'Straight',
  [HandRank.Flush]: 'Flush',
  [HandRank.FullHouse]: 'Full House',
  [HandRank.FourOfAKind]: 'Four of a Kind',
  [HandRank.StraightFlush]: 'Straight Flush',
  [HandRank.RoyalFlush]: 'Royal Flush',
};

export interface HandResult {
  handRank: HandRank;
  primaryValue: number;
  kickers: number[];
  bestFiveCards: Card[];
  handName: string;
}

export function compareTo(a: HandResult, b: HandResult): number {
  if (a.handRank !== b.handRank) {
    return a.handRank - b.handRank;
  }
  if (a.primaryValue !== b.primaryValue) {
    return a.primaryValue - b.primaryValue;
  }
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) {
      return a.kickers[i] - b.kickers[i];
    }
  }
  return 0; // tie
}

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

/**
 * TDA Rule 2E: Ace plays high AND low for straights.
 * Wheel (A-2-3-4-5) is the lowest straight.
 * Hand ranking order: Royal Flush > Straight Flush > Four of a Kind >
 * Full House > Flush > Straight > Three of a Kind > Two Pair > One Pair > High Card.
 * Full House: trips rank determines winner, then pair rank (kicker).
 * Kickers are compared correctly for same-rank hands.
 */
function isStraight(cards: Card[]): { straight: boolean; highCard: Rank } {
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);

  // Check wheel (A-2-3-4-5) - Ace plays low
  if (
    ranks[0] === Rank.Two &&
    ranks[1] === Rank.Three &&
    ranks[2] === Rank.Four &&
    ranks[3] === Rank.Five &&
    ranks[4] === Rank.Ace
  ) {
    return { straight: true, highCard: Rank.Five };
  }

  // Check normal straight
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

  // Straight Flush / Royal Flush
  if (flush && straight) {
    if (straightResult.highCard === Rank.Ace && sorted[sorted.length - 1].rank === Rank.Ten) {
      return {
        handRank: HandRank.RoyalFlush,
        primaryValue: Rank.Ace,
        kickers: [],
        bestFiveCards: sorted,
        handName: HAND_NAMES[HandRank.RoyalFlush],
      };
    }
    return {
      handRank: HandRank.StraightFlush,
      primaryValue: straightResult.highCard,
      kickers: [],
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.StraightFlush],
    };
  }

  // Build arrays of ranks by count
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

  // Four of a Kind
  if (fours.length === 1) {
    const kicker = [...pairs, ...threes, ...singles].sort((a, b) => b - a);
    return {
      handRank: HandRank.FourOfAKind,
      primaryValue: fours[0],
      kickers: kicker.slice(0, 1),
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.FourOfAKind],
    };
  }

  // Full House
  if (threes.length >= 1 && pairs.length >= 1) {
    return {
      handRank: HandRank.FullHouse,
      primaryValue: threes[0],
      kickers: [pairs[0]],
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.FullHouse],
    };
  }

  // Flush
  if (flush) {
    const ranks = sorted.map(c => c.rank);
    return {
      handRank: HandRank.Flush,
      primaryValue: ranks[0],
      kickers: ranks.slice(1),
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.Flush],
    };
  }

  // Straight
  if (straight) {
    return {
      handRank: HandRank.Straight,
      primaryValue: straightResult.highCard,
      kickers: [],
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.Straight],
    };
  }

  // Three of a Kind
  if (threes.length === 1 && pairs.length === 0) {
    return {
      handRank: HandRank.ThreeOfAKind,
      primaryValue: threes[0],
      kickers: singles.slice(0, 2),
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.ThreeOfAKind],
    };
  }

  // Two Pair
  if (pairs.length >= 2) {
    const kicker = [...singles, ...threes].sort((a, b) => b - a);
    return {
      handRank: HandRank.TwoPair,
      primaryValue: pairs[0],
      kickers: [pairs[1], ...kicker.slice(0, 1)],
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.TwoPair],
    };
  }

  // One Pair
  if (pairs.length === 1) {
    return {
      handRank: HandRank.OnePair,
      primaryValue: pairs[0],
      kickers: singles.slice(0, 3),
      bestFiveCards: sorted,
      handName: HAND_NAMES[HandRank.OnePair],
    };
  }

  // High Card
  const ranks = sorted.map(c => c.rank);
  return {
    handRank: HandRank.HighCard,
    primaryValue: ranks[0],
    kickers: ranks.slice(1),
    bestFiveCards: sorted,
    handName: HAND_NAMES[HandRank.HighCard],
  };
}

/**
 * Generate all C(n, k) combinations
 */
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

/**
 * Evaluate the best 5-card hand from 7 cards (2 hole + 5 community).
 * Generates all C(7,5)=21 combinations and picks the best.
 */
export function evaluateHand(cards: Card[]): HandResult {
  if (cards.length < 5) {
    // If fewer than 5 cards, evaluate what we have (shouldn't happen in normal play)
    return evaluateFiveCards(cards);
  }

  if (cards.length === 5) {
    return evaluateFiveCards(cards);
  }

  const allCombos = combinations(cards, 5);
  let bestResult: HandResult | null = null;

  for (const combo of allCombos) {
    const result = evaluateFiveCards(combo);
    if (bestResult === null || compareTo(result, bestResult) > 0) {
      bestResult = result;
    }
  }

  return bestResult!;
}

export function getHandName(rank: HandRank): string {
  return HAND_NAMES[rank];
}

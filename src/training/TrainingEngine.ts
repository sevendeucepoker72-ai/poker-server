import { Card, Rank, Suit } from '../game/Card';
import { CardDeck } from '../game/CardDeck';
import { evaluateHand, compareTo, HandRank, HandResult } from '../game/HandEvaluator';

export interface TrainingData {
  equity: number; // 0-100 win probability
  potOdds: number; // pot odds as percentage
  suggestedAction: string; // 'fold' | 'check' | 'call' | 'raise'
  suggestedRaiseAmount?: number;
  reasoning: string; // brief explanation
  handStrength: string; // e.g. "Top Pair, Jack kicker"
  outs: number; // number of outs to improve
  drawType?: string; // "flush draw", "straight draw", "none"
}

const RANK_NAMES: Record<number, string> = {
  [Rank.Two]: 'Twos',
  [Rank.Three]: 'Threes',
  [Rank.Four]: 'Fours',
  [Rank.Five]: 'Fives',
  [Rank.Six]: 'Sixes',
  [Rank.Seven]: 'Sevens',
  [Rank.Eight]: 'Eights',
  [Rank.Nine]: 'Nines',
  [Rank.Ten]: 'Tens',
  [Rank.Jack]: 'Jacks',
  [Rank.Queen]: 'Queens',
  [Rank.King]: 'Kings',
  [Rank.Ace]: 'Aces',
};

const RANK_SINGULAR: Record<number, string> = {
  [Rank.Two]: 'Two',
  [Rank.Three]: 'Three',
  [Rank.Four]: 'Four',
  [Rank.Five]: 'Five',
  [Rank.Six]: 'Six',
  [Rank.Seven]: 'Seven',
  [Rank.Eight]: 'Eight',
  [Rank.Nine]: 'Nine',
  [Rank.Ten]: 'Ten',
  [Rank.Jack]: 'Jack',
  [Rank.Queen]: 'Queen',
  [Rank.King]: 'King',
  [Rank.Ace]: 'Ace',
};

function buildFullDeck(): Card[] {
  const cards: Card[] = [];
  for (let suit = Suit.Hearts; suit <= Suit.Spades; suit++) {
    for (let rank = Rank.Two; rank <= Rank.Ace; rank++) {
      cards.push({ suit, rank });
    }
  }
  return cards;
}

function cardKey(c: Card): string {
  return `${c.rank}_${c.suit}`;
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Monte Carlo equity calculation.
 * Runs 500 simulations to estimate win probability.
 */
export function calculateEquity(
  holeCards: Card[],
  communityCards: Card[],
  numOpponents: number
): number {
  if (holeCards.length < 2) return 50;
  if (numOpponents < 1) return 100;

  const NUM_SIMULATIONS = 500;
  let wins = 0;
  let ties = 0;

  // Build set of known cards
  const knownSet = new Set<string>();
  for (const c of holeCards) knownSet.add(cardKey(c));
  for (const c of communityCards) knownSet.add(cardKey(c));

  // Build remaining deck
  const fullDeck = buildFullDeck();
  const remainingDeck = fullDeck.filter((c) => !knownSet.has(cardKey(c)));

  const communityNeeded = 5 - communityCards.length;
  const cardsNeeded = communityNeeded + numOpponents * 2;

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    // Shuffle remaining deck for this simulation
    shuffleArray(remainingDeck);

    if (remainingDeck.length < cardsNeeded) break;

    let idx = 0;

    // Deal remaining community cards
    const simCommunity = [...communityCards];
    for (let i = 0; i < communityNeeded; i++) {
      simCommunity.push(remainingDeck[idx++]);
    }

    // Evaluate player's hand
    const playerCards = [...holeCards, ...simCommunity];
    const playerResult = evaluateHand(playerCards);

    // Deal and evaluate opponent hands
    let playerWins = true;
    let isTie = false;

    for (let opp = 0; opp < numOpponents; opp++) {
      const oppHole = [remainingDeck[idx++], remainingDeck[idx++]];
      const oppCards = [...oppHole, ...simCommunity];
      const oppResult = evaluateHand(oppCards);

      const cmp = compareTo(playerResult, oppResult);
      if (cmp < 0) {
        playerWins = false;
        isTie = false;
        break;
      } else if (cmp === 0) {
        isTie = true;
      }
    }

    if (playerWins && !isTie) {
      wins++;
    } else if (playerWins && isTie) {
      ties++;
    }
  }

  // Win percentage: wins + ties/2
  const equity = ((wins + ties / 2) / NUM_SIMULATIONS) * 100;
  return Math.round(equity * 10) / 10;
}

/**
 * Calculate pot odds as a percentage.
 */
export function calculatePotOdds(callAmount: number, potSize: number): number {
  if (callAmount <= 0) return 0;
  const odds = (callAmount / (potSize + callAmount)) * 100;
  return Math.round(odds * 10) / 10;
}

/**
 * Count the number of outs that improve the hand.
 * Returns { outs, drawType } information.
 */
export function countOuts(
  holeCards: Card[],
  communityCards: Card[]
): { outs: number; drawType: string } {
  if (communityCards.length === 0 || communityCards.length >= 5) {
    return { outs: 0, drawType: 'none' };
  }

  const allCards = [...holeCards, ...communityCards];
  let totalOuts = 0;
  const drawTypes: string[] = [];

  // Check for flush draw
  const suitCounts = new Map<Suit, number>();
  for (const c of allCards) {
    suitCounts.set(c.suit, (suitCounts.get(c.suit) || 0) + 1);
  }

  for (const [suit, count] of suitCounts) {
    if (count === 4) {
      // Flush draw: 13 cards of the suit minus 4 we have = 9 outs
      // But subtract any community cards of the same suit that we've already counted
      totalOuts += 9;
      drawTypes.push('flush draw');
      break;
    }
  }

  // Check for straight draws
  const ranks = new Set<number>();
  for (const c of allCards) {
    ranks.add(c.rank);
    // Ace can also count as 1 for low straights
    if (c.rank === Rank.Ace) ranks.add(1);
  }

  const sortedRanks = [...ranks].sort((a, b) => a - b);

  // Check for open-ended straight draw (4 consecutive cards with room on both ends)
  let openEnded = false;
  let gutshot = false;

  for (let start = 1; start <= 10; start++) {
    const needed = [start, start + 1, start + 2, start + 3, start + 4];
    let have = 0;
    let missing: number[] = [];

    for (const r of needed) {
      if (ranks.has(r)) {
        have++;
      } else {
        missing.push(r);
      }
    }

    if (have === 4 && missing.length === 1) {
      // Check if it's open-ended or gutshot
      const missingRank = missing[0];
      if (missingRank === needed[0] || missingRank === needed[4]) {
        // Could be open-ended if we have the middle 4
        // Actually need to check: do we have 4 consecutive?
        // Open-ended: missing card is at the end of a 4-card run
        if (!openEnded) {
          // Check if the other end is also open (not blocked by Ace-high or low)
          if (missingRank > 1 && missingRank < Rank.Ace) {
            openEnded = true;
          } else {
            gutshot = true;
          }
        }
      } else {
        // Gutshot: missing card is in the middle
        if (!openEnded) {
          gutshot = true;
        }
      }
    }
  }

  if (openEnded && !drawTypes.includes('flush draw')) {
    totalOuts += 8;
    drawTypes.push('open-ended straight draw');
  } else if (openEnded && drawTypes.includes('flush draw')) {
    // Some outs may overlap; approximate by adding 6 (8 minus ~2 overlap)
    totalOuts += 6;
    drawTypes.push('open-ended straight draw');
  } else if (gutshot && !drawTypes.includes('flush draw')) {
    totalOuts += 4;
    drawTypes.push('gutshot straight draw');
  } else if (gutshot && drawTypes.includes('flush draw')) {
    // Subtract ~1 for overlap
    totalOuts += 3;
    drawTypes.push('gutshot straight draw');
  }

  // Check for overcards (cards in hand higher than any community card)
  if (communityCards.length >= 3) {
    const maxCommunityRank = Math.max(...communityCards.map((c) => c.rank));
    const currentHandResult = evaluateHand(allCards);

    // Only count overcards if we have a weak hand (high card or no pair)
    if (currentHandResult.handRank <= HandRank.HighCard) {
      let overcardOuts = 0;
      for (const hc of holeCards) {
        if (hc.rank > maxCommunityRank) {
          overcardOuts += 3; // 3 remaining cards of that rank
        }
      }
      if (overcardOuts > 0) {
        totalOuts += overcardOuts;
        drawTypes.push('overcards');
      }
    }
  }

  const drawType =
    drawTypes.length > 0 ? drawTypes.join(' + ') : 'none';

  return { outs: totalOuts, drawType };
}

/**
 * Create a human-readable description of current hand strength.
 */
export function describeHandStrength(
  holeCards: Card[],
  communityCards: Card[]
): string {
  if (holeCards.length < 2) return 'No cards';

  // Pre-flop: describe hole cards
  if (communityCards.length === 0) {
    const r1 = holeCards[0].rank;
    const r2 = holeCards[1].rank;
    const suited = holeCards[0].suit === holeCards[1].suit;

    if (r1 === r2) {
      return `Pocket ${RANK_NAMES[r1]}`;
    }

    const highRank = Math.max(r1, r2);
    const lowRank = Math.min(r1, r2);
    const suitedStr = suited ? ' suited' : '';

    if (highRank === Rank.Ace && lowRank === Rank.King) {
      return `Big Slick (AK)${suitedStr}`;
    }
    if (highRank === Rank.Ace) {
      return `Ace-${RANK_SINGULAR[lowRank]}${suitedStr}`;
    }
    if (highRank >= Rank.Jack && lowRank >= Rank.Jack) {
      return `${RANK_SINGULAR[highRank]}-${RANK_SINGULAR[lowRank]}${suitedStr}`;
    }

    return `${RANK_SINGULAR[highRank]}-${RANK_SINGULAR[lowRank]}${suitedStr}`;
  }

  // Post-flop: evaluate the hand
  const allCards = [...holeCards, ...communityCards];
  const result = evaluateHand(allCards);

  // Build the base description
  let description = '';

  switch (result.handRank) {
    case HandRank.RoyalFlush:
      description = 'Royal Flush';
      break;
    case HandRank.StraightFlush:
      description = `Straight Flush, ${RANK_SINGULAR[result.primaryValue]} high`;
      break;
    case HandRank.FourOfAKind:
      description = `Four of a Kind, ${RANK_NAMES[result.primaryValue]}`;
      break;
    case HandRank.FullHouse:
      description = `Full House, ${RANK_NAMES[result.primaryValue]} full of ${RANK_NAMES[result.kickers[0]]}`;
      break;
    case HandRank.Flush:
      description = `Flush, ${RANK_SINGULAR[result.primaryValue]} high`;
      break;
    case HandRank.Straight:
      description = `Straight, ${RANK_SINGULAR[result.primaryValue]} high`;
      break;
    case HandRank.ThreeOfAKind:
      description = `Three of a Kind, ${RANK_NAMES[result.primaryValue]}`;
      break;
    case HandRank.TwoPair: {
      description = `Two Pair, ${RANK_NAMES[result.primaryValue]} and ${RANK_NAMES[result.kickers[0]]}`;
      break;
    }
    case HandRank.OnePair: {
      // Determine kicker info
      const pairRank = result.primaryValue;
      const maxCommunityRank = Math.max(...communityCards.map((c) => c.rank));

      if (pairRank > maxCommunityRank) {
        description = `Overpair, ${RANK_NAMES[pairRank]}`;
      } else if (pairRank === maxCommunityRank) {
        // Top pair - find kicker from hole cards
        const kicker = holeCards
          .filter((c) => c.rank !== pairRank)
          .map((c) => c.rank)
          .sort((a, b) => b - a)[0];
        if (kicker) {
          description = `Top Pair, ${RANK_SINGULAR[kicker]} kicker`;
        } else {
          description = `Pair of ${RANK_NAMES[pairRank]}`;
        }
      } else {
        description = `Pair of ${RANK_NAMES[pairRank]}`;
      }
      break;
    }
    case HandRank.HighCard: {
      description = `High Card, ${RANK_SINGULAR[result.primaryValue]} high`;
      break;
    }
  }

  // Append draw info
  const { outs, drawType } = countOuts(holeCards, communityCards);
  if (drawType !== 'none' && outs > 0) {
    description += ` with ${drawType} (${outs} outs)`;
  }

  return description;
}

/**
 * Suggest an action based on equity, pot odds, and game context.
 */
export function getSuggestedAction(
  equity: number,
  potOdds: number,
  phase: string,
  callAmount: number,
  potSize: number,
  chipStack: number
): {
  action: string;
  raiseAmount?: number;
  reasoning: string;
} {
  // If no bet to call, check or raise
  if (callAmount === 0) {
    if (equity > 65) {
      // Strong hand, bet for value
      const raiseAmount = Math.round(potSize * 0.6);
      const clampedRaise = Math.min(raiseAmount, chipStack);
      return {
        action: 'raise',
        raiseAmount: clampedRaise,
        reasoning: `Strong hand (${equity}% equity). Bet for value.`,
      };
    }
    if (equity > 40) {
      return {
        action: 'check',
        reasoning: `Decent hand (${equity}% equity) but not strong enough to bet. Check and see.`,
      };
    }
    return {
      action: 'check',
      reasoning: `Weak hand (${equity}% equity). Check to see free cards.`,
    };
  }

  // Facing a bet
  if (equity > potOdds + 10) {
    // Good spot to raise
    const raiseAmount = Math.round(potSize * 0.75);
    const clampedRaise = Math.min(raiseAmount, chipStack);
    return {
      action: 'raise',
      raiseAmount: clampedRaise,
      reasoning: `Equity (${equity}%) well above pot odds (${potOdds}%). Raise to build the pot.`,
    };
  }

  if (equity > potOdds) {
    return {
      action: 'call',
      reasoning: `Equity (${equity}%) exceeds pot odds (${potOdds}%). Profitable call.`,
    };
  }

  // Equity below pot odds
  return {
    action: 'fold',
    reasoning: `Equity (${equity}%) below pot odds (${potOdds}%). Fold to save chips.`,
  };
}

/**
 * Get complete training data for the current situation.
 */
export function getFullTrainingData(
  holeCards: Card[],
  communityCards: Card[],
  numOpponents: number,
  callAmount: number,
  potSize: number,
  chipStack: number,
  phase: string
): TrainingData {
  const equity = calculateEquity(holeCards, communityCards, numOpponents);
  const potOdds = calculatePotOdds(callAmount, potSize);
  const { outs, drawType } = countOuts(holeCards, communityCards);
  const handStrength = describeHandStrength(holeCards, communityCards);
  const { action, raiseAmount, reasoning } = getSuggestedAction(
    equity,
    potOdds,
    phase,
    callAmount,
    potSize,
    chipStack
  );

  return {
    equity,
    potOdds,
    suggestedAction: action,
    suggestedRaiseAmount: raiseAmount,
    reasoning,
    handStrength,
    outs,
    drawType: drawType === 'none' ? undefined : drawType,
  };
}

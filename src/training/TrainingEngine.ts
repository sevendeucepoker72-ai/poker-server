import { Card, Rank, Suit } from '../game/Card';
import { CardDeck } from '../game/CardDeck';
import { evaluateHand, compareTo, HandRank, HandResult } from '../game/HandEvaluator';
import { evaluateOmahaHand } from '../game/HandEvaluatorExtensions';
import { percentileByRanks } from '../ai/preflopRanges';

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

/** Evaluate a hand, upgrading the SHORT-DECK ace-low wheel A-6-7-8-9 to a
 * 9-high straight (the standard evaluator only wheels A-2-3-4-5, which don't
 * exist in short-deck). Only fires when the normal result is below a straight. */
function evaluateMaybeShortDeck(cards: Card[], shortDeck: boolean): HandResult {
  const r = evaluateHand(cards);
  if (!shortDeck || r.handRank >= HandRank.Straight) return r;
  const ranks = new Set(cards.map((c) => c.rank));
  const hasWheel = ranks.has(Rank.Ace) && ranks.has(Rank.Six) && ranks.has(Rank.Seven) && ranks.has(Rank.Eight) && ranks.has(Rank.Nine);
  if (!hasWheel) return r;
  // Straight flush if the five wheel ranks share one suit.
  const bySuit = new Map<number, Set<number>>();
  for (const c of cards) { let s = bySuit.get(c.suit); if (!s) { s = new Set(); bySuit.set(c.suit, s); } s.add(c.rank); }
  for (const [, rs] of bySuit) {
    if (rs.has(Rank.Ace) && rs.has(Rank.Six) && rs.has(Rank.Seven) && rs.has(Rank.Eight) && rs.has(Rank.Nine)) {
      return { handRank: HandRank.StraightFlush, primaryValue: Rank.Nine, kickers: [], bestFiveCards: [], handName: '9-high Straight Flush' };
    }
  }
  return { handRank: HandRank.Straight, primaryValue: Rank.Nine, kickers: [], bestFiveCards: [], handName: '9-high Straight' };
}

/** Compare two hands, applying the short-deck rule that a FLUSH beats a FULL
 * HOUSE (the only ranking swap vs standard Hold'em). */
function compareShortDeck(a: HandResult, b: HandResult, shortDeck: boolean): number {
  if (shortDeck) {
    const aF = a.handRank === HandRank.Flush, aFH = a.handRank === HandRank.FullHouse;
    const bF = b.handRank === HandRank.Flush, bFH = b.handRank === HandRank.FullHouse;
    if (aF && bFH) return 1;
    if (aFH && bF) return -1;
  }
  return compareTo(a, b);
}

/**
 * 2026-10-11 (.online R2, GAME-8) — the two hole cards a HOLD'EM-style hand
 * plays when it holds more: a (Crazy) Pineapple seat keeps all but its weakest
 * card (PineappleTable.autoDiscardOne drops the lowest rank, ties to the lowest
 * suit). calculateEquity's Hold'em model is only ever run on these two.
 */
export function keptHoldemHoleCards(hole: Card[]): Card[] {
  if (!hole || hole.length <= 2) return hole;
  const cards = hole.slice();
  while (cards.length > 2) {
    let worst = 0;
    for (let i = 1; i < cards.length; i++) {
      const c = cards[i];
      const w = cards[worst];
      if (c.rank < w.rank || (c.rank === w.rank && c.suit < w.suit)) worst = i;
    }
    cards.splice(worst, 1);
  }
  return cards;
}

/** GAME-8 — simulations a time-budgeted equity always completes before it may stop early. */
const MIN_BUDGETED_SIMULATIONS = 64;

/**
 * Monte Carlo equity calculation.
 * Runs 500 simulations to estimate win probability.
 * 2026-10-11 (.online R2, GAME-8): a Hold'em (non-Omaha) equity is computed for
 * at most TWO hole cards — a Stud bot's 7 cards made every simulation evaluate
 * 12-card hands (~1s of blocking CPU per decision, a fake 80-96% equity) — and
 * `maxMs` (> 0) bounds the wall-clock time: the loop stops after at least
 * MIN_BUDGETED_SIMULATIONS once the budget is spent (the bots pass one). The
 * result is over the simulations actually run.
 */
export function calculateEquity(
  holeCards: Card[],
  communityCards: Card[],
  numOpponents: number,
  // 2026-06-19: Omaha awareness (default false → unchanged Hold'em path). Omaha
  // uses exactly-2-hole + 3-board and 4-card opponents; the old any-5/2-card
  // model made Omaha equity meaningless.
  omaha: boolean = false,
  // 2026-07-07 AI overhaul: RANGE-AWARE equity. When > 0, each opponent's hole
  // cards are reject-sampled to a hand with preflop percentile >= oppMinPctile,
  // instead of a uniformly-random hand. This models the fact that an opponent
  // who has bet/raised has a STRONGER-than-random range, so the bot no longer
  // systematically over-estimates its equity against aggression. Hold'em only
  // (Omaha keeps the 4-random-card model). Default 0 = unchanged random-range.
  oppMinPctile: number = 0,
  // 2026-07-07 AI overhaul: SHORT-DECK (6+ Hold'em). Removes 2-5 (36-card deck)
  // so straight/flush frequencies are realistic, and applies the short-deck rule
  // that a FLUSH beats a FULL HOUSE. Was previously mis-modeled on a full 52-card
  // deck with standard rankings, making short-deck equity simply wrong.
  shortDeck: boolean = false,
  maxMs: number = 0
): number {
  if (holeCards.length < 2) return 50;
  if (numOpponents < 1) return 100;
  if (!omaha && holeCards.length > 2) holeCards = keptHoldemHoleCards(holeCards);

  const NUM_SIMULATIONS = 500;
  const deadline = maxMs > 0 ? Date.now() + maxMs : 0;
  let simsRun = 0;
  const narrow = oppMinPctile > 0 && !omaha;
  let wins = 0;
  let ties = 0;

  // Build set of known cards
  const knownSet = new Set<string>();
  for (const c of holeCards) knownSet.add(cardKey(c));
  for (const c of communityCards) knownSet.add(cardKey(c));

  // Build remaining deck (short-deck excludes ranks below Six).
  const fullDeck = buildFullDeck();
  const remainingDeck = fullDeck.filter((c) => !knownSet.has(cardKey(c)) && (!shortDeck || c.rank >= Rank.Six));

  const communityNeeded = 5 - communityCards.length;
  const holePerOpp = omaha ? 4 : 2;
  const cardsNeeded = communityNeeded + numOpponents * holePerOpp;

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    // GAME-8 — the time budget (checked every 16 simulations past the minimum).
    if (deadline && sim >= MIN_BUDGETED_SIMULATIONS && (sim & 15) === 0 && Date.now() > deadline) break;
    // Shuffle remaining deck for this simulation
    shuffleArray(remainingDeck);

    if (remainingDeck.length < cardsNeeded) break;
    simsRun++;

    let idx = 0;

    // Deal remaining community cards
    const simCommunity = [...communityCards];
    for (let i = 0; i < communityNeeded; i++) {
      simCommunity.push(remainingDeck[idx++]);
    }

    // Evaluate player's hand (Omaha uses the 2-of-hole + 3-of-board evaluator;
    // short-deck upgrades the A-6-7-8-9 wheel to a straight).
    const playerResult = omaha
      ? evaluateOmahaHand(holeCards, simCommunity)
      : evaluateMaybeShortDeck([...holeCards, ...simCommunity], shortDeck);

    // Deal and evaluate opponent hands
    let playerWins = true;
    let isTie = false;

    for (let opp = 0; opp < numOpponents; opp++) {
      if (narrow) {
        // Reject-sample a 2-card combo from the undealt tail whose preflop
        // percentile meets the opponent's assumed range floor. Two-swap
        // select-to-front keeps the deck a valid permutation; bounded attempts
        // avoid a pathological loop when the range is very tight.
        const len = remainingDeck.length;
        let qualified = false;
        for (let t = 0; t < 32; t++) {
          const i = idx + Math.floor(Math.random() * (len - idx));
          const tmp1 = remainingDeck[idx]; remainingDeck[idx] = remainingDeck[i]; remainingDeck[i] = tmp1;
          const j = (idx + 1) + Math.floor(Math.random() * (len - idx - 1));
          const tmp2 = remainingDeck[idx + 1]; remainingDeck[idx + 1] = remainingDeck[j]; remainingDeck[j] = tmp2;
          const c1 = remainingDeck[idx], c2 = remainingDeck[idx + 1];
          if (percentileByRanks(c1.rank, c2.rank, c1.suit === c2.suit) >= oppMinPctile) { qualified = true; break; }
        }
        // 2026-07-07 review fix: if 32 tries never met a very tight range floor,
        // do NOT leave the last RANDOM pair (that biases our equity UPWARD, since
        // a random hand is weaker than the tight range we're supposed to face).
        // Instead approximate the tight range with the two HIGHEST cards in the
        // tail — a strong high-card hand — which is directionally correct.
        if (!qualified) {
          let hi1 = idx, hi2 = idx + 1;
          if (remainingDeck[hi2].rank > remainingDeck[hi1].rank) { const s = hi1; hi1 = hi2; hi2 = s; }
          for (let k = idx + 2; k < len; k++) {
            if (remainingDeck[k].rank > remainingDeck[hi1].rank) { hi2 = hi1; hi1 = k; }
            else if (remainingDeck[k].rank > remainingDeck[hi2].rank) { hi2 = k; }
          }
          // Place the two highest at idx, idx+1 (two-step swap; keep hi2 valid).
          const a = remainingDeck[idx]; remainingDeck[idx] = remainingDeck[hi1]; remainingDeck[hi1] = a;
          if (hi2 === idx) hi2 = hi1;
          const b = remainingDeck[idx + 1]; remainingDeck[idx + 1] = remainingDeck[hi2]; remainingDeck[hi2] = b;
        }
      }
      const oppHole: Card[] = [];
      for (let h = 0; h < holePerOpp; h++) oppHole.push(remainingDeck[idx++]);
      const oppResult = omaha
        ? evaluateOmahaHand(oppHole, simCommunity)
        : evaluateMaybeShortDeck([...oppHole, ...simCommunity], shortDeck);

      const cmp = compareShortDeck(playerResult, oppResult, shortDeck);
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

  // Win percentage: wins + ties/2, over the simulations actually run (a
  // budgeted run may stop early; a deck too small for the field runs none).
  if (simsRun === 0) return 50;
  const equity = ((wins + ties / 2) / simsRun) * 100;
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
  communityCards: Card[],
  omaha: boolean = false
): { outs: number; drawType: string } {
  if (communityCards.length === 0 || communityCards.length >= 5) {
    return { outs: 0, drawType: 'none' };
  }

  // Omaha family: a made hand must use EXACTLY 2 hole cards, so counting draws
  // off all 4+ hole cards together over-counts flushes/straights (e.g. three
  // suited hole cards is NOT a flush draw). Evaluate every 2-card hole combo
  // with the Hold'em logic and keep the best. 6 combos for 4-card Omaha.
  if (omaha && holeCards.length > 2) {
    let best = { outs: 0, drawType: 'none' };
    for (let i = 0; i < holeCards.length; i++) {
      for (let j = i + 1; j < holeCards.length; j++) {
        const r = countOuts([holeCards[i], holeCards[j]], communityCards, false);
        if (r.outs > best.outs) best = r;
      }
    }
    return best;
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
  phase: string,
  isOmaha: boolean = false
): TrainingData {
  // Omaha changes both equity (must use exactly 2 of 4 hole cards) and out
  // counting — without the flag the coach graded Omaha hands as Hold'em.
  const equity = calculateEquity(holeCards, communityCards, numOpponents, isOmaha);
  const potOdds = calculatePotOdds(callAmount, potSize);
  const { outs, drawType } = countOuts(holeCards, communityCards, isOmaha);
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

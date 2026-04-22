import { Card, Rank, Suit } from '../game/Card';
import { evaluateHand, compareTo, HandRank, HandResult } from '../game/HandEvaluator';
import { PokerTable, Seat, PlayerAction, GamePhase } from '../game/PokerTable';
import { calculateEquity } from '../training/TrainingEngine';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
export type Personality =
  | 'tight'
  | 'loose'
  | 'aggressive'
  | 'passive'
  | 'maniac'
  | 'rock';

/**
 * Archetype = a complete poker strategy profile, not just numeric tweaks.
 * Each archetype has its own decision branch in `decideAction` so different
 * AIs actually play differently — not just slightly different numbers in the
 * same decision tree.
 *
 * - NIT:             Ultra-tight, premium hands only, no bluffs, pot-control on flops
 * - ROCK:            Tight-passive, calls down with marginals, never raises
 * - TAG:             Tight-aggressive, balanced GTO-leaning play
 * - LAG:             Loose-aggressive, lots of 3-bets, frequent c-bets, balanced bluffs
 * - MANIAC:          Hyper-aggressive, raises constantly, overbets, big bluffs
 * - CALLING_STATION: Calls everything, never folds top pair, rarely raises
 * - FISH:            Loose-passive, plays too many hands, calls too much, rare raises
 */
export type Archetype =
  | 'NIT'
  | 'ROCK'
  | 'TAG'
  | 'LAG'
  | 'MANIAC'
  | 'CALLING_STATION'
  | 'FISH';

export interface AIPlayerProfile {
  botName: string;
  difficulty: Difficulty;
  personality: Personality;
  archetype: Archetype;
  vpip: number;
  pfr: number;
  aggressionFactor: number;
  bluffFrequency: number;
}

/** Tunable per-archetype parameters */
interface ArchetypeParams {
  vpipBase: number;       // % hands played
  pfrBase: number;        // % hands raised preflop
  aggression: number;     // 0=passive, 5=maniac
  bluffFreq: number;      // 0..0.5
  cbetFreq: number;       // 0..1 — how often to c-bet flop after preflop raise
  callDownTendency: number; // 0..1 — how willing to call river bets
  betSizingMultiplier: number; // 0.5..1.8 — overall bet size multiplier
  openLimpFreq: number;   // 0..1 — fish/calling stations limp instead of raising
}

const ARCHETYPE_PARAMS: Record<Archetype, ArchetypeParams> = {
  NIT:             { vpipBase: 0.10, pfrBase: 0.08, aggression: 1.5, bluffFreq: 0.02, cbetFreq: 0.50, callDownTendency: 0.20, betSizingMultiplier: 0.85, openLimpFreq: 0.0 },
  ROCK:            { vpipBase: 0.14, pfrBase: 0.06, aggression: 0.8, bluffFreq: 0.03, cbetFreq: 0.40, callDownTendency: 0.55, betSizingMultiplier: 0.75, openLimpFreq: 0.3 },
  TAG:             { vpipBase: 0.22, pfrBase: 0.18, aggression: 2.5, bluffFreq: 0.15, cbetFreq: 0.65, callDownTendency: 0.45, betSizingMultiplier: 1.00, openLimpFreq: 0.0 },
  LAG:             { vpipBase: 0.32, pfrBase: 0.26, aggression: 3.5, bluffFreq: 0.25, cbetFreq: 0.78, callDownTendency: 0.55, betSizingMultiplier: 1.15, openLimpFreq: 0.0 },
  MANIAC:          { vpipBase: 0.55, pfrBase: 0.45, aggression: 5.0, bluffFreq: 0.40, cbetFreq: 0.92, callDownTendency: 0.65, betSizingMultiplier: 1.45, openLimpFreq: 0.0 },
  CALLING_STATION: { vpipBase: 0.55, pfrBase: 0.05, aggression: 0.4, bluffFreq: 0.02, cbetFreq: 0.10, callDownTendency: 0.95, betSizingMultiplier: 0.65, openLimpFreq: 0.7 },
  FISH:            { vpipBase: 0.42, pfrBase: 0.10, aggression: 1.0, bluffFreq: 0.08, cbetFreq: 0.30, callDownTendency: 0.75, betSizingMultiplier: 0.80, openLimpFreq: 0.55 },
};

export interface AIDecision {
  action: PlayerAction;
  raiseAmount: number;
}

// ============================================================
// Opponent modeling: track what opponents have done this hand
// ============================================================
interface OpponentModel {
  raiseCount: number;
  callCount: number;
  checkCount: number;
  totalBet: number;
  isAggressive: boolean;
}

function modelOpponents(table: PokerTable, mySeat: number): OpponentModel {
  let raiseCount = 0;
  let callCount = 0;
  let checkCount = 0;
  let totalBet = 0;

  for (const seat of table.seats) {
    if (seat.seatIndex === mySeat) continue;
    if (seat.state !== 'occupied' || seat.folded || seat.eliminated) continue;

    totalBet += seat.totalInvestedThisHand; // already includes current round bets
    switch (seat.lastAction) {
      case PlayerAction.Raise: raiseCount++; break;
      case PlayerAction.Call: callCount++; break;
      case PlayerAction.Check: checkCount++; break;
      case PlayerAction.AllIn: raiseCount += 2; break;
    }
  }

  return {
    raiseCount,
    callCount,
    checkCount,
    totalBet,
    isAggressive: raiseCount >= 2,
  };
}

// ============================================================
// Board texture analysis
// ============================================================
interface BoardTexture {
  isPaired: boolean;
  isMonotone: boolean;   // 3+ same suit
  isTwoTone: boolean;    // 2 of same suit
  isConnected: boolean;  // 3+ consecutive
  hasHighCards: boolean;  // A or K on board
  isWet: boolean;        // many draws possible
  isDry: boolean;        // few draws possible
  straightPossible: boolean;
  flushPossible: boolean;
}

function analyzeBoardTexture(community: Card[]): BoardTexture {
  if (community.length < 3) {
    return {
      isPaired: false, isMonotone: false, isTwoTone: false,
      isConnected: false, hasHighCards: false, isWet: false,
      isDry: true, straightPossible: false, flushPossible: false,
    };
  }

  const ranks = community.map(c => c.rank).sort((a, b) => a - b);
  const suits = community.map(c => c.suit);

  // Pair check
  const rankCounts = new Map<number, number>();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  const isPaired = [...rankCounts.values()].some(v => v >= 2);

  // Suit analysis
  const suitCounts = new Map<number, number>();
  for (const s of suits) suitCounts.set(s, (suitCounts.get(s) || 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const isMonotone = maxSuit >= 3;
  const isTwoTone = maxSuit === 2;
  const flushPossible = maxSuit >= 3;

  // Connectivity
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => a - b);
  let maxConsecutive = 1;
  let current = 1;
  for (let i = 1; i < uniqueRanks.length; i++) {
    if (uniqueRanks[i] - uniqueRanks[i - 1] <= 2) {
      current++;
      maxConsecutive = Math.max(maxConsecutive, current);
    } else {
      current = 1;
    }
  }
  const isConnected = maxConsecutive >= 3;
  const straightPossible = maxConsecutive >= 3 || (uniqueRanks.includes(Rank.Ace) && uniqueRanks.some(r => r <= 5));

  const hasHighCards = ranks.some(r => r >= Rank.King);
  const isWet = (isConnected || isTwoTone || isMonotone) && !isPaired;
  const isDry = !isWet && isPaired;

  return {
    isPaired, isMonotone, isTwoTone, isConnected,
    hasHighCards, isWet, isDry, straightPossible, flushPossible,
  };
}

// ============================================================
// Preflop hand rankings - 169 hand matrix
// ============================================================

// Chen formula for preflop hand strength (modified)
function chenFormulaScore(holeCards: Card[]): number {
  if (holeCards.length < 2) return 0;

  const r1 = holeCards[0].rank;
  const r2 = holeCards[1].rank;
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const suited = holeCards[0].suit === holeCards[1].suit;
  const gap = high - low;
  const isPair = r1 === r2;

  // Base score from high card
  let score = 0;
  if (high === Rank.Ace) score = 10;
  else if (high === Rank.King) score = 8;
  else if (high === Rank.Queen) score = 7;
  else if (high === Rank.Jack) score = 6;
  else score = high / 2;

  // Pairs double the score
  if (isPair) {
    score *= 2;
    if (score < 5) score = 5; // minimum 5 for pairs
  }

  // Suited bonus
  if (suited) score += 2;

  // Gap penalty
  if (!isPair) {
    if (gap === 1) score += 1; // connected
    else if (gap === 2) score -= 1;
    else if (gap === 3) score -= 2;
    else if (gap === 4) score -= 4;
    else score -= 5;
  }

  // Bonus for both cards > 10
  if (low >= Rank.Ten && !isPair) score += 1;

  return Math.max(0, score);
}

// Normalize chen score to 0-1 range (max chen ≈ 20 for AA)
function getPreFlopHandRank(holeCards: Card[]): number {
  const chen = chenFormulaScore(holeCards);
  return Math.min(1.0, chen / 20);
}

/**
 * Generic hand-strength estimator for non-community-card variants.
 * Used for stud (3rd-7th street), razz, draw games, and badugi — where the
 * Hold'em-centric chen formula and Monte Carlo flop equity don't apply.
 *
 * Returns 0 (weak) to 1 (strong) regardless of variant. Lowball variants
 * invert the scale so the AI treats a low hand as "strong".
 */
function getVariantHandStrength(holeCards: Card[], variantId: string, isLowball: boolean): number {
  if (!holeCards || holeCards.length === 0) return 0;

  // Lowball variants: count cards ≤ 8 and penalize pairs (badugi: penalize
  // duplicate suits). Higher low-card count = better expected low hand.
  if (isLowball) {
    const ranks = holeCards.map((c) => c.rank);
    const suits = holeCards.map((c) => c.suit);
    const uniqueLowRanks = new Set(ranks.filter((r) => r <= 8 || r === 14)).size; // Rank.Ace === 14
    const pairs = ranks.length - new Set(ranks).size;
    const dupSuits = suits.length - new Set(suits).size;
    if (variantId === 'badugi') {
      // Best badugi = 4 unique suits + 4 unique low ranks
      const uniqueSuits = new Set(suits).size;
      const score = (uniqueLowRanks * 0.12) + (uniqueSuits * 0.15) - (pairs * 0.05);
      return Math.max(0, Math.min(1, score));
    }
    if (variantId === 'triple-draw') {
      // 2-7 lowball: no aces (ace is HIGH), no straights/flushes, no pairs
      const lowNoAce = ranks.filter((r) => r >= 2 && r <= 7).length;
      const score = (lowNoAce * 0.13) - (pairs * 0.12) - (dupSuits >= 4 ? 0.15 : 0);
      return Math.max(0, Math.min(1, score + 0.2));
    }
    // razz: best 5 of 7 low, A-2-3-4-5 is nuts
    const score = (uniqueLowRanks * 0.12) - (pairs * 0.08);
    return Math.max(0, Math.min(1, score + 0.1));
  }

  // High-card variants (seven-card-stud, seven-card-stud-hi-lo, five-card-draw).
  // Use pair structure + high cards as a rough strength signal.
  const ranks = holeCards.map((c) => c.rank);
  const uniqueRanks = new Set(ranks).size;
  const pairs = ranks.length - uniqueRanks;
  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length; // Rank.Ace=14, Two=2
  // Flush / three-of-a-kind bonus (crude)
  const suitCounts: Record<string, number> = {};
  for (const c of holeCards) suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCounts));
  const flushDraw = maxSuit >= 4 ? 0.15 : maxSuit >= 3 ? 0.08 : 0;

  const rankCounts: Record<number, number> = {};
  for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
  const maxSame = Math.max(...Object.values(rankCounts));
  let handBonus = 0;
  if (maxSame >= 4) handBonus = 0.85;          // quads
  else if (maxSame === 3 && pairs >= 1) handBonus = 0.75; // full house (if 7 cards + pair)
  else if (maxSame === 3) handBonus = 0.55;    // trips
  else if (pairs >= 2) handBonus = 0.40;       // two pair
  else if (pairs === 1) handBonus = 0.25;      // one pair

  const highCardBonus = (avgRank - 7) * 0.03;  // favors high average rank
  const score = handBonus + flushDraw + highCardBonus;
  return Math.max(0.05, Math.min(1, score));
}

// ============================================================
// Post-flop hand strength with Monte Carlo equity
// ============================================================

function getPostFlopStrength(
  holeCards: Card[],
  communityCards: Card[],
  numOpponents: number,
  difficulty: Difficulty
): number {
  // Expert and Hard AI use actual Monte Carlo equity (but fewer sims for speed)
  if (difficulty === 'expert' || difficulty === 'hard') {
    const equity = calculateEquity(
      holeCards,
      communityCards,
      numOpponents
    );
    return equity / 100; // normalize to 0-1
  }

  // Medium/Easy use simplified evaluation
  const allCards = [...holeCards, ...communityCards];
  const result = evaluateHand(allCards);

  let score: number;
  switch (result.handRank) {
    case HandRank.HighCard:      score = 0.08 + (result.primaryValue / Rank.Ace) * 0.08; break;
    case HandRank.OnePair:       score = 0.22 + (result.primaryValue / Rank.Ace) * 0.12; break;
    case HandRank.TwoPair:       score = 0.42 + (result.primaryValue / Rank.Ace) * 0.08; break;
    case HandRank.ThreeOfAKind:  score = 0.58 + (result.primaryValue / Rank.Ace) * 0.06; break;
    case HandRank.Straight:      score = 0.70 + (result.primaryValue / Rank.Ace) * 0.04; break;
    case HandRank.Flush:         score = 0.78 + (result.primaryValue / Rank.Ace) * 0.04; break;
    case HandRank.FullHouse:     score = 0.85 + (result.primaryValue / Rank.Ace) * 0.04; break;
    case HandRank.FourOfAKind:   score = 0.93; break;
    case HandRank.StraightFlush: score = 0.97; break;
    case HandRank.RoyalFlush:    score = 1.00; break;
    default: score = 0.05;
  }

  // Check if hole cards contribute
  if (communityCards.length >= 5) {
    const communityResult = evaluateHand(communityCards);
    if (result.handRank === communityResult.handRank &&
        result.primaryValue === communityResult.primaryValue) {
      score *= 0.4; // playing the board = very weak
    }
  }

  return Math.min(1.0, Math.max(0.0, score));
}

// ============================================================
// Implied odds & stack-to-pot ratio considerations
// ============================================================

function getImpliedOdds(
  handStrength: number,
  outs: number,
  potSize: number,
  effectiveStack: number,
  phase: GamePhase
): number {
  // More cards to come = more implied odds
  const cardsTocome = phase === GamePhase.Flop ? 2 : phase === GamePhase.Turn ? 1 : 0;
  if (cardsTocome === 0) return 0;

  // Stack-to-pot ratio: deep stacks = more implied odds
  const spr = effectiveStack / Math.max(potSize, 1);

  // Base implied odds from outs
  const drawEquity = (outs * cardsTocome * 2.2) / 100; // rough rule of 2/4

  // Adjust by SPR: deep stacks make draws more valuable
  const sprBonus = Math.min(0.15, spr * 0.01);

  return drawEquity + sprBonus;
}

// ============================================================
// Counting outs (from TrainingEngine, simplified inline)
// ============================================================

function countOuts(holeCards: Card[], communityCards: Card[]): number {
  if (communityCards.length === 0 || communityCards.length >= 5) return 0;

  const allCards = [...holeCards, ...communityCards];
  let outs = 0;

  // Flush draw check
  const suitCounts = new Map<number, number>();
  for (const c of allCards) suitCounts.set(c.suit, (suitCounts.get(c.suit) || 0) + 1);
  for (const count of suitCounts.values()) {
    if (count === 4) { outs += 9; break; }
  }

  // Straight draw check
  const ranks = new Set<number>(allCards.map(c => c.rank as number));
  if (allCards.some(c => c.rank === Rank.Ace)) ranks.add(1);

  for (let start = 1; start <= 10; start++) {
    let have = 0;
    for (let r = start; r < start + 5; r++) {
      if (ranks.has(r)) have++;
    }
    if (have === 4) {
      outs += outs >= 9 ? 6 : 8; // reduce if already have flush draw (overlap)
      break;
    }
  }

  // Overcard outs
  if (communityCards.length >= 3) {
    const maxBoard = Math.max(...communityCards.map(c => c.rank));
    const currentHand = evaluateHand(allCards);
    if (currentHand.handRank <= HandRank.HighCard) {
      for (const hc of holeCards) {
        if (hc.rank > maxBoard) outs += 3;
      }
    }
  }

  return outs;
}

// ============================================================
// Round a chip amount to the nearest big-blind multiple for clean bet sizing
function roundToBB(amount: number, bigBlind: number): number {
  if (bigBlind <= 0) return amount;
  return Math.round(amount / bigBlind) * bigBlind;
}

// GTO-influenced bet sizing
// ============================================================

function getGTOBetSize(
  handStrength: number,
  potSize: number,
  bigBlind: number,
  chipStack: number,
  board: BoardTexture,
  phase: GamePhase,
  profile: AIPlayerProfile
): number {
  const minBet = bigBlind * 2;

  // Polarized sizing: bet big with strong hands and bluffs, small with medium
  let potFraction: number;

  if (handStrength > 0.85) {
    // Very strong: overbet for value (sometimes)
    if (Math.random() < 0.25 && profile.aggressionFactor > 2) {
      potFraction = 1.25 + Math.random() * 0.5; // 125-175% pot overbet
    } else {
      potFraction = 0.66 + Math.random() * 0.34; // 66-100% pot
    }
  } else if (handStrength > 0.7) {
    // Strong: standard value bet
    potFraction = 0.55 + Math.random() * 0.2; // 55-75% pot
  } else if (handStrength > 0.5) {
    // Medium: smaller bet to control pot, or check sometimes
    potFraction = 0.33 + Math.random() * 0.17; // 33-50% pot
  } else {
    // Bluff/semi-bluff: use same sizing as value bets (balanced)
    potFraction = 0.55 + Math.random() * 0.2; // 55-75% pot (mirrors value range)
  }

  // Board texture adjustments
  if (board.isWet) {
    // Wet boards: bet bigger to deny equity
    potFraction *= 1.15;
  } else if (board.isDry) {
    // Dry boards: smaller bets work
    potFraction *= 0.85;
  }

  // Phase adjustments
  if (phase === GamePhase.River) {
    // River: polarize more (big or small, no medium)
    if (handStrength > 0.75) potFraction *= 1.2;
    else potFraction *= 0.8;
  }

  // Personality adjustment
  potFraction *= 0.7 + profile.aggressionFactor * 0.15;

  let betSize = Math.max(minBet, roundToBB(Math.round(potSize * potFraction), bigBlind));
  betSize = Math.min(betSize, chipStack);

  return betSize;
}

// ============================================================
// Preflop raising ranges (position-aware)
// ============================================================

function getOpenRaiseRange(position: number, totalActive: number): number {
  // Position: 0 = early, higher = later
  // Returns minimum hand strength to open-raise
  const relativePos = position / Math.max(totalActive - 1, 1);

  if (relativePos < 0.3) return 0.55; // early position: tight
  if (relativePos < 0.6) return 0.42; // middle position
  if (relativePos < 0.85) return 0.32; // late position: wide
  return 0.25; // button/cutoff: very wide
}

function get3BetRange(position: number): number {
  // 3-bet range threshold (tighter than opening)
  if (position < 3) return 0.7; // early: only premiums
  return 0.6; // late: wider 3-bet range
}

// ============================================================
// Main decision engine
// ============================================================

const BOT_NAMES = [
  // Realistic first names / nicknames
  'Mike', 'Danny', 'Steve', 'Tommy', 'Jake', 'Rico',
  'Vinny', 'Carlos', 'Big Al', 'Joey B', 'Lex', 'Nate',
  'Frankie', 'Dex', 'Sal', 'Manny', 'Ricky', 'Gus',
  'Phil', 'Hank', 'Eddie', 'Marco', 'Bobby', 'Trent',
  'Chase', 'Brody', 'Mick', 'Colt', 'Dean', 'Ray',
  'Zeke', 'Dallas', 'Rocco', 'Benny', 'Clyde', 'Wade',
  'Eli', 'Jax', 'Knox', 'Miles', 'Owen', 'Quinn',
  'Theo', 'Vince', 'Wes', 'Ty', 'Ash', 'Cruz',
  'Leo', 'Max', 'Nico', 'Reed', 'Shane', 'Troy',
  'Blake', 'Cole', 'Drew', 'Flynn', 'Grant', 'Hugo',
  'Ivan', 'Kurt', 'Liam', 'Nash', 'Pete', 'Russ',
  'Seth', 'Toby', 'Vaughn', 'Wyatt', 'Axel', 'Brock',
  'Cliff', 'Donnie', 'Earl', 'Fritz', 'Gil', 'Hector',
  'Ike', 'Jules', 'Kenny', 'Lou', 'Moe', 'Neil',
  'Oscar', 'Paulie', 'Ruben', 'Saul', 'Terry', 'Vic',
];

const PERSONALITIES: Personality[] = [
  'tight', 'loose', 'aggressive', 'passive', 'maniac', 'rock',
];

const ARCHETYPES: Archetype[] = [
  'NIT', 'ROCK', 'TAG', 'LAG', 'MANIAC', 'CALLING_STATION', 'FISH',
];

/**
 * Deterministic name → archetype mapping. Same bot name always gets the same
 * archetype across games, so players can learn which characters play which way.
 * Uses a simple FNV-1a-style hash so the mapping is stable across server restarts.
 */
function nameToArchetype(name: string): Archetype {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Convert to unsigned and modulo
  return ARCHETYPES[(h >>> 0) % ARCHETYPES.length];
}

function archetypeToPersonality(a: Archetype): Personality {
  switch (a) {
    case 'NIT':             return 'rock';
    case 'ROCK':            return 'tight';
    case 'TAG':             return 'tight';
    case 'LAG':             return 'aggressive';
    case 'MANIAC':          return 'maniac';
    case 'CALLING_STATION': return 'passive';
    case 'FISH':            return 'loose';
  }
}

export function generateRandomProfile(difficulty: Difficulty): AIPlayerProfile {
  const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  const archetype = nameToArchetype(botName);
  const personality = archetypeToPersonality(archetype);
  const params = ARCHETYPE_PARAMS[archetype];

  // Difficulty determines noise/skill, but archetype params dominate strategy.
  // Add a small per-bot jitter so two NITs aren't perfectly identical.
  const jitter = () => 0.85 + Math.random() * 0.30; // 0.85..1.15

  let vpip = params.vpipBase * jitter();
  let pfr = params.pfrBase * jitter();
  let aggressionFactor = params.aggression * jitter();
  let bluffFrequency = params.bluffFreq * jitter();

  // Difficulty influence: harder difficulties tighten up slightly (better hand selection)
  // and easier ones loosen up (more mistakes).
  switch (difficulty) {
    case 'easy':   vpip *= 1.20; pfr *= 0.85; bluffFrequency *= 0.7; break;
    case 'medium': /* no change */ break;
    case 'hard':   vpip *= 0.95; aggressionFactor *= 1.10; break;
    case 'expert': vpip *= 0.90; aggressionFactor *= 1.20; bluffFrequency *= 1.20; break;
  }

  vpip = Math.min(1.0, Math.max(0.05, vpip));
  pfr = Math.min(vpip, Math.max(0.02, pfr));
  aggressionFactor = Math.max(0.1, aggressionFactor);
  bluffFrequency = Math.min(0.5, Math.max(0.01, bluffFrequency));

  return { botName, difficulty, personality, archetype, vpip, pfr, aggressionFactor, bluffFrequency };
}

export function decideAction(
  table: PokerTable,
  seatIndex: number,
  profile: AIPlayerProfile
): AIDecision {
  const seat = table.seats[seatIndex];
  if (!seat || seat.state !== 'occupied' || seat.folded || seat.allIn) {
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // A "pre-action" phase is the first betting round of a hand — where we have
  // minimal info and lean on starting-hand strength heuristics. Covers Hold'em
  // PreFlop, stud ThirdStreet, and the first betting round of draw games (Bet1).
  const isPreFlop =
    table.currentPhase === GamePhase.PreFlop ||
    table.currentPhase === GamePhase.ThirdStreet ||
    table.currentPhase === GamePhase.Bet1;
  const isStudStreet =
    table.currentPhase === GamePhase.ThirdStreet ||
    table.currentPhase === GamePhase.FourthStreet ||
    table.currentPhase === GamePhase.FifthStreet ||
    table.currentPhase === GamePhase.SixthStreet ||
    table.currentPhase === GamePhase.SeventhStreet;
  const isDrawBet =
    table.currentPhase === GamePhase.Bet1 ||
    table.currentPhase === GamePhase.Bet2 ||
    table.currentPhase === GamePhase.Bet3 ||
    table.currentPhase === GamePhase.Bet4;
  const variantId: string = (table as any).variantId || 'texas-holdem';
  const isLowball = variantId === 'razz' || variantId === 'triple-draw' || variantId === 'badugi';
  const isStudFamily = variantId === 'seven-card-stud' || variantId === 'seven-card-stud-hi-lo' || variantId === 'razz';
  const callAmount = table.getCallAmount(seat);
  const totalPot = table.getTotalPot();
  const potOdds = totalPot > 0 ? callAmount / (totalPot + callAmount) : 0;
  const bigBlind = table.config.bigBlind;
  const board = analyzeBoardTexture(table.communityCards);
  const opponents = modelOpponents(table, seatIndex);

  // Count active non-folded opponents
  const numOpponents = table.seats.filter(
    s => s.state === 'occupied' && !s.folded && !s.eliminated && s.seatIndex !== seatIndex
  ).length;

  // Get position info
  const activeSeats = table.getActivePlayerSeats();
  const myPosition = activeSeats.indexOf(seatIndex);
  const totalActive = activeSeats.length;

  // ============================================================
  // Hand strength evaluation
  // ============================================================
  let handStrength: number;

  if (isStudFamily || isDrawBet) {
    // Non-community-card variants: use a generic hand-strength heuristic based
    // on the variant's own evaluator (or a lowball-aware one for razz/badugi/2-7).
    handStrength = getVariantHandStrength(seat.holeCards, variantId, isLowball);
  } else if (isPreFlop) {
    handStrength = getPreFlopHandRank(seat.holeCards);
  } else {
    handStrength = getPostFlopStrength(
      seat.holeCards, table.communityCards, numOpponents, profile.difficulty
    );
  }

  // Position multiplier (more refined than before)
  const relativePosition = totalActive > 1 ? myPosition / (totalActive - 1) : 0.5;
  const positionMult = 0.88 + relativePosition * 0.24; // 0.88 EP to 1.12 LP
  handStrength *= positionMult;

  // Difficulty-based noise (expert has almost none)
  const noiseMap: Record<Difficulty, number> = {
    easy: 0.25, medium: 0.12, hard: 0.05, expert: 0.02
  };
  const noise = (Math.random() - 0.5) * noiseMap[profile.difficulty];
  handStrength = Math.min(1.0, Math.max(0.0, handStrength + noise));

  // Outs and implied odds for draw decisions
  const outs = isPreFlop ? 0 : countOuts(seat.holeCards, table.communityCards);
  const impliedOdds = isPreFlop ? 0 : getImpliedOdds(
    handStrength, outs, totalPot, seat.chipCount, table.currentPhase
  );

  // Adjust hand strength with implied odds for drawing hands
  const effectiveStrength = handStrength + impliedOdds;

  // ============================================================
  // Expert-level adjustments
  // ============================================================
  if (profile.difficulty === 'expert' || profile.difficulty === 'hard') {
    // Adjust for opponent aggression — tighten up against aggressive opponents
    if (opponents.isAggressive && callAmount > bigBlind * 4) {
      // Opponent is very aggressive — need a stronger hand to continue
      const aggressionAdjust = profile.difficulty === 'expert' ? 0.08 : 0.05;
      // But don't over-fold: if we have a good hand, keep it
      if (handStrength < 0.65) {
        handStrength -= aggressionAdjust;
      }
    }

    // Multi-way pot adjustment: hands play worse multi-way
    if (numOpponents >= 3 && !isPreFlop) {
      handStrength *= 0.92; // drawing hands lose value in multi-way
    }

    // Board texture awareness
    if (!isPreFlop && board.isWet && handStrength < 0.5) {
      // Wet board + weak hand = dangerous
      handStrength *= 0.85;
    }
  }

  // ============================================================
  // PREFLOP STRATEGY
  // ============================================================
  if (isPreFlop) {
    return preFlopStrategy(
      handStrength, callAmount, totalPot, seat, table, profile,
      myPosition, totalActive, opponents, bigBlind
    );
  }

  // ============================================================
  // POST-FLOP STRATEGY
  // ============================================================
  return postFlopStrategy(
    effectiveStrength, handStrength, callAmount, totalPot, potOdds,
    seat, table, profile, board, opponents, outs, bigBlind, numOpponents
  );
}

// ============================================================
// Preflop decision logic
// ============================================================

function preFlopStrategy(
  handStrength: number,
  callAmount: number,
  totalPot: number,
  seat: Seat,
  table: PokerTable,
  profile: AIPlayerProfile,
  position: number,
  totalActive: number,
  opponents: OpponentModel,
  bigBlind: number
): AIDecision {
  const params = ARCHETYPE_PARAMS[profile.archetype];

  // ============================================================
  // ARCHETYPE-SPECIFIC PREFLOP BRANCHES
  // Each archetype gets a fundamentally different decision tree.
  // ============================================================

  // CALLING_STATION: never folds to a normal raise, calls everything but never raises
  if (profile.archetype === 'CALLING_STATION') {
    if (callAmount === 0) return { action: PlayerAction.Check, raiseAmount: 0 };
    // Only fold to massive bets (> 30% of stack) AND a weak hand
    if (callAmount > seat.chipCount * 0.30 && handStrength < 0.30) {
      return { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    if (callAmount >= seat.chipCount) return { action: PlayerAction.AllIn, raiseAmount: 0 };
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // MANIAC: raises with anything, almost never just calls preflop
  if (profile.archetype === 'MANIAC') {
    // Always raise/3-bet/4-bet unless hand is total trash (handStrength < 0.12)
    const wantToRaise = handStrength >= 0.12 || Math.random() < 0.6;
    if (wantToRaise) {
      const sizeMult = 2.5 + Math.random() * 2.5; // 2.5x..5x BB
      const target = callAmount === 0
        ? Math.round(bigBlind * sizeMult)
        : Math.round(callAmount * (2.5 + Math.random() * 1.5));
      const raiseAmount = Math.max(table.getMinRaise(), target);
      if (raiseAmount >= seat.chipCount * 0.7) return { action: PlayerAction.AllIn, raiseAmount: 0 };
      if (raiseAmount <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount };
    }
    if (callAmount === 0) return { action: PlayerAction.Check, raiseAmount: 0 };
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // NIT: only premiums (top ~10%), folds to any 3-bet without aces/kings
  if (profile.archetype === 'NIT') {
    const NIT_OPEN = 0.78; // ~AQs+, TT+, AKo, JJ+
    const NIT_CALL_RAISE = 0.85; // QQ+, AK
    const NIT_4BET = 0.93; // KK+, AA only
    if (callAmount === 0) {
      if (handStrength >= NIT_OPEN) {
        const raiseAmount = Math.max(table.getMinRaise(), Math.round(bigBlind * 2.5));
        return raiseAmount <= seat.chipCount
          ? { action: PlayerAction.Raise, raiseAmount }
          : { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (opponents.raiseCount >= 2 && handStrength < NIT_4BET) {
      return { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    if (handStrength >= NIT_4BET) {
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    if (handStrength >= NIT_CALL_RAISE) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // ROCK: tight-passive, calls down with marginals, almost never raises preflop
  if (profile.archetype === 'ROCK') {
    if (callAmount === 0) {
      if (handStrength >= 0.85) {
        const raiseAmount = Math.max(table.getMinRaise(), Math.round(bigBlind * 2.5));
        return raiseAmount <= seat.chipCount
          ? { action: PlayerAction.Raise, raiseAmount }
          : { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (handStrength >= 0.50 && callAmount <= bigBlind * 4) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    if (handStrength >= 0.85) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // FISH: loose-passive, limps a lot, calls almost any raise with anything decent
  if (profile.archetype === 'FISH') {
    if (callAmount === 0) {
      // Often limp with marginal hands (very fishy behavior)
      if (handStrength >= 0.85) {
        const raiseAmount = Math.max(table.getMinRaise(), Math.round(bigBlind * 3));
        return raiseAmount <= seat.chipCount
          ? { action: PlayerAction.Raise, raiseAmount }
          : { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      if (handStrength >= 0.18) {
        return { action: PlayerAction.Check, raiseAmount: 0 }; // limp
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    // Calls way too wide
    if (handStrength >= 0.22 && callAmount <= seat.chipCount * 0.10) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    if (handStrength >= 0.60) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    if (handStrength >= 0.88) {
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // LAG: 3-bets wide, raises in late position with anything decent
  if (profile.archetype === 'LAG') {
    const lagOpen = position >= totalActive - 3 ? 0.20 : 0.32;
    const lag3Bet = 0.42;
    if (callAmount === 0) {
      if (handStrength >= lagOpen) {
        const raiseAmount = Math.max(table.getMinRaise(), Math.round(bigBlind * (2.5 + Math.random() * 0.8)));
        return raiseAmount <= seat.chipCount
          ? { action: PlayerAction.Raise, raiseAmount }
          : { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (handStrength >= 0.85) {
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    if (opponents.raiseCount >= 2) {
      // Facing 3-bet
      if (handStrength >= 0.65) return { action: PlayerAction.Call, raiseAmount: 0 };
      return { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    if (handStrength >= lag3Bet) {
      // 3-bet
      const raiseAmount = roundToBB(Math.max(table.getMinRaise(), Math.round(callAmount * 3)), bigBlind);
      if (raiseAmount <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount };
    }
    if (handStrength >= 0.30) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // TAG (default): falls through to existing GTO-leaning logic
  const openRaiseThreshold = getOpenRaiseRange(position, totalActive);
  const threeBetThreshold = get3BetRange(position);

  // No bet to match (we can check or open-raise)
  if (callAmount === 0) {
    if (handStrength >= openRaiseThreshold) {
      // Open raise: 2.5-3x BB from early, 2-2.5x from late
      const raiseMult = position < 3 ? 2.5 + Math.random() * 0.5 : 2.0 + Math.random() * 0.5;
      const raiseAmount = Math.max(table.getMinRaise(), Math.round(bigBlind * raiseMult));
      if (raiseAmount <= seat.chipCount) {
        return { action: PlayerAction.Raise, raiseAmount };
      }
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    return { action: PlayerAction.Check, raiseAmount: 0 };
  }

  // Facing a raise
  const facingRaise = callAmount > bigBlind;
  const facingThreeBet = opponents.raiseCount >= 2;

  if (facingThreeBet) {
    // Facing 3-bet: need premium hands
    if (handStrength >= 0.8) {
      // 4-bet with premiums
      const raiseAmount = Math.max(table.getMinRaise(), Math.round(totalPot * 2.2));
      if (raiseAmount <= seat.chipCount) {
        return { action: PlayerAction.Raise, raiseAmount };
      }
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    if (handStrength >= 0.65) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    // Occasional light 4-bet bluff (expert only)
    if (profile.difficulty === 'expert' && Math.random() < profile.bluffFrequency * 0.3) {
      const raiseAmount = Math.max(table.getMinRaise(), Math.round(totalPot * 2));
      if (raiseAmount <= seat.chipCount * 0.3) {
        return { action: PlayerAction.Raise, raiseAmount };
      }
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  if (facingRaise) {
    // Facing single raise
    if (handStrength >= threeBetThreshold) {
      // 3-bet
      const raiseAmount = roundToBB(Math.max(table.getMinRaise(), Math.round(callAmount * 3)), bigBlind);
      if (raiseAmount <= seat.chipCount) {
        return { action: PlayerAction.Raise, raiseAmount };
      }
    }
    if (handStrength >= openRaiseThreshold * 0.85) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    // Consider calling with suited connectors in position
    if (position >= totalActive - 2 && handStrength >= 0.25) {
      if (callAmount <= seat.chipCount * 0.05) {
        return { action: PlayerAction.Call, raiseAmount: 0 };
      }
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // Facing just the big blind (limp or raise)
  if (handStrength >= openRaiseThreshold) {
    const raiseMult = 2.5 + Math.random() * 0.5;
    const raiseAmount = roundToBB(Math.max(table.getMinRaise(), Math.round(bigBlind * raiseMult)), bigBlind);
    if (raiseAmount <= seat.chipCount) {
      return { action: PlayerAction.Raise, raiseAmount };
    }
  }

  // Limp with speculative hands in late position
  if (position >= totalActive - 3 && handStrength >= 0.2) {
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // VPIP threshold (personality-influenced)
  if (handStrength >= 1.0 - profile.vpip) {
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  return { action: PlayerAction.Fold, raiseAmount: 0 };
}

// ============================================================
// Post-flop decision logic
// ============================================================

function postFlopStrategy(
  effectiveStrength: number,
  rawStrength: number,
  callAmount: number,
  totalPot: number,
  potOdds: number,
  seat: Seat,
  table: PokerTable,
  profile: AIPlayerProfile,
  board: BoardTexture,
  opponents: OpponentModel,
  outs: number,
  bigBlind: number,
  numOpponents: number
): AIDecision {
  const isRiver = table.currentPhase === GamePhase.River;
  const params = ARCHETYPE_PARAMS[profile.archetype];

  // ============================================================
  // ARCHETYPE-SPECIFIC POSTFLOP BRANCHES
  // ============================================================

  // CALLING_STATION: never folds top pair, calls down with second pair
  if (profile.archetype === 'CALLING_STATION') {
    if (callAmount === 0) {
      // Almost never bets — only obvious value bets
      if (effectiveStrength > 0.85) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.4));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    // Folds only with absolute trash on big bets
    if (effectiveStrength < 0.18 && callAmount > totalPot) {
      return { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    if (callAmount >= seat.chipCount) {
      return effectiveStrength > 0.45 ? { action: PlayerAction.AllIn, raiseAmount: 0 } : { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // MANIAC: bets/raises everything, big bluffs, never just calls
  if (profile.archetype === 'MANIAC') {
    if (callAmount === 0) {
      // Always c-bet/barrel
      const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * (0.7 + Math.random() * 0.6) * params.betSizingMultiplier));
      if (betSize >= seat.chipCount * 0.7 && effectiveStrength > 0.5) {
        return { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      if (betSize <= seat.chipCount && betSize >= table.getMinRaise()) {
        return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    // Facing a bet: raise or fold (almost never just call)
    if (effectiveStrength > 0.55 || (Math.random() < 0.45 && !isRiver)) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 1.0 * params.betSizingMultiplier));
      if (raiseSize + callAmount >= seat.chipCount * 0.8) {
        return { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      if (raiseSize + callAmount <= seat.chipCount) {
        return { action: PlayerAction.Raise, raiseAmount: raiseSize };
      }
    }
    if (effectiveStrength < 0.25) return { action: PlayerAction.Fold, raiseAmount: 0 };
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // NIT: pot-controls everything except monsters, gives up on missed flops
  if (profile.archetype === 'NIT') {
    if (callAmount === 0) {
      if (effectiveStrength > 0.80) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.5 * params.betSizingMultiplier));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    // Folds anything below top pair to a bet
    if (effectiveStrength < 0.55) return { action: PlayerAction.Fold, raiseAmount: 0 };
    if (effectiveStrength > 0.85) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.7));
      if (raiseSize + callAmount <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // ROCK: tight-passive — calls down marginal hands but rarely raises
  if (profile.archetype === 'ROCK') {
    if (callAmount === 0) {
      if (effectiveStrength > 0.78) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.4));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (effectiveStrength < 0.30) return { action: PlayerAction.Fold, raiseAmount: 0 };
    if (effectiveStrength > 0.92) {
      // Only raise with monsters
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.5));
      if (raiseSize + callAmount <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    if (callAmount >= seat.chipCount * 0.6 && effectiveStrength < 0.7) {
      return { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // FISH: chases draws too far, calls bottom pair, occasional weird raise
  if (profile.archetype === 'FISH') {
    if (callAmount === 0) {
      if (effectiveStrength > 0.70) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.5));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    // Chases ANY draw
    if (outs >= 4 && callAmount <= totalPot * 0.6) return { action: PlayerAction.Call, raiseAmount: 0 };
    if (effectiveStrength < 0.20 && callAmount > totalPot * 0.4) return { action: PlayerAction.Fold, raiseAmount: 0 };
    if (effectiveStrength > 0.88) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.6));
      if (raiseSize + callAmount <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // LAG: high c-bet frequency, lots of bluffs, frequent raises
  if (profile.archetype === 'LAG') {
    if (callAmount === 0) {
      // C-bet most flops if we raised preflop
      const cbetRoll = Math.random();
      if (effectiveStrength > 0.55 || cbetRoll < params.cbetFreq) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * (0.6 + Math.random() * 0.3) * params.betSizingMultiplier));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (effectiveStrength > 0.70) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.85 * params.betSizingMultiplier));
      if (raiseSize + callAmount >= seat.chipCount * 0.8) return { action: PlayerAction.AllIn, raiseAmount: 0 };
      if (raiseSize + callAmount <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    if (effectiveStrength > potOdds + 0.05) return { action: PlayerAction.Call, raiseAmount: 0 };
    // Bluff-raise occasionally
    if (Math.random() < params.bluffFreq && !isRiver) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.7));
      if (raiseSize + callAmount <= seat.chipCount * 0.4) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // TAG (default): existing GTO-leaning logic below
  // ============================================================
  // No bet to face: check or bet
  // ============================================================
  if (callAmount === 0) {
    // Strong hand: bet for value
    if (effectiveStrength > 0.65) {
      const betSize = getGTOBetSize(
        rawStrength, totalPot, bigBlind, seat.chipCount,
        board, table.currentPhase, profile
      );
      const minRaise = table.getMinRaise();
      if (betSize >= minRaise) {
        return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
    }

    // Medium hand: check (pot control)
    if (effectiveStrength > 0.4) {
      // Sometimes bet as a thin value bet (expert level)
      if (profile.difficulty === 'expert' && Math.random() < 0.25) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.33));
        if (betSize <= seat.chipCount) {
          return { action: PlayerAction.Raise, raiseAmount: betSize };
        }
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }

    // Weak hand: check or bluff
    if (Math.random() < profile.bluffFrequency) {
      // Semi-bluff with draws
      if (outs >= 8) {
        const betSize = getGTOBetSize(
          0.7, totalPot, bigBlind, seat.chipCount,
          board, table.currentPhase, profile
        );
        const minRaise = table.getMinRaise();
        if (betSize >= minRaise && betSize <= seat.chipCount * 0.4) {
          return { action: PlayerAction.Raise, raiseAmount: betSize };
        }
      }
      // Pure bluff on dry boards (expert/hard)
      if (board.isDry && (profile.difficulty === 'expert' || profile.difficulty === 'hard')) {
        const betSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.55));
        if (betSize <= seat.chipCount * 0.25) {
          return { action: PlayerAction.Raise, raiseAmount: betSize };
        }
      }
    }

    return { action: PlayerAction.Check, raiseAmount: 0 };
  }

  // ============================================================
  // Facing a bet: call, raise, or fold
  // ============================================================

  // All-in decision (calling would commit most of stack)
  if (callAmount >= seat.chipCount * 0.6) {
    if (effectiveStrength > 0.7) {
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    if (effectiveStrength > potOdds + 0.1) {
      return { action: PlayerAction.AllIn, raiseAmount: 0 };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // Strong hand: raise (value raise or check-raise)
  if (effectiveStrength > 0.75) {
    const raiseSize = getGTOBetSize(
      rawStrength, totalPot, bigBlind, seat.chipCount,
      board, table.currentPhase, profile
    );
    const minRaise = table.getMinRaise();
    if (raiseSize >= minRaise && raiseSize + callAmount <= seat.chipCount) {
      return { action: PlayerAction.Raise, raiseAmount: Math.max(raiseSize, minRaise) };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // Medium hand: call if pot odds are right
  if (effectiveStrength > potOdds || effectiveStrength > 0.45) {
    // But consider raising sometimes (merge/balanced)
    if (effectiveStrength > 0.6 && Math.random() < 0.3 * profile.aggressionFactor / 3) {
      const raiseSize = roundToBB(Math.max(table.getMinRaise(), Math.round(totalPot * 0.6)), bigBlind);
      if (raiseSize + callAmount <= seat.chipCount) {
        return { action: PlayerAction.Raise, raiseAmount: raiseSize };
      }
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // Drawing hand: call if implied odds justify it
  if (outs >= 8 && !isRiver) {
    // Flush/straight draw: call if getting at least 3:1
    if (callAmount <= totalPot * 0.35) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    // Semi-bluff raise with big draws
    if (outs >= 12 && Math.random() < profile.aggressionFactor * 0.2) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.7));
      if (raiseSize + callAmount <= seat.chipCount * 0.4) {
        return { action: PlayerAction.Raise, raiseAmount: raiseSize };
      }
    }
    if (callAmount <= seat.chipCount * 0.1) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
  }

  // Gutshot or small draw on good price
  if (outs >= 4 && !isRiver && callAmount <= totalPot * 0.2) {
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // Bluff-raise (expert level, balanced frequency)
  if (profile.difficulty === 'expert' && Math.random() < profile.bluffFrequency * 0.4) {
    // Only bluff-raise on certain board textures
    if (board.hasHighCards || board.isPaired) {
      const raiseSize = Math.max(table.getMinRaise(), Math.round(totalPot * 0.65));
      if (raiseSize + callAmount <= seat.chipCount * 0.25) {
        return { action: PlayerAction.Raise, raiseAmount: raiseSize };
      }
    }
  }

  // Fold
  return { action: PlayerAction.Fold, raiseAmount: 0 };
}

// ============================================================
// Thinking delay
// ============================================================

export function getThinkingDelay(difficulty: Difficulty): number {
  // Natural human-like variance per difficulty. Ranges overlap so two bots
  // of the same difficulty don't feel lockstep; higher-difficulty bots lean
  // longer without being grindingly slow. Max is ~2.35s (turn clock is 30s,
  // so bots will NEVER burn the whole timer). Min is ~250-650ms so the
  // fastest bot still has "a beat of thought" — acting in <100ms feels
  // robotic. Rebalanced 2026-04-22 after audit feedback: "AI shouldn't
  // look like AI, but should never take the entire turn clock."
  switch (difficulty) {
    case 'easy':   return 250 + Math.floor(Math.random() * 750);   // 250-1000ms
    case 'medium': return 400 + Math.floor(Math.random() * 1000);  // 400-1400ms
    case 'hard':   return 550 + Math.floor(Math.random() * 1350);  // 550-1900ms
    case 'expert': return 650 + Math.floor(Math.random() * 1700);  // 650-2350ms
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AI INTELLIGENCE UPGRADES — audit-driven (5 additions)
//
// Additive helpers + a module-scope opponent profile store. The existing
// archetype decision branches stay the skeleton; these helpers layer on:
//   1) Session-level opponent modeling (across hands, not per-hand)
//   2) Stack-depth-aware pre-flop range adjustment
//   3) Multi-way pot c-bet + call-tighten + sizing adjustment
//   4) Balanced bluff strategy (board + hand + opponent-category aware)
//   5) Thin river value-betting against loose opponents
// ═══════════════════════════════════════════════════════════════════════

export interface OpponentSessionProfile {
  handsSeen: number;
  vpipHands: number;
  pfrHands: number;
  threeBetsFaced: number;
  threeBetFolds: number;
  cbetsFaced: number;
  cbetFolds: number;
  showdownsReached: number;
  showdownsWonWithBluff: number;
  lastHandNumber: number;
}

const OPPONENT_PROFILES: Map<string, OpponentSessionProfile> = new Map();

function getOrCreateOpponentProfile(playerName: string): OpponentSessionProfile {
  let p = OPPONENT_PROFILES.get(playerName);
  if (!p) {
    p = {
      handsSeen: 0, vpipHands: 0, pfrHands: 0,
      threeBetsFaced: 0, threeBetFolds: 0,
      cbetsFaced: 0, cbetFolds: 0,
      showdownsReached: 0, showdownsWonWithBluff: 0,
      lastHandNumber: -1,
    };
    OPPONENT_PROFILES.set(playerName, p);
  }
  return p;
}

export function getOpponentProfile(playerName: string): OpponentSessionProfile | null {
  return OPPONENT_PROFILES.get(playerName) || null;
}

// External hook — PokerTable calls on action events to build session view.
export function recordOpponentObservation(
  playerName: string,
  observation: 'hand_start' | 'vpip' | 'pfr' | 'face_3bet' | 'fold_to_3bet' | 'face_cbet' | 'fold_to_cbet' | 'showdown',
  extra?: { bluffed?: boolean; handNumber?: number }
): void {
  if (!playerName) return;
  const p = getOrCreateOpponentProfile(playerName);
  switch (observation) {
    case 'hand_start':
      if (extra && extra.handNumber != null && extra.handNumber !== p.lastHandNumber) {
        p.handsSeen++;
        p.lastHandNumber = extra.handNumber;
      }
      break;
    case 'vpip':         p.vpipHands++; break;
    case 'pfr':          p.pfrHands++; break;
    case 'face_3bet':    p.threeBetsFaced++; break;
    case 'fold_to_3bet': p.threeBetFolds++; break;
    case 'face_cbet':    p.cbetsFaced++; break;
    case 'fold_to_cbet': p.cbetFolds++; break;
    case 'showdown':
      p.showdownsReached++;
      if (extra && extra.bluffed) p.showdownsWonWithBluff++;
      break;
  }
}

export type OpponentCategory = 'unknown' | 'nit' | 'tag' | 'lag' | 'fish' | 'station' | 'maniac';

export function categorizeOpponent(playerName: string): OpponentCategory {
  const p = OPPONENT_PROFILES.get(playerName);
  if (!p || p.handsSeen < 10) return 'unknown';
  const vpip = p.vpipHands / p.handsSeen;
  const pfr = p.pfrHands / p.handsSeen;
  const foldTo3bet = p.threeBetsFaced > 0 ? p.threeBetFolds / p.threeBetsFaced : 0.6;
  if (vpip < 0.15 && pfr < 0.12) return 'nit';
  if (vpip > 0.45 && pfr < 0.10) return 'station';
  if (vpip > 0.50 && pfr > 0.35) return 'maniac';
  if (vpip > 0.35 && pfr < 0.15) return 'fish';
  if (vpip > 0.25 && pfr > 0.20 && foldTo3bet < 0.55) return 'lag';
  if (vpip > 0.18 && pfr > 0.12) return 'tag';
  return 'unknown';
}

// UPGRADE #3 — stack-depth pre-flop threshold multiplier.
export function getStackDepthMultiplier(effectiveStackBB: number): number {
  if (effectiveStackBB < 30)  return 1.4;
  if (effectiveStackBB < 60)  return 1.1;
  if (effectiveStackBB < 120) return 1.0;
  if (effectiveStackBB < 200) return 0.95;
  return 0.90;
}

// UPGRADE #5 — multi-way pot adjustments.
export function getMultiWayAdjustment(numOpponentsInPot: number): { cbetMult: number; callTightenMult: number; sizeMult: number } {
  if (numOpponentsInPot <= 1) return { cbetMult: 1.0, callTightenMult: 1.0, sizeMult: 1.0 };
  if (numOpponentsInPot === 2) return { cbetMult: 0.7, callTightenMult: 1.12, sizeMult: 1.1 };
  return { cbetMult: 0.5, callTightenMult: 1.25, sizeMult: 1.2 };
}

// UPGRADE #2 — balanced bluff decision.
export function shouldBluffBalanced(
  handStrength: number,
  board: BoardTexture,
  phase: GamePhase,
  profile: AIPlayerProfile,
  opponentNames: string[]
): boolean {
  if (handStrength > 0.75) return false;
  if (handStrength < 0.08) return false;
  let foldyCount = 0;
  let stickyCount = 0;
  for (const name of opponentNames) {
    const cat = categorizeOpponent(name);
    if (cat === 'nit' || cat === 'tag') foldyCount++;
    if (cat === 'station' || cat === 'fish' || cat === 'maniac') stickyCount++;
  }
  if (stickyCount > foldyCount + 1) return false;
  const baseBluff = profile.bluffFrequency;
  let storyMult = 0;
  if (phase === GamePhase.Flop) {
    if (board.isDry && board.hasHighCards) storyMult = 1.2;
    else if (board.isMonotone) storyMult = 0.9;
    else if (board.isWet && !board.hasHighCards) storyMult = 0.5;
    else storyMult = 0.7;
  } else if (phase === GamePhase.Turn) {
    storyMult = board.straightPossible || board.flushPossible ? 0.7 : 0.35;
  } else if (phase === GamePhase.River) {
    storyMult = board.isMonotone || board.isPaired ? 0.45 : 0.15;
  }
  const foldMult = foldyCount > 0 ? 1 + (foldyCount * 0.15) : 1;
  return Math.random() < Math.min(0.35, baseBluff * storyMult * foldMult);
}

// UPGRADE #4 — thin river value bet.
export function shouldThinValueBet(
  handStrength: number,
  phase: GamePhase,
  board: BoardTexture,
  opponentNames: string[],
  profile: AIPlayerProfile
): boolean {
  if (phase !== GamePhase.River) return false;
  if (handStrength < 0.45 || handStrength > 0.68) return false;
  if (board.isMonotone || (board.isPaired && board.hasHighCards)) return false;
  const loose = opponentNames.filter((n) => {
    const c = categorizeOpponent(n);
    return c === 'station' || c === 'fish' || c === 'lag';
  }).length;
  const tight = opponentNames.filter((n) => categorizeOpponent(n) === 'nit').length;
  if (loose === 0 || tight > loose) return false;
  if (profile.difficulty === 'easy') return false;
  const baseProb = profile.difficulty === 'expert' ? 0.45
                 : profile.difficulty === 'hard'   ? 0.30
                 : 0.15;
  return Math.random() < baseProb;
}

export function getEffectiveStackBB(table: PokerTable, mySeat: number): number {
  const seat = table.seats[mySeat];
  if (!seat) return 100;
  const bb = table.config.bigBlind || 50;
  let largestOpp = 0;
  for (const s of table.seats) {
    if (s.seatIndex === mySeat) continue;
    if (s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.chipCount > largestOpp) largestOpp = s.chipCount;
  }
  const effective = Math.min(seat.chipCount, largestOpp);
  return Math.max(1, Math.round(effective / bb));
}

/** Enumerate the non-folded opponent player names on a table. */
export function getActiveOpponentNames(table: PokerTable, mySeat: number): string[] {
  const names: string[] = [];
  for (const s of table.seats) {
    if (s.seatIndex === mySeat) continue;
    if (s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (!s.isAI && s.playerName) names.push(s.playerName);
  }
  return names;
}

import { Card, Rank, Suit } from '../game/Card';
import { evaluateHand, compareTo, HandRank, HandResult } from '../game/HandEvaluator';
import { evaluateOmahaHand } from '../game/HandEvaluatorExtensions';
import { PokerTable, Seat, PlayerAction, GamePhase } from '../game/PokerTable';
import { calculateEquity, keptHoldemHoleCards } from '../training/TrainingEngine';
import {
  getPreflopPercentile, posBucket, PosBucket,
  OPEN_THRESHOLD, THREEBET_THRESHOLD, FOURBET_THRESHOLD, CALL_VS_RAISE_THRESHOLD,
  ARCHETYPE_RANGE_FACTOR, adjustThreshold,
} from './preflopRanges';
import { inPushFoldZone, nashPushPctile, nashCallPctile, PUSH_FOLD_MAX_BB } from './pushFoldSolver';

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

/**
 * 2026-10-21 (gameplay F49) — the table's format, for the decision. All-In or
 * Fold: every pre-flop decision is shove-or-fold from the push/fold solver at
 * any stack depth (the deepest baked stack stands in for a deeper one) — the
 * bots used to open, limp and min-raise at 50 BB where the human may only fold
 * or go all-in. index.ts maps whatever is left to fold / free check / all-in.
 */
export interface DecideOptions {
  allInOrFold?: boolean;
}

// ============================================================
// 2026-10-11 (.online R2, GAME-8 / GAME-9) — variant routing + raise-war limits
// ============================================================

/** Every Stud-family variantId the engine uses (SevenStudTable: 'seven-stud' — plain Stud — was missing). */
export const STUD_VARIANT_IDS: ReadonlySet<string> = new Set(['seven-stud', 'seven-card-stud', 'seven-card-stud-hi-lo', 'razz']);
/** Every draw-family variantId (FiveCardDrawTable / BadugiTable). */
export const DRAW_VARIANT_IDS: ReadonlySet<string> = new Set(['five-card-draw', 'triple-draw', 'badugi']);

/**
 * GAME-8 — the two hole cards a HOLD'EM-style hand plays. A (Crazy) Pineapple
 * seat holds 3 until its discard; the bot's discard is the engine's automatic
 * one (PineappleTable.autoDiscardOne: the lowest rank, ties to the lowest
 * suit), so these are exactly the two it keeps. calculateEquity / the preflop
 * percentile are only ever given two cards (a 7-card Stud hand fed to the
 * Hold'em Monte Carlo cost ~1s of blocking CPU per decision).
 */
export function holdemHoleCards(hole: Card[]): Card[] {
  return keptHoldemHoleCards(hole);
}

/**
 * GAME-8 — the most wall-clock time one bot decision may spend in its Monte
 * Carlo equity (calculateEquity stops after at least 64 simulations once it is
 * spent). Measured before R2: 6-card Omaha multiway ~0.7s, Stud ~1s, per
 * decision, all on the shared event loop.
 */
export const BOT_EQUITY_BUDGET_MS = 40;

/**
 * GAME-9 — no endless bot raise wars. Raises allowed per betting round before
 * a bot stops re-raising (the table's own count of voluntary bets/raises this
 * street, PokerTable.raisesThisStreet): pre-flop an open, a 3-bet and a 4-bet;
 * after the flop (and on every Stud / draw street) a bet and one raise. Past
 * that, and after BOT_MAX_OWN_RAISES_PER_STREET raises of its own, a bot only
 * calls / checks — or, at no-limit with a premium hand, moves all-in (a war
 * then ends in one more action). Before this two bots with strong hands
 * min-re-raised each other 122-154 times in one round (multi-minute hands,
 * ~200 busts/hour on the 24/7 tables).
 */
export const BOT_MAX_STREET_RAISES_PREFLOP = 3;
export const BOT_MAX_STREET_RAISES_POSTFLOP = 2;
export const BOT_MAX_OWN_RAISES_PER_STREET = 2;
// 2026-10-24 (Sit & Go fix-all F2) — an opening bet is logged 'bet N': it is one of the bot's own raises too.
const OWN_RAISE_RE = /^(raised to|bet |straddle|went all-in)/;

export function limitBotRaiseWar(
  table: PokerTable,
  seat: Seat,
  decision: AIDecision,
  firstRound: boolean,
  strength: number,
): AIDecision {
  if (decision.action !== PlayerAction.Raise && decision.action !== PlayerAction.AllIn) return decision;
  const callAmount = table.getCallAmount(seat);
  // Calling for all of a short stack is a call, not a raise — always allowed.
  if (decision.action === PlayerAction.AllIn && callAmount >= seat.chipCount) return decision;
  const passive: AIDecision = callAmount > 0
    ? { action: PlayerAction.Call, raiseAmount: 0 }
    : { action: PlayerAction.Check, raiseAmount: 0 };
  // Fixed limit at its cap (a bet and three raises): no raise is legal at all.
  if (typeof (table as any).isRaiseCapped === 'function' && table.isRaiseCapped()) return passive;
  const streetRaises = Number((table as any).raisesThisStreet) || 0;
  const streetCap = firstRound ? BOT_MAX_STREET_RAISES_PREFLOP : BOT_MAX_STREET_RAISES_POSTFLOP;
  let ownRaises = 0;
  for (const e of table.actionLog) {
    if (e.street === table.currentPhase && e.seatIndex === seat.seatIndex && OWN_RAISE_RE.test(e.action)) ownRaises++;
  }
  if (streetRaises < streetCap && ownRaises < BOT_MAX_OWN_RAISES_PER_STREET) return decision;
  // Past the cap: a premium no-limit hand may still shove (one action, the war
  // is over); everything else just calls / checks.
  const premium = firstRound ? 0.93 : 0.85;
  if (table.bettingStructure === 'no-limit' && strength >= premium) return { action: PlayerAction.AllIn, raiseAmount: 0 };
  return passive;
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
  // 2026-07-07 fix: a board is either wet (draw-heavy) or dry (static). The old
  // `!isWet && isPaired` left the most common flop — a dry unpaired rainbow —
  // as NEITHER, so every `board.isDry` branch (dry-board bluffs/sizing) silently
  // skipped it. Dry now correctly means "not wet".
  const isDry = !isWet;

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

// 2026-07-07 AI overhaul: preflop strength is now a real, equity-ranked range
// PERCENTILE (1.0 = AA, ~0.85 = top 15%) instead of the old chen/20 heuristic
// that compressed every non-AA hand. All preflop thresholds are on this same
// percentile scale, so "open the top 15%" is literally `pctile >= 0.85`. The
// chen formula is kept as a cheap fallback for the rare pre-table-warm call.
function getPreFlopHandRank(holeCards: Card[]): number {
  const p = getPreflopPercentile(holeCards);
  if (p > 0) return p;
  return Math.min(1.0, chenFormulaScore(holeCards) / 20);
}

// 2026-07-07 AI overhaul: Omaha preflop strength (4 hole cards). Omaha value
// comes from PAIRS (especially high), being DOUBLE-SUITED, and CONNECTEDNESS
// (rundowns), plus broadway content — trips/quads in hand are BAD (dead cards).
// Replaces feeding Omaha hands into the 2-card Chen formula, which ignored two
// of the four cards. Returns 0..1 (calibrated to the same rough scale as the
// Hold'em percentile so the shared preflop thresholds still apply).
function getOmahaPreflopStrength(hole: Card[]): number {
  if (!hole || hole.length < 4) {
    return hole && hole.length >= 2 ? getPreFlopHandRank(hole.slice(0, 2)) : 0.3;
  }
  const ranks = hole.map((c) => c.rank).sort((a, b) => b - a);
  const rc = new Map<number, number>();
  for (const r of ranks) rc.set(r, (rc.get(r) || 0) + 1);
  const sc = new Map<number, number>();
  for (const c of hole) sc.set(c.suit, (sc.get(c.suit) || 0) + 1);

  let score = 0.30;
  // Pairs: high pairs premium; trips/quads = wasted cards.
  for (const [rank, count] of rc) {
    if (count === 2) score += 0.02 + (rank / 14) * 0.20;
    else if (count >= 3) score -= 0.12;
  }
  // Suitedness: double-suited is best; too many of one suit blocks own flushes.
  const suitCounts = [...sc.values()].sort((a, b) => b - a);
  if (suitCounts[0] === 2 && suitCounts[1] === 2) score += 0.14;
  else if (suitCounts[0] === 2) score += 0.06;
  else if (suitCounts[0] >= 3) score -= 0.06;
  for (const [suit, cnt] of sc) {
    if (cnt >= 2 && hole.some((c) => c.suit === suit && c.rank === Rank.Ace)) { score += 0.05; break; }
  }
  // Connectedness (rundowns).
  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  if (uniq.length >= 3) {
    const span = uniq[uniq.length - 1] - uniq[0];
    if (span <= 3) score += 0.14;
    else if (span <= 5) score += 0.08;
    else if (span <= 8) score += 0.03;
  }
  score += ranks.filter((r) => r >= Rank.Ten).length * 0.02;
  // 2026-07-07 review fix: calibrate onto the Hold'em PERCENTILE scale the shared
  // preflop thresholds expect. Omaha equities run closer together (ranges are
  // wider), so a linear stretch lifts strong PLO hands above the open thresholds:
  // AAKKds→~1.0, AKQJds→~0.92 (EP-open), big rundowns→~0.77 (CO/MP), KKxx→~0.73
  // (CO/BTN), junk→~0.45 (fold). Without this, only aces cleared EP/MP and Omaha
  // bots massively over-folded out of position.
  return Math.max(0.10, Math.min(1, score * 1.15 + 0.10));
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
  difficulty: Difficulty,
  // 2026-06-19: Omaha awareness (default false → unchanged Hold'em path). Omaha
  // REQUIRES exactly 2 hole + 3 board, so the old any-5-of-9 made bots evaluate
  // their Omaha hands as far too strong.
  isOmaha: boolean = false,
  // 2026-07-07 AI overhaul: opponents' assumed range floor (preflop percentile).
  // Threaded into calculateEquity so equity is computed vs a realistic (action-
  // narrowed) range instead of vs uniformly-random hands.
  oppMinPctile: number = 0,
  // 2026-07-07: short-deck (6+ Hold'em) — 36-card deck + flush > full house.
  shortDeck: boolean = false
): number {
  // Expert and Hard AI use actual Monte Carlo equity (but fewer sims for speed)
  if (difficulty === 'expert' || difficulty === 'hard') {
    const equity = calculateEquity(
      holeCards,
      communityCards,
      numOpponents,
      isOmaha,
      oppMinPctile,
      shortDeck,
      BOT_EQUITY_BUDGET_MS // GAME-8 (R2) — bounded think time
    );
    return equity / 100; // normalize to 0-1
  }

  // Medium/Easy use simplified evaluation
  const allCards = [...holeCards, ...communityCards];
  const result = (isOmaha && communityCards.length >= 3)
    ? evaluateOmahaHand(holeCards, communityCards)
    : evaluateHand(allCards);

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

  // Guard against zero / negative inputs which would produce NaN / Infinity
  // and poison effectiveStrength downstream.
  if (effectiveStack <= 0 || potSize <= 0) return 0;

  // Stack-to-pot ratio: deep stacks = more implied odds
  const spr = effectiveStack / Math.max(potSize, 1);

  // Base implied odds from outs
  const drawEquity = (outs * cardsTocome * 2.2) / 100; // rough rule of 2/4

  // Adjust by SPR: deep stacks make draws more valuable
  const sprBonus = Math.min(0.15, spr * 0.01);

  const value = drawEquity + sprBonus;
  if (!isFinite(value)) return 0;
  // Clamp to [0, 0.5] so a malformed draw can never poison effectiveStrength.
  return Math.max(0, Math.min(0.5, value));
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
  // 2026-06-11 audit M4: round UP to the nearest big blind, not to the nearest.
  // Every raise site passes Math.max(getMinRaise(), …) as `amount`; rounding to
  // the NEAREST BB could land BELOW getMinRaise (e.g. min 160, BB 50 → 150),
  // and the engine then rejects the sub-minimum raise and silently downgrades
  // it to a call. Ceiling keeps the rounded size >= the (already min-gated)
  // input, so an intended raise stays a raise.
  return Math.ceil(amount / bigBlind) * bigBlind;
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

  // 2026-07-07 AI overhaul — DE-CORRELATED sizing. The old code mapped strength
  // almost 1:1 to size (small = a medium hand, big = strong/bluff), so a human
  // could read the bet size. Real solvers use a small DISCRETE MENU of sizes and
  // put value, bluffs AND merges through the SAME sizes, with mixing — so the
  // size no longer reveals the hand. We pick a menu index biased by strength but
  // with a genuine ±1 random walk, so strong hands sometimes bet small (trap /
  // merge) and medium hands sometimes bet big — breaking the tell.
  const MENU = [0.33, 0.5, 0.66, 0.85, 1.15]; // small → overbet
  // Value (strong) and bluffs both center on the big sizes (polarized); merges
  // (medium) center small.
  let center: number;
  if (handStrength > 0.82) center = 3;        // strong → ~85% pot
  else if (handStrength > 0.55) center = 1;   // medium/merge → ~50% pot
  else center = 3;                            // bluff → mirrors value (polarized)
  const r = Math.random();
  let idx = center;
  if (r < 0.20) idx = Math.max(0, center - 1);
  else if (r > 0.80) idx = Math.min(MENU.length - 1, center + 1);
  // Overbet (idx 4) only for genuinely strong + aggressive personalities.
  if (idx >= 4 && !(handStrength > 0.82 && profile.aggressionFactor > 2)) idx = 3;
  let potFraction = MENU[idx] * (0.9 + Math.random() * 0.2); // ±10% jitter

  // Board texture: bigger on wet (deny equity), a touch smaller on dry/static.
  if (board.isWet) potFraction *= 1.12;
  else potFraction *= 0.92;

  // River: polarize a little more (big or small, less medium).
  if (phase === GamePhase.River) {
    if (handStrength > 0.75) potFraction *= 1.15;
    else potFraction *= 0.85;
  }

  // Personality scale (aggressive players size up).
  potFraction *= 0.8 + profile.aggressionFactor * 0.12;

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

/**
 * 2026-10-21 (gameplay F117) — a bot's position in the hand, as the strategy
 * reads it (0 = first to act), over the seats DEALT INTO the hand (a
 * sitting-out seat is not a position):
 *  - preflop: UTG = 0 … button = n-3, small blind = n-2, big blind = n-1 —
 *    posBucket's convention — counted from the first seat after THIS hand's
 *    big blind (heads-up: the button / small blind 0, the big blind 1);
 *  - postflop: small blind = 0 … button = n-1 — counted from the first seat
 *    after the button (a dead button counts from its empty seat).
 * Stud has no button: both count from the street's first actor (the bring-in
 * on Third Street, the best — Razz: lowest — board after). Before a hand has
 * a button / big blind it falls back to the seat's place in seat order (the
 * old behaviour, which used that order for every hand).
 */
export function seatPositions(table: PokerTable, seatIndex: number): { preflop: number; postflop: number; total: number } {
  const dealt = table.seats
    .filter(s => s.state === 'occupied' && !s.eliminated && s.holeCards.length > 0)
    .map(s => s.seatIndex);
  const seats = dealt.includes(seatIndex) ? dealt : table.getActivePlayerSeats();
  const n = seats.length;
  const me = seats.indexOf(seatIndex);
  if (n === 0 || me < 0) return { preflop: Math.max(0, me), postflop: Math.max(0, me), total: n };
  // The listed seat first clockwise strictly after `seat` (wrapping round).
  const firstAfter = (seat: number): number => {
    const i = seats.findIndex(s => s > seat);
    return i >= 0 ? i : 0;
  };
  const from = (startIdx: number): number => (((me - startIdx) % n) + n) % n;
  const studFirstActor = (table as any).getStudFirstActor;
  if (typeof studFirstActor === 'function') {
    const at = seats.indexOf(studFirstActor.call(table));
    const p = at >= 0 ? from(at) : me;
    return { preflop: p, postflop: p, total: n };
  }
  const bb = table.previousBigBlindSeat;
  const btn = table.dealerButtonSeat;
  return {
    preflop: bb >= 0 ? from(firstAfter(bb)) : me,
    postflop: btn >= 0 ? from(firstAfter(btn)) : me,
    total: n,
  };
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
  profile: AIPlayerProfile,
  opts: DecideOptions = {}
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
  // 2026-10-11 (.online R2, GAME-8) — plain Seven Card Stud's variantId is
  // 'seven-stud' (SevenStudTable), which this list missed: its bots ran the
  // Hold'em Monte Carlo on 4-7 hole cards (~1s of blocking CPU per decision,
  // a fake 80-96% equity) — 295 hands in 8h on that table vs 675-3,578
  // elsewhere. Recognised by id AND by the table's own shape (a Stud table
  // has getStudFirstActor, a draw table playerDraw), so a renamed variant can
  // never fall back to the Hold'em path again.
  const isStudFamily = STUD_VARIANT_IDS.has(variantId) || typeof (table as any).getStudFirstActor === 'function';
  // Draw games bet first in GamePhase.PreFlop (then Draw1 / Bet2 / …): every one
  // of their betting rounds uses the draw-hand strength, never the Hold'em
  // percentile of two of the five cards.
  const isDrawFamily = DRAW_VARIANT_IDS.has(variantId) || typeof (table as any).playerDraw === 'function';
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

  // Get position info. 2026-10-21 (gameplay F117) — RELATIVE to the button /
  // the big blind (it was the seat's rank in seat-number order: seat 0 always
  // played the early-position range, the highest seat the big blind's).
  const pos = seatPositions(table, seatIndex);
  const myPosition = pos.preflop;
  const totalActive = pos.total;

  // ============================================================
  // Hand strength evaluation
  // ============================================================
  // 2026-07-07 AI overhaul: infer the opponents' RANGE FLOOR from their action
  // so postflop equity is RANGE-AWARE, not "vs random hands". Aggression ⇒ a
  // stronger-than-random range; a passive field ⇒ near-random. Session reads
  // sharpen it: a known nit who bets is very strong; a station is wide.
  const oppCategory = dominantOpponentCategory(table, seatIndex);
  let oppMinPctile = 0;
  if (!isPreFlop && !isStudFamily && !isDrawFamily && !isDrawBet) {
    if (opponents.raiseCount >= 2) oppMinPctile = 0.80;
    else if (opponents.raiseCount === 1 || callAmount > bigBlind) oppMinPctile = 0.62;
    else if (callAmount > 0) oppMinPctile = 0.45;
    if (oppMinPctile > 0) {
      if (oppCategory === 'nit') oppMinPctile = Math.min(0.92, oppMinPctile + 0.10);
      else if (oppCategory === 'tag') oppMinPctile = Math.min(0.88, oppMinPctile + 0.05);
      else if (oppCategory === 'station' || oppCategory === 'fish') oppMinPctile = Math.max(0, oppMinPctile - 0.22);
      else if (oppCategory === 'maniac') oppMinPctile = Math.max(0, oppMinPctile - 0.15);
    }
  }

  let handStrength: number;

  const isOmahaFamily = /omaha/i.test(variantId);
  if (isStudFamily || isDrawFamily || isDrawBet) {
    // Non-community-card variants: use a generic hand-strength heuristic based
    // on the variant's own evaluator (or a lowball-aware one for razz/badugi/2-7).
    handStrength = getVariantHandStrength(seat.holeCards, variantId, isLowball);
  } else if (isPreFlop) {
    // Omaha uses a 4-card preflop model; Hold'em uses the equity-ranked percentile.
    handStrength = isOmahaFamily
      ? getOmahaPreflopStrength(seat.holeCards)
      : getPreFlopHandRank(holdemHoleCards(seat.holeCards));
  } else {
    // GAME-8 — the Hold'em equity is never fed more than 2 hole cards: a
    // (Crazy) Pineapple seat still holding 3 is priced on the 2 it keeps.
    handStrength = getPostFlopStrength(
      isOmahaFamily ? seat.holeCards : holdemHoleCards(seat.holeCards),
      table.communityCards, numOpponents, profile.difficulty,
      isOmahaFamily, oppMinPctile, /short|six.?plus|6.?plus/i.test(variantId)
    );
  }

  // Position: postflop keeps the 0.88(EP)→1.12(LP) nudge. Preflop position is
  // handled by position-bucketed range thresholds in preFlopStrategy (percentile
  // scale), so don't ALSO scale the percentile there. F117 — the POSTFLOP order
  // (small blind first, button last), not the pre-flop one (the blinds act
  // first after the flop: out of position).
  const relativePosition = totalActive > 1 ? pos.postflop / (totalActive - 1) : 0.5;
  const positionMult = 0.88 + relativePosition * 0.24;
  if (!isPreFlop) handStrength *= positionMult;
  if (!isFinite(handStrength)) handStrength = 0.3;

  // Difficulty-based noise (expert has almost none)
  const noiseMap: Record<Difficulty, number> = {
    easy: 0.25, medium: 0.12, hard: 0.05, expert: 0.02
  };
  const rawNoise = (Math.random() - 0.5) * noiseMap[profile.difficulty];
  const noise = isFinite(rawNoise) ? rawNoise : 0;
  handStrength = Math.min(1.0, Math.max(0.0, handStrength + noise));

  // Outs and implied odds for draw decisions
  const outs = isPreFlop ? 0 : countOuts(seat.holeCards, table.communityCards);
  const rawImplied = isPreFlop ? 0 : getImpliedOdds(
    handStrength, outs, totalPot, seat.chipCount, table.currentPhase
  );
  const impliedOdds = isFinite(rawImplied) ? rawImplied : 0;

  // Final NaN/Infinity guard — any upstream division or multiplication
  // that leaks a non-finite value here would otherwise poison every
  // comparison in the strategy blocks below.
  handStrength = isFinite(handStrength) ? Math.max(0, Math.min(1, handStrength)) : 0.3;

  // 2026-07-07 fix: for the Monte-Carlo tiers (hard/expert) equity ALREADY
  // prices in hitting the draw, so adding full implied odds double-counted it
  // and made bots call too wide with draws. Keep only the "extra money when I
  // hit" premium there; easy/medium (static made-hand lookup, no draw awareness)
  // still get the full draw bonus so they don't misprice draws entirely.
  const mcTier = profile.difficulty === 'expert' || profile.difficulty === 'hard';
  const effectiveStrength = handStrength + impliedOdds * (mcTier ? 0.35 : 1.0);

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
  // GAME-9 (R2) — every decision passes the raise-war limiter last.
  if (isPreFlop) {
    const pre = preFlopStrategy(
      handStrength, callAmount, totalPot, seat, table, profile,
      myPosition, totalActive, opponents, bigBlind, opts.allInOrFold === true
    );
    return limitBotRaiseWar(table, seat, pre, true, handStrength);
  }

  // ============================================================
  // POST-FLOP STRATEGY
  // ============================================================
  const post = postFlopStrategy(
    effectiveStrength, handStrength, callAmount, totalPot, potOdds,
    seat, table, profile, board, opponents, outs, bigBlind, numOpponents, oppCategory
  );
  return limitBotRaiseWar(table, seat, post, false, effectiveStrength);
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
  bigBlind: number,
  allInOrFold = false
): AIDecision {
  // 2026-07-07 AI overhaul: `handStrength` is now a real preflop PERCENTILE
  // (1.0 = AA, 0.85 = top 15%). Thresholds come from the solver-sized position
  // ranges (preflopRanges.ts), archetype-widened by ARCHETYPE_RANGE_FACTOR and
  // stack-adjusted by getStackDepthMultiplier — so the personalities derive from
  // ONE principled range instead of scattered magic literals, short stacks
  // tighten, and the vestigial openLimpFreq knob now actually matters.
  const params = ARCHETYPE_PARAMS[profile.archetype];
  const pctile = handStrength;
  const bucket = posBucket(position, totalActive);
  const factor = ARCHETYPE_RANGE_FACTOR[profile.archetype] ?? 1.0;
  const effBB = getEffectiveStackBB(table, seat.seatIndex);
  const stackMult = getStackDepthMultiplier(effBB);
  const huFactor = totalActive <= 2 ? 0.55 : 1.0; // heads-up plays FAR wider
  const facingRaise = callAmount > bigBlind;
  // GAME-9 (R2) — the table's own count of this round's raises: with each
  // opponent's LAST action only, two bots re-raising each other each saw "one
  // raise" forever and never reached the 4-bet / fold logic.
  const streetRaises = Number((table as any).raisesThisStreet) || 0;
  const facingThreeBet = Math.max(opponents.raiseCount, streetRaises) >= 2;
  // A re-raise is sized off the bet it faces (currentBetToMatch), not off the
  // increment still to call: "3x the call" made every 3-bet a near min-raise.
  const betToMatch = table.currentBetToMatch;
  const minRaise = table.getMinRaise();

  // Model-derived, archetype/stack/heads-up-adjusted thresholds (percentile scale).
  const openTh = adjustThreshold(adjustThreshold(adjustThreshold(OPEN_THRESHOLD[bucket], factor), stackMult), huFactor);
  const threeBetTh = adjustThreshold(adjustThreshold(THREEBET_THRESHOLD[bucket], factor), huFactor);
  const callVsRaiseTh = adjustThreshold(adjustThreshold(adjustThreshold(CALL_VS_RAISE_THRESHOLD[bucket], factor), stackMult), huFactor);
  const fourBetTh = FOURBET_THRESHOLD;

  const raiseOrAllIn = (amount: number): AIDecision =>
    Math.max(minRaise, amount) >= seat.chipCount
      ? { action: PlayerAction.AllIn, raiseAmount: 0 }
      : { action: PlayerAction.Raise, raiseAmount: Math.max(minRaise, amount) };

  // ── Short-stack push/fold: shove-or-fold from the BAKED Nash lookup
  //    (pushFoldSolver.ts — an offline-solved HU equilibrium, multiway-tightened
  //    and validated vs published charts). Replaces the old too-tight heuristic
  //    (which shoved only ~top 35% at 10bb; Nash is ~top 56%). The HU-vs-multiway
  //    axis is handled by the lookup itself (playersYetToAct), so we do NOT apply
  //    huFactor here — only the archetype `factor` as a personality overlay.
  //    Stations still flat; nobody limps a short stack. ──
  const playersYetToAct = Math.min(3, Math.max(1, totalActive - 1));
  // F49 (2026-10-21) — an All-In or Fold table plays this branch at ANY depth
  // and for every archetype (a call there is a shove too): the stack is read as
  // at most the deepest baked one, and a bet above the big blind is a shove to
  // CALL (the Nash call threshold), never one to re-shove over on push odds.
  const pfBB = allInOrFold ? Math.min(effBB, PUSH_FOLD_MAX_BB) : effBB;
  if (allInOrFold || (inPushFoldZone(effBB, playersYetToAct) && profile.archetype !== 'CALLING_STATION')) {
    const nashPush = nashPushPctile(pfBB, playersYetToAct);
    if (nashPush !== null) {
      if ((callAmount >= seat.chipCount && callAmount > 0) || (allInOrFold && callAmount > bigBlind)) {
        // Facing an all-in that covers us: use the Nash CALL threshold, not push.
        const callTh = adjustThreshold(nashCallPctile(pfBB, playersYetToAct), factor);
        return pctile >= callTh
          ? { action: PlayerAction.AllIn, raiseAmount: 0 }
          : { action: PlayerAction.Fold, raiseAmount: 0 };
      }
      const shoveTh = adjustThreshold(nashPush, factor);
      if (pctile >= shoveTh) return { action: PlayerAction.AllIn, raiseAmount: 0 };
      if (callAmount === 0) return { action: PlayerAction.Check, raiseAmount: 0 };
      return { action: PlayerAction.Fold, raiseAmount: 0 };
    }
  }

  // ── CALLING_STATION: calls almost everything, never raises. ──
  if (profile.archetype === 'CALLING_STATION') {
    if (callAmount === 0) return { action: PlayerAction.Check, raiseAmount: 0 };
    if (callAmount > seat.chipCount * 0.30 && pctile < 0.35) return { action: PlayerAction.Fold, raiseAmount: 0 };
    if (callAmount >= seat.chipCount) {
      return pctile >= 0.40 ? { action: PlayerAction.AllIn, raiseAmount: 0 } : { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // ── MANIAC: raises/3-bets almost anything. ──
  if (profile.archetype === 'MANIAC') {
    const wantRaise = pctile >= 0.15 || Math.random() < 0.55;
    if (wantRaise) {
      const target = callAmount === 0
        ? Math.round(bigBlind * (2.5 + Math.random() * 2.5))
        : Math.round(betToMatch * (2.5 + Math.random() * 1.5));
      if (Math.max(minRaise, target) >= seat.chipCount * 0.7) return { action: PlayerAction.AllIn, raiseAmount: 0 };
      return raiseOrAllIn(target);
    }
    if (callAmount === 0) return { action: PlayerAction.Check, raiseAmount: 0 };
    return pctile >= 0.30 ? { action: PlayerAction.Call, raiseAmount: 0 } : { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // ── FISH: loose-passive; LIMPS its playables (openLimpFreq), calls too wide. ──
  if (profile.archetype === 'FISH') {
    if (callAmount === 0) {
      if (pctile >= openTh && Math.random() >= params.openLimpFreq) return raiseOrAllIn(Math.round(bigBlind * 3));
      return { action: PlayerAction.Check, raiseAmount: 0 }; // limp / check back
    }
    if (pctile >= 0.90) return { action: PlayerAction.AllIn, raiseAmount: 0 };
    if (pctile >= adjustThreshold(0.55, factor) && callAmount <= seat.chipCount * 0.12) return { action: PlayerAction.Call, raiseAmount: 0 };
    if (pctile >= callVsRaiseTh) return { action: PlayerAction.Call, raiseAmount: 0 };
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // ── ROCK: tight-passive; calls down, almost never raises preflop. ──
  if (profile.archetype === 'ROCK') {
    if (callAmount === 0) {
      if (pctile >= adjustThreshold(0.94, huFactor)) return raiseOrAllIn(Math.round(bigBlind * 2.5));
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (pctile >= callVsRaiseTh) return { action: PlayerAction.Call, raiseAmount: 0 };
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // ── NIT: only premiums; folds to 3-bets without a 4-bet-worthy hand. ──
  if (profile.archetype === 'NIT') {
    if (callAmount === 0) {
      if (pctile >= openTh) return raiseOrAllIn(Math.round(bigBlind * 2.5));
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (facingThreeBet && pctile < fourBetTh) return { action: PlayerAction.Fold, raiseAmount: 0 };
    if (pctile >= fourBetTh) return { action: PlayerAction.AllIn, raiseAmount: 0 };
    if (pctile >= threeBetTh) return { action: PlayerAction.Call, raiseAmount: 0 };
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // ── LAG / TAG (aggressive, range-based): the default balanced path. LAG's
  // looser ARCHETYPE_RANGE_FACTOR automatically widens every threshold below. ──

  // No bet to face: open-raise in range, else check.
  if (callAmount === 0) {
    if (pctile >= openTh) {
      const mult = position < 3 ? 2.5 + Math.random() * 0.5 : 2.0 + Math.random() * 0.6;
      return raiseOrAllIn(roundToBB(Math.round(bigBlind * mult), bigBlind));
    }
    return { action: PlayerAction.Check, raiseAmount: 0 };
  }

  // Facing a 3-bet+: 4-bet premiums, flat strong, occasional 4-bet-bluff (expert).
  // GAME-9: a 4-bet is ~2.3x the 3-bet it faces (was 2.2x the whole pot).
  if (facingThreeBet) {
    if (pctile >= fourBetTh) return raiseOrAllIn(roundToBB(Math.round(betToMatch * 2.3), bigBlind));
    if (pctile >= threeBetTh) return { action: PlayerAction.Call, raiseAmount: 0 };
    if (profile.difficulty === 'expert' && Math.random() < profile.bluffFrequency * 0.3) {
      const target = roundToBB(Math.round(betToMatch * 2.2), bigBlind);
      if (Math.max(minRaise, target) <= seat.chipCount * 0.35) return raiseOrAllIn(target);
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // Facing a single raise: 3-bet, flat, or fold.
  if (facingRaise) {
    if (pctile >= threeBetTh) {
      // GAME-9: 3x the open it faces (was 3x the increment still to call).
      const target = roundToBB(Math.round(betToMatch * 3), bigBlind);
      return raiseOrAllIn(target);
    }
    if (pctile >= callVsRaiseTh) return { action: PlayerAction.Call, raiseAmount: 0 };
    // Cheap speculative flat in late position.
    if ((bucket === 'BTN' || bucket === 'CO') && pctile >= adjustThreshold(0.45, factor) && callAmount <= seat.chipCount * 0.06) {
      return { action: PlayerAction.Call, raiseAmount: 0 };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // Facing only the big blind (limped pot / SB complete): raise in range, else complete/fold.
  if (pctile >= openTh) {
    const target = roundToBB(Math.round(bigBlind * (2.5 + Math.random() * 0.5)), bigBlind);
    return raiseOrAllIn(target);
  }
  if (pctile >= callVsRaiseTh) return { action: PlayerAction.Call, raiseAmount: 0 };
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
  numOpponents: number,
  oppCategory: OpponentCategory
): AIDecision {
  const isRiver = table.currentPhase === GamePhase.River;
  const params = ARCHETYPE_PARAMS[profile.archetype];
  const oppNames = getActiveOpponentKeys(table, seat.seatIndex);   // R3 (GAME-P3-10) — player ids
  // GAME-9 (R2) — a RAISE facing a bet is sized off that bet: call it, then add
  // `fraction` of the pot after the call ("raise to"). The old totals (a pot
  // fraction alone) fell under the minimum re-raise as soon as the bets grew,
  // so every re-raise became a min-raise and two strong bots traded them
  // forever. With nothing to call this is the plain pot-fraction bet.
  const potAfterCall = totalPot + callAmount;
  const raiseTo = (fraction: number): number =>
    Math.max(table.getMinRaise(), table.currentBetToMatch + Math.round(potAfterCall * fraction));
  /** Chips a raise TO `total` takes from the stack (what it has already put in this round stays). */
  const chipsFor = (total: number): number => total - seat.currentBet;

  // 2026-07-07 AI overhaul — CROSS-STREET + EXPLOITATIVE reads:
  //  • streetCaution: later-street bets mean a stronger (multi-barrel) range, so
  //    require a touch more equity to continue (turn/river barrel respect).
  //  • callDownAdj: the once-dead callDownTendency knob now actually widens/
  //    narrows how light we call; we also call lighter vs a known maniac (bluffs).
  //  • stickyPool/foldyPool drive exploitative value/bluff deviations below.
  const streetCaution = isRiver ? 0.06 : (table.currentPhase === GamePhase.Turn ? 0.03 : 0);
  const callDownAdj = (params.callDownTendency - 0.5) * 0.20 + (oppCategory === 'maniac' ? 0.10 : 0);
  const stickyPool = oppCategory === 'station' || oppCategory === 'fish';
  const foldyPool = oppCategory === 'nit' || oppCategory === 'tag';

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
      const raiseSize = raiseTo(0.8 * params.betSizingMultiplier);
      if (chipsFor(raiseSize) >= seat.chipCount * 0.8) {
        return { action: PlayerAction.AllIn, raiseAmount: 0 };
      }
      if (chipsFor(raiseSize) <= seat.chipCount) {
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
      const raiseSize = raiseTo(0.7);
      if (chipsFor(raiseSize) <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
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
      const raiseSize = raiseTo(0.5);
      if (chipsFor(raiseSize) <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
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
      const raiseSize = raiseTo(0.6);
      if (chipsFor(raiseSize) <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
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
      const raiseSize = raiseTo(0.75 * params.betSizingMultiplier);
      if (chipsFor(raiseSize) >= seat.chipCount * 0.8) return { action: PlayerAction.AllIn, raiseAmount: 0 };
      if (chipsFor(raiseSize) <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    if (effectiveStrength > potOdds + 0.05) return { action: PlayerAction.Call, raiseAmount: 0 };
    // Bluff-raise occasionally
    if (Math.random() < params.bluffFreq && !isRiver) {
      const raiseSize = raiseTo(0.6);
      if (chipsFor(raiseSize) <= seat.chipCount * 0.4) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // TAG (default): balanced, adaptive, exploitative logic.
  // ============================================================
  // No bet to face: check or bet
  // ============================================================
  if (callAmount === 0) {
    const minRaise = table.getMinRaise();
    // Value bet — thinner vs sticky (station/fish) pools that call too much.
    const valueTh = stickyPool ? 0.58 : 0.65;
    if (effectiveStrength > valueTh) {
      const betSize = getGTOBetSize(rawStrength, totalPot, bigBlind, seat.chipCount, board, table.currentPhase, profile);
      if (betSize >= minRaise) return { action: PlayerAction.Raise, raiseAmount: betSize };
    }

    // Medium hand: mostly pot-control, but take a THIN VALUE bet when the wired
    // river logic says it's +EV (loose opponents, safe board, difficulty-scaled).
    if (effectiveStrength > 0.4) {
      if (shouldThinValueBet(rawStrength, table.currentPhase, board, oppNames, profile)) {
        const betSize = Math.max(minRaise, Math.round(totalPot * (0.33 + Math.random() * 0.12)));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }

    // Weak hand: BALANCED bluff decision (hand-strength band + board "story" +
    // opponent pool aware). This wires shouldBluffBalanced as the real bluff
    // engine, replacing the old raw coin-flip on effectiveBluffFreq.
    if (shouldBluffBalanced(rawStrength, board, table.currentPhase, profile, oppNames)) {
      // 2026-07-07 review fix: both map to getGTOBetSize's BIG (polarized) band,
      // and the semi-bluff value (0.9) is additionally overbet-eligible, so
      // semi-bluffs bet a touch bigger than pure bluffs (was inverted).
      const bluffSizeStrength = outs >= 8 ? 0.9 : 0.5;
      const betSize = getGTOBetSize(bluffSizeStrength, totalPot, bigBlind, seat.chipCount, board, table.currentPhase, profile);
      if (betSize >= minRaise && betSize <= seat.chipCount * 0.5) {
        return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
    }

    return { action: PlayerAction.Check, raiseAmount: 0 };
  }

  // ============================================================
  // Facing a bet: call, raise, or fold (adaptive continue threshold)
  // ============================================================
  const minRaise = table.getMinRaise();
  // Continue threshold: later-street barrels earn more respect (streetCaution);
  // callDownAdj widens it (high callDownTendency / vs a bluffy maniac); a foldy
  // (nit/tag) pool that is BETTING has a stronger range, so tighten vs them.
  const contTh = Math.max(0.25, 0.45 + streetCaution - callDownAdj + (foldyPool ? 0.06 : 0));

  // All-in decision (calling would commit most of the stack).
  if (callAmount >= seat.chipCount * 0.6) {
    if (effectiveStrength > 0.72 + streetCaution) return { action: PlayerAction.AllIn, raiseAmount: 0 };
    if (effectiveStrength > potOdds + 0.10 - callDownAdj) return { action: PlayerAction.AllIn, raiseAmount: 0 };
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }

  // Strong hand: value-raise (thinner vs sticky pools that pay off light).
  // GAME-9 (R2): the GTO-sized amount is added ON TOP of the bet being raised.
  const valueRaiseTh = stickyPool ? 0.70 : 0.75;
  if (effectiveStrength > valueRaiseTh) {
    const raiseSize = Math.max(minRaise, table.currentBetToMatch +
      getGTOBetSize(rawStrength, potAfterCall, bigBlind, seat.chipCount, board, table.currentPhase, profile));
    if (chipsFor(raiseSize) <= seat.chipCount) {
      return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // Medium hand: call if it clears pot odds OR the adaptive continue threshold.
  if (effectiveStrength > potOdds || effectiveStrength > contTh) {
    // Occasional merge/balanced raise with the top of the calling range.
    if (effectiveStrength > 0.6 && Math.random() < 0.3 * profile.aggressionFactor / 3) {
      const raiseSize = roundToBB(raiseTo(0.6), bigBlind);
      if (chipsFor(raiseSize) <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    return { action: PlayerAction.Call, raiseAmount: 0 };
  }

  // Drawing hands: call on a price; semi-bluff-raise the biggest draws.
  if (outs >= 8 && !isRiver) {
    if (callAmount <= totalPot * 0.35) return { action: PlayerAction.Call, raiseAmount: 0 };
    if (outs >= 12 && Math.random() < profile.aggressionFactor * 0.2) {
      const raiseSize = raiseTo(0.7);
      if (chipsFor(raiseSize) <= seat.chipCount * 0.4) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
    }
    if (callAmount <= seat.chipCount * 0.1) return { action: PlayerAction.Call, raiseAmount: 0 };
  }
  if (outs >= 4 && !isRiver && callAmount <= totalPot * 0.2) return { action: PlayerAction.Call, raiseAmount: 0 };

  // Balanced bluff-RAISE line, gated by shouldBluffBalanced — never into sticky
  // pools, more vs foldy ones. Not on the river (no fold-equity draws left).
  if (!isRiver && shouldBluffBalanced(rawStrength, board, table.currentPhase, profile, oppNames)) {
    if (board.hasHighCards || board.isPaired || board.isDry) {
      const raiseSize = raiseTo(0.6);
      if (chipsFor(raiseSize) <= seat.chipCount * 0.30) return { action: PlayerAction.Raise, raiseAmount: raiseSize };
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

/**
 * R3 (GAME-P3-10) — the profiles are keyed by the seat's PLAYER ID
 * (opponentModelKey: `user_<id>` for a human, a per-seat `ai-<uuid>` for a bot),
 * never by the display name: two players sharing a name ('Player', 'First L.',
 * a bot name from the pool at another table) shared ONE read, so a bot played a
 * nit's tendencies against a maniac. Bounded (least-recently-observed out) —
 * bot ids are new per seating, so the map would otherwise only grow.
 */
const OPPONENT_PROFILES: Map<string, OpponentSessionProfile> = new Map();
export const OPPONENT_PROFILES_CAP = 5000;

/** R3 (GAME-P3-10) — the opponent-model key of a seat: its playerId (the display name only for a seat without one). */
export function opponentModelKey(seat: { playerId?: string | null; playerName?: string | null }): string {
  return seat.playerId || seat.playerName || '';
}

function getOrCreateOpponentProfile(opponentKey: string): OpponentSessionProfile {
  let p = OPPONENT_PROFILES.get(opponentKey);
  if (p) {
    // Most recently observed last (Map order) — the eviction below drops the oldest.
    OPPONENT_PROFILES.delete(opponentKey);
  } else {
    p = {
      handsSeen: 0, vpipHands: 0, pfrHands: 0,
      threeBetsFaced: 0, threeBetFolds: 0,
      cbetsFaced: 0, cbetFolds: 0,
      showdownsReached: 0, showdownsWonWithBluff: 0,
      lastHandNumber: -1,
    };
    while (OPPONENT_PROFILES.size >= OPPONENT_PROFILES_CAP) {
      const oldest = OPPONENT_PROFILES.keys().next().value;
      if (oldest === undefined) break;
      OPPONENT_PROFILES.delete(oldest);
    }
  }
  OPPONENT_PROFILES.set(opponentKey, p);
  return p;
}

export function getOpponentProfile(opponentKey: string): OpponentSessionProfile | null {
  return OPPONENT_PROFILES.get(opponentKey) || null;
}

/** Profiles held right now (tests / diagnostics). */
export function opponentProfileCount(): number {
  return OPPONENT_PROFILES.size;
}

// External hook — index.ts calls it on the table's action events to build the
// session view. R3 (GAME-P3-10): `opponentKey` = opponentModelKey(seat).
export function recordOpponentObservation(
  opponentKey: string,
  observation: 'hand_start' | 'vpip' | 'pfr' | 'face_3bet' | 'fold_to_3bet' | 'face_cbet' | 'fold_to_cbet' | 'showdown',
  extra?: { bluffed?: boolean; handNumber?: number }
): void {
  if (!opponentKey) return;
  const p = getOrCreateOpponentProfile(opponentKey);
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

export function categorizeOpponent(opponentKey: string): OpponentCategory {
  const p = OPPONENT_PROFILES.get(opponentKey);
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
  opponentKeys: string[]
): boolean {
  if (handStrength > 0.75) return false;
  if (handStrength < 0.08) return false;
  let foldyCount = 0;
  let stickyCount = 0;
  for (const key of opponentKeys) {
    const cat = categorizeOpponent(key);
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
  opponentKeys: string[],
  profile: AIPlayerProfile
): boolean {
  if (phase !== GamePhase.River) return false;
  if (handStrength < 0.45 || handStrength > 0.68) return false;
  if (board.isMonotone || (board.isPaired && board.hasHighCards)) return false;
  const loose = opponentKeys.filter((k) => {
    const c = categorizeOpponent(k);
    return c === 'station' || c === 'fish' || c === 'lag';
  }).length;
  const tight = opponentKeys.filter((k) => categorizeOpponent(k) === 'nit').length;
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

/** Enumerate the non-folded opponents' opponent-model keys on a table.
 * 2026-07-07: includes AI seats too (was humans-only), so bot-vs-bot tables
 * also build reads and adapt to each other, not just humans.
 * R3 (GAME-P3-10): their opponentModelKey (player id), not their display names. */
export function getActiveOpponentKeys(table: PokerTable, mySeat: number): string[] {
  const keys: string[] = [];
  for (const s of table.seats) {
    if (s.seatIndex === mySeat) continue;
    if (s.state !== 'occupied' || s.folded || s.eliminated) continue;
    const key = opponentModelKey(s);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * 2026-07-07 AI overhaul: the single most decision-relevant opponent category
 * among the active opponents, preferring the strongest (foldiest→loosest) read.
 * Used to make equity range-aware and to drive exploitative deviations.
 */
export function dominantOpponentCategory(table: PokerTable, mySeat: number): OpponentCategory {
  const cats = getActiveOpponentKeys(table, mySeat).map(categorizeOpponent);
  // Priority: a known nit's aggression means the most; then tag; then the
  // exploitable loose types; 'unknown' only if nothing else is known.
  for (const want of ['nit', 'tag', 'lag', 'maniac', 'station', 'fish'] as OpponentCategory[]) {
    if (cats.includes(want)) return want;
  }
  return 'unknown';
}

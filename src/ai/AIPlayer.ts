import { Card, Rank, Suit } from '../game/Card';
import { evaluateHand, compareTo, HandRank, HandResult } from '../game/HandEvaluator';
import { evaluateOmahaHand, evaluateShortDeckHand, ShortDeckHandRank } from '../game/HandEvaluatorExtensions';
import { PokerTable, Seat, PlayerAction, GamePhase } from '../game/PokerTable';
import { calculateEquity, keptHoldemHoleCards } from '../training/TrainingEngine';
import {
  getPreflopPercentile, getStackOffPercentile, posBucket, PosBucket,
  OPEN_THRESHOLD, THREEBET_THRESHOLD, FOURBET_THRESHOLD, FOURBET_STACKOFF_THRESHOLD, CALL_VS_RAISE_THRESHOLD,
  ARCHETYPE_RANGE_FACTOR, adjustThreshold, PREMIUM_STACKOFF_THRESHOLD,
} from './preflopRanges';
import {
  inPushFoldZone, nashPushPctile, nashCallPctile, PUSH_FOLD_MAX_BB, stackOffCallWidth,
  aofPushPctile, aofCallPctile, AOF_OBS_PRIOR_HANDS,
} from './pushFoldSolver';
import {
  StudDrawKind, studDrawKindOf, isStudKind, studDrawEquity, firstRoundEquity, equityToPercentile, drawsLeftAt,
} from './studDrawStrength';
import { getShortDeckPreflopPercentile } from './shortDeckPreflop';
import { calibrateOmahaPreflop } from './omahaPreflopCalibration';
import { countOmahaDrawOuts } from '../training/fastOmahaEval';

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
 * seat holds 3 until its discard, and a bot never picks one: the engine's
 * no-pick fallback discards for it with the ONE keep rule
 * (pineappleKeep.pineappleDiscardIndex: before the flop the pair with the best
 * pre-flop percentile, 77K keeps 77; on the Crazy Pineapple flop, with `board`,
 * the card whose loss leaves the best hand). keptHoldemHoleCards applies the
 * same rule, so these are exactly the two cards the bot keeps (2026-11 bots
 * review B7; it priced the lowest-rank pair). calculateEquity / the pre-flop
 * percentile are only ever given two cards (a 7-card Stud hand fed to the
 * Hold'em Monte Carlo cost ~1s of blocking CPU per decision).
 */
export function holdemHoleCards(hole: Card[], board: Card[] = []): Card[] {
  return keptHoldemHoleCards(hole, board);
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
// 2026-11 (bots review, equity C6): 5- and 6-card hands go through
// calibrateOmahaPreflop, which maps them onto the 4-card distribution (they
// scored higher, so every threshold cleared 2-5 times the 4-card share).
export function getOmahaPreflopStrength(hole: Card[]): number {
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
  const u = score * 1.15 + 0.10;
  if (hole.length >= 5) {
    const m = calibrateOmahaPreflop(hole.length, u);
    if (isFinite(m)) return Math.max(0.10, Math.min(1, m));
  }
  return Math.max(0.10, Math.min(1, u));
}

/**
 * 2026-11 (bots review B1/B2/B11) — Stud / Draw hand strength from PUBLIC information
 * only: the bot's own cards, every opponent's FACE-UP cards (getFaceUpCards reads only
 * the face-up slots) and how many cards each holds. Never an opponent's down card, the
 * deck or the seed. First round: the percentile of the heads-up pot share among that
 * game's starting hands (the baked CDF in studDrawCdf.ts). Later rounds: the Monte
 * Carlo pot share vs the active opponents. Replaces the pre-2026-11 static variant
 * heuristic, which was not on the engine's hand order (AA-K folded to a Stud completion).
 */
function studDrawHandStrength(table: PokerTable, seatIndex: number, kind: StudDrawKind, firstRound: boolean): number {
  const t: any = table;
  const stud = isStudKind(kind);
  const mine = table.seats[seatIndex].holeCards;
  const up = (i: number): Card[] => (stud && typeof t.getFaceUpCards === 'function' ? t.getFaceUpCards(i) : []);
  const dead: Card[] = [];
  const opps: { known: Card[]; total: number; floor: number }[] = [];
  const streetBets = Number(t.raisesThisStreet) || 0;
  for (const s of table.seats) {
    if (s.seatIndex === seatIndex || s.state !== 'occupied' || s.holeCards.length === 0) continue;
    const vis = up(s.seatIndex);
    if (s.folded || s.eliminated) { dead.push(...vis); continue; }
    opps.push({ known: vis, total: s.holeCards.length, floor: firstRound ? 0 : studDrawRangeFloor(s, streetBets, t.lastAggressorSeat) });
  }
  const shared = stud ? [...table.communityCards] : [];
  const drawsLeft = stud ? 0 : drawsLeftAt(kind, table.currentPhase);
  if (firstRound) {
    const allDead = dead.concat(...opps.map((o) => o.known));
    return equityToPercentile(kind, firstRoundEquity(kind, mine, allDead, drawsLeft, BOT_EQUITY_BUDGET_MS));
  }
  return studDrawEquity({ kind, mine, dead, shared, opps, drawsLeft }, undefined, BOT_EQUITY_BUDGET_MS);
}

/**
 * 2026-11 (bots review B2) — how far an opponent's STARTING range is narrowed by HIS OWN
 * action this round (public): the bet / last raise 0.62 / 0.80 (Hold'em's facing-a-bet /
 * -raise floors), a caller 0.45, not yet in this round 0 — then his session read, as
 * Hold'em (nit +0.10, tag +0.05, station / fish -0.22, maniac -0.15). Per opponent rather
 * than Hold'em's one table-wide floor: a player who has not acted this round has shown
 * nothing yet.
 */
function studDrawRangeFloor(s: Seat, streetBets: number, lastAggressor: number): number {
  let f = 0;
  if (s.lastAction === PlayerAction.Raise || s.lastAction === PlayerAction.AllIn) f = streetBets >= 2 && s.seatIndex === lastAggressor ? 0.80 : 0.62;
  else if (s.lastAction === PlayerAction.Call) f = 0.45;
  if (f === 0) return 0;
  const cat = categorizeOpponent(opponentModelKey(s));
  if (cat === 'nit') f = Math.min(0.92, f + 0.10);
  else if (cat === 'tag') f = Math.min(0.88, f + 0.05);
  else if (cat === 'station' || cat === 'fish') f = Math.max(0, f - 0.22);
  else if (cat === 'maniac') f = Math.max(0, f - 0.15);
  return f;
}

/** 2026-11 (bots review B12) — the Hold'em street a Stud / Draw betting round plays like (identity elsewhere). */
export function holdemEquivalentStreet(phase: GamePhase, kind: StudDrawKind | null): GamePhase {
  if (!kind) return phase;
  switch (phase) {
    case GamePhase.FourthStreet: return GamePhase.Flop;
    case GamePhase.FifthStreet: case GamePhase.SixthStreet: return GamePhase.Turn;
    case GamePhase.SeventhStreet: return GamePhase.River;
    case GamePhase.Bet2: return kind === 'draw-hi' ? GamePhase.River : GamePhase.Flop;
    case GamePhase.Bet3: return GamePhase.Turn;
    case GamePhase.Bet4: return GamePhase.River;
    default: return phase;
  }
}

// ============================================================
// Post-flop hand strength with Monte Carlo equity
// ============================================================

export function getPostFlopStrength(
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
  shortDeck: boolean = false,
  // 2026-11 (bots review, equity hi-lo): Omaha Hi-Lo — the equity is the
  // expected share of a split pot (calculateEquity's hiLo), not a high-only win.
  hiLo: boolean = false
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
      BOT_EQUITY_BUDGET_MS, // GAME-8 (R2) — bounded think time
      hiLo
    );
    return equity / 100; // normalize to 0-1
  }

  // Medium/Easy use simplified evaluation
  const allCards = [...holeCards, ...communityCards];
  // 2026-11 (bots review B13): Short Deck ranks hands its own way (trips beat a
  // straight, a flush beats a full house, A-6-7-8-9 is a straight).
  if (shortDeck && !isOmaha) return shortDeckStaticStrength(allCards, communityCards);
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

/**
 * 2026-11 (bots review B13) — the medium/easy static strength for Short Deck:
 * the Hold'em ladder above re-slotted to the 6+ hand order under the engine's
 * own evaluateShortDeckHand (it ranked a straight above trips, a full house
 * above a flush, and missed A-6-7-8-9: A6 on 789 scored 0.16).
 */
function shortDeckStaticStrength(allCards: Card[], communityCards: Card[]): number {
  const r = evaluateShortDeckHand(allCards);
  const pv = r.primaryValue / Rank.Ace;
  let score: number;
  switch (r.handRank as number) {
    case ShortDeckHandRank.HighCard:      score = 0.08 + pv * 0.08; break;
    case ShortDeckHandRank.OnePair:       score = 0.22 + pv * 0.12; break;
    case ShortDeckHandRank.TwoPair:       score = 0.42 + pv * 0.08; break;
    case ShortDeckHandRank.Straight:      score = 0.58 + pv * 0.06; break;
    case ShortDeckHandRank.ThreeOfAKind:  score = 0.70 + pv * 0.04; break;
    case ShortDeckHandRank.FullHouse:     score = 0.78 + pv * 0.04; break;
    case ShortDeckHandRank.Flush:         score = 0.85 + pv * 0.04; break;
    case ShortDeckHandRank.FourOfAKind:   score = 0.93; break;
    case ShortDeckHandRank.StraightFlush: score = 0.97; break;
    case ShortDeckHandRank.RoyalFlush:    score = 1.00; break;
    default: score = 0.05;
  }
  // Playing the board (same rank and primary value as the 5 community cards) = very weak.
  if (communityCards.length >= 5) {
    const b = evaluateShortDeckHand(communityCards);
    if (b.handRank === r.handRank && b.primaryValue === r.primaryValue) score *= 0.4;
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

export function countOuts(holeCards: Card[], communityCards: Card[], omaha = false): number {
  if (communityCards.length === 0 || communityCards.length >= 5) return 0;
  // 2026-11 (bots review B14): Omaha plays exactly 2 hole + 3 board cards; the
  // Hold'em counter below pooled all 4-6 hole cards (mean 5.9-9.4 outs vs 2.9-5.0 true).
  if (omaha && holeCards.length > 2) return countOmahaDrawOuts(holeCards, communityCards);

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

  // 2026-11 fix: count the distinct RANKS that complete a straight (a 5-rank
  // window holding 4 of them). One rank = a gutshot (4 outs); two = an
  // open-ender or a double gutter (8 outs). Every gutshot used to score 8.
  const completing = new Set<number>();
  for (let start = 1; start <= 10; start++) {
    let have = 0;
    let missing = 0;
    for (let r = start; r < start + 5; r++) {
      if (ranks.has(r)) have++; else missing = r;
    }
    if (have === 4) completing.add(missing === 1 ? Rank.Ace : missing);
  }
  if (completing.size >= 2) outs += outs >= 9 ? 6 : 8;      // open-ended / double gutter (flush-draw overlap as before)
  else if (completing.size === 1) outs += outs >= 9 ? 3 : 4; // gutshot

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
  const d = decideActionForSeat(table, seatIndex, profile, opts);
  // Bots review fix round 2 (HAI-4): a bot never folds when checking is free, on
  // every variant and street. A raised pot can owe nothing (the straddler's
  // option; a raise voided when its maker left the table, F22's
  // lowerBetAfterOutOfTurnFold), and some strategy lines fold there.
  if (d.action === PlayerAction.Fold) {
    const seat = table.seats[seatIndex];
    if (seat && seat.state === 'occupied' && !seat.folded && !seat.allIn && table.getCallAmount(seat) === 0) {
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
  }
  return d;
}

function decideActionForSeat(
  table: PokerTable,
  seatIndex: number,
  profile: AIPlayerProfile,
  opts: DecideOptions,
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
  // 2026-11 (bots review, stud-draw B1/B2/B12): the Stud / Draw family's game, and —
  // Stud — the bot's own up cards (there is no community board to tell a story with).
  const sdKind: StudDrawKind | null = (isStudFamily || isDrawFamily || isDrawBet)
    ? (studDrawKindOf(variantId, table) ?? (isStudFamily ? 'stud-hi' : 'draw-hi')) : null;
  const myUpCards: Card[] = sdKind && isStudKind(sdKind) && typeof (table as any).getFaceUpCards === 'function'
    ? (table as any).getFaceUpCards(seatIndex) : [];
  const board = analyzeBoardTexture(table.communityCards);
  // B12 — Stud: the bot's own up cards are the board its bets tell a story with (postFlopStrategy
  // only: bluff / thin-value / sizing). decideAction's own wet-board penalty keeps `board`.
  const storyBoard = sdKind && isStudKind(sdKind) ? analyzeBoardTexture(myUpCards) : board;
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
  // 2026-11 (bots review B13 / hi-lo): Short Deck (6+) has its own hand order and
  // pre-flop table; Omaha Hi-Lo prices a split pot. OmahaTable(cfg, true, 6) has
  // the id 'omaha-6', so its public variant.isHiLo is read too.
  const isShortDeck = !isOmahaFamily && /short|six.?plus|6.?plus/i.test(variantId);
  const isHiLoSplit = isOmahaFamily && ((table as any).variant?.isHiLo === true || /hi.?lo/i.test(variantId));
  // 2026-11 — Hold'em pre-flop also reads the STACK-OFF percentile (4-bets, deep
  // all-ins). Never Omaha or Short Deck: null falls back to their own strength.
  let stackOff: number | null = null;
  if (sdKind) {
    // 2026-11 (bots review B1/B2/B11): the engine's own hand order, from public
    // information only — the first round as a PERCENTILE of that game's starting
    // hands (heads-up pot share vs a random holding, through the baked CDF: the
    // Hold'em percentile's definition), later rounds as the Monte Carlo pot share
    // vs the active opponents (Hold'em's post-flop equity), each opponent's
    // starting range narrowed by his own action.
    handStrength = studDrawHandStrength(table, seatIndex, sdKind, isPreFlop);
  } else if (isPreFlop) {
    // Omaha uses its pre-flop model (5/6 cards calibrated); Short Deck its own
    // equity-ranked table; Hold'em the equity-ranked percentile.
    handStrength = isOmahaFamily
      ? getOmahaPreflopStrength(seat.holeCards)
      : isShortDeck ? (getShortDeckPreflopPercentile(seat.holeCards) || getPreFlopHandRank(seat.holeCards))
      : getPreFlopHandRank(holdemHoleCards(seat.holeCards));
    if (!isOmahaFamily && !isShortDeck) stackOff = getStackOffPercentile(holdemHoleCards(seat.holeCards));
  } else {
    // GAME-8 — the Hold'em equity is never fed more than 2 hole cards: a
    // (Crazy) Pineapple seat still holding 3 is priced on the 2 it keeps
    // (board-aware on the Crazy Pineapple flop: B7).
    handStrength = getPostFlopStrength(
      isOmahaFamily ? seat.holeCards : holdemHoleCards(seat.holeCards, table.communityCards),
      table.communityCards, numOpponents, profile.difficulty,
      isOmahaFamily, oppMinPctile, isShortDeck, isHiLoSplit
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

  // 2026-11 (bots review fix round 2): the first-round strength BEFORE the
  // difficulty noise, for the decisions a premium hand must never get wrong.
  const rawStrength = isFinite(handStrength) ? Math.max(0, Math.min(1, handStrength)) : 0.3;
  const rawStackOff = stackOff;

  // Difficulty-based noise (expert has almost none)
  const noiseMap: Record<Difficulty, number> = {
    easy: 0.25, medium: 0.12, hard: 0.05, expert: 0.02
  };
  const rawNoise = (Math.random() - 0.5) * noiseMap[profile.difficulty];
  const noise = isFinite(rawNoise) ? rawNoise : 0;
  handStrength = Math.min(1.0, Math.max(0.0, handStrength + noise));
  if (stackOff !== null) stackOff = Math.min(1.0, Math.max(0.0, stackOff + noise));   // same noise draw

  // Outs and implied odds for draw decisions. 2026-11: Stud / Draw equity already
  // prices every card still to come (and the 8-handed shared 7th-street card made
  // countOuts count a dead "draw"); Omaha counts exact 2+3 outs (B14); Hold'em-style
  // tables count the two cards they keep.
  const outs = (isPreFlop || sdKind || isStudFamily || isDrawFamily || isDrawBet) ? 0 : countOuts(isOmahaFamily ? seat.holeCards : holdemHoleCards(seat.holeCards, table.communityCards), table.communityCards, isOmahaFamily);
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
  const impliedTerm = impliedOdds * (mcTier ? 0.35 : 1.0);
  // 2026-11 (bots review, "dead adjustments"): the hard/expert adjustments below
  // change the RAW strength only (rawStrength: getGTOBetSize, shouldBluffBalanced,
  // shouldThinValueBet; and pre-flop the percentile). The DECISION strength is
  // taken before them ON PURPOSE: hard/expert strength is Monte Carlo equity
  // (calculateEquity) already run against every live opponent (numOpponents) and
  // an action-narrowed range (oppMinPctile), so x0.92 multiway / x0.85 wet /
  // -0.05 aggression would count the same thing twice. Stud / draw strengths are
  // the same kind of Monte Carlo pot share vs the active opponents
  // (studDrawHandStrength), so they stay out of the decision there too; `board`
  // stays the community cards (the bot's own up cards go to postFlopStrategy only).
  const preAdjustStrength = handStrength;

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
  const effectiveStrength = preAdjustStrength + impliedTerm;   // == 0dc1b96 for every variant

  // ============================================================
  // PREFLOP STRATEGY
  // ============================================================
  // GAME-9 (R2) — every decision passes the raise-war limiter last.
  if (isPreFlop) {
    // 2026-11 — Stud (Third Street) and draw first rounds have their own routing
    // (studDrawFirstRound: no blinds in Stud, a completion is a raise, fixed-limit
    // has no push/fold); Hold'em / Omaha / Short Deck / Pineapple use preFlopStrategy.
    const pre = sdKind
      ? studDrawFirstRound(
        handStrength, callAmount, totalPot, seat, table, profile,
        myPosition, totalActive, opponents, bigBlind, opts.allInOrFold === true, isStudKind(sdKind) ? 'stud' : 'draw',
        { liveOpponents: numOpponents, rawPctile: rawStrength })
      : preFlopStrategy(
        handStrength, callAmount, totalPot, seat, table, profile,
        myPosition, totalActive, opponents, bigBlind, opts.allInOrFold === true,
        { liveOpponents: numOpponents, stackOff, rawPctile: rawStrength, rawStackOff });
    return limitBotRaiseWar(table, seat, pre, true, handStrength);
  }

  // ============================================================
  // POST-FLOP STRATEGY
  // ============================================================
  const post = postFlopStrategy(
    effectiveStrength, handStrength, callAmount, totalPot, potOdds,
    seat, table, profile, storyBoard, opponents, outs, bigBlind, numOpponents, oppCategory,
    holdemEquivalentStreet(table.currentPhase, sdKind)
  );
  return limitBotRaiseWar(table, seat, post, false, effectiveStrength);
}

// ============================================================
// Preflop decision logic
// ============================================================

// 2026-11 pre-flop fix round (bots review 11-04: NEW-1, B4, B5, B8, B9, B16, NEW-3..5, CS).
/** A pre-flop CALL of at least this share of the chips behind is a stack-off (continue = all-in). */
export const STACKOFF_COMMIT_FRACTION = 1 / 3;
/** A pre-flop RAISE to at least this share of the street stack is made as an all-in instead. */
export const RAISE_JAM_FRACTION = 0.6;
/** The open size (in BB) the facing-a-raise thresholds were tuned against (no-limit). */
export const OPEN_REFERENCE_BB = 3;
/** A raise smaller than the reference widens the CALL range by at most this factor (never the 3-bet range). */
export const SIZE_WIDEN_MAX = 1.3;
/**
 * HAI-2 (bots review fix round 2) — a raise bigger than the reference narrows a CALL range to
 * no fewer than the top ~5.4% (77+, AJs+, AKo: the AKo .95023 / AQo .94118 gap). The
 * 3-bet line keeps narrowing; the value set is held whatever the size (preFlopStrategy).
 */
export const SIZE_NARROW_MAX_TH = 0.946;
/**
 * Fix round 3 (review of HAI-2) — from a call of this share of the commit line
 * (STACKOFF_COMMIT_FRACTION: 1/2 x 1/3 = a sixth of the stack) the size floor slides linearly
 * to the stack-off width at the depth, which is what the call faces at the commit line. A
 * 30-33 BB open at 100 BB was flatted with 77 / AJs (5.6%) and the range fell to the stack-off
 * 3.5% at 34 BB; it now narrows smoothly into it.
 */
export const SIZE_FLOOR_TAPER_FROM = 0.5;
/** HAI-1 — the multiway count the stack-off and all-in call widths were tuned for (0dc1b96's min(3, ...)): more players count as this many. */
export const CALL_WIDTH_MAX_PLAYERS = 3;
/** B8 — share of its own opening range an opener keeps vs a 3-bet, by the price it is laid. */
export const DEF3B_KEEP_AT_MIN = 0.60;   // at DEF3B_MIN_NEED needed equity (a min 3-bet ~ 19%)
export const DEF3B_MIN_NEED = 0.19;
export const DEF3B_SLOPE = 1.15;         // less per unit of extra needed equity
export const DEF3B_KEEP_MAX = 0.75;
/** CALLING_STATION — unopened it plays adjustThreshold(CS_PLAY_BASE) (~56%); it calls CS_CALL_WIDTH of hands vs a standard raise. */
export const CS_PLAY_BASE = 0.55;
export const CS_CALL_WIDTH = 0.60;
/**
 * A call that CLOSES the action against an all-in at this needed equity or less (a micro all-in) is always made.
 * HAI-3 (fix round 2): per opponent in the pot — the cutoff is MICRO_CALL_NEED / the live opponents.
 */
export const MICRO_CALL_NEED = 0.25;
/**
 * Fix round 3 (All-In or Fold economy) — in All-In or Fold every decision is a stack-off, so an
 * archetype's range factor applies as factor ^ AOF_ARCHETYPE_DAMP there (MANIAC 0.60 -> 0.77, FISH
 * 0.78 -> 0.88, NIT 1.10 -> 1.05): the personalities stay, at half the width spread. The full spread
 * (a MANIAC shoving and calling 1.67x the table's widths) was a large leak: alone, this damping took
 * a position-aware human from +6.5% to +3.3% per game and the best one found from +8.7% to +6.5%.
 */
export const AOF_ARCHETYPE_DAMP = 0.5;
/**
 * Fix round 3 (All-In or Fold economy) — in All-In or Fold the difficulty noise on the strength
 * applies at this share of its amplitude (easy +-0.125 -> +-0.0625, medium +-0.06 -> +-0.03, hard
 * +-0.025 -> +-0.0125). Every All-In or Fold decision is one shove / call line for the whole stack,
 * so each noise draw past the line was a whole-stack mistake. With both, the best human strategy
 * found (position-aware shoves, tighter calls with players behind) measures ~+3.8% per game (100k
 * games, 20/40, 1,000 chips, live mix), the fixed .85 / .88 one ~-0.5%, a hard bot ~+1.8%.
 */
export const AOF_NOISE_KEEP = 0.5;

export interface PreflopCtx {
  /** Live (not folded) opponents in the hand: the players who can still call a shove or are in it (B16). */
  liveOpponents: number;
  /** Hold'em-family stack-off percentile (getStackOffPercentile + the same noise); null = use the strength itself. */
  stackOff: number | null;
  /** The strength before the difficulty noise (undefined = the noisy strength). */
  rawPctile?: number;
  /** The stack-off percentile before the difficulty noise (undefined = the noisy one). */
  rawStackOff?: number | null;
}

/** Stud / draw first-round context: who is live, and the strength before the difficulty noise. */
export interface StudDrawFirstCtx {
  /** Live (not folded) opponents in the hand. */
  liveOpponents: number;
  /** The first-round percentile before the difficulty noise. */
  rawPctile: number;
}

/** NEW-1 — a seat's stack at the START of this hand (what it holds + what it has put in). */
export function handStartStack(s: Seat): number {
  return (s.chipCount || 0) + (s.totalInvestedThisHand || 0);
}

/** NEW-1 — the live opponent whose ALL-IN set the bet this seat faces (null when the bet was made by a seat with chips left). */
export function shoverFaced(table: PokerTable, seat: Seat): Seat | null {
  if (table.getCallAmount(seat) <= 0) return null;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.allIn && s.currentBet === table.currentBetToMatch) return s;
  }
  return null;
}

/** B8 — raises this seat has made on the current street (its own open / 3-bet), from the table's action log. */
function ownRaisesThisStreet(table: PokerTable, seat: Seat): number {
  let n = 0;
  for (const e of table.actionLog) {
    if (e.street === table.currentPhase && e.seatIndex === seat.seatIndex && OWN_RAISE_RE.test(e.action)) n++;
  }
  return n;
}

/**
 * 2026-11 (bots review, economy E3, All-In or Fold): the width the all-in player
 * is read to shove. It is the AoF push width for the seat he shoved from (the
 * players behind him then), blended with his VPIP observed this game at
 * AOF_OBS_PRIOR_HANDS hands of prior weight. Every voluntary AoF action is an
 * all-in. The opponent model is the existing session feed (index.ts
 * ensureTableProgressListener); quick tables seat player-<uuid>, so a read
 * starts empty each game. Public information only (seats, the action feed).
 */
function aofShoverWidth(table: PokerTable, shover: Seat | null, effBB: number): number {
  const huW = 1 - (nashPushPctile(effBB, 1) ?? 0.9);
  if (!shover) return huW;   // = the heads-up Nash call (the pre-2026-11 behaviour)
  const sp = seatPositions(table, shover.seatIndex);
  const prior = 1 - (aofPushPctile(effBB, Math.max(1, sp.total - 1 - sp.preflop)) ?? 1 - huW);
  const obs = getOpponentProfile(opponentModelKey(shover));
  return obs && obs.handsSeen > 0 ? (obs.vpipHands + AOF_OBS_PRIOR_HANDS * prior) / (obs.handsSeen + AOF_OBS_PRIOR_HANDS) : prior;
}

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
  allInOrFold = false,
  ctx: PreflopCtx = { liveOpponents: Math.max(1, totalActive - 1), stackOff: null },
): AIDecision {
  const params = ARCHETYPE_PARAMS[profile.archetype];
  const noLimit = table.bettingStructure === 'no-limit';
  // Bots review fix round 2 (HAI-1 / HAI-2) — the VALUE set: JJ+, AKs, AKo (stack-off
  // percentile >= FOURBET_STACKOFF_THRESHOLD) judged BEFORE the difficulty noise, which can
  // lift its strength but never lower it. Short Deck (no-limit, no stack-off scale) reads
  // its own percentile (value AA-QQ, premium AA); pot-limit Omaha is not held.
  const rawValue = ctx.rawStackOff ?? (noLimit && ctx.stackOff === null ? ctx.rawPctile ?? null : null);
  const valueHand = rawValue !== null && rawValue >= FOURBET_STACKOFF_THRESHOLD;
  const pctile = valueHand ? Math.max(handStrength, ctx.rawPctile ?? handStrength) : handStrength;
  const bucket = posBucket(position, totalActive);
  const factor = ARCHETYPE_RANGE_FACTOR[profile.archetype] ?? 1.0;
  const effBB = getEffectiveStackBB(table, seat.seatIndex);   // NEW-1: start-of-hand stacks
  const stackMult = getStackDepthMultiplier(effBB);
  const huFactor = totalActive <= 2 ? 0.55 : 1.0;
  const streetRaises = Number((table as any).raisesThisStreet) || 0;
  // B5 / B9 — routed by the table's own count of VOLUNTARY raises this street
  // (blinds are not raises). Every seat but the big blind faces a call of one
  // big blind in an unopened pot; the big blind facing a min-raise faces one too.
  const unopened = streetRaises === 0;
  const facingRaise = streetRaises >= 1 && callAmount > 0;
  const facingThreeBet = Math.max(opponents.raiseCount, streetRaises) >= 2;
  const betToMatch = table.currentBetToMatch;
  const minRaise = table.getMinRaise();
  // Hold'em: value 4-bets and deep stack-offs read the stack-off percentile (QQ+/AK on top);
  // Omaha keeps its own strength on the old vs-random threshold.
  const so = valueHand ? Math.max(ctx.stackOff ?? pctile, rawValue as number) : ctx.stackOff ?? pctile;
  const fourBetValue = ctx.stackOff !== null ? so >= FOURBET_STACKOFF_THRESHOLD : pctile >= FOURBET_THRESHOLD;

  // Model-derived, archetype/stack/heads-up-adjusted thresholds (percentile scale) — unchanged.
  const openTh = adjustThreshold(adjustThreshold(adjustThreshold(OPEN_THRESHOLD[bucket], factor), stackMult), huFactor);
  const threeBetTh = adjustThreshold(adjustThreshold(THREEBET_THRESHOLD[bucket], factor), huFactor);
  const callVsRaiseTh = adjustThreshold(adjustThreshold(adjustThreshold(CALL_VS_RAISE_THRESHOLD[bucket], factor), stackMult), huFactor);

  // B4 / NEW-4 — the size of the bet faced: a bigger bet narrows every call and
  // 3-bet range in proportion (REF / size); a smaller one widens CALLS only.
  // No-limit only (Hold'em, Short Deck, Pineapple): pot-limit Omaha cannot be raised past the pot
  // pre-flop and keeps its tuned ranges. Only the big blind (last to act, best price) widens vs a
  // small raise (NEW-4); every seat narrows vs a big one (noLimit: above).
  // A UTG straddle is this hand's effective big blind (PokerTable.straddle): the reference open is 3 straddles.
  const refBB = table.actionLog.some(e => e.street === table.currentPhase && e.action === 'straddle') ? 2 * bigBlind : bigBlind;
  const sizeFactor = facingRaise && noLimit
    ? Math.min(bucket === 'BB' ? SIZE_WIDEN_MAX : 1, (OPEN_REFERENCE_BB * refBB) / Math.max(betToMatch, refBB))
    : 1;
  const sized = (th: number, f: number): number => (f === 1 ? th : Math.min(0.99, Math.max(0.30, 1 - (1 - th) * f)));
  const callVsRaiseThS = sized(callVsRaiseTh, sizeFactor);
  const threeBetThS = sized(threeBetTh, Math.min(1, sizeFactor));
  // HAI-2 — a CALL line (th: sized; base: unscaled) is never narrowed past SIZE_NARROW_MAX_TH (it
  // was pushed to the 0.96-0.99 noise band of AA/KK), nor widened by it. Fix round 3: where the
  // stack-off line at this depth is narrower than that floor (deep stacks, ~36 BB+ multiway), from
  // a call of SIZE_FLOOR_TAPER_FROM of the commit line the floor rises to it and the strength it
  // reads slides to the stack-off percentile (so): at a third of the stack it is the stack-off
  // decision, with no cliff and no 77 / AJs flat of 30 BB. Shallower, nothing changes.
  const commitShare = noLimit && callAmount > 0 ? callAmount / Math.max(1, seat.chipCount * STACKOFF_COMMIT_FRACTION) : 0;
  const soLineTh = commitShare > SIZE_FLOOR_TAPER_FROM
    ? adjustThreshold(1 - stackOffCallWidth(effBB, Math.min(CALL_WIDTH_MAX_PLAYERS, Math.max(1, ctx.liveOpponents))), factor)
    : 0;
  const floorTaper = soLineTh > SIZE_NARROW_MAX_TH
    ? Math.min(1, (commitShare - SIZE_FLOOR_TAPER_FROM) / (1 - SIZE_FLOOR_TAPER_FROM))
    : 0;
  const sizeFloorTh = SIZE_NARROW_MAX_TH + floorTaper * (soLineTh - SIZE_NARROW_MAX_TH);
  const callsSized = (th: number, base: number): boolean => {
    const floorTh = Math.max(base, sizeFloorTh);
    return th <= floorTh ? pctile >= th : pctile + floorTaper * (so - pctile) >= floorTh;
  };

  const raiseOrAllIn = (amount: number): AIDecision => {
    const to = Math.max(minRaise, amount);
    // No-limit only: a pot-limit "all-in" is capped at a pot raise by the engine, so PLO keeps 0dc1b96 sizing.
    return to >= seat.chipCount || (noLimit && to >= (seat.chipCount + seat.currentBet) * RAISE_JAM_FRACTION)
      ? { action: PlayerAction.AllIn, raiseAmount: 0 }
      : { action: PlayerAction.Raise, raiseAmount: to };
  };
  const CHECK: AIDecision = { action: PlayerAction.Check, raiseAmount: 0 };
  const CALL: AIDecision = { action: PlayerAction.Call, raiseAmount: 0 };
  const ALLIN: AIDecision = { action: PlayerAction.AllIn, raiseAmount: 0 };

  // B16 — the players who can still call / are in: every live opponent (UTG
  // 6-handed: 5; the small blind folded to: 1). Used where B16 was measured
  // (unopened pots) and where the bot is alone against all-in player(s).
  const pyta = Math.max(1, ctx.liveOpponents);
  // Every other spot (facing a raise that is not a lone all-in) keeps the
  // 0dc1b96 seat-independent count, so its push/fold zone membership is unchanged.
  const headPyta = Math.min(3, Math.max(1, totalActive - 1));
  // NEW-1 — the all-in that SET the bet this seat faces, and the depth at risk
  // against it (min of the two hand-start stacks), never the shover's 0 left.
  const shover = callAmount > 0 ? shoverFaced(table, seat) : null;
  const shoveBB = shover ? Math.max(1, Math.round(Math.min(handStartStack(seat), handStartStack(shover)) / bigBlind)) : 0;
  // Review fix — price a spot as "calling the shove" ONLY when nobody else can
  // still act: pureCall = a call closes the action; pureAllInCall = no other live
  // opponent has chips (it is this seat against the all-in player(s) alone).
  // A short all-in with deep players still to act is routed like any other raise.
  let othersWithChips = 0, othersToAct = 0;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated || s.allIn || s.chipCount <= 0) continue;
    othersWithChips++;
    if (s.currentBet < table.currentBetToMatch) othersToAct++;
  }
  const pureCall = !!shover && othersToAct === 0;
  const pureAllInCall = !!shover && othersWithChips === 0;
  const zonePlayers = unopened || pureAllInCall ? pyta : headPyta;
  // HAI-1 — every call width below (stack-off, Nash call, All-In or Fold call) counts at most
  // CALL_WIDTH_MAX_PLAYERS: past 3 the +0.05-per-player Nash call hit its 0.99 cap (only AA/KK
  // continued at 20-25 BB, AKo 0%, vs JJ+/AK at 26 BB) and the All-In or Fold call reached 0.986.
  const callPyta = Math.min(CALL_WIDTH_MAX_PLAYERS, pyta);

  // HAI-1 / HAI-2 — the fold exit: every fold below returns FOLD. A value hand never folds to a
  // single bet (one opponent in for it: an open of any size, a 3-bet, a 4-bet, a shove), and AA /
  // KK never fold at all; they continue instead (all-in when the call is a stack-off). With two or
  // more opponents already in for the bet, QQ / JJ / AK play the stack-off ranges like any hand
  // (on their pre-noise strength).
  let inForBet = 0;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.allIn || s.currentBet >= table.currentBetToMatch) inForBet++;
  }
  const held = valueHand && callAmount > 0 && ((rawValue as number) >= PREMIUM_STACKOFF_THRESHOLD || inForBet <= 1);
  const FOLD: AIDecision = !held ? { action: PlayerAction.Fold, raiseAmount: 0 }
    : allInOrFold || callAmount >= seat.chipCount ? ALLIN
    : pureCall ? CALL
    : noLimit && callAmount >= seat.chipCount * STACKOFF_COMMIT_FRACTION ? ALLIN
    : CALL;

  // Price floor — a micro all-in that this call closes is called with any two cards: at most
  // MICRO_CALL_NEED of equity needed PER OPPONENT in the pot (the big blind vs a 1.5 BB shove
  // needs 14%). HAI-3: 0.25 flat let three 100 BB all-ins' dead money price in 72o (24.7%
  // needed; 72o has 12-15% 4-way); at 0.25 / 3 = 8.3% it never fires there.
  if (shover && table.bettingStructure !== 'fixed-limit' && (allInOrFold ? pureAllInCall : pureCall)
      && callAmount / (totalPot + callAmount) <= MICRO_CALL_NEED / pyta) {
    return allInOrFold || callAmount >= seat.chipCount ? ALLIN : CALL;
  }

  // ── Short-stack push/fold (and every All-In or Fold decision): the baked Nash lookup. ──
  const pfBB = allInOrFold ? Math.min(pureAllInCall ? shoveBB : effBB, PUSH_FOLD_MAX_BB) : effBB;
  if (allInOrFold || (inPushFoldZone(effBB, zonePlayers) && profile.archetype !== 'CALLING_STATION')) {
    const nashPush = nashPushPctile(pfBB, zonePlayers);
    const pfFactor = allInOrFold ? Math.pow(factor, AOF_ARCHETYPE_DAMP) : factor;
    // All-In or Fold: the strength with AOF_NOISE_KEEP of the difficulty noise (the value set never below its raw strength).
    const pfP = allInOrFold && ctx.rawPctile !== undefined
      ? Math.max(ctx.rawPctile + (handStrength - ctx.rawPctile) * AOF_NOISE_KEEP, valueHand ? ctx.rawPctile : 0)
      : pctile;
    if (nashPush !== null) {
      if (pureAllInCall || (callAmount >= seat.chipCount && callAmount > 0) || (allInOrFold && callAmount > bigBlind)) {
        const callBB = pureAllInCall ? Math.min(shoveBB, pfBB) : pfBB;
        // E3 (All-In or Fold only): call vs the range the shover is read to shove
        // from his seat (and his observed VPIP), narrower with more players live.
        const callTh = adjustThreshold(allInOrFold
          ? aofCallPctile(callBB, aofShoverWidth(table, shover, callBB), callPyta - 1)
          : nashCallPctile(callBB, Math.min(CALL_WIDTH_MAX_PLAYERS, zonePlayers)), pfFactor);
        return pfP >= callTh ? ALLIN : FOLD;
      }
      // E3 (All-In or Fold only): the open-shove width shrinks x0.7 per extra player behind.
      const shoveTh = adjustThreshold(allInOrFold ? (aofPushPctile(pfBB, zonePlayers) ?? nashPush) : nashPush, pfFactor);
      if (pfP >= shoveTh) return ALLIN;
      if (callAmount === 0) return CHECK;
      return FOLD;
    }
  }

  // ── NEW-1 / B4 / NEW-5 — STACK-OFF: facing an all-in, or a call that commits a
  //    third of the stack. Continue only with the stack-off range for the depth
  //    actually at risk (the baked Nash call up to 25 BB, then top 17% -> 6% at
  //    100 BB+, tighter with more players in); continuing = calling the all-in /
  //    moving in. Every archetype, CALLING_STATION and MANIAC included. ──
  const committing = callAmount > 0 && callAmount >= seat.chipCount * STACKOFF_COMMIT_FRACTION;
  // HAI-1 — up to 25 BB the Nash call is never narrower than the deep width at the 25 BB anchor
  // (with 3 players in, 0.93 vs 0.915: 23-25 BB continued less than 26 BB).
  const stackOffOK = (depthBB: number): boolean => depthBB <= PUSH_FOLD_MAX_BB
    ? pctile >= adjustThreshold(Math.min(nashCallPctile(depthBB, callPyta), 1 - stackOffCallWidth(depthBB, callPyta)), factor)
    : so >= adjustThreshold(1 - stackOffCallWidth(depthBB, callPyta), factor);
  // No-limit only (Hold'em, Short Deck, Pineapple): pot-limit Omaha keeps its 0dc1b96 commit ranges
  // (its NEW-1 case, the push/fold zone misfire, is fixed by the hand-start effective stack above).
  if (!allInOrFold && noLimit && (pureCall || committing)) {
    if (!stackOffOK(pureCall ? shoveBB : effBB)) return FOLD;
    return pureCall && callAmount < seat.chipCount ? CALL : ALLIN;
  }
  /** A re-raise; when it would be a jam it must pass the stack-off range too (null = not this hand: fall through). */
  const raiseOrJam = (amount: number): AIDecision | null => {
    const d = raiseOrAllIn(amount);
    return d.action === PlayerAction.AllIn && noLimit && !stackOffOK(effBB) ? null : d;
  };

  // ── CALLING_STATION: loose and passive — plays ~56% unopened, calls ~60% vs a
  //    standard raise, narrowing with the size; never raises. (Was 100% of hands.) ──
  if (profile.archetype === 'CALLING_STATION') {
    if (callAmount === 0) return CHECK;
    if (unopened) return pctile >= adjustThreshold(CS_PLAY_BASE, factor) ? CALL : FOLD;
    return callsSized(Math.max(0.30, 1 - CS_CALL_WIDTH * sizeFactor), 1 - CS_CALL_WIDTH) ? CALL : FOLD;
  }

  // ── MANIAC: raises/3-bets almost anything — but a raise that would be a jam is a
  //    stack-off (NEW-5: it called 100 BB off with 91% of hands). ──
  if (profile.archetype === 'MANIAC') {
    const wantRaise = pctile >= 0.15 || Math.random() < 0.55;
    if (wantRaise) {
      const target = callAmount === 0
        ? Math.round(bigBlind * (2.5 + Math.random() * 2.5))
        : Math.round(betToMatch * (2.5 + Math.random() * 1.5));
      if (!noLimit) {   // pot-limit: 0dc1b96 exactly (an all-in there is a pot raise)
        if (Math.max(minRaise, target) >= seat.chipCount * 0.7) return ALLIN;
        return raiseOrAllIn(target);
      }
      const r = raiseOrJam(target);
      if (r) return r;
    }
    if (callAmount === 0) return CHECK;
    return pctile >= 0.30 ? CALL : FOLD;
  }

  // ── FISH: loose-passive; LIMPS its playables (openLimpFreq), calls too wide. ──
  if (profile.archetype === 'FISH') {
    if (callAmount === 0) {   // the big blind option: unchanged
      if (pctile >= openTh && Math.random() >= params.openLimpFreq) return raiseOrAllIn(Math.round(bigBlind * 3));
      return CHECK;
    }
    if (unopened) {
      // B5 — the hands it used to SHOVE for 100 BB (top 10%) are now a 3 BB raise;
      // the rest of its range limps as before (same VPIP and PFR).
      if (pctile >= 0.90) return raiseOrAllIn(Math.round(bigBlind * 3));
      return pctile >= adjustThreshold(0.55, factor) ? CALL : FOLD;   // limp
    }
    // Its "weird raise": a 3-bet, not a 100 BB jam; never a 4-bet.
    if (!facingThreeBet && pctile >= 0.90) { const r = raiseOrJam(roundToBB(Math.round(betToMatch * 3), bigBlind)); if (r) return r; }
    if (pctile >= adjustThreshold(0.55, factor) && callAmount <= seat.chipCount * 0.12) return CALL;
    if (callsSized(callVsRaiseThS, callVsRaiseTh)) return CALL;
    return FOLD;
  }

  // ── ROCK: tight-passive; limps its playables, RAISES only premiums. ──
  if (profile.archetype === 'ROCK') {
    if (unopened) {
      // B5 — premiums raise from ANY seat (AA used to be limped everywhere but the big blind).
      if (pctile >= adjustThreshold(0.94, huFactor)) return raiseOrAllIn(Math.round(bigBlind * 2.5));
      if (callAmount === 0) return CHECK;
      return pctile >= callVsRaiseTh ? CALL : FOLD;                  // limp (unchanged range)
    }
    return callsSized(callVsRaiseThS, callVsRaiseTh) ? CALL : FOLD;
  }

  // ── NIT: only premiums; folds to 3-bets without a 4-bet-worthy hand. ──
  if (profile.archetype === 'NIT') {
    if (unopened) {
      // B5 — a normal open from ANY seat (was a 100 BB shove with AA-88), never a limp.
      // Off the big blind it opens the range it already played there (its 3-bet
      // range: ~6% EP to ~11% BTN); the big blind keeps its old raise range.
      const nitOpenTh = callAmount === 0 ? openTh : Math.max(openTh, threeBetTh);
      if (pctile >= nitOpenTh) return raiseOrAllIn(Math.round(bigBlind * 2.5));
      return callAmount === 0 ? CHECK : FOLD;
    }
    if (facingThreeBet) return fourBetValue ? ALLIN : FOLD;
    if (fourBetValue) { const r = raiseOrJam(roundToBB(Math.round(betToMatch * 3), bigBlind)); if (r) return r; }   // 3-bet, not a jam
    if (callsSized(threeBetThS, threeBetTh)) return CALL;   // NIT flats its 3-bet range
    return FOLD;
  }

  // ── LAG / TAG (aggressive, range-based): the default balanced path. ──
  if (unopened) {
    if (pctile >= openTh) {
      let size: number;
      const limpers = table.seats.some(s => s.seatIndex !== seat.seatIndex && s.state === 'occupied'
        && !s.folded && s.lastAction === PlayerAction.Call);
      if (callAmount > 0 && !limpers && noLimit) {
        // NEW-3 — a first-in open: position-sized (EP 2.5-3x, late 2-2.6x), rounded
        // UP to a small blind (a whole big blind made every open 3 BB).
        const unit = Math.max(1, Math.min(bigBlind, table.config.smallBlind || Math.round(bigBlind / 2)));
        const mult = position < 3 ? 2.5 + Math.random() * 0.5 : 2.0 + Math.random() * 0.6;
        size = Math.ceil(Math.round(bigBlind * mult) / unit) * unit;
      } else if (callAmount === 0) {
        const mult = position < 3 ? 2.5 + Math.random() * 0.5 : 2.0 + Math.random() * 0.6;
        size = roundToBB(Math.round(bigBlind * mult), bigBlind);                     // big blind's raise (as before)
      } else {
        size = roundToBB(Math.round(bigBlind * (2.5 + Math.random() * 0.5)), bigBlind); // over limpers (as before)
      }
      return raiseOrAllIn(size);
    }
    if (callAmount === 0) return CHECK;
    if (pctile >= callVsRaiseTh) return CALL;   // over-limp (unchanged)
    return FOLD;
  }

  // Facing a 3-bet+: 4-bet premiums, defend by price after opening (B8), else the old flat range.
  if (facingThreeBet) {
    if (fourBetValue) { const r = raiseOrJam(roundToBB(Math.round(betToMatch * 2.3), bigBlind)); if (r) return r; }
    let contTh = threeBetTh;
    if (noLimit && streetRaises === 2 && callAmount > 0 && ownRaisesThisStreet(table, seat) > 0) {
      const need = callAmount / (totalPot + callAmount);
      const keep = Math.max(0, Math.min(DEF3B_KEEP_MAX, DEF3B_KEEP_AT_MIN - DEF3B_SLOPE * (need - DEF3B_MIN_NEED)));
      contTh = Math.min(contTh, 1 - (1 - openTh) * keep);
    }
    if (pctile >= contTh) return CALL;
    if (profile.difficulty === 'expert' && Math.random() < profile.bluffFrequency * 0.3) {
      const target = roundToBB(Math.round(betToMatch * 2.2), bigBlind);
      if (Math.max(minRaise, target) <= seat.chipCount * 0.35) return raiseOrAllIn(target);
    }
    return FOLD;
  }

  // Facing a single raise (B9: the big blind vs a min-raise lands here now): 3-bet, flat, or fold.
  if (facingRaise) {
    if (pctile >= threeBetThS) { const r = raiseOrJam(roundToBB(Math.round(betToMatch * 3), bigBlind)); if (r) return r; }
    if (callsSized(callVsRaiseThS, callVsRaiseTh)) return CALL;
    // Cheap speculative flat in late position.
    if ((bucket === 'BTN' || bucket === 'CO') && pctile >= adjustThreshold(0.45, factor) && callAmount <= seat.chipCount * 0.06) {
      return CALL;
    }
    return FOLD;
  }

  // A raised pot with nothing to call (a straddler's option): raise in range, else check.
  if (pctile >= openTh) return raiseOrAllIn(roundToBB(Math.round(bigBlind * 3), bigBlind));
  return CHECK;
}

// ============================================================
// Stud (Third Street) and draw (first betting round) first-round logic.
// 2026-11 (bots review, stud-draw-lowball SD4): replaces the 0dc1b96 copy of
// preFlopStrategy these games used. The strength is a real percentile of the
// game's own starting hands (studDrawHandStrength), and on this path:
//  - Stud has no blinds: every Third Street seat uses the MP ranges, the
//    bring-in seat (it acts first) EP;
//  - a completion (exactly one big blind) or any voluntary raise this round is
//    a raise (B1 / B9), and nobody-raised-yet is "unopened" for every seat (B5);
//  - facing one Stud completion the flat range is the button's facing an open;
//  - a fixed-limit game never consults the no-limit Nash push/fold chart;
//  - NIT / ROCK / FISH open normally, CALLING_STATION plays ~56% (CS_PLAY_BASE)
//    unopened and calls CS_CALL_WIDTH vs a raise (it played 100%);
//  - fix round 2: a hand in its game's value set (STUD_DRAW_VALUE_PCTILE, read
//    BEFORE the difficulty noise; Five Card Draw also a pair of aces or better
//    by class, fiveDrawAcesOrBetter) never folds to one completion, one raise
//    that does not commit the stack, or only the bring-in / big blind, for every
//    archetype (NIT folded Razz A-2-3 27%, Stud 8 A-2-3 suited 30%, Five Card
//    Draw A-A-K 41% and 3-3-2-2-K 86% to one; easy bots folded them unopened);
//    fix round 3: "one" by the table's own count of FULL raises, so a short
//    stack's all-in call, an all-in for less than a full raise, or a lone short
//    all-in is not a 3-bet (SD2-1 / SD2-2, review REG-1).
// Five Card Draw is the one no-limit game here. The Stud family, 2-7 Triple Draw
// and Badugi are fixed-limit and take none of the following (fix round 2, VA-1:
// preFlopStrategy's no-limit fixes, read on the 5CD percentile):
//  - NEW-1: facing an all-in its call closes, or a call that commits a third of
//    the stack, every archetype (CALLING_STATION and MANIAC included) continues
//    only with the stack-off range for the depth at risk (the smaller hand-start
//    stack): the Nash call up to 25 BB, then top 17% -> 6% at 100 BB+ (two pair
//    or better), narrower with up to 3 players in; FIVE_DRAW_STACKOFF_PREMIUM
//    hands (aces up, trips, pat hands; fix round 3 review: also by made-hand
//    class, fiveDrawStackOffPremium) always. It called a lone 100 BB shove
//    with 35-91% of hands. Fix round 3 review: against an all-in a call that
//    commits a third of a 100 BB stack on the depth at risk is one too, however
//    deep the bot (FIVE_DRAW_ALLIN_COMMIT_BB);
//  - NEW-5: a raise to RAISE_JAM_FRACTION of the stack is an all-in; a re-raise
//    to a third of it is a stack-off too (made as an all-in), and every jam must
//    pass that range (MANIAC moved in at 0.7 of its stack with any hand); a
//    hand that fails it re-raises at most FIVE_DRAW_LIGHT_RERAISE_FRACTION of
//    the stack (MANIAC re-raised 91% of hands to 33-59% of its stack, then
//    folded 89% of them to a shove);
//  - B4: the call and 3-bet ranges narrow with the size of the raise faced
//    (the big blind widens its calls vs a small one); a FIVE_DRAW_STACKOFF_PREMIUM
//    hand never folds to a 3-bet or short all-in that does not commit it (the
//    sized line folded ROCK / FISH full houses 17-47%), and a value-set hand
//    never folds to a lone short all-in that does not commit it. MANIAC keeps its flat
//    call (top 70%) at every size, as preFlopStrategy's;
//  - B8: an opener facing a 3-bet keeps a share of its opening range by the
//    price (never narrower than its old flat range: the stack-off gate prices
//    the 3-bets that commit it);
//  - B16: push/fold counts the live opponents when the pot is unopened or the
//    bot is alone against all-in player(s) (it assumed min(3, totalActive - 1)).
// It shares the fixed getEffectiveStackBB (hand-start stacks, NEW-1).
// ============================================================

/**
 * Fix round 2 (item 4) — each game's VALUE SET, on the first-round percentile
 * BEFORE the difficulty noise: such a hand never folds to one completion or one
 * raise that does not commit the stack. About the top 5% of starting hands
 * where a hand's own cards fix its percentile: 2-7 pat 8-lows and 4-card 7 / 8
 * draws, Badugi most badugis and 3-card 5-lows (0.95). In Stud the door cards
 * showing move it (over random 5-handed deals K-K-9 0.92-0.99, Stud 8 A-2-3
 * suited 0.87-0.98, Razz 2-4-6 0.84-1.0), and at 0.95 K-K-9 with a king
 * showing, or Razz A-2-3 / 2-4-6 and Stud 8 A-2-3 suited in 40-60% of deals,
 * would sit outside the set: Stud cuts at 0.92 (top ~8%: trips, jacks or
 * better, live tens / nines), Stud 8 at 0.90 (top ~10%), Razz at 0.85 (top
 * ~15%: nearly every three-to-a-7 and most three-to-an-8 starts). Five Card
 * Draw cuts at aces or better (0.90, ~10%): two pair or better is only 7.6% of
 * deals.
 */
export const STUD_DRAW_VALUE_PCTILE: Record<StudDrawKind, number> = {
  'stud-hi': 0.92, stud8: 0.90, razz: 0.85, 'draw-hi': 0.90, deuce7: 0.95, badugi: 0.95,
};
/** Five Card Draw: a first-round percentile this high before the noise (aces up, trips, pat hands: top ~3%) always continues a stack-off. */
export const FIVE_DRAW_STACKOFF_PREMIUM = 0.965;
/**
 * Five Card Draw: a re-raise by a hand that fails the stack-off range is made only up
 * to this share of the street stack (10 BB of 100: a 3-bet of a 2.5-3 BB open). Larger,
 * it is a call / fold instead: a hand that folds to the shove it invites risks little.
 * Opening 3 / 4 BB with any two and shoving over every re-raise vs four MANIACs (who
 * re-raise ~91% and fold ~89% of it to a shove) measured -63 / -273 BB/100 with 0.10,
 * +78 / +32 with 0.125 (2,000 hands, se ~47).
 */
export const FIVE_DRAW_LIGHT_RERAISE_FRACTION = 0.10;

/**
 * Fix round 2 follow-up — Five Card Draw's value set also holds every pair of aces
 * or better by its made-hand class (two pair+ 7.6% of deals, a pair of aces 3.3%):
 * the 600-sim percentile is noisy at the top and ranks low two pair (3-3-2-2-K
 * 0.85-0.90) and some pairs of aces (from 0.87) under the 0.90 cut, so a NIT still
 * folded them to one 3 BB open. The bot's own five cards only.
 */
export function fiveDrawAcesOrBetter(cards: Card[]): boolean {
  if (!cards || cards.length !== 5) return false;
  const cnt = new Map<number, number>();
  for (const c of cards) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
  const groups = [...cnt.values()].sort((a, b) => b - a);
  if (groups[0] >= 3 || (groups[0] === 2 && groups[1] === 2)) return true;   // trips, quads, full house, two pair
  if ((cnt.get(14) || 0) >= 2) return true;                                   // a pair of aces
  if (cards.every((c) => c.suit === cards[0].suit)) return true;              // flush
  if (groups.length === 5) {                                                  // straight (A-2-3-4-5 too)
    const r = cards.map((c) => c.rank).sort((a, b) => a - b);
    if (r[4] - r[0] === 4 || (r[4] === 14 && r[3] === 5)) return true;
  }
  return false;
}

/**
 * Five Card Draw made-hand class of the bot's own five cards (fix round 3 review / fix round 4):
 * 0 no pair, 1 one pair, 2 two pair below aces up, 3 two pair aces up, 4 trips, 5 a straight or
 * better (flush, full house, quads, straight flush; A-2-3-4-5 is a straight).
 */
export function fiveDrawMadeClass(cards: Card[]): number {
  if (!cards || cards.length !== 5) return 0;
  const cnt = new Map<number, number>();
  for (const c of cards) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
  const groups = [...cnt.values()].sort((a, b) => b - a);
  if (groups[0] >= 4 || (groups[0] === 3 && groups[1] === 2)) return 5;      // quads, full house
  if (groups[0] === 3) return 4;                                             // trips
  if (groups[0] === 2) return groups[1] !== 2 ? 1 : (cnt.get(14) || 0) === 2 ? 3 : 2;
  if (cards.every((c) => c.suit === cards[0].suit)) return 5;                // flush
  const r = cards.map((c) => c.rank).sort((a, b) => a - b);
  return r[4] - r[0] === 4 || (r[4] === 14 && r[3] === 5) ? 5 : 0;           // straight
}

/**
 * Fix round 3 review (MEAS-3) — Five Card Draw's stack-off PREMIUMS by made-hand class: two pair
 * aces up, trips, or a pat straight / flush / full house / quads (hiValue >= A-A-2-2-3). The bot's
 * own five cards only. FIVE_DRAW_STACKOFF_PREMIUM alone read them on the 600-sim percentile, whose
 * Monte Carlo seed is the cards themselves: by suit combination A-A-K-K-3 read 0.956-0.980, A-A-2-2-3
 * and 2-2-2-3-4 down to 0.95, and 6-21% of their suit combinations folded to a lone 100 BB shove.
 */
export function fiveDrawStackOffPremium(cards: Card[]): boolean {
  return fiveDrawMadeClass(cards) >= 3;
}

/**
 * Fix round 4 (MEAS-1 / EXPLOIT-1) — Five Card Draw AFTER the draw: a call that commits a third of the depth
 * at risk against the bet (the smaller of this seat's stack and the bet's this round: fiveDrawPostCommits)
 * against an overbet (FIVE_DRAW_POST_CLASS_PO: the made hand needed rises with the price) never needs more
 * than this made-hand class (fiveDrawMadeClass), by archetype: NIT / ROCK trips, TAG / LAG / MANIAC / FISH
 * aces up, CALLING_STATION two pair. The later-round
 * strength is the pot share vs each bettor's STARTING range (studDrawRangeFloor: 0.62 / 0.80 whatever the
 * bet), so a 100 BB shove after the draw was priced like a small bet and a NIT called it with one pair (32 of
 * 103 callers; live 0dc1b96, whose made-hand heuristic it replaced, 0 of 14): limping any five cards and
 * shoving two pair or better after the draw won +180 BB/100 vs NIT x4 and MANIAC x4 (live -121 / -97). At two
 * pair a MANIAC still lost +166 BB/100 to calling its raises up to 10 BB with any five cards and shoving two
 * pair or better after the draw (live -220; aces up: -103), and a FISH +257 to opening the top 25% and shoving
 * two pair or better after the draw (live +113; aces up: -45).
 */
export const FIVE_DRAW_POST_STACKOFF_CLASS: Record<Archetype, number> = {
  NIT: 4, ROCK: 4, TAG: 3, LAG: 3, MANIAC: 3, FISH: 3, CALLING_STATION: 2,
};

/**
 * Fix round 4 (unequal stacks) — Five Card Draw after the draw: an ALL-IN smaller than the pot-size gate that still
 * commits the depth at risk. Re-review fix-ups (STUDDRAW-RR1-MEASUREMENT-1 / R4R-EXPLOIT-2): from
 * FIVE_DRAW_POST_ALLIN_MIN_PO (every pair) the pair needed rises by rank, as for a bet, up to FIVE_DRAW_POST_ALLIN_CLASS
 * (two pair) at FIVE_DRAW_POST_CLASS_PO[0]. Fix round 4 asked two pair of every such all-in from 0.25: a MANIAC had
 * called a 40 BB human's ~30 BB shove into ~45 BB with a pair of queens or better (calling every raise up to 10 BB
 * with any five cards, then shoving two pair or better: +147 BB/100 vs MANIAC x4, live 0dc1b96 -218). Then every
 * archetype, FISH and CALLING_STATION included, folded a pair of aces to a 20 BB all-in into 30 BB, and the same
 * pre-draw line shoving ANY five cards with 25-30 BB when checked to after the draw (0.5-1.25x the pot) won +97 to
 * +100 BB/100 (live -224 to -236). The leads are capped now (FIVE_DRAW_POST_LEAD_CAP), so the bots bet into such a
 * stack instead of checking the pot to it.
 */
export const FIVE_DRAW_POST_ALLIN_MIN_PO = 0.25;
export const FIVE_DRAW_POST_ALLIN_CLASS = 2;

/**
 * Fix round 4 review (MEASUREMENT-1 / EXPLOIT-1) — Five Card Draw after the draw: the made hand a committing call
 * needs (fiveDrawGateScore: one pair 1-1.92 by its rank, two pair 2-2.91 by its top pair, aces up 3, trips 4) rises
 * SMOOTHLY with the price, for an all-in and any other bet alike: two pair up to [0] (~1.3x the pot), then up to
 * aces up at [1] (~2.6x), then trips by [2] (~6x), never above the stack-off class (FIVE_DRAW_POST_STACKOFF_CLASS).
 * The round-4 gate stepped from nothing to the stack-off class at a pot-size bet: TAG / LAG / FISH / MANIAC folded
 * every hand under aces up to a bet of exactly the pot but called a 0.95-pot bet with one pair. Calling raises up to
 * 10 BB with any five cards, then betting at least the pot with ANY hand when checked to after the draw, won +382
 * BB/100 vs MANIAC x4 (live 0dc1b96 -228); re-raising any open, then betting the pot with any hand heads-up, +90
 * vs LAG x4 and +41 / +55 vs NIT / TAG x4 with a 40 BB stack (live about 0); opening any five cards, then betting
 * the pot, +46 vs FISH x4 with 20-25 BB (live -108); with a 60 BB stack, betting 1.5x the pot with any hand (an
 * all-in of ~1.1x the pot, which kept the step) +210 to +500 (live -219; c2b81d4 +488 / +499).
 */
export const FIVE_DRAW_POST_CLASS_PO: readonly [number, number, number] = [0.36, 0.42, 0.46];

/**
 * Fix round 4 review — one pair facing a bet that is not an all-in after the draw continues when its pair rank is
 * at least 2 + 13 x (potOdds - lo) / (hi - lo): every pair against a third of the pot or less (potOdds 0.20),
 * none from three quarters of the pot (0.30), aces from ~0.29; an all-in on its own ramp, from
 * FIVE_DRAW_POST_ALLIN_MIN_PO to FIVE_DRAW_POST_CLASS_PO[0]. Smooth thresholds, not steps, so a value bet just under
 * a size and a bluff just over it are priced alike.
 */
export const FIVE_DRAW_POST_PAIR_PO: readonly [number, number] = [0.20, 0.30];

/**
 * Fix round 4 review (REGRESSION-1) — the class gate is for stacks that can be lost: against an all-in with a
 * depth at risk under this many big blinds it does not apply (the strategy prices the call); under
 * FIVE_DRAW_ALLIN_COMMIT_BB the stack-off class is at most aces up.
 * On the shorter stack alone a 5 BB human's 4 BB all-in into 5 BB was folded with a pair of aces by every archetype
 * (live 0dc1b96: 96 of 126 called), a NIT / ROCK folded aces up to a 20 BB human's all-in (live ROCK 18 of 18
 * called), and opening any five cards, then betting the pot after the draw (his whole stack), won +46 BB/100 vs
 * FISH x4 with 25 BB and +63 with 20 BB (live -108 / -96; cdb31dd -152).
 */
export const FIVE_DRAW_POST_SHALLOW_BB = 15;

/**
 * Re-review fix-ups (STUDDRAW-RR1-MEASUREMENT-1) — against an ALL-IN the made hand the gate asks phases in with the
 * depth at risk, from nothing at [0] big blinds to all of it at [1]. Fix round 4 switched it on whole at
 * FIVE_DRAW_POST_SHALLOW_BB: nothing was folded at 14 BB of depth, a pair of aces at 15. Ending the ramp at 33 BB
 * left 15-25 BB all-ins almost ungated: calling raises up to 10 BB with any five cards, then shoving two pair or
 * better after the draw with 30 BB, won +54 +- 22 BB/100 vs MANIAC x4 [6 seeds] (live 0dc1b96 -227); ending it at
 * 20 BB, -24 [4 seeds], while the same line shoving any five cards in a 0.5-1.25 pot window stays at -185 [2 seeds].
 */
export const FIVE_DRAW_POST_SHALLOW_RAMP_BB: readonly [number, number] = [12, 20];

/**
 * Re-review fix-ups (STUDDRAW-RR1-MEASUREMENT-2 / R4R-EXPLOIT-1) — the made hand the gate asks phases in with the share
 * of the depth at risk the call puts in, from nothing at [0] to all of it at [1] (STACKOFF_COMMIT_FRACTION). Fix
 * round 4 switched the gate on whole at a third of the depth: a value bet just under it was called by every pair
 * (no gate), a bluff just over it folded by every pair, and sizing value under the edge, bluffs over it, won +70
 * BB/100 vs FISH x4 and +118 vs MANIAC x4 at 100 BB (live 0dc1b96 -534 / -231).
 */
export const FIVE_DRAW_POST_COMMIT_RAMP: readonly [number, number] = [1 / 6, STACKOFF_COMMIT_FRACTION];

/**
 * Re-review fix-ups (STUDDRAW-R4R-EXPLOIT-1 / RR1-MEASUREMENT-2) — how much looser an archetype calls after the draw:
 * the gate reads its price this much lower. FISH and CALLING_STATION call down; with the plain ramp a FISH folded
 * 546 of the 619 any-hand bets of 0.75 pot or more a human made after the draw (live 20 of 261), and a CALLING_STATION
 * folded a pair of aces to a pot-size bet every time (live never).
 */
export const FIVE_DRAW_POST_LOOSE_PO: Record<Archetype, number> = {
  NIT: 0, ROCK: 0, TAG: 0, LAG: 0, MANIAC: 0, FISH: 0.06, CALLING_STATION: 0.10,
};

/**
 * Fix round 4 review fix-ups (MEASUREMENT-2) — Five Card Draw after the draw: an OVERCALL (a seat other than the bet's
 * maker has already called it this round, all-in for less included: fiveDrawPostOvercall) needs [0] more made hand
 * (fiveDrawGateScore) than a lone call at the same price, and at least [1] (two pair), still never above the stack-off
 * class. A bluff has already lost once one seat calls, so the rule costs the bots nothing against a bluffer; against a
 * value bettor every extra caller with a worse hand paid him. Since fix round 2 MANIACs re-raise light (at most 10 BB)
 * before the draw, so a human sees the draw cheaply in their multiway pots: calling raises up to 10 BB with any five
 * cards, then betting two pair or better when checked to after the draw, won vs MANIAC x4 (0.95 pot, 40 BB stack)
 * +61 BB/100, (1.5x pot, 60 BB) +99, (0.6 pot, 40 BB) +104 on ca66fff (live 0dc1b96 about -210).
 */
export const FIVE_DRAW_POST_OVERCALL: readonly [number, number] = [1, 2];

/** Fix round 4 review — the depth at risk against the bet this seat faces after the draw (chips): this seat's stack this round, or the smallest stack among the seats that have put the whole bet in, if smaller. */
function fiveDrawPostDepth(table: PokerTable, seat: Seat): number {
  let bet = 0;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.currentBet >= table.currentBetToMatch) bet = bet === 0 ? s.chipCount + s.currentBet : Math.min(bet, s.chipCount + s.currentBet);
  }
  return bet > 0 ? Math.min(seat.chipCount + seat.currentBet, bet) : 0;
}

/**
 * Fix round 4 — after the draw: how much of the made hand the gate asks does calling `callAmount` bring in, by the
 * share of the depth at risk against the bet (fiveDrawPostDepth) it puts in: 0 under FIVE_DRAW_POST_COMMIT_RAMP[0],
 * all of it from [1] (a third: fix round 4's on / off edge), linear between.
 */
function fiveDrawPostCommits(table: PokerTable, seat: Seat, callAmount: number): number {
  const depth = fiveDrawPostDepth(table, seat);
  if (depth <= 0) return 0;
  const [c0, c1] = FIVE_DRAW_POST_COMMIT_RAMP;
  return Math.max(0, Math.min(1, (callAmount / depth - c0) / (c1 - c0)));
}

/**
 * Fix round 4 review — is the bet this seat faces an all-in for the class gate: an all-in, a call that puts this
 * seat all-in, or a bet that leaves its maker at most 2 BB or a tenth of the bet behind (a value bet of "all but a
 * chip" is priced as the shove it is)?
 */
function fiveDrawPostShoveLike(table: PokerTable, seat: Seat, callAmount: number, bigBlind: number): boolean {
  if (shoverFaced(table, seat) || callAmount >= seat.chipCount) return true;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.currentBet > 0 && s.currentBet >= table.currentBetToMatch && s.chipCount <= Math.max(2 * bigBlind, 0.1 * s.currentBet)) return true;
  }
  return false;
}

/**
 * Fix round 4 review — a Five Card Draw made hand on one continuous scale for the post-draw gate: no pair 0, one
 * pair 1 + (rank - 2) / 13 (deuces 1, aces ~1.92), two pair 2 + (top pair - 3) / 11 (threes up 2, kings up ~2.91),
 * aces up 3, trips 4, a straight or better 5 (pure).
 */
export function fiveDrawGateScore(cards: Card[]): number {
  const cls = fiveDrawMadeClass(cards);
  if (cls !== 1 && cls !== 2) return cls;
  const cnt = new Map<number, number>();
  for (const c of cards) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
  let top = 0;
  for (const [r, k] of cnt) if (k === 2) top = Math.max(top, r);
  return cls === 1 ? 1 + (top - 2) / 13 : 2 + (top - 3) / 11;
}

/**
 * Fix round 4 review — Five Card Draw after the draw, a call that commits the depth at risk (fiveDrawPostCommits):
 * does the made-hand gate fold `cards` (pure)? `shoveLike`: fiveDrawPostShoveLike; `depthBB`: fiveDrawPostDepth in
 * big blinds; `commit`: fiveDrawPostCommits (1 = a third of the depth or more). The hand needed (fiveDrawGateScore)
 * by the price, read FIVE_DRAW_POST_LOOSE_PO lower for the archetype:
 *  - from FIVE_DRAW_POST_CLASS_PO[0], any bet: two pair rising to aces up at [1], then to trips at [2];
 *  - below it, one pair by its rank rising to FIVE_DRAW_POST_ALLIN_CLASS (two pair): an all-in from
 *    FIVE_DRAW_POST_ALLIN_MIN_PO (nothing under it) to FIVE_DRAW_POST_CLASS_PO[0]; any other bet from
 *    FIVE_DRAW_POST_PAIR_PO[0] (every pair; no pair folds) to [1];
 *  - an overcall (`overcall`: fiveDrawPostOvercall) needs FIVE_DRAW_POST_OVERCALL[0] more, and at least [1] (an
 *    all-in under FIVE_DRAW_POST_ALLIN_MIN_PO too);
 *  - never more than the stack-off class (FIVE_DRAW_POST_STACKOFF_CLASS), at most aces up under
 *    FIVE_DRAW_ALLIN_COMMIT_BB of depth;
 *  - all of that scaled by `commit` and, against an all-in, by the depth (FIVE_DRAW_POST_SHALLOW_RAMP_BB): a made
 *    hand meets no step at any size or depth (no pair folds wherever the gate applies at all);
 *  - `checked` (this seat checked this round): a bet's price read FIVE_DRAW_POST_CHECKED_PO lower too (not an
 *    all-in's, nor an overcall's);
 *  - `raised` (this seat already has chips in this round - its lead, raise or call - and the all-in raises over
 *    them): no ramp, two pair from
 *    FIVE_DRAW_POST_ALLIN_MIN_PO (re-review fix-ups: on the ramp a MANIAC whose capped lead was shoved over at 100 BB
 *    called with a pair of sixes or better, and shoving aces up or better over its leads won +231 / +352 BB/100 on two
 *    seeds, cdfc8a1 +301 / +217).
 */
export function fiveDrawPostFolds(cards: Card[], potOdds: number, archetype: Archetype, shoveLike: boolean, depthBB: number, overcall = false, commit = 1, checked = false, raised = false): boolean {
  let stackOff = FIVE_DRAW_POST_STACKOFF_CLASS[archetype] ?? 3;
  if (depthBB < FIVE_DRAW_ALLIN_COMMIT_BB) stackOff = Math.min(stackOff, 3);
  const [d0, d1] = FIVE_DRAW_POST_SHALLOW_RAMP_BB;
  const w = Math.max(0, Math.min(1, commit)) * (shoveLike ? Math.max(0, Math.min(1, (depthBB - d0) / (d1 - d0))) : 1);
  if (w <= 0) return false;
  const po = potOdds - (overcall ? 0 : (FIVE_DRAW_POST_LOOSE_PO[archetype] ?? 0) + (checked && !shoveLike ? FIVE_DRAW_POST_CHECKED_PO[archetype] ?? 0 : 0));
  const score = fiveDrawGateScore(cards);
  const [overAdd, overMin] = FIVE_DRAW_POST_OVERCALL;
  const [twoPair, acesUp, trips] = FIVE_DRAW_POST_CLASS_PO;
  const [lo, hi] = shoveLike ? [FIVE_DRAW_POST_ALLIN_MIN_PO, twoPair] : FIVE_DRAW_POST_PAIR_PO;
  if (shoveLike && po < lo) return overcall && score < w * Math.min(overMin, stackOff);
  let need: number;
  if (po >= acesUp) need = 3 + Math.min(1, (po - acesUp) / (trips - acesUp));
  else if (po >= twoPair) need = 2 + (po - twoPair) / (acesUp - twoPair);
  else need = po >= hi || (shoveLike && raised) ? FIVE_DRAW_POST_ALLIN_CLASS : po <= lo ? 1 : 1 + (FIVE_DRAW_POST_ALLIN_CLASS - 1) * (po - lo) / (hi - lo);
  if (overcall) need = Math.max(need + overAdd, overMin);
  return score < w * Math.min(need, stackOff);
}

/**
 * Fix round 4 review fix-ups — after the draw: has a seat other than this one and the bet's maker (the last seat to
 * raise the round's bet, betRaisingEntries) already put the whole bet in, or all its chips this round?
 */
function fiveDrawPostOvercall(table: PokerTable, seat: Seat): boolean {
  const raisers = betRaisingEntries(table);
  const maker = raisers.length ? raisers[raisers.length - 1] : -1;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.seatIndex === maker || s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.currentBet > 0 && (s.currentBet >= table.currentBetToMatch || s.allIn)) return true;
  }
  return false;
}

/**
 * Fix round 4 (MEAS-2 / EXPLOIT-2) — fixed-limit Stud / Draw, the rounds after the first: facing ONE
 * bet a bot whose pot share clears the price by this margin (callAmount / (pot + call) + margin)
 * calls. The NIT branch folded everything under 0.55 to one bet, ROCK under 0.30, MANIAC under 0.25,
 * whatever the pot laid (one small bet into 4-6 needs ~15-20%): calling the first round with any hand,
 * then betting when checked to and folding to any bet, won +83 BB/100 vs NIT x4 in Badugi (live -49)
 * and +119 in 2-7 Triple Draw (live +68); 3-betting the completion first, +15 to +33 in Stud / Razz /
 * Stud 8 (live ~0).
 */
export const STUD_DRAW_FL_CALL_MARGIN = 0.05;

/** Fix round 4 — the Stud / Draw game of a table, read as decideAction reads it; null for Hold'em, Omaha, Short Deck, Pineapple. */
function studDrawKindOfTable(table: PokerTable): StudDrawKind | null {
  const variantId: string = (table as any).variantId || 'texas-holdem';
  const stud = STUD_VARIANT_IDS.has(variantId) || typeof (table as any).getStudFirstActor === 'function';
  const draw = DRAW_VARIANT_IDS.has(variantId) || typeof (table as any).playerDraw === 'function';
  const p = table.currentPhase;
  const drawBet = p === GamePhase.Bet1 || p === GamePhase.Bet2 || p === GamePhase.Bet3 || p === GamePhase.Bet4;
  return (stud || draw || drawBet) ? (studDrawKindOf(variantId, table) ?? (stud ? 'stud-hi' : 'draw-hi')) : null;
}

/**
 * Fix round 3 review (REG-2) — Five Card Draw: facing an ALL-IN, a call is a stack-off when the depth
 * at risk against it (the smaller hand-start stack) reaches a third of a 100 BB stack, however deep
 * this seat is. On its own stack alone a 400 BB bot facing a lone 100 BB shove was not "committing":
 * the value-set hold called it with a pair of aces (continue 9-15% vs 5-10% at 100 BB), and a deep
 * MANIAC with players behind called it with its whole flat range (65%). Fix round 4: for a LONE shove
 * only (the round's one raise). In raise wars a 400 BB MANIAC then folded its light re-raises and cold
 * calls to a 100 BB shove over them: opening 3 BB with any five cards and shoving over every re-raise
 * won +894 BB/100 vs MANIAC x4 at 400 BB (cdb31dd -88, live 0dc1b96 -165); exempting only its own
 * re-raises still left 3-betting any open and shoving over a 4-bet at +297 (cdb31dd -104).
 */
export const FIVE_DRAW_ALLIN_COMMIT_BB = 100 * STACKOFF_COMMIT_FRACTION;

/**
 * Fix round 3 review (EXPLOIT-3) — fixed-limit draw games (2-7 Triple Draw, Badugi): a ROCK in the big
 * blind facing ONE raise calls with this first-round percentile or better (the top 70%: one small bet
 * more into 3.5 is a pot-odds call; live 0dc1b96 defended ~71%). On its flat range (callVsRaiseTh, top
 * 42%) it folded 58%, and completing / raising any hand first in, then folding to any bet, beat ROCK x4
 * in Badugi: +11.6 +- 3.9 BB/100 (live -139); with this, -7.8 +- 4.1 (2 seeds x 1,500 hands).
 */
export const STUD_DRAW_FL_ROCK_BB_DEFEND = 0.30;

/**
 * Fix round 3 review (REG-1) — this first round's FULL raises: the table's bet levels (a full raise,
 * or the Stud completion, is one; an all-in for less than a full raise reopens nothing and is none),
 * above the posted big blind in a draw game (Stud has no blind level: the bring-in is not one).
 * raisesThisStreet counts that incomplete all-in as a raise, so one completion / one open with a short
 * all-in made before or after it read as two, and the value set folded (Razz A-2-3, Stud 8 A-2-3
 * suited, Five Card Draw aces 39-100% for a hard NIT).
 */
function fullRaisesThisRound(table: PokerTable, variantFirstRound: 'stud' | 'draw', streetRaises: number): number {
  const levels = Number((table as any).betLevelsThisStreet);
  if (!Number.isFinite(levels)) return streetRaises;
  return Math.max(0, Math.min(streetRaises, levels - (variantFirstRound === 'draw' ? 1 : 0)));
}

/**
 * Fix round 4 (unequal stacks) — Five Card Draw: has this seat RE-raised this round (a raise of its own made
 * after another seat's raise / all-in) and put in more than FIVE_DRAW_LIGHT_RERAISE_FRACTION of the depth at
 * risk against the all-in it now faces (the smaller hand-start stack)? The light re-raise cap is a share of the
 * seat's OWN stack: "a hand that folds to the shove it invites risks little" holds only against a shove as
 * deep. Against a shorter all-in the re-raise is priced in, and folding it gave it away: a MANIAC re-raised a
 * 40 BB human's 3 BB open to ~10 BB and folded ~90% of those to his 40 BB shove (call 30 to win 51), so
 * opening 3 BB with any five cards and shoving over every re-raise won +98 +- 22 BB/100 vs MANIAC x4
 * (live 0dc1b96 +4 +- 32; it came with fix round 2's stack-off gate: e92bc52 -21, 2b5ac52 +122).
 * Fix round 4 review (REGRESSION-2): a raise is an action that RAISED the round's bet (betRaisingEntries). An
 * all-in CALL for less ('went all-in for 30' under a 50 big blind) is not one: read as a raise, it turned the
 * bot's plain open after it into a "re-raise", and a MANIAC / LAG / TAG / FISH open then called a 40 BB shove with
 * any five cards (0 of 160 folds; cdb31dd 140-148).
 */
function reRaisePricedIn(table: PokerTable, seat: Seat, shover: Seat | null): boolean {
  if (!shover || seat.currentBet <= FIVE_DRAW_LIGHT_RERAISE_FRACTION * Math.min(handStartStack(seat), handStartStack(shover))) return false;
  let raised = false;
  for (const seatIndex of betRaisingEntries(table)) {
    if (seatIndex !== seat.seatIndex) raised = true; else if (raised) return true;
  }
  return false;
}

/** 'raised to N' / 'bet N' / 'went all-in for N' (the amount the seat's bet now totals). */
const BET_TOTAL_RE = /^(?:raised to |bet |went all-in for )(\d+)/;

/**
 * Fix round 4 review (REGRESSION-2) — this round's actions that RAISED the bet to match, in order (the seat of
 * each): a raise, an opening bet, or an all-in above the running bet. The first round starts from the big blind
 * (the blinds' log lines carry no street); an all-in for no more than the running bet is a call.
 * Re-review fix-ups (STUDDRAW-R4F-REGRESSION-2): a UTG straddle (logged as 'straddle', 2 x the hand's big blind)
 * is the round's posted blind, not a raise: the level starts there. From the big blind alone, an all-in call for
 * less than the straddle ('went all-in for 80' under a 100 straddle) read as a raise, the bot's plain open after
 * it as a "re-raise", and a MANIAC / LAG / TAG / FISH open called a 40 BB shove with any five cards (0 of 160
 * folds; 132-144 without the short call). The hand's big blind (handBigBlind), not config's: a tournament
 * level-up changes config mid-hand.
 */
function betRaisingEntries(table: PokerTable): number[] {
  const firstRound = table.currentPhase === GamePhase.PreFlop;
  const handBB = Number((table as any).handBigBlind) || Number(table.config.bigBlind) || 0;
  let level = firstRound ? handBB : 0;
  const out: number[] = [];
  for (const e of table.actionLog) {
    if (e.street !== table.currentPhase) continue;
    if (firstRound && e.action === 'straddle') { level = Math.max(level, 2 * handBB); continue; }
    const m = BET_TOTAL_RE.exec(e.action);
    if (!m) continue;
    const total = Number(m[1]);
    if (total > level) { out.push(e.seatIndex); level = total; }
  }
  return out;
}

function studDrawFirstRound(
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
  allInOrFold: boolean,
  variantFirstRound: 'stud' | 'draw',
  ctx: StudDrawFirstCtx = { liveOpponents: Math.max(1, totalActive - 1), rawPctile: handStrength },
): AIDecision {
  // 2026-07-07 AI overhaul: `handStrength` is now a real preflop PERCENTILE
  // (1.0 = AA, 0.85 = top 15%). Thresholds come from the solver-sized position
  // ranges (preflopRanges.ts), archetype-widened by ARCHETYPE_RANGE_FACTOR and
  // stack-adjusted by getStackDepthMultiplier — so the personalities derive from
  // ONE principled range instead of scattered magic literals, short stacks
  // tighten, and the vestigial openLimpFreq knob now actually matters.
  const params = ARCHETYPE_PARAMS[profile.archetype];
  const pctile = handStrength;
  // B1: Stud has no blinds — the SB/BB buckets (a posted blind, BB defence 0.55)
  // made the last two Third Street seats play ~45% of hands. Every Third Street
  // seat uses the MP ranges except the bring-in seat, which acts FIRST (G168): EP.
  const bucket: PosBucket = variantFirstRound === 'stud'
    ? (position === 0 ? 'EP' : 'MP')
    : posBucket(position, totalActive);
  const factor = ARCHETYPE_RANGE_FACTOR[profile.archetype] ?? 1.0;
  const effBB = getEffectiveStackBB(table, seat.seatIndex);
  const stackMult = getStackDepthMultiplier(effBB);
  const huFactor = totalActive <= 2 ? 0.55 : 1.0; // heads-up plays FAR wider
  // GAME-9 (R2) — the table's own count of this round's raises: with each
  // opponent's LAST action only, two bots re-raising each other each saw "one
  // raise" forever and never reached the 4-bet / fold logic.
  const streetRaises = Number((table as any).raisesThisStreet) || 0;
  // Fix round 3 review (REG-1): the FULL raises among them (an incomplete all-in raise is none).
  const fullRaises = fullRaisesThisRound(table, variantFirstRound, streetRaises);
  // B1: a Stud completion is exactly one big blind (the bring-in is posted, not a
  // raise), so `callAmount > bigBlind` read it as a limp. In Stud and the draw
  // games the round's own raise count says whether a raise was made.
  const facingRaise = callAmount > bigBlind || (streetRaises >= 1 && callAmount > 0);
  // B5 / CS: nobody has raised this round and there is a bet to call (the big blind,
  // the bring-in, a limp). Every seat but the big blind / bring-in faces one, so the
  // per-archetype `callAmount === 0` open branches were reachable only there (NIT
  // shoved or folded, ROCK limped AA, FISH shoved 100 BB in Five Card Draw,
  // CALLING_STATION played 100%).
  const unopened = !facingRaise && callAmount > 0;
  const facingThreeBet = Math.max(opponents.raiseCount, streetRaises) >= 2;
  // A re-raise is sized off the bet it faces (currentBetToMatch), not off the
  // increment still to call: "3x the call" made every 3-bet a near min-raise.
  const betToMatch = table.currentBetToMatch;
  const minRaise = table.getMinRaise();

  // Model-derived, archetype/stack/heads-up-adjusted thresholds (percentile scale).
  const openTh = adjustThreshold(adjustThreshold(adjustThreshold(OPEN_THRESHOLD[bucket], factor), stackMult), huFactor);
  const threeBetTh = adjustThreshold(adjustThreshold(THREEBET_THRESHOLD[bucket], factor), huFactor);
  // B1x: facing a single Stud COMPLETION the price is the Hold'em button's facing
  // an open (one small bet to win the antes, the bring-in and the completion), so
  // the flat range is the BTN one; the bring-in / limp decisions keep their own bucket.
  const callBucket: PosBucket = variantFirstRound === 'stud' && facingRaise && !facingThreeBet ? 'BTN' : bucket;
  const callVsRaiseTh = adjustThreshold(adjustThreshold(adjustThreshold(CALL_VS_RAISE_THRESHOLD[callBucket], factor), stackMult), huFactor);
  const fourBetTh = FOURBET_THRESHOLD;

  // Fix round 2 — Five Card Draw is the one no-limit game here: every branch below
  // that reads `noLimit` leaves the fixed-limit games exactly as they were.
  const noLimit = table.bettingStructure === 'no-limit';
  const kind: StudDrawKind = studDrawKindOf((table as any).variantId || '', table) ?? (variantFirstRound === 'stud' ? 'stud-hi' : 'draw-hi');
  const raw = ctx.rawPctile;
  // B4 (no-limit) — the size of the raise faced, as preFlopStrategy: a bigger raise
  // narrows the call and 3-bet ranges in proportion (3 BB / size); a smaller one
  // widens the big blind's calls only. The fixed-limit games keep factor 1.
  const sizeFactor = facingRaise && noLimit
    ? Math.min(bucket === 'BB' ? SIZE_WIDEN_MAX : 1, (OPEN_REFERENCE_BB * bigBlind) / Math.max(betToMatch, bigBlind))
    : 1;
  const sized = (th: number, f: number): number => (f === 1 ? th : Math.min(0.99, Math.max(0.30, 1 - (1 - th) * f)));
  const callVsRaiseThS = sized(callVsRaiseTh, sizeFactor);
  const threeBetThS = sized(threeBetTh, Math.min(1, sizeFactor));

  const FOLD: AIDecision = { action: PlayerAction.Fold, raiseAmount: 0 };
  const CHECK: AIDecision = { action: PlayerAction.Check, raiseAmount: 0 };
  const CALL: AIDecision = { action: PlayerAction.Call, raiseAmount: 0 };
  const ALLIN: AIDecision = { action: PlayerAction.AllIn, raiseAmount: 0 };
  // Item 4 — a value-set hand (pre-noise percentile; Five Card Draw also a pair of aces
  // or better by class) facing ONE completion / raise, or only the bring-in / big blind,
  // calls instead of folding. No-limit: a FIVE_DRAW_STACKOFF_PREMIUM hand never folds to
  // a 3-bet or a short all-in that does not commit it (the B4 sizing put ROCK / FISH's
  // threshold at 0.98: they folded full houses 17-47% to a 25-32 BB 3-bet).
  // Fix round 3 (SD2-1 / SD2-2) — "one" is the table's own count of this round's FULL raises
  // (fullRaises; review REG-1: an all-in for less than a full raise is none, before or after
  // the completion / open): modelOpponents reads every all-in as two raises, so a short
  // stack's all-in CALL (every game), an incomplete all-in raise, or a lone short all-in
  // (under the Stud completion; a no-limit shove that does not commit this seat) read as a
  // 3-bet, and the value set folded (Five Card Draw ROCK / FISH aces and two pair 95-100% to
  // a 15-25 BB shove, Razz NIT A-2-3 58% beside an all-in call). A no-limit call that commits
  // a third of the stack, or of a 100 BB stack against an all-in (FIVE_DRAW_ALLIN_COMMIT_BB),
  // never gets here: the stack-off gate prices it first.
  const inValueSet = raw >= STUD_DRAW_VALUE_PCTILE[kind] || (kind === 'draw-hi' && fiveDrawAcesOrBetter(seat.holeCards));
  // Review MEAS-3 — a stack-off premium by percentile OR by made-hand class (Five Card Draw).
  const premium = raw >= FIVE_DRAW_STACKOFF_PREMIUM || (kind === 'draw-hi' && fiveDrawStackOffPremium(seat.holeCards));
  const facingOneRaise = facingRaise && fullRaises <= 1;
  const FOLD_VS_RAISE: AIDecision = ((unopened || facingOneRaise) && inValueSet)
    || (noLimit && facingThreeBet && premium) ? CALL : FOLD;
  const raiseOrAllIn = (amount: number): AIDecision => {
    const to = Math.max(minRaise, amount);
    // NEW-5 (no-limit) — a raise to RAISE_JAM_FRACTION of the stack is made as an all-in.
    return to >= seat.chipCount || (noLimit && to >= (seat.chipCount + seat.currentBet) * RAISE_JAM_FRACTION)
      ? ALLIN
      : { action: PlayerAction.Raise, raiseAmount: to };
  };

  // NEW-1 — the all-in that SET the bet this seat faces and the depth at risk
  // against it (the smaller hand-start stack); pureCall = a call closes the action,
  // pureAllInCall = no other live opponent has chips (preFlopStrategy's reading).
  const pyta = Math.max(1, ctx.liveOpponents);
  const shover = callAmount > 0 ? shoverFaced(table, seat) : null;
  const shoveBB = shover ? Math.max(1, Math.round(Math.min(handStartStack(seat), handStartStack(shover)) / bigBlind)) : 0;
  let othersWithChips = 0, othersToAct = 0;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated || s.allIn || s.chipCount <= 0) continue;
    othersWithChips++;
    if (s.currentBet < table.currentBetToMatch) othersToAct++;
  }
  const pureCall = !!shover && othersToAct === 0;
  const pureAllInCall = !!shover && othersWithChips === 0;

  // ── Short-stack push/fold: shove-or-fold from the BAKED Nash lookup
  //    (pushFoldSolver.ts — an offline-solved HU equilibrium, multiway-tightened
  //    and validated vs published charts). The HU-vs-multiway axis is handled by
  //    the lookup itself (playersYetToAct), so we do NOT apply huFactor here —
  //    only the archetype `factor` as a personality overlay. Stations still flat;
  //    nobody limps a short stack. ──
  // B16 (no-limit) — an unopened pot, or a call against all-in player(s) alone,
  // counts every live opponent (folded to the small blind: 1, not 3).
  const playersYetToAct = noLimit && ((streetRaises === 0 && !facingRaise) || pureAllInCall)
    ? pyta
    : Math.min(3, Math.max(1, totalActive - 1));
  // F49 (2026-10-21) — an All-In or Fold table plays this branch at ANY depth
  // and for every archetype (a call there is a shove too): the stack is read as
  // at most the deepest baked one, and a bet above the big blind is a shove to
  // CALL (the Nash call threshold), never one to re-shove over on push odds.
  const pfBB = allInOrFold ? Math.min(effBB, PUSH_FOLD_MAX_BB) : effBB;
  // The Nash push/fold chart is a no-limit Hold'em shove; a fixed-limit game
  // (Stud family, 2-7 Triple Draw, Badugi) has no shove (All-In is capped at one bet).
  const pushFoldGame = table.bettingStructure !== 'fixed-limit';
  if (allInOrFold || (pushFoldGame && inPushFoldZone(effBB, playersYetToAct) && profile.archetype !== 'CALLING_STATION')) {
    const nashPush = nashPushPctile(pfBB, playersYetToAct);
    if (nashPush !== null) {
      // NEW-1 (no-limit): a short all-in the bot faces alone is a CALL too (it was re-shoved on the push range).
      if ((noLimit && pureAllInCall) || (callAmount >= seat.chipCount && callAmount > 0) || (allInOrFold && callAmount > bigBlind)) {
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

  // ── NEW-1 / NEW-5 (no-limit: Five Card Draw) — STACK-OFF: facing an all-in this
  //    call closes, or a call that commits a third of the stack, continue only with
  //    the stack-off range for the depth at risk (preFlopStrategy's: the Nash call up
  //    to 25 BB, then top 17% -> 6% at 100 BB+, narrower with up to 3 players in),
  //    read on the 5CD percentile, whose top 6% is two pair or better: the hands that
  //    beat the one-pair part of any shoving range. Premiums (aces up, trips, pat
  //    hands) always. Continuing = calling the all-in / moving in. Every archetype.
  //    Fix round 3 (SD2-1): a value-set hand closing the action on ONE all-in that does
  //    not commit it calls (on the noisy percentile easy / medium bots folded aces and
  //    two pair 5-25% to a 20-25 BB shove, hard ones 10-20% at 33 BB).
  //    Review REG-2: facing an all-in, a call that commits a third of a 100 BB stack
  //    (FIVE_DRAW_ALLIN_COMMIT_BB, on the depth at risk) is a stack-off too, however deep
  //    this seat is; when only that makes it one, a continuing hand with players behind
  //    calls (it does not move in its deeper stack). Fix round 4: for a LONE shove only (the
  //    round's one raise); in a raise war the seat's own stack prices it, as before (a 400 BB
  //    MANIAC folded its light re-raises, and its cold calls, to a 100 BB shove over them).
  //    Review fix-ups: the round's one FULL raise (fullRaises): a short all-in for less before the
  //    shove does not make it a raise war.
  //    Review MEAS-3: premiums by class.
  //    Fix round 4 (unequal stacks): a seat whose own re-raise is more than the light share of
  //    the depth at risk against a SHORTER all-in calls it (reRaisePricedIn). ──
  const ownCommit = callAmount > 0 && callAmount >= seat.chipCount * STACKOFF_COMMIT_FRACTION;
  const committing = ownCommit
    || (callAmount > 0 && !!shover && shoveBB >= FIVE_DRAW_ALLIN_COMMIT_BB && fullRaises <= 1);
  const soPlayers = Math.min(3, pyta);
  const stackOffOK = (depthBB: number): boolean => premium || (depthBB <= PUSH_FOLD_MAX_BB
    ? pctile >= adjustThreshold(nashCallPctile(depthBB, soPlayers), factor)
    : pctile >= adjustThreshold(1 - stackOffCallWidth(depthBB, soPlayers), factor));
  if (noLimit && !allInOrFold && (pureCall || committing)) {
    if (!stackOffOK(pureCall ? shoveBB : effBB) && !(!committing && facingOneRaise && inValueSet)) {
      return reRaisePricedIn(table, seat, shover) ? (callAmount < seat.chipCount ? CALL : ALLIN) : FOLD;
    }
    return (pureCall || !ownCommit) && callAmount < seat.chipCount ? CALL : ALLIN;
  }
  /**
   * A re-raise. No-limit: one that would put STACKOFF_COMMIT_FRACTION of the street
   * stack in is a stack-off — made as an all-in, and only with a hand that passes the
   * stack-off range (null = not this hand: fall through to the call / fold line). A
   * MANIAC re-raised 91% of hands to 33-59% of its stack, then folded 89% of them to
   * a shove: any two cards profited by shoving over it.
   */
  const raiseOrJam = (amount: number): AIDecision | null => {
    const d = raiseOrAllIn(amount);
    if (!noLimit) return d;
    const to = Math.max(minRaise, amount), street = seat.chipCount + seat.currentBet;
    if (d.action === PlayerAction.AllIn || to >= street * STACKOFF_COMMIT_FRACTION) return stackOffOK(effBB) ? ALLIN : null;
    // ... and a re-raise of a hand that would fold to the shove it invites stays small.
    if (facingRaise && to > street * FIVE_DRAW_LIGHT_RERAISE_FRACTION && !stackOffOK(effBB)) return null;
    return d;
  };

  // ── CALLING_STATION: loose and passive (Hold'em's CS_PLAY_BASE / CS_CALL_WIDTH, the
  //    width narrowing with the size of a no-limit raise), never raises. ──
  if (profile.archetype === 'CALLING_STATION') {
    if (callAmount === 0) return CHECK;
    if (unopened) return pctile >= adjustThreshold(CS_PLAY_BASE, factor) ? CALL : FOLD_VS_RAISE;
    if (callAmount > seat.chipCount * 0.30 && pctile < 0.35) return FOLD_VS_RAISE;
    if (callAmount >= seat.chipCount) return pctile >= 0.40 ? ALLIN : FOLD_VS_RAISE;   // fixed limit only (no-limit: the gate above)
    return pctile >= Math.max(0.30, 1 - CS_CALL_WIDTH * sizeFactor) ? CALL : FOLD_VS_RAISE;
  }

  // ── MANIAC: raises/3-bets almost anything — at no-limit a raise that would be a
  //    jam is a stack-off (NEW-5: it moved in at 0.7 of its stack with any hand). ──
  if (profile.archetype === 'MANIAC') {
    const wantRaise = pctile >= 0.15 || Math.random() < 0.55;
    if (wantRaise) {
      const target = callAmount === 0
        ? Math.round(bigBlind * (2.5 + Math.random() * 2.5))
        : Math.round(betToMatch * (2.5 + Math.random() * 1.5));
      if (!noLimit) {   // fixed limit: unchanged
        if (Math.max(minRaise, target) >= seat.chipCount * 0.7) return ALLIN;
        return raiseOrAllIn(target);
      }
      const r = raiseOrJam(target);
      if (r) return r;
    }
    if (callAmount === 0) return CHECK;
    return pctile >= 0.30 ? CALL : FOLD_VS_RAISE;
  }

  // ── FISH: loose-passive; LIMPS its playables (openLimpFreq), calls too wide. ──
  if (profile.archetype === 'FISH') {
    if (callAmount === 0) {
      if (pctile >= openTh && Math.random() >= params.openLimpFreq) return raiseOrAllIn(Math.round(bigBlind * 3));
      return { action: PlayerAction.Check, raiseAmount: 0 }; // limp / check back
    }
    if (unopened) {
      // B5 — the hands it used to SHOVE (top 10%) are a 3 BB raise; the rest of its range limps.
      if (pctile >= 0.90) return raiseOrAllIn(Math.round(bigBlind * 3));
      return pctile >= adjustThreshold(0.55, factor) ? { action: PlayerAction.Call, raiseAmount: 0 } : FOLD_VS_RAISE;
    }
    // Its "weird raise": a 3-bet, never a jam and never a 4-bet.
    if (!facingThreeBet && pctile >= 0.90) { const r = raiseOrJam(roundToBB(Math.round(betToMatch * 3), bigBlind)); if (r) return r; }
    if (pctile >= adjustThreshold(0.55, factor) && callAmount <= seat.chipCount * 0.12) return CALL;
    if (pctile >= callVsRaiseThS) return CALL;
    return FOLD_VS_RAISE;
  }

  // ── ROCK: tight-passive; calls down, raises only premiums. ──
  if (profile.archetype === 'ROCK') {
    if (callAmount === 0) {
      if (pctile >= adjustThreshold(0.94, huFactor)) return raiseOrAllIn(Math.round(bigBlind * 2.5));
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    // B5 — premiums raise from ANY seat (it limped AA everywhere but the big blind).
    if (unopened && pctile >= adjustThreshold(0.94, huFactor)) return raiseOrAllIn(Math.round(bigBlind * 2.5));
    // Review EXPLOIT-3 — fixed limit: the big blind facing ONE raise defends its pot-odds range.
    if (!noLimit && bucket === 'BB' && facingOneRaise && pctile >= STUD_DRAW_FL_ROCK_BB_DEFEND) return CALL;
    if (pctile >= callVsRaiseThS) return CALL;
    return FOLD_VS_RAISE;
  }

  // ── NIT: only premiums; folds to 3-bets without a 4-bet-worthy hand (an opener keeps a share). ──
  if (profile.archetype === 'NIT') {
    if (callAmount === 0) {
      if (pctile >= openTh) return raiseOrAllIn(Math.round(bigBlind * 2.5));
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }
    if (unopened) {
      // B1 / B5 — NIT opens its own range (openTh: the one it already uses in the big blind) from
      // ANY seat: it used to shove the top 3.5% and fold the rest (Five Card Draw AA-K folded 88%).
      // Item 4 — a value-set hand the noise put under openTh opens too (a NIT never limps).
      return pctile >= openTh || inValueSet ? raiseOrAllIn(Math.round(bigBlind * 2.5)) : { action: PlayerAction.Fold, raiseAmount: 0 };
    }
    // Fix round 3 — an opener facing ONE re-raise (B8's spot) keeps a share of its opening range:
    // no-limit by the price (B8's DEF3B_* rule), fixed limit all of it (one more bet into ~6 is no
    // fold for a hand that opened), a value-set hand always; read on the noisy percentile or the
    // pre-noise one (the open passed on one draw of the noise). It folded every open under fourBetTh
    // to a single 3-bet: 3-betting any two cards won +59 BB/100 vs NIT x4 in Five Card Draw (live
    // -4) and +80 in Badugi (live +2).
    if (facingThreeBet && pctile < fourBetTh) {
      if (fullRaises === 2 && callAmount > 0 && ownRaisesThisStreet(table, seat) > 0) {   // review REG-1: full raises
        let keepTh = openTh;
        if (noLimit) {
          const need = callAmount / (totalPot + callAmount);
          const keep = Math.max(0, Math.min(DEF3B_KEEP_MAX, DEF3B_KEEP_AT_MIN - DEF3B_SLOPE * (need - DEF3B_MIN_NEED)));
          keepTh = 1 - (1 - openTh) * keep;
        }
        if (Math.max(pctile, raw) >= keepTh || inValueSet) return CALL;
      }
      return FOLD_VS_RAISE;
    }
    if (pctile >= fourBetTh) {
      if (facingThreeBet) return ALLIN;
      const r = raiseOrJam(roundToBB(Math.round(betToMatch * 3), bigBlind));
      if (r) return r;
    }
    if (pctile >= threeBetThS) return CALL;
    return FOLD_VS_RAISE;
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
    if (pctile >= fourBetTh) { const r = raiseOrJam(roundToBB(Math.round(betToMatch * 2.3), bigBlind)); if (r) return r; }
    // B8 (no-limit) — an opener facing a 3-bet keeps a share of its opening range by
    // the price it is laid (preFlopStrategy's DEF3B line); never narrower than the old flat range.
    // Review REG-1: counted on FULL raises (an incomplete all-in raise in the round is none).
    let contTh = threeBetTh;
    if (noLimit && fullRaises === 2 && callAmount > 0 && ownRaisesThisStreet(table, seat) > 0) {
      const need = callAmount / (totalPot + callAmount);
      const keep = Math.max(0, Math.min(DEF3B_KEEP_MAX, DEF3B_KEEP_AT_MIN - DEF3B_SLOPE * (need - DEF3B_MIN_NEED)));
      contTh = Math.min(contTh, 1 - (1 - openTh) * keep);
    }
    if (pctile >= contTh) return CALL;
    if (profile.difficulty === 'expert' && Math.random() < profile.bluffFrequency * 0.3) {
      const target = roundToBB(Math.round(betToMatch * 2.2), bigBlind);
      if (Math.max(minRaise, target) <= seat.chipCount * 0.35) { const r = raiseOrJam(target); if (r) return r; }
    }
    return FOLD_VS_RAISE;
  }

  // Facing a single raise: 3-bet, flat, or fold.
  if (facingRaise) {
    if (pctile >= threeBetThS) {
      // GAME-9: 3x the open it faces (was 3x the increment still to call).
      const r = raiseOrJam(roundToBB(Math.round(betToMatch * 3), bigBlind));
      if (r) return r;
    }
    if (pctile >= callVsRaiseThS) return CALL;
    // Cheap speculative flat in late position.
    if ((bucket === 'BTN' || bucket === 'CO') && pctile >= adjustThreshold(0.45, factor) && callAmount <= seat.chipCount * 0.06) {
      return CALL;
    }
    return FOLD_VS_RAISE;
  }

  // Facing only the big blind / the bring-in (limped pot / SB complete): raise in range, else complete/fold.
  if (pctile >= openTh) {
    const target = roundToBB(Math.round(bigBlind * (2.5 + Math.random() * 0.5)), bigBlind);
    return raiseOrAllIn(target);
  }
  if (pctile >= callVsRaiseTh) return { action: PlayerAction.Call, raiseAmount: 0 };
  return FOLD_VS_RAISE;
}

// ============================================================
// Post-flop decision logic
// ============================================================

/**
 * Fix round 4 (bots review, studdraw MEAS-1 / EXPLOIT-1) — postFlopStrategyCore's decision, then, in Five
 * Card Draw after the draw ONLY (every other game: the core's decision, unchanged), with the depth at risk
 * the smaller of this seat's stack and the shortest live opponent's with FIVE_DRAW_POST_SHALLOW_BB or more
 * behind this round (fiveDrawPostBetDepth; no such opponent: no limit):
 *  - a LEAD (nothing to call) puts in at most FIVE_DRAW_POST_LEAD_CAP of the depth, whatever the hand
 *    (re-review fix-ups); a capped lead under the minimum bet (the bot's own stack is under ~3.3 BB) is its
 *    whole stack, one size for every hand (fix-up 3, STUDDRAW-R4RR-REGRESSION-2: it was a check, so a bot with
 *    2 BB behind never bet a full house, 0 of 54; live 0dc1b96 16 of 54);
 *  - a MANIAC with seats still to act behind it leads polarized (FIVE_DRAW_POST_MANIAC_LEAD): a pair of kings
 *    or better and a share of its no-pair hands (re-review fix-ups), plus a share of its lower pairs, and it
 *    checks a share of the kings or better (FIVE_DRAW_POST_MANIAC_MIX, fix-up 3), so neither its lead nor its
 *    check is a capped range; checked to by every seat, it bets as the core does;
 *  - a RAISE that puts a third of the depth in needs the stack-off class (FIVE_DRAW_POST_STACKOFF_CLASS),
 *    else it calls.
 * Fix round 4 made every big bet of a weaker hand a check: in pots built big before the draw a MANIAC bet
 * half its stack with any hand, then called a shove with one pair or folded its bet (calling its raises up
 * to 10 BB with any five cards and shoving two pair or better after the draw: +462 BB/100 vs MANIAC x4,
 * live 0dc1b96 -220). The re-review found what the checks cost: a big LAG / MANIAC lead was aces up or
 * better 473 times in 476 (live 4 of 24), and against a short stack every hand below aces up checked. Value
 * bets just under a third of the depth, bluffs just over it and folding to every big lead won +124 BB/100
 * vs MANIAC x4 with 40 BB and +182 at 100 BB; shoving any five cards when checked to with 25-30 BB, +97;
 * shoving two pair or better with 15-20 BB, about +10 (live 0dc1b96 -224 to -252). One capped size for
 * every hand tells nothing, keeps the bots betting into short stacks, and a lead that folds to a shove
 * over it risks at most FIVE_DRAW_POST_LEAD_CAP of the depth.
 */
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
  oppCategory: OpponentCategory,
  street: GamePhase = table.currentPhase
): AIDecision {
  const d = postFlopStrategyCore(effectiveStrength, rawStrength, callAmount, totalPot, potOdds, seat, table, profile,
    board, opponents, outs, bigBlind, numOpponents, oppCategory, street);
  if ((d.action !== PlayerAction.Raise && d.action !== PlayerAction.AllIn) || callAmount >= seat.chipCount) return d;
  if (studDrawKindOfTable(table) !== 'draw-hi' || table.bettingStructure !== 'no-limit' || drawsLeftAt('draw-hi', table.currentPhase) !== 0) return d;
  if (callAmount === 0 && profile.archetype === 'MANIAC' && !fiveDrawPostCheckedToLast(table, seat)) {
    const score = fiveDrawGateScore(seat.holeCards);
    const [leadFrom, airShare] = FIVE_DRAW_POST_MANIAC_LEAD;
    const [pairShare, trapShare] = FIVE_DRAW_POST_MANIAC_MIX;
    const u = Math.random();
    if (score < 1 ? u >= airShare : score < leadFrom ? u >= pairShare : u < trapShare) return { action: PlayerAction.Check, raiseAmount: 0 };
  }
  const put = d.action === PlayerAction.AllIn ? seat.chipCount : d.raiseAmount - seat.currentBet;
  const oppDepth = fiveDrawPostBetDepth(table, seat, bigBlind);
  if (oppDepth <= 0) return d;
  const depth = Math.min(seat.chipCount + seat.currentBet, oppDepth);
  if (callAmount === 0) {
    const cap = Math.floor(FIVE_DRAW_POST_LEAD_CAP * depth);
    if (put <= cap) return d;
    const to = seat.currentBet + cap;
    if (to < table.getMinRaise()) return { action: PlayerAction.AllIn, raiseAmount: 0 };
    return cap < seat.chipCount
      ? { action: PlayerAction.Raise, raiseAmount: to } : { action: PlayerAction.Check, raiseAmount: 0 };
  }
  if (put < STACKOFF_COMMIT_FRACTION * depth) return d;
  if (fiveDrawMadeClass(seat.holeCards) >= (FIVE_DRAW_POST_STACKOFF_CLASS[profile.archetype] ?? 3)) return d;
  return { action: PlayerAction.Call, raiseAmount: 0 };
}

/**
 * Re-review fix-ups (STUDDRAW-R4R-EXPLOIT-1 / RR1-MEASUREMENT-2, R4F-REGRESSION-1) — Five Card Draw after the draw:
 * the most a LEAD puts in, as a share of the depth at risk (fiveDrawPostBetDepth), for every hand alike (a bet that
 * would put in more is made at this size). Just under the third of the depth a call starts to commit
 * (STACKOFF_COMMIT_FRACTION). Screened vs MANIAC x4 against a check (cdfc8a1) and against a cap for the hands
 * below the stack-off class only (big bets kept for aces up or better): the commit-edge read line went from +151 /
 * +236 BB/100 to +34 / +94 with one size for every hand, +86 / +85 with the split (single seeds). With the rest of
 * the re-review fix-ups, over whole hands vs MANIAC x4: that line (value under the edge, bluffs over it, folding to
 * big leads) -147 +- 35 BB/100 with 40 BB and -83 +- 55 at 100 BB [4 seeds each] (cdfc8a1 +123 / +182; live -246 /
 * -252); shoving any five cards into a checked pot with 30 BB -103 +- 31 (cdfc8a1 +97).
 */
export const FIVE_DRAW_POST_LEAD_CAP = 0.3;

/**
 * Re-review fix-ups (STUDDRAW-R4R-EXPLOIT-1 / RR1-MEASUREMENT-2) — Five Card Draw after the draw, a MANIAC's LEADS: it
 * leads a made hand from [0] on the fiveDrawGateScore scale (a pair of kings) and the share [1] of its no-pair hands;
 * it checks every other pair (the core's MANIAC leads every hand it is checked). A lead of every hand was the line's
 * profit: with one capped size, calling every MANIAC lead with any pair, shoving aces up or better over it and
 * value-betting two pair or better when checked to won +125 BB/100 vs MANIAC x4 with 40 BB and +117 to +192 at
 * 100 BB on single seeds (live 0dc1b96 -213 to -252; cdfc8a1 +89 / +272 over 2-3 seeds); with this, -79 +- 34
 * [3 seeds] and -223 +- 76 [2 seeds]. Its checked range then holds the middle pairs, which call more
 * (FIVE_DRAW_POST_CHECKED_PO). Fix-up 3: with seats still to act behind it (FIVE_DRAW_POST_MANIAC_MIX), and the
 * no-pair share is 0.35 (was 0.5): it now traps a share of its kings or better, and the lower air share keeps its
 * leads about as strong as before.
 */
export const FIVE_DRAW_POST_MANIAC_LEAD: readonly [number, number] = [1 + 11 / 13, 0.35];

/**
 * Fix-up 3 (STUDDRAW-RR2-EXPLOIT-1 / R4RR-REGRESSION-1) — Five Card Draw after the draw, a MANIAC with players still to
 * act behind it: it also leads the share [0] of the pairs under FIVE_DRAW_POST_MANIAC_LEAD[0] and checks (traps) the
 * share [1] of the hands from it, so its check is not a capped range. When every other live seat has checked to it
 * (fiveDrawPostCheckedToLast) it bets as the core MANIAC does, every hand at the capped size. With every pair under
 * K-K checked and every K-K or better led, its check never held two pair or K-K, and the gate folds such a range to an
 * overbet shove: calling up to 10 BB before the draw with any five cards on the button only, then shoving two pair or
 * better, or any hand once every seat had checked, won +66 +- 19 BB/100 vs MANIAC x4 [8 seeds] (live 0dc1b96 -88);
 * a short stack's checked hands got to showdown free (calling up to 10 BB, then shoving two pair or better with
 * 20-30 BB: about +110 BB/100 over the same line without the polarized lead, to break-even; live -230).
 */
export const FIVE_DRAW_POST_MANIAC_MIX: readonly [number, number] = [0.5, 0.3];

/** Fix-up 3 — after the draw, has every other live seat with chips behind already checked this round (this seat acts last)? */
function fiveDrawPostCheckedToLast(table: PokerTable, seat: Seat): boolean {
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated || s.allIn) continue;
    if (!table.actionLog.some((e) => e.street === table.currentPhase && e.seatIndex === s.seatIndex && e.action === 'checked')) return false;
  }
  return true;
}

/**
 * Re-review fix-ups — Five Card Draw after the draw: how much lower a seat that CHECKED this round reads the gate's
 * price for a bet that is not an all-in (its checked range holds the pairs it did not lead). Only the MANIAC polarizes
 * its leads. Not for an all-in: read lower there too, the checked MANIAC called a 30 BB value shove into 50 BB with
 * almost any pair (two pair or better shoved after the draw: +168 / +89 BB/100 on single seeds; without it +108 / +36).
 */
export const FIVE_DRAW_POST_CHECKED_PO: Record<Archetype, number> = {
  NIT: 0, ROCK: 0, TAG: 0, LAG: 0, MANIAC: 0.08, FISH: 0, CALLING_STATION: 0,
};

/**
 * Fix round 4 review fix-ups (MEASUREMENT-2) — the depth at risk for the 5CD post-draw bet gate (chips): the
 * SHORTEST live opponent whose shove over the bet could commit this seat (his stack this round). Keyed on the
 * deepest opponent, a LAG / MANIAC in a multiway pot bet a 40 BB human's whole remaining stack with one pair or two
 * pair (the deep bots set the depth), then was pot-committed to his shove: calling raises up to 10 BB with any five
 * cards, then betting two pair or better at 0.4 pot (shoving over any bet) won +58 BB/100 vs MANIAC x4 [6 seeds]
 * (live 0dc1b96 about -215). Heads-up the two are the same seat.
 * Re-review fix-ups (STUDDRAW-R4F-REGRESSION-1): an opponent with less than FIVE_DRAW_POST_SHALLOW_BB behind does
 * not count: his shove over a bet commits nobody (the call gate does not ask a class of such an all-in). Counted,
 * a third seat with 1 BB behind silenced a LAG / MANIAC's bets into a 100 BB human (0 of 90 K-K-Q-Q leads;
 * c2b81d4 and live 28), and a human with 10 BB behind was never bet into below aces up (live 15 of 15). 0 (no
 * limit) when no live opponent has that much behind.
 */
function fiveDrawPostBetDepth(table: PokerTable, seat: Seat, bigBlind: number): number {
  let shortest = 0;
  for (const s of table.seats) {
    if (s.seatIndex === seat.seatIndex || s.state !== 'occupied' || s.folded || s.eliminated) continue;
    if (s.chipCount < FIVE_DRAW_POST_SHALLOW_BB * bigBlind) continue;
    const st = s.chipCount + s.currentBet;
    shortest = shortest === 0 ? st : Math.min(shortest, st);
  }
  return shortest;
}

function postFlopStrategyCore(
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
  oppCategory: OpponentCategory,
  // 2026-11 (bots review B12): the Hold'em street this betting round plays like
  // (identity in the board games): Stud 4th = Flop, 5th/6th = Turn, 7th = River;
  // Triple Draw / Badugi Bet2 = Flop, Bet3 = Turn, Bet4 = River; Five Card Draw Bet2 = River.
  street: GamePhase = table.currentPhase
): AIDecision {
  const isRiver = street === GamePhase.River;
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
  const streetCaution = isRiver ? 0.06 : (street === GamePhase.Turn ? 0.03 : 0);
  const callDownAdj = (params.callDownTendency - 0.5) * 0.20 + (oppCategory === 'maniac' ? 0.10 : 0);
  const stickyPool = oppCategory === 'station' || oppCategory === 'fish';
  const foldyPool = oppCategory === 'nit' || oppCategory === 'tag';

  // Fix round 4 (bots review, studdraw MEAS-1 / MEAS-2, EXPLOIT-1 / EXPLOIT-2) — Stud / Draw ONLY:
  // sdKind is null on Hold'em, Omaha, Short Deck and Pineapple, whose decisions do not change.
  //  - Five Card Draw after the draw: a call that commits the depth at risk folds the hands
  //    fiveDrawPostFolds names: the made hand needed rises smoothly with the price, from one pair (by
  //    rank) through two pair (from 0.30 for a bet, 0.36 for an all-in) to aces up and trips on
  //    overbets (FIVE_DRAW_POST_CLASS_PO), never above the stack-off class; an overcall needs more
  //    (FIVE_DRAW_POST_OVERCALL); it phases in with the share of the depth the call puts in (from a
  //    sixth to a third) and, against an all-in, with the depth (12-20 BB); FISH / CALLING_STATION
  //    read the price lower (FIVE_DRAW_POST_LOOSE_PO), and so does a MANIAC that checked, for a bet
  //    (FIVE_DRAW_POST_CHECKED_PO); an all-in over chips this seat already put in this round (its lead,
  //    raise or call) asks two pair, no ramp.
  //  - Fixed limit, the rounds after the first: facing ONE bet, a pot share that clears the price
  //    (STUD_DRAW_FL_CALL_MARGIN) calls in the NIT / ROCK / MANIAC branches, which folded under a
  //    flat 0.55 / 0.30 / 0.25 whatever the pot laid.
  const sdKind = studDrawKindOfTable(table);
  if (sdKind === 'draw-hi' && table.bettingStructure === 'no-limit' && callAmount > 0
    && drawsLeftAt(sdKind, table.currentPhase) === 0
    && fiveDrawPostCommits(table, seat, callAmount) > 0
    && fiveDrawPostFolds(seat.holeCards, potOdds, profile.archetype, fiveDrawPostShoveLike(table, seat, callAmount, bigBlind),
      fiveDrawPostDepth(table, seat) / Math.max(1, bigBlind), fiveDrawPostOvercall(table, seat), fiveDrawPostCommits(table, seat, callAmount),
      table.actionLog.some((e) => e.street === table.currentPhase && e.seatIndex === seat.seatIndex && e.action === 'checked'),
      seat.currentBet > 0)) {
    return { action: PlayerAction.Fold, raiseAmount: 0 };
  }
  const flPotOddsCall = sdKind !== null && table.bettingStructure === 'fixed-limit' && callAmount > 0
    && (Number((table as any).raisesThisStreet) || 0) <= 1 && effectiveStrength >= potOdds + STUD_DRAW_FL_CALL_MARGIN;

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
    if (effectiveStrength < 0.25 && !flPotOddsCall) return { action: PlayerAction.Fold, raiseAmount: 0 };
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
    // Folds anything below top pair to a bet (fix round 4: Stud / Draw fixed limit, one bet: by the price)
    if (effectiveStrength < 0.55) return flPotOddsCall ? { action: PlayerAction.Call, raiseAmount: 0 } : { action: PlayerAction.Fold, raiseAmount: 0 };
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
    if (effectiveStrength < 0.30 && !flPotOddsCall) return { action: PlayerAction.Fold, raiseAmount: 0 };
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
      const betSize = getGTOBetSize(rawStrength, totalPot, bigBlind, seat.chipCount, board, street, profile);
      if (betSize >= minRaise) return { action: PlayerAction.Raise, raiseAmount: betSize };
    }

    // Medium hand: mostly pot-control, but take a THIN VALUE bet when the wired
    // river logic says it's +EV (loose opponents, safe board, difficulty-scaled).
    if (effectiveStrength > 0.4) {
      if (shouldThinValueBet(rawStrength, street, board, oppNames, profile)) {
        const betSize = Math.max(minRaise, Math.round(totalPot * (0.33 + Math.random() * 0.12)));
        if (betSize <= seat.chipCount) return { action: PlayerAction.Raise, raiseAmount: betSize };
      }
      return { action: PlayerAction.Check, raiseAmount: 0 };
    }

    // Weak hand: BALANCED bluff decision (hand-strength band + board "story" +
    // opponent pool aware). This wires shouldBluffBalanced as the real bluff
    // engine, replacing the old raw coin-flip on effectiveBluffFreq.
    if (shouldBluffBalanced(rawStrength, board, street, profile, oppNames)) {
      // 2026-07-07 review fix: both map to getGTOBetSize's BIG (polarized) band,
      // and the semi-bluff value (0.9) is additionally overbet-eligible, so
      // semi-bluffs bet a touch bigger than pure bluffs (was inverted).
      const bluffSizeStrength = outs >= 8 ? 0.9 : 0.5;
      const betSize = getGTOBetSize(bluffSizeStrength, totalPot, bigBlind, seat.chipCount, board, street, profile);
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
      getGTOBetSize(rawStrength, potAfterCall, bigBlind, seat.chipCount, board, street, profile));
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
  if (!isRiver && shouldBluffBalanced(rawStrength, board, street, profile, oppNames)) {
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
  // NEW-1 (2026-11): HAND-START stacks (chips behind + chips put in this hand).
  // It read the chips LEFT, so an all-in opponent counted 0 and every lone
  // 100 BB shove looked like a 1 BB stack (push/fold call floor: ~65% of hands).
  let largestOpp = 0;
  for (const s of table.seats) {
    if (s.seatIndex === mySeat) continue;
    if (s.state !== 'occupied' || s.folded || s.eliminated) continue;
    largestOpp = Math.max(largestOpp, handStartStack(s));
  }
  const effective = Math.min(handStartStack(seat), largestOpp);
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

/**
 * Heads-up showdown equity against the opponent's ACTUAL hole cards
 * (2026-10-11, .online fix round 1 — ECON-1 / TABLEUI-1, all-in insurance).
 *
 * The old insurance quote fed the training engine's Monte-Carlo equity — a
 * PERCENT (0-100) against a RANDOM hand — into a pricing helper that expects a
 * 0..1 fraction: every quote clamped to 100% and paid 90% of the pot for ANY
 * hand (live mint, 1.47M chips). Insurance is only offered once the betting is
 * closed heads-up, so both hands are known: this module prices against them.
 *
 *  - <= 2 board cards to come (flop / turn): EXACT enumeration of every
 *    remaining board (C(45,2) = 990 / 44 runouts).
 *  - more to come (pre-flop): DETERMINISTIC Monte Carlo (seeded PRNG — the same
 *    seed gives the same number, so a quote is reproducible and testable).
 *
 * `fastHandScore` ranks 5-7 Hold'em cards into one comparable integer. It
 * orders hands exactly like HandEvaluator's evaluateHand + compareTo (the
 * engine's showdown) — pinned by tests/insuranceEquity.test.ts on random and
 * edge-case deals — but without allocations, so a pre-flop estimate costs
 * milliseconds instead of the ~40us/hand of the generic evaluator.
 */
import { Card } from './Card';

const RANK_SHIFT = [16 ** 4, 16 ** 3, 16 ** 2, 16, 1];
const CATEGORY_UNIT = 16 ** 5;

/** Highest straight in a rank bitmask (bit r set = rank r present, Ace = 14), else 0. Wheel = 5. */
function straightHigh(mask: number): number {
  for (let high = 14; high >= 6; high--) {
    const need = (0b11111 << (high - 4));
    if ((mask & need) === need) return high;
  }
  // A-2-3-4-5: bits 14, 2, 3, 4, 5.
  const wheel = (1 << 14) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
  return (mask & wheel) === wheel ? 5 : 0;
}

function score(category: number, ranks: number[]): number {
  let s = category * CATEGORY_UNIT;
  for (let i = 0; i < ranks.length && i < 5; i++) s += ranks[i] * RANK_SHIFT[i];
  return s;
}

/** The top `n` ranks of a bitmask, highest first. */
function topRanks(mask: number, n: number, exclude: number[] = []): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) {
    if ((mask & (1 << r)) && !exclude.includes(r)) out.push(r);
  }
  return out;
}

/**
 * Comparable strength of the best 5-card Hold'em hand in `cards` (5-7 cards).
 * Higher is better; equal means a split pot.
 */
const COUNTS = new Int32Array(15);
const SUIT_COUNT = new Int32Array(4);
const SUIT_MASK = new Int32Array(4);

export function fastHandScore(cards: readonly Card[]): number {
  const counts = COUNTS; counts.fill(0);
  const suitCount = SUIT_COUNT; suitCount.fill(0);
  const suitMask = SUIT_MASK; suitMask.fill(0);
  let mask = 0;
  for (const c of cards) {
    counts[c.rank]++;
    suitCount[c.suit]++;
    suitMask[c.suit] |= (1 << c.rank);
    mask |= (1 << c.rank);
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit]);
    if (sf) return score(8, [sf]);
  }

  let quad = 0;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quad = quad || r;
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
  }

  if (quad) {
    const kicker = topRanks(mask, 1, [quad]);
    return score(7, [quad, ...kicker]);
  }
  if (trips.length >= 1 && (trips.length >= 2 || pairs.length >= 1)) {
    // Best trips; the pair part is the best of (second trips, best pair).
    const pairPart = Math.max(trips[1] || 0, pairs[0] || 0);
    return score(6, [trips[0], pairPart]);
  }
  if (flushSuit >= 0) return score(5, topRanks(suitMask[flushSuit], 5));
  const st = straightHigh(mask);
  if (st) return score(4, [st]);
  if (trips.length === 1) return score(3, [trips[0], ...topRanks(mask, 2, [trips[0]])]);
  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    return score(2, [p1, p2, ...topRanks(mask, 1, [p1, p2])]);
  }
  if (pairs.length === 1) return score(1, [pairs[0], ...topRanks(mask, 3, [pairs[0]])]);
  return score(0, topRanks(mask, 5));
}

/** 32-bit FNV-1a — the deterministic seed of a pre-flop estimate. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HeadsUpEquity {
  /** Runouts the hero wins outright / splits / loses. */
  wins: number;
  ties: number;
  losses: number;
  total: number;
  /** (wins + ties/2) / total — a fraction in [0, 1]. */
  equity: number;
  /** true = every remaining board was enumerated; false = seeded Monte Carlo. */
  exact: boolean;
}

export interface HeadsUpEquityOptions {
  /** Seed of the Monte-Carlo estimate (ignored when exact). */
  seed?: number;
  /** Monte-Carlo runouts (ignored when exact). Default 20,000. */
  samples?: number;
}

const cardKey = (c: Card): number => c.suit * 16 + c.rank;

/**
 * Hero's equity against the villain's KNOWN cards on `board` (0-5 cards).
 * Exact when at most two board cards remain, else a seeded Monte Carlo.
 * Throws on a malformed deal (duplicate cards, wrong counts) — callers treat
 * that as "no quote".
 */
export function headsUpEquity(
  hero: readonly Card[],
  villain: readonly Card[],
  board: readonly Card[],
  opts: HeadsUpEquityOptions = {}
): HeadsUpEquity {
  if (hero.length !== 2 || villain.length !== 2) throw new Error('headsUpEquity: two hole cards each');
  if (board.length > 5) throw new Error('headsUpEquity: board has more than 5 cards');
  const known = new Set<number>();
  for (const c of [...hero, ...villain, ...board]) {
    const k = cardKey(c);
    if (known.has(k) || !(c.rank >= 2 && c.rank <= 14) || !(c.suit >= 0 && c.suit <= 3)) {
      throw new Error('headsUpEquity: invalid or duplicate card');
    }
    known.add(k);
  }
  const deck: Card[] = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      if (!known.has(suit * 16 + rank)) deck.push({ suit, rank } as Card);
    }
  }

  const need = 5 - board.length;
  let wins = 0, ties = 0, losses = 0;
  // Two fixed 7-card hands: hole cards + known board, the runout written into
  // the tail in place (no per-runout allocation — a pre-flop quote scores 40k hands).
  const heroCards: Card[] = [...hero, ...board];
  const villCards: Card[] = [...villain, ...board];
  const fixedCount = heroCards.length;
  const tally = (extra: Card[]): void => {
    for (let i = 0; i < extra.length; i++) { heroCards[fixedCount + i] = extra[i]; villCards[fixedCount + i] = extra[i]; }
    const h = fastHandScore(heroCards);
    const v = fastHandScore(villCards);
    if (h > v) wins++;
    else if (h === v) ties++;
    else losses++;
  };

  let exact = true;
  if (need === 0) {
    tally([]);
  } else if (need === 1) {
    for (let i = 0; i < deck.length; i++) tally([deck[i]]);
  } else if (need === 2) {
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) tally([deck[i], deck[j]]);
    }
  } else {
    exact = false;
    const samples = Math.max(1, Math.floor(opts.samples ?? 20_000));
    const rand = mulberry32(opts.seed ?? 1);
    const work = deck.slice();
    const extra: Card[] = new Array(need);
    for (let s = 0; s < samples; s++) {
      // Partial Fisher-Yates: the first `need` slots become a uniform draw.
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rand() * (work.length - i));
        const t = work[i]; work[i] = work[j]; work[j] = t;
        extra[i] = work[i];
      }
      tally(extra);
    }
  }
  const total = wins + ties + losses;
  return { wins, ties, losses, total, equity: total > 0 ? (wins + ties / 2) / total : 0, exact };
}

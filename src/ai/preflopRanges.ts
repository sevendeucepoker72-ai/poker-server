// ============================================================================
// Solver-informed preflop ranges (2026-07-07 AI overhaul, Level 1).
//
// The old AI ranked starting hands with the 1970s Chen formula normalized by
// /20, which compressed every non-AA hand and made "open the top 15%" impossible
// to express. This module replaces that with an EQUITY-RANKED, COMBO-WEIGHTED
// percentile for all 169 canonical starting hands:
//
//   - At first use we Monte-Carlo each hand's heads-up equity vs a random hand,
//     sort by equity, and assign a percentile = 1 - (combo-weighted rank). So
//     AA ≈ 1.00 (top of the deck), 72o ≈ 0.00 (bottom), and "open the top 15%"
//     becomes literally `percentile >= 0.85`.
//   - Position buckets carry real solver-sized open/3-bet/4-bet/defend
//     thresholds (UTG ~15%, CO ~27%, BTN ~45%, …). Archetypes widen/tighten
//     that base by a single factor, so the personalities are now parametric off
//     one principled range instead of scattered magic literals.
//
// Dependency-clean: imports only Card + the hand evaluator (no cycle with
// TrainingEngine, which imports getPreflopPercentile back for range-aware equity).
// ============================================================================
import { Card, Rank, Suit } from '../game/Card';
import { evaluateHand, compareTo } from '../game/HandEvaluator';

const RANK_CHAR: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};

/** Canonical 169-hand code: "AA", "AKs", "AKo", "72o", … (high card first). */
export function handCodeFrom(r1: number, r2: number, suited: boolean): string {
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return RANK_CHAR[hi] + RANK_CHAR[hi];
  return RANK_CHAR[hi] + RANK_CHAR[lo] + (suited ? 's' : 'o');
}

export function getHandCode(holeCards: Card[]): string {
  if (!holeCards || holeCards.length < 2) return '';
  return handCodeFrom(holeCards[0].rank, holeCards[1].rank, holeCards[0].suit === holeCards[1].suit);
}

// ── Percentile table (lazy, cached) ─────────────────────────────────────────
let _pctile: Map<string, number> | null = null;

function buildDeck(): Card[] {
  const d: Card[] = [];
  for (let s = Suit.Hearts; s <= Suit.Spades; s++) {
    for (let r = Rank.Two; r <= Rank.Ace; r++) d.push({ suit: s, rank: r });
  }
  return d;
}

/** Heads-up equity of `hole` vs one random hand over `sims` runs (0..1). */
function equityVsRandom(hole: Card[], sims: number): number {
  const known = new Set<string>(hole.map((c) => `${c.rank}_${c.suit}`));
  const deck = buildDeck().filter((c) => !known.has(`${c.rank}_${c.suit}`));
  let win = 0, tie = 0, n = 0;
  for (let i = 0; i < sims; i++) {
    // Fisher-Yates partial shuffle of the first 7 slots (5 board + 2 opp).
    for (let k = 0; k < 7; k++) {
      const j = k + Math.floor(Math.random() * (deck.length - k));
      const t = deck[k]; deck[k] = deck[j]; deck[j] = t;
    }
    const board = deck.slice(0, 5);
    const opp = deck.slice(5, 7);
    const me = evaluateHand([...hole, ...board]);
    const them = evaluateHand([...opp, ...board]);
    const cmp = compareTo(me, them);
    if (cmp > 0) win++; else if (cmp === 0) tie++;
    n++;
  }
  return n > 0 ? (win + tie / 2) / n : 0.5;
}

/** Build the combo-weighted percentile table once. ~169 * SIMS evaluations. */
function ensureTable(): void {
  if (_pctile) return;
  const SIMS = 600; // enough for a stable ranking (±~2% equity noise, order stable)
  const hands: { code: string; combos: number; eq: number }[] = [];
  for (let hi = Rank.Two; hi <= Rank.Ace; hi++) {
    for (let lo = Rank.Two; lo <= hi; lo++) {
      if (hi === lo) {
        // pair — 6 combos
        const hole = [{ suit: Suit.Hearts, rank: hi }, { suit: Suit.Spades, rank: hi }];
        hands.push({ code: handCodeFrom(hi, lo, false), combos: 6, eq: equityVsRandom(hole, SIMS) });
      } else {
        // suited — 4 combos
        const suited = [{ suit: Suit.Hearts, rank: hi }, { suit: Suit.Hearts, rank: lo }];
        hands.push({ code: handCodeFrom(hi, lo, true), combos: 4, eq: equityVsRandom(suited, SIMS) });
        // offsuit — 12 combos
        const off = [{ suit: Suit.Hearts, rank: hi }, { suit: Suit.Spades, rank: lo }];
        hands.push({ code: handCodeFrom(hi, lo, false), combos: 12, eq: equityVsRandom(off, SIMS) });
      }
    }
  }
  hands.sort((a, b) => b.eq - a.eq); // strongest first
  const total = hands.reduce((s, h) => s + h.combos, 0); // 1326
  const map = new Map<string, number>();
  let running = 0;
  for (const h of hands) {
    const midpoint = running + h.combos / 2;
    map.set(h.code, 1 - midpoint / total); // AA≈0.998 (top), 72o≈~0.002 (bottom)
    running += h.combos;
  }
  _pctile = map;
}

/** Preflop strength as a real range PERCENTILE: 1.0 = AA, ~0.85 = top 15%. */
export function getPreflopPercentile(holeCards: Card[]): number {
  if (!holeCards || holeCards.length < 2) return 0;
  ensureTable();
  return _pctile!.get(getHandCode(holeCards)) ?? 0;
}

/** Percentile by (rank, rank, suited) — used by the range-aware equity sampler. */
export function percentileByRanks(r1: number, r2: number, suited: boolean): number {
  ensureTable();
  return _pctile!.get(handCodeFrom(r1, r2, suited)) ?? 0;
}

// ── Position-bucketed range thresholds (solver-sized) ───────────────────────
// A hand "qualifies" for an action when its percentile >= the threshold. The
// numbers ARE the range sizes: 0.85 = top 15%, 0.73 = top 27%, etc.
export type PosBucket = 'EP' | 'MP' | 'CO' | 'BTN' | 'SB' | 'BB';

/** Map a relative position index (0 = first to act) to a position bucket. */
export function posBucket(position: number, totalActive: number): PosBucket {
  if (totalActive <= 2) return position === 0 ? 'SB' : 'BB'; // heads-up
  const fromEnd = totalActive - 1 - position; // 0 = button-ish (last non-blind)
  if (position >= totalActive - 2) return position === totalActive - 2 ? 'SB' : 'BB';
  if (fromEnd <= 2) return 'BTN';
  if (fromEnd <= 3) return 'CO';
  if (position <= 1) return 'EP';
  return 'MP';
}

/** Unopened-pot RFI (raise-first-in) threshold by position. */
export const OPEN_THRESHOLD: Record<PosBucket, number> = {
  EP: 0.85,  // ~15%
  MP: 0.80,  // ~20%
  CO: 0.72,  // ~28%
  BTN: 0.55, // ~45%
  SB: 0.60,  // ~40% (raise-or-fold)
  BB: 0.70,  // BB rarely "opens"; used only when checked to
};

/** Value-3-bet threshold (facing a single raise), by the 3-bettor's position. */
export const THREEBET_THRESHOLD: Record<PosBucket, number> = {
  EP: 0.93, MP: 0.92, CO: 0.90, BTN: 0.88, SB: 0.91, BB: 0.90,
};

/** 4-bet-for-value threshold. */
export const FOURBET_THRESHOLD = 0.965; // ~ QQ+/AK top

/** How wide to flat/defend vs a single raise (call, not 3-bet), by position.
 * 2026-07-07 tuning: tightened the wide late-position flats (CO/BTN) — the bots
 * were flatting too loose IP, pushing TAG VPIP into LAG territory (~40%). BB
 * defence stays wide (correct). */
export const CALL_VS_RAISE_THRESHOLD: Record<PosBucket, number> = {
  EP: 0.83, MP: 0.79, CO: 0.74, BTN: 0.65, SB: 0.73, BB: 0.55,
};

/**
 * Per-archetype range-width factor. >1 tightens (raise thresholds up), <1
 * loosens. Applied to the position base so every archetype derives from ONE
 * solver-informed range instead of scattered literals. Also lets the vpip knob
 * matter: looser archetypes open more.
 */
export const ARCHETYPE_RANGE_FACTOR: Record<string, number> = {
  NIT: 1.10,
  ROCK: 1.06,
  TAG: 1.06,   // 2026-07-07 tuning: was 1.00 — nudge TAG genuinely tight-aggressive (~30% VPIP, not ~40%)
  LAG: 0.86,
  MANIAC: 0.60,
  CALLING_STATION: 0.80,
  FISH: 0.78,
};

/**
 * Widen/tighten a base percentile threshold by an archetype factor. Tightening
 * pushes the threshold toward 1.0 (fewer hands); loosening pulls it down.
 */
export function adjustThreshold(base: number, factor: number): number {
  // Express the range width (1-base), scale it by 1/factor (tighter factor →
  // narrower width → higher threshold), and clamp.
  const width = Math.max(0, 1 - base);
  const newWidth = width / Math.max(0.4, factor);
  return Math.min(0.99, Math.max(0.30, 1 - newWidth));
}

// ============================================================================
// Solver-informed preflop ranges (2026-07-07 AI overhaul, Level 1).
//
// The old AI ranked starting hands with the 1970s Chen formula normalized by
// /20, which compressed every non-AA hand and made "open the top 15%" impossible
// to express. This module replaces that with an EQUITY-RANKED, COMBO-WEIGHTED
// percentile for all 169 canonical starting hands:
//
//   - Each hand's heads-up equity vs a random hand is Monte-Carlo'd OFFLINE
//     (gen-preflop-table.ts at the repo root, fixed seed) and committed as
//     preflopTable.ts; sorted by equity, percentile = 1 - (combo-weighted
//     rank). So AA ≈ 1.00 (top of the deck), 32o ≈ 0.00 (bottom), and "open
//     the top 15%" becomes literally `percentile >= 0.85`. A second column
//     (stack-off) ranks the same hands by equity vs the top 15%.
//   - Position buckets carry real solver-sized open/3-bet/4-bet/defend
//     thresholds (UTG ~15%, CO ~27%, BTN ~45%, …). Archetypes widen/tighten
//     that base by a single factor, so the personalities are now parametric off
//     one principled range instead of scattered magic literals.
//
// Dependency-clean: imports only Card + the committed table (no cycle with
// TrainingEngine, which imports percentileByRanks back for range-aware equity).
// ============================================================================
import { Card } from '../game/Card';
import { PREFLOP_TABLE } from './preflopTable';

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

// ── Percentile tables (B10 / NEW-2, bots review 2026-11-04): COMMITTED ──────
// The table used to be Monte-Carlo-built lazily, synchronously and with
// Math.random on the first bot decision after every boot (169 hands x 600
// runs, ~710k Math.random calls): a 7-21 s whole-server freeze, and bot ranges
// that reshuffled on every deploy. It is now generated ONCE offline by
// gen-preflop-table.ts (repo root, fixed seed; VERIFY=1 re-checks it) and
// committed as preflopTable.ts. Loading it is two Map fills (169 rows, < 1 ms),
// zero Math.random calls, identical on every boot.
const _pctile: Map<string, number> = new Map();
const _stackOff: Map<string, number> = new Map();
for (const [code, , pctile, stackOff] of PREFLOP_TABLE) { _pctile.set(code, pctile); _stackOff.set(code, stackOff); }

/** Preflop strength as a real range PERCENTILE: 1.0 = AA, ~0.85 = top 15%. */
export function getPreflopPercentile(holeCards: Card[]): number {
  if (!holeCards || holeCards.length < 2) return 0;
  return _pctile.get(getHandCode(holeCards)) ?? 0;
}

/** Percentile by (rank, rank, suited) — used by the range-aware equity sampler. */
export function percentileByRanks(r1: number, r2: number, suited: boolean): number {
  return _pctile.get(handCodeFrom(r1, r2, suited)) ?? 0;
}

/**
 * STACK-OFF percentile (bots review 2026-11-04): the same combo-weighted scale,
 * but ranked by equity vs a STRONG range (the top 15% by percentile) instead
 * of vs a random hand. For use only where the bot is up against a strong range
 * (4-bets, deep stack-offs), so AK / QQ rank above 88 / 77 there (vs a random
 * hand small pairs outrank AK).
 */
export function getStackOffPercentile(holeCards: Card[]): number {
  if (!holeCards || holeCards.length < 2) return 0;
  return _stackOff.get(getHandCode(holeCards)) ?? 0;
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

/** 4-bet-for-value threshold on the getPreflopPercentile scale. Kept for
 * non-Hold'em strengths (Omaha); the Hold'em 4-bet / stack-off line is
 * FOURBET_STACKOFF_THRESHOLD below, on the stack-off scale (wired into
 * AIPlayer by holdem-preflop C10). */
export const FOURBET_THRESHOLD = 0.965; // equity-vs-random scale: AA-88 + AKs

/**
 * 4-bet-for-value / 5-bet threshold on the STACK-OFF scale
 * (getStackOffPercentile): exactly JJ+, AKs, AKo (40 combos, 3.0%). Re-centred
 * in the AKo (.97436) / TT (.96757) gap of the 50k-sim stack-off column
 * (midpoint .970965), the widest margin on either side.
 * tests/botPreflopTable.test.ts pins the set.
 */
export const FOURBET_STACKOFF_THRESHOLD = 0.971;

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

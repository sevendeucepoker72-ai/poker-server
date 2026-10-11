/**
 * Client-supplied table configuration, validated (2026-10-11, .online R1 — AUTH-4).
 *
 * createPrivateTable took `minBuyIn` straight from the client: -1,000,000 made a
 * table whose buy-in clamp produced a NEGATIVE buy-in, deductChips(-n) ran
 * `chips = chips - (-n)` (a wallet CREDIT), sitDown seated the negative stack
 * and leaving credited 0 — a live mint. The club table / scheduled table /
 * club challenge paths took their numbers the same way. Every client-created
 * table now goes through validateTableConfig (blinds, ante, buy-in, seats,
 * variant, name) and every club challenge through validateChallengeStakes;
 * authManager's chip paths and PokerTable.sitDown refuse bad amounts as a
 * second line of defence.
 */
import type { VariantType } from './variants/PokerVariant';

export const TABLE_CONFIG_LIMITS = {
  /** Highest small / big blind a player may set. */
  MAX_BLIND: 1_000_000,
  /** A fresh stack is at least this many big blinds… */
  MIN_BUY_IN_BIG_BLINDS: 10,
  /** …and at most this many. */
  MAX_BUY_IN_BIG_BLINDS: 1_000,
  /** Absolute cap on minBuyIn: every join clamps a buy-in to 10 x minBuyIn, which must stay far below users.chips' INTEGER range. */
  MAX_MIN_BUY_IN: 100_000_000,
  MAX_NAME_LENGTH: 40,
  MIN_CHALLENGE_STAKES: 100,
  MAX_CHALLENGE_STAKES: 10_000_000,
} as const;

/** Variants a client may ask for (TableManager.createVariantTable's own list). */
export const CLIENT_TABLE_VARIANTS: readonly VariantType[] = [
  'texas-holdem', 'omaha', 'omaha-hi-lo', 'omaha-5', 'omaha-6', 'short-deck', 'five-card-draw', 'triple-draw',
  'badugi', 'seven-card-stud', 'seven-card-stud-hi-lo', 'razz', 'pineapple', 'crazy-pineapple',
] as VariantType[];

export interface TableConfigDefaults {
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  /** A number, or derived from the (validated) big blind. */
  minBuyIn: number | ((bigBlind: number) => number);
  maxBuyIn?: number | ((bigBlind: number) => number);
  variant?: VariantType;
}

export interface ValidTableConfig {
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minBuyIn: number;
  /** Present only when the input or the defaults carry one (club tables store it). */
  maxBuyIn?: number;
  /** Present only when the input carries one. */
  maxSeats?: number;
  variant: VariantType;
}

export type TableConfigCheck =
  | { ok: true; config: ValidTableConfig }
  | { ok: false; code: 'invalid_table_config'; error: string };

const bad = (why: string): TableConfigCheck => ({ ok: false, code: 'invalid_table_config', error: `Invalid table settings: ${why}` });

/** undefined / null / '' -> the default; a number or numeric string -> that number; anything else -> NaN. */
function numberOr(value: unknown, dflt: number): number {
  if (value === undefined || value === null || value === '') return dflt;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

const isWhole = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n);

/** A table title other players see: printable, single-spaced, bounded. */
export function sanitizeTableName(value: unknown, dflt: string): string {
  if (typeof value !== 'string') return dflt;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, TABLE_CONFIG_LIMITS.MAX_NAME_LENGTH).trim();
  return cleaned || dflt;
}

/**
 * Validate a client's table configuration. Absent fields take the defaults;
 * a present field must be a whole number in range. Rules: 1 <= small blind
 * <= big blind <= MAX_BLIND (big blind >= 2); 0 <= ante <= big blind;
 * 10 BB <= minBuyIn <= 1,000 BB (and <= MAX_MIN_BUY_IN); minBuyIn <= maxBuyIn
 * <= 10 x MAX_MIN_BUY_IN; 2 <= maxSeats <= 9; a known variant.
 */
export function validateTableConfig(input: unknown, defaults: TableConfigDefaults): TableConfigCheck {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const L = TABLE_CONFIG_LIMITS;

  const smallBlind = numberOr(src.smallBlind, defaults.smallBlind);
  if (!isWhole(smallBlind) || smallBlind < 1 || smallBlind > L.MAX_BLIND) return bad('small blind must be a whole number from 1 to 1,000,000');
  const bigBlind = numberOr(src.bigBlind, defaults.bigBlind);
  if (!isWhole(bigBlind) || bigBlind < 2 || bigBlind < smallBlind || bigBlind > L.MAX_BLIND) return bad('big blind must be a whole number, at least 2 and at least the small blind');
  const ante = numberOr(src.ante, defaults.ante ?? 0);
  if (!isWhole(ante) || ante < 0 || ante > bigBlind) return bad('ante must be a whole number from 0 to the big blind');

  const dfltMin = typeof defaults.minBuyIn === 'function' ? defaults.minBuyIn(bigBlind) : defaults.minBuyIn;
  const minBuyIn = numberOr(src.minBuyIn, dfltMin);
  if (!isWhole(minBuyIn) || minBuyIn <= 0) return bad('minimum buy-in must be a positive whole number');
  if (minBuyIn < L.MIN_BUY_IN_BIG_BLINDS * bigBlind) return bad(`minimum buy-in must be at least ${L.MIN_BUY_IN_BIG_BLINDS} big blinds`);
  if (minBuyIn > L.MAX_BUY_IN_BIG_BLINDS * bigBlind || minBuyIn > L.MAX_MIN_BUY_IN) return bad(`minimum buy-in must be at most ${L.MAX_BUY_IN_BIG_BLINDS} big blinds`);

  const config: ValidTableConfig = {
    tableName: sanitizeTableName(src.tableName, defaults.tableName),
    smallBlind, bigBlind, ante, minBuyIn,
    variant: defaults.variant ?? 'texas-holdem',
  };

  const dfltMax = typeof defaults.maxBuyIn === 'function' ? defaults.maxBuyIn(bigBlind) : defaults.maxBuyIn;
  if ((src.maxBuyIn !== undefined && src.maxBuyIn !== null && src.maxBuyIn !== '') || dfltMax !== undefined) {
    const maxBuyIn = numberOr(src.maxBuyIn, dfltMax ?? minBuyIn);
    if (!isWhole(maxBuyIn) || maxBuyIn < minBuyIn || maxBuyIn > L.MAX_MIN_BUY_IN * 10) return bad('maximum buy-in must be a whole number, at least the minimum buy-in');
    config.maxBuyIn = maxBuyIn;
  }
  if (src.maxSeats !== undefined && src.maxSeats !== null && src.maxSeats !== '') {
    const maxSeats = numberOr(src.maxSeats, 9);
    if (!isWhole(maxSeats) || maxSeats < 2 || maxSeats > 9) return bad('seats must be from 2 to 9');
    config.maxSeats = maxSeats;
  }
  if (src.variant !== undefined && src.variant !== null && src.variant !== '') {
    if (typeof src.variant !== 'string' || !CLIENT_TABLE_VARIANTS.includes(src.variant as VariantType)) return bad('unknown game variant');
    config.variant = src.variant as VariantType;
  }
  return { ok: true, config };
}

export type StakesCheck = { ok: true; stakes: number } | { ok: false; code: 'invalid_challenge_stakes'; error: string };

/** A club challenge's stakes are its buy-in (both players): a whole number of chips in range. */
export function validateChallengeStakes(value: unknown): StakesCheck {
  const L = TABLE_CONFIG_LIMITS;
  const n = numberOr(value, NaN);
  if (!isWhole(n) || n < L.MIN_CHALLENGE_STAKES || n > L.MAX_CHALLENGE_STAKES) {
    return { ok: false, code: 'invalid_challenge_stakes', error: `Challenge stakes must be a whole number of chips from ${L.MIN_CHALLENGE_STAKES.toLocaleString('en-US')} to ${L.MAX_CHALLENGE_STAKES.toLocaleString('en-US')}.` };
  }
  return { ok: true, stakes: n };
}

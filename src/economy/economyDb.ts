/**
 * Economy settlements (2026-10-11, .online R2 — ECON-6/7/10/12/16/17/18,
 * C5/C6/C7/C8/C9, APPUI-3/5/6/17/38).
 *
 * Every credit a player can claim or buy settles its LEDGER ROW and its
 * BALANCE CHANGE in ONE transaction, under the user's row lock
 * (`SELECT … FOR UPDATE` on users first, always, so two economy operations of
 * one account serialize and never deadlock):
 *   - a claim (daily login, spin, scratch card, mission, achievement, VIP
 *     monthly bonus, career venue, keyed one-off credit) pays only when its
 *     ledger INSERT … ON CONFLICT DO NOTHING returns a row — a second tab, a
 *     second seat or a retry pays nothing;
 *   - a purchase DEDUCTS the stars first, then grants (inventory row, chips,
 *     stars, booster, VIP time, Battle Pass premium); any refusal or error
 *     rolls the whole thing back, so a failed grant can never keep the stars
 *     and a failed deduct can never grant anything.
 * Before R2 the ledger committed first and the credit ran after it with
 * swallowed errors (a failed credit = a claimed-but-unpaid reward), cosmetics
 * were granted BEFORE the stars were deducted, and the daily streak compared a
 * UTC "yesterday" with a Denver claim date.
 *
 * Refusals are thrown as EconomyRefusal(code) inside the transaction (→
 * ROLLBACK) and returned to the caller as { ok:false, code }.
 */
import { getPool } from '../auth/authManager';
import { parseStatsColumn } from '../auth/loginIdentity';
import { LISTABLE_USER_SQL, publicDisplayName } from '../social/publicIdentity';
// ./schema also installs the BIGINT → number result parser at import time.
import { PUBLIC_ID_SQL } from './schema';
import {
  BUNDLE_CONTENTS, CHIP_PACK_PAYOUT, FIRST_CHIPS_WON_SEASON, LOGIN_CHIPS_BY_DAY, LOGIN_DAY7_MYSTERY_BOX, LOGIN_STARS_BY_DAY,
  MYSTERY_BOX_TIERS, MYSTERY_DUPLICATE_REFUND_SHARE, SCRATCH_DUPLICATE_STARS, SEASON_REWARDS, SHOP_PRICES,
  VIP_LOGIN_MULTIPLIER, isFreeForEveryone, loginCycleDay, normalizeItemType, rollMysteryBox, rollScratchCard, rollSpinWheel,
  type ItemType, type RewardRoll, type Rng,
} from './catalog';
import { monthDateRange } from './denverTime';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface TxPool extends Queryable {
  connect(): Promise<Queryable & { release(err?: unknown): void }>;
}

export class EconomyRefusal extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message || code);
    this.name = 'EconomyRefusal';
  }
}

export type Settled<T> = ({ ok: true } & T) | { ok: false; code: string };

const defaultPool = (): TxPool => getPool() as unknown as TxPool;

/** BEGIN … COMMIT on one pooled client; ROLLBACK + rethrow on any error. */
export async function withEconomyTx<T>(fn: (tx: Queryable) => Promise<T>, pool: TxPool = defaultPool()): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* the connection is reset by release(e) */ }
    throw e;
  } finally {
    c.release();
  }
}

/** Run a settlement; an EconomyRefusal becomes { ok:false, code } (other errors propagate). */
async function settle<T extends object>(fn: (tx: Queryable) => Promise<T>, pool?: TxPool): Promise<Settled<T>> {
  try {
    const out = await withEconomyTx(fn, pool);
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof EconomyRefusal) return { ok: false, code: e.code };
    throw e;
  }
}

const DENVER_TODAY = `(NOW() AT TIME ZONE 'America/Denver')::date`;

export interface Balances { chips: number; stars: number; scratchCardsAvailable: number }

interface LockedUser {
  id: number;
  chips: number;
  stars: number;
  stats: Record<string, any>;
  achievements: string[];
  loginStreak: number;
  lastLoginClaimDate: string | null;
  nextLoginStreak: number;
  scratch: number;
  denverToday: string;
}

function parseAchievementList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === 'string');
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch { return []; }
}

/** The user's row, locked for the rest of the transaction. The Denver streak is computed HERE, in SQL (ECON-4). */
async function lockUser(tx: Queryable, userId: number): Promise<LockedUser> {
  const { rows } = await tx.query(
    `SELECT id, chips, stars, stats::text AS stats, achievements::text AS achievements,
            COALESCE(login_streak, 0) AS login_streak,
            to_char(last_login_claim_date, 'YYYY-MM-DD') AS last_login_claim_date,
            CASE WHEN last_login_claim_date = ${DENVER_TODAY} - 1 THEN COALESCE(login_streak, 0) + 1 ELSE 1 END AS next_login_streak,
            COALESCE(scratch_cards_available, 0) AS scratch_cards_available,
            to_char(${DENVER_TODAY}, 'YYYY-MM-DD') AS denver_today
       FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw new EconomyRefusal('no_account');
  return {
    id: Number(r.id),
    chips: Number(r.chips) || 0,
    stars: Number(r.stars) || 0,
    stats: parseStatsColumn(r.stats),
    achievements: parseAchievementList(r.achievements),
    loginStreak: Number(r.login_streak) || 0,
    lastLoginClaimDate: r.last_login_claim_date || null,
    nextLoginStreak: Math.max(1, Number(r.next_login_streak) || 1),
    scratch: Number(r.scratch_cards_available) || 0,
    denverToday: String(r.denver_today),
  };
}

const wholeNonNeg = (n: unknown): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

async function credit(tx: Queryable, userId: number, chips: number, stars: number): Promise<Balances> {
  const { rows } = await tx.query(
    `UPDATE users SET chips = chips + $2, stars = COALESCE(stars, 0) + $3 WHERE id = $1
     RETURNING chips, stars, COALESCE(scratch_cards_available, 0) AS scratch_cards_available`,
    [userId, wholeNonNeg(chips), wholeNonNeg(stars)],
  );
  if (!rows[0]) throw new Error(`credit: no users row ${userId}`);
  return { chips: Number(rows[0].chips), stars: Number(rows[0].stars), scratchCardsAvailable: Number(rows[0].scratch_cards_available) };
}

async function deductStars(tx: Queryable, userId: number, cost: number): Promise<void> {
  const c = Math.floor(Number(cost));
  if (!Number.isFinite(c) || c < 0) throw new EconomyRefusal('invalid_price');
  if (c === 0) return;
  const r = await tx.query('UPDATE users SET stars = stars - $2 WHERE id = $1 AND stars >= $2 RETURNING stars', [userId, c]);
  if (!r.rowCount) throw new EconomyRefusal('not_enough_stars');
}

/** INSERT the inventory row; true when it is NEW (false = already owned). */
async function grantItemTx(tx: Queryable, userId: number, type: string, id: string): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO user_inventory (user_id, item_type, item_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, item_type, item_id) DO NOTHING RETURNING 1`,
    [userId, normalizeItemType(type), id],
  );
  return (r.rowCount || 0) > 0;
}

async function writeStats(tx: Queryable, userId: number, stats: Record<string, any>): Promise<void> {
  await tx.query('UPDATE users SET stats = $2 WHERE id = $1', [userId, JSON.stringify(stats)]);
}

// ───────────────────────────── VIP / boosters (pure) ─────────────────────────────

export function vipActiveIn(stats: Record<string, any>, now: number): boolean {
  return Number(stats?.vipExpiresAt) > now;
}
/** The live chip-booster multiplier in a stats object (1 when none). */
export function chipBoostIn(stats: Record<string, any>, now: number): number {
  const b = stats?.activeBoosters?.chip;
  const mult = Number(b?.mult);
  return b && Number(b.expiresAt) > now && mult > 0 ? mult : 1;
}
const boosted = (amount: number, mult: number) => Math.round(wholeNonNeg(amount) * (mult > 0 ? mult : 1));

/** Apply a reward roll inside a transaction. A duplicate item becomes stars (`dupStars`). */
async function applyRoll(
  tx: Queryable, userId: number, roll: RewardRoll, dupStars: number,
): Promise<{ chips: number; stars: number; result: MysteryResult }> {
  if (roll.kind === 'chips') return { chips: roll.amount, stars: 0, result: { kind: 'chips', amount: roll.amount } };
  if (roll.kind === 'stars') return { chips: 0, stars: roll.amount, result: { kind: 'stars', amount: roll.amount } };
  // An item everyone can already use (a free wheel emote) is never 'won': it pays the duplicate stars.
  const fresh = !isFreeForEveryone(roll.itemType, roll.itemId) && await grantItemTx(tx, userId, roll.itemType, roll.itemId);
  if (fresh) return { chips: 0, stars: 0, result: { kind: 'item', itemType: roll.itemType, itemId: roll.itemId } };
  return {
    chips: 0, stars: dupStars,
    result: { kind: 'stars', amount: dupStars, reason: 'duplicate_refund', itemType: roll.itemType, itemId: roll.itemId },
  };
}

/** What a mystery box / scratch card / Day-7 box gave: `{kind, amount}` or `{kind:'item', itemType, itemId}`. */
export type MysteryResult =
  | { kind: 'chips'; amount: number }
  | { kind: 'stars'; amount: number; reason?: 'duplicate_refund'; itemType?: string; itemId?: string }
  | { kind: 'item'; itemType: string; itemId: string };

// ───────────────────────────── Daily login (ECON-4 / C8) ─────────────────────────────

export interface DailyLoginResult {
  day: number; streak: number; chips: number; stars: number;
  baseChips: number; baseStars: number; vip: boolean; chipBoost: number;
  mysteryBox: MysteryResult | null;
  lastLoginClaimDate: string; balances: Balances;
}

/**
 * The daily login reward: once per Denver day (ledger `login`), the streak
 * continues only when the last claim was the Denver YESTERDAY (computed in SQL),
 * +50% chips and stars while a VIP pass is active (C8), the chip booster on the
 * chips, and Day 7 also opens a real basic Mystery Box (what the UI advertises).
 */
export async function settleDailyLogin(userId: number, opts: { now?: number; rng?: Rng } = {}, pool?: TxPool): Promise<Settled<DailyLoginResult>> {
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  return settle(async (tx) => {
    const u = await lockUser(tx, userId);
    if (u.lastLoginClaimDate === u.denverToday) throw new EconomyRefusal('already_claimed');
    const streak = u.nextLoginStreak;
    const day = loginCycleDay(streak);
    const vip = vipActiveIn(u.stats, now);
    const chipBoost = chipBoostIn(u.stats, now);
    const baseChips = LOGIN_CHIPS_BY_DAY[day] || 0;
    const baseStars = LOGIN_STARS_BY_DAY[day] || 0;
    let chips = boosted(vip ? Math.round(baseChips * VIP_LOGIN_MULTIPLIER) : baseChips, chipBoost);
    let stars = vip ? Math.round(baseStars * VIP_LOGIN_MULTIPLIER) : baseStars;
    let mysteryBox: MysteryResult | null = null;
    // The claim row FIRST: a second tab's insert loses here and pays nothing.
    const ledger = await tx.query(
      `INSERT INTO user_daily_claims (user_id, claim_type, claim_date, payload) VALUES ($1, 'login', ${DENVER_TODAY}, $2::jsonb)
         ON CONFLICT (user_id, claim_type, claim_date) DO NOTHING RETURNING 1`,
      [userId, JSON.stringify({ day, streak, vip, chipBoost })],
    );
    if (!ledger.rowCount) throw new EconomyRefusal('already_claimed');
    if (day === 7) {
      const roll = rollMysteryBox(LOGIN_DAY7_MYSTERY_BOX, rng);
      const dupStars = Math.floor((SHOP_PRICES.mystery_box[LOGIN_DAY7_MYSTERY_BOX] || 0) * MYSTERY_DUPLICATE_REFUND_SHARE);
      const applied = await applyRoll(tx, userId, roll, dupStars);
      chips += applied.chips;
      stars += applied.stars;
      mysteryBox = applied.result;
    }
    await credit(tx, userId, chips, stars);
    const { rows } = await tx.query(
      `UPDATE users SET login_streak = $2, last_login_claim_date = ${DENVER_TODAY} WHERE id = $1
       RETURNING chips, stars, COALESCE(scratch_cards_available, 0) AS scratch_cards_available,
                 to_char(last_login_claim_date, 'YYYY-MM-DD') AS last_login_claim_date`,
      [userId, streak],
    );
    return {
      day, streak, chips, stars, baseChips, baseStars, vip, chipBoost, mysteryBox,
      lastLoginClaimDate: String(rows[0].last_login_claim_date),
      balances: { chips: Number(rows[0].chips), stars: Number(rows[0].stars), scratchCardsAvailable: Number(rows[0].scratch_cards_available) },
    };
  }, pool);
}

// ───────────────────────────── Daily spin (APPUI-37) ─────────────────────────────

export interface DailySpinResult { segmentId: string; label: string; chips: number; stars: number; chipBoost: number; balances: Balances }

export async function settleDailySpin(userId: number, opts: { now?: number; rng?: Rng } = {}, pool?: TxPool): Promise<Settled<DailySpinResult>> {
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  return settle(async (tx) => {
    const u = await lockUser(tx, userId);
    const seg = rollSpinWheel(rng);
    const chipBoost = chipBoostIn(u.stats, now);
    const chips = boosted(seg.chips, chipBoost);
    const stars = seg.stars;
    const ledger = await tx.query(
      `INSERT INTO user_daily_claims (user_id, claim_type, claim_date, payload) VALUES ($1, 'spin', ${DENVER_TODAY}, $2::jsonb)
         ON CONFLICT (user_id, claim_type, claim_date) DO NOTHING RETURNING 1`,
      [userId, JSON.stringify({ segmentId: seg.id, chips, stars, label: seg.label })],
    );
    if (!ledger.rowCount) throw new EconomyRefusal('already_claimed');
    const balances = await credit(tx, userId, chips, stars);
    return { segmentId: seg.id, label: seg.label, chips, stars, chipBoost, balances };
  }, pool);
}

// ───────────────────────────── Scratch card (APPUI-38) ─────────────────────────────

export interface ScratchResult { reward: MysteryResult; chips: number; stars: number; label: string; balances: Balances }

/** Consume one banked card AND pay it in one transaction (a duplicate emote pays stars instead of "0 item"). */
export async function settleScratchCard(userId: number, opts: { now?: number; rng?: Rng } = {}, pool?: TxPool): Promise<Settled<ScratchResult>> {
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  return settle(async (tx) => {
    const u = await lockUser(tx, userId);
    const used = await tx.query(
      `UPDATE users SET scratch_cards_available = scratch_cards_available - 1
        WHERE id = $1 AND scratch_cards_available > 0 RETURNING scratch_cards_available`,
      [userId],
    );
    if (!used.rowCount) throw new EconomyRefusal('no_cards_available');
    const roll = rollScratchCard(rng);
    const chipBoost = chipBoostIn(u.stats, now);
    const boostedRoll: RewardRoll = roll.kind === 'chips' ? { kind: 'chips', amount: boosted(roll.amount, chipBoost) } : roll;
    const applied = await applyRoll(tx, userId, boostedRoll, SCRATCH_DUPLICATE_STARS);
    const balances = await credit(tx, userId, applied.chips, applied.stars);
    const r = applied.result;
    const label = r.kind === 'chips' ? `${r.amount.toLocaleString('en-US')} chips`
      : r.kind === 'stars' ? (r.reason === 'duplicate_refund' ? `${r.amount} stars (you already own that emote)` : `${r.amount} stars`)
        : `Emote: ${r.itemId}`;
    return { reward: r, chips: applied.chips, stars: applied.stars, label, balances };
  }, pool);
}

// ───────────────────────────── Missions (C6) ─────────────────────────────

export interface MissionClaimResult { chips: number; stars: number; chipBoost: number; balances: Balances }

/**
 * Pay a completed mission once: ledger `mission:<date>:<templateId>` with
 * claim_date = the MISSION's Denver date (so the key is unique for good).
 * The caller has checked the mission is today's and complete.
 */
export async function settleMissionClaim(
  userId: number, dateKey: string, templateId: string, reward: { chips: number; stars: number },
  opts: { now?: number } = {}, pool?: TxPool,
): Promise<Settled<MissionClaimResult>> {
  const now = opts.now ?? Date.now();
  return settle(async (tx) => {
    const u = await lockUser(tx, userId);
    const chipBoost = chipBoostIn(u.stats, now);
    const chips = boosted(reward.chips, chipBoost);
    const stars = wholeNonNeg(reward.stars);
    const ledger = await tx.query(
      `INSERT INTO user_daily_claims (user_id, claim_type, claim_date, payload) VALUES ($1, $2, $3::date, $4::jsonb)
         ON CONFLICT (user_id, claim_type, claim_date) DO NOTHING RETURNING 1`,
      [userId, `mission:${dateKey}:${templateId}`, dateKey, JSON.stringify({ chips, stars })],
    );
    if (!ledger.rowCount) throw new EconomyRefusal('already_claimed');
    const balances = await credit(tx, userId, chips, stars);
    return { chips, stars, chipBoost, balances };
  }, pool);
}

// ───────────────────────────── Achievements (ECON-10) ─────────────────────────────

export type AchievementCategory = 'lifetime' | 'daily' | 'weekly';
export interface AchievementSettle { status: 'paid' | 'already'; chips: number; stars: number; balances: Balances | null }

/**
 * Pay an achievement ONLY when its ledger INSERT returns a row. Lifetime:
 * user_achievements (and an id already in users.achievements counts as paid);
 * daily: user_daily_achievements(windowKey = UTC date); weekly:
 * user_weekly_achievements(windowKey = UTC Sunday). The id is unioned into
 * users.achievements in the same statement as the credit (lifetime).
 */
export async function settleAchievementReward(
  userId: number, category: AchievementCategory, achId: string, windowKey: string,
  reward: { chips: number; stars: number }, opts: { now?: number } = {}, pool?: TxPool,
): Promise<AchievementSettle> {
  const now = opts.now ?? Date.now();
  return withEconomyTx(async (tx) => {
    const u = await lockUser(tx, userId);
    let fresh = false;
    if (category === 'lifetime') {
      if (u.achievements.includes(achId)) {
        await tx.query(`INSERT INTO user_achievements (user_id, ach_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, achId]);
        return { status: 'already', chips: 0, stars: 0, balances: null };
      }
      fresh = ((await tx.query(`INSERT INTO user_achievements (user_id, ach_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`, [userId, achId])).rowCount || 0) > 0;
    } else if (category === 'daily') {
      fresh = ((await tx.query(`INSERT INTO user_daily_achievements (user_id, ach_id, claim_date) VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING RETURNING 1`, [userId, achId, windowKey])).rowCount || 0) > 0;
    } else {
      fresh = ((await tx.query(`INSERT INTO user_weekly_achievements (user_id, ach_id, week_start_date) VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING RETURNING 1`, [userId, achId, windowKey])).rowCount || 0) > 0;
    }
    if (!fresh) return { status: 'already', chips: 0, stars: 0, balances: null };
    const chips = boosted(reward.chips, chipBoostIn(u.stats, now));
    const stars = wholeNonNeg(reward.stars);
    if (category === 'lifetime') {
      await tx.query(
        `UPDATE users SET achievements = (
           SELECT COALESCE(jsonb_agg(DISTINCT a ORDER BY a), '[]'::jsonb)::text FROM (
             SELECT jsonb_array_elements_text($2::jsonb) AS a UNION ALL SELECT $3::text AS a
           ) s) WHERE id = $1`,
        [userId, JSON.stringify(u.achievements), achId],
      );
    }
    const balances = await credit(tx, userId, chips, stars);
    return { status: 'paid', chips, stars, balances };
  }, pool);
}

// ───────────────────────────── Level-ups (ECON-10 / ECON-17) ─────────────────────────────

export interface LevelUpSettle { paidLevels: number[]; chips: number; stars: number; balances: Balances }

/**
 * Pay level-up rewards ONCE PER LEVEL (ledger economy_credits
 * `levelup:<userId>:<level>`) and ratchet level / xp, in one transaction.
 * Keyed by the LEVEL, not by users.level: a hand-complete save that raised
 * users.level first can no longer make the reward commit a no-op (the old
 * `WHERE level < $new` guard lost the reward in that race), and a level a stale
 * entry re-crosses is never paid twice. Chips are boosted by the DB's live chip
 * booster. The caller only calls this for a HYDRATED entry (memory level =
 * the DB level at hydrate), so a level paid before the ledger existed is never
 * re-crossed.
 */
export async function settleLevelUps(
  userId: number, levels: Array<{ level: number; chips: number; stars: number }>, newLevel: number, xp: number,
  opts: { now?: number } = {}, pool?: TxPool,
): Promise<LevelUpSettle> {
  const now = opts.now ?? Date.now();
  return withEconomyTx(async (tx) => {
    const u = await lockUser(tx, userId);
    const boost = chipBoostIn(u.stats, now);
    let chips = 0;
    let stars = 0;
    const paidLevels: number[] = [];
    for (const l of levels) {
      const lvChips = boosted(l.chips, boost);
      const r = await tx.query(
        `INSERT INTO economy_credits (credit_key, user_id, chips, stars, reason, detail) VALUES ($1, $2, $3, $4, 'level_up', $5::jsonb)
           ON CONFLICT (credit_key) DO NOTHING RETURNING 1`,
        [`levelup:${userId}:${l.level}`, userId, lvChips, wholeNonNeg(l.stars), JSON.stringify({ level: l.level })],
      );
      if (!r.rowCount) continue;
      paidLevels.push(l.level);
      chips += lvChips;
      stars += wholeNonNeg(l.stars);
    }
    const { rows } = await tx.query(
      `UPDATE users SET chips = chips + $2, stars = COALESCE(stars, 0) + $3,
              level = GREATEST(level, $4),
              xp = CASE WHEN $4 > level THEN $5 WHEN $4 = level THEN GREATEST(xp, $5) ELSE xp END
        WHERE id = $1
       RETURNING chips, stars, COALESCE(scratch_cards_available, 0) AS scratch_cards_available`,
      [userId, chips, stars, Math.floor(newLevel), Math.max(0, Math.floor(xp))],
    );
    return { paidLevels, chips, stars, balances: { chips: Number(rows[0].chips), stars: Number(rows[0].stars), scratchCardsAvailable: Number(rows[0].scratch_cards_available) } };
  }, pool);
}

// ───────────────────────────── Purchases (C7 / C8 / ECON-6 / ECON-16) ─────────────────────────────

export interface PurchaseOut { cost: number; balances: Balances }

/**
 * Deduct `cost` stars THEN run `grant` — in one transaction. A refusal from
 * `grant` (already owned, …) or any error rolls the deduct back.
 */
async function purchase<T extends object>(
  userId: number, cost: number, grant: (tx: Queryable, u: LockedUser) => Promise<T>, pool?: TxPool,
): Promise<Settled<T & PurchaseOut>> {
  return settle(async (tx) => {
    const u = await lockUser(tx, userId);
    await deductStars(tx, userId, cost);
    const g = await grant(tx, u);
    const { rows } = await tx.query(
      'SELECT chips, stars, COALESCE(scratch_cards_available, 0) AS scratch_cards_available FROM users WHERE id = $1', [userId],
    );
    return { ...g, cost, balances: { chips: Number(rows[0].chips), stars: Number(rows[0].stars), scratchCardsAvailable: Number(rows[0].scratch_cards_available) } };
  }, pool);
}

/** A cosmetic (catalog-validated by the caller): stars deducted, then the inventory row. */
export function purchaseCosmetic(userId: number, itemType: ItemType | string, itemId: string, cost: number, pool?: TxPool) {
  return purchase(userId, cost, async (tx) => {
    if (!(await grantItemTx(tx, userId, itemType, itemId))) throw new EconomyRefusal('already_owned');
    return { itemType: normalizeItemType(itemType), itemId };
  }, pool);
}

/** A bundle: every item it holds; a duplicate refunds 25% of the price pro rata (stars). All owned → refused. */
export function purchaseBundle(userId: number, bundleId: string, cost: number, pool?: TxPool) {
  const contents = BUNDLE_CONTENTS[bundleId] || [];
  return purchase(userId, cost, async (tx) => {
    if (contents.length === 0) throw new EconomyRefusal('unknown_item');
    const granted: Array<[string, string]> = [];
    let duplicates = 0;
    for (const [t, id] of contents) {
      if (await grantItemTx(tx, userId, t, id)) granted.push([t, id]); else duplicates++;
    }
    if (granted.length === 0) throw new EconomyRefusal('already_owned');
    const refund = duplicates > 0 ? Math.floor((cost * 0.25 * duplicates) / contents.length) : 0;
    if (refund > 0) await credit(tx, userId, 0, refund);
    return { granted, duplicates, refund };
  }, pool);
}

/** A chip pack: stars → chips. */
export function purchaseChipPack(userId: number, packId: string, cost: number, pool?: TxPool) {
  const payout = CHIP_PACK_PAYOUT[packId] || 0;
  return purchase(userId, cost, async (tx) => {
    if (!(payout > 0)) throw new EconomyRefusal('unknown_item');
    await credit(tx, userId, payout, 0);
    return { payout };
  }, pool);
}

/** A mystery box: the roll is applied in the purchase transaction; a duplicate item refunds 40% of the price in stars. */
export function purchaseMysteryBox(userId: number, tierId: string, cost: number, opts: { rng?: Rng } = {}, pool?: TxPool) {
  return purchase(userId, cost, async (tx) => {
    if (!MYSTERY_BOX_TIERS[tierId]) throw new EconomyRefusal('unknown_item');
    const roll = rollMysteryBox(tierId, opts.rng ?? Math.random);
    const applied = await applyRoll(tx, userId, roll, Math.floor(cost * MYSTERY_DUPLICATE_REFUND_SHARE));
    if (applied.chips > 0 || applied.stars > 0) await credit(tx, userId, applied.chips, applied.stars);
    return { mysteryReward: applied.result };
  }, pool);
}

/**
 * A booster: stats.activeBoosters[kind] = { mult, expiresAt }. A booster of the
 * same kind and multiplier that is still running is EXTENDED.
 */
export function purchaseBooster(
  userId: number, cost: number, kind: 'xp' | 'chip', mult: number, ms: number, opts: { now?: number } = {}, pool?: TxPool,
) {
  const now = opts.now ?? Date.now();
  return purchase(userId, cost, async (tx, u) => {
    const boosters = (u.stats.activeBoosters && typeof u.stats.activeBoosters === 'object') ? { ...u.stats.activeBoosters } : {};
    for (const [k, v] of Object.entries(boosters)) if (!(Number((v as any)?.expiresAt) > now)) delete (boosters as any)[k];
    const cur = (boosters as any)[kind];
    const base = cur && Number(cur.mult) === mult && Number(cur.expiresAt) > now ? Number(cur.expiresAt) : now;
    (boosters as any)[kind] = { mult, expiresAt: base + ms };
    await writeStats(tx, userId, { ...u.stats, activeBoosters: boosters });
    return { booster: { kind, mult, expiresAt: base + ms }, activeBoosters: boosters as Record<string, { mult: number; expiresAt: number }> };
  }, pool);
}

/** A VIP pass: stats.vipExpiresAt = max(now, current expiry) + duration (time is added, never lost). */
export function purchaseVipPass(userId: number, cost: number, ms: number, opts: { now?: number } = {}, pool?: TxPool) {
  const now = opts.now ?? Date.now();
  return purchase(userId, cost, async (tx, u) => {
    const current = Number(u.stats.vipExpiresAt) || 0;
    const vipExpiresAt = Math.max(now, current) + ms;
    await writeStats(tx, userId, { ...u.stats, vipExpiresAt });
    return { vipExpiresAt };
  }, pool);
}

/** Battle Pass premium for a season — bought ONCE (never charged twice), remembered durably. */
export function purchaseBattlePassPremium(userId: number, seasonId: string, cost: number, pool?: TxPool) {
  return purchase(userId, cost, async (tx, u) => {
    if (u.stats.battlePassPremium === true) throw new EconomyRefusal('already_owned'); // pre-R2 flag (none on prod 2026-10-11)
    const r = await tx.query(
      `INSERT INTO user_battle_pass_premium (user_id, season_id, stars_paid) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, season_id) DO NOTHING RETURNING 1`,
      [userId, seasonId, cost],
    );
    if (!r.rowCount) throw new EconomyRefusal('already_owned');
    return { seasonId };
  }, pool);
}

/**
 * Does the account own Battle Pass premium for the season (the R2 table, or the pre-R2 stats flag)?
 * R3 (S3-1) — the pre-R2 flag is the PARSED TOP-LEVEL `stats.battlePassPremium`
 * (as loadProgressBundle and purchaseBattlePassPremium read it), never a
 * substring of the stats text: the client writes `stats.clientData` (D4), so a
 * crafted saveProgress {stats:{clientData:{battlePassPremium:true}}} put
 * `"battlePassPremium":true` into the text after the next compact stats write
 * and unlocked every premium tier for free (15,000 chips, 300 stars, 5 cosmetics).
 */
export async function hasBattlePassPremium(userId: number, seasonId: string, db: Queryable = defaultPool()): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM user_battle_pass_premium WHERE user_id = $1 AND season_id = $2) AS owned,
            (SELECT stats::text FROM users WHERE id = $1) AS stats`,
    [userId, seasonId],
  );
  return !!rows[0]?.owned || parseStatsColumn(rows[0]?.stats).battlePassPremium === true;
}

// ───────────────────────────── VIP monthly bonus (C8) ─────────────────────────────

/** Once per Denver month while a VIP pass is active: ledger `vip_monthly:<YYYY-MM>` (claim_date = the 1st). */
export async function settleVipMonthly(
  userId: number, monthKey: string, chips: number, opts: { now?: number } = {}, pool?: TxPool,
): Promise<Settled<{ chips: number; balances: Balances }>> {
  const now = opts.now ?? Date.now();
  const range = monthDateRange(monthKey);
  return settle(async (tx) => {
    if (!range) throw new EconomyRefusal('invalid_month');
    const u = await lockUser(tx, userId);
    if (!vipActiveIn(u.stats, now)) throw new EconomyRefusal('vip_required');
    const ledger = await tx.query(
      `INSERT INTO user_daily_claims (user_id, claim_type, claim_date, payload) VALUES ($1, $2, $3::date, $4::jsonb)
         ON CONFLICT (user_id, claim_type, claim_date) DO NOTHING RETURNING 1`,
      [userId, `vip_monthly:${monthKey}`, range.first, JSON.stringify({ chips })],
    );
    if (!ledger.rowCount) throw new EconomyRefusal('already_claimed');
    const balances = await credit(tx, userId, chips, 0);
    return { chips: wholeNonNeg(chips), balances };
  }, pool);
}

// ───────────────────────────── Career (ECON-17) ─────────────────────────────

/** A career venue's reward, once per venue: claim row + chips + the (catalog) cosmetic in one transaction. */
export async function settleCareerReward(
  userId: number, venue: number, chips: number, item: [string, string] | undefined, pool?: TxPool,
): Promise<Settled<{ chips: number; item: [string, string] | null; itemGranted: boolean; balances: Balances }>> {
  return settle(async (tx) => {
    await lockUser(tx, userId);
    const claim = await tx.query(
      `INSERT INTO user_career_reward_claims (user_id, venue) VALUES ($1, $2) ON CONFLICT (user_id, venue) DO NOTHING RETURNING 1`,
      [userId, venue],
    );
    if (!claim.rowCount) throw new EconomyRefusal('already_claimed');
    const itemGranted = item ? await grantItemTx(tx, userId, item[0], item[1]) : false;
    const balances = await credit(tx, userId, chips, 0);
    return { chips: wholeNonNeg(chips), item: item ?? null, itemGranted, balances };
  }, pool);
}

// ───────────────────────────── Keyed one-off credits (ECON-17) ─────────────────────────────

/** Credit chips/stars exactly once per `creditKey` (economy_credits). 'duplicate' = already paid. */
export async function creditOnce(
  creditKey: string, userId: number, chips: number, stars: number, reason: string, detail: Record<string, unknown> = {}, pool?: TxPool,
): Promise<{ status: 'credited' | 'duplicate'; balances: Balances | null }> {
  return withEconomyTx(async (tx) => {
    await lockUser(tx, userId);
    const r = await tx.query(
      `INSERT INTO economy_credits (credit_key, user_id, chips, stars, reason, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (credit_key) DO NOTHING RETURNING 1`,
      [creditKey, userId, wholeNonNeg(chips), wholeNonNeg(stars), reason, JSON.stringify(detail)],
    );
    if (!r.rowCount) return { status: 'duplicate' as const, balances: null };
    return { status: 'credited' as const, balances: await credit(tx, userId, chips, stars) };
  }, pool);
}

/** creditOnce with bounded retries on transient errors (a refusal / duplicate is final). */
export async function creditOnceWithRetry(
  creditKey: string, userId: number, chips: number, stars: number, reason: string, detail: Record<string, unknown> = {},
  opts: { attempts?: number; delayMs?: number; pool?: TxPool } = {},
): Promise<{ status: 'credited' | 'duplicate' | 'failed'; balances: Balances | null; error?: string }> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      return await creditOnce(creditKey, userId, chips, stars, reason, detail, opts.pool);
    } catch (e: any) {
      lastErr = e?.message || String(e);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, (opts.delayMs ?? 500) * (i + 1)));
    }
  }
  return { status: 'failed', balances: null, error: lastErr };
}

// ───────────────────────────── Equip (C7) ─────────────────────────────

/**
 * Equip (itemId) or unequip (null) the slot `itemType`. A FREE catalog item
 * (price 0) is owned by everyone: its inventory row is created on equip. The
 * caller has validated (type, id) against the catalog.
 */
export async function equipItemTx(
  userId: number, itemType: string, itemId: string | null, free: boolean, pool?: TxPool,
): Promise<Settled<{ itemType: string; itemId: string | null }>> {
  const t = normalizeItemType(itemType);
  return settle(async (tx) => {
    await lockUser(tx, userId);
    if (itemId === null) {
      await tx.query('UPDATE user_inventory SET equipped = FALSE WHERE user_id = $1 AND item_type = $2', [userId, t]);
      return { itemType: t, itemId: null };
    }
    if (free) await grantItemTx(tx, userId, t, itemId);
    const owns = await tx.query('SELECT 1 FROM user_inventory WHERE user_id = $1 AND item_type = $2 AND item_id = $3', [userId, t, itemId]);
    if (!owns.rowCount) throw new EconomyRefusal('not_owned');
    await tx.query('UPDATE user_inventory SET equipped = FALSE WHERE user_id = $1 AND item_type = $2 AND item_id <> $3', [userId, t, itemId]);
    await tx.query('UPDATE user_inventory SET equipped = TRUE WHERE user_id = $1 AND item_type = $2 AND item_id = $3', [userId, t, itemId]);
    return { itemType: t, itemId };
  }, pool);
}

// ───────────────────────────── Wallet read (C5 DB-fresh push) ─────────────────────────────

export interface WalletRow { chips: number; stars: number; scratchCardsAvailable: number; loginStreak: number; lastLoginClaimDate: string | null }

export async function readWallet(userId: number, db: Queryable = defaultPool()): Promise<WalletRow | null> {
  const { rows } = await db.query(
    `SELECT chips, stars, COALESCE(scratch_cards_available, 0) AS scratch_cards_available, COALESCE(login_streak, 0) AS login_streak,
            to_char(last_login_claim_date, 'YYYY-MM-DD') AS last_login_claim_date
       FROM users WHERE id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    chips: Number(r.chips) || 0, stars: Number(r.stars) || 0, scratchCardsAvailable: Number(r.scratch_cards_available) || 0,
    loginStreak: Number(r.login_streak) || 0, lastLoginClaimDate: r.last_login_claim_date || null,
  };
}

// ───────────────────────────── Hydration bundle (ECON-12) ─────────────────────────────

export interface ProgressBundle {
  userId: number;
  displayName: string | null;
  publicId: string | null;
  chips: number; level: number; xp: number; stars: number;
  stats: Record<string, any>;
  achievements: string[];
  lifetimeLedger: string[];
  loginStreak: number; lastLoginClaimDate: string | null;
  scratchCardsAvailable: number;
  inventory: Array<{ itemType: string; itemId: string; equipped: boolean }>;
  dailyAchievementIds: string[]; weeklyAchievementIds: string[];
  /** Denver-today claims: mission template ids claimed, spin claimed. */
  missionClaims: string[]; spinClaimedToday: boolean;
  vipMonthlyClaimed: boolean;
  battlePassPremium: boolean;
  denverToday: string; denverMonth: string;
}

/**
 * Every DB read a progress entry needs, on ONE connection, THROWING on any
 * failure (the old per-table loaders swallowed errors and returned [] / null —
 * a failed read of today's daily achievements re-paid them all, ECON-12).
 */
export async function loadProgressBundle(
  userId: number, ctx: { utcToday: string; utcWeekStart: string; battlePassSeason: string }, pool: TxPool = defaultPool(),
): Promise<ProgressBundle | null> {
  const c = await pool.connect();
  // A table / column the boot DDL (economy/schema) has not created YET has no
  // rows — 42P01 / 42703 only; every other error throws (ECON-12: a failed read
  // is never treated as "nothing earned").
  const optional = async (sql: string, params: unknown[]): Promise<any[]> => {
    try { return (await c.query(sql, params)).rows; } catch (e: any) {
      if (e?.code === '42P01' || e?.code === '42703') return [];
      throw e;
    }
  };
  try {
    const { rows } = await c.query(
      `SELECT id, display_name, chips, level, xp, stats::text AS stats, achievements::text AS achievements,
              COALESCE(stars, 0) AS stars, COALESCE(login_streak, 0) AS login_streak,
              to_char(last_login_claim_date, 'YYYY-MM-DD') AS last_login_claim_date,
              COALESCE(scratch_cards_available, 0) AS scratch_cards_available,
              to_char(${DENVER_TODAY}, 'YYYY-MM-DD') AS denver_today,
              to_char(${DENVER_TODAY}, 'YYYY-MM') AS denver_month
         FROM users WHERE id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u) return null;
    const denverToday = String(u.denver_today);
    const denverMonth = String(u.denver_month);
    const inv = await c.query('SELECT item_type, item_id, equipped FROM user_inventory WHERE user_id = $1 ORDER BY acquired_at', [userId]);
    const daily = await c.query('SELECT ach_id FROM user_daily_achievements WHERE user_id = $1 AND claim_date = $2::date', [userId, ctx.utcToday]);
    const weekly = await c.query('SELECT ach_id FROM user_weekly_achievements WHERE user_id = $1 AND week_start_date = $2::date', [userId, ctx.utcWeekStart]);
    const ledger = await optional('SELECT ach_id FROM user_achievements WHERE user_id = $1', [userId]);
    const claims = await c.query(
      `SELECT claim_type FROM user_daily_claims
        WHERE user_id = $1 AND (claim_type LIKE $2 OR claim_type = $3 OR (claim_type = 'spin' AND claim_date = $4::date))`,
      [userId, `mission:${denverToday}:%`, `vip_monthly:${denverMonth}`, denverToday],
    );
    const bp = await optional('SELECT 1 FROM user_battle_pass_premium WHERE user_id = $1 AND season_id = $2', [userId, ctx.battlePassSeason]);
    // A row created after the boot backfill gets its public id here (per row).
    await optional(`UPDATE users SET public_id = ${PUBLIC_ID_SQL} WHERE id = $1 AND public_id IS NULL`, [userId]);
    const pid = await optional('SELECT public_id FROM users WHERE id = $1', [userId]);
    const stats = parseStatsColumn(u.stats);
    const claimTypes: string[] = claims.rows.map((r: any) => String(r.claim_type));
    return {
      userId: Number(u.id),
      displayName: u.display_name ?? null,
      publicId: pid[0]?.public_id ?? null,
      chips: Number(u.chips) || 0,
      level: Math.max(1, Number(u.level) || 1),
      xp: Math.max(0, Number(u.xp) || 0),
      stars: Number(u.stars) || 0,
      stats,
      achievements: parseAchievementList(u.achievements),
      lifetimeLedger: ledger.map((r: any) => String(r.ach_id)),
      loginStreak: Number(u.login_streak) || 0,
      lastLoginClaimDate: u.last_login_claim_date || null,
      scratchCardsAvailable: Number(u.scratch_cards_available) || 0,
      inventory: inv.rows.map((r: any) => ({ itemType: normalizeItemType(r.item_type), itemId: String(r.item_id), equipped: !!r.equipped })),
      dailyAchievementIds: daily.rows.map((r: any) => String(r.ach_id)),
      weeklyAchievementIds: weekly.rows.map((r: any) => String(r.ach_id)),
      missionClaims: claimTypes.filter((t) => t.startsWith(`mission:${denverToday}:`)).map((t) => t.slice(`mission:${denverToday}:`.length)),
      spinClaimedToday: claimTypes.includes('spin'),
      vipMonthlyClaimed: claimTypes.includes(`vip_monthly:${denverMonth}`),
      battlePassPremium: bp.length > 0 || stats.battlePassPremium === true,
      denverToday, denverMonth,
    };
  } finally {
    c.release();
  }
}

// ───────────────────────────── Chips won (C9 / APPUI-50) ─────────────────────────────

/** Add a hand's NET chips won (may be negative) to the user's Denver-day bucket. Additive — never last-writer-wins. */
export async function recordChipWins(userId: number, dayKey: string, net: number, hands = 1, db: Queryable = defaultPool()): Promise<void> {
  const n = Math.trunc(Number(net) || 0);
  await db.query(
    `INSERT INTO user_chip_wins (user_id, day, won, hands) VALUES ($1, $2::date, $3, $4)
       ON CONFLICT (user_id, day) DO UPDATE SET won = user_chip_wins.won + EXCLUDED.won, hands = user_chip_wins.hands + EXCLUDED.hands`,
    [userId, dayKey, n, Math.max(0, Math.trunc(hands))],
  );
}

/**
 * Rows the season ranking / period leaderboards may show and pay: listable
 * (not banned / admin / merge tombstone / retired guest) and not a GUEST row
 * (a GuestNNNN username with no master account stamp).
 */
export const RANKABLE_USER_SQL = `${LISTABLE_USER_SQL}`
  + ` AND NOT (username ~ '^Guest[0-9]+$' AND position('"masterUserId"' in COALESCE(stats::text, '')) = 0)`;

export interface ChipsWonRow {
  userId: number;
  /** publicDisplayName(display_name) — what other players may see. */
  displayName: string;
  rawDisplayName: string | null;
  won: number; hands: number; level: number; stats: Record<string, any>;
}

/** Users ranked by NET chips won between two Denver dates (inclusive); only positive totals. */
export async function chipsWonStandings(firstDay: string, lastDay: string, limit: number, db: Queryable = defaultPool()): Promise<ChipsWonRow[]> {
  const { rows } = await db.query(
    `SELECT w.user_id, SUM(w.won)::bigint AS won, SUM(w.hands)::bigint AS hands, u.display_name, u.level, u.stats::text AS stats
       FROM user_chip_wins w JOIN users u ON u.id = w.user_id
      WHERE w.day BETWEEN $1::date AND $2::date AND ${RANKABLE_USER_SQL}
      GROUP BY w.user_id, u.display_name, u.level, u.stats
     HAVING SUM(w.won) > 0
      ORDER BY SUM(w.won) DESC, w.user_id ASC
      LIMIT $3`,
    [firstDay, lastDay, Math.max(1, Math.min(500, Math.floor(limit)))],
  );
  return rows.map((r: any) => ({
    userId: Number(r.user_id), displayName: publicDisplayName(r.display_name), rawDisplayName: r.display_name ?? null,
    won: Number(r.won) || 0, hands: Number(r.hands) || 0, level: Number(r.level) || 1, stats: parseStatsColumn(r.stats),
  }));
}

// ───────────────────────────── Season award (C9) ─────────────────────────────

export interface SeasonAwardResult {
  /** R3 (XL-2) — 'pre_ledger': the month ended before the chips-won ledger existed (nothing paid, nothing marked). */
  status: 'awarded' | 'already_awarded' | 'pre_ledger';
  seasonKey: string;
  /** The paid rows (`display_name` raw — callers show it through publicNameOf). */
  winners: Array<{ id: number; display_name: string | null; place: number; chips: number; badge: string; won: number }>;
}

/**
 * Award a finished Denver month ONCE: top 3 by chips won in that month (C9),
 * 50k / 25k / 10k + a badge, ledger rows + chips + badge + the season's run
 * marker in ONE transaction, serialized by an advisory lock. A month with no
 * eligible winner is marked run (winners 0) so the sweep never retries it.
 */
export async function awardSeason(seasonKey: string, trigger: string, pool?: TxPool): Promise<SeasonAwardResult> {
  const range = monthDateRange(seasonKey);
  if (!range) throw new Error(`invalid season key ${seasonKey}`);
  // R3 (XL-2) — a month before the ledger existed was never measured: no award,
  // and NO season_award_runs marker (it would make the month unpayable forever).
  if (seasonKey < FIRST_CHIPS_WON_SEASON) return { status: 'pre_ledger', seasonKey, winners: [] };
  return withEconomyTx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`season_award:${seasonKey}`]);
    const ran = await tx.query('SELECT 1 FROM season_award_runs WHERE season_key = $1', [seasonKey]);
    const legacy = await tx.query('SELECT 1 FROM season_leaderboard_awards WHERE season_key = $1 LIMIT 1', [seasonKey]);
    if (ran.rowCount || legacy.rowCount) return { status: 'already_awarded' as const, seasonKey, winners: [] };
    const standings = await chipsWonStandings(range.first, range.last, SEASON_REWARDS.length, tx);
    const winners: SeasonAwardResult['winners'] = [];
    for (let i = 0; i < standings.length && i < SEASON_REWARDS.length; i++) {
      const s = standings[i];
      const rw = SEASON_REWARDS[i];
      await lockUser(tx, s.userId);
      await tx.query(
        `INSERT INTO season_leaderboard_awards (season_key, user_id, place, chips, badge_id) VALUES ($1, $2, $3, $4, $5)`,
        [seasonKey, s.userId, rw.place, rw.chips, rw.badge],
      );
      await credit(tx, s.userId, rw.chips, 0);
      await grantItemTx(tx, s.userId, 'badge', rw.badge);
      winners.push({ id: s.userId, display_name: s.rawDisplayName, place: rw.place, chips: rw.chips, badge: rw.badge, won: s.won });
    }
    await tx.query(
      `INSERT INTO season_award_runs (season_key, winners, trigger, detail) VALUES ($1, $2, $3, $4::jsonb)`,
      [seasonKey, winners.length, trigger, JSON.stringify({ winners: winners.map(({ id, place, chips, won }) => ({ userId: id, place, chips, won })) })],
    );
    return { status: 'awarded' as const, seasonKey, winners };
  }, pool);
}

// ───────────────────────────── Public ids (APPUI-14 / Addendum) ─────────────────────────────

/** The opaque public id of each user id (assigned on first need). Unknown ids are absent. */
export async function publicIdsFor(userIds: number[], db: Queryable = defaultPool()): Promise<Map<number, string>> {
  const ids = [...new Set(userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  let { rows } = await db.query('SELECT id, public_id FROM users WHERE id = ANY($1::int[])', [ids]);
  const missing = rows.filter((r: any) => !r.public_id).map((r: any) => Number(r.id));
  if (missing.length > 0) {
    await db.query(`UPDATE users SET public_id = ${PUBLIC_ID_SQL} WHERE id = ANY($1::int[]) AND public_id IS NULL`, [missing]);
    ({ rows } = await db.query('SELECT id, public_id FROM users WHERE id = ANY($1::int[])', [ids]));
  }
  for (const r of rows) if (r.public_id) out.set(Number(r.id), String(r.public_id));
  return out;
}

/** The listable account behind a public id, else null. */
export async function userIdForPublicId(publicId: unknown, db: Queryable = defaultPool()): Promise<number | null> {
  const p = String(publicId ?? '');
  if (!/^p[0-9a-f]{15}$/.test(p)) return null;
  const { rows } = await db.query(`SELECT id FROM users WHERE public_id = $1 AND ${LISTABLE_USER_SQL}`, [p]);
  return rows[0] ? Number(rows[0].id) : null;
}

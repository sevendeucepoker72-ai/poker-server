/**
 * 2026-10-10 — one person, one local account (owner-approved: "Merge and yes").
 *
 * WHY. poker-server keeps its own `users` rows, linked to the master
 * (americanpub.poker) account by `stats.masterUserId`. Two sign-in paths picked
 * DIFFERENT rows for the same master account:
 *   - the OIDC path (oauthLogin / tokenLogin, upsertOidcLocalUser) keys the row
 *     by the `username` CLAIM, i.e. the display name ("Josh Hall");
 *   - the Play Online ticket path (authWithTicket 3a) looked the row up with
 *     `stats->>'masterUserId'`, which ERRORS on the TEXT `stats` column, so it
 *     always fell through to its slug upsert ("josh.hall2").
 * Every player who used both got two (sometimes three) rows — on 2026-10-10:
 * 114 master accounts / 240 rows — each with its own chips, stars, level and
 * hand history. "My chips changed when I used Play Online" was this.
 *
 * WHAT THIS MODULE DOES
 *   1. findLocalUserByMasterId — the master-first resolver every sign-in path
 *      now uses, so a master account always lands on ONE row.
 *   2. runAccountMerge — a one-time boot operation that folds each split
 *      master's rows into one survivor: chips / stars / scratch cards SUMMED
 *      (never minted: the group's totals are asserted equal before and after),
 *      level = highest, achievements + variants UNIONED, hand counters summed,
 *      best results maxed, every child-table row re-pointed (rows that would
 *      collide on a unique key are archived to merged_rows_archive, never just
 *      dropped). The other rows become TOMBSTONES: zero balances, banned,
 *      renamed, masterUserId removed, `mergedInto` set, token_version bumped
 *      (their resume tokens die) — never deleted, so every FK stays valid and
 *      the merge can be audited / reversed from account_merges + the archive.
 *   3. installMergedCreditRedirect — a BEFORE UPDATE trigger: any chips / stars
 *      / scratch-card CREDIT that still lands on a tombstone (e.g. a seat that
 *      Redis rehydrated under the old local id, a cash-out queued before the
 *      merge) is moved to its survivor and logged in merged_account_redirects.
 *      Deductions from a tombstone fail at their `WHERE chips >= $n` (balance
 *      0), exactly like any empty wallet.
 *   4. runGoodwillGrant — one-time 50,000 chips per PERSON who played since
 *      2026-06-19 (the saveProgress COALESCE bug lost their level / XP /
 *      achievement progress from then on). Exactly-once: claim + grant + done
 *      in ONE transaction.
 *   5. The identity gate — sign-ins wait (bounded) until the boot operations
 *      have finished, so no session can bind to a row that is about to become a
 *      tombstone. On boots where the operations are already done the gate opens
 *      as soon as the DB is up.
 *
 * WHY THE DELAY (MERGE_START_DELAY_MS). Railway starts the NEW container before
 * it SIGTERMs the old one (measured 2026-10-10: new listening 16:08:23.39Z, old
 * SIGTERM 16:08:30.26Z, old stopped 16:08:32.18Z). The old process's SIGTERM
 * flush and any socket it is still serving can write to the old rows. The merge
 * therefore starts only after the old process is certainly gone, and logins
 * wait for it.
 */

import type { Pool, PoolClient } from 'pg';
import { parseStatsColumn } from './loginIdentity';
import { lifetimeAchievementsSatisfiedBy } from '../progression/ProgressionManager';

export const MERGE_OP_ID = 'merge_split_master_accounts_2026_10_10';
export const GOODWILL_OP_ID = 'goodwill_50k_progress_save_bug_2026_10_10';
export const GOODWILL_AMOUNT = 50_000;
/** 2026-06-19 00:00 America/Denver — the day 89ac65e broke saveProgress. */
export const GOODWILL_SINCE_ISO = '2026-06-19T06:00:00.000Z';
export const GOODWILL_SINCE_MS = Date.parse(GOODWILL_SINCE_ISO);
/**
 * Old container: SIGTERM ~7s after the new one listens, gone ~2s later (measured
 * 2026-10-10). 20s is ~2x that; waitForPreviousInstanceGone then also waits for
 * every DB session older than this process (the old pool, which a SIGTERM flush
 * just used, so it is not idle-reaped) before anything is merged.
 */
export const MERGE_START_DELAY_MS = 20_000;
/** A login never waits longer than this for the boot operations. */
export const IDENTITY_GATE_MAX_WAIT_MS = 240_000;
const INT4_MAX = 2_147_483_647;

// ─────────────────────────────────────────────────────────────────────────────
// Row helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalUserRow {
  id: number;
  username: string;
  display_name?: string | null;
  chips: number;
  stars?: number | null;
  level: number;
  xp: number;
  stats: unknown;
  achievements?: unknown;
  is_admin?: boolean | null;
  banned?: boolean | null;
  token_version?: number | null;
  created_at?: Date | string | null;
  login_streak?: number | null;
  last_login_claim_date?: Date | string | null;
  scratch_cards_available?: number | null;
  hands_since_last_scratch?: number | null;
  customization?: unknown;
  preferences?: unknown;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** True for a row this module retired (its credits are redirected). */
export function isMergedTombstone(rawStats: unknown): boolean {
  const s = parseStatsColumn(rawStats);
  return s.mergedInto != null && s.mergedInto !== '';
}

/**
 * The identity keys of `stamp` that differ from the row's current stats — the
 * PATCH to hand to authManager.mergeUserStats (an atomic SELECT … FOR UPDATE
 * merge), or null when nothing changed. Review 2026-10-10: the sign-in paths
 * used to rewrite the WHOLE stats value from an earlier read, which could undo
 * a concurrent hand's counter update.
 */
export function identityStampPatch(rawStats: unknown, stamp: Record<string, string | undefined>): Record<string, string> | null {
  const existing = parseStatsColumn(rawStats);
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(stamp)) {
    if (v == null || v === '') continue;
    if (String(existing[k] ?? '') !== String(v)) patch[k] = String(v);
  }
  return Object.keys(patch).length ? patch : null;
}

/** The survivor id a tombstone points at, or null. */
export function mergedIntoOf(rawStats: unknown): number | null {
  const v = parseStatsColumn(rawStats).mergedInto;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseAchievements(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.map(String);
    } catch { /* corrupt — treat as empty */ }
  }
  return [];
}

function isNonEmptyObject(v: unknown): boolean {
  let o: unknown = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { return false; } }
  return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o as object).length > 0;
}

function dateMs(v: unknown): number {
  if (v == null) return NaN;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

/**
 * The row a person keeps: the one they used MOST RECENTLY (their current table
 * name / avatar), then the highest level, the most chips, the lowest id. Pure
 * and total — the resolver (findLocalUserByMasterId) and the merge use the same
 * rule, so a sign-in that ever sees a still-split master picks the same row the
 * merge will keep.
 */
export function pickSurvivor<T extends LocalUserRow>(rows: T[]): T {
  if (!rows.length) throw new Error('pickSurvivor: no rows');
  return [...rows].sort((a, b) => {
    const la = num(parseStatsColumn(a.stats).lastHandAt);
    const lb = num(parseStatsColumn(b.stats).lastHandAt);
    if (la !== lb) return lb - la;
    if (num(a.level) !== num(b.level)) return num(b.level) - num(a.level);
    if (num(a.chips) !== num(b.chips)) return num(b.chips) - num(a.chips);
    return num(a.id) - num(b.id);
  })[0];
}

/** users.username is UNIQUE (and LOWER-unique); the id makes this one unique. */
export function tombstoneUsername(id: number, original: string): string {
  return `merged-${id}-${String(original || '').slice(0, 60)}`;
}

// Stats merge rules. Only these keys exist in production (2026-10-10 census);
// the lists also name the counters ProgressionManager can persist.
// Every counter ProgressionManager.hydrateFromDB reads back (review 2026-10-10:
// since 29fe063 saves persist them, so a retired row's values must be added).
const SUM_KEYS = [
  'handsPlayed', 'handsWon', 'tournamentsPlayed', 'tournamentsWon', 'bluffWins', 'allInWins', 'chatMessagesSent',
  'straightFlushHits', 'fullHouseHits', 'quadsHits', 'royalFlushHits',
  'vpipHands', 'pfrHands', 'flopsSeenHands', 'showdownHands', 'showdownWins', 'threeBetOpps', 'threeBets',
];
const MAX_KEYS = ['biggestPot', 'bestStreak', 'lastHandAt', 'vipExpiresAt'];
const UNION_KEYS = ['variantsPlayed'];
const FLAG_KEYS: Array<[string, string]> = [
  ['chipRecoveryGrantApplied', 'chipRecoveryGrantAt'],
  ['starsRecoveryGrantApplied', 'starsRecoveryGrantAt'],
];
const IDENTITY_KEYS = ['masterUserId', 'masterUsername', 'masterDisplayName', 'masterPhone'];
/** Keys the per-person counters / identity own; nothing else is copied onto a tombstone. */
const DESCRIPTIVE_KEYS = ['masterUsername', 'masterDisplayName', 'masterPhone'];

/**
 * The PlayerProgress-shaped view of a stored row (level + the stats counters
 * ProgressionManager.hydrateFromDB reads), for lifetimeAchievementsSatisfiedBy.
 */
export function progressStateFrom(level: number, rawStats: unknown): Record<string, unknown> {
  const st = parseStatsColumn(rawStats);
  return {
    level: num(level),
    totalHandsPlayed: num(st.handsPlayed), handsWon: num(st.handsWon), biggestPot: num(st.biggestPot),
    bestStreak: num(st.bestStreak), bluffWins: num(st.bluffWins), allInWins: num(st.allInWins),
    chatMessagesSent: num(st.chatMessagesSent),
    straightFlushHits: num(st.straightFlushHits), fullHouseHits: num(st.fullHouseHits),
    quadsHits: num(st.quadsHits), royalFlushHits: num(st.royalFlushHits),
    tournamentsWon: num(st.tournamentsWon), tournamentsPlayed: num(st.tournamentsPlayed),
    variantsPlayed: Array.isArray(st.variantsPlayed) ? st.variantsPlayed : [],
  };
}

export interface MergePlan {
  masterUserId: string;
  survivorId: number;
  loserIds: number[];
  survivor: {
    chips: number; stars: number; scratch_cards_available: number; hands_since_last_scratch: number;
    level: number; xp: number; achievements: string; stats: string;
    login_streak: number; last_login_claim_date: string | null;
    is_admin: boolean; banned: boolean;
    customization: unknown; preferences: unknown;
    display_name: string | null; created_at: string | null;
  };
  tombstones: Array<{ id: number; username: string; stats: string; token_version: number }>;
  totals: { chips: number; stars: number; scratch: number };
  /** Set when the plan must NOT be applied (e.g. an int4 overflow). */
  refuse?: string;
}

/**
 * Fold a master's rows into one. PURE: no I/O, deterministic for a given input
 * (`nowIso` is passed in). The caller applies it inside one transaction and
 * re-checks the totals there.
 */
export function planAccountMerge(masterUserId: string, rows: LocalUserRow[], nowIso: string): MergePlan {
  if (rows.length < 2) throw new Error('planAccountMerge: need 2+ rows');
  const survivorRow = pickSurvivor(rows);
  // Others newest-activity first, so "first non-empty" prefers recent data.
  const others = rows.filter((r) => r.id !== survivorRow.id)
    .sort((a, b) => num(parseStatsColumn(b.stats).lastHandAt) - num(parseStatsColumn(a.stats).lastHandAt) || a.id - b.id);
  const ordered = [survivorRow, ...others];
  const statsOf = ordered.map((r) => parseStatsColumn(r.stats));

  const totals = {
    chips: rows.reduce((s, r) => s + num(r.chips), 0),
    stars: rows.reduce((s, r) => s + num(r.stars), 0),
    scratch: rows.reduce((s, r) => s + num(r.scratch_cards_available), 0),
  };

  // Level: the highest; XP travels WITH that level (xp is progress within it).
  const topLevel = Math.max(...rows.map((r) => num(r.level)));
  const xp = Math.max(...rows.filter((r) => num(r.level) === topLevel).map((r) => num(r.xp)));

  const unionedAchievements = Array.from(new Set(ordered.flatMap((r) => parseAchievements(r.achievements))));

  // Stats: start from the survivor's (keeps every key we do not know about),
  // fill unknown keys from the others, then apply the per-key rules.
  const stats: Record<string, any> = {};
  for (const s of [...statsOf].reverse()) Object.assign(stats, s); // survivor wins (applied last)
  delete stats.mergedInto; delete stats.mergedAt; delete stats.mergedFromMasterUserId;
  for (const k of SUM_KEYS) {
    if (statsOf.some((s) => s[k] != null)) stats[k] = statsOf.reduce((acc, s) => acc + num(s[k]), 0);
  }
  for (const k of MAX_KEYS) {
    if (statsOf.some((s) => s[k] != null)) stats[k] = Math.max(...statsOf.filter((s) => s[k] != null).map((s) => num(s[k])));
  }
  for (const k of UNION_KEYS) {
    if (!statsOf.some((s) => Array.isArray(s[k]))) continue;
    const seen = new Map<string, unknown>();
    for (const s of statsOf) {
      if (!Array.isArray(s[k])) continue;
      for (const v of s[k]) {
        const key = typeof v === 'string' ? v : JSON.stringify(v);
        if (!seen.has(key)) seen.set(key, v);
      }
    }
    stats[k] = Array.from(seen.values());
  }
  for (const [flag, at] of FLAG_KEYS) {
    const withFlag = statsOf.find((s) => s[flag] === true);
    if (withFlag) { stats[flag] = true; if (withFlag[at] != null) stats[at] = withFlag[at]; }
  }
  for (const k of IDENTITY_KEYS) {
    const v = statsOf.map((s) => s[k]).find((x) => x != null && x !== '');
    if (v != null) stats[k] = v;
  }
  // Shop boosters: per kind, the one that runs longest.
  if (statsOf.some((st) => st.activeBoosters && typeof st.activeBoosters === 'object')) {
    const boosters: Record<string, any> = {};
    for (const st of statsOf) {
      if (!st.activeBoosters || typeof st.activeBoosters !== 'object') continue;
      for (const [kind, b] of Object.entries(st.activeBoosters as Record<string, any>)) {
        if (!b || typeof b !== 'object') continue;
        if (!boosters[kind] || num(b.expiresAt) > num(boosters[kind].expiresAt)) boosters[kind] = b;
      }
    }
    stats.activeBoosters = boosters;
  }
  stats.masterUserId = String(masterUserId);
  stats.accountMergedAt = nowIso;
  stats.accountMergedFrom = others.map((r) => r.id);

  const firstNonEmpty = (pick: (r: LocalUserRow) => unknown) => {
    for (const r of ordered) { const v = pick(r); if (isNonEmptyObject(v)) return v; }
    return pick(survivorRow) ?? null;
  };
  const claimDates = rows.map((r) => r.last_login_claim_date).filter((d) => Number.isFinite(dateMs(d)));
  const lastClaim = claimDates.length
    ? claimDates.reduce((a, b) => (dateMs(b) > dateMs(a) ? b : a))
    : null;
  const createdDates = rows.map((r) => r.created_at).filter((d) => Number.isFinite(dateMs(d)));
  const created = createdDates.length ? createdDates.reduce((a, b) => (dateMs(b) < dateMs(a) ? b : a)) : null;
  const isoDate = (d: unknown) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));

  // Review 2026-10-10 (major): mark as EARNED every lifetime achievement the
  // MERGED state already satisfies. Summed counters / the other row's level
  // would otherwise make checkAchievements pay those rewards AGAIN on the first
  // hand (rehearsal: ~1M chips + 8k stars across 13-15 survivors), and the
  // 2026-06-19..10-10 save bug left many already-paid achievements unrecorded.
  // Owner rule applied: a reward is never paid for a threshold the merge alone
  // crossed.
  const achievements = Array.from(new Set([
    ...unionedAchievements,
    ...lifetimeAchievementsSatisfiedBy(progressStateFrom(topLevel, stats)),
  ])).sort();

  const plan: MergePlan = {
    masterUserId: String(masterUserId),
    survivorId: survivorRow.id,
    loserIds: others.map((r) => r.id),
    survivor: {
      chips: totals.chips,
      stars: totals.stars,
      scratch_cards_available: totals.scratch,
      hands_since_last_scratch: Math.max(...rows.map((r) => num(r.hands_since_last_scratch))),
      level: topLevel,
      xp,
      achievements: JSON.stringify(achievements),
      stats: JSON.stringify(stats),
      login_streak: Math.max(...rows.map((r) => num(r.login_streak))),
      last_login_claim_date: lastClaim == null ? null : (lastClaim instanceof Date ? lastClaim.toISOString().slice(0, 10) : String(lastClaim).slice(0, 10)),
      is_admin: rows.some((r) => !!r.is_admin),
      banned: rows.some((r) => !!r.banned),
      customization: firstNonEmpty((r) => r.customization),
      preferences: firstNonEmpty((r) => r.preferences),
      display_name: survivorRow.display_name || others.map((r) => r.display_name).find((d) => !!d) || null,
      created_at: isoDate(created),
    },
    tombstones: others.map((r) => {
      const s = parseStatsColumn(r.stats);
      const t: Record<string, any> = { mergedInto: survivorRow.id, mergedAt: nowIso, mergedFromMasterUserId: String(masterUserId) };
      for (const k of DESCRIPTIVE_KEYS) if (s[k] != null) t[k] = s[k];
      return { id: r.id, username: tombstoneUsername(r.id, r.username), stats: JSON.stringify(t), token_version: num(r.token_version) + 1 };
    }),
    totals,
  };
  if (totals.chips > INT4_MAX || totals.stars > INT4_MAX || totals.scratch > INT4_MAX) {
    plan.refuse = `int4 overflow (chips=${totals.chips} stars=${totals.stars} scratch=${totals.scratch})`;
  }
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// Master-first resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQL predicate: the row's stats carry this master id (param) and the row is
 * not a tombstone. TEXT-safe (`stats::text` is a no-op on TEXT and works on
 * JSONB) and corrupt-row-safe (pg_input_is_valid, PG16+; prod is PG18), so one
 * bad row can never fail every sign-in.
 */
export function masterRowSql(param: string): string {
  return `(CASE WHEN pg_input_is_valid(users.stats::text, 'jsonb')
                THEN (users.stats::text)::jsonb ->> 'masterUserId' END) = ${param}
          AND NOT COALESCE(CASE WHEN pg_input_is_valid(users.stats::text, 'jsonb')
                THEN ((users.stats::text)::jsonb ? 'mergedInto') END, false)`;
}

export const identityResolverStats = { lookups: 0, found: 0, splitSeen: 0, errors: 0, retried: 0, failed: 0, lockWaits: 0 };

/** Thrown when the master lookup could not be answered (DB error after retries). */
export class MasterLookupError extends Error {
  constructor(message: string) { super(message); this.name = 'MasterLookupError'; }
}

const LOOKUP_RETRY_DELAYS_MS = [250, 750];

/**
 * The ONE local row for a master account, or null when it has none yet. Used by
 * every sign-in path BEFORE it falls back to its own key-based upsert. If a
 * master is still split (the boot merge refused or has not run), picks the row
 * the merge would keep and logs the split.
 *
 * 🚨 A DB ERROR IS NOT "NO ROW". Review 2026-10-10: treating a failed lookup as
 * "not found" sent the sign-in to the key-based INSERT, which after the merge
 * freed the retired rows' usernames created a brand-new 50,000-chip row for an
 * existing person (a pool-timeout burst at the gate opening made it ~1 in 3).
 * A transient error is retried; if it persists this THROWS MasterLookupError
 * and the caller fails the sign-in (retryable) — it never inserts.
 */
export async function findLocalUserByMasterId(pool: Pool, masterUserId: string): Promise<any | null> {
  if (!masterUserId) return null;
  identityResolverStats.lookups++;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= LOOKUP_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      identityResolverStats.retried++;
      await new Promise((r) => setTimeout(r, LOOKUP_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const { rows } = await pool.query(`SELECT * FROM users WHERE ${masterRowSql('$1')} LIMIT 10`, [String(masterUserId)]);
      if (!rows.length) return null;
      identityResolverStats.found++;
      if (rows.length > 1) {
        identityResolverStats.splitSeen++;
        console.warn(`[identity] master ${masterUserId} still has ${rows.length} local rows (${rows.map((r: any) => r.id).join(',')}) — using the merge survivor rule`);
        return pickSurvivor(rows);
      }
      return rows[0];
    } catch (e: any) {
      identityResolverStats.errors++;
      lastErr = e;
    }
  }
  identityResolverStats.failed++;
  const msg = String((lastErr as any)?.message || lastErr || 'unknown').slice(0, 160);
  console.error(`[identity] master lookup failed after retries (sign-in refused, never inserts): ${msg}`);
  throw new MasterLookupError(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-master serialization
// ─────────────────────────────────────────────────────────────────────────────

const masterLocks = new Map<string, Promise<void>>();

/**
 * Run `fn` with no other resolution of the SAME master account in flight in
 * this process. Review 2026-10-10: a Play Online tap sends `oauthLogin` (the
 * bridge) and `authWithTicket` together on one socket; for a brand-new player
 * both looked up the master, both found nothing, and both INSERTed — two rows
 * again. Serialized, the second one finds the first's row. (Both events of one
 * tap arrive on one socket, i.e. one process; every DB statement inside is
 * bounded by statement_timeout, so a holder cannot wedge the chain.)
 */
export async function withMasterLock<T>(masterId: string, fn: () => Promise<T>): Promise<T> {
  const key = String(masterId || '');
  if (!key) return fn();
  const prev = masterLocks.get(key);
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = (prev || Promise.resolve()).then(() => mine);
  masterLocks.set(key, tail);
  if (prev) {
    identityResolverStats.lockWaits++;
    try { await prev; } catch { /* a failed holder still releases */ }
  }
  try {
    return await fn();
  } finally {
    release();
    if (masterLocks.get(key) === tail) masterLocks.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity gate
// ─────────────────────────────────────────────────────────────────────────────

let gateOpen = false;
let gateReason = '';
let openGate: () => void = () => {};
const gatePromise = new Promise<void>((resolve) => { openGate = resolve; });
export const identityGateStats = { waited: 0, timedOut: 0, openedAt: null as string | null };

export function releaseIdentityGate(reason: string): void {
  if (gateOpen) return;
  gateOpen = true;
  gateReason = reason;
  identityGateStats.openedAt = new Date().toISOString();
  console.log(`[identity-gate] open (${reason})`);
  openGate();
}

export function identityGateState(): { open: boolean; reason: string } {
  return { open: gateOpen, reason: gateReason };
}

/** Spread of the post-gate release (see awaitIdentityGate). */
export const GATE_RELEASE_JITTER_MS = 3_000;

/**
 * Sign-ins await this before they resolve a local row. Bounded. A sign-in that
 * actually WAITED is released after a random 0-GATE_RELEASE_JITTER_MS delay, so
 * the backlog that piled up during the boot operations does not hit the
 * 10-connection pool all at once (review 2026-10-10: a simultaneous release of
 * 100 sign-ins timed out ~1 in 3 DB acquisitions).
 */
export async function awaitIdentityGate(maxMs: number = IDENTITY_GATE_MAX_WAIT_MS): Promise<void> {
  if (gateOpen) return;
  identityGateStats.waited++;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    gatePromise.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), maxMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) identityGateStats.timedOut++;
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * GATE_RELEASE_JITTER_MS)));
}

// Failsafe: the gate can never stay shut (a boot path that throws before it
// schedules the operations must not lock every sign-in out).
setTimeout(() => releaseIdentityGate('failsafe_timer'), 300_000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// DB objects
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureMergeTables(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS account_merges (
    id BIGSERIAL PRIMARY KEY,
    master_user_id TEXT NOT NULL,
    survivor_id INTEGER NOT NULL,
    loser_ids INTEGER[] NOT NULL,
    before JSONB NOT NULL,
    after JSONB NOT NULL,
    repointed JSONB NOT NULL,
    archived_rows INTEGER NOT NULL DEFAULT 0,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS merged_rows_archive (
    id BIGSERIAL PRIMARY KEY,
    master_user_id TEXT NOT NULL,
    survivor_id INTEGER NOT NULL,
    loser_id INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    row_data JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS merged_account_redirects (
    id BIGSERIAL PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    chips BIGINT NOT NULL DEFAULT 0,
    stars BIGINT NOT NULL DEFAULT 0,
    scratch BIGINT NOT NULL DEFAULT 0,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

/**
 * BEFORE UPDATE trigger on users: a CREDIT to a tombstone's chips / stars /
 * scratch cards goes to its survivor instead (logged); the tombstone's own
 * balances never change. Idempotent (CREATE OR REPLACE).
 */
export async function installMergedCreditRedirect(pool: Pool): Promise<void> {
  await pool.query(`CREATE OR REPLACE FUNCTION redirect_merged_account_credit() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      target integer;
      d_chips bigint := COALESCE(NEW.chips, 0)::bigint - COALESCE(OLD.chips, 0)::bigint;
      d_stars bigint := COALESCE(NEW.stars, 0)::bigint - COALESCE(OLD.stars, 0)::bigint;
      d_scratch bigint := COALESCE(NEW.scratch_cards_available, 0)::bigint - COALESCE(OLD.scratch_cards_available, 0)::bigint;
    BEGIN
      IF NOT pg_input_is_valid(OLD.stats::text, 'jsonb') THEN RETURN NEW; END IF;
      target := NULLIF((OLD.stats::text)::jsonb ->> 'mergedInto', '')::integer;
      IF target IS NULL OR target = OLD.id THEN RETURN NEW; END IF;
      IF d_chips > 0 OR d_stars > 0 OR d_scratch > 0 THEN
        UPDATE users
           SET chips = chips + GREATEST(d_chips, 0),
               stars = COALESCE(stars, 0) + GREATEST(d_stars, 0),
               scratch_cards_available = COALESCE(scratch_cards_available, 0) + GREATEST(d_scratch, 0)
         WHERE id = target;
        INSERT INTO merged_account_redirects (from_id, to_id, chips, stars, scratch)
             VALUES (OLD.id, target, GREATEST(d_chips, 0), GREATEST(d_stars, 0), GREATEST(d_scratch, 0));
      END IF;
      NEW.chips := OLD.chips;
      NEW.stars := OLD.stars;
      NEW.scratch_cards_available := OLD.scratch_cards_available;
      RETURN NEW;
    END
    $fn$`);
  // CREATE OR REPLACE TRIGGER (PG14+): one statement — no window without the
  // trigger and no DROP on every boot (review 2026-10-10).
  await pool.query(`CREATE OR REPLACE TRIGGER trg_redirect_merged_account_credit
    BEFORE UPDATE OF chips, stars, scratch_cards_available ON users
    FOR EACH ROW WHEN (OLD.stats::text LIKE '%"mergedInto"%')
    EXECUTE FUNCTION redirect_merged_account_credit()`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Child tables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every table/column that holds a local users.id. `unique`:
 *   null      — no unique key involves the column: plain re-point;
 *   []        — the column alone is unique (PK): keep the survivor's row,
 *               archive the loser's;
 *   [cols...] — unique with these columns: archive the loser's rows that would
 *               collide with the survivor's, re-point the rest.
 * prediction_wallets (balances SUMMED) and friendships (normalized pairs) are
 * handled separately. Any FOREIGN KEY to users that is not listed here makes
 * the whole operation refuse to run (a future table must be added here first).
 */
export const REPOINT_SPECS: Array<{ table: string; col: string; unique: string[] | null }> = [
  { table: 'user_hand_history', col: 'user_id', unique: ['hand_id'] },
  { table: 'user_daily_claims', col: 'user_id', unique: ['claim_type', 'claim_date'] },
  { table: 'user_daily_achievements', col: 'user_id', unique: ['ach_id', 'claim_date'] },
  { table: 'user_weekly_achievements', col: 'user_id', unique: ['ach_id', 'week_start_date'] },
  { table: 'user_battle_pass_claims', col: 'user_id', unique: ['season_id', 'tier_id', 'track'] },
  { table: 'user_inventory', col: 'user_id', unique: ['item_type', 'item_id'] },
  { table: 'user_career_progress', col: 'user_id', unique: ['venue', 'stage'] },
  { table: 'user_career_reward_claims', col: 'user_id', unique: ['venue'] },
  { table: 'season_leaderboard_awards', col: 'user_id', unique: ['season_key'] },
  { table: 'prediction_bets', col: 'user_id', unique: ['table_id', 'hand_number', 'market_id'] },
  { table: 'prediction_picks', col: 'user_id', unique: ['table_id', 'hand_number'] },
  { table: 'prediction_spectator_stats', col: 'user_id', unique: [] },
  { table: 'club_members', col: 'userid', unique: ['clubid'] },
  { table: 'club_members', col: 'referred_by', unique: null },
  { table: 'club_stats', col: 'userid', unique: ['clubid'] },
  { table: 'club_tournament_registrations', col: 'userid', unique: ['tournamentid'] },
  { table: 'club_messages', col: 'userid', unique: null },
  { table: 'club_invitations', col: 'invited_user_id', unique: null },
  { table: 'club_invitations', col: 'inviterid', unique: null },
  { table: 'club_challenges', col: 'winnerid', unique: null },
  { table: 'clubs', col: 'ownerid', unique: null },
  { table: 'social_bracket_sidebets', col: 'bettor_user_id', unique: null },
  { table: 'staking_offers', col: 'seller_id', unique: null },
  { table: 'online_entry_codes', col: 'created_by', unique: null },
  { table: 'online_entry_codes', col: 'redeemed_by', unique: null },
  { table: 'online_promotions', col: 'created_by', unique: null },
  { table: 'referral_reward_grants', col: 'referrerid', unique: null },
  { table: 'referral_reward_grants', col: 'refereeid', unique: [] },
];
const SPECIAL_COLUMNS = [
  { table: 'prediction_wallets', col: 'user_id' },
  { table: 'friendships', col: 'user_lo' },
  { table: 'friendships', col: 'user_hi' },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
function q(id: string): string {
  if (!IDENT.test(id)) throw new Error(`unsafe identifier ${id}`);
  return `"${id}"`;
}

async function existingColumns(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query(
    `SELECT table_name || '.' || column_name AS tc FROM information_schema.columns WHERE table_schema = 'public'`
  );
  return new Set(rows.map((r: any) => String(r.tc)));
}

/** FKs to users that this module does not know how to move → refuse. */
export async function unhandledUserForeignKeys(pool: Pool | PoolClient): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'users'`);
  const known = new Set([...REPOINT_SPECS, ...SPECIAL_COLUMNS].map((s) => `${s.table}.${s.col}`));
  return rows.map((r: any) => `${r.table_name}.${r.column_name}`).filter((tc: string) => !known.has(tc));
}

async function archiveAndDelete(
  client: PoolClient, table: string, whereSql: string, params: unknown[],
  ctx: { master: string; survivor: number; loser: number },
): Promise<number> {
  const ins = await client.query(
    `INSERT INTO merged_rows_archive (master_user_id, survivor_id, loser_id, table_name, row_data)
     SELECT $${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, to_jsonb(t)
       FROM ${q(table)} t WHERE ${whereSql}`,
    [...params, ctx.master, ctx.survivor, ctx.loser, table],
  );
  const del = await client.query(`DELETE FROM ${q(table)} t WHERE ${whereSql}`, params);
  if ((ins.rowCount || 0) !== (del.rowCount || 0)) throw new Error(`archive/delete mismatch on ${table}`);
  return del.rowCount || 0;
}

interface RepointResult { moved: Record<string, number>; archived: number }

async function repointChildRows(
  client: PoolClient, cols: Set<string>, master: string, survivor: number, loser: number,
): Promise<RepointResult> {
  const moved: Record<string, number> = {};
  let archived = 0;
  const ctx = { master, survivor, loser };
  for (const spec of REPOINT_SPECS) {
    if (!cols.has(`${spec.table}.${spec.col}`)) continue;
    if (spec.unique && !spec.unique.every((c) => cols.has(`${spec.table}.${c}`))) {
      throw new Error(`schema drift: ${spec.table} lacks one of ${spec.unique.join(',')}`);
    }
    const T = q(spec.table); const C = q(spec.col);
    if (spec.unique) {
      const match = spec.unique.map((c) => `s.${q(c)} IS NOT DISTINCT FROM t.${q(c)}`).join(' AND ');
      const collide = `t.${C} = $1 AND EXISTS (SELECT 1 FROM ${T} s WHERE s.${C} = $2${match ? ` AND ${match}` : ''})`;
      archived += await archiveAndDelete(client, spec.table, collide, [loser, survivor], ctx);
    }
    const upd = await client.query(`UPDATE ${T} SET ${C} = $2 WHERE ${C} = $1`, [loser, survivor]);
    if (upd.rowCount) moved[`${spec.table}.${spec.col}`] = upd.rowCount;
  }

  // prediction_wallets: one balance per user. If the survivor has a wallet the
  // loser's balance is ADDED to it and the loser's row archived; otherwise the
  // loser's row simply becomes the survivor's (re-pointed, nothing archived).
  if (cols.has('prediction_wallets.user_id') && cols.has('prediction_wallets.balance')) {
    const { rows } = await client.query(`SELECT balance FROM prediction_wallets WHERE user_id = $1 FOR UPDATE`, [loser]);
    if (rows.length) {
      const bal = num(rows[0].balance);
      const has = await client.query(`SELECT 1 FROM prediction_wallets WHERE user_id = $1 FOR UPDATE`, [survivor]);
      if (has.rowCount) {
        await client.query(`UPDATE prediction_wallets SET balance = balance + $2 WHERE user_id = $1`, [survivor, bal]);
        archived += await archiveAndDelete(client, 'prediction_wallets', `t.user_id = $1`, [loser], ctx);
      } else {
        await client.query(`UPDATE prediction_wallets SET user_id = $2 WHERE user_id = $1`, [loser, survivor]);
      }
      moved['prediction_wallets.balance'] = (moved['prediction_wallets.balance'] || 0) + bal;
    }
  }

  // friendships: normalized (user_lo < user_hi) pairs.
  if (cols.has('friendships.user_lo') && cols.has('friendships.user_hi')) {
    const { rows } = await client.query(
      `SELECT * FROM friendships WHERE user_lo = $1 OR user_hi = $1 FOR UPDATE`, [loser],
    );
    for (const f of rows) {
      const other = num(f.user_lo) === loser ? num(f.user_hi) : num(f.user_lo);
      const lo = Math.min(survivor, other); const hi = Math.max(survivor, other);
      const dup = other === survivor
        || (await client.query(`SELECT 1 FROM friendships WHERE user_lo = $1 AND user_hi = $2 AND id <> $3`, [lo, hi, f.id])).rowCount;
      if (dup) {
        archived += await archiveAndDelete(client, 'friendships', `t.id = $1`, [f.id], ctx);
      } else {
        await client.query(`UPDATE friendships SET user_lo = $1, user_hi = $2 WHERE id = $3`, [lo, hi, f.id]);
        moved['friendships'] = (moved['friendships'] || 0) + 1;
      }
    }
  }
  return { moved, archived };
}

async function countChildRows(client: PoolClient, cols: Set<string>, ids: number[]): Promise<number> {
  let total = 0;
  const seen = new Set<string>();
  for (const s of [...REPOINT_SPECS, ...SPECIAL_COLUMNS]) {
    if (!cols.has(`${s.table}.${s.col}`)) continue;
    const key = `${s.table}.${s.col}`;
    if (seen.has(key)) continue; seen.add(key);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${q(s.table)} WHERE ${q(s.col)} = ANY($1::int[])`, [ids]);
    total += num(rows[0]?.n);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// The merge
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeOutcome {
  status: 'done' | 'skipped_already_done' | 'refused' | 'error';
  groups: number;
  merged: number;
  skipped: Array<{ master: string; reason: string }>;
  rowsRetired: number;
  archivedRows: number;
  error?: string;
}

type AuditFn = (actor: string, action: string, details: Record<string, unknown>) => void;

/** Masters with 2+ live (non-tombstone) local rows. */
export async function splitMasters(pool: Pool | PoolClient): Promise<Array<{ master: string; ids: number[] }>> {
  const { rows } = await pool.query(`
    SELECT m AS master, array_agg(id ORDER BY id) AS ids FROM (
      SELECT id, CASE WHEN pg_input_is_valid(stats::text, 'jsonb') THEN (stats::text)::jsonb ->> 'masterUserId' END AS m,
             COALESCE(CASE WHEN pg_input_is_valid(stats::text, 'jsonb') THEN ((stats::text)::jsonb ? 'mergedInto') END, false) AS tomb
        FROM users) u
     WHERE m IS NOT NULL AND m <> '' AND NOT tomb
     GROUP BY m HAVING count(*) > 1 ORDER BY m`);
  return rows.map((r: any) => ({ master: String(r.master), ids: (r.ids as any[]).map(Number) }));
}

async function mergeOneMaster(
  pool: Pool, cols: Set<string>, master: string, ids: number[], nowIso: string, audit: AuditFn,
): Promise<{ ok: true; plan: MergePlan; archived: number; repointed: Record<string, number> } | { ok: false; reason: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-read under lock: the group may have changed since the scan.
    const { rows } = await client.query(`SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
    const live = rows.filter((r: any) => {
      const s = parseStatsColumn(r.stats);
      return String(s.masterUserId ?? '') === master && !isMergedTombstone(r.stats);
    });
    if (live.length < 2) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_longer_split' }; }
    const liveIds = live.map((r: any) => Number(r.id));
    const plan = planAccountMerge(master, live as LocalUserRow[], nowIso);
    if (plan.refuse) { await client.query('ROLLBACK'); return { ok: false, reason: plan.refuse }; }

    const childBefore = await countChildRows(client, cols, liveIds);
    const walletSum = async (): Promise<number> => {
      if (!cols.has('prediction_wallets.balance')) return 0;
      const { rows: w } = await client.query(`SELECT COALESCE(sum(balance),0)::bigint AS b FROM prediction_wallets WHERE user_id = ANY($1::int[])`, [liveIds]);
      return num(w[0]?.b);
    };
    const walletBefore = await walletSum();
    // The COMPLETE prior users rows (every column but password_hash), so the
    // users side of a merge can be reversed from account_merges alone (review
    // 2026-10-10: customization / preferences / streak / dates were missing).
    // Child rows: moved counts here, collisions in merged_rows_archive, and the
    // pre-merge backup (backups/railway-online-2026-10-10-premerge) holds all.
    const before = live.map((r: any) => {
      const { password_hash: _omit, ...rest } = r;
      return { ...rest, stats: parseStatsColumn(r.stats), achievements: parseAchievements(r.achievements) };
    });

    // 1. Retire the losers FIRST (frees their usernames; zeroes balances while
    //    their stats still carry no mergedInto, so the redirect trigger is not
    //    involved in the merge's own writes).
    for (const t of plan.tombstones) {
      await client.query(
        `UPDATE users SET username = $2, stats = $3, token_version = $4,
                chips = 0, stars = 0, scratch_cards_available = 0, hands_since_last_scratch = 0,
                level = 1, xp = 0, achievements = '[]', banned = TRUE, is_admin = FALSE
          WHERE id = $1`,
        [t.id, t.username, t.stats, t.token_version],
      );
    }
    // 2. The survivor takes everything.
    const s = plan.survivor;
    await client.query(
      `UPDATE users SET chips = $2, stars = $3, scratch_cards_available = $4, hands_since_last_scratch = $5,
              level = $6, xp = $7, achievements = $8, stats = $9, login_streak = $10,
              last_login_claim_date = $11::date, is_admin = $12, banned = $13,
              customization = $14::jsonb, preferences = $15::jsonb, display_name = $16,
              created_at = COALESCE($17::timestamptz, created_at)
        WHERE id = $1`,
      [plan.survivorId, s.chips, s.stars, s.scratch_cards_available, s.hands_since_last_scratch,
        s.level, s.xp, s.achievements, s.stats, s.login_streak, s.last_login_claim_date, s.is_admin, s.banned,
        s.customization == null ? null : (typeof s.customization === 'string' ? s.customization : JSON.stringify(s.customization)),
        s.preferences == null ? null : (typeof s.preferences === 'string' ? s.preferences : JSON.stringify(s.preferences)),
        s.display_name, s.created_at],
    );
    // 3. Child rows.
    const repointed: Record<string, number> = {};
    let archived = 0;
    for (const loser of plan.loserIds) {
      const r = await repointChildRows(client, cols, master, plan.survivorId, loser);
      archived += r.archived;
      for (const [k, v] of Object.entries(r.moved)) repointed[k] = (repointed[k] || 0) + v;
    }
    // Hand history keeps the newest 100 per player (authManager.recordHand prunes
    // the rest on the next hand, unarchived). The merged history beyond that is
    // ARCHIVED here instead of silently dropped later (review 2026-10-10).
    if (cols.has('user_hand_history.user_id') && cols.has('user_hand_history.created_at')) {
      archived += await archiveAndDelete(client, 'user_hand_history',
        `t.user_id = $1 AND t.id NOT IN (SELECT id FROM user_hand_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100)`,
        [plan.survivorId], { master, survivor: plan.survivorId, loser: plan.survivorId });
    }

    // 4. Invariants — abort the group on any mismatch.
    const { rows: after } = await client.query(
      `SELECT COALESCE(sum(chips),0)::bigint AS chips, COALESCE(sum(stars),0)::bigint AS stars,
              COALESCE(sum(scratch_cards_available),0)::bigint AS scratch
         FROM users WHERE id = ANY($1::int[])`, [liveIds],
    );
    const a = after[0];
    if (num(a.chips) !== plan.totals.chips || num(a.stars) !== plan.totals.stars || num(a.scratch) !== plan.totals.scratch) {
      throw new Error(`balance invariant failed: before ${JSON.stringify(plan.totals)} after ${JSON.stringify(a)}`);
    }
    const walletAfter = await walletSum();
    if (walletAfter !== walletBefore) throw new Error(`prediction wallet invariant failed: before ${walletBefore} after ${walletAfter}`);
    const childAfter = await countChildRows(client, cols, liveIds);
    if (childAfter + archived !== childBefore) {
      throw new Error(`child-row invariant failed: before ${childBefore} after ${childAfter} archived ${archived}`);
    }
    const { rows: still } = await client.query(
      `SELECT count(*)::int AS n FROM users WHERE id = ANY($1::int[]) AND ${masterRowSql('$2')}`, [liveIds, master],
    );
    if (num(still[0]?.n) !== 1) throw new Error(`resolver invariant failed: ${still[0]?.n} live rows remain`);

    await client.query(
      `INSERT INTO account_merges (master_user_id, survivor_id, loser_ids, before, after, repointed, archived_rows)
       VALUES ($1, $2, $3::int[], $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
      [master, plan.survivorId, plan.loserIds, JSON.stringify(before),
        JSON.stringify({ ...plan.survivor, achievements: JSON.parse(plan.survivor.achievements), stats: JSON.parse(plan.survivor.stats) }),
        JSON.stringify(repointed), archived],
    );
    await client.query('COMMIT');
    audit('SYSTEM', 'ACCOUNT_MERGE', {
      masterUserId: master, survivorId: plan.survivorId, loserIds: plan.loserIds,
      chips: plan.totals.chips, stars: plan.totals.stars, level: plan.survivor.level, archivedRows: archived,
    });
    return { ok: true, plan, archived, repointed };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, reason: `error: ${String(e?.message || e).slice(0, 200)}` };
  } finally {
    client.release();
  }
}

/** Claim a one-time op unless it is already done (a crashed 'running' claim re-runs). */
async function claimOp(pool: Pool, opId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO one_time_ops (op_id, detail) VALUES ($1, '{"status":"running","attempts":1}'::jsonb)
       ON CONFLICT (op_id) DO UPDATE SET ran_at = NOW(),
         detail = jsonb_build_object('status', 'running',
                                     'attempts', COALESCE((one_time_ops.detail->>'attempts')::int, 0) + 1)
         WHERE COALESCE(one_time_ops.detail->>'status', '') NOT IN ('done', 'refused')
     RETURNING op_id`,
    [opId],
  );
  return rowCount === 1;
}

export async function opStatus(pool: Pool, opId: string): Promise<string | null> {
  return (await opState(pool, opId)).status;
}

export async function opState(pool: Pool, opId: string): Promise<{ status: string | null; attempts: number }> {
  const { rows } = await pool.query(`SELECT detail->>'status' AS s, COALESCE((detail->>'attempts')::int, 0) AS a FROM one_time_ops WHERE op_id = $1`, [opId]);
  return { status: rows[0]?.s ?? null, attempts: num(rows[0]?.a) };
}

/** A merge that skipped groups or errored is retried on later boots, at most this often in all. */
export const MERGE_MAX_ATTEMPTS = 3;

export async function opDone(pool: Pool, opId: string): Promise<boolean> {
  return (await opStatus(pool, opId)) === 'done';
}

export async function runAccountMerge(pool: Pool, audit: AuditFn, nowIso: string = new Date().toISOString()): Promise<MergeOutcome> {
  const out: MergeOutcome = { status: 'done', groups: 0, merged: 0, skipped: [], rowsRetired: 0, archivedRows: 0 };
  try {
    await ensureMergeTables(pool);
    if (!(await claimOp(pool, MERGE_OP_ID))) { out.status = 'skipped_already_done'; return out; }
    const unhandled = await unhandledUserForeignKeys(pool);
    if (unhandled.length) {
      out.status = 'refused';
      out.error = `unhandled foreign keys to users: ${unhandled.join(', ')}`;
      await pool.query(`UPDATE one_time_ops SET detail = $2::jsonb WHERE op_id = $1`, [MERGE_OP_ID, JSON.stringify({ status: 'refused', error: out.error })]);
      console.error(`[account-merge] REFUSED: ${out.error}`);
      return out;
    }
    const client = await pool.connect();
    let cols: Set<string>;
    try { cols = await existingColumns(client); } finally { client.release(); }
    const groups = await splitMasters(pool);
    out.groups = groups.length;
    for (const g of groups) {
      const r = await mergeOneMaster(pool, cols, g.master, g.ids, nowIso, audit);
      if (r.ok) {
        out.merged++;
        out.rowsRetired += r.plan.loserIds.length;
        out.archivedRows += r.archived;
      } else {
        out.skipped.push({ master: g.master, reason: r.reason });
        console.warn(`[account-merge] master ${g.master} not merged: ${r.reason}`);
      }
    }
    await pool.query(`UPDATE one_time_ops SET detail = $2::jsonb WHERE op_id = $1`,
      [MERGE_OP_ID, JSON.stringify({
        // 'partial' (some masters skipped — a lock wait, a statement timeout) is
        // retried on the next boot, up to MERGE_MAX_ATTEMPTS (review 2026-10-10).
        status: out.skipped.length ? 'partial' : 'done', attempts: (await opState(pool, MERGE_OP_ID)).attempts,
        groups: out.groups, merged: out.merged, rowsRetired: out.rowsRetired, archivedRows: out.archivedRows, skipped: out.skipped,
      })]);
    console.log(`[account-merge] done: ${out.merged}/${out.groups} split account(s) merged, ${out.rowsRetired} row(s) retired, ${out.archivedRows} colliding child row(s) archived, ${out.skipped.length} skipped`);
    return out;
  } catch (e: any) {
    out.status = 'error';
    out.error = String(e?.message || e).slice(0, 300);
    console.error('[account-merge] FAILED:', out.error);
    // Recorded so later boots neither hold sign-ins for it nor re-run it blindly
    // (groups are each atomic, so a partial run is consistent). An owner resets
    // the one_time_ops row to re-run. A process KILLED mid-run leaves
    // 'running', which the next boot does resume.
    try {
      await pool.query(`UPDATE one_time_ops SET detail = $2::jsonb WHERE op_id = $1`,
        [MERGE_OP_ID, JSON.stringify({ status: 'error', attempts: (await opState(pool, MERGE_OP_ID)).attempts, error: out.error, merged: out.merged, groups: out.groups })]);
    } catch { /* the log line above is the record */ }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Goodwill grant
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Achievement backfill
// ─────────────────────────────────────────────────────────────────────────────

export const ACH_BACKFILL_OP_ID = 'achievement_backfill_2026_10_10';

export interface BackfillOutcome { status: 'done' | 'skipped_already_done' | 'error'; rows: number; added: number; error?: string }

/**
 * One-time: every live row gets every LIFETIME achievement its stored level +
 * counters already satisfy added to its achievements list (union only — no
 * balance is touched). Review 2026-10-10: the saveProgress bug
 * (2026-06-19..10-10) paid achievement rewards but never stored the ids, so
 * checkAchievements kept paying them again; without this every player would be
 * paid once more on their next hand. Exactly once: claim + writes + done in ONE
 * transaction. Runs inside the identity gate, before any session hydrates.
 */
export async function runAchievementBackfill(pool: Pool, audit: AuditFn): Promise<BackfillOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO one_time_ops (op_id, detail) VALUES ($1, '{"status":"running"}'::jsonb)
         ON CONFLICT (op_id) DO NOTHING RETURNING op_id`, [ACH_BACKFILL_OP_ID],
    );
    if (claim.rowCount !== 1) { await client.query('ROLLBACK'); return { status: 'skipped_already_done', rows: 0, added: 0 }; }
    const { rows } = await client.query(`SELECT id, level, stats, achievements FROM users ORDER BY id FOR UPDATE`);
    let changed = 0;
    let added = 0;
    for (const r of rows) {
      if (isMergedTombstone(r.stats)) continue;
      const have = parseAchievements(r.achievements);
      const missing = lifetimeAchievementsSatisfiedBy(progressStateFrom(num(r.level), r.stats)).filter((a) => !have.includes(a));
      if (!missing.length) continue;
      const next = Array.from(new Set([...have, ...missing])).sort();
      await client.query('UPDATE users SET achievements = $2 WHERE id = $1', [r.id, JSON.stringify(next)]);
      changed++;
      added += missing.length;
    }
    await client.query(`UPDATE one_time_ops SET detail = $2::jsonb WHERE op_id = $1`,
      [ACH_BACKFILL_OP_ID, JSON.stringify({ status: 'done', rows: changed, added })]);
    await client.query('COMMIT');
    audit('SYSTEM', 'ACHIEVEMENT_BACKFILL', { rows: changed, added, reason: 'progress_save_bug_2026_06_19' });
    console.log(`[achievement-backfill] marked ${added} already-satisfied achievement(s) earned on ${changed} row(s)`);
    return { status: 'done', rows: changed, added };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    const error = String(e?.message || e).slice(0, 300);
    console.error('[achievement-backfill] FAILED (nothing written; retried next boot):', error);
    return { status: 'error', rows: 0, added: 0, error };
  } finally {
    client.release();
  }
}

export interface GoodwillOutcome { status: 'done' | 'skipped_already_done' | 'error'; recipients: number; amount: number; error?: string }

/**
 * 50,000 chips, once, per PERSON who played .online since GOODWILL_SINCE_ISO
 * (stats.lastHandAt, or a user_hand_history row, on/after it). Tombstones and
 * banned rows are excluded; rows still sharing a master account (a split the
 * merge refused) are granted ONCE, on the row the merge would keep. Claim,
 * grant and the recipient list commit in ONE transaction — exactly once.
 */
export async function runGoodwillGrant(pool: Pool, audit: AuditFn): Promise<GoodwillOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO one_time_ops (op_id, detail) VALUES ($1, '{"status":"running"}'::jsonb)
         ON CONFLICT (op_id) DO NOTHING RETURNING op_id`, [GOODWILL_OP_ID],
    );
    if (claim.rowCount !== 1) { await client.query('ROLLBACK'); return { status: 'skipped_already_done', recipients: 0, amount: GOODWILL_AMOUNT }; }
    const hasHistory = (await client.query(`SELECT to_regclass('public.user_hand_history') IS NOT NULL AS ok`)).rows[0]?.ok;
    // `sj` is NULL for a row whose stats are not valid JSON (CASE guarantees the
    // cast never runs on it), so a corrupt row is skipped, never fatal.
    const { rows } = await client.query(
      `SELECT u.* FROM users u
        CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(u.stats::text, 'jsonb')
                                        THEN (u.stats::text)::jsonb END AS sj) x
        WHERE NOT COALESCE(u.banned, false)
          AND x.sj IS NOT NULL
          AND NOT (x.sj ? 'mergedInto')
          AND (
            (CASE WHEN jsonb_typeof(x.sj -> 'lastHandAt') = 'number'
                  THEN (x.sj ->> 'lastHandAt')::numeric ELSE 0 END) >= $1
            ${hasHistory ? `OR EXISTS (SELECT 1 FROM user_hand_history h WHERE h.user_id = u.id AND h.created_at >= $2::timestamptz)` : ''}
          )
        FOR UPDATE OF u`,
      hasHistory ? [GOODWILL_SINCE_MS, GOODWILL_SINCE_ISO] : [GOODWILL_SINCE_MS],
    );
    // One grant per PERSON = per American Pub Poker (master) account; grant the
    // merge-survivor row of each master's rows. Rows linked to NO master account
    // are skipped (review 2026-10-10): in production those are the old guest
    // rows (GuestNNNN) — guest play is off, so their only use is the guest
    // carry-over INTO a real account, which already gets its own grant (a
    // former guest would otherwise collect 2 x 50,000).
    const GUEST_ROW = /^guest\d+$/i;
    const byPerson = new Map<string, LocalUserRow[]>();
    let skippedUnlinked = 0;
    for (const r of rows as LocalUserRow[]) {
      const m = String(parseStatsColumn(r.stats).masterUserId ?? '');
      if (!m || GUEST_ROW.test(String(r.username || ''))) { skippedUnlinked++; continue; }
      const key = `m:${m}`;
      byPerson.set(key, [...(byPerson.get(key) || []), r]);
    }
    const recipientIds: number[] = [];
    for (const group of byPerson.values()) {
      const pick = pickSurvivor(group);
      if (num(pick.chips) <= INT4_MAX - GOODWILL_AMOUNT) recipientIds.push(pick.id);
    }
    recipientIds.sort((a, b) => a - b);
    if (recipientIds.length) {
      const upd = await client.query(`UPDATE users SET chips = chips + $2 WHERE id = ANY($1::int[])`, [recipientIds, GOODWILL_AMOUNT]);
      if (upd.rowCount !== recipientIds.length) throw new Error(`granted ${upd.rowCount} of ${recipientIds.length}`);
    }
    await client.query(`UPDATE one_time_ops SET detail = $2::jsonb WHERE op_id = $1`, [GOODWILL_OP_ID, JSON.stringify({
      status: 'done', amount: GOODWILL_AMOUNT, since: GOODWILL_SINCE_ISO, recipients: recipientIds.length, skippedUnlinked,
      totalChips: recipientIds.length * GOODWILL_AMOUNT, userIds: recipientIds,
      reason: 'saveProgress COALESCE bug (89ac65e, 2026-06-19) lost level/XP/achievement progress',
    })]);
    await client.query('COMMIT');
    for (const id of recipientIds) {
      audit('SYSTEM', 'GOODWILL_CHIP_GRANT', { targetUserId: id, amount: GOODWILL_AMOUNT, reason: 'progress_save_bug_2026_06_19' });
    }
    console.log(`[goodwill] granted ${GOODWILL_AMOUNT.toLocaleString()} chips to ${recipientIds.length} player(s) who played since ${GOODWILL_SINCE_ISO}`);
    return { status: 'done', recipients: recipientIds.length, amount: GOODWILL_AMOUNT };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    const error = String(e?.message || e).slice(0, 300);
    console.error('[goodwill] FAILED (nothing granted; retried next boot):', error);
    return { status: 'error', recipients: 0, amount: GOODWILL_AMOUNT, error };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot orchestration
// ─────────────────────────────────────────────────────────────────────────────

export const bootAccountOps: {
  scheduled: boolean; merge: MergeOutcome | null; backfill: BackfillOutcome | null; goodwill: GoodwillOutcome | null; startedAt: string | null; finishedAt: string | null;
  previousInstance: { olderConnections: number; waitedMs: number } | null;
} = { scheduled: false, merge: null, backfill: null, goodwill: null, startedAt: null, finishedAt: null, previousInstance: null };

/** When this process started (module load ≈ process start). */
const PROCESS_BOOT_ISO = new Date().toISOString();

/**
 * Belt and braces for the Railway overlap: wait (bounded) until no database
 * session that is OLDER than this process remains — the previous container's
 * pool. Proceeds anyway after `maxMs` (the old container is SIGKILLed long
 * before that); logs what it saw either way.
 */
export async function waitForPreviousInstanceGone(pool: Pool, maxMs = 60_000, pollMs = 3_000): Promise<{ olderConnections: number; waitedMs: number }> {
  const start = Date.now();
  let older = 0;
  for (;;) {
    try {
      // The previous container's sessions: anything opened before this process
      // booted, plus anything opened since that is NOT labelled as ours (the
      // old code set no application_name; later builds label every session
      // 'poker-server:<deployment>' — authManager DB_APPLICATION_NAME).
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND backend_type = 'client backend'
            AND application_name IS DISTINCT FROM current_setting('application_name')
            AND (backend_start < $1::timestamptz OR application_name = '' OR application_name LIKE 'poker-server%')`,
        [PROCESS_BOOT_ISO],
      );
      older = num(rows[0]?.n);
    } catch (e: any) {
      console.warn('[account-ops] pg_stat_activity check failed (proceeding):', e?.message || e);
      older = 0;
    }
    const waited = Date.now() - start;
    if (older === 0 || waited >= maxMs) {
      if (older > 0) console.warn(`[account-ops] ${older} database session(s) older than this process still open after ${waited}ms — proceeding`);
      return { olderConnections: older, waitedMs: waited };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Called once from the boot path after initDB. Installs the redirect trigger,
 * then, if any one-time operation is still pending:
 *   - the MERGE and the ACHIEVEMENT BACKFILL change what a session hydrates, so
 *     they run behind the identity gate, MERGE_START_DELAY_MS after boot plus
 *     waitForPreviousInstanceGone (Railway overlaps containers);
 *   - the GOODWILL grant is additive and per-person: it runs after them, or at
 *     once (gate open) when it is the only thing left.
 * A merge that is done or refused is settled. One that skipped masters
 * ('partial'), errored, or was killed mid-run ('running') is retried on later
 * boots, MERGE_MAX_ATTEMPTS in all (review 2026-10-10), so a persistent fault
 * cannot hold sign-ins on every boot.
 */
export async function scheduleBootAccountOps(pool: Pool, audit: AuditFn, delayMs: number = MERGE_START_DELAY_MS): Promise<void> {
  if (bootAccountOps.scheduled) return;
  bootAccountOps.scheduled = true;
  try {
    await ensureMergeTables(pool);
    await installMergedCreditRedirect(pool);
    const [mergeState, backfillStatus, goodwillStatus] = await Promise.all([
      opState(pool, MERGE_OP_ID), opStatus(pool, ACH_BACKFILL_OP_ID), opStatus(pool, GOODWILL_OP_ID),
    ]);
    const mergeFinal = mergeState.status === 'done' || mergeState.status === 'refused';
    const mergePending = !mergeFinal && mergeState.attempts < MERGE_MAX_ATTEMPTS;
    if (!mergeFinal && !mergePending) {
      console.error(`[account-ops] merge gave up after ${mergeState.attempts} attempt(s) (status ${mergeState.status}) — split masters stay split until an owner resets one_time_ops '${MERGE_OP_ID}'`);
    }
    const backfillPending = backfillStatus !== 'done';
    const goodwillPending = goodwillStatus !== 'done';
    if (!mergePending && !backfillPending && !goodwillPending) { releaseIdentityGate('ops_already_done'); return; }
    if (!mergePending && !backfillPending) {
      releaseIdentityGate('only_goodwill_pending');
      console.log('[account-ops] running the goodwill grant');
      bootAccountOps.startedAt = new Date().toISOString();
      bootAccountOps.goodwill = await runGoodwillGrant(pool, audit);
      bootAccountOps.finishedAt = new Date().toISOString();
      return;
    }
    console.log(`[account-ops] pending (merge=${mergeState.status ?? 'not run'}#${mergeState.attempts}, backfill=${backfillStatus ?? 'not run'}, goodwill=${goodwillStatus ?? 'not run'}) — starting in ${Math.round(delayMs / 1000)}s; sign-ins wait until then`);
    setTimeout(async () => {
      bootAccountOps.startedAt = new Date().toISOString();
      try {
        bootAccountOps.previousInstance = await waitForPreviousInstanceGone(pool);
        if (mergePending) bootAccountOps.merge = await runAccountMerge(pool, audit);
        if (backfillPending) bootAccountOps.backfill = await runAchievementBackfill(pool, audit);
        if (goodwillPending) bootAccountOps.goodwill = await runGoodwillGrant(pool, audit);
      } catch (e: any) {
        console.error('[account-ops] failed:', e?.message || e);
      } finally {
        bootAccountOps.finishedAt = new Date().toISOString();
        releaseIdentityGate('ops_finished');
      }
    }, delayMs).unref();
  } catch (e: any) {
    console.error('[account-ops] setup failed (sign-ins proceed; ops retried next boot):', e?.message || e);
    releaseIdentityGate('setup_failed');
  }
}

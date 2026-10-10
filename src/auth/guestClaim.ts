/**
 * 2026-10-09 — R2: GUEST PROGRESS CARRY-OVER (shared contract with poker-3d;
 * CONTRACTS.md C5 "Guest carry-over").
 *
 * Guest play is OFF (owner rule 2026-10-07): a former guest — a local
 * GuestNNNN row with no American Pub Poker identity (e.g. "PappyR" 4203 =
 * Guest1971, "Marvin a" 4402 = Guest9629) — must now play with an American
 * Pub Poker account. To make that painless, when he signs in with his account
 * on a device that still holds the guest's legacy HS256 token, .online offers
 * ONCE to carry the guest's chips + progress over:
 *
 *   socket 'claimGuestProgress' {guestToken}
 *     → 'claimGuestProgressResult' {success:true, chipsAdded, starsAdded, levelAfter, …}
 *                                | {success:false, code, error}
 *   socket 'peekGuestProgress'  {guestToken}   (read-only, for the prompt)
 *     → 'peekGuestProgressResult' {success:true, chips, stars, level, xp, achievementsCount, displayName}
 *                               | {success:false, code, error}
 *
 * Proof of ownership is the guest's own legacy token (JWT_SECRET signature
 * verified by authManager.verifyLegacyTokenClaims). An EXPIRED token is
 * accepted here — signature still checked, only `exp` waived — because
 * legacy tokens die 7 days after the last visit and a returning former guest
 * holds an expired one; the token_version check below (bumped by the claim)
 * is what stops a token from being used twice. The caller must be signed in
 * with an ATTESTED master id (OIDC / ticket / resume session).
 *
 * WHAT IS A GUEST ROW (decision D2, 2026-10-09). All of:
 *   - users.username is the old guest flow's `GuestNNNN` (poker-3d
 *     LoginScreen generated `Guest${1000..9999}`); the display name may have
 *     been changed, the username never is;
 *   - users.stats carries NO master identity stamp (masterUserId /
 *     masterUsername / masterPhone);
 *   - users.created_at is BEFORE GUEST_CLAIM_CUTOFF_ISO (2026-10-09T16:00Z —
 *     guest play went off at ~16:45Z that day). A row created later — e.g.
 *     by `register` under the ONLINE_GUEST_PLAY_ENABLED=1 rollback, which
 *     hands every new row a 50,000-chip starting bankroll — is NEVER
 *     claimable, so the carry-over can never launder fresh bankrolls into an
 *     account. A missing / unreadable created_at is not claimable either.
 *     (Read-only prod check 2026-10-09: all 207 GuestNNNN rows have a
 *     non-null created_at, the latest 2026-10-08T20:39Z.);
 *   - not already claimed (stats.claimedBy), not banned, not the caller's row.
 * And the guest token must be FOR THAT ROW: its `username` claim must equal
 * the row's username (as well as its userId naming the row and its
 * tokenVersion equalling the row's).
 * The username rule is defence in depth: on prod (read-only survey
 * 2026-10-09, 576 rows) every unstamped row is a GuestNNNN row except ONE
 * phone-keyed account row. Without it, an ACCOUNT row that merely lacks the
 * stamp (ticket rows on prod often do — users.stats is TEXT) and whose legacy
 * token was left on a shared device could be "carried over" into whoever
 * signs in there next.
 *
 * What moves (everything inside ONE transaction, guest row locked first):
 *   - chips  — debited from the guest with authManager.deductChips and
 *              credited to the caller with authManager.addChipsToUser, the
 *              SAME atomic additive statements every other chip path uses,
 *              run on the transaction's client. The amount is the LOCKED
 *              guest row's own balance — never a client value. Chip-conserving.
 *   - stars  — the same, additive both ways.
 *   - level/xp — GREATEST ratchet: the caller keeps the higher level; on a tie
 *              the higher xp. Never lowers the caller.
 *   - achievements — union.
 * What does NOT move: hand counters (handsPlayed/handsWon — summing them can
 * newly cross achievement thresholds and mint those rewards), inventory,
 * battle pass, career, hand history — none is "trivially safe".
 *
 * LEVEL REWARDS ARE NOT RE-PAID (D2). Level-gated lifetime achievements
 * (lvl_25 … lvl_1000) pay chips + stars the first time checkAchievements
 * sees the level. When the ratchet RAISES the caller's level, every such
 * achievement the raise newly unlocks is written into the caller's
 * achievements as ALREADY EARNED, in the same transaction: the guest earned
 * it on the way to that level and its reward is already in the wallet that
 * just moved. (On prod the guest's achievements column can lack the id even
 * though the reward was paid — the end-of-hand save fails on the TEXT stats
 * column — so unioning the guest's ids alone is not enough.)
 *
 * The guest row is RETIRED, not deleted: stats.claimedBy / claimedAt plus the
 * moved amounts (reversal record), and token_version + 1 so the guest token
 * (and any session derived from it) stops working. One claim per row: the
 * claimedBy check runs on the row LOCKED with SELECT … FOR UPDATE, so a
 * double tap's second transaction waits for the first and then sees it
 * claimed (already_claimed) — it can never double-credit.
 * ONE claim per caller ACCOUNT (S4, 2026-10-09): an account (its local row id
 * or its master id) that already received a carry-over gets
 * `already_claimed_by_account` for any other guest row — at peek (no offer)
 * and inside the claim transaction with the caller row LOCKED (two guest
 * tokens claimed into one account at once serialize on that lock, and the
 * second reads the first's committed retired row). Several pre-cutoff guest
 * bankrolls can never be consolidated into one account.
 */

import { parseStatsColumn } from './loginIdentity';

export type GuestClaimFailureCode =
  | 'not_signed_in'
  | 'invalid_guest_token'
  | 'not_a_guest'
  | 'already_claimed'
  | 'same_account'
  /**
   * 2026-10-09 (S4) — ONE carry-over per caller ACCOUNT: the caller (his
   * local row, or his master id) has already received a guest carry-over,
   * so a second guest row cannot be consolidated into the same account.
   */
  | 'already_claimed_by_account';

/** Short texts for the `error` field. The client keys on `code`. */
export const GUEST_CLAIM_MESSAGES: Record<GuestClaimFailureCode, string> = {
  not_signed_in: 'Sign in with your American Pub Poker account first.',
  invalid_guest_token: "We couldn't verify the guest account on this device.",
  not_a_guest: 'That account is not a guest account.',
  already_claimed: 'That guest account has already been carried over.',
  same_account: "That guest account is the one you're signed in with.",
  already_claimed_by_account: 'Your account has already received a guest carry-over — only one guest account can be brought over per account.',
};

/**
 * 2026-10-09 (S4) — was this (retired) guest row carried over into the
 * caller's ACCOUNT — his local row id or his master id? Reads the reversal
 * record the claim writes (stats.claimedBy / claimedByMasterUserId, top level
 * only: the client can write nothing but stats.clientData).
 */
export function guestRowClaimedByCaller(rawStats: unknown, callerLocalId: number, callerMasterId: string): boolean {
  const stats = parseStatsColumn(rawStats);
  if (stats.claimedBy == null) return false;
  if (Number(stats.claimedBy) === callerLocalId) return true;
  const byMaster = stats.claimedByMasterUserId == null ? '' : String(stats.claimedByMasterUserId).trim();
  return !!byMaster && !!callerMasterId && byMaster === callerMasterId;
}

/** The old guest flow's local username (poker-3d LoginScreen: `Guest${1000..9999}`). Tested on the TRIMMED username. */
export const GUEST_USERNAME_PATTERN = /^Guest\d+$/i;

/**
 * Only rows created BEFORE this instant are claimable (D2). Guest play went
 * off on prod at ~2026-10-09T16:45Z; anything created after the cutoff (the
 * guest-play rollback flag, a non-prod environment) is not a real
 * pre-shutoff guest.
 */
export const GUEST_CLAIM_CUTOFF_ISO = '2026-10-09T16:00:00Z';
const GUEST_CLAIM_CUTOFF_MS = Date.parse(GUEST_CLAIM_CUTOFF_ISO);

/** users.created_at (Date from pg, or an ISO string) → ms, or null when unreadable. */
function createdAtMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

/** Any of these on users.stats means the row is linked to a master identity. */
export const MASTER_STAMP_KEYS = ['masterUserId', 'masterUsername', 'masterPhone'] as const;

/** The slice of a users row the claim reads. stats/achievements are TEXT on prod. */
export interface ClaimUserRow {
  id: number;
  username?: string | null;
  display_name?: string | null;
  chips: number | null;
  stars: number | null;
  level: number | null;
  xp: number | null;
  achievements: unknown;
  stats: unknown;
  banned: boolean | null;
  token_version: number | null;
  /** users.created_at (TIMESTAMPTZ). Must be before GUEST_CLAIM_CUTOFF_ISO. */
  created_at?: Date | string | null;
}

export type GuestRowState = 'guest' | 'not_a_guest' | 'already_claimed';

/** Already claimed wins over everything else so a double tap reads as already_claimed. */
export function guestRowState(row: Pick<ClaimUserRow, 'stats' | 'username' | 'created_at'>): GuestRowState {
  const stats = parseStatsColumn(row.stats);
  if (stats.claimedBy != null) return 'already_claimed';
  if (!GUEST_USERNAME_PATTERN.test(String(row.username ?? '').trim())) return 'not_a_guest';
  for (const k of MASTER_STAMP_KEYS) {
    const v = stats[k];
    if (v != null && String(v).trim() !== '') return 'not_a_guest';
  }
  // D2: only a real PRE-SHUTOFF guest row. Unknown creation time = not claimable.
  const created = createdAtMs(row.created_at);
  if (created === null || created >= GUEST_CLAIM_CUTOFF_MS) return 'not_a_guest';
  return 'guest';
}

/**
 * Is this a row the carry-over could still claim (a pre-shutoff GuestNNNN row,
 * unstamped, unclaimed, not banned)? Used by the sign-out revocation (socket
 * `revokeSignInTokens`, and the compatibility-only `logout`) and the admin
 * kick, which must NOT bump such a row's token_version: its legacy token is the
 * device's only proof for the carry-over (a guest row never holds a resume
 * token anyway).
 */
export function isClaimableGuestRow(row: Pick<ClaimUserRow, 'stats' | 'username' | 'created_at'> & { banned?: boolean | null }): boolean {
  return !row.banned && guestRowState(row) === 'guest';
}

/** achievements column (TEXT JSON array on prod, or an array) → string[]. */
export function parseAchievements(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((a): a is string => typeof a === 'string' && a.length > 0);
}

const nonNegInt = (v: unknown, dflt = 0): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export interface GuestClaimPlan {
  chips: number;
  stars: number;
  guestLevel: number;
  guestXp: number;
  /** What the caller's level/xp become (the SQL applies the same ratchet). */
  levelAfter: number;
  xpAfter: number;
  achievementsAfter: string[];
  achievementsAdded: number;
  /** The ids the caller did not have before (guest's + level-unlocked), sorted. */
  achievementIdsAdded: string[];
  /** Level-gated achievements the ratchet newly unlocks, written as ALREADY EARNED (D2). */
  levelAchievementsMarkedEarned: string[];
  guestStatsAfter: Record<string, any>;
}

/**
 * Lifetime achievement ids that reaching `toLevel` unlocks which `fromLevel`
 * did not (ProgressionManager.lifetimeAchievementsUnlockedByLevel). Injected
 * so this module stays free of the progression engine.
 */
export type LevelUnlockFn = (fromLevel: number, toLevel: number) => string[];

/** Pure: what a claim of `guest` into `caller` moves. Both rows must be the LOCKED reads. */
export function planGuestClaim(
  guest: ClaimUserRow,
  caller: ClaimUserRow,
  ctx: { callerLocalId: number; callerMasterId: string; nowIso: string; levelUnlocks?: LevelUnlockFn; maxXpAtLevel?: (level: number) => number },
): GuestClaimPlan {
  const chips = nonNegInt(guest.chips);
  const stars = nonNegInt(guest.stars);
  const guestLevel = Math.max(1, nonNegInt(guest.level, 1));
  // Clamped to what a player can legitimately hold AT his level: an inflated
  // xp (e.g. written by the pre-2026-10-09 client saveProgress hole) would
  // otherwise walk the caller's next addXP through the paying level-up loop.
  const rawGuestXp = nonNegInt(guest.xp);
  const guestXp = ctx.maxXpAtLevel ? Math.min(rawGuestXp, Math.max(0, Math.floor(ctx.maxXpAtLevel(guestLevel)) || 0)) : rawGuestXp;
  const callerLevel = Math.max(1, nonNegInt(caller.level, 1));
  const callerXp = nonNegInt(caller.xp);
  const levelAfter = Math.max(callerLevel, guestLevel);
  const xpAfter = guestLevel > callerLevel ? guestXp : guestLevel === callerLevel ? Math.max(callerXp, guestXp) : callerXp;
  const callerAch = parseAchievements(caller.achievements);
  const guestAch = parseAchievements(guest.achievements);
  // D2: the level achievements the ratchet newly unlocks for the caller are
  // marked EARNED (their reward is already in the guest wallet that moves).
  // Thresholds the caller had already reached on his own are left alone.
  const levelAchievementsMarkedEarned = levelAfter > callerLevel && ctx.levelUnlocks
    ? Array.from(new Set(ctx.levelUnlocks(callerLevel, levelAfter).filter((a) => typeof a === 'string' && a.length > 0))).sort()
    : [];
  const achievementsAfter = Array.from(new Set([...callerAch, ...guestAch, ...levelAchievementsMarkedEarned])).sort();
  const callerSet = new Set(callerAch);
  const achievementIdsAdded = achievementsAfter.filter((a) => !callerSet.has(a));
  const achievementsAdded = achievementIdsAdded.length;
  const guestStatsAfter = {
    ...parseStatsColumn(guest.stats),
    claimedBy: ctx.callerLocalId,
    claimedAt: ctx.nowIso,
    claimedByMasterUserId: ctx.callerMasterId,
    // Reversal record: exactly what left this row.
    claimedChips: chips,
    claimedStars: stars,
    claimedLevel: guestLevel,
    claimedXp: guestXp,
    claimedAchievements: guestAch,
  };
  return {
    chips, stars, guestLevel, guestXp, levelAfter, xpAfter, achievementsAfter, achievementsAdded,
    achievementIdsAdded, levelAchievementsMarkedEarned, guestStatsAfter,
  };
}

/** Writes inside one transaction. */
export interface GuestClaimTx {
  /** SELECT … FOR UPDATE. */
  lockUser(id: number): Promise<ClaimUserRow | null>;
  /** Debit the guest's chips + stars (additive), bump token_version, write the retired stats. */
  retireGuest(guestId: number, p: { chips: number; stars: number; statsJson: string }): Promise<void>;
  /** Credit the caller's chips + stars (additive) + level/xp ratchet + achievements. Returns the row after. */
  creditCaller(callerId: number, p: {
    chips: number; stars: number; guestLevel: number; guestXp: number; achievementsJson: string;
  }): Promise<{ chips: number; stars: number; level: number; xp: number }>;
  /**
   * S4 — the id of a guest row ALREADY carried over into this caller account
   * (guestRowClaimedByCaller), or null. Run AFTER the caller row is locked, so
   * a concurrent claim of another guest into the same account has committed
   * (or rolled back) before this reads.
   */
  findGuestClaimedBy(callerLocalId: number, callerMasterId: string): Promise<number | null>;
}

export interface GuestClaimDb {
  /** Plain read (peek). */
  readUser(id: number): Promise<ClaimUserRow | null>;
  /** S4 — plain-read twin of GuestClaimTx.findGuestClaimedBy (peek). */
  findGuestClaimedBy(callerLocalId: number, callerMasterId: string): Promise<number | null>;
  /** BEGIN … COMMIT; ROLLBACK (and rethrow) if `fn` throws. */
  transaction<T>(fn: (tx: GuestClaimTx) => Promise<T>): Promise<T>;
}

/**
 * Verified guest-token claims (authManager.verifyLegacyTokenClaims shape).
 * `username` is the token's username claim (null when it has none — such a
 * token is refused: it must name the row it is for).
 */
export type GuestTokenCheck =
  | { ok: true; userId: number; tokenVersion: number; username: string | null }
  | { ok: false; reason?: string };

export interface GuestClaimDeps {
  db: GuestClaimDb;
  verifyGuestToken: (token: unknown) => GuestTokenCheck;
  now?: () => number;
  /** D2 level-reward guard; omitted = no level achievements are marked (tests of other rules). */
  levelUnlocks?: LevelUnlockFn;
  /** D2 xp clamp (ProgressionManager.maxXpAtLevel); omitted = no clamp. */
  maxXpAtLevel?: (level: number) => number;
}

export interface GuestClaimInput {
  /** The caller's LOCAL users.id (authSessions). */
  callerLocalId: number | null | undefined;
  /** The caller's ATTESTED master id (authSessions.masterUserId) — required. */
  callerMasterId: string | null | undefined;
  guestToken: unknown;
}

export type GuestClaimFailure = { success: false; code: GuestClaimFailureCode; error: string; guestUserId?: number };

export interface GuestClaimSuccess {
  success: true;
  guestUserId: number;
  chipsAdded: number;
  starsAdded: number;
  levelAfter: number;
  xpAfter: number;
  achievementsAdded: number;
  /** SERVER-ONLY (not in the client frame — see claimResultFrame): the ids added to the caller. */
  achievementIdsAdded: string[];
  /** SERVER-ONLY: level achievements written as already earned (D2). */
  levelAchievementsMarkedEarned: string[];
}

export type GuestClaimResult = GuestClaimSuccess | GuestClaimFailure;

/**
 * The `claimGuestProgressResult` frame (contract C5 R2): exactly the contract
 * fields, never the server-only bookkeeping.
 */
export function claimResultFrame(r: GuestClaimResult): Record<string, unknown> {
  if (!r.success) return { ...r };
  return {
    success: true, guestUserId: r.guestUserId, chipsAdded: r.chipsAdded, starsAdded: r.starsAdded,
    levelAfter: r.levelAfter, xpAfter: r.xpAfter, achievementsAdded: r.achievementsAdded,
  };
}

export type GuestPeekResult =
  | {
    success: true;
    guestUserId: number;
    chips: number;
    stars: number;
    level: number;
    xp: number;
    achievementsCount: number;
    displayName: string | null;
  }
  | GuestClaimFailure;

const fail = (code: GuestClaimFailureCode, guestUserId?: number): GuestClaimFailure => ({
  success: false, code, error: GUEST_CLAIM_MESSAGES[code], ...(guestUserId ? { guestUserId } : {}),
});

/** Shared pre-DB checks for claim + peek. */
function precheck(deps: GuestClaimDeps, input: GuestClaimInput):
  | { ok: true; callerLocalId: number; callerMasterId: string; guestUserId: number; tokenVersion: number; tokenUsername: string | null }
  | { ok: false; failure: GuestClaimFailure } {
  const callerLocalId = Number(input.callerLocalId);
  const callerMasterId = input.callerMasterId == null ? '' : String(input.callerMasterId).trim();
  if (!Number.isInteger(callerLocalId) || callerLocalId <= 0 || !callerMasterId) {
    return { ok: false, failure: fail('not_signed_in') };
  }
  const v = deps.verifyGuestToken(input.guestToken);
  if (!v.ok) return { ok: false, failure: fail('invalid_guest_token') };
  if (v.userId === callerLocalId) return { ok: false, failure: fail('same_account', v.userId) };
  return {
    ok: true, callerLocalId, callerMasterId, guestUserId: v.userId, tokenVersion: v.tokenVersion,
    tokenUsername: v.username == null ? null : String(v.username),
  };
}

/** The guest-row checks, on a LOCKED (claim) or plain (peek) read. */
function guestRowFailure(
  guest: ClaimUserRow | null, tokenVersion: number, guestUserId: number, tokenUsername: string | null,
): GuestClaimFailure | null {
  if (!guest) return fail('invalid_guest_token', guestUserId);
  // D2: the token must be FOR this row — its username claim equals the row's
  // username. Checked before anything about the row's state is disclosed.
  if (tokenUsername == null || tokenUsername !== String(guest.username ?? '')) return fail('invalid_guest_token', guestUserId);
  const state = guestRowState(guest);
  if (state === 'already_claimed') return fail('already_claimed', guestUserId);
  if (state === 'not_a_guest') return fail('not_a_guest', guestUserId);
  // The token must carry the row's CURRENT token_version (contract R2: "must
  // still match"). A token minted before a bump (ban, admin logout) is dead;
  // getUserFromToken's login rule is `<`, but a signed token can never carry
  // a HIGHER version than its row legitimately, so equality is the honest test.
  if (tokenVersion !== (guest.token_version == null ? 0 : Number(guest.token_version))) return fail('invalid_guest_token', guestUserId);
  if (guest.banned) return fail('invalid_guest_token', guestUserId);
  return null;
}

export async function peekGuestProgress(deps: GuestClaimDeps, input: GuestClaimInput): Promise<GuestPeekResult> {
  const pre = precheck(deps, input);
  if (!pre.ok) return pre.failure;
  const guest = await deps.db.readUser(pre.guestUserId);
  const bad = guestRowFailure(guest, pre.tokenVersion, pre.guestUserId, pre.tokenUsername);
  if (bad) return bad;
  // S4: one carry-over per caller account — never offer a second one.
  if ((await deps.db.findGuestClaimedBy(pre.callerLocalId, pre.callerMasterId)) != null) {
    return fail('already_claimed_by_account', pre.guestUserId);
  }
  const g = guest as ClaimUserRow;
  return {
    success: true,
    guestUserId: g.id,
    chips: nonNegInt(g.chips),
    stars: nonNegInt(g.stars),
    level: Math.max(1, nonNegInt(g.level, 1)),
    xp: nonNegInt(g.xp),
    achievementsCount: parseAchievements(g.achievements).length,
    displayName: (g.display_name && String(g.display_name)) || (g.username && String(g.username)) || null,
  };
}

export async function claimGuestProgress(deps: GuestClaimDeps, input: GuestClaimInput): Promise<GuestClaimResult> {
  const pre = precheck(deps, input);
  if (!pre.ok) return pre.failure;
  const now = deps.now || Date.now;
  return deps.db.transaction(async (tx): Promise<GuestClaimResult> => {
    // Lock order is ALWAYS guest then caller.
    const guest = await tx.lockUser(pre.guestUserId);
    const bad = guestRowFailure(guest, pre.tokenVersion, pre.guestUserId, pre.tokenUsername);
    if (bad) return bad;
    const caller = await tx.lockUser(pre.callerLocalId);
    if (!caller || caller.banned) return fail('not_signed_in');
    // S4: ONE carry-over per caller account. Checked with the caller row
    // LOCKED: two different guest tokens claimed into the same account at once
    // serialize on this lock, and the second one reads the first's committed
    // retired row here — so several pre-cutoff guest bankrolls can never be
    // consolidated into one account.
    if ((await tx.findGuestClaimedBy(pre.callerLocalId, pre.callerMasterId)) != null) {
      return fail('already_claimed_by_account', pre.guestUserId);
    }
    const plan = planGuestClaim(guest as ClaimUserRow, caller, {
      callerLocalId: pre.callerLocalId,
      callerMasterId: pre.callerMasterId,
      nowIso: new Date(now()).toISOString(),
      levelUnlocks: deps.levelUnlocks,
      maxXpAtLevel: deps.maxXpAtLevel,
    });
    await tx.retireGuest(pre.guestUserId, { chips: plan.chips, stars: plan.stars, statsJson: JSON.stringify(plan.guestStatsAfter) });
    const after = await tx.creditCaller(pre.callerLocalId, {
      chips: plan.chips,
      stars: plan.stars,
      guestLevel: plan.guestLevel,
      guestXp: plan.guestXp,
      achievementsJson: JSON.stringify(plan.achievementsAfter),
    });
    return {
      success: true,
      guestUserId: pre.guestUserId,
      chipsAdded: plan.chips,
      starsAdded: plan.stars,
      levelAfter: Number(after.level),
      xpAfter: Number(after.xp),
      achievementsAdded: plan.achievementsAdded,
      achievementIdsAdded: plan.achievementIdsAdded,
      levelAchievementsMarkedEarned: plan.levelAchievementsMarkedEarned,
    };
  });
}

// ── Postgres implementation ────────────────────────────────────────────────

/** The pg Pool / PoolClient surface used here (keeps tests free of a real DB). */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(): void }>;
}

/**
 * authManager's chip paths (deductChips / addChipsToUser), passed in so this
 * module needs no DB pool of its own and the claim moves chips through the
 * SAME atomic statements as every other chip write — just on the
 * transaction's client. Each returns false on failure (never throws).
 */
export interface GuestClaimChipPaths {
  deductChips(userId: number, amount: number, db: PgQueryable): Promise<boolean>;
  addChipsToUser(userId: number, chips: number, db: PgQueryable): Promise<boolean>;
}

const USER_COLUMNS = 'id, username, display_name, chips, stars, level, xp, achievements, stats, banned, token_version, created_at';

/**
 * S4 — candidate retired rows: a plain substring filter on the stats TEXT (no
 * jsonb operator — prod's column is TEXT; `::text` is a no-op there and also
 * works on jsonb), then the exact top-level match in JS
 * (guestRowClaimedByCaller). Every claimable row is a GuestNNNN row and the
 * claim never renames it, so the scan is a few hundred rows at most.
 */
const CLAIMED_BY_CANDIDATES_SQL = `SELECT id, stats FROM users WHERE stats::text LIKE '%claimedBy%'`;

async function findGuestClaimedByOn(db: PgQueryable, callerLocalId: number, callerMasterId: string): Promise<number | null> {
  const { rows } = await db.query(CLAIMED_BY_CANDIDATES_SQL);
  for (const r of rows) {
    if (Number(r.id) !== callerLocalId && guestRowClaimedByCaller(r.stats, callerLocalId, callerMasterId)) return Number(r.id);
  }
  return null;
}

/**
 * users.stats / users.achievements are TEXT on prod (/api/health
 * identityGuard.statsColumnType; information_schema confirmed 2026-10-09) —
 * so they are read and written as JSON TEXT under the row lock, never with
 * jsonb operators (which fail on TEXT).
 */
export function createPgGuestClaimDb(pool: PgPoolLike, chipPaths: GuestClaimChipPaths): GuestClaimDb {
  return {
    async readUser(id: number) {
      const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
      return rows[0] || null;
    },
    findGuestClaimedBy(callerLocalId: number, callerMasterId: string) {
      return findGuestClaimedByOn(pool, callerLocalId, callerMasterId);
    },
    async transaction<T>(fn: (tx: GuestClaimTx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: GuestClaimTx = {
          async lockUser(id: number) {
            const { rows } = await client.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
            return rows[0] || null;
          },
          findGuestClaimedBy(callerLocalId: number, callerMasterId: string) {
            // On the transaction's client, after the caller row is locked.
            return findGuestClaimedByOn(client, callerLocalId, callerMasterId);
          },
          async retireGuest(guestId, p) {
            // chips: authManager.deductChips (`chips = chips - $1 … AND chips >= $1`)
            // on the LOCKED balance, so it cannot fail for a short wallet.
            if (p.chips > 0 && !(await chipPaths.deductChips(guestId, p.chips, client))) {
              throw new Error('guest chip debit failed');
            }
            const r = await client.query(
              `UPDATE users
                  SET stars = COALESCE(stars, 0) - $1::int,
                      token_version = COALESCE(token_version, 0) + 1,
                      stats = $2
                WHERE id = $3`,
              [p.stars, p.statsJson, guestId],
            );
            if ((r.rowCount ?? 0) !== 1) throw new Error('guest row vanished mid-claim');
          },
          async creditCaller(callerId, p) {
            // chips: authManager.addChipsToUser (`chips = chips + $1`).
            if (p.chips > 0 && !(await chipPaths.addChipsToUser(callerId, p.chips, client))) {
              throw new Error('caller chip credit failed');
            }
            // In an UPDATE every SET expression sees the OLD row, so `level`
            // inside the xp CASE is the caller's level before the ratchet.
            const r = await client.query(
              `UPDATE users
                  SET stars = COALESCE(stars, 0) + $1::int,
                      level = GREATEST(COALESCE(level, 1), $2::int),
                      xp = CASE
                             WHEN $2::int > COALESCE(level, 1) THEN $3::int
                             WHEN $2::int = COALESCE(level, 1) THEN GREATEST(COALESCE(xp, 0), $3::int)
                             ELSE xp
                           END,
                      achievements = $4
                WHERE id = $5
              RETURNING chips, stars, level, xp`,
              [p.stars, p.guestLevel, p.guestXp, p.achievementsJson, callerId],
            );
            if (!r.rows[0]) throw new Error('caller row vanished mid-claim');
            return r.rows[0];
          },
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * What other players may see of an account (2026-10-11, .online R1 — ECON-3 /
 * AUTH-7 / APPUI-1, P0 PII).
 *
 * `users.username` is a LOGIN handle: for many rows it is the owner's phone
 * number (12 in the leaderboard's top 50, the admin seed row at #1) or a
 * first.last slug. It was sent to every client by the leaderboard, player
 * search, staking offers, tournament standings, profiles, friend events and
 * club views. It is never sent to another player any more; they see the
 * DISPLAY NAME — and only one that passes the display-name whitelist
 * (authManager.setDisplayName: 2-20 chars of [A-Za-z0-9 _.'-] with a letter
 * or digit) and does not look like a phone number. Anything else is shown as
 * 'Player' (the same fallback contract #3 uses for seat names).
 */
export const PUBLIC_NAME_FALLBACK = 'Player';

const DISPLAY_NAME_RE = /^[A-Za-z0-9 _.'-]+$/;

/** Seven or more digits anywhere — a phone number (or a fragment of one), never a name to show. */
export function isPhoneLike(value: string): boolean {
  return (value.match(/\d/g) || []).length >= 7;
}

/** The name other players may see for a `users.display_name` value (else 'Player'). */
export function publicDisplayName(displayName: unknown): string {
  if (typeof displayName !== 'string') return PUBLIC_NAME_FALLBACK;
  const t = displayName.trim();
  if (t.length < 2 || t.length > 20) return PUBLIC_NAME_FALLBACK;
  if (!DISPLAY_NAME_RE.test(t) || !/[A-Za-z0-9]/.test(t) || isPhoneLike(t)) return PUBLIC_NAME_FALLBACK;
  return t;
}

/** True when `displayName` is shown as itself (not replaced by the fallback). */
export function isPublicDisplayName(displayName: unknown): displayName is string {
  return typeof displayName === 'string' && publicDisplayName(displayName) === displayName.trim() && displayName.trim() !== PUBLIC_NAME_FALLBACK;
}

/**
 * A free-text name or seat label already shown somewhere (a tournament
 * registration name, a seat name): shown as itself only when it passes the
 * same rules, else 'Player'. Bots' names always pass.
 */
export function publicNameOf(value: unknown): string {
  return publicDisplayName(value);
}

/** Escape LIKE wildcards so a search for "%" or "_" matches those characters, not everything. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQL predicate (no parameters) for rows another player may be shown: not
 * banned, not an admin, not an account-merge tombstone, not a retired
 * (carried-over) guest row. TEXT-safe on users.stats (it is TEXT in prod).
 */
export const LISTABLE_USER_SQL =
  `COALESCE(banned, FALSE) = FALSE AND COALESCE(is_admin, FALSE) = FALSE`
  + ` AND position('"mergedInto"' in COALESCE(stats::text, '')) = 0`
  + ` AND position('"claimedBy"' in COALESCE(stats::text, '')) = 0`;

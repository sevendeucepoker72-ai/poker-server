/**
 * 2026-10-11 — the ONE rule for a player name that OTHER players see (R1
 * contract #3; audit AUTH-6, APPUI-13, TOURNEY-12, AUTH-1).
 *
 * Same whitelist as authManager.setDisplayName (CLAUDE.md: "Display-name /
 * username input has a strict ASCII whitelist"): plain ASCII letters, digits,
 * space and _ . ' -, 2-20 characters, at least one letter or digit. On top of
 * it, a value with NO letter and 7+ digits is refused: it is a phone number
 * (legacy rows were keyed and sometimes named by the player's phone), never a
 * name to put on a seat.
 *
 * `users.username` is NOT a display value: it is a phone number, a master slug,
 * a legacy display name or (since 2026-10-11, AUTH-1) the collision-proof key
 * `m:<master id>`. What players see is `users.display_name`, through this rule.
 */

export const DISPLAY_NAME_FALLBACK = 'Player';
/** = authManager DISPLAY_NAME_RE (setDisplayName). Keep the two in step. */
export const DISPLAY_NAME_RE = /^[A-Za-z0-9 _.'-]+$/;
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 20;

// Merge of R1 lanes (2026-10-11): the SAME phone rule as
// social/publicIdentity.isPhoneLike (7+ digits anywhere, letters or not), so a
// seat name and a leaderboard/profile name never disagree about one account.
function looksLikePhone(v: string): boolean {
  return (v.match(/\d/g) || []).length >= 7;
}

/** True when `v` may be shown to other players as-is. */
export function isWhitelistDisplayName(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (v !== v.trim()) return false;
  if (v.length < DISPLAY_NAME_MIN || v.length > DISPLAY_NAME_MAX) return false;
  if (!DISPLAY_NAME_RE.test(v)) return false;
  if (!/[A-Za-z0-9]/.test(v)) return false;
  return !looksLikePhone(v);
}

/**
 * The whitelist-valid form of a raw name, or null. Whitespace is collapsed; a
 * "First Last" that is too long, or whose surname is not plain ASCII, becomes
 * "First L." when THAT passes (the Play Online ticket path's own convention).
 * Never invents a name from anything but `raw`.
 */
export function toWhitelistDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (isWhitelistDisplayName(t)) return t;
  const words = t.split(' ').filter(Boolean);
  if (words.length >= 2) {
    const short = `${words[0]} ${words[words.length - 1].charAt(0)}.`;
    if (isWhitelistDisplayName(short)) return short;
  }
  return null;
}

/** A name to show for an account: its whitelist-valid display name, else 'Player'. */
export function accountDisplayName(raw: unknown): string {
  return toWhitelistDisplayName(raw) ?? DISPLAY_NAME_FALLBACK;
}

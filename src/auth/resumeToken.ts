/**
 * 2026-10-09 — R1: the .online RESUME TOKEN (shared contract with poker-3d;
 * CONTRACTS.md C5 "Resumable ticket sessions").
 *
 * THE PROBLEM. A player who arrives through the player app's "Play Online"
 * button is signed in by `authWithTicket` with a ONE-SHOT ticket (the master
 * verifies it, poker-server's replay guard burns it). Socket.IO hands every
 * reconnect (phone unlock, PWA resume, Railway blip) a NEW socket with no
 * authSessions entry, and the ticket cannot be replayed — so after any
 * reconnect the client had nothing to re-authenticate with and the player was
 * told to sign in, mid-session.
 *
 * THE FIX. A successful ticket login (and the waitlist deep link's auth
 * bootstrap) also returns a short-lived, server-signed credential naming the
 * session it resumes. On reconnect the client emits `resumeSession
 * {resumeToken}` and is signed back in silently, exactly as the ticket did.
 *
 * WHO GETS ONE (decision D1, 2026-10-09). ONLY 'Play Online' ticket sessions
 * (authWithTicket) and the waitlist bootstrap. NOT oauthLogin / tokenLogin —
 * an OIDC session re-authenticates with its own refresh flow — and NEVER an
 * is_admin row (a copied resume token must never be an admin credential).
 *
 * Token: an HS256 JWT signed with a key DERIVED from JWT_SECRET for this one
 * purpose (authManager.getScopedSigningKey(RESUME_KEY_SCOPE)), so it can never
 * verify as a legacy login token and a legacy token can never verify as one.
 * Claims: { kind:'online_resume', localUserId, masterUserId, token_version,
 * orig_iat, phone?, iat, exp = min(iat + 12h, orig_iat + 24h) }.
 *   - exp is SLIDING: every successful resume answers with a fresh token
 *     (exp = now + 12h), but NEVER past orig_iat + 24h (S4) — so
 *     resumeExpiresAt never promises more than the absolute cap allows.
 *   - orig_iat is the time of the ORIGINAL ticket login, carried UNCHANGED
 *     through every resume. A resume is refused (resume_invalid) once
 *     now - orig_iat > 24h — the ABSOLUTE cap: a token chain can never keep a
 *     session alive past one day after the ticket that started it.
 *   - phone is the `phone` the original session carried (authWithTicket's
 *     master phone-or-slug; absent for the waitlist bootstrap, which sets
 *     none), so a resumed session is the same session.
 *
 * Revocation: bumping users.token_version kills every outstanding resume token
 * for that row (the token's token_version must EQUAL the row's). Bumped by:
 * ban, the explicit sign-out — socket `revokeSignInTokens` (T2; the old
 * `logout` does the same and is kept for compatibility only, no client emits
 * it) — which only bumps and acks (the disconnect handler still owns the seat
 * teardown), adminKickPlayer, and the guest carry-over retiring a row.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { parseStatsColumn } from './loginIdentity';

export const RESUME_TOKEN_KIND = 'online_resume';
/** Key-derivation scope. Changing it invalidates every outstanding resume token. */
export const RESUME_KEY_SCOPE = 'poker-server/online_resume/v1';
/** Sliding lifetime of ONE token (each resume issues a fresh one). */
export const RESUME_TOKEN_TTL_SECONDS = 12 * 60 * 60;
/** Absolute cap: no resume once now - orig_iat exceeds this (D1). */
export const RESUME_ABSOLUTE_MAX_SECONDS = 24 * 60 * 60;
/** Tolerated clock skew for an orig_iat "in the future". */
const CLOCK_SKEW_SECONDS = 60;
/** Shown for code 'resume_invalid' — the client falls back to its sign-in path. */
export const RESUME_INVALID_MESSAGE = 'Your session has ended — please sign in again.';

/** HMAC-SHA256(secret, scope) — same derivation as authManager.getScopedSigningKey (tests use it directly). */
export function deriveScopedKey(secret: string, scope: string = RESUME_KEY_SCOPE): string {
  return crypto.createHmac('sha256', secret).update(scope).digest('hex');
}

export interface ResumeSubject {
  localUserId: number;
  masterUserId: string;
  /** users.token_version of the local row at issue time (NULL in the DB = 0). */
  tokenVersion: number | null | undefined;
  /**
   * Unix SECONDS of the ORIGINAL ticket login. Omitted = this is that login
   * (orig_iat = iat). A resume passes the presented token's orig_iat through.
   */
  origIat?: number;
  /** The original session's `phone` (authSessions), if it had one. */
  phone?: string | null;
}

export interface ResumeClaims {
  kind: typeof RESUME_TOKEN_KIND;
  localUserId: number;
  masterUserId: string;
  token_version: number;
  /** Unix seconds of the original ticket login — never changes across resumes. */
  orig_iat: number;
  /** The original session's phone; absent when it had none. */
  phone?: string;
  iat: number;
  exp: number;
}

export interface IssuedResumeToken {
  resumeToken: string;
  /** ISO timestamp of `exp`. */
  resumeExpiresAt: string;
}

const cleanPhone = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s && s.length <= 128 ? s : undefined;
};

/**
 * Mint a resume token, or null when the subject is not resumable (no master
 * id — a ticket/waitlist session always has one — a bad local id, or an
 * orig_iat already past the absolute cap: such a token could never resume).
 */
export function issueResumeToken(key: string, subject: ResumeSubject, nowMs: number = Date.now()): IssuedResumeToken | null {
  const localUserId = Number(subject.localUserId);
  const masterUserId = subject.masterUserId == null ? '' : String(subject.masterUserId).trim();
  const tokenVersion = subject.tokenVersion == null ? 0 : Number(subject.tokenVersion);
  if (!key || !Number.isInteger(localUserId) || localUserId <= 0) return null;
  if (!masterUserId || masterUserId.length > 128) return null;
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) return null;
  const iat = Math.floor(nowMs / 1000);
  const origIat = subject.origIat == null ? iat : Number(subject.origIat);
  if (!Number.isInteger(origIat) || origIat <= 0 || origIat > iat + CLOCK_SKEW_SECONDS) return null;
  const origIatClaim = Math.min(origIat, iat);
  // 2026-10-09 (S4) — exp (and so resumeExpiresAt) NEVER exceeds the chain's
  // absolute cap: the 12h sliding exp is clamped to orig_iat + 24h, so the
  // frame never promises a validity the server will not honour. A chain at
  // (or past) its cap gets no token at all — it could never be used.
  const exp = Math.min(iat + RESUME_TOKEN_TTL_SECONDS, origIatClaim + RESUME_ABSOLUTE_MAX_SECONDS);
  if (exp <= iat) return null;
  const phone = cleanPhone(subject.phone);
  const claims: ResumeClaims = {
    kind: RESUME_TOKEN_KIND, localUserId, masterUserId, token_version: tokenVersion,
    orig_iat: origIatClaim, ...(phone ? { phone } : {}), iat, exp,
  };
  const resumeToken = jwt.sign(claims, key, { algorithm: 'HS256' });
  return { resumeToken, resumeExpiresAt: new Date(exp * 1000).toISOString() };
}

export type ResumeTokenFailure =
  | 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'wrong_kind' | 'bad_claims'
  /** now - orig_iat > RESUME_ABSOLUTE_MAX_SECONDS (D1 absolute cap). */
  | 'session_too_old';

export type ResumeTokenCheck =
  | { ok: true; claims: ResumeClaims }
  | { ok: false; reason: ResumeTokenFailure };

/** Signature + expiry + absolute cap + shape. Row checks (revocation) are checkResumeRow's job. */
export function verifyResumeToken(key: string, token: unknown, nowMs: number = Date.now()): ResumeTokenCheck {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  if (token.length > 2048 || !key) return { ok: false, reason: 'malformed' };
  const nowSec = Math.floor(nowMs / 1000);
  let decoded: any;
  try {
    decoded = jwt.verify(token, key, { algorithms: ['HS256'], clockTimestamp: nowSec });
  } catch (e: any) {
    if (e?.name === 'TokenExpiredError') return { ok: false, reason: 'expired' };
    if (/signature/i.test(String(e?.message || ''))) return { ok: false, reason: 'bad_signature' };
    return { ok: false, reason: 'malformed' };
  }
  if (!decoded || typeof decoded !== 'object') return { ok: false, reason: 'malformed' };
  if (decoded.kind !== RESUME_TOKEN_KIND) return { ok: false, reason: 'wrong_kind' };
  const localUserId = Number(decoded.localUserId);
  const masterUserId = typeof decoded.masterUserId === 'string' ? decoded.masterUserId.trim() : '';
  const tokenVersion = Number(decoded.token_version);
  const iat = Number(decoded.iat);
  const exp = Number(decoded.exp);
  const origIat = Number(decoded.orig_iat);
  if (!Number.isInteger(localUserId) || localUserId <= 0) return { ok: false, reason: 'bad_claims' };
  if (!masterUserId || masterUserId.length > 128) return { ok: false, reason: 'bad_claims' };
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) return { ok: false, reason: 'bad_claims' };
  if (!Number.isFinite(exp) || !Number.isInteger(iat)) return { ok: false, reason: 'bad_claims' };
  // orig_iat is REQUIRED (every token ever issued carries it) and can never be
  // later than the token's own iat or the present.
  if (!Number.isInteger(origIat) || origIat <= 0 || origIat > iat || origIat > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'bad_claims' };
  }
  if (nowSec - origIat > RESUME_ABSOLUTE_MAX_SECONDS) return { ok: false, reason: 'session_too_old' };
  const phone = cleanPhone(decoded.phone);
  if (decoded.phone != null && phone === undefined) return { ok: false, reason: 'bad_claims' };
  return {
    ok: true,
    claims: {
      kind: RESUME_TOKEN_KIND, localUserId, masterUserId, token_version: tokenVersion,
      orig_iat: origIat, ...(phone ? { phone } : {}), iat, exp,
    },
  };
}

/** The slice of a users row the revocation checks read. */
export interface ResumeRow {
  id: number;
  banned?: boolean | null;
  is_admin?: boolean | null;
  token_version?: number | null;
  /** users.stats — TEXT on prod (/api/health identityGuard.statsColumnType), parsed defensively. */
  stats?: unknown;
}

export type ResumeRowFailure =
  | 'user_missing' | 'banned' | 'admin_row' | 'token_version_mismatch' | 'row_retired' | 'master_link_changed';

/**
 * Is the local row still the session this token resumes?
 *  - gone / a different row          → user_missing
 *  - banned                          → banned
 *  - an is_admin row                 → admin_row (never resumable — D1. No
 *                                      token is issued to one; this refuses a
 *                                      row promoted after the token was issued)
 *  - token_version moved on          → token_version_mismatch (revoked)
 *  - retired by a guest carry-over   → row_retired
 *  - stamped with a DIFFERENT master → master_link_changed
 * A row with no master stamp is accepted: on prod most ticket rows carry
 * none (users.stats is TEXT and authWithTicket's stamp lookup cannot run
 * there), and the token itself is the server's attestation of the
 * localUserId↔masterUserId pair made by a verified ticket.
 */
export function checkResumeRow(claims: ResumeClaims, row: ResumeRow | null | undefined): ResumeRowFailure | null {
  if (!row || Number(row.id) !== claims.localUserId) return 'user_missing';
  if (row.banned) return 'banned';
  if (row.is_admin) return 'admin_row';
  const rowVersion = row.token_version == null ? 0 : Number(row.token_version);
  if (rowVersion !== claims.token_version) return 'token_version_mismatch';
  const stats = parseStatsColumn(row.stats);
  if (stats.claimedBy != null) return 'row_retired';
  // 2026-10-10 — a row the one-time account merge retired (auth/accountMerge.ts):
  // its person now signs in to the survivor; never resume onto the tombstone.
  if (stats.mergedInto != null) return 'row_retired';
  const stamped = stats.masterUserId == null ? '' : String(stats.masterUserId).trim();
  if (stamped && stamped !== claims.masterUserId) return 'master_link_changed';
  return null;
}

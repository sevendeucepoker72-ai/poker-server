/**
 * 2026-10-09 — R1: resumable .online ticket sessions (src/auth/resumeToken.ts,
 * wired as the `resumeSession` socket event in src/index.ts).
 *
 * Pins:
 *   - a valid token round-trips its claims (localUserId, masterUserId,
 *     token_version, kind:'online_resume', exp = iat + 12h);
 *   - expired / forged (other key, tampered payload, alg:none) / wrong-kind
 *     tokens are refused with a stable reason;
 *   - bumping users.token_version REVOKES every outstanding token;
 *     banned / retired / re-linked rows are refused too;
 *   - domain separation: a resume token is never a legacy login token and a
 *     legacy login token is never a resume token (both derive from JWT_SECRET).
 */

import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import {
  RESUME_TOKEN_KIND, RESUME_KEY_SCOPE, RESUME_TOKEN_TTL_SECONDS, RESUME_ABSOLUTE_MAX_SECONDS, RESUME_INVALID_MESSAGE,
  deriveScopedKey, issueResumeToken, verifyResumeToken, checkResumeRow,
  type ResumeClaims,
} from '../src/auth/resumeToken';
import { isClaimableGuestRow } from '../src/auth/guestClaim';

// authManager reads JWT_SECRET at import time — set it first, then require.
const TEST_JWT_SECRET = 'unit-test-jwt-secret-resume';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_JWT_SECRET;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authManager = require('../src/auth/authManager') as typeof import('../src/auth/authManager');
afterAll(() => {
  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
});

const KEY = deriveScopedKey(TEST_JWT_SECRET, RESUME_KEY_SCOPE);
const MASTER = 'df83fafd-e6ac-403d-8d26-9b01c2a1ee96';
const T0 = Date.UTC(2026, 9, 9, 18, 0, 0);

function issue(
  over: Partial<{ localUserId: number; masterUserId: string; tokenVersion: number | null; origIat: number; phone: string | null }> = {},
  now = T0,
) {
  const out = issueResumeToken(KEY, { localUserId: 512, masterUserId: MASTER, tokenVersion: 0, ...over }, now);
  if (!out) throw new Error('expected a token');
  return out;
}
const sec = (ms: number) => Math.floor(ms / 1000);
const HOUR_MS = 3600 * 1000;

function claimsOf(token: string, now = T0): ResumeClaims {
  const v = verifyResumeToken(KEY, token, now);
  if (!v.ok) throw new Error(`expected valid, got ${v.reason}`);
  return v.claims;
}

describe('resume token — issue + verify', () => {
  it('a valid token round-trips its claims; exp = iat + 12h; resumeExpiresAt is that exp as ISO', () => {
    const { resumeToken, resumeExpiresAt } = issue({ tokenVersion: 3 });
    const c = claimsOf(resumeToken);
    expect(c).toMatchObject({ kind: RESUME_TOKEN_KIND, localUserId: 512, masterUserId: MASTER, token_version: 3 });
    expect(c.exp - c.iat).toBe(RESUME_TOKEN_TTL_SECONDS);
    expect(RESUME_TOKEN_TTL_SECONDS).toBe(12 * 60 * 60);
    expect(resumeExpiresAt).toBe(new Date(c.exp * 1000).toISOString());
    expect(RESUME_TOKEN_KIND).toBe('online_resume');
    // A fresh ticket login: orig_iat = iat (this IS the original login).
    expect(c.orig_iat).toBe(c.iat);
    expect(c.phone).toBeUndefined();
  });

  it('the session phone round-trips (authWithTicket carries one; the waitlist bootstrap none)', () => {
    expect(claimsOf(issue({ phone: 'josh.hall2' }).resumeToken).phone).toBe('josh.hall2');
    expect(claimsOf(issue({ phone: null }).resumeToken).phone).toBeUndefined();
    expect(claimsOf(issue({ phone: '  ' }).resumeToken).phone).toBeUndefined();
  });

  it('NULL token_version in the DB is issued as 0', () => {
    expect(claimsOf(issue({ tokenVersion: null }).resumeToken).token_version).toBe(0);
  });

  it('is not issued without a master id or with a bad local id', () => {
    expect(issueResumeToken(KEY, { localUserId: 5, masterUserId: '', tokenVersion: 0 }, T0)).toBeNull();
    expect(issueResumeToken(KEY, { localUserId: 0, masterUserId: MASTER, tokenVersion: 0 }, T0)).toBeNull();
    expect(issueResumeToken('', { localUserId: 5, masterUserId: MASTER, tokenVersion: 0 }, T0)).toBeNull();
  });

  it('valid until exp, refused as expired after', () => {
    const { resumeToken } = issue();
    expect(verifyResumeToken(KEY, resumeToken, T0 + (RESUME_TOKEN_TTL_SECONDS - 60) * 1000).ok).toBe(true);
    expect(verifyResumeToken(KEY, resumeToken, T0 + (RESUME_TOKEN_TTL_SECONDS + 1) * 1000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('forged: signed with another key → bad_signature', () => {
    const forged = issueResumeToken(deriveScopedKey('attacker-guess', RESUME_KEY_SCOPE), {
      localUserId: 512, masterUserId: MASTER, tokenVersion: 0,
    }, T0)!.resumeToken;
    expect(verifyResumeToken(KEY, forged, T0)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('forged: payload tampered (another user id) under the original signature → bad_signature', () => {
    const { resumeToken } = issue();
    const [h, , s] = resumeToken.split('.');
    const evil = Buffer.from(JSON.stringify({
      kind: RESUME_TOKEN_KIND, localUserId: 1, masterUserId: MASTER, token_version: 0,
      iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600,
    })).toString('base64url');
    expect(verifyResumeToken(KEY, `${h}.${evil}.${s}`, T0)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('forged: alg:none is refused', () => {
    const none = jwt.sign({ kind: RESUME_TOKEN_KIND, localUserId: 512, masterUserId: MASTER, token_version: 0 }, '', { algorithm: 'none' as any });
    expect(verifyResumeToken(KEY, none, T0).ok).toBe(false);
  });

  it('a correctly signed token of another kind → wrong_kind', () => {
    const other = jwt.sign({ kind: 'something_else', localUserId: 512, masterUserId: MASTER, token_version: 0 }, KEY, { algorithm: 'HS256' });
    expect(verifyResumeToken(KEY, other, Date.now())).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('missing / garbage / oversized input never throws', () => {
    expect(verifyResumeToken(KEY, undefined, T0)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyResumeToken(KEY, '', T0)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyResumeToken(KEY, 'not.a.jwt', T0).ok).toBe(false);
    expect(verifyResumeToken(KEY, 'x'.repeat(5000), T0)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('the failure message the client shows for resume_invalid', () => {
    expect(RESUME_INVALID_MESSAGE).toBe('Your session has ended — please sign in again.');
  });
});

describe('resume token — D1 absolute cap (orig_iat, 24h after the ORIGINAL ticket login)', () => {
  it('the cap is 24h', () => {
    expect(RESUME_ABSOLUTE_MAX_SECONDS).toBe(24 * 60 * 60);
  });

  it('every resume re-issues a FRESH 12h token but carries the ORIGINAL orig_iat unchanged', () => {
    const first = claimsOf(issue({}, T0).resumeToken, T0);
    // Resume at T0+11h: the new token is issued from the presented claims.
    const t1 = T0 + 11 * HOUR_MS;
    const second = issue({ origIat: first.orig_iat }, t1);
    const c2 = claimsOf(second.resumeToken, t1);
    expect(c2.orig_iat).toBe(sec(T0));
    expect(c2.iat).toBe(sec(t1));
    expect(c2.exp).toBe(sec(t1) + RESUME_TOKEN_TTL_SECONDS); // sliding exp stays 12h
    // And again at T0+22h.
    const t2 = T0 + 22 * HOUR_MS;
    const c3 = claimsOf(issue({ origIat: c2.orig_iat }, t2).resumeToken, t2);
    expect(c3.orig_iat).toBe(sec(T0));
  });

  it('S4: exp / resumeExpiresAt NEVER exceed orig_iat + 24h — a resume at +22h gets exp = orig_iat + 24h, not +34h', () => {
    const t22 = T0 + 22 * HOUR_MS;
    const { resumeToken: chained, resumeExpiresAt } = issue({ origIat: sec(T0) }, t22);
    const c = claimsOf(chained, t22);
    expect(c.orig_iat).toBe(sec(T0));
    expect(c.exp).toBe(sec(T0) + RESUME_ABSOLUTE_MAX_SECONDS);              // clamped (was iat + 12h = T0 + 34h)
    expect(resumeExpiresAt).toBe(new Date((sec(T0) + RESUME_ABSOLUTE_MAX_SECONDS) * 1000).toISOString());
    expect(verifyResumeToken(KEY, chained, T0 + 24 * HOUR_MS - 1000).ok).toBe(true); // 1s before the cap
    expect(verifyResumeToken(KEY, chained, T0 + 24 * HOUR_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyResumeToken(KEY, chained, T0 + 30 * HOUR_MS)).toEqual({ ok: false, reason: 'expired' });
    // Every issue point along a chain: exp ≤ orig_iat + 24h and exp ≤ iat + 12h.
    for (let h = 0; h < 24; h++) {
      const at = T0 + h * HOUR_MS;
      const ci = claimsOf(issue({ origIat: sec(T0) }, at).resumeToken, at);
      expect(ci.exp).toBeLessThanOrEqual(sec(T0) + RESUME_ABSOLUTE_MAX_SECONDS);
      expect(ci.exp).toBe(Math.min(sec(at) + RESUME_TOKEN_TTL_SECONDS, sec(T0) + RESUME_ABSOLUTE_MAX_SECONDS));
    }
  });

  it('a resume is REFUSED once now - orig_iat > 24h even when a token\'s own exp is later (session_too_old, defence in depth)', () => {
    // A token shaped like the pre-S4 issuer's (exp = iat + 12h past the cap),
    // signed with the real key: the orig_iat check still refuses it.
    const iat = sec(T0 + 22 * HOUR_MS);
    const legacyShaped = jwt.sign({
      kind: RESUME_TOKEN_KIND, localUserId: 512, masterUserId: MASTER, token_version: 0,
      orig_iat: sec(T0), iat, exp: iat + RESUME_TOKEN_TTL_SECONDS,
    }, KEY);
    expect(verifyResumeToken(KEY, legacyShaped, T0 + 24 * HOUR_MS).ok).toBe(true); // exactly 24h: still allowed
    expect(verifyResumeToken(KEY, legacyShaped, T0 + 24 * HOUR_MS + 1000)).toEqual({ ok: false, reason: 'session_too_old' });
    expect(verifyResumeToken(KEY, legacyShaped, T0 + 30 * HOUR_MS)).toEqual({ ok: false, reason: 'session_too_old' });
  });

  it('S4: a chain AT its cap gets no token (it could never be used)', () => {
    expect(issueResumeToken(KEY, { localUserId: 512, masterUserId: MASTER, tokenVersion: 0, origIat: sec(T0) }, T0 + 24 * HOUR_MS)).toBeNull();
    expect(issueResumeToken(KEY, { localUserId: 512, masterUserId: MASTER, tokenVersion: 0, origIat: sec(T0) }, T0 + 24 * HOUR_MS - 1000)).not.toBeNull();
  });

  it('a chain can never be extended past the cap: no token is issued for an orig_iat already > 24h old', () => {
    expect(issueResumeToken(KEY, { localUserId: 512, masterUserId: MASTER, tokenVersion: 0, origIat: sec(T0) }, T0 + 25 * HOUR_MS)).toBeNull();
  });

  it('orig_iat is REQUIRED and can never be later than iat (forged-shape tokens refused as bad_claims)', () => {
    const now = sec(T0);
    const noOrig = jwt.sign({ kind: RESUME_TOKEN_KIND, localUserId: 512, masterUserId: MASTER, token_version: 0, iat: now, exp: now + 3600 }, KEY);
    expect(verifyResumeToken(KEY, noOrig, T0)).toEqual({ ok: false, reason: 'bad_claims' });
    const future = jwt.sign({ kind: RESUME_TOKEN_KIND, localUserId: 512, masterUserId: MASTER, token_version: 0, orig_iat: now + 10, iat: now, exp: now + 3600 }, KEY);
    expect(verifyResumeToken(KEY, future, T0)).toEqual({ ok: false, reason: 'bad_claims' });
  });
});

describe('resume token — row checks (revocation)', () => {
  const claims = () => claimsOf(issue({ tokenVersion: 2 }).resumeToken);
  const row = (over: Record<string, unknown> = {}) => ({
    id: 512, banned: false, token_version: 2, stats: JSON.stringify({ masterUserId: MASTER }), ...over,
  });

  it('the matching row is accepted (TEXT stats, as on prod)', () => {
    expect(checkResumeRow(claims(), row())).toBeNull();
  });

  it('a row with NO master stamp is accepted (prod ticket rows mostly carry none)', () => {
    expect(checkResumeRow(claims(), row({ stats: '{"handsPlayed":3}' }))).toBeNull();
    expect(checkResumeRow(claims(), row({ stats: null }))).toBeNull();
  });

  it('REVOKED: bumping users.token_version kills the token', () => {
    expect(checkResumeRow(claims(), row({ token_version: 3 }))).toBe('token_version_mismatch');
  });

  it('banned → refused', () => {
    expect(checkResumeRow(claims(), row({ banned: true }))).toBe('banned');
  });

  it('D1: an is_admin row is NEVER resumable (admin_row), even with an otherwise valid token', () => {
    expect(checkResumeRow(claims(), row({ is_admin: true }))).toBe('admin_row');
    expect(checkResumeRow(claims(), row({ is_admin: false }))).toBeNull();
  });

  it('D1: a sign-out bump (socket `revokeSignInTokens`; the compatibility-only `logout` does the same) — token_version + 1 — revokes the token: the next resume is refused', () => {
    const c = claimsOf(issue({ tokenVersion: 0 }).resumeToken);
    expect(checkResumeRow(c, row({ token_version: 0 }))).toBeNull();
    // revokeTokensOnSignOut → authManager.bumpTokenVersion: token_version 0 → 1.
    expect(checkResumeRow(c, row({ token_version: 1 }))).toBe('token_version_mismatch');
  });

  it('master link changed → refused', () => {
    expect(checkResumeRow(claims(), row({ stats: { masterUserId: 'someone-else' } }))).toBe('master_link_changed');
  });

  it('a row retired by a guest carry-over → refused', () => {
    expect(checkResumeRow(claims(), row({ stats: { claimedBy: 9 } }))).toBe('row_retired');
  });

  it('missing row, or a different row → user_missing', () => {
    expect(checkResumeRow(claims(), undefined)).toBe('user_missing');
    expect(checkResumeRow(claims(), row({ id: 513 }))).toBe('user_missing');
  });
});

describe('D1 sign-out revocation — which rows a sign-out (`revokeSignInTokens` / the kept `logout`) bumps', () => {
  // revokeTokensOnSignOut (src/index.ts) bumps users.token_version UNLESS
  // isClaimableGuestRow: a pre-shutoff guest row keeps its legacy token, the
  // device's only proof for the carry-over (D2). Every other row is bumped.
  const guest = { username: 'Guest1971', stats: '{"handsPlayed":812}', created_at: '2026-08-21T01:48:18.979Z', banned: false };

  it('a claimable pre-shutoff guest row is NOT bumped (its token stays the carry-over key)', () => {
    expect(isClaimableGuestRow(guest)).toBe(true);
  });

  it.each([
    ['an account row (ticket slug)', { ...guest, username: 'josh.hall2' }],
    ['a master-stamped row', { ...guest, stats: JSON.stringify({ masterUserId: MASTER }) }],
    ['a guest row created after the 2026-10-09T16:00Z cutoff', { ...guest, created_at: '2026-10-09T17:00:00Z' }],
    ['an already-claimed guest row', { ...guest, stats: '{"claimedBy":512}' }],
    ['a banned guest row', { ...guest, banned: true }],
  ])('%s IS bumped', (_label, row) => {
    expect(isClaimableGuestRow(row)).toBe(false);
  });

  it('src/index.ts (S1 + T2): revokeSignInTokens and the kept logout ONLY revoke (awaited) then ack — they never end the session or stand anyone up; the guest exemption precedes the bump', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const forbiddenInSignOut = ['authSessions.delete', 'handlePlayerLeave', 'standUp', 'playerSessions', 'reservedSeats', 'addChipsToUser'];
    // Both socket events delegate to the ONE shared body, nothing else.
    for (const event of ['revokeSignInTokens', 'logout']) {
      const at = src.indexOf(`socket.on('${event}', async (...args: unknown[]) => {`);
      expect(at).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('\n  });', at));
      expect(body).toContain(`await answerSignInTokenRevocation(socket, '${event}', args);`);
      for (const forbidden of forbiddenInSignOut) expect(body).not.toContain(forbidden);
    }
    // The disconnect handler owns the teardown — it needs the auth session.
    const fnBody = (needle: string) => {
      const fnAt = src.indexOf(needle);
      expect(fnAt).toBeGreaterThan(-1);
      return src.slice(fnAt, src.indexOf('\n}\n', fnAt));
    };
    const forSocket = fnBody('async function revokeSignInTokensForSocket(');
    const answer = fnBody('async function answerSignInTokenRevocation(');
    for (const forbidden of forbiddenInSignOut) {
      expect(forSocket).not.toContain(forbidden);
      expect(answer).not.toContain(forbidden);
    }
    expect(forSocket).toContain("await revokeTokensOnSignOut(session.userId, 'logout', event)");
    const revokeAt = answer.indexOf('answer = await revokeSignInTokensForSocket(socket, event);');
    const ackAt = answer.indexOf('ack(answer)');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(ackAt).toBeGreaterThan(revokeAt); // ack only after the bump settled
    const fnAt = src.indexOf('async function revokeTokensOnSignOut(');
    const fn = src.slice(fnAt, src.indexOf('\n}\n', fnAt));
    expect(fn.indexOf('if (isClaimableGuestRow(row)) {')).toBeGreaterThan(-1);
    expect(fn.indexOf('await bumpTokenVersion(userId);')).toBeGreaterThan(fn.indexOf('if (isClaimableGuestRow(row)) {'));
    // It touches token_version only — never a session, seat or chip.
    for (const forbidden of ['authSessions', 'playerSessions', 'standUp', 'addChipsToUser', 'handlePlayerLeave']) {
      expect(fn).not.toContain(forbidden);
    }
  });

  it('src/index.ts (S4): adminKickPlayer revokes the kicked row\'s tokens (awaited) BEFORE dropping any socket', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const at = src.indexOf("socket.on('adminKickPlayer', async (data: { userId: number }) => {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n  });', at));
    const adminGateAt = body.indexOf('!(await isUserAdmin(auth.userId))');
    const revokeAt = body.indexOf("await revokeTokensOnSignOut(targetUserId, 'admin_kick')");
    const disconnectAt = body.indexOf('s.disconnect(true)');
    expect(adminGateAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(adminGateAt);
    expect(disconnectAt).toBeGreaterThan(revokeAt);
    expect(body).toContain("auditLog(auth.username, 'ADMIN_KICK', { targetUserId, tokenRevocation: revocation });");
  });
});

describe('resume token — key derivation + domain separation from legacy login tokens', () => {
  it('authManager.getScopedSigningKey derives the same key from JWT_SECRET', () => {
    expect(authManager.JWT_LEGACY_DISABLED).toBe(false);
    expect(authManager.getScopedSigningKey(RESUME_KEY_SCOPE)).toBe(KEY);
    expect(KEY).not.toBe(TEST_JWT_SECRET);
  });

  it('a resume token is NOT a legacy login token', () => {
    const { resumeToken } = issue();
    expect(authManager.verifyLegacyTokenClaims(resumeToken).ok).toBe(false);
  });

  it('a legacy login token (JWT_SECRET, HS256) is NOT a resume token', () => {
    const legacy = jwt.sign({ userId: 512, username: 'Guest1971', tokenVersion: 0 }, TEST_JWT_SECRET, { expiresIn: '7d' });
    expect(authManager.verifyLegacyTokenClaims(legacy)).toMatchObject({ ok: true, userId: 512, tokenVersion: 0 });
    expect(verifyResumeToken(KEY, legacy).ok).toBe(false);
  });
});

describe('verifyLegacyTokenClaims — the guest carry-over proof', () => {
  const nowMs = Date.now();
  const sign = (exp: number, extra: Record<string, unknown> = {}) =>
    jwt.sign({ userId: 4203, username: 'Guest1971', tokenVersion: 0, iat: exp - 7 * 86400, exp, ...extra }, TEST_JWT_SECRET);

  it('an unexpired token verifies', () => {
    expect(authManager.verifyLegacyTokenClaims(sign(Math.floor(nowMs / 1000) + 3600))).toEqual({
      ok: true, userId: 4203, tokenVersion: 0, expired: false, username: 'Guest1971',
    });
  });

  it('expired: refused by default; accepted (signature still checked) with allowExpired — however old', () => {
    const expiredTenDaysAgo = sign(Math.floor(nowMs / 1000) - 10 * 86400);
    const expiredTwoYearsAgo = sign(Math.floor(nowMs / 1000) - 2 * 365 * 86400);
    expect(authManager.verifyLegacyTokenClaims(expiredTenDaysAgo)).toEqual({ ok: false, reason: 'expired' });
    expect(authManager.verifyLegacyTokenClaims(expiredTenDaysAgo, { allowExpired: true }))
      .toEqual({ ok: true, userId: 4203, tokenVersion: 0, expired: true, username: 'Guest1971' });
    expect(authManager.verifyLegacyTokenClaims(expiredTwoYearsAgo, { allowExpired: true }))
      .toEqual({ ok: true, userId: 4203, tokenVersion: 0, expired: true, username: 'Guest1971' });
  });

  it('allowExpired never rescues a bad signature', () => {
    const forgedExpired = jwt.sign(
      { userId: 4203, tokenVersion: 0, iat: Math.floor(nowMs / 1000) - 20 * 86400, exp: Math.floor(nowMs / 1000) - 13 * 86400 },
      'not-the-secret',
    );
    expect(authManager.verifyLegacyTokenClaims(forgedExpired, { allowExpired: true })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('wrong secret / garbage → invalid', () => {
    const bad = jwt.sign({ userId: 4203, tokenVersion: 0 }, 'not-the-secret', { expiresIn: '7d' });
    expect(authManager.verifyLegacyTokenClaims(bad)).toEqual({ ok: false, reason: 'invalid' });
    expect(authManager.verifyLegacyTokenClaims('garbage')).toEqual({ ok: false, reason: 'invalid' });
    expect(authManager.verifyLegacyTokenClaims(undefined)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('getUserFromToken (LOGIN) still refuses an expired legacy token — allowExpired is claim-only', async () => {
    const expired = sign(Math.floor(nowMs / 1000) - 10 * 86400);
    // Rejected at jwt.verify, before any DB access.
    expect(await authManager.getUserFromToken(expired)).toMatchObject({ success: false });
  });
});

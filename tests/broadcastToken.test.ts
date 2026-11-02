/**
 * 2026-11-02 (.online tournament broadcast, P2-S4) — BROADCAST TOKENS
 * (src/broadcast/broadcastToken.ts): HS256 pinned, typ 'bcast+jwt' pinned, nbf /
 * exp, at most 12 h, a secret of 32+ characters or nothing works, the registry
 * (revocation survives a restart; an unknown jti is refused: fail-closed), and the
 * token string is never stored.
 */
import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import {
  createTokenRegistry, signBroadcastToken, tokenSecretOf, validateMintRequest, verifyBroadcastToken, parseTokenEv, cleanLabel,
  BROADCAST_TOKEN_SECRET_MIN,
} from '../src/broadcast/broadcastToken';
import { BROADCAST_TOKEN_TYP, BROADCAST_TOKEN_MAX_TTL_MS } from '../src/broadcast/contract';
import { fakeBroadcastDb } from './helpers/broadcastWorld';

const SECRET = 'a-very-long-broadcast-secret-0123456789';
const NOW = Date.UTC(2026, 10, 8, 18, 0, 0);
const H = 3_600_000;

function mintOk(req: Record<string, unknown>, now = NOW) {
  const v = validateMintRequest(req as any, now);
  if (!v.ok) throw new Error(`invalid: ${v.code}`);
  return v;
}
const claims = (o: Record<string, unknown> = {}) => ({ jti: 'j-1', ev: 'ch:weekly', scp: ['output'], iss_m: 'm-1', lbl: 'OBS', nbf: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600, ...o }) as any;

describe('S4 token — the mint request rules', () => {
  it('ev: ch:<channel> | ch:* | q:<id> | t:<id>; next: / junk → event_not_found', () => {
    expect(parseTokenEv('ch:*')).toEqual({ kind: 'ch', channel: '*' });
    expect(parseTokenEv('ch:weekly')).toEqual({ kind: 'ch', channel: 'weekly' });
    expect(parseTokenEv('q:Q-1')).toEqual({ kind: 'q', id: 'Q-1' });
    expect(parseTokenEv('t:abc')).toEqual({ kind: 't', id: 'abc' });
    for (const bad of ['ch:tv', 'next:weekly', 'q:', 'x:1', '', 7, null]) expect(validateMintRequest({ ev: bad, scopes: ['output'], label: 'x' }, NOW)).toEqual({ ok: false, code: 'event_not_found' });
  });

  it('scopes: known, unique, non-empty; ch:* is producer ONLY; delayed only for q: / t:', () => {
    for (const scopes of [[], ['viewer'], ['output', 'output'], 'output', ['output', 'producer', 'delayed', 'x']]) {
      expect(validateMintRequest({ ev: 'ch:weekly', scopes, label: 'x' } as any, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    }
    expect(validateMintRequest({ ev: 'ch:*', scopes: ['output'], label: 'x' }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    expect(validateMintRequest({ ev: 'ch:*', scopes: ['producer', 'output'], label: 'x' }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    expect(validateMintRequest({ ev: 'ch:*', scopes: ['delayed'], label: 'x' }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    expect(validateMintRequest({ ev: 'ch:weekly', scopes: ['delayed', 'output'], label: 'x' }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    expect(mintOk({ ev: 'ch:*', scopes: ['producer'], label: 'Producer panel' }).scopes).toEqual(['producer']);
    expect(mintOk({ ev: 'q:Q-1', scopes: ['delayed', 'output'], label: 'x' }).scopes).toEqual(['delayed', 'output']);
  });

  it('the lifetime is capped at 12 h (default 12 h); nbf = now or notBefore (at most 7 days ahead); whole seconds; the label is plain text', () => {
    const v = mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x', ttlHours: 48 });
    expect(v.exp - v.nbf).toBe(BROADCAST_TOKEN_MAX_TTL_MS);
    expect(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x' }).exp - NOW).toBe(12 * H);
    expect(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x', ttlHours: 2 }).exp - NOW).toBe(2 * H);
    expect(validateMintRequest({ ev: 'ch:weekly', scopes: ['output'], label: 'x', ttlHours: 0 }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    expect(validateMintRequest({ ev: 'ch:weekly', scopes: ['output'], label: 'x', ttlHours: 'lots' }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    const later = mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x', notBefore: NOW + 2 * H, ttlHours: 3 });
    expect([later.nbf, later.exp]).toEqual([NOW + 2 * H, NOW + 5 * H]);
    expect(validateMintRequest({ ev: 'ch:weekly', scopes: ['output'], label: 'x', notBefore: NOW + 8 * 24 * H }, NOW)).toEqual({ ok: false, code: 'invalid_request' });
    expect(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x', notBefore: NOW - H }).nbf).toBe(NOW);
    expect(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: ' OBS\u0000 main‮ ' }).label).toBe('OBS main');
    expect(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: '' }).label).toBe('Broadcast key');
    expect(cleanLabel('x'.repeat(100), 60)).toHaveLength(60);
  });
});

describe('S4 token — signature, algorithm, type, time', () => {
  it('round trip: typ bcast+jwt, HS256; the claims come back', () => {
    const tok = signBroadcastToken(SECRET, claims());
    const head = JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString());
    expect(head).toEqual({ alg: 'HS256', typ: BROADCAST_TOKEN_TYP });
    expect(verifyBroadcastToken(SECRET, tok, NOW)).toEqual({ ok: true, claims: claims() });
  });

  it('refused: alg none, RS256, HS512 (same secret), typ JWT, a tampered payload or signature, another secret, junk', () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: BROADCAST_TOKEN_TYP })).toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`;
    expect(verifyBroadcastToken(SECRET, none, NOW)).toEqual({ ok: false, code: 'bad_token' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rs = jwt.sign(claims(), privateKey, { algorithm: 'RS256', header: { alg: 'RS256', typ: BROADCAST_TOKEN_TYP }, noTimestamp: true });
    expect(verifyBroadcastToken(SECRET, rs, NOW)).toEqual({ ok: false, code: 'bad_token' });
    const hs512 = jwt.sign(claims(), SECRET, { algorithm: 'HS512', header: { alg: 'HS512', typ: BROADCAST_TOKEN_TYP }, noTimestamp: true });
    expect(verifyBroadcastToken(SECRET, hs512, NOW)).toEqual({ ok: false, code: 'bad_token' });
    const typJwt = jwt.sign(claims(), SECRET, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' }, noTimestamp: true });
    expect(verifyBroadcastToken(SECRET, typJwt, NOW)).toEqual({ ok: false, code: 'bad_token' });
    const good = signBroadcastToken(SECRET, claims());
    const [h, p, s] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims(), scp: ['producer'], ev: 'ch:*' })).toString('base64url');
    expect(verifyBroadcastToken(SECRET, `${h}.${forged}.${s}`, NOW)).toEqual({ ok: false, code: 'bad_token' });
    expect(verifyBroadcastToken(SECRET, `${h}.${p}.${s.slice(0, -2)}xx`, NOW)).toEqual({ ok: false, code: 'bad_token' });
    expect(verifyBroadcastToken('another-secret-of-enough-length-012345', good, NOW)).toEqual({ ok: false, code: 'bad_token' });
    for (const junk of ['', 'abc', 'a.b.c', 42, null, 'x'.repeat(5000)]) expect(verifyBroadcastToken(SECRET, junk, NOW)).toEqual({ ok: false, code: 'bad_token' });
  });

  it('nbf / exp: not yet valid, expired; a lifetime over 12 h is refused even when signed with the secret; bad claim shapes refused', () => {
    expect(verifyBroadcastToken(SECRET, signBroadcastToken(SECRET, claims({ nbf: Math.floor(NOW / 1000) + 60, exp: Math.floor(NOW / 1000) + 120 })), NOW)).toEqual({ ok: false, code: 'not_yet_valid' });
    expect(verifyBroadcastToken(SECRET, signBroadcastToken(SECRET, claims({ nbf: Math.floor(NOW / 1000) - 7200, exp: Math.floor(NOW / 1000) - 1 })), NOW)).toEqual({ ok: false, code: 'expired' });
    expect(verifyBroadcastToken(SECRET, signBroadcastToken(SECRET, claims({ exp: Math.floor(NOW / 1000) + 13 * 3600 })), NOW)).toEqual({ ok: false, code: 'bad_token' });
    for (const bad of [{ scp: [] }, { scp: ['root'] }, { ev: 'next:weekly' }, { jti: '' }]) {
      expect(verifyBroadcastToken(SECRET, signBroadcastToken(SECRET, claims(bad)), NOW)).toEqual({ ok: false, code: 'bad_token' });
    }
  });

  it('the secret: under 32 characters (or unset) = every token feature off (secret_unset)', () => {
    expect(tokenSecretOf({})).toBeNull();
    expect(tokenSecretOf({ BROADCAST_TOKEN_SECRET: 'x'.repeat(BROADCAST_TOKEN_SECRET_MIN - 1) })).toBeNull();
    expect(tokenSecretOf({ BROADCAST_TOKEN_SECRET: ` ${'x'.repeat(BROADCAST_TOKEN_SECRET_MIN)} ` })).toBe('x'.repeat(BROADCAST_TOKEN_SECRET_MIN));
    expect(verifyBroadcastToken(null, signBroadcastToken(SECRET, claims()), NOW)).toEqual({ ok: false, code: 'secret_unset' });
  });
});

describe('S4 token — the registry (Postgres broadcast_tokens: jti + metadata, never the token)', () => {
  it('mint → check ok; revoke → revoked; a correctly signed token whose jti the registry does not know → revoked (fail-closed); claims that disagree with the row → bad_token', async () => {
    let t = NOW;
    const reg = createTokenRegistry({ secret: () => SECRET, now: () => t, log: () => {} });
    const m = await reg.mint(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS' }), { masterUserId: 'm-1', userId: 7 });
    if (!m.ok) throw new Error('mint');
    const c = reg.check(m.token);
    expect(c).toMatchObject({ ok: true, claims: { jti: m.row.jti, ev: 'ch:weekly', scp: ['output'], iss_m: 'm-1', lbl: 'OBS' }, row: { issuedByUser: 7 } });
    expect(reg.check(signBroadcastToken(SECRET, claims({ jti: 'not-issued-here' })))).toEqual({ ok: false, code: 'revoked' });
    expect(reg.check(signBroadcastToken(SECRET, claims({ jti: m.row.jti, ev: 'ch:main' })))).toEqual({ ok: false, code: 'bad_token' });
    expect(reg.liveRowsOf('m-1').map((r) => r.jti)).toEqual([m.row.jti]);
    await reg.revoke(m.row.jti);
    expect(reg.check(m.token)).toEqual({ ok: false, code: 'revoked' });
    expect(reg.stillValid(m.row.jti)).toEqual({ ok: false, code: 'revoked' });
    expect(reg.liveRowsOf('m-1')).toEqual([]);
    const m2 = await reg.mint(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS', ttlHours: 1 }), { masterUserId: 'm-1', userId: 7 });
    if (!m2.ok) throw new Error('mint');
    t = NOW + H;
    expect(reg.stillValid(m2.row.jti)).toEqual({ ok: false, code: 'expired' });
    expect(reg.check(m2.token)).toEqual({ ok: false, code: 'expired' });
    const off = createTokenRegistry({ secret: () => null, log: () => {} });
    expect(await off.mint(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x' }), { masterUserId: null, userId: null })).toEqual({ ok: false, code: 'secret_unset' });
    expect(off.check(m.token)).toEqual({ ok: false, code: 'secret_unset' });
  });

  it('persisted: the row (never the token string) is written; a NEW registry loading it accepts the token and keeps the revocation (a restart)', async () => {
    const db = fakeBroadcastDb();
    const reg = createTokenRegistry({ secret: () => SECRET, db, now: () => NOW, log: () => {} });
    const a = await reg.mint(mintOk({ ev: 'q:Q-1', scopes: ['output'], label: 'OBS' }), { masterUserId: 'm-9', userId: 9 });
    const b = await reg.mint(mintOk({ ev: 'ch:*', scopes: ['producer'], label: 'Producer panel' }), { masterUserId: 'm-9', userId: 9 });
    if (!a.ok || !b.ok) throw new Error('mint');
    expect(a.persisted).toBe(true);
    await reg.revoke(b.row.jti);
    const stored = JSON.stringify([...db.tokens.values()]) + JSON.stringify(db.queries);
    expect(stored).not.toContain(a.token);
    expect(stored).not.toContain(a.token.split('.')[2]);
    expect(db.tokens.get(a.row.jti)).toMatchObject({ ev: 'q:Q-1', scopes: ['output'], label: 'OBS', issued_by_master: 'm-9', issued_by_user: 9 });
    const after = createTokenRegistry({ secret: () => SECRET, db, now: () => NOW, log: () => {} });
    expect(await after.load()).toEqual({ loaded: 2 });
    expect(after.check(a.token)).toMatchObject({ ok: true, row: { jti: a.row.jti, ev: 'q:Q-1' } });
    expect(after.check(b.token)).toEqual({ ok: false, code: 'revoked' });
    // Before the load (or with no row) the same token is refused.
    expect(createTokenRegistry({ secret: () => SECRET, db, now: () => NOW, log: () => {} }).check(a.token)).toEqual({ ok: false, code: 'revoked' });
  });

  it('a DB failure: the mint still works in this process (persisted:false, logged); the load fails soft', async () => {
    const db = fakeBroadcastDb();
    db.fail = true;
    const logs: string[] = [];
    const reg = createTokenRegistry({ secret: () => SECRET, db, now: () => NOW, log: (l) => logs.push(l) });
    const m = await reg.mint(mintOk({ ev: 'ch:weekly', scopes: ['output'], label: 'x' }), { masterUserId: null, userId: 1 });
    expect(m).toMatchObject({ ok: true, persisted: false });
    if (m.ok) expect(reg.check(m.token).ok).toBe(true);
    expect(await reg.load()).toMatchObject({ loaded: 0, error: 'db down' });
    expect(logs.some((l) => l.includes('broadcast_token_save_failed'))).toBe(true);
    expect(logs.join('\n')).not.toContain(m.ok ? m.token : '-');
  });
});

/**
 * 2026-11-02 (.online tournament broadcast, P2-S4) — WHO GETS A BROADCAST KEY AND
 * WHAT IT OPENS, end to end on a REAL in-process socket.io server:
 *  - 'broadcastIssueToken' (default namespace): signed in, isUserAdmin AND the
 *    login's own is_admin claim; an entrant cannot issue (issuer_is_entrant);
 *    'ch:*' only with the producer scope; 'delayed' → holecards_off (P5 dark);
 *    the reply on 'broadcastTokenIssued' and the ack; audited without the token;
 *  - a producer key minted there works on /broadcast (bc:producer:hello);
 *  - handshake refusals bad_token / expired / not_yet_valid / revoked / secret_unset;
 *  - an output key counts as an on-air output only with role 'output' on its own
 *    channel (else wrong_event); held by an entrant → entrant;
 *  - revoked / expired mid-session → bc:authExpired + disconnect;
 *  - spec R4: registration refused broadcast_staff_cannot_enter while the account
 *    holds a live key for that event (and the index.ts wiring).
 */
import { createBroadcastIssueHandler } from '../src/broadcast/broadcastToken';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { SRC } from './helpers/indexSource';
import { broadcastRig, fakeRes, settle, type Rig } from './helpers/broadcastRig';

interface Auth { userId: number; username: string; masterUserId?: string; isAdminClaim?: boolean }

function issuer(r: Rig, sessions: Map<string, Auth>, admins: Set<number>, limit = 50) {
  return createBroadcastIssueHandler({
    authOf: (id) => sessions.get(id),
    isUserAdmin: async (uid) => admins.has(uid),
    mint: (req, who) => r.handle.mintToken(req, who),
    limiter: createWindowRateLimiter(limit, 60 * 60_000),
    log: () => {},
  });
}
function fakeSocket(id: string) {
  const emitted: Array<[string, any]> = [];
  return { id, emitted, emit: (ev: string, d: unknown) => { emitted.push([ev, d]); return true; } };
}
async function issue(h: ReturnType<typeof issuer>, sock: ReturnType<typeof fakeSocket>, data: Record<string, unknown>) {
  let acked: any = null;
  await h.issue(sock, data, (x: unknown) => { acked = x; });
  const ev = sock.emitted.filter(([e]) => e === 'broadcastTokenIssued').pop()?.[1];
  expect(ev).toEqual(acked);
  return acked;
}
const PRODUCER = { ev: 'ch:*', scopes: ['producer'], label: 'Producer panel', ttlHours: 12 };

describe('S4 — broadcastIssueToken (default namespace, signed-in admin)', () => {
  it('login_required; not_admin without isUserAdmin OR without this login\'s is_admin claim; an admin with the claim gets a token (event AND ack), audited without the token', async () => {
    const r = await broadcastRig();
    try {
      const sessions = new Map<string, Auth>();
      const admins = new Set<number>([1, 2]);
      const h = issuer(r, sessions, admins);
      const s = fakeSocket('s1');
      expect(await issue(h, s, PRODUCER)).toEqual({ ok: false, code: 'login_required' });
      sessions.set('s1', { userId: 3, username: 'plain', masterUserId: 'm-3', isAdminClaim: true });
      expect(await issue(h, s, PRODUCER)).toEqual({ ok: false, code: 'not_admin' });            // claim but no local admin
      sessions.set('s1', { userId: 2, username: 'stale', masterUserId: 'm-2' });
      expect(await issue(h, s, PRODUCER)).toEqual({ ok: false, code: 'not_admin' });            // grant-only column, no claim now
      sessions.set('s1', { userId: 1, username: 'owner', masterUserId: 'm-owner', isAdminClaim: true });
      const ok = await issue(h, s, PRODUCER);
      expect(ok).toMatchObject({ ok: true, jti: expect.any(String), scopes: ['producer'], nbf: expect.any(Number), exp: expect.any(Number) });
      expect(ok.exp - ok.nbf).toBe(12 * 3_600_000);
      expect(typeof ok.token).toBe('string');
      const a = r.audits.find((x) => x.action === 'BROADCAST_TOKEN_ISSUED')!;
      expect(a).toMatchObject({ actor: 'owner', details: { jti: ok.jti, ev: 'ch:*', scopes: ['producer'], byUserId: 1, byMasterUserId: 'm-owner' } });
      expect(JSON.stringify(r.audits) + r.logs.join('\n')).not.toContain(ok.token);
    } finally { await r.close(); }
  });

  it('ch:* only with the producer scope; delayed → holecards_off (built dark); an unknown event → event_not_found; an entrant → issuer_is_entrant; a rate limit', async () => {
    const r = await broadcastRig();
    try {
      const sessions = new Map<string, Auth>([['s1', { userId: 1, username: 'owner', masterUserId: 'm-owner', isAdminClaim: true }]]);
      const h = issuer(r, sessions, new Set([1, 101]), 9);
      const s = fakeSocket('s1');
      expect(await issue(h, s, { ev: 'ch:*', scopes: ['output'], label: 'x' })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await issue(h, s, { ev: 'ch:*', scopes: ['producer', 'output'], label: 'x' })).toEqual({ ok: false, code: 'invalid_request' });
      expect(await issue(h, s, { ev: `q:${r.w.qualId}`, scopes: ['delayed', 'output'], label: 'x' })).toEqual({ ok: false, code: 'holecards_off' });
      expect(await issue(h, s, { ev: 'q:nope', scopes: ['output'], label: 'x' })).toEqual({ ok: false, code: 'event_not_found' });
      expect((await issue(h, s, { ev: `q:${r.w.qualId}`, scopes: ['output'], label: 'OBS' })).ok).toBe(true);
      expect((await issue(h, s, { ev: 'ch:weekly', scopes: ['output', 'producer'], label: 'OBS' })).ok).toBe(true);
      // An admin who is registered in the event (John Smith = local 101 / m-0000-101).
      sessions.set('s2', { userId: 101, username: 'john', masterUserId: 'm-0000-101', isAdminClaim: true });
      const s2 = fakeSocket('s2');
      expect(await issue(h, s2, { ev: `q:${r.w.qualId}`, scopes: ['output'], label: 'x' })).toEqual({ ok: false, code: 'issuer_is_entrant' });
      expect(await issue(h, s2, { ev: 'ch:weekly', scopes: ['output'], label: 'x' })).toEqual({ ok: false, code: 'issuer_is_entrant' });
      expect(await issue(h, s2, PRODUCER)).toEqual({ ok: false, code: 'issuer_is_entrant' });
      expect((await issue(h, s2, { ev: 'ch:monthly', scopes: ['output'], label: 'x' })).ok).toBe(true);   // nothing he plays
      for (let i = 0; i < 6; i++) await issue(h, s, PRODUCER);
      expect(await issue(h, s, PRODUCER)).toEqual({ ok: false, code: 'rate_limited' });
    } finally { await r.close(); }
  });

  it('no secret configured → secret_unset (every token feature off)', async () => {
    const r = await broadcastRig({ env: { BROADCAST_TOKEN_SECRET: 'too-short' } });
    try {
      const h = issuer(r, new Map([['s1', { userId: 1, username: 'owner', masterUserId: 'm-owner', isAdminClaim: true }]]), new Set([1]));
      expect(await issue(h, fakeSocket('s1'), PRODUCER)).toEqual({ ok: false, code: 'secret_unset' });
      expect((r.handle.health() as any).secretConfigured).toBe(false);
      const k = r.client('/broadcast', { auth: { key: 'eyJ.anything.here' } });
      expect((await k.ready).error.data).toEqual({ code: 'secret_unset' });
    } finally { await r.close(); }
  });
});

describe('S4 — keys on /broadcast', () => {
  async function owner(r: Rig) {
    const sessions = new Map<string, Auth>([['s1', { userId: 1, username: 'owner', masterUserId: 'm-owner', isAdminClaim: true }]]);
    const h = issuer(r, sessions, new Set([1]));
    return (data: Record<string, unknown>) => issue(h, fakeSocket('s1'), data);
  }

  it('a producer key minted on the default namespace works on /broadcast (bc:producer:hello); a viewer gets not_producer', async () => {
    const r = await broadcastRig();
    try {
      const mint = await owner(r);
      const tok = await mint(PRODUCER);
      const p = r.client('/broadcast', { auth: { key: tok.token } });
      expect((await p.ready).ok).toBe(true);
      const hello = await p.request('bc:producer:hello', {});
      expect(hello).toMatchObject({ ok: true, channels: expect.any(Array), events: expect.any(Array) });
      expect(hello.channels.map((c: any) => c.channel)).toEqual(['main', 'weekly', 'monthly', 'sitgo']);
      const v = r.client('/broadcast');
      await v.ready;
      expect(await v.request('bc:producer:hello', {})).toEqual({ ok: false, code: 'not_producer' });
      expect((r.handle.health() as any).producerSessions).toBe(1);
    } finally { await r.close(); }
  });

  it('handshake refusals: bad_token, expired, not_yet_valid, revoked (each logged broadcast_token_refused; never the token)', async () => {
    const r = await broadcastRig();
    try {
      const mint = await owner(r);
      const bad = r.client('/broadcast', { auth: { key: 'not.a.token' } });
      expect((await bad.ready).error.data).toEqual({ code: 'bad_token' });
      const later = await mint({ ev: 'ch:weekly', scopes: ['output'], label: 'later', notBefore: Date.now() + 3_600_000 });
      const nyv = r.client('/broadcast', { auth: { key: later.token } });
      expect((await nyv.ready).error.data).toEqual({ code: 'not_yet_valid' });
      const short = await mint({ ev: 'ch:weekly', scopes: ['output'], label: 'short', ttlHours: 1 });
      r.clock.t = Date.now() + 2 * 3_600_000;
      const exp = r.client('/broadcast', { auth: { key: short.token } });
      expect((await exp.ready).error.data).toEqual({ code: 'expired' });
      r.clock.t = null;
      const rv = await mint({ ev: 'ch:weekly', scopes: ['output'], label: 'rv' });
      await r.handle.tokens.revoke(rv.jti);
      const c = r.client('/broadcast', { auth: { key: rv.token } });
      expect((await c.ready).error.data).toEqual({ code: 'revoked' });
      expect(r.logs.filter((l) => l.includes('broadcast_token_refused')).length).toBe(4);
      expect(r.logs.join('\n')).not.toContain(rv.token);
    } finally { await r.close(); }
  });

  it('an output key: role output on ITS channel counts as an on-air output (on-air source output); another channel → wrong_event; no key + role output = a viewer', async () => {
    const r = await broadcastRig();
    try {
      const mint = await owner(r);
      const k = await mint({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly' });
      const v = r.client('/broadcast');
      await v.ready;
      expect((await v.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '16x9', role: 'output' })).ok).toBe(true);
      expect((r.handle.health() as any).outputs).toBe(0);
      let x = fakeRes(); r.routes['GET /api/broadcast/on-air']({}, x);
      expect(x.body.onAir).toBe(false);
      const o = r.client('/broadcast', { auth: { key: k.token } });
      expect((await o.ready).ok).toBe(true);
      expect(await o.request('bc:subscribe', { v: 1, channel: 'monthly', layout: '16x9', role: 'output' })).toEqual({ ok: false, code: 'wrong_event' });
      expect((await o.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '9x16', role: 'output' })).ok).toBe(true);
      expect((r.handle.health() as any).outputs).toBe(1);
      expect(r.handle.onAirView().channels.find((c) => c.channel === 'weekly')).toMatchObject({ onAir: true, source: 'output', since: expect.any(Number) });
      await new Promise((d) => setTimeout(d, 1050));                                       // past the 1 s memo
      x = fakeRes(); r.routes['GET /api/broadcast/on-air']({}, x);
      expect(x.body.onAir).toBe(true);
      o.close();
      await settle(200);
      expect(r.handle.onAirView().onAir).toBe(false);
    } finally { await r.close(); }
  });

  it('a key held by an entrant of the event → entrant (the key was minted before he registered)', async () => {
    const r = await broadcastRig();
    try {
      const mint = await owner(r);
      const k = await mint({ ev: `q:${r.w.qualId}`, scopes: ['output'], label: 'OBS' });
      r.w.qt.players.push({ playerId: 'user-owner', masterPlayerId: 'm-owner', localUserId: 1, playerName: 'Owner Person', phone: '', socketId: '' });
      const o = r.client('/broadcast', { auth: { key: k.token } });
      expect((await o.ready).ok).toBe(true);
      expect(await o.request('bc:subscribe', { v: 1, event: `q:${r.w.qualId}`, layout: '16x9' })).toEqual({ ok: false, code: 'entrant' });
    } finally { await r.close(); }
  });

  it('revoked or expired mid-session → bc:authExpired {code} and the socket is dropped at the next heartbeat', async () => {
    const r = await broadcastRig();
    try {
      const mint = await owner(r);
      const a = await mint({ ev: 'ch:weekly', scopes: ['output'], label: 'a' });
      const b = await mint({ ev: 'ch:weekly', scopes: ['output'], label: 'b', ttlHours: 1 });
      const ca = r.client('/broadcast', { auth: { key: a.token } });
      const cb = r.client('/broadcast', { auth: { key: b.token } });
      expect((await ca.ready).ok).toBe(true);
      expect((await cb.ready).ok).toBe(true);
      await r.handle.tokens.revoke(a.jti);
      r.handle.heartbeat();
      expect((await ca.next((p) => p.type === 2 && p.data[0] === 'bc:authExpired'))!.data[1]).toEqual({ code: 'revoked' });
      await settle();
      expect(ca.disconnected()).toBe(true);
      expect(cb.disconnected()).toBe(false);
      r.clock.t = Date.now() + 3_600_000 + 1000;
      r.handle.heartbeat();
      expect((await cb.next((p) => p.type === 2 && p.data[0] === 'bc:authExpired'))!.data[1]).toEqual({ code: 'expired' });
    } finally { await r.close(); }
  });
});

describe('S4 / R4 — staff who hold a key cannot enter the event (broadcast_staff_cannot_enter)', () => {
  it('staffHoldsKeyFor: a q: key for it, a ch: key of a channel showing it, the producer panel\'s ch:*; not another event; not after a revoke', async () => {
    const r = await broadcastRig();
    try {
      const sessions = new Map<string, Auth>([['s1', { userId: 1, username: 'owner', masterUserId: 'm-owner', isAdminClaim: true }]]);
      const h = issuer(r, sessions, new Set([1]));
      const target = { qualifierId: r.w.qualId, tournamentId: r.w.tid };
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(false);
      const m = await issue(h, fakeSocket('s1'), { ev: 'ch:monthly', scopes: ['output'], label: 'x' });
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(false);                       // the monthly channel shows nothing / another event
      const w = await issue(h, fakeSocket('s1'), { ev: 'ch:weekly', scopes: ['output'], label: 'x' });
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(true);
      await r.handle.tokens.revoke(w.jti);
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(false);
      const q = await issue(h, fakeSocket('s1'), { ev: `q:${r.w.qualId}`, scopes: ['output'], label: 'x' });
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(true);
      await r.handle.tokens.revoke(q.jti);
      // Review fix (F13): the panel's ch:* key bars him only while the panel is CONNECTED (and a
      // channel shows the event): a key left from opening the panel once does not.
      const pk = await issue(h, fakeSocket('s1'), PRODUCER);
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(false);
      const panel = r.client('/broadcast', { auth: { key: pk.token } });
      expect((await panel.ready).ok).toBe(true);
      expect(r.handle.staffHoldsKeyFor('m-owner', target)).toBe(true);
      expect(r.handle.staffHoldsKeyFor('m-somebody-else', target)).toBe(false);
      expect(m.ok).toBe(true);
    } finally { await r.close(); }
  });

  it('index.ts: isAdminClaim at oauthLogin + tokenLogin; broadcastIssueToken registered; the registration refusal sits before the qualification check and every credit / chip step', () => {
    expect(SRC).toContain("socket.on('broadcastIssueToken', (data: Record<string, unknown>, ack?: unknown) => broadcastIssueHandler.issue(socket, data, ack));");
    expect(SRC.match(/isAdminClaim: !!oauthResult\.isAdmin,/g)).toHaveLength(2);
    const at = SRC.indexOf("socket.on('registerQualifierTournament', async");
    expect(at).toBeGreaterThan(0);
    const reg = SRC.slice(at, SRC.indexOf("\n  socket.on('", at + 20));
    const refusal = reg.indexOf('broadcastFeed?.staffHoldsKeyFor(masterId, { qualifierId: qualId, tournamentId: qt.tournamentId })');
    expect(refusal).toBeGreaterThan(reg.indexOf('const [qualId, qt] = found;'));
    for (const later of ['isPlayerQualified(', 'deductChips(', 'consumeQualifierCreditOnMaster(', 'ensureChipsForBuyIn(']) {
      expect({ later, before: refusal < reg.indexOf(later) }).toEqual({ later, before: true });
    }
    expect(reg).toContain('refuseQualifier(BROADCAST_STAFF_CANNOT_ENTER,');
  });
});

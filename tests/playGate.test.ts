/**
 * 2026-10-07 — .online play gate: game suspensions + "no American Pub Poker
 * account, no play" (guest play off). See src/auth/playGate.ts.
 *
 * Pins:
 *   - the owner's exact sentences and the C5 wire codes poker-3d keys on;
 *   - no master id → login_required (guest / unauthenticated / unlinked);
 *   - suspended master id → player_suspended, from ANY attached identity;
 *   - master endpoint down / 404 / 401 / slow / garbage → FAIL OPEN (allowed),
 *     loudly logged, cached briefly so an outage can't add 4s to every join;
 *   - real answers cached ~60s per master id, concurrent lookups de-duplicated;
 *   - legacy sessions resolve the master id from the local row's TEXT stats;
 *   - guest `register` refusal shape.
 */

import {
  PLAYER_SUSPENDED_MESSAGE,
  LOGIN_REQUIRED_MESSAGE,
  createPlayStatusClient,
  createAssertPlayable,
  evaluatePlayable,
  resolveSessionMasterId,
  masterIdFromStats,
  resolveGuestPlayEnabled,
  guestRegisterRefusal,
  partitionSuspendedRegistrants,
  createLoginTracker,
  DEFAULT_LOGIN_WAIT_MS,
  seatRestoreAction,
  type GateSession,
  type PlayStatus,
  type LoginWaitOutcome,
} from '../src/auth/playGate';

const ROGER = 'df83fafd-e6ac-403d-8d26-9b01c2a1ee96';
const OTHER = '16899b30-fcc1-4be1-94f9-47f54cacf240';
const BASE = 'https://master.example/poker-api';
const TOKEN = 'internal-token-xyz';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A fake master /play-status endpoint. `suspended` is the set of suspended ids. */
function fakeMaster(suspended: Set<string>, opts: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = jest.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), headers: (init?.headers || {}) as Record<string, string> });
    if (opts.status && opts.status !== 200) return jsonResponse(opts.status, { success: false });
    if (opts.body !== undefined) return jsonResponse(200, opts.body);
    const m = /\/users\/([^/]+)\/play-status\/internal$/.exec(String(url));
    const id = m ? decodeURIComponent(m[1]) : '';
    const isSuspended = suspended.has(id);
    return jsonResponse(200, { success: true, suspended: isSuspended, message: isSuspended ? PLAYER_SUSPENDED_MESSAGE : null });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, mock: fetchImpl };
}

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createPlayStatusClient>[0]> = {}) {
  const logs: string[] = [];
  const c = createPlayStatusClient({
    baseUrl: () => BASE,
    token: () => TOKEN,
    fetchImpl,
    logError: (l) => logs.push(l),
    ...extra,
  });
  return { c, logs };
}

describe('owner wording + wire codes (contract C5) — do not paraphrase', () => {
  it('suspended sentence is verbatim', () => {
    expect(PLAYER_SUSPENDED_MESSAGE).toBe('You are suspended from playing any games with American Pub Poker.');
  });
  it('sign-in sentence is verbatim', () => {
    expect(LOGIN_REQUIRED_MESSAGE).toBe('Sign in with your American Pub Poker account to play.');
  });
  it('guest register refusal is guest_disabled with the sign-in sentence (registerResult shape)', () => {
    expect(guestRegisterRefusal()).toEqual({
      success: false,
      error: 'Sign in with your American Pub Poker account to play.',
      code: 'guest_disabled',
    });
  });
});

describe('createPlayStatusClient — the C4 lookup', () => {
  it('calls GET {base}/users/:id/play-status/internal with X-Internal-Token and reads suspended:true', async () => {
    const m = fakeMaster(new Set([ROGER]));
    const { c } = client(m.fetchImpl);
    const s = await c.getPlayStatus(ROGER);
    expect(s).toEqual({ suspended: true, failedOpen: false });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].url).toBe(`${BASE}/users/${ROGER}/play-status/internal`);
    expect(m.calls[0].headers['X-Internal-Token']).toBe(TOKEN);
  });

  it('an unsuspended (or unknown) user is not suspended', async () => {
    const m = fakeMaster(new Set([ROGER]));
    const { c } = client(m.fetchImpl);
    expect(await c.getPlayStatus(OTHER)).toEqual({ suspended: false, failedOpen: false });
  });

  it('caches a real answer for ~60s per master id, then re-asks', async () => {
    let t = 1_000_000;
    const m = fakeMaster(new Set([ROGER]));
    const { c } = client(m.fetchImpl, { now: () => t });
    await c.getPlayStatus(ROGER);
    t += 59_000;
    expect((await c.getPlayStatus(ROGER)).suspended).toBe(true);
    expect(m.calls).toHaveLength(1); // served from cache
    expect(c.counters().cacheHits).toBe(1);
    t += 2_000; // past 60s
    await c.getPlayStatus(ROGER);
    expect(m.calls).toHaveLength(2);
  });

  it('de-duplicates concurrent lookups for the same id (a burst of joins = one request)', async () => {
    const m = fakeMaster(new Set());
    const { c } = client(m.fetchImpl);
    const [a, b, d] = await Promise.all([c.getPlayStatus(OTHER), c.getPlayStatus(OTHER), c.getPlayStatus(OTHER)]);
    expect([a.suspended, b.suspended, d.suspended]).toEqual([false, false, false]);
    expect(m.calls).toHaveLength(1);
  });

  it('invalidate() forces a fresh lookup (e.g. right after a lift)', async () => {
    const m = fakeMaster(new Set([ROGER]));
    const { c } = client(m.fetchImpl);
    await c.getPlayStatus(ROGER);
    c.invalidate(ROGER);
    await c.getPlayStatus(ROGER);
    expect(m.calls).toHaveLength(2);
  });

  describe('FAIL OPEN — a broken check must never lock .online out', () => {
    it('network error → allowed, failedOpen, logged loudly', async () => {
      const fetchImpl = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const { c, logs } = client(fetchImpl);
      const s = await c.getPlayStatus(ROGER);
      expect(s).toEqual({ suspended: false, failedOpen: true, reason: 'network_error' });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('[play-gate]');
      expect(logs[0]).toContain('play_status_check_failed');
      expect(logs[0]).toContain('fail_open_allowed');
      expect(c.counters().failOpen).toBe(1);
      expect(c.counters().lastFailOpenReason).toBe('network_error');
    });

    it.each([404, 401, 500, 503])('HTTP %i → allowed (404 = route not deployed yet, 401 = token drift)', async (status) => {
      const m = fakeMaster(new Set([ROGER]), { status });
      const { c } = client(m.fetchImpl);
      const s = await c.getPlayStatus(ROGER);
      expect(s.suspended).toBe(false);
      expect(s.failedOpen).toBe(true);
      expect(s.reason).toBe(`http_${status}`);
    });

    it('a 200 without a boolean `suspended` is not trusted either way → allowed', async () => {
      const m = fakeMaster(new Set([ROGER]), { body: { success: true, suspended: 'yes' } });
      const { c } = client(m.fetchImpl);
      expect(await c.getPlayStatus(ROGER)).toEqual({ suspended: false, failedOpen: true, reason: 'bad_shape' });
    });

    it('slower than the timeout → aborted → allowed', async () => {
      const fetchImpl = jest.fn((_url: any, init?: any) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); (e as any).name = 'AbortError'; reject(e);
        });
      })) as unknown as typeof fetch;
      const { c } = client(fetchImpl, { timeoutMs: 20 });
      expect(await c.getPlayStatus(ROGER)).toEqual({ suspended: false, failedOpen: true, reason: 'timeout' });
    });

    it('no INTERNAL_NOTIFY_TOKEN → allowed without calling the master', async () => {
      const m = fakeMaster(new Set([ROGER]));
      const { c } = client(m.fetchImpl, { token: () => '' });
      expect(await c.getPlayStatus(ROGER)).toEqual({ suspended: false, failedOpen: true, reason: 'no_internal_token' });
      expect(m.calls).toHaveLength(0);
    });

    it('a fail-open answer is cached only briefly (15s), then the master is asked again', async () => {
      let t = 5_000_000;
      let down = true;
      const fetchImpl = jest.fn(async () => {
        if (down) throw new Error('down');
        return jsonResponse(200, { success: true, suspended: true, message: PLAYER_SUSPENDED_MESSAGE });
      }) as unknown as typeof fetch;
      const { c } = client(fetchImpl, { now: () => t });
      expect((await c.getPlayStatus(ROGER)).failedOpen).toBe(true);
      t += 10_000;
      expect((await c.getPlayStatus(ROGER)).failedOpen).toBe(true); // cached outage answer
      expect((fetchImpl as unknown as jest.Mock).mock.calls).toHaveLength(1);
      down = false;
      t += 6_000; // > 15s since the failure
      expect(await c.getPlayStatus(ROGER)).toEqual({ suspended: true, failedOpen: false });
      expect((fetchImpl as unknown as jest.Mock).mock.calls).toHaveLength(2);
    });
  });
});

describe('evaluatePlayable — the decision', () => {
  const statusOf = (suspended: Set<string>) => async (id: string): Promise<PlayStatus> =>
    ({ suspended: suspended.has(id), failedOpen: false });

  it('no master id at all → login_required (guest / unauthenticated / unlinked)', async () => {
    expect(await evaluatePlayable([], statusOf(new Set()))).toEqual({ code: 'login_required', message: LOGIN_REQUIRED_MESSAGE });
    expect(await evaluatePlayable([null, undefined, '', '  '], statusOf(new Set()))).toEqual({ code: 'login_required', message: LOGIN_REQUIRED_MESSAGE });
  });

  it('…unless the ONLINE_GUEST_PLAY_ENABLED emergency switch turned the account requirement off', async () => {
    expect(await evaluatePlayable([], statusOf(new Set()), { requireAccount: false })).toBeNull();
  });

  it('suspended master id → player_suspended with the owner sentence', async () => {
    expect(await evaluatePlayable([ROGER], statusOf(new Set([ROGER])))).toEqual({
      code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ROGER,
    });
  });

  it('the suspension wins even with guest play switched back on', async () => {
    const r = await evaluatePlayable([ROGER], statusOf(new Set([ROGER])), { requireAccount: false });
    expect(r?.code).toBe('player_suspended');
  });

  it('ANY attached identity suspended → refused (e.g. a ticket for a suspended account on a clean socket)', async () => {
    const r = await evaluatePlayable([OTHER, ROGER], statusOf(new Set([ROGER])));
    expect(r).toEqual({ code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ROGER });
  });

  it('a fail-open status lets the player through', async () => {
    const r = await evaluatePlayable([ROGER], async () => ({ suspended: false, failedOpen: true, reason: 'timeout' }));
    expect(r).toBeNull();
  });

  it('asks once per distinct id', async () => {
    const seen: string[] = [];
    await evaluatePlayable([OTHER, OTHER, ` ${OTHER} `], async (id) => { seen.push(id); return { suspended: false, failedOpen: false }; });
    expect(seen).toEqual([OTHER]);
  });
});

describe('resolveSessionMasterId — every session to a MASTER id', () => {
  it('no session (never signed in) → null', async () => {
    expect(await resolveSessionMasterId(undefined, async () => '{}')).toBeNull();
  });

  it('attested masterUserId (oauthLogin / tokenLogin-OIDC / authWithTicket) wins; stats are never read', async () => {
    const load = jest.fn(async () => JSON.stringify({ masterUserId: OTHER }));
    expect(await resolveSessionMasterId({ userId: 7, masterUserId: ROGER }, load)).toBe(ROGER);
    expect(load).not.toHaveBeenCalled();
  });

  it('legacy session: falls back to the local row\'s TEXT stats stamp and caches it on the session', async () => {
    const session: GateSession = { userId: 4693 };
    const load = jest.fn(async () => JSON.stringify({ masterUserId: ROGER, masterUsername: 'roger.auerbach2' }));
    expect(await resolveSessionMasterId(session, load)).toBe(ROGER);
    expect(session.statsMasterUserId).toBe(ROGER);
    expect(await resolveSessionMasterId(session, load)).toBe(ROGER);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a guest row (no stamp) resolves to null and the miss is cached too', async () => {
    const session: GateSession = { userId: 4203 };
    const load = jest.fn(async () => '{}');
    expect(await resolveSessionMasterId(session, load)).toBeNull();
    expect(session.statsMasterUserId).toBeNull();
    await resolveSessionMasterId(session, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a stamp captured at login (statsMasterUserId) is used without a DB read', async () => {
    const load = jest.fn(async () => '{}');
    expect(await resolveSessionMasterId({ userId: 1, statsMasterUserId: ROGER }, load)).toBe(ROGER);
    expect(await resolveSessionMasterId({ userId: 1, statsMasterUserId: null }, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('a DB error resolves to null (→ login_required) and is NOT cached, so the next try re-reads', async () => {
    const session: GateSession = { userId: 9 };
    const logs: string[] = [];
    const load = jest.fn()
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValueOnce(JSON.stringify({ masterUserId: ROGER }));
    expect(await resolveSessionMasterId(session, load, (l) => logs.push(l))).toBeNull();
    expect(session.statsMasterUserId).toBeUndefined();
    expect(logs[0]).toContain('master_id_lookup_failed');
    expect(await resolveSessionMasterId(session, load)).toBe(ROGER);
  });
});

describe('masterIdFromStats — prod users.stats is TEXT', () => {
  it('reads TEXT, jsonb objects, and tolerates junk', () => {
    expect(masterIdFromStats(JSON.stringify({ masterUserId: ROGER }))).toBe(ROGER);
    expect(masterIdFromStats({ masterUserId: ROGER })).toBe(ROGER);
    expect(masterIdFromStats('{}')).toBeNull();
    expect(masterIdFromStats('')).toBeNull();
    expect(masterIdFromStats(null)).toBeNull();
    expect(masterIdFromStats('{not json')).toBeNull();
    expect(masterIdFromStats(JSON.stringify({ masterUserId: '   ' }))).toBeNull();
  });
});

describe('createAssertPlayable — what every play-entry handler calls first', () => {
  function gate(opts: {
    sessions?: Record<string, GateSession>;
    stats?: Record<number, unknown>;
    suspended?: Set<string>;
    master?: ReturnType<typeof fakeMaster>;
    requireAccount?: boolean;
  }) {
    const master = opts.master || fakeMaster(opts.suspended || new Set());
    const { c } = client(master.fetchImpl);
    const refusals: Array<{ code: string; where: string; localUserId: number | null }> = [];
    const loadStats = jest.fn(async (userId: number) => (opts.stats || {})[userId] ?? '{}');
    const assertPlayable = createAssertPlayable({
      getSession: (sid) => (opts.sessions || {})[sid],
      loadStats,
      getPlayStatus: (id) => c.getPlayStatus(id),
      requireAccount: () => opts.requireAccount !== false,
      onRefusal: (r, ctx) => refusals.push({ code: r.code, where: ctx.where, localUserId: ctx.localUserId }),
      logError: () => {},
    });
    return { assertPlayable, master, refusals, loadStats, client: c };
  }

  it('unauthenticated socket (no session) → login_required, master never asked', async () => {
    const g = gate({});
    expect(await g.assertPlayable('sock-anon', 'joinTable')).toEqual({ code: 'login_required', message: LOGIN_REQUIRED_MESSAGE });
    expect(g.master.calls).toHaveLength(0);
    expect(g.refusals).toEqual([{ code: 'login_required', where: 'joinTable', localUserId: null }]);
  });

  it('legacy GUEST session (local row, no master stamp) → login_required', async () => {
    const g = gate({ sessions: { s1: { userId: 4203 } }, stats: { 4203: '{}' } });
    expect((await g.assertPlayable('s1', 'quickPlay'))?.code).toBe('login_required');
  });

  it('OIDC session for a suspended master id → player_suspended', async () => {
    const g = gate({ sessions: { s1: { userId: 4693, masterUserId: ROGER } }, suspended: new Set([ROGER]) });
    expect(await g.assertPlayable('s1', 'joinTable')).toEqual({
      code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ROGER,
    });
    expect(g.refusals[0]).toEqual({ code: 'player_suspended', where: 'joinTable', localUserId: 4693 });
  });

  it('legacy HS256 session whose row is stamped with a suspended id → player_suspended (stats fallback)', async () => {
    const g = gate({
      sessions: { s1: { userId: 4693 } },
      stats: { 4693: JSON.stringify({ masterUserId: ROGER, masterUsername: 'roger.auerbach2' }) },
      suspended: new Set([ROGER]),
    });
    expect((await g.assertPlayable('s1', 'rebuy'))?.code).toBe('player_suspended');
  });

  it('a clean account plays; the answer is cached across handlers (one master call)', async () => {
    const g = gate({ sessions: { s1: { userId: 1, masterUserId: OTHER } }, suspended: new Set([ROGER]) });
    expect(await g.assertPlayable('s1', 'joinClubTable')).toBeNull();
    expect(await g.assertPlayable('s1', 'joinTable')).toBeNull(); // joinClubTable re-dispatches here
    expect(g.master.calls).toHaveLength(1);
    expect(g.refusals).toHaveLength(0);
  });

  it('master endpoint DOWN → a signed-in player is allowed (fail-open)…', async () => {
    const down = jest.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const g = gate({ sessions: { s1: { userId: 4693, masterUserId: ROGER } }, master: { fetchImpl: down, calls: [], mock: down as any } });
    expect(await g.assertPlayable('s1', 'joinTable')).toBeNull();
    expect(g.client.counters().failOpen).toBe(1);
  });

  it('…but an outage never lets an account-less socket in', async () => {
    const down = jest.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const g = gate({ master: { fetchImpl: down, calls: [], mock: down as any } });
    expect((await g.assertPlayable('anon', 'joinTable'))?.code).toBe('login_required');
  });

  it('waitlist deep-link: the verified ticket id is checked even when the socket session is clean', async () => {
    const g = gate({ sessions: { s1: { userId: 1, masterUserId: OTHER } }, suspended: new Set([ROGER]) });
    const r = await g.assertPlayable('s1', 'joinWithWaitlistContext', [ROGER]);
    expect(r).toEqual({ code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ROGER });
  });

  it('waitlist deep-link with no prior session: the ticket id alone is an account', async () => {
    const g = gate({ suspended: new Set([ROGER]) });
    expect(await g.assertPlayable('fresh', 'joinWithWaitlistContext', [OTHER])).toBeNull();
  });

  it('emergency switch (requireAccount false): account-less allowed, suspended still refused', async () => {
    const g = gate({ sessions: { s1: { userId: 4693, masterUserId: ROGER } }, suspended: new Set([ROGER]), requireAccount: false });
    expect(await g.assertPlayable('anon', 'joinTable')).toBeNull();
    expect((await g.assertPlayable('s1', 'joinTable'))?.code).toBe('player_suspended');
  });
});

describe('createLoginTracker — logins in flight per socket', () => {
  it('nothing in flight → waitFor answers "none" at once', async () => {
    const t = createLoginTracker();
    expect(t.isPending('s1')).toBe(false);
    expect(await t.waitFor('s1', 5_000)).toBe('none');
  });

  it('begin/release marks and clears a socket; release is idempotent', async () => {
    const t = createLoginTracker();
    const release = t.begin('s1');
    expect(t.isPending('s1')).toBe(true);
    expect(t.size()).toBe(1);
    release();
    release();
    expect(t.isPending('s1')).toBe(false);
    expect(t.size()).toBe(0);
    expect(await t.waitFor('s1', 5_000)).toBe('none');
  });

  it('waitFor settles only when EVERY login in flight on that socket has finished', async () => {
    const t = createLoginTracker();
    const r1 = t.begin('s1');
    const r2 = t.begin('s1');
    let outcome: LoginWaitOutcome | null = null;
    const w = t.waitFor('s1', 5_000).then((o) => { outcome = o; });
    r1();
    await new Promise((r) => setTimeout(r, 10));
    expect(outcome).toBeNull(); // r2 still running
    r2();
    await w;
    expect(outcome).toBe('settled');
  });

  it('a login that never finishes is bounded: waitFor answers "timeout"', async () => {
    const t = createLoginTracker();
    t.begin('s1');
    const t0 = Date.now();
    expect(await t.waitFor('s1', 30)).toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('another socket\'s login never blocks this socket', async () => {
    const t = createLoginTracker();
    t.begin('other-socket');
    expect(await t.waitFor('s1', 5_000)).toBe('none');
  });

  it('the default bound stays under poker-3d\'s 8s join watchdog', () => {
    expect(DEFAULT_LOGIN_WAIT_MS).toBeLessThan(8_000);
    expect(DEFAULT_LOGIN_WAIT_MS).toBeGreaterThanOrEqual(3_000);
  });

  it('forget() (socket disconnected) drops a hung login\'s mark and settles its waiters at once', async () => {
    const t = createLoginTracker();
    const release = t.begin('s1'); // a login handler that never finishes
    t.begin('s2');
    const t0 = Date.now();
    const w = t.waitFor('s1', 5_000);
    t.forget('s1');
    expect(await w).toBe('settled');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(t.isPending('s1')).toBe(false);
    expect(t.size()).toBe(1); // s2 untouched
    expect(t.isPending('s2')).toBe(true);
    release(); // the hung handler finishing later is a harmless no-op
    expect(t.isPending('s1')).toBe(false);
    expect(t.size()).toBe(1);
    t.forget('never-seen'); // no-op
    expect(t.size()).toBe(1);
  });
});

describe('seatRestoreAction — what a login does with the seat it would restore', () => {
  it('may play → restore', () => {
    expect(seatRestoreAction(null)).toBe('restore');
    expect(seatRestoreAction(undefined)).toBe('restore');
  });

  it('suspended → stand_up (definitive: the seat is cashed out, he is told why)', () => {
    expect(seatRestoreAction({ code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ROGER })).toBe('stand_up');
  });

  it('no account behind THIS session → hold (not restored, not destroyed: a parallel/retried oauthLogin can still claim it)', () => {
    expect(seatRestoreAction({ code: 'login_required', message: LOGIN_REQUIRED_MESSAGE })).toBe('hold');
    expect(seatRestoreAction({ code: 'guest_disabled', message: LOGIN_REQUIRED_MESSAGE })).toBe('hold');
  });
});

/**
 * 2026-10-07 review finding (MAJOR, verified): after a reconnect the socket is
 * new and has no session until oauthLogin finishes. A play tap in that window
 * was refused login_required — a signed-in player told to sign in. These run
 * the gate CONCURRENTLY with a login that sets the session after a delay,
 * exactly as index.ts does (the login is registered with the tracker when its
 * event is dispatched, before the play event behind it).
 */
describe('reconnect race — the gate waits for a login in flight on the same socket', () => {
  function raceGate(opts: { suspended?: Set<string>; loginWaitMs?: number; stats?: Record<number, unknown> } = {}) {
    const sessions: Record<string, GateSession> = {};
    const tracker = createLoginTracker();
    const master = fakeMaster(opts.suspended || new Set());
    const { c } = client(master.fetchImpl);
    const waits: Array<{ outcome: LoginWaitOutcome; where: string; waitedMs: number; resolved: boolean }> = [];
    const deps = {
      getSession: (sid: string) => sessions[sid],
      loadStats: async (userId: number) => (opts.stats || {})[userId] ?? '{}',
      getPlayStatus: (id: string) => c.getPlayStatus(id),
      requireAccount: () => true,
      logError: () => {},
    };
    const assertPlayable = createAssertPlayable({
      ...deps,
      waitForLogin: (sid, ms) => tracker.waitFor(sid, ms),
      loginWaitMs: opts.loginWaitMs,
      onLoginWait: (outcome, ctx) => waits.push({ outcome, ...ctx }),
    });
    /** The pre-fix gate: same deps, no in-flight-login wait. */
    const assertPlayableNoWait = createAssertPlayable(deps);
    /** A login handler: registered at dispatch, sets the session after `delayMs` (or never, on failure). */
    function simulateLogin(sid: string, session: GateSession | null, delayMs: number): Promise<void> {
      const release = tracker.begin(sid);
      return new Promise<void>((resolve) => setTimeout(() => {
        if (session) sessions[sid] = session;
        release();
        resolve();
      }, delayMs));
    }
    return { assertPlayable, assertPlayableNoWait, simulateLogin, sessions, tracker, waits, master };
  }

  it('REPRO of the bug: without the wait, a tap racing oauthLogin is refused login_required', async () => {
    const g = raceGate();
    const login = g.simulateLogin('sock-new', { userId: 1, masterUserId: OTHER }, 50);
    expect((await g.assertPlayableNoWait('sock-new', 'quickPlay'))?.code).toBe('login_required');
    await login;
  });

  it('FIX: the same tap waits for the login and is allowed once the session lands', async () => {
    const g = raceGate();
    const login = g.simulateLogin('sock-new', { userId: 1, masterUserId: OTHER }, 50);
    const t0 = Date.now();
    const verdict = await g.assertPlayable('sock-new', 'quickPlay'); // concurrent with the login
    expect(verdict).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    await login;
    expect(g.waits).toEqual([expect.objectContaining({ outcome: 'settled', where: 'quickPlay', resolved: true })]);
  });

  it('several taps racing one login all wait and all pass; the master is asked once', async () => {
    const g = raceGate();
    const login = g.simulateLogin('sock-new', { userId: 1, masterUserId: OTHER }, 40);
    const verdicts = await Promise.all([
      g.assertPlayable('sock-new', 'joinTable'),
      g.assertPlayable('sock-new', 'rebuy'),
      g.assertPlayable('sock-new', 'registerTournament'),
    ]);
    expect(verdicts).toEqual([null, null, null]);
    expect(g.master.calls).toHaveLength(1);
    await login;
  });

  it('a SUSPENDED player racing his own login is still refused player_suspended (not let through by the wait)', async () => {
    const g = raceGate({ suspended: new Set([ROGER]) });
    const login = g.simulateLogin('sock-new', { userId: 4693, masterUserId: ROGER }, 30);
    expect(await g.assertPlayable('sock-new', 'joinTable')).toEqual({
      code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ROGER,
    });
    await login;
  });

  it('a login that FAILS (no session set) → login_required as soon as it finishes, not after the bound', async () => {
    const g = raceGate({ loginWaitMs: 5_000 });
    const login = g.simulateLogin('sock-new', null, 30);
    const t0 = Date.now();
    expect((await g.assertPlayable('sock-new', 'quickPlay'))?.code).toBe('login_required');
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(g.waits[0]).toMatchObject({ outcome: 'settled', resolved: false });
    await login;
  });

  it('a login slower than the bound → login_required at the bound (the client then re-auths and retries)', async () => {
    const g = raceGate({ loginWaitMs: 30 });
    const login = g.simulateLogin('sock-new', { userId: 1, masterUserId: OTHER }, 200);
    expect((await g.assertPlayable('sock-new', 'quickPlay'))?.code).toBe('login_required');
    expect(g.waits[0]).toMatchObject({ outcome: 'timeout', resolved: false });
    await login;
  });

  it('a legacy GUEST session signing in (oauthLogin in flight) waits and then plays as the account', async () => {
    const g = raceGate({ stats: { 4203: '{}' } });
    g.sessions['sock-1'] = { userId: 4203 }; // guest row, no master stamp
    const login = g.simulateLogin('sock-1', { userId: 1753, masterUserId: OTHER }, 30);
    expect(await g.assertPlayable('sock-1', 'quickPlay')).toBeNull();
    await login;
  });

  it('an account session never waits, even with another login in flight on the socket', async () => {
    const g = raceGate();
    g.sessions['sock-1'] = { userId: 1, masterUserId: OTHER };
    const login = g.simulateLogin('sock-1', { userId: 1, masterUserId: OTHER }, 200);
    const t0 = Date.now();
    expect(await g.assertPlayable('sock-1', 'joinTable')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(150);
    expect(g.waits).toHaveLength(0);
    await login;
  });

  it('no login in flight → login_required at once (a real guest is not slowed down)', async () => {
    const g = raceGate();
    const t0 = Date.now();
    expect((await g.assertPlayable('anon', 'quickPlay'))?.code).toBe('login_required');
    expect(Date.now() - t0).toBeLessThan(150);
    expect(g.waits).toHaveLength(0);
  });

  it('waitForLogin:false (the seat-restore gate, called from INSIDE a login) never waits on itself', async () => {
    const g = raceGate({ loginWaitMs: 5_000 });
    const login = g.simulateLogin('sock-1', null, 300);
    const t0 = Date.now();
    expect((await g.assertPlayable('sock-1', 'tokenLogin_legacy:seatRestore', [], { waitForLogin: false }))?.code).toBe('login_required');
    expect(Date.now() - t0).toBeLessThan(150);
    expect(g.waits).toHaveLength(0);
    await login;
  });
});

describe('guest play switch', () => {
  it('is OFF unless explicitly enabled', () => {
    expect(resolveGuestPlayEnabled(undefined)).toBe(false);
    expect(resolveGuestPlayEnabled('')).toBe(false);
    expect(resolveGuestPlayEnabled('0')).toBe(false);
    expect(resolveGuestPlayEnabled('yes')).toBe(false);
    expect(resolveGuestPlayEnabled('1')).toBe(true);
    expect(resolveGuestPlayEnabled(' TRUE ')).toBe(true);
  });
});

describe('partitionSuspendedRegistrants — qualifier pre-start screen', () => {
  it('drops only suspended registrants; registrants without a master id are kept', async () => {
    const players = [
      { playerId: 'a', masterPlayerId: OTHER },
      { playerId: 'roger', masterPlayerId: ROGER },
      { playerId: 'legacy' },
    ];
    const { keep, suspended } = await partitionSuspendedRegistrants(players, async (id) => ({ suspended: id === ROGER, failedOpen: false }));
    expect(keep.map((p) => p.playerId)).toEqual(['a', 'legacy']);
    expect(suspended.map((p) => p.playerId)).toEqual(['roger']);
  });

  it('master down → nobody is removed', async () => {
    const players = [{ playerId: 'roger', masterPlayerId: ROGER }];
    const { keep, suspended } = await partitionSuspendedRegistrants(players, async () => ({ suspended: false, failedOpen: true, reason: 'timeout' }));
    expect(keep).toHaveLength(1);
    expect(suspended).toHaveLength(0);
  });
});

/**
 * STRUCTURAL GUARD. index.ts boots the whole server on import, so the handlers
 * can't be driven from a unit test. Instead, scan the source: in every
 * play-entry handler, `assertPlayable(socket, '<handler>'` must appear BEFORE
 * the handler's first side effect (leaving a table, standing up an AI, a
 * buy-in, a seat, a credit consume, a club mutation). This is the ordering
 * defect the old joinTable ban check had (it ran after the AI stand-up), and
 * the exact regression a future "small refactor" would reintroduce.
 */
describe('index.ts — every play-entry handler is gated before its first side effect', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const src: string = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  const SIDE_EFFECTS = [
    'handlePlayerLeave(', 'deductChips(', 'ensureChipsForBuyIn(', '.sitDown(', '.standUp(',
    'registerPlayer(', 'consumeQualifierCreditOnMaster(', 'acceptChallenge(', 'createChallenge(',
    'registerForClubTournament(', 'createQuickTable(', 'tableManager.createTable(', 'spectators.delete(',
    'getClubTableById(', 'qt.players.push(',
  ];

  /** Body of the handler registered for `event`, up to the next registration. */
  function handlerBody(event: string): string {
    const starts = [`socket.on('${event}'`, `    '${event}',\n`];
    let at = -1;
    for (const s of starts) { at = src.indexOf(s); if (at >= 0) break; }
    if (at < 0) throw new Error(`handler for '${event}' not found in src/index.ts`);
    const rest = src.slice(at + 10);
    const next = rest.search(/\n  socket\.on\(/);
    const raw = src.slice(at, at + 10 + (next >= 0 ? next : rest.length));
    // Ignore // comments so prose naming a call cannot satisfy or trip the scan.
    // (`[^:]` keeps `https://` inside string literals intact.)
    return raw.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  }

  const GATED = [
    'joinTable', 'quickPlay', 'quickHeadsUp', 'quickSpinGo', 'quickAllInOrFold', 'startCareerGame',
    'joinAdditionalTable', 'joinByInviteCode', 'registerTournament', 'rebuy', 'joinClubTable',
    'registerClubTournament', 'createClubChallenge', 'acceptClubChallenge', 'registerQualifierTournament',
    'joinWithWaitlistContext',
  ];

  it.each(GATED)('%s calls assertPlayable before any side effect', (event) => {
    const body = handlerBody(event);
    const gateAt = body.indexOf(`assertPlayable(socket, '${event}'`);
    expect(gateAt).toBeGreaterThan(-1);
    for (const fx of SIDE_EFFECTS) {
      const fxAt = body.indexOf(fx);
      if (fxAt >= 0) expect({ event, fx, before: gateAt < fxAt }).toEqual({ event, fx, before: true });
    }
  });

  it('joinByInviteCode refuses on joinError (CreateTableModal waits on it), not error', () => {
    const body = handlerBody('joinByInviteCode');
    expect(body).toMatch(/if \(icGate\) \{ socket\.emit\('joinError', \{ message: icGate\.message, code: icGate\.code \}\)/);
  });

  it('registerQualifierTournament refuses on qualifierRegistrationResult with the code', () => {
    const body = handlerBody('registerQualifierTournament');
    expect(body).toMatch(/socket\.emit\('qualifierRegistrationResult', \{ success: false, error: qGate\.message, code: qGate\.code/);
  });

  it('guest register is refused before any local row is created', () => {
    const body = handlerBody('register');
    const refuseAt = body.indexOf('guestRegisterRefusal()');
    const createAt = body.indexOf('registerUser(');
    expect(refuseAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(refuseAt);
    expect(body).toContain("socket.emit('registerResult', guestRegisterRefusal())");
  });

  it('spectating stays ungated', () => {
    for (const event of ['spectate', 'spectateTournament', 'spectateNextTable']) {
      expect(handlerBody(event)).not.toContain('assertPlayable(');
    }
  });

  // ── 2026-10-07 review fixes ────────────────────────────────────────────
  it.each(['login', 'oauthLogin', 'tokenLogin', 'authWithTicket'])(
    '%s is registered through trackLogin (the gate can wait for it)',
    (event) => {
      const re = new RegExp(`socket\\.on\\(\\s*'${event}',\\s*trackLogin\\(socket, '${event}', async \\(`);
      expect(src).toMatch(re);
    },
  );

  it('the waitlist auth bootstrap is tracked as a login, begun AFTER the gate and released in finally', () => {
    const body = handlerBody('joinWithWaitlistContext');
    const gateAt = body.indexOf("assertPlayable(socket, 'joinWithWaitlistContext'");
    const beginAt = body.indexOf('const releaseWlBootstrap = loginTracker.begin(socket.id);');
    const bootstrapAt = body.indexOf('authSessions.set(socket.id');
    const releaseAt = body.indexOf('releaseWlBootstrap();');
    expect(gateAt).toBeGreaterThan(-1);
    expect(beginAt).toBeGreaterThan(gateAt);
    expect(bootstrapAt).toBeGreaterThan(beginAt);
    expect(releaseAt).toBeGreaterThan(bootstrapAt);
    expect(body.slice(bootstrapAt, releaseAt)).toContain('} finally {');
  });

  /** Every seat restore (`playerSessions.set(socket.id, …)`) is preceded by its own seat-restore gate. */
  function expectRestoresGated(event: string, expectedRestores: number) {
    const body = handlerBody(event);
    const all = (needle: string) => {
      const at: number[] = [];
      for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) at.push(i);
      return at;
    };
    const restores = all('playerSessions.set(socket.id');
    const gates = all('await refuseSeatRestoreIfBarred(socket, userId,');
    expect(restores).toHaveLength(expectedRestores);
    expect(gates).toHaveLength(expectedRestores);
    gates.forEach((g, i) => {
      expect(g).toBeLessThan(restores[i]);
      if (i > 0) expect(g).toBeGreaterThan(restores[i - 1]);
    });
    return body;
  }

  /**
   * A refusal must SKIP the restore by itself — not only through the
   * reservation the stand-up path deletes. The 'hold' path (no account behind
   * the session) deliberately keeps the reservation, so a restore guarded only
   * by `reserved && reserved.expiresAt > …` would put the player straight back.
   */
  function expectRestoreSkippedOnRefusal(body: string, refusalVar: string, gateCall: string) {
    const gateAt = body.indexOf(` ${refusalVar} = await refuseSeatRestoreIfBarred(socket, userId, ${gateCall}`);
    const guard = `if (!${refusalVar} && reserved && reserved.expiresAt > Date.now()) {`;
    const guardAt = body.indexOf(guard);
    expect({ refusalVar, gate: gateAt > -1 }).toEqual({ refusalVar, gate: true });
    expect({ refusalVar, guard: guardAt > gateAt }).toEqual({ refusalVar, guard: true });
    const restoreAt = body.indexOf('playerSessions.set(socket.id', guardAt);
    expect(restoreAt).toBeGreaterThan(guardAt);
  }

  it('oauthLogin: the seat-restore gate runs before the restore; the refusal is sent after loginResult', () => {
    const body = expectRestoresGated('oauthLogin', 1);
    expectRestoreSkippedOnRefusal(body, 'seatRestoreRefusal', "localUser.username, 'oauthLogin')");
    const loginResultAt = body.indexOf("socket.emit('loginResult', {\n        success: true,");
    const refusalAt = body.indexOf('if (seatRestoreRefusal) emitPlayRefusal(socket, seatRestoreRefusal);');
    expect(loginResultAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(loginResultAt);
  });

  it('tokenLogin (OIDC branch + legacy HS256 branch): each restore is gated; refusals follow loginResult', () => {
    const body = expectRestoresGated('tokenLogin', 2);
    expectRestoreSkippedOnRefusal(body, 'tlSeatRestoreRefusal', "_tlLocalUser.username, 'tokenLogin')");
    expectRestoreSkippedOnRefusal(body, 'legacySeatRestoreRefusal', "result.userData.username, 'tokenLogin_legacy')");
    const oidcResultAt = body.indexOf("success: true, token: data.token, userData: progress.userData,");
    const oidcRefusalAt = body.indexOf('if (tlSeatRestoreRefusal) emitPlayRefusal(socket, tlSeatRestoreRefusal);');
    expect(oidcRefusalAt).toBeGreaterThan(oidcResultAt);
    const legacyResultAt = body.indexOf("socket.emit('loginResult', { ...result,");
    const legacyRefusalAt = body.indexOf('if (legacySeatRestoreRefusal) emitPlayRefusal(socket, legacySeatRestoreRefusal);');
    expect(legacyRefusalAt).toBeGreaterThan(legacyResultAt);
  });

  it('seat-restore gate: suspended → stood up; no account → HELD (returns before any teardown)', () => {
    const at = src.indexOf('async function refuseSeatRestoreIfBarred(');
    const fn = src.slice(at, src.indexOf('\n}\n', at));
    expect(fn).toContain('const action = seatRestoreAction(refusal);');
    const holdAt = fn.indexOf("if (action === 'hold') {");
    const holdEnd = fn.indexOf('return refusal;', holdAt);
    expect(holdAt).toBeGreaterThan(-1);
    expect(holdEnd).toBeGreaterThan(holdAt);
    const hold = fn.slice(holdAt, holdEnd);
    // The hold branch destroys nothing: no leave, no stand-up, no timer clear.
    for (const fx of ['handlePlayerLeave(', 'standUpRefusedSeat(', 'clearTimeout(', '.standUp(']) {
      expect({ fx, inHold: hold.includes(fx) }).toEqual({ fx, inHold: false });
    }
    expect(hold).toContain("event: 'seat_restore_held'");
    // …and only a SYNTHETIC reservation (no cleanupTimer) is dropped from the map.
    expect(hold).toContain('if (!held.cleanupTimer) reservedSeats.delete(userId);');
    // The stand-up teardown is AFTER the hold branch.
    const teardownAt = fn.indexOf('if (own) handlePlayerLeave(socket);');
    expect(teardownAt).toBeGreaterThan(holdEnd);
    expect(fn.indexOf('standUpRefusedSeat(userId, username, reserved.tableId, reserved.seatIndex')).toBeGreaterThan(holdEnd);
  });

  it('disconnect drops the socket\'s in-flight login marks', () => {
    const body = handlerBody('disconnect');
    expect(body).toContain('loginTracker.forget(socket.id);');
  });

  it('the seat-restore gate never waits on the in-flight login it is called from', () => {
    const at = src.indexOf('async function refuseSeatRestoreIfBarred(');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('\n}\n', at));
    expect(fn).toContain("assertPlayable(socket, `${via}:seatRestore`, [], { waitForLogin: false })");
  });

  it('password `login`: identifies the player by the master-attested id and never puts it on the wire', () => {
    const body = handlerBody('login');
    expect(body).toContain('const { attestedMasterUserId, ...wireResult } = result;');
    expect(body).toContain('statsMasterUserId: attestedMasterUserId || masterIdFromStats(result.userData.stats)');
    expect(body).toContain("socket.emit('loginResult', wireResult);");
    expect(body).not.toContain("socket.emit('loginResult', result)");
  });
});

describe('circuit breaker (review R2: a slow master must not stall every join)', () => {
  it('after 3 transport failures it fails open at once, then recovers after the open window', async () => {
    let t = 1_000_000;
    let calls = 0;
    let healthy = false;
    const fetchImpl = (async (url: string) => {
      calls++;
      if (!healthy) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { ok: true, status: 200, json: async () => ({ success: true, suspended: false, message: null }) } as any;
    }) as unknown as typeof fetch;
    const { c } = client(fetchImpl, { now: () => t, failOpenTtlMs: 0 });
    for (const id of ['a', 'b', 'c']) {
      const s = await c.getPlayStatus(id);
      expect(s).toMatchObject({ suspended: false, failedOpen: true, reason: 'timeout' });
    }
    expect(calls).toBe(3);
    t += 1;
    const open = await c.getPlayStatus('d');
    expect(open).toMatchObject({ suspended: false, failedOpen: true, reason: 'circuit_open' });
    expect(calls).toBe(3); // no request made while open
    t += 30_001;
    healthy = true;
    const back = await c.getPlayStatus('e');
    expect(back).toEqual({ suspended: false, failedOpen: false });
    expect(calls).toBe(4);
  });

  it('HTTP 4xx (e.g. route not deployed yet) does not trip the breaker', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return { ok: false, status: 404, json: async () => ({}) } as any; }) as unknown as typeof fetch;
    const { c } = client(fetchImpl, { failOpenTtlMs: 0 });
    for (const id of ['a', 'b', 'c', 'd']) await c.getPlayStatus(id);
    expect(calls).toBe(4);
  });
});

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
  findSuspendedRegistrants,
  removeSuspendedRegistrants,
  cancelIfTooFewEligibleAfterScreen,
  MIN_ELIGIBLE_TO_START,
  planHandStartGate,
  HAND_GATE_MAX_STATUS_AGE_MS,
  type PlayStatusPeek,
  type GateSession,
  type PlayStatus,
  type LoginWaitOutcome,
} from '../src/auth/playGate';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';

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
    // 2026-10-09 side features (staking, wagers, entry codes, home games).
    'createVariantTable(', 'placeMarketBet(', 'addBracketSideBet(', 'UPDATE online_entry_codes',
    'INSERT INTO staking_offers', 'getPool().connect()',
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
    // 2026-10-09 — side features a suspended player could still use.
    'createStake', 'buyStake', 'placePredictionBet', 'placeSocialSideBet', 'redeemEntryCode',
    'createPrivateTable',
    // 2026-10-10 (S2) — the lobby's Return to tournament puts a player back on his absent seat.
    'returnToTournamentSeat',
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
  // 2026-10-11 (AUTH-8): the password `login` handler is removed (see below).
  it.each(['oauthLogin', 'tokenLogin', 'authWithTicket', 'resumeSession'])(
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
    // 2026-10-21 (gameplay S6) — every sign-in restores through the ONE shared
    // restoreSeatReservation (its playerSessions.set lives there).
    const restores = all('restoreSeatReservation(socket, userId,');
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
    // 2026-10-21 (gameplay S6) — the restore is the shared restoreSeatReservation,
    // called only inside `if (!<refusal>) {` (nothing else in between).
    const guard = `if (!${refusalVar}) {`;
    const guardAt = body.indexOf(guard, gateAt);
    expect({ refusalVar, gate: gateAt > -1 }).toEqual({ refusalVar, gate: true });
    expect({ refusalVar, guard: guardAt > gateAt }).toEqual({ refusalVar, guard: true });
    const restoreAt = body.indexOf('restoreSeatReservation(socket, userId,', guardAt);
    expect(restoreAt).toBeGreaterThan(guardAt);
    expect(body.slice(guardAt + guard.length, restoreAt)).toMatch(/^\s*(const restore = |\w+ = )?$/);
    // S2 fixed protocol (P-b, 2026-10-10): a VOLUNTARY tournament reservation is never restored by a sign-in.
    const shared = fnBody('function restoreSeatReservation(');
    expect(shared).toContain("if (!reserved || reserved.voluntary || !(reserved.expiresAt > Date.now())) return { outcome: 'none' };");
  }

  it('oauthLogin: the seat-restore gate runs before the restore; the refusal is sent after loginResult', () => {
    const body = expectRestoresGated('oauthLogin', 1);
    expectRestoreSkippedOnRefusal(body, 'seatRestoreRefusal', "localUser.username, 'oauthLogin', oauthSession)");   // Q3: + the login's own session
    const loginResultAt = body.indexOf("socket.emit('loginResult', {\n        success: true,");
    const refusalAt = body.indexOf('if (seatRestoreRefusal) emitPlayRefusal(socket, seatRestoreRefusal);');
    expect(loginResultAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(loginResultAt);
  });

  it('tokenLogin (OIDC branch + legacy HS256 branch): each restore is gated; refusals follow loginResult', () => {
    const body = expectRestoresGated('tokenLogin', 2);
    expectRestoreSkippedOnRefusal(body, 'tlSeatRestoreRefusal', "_tlLocalUser.username, 'tokenLogin', tlSession)");
    expectRestoreSkippedOnRefusal(body, 'legacySeatRestoreRefusal', "result.userData.username, 'tokenLogin_legacy', legacySession)");
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
    // S2 fixed protocol: a suspended player's own tournament seat is kept absent NON-voluntarily ('kept').
    const teardownAt = fn.indexOf("if (own) handlePlayerLeave(socket, 'kept');");
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

  it('AUTH-8 (2026-10-11): the socket password `login` handler and its local-bcrypt fallback are GONE', () => {
    expect(src).not.toMatch(/socket\.on\(\s*'login'/);
    expect(src).not.toContain('loginUserAsync');
    const am = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'authManager.ts'), 'utf8');
    for (const gone of ['loginUserAsync', 'syncMasterUser', 'authenticateWithMasterAPI', 'compareSync', 'checkLoginRateLimit']) {
      expect({ gone, present: am.includes(gone + '(') }).toEqual({ gone, present: false });
    }
    // No admin seed from ADMIN_PASSWORD, no hardcoded ADMIN_PHONE default.
    expect(am).not.toMatch(/ADMIN_PHONE \|\| '\d/);
    expect(am).not.toContain('INSERT INTO users (username, password_hash, is_admin)');
    expect(src).not.toMatch(/ADMIN_PHONE \|\| '\d/);
  });

  // ── 2026-10-09 "Fix all of it" ─────────────────────────────────────────
  /** A top-level function's body (up to the first line that is just `}`). */
  function fnBody(signature: string): string {
    const at = src.indexOf(signature);
    if (at < 0) throw new Error(`${signature} not found in src/index.ts`);
    return src.slice(at, src.indexOf('\n}\n', at));
  }

  it.each([
    ['createStake', 'if (csGate) { emitPlayRefusal(socket, csGate); return; }'],
    ['buyStake', 'if (bsGate) { replyBuyStake({ success: false, error: bsGate.message, code: bsGate.code }); return; }'],
    ['placePredictionBet', "if (pbGate) { socket.emit('predictionError', { message: pbGate.message, code: pbGate.code }); return; }"],
    ['placeSocialSideBet', "if (sbGate) { socket.emit('socialBracketError', { message: sbGate.message, code: sbGate.code }); return; }"],
    ['redeemEntryCode', "if (rcGate) { socket.emit('redeemEntryCodeResult', { success: false, error: rcGate.message, code: rcGate.code }); return; }"],
    ['createPrivateTable', 'if (ptGate) { emitPlayRefusal(socket, ptGate); return; }'],
  ])('(C) %s refuses on the channel its client already listens to', (event, line) => {
    expect(handlerBody(event)).toContain(line);
  });

  it('(C) buyStake never pays a SUSPENDED seller — checked before any chip moves, answered as unavailable', () => {
    const body = handlerBody('buyStake');
    const sellerAt = body.indexOf('if (await stakingSellerSuspended(Number(offer.sellerId))) {');
    const txAt = body.indexOf('getPool().connect()');
    expect(sellerAt).toBeGreaterThan(-1);
    expect(txAt).toBeGreaterThan(sellerAt);
    expect(body.slice(sellerAt, txAt)).toContain("error: 'Offer unavailable'");
  });

  it('(C) the free spectator pick (placePrediction) stays ungated — spectating is never gated', () => {
    expect(handlerBody('placePrediction')).not.toContain('assertPlayable(');
  });

  it('(C) every free-chip tournament start goes through the suspension screen', () => {
    const reg = handlerBody('registerTournament');
    expect(reg).toContain("void screenAndStartTournament(data.tournamentId, 'register');");
    expect(reg).not.toMatch(/\bstartTournamentGame\(/);
    expect(src).toContain("void screenAndStartTournament(id, 'timed');");
    // The only direct callers left are inside the screen (the normal start
    // and its fail-open fallback) — plus the definition itself.
    const screen = fnBody('async function screenAndStartTournament(');
    expect(screen.split('startTournamentGame(').length - 1).toBe(2);
    expect(src.split('startTournamentGame(').length - 1).toBe(3);
    expect(screen).toContain('findSuspendedRegistrants(');
    expect(screen).toContain("reason: 'suspended_at_start'");
    // Silent (owner rule): nothing is pushed to the removed registrant.
    expect(screen).not.toContain(PLAYER_SUSPENDED_MESSAGE);
    expect(screen).not.toContain('PLAYER_SUSPENDED_MESSAGE');
  });

  it('(C) the hand loop: beforeHandStart → cached-status stand-up, never awaiting the master', () => {
    const listener = src.slice(src.indexOf('function ensureTableProgressListener('), src.indexOf('function ensureTableProgressListener(') + 1200);
    expect(listener).toContain("table.on('beforeHandStart', () => {");
    expect(listener).toContain('standUpSuspendedSeatsBeforeDeal(table, tableId);');
    const gate = fnBody('function standUpSuspendedSeatsBeforeDeal(');
    expect(gate).toContain('if (table.isHandInProgress()) return;');
    expect(gate).toContain('playStatusClient.peek(id, HAND_GATE_MAX_STATUS_AGE_MS)');
    expect(gate).not.toMatch(/\bawait\b/);
    const su = fnBody('function standUpSuspendedSeat(');
    // Tournament seats: disqualified (eliminated, no prize) BEFORE any leave —
    // a stood-up-but-alive entrant would stop the tournament from finishing.
    // S4: ALL of this boundary's suspended entrants in ONE batch
    // (disqualifyPlayers flags every one before eliminating any), before the
    // first stand-up — so a finish mid-batch can never pay one of them.
    const dqAt = gate.indexOf('tournamentManager.disqualifyPlayers(tournamentIdForGate, targets.map(');
    const standUpLoopAt = gate.indexOf('standUpSuspendedSeat(table, tableId, seatIndex, owners.get(seatIndex)!, masterId, disqualifiedSeats.get(seatIndex) === true);');
    expect(dqAt).toBeGreaterThan(-1);
    expect(standUpLoopAt).toBeGreaterThan(dqAt);
    expect(su).not.toContain('disqualifyPlayer');
    const leaveAt = su.indexOf("handlePlayerLeave(sock!, 'kept')");   // S2 fixed protocol: never a voluntary keep
    expect(leaveAt).toBeGreaterThan(-1);
    // Extra-table seats are detached for the main-seat leave, then put back.
    expect(su).toContain('if (multi) multiTableSessions.delete(owner.socketId);');
    expect(su).toContain('if (multi) multiTableSessions.set(owner.socketId, multi);');
    expect(su).toContain("sock?.emit('error', { message: PLAYER_SUSPENDED_MESSAGE, code: 'player_suspended', tableId });");
    // Spectating stays allowed: after the main-seat leave he is put back in
    // the room as a SPECTATOR (same steps as the `spectate` handler), so his
    // client flips to spectator chrome instead of freezing on a seated view.
    const specAt = su.indexOf('spectators.get(tableId)!.add(sock.id);');
    expect(specAt).toBeGreaterThan(leaveAt);
    expect(su).toContain('(spectatorState as any).isSpectator = true;');
    expect(su).toContain("sock.emit('spectating', { tableId, tableName: stillThere.config.tableName });");
  });

  it('(B/D1) ONLY authWithTicket and the waitlist bootstrap issue a resume token — never oauthLogin / tokenLogin / login, never an is_admin row', () => {
    expect(handlerBody('authWithTicket')).toContain(
      '...resumeFieldsFor(localUser.id, String(remoteUserId), localUser.token_version, {\n            isAdmin: !!localUser.is_admin, phone: String(phone),\n          }),',
    );
    // Waitlist: only for the session the bootstrap itself created (a
    // pre-existing OIDC session on the socket has its own refresh flow).
    const wl = handlerBody('joinWithWaitlistContext');
    expect(wl).toContain('...(wlBootstrapSession && seatedAuth === wlBootstrapSession');
    expect(wl).toContain('? resumeFieldsFor(lu.id, wlBootstrapSession.masterUserId, lu.token_version, { isAdmin: !!lu.is_admin })');
    expect(wl).toContain('wlBootstrapSession = { userId: wlRow.id, username: wlRow.username, masterUserId: String(remoteUserId), displayName: wlRow.display_name || wlRow.username };');
    // OIDC logins and the password login issue NONE.
    for (const ev of ['oauthLogin', 'tokenLogin']) expect(handlerBody(ev)).not.toContain('resumeFieldsFor(');
    // The only call sites in the file: the two issuers + the resume refresh
    // (+ the definition) — and every call states isAdmin.
    expect(src.split('resumeFieldsFor(').length - 1).toBe(4);
    const fn = fnBody('function resumeFieldsFor(');
    expect(fn).toContain('opts: { isAdmin: boolean; origIat?: number; phone?: string | null },');
    expect(fn).toContain('if (opts.isAdmin) { resumeStats.adminRowsSkipped++; return {}; }');
  });

  it('(D3) EVERY buyStakeResult frame echoes the request offerId (one emit site: the helper)', () => {
    const body = handlerBody('buyStake');
    expect(body.split("socket.emit('buyStakeResult'").length - 1).toBe(1);
    expect(body).toContain("socket.emit('buyStakeResult', { ...frame, ...(bsOfferId ? { offerId: bsOfferId } : {}) });");
    // The helper is defined BEFORE the gate, so the play-gate refusal carries it too.
    expect(body.indexOf('const replyBuyStake = ')).toBeLessThan(body.indexOf("await assertPlayable(socket, 'buyStake')"));
    // success + every failure go through it.
    expect(body).toContain('replyBuyStake({ success: true });');
    expect(body.split('replyBuyStake({ success: false').length - 1).toBeGreaterThanOrEqual(9);
  });

  it('(D4) saveProgress: the client may write ONLY stats.clientData — level / xp / achievements / chips never reach the DB', () => {
    const body = handlerBody('saveProgress');
    expect(body).toContain('const { data: progressData, dropped } = sanitizeClientProgressSave(data);');
    expect(body).toContain('const success = await saveProgress(auth.userId, progressData);');
    expect(body).not.toMatch(/\.\.\.progressData\s*}\s*=\s*data/);
    expect(body.split('saveProgress(auth.userId').length - 1).toBe(1);
  });

  it('(D5) the tournament start screen removes + refunds through removeSuspendedRegistrants (live re-read, single refund)', () => {
    const screen = fnBody('async function screenAndStartTournament(');
    expect(screen).toContain('await removeSuspendedRegistrants(');
    expect(screen).not.toContain('tournamentManager.unregisterPlayer(');
    expect(screen).not.toContain('tournamentManager.refundEntryFee(');
  });

  it('(S4) the start screen cancels + refunds (existing cancel path) when its removals leave < 2 eligible — before any start, with no await in between', () => {
    const screen = fnBody('async function screenAndStartTournament(');
    const removeAt = screen.indexOf('await removeSuspendedRegistrants(');
    const cancelAt = screen.indexOf('const cancelled = cancelIfTooFewEligibleAfterScreen(tournamentManager, tournamentId, removed.length);');
    const refundAt = screen.indexOf("refundCancelledTournamentEntrants(tournamentId, cancelled, 'cancelled_too_few_eligible_at_start');");
    const startAt = screen.indexOf('if (tournamentManager.canStart(tournamentId)) startTournamentGame(tournamentId);');
    expect(removeAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(removeAt);
    expect(refundAt).toBeGreaterThan(cancelAt);
    expect(startAt).toBeGreaterThan(refundAt);
    // No await between the removal and the cancel decision.
    expect(screen.slice(screen.indexOf(';', removeAt) + 1, cancelAt)).not.toMatch(/\bawait\b/);
    // ONE refund path for a cancelled tournament: the stall sweep uses it too,
    // and it credits additively + audits every entrant.
    const sweepAt = src.indexOf('for (const id of tournamentManager.checkStalledTournaments()) {');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(src.slice(sweepAt, sweepAt + 400)).toContain("refundCancelledTournamentEntrants(id, registrants, 'tournament_cancelled_stalled');");
    const refundFn = fnBody('function refundCancelledTournamentEntrants(');
    // R3 (TOURNEY-P3-3) — through the prize ledger now (idempotent key per tournament + entrant, retried);
    // every entrant still audited (refunded, or FAILED while the ledger retries it).
    expect(refundFn).toContain('void prizeLedger.settle({ label: `tfee:${tournamentId}`, credits })');
    expect(refundFn).toContain('key: `tfee:${tournamentId}:${r.playerId}`');
    expect(refundFn).toContain("tournamentFeeAudit('TOURNAMENT_ENTRY_REFUND', { login: loginOf(c.userId), userId: c.userId, tournamentId, entryFee: c.amount, amount: c.amount, reason });");
    expect(refundFn).toContain("'TOURNAMENT_ENTRY_REFUND_FAILED'");
  });

  it('(B/D1) resumeSession: seat restored by LOCAL userId only (no display-name scan); session phone + orig_iat carried from the token', () => {
    const body = handlerBody('resumeSession');
    expect(body).not.toContain('recoverName');
    expect(body).not.toContain('seat.playerName');
    // 2026-10-21 (gameplay S6) — through the shared restore, by the LOCAL userId, ghost clearing on.
    expect(body).toContain("restoreSeatReservation(socket, userId, 'resumeSession', { clearGhosts: true })");
    const shared = fnBody('function restoreSeatReservation(');
    expect(shared).toContain('const reserved = reservedSeats.get(userId);');
    expect(body).toContain('...(claims.phone ? { phone: claims.phone } : {}),');
    expect(body).toContain('isAdmin: !!row.is_admin, origIat: claims.orig_iat, phone: claims.phone,');
    // The ghost clearing around the restore is account-only — and since AUTH-3
    // (2026-10-11) for EVERY caller: the display-name step is gone.
    expect(shared).toContain('if (opts.clearGhosts) clearGhostSeatsForUser(userId, reserved.tableId, socket.id, reserved.seatIndex);');
    expect(fnBody('function clearGhostSeatsForUser(')).not.toContain('namesToMatch');
  });

  it('(B) resumeSession builds userData BEFORE setting the session (no half-signed-in socket on a parse error)', () => {
    const body = handlerBody('resumeSession');
    expect(body).toContain('achievements: parseAchievements(row.achievements),');
    expect(body.indexOf('const userData = {')).toBeLessThan(body.indexOf('authSessions.set(socket.id, {'));
  });

  it('(B) resumeSession: verified + row-checked before the session is set, exactly like authWithTicket\'s', () => {
    const body = handlerBody('resumeSession');
    const verifyAt = body.indexOf('verifyResumeToken(RESUME_SIGNING_KEY, data?.resumeToken)');
    const rowAt = body.indexOf('checkResumeRow(claims, row)');
    const setAt = body.indexOf('authSessions.set(socket.id, {');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(verifyAt);
    expect(setAt).toBeGreaterThan(rowAt);
    expect(body).toContain('userId, username: row.username, masterUserId: claims.masterUserId,\n          ...(claims.phone ? { phone: claims.phone } : {}),');
    expect(body).toContain("code: 'resume_invalid', message: RESUME_INVALID_MESSAGE");
  });

  it('(B) resumeSession: the seat restore is gated and skipped on refusal; the refusal follows loginResult', () => {
    const body = expectRestoresGated('resumeSession', 1);
    expectRestoreSkippedOnRefusal(body, 'rsSeatRestoreRefusal', "row.username, 'resumeSession', rsSession)");
    const loginResultAt = body.indexOf("socket.emit('loginResult', {\n          success: true,");
    const refusalAt = body.indexOf('if (rsSeatRestoreRefusal) emitPlayRefusal(socket, rsSeatRestoreRefusal);');
    expect(loginResultAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(loginResultAt);
    expect(body).toContain('if (!data?.skipSeatRecovery) try {');
  });

  it('(A) claimGuestProgress: read-only checks first, then the guest seat cash-out, then the transaction; audited', () => {
    const body = handlerBody('claimGuestProgress');
    const peekAt = body.indexOf('await peekGuestProgress(deps, input)');
    const cashAt = body.indexOf('await cashOutSeatsBeforeGuestClaim(pre.guestUserId)');
    const claimAt = body.indexOf('await claimGuestProgress(deps, input)');
    expect(peekAt).toBeGreaterThan(-1);
    expect(cashAt).toBeGreaterThan(peekAt);
    expect(claimAt).toBeGreaterThan(cashAt);
    expect(body).toContain("'GUEST_PROGRESS_CLAIMED'");
    // D2: the caller is MERGED (never reloaded: a reload drops unsaved progress).
    expect(body).toContain('progressionManager.applyCarriedProgress(auth.userId, {');
    expect(body).not.toContain('rehydrateUser(auth.userId)');
    // Only an ATTESTED master id may claim — never the gate-only stats id.
    expect(body).toContain('callerMasterId: auth?.masterUserId');
    expect(body).not.toContain('statsMasterUserId');
    // Durable audit row: listed in DURABLE_AUDIT_ACTIONS (2026-10-10:
    // ACCOUNT_MERGE / GOODWILL_CHIP_GRANT were appended after it).
    const durableStart = src.indexOf('const DURABLE_AUDIT_ACTIONS = new Set([');
    expect(durableStart).toBeGreaterThan(-1);
    const durable = src.slice(durableStart, src.indexOf(']);', durableStart));
    expect(durable).toContain("'GUEST_PROGRESS_CLAIMED',");
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

// ── 2026-10-09 — hand-start stand-up + tournament start screen ─────────────
describe('play-status cache peek — the hand loop never waits on the master', () => {
  it('returns the last answer with its age; null when there is none or it is too old; never fetches or counts', async () => {
    let t = 1_000_000;
    const m = fakeMaster(new Set([ROGER]));
    const { c } = client(m.fetchImpl, { now: () => t });
    expect(c.peek(ROGER, 60_000)).toBeNull();
    await c.getPlayStatus(ROGER);
    const before = c.counters();
    t += 30_000;
    expect(c.peek(ROGER, HAND_GATE_MAX_STATUS_AGE_MS)).toEqual({ status: { suspended: true, failedOpen: false }, ageMs: 30_000, expired: false });
    t += 40_000; // 70s — past the 60s TTL: still readable for the hand gate, flagged expired
    expect(c.peek(ROGER, HAND_GATE_MAX_STATUS_AGE_MS)).toMatchObject({ ageMs: 70_000, expired: true, status: { suspended: true } });
    expect(c.peek(ROGER, 60_000)).toBeNull();
    t += HAND_GATE_MAX_STATUS_AGE_MS;
    expect(c.peek(ROGER, HAND_GATE_MAX_STATUS_AGE_MS)).toBeNull();
    expect(m.calls).toHaveLength(1);
    expect(c.counters()).toEqual(before);
    expect(c.peek('', HAND_GATE_MAX_STATUS_AGE_MS)).toBeNull();
  });

  it('HAND_GATE_MAX_STATUS_AGE_MS is 5 minutes', () => {
    expect(HAND_GATE_MAX_STATUS_AGE_MS).toBe(5 * 60_000);
  });
});

describe('planHandStartGate — who is stood up before the deal', () => {
  const peekFrom = (entries: Record<string, PlayStatusPeek>) => (id: string) => entries[id] ?? null;
  const fresh = (suspended: boolean, failedOpen = false): PlayStatusPeek => ({ status: { suspended, failedOpen }, ageMs: 1_000, expired: false });
  const stale = (suspended: boolean): PlayStatusPeek => ({ status: { suspended, failedOpen: false }, ageMs: 90_000, expired: true });

  it('a cached SUSPENDED answer stands the seat up; nothing to refresh', () => {
    expect(planHandStartGate([{ seatIndex: 3, masterId: ROGER }, { seatIndex: 5, masterId: OTHER }], peekFrom({ [ROGER]: fresh(true), [OTHER]: fresh(false) })))
      .toEqual({ standUp: [{ seatIndex: 3, masterId: ROGER }], refresh: [] });
  });

  it('no cached answer → nobody stood up THIS hand, the id is refreshed for the next one', () => {
    expect(planHandStartGate([{ seatIndex: 3, masterId: ROGER }], peekFrom({})))
      .toEqual({ standUp: [], refresh: [ROGER] });
  });

  it('an expired (but within max age) suspended answer still stands him up, and is refreshed', () => {
    expect(planHandStartGate([{ seatIndex: 1, masterId: ROGER }], peekFrom({ [ROGER]: stale(true) })))
      .toEqual({ standUp: [{ seatIndex: 1, masterId: ROGER }], refresh: [ROGER] });
  });

  it('fail-open answers and seats with no master id never stand anyone up', () => {
    expect(planHandStartGate(
      [{ seatIndex: 0, masterId: ROGER }, { seatIndex: 2, masterId: null }, { seatIndex: 4, masterId: '  ' }],
      peekFrom({ [ROGER]: fresh(false, true) }),
    )).toEqual({ standUp: [], refresh: [] });
  });

  it('one refresh per id even when the same player holds two seats', () => {
    const plan = planHandStartGate([{ seatIndex: 0, masterId: OTHER }, { seatIndex: 6, masterId: OTHER }], peekFrom({}));
    expect(plan.refresh).toEqual([OTHER]);
  });
});

describe('findSuspendedRegistrants — free-chip tournament start screen', () => {
  const regs = [
    { playerId: 'a', socketId: 's-a', userId: 1 },
    { playerId: 'roger', socketId: 's-r', userId: 2 },
    { playerId: 'nolink', socketId: 's-n', userId: 3 },
    { playerId: 'boom', socketId: 's-b', userId: 4 },
  ];
  const ids: Record<string, string | null> = { a: OTHER, roger: ROGER, nolink: null };
  const masterIdOf = async (p: { playerId: string }) => {
    if (p.playerId === 'boom') throw new Error('stats lookup failed');
    return ids[p.playerId];
  };

  it('removes only the suspended; no master id or a failed lookup keeps the player', async () => {
    const { keep, suspended } = await findSuspendedRegistrants(regs, masterIdOf, async (id) => ({ suspended: id === ROGER, failedOpen: false }));
    expect(keep.map((p) => p.playerId)).toEqual(['a', 'nolink', 'boom']);
    expect(suspended).toEqual([{ player: regs[1], masterId: ROGER }]);
  });

  it('master down (fail-open) → nobody is removed', async () => {
    const { keep, suspended } = await findSuspendedRegistrants(regs, masterIdOf, async () => ({ suspended: false, failedOpen: true, reason: 'timeout' }));
    expect(keep).toHaveLength(4);
    expect(suspended).toHaveLength(0);
  });
});

// ── 2026-10-09 decision D5 — the tournament start screen never refunds twice ──
describe('D5 — removeSuspendedRegistrants against the REAL TournamentManager', () => {
  const FEE = 500;
  function paidSng() {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'D5-SNG', buyIn: FEE, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS,
    } as any);
    tm.registerPlayer(id, 'p-roger', 'Roger A.', 's-roger', 7); // the suspended registrant (paid)
    tm.registerPlayer(id, 'p-amy', 'Amy B.', 's-amy', 8);
    tm.registerPlayer(id, 'p-cal', 'Cal C.', 's-cal', 9);
    return { tm, id };
  }

  it('TournamentManager.unregisterPlayer returns true ONLY for a real removal', () => {
    const { tm, id } = paidSng();
    expect(tm.unregisterPlayer(id, 'p-roger')).toBe(true);
    expect(tm.unregisterPlayer(id, 'p-roger')).toBe(false); // already gone
    expect(tm.unregisterPlayer(id, 'nobody')).toBe(false);
  });

  it('a suspended registrant still registered is removed and refunded EXACTLY once', async () => {
    const { tm, id } = paidSng();
    const credits: Array<[number, number]> = [];
    const credit = async (u: number, a: number) => { credits.push([u, a]); return true; };
    const snapshot = tm.getTournament(id)!.players.slice();
    const suspended = [{ player: snapshot[0], masterId: 'roger-master' }];
    const out = await removeSuspendedRegistrants(tm, id, suspended, credit);
    expect(out).toEqual([{ playerId: 'p-roger', masterId: 'roger-master', userId: 7, refunded: FEE, refundFailed: false }]);
    expect(credits).toEqual([[7, FEE]]);
    expect(tm.getTournament(id)!.players.map((p) => p.playerId)).toEqual(['p-amy', 'p-cal']);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(2 * FEE);
    // A second screen pass (or a duplicate list entry) changes nothing.
    expect(await removeSuspendedRegistrants(tm, id, suspended, credit)).toEqual([]);
    expect(credits).toHaveLength(1);
  });

  it('THE RACE: he leaves (unregister + refund) while the screen awaits its lookups → the screen does NOT refund again', async () => {
    const { tm, id } = paidSng();
    const credits: Array<[number, number]> = [];
    const credit = async (u: number, a: number) => { credits.push([u, a]); return true; };
    // 1. The screen snapshots the field and starts its (async) status lookups.
    const snapshot = tm.getTournament(id)!.players.slice();
    // 2. Meanwhile his own leaveTournament runs (index.ts handler: unregister,
    //    then refund on true).
    if (tm.unregisterPlayer(id, 'p-roger')) { tm.refundEntryFee(id, 7); await credit(7, FEE); }
    // 3. The lookups resolve: Roger is suspended — from the STALE snapshot.
    const out = await removeSuspendedRegistrants(tm, id, [{ player: snapshot[0], masterId: 'roger-master' }], credit);
    expect(out).toEqual([]);
    expect(credits).toEqual([[7, FEE]]); // ONE refund, not two
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(2 * FEE); // pool backed out once
  });

  it('a failed wallet credit is reported (audited as TOURNAMENT_ENTRY_REFUND_FAILED), never retried into a double', async () => {
    const { tm, id } = paidSng();
    const snapshot = tm.getTournament(id)!.players.slice();
    const out = await removeSuspendedRegistrants(tm, id, [{ player: snapshot[0], masterId: 'm' }], async () => false);
    expect(out).toEqual([{ playerId: 'p-roger', masterId: 'm', userId: 7, refunded: 0, refundFailed: true }]);
  });

  it('a free tournament / an AI entrant: removed, nothing to refund', async () => {
    const tm = new TournamentManager();
    const id = tm.createTournament({ name: 'FREE', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    tm.registerPlayer(id, 'p1', 'One', 's1', 1);
    const credit = jest.fn(async () => true);
    const out = await removeSuspendedRegistrants(tm, id, [{ player: { playerId: 'p1' }, masterId: 'm' }], credit);
    expect(out).toEqual([{ playerId: 'p1', masterId: 'm', userId: 1, refunded: 0, refundFailed: false }]);
    expect(credit).not.toHaveBeenCalled();
  });
});

// ── 2026-10-09 S4 — fewer than two eligible after the start screen → cancel + refund ──
describe('S4 — cancelIfTooFewEligibleAfterScreen against the REAL TournamentManager', () => {
  const FEE = 1000;
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function sng(names: Array<[string, number]>, maxPlayers = 2) {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'S4-HU', buyIn: FEE, prizePool: 0, maxPlayers, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS,
    } as any);
    for (const [pid, uid] of names) tm.registerPlayer(id, pid, pid.toUpperCase(), 's-' + pid, uid);
    const wallet: Array<[number, number]> = [];
    const credit = async (u: number, a: number) => { wallet.push([u, a]); return true; };
    /** What index.ts refundCancelledTournamentEntrants credits. */
    const refundCancelled = (regs: Array<{ userId?: number; refund: number }>) => {
      for (const r of regs) if (r.userId !== undefined && r.refund > 0) wallet.push([r.userId, r.refund]);
    };
    return { tm, id, wallet, credit, refundCancelled };
  }

  it('heads-up, one suspended: he is removed + refunded once, the tournament is CANCELLED and the other refunded once — no walkover, no prize', async () => {
    const { tm, id, wallet, credit, refundCancelled } = sng([['roger', 7], ['amy', 8]]);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(2 * FEE);
    const snapshot = tm.getTournament(id)!.players.slice();
    const removed = await removeSuspendedRegistrants(tm, id, [{ player: snapshot[0], masterId: 'roger-master' }], credit);
    expect(removed).toHaveLength(1);
    const cancelled = cancelIfTooFewEligibleAfterScreen(tm, id, removed.length);
    expect(cancelled).toEqual([{ playerId: 'amy', userId: 8, refund: FEE }]);
    refundCancelled(cancelled!);
    expect(wallet).toEqual([[7, FEE], [8, FEE]]);                       // each exactly once
    expect(wallet.reduce((s, [, a]) => s + a, 0)).toBe(2 * FEE);          // = what was collected (no mint)
    const t = tm.getTournament(id)!;
    expect(t.status).toBe('cancelled');
    expect(t.players).toEqual([]);
    expect(t.collectedEntryFees).toBe(0);
    expect(tm.canStart(id)).toBe(false);
    // Nothing can refund either of them again:
    expect(tm.unregisterPlayer(id, 'amy')).toBe(false);                   // leaveTournament refunds only on true
    expect(cancelIfTooFewEligibleAfterScreen(tm, id, 1)).toBeNull();      // a second screen pass
    expect(tm.cancelTournament(id)).toEqual([]);                          // the stall sweep's path
    expect(tm.checkStalledTournaments()).not.toContain(id);
  });

  it('heads-up, BOTH suspended: both removed + refunded once; the empty tournament is cancelled with nobody else to refund', async () => {
    const { tm, id, wallet, credit, refundCancelled } = sng([['roger', 7], ['rex', 9]]);
    const snapshot = tm.getTournament(id)!.players.slice();
    const removed = await removeSuspendedRegistrants(tm, id, snapshot.map((p) => ({ player: p, masterId: 'm-' + p.playerId })), credit);
    const cancelled = cancelIfTooFewEligibleAfterScreen(tm, id, removed.length);
    expect(cancelled).toEqual([]);
    refundCancelled(cancelled!);
    expect(wallet).toEqual([[7, FEE], [9, FEE]]);
    expect(tm.getTournament(id)!.status).toBe('cancelled');
  });

  it('no-op (null) when nothing was removed, when >= 2 eligible remain, or when the tournament is no longer registering', async () => {
    const a = sng([['amy', 8]]);                                            // 1 registrant, nobody suspended
    expect(cancelIfTooFewEligibleAfterScreen(a.tm, a.id, 0)).toBeNull();   // not this rule's business
    expect(a.tm.getTournament(a.id)!.status).toBe('registering');

    const b = sng([['roger', 7], ['amy', 8], ['cal', 9]], 9);
    const snap = b.tm.getTournament(b.id)!.players.slice();
    const removed = await removeSuspendedRegistrants(b.tm, b.id, [{ player: snap[0], masterId: 'm' }], b.credit);
    expect(cancelIfTooFewEligibleAfterScreen(b.tm, b.id, removed.length)).toBeNull(); // 2 remain
    expect(b.tm.getTournament(b.id)!.status).toBe('registering');
    expect(MIN_ELIGIBLE_TO_START).toBe(2);

    const c = sng([['amy', 8], ['cal', 9]]);
    c.tm.startTournament(c.id);
    expect(cancelIfTooFewEligibleAfterScreen(c.tm, c.id, 1)).toBeNull();   // running: never cancelled here
    expect(c.tm.getTournament(c.id)!.status).toBe('running');
  });
});

/**
 * 2026-10-28 (error sweep, game-server: .online sign-in failed 'Auth server
 * timed out') — poker-server's token introspection aborted at 5 s, and a
 * request Cloud Run routed to a cold-starting auth-server instance waited out
 * its 7-19 s boot (the warm instance answered in 0.05-0.15 s at the same
 * moment). validateOAuthToken now re-sends a TIMED-OUT introspection ONCE
 * with a 4 s abort (the gain is being routed again, mostly to the warm
 * instance). Introspection is read-only, so the re-send is safe.
 *  - Normal path unchanged: one request, 5 s abort.
 *  - Only a timeout is re-tried: an answer (401 / 5xx / inactive) or a
 *    network error is returned as before, after one request.
 *  - At most two requests; worst case 9 s (under poker-3d's 10 s legacy
 *    tokenLogin watchdog, which also sends an opaque token, and the 15 s /
 *    25 s oauthLogin watchdogs). Review fix 2026-10-28: was 7 s / 12 s.
 */
jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(() => ({})), jwtVerify: jest.fn(async () => { throw Object.assign(new Error('bad'), { code: 'ERR_JWS_INVALID' }); }) }));

type V = typeof import('../src/auth/oauthValidator');

function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}
/** A fetch that never answers; rejects with AbortError when its signal fires. */
const hang = (_url: string, init: any) => new Promise((_res, rej) => {
  init.signal.addEventListener('abort', () => rej(abortError()));
});
const answer = (status: number, body: any = {}) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('validateOAuthToken — a timed-out introspection is re-tried once', () => {
  const realFetch = global.fetch;
  let v: V;
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.OAUTH_CLIENT_SECRET = 'test-secret';
    jest.isolateModules(() => { v = require('../src/auth/oauthValidator'); });
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
    delete process.env.OAUTH_CLIENT_SECRET;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('the constants: 5 s first, 4 s re-try (worst case 9 s, under the 10 s legacy tokenLogin watchdog)', () => {
    expect(v.INTROSPECTION_TIMEOUT_MS).toBe(5000);
    expect(v.INTROSPECTION_RETRY_TIMEOUT_MS).toBe(4000);
    expect(v.INTROSPECTION_TIMEOUT_MS + v.INTROSPECTION_RETRY_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('normal path: ONE request, answered at once — nothing re-tried, nothing logged', async () => {
    fetchMock.mockImplementation(answer(200, { active: true, sub: 'm-1', username: 'alice' }));
    const r = await v.validateOAuthToken('opaque-token');
    expect(r).toEqual({ valid: true, sub: 'm-1', username: 'alice', phone: undefined, isAdmin: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(v.getIntrospectionStats()).toEqual({ timedOut: 0, retried: 0, retrySucceeded: 0, retryTimedOut: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('cold instance: the first attempt is aborted at 5 s, the re-send (routed again) answers → the sign-in succeeds', async () => {
    fetchMock.mockImplementationOnce(hang).mockImplementationOnce(answer(200, { active: true, sub: 'm-2', preferred_username: 'bob', is_admin: false }));
    const p = v.validateOAuthToken('opaque-token');
    await jest.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);                               // the normal path is not delayed or doubled
    await jest.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r).toMatchObject({ valid: true, sub: 'm-2', username: 'bob' });    // pre-fix: { valid:false, error:'Auth server timed out' }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toMatch(/\/token\/introspection$/);
    expect(String(init.body)).toBe('token=opaque-token');                     // the same, idempotent request
    expect(v.getIntrospectionStats()).toEqual({ timedOut: 1, retried: 1, retrySucceeded: 1, retryTimedOut: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"event":"introspection_timeout_retried","outcome":"valid"');
  });

  it('the re-send waits up to 4 s — answered at 3.5 s into it', async () => {
    fetchMock.mockImplementationOnce(hang).mockImplementationOnce((_u: string, init: any) => new Promise((res, rej) => {
      const t = setTimeout(() => res({ ok: true, status: 200, json: async () => ({ active: true, sub: 'm-3' }) }), 3500);
      init.signal.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); });
    }));
    const p = v.validateOAuthToken('opaque-token');
    await jest.advanceTimersByTimeAsync(5000 + 3500);
    expect((await p).valid).toBe(true);
  });

  it('a re-send still unanswered at 4 s is aborted (an answer at 4.5 s comes too late)', async () => {
    fetchMock.mockImplementationOnce(hang).mockImplementationOnce((_u: string, init: any) => new Promise((res, rej) => {
      const t = setTimeout(() => res({ ok: true, status: 200, json: async () => ({ active: true, sub: 'm-4' }) }), 4500);
      init.signal.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); });
    }));
    const p = v.validateOAuthToken('opaque-token');
    await jest.advanceTimersByTimeAsync(5000 + 4000);
    expect(await p).toEqual({ valid: false, error: 'Auth server timed out' });
  });

  it('both attempts time out: the same "Auth server timed out" after 9 s, exactly two requests', async () => {
    fetchMock.mockImplementation(hang);
    const p = v.validateOAuthToken('opaque-token');
    let settled = false;
    void p.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(8_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ valid: false, error: 'Auth server timed out' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);                               // never a third
    expect(v.getIntrospectionStats()).toEqual({ timedOut: 1, retried: 1, retrySucceeded: 0, retryTimedOut: 1 });
  });

  it('an ANSWER is never re-tried: 401 invalid_client, 5xx, inactive token; nor a network error', async () => {
    const cases: Array<[() => Promise<any>, Record<string, unknown>]> = [
      [answer(401), { valid: false, status: 401, clientAuthFailed: true }],
      [answer(503), { valid: false, status: 503, error: 'Introspection failed (503)' }],
      [answer(200, { active: false }), { valid: false, error: 'Token is not active' }],
      [async () => { throw new TypeError('fetch failed'); }, { valid: false, error: 'fetch failed' }],
    ];
    for (const [impl, want] of cases) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(impl);
      expect(await v.validateOAuthToken('opaque-token')).toMatchObject(want);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    expect(v.getIntrospectionStats().retried).toBe(0);
  });

  it('a re-send that is ANSWERED invalid is returned as is (no third request)', async () => {
    fetchMock.mockImplementationOnce(hang).mockImplementationOnce(answer(200, { active: false }));
    const p = v.validateOAuthToken('opaque-token');
    await jest.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ valid: false, error: 'Token is not active' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(v.getIntrospectionStats()).toEqual({ timedOut: 1, retried: 1, retrySucceeded: 0, retryTimedOut: 0 });
    expect(String(warn.mock.calls[0][0])).toContain('"outcome":"answered_invalid"');
  });

  it('a JWT access token never reaches introspection (JWKS path unchanged)', async () => {
    const r = await v.validateOAuthToken('aaa.bbb.ccc');
    expect(r.valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

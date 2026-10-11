/**
 * 2026-10-11 — AUTH-12: a locally BANNED account (banUser / adminIPBan:
 * users.banned) is refused at SIGN-IN (oauthLogin, tokenLogin, authWithTicket,
 * the waitlist deep link — resumeSession and the legacy token already refused
 * it) and at EVERY play entry (assertPlayable). Before, the ban was checked
 * only by joinTable, the Return and the seat restores: a banned player could
 * sign in, quick-play, register for tournaments, take a waitlist seat, rebuy.
 *
 * Runs the REAL assertPlayable / bannedAccountRefusal and the REAL oauthLogin /
 * tokenLogin handlers sliced from src/index.ts.
 */

import { fnSrc, handlerSrc, load, flush, SRC } from './helpers/indexSource';
import { resolveLoginIdentity } from '../src/auth/loginIdentity';

describe('assertPlayable — the ban is checked at every play entry', () => {
  function gate(opts: { banned?: number[]; masterRefusal?: unknown; dbDown?: boolean; session?: boolean } = {}) {
    const lookups: number[] = [];
    const logs: string[] = [];
    const authSessions = new Map<string, any>(opts.session === false ? [] : [['S1', { userId: 7, username: 'm:x' }]]);
    const { exports } = load(fnSrc('async function assertPlayable(') + fnSrc('async function bannedAccountRefusal('), {
      assertPlayableForSocket: async () => opts.masterRefusal ?? null,
      authSessions,
      isUserBanned: async (uid: number) => { lookups.push(uid); if (opts.dbDown) throw new Error('db down'); return (opts.banned || []).includes(uid); },
      PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED',
      console: { log() {}, warn: (l: string) => logs.push(l), error() {} },
    }, 'assertPlayable');
    return { assertPlayable: exports as (s: any, where: string) => Promise<any>, lookups, logs };
  }
  const socket = { id: 'S1' };

  it('a banned signed-in account → player_suspended (the owner\'s sentence), logged', async () => {
    const g = gate({ banned: [7] });
    expect(await g.assertPlayable(socket, 'quickHeadsUp')).toEqual({ code: 'player_suspended', message: 'SUSPENDED' });
    expect(g.logs.some((l) => l.includes('banned_account_refused') && l.includes('quickHeadsUp'))).toBe(true);
  });
  it('not banned → null; no session → null without a lookup; a master refusal wins without a lookup', async () => {
    expect(await gate().assertPlayable(socket, 'rebuy')).toBeNull();
    const none = gate({ session: false });
    expect(await none.assertPlayable(socket, 'rebuy')).toBeNull();
    expect(none.lookups).toEqual([]);
    const m = gate({ banned: [7], masterRefusal: { code: 'login_required', message: 'L' } });
    expect(await m.assertPlayable(socket, 'rebuy')).toEqual({ code: 'login_required', message: 'L' });
    expect(m.lookups).toEqual([]);
  });
  it('a DB error fails OPEN (like the master suspension lookup), logged', async () => {
    const g = gate({ dbDown: true });
    expect(await g.assertPlayable(socket, 'registerTournament')).toBeNull();
    expect(g.logs.some((l) => l.includes('ban_check_failed_open'))).toBe(true);
  });
});

describe('sign-in — a banned row signs in nowhere', () => {
  function signIn(event: 'oauthLogin' | 'tokenLogin', banned: boolean) {
    const frames: any[] = [];
    const emitted: Array<[string, any]> = [];
    const authSessions = new Map<string, any>();
    const loadProgress = jest.fn(async () => ({ success: false }));
    const release = jest.fn();
    const code = event === 'oauthLogin' ? handlerSrc('oauthLogin', '\n  }));\n') : handlerSrc('tokenLogin', '\n  }));\n');
    const { exports, stubbed } = load(`function wire(socket) {\n${code}\n}`, {
      trackLogin: (_s: unknown, _v: unknown, fn: unknown) => fn,
      normalizeRequestId: (x: unknown) => (typeof x === 'string' ? x : undefined),
      validateOAuthToken: async () => ({ valid: true, sub: 'm-banned', username: 'Banned Person', isAdmin: false }),
      resolveLoginIdentity,
      maintenanceBlocksLogin: () => false,
      upsertOidcLocalUser: async () => ({ ok: true, how: 'master', user: { id: 9, username: 'm:m-banned', display_name: 'Banned Person', banned } }),
      failLogin: (_s: unknown, f: unknown) => frames.push(f),
      PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED',
      authSessions, playerSessions: new Map(), reservedSeats: new Map(), tokenLoginAttempts: new Map(),
      loadProgress, releaseSocketForAccountSwitch: release,
      reportAuthEvent() {}, Sentry: null, console: { log() {}, warn() {}, error() {} },
    }, '{ wire }');
    const handlers: Record<string, (...a: any[]) => any> = {};
    const socket = { id: 'S1', connected: true, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, d: any) => emitted.push([ev, d]), join() {}, leave() {} };
    exports.wire(socket);
    expect(stubbed.has('failLogin')).toBe(false);
    return { handlers, frames, emitted, authSessions, loadProgress, release };
  }

  it.each(['oauthLogin', 'tokenLogin'] as const)('%s: refused player_suspended BEFORE any session, seat restore or progress', async (event) => {
    const w = signIn(event, true);
    await w.handlers[event](event === 'oauthLogin' ? { accessToken: 'tok', requestId: 'r1' } : { token: 'tok', requestId: 'r1' });
    await flush();
    expect(w.frames).toEqual([expect.objectContaining({ code: 'player_suspended', message: 'SUSPENDED', via: event })]);
    expect(w.authSessions.has('S1')).toBe(false);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.loadProgress).not.toHaveBeenCalled();
  });

  it.each(['oauthLogin', 'tokenLogin'] as const)('CONTROL — %s with the same row NOT banned goes on to load the account', async (event) => {
    const w = signIn(event, false);
    await w.handlers[event](event === 'oauthLogin' ? { accessToken: 'tok' } : { token: 'tok' });
    await flush();
    expect(w.loadProgress).toHaveBeenCalledWith(9);
    expect(w.frames.some((f) => f.code === 'player_suspended')).toBe(false);
  });

  it('wiring: authWithTicket refuses a banned row before binding the session', () => {
    const tk = SRC.slice(SRC.indexOf("trackLogin(socket, 'authWithTicket'"), SRC.indexOf("'resumeSession',"));
    const banAt = tk.indexOf('if (localUser.banned) {');
    expect(banAt).toBeGreaterThan(-1);
    expect(tk.indexOf("failTicket('player_suspended', PLAYER_SUSPENDED_MESSAGE", banAt)).toBeGreaterThan(banAt);
    expect(tk.indexOf('authSessions.set(socket.id', banAt)).toBeGreaterThan(banAt);
    expect(tk.slice(0, banAt)).not.toContain('authSessions.set(socket.id');
  });

  it('wiring: the waitlist deep link never binds a banned row and refuses the link before any seat or deduct', () => {
    const wl = SRC.slice(SRC.indexOf("'joinWithWaitlistContext',"), SRC.indexOf("socket.on('selectPineappleDiscard'"));
    const flagAt = wl.indexOf('if (wlRow?.banned) {');
    const bindAt = wl.indexOf('releaseSocketForAccountSwitch(socket, wlRow.id');
    const refuseAt = wl.indexOf("if (wlBootstrapBanned) {\n          failWaitlist('player_suspended', PLAYER_SUSPENDED_MESSAGE);");
    expect(flagAt).toBeGreaterThan(-1);
    expect(bindAt).toBeGreaterThan(flagAt);
    expect(refuseAt).toBeGreaterThan(bindAt);
    expect(wl.indexOf('deductChips(', refuseAt)).toBeGreaterThan(refuseAt);
    expect(wl.indexOf('.sitDown(', refuseAt)).toBeGreaterThan(refuseAt);
  });
});

/**
 * 2026-11-02 (.online tournament broadcast, P1-S1) — the per-player BROADCAST
 * OPT-OUT ("Show me as Player on broadcasts").
 *  - 'setBroadcastOptOut' / 'getBroadcastOptOut' (signed in) → 'broadcastOptOutResult';
 *    'adminSetBroadcastOptOut' → isUserAdmin first, audited BROADCAST_OPT_OUT_SET.
 *  - Stored in users.stats through the atomic mergeUserStats: the patch is EXACTLY
 *    {broadcastOptOut, broadcastOptOutAt}; it survives a restart (a fresh process
 *    reads it back from the row); a failed save says save_failed (and an opt-OUT is
 *    still honoured in memory: privacy first).
 *  - The next program shows 'Player' (names resolved at emit time).
 * The REAL handler module + the REAL authManager functions (sliced, on a fake pool).
 */
import fs from 'fs';
import path from 'path';
import { createBroadcastOptOutStore, createBroadcastOptOutHandlers, type OptOutRow } from '../src/broadcast/broadcastNames';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { buildProgramData } from '../src/broadcast/broadcastSnapshot';
import { resolveEventKey } from '../src/broadcast/eventKey';
import { SRC, handlerSrc, load } from './helpers/indexSource';
import { qualifierWorld } from './helpers/broadcastWorld';

const AUTH_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'authManager.ts'), 'utf8');
const authFn = (sig: string): string => {
  const at = AUTH_SRC.indexOf(sig);
  if (at < 0) throw new Error(`not in authManager.ts: ${sig}`);
  return AUTH_SRC.slice(at, AUTH_SRC.indexOf('\n}\n', at) + 3).replace(/^export /, '');
};

/** users rows (id → stats TEXT, as on prod) behind a fake pg pool that runs the two statements the real code sends. */
function fakeUsersDb(rows: Record<number, Record<string, unknown>>) {
  const users = new Map<number, string>(Object.entries(rows).map(([id, s]) => [Number(id), JSON.stringify(s)]));
  const log: string[] = [];
  const fail = { update: false, select: false };
  const rowOut = (id: number) => {
    const s = JSON.parse(users.get(id) as string);
    return { id, m: s.masterUserId ?? null, o: s.broadcastOptOut === undefined ? null : String(s.broadcastOptOut), tomb: 'mergedInto' in s };
  };
  const pool = {
    connect: async () => ({
      query: async (sql: string, params: any[] = []) => {
        log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (/^SELECT stats FROM users WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: users.has(params[0]) ? [{ stats: users.get(params[0]) }] : [] };
        if (/^UPDATE users SET stats/.test(sql)) {
          if (fail.update) throw new Error('connection reset');
          users.set(params[1], params[0]);
          return { rows: [] };
        }
        return { rows: [] };   // BEGIN / COMMIT / ROLLBACK
      },
      release: () => {},
    }),
    query: async (sql: string, params: any[]) => {
      if (fail.select) throw new Error('db down');
      log.push(/WHERE id = ANY/.test(sql) ? 'SELECT by id' : 'SELECT by master');
      if (/WHERE id = ANY\(\$1::int\[\]\)/.test(sql)) return { rows: (params[0] as number[]).filter((id) => users.has(id)).map(rowOut) };
      if (/->> 'masterUserId' END\) = ANY\(\$1::text\[\]\)/.test(sql)) {
        return { rows: [...users.keys()].filter((id) => (params[0] as string[]).includes(JSON.parse(users.get(id)!).masterUserId)).map(rowOut) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { users, pool, log, fail, stats: (id: number) => JSON.parse(users.get(id) as string) };
}

/** The REAL mergeUserStats + loadBroadcastOptOuts (authManager.ts) on the fake pool. */
function realAuth(db: ReturnType<typeof fakeUsersDb>) {
  const code = `${authFn('export async function mergeUserStats(')}\n${authFn('export async function loadBroadcastOptOuts(')}`;
  const { exports: m, stubbed } = load(code, {
    pool: db.pool,
    parseStatsColumn: (s: unknown) => (typeof s === 'string' ? JSON.parse(s) : s || {}),
    mergeProgressStats: (a: any, b: any) => ({ ...a, ...b }),
    console: { warn() {}, log() {} },
  }, '{ mergeUserStats, loadBroadcastOptOuts }');
  expect([...stubbed]).toEqual([]);
  return m as { mergeUserStats: (id: number, patch: any, opts?: any) => Promise<void>; loadBroadcastOptOuts: (q: any) => Promise<OptOutRow[]> };
}

function harness(o: { admin?: boolean } = {}) {
  const db = fakeUsersDb({
    101: { masterUserId: 'm-0000-101', handsPlayed: 40 },
    102: { masterUserId: 'm-0000-102', broadcastOptOut: true },
    103: { masterUserId: 'm-0000-103', mergedInto: 101 },
  });
  const auth = realAuth(db);
  const merges: Array<[number, any, any]> = [];
  const audits: any[] = [];
  const store = createBroadcastOptOutStore({ load: auth.loadBroadcastOptOuts, schedule: () => {}, log: () => {} });
  const authSessions = new Map<string, any>([
    ['S1', { userId: 101, username: 'u101', masterUserId: 'm-0000-101' }],
    ['SA', { userId: 9, username: 'admin', masterUserId: 'm-admin', isAdminClaim: true }],
  ]);
  const order: string[] = [];
  const h = createBroadcastOptOutHandlers({
    store,
    authOf: (sid) => authSessions.get(sid),
    mergeUserStats: async (id, patch, opts) => { order.push('merge'); merges.push([id, patch, opts]); return auth.mergeUserStats(id, patch, opts); },
    isUserAdmin: async (id) => { order.push('isUserAdmin'); return !!o.admin && id === 9; },
    auditLog: (actor, action, details) => audits.push({ actor, action, details }),
    limiter: createWindowRateLimiter(10, 60_000),
    now: () => Date.parse('2026-11-02T18:00:00.000Z'),
    log: () => {},
  });
  const sock = (id: string) => {
    const out: Array<[string, any]> = [];
    return { id, emit: (ev: string, d: any) => out.push([ev, d]), out, last: () => out[out.length - 1] };
  };
  return { db, auth, store, h, merges, audits, sock, order, authSessions };
}

describe('setBroadcastOptOut / getBroadcastOptOut', () => {
  it('not signed in → login_required (nothing written)', async () => {
    const x = harness();
    const s = x.sock('ANON');
    await x.h.set(s, { optOut: true });
    await x.h.get(s);
    expect(s.out).toEqual([['broadcastOptOutResult', { ok: false, code: 'login_required' }], ['broadcastOptOutResult', { ok: false, code: 'login_required' }]]);
    expect(x.merges).toEqual([]);
  });

  it('the patch is EXACTLY {broadcastOptOut, broadcastOptOutAt} through mergeUserStats (rethrow); every other stats key kept; the cache knows it by local AND master id', async () => {
    const x = harness();
    const s = x.sock('S1');
    await x.h.set(s, { optOut: true });
    expect(x.merges).toEqual([[101, { broadcastOptOut: true, broadcastOptOutAt: '2026-11-02T18:00:00.000Z' }, { rethrow: true }]]);
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: true, optOut: true }]);
    expect(x.db.stats(101)).toEqual({ masterUserId: 'm-0000-101', handsPlayed: 40, broadcastOptOut: true, broadcastOptOutAt: '2026-11-02T18:00:00.000Z' });
    expect(x.store.get({ userId: 101 })).toBe(true);
    expect(x.store.get({ masterUserId: 'm-0000-101' })).toBe(true);
    await x.h.set(s, { optOut: false });
    expect(x.db.stats(101).broadcastOptOut).toBe(false);
    expect(x.store.get({ userId: 101 })).toBe(false);
  });

  it('survives a restart: a fresh process (new cache) reads it back from the row; getBroadcastOptOut answers from the row', async () => {
    const x = harness();
    await x.h.set(x.sock('S1'), { optOut: true });
    // "Restart": a new cache + handlers over the SAME database.
    const store2 = createBroadcastOptOutStore({ load: x.auth.loadBroadcastOptOuts, schedule: () => {}, log: () => {} });
    expect(store2.get({ userId: 101, masterUserId: 'm-0000-101' })).toBeUndefined();   // unknown until read → 'Player'
    await store2.flush();
    expect(store2.get({ userId: 101 })).toBe(true);
    expect(store2.get({ masterUserId: 'm-0000-101' })).toBe(true);
    const h2 = createBroadcastOptOutHandlers({
      store: store2, authOf: (sid) => x.authSessions.get(sid), mergeUserStats: x.auth.mergeUserStats, isUserAdmin: async () => false,
      auditLog: () => {}, limiter: createWindowRateLimiter(10, 60_000), log: () => {},
    });
    const s = x.sock('S1');
    await h2.get(s);
    expect(s.out).toEqual([['broadcastOptOutResult', { ok: true, optOut: true }]]);
    // A master-id-only entrant (no local id known) is read by master id; a merged tombstone row is never an answer.
    const rows = await x.auth.loadBroadcastOptOuts({ masterIds: ['m-0000-102', 'm-0000-103'] });
    expect(rows).toEqual([{ id: 102, masterUserId: 'm-0000-102', optOut: true }]);
  });

  it('a failed save → save_failed; an opt-OUT is still honoured in memory (privacy first); a failed opt-IN changes nothing; a read failure → load_failed', async () => {
    const x = harness();
    const s = x.sock('S1');
    x.db.fail.update = true;
    await x.h.set(s, { optOut: true });
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: false, code: 'save_failed' }]);
    expect(x.db.stats(101).broadcastOptOut).toBeUndefined();
    expect(x.store.get({ userId: 101 })).toBe(true);
    await x.h.set(s, { optOut: false });
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: false, code: 'save_failed' }]);
    expect(x.store.get({ userId: 101 })).toBe(true);
    x.db.fail.select = true;
    await x.h.get(s);
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: false, code: 'load_failed' }]);
  });

  it('a non-boolean optOut → save_failed, nothing written; more than 10 changes a minute → rate_limited', async () => {
    const x = harness();
    const s = x.sock('S1');
    await x.h.set(s, { optOut: 'yes' });
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: false, code: 'save_failed' }]);
    expect(x.merges).toEqual([]);
    for (let i = 0; i < 10; i++) await x.h.set(s, { optOut: i % 2 === 0 });
    await x.h.set(s, { optOut: true });
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: false, code: 'rate_limited' }]);
    expect(x.merges).toHaveLength(10);
    // getBroadcastOptOut in a loop: 10 row reads a minute, then the cache answers (no DB read).
    const reads = () => x.db.log.filter((l) => l === 'SELECT by id').length;
    for (let i = 0; i < 10; i++) await x.h.get(s);
    expect(reads()).toBe(10);
    await x.h.get(s);
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: true, optOut: false }]);
    expect(reads()).toBe(10);
  });

  it('getBroadcastOptOut past the limit with nothing cached → rate_limited (never a DB read)', async () => {
    const x = harness();
    const s = x.sock('S1');
    const limited = createBroadcastOptOutHandlers({
      store: createBroadcastOptOutStore({ load: async () => { throw new Error('must not read'); }, schedule: () => {}, log: () => {} }),
      authOf: (sid) => x.authSessions.get(sid), mergeUserStats: async () => {}, isUserAdmin: async () => false,
      auditLog: () => {}, limiter: { hit: () => false, size: () => 0 }, log: () => {},
    });
    await limited.get(s);
    expect(s.last()).toEqual(['broadcastOptOutResult', { ok: false, code: 'rate_limited' }]);
  });

  it('the NEXT program shows "Player" for him (names resolved at emit time), and his name again after opting back in', async () => {
    const x = harness();
    const w = qualifierWorld();
    w.world.optOut = (ids) => x.store.get(ids);
    x.store.set({ userId: 101, masterUserId: 'm-0000-101' }, false);
    for (const p of w.players) if (p.localUserId !== 101) x.store.set({ userId: p.localUserId }, false);
    const ev = (resolveEventKey(w.world, `q:${w.qualId}`) as any).ev;
    const nameOfJohn = () => buildProgramData({ world: w.world, ev, channel: 'weekly', now: Date.now(), ticker: [] })
      .program.standings.leaders.map((l) => l.name).filter((n) => n.startsWith('John') || n === 'Player');
    expect(nameOfJohn()).toContain('John S.');
    await x.h.set(x.sock('S1'), { optOut: true });
    expect(nameOfJohn()).not.toContain('John S.');
    await x.h.set(x.sock('S1'), { optOut: false });
    expect(nameOfJohn()).toContain('John S.');
  });
});

describe('adminSetBroadcastOptOut — isUserAdmin first, audited', () => {
  it('not an admin → not_admin (nothing written, nothing audited); isUserAdmin is asked BEFORE any write', async () => {
    const x = harness({ admin: false });
    const s = x.sock('S1');
    await x.h.adminSet(s, { userId: 102, optOut: false });
    expect(s.out).toEqual([['adminBroadcastOptOutResult', { ok: false, code: 'not_admin' }]]);
    expect(x.merges).toEqual([]);
    expect(x.audits).toEqual([]);
  });

  it('an admin, by master id or local id: written, cached, audited BROADCAST_OPT_OUT_SET; unknown → user_not_found; a tombstone is not a user; bad body → invalid_request', async () => {
    const x = harness({ admin: true });
    const s = x.sock('SA');
    await x.h.adminSet(s, { masterUserId: 'm-0000-102', optOut: false });
    expect(x.order).toEqual(['isUserAdmin', 'merge']);
    expect(s.last()).toEqual(['adminBroadcastOptOutResult', { ok: true, userId: 102, masterUserId: 'm-0000-102', optOut: false }]);
    expect(x.db.stats(102).broadcastOptOut).toBe(false);
    expect(x.store.get({ userId: 102 })).toBe(false);
    expect(x.audits).toEqual([{ actor: 'admin', action: 'BROADCAST_OPT_OUT_SET', details: { targetUserId: 102, targetMasterUserId: 'm-0000-102', optOut: false, byUserId: 9 } }]);
    await x.h.adminSet(s, { userId: 101, optOut: true });
    expect(s.last()).toEqual(['adminBroadcastOptOutResult', { ok: true, userId: 101, masterUserId: 'm-0000-101', optOut: true }]);
    await x.h.adminSet(s, { userId: 999, optOut: true });
    expect(s.last()).toEqual(['adminBroadcastOptOutResult', { ok: false, code: 'user_not_found' }]);
    await x.h.adminSet(s, { userId: 103, optOut: true });
    expect(s.last()).toEqual(['adminBroadcastOptOutResult', { ok: false, code: 'user_not_found' }]);
    await x.h.adminSet(s, { optOut: true });
    expect(s.last()).toEqual(['adminBroadcastOptOutResult', { ok: false, code: 'invalid_request' }]);
    expect(x.audits).toHaveLength(2);
  });
});

describe('wiring in index.ts / authManager.ts', () => {
  it('the three socket events are registered; registerQualifierTournament warms the cache after the master id check; the admin override is a durable audit action', () => {
    expect(handlerSrc('setBroadcastOptOut', '\n')).toContain('broadcastOptOutHandlers.set(socket, data)');
    expect(handlerSrc('getBroadcastOptOut', '\n')).toContain('broadcastOptOutHandlers.get(socket)');
    expect(handlerSrc('adminSetBroadcastOptOut', '\n')).toContain('broadcastOptOutHandlers.adminSet(socket, data)');
    const reg = handlerSrc('registerQualifierTournament', '\n  });\n');
    const prime = reg.indexOf('primeBroadcastOptOut(auth.userId, masterId);');
    expect(prime).toBeGreaterThan(reg.indexOf("if (!masterId) {"));
    expect(prime).toBeLessThan(reg.indexOf('qualifierEventFor(data?.qualifierId)'));
    expect(SRC).toMatch(/const DURABLE_AUDIT_ACTIONS = new Set\(\[[\s\S]*'BROADCAST_OPT_OUT_SET',[\s\S]*\]\);/);
    expect(SRC).toContain('isUserAdmin,\n  auditLog,');
    // mergeUserStats: an existing caller (no rethrow) still resolves on a failure; rethrow is opt-in.
    expect(authFn('export async function mergeUserStats(')).toContain('if (opts.rethrow) throw e;');
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['setBroadcastOptOut', 'broadcastOptOutResult', 'BROADCAST_OPT_OUT_SET']) expect(manifest).toContain(tok);
  });

  it('an existing mergeUserStats caller (no rethrow) still resolves when the write fails (unchanged behaviour)', async () => {
    const db = fakeUsersDb({ 5: { a: 1 } });
    const auth = realAuth(db);
    db.fail.update = true;
    await expect(auth.mergeUserStats(5, { b: 2 })).resolves.toBeUndefined();
    await expect(auth.mergeUserStats(5, { b: 2 }, { rethrow: true })).rejects.toThrow('connection reset');
    expect(db.stats(5)).toEqual({ a: 1 });
  });
});

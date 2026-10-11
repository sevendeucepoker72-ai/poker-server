/**
 * 2026-10-11 — AUTH-1 (P0 account / admin takeover) + AUTH-11.
 *
 * A sign-in must NEVER bind or adopt an existing local row because of a name
 * (the token's `username` claim is the display name the player edits freely on
 * americanpub.poker; a slug or an unattested phone is no better). Rows are found
 * by MASTER ID; a master with no row gets a NEW `m:<master id>` row — or an
 * existing UNOWNED row only with real proof (a master-attested phone equal to
 * the row's phone-number username), never an is_admin / GuestNNNN / tombstone
 * row, never a row another master owns.
 *
 * The OIDC tests run the REAL `upsertOidcLocalUser(Locked)` source sliced out of
 * src/index.ts (with the real accountMerge resolver, masterRow module and
 * withMasterLock) against an in-memory `users` table that enforces the same
 * unique keys as prod (username, LOWER(username)). A CONTROL runs the statement
 * the server used until today against the same table and shows the takeover.
 */

import { fnSrc, load } from './helpers/indexSource';
import { findLocalUserByMasterId, identityStampPatch, withMasterLock } from '../src/auth/accountMerge';
import { parseStatsColumn } from '../src/auth/loginIdentity';
import {
  createOrAdoptMasterRow, adoptionRefusalReason, normalizePhoneKey, masterRowUsername, isGuestUsername, masterRowStats,
} from '../src/auth/masterRow';
import { accountDisplayName, toWhitelistDisplayName, isWhitelistDisplayName } from '../src/auth/displayName';
import fs from 'fs';
import path from 'path';

// The module logs every created / refused row ([identity] …); keep the test output readable.
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

interface Row {
  id: number; username: string; display_name: string | null; password_hash: string; chips: number; level: number; xp: number;
  stats: string; is_admin: boolean; banned: boolean;
}

/**
 * An in-memory users table speaking the statements the sign-in paths issue.
 * Unique like prod: username and LOWER(username).
 */
function fakeDb(seed: Array<Partial<Row> & { username: string }>) {
  let nextId = 1;
  const rows: Row[] = seed.map((r) => ({
    id: r.id ?? nextId++, username: r.username, display_name: r.display_name ?? null, password_hash: 'x',
    chips: r.chips ?? 50_000, level: r.level ?? 1, xp: r.xp ?? 0, stats: r.stats ?? '{}', is_admin: !!r.is_admin, banned: !!r.banned,
  }));
  nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
  const statements: string[] = [];
  let failNext: string | null = null;
  const taken = (u: string) => rows.find((r) => r.username.toLowerCase() === u.toLowerCase());
  async function query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    if (failNext && sql.includes(failNext)) { failNext = null; throw new Error('connection terminated'); }
    const out = (rs: any[]) => ({ rows: rs.map((r) => ({ ...r })), rowCount: rs.length });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return out([]);
    if (sql.includes("pg_input_is_valid(users.stats::text, 'jsonb')") && /SELECT \* FROM users WHERE/.test(sql)) {
      return out(rows.filter((r) => {
        const s = parseStatsColumn(r.stats);
        return s.masterUserId === params[0] && !(s.mergedInto != null && s.mergedInto !== '');
      }));
    }
    if (/SELECT \* FROM users WHERE username = ANY\(\$1::text\[\]\)/.test(sql)) {
      return out(rows.filter((r) => (params[0] as string[]).includes(r.username)).sort((a, b) => a.id - b.id).slice(0, 2));
    }
    if (/INSERT INTO users/.test(sql) && /ON CONFLICT DO NOTHING/.test(sql)) {
      const [username, display, hash, chips, level, xp, stats, isAdmin] = params;
      if (taken(username)) return out([]);
      const r: Row = { id: nextId++, username, display_name: display, password_hash: hash, chips, level, xp, stats, is_admin: !!isAdmin, banned: false };
      rows.push(r);
      return out([r]);
    }
    // The statement every OIDC sign-in used until 2026-10-11 (CONTROL only).
    if (/INSERT INTO users/.test(sql) && /ON CONFLICT \(LOWER\(username\)\) DO UPDATE/.test(sql)) {
      const [username, display, hash, stats, isAdmin] = params;
      const hit = taken(username);
      if (hit) {
        hit.display_name = hit.display_name ?? display;
        hit.is_admin = !!isAdmin || hit.is_admin;
        return out([hit]);
      }
      const r: Row = { id: nextId++, username, display_name: display, password_hash: hash, chips: 50_000, level: 1, xp: 0, stats, is_admin: !!isAdmin, banned: false };
      rows.push(r);
      return out([r]);
    }
    let m = /^UPDATE users SET stats = \$2, display_name = COALESCE\(display_name, \$3\) WHERE id = \$1 RETURNING \*$/.exec(sql.replace(/\s+/g, ' ').trim());
    if (m) {
      const r = rows.find((x) => x.id === params[0]);
      if (!r) return out([]);
      r.stats = params[1];
      r.display_name = r.display_name ?? params[2];
      return out([r]);
    }
    m = /^UPDATE users SET is_admin = TRUE WHERE id = \$1$/.exec(sql.trim());
    if (m) { const r = rows.find((x) => x.id === params[0]); if (r) r.is_admin = true; return out([]); }
    if (/^UPDATE users SET display_name = \$2 WHERE id = \$1 AND display_name IS NULL$/.test(sql.trim())) {
      const r = rows.find((x) => x.id === params[0]); if (r && r.display_name == null) r.display_name = params[1]; return out([]);
    }
    throw new Error(`fakeDb: unhandled statement: ${sql.slice(0, 120)}`);
  }
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  };
  return {
    pool, rows, statements,
    byId: (id: number) => rows.find((r) => r.id === id)!,
    owner: (id: number) => parseStatsColumn(rows.find((r) => r.id === id)!.stats).masterUserId ?? null,
    failOn: (needle: string) => { failNext = needle; },
  };
}

/** Prod-like table: the admin seed (row 1), an owned admin row, a guest, an unowned legacy name row, an unowned phone row, a tombstone, an owned phone row. */
function prodLike() {
  return fakeDb([
    { id: 1, username: '5550001111', display_name: null, is_admin: true, chips: 1_999_755_231, stats: '{}' },
    { id: 2, username: 'Owner Name', display_name: 'Owner Name', is_admin: true, chips: 4_085_433, stats: JSON.stringify({ masterUserId: 'owner-master' }) },
    { id: 3, username: 'Guest1971', chips: 58_593, stats: '{}' },
    { id: 4, username: 'Jane Doe', display_name: 'Jane Doe', chips: 80_000, level: 7, stats: '{}' },
    { id: 5, username: '5550002222', display_name: 'Phil P.', chips: 70_000, stats: '{}' },
    { id: 6, username: 'merged-6-5550004444', chips: 0, banned: true, stats: JSON.stringify({ mergedInto: 9 }) },
    { id: 7, username: '5550003333', display_name: 'Pat Q.', chips: 60_000, stats: JSON.stringify({ masterUserId: 'phone-owner' }) },
  ]);
}

/** The REAL upsertOidcLocalUser + upsertOidcLocalUserLocked from src/index.ts, on `db`. */
function realOidcUpsert(db: ReturnType<typeof fakeDb>) {
  const code = fnSrc('async function upsertOidcLocalUser(') + fnSrc('async function upsertOidcLocalUserLocked(');
  const merges: Array<[number, Record<string, unknown>]> = [];
  const loaded = load(code, {
    getPool: () => db.pool,
    findLocalUserByMasterId, identityStampPatch, withMasterLock, parseStatsColumn, createOrAdoptMasterRow, accountDisplayName,
    mergeUserStats: async (id: number, patch: Record<string, unknown>) => {
      merges.push([id, patch]);
      const r = db.byId(id);
      r.stats = JSON.stringify({ ...parseStatsColumn(r.stats), ...patch });
    },
    DEFAULT_CHIPS: 50_000, DEFAULT_LEVEL: 1, DEFAULT_XP: 0,
    Sentry: null,
    console: { log() {}, warn() {}, error() {} },
  }, '{ upsertOidcLocalUser, upsertOidcLocalUserLocked }');
  expect([...loaded.stubbed]).toEqual([]);
  /** Sign in as master `sub` with the token's username claim `claim` (and a signed phone claim, if any). */
  const signIn = (sub: string, claim: string, opts: { phoneClaim?: string; isAdmin?: boolean } = {}) =>
    loaded.exports.upsertOidcLocalUser({
      displayName: claim, sub, masterDisplayName: claim, masterPhone: opts.phoneClaim, isAdmin: !!opts.isAdmin, via: 'oauthLogin',
    });
  return { signIn, merges };
}

describe('AUTH-1 — a sign-in never binds or adopts a row because of a name (real upsertOidcLocalUser, prod-like table)', () => {
  it('CONTROL — the statement used until 2026-10-11 binds a renamed attacker to the unowned ADMIN seed (row 1) and to another master\'s row', async () => {
    const db = prodLike();
    // Verbatim shape of the old upsert (WARN mode — the live default).
    const oldUpsert = (key: string, sub: string) => db.pool.query(
      `INSERT INTO users (username, display_name, password_hash, chips, level, xp, stats, is_admin)
         VALUES ($1, $2, $3, 50000, 1, 0, $4, $5)
         ON CONFLICT (LOWER(username)) DO UPDATE
           SET display_name = COALESCE(users.display_name, $2),
               is_admin = ($5 OR users.is_admin)
       RETURNING *`,
      [key, key, 'h', JSON.stringify({ masterUserId: sub }), false],
    );
    const a = (await oldUpsert('5550001111', 'attacker-A')).rows[0];
    expect(a).toMatchObject({ id: 1, is_admin: true, chips: 1_999_755_231 });
    const b = (await oldUpsert('owner name', 'attacker-B')).rows[0];
    expect(b).toMatchObject({ id: 2, is_admin: true });
  });

  it('a new master whose claim EQUALS an existing username / display name gets a NEW row (owned or unowned, any letter case)', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    for (const [sub, claim, existingId] of [['atk-B', 'owner name', 2], ['atk-J', 'Jane Doe', 4], ['atk-A', '5550001111', 1]] as const) {
      const r = await signIn(sub, claim);
      expect(r.ok).toBe(true);
      expect(r.user.id).not.toBe(existingId);
      expect(r.user).toMatchObject({ username: masterRowUsername(sub), is_admin: false, chips: 50_000, level: 1 });
      expect(parseStatsColumn(r.user.stats)).toMatchObject({ masterUserId: sub });
      expect(r.how).toBe('created');
    }
    // The existing rows are untouched: same owner (or still unowned), same admin flag and chips.
    expect(db.byId(1)).toMatchObject({ is_admin: true, chips: 1_999_755_231 });
    expect(db.owner(1)).toBeNull();
    expect(db.byId(2)).toMatchObject({ is_admin: true, chips: 4_085_433 });
    expect(db.owner(2)).toBe('owner-master');
    expect(db.byId(4)).toMatchObject({ chips: 80_000, level: 7 });
    expect(db.owner(4)).toBeNull();
    // Nothing was ever upserted by name.
    expect(db.statements.some((s) => s.includes('ON CONFLICT (LOWER(username)) DO UPDATE'))).toBe(false);
  });

  it('a row OWNED by another master is never bound — not by name, not even by a matching signed phone claim', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const byName = await signIn('atk-C', 'Pat Q.');
    const byPhone = await signIn('atk-D', 'Pat Q.', { phoneClaim: '555-000-3333' });
    for (const r of [byName, byPhone]) {
      expect(r.ok).toBe(true);
      expect(r.user.id).not.toBe(7);
    }
    expect(db.owner(7)).toBe('phone-owner');
    expect(db.byId(7).chips).toBe(60_000);
  });

  it('the unowned ADMIN seed is never adopted — not by its digits as a name, not by a matching signed phone claim', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const before = masterRowStats.adoptionRefused.admin;
    const byName = await signIn('atk-E', '5550001111');
    const byPhone = await signIn('atk-F', 'Anyone', { phoneClaim: '+1 (555) 000-1111' });
    expect(byName.user.id).not.toBe(1);
    expect(byPhone.user.id).not.toBe(1);
    expect(byPhone.user.is_admin).toBe(false);
    expect(masterRowStats.adoptionRefused.admin).toBe(before + 1);
    expect(db.owner(1)).toBeNull();
  });

  it('a GuestNNNN row is never adopted (the guest carry-over has its own claim flow)', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const r = await signIn('atk-G', 'Guest1971');
    expect(r.user.id).not.toBe(3);
    expect(db.owner(3)).toBeNull();
    expect(db.byId(3).chips).toBe(58_593);
  });

  it('REAL PROOF: an unowned non-admin phone row is adopted by the master whose SIGNED phone claim matches — once; another master with the same phone gets a new row', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const phil = await signIn('phil-master', 'Phil Person', { phoneClaim: '(555) 000-2222' });
    expect(phil).toMatchObject({ ok: true, how: 'adopted_phone' });
    expect(phil.user.id).toBe(5);
    expect(db.owner(5)).toBe('phil-master');
    expect(db.byId(5)).toMatchObject({ chips: 70_000, display_name: 'Phil P.' });
    // Next sign-in: master-first, the same row, no lookup by name or phone.
    const again = await signIn('phil-master', 'Renamed Totally');
    expect(again).toMatchObject({ ok: true, how: 'master' });
    expect(again.user.id).toBe(5);
    // A different master presenting the same phone: the row is owned now.
    const other = await signIn('other-master', 'Phil Person', { phoneClaim: '5550002222' });
    expect(other.user.id).not.toBe(5);
    expect(db.owner(5)).toBe('phil-master');
  });

  it('an unverified phone (no phone claim — the NAME is digits) is no proof: a new row', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const r = await signIn('atk-H', '5550002222');
    expect(r.user.id).not.toBe(5);
    expect(db.owner(5)).toBeNull();
  });

  it('one master, one row: signing in twice (and with a changed name) finds the same row', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const first = await signIn('new-master', 'New Person');
    const second = await signIn('new-master', 'Owner Name');
    expect(second.user.id).toBe(first.user.id);
    expect(db.rows.filter((r) => parseStatsColumn(r.stats).masterUserId === 'new-master')).toHaveLength(1);
  });

  it('a new row shows a whitelist-valid display name, never its m: username', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const long = await signIn('long-name', 'Christopher Montgomery-Smithson');
    expect(long.user.display_name).toBe('Christopher M.');
    const odd = await signIn('odd-name', '美琪 王');
    expect(odd.user.display_name).toBe('Player');
    const phoney = await signIn('phone-name', '7205551234');
    expect(phoney.user.display_name).toBe('Player');
  });

  it('a master lookup that cannot be answered refuses the sign-in (user_upsert_failed) and inserts nothing', async () => {
    const db = prodLike();
    const { signIn } = realOidcUpsert(db);
    const n = db.rows.length;
    // findLocalUserByMasterId retries; make every attempt fail.
    const origQuery = db.pool.query;
    (db.pool as any).query = async (sql: string, params: any[]) => {
      if (sql.includes("pg_input_is_valid(users.stats::text, 'jsonb')")) throw new Error('pool timeout');
      return origQuery(sql, params);
    };
    const r = await signIn('blip-master', 'Blip Person');
    expect(r).toMatchObject({ ok: false, code: 'user_upsert_failed' });
    expect(db.rows).toHaveLength(n);
  });
});

describe('createOrAdoptMasterRow — edge cases', () => {
  const args = (masterUserId: string, extra: Record<string, unknown> = {}) => ({
    masterUserId, displayName: 'Some One', via: 'test', defaults: { chips: 50_000, level: 1, xp: 0 }, ...extra,
  });

  it('the m:<id> key held by a row of ANOTHER master is never bound: the new row gets a suffixed key', async () => {
    const db = fakeDb([{ id: 1, username: 'm:victim-x', stats: JSON.stringify({ masterUserId: 'someone-else' }), chips: 99_000 }]);
    const r = await createOrAdoptMasterRow({ pool: db.pool as any }, args('victim-x'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.id).not.toBe(1);
    expect(r.user.username).toMatch(/^m:victim-x:[0-9a-f]{8}$/);
    expect(parseStatsColumn(r.user.stats).masterUserId).toBe('victim-x');
    expect(db.owner(1)).toBe('someone-else');
  });

  it('a row the SAME master created a moment ago (another process) is returned, not duplicated', async () => {
    const db = fakeDb([{ id: 1, username: 'm:racer', stats: JSON.stringify({ masterUserId: 'racer' }) }]);
    const r = await createOrAdoptMasterRow({ pool: db.pool as any }, args('racer'));
    expect(r).toMatchObject({ ok: true, how: 'found_after_race' });
    if (r.ok) expect(r.user.id).toBe(1);
    expect(db.rows).toHaveLength(1);
  });

  it('a DB error is { ok:false, user_upsert_failed } — never a guess', async () => {
    const db = fakeDb([]);
    db.failOn('INSERT INTO users');
    const r = await createOrAdoptMasterRow({ pool: db.pool as any }, args('m1'));
    expect(r).toMatchObject({ ok: false, code: 'user_upsert_failed' });
  });

  it('a new row never has a usable password (bcrypt.compare is false for it) and is_admin only as passed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bcrypt = require('bcryptjs');
    const db = fakeDb([]);
    const r = await createOrAdoptMasterRow({ pool: db.pool as any }, args('m2', { isAdmin: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.is_admin).toBe(true);
    expect(r.user.password_hash.startsWith('!no-password:')).toBe(true);
    expect(await bcrypt.compare('', r.user.password_hash)).toBe(false);
    expect(await bcrypt.compare(r.user.password_hash, r.user.password_hash)).toBe(false);
  });
});

describe('adoption rule + keys (pure)', () => {
  it('adoptionRefusalReason', () => {
    const phone = '5550002222';
    expect(adoptionRefusalReason({ username: '5550002222', stats: '{}' }, phone)).toBeNull();
    expect(adoptionRefusalReason({ username: '+15550002222', stats: '{}' }, phone)).toBeNull();
    expect(adoptionRefusalReason({ username: '5550002222', stats: '{"masterUserId":"x"}' }, phone)).toBe('owned');
    expect(adoptionRefusalReason({ username: '5550002222', stats: '{"mergedInto":4}' }, phone)).toBe('tombstone');
    expect(adoptionRefusalReason({ username: 'merged-9-5550002222', stats: '{}' }, phone)).toBe('tombstone');
    expect(adoptionRefusalReason({ username: '5550002222', stats: '{}', is_admin: true }, phone)).toBe('admin');
    expect(adoptionRefusalReason({ username: 'Guest42', stats: '{}' }, phone)).toBe('guest');
    expect(adoptionRefusalReason({ username: '5550002222', stats: '{}' }, null)).toBe('no_proof');
    expect(adoptionRefusalReason({ username: '5550009999', stats: '{}' }, phone)).toBe('phone_mismatch');
    expect(adoptionRefusalReason({ username: 'Jane Doe', stats: '{}' }, phone)).toBe('phone_mismatch');
  });

  it('normalizePhoneKey / masterRowUsername / isGuestUsername', () => {
    expect(normalizePhoneKey('(555) 000-2222')).toBe('5550002222');
    expect(normalizePhoneKey('+1 555 000 2222')).toBe('5550002222');
    expect(normalizePhoneKey('15550002222')).toBe('5550002222');
    expect(normalizePhoneKey('555000222')).toBeNull();
    expect(normalizePhoneKey('josh.hall2')).toBeNull();
    expect(normalizePhoneKey(undefined)).toBeNull();
    expect(masterRowUsername('abc-123')).toBe('m:abc-123');
    expect(isGuestUsername('Guest1971')).toBe(true);
    expect(isGuestUsername('guest1971')).toBe(false);
  });

  it('display-name rule (same whitelist as setDisplayName; never a phone number)', () => {
    expect(toWhitelistDisplayName('Josh Hall')).toBe('Josh Hall');
    expect(toWhitelistDisplayName('  Josh   Hall ')).toBe('Josh Hall');
    expect(toWhitelistDisplayName("O'Brien-Smith")).toBe("O'Brien-Smith");
    expect(toWhitelistDisplayName('Christopher Montgomery')).toBe('Christopher M.');
    expect(toWhitelistDisplayName('João Silva')).toBeNull();
    expect(toWhitelistDisplayName('<b>x</b>')).toBeNull();
    expect(toWhitelistDisplayName('7205551234')).toBeNull();
    expect(toWhitelistDisplayName('720-555-1234')).toBeNull();
    expect(toWhitelistDisplayName('m:4f1c-uuid')).toBeNull();
    expect(toWhitelistDisplayName({ toString: () => 'x' })).toBeNull();
    expect(toWhitelistDisplayName(42)).toBeNull();
    expect(accountDisplayName(null)).toBe('Player');
    expect(isWhitelistDisplayName('A')).toBe(false);
    expect(isWhitelistDisplayName('Ace 77')).toBe(true);
  });
});

describe('wiring — no sign-in path resolves a row by a name any more', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  /** Code only: comments dropped so prose naming a statement cannot satisfy or trip a scan. */
  const code = SRC.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

  it('index.ts has no ON CONFLICT (LOWER(username)) DO UPDATE and no warn/enforce guard', () => {
    expect(code).not.toMatch(/ON CONFLICT \(LOWER\(username\)\) DO UPDATE/);
    expect(code).not.toContain('IDENTITY_GUARD_MODE');
    expect(code).not.toContain('masterIdGuardSql(');
  });

  it('upsertOidcLocalUserLocked: master-first, then createOrAdoptMasterRow with ONLY the signed phone claim as proof', () => {
    const fn = fnSrc('async function upsertOidcLocalUserLocked(');
    const lookupAt = fn.indexOf('findLocalUserByMasterId(getPool(), String(sub))');
    const createAt = fn.indexOf('createOrAdoptMasterRow({ pool: getPool() }, {');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(lookupAt);
    expect(fn).toContain('verifiedPhone: masterPhone ?? null,');
    expect(fn).not.toContain('INSERT INTO users');
  });

  it('authWithTicket 3b and the waitlist bootstrap create the row with createOrAdoptMasterRow under withMasterLock', () => {
    const tk = SRC.slice(SRC.indexOf("trackLogin(socket, 'authWithTicket'"), SRC.indexOf("'resumeSession',"));
    const tkLock = tk.indexOf('await withMasterLock(String(remoteUserId), async () => {');
    expect(tkLock).toBeGreaterThan(-1);
    const tkCreate = tk.indexOf('createOrAdoptMasterRow({ pool: getPool() }, {');
    expect(tkCreate).toBeGreaterThan(tkLock);
    expect(tk.indexOf("via: 'authWithTicket',", tkCreate)).toBeGreaterThan(tkCreate);
    expect(tk).not.toContain('INSERT INTO users');
    const wl = SRC.slice(SRC.indexOf("'joinWithWaitlistContext',"), SRC.indexOf("socket.on('selectPineappleDiscard'"));
    const wlLock = wl.indexOf('await withMasterLock(String(remoteUserId), async () => {');
    expect(wlLock).toBeGreaterThan(-1);
    const wlCreate = wl.indexOf('createOrAdoptMasterRow({ pool: getPool() }, {');
    expect(wlCreate).toBeGreaterThan(wlLock);
    expect(wl.indexOf("via: 'joinWithWaitlistContext',", wlCreate)).toBeGreaterThan(wlCreate);
    // The old by-phone lookup bound ANY row with that username — gone.
    expect(wl).not.toContain("'SELECT id, username, stats FROM users WHERE username = $1 LIMIT 1'");
  });
});

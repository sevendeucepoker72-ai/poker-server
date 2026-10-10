/**
 * 2026-10-09 — R2: guest progress carry-over (src/auth/guestClaim.ts, wired
 * as `claimGuestProgress` / `peekGuestProgress` in src/index.ts).
 *
 * Fixtures are the real shapes of the two former guests named by the owner
 * (read-only prod query 2026-10-09): Guest1971 "PappyR" (4203) — 58,593 chips,
 * level 6 / 254 xp, 199 stars, 2 achievements, token_version 0;
 * Guest9629 "Marvin a" (4402) — 15,000 chips, level 2 / 100 xp, 45 stars,
 * 1 achievement, token_version 0. stats/achievements are TEXT on prod.
 *
 * Pins:
 *   - success moves chips + stars (guest debited, caller credited — additive),
 *     level/xp by GREATEST ratchet, achievements as a union; the guest row is
 *     retired (stats.claimedBy/claimedAt + reversal record, token_version+1);
 *   - a DOUBLE TAP credits once: the second transaction waits on the guest
 *     row lock and then sees it claimed (already_claimed);
 *   - not_a_guest (master stamp, or not a GuestNNNN row) / same_account /
 *     invalid_guest_token (bad signature, token_version mismatch, banned,
 *     missing row) / not_signed_in;
 *   - END TO END with real HS256 tokens: an EXPIRED-but-signed guest token is
 *     accepted (no age cap), a forged one is not, and the claim makes the
 *     token single-use;
 *   - peek reads without writing;
 *   - the Postgres implementation: FOR UPDATE, chips moved by authManager's
 *     OWN deductChips / addChipsToUser statements on the transaction client,
 *     never an absolute chips value, no jsonb operators (prod stats is TEXT),
 *     ROLLBACK on error.
 */

import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import {
  claimGuestProgress, peekGuestProgress, createPgGuestClaimDb, planGuestClaim, guestRowState, parseAchievements, guestRowClaimedByCaller,
  claimResultFrame, GUEST_CLAIM_MESSAGES, GUEST_USERNAME_PATTERN, GUEST_CLAIM_CUTOFF_ISO,
  type ClaimUserRow, type GuestClaimDb, type GuestClaimTx, type GuestClaimDeps, type GuestTokenCheck,
} from '../src/auth/guestClaim';

// authManager reads JWT_SECRET at import time — set it first, then require
// (ProgressionManager imports authManager, so it is required after too).
const TEST_JWT_SECRET = 'unit-test-jwt-secret-guest-claim';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_JWT_SECRET;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authManager = require('../src/auth/authManager') as typeof import('../src/auth/authManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const progression = require('../src/progression/ProgressionManager') as typeof import('../src/progression/ProgressionManager');
afterAll(() => {
  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
});

const CALLER_ID = 512;
const CALLER_MASTER = '16899b30-fcc1-4be1-94f9-47f54cacf240';
const GUEST_ID = 4203;
const GUEST_TOKEN = 'legacy.guest.token';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// created_at values are the REAL ones (read-only prod query 2026-10-09).
function pappyR(over: Partial<ClaimUserRow> = {}): ClaimUserRow {
  return {
    id: GUEST_ID, username: 'Guest1971', display_name: 'PappyR',
    chips: 58593, stars: 199, level: 6, xp: 254,
    achievements: JSON.stringify(['first_win', 'hands_100']),
    stats: JSON.stringify({ handsPlayed: 812, handsWon: 120, biggestPot: 9000, lastHandAt: 1 }),
    banned: false, token_version: 0, created_at: '2026-08-21T01:48:18.979Z',
    ...over,
  };
}

function marvin(over: Partial<ClaimUserRow> = {}): ClaimUserRow {
  return {
    id: 4402, username: 'Guest9629', display_name: 'Marvin a',
    chips: 15000, stars: 45, level: 2, xp: 100,
    achievements: JSON.stringify(['first_win']),
    stats: JSON.stringify({ handsPlayed: 40, handsWon: 6, biggestPot: 1200, lastHandAt: 1 }),
    banned: false, token_version: 0, created_at: '2026-09-07T03:18:53.978Z',
    ...over,
  };
}

function account(over: Partial<ClaimUserRow> = {}): ClaimUserRow {
  return {
    id: CALLER_ID, username: 'josh.hall2', display_name: 'Josh H.',
    chips: 50000, stars: 10, level: 3, xp: 40,
    achievements: JSON.stringify(['first_win']),
    stats: JSON.stringify({ masterUserId: CALLER_MASTER, handsPlayed: 30 }),
    banned: false, token_version: 0, created_at: '2026-05-19T00:00:00.000Z',
    ...over,
  };
}

/**
 * In-memory users table with Postgres-like row locks: lockUser() blocks
 * until the row's previous holder's transaction ends, then reads the
 * COMMITTED row (READ COMMITTED re-read after a lock wait). Writes are
 * staged and applied at commit; a throw discards them (rollback).
 */
class FakeUsersDb implements GuestClaimDb {
  rows = new Map<number, ClaimUserRow>();
  private lockTails = new Map<number, Promise<void>>();
  commits = 0;
  rollbacks = 0;

  constructor(rows: ClaimUserRow[]) { for (const r of rows) this.rows.set(r.id, clone(r)); }

  async readUser(id: number) { const r = this.rows.get(id); return r ? clone(r) : null; }

  /** S4 — committed rows only (what a plain read / a statement after the caller lock sees). */
  async findGuestClaimedBy(callerId: number, callerMaster: string, overlay?: Map<number, ClaimUserRow>) {
    const ids = new Set<number>([...this.rows.keys(), ...(overlay ? overlay.keys() : [])]);
    for (const id of ids) {
      const r = (overlay && overlay.get(id)) || this.rows.get(id);
      if (r && id !== callerId && guestRowClaimedByCaller(r.stats, callerId, callerMaster)) return id;
    }
    return null;
  }

  async transaction<T>(fn: (tx: GuestClaimTx) => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    const staged = new Map<number, ClaimUserRow>();
    const current = (id: number) => clone((staged.get(id) || this.rows.get(id)) as ClaimUserRow);
    const tx: GuestClaimTx = {
      lockUser: async (id) => {
        const prev = this.lockTails.get(id) || Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((r) => { release = r; });
        this.lockTails.set(id, prev.then(() => mine));
        await prev;
        releases.push(release);
        await new Promise((r) => setImmediate(r)); // let a concurrent tx interleave
        return this.rows.has(id) || staged.has(id) ? current(id) : null;
      },
      findGuestClaimedBy: (callerId, callerMaster) => this.findGuestClaimedBy(callerId, callerMaster, staged),
      retireGuest: async (id, p) => {
        const r = current(id);
        r.chips = (r.chips || 0) - p.chips;
        r.stars = (r.stars || 0) - p.stars;
        r.token_version = (r.token_version || 0) + 1;
        r.stats = p.statsJson;
        staged.set(id, r);
      },
      creditCaller: async (id, p) => {
        const r = current(id);
        const lvl = r.level || 1;
        r.chips = (r.chips || 0) + p.chips;
        r.stars = (r.stars || 0) + p.stars;
        r.xp = p.guestLevel > lvl ? p.guestXp : p.guestLevel === lvl ? Math.max(r.xp || 0, p.guestXp) : r.xp;
        r.level = Math.max(lvl, p.guestLevel);
        r.achievements = p.achievementsJson;
        staged.set(id, r);
        return { chips: r.chips as number, stars: r.stars as number, level: r.level, xp: r.xp as number };
      },
    };
    try {
      const out = await fn(tx);
      for (const [id, r] of staged) this.rows.set(id, r);
      this.commits++;
      return out;
    } catch (e) {
      this.rollbacks++;
      throw e;
    } finally {
      releases.forEach((r) => r());
    }
  }
}

/** The username each fixture row's legacy token was minted for (generateToken: {userId, username, tokenVersion}). */
const USERNAME_OF: Record<number, string> = { [GUEST_ID]: 'Guest1971', 4402: 'Guest9629', [CALLER_ID]: 'josh.hall2' };
const okToken = (userId = GUEST_ID, tokenVersion = 0, username: string | null = USERNAME_OF[userId] ?? null) =>
  (): GuestTokenCheck => ({ ok: true, userId, tokenVersion, username });

function deps(db: GuestClaimDb, verify: (t: unknown) => GuestTokenCheck = okToken()): GuestClaimDeps {
  return { db, verifyGuestToken: verify, now: () => Date.UTC(2026, 9, 9, 20, 0, 0) };
}

const input = (over: Record<string, unknown> = {}) => ({
  callerLocalId: CALLER_ID, callerMasterId: CALLER_MASTER, guestToken: GUEST_TOKEN, ...over,
});

describe('claimGuestProgress — success (PappyR → his account)', () => {
  it('moves chips + stars additively, ratchets level/xp, unions achievements, retires the guest row', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const r = await claimGuestProgress(deps(db), input());
    expect(r).toEqual({
      success: true, guestUserId: GUEST_ID, chipsAdded: 58593, starsAdded: 199,
      levelAfter: 6, xpAfter: 254, achievementsAdded: 1,
      achievementIdsAdded: ['hands_100'], levelAchievementsMarkedEarned: [],
    });
    // The client frame carries exactly the contract fields.
    expect(claimResultFrame(r)).toEqual({
      success: true, guestUserId: GUEST_ID, chipsAdded: 58593, starsAdded: 199,
      levelAfter: 6, xpAfter: 254, achievementsAdded: 1,
    });
    const caller = db.rows.get(CALLER_ID)!;
    expect(caller.chips).toBe(50000 + 58593);
    expect(caller.stars).toBe(10 + 199);
    expect(caller.level).toBe(6);
    expect(caller.xp).toBe(254);
    expect(parseAchievements(caller.achievements)).toEqual(['first_win', 'hands_100']);
    // Caller's other stats untouched (hand counters are NOT merged).
    expect(JSON.parse(String(caller.stats))).toEqual({ masterUserId: CALLER_MASTER, handsPlayed: 30 });

    const guest = db.rows.get(GUEST_ID)!;
    expect(guest.chips).toBe(0);
    expect(guest.stars).toBe(0);
    expect(guest.token_version).toBe(1); // the guest token (and sessions from it) stop working
    const gs = JSON.parse(String(guest.stats));
    expect(gs).toMatchObject({
      claimedBy: CALLER_ID, claimedByMasterUserId: CALLER_MASTER, claimedAt: '2026-10-09T20:00:00.000Z',
      claimedChips: 58593, claimedStars: 199, claimedLevel: 6, claimedXp: 254,
      claimedAchievements: ['first_win', 'hands_100'],
      handsPlayed: 812, // original stats kept — the row is retired, not wiped
    });
    expect(gs.masterUserId).toBeUndefined(); // never linked to the account
    // The row is still there (retired, never deleted), username unchanged.
    expect(guest.username).toBe('Guest1971');
    // Chip conservation across the two rows.
    expect((caller.chips as number) + (guest.chips as number)).toBe(50000 + 58593);
  });

  it('Marvin a (4402): a lower-level guest never lowers the caller', async () => {
    const db = new FakeUsersDb([marvin(), account()]);
    const r = await claimGuestProgress(deps(db, okToken(4402)), input());
    expect(r).toMatchObject({ success: true, guestUserId: 4402, chipsAdded: 15000, starsAdded: 45, levelAfter: 3, xpAfter: 40, achievementsAdded: 0 });
    expect(db.rows.get(CALLER_ID)!.chips).toBe(65000);
  });

  it('never LOWERS the caller: higher caller level keeps its own level and xp', async () => {
    const db = new FakeUsersDb([pappyR({ level: 2, xp: 100 }), account({ level: 9, xp: 5 })]);
    const r = await claimGuestProgress(deps(db), input());
    expect(r).toMatchObject({ success: true, levelAfter: 9, xpAfter: 5 });
  });

  it('same level: the higher xp wins', async () => {
    const db = new FakeUsersDb([pappyR({ level: 3, xp: 10 }), account({ level: 3, xp: 40 })]);
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: true, levelAfter: 3, xpAfter: 40 });
  });

  it('a zero-chip guest is still claimable (progress only)', async () => {
    const db = new FakeUsersDb([pappyR({ chips: 0, stars: 0 }), account()]);
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: true, chipsAdded: 0, starsAdded: 0 });
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });
});

describe('claimGuestProgress — one claim per guest row', () => {
  it('a DOUBLE TAP (two concurrent claims) credits exactly once; the second sees already_claimed', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const [a, b] = await Promise.all([claimGuestProgress(deps(db), input()), claimGuestProgress(deps(db), input())]);
    const results = [a, b];
    expect(results.filter((r) => r.success)).toHaveLength(1);
    const loser = results.find((r) => !r.success) as any;
    expect(loser).toMatchObject({ success: false, code: 'already_claimed', error: GUEST_CLAIM_MESSAGES.already_claimed });
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000 + 58593); // NOT + 2×58593
    expect(db.rows.get(CALLER_ID)!.stars).toBe(10 + 199);
    expect(db.rows.get(GUEST_ID)!.chips).toBe(0);
  });

  it('five concurrent taps still credit once', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const results = await Promise.all(Array.from({ length: 5 }, () => claimGuestProgress(deps(db), input())));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success).every((r: any) => r.code === 'already_claimed')).toBe(true);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000 + 58593);
  });

  it('already_claimed: a claim INTO A DIFFERENT account after the first is refused too', async () => {
    const other = account({ id: 777, stats: JSON.stringify({ masterUserId: 'other-master' }) });
    const db = new FakeUsersDb([pappyR(), account(), other]);
    expect((await claimGuestProgress(deps(db), input())).success).toBe(true);
    const second = await claimGuestProgress(deps(db), input({ callerLocalId: 777, callerMasterId: 'other-master' }));
    expect(second).toMatchObject({ success: false, code: 'already_claimed' });
    expect(db.rows.get(777)!.chips).toBe(50000);
  });
});

describe('claimGuestProgress — refusals (contract codes)', () => {
  it('not_signed_in: no attested master id on the caller session', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    expect(await claimGuestProgress(deps(db), input({ callerMasterId: undefined }))).toMatchObject({ success: false, code: 'not_signed_in' });
    expect(await claimGuestProgress(deps(db), input({ callerLocalId: undefined }))).toMatchObject({ success: false, code: 'not_signed_in' });
    expect(db.commits).toBe(0);
  });

  it('invalid_guest_token: the legacy verifier rejects it (bad signature)', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const r = await claimGuestProgress(deps(db, () => ({ ok: false, reason: 'invalid' })), input());
    expect(r).toMatchObject({ success: false, code: 'invalid_guest_token' });
    expect(db.rows.get(GUEST_ID)!.chips).toBe(58593);
  });

  it('invalid_guest_token: the token predates a token_version bump', async () => {
    const db = new FakeUsersDb([pappyR({ token_version: 2 }), account()]);
    expect(await claimGuestProgress(deps(db, okToken(GUEST_ID, 1)), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
  });

  it('invalid_guest_token: token_version must MATCH (a token claiming a newer version is refused too)', async () => {
    const db = new FakeUsersDb([pappyR({ token_version: 0 }), account()]);
    expect(await claimGuestProgress(deps(db, okToken(GUEST_ID, 1)), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });

  it('invalid_guest_token: banned guest row, or no such row', async () => {
    const db = new FakeUsersDb([pappyR({ banned: true }), account()]);
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
    const db2 = new FakeUsersDb([account()]);
    expect(await claimGuestProgress(deps(db2), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
  });

  it.each([
    ['masterUserId', { masterUserId: 'abc' }],
    ['masterUsername', { masterUsername: 'someone' }],
    ['masterPhone', { masterPhone: '7205550100' }],
  ])('not_a_guest: the row carries a master identity stamp (%s)', async (_k, stamp) => {
    const db = new FakeUsersDb([pappyR({ stats: JSON.stringify(stamp) }), account()]);
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: false, code: 'not_a_guest' });
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });

  it.each([
    ['a phone-keyed account row with no stamp (1 such row on prod)', '7205550100'],
    ['a slug-keyed account row with no stamp', 'someone.else'],
    ['a display-name-keyed row', 'Josh Hall'],
  ])('not_a_guest: %s — only GuestNNNN rows are guests', async (_label, username) => {
    const db = new FakeUsersDb([pappyR({ username, stats: '{"handsPlayed":3}' }), account()]);
    // The row's OWN legacy token (username claim = the row's username).
    const own = okToken(GUEST_ID, 0, username);
    expect(await claimGuestProgress(deps(db, own), input())).toMatchObject({ success: false, code: 'not_a_guest' });
    expect(await peekGuestProgress(deps(db, own), input())).toMatchObject({ success: false, code: 'not_a_guest' });
    expect(db.rows.get(GUEST_ID)!.chips).toBe(58593);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });

  it('same_account: the guest token is for the caller\'s own row', async () => {
    const db = new FakeUsersDb([account()]);
    expect(await claimGuestProgress(deps(db, okToken(CALLER_ID)), input())).toMatchObject({ success: false, code: 'same_account' });
  });

  it('a failure mid-transaction rolls back: nothing moves', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const broken: GuestClaimDb = {
      readUser: (id) => db.readUser(id),
      findGuestClaimedBy: (a, b) => db.findGuestClaimedBy(a, b),
      transaction: (fn) => db.transaction((tx) => fn({ ...tx, creditCaller: async () => { throw new Error('boom'); } })),
    };
    await expect(claimGuestProgress(deps(broken), input())).rejects.toThrow('boom');
    expect(db.rollbacks).toBe(1);
    expect(db.rows.get(GUEST_ID)!.chips).toBe(58593);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
    expect(guestRowState(db.rows.get(GUEST_ID)!)).toBe('guest');
  });
});

describe('peekGuestProgress — read-only', () => {
  it('reports chips / stars / level / xp / achievement count / name without writing', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const before = clone([...db.rows.values()]);
    expect(await peekGuestProgress(deps(db), input())).toEqual({
      success: true, guestUserId: GUEST_ID, chips: 58593, stars: 199, level: 6, xp: 254,
      achievementsCount: 2, displayName: 'PappyR',
    });
    expect([...db.rows.values()]).toEqual(before);
    expect(db.commits).toBe(0);
  });

  it('applies the same refusals', async () => {
    const db = new FakeUsersDb([pappyR({ stats: JSON.stringify({ claimedBy: 1 }) }), account()]);
    expect(await peekGuestProgress(deps(db), input())).toMatchObject({ success: false, code: 'already_claimed' });
    expect(await peekGuestProgress(deps(db), input({ callerMasterId: '' }))).toMatchObject({ success: false, code: 'not_signed_in' });
  });
});

describe('END TO END with real legacy HS256 tokens (authManager.verifyLegacyTokenClaims)', () => {
  const NOW = Date.UTC(2026, 9, 9, 20, 0, 0);
  const nowSec = Math.floor(NOW / 1000);
  // The legacy token generateToken mints: { userId, username, tokenVersion }, 7d.
  const legacyToken = (userId: number, iatSec: number, extra: Record<string, unknown> = {}, secret = TEST_JWT_SECRET) =>
    jwt.sign({ userId, username: 'Guest1971', tokenVersion: 0, iat: iatSec, exp: iatSec + 7 * 86400, ...extra }, secret);
  // Exactly what src/index.ts wires: allowExpired for peek/claim only.
  const realVerify = (token: unknown): GuestTokenCheck => {
    const v = authManager.verifyLegacyTokenClaims(token, { allowExpired: true, nowMs: NOW });
    return v.ok ? { ok: true, userId: v.userId, tokenVersion: v.tokenVersion, username: v.username } : { ok: false, reason: v.reason };
  };

  it('PappyR: his token from his last visit (2026-08-21, expired 2026-08-28) is accepted — no age cap', async () => {
    const lastVisit = Math.floor(Date.UTC(2026, 7, 21, 1, 48, 0) / 1000);
    const token = legacyToken(GUEST_ID, lastVisit);
    // A LOGIN with it is still refused (expired) — only the claim waives exp.
    expect(authManager.verifyLegacyTokenClaims(token, { nowMs: NOW })).toEqual({ ok: false, reason: 'expired' });
    const db = new FakeUsersDb([pappyR(), account()]);
    const d = { db, verifyGuestToken: realVerify, now: () => NOW };
    expect(await peekGuestProgress(d, input({ guestToken: token }))).toMatchObject({ success: true, chips: 58593, level: 6, achievementsCount: 2 });
    expect(await claimGuestProgress(d, input({ guestToken: token }))).toMatchObject({ success: true, chipsAdded: 58593, starsAdded: 199, levelAfter: 6 });
  });

  it('a token that expired YEARS ago is still accepted when correctly signed', async () => {
    const token = legacyToken(GUEST_ID, nowSec - 3 * 365 * 86400);
    expect(realVerify(token)).toEqual({ ok: true, userId: GUEST_ID, tokenVersion: 0, username: 'Guest1971' });
    const db = new FakeUsersDb([pappyR(), account()]);
    expect(await claimGuestProgress({ db, verifyGuestToken: realVerify }, input({ guestToken: token }))).toMatchObject({ success: true });
  });

  it('the claim makes the token SINGLE-USE (token_version bumped → the same token is refused after)', async () => {
    const token = legacyToken(GUEST_ID, nowSec - 60 * 86400);
    const db = new FakeUsersDb([pappyR(), account()]);
    const d = { db, verifyGuestToken: realVerify };
    expect((await claimGuestProgress(d, input({ guestToken: token }))).success).toBe(true);
    // already_claimed wins (the row is retired) — and the version moved on too.
    expect(await claimGuestProgress(d, input({ guestToken: token }))).toMatchObject({ success: false, code: 'already_claimed' });
    expect(db.rows.get(GUEST_ID)!.token_version).toBe(1);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000 + 58593);
  });

  it('FORGED: signed with another secret, tampered payload, or alg:none → invalid_guest_token, nothing moves', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const d = { db, verifyGuestToken: realVerify };
    const wrongKey = legacyToken(GUEST_ID, nowSec - 60 * 86400, {}, 'attacker-guess');
    const good = legacyToken(4402, nowSec - 60 * 86400);
    const [h, , s] = good.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ userId: GUEST_ID, tokenVersion: 0, iat: nowSec - 100, exp: nowSec - 50 })).toString('base64url')}.${s}`;
    const none = jwt.sign({ userId: GUEST_ID, tokenVersion: 0 }, '', { algorithm: 'none' as any });
    for (const t of [wrongKey, tampered, none, 'garbage', undefined]) {
      expect(await claimGuestProgress(d, input({ guestToken: t }))).toMatchObject({ success: false, code: 'invalid_guest_token' });
    }
    expect(db.rows.get(GUEST_ID)!.chips).toBe(58593);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });

  it('a resume token is not a guest token (different derived key)', () => {
    const resumeKey = authManager.getScopedSigningKey('poker-server/online_resume/v1')!;
    const resumeLike = jwt.sign({ userId: GUEST_ID, tokenVersion: 0, kind: 'online_resume' }, resumeKey);
    expect(realVerify(resumeLike)).toMatchObject({ ok: false });
  });
});

describe('planGuestClaim / guestRowState — pure helpers', () => {
  it('already-claimed wins over a stamp (a double tap reads as already_claimed)', () => {
    const created_at = '2026-08-21T01:48:18.979Z';
    expect(guestRowState({ username: 'Guest1971', stats: { claimedBy: 1, masterUserId: 'x' } })).toBe('already_claimed');
    expect(guestRowState({ username: 'Guest1971', stats: '{"handsPlayed":1}', created_at })).toBe('guest');
    expect(guestRowState({ username: 'Guest1971', stats: null, created_at })).toBe('guest');
    expect(guestRowState({ username: 'Guest1971', stats: 'not json', created_at })).toBe('guest');
    expect(guestRowState({ username: ' Guest1971 ', stats: null, created_at })).toBe('guest'); // trimmed, case-insensitive
    expect(guestRowState({ username: 'guest1971', stats: null, created_at })).toBe('guest');
    expect(guestRowState({ username: null, stats: null, created_at })).toBe('not_a_guest');
    // D2: no creation time → not claimable.
    expect(guestRowState({ username: 'Guest1971', stats: null })).toBe('not_a_guest');
  });

  it('GuestNNNN is the old guest flow\'s username (poker-3d LoginScreen `Guest${1000..9999}`)', () => {
    for (const u of ['Guest1971', 'Guest9629', 'guest1000']) expect(GUEST_USERNAME_PATTERN.test(u)).toBe(true);
    for (const u of ['PappyR', 'Guest', 'Guest12a', '7205550100', 'josh.hall2', 'xGuest1971']) expect(GUEST_USERNAME_PATTERN.test(u)).toBe(false);
  });

  it('negative / null balances never produce a negative transfer', () => {
    const p = planGuestClaim(pappyR({ chips: -5, stars: null }), account(), { callerLocalId: 1, callerMasterId: 'm', nowIso: 'now' });
    expect(p.chips).toBe(0);
    expect(p.stars).toBe(0);
  });
});

describe('createPgGuestClaimDb — the SQL (prod: stats/achievements are TEXT)', () => {
  // The REAL authManager chip paths, run against the fake transaction client.
  const realChipPaths = { deductChips: authManager.deductChips, addChipsToUser: authManager.addChipsToUser };

  function fakePg(rowsById: Map<number, ClaimUserRow>, opts: { failCredit?: boolean } = {}) {
    const queries: Array<{ text: string; params: unknown[]; via: 'client' | 'pool' }> = [];
    const client = {
      released: 0,
      async query(text: string, params: unknown[] = []) {
        queries.push({ text, params, via: 'client' });
        if (/FOR UPDATE/.test(text)) {
          const r = rowsById.get(Number(params[0]));
          return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 };
        }
        if (/SET chips = chips - \$1/.test(text)) return { rows: [], rowCount: 1 };
        if (/SET chips = chips \+ \$1/.test(text)) {
          if (opts.failCredit) throw new Error('db down');
          return { rows: [], rowCount: 1 };
        }
        if (/RETURNING chips, stars, level, xp/.test(text)) return { rows: [{ chips: 108593, stars: 209, level: 6, xp: 254 }], rowCount: 1 };
        if (/^\s*UPDATE users/.test(text)) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() { this.released++; },
    };
    const pool = {
      query: async (t: string, p?: unknown[]) => { queries.push({ text: t, params: p || [], via: 'pool' }); return { rows: [], rowCount: 0 }; },
      connect: async () => client,
    };
    return { pool, client, queries };
  }

  it('locks guest then caller FOR UPDATE; chips move via authManager.deductChips / addChipsToUser ON THE TX CLIENT; commits', async () => {
    const { pool, client, queries } = fakePg(new Map([[GUEST_ID, pappyR()], [CALLER_ID, account()]]));
    const r = await claimGuestProgress(deps(createPgGuestClaimDb(pool, realChipPaths)), input());
    expect(r).toMatchObject({ success: true, chipsAdded: 58593, starsAdded: 199, levelAfter: 6 });
    // Everything ran inside the transaction — nothing on the shared pool.
    expect(queries.every((q) => q.via === 'client')).toBe(true);
    const texts = queries.map((q) => q.text.replace(/\s+/g, ' ').trim());
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toMatch(/FROM users WHERE id = \$1 FOR UPDATE$/);
    expect(queries[1].params).toEqual([GUEST_ID]);
    expect(queries[2].params).toEqual([CALLER_ID]);
    // S4: with the caller row LOCKED, the one-claim-per-account scan (plain
    // substring filter on the TEXT column — no jsonb operator).
    expect(texts[3]).toBe("SELECT id, stats FROM users WHERE stats::text LIKE '%claimedBy%'");
    // Guest debit: authManager.deductChips' own statement, the locked amount.
    expect(texts[4]).toBe('UPDATE users SET chips = chips - $1 WHERE id = $2 AND chips >= $1');
    expect(queries[4].params).toEqual([58593, GUEST_ID]);
    // Guest retire: stars additive, token_version bump, retired stats as TEXT.
    expect(texts[5]).toContain('stars = COALESCE(stars, 0) - $1::int');
    expect(texts[5]).toContain('token_version = COALESCE(token_version, 0) + 1');
    expect(queries[5].params[0]).toBe(199);
    expect(queries[5].params[2]).toBe(GUEST_ID);
    expect(JSON.parse(String(queries[5].params[1]))).toMatchObject({ claimedBy: CALLER_ID, claimedChips: 58593 });
    // Caller credit: authManager.addChipsToUser's own statement.
    expect(texts[6]).toBe('UPDATE users SET chips = chips + $1 WHERE id = $2');
    expect(queries[6].params).toEqual([58593, CALLER_ID]);
    // Then stars additive + GREATEST ratchet + achievements.
    expect(texts[7]).toContain('stars = COALESCE(stars, 0) + $1::int');
    expect(texts[7]).toContain('level = GREATEST(COALESCE(level, 1), $2::int)');
    expect(queries[7].params).toEqual([199, 6, 254, JSON.stringify(['first_win', 'hands_100']), CALLER_ID]);
    expect(texts[8]).toBe('COMMIT');
    expect(client.released).toBe(1);
    // Never an absolute chips value, never a jsonb operator (fails on TEXT).
    for (const t of texts) {
      expect(t).not.toMatch(/chips = \$\d/);
      expect(t).not.toContain('->>');
      expect(t).not.toContain('::jsonb');
    }
  });

  it('a zero-chip guest moves no chips at all (no chip statement runs)', async () => {
    const { pool, queries } = fakePg(new Map([[GUEST_ID, pappyR({ chips: 0 })], [CALLER_ID, account()]]));
    expect(await claimGuestProgress(deps(createPgGuestClaimDb(pool, realChipPaths)), input())).toMatchObject({ success: true, chipsAdded: 0 });
    expect(queries.some((q) => /SET chips = chips/.test(q.text))).toBe(false);
  });

  it('a refusal inside the transaction writes nothing', async () => {
    const { pool, queries } = fakePg(new Map([[GUEST_ID, pappyR({ stats: '{"claimedBy":9}' })], [CALLER_ID, account()]]));
    expect(await claimGuestProgress(deps(createPgGuestClaimDb(pool, realChipPaths)), input())).toMatchObject({ code: 'already_claimed' });
    expect(queries.some((q) => /^\s*UPDATE/.test(q.text))).toBe(false);
  });

  it('a chip-path failure (addChipsToUser → false) rolls back and releases the connection', async () => {
    const { pool, client, queries } = fakePg(new Map([[GUEST_ID, pappyR()], [CALLER_ID, account()]]), { failCredit: true });
    await expect(claimGuestProgress(deps(createPgGuestClaimDb(pool, realChipPaths)), input())).rejects.toThrow('caller chip credit failed');
    expect(queries.map((q) => q.text.trim())).toContain('ROLLBACK');
    expect(queries.map((q) => q.text.trim())).not.toContain('COMMIT');
    expect(client.released).toBe(1);
  });
});

describe('src/index.ts wiring (source scan)', () => {
  const src: string = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  it('the claim DB is built on authManager\'s chip paths, and guest tokens are verified with allowExpired', () => {
    expect(src).toContain('createPgGuestClaimDb(getPool() as unknown as PgPoolLike, { deductChips, addChipsToUser })');
    expect(src).toContain('verifyLegacyTokenClaims(token, { allowExpired: true })');
    // D2: the token's username claim is passed through, and the level-reward
    // guard + xp clamp are wired from the progression engine.
    expect(src).toContain('{ ok: true, userId: v.userId, tokenVersion: v.tokenVersion, username: v.username }');
    expect(src).toContain('levelUnlocks: lifetimeAchievementsUnlockedByLevel,');
    expect(src).toContain('    maxXpAtLevel,\n');
  });

  it('a successful claim is audited; the GUEST re-hydrates, the CALLER is merged (never reloaded — D2)', () => {
    const at = src.indexOf("socket.on('claimGuestProgress'");
    const raw = src.slice(at, src.indexOf('\n  socket.on(', at + 10));
    const body = raw.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    expect(body).toContain("auditLog(auth?.username || String(auth?.userId), 'GUEST_PROGRESS_CLAIMED', {");
    expect(body).toContain('await progressionManager.rehydrateUser(r.guestUserId)');
    expect(body).not.toContain('rehydrateUser(auth.userId)');
    expect(body).toContain('progressionManager.applyCarriedProgress(auth.userId, {');
    expect(body).toContain('achievementIds: r.achievementIdsAdded,');
    expect(body).toContain('GUEST_CLAIM_CHIP_ALERT_THRESHOLD');
  });

  it('peek and claim answer on BOTH the ack and the <event>Result frame; the claim frame is the contract shape', () => {
    expect(src).toContain("answerGuestClaim('peekGuestProgressResult', r as unknown as Record<string, unknown>, rid, ack);");
    expect(src).toContain("answerGuestClaim('claimGuestProgressResult', claimResultFrame(r), rid, ack);");
    expect(src).toContain("socket.emit(event, frame);\n    if (typeof ack === 'function')");
  });
});

// ── 2026-10-09 decision D2 ─────────────────────────────────────────────────
describe('D2 — only REAL pre-shutoff guest rows are claimable (created_at < 2026-10-09T16:00Z)', () => {
  it('the cutoff is 2026-10-09T16:00:00Z', () => {
    expect(GUEST_CLAIM_CUTOFF_ISO).toBe('2026-10-09T16:00:00Z');
  });

  it.each([
    ['at the cutoff exactly', '2026-10-09T16:00:00.000Z'],
    ['after guest play went off (rollback-flag register)', '2026-10-09T17:30:00.000Z'],
    ['weeks later', '2026-11-01T00:00:00.000Z'],
    ['unknown (NULL)', null],
    ['unreadable', 'not a date'],
  ])('a GuestNNNN row created %s → not_a_guest; nothing moves', async (_label, createdAt) => {
    const db = new FakeUsersDb([pappyR({ created_at: createdAt as any }), account()]);
    expect(await peekGuestProgress(deps(db), input())).toMatchObject({ success: false, code: 'not_a_guest' });
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: false, code: 'not_a_guest' });
    expect(db.rows.get(GUEST_ID)!.chips).toBe(58593);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
    expect(db.commits).toBe(1); // the claim transaction ran its checks and wrote nothing
  });

  it('one millisecond before the cutoff is claimable; a pg Date value works too', async () => {
    const db = new FakeUsersDb([pappyR({ created_at: '2026-10-09T15:59:59.999Z' }), account()]);
    expect((await claimGuestProgress(deps(db), input())).success).toBe(true);
    expect(guestRowState({ username: 'Guest1', stats: null, created_at: new Date('2026-08-21T01:48:18.979Z') })).toBe('guest');
  });

  it('the 50,000-chip rollback-register mint is closed: a fresh Guest row (register under ONLINE_GUEST_PLAY_ENABLED=1) cannot be carried over', async () => {
    const fresh: ClaimUserRow = {
      id: 9001, username: 'Guest4242', display_name: null, chips: 50000, stars: 0, level: 1, xp: 0,
      achievements: '[]', stats: '{}', banned: false, token_version: 0, created_at: '2026-10-10T12:00:00Z',
    };
    const db = new FakeUsersDb([fresh, account()]);
    const r = await claimGuestProgress(deps(db, okToken(9001, 0, 'Guest4242')), input());
    expect(r).toMatchObject({ success: false, code: 'not_a_guest' });
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });

  it('the Postgres read includes created_at (so the rule runs on the LOCKED row)', async () => {
    const queries: string[] = [];
    const client = {
      async query(text: string) { queries.push(text); return { rows: [], rowCount: 0 }; },
      release() { /* noop */ },
    };
    const pool = { query: client.query, connect: async () => client };
    await claimGuestProgress(deps(createPgGuestClaimDb(pool, { deductChips: async () => true, addChipsToUser: async () => true })), input());
    const lock = queries.find((q) => /FOR UPDATE/.test(q))!;
    expect(lock).toContain('created_at');
  });
});

describe('D2 — the guest token must be FOR that row (username claim = row username)', () => {
  it('a token naming the right userId but another username → invalid_guest_token, nothing moves (peek + claim)', async () => {
    const db = new FakeUsersDb([pappyR(), account()]);
    const wrongName = okToken(GUEST_ID, 0, 'Guest9629');
    expect(await peekGuestProgress(deps(db, wrongName), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
    expect(await claimGuestProgress(deps(db, wrongName), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
    expect(db.rows.get(GUEST_ID)!.chips).toBe(58593);
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });

  it('a token with NO username claim is refused (the row state is not disclosed to it)', async () => {
    const db = new FakeUsersDb([pappyR({ stats: '{"claimedBy":1}' }), account()]);
    // Would be already_claimed with a matching token — a nameless one learns nothing.
    expect(await claimGuestProgress(deps(db, okToken(GUEST_ID, 0, null)), input())).toMatchObject({ success: false, code: 'invalid_guest_token' });
  });

  it('END TO END: a correctly SIGNED legacy token whose username is not the row\'s is refused', async () => {
    const NOW = Date.UTC(2026, 9, 9, 20, 0, 0);
    const realVerify = (token: unknown): GuestTokenCheck => {
      const v = authManager.verifyLegacyTokenClaims(token, { allowExpired: true, nowMs: NOW });
      return v.ok ? { ok: true, userId: v.userId, tokenVersion: v.tokenVersion, username: v.username } : { ok: false, reason: v.reason };
    };
    const iat = Math.floor(NOW / 1000) - 30 * 86400;
    const other = jwt.sign({ userId: GUEST_ID, username: 'someone.else', tokenVersion: 0, iat, exp: iat + 7 * 86400 }, TEST_JWT_SECRET);
    const nameless = jwt.sign({ userId: GUEST_ID, tokenVersion: 0, iat, exp: iat + 7 * 86400 }, TEST_JWT_SECRET);
    const db = new FakeUsersDb([pappyR(), account()]);
    for (const t of [other, nameless]) {
      expect(await claimGuestProgress({ db, verifyGuestToken: realVerify }, input({ guestToken: t }))).toMatchObject({ success: false, code: 'invalid_guest_token' });
    }
    expect(db.rows.get(CALLER_ID)!.chips).toBe(50000);
  });
});

describe('D2 — carrying the guest\'s LEVEL never re-pays level-achievement rewards', () => {
  const { lifetimeAchievementsUnlockedByLevel, maxXpAtLevel, ProgressionManager } = progression;
  // The engine's fire-and-forget DB writes have no pool here (they fail soft and warn).
  let warn: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    err = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); });

  it('lifetimeAchievementsUnlockedByLevel: only the level thresholds crossed by the raise', () => {
    expect(lifetimeAchievementsUnlockedByLevel(3, 30)).toEqual(['lvl_25']);
    expect(lifetimeAchievementsUnlockedByLevel(25, 30)).toEqual([]);
    expect(lifetimeAchievementsUnlockedByLevel(30, 3)).toEqual([]);
    expect(lifetimeAchievementsUnlockedByLevel(1, 1000)).toEqual(['lvl_25', 'lvl_75', 'lvl_150', 'lvl_300', 'lvl_500', 'lvl_700', 'lvl_1000']);
    // Nothing that needs a counter (hands, wins, pots …) is ever returned.
    expect(lifetimeAchievementsUnlockedByLevel(1, 1000).every((id) => id.startsWith('lvl_'))).toBe(true);
  });

  const levelDeps = (db: GuestClaimDb, verify = okToken()): GuestClaimDeps => ({
    ...deps(db, verify), levelUnlocks: lifetimeAchievementsUnlockedByLevel, maxXpAtLevel,
  });

  it('the claim writes lvl_25 as ALREADY EARNED when the guest (level 30) raises the caller (level 3) — even though the guest row lacks the id (prod TEXT-stats save failures)', async () => {
    const db = new FakeUsersDb([pappyR({ level: 30, xp: 100, achievements: '["first_win"]' }), account()]);
    const r = await claimGuestProgress(levelDeps(db), input());
    expect(r).toMatchObject({ success: true, levelAfter: 30, levelAchievementsMarkedEarned: ['lvl_25'] });
    expect(parseAchievements(db.rows.get(CALLER_ID)!.achievements)).toContain('lvl_25');
  });

  it('a caller ALREADY past a threshold on his own keeps his own state (nothing marked for him)', async () => {
    const db = new FakeUsersDb([pappyR({ level: 80, xp: 1 }), account({ level: 30, achievements: '["first_win"]' })]);
    const r = await claimGuestProgress(levelDeps(db), input());
    expect(r).toMatchObject({ success: true, levelAfter: 80, levelAchievementsMarkedEarned: ['lvl_75'] });
  });

  it('END TO END in the progression engine: after the claim, the next checkAchievements pays NO level reward (and would have without the guard)', async () => {
    const run = async (useGuard: boolean) => {
      const db = new FakeUsersDb([pappyR({ level: 30, xp: 100, achievements: '["first_win"]' }), account()]);
      const r = await claimGuestProgress(useGuard ? levelDeps(db) : deps(db), input());
      if (!r.success) throw new Error('claim failed');
      const pm = new ProgressionManager();
      const p = pm.getOrCreateProgress('player-x', 'Josh H.'); // no userId → no DB hydrate
      Object.assign(p, { userId: CALLER_ID, hydrated: true, level: 3, xp: 40, chips: 50000, stars: 10, achievements: ['first_win'] });
      pm.applyCarriedProgress(CALLER_ID, {
        chipsAdded: r.chipsAdded, starsAdded: r.starsAdded, levelAfter: r.levelAfter, xpAfter: r.xpAfter,
        achievementIds: r.achievementIdsAdded,
      });
      const chipsBefore = p.chips;
      pm.checkAchievements('player-x');
      return { level: p.level, paid: p.chips - chipsBefore, has25: p.achievements.includes('lvl_25') };
    };
    expect(await run(true)).toEqual({ level: 30, paid: 0, has25: true });
    // Control: without the D2 guard the same claim re-mints lvl_25's 10,000 chips.
    expect(await run(false)).toMatchObject({ level: 30, paid: 10000 });
  });

  it('an inflated guest xp is clamped to its level (no paying level-up walk on the next addXP)', async () => {
    const db = new FakeUsersDb([pappyR({ level: 6, xp: 999_999_999 }), account()]);
    const r = await claimGuestProgress(levelDeps(db), input());
    expect(r).toMatchObject({ success: true, levelAfter: 6, xpAfter: maxXpAtLevel(6) });
    expect(maxXpAtLevel(6)).toBe(progression.xpRequiredForLevel(6) - 1);
    expect(db.rows.get(CALLER_ID)!.xp).toBe(maxXpAtLevel(6));
  });
});

describe('D2 — the caller\'s unsaved in-memory progress is never lost', () => {
  const { ProgressionManager, MAX_LEVEL } = progression;
  let warn: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    err = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); });
  const carried = { chipsAdded: 58593, starsAdded: 199, levelAfter: 6, xpAfter: 254, achievementIds: ['hands_100'] };

  function liveEntry(pm: InstanceType<typeof ProgressionManager>, id: string, over: Record<string, unknown> = {}) {
    const p = pm.getOrCreateProgress(id, 'Josh H.');
    Object.assign(p, {
      userId: CALLER_ID, hydrated: true, level: 3, xp: 90, chips: 50000, stars: 10,
      achievements: ['first_win', 'wins_50'], totalHandsPlayed: 640, handsWon: 77, ...over,
    });
    return p;
  }

  it('merges ONLY the carried fields: counters/xp ahead of the DB survive, hydrated stays true, no reload', () => {
    const pm = new ProgressionManager();
    const p = liveEntry(pm, 'player-a');
    const hydrate = jest.spyOn(pm, 'hydrateFromDB');
    const out = pm.applyCarriedProgress(CALLER_ID, carried);
    expect(out).toEqual({ merged: ['player-a'], reloading: [] });
    expect(hydrate).not.toHaveBeenCalled();
    expect(p.hydrated).toBe(true);
    expect(p.totalHandsPlayed).toBe(640); // in-memory progress NOT reset to the DB's
    expect(p.handsWon).toBe(77);
    expect(p.chips).toBe(50000 + 58593);
    expect(p.stars).toBe(10 + 199);
    expect(p.level).toBe(6);
    expect(p.xp).toBe(254);
    expect(p.xpToNextLevel).toBe(progression.xpRequiredForLevel(6));
    expect(p.achievements.sort()).toEqual(['first_win', 'hands_100', 'wins_50']);
  });

  it('never lowers memory: a higher in-memory level keeps its level AND xp; equal level keeps the higher xp', () => {
    const pm = new ProgressionManager();
    const hi = liveEntry(pm, 'player-hi', { level: 9, xp: 5 });
    const eq = liveEntry(pm, 'player-eq', { level: 6, xp: 400 });
    pm.applyCarriedProgress(CALLER_ID, carried);
    expect([hi.level, hi.xp]).toEqual([9, 5]);
    expect([eq.level, eq.xp]).toEqual([6, 400]);
  });

  it('a reward earned right after the claim persists (the entry never went un-hydrated)', () => {
    const pm = new ProgressionManager();
    const p = liveEntry(pm, 'player-r', { handsWon: 0, achievements: [] });
    pm.applyCarriedProgress(CALLER_ID, { ...carried, achievementIds: [] });
    const persisted: number[] = [];
    (pm as any).persistChipReward = (_prog: unknown, amount: number) => { if ((_prog as any).hydrated) persisted.push(amount); };
    p.handsWon = 1; // first_win becomes due
    pm.checkAchievements('player-r');
    expect(persisted).toContain(1000); // first_win's chip reward reached the persist path
  });

  it('only the caller\'s entries are touched; an entry still hydrating gets a fresh hydrate instead', () => {
    const pm = new ProgressionManager();
    const other = pm.getOrCreateProgress('someone', 'Other');
    Object.assign(other, { userId: 999, hydrated: true, chips: 1 });
    const pending = liveEntry(pm, 'player-pending', { hydrated: false });
    const hydrate = jest.spyOn(pm, 'hydrateFromDB').mockResolvedValue(undefined);
    const out = pm.applyCarriedProgress(CALLER_ID, carried);
    expect(out).toEqual({ merged: [], reloading: ['player-pending'] });
    expect(hydrate).toHaveBeenCalledWith('player-pending', CALLER_ID);
    expect(other.chips).toBe(1);
    expect(pending.chips).toBe(50000); // not double-counted: the hydrate reads the post-claim row
  });

  it('caps at MAX_LEVEL', () => {
    const pm = new ProgressionManager();
    const p = liveEntry(pm, 'player-max');
    pm.applyCarriedProgress(CALLER_ID, { ...carried, levelAfter: 5000, xpAfter: 10 });
    expect(p.level).toBe(MAX_LEVEL);
    expect(p.xp).toBe(0);
    expect(p.xpToNextLevel).toBe(Infinity);
  });
});

// ── 2026-10-09 S4 — at most ONE guest carry-over per caller ACCOUNT ──────────
describe('S4 — one guest carry-over per caller account (already_claimed_by_account)', () => {
  const marvinToken = okToken(4402);

  it('after PappyR is carried over, a SECOND guest (Marvin) into the same account is refused — nothing moves', async () => {
    const db = new FakeUsersDb([pappyR(), marvin(), account()]);
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: true, chipsAdded: 58593 });
    const callerAfterFirst = clone(db.rows.get(CALLER_ID)!);
    const commitsAfterFirst = db.commits;

    const second = await claimGuestProgress(deps(db, marvinToken), input({ guestToken: 'marvin.token' }));
    expect(second).toEqual({
      success: false, code: 'already_claimed_by_account', guestUserId: 4402,
      error: GUEST_CLAIM_MESSAGES.already_claimed_by_account,
    });
    expect(db.rows.get(4402)).toEqual(marvin());                 // Marvin's row untouched (still claimable elsewhere)
    expect(db.rows.get(CALLER_ID)).toEqual(callerAfterFirst);    // caller unchanged
    expect(db.commits).toBe(commitsAfterFirst + 1);              // the refusal transaction wrote nothing
  });

  it('peek refuses the second one too, so it is never even offered', async () => {
    const db = new FakeUsersDb([pappyR(), marvin(), account()]);
    expect(await peekGuestProgress(deps(db, marvinToken), input())).toMatchObject({ success: true, chips: 15000 });
    await claimGuestProgress(deps(db), input());
    expect(await peekGuestProgress(deps(db, marvinToken), input())).toMatchObject({
      success: false, code: 'already_claimed_by_account', guestUserId: 4402,
    });
    // Re-presenting the guest already carried over still reads as already_claimed.
    expect(await peekGuestProgress(deps(db), input())).toMatchObject({ success: false, code: 'already_claimed' });
  });

  it('CONCURRENT claims of two different guests into one account: exactly one succeeds (they serialize on the caller lock)', async () => {
    const db = new FakeUsersDb([pappyR(), marvin(), account()]);
    const [a, b] = await Promise.all([
      claimGuestProgress(deps(db), input()),
      claimGuestProgress(deps(db, marvinToken), input({ guestToken: 'marvin.token' })),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success)).toMatchObject({ code: 'already_claimed_by_account' });
    const caller = db.rows.get(CALLER_ID)!;
    const pappyMoved = (db.rows.get(GUEST_ID)!.chips === 0);
    const marvinMoved = (db.rows.get(4402)!.chips === 0);
    expect(pappyMoved !== marvinMoved).toBe(true);                // exactly one guest row retired
    expect(caller.chips).toBe(50000 + (pappyMoved ? 58593 : 15000));
  });

  it('the rule follows the ACCOUNT: a guest claimed under the same MASTER id via another local row also counts', async () => {
    const otherLocal = account({ id: 777, username: 'josh.phone', stats: JSON.stringify({ masterUserId: CALLER_MASTER }) });
    const retiredByOther = pappyR({
      chips: 0, stars: 0, token_version: 1,
      stats: JSON.stringify({ claimedBy: 777, claimedByMasterUserId: CALLER_MASTER }),
    });
    const db = new FakeUsersDb([retiredByOther, marvin(), account(), otherLocal]);
    expect(await claimGuestProgress(deps(db, marvinToken), input({ guestToken: 'marvin.token' }))).toMatchObject({
      success: false, code: 'already_claimed_by_account',
    });
    expect(db.rows.get(4402)!.chips).toBe(15000);
  });

  it('a DIFFERENT account can still carry Marvin over (the limit is per account, not global)', async () => {
    const db = new FakeUsersDb([pappyR(), marvin(), account(), account({ id: 900, username: 'someone', stats: JSON.stringify({ masterUserId: 'other-master' }) })]);
    expect(await claimGuestProgress(deps(db), input())).toMatchObject({ success: true });
    expect(await claimGuestProgress(deps(db, marvinToken), input({ callerLocalId: 900, callerMasterId: 'other-master' })))
      .toMatchObject({ success: true, chipsAdded: 15000 });
  });

  it('guestRowClaimedByCaller reads only the top-level reversal record (client-writable stats.clientData cannot fake it)', () => {
    expect(guestRowClaimedByCaller('{"claimedBy":512}', 512, 'x')).toBe(true);
    expect(guestRowClaimedByCaller({ claimedBy: '512' }, 512, 'x')).toBe(true);
    expect(guestRowClaimedByCaller('{"claimedBy":9,"claimedByMasterUserId":"m1"}', 512, 'm1')).toBe(true);
    expect(guestRowClaimedByCaller('{"claimedBy":9,"claimedByMasterUserId":"m1"}', 512, 'm2')).toBe(false);
    expect(guestRowClaimedByCaller('{"clientData":{"claimedBy":512}}', 512, 'x')).toBe(false);
    expect(guestRowClaimedByCaller('not json', 512, 'x')).toBe(false);
    expect(guestRowClaimedByCaller(null, 512, '')).toBe(false);
  });

  it('pg: the scan runs on the TRANSACTION client after the caller lock; a hit refuses before any write', async () => {
    const queries: string[] = [];
    const rows = new Map<number, ClaimUserRow>([[GUEST_ID, pappyR()], [CALLER_ID, account()]]);
    const client = {
      async query(text: string, params: unknown[] = []) {
        queries.push(text.replace(/\s+/g, ' ').trim());
        if (/FOR UPDATE/.test(text)) { const r = rows.get(Number(params[0])); return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 }; }
        if (/LIKE '%claimedBy%'/.test(text)) return { rows: [{ id: 4402, stats: JSON.stringify({ claimedBy: CALLER_ID }) }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { query: async () => { throw new Error('must not use the pool inside a claim'); }, connect: async () => client };
    const r = await claimGuestProgress(deps(createPgGuestClaimDb(pool as any, { deductChips: async () => true, addChipsToUser: async () => true })), input());
    expect(r).toMatchObject({ success: false, code: 'already_claimed_by_account', guestUserId: GUEST_ID });
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toMatch(/FOR UPDATE$/);
    expect(queries[2]).toMatch(/FOR UPDATE$/);
    expect(queries[3]).toBe("SELECT id, stats FROM users WHERE stats::text LIKE '%claimedBy%'");
    expect(queries.some((q) => /^UPDATE/.test(q))).toBe(false);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });
});

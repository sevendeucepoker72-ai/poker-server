/**
 * 2026-10-11 — AUTH-1 (P0: account / admin takeover) and AUTH-11.
 *
 * THE HOLE. A sign-in for a master account with no local row yet was resolved
 * by UPSERTING on `users.username` with a key taken from the sign-in itself:
 *   - oauthLogin / tokenLogin: the token's `username` claim = the master's
 *     display name `[firstName, lastName].join(' ')`, which the player edits
 *     freely on americanpub.poker (PUT /users/:id);
 *   - authWithTicket: the master slug (or a phone when /me returned one);
 *   - the password `login`: the phone.
 * `ON CONFLICT (LOWER(username)) DO UPDATE … RETURNING *` then handed back
 * WHATEVER row already had that username. An UNOWNED row was adopted and
 * stamped in both guard modes — row 1, the ADMIN_PHONE admin seed (is_admin,
 * ~2.0B chips), included: rename yourself to its digits and sign in. In the
 * default WARN mode even a row OWNED by another master was bound ("allowed").
 *
 * THE RULE NOW. Rows are found by MASTER ID only (accountMerge
 * findLocalUserByMasterId, master-first — every caller does that first, under
 * withMasterLock). A master with no row gets:
 *   1. an EXISTING unowned row only with REAL PROOF that it is his: a phone
 *      number the master side ATTESTED (a phone claim in a token the auth
 *      server signed, or the master API's own user record) equal to the row's
 *      phone-number username — and never an is_admin row, a GuestNNNN row (the
 *      guest carry-over has its own claim flow, guestClaim.ts), a merged
 *      tombstone, or a row any master already owns. The adoption is atomic
 *      (row locked FOR UPDATE, ownership re-checked under the lock).
 *   2. otherwise a NEW row under the collision-proof key `m:<master id>`
 *      (INSERT … ON CONFLICT DO NOTHING; on a conflict the master is looked up
 *      again — another process may have created his row a moment ago — and a
 *      key some other row already holds gets a random suffix). Never a bind.
 * A display name, a slug or an unverified phone is never proof. A row owned by
 * another master is never bound, in any mode. Measured 2026-10-11 on prod: the
 * ONLY unowned non-guest non-tombstone row is row 1 (the admin seed), so no
 * real player loses an adoption.
 *
 * Players see `display_name`, never `username` (auth/displayName.ts): a new
 * row's display_name is the whitelist-valid form of the sign-in's name.
 */

import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { parseStatsColumn } from './loginIdentity';
import { findLocalUserByMasterId, isMergedTombstone } from './accountMerge';
import { accountDisplayName } from './displayName';

export const MASTER_ROW_USERNAME_PREFIX = 'm:';

/** The collision-proof local username of a master account's row. */
export function masterRowUsername(masterUserId: string): string {
  return `${MASTER_ROW_USERNAME_PREFIX}${masterUserId}`;
}

/** A US phone key — exactly 10 digits once formatting and a leading 1 / +1 are dropped — or null. */
export function normalizePhoneKey(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/[^0-9]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[0-9]{10}$/.test(ten) ? ten : null;
}

export function isGuestUsername(username: unknown): boolean {
  return typeof username === 'string' && /^Guest[0-9]+$/.test(username);
}

export type AdoptionRefusal = 'owned' | 'tombstone' | 'admin' | 'guest' | 'no_proof' | 'phone_mismatch';

/**
 * Why `row` may NOT be adopted by a master whose ATTESTED phone is
 * `verifiedPhone` (already normalized), or null when it may. Pure.
 */
export function adoptionRefusalReason(
  row: { username?: unknown; stats?: unknown; is_admin?: unknown },
  verifiedPhone: string | null,
): AdoptionRefusal | null {
  const owner = parseStatsColumn(row.stats).masterUserId;
  if (owner != null && owner !== '') return 'owned';
  if (isMergedTombstone(row.stats) || /^merged-/.test(String(row.username ?? ''))) return 'tombstone';
  if (row.is_admin) return 'admin';
  if (isGuestUsername(row.username)) return 'guest';
  if (!verifiedPhone) return 'no_proof';
  if (normalizePhoneKey(row.username) !== verifiedPhone) return 'phone_mismatch';
  return null;
}

/** /api/health → identityGuard. Counts only, no ids. */
export const masterRowStats = {
  created: 0,
  adoptedByPhone: 0,
  adoptionRefused: { owned: 0, tombstone: 0, admin: 0, guest: 0, no_proof: 0, phone_mismatch: 0, ambiguous: 0 },
  foundAfterRace: 0,
  keyCollisions: 0,
  failures: 0,
};

export interface MasterRowDeps {
  pool: Pick<Pool, 'query' | 'connect'>;
  /** Defaults to accountMerge.findLocalUserByMasterId(pool, id) (throws MasterLookupError). */
  findByMaster?: (masterUserId: string) => Promise<any | null>;
  log?: (line: string) => void;
}

export interface MasterRowArgs {
  masterUserId: string;
  /** The sign-in's name for this person (claim / ticket); stored whitelist-safe. */
  displayName: string;
  /** Descriptive identity keys to stamp next to masterUserId (see MasterIdentityStamp). */
  stamp?: { masterUsername?: string; masterDisplayName?: string; masterPhone?: string };
  /** A phone number the MASTER side attested for this account — the only adoption proof. */
  verifiedPhone?: string | null;
  /** is_admin for a NEW row (the master's attested roles). Never applied to an adopted row. */
  isAdmin?: boolean;
  via: string;
  defaults: { chips: number; level: number; xp: number };
}

export type MasterRowResult =
  | { ok: true; user: any; how: 'created' | 'adopted_phone' | 'found_after_race' }
  | { ok: false; code: 'user_upsert_failed'; diag: string };

function stampOf(args: MasterRowArgs): Record<string, string> {
  const out: Record<string, string> = { masterUserId: String(args.masterUserId) };
  for (const [k, v] of Object.entries(args.stamp || {})) {
    if (v != null && String(v) !== '') out[k] = String(v);
  }
  return out;
}

/** A password_hash no password can ever match (sign-in is OIDC / ticket only; bcrypt.compare → false). */
function unusablePasswordHash(): string {
  return `!no-password:${crypto.randomBytes(18).toString('hex')}`;
}

async function adoptByVerifiedPhone(deps: MasterRowDeps, args: MasterRowArgs, phone: string, log: (l: string) => void): Promise<any | null> {
  const client: PoolClient = await (deps.pool as Pool).connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM users WHERE username = ANY($1::text[]) ORDER BY id LIMIT 2 FOR UPDATE',
      [[phone, `1${phone}`, `+1${phone}`]],
    );
    if (rows.length !== 1) {
      await client.query('ROLLBACK');
      if (rows.length > 1) {
        masterRowStats.adoptionRefused.ambiguous++;
        log(`[identity] ${JSON.stringify({ event: 'phone_adoption_refused', reason: 'ambiguous', via: args.via, masterUserId: String(args.masterUserId) })}`);
      }
      return null;
    }
    const row = rows[0];
    const why = adoptionRefusalReason(row, phone);
    if (why) {
      await client.query('ROLLBACK');
      masterRowStats.adoptionRefused[why]++;
      log(`[identity] ${JSON.stringify({ event: 'phone_adoption_refused', reason: why, via: args.via, masterUserId: String(args.masterUserId), localUserId: row.id })}`);
      return null;
    }
    const stats = { ...parseStatsColumn(row.stats), ...stampOf(args) };
    const { rows: upd } = await client.query(
      'UPDATE users SET stats = $2, display_name = COALESCE(display_name, $3) WHERE id = $1 RETURNING *',
      [row.id, JSON.stringify(stats), accountDisplayName(args.displayName)],
    );
    await client.query('COMMIT');
    masterRowStats.adoptedByPhone++;
    log(`[identity] ${JSON.stringify({ event: 'phone_row_adopted', via: args.via, masterUserId: String(args.masterUserId), localUserId: row.id })}`);
    return upd[0] || null;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The local row for a master account that has NONE yet (the caller looked it up
 * by master id first, under withMasterLock). See the module comment for the
 * rule. Never throws: a DB failure is `{ ok:false, code:'user_upsert_failed' }`
 * (retryable — the sign-in is refused, never guessed).
 */
export async function createOrAdoptMasterRow(deps: MasterRowDeps, args: MasterRowArgs): Promise<MasterRowResult> {
  const log = deps.log || ((l: string) => console.warn(l));
  const masterId = String(args.masterUserId || '').trim();
  if (!masterId) return { ok: false, code: 'user_upsert_failed', diag: 'no_master_id' };
  const findByMaster = deps.findByMaster || ((id: string) => findLocalUserByMasterId(deps.pool as Pool, id));
  try {
    const phone = normalizePhoneKey(args.verifiedPhone);
    if (phone) {
      const adopted = await adoptByVerifiedPhone(deps, { ...args, masterUserId: masterId }, phone, log);
      if (adopted) return { ok: true, user: adopted, how: 'adopted_phone' };
    }
    const stats = JSON.stringify(stampOf({ ...args, masterUserId: masterId }));
    const displayName = accountDisplayName(args.displayName);
    for (let attempt = 0; attempt < 3; attempt++) {
      const username = attempt === 0
        ? masterRowUsername(masterId)
        : `${masterRowUsername(masterId)}:${crypto.randomBytes(4).toString('hex')}`;
      const { rows } = await deps.pool.query(
        `INSERT INTO users (username, display_name, password_hash, chips, level, xp, stats, is_admin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [username, displayName, unusablePasswordHash(), args.defaults.chips, args.defaults.level, args.defaults.xp, stats, !!args.isAdmin],
      );
      if (rows[0]) {
        masterRowStats.created++;
        log(`[identity] ${JSON.stringify({ event: 'master_row_created', via: args.via, masterUserId: masterId, localUserId: rows[0].id, suffixed: attempt > 0 })}`);
        return { ok: true, user: rows[0], how: 'created' };
      }
      // The key is taken. This master's own row, created a moment ago by
      // another process (a Railway deploy overlap) → that row. Otherwise some
      // OTHER row holds the key: it is never bound — retry with a suffix.
      const raced = await findByMaster(masterId);
      if (raced) {
        masterRowStats.foundAfterRace++;
        return { ok: true, user: raced, how: 'found_after_race' };
      }
      masterRowStats.keyCollisions++;
      log(`[identity] ${JSON.stringify({ event: 'master_row_key_taken', via: args.via, masterUserId: masterId, attempt })}`);
    }
    masterRowStats.failures++;
    return { ok: false, code: 'user_upsert_failed', diag: 'master_row_key_collision' };
  } catch (e: any) {
    masterRowStats.failures++;
    return { ok: false, code: 'user_upsert_failed', diag: `master_row: ${String(e?.message || e).slice(0, 140)}` };
  }
}

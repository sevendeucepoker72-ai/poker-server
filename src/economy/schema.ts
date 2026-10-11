/**
 * Economy schema (2026-10-11, .online R2). Idempotent DDL, run on every boot
 * from index.ts right after the other init*Tables, never destructive:
 *
 *   user_achievements          LIFETIME achievement ledger (ECON-10): a reward
 *                              is paid only by the INSERT … ON CONFLICT DO
 *                              NOTHING that returns a row (economyDb
 *                              .settleAchievementReward), so two seats / two
 *                              processes can never both pay one achievement.
 *   economy_credits            one row per keyed one-off credit (Spin & Go
 *                              prize, …): the key makes a retry a no-op.
 *   user_chip_wins             chips WON per user per Denver day (net, cash
 *                              tables) — the season ranking (C9) and the
 *                              leaderboard's daily / weekly / season windows.
 *   user_battle_pass_premium   one row per user per Battle Pass season: bought
 *                              once, never charged twice (ECON-16).
 *   season_award_runs          one row per awarded season (C9 idempotency,
 *                              also when a month had no eligible winner).
 *   users.public_id            an opaque stable id other players may see
 *                              (profile / friend request by id — never the
 *                              local account id or the login handle).
 *   users.chips → BIGINT       (P3) the admin row sat 147.7M below INT4 max.
 */
import { types as pgTypes } from 'pg';

export interface DdlQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface DdlPool extends DdlQueryable {
  connect(): Promise<DdlQueryable & { release(err?: unknown): void }>;
}

/**
 * node-postgres returns BIGINT (int8, OID 20) as a STRING by default; after
 * users.chips becomes BIGINT every `rows[0].chips` would turn into "50000" and
 * `chips + reward` into string concatenation. Parse int8 as a JS number when it
 * is a safe integer (every chip balance is far below 2^53); an unsafe value
 * stays a string (never silently rounded). Idempotent; set at import time.
 */
export function installInt8Parser(): void {
  pgTypes.setTypeParser(20, (v: string) => {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  });
}
installInt8Parser();

export const ECONOMY_TABLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS user_achievements (
     user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     ach_id    TEXT    NOT NULL,
     earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, ach_id)
   )`,
  `CREATE TABLE IF NOT EXISTS economy_credits (
     credit_key TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL,
     chips      BIGINT  NOT NULL DEFAULT 0,
     stars      INTEGER NOT NULL DEFAULT 0,
     reason     TEXT    NOT NULL,
     detail     JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_economy_credits_user ON economy_credits (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS user_chip_wins (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     day     DATE    NOT NULL,
     won     BIGINT  NOT NULL DEFAULT 0,
     hands   INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_chip_wins_day ON user_chip_wins (day)`,
  `CREATE TABLE IF NOT EXISTS user_battle_pass_premium (
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     season_id    TEXT    NOT NULL,
     stars_paid   INTEGER NOT NULL DEFAULT 0,
     purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, season_id)
   )`,
  `CREATE TABLE IF NOT EXISTS season_award_runs (
     season_key TEXT PRIMARY KEY,
     ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     winners    INTEGER NOT NULL DEFAULT 0,
     trigger    TEXT,
     detail     JSONB
   )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users (public_id) WHERE public_id IS NOT NULL`,
];

/**
 * A public id is 'p' + 15 hex chars from md5 over (random, the ROW's id, the
 * clock): the expression references the outer row, so Postgres evaluates it
 * per row (CLAUDE.md "never generate randomness per-row in SQL" — an
 * uncorrelated expression is evaluated once); the unique index is the net.
 */
export const PUBLIC_ID_SQL = `'p' || substr(md5(random()::text || users.id::text || clock_timestamp()::text), 1, 15)`;

export async function initEconomyTables(pool: DdlQueryable): Promise<void> {
  for (const ddl of ECONOMY_TABLE_DDL) await pool.query(ddl);
  // Backfill missing public ids (every row on the first boot; rows created
  // later by the sign-in paths are filled lazily by economyDb.publicIdsFor).
  await pool.query(`UPDATE users SET public_id = ${PUBLIC_ID_SQL} WHERE public_id IS NULL`);
}

export type BigintMigration = 'migrated' | 'already_bigint' | 'lock_timeout' | 'failed' | 'no_column';

/**
 * users.chips INTEGER → BIGINT, idempotent. The account-merge credit-redirect
 * trigger (`BEFORE UPDATE OF chips, …`) depends on the column and Postgres
 * refuses to change the type of a column a trigger names ("cannot alter type of
 * a column used in a trigger definition"), so — in ONE transaction — every
 * user-defined trigger on users is captured with pg_get_triggerdef, dropped,
 * the column altered, and each trigger re-created from its own definition
 * (exactly as it was; no window without it, nothing else touched). The table
 * rewrite of ~600 rows takes milliseconds; `lock_timeout` bounds the wait for
 * the ACCESS EXCLUSIVE lock (a busy row lock during the Railway deploy overlap
 * → 'lock_timeout', retried later by the caller).
 */
export async function migrateUsersChipsToBigint(pool: DdlPool, lockTimeoutMs = 5000): Promise<BigintMigration> {
  const pre = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'chips'`,
  );
  const type = pre.rows[0]?.data_type;
  if (!type) return 'no_column';
  if (type === 'bigint') return 'already_bigint';
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '${Math.max(100, Math.floor(lockTimeoutMs))}ms'`);
    await c.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
    const again = await c.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'chips'`,
    );
    if (again.rows[0]?.data_type === 'bigint') { await c.query('ROLLBACK'); return 'already_bigint'; }
    const trig = await c.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'users'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    for (const t of trig.rows) await c.query(`DROP TRIGGER ${quoteIdent(t.tgname)} ON users`);
    await c.query('ALTER TABLE users ALTER COLUMN chips TYPE BIGINT');
    for (const t of trig.rows) await c.query(String(t.def));
    await c.query('COMMIT');
    return 'migrated';
  } catch (e: any) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    if (e?.code === '55P03') return 'lock_timeout';
    console.error('[economy-schema] users.chips BIGINT migration failed (nothing changed):', e?.message || e);
    return 'failed';
  } finally {
    c.release();
  }
}

function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

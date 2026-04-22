import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// JWT secret
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[Auth] FATAL: JWT_SECRET env var is not set in production.');
    process.exit(1);
  }
  console.warn('[Auth] WARNING: JWT_SECRET env var not set. Using insecure fallback.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'american-pub-poker-jwt-secret-2024-dev-only';
const JWT_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 10;

const DEFAULT_CHIPS = 10000;
const DEFAULT_LEVEL = 1;
const DEFAULT_XP = 0;

// Rate limiter (in-memory, no DB needed)
const loginAttempts = new Map<string, { attempts: number; firstAttemptAt: number; lockedUntil: number }>();
const RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 5 * 60 * 1000 };

function checkLoginRateLimit(username: string): { blocked: boolean; lockoutSecsLeft: number } {
  const key = username.trim().toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry) return { blocked: false, lockoutSecsLeft: 0 };
  const now = Date.now();
  if (entry.lockedUntil > now) return { blocked: true, lockoutSecsLeft: Math.ceil((entry.lockedUntil - now) / 1000) };
  if (now - entry.firstAttemptAt > RATE_LIMIT.windowMs) { loginAttempts.delete(key); return { blocked: false, lockoutSecsLeft: 0 }; }
  return { blocked: false, lockoutSecsLeft: 0 };
}

function recordFailedLogin(username: string): { lockoutSecsLeft: number } {
  const key = username.trim().toLowerCase();
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > RATE_LIMIT.windowMs) entry = { attempts: 0, firstAttemptAt: now, lockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= RATE_LIMIT.maxAttempts) { entry.lockedUntil = now + RATE_LIMIT.lockoutMs; loginAttempts.set(key, entry); return { lockoutSecsLeft: Math.ceil(RATE_LIMIT.lockoutMs / 1000) }; }
  loginAttempts.set(key, entry);
  return { lockoutSecsLeft: 0 };
}

function clearLoginAttempts(username: string): void { loginAttempts.delete(username.trim().toLowerCase()); }

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;

export interface UserData {
  id: number;
  username: string;
  displayName: string | null;
  chips: number;
  level: number;
  xp: number;
  stats: string;
  achievements: string;
  isAdmin: number;
  banned: number;
  tokenVersion: number;
  createdAt: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  token?: string;
  userData?: {
    id: number;
    username: string;
    chips: number;
    level: number;
    xp: number;
    stats: Record<string, any>;
    achievements: string[];
    isAdmin?: boolean;
  };
}

// ── PostgreSQL connection ──────────────────────────────────────────────────────

let pool: Pool;

/** Access the lazy-initialized PG pool (call after initDB). */
export function getPool(): Pool {
  if (!pool) throw new Error('DB not initialized');
  return pool;
}

function rowToUserData(row: any): UserData {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || null,
    chips: row.chips,
    level: row.level,
    xp: row.xp,
    stats: row.stats || '{}',
    achievements: row.achievements || '[]',
    isAdmin: row.is_admin ? 1 : 0,
    banned: row.banned ? 1 : 0,
    tokenVersion: row.token_version || 0,
    createdAt: row.created_at,
  };
}

export async function initDB(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[Auth] FATAL: DATABASE_URL env var not set. Cannot connect to PostgreSQL.');
    process.exit(1);
  }

  // Explicit timeouts so a slow/broken DB can't stall auth indefinitely.
  // Without these, pool.connect() could wait on the default kernel TCP
  // timeout (~2 min), leaving login sockets hanging past the client's
  // 10–15s timeout with no error surfaced.
  pool = new Pool({
    connectionString: dbUrl,
    connectionTimeoutMillis: 5_000,   // give up acquiring a conn after 5s
    idleTimeoutMillis: 30_000,        // recycle idle conns after 30s
    statement_timeout: 8_000,         // any single query aborts after 8s
    query_timeout: 8_000,
  });

  pool.on('error', (err) => {
    console.error('[Auth] PostgreSQL pool error:', err);
  });

  // Create users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      chips INTEGER DEFAULT ${DEFAULT_CHIPS},
      level INTEGER DEFAULT ${DEFAULT_LEVEL},
      xp INTEGER DEFAULT ${DEFAULT_XP},
      stats TEXT DEFAULT '{}',
      achievements TEXT DEFAULT '[]',
      is_admin BOOLEAN DEFAULT FALSE,
      banned BOOLEAN DEFAULT FALSE,
      token_version INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Create case-insensitive unique index
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))
  `).catch(() => { /* index may already exist */ });

  // Migration: add display_name column if it doesn't exist
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`).catch(() => {});

  // =====================================================================
  // Persistence sweep (2026-04-17): stars, inventory, daily claims,
  // battle pass, customization, preferences, hand history.
  // All IF NOT EXISTS — safe to re-run on every boot.
  // =====================================================================
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stars INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_streak INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_claim_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scratch_cards_available INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hands_since_last_scratch INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS customization JSONB NOT NULL DEFAULT '{}'`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences   JSONB NOT NULL DEFAULT '{}'`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_stars ON users(stars)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_inventory (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_type    TEXT    NOT NULL,
      item_id      TEXT    NOT NULL,
      acquired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      equipped     BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (user_id, item_type, item_id)
    )
  `).catch((e: any) => console.warn('[Auth] user_inventory:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_inventory_equipped ON user_inventory(user_id, item_type) WHERE equipped = TRUE`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_daily_claims (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      claim_type  TEXT    NOT NULL,
      claim_date  DATE    NOT NULL,
      payload     JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, claim_type, claim_date)
    )
  `).catch((e: any) => console.warn('[Auth] user_daily_claims:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_battle_pass_claims (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season_id   TEXT    NOT NULL,
      tier_id     INTEGER NOT NULL,
      claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, season_id, tier_id)
    )
  `).catch((e: any) => console.warn('[Auth] user_battle_pass_claims:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_hand_history (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hand_id     TEXT    NOT NULL,
      data        JSONB   NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => console.warn('[Auth] user_hand_history:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hand_history_user_created ON user_hand_history(user_id, created_at DESC)`).catch(() => {});

  // Daily achievements — (user, ach_id, date) composite PK so the same
  // achievement can be earned once per UTC calendar day.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_daily_achievements (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ach_id      TEXT    NOT NULL,
      claim_date  DATE    NOT NULL,
      claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, ach_id, claim_date)
    )
  `).catch((e: any) => console.warn('[Auth] user_daily_achievements:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_ach_user_date ON user_daily_achievements(user_id, claim_date DESC)`).catch(() => {});

  // Weekly achievements — keyed by ISO week-start date (Sunday 00:00 UTC).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_weekly_achievements (
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ach_id          TEXT    NOT NULL,
      week_start_date DATE    NOT NULL,
      claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, ach_id, week_start_date)
    )
  `).catch((e: any) => console.warn('[Auth] user_weekly_achievements:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_weekly_ach_user_date ON user_weekly_achievements(user_id, week_start_date DESC)`).catch(() => {});

  console.log('[Auth] Persistence sweep DDL applied');

  // Seed admin accounts
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminPhone = process.env.ADMIN_PHONE || '7202780636';

  if (adminPassword) {
    const hash = bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS);
    await pool.query(`
      INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE)
      ON CONFLICT (LOWER(username)) DO UPDATE SET password_hash = $2, is_admin = TRUE
    `, [adminPhone, hash]).catch(() => {
      // Fallback if the unique index conflict doesn't work
      pool.query(`UPDATE users SET password_hash = $1, is_admin = TRUE WHERE LOWER(username) = LOWER($2)`, [hash, adminPhone]).catch(() => {});
    });
    console.log(`[Auth] Admin user "${adminPhone}" seeded/synced`);
  }

  console.log('[Auth] PostgreSQL database initialized');
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function generateToken(userId: number, username: string, tokenVersion: number = 0): string {
  return jwt.sign({ userId, username, tokenVersion }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function formatUserData(user: UserData) {
  let stats: Record<string, any> = {};
  let achievements: string[] = [];
  try { stats = JSON.parse(user.stats || '{}'); } catch { stats = {}; }
  try { achievements = JSON.parse(user.achievements || '[]'); } catch { achievements = []; }
  return {
    id: user.id,
    username: user.displayName || user.username, // Public name — never expose phone
    phone: user.username, // Internal use only — not sent to other players
    displayName: user.displayName,
    needsUsername: !user.displayName, // Frontend should prompt to choose a name
    chips: user.chips,
    level: user.level,
    xp: user.xp,
    stats,
    achievements,
    isAdmin: user.isAdmin === 1,
  };
}

// ── Public API (all async) ──────────────────────────────────────────────────────

export async function isUsernameTaken(username: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [(username || '').trim()]);
  return rows.length > 0;
}

export async function registerUser(username: string, password: string): Promise<AuthResult> {
  const trimmed = (username || '').trim();
  if (!USERNAME_REGEX.test(trimmed)) return { success: false, error: 'Username must be 3-20 characters (letters, numbers, _ or -)' };
  if (!password || password.length < 4) return { success: false, error: 'Password must be at least 4 characters' };

  const existing = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [trimmed]);
  if (existing.rows.length > 0) return { success: false, error: 'Username already taken' };

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, chips, level, xp) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [trimmed, hash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP]
  );

  const user = rowToUserData(rows[0]);
  const token = generateToken(user.id, user.username);
  return { success: true, token, userData: formatUserData(user) };
}

// Master API auth
const MASTER_API_BASE = process.env.MASTER_API_URL || 'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';

async function authenticateWithMasterAPI(phone: string, password: string): Promise<any | null> {
  // 6s hard timeout. Previously this fetch had no timeout, so when the
  // master API was slow the login would hang until Node's default TCP
  // timeout (~2 min) — by which time the client had already given up and
  // the user saw "login timed out" with no upstream error logged.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${MASTER_API_BASE}/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password }),
      signal: controller.signal,
    });
    const data: any = await res.json();
    return (data.success && data.data) ? data.data : null;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.error('[Auth] Master API login timed out after 6s');
    } else {
      console.error('[Auth] Master API login failed:', err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function syncMasterUser(masterData: any, password: string): Promise<UserData> {
  const phone = masterData.phoneNumber;
  const displayName = masterData.firstName
    ? `${masterData.firstName} ${(masterData.lastName || '')[0] || ''}.`.trim()
    : masterData.username || phone;
  const isAdmin = masterData.roles?.includes('siteAdmin') || masterData.roles?.includes('leagueAdmin') || false;
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const { rows } = await pool.query(
    `INSERT INTO users (username, display_name, password_hash, chips, level, xp, stats, is_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (LOWER(username)) DO UPDATE SET password_hash = $3, is_admin = $8, display_name = COALESCE(users.display_name, $2)
     RETURNING *`,
    [phone, displayName, hash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP, JSON.stringify({ masterPhone: phone, masterUsername: masterData.username }), isAdmin]
  );

  if (rows.length > 0) return rowToUserData(rows[0]);
  // Fallback: query existing
  const fallback = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [phone]);
  return rowToUserData(fallback.rows[0]);
}

export function loginUser(username: string, password: string): AuthResult {
  // Sync version — kept for backwards compatibility but should not be used
  // Use loginUserAsync instead
  return { success: false, error: 'Use loginUserAsync for PostgreSQL' };
}

export async function loginUserAsync(username: string, password: string): Promise<AuthResult> {
  if (!username || !password) return { success: false, error: 'Phone number and password are required' };

  const rateCheck = checkLoginRateLimit(username);
  if (rateCheck.blocked) return { success: false, error: `Too many failed attempts. Try again in ${rateCheck.lockoutSecsLeft}s` } as any;

  // Try master API first
  const masterUser = await authenticateWithMasterAPI(username, password);
  if (masterUser) {
    const localUser = await syncMasterUser(masterUser, password);
    clearLoginAttempts(username);
    const token = generateToken(localUser.id, localUser.username, localUser.tokenVersion || 0);
    return { success: true, token, userData: formatUserData(localUser) };
  }

  // Fall back to local DB
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
  if (rows.length > 0) {
    const user = rowToUserData(rows[0]);
    if (user.banned) return { success: false, error: 'This account has been banned' };
    const valid = bcrypt.compareSync(password, rows[0].password_hash);
    if (valid) {
      clearLoginAttempts(username);
      const token = generateToken(user.id, user.username, user.tokenVersion || 0);
      return { success: true, token, userData: formatUserData(user) };
    }
  }

  recordFailedLogin(username);
  return { success: false, error: 'Invalid phone number or password' } as any;
}

export async function getUserFromToken(token: string): Promise<AuthResult> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; username: string; tokenVersion?: number };
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (rows.length === 0) return { success: false, error: 'User not found' };

    const user = rowToUserData(rows[0]);
    if ((decoded.tokenVersion ?? 0) < (user.tokenVersion || 0)) return { success: false, error: 'Session invalidated. Please log in again.' };
    if (user.banned) return { success: false, error: 'Account banned' };

    const newToken = generateToken(user.id, user.username, user.tokenVersion || 0);
    return { success: true, token: newToken, userData: formatUserData(user) };
  } catch {
    return { success: false, error: 'Invalid or expired token' };
  }
}

export async function saveProgress(userId: number, data: { level?: number; xp?: number; stats?: Record<string, any>; achievements?: string[] }): Promise<boolean> {
  try {
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    // SECURITY: `chips` is intentionally NOT in the accepted shape.
    // All chip mutations must flow through server-authoritative paths:
    //   - pot distribution (hand-complete)
    //   - addChipsToUser / deductChips (buy-in, rebuy, shop, daily rewards)
    //   - adminGrantChips (audited admin flow)
    // A client that sends chips here would have had its value written raw
    // before 2026-04-22. The socket handler strips chips before calling,
    // but this function also refuses at the DB boundary as defense-in-depth
    // — if any future caller passes `chips`, TypeScript rejects it and
    // runtime-strict destructuring below ignores it.
    // Level can ONLY go up — use GREATEST so a race-condition save
    // (in-memory fresh-init level 1 overwriting DB level 9) is rejected
    // at the database layer. This is the third-layer safety net on top of
    // the `hydrated` gate in the hand-complete handler and the in-memory
    // hydration step. Belt + suspenders for the "level keeps resetting"
    // bug users reported.
    if (data.level !== undefined) {
      sets.push(`level = GREATEST(level, $${idx++})`);
      vals.push(data.level);
    }
    // XP resets on level-up and can temporarily go down, BUT only if the
    // level field also advanced in the same write. Guard: accept xp write
    // only if either (a) level also bumped up, or (b) new xp >= old xp.
    // Use a subquery-driven ternary via CASE to handle both cases.
    if (data.xp !== undefined) {
      if (data.level !== undefined) {
        // Paired with a level write: accept xp unconditionally (new level means xp can reset).
        sets.push(`xp = $${idx++}`);
        vals.push(data.xp);
      } else {
        // Lone xp write: ratchet — only accept if >= current.
        sets.push(`xp = GREATEST(xp, $${idx++})`);
        vals.push(data.xp);
      }
    }
    if (data.stats !== undefined) { sets.push(`stats = $${idx++}`); vals.push(JSON.stringify(data.stats)); }
    // Achievements list should only grow — use a JSONB union via SQL so a
    // stale (empty) write doesn't erase unlocked achievements. We merge
    // existing + incoming, dedup, sort for stable comparison.
    if (data.achievements !== undefined) {
      sets.push(`achievements = (
        SELECT jsonb_agg(DISTINCT a ORDER BY a)::text
        FROM (
          SELECT jsonb_array_elements_text(achievements::jsonb) AS a
          UNION ALL
          SELECT jsonb_array_elements_text($${idx}::jsonb) AS a
        ) s
      )`);
      vals.push(JSON.stringify(data.achievements));
      idx++;
    }
    if (sets.length === 0) return true;
    vals.push(userId);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    return true;
  } catch (err) {
    console.error('[Auth] Failed to save progress:', err);
    return false;
  }
}

export async function loadProgress(userId: number): Promise<AuthResult> {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return { success: false, error: 'User not found' };
  return { success: true, userData: formatUserData(rowToUserData(rows[0])) };
}

export async function isUserAdmin(userId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}

// Character whitelist for display names. Intentionally strict:
//   letters (Unicode, so "João" / "Владимир" / "美琪" are fine),
//   digits, spaces, hyphen, underscore, period, apostrophe.
// No angle brackets, quotes, semicolons, backticks, HTML entities — those
// have been the XSS/injection vectors in the wild when names get echoed
// back unescaped (chat lines, leaderboard, hand history, etc.).
// `u` flag enables \p{L}/\p{N}; `v` would be newer, but Node runtimes we
// target don't all support it.
const DISPLAY_NAME_RE = /^[\p{L}\p{N} _.'-]+$/u;

export async function setDisplayName(userId: number, name: string): Promise<{ success: boolean; error?: string }> {
  const trimmed = (name || '').trim();
  if (trimmed.length < 2 || trimmed.length > 20) return { success: false, error: 'Name must be 2-20 characters' };
  if (!DISPLAY_NAME_RE.test(trimmed)) {
    return { success: false, error: 'Name can only contain letters, numbers, spaces, and _ . - \'' };
  }
  // Reject all-whitespace / all-punctuation names (would pass the regex
  // but look blank when rendered). Require at least one letter OR digit.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return { success: false, error: 'Name must contain at least one letter or number' };
  }
  // Check if name is already taken by another user
  const existing = await pool.query('SELECT id FROM users WHERE LOWER(display_name) = LOWER($1) AND id != $2', [trimmed, userId]);
  if (existing.rows.length > 0) return { success: false, error: 'Name already taken' };
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [trimmed, userId]);
  return { success: true };
}

export async function isUserBanned(userId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT banned FROM users WHERE id = $1', [userId]);
  return rows[0]?.banned === true;
}

export async function getAllUsers(): Promise<Array<{ id: number; username: string; chips: number; level: number; isAdmin: boolean; banned: boolean }>> {
  const { rows } = await pool.query('SELECT id, username, chips, level, is_admin, banned FROM users');
  return rows.map(u => ({ id: u.id, username: u.username, chips: u.chips, level: u.level, isAdmin: u.is_admin, banned: u.banned }));
}

export async function banUser(userId: number): Promise<boolean> {
  try { await pool.query('UPDATE users SET banned = TRUE, token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [userId]); return true; } catch { return false; }
}

export async function unbanUser(userId: number): Promise<boolean> {
  try { await pool.query('UPDATE users SET banned = FALSE WHERE id = $1', [userId]); return true; } catch { return false; }
}

export async function getUserChips(userId: number): Promise<number> {
  const { rows } = await pool.query('SELECT chips FROM users WHERE id = $1', [userId]);
  return rows[0]?.chips ?? 0;
}

export async function deductChips(userId: number, amount: number): Promise<boolean> {
  try {
    const { rowCount } = await pool.query('UPDATE users SET chips = chips - $1 WHERE id = $2 AND chips >= $1', [amount, userId]);
    return (rowCount ?? 0) > 0;
  } catch { return false; }
}

export async function addChipsToUser(userId: number, chips: number): Promise<boolean> {
  try { await pool.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [chips, userId]); return true; } catch { return false; }
}

export async function bumpTokenVersion(userId: number): Promise<void> {
  await pool.query('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [userId]);
}

export async function getTotalUsers(): Promise<number> {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM users');
  return parseInt(rows[0].count);
}

export async function mergeUserStats(userId: number, patch: Record<string, any>): Promise<void> {
  try {
    const { rows } = await pool.query('SELECT stats FROM users WHERE id = $1', [userId]);
    let existing: Record<string, any> = {};
    try { existing = JSON.parse(rows[0]?.stats || '{}'); } catch { /* ignore */ }
    const merged = { ...existing, ...patch };
    await pool.query('UPDATE users SET stats = $1 WHERE id = $2', [JSON.stringify(merged), userId]);
  } catch { /* ignore */ }
}

export interface LeaderboardEntry {
  rank: number; username: string; chips: number; level: number;
  handsPlayed: number; handsWon: number; winRate: number; biggestPot: number;
}

export async function getLeaderboard(limit = 50, period = 'alltime'): Promise<LeaderboardEntry[]> {
  const { rows } = await pool.query('SELECT username, chips, level, stats FROM users WHERE banned = FALSE ORDER BY chips DESC LIMIT $1', [limit]);

  const now = Date.now();
  let cutoff = 0;
  if (period === 'daily') cutoff = now - 86400000;
  else if (period === 'weekly') cutoff = now - 7 * 86400000;
  else if (period === 'season') cutoff = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const entries: LeaderboardEntry[] = [];
  let rank = 1;
  for (const row of rows) {
    let stats: Record<string, any> = {};
    try { stats = JSON.parse(row.stats || '{}'); } catch { /* ignore */ }
    if (cutoff > 0 && (stats.lastHandAt || 0) < cutoff) continue;
    const handsPlayed = stats.handsPlayed || stats.totalHandsPlayed || 0;
    const handsWon = stats.handsWon || 0;
    entries.push({ rank: rank++, username: row.username, chips: row.chips, level: row.level,
      handsPlayed, handsWon, winRate: handsPlayed > 0 ? Math.round((handsWon / handsPlayed) * 1000) / 10 : 0,
      biggestPot: stats.biggestPot || 0 });
  }
  return entries;
}

export async function searchUsers(query: string, limit = 10): Promise<Array<{ id: number; username: string; chips: number; level: number }>> {
  const { rows } = await pool.query('SELECT id, username, chips, level FROM users WHERE banned = FALSE AND LOWER(username) LIKE $1 LIMIT $2', [`%${query.toLowerCase()}%`, limit]);
  return rows;
}

// =============================================================================
// Persistence sweep helpers (stars, inventory, claims, customization, etc.)
// =============================================================================

/** Update the stars balance for a user. Fire-and-forget friendly.
 *
 * WARNING: plain SET — callers must hold a hydrated in-memory source of
 * truth before writing, or data from parallel grants can be clobbered.
 * Prefer `addStarsToUser` / `deductStars` for grants. `persistStars` is
 * only appropriate for full-snapshot resync paths (graceful shutdown,
 * durable-state reconciliation) where the caller has loaded fresh DB
 * state first.
 */
export async function persistStars(userId: number, stars: number): Promise<void> {
  try {
    await pool.query('UPDATE users SET stars = $1 WHERE id = $2', [Math.max(0, Math.floor(stars)), userId]);
  } catch (e: any) {
    console.warn(`[persistStars ${userId}]`, e.message);
  }
}

/** Atomic additive star credit — analogous to addChipsToUser.
 *  Postgres serializes `stars = stars + $1` correctly across concurrent
 *  writes, so grants can't clobber each other. Use for daily rewards,
 *  battle pass, scratch cards, shop refunds — anywhere a delta is added. */
export async function addStarsToUser(userId: number, stars: number): Promise<boolean> {
  try {
    const amount = Math.max(0, Math.floor(stars));
    if (amount === 0) return true;
    await pool.query('UPDATE users SET stars = stars + $1 WHERE id = $2', [amount, userId]);
    return true;
  } catch (e: any) {
    console.error(`[addStarsToUser ${userId}] amount=${stars}`, e.message);
    return false;
  }
}

/** Atomic check-and-deduct — returns false if balance insufficient. */
export async function deductStars(userId: number, stars: number): Promise<boolean> {
  try {
    const amount = Math.max(0, Math.floor(stars));
    if (amount === 0) return true;
    const { rowCount } = await pool.query(
      'UPDATE users SET stars = stars - $1 WHERE id = $2 AND stars >= $1',
      [amount, userId]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.error(`[deductStars ${userId}] amount=${stars}`, e.message);
    return false;
  }
}

/** Load the durable progression fields from DB (seed values for ProgressionManager.getOrCreateProgress). */
export async function loadDurableProgress(userId: number): Promise<{
  stars: number;
  loginStreak: number;
  lastLoginClaimDate: string | null;
  scratchCardsAvailable: number;
  handsSinceLastScratch: number;
  customization: any;
  preferences: any;
} | null> {
  try {
    const { rows } = await pool.query(
      `SELECT stars, login_streak, last_login_claim_date, scratch_cards_available, hands_since_last_scratch, customization, preferences
         FROM users WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      stars: r.stars || 0,
      loginStreak: r.login_streak || 0,
      lastLoginClaimDate: r.last_login_claim_date ? new Date(r.last_login_claim_date).toISOString().slice(0, 10) : null,
      scratchCardsAvailable: r.scratch_cards_available || 0,
      handsSinceLastScratch: r.hands_since_last_scratch || 0,
      customization: r.customization || {},
      preferences: r.preferences || {},
    };
  } catch (e: any) {
    console.warn(`[loadDurableProgress ${userId}]`, e.message);
    return null;
  }
}

/** Load the user's full inventory with equipped flags. */
export async function loadInventory(userId: number): Promise<Array<{ item_type: string; item_id: string; equipped: boolean; acquired_at: string }>> {
  try {
    const { rows } = await pool.query(
      `SELECT item_type, item_id, equipped, acquired_at FROM user_inventory WHERE user_id = $1 ORDER BY acquired_at`,
      [userId]
    );
    return rows;
  } catch (e: any) {
    console.warn(`[loadInventory ${userId}]`, e.message);
    return [];
  }
}

/** Grant a cosmetic item. Returns true if newly granted, false if already owned. */
export async function grantItem(userId: number, itemType: string, itemId: string): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO user_inventory (user_id, item_type, item_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_type, item_id) DO NOTHING`,
      [userId, itemType, itemId]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[grantItem ${userId} ${itemType}/${itemId}]`, e.message);
    return false;
  }
}

/** Equip an item. Unequips other items of the same type first. Returns true if owned+equipped. */
export async function equipItem(userId: number, itemType: string, itemId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: owns } = await client.query(
      `SELECT 1 FROM user_inventory WHERE user_id = $1 AND item_type = $2 AND item_id = $3`,
      [userId, itemType, itemId]
    );
    if ((owns || 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`UPDATE user_inventory SET equipped = FALSE WHERE user_id = $1 AND item_type = $2`, [userId, itemType]);
    await client.query(`UPDATE user_inventory SET equipped = TRUE WHERE user_id = $1 AND item_type = $2 AND item_id = $3`, [userId, itemType, itemId]);
    await client.query('COMMIT');
    return true;
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch {}
    console.warn(`[equipItem ${userId} ${itemType}/${itemId}]`, e.message);
    return false;
  } finally {
    client.release();
  }
}

/** Check if a daily claim of a given type has already been made today. */
export async function hasClaimedToday(userId: number, claimType: string): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM user_daily_claims WHERE user_id = $1 AND claim_type = $2 AND claim_date = CURRENT_DATE`,
      [userId, claimType]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[hasClaimedToday ${userId} ${claimType}]`, e.message);
    return false;
  }
}

/** Record a daily claim. Returns true if newly recorded, false if already claimed. */
export async function recordDailyClaim(userId: number, claimType: string, payload: any = null): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO user_daily_claims (user_id, claim_type, claim_date, payload) VALUES ($1, $2, CURRENT_DATE, $3)
         ON CONFLICT (user_id, claim_type, claim_date) DO NOTHING`,
      [userId, claimType, payload ? JSON.stringify(payload) : null]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[recordDailyClaim ${userId} ${claimType}]`, e.message);
    return false;
  }
}

/** Update login streak after a successful claim. */
export async function updateLoginStreak(userId: number, streak: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE users SET login_streak = $1, last_login_claim_date = CURRENT_DATE WHERE id = $2`,
      [streak, userId]
    );
  } catch (e: any) {
    console.warn(`[updateLoginStreak ${userId}]`, e.message);
  }
}

/** Increment hands_since_last_scratch; if it crosses 20, bank a card and reset the counter. Returns whether a card was awarded. */
export async function tickScratchProgress(userId: number): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET hands_since_last_scratch = hands_since_last_scratch + 1 WHERE id = $1 RETURNING hands_since_last_scratch`,
      [userId]
    );
    if (rows.length === 0) return false;
    if (rows[0].hands_since_last_scratch >= 20) {
      await pool.query(
        `UPDATE users SET hands_since_last_scratch = 0, scratch_cards_available = scratch_cards_available + 1 WHERE id = $1`,
        [userId]
      );
      return true;
    }
    return false;
  } catch (e: any) {
    console.warn(`[tickScratchProgress ${userId}]`, e.message);
    return false;
  }
}

/** Consume one scratch card. Returns true if consumed, false if none available. */
export async function consumeScratchCard(userId: number): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE users SET scratch_cards_available = scratch_cards_available - 1
         WHERE id = $1 AND scratch_cards_available > 0`,
      [userId]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[consumeScratchCard ${userId}]`, e.message);
    return false;
  }
}

/** Try to claim a battle pass tier. Returns true if newly claimed. */
export async function claimBattlePassTier(userId: number, seasonId: string, tierId: number): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO user_battle_pass_claims (user_id, season_id, tier_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, season_id, tier_id) DO NOTHING`,
      [userId, seasonId, tierId]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[claimBattlePassTier ${userId} ${seasonId}/${tierId}]`, e.message);
    return false;
  }
}

/** List claimed battle pass tiers for a season. */
export async function loadBattlePassClaims(userId: number, seasonId: string): Promise<number[]> {
  try {
    const { rows } = await pool.query(
      `SELECT tier_id FROM user_battle_pass_claims WHERE user_id = $1 AND season_id = $2 ORDER BY tier_id`,
      [userId, seasonId]
    );
    return rows.map((r: any) => r.tier_id);
  } catch (e: any) {
    console.warn(`[loadBattlePassClaims ${userId} ${seasonId}]`, e.message);
    return [];
  }
}

/** Merge customization fields. */
export async function persistCustomization(userId: number, patch: any): Promise<void> {
  try {
    await pool.query(
      `UPDATE users SET customization = customization || $1::jsonb WHERE id = $2`,
      [JSON.stringify(patch || {}), userId]
    );
  } catch (e: any) {
    console.warn(`[persistCustomization ${userId}]`, e.message);
  }
}

/** Merge preference fields. */
export async function persistPreferences(userId: number, patch: any): Promise<void> {
  try {
    await pool.query(
      `UPDATE users SET preferences = preferences || $1::jsonb WHERE id = $2`,
      [JSON.stringify(patch || {}), userId]
    );
  } catch (e: any) {
    console.warn(`[persistPreferences ${userId}]`, e.message);
  }
}

/** Record a hand into user_hand_history. Caps to latest 100 per user. */
export async function recordHand(userId: number, handId: string, data: any): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO user_hand_history (user_id, hand_id, data) VALUES ($1, $2, $3)`,
      [userId, handId, JSON.stringify(data)]
    );
    // Cap at 100 — delete anything older than the newest 100.
    await pool.query(
      `DELETE FROM user_hand_history
         WHERE user_id = $1
           AND id NOT IN (
             SELECT id FROM user_hand_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100
           )`,
      [userId]
    );
  } catch (e: any) {
    console.warn(`[recordHand ${userId}]`, e.message);
  }
}

/** Load the most recent N hand history rows for a user. */
export async function loadHandHistory(userId: number, limit = 100): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT hand_id, data, created_at FROM user_hand_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map((r: any) => ({ ...r.data, handId: r.hand_id, timestamp: r.created_at }));
  } catch (e: any) {
    console.warn(`[loadHandHistory ${userId}]`, e.message);
    return [];
  }
}

// ── Daily / Weekly achievement persistence ─────────────────────────────────
//
// Daily:  keyed by (user, ach_id, UTC date). PK is unique so a second insert
//         for the same day is a no-op via ON CONFLICT DO NOTHING. Returns
//         true if the row was actually inserted (first earn today).
// Weekly: same pattern but keyed by week_start_date (Sunday 00:00 UTC).

/** Return today's UTC date as a YYYY-MM-DD string. */
function utcDateStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
/** Return the Sunday (week start) of the current UTC week as YYYY-MM-DD. */
function utcWeekStartStr(d: Date = new Date()): string {
  const dow = d.getUTCDay();
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return sunday.toISOString().slice(0, 10);
}

export async function recordDailyAchievement(userId: number, achId: string): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO user_daily_achievements (user_id, ach_id, claim_date)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, achId, utcDateStr()]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[recordDailyAchievement ${userId} ${achId}]`, e.message);
    return false;
  }
}

export async function recordWeeklyAchievement(userId: number, achId: string): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO user_weekly_achievements (user_id, ach_id, week_start_date)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, achId, utcWeekStartStr()]
    );
    return (rowCount || 0) > 0;
  } catch (e: any) {
    console.warn(`[recordWeeklyAchievement ${userId} ${achId}]`, e.message);
    return false;
  }
}

/** Return the IDs of daily achievements this user already earned TODAY. */
export async function loadTodayDailyAchievements(userId: number): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `SELECT ach_id FROM user_daily_achievements WHERE user_id = $1 AND claim_date = $2`,
      [userId, utcDateStr()]
    );
    return rows.map((r: any) => r.ach_id);
  } catch (e: any) {
    console.warn(`[loadTodayDailyAchievements ${userId}]`, e.message);
    return [];
  }
}

/** Return the IDs of weekly achievements this user already earned THIS WEEK. */
export async function loadThisWeekWeeklyAchievements(userId: number): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `SELECT ach_id FROM user_weekly_achievements WHERE user_id = $1 AND week_start_date = $2`,
      [userId, utcWeekStartStr()]
    );
    return rows.map((r: any) => r.ach_id);
  } catch (e: any) {
    console.warn(`[loadThisWeekWeeklyAchievements ${userId}]`, e.message);
    return [];
  }
}

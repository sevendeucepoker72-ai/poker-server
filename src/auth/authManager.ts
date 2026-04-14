import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';

// JWT secret — must be set via environment variable in production
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[Auth] FATAL: JWT_SECRET env var is not set in production. Refusing to start.');
    process.exit(1);
  }
  console.warn('[Auth] WARNING: JWT_SECRET env var not set. Using insecure fallback — NEVER deploy this to production!');
}
const JWT_SECRET = process.env.JWT_SECRET || 'american-pub-poker-jwt-secret-2024-dev-only';
const JWT_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 10;

// Default starting values for new users
const DEFAULT_CHIPS = 10000;
const DEFAULT_LEVEL = 1;
const DEFAULT_XP = 0;

// In-memory login rate limiter
const loginAttempts = new Map<string, { attempts: number; firstAttemptAt: number; lockedUntil: number }>();
const RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 5 * 60 * 1000 };

function checkLoginRateLimit(username: string): { blocked: boolean; lockoutSecsLeft: number } {
  const key = username.trim().toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry) return { blocked: false, lockoutSecsLeft: 0 };
  const now = Date.now();
  if (entry.lockedUntil > now) {
    return { blocked: true, lockoutSecsLeft: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  // Reset if window has passed
  if (now - entry.firstAttemptAt > RATE_LIMIT.windowMs) {
    loginAttempts.delete(key);
    return { blocked: false, lockoutSecsLeft: 0 };
  }
  return { blocked: false, lockoutSecsLeft: 0 };
}

function recordFailedLogin(username: string): { lockoutSecsLeft: number } {
  const key = username.trim().toLowerCase();
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > RATE_LIMIT.windowMs) {
    entry = { attempts: 0, firstAttemptAt: now, lockedUntil: 0 };
  }
  entry.attempts += 1;
  if (entry.attempts >= RATE_LIMIT.maxAttempts) {
    entry.lockedUntil = now + RATE_LIMIT.lockoutMs;
    loginAttempts.set(key, entry);
    return { lockoutSecsLeft: Math.ceil(RATE_LIMIT.lockoutMs / 1000) };
  }
  loginAttempts.set(key, entry);
  return { lockoutSecsLeft: 0 };
}

function clearLoginAttempts(username: string): void {
  loginAttempts.delete(username.trim().toLowerCase());
}

// Username validation: 3-20 chars, alphanumeric + underscore + hyphen
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;

export interface UserData {
  id: number;
  username: string;
  chips: number;
  level: number;
  xp: number;
  stats: string; // JSON string
  achievements: string; // JSON string
  isAdmin: number; // 0 or 1
  banned: number; // 0 or 1
  tokenVersion: number; // incremented on ban/password change to invalidate existing JWTs
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
  };
}

let db: Database.Database;

export function initDB(): void {
  const dbPath = path.join(__dirname, '..', '..', 'data', 'poker.db');

  // Ensure data directory exists
  const fs = require('fs');
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Create users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      chips INTEGER DEFAULT ${DEFAULT_CHIPS},
      level INTEGER DEFAULT ${DEFAULT_LEVEL},
      xp INTEGER DEFAULT ${DEFAULT_XP},
      stats TEXT DEFAULT '{}',
      achievements TEXT DEFAULT '[]',
      isAdmin INTEGER DEFAULT 0,
      banned INTEGER DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add isAdmin and banned columns if they don't exist (migration for existing DBs)
  try {
    db.exec('ALTER TABLE users ADD COLUMN isAdmin INTEGER DEFAULT 0');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0');
  } catch { /* column already exists */ }
  // tokenVersion: incremented on ban/password-change to invalidate existing JWTs
  try {
    db.exec('ALTER TABLE users ADD COLUMN tokenVersion INTEGER DEFAULT 0');
  } catch { /* column already exists */ }

  // Seed / sync admin accounts (phone number as username for pub poker)
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminPhone = process.env.ADMIN_PHONE || '7202780636';

  // Seed admin by phone number
  const existingPhone = db.prepare('SELECT id FROM users WHERE username = ?').get(adminPhone) as { id: number } | undefined;
  if (!existingPhone) {
    if (adminPassword) {
      const phoneHash = bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS);
      db.prepare(
        'INSERT INTO users (username, passwordHash, chips, level, xp, stats, achievements, isAdmin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(adminPhone, phoneHash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP, '{}', '[]', 1);
      console.log(`[Auth] Admin user "${adminPhone}" seeded`);
    }
  } else {
    db.prepare('UPDATE users SET isAdmin = 1 WHERE username = ?').run(adminPhone);
    if (adminPassword) {
      const phoneHash = bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS);
      db.prepare('UPDATE users SET passwordHash = ? WHERE username = ?').run(phoneHash, adminPhone);
      console.log(`[Auth] Admin user "${adminPhone}" password synced from ADMIN_PASSWORD env var`);
    }
  }

  // Also seed legacy "Josh" admin for backwards compatibility
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get('Josh') as { id: number } | undefined;
  if (!existingUser) {
    if (adminPassword) {
      const joshHash = bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS);
      db.prepare(
        'INSERT INTO users (username, passwordHash, chips, level, xp, stats, achievements, isAdmin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Josh', joshHash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP, '{}', '[]', 1);
      console.log('[Auth] Default admin user "Josh" seeded');
    }
  } else {
    db.prepare('UPDATE users SET isAdmin = 1 WHERE username = ?').run('Josh');
    if (adminPassword) {
      const joshHash = bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS);
      db.prepare('UPDATE users SET passwordHash = ? WHERE username = ?').run(joshHash, 'Josh');
    }
  }

  console.log('[Auth] Database initialized');
}

function generateToken(userId: number, username: string, tokenVersion: number = 0): string {
  return jwt.sign({ userId, username, tokenVersion }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function formatUserData(user: UserData) {
  let stats: Record<string, any> = {};
  let achievements: string[] = [];

  try {
    stats = JSON.parse(user.stats || '{}');
  } catch {
    stats = {};
  }
  try {
    achievements = JSON.parse(user.achievements || '[]');
  } catch {
    achievements = [];
  }

  return {
    id: user.id,
    username: user.username,
    chips: user.chips,
    level: user.level,
    xp: user.xp,
    stats,
    achievements,
    isAdmin: user.isAdmin === 1,
  };
}

export function isUsernameTaken(username: string): boolean {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get((username || '').trim());
  return !!existing;
}

export function registerUser(username: string, password: string): AuthResult {
  const trimmed = (username || '').trim();
  if (!USERNAME_REGEX.test(trimmed)) {
    return { success: false, error: 'Username must be 3-20 characters (letters, numbers, _ or -)' };
  }
  if (!password || password.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters' };
  }

  // Check if username is taken
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmed);
  if (existing) {
    return { success: false, error: 'Username already taken' };
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const result = db.prepare(
    'INSERT INTO users (username, passwordHash, chips, level, xp, stats, achievements) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(trimmed, hash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP, '{}', '[]');

  const userId = result.lastInsertRowid as number;
  const token = generateToken(userId, trimmed);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserData;

  return {
    success: true,
    token,
    userData: formatUserData(user),
  };
}

/**
 * Master API base URL for americanpub.poker authentication.
 * All login attempts are validated against this API first.
 */
const MASTER_API_BASE = process.env.MASTER_API_URL || 'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';

/**
 * Authenticate against the master americanpub.poker API.
 * Returns the master user data on success, null on failure.
 */
async function authenticateWithMasterAPI(phone: string, password: string): Promise<any | null> {
  try {
    const res = await fetch(`${MASTER_API_BASE}/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password }),
    });
    const data: any = await res.json();
    if (data.success && data.data) {
      return data.data;
    }
    return null;
  } catch (err) {
    console.error('[Auth] Master API login failed:', err);
    return null;
  }
}

/**
 * Sync a master API user into the local SQLite database.
 * Creates the user if they don't exist, or updates their info.
 */
function syncMasterUser(masterData: any, password: string): UserData {
  const phone = masterData.phoneNumber;
  const displayName = masterData.firstName
    ? `${masterData.firstName} ${(masterData.lastName || '')[0] || ''}.`.trim()
    : masterData.username || phone;

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(phone) as UserData | undefined;
  const isAdmin = masterData.roles?.includes('siteAdmin') || masterData.roles?.includes('leagueAdmin') || false;
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  if (!existing) {
    const result = db.prepare(
      'INSERT INTO users (username, passwordHash, chips, level, xp, stats, achievements, isAdmin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(phone, hash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP,
      JSON.stringify({ displayName, masterPhone: phone, masterUsername: masterData.username }), '[]', isAdmin ? 1 : 0);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as UserData;
  } else {
    // Update password hash and admin status
    db.prepare('UPDATE users SET passwordHash = ?, isAdmin = ? WHERE username = ?')
      .run(hash, isAdmin ? 1 : 0, phone);
    return db.prepare('SELECT * FROM users WHERE username = ?').get(phone) as UserData;
  }
}

export function loginUser(username: string, password: string): AuthResult {
  if (!username || !password) {
    return { success: false, error: 'Phone number and password are required' };
  }

  // Check rate limit
  const rateCheck = checkLoginRateLimit(username);
  if (rateCheck.blocked) {
    return { success: false, error: `Too many failed attempts. Try again in ${rateCheck.lockoutSecsLeft}s`, lockoutSecs: rateCheck.lockoutSecsLeft } as any;
  }

  // First try local database (for cached credentials / offline play)
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserData | undefined;
  if (user) {
    if (user.banned) {
      return { success: false, error: 'This account has been banned' };
    }
    const passwordHash = (user as any).passwordHash as string;
    const valid = bcrypt.compareSync(password, passwordHash);
    if (valid) {
      clearLoginAttempts(username);
      const token = generateToken(user.id, user.username, user.tokenVersion || 0);
      return { success: true, token, userData: formatUserData(user) };
    }
  }

  // Local auth failed — fall through to master API (async handled via wrapper)
  recordFailedLogin(username);
  const entry = loginAttempts.get(username.trim().toLowerCase());
  const attemptsLeft = entry ? Math.max(0, RATE_LIMIT.maxAttempts - entry.attempts) : RATE_LIMIT.maxAttempts;
  return { success: false, error: 'Invalid phone number or password', attemptsLeft } as any;
}

/**
 * Async login — tries master API first, then falls back to local.
 * Used by the socket handler for real-time auth.
 */
export async function loginUserAsync(username: string, password: string): Promise<AuthResult> {
  if (!username || !password) {
    return { success: false, error: 'Phone number and password are required' };
  }

  const rateCheck = checkLoginRateLimit(username);
  if (rateCheck.blocked) {
    return { success: false, error: `Too many failed attempts. Try again in ${rateCheck.lockoutSecsLeft}s`, lockoutSecs: rateCheck.lockoutSecsLeft } as any;
  }

  // Try master API first (americanpub.poker)
  const masterUser = await authenticateWithMasterAPI(username, password);
  if (masterUser) {
    const localUser = syncMasterUser(masterUser, password);
    clearLoginAttempts(username);
    const token = generateToken(localUser.id, localUser.username, localUser.tokenVersion || 0);
    return { success: true, token, userData: formatUserData(localUser) };
  }

  // Fall back to local-only auth
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserData | undefined;
  if (user) {
    if (user.banned) return { success: false, error: 'This account has been banned' };
    const valid = bcrypt.compareSync(password, (user as any).passwordHash);
    if (valid) {
      clearLoginAttempts(username);
      const token = generateToken(user.id, user.username, user.tokenVersion || 0);
      return { success: true, token, userData: formatUserData(user) };
    }
  }

  recordFailedLogin(username);
  const entry = loginAttempts.get(username.trim().toLowerCase());
  const attemptsLeft = entry ? Math.max(0, RATE_LIMIT.maxAttempts - entry.attempts) : RATE_LIMIT.maxAttempts;
  return { success: false, error: 'Invalid phone number or password', attemptsLeft } as any;
}

export function getUserFromToken(token: string): AuthResult {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; username: string; tokenVersion?: number };
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as UserData | undefined;

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Reject tokens whose version is older than the current DB version (e.g. banned user)
    if ((decoded.tokenVersion ?? 0) < (user.tokenVersion || 0)) {
      return { success: false, error: 'Session invalidated. Please log in again.' };
    }

    if (user.banned) {
      return { success: false, error: 'Account banned' };
    }

    const newToken = generateToken(user.id, user.username, user.tokenVersion || 0);

    return {
      success: true,
      token: newToken,
      userData: formatUserData(user),
    };
  } catch (err: any) {
    return { success: false, error: 'Invalid or expired token' };
  }
}

export function saveProgress(
  userId: number,
  data: {
    chips?: number;
    level?: number;
    xp?: number;
    stats?: Record<string, any>;
    achievements?: string[];
  }
): boolean {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserData | undefined;
    if (!user) return false;

    const updates: string[] = [];
    const values: any[] = [];

    if (data.chips !== undefined) {
      updates.push('chips = ?');
      values.push(data.chips);
    }
    if (data.level !== undefined) {
      updates.push('level = ?');
      values.push(data.level);
    }
    if (data.xp !== undefined) {
      updates.push('xp = ?');
      values.push(data.xp);
    }
    if (data.stats !== undefined) {
      updates.push('stats = ?');
      values.push(JSON.stringify(data.stats));
    }
    if (data.achievements !== undefined) {
      updates.push('achievements = ?');
      values.push(JSON.stringify(data.achievements));
    }

    if (updates.length === 0) return true;

    values.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    return true;
  } catch (err) {
    console.error('[Auth] Failed to save progress:', err);
    return false;
  }
}

export function loadProgress(userId: number): AuthResult {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserData | undefined;
  if (!user) {
    return { success: false, error: 'User not found' };
  }

  return {
    success: true,
    userData: formatUserData(user),
  };
}

export function isUserAdmin(userId: number): boolean {
  const user = db.prepare('SELECT isAdmin FROM users WHERE id = ?').get(userId) as { isAdmin: number } | undefined;
  return user?.isAdmin === 1;
}

export function getAllUsers(): Array<{ id: number; username: string; chips: number; level: number; isAdmin: boolean; banned: boolean }> {
  const users = db.prepare('SELECT id, username, chips, level, isAdmin, banned FROM users').all() as Array<{ id: number; username: string; chips: number; level: number; isAdmin: number; banned: number }>;
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    chips: u.chips,
    level: u.level,
    isAdmin: u.isAdmin === 1,
    banned: u.banned === 1,
  }));
}

export function banUser(userId: number): boolean {
  try {
    // Bump tokenVersion so all existing JWTs for this user are immediately invalidated
    db.prepare('UPDATE users SET banned = 1, tokenVersion = COALESCE(tokenVersion, 0) + 1 WHERE id = ?').run(userId);
    return true;
  } catch {
    return false;
  }
}

export function getUserChips(userId: number): number {
  const row = db.prepare('SELECT chips FROM users WHERE id = ?').get(userId) as { chips: number } | undefined;
  return row?.chips ?? 0;
}

export function deductChips(userId: number, amount: number): boolean {
  try {
    const result = db.prepare(
      'UPDATE users SET chips = chips - ? WHERE id = ? AND chips >= ?'
    ).run(amount, userId, amount) as { changes: number };
    return result.changes > 0;
  } catch {
    return false;
  }
}

export function bumpTokenVersion(userId: number): void {
  db.prepare('UPDATE users SET tokenVersion = COALESCE(tokenVersion, 0) + 1 WHERE id = ?').run(userId);
}

export function unbanUser(userId: number): boolean {
  try {
    db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(userId);
    return true;
  } catch {
    return false;
  }
}

export function addChipsToUser(userId: number, chips: number): boolean {
  try {
    db.prepare('UPDATE users SET chips = chips + ? WHERE id = ?').run(chips, userId);
    return true;
  } catch {
    return false;
  }
}

export function isUserBanned(userId: number): boolean {
  const user = db.prepare('SELECT banned FROM users WHERE id = ?').get(userId) as { banned: number } | undefined;
  return user?.banned === 1;
}

export function getTotalUsers(): number {
  const result = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return result.count;
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  chips: number;
  level: number;
  handsPlayed: number;
  handsWon: number;
  winRate: number;
  biggestPot: number;
}

/** Merge a partial stats patch into the existing stats JSON for a user. */
export function mergeUserStats(userId: number, patch: Record<string, any>): void {
  try {
    const row = db.prepare('SELECT stats FROM users WHERE id = ?').get(userId) as { stats: string } | undefined;
    let existing: Record<string, any> = {};
    try { existing = JSON.parse(row?.stats || '{}'); } catch { /* ignore */ }
    const merged = { ...existing, ...patch };
    db.prepare('UPDATE users SET stats = ? WHERE id = ?').run(JSON.stringify(merged), userId);
  } catch { /* ignore */ }
}

export function getLeaderboard(limit = 50, period = 'alltime'): LeaderboardEntry[] {
  const rows = db.prepare(
    'SELECT username, chips, level, stats FROM users WHERE banned = 0 ORDER BY chips DESC LIMIT ?'
  ).all(limit) as Array<{ username: string; chips: number; level: number; stats: string }>;

  const now = Date.now();
  let cutoff = 0;
  if (period === 'daily') {
    cutoff = now - 24 * 60 * 60 * 1000;
  } else if (period === 'weekly') {
    cutoff = now - 7 * 24 * 60 * 60 * 1000;
  } else if (period === 'season') {
    // Start of current calendar month
    const d = new Date();
    cutoff = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  const entries: LeaderboardEntry[] = [];
  let rank = 1;
  for (const row of rows) {
    let stats: Record<string, any> = {};
    try { stats = JSON.parse(row.stats || '{}'); } catch { /* ignore */ }

    // For period-filtered views, only include players who have been active recently
    if (cutoff > 0) {
      const lastHandAt = stats.lastHandAt || 0;
      if (lastHandAt < cutoff) continue;
    }

    const handsPlayed = stats.handsPlayed || stats.totalHandsPlayed || 0;
    const handsWon = stats.handsWon || 0;
    const winRate = handsPlayed > 0 ? Math.round((handsWon / handsPlayed) * 1000) / 10 : 0;
    entries.push({
      rank: rank++,
      username: row.username,
      chips: row.chips,
      level: row.level,
      handsPlayed,
      handsWon,
      winRate,
      biggestPot: stats.biggestPot || 0,
    });
  }
  return entries;
}

export function searchUsers(query: string, limit = 10): Array<{ id: number; username: string; chips: number; level: number }> {
  const q = `%${query.toLowerCase()}%`;
  const rows = db.prepare(
    'SELECT id, username, chips, level FROM users WHERE banned = 0 AND LOWER(username) LIKE ? LIMIT ?'
  ).all(q, limit) as Array<{ id: number; username: string; chips: number; level: number }>;
  return rows;
}

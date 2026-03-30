import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';

// JWT secret - use environment variable or fallback constant
const JWT_SECRET = process.env.JWT_SECRET || 'american-pub-poker-jwt-secret-2024';
const JWT_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 10;

// Default starting values for new users
const DEFAULT_CHIPS = 10000;
const DEFAULT_LEVEL = 1;
const DEFAULT_XP = 0;

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

  // Seed default user "Josh" if not exists, mark as admin
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get('Josh') as { id: number } | undefined;
  const joshHash = bcrypt.hashSync('13811', BCRYPT_ROUNDS);
  if (!existingUser) {
    db.prepare(
      'INSERT INTO users (username, passwordHash, chips, level, xp, stats, achievements, isAdmin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('Josh', joshHash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP, '{}', '[]', 1);
    console.log('[Auth] Default user "Josh" seeded as admin');
  } else {
    // Always reset Josh's password and ensure admin status
    db.prepare('UPDATE users SET passwordHash = ?, isAdmin = 1 WHERE username = ?').run(joshHash, 'Josh');
    console.log('[Auth] Default user "Josh" password refreshed');
  }

  console.log('[Auth] Database initialized');
}

function generateToken(userId: number, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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
  if (!username || username.trim().length < 2) {
    return { success: false, error: 'Username must be at least 2 characters' };
  }
  if (!password || password.length < 3) {
    return { success: false, error: 'Password must be at least 3 characters' };
  }

  // Check if username is taken
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return { success: false, error: 'Username already taken' };
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const result = db.prepare(
    'INSERT INTO users (username, passwordHash, chips, level, xp, stats, achievements) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(username.trim(), hash, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP, '{}', '[]');

  const userId = result.lastInsertRowid as number;
  const token = generateToken(userId, username.trim());

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserData;

  return {
    success: true,
    token,
    userData: formatUserData(user),
  };
}

export function loginUser(username: string, password: string): AuthResult {
  if (!username || !password) {
    return { success: false, error: 'Username and password are required' };
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserData | undefined;
  if (!user) {
    return { success: false, error: 'Invalid username or password' };
  }

  const passwordHash = (user as any).passwordHash as string;
  const valid = bcrypt.compareSync(password, passwordHash);
  if (!valid) {
    return { success: false, error: 'Invalid username or password' };
  }

  const token = generateToken(user.id, user.username);

  return {
    success: true,
    token,
    userData: formatUserData(user),
  };
}

export function getUserFromToken(token: string): AuthResult {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; username: string };
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as UserData | undefined;

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    const newToken = generateToken(user.id, user.username);

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
    db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(userId);
    return true;
  } catch {
    return false;
  }
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

export function getLeaderboard(limit = 50): LeaderboardEntry[] {
  const rows = db.prepare(
    'SELECT username, chips, level, stats FROM users WHERE banned = 0 ORDER BY chips DESC LIMIT ?'
  ).all(limit) as Array<{ username: string; chips: number; level: number; stats: string }>;

  return rows.map((row, i) => {
    let stats: Record<string, any> = {};
    try { stats = JSON.parse(row.stats || '{}'); } catch { /* ignore */ }
    const handsPlayed = stats.handsPlayed || 0;
    const handsWon = stats.handsWon || 0;
    const winRate = handsPlayed > 0 ? Math.round((handsWon / handsPlayed) * 1000) / 10 : 0;
    return {
      rank: i + 1,
      username: row.username,
      chips: row.chips,
      level: row.level,
      handsPlayed,
      handsWon,
      winRate,
      biggestPot: stats.biggestPot || 0,
    };
  });
}

export function searchUsers(query: string, limit = 10): Array<{ id: number; username: string; chips: number; level: number }> {
  const q = `%${query.toLowerCase()}%`;
  const rows = db.prepare(
    'SELECT id, username, chips, level FROM users WHERE banned = 0 AND LOWER(username) LIKE ? LIMIT ?'
  ).all(q, limit) as Array<{ id: number; username: string; chips: number; level: number }>;
  return rows;
}

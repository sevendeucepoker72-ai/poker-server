import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ========== Types ==========

export interface ClubSettings {
  rake: number;        // 0-5 percentage
  maxMembers: number;  // default 100
  isPrivate: boolean;
  requireApproval: boolean;
}

export interface Club {
  id: number;
  clubCode: string;    // 6-digit unique code
  name: string;
  description: string;
  ownerId: number;
  settings: ClubSettings;
  createdAt: string;
}

export interface ClubMember {
  id: number;
  clubId: number;
  userId: number;
  username?: string;
  role: 'owner' | 'manager' | 'member';
  joinedAt: string;
  status: 'active' | 'pending' | 'banned';
}

export interface ClubTable {
  id: number;
  clubId: number;
  tableName: string;
  variant: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxSeats: number;
  isActive: boolean;
  tableId?: string; // runtime table ID in TableManager
}

export interface ClubInfo {
  id: number;
  clubCode: string;
  name: string;
  description: string;
  ownerId: number;
  ownerName?: string;
  settings: ClubSettings;
  memberCount: number;
  createdAt: string;
  myRole?: string;
  badge?: string;
  clubLevel?: number;
  clubXp?: number;
}

export interface ClubInvitation {
  id: number;
  clubId: number;
  clubName: string;
  inviterId: number;
  inviterName: string;
  invitedUsername: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

export interface ClubUnion {
  id: number;
  name: string;
  description: string;
  leaderClubId: number;
  createdAt: string;
}

export interface UnionMember {
  id: number;
  unionId: number;
  clubId: number;
  joinedAt: string;
  status: string;
}

export interface MemberProfile {
  username: string;
  role: string;
  joinedAt: string;
  handsPlayed: number;
  chipsWon: number;
  chipsLost: number;
  biggestPot: number;
  winRate: number;
}

// ========== Club Level Thresholds ==========

export const CLUB_LEVEL_THRESHOLDS = [
  0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5200,
  6500, 8000, 10000, 12500, 15500, 19000, 23000, 28000, 34000, 41000,
];

export const CLUB_LEVEL_PERKS: { level: number; perk: string }[] = [
  { level: 1, perk: 'Base club: 100 max members' },
  { level: 3, perk: 'Max members increased to 150' },
  { level: 5, perk: 'Max members increased to 200' },
  { level: 7, perk: 'Higher max stakes unlocked' },
  { level: 10, perk: 'Max members increased to 300' },
  { level: 13, perk: 'Custom badge slots unlocked' },
  { level: 15, perk: 'Max members increased to 500' },
  { level: 18, perk: 'Exclusive tournament hosting' },
  { level: 20, perk: 'Legendary club status' },
];

export interface ClubMessage {
  id: number;
  clubId: number;
  userId: number;
  username: string;
  message: string;
  type: 'chat' | 'announcement' | 'system';
  isPinned: number;
  createdAt: string;
}

export interface ClubStat {
  id: number;
  clubId: number;
  userId: number;
  username: string;
  handsPlayed: number;
  chipsWon: number;
  chipsLost: number;
  biggestPot: number;
  tournamentsWon: number;
  updatedAt: string;
}

export interface ClubActivityItem {
  id: number;
  clubId: number;
  type: 'member_join' | 'member_leave' | 'big_win' | 'tournament' | 'announcement';
  data: string;
  createdAt: string;
}

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
}

export interface BlindStructure {
  id: number;
  clubId: number;
  name: string;
  levels: BlindLevel[];
  createdBy: number;
}

export interface ClubTournament {
  id: number;
  clubId: number;
  name: string;
  format: 'freezeout' | 'rebuy' | 'bounty';
  blindStructure: { level: number; smallBlind: number; bigBlind: number; ante: number; duration: number }[];
  buyIn: number;
  startingChips: number;
  maxPlayers: number;
  status: 'scheduled' | 'registering' | 'running' | 'finished';
  scheduledAt: string;
  startedAt: string | null;
  createdBy: number;
  registeredCount?: number;
}

export interface ClubChallenge {
  id: number;
  clubId: number;
  challengerId: number;
  challengerName: string;
  challengedId: number;
  challengedName: string;
  stakes: number;
  status: 'pending' | 'accepted' | 'playing' | 'completed';
  winnerId: number | null;
  createdAt: string;
}

export interface ScheduledTable {
  id: number;
  clubId: number;
  tableConfig: string;
  scheduledTime: string;
  recurring: boolean;
  recurrencePattern: string | null;
  status: 'scheduled' | 'active' | 'completed';
  createdBy: number;
}

// ========== Database ==========

let db: Database.Database;

function getDB(): Database.Database {
  if (db) return db;
  const dbPath = path.join(__dirname, '..', '..', 'data', 'poker.db');
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export function initClubTables(): void {
  const d = getDB();

  d.exec(`
    CREATE TABLE IF NOT EXISTS clubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubCode TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      ownerId INTEGER NOT NULL,
      settings TEXT DEFAULT '{}',
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joinedAt TEXT DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(clubId, userId),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      tableName TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'texas-holdem',
      smallBlind INTEGER NOT NULL DEFAULT 5,
      bigBlind INTEGER NOT NULL DEFAULT 10,
      minBuyIn INTEGER NOT NULL DEFAULT 100,
      maxBuyIn INTEGER NOT NULL DEFAULT 1000,
      maxSeats INTEGER NOT NULL DEFAULT 9,
      isActive INTEGER NOT NULL DEFAULT 1,
      tableId TEXT DEFAULT NULL,
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'chat',
      isPinned INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      username TEXT NOT NULL,
      handsPlayed INTEGER NOT NULL DEFAULT 0,
      chipsWon INTEGER NOT NULL DEFAULT 0,
      chipsLost INTEGER NOT NULL DEFAULT 0,
      biggestPot INTEGER NOT NULL DEFAULT 0,
      tournamentsWon INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT DEFAULT (datetime('now')),
      UNIQUE(clubId, userId),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      name TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'freezeout',
      blindStructure TEXT NOT NULL DEFAULT '[]',
      buyIn INTEGER NOT NULL DEFAULT 100,
      startingChips INTEGER NOT NULL DEFAULT 5000,
      maxPlayers INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'scheduled',
      scheduledAt TEXT NOT NULL,
      startedAt TEXT DEFAULT NULL,
      createdBy INTEGER NOT NULL,
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_tournament_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournamentId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      registeredAt TEXT DEFAULT (datetime('now')),
      UNIQUE(tournamentId, userId),
      FOREIGN KEY (tournamentId) REFERENCES club_tournaments(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS club_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      challengerId INTEGER NOT NULL,
      challengerName TEXT NOT NULL,
      challengedId INTEGER NOT NULL,
      challengedName TEXT NOT NULL,
      stakes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      winnerId INTEGER DEFAULT NULL,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      tableConfig TEXT NOT NULL DEFAULT '{}',
      scheduledTime TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 0,
      recurrencePattern TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      createdBy INTEGER NOT NULL,
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS blind_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      name TEXT NOT NULL,
      levels TEXT NOT NULL DEFAULT '[]',
      createdBy INTEGER NOT NULL,
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  // ── Feature 10: Club Invitations ──
  d.exec(`
    CREATE TABLE IF NOT EXISTS club_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clubId INTEGER NOT NULL,
      clubName TEXT NOT NULL,
      inviterId INTEGER NOT NULL,
      inviterName TEXT NOT NULL,
      invitedUsername TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  // ── Feature 11: Club Unions ──
  d.exec(`
    CREATE TABLE IF NOT EXISTS club_unions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      leaderClubId INTEGER NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS union_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unionId INTEGER NOT NULL,
      clubId INTEGER NOT NULL,
      joinedAt TEXT DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(unionId, clubId),
      FOREIGN KEY (unionId) REFERENCES club_unions(id) ON DELETE CASCADE
    )
  `);

  // ── Feature 13: Club Badges - add badge column ──
  try {
    d.exec(`ALTER TABLE clubs ADD COLUMN badge TEXT DEFAULT '♠'`);
  } catch (_e) { /* column already exists */ }

  // ── Feature 14: Referral Codes - add referral_code column ──
  try {
    d.exec(`ALTER TABLE club_members ADD COLUMN referral_code TEXT DEFAULT NULL`);
  } catch (_e) { /* column already exists */ }

  // ── Feature 15: Club Levels - add clubXp and clubLevel columns ──
  try {
    d.exec(`ALTER TABLE clubs ADD COLUMN clubXp INTEGER DEFAULT 0`);
  } catch (_e) { /* column already exists */ }
  try {
    d.exec(`ALTER TABLE clubs ADD COLUMN clubLevel INTEGER DEFAULT 1`);
  } catch (_e) { /* column already exists */ }

  console.log('[Clubs] Database tables initialized (with social features)');
}

// ========== Helpers ==========

function generateClubCode(): string {
  const d = getDB();
  let code: string;
  let attempts = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = d.prepare('SELECT id FROM clubs WHERE clubCode = ?').get(code);
    if (!existing) return code;
    attempts++;
  } while (attempts < 100);
  throw new Error('Could not generate unique club code');
}

function getUsername(userId: number): string {
  const d = getDB();
  const user = d.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  return user?.username || 'Unknown';
}

function getMemberRole(clubId: number, userId: number): string | null {
  const d = getDB();
  const row = d.prepare('SELECT role FROM club_members WHERE clubId = ? AND userId = ? AND status = ?').get(clubId, userId, 'active') as { role: string } | undefined;
  return row?.role || null;
}

function getClubById(clubId: number): Club | null {
  const d = getDB();
  const row = d.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId) as any;
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings || '{}'),
  };
}

function getClubByCode(code: string): Club | null {
  const d = getDB();
  const row = d.prepare('SELECT * FROM clubs WHERE clubCode = ?').get(code) as any;
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings || '{}'),
  };
}

// ========== Club Operations ==========

export function createClub(
  ownerId: number,
  name: string,
  description: string,
  settings: Partial<ClubSettings>
): { success: boolean; error?: string; club?: ClubInfo } {
  if (!name || name.trim().length < 2) {
    return { success: false, error: 'Club name must be at least 2 characters' };
  }

  const d = getDB();
  const clubCode = generateClubCode();
  const fullSettings: ClubSettings = {
    rake: settings.rake ?? 0,
    maxMembers: settings.maxMembers ?? 100,
    isPrivate: settings.isPrivate ?? true,
    requireApproval: settings.requireApproval ?? false,
  };

  try {
    const result = d.prepare(
      'INSERT INTO clubs (clubCode, name, description, ownerId, settings) VALUES (?, ?, ?, ?, ?)'
    ).run(clubCode, name.trim(), description?.trim() || '', ownerId, JSON.stringify(fullSettings));

    const clubId = result.lastInsertRowid as number;

    // Add owner as member
    d.prepare(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES (?, ?, ?, ?)'
    ).run(clubId, ownerId, 'owner', 'active');

    return {
      success: true,
      club: {
        id: clubId,
        clubCode,
        name: name.trim(),
        description: description?.trim() || '',
        ownerId,
        ownerName: getUsername(ownerId),
        settings: fullSettings,
        memberCount: 1,
        createdAt: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Create error:', err);
    return { success: false, error: 'Failed to create club' };
  }
}

export function joinClub(
  userId: number,
  clubCode: string
): { success: boolean; error?: string; club?: ClubInfo; status?: string } {
  const club = getClubByCode(clubCode);
  if (!club) {
    return { success: false, error: 'Club not found. Check the code and try again.' };
  }

  const d = getDB();

  // Check if already a member
  const existing = d.prepare('SELECT * FROM club_members WHERE clubId = ? AND userId = ?').get(club.id, userId) as any;
  if (existing) {
    if (existing.status === 'active') {
      return { success: false, error: 'You are already a member of this club' };
    }
    if (existing.status === 'banned') {
      return { success: false, error: 'You have been banned from this club' };
    }
    if (existing.status === 'pending') {
      return { success: false, error: 'Your join request is already pending approval' };
    }
  }

  // Check member limit
  const settings = club.settings;
  const memberCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(club.id, 'active') as any).cnt;
  if (memberCount >= settings.maxMembers) {
    return { success: false, error: 'This club is full' };
  }

  const status = settings.requireApproval ? 'pending' : 'active';

  try {
    d.prepare(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES (?, ?, ?, ?)'
    ).run(club.id, userId, 'member', status);

    const newCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(club.id, 'active') as any).cnt;

    return {
      success: true,
      status,
      club: {
        id: club.id,
        clubCode: club.clubCode,
        name: club.name,
        description: club.description,
        ownerId: club.ownerId,
        ownerName: getUsername(club.ownerId),
        settings: club.settings,
        memberCount: newCount,
        createdAt: club.createdAt,
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Join error:', err);
    return { success: false, error: 'Failed to join club' };
  }
}

export function leaveClub(
  userId: number,
  clubId: number
): { success: boolean; error?: string } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  if (club.ownerId === userId) {
    return { success: false, error: 'Owners cannot leave their own club. Transfer ownership or delete the club.' };
  }

  const d = getDB();
  const result = d.prepare('DELETE FROM club_members WHERE clubId = ? AND userId = ?').run(clubId, userId);
  if (result.changes === 0) {
    return { success: false, error: 'You are not a member of this club' };
  }

  return { success: true };
}

export function getClubInfo(
  clubId: number,
  requesterId?: number
): { success: boolean; error?: string; club?: ClubInfo } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const memberCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(clubId, 'active') as any).cnt;

  let myRole: string | undefined;
  if (requesterId) {
    myRole = getMemberRole(clubId, requesterId) || undefined;
  }

  // Get badge and level from raw row
  const rawRow = d.prepare('SELECT badge, clubXp, clubLevel FROM clubs WHERE id = ?').get(clubId) as any;

  return {
    success: true,
    club: {
      id: club.id,
      clubCode: club.clubCode,
      name: club.name,
      description: club.description,
      ownerId: club.ownerId,
      ownerName: getUsername(club.ownerId),
      settings: club.settings,
      memberCount,
      createdAt: club.createdAt,
      myRole,
      badge: rawRow?.badge || '♠',
      clubLevel: rawRow?.clubLevel || 1,
      clubXp: rawRow?.clubXp || 0,
    },
  };
}

export function getClubMembers(
  clubId: number
): { success: boolean; error?: string; members?: ClubMember[] } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const rows = d.prepare(
    `SELECT cm.*, u.username FROM club_members cm
     LEFT JOIN users u ON cm.userId = u.id
     WHERE cm.clubId = ?
     ORDER BY
       CASE cm.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
       cm.joinedAt ASC`
  ).all(clubId) as any[];

  const members: ClubMember[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    userId: r.userId,
    username: r.username,
    role: r.role,
    joinedAt: r.joinedAt,
    status: r.status,
  }));

  return { success: true, members };
}

export function getMyClubs(
  userId: number
): { success: boolean; clubs: ClubInfo[] } {
  const d = getDB();
  const rows = d.prepare(
    `SELECT c.*, cm.role as myRole,
      (SELECT COUNT(*) FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount
     FROM clubs c
     JOIN club_members cm ON c.id = cm.clubId
     WHERE cm.userId = ? AND cm.status = 'active'
     ORDER BY cm.joinedAt DESC`
  ).all(userId) as any[];

  const clubs: ClubInfo[] = rows.map((r) => ({
    id: r.id,
    clubCode: r.clubCode,
    name: r.name,
    description: r.description,
    ownerId: r.ownerId,
    ownerName: getUsername(r.ownerId),
    settings: JSON.parse(r.settings || '{}'),
    memberCount: r.memberCount,
    createdAt: r.createdAt,
    myRole: r.myRole,
    badge: r.badge || '♠',
    clubLevel: r.clubLevel || 1,
    clubXp: r.clubXp || 0,
  }));

  return { success: true, clubs };
}

export function approveMember(
  managerId: number,
  clubId: number,
  userId: number
): { success: boolean; error?: string } {
  const managerRole = getMemberRole(clubId, managerId);
  if (!managerRole || (managerRole !== 'owner' && managerRole !== 'manager')) {
    return { success: false, error: 'Only owners and managers can approve members' };
  }

  const d = getDB();
  const result = d.prepare(
    'UPDATE club_members SET status = ? WHERE clubId = ? AND userId = ? AND status = ?'
  ).run('active', clubId, userId, 'pending');

  if (result.changes === 0) {
    return { success: false, error: 'No pending request found for this user' };
  }

  return { success: true };
}

export function removeMember(
  managerId: number,
  clubId: number,
  userId: number
): { success: boolean; error?: string } {
  const managerRole = getMemberRole(clubId, managerId);
  if (!managerRole || (managerRole !== 'owner' && managerRole !== 'manager')) {
    return { success: false, error: 'Only owners and managers can remove members' };
  }

  // Managers can't remove owners or other managers
  const targetRole = getMemberRole(clubId, userId);
  if (targetRole === 'owner') {
    return { success: false, error: 'Cannot remove the club owner' };
  }
  if (targetRole === 'manager' && managerRole !== 'owner') {
    return { success: false, error: 'Only the owner can remove managers' };
  }

  const d = getDB();
  d.prepare('UPDATE club_members SET status = ? WHERE clubId = ? AND userId = ?').run('banned', clubId, userId);
  return { success: true };
}

export function promoteToManager(
  ownerId: number,
  clubId: number,
  userId: number
): { success: boolean; error?: string } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can promote members' };
  }

  const d = getDB();
  const result = d.prepare(
    'UPDATE club_members SET role = ? WHERE clubId = ? AND userId = ? AND status = ?'
  ).run('manager', clubId, userId, 'active');

  if (result.changes === 0) {
    return { success: false, error: 'Member not found or not active' };
  }

  return { success: true };
}

export function createClubTable(
  managerId: number,
  clubId: number,
  config: {
    tableName: string;
    variant?: string;
    smallBlind?: number;
    bigBlind?: number;
    minBuyIn?: number;
    maxBuyIn?: number;
    maxSeats?: number;
  }
): { success: boolean; error?: string; table?: ClubTable } {
  const role = getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can create tables' };
  }

  if (!config.tableName || config.tableName.trim().length < 2) {
    return { success: false, error: 'Table name must be at least 2 characters' };
  }

  const d = getDB();
  const sb = config.smallBlind || 5;
  const bb = config.bigBlind || 10;
  const minBuy = config.minBuyIn || bb * 20;
  const maxBuy = config.maxBuyIn || bb * 100;
  const maxSeats = Math.min(9, Math.max(2, config.maxSeats || 9));
  const variant = config.variant || 'texas-holdem';

  try {
    const result = d.prepare(
      `INSERT INTO club_tables (clubId, tableName, variant, smallBlind, bigBlind, minBuyIn, maxBuyIn, maxSeats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(clubId, config.tableName.trim(), variant, sb, bb, minBuy, maxBuy, maxSeats);

    const tableRow: ClubTable = {
      id: result.lastInsertRowid as number,
      clubId,
      tableName: config.tableName.trim(),
      variant,
      smallBlind: sb,
      bigBlind: bb,
      minBuyIn: minBuy,
      maxBuyIn: maxBuy,
      maxSeats,
      isActive: true,
    };

    return { success: true, table: tableRow };
  } catch (err: any) {
    console.error('[Clubs] Create table error:', err);
    return { success: false, error: 'Failed to create table' };
  }
}

export function getClubTables(
  clubId: number
): { success: boolean; error?: string; tables?: ClubTable[] } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM club_tables WHERE clubId = ? AND isActive = 1'
  ).all(clubId) as any[];

  const tables: ClubTable[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    tableName: r.tableName,
    variant: r.variant,
    smallBlind: r.smallBlind,
    bigBlind: r.bigBlind,
    minBuyIn: r.minBuyIn,
    maxBuyIn: r.maxBuyIn,
    maxSeats: r.maxSeats,
    isActive: r.isActive === 1,
    tableId: r.tableId || undefined,
  }));

  return { success: true, tables };
}

export function updateClubTableId(clubTableId: number, runtimeTableId: string): void {
  const d = getDB();
  d.prepare('UPDATE club_tables SET tableId = ? WHERE id = ?').run(runtimeTableId, clubTableId);
}

export function removeClubTable(clubTableId: number): void {
  const d = getDB();
  d.prepare('UPDATE club_tables SET isActive = 0 WHERE id = ?').run(clubTableId);
}

export function updateClubSettings(
  ownerId: number,
  clubId: number,
  newSettings: Partial<ClubSettings> & { name?: string; description?: string }
): { success: boolean; error?: string; club?: ClubInfo } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can update settings' };
  }

  const d = getDB();
  const updatedSettings: ClubSettings = {
    rake: newSettings.rake ?? club.settings.rake,
    maxMembers: newSettings.maxMembers ?? club.settings.maxMembers,
    isPrivate: newSettings.isPrivate ?? club.settings.isPrivate,
    requireApproval: newSettings.requireApproval ?? club.settings.requireApproval,
  };

  const updatedName = newSettings.name?.trim() || club.name;
  const updatedDesc = newSettings.description !== undefined ? newSettings.description.trim() : club.description;

  d.prepare(
    'UPDATE clubs SET name = ?, description = ?, settings = ? WHERE id = ?'
  ).run(updatedName, updatedDesc, JSON.stringify(updatedSettings), clubId);

  const memberCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(clubId, 'active') as any).cnt;

  return {
    success: true,
    club: {
      id: clubId,
      clubCode: club.clubCode,
      name: updatedName,
      description: updatedDesc,
      ownerId,
      ownerName: getUsername(ownerId),
      settings: updatedSettings,
      memberCount,
      createdAt: club.createdAt,
    },
  };
}

export function deleteClub(
  ownerId: number,
  clubId: number
): { success: boolean; error?: string } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can delete the club' };
  }

  const d = getDB();
  d.prepare('DELETE FROM club_members WHERE clubId = ?').run(clubId);
  d.prepare('DELETE FROM club_tables WHERE clubId = ?').run(clubId);
  d.prepare('DELETE FROM clubs WHERE id = ?').run(clubId);

  return { success: true };
}

export function searchClubs(
  query: string
): { success: boolean; clubs: ClubInfo[] } {
  const d = getDB();
  const rows = d.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount
     FROM clubs c
     WHERE c.name LIKE ? AND json_extract(c.settings, '$.isPrivate') = 0
     ORDER BY memberCount DESC
     LIMIT 20`
  ).all(`%${query}%`) as any[];

  const clubs: ClubInfo[] = rows.map((r) => ({
    id: r.id,
    clubCode: r.clubCode,
    name: r.name,
    description: r.description,
    ownerId: r.ownerId,
    ownerName: getUsername(r.ownerId),
    settings: JSON.parse(r.settings || '{}'),
    memberCount: r.memberCount,
    createdAt: r.createdAt,
  }));

  return { success: true, clubs };
}

export function isClubMember(clubId: number, userId: number): boolean {
  const role = getMemberRole(clubId, userId);
  return role !== null;
}

export function getClubTableById(clubTableId: number): ClubTable | null {
  const d = getDB();
  const row = d.prepare('SELECT * FROM club_tables WHERE id = ?').get(clubTableId) as any;
  if (!row) return null;
  return {
    id: row.id,
    clubId: row.clubId,
    tableName: row.tableName,
    variant: row.variant,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    minBuyIn: row.minBuyIn,
    maxBuyIn: row.maxBuyIn,
    maxSeats: row.maxSeats,
    isActive: row.isActive === 1,
    tableId: row.tableId || undefined,
  };
}

// ========== Club Messages ==========

export function sendClubMessage(
  clubId: number,
  userId: number,
  username: string,
  message: string,
  type: 'chat' | 'announcement' | 'system' = 'chat'
): { success: boolean; error?: string; message?: ClubMessage } {
  if (!message || message.trim().length === 0) {
    return { success: false, error: 'Message cannot be empty' };
  }

  const d = getDB();
  try {
    const isPinned = type === 'announcement' ? 1 : 0;
    const result = d.prepare(
      'INSERT INTO club_messages (clubId, userId, username, message, type, isPinned) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(clubId, userId, username, message.trim(), type, isPinned);

    const msg: ClubMessage = {
      id: result.lastInsertRowid as number,
      clubId,
      userId,
      username,
      message: message.trim(),
      type,
      isPinned,
      createdAt: new Date().toISOString(),
    };

    return { success: true, message: msg };
  } catch (err: any) {
    console.error('[Clubs] Send message error:', err);
    return { success: false, error: 'Failed to send message' };
  }
}

export function getClubMessages(
  clubId: number,
  limit: number = 50
): { success: boolean; messages: ClubMessage[] } {
  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM club_messages WHERE clubId = ? ORDER BY createdAt DESC LIMIT ?'
  ).all(clubId, limit) as any[];

  const messages: ClubMessage[] = rows.reverse().map((r) => ({
    id: r.id,
    clubId: r.clubId,
    userId: r.userId,
    username: r.username,
    message: r.message,
    type: r.type,
    isPinned: r.isPinned,
    createdAt: r.createdAt,
  }));

  return { success: true, messages };
}

export function pinMessage(
  clubId: number,
  messageId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const result = d.prepare(
    'UPDATE club_messages SET isPinned = 1 WHERE id = ? AND clubId = ?'
  ).run(messageId, clubId);
  if (result.changes === 0) {
    return { success: false, error: 'Message not found' };
  }
  return { success: true };
}

export function unpinMessage(
  clubId: number,
  messageId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const result = d.prepare(
    'UPDATE club_messages SET isPinned = 0 WHERE id = ? AND clubId = ?'
  ).run(messageId, clubId);
  if (result.changes === 0) {
    return { success: false, error: 'Message not found' };
  }
  return { success: true };
}

export function getAnnouncements(
  clubId: number
): { success: boolean; announcements: ClubMessage[] } {
  const d = getDB();
  const rows = d.prepare(
    "SELECT * FROM club_messages WHERE clubId = ? AND (type = 'announcement' OR isPinned = 1) ORDER BY createdAt DESC LIMIT 10"
  ).all(clubId) as any[];

  const announcements: ClubMessage[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    userId: r.userId,
    username: r.username,
    message: r.message,
    type: r.type,
    isPinned: r.isPinned,
    createdAt: r.createdAt,
  }));

  return { success: true, announcements };
}

// ========== Club Stats / Leaderboard ==========

export function updateClubStats(
  clubId: number,
  userId: number,
  data: { handsPlayed?: number; chipsWon?: number; chipsLost?: number; biggestPot?: number; tournamentsWon?: number }
): { success: boolean } {
  const d = getDB();
  const username = getUsername(userId);

  const existing = d.prepare('SELECT * FROM club_stats WHERE clubId = ? AND userId = ?').get(clubId, userId) as any;

  if (!existing) {
    d.prepare(
      'INSERT INTO club_stats (clubId, userId, username, handsPlayed, chipsWon, chipsLost, biggestPot, tournamentsWon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(clubId, userId, username, data.handsPlayed || 0, data.chipsWon || 0, data.chipsLost || 0, data.biggestPot || 0, data.tournamentsWon || 0);
  } else {
    const hp = (existing.handsPlayed || 0) + (data.handsPlayed || 0);
    const cw = (existing.chipsWon || 0) + (data.chipsWon || 0);
    const cl = (existing.chipsLost || 0) + (data.chipsLost || 0);
    const bp = Math.max(existing.biggestPot || 0, data.biggestPot || 0);
    const tw = (existing.tournamentsWon || 0) + (data.tournamentsWon || 0);

    d.prepare(
      "UPDATE club_stats SET handsPlayed = ?, chipsWon = ?, chipsLost = ?, biggestPot = ?, tournamentsWon = ?, username = ?, updatedAt = datetime('now') WHERE clubId = ? AND userId = ?"
    ).run(hp, cw, cl, bp, tw, username, clubId, userId);
  }

  return { success: true };
}

export function getClubLeaderboard(
  clubId: number,
  period: 'today' | 'week' | 'alltime' = 'alltime'
): { success: boolean; leaderboard: ClubStat[] } {
  const d = getDB();

  // For simplicity, alltime uses club_stats directly.
  // period filtering would require per-hand timestamped data; approximate with updatedAt
  let dateFilter = '';
  if (period === 'today') {
    dateFilter = "AND updatedAt >= datetime('now', '-1 day')";
  } else if (period === 'week') {
    dateFilter = "AND updatedAt >= datetime('now', '-7 days')";
  }

  const rows = d.prepare(
    `SELECT * FROM club_stats WHERE clubId = ? ${dateFilter} ORDER BY chipsWon DESC LIMIT 50`
  ).all(clubId) as any[];

  const leaderboard: ClubStat[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    userId: r.userId,
    username: r.username,
    handsPlayed: r.handsPlayed,
    chipsWon: r.chipsWon,
    chipsLost: r.chipsLost,
    biggestPot: r.biggestPot,
    tournamentsWon: r.tournamentsWon,
    updatedAt: r.updatedAt,
  }));

  return { success: true, leaderboard };
}

export function getClubStatistics(
  clubId: number
): { success: boolean; statistics: { totalMembers: number; totalHandsPlayed: number; biggestPotEver: number; mostActivePlayer: string; clubAge: string } } {
  const d = getDB();

  const totalMembers = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(clubId, 'active') as any).cnt;

  const statsAgg = d.prepare(
    'SELECT COALESCE(SUM(handsPlayed), 0) as totalHands, COALESCE(MAX(biggestPot), 0) as bigPot FROM club_stats WHERE clubId = ?'
  ).get(clubId) as any;

  const mostActive = d.prepare(
    'SELECT username FROM club_stats WHERE clubId = ? ORDER BY handsPlayed DESC LIMIT 1'
  ).get(clubId) as any;

  const club = d.prepare('SELECT createdAt FROM clubs WHERE id = ?').get(clubId) as any;
  const clubCreated = club?.createdAt || '';
  let clubAge = 'Unknown';
  if (clubCreated) {
    const diff = Date.now() - new Date(clubCreated).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    clubAge = days <= 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`;
  }

  return {
    success: true,
    statistics: {
      totalMembers,
      totalHandsPlayed: statsAgg.totalHands,
      biggestPotEver: statsAgg.bigPot,
      mostActivePlayer: mostActive?.username || 'N/A',
      clubAge,
    },
  };
}

// ========== Club Activity Feed ==========

export function addActivity(
  clubId: number,
  type: 'member_join' | 'member_leave' | 'big_win' | 'tournament' | 'announcement',
  data: Record<string, any>
): { success: boolean } {
  const d = getDB();
  try {
    d.prepare(
      'INSERT INTO club_activity (clubId, type, data) VALUES (?, ?, ?)'
    ).run(clubId, type, JSON.stringify(data));
    return { success: true };
  } catch (err: any) {
    console.error('[Clubs] Add activity error:', err);
    return { success: false };
  }
}

export function getActivityFeed(
  clubId: number,
  limit: number = 20
): { success: boolean; activities: ClubActivityItem[] } {
  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM club_activity WHERE clubId = ? ORDER BY createdAt DESC LIMIT ?'
  ).all(clubId, limit) as any[];

  const activities: ClubActivityItem[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    type: r.type,
    data: r.data,
    createdAt: r.createdAt,
  }));

  return { success: true, activities };
}

// ========== Club Tournaments ==========

export function createClubTournament(
  clubId: number,
  managerId: number,
  config: {
    name: string;
    format?: 'freezeout' | 'rebuy' | 'bounty';
    blindStructure?: { level: number; smallBlind: number; bigBlind: number; ante: number; duration: number }[];
    buyIn?: number;
    startingChips?: number;
    maxPlayers?: number;
    scheduledAt: string;
  }
): { success: boolean; error?: string; tournament?: ClubTournament } {
  const role = getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can create tournaments' };
  }
  if (!config.name || config.name.trim().length < 2) {
    return { success: false, error: 'Tournament name must be at least 2 characters' };
  }

  const d = getDB();
  const format = config.format || 'freezeout';
  const blindStructure = config.blindStructure || [
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, duration: 15 },
    { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, duration: 15 },
    { level: 3, smallBlind: 100, bigBlind: 200, ante: 25, duration: 15 },
  ];
  const buyIn = config.buyIn || 100;
  const startingChips = config.startingChips || 5000;
  const maxPlayers = Math.min(200, Math.max(2, config.maxPlayers || 20));

  try {
    const result = d.prepare(
      `INSERT INTO club_tournaments (clubId, name, format, blindStructure, buyIn, startingChips, maxPlayers, status, scheduledAt, createdBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'registering', ?, ?)`
    ).run(clubId, config.name.trim(), format, JSON.stringify(blindStructure), buyIn, startingChips, maxPlayers, config.scheduledAt, managerId);

    const tournament: ClubTournament = {
      id: result.lastInsertRowid as number,
      clubId,
      name: config.name.trim(),
      format,
      blindStructure,
      buyIn,
      startingChips,
      maxPlayers,
      status: 'registering',
      scheduledAt: config.scheduledAt,
      startedAt: null,
      createdBy: managerId,
      registeredCount: 0,
    };

    return { success: true, tournament };
  } catch (err: any) {
    console.error('[Clubs] Create tournament error:', err);
    return { success: false, error: 'Failed to create tournament' };
  }
}

export function getClubTournaments(
  clubId: number
): { success: boolean; error?: string; tournaments?: ClubTournament[] } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const rows = d.prepare(
    `SELECT ct.*,
      (SELECT COUNT(*) FROM club_tournament_registrations WHERE tournamentId = ct.id) as registeredCount
     FROM club_tournaments ct
     WHERE ct.clubId = ?
     ORDER BY ct.scheduledAt DESC`
  ).all(clubId) as any[];

  const tournaments: ClubTournament[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    name: r.name,
    format: r.format,
    blindStructure: JSON.parse(r.blindStructure || '[]'),
    buyIn: r.buyIn,
    startingChips: r.startingChips,
    maxPlayers: r.maxPlayers,
    status: r.status,
    scheduledAt: r.scheduledAt,
    startedAt: r.startedAt,
    createdBy: r.createdBy,
    registeredCount: r.registeredCount || 0,
  }));

  return { success: true, tournaments };
}

export function registerForClubTournament(
  tournamentId: number,
  userId: number
): { success: boolean; error?: string; registered?: boolean } {
  const d = getDB();
  const tourney = d.prepare('SELECT * FROM club_tournaments WHERE id = ?').get(tournamentId) as any;
  if (!tourney) return { success: false, error: 'Tournament not found' };
  if (tourney.status !== 'registering') return { success: false, error: 'Tournament is not accepting registrations' };

  if (!isClubMember(tourney.clubId, userId)) {
    return { success: false, error: 'You must be a club member to register' };
  }

  const regCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_tournament_registrations WHERE tournamentId = ?').get(tournamentId) as any).cnt;
  if (regCount >= tourney.maxPlayers) {
    return { success: false, error: 'Tournament is full' };
  }

  const existing = d.prepare('SELECT id FROM club_tournament_registrations WHERE tournamentId = ? AND userId = ?').get(tournamentId, userId);
  if (existing) {
    // Unregister
    d.prepare('DELETE FROM club_tournament_registrations WHERE tournamentId = ? AND userId = ?').run(tournamentId, userId);
    return { success: true, registered: false };
  }

  d.prepare('INSERT INTO club_tournament_registrations (tournamentId, userId) VALUES (?, ?)').run(tournamentId, userId);
  return { success: true, registered: true };
}

export function startClubTournament(
  tournamentId: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const tourney = d.prepare('SELECT * FROM club_tournaments WHERE id = ?').get(tournamentId) as any;
  if (!tourney) return { success: false, error: 'Tournament not found' };

  const role = getMemberRole(tourney.clubId, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can start tournaments' };
  }
  if (tourney.status !== 'registering') {
    return { success: false, error: 'Tournament cannot be started in current state' };
  }

  d.prepare('UPDATE club_tournaments SET status = ?, startedAt = datetime(\'now\') WHERE id = ?').run('running', tournamentId);
  return { success: true };
}

// ========== Club Challenges ==========

export function createChallenge(
  clubId: number,
  challengerId: number,
  challengedId: number,
  stakes: number
): { success: boolean; error?: string; challenge?: ClubChallenge } {
  if (!isClubMember(clubId, challengerId)) {
    return { success: false, error: 'You must be a club member' };
  }
  if (!isClubMember(clubId, challengedId)) {
    return { success: false, error: 'Challenged player is not a club member' };
  }
  if (challengerId === challengedId) {
    return { success: false, error: 'You cannot challenge yourself' };
  }

  const d = getDB();
  const challengerName = getUsername(challengerId);
  const challengedName = getUsername(challengedId);

  try {
    const result = d.prepare(
      `INSERT INTO club_challenges (clubId, challengerId, challengerName, challengedId, challengedName, stakes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).run(clubId, challengerId, challengerName, challengedId, challengedName, stakes || 0);

    const challenge: ClubChallenge = {
      id: result.lastInsertRowid as number,
      clubId,
      challengerId,
      challengerName,
      challengedId,
      challengedName,
      stakes: stakes || 0,
      status: 'pending',
      winnerId: null,
      createdAt: new Date().toISOString(),
    };

    return { success: true, challenge };
  } catch (err: any) {
    console.error('[Clubs] Create challenge error:', err);
    return { success: false, error: 'Failed to create challenge' };
  }
}

export function acceptChallenge(
  challengeId: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const ch = d.prepare('SELECT * FROM club_challenges WHERE id = ?').get(challengeId) as any;
  if (!ch) return { success: false, error: 'Challenge not found' };
  if (ch.challengedId !== userId) return { success: false, error: 'Only the challenged player can accept' };
  if (ch.status !== 'pending') return { success: false, error: 'Challenge is not pending' };

  d.prepare('UPDATE club_challenges SET status = ? WHERE id = ?').run('accepted', challengeId);
  return { success: true };
}

export function declineChallenge(
  challengeId: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const ch = d.prepare('SELECT * FROM club_challenges WHERE id = ?').get(challengeId) as any;
  if (!ch) return { success: false, error: 'Challenge not found' };
  if (ch.challengedId !== userId && ch.challengerId !== userId) {
    return { success: false, error: 'Only participants can decline/cancel a challenge' };
  }
  if (ch.status !== 'pending') return { success: false, error: 'Challenge is not pending' };

  d.prepare('DELETE FROM club_challenges WHERE id = ?').run(challengeId);
  return { success: true };
}

export function getClubChallenges(
  clubId: number
): { success: boolean; error?: string; challenges?: ClubChallenge[] } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM club_challenges WHERE clubId = ? ORDER BY createdAt DESC LIMIT 50'
  ).all(clubId) as any[];

  const challenges: ClubChallenge[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    challengerId: r.challengerId,
    challengerName: r.challengerName,
    challengedId: r.challengedId,
    challengedName: r.challengedName,
    stakes: r.stakes,
    status: r.status,
    winnerId: r.winnerId,
    createdAt: r.createdAt,
  }));

  return { success: true, challenges };
}

// ========== Table Scheduling ==========

export function scheduleTable(
  clubId: number,
  managerId: number,
  config: any,
  time: string,
  recurring: boolean,
  recurrencePattern?: string
): { success: boolean; error?: string; scheduledTable?: ScheduledTable } {
  const role = getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can schedule tables' };
  }

  const d = getDB();
  try {
    const result = d.prepare(
      `INSERT INTO scheduled_tables (clubId, tableConfig, scheduledTime, recurring, recurrencePattern, status, createdBy)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`
    ).run(clubId, JSON.stringify(config), time, recurring ? 1 : 0, recurrencePattern || null, managerId);

    const st: ScheduledTable = {
      id: result.lastInsertRowid as number,
      clubId,
      tableConfig: JSON.stringify(config),
      scheduledTime: time,
      recurring,
      recurrencePattern: recurrencePattern || null,
      status: 'scheduled',
      createdBy: managerId,
    };

    return { success: true, scheduledTable: st };
  } catch (err: any) {
    console.error('[Clubs] Schedule table error:', err);
    return { success: false, error: 'Failed to schedule table' };
  }
}

export function getScheduledTables(
  clubId: number
): { success: boolean; error?: string; scheduledTables?: ScheduledTable[] } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM scheduled_tables WHERE clubId = ? AND status != ? ORDER BY scheduledTime ASC'
  ).all(clubId, 'completed') as any[];

  const scheduledTables: ScheduledTable[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    tableConfig: r.tableConfig,
    scheduledTime: r.scheduledTime,
    recurring: r.recurring === 1,
    recurrencePattern: r.recurrencePattern,
    status: r.status,
    createdBy: r.createdBy,
  }));

  return { success: true, scheduledTables };
}

export function activateScheduledTable(
  id: number,
  userId: number
): { success: boolean; error?: string; tableConfig?: any } {
  const d = getDB();
  const row = d.prepare('SELECT * FROM scheduled_tables WHERE id = ?').get(id) as any;
  if (!row) return { success: false, error: 'Scheduled table not found' };

  const role = getMemberRole(row.clubId, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can activate scheduled tables' };
  }

  d.prepare('UPDATE scheduled_tables SET status = ? WHERE id = ?').run('active', id);

  return { success: true, tableConfig: JSON.parse(row.tableConfig || '{}') };
}

export function deleteScheduledTable(
  id: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const row = d.prepare('SELECT * FROM scheduled_tables WHERE id = ?').get(id) as any;
  if (!row) return { success: false, error: 'Scheduled table not found' };

  const role = getMemberRole(row.clubId, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can delete scheduled tables' };
  }

  d.prepare('DELETE FROM scheduled_tables WHERE id = ?').run(id);
  return { success: true };
}

// ========== Custom Blind Structures ==========

export function createBlindStructure(
  clubId: number,
  managerId: number,
  name: string,
  levels: BlindLevel[]
): { success: boolean; error?: string; structure?: BlindStructure } {
  const role = getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can create blind structures' };
  }
  if (!name || name.trim().length < 2) {
    return { success: false, error: 'Name must be at least 2 characters' };
  }
  if (!levels || levels.length === 0) {
    return { success: false, error: 'At least one blind level is required' };
  }

  const d = getDB();
  try {
    const result = d.prepare(
      'INSERT INTO blind_structures (clubId, name, levels, createdBy) VALUES (?, ?, ?, ?)'
    ).run(clubId, name.trim(), JSON.stringify(levels), managerId);

    const structure: BlindStructure = {
      id: result.lastInsertRowid as number,
      clubId,
      name: name.trim(),
      levels,
      createdBy: managerId,
    };

    return { success: true, structure };
  } catch (err: any) {
    console.error('[Clubs] Create blind structure error:', err);
    return { success: false, error: 'Failed to create blind structure' };
  }
}

export function getBlindStructures(
  clubId: number
): { success: boolean; error?: string; structures?: BlindStructure[] } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM blind_structures WHERE clubId = ? ORDER BY id DESC'
  ).all(clubId) as any[];

  const structures: BlindStructure[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    name: r.name,
    levels: JSON.parse(r.levels || '[]'),
    createdBy: r.createdBy,
  }));

  return { success: true, structures };
}

export function deleteBlindStructure(
  id: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const row = d.prepare('SELECT * FROM blind_structures WHERE id = ?').get(id) as any;
  if (!row) return { success: false, error: 'Blind structure not found' };

  const role = getMemberRole(row.clubId, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can delete blind structures' };
  }

  d.prepare('DELETE FROM blind_structures WHERE id = ?').run(id);
  return { success: true };
}

// ═══════════════════════════════════════════
// Feature 10: Club Invitations
// ═══════════════════════════════════════════

function getUserIdByUsername(username: string): number | null {
  const d = getDB();
  const row = d.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  return row?.id || null;
}

export function inviteToClub(
  clubId: number,
  inviterId: number,
  inviterName: string,
  invitedUsername: string
): { success: boolean; error?: string; invitation?: ClubInvitation } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const role = getMemberRole(clubId, inviterId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can invite players' };
  }

  const invitedUserId = getUserIdByUsername(invitedUsername);
  if (!invitedUserId) {
    return { success: false, error: 'User not found' };
  }

  if (isClubMember(clubId, invitedUserId)) {
    return { success: false, error: 'User is already a member of this club' };
  }

  const d = getDB();
  const existing = d.prepare(
    'SELECT id FROM club_invitations WHERE clubId = ? AND invitedUsername = ? AND status = ?'
  ).get(clubId, invitedUsername, 'pending') as any;
  if (existing) {
    return { success: false, error: 'An invitation is already pending for this user' };
  }

  try {
    const result = d.prepare(
      'INSERT INTO club_invitations (clubId, clubName, inviterId, inviterName, invitedUsername, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(clubId, club.name, inviterId, inviterName, invitedUsername, 'pending');

    return {
      success: true,
      invitation: {
        id: result.lastInsertRowid as number,
        clubId,
        clubName: club.name,
        inviterId,
        inviterName,
        invitedUsername,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Invite error:', err);
    return { success: false, error: 'Failed to send invitation' };
  }
}

export function getMyInvitations(
  userId: number
): { success: boolean; invitations: ClubInvitation[] } {
  const d = getDB();
  const username = getUsername(userId);
  const rows = d.prepare(
    'SELECT * FROM club_invitations WHERE invitedUsername = ? AND status = ? ORDER BY createdAt DESC'
  ).all(username, 'pending') as any[];

  const invitations: ClubInvitation[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    clubName: r.clubName,
    inviterId: r.inviterId,
    inviterName: r.inviterName,
    invitedUsername: r.invitedUsername,
    status: r.status,
    createdAt: r.createdAt,
  }));

  return { success: true, invitations };
}

export function acceptInvitation(
  invitationId: number,
  userId: number
): { success: boolean; error?: string; club?: ClubInfo } {
  const d = getDB();
  const username = getUsername(userId);
  const inv = d.prepare('SELECT * FROM club_invitations WHERE id = ? AND invitedUsername = ? AND status = ?').get(invitationId, username, 'pending') as any;
  if (!inv) return { success: false, error: 'Invitation not found or already handled' };

  const club = getClubById(inv.clubId);
  if (!club) return { success: false, error: 'Club no longer exists' };

  if (isClubMember(inv.clubId, userId)) {
    d.prepare('UPDATE club_invitations SET status = ? WHERE id = ?').run('accepted', invitationId);
    return { success: false, error: 'You are already a member of this club' };
  }

  try {
    d.prepare(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES (?, ?, ?, ?)'
    ).run(inv.clubId, userId, 'member', 'active');
    d.prepare('UPDATE club_invitations SET status = ? WHERE id = ?').run('accepted', invitationId);

    const memberCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(inv.clubId, 'active') as any).cnt;
    const rawRow = d.prepare('SELECT badge, clubXp, clubLevel FROM clubs WHERE id = ?').get(inv.clubId) as any;

    return {
      success: true,
      club: {
        id: club.id,
        clubCode: club.clubCode,
        name: club.name,
        description: club.description,
        ownerId: club.ownerId,
        ownerName: getUsername(club.ownerId),
        settings: club.settings,
        memberCount,
        createdAt: club.createdAt,
        badge: rawRow?.badge || '♠',
        clubLevel: rawRow?.clubLevel || 1,
        clubXp: rawRow?.clubXp || 0,
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Accept invitation error:', err);
    return { success: false, error: 'Failed to accept invitation' };
  }
}

export function declineInvitation(
  invitationId: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const username = getUsername(userId);
  const result = d.prepare('UPDATE club_invitations SET status = ? WHERE id = ? AND invitedUsername = ? AND status = ?').run('declined', invitationId, username, 'pending');
  if (result.changes === 0) {
    return { success: false, error: 'Invitation not found or already handled' };
  }
  return { success: true };
}

export function getClubInvitations(
  clubId: number
): { success: boolean; invitations: ClubInvitation[] } {
  const d = getDB();
  const rows = d.prepare(
    'SELECT * FROM club_invitations WHERE clubId = ? ORDER BY createdAt DESC LIMIT 50'
  ).all(clubId) as any[];

  const invitations: ClubInvitation[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    clubName: r.clubName,
    inviterId: r.inviterId,
    inviterName: r.inviterName,
    invitedUsername: r.invitedUsername,
    status: r.status,
    createdAt: r.createdAt,
  }));

  return { success: true, invitations };
}

// ═══════════════════════════════════════════
// Feature 11: Club Unions (Alliance System)
// ═══════════════════════════════════════════

export function createUnion(
  clubId: number,
  userId: number,
  name: string,
  description: string
): { success: boolean; error?: string; union?: ClubUnion } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== userId) {
    return { success: false, error: 'Only the club owner can create a union' };
  }
  if (!name || name.trim().length < 2) {
    return { success: false, error: 'Union name must be at least 2 characters' };
  }

  const d = getDB();
  const existing = d.prepare(
    'SELECT um.id FROM union_members um WHERE um.clubId = ? AND um.status = ?'
  ).get(clubId, 'active') as any;
  if (existing) {
    return { success: false, error: 'Your club is already in a union' };
  }

  try {
    const result = d.prepare(
      'INSERT INTO club_unions (name, description, leaderClubId) VALUES (?, ?, ?)'
    ).run(name.trim(), description?.trim() || '', clubId);

    const unionId = result.lastInsertRowid as number;
    d.prepare(
      'INSERT INTO union_members (unionId, clubId, status) VALUES (?, ?, ?)'
    ).run(unionId, clubId, 'active');

    return {
      success: true,
      union: {
        id: unionId,
        name: name.trim(),
        description: description?.trim() || '',
        leaderClubId: clubId,
        createdAt: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Create union error:', err);
    return { success: false, error: 'Failed to create union' };
  }
}

export function inviteToUnion(
  unionId: number,
  inviterClubId: number,
  targetClubId: number,
  userId: number
): { success: boolean; error?: string } {
  const d = getDB();
  const union = d.prepare('SELECT * FROM club_unions WHERE id = ?').get(unionId) as any;
  if (!union) return { success: false, error: 'Union not found' };
  if (union.leaderClubId !== inviterClubId) {
    return { success: false, error: 'Only the leader club can invite others' };
  }
  const club = getClubById(inviterClubId);
  if (!club || club.ownerId !== userId) {
    return { success: false, error: 'Only the club owner can invite to the union' };
  }

  const existing = d.prepare(
    'SELECT id FROM union_members WHERE unionId = ? AND clubId = ?'
  ).get(unionId, targetClubId) as any;
  if (existing) {
    return { success: false, error: 'Club is already in or invited to this union' };
  }

  d.prepare('INSERT INTO union_members (unionId, clubId, status) VALUES (?, ?, ?)').run(unionId, targetClubId, 'pending');
  return { success: true };
}

export function joinUnion(
  unionId: number,
  clubId: number,
  userId: number
): { success: boolean; error?: string } {
  const club = getClubById(clubId);
  if (!club || club.ownerId !== userId) {
    return { success: false, error: 'Only the club owner can join a union' };
  }

  const d = getDB();
  const invite = d.prepare(
    'SELECT id FROM union_members WHERE unionId = ? AND clubId = ? AND status = ?'
  ).get(unionId, clubId, 'pending') as any;
  if (!invite) {
    return { success: false, error: 'No pending union invitation found' };
  }

  d.prepare('UPDATE union_members SET status = ? WHERE unionId = ? AND clubId = ?').run('active', unionId, clubId);
  return { success: true };
}

export function getUnionInfo(
  clubId: number
): { success: boolean; union?: ClubUnion & { clubs: { clubId: number; clubName: string; memberCount: number; badge: string }[] } } {
  const d = getDB();
  const membership = d.prepare(
    'SELECT unionId FROM union_members WHERE clubId = ? AND status = ?'
  ).get(clubId, 'active') as any;
  if (!membership) {
    return { success: true };
  }

  const union = d.prepare('SELECT * FROM club_unions WHERE id = ?').get(membership.unionId) as any;
  if (!union) return { success: true };

  const members = d.prepare(
    `SELECT um.clubId, c.name as clubName, c.badge,
      (SELECT COUNT(*) FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount
     FROM union_members um
     JOIN clubs c ON um.clubId = c.id
     WHERE um.unionId = ? AND um.status = ?
     ORDER BY um.joinedAt ASC`
  ).all(union.id, 'active') as any[];

  return {
    success: true,
    union: {
      id: union.id,
      name: union.name,
      description: union.description,
      leaderClubId: union.leaderClubId,
      createdAt: union.createdAt,
      clubs: members.map((m: any) => ({
        clubId: m.clubId,
        clubName: m.clubName,
        memberCount: m.memberCount,
        badge: m.badge || '♠',
      })),
    },
  };
}

// ═══════════════════════════════════════════
// Feature 12: Member Profiles
// ═══════════════════════════════════════════

export function getMemberProfile(
  clubId: number,
  targetUserId: number
): { success: boolean; error?: string; profile?: MemberProfile } {
  const d = getDB();
  const member = d.prepare(
    'SELECT cm.role, cm.joinedAt, u.username FROM club_members cm LEFT JOIN users u ON cm.userId = u.id WHERE cm.clubId = ? AND cm.userId = ? AND cm.status = ?'
  ).get(clubId, targetUserId, 'active') as any;
  if (!member) return { success: false, error: 'Member not found' };

  const stats = d.prepare(
    'SELECT handsPlayed, chipsWon, chipsLost, biggestPot FROM club_stats WHERE clubId = ? AND userId = ?'
  ).get(clubId, targetUserId) as any;

  const handsPlayed = stats?.handsPlayed || 0;
  const chipsWon = stats?.chipsWon || 0;
  const chipsLost = stats?.chipsLost || 0;
  const winRate = handsPlayed > 0 ? Math.round((chipsWon / (chipsWon + chipsLost || 1)) * 100) : 0;

  return {
    success: true,
    profile: {
      username: member.username || 'Unknown',
      role: member.role,
      joinedAt: member.joinedAt,
      handsPlayed,
      chipsWon,
      chipsLost,
      biggestPot: stats?.biggestPot || 0,
      winRate,
    },
  };
}

// ═══════════════════════════════════════════
// Feature 13: Club Badges/Logos
// ═══════════════════════════════════════════

export function updateClubBadge(
  clubId: number,
  ownerId: number,
  badge: string
): { success: boolean; error?: string } {
  const club = getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can change the badge' };
  }

  const d = getDB();
  d.prepare('UPDATE clubs SET badge = ? WHERE id = ?').run(badge, clubId);
  return { success: true };
}

// ═══════════════════════════════════════════
// Feature 14: Referral Rewards
// ═══════════════════════════════════════════

export function generateReferralCode(
  clubId: number,
  userId: number
): { success: boolean; error?: string; referralCode?: string } {
  if (!isClubMember(clubId, userId)) {
    return { success: false, error: 'You are not a member of this club' };
  }

  const d = getDB();
  const existing = d.prepare(
    'SELECT referral_code FROM club_members WHERE clubId = ? AND userId = ?'
  ).get(clubId, userId) as any;

  if (existing?.referral_code) {
    return { success: true, referralCode: existing.referral_code };
  }

  const code = `REF-${clubId}-${userId}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  d.prepare('UPDATE club_members SET referral_code = ? WHERE clubId = ? AND userId = ?').run(code, clubId, userId);

  return { success: true, referralCode: code };
}

export function joinByReferral(
  referralCode: string,
  userId: number
): { success: boolean; error?: string; club?: ClubInfo; bonusChips?: number } {
  const d = getDB();
  const referrer = d.prepare(
    'SELECT cm.clubId, cm.userId as referrerId FROM club_members cm WHERE cm.referral_code = ?'
  ).get(referralCode) as any;

  if (!referrer) {
    return { success: false, error: 'Invalid referral code' };
  }

  const club = getClubById(referrer.clubId);
  if (!club) return { success: false, error: 'Club not found' };

  if (isClubMember(referrer.clubId, userId)) {
    return { success: false, error: 'You are already a member of this club' };
  }

  const memberCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(referrer.clubId, 'active') as any).cnt;
  if (memberCount >= club.settings.maxMembers) {
    return { success: false, error: 'This club is full' };
  }

  try {
    d.prepare(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES (?, ?, ?, ?)'
    ).run(referrer.clubId, userId, 'member', 'active');

    const referrerName = getUsername(referrer.referrerId);
    const newMemberName = getUsername(userId);

    d.prepare(
      `INSERT INTO club_stats (clubId, userId, username, chipsWon) VALUES (?, ?, ?, 500)
       ON CONFLICT(clubId, userId) DO UPDATE SET chipsWon = chipsWon + 500, updatedAt = datetime('now')`
    ).run(referrer.clubId, referrer.referrerId, referrerName);

    d.prepare(
      `INSERT INTO club_stats (clubId, userId, username, chipsWon) VALUES (?, ?, ?, 500)
       ON CONFLICT(clubId, userId) DO UPDATE SET chipsWon = chipsWon + 500, updatedAt = datetime('now')`
    ).run(referrer.clubId, userId, newMemberName);

    const newCount = (d.prepare('SELECT COUNT(*) as cnt FROM club_members WHERE clubId = ? AND status = ?').get(referrer.clubId, 'active') as any).cnt;
    const rawRow = d.prepare('SELECT badge, clubXp, clubLevel FROM clubs WHERE id = ?').get(referrer.clubId) as any;

    return {
      success: true,
      bonusChips: 500,
      club: {
        id: club.id,
        clubCode: club.clubCode,
        name: club.name,
        description: club.description,
        ownerId: club.ownerId,
        ownerName: getUsername(club.ownerId),
        settings: club.settings,
        memberCount: newCount,
        createdAt: club.createdAt,
        badge: rawRow?.badge || '♠',
        clubLevel: rawRow?.clubLevel || 1,
        clubXp: rawRow?.clubXp || 0,
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Referral join error:', err);
    return { success: false, error: 'Failed to join club via referral' };
  }
}

export function getReferralStats(
  clubId: number,
  userId: number
): { success: boolean; referralCode?: string; referralCount: number; chipsEarned: number } {
  const d = getDB();
  const member = d.prepare(
    'SELECT referral_code FROM club_members WHERE clubId = ? AND userId = ?'
  ).get(clubId, userId) as any;

  if (!member?.referral_code) {
    return { success: true, referralCount: 0, chipsEarned: 0 };
  }

  const stats = d.prepare(
    'SELECT chipsWon FROM club_stats WHERE clubId = ? AND userId = ?'
  ).get(clubId, userId) as any;

  return {
    success: true,
    referralCode: member.referral_code,
    referralCount: 0,
    chipsEarned: stats?.chipsWon || 0,
  };
}

// ═══════════════════════════════════════════
// Feature 15: Club Levels
// ═══════════════════════════════════════════

export function addClubXp(
  clubId: number,
  amount: number
): { success: boolean; newLevel?: number; newXp?: number; leveledUp?: boolean } {
  const d = getDB();
  const club = d.prepare('SELECT clubXp, clubLevel FROM clubs WHERE id = ?').get(clubId) as any;
  if (!club) return { success: false };

  const currentXp = (club.clubXp || 0) + amount;
  let currentLevel = club.clubLevel || 1;
  let leveledUp = false;

  while (currentLevel < 20 && currentXp >= CLUB_LEVEL_THRESHOLDS[currentLevel]) {
    currentLevel++;
    leveledUp = true;
  }

  d.prepare('UPDATE clubs SET clubXp = ?, clubLevel = ? WHERE id = ?').run(currentXp, currentLevel, clubId);

  return { success: true, newLevel: currentLevel, newXp: currentXp, leveledUp };
}

export function getClubLevel(
  clubId: number
): { success: boolean; level: number; xp: number; nextLevelXp: number; perks: { level: number; perk: string; unlocked: boolean }[] } {
  const d = getDB();
  const club = d.prepare('SELECT clubXp, clubLevel FROM clubs WHERE id = ?').get(clubId) as any;
  const level = club?.clubLevel || 1;
  const xp = club?.clubXp || 0;
  const nextLevelXp = level < 20 ? CLUB_LEVEL_THRESHOLDS[level] : CLUB_LEVEL_THRESHOLDS[19];

  const perks = CLUB_LEVEL_PERKS.map((p) => ({
    ...p,
    unlocked: level >= p.level,
  }));

  return { success: true, level, xp, nextLevelXp, perks };
}

// ═══════════════════════════════════════════
// Feature 16: Featured Clubs Directory
// ═══════════════════════════════════════════

export function getFeaturedClubs(): { success: boolean; clubs: ClubInfo[] } {
  const d = getDB();
  const rows = d.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount,
      (SELECT COALESCE(SUM(handsPlayed), 0) FROM club_stats WHERE clubId = c.id) as totalHands
     FROM clubs c
     WHERE json_extract(c.settings, '$.isPrivate') = 0
     ORDER BY memberCount DESC, totalHands DESC
     LIMIT 10`
  ).all() as any[];

  const clubs: ClubInfo[] = rows.map((r) => ({
    id: r.id,
    clubCode: r.clubCode,
    name: r.name,
    description: r.description,
    ownerId: r.ownerId,
    ownerName: getUsername(r.ownerId),
    settings: JSON.parse(r.settings || '{}'),
    memberCount: r.memberCount,
    createdAt: r.createdAt,
    badge: r.badge || '♠',
    clubLevel: r.clubLevel || 1,
    clubXp: r.clubXp || 0,
  }));

  return { success: true, clubs };
}

export function getClubOfWeek(): { success: boolean; club?: ClubInfo } {
  const d = getDB();
  const row = d.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount,
      (SELECT COALESCE(SUM(handsPlayed), 0) FROM club_stats WHERE clubId = c.id AND updatedAt >= datetime('now', '-7 days')) as weeklyHands
     FROM clubs c
     WHERE json_extract(c.settings, '$.isPrivate') = 0
     ORDER BY weeklyHands DESC, memberCount DESC
     LIMIT 1`
  ).get() as any;

  if (!row) return { success: true };

  return {
    success: true,
    club: {
      id: row.id,
      clubCode: row.clubCode,
      name: row.name,
      description: row.description,
      ownerId: row.ownerId,
      ownerName: getUsername(row.ownerId),
      settings: JSON.parse(row.settings || '{}'),
      memberCount: row.memberCount,
      createdAt: row.createdAt,
      badge: row.badge || '♠',
      clubLevel: row.clubLevel || 1,
      clubXp: row.clubXp || 0,
    },
  };
}

import { getPool } from '../auth/authManager';

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
//
// Migrated 2026-06-19 from ephemeral better-sqlite3 to the durable Postgres
// pool (authManager.getPool()). Two bugs fixed by this migration:
//   1. Clubs data was wiped on every Railway redeploy (SQLite file on an
//      ephemeral FS with no volume).
//   2. clubManager queried a `users` table it never created, so member
//      names showed 'Unknown' and invites failed. Username/displayName now
//      resolve against the REAL Postgres `users` table owned by authManager
//      (columns: id, username, display_name).
//
// Boolean-ish columns are kept as INTEGER (0/1) so all existing comparison
// logic (isActive === 1, isPinned, recurring ? 1 : 0, etc.) is unchanged.

export async function initClubTables(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      clubCode TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      ownerId INTEGER NOT NULL,
      settings TEXT DEFAULT '{}',
      createdAt TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_members (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joinedAt TIMESTAMPTZ DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(clubId, userId),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_tables (
      id SERIAL PRIMARY KEY,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_messages (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'chat',
      isPinned INTEGER NOT NULL DEFAULT 0,
      createdAt TIMESTAMPTZ DEFAULT now(),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_stats (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      username TEXT NOT NULL,
      handsPlayed INTEGER NOT NULL DEFAULT 0,
      chipsWon INTEGER NOT NULL DEFAULT 0,
      chipsLost INTEGER NOT NULL DEFAULT 0,
      biggestPot INTEGER NOT NULL DEFAULT 0,
      tournamentsWon INTEGER NOT NULL DEFAULT 0,
      updatedAt TIMESTAMPTZ DEFAULT now(),
      UNIQUE(clubId, userId),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_activity (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      createdAt TIMESTAMPTZ DEFAULT now(),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_tournaments (
      id SERIAL PRIMARY KEY,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_tournament_registrations (
      id SERIAL PRIMARY KEY,
      tournamentId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      registeredAt TIMESTAMPTZ DEFAULT now(),
      UNIQUE(tournamentId, userId),
      FOREIGN KEY (tournamentId) REFERENCES club_tournaments(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_challenges (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      challengerId INTEGER NOT NULL,
      challengerName TEXT NOT NULL,
      challengedId INTEGER NOT NULL,
      challengedName TEXT NOT NULL,
      stakes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      winnerId INTEGER DEFAULT NULL,
      createdAt TIMESTAMPTZ DEFAULT now(),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tables (
      id SERIAL PRIMARY KEY,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blind_structures (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      name TEXT NOT NULL,
      levels TEXT NOT NULL DEFAULT '[]',
      createdBy INTEGER NOT NULL,
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  // ── Feature 10: Club Invitations ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_invitations (
      id SERIAL PRIMARY KEY,
      clubId INTEGER NOT NULL,
      clubName TEXT NOT NULL,
      inviterId INTEGER NOT NULL,
      inviterName TEXT NOT NULL,
      invitedUsername TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt TIMESTAMPTZ DEFAULT now(),
      FOREIGN KEY (clubId) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  // ── Feature 11: Club Unions ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_unions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      leaderClubId INTEGER NOT NULL,
      createdAt TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS union_members (
      id SERIAL PRIMARY KEY,
      unionId INTEGER NOT NULL,
      clubId INTEGER NOT NULL,
      joinedAt TIMESTAMPTZ DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(unionId, clubId),
      FOREIGN KEY (unionId) REFERENCES club_unions(id) ON DELETE CASCADE
    )
  `);

  // ── Feature 13: Club Badges - add badge column ──
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS badge TEXT DEFAULT '♠'`).catch(() => {});

  // ── Feature 14: Referral Codes - add referral_code column ──
  await pool.query(`ALTER TABLE club_members ADD COLUMN IF NOT EXISTS referral_code TEXT DEFAULT NULL`).catch(() => {});

  // ── Feature 15: Club Levels - add clubXp and clubLevel columns ──
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS clubXp INTEGER DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS clubLevel INTEGER DEFAULT 1`).catch(() => {});

  console.log('[Clubs] Database tables initialized (with social features)');
}

// ========== Helpers ==========

async function generateClubCode(): Promise<string> {
  const pool = getPool();
  let code: string;
  let attempts = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = (await pool.query('SELECT id FROM clubs WHERE clubCode = $1', [code])).rows[0] ?? null;
    if (!existing) return code;
    attempts++;
  } while (attempts < 100);
  throw new Error('Could not generate unique club code');
}

async function getUsername(userId: number): Promise<string> {
  const pool = getPool();
  const user = (await pool.query(
    'SELECT COALESCE(display_name, username) AS username FROM users WHERE id = $1',
    [userId]
  )).rows[0] as { username: string } | undefined;
  return user?.username || 'Unknown';
}

async function getMemberRole(clubId: number, userId: number): Promise<string | null> {
  const pool = getPool();
  const row = (await pool.query(
    'SELECT role FROM club_members WHERE clubId = $1 AND userId = $2 AND status = $3',
    [clubId, userId, 'active']
  )).rows[0] as { role: string } | undefined;
  return row?.role || null;
}

// NOTE on identifier case: Postgres folds unquoted column names to
// lowercase, so a column created as `clubCode` comes back on the result
// row as `clubcode`. We map result rows explicitly (lowercase keys →
// camelCase fields) rather than spreading, so the public return shapes are
// identical to the old better-sqlite3 versions.
function rowToClub(row: any): Club {
  return {
    id: row.id,
    clubCode: row.clubcode,
    name: row.name,
    description: row.description,
    ownerId: row.ownerid,
    settings: JSON.parse(row.settings || '{}'),
    createdAt: row.createdat,
  };
}

async function getClubById(clubId: number): Promise<Club | null> {
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM clubs WHERE id = $1', [clubId])).rows[0] as any;
  if (!row) return null;
  return rowToClub(row);
}

async function getClubByCode(code: string): Promise<Club | null> {
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM clubs WHERE clubCode = $1', [code])).rows[0] as any;
  if (!row) return null;
  return rowToClub(row);
}

// ========== Club Operations ==========

export async function createClub(
  ownerId: number,
  name: string,
  description: string,
  settings: Partial<ClubSettings>
): Promise<{ success: boolean; error?: string; club?: ClubInfo }> {
  if (!name || name.trim().length < 2) {
    return { success: false, error: 'Club name must be at least 2 characters' };
  }

  const pool = getPool();
  const clubCode = await generateClubCode();
  const fullSettings: ClubSettings = {
    rake: settings.rake ?? 0,
    maxMembers: settings.maxMembers ?? 100,
    isPrivate: settings.isPrivate ?? true,
    requireApproval: settings.requireApproval ?? false,
  };

  try {
    const result = await pool.query(
      'INSERT INTO clubs (clubCode, name, description, ownerId, settings) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [clubCode, name.trim(), description?.trim() || '', ownerId, JSON.stringify(fullSettings)]
    );

    const clubId = result.rows[0].id as number;

    // Add owner as member
    await pool.query(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES ($1, $2, $3, $4)',
      [clubId, ownerId, 'owner', 'active']
    );

    return {
      success: true,
      club: {
        id: clubId,
        clubCode,
        name: name.trim(),
        description: description?.trim() || '',
        ownerId,
        ownerName: await getUsername(ownerId),
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

export async function joinClub(
  userId: number,
  clubCode: string
): Promise<{ success: boolean; error?: string; club?: ClubInfo; status?: string }> {
  const club = await getClubByCode(clubCode);
  if (!club) {
    return { success: false, error: 'Club not found. Check the code and try again.' };
  }

  const pool = getPool();

  // Check if already a member
  const existing = (await pool.query('SELECT * FROM club_members WHERE clubId = $1 AND userId = $2', [club.id, userId])).rows[0] as any;
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
  const memberCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [club.id, 'active'])).rows[0] as any).cnt;
  if (memberCount >= settings.maxMembers) {
    return { success: false, error: 'This club is full' };
  }

  const status = settings.requireApproval ? 'pending' : 'active';

  try {
    await pool.query(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES ($1, $2, $3, $4)',
      [club.id, userId, 'member', status]
    );

    const newCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [club.id, 'active'])).rows[0] as any).cnt;

    return {
      success: true,
      status,
      club: {
        id: club.id,
        clubCode: club.clubCode,
        name: club.name,
        description: club.description,
        ownerId: club.ownerId,
        ownerName: await getUsername(club.ownerId),
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

export async function leaveClub(
  userId: number,
  clubId: number
): Promise<{ success: boolean; error?: string }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  if (club.ownerId === userId) {
    return { success: false, error: 'Owners cannot leave their own club. Transfer ownership or delete the club.' };
  }

  const pool = getPool();
  const result = await pool.query('DELETE FROM club_members WHERE clubId = $1 AND userId = $2', [clubId, userId]);
  if (result.rowCount === 0) {
    return { success: false, error: 'You are not a member of this club' };
  }

  return { success: true };
}

export async function getClubInfo(
  clubId: number,
  requesterId?: number
): Promise<{ success: boolean; error?: string; club?: ClubInfo }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const memberCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [clubId, 'active'])).rows[0] as any).cnt;

  let myRole: string | undefined;
  if (requesterId) {
    myRole = (await getMemberRole(clubId, requesterId)) || undefined;
  }

  // Get badge and level from raw row
  const rawRow = (await pool.query('SELECT badge, clubXp, clubLevel FROM clubs WHERE id = $1', [clubId])).rows[0] as any;

  return {
    success: true,
    club: {
      id: club.id,
      clubCode: club.clubCode,
      name: club.name,
      description: club.description,
      ownerId: club.ownerId,
      ownerName: await getUsername(club.ownerId),
      settings: club.settings,
      memberCount,
      createdAt: club.createdAt,
      myRole,
      badge: rawRow?.badge || '♠',
      clubLevel: rawRow?.clublevel || 1,
      clubXp: rawRow?.clubxp || 0,
    },
  };
}

export async function getClubMembers(
  clubId: number
): Promise<{ success: boolean; error?: string; members?: ClubMember[] }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const rows = (await pool.query(
    `SELECT cm.*, COALESCE(u.display_name, u.username) AS username FROM club_members cm
     LEFT JOIN users u ON cm.userId = u.id
     WHERE cm.clubId = $1
     ORDER BY
       CASE cm.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
       cm.joinedAt ASC`,
    [clubId]
  )).rows as any[];

  const members: ClubMember[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    userId: r.userid,
    username: r.username,
    role: r.role,
    joinedAt: r.joinedat,
    status: r.status,
  }));

  return { success: true, members };
}

export async function getMyClubs(
  userId: number
): Promise<{ success: boolean; clubs: ClubInfo[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT c.*, cm.role as myRole,
      (SELECT COUNT(*)::int FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount
     FROM clubs c
     JOIN club_members cm ON c.id = cm.clubId
     WHERE cm.userId = $1 AND cm.status = 'active'
     ORDER BY cm.joinedAt DESC`,
    [userId]
  )).rows as any[];

  const clubs: ClubInfo[] = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    clubCode: r.clubcode,
    name: r.name,
    description: r.description,
    ownerId: r.ownerid,
    ownerName: await getUsername(r.ownerid),
    settings: JSON.parse(r.settings || '{}'),
    memberCount: r.membercount,
    createdAt: r.createdat,
    myRole: r.myrole,
    badge: r.badge || '♠',
    clubLevel: r.clublevel || 1,
    clubXp: r.clubxp || 0,
  })));

  return { success: true, clubs };
}

export async function approveMember(
  managerId: number,
  clubId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const managerRole = await getMemberRole(clubId, managerId);
  if (!managerRole || (managerRole !== 'owner' && managerRole !== 'manager')) {
    return { success: false, error: 'Only owners and managers can approve members' };
  }

  const pool = getPool();
  const result = await pool.query(
    'UPDATE club_members SET status = $1 WHERE clubId = $2 AND userId = $3 AND status = $4',
    ['active', clubId, userId, 'pending']
  );

  if (result.rowCount === 0) {
    return { success: false, error: 'No pending request found for this user' };
  }

  return { success: true };
}

export async function removeMember(
  managerId: number,
  clubId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const managerRole = await getMemberRole(clubId, managerId);
  if (!managerRole || (managerRole !== 'owner' && managerRole !== 'manager')) {
    return { success: false, error: 'Only owners and managers can remove members' };
  }

  // Managers can't remove owners or other managers
  const targetRole = await getMemberRole(clubId, userId);
  if (targetRole === 'owner') {
    return { success: false, error: 'Cannot remove the club owner' };
  }
  if (targetRole === 'manager' && managerRole !== 'owner') {
    return { success: false, error: 'Only the owner can remove managers' };
  }

  const pool = getPool();
  await pool.query('UPDATE club_members SET status = $1 WHERE clubId = $2 AND userId = $3', ['banned', clubId, userId]);
  return { success: true };
}

export async function promoteToManager(
  ownerId: number,
  clubId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can promote members' };
  }

  const pool = getPool();
  const result = await pool.query(
    'UPDATE club_members SET role = $1 WHERE clubId = $2 AND userId = $3 AND status = $4',
    ['manager', clubId, userId, 'active']
  );

  if (result.rowCount === 0) {
    return { success: false, error: 'Member not found or not active' };
  }

  return { success: true };
}

export async function createClubTable(
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
): Promise<{ success: boolean; error?: string; table?: ClubTable }> {
  const role = await getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can create tables' };
  }

  if (!config.tableName || config.tableName.trim().length < 2) {
    return { success: false, error: 'Table name must be at least 2 characters' };
  }

  const pool = getPool();
  const sb = config.smallBlind || 5;
  const bb = config.bigBlind || 10;
  const minBuy = config.minBuyIn || bb * 20;
  const maxBuy = config.maxBuyIn || bb * 100;
  const maxSeats = Math.min(9, Math.max(2, config.maxSeats || 9));
  const variant = config.variant || 'texas-holdem';

  try {
    const result = await pool.query(
      `INSERT INTO club_tables (clubId, tableName, variant, smallBlind, bigBlind, minBuyIn, maxBuyIn, maxSeats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [clubId, config.tableName.trim(), variant, sb, bb, minBuy, maxBuy, maxSeats]
    );

    const tableRow: ClubTable = {
      id: result.rows[0].id as number,
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

export async function getClubTables(
  clubId: number
): Promise<{ success: boolean; error?: string; tables?: ClubTable[] }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM club_tables WHERE clubId = $1 AND isActive = 1',
    [clubId]
  )).rows as any[];

  const tables: ClubTable[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    tableName: r.tablename,
    variant: r.variant,
    smallBlind: r.smallblind,
    bigBlind: r.bigblind,
    minBuyIn: r.minbuyin,
    maxBuyIn: r.maxbuyin,
    maxSeats: r.maxseats,
    isActive: r.isactive === 1,
    tableId: r.tableid || undefined,
  }));

  return { success: true, tables };
}

export async function updateClubTableId(clubTableId: number, runtimeTableId: string): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE club_tables SET tableId = $1 WHERE id = $2', [runtimeTableId, clubTableId]);
}

export async function removeClubTable(clubTableId: number): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE club_tables SET isActive = 0 WHERE id = $1', [clubTableId]);
}

export async function updateClubSettings(
  ownerId: number,
  clubId: number,
  newSettings: Partial<ClubSettings> & { name?: string; description?: string }
): Promise<{ success: boolean; error?: string; club?: ClubInfo }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can update settings' };
  }

  const pool = getPool();
  const updatedSettings: ClubSettings = {
    rake: newSettings.rake ?? club.settings.rake,
    maxMembers: newSettings.maxMembers ?? club.settings.maxMembers,
    isPrivate: newSettings.isPrivate ?? club.settings.isPrivate,
    requireApproval: newSettings.requireApproval ?? club.settings.requireApproval,
  };

  const updatedName = newSettings.name?.trim() || club.name;
  const updatedDesc = newSettings.description !== undefined ? newSettings.description.trim() : club.description;

  await pool.query(
    'UPDATE clubs SET name = $1, description = $2, settings = $3 WHERE id = $4',
    [updatedName, updatedDesc, JSON.stringify(updatedSettings), clubId]
  );

  const memberCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [clubId, 'active'])).rows[0] as any).cnt;

  return {
    success: true,
    club: {
      id: clubId,
      clubCode: club.clubCode,
      name: updatedName,
      description: updatedDesc,
      ownerId,
      ownerName: await getUsername(ownerId),
      settings: updatedSettings,
      memberCount,
      createdAt: club.createdAt,
    },
  };
}

export async function deleteClub(
  ownerId: number,
  clubId: number
): Promise<{ success: boolean; error?: string }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can delete the club' };
  }

  const pool = getPool();
  await pool.query('DELETE FROM club_members WHERE clubId = $1', [clubId]);
  await pool.query('DELETE FROM club_tables WHERE clubId = $1', [clubId]);
  await pool.query('DELETE FROM clubs WHERE id = $1', [clubId]);

  return { success: true };
}

export async function searchClubs(
  query: string
): Promise<{ success: boolean; clubs: ClubInfo[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT c.*,
      (SELECT COUNT(*)::int FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount
     FROM clubs c
     WHERE c.name ILIKE $1 AND (c.settings::jsonb ->> 'isPrivate') = 'false'
     ORDER BY memberCount DESC
     LIMIT 20`,
    [`%${query}%`]
  )).rows as any[];

  const clubs: ClubInfo[] = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    clubCode: r.clubcode,
    name: r.name,
    description: r.description,
    ownerId: r.ownerid,
    ownerName: await getUsername(r.ownerid),
    settings: JSON.parse(r.settings || '{}'),
    memberCount: r.membercount,
    createdAt: r.createdat,
  })));

  return { success: true, clubs };
}

export async function isClubMember(clubId: number, userId: number): Promise<boolean> {
  const role = await getMemberRole(clubId, userId);
  return role !== null;
}

export async function getClubTableById(clubTableId: number): Promise<ClubTable | null> {
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM club_tables WHERE id = $1', [clubTableId])).rows[0] as any;
  if (!row) return null;
  return {
    id: row.id,
    clubId: row.clubid,
    tableName: row.tablename,
    variant: row.variant,
    smallBlind: row.smallblind,
    bigBlind: row.bigblind,
    minBuyIn: row.minbuyin,
    maxBuyIn: row.maxbuyin,
    maxSeats: row.maxseats,
    isActive: row.isactive === 1,
    tableId: row.tableid || undefined,
  };
}

// ========== Club Messages ==========

export async function sendClubMessage(
  clubId: number,
  userId: number,
  username: string,
  message: string,
  type: 'chat' | 'announcement' | 'system' = 'chat'
): Promise<{ success: boolean; error?: string; message?: ClubMessage }> {
  if (!message || message.trim().length === 0) {
    return { success: false, error: 'Message cannot be empty' };
  }

  const pool = getPool();
  try {
    const isPinned = type === 'announcement' ? 1 : 0;
    const result = await pool.query(
      'INSERT INTO club_messages (clubId, userId, username, message, type, isPinned) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [clubId, userId, username, message.trim(), type, isPinned]
    );

    const msg: ClubMessage = {
      id: result.rows[0].id as number,
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

export async function getClubMessages(
  clubId: number,
  limit: number = 50
): Promise<{ success: boolean; messages: ClubMessage[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM club_messages WHERE clubId = $1 ORDER BY createdAt DESC LIMIT $2',
    [clubId, limit]
  )).rows as any[];

  const messages: ClubMessage[] = rows.reverse().map((r) => ({
    id: r.id,
    clubId: r.clubid,
    userId: r.userid,
    username: r.username,
    message: r.message,
    type: r.type,
    isPinned: r.ispinned,
    createdAt: r.createdat,
  }));

  return { success: true, messages };
}

export async function pinMessage(
  clubId: number,
  messageId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const result = await pool.query(
    'UPDATE club_messages SET isPinned = 1 WHERE id = $1 AND clubId = $2',
    [messageId, clubId]
  );
  if (result.rowCount === 0) {
    return { success: false, error: 'Message not found' };
  }
  return { success: true };
}

export async function unpinMessage(
  clubId: number,
  messageId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const result = await pool.query(
    'UPDATE club_messages SET isPinned = 0 WHERE id = $1 AND clubId = $2',
    [messageId, clubId]
  );
  if (result.rowCount === 0) {
    return { success: false, error: 'Message not found' };
  }
  return { success: true };
}

export async function getAnnouncements(
  clubId: number
): Promise<{ success: boolean; announcements: ClubMessage[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    "SELECT * FROM club_messages WHERE clubId = $1 AND (type = 'announcement' OR isPinned = 1) ORDER BY createdAt DESC LIMIT 10",
    [clubId]
  )).rows as any[];

  const announcements: ClubMessage[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    userId: r.userid,
    username: r.username,
    message: r.message,
    type: r.type,
    isPinned: r.ispinned,
    createdAt: r.createdat,
  }));

  return { success: true, announcements };
}

// ========== Club Stats / Leaderboard ==========

export async function updateClubStats(
  clubId: number,
  userId: number,
  data: { handsPlayed?: number; chipsWon?: number; chipsLost?: number; biggestPot?: number; tournamentsWon?: number }
): Promise<{ success: boolean }> {
  const pool = getPool();
  const username = await getUsername(userId);

  const existing = (await pool.query('SELECT * FROM club_stats WHERE clubId = $1 AND userId = $2', [clubId, userId])).rows[0] as any;

  if (!existing) {
    await pool.query(
      'INSERT INTO club_stats (clubId, userId, username, handsPlayed, chipsWon, chipsLost, biggestPot, tournamentsWon) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [clubId, userId, username, data.handsPlayed || 0, data.chipsWon || 0, data.chipsLost || 0, data.biggestPot || 0, data.tournamentsWon || 0]
    );
  } else {
    const hp = (existing.handsplayed || 0) + (data.handsPlayed || 0);
    const cw = (existing.chipswon || 0) + (data.chipsWon || 0);
    const cl = (existing.chipslost || 0) + (data.chipsLost || 0);
    const bp = Math.max(existing.biggestpot || 0, data.biggestPot || 0);
    const tw = (existing.tournamentswon || 0) + (data.tournamentsWon || 0);

    await pool.query(
      "UPDATE club_stats SET handsPlayed = $1, chipsWon = $2, chipsLost = $3, biggestPot = $4, tournamentsWon = $5, username = $6, updatedAt = now() WHERE clubId = $7 AND userId = $8",
      [hp, cw, cl, bp, tw, username, clubId, userId]
    );
  }

  return { success: true };
}

export async function getClubLeaderboard(
  clubId: number,
  period: 'today' | 'week' | 'alltime' = 'alltime'
): Promise<{ success: boolean; leaderboard: ClubStat[] }> {
  const pool = getPool();

  // For simplicity, alltime uses club_stats directly.
  // period filtering would require per-hand timestamped data; approximate with updatedAt
  let dateFilter = '';
  if (period === 'today') {
    dateFilter = "AND updatedAt >= now() - interval '1 day'";
  } else if (period === 'week') {
    dateFilter = "AND updatedAt >= now() - interval '7 days'";
  }

  const rows = (await pool.query(
    `SELECT * FROM club_stats WHERE clubId = $1 ${dateFilter} ORDER BY chipsWon DESC LIMIT 50`,
    [clubId]
  )).rows as any[];

  const leaderboard: ClubStat[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    userId: r.userid,
    username: r.username,
    handsPlayed: r.handsplayed,
    chipsWon: r.chipswon,
    chipsLost: r.chipslost,
    biggestPot: r.biggestpot,
    tournamentsWon: r.tournamentswon,
    updatedAt: r.updatedat,
  }));

  return { success: true, leaderboard };
}

export async function getClubStatistics(
  clubId: number
): Promise<{ success: boolean; statistics: { totalMembers: number; totalHandsPlayed: number; biggestPotEver: number; mostActivePlayer: string; clubAge: string } }> {
  const pool = getPool();

  const totalMembers = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [clubId, 'active'])).rows[0] as any).cnt;

  const statsAgg = (await pool.query(
    'SELECT COALESCE(SUM(handsPlayed), 0)::int as totalHands, COALESCE(MAX(biggestPot), 0)::int as bigPot FROM club_stats WHERE clubId = $1',
    [clubId]
  )).rows[0] as any;

  const mostActive = (await pool.query(
    'SELECT username FROM club_stats WHERE clubId = $1 ORDER BY handsPlayed DESC LIMIT 1',
    [clubId]
  )).rows[0] as any;

  const club = (await pool.query('SELECT createdAt FROM clubs WHERE id = $1', [clubId])).rows[0] as any;
  const clubCreated = club?.createdat || '';
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
      totalHandsPlayed: statsAgg.totalhands,
      biggestPotEver: statsAgg.bigpot,
      mostActivePlayer: mostActive?.username || 'N/A',
      clubAge,
    },
  };
}

// ========== Club Activity Feed ==========

export async function addActivity(
  clubId: number,
  type: 'member_join' | 'member_leave' | 'big_win' | 'tournament' | 'announcement',
  data: Record<string, any>
): Promise<{ success: boolean }> {
  const pool = getPool();
  try {
    await pool.query(
      'INSERT INTO club_activity (clubId, type, data) VALUES ($1, $2, $3)',
      [clubId, type, JSON.stringify(data)]
    );
    return { success: true };
  } catch (err: any) {
    console.error('[Clubs] Add activity error:', err);
    return { success: false };
  }
}

export async function getActivityFeed(
  clubId: number,
  limit: number = 20
): Promise<{ success: boolean; activities: ClubActivityItem[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM club_activity WHERE clubId = $1 ORDER BY createdAt DESC LIMIT $2',
    [clubId, limit]
  )).rows as any[];

  const activities: ClubActivityItem[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    type: r.type,
    data: r.data,
    createdAt: r.createdat,
  }));

  return { success: true, activities };
}

// ========== Club Tournaments ==========

export async function createClubTournament(
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
): Promise<{ success: boolean; error?: string; tournament?: ClubTournament }> {
  const role = await getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can create tournaments' };
  }
  if (!config.name || config.name.trim().length < 2) {
    return { success: false, error: 'Tournament name must be at least 2 characters' };
  }

  const pool = getPool();
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
    const result = await pool.query(
      `INSERT INTO club_tournaments (clubId, name, format, blindStructure, buyIn, startingChips, maxPlayers, status, scheduledAt, createdBy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'registering', $8, $9) RETURNING id`,
      [clubId, config.name.trim(), format, JSON.stringify(blindStructure), buyIn, startingChips, maxPlayers, config.scheduledAt, managerId]
    );

    const tournament: ClubTournament = {
      id: result.rows[0].id as number,
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

export async function getClubTournaments(
  clubId: number
): Promise<{ success: boolean; error?: string; tournaments?: ClubTournament[] }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const rows = (await pool.query(
    `SELECT ct.*,
      (SELECT COUNT(*)::int FROM club_tournament_registrations WHERE tournamentId = ct.id) as registeredCount
     FROM club_tournaments ct
     WHERE ct.clubId = $1
     ORDER BY ct.scheduledAt DESC`,
    [clubId]
  )).rows as any[];

  const tournaments: ClubTournament[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    name: r.name,
    format: r.format,
    blindStructure: JSON.parse(r.blindstructure || '[]'),
    buyIn: r.buyin,
    startingChips: r.startingchips,
    maxPlayers: r.maxplayers,
    status: r.status,
    scheduledAt: r.scheduledat,
    startedAt: r.startedat,
    createdBy: r.createdby,
    registeredCount: r.registeredcount || 0,
  }));

  return { success: true, tournaments };
}

export async function registerForClubTournament(
  tournamentId: number,
  userId: number
): Promise<{ success: boolean; error?: string; registered?: boolean }> {
  const pool = getPool();
  const tourney = (await pool.query('SELECT * FROM club_tournaments WHERE id = $1', [tournamentId])).rows[0] as any;
  if (!tourney) return { success: false, error: 'Tournament not found' };
  if (tourney.status !== 'registering') return { success: false, error: 'Tournament is not accepting registrations' };

  if (!(await isClubMember(tourney.clubid, userId))) {
    return { success: false, error: 'You must be a club member to register' };
  }

  const regCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_tournament_registrations WHERE tournamentId = $1', [tournamentId])).rows[0] as any).cnt;
  if (regCount >= tourney.maxplayers) {
    return { success: false, error: 'Tournament is full' };
  }

  const existing = (await pool.query('SELECT id FROM club_tournament_registrations WHERE tournamentId = $1 AND userId = $2', [tournamentId, userId])).rows[0];
  if (existing) {
    // Unregister
    await pool.query('DELETE FROM club_tournament_registrations WHERE tournamentId = $1 AND userId = $2', [tournamentId, userId]);
    return { success: true, registered: false };
  }

  await pool.query('INSERT INTO club_tournament_registrations (tournamentId, userId) VALUES ($1, $2)', [tournamentId, userId]);
  return { success: true, registered: true };
}

export async function startClubTournament(
  tournamentId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const tourney = (await pool.query('SELECT * FROM club_tournaments WHERE id = $1', [tournamentId])).rows[0] as any;
  if (!tourney) return { success: false, error: 'Tournament not found' };

  const role = await getMemberRole(tourney.clubid, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can start tournaments' };
  }
  if (tourney.status !== 'registering') {
    return { success: false, error: 'Tournament cannot be started in current state' };
  }

  await pool.query("UPDATE club_tournaments SET status = $1, startedAt = now() WHERE id = $2", ['running', tournamentId]);
  return { success: true };
}

// ========== Club Challenges ==========

export async function createChallenge(
  clubId: number,
  challengerId: number,
  challengedId: number,
  stakes: number
): Promise<{ success: boolean; error?: string; challenge?: ClubChallenge }> {
  if (!(await isClubMember(clubId, challengerId))) {
    return { success: false, error: 'You must be a club member' };
  }
  if (!(await isClubMember(clubId, challengedId))) {
    return { success: false, error: 'Challenged player is not a club member' };
  }
  if (challengerId === challengedId) {
    return { success: false, error: 'You cannot challenge yourself' };
  }

  const pool = getPool();
  const challengerName = await getUsername(challengerId);
  const challengedName = await getUsername(challengedId);

  try {
    const result = await pool.query(
      `INSERT INTO club_challenges (clubId, challengerId, challengerName, challengedId, challengedName, stakes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
      [clubId, challengerId, challengerName, challengedId, challengedName, stakes || 0]
    );

    const challenge: ClubChallenge = {
      id: result.rows[0].id as number,
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

export async function acceptChallenge(
  challengeId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const ch = (await pool.query('SELECT * FROM club_challenges WHERE id = $1', [challengeId])).rows[0] as any;
  if (!ch) return { success: false, error: 'Challenge not found' };
  if (ch.challengedid !== userId) return { success: false, error: 'Only the challenged player can accept' };
  if (ch.status !== 'pending') return { success: false, error: 'Challenge is not pending' };

  await pool.query('UPDATE club_challenges SET status = $1 WHERE id = $2', ['accepted', challengeId]);
  return { success: true };
}

export async function declineChallenge(
  challengeId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const ch = (await pool.query('SELECT * FROM club_challenges WHERE id = $1', [challengeId])).rows[0] as any;
  if (!ch) return { success: false, error: 'Challenge not found' };
  if (ch.challengedid !== userId && ch.challengerid !== userId) {
    return { success: false, error: 'Only participants can decline/cancel a challenge' };
  }
  if (ch.status !== 'pending') return { success: false, error: 'Challenge is not pending' };

  await pool.query('DELETE FROM club_challenges WHERE id = $1', [challengeId]);
  return { success: true };
}

export async function getClubChallenges(
  clubId: number
): Promise<{ success: boolean; error?: string; challenges?: ClubChallenge[] }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM club_challenges WHERE clubId = $1 ORDER BY createdAt DESC LIMIT 50',
    [clubId]
  )).rows as any[];

  const challenges: ClubChallenge[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    challengerId: r.challengerid,
    challengerName: r.challengername,
    challengedId: r.challengedid,
    challengedName: r.challengedname,
    stakes: r.stakes,
    status: r.status,
    winnerId: r.winnerid,
    createdAt: r.createdat,
  }));

  return { success: true, challenges };
}

// ========== Table Scheduling ==========

export async function scheduleTable(
  clubId: number,
  managerId: number,
  config: any,
  time: string,
  recurring: boolean,
  recurrencePattern?: string
): Promise<{ success: boolean; error?: string; scheduledTable?: ScheduledTable }> {
  const role = await getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can schedule tables' };
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `INSERT INTO scheduled_tables (clubId, tableConfig, scheduledTime, recurring, recurrencePattern, status, createdBy)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6) RETURNING id`,
      [clubId, JSON.stringify(config), time, recurring ? 1 : 0, recurrencePattern || null, managerId]
    );

    const st: ScheduledTable = {
      id: result.rows[0].id as number,
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

export async function getScheduledTables(
  clubId: number
): Promise<{ success: boolean; error?: string; scheduledTables?: ScheduledTable[] }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM scheduled_tables WHERE clubId = $1 AND status != $2 ORDER BY scheduledTime ASC',
    [clubId, 'completed']
  )).rows as any[];

  const scheduledTables: ScheduledTable[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    tableConfig: r.tableconfig,
    scheduledTime: r.scheduledtime,
    recurring: r.recurring === 1,
    recurrencePattern: r.recurrencepattern,
    status: r.status,
    createdBy: r.createdby,
  }));

  return { success: true, scheduledTables };
}

export async function activateScheduledTable(
  id: number,
  userId: number
): Promise<{ success: boolean; error?: string; tableConfig?: any }> {
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM scheduled_tables WHERE id = $1', [id])).rows[0] as any;
  if (!row) return { success: false, error: 'Scheduled table not found' };

  const role = await getMemberRole(row.clubid, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can activate scheduled tables' };
  }

  await pool.query('UPDATE scheduled_tables SET status = $1 WHERE id = $2', ['active', id]);

  return { success: true, tableConfig: JSON.parse(row.tableconfig || '{}') };
}

export async function deleteScheduledTable(
  id: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM scheduled_tables WHERE id = $1', [id])).rows[0] as any;
  if (!row) return { success: false, error: 'Scheduled table not found' };

  const role = await getMemberRole(row.clubid, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can delete scheduled tables' };
  }

  await pool.query('DELETE FROM scheduled_tables WHERE id = $1', [id]);
  return { success: true };
}

// ========== Custom Blind Structures ==========

export async function createBlindStructure(
  clubId: number,
  managerId: number,
  name: string,
  levels: BlindLevel[]
): Promise<{ success: boolean; error?: string; structure?: BlindStructure }> {
  const role = await getMemberRole(clubId, managerId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can create blind structures' };
  }
  if (!name || name.trim().length < 2) {
    return { success: false, error: 'Name must be at least 2 characters' };
  }
  if (!levels || levels.length === 0) {
    return { success: false, error: 'At least one blind level is required' };
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      'INSERT INTO blind_structures (clubId, name, levels, createdBy) VALUES ($1, $2, $3, $4) RETURNING id',
      [clubId, name.trim(), JSON.stringify(levels), managerId]
    );

    const structure: BlindStructure = {
      id: result.rows[0].id as number,
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

export async function getBlindStructures(
  clubId: number
): Promise<{ success: boolean; error?: string; structures?: BlindStructure[] }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM blind_structures WHERE clubId = $1 ORDER BY id DESC',
    [clubId]
  )).rows as any[];

  const structures: BlindStructure[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    name: r.name,
    levels: JSON.parse(r.levels || '[]'),
    createdBy: r.createdby,
  }));

  return { success: true, structures };
}

export async function deleteBlindStructure(
  id: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM blind_structures WHERE id = $1', [id])).rows[0] as any;
  if (!row) return { success: false, error: 'Blind structure not found' };

  const role = await getMemberRole(row.clubid, userId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can delete blind structures' };
  }

  await pool.query('DELETE FROM blind_structures WHERE id = $1', [id]);
  return { success: true };
}

// ═══════════════════════════════════════════
// Feature 10: Club Invitations
// ═══════════════════════════════════════════

async function getUserIdByUsername(username: string): Promise<number | null> {
  const pool = getPool();
  const row = (await pool.query(
    'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
    [(username || '').trim()]
  )).rows[0] as { id: number } | undefined;
  return row?.id || null;
}

export async function inviteToClub(
  clubId: number,
  inviterId: number,
  inviterName: string,
  invitedUsername: string
): Promise<{ success: boolean; error?: string; invitation?: ClubInvitation }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };

  const role = await getMemberRole(clubId, inviterId);
  if (!role || (role !== 'owner' && role !== 'manager')) {
    return { success: false, error: 'Only owners and managers can invite players' };
  }

  const invitedUserId = await getUserIdByUsername(invitedUsername);
  if (!invitedUserId) {
    return { success: false, error: 'User not found' };
  }

  if (await isClubMember(clubId, invitedUserId)) {
    return { success: false, error: 'User is already a member of this club' };
  }

  const pool = getPool();
  const existing = (await pool.query(
    'SELECT id FROM club_invitations WHERE clubId = $1 AND invitedUsername = $2 AND status = $3',
    [clubId, invitedUsername, 'pending']
  )).rows[0] as any;
  if (existing) {
    return { success: false, error: 'An invitation is already pending for this user' };
  }

  try {
    const result = await pool.query(
      'INSERT INTO club_invitations (clubId, clubName, inviterId, inviterName, invitedUsername, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [clubId, club.name, inviterId, inviterName, invitedUsername, 'pending']
    );

    return {
      success: true,
      invitation: {
        id: result.rows[0].id as number,
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

export async function getMyInvitations(
  userId: number
): Promise<{ success: boolean; invitations: ClubInvitation[] }> {
  const pool = getPool();
  const username = await getUsername(userId);
  const rows = (await pool.query(
    'SELECT * FROM club_invitations WHERE invitedUsername = $1 AND status = $2 ORDER BY createdAt DESC',
    [username, 'pending']
  )).rows as any[];

  const invitations: ClubInvitation[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    clubName: r.clubname,
    inviterId: r.inviterid,
    inviterName: r.invitername,
    invitedUsername: r.invitedusername,
    status: r.status,
    createdAt: r.createdat,
  }));

  return { success: true, invitations };
}

export async function acceptInvitation(
  invitationId: number,
  userId: number
): Promise<{ success: boolean; error?: string; club?: ClubInfo }> {
  const pool = getPool();
  const username = await getUsername(userId);
  const inv = (await pool.query('SELECT * FROM club_invitations WHERE id = $1 AND invitedUsername = $2 AND status = $3', [invitationId, username, 'pending'])).rows[0] as any;
  if (!inv) return { success: false, error: 'Invitation not found or already handled' };

  const club = await getClubById(inv.clubid);
  if (!club) return { success: false, error: 'Club no longer exists' };

  if (await isClubMember(inv.clubid, userId)) {
    await pool.query('UPDATE club_invitations SET status = $1 WHERE id = $2', ['accepted', invitationId]);
    return { success: false, error: 'You are already a member of this club' };
  }

  try {
    await pool.query(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES ($1, $2, $3, $4)',
      [inv.clubid, userId, 'member', 'active']
    );
    await pool.query('UPDATE club_invitations SET status = $1 WHERE id = $2', ['accepted', invitationId]);

    const memberCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [inv.clubid, 'active'])).rows[0] as any).cnt;
    const rawRow = (await pool.query('SELECT badge, clubXp, clubLevel FROM clubs WHERE id = $1', [inv.clubid])).rows[0] as any;

    return {
      success: true,
      club: {
        id: club.id,
        clubCode: club.clubCode,
        name: club.name,
        description: club.description,
        ownerId: club.ownerId,
        ownerName: await getUsername(club.ownerId),
        settings: club.settings,
        memberCount,
        createdAt: club.createdAt,
        badge: rawRow?.badge || '♠',
        clubLevel: rawRow?.clublevel || 1,
        clubXp: rawRow?.clubxp || 0,
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Accept invitation error:', err);
    return { success: false, error: 'Failed to accept invitation' };
  }
}

export async function declineInvitation(
  invitationId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const username = await getUsername(userId);
  const result = await pool.query('UPDATE club_invitations SET status = $1 WHERE id = $2 AND invitedUsername = $3 AND status = $4', ['declined', invitationId, username, 'pending']);
  if (result.rowCount === 0) {
    return { success: false, error: 'Invitation not found or already handled' };
  }
  return { success: true };
}

export async function getClubInvitations(
  clubId: number
): Promise<{ success: boolean; invitations: ClubInvitation[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    'SELECT * FROM club_invitations WHERE clubId = $1 ORDER BY createdAt DESC LIMIT 50',
    [clubId]
  )).rows as any[];

  const invitations: ClubInvitation[] = rows.map((r) => ({
    id: r.id,
    clubId: r.clubid,
    clubName: r.clubname,
    inviterId: r.inviterid,
    inviterName: r.invitername,
    invitedUsername: r.invitedusername,
    status: r.status,
    createdAt: r.createdat,
  }));

  return { success: true, invitations };
}

// ═══════════════════════════════════════════
// Feature 11: Club Unions (Alliance System)
// ═══════════════════════════════════════════

export async function createUnion(
  clubId: number,
  userId: number,
  name: string,
  description: string
): Promise<{ success: boolean; error?: string; union?: ClubUnion }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== userId) {
    return { success: false, error: 'Only the club owner can create a union' };
  }
  if (!name || name.trim().length < 2) {
    return { success: false, error: 'Union name must be at least 2 characters' };
  }

  const pool = getPool();
  const existing = (await pool.query(
    'SELECT um.id FROM union_members um WHERE um.clubId = $1 AND um.status = $2',
    [clubId, 'active']
  )).rows[0] as any;
  if (existing) {
    return { success: false, error: 'Your club is already in a union' };
  }

  try {
    const result = await pool.query(
      'INSERT INTO club_unions (name, description, leaderClubId) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), description?.trim() || '', clubId]
    );

    const unionId = result.rows[0].id as number;
    await pool.query(
      'INSERT INTO union_members (unionId, clubId, status) VALUES ($1, $2, $3)',
      [unionId, clubId, 'active']
    );

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

export async function inviteToUnion(
  unionId: number,
  inviterClubId: number,
  targetClubId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const union = (await pool.query('SELECT * FROM club_unions WHERE id = $1', [unionId])).rows[0] as any;
  if (!union) return { success: false, error: 'Union not found' };
  if (union.leaderclubid !== inviterClubId) {
    return { success: false, error: 'Only the leader club can invite others' };
  }
  const club = await getClubById(inviterClubId);
  if (!club || club.ownerId !== userId) {
    return { success: false, error: 'Only the club owner can invite to the union' };
  }

  const existing = (await pool.query(
    'SELECT id FROM union_members WHERE unionId = $1 AND clubId = $2',
    [unionId, targetClubId]
  )).rows[0] as any;
  if (existing) {
    return { success: false, error: 'Club is already in or invited to this union' };
  }

  await pool.query('INSERT INTO union_members (unionId, clubId, status) VALUES ($1, $2, $3)', [unionId, targetClubId, 'pending']);
  return { success: true };
}

export async function joinUnion(
  unionId: number,
  clubId: number,
  userId: number
): Promise<{ success: boolean; error?: string }> {
  const club = await getClubById(clubId);
  if (!club || club.ownerId !== userId) {
    return { success: false, error: 'Only the club owner can join a union' };
  }

  const pool = getPool();
  const invite = (await pool.query(
    'SELECT id FROM union_members WHERE unionId = $1 AND clubId = $2 AND status = $3',
    [unionId, clubId, 'pending']
  )).rows[0] as any;
  if (!invite) {
    return { success: false, error: 'No pending union invitation found' };
  }

  await pool.query('UPDATE union_members SET status = $1 WHERE unionId = $2 AND clubId = $3', ['active', unionId, clubId]);
  return { success: true };
}

export async function getUnionInfo(
  clubId: number
): Promise<{ success: boolean; union?: ClubUnion & { clubs: { clubId: number; clubName: string; memberCount: number; badge: string }[] } }> {
  const pool = getPool();
  const membership = (await pool.query(
    'SELECT unionId FROM union_members WHERE clubId = $1 AND status = $2',
    [clubId, 'active']
  )).rows[0] as any;
  if (!membership) {
    return { success: true };
  }

  const union = (await pool.query('SELECT * FROM club_unions WHERE id = $1', [membership.unionid])).rows[0] as any;
  if (!union) return { success: true };

  const members = (await pool.query(
    `SELECT um.clubId, c.name as clubName, c.badge,
      (SELECT COUNT(*)::int FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount
     FROM union_members um
     JOIN clubs c ON um.clubId = c.id
     WHERE um.unionId = $1 AND um.status = $2
     ORDER BY um.joinedAt ASC`,
    [union.id, 'active']
  )).rows as any[];

  return {
    success: true,
    union: {
      id: union.id,
      name: union.name,
      description: union.description,
      leaderClubId: union.leaderclubid,
      createdAt: union.createdat,
      clubs: members.map((m: any) => ({
        clubId: m.clubid,
        clubName: m.clubname,
        memberCount: m.membercount,
        badge: m.badge || '♠',
      })),
    },
  };
}

// ═══════════════════════════════════════════
// Feature 12: Member Profiles
// ═══════════════════════════════════════════

export async function getMemberProfile(
  clubId: number,
  targetUserId: number
): Promise<{ success: boolean; error?: string; profile?: MemberProfile }> {
  const pool = getPool();
  const member = (await pool.query(
    'SELECT cm.role, cm.joinedAt, COALESCE(u.display_name, u.username) AS username FROM club_members cm LEFT JOIN users u ON cm.userId = u.id WHERE cm.clubId = $1 AND cm.userId = $2 AND cm.status = $3',
    [clubId, targetUserId, 'active']
  )).rows[0] as any;
  if (!member) return { success: false, error: 'Member not found' };

  const stats = (await pool.query(
    'SELECT handsPlayed, chipsWon, chipsLost, biggestPot FROM club_stats WHERE clubId = $1 AND userId = $2',
    [clubId, targetUserId]
  )).rows[0] as any;

  const handsPlayed = stats?.handsplayed || 0;
  const chipsWon = stats?.chipswon || 0;
  const chipsLost = stats?.chipslost || 0;
  const winRate = handsPlayed > 0 ? Math.round((chipsWon / (chipsWon + chipsLost || 1)) * 100) : 0;

  return {
    success: true,
    profile: {
      username: member.username || 'Unknown',
      role: member.role,
      joinedAt: member.joinedat,
      handsPlayed,
      chipsWon,
      chipsLost,
      biggestPot: stats?.biggestpot || 0,
      winRate,
    },
  };
}

// ═══════════════════════════════════════════
// Feature 13: Club Badges/Logos
// ═══════════════════════════════════════════

export async function updateClubBadge(
  clubId: number,
  ownerId: number,
  badge: string
): Promise<{ success: boolean; error?: string }> {
  const club = await getClubById(clubId);
  if (!club) return { success: false, error: 'Club not found' };
  if (club.ownerId !== ownerId) {
    return { success: false, error: 'Only the club owner can change the badge' };
  }

  const pool = getPool();
  await pool.query('UPDATE clubs SET badge = $1 WHERE id = $2', [badge, clubId]);
  return { success: true };
}

// ═══════════════════════════════════════════
// Feature 14: Referral Rewards
// ═══════════════════════════════════════════

export async function generateReferralCode(
  clubId: number,
  userId: number
): Promise<{ success: boolean; error?: string; referralCode?: string }> {
  if (!(await isClubMember(clubId, userId))) {
    return { success: false, error: 'You are not a member of this club' };
  }

  const pool = getPool();
  const existing = (await pool.query(
    'SELECT referral_code FROM club_members WHERE clubId = $1 AND userId = $2',
    [clubId, userId]
  )).rows[0] as any;

  if (existing?.referral_code) {
    return { success: true, referralCode: existing.referral_code };
  }

  const code = `REF-${clubId}-${userId}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  await pool.query('UPDATE club_members SET referral_code = $1 WHERE clubId = $2 AND userId = $3', [code, clubId, userId]);

  return { success: true, referralCode: code };
}

export async function joinByReferral(
  referralCode: string,
  userId: number
): Promise<{ success: boolean; error?: string; club?: ClubInfo; bonusChips?: number }> {
  const pool = getPool();
  const referrer = (await pool.query(
    'SELECT cm.clubId, cm.userId as referrerId FROM club_members cm WHERE cm.referral_code = $1',
    [referralCode]
  )).rows[0] as any;

  if (!referrer) {
    return { success: false, error: 'Invalid referral code' };
  }

  const club = await getClubById(referrer.clubid);
  if (!club) return { success: false, error: 'Club not found' };

  if (await isClubMember(referrer.clubid, userId)) {
    return { success: false, error: 'You are already a member of this club' };
  }

  const memberCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [referrer.clubid, 'active'])).rows[0] as any).cnt;
  if (memberCount >= club.settings.maxMembers) {
    return { success: false, error: 'This club is full' };
  }

  try {
    await pool.query(
      'INSERT INTO club_members (clubId, userId, role, status) VALUES ($1, $2, $3, $4)',
      [referrer.clubid, userId, 'member', 'active']
    );

    const referrerName = await getUsername(referrer.referrerid);
    const newMemberName = await getUsername(userId);

    await pool.query(
      `INSERT INTO club_stats (clubId, userId, username, chipsWon) VALUES ($1, $2, $3, 500)
       ON CONFLICT (clubId, userId) DO UPDATE SET chipsWon = club_stats.chipsWon + 500, updatedAt = now()`,
      [referrer.clubid, referrer.referrerid, referrerName]
    );

    await pool.query(
      `INSERT INTO club_stats (clubId, userId, username, chipsWon) VALUES ($1, $2, $3, 500)
       ON CONFLICT (clubId, userId) DO UPDATE SET chipsWon = club_stats.chipsWon + 500, updatedAt = now()`,
      [referrer.clubid, userId, newMemberName]
    );

    const newCount = ((await pool.query('SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2', [referrer.clubid, 'active'])).rows[0] as any).cnt;
    const rawRow = (await pool.query('SELECT badge, clubXp, clubLevel FROM clubs WHERE id = $1', [referrer.clubid])).rows[0] as any;

    return {
      success: true,
      bonusChips: 500,
      club: {
        id: club.id,
        clubCode: club.clubCode,
        name: club.name,
        description: club.description,
        ownerId: club.ownerId,
        ownerName: await getUsername(club.ownerId),
        settings: club.settings,
        memberCount: newCount,
        createdAt: club.createdAt,
        badge: rawRow?.badge || '♠',
        clubLevel: rawRow?.clublevel || 1,
        clubXp: rawRow?.clubxp || 0,
      },
    };
  } catch (err: any) {
    console.error('[Clubs] Referral join error:', err);
    return { success: false, error: 'Failed to join club via referral' };
  }
}

export async function getReferralStats(
  clubId: number,
  userId: number
): Promise<{ success: boolean; referralCode?: string; referralCount: number; chipsEarned: number }> {
  const pool = getPool();
  const member = (await pool.query(
    'SELECT referral_code FROM club_members WHERE clubId = $1 AND userId = $2',
    [clubId, userId]
  )).rows[0] as any;

  if (!member?.referral_code) {
    return { success: true, referralCount: 0, chipsEarned: 0 };
  }

  const stats = (await pool.query(
    'SELECT chipsWon FROM club_stats WHERE clubId = $1 AND userId = $2',
    [clubId, userId]
  )).rows[0] as any;

  return {
    success: true,
    referralCode: member.referral_code,
    referralCount: 0,
    chipsEarned: stats?.chipswon || 0,
  };
}

// ═══════════════════════════════════════════
// Feature 15: Club Levels
// ═══════════════════════════════════════════

export async function addClubXp(
  clubId: number,
  amount: number
): Promise<{ success: boolean; newLevel?: number; newXp?: number; leveledUp?: boolean }> {
  const pool = getPool();
  const club = (await pool.query('SELECT clubXp, clubLevel FROM clubs WHERE id = $1', [clubId])).rows[0] as any;
  if (!club) return { success: false };

  const currentXp = (club.clubxp || 0) + amount;
  let currentLevel = club.clublevel || 1;
  let leveledUp = false;

  while (currentLevel < 20 && currentXp >= CLUB_LEVEL_THRESHOLDS[currentLevel]) {
    currentLevel++;
    leveledUp = true;
  }

  await pool.query('UPDATE clubs SET clubXp = $1, clubLevel = $2 WHERE id = $3', [currentXp, currentLevel, clubId]);

  return { success: true, newLevel: currentLevel, newXp: currentXp, leveledUp };
}

export async function getClubLevel(
  clubId: number
): Promise<{ success: boolean; level: number; xp: number; nextLevelXp: number; perks: { level: number; perk: string; unlocked: boolean }[] }> {
  const pool = getPool();
  const club = (await pool.query('SELECT clubXp, clubLevel FROM clubs WHERE id = $1', [clubId])).rows[0] as any;
  const level = club?.clublevel || 1;
  const xp = club?.clubxp || 0;
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

export async function getFeaturedClubs(): Promise<{ success: boolean; clubs: ClubInfo[] }> {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT c.*,
      (SELECT COUNT(*)::int FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount,
      (SELECT COALESCE(SUM(handsPlayed), 0)::int FROM club_stats WHERE clubId = c.id) as totalHands
     FROM clubs c
     WHERE (c.settings::jsonb ->> 'isPrivate') = 'false'
     ORDER BY memberCount DESC, totalHands DESC
     LIMIT 10`
  )).rows as any[];

  const clubs: ClubInfo[] = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    clubCode: r.clubcode,
    name: r.name,
    description: r.description,
    ownerId: r.ownerid,
    ownerName: await getUsername(r.ownerid),
    settings: JSON.parse(r.settings || '{}'),
    memberCount: r.membercount,
    createdAt: r.createdat,
    badge: r.badge || '♠',
    clubLevel: r.clublevel || 1,
    clubXp: r.clubxp || 0,
  })));

  return { success: true, clubs };
}

export async function getClubOfWeek(): Promise<{ success: boolean; club?: ClubInfo }> {
  const pool = getPool();
  const row = (await pool.query(
    `SELECT c.*,
      (SELECT COUNT(*)::int FROM club_members WHERE clubId = c.id AND status = 'active') as memberCount,
      (SELECT COALESCE(SUM(handsPlayed), 0)::int FROM club_stats WHERE clubId = c.id AND updatedAt >= now() - interval '7 days') as weeklyHands
     FROM clubs c
     WHERE (c.settings::jsonb ->> 'isPrivate') = 'false'
     ORDER BY weeklyHands DESC, memberCount DESC
     LIMIT 1`
  )).rows[0] as any;

  if (!row) return { success: true };

  return {
    success: true,
    club: {
      id: row.id,
      clubCode: row.clubcode,
      name: row.name,
      description: row.description,
      ownerId: row.ownerid,
      ownerName: await getUsername(row.ownerid),
      settings: JSON.parse(row.settings || '{}'),
      memberCount: row.membercount,
      createdAt: row.createdat,
      badge: row.badge || '♠',
      clubLevel: row.clublevel || 1,
      clubXp: row.clubxp || 0,
    },
  };
}

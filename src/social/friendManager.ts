// Friend system — DURABLE (Postgres via authManager pool), unlike the
// ephemeral better-sqlite3 club store. A friendship is one row with a
// canonical (lo,hi) user-id pair so (A,B) and (B,A) can't both exist;
// `requested_by` + `status` model the pending→accepted handshake.
//
// 2026-06-18 — Phase 3a of the .online remediation (build the mock features
// for real). Client: components/ui/FriendSystem.jsx.
import { getPool } from '../auth/authManager';

export interface FriendRow {
  userId: number;
  username: string;
  status: 'pending_in' | 'pending_out' | 'accepted';
}

function pair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export async function initFriendTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id          SERIAL PRIMARY KEY,
      user_lo     INTEGER NOT NULL,
      user_hi     INTEGER NOT NULL,
      requested_by INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted'
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT friendships_pair_uniq UNIQUE (user_lo, user_hi),
      CONSTRAINT friendships_pair_order CHECK (user_lo < user_hi)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS friendships_lo_idx ON friendships(user_lo)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS friendships_hi_idx ON friendships(user_hi)`);
}

// Send (or auto-accept) a friend request. If the other side already
// requested us, this accepts it. Returns the resulting status.
export async function sendFriendRequest(fromId: number, toId: number): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (!fromId || !toId || fromId === toId) return { ok: false, error: 'Invalid user' };
  const pool = getPool();
  const [lo, hi] = pair(fromId, toId);
  const existing = await pool.query('SELECT status, requested_by FROM friendships WHERE user_lo=$1 AND user_hi=$2', [lo, hi]);
  if (existing.rows.length) {
    const row = existing.rows[0];
    if (row.status === 'accepted') return { ok: true, status: 'accepted' };
    // pending: if the OTHER person requested, accept it; else it's a dup
    if (row.requested_by !== fromId) {
      await pool.query("UPDATE friendships SET status='accepted', updated_at=now() WHERE user_lo=$1 AND user_hi=$2", [lo, hi]);
      return { ok: true, status: 'accepted' };
    }
    return { ok: true, status: 'pending' };
  }
  await pool.query(
    "INSERT INTO friendships (user_lo, user_hi, requested_by, status) VALUES ($1,$2,$3,'pending')",
    [lo, hi, fromId]
  );
  return { ok: true, status: 'pending' };
}

export async function acceptFriendRequest(userId: number, otherId: number): Promise<{ ok: boolean; error?: string }> {
  const pool = getPool();
  const [lo, hi] = pair(userId, otherId);
  // Only the addressee (not the requester) may accept.
  const r = await pool.query(
    "UPDATE friendships SET status='accepted', updated_at=now() WHERE user_lo=$1 AND user_hi=$2 AND status='pending' AND requested_by<>$3",
    [lo, hi, userId]
  );
  return r.rowCount ? { ok: true } : { ok: false, error: 'No pending request' };
}

export async function removeFriend(userId: number, otherId: number): Promise<{ ok: boolean }> {
  const pool = getPool();
  const [lo, hi] = pair(userId, otherId);
  await pool.query('DELETE FROM friendships WHERE user_lo=$1 AND user_hi=$2', [lo, hi]);
  return { ok: true };
}

// All relationships for a user, with the other party's username and a
// per-viewer status (pending_in = they need to accept; pending_out = waiting).
export async function listFriends(userId: number): Promise<FriendRow[]> {
  if (!userId) return [];
  const pool = getPool();
  const r = await pool.query(
    `SELECT f.user_lo, f.user_hi, f.requested_by, f.status,
            u.id AS other_id, u.username AS other_name
       FROM friendships f
       JOIN users u ON u.id = (CASE WHEN f.user_lo=$1 THEN f.user_hi ELSE f.user_lo END)
      WHERE f.user_lo=$1 OR f.user_hi=$1
      ORDER BY f.status DESC, u.username ASC`,
    [userId]
  );
  return r.rows.map((row: any) => {
    let status: FriendRow['status'];
    if (row.status === 'accepted') status = 'accepted';
    else status = row.requested_by === userId ? 'pending_out' : 'pending_in';
    return { userId: row.other_id, username: row.other_name, status };
  });
}

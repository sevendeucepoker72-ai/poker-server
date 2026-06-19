// Social Bracket tournaments — DURABLE (Postgres) + LIVE (socket room per
// bracket). Replaces the local-state mock in components/ui/SocialBracket.jsx
// where eliminations/side-bets lived only in one browser and the share link
// pointed at nothing.
//
// An organizer creates a bracket (named, themed, a roster of player names),
// shares `?bracket=<id>`, and anyone who opens it joins the live view. The
// organizer (created_by) eliminates players; everyone in the room sees the
// bracket update in real time. Side bets are social tallies (who called whom
// to win) synced to the room — NOT wired to any chip pool in v1.
//
// 2026-06-18 — Phase 3d of the .online remediation.
import { getPool } from '../auth/authManager';

export interface BracketPlayer { name: string; seed: number; out: boolean; outOrder: number | null; }
export interface BracketSideBet { bettor: string; target: string; amount: number; }
export interface BracketState {
  bracketId: string;
  name: string;
  theme: string;
  status: 'active' | 'complete';
  createdBy: number;
  players: BracketPlayer[];
  sideBets: BracketSideBet[];
}

export async function initBracketTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_brackets (
      bracket_id TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      theme      TEXT NOT NULL DEFAULT 'neon',
      created_by INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active', -- 'active' | 'complete'
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_bracket_players (
      id         SERIAL PRIMARY KEY,
      bracket_id TEXT NOT NULL REFERENCES social_brackets(bracket_id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      seed       INTEGER NOT NULL,
      is_out     BOOLEAN NOT NULL DEFAULT false,
      out_order  INTEGER,
      CONSTRAINT social_bracket_players_uniq UNIQUE (bracket_id, name)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS social_bracket_players_bid_idx ON social_bracket_players(bracket_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_bracket_sidebets (
      id          SERIAL PRIMARY KEY,
      bracket_id  TEXT NOT NULL REFERENCES social_brackets(bracket_id) ON DELETE CASCADE,
      bettor_name TEXT NOT NULL,
      target_name TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS social_bracket_sidebets_bid_idx ON social_bracket_sidebets(bracket_id)`);
}

export async function getBracket(bracketId: string): Promise<BracketState | null> {
  if (!bracketId) return null;
  const pool = getPool();
  const b = await pool.query('SELECT bracket_id, name, theme, created_by, status FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return null;
  const row = b.rows[0];
  const pl = await pool.query('SELECT name, seed, is_out, out_order FROM social_bracket_players WHERE bracket_id=$1 ORDER BY seed ASC', [bracketId]);
  const sb = await pool.query('SELECT bettor_name, target_name, amount FROM social_bracket_sidebets WHERE bracket_id=$1 ORDER BY created_at ASC', [bracketId]);
  return {
    bracketId: row.bracket_id,
    name: row.name,
    theme: row.theme,
    status: row.status,
    createdBy: row.created_by,
    players: pl.rows.map((p: any) => ({ name: p.name, seed: p.seed, out: p.is_out, outOrder: p.out_order })),
    sideBets: sb.rows.map((s: any) => ({ bettor: s.bettor_name, target: s.target_name, amount: s.amount })),
  };
}

export async function createBracket(
  creatorId: number,
  bracketId: string,
  name: string,
  theme: string,
  players: string[]
): Promise<{ ok: boolean; error?: string; state?: BracketState }> {
  if (!creatorId) return { ok: false, error: 'Not signed in' };
  const id = String(bracketId || '').trim().toUpperCase().slice(0, 16);
  if (!/^[A-Z0-9]{4,16}$/.test(id)) return { ok: false, error: 'Bad bracket id' };
  const roster = (players || []).map((p) => String(p).trim()).filter(Boolean).slice(0, 64);
  if (roster.length < 2) return { ok: false, error: 'Need at least 2 players' };
  // De-dup names (the unique constraint would otherwise reject the batch).
  const seen = new Set<string>();
  const unique = roster.filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  const pool = getPool();
  const ins = await pool.query(
    `INSERT INTO social_brackets (bracket_id, name, theme, created_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT (bracket_id) DO NOTHING`,
    [id, String(name || 'Bracket').slice(0, 80), String(theme || 'neon').slice(0, 24), creatorId]
  );
  if (!ins.rowCount) return { ok: false, error: 'Bracket id already exists' };
  for (let i = 0; i < unique.length; i++) {
    await pool.query(
      'INSERT INTO social_bracket_players (bracket_id, name, seed) VALUES ($1,$2,$3)',
      [id, unique[i].slice(0, 40), i + 1]
    );
  }
  const state = await getBracket(id);
  return { ok: true, state: state! };
}

export async function eliminatePlayer(
  bracketId: string,
  requesterId: number,
  playerName: string
): Promise<{ ok: boolean; error?: string; state?: BracketState }> {
  const pool = getPool();
  const b = await pool.query('SELECT created_by, status FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return { ok: false, error: 'Bracket not found' };
  if (b.rows[0].created_by !== requesterId) return { ok: false, error: 'Only the organizer can eliminate' };
  if (b.rows[0].status === 'complete') return { ok: false, error: 'Tournament already finished' };

  const outCount = await pool.query("SELECT COUNT(*)::int AS c FROM social_bracket_players WHERE bracket_id=$1 AND is_out=true", [bracketId]);
  const order = (outCount.rows[0]?.c ?? 0) + 1;
  const upd = await pool.query(
    'UPDATE social_bracket_players SET is_out=true, out_order=$3 WHERE bracket_id=$1 AND name=$2 AND is_out=false',
    [bracketId, playerName, order]
  );
  if (!upd.rowCount) return { ok: false, error: 'Player not active' };

  // If only one player remains active, the tournament is complete.
  const active = await pool.query("SELECT COUNT(*)::int AS c FROM social_bracket_players WHERE bracket_id=$1 AND is_out=false", [bracketId]);
  if ((active.rows[0]?.c ?? 0) <= 1) {
    await pool.query("UPDATE social_brackets SET status='complete' WHERE bracket_id=$1", [bracketId]);
  }
  const state = await getBracket(bracketId);
  return { ok: true, state: state! };
}

export async function addSideBet(
  bracketId: string,
  bettorName: string,
  targetName: string,
  amount: number
): Promise<{ ok: boolean; error?: string; state?: BracketState }> {
  const pool = getPool();
  const b = await pool.query('SELECT 1 FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return { ok: false, error: 'Bracket not found' };
  const amt = Math.max(1, Math.min(1_000_000, Math.floor(Number(amount) || 0)));
  const target = await pool.query('SELECT 1 FROM social_bracket_players WHERE bracket_id=$1 AND name=$2', [bracketId, targetName]);
  if (!target.rows.length) return { ok: false, error: 'No such player' };
  await pool.query(
    'INSERT INTO social_bracket_sidebets (bracket_id, bettor_name, target_name, amount) VALUES ($1,$2,$3,$4)',
    [bracketId, String(bettorName || 'Guest').slice(0, 40), String(targetName).slice(0, 40), amt]
  );
  const state = await getBracket(bracketId);
  return { ok: true, state: state! };
}

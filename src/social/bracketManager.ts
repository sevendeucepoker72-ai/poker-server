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
import { getPool, addChipsToUser } from '../auth/authManager';

export interface BracketPlayer { name: string; seed: number; out: boolean; outOrder: number | null; }
export interface BracketSideBet { bettor: string; target: string; amount: number; settled?: boolean; payout?: number }
export interface BracketState {
  bracketId: string;
  name: string;
  theme: string;
  status: 'active' | 'complete';
  createdBy: number;
  players: BracketPlayer[];
  sideBets: BracketSideBet[];
  sidebetsSettled?: boolean;
}
// 2026-07-07 gap-fill [24] — a single escrow/payout movement returned by
// settle/refund so the caller (index.ts) can auditLog + notify each one.
export interface BracketChipMovement { userId: number; amount: number; reason: 'sidebet_win' | 'sidebet_refund'; target?: string }

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
  // 2026-07-07 gap-fill [24] — real chip-escrowed side bets. bettor_user_id ties
  // a bet to a wallet (only escrowed bets carry it; old display-only rows stay
  // NULL and are never settled). settled/payout are settlement bookkeeping;
  // sidebets_settled on the bracket makes settlement idempotent (runs once).
  await pool.query(`ALTER TABLE social_bracket_sidebets ADD COLUMN IF NOT EXISTS bettor_user_id INTEGER`).catch((e: any) => console.warn('[Bracket] sidebet bettor_user_id:', e.message));
  await pool.query(`ALTER TABLE social_bracket_sidebets ADD COLUMN IF NOT EXISTS settled BOOLEAN NOT NULL DEFAULT FALSE`).catch((e: any) => console.warn('[Bracket] sidebet settled:', e.message));
  await pool.query(`ALTER TABLE social_bracket_sidebets ADD COLUMN IF NOT EXISTS payout INTEGER NOT NULL DEFAULT 0`).catch((e: any) => console.warn('[Bracket] sidebet payout:', e.message));
  await pool.query(`ALTER TABLE social_brackets ADD COLUMN IF NOT EXISTS sidebets_settled BOOLEAN NOT NULL DEFAULT FALSE`).catch((e: any) => console.warn('[Bracket] sidebets_settled:', e.message));
}

export async function getBracket(bracketId: string): Promise<BracketState | null> {
  if (!bracketId) return null;
  const pool = getPool();
  const b = await pool.query('SELECT bracket_id, name, theme, created_by, status, sidebets_settled FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return null;
  const row = b.rows[0];
  const pl = await pool.query('SELECT name, seed, is_out, out_order FROM social_bracket_players WHERE bracket_id=$1 ORDER BY seed ASC', [bracketId]);
  const sb = await pool.query('SELECT bettor_name, target_name, amount, settled, payout FROM social_bracket_sidebets WHERE bracket_id=$1 ORDER BY created_at ASC', [bracketId]);
  return {
    bracketId: row.bracket_id,
    name: row.name,
    theme: row.theme,
    status: row.status,
    createdBy: row.created_by,
    sidebetsSettled: !!row.sidebets_settled,
    players: pl.rows.map((p: any) => ({ name: p.name, seed: p.seed, out: p.is_out, outOrder: p.out_order })),
    sideBets: sb.rows.map((s: any) => ({ bettor: s.bettor_name, target: s.target_name, amount: s.amount, settled: !!s.settled, payout: s.payout || 0 })),
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

// 2026-07-07 gap-fill [24] — records a side bet. The chip ESCROW (deductChips)
// happens in the index.ts handler BEFORE this call; here we just persist the row
// (with the escrowing user's id so settlement can credit the right wallet). The
// clamped `amt` returned lets the caller escrow the exact amount stored. Rejects
// bets on an already-eliminated player or a completed bracket (can't escrow into
// a decided outcome).
export async function addSideBet(
  bracketId: string,
  bettorName: string,
  targetName: string,
  amount: number,
  bettorUserId?: number
): Promise<{ ok: boolean; error?: string; state?: BracketState; amount?: number }> {
  const pool = getPool();
  const b = await pool.query('SELECT status FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return { ok: false, error: 'Bracket not found' };
  if (b.rows[0].status === 'complete') return { ok: false, error: 'Tournament already finished' };
  const amt = Math.max(1, Math.min(1_000_000, Math.floor(Number(amount) || 0)));
  const target = await pool.query('SELECT is_out FROM social_bracket_players WHERE bracket_id=$1 AND name=$2', [bracketId, targetName]);
  if (!target.rows.length) return { ok: false, error: 'No such player' };
  if (target.rows[0].is_out) return { ok: false, error: 'That player is already out' };
  await pool.query(
    'INSERT INTO social_bracket_sidebets (bracket_id, bettor_name, target_name, amount, bettor_user_id) VALUES ($1,$2,$3,$4,$5)',
    [bracketId, String(bettorName || 'Guest').slice(0, 40), String(targetName).slice(0, 40), amt, bettorUserId ?? null]
  );
  const state = await getBracket(bracketId);
  return { ok: true, state: state!, amount: amt };
}

// 2026-07-07 gap-fill [24] — PARIMUTUEL settlement. Called when a bracket
// completes (one player left = champion). Winners = bettors on the champion; the
// ENTIRE escrowed pool is split among them PROPORTIONAL to their stake (winners
// also get their own stake back — that's how parimutuel works). If nobody backed
// the champion, every escrowed bettor is REFUNDED their stake (chips are never
// destroyed — user-data-must-persist). Chip-conserving: Σpayouts == Σescrowed
// (any floor-division dust is handed to the largest winner). Idempotent via
// social_brackets.sidebets_settled — a re-run can never double-pay. Only rows
// with a bettor_user_id (i.e. actually escrowed) are ever paid.
export async function settleBracketSideBets(bracketId: string): Promise<BracketChipMovement[]> {
  const pool = getPool();
  // Atomic idempotency claim: flip sidebets_settled false->true; if no row comes
  // back, another call already settled this bracket.
  const claim = await pool.query(
    `UPDATE social_brackets SET sidebets_settled=TRUE WHERE bracket_id=$1 AND status='complete' AND sidebets_settled=FALSE RETURNING bracket_id`,
    [bracketId]
  );
  if (!claim.rowCount) return [];

  const champRow = await pool.query(`SELECT name FROM social_bracket_players WHERE bracket_id=$1 AND is_out=FALSE ORDER BY seed ASC LIMIT 1`, [bracketId]);
  const champion = champRow.rows[0]?.name as string | undefined;
  // Only escrowed bets (bettor_user_id NOT NULL, unsettled) participate.
  const bets = (await pool.query(
    `SELECT id, bettor_user_id, target_name, amount FROM social_bracket_sidebets WHERE bracket_id=$1 AND settled=FALSE AND bettor_user_id IS NOT NULL`,
    [bracketId]
  )).rows as any[];
  if (bets.length === 0) return [];

  const totalPool = bets.reduce((s, b) => s + (b.amount || 0), 0);
  const winners = champion ? bets.filter((b) => b.target_name === champion) : [];
  const winnerStake = winners.reduce((s, b) => s + (b.amount || 0), 0);
  const movements: BracketChipMovement[] = [];

  if (winners.length > 0 && winnerStake > 0) {
    // Parimutuel proportional split of the WHOLE pool among champion backers.
    let distributed = 0;
    // Largest stake first so the dust remainder lands on the biggest winner.
    winners.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    for (let i = 0; i < winners.length; i++) {
      const w = winners[i];
      let payout = Math.floor((w.amount / winnerStake) * totalPool);
      if (i === 0) payout += totalPool - winners.reduce((s, x) => s + Math.floor((x.amount / winnerStake) * totalPool), 0); // dust → top winner
      distributed += payout;
      await pool.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=$2 WHERE id=$1', [w.id, payout]);
      if (payout > 0) {
        await addChipsToUser(w.bettor_user_id, payout);
        movements.push({ userId: w.bettor_user_id, amount: payout, reason: 'sidebet_win', target: champion });
      }
    }
    // Losing bets: settled with payout 0 (their stake funded the winners' pool).
    for (const b of bets) {
      if (b.target_name !== champion) {
        await pool.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=0 WHERE id=$1', [b.id]);
      }
    }
    void distributed;
  } else {
    // Nobody backed the champion → refund every escrowed bettor their own stake.
    for (const b of bets) {
      await pool.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=$2 WHERE id=$1', [b.id, b.amount]);
      await addChipsToUser(b.bettor_user_id, b.amount);
      movements.push({ userId: b.bettor_user_id, amount: b.amount, reason: 'sidebet_refund' });
    }
  }
  return movements;
}

// 2026-07-07 gap-fill [24] — refund path for an ABANDONED bracket (never
// completed). Returns every escrowed bettor their stake and marks the bracket
// settled so it can't also pay out later. Admin/organizer-invoked.
export async function refundBracketSideBets(bracketId: string): Promise<BracketChipMovement[]> {
  const pool = getPool();
  const claim = await pool.query(
    `UPDATE social_brackets SET sidebets_settled=TRUE WHERE bracket_id=$1 AND sidebets_settled=FALSE RETURNING bracket_id`,
    [bracketId]
  );
  if (!claim.rowCount) return [];
  const bets = (await pool.query(
    `SELECT id, bettor_user_id, amount FROM social_bracket_sidebets WHERE bracket_id=$1 AND settled=FALSE AND bettor_user_id IS NOT NULL`,
    [bracketId]
  )).rows as any[];
  const movements: BracketChipMovement[] = [];
  for (const b of bets) {
    await pool.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=$2 WHERE id=$1', [b.id, b.amount]);
    await addChipsToUser(b.bettor_user_id, b.amount);
    movements.push({ userId: b.bettor_user_id, amount: b.amount, reason: 'sidebet_refund' });
  }
  return movements;
}

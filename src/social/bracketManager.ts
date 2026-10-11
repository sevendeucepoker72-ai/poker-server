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
/**
 * 2026-10-11 (.online R2, ECON-14 / APPUI-43) — who may bet on a bracket and
 * when: never its ORGANIZER (he decides every elimination, so he decides the
 * outcome), never a player IN it (a roster name equal to one of the bettor's
 * names, case-insensitive), and only until the FIRST elimination (after that
 * the field is no longer unknown). A refusal carries a stable `code`.
 */
export async function sideBetRefusal(
  bracketId: string, bettorUserId: number | undefined, bettorNames: string[],
): Promise<{ code: string; error: string } | null> {
  const pool = getPool();
  const b = await pool.query('SELECT status, sidebets_settled, created_by FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return { code: 'bracket_not_found', error: 'Bracket not found' };
  if (b.rows[0].status === 'complete' || b.rows[0].sidebets_settled) return { code: 'bracket_finished', error: 'Tournament already finished' };
  if (bettorUserId !== undefined && Number(b.rows[0].created_by) === bettorUserId) {
    return { code: 'organizer_cannot_bet', error: 'The organizer cannot bet on their own bracket' };
  }
  const names = bettorNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  if (names.length) {
    const inIt = await pool.query('SELECT 1 FROM social_bracket_players WHERE bracket_id=$1 AND LOWER(name) = ANY($2::text[]) LIMIT 1', [bracketId, names]);
    if (inIt.rowCount) return { code: 'player_cannot_bet', error: 'Players in this bracket cannot bet on it' };
  }
  const out = await pool.query('SELECT 1 FROM social_bracket_players WHERE bracket_id=$1 AND is_out=TRUE LIMIT 1', [bracketId]);
  if (out.rowCount) return { code: 'betting_closed', error: 'Betting closed at the first elimination' };
  return null;
}

export async function addSideBet(
  bracketId: string,
  bettorName: string,
  targetName: string,
  amount: number,
  bettorUserId?: number,
  bettorNames: string[] = [],
): Promise<{ ok: boolean; error?: string; code?: string; state?: BracketState; amount?: number }> {
  const pool = getPool();
  const b = await pool.query('SELECT status, sidebets_settled FROM social_brackets WHERE bracket_id=$1', [bracketId]);
  if (!b.rows.length) return { ok: false, error: 'Bracket not found' };
  if (b.rows[0].status === 'complete' || b.rows[0].sidebets_settled) return { ok: false, error: 'Tournament already finished' };
  const amt = Math.max(1, Math.min(1_000_000, Math.floor(Number(amount) || 0)));
  const target = await pool.query('SELECT is_out FROM social_bracket_players WHERE bracket_id=$1 AND name=$2', [bracketId, targetName]);
  if (!target.rows.length) return { ok: false, error: 'No such player' };
  if (target.rows[0].is_out) return { ok: false, error: 'That player is already out' };
  // 2026-07-07 review fix — close the escrow-into-a-just-completed-bracket race.
  // The status/target reads above can be stale (a completing elimination can
  // commit between them and this INSERT), which would strand the escrowed stake
  // because settlement already claimed sidebets_settled. Make the INSERT ITSELF
  // conditional on the bracket still being active+unsettled AND the target still
  // in AT WRITE TIME — a single atomic statement. If the race lost, rowCount is
  // 0 and the caller refunds the escrow.
  // R2 (ECON-14) — the same statement also holds the who/when rules at write
  // time: not the organizer, not a player in the bracket, no one eliminated yet.
  const names = bettorNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  const ins = await pool.query(
    `INSERT INTO social_bracket_sidebets (bracket_id, bettor_name, target_name, amount, bettor_user_id)
     SELECT $1,$2,$3,$4,$5
     WHERE EXISTS (SELECT 1 FROM social_brackets WHERE bracket_id=$1 AND status='active' AND sidebets_settled=FALSE
                     AND ($5::int IS NULL OR created_by <> $5::int))
       AND EXISTS (SELECT 1 FROM social_bracket_players WHERE bracket_id=$1 AND name=$3 AND is_out=FALSE)
       AND NOT EXISTS (SELECT 1 FROM social_bracket_players WHERE bracket_id=$1 AND is_out=TRUE)
       AND NOT EXISTS (SELECT 1 FROM social_bracket_players WHERE bracket_id=$1 AND LOWER(name) = ANY($6::text[]))`,
    [bracketId, String(bettorName || 'Guest').slice(0, 40), String(targetName).slice(0, 40), amt, bettorUserId ?? null, names]
  );
  if (!ins.rowCount) return { ok: false, error: 'Betting on this bracket is closed — bet not placed', code: 'betting_closed' };
  // 2026-07-07 review fix — the bet is now DURABLY recorded. The follow-up state
  // read is BEST-EFFORT: if it throws, addSideBet must NOT throw, because the
  // caller (placeSocialSideBet) would then treat it as "never recorded" and
  // refund the escrow — but the row survives and settles later = a chip mint.
  // Return ok:true even with no state; the caller skips the broadcast and the
  // next getSocialBracket refresh picks it up.
  let state: BracketState | null = null;
  try { state = await getBracket(bracketId); } catch { /* best-effort — bet is already recorded */ }
  return { ok: true, state: state || undefined, amount: amt };
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
  // 2026-07-07 review fix — run the ENTIRE settlement in ONE transaction on a
  // dedicated client. Previously the idempotency claim + each row-mark were
  // separate auto-committed statements that ran BEFORE the chip credit, and
  // addChipsToUser swallows DB errors (returns false, not throw) — so a transient
  // credit failure permanently DESTROYED the escrowed stake with no retry path.
  // Now: BEGIN -> claim -> credit (direct UPDATE that THROWS inside the txn on
  // failure) -> mark rows -> COMMIT. Any failure ROLLs BACK the whole thing,
  // including the sidebets_settled claim, so the caller can safely retry and no
  // chips are ever destroyed. Σpayouts == Σescrowed (dust → largest winner).
  const client = await pool.connect();
  const movements: BracketChipMovement[] = [];
  try {
    await client.query('BEGIN');
    // Atomic idempotency claim under a row lock: flip sidebets_settled false->true;
    // if no row comes back, another call already settled this bracket.
    const claim = await client.query(
      `UPDATE social_brackets SET sidebets_settled=TRUE WHERE bracket_id=$1 AND status='complete' AND sidebets_settled=FALSE RETURNING bracket_id`,
      [bracketId]
    );
    if (!claim.rowCount) { await client.query('ROLLBACK'); return []; }

    const champRow = await client.query(`SELECT name FROM social_bracket_players WHERE bracket_id=$1 AND is_out=FALSE ORDER BY seed ASC LIMIT 1`, [bracketId]);
    const champion = champRow.rows[0]?.name as string | undefined;
    // Only escrowed bets (bettor_user_id NOT NULL, unsettled) participate. FOR
    // UPDATE locks them against a concurrent settle/refund.
    const bets = (await client.query(
      `SELECT id, bettor_user_id, target_name, amount FROM social_bracket_sidebets WHERE bracket_id=$1 AND settled=FALSE AND bettor_user_id IS NOT NULL FOR UPDATE`,
      [bracketId]
    )).rows as any[];
    if (bets.length === 0) { await client.query('COMMIT'); return []; }

    const totalPool = bets.reduce((s, b) => s + (b.amount || 0), 0);
    const winners = champion ? bets.filter((b) => b.target_name === champion) : [];
    const winnerStake = winners.reduce((s, b) => s + (b.amount || 0), 0);

    if (winners.length > 0 && winnerStake > 0) {
      // Parimutuel proportional split of the WHOLE pool among champion backers.
      // Largest stake first so the dust remainder lands on the biggest winner.
      winners.sort((a, b) => (b.amount || 0) - (a.amount || 0));
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i];
        let payout = Math.floor((w.amount / winnerStake) * totalPool);
        if (i === 0) payout += totalPool - winners.reduce((s, x) => s + Math.floor((x.amount / winnerStake) * totalPool), 0); // dust → top winner
        await client.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=$2 WHERE id=$1', [w.id, payout]);
        if (payout > 0) {
          await client.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [payout, w.bettor_user_id]);
          movements.push({ userId: w.bettor_user_id, amount: payout, reason: 'sidebet_win', target: champion });
        }
      }
      // Losing bets: settled with payout 0 (their stake funded the winners' pool).
      for (const b of bets) {
        if (b.target_name !== champion) {
          await client.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=0 WHERE id=$1', [b.id]);
        }
      }
    } else {
      // Nobody backed the champion → refund every escrowed bettor their own stake.
      for (const b of bets) {
        await client.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=$2 WHERE id=$1', [b.id, b.amount]);
        await client.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [b.amount, b.bettor_user_id]);
        movements.push({ userId: b.bettor_user_id, amount: b.amount, reason: 'sidebet_refund' });
      }
    }
    await client.query('COMMIT');
    return movements;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e; // nothing committed — caller can retry; escrows are never lost
  } finally {
    client.release();
  }
}

// 2026-07-07 gap-fill [24] — refund path for an ABANDONED bracket (never
// completed). Returns every escrowed bettor their stake and marks the bracket
// settled so it can't also pay out later. Admin/organizer-invoked. Transactional
// for the same no-chip-destruction reason as settleBracketSideBets.
export async function refundBracketSideBets(bracketId: string): Promise<BracketChipMovement[]> {
  const pool = getPool();
  const client = await pool.connect();
  const movements: BracketChipMovement[] = [];
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `UPDATE social_brackets SET sidebets_settled=TRUE WHERE bracket_id=$1 AND sidebets_settled=FALSE RETURNING bracket_id`,
      [bracketId]
    );
    if (!claim.rowCount) { await client.query('ROLLBACK'); return []; }
    const bets = (await client.query(
      `SELECT id, bettor_user_id, amount FROM social_bracket_sidebets WHERE bracket_id=$1 AND settled=FALSE AND bettor_user_id IS NOT NULL FOR UPDATE`,
      [bracketId]
    )).rows as any[];
    for (const b of bets) {
      await client.query('UPDATE social_bracket_sidebets SET settled=TRUE, payout=$2 WHERE id=$1', [b.id, b.amount]);
      await client.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [b.amount, b.bettor_user_id]);
      movements.push({ userId: b.bettor_user_id, amount: b.amount, reason: 'sidebet_refund' });
    }
    await client.query('COMMIT');
    return movements;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

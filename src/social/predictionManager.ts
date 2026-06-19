// Prediction games — DURABLE (Postgres via authManager pool) and
// SERVER-AUTHORITATIVE. Replaces the sessionStorage mocks in
// components/ui/PredictionMarket.jsx and components/ui/SpectatorPredict.jsx.
//
// Two play-money games sharing one isolated chip pool (`prediction_wallets`)
// that is COMPLETELY SEPARATE from real poker `users.chips`:
//   • Prediction Market — per-hand yes/no markets ("will there be a
//     showdown?"). The server places the bet (deducts the wallet) and is
//     the ONLY thing that resolves the outcome, from the authoritative final
//     table state at hand-complete. The client can never self-report a win.
//   • Spectator Predict — pick the seat you think wins the hand; the server
//     compares to the real winner and keeps a durable streak/accuracy stat.
//
// Because the pool is play-money and isolated, the blast radius of any abuse
// is the fun-pool only — it can never mint real chips. Still, every credit
// flows through additive SQL here, never from a client payload.
//
// 2026-06-18 — Phase 3c of the .online remediation (build the mocks for real).
import { getPool } from '../auth/authManager';

const START_BALANCE = 1000;
const MIN_STAKE = 10;
const MAX_STAKE = 500;

// The ONLY markets the server can resolve authoritatively from the final
// hand-complete state. (The client's old pool also had 3-bet% / 3-way-to-flop
// markets — those need mid-hand history we don't reliably have, so they're
// dropped on both sides to keep the game honest.) odds = [yes%, no%].
export const MARKET_ODDS: Record<string, [number, number]> = {
  showdown:    [55, 45],
  flopPaired:  [17, 83],
  allIn:       [12, 88],
  bigPot:      [30, 70],
  riverSeen:   [45, 55],
  foldPreflop: [15, 85],
};

export interface PredictionFacts {
  showdown: boolean;
  flopPaired: boolean;
  allIn: boolean;
  bigPot: boolean;
  riverSeen: boolean;
  foldPreflop: boolean;
}

export interface SpectatorStats {
  correct: number;
  total: number;
  streak: number;
  bestStreak: number;
}

export async function initPredictionTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_wallets (
      user_id    INTEGER PRIMARY KEY,
      balance    INTEGER NOT NULL DEFAULT ${START_BALANCE},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_bets (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      table_id      TEXT NOT NULL,
      hand_number   INTEGER NOT NULL,
      market_id     TEXT NOT NULL,
      outcome       TEXT NOT NULL,            -- 'yes' | 'no' (the player's pick)
      stake         INTEGER NOT NULL,
      odds          INTEGER NOT NULL,         -- the % for the chosen outcome
      potential_win INTEGER NOT NULL,         -- gross return if correct
      status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'won' | 'lost'
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at   TIMESTAMPTZ,
      CONSTRAINT prediction_bets_uniq UNIQUE (user_id, table_id, hand_number, market_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS prediction_bets_open_idx ON prediction_bets(table_id, hand_number) WHERE status='open'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_picks (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      table_id      TEXT NOT NULL,
      hand_number   INTEGER NOT NULL,
      predicted_seat INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
      correct       BOOLEAN,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at   TIMESTAMPTZ,
      CONSTRAINT prediction_picks_uniq UNIQUE (user_id, table_id, hand_number)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS prediction_picks_open_idx ON prediction_picks(table_id, hand_number) WHERE status='open'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prediction_spectator_stats (
      user_id     INTEGER PRIMARY KEY,
      correct     INTEGER NOT NULL DEFAULT 0,
      total       INTEGER NOT NULL DEFAULT 0,
      streak      INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Wallet — ensures a row exists (start balance) and refills a busted wallet
// back to the start so the game never dead-ends. Play-money, so a free refill
// is intentional.
export async function getWallet(userId: number): Promise<number> {
  if (!userId) return 0;
  const pool = getPool();
  await pool.query(
    'INSERT INTO prediction_wallets (user_id, balance) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING',
    [userId, START_BALANCE]
  );
  const r = await pool.query('SELECT balance FROM prediction_wallets WHERE user_id=$1', [userId]);
  let balance = r.rows[0]?.balance ?? START_BALANCE;
  if (balance < MIN_STAKE) {
    await pool.query('UPDATE prediction_wallets SET balance=$2, updated_at=now() WHERE user_id=$1', [userId, START_BALANCE]);
    balance = START_BALANCE;
  }
  return balance;
}

export interface PlacedBet {
  marketId: string;
  outcome: string;
  stake: number;
  odds: number;
  potentialWin: number;
}

// Place a market bet. Server validates market/outcome/stake, deducts the
// wallet atomically, and records the position. The outcome is NOT resolved
// here — only at hand-complete via settleHand().
export async function placeMarketBet(
  userId: number,
  tableId: string,
  handNumber: number,
  marketId: string,
  outcome: string
  , stakeRaw: number
): Promise<{ ok: boolean; error?: string; balance?: number; bet?: PlacedBet }> {
  if (!userId || !tableId || !Number.isFinite(handNumber)) return { ok: false, error: 'Invalid bet' };
  const odds2 = MARKET_ODDS[marketId];
  if (!odds2) return { ok: false, error: 'Unknown market' };
  if (outcome !== 'yes' && outcome !== 'no') return { ok: false, error: 'Invalid outcome' };
  const stake = Math.max(MIN_STAKE, Math.min(MAX_STAKE, Math.floor(Number(stakeRaw) || 0)));
  if (stake < MIN_STAKE) return { ok: false, error: 'Stake too small' };

  const pool = getPool();
  const balance = await getWallet(userId);
  if (stake > balance) return { ok: false, error: 'Insufficient balance' };

  const odds = outcome === 'yes' ? odds2[0] : odds2[1];
  const potentialWin = Math.max(stake, Math.round(stake * (100 / odds)));

  // Atomic deduct guarded on sufficient balance; the unique constraint stops
  // double-betting the same market this hand.
  try {
    const ins = await pool.query(
      `INSERT INTO prediction_bets (user_id, table_id, hand_number, market_id, outcome, stake, odds, potential_win)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, tableId, handNumber, marketId, outcome, stake, odds, potentialWin]
    );
    if (!ins.rowCount) return { ok: false, error: 'Already bet' };
  } catch (e: any) {
    if (e?.code === '23505') return { ok: false, error: 'Already bet this market' };
    throw e;
  }
  const upd = await pool.query(
    'UPDATE prediction_wallets SET balance = balance - $2, updated_at=now() WHERE user_id=$1 AND balance >= $2 RETURNING balance',
    [userId, stake]
  );
  if (!upd.rowCount) {
    // Lost the race for balance — roll the bet back.
    await pool.query('DELETE FROM prediction_bets WHERE user_id=$1 AND table_id=$2 AND hand_number=$3 AND market_id=$4', [userId, tableId, handNumber, marketId]);
    return { ok: false, error: 'Insufficient balance' };
  }
  return { ok: true, balance: upd.rows[0].balance, bet: { marketId, outcome, stake, odds, potentialWin } };
}

// Spectator pick — upserts (one pick per table+hand). Returns ok.
export async function placePick(userId: number, tableId: string, handNumber: number, predictedSeat: number): Promise<{ ok: boolean; error?: string }> {
  if (!userId || !tableId || !Number.isFinite(handNumber) || !Number.isFinite(predictedSeat)) return { ok: false, error: 'Invalid pick' };
  const pool = getPool();
  await pool.query(
    `INSERT INTO prediction_picks (user_id, table_id, hand_number, predicted_seat)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, table_id, hand_number)
       DO UPDATE SET predicted_seat=EXCLUDED.predicted_seat
       WHERE prediction_picks.status='open'`,
    [userId, tableId, handNumber, predictedSeat]
  );
  return { ok: true };
}

export async function getSpectatorStats(userId: number): Promise<SpectatorStats> {
  if (!userId) return { correct: 0, total: 0, streak: 0, bestStreak: 0 };
  const pool = getPool();
  const r = await pool.query('SELECT correct, total, streak, best_streak FROM prediction_spectator_stats WHERE user_id=$1', [userId]);
  const row = r.rows[0];
  return {
    correct: row?.correct ?? 0,
    total: row?.total ?? 0,
    streak: row?.streak ?? 0,
    bestStreak: row?.best_streak ?? 0,
  };
}

function marketOutcome(facts: PredictionFacts, marketId: string): 'yes' | 'no' {
  return (facts as any)[marketId] ? 'yes' : 'no';
}

export interface SettleResult {
  // userId -> resolved market bets
  bets: Map<number, Array<{ marketId: string; result: 'yes' | 'no'; won: boolean; payout: number }>>;
  // userId -> new wallet balance (only for users who had bets)
  wallets: Map<number, number>;
  // userId -> spectator outcome
  picks: Map<number, { winnerSeat: number | null; correct: boolean; stats: SpectatorStats }>;
}

// Resolve every open bet/pick for this table+hand from the authoritative facts.
// Credits winning bets additively; updates spectator streaks.
export async function settleHand(
  tableId: string,
  handNumber: number,
  facts: PredictionFacts,
  winnerSeats: number[]
): Promise<SettleResult> {
  const pool = getPool();
  const out: SettleResult = { bets: new Map(), wallets: new Map(), picks: new Map() };
  if (!tableId || !Number.isFinite(handNumber)) return out;

  // ── Market bets ──
  const openBets = await pool.query(
    "SELECT id, user_id, market_id, outcome, potential_win FROM prediction_bets WHERE table_id=$1 AND hand_number=$2 AND status='open'",
    [tableId, handNumber]
  );
  for (const b of openBets.rows) {
    const result = marketOutcome(facts, b.market_id);
    const won = b.outcome === result;
    const payout = won ? b.potential_win : 0;
    await pool.query(
      "UPDATE prediction_bets SET status=$2, resolved_at=now() WHERE id=$1",
      [b.id, won ? 'won' : 'lost']
    );
    if (payout > 0) {
      await pool.query('UPDATE prediction_wallets SET balance = balance + $2, updated_at=now() WHERE user_id=$1', [b.user_id, payout]);
    }
    if (!out.bets.has(b.user_id)) out.bets.set(b.user_id, []);
    out.bets.get(b.user_id)!.push({ marketId: b.market_id, result, won, payout });
  }
  for (const uid of out.bets.keys()) {
    const r = await pool.query('SELECT balance FROM prediction_wallets WHERE user_id=$1', [uid]);
    out.wallets.set(uid, r.rows[0]?.balance ?? START_BALANCE);
  }

  // ── Spectator picks ──
  const winnerSet = new Set(winnerSeats);
  const openPicks = await pool.query(
    "SELECT id, user_id, predicted_seat FROM prediction_picks WHERE table_id=$1 AND hand_number=$2 AND status='open'",
    [tableId, handNumber]
  );
  for (const p of openPicks.rows) {
    const correct = winnerSet.has(p.predicted_seat);
    await pool.query("UPDATE prediction_picks SET status='resolved', correct=$2, resolved_at=now() WHERE id=$1", [p.id, correct]);
    // Durable streak update (additive / GREATEST for best_streak).
    await pool.query(
      `INSERT INTO prediction_spectator_stats (user_id, correct, total, streak, best_streak, updated_at)
         VALUES ($1, $2, 1, $3, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET
         correct = prediction_spectator_stats.correct + $2,
         total   = prediction_spectator_stats.total + 1,
         streak  = CASE WHEN $4 THEN prediction_spectator_stats.streak + 1 ELSE 0 END,
         best_streak = GREATEST(prediction_spectator_stats.best_streak,
                                CASE WHEN $4 THEN prediction_spectator_stats.streak + 1 ELSE prediction_spectator_stats.best_streak END),
         updated_at = now()`,
      [p.user_id, correct ? 1 : 0, correct ? 1 : 0, correct]
    );
    const stats = await getSpectatorStats(p.user_id);
    out.picks.set(p.user_id, { winnerSeat: winnerSeats[0] ?? null, correct, stats });
  }

  return out;
}

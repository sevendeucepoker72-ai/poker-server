/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F14) — DURABLE
 * tournament results. A tournament lives in memory; its finishing places 4..N,
 * who knocked whom out and the bust hands were stored nowhere (only the paid
 * places reached prize_payouts), so a player who busted while away could
 * never be told his place after the table closed (F12).
 *
 * Two tables (created by authManager.initDB from TOURNAMENT_RESULTS_DDL, and
 * lazily again by the first write here; ASCII-only SQL):
 *   tournament_results         one row per tournament: id, name, kind, buy-in,
 *                              entrants, prize pool, table ids, started /
 *                              finished times, status (running | finished |
 *                              voided);
 *   tournament_result_players  one row per entrant: account (local user_id,
 *                              master_user_id), name, place, prize,
 *                              eliminated_by, bust_hand, busted_at, told_at
 *                              (NULL = never told his result: F12 tells him at
 *                              his next sign-in).
 * Written as each player busts and at the finish (index.ts; non-qualifier
 * tournaments only — qualifier results have their own durable path).
 *
 * Every write is fire-and-forget through ONE serialized promise chain (one
 * pool connection at a time, never in parallel with itself); a failed write is
 * logged and counted, never thrown. Reads (unseenFor) go through the same
 * chain so they see the writes queued before them.
 */

export const TOURNAMENT_RESULTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS tournament_results (
    tournament_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    buy_in BIGINT NOT NULL DEFAULT 0,
    entrants INTEGER NOT NULL DEFAULT 0,
    prize_pool BIGINT NOT NULL DEFAULT 0,
    table_ids JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS tournament_result_players (
    tournament_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    user_id INTEGER,
    master_user_id TEXT,
    player_name TEXT,
    place INTEGER,
    prize BIGINT NOT NULL DEFAULT 0,
    eliminated_by TEXT,
    bust_hand INTEGER,
    busted_at TIMESTAMPTZ,
    told_at TIMESTAMPTZ,
    PRIMARY KEY (tournament_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trp_untold_user ON tournament_result_players(user_id) WHERE told_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_trp_untold_master ON tournament_result_players(master_user_id) WHERE told_at IS NULL`,
];

export interface TournamentResultsQuery {
  (sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface ResultsHeader {
  tournamentId: string;
  name: string;
  kind: string;
  buyIn: number;
  entrants: number;
  prizePool: number;
  tableIds: string[];
  startedAt: number;
}

export interface ResultsEntrant {
  playerId: string;
  userId?: number;
  masterUserId?: string;
  playerName: string;
}

export interface ResultsPlace {
  playerId: string;
  place: number;
  prize: number;
  eliminatedBy?: string | null;
  bustHand?: number | null;
  /** He was told his result live (a socket got the notice): told_at = now. */
  told: boolean;
}

export interface UnseenResult {
  tournamentId: string;
  playerId: string;
  playerName: string | null;
  place: number;
  prize: number;
  name: string;
  status: string;
}

export const tournamentResultsStats = {
  writes: 0,
  writeFailures: 0,
  ddlFailures: 0,
  reads: 0,
  readFailures: 0,
};

const clampInt = (n: unknown): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0;
};

export function createTournamentResultsStore(deps: { query: TournamentResultsQuery; log?: (line: string) => void }) {
  const log = deps.log || ((line: string) => console.warn(line));
  let ready = false;
  let chain: Promise<unknown> = Promise.resolve();

  async function ensureTables(): Promise<void> {
    if (ready) return;
    let ok = true;
    for (const sql of TOURNAMENT_RESULTS_DDL) {
      try { await deps.query(sql); } catch (e: any) {
        ok = false;
        tournamentResultsStats.ddlFailures++;
        log(`[tournament-results] ${JSON.stringify({ event: 'ddl_failed', error: String(e?.message || e).slice(0, 160) })}`);
      }
    }
    ready = ok;
  }

  /** One write, serialized; never throws. */
  function enqueue(label: string, statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
    const job = chain.then(async () => {
      await ensureTables();
      try {
        for (const st of statements) await deps.query(st.sql, st.params);
        tournamentResultsStats.writes++;
      } catch (e: any) {
        tournamentResultsStats.writeFailures++;
        log(`[tournament-results] ${JSON.stringify({ event: 'write_failed', label, error: String(e?.message || e).slice(0, 160) })}`);
      }
    });
    chain = job.catch(() => {});
    return job.catch(() => {});
  }

  /** The tournament started: its header + one row per entrant (no place yet). */
  function recordStart(h: ResultsHeader, entrants: ResultsEntrant[]): Promise<void> {
    const statements: Array<{ sql: string; params: unknown[] }> = [{
      sql: `INSERT INTO tournament_results (tournament_id, name, kind, buy_in, entrants, prize_pool, table_ids, status, started_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'running', to_timestamp($8 / 1000.0), NOW())
            ON CONFLICT (tournament_id) DO UPDATE SET entrants = EXCLUDED.entrants, prize_pool = EXCLUDED.prize_pool,
              table_ids = EXCLUDED.table_ids, updated_at = NOW()`,
      params: [h.tournamentId, String(h.name).slice(0, 120), h.kind, clampInt(h.buyIn), clampInt(h.entrants), clampInt(h.prizePool),
        JSON.stringify(h.tableIds || []), clampInt(h.startedAt) || Date.now()],
    }];
    for (const e of entrants) {
      statements.push({
        sql: `INSERT INTO tournament_result_players (tournament_id, player_id, user_id, master_user_id, player_name)
              VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tournament_id, player_id) DO NOTHING`,
        params: [h.tournamentId, e.playerId, e.userId ?? null, e.masterUserId ?? null, String(e.playerName || '').slice(0, 60)],
      });
    }
    return enqueue(`start:${h.tournamentId}`, statements);
  }

  function placeStatement(tournamentId: string, p: ResultsPlace, entrant?: ResultsEntrant): { sql: string; params: unknown[] } {
    return {
      sql: `INSERT INTO tournament_result_players (tournament_id, player_id, user_id, master_user_id, player_name, place, prize, eliminated_by, bust_hand, busted_at, told_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), CASE WHEN $10 THEN NOW() ELSE NULL END)
            ON CONFLICT (tournament_id, player_id) DO UPDATE SET
              place = EXCLUDED.place, prize = EXCLUDED.prize,
              eliminated_by = COALESCE(EXCLUDED.eliminated_by, tournament_result_players.eliminated_by),
              bust_hand = COALESCE(EXCLUDED.bust_hand, tournament_result_players.bust_hand),
              busted_at = COALESCE(tournament_result_players.busted_at, EXCLUDED.busted_at),
              user_id = COALESCE(tournament_result_players.user_id, EXCLUDED.user_id),
              master_user_id = COALESCE(tournament_result_players.master_user_id, EXCLUDED.master_user_id),
              told_at = COALESCE(tournament_result_players.told_at, EXCLUDED.told_at)`,
      params: [tournamentId, p.playerId, entrant?.userId ?? null, entrant?.masterUserId ?? null, entrant ? String(entrant.playerName || '').slice(0, 60) : null,
        clampInt(p.place) || null, clampInt(p.prize), p.eliminatedBy ?? null, p.bustHand != null ? clampInt(p.bustHand) || null : null, !!p.told],
    };
  }

  /** A player busted: his place (final for a non-qualifier field), prize so far, eliminator, bust hand, told? */
  function recordBust(tournamentId: string, p: ResultsPlace, entrant?: ResultsEntrant): Promise<void> {
    return enqueue(`bust:${tournamentId}:${p.playerId}`, [placeStatement(tournamentId, p, entrant)]);
  }

  /** The tournament finished: every place + prize (ties split) and the header's finish. */
  function recordFinish(tournamentId: string, info: { tableIds: string[]; entrants: number; prizePool: number }, places: Array<ResultsPlace & { entrant?: ResultsEntrant }>): Promise<void> {
    const statements = places.map((p) => placeStatement(tournamentId, p, p.entrant));
    statements.push({
      sql: `UPDATE tournament_results SET status = 'finished', finished_at = NOW(), entrants = GREATEST(entrants, $2),
              prize_pool = $3, table_ids = $4::jsonb, updated_at = NOW() WHERE tournament_id = $1`,
      params: [tournamentId, clampInt(info.entrants), clampInt(info.prizePool), JSON.stringify(info.tableIds || [])],
    });
    return enqueue(`finish:${tournamentId}`, statements);
  }

  /** A tournament voided by a restart (every fee refunded): never told as a result. */
  function markVoided(tournamentIds: string[]): Promise<void> {
    if (tournamentIds.length === 0) return Promise.resolve();
    return enqueue('voided', [{
      sql: `UPDATE tournament_results SET status = 'voided', finished_at = NOW(), updated_at = NOW() WHERE tournament_id = ANY($1::text[]) AND status = 'running'`,
      params: [tournamentIds],
    }]);
  }

  function markTold(tournamentId: string, playerId: string): Promise<void> {
    return enqueue(`told:${tournamentId}:${playerId}`, [{
      sql: `UPDATE tournament_result_players SET told_at = NOW() WHERE tournament_id = $1 AND player_id = $2 AND told_at IS NULL`,
      params: [tournamentId, playerId],
    }]);
  }

  /**
   * F12 — the results this account was never told (a place, not voided, not a
   * qualifier, within 7 days), oldest first, at most `limit`.
   */
  function unseenFor(userId: number | null, masterUserId: string | null, limit = 5): Promise<UnseenResult[]> {
    const job = chain.then(async () => {
      await ensureTables();
      tournamentResultsStats.reads++;
      const r = await deps.query(
        `SELECT p.tournament_id, p.player_id, p.player_name, p.place, p.prize, r.name, r.status
           FROM tournament_result_players p JOIN tournament_results r ON r.tournament_id = p.tournament_id
          WHERE (p.user_id = $1 OR ($2::text IS NOT NULL AND p.master_user_id = $2))
            AND p.told_at IS NULL AND p.place IS NOT NULL AND r.kind <> 'qualifier' AND r.status <> 'voided'
            AND COALESCE(r.finished_at, p.busted_at) > NOW() - INTERVAL '7 days'
          ORDER BY p.busted_at NULLS LAST LIMIT $3`,
        [userId ?? -1, masterUserId ?? null, Math.max(1, Math.min(20, Math.floor(limit)))],
      );
      return (r.rows || []).map((x: any) => ({
        tournamentId: String(x.tournament_id), playerId: String(x.player_id), playerName: x.player_name ?? null,
        place: Number(x.place) || 0, prize: Number(x.prize) || 0, name: String(x.name || 'Tournament'), status: String(x.status || ''),
      }));
    });
    chain = job.catch(() => {});
    return job.catch((e: any) => {
      tournamentResultsStats.readFailures++;
      log(`[tournament-results] ${JSON.stringify({ event: 'read_failed', error: String(e?.message || e).slice(0, 160) })}`);
      return [] as UnseenResult[];
    });
  }

  /** Resolves once every queued write ran (tests, the shutdown flush). */
  function drain(): Promise<void> {
    return chain.then(() => {}, () => {});
  }

  return { recordStart, recordBust, recordFinish, markVoided, markTold, unseenFor, drain };
}

export type TournamentResultsStore = ReturnType<typeof createTournamentResultsStore>;

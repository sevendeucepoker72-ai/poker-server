/**
 * 2026-10-11 (.online R2, S1) — ECON-17 (tournament part): a prize is NEVER
 * marked paid before the wallet credit succeeded.
 *
 * Before: payTournamentPrizes added the tournament to an in-memory "paid" set,
 * then fired `addChipsToUser` per winner with the failure only logged (no
 * retry); staking settlement stamped `paid_out_at` on the offers BEFORE the
 * backer credits ran; the Spin & Go settlement zeroed the winner's stack and
 * then credited with a swallowed error. One DB blip lost a prize for good.
 *
 * Now every settlement is ONE transaction:
 *   - each credit has an idempotency key (`payout_key`, PRIMARY KEY of
 *     `prize_payouts`): the ledger row is INSERTed ... ON CONFLICT DO NOTHING
 *     and the wallet is credited only when that insert made a row — a re-run
 *     of an already committed settlement credits nothing;
 *   - the caller's extra statements (e.g. marking staking offers paid) run in
 *     the SAME transaction;
 *   - any error rolls the whole thing back and it is retried with backoff; a
 *     settlement that still fails is kept and retried by `retryPending()` (a
 *     timer in index.ts, and once more by the shutdown flush) — the key makes
 *     every retry safe.
 */

export interface LedgerCredit {
  /** Idempotency key: the same key is credited at most once, ever. */
  key: string;
  userId: number;
  amount: number;
  /** Audit kind, e.g. TOURNAMENT_PRIZE, STAKING_PAYOUT, SPINGO_PRIZE, STAKING_REFUND. */
  kind: string;
  details?: Record<string, unknown>;
}

export interface LedgerSettlement {
  /** A name for logs / the pending list (e.g. `tournament:<id>`). */
  label: string;
  credits: LedgerCredit[];
  /** Run inside the same transaction, after the credits (e.g. mark offers paid). */
  extraStatements?: Array<{ sql: string; params: unknown[] }>;
}

export interface LedgerResult {
  status: 'committed' | 'failed';
  /** Credits this run actually paid. */
  paid: LedgerCredit[];
  /** Credits whose key was already in the ledger (paid before — never twice). */
  alreadyPaid: LedgerCredit[];
  /** Credits whose user row no longer exists (recorded, nothing credited). */
  noUser: LedgerCredit[];
  attempts: number;
  error?: string;
}

interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}

export interface PrizeLedgerDeps {
  connect: () => Promise<QueryClient>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Backoff before each retry (ms). Default 0, 500, 2000, 8000. */
  backoffMs?: number[];
}

export const PRIZE_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS prize_payouts (
  payout_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount BIGINT NOT NULL,
  kind TEXT NOT NULL,
  details JSONB,
  credited BOOLEAN NOT NULL DEFAULT TRUE,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;

export const prizeLedgerStats = {
  settlements: 0,
  committed: 0,
  retriedAttempts: 0,
  failedSettlements: 0,
  pending: 0,
  creditsPaid: 0,
  creditsAlreadyPaid: 0,
  creditsNoUser: 0,
  invalidCreditsDropped: 0,
};

export function createPrizeLedger(deps: PrizeLedgerDeps) {
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log || ((line: string) => console.warn(line));
  const backoff = deps.backoffMs || [0, 500, 2000, 8000];
  let tableReady = false;
  /** Settlements that exhausted their attempts — retried by retryPending(). */
  const pending = new Map<string, LedgerSettlement>();

  async function attempt(s: LedgerSettlement): Promise<Omit<LedgerResult, 'attempts' | 'status'>> {
    const client = await deps.connect();
    try {
      if (!tableReady) {
        await client.query(PRIZE_LEDGER_DDL);
        tableReady = true;
      }
      await client.query('BEGIN');
      const paid: LedgerCredit[] = [];
      const alreadyPaid: LedgerCredit[] = [];
      const noUser: LedgerCredit[] = [];
      for (const c of s.credits) {
        const ins = await client.query(
          `INSERT INTO prize_payouts (payout_key, user_id, amount, kind, details)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payout_key) DO NOTHING RETURNING payout_key`,
          [c.key, c.userId, c.amount, c.kind, JSON.stringify(c.details || {})],
        );
        if (!ins.rows || ins.rows.length === 0) { alreadyPaid.push(c); continue; }
        const upd = await client.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [c.amount, c.userId]);
        if (!upd.rowCount) {
          await client.query('UPDATE prize_payouts SET credited = FALSE WHERE payout_key = $1', [c.key]);
          noUser.push(c);
          continue;
        }
        paid.push(c);
      }
      for (const st of s.extraStatements || []) await client.query(st.sql, st.params);
      await client.query('COMMIT');
      return { paid, alreadyPaid, noUser };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* the connection may be gone */ }
      throw e;
    } finally {
      try { client.release(); } catch { /* ignore */ }
    }
  }

  /**
   * Settle: credits with a valid key / user / whole positive amount are paid in
   * ONE transaction (with the extra statements); retried with backoff. Never
   * throws. A failed settlement is kept for retryPending().
   */
  async function settle(input: LedgerSettlement): Promise<LedgerResult> {
    const credits = input.credits.filter((c) => {
      const ok = typeof c.key === 'string' && c.key.length > 0 && Number.isInteger(c.userId) && c.userId > 0 && isWhole(c.amount);
      if (!ok) prizeLedgerStats.invalidCreditsDropped++;
      return ok;
    });
    const s: LedgerSettlement = { ...input, credits };
    prizeLedgerStats.settlements++;
    let lastError = '';
    for (let i = 0; i < backoff.length; i++) {
      if (backoff[i] > 0) await sleep(backoff[i]);
      if (i > 0) prizeLedgerStats.retriedAttempts++;
      try {
        const r = await attempt(s);
        prizeLedgerStats.committed++;
        prizeLedgerStats.creditsPaid += r.paid.length;
        prizeLedgerStats.creditsAlreadyPaid += r.alreadyPaid.length;
        prizeLedgerStats.creditsNoUser += r.noUser.length;
        if (pending.delete(s.label)) prizeLedgerStats.pending = pending.size;
        return { status: 'committed', ...r, attempts: i + 1 };
      } catch (e: any) {
        lastError = String(e?.message || e).slice(0, 200);
        log(`[prize-ledger] ${JSON.stringify({ event: 'settlement_attempt_failed', label: s.label, attempt: i + 1, error: lastError })}`);
      }
    }
    prizeLedgerStats.failedSettlements++;
    pending.set(s.label, s);
    prizeLedgerStats.pending = pending.size;
    log(`[prize-ledger] ${JSON.stringify({ event: 'settlement_pending_retry', label: s.label, credits: s.credits.length, error: lastError })}`);
    return { status: 'failed', paid: [], alreadyPaid: [], noUser: [], attempts: backoff.length, error: lastError };
  }

  /** Retry every pending settlement once (the key makes a retry of a committed one a no-op). */
  async function retryPending(): Promise<number> {
    let committed = 0;
    for (const [label, s] of [...pending]) {
      try {
        const r = await attempt(s);
        pending.delete(label);
        committed++;
        prizeLedgerStats.committed++;
        prizeLedgerStats.creditsPaid += r.paid.length;
        prizeLedgerStats.creditsAlreadyPaid += r.alreadyPaid.length;
        prizeLedgerStats.creditsNoUser += r.noUser.length;
        log(`[prize-ledger] ${JSON.stringify({ event: 'pending_settlement_committed', label, paid: r.paid.length })}`);
      } catch (e: any) {
        log(`[prize-ledger] ${JSON.stringify({ event: 'pending_settlement_retry_failed', label, error: String(e?.message || e).slice(0, 200) })}`);
      }
    }
    prizeLedgerStats.pending = pending.size;
    return committed;
  }

  return { settle, retryPending, pendingCount: () => pending.size, pendingLabels: () => [...pending.keys()] };
}

export type PrizeLedger = ReturnType<typeof createPrizeLedger>;

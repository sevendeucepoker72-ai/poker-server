/**
 * R3 (2026-10-11, AUTH-P3-3) — the deep-link PLAY TICKET replay guard, durable.
 *
 * `authWithTicket` (Play Online) and `joinWithWaitlistContext` (a waitlist
 * link) sign a socket in with a short-lived ticket the master API verifies but
 * does NOT mark consumed. poker-server burns it: a second use is refused
 * `ticket_replayed`. That burn was an in-memory Map only — every restart (each
 * Railway deploy) forgot it, and during a deploy's overlap the OLD and the NEW
 * process each accepted the same ticket once. A leaked link could be replayed.
 *
 * Now: the in-memory map stays the FAST path (a second claim in this process is
 * refused synchronously, before any await), and the claim is made durable with
 * ONE atomic statement on the shared Postgres —
 *   INSERT INTO used_play_tickets (ticket_hash, expires_at) VALUES ($1, $2)
 *     ON CONFLICT (ticket_hash) DO NOTHING RETURNING 1
 * — no row back = another process (or this one before a restart) already used
 * it: refused. Only a SHA-256 of the ticket is stored, never the ticket.
 * Rows expire after TICKET_HASH_TTL_MS (longer than any ticket's lifetime) and
 * are pruned hourly (`prune`).
 *
 * A DB that cannot answer (no pool yet, table missing, query error) falls back
 * to the in-memory guard — exactly the old protection — and is counted
 * (`durableErrors`, /api/health `ticketReplayGuard`): a sign-in needs the DB
 * anyway, so failing closed here would only add an outage mode.
 */
import { createHash } from 'crypto';

/** 2h: longer than any ticket we issue, so a retry inside a ticket's window is still refused. */
export const TICKET_HASH_TTL_MS = 2 * 60 * 60 * 1000;

export interface TicketDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export const ticketReplayStats = {
  /** Claims accepted (first use). */
  claimed: 0,
  /** Refused by this process's memory (a second use since this process started). */
  refusedMemory: 0,
  /** Refused by the durable ledger (used before a restart, or by the other process of a deploy overlap). */
  refusedDurable: 0,
  /** Claims the DB could not answer — accepted on the in-memory guard alone. */
  durableErrors: 0,
  /** Expired ledger rows deleted by prune(). */
  pruned: 0,
};

/** The ledger key of a ticket: SHA-256 (hex) of the raw token — the token itself is never stored. */
export function ticketHash(token: string): string {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Boot DDL (idempotent) — next to the other boot tables in index.ts's initDB chain. */
export async function initUsedPlayTicketsTable(db: TicketDb): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS used_play_tickets (
      ticket_hash TEXT PRIMARY KEY,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_used_play_tickets_expires_at ON used_play_tickets (expires_at)');
}

export interface TicketReplayGuard {
  /** true = first use (go on); false = replay (refuse `ticket_replayed`). */
  claim(token: string): Promise<boolean>;
  /** Delete expired ledger rows; returns how many. Never throws. */
  prune(): Promise<number>;
  /** Entries in the in-memory fast path (tests / diagnostics). */
  memorySize(): number;
}

export function createTicketReplayGuard(
  getDb: () => TicketDb | null,
  opts: { ttlMs?: number; now?: () => number; warn?: (msg: string) => void } = {},
): TicketReplayGuard {
  const ttlMs = opts.ttlMs ?? TICKET_HASH_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const memory = new Map<string, number>(); // ticket hash -> expiresAt (ms)

  const db = (): TicketDb | null => {
    try { return getDb(); } catch { return null; }
  };

  return {
    async claim(token: string): Promise<boolean> {
      const t = now();
      for (const [k, exp] of memory) if (exp <= t) memory.delete(k);
      const hash = ticketHash(token);
      if (memory.has(hash)) { ticketReplayStats.refusedMemory++; return false; }
      // Synchronous: a second claim in THIS process is refused even while the
      // durable insert below is still in flight.
      memory.set(hash, t + ttlMs);
      const pool = db();
      if (!pool) { ticketReplayStats.durableErrors++; ticketReplayStats.claimed++; return true; }
      try {
        const res = await pool.query(
          `INSERT INTO used_play_tickets (ticket_hash, expires_at) VALUES ($1, $2)
             ON CONFLICT (ticket_hash) DO NOTHING RETURNING 1`,
          [hash, new Date(t + ttlMs)],
        );
        const inserted = (res.rowCount ?? res.rows.length) > 0;
        if (!inserted) { ticketReplayStats.refusedDurable++; return false; }
        ticketReplayStats.claimed++;
        return true;
      } catch (e: any) {
        ticketReplayStats.durableErrors++;
        ticketReplayStats.claimed++;
        warn(`[ticket-replay] durable claim failed — in-memory guard only for this ticket: ${String(e?.message || e).slice(0, 120)}`);
        return true;
      }
    },
    async prune(): Promise<number> {
      const pool = db();
      if (!pool) return 0;
      try {
        const res = await pool.query('DELETE FROM used_play_tickets WHERE expires_at < NOW()');
        const n = Number(res.rowCount) || 0;
        ticketReplayStats.pruned += n;
        return n;
      } catch (e: any) {
        warn(`[ticket-replay] prune failed (non-fatal): ${String(e?.message || e).slice(0, 120)}`);
        return 0;
      }
    },
    memorySize: () => memory.size,
  };
}

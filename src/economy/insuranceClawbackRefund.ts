/**
 * 2026-10-24 (owner: "Yes, refund them" / "All 13 accounts") — one-time refund of
 * the all-in insurance clawbacks.
 *
 * An insured player who WON the pot was paid the whole pot by the engine, then
 * settleInsuranceForHand cut his stack back to the locked cashout and the rest
 * left the economy, while the table still showed him winning the whole pot.
 * Every clawback since the R1 insurance rework (2026-10-12) is refunded exactly:
 * the amounts are the INSURANCE_COLLECT audit lines (-delta) in the Railway
 * logs, each matched to its account through the INSURANCE_ACCEPTED line of the
 * same table + hand + seat (65 events, 0 unmatched; 371,861 chips, 12 accounts).
 * The Sept 25-29 clawbacks (older build) name no account and are not included.
 *
 * Exactly once: the one_time_ops claim, every credit and the recipient record
 * commit in ONE transaction (the 2026-10-10 goodwill-grant pattern). A failure
 * rolls everything back and the next boot retries. An account that no longer
 * exists is skipped and recorded, never fatal.
 */
import type { Pool, PoolClient } from 'pg';

export const INSURANCE_REFUND_OP_ID = 'insurance_clawback_refund_2026_10_24';
export const INSURANCE_REFUND_ID = 'online-insurance-clawback-refund-2026-10-24';

/** users.id -> chips clawed back since 2026-10-12, and how many hands. */
export const INSURANCE_REFUNDS: ReadonlyArray<{ userId: number; chips: number; hands: number }> = Object.freeze([
  { userId: 4239, chips: 161906, hands: 15 },
  { userId: 1772, chips: 51023, hands: 3 },
  { userId: 1054, chips: 36709, hands: 13 },
  { userId: 4448, chips: 36327, hands: 12 },
  { userId: 2414, chips: 29463, hands: 9 },
  { userId: 4198, chips: 22933, hands: 5 },
  { userId: 4775, chips: 17040, hands: 3 },
  { userId: 4907, chips: 5667, hands: 1 },
  { userId: 4171, chips: 4661, hands: 1 },
  { userId: 4887, chips: 3142, hands: 1 },
  { userId: 4882, chips: 2876, hands: 1 },
  { userId: 4890, chips: 114, hands: 1 },
]);

export const INSURANCE_REFUND_TOTAL = INSURANCE_REFUNDS.reduce((s, r) => s + r.chips, 0);

export type InsuranceRefundOutcome = {
  status: 'done' | 'skipped_already_done' | 'error';
  recipients: number;
  chips: number;
  missing: number[];
  error?: string;
};

/** Called once per credited account AFTER the commit (audit + wallet push). */
export type InsuranceRefundCredited = (userId: number, chips: number, hands: number) => void;

export async function runInsuranceClawbackRefund(pool: Pool, onCredited: InsuranceRefundCredited): Promise<InsuranceRefundOutcome> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO one_time_ops (op_id, detail) VALUES ($1, '{"status":"running"}'::jsonb)
         ON CONFLICT (op_id) DO NOTHING RETURNING op_id`, [INSURANCE_REFUND_OP_ID],
    );
    if (claim.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { status: 'skipped_already_done', recipients: 0, chips: 0, missing: [] };
    }
    const credited: Array<{ userId: number; chips: number; hands: number }> = [];
    const missing: number[] = [];
    for (const r of INSURANCE_REFUNDS) {
      const upd = await client.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [r.chips, r.userId]);
      if (upd.rowCount === 1) credited.push(r); else missing.push(r.userId);
    }
    const chips = credited.reduce((s, r) => s + r.chips, 0);
    await client.query(`UPDATE one_time_ops SET detail = $2::jsonb WHERE op_id = $1`, [INSURANCE_REFUND_OP_ID, JSON.stringify({
      status: 'done', refundId: INSURANCE_REFUND_ID, recipients: credited.length, totalChips: chips, missing,
      credits: credited, reason: 'all-in insurance clawed back pots the insured player won (2026-10-12..2026-10-24)',
    })]);
    await client.query('COMMIT');
    for (const r of credited) {
      try { onCredited(r.userId, r.chips, r.hands); } catch { /* audit / push only — the credit is committed */ }
    }
    console.log(`[insurance-refund] refunded ${chips.toLocaleString('en-US')} chips to ${credited.length} account(s)${missing.length ? `; missing ${missing.join(',')}` : ''} (${INSURANCE_REFUND_ID})`);
    return { status: 'done', recipients: credited.length, chips, missing };
  } catch (e: any) {
    if (client) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } }
    const error = String(e?.message || e).slice(0, 300);
    console.error('[insurance-refund] FAILED (nothing credited; retried next boot):', error);
    return { status: 'error', recipients: 0, chips: 0, missing: [], error };
  } finally {
    client?.release();
  }
}

/**
 * 2026-10-24 (owner: refund "All 13 accounts" — 12 distinct: rodney.elmore is
 * user 4198) — the one-time refund of the all-in insurance clawbacks.
 * Exactly once: claim + credits + record in ONE transaction; a second boot is a
 * no-op; a failure credits nothing (rolled back, retried next boot).
 */
import {
  runInsuranceClawbackRefund, INSURANCE_REFUNDS, INSURANCE_REFUND_TOTAL, INSURANCE_REFUND_OP_ID,
} from '../src/economy/insuranceClawbackRefund';
import { SRC } from './helpers/indexSource';

/** A fake pg pool: one users table + one_time_ops, with real BEGIN / COMMIT / ROLLBACK semantics. */
function fakePool(opts: { users?: number[]; failOnUser?: number } = {}) {
  const users = new Map<number, number>((opts.users ?? INSURANCE_REFUNDS.map((r) => r.userId)).map((id) => [id, 1000]));
  const ops = new Map<string, any>();
  let tx: { users: Map<number, number>; ops: Map<string, any> } | null = null;
  const log: string[] = [];
  const client = {
    async query(sql: string, params: any[] = []) {
      const s = sql.trim();
      if (s === 'BEGIN') { tx = { users: new Map(users), ops: new Map(ops) }; log.push('BEGIN'); return { rowCount: 0, rows: [] }; }
      if (s === 'COMMIT') { for (const [k, v] of tx!.users) users.set(k, v); for (const [k, v] of tx!.ops) ops.set(k, v); tx = null; log.push('COMMIT'); return { rowCount: 0, rows: [] }; }
      if (s === 'ROLLBACK') { tx = null; log.push('ROLLBACK'); return { rowCount: 0, rows: [] }; }
      const t = tx!;
      if (s.startsWith('INSERT INTO one_time_ops')) {
        if (t.ops.has(params[0])) return { rowCount: 0, rows: [] };
        t.ops.set(params[0], { status: 'running' });
        return { rowCount: 1, rows: [{ op_id: params[0] }] };
      }
      if (s.startsWith('UPDATE users SET chips = chips + $1 WHERE id = $2')) {
        const [amt, id] = params;
        if (id === opts.failOnUser) throw new Error('connection reset');
        if (!t.users.has(id)) return { rowCount: 0, rows: [] };
        t.users.set(id, t.users.get(id)! + amt);
        return { rowCount: 1, rows: [] };
      }
      if (s.startsWith('UPDATE one_time_ops SET detail')) { t.ops.set(params[0], JSON.parse(params[1])); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected SQL: ${s.slice(0, 60)}`);
    },
    release() { log.push('release'); },
  };
  return { pool: { connect: async () => client } as any, users, ops, log };
}

describe('insurance clawback refund (one-time, exactly once)', () => {
  const quiet = { log: console.log, error: console.error };
  beforeAll(() => { console.log = () => {}; console.error = () => {}; });
  afterAll(() => { console.log = quiet.log; console.error = quiet.error; });

  test('the list: 12 accounts, 65 hands, 371,861 chips — every amount a positive whole number, no account twice', () => {
    expect(INSURANCE_REFUNDS).toHaveLength(12);
    expect(new Set(INSURANCE_REFUNDS.map((r) => r.userId)).size).toBe(12);
    expect(INSURANCE_REFUNDS.reduce((s, r) => s + r.hands, 0)).toBe(65);
    expect(INSURANCE_REFUND_TOTAL).toBe(371_861);
    for (const r of INSURANCE_REFUNDS) { expect(Number.isInteger(r.chips)).toBe(true); expect(r.chips).toBeGreaterThan(0); }
  });

  test('first run credits every account its exact amount in one transaction, then tells the caller (audit + push) per account', async () => {
    const db = fakePool();
    const told: Array<[number, number, number]> = [];
    const out = await runInsuranceClawbackRefund(db.pool, (u, c, h) => told.push([u, c, h]));
    expect(out).toEqual({ status: 'done', recipients: 12, chips: 371_861, missing: [] });
    for (const r of INSURANCE_REFUNDS) expect(db.users.get(r.userId)).toBe(1000 + r.chips);
    expect(told).toEqual(INSURANCE_REFUNDS.map((r) => [r.userId, r.chips, r.hands]));
    expect(db.ops.get(INSURANCE_REFUND_OP_ID)).toMatchObject({ status: 'done', recipients: 12, totalChips: 371_861 });
    expect(db.log.filter((x) => x === 'COMMIT')).toHaveLength(1);
  });

  test('a second boot is a no-op: nothing credited twice, nobody told twice', async () => {
    const db = fakePool();
    await runInsuranceClawbackRefund(db.pool, () => {});
    const told: number[] = [];
    const again = await runInsuranceClawbackRefund(db.pool, (u) => told.push(u));
    expect(again.status).toBe('skipped_already_done');
    expect(told).toEqual([]);
    for (const r of INSURANCE_REFUNDS) expect(db.users.get(r.userId)).toBe(1000 + r.chips);
  });

  test('a DB error mid-way credits NOBODY (rolled back) and leaves the op unclaimed, so the next boot retries', async () => {
    const db = fakePool({ failOnUser: INSURANCE_REFUNDS[5].userId });
    const out = await runInsuranceClawbackRefund(db.pool, () => { throw new Error('must not be told'); });
    expect(out.status).toBe('error');
    for (const r of INSURANCE_REFUNDS) expect(db.users.get(r.userId)).toBe(1000);
    expect(db.ops.has(INSURANCE_REFUND_OP_ID)).toBe(false);
    expect(db.log).toContain('ROLLBACK');
  });

  test('an account that no longer exists is skipped and recorded, never fatal', async () => {
    const gone = INSURANCE_REFUNDS[11].userId;
    const db = fakePool({ users: INSURANCE_REFUNDS.map((r) => r.userId).filter((id) => id !== gone) });
    const out = await runInsuranceClawbackRefund(db.pool, () => {});
    expect(out).toMatchObject({ status: 'done', recipients: 11, chips: 371_861 - INSURANCE_REFUNDS[11].chips, missing: [gone] });
  });

  test('an unreachable database at boot is an error outcome, never an unhandled rejection; nothing is told', async () => {
    const told: number[] = [];
    const out = await runInsuranceClawbackRefund({ connect: async () => { throw new Error('ECONNREFUSED'); } } as any, (uid) => told.push(uid));
    expect(out).toMatchObject({ status: 'error', recipients: 0, chips: 0 });
    expect(told).toEqual([]);
  });

  test('wiring: boot runs it with the durable BUG_REFUND audit (auditEconomyCredit) and a fresh wallet push', () => {
    expect(SRC).toContain("auditEconomyCredit(userId, 'BUG_REFUND', chips, 0, { refundId: INSURANCE_REFUND_ID, hands, reason: 'insurance_clawback' });");
    expect(SRC).toContain('void runInsuranceClawbackRefund(getPool(), (userId, chips, hands) => {');
  });
});

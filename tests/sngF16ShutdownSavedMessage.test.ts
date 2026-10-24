/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F16, review fix-up)
 * — the shutdown flush no longer tells an operator to grant by hand a credit
 * the next boot will retry.
 *
 * F16 saves a settlement that failed every attempt to prize_ledger_pending and
 * the next boot retries it (loadPersistedPending + retryPending). The shutdown
 * flush still logged every unsettled credit as 'NOT SETTLED' and sent Sentry a
 * message to "reconcile": an operator who granted those chips by hand (admin
 * grant / addChipsToUser) would be paid twice once the boot retry ran - the
 * ledger keys only stop ledger re-runs.
 *  - prizeLedger.settle's failed result says whether the settlement is SAVED
 *    (`persisted: true`, additive) - false when the save itself failed (then
 *    nothing will retry it and it must be reconciled by hand, as before).
 *  - settleShutdownCredits: saved -> '[Shutdown] SAVED FOR RETRY AT BOOT ...
 *    do NOT grant by hand' (+ Sentry says the same); not saved -> the old
 *    'NOT SETTLED' line (+ Sentry "reconcile").
 */
import { createPrizeLedger } from '../src/game/prizeLedger';
import { fnSrc, load } from './helpers/indexSource';

function fakeConnect(opts: { failCredits: boolean; failPendingSave: boolean }) {
  return async () => ({
    async query(q: string) {
      if (/^\s*CREATE|^\s*BEGIN|^\s*ROLLBACK|^\s*COMMIT/i.test(q)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO prize_payouts/i.test(q)) { if (opts.failCredits) throw new Error('db down'); return { rows: [{ payout_key: 'k' }], rowCount: 1 }; }
      if (/UPDATE users SET chips/i.test(q)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO prize_ledger_pending/i.test(q)) { if (opts.failPendingSave) throw new Error('db down'); return { rows: [], rowCount: 1 }; }
      if (/DELETE FROM prize_ledger_pending/i.test(q)) return { rows: [], rowCount: 1 };
      throw new Error(`unhandled ${q.slice(0, 40)}`);
    },
    release() {},
  });
}
const credit = { key: 'shutdown:P:T1:0', userId: 7, amount: 1200, kind: 'SHUTDOWN_CASH_OUT' };

describe('F16 review fix-up — prizeLedger.settle says whether a failed settlement was saved', () => {
  it('saved to prize_ledger_pending -> persisted: true', async () => {
    const l = createPrizeLedger({ connect: fakeConnect({ failCredits: true, failPendingSave: false }) as any, sleep: async () => {}, log: () => {}, backoffMs: [0, 0], persistPending: true } as any);
    const r: any = await l.settle({ label: 'shutdown:P', credits: [credit] });
    expect(r.status).toBe('failed');
    expect(r.persisted).toBe(true);                // 78a7925: absent
  });
  it('the save failed too (DB down) -> persisted: false', async () => {
    const l = createPrizeLedger({ connect: fakeConnect({ failCredits: true, failPendingSave: true }) as any, sleep: async () => {}, log: () => {}, backoffMs: [0, 0], persistPending: true } as any);
    const r: any = await l.settle({ label: 'shutdown:P', credits: [credit] });
    expect(r.status).toBe('failed');
    expect(r.persisted).toBe(false);
  });
  it('persistence off (tests, tools) -> persisted: false', async () => {
    const l = createPrizeLedger({ connect: fakeConnect({ failCredits: true, failPendingSave: false }) as any, sleep: async () => {}, log: () => {}, backoffMs: [0] } as any);
    const r: any = await l.settle({ label: 'shutdown:P', credits: [credit] });
    expect(r.persisted).toBe(false);
  });
});

describe('F16 review fix-up — settleShutdownCredits tells the operator what to do', () => {
  function run(result: any) {
    const errors: string[] = [];
    const sentry: string[] = [];
    const stats: any = { ledgerStatus: '', seatsCashedOut: 0, chipsCashedOut: 0, entryFeesRefunded: 0 };
    const { exports: m } = load(fnSrc('async function settleShutdownCredits('), {
      prizeLedger: { settle: async () => result },
      PROCESS_INSTANCE_ID: 'P', shutdownFlushStats: stats, shutdownRefundLogins: new Map(),
      tournamentFeeAudit() {},
      Sentry: { captureMessage: (msg: string) => { sentry.push(msg); } },
      console: { log() {}, warn() {}, error: (line: string) => { errors.push(line); } },
    }, '{ settleShutdownCredits }');
    return { m, errors, sentry, stats };
  }
  const seat = { tableId: 'T1', seatIndex: 0, userId: 7, amount: 1200, via: 'seat', invested: 0 };

  it('saved for the boot retry: no "NOT SETTLED" / "reconcile"; each credit logged SAVED FOR RETRY AT BOOT, do NOT grant by hand (78a7925: NOT SETTLED + reconcile)', async () => {
    const w = run({ status: 'failed', paid: [], alreadyPaid: [], noUser: [], attempts: 4, error: 'db down', persisted: true });
    await w.m.settleShutdownCredits([seat], []);
    expect(w.errors.some((l) => /NOT SETTLED/.test(l))).toBe(false);
    expect(w.errors).toEqual([expect.stringMatching(/^\[Shutdown\] SAVED FOR RETRY AT BOOT \(do NOT grant by hand\) SHUTDOWN_CASH_OUT 1200 for user 7 /)]);
    expect(w.sentry).toEqual([expect.stringMatching(/saved for retry at the next boot/)]);
    expect(w.sentry[0]).toMatch(/do not grant by hand/);
    expect(w.sentry[0]).not.toMatch(/reconcile/);
    expect(w.stats.ledgerSavedForRetry).toBe(true);
  });

  it('NOT saved (the save failed too): the old NOT SETTLED line and a Sentry "reconcile by hand"', async () => {
    const w = run({ status: 'failed', paid: [], alreadyPaid: [], noUser: [], attempts: 4, error: 'db down', persisted: false });
    await w.m.settleShutdownCredits([seat], []);
    expect(w.errors).toEqual([expect.stringMatching(/^\[Shutdown\] NOT SETTLED SHUTDOWN_CASH_OUT 1200 for user 7 /)]);
    expect(w.sentry).toEqual([expect.stringMatching(/not settled and not saved .*reconcile by hand/)]);
    expect(w.stats.ledgerSavedForRetry).toBe(false);
  });

  it('committed: nothing logged as an error', async () => {
    const w = run({ status: 'committed', paid: [{ ...credit, details: {} }], alreadyPaid: [], noUser: [], attempts: 1 });
    await w.m.settleShutdownCredits([seat], []);
    expect(w.errors).toEqual([]);
    expect(w.sentry).toEqual([]);
  });
});

/**
 * R2 (2026-10-11) — ECON-17 (tournament part): a prize is NEVER marked paid
 * before the wallet credit succeeded, and is paid exactly once.
 *
 * Before: payTournamentPrizes put the tournament in an in-memory "paid" set and
 * then fired one addChipsToUser per winner with failures only logged; the
 * staking settlement stamped paid_out_at BEFORE the backer credits; the Spin &
 * Go settlement zeroed the winner's stack and then credited with a swallowed
 * error. One DB blip lost a prize for good.
 */
import { createPrizeLedger, prizeLedgerStats } from '../src/game/prizeLedger';
import { createFakeLedgerDb } from './helpers/fakeLedgerDb';

const noSleep = async () => {};

describe('prize ledger — one transaction, an idempotent key per credit, retried until it commits', () => {
  it('credits every winner in ONE transaction and records each key', async () => {
    const db = createFakeLedgerDb({ 1: 100, 2: 0 });
    const ledger = createPrizeLedger({ connect: () => db.connect() as any, sleep: noSleep, log: () => {} });
    const r = await ledger.settle({
      label: 'tournament:T1',
      credits: [
        { key: 'T1:1', userId: 1, amount: 500, kind: 'TOURNAMENT_PRIZE' },
        { key: 'T1:2', userId: 2, amount: 300, kind: 'TOURNAMENT_PRIZE' },
      ],
    });
    expect(r.status).toBe('committed');
    expect(r.paid.map((c) => c.key)).toEqual(['T1:1', 'T1:2']);
    expect(db.wallets.get(1)).toBe(600);
    expect(db.wallets.get(2)).toBe(300);
    expect([...db.payouts.keys()]).toEqual(['T1:1', 'T1:2']);
    expect(db.statements.filter((s) => /^BEGIN/.test(s))).toHaveLength(1);
  });

  it('a settlement run twice (a duplicate tournamentFinished, a retry after a lost answer) pays NOTHING the second time', async () => {
    const db = createFakeLedgerDb({ 1: 0 });
    const ledger = createPrizeLedger({ connect: () => db.connect() as any, sleep: noSleep, log: () => {} });
    const s = { label: 'spingo:X', credits: [{ key: 'spingo:X:prize', userId: 1, amount: 1000, kind: 'SPINGO_PRIZE' }] };
    await ledger.settle(s);
    const again = await ledger.settle(s);
    expect(again.status).toBe('committed');
    expect(again.paid).toEqual([]);
    expect(again.alreadyPaid.map((c) => c.key)).toEqual(['spingo:X:prize']);
    expect(db.wallets.get(1)).toBe(1000);
  });

  it('a DB failure in the middle rolls EVERYTHING back (no half-paid field, nothing marked paid) and the retry pays each winner once', async () => {
    const db = createFakeLedgerDb({ 1: 0, 2: 0 });
    // The SECOND credit fails once: the first credit + its ledger row must roll back with it.
    let creditCalls = 0;
    const realConnect = db.connect.bind(db);
    const ledger = createPrizeLedger({
      connect: async () => {
        const c = await realConnect();
        return {
          async query(sql: string, params?: unknown[]) {
            if (/UPDATE users SET chips/.test(sql) && ++creditCalls === 2) throw new Error('blip');
            return c.query(sql, params);
          },
          release: c.release,
        } as any;
      },
      sleep: noSleep, log: () => {},
    });
    const r = await ledger.settle({
      label: 'tournament:T2',
      credits: [
        { key: 'T2:1', userId: 1, amount: 500, kind: 'TOURNAMENT_PRIZE' },
        { key: 'T2:2', userId: 2, amount: 300, kind: 'TOURNAMENT_PRIZE' },
      ],
      extraStatements: [{ sql: 'UPDATE staking_offers SET paid_out_at = NOW() WHERE id = ANY($1::uuid[])', params: [['o1']] }],
    });
    expect(r.status).toBe('committed');
    expect(r.attempts).toBe(2);
    expect(db.wallets.get(1)).toBe(500);   // once — the first attempt's credit was rolled back
    expect(db.wallets.get(2)).toBe(300);
    expect(db.offersMarkedPaid).toEqual([['o1']]);   // marked paid only WITH the credits
  });

  it('a settlement that keeps failing is kept PENDING (nothing paid, nothing marked) and retryPending commits it later — once', async () => {
    const db = createFakeLedgerDb({ 1: 0 });
    const ledger = createPrizeLedger({ connect: () => db.connect() as any, sleep: noSleep, log: () => {}, backoffMs: [0, 0] });
    db.failNext(/UPDATE users SET chips/, 2);
    const before = prizeLedgerStats.failedSettlements;
    const r = await ledger.settle({
      label: 'tournament:T3', credits: [{ key: 'T3:1', userId: 1, amount: 700, kind: 'TOURNAMENT_PRIZE' }],
      extraStatements: [{ sql: 'UPDATE staking_offers SET paid_out_at = NOW() WHERE id = ANY($1::uuid[])', params: [['o9']] }],
    });
    expect(r.status).toBe('failed');
    expect(prizeLedgerStats.failedSettlements).toBe(before + 1);
    expect(db.wallets.get(1)).toBe(0);
    expect(db.payouts.size).toBe(0);
    expect(db.offersMarkedPaid).toEqual([]);
    expect(ledger.pendingLabels()).toEqual(['tournament:T3']);
    expect(await ledger.retryPending()).toBe(1);
    expect(db.wallets.get(1)).toBe(700);
    expect(db.offersMarkedPaid).toEqual([['o9']]);
    expect(ledger.pendingCount()).toBe(0);
    expect(await ledger.retryPending()).toBe(0);
    expect(db.wallets.get(1)).toBe(700);
  });

  it('a credit to a user row that no longer exists is recorded (credited=false), never thrown, and the others are paid', async () => {
    const db = createFakeLedgerDb({ 1: 0 });
    const ledger = createPrizeLedger({ connect: () => db.connect() as any, sleep: noSleep, log: () => {} });
    const r = await ledger.settle({
      label: 'tournament:T4',
      credits: [
        { key: 'T4:gone', userId: 99, amount: 100, kind: 'TOURNAMENT_PRIZE' },
        { key: 'T4:1', userId: 1, amount: 50, kind: 'TOURNAMENT_PRIZE' },
      ],
    });
    expect(r.status).toBe('committed');
    expect(r.noUser.map((c) => c.key)).toEqual(['T4:gone']);
    expect(db.payouts.get('T4:gone')).toMatchObject({ credited: false });
    expect(db.wallets.get(1)).toBe(50);
  });

  it('never credits a non-positive, fractional or keyless amount (dropped before the transaction)', async () => {
    const db = createFakeLedgerDb({ 1: 0 });
    const ledger = createPrizeLedger({ connect: () => db.connect() as any, sleep: noSleep, log: () => {} });
    await ledger.settle({
      label: 'bad',
      credits: [
        { key: 'a', userId: 1, amount: 0, kind: 'X' },
        { key: 'b', userId: 1, amount: -5, kind: 'X' },
        { key: 'c', userId: 1, amount: 1.5, kind: 'X' },
        { key: '', userId: 1, amount: 5, kind: 'X' },
        { key: 'd', userId: 0, amount: 5, kind: 'X' },
      ],
    });
    expect(db.wallets.get(1)).toBe(0);
    expect(db.payouts.size).toBe(0);
  });
});

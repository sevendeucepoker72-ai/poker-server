/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F16) — the
 * UNREGISTER refund goes through the prize ledger (one transaction, an
 * idempotency key, retried), and PENDING prize / refund settlements are
 * persisted so a restart retries them.
 *  - leaveTournament: the fee comes back through prizeLedger.settle with key
 *    `tfee:<tid>:<playerId>:unreg:<entryId>` (per registration: a re-entry and
 *    a later cancel refund are never blocked by it); it was a bare
 *    addChipsToUser (a DB blip lost it for good). A settlement that did not
 *    commit answers refunded 0 + refundPending: true and is retried.
 *  - createPrizeLedger({ persistPending: true }): a settlement that exhausted
 *    its attempts is saved to prize_ledger_pending (label, settlement JSONB);
 *    removed once it commits (or conflicts); loadPersistedPending() at boot
 *    puts them back in the retry list. Off by default (tests / tools).
 */
import { TournamentManager } from '../src/game/TournamentManager';
import { createPrizeLedger, PRIZE_LEDGER_PENDING_DDL } from '../src/game/prizeLedger';
import { handlerSrc, fnSrc, load, flush } from './helpers/indexSource';

/** A tiny Postgres stand-in: users.chips, prize_payouts, prize_ledger_pending, transactions, injected failures. */
function fakeDb(wallets: Record<number, number>) {
  const w = new Map<number, number>(Object.entries(wallets).map(([k, v]) => [Number(k), v]));
  const payouts = new Map<string, any>();
  const pendingRows = new Map<string, string>();
  const fails: Array<{ re: RegExp; n: number }> = [];
  const sql: string[] = [];
  const connect = async () => {
    let tx: { w: Map<number, number>; p: Map<string, any> } | null = null;
    return {
      async query(q: string, params: any[] = []) {
        sql.push(q.replace(/\s+/g, ' ').trim());
        const f = fails.find((x) => x.n > 0 && x.re.test(q));
        if (f) { f.n--; throw new Error('db blip'); }
        if (/^\s*CREATE/i.test(q)) return { rows: [], rowCount: 0 };
        if (/^\s*BEGIN/i.test(q)) { tx = { w: new Map(), p: new Map() }; return { rows: [], rowCount: 0 }; }
        if (/^\s*COMMIT/i.test(q)) { for (const [k, v] of tx!.w) w.set(k, v); for (const [k, v] of tx!.p) payouts.set(k, v); tx = null; return { rows: [], rowCount: 0 }; }
        if (/^\s*ROLLBACK/i.test(q)) { tx = null; return { rows: [], rowCount: 0 }; }
        if (/INSERT INTO prize_payouts/i.test(q)) {
          if (payouts.has(params[0]) || tx?.p.has(params[0])) return { rows: [], rowCount: 0 };
          tx!.p.set(params[0], { userId: params[1], amount: params[2], kind: params[3] });
          return { rows: [{ payout_key: params[0] }], rowCount: 1 };
        }
        if (/UPDATE users SET chips = chips \+/i.test(q)) {
          const cur = tx!.w.has(params[1]) ? tx!.w.get(params[1])! : w.get(params[1]);
          if (cur === undefined) return { rows: [], rowCount: 0 };
          tx!.w.set(params[1], cur + params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO prize_ledger_pending/i.test(q)) { pendingRows.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
        if (/DELETE FROM prize_ledger_pending/i.test(q)) { const had = pendingRows.delete(params[0]); return { rows: [], rowCount: had ? 1 : 0 }; }
        if (/SELECT label, settlement FROM prize_ledger_pending/i.test(q)) {
          return { rows: [...pendingRows].map(([label, s]) => ({ label, settlement: JSON.parse(s) })), rowCount: pendingRows.size };
        }
        throw new Error(`unhandled: ${q.slice(0, 60)}`);
      },
      release() {},
    };
  };
  return { w, payouts, pendingRows, sql, connect, failNext: (re: RegExp, n = 1) => fails.push({ re, n }) };
}

describe('F16 — pending settlements survive a restart', () => {
  it('a settlement that exhausted its attempts is saved; a NEW ledger (the restarted process) loads it and its retry pays once; the row is removed', async () => {
    const db = fakeDb({ 7: 0 });
    const l1 = createPrizeLedger({ connect: db.connect as any, sleep: async () => {}, log: () => {}, backoffMs: [0, 0], persistPending: true } as any);
    db.failNext(/UPDATE users SET chips/, 2);
    const r = await l1.settle({ label: 'tournament:T1', credits: [{ key: 'prize:T1:user-7', userId: 7, amount: 450, kind: 'TOURNAMENT_PRIZE' }] });
    expect(r.status).toBe('failed');
    expect([...db.pendingRows.keys()]).toEqual(['tournament:T1']);                 // e038f7b: memory only (lost at a restart)
    // The restart: a fresh ledger, nothing in memory, loads the row.
    const l2 = createPrizeLedger({ connect: db.connect as any, sleep: async () => {}, log: () => {}, backoffMs: [0], persistPending: true } as any);
    expect(l2.pendingCount()).toBe(0);
    expect(await (l2 as any).loadPersistedPending()).toBe(1);
    expect(l2.pendingCount()).toBe(1);
    expect(await l2.retryPending()).toBe(1);
    expect(db.w.get(7)).toBe(450);
    expect(db.pendingRows.size).toBe(0);
    // A second retry / load pays nothing more.
    expect(await (l2 as any).loadPersistedPending()).toBe(0);
    await l2.retryPending();
    expect(db.w.get(7)).toBe(450);
  });

  it('a settlement that commits at once is never saved; persistence is OFF by default (tests / tools)', async () => {
    const db = fakeDb({ 7: 0 });
    const l = createPrizeLedger({ connect: db.connect as any, sleep: async () => {}, log: () => {}, backoffMs: [0], persistPending: true } as any);
    await l.settle({ label: 'x', credits: [{ key: 'k1', userId: 7, amount: 5, kind: 'TOURNAMENT_PRIZE' }] });
    expect(db.sql.some((q) => /prize_ledger_pending/.test(q) && !/^CREATE/.test(q))).toBe(false);
    const off = fakeDb({ 7: 0 });
    const l0 = createPrizeLedger({ connect: off.connect as any, sleep: async () => {}, log: () => {}, backoffMs: [0] });
    off.failNext(/UPDATE users SET chips/, 1);
    await l0.settle({ label: 'y', credits: [{ key: 'k2', userId: 7, amount: 5, kind: 'TOURNAMENT_PRIZE' }] });
    expect(off.pendingRows.size).toBe(0);
    expect(/^[\x00-\x7F]*$/.test(PRIZE_LEDGER_PENDING_DDL)).toBe(true);
  });
});

describe('F16 — the unregister refund goes through the ledger', () => {
  function world() {
    const db = fakeDb({ 101: 900 });
    const ledger = createPrizeLedger({ connect: db.connect as any, sleep: async () => {}, log: () => {}, backoffMs: [0] });
    const tm = new TournamentManager();
    const tid = (tm.getTournamentList() as any[]).find((x) => x.name === 'Sit & Go').tournamentId;
    const emitted: Array<[string, any]> = [];
    const socket: any = { id: 'S1', emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { socket.h = fn; } };
    const audits: any[] = [];
    const scope: Record<string, unknown> = {
      tournamentManager: tm, playerSessions: new Map(), authSessions: new Map([['S1', { userId: 101, username: 'andy' }]]),
      tournamentViewerOf: () => ({ userId: 101, masterUserId: null }), prizeLedger: ledger,
      addChipsToUser: async () => { throw new Error('a bare credit is not the refund path any more'); },
      auditLog: (actor: string, action: string, d: any) => audits.push([actor, action, d]),
      refundStakesOf: () => Promise.resolve(0), broadcastTournamentList() {}, console: { log() {}, warn() {}, error() {} },
    };
    const { exports: m } = load(`${fnSrc('function tournamentFeeAudit(')}\nfunction wire(socket) {\n${handlerSrc('leaveTournament', '\n  });\n')}\n}`, scope, '{ wire }');
    m.wire(socket);
    const register = () => {
      const r = tm.registerPlayer(tid, 'user-101', 'Andy', 'S1', 101);
      expect(r.success).toBe(true);
      db.w.set(101, (db.w.get(101) ?? 0) - 100);   // the deduct
      return r.entryId!;
    };
    return { db, ledger, tm, tid, emitted, socket, audits, register };
  }

  it('the refund is ONE ledger credit keyed per registration; the wallet gets the fee once; the reply says refunded', async () => {
    const w = world();
    const entryId = w.register();
    await w.socket.h({ tournamentId: w.tid });
    await flush();
    expect(w.db.w.get(101)).toBe(900);
    expect([...w.db.payouts.keys()]).toEqual([`tfee:${w.tid}:user-101:unreg:${entryId}`]);
    expect(w.emitted).toEqual([['tournamentUnregistered', { tournamentId: w.tid, refunded: 100 }]]);
    expect(w.audits.filter((a) => a[1] === 'TOURNAMENT_ENTRY_REFUND')).toEqual([['andy', 'TOURNAMENT_ENTRY_REFUND', { userId: 101, entryFee: 100, amount: 100, reason: 'unregister', tournamentId: w.tid }]]);
  });

  it('a DB blip: refunded 0 + refundPending, audited FAILED (pendingRetry); the ledger retry pays it exactly once', async () => {
    const w = world();
    w.register();
    w.db.failNext(/UPDATE users SET chips/, 1);
    await w.socket.h({ tournamentId: w.tid });
    await flush();
    expect(w.db.w.get(101)).toBe(800);
    expect(w.emitted).toEqual([['tournamentUnregistered', { tournamentId: w.tid, refunded: 0, refundPending: true }]]);
    expect(w.audits.find((a) => a[1] === 'TOURNAMENT_ENTRY_REFUND_FAILED')![2]).toMatchObject({ pendingRetry: true, reason: 'unregister' });
    await w.ledger.retryPending();
    await w.ledger.retryPending();
    expect(w.db.w.get(101)).toBe(900);
  });

  it('unregister, re-register, then the event is cancelled: BOTH refunds are paid (the keys never collide)', async () => {
    const w = world();
    w.register();
    await w.socket.h({ tournamentId: w.tid });
    await flush();
    w.register();
    const regs = w.tm.cancelTournament(w.tid);
    await w.ledger.settle({ label: `tfee:${w.tid}`, credits: regs.filter((r) => r.refund > 0).map((r) => ({ key: `tfee:${w.tid}:${r.playerId}`, userId: r.userId!, amount: r.refund, kind: 'TOURNAMENT_ENTRY_REFUND' })) });
    expect(w.db.w.get(101)).toBe(900);
    expect(w.db.payouts.size).toBe(2);
  });
});

/**
 * R2 (2026-10-11) — a tiny in-memory stand-in for the Postgres statements the
 * prize ledger (src/game/prizeLedger.ts) and the R2 settlement paths run:
 * transactions (BEGIN / COMMIT / ROLLBACK — changes are buffered and only
 * applied on COMMIT), `prize_payouts` inserts with ON CONFLICT DO NOTHING,
 * additive `users.chips` credits and a few `staking_offers` updates. A test
 * can make the next N statements matching a pattern throw (a DB blip).
 */
export interface FakeLedgerDb {
  wallets: Map<number, number>;
  payouts: Map<string, { userId: number; amount: number; kind: string; credited: boolean }>;
  statements: string[];
  failNext(pattern: RegExp, times?: number): void;
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>; release(): void }>;
  offersMarkedPaid: string[][];
  extra: Array<{ sql: string; params: unknown[] }>;
}

export function createFakeLedgerDb(initialWallets: Record<number, number> = {}): FakeLedgerDb {
  const wallets = new Map<number, number>(Object.entries(initialWallets).map(([k, v]) => [Number(k), v]));
  const payouts = new Map<string, { userId: number; amount: number; kind: string; credited: boolean }>();
  const statements: string[] = [];
  const failures: Array<{ pattern: RegExp; times: number }> = [];
  const offersMarkedPaid: string[][] = [];
  const extra: Array<{ sql: string; params: unknown[] }> = [];

  const db: FakeLedgerDb = {
    wallets, payouts, statements, offersMarkedPaid, extra,
    failNext(pattern: RegExp, times = 1) { failures.push({ pattern, times }); },
    async connect() {
      // Per-transaction buffers.
      let inTx = false;
      let pendingWallet = new Map<number, number>();
      let pendingPayouts = new Map<string, { userId: number; amount: number; kind: string; credited: boolean }>();
      let pendingOffers: string[][] = [];
      let pendingExtra: Array<{ sql: string; params: unknown[] }> = [];
      const balance = (uid: number) => (pendingWallet.has(uid) ? pendingWallet.get(uid)! : wallets.get(uid));
      return {
        async query(sql: string, params: unknown[] = []) {
          statements.push(sql.replace(/\s+/g, ' ').trim().slice(0, 80));
          const f = failures.find((x) => x.times > 0 && x.pattern.test(sql));
          if (f) { f.times--; throw new Error('simulated db failure'); }
          if (/^\s*CREATE TABLE/i.test(sql)) return { rows: [], rowCount: 0 };
          if (/^\s*BEGIN/i.test(sql)) { inTx = true; pendingWallet = new Map(); pendingPayouts = new Map(); pendingOffers = []; pendingExtra = []; return { rows: [], rowCount: 0 }; }
          if (/^\s*COMMIT/i.test(sql)) {
            for (const [k, v] of pendingWallet) wallets.set(k, v);
            for (const [k, v] of pendingPayouts) payouts.set(k, v);
            offersMarkedPaid.push(...pendingOffers);
            extra.push(...pendingExtra);
            inTx = false;
            return { rows: [], rowCount: 0 };
          }
          if (/^\s*ROLLBACK/i.test(sql)) { inTx = false; pendingWallet = new Map(); pendingPayouts = new Map(); pendingOffers = []; pendingExtra = []; return { rows: [], rowCount: 0 }; }
          if (/INSERT INTO prize_payouts/i.test(sql)) {
            const [key, userId, amount, kind] = params as [string, number, number, string];
            if (payouts.has(key) || pendingPayouts.has(key)) return { rows: [], rowCount: 0 };
            pendingPayouts.set(key, { userId, amount, kind, credited: true });
            return { rows: [{ payout_key: key }], rowCount: 1 };
          }
          if (/UPDATE prize_payouts SET credited = FALSE/i.test(sql)) {
            const p = pendingPayouts.get(String(params[0]));
            if (p) p.credited = false;
            return { rows: [], rowCount: p ? 1 : 0 };
          }
          if (/UPDATE users SET chips = chips \+ \$1 WHERE id = \$2/i.test(sql)) {
            const [amount, uid] = params as [number, number];
            const b = balance(uid);
            if (b === undefined) return { rows: [], rowCount: 0 };
            pendingWallet.set(uid, b + amount);
            if (!inTx) wallets.set(uid, b + amount);
            return { rows: [], rowCount: 1 };
          }
          if (/UPDATE staking_offers SET paid_out_at/i.test(sql)) {
            pendingOffers.push((params[0] as string[]) || []);
            if (!inTx) offersMarkedPaid.push((params[0] as string[]) || []);
            return { rows: [], rowCount: ((params[0] as string[]) || []).length };
          }
          pendingExtra.push({ sql, params });
          if (!inTx) extra.push({ sql, params });
          return { rows: [], rowCount: 1 };
        },
        release() { /* nothing pooled */ },
      };
    },
  };
  return db;
}

/**
 * R2 (2026-10-11) — an in-memory stand-in for the Postgres statements the R2
 * tournament settlement + staking escrow paths run: users.chips, prize_payouts,
 * staking_offers. A transaction snapshots the whole state at BEGIN and
 * restores it on ROLLBACK (tests run one connection at a time). `failNext`
 * makes the next statement(s) matching a pattern throw (a DB blip).
 */
export interface FakeOffer {
  id: string;
  tournament_id: string;
  total_pct: number;
  price_per_pct: number;
  remaining: number;
  seller_id: number;
  player_name: string;
  backers: any[];
  escrow: boolean;
  created_at: string;
  settled_at: string | null;
  paid_out_at: string | null;
  refunded_at: string | null;
  seller_entry_id: string | null;
}

interface State {
  wallets: Map<number, number>;
  payouts: Map<string, { userId: number; amount: number; kind: string; credited: boolean }>;
  offers: Map<string, FakeOffer>;
}

const clone = (s: State): State => ({
  wallets: new Map(s.wallets),
  payouts: new Map([...s.payouts].map(([k, v]) => [k, { ...v }])),
  offers: new Map([...s.offers].map(([k, v]) => [k, { ...v, backers: JSON.parse(JSON.stringify(v.backers)) }])),
});

export function createFakePokerDb(wallets: Record<number, number> = {}) {
  let state: State = {
    wallets: new Map(Object.entries(wallets).map(([k, v]) => [Number(k), v])),
    payouts: new Map(),
    offers: new Map(),
  };
  const failures: Array<{ pattern: RegExp; times: number }> = [];
  const statements: string[] = [];
  const now = () => new Date().toISOString();

  async function query(sql: string, params: any[] = [], tx?: { snap: State | null }): Promise<{ rows: any[]; rowCount: number }> {
    statements.push(sql.replace(/\s+/g, ' ').trim().slice(0, 90));
    const f = failures.find((x) => x.times > 0 && x.pattern.test(sql));
    if (f) { f.times--; throw new Error('simulated db failure'); }
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER) TABLE/i.test(q) || /^CREATE INDEX/i.test(q)) return { rows: [], rowCount: 0 };
    if (/^BEGIN/i.test(q)) { if (tx) tx.snap = clone(state); return { rows: [], rowCount: 0 }; }
    if (/^COMMIT/i.test(q)) { if (tx) tx.snap = null; return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK/i.test(q)) { if (tx && tx.snap) { state = tx.snap; tx.snap = null; } return { rows: [], rowCount: 0 }; }
    if (/^SELECT 1/i.test(q)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    // ── users ──
    if (/^UPDATE users SET chips = chips \+ \$1 WHERE id = \$2/i.test(q)) {
      const [amount, uid] = params;
      if (!state.wallets.has(uid)) return { rows: [], rowCount: 0 };
      state.wallets.set(uid, state.wallets.get(uid)! + amount);
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE users SET chips = chips - \$1 WHERE id = \$2 AND chips >= \$1/i.test(q)) {
      const [amount, uid] = params;
      const have = state.wallets.get(uid);
      if (have === undefined || have < amount) return { rows: [], rowCount: 0 };
      state.wallets.set(uid, have - amount);
      return { rows: [], rowCount: 1 };
    }
    // ── prize_payouts ──
    if (/^INSERT INTO prize_payouts/i.test(q)) {
      const [key, userId, amount, kind] = params;
      if (state.payouts.has(key)) return { rows: [], rowCount: 0 };
      state.payouts.set(key, { userId, amount, kind, credited: true });
      return { rows: [{ payout_key: key }], rowCount: 1 };
    }
    if (/^UPDATE prize_payouts SET credited = FALSE/i.test(q)) {
      const p = state.payouts.get(params[0]);
      if (p) p.credited = false;
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    // ── staking_offers ──
    if (/^INSERT INTO staking_offers/i.test(q)) {
      const [id, tid, total, price, remaining, seller, name, entry] = params;
      state.offers.set(id, {
        id, tournament_id: tid, total_pct: total, price_per_pct: price, remaining, seller_id: seller, player_name: name,
        backers: [], escrow: /TRUE/i.test(q), created_at: now(), settled_at: null, paid_out_at: null, refunded_at: null,
        seller_entry_id: entry ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT id, seller_id, backers FROM staking_offers WHERE tournament_id = \$1 AND escrow = TRUE/i.test(q)) {
      const [tid, seller] = params;
      const rows = [...state.offers.values()]
        .filter((o) => o.tournament_id === tid && o.escrow && !o.paid_out_at && !o.refunded_at && (seller === null || o.seller_id === seller))
        .map((o) => ({ id: o.id, seller_id: o.seller_id, backers: JSON.parse(JSON.stringify(o.backers)) }));
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT id, seller_id, backers, tournament_id FROM staking_offers WHERE escrow = TRUE AND paid_out_at IS NULL AND refunded_at IS NULL AND created_at < \$1/i.test(q)) {
      const rows = [...state.offers.values()]
        .filter((o) => o.escrow && !o.paid_out_at && !o.refunded_at && o.created_at < params[0])
        .map((o) => ({ id: o.id, seller_id: o.seller_id, backers: JSON.parse(JSON.stringify(o.backers)), tournament_id: o.tournament_id }));
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE staking_offers SET settled_at = COALESCE\(settled_at, NOW\(\)\), paid_out_at = COALESCE\(paid_out_at, NOW\(\)\) WHERE escrow = FALSE/i.test(q)) {
      let n = 0;
      for (const o of state.offers.values()) if (!o.escrow && !o.paid_out_at && o.created_at < params[0]) { o.paid_out_at = now(); o.settled_at = o.settled_at || now(); n++; }
      return { rows: [], rowCount: n };
    }
    if (/^UPDATE staking_offers SET refunded_at = NOW\(\) WHERE id = ANY\(\$1::uuid\[\]\) AND paid_out_at IS NULL AND refunded_at IS NULL RETURNING id/i.test(q)) {
      const rows: any[] = [];
      for (const id of params[0]) { const o = state.offers.get(id); if (o && !o.paid_out_at && !o.refunded_at) { o.refunded_at = now(); rows.push({ id }); } }
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE staking_offers SET paid_out_at = NOW\(\), settled_at = COALESCE\(settled_at, NOW\(\)\) WHERE id = ANY\(\$1::uuid\[\]\) AND paid_out_at IS NULL AND refunded_at IS NULL RETURNING id/i.test(q)) {
      const rows: any[] = [];
      for (const id of params[0]) { const o = state.offers.get(id); if (o && !o.paid_out_at && !o.refunded_at) { o.paid_out_at = now(); o.settled_at = o.settled_at || now(); rows.push({ id }); } }
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE staking_offers SET refunded_at = NOW\(\), paid_out_at = NULL WHERE id = ANY\(\$1::uuid\[\]\)/i.test(q)) {
      let n = 0;
      for (const id of params[0]) { const o = state.offers.get(id); if (o) { o.refunded_at = now(); o.paid_out_at = null; n++; } }
      return { rows: [], rowCount: n };
    }
    if (/^UPDATE staking_offers SET remaining = remaining - \$1/i.test(q)) {
      const [pct, backersJson, id] = params;
      const o = state.offers.get(id);
      if (!o || o.remaining < pct || o.paid_out_at || o.refunded_at) return { rows: [], rowCount: 0 };
      o.remaining -= pct;
      o.backers = [...o.backers, ...JSON.parse(backersJson)];
      if (o.remaining <= 0) o.settled_at = now();
      return { rows: [{ remaining: o.remaining }], rowCount: 1 };
    }
    throw new Error(`fakePokerDb: unhandled SQL: ${q.slice(0, 120)}`);
  }

  const pool = {
    query: (sql: string, params?: any[]) => query(sql, params),
    connect: async () => {
      const tx = { snap: null as State | null };
      return { query: (sql: string, params?: any[]) => query(sql, params, tx), release() { /* no pool */ } };
    },
  };
  return {
    pool,
    get wallets() { return state.wallets; },
    get payouts() { return state.payouts; },
    get offers() { return state.offers; },
    statements,
    failNext(pattern: RegExp, times = 1) { failures.push({ pattern, times }); },
  };
}

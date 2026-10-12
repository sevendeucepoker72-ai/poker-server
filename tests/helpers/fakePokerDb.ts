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

/** R2 (TOURNEY-14 / CLUBS-4) — the club rows the club tournament + club table paths touch. */
export interface FakeClubTournament {
  id: number; clubid: number; name: string; format: string; blindstructure: string; buyin: number; startingchips: number;
  maxplayers: number; status: string; scheduledat: string; startedat: string | null; createdby: number; livetournamentid: string | null;
}
export interface FakeClubReg { tournamentid: number; userid: number; paid: number; transferredat: string | null }
export interface FakeClubTable {
  id: number; clubid: number; tablename: string; variant: string; smallblind: number; bigblind: number; minbuyin: number;
  maxbuyin: number; maxseats: number; isactive: number; tableid: string | null;
}

interface State {
  wallets: Map<number, number>;
  payouts: Map<string, { userId: number; amount: number; kind: string; credited: boolean }>;
  offers: Map<string, FakeOffer>;
  clubs: Map<number, { id: number; name: string }>;
  members: Array<{ clubid: number; userid: number; role: string; status: string }>;
  clubTournaments: Map<number, FakeClubTournament>;
  clubRegs: FakeClubReg[];
  clubTables: Map<number, FakeClubTable>;
}

const clone = (s: State): State => ({
  wallets: new Map(s.wallets),
  payouts: new Map([...s.payouts].map(([k, v]) => [k, { ...v }])),
  offers: new Map([...s.offers].map(([k, v]) => [k, { ...v, backers: JSON.parse(JSON.stringify(v.backers)) }])),
  clubs: new Map([...s.clubs].map(([k, v]) => [k, { ...v }])),
  members: s.members.map((m) => ({ ...m })),
  clubTournaments: new Map([...s.clubTournaments].map(([k, v]) => [k, { ...v }])),
  clubRegs: s.clubRegs.map((r) => ({ ...r })),
  clubTables: new Map([...s.clubTables].map(([k, v]) => [k, { ...v }])),
});

export function createFakePokerDb(wallets: Record<number, number> = {}) {
  let state: State = {
    wallets: new Map(Object.entries(wallets).map(([k, v]) => [Number(k), v])),
    payouts: new Map(),
    offers: new Map(),
    clubs: new Map(),
    members: [],
    clubTournaments: new Map(),
    clubRegs: [],
    clubTables: new Map(),
  };
  let clubSeq = 0;
  const failures: Array<{ pattern: RegExp; times: number }> = [];
  const statements: string[] = [];
  /** R3 (S1-3) — every pg_advisory_xact_lock key taken (in order). */
  const locks: string[] = [];
  const now = () => new Date().toISOString();

  const res = (rows: any[]) => ({ rows, rowCount: rows.length });
  /** The club statements (whitespace-normalized SQL), or null when `q` is not one of them. */
  function clubQuery(q: string, params: any[]): { rows: any[]; rowCount: number } | null {
    const S = state;
    if (/^SELECT \* FROM club_tournaments WHERE id = \$1$/i.test(q)) { const t = S.clubTournaments.get(Number(params[0])); return res(t ? [{ ...t }] : []); }
    if (/^SELECT role FROM club_members WHERE clubId = \$1 AND userId = \$2 AND status = \$3$/i.test(q)) {
      return res(S.members.filter((m) => m.clubid === Number(params[0]) && m.userid === Number(params[1]) && m.status === params[2]).map((m) => ({ role: m.role })));
    }
    if (/^SELECT id FROM club_tournament_registrations WHERE tournamentId = \$1 AND userId = \$2$/i.test(q)) {
      return res(S.clubRegs.filter((r) => r.tournamentid === Number(params[0]) && r.userid === Number(params[1])).map(() => ({ id: 1 })));
    }
    if (/^DELETE FROM club_tournament_registrations WHERE tournamentId = \$1 AND userId = \$2 AND transferredAt IS NULL AND \(SELECT status FROM club_tournaments WHERE id = \$1\) = 'registering' RETURNING paid$/i.test(q)) {
      const t = S.clubTournaments.get(Number(params[0]));
      if (!t || t.status !== 'registering') return res([]);
      const hit = S.clubRegs.filter((r) => r.tournamentid === Number(params[0]) && r.userid === Number(params[1]) && r.transferredat === null);
      S.clubRegs = S.clubRegs.filter((r) => !hit.includes(r));
      return res(hit.map((r) => ({ paid: r.paid })));
    }
    if (/^SELECT COUNT\(\*\)::int as cnt FROM club_tournament_registrations WHERE tournamentId = \$1$/i.test(q)) {
      return res([{ cnt: S.clubRegs.filter((r) => r.tournamentid === Number(params[0])).length }]);
    }
    if (/^INSERT INTO club_tournament_registrations \(tournamentId, userId, paid\) SELECT \$1, \$2, \$3 WHERE \(SELECT status FROM club_tournaments WHERE id = \$1\) = 'registering' ON CONFLICT \(tournamentId, userId\) DO NOTHING RETURNING id$/i.test(q)) {
      const [tid, uid, paid] = params.map(Number);
      if (S.clubTournaments.get(tid)?.status !== 'registering') return res([]);
      if (S.clubRegs.some((r) => r.tournamentid === tid && r.userid === uid)) return res([]);
      S.clubRegs.push({ tournamentid: tid, userid: uid, paid, transferredat: null });
      return res([{ id: S.clubRegs.length }]);
    }
    if (/^UPDATE club_tournaments SET status = 'running', startedAt = now\(\) WHERE id = \$1 AND status = 'registering' RETURNING id$/i.test(q)) {
      const t = S.clubTournaments.get(Number(params[0]));
      if (!t || t.status !== 'registering') return res([]);
      t.status = 'running'; t.startedat = now();
      return res([{ id: t.id }]);
    }
    if (/^UPDATE club_tournament_registrations SET transferredAt = now\(\) WHERE tournamentId = \$1 AND transferredAt IS NULL AND paid >= \$2 RETURNING userId, paid$/i.test(q)) {
      const hit = S.clubRegs.filter((r) => r.tournamentid === Number(params[0]) && r.transferredat === null && r.paid >= Number(params[1]));
      for (const r of hit) r.transferredat = now();
      return res(hit.map((r) => ({ userid: r.userid, paid: r.paid })));
    }
    if (/^DELETE FROM club_tournament_registrations WHERE tournamentId = \$1 AND transferredAt IS NULL RETURNING userId, paid$/i.test(q)) {
      const hit = S.clubRegs.filter((r) => r.tournamentid === Number(params[0]) && r.transferredat === null);
      S.clubRegs = S.clubRegs.filter((r) => !hit.includes(r));
      return res(hit.map((r) => ({ userid: r.userid, paid: r.paid })));
    }
    if (/^UPDATE club_tournaments SET status = 'cancelled' WHERE id = \$1 AND status IN \('registering', 'scheduled'\) RETURNING id$/i.test(q)) {
      const t = S.clubTournaments.get(Number(params[0]));
      if (!t || (t.status !== 'registering' && t.status !== 'scheduled')) return res([]);
      t.status = 'cancelled';
      return res([{ id: t.id }]);
    }
    if (/^UPDATE club_tournaments SET liveTournamentId = \$1 WHERE id = \$2$/i.test(q)) {
      const t = S.clubTournaments.get(Number(params[1]));
      if (t) t.livetournamentid = String(params[0]);
      return res(t ? [{}] : []);
    }
    if (/^UPDATE club_tournaments SET status = \$1 WHERE id = \$2 AND status = 'running' RETURNING id$/i.test(q)) {
      const t = S.clubTournaments.get(Number(params[1]));
      if (!t || t.status !== 'running') return res([]);
      t.status = String(params[0]);
      return res([{ id: t.id }]);
    }
    if (/^UPDATE club_tournaments SET status = \$2 WHERE id = \$1 AND status = 'running' RETURNING id$/i.test(q)) {
      const t = S.clubTournaments.get(Number(params[0]));
      if (!t || t.status !== 'running') return res([]);
      t.status = String(params[1]);
      return res([{ id: t.id }]);
    }
    if (/^SELECT id, liveTournamentId FROM club_tournaments WHERE status = 'running'$/i.test(q)) {
      return res([...S.clubTournaments.values()].filter((t) => t.status === 'running').map((t) => ({ id: t.id, livetournamentid: t.livetournamentid })));
    }
    if (/^SELECT userId, paid FROM club_tournament_registrations WHERE tournamentId = \$1 AND transferredAt IS NOT NULL$/i.test(q)) {
      return res(S.clubRegs.filter((r) => r.tournamentid === Number(params[0]) && r.transferredat !== null).map((r) => ({ userid: r.userid, paid: r.paid })));
    }
    if (/^SELECT 1 FROM prize_payouts WHERE payout_key LIKE \$1 LIMIT 1$/i.test(q)) {
      const prefix = String(params[0]).replace(/%$/, '');
      return res([...S.payouts.keys()].filter((k) => k.startsWith(prefix)).slice(0, 1).map(() => ({ '?column?': 1 })));
    }
    if (/^INSERT INTO club_tournaments \(clubId, name, format, blindStructure, buyIn, startingChips, maxPlayers, status, scheduledAt, createdBy\)/i.test(q)) {
      const id = ++clubSeq;
      const [clubid, name, format, blindstructure, buyin, startingchips, maxplayers, scheduledat, createdby] = params;
      S.clubTournaments.set(id, { id, clubid, name, format, blindstructure, buyin, startingchips, maxplayers, status: 'registering', scheduledat, startedat: null, createdby, livetournamentid: null });
      return res([{ id }]);
    }
    if (/^SELECT \* FROM club_tables WHERE id = \$1$/i.test(q)) { const t = S.clubTables.get(Number(params[0])); return res(t ? [{ ...t }] : []); }
    if (/^SELECT \* FROM club_tables WHERE clubId = \$1 AND isActive = 1$/i.test(q)) {
      return res([...S.clubTables.values()].filter((t) => t.clubid === Number(params[0]) && t.isactive === 1).map((t) => ({ ...t })));
    }
    if (/^UPDATE club_tables SET tableId = \$1 WHERE id = \$2$/i.test(q)) {
      const t = S.clubTables.get(Number(params[1]));
      if (t) t.tableid = String(params[0]);
      return res(t ? [{}] : []);
    }
    if (/^SELECT \* FROM clubs WHERE id = \$1$/i.test(q)) { const c = S.clubs.get(Number(params[0])); return res(c ? [{ id: c.id, name: c.name, clubcode: 'X', ownerid: 1, settings: '{}', description: '' }] : []); }
    return null;
  }

  async function query(sql: string, params: any[] = [], tx?: { snap: State | null }): Promise<{ rows: any[]; rowCount: number }> {
    statements.push(sql.replace(/\s+/g, ' ').trim().slice(0, 90));
    const f = failures.find((x) => x.times > 0 && x.pattern.test(sql));
    if (f) { f.times--; throw new Error('simulated db failure'); }
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER) TABLE/i.test(q) || /^CREATE INDEX/i.test(q)) return { rows: [], rowCount: 0 };
    if (/^BEGIN/i.test(q)) { if (tx) tx.snap = clone(state); return { rows: [], rowCount: 0 }; }
    if (/^COMMIT/i.test(q)) { if (tx) tx.snap = null; return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK/i.test(q)) { if (tx && tx.snap) { state = tx.snap; tx.snap = null; } return { rows: [], rowCount: 0 }; }
    if (/^SELECT 1;?$/i.test(q)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    // ── R2 club tournaments / club tables (TOURNEY-14 / CLUBS-4) ──
    const club = clubQuery(q, params);
    if (club) return club;
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
    // R3 (S1-2) — a refund CLOSES the offer first and plans from the backers it returns.
    if (/^UPDATE staking_offers SET remaining = 0 WHERE id = \$1 AND paid_out_at IS NULL AND refunded_at IS NULL RETURNING backers$/i.test(q)) {
      const o = state.offers.get(params[0]);
      if (!o || o.paid_out_at || o.refunded_at) return { rows: [], rowCount: 0 };
      o.remaining = 0;
      return { rows: [{ backers: JSON.parse(JSON.stringify(o.backers)) }], rowCount: 1 };
    }
    // R3 (S1-3) — createStake: the per (tournament, seller) lock, then his unsettled offered % from the DB.
    if (/^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)::bigint\)$/i.test(q)) {
      locks.push(String(params[0]));
      return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
    }
    if (/^SELECT COALESCE\(SUM\(total_pct\), 0\)::int AS offered FROM staking_offers WHERE tournament_id = \$1 AND seller_id = \$2 AND escrow = TRUE AND paid_out_at IS NULL AND refunded_at IS NULL$/i.test(q)) {
      const [tid, seller] = params;
      const offered = [...state.offers.values()]
        .filter((o) => o.tournament_id === tid && o.seller_id === seller && o.escrow && !o.paid_out_at && !o.refunded_at)
        .reduce((s, o) => s + Number(o.total_pct), 0);
      return { rows: [{ offered }], rowCount: 1 };
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
    // R2 (TOURNEY-14 / CLUBS-4) — club rows.
    get clubTournaments() { return state.clubTournaments; },
    get clubRegs() { return state.clubRegs; },
    get clubTables() { return state.clubTables; },
    get members() { return state.members; },
    get clubs() { return state.clubs; },
    statements,
    locks,
    failNext(pattern: RegExp, times = 1) { failures.push({ pattern, times }); },
  };
}

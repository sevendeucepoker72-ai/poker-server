/**
 * R2 (2026-10-11, S1) — buy-in tournaments, prize settlement and staking.
 *
 * C2 (TOURNEY-5 / TOURNEY-7 / TOURNEY-10 / APPUI-19): one entry per ACCOUNT
 * (`already_registered`), `registered` + `entryId` per asking socket in every
 * list, a stall clock that starts at the FIRST registration, `tournamentCancelled`
 * to every registrant, a stable per-account entrant id that feeds progression.
 * ECON-17: prizes settle in ONE ledger transaction, retried, never marked paid
 * before the credit. C4 (TOURNEY-8 / ECON-15 / APPUI-22): staking on a
 * registered tournament, escrowed until settlement, refunded otherwise.
 * TOURNEY-9: a start never takes over a live cash seat. P3s: field-size payout
 * shares, ties, custom min players, standings for the viewer, ended
 * tournaments pruned, freeroll start rolled forward.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS, payoutSharesFor } from '../src/game/TournamentManager';
import { computeStakingSplit } from '../src/game/staking';
import { planCashedSettlement, planEscrowRefund, validateStakeOffer, normalizeBackers } from '../src/game/stakingEscrow';
import { createPrizeLedger } from '../src/game/prizeLedger';
import { accountDisplayName } from '../src/auth/displayName';
import { SRC, slice, fnSrc, handlerSrc, load, flush, deferred } from './helpers/indexSource';
import { createFakePokerDb } from './helpers/fakePokerDb';

const ALICE = 101;
const BOB = 102;
const CARL = 103;
const tpl = (o: Record<string, unknown> = {}) => ({ name: 'Test Cup', buyIn: 500, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS, ...o } as any);

describe('TournamentManager — one entry per account, the lobby flags, the stall clock', () => {
  it('a second registration by the same ACCOUNT is refused already_registered (whatever its entrant id); each entry has its own entryId', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(tpl());
    const a = tm.registerPlayer(id, 'user-101', 'Alice', 's1', ALICE);
    expect(a).toMatchObject({ success: true, entryId: expect.any(String) });
    expect(tm.registerPlayer(id, 'player-other', 'Alice', 's2', ALICE)).toMatchObject({ success: false, code: 'already_registered' });
    expect(tm.registerPlayer(id, 'q-x', 'Alice', 's3', undefined, 'm-a')).toMatchObject({ success: true });
    expect(tm.registerPlayer(id, 'q-y', 'Alice2', 's4', undefined, 'm-a')).toMatchObject({ success: false, code: 'already_registered' });
    expect(tm.getTournament(id)!.players).toHaveLength(2);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(500);       // only the paying local account funded it
  });

  it('getTournamentList(viewer): registered + entryId for THAT account only', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(tpl());
    const { entryId } = tm.registerPlayer(id, 'user-101', 'Alice', 's1', ALICE) as any;
    const mine = (tm.getTournamentList({ userId: ALICE }) as any[]).find((t) => t.tournamentId === id);
    const bobs = (tm.getTournamentList({ userId: BOB }) as any[]).find((t) => t.tournamentId === id);
    const anon = (tm.getTournamentList() as any[]).find((t) => t.tournamentId === id);
    expect(mine).toMatchObject({ registered: true, entryId });
    expect(bobs).toMatchObject({ registered: false, entryId: null });
    expect(anon).toMatchObject({ registered: false, entryId: null, minPlayers: 4 });
  });

  it('TOURNEY-5 — the stall clock starts at the FIRST registration (not at the template\'s creation at boot); an emptied field starts over', () => {
    const tm = new TournamentManager();
    const t0 = Date.now();
    const id = tm.createTournament(tpl());
    // 2 hours after boot the first player registers: NOT stalled (it used to be cancelled ~10s later).
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 2 * 3600_000);
    tm.registerPlayer(id, 'user-101', 'Alice', 's1', ALICE);
    expect(tm.checkStalledTournaments(t0 + 2 * 3600_000 + 10_000)).toEqual([]);
    expect(tm.checkStalledTournaments(t0 + 2 * 3600_000 + 31 * 60_000)).toEqual([id]);
    tm.unregisterPlayer(id, 'user-101');
    expect(tm.getTournament(id)!.firstRegistrationAt).toBeNull();
    (Date.now as any).mockRestore();
  });

  it('cancelTournament → each paying registrant once; voidRunningTournament → every paying entrant (busted too) and no finish can follow', () => {
    jest.useFakeTimers();
    try {
      const tm = new TournamentManager();
      const id = tm.createTournament(tpl());
      tm.registerPlayer(id, 'user-101', 'Alice', 's1', ALICE);
      tm.registerPlayer(id, 'user-102', 'Bob', 's2', BOB);
      tm.registerPlayer(id, 'user-103', 'Carl', 's3', CARL);
      tm.startTournament(id);
      tm.eliminatePlayer(id, 'user-103');
      let finished = false;
      tm.onEvent(id, (ev) => { if (ev === 'tournamentFinished') finished = true; });
      expect(tm.voidRunningTournament(id).map((r) => [r.userId, r.refund])).toEqual([[ALICE, 500], [BOB, 500], [CARL, 500]]);
      expect(tm.voidRunningTournament(id)).toEqual([]);
      expect(tm.eliminatePlayer(id, 'user-102')).toBeNull();
      expect(finished).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  it('a custom tournament starts at ITS minPlayers (it used to start at 4 whatever its max)', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(tpl({ maxPlayers: 9, minPlayers: 6 }));
    for (let i = 0; i < 5; i++) tm.registerPlayer(id, `p${i}`, `P${i}`, `s${i}`, 200 + i);
    expect(tm.canStart(id)).toBe(false);
    tm.registerPlayer(id, 'p5', 'P5', 's5', 205);
    expect(tm.canStart(id)).toBe(true);
  });

  it('a timed freeroll whose start passed with < 2 players rolls its start forward (never "Starting soon" all day)', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(tpl({ buyIn: 0, prizePool: 1000, startInterval: 30 * 60_000 }));
    const t = tm.getTournament(id)!;
    const start = t.nextStartTime;
    expect(tm.rollOverdueFreerollStarts(start + 5 * 60_000)).toContain(id);
    expect(t.nextStartTime).toBe(start + 30 * 60_000);
    expect(tm.rollOverdueFreerollStarts(start + 6 * 60_000)).not.toContain(id);
  });

  it('ended ad-hoc tournaments (and their listeners) are dropped after an hour; templates are not', () => {
    jest.useFakeTimers();
    try {
      const tm = new TournamentManager();
      const id = tm.createTournament(tpl({ name: 'Custom X' }));
      tm.registerPlayer(id, 'a', 'A', 's1', ALICE); tm.registerPlayer(id, 'b', 'B', 's2', BOB);
      tm.onEvent(id, () => {});
      tm.startTournament(id);
      tm.eliminatePlayer(id, 'b');
      const at = tm.getTournament(id)!.finishedAt!;
      expect(tm.pruneEndedTournaments(at + 59 * 60_000)).toEqual([]);
      expect(tm.pruneEndedTournaments(at + 61 * 60_000)).toEqual([id]);
      expect(tm.getTournament(id)).toBeUndefined();
      expect((tm as any).eventCallbacks.has(id)).toBe(false);
    } finally { jest.useRealTimers(); }
  });
});

describe('P3 — prize shares by the field, and ties', () => {
  it('a heads-up field pays the WHOLE pool (62.5 / 37.5) — its "3rd place" 20% used to vanish; 3+ entrants 50/30/20 as before', () => {
    expect(payoutSharesFor(2)).toEqual([0.625, 0.375]);
    expect(payoutSharesFor(3)).toEqual([0.5, 0.3, 0.2]);
    expect(payoutSharesFor(9)).toEqual([0.5, 0.3, 0.2]);
    jest.useFakeTimers();
    try {
      const tm = new TournamentManager();
      const id = tm.createTournament(tpl({ name: 'HU', buyIn: 1000 }));
      tm.registerPlayer(id, 'a', 'A', 's1', ALICE); tm.registerPlayer(id, 'b', 'B', 's2', BOB);
      let results: any[] = [];
      tm.onEvent(id, (ev, d) => { if (ev === 'tournamentFinished') results = d.results; });
      tm.startTournament(id);
      tm.eliminatePlayer(id, 'b');
      expect(results.map((r) => [r.playerId, r.position, r.payout])).toEqual([['a', 1, 1250], ['b', 2, 750]]);
      expect(results.reduce((s, r) => s + r.payout, 0)).toBe(2000);
    } finally { jest.useRealTimers(); }
  });

  it('two entrants busted in the same hand with EQUAL stacks tie: the money of their places is split equally (not by seat number)', () => {
    jest.useFakeTimers();
    try {
      const tm = new TournamentManager();
      const id = tm.createTournament(tpl({ name: 'Tie Cup', buyIn: 1000 }));
      for (const [p, u] of [['a', ALICE], ['b', BOB], ['c', CARL]] as const) tm.registerPlayer(id, p, p, `s-${p}`, u);
      let results: any[] = [];
      tm.onEvent(id, (ev, d) => { if (ev === 'tournamentFinished') results = d.results; });
      tm.startTournament(id);
      expect(tm.markSimultaneousBustTie(id, ['b', 'c'])).toBe(true);
      tm.eliminatePlayer(id, 'b');
      tm.eliminatePlayer(id, 'c');
      const by = Object.fromEntries(results.map((r) => [r.playerId, r]));
      expect(by.a.payout).toBe(1500);                              // 1st: 50% of 3000
      expect(by.b.payout).toBe(by.c.payout);
      expect(by.b.payout).toBe(Math.floor((900 + 600) / 2));        // (2nd + 3rd) / 2
      expect(by.b.tied && by.c.tied).toBe(true);
      expect(results.reduce((s, r) => s + r.payout, 0)).toBeLessThanOrEqual(3000);
    } finally { jest.useRealTimers(); }
  });

  it('wiring: the bust check marks this hand\'s equal-stack busts as a tie before eliminating them', () => {
    const body = fnSrc('function runTournamentBustCheck(');
    expect(body).toContain('tournamentManager.markSimultaneousBustTie(tournamentId, ids)');
    expect(body.indexOf('markSimultaneousBustTie')).toBeLessThan(body.indexOf('tournamentManager.eliminatePlayer(tournamentId, seat.playerId, eliminatorId)'));
  });
});

describe('staking escrow planning (pure)', () => {
  const offer = (id: string, backers: Array<[number, number, number]>) => ({ id, sellerId: ALICE, backers: backers.map(([userId, pct, paid]) => ({ userId, name: `u${userId}`, pct, paid })) });
  it('the seller CASHES: backers get their share (the computeStakingSplit rule exactly), the escrow is released to him; Σ = payout + escrow', () => {
    const o1 = offer('o1', [[BOB, 20, 2000], [CARL, 10, 1000]]);
    const plan = planCashedSettlement([o1], ALICE, 9000, 'tprize:T:a');
    const split = computeStakingSplit(9000, o1.backers);
    expect(plan.sellerPrize).toMatchObject({ userId: ALICE, amount: split.sellerAmount });
    const shares = plan.credits.filter((c) => c.kind === 'STAKING_PAYOUT');
    expect(shares.map((c) => [c.userId, c.amount])).toEqual(split.backerPayouts.map((b) => [b.userId, b.amount]));
    expect(plan.credits.find((c) => c.kind === 'STAKING_ESCROW_RELEASE')).toMatchObject({ userId: ALICE, amount: 3000, key: 'stake:o1:release' });
    const total = (plan.sellerPrize?.amount || 0) + plan.credits.reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(9000 + 3000);
  });
  it('anything else refunds every backer exactly his escrow; malformed legacy backers are skipped', () => {
    const o = { id: 'o2', sellerId: ALICE, backers: normalizeBackers([{ userId: BOB, pct: 5, paid: 500 }, { name: 'legacy' }, null]) };
    expect(planEscrowRefund(o, 'cancelled').map((c) => [c.userId, c.amount, c.key])).toEqual([[BOB, 500, 'stake:o2:refund:0']]);
  });
  it('C4 offer validation: whole percent 1..100, whole price 1..1,000,000 (the pre-R2 field names still read)', () => {
    expect(validateStakeOffer({ percent: 25, pricePerPercent: 100 })).toEqual({ ok: true, percent: 25, pricePerPercent: 100 });
    expect(validateStakeOffer({ totalPct: 10, pricePerPct: 50 })).toEqual({ ok: true, percent: 10, pricePerPercent: 50 });
    expect(validateStakeOffer({ percent: 0, pricePerPercent: 100 })).toMatchObject({ ok: false, code: 'stake_invalid_offer' });
    expect(validateStakeOffer({ percent: 10.5, pricePerPercent: 100 })).toMatchObject({ ok: false, code: 'stake_invalid_offer' });
    expect(validateStakeOffer({ percent: 10, pricePerPercent: 0 })).toMatchObject({ ok: false, code: 'stake_invalid_price' });
    expect(validateStakeOffer({ percent: 10, pricePerPercent: '5' })).toMatchObject({ ok: false, code: 'stake_invalid_price' });
  });
});

// ─────────────────────────── the real index.ts paths ───────────────────────────
const REG = slice('// ========== Tournament registration — per account, per socket (R2, C2) ==========', "  return userId !== undefined ? `user-${userId}` : `player-${uuidv4()}`;\n}\n");
// 2026-10-24 (Sit & Go fix-all F15) — + the one fee-row helper the refunds audit through.
const REFUND_CANCELLED = fnSrc('function refundCancelledTournamentEntrants(') + '\n' + fnSrc('function tournamentFeeAudit(');
const PRIZES = slice('const paidOutTournaments = new Set<string>();', '    tournamentsSettlingStakes.delete(tid);\n  }\n}\n');
const START = SRC.slice(
  SRC.indexOf('/**\n * R2 (TOURNEY-9) — does this socket PLAY a live seat elsewhere'),
  SRC.indexOf('\n/**\n * Refund the registrants TournamentManager.cancelTournament returned'),
);
const BINDINGS = slice('const registrantBindings = {', 'return bound;\n}\n');
// R2 (C4): the per-socket marketplace view (isMine / own sellerUserId).
const VIEWER = fnSrc('function stakingOffersForViewer(');
const H = {
  registerTournament: handlerSrc('registerTournament', '\n  });\n'),
  getTournaments: handlerSrc('getTournaments', '\n  });\n'),
  getTournamentStandings: handlerSrc('getTournamentStandings', '\n  });\n'),
  leaveTournament: handlerSrc('leaveTournament', '\n  });\n'),
  getStakeableTournaments: handlerSrc('getStakeableTournaments', '\n  });\n'),
  createStake: handlerSrc('createStake', '\n  });\n'),
  buyStake: handlerSrc('buyStake', '\n  });\n'),
};

function world(opts: { wallets?: Record<number, number> } = {}) {
  const db = createFakePokerDb(opts.wallets ?? { [ALICE]: 100_000, [BOB]: 100_000, [CARL]: 100_000 });
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  let n = 0;
  const sockets = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const audits: Array<{ action: string; d: any }> = [];
  const progressCreated: string[] = [];
  const started: string[] = [];
  const ledger = createPrizeLedger({ connect: () => db.pool.connect() as any, sleep: async () => {}, log: () => {}, backoffMs: [0, 0] });
  const scope: Record<string, unknown> = {
    tournamentManager: tm, authSessions, playerSessions, multiTableSessions: new Map(), tournamentTables: new Map(),
    tableManager: {
      getTable: (id: string) => tables.get(id),
      createQuickTable: (name: string, _s: number, sb: number, bb: number, buyIn: number) => {
        const id = `T${++n}`;
        tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: buyIn } as any));
        return id;
      },
    },
    io: { emit() {}, to: () => ({ emit() {}, except: () => ({ emit() {} }) }), sockets: { sockets } },
    getPool: () => db.pool, prizeLedger: ledger, MAX_SEATS: 9, DEFAULT_BLIND_LEVELS,
    auditLog: (_a: string, action: string, d: any) => audits.push({ action, d }),
    addChipsToUser: async (uid: number, amount: number) => { db.wallets.set(uid, (db.wallets.get(uid) ?? 0) + amount); return true; },
    deductChips: async (uid: number, amount: number) => { const h = db.wallets.get(uid) ?? 0; if (h < amount) return false; db.wallets.set(uid, h - amount); return true; },
    ensureChipsForBuyIn: async (uid: number) => db.wallets.get(uid) ?? 0,
    assertPlayable: async () => null, emitPlayRefusal: (s: any, r: any) => s.emit('error', r), buyInSocketGone: async () => false,
    blockedByMaintenance: () => false, stakingSellerSuspended: async () => false,
    seatNameForSocket: (s: any, nm?: unknown) => accountDisplayName(authSessions.get(s.id)?.displayName ?? nm),
    progressionManager: { getOrCreateProgress: (pid: string) => { progressCreated.push(pid); }, recordTournamentResult() {} },
    screenAndStartTournament: async (tid: string) => { started.push(tid); },
    publicStakingOffers: async (o: any[]) => o, publicTournamentStandings: (s: any) => s,
    pushActivity() {}, uuidv4: () => `u-${++n}`, notifyPlayer: async () => {}, ensureTableProgressListener() {},
    broadcastGameState() {}, scheduleAIAction() {}, bootstrapTournamentTables() {}, detachSocketFromOtherTables() {},
    normalizeBackers, planEscrowRefund, planCashedSettlement, validateStakeOffer,
    randomInt: require('crypto').randomInt,   // Sit & Go fix-all F6 (2026-10-24) — the start's seat draw
    console: { log() {}, warn() {}, error() {} },
  };
  const code = `${BINDINGS}\n${VIEWER}\n${REG}\n${REFUND_CANCELLED}\n${PRIZES}\n${START}\nfunction wire(socket) {\n  ${Object.values(H).join('\n  ')}\n}`;
  const { exports: m } = load(code, scope, `{ wire, broadcastTournamentList, tournamentViewerOf, refundCancelledTournamentEntrants, payTournamentPrizes,
    stakingOffers, sweepStakingOffers, bootSweepUnsettledStakes, refundStakesOf, startTournamentGame, tournamentStartsKeptAbsent, stakingStats }`);
  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (id: string, userId: number | null, name: string, master?: string) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = { id, connected: true, handlers, rooms: new Set<string>(), on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, p: any) => emitted.push([id, ev, p]), join() {}, leave() {} };
    sockets.set(id, s);
    if (userId !== null) authSessions.set(id, { userId, username: `${name.toLowerCase()}.x`, masterUserId: master ?? `m-${userId}`, displayName: name });
    m.wire(s);
    return s;
  };
  const of = (id: string, ev: string) => emitted.filter(([sid, e]) => sid === id && e === ev).map(([, , p]) => p);
  return { db, tm, tables, m, scope, sockets, authSessions, playerSessions, audits, progressCreated, started, mkSocket, of, emitted };
}

describe('C2 — registerTournament / getTournaments / leaveTournament (real handlers)', () => {
  it('one entry per account under a STABLE entrant id (user-<id>), a progression entry for it, entryId on the answer; a second tap is refused BEFORE any fee', async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl());
    const s1 = w.mkSocket('S1', ALICE, 'Alice');
    const s2 = w.mkSocket('S2', ALICE, 'Alice');               // the same account, a second tab
    await s1.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    await s2.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    const t = w.tm.getTournament(tid)!;
    expect(t.players.map((p) => p.playerId)).toEqual(['user-101']);
    expect(w.db.wallets.get(ALICE)).toBe(100_000 - 500);           // charged ONCE
    expect(w.progressCreated).toEqual(['user-101']);
    expect(w.of('S1', 'tournamentRegistered')).toEqual([{ tournamentId: tid, entryId: t.players[0].entryId }]);
    expect(w.of('S2', 'error')).toEqual([expect.objectContaining({ code: 'already_registered', tournamentId: tid })]);
  });

  it('the list carries registered + entryId for the ASKING socket (every socket its own copy on a broadcast)', async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl());
    const a = w.mkSocket('SA', ALICE, 'Alice');
    w.mkSocket('SB', BOB, 'Bob');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    w.emitted.length = 0;
    w.m.broadcastTournamentList();
    const pick = (sid: string) => (w.of(sid, 'tournamentList')[0] as any[]).find((x) => x.tournamentId === tid);
    expect(pick('SA')).toMatchObject({ registered: true, entryId: expect.any(String) });
    expect(pick('SB')).toMatchObject({ registered: false, entryId: null });
    a.handlers.getTournaments();
    expect((w.of('SA', 'tournamentList')[1] as any[]).find((x) => x.tournamentId === tid).registered).toBe(true);
  });

  it('leaveTournament finds the ACCOUNT\'s entry (any of his sockets) and refunds it once', async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl());
    const a = w.mkSocket('SA', ALICE, 'Alice');
    const a2 = w.mkSocket('SA2', ALICE, 'Alice');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    await a2.handlers.leaveTournament({ tournamentId: tid });
    await a.handlers.leaveTournament({ tournamentId: tid });
    expect(w.db.wallets.get(ALICE)).toBe(100_000);
    expect(w.of('SA2', 'tournamentUnregistered')).toEqual([{ tournamentId: tid, refunded: 500 }]);
    expect(w.of('SA', 'tournamentUnregistered')).toEqual([{ tournamentId: tid, refunded: 0 }]);
  });

  it('a cancelled tournament TELLS every registrant: tournamentCancelled {tournamentId, refunded, reason}', async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl());
    const a = w.mkSocket('SA', ALICE, 'Alice');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    const regs = w.tm.cancelTournament(tid);
    w.m.refundCancelledTournamentEntrants(tid, regs, 'tournament_cancelled_stalled');
    await flush();
    expect(w.of('SA', 'tournamentCancelled')).toEqual([{ tournamentId: tid, refunded: 500, reason: 'tournament_cancelled_stalled' }]);
    expect(w.db.wallets.get(ALICE)).toBe(100_000);
  });

  it('standings without an id: the VIEWER\'s running tournament, not simply the first running one', async () => {
    const w = world();
    const other = w.tm.createTournament(tpl({ name: 'Other', buyIn: 0 }));
    w.tm.registerPlayer(other, 'x1', 'X1', 'sx1', 501); w.tm.registerPlayer(other, 'x2', 'X2', 'sx2', 502); w.tm.startTournament(other);
    const mine = w.tm.createTournament(tpl({ name: 'Mine', buyIn: 0 }));
    w.tm.registerPlayer(mine, 'user-101', 'Alice', 'SA', ALICE); w.tm.registerPlayer(mine, 'y', 'Y', 'sy', 503); w.tm.startTournament(mine);
    const a = w.mkSocket('SA', ALICE, 'Alice');
    a.handlers.getTournamentStandings();                         // no payload at all (the guard never rejects it)
    expect(w.of('SA', 'tournamentStandings')[0]).toMatchObject({ tournamentId: mine, name: 'Mine' });
  });
});

describe('ECON-17 — tournament prizes settle through the ledger: once, never "paid" before the credit', () => {
  const finish = (w: ReturnType<typeof world>, buyIn = 1000) => {
    const tid = w.tm.createTournament(tpl({ name: 'Ledger Cup', buyIn }));
    for (const [p, u] of [['user-101', ALICE], ['user-102', BOB], ['user-103', CARL]] as const) w.tm.registerPlayer(tid, p, p, `s-${p}`, u);
    let data: any = null;
    w.tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
    w.tm.startTournament(tid);
    w.tm.eliminatePlayer(tid, 'user-103');
    w.tm.eliminatePlayer(tid, 'user-102');
    return { tid, data };
  };

  it('every prize credited once; a duplicate tournamentFinished pays nothing more', async () => {
    jest.useFakeTimers();
    try {
      const w = world({ wallets: { [ALICE]: 0, [BOB]: 0, [CARL]: 0 } });
      const { tid, data } = finish(w);
      await w.m.payTournamentPrizes(data);
      await w.m.payTournamentPrizes(data);
      expect([w.db.wallets.get(ALICE), w.db.wallets.get(BOB), w.db.wallets.get(CARL)]).toEqual([1500, 900, 600]);
      expect([...w.db.payouts.keys()].sort()).toEqual([`tprize:${tid}:${data.results[0].entryId}`, `tprize:${tid}:${data.results[1].entryId}`, `tprize:${tid}:${data.results[2].entryId}`].sort());
    } finally { jest.useRealTimers(); }
  });

  it('a DB failure leaves nothing half-paid; the pending settlement later pays each winner exactly once', async () => {
    jest.useFakeTimers();
    try {
      const w = world({ wallets: { [ALICE]: 0, [BOB]: 0, [CARL]: 0 } });
      const { data } = finish(w);
      w.db.failNext(/UPDATE users SET chips = chips \+/, 2);   // both attempts of the settlement fail
      await w.m.payTournamentPrizes(data);
      expect([w.db.wallets.get(ALICE), w.db.wallets.get(BOB)]).toEqual([0, 0]);
      expect(w.db.payouts.size).toBe(0);
      expect(w.audits.map((a) => a.action)).toContain('TOURNAMENT_PRIZE_PENDING_RETRY');
      await (w.scope.prizeLedger as any).retryPending();
      await (w.scope.prizeLedger as any).retryPending();
      expect([w.db.wallets.get(ALICE), w.db.wallets.get(BOB), w.db.wallets.get(CARL)]).toEqual([1500, 900, 600]);
    } finally { jest.useRealTimers(); }
  });
});

describe('C4 — staking: a registered tournament, escrow, settlement or refund (real handlers + settlement)', () => {
  const setup = async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ name: 'Stake Cup', buyIn: 1000 }));
    const a = w.mkSocket('SA', ALICE, 'Alice');
    const b = w.mkSocket('SB', BOB, 'Bob');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    return { w, tid, a, b };
  };

  it('getStakeableTournaments lists the tournaments he is registered in (myStakeableTournaments)', async () => {
    const { w, tid, a, b } = await setup();
    a.handlers.getStakeableTournaments();
    b.handlers.getStakeableTournaments();
    expect(w.of('SA', 'myStakeableTournaments')).toEqual([[{ tournamentId: tid, name: 'Stake Cup', startsAt: null }]]);
    expect(w.of('SB', 'myStakeableTournaments')).toEqual([[]]);
  });

  it('createStake: only for a tournament he is REGISTERED in (stake_not_registered), never more than 100% in total', async () => {
    const { w, tid, a, b } = await setup();
    await b.handlers.createStake({ tournamentId: tid, percent: 10, pricePerPercent: 50 });
    expect(w.of('SB', 'error')).toEqual([expect.objectContaining({ code: 'stake_not_registered' })]);
    await a.handlers.createStake({ tournamentId: 'Sunday Million', percent: 10, pricePerPercent: 50 });
    expect(w.of('SA', 'error')).toEqual([expect.objectContaining({ code: 'stake_not_registered' })]);
    await a.handlers.createStake({ tournamentId: tid, percent: 60, pricePerPercent: 50 });
    await a.handlers.createStake({ tournamentId: tid, percent: 50, pricePerPercent: 50 });
    expect(w.of('SA', 'error').map((e) => e.code)).toEqual(['stake_not_registered', 'stake_invalid_offer']);
    expect(w.of('SA', 'stakeCreated')).toEqual([expect.objectContaining({ tournamentId: tid, percent: 60, pricePerPercent: 50 })]);
  });

  it('buyStake ESCROWS: the backer pays, the seller is NOT credited; then the seller cashes → share + escrow released, offers marked paid', async () => {
    jest.useFakeTimers();
    try {
      const { w, tid, a, b } = await setup();
      await a.handlers.createStake({ tournamentId: tid, percent: 20, pricePerPercent: 100 });
      const offerId = w.of('SA', 'stakeCreated')[0].id;
      await b.handlers.buyStake({ offerId, pct: 20 });
      expect(w.of('SB', 'buyStakeResult')).toEqual([{ success: true, offerId }]);
      expect(w.db.wallets.get(BOB)).toBe(100_000 - 2000);
      expect(w.db.wallets.get(ALICE)).toBe(100_000 - 1000);       // only her entry fee — nothing from Bob yet
      // The field: Alice + 2 more; Alice wins.
      w.tm.registerPlayer(tid, 'user-103', 'Carl', 's3', CARL);
      w.tm.registerPlayer(tid, 'p4', 'Dee', 's4', 104);
      let data: any = null;
      w.tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
      w.tm.startTournament(tid);
      w.tm.eliminatePlayer(tid, 'p4'); w.tm.eliminatePlayer(tid, 'user-103');
      await w.m.payTournamentPrizes(data);
      // pool 3000 (3 paying: Alice, Carl, Dee) — 1st 1500: Bob 20% = 300; Alice 1200 + Bob's 2,000 escrow.
      expect(w.db.wallets.get(BOB)).toBe(100_000 - 2000 + 300);
      expect(w.db.wallets.get(ALICE)).toBe(100_000 - 1000 + 1200 + 2000);
      expect(w.db.offers.get(offerId)).toMatchObject({ paid_out_at: expect.any(String), refunded_at: null });
    } finally { jest.useRealTimers(); }
  });

  it('the seller busts OUT OF THE MONEY → every backer gets his escrow back (nothing to the seller)', async () => {
    jest.useFakeTimers();
    try {
      const { w, tid, a, b } = await setup();
      await a.handlers.createStake({ tournamentId: tid, percent: 30, pricePerPercent: 10 });
      const offerId = w.of('SA', 'stakeCreated')[0].id;
      await b.handlers.buyStake({ offerId, pct: 30 });
      for (const [p, u] of [['user-103', CARL], ['p4', 104], ['p5', 105]] as const) w.tm.registerPlayer(tid, p, p, `s-${p}`, u);
      let data: any = null;
      w.tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
      w.tm.startTournament(tid);
      w.tm.eliminatePlayer(tid, 'user-101');                       // Alice 4th — no prize
      w.tm.eliminatePlayer(tid, 'p5'); w.tm.eliminatePlayer(tid, 'p4');
      await w.m.payTournamentPrizes(data);
      expect(w.db.wallets.get(BOB)).toBe(100_000);                 // escrow back
      expect(w.db.wallets.get(ALICE)).toBe(100_000 - 1000);
      expect(w.db.offers.get(offerId)).toMatchObject({ refunded_at: expect.any(String), paid_out_at: null });
      // C4 (K3) — the backer is TOLD: stakeRefunded {offerId, tournamentId, amount, reason}.
      expect(w.of('SB', 'stakeRefunded')).toEqual([{ offerId, tournamentId: tid, amount: 300, reason: 'not_in_the_money' }]);
    } finally { jest.useRealTimers(); }
  });

  it('the marketplace goes to EVERY socket with ITS isMine (by account) — the seller id only on his own offer', async () => {
    const { w, tid, a } = await setup();
    await a.handlers.createStake({ tournamentId: tid, percent: 10, pricePerPercent: 100 });
    await flush();
    const last = (sid: string) => { const l = w.of(sid, 'stakingUpdated'); return l[l.length - 1].offers; };
    expect(last('SA')).toEqual([expect.objectContaining({ tournamentId: tid, isMine: true, sellerUserId: ALICE })]);
    expect(last('SB')).toEqual([expect.objectContaining({ tournamentId: tid, isMine: false, sellerUserId: null })]);
  });

  it('the seller UNREGISTERS → his backers refunded once; a buy after the start is refused', async () => {
    const { w, tid, a, b } = await setup();
    await a.handlers.createStake({ tournamentId: tid, percent: 10, pricePerPercent: 100 });
    const offerId = w.of('SA', 'stakeCreated')[0].id;
    await b.handlers.buyStake({ offerId, pct: 5 });
    await a.handlers.leaveTournament({ tournamentId: tid });
    await flush(); await flush();
    expect(w.db.wallets.get(BOB)).toBe(100_000);
    expect(w.db.offers.get(offerId)!.refunded_at).toEqual(expect.any(String));
    expect(w.of('SB', 'stakeRefunded')).toEqual([{ offerId, tournamentId: tid, amount: 500, reason: 'seller_unregistered' }]);
    await b.handlers.buyStake({ offerId, pct: 5 });
    expect(w.of('SB', 'buyStakeResult')[1]).toEqual({ success: false, error: 'Offer unavailable', offerId });
  });

  it('a cancelled tournament refunds its backers (with the entrants); the sweep and the boot sweep refund offers whose tournament is gone — each offer ONCE', async () => {
    const { w, tid, a, b } = await setup();
    await a.handlers.createStake({ tournamentId: tid, percent: 10, pricePerPercent: 100 });
    const offerId = w.of('SA', 'stakeCreated')[0].id;
    await b.handlers.buyStake({ offerId, pct: 10 });
    const regs = w.tm.cancelTournament(tid);
    w.m.refundCancelledTournamentEntrants(tid, regs, 'cancelled_test');
    for (let i = 0; i < 4; i++) await flush();
    await w.m.sweepStakingOffers();
    await w.m.bootSweepUnsettledStakes();
    expect(w.db.wallets.get(BOB)).toBe(100_000);                   // refunded exactly once
    expect([...w.db.payouts.keys()].filter((k) => k.startsWith(`stake:${offerId}`))).toEqual([`stake:${offerId}:refund:0`]);
  });
});

describe('TOURNEY-9 / multi-table — a start never takes over a live cash seat; more than 9 entrants are all seated', () => {
  it('a registrant whose socket PLAYS a cash seat: his tournament seat is dealt ABSENT, he is told tournamentSeatKept (atStart), his cash session untouched', () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ buyIn: 0, name: 'Start Cup' }));
    const cash = new PokerTable({ tableId: 'cash', tableName: 'cash', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
    cash.sitDown(2, 'Alice', 5000, 'p-cash', false);
    w.tables.set('cash', cash);
    w.mkSocket('SA', ALICE, 'Alice');
    w.mkSocket('SB', BOB, 'Bob');
    const cashSession = { socketId: 'SA', tableId: 'cash', seatIndex: 2, playerName: 'Alice', playerId: 'p-cash' };
    w.playerSessions.set('SA', cashSession);
    w.tm.registerPlayer(tid, 'user-101', 'Alice', 'SA', ALICE);
    w.tm.registerPlayer(tid, 'user-102', 'Bob', 'SB', BOB);
    w.m.startTournamentGame(tid);
    expect(w.playerSessions.get('SA')).toBe(cashSession);
    expect(w.playerSessions.get('SB')).toMatchObject({ playerId: 'user-102' });
    expect(w.of('SA', 'tournamentSeatKept')).toEqual([expect.objectContaining({ tournamentId: tid, atStart: true, tournamentName: 'Start Cup' })]);
    expect(w.of('SA', 'tournamentStarted')).toEqual([]);
    expect(w.tm.getTournament(tid)!.players.find((p) => p.playerId === 'user-101')!.socketId).toBe('');
    expect(w.m.tournamentStartsKeptAbsent.seats).toBe(1);
  });

  it('12 registrants → 2 balanced tables, every one of them seated (a single-table start dealt only 9)', () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ buyIn: 0, name: 'Big Cup', maxPlayers: 18 }));
    for (let i = 0; i < 12; i++) w.tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, 300 + i);
    w.m.startTournamentGame(tid);
    const t = w.tm.getTournament(tid)!;
    expect(t.tableIds).toHaveLength(2);
    const seated = t.tableIds.map((id) => w.tables.get(id)!.seats.filter((s) => s.state === 'occupied').length);
    expect(seated).toEqual([6, 6]);
    for (const p of t.players) expect(t.playerTableMap.get(p.playerId)).toBeTruthy();
  });
});

// ─────────────────────────── R3 (2026-10-11, SF-A) ───────────────────────────
describe('R3 (S1-2 / S1-3 / K3-3) — staking: a refund never loses a backer, the 100% cap counts sold-out offers, a payout names its offer', () => {
  /** Alice registered + a 50% escrow offer at 100/pct; Bob already backs 10% (1,000 escrowed). */
  const offerWithOneBacker = async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ name: 'Race Cup', buyIn: 1000 }));
    const a = w.mkSocket('SA', ALICE, 'Alice');
    const b = w.mkSocket('SB', BOB, 'Bob');
    const c = w.mkSocket('SC', CARL, 'Carl');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    await a.handlers.createStake({ tournamentId: tid, percent: 50, pricePerPercent: 100 });
    const offerId = w.of('SA', 'stakeCreated')[0].id;
    await b.handlers.buyStake({ offerId, pct: 10 });
    expect(w.db.wallets.get(BOB)).toBe(100_000 - 1000);
    return { w, tid, a, b, c, offerId };
  };
  /** Carl's purchase (20% = 2,000) passes its in-memory checks, then waits on the seller check until released. */
  const carlBuysWaiting = (w: ReturnType<typeof world>, c: any, offerId: string) => {
    const sellerCheck = deferred();
    w.scope.stakingSellerSuspended = async () => { await sellerCheck.p; return false; };
    const done = c.handlers.buyStake({ offerId, pct: 20 });
    return { sellerCheck, done };
  };

  it('S1-2: a purchase that COMMITS between the refund\'s read and its settlement is refunded too (the offer is closed first; its returned backers are planned)', async () => {
    const { w, tid, c, offerId } = await offerWithOneBacker();
    const carl = carlBuysWaiting(w, c, offerId);
    await flush();
    // The refund reads the offer, then its close waits — Carl's purchase commits meanwhile.
    const closeGate = deferred();
    const pool = w.db.pool;
    w.scope.getPool = () => ({
      ...pool,
      query: async (sql: string, params?: any[]) => { if (/SET remaining = 0/.test(sql)) await closeGate.p; return pool.query(sql, params); },
    });
    const refund = w.m.refundStakesOf(tid, 'seller_unregistered', ALICE);
    await flush();
    carl.sellerCheck.resolve();
    await carl.done; await flush();
    expect(w.of('SC', 'buyStakeResult')).toEqual([{ success: true, offerId }]);
    expect(w.db.wallets.get(CARL)).toBe(100_000 - 2000);
    closeGate.resolve();
    expect(await refund).toBe(1);
    await flush();
    expect([w.db.wallets.get(BOB), w.db.wallets.get(CARL)]).toEqual([100_000, 100_000]);   // both escrows back
    expect([...w.db.payouts.keys()].sort()).toEqual([`stake:${offerId}:refund:0`, `stake:${offerId}:refund:1`]);
    expect(w.db.offers.get(offerId)).toMatchObject({ remaining: 0, refunded_at: expect.any(String) });
    expect(w.of('SC', 'stakeRefunded')).toEqual([{ offerId, tournamentId: tid, amount: 2000, reason: 'seller_unregistered' }]);
  });

  it('S1-2: a purchase that arrives AFTER the close is refused and charged nothing (the closed offer has nothing left to sell)', async () => {
    const { w, tid, c, offerId } = await offerWithOneBacker();
    const carl = carlBuysWaiting(w, c, offerId);
    await flush();
    expect(await w.m.refundStakesOf(tid, 'seller_unregistered', ALICE)).toBe(1);
    carl.sellerCheck.resolve();
    await carl.done; await flush();
    expect(w.of('SC', 'buyStakeResult')).toEqual([{ success: false, error: 'Offer unavailable', offerId }]);
    expect([w.db.wallets.get(BOB), w.db.wallets.get(CARL)]).toEqual([100_000, 100_000]);
    expect(w.db.offers.get(offerId)!.backers.map((x: any) => x.userId)).toEqual([BOB]);
  });

  it('S1-2: the boot sweep goes through the same close (it refunds what the offer holds NOW, once)', async () => {
    const { w, offerId } = await offerWithOneBacker();
    w.db.offers.get(offerId)!.created_at = new Date(Date.now() - 3600_000).toISOString();   // a previous process's offer
    await w.m.bootSweepUnsettledStakes();
    await w.m.bootSweepUnsettledStakes();
    expect(w.db.wallets.get(BOB)).toBe(100_000);
    expect([...w.db.payouts.keys()]).toEqual([`stake:${offerId}:refund:0`]);
  });

  it('CONTROL — S1-2: planned from the backers read BEFORE the settlement (the pre-R3 refund), Carl\'s committed purchase is never refunded', async () => {
    const start = PRIZES.indexOf('    let backers: EscrowBacker[] | null;');
    const endNeedle = '    const credits = planEscrowRefund({ ...offer, backers }, reason);';
    const end = PRIZES.indexOf(endNeedle);
    expect([start > 0, end > start]).toEqual([true, true]);
    const prePrizes = `${PRIZES.slice(0, start)}    const credits = planEscrowRefund(offer, reason);${PRIZES.slice(end + endNeedle.length)}`;
    const code = `${BINDINGS}\n${VIEWER}\n${REG}\n${REFUND_CANCELLED}\n${prePrizes}\n${START}\nfunction wire(socket) {\n  ${Object.values(H).join('\n  ')}\n}`;
    const { w, tid, c, offerId } = await offerWithOneBacker();
    const { exports: pre } = load(code, w.scope, '{ refundStakesOf }');
    const carl = carlBuysWaiting(w, c, offerId);
    await flush();
    const ledgerGate = deferred();
    const pool = w.db.pool;
    w.scope.prizeLedger = createPrizeLedger({ connect: async () => { await ledgerGate.p; return pool.connect() as any; }, sleep: async () => {}, log: () => {}, backoffMs: [0] });
    const refund = pre.refundStakesOf(tid, 'seller_unregistered', ALICE);
    await flush();
    carl.sellerCheck.resolve();
    await carl.done; await flush();
    ledgerGate.resolve();
    await refund; await flush();
    expect(w.db.wallets.get(BOB)).toBe(100_000);
    expect(w.db.wallets.get(CARL)).toBe(100_000 - 2000);                      // his escrow: lost
    expect(w.db.offers.get(offerId)!.refunded_at).toEqual(expect.any(String));  // and the offer closed for good
  });

  it('S1-3: after an offer SELLS OUT the seller still cannot sell more than 100% of his action in total', async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ name: 'Cap Cup', buyIn: 1000 }));
    const a = w.mkSocket('SA', ALICE, 'Alice');
    const b = w.mkSocket('SB', BOB, 'Bob');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    await a.handlers.createStake({ tournamentId: tid, percent: 100, pricePerPercent: 10 });
    const offerId = w.of('SA', 'stakeCreated')[0].id;
    await b.handlers.buyStake({ offerId, pct: 100 });
    expect(w.m.stakingOffers.has(offerId)).toBe(false);                       // sold out: off the marketplace
    await a.handlers.createStake({ tournamentId: tid, percent: 10, pricePerPercent: 10 });
    expect(w.of('SA', 'error')).toEqual([{ message: 'You can sell at most 0% more of this tournament.', code: 'stake_invalid_offer' }]);
    expect(w.of('SA', 'stakeCreated')).toHaveLength(1);
    expect([...w.db.offers.values()].filter((o) => o.seller_id === ALICE)).toHaveLength(1);
  });

  it('S1-3: the check and the insert are ONE transaction under the per (tournament, seller) advisory lock — lock, then sum, then insert', async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ name: 'Lock Cup', buyIn: 1000 }));
    const a = w.mkSocket('SA', ALICE, 'Alice');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    w.db.statements.length = 0;
    await a.handlers.createStake({ tournamentId: tid, percent: 40, pricePerPercent: 10 });
    const seq = w.db.statements
      .filter((s) => /^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory|SELECT COALESCE\(SUM|INSERT INTO staking_offers)/.test(s))
      .map((s) => s.split(' ').slice(0, 3).join(' '));
    expect(seq).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', 'SELECT COALESCE(SUM(total_pct), 0)::int', 'INSERT INTO staking_offers', 'COMMIT']);
    expect(w.db.locks).toEqual([`stake_offer:${tid}:${ALICE}`]);
    // A refused offer rolls back (nothing inserted, the lock released with the transaction).
    await a.handlers.createStake({ tournamentId: tid, percent: 61, pricePerPercent: 10 });
    expect(w.of('SA', 'error')).toEqual([expect.objectContaining({ code: 'stake_invalid_offer', message: 'You can sell at most 60% more of this tournament.' })]);
    expect(w.db.statements[w.db.statements.length - 1]).toBe('ROLLBACK');
  });

  it('K3-3: stakingPayout names its offer (offerId) — the backer\'s client settles THAT stake', async () => {
    jest.useFakeTimers();
    try {
      const w = world();
      const tid = w.tm.createTournament(tpl({ name: 'Pay Cup', buyIn: 1000 }));
      const a = w.mkSocket('SA', ALICE, 'Alice');
      const b = w.mkSocket('SB', BOB, 'Bob');
      await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
      await a.handlers.createStake({ tournamentId: tid, percent: 20, pricePerPercent: 100 });
      const offerId = w.of('SA', 'stakeCreated')[0].id;
      await b.handlers.buyStake({ offerId, pct: 20 });
      w.tm.registerPlayer(tid, 'user-103', 'Carl', 's3', CARL);
      w.tm.registerPlayer(tid, 'p4', 'Dee', 's4', 104);
      let data: any = null;
      w.tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
      w.tm.startTournament(tid);
      w.tm.eliminatePlayer(tid, 'p4'); w.tm.eliminatePlayer(tid, 'user-103');
      await w.m.payTournamentPrizes(data);
      expect(w.of('SB', 'stakingPayout')).toEqual([{ amount: 300, sellerName: 'Alice', tournamentId: tid, offerId }]);
    } finally { jest.useRealTimers(); }
  });
});

describe('R3 (TOURNEY-P3-3) — a cancelled tournament\'s entry fees are refunded through the prize ledger (durable, once, retried)', () => {
  const cancelled = async () => {
    const w = world();
    const tid = w.tm.createTournament(tpl({ name: 'Void Cup', buyIn: 500 }));
    const a = w.mkSocket('SA', ALICE, 'Alice');
    const b = w.mkSocket('SB', BOB, 'Bob');
    await a.handlers.registerTournament({ tournamentId: tid, playerName: 'Alice' });
    await b.handlers.registerTournament({ tournamentId: tid, playerName: 'Bob' });
    const regs = w.tm.cancelTournament(tid);
    return { w, tid, regs };
  };

  it('one ledger settlement keyed per tournament + entrant (tfee:<tid>:<playerId> — the shutdown flush\'s key); a repeat pays nothing more', async () => {
    const { w, tid, regs } = await cancelled();
    w.m.refundCancelledTournamentEntrants(tid, regs, 'tournament_cancelled_stalled');
    await flush();
    w.m.refundCancelledTournamentEntrants(tid, regs, 'tournament_cancelled_stalled');
    await flush();
    expect([w.db.wallets.get(ALICE), w.db.wallets.get(BOB)]).toEqual([100_000, 100_000]);
    expect([...w.db.payouts.keys()].sort()).toEqual([`tfee:${tid}:user-101`, `tfee:${tid}:user-102`]);
    expect(w.db.payouts.get(`tfee:${tid}:user-101`)).toMatchObject({ userId: ALICE, amount: 500, kind: 'TOURNAMENT_ENTRY_REFUND' });
    // F15 (2026-10-24) — the one fee-row shape: {userId, entryFee, amount, reason, tournamentId}.
    expect(w.audits.filter((x) => x.action === 'TOURNAMENT_ENTRY_REFUND').map((x) => x.d)).toEqual([
      { userId: ALICE, entryFee: 500, tournamentId: tid, amount: 500, reason: 'tournament_cancelled_stalled' },
      { userId: BOB, entryFee: 500, tournamentId: tid, amount: 500, reason: 'tournament_cancelled_stalled' },
    ]);
  });

  it('a DB blip: nothing half-paid, audited FAILED (pendingRetry), and the ledger\'s retry pays each entrant exactly once', async () => {
    const { w, tid, regs } = await cancelled();
    w.db.failNext(/UPDATE users SET chips = chips \+/, 2);                   // both attempts of the settlement fail
    w.m.refundCancelledTournamentEntrants(tid, regs, 'tournament_cancelled_stalled');
    await flush();
    expect([w.db.wallets.get(ALICE), w.db.wallets.get(BOB)]).toEqual([100_000 - 500, 100_000 - 500]);
    expect(w.db.payouts.size).toBe(0);
    expect(w.audits.filter((x) => x.action === 'TOURNAMENT_ENTRY_REFUND_FAILED').map((x) => x.d.pendingRetry)).toEqual([true, true]);
    await (w.scope.prizeLedger as any).retryPending();
    await (w.scope.prizeLedger as any).retryPending();
    expect([w.db.wallets.get(ALICE), w.db.wallets.get(BOB)]).toEqual([100_000, 100_000]);
    // Every registrant was still told at once.
    expect(w.of('SA', 'tournamentCancelled')).toEqual([{ tournamentId: tid, refunded: 500, reason: 'tournament_cancelled_stalled' }]);
  });

  it('the entry-fee moves keep a durable audit row (DURABLE_AUDIT_ACTIONS)', () => {
    const durable = slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);');
    for (const a of ['TOURNAMENT_ENTRY_DEDUCT', 'TOURNAMENT_ENTRY_REFUND', 'TOURNAMENT_ENTRY_REFUND_FAILED']) expect(durable).toContain(`'${a}'`);
    expect(REFUND_CANCELLED).not.toContain('addChipsToUser(');
  });
});

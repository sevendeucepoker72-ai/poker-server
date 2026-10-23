/**
 * 2026-10-23 (qualifier lifecycle S1, owner 2026-10-22: "So this tournament
 * will fully run with no issues?") — the credit-failure audit trail and a
 * sturdier start for the Sunday weekly qualifier:
 *
 *   (a) a RANDOM seat draw at the start (registration order used to decide the
 *       tables, seat 0 of Table 1 and with it the hand-1 button);
 *   (c) every credit-refund FAILURE / anomaly row is durable (audit_log), so a
 *       credit the master did not give back can be found after a restart;
 *   (d) one table's throw at the start no longer voids the whole event (it was
 *       an uncaughtException → the crash flush refunded everyone);
 *   (e) a failed schedule sync with an empty registry retries in 30 s, once at
 *       a time, and the fetch is bounded at 10 s.
 *   (b) — the on-time start timer — is in r2Qualifiers.test.ts (its world).
 *
 * Runs the REAL src/index.ts source (sliced + transpiled) with the REAL
 * TournamentManager / PokerTable.
 */
import { randomInt } from 'crypto';
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { qualifierBlindLevels } from '../src/game/qualifierSchedule';
import { SRC, slice, fnSrc, load, flush } from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };

// ─────────────────────────────── (a) the seat draw ───────────────────────────────
describe('(a) startQualifierTournament seats the field by a random draw (crypto randomInt)', () => {
  const START_Q = fnSrc('function startQualifierTournament(');

  function harness(rand: (max: number) => number) {
    const tm = new TournamentManager();
    const tables = new Map<string, PokerTable>();
    const created: string[] = [];
    const bootstraps: Array<{ tournamentId: string; tableIds: string[] }> = [];
    const randCalls: number[] = [];
    const { exports: m } = load(START_Q, {
      tournamentManager: tm, tournamentTables: new Map(), fastModeTables: new Map(), qualifierBlindLevels,
      playerSessions: new Map(), io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
      tableManager: {
        createQuickTable: (name: string, seats: number, sb: number, bb: number, buyIn: number) => {
          const id = `T${created.length + 1}`;
          created.push(id);
          tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn: buyIn, maxBuyIn: buyIn * 10, maxPlayers: seats } as any));
          return id;
        },
        getTable: (id: string) => tables.get(id),
      },
      // Every registrant absent (no live socket): the draw is about seats, not sessions.
      bindRegistrantSocket: () => '',
      bootstrapTournamentTables: (tournamentId: string, tableIds: string[]) => { bootstraps.push({ tournamentId, tableIds }); },
      randomInt: (max: number) => { randCalls.push(max); return rand(max); },
      console: quiet,
    }, '{ startQualifierTournament }');
    return { tm, tables, created, bootstraps, randCalls, m };
  }

  const field = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q-${i}`, name: `P${i}`, socketId: `S${i}`, masterId: `m-${i}` }));

  /** Every occupied seat: [tableId, seatIndex, playerId]. */
  function seating(tables: Map<string, PokerTable>, ids: string[]) {
    const out: Array<[string, number, string]> = [];
    for (const id of ids) tables.get(id)!.seats.forEach((s, i) => { if (s.state === 'occupied') out.push([id, i, s.playerId]); });
    return out;
  }

  it('the seats follow the SHUFFLED order (randomInt mocked to a known permutation); tournament.players keeps INPUT order', () => {
    // randomInt always 0: Fisher-Yates swaps position i with 0 for i = n-1 … 1,
    // which draws the order [1, 2, …, n-1, 0] — not the registration order.
    const h = harness(() => 0);
    const players = field(20);
    const r = h.m.startQualifierTournament(players, 50_000, false);
    expect(r).toBeTruthy();
    expect(r.tableCount).toBe(3);
    const order = [...Array.from({ length: 19 }, (_, i) => i + 1), 0];
    // One randomInt call per swap: max = i + 1 for i = n-1 … 1.
    expect(h.randCalls).toEqual(Array.from({ length: 19 }, (_, i) => 20 - i));
    // The k-th drawn player: table k % 3, seat floor(k / 3) (round-robin, as before).
    for (let k = 0; k < order.length; k++) {
      const seat = h.tables.get(r.tableIds[k % 3])!.seats[Math.floor(k / 3)];
      expect({ k, seat: seat.state, pid: seat.playerId }).toEqual({ k, seat: 'occupied', pid: players[order[k]].id });
    }
    // Table 1 seat 0 (the hand-1 button) is the DRAWN first player, not the first registrant.
    expect(h.tables.get('T1')!.seats[0].playerId).toBe('q-1');
    // TournamentManager's entrant list is untouched: input order.
    expect(h.tm.getTournament(r.tournamentId)!.players.map((p) => p.playerId)).toEqual(players.map((p) => p.id));
    // Each entrant's table map follows his drawn seat.
    for (const [tid, , pid] of seating(h.tables, r.tableIds)) expect(h.tm.getPlayerTable(r.tournamentId, pid)).toBe(tid);
    expect(h.bootstraps).toEqual([{ tournamentId: r.tournamentId, tableIds: r.tableIds }]);
  });

  it('every table is within ONE player of the others and every seat index is below 9 (mocked draw, 2..60 entrants)', () => {
    for (let n = 2; n <= 60; n++) {
      // A deterministic, non-trivial draw: j = 7n mod max.
      const h = harness((max) => (n * 7) % max);
      const players = field(n);
      const r = h.m.startQualifierTournament(players, 50_000, false);
      const seats = seating(h.tables, r.tableIds);
      const counts = r.tableIds.map((id: string) => seats.filter(([t]) => t === id).length);
      expect({ n, spread: Math.max(...counts) - Math.min(...counts) <= 1 }).toEqual({ n, spread: true });
      expect({ n, seatsBelow9: seats.every(([, i]) => i < 9) }).toEqual({ n, seatsBelow9: true });
      expect({ n, tables: r.tableIds.length }).toEqual({ n, tables: Math.ceil(n / 9) });
      // Everyone seated exactly once.
      expect(seats.map(([, , pid]) => pid).sort()).toEqual(players.map((p) => p.id).sort());
      expect(h.tm.getTournament(r.tournamentId)!.players.map((p) => p.playerId)).toEqual(players.map((p) => p.id));
    }
  });

  it('with the REAL crypto randomInt: same guarantees, and the draw is not the registration order', () => {
    let notInputOrder = 0;
    for (let run = 0; run < 25; run++) {
      const h = harness((max) => randomInt(max));
      const players = field(45);
      const r = h.m.startQualifierTournament(players, 50_000, false);
      const seats = seating(h.tables, r.tableIds);
      const counts = r.tableIds.map((id: string) => seats.filter(([t]) => t === id).length);
      expect(counts).toEqual([9, 9, 9, 9, 9]);
      expect(seats.every(([, i]) => i < 9)).toBe(true);
      expect(new Set(seats.map(([, , pid]) => pid)).size).toBe(45);
      if (h.tables.get('T1')!.seats[0].playerId !== 'q-0' || h.tables.get('T1')!.seats[1].playerId !== 'q-5') notInputOrder++;
    }
    expect(notInputOrder).toBeGreaterThan(20);
  });

  it('wiring: the draw uses crypto randomInt (imported, no new dependency); registerPlayer still runs over `players` in input order', () => {
    expect(SRC).toMatch(/^import \{ createHash, randomInt, timingSafeEqual \} from 'crypto';$/m);
    const regAt = START_Q.indexOf('tournamentManager.registerPlayer(tournamentId, p.id, p.name, p.socketId, undefined, p.masterId || undefined);');
    const drawAt = START_Q.indexOf('const j = randomInt(i + 1);');
    expect(regAt).toBeGreaterThan(-1);
    expect(drawAt).toBeGreaterThan(regAt);
    expect(START_Q).toContain('const p = players[drawOrder[k]];');
  });
});

// ─────────────────────── (c) the credit-failure audit trail ───────────────────────
describe('(c) every qualifier credit-refund FAILURE / anomaly is a durable audit_log row', () => {
  const AUDIT_SRC = [
    slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);'),
    slice('let _auditTableReady = false;', '\n}\n'),
    slice('const PHONE_HANDLE_RE', '\n}\n'),
    fnSrc('function auditLog('),
  ].join('\n');
  const NEW_DURABLE = [
    'QUALIFIER_CREDIT_REFUND_FAILED', 'QUALIFIER_ENTRY_CREDIT_REFUND_FAILED', 'QUALIFIER_REENTRY_CREDIT_REFUND_FAILED',
    'QUALIFIER_REENTRY_BUYIN_REFUND_FAILED', 'QUALIFIER_SUSPENDED_CREDIT_REFUND_FAILED',
    'QUALIFIER_ENTRY_CREDIT_SHARED_KEPT', 'QUALIFIER_REENTRY_CREDIT_SHARED_KEPT',
    'QUALIFIER_OVERFLOW_CAP_SET', 'TOURNAMENT_PAUSE',
  ];
  // High-volume successes stay stdout-only (the db-f1-micro note above DURABLE_AUDIT_ACTIONS).
  const STAY_STDOUT = [
    'QUALIFIER_CREDIT_REFUND', 'QUALIFIER_ENTRY_CREDIT_REFUND', 'QUALIFIER_ENTRY_CREDIT_CONSUME',
    'QUALIFIER_LATE_ENTRY_SEATED', 'QUALIFIER_NO_SHOW_RELEASED', 'QUALIFIER_SUSPENDED_CREDIT_REFUND', 'QUALIFIER_REENTRY_BUYIN_REFUND',
  ];

  function world(extra = '', scopeExtra: Record<string, unknown> = {}) {
    const queries: Array<{ sql: string; params?: any[] }> = [];
    const pool = { query: (sql: string, params?: any[]) => { queries.push({ sql, params: params && JSON.parse(JSON.stringify(params)) }); return Promise.resolve({ rows: [] }); } };
    const { exports: m } = load(`${AUDIT_SRC}\n${extra}`, {
      authSessions: new Map(), Sentry: null, getPool: () => pool, console: quiet, ...scopeExtra,
    }, `{ DURABLE_AUDIT_ACTIONS, auditLog${extra ? ', refundQualifierEntryCredit, refundQualifierReentryCharges, qualifierLateEntries' : ''} }`);
    const rows = () => queries.filter((q) => /^INSERT INTO audit_log/.test(q.sql)).map((q) => ({ actor: q.params![0], action: q.params![1], details: q.params![2] }));
    return { m, rows };
  }

  it('DURABLE_AUDIT_ACTIONS has every new name (and still the results rows); the successes stay stdout-only', () => {
    const { m } = world();
    for (const a of NEW_DURABLE) expect({ a, durable: m.DURABLE_AUDIT_ACTIONS.has(a) }).toEqual({ a, durable: true });
    for (const a of ['QUALIFIER_RESULTS_RECORDED', 'QUALIFIER_RESULTS_POSTED', 'QUALIFIER_RESULTS_POST_FAILED', 'QUALIFIER_REENTRY_CREDIT_CONSUME', 'QUALIFIER_REENTRY_CREDIT_REFUND']) {
      expect({ a, durable: m.DURABLE_AUDIT_ACTIONS.has(a) }).toEqual({ a, durable: true });
    }
    for (const a of STAY_STDOUT) expect({ a, durable: m.DURABLE_AUDIT_ACTIONS.has(a) }).toEqual({ a, durable: false });
  });

  it('each new name is a real auditLog action in src/index.ts (no typo that would never match)', () => {
    for (const a of NEW_DURABLE) {
      const call = new RegExp(`auditLog\\([\\s\\S]{0,240}?'${a}'`);
      expect({ a, called: call.test(SRC) }).toEqual({ a, called: true });
    }
  });

  it('auditLog writes an audit_log row for every new name (details JSONB as given) and none for a success', async () => {
    const { m, rows } = world();
    for (const a of NEW_DURABLE) m.auditLog('SYSTEM', a, { qualifierId: 'Q1', creditId: `c-${a}` });
    for (const a of STAY_STDOUT) m.auditLog('SYSTEM', a, { qualifierId: 'Q1', creditId: `c-${a}` });
    await flush();
    expect(rows().map((r) => r.action).sort()).toEqual([...NEW_DURABLE].sort());
    expect(rows().find((r) => r.action === 'QUALIFIER_CREDIT_REFUND_FAILED')).toEqual({ actor: 'SYSTEM', action: 'QUALIFIER_CREDIT_REFUND_FAILED', details: { qualifierId: 'Q1', creditId: 'c-QUALIFIER_CREDIT_REFUND_FAILED' } });
  });

  it('the REAL refund helpers: a refund the master did not take leaves a durable row with qualifierId + creditId (a taken one: none)', async () => {
    let masterRefunds = false;
    const helpers = [fnSrc('async function refundQualifierEntryCredit('), fnSrc('async function refundQualifierReentryCharges('),
      slice('const qualifierLateEntries = {', ';\n')].join('\n');
    const { m, rows } = world(helpers, {
      refundQualifierCreditOnMaster: async () => masterRefunds,
      addChipsToUser: async () => false,
      lastQualifierFetch: 1,
    });
    await m.refundQualifierEntryCredit('alice.x', 'QID', 'credit-1', 'no_seat');
    await m.refundQualifierReentryCharges(101, 'alice.x', 'QID', 0, 'credit-2', 'no_seat');
    await flush();
    expect(rows()).toEqual([
      { actor: 'alice.x', action: 'QUALIFIER_ENTRY_CREDIT_REFUND_FAILED', details: { qualifierId: 'QID', creditId: 'credit-1', reason: 'no_seat' } },
      { actor: 'alice.x', action: 'QUALIFIER_REENTRY_CREDIT_REFUND_FAILED', details: { qualifierId: 'QID', creditId: 'credit-2', reason: 'no_seat' } },
    ]);
    masterRefunds = true;
    await m.refundQualifierEntryCredit('bob.x', 'QID', 'credit-3', 'no_seat');
    await flush();
    expect(rows()).toHaveLength(2);
  });
});

// ─────────────────────── (d) the per-table bootstrap guard ───────────────────────
describe('(d) bootstrapTournamentTables: one table\'s throw no longer escapes (it voided the whole event)', () => {
  const BOOT = [slice('const tournamentBootstrapStats = {', ';\n'), fnSrc('function bootstrapTournamentTables(')].join('\n');

  function harness(boot = BOOT) {
    const tables = new Map<string, PokerTable>();
    for (const id of ['T1', 'T2', 'T3']) {
      const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
      t.sitDown(0, `${id}-a`, 50_000, `${id}-a`, false, true);
      t.sitDown(1, `${id}-b`, 50_000, `${id}-b`, false, true);
      tables.set(id, t);
    }
    // T2's first deal throws (any throw inside the table's setup counts).
    (tables.get('T2') as any).startNewHand = () => { throw new Error('deck exploded'); };
    const listeners: string[] = [];
    const broadcasts: string[] = [];
    const aiKicks: string[] = [];
    const onEvents: string[] = [];
    const errors: string[] = [];
    const { exports: m } = load(boot, {
      tableManager: { getTable: (id: string) => tables.get(id) },
      ensureTableProgressListener: (_t: unknown, id: string) => { listeners.push(id); },
      broadcastGameState: (id: string) => { broadcasts.push(id); },
      scheduleAIAction: (id: string) => { aiKicks.push(id); },
      tournamentManager: { onEvent: (id: string) => { onEvents.push(id); }, getTournament: () => undefined },
      Sentry: null,
      console: { log() {}, warn() {}, error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); } },
    }, `{ bootstrapTournamentTables, stats: typeof tournamentBootstrapStats !== 'undefined' ? tournamentBootstrapStats : null }`);
    return { m, tables, listeners, broadcasts, aiKicks, onEvents, errors };
  }

  it('T2 throws: T1 and T3 still deal, nothing escapes, the counter reads 1, the one onEvent listener is registered once', () => {
    const h = harness();
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1', 'T2', 'T3'])).not.toThrow();
    expect(h.tables.get('T1')!.isHandInProgress()).toBe(true);
    expect(h.tables.get('T3')!.isHandInProgress()).toBe(true);
    expect(h.tables.get('T2')!.isHandInProgress()).toBe(false);   // un-dealt, stacks still seated
    expect(h.tables.get('T2')!.seats.filter((s) => s.state === 'occupied').map((s) => s.chipCount)).toEqual([50_000, 50_000]);
    expect(h.listeners).toEqual(['T1', 'T2', 'T3']);
    expect(h.broadcasts).toEqual(['T1', 'T3']);
    expect(h.aiKicks).toEqual(['T1', 'T3']);
    expect(h.m.stats).toEqual({ tableFailures: 1 });
    expect(h.onEvents).toEqual(['TQ']);
    const logged = h.errors.filter((l) => l.includes('tournament_table_bootstrap_failed'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0].slice(logged[0].indexOf('{')))).toEqual({
      event: 'tournament_table_bootstrap_failed', tournamentId: 'TQ', tableId: 'T2', error: 'deck exploded',
    });
  });

  it('no throw: every table deals, the counter stays 0, onEvent once', () => {
    const h = harness();
    delete (h.tables.get('T2') as any).startNewHand;
    h.m.bootstrapTournamentTables('TQ', ['T1', 'T2', 'T3']);
    expect(['T1', 'T2', 'T3'].map((id) => h.tables.get(id)!.isHandInProgress())).toEqual([true, true, true]);
    expect(h.m.stats).toEqual({ tableFailures: 0 });
    expect(h.onEvents).toEqual(['TQ']);
    expect(h.errors).toEqual([]);
  });

  it('wiring: the onEvent registration is outside the per-table loop, exactly once', () => {
    const body = fnSrc('function bootstrapTournamentTables(');
    expect(body.split('tournamentManager.onEvent(').length - 1).toBe(1);
    expect(body.indexOf('tournamentManager.onEvent(')).toBeGreaterThan(body.indexOf('tournamentBootstrapStats.tableFailures++;'));
  });
});

// ──────────── (d) review fix-up: a throw with NO table dealt is re-thrown ────────────
// Swallowed, a TOTAL start failure (the only table of a field of 9 or fewer, or
// every table) left a 'running' event nothing deals: no elimination ever asks
// for a rebalance, late entries kept consuming credits into it, no results,
// every credit held until a restart. Re-thrown, it is the uncaughtException it
// was before S1: the crash flush voids the event and refunds every credit.
describe('(d) review fix-up — a throw with NO table dealt is re-thrown (the old crash-and-refund); a partial one is not', () => {
  const BOOT = [slice('const tournamentBootstrapStats = {', ';\n'), fnSrc('function bootstrapTournamentTables(')].join('\n');

  type Mode = 'deal' | 'throw' | 'noDeal' | 'throwAfterDeal';
  function harness(modes: Record<string, Mode>) {
    const tables = new Map<string, PokerTable>();
    const broadcasts: string[] = [];
    for (const [id, mode] of Object.entries(modes)) {
      const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
      t.sitDown(0, `${id}-a`, 50_000, `${id}-a`, false, true);
      t.sitDown(1, `${id}-b`, 50_000, `${id}-b`, false, true);
      if (mode === 'throw') (t as any).startNewHand = () => { throw new Error(`deck exploded at ${id}`); };
      if (mode === 'noDeal') (t as any).startNewHand = () => false;
      tables.set(id, t);
    }
    const onEvents: string[] = [];
    const errors: string[] = [];
    const { exports: m } = load(BOOT, {
      tableManager: { getTable: (id: string) => tables.get(id) },
      ensureTableProgressListener() {},
      broadcastGameState: (id: string) => {
        broadcasts.push(id);
        if (modes[id] === 'throwAfterDeal') throw new Error(`broadcast failed at ${id}`);
      },
      scheduleAIAction() {},
      tournamentManager: { onEvent: (id: string) => { onEvents.push(id); }, getTournament: () => undefined },
      Sentry: null,
      console: { log() {}, warn() {}, error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); } },
    }, '{ bootstrapTournamentTables, stats: tournamentBootstrapStats }');
    const lines = (event: string) => errors.filter((l) => l.includes(`"event":"${event}"`)).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    return { m, tables, onEvents, broadcasts, lines };
  }

  it('the ONLY table (a field of 9 or fewer) throws: re-thrown with its own error, no onEvent listener, one no_table_dealt line', () => {
    const h = harness({ T1: 'throw' });
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1'])).toThrow('deck exploded at T1');
    expect(h.onEvents).toEqual([]);
    expect(h.m.stats).toEqual({ tableFailures: 1 });
    expect(h.lines('tournament_table_bootstrap_failed').map((l) => l.tableId)).toEqual(['T1']);
    expect(h.lines('tournament_bootstrap_no_table_dealt')).toEqual([
      { event: 'tournament_bootstrap_no_table_dealt', tournamentId: 'TQ', tables: 1, failedTables: 1, outcome: 'rethrown' },
    ]);
    // The seated stacks are untouched (the crash flush voids the event; nothing is cashed from a tournament seat).
    expect(h.tables.get('T1')!.seats.filter((s) => s.state === 'occupied').map((s) => s.chipCount)).toEqual([50_000, 50_000]);
  });

  it('EVERY table throws: each is tried and logged, then the FIRST error is re-thrown; no onEvent listener', () => {
    const h = harness({ T1: 'throw', T2: 'throw', T3: 'throw' });
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1', 'T2', 'T3'])).toThrow('deck exploded at T1');
    expect(h.lines('tournament_table_bootstrap_failed').map((l) => l.tableId)).toEqual(['T1', 'T2', 'T3']);
    expect(h.m.stats).toEqual({ tableFailures: 3 });
    expect(h.lines('tournament_bootstrap_no_table_dealt')).toEqual([
      { event: 'tournament_bootstrap_no_table_dealt', tournamentId: 'TQ', tables: 3, failedTables: 3, outcome: 'rethrown' },
    ]);
    expect(h.onEvents).toEqual([]);
  });

  it('one table throws and the other deals NOTHING (startNewHand false): no table dealt, re-thrown', () => {
    const h = harness({ T1: 'noDeal', T2: 'throw' });
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1', 'T2'])).toThrow('deck exploded at T2');
    expect(h.onEvents).toEqual([]);
  });

  it('one table deals and one throws (partial): NOT re-thrown, the dealt table plays, onEvent once (S1 unchanged)', () => {
    const h = harness({ T1: 'throw', T2: 'deal' });
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1', 'T2'])).not.toThrow();
    expect(h.tables.get('T2')!.isHandInProgress()).toBe(true);
    expect(h.onEvents).toEqual(['TQ']);
    expect(h.lines('tournament_bootstrap_no_table_dealt')).toEqual([]);
  });

  it('a table that DEALT and then threw (its broadcast) counts as dealt: not re-thrown, its hand is in progress', () => {
    const h = harness({ T1: 'throwAfterDeal' });
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1'])).not.toThrow();
    expect(h.tables.get('T1')!.isHandInProgress()).toBe(true);
    expect(h.m.stats).toEqual({ tableFailures: 1 });
    expect(h.onEvents).toEqual(['TQ']);
  });

  it('no throw at all, nothing dealt: unchanged — no throw (nothing to re-throw), onEvent once', () => {
    const h = harness({ T1: 'noDeal' });
    expect(() => h.m.bootstrapTournamentTables('TQ', ['T1'])).not.toThrow();
    expect(h.onEvents).toEqual(['TQ']);
    expect(h.m.stats).toEqual({ tableFailures: 0 });
  });

  it('through the REAL startQualifierTournament: a field of 9 (one table) whose first deal throws escapes it; a field of 18 with Table 1 throwing does not', () => {
    const START_Q = fnSrc('function startQualifierTournament(');
    function start(n: number, throwAt: string) {
      const tm = new TournamentManager();
      const tables = new Map<string, PokerTable>();
      const onEvents: string[] = [];
      let created = 0;
      const { exports: m } = load(`${START_Q}\n${BOOT}`, {
        tournamentManager: Object.assign(tm, { onEvent: (id: string) => { onEvents.push(id); } }),
        tournamentTables: new Map(), fastModeTables: new Map(), qualifierBlindLevels,
        playerSessions: new Map(), io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
        tableManager: {
          createQuickTable: (name: string, seats: number, sb: number, bb: number, buyIn: number) => {
            const id = `T${++created}`;
            const t = new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn: buyIn, maxBuyIn: buyIn * 10, maxPlayers: seats } as any);
            if (id === throwAt) (t as any).startNewHand = () => { throw new Error(`deck exploded at ${id}`); };
            tables.set(id, t);
            return id;
          },
          getTable: (id: string) => tables.get(id),
        },
        bindRegistrantSocket: () => '',
        randomInt: (max: number) => randomInt(max),
        ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {},
        Sentry: null, console: quiet,
      }, '{ startQualifierTournament }');
      const players = Array.from({ length: n }, (_, i) => ({ id: `q-${i}`, name: `P${i}`, socketId: `S${i}`, masterId: `m-${i}` }));
      return { run: () => m.startQualifierTournament(players, 50_000, false), tables, onEvents };
    }
    // 9 entrants → one table: its throw reaches the caller (tickQualifierAutoStart → uncaughtException → crash flush).
    const nine = start(9, 'T1');
    expect(() => nine.run()).toThrow('deck exploded at T1');
    expect(nine.onEvents).toEqual([]);
    // 18 entrants → two tables: Table 1 throws, Table 2 deals, the event runs.
    const eighteen = start(18, 'T1');
    const r = eighteen.run();
    expect(r).toMatchObject({ tableCount: 2 });
    expect(eighteen.tables.get('T2')!.isHandInProgress()).toBe(true);
    expect(eighteen.onEvents).toHaveLength(1);
  });

  it('wiring: the re-throw sits after the per-table loop and BEFORE the onEvent listener; the tick does not catch it', () => {
    const body = fnSrc('function bootstrapTournamentTables(');
    const rethrowAt = body.indexOf('throw firstFailure;');
    expect(rethrowAt).toBeGreaterThan(body.indexOf('tournamentBootstrapStats.tableFailures++;'));
    expect(rethrowAt).toBeLessThan(body.indexOf('tournamentManager.onEvent('));
    expect(body).toContain('if (failedTables > 0 && dealtTables === 0) {');
    expect(body).toContain('if (table.startNewHand()) dealtTables++;');
    // The start tick calls startQualifierTournament bare (no try): the throw is the
    // uncaughtException the crash flush handles (qt stays 'starting' → released, refunded).
    const tick = fnSrc('function tickQualifierAutoStart(');
    const callAt = tick.indexOf('const result = startQualifierTournament(humanPlayers');
    expect(callAt).toBeGreaterThan(-1);
    expect(tick.slice(0, callAt)).not.toMatch(/\btry\s*\{/);
    expect(tick.slice(0, callAt)).toContain("qt.status = 'starting';");
  });
});

// ─────────────────────────── (e) the schedule-sync retry ───────────────────────────
describe('(e) syncQualifierSchedule: a failure with an EMPTY registry retries in 30 s (one at a time); the fetch is bounded at 10 s', () => {
  const SYNC = [slice('const qualifierSyncStats = {', '\n}\n'), fnSrc('async function syncQualifierSchedule(')].join('\n');

  function harness(opts: { registry?: number; answer?: 'reject' | 'http500' | 'ok' } = {}) {
    const qualifierTournaments = new Map<string, any>();
    for (let i = 0; i < (opts.registry ?? 0); i++) qualifierTournaments.set(`Q${i}`, { status: 'registering' });
    const timers: Array<{ ms: number; fn: () => void; unref: number; cleared: boolean }> = [];
    const fetches: Array<{ url: string; init: any }> = [];
    const applied: unknown[] = [];
    let answer = opts.answer ?? 'reject';
    const { exports: m } = load(SYNC, {
      qualifierTournaments,
      process: { env: { INTERNAL_NOTIFY_TOKEN: 't', MASTER_API_URL: 'https://master.test' } },
      fetch: async (url: string, init: any) => {
        fetches.push({ url, init });
        if (answer === 'reject') throw new Error('ECONNRESET');
        if (answer === 'http500') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { schedule: [] } }) };
      },
      setTimeout: (fn: () => void, ms: number) => {
        const t = { ms, fn, unref: 0, cleared: false };
        timers.push(t);
        return { unref: () => { t.unref++; return t; }, _t: t };
      },
      clearTimeout: (h: any) => { if (h && h._t) h._t.cleared = true; },
      parseMasterSchedule: (b: unknown) => b,
      applyQualifierSchedule: (list: unknown) => { applied.push(list); },
      console: quiet,
    }, '{ syncQualifierSchedule, qualifierSyncStats }');
    const retries = () => timers.filter((t) => t.ms === 30_000);
    return { m, timers, retries, fetches, applied, qualifierTournaments, setAnswer: (a: typeof answer) => { answer = a; } };
  }

  it('a rejected fetch with an empty registry schedules ONE 30 s retry (unref\'d); a second failure while it is armed stacks none', async () => {
    const h = harness();
    await h.m.syncQualifierSchedule();
    expect(h.retries()).toHaveLength(1);
    expect(h.retries()[0].unref).toBe(1);
    expect(h.m.qualifierSyncStats).toMatchObject({ failures: 1, retries: 1 });
    await h.m.syncQualifierSchedule();                       // the 10-minute interval fails too, meanwhile
    expect(h.retries()).toHaveLength(1);
    expect(h.m.qualifierSyncStats).toMatchObject({ failures: 2, retries: 1 });
    // The retry fires and fails again: the NEXT single retry is armed.
    h.retries()[0].fn();
    await flush();
    expect(h.fetches).toHaveLength(3);
    expect(h.retries()).toHaveLength(2);
    // The master answers: the registry fills (applyQualifierSchedule) and nothing more is armed.
    h.setAnswer('ok');
    h.retries()[1].fn();
    await flush();
    expect(h.applied).toHaveLength(1);
    expect(h.retries()).toHaveLength(2);
  });

  it('an HTTP error (non-2xx) with an empty registry also retries once', async () => {
    const h = harness({ answer: 'http500' });
    await h.m.syncQualifierSchedule();
    expect(h.retries()).toHaveLength(1);
  });

  it('a non-empty registry arms NO retry (the 10-minute interval keeps it fresh); a success arms none', async () => {
    const h = harness({ registry: 1 });
    await h.m.syncQualifierSchedule();
    expect(h.retries()).toHaveLength(0);
    expect(h.m.qualifierSyncStats.failures).toBe(1);
    const ok = harness({ answer: 'ok' });
    await ok.m.syncQualifierSchedule();
    expect(ok.retries()).toHaveLength(0);
    expect(ok.applied).toHaveLength(1);
  });

  it('the fetch is bounded: a 10 s timer aborts its signal, and is cleared once the sync ends', async () => {
    const h = harness({ answer: 'ok' });
    await h.m.syncQualifierSchedule();
    const abortTimer = h.timers.find((t) => t.ms === 10_000)!;
    expect(abortTimer).toBeTruthy();
    expect(abortTimer.cleared).toBe(true);
    const signal = h.fetches[0].init.signal;
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
    abortTimer.fn();
    expect(signal.aborted).toBe(true);
    expect(h.fetches[0].init.headers).toEqual({ 'X-Internal-Token': 't' });
  });

  it('no token configured: no fetch, no timer, no retry (unchanged)', async () => {
    let fetched = 0;
    let timers = 0;
    const { exports: m } = load(SYNC, {
      qualifierTournaments: new Map(), process: { env: {} }, console: quiet,
      fetch: async () => { fetched++; throw new Error('no fetch expected'); },
      setTimeout: () => { timers++; return { unref() {} }; },
    }, '{ syncQualifierSchedule }');
    await m.syncQualifierSchedule();
    expect({ fetched, timers }).toEqual({ fetched: 0, timers: 0 });
  });
});

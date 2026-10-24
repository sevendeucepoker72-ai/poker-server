/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F14) — DURABLE
 * tournament results: tournament_results (id, name, kind, buy-in, entrants,
 * prize pool, table ids, start / finish, status) and tournament_result_players
 * (account, place, prize, eliminated_by, bust_hand, busted_at, told_at),
 * written as each player busts and at the finish; non-qualifier tournaments
 * only. Places 4..N and the eliminators were stored nowhere.
 *  - src/game/tournamentResults.ts: ONE serialized chain (never two queries at
 *    once), lazy DDL, every failure logged + counted, never thrown.
 *  - index.ts: recordTournamentResultsStart / Bust / Finish (real source,
 *    sliced) on a REAL TournamentManager run.
 *  - The DDL is ASCII-only and authManager.initDB creates it.
 */
import fs from 'fs';
import path from 'path';
import { TournamentManager } from '../src/game/TournamentManager';
import { createTournamentResultsStore, TOURNAMENT_RESULTS_DDL, tournamentResultsStats } from '../src/game/tournamentResults';
import { slice, load, flush } from './helpers/indexSource';

function fakeDb(opts: { failOn?: RegExp; delayMs?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const query = async (sql: string, params?: unknown[]) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ sql, params });
    await new Promise((r) => setImmediate(r));
    inFlight--;
    if (opts.failOn && opts.failOn.test(sql)) throw new Error('db down');
    return { rows: [], rowCount: 1 };
  };
  return { query, calls, max: () => maxInFlight };
}

describe('F14 — the store', () => {
  it('the DDL runs first (once), then the header and one row per entrant; every query alone (serialized)', async () => {
    const db = fakeDb();
    const s = createTournamentResultsStore({ query: db.query, log: () => {} });
    void s.recordStart({ tournamentId: 'T', name: 'Sit & Go', kind: 'template', buyIn: 100, entrants: 2, prizePool: 200, tableIds: ['X'], startedAt: 1_700_000_000_000 },
      [{ playerId: 'user-1', userId: 1, playerName: 'A' }, { playerId: 'user-2', userId: 2, masterUserId: 'm-2', playerName: 'B' }]);
    void s.recordBust('T', { playerId: 'user-2', place: 2, prize: 75, eliminatedBy: 'user-1', bustHand: 9, told: false });
    await s.drain();
    expect(db.calls.slice(0, TOURNAMENT_RESULTS_DDL.length).map((c) => c.sql)).toEqual(TOURNAMENT_RESULTS_DDL);
    const rest = db.calls.slice(TOURNAMENT_RESULTS_DDL.length);
    expect(rest[0].sql).toMatch(/^INSERT INTO tournament_results /);
    expect(rest[0].params).toEqual(['T', 'Sit & Go', 'template', 100, 2, 200, '["X"]', 1_700_000_000_000]);
    expect(rest[1].params).toEqual(['T', 'user-1', 1, null, 'A']);
    expect(rest[2].params).toEqual(['T', 'user-2', 2, 'm-2', 'B']);
    expect(rest[3].sql).toMatch(/INSERT INTO tournament_result_players .* ON CONFLICT/s);
    expect(rest[3].params).toEqual(['T', 'user-2', null, null, null, 2, 75, 'user-1', 9, false]);
    expect(db.max()).toBe(1);
    // A second write does not repeat the DDL.
    void s.markTold('T', 'user-2');
    await s.drain();
    expect(db.calls.filter((c) => /CREATE TABLE/.test(c.sql))).toHaveLength(2);
  });

  it('a failing write is logged and counted, never thrown; the next write still runs', async () => {
    const db = fakeDb({ failOn: /INSERT INTO tournament_results /, delayMs: 0 });
    const lines: string[] = [];
    const s = createTournamentResultsStore({ query: db.query, log: (l) => lines.push(l) });
    const before = tournamentResultsStats.writeFailures;
    await expect(s.recordStart({ tournamentId: 'T', name: 'X', kind: 'custom', buyIn: 0, entrants: 0, prizePool: 0, tableIds: [], startedAt: 1 }, [])).resolves.toBeUndefined();
    await s.recordBust('T', { playerId: 'p', place: 3, prize: 0, told: true });
    await s.drain();
    expect(tournamentResultsStats.writeFailures).toBe(before + 1);
    expect(lines.some((l) => /write_failed/.test(l))).toBe(true);
    expect(db.calls.some((c) => /INSERT INTO tournament_result_players/.test(c.sql))).toBe(true);
  });

  it('unseenFor reads the untold, non-voided, non-qualifier results (a failure answers [])', async () => {
    const db = fakeDb();
    const s = createTournamentResultsStore({ query: db.query, log: () => {} });
    expect(await s.unseenFor(7, 'm-7')).toEqual([]);
    const sel = db.calls.find((c) => /^SELECT/.test(c.sql.trim()))!;
    expect(sel.sql).toMatch(/told_at IS NULL/);
    expect(sel.sql).toMatch(/r\.kind <> 'qualifier'/);
    expect(sel.sql).toMatch(/r\.status <> 'voided'/);
    expect(sel.params).toEqual([7, 'm-7', 5]);
    const bad = createTournamentResultsStore({ query: async () => { throw new Error('x'); }, log: () => {} });
    expect(await bad.unseenFor(1, null)).toEqual([]);
  });

  it('the DDL is ASCII only and authManager.initDB creates it', () => {
    for (const sql of TOURNAMENT_RESULTS_DDL) expect(/^[\x00-\x7F]*$/.test(sql)).toBe(true);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'game', 'tournamentResults.ts'), 'utf8');
    const sqlBlocks = src.match(/`[^`]*(?:SELECT|INSERT|UPDATE|CREATE)[^`]*`/g) || [];
    expect(sqlBlocks.length).toBeGreaterThan(5);
    for (const b of sqlBlocks) expect([b.slice(0, 40), /^[\x00-\x7F]*$/.test(b)]).toEqual([b.slice(0, 40), true]);
    const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'authManager.ts'), 'utf8');
    expect(auth).toContain('TOURNAMENT_RESULTS_DDL');
  });
});

describe('F14 — index.ts writes as each player busts and at the finish (non-qualifier)', () => {
  function world(opts: { qualifier?: boolean } = {}) {
    const tm = new TournamentManager();
    const calls: Array<[string, ...any[]]> = [];
    const store = {
      recordStart: (h: any, e: any) => { calls.push(['start', h, e]); return Promise.resolve(); },
      recordBust: (tid: string, p: any, e: any) => { calls.push(['bust', tid, p, e]); return Promise.resolve(); },
      recordFinish: (tid: string, info: any, places: any) => { calls.push(['finish', tid, info, places]); return Promise.resolve(); },
      markTold: () => Promise.resolve(), markVoided: () => Promise.resolve(),
    };
    const scope: Record<string, unknown> = {
      tournamentManager: tm, tournamentResults: store, qualifierOfTournament: () => (opts.qualifier ? { qualId: 'Q' } : null),
      clubLiveTournaments: new Map(), console: { log() {}, warn() {}, error() {} },
    };
    const code = slice('// ===== Durable tournament results (Sit & Go fix-all F14) =====', '// ===== end durable tournament results =====\n')
      .replace(/^const tournamentResults = .*$/m, '');
    const { exports: m, stubbed } = load(code, scope, '{ recordTournamentResultsStart, recordTournamentResultsBust, recordTournamentResultsFinish }');
    return { tm, m, calls, stubbed };
  }
  function sng(w: ReturnType<typeof world>) {
    const tid = (w.tm.getTournamentList() as any[]).find((x) => x.name === 'Sit & Go').tournamentId;
    for (let i = 0; i < 9; i++) w.tm.registerPlayer(tid, `user-${i}`, `P${i}`, `s${i}`, 100 + i, `m-${i}`);
    w.tm.startTournament(tid);
    const t = w.tm.getTournament(tid)!;
    if (t.blindTimer) clearTimeout(t.blindTimer);
    return tid;
  }

  it('start: the header (name, kind, buy-in 100, 9 entrants, pool 900) + one row per entrant with his accounts', () => {
    const w = world();
    const tid = sng(w);
    w.m.recordTournamentResultsStart(tid, ['TBL']);
    const [, h, e] = w.calls.find((c) => c[0] === 'start')!;
    expect(h).toMatchObject({ tournamentId: tid, name: 'Sit & Go', kind: 'template', buyIn: 100, entrants: 9, prizePool: 900, tableIds: ['TBL'] });
    expect(e).toHaveLength(9);
    expect(e[0]).toEqual({ playerId: 'user-0', userId: 100, masterUserId: 'm-0', playerName: 'P0' });
  });

  it('a bust: his final place, his prize (paid places), the eliminator, the bust hand, told; the finish: every place + prize', () => {
    jest.useFakeTimers();
    const w = world();
    const tid = sng(w);
    for (const pid of ['user-8', 'user-7', 'user-6', 'user-5', 'user-4', 'user-3']) w.tm.eliminatePlayer(tid, pid, 'user-0');
    w.tm.eliminatePlayer(tid, 'user-2', 'user-0');
    w.m.recordTournamentResultsBust(tid, 'user-2', { eliminatorId: 'user-0', handNumber: 14, told: true });
    w.m.recordTournamentResultsBust(tid, 'user-8', { eliminatorId: 'user-0', handNumber: 3, told: false });
    const busts = w.calls.filter((c) => c[0] === 'bust');
    expect(busts[0][2]).toEqual({ playerId: 'user-2', place: 3, prize: 180, eliminatedBy: 'user-0', bustHand: 14, told: true });
    expect(busts[1][2]).toEqual({ playerId: 'user-8', place: 9, prize: 0, eliminatedBy: 'user-0', bustHand: 3, told: false });
    let data: any = null;
    w.tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
    w.tm.eliminatePlayer(tid, 'user-1', 'user-0');
    w.m.recordTournamentResultsFinish(tid, data, new Set(['user-0', 'user-1']));
    const [, , info, places] = w.calls.find((c) => c[0] === 'finish')!;
    expect(info).toMatchObject({ entrants: 9, prizePool: 900 });
    const byId = Object.fromEntries(places.map((p: any) => [p.playerId, p]));
    expect([byId['user-0'].place, byId['user-0'].prize, byId['user-0'].told]).toEqual([1, 450, true]);
    expect([byId['user-1'].place, byId['user-1'].prize, byId['user-1'].told]).toEqual([2, 270, true]);
    expect([byId['user-8'].place, byId['user-8'].prize, byId['user-8'].told]).toEqual([9, 0, false]);
    expect(places).toHaveLength(9);
    jest.useRealTimers();
  });

  it('a qualifier writes nothing (its results have their own durable path)', () => {
    const w = world({ qualifier: true });
    const tid = sng(w);
    w.m.recordTournamentResultsStart(tid, ['TBL']);
    w.m.recordTournamentResultsBust(tid, 'user-8', { told: true });
    expect(w.calls).toEqual([]);
  });

  it('wiring: the start, the bust check and the finish call them', async () => {
    const { SRC } = await import('./helpers/indexSource');
    expect(slice('function startTournamentGame(', '\n}\n')).toContain('recordTournamentResultsStart(');
    expect(slice('function runTournamentBustCheck(', '\n}\n')).toContain('recordTournamentResultsBust(');
    expect(slice('function emitTournamentFinishedToEntrants(', '\n}\n')).toContain('recordTournamentResultsFinish(');
    expect(SRC).toContain('createTournamentResultsStore(');
    await flush();
  });
});

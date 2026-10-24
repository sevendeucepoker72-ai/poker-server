/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all C2, review fix-up)
 * — durableState.tournamentResults: the account's finished tournament results
 * from the F14 rows, so poker-3d's bankroll / analytics plot each
 * tournament's prize - entry fee after a reload or a fresh sign-in too (its
 * results list lived in page memory only; the server never sent the
 * `durableState.tournamentResults` the client hydrates).
 *  - tournamentResults.resultsFor(userId, limit): FINISHED, not voided, not a
 *    qualifier, a place, within 30 days, newest first: [{tournamentId, name,
 *    place, prize, entryFee (buy-in), finishedAt (ms), tableIds}].
 *  - getDurableState: + `tournamentResults` (additive), waited for at most
 *    DURABLE_TOURNAMENT_RESULTS_WAIT_MS ([] on a slow / failed read - the rest
 *    of durableState is never held up or lost).
 */
import { createTournamentResultsStore } from '../src/game/tournamentResults';
import { handlerSrc, fnSrc, slice, load, flush } from './helpers/indexSource';

describe('C2 review fix-up — tournamentResults.resultsFor', () => {
  it('reads his finished non-qualifier places (one query after the DDL) and maps them for the client', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const finished = new Date('2026-10-23T22:15:00Z');
    const query = async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/^SELECT/.test(sql.trim())) {
        return { rows: [{ tournament_id: 'T-1', place: 2, prize: '270', name: 'Sit & Go', buy_in: '100', table_ids: ['TBL-1'], finished_at: finished }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const s = createTournamentResultsStore({ query, log: () => {} }) as any;
    const out = await s.resultsFor(77, 50);
    expect(out).toEqual([{ tournamentId: 'T-1', name: 'Sit & Go', place: 2, prize: 270, entryFee: 100, finishedAt: finished.getTime(), tableIds: ['TBL-1'] }]);
    const sel = calls.find((c) => /^SELECT/.test(c.sql.trim()))!;
    expect(sel.sql).toMatch(/p\.user_id = \$1/);
    expect(sel.sql).toMatch(/r\.kind <> 'qualifier'/);
    expect(sel.sql).toMatch(/r\.status = 'finished'/);
    expect(sel.sql).toMatch(/p\.place IS NOT NULL/);
    expect(sel.sql).toMatch(/INTERVAL '30 days'/);
    expect(sel.params).toEqual([77, 50]);
    // ASCII-only SQL
    expect(/^[\x00-\x7f]*$/.test(sel.sql)).toBe(true);
  });

  it('a failed read answers [] (logged, counted), never throws', async () => {
    const s = createTournamentResultsStore({ query: async (sql: string) => { if (/^SELECT/.test(sql.trim())) throw new Error('db down'); return { rows: [] }; }, log: () => {} }) as any;
    expect(await s.resultsFor(77)).toEqual([]);
  });
});

describe('C2 review fix-up — getDurableState sends tournamentResults', () => {
  function run(resultsFor: (uid: number) => Promise<any>) {
    const emitted: Array<[string, any]> = [];
    const handlers: Record<string, (d?: any) => Promise<void>> = {};
    const socket = { id: 'S1', emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { handlers[ev] = fn; } };
    const scope: Record<string, unknown> = {
      ensureHydrated: async () => ({ userId: 77 }),
      loadInventory: async () => [], loadBattlePassClaims: async () => [], loadDurableProgress: async () => ({}),
      loadHandHistory: async () => [], loadCareerProgress: async () => ({}), CURRENT_BATTLE_PASS_SEASON: 's1',
      progressionManager: { userRecord: () => null },
      tournamentResults: { resultsFor },
      console: { log() {}, warn() {}, error() {} },
    };
    const code = `${slice('const DURABLE_TOURNAMENT_RESULTS_WAIT_MS', ';\n')}\n${fnSrc('async function durableTournamentResultsFor(')}\nfunction wire(socket) {\n${handlerSrc('getDurableState', '\n  });\n')}\n}`;
    const { exports: m, stubbed } = load(code, scope, '{ wire, DURABLE_TOURNAMENT_RESULTS_WAIT_MS }');
    m.wire(socket);
    return { handlers, emitted, stubbed, waitMs: m.DURABLE_TOURNAMENT_RESULTS_WAIT_MS as number };
  }
  const ROW = { tournamentId: 'T-1', name: 'Sit & Go', place: 2, prize: 270, entryFee: 100, finishedAt: 1, tableIds: ['TBL-1'] };

  it('his rows are in durableState.tournamentResults (a97fb93: no key)', async () => {
    const w = run(async () => [ROW]);
    await w.handlers.getDurableState({});
    const [ev, d] = w.emitted[0];
    expect(ev).toBe('durableState');
    expect(d.tournamentResults).toEqual([ROW]);
    expect(d.handHistory).toEqual([]);
    expect([...w.stubbed].filter((s) => /tournamentResults|durableTournamentResultsFor|DURABLE_TOURNAMENT/.test(s))).toEqual([]);
  });

  it('a read that hangs: durableState still goes out after the wait, with tournamentResults []', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = run(() => new Promise(() => {}));
      const p = w.handlers.getDurableState({});
      await flush();
      expect(w.emitted).toEqual([]);
      jest.advanceTimersByTime(w.waitMs + 10);
      await p;
      expect(w.emitted[0][1].tournamentResults).toEqual([]);
      expect(w.waitMs).toBeLessThanOrEqual(2000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a read that rejects or answers garbage: []', async () => {
    const w1 = run(async () => { throw new Error('x'); });
    await w1.handlers.getDurableState({});
    expect(w1.emitted[0][1].tournamentResults).toEqual([]);
    const w2 = run(async () => undefined);
    await w2.handlers.getDurableState({});
    expect(w2.emitted[0][1].tournamentResults).toEqual([]);
  });
});

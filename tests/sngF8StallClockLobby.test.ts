/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F8) — the lobby
 * says when a Sit & Go starts and that it cancels 30 minutes after the first
 * entry if not full, and the 30-minute stall clock restarts from the EARLIEST
 * REMAINING registrant's entry when the first one leaves (it kept the first
 * registrant's time: one early leaver could get the field cancelled minutes
 * after the others entered).
 *  - unregisterPlayer: firstRegistrationAt = the earliest registeredAt left.
 *  - Lobby item (additive) for an on-demand buy-in event: stallCancelMs
 *    (1,800,000) and stallCancelAt (ms, while registering with an entrant);
 *    null otherwise. minPlayers / maxPlayers already say "starts at 9/9".
 */
import { TournamentManager } from '../src/game/TournamentManager';

const idOf = (tm: TournamentManager, name: string) => {
  for (const [id, t] of (tm as any).tournaments as Map<string, any>) if (t.config.name === name && t.status === 'registering') return id as string;
  throw new Error(name);
};
const item = (tm: TournamentManager, tid: string) => (tm.getTournamentList() as any[]).find((x) => x.tournamentId === tid);
const MIN = 60_000;

describe('F8 — the stall clock runs from the earliest REMAINING entry', () => {
  let now = 0;
  let spy: jest.SpyInstance;
  beforeEach(() => { now = 1_800_000_000_000; spy = jest.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => { spy.mockRestore(); });

  it('A at t0, B at t0+5m, A leaves at t0+10m: not stalled at t0+30m, stalled at t0+35m (e038f7b: stalled at t0+30m)', () => {
    const tm = new TournamentManager();
    const tid = idOf(tm, 'Sit & Go');
    const t0 = now;
    expect(tm.registerPlayer(tid, 'A', 'A', 'sa', 1).success).toBe(true);
    now = t0 + 5 * MIN;
    expect(tm.registerPlayer(tid, 'B', 'B', 'sb', 2).success).toBe(true);
    now = t0 + 10 * MIN;
    expect(tm.unregisterPlayer(tid, 'A')).toBe(true);
    expect(tm.checkStalledTournaments(t0 + 30 * MIN)).not.toContain(tid);
    expect(tm.checkStalledTournaments(t0 + 35 * MIN)).toContain(tid);
  });

  it('the lobby item: stallCancelMs 1,800,000; stallCancelAt = earliest remaining entry + 30 min; null once empty', () => {
    const tm = new TournamentManager();
    const tid = idOf(tm, 'Sit & Go');
    const t0 = now;
    expect(item(tm, tid)).toMatchObject({ stallCancelMs: 30 * MIN, stallCancelAt: null, minPlayers: 9, maxPlayers: 9 });
    tm.registerPlayer(tid, 'A', 'A', 'sa', 1);
    expect(item(tm, tid).stallCancelAt).toBe(t0 + 30 * MIN);
    now = t0 + 5 * MIN;
    tm.registerPlayer(tid, 'B', 'B', 'sb', 2);
    tm.unregisterPlayer(tid, 'A');
    expect(item(tm, tid).stallCancelAt).toBe(t0 + 35 * MIN);
    tm.unregisterPlayer(tid, 'B');
    expect(item(tm, tid).stallCancelAt).toBeNull();
  });

  it('a re-registration (unregister + register 3 s later, the Chris M. case) moves only his own time: the clock keeps the earliest of the others', () => {
    const tm = new TournamentManager();
    const tid = idOf(tm, 'Sit & Go');
    const t0 = now;
    tm.registerPlayer(tid, 'A', 'A', 'sa', 1);
    now = t0 + 1 * MIN;
    tm.registerPlayer(tid, 'C', 'C', 'sc', 3);
    now = t0 + 2 * MIN;
    tm.unregisterPlayer(tid, 'C');
    now = t0 + 2 * MIN + 3000;
    tm.registerPlayer(tid, 'C2', 'C', 'sc', 3);
    expect(item(tm, tid).stallCancelAt).toBe(t0 + 30 * MIN);
    // A leaves: the clock is C's NEW entry.
    tm.unregisterPlayer(tid, 'A');
    expect(item(tm, tid).stallCancelAt).toBe(t0 + 2 * MIN + 3000 + 30 * MIN);
  });

  it('a timed Freeroll and a running event carry stallCancelMs / stallCancelAt null', () => {
    const tm = new TournamentManager();
    const fr = idOf(tm, 'Freeroll');
    expect(item(tm, fr)).toMatchObject({ stallCancelMs: null, stallCancelAt: null });
    const sng = idOf(tm, 'Sit & Go Turbo');
    for (let i = 0; i < 6; i++) tm.registerPlayer(sng, `p${i}`, `P${i}`, `s${i}`, 10 + i);
    tm.startTournament(sng);
    expect(item(tm, sng)).toMatchObject({ status: 'running', stallCancelMs: 30 * MIN, stallCancelAt: null });
    const t = tm.getTournament(sng)!;
    if (t.blindTimer) clearTimeout(t.blindTimer);
  });
});

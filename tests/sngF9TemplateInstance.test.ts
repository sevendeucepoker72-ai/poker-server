/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F9) — when a
 * template Sit & Go starts, a fresh REGISTERING instance of it opens at once:
 * one registering instance per template at any time (players arriving while
 * one plays queue for the next table). Only the timed Freeroll keeps its
 * 10-seconds-after-the-finish re-creation (its cadence is its start interval).
 *
 * Template-born tournaments are marked `fromTemplate` (not matched by name: a
 * custom or club event called 'Sit & Go' is never cloned). The finish / cancel
 * re-creation still drops the old record after 10 s but creates a new instance
 * only if none is registering.
 */
import { TournamentManager } from '../src/game/TournamentManager';

const registering = (tm: TournamentManager, name: string) =>
  (tm.getTournamentList() as any[]).filter((x) => x.name === name && x.status === 'registering');
const running = (tm: TournamentManager, name: string) =>
  (tm.getTournamentList() as any[]).filter((x) => x.name === name && x.status === 'running');

function fillAndStart(tm: TournamentManager, name: string, n: number): string {
  const tid = registering(tm, name)[0].tournamentId;
  for (let i = 0; i < n; i++) expect(tm.registerPlayer(tid, `${tid}-p${i}`, `P${i}`, `s${i}`, 1000 + i).success).toBe(true);
  expect(tm.startTournament(tid)).toBeTruthy();
  return tid;
}
function finish(tm: TournamentManager, tid: string): void {
  const t = tm.getTournament(tid)!;
  for (const p of [...t.players].slice(1)) tm.eliminatePlayer(tid, p.playerId);
  expect(t.status).toBe('finished');
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('F9 — a fresh registering instance opens the moment a template Sit & Go starts', () => {
  test.each([['Sit & Go', 9], ['Sit & Go Turbo', 6]])('%s: start → the running one + exactly ONE new registering instance with 0 players', (name, max) => {
    const tm = new TournamentManager();
    const tid = fillAndStart(tm, name as string, max as number);
    expect(running(tm, name as string).map((x) => x.tournamentId)).toEqual([tid]);
    const reg = registering(tm, name as string);
    expect(reg).toHaveLength(1);                        // e038f7b: none until 10 s after the finish
    expect(reg[0].registeredPlayers).toBe(0);
    expect(reg[0].tournamentId).not.toBe(tid);
  });

  it('the finish of the running one, 10 s later: its record is dropped and there is STILL exactly one registering instance', () => {
    const tm = new TournamentManager();
    const tid = fillAndStart(tm, 'Sit & Go', 9);
    finish(tm, tid);
    jest.advanceTimersByTime(10_001);
    expect(tm.getTournament(tid)).toBeUndefined();
    expect(registering(tm, 'Sit & Go')).toHaveLength(1);
  });

  it('a stall-cancel of the new instance recreates one (still exactly one registering)', () => {
    const tm = new TournamentManager();
    fillAndStart(tm, 'Sit & Go', 9);
    const fresh = registering(tm, 'Sit & Go')[0].tournamentId;
    expect(tm.registerPlayer(fresh, 'x', 'X', 'sx', 1).success).toBe(true);
    tm.cancelTournament(fresh);
    expect(registering(tm, 'Sit & Go')).toHaveLength(0);
    jest.advanceTimersByTime(10_001);
    expect(registering(tm, 'Sit & Go')).toHaveLength(1);
  });

  it('two finishes and a start interleaved never leave two registering instances', () => {
    const tm = new TournamentManager();
    const a = fillAndStart(tm, 'Sit & Go', 9);
    const b = fillAndStart(tm, 'Sit & Go', 9);       // the instance opened by a's start
    expect(registering(tm, 'Sit & Go')).toHaveLength(1);
    finish(tm, a);
    finish(tm, b);
    jest.advanceTimersByTime(10_001);
    expect(registering(tm, 'Sit & Go')).toHaveLength(1);
    expect(running(tm, 'Sit & Go')).toHaveLength(0);
  });

  it("a custom tournament NAMED 'Sit & Go' (no fromTemplate) starts and spawns nothing; its finish recreates nothing", () => {
    const tm = new TournamentManager();
    const before = registering(tm, 'Sit & Go').length;
    const tid = tm.createTournament({ name: 'Sit & Go', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, minPlayers: 2, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    for (let i = 0; i < 2; i++) tm.registerPlayer(tid, `c${i}`, `C${i}`, `sc${i}`);
    expect(tm.startTournament(tid)).toBeTruthy();
    expect(registering(tm, 'Sit & Go')).toHaveLength(before);
    finish(tm, tid);
    jest.advanceTimersByTime(10_001);
    expect(registering(tm, 'Sit & Go')).toHaveLength(before);
  });

  it('the timed Freeroll keeps its cadence: no instance at its start, recreated 10 s after its finish', () => {
    const tm = new TournamentManager();
    const fr = registering(tm, 'Freeroll')[0].tournamentId;
    for (let i = 0; i < 2; i++) tm.registerPlayer(fr, `f${i}`, `F${i}`, `sf${i}`);
    expect(tm.startTournament(fr)).toBeTruthy();
    expect(registering(tm, 'Freeroll')).toHaveLength(0);
    finish(tm, fr);
    jest.advanceTimersByTime(10_001);
    expect(registering(tm, 'Freeroll')).toHaveLength(1);
  });
});

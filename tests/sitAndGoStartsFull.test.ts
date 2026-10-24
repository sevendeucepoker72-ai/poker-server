/**
 * 2026-10-24 (owner: "Make the sit and gos not start until full") — the two
 * Sit & Go templates start only when every seat is taken (9 / 6), never at the
 * templates' default threshold of 4. Other on-demand templates keep 4.
 */
import { TournamentManager } from '../src/game/TournamentManager';

function idOf(tm: TournamentManager, name: string): string {
  for (const [id, t] of (tm as any).tournaments as Map<string, any>) if (t.config.name === name && t.status === 'registering') return id;
  throw new Error(`no registering ${name}`);
}

function fill(tm: TournamentManager, tid: string, n: number): void {
  for (let i = 0; i < n; i++) expect(tm.registerPlayer(tid, `p${i}`, `Player ${i}`, `s${i}`, 100 + i).success).toBe(true);
}

describe('Sit & Go start only when full', () => {
  test.each([['Sit & Go', 9], ['Sit & Go Turbo', 6]])('%s: not at 4 or at max - 1; starts at %i (full)', (name, max) => {
    const tm = new TournamentManager();
    const tid = idOf(tm, name as string);
    fill(tm, tid, 4);
    expect(tm.canStart(tid)).toBe(false);                 // used to start here
    fill2(tm, tid, 4, (max as number) - 1);
    expect(tm.canStart(tid)).toBe(false);
    expect(tm.registerPlayer(tid, 'last', 'Last', 'sl', 999).success).toBe(true);
    expect(tm.canStart(tid)).toBe(true);
    const listed = tm.getTournamentList().find((x: any) => x.tournamentId === tid) as any;
    expect(listed.minPlayers).toBe(max);
  });

  test('other on-demand templates keep the default threshold of 4 (Daily 5K)', () => {
    const tm = new TournamentManager();
    const tid = idOf(tm, 'Daily 5K');
    fill(tm, tid, 3);
    expect(tm.canStart(tid)).toBe(false);
    expect(tm.registerPlayer(tid, 'p3', 'Player 3', 's3', 103).success).toBe(true);
    expect(tm.canStart(tid)).toBe(true);
  });

  test('a Sit & Go short of full is still cancelled + refunded 30 minutes after its first entry', () => {
    const tm = new TournamentManager();
    const tid = idOf(tm, 'Sit & Go');
    const t0 = Date.now();
    fill(tm, tid, 3);
    (tm as any).tournaments.get(tid).firstRegistrationAt = t0;
    expect(tm.checkStalledTournaments(t0 + 29 * 60_000)).not.toContain(tid);
    expect(tm.checkStalledTournaments(t0 + 30 * 60_000)).toContain(tid);
  });
});

function fill2(tm: TournamentManager, tid: string, from: number, to: number): void {
  for (let i = from; i < to; i++) expect(tm.registerPlayer(tid, `p${i}`, `Player ${i}`, `s${i}`, 100 + i).success).toBe(true);
}

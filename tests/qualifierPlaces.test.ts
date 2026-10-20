/**
 * 2026-10-20 (owner: "look deep into the qualifier, test everything") — the
 * finishing places of a qualifier with LATE ENTRIES and RE-ENTRIES.
 *
 * Found on a local run of the real server (31 entrants, one late entry after
 * 15 busts): the results posted to the master had two 16ths and no 31st. A
 * place is fixed at the bust ("players still alive + 1"); a field that grows
 * afterwards (a late entry, a re-entry) made the next bust reuse a place.
 * The places are what the master awards seats (top 3) and monthly credits
 * (top 10%) from, so they must always be exactly 1..N, one each.
 */
import { TournamentManager, qualifierBlindLevelsForTest } from './helpers/qualifierPlacesWorld';

function field(n: number) {
  const tm = new TournamentManager();
  const id = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: n, startInterval: 0,
    blindLevels: qualifierBlindLevelsForTest(), startingChips: 50_000,
  } as any);
  for (let i = 1; i <= n; i++) tm.registerPlayer(id, `p${i}`, `P${i}`, `s${i}`, undefined, `m${i}`);
  tm.startTournament(id);
  return { tm, id, t: () => tm.getTournament(id)! };
}

const placesOf = (t: any): number[] => t.players.map((p: any) => p.finishPosition).sort((a: number, b: number) => a - b);
const oneToN = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const bustAll = (tm: TournamentManager, id: string, order: string[]) => { for (const pid of order) tm.eliminatePlayer(id, pid); };

describe('qualifier places with late entries and re-entries', () => {
  afterEach(() => { jest.clearAllTimers(); });

  it('CONTROL — no late entry: places 1..N', () => {
    const { tm, id, t } = field(10);
    bustAll(tm, id, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    expect(t().status).toBe('finished');
    expect(placesOf(t())).toEqual(oneToN(10));
  });

  it('a late entry after busts: the busted places move down one, the late entrant gets a real place (was: a duplicate + a missing last place)', () => {
    const { tm, id, t } = field(30);
    bustAll(tm, id, Array.from({ length: 15 }, (_, i) => `p${i + 1}`));   // places 30..16
    expect(t().players.find((p) => p.playerId === 'p1')!.finishPosition).toBe(30);
    tm.addLateEntrant(id, 'late', 'Late', 'sL', 50_000, { masterUserId: 'mL' });
    expect(t().players.find((p) => p.playerId === 'p1')!.finishPosition).toBe(31);   // first out of 31
    expect(t().players.find((p) => p.playerId === 'p15')!.finishPosition).toBe(17);
    bustAll(tm, id, [...Array.from({ length: 15 }, (_, i) => `p${i + 16}`).slice(0, 14), 'late']);
    expect(t().status).toBe('finished');
    expect(placesOf(t())).toEqual(oneToN(31));
  });

  it('removeLateEntrant (the seat could not be taken) undoes the shift', () => {
    const { tm, id, t } = field(9);
    bustAll(tm, id, ['p1', 'p2', 'p3']);                               // 9, 8, 7
    tm.addLateEntrant(id, 'late', 'Late', 'sL', 50_000, { masterUserId: 'mL' });
    expect(t().players.find((p) => p.playerId === 'p1')!.finishPosition).toBe(10);
    expect(tm.removeLateEntrant(id, 'late')).toBe(true);
    expect(t().players.filter((p) => p.eliminated).map((p) => p.finishPosition).sort()).toEqual([7, 8, 9]);
    bustAll(tm, id, ['p4', 'p5', 'p6', 'p7', 'p8']);
    expect(placesOf(t())).toEqual(oneToN(9));
  });

  it('a re-entry: his old place is freed and those who busted after him move down one (was: a duplicate)', () => {
    const { tm, id, t } = field(10);
    bustAll(tm, id, ['p1', 'p2', 'p3']);                               // p1 10, p2 9, p3 8
    expect(tm.reinstateForReentry(id, 'p1', 50_000)).toBe(true);
    const p1 = t().players.find((p) => p.playerId === 'p1')!;
    expect(p1).toMatchObject({ eliminated: false, finishPosition: 0, chips: 50_000 });
    expect(t().players.find((p) => p.playerId === 'p2')!.finishPosition).toBe(10);
    expect(t().players.find((p) => p.playerId === 'p3')!.finishPosition).toBe(9);
    bustAll(tm, id, ['p4', 'p1', 'p5', 'p6', 'p7', 'p8', 'p9']);
    expect(t().status).toBe('finished');
    expect(placesOf(t())).toEqual(oneToN(10));
  });

  it('a re-entry of a LATER bust leaves the earlier busts alone', () => {
    const { tm, id, t } = field(10);
    bustAll(tm, id, ['p1', 'p2']);                                     // p1 10, p2 9
    tm.reinstateForReentry(id, 'p2', 50_000);
    expect(t().players.find((p) => p.playerId === 'p1')!.finishPosition).toBe(10);
    bustAll(tm, id, ['p3', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    expect(placesOf(t())).toEqual(oneToN(10));
  });

  it('late entries and re-entries mixed, 40 entrants: still 1..N', () => {
    const { tm, id, t } = field(36);
    bustAll(tm, id, ['p1', 'p2', 'p3', 'p4', 'p5']);
    tm.addLateEntrant(id, 'l1', 'L1', 's', 50_000, { masterUserId: 'ml1' });
    tm.reinstateForReentry(id, 'p3', 50_000);
    bustAll(tm, id, ['p6', 'p7', 'l1']);
    tm.addLateEntrant(id, 'l2', 'L2', 's', 50_000, { masterUserId: 'ml2' });
    tm.addLateEntrant(id, 'l3', 'L3', 's', 50_000, { masterUserId: 'ml3' });
    tm.reinstateForReentry(id, 'l1', 50_000);
    tm.addLateEntrant(id, 'l4', 'L4', 's', 50_000, { masterUserId: 'ml4' });
    const alive = () => t().players.filter((p) => !p.eliminated).map((p) => p.playerId);
    while (alive().length > 1) tm.eliminatePlayer(id, alive()[0]);
    expect(t().status).toBe('finished');
    expect(t().players).toHaveLength(40);
    expect(placesOf(t())).toEqual(oneToN(40));
  });

  it('a non-busted entrant cannot be "reinstated"', () => {
    const { tm, id } = field(4);
    expect(tm.reinstateForReentry(id, 'p1', 50_000)).toBe(false);
  });
});

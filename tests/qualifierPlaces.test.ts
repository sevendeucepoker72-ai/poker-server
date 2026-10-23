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

/**
 * 2026-10-22 (owner: "Build it for Sunday") — a qualifier OVERFLOW table: when a
 * late entrant or a re-entrant finds every seat alive, index.ts opens a new
 * table and registers it with TournamentManager.addTable. It used to be
 * impossible: TournamentManager only ever REMOVED tables (removeTable), so the
 * entry was refused no_seat and the credit refunded.
 */
describe('qualifier overflow tables — TournamentManager.addTable + checkRebalance', () => {
  afterEach(() => { jest.clearAllTimers(); });

  it('A1 — addTable: a table opened in a RUNNING tournament joins its live tableIds once (copy-on-write); refused while registering, finished, or already listed', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 4, startInterval: 0,
      blindLevels: qualifierBlindLevelsForTest(), startingChips: 50_000,
    } as any);
    tm.registerPlayer(id, 'p1', 'P1', 's1', undefined, 'm1');
    tm.registerPlayer(id, 'p2', 'P2', 's2', undefined, 'm2');
    expect(tm.addTable(id, 'T-early')).toBe(false);                     // registering: nothing to add to
    tm.startTournament(id);
    tm.setTableIds(id, ['T1']);
    const before = tm.getTournament(id)!.tableIds;
    expect(tm.addTable(id, 'T2')).toBe(true);
    expect(tm.getTournament(id)!.tableIds).toEqual(['T1', 'T2']);
    expect(before).toEqual(['T1']);                                     // a copy, never mutated in place (like removeTable)
    expect(tm.addTable(id, 'T2')).toBe(false);                          // listed once
    expect(tm.addTable(id, '')).toBe(false);
    expect(tm.addTable('no-such-tournament', 'T3')).toBe(false);
    expect(tm.getTournament(id)!.tableIds).toEqual(['T1', 'T2']);
    expect(tm.getActiveTableCount(id)).toBe(2);
    tm.eliminatePlayer(id, 'p1');                                       // one left: finished
    expect(tm.getTournament(id)!.status).toBe('finished');
    expect(tm.addTable(id, 'T3')).toBe(false);
    expect(tm.getTournament(id)!.tableIds).toEqual(['T1', 'T2']);
  });

  it('A2 — checkRebalance with an added table: two full tables + a lone added table → nothing (no room); one bust elsewhere → Rule 1 breaks the added table; a 4-alive table whose seats cannot take a mover fits into the added table → Rule 2 breaks it', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 30, startInterval: 0,
      blindLevels: qualifierBlindLevelsForTest(), startingChips: 50_000,
    } as any);
    for (let i = 1; i <= 18; i++) tm.registerPlayer(id, `p${i}`, `P${i}`, `s${i}`, undefined, `m${i}`);
    tm.startTournament(id);
    tm.setTableIds(id, ['TA', 'TB']);
    for (let i = 1; i <= 18; i++) tm.setPlayerTable(id, `p${i}`, i <= 9 ? 'TA' : 'TB');
    // Every seat alive: the late entrant gets a NEW table.
    tm.addLateEntrant(id, 'late', 'Late', 'sL', 50_000, { masterUserId: 'mL' });
    expect(tm.addTable(id, 'TL')).toBe(true);
    tm.setPlayerTable(id, 'late', 'TL');
    // index.ts's capacity: the seats a mover could take (empty + busted) — 9 minus the alive mapped there.
    const free = (tid: string) => 9 - tm.getAlivePlayersOnTable(id, tid).length;
    expect(tm.checkRebalance(id, free)).toBeNull();                     // 19 alive > 18; TL's one player has no room elsewhere
    expect(tm.checkRebalance(id)).toBeNull();
    tm.eliminatePlayer(id, 'p3');                                       // a bust at TA: 18 alive fit two tables
    expect(tm.checkRebalance(id, free)).toEqual({ breakTableId: 'TL', playersToMove: [{ playerId: 'late', playerName: 'Late' }] });

    // A full table, a 4-alive table whose other seats cannot take a mover (they
    // hold busts still being settled), and an added table with 8 seats free.
    const tm2 = new TournamentManager();
    const id2 = tm2.createTournament({
      name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 30, startInterval: 0,
      blindLevels: qualifierBlindLevelsForTest(), startingChips: 50_000,
    } as any);
    for (let i = 1; i <= 13; i++) tm2.registerPlayer(id2, `q${i}`, `Q${i}`, `s${i}`, undefined, `n${i}`);
    tm2.startTournament(id2);
    tm2.setTableIds(id2, ['TA', 'TB']);
    for (let i = 1; i <= 13; i++) tm2.setPlayerTable(id2, `q${i}`, i <= 9 ? 'TA' : 'TB');
    tm2.addLateEntrant(id2, 'late', 'Late', 'sL', 50_000, { masterUserId: 'mL' });
    expect(tm2.addTable(id2, 'TL')).toBe(true);
    tm2.setPlayerTable(id2, 'late', 'TL');
    const free2 = (tid: string) => ({ TA: 0, TB: 0, TL: 8 } as Record<string, number>)[tid];
    // Rule 1 (14 alive fit two tables) cannot break TL (nobody has room for its player);
    // Rule 2 breaks TB: its 4 players fit into TL's 8 free seats.
    expect(tm2.checkRebalance(id2, free2)).toEqual({
      breakTableId: 'TB',
      playersToMove: ['q10', 'q11', 'q12', 'q13'].map((p) => ({ playerId: p, playerName: p.toUpperCase() })),
    });
  });
});

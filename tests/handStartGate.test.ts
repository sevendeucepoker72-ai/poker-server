/**
 * 2026-10-09 — (C) a player suspended mid-session no longer keeps his seat.
 *
 * index.ts stands such a player up from PokerTable's 'beforeHandStart' event
 * (standUpSuspendedSeatsBeforeDeal → the existing leave paths; the decision
 * logic is planHandStartGate, pinned in playGate.test.ts). These tests pin the
 * ENGINE half with a real PokerTable:
 *   - the event fires before anything of the new hand happens: the previous
 *     pot is awarded, no blind is posted, no card dealt — so a stand-up there
 *     returns the player's WHOLE stack (chip conservation checked);
 *   - the stood-up seat is not dealt in; the hand starts without him, or does
 *     not start at all when fewer than two players remain;
 *   - a throwing listener cannot stop the hand loop.
 * And the TOURNAMENT half: TournamentManager.disqualifyPlayer eliminates the
 * entrant (so the tournament can still finish) and he is paid nothing.
 */

import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';

function makeTable(): PokerTable {
  return new PokerTable({
    tableId: 'gate-table', tableName: 'Gate', smallBlind: 25, bigBlind: 50,
    minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9,
  } as any);
}

const tableChips = (t: PokerTable) =>
  t.seats.reduce((sum, s) => sum + (s.state === 'occupied' ? s.chipCount : 0), 0) + t.getTotalPot();

/** Fold the hand out (whoever is to act folds until one player is left). */
function foldOut(t: PokerTable): void {
  for (let guard = 0; guard < 20 && t.isHandInProgress(); guard++) {
    if (t.activeSeatIndex < 0) break;
    t.playerFold(t.activeSeatIndex);
  }
  expect(t.isHandInProgress()).toBe(false);
}

describe("PokerTable 'beforeHandStart' — the pre-deal stand-up point", () => {
  it('fires before blinds / cards: nothing is committed to a pot at that moment', () => {
    const t = makeTable();
    [0, 1, 2].forEach((i) => t.sitDown(i, `P${i}`, 5000, `p${i}`, false));
    const seen: Array<{ inHand: boolean; invested: number; cards: number; handNumber: number }> = [];
    t.on('beforeHandStart', (d: { handNumber: number }) => {
      seen.push({
        inHand: t.isHandInProgress(),
        invested: t.seats.reduce((s, x) => s + (x.totalInvestedThisHand || 0), 0),
        cards: t.seats.reduce((s, x) => s + (x.holeCards?.length || 0), 0),
        handNumber: d.handNumber,
      });
    });
    expect(t.startNewHand()).toBe(true);
    foldOut(t);
    expect(t.startNewHand()).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ inHand: false, invested: 0, cards: 0, handNumber: 1 });
    // Before hand 2: hand 1 is complete and its pot awarded (no investment left).
    expect(seen[1].inHand).toBe(false);
    expect(seen[1].invested).toBe(0);
    expect(seen[1].handNumber).toBe(2);
  });

  it('a seat stood up there leaves with its WHOLE stack, is not dealt in, and the hand runs without him', () => {
    const t = makeTable();
    [0, 1, 2].forEach((i) => t.sitDown(i, `P${i}`, 5000, `p${i}`, false));
    const total = tableChips(t);
    expect(total).toBe(15000);
    t.startNewHand();
    foldOut(t);
    const stackAfterHand1 = t.seats[1].chipCount;

    let credited = 0;
    t.on('beforeHandStart', () => {
      // What index.ts does through handlePlayerLeave: credit the stack, stand up.
      if (t.seats[1].state === 'occupied') {
        credited += t.seats[1].chipCount;
        t.standUp(1);
      }
    });
    expect(t.startNewHand()).toBe(true);
    expect(credited).toBe(stackAfterHand1);           // the whole stack, nothing left in a pot
    expect(t.seats[1].state).toBe('empty');
    expect(t.seats[1].holeCards?.length || 0).toBe(0);  // not dealt in
    expect(t.seats[1].totalInvestedThisHand || 0).toBe(0);
    expect(t.getTotalPot()).toBe(75);                   // blinds came from the two remaining players
    expect(tableChips(t) + credited).toBe(total);       // chip conservation
  });

  it('when the stand-up leaves fewer than two players, no hand starts', () => {
    const t = makeTable();
    [0, 1].forEach((i) => t.sitDown(i, `P${i}`, 5000, `p${i}`, false));
    t.on('beforeHandStart', () => { t.standUp(0); });
    expect(t.startNewHand()).toBe(false);
    expect(t.isHandInProgress()).toBe(false);
    expect(t.getTotalPot()).toBe(0);
    expect(t.seats[1].chipCount).toBe(5000);
  });

  it('a throwing listener never stops the hand loop', () => {
    const t = makeTable();
    [0, 1, 2].forEach((i) => t.sitDown(i, `P${i}`, 5000, `p${i}`, false));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    t.on('beforeHandStart', () => { throw new Error('gate exploded'); });
    try {
      expect(t.startNewHand()).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.PreFlop);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('TournamentManager.disqualifyPlayer — suspended mid-tournament', () => {
  function running(buyIn = 500) {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'DQ-CUP', buyIn, prizePool: 1000, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS,
    } as any);
    tm.registerPlayer(id, 'p1', 'Alice', 's1', 101);
    tm.registerPlayer(id, 'roger', 'Roger', 's2', 102);
    tm.registerPlayer(id, 'p3', 'Cara', 's3', 103);
    let results: any[] | null = null;
    tm.onEvent(id, (event, data) => { if (event === 'tournamentFinished') results = data.results; });
    tm.startTournament(id);
    return { tm, id, getResults: () => results };
  }

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('eliminates him (worst remaining place) without finishing a field that is still playing', () => {
    const { tm, id } = running();
    expect(tm.disqualifyPlayer(id, 'roger')).toEqual({ finished: false, position: 3 });
    const roger = tm.getTournament(id)!.players.find((p) => p.playerId === 'roger')!;
    expect(roger).toMatchObject({ eliminated: true, disqualified: true, chips: 0, finishPosition: 3 });
  });

  it('is paid NOTHING even in a paid place; the tournament still finishes; never mints', () => {
    const { tm, id, getResults } = running();
    tm.disqualifyPlayer(id, 'roger');   // 3rd — a paid place (50/30/20)
    tm.eliminatePlayer(id, 'p3');       // 2nd → finishes, Alice 1st
    const results = getResults()!;
    expect(results).not.toBeNull();
    const by = (pid: string) => results.find((r: any) => r.playerId === pid);
    expect(by('roger')).toMatchObject({ position: 3, payout: 0, disqualified: true });
    expect(by('p1')).toMatchObject({ position: 1, payout: 750 });  // 50% of 3×500
    expect(by('p3')).toMatchObject({ position: 2, payout: 450 });  // 30%
    const paid = results.reduce((s: number, r: any) => s + r.payout, 0);
    expect(paid).toBeLessThanOrEqual(tm.getTournament(id)!.collectedEntryFees);
  });

  it('disqualifying the second-to-last entrant finishes the tournament (no wedge)', () => {
    const { tm, id, getResults } = running();
    tm.eliminatePlayer(id, 'p3');
    expect(tm.disqualifyPlayer(id, 'roger')).toMatchObject({ finished: true });
    expect(tm.getTournament(id)!.status).toBe('finished');
    expect(getResults()!.find((r: any) => r.playerId === 'p1')).toMatchObject({ position: 1 });
    expect(getResults()!.find((r: any) => r.playerId === 'roger')).toMatchObject({ payout: 0, disqualified: true });
  });

  it('no-op for an entrant already out, an unknown player, or a tournament not running', () => {
    const { tm, id } = running();
    tm.eliminatePlayer(id, 'p3');
    expect(tm.disqualifyPlayer(id, 'p3')).toBeNull();
    expect(tm.disqualifyPlayer(id, 'nobody')).toBeNull();
    const tm2 = new TournamentManager();
    const id2 = tm2.createTournament({ name: 'X', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    tm2.registerPlayer(id2, 'a', 'A', 's', 1);
    expect(tm2.disqualifyPlayer(id2, 'a')).toBeNull(); // still registering
  });

  it('results of a normal (no-DQ) tournament carry no disqualified flag', () => {
    const { tm, id, getResults } = running();
    tm.eliminatePlayer(id, 'p3');
    tm.eliminatePlayer(id, 'roger');
    for (const r of getResults()!) expect(r).not.toHaveProperty('disqualified');
  });
});

describe('S4 — TournamentManager.disqualifyPlayers: a suspended entrant is NEVER paid, even as the survivor', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function headsUp(buyIn = 1000) {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'HU-S4', buyIn, prizePool: 0, maxPlayers: 2, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS,
    } as any);
    tm.registerPlayer(id, 'pA', 'A', 'sA', 101);
    tm.registerPlayer(id, 'pB', 'B', 'sB', 102);
    let results: any[] | null = null;
    let finishedEvents = 0;
    tm.onEvent(id, (event, data) => { if (event === 'tournamentFinished') { results = data.results; finishedEvents++; } });
    tm.startTournament(id);
    return { tm, id, getResults: () => results, finishedEvents: () => finishedEvents };
  }

  it('REPRO of the review finding: one-at-a-time, the second suspended heads-up player is paid 1st place', () => {
    // What the hand-start gate did before S4 (disqualifyPlayer per seat, in order).
    const { tm, id, getResults } = headsUp();
    tm.disqualifyPlayer(id, 'pA');            // finishes the tournament — B still unflagged
    tm.disqualifyPlayer(id, 'pB');            // too late: already finished
    const b = getResults()!.find((r: any) => r.playerId === 'pB');
    expect(b).toMatchObject({ position: 1, payout: 1250 }); // 62.5% (R2: heads-up pays the whole pool) of 2×1000 to a suspended player
    expect(b).not.toHaveProperty('disqualified');
  });

  it('heads-up, BOTH suspended, one batch: the tournament finishes and NOBODY is paid', () => {
    const { tm, id, getResults, finishedEvents } = headsUp();
    const out = tm.disqualifyPlayers(id, ['pA', 'pB']);
    expect(out.get('pA')).toEqual({ finished: true, position: 2 });
    expect(out.get('pB')).toEqual({ finished: true, position: 1 });
    expect(tm.getTournament(id)!.status).toBe('finished');
    expect(finishedEvents()).toBe(1);
    const results = getResults()!;
    expect(results.find((r: any) => r.playerId === 'pA')).toMatchObject({ position: 2, payout: 0, disqualified: true });
    expect(results.find((r: any) => r.playerId === 'pB')).toMatchObject({ position: 1, payout: 0, disqualified: true });
    expect(results.reduce((s: number, r: any) => s + r.payout, 0)).toBe(0);
  });

  it('3 left, 2 suspended in one batch: the ELIGIBLE player wins; neither suspended player is paid', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament({ name: 'S4-3', buyIn: 500, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    tm.registerPlayer(id, 'ok', 'Okay', 's1', 1);
    tm.registerPlayer(id, 'x', 'X', 's2', 2);
    tm.registerPlayer(id, 'y', 'Y', 's3', 3);
    let results: any[] | null = null;
    tm.onEvent(id, (event, data) => { if (event === 'tournamentFinished') results = data.results; });
    tm.startTournament(id);
    tm.disqualifyPlayers(id, ['x', 'y']);
    const by = (pid: string) => results!.find((r: any) => r.playerId === pid);
    expect(by('ok')).toMatchObject({ position: 1, payout: 750 });
    expect(by('x')).toMatchObject({ payout: 0, disqualified: true });
    expect(by('y')).toMatchObject({ payout: 0, disqualified: true });
    expect(results!.reduce((s: number, r: any) => s + r.payout, 0)).toBeLessThanOrEqual(1500);
  });

  it('unknown / already-out / duplicate ids are null or ignored; a non-running tournament is untouched', () => {
    const { tm, id } = headsUp();
    const out = tm.disqualifyPlayers(id, ['nobody', 'pA', 'pA']);
    expect(out.get('nobody')).toBeNull();
    expect(out.get('pA')).toEqual({ finished: true, position: 2 });
    expect(tm.disqualifyPlayers(id, ['pB']).get('pB')).toBeNull(); // finished → nothing more
  });

  it('index.ts: a disqualified result gets no prize, no progression credit (achievement rewards pay) and no winner ticker', () => {
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const at = src.indexOf('async function payTournamentPrizes(');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain('if (r.playerId && !r.disqualified) progressionManager.recordTournamentResult(r.playerId, r.position);');
    expect(body).toContain('r.position === 1 && r.userId !== undefined && !r.disqualified');
    expect(body).toContain('if (r.userId === undefined || !(r.payout > 0) || r.disqualified) continue;');
  });
});

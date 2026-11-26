/**
 * 2026-11-25 (owner, ~10:40 PM MT: "for all online tournaments to be able to
 * see who is registered in the lobby and a list for it to show who busted in
 * each position") — the server side of the two lobby lists.
 *
 *  - REGISTERED: every qualifier list item (socket `getQualifierTournaments`
 *    only; the anonymous REST list stays name-free) and every tournament list
 *    item (`getTournaments` / the 10 s broadcast) carries `registrantNames`:
 *    PUBLIC names (publicNameOf) in registration order, each entry once (a
 *    re-entry is the same entry), at most REGISTRANT_NAMES_MAX. Never an id, a
 *    master id, a login handle or a phone. A club tournament's item (and so its
 *    names) still reaches only its own entrants.
 *  - RESULTS: getTournamentStandings answers for a FINISHED tournament too —
 *    from its live record, then (once TournamentManager drops it: a template
 *    10 s after its finish, anything else an hour after) from the roster
 *    finishTournament kept, for >= 24 h (25 h; bounded). Places are the STORED
 *    finishPosition (ties, hand-for-hand, late-entry shifts). Lobby items
 *    carry `resultsTournamentId` (+ qualifier items `resultsQualifierId`): the
 *    running / finished event itself, else the latest finished one of the same
 *    card still kept.
 *
 * The pure module (src/game/lobbyLists.ts), the REAL TournamentManager, and the
 * REAL index.ts source (qualifierListItem / qualifierLobbyListFields /
 * qualifierList, the getQualifierTournaments + getTournamentStandings handlers,
 * the REST routes, publicTournamentStandings) through the indexSource harness.
 * CONTROL cases: a cancelled tournament keeps no roster; past the keep window
 * nothing is served; the size bound never drops a card's latest roster first;
 * the no-id getTournamentStandings still answers only a RUNNING tournament.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { TournamentManager } from '../src/game/TournamentManager';
import {
  registrantNamesOf, REGISTRANT_NAMES_MAX, FinishedStandingsStore, FinishedStandingsRecord, FINISHED_STANDINGS_KEEP_MS,
  FINISHED_STANDINGS_MAX, qualifierResultsPointer,
} from '../src/game/lobbyLists';
import { publicNameOf } from '../src/social/publicIdentity';
import {
  qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
  QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifierEventConfig,
} from '../src/game/qualifierSchedule';
import { SRC, slice, fnSrc, handlerSrc, load } from './helpers/indexSource';

const H = 60 * 60_000;
const LEVELS = [{ sb: 25, bb: 50, ante: 0, duration: 600 }];

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

/** A non-template tournament (custom / qualifier-like): a fresh id, registering. */
const custom = (tm: TournamentManager, name = 'Custom Cup', max = 9, extra: Record<string, unknown> = {}) =>
  tm.createTournament({ name, buyIn: 0, prizePool: 0, maxPlayers: max, startInterval: 0, blindLevels: LEVELS, ...extra } as any);
const regId = (tm: TournamentManager, name: string) => {
  for (const [id, t] of (tm as any).tournaments as Map<string, any>) if (t.config.name === name && t.status === 'registering') return id as string;
  throw new Error(`no registering ${name}`);
};
const item = (tm: TournamentManager, tid: string, viewer: any = null) => (tm.getTournamentList(viewer) as any[]).find((x) => x.tournamentId === tid);
const placesOf = (st: any) => Object.fromEntries(st.players.map((p: any) => [p.playerId, p.finishPosition]));
const storedPlacesOf = (tm: TournamentManager, tid: string) =>
  Object.fromEntries(tm.getTournament(tid)!.players.map((p) => [p.playerId, p.finishPosition > 0 ? p.finishPosition : null]));

function rec(id: string, cardKey: string, finishedAt: number): FinishedStandingsRecord {
  return {
    tournamentId: id, name: id, status: 'finished', eliminationOrder: ['b'], finishedAt, cardKey,
    players: [{ playerId: 'a', playerName: 'Ann', chipCount: 0, finishPosition: 1 }, { playerId: 'b', playerName: 'Bob', chipCount: 0, finishPosition: 2 }],
  };
}

// ═════════════════════════════════════════════ the pure module
describe('registrantNamesOf — public names, registration order, each entry once, bounded', () => {
  it('public names ONLY: a display name stays, a phone / email / missing name is "Player"; the keys (ids) never appear', () => {
    const names = registrantNamesOf([
      { key: 'user-101', name: 'Stacy L.' },
      { key: 'user-102', name: '3035551234' },
      { key: 'm-c3', name: 'jo@example.com' },
      { key: 'user-104', name: undefined },
      { key: 'ai-1', name: 'Ace' },
    ]);
    expect(names).toEqual(['Stacy L.', 'Player', 'Player', 'Player', 'Ace']);
    expect(names).toEqual(['Stacy L.', '3035551234', 'jo@example.com', undefined, 'Ace'].map(publicNameOf));
    const json = JSON.stringify(names);
    for (const leak of ['user-101', 'user-102', 'm-c3', '3035551234', 'jo@example.com', 'ai-1']) expect(json).not.toContain(leak);
  });

  it('registration order kept; a repeated key (the same entry) once — the first wins; key-less entries are each kept; not an array → []', () => {
    expect(registrantNamesOf([{ key: 'a', name: 'Ann' }, { key: 'b', name: 'Bob' }, { key: 'a', name: 'Ann Again' }, { key: 'c', name: 'Cy' }]))
      .toEqual(['Ann', 'Bob', 'Cy']);
    expect(registrantNamesOf([{ name: 'Bot' }, { key: null, name: 'Bot' }, { key: '', name: 'Bot' }])).toEqual(['Bot', 'Bot', 'Bot']);
    expect(registrantNamesOf(null)).toEqual([]);
    expect(registrantNamesOf(undefined)).toEqual([]);
    expect(registrantNamesOf([null as any, 7 as any, { key: 'x', name: 'Xavi' }])).toEqual(['Xavi']);
  });

  it(`bounded: at most REGISTRANT_NAMES_MAX (${REGISTRANT_NAMES_MAX}) names, the FIRST registrants; a smaller max is honoured`, () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ key: `user-${i}`, name: `Player${i}` }));
    const names = registrantNamesOf(many);
    expect(names).toHaveLength(REGISTRANT_NAMES_MAX);
    expect(names[0]).toBe('Player0');
    expect(names[REGISTRANT_NAMES_MAX - 1]).toBe(`Player${REGISTRANT_NAMES_MAX - 1}`);
    expect(JSON.stringify(names).length).toBeLessThan(REGISTRANT_NAMES_MAX * 23);   // 20-char names + quotes + comma
    expect(registrantNamesOf(many, 2)).toEqual(['Player0', 'Player1']);
  });
});

describe('FinishedStandingsStore — kept >= 24 h, a copy per read, bounded without dropping a card\'s latest first', () => {
  it('the keep window: served up to FINISHED_STANDINGS_KEEP_MS (>= 24 h) after the finish, then gone (CONTROL: one ms past it)', () => {
    expect(FINISHED_STANDINGS_KEEP_MS).toBeGreaterThanOrEqual(24 * H);
    const s = new FinishedStandingsStore();
    const t0 = 1_000_000;
    s.note(rec('T1', 'tournament:T1', t0), t0);
    expect(s.get('T1', t0 + 24 * H)).toMatchObject({ tournamentId: 'T1', status: 'finished' });
    expect(s.get('T1', t0 + FINISHED_STANDINGS_KEEP_MS)).not.toBeNull();
    expect(s.has('T1', t0 + FINISHED_STANDINGS_KEEP_MS + 1)).toBe(false);
    expect(s.get('T1', t0 + FINISHED_STANDINGS_KEEP_MS + 1)).toBeNull();
    s.prune(t0 + FINISHED_STANDINGS_KEEP_MS + 1);
    expect(s.size).toBe(0);
    expect(s.stats.expired).toBe(1);
  });

  it('get answers a COPY (a caller that edits it never changes what is kept)', () => {
    const s = new FinishedStandingsStore();
    s.note(rec('T1', 'tournament:T1', 5), 5);
    const a = s.get('T1', 5)!;
    a.players[0].playerName = 'Mallory';
    a.eliminationOrder.push('zzz');
    expect(s.get('T1', 5)).toMatchObject({ players: [{ playerName: 'Ann' }, { playerName: 'Bob' }], eliminationOrder: ['b'] });
  });

  it('latestIdFor: the newest roster of a card, inside the keep window', () => {
    const s = new FinishedStandingsStore();
    s.note(rec('S1', 'template:Sit & Go', 10), 10);
    s.note(rec('S2', 'template:Sit & Go', 20), 20);
    s.note(rec('D1', 'template:Daily 5K', 30), 30);
    expect(s.latestIdFor('template:Sit & Go', 30)).toBe('S2');
    expect(s.latestIdFor('template:Daily 5K', 30)).toBe('D1');
    expect(s.latestIdFor('template:Freeroll', 30)).toBeNull();
    expect(s.latestIdFor('template:Sit & Go', 20 + FINISHED_STANDINGS_KEEP_MS + 1)).toBeNull();
  });

  it('the size bound drops the OLDEST roster that is not its card\'s latest (a busy template never pushes out a qualifier); CONTROL: at the bound nothing goes', () => {
    const s = new FinishedStandingsStore(FINISHED_STANDINGS_KEEP_MS, 3);
    s.note(rec('Q', 'tournament:Q', 1), 1);               // the oldest of all, but its card's only (latest) roster
    s.note(rec('A1', 'template:Sit & Go', 2), 2);
    s.note(rec('A2', 'template:Sit & Go', 3), 3);
    expect(s.size).toBe(3);                               // CONTROL: at the bound
    expect(s.stats.evicted).toBe(0);
    s.note(rec('A3', 'template:Sit & Go', 4), 4);
    expect(s.size).toBe(3);
    expect(s.has('Q', 4)).toBe(true);
    expect(s.has('A1', 4)).toBe(false);                   // the oldest NON-latest
    expect(s.has('A3', 4)).toBe(true);
    expect(s.stats.evicted).toBe(1);
    // Every roster is its card's latest: the oldest of all goes.
    const t = new FinishedStandingsStore(FINISHED_STANDINGS_KEEP_MS, 2);
    t.note(rec('X', 'tournament:X', 1), 1);
    t.note(rec('Y', 'tournament:Y', 2), 2);
    t.note(rec('Z', 'tournament:Z', 3), 3);
    expect([t.has('X', 3), t.has('Y', 3), t.has('Z', 3)]).toEqual([false, true, true]);
  });

  it(`the default bound (${FINISHED_STANDINGS_MAX}) holds under a flood of one template's finishes; the latest stays`, () => {
    const s = new FinishedStandingsStore();
    for (let i = 0; i < FINISHED_STANDINGS_MAX + 50; i++) s.note(rec(`S${i}`, 'template:Sit & Go', 100 + i), 100 + i);
    expect(s.size).toBe(FINISHED_STANDINGS_MAX);
    expect(s.latestIdFor('template:Sit & Go', 1000)).toBe(`S${FINISHED_STANDINGS_MAX + 49}`);
  });
});

describe('qualifierResultsPointer — which finish order a qualifier card opens', () => {
  const ev = (o: Partial<{ qualifierType: string; status: string; cancelled: boolean; tournamentId: string | null; finishedAt: number }>) =>
    ({ qualifierType: 'online_league', status: 'registering', tournamentId: null, ...o });
  const kept = new Set(['T-RUN', 'T-L0', 'T-L1', 'T-W0']);
  const has = (tid: string) => kept.has(tid);

  it('running / starting: its own tournament; finished and played: its own; cancelled: none', () => {
    expect(qualifierResultsPointer('Q', ev({ status: 'running', tournamentId: 'T-RUN' }), [], has)).toEqual({ resultsTournamentId: 'T-RUN', resultsQualifierId: 'Q' });
    expect(qualifierResultsPointer('Q', ev({ status: 'starting', tournamentId: 'T-RUN' }), [], has)).toEqual({ resultsTournamentId: 'T-RUN', resultsQualifierId: 'Q' });
    expect(qualifierResultsPointer('L0', ev({ status: 'finished', tournamentId: 'T-L0', finishedAt: 5 }), [], has)).toEqual({ resultsTournamentId: 'T-L0', resultsQualifierId: 'L0' });
    expect(qualifierResultsPointer('Lx', ev({ status: 'finished', cancelled: true, tournamentId: 'T-L0' }), [], has)).toEqual({ resultsTournamentId: null, resultsQualifierId: null });
    // Finished but no roster left (dropped): none.
    expect(qualifierResultsPointer('Lg', ev({ status: 'finished', tournamentId: 'T-GONE' }), [], has)).toEqual({ resultsTournamentId: null, resultsQualifierId: null });
  });

  it('registering: the latest finished, played event of the SAME type still kept; never another type, a cancelled one or a dropped one', () => {
    const events: Array<[string, any]> = [
      ['L0', ev({ status: 'finished', tournamentId: 'T-L0', finishedAt: 100 })],
      ['L1', ev({ status: 'finished', tournamentId: 'T-L1', finishedAt: 200 })],
      ['L2', ev({ status: 'finished', cancelled: true, tournamentId: 'T-RUN', finishedAt: 300 })],
      ['L3', ev({ status: 'finished', tournamentId: 'T-GONE', finishedAt: 400 })],
      ['W0', ev({ qualifierType: 'weekly', status: 'finished', tournamentId: 'T-W0', finishedAt: 500 })],
    ];
    const tonight = ev({ status: 'registering' });
    expect(qualifierResultsPointer('L9', tonight, [...events, ['L9', tonight]], has)).toEqual({ resultsTournamentId: 'T-L1', resultsQualifierId: 'L1' });
    expect(qualifierResultsPointer('W1', ev({ qualifierType: 'weekly' }), events, has)).toEqual({ resultsTournamentId: 'T-W0', resultsQualifierId: 'W0' });
    expect(qualifierResultsPointer('M1', ev({ qualifierType: 'monthly' }), events, has)).toEqual({ resultsTournamentId: null, resultsQualifierId: null });
  });
});

// ═════════════════════════════════════════════ the REAL TournamentManager
describe('TournamentManager lobby items — registrantNames (who is registered)', () => {
  it('public names in registration order; the phone-like name is "Player"; no entrant id / user id in the names', () => {
    const tm = new TournamentManager();
    const tid = custom(tm);
    tm.registerPlayer(tid, 'user-101', 'Alice', 's1', 101);
    tm.registerPlayer(tid, 'user-102', '3035551234', 's2', 102);
    tm.registerPlayer(tid, 'ai-1', 'Ace', 's3');
    const it0 = item(tm, tid);
    expect(it0.registrantNames).toEqual(['Alice', 'Player', 'Ace']);
    expect(it0.registeredPlayers).toBe(3);
    const json = JSON.stringify(it0.registrantNames);
    for (const leak of ['user-101', 'user-102', '101', '3035551234', 'ai-1']) expect(json).not.toContain(leak);
    // Live: a withdrawal leaves the list at the next read.
    tm.unregisterPlayer(tid, 'user-102');
    expect(item(tm, tid).registrantNames).toEqual(['Alice', 'Ace']);
  });

  it('running: a late entrant is added at the end; a re-entered player stays ONCE (same entry)', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Late Cup');
    for (const [pid, nm] of [['user-1', 'Ann'], ['user-2', 'Bob'], ['user-3', 'Cy']]) tm.registerPlayer(tid, pid, nm, `s-${pid}`, Number(pid.slice(5)));
    tm.startTournament(tid);
    tm.eliminatePlayer(tid, 'user-1');
    expect(tm.addLateEntrant(tid, 'user-4', 'Dee', 's4', 1000, { userId: 4 })).toBeTruthy();
    expect(tm.reinstateForReentry(tid, 'user-1', 1000)).toBe(true);
    expect(item(tm, tid).registrantNames).toEqual(['Ann', 'Bob', 'Cy', 'Dee']);
  });

  it('a CLUB tournament (unlisted): its item — names included — reaches only its own entrants (the R2 rule, unchanged)', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Club Night', 9, { unlisted: true });
    tm.registerPlayer(tid, 'user-1', 'Ann', 's1', 1);
    tm.registerPlayer(tid, 'user-2', 'Bob', 's2', 2);
    expect(item(tm, tid, null)).toBeUndefined();
    expect(item(tm, tid, { userId: 3 })).toBeUndefined();
    expect(JSON.stringify(tm.getTournamentList({ userId: 3 }))).not.toMatch(/"Ann"|"Bob"/);
    expect(item(tm, tid, { userId: 1 })).toMatchObject({ registered: true, registrantNames: ['Ann', 'Bob'] });
  });

  it(`payload bound: a 400-entrant field lists the first ${REGISTRANT_NAMES_MAX} names; registeredPlayers stays the full count`, () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Big Field', 500);
    for (let i = 0; i < 400; i++) expect(tm.registerPlayer(tid, `user-${i}`, `Player${i}`, `s${i}`, 1000 + i).success).toBe(true);
    const it0 = item(tm, tid);
    expect(it0.registrantNames).toHaveLength(REGISTRANT_NAMES_MAX);
    expect(it0.registeredPlayers).toBe(400);
  });

  it('every template item carries registrantNames ([] when empty) and resultsTournamentId (null before any finish)', () => {
    const tm = new TournamentManager();
    for (const it0 of tm.getTournamentList() as any[]) {
      expect(it0.registrantNames).toEqual([]);
      expect(it0.resultsTournamentId).toBeNull();
    }
  });
});

describe('TournamentManager — getTournamentStandings for a FINISHED tournament (kept >= 24 h)', () => {
  /** A 4-entrant custom event played to the end: D 4th, C 3rd, B 2nd, A 1st. */
  function finished() {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Finish Cup');
    for (const [pid, nm] of [['A', 'Ann'], ['B', 'Bob'], ['C', 'Cy'], ['D', 'Dee']]) tm.registerPlayer(tid, pid, nm, `s${pid}`);
    tm.startTournament(tid);
    for (const pid of ['D', 'C', 'B']) tm.eliminatePlayer(tid, pid);
    return { tm, tid };
  }

  it('the live record answers status "finished" + finishedAt; once it is dropped (1 h) the kept roster answers the SAME standings', () => {
    const { tm, tid } = finished();
    const live = tm.getTournamentStandings(tid, null)!;
    expect(live).toMatchObject({ tournamentId: tid, name: 'Finish Cup', status: 'finished', eliminationOrder: ['D', 'C', 'B'] });
    expect(typeof live.finishedAt).toBe('number');
    expect(placesOf(live)).toEqual({ A: 1, B: 2, C: 3, D: 4 });
    expect(item(tm, tid).resultsTournamentId).toBe(tid);
    expect(tm.pruneEndedTournaments(Date.now() + H + 1)).toEqual([tid]);
    expect(tm.getTournament(tid)).toBeUndefined();
    expect(item(tm, tid)).toBeUndefined();               // the card leaves the list as before (1 h)
    const kept = tm.getTournamentStandings(tid, null)!;
    expect(kept).toEqual(live);
    expect(tm.hasStandings(tid)).toBe(true);
    expect(tm.finishedStandingsHealth()).toMatchObject({ noted: 1, served: 1, kept: 1, noteErrors: 0, evicted: 0 });
  });

  it('still answered 24 h after the finish; past the keep window nothing (CONTROL)', () => {
    const { tm, tid } = finished();
    const t0 = Date.now();
    tm.pruneEndedTournaments(t0 + H + 1);
    jest.setSystemTime(t0 + 24 * H);
    expect(tm.getTournamentStandings(tid, null)).toMatchObject({ status: 'finished' });
    jest.setSystemTime(t0 + FINISHED_STANDINGS_KEEP_MS + 1);
    expect(tm.getTournamentStandings(tid, null)).toBeNull();
    expect(tm.hasStandings(tid)).toBe(false);
    tm.pruneEndedTournaments();
    expect(tm.finishedStandingsHealth()).toMatchObject({ kept: 0, expired: 1 });
  });

  it('CONTROL: a CANCELLED tournament keeps no roster (only a finish records one); an unknown id is null', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Never Played', 9, { buyIn: 0 });
    tm.registerPlayer(tid, 'A', 'Ann', 'sA');
    tm.cancelTournament(tid);
    tm.pruneEndedTournaments(Date.now() + H + 1);
    expect(tm.getTournamentStandings(tid, null)).toBeNull();
    expect(tm.getTournamentStandings('nope', null)).toBeNull();
    expect(tm.finishedStandingsHealth()).toMatchObject({ noted: 0, kept: 0 });
  });

  it('a TEMPLATE (Sit & Go): dropped 10 s after its finish — the registering card points at the finished one\'s results, still served', () => {
    const tm = new TournamentManager();
    const tid = regId(tm, 'Sit & Go');
    for (let i = 0; i < 9; i++) expect(tm.registerPlayer(tid, `user-${i}`, `P${i}`, `s${i}`, 100 + i).success).toBe(true);
    expect(tm.startTournament(tid)).toBeTruthy();
    const next = regId(tm, 'Sit & Go');                    // the instance opened at the start (F9)
    expect(next).not.toBe(tid);
    expect(item(tm, next).resultsTournamentId).toBeNull(); // CONTROL: nothing finished yet
    expect(item(tm, tid).resultsTournamentId).toBe(tid);   // running: its own
    for (let i = 8; i >= 1; i--) tm.eliminatePlayer(tid, `user-${i}`);
    const live = tm.getTournamentStandings(tid, null)!;
    expect(live.status).toBe('finished');
    jest.advanceTimersByTime(10_000);                      // finishTournament's re-creation drops the record
    expect(tm.getTournament(tid)).toBeUndefined();
    expect(item(tm, next).resultsTournamentId).toBe(tid);
    expect(tm.getTournamentStandings(tid, null)).toEqual(live);
    expect(placesOf(live)).toEqual(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`user-${i}`, i + 1])));
  });

  it('places are the STORED ones: hand-for-hand re-placing and a tie group keep what the engine recorded (live and kept)', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'HFH Cup');
    for (const pid of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) tm.registerPlayer(tid, pid, pid.toUpperCase(), `s${pid}`);
    tm.startTournament(tid);
    tm.eliminatePlayer(tid, 'p6');                          // 6th at the bust
    tm.eliminatePlayer(tid, 'p5');                          // 5th at the bust
    // Same hand-for-hand hand: p6 started it with the bigger stack -> the better place.
    expect(tm.placeSimultaneousBusts(tid, [{ playerId: 'p6', startStack: 900, order: 1 }, { playerId: 'p5', startStack: 100, order: 2 }]))
      .toEqual([{ playerId: 'p6', from: 6, to: 5 }, { playerId: 'p5', from: 5, to: 6 }]);
    expect(tm.markSimultaneousBustTie(tid, ['p4', 'p3'])).toBe(true);
    tm.eliminatePlayer(tid, 'p4');
    tm.eliminatePlayer(tid, 'p3');
    const running = tm.getTournamentStandings(tid, null)!;
    expect(placesOf(running)).toEqual(storedPlacesOf(tm, tid));
    expect(placesOf(running)).toMatchObject({ p6: 5, p5: 6, p4: 4, p3: 3, p1: null, p2: null });
    tm.eliminatePlayer(tid, 'p2');
    const stored = storedPlacesOf(tm, tid);
    expect(stored).toEqual({ p1: 1, p2: 2, p3: 3, p4: 4, p5: 6, p6: 5 });
    expect(placesOf(tm.getTournamentStandings(tid, null))).toEqual(stored);
    tm.pruneEndedTournaments(Date.now() + H + 1);
    expect(placesOf(tm.getTournamentStandings(tid, null))).toEqual(stored);   // the kept roster: the same stored places
  });

  it('a late entry\'s place shift is what the standings show (stored), never a client-side count', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Shift Cup');
    for (const pid of ['a', 'b', 'c']) tm.registerPlayer(tid, pid, pid.toUpperCase(), `s${pid}`);
    tm.startTournament(tid);
    tm.eliminatePlayer(tid, 'c');                           // 3rd ...
    tm.addLateEntrant(tid, 'd', 'D', 'sd', 1000, {});
    expect(placesOf(tm.getTournamentStandings(tid, null))).toMatchObject({ c: 4 });   // ... moved to 4th by the late entry
    tm.eliminatePlayer(tid, 'b');
    tm.eliminatePlayer(tid, 'd');
    expect(placesOf(tm.getTournamentStandings(tid, null))).toEqual({ a: 1, b: 3, c: 4, d: 2 });
  });

  it('a re-entry (F97): the player shows ONCE — still in after the re-entry, then with his final place', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, 'Reentry Cup');
    for (const pid of ['a', 'b', 'c']) tm.registerPlayer(tid, pid, pid.toUpperCase(), `s${pid}`);
    tm.startTournament(tid);
    tm.eliminatePlayer(tid, 'a');
    expect(placesOf(tm.getTournamentStandings(tid, null))).toMatchObject({ a: 3 });
    tm.reinstateForReentry(tid, 'a', 1000);
    const back = tm.getTournamentStandings(tid, null)!;
    expect(back.players.filter((p) => p.playerId === 'a')).toHaveLength(1);
    expect(placesOf(back)).toMatchObject({ a: null });
    expect(back.eliminationOrder).toEqual([]);
    tm.eliminatePlayer(tid, 'b');
    tm.eliminatePlayer(tid, 'a');
    const done = tm.getTournamentStandings(tid, null)!;
    expect(done.players).toHaveLength(3);
    expect(placesOf(done)).toEqual({ a: 2, b: 3, c: 1 });
    expect(done.eliminationOrder).toEqual(['b', 'a']);
  });
});

// ═════════════════════════════════════════════ the REAL index.ts source
const QUAL_CODE = [
  fnSrc('function qualifierEventFor('),
  fnSrc('function qualifierListItem('),
  fnSrc('function qualifierLobbyListFields('),
  fnSrc('function qualifierList('),
  slice("app.get('/api/qualifier-tournaments', ", '\n});\n'),
  slice("app.get('/api/qualifier-tournaments/:qualifierId', ", '\n});\n'),
  fnSrc('function publicTournamentStandings('),
  fnSrc('function tournamentViewerOf('),
].join('\n');
const QUAL_HANDLERS = ['getQualifierTournaments', 'getTournamentStandings'].map((ev) => handlerSrc(ev, '\n  });\n')).join('\n  ');

function qualWorld() {
  const tm = new TournamentManager();
  const qualifierTournaments = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const routes = new Map<string, (req: any, res: any) => void>();
  const scope: Record<string, unknown> = {
    tournamentManager: tm, qualifierTournaments, authSessions,
    tableManager: { getTable: () => undefined },
    qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
    QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers: new Map(), qualifierEventConfig,
    registrantNamesOf, qualifierResultsPointer, publicNameOf, createHash,
    onlineLeagueStats: { listRequests: 0 },
    app: { get: (p: string, fn: any) => { routes.set(p, fn); } },
  };
  const { exports: m, stubbed } = load(`${QUAL_CODE}\nfunction wire(socket) {\n  ${QUAL_HANDLERS}\n}`, scope, '{ wire, qualifierList }');
  const emitted: Array<[string, any]> = [];
  const sock: any = { id: 'SV', handlers: {} as Record<string, (...a: any[]) => any>, on(ev: string, fn: any) { sock.handlers[ev] = fn; }, emit: (ev: string, d: any) => emitted.push([ev, d]) };
  m.wire(sock);
  const rest = (p: string, params: Record<string, string> = {}, query: Record<string, string> = {}) => {
    let body: any = null;
    routes.get(p)!({ params, query, headers: {} }, { json: (b: unknown) => { body = b; } });
    return body;
  };
  const socketList = async (kinds?: string[]) => {
    await sock.handlers.getQualifierTournaments(kinds ? { kinds } : undefined);
    return emitted.filter(([ev]) => ev === 'qualifierTournamentList').pop()![1] as any[];
  };
  const standings = (data?: unknown) => {
    sock.handlers.getTournamentStandings(data);
    return emitted.filter(([ev]) => ev === 'tournamentStandings').pop()![1];
  };
  const qt = (over: Record<string, unknown>) => ({
    qualifierType: 'weekly', qualifierName: 'Weekly Qualifier', scheduledAt: new Date(Date.now() + H).toISOString(),
    startingStack: QUALIFIER_BASE_STACK, maxPlayers: 999, players: [], status: 'registering', tournamentId: null,
    blindStructure: [], results: null, seatPackage: null, ...over,
  });
  const reg = (pid: string, master: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ playerId: pid, masterPlayerId: master, localUserId: Number(pid.replace(/\D/g, '')) || undefined, playerName: name, phone: '3035550000', socketId: `s-${pid}`, ...extra });
  /** A qualifier's tournament played to the end in TournamentManager (registrants in order; busts worst first). */
  const playQualifier = (players: Array<[string, string]>) => {
    const tid = custom(tm, 'Qualifier Tournament', 999);
    for (const [pid, nm] of players) tm.registerPlayer(tid, pid, nm, `s-${pid}`);
    tm.startTournament(tid);
    for (const [pid] of [...players].reverse().slice(0, -1)) tm.eliminatePlayer(tid, pid);
    return tid;
  };
  return { tm, qualifierTournaments, m, stubbed, rest, socketList, standings, qt, reg, playQualifier, emitted };
}

describe('index.ts (REAL) — the qualifier lobby list: registrantNames + the results pointer', () => {
  it('socket list: public names in registration order, a re-entered player once, a phone-like name "Player"; REST stays name-free; nothing stubbed', async () => {
    const w = qualWorld();
    w.qualifierTournaments.set('W1', w.qt({
      players: [
        w.reg('user-101', 'm-alice', 'Alice', { reEntries: 1 }),
        w.reg('user-102', 'm-bob', '3035551234'),
        w.reg('user-103', 'm-cara', 'Cara D.'),
      ],
    }));
    const [item0] = await w.socketList();
    expect(item0).toMatchObject({ qualifierId: 'W1', players: 3, registrantNames: ['Alice', 'Player', 'Cara D.'], resultsTournamentId: null, resultsQualifierId: null });
    const json = JSON.stringify(item0);
    for (const leak of ['user-101', 'm-alice', 'm-bob', '3035551234', '3035550000', 's-user-101']) expect(json).not.toContain(leak);
    // The anonymous REST list / item: the pointer, never names.
    const restItem = w.rest('/api/qualifier-tournaments').tournaments[0];
    expect(restItem).toMatchObject({ qualifierId: 'W1', resultsTournamentId: null, resultsQualifierId: null });
    expect(restItem).not.toHaveProperty('registrantNames');
    const restOne = w.rest('/api/qualifier-tournaments/:qualifierId', { qualifierId: 'W1' }).tournament;
    expect(restOne).toMatchObject({ qualifierId: 'W1', resultsTournamentId: null });
    expect(restOne).not.toHaveProperty('registrantNames');
    expect(JSON.stringify(w.rest('/api/qualifier-tournaments'))).not.toMatch(/Alice|Cara/);
    // The default call (no opts) is name-free too (the REST route's).
    expect(w.m.qualifierList(null)[0]).not.toHaveProperty('registrantNames');
    expect([...w.stubbed]).toEqual([]);
  });

  it('each ACCOUNT once even if the registry ever held it twice; a cancelled event lists nobody (all released)', async () => {
    const w = qualWorld();
    w.qualifierTournaments.set('W1', w.qt({ players: [w.reg('user-101', 'm-alice', 'Alice'), w.reg('user-901', 'm-alice', 'Alice2'), w.reg('user-102', 'm-bob', 'Bob')] }));
    w.qualifierTournaments.set('W0', w.qt({ status: 'finished', cancelled: true, finishedAt: Date.now(), scheduledAt: new Date(Date.now() - H).toISOString(), players: [w.reg('user-103', 'm-cara', 'Cara')] }));
    const list = await w.socketList();
    expect(list.find((q) => q.qualifierId === 'W1').registrantNames).toEqual(['Alice', 'Bob']);
    expect(list.find((q) => q.qualifierId === 'W0')).toMatchObject({ registrantNames: [], resultsTournamentId: null, resultsQualifierId: null });
  });

  it(`payload bound: a ~400-entrant weekly lists the first ${REGISTRANT_NAMES_MAX} names; players stays 400`, async () => {
    const w = qualWorld();
    w.qualifierTournaments.set('W1', w.qt({ players: Array.from({ length: 400 }, (_, i) => w.reg(`user-${i + 1}`, `m-${i + 1}`, `Player${i + 1}`)) }));
    const [item0] = await w.socketList();
    expect(item0.players).toBe(400);
    expect(item0.registrantNames).toHaveLength(REGISTRANT_NAMES_MAX);
  });

  it('running: its own tournament; last night\'s finished league night still opens from tonight\'s card after its record is dropped; asked by that id the socket answers public, finished standings', async () => {
    const w = qualWorld();
    const runTid = w.playQualifier([['user-1', 'Ann'], ['user-2', 'Bob']]);   // (only to have a second event of another type)
    const lastNight = w.playQualifier([['user-11', 'Wanda'], ['user-12', '3035551234'], ['user-13', 'Redbeard']]);
    const now = Date.now();
    w.qualifierTournaments.set('L0', w.qt({ qualifierType: 'online_league', qualifierName: 'Online League', status: 'finished', tournamentId: lastNight, finishedAt: now, scheduledAt: new Date(now - 5 * H).toISOString(),
      players: [w.reg('user-11', 'm-11', 'Wanda'), w.reg('user-12', 'm-12', '3035551234'), w.reg('user-13', 'm-13', 'Redbeard')] }));
    w.qualifierTournaments.set('L1', w.qt({ qualifierType: 'online_league', qualifierName: 'Online League', status: 'registering', scheduledAt: new Date(now + 3 * H).toISOString(), players: [w.reg('user-11', 'm-11', 'Wanda')] }));
    w.qualifierTournaments.set('W0', w.qt({ status: 'finished', tournamentId: runTid, finishedAt: now + 1, scheduledAt: new Date(now - 6 * H).toISOString() }));
    // A running weekly: its own.
    const liveTid = custom(w.tm, 'Qualifier Tournament', 999);
    w.tm.registerPlayer(liveTid, 'user-21', 'Gus', 's21');
    w.tm.registerPlayer(liveTid, 'user-22', 'Hal', 's22');
    w.tm.startTournament(liveTid);
    w.qualifierTournaments.set('W2', w.qt({ status: 'running', tournamentId: liveTid, scheduledAt: new Date(now - H).toISOString() }));

    const byId = async () => Object.fromEntries((await w.socketList(['league'])).map((q) => [q.qualifierId, q]));
    let items = await byId();
    expect(items.L0).toMatchObject({ resultsTournamentId: lastNight, resultsQualifierId: 'L0' });
    expect(items.L1).toMatchObject({ resultsTournamentId: lastNight, resultsQualifierId: 'L0' });   // never the weekly's
    expect(items.W2).toMatchObject({ resultsTournamentId: liveTid, resultsQualifierId: 'W2' });
    expect(items.W0).toMatchObject({ resultsTournamentId: runTid, resultsQualifierId: 'W0' });

    // The engine drops the finished records an hour on; the kept rosters still answer.
    w.tm.pruneEndedTournaments(Date.now() + H + 1);
    expect(w.tm.getTournament(lastNight)).toBeUndefined();
    items = await byId();
    expect(items.L1.resultsTournamentId).toBe(lastNight);
    const st = w.standings({ tournamentId: items.L1.resultsTournamentId });
    expect(st).toMatchObject({ status: 'finished', name: 'Qualifier Tournament' });
    expect(st.players.map((p: any) => [p.playerName, p.finishPosition])).toEqual([['Wanda', 1], ['Player', 2], ['Redbeard', 3]]);
    for (const p of st.players) expect(p.playerId).toMatch(/^e[0-9a-f]{12}$/);
    expect(JSON.stringify(st)).not.toMatch(/user-1[123]|3035551234/);
    expect(st.eliminationOrder).toEqual([st.players[2].playerId, st.players[1].playerId]);

    // Past the keep window (CONTROL): no pointer, no standings.
    jest.setSystemTime(now + FINISHED_STANDINGS_KEEP_MS + 1);
    items = await byId();
    expect(items.L1).toMatchObject({ resultsTournamentId: null, resultsQualifierId: null });
    expect(w.standings({ tournamentId: lastNight })).toBeNull();
  });

  it('CONTROL — getTournamentStandings with NO id still answers a RUNNING tournament only (never a finished one)', () => {
    const w = qualWorld();
    const done = w.playQualifier([['user-1', 'Ann'], ['user-2', 'Bob']]);
    expect(w.tm.getTournamentStandings(done, null)!.status).toBe('finished');
    expect(w.standings({})).toBeNull();
    const live = custom(w.tm, 'Live One', 9);
    w.tm.registerPlayer(live, 'user-3', 'Cy', 's3');
    w.tm.registerPlayer(live, 'user-4', 'Dee', 's4');
    w.tm.startTournament(live);
    expect(w.standings({})).toMatchObject({ tournamentId: live, status: 'running' });
  });
});

describe('wiring: the socket list asks for names, REST does not; the update broadcast stays a count; health; manifest', () => {
  it('only the socket lobby list passes withNames; the REST list and the qualifierTournamentUpdate frame carry no names', () => {
    expect(handlerSrc('getQualifierTournaments', '\n  });\n')).toContain("qualifierList(viewerMasterId, Date.now(), { includeLeague, withNames: true })");
    expect(slice("app.get('/api/qualifier-tournaments', ", '\n});\n')).toContain('qualifierList(null, Date.now(), { includeLeague })');
    expect(fnSrc('function broadcastQualifierUpdate(')).not.toContain('registrantNames');
    expect(fnSrc('function qualifierList(')).toContain('...qualifierLobbyListFields(id, qt, opts.withNames === true, now),');
    // The standings handler still sends ONLY the public shape (names + opaque ids).
    expect(SRC).toContain("socket.emit('tournamentStandings', tid ? publicTournamentStandings(");
  });

  it('health r2Play.lobbyLists is a fail-safe healthSection over the kept rosters', () => {
    expect(SRC).toContain("lobbyLists: healthSection('r2Play.lobbyLists', () => ({ ...tournamentManager.finishedStandingsHealth() })),");
  });

  it('canonical-features.txt locks the lobby-list tokens', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8').split('\n').map((l) => l.trim());
    for (const tok of ['registrantNames:', 'resultsTournamentId:', 'resultsQualifierId', 'function registrantNamesOf(', 'function qualifierResultsPointer(', 'finished_standings_note_failed', 'function qualifierLobbyListFields(', 'r2Play.lobbyLists']) {
      expect({ tok, listed: manifest.includes(tok) }).toEqual({ tok, listed: true });
    }
  });
});

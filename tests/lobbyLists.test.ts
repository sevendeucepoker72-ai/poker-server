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
  FINISHED_STANDINGS_MAX, qualifierResultsPointer, serializeFinishedStandings, parseFinishedStandings, keptCardOf,
  keptFinishedItemOf, rosterHasAccount, FINISHED_STANDINGS_FORMAT, KEPT_CARD_FIELDS, FinishedStandingsPersistence,
} from '../src/game/lobbyLists';
import { publicNameOf } from '../src/social/publicIdentity';
import {
  qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
  QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifierEventConfig, seatsWonAt, leagueFinishFrameFields,
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

  it('2026-11-26 (finding 1) keptLatest: used when the registry has no finished event of the type (after a restart) or only an older one; CONTROL: absent / throwing / unreadable = the rule above', () => {
    const tonight = ev({ status: 'registering' });
    const keptL = (type: string) => (type === 'online_league' ? { tournamentId: 'T-L1', qualifierId: 'L1', finishedAt: 200 } : null);
    // A restart: the registry holds only tonight's card — the kept roster answers.
    expect(qualifierResultsPointer('L9', tonight, [['L9', tonight]], has, keptL)).toEqual({ resultsTournamentId: 'T-L1', resultsQualifierId: 'L1' });
    // Never another type's.
    expect(qualifierResultsPointer('W1', ev({ qualifierType: 'weekly' }), [], has, keptL)).toEqual({ resultsTournamentId: null, resultsQualifierId: null });
    // The registry's own finished event is newer → it wins; an older one → the kept roster wins.
    expect(qualifierResultsPointer('L9', tonight, [['L0', ev({ status: 'finished', tournamentId: 'T-L0', finishedAt: 300 })]], has, keptL))
      .toEqual({ resultsTournamentId: 'T-L0', resultsQualifierId: 'L0' });
    expect(qualifierResultsPointer('L9', tonight, [['L0', ev({ status: 'finished', tournamentId: 'T-L0', finishedAt: 100 })]], has, keptL))
      .toEqual({ resultsTournamentId: 'T-L1', resultsQualifierId: 'L1' });
    // CONTROL: no keptLatest, a throwing one, or one whose roster is no longer readable.
    const none = { resultsTournamentId: null, resultsQualifierId: null };
    expect(qualifierResultsPointer('L9', tonight, [], has)).toEqual(none);
    expect(qualifierResultsPointer('L9', tonight, [], has, () => { throw new Error('boom'); })).toEqual(none);
    expect(qualifierResultsPointer('L9', tonight, [], has, () => ({ tournamentId: 'T-GONE', qualifierId: 'L3', finishedAt: 999 }))).toEqual(none);
    // Running / finished cards still answer their OWN event only.
    expect(qualifierResultsPointer('Q', ev({ status: 'running', tournamentId: 'T-RUN' }), [], has, keptL)).toEqual({ resultsTournamentId: 'T-RUN', resultsQualifierId: 'Q' });
    expect(qualifierResultsPointer('Lx', ev({ status: 'finished', cancelled: true, tournamentId: 'T-RUN' }), [], has, keptL)).toEqual(none);
  });
});

describe('2026-11-26 review fix (finding 1) — kept rosters survive a restart: persisted, read back, a qualifier\'s tagged', () => {
  /** A fake persistence (what index.ts does with Redis): key -> text, + the TTLs asked for. */
  function fakeRedis(opts: { answer?: unknown } = {}) {
    const keys = new Map<string, string>();
    const ttls: Array<[string, number]> = [];
    const drops: string[] = [];
    const p: FinishedStandingsPersistence = {
      save: (r, ttlMs) => { keys.set(r.tournamentId, serializeFinishedStandings(r)); ttls.push([r.tournamentId, ttlMs]); return 'answer' in opts ? opts.answer : true; },
      drop: (id) => { keys.delete(id); drops.push(id); return true; },
    };
    return { p, keys, ttls, drops, read: () => [...keys.values()].map((s) => parseFinishedStandings(s)) };
  }

  it('note writes the roster with the REST of the keep window as its TTL; a qualifier tag writes it again; an eviction deletes it; CONTROL: no persistence = memory only', () => {
    const r = fakeRedis();
    const s = new FinishedStandingsStore(10 * H, 3);
    s.setPersistence(r.p);
    s.note(rec('t1', 'tournament:t1', 1000), 1000 + H);
    expect(r.ttls).toEqual([['t1', 9 * H]]);
    expect(parseFinishedStandings(r.keys.get('t1'))).toMatchObject({ tournamentId: 't1', cardKey: 'tournament:t1' });
    expect(s.tagQualifier('t1', { type: 'online_league', id: 'L0' }, 1000 + 2 * H)).toBe(true);
    expect(r.ttls[1]).toEqual(['t1', 8 * H]);
    expect(parseFinishedStandings(r.keys.get('t1'))!.qualifier).toEqual({ type: 'online_league', id: 'L0' });
    expect(s.tagQualifier('nope', { type: 'weekly', id: 'W' })).toBe(false);
    // The size bound (3): a 4th template roster pushes out the oldest non-latest — deleted there too.
    for (const [id, at] of [['a', 2000], ['b', 3000], ['c', 4000]] as const) s.note(rec(id, 'template:Sit & Go', at), 5000);
    expect(r.drops).toEqual(['a']);
    expect(r.keys.has('a')).toBe(false);
    expect(s.stats).toMatchObject({ persisted: 5, persistErrors: 0, evicted: 1 });
    // CONTROL: without a persistence nothing is written and nothing throws.
    const mem = new FinishedStandingsStore();
    mem.note(rec('m1', 'tournament:m1', Date.now()));
    expect(mem.stats).toMatchObject({ noted: 1, persisted: 0, persistErrors: 0 });
  });

  it('a persistence that throws or rejects never breaks a note (persistErrors counted); a save answering false (no Redis) is not counted as written', async () => {
    const thrower = new FinishedStandingsStore();
    thrower.setPersistence({ save: () => { throw new Error('redis down'); }, drop: () => { throw new Error('x'); } });
    expect(() => thrower.note(rec('t1', 'tournament:t1', Date.now()))).not.toThrow();
    expect(thrower.get('t1')).not.toBeNull();
    const rejecter = new FinishedStandingsStore();
    rejecter.setPersistence({ save: () => Promise.reject(new Error('READONLY')), drop: () => Promise.resolve(true) });
    rejecter.note(rec('t2', 'tournament:t2', Date.now()));
    const offline = new FinishedStandingsStore();
    offline.setPersistence({ save: () => Promise.resolve(false), drop: () => Promise.resolve(false) });
    offline.note(rec('t3', 'tournament:t3', Date.now()));
    await Promise.resolve(); await Promise.resolve();
    expect(thrower.stats).toMatchObject({ noted: 1, persisted: 0, persistErrors: 1 });
    expect(rejecter.stats).toMatchObject({ noted: 1, persisted: 0, persistErrors: 1 });
    expect(offline.stats).toMatchObject({ noted: 1, persisted: 0, persistErrors: 0 });
  });

  it('serialize -> parse round-trips a roster; CONTROL: malformed / another format / no id / no finish time → null; the card and the player fields are re-whitelisted', () => {
    const full: FinishedStandingsRecord = {
      ...rec('t1', 'tournament:t1', 1234), unlisted: true, accounts: [{ userId: 7 }, { masterUserId: 'm-8' }],
      card: { buyIn: 100, payouts: [{ place: 1, amount: 900 }], isFreeroll: false }, qualifier: { type: 'weekly', id: 'W1' },
    };
    expect(parseFinishedStandings(serializeFinishedStandings(full))).toEqual(full);
    expect(JSON.parse(serializeFinishedStandings(full)).v).toBe(FINISHED_STANDINGS_FORMAT);
    // At rest: public names only (a phone typed as a name is "Player"; extra player fields never written).
    const phoney = { ...full, players: [{ playerId: 'a', playerName: '3035551234', chipCount: 0, finishPosition: 1, phone: '3035551234' } as any] };
    expect(serializeFinishedStandings(phoney)).not.toContain('3035551234');
    expect(parseFinishedStandings(serializeFinishedStandings(phoney))!.players).toEqual([{ playerId: 'a', playerName: 'Player', chipCount: 0, finishPosition: 1 }]);
    for (const bad of [
      'not json', '', null, 42, '[]',
      JSON.stringify({ ...full, v: FINISHED_STANDINGS_FORMAT + 1 }),
      JSON.stringify({ ...full }),                                         // no version
      JSON.stringify({ v: 1, ...full, tournamentId: '' }),
      JSON.stringify({ v: 1, ...full, finishedAt: 'yesterday' }),
      JSON.stringify({ v: 1, ...full, players: 'everyone' }),
      JSON.stringify({ v: 1, ...full, players: [{ playerName: 'no id' }] }),
    ]) expect(parseFinishedStandings(bad)).toBeNull();
    const dirty = parseFinishedStandings(JSON.stringify({
      v: 1, ...full,
      players: [{ playerId: 'a', playerName: 'Ann', chipCount: 0, finishPosition: 1, phone: '3035551234', userId: 7 }, { playerId: 'b', playerName: 'Bob', chipCount: 'x', finishPosition: 0 }],
      card: { buyIn: 100, name: '<b>x</b>', registered: true, entryId: 'E1', registrantNames: ['Ann'], payouts: [{ place: 1, amount: 900, who: 'Ann' }] },
      accounts: [{ userId: 7.5 }, { masterUserId: 9 }, 'm-1', { userId: 3, masterUserId: 'm-3', phone: '3035551234' }],
    }))!;
    expect(dirty.players).toEqual([
      { playerId: 'a', playerName: 'Ann', chipCount: 0, finishPosition: 1 },
      { playerId: 'b', playerName: 'Bob', chipCount: 0, finishPosition: null },
    ]);
    expect(dirty.card).toEqual({ buyIn: 100, payouts: [{ place: 1, amount: 900 }] });
    expect(dirty.accounts).toEqual([{ userId: 3, masterUserId: 'm-3' }]);
  });

  it('restore: the previous process\'s rosters come back inside the keep window only, never twice, never re-written; then the tag finds the newest of a type', () => {
    const r = fakeRedis();
    const before = new FinishedStandingsStore();
    before.setPersistence(r.p);
    const t0 = Date.now();
    before.note(rec('L-old', 'tournament:L-old', t0 - 30 * H));            // past the keep window (its key would have expired)
    before.note({ ...rec('L-0', 'tournament:L-0', t0 - 2 * H), qualifier: { type: 'online_league', id: 'Q-L0' } });
    before.note({ ...rec('L-1', 'tournament:L-1', t0 - H), qualifier: { type: 'online_league', id: 'Q-L1' } });
    before.note({ ...rec('W-0', 'tournament:W-0', t0 - 3 * H), qualifier: { type: 'weekly', id: 'Q-W0' } });
    const writes = r.ttls.length;
    // "The restart": a NEW store, read back from the persisted texts.
    const after = new FinishedStandingsStore();
    after.setPersistence(r.p);
    expect(after.latestQualifier('online_league')).toBeNull();               // CONTROL: before the restore, nothing
    const texts = [...r.keys.values()];
    expect(after.restore([...texts.map((x) => parseFinishedStandings(x)), parseFinishedStandings(serializeFinishedStandings(rec('L-old', 'tournament:L-old', t0 - 30 * H))), null], t0)).toBe(3);
    expect(after.restore(texts.map((x) => parseFinishedStandings(x)), t0)).toBe(0);   // never twice
    expect(r.ttls.length).toBe(writes);                                       // never re-written
    expect(after.stats).toMatchObject({ restored: 3, noted: 0 });
    expect(after.get('L-old')).toBeNull();
    expect(after.get('L-1')!.players.map((p) => [p.playerName, p.finishPosition])).toEqual([['Ann', 1], ['Bob', 2]]);
    expect(after.latestQualifier('online_league')).toEqual({ tournamentId: 'L-1', qualifierId: 'Q-L1', finishedAt: t0 - H });
    expect(after.latestQualifier('weekly')).toEqual({ tournamentId: 'W-0', qualifierId: 'Q-W0', finishedAt: t0 - 3 * H });
    expect(after.latestQualifier('monthly')).toBeNull();
  });
});

describe('2026-11-26 review fix (finding 1) — through the REAL redisStore (fake client): written with a TTL, read back by a NEW TournamentManager', () => {
  /** A fake node-redis client: strings with EX, del, scanIterator (the calls redisStore makes). */
  function fakeClient() {
    const strings = new Map<string, string>();
    const ex = new Map<string, number>();
    const handlers: Record<string, (...a: any[]) => void> = {};
    const client: any = {
      on: (ev: string, fn: (...a: any[]) => void) => { handlers[ev] = fn; return client; },
      connect: async () => { if (handlers.ready) handlers.ready(); },
      set: async (k: string, v: string, o?: { EX?: number }) => { strings.set(k, v); if (o?.EX) ex.set(k, o.EX); return 'OK'; },
      get: async (k: string) => strings.get(k) ?? null,
      del: async (k: string) => { const had = strings.delete(k); ex.delete(k); return had ? 1 : 0; },
      scanIterator: async function* scan(opts: { MATCH: string }) {
        const pre = opts.MATCH.replace(/\*$/, '');
        for (const k of [...strings.keys()]) if (k.startsWith(pre)) yield k;
      },
    };
    return { client, strings, ex };
  }
  async function realRedisStore(connect = true) {
    const fake = fakeClient();
    let rs: any;
    jest.isolateModules(() => {
      jest.doMock('redis', () => ({ createClient: () => fake.client }));
      rs = require('../src/redisStore');
    });
    if (connect) {
      const prev = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://fake-for-test';
      const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
      try { expect(await rs.connectRedis()).toBe(true); } finally {
        quiet.mockRestore();
        if (prev === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prev;
      }
    }
    return { rs, fake };
  }

  it('a finish is written under poker:finishedStandings:<id> with the rest of the 25 h as EX; a new process reads it back and answers the same standings; CONTROL: Redis-less = false / [] (memory only, nothing thrown)', async () => {
    const { rs, fake } = await realRedisStore();
    const persistence: FinishedStandingsPersistence = {
      save: (r, ttlMs) => rs.saveFinishedStandings(r.tournamentId, serializeFinishedStandings(r), Math.ceil(ttlMs / 1000)),
      drop: (id) => rs.deleteFinishedStandings(id),
    };
    const before = new TournamentManager();
    before.setFinishedStandingsPersistence(persistence);
    const tid = custom(before, 'Redis Cup');
    for (const [pid, nm] of [['user-1', 'Ann'], ['user-2', 'Bob']]) before.registerPlayer(tid, pid, nm, `s-${pid}`, Number(pid.slice(5)));
    before.startTournament(tid);
    before.eliminatePlayer(tid, 'user-2');
    await Promise.resolve(); await Promise.resolve();
    const key = `poker:finishedStandings:${tid}`;
    expect(fake.strings.has(key)).toBe(true);
    expect(fake.ex.get(key)).toBe(Math.ceil(FINISHED_STANDINGS_KEEP_MS / 1000));
    expect(before.finishedStandingsHealth()).toMatchObject({ persisted: 1, persistErrors: 0 });
    // The new process: scan -> parse -> restore (index.ts restoreFinishedStandingsFromRedis).
    const after = new TournamentManager();
    const raws: string[] = await rs.scanFinishedStandings();
    expect(raws).toHaveLength(1);
    expect(after.restoreFinishedStandings(raws.map((x) => parseFinishedStandings(x)))).toBe(1);
    expect(after.getTournamentStandings(tid, null)).toEqual(before.getTournamentStandings(tid, null));
    expect(await rs.deleteFinishedStandings(tid)).toBe(true);
    expect(fake.strings.has(key)).toBe(false);
    // CONTROL: no REDIS_URL — every call is a quiet no-op.
    const off = await realRedisStore(false);
    expect(await off.rs.saveFinishedStandings('x', '{}', 60)).toBe(false);
    expect(await off.rs.deleteFinishedStandings('x')).toBe(false);
    expect(await off.rs.scanFinishedStandings()).toEqual([]);
    expect(off.fake.strings.size).toBe(0);
  });
});

describe('2026-11-26 review fix (finding 3) — the kept finished item: the card, public names, its own results; account keys never leave', () => {
  it('keptFinishedItemOf: status finished, resultsTournamentId = itself, resultsKept, public names, the whitelisted card; never an account key / entrant id; rosterHasAccount = the entryOfAccount rule', () => {
    const r: FinishedStandingsRecord = {
      ...rec('t-club', 'tournament:t-club', 5000), unlisted: true,
      players: [
        { playerId: 'user-101', playerName: 'Ann', chipCount: 0, finishPosition: 2 },
        { playerId: 'user-102', playerName: '3035551234', chipCount: 0, finishPosition: 1 },
      ],
      accounts: [{ userId: 101 }, { userId: 102, masterUserId: 'm-102' }],
      card: { buyIn: 500, fundedPool: 1000, isFreeroll: false, maxPlayers: 9, payouts: [{ place: 1, amount: 625 }], blindLevelCount: 12 },
    };
    const it0 = keptFinishedItemOf(r, true);
    expect(it0).toMatchObject({
      tournamentId: 't-club', name: 't-club', status: 'finished', registered: true, entryId: null, registeredPlayers: 2,
      registrantNames: ['Ann', 'Player'], resultsTournamentId: 't-club', resultsKept: true, finishedAt: 5000,
      buyIn: 500, fundedPool: 1000, isFreeroll: false, maxPlayers: 9, payouts: [{ place: 1, amount: 625 }], currentBlinds: null, paused: false,
    });
    const json = JSON.stringify(it0);
    for (const leak of ['user-101', 'user-102', 'm-102', '3035551234', '"accounts"', '"unlisted"', '"players"']) expect(json).not.toContain(leak);
    expect(keptFinishedItemOf(r, false).registered).toBe(false);
    expect(rosterHasAccount(r, { userId: 101 })).toBe(true);
    expect(rosterHasAccount(r, { masterUserId: 'm-102' })).toBe(true);
    expect(rosterHasAccount(r, { userId: 999, masterUserId: 'm-999' })).toBe(false);
    expect(rosterHasAccount(r, null)).toBe(false);
    expect(rosterHasAccount({ ...r, accounts: undefined }, { userId: 101 })).toBe(false);
    // keptCardOf: only the whitelisted viewer-independent fields.
    expect(Object.keys(keptCardOf({ registered: true, entryId: 'E', registrantNames: ['A'], name: 'x', buyIn: 1, minPlayers: 2 })).sort()).toEqual(['buyIn', 'minPlayers']);
    for (const k of KEPT_CARD_FIELDS) expect(['registered', 'entryId', 'registrantNames', 'tournamentId', 'name']).not.toContain(k);
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
    // 2026-11-26 review fix (finding 3) — the card STAYS listed from the kept roster
    // (it used to leave the list here, an hour after the finish).
    expect(item(tm, tid)).toMatchObject({ status: 'finished', resultsKept: true, resultsTournamentId: tid });
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
    // 2026-11-26 review fix (finding 2) — the CLIENT CONTRACT (poker-3d
    // src/utils/tournamentLists.js tournamentResultsTournamentId +
    // resultsButtonLabel): the finished card is GONE from the list (no kept item for
    // a template roster), so the registering card's `resultsTournamentId` — a string
    // that is NOT its own tournamentId — is the only way to the results ("Last
    // results"). A rename of this field breaks that button: keep the name.
    expect(item(tm, tid)).toBeUndefined();
    expect(typeof item(tm, next).resultsTournamentId).toBe('string');
    expect(item(tm, next).resultsTournamentId).not.toBe(item(tm, next).tournamentId);
    expect((tm.getTournamentList() as any[]).filter((x) => x.resultsKept)).toEqual([]);
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

describe('2026-11-26 review fix (finding 3) — a finished custom / club event stays LISTED for the keep window (>= 24 h), not 1 h', () => {
  /** Plays a 3-entrant event to the end: 103 busts 3rd, 102 2nd, 101 wins. */
  function play(tm: TournamentManager, tid: string, masters: Array<string | undefined> = []) {
    const field: Array<[string, string, number]> = [['user-101', 'Ann', 101], ['user-102', 'Bob', 102], ['user-103', '3035551234', 103]];
    field.forEach(([pid, nm, uid], i) => expect(tm.registerPlayer(tid, pid, nm, `s-${pid}`, masters[i] ? undefined : uid, masters[i]).success).toBe(true));
    tm.startTournament(tid);
    tm.eliminatePlayer(tid, 'user-103');
    tm.eliminatePlayer(tid, 'user-102');
    expect(tm.getTournament(tid)!.status).toBe('finished');
  }
  const itemsOf = (tm: TournamentManager, tid: string, viewer: any = null) => (tm.getTournamentList(viewer) as any[]).filter((x) => x.tournamentId === tid);

  it('custom: one live item, then (record dropped at 1 h) ONE kept finished item with the same card, public names and its own results — 24 h on still listed; CONTROL: past the keep window gone', () => {
    const tm = new TournamentManager();
    const t0 = Date.now();
    const tid = custom(tm, 'Friday Cup', 9, { prizePool: 900 });
    play(tm, tid);
    const live = itemsOf(tm, tid);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'finished', resultsTournamentId: tid });
    expect(live[0]).not.toHaveProperty('resultsKept');
    expect(tm.pruneEndedTournaments(t0 + H + 1)).toEqual([tid]);
    const kept = itemsOf(tm, tid);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      status: 'finished', resultsKept: true, resultsTournamentId: tid, name: 'Friday Cup', registeredPlayers: 3,
      registrantNames: ['Ann', 'Bob', 'Player'], buyIn: live[0].buyIn, prizePool: 900, fundedPool: live[0].fundedPool,
      isFreeroll: true, maxPlayers: 9, payouts: live[0].payouts, blindStructure: live[0].blindStructure, registered: false, entryId: null,
    });
    expect(itemsOf(tm, tid, { userId: 101 })[0].registered).toBe(true);
    expect(JSON.stringify(kept[0])).not.toMatch(/user-10|3035551234|"accounts"/);
    expect(tm.getTournamentStandings(kept[0].resultsTournamentId, null)).toMatchObject({ status: 'finished', tournamentId: tid });
    jest.setSystemTime(t0 + 24 * H);
    expect(itemsOf(tm, tid)).toHaveLength(1);
    jest.setSystemTime(t0 + FINISHED_STANDINGS_KEEP_MS + 1);
    expect(itemsOf(tm, tid)).toEqual([]);                    // CONTROL: the keep window ended
  });

  it('a CLUB (unlisted) finished event: the kept item reaches ONLY its own entrants (local id or master id), never anyone else — names included', () => {
    const tm = new TournamentManager();
    const tid = custom(tm, '[Aces] Club Night', 9, { unlisted: true });
    play(tm, tid, [undefined, undefined, 'm-103']);          // the 3rd entrant by master id only
    tm.pruneEndedTournaments(Date.now() + H + 1);
    expect(tm.getTournament(tid)).toBeUndefined();
    expect(itemsOf(tm, tid, null)).toEqual([]);
    expect(itemsOf(tm, tid, { userId: 999, masterUserId: 'm-999' })).toEqual([]);
    expect(JSON.stringify(tm.getTournamentList({ userId: 999 }))).not.toMatch(/Club Night|"Ann"|"Bob"/);
    expect(itemsOf(tm, tid, { userId: 101 })[0]).toMatchObject({ registered: true, resultsKept: true, registrantNames: ['Ann', 'Bob', 'Player'] });
    expect(itemsOf(tm, tid, { masterUserId: 'm-103' })[0]).toMatchObject({ registered: true, resultsKept: true });
  });

  it('…and after a RESTART: the persisted roster brings the club item back for its own entrants only (the account keys travel server-side, never in an item)', () => {
    const redis = new Map<string, string>();
    const before = new TournamentManager();
    before.setFinishedStandingsPersistence({ save: (r) => { redis.set(r.tournamentId, serializeFinishedStandings(r)); return true; }, drop: (id) => redis.delete(id) });
    const tid = custom(before, '[Aces] Club Night', 9, { unlisted: true });
    play(before, tid, [undefined, undefined, 'm-103']);
    expect(redis.has(tid)).toBe(true);
    const after = new TournamentManager();                     // the new process
    expect(itemsOf(after, tid, { userId: 101 })).toEqual([]); // CONTROL: nothing before the restore
    expect(after.restoreFinishedStandings([...redis.values()].map((x) => parseFinishedStandings(x)))).toBe(1);
    expect(itemsOf(after, tid, null)).toEqual([]);
    expect(itemsOf(after, tid, { userId: 102 })[0]).toMatchObject({ status: 'finished', resultsKept: true, registered: true, name: '[Aces] Club Night' });
    expect(itemsOf(after, tid, { masterUserId: 'm-103' })).toHaveLength(1);
    // The same standings, names as players see them (Redis holds public names only: the phone-like one is "Player").
    const live = before.getTournamentStandings(tid, null)!;
    expect(after.getTournamentStandings(tid, null)).toEqual({ ...live, players: live.players.map((p) => ({ ...p, playerName: publicNameOf(p.playerName) })) });
    expect(JSON.stringify([...redis.values()])).not.toContain('3035551234');
    expect(placesOf(after.getTournamentStandings(tid, null))).toEqual({ 'user-101': 1, 'user-102': 2, 'user-103': 3 });
    expect(after.finishedStandingsHealth()).toMatchObject({ restored: 1, kept: 1 });
  });

  it('CONTROL: a QUALIFIER\'s roster (tagged by markQualifierFinished) is NOT a tournament-lobby item (the qualifier lobby is its home); untagged, the same roster would be', () => {
    const tm = new TournamentManager();
    const q = custom(tm, 'Online League', 999);
    const c = custom(tm, 'Plain Cup', 9);
    play(tm, q);
    for (const [pid, nm] of [['x1', 'Xi'], ['x2', 'Yu']]) tm.registerPlayer(c, pid, nm, `s-${pid}`);
    tm.startTournament(c);
    tm.eliminatePlayer(c, 'x2');
    expect(tm.tagFinishedStandingsQualifier(q, { type: 'online_league', id: 'L0' })).toBe(true);
    tm.pruneEndedTournaments(Date.now() + H + 1);
    expect(itemsOf(tm, q)).toEqual([]);
    expect(itemsOf(tm, c)).toHaveLength(1);
    expect(tm.getTournamentStandings(q, null)).toMatchObject({ status: 'finished' });   // still openable by id (the qualifier card's pointer)
    expect(tm.latestQualifierResults('online_league')).toMatchObject({ tournamentId: q, qualifierId: 'L0' });
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

  it('2026-11-26 (finding 1) — a RESTART: last night\'s league results (tagged by the REAL markQualifierFinished, persisted) still open from tonight\'s card and by id; CONTROL: without the read-back nothing (the bug)', async () => {
    // The OLD process: the night is played and finished through the REAL markQualifierFinished.
    const redis = new Map<string, string>();
    const a = qualWorld();
    a.tm.setFinishedStandingsPersistence({ save: (r) => { redis.set(r.tournamentId, serializeFinishedStandings(r)); return true; }, drop: (id) => redis.delete(id) });
    const lastNight = a.playQualifier([['user-11', 'Wanda'], ['user-12', '3035551234'], ['user-13', 'Redbeard']]);
    const now = Date.now();
    a.qualifierTournaments.set('L0', a.qt({ qualifierType: 'online_league', qualifierName: 'Online League', kind: 'league', status: 'running', tournamentId: lastNight,
      scheduledAt: new Date(now - 4 * H).toISOString(), players: [a.reg('user-11', 'm-11', 'Wanda'), a.reg('user-12', 'm-12', '3035551234'), a.reg('user-13', 'm-13', 'Redbeard')] }));
    const markScope: Record<string, unknown> = {
      qualifierTournaments: a.qualifierTournaments, tournamentManager: a.tm, seatsForTopWith, seatsWonAt, publicNameOf, leagueFinishFrameFields,
      onlineLeagueStats: { finished: 0 }, socketsOfMaster: () => [], io: { emit() {} },
    };
    const marked = load(fnSrc('function markQualifierFinished('), markScope, '{ markQualifierFinished }');
    marked.exports.markQualifierFinished(lastNight, { results: [
      { playerId: 'user-11', playerName: 'Wanda', position: 1 }, { playerId: 'user-12', playerName: '3035551234', position: 2 }, { playerId: 'user-13', playerName: 'Redbeard', position: 3 },
    ] });
    expect([...marked.stubbed]).toEqual([]);
    expect(a.qualifierTournaments.get('L0')).toMatchObject({ status: 'finished' });
    expect(parseFinishedStandings(redis.get(lastNight))!.qualifier).toEqual({ type: 'online_league', id: 'L0' });   // re-written WITH the mark
    const before = a.standings({ tournamentId: lastNight });
    expect(before).toMatchObject({ status: 'finished' });

    // The NEW process: its registry holds only tonight's card (the sync never re-opens a night past 7:00 PM).
    const b = qualWorld();
    b.qualifierTournaments.set('L1', b.qt({ qualifierType: 'online_league', qualifierName: 'Online League', kind: 'league', status: 'registering', scheduledAt: new Date(now + 20 * H).toISOString() }));
    let [l1] = await b.socketList(['league']);
    expect(l1).toMatchObject({ qualifierId: 'L1', resultsTournamentId: null, resultsQualifierId: null });   // CONTROL: the reported bug
    expect(b.standings({ tournamentId: lastNight })).toBeNull();
    // The boot read-back (index.ts restoreFinishedStandingsFromRedis: scan -> parse -> restore).
    expect(b.tm.restoreFinishedStandings([...redis.values()].map((x) => parseFinishedStandings(x)))).toBe(1);
    [l1] = await b.socketList(['league']);
    expect(l1).toMatchObject({ qualifierId: 'L1', resultsTournamentId: lastNight, resultsQualifierId: 'L0' });
    expect(b.standings({ tournamentId: lastNight })).toEqual(before);
    expect(b.rest('/api/qualifier-tournaments', {}, { kinds: 'league' }).tournaments[0]).toMatchObject({ qualifierId: 'L1', resultsTournamentId: lastNight, resultsQualifierId: 'L0' });
    // Its home is the qualifier lobby: the tournament lobby does not list it.
    expect((b.tm.getTournamentList() as any[]).some((x) => x.tournamentId === lastNight)).toBe(false);
    // 25 h on, gone (CONTROL: bounded like everything kept).
    jest.setSystemTime(now + FINISHED_STANDINGS_KEEP_MS + 1);
    [l1] = await b.socketList(['league']);
    expect(l1).toMatchObject({ resultsTournamentId: null, resultsQualifierId: null });
    expect([...b.stubbed]).toEqual([]);
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

  it('2026-11-26 (finding 1) — boot: the kept rosters are written to Redis from the first finish and read back in the Redis rehydrate block; the qualifier finish tags its roster', () => {
    expect(SRC).toContain('tournamentManager.setFinishedStandingsPersistence(finishedStandingsRedisPersistence);');
    expect(SRC.indexOf('tournamentManager.setFinishedStandingsPersistence(')).toBeLessThan(SRC.indexOf("io.on('connection'"));
    const persistence = slice('const finishedStandingsRedisPersistence: FinishedStandingsPersistence = {', '\n};\n');
    expect(persistence).toContain('saveFinishedStandings(rec.tournamentId, serializeFinishedStandings(rec), Math.ceil(ttlMs / 1000))');
    expect(persistence).toContain('deleteFinishedStandings(tournamentId)');
    const restore = fnSrc('async function restoreFinishedStandingsFromRedis(');
    expect(restore).toContain('parseFinishedStandings(raw)');
    expect(restore).toContain('tournamentManager.restoreFinishedStandings(recs)');
    // Inside the `if (redisConnected)` block, after the fairness read-back.
    const boot = slice('const redisConnected = await connectHandStore();', '\n});\n');
    expect(boot).toContain('await restoreFinishedStandingsFromRedis();');
    expect(boot.indexOf('await restoreFinishedStandingsFromRedis();')).toBeGreaterThan(boot.indexOf('scanFairnessBuffers()'));
    expect(fnSrc('function markQualifierFinished(')).toContain('tournamentManager.tagFinishedStandingsQualifier?.(tournamentId, { type: qt.qualifierType, id: qualId })');
    expect(fnSrc('function qualifierLobbyListFields(')).toContain('tournamentManager.latestQualifierResults?.(type, now)');
    // The Redis helpers: one key per roster, a TTL on every write.
    const redisSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'redisStore.ts'), 'utf8');
    expect(redisSrc).toContain("const FINISHED_STANDINGS_KEY_PREFIX = 'poker:finishedStandings:';");
    expect(redisSrc).toContain('await client.set(FINISHED_STANDINGS_KEY_PREFIX + tournamentId, json, { EX: ttl });');
  });

  it('canonical-features.txt locks the lobby-list tokens', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8').split('\n').map((l) => l.trim());
    for (const tok of ['registrantNames:', 'resultsTournamentId:', 'resultsQualifierId', 'function registrantNamesOf(', 'function qualifierResultsPointer(', 'finished_standings_note_failed', 'function qualifierLobbyListFields(', 'r2Play.lobbyLists',
      // 2026-11-26 review fixes (finding 1: restart; finding 3: finished custom / club events stay listed).
      'finished_standings_restored', 'poker:finishedStandings:', 'tagFinishedStandingsQualifier', 'resultsKept: true']) {
      expect({ tok, listed: manifest.includes(tok) }).toEqual({ tok, listed: true });
    }
  });
});

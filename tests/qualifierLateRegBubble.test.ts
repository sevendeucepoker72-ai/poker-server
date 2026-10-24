/**
 * 2026-10-24 (owner 2026-10-23: "Fix both") — online qualifier LATE ENTRY and
 * RE-ENTRY close at the SEAT BUBBLE (or at 2:00 PM MT, whichever comes first).
 *
 * The rule, on the REAL TournamentManager (no index.ts slicing):
 *  - the bubble = seatsForTop + 1 (index.ts resolves it per event from the live
 *    seat package: TournamentManager.lateEntryBubbleOf → {closeAtAlive, openUntil});
 *  - it is REACHED by an ELIMINATION that takes the alive count from above the
 *    bubble to the bubble or below while now <= openUntil (2:00 PM). One
 *    elimination removes one player, so a double bust that skips past the
 *    bubble passes through it on the first of the two;
 *  - a field that never went above the bubble stays open until 2:00 PM;
 *  - a no-show release / an undone late seat (removeLateEntrant) never counts;
 *  - once closed it never reopens: addLateEntrant / reinstateForReentry refuse
 *    at their top (no push, no place shift — places stay 1..N);
 *  - the state is set in the SAME synchronous call that lowers the alive count,
 *    and 'lateEntryClosedAtBubble' is emitted BEFORE 'playerEliminated'.
 *
 * Before (9c37499) none of it existed: a late entry while 10 or fewer were alive
 * pushed a busted player out of the seats (addLateEntrant shifts every busted
 * place down one).
 */
import { TournamentManager } from '../src/game/TournamentManager';
import {
  QUALIFIER_LATE_REG_CLOSED_BUBBLE_TEXT, qualifierLateRegClosedText,
} from '../src/game/qualifierSchedule';

const HOUR = 3600_000;

/** A running qualifier-shaped tournament of `n` entrants p0..p{n-1} (50,000 stacks), events recorded in order. */
function field(n: number, resolver?: ((tid: string) => any) | null) {
  const tm = new TournamentManager();
  if (resolver !== undefined) tm.lateEntryBubbleOf = resolver;
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 200, startInterval: 0,
    blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 720 }], startingChips: 50_000,
  } as any);
  for (let i = 0; i < n; i++) tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, undefined, `m-${i}`);
  expect(tm.startTournament(tid)).toBeTruthy();
  const events: Array<[string, any]> = [];
  tm.onEvent(tid, (ev, d) => { events.push([ev, d]); });
  const t = tm.getTournament(tid)!;
  const place = (id: string) => t.players.find((p) => p.playerId === id)!.finishPosition;
  const names = () => events.map(([ev]) => ev).filter((ev) => ev === 'lateEntryClosedAtBubble' || ev === 'playerEliminated');
  const closes = () => events.filter(([ev]) => ev === 'lateEntryClosedAtBubble').map(([, d]) => d);
  return { tm, tid, t, events, place, names, closes };
}
/** Sunday: the top 10 win seats → the bubble is 11; late entry open until an hour from now. */
const sunday = () => (_tid: string) => ({ closeAtAlive: 11, openUntil: Date.now() + HOUR });

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('LB1 — the bust that takes the field from 12 to 11 (top 10) closes late entry and re-entry, durably', () => {
  it('13 entrants: 12 alive → still open; 11 alive → closed {alive:11, closeAtAlive:11, playerId}; the close is emitted BEFORE playerEliminated; late entry / re-entry refused without touching places; never a second close', () => {
    const w = field(13, sunday());
    w.tm.eliminatePlayer(w.tid, 'p12');                                     // 12 alive
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.closes()).toEqual([]);
    w.events.length = 0;
    const before = Date.now();
    w.tm.eliminatePlayer(w.tid, 'p11');                                     // 11 alive: the bubble is reached
    expect(w.tm.getAliveCount(w.tid)).toBe(11);
    const rec = w.tm.lateEntryClosedAtBubble(w.tid);
    expect(rec).toEqual({ at: expect.any(Number), alive: 11, closeAtAlive: 11, playerId: 'p11' });
    expect(rec!.at).toBeGreaterThanOrEqual(before);
    expect(w.names()).toEqual(['lateEntryClosedAtBubble', 'playerEliminated']);   // the audit is written before the bust's own handling
    expect(w.closes()).toEqual([{ tournamentId: w.tid, alive: 11, closeAtAlive: 11, playerId: 'p11', at: rec!.at }]);

    // A late entry is refused: nobody added, no busted place moved (13th / 12th stay).
    const players = w.t.players.length;
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeNull();
    expect(w.t.players.length).toBe(players);
    expect([w.place('p12'), w.place('p11')]).toEqual([13, 12]);
    expect(w.t.entries).toBe(13);
    // The buster's own re-entry is refused: he stays out, in 12th.
    expect(w.tm.reinstateForReentry(w.tid, 'p11', 50_000)).toBe(false);
    expect(w.t.players.find((p) => p.playerId === 'p11')).toMatchObject({ eliminated: true, finishPosition: 12 });
    expect(w.tm.getAliveCount(w.tid)).toBe(11);
    // A further bust: no second close, the first record kept.
    w.tm.eliminatePlayer(w.tid, 'p10');
    expect(w.closes()).toHaveLength(1);
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toEqual(rec);
    expect(w.tm.lateEntryBubbleStats).toEqual({ closed: 1, resolverErrors: 0, lockRefusals: 2 });
  });

  it('CONTROL — with no resolver (every tournament that is not a qualifier) nothing ever closes: the late entry at 11 alive is added and shifts the busted places (the published place shift)', () => {
    const w = field(13, null);
    w.tm.eliminatePlayer(w.tid, 'p12');
    w.tm.eliminatePlayer(w.tid, 'p11');
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeTruthy();
    expect([w.place('p12'), w.place('p11')]).toEqual([14, 13]);
    expect(w.tm.reinstateForReentry(w.tid, 'p11', 50_000)).toBe(true);
    expect(w.tm.lateEntryBubbleStats).toEqual({ closed: 0, resolverErrors: 0, lockRefusals: 0 });
  });
});

describe('LB2 — two players out in one batch (12 → 10): the first elimination passes through the bubble and closes it', () => {
  it('disqualifyPlayers([a, b]) at 12 alive: closed at the first elimination (alive 11), final alive 10, exactly one close', () => {
    const w = field(13, sunday());
    w.tm.eliminatePlayer(w.tid, 'p12');
    w.tm.disqualifyPlayers(w.tid, ['p0', 'p1']);
    expect(w.tm.getAliveCount(w.tid)).toBe(10);
    expect(w.closes()).toEqual([expect.objectContaining({ alive: 11, closeAtAlive: 11, playerId: 'p0' })]);
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toMatchObject({ alive: 11, playerId: 'p0' });
  });

  it('two eliminations in one hand (the bust check, one by one): 12 → 11 closes, 11 → 10 does not close again', () => {
    const w = field(13, sunday());
    w.tm.eliminatePlayer(w.tid, 'p12');
    w.tm.eliminatePlayer(w.tid, 'p3');
    w.tm.eliminatePlayer(w.tid, 'p4');
    expect(w.closes()).toEqual([expect.objectContaining({ alive: 11, playerId: 'p3' })]);
  });
});

describe('LB3 — a field that never went above the bubble keeps late entry open until 2:00 PM', () => {
  it('8 entrants (top 10): busts down to 5 never close; late entries take the field to 12 (places shift as published); the next bust (12 → 11) closes', () => {
    const w = field(8, sunday());
    for (const id of ['p7', 'p6', 'p5']) w.tm.eliminatePlayer(w.tid, id);   // 5 alive
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect([w.place('p7'), w.place('p6'), w.place('p5')]).toEqual([8, 7, 6]);
    for (let i = 0; i < 7; i++) expect(w.tm.addLateEntrant(w.tid, `late-${i}`, `L${i}`, `sl${i}`, 50_000, { masterUserId: `m-l${i}` })).toBeTruthy();
    expect(w.tm.getAliveCount(w.tid)).toBe(12);
    expect([w.place('p7'), w.place('p6'), w.place('p5')]).toEqual([15, 14, 13]);   // each late entry moved every busted place down one
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    w.tm.eliminatePlayer(w.tid, 'late-0');                                   // 12 → 11
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toMatchObject({ alive: 11, closeAtAlive: 11, playerId: 'late-0' });
    expect(w.place('late-0')).toBe(12);
    expect(w.tm.addLateEntrant(w.tid, 'late-9', 'L9', 'sl9', 50_000, { masterUserId: 'm-l9' })).toBeNull();
    // Places are still a permutation once it is played out.
    for (const p of [...w.t.players]) if (!p.eliminated && p.playerId !== 'p0') w.tm.eliminatePlayer(w.tid, p.playerId);
    expect(w.t.status).toBe('finished');
    expect(w.t.players.map((p) => p.finishPosition).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});

describe('LB4 — only inside the late window; a broken resolver closes nothing and never breaks the elimination', () => {
  it('openUntil in the past (after 2:00 PM): the 12 → 11 bust closes nothing', () => {
    const w = field(13, () => ({ closeAtAlive: 11, openUntil: Date.now() - 1 }));
    w.tm.eliminatePlayer(w.tid, 'p12');
    w.tm.eliminatePlayer(w.tid, 'p11');
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.closes()).toEqual([]);
  });

  it('a THROWING resolver: nothing closes, resolverErrors 1 per elimination, and the elimination still sets the place and emits playerEliminated', () => {
    const w = field(13, () => { throw new Error('registry read failed'); });
    w.tm.eliminatePlayer(w.tid, 'p12');
    expect(w.place('p12')).toBe(13);
    expect(w.names()).toEqual(['playerEliminated']);
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.lateEntryBubbleStats.resolverErrors).toBe(1);
  });

  it('garbage answers (null, NaN openUntil, a bubble below 2, a fraction) close nothing', () => {
    for (const ans of [null, { closeAtAlive: 11, openUntil: NaN }, { closeAtAlive: 1, openUntil: Date.now() + HOUR }, { closeAtAlive: 11.5, openUntil: Date.now() + HOUR }]) {
      const w = field(13, () => ans);
      w.tm.eliminatePlayer(w.tid, 'p12');
      w.tm.eliminatePlayer(w.tid, 'p11');
      w.tm.eliminatePlayer(w.tid, 'p10');
      expect({ ans, closed: w.tm.lateEntryClosedAtBubble(w.tid) }).toEqual({ ans, closed: null });
    }
  });

  it('a listener that throws on the close cannot undo it: the lock holds and the elimination completes', () => {
    const w = field(13, sunday());
    const errs = jest.spyOn(console, 'error').mockImplementation(() => {});
    w.tm.onEvent(w.tid, (ev) => { if (ev === 'lateEntryClosedAtBubble') throw new Error('listener boom'); });
    w.tm.eliminatePlayer(w.tid, 'p12');
    expect(() => w.tm.eliminatePlayer(w.tid, 'p11')).not.toThrow();
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toMatchObject({ alive: 11 });
    expect(w.names()).toEqual(['playerEliminated', 'lateEntryClosedAtBubble', 'playerEliminated']);
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, {})).toBeNull();
    expect(errs.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('"event":"late_entry_closed_listener_failed"')]);
    errs.mockRestore();
  });
});

describe('LB5 — what never counts as reaching the bubble', () => {
  it('removeLateEntrant (an undone seat / the no-show release) taking the field from 12 to 11 closes nothing; the next ELIMINATION from 12 does', () => {
    const w = field(11, sunday());
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeTruthy();   // 12
    expect(w.tm.removeLateEntrant(w.tid, 'late-1')).toBe(true);                                                  // 11, not an elimination
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.addLateEntrant(w.tid, 'late-2', 'Late2', 'sl2', 50_000, { masterUserId: 'm-late2' })).toBeTruthy();   // 12 again
    w.tm.eliminatePlayer(w.tid, 'p0');
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toMatchObject({ alive: 11, playerId: 'p0' });
  });

  it('a 30-player start whose 20 no-shows are released before the deal (10 left) never played above the bubble: still open', () => {
    const w = field(30, sunday());
    for (let i = 10; i < 30; i++) w.tm.removeLateEntrant(w.tid, `p${i}`);
    expect(w.tm.getAliveCount(w.tid)).toBe(10);
    w.tm.eliminatePlayer(w.tid, 'p9');
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeTruthy();
  });

  it('a Sit & Go / any tournament with no resolver answer (null) never closes', () => {
    const w = field(13, () => null);
    for (const id of ['p12', 'p11', 'p10']) w.tm.eliminatePlayer(w.tid, id);
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.lateEntryClosedAtBubble('no-such-tournament')).toBeNull();
  });
});

describe('LB6 — the player-facing sentences (plain ASCII, short)', () => {
  it('the refusal and the room notice', () => {
    expect(QUALIFIER_LATE_REG_CLOSED_BUBBLE_TEXT).toBe('Late entry and re-entry are closed: the seat bubble was reached.');
    expect(qualifierLateRegClosedText(11, 10)).toBe('Late entry and re-entry are now closed: 11 players are left and the top 10 win seats.');
    for (const s of [QUALIFIER_LATE_REG_CLOSED_BUBBLE_TEXT, qualifierLateRegClosedText(11, 10)]) {
      expect(s.length).toBeLessThanOrEqual(200);
      expect(/^[\x20-\x7e]+$/.test(s)).toBe(true);
    }
  });
});

describe('LB14 (review fix-up) — the bubble is reached by any elimination at or below it once the field PLAYED above it, not only by the one crossing elimination', () => {
  it('the resolver has no answer at the 12 -> 11 bust (a registry read at that moment), then answers again: the 11 -> 10 bust closes; a later late entry is refused and the seat-winning busters keep their places (c00b5b8: never closed; the late entry pushed 10th to 11th)', () => {
    let blind = false;
    const w = field(13, (_tid: string) => (blind ? null : { closeAtAlive: 11, openUntil: Date.now() + HOUR }));
    w.tm.eliminatePlayer(w.tid, 'p12');                                     // 12 alive
    blind = true;
    w.tm.eliminatePlayer(w.tid, 'p11');                                     // 11 alive: no answer, nothing closes
    blind = false;
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    w.tm.eliminatePlayer(w.tid, 'p10');                                     // 10 alive: closed now
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toEqual({ at: expect.any(Number), alive: 10, closeAtAlive: 11, playerId: 'p10' });
    expect(w.closes()).toEqual([expect.objectContaining({ alive: 10, closeAtAlive: 11, playerId: 'p10' })]);
    w.tm.eliminatePlayer(w.tid, 'p9');                                      // 9 alive: p9 finished 10th (a seat)
    expect(w.place('p9')).toBe(10);
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeNull();
    expect(w.tm.reinstateForReentry(w.tid, 'p11', 50_000)).toBe(false);
    expect([w.place('p9'), w.place('p10'), w.place('p11'), w.place('p12')]).toEqual([10, 11, 12, 13]);
    expect(w.closes()).toHaveLength(1);
  });

  it('the seat package moves the bubble from 11 to 13 while 12 are left (a field of 20): the next bust (12 -> 11) closes (c00b5b8: the bust to 11 never closed, the crossing of 13 had happened under the old bubble)', () => {
    let bubble = 11;
    const w = field(20, (_tid: string) => ({ closeAtAlive: bubble, openUntil: Date.now() + HOUR }));
    for (let i = 19; i >= 12; i--) w.tm.eliminatePlayer(w.tid, `p${i}`);    // 20 -> 12 alive, the old bubble (11) not reached
    expect(w.tm.getAliveCount(w.tid)).toBe(12);
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    bubble = 13;                                                             // the owner widened the package to the top 12
    w.tm.eliminatePlayer(w.tid, 'p11');                                      // 11 alive
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toMatchObject({ alive: 11, closeAtAlive: 13, playerId: 'p11' });
  });

  it('CONTROL — a bubble moved ABOVE the largest field that played (13 entrants, bubble raised to 14) never closes: that field never played above it (open until 2:00 PM, as published)', () => {
    let bubble = 11;
    const w = field(13, (_tid: string) => ({ closeAtAlive: bubble, openUntil: Date.now() + HOUR }));
    w.tm.eliminatePlayer(w.tid, 'p12');                                      // 12
    bubble = 14;
    for (const id of ['p11', 'p10', 'p9']) w.tm.eliminatePlayer(w.tid, id);  // 9
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeTruthy();
  });

  it('played above the bubble, then a seat undone (removeLateEntrant, not an elimination) leaves 11: the next ELIMINATION (11 -> 10) closes (c00b5b8: never closed for the rest of the window)', () => {
    const w = field(13, sunday());
    w.tm.eliminatePlayer(w.tid, 'p12');                                      // 12, played at 13
    expect(w.tm.removeLateEntrant(w.tid, 'p11')).toBe(true);                 // 11, not an elimination: nothing closes
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    w.tm.eliminatePlayer(w.tid, 'p10');                                      // 10
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toMatchObject({ alive: 10, closeAtAlive: 11, playerId: 'p10' });
  });

  it('an elimination during the prestart hold (30 seated, before the no-shows are released) does not count as the field playing: 20 no-shows released, 10 left, the first bust after the deal closes nothing', () => {
    const w = field(30, sunday());
    expect(w.tm.pauseTournament(w.tid, true, 'prestart')).toBe(true);
    w.tm.eliminatePlayer(w.tid, 'p29');                                      // e.g. a disqualification while held
    for (let i = 10; i < 29; i++) w.tm.removeLateEntrant(w.tid, `p${i}`);
    expect(w.tm.getAliveCount(w.tid)).toBe(10);
    expect(w.tm.pauseTournament(w.tid, false, 'prestart')).toBe(true);
    w.tm.eliminatePlayer(w.tid, 'p9');                                       // 9
    expect(w.tm.lateEntryClosedAtBubble(w.tid)).toBeNull();
    expect(w.tm.addLateEntrant(w.tid, 'late-1', 'Late', 'sl', 50_000, { masterUserId: 'm-late' })).toBeTruthy();
  });
});

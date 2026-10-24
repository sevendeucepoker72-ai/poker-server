/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F7) — every PAID
 * finisher is told his own place AND prize, and the payout table is shown
 * before registering. The audit's 2nd and 3rd (Wesley Smith 270, Andy K. 180)
 * were paid but never shown their prize: the Game Over line named the winner.
 *  - TournamentManager.payoutTableOf(t): {field, projected, payouts[{place,
 *    amount}]} with the SAME floor(pool x share) as finishTournament; the lobby
 *    item carries payouts / payoutField / payoutsProjected (additive).
 *  - prizeForEntrant(tid, pid): finished → his payout in the stored results;
 *    running + eliminated in a paid place (no tie group, not disqualified) →
 *    floor(pool x share); else null. A qualifier's pool is 0 → never a prize.
 *  - eliminatedToSpectator and the direct 'playerEliminated' carry `prize`
 *    when it is > 0.
 *  - A non-qualifier 'tournamentFinished' is sent PER SOCKET in the rooms with
 *    `myResult {place, prize, tied?} | null`; never isQualifier / wonSeat.
 *    The qualifier branch is unchanged.
 */
import { TournamentManager } from '../src/game/TournamentManager';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const regId = (tm: TournamentManager, name: string) => {
  for (const [id, t] of (tm as any).tournaments as Map<string, any>) if (t.config.name === name && t.status === 'registering') return id as string;
  throw new Error(name);
};
const item = (tm: TournamentManager, tid: string) => (tm.getTournamentList() as any[]).find((x) => x.tournamentId === tid);

/** A running 9-player Sit & Go (100 each: pool 900). */
function runningSng() {
  const tm = new TournamentManager();
  const tid = regId(tm, 'Sit & Go');
  for (let i = 0; i < 9; i++) expect(tm.registerPlayer(tid, `user-${i}`, `P${i}`, `s${i}`, 100 + i).success).toBe(true);
  expect(tm.startTournament(tid)).toBeTruthy();
  return { tm, tid };
}

afterEach(() => { jest.useRealTimers(); });

describe('F7 — the payout table (lobby) and every paid finisher\'s prize', () => {
  it("a registering 'Sit & Go': payouts 450 / 270 / 180, payoutField 9, not projected (it starts only when full); 'Daily 5K' with 2 registered projects a field of 4", () => {
    const tm = new TournamentManager();
    const sng = regId(tm, 'Sit & Go');
    expect(item(tm, sng)).toMatchObject({ payouts: [{ place: 1, amount: 450 }, { place: 2, amount: 270 }, { place: 3, amount: 180 }], payoutField: 9, payoutsProjected: false });
    const daily = regId(tm, 'Daily 5K');
    tm.registerPlayer(daily, 'a', 'A', 'sa', 1);
    tm.registerPlayer(daily, 'b', 'B', 'sb', 2);
    expect(item(tm, daily)).toMatchObject({ payouts: [{ place: 1, amount: 1000 }, { place: 2, amount: 600 }, { place: 3, amount: 400 }], payoutField: 4, payoutsProjected: true });
    // A qualifier-style event (pool 0): no table.
    const q = tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 600 }] } as any);
    expect(item(tm, q).payouts).toEqual([]);
  });

  it('a real 9-player Sit & Go to the end: the bust-time prize of 3rd (180) and of the runner-up (270) equal finishTournament\'s payouts; 4th and worse: null', () => {
    jest.useFakeTimers();
    const { tm, tid } = runningSng();
    const order = ['user-8', 'user-7', 'user-6', 'user-5', 'user-4', 'user-3'];
    for (const pid of order) {
      tm.eliminatePlayer(tid, pid);
      expect((tm as any).prizeForEntrant(tid, pid)).toBeNull();          // 9th .. 4th: unpaid
    }
    tm.eliminatePlayer(tid, 'user-2');
    expect((tm as any).prizeForEntrant(tid, 'user-2')).toBe(180);
    let finished: any = null;
    tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') finished = d; });
    tm.eliminatePlayer(tid, 'user-1');
    expect(tm.getTournament(tid)!.status).toBe('finished');
    expect((tm as any).prizeForEntrant(tid, 'user-1')).toBe(270);
    expect((tm as any).prizeForEntrant(tid, 'user-0')).toBe(450);
    const pay = Object.fromEntries(finished.results.map((r: any) => [r.playerId, r.payout]));
    expect([pay['user-0'], pay['user-1'], pay['user-2']]).toEqual([450, 270, 180]);
    expect(item(tm, tid).payouts).toEqual([{ place: 1, amount: 450 }, { place: 2, amount: 270 }, { place: 3, amount: 180 }]);
  });

  it('a tie group at the bust: null (the split is known only at the finish)', () => {
    jest.useFakeTimers();
    const { tm, tid } = runningSng();
    for (const pid of ['user-8', 'user-7', 'user-6', 'user-5', 'user-4', 'user-3']) tm.eliminatePlayer(tid, pid);
    expect(tm.markSimultaneousBustTie(tid, ['user-2', 'user-1'])).toBe(true);
    tm.eliminatePlayer(tid, 'user-2');
    expect((tm as any).prizeForEntrant(tid, 'user-2')).toBeNull();
  });
});

function sock(id: string, rooms: string[] = []) {
  const s: any = { id, connected: true, rooms: new Set(rooms), emitted: [] as Array<[string, any]> };
  s.emit = (ev: string, d: any) => s.emitted.push([ev, d]);
  s.join = (r: string) => s.rooms.add(r);
  s.leave = (r: string) => s.rooms.delete(r);
  return s;
}

describe('F7 — the bust notices carry the prize', () => {
  it('3rd place: eliminatedToSpectator {position 3, prize 180}; his other socket\'s playerEliminated carries prize 180; 4th: no prize key', () => {
    jest.useFakeTimers();
    const { tm, tid } = runningSng();
    const sockets = new Map<string, any>([['S2', sock('S2', ['table:T1'])], ['S2b', sock('S2b')], ['S3', sock('S3', ['table:T1'])]]);
    const scope: Record<string, unknown> = {
      io: { sockets: { sockets }, to: () => ({ emit() {} }) }, tournamentManager: tm, tournamentTables: new Map([['T1', tid]]),
      spectators: new Map(), detachSocketFromOtherTables() {}, tournamentHandStartSafety: { eliminationsToSocketSeatedElsewhere: 0, eliminationsToAwaySocket: 0 },
    };
    const { exports: m } = load(`${fnSrc('function tellTournamentBustNow(')}\n${fnSrc('function noticeTournamentEliminationToEntrant(')}`, scope, '{ tellTournamentBustNow }');
    for (const pid of ['user-8', 'user-7', 'user-6', 'user-5', 'user-4']) tm.eliminatePlayer(tid, pid);
    tm.eliminatePlayer(tid, 'user-3');
    m.tellTournamentBustNow(tid, 'T1', { playerId: 'user-3', playerName: 'P3' }, { sid: 'S3', toSpectator: true, seatedElsewhere: false, playsHere: true }, 4, []);
    const e4 = sockets.get('S3').emitted.find(([ev]: any) => ev === 'eliminatedToSpectator')[1];
    expect(e4.position).toBe(4);
    expect('prize' in e4).toBe(false);
    tm.eliminatePlayer(tid, 'user-2');
    m.tellTournamentBustNow(tid, 'T1', { playerId: 'user-2', playerName: 'P2' }, { sid: 'S2', toSpectator: true, seatedElsewhere: false, playsHere: true }, 3, ['S2b']);
    expect(sockets.get('S2').emitted.find(([ev]: any) => ev === 'eliminatedToSpectator')[1]).toMatchObject({ tournamentId: tid, position: 3, prize: 180 });   // e038f7b: no prize
    expect(sockets.get('S2b').emitted).toEqual([['playerEliminated', { tournamentId: tid, playerId: 'user-2', playerName: 'P2', position: 3, prize: 180 }]]);
  });
});

describe("F7 — a non-qualifier 'tournamentFinished' tells each socket its own result", () => {
  function finishWorld() {
    const tm = new TournamentManager();
    const tid = tm.createTournament({ name: 'Sit & Go', buyIn: 100, prizePool: 0, maxPlayers: 3, startInterval: 0, minPlayers: 3, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    for (let i = 0; i < 3; i++) tm.registerPlayer(tid, `user-${50 + i}`, `P${i}`, `s${i}`, 50 + i);
    tm.startTournament(tid);
    let data: any = null;
    tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
    tm.eliminatePlayer(tid, 'user-52');
    tm.eliminatePlayer(tid, 'user-51');
    const sockets = new Map<string, any>([
      ['SW', sock('SW', ['table:T1'])], ['S2', sock('S2', ['table:T1'])], ['SPEC', sock('SPEC', ['table:T1'])], ['AWAY', sock('AWAY')],
    ]);
    const authSessions = new Map<string, any>([['SW', { userId: 50 }], ['S2', { userId: 51 }], ['SPEC', { userId: 99 }], ['AWAY', { userId: 52 }]]);
    const roomEmits: any[] = [];
    const scope: Record<string, unknown> = {
      io: { sockets: { sockets }, to: (r: string) => ({ emit: (ev: string, d: any) => roomEmits.push([r, ev, d]) }) },
      tournamentManager: tm, authSessions, qualifierOfTournament: () => null, qualifierEntrantMasterId: () => null,
      console: { log() {}, warn() {}, error() {} },
    };
    const code = [
      slice('const FINISHED_TOURNAMENT_KEEP_MS', 'return rec;\n}\n'),
      fnSrc('function finishedEntrantIsAccount('),
      fnSrc('function emitTournamentFinishedToEntrants('),
    ].join('\n');
    const { exports: m } = load(code, scope, '{ emitTournamentFinishedToEntrants }');
    m.emitTournamentFinishedToEntrants(tid, ['T1'], data);
    return { tid, sockets, roomEmits, data };
  }
  const frame = (w: any, sid: string) => w.sockets.get(sid).emitted.filter(([ev]: any) => ev === 'tournamentFinished').map(([, d]: any) => d);

  it('the runner-up\'s socket: myResult {place 2, prize 90}; the winner\'s {place 1, prize 150}; a spectator: myResult null; no wonSeat / isQualifier anywhere; one frame each', () => {
    const w = finishWorld();
    expect(w.roomEmits).toEqual([]);                                   // e038f7b: one room broadcast, no myResult
    expect(frame(w, 'S2')).toHaveLength(1);
    expect(frame(w, 'S2')[0].myResult).toEqual({ place: 2, prize: 90 });
    expect(frame(w, 'SW')[0].myResult).toEqual({ place: 1, prize: 150 });
    expect(frame(w, 'SPEC')[0].myResult).toBeNull();
    for (const sid of ['SW', 'S2', 'SPEC']) {
      const f = frame(w, sid)[0];
      expect(f.tournamentId).toBe(w.tid);
      expect('wonSeat' in f || 'isQualifier' in f).toBe(false);
      expect(f.results.map((r: any) => [r.playerName, r.position, r.payout])).toEqual([['P0', 1, 150], ['P1', 2, 90], ['P2', 3, 60]]);
    }
    // The away entrant (in no room) still gets his own event with the prize.
    expect(w.sockets.get('AWAY').emitted).toEqual([['tournamentFinishedForEntrant', expect.objectContaining({ tournamentId: w.tid, position: 3, prize: 60 })]]);
  });

  it('the qualifier branch is unchanged (its per-socket frame with isQualifier / myResult {place, wonSeat})', () => {
    const fn = fnSrc('function emitTournamentFinishedToEntrants(');
    expect(fn).toContain("const common = { isQualifier: true, qualifierId: q.qualId, seatsForTop: seatsForTopWith(q.qt.qualifierType, q.qt.seatPackage), seatPackage: q.qt.seatPackage || null };");
    expect(fn).toContain("sock.emit('tournamentFinished', { ...data, ...common, myResult: mine, ...(mine ? { place: mine.place, wonSeat: mine.wonSeat } : {}) });");
    expect(SRC).toContain('prizeForEntrant(');
  });
});

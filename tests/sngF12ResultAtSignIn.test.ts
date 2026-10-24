/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F12) — a player
 * who busted while DISCONNECTED is told his place (and prize) at his next
 * sign-in, even after the table closed. The G183 notice (tellDeadTournamentSeat)
 * only covered a still-held reservation; the result itself lived in memory.
 * Now every sign-in (oauthLogin, tokenLogin x2, resumeSession) asks the durable
 * rows (F14) for this account's UNTOLD results (non-qualifier, not voided,
 * within 7 days, at most 5):
 *  - finished → the EXISTING 'tournamentFinishedForEntrant' {tournamentId,
 *    position, prize?, tournamentName, atSignIn:true} (old bundles toast it);
 *  - still running (in this process) → the EXISTING 'playerEliminated'
 *    {tournamentId, playerId, playerName, position, prize?, atSignIn:true};
 *  - each told row gets told_at (never told twice); the tournament the G183
 *    notice just told is not told again (marked told); a running row whose
 *    tournament is gone (a crash) is left untold; a socket that changed
 *    account meanwhile gets nothing. Never throws into the sign-in.
 */
import { TournamentManager } from '../src/game/TournamentManager';
import { slice, fnSrc, load, flush } from './helpers/indexSource';

function world(rows: any[]) {
  const tm = new TournamentManager();
  const told: Array<[string, string]> = [];
  const asked: Array<[unknown, unknown]> = [];
  const store = {
    unseenFor: async (uid: unknown, master: unknown) => { asked.push([uid, master]); return rows; },
    markTold: async (tid: string, pid: string) => { told.push([tid, pid]); },
  };
  const emitted: Array<[string, any]> = [];
  const socket: any = { id: 'S1', connected: true, emit: (ev: string, d: any) => emitted.push([ev, d]) };
  const auth = { userId: 7, masterUserId: 'm-7' };
  const authSessions = new Map<string, any>([['S1', auth]]);
  const { exports: m, stubbed } = load(fnSrc('function tellUnseenTournamentResults('), {
    tournamentResults: store, tournamentManager: tm, authSessions, console: { log() {}, warn() {}, error() {} },
  }, '{ tellUnseenTournamentResults, unseenResultNotices }');
  return { tm, m, told, asked, emitted, socket, auth, authSessions, stubbed };
}
const FIN = (o: any = {}) => ({ tournamentId: 'TF', playerId: 'user-7', playerName: 'Josh', place: 6, prize: 0, name: 'Sit & Go', status: 'finished', ...o });

describe('F12 — his place (and prize) at the next sign-in', () => {
  it('an untold finished result: tournamentFinishedForEntrant {position 6, atSignIn} (no prize key at 0), then told_at; asked by local AND master id', async () => {
    const w = world([FIN()]);
    w.m.tellUnseenTournamentResults(w.socket, w.auth, null);
    await flush();
    expect(w.asked).toEqual([[7, 'm-7']]);
    expect(w.emitted).toEqual([['tournamentFinishedForEntrant', { tournamentId: 'TF', position: 6, tournamentName: 'Sit & Go', atSignIn: true }]]);
    expect(w.told).toEqual([['TF', 'user-7']]);
  });

  it('a paid place carries its prize (3rd: 180)', async () => {
    const w = world([FIN({ place: 3, prize: 180 })]);
    w.m.tellUnseenTournamentResults(w.socket, w.auth, null);
    await flush();
    expect(w.emitted[0][1]).toMatchObject({ position: 3, prize: 180 });
  });

  it('a tournament still RUNNING here: playerEliminated with his place; gone (a crash killed it): nothing, left untold', async () => {
    const w = world([]);
    const tid = (w.tm.getTournamentList() as any[]).find((x) => x.name === 'Sit & Go').tournamentId;
    for (let i = 0; i < 9; i++) w.tm.registerPlayer(tid, `user-${i}`, `P${i}`, `s${i}`, i + 1);
    w.tm.startTournament(tid);
    const t = w.tm.getTournament(tid)!;
    if (t.blindTimer) clearTimeout(t.blindTimer);
    const w2 = world([FIN({ tournamentId: tid, status: 'running', place: 9 }), FIN({ tournamentId: 'GONE', status: 'running', place: 8 })]);
    (w2 as any).m = load(fnSrc('function tellUnseenTournamentResults('), {
      tournamentResults: { unseenFor: async () => [FIN({ tournamentId: tid, status: 'running', place: 9 }), FIN({ tournamentId: 'GONE', status: 'running', place: 8 })], markTold: async (a: string, b: string) => { w2.told.push([a, b]); } },
      tournamentManager: w.tm, authSessions: w2.authSessions, console: { log() {}, warn() {}, error() {} },
    }, '{ tellUnseenTournamentResults }').exports;
    w2.m.tellUnseenTournamentResults(w2.socket, w2.auth, null);
    await flush();
    expect(w2.emitted).toEqual([['playerEliminated', { tournamentId: tid, playerId: 'user-7', playerName: 'Josh', position: 9, atSignIn: true }]]);
    expect(w2.told).toEqual([[tid, 'user-7']]);
  });

  it('the tournament the G183 notice just told: not told again, marked told', async () => {
    const w = world([FIN(), FIN({ tournamentId: 'TB', place: 4 })]);
    w.m.tellUnseenTournamentResults(w.socket, w.auth, 'TF');
    await flush();
    expect(w.emitted.map(([, d]) => d.tournamentId)).toEqual(['TB']);
    expect(w.told.sort()).toEqual([['TB', 'user-7'], ['TF', 'user-7']]);
  });

  it('the socket signed out / switched account before the answer: nothing told, nothing marked', async () => {
    const w = world([FIN()]);
    w.m.tellUnseenTournamentResults(w.socket, w.auth, null);
    w.authSessions.set('S1', { userId: 99 });
    await flush();
    expect(w.emitted).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it('a failing read never throws into the sign-in', async () => {
    const w = world([]);
    const m = load(fnSrc('function tellUnseenTournamentResults('), {
      tournamentResults: { unseenFor: async () => { throw new Error('db'); }, markTold: async () => {} },
      tournamentManager: w.tm, authSessions: w.authSessions, console: { log() {}, warn() {}, error() {} },
    }, '{ tellUnseenTournamentResults }').exports;
    expect(() => m.tellUnseenTournamentResults(w.socket, w.auth, null)).not.toThrow();
    await flush();
    expect(w.emitted).toEqual([]);
  });

  it('wiring: each of the 4 sign-in handlers asks right after its G183 notice', () => {
    for (const [start, end] of [
      ["socket.on('oauthLogin', trackLogin(socket, 'oauthLogin', async", '\n  }));\n'],
      ["socket.on('tokenLogin', trackLogin(socket, 'tokenLogin', async", '\n  }));\n'],
    ] as const) {
      const body = slice(start, end);
      expect((body.match(/tellUnseenTournamentResults\(/g) || []).length).toBe((body.match(/tellDeadTournamentSeat\(socket/g) || []).length);
    }
    const resume = slice('  let resumeWindowStart = 0;', '\n    })\n  );\n');
    expect(resume).toContain('tellUnseenTournamentResults(socket, rsSession');
    expect(slice("socket.on('tokenLogin', trackLogin(socket, 'tokenLogin', async", '\n  }));\n').match(/tellUnseenTournamentResults\(/g)).toHaveLength(2);
  });
});

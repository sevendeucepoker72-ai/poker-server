/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F19) — the
 * non-qualifier 'tournamentFinished' room frame no longer broadcasts every
 * entrant's LOCAL ACCOUNT ID. Each results row carried `userId` (the local
 * users.id) and a `playerId` of the form `user-<id>` to every socket in the
 * table rooms, spectators included.
 * Now (the per-socket frame of F7): every row keeps what the client draws —
 * playerName, position, payout, entryId, tied / disqualified — and only the
 * receiving socket's OWN row keeps `userId` / `playerId` (the old client finds
 * its own row by userId). The qualifier branch is unchanged (its rows carry the
 * qualifier registration ids, never a local account id); the away entrant's
 * 'tournamentFinishedForEntrant' never had results.
 */
import { TournamentManager } from '../src/game/TournamentManager';
import { slice, fnSrc, load } from './helpers/indexSource';

function sock(id: string, rooms: string[] = []) {
  const s: any = { id, connected: true, rooms: new Set(rooms), emitted: [] as Array<[string, any]> };
  s.emit = (ev: string, d: any) => s.emitted.push([ev, d]);
  return s;
}

function finishWorld() {
  const tm = new TournamentManager();
  const tid = tm.createTournament({ name: 'Sit & Go', buyIn: 100, prizePool: 0, maxPlayers: 3, startInterval: 0, minPlayers: 3, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
  for (let i = 0; i < 3; i++) tm.registerPlayer(tid, `user-${50 + i}`, `P${i}`, `s${i}`, 50 + i);
  tm.startTournament(tid);
  let data: any = null;
  tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') data = d; });
  tm.eliminatePlayer(tid, 'user-52');
  tm.eliminatePlayer(tid, 'user-51');
  const t = tm.getTournament(tid)!;
  if (t.blindTimer) clearTimeout(t.blindTimer);
  const sockets = new Map<string, any>([['S2', sock('S2', ['table:T1'])], ['SPEC', sock('SPEC', ['table:T1'])]]);
  const authSessions = new Map<string, any>([['S2', { userId: 51 }], ['SPEC', { userId: 99 }]]);
  const scope: Record<string, unknown> = {
    io: { sockets: { sockets }, to: () => ({ emit() {} }) },
    tournamentManager: tm, authSessions, qualifierOfTournament: () => null, qualifierEntrantMasterId: () => null,
    console: { log() {}, warn() {}, error() {} },
  };
  const code = [slice('const FINISHED_TOURNAMENT_KEEP_MS', 'return rec;\n}\n'), fnSrc('function finishedEntrantIsAccount('), fnSrc('function emitTournamentFinishedToEntrants(')].join('\n');
  const { exports: m } = load(code, scope, '{ emitTournamentFinishedToEntrants }');
  m.emitTournamentFinishedToEntrants(tid, ['T1'], data);
  const frame = (sid: string) => sockets.get(sid).emitted.find(([ev]: any) => ev === 'tournamentFinished')[1];
  return { tid, data, frame };
}

describe('F19 — the finish frame carries no other entrant\'s local account id', () => {
  it('a spectator\'s frame: no userId and no user-<id> playerId in any row; names, places, payouts kept', () => {
    const w = finishWorld();
    const f = w.frame('SPEC');
    expect(f.results.map((r: any) => [r.playerName, r.position, r.payout])).toEqual([['P0', 1, 150], ['P1', 2, 90], ['P2', 3, 60]]);
    for (const r of f.results) {
      expect('userId' in r).toBe(false);                                   // e038f7b: 50 / 51 / 52
      expect('playerId' in r).toBe(false);                                 // e038f7b: user-50 ...
      expect(typeof r.entryId).toBe('string');
    }
    expect(JSON.stringify(f)).not.toMatch(/user-5\d/);
  });

  it('an entrant\'s frame: ONLY his own row keeps userId / playerId; myResult as F7', () => {
    const w = finishWorld();
    const f = w.frame('S2');
    expect(f.myResult).toEqual({ place: 2, prize: 90 });
    const own = f.results.find((r: any) => r.position === 2);
    expect(own).toMatchObject({ userId: 51, playerId: 'user-51', playerName: 'P1' });
    for (const r of f.results.filter((x: any) => x.position !== 2)) expect('userId' in r || 'playerId' in r).toBe(false);
    // The source `data` (the qualifier / prize paths read it) is untouched.
    expect(w.data.results.every((r: any) => typeof r.userId === 'number' && /^user-/.test(r.playerId))).toBe(true);
  });
});

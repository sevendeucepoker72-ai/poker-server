/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F13) — the
 * 'tournament starting' alert is sent by MASTER account id, to EVERY entrant:
 * also a registrant who is away at the start (no bound socket). It used to go
 * to authSessions.get(tp.socketId).userId — the LOCAL integer id the master's
 * notification service cannot resolve (notifyClient: the master keys on the
 * master id), and only to registrants still bound to a socket; the > 9-entrant
 * start sent none.
 *  - Master id: the registration's masterUserId, the bound socket's session,
 *    a reservation's snapshot, the absent-seat cache, else resolved from the
 *    row's stats stamp (loadLocalStats → masterIdFromStats) and sent then.
 *  - An account-less entrant gets nothing. The body names the drawn table /
 *    seat (F6). Qualifier and simulation starts are unchanged.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { masterIdFromStats } from '../src/auth/playGate';
import { fnSrc, load, flush } from './helpers/indexSource';

function world() {
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  let n = 0;
  const tableManager = {
    createQuickTable: (name: string, max: number, sb: number, bb: number, _minBuyIn: number, _v: any, ante = 0) => {
      const id = `T${++n}`;
      tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: max } as any));
      return id;
    },
    getTable: (id: string) => tables.get(id),
  };
  const sent: Array<{ to: unknown; type: string; body: string; meta: any }> = [];
  const authSessions = new Map<string, any>([['SA', { userId: 1, masterUserId: 'm-a' }]]);
  const stats = new Map<number, string>([[2, JSON.stringify({ masterUserId: 'm-b' })], [4, JSON.stringify({ masterUserId: 'm-d' })]]);
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tableManager, tournamentTables: new Map(), randomInt: require('crypto').randomInt,
    bindRegistrantSocket: (_tid: string, tp: any) => (tp.playerId === 'pa' ? 'SA' : null),
    keepStartSeatAbsentForLiveSeatElsewhere: () => false, detachSocketFromOtherTables() {},
    ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {}, bootstrapTournamentTables() {},
    authSessions, playerSessions: new Map(), reservedSeats: new Map(), absentSeatMasterIds: new Map(),
    loadLocalStats: async (uid: number) => stats.get(uid) ?? '{}', masterIdFromStats,
    notifyPlayer: async (to: unknown, type: string, _title: string, body: string, opts: any) => { sent.push({ to, type, body, meta: opts?.metadata }); },
    io: { to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
    console: { log() {}, warn() {}, error() {} },
  };
  const code = [fnSrc('function drawSeatOrder('), fnSrc('function notifyTournamentStart('), fnSrc('function startRegisteredTournamentTables('), fnSrc('function startTournamentGame(')].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ startTournamentGame, notifyTournamentStart }');
  return { tm, tables, m, sent, stubbed };
}

afterEach(() => { jest.useRealTimers(); });

describe('F13 — the start alert goes to every entrant by MASTER id', () => {
  it('single table: A (bound, master at registration), B (AWAY, master resolved from his row), C (no account: nothing) → m-a and m-b, each with his drawn seat; never a local integer id', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const w = world();
    const tid = w.tm.createTournament({ name: 'Cup', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, minPlayers: 3, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    w.tm.registerPlayer(tid, 'pa', 'A', 'SA', 1, 'm-a');
    w.tm.registerPlayer(tid, 'pb', 'B', 'SB-old', 2);
    w.tm.registerPlayer(tid, 'pc', 'C', 'SC-old');
    w.m.startTournamentGame(tid);
    await flush();
    const t = w.tables.get('T1')!;
    const seatOf = (pid: string) => t.seats.findIndex((s) => s.playerId === pid);
    expect(w.sent.map((x) => x.to).sort()).toEqual(['m-a', 'm-b']);                       // e038f7b: [1] (local id), B never told
    for (const x of w.sent) {
      expect(typeof x.to).toBe('string');
      expect(x.type).toBe('tournament_start');
      const pid = x.to === 'm-a' ? 'pa' : 'pb';
      expect(x.meta).toEqual({ gameId: 'T1', tournamentId: tid, seatNumber: seatOf(pid), tableNum: 1 });
      expect(x.body).toBe("Cup is starting now — you're seated at Table 1");
    }
    expect([...w.stubbed].filter((s) => /notify|Stats|master/i.test(s))).toEqual([]);
  });

  it('more than one table (12 entrants): every entrant with an account is alerted with HIS table number (e038f7b: none)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const w = world();
    const tid = w.tm.createTournament({ name: 'Big', buyIn: 0, prizePool: 0, maxPlayers: 18, startInterval: 0, minPlayers: 12, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    for (let i = 0; i < 12; i++) w.tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, 100 + i, `m-${i}`);
    w.m.startTournamentGame(tid);
    await flush();
    expect(w.sent).toHaveLength(12);
    for (const x of w.sent) {
      const pid = `p${String(x.to).slice(2)}`;
      const tableId = w.tm.getTournament(tid)!.playerTableMap.get(pid)!;
      expect(x.meta.gameId).toBe(tableId);
      expect(x.meta.tableNum).toBe(Number(tableId.slice(1)));
      expect(w.tables.get(tableId)!.seats[x.meta.seatNumber].playerId).toBe(pid);
    }
  });

  it('qualifier and simulation starts are unchanged (never notifyTournamentStart)', () => {
    expect(fnSrc('function startQualifierTournament(')).not.toContain('notifyTournamentStart');
  });
});

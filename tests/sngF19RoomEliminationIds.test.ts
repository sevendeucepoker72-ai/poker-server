/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F19, review fix-up)
 * — the table-room 'playerEliminated' copy no longer carries the entrants'
 * local account ids.
 *
 * F19 stripped userId / playerId from the other rows of the finish frame, but
 * every ROOM 'playerEliminated' broadcast still sent the busted entrant's
 * `playerId` ('user-<local users.id>') and `eliminatorId` ('user-<id>') to
 * every socket in the table room, spectators included: over a Sit & Go every
 * entrant's account id still reached the room one bust at a time.
 *  - roomEliminationPayload: at a NON-qualifier tournament the room copy's
 *    `playerId` / `eliminatorId` become opaque per-process tokens
 *    (`e-` + HMAC(tournamentId:id) with a random boot key - stable for the same
 *    entrant within the event, so the client's dedupe still matches across
 *    copies; nothing maps back to an account). Every other field unchanged.
 *  - Qualifier rooms: byte-identical (Sunday). Direct notices to the entrant's
 *    own sockets keep his own id (unchanged).
 *  - The room's `.except(...)` (the sockets told directly) still keys on the
 *    REAL playerId.
 */
import { createHmac, randomBytes } from 'crypto';
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { slice, fnSrc, load } from './helpers/indexSource';

type Emit = { room: string; except: string[]; ev: string; data: any };

function world(opts: { qualifier?: boolean } = {}) {
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  const qualifierTournaments = new Map<string, any>();
  const emits: Emit[] = [];
  let n = 0;
  const roomOf = (room: string, except: string[] = []): any => ({
    emit: (ev: string, data: any) => emits.push({ room, except, ev, data: JSON.parse(JSON.stringify(data)) }),
    except: (e: string[]) => roomOf(room, e),
  });
  const tableManager = {
    createQuickTable: (name: string, max: number, sb: number, bb: number, _min: number, _v: any, ante = 0) => {
      const id = `T${++n}`;
      tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: max } as any));
      return id;
    },
    getTable: (id: string) => tables.get(id),
  };
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tableManager, tournamentTables, qualifierTournaments, randomInt: () => 0, createHmac, randomBytes,
    bindRegistrantSocket: () => null, ensureTableProgressListener() {}, scheduleAIAction() {},
    broadcastGameState() {}, recordTournamentResultsStart() {}, notifyTournamentStart() {},
    handForHandNoticeDeferred: () => false, handleTableRebalance() {},
    authSessions: new Map(), playerSessions: new Map(), reservedSeats: new Map(), absentSeatMasterIds: new Map(),
    notifyPlayer: async () => {}, io: { to: (r: string) => roomOf(r), emit() {}, sockets: { sockets: new Map() } },
    SEAT_RESERVE_MS: 6 * 3600_000, Sentry: null, tournamentBootstrapStats: { tableFailures: 0 },
    console: { log() {}, warn() {}, error() {} },
  };
  const code = [
    slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
    fnSrc('function qualifierOfTournament('),
    slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n'),
    slice('let eliminationDirectNotice: ', 'eliminationDirectNotice.sids : [];\n}\n'),
    slice('// ===== F19 review fix-up: room elimination ids =====', '// ===== end F19 review fix-up =====\n'),
    fnSrc('function drawSeatOrder('),
    fnSrc('function startRegisteredTournamentTables('),
    fnSrc('function startTournamentGame('),
    fnSrc('function bootstrapTournamentTables('),
    fnSrc('function emitHandForHandRoomBust('),
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ startTournamentGame, emitHandForHandRoomBust, roomEliminationPayload }');
  const eliminations = () => emits.filter((e) => e.ev === 'playerEliminated');
  const create = (name: string, players: number, maxPlayers = 18) => {
    const tid = tm.createTournament({ name, buyIn: 0, prizePool: 0, maxPlayers, startInterval: 0, minPlayers: players, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    for (let i = 0; i < players; i++) expect(tm.registerPlayer(tid, `user-${500 + i}`, `P${i}`, `s${i}`, 500 + i).success).toBe(true);
    if (opts.qualifier) qualifierTournaments.set('Q-weekly', { tournamentId: tid, status: 'running', players: [] });
    return tid;
  };
  return { tm, m, stubbed, emits, eliminations, create, tables };
}

afterEach(() => { jest.useRealTimers(); });
const ACCOUNT_ID = /user-\d+/;

describe('F19 review fix-up — no account ids in the room elimination copy (non-qualifier)', () => {
  it('a one-table Sit & Go (startTournamentGame): the room copy has opaque playerId / eliminatorId, everything else as before (a154b20: user-<id>)', () => {
    jest.useFakeTimers();
    const w = world();
    const tid = w.create('Custom Six', 6);
    w.m.startTournamentGame(tid);
    w.tm.eliminatePlayer(tid, 'user-503', 'user-501');
    const [e] = w.eliminations();
    expect(e.room).toBe('table:T1');
    expect(JSON.stringify(e.data)).not.toMatch(ACCOUNT_ID);
    expect(e.data).toMatchObject({ playerName: 'P3', position: 6, playerId: expect.stringMatching(/^e-[0-9a-f]{16}$/), eliminatorId: expect.stringMatching(/^e-[0-9a-f]{16}$/) });
    expect(e.data.playerId).not.toBe(e.data.eliminatorId);
    expect([...w.stubbed].filter((s) => /roomEliminationPayload|roomEntrantToken|ROOM_ENTRANT|createHmac|randomBytes|qualifierEngine/.test(s))).toEqual([]);
  });

  it('a multi-table event (bootstrapTournamentTables): every table room gets the SAME opaque token for the same entrant (the client dedupe still matches)', () => {
    jest.useFakeTimers();
    const w = world();
    const tid = w.create('Big Custom', 12);
    w.m.startTournamentGame(tid);
    w.tm.eliminatePlayer(tid, 'user-507');
    const copies = w.eliminations();
    expect(copies.map((c) => c.room).sort()).toEqual(['table:T1', 'table:T2']);
    for (const c of copies) expect(JSON.stringify(c.data)).not.toMatch(ACCOUNT_ID);
    expect(new Set(copies.map((c) => c.data.playerId)).size).toBe(1);
    // A token is per tournament + entrant: another entrant gets another one.
    w.tm.eliminatePlayer(tid, 'user-508');
    const later = w.eliminations().slice(2);
    expect(later[0].data.playerId).not.toBe(copies[0].data.playerId);
  });

  it('the hand-for-hand room copy is mapped the same way at a non-qualifier event', () => {
    const w = world();
    const tid = w.create('HFH Custom', 4);
    (w.tm.getTournament(tid) as any).tableIds = ['T9'];
    w.m.emitHandForHandRoomBust(tid, { playerId: 'user-502', playerName: 'P2', position: 3, eliminatorId: 'user-500' }, []);
    const [e] = w.eliminations();
    expect(e.data).toMatchObject({ playerName: 'P2', position: 3, handForHand: true });
    expect(JSON.stringify(e.data)).not.toMatch(ACCOUNT_ID);
  });
});

describe('F19 review fix-up — qualifier rooms byte-identical', () => {
  it('a qualifier tournament: the room copy keeps its ids exactly (Sunday)', () => {
    jest.useFakeTimers();
    const w = world({ qualifier: true });
    const tid = w.create('Qualifier Tournament', 12);
    w.m.startTournamentGame(tid);
    w.tm.eliminatePlayer(tid, 'user-504', 'user-506');
    for (const c of w.eliminations()) expect(c.data).toMatchObject({ playerId: 'user-504', eliminatorId: 'user-506' });
    expect(w.m.roomEliminationPayload(tid, { playerId: 'user-1', playerName: 'X' })).toEqual({ playerId: 'user-1', playerName: 'X' });
  });
});

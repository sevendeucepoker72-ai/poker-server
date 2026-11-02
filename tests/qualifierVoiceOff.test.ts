/**
 * 2026-11-02 (.online tournament broadcast, P1-S6) — VOICE CHAT IS OFF AT A
 * QUALIFIER TABLE, server side. Peer-to-peer voice between opponents at a
 * seat-awarding table is a collusion channel, and qualifier tables may be
 * streamed. At any table of a qualifier (start + overflow tables, seated, on an
 * extra seat, or watching):
 *  - 'voiceJoin' is refused ('voiceRefused' {tableId, code:'voice_off_qualifier',
 *    message}) and the socket never joins voice_<tableId>;
 *  - a socket already in a voice room whose session lands on a qualifier table
 *    (every qualifier seating runs detachSocketFromOtherTables(…, 'seat', …); a
 *    rebalance runs moveTournamentSeatPointers) leaves every voice_ room, its peers
 *    get 'voicePeerLeft', it gets 'voiceForcedOff';
 *  - every gameState carries `voiceChatAllowed` (false at a qualifier table).
 * Cash tables and Sit & Gos are unchanged (the controls).
 *
 * The REAL index.ts source (sliced) on the REAL PokerTable / TournamentManager
 * (the world of qualifierHelpToolsOff.test.ts).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { SRC, slice, fnSrc, handlerSrc, load } from './helpers/indexSource';

const CODE = 'voice_off_qualifier';
const TEXT = 'Voice chat is off in qualifier tournaments.';
const HELP = [
  slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  fnSrc('function qualifierOfTournament('),
  slice('// ===== Help tools off at qualifier tables', '// ===== end help tools off =====\n'),
  slice('// ===== Voice chat off at qualifier tables', '// ===== end voice off =====\n'),
].join('\n');
/** The voiceJoin handler with the connection-scoped isSeatedAt it reads. */
const VOICE_JOIN_SRC = slice('  const isSeatedAt = (tableId: string): boolean => {', '\n  });\n');

/** A running QUALIFIER (start QS1 + overflow QOV), a running Sit & Go (SG1), a cash table (C1). */
function world() {
  const tm = new TournamentManager();
  const tournamentTables = new Map<string, string>();
  const qualifierTournaments = new Map<string, any>();
  const tables = new Map<string, PokerTable>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const authSessions = new Map<string, any>();
  const sockets = new Map<string, any>();
  const logs: string[] = [];
  const start = (n: number) => {
    const tid = tm.createTournament({ name: 'T', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 720 }], startingChips: 5000 } as any);
    for (let i = 0; i < n; i++) tm.registerPlayer(tid, `${tid}-${i}`, `P${i}`, `s${i}`, undefined, `m-${tid}-${i}`);
    expect(tm.startTournament(tid)).toBeTruthy();
    return tid;
  };
  const qtid = start(4);
  qualifierTournaments.set('Q-weekly', { tournamentId: qtid, status: 'running', qualifierType: 'weekly', players: [] });
  const sng = start(2);
  const mkTable = (id: string, tournamentId?: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 100_000, maxPlayers: 9 } as any);
    t.sitDown(0, `${id}-A`, 5000, `${id}-a`, false);
    t.sitDown(1, `${id}-B`, 5000, `${id}-b`, false);
    if (tournamentId) tournamentTables.set(id, tournamentId);
    tables.set(id, t);
    return t;
  };
  mkTable('QS1', qtid);
  mkTable('QOV', qtid);
  tm.setTableIds(qtid, ['QS1']);
  tm.addTable?.(qtid, 'QOV');
  mkTable('SG1', sng);
  mkTable('C1');
  const emitted: Array<[string, string, any]> = [];
  /** socket.to(room).emit — [room, event, payload, from]. */
  const roomEmits: Array<[string, string, any, string]> = [];
  const mkSocket = (id: string, userId: number) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers, rooms: new Set<string>([id]),
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      emit: (ev: string, p: any) => emitted.push([id, ev, p]),
      to: (room: string) => ({ emit: (ev: string, p: any) => roomEmits.push([room, ev, p, id]) }),
      join(r: string) { s.rooms.add(r); }, leave(r: string) { s.rooms.delete(r); },
    };
    sockets.set(id, s);
    authSessions.set(id, { userId, username: `u${userId}`, masterUserId: `m-${userId}` });
    return s;
  };
  const seat = (s: any, tableId: string, seatIndex: number) => {
    playerSessions.set(s.id, { socketId: s.id, tableId, seatIndex, playerName: `${tableId}-x`, playerId: `${tableId}-p`, trainingEnabled: false, sittingOut: false });
    s.join(`table:${tableId}`);
  };
  const of = (sid: string, ev: string) => emitted.filter(([s, e]) => s === sid && e === ev).map(([, , p]) => p);
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, SEAT_RESERVE_MS: 6 * 3600_000,
    tableManager: { getTable: (id: string) => tables.get(id) },
    playerSessions, multiTableSessions, authSessions,
    io: { sockets: { sockets }, to: () => ({ emit() {} }) },
    seatNameForSocket: () => 'Seat Name',
    console: { log: (...a: any[]) => logs.push(a.join(' ')), warn() {}, error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`) },
  };
  return { tm, qtid, sng, tables, tournamentTables, playerSessions, multiTableSessions, authSessions, sockets, emitted, roomEmits, logs, scope, mkSocket, seat, of };
}
const refusedLines = (logs: string[]) => logs.filter((l) => l.includes('"event":"voice_refused_at_qualifier"'));
const forcedLines = (logs: string[]) => logs.filter((l) => l.includes('"event":"voice_forced_off_at_qualifier"'));

function voiceJoinWorld() {
  const w = world();
  const code = `${HELP}\nfunction wire(socket) {\n${VOICE_JOIN_SRC}\n}`;
  const loaded = load(code, w.scope, '{ wire, qualifierVoiceOff }');
  return { w, m: loaded.exports, stubbed: loaded.stubbed };
}

describe('V1 — voiceJoin is refused at a qualifier table (start + overflow), the socket never joins the voice room', () => {
  it('seated at the start table / the overflow table: voiceRefused {tableId, code, message}, no voice_ room, nobody told voicePeerJoined (d2a52b5: joined)', async () => {
    const { w, m, stubbed } = voiceJoinWorld();
    for (const [sid, uid, tid] of [['S1', 1, 'QS1'], ['S2', 2, 'QOV']] as const) {
      const s = w.mkSocket(sid, uid);
      w.seat(s, tid, 0);
      m.wire(s);
      await s.handlers.voiceJoin({ tableId: tid, username: 'spoofed' });
      expect(w.of(sid, 'voiceRefused')).toEqual([{ tableId: tid, code: CODE, message: TEXT }]);
      expect([...s.rooms].filter((r: string) => r.startsWith('voice_'))).toEqual([]);
    }
    expect(w.roomEmits.filter(([, ev]) => ev === 'voicePeerJoined')).toEqual([]);
    expect(m.qualifierVoiceOff.voiceRefused).toBe(2);
    expect(refusedLines(w.logs)).toHaveLength(2);
    expect(refusedLines(w.logs)[0]).toContain('"qualifierId":"Q-weekly"');
    expect([...stubbed].filter((n) => /qualifier|Qualifier|tournamentIdOfTable/.test(n))).toEqual([]);
  });

  it('seated at a CASH table but on an extra seat at the qualifier, or watching a qualifier table (its table: room): refused for the cash table too', async () => {
    const { w, m } = voiceJoinWorld();
    const extra = w.mkSocket('SX', 3);
    w.seat(extra, 'C1', 0);
    w.multiTableSessions.set('SX', [{ socketId: 'SX', tableId: 'QOV', seatIndex: 1 }]);
    m.wire(extra);
    await extra.handlers.voiceJoin({ tableId: 'C1' });
    expect(w.of('SX', 'voiceRefused')).toEqual([{ tableId: 'C1', code: CODE, message: TEXT }]);
    const watcher = w.mkSocket('SW', 4);
    w.seat(watcher, 'C1', 1);
    watcher.join('table:QS1');
    m.wire(watcher);
    await watcher.handlers.voiceJoin({ tableId: 'C1' });
    expect(w.of('SW', 'voiceRefused')).toEqual([expect.objectContaining({ code: CODE })]);
    for (const s of [extra, watcher]) expect(s.rooms.has('voice_C1')).toBe(false);
    expect(m.qualifierVoiceOff.voiceRefused).toBe(2);
  });

  it('CONTROLS — a cash table and a Sit & Go table: joined, the room told voicePeerJoined; not seated: the old error, nothing counted', async () => {
    const { w, m } = voiceJoinWorld();
    const c = w.mkSocket('SC', 5); w.seat(c, 'C1', 0); m.wire(c);
    const g = w.mkSocket('SG', 6); w.seat(g, 'SG1', 0); m.wire(g);
    await c.handlers.voiceJoin({ tableId: 'C1' });
    await g.handlers.voiceJoin({ tableId: 'SG1' });
    expect(c.rooms.has('voice_C1')).toBe(true);
    expect(g.rooms.has('voice_SG1')).toBe(true);
    expect(w.roomEmits.filter(([, ev]) => ev === 'voicePeerJoined').map(([room]) => room)).toEqual(['voice_C1', 'voice_SG1']);
    expect(w.of('SC', 'voiceRefused')).toEqual([]);
    const n = w.mkSocket('SN', 7); m.wire(n);
    await n.handlers.voiceJoin({ tableId: 'QS1' });
    expect(w.of('SN', 'error')).toEqual([{ message: 'Not seated at table' }]);
    expect(m.qualifierVoiceOff.voiceRefused).toBe(0);
  });
});

describe('V2 — a socket in voice chat is forced out when its session lands on a qualifier table', () => {
  function detachWorld() {
    const w = world();
    const code = `${HELP}\nconst spectators = new Map();\nconst lastSentState = new Map();\nconst lastSentJson = new Map();\nconst tableViewDetaches = { calls: 0, spectatorViewsEnded: 0, roomsLeft: 0, deadSeatSessionsEnded: 0, deadSeatSessionsEndedSilently: 0 };\n${fnSrc('function detachSocketFromOtherTables(')}`;
    const loaded = load(code, { ...w.scope, isTournamentTable: (id: string) => w.tournamentTables.has(id), releaseSeatedSlot() {} }, '{ detachSocketFromOtherTables, qualifierVoiceOff }');
    return { w, m: loaded.exports };
  }

  it('seated at a qualifier (detachSocketFromOtherTables kind "seat" — start, early rooms, late entry, re-entries): every voice_ room left, peers told voicePeerLeft, voiceForcedOff {code}; counted + logged', () => {
    const { w, m } = detachWorld();
    const s = w.mkSocket('S1', 1);
    w.seat(s, 'C1', 0);
    s.join('voice_C1');
    s.join('voice_SG1');
    m.detachSocketFromOtherTables(s, 'QS1', 'seat', 'startQualifierTournament');
    expect([...s.rooms].filter((r: string) => r.startsWith('voice_'))).toEqual([]);
    expect(w.roomEmits.filter(([, ev]) => ev === 'voicePeerLeft')).toEqual([
      ['voice_C1', 'voicePeerLeft', { socketId: 'S1' }, 'S1'],
      ['voice_SG1', 'voicePeerLeft', { socketId: 'S1' }, 'S1'],
    ]);
    expect(w.of('S1', 'voiceForcedOff')).toEqual([{ code: CODE, tableId: 'QS1', message: TEXT }]);
    expect(m.qualifierVoiceOff).toEqual({ voiceRefused: 0, voiceForcedOff: 1, voiceRoomsLeft: 2 });
    expect(forcedLines(w.logs)).toHaveLength(1);
    expect(forcedLines(w.logs)[0]).toContain('"via":"startQualifierTournament"');
    // A second seating with no voice room: nothing (idempotent).
    m.detachSocketFromOtherTables(s, 'QOV', 'seat', 'qualifierReentry');
    expect(w.of('S1', 'voiceForcedOff')).toHaveLength(1);
  });

  it('CONTROLS — seated at a cash / Sit & Go table, or only SPECTATING a qualifier table: the voice room is kept, nothing told', () => {
    const { w, m } = detachWorld();
    const s = w.mkSocket('S1', 1);
    s.join('voice_C1');
    m.detachSocketFromOtherTables(s, 'C1', 'seat', 'joinTable');
    m.detachSocketFromOtherTables(s, 'SG1', 'seat', 'startTournamentGame');
    m.detachSocketFromOtherTables(s, 'QS1', 'spectate', 'spectate');
    expect(s.rooms.has('voice_C1')).toBe(true);
    expect(w.of('S1', 'voiceForcedOff')).toEqual([]);
    expect(m.qualifierVoiceOff.voiceForcedOff).toBe(0);
  });

  it('a rebalance move onto a qualifier table (moveTournamentSeatPointers): the main and the extra-table session sockets are forced out; a Sit & Go move keeps voice', () => {
    const w = world();
    const code = `${HELP}\n${fnSrc('function moveTournamentSeatPointers(')}`;
    const { exports: m } = load(code, {
      ...w.scope, reservedSeats: new Map(), lastSentState: new Map(), lastSentJson: new Map(),
      tournamentHandStartSafety: { reconnectedSessionsMoved: 0, reservationsMoved: 0 }, noteAbsentTournamentSeatMoved() {}, carryAwayStateOnMove() {},
    }, '{ moveTournamentSeatPointers, qualifierVoiceOff }');
    // A qualifier table broken into another of the same event: tables QB (a qualifier table) → QOV.
    w.tables.set('QB', w.tables.get('QS1')!);
    w.tournamentTables.set('QB', w.qtid);
    const s = w.mkSocket('S1', 1);
    w.seat(s, 'QB', 0);
    s.join('voice_C1');                                // joined at a cash table before (an older client)
    const extra = w.mkSocket('S2', 2);
    w.seat(extra, 'C1', 0);
    extra.join('voice_C1');
    w.multiTableSessions.set('S2', [{ socketId: 'S2', tableId: 'QB', seatIndex: 1 }]);
    m.moveTournamentSeatPointers({ playerId: 'p', socketId: 'S1' }, 'QB', 0, 'QOV', 4, w.qtid);
    m.moveTournamentSeatPointers(undefined, 'QB', 1, 'QOV', 5, w.qtid);
    for (const sock of [s, extra]) expect(sock.rooms.has('voice_C1')).toBe(false);
    expect(w.of('S1', 'voiceForcedOff')).toEqual([{ code: CODE, tableId: 'QOV', message: TEXT }]);
    expect(w.of('S2', 'voiceForcedOff')).toEqual([{ code: CODE, tableId: 'QOV', message: TEXT }]);
    expect(m.qualifierVoiceOff.voiceForcedOff).toBe(2);
    // CONTROL — a Sit & Go move.
    w.tables.set('SG2', w.tables.get('SG1')!);
    w.tournamentTables.set('SG2', w.sng);
    const g = w.mkSocket('S3', 3);
    w.seat(g, 'SG1', 0);
    g.join('voice_SG1');
    m.moveTournamentSeatPointers({ playerId: 'q', socketId: 'S3' }, 'SG1', 0, 'SG2', 2, w.sng);
    expect(g.rooms.has('voice_SG1')).toBe(true);
    expect(w.of('S3', 'voiceForcedOff')).toEqual([]);
  });
});

describe('V3 — every gameState carries voiceChatAllowed (false at a qualifier table)', () => {
  it('start + overflow table → false; Sit & Go and cash → true; seated and spectator frames alike', () => {
    const w = world();
    const code = HELP + fnSrc('function getGameStateForPlayer(');
    const { exports: m } = load(code, {
      ...w.scope, progressionManager: { getProgress: () => null, equippedTheme: () => null },
      getVariantInfo: () => ({ variant: 'texas-holdem', variantName: "Texas Hold'em", holeCardCount: 2, hasDrawPhase: false, isStudGame: false }),
      turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
      MAX_SEATS: 9, GamePhase, cardToString: (c: any) => `${c.rank}${c.suit}`,
      getFullTrainingData: () => null,
    }, '{ getGameStateForPlayer }');
    for (const id of ['QS1', 'QOV', 'SG1', 'C1']) expect(w.tables.get(id)!.startNewHand()).toBe(true);
    const want: Record<string, boolean> = { QS1: false, QOV: false, SG1: true, C1: true };
    for (const id of Object.keys(want)) {
      for (const seat of [0, -1]) {
        const st = m.getGameStateForPlayer(w.tables.get(id)!, seat, false);
        expect({ id, seat, has: 'voiceChatAllowed' in st, v: st.voiceChatAllowed }).toEqual({ id, seat, has: true, v: want[id] });
      }
    }
  });
});

describe('V4 — wiring: the checks sit where the design puts them; health and manifest', () => {
  it('voiceJoin asks before any join; detach (kind seat) and both rebalance move loops force voice off; health voiceOff; tokens', () => {
    const join = handlerSrc('voiceJoin', '\n  });\n');
    const check = join.indexOf('qualifierIdOfTable(data.tableId) || socketAtQualifierTable(socket)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(join.indexOf('socket.join(room)'));
    expect(fnSrc('function detachSocketFromOtherTables(')).toContain("if (kind === 'seat') forceVoiceOffAtQualifierTable(socket, tableId, via);");
    const move = fnSrc('function moveTournamentSeatPointers(');
    expect(move).toContain("forceVoiceOffAtQualifierTable(sock, toTableId, 'rebalanceMove')");
    expect(move).toContain("forceVoiceOffAtQualifierTable(sock, toTableId, 'rebalanceMoveExtraSeat')");
    expect(fnSrc('function getGameStateForPlayer(')).toContain('stateObj.voiceChatAllowed = !stateQualifierId;');
    expect(SRC).toContain('voiceOff: { ...qualifierVoiceOff },');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['voice_off_qualifier', 'voice_refused_at_qualifier', 'voiceForcedOff', 'voiceChatAllowed']) expect(manifest).toContain(tok);
  });
});

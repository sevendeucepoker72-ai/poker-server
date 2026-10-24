/**
 * 2026-10-24 (owner 2026-10-23: "Turn all off") — NO HELP TOOLS AT A QUALIFIER
 * TABLE, server side. poker-3d already hides them (src/utils/qualifierHelpTools.js);
 * the server now refuses every server-computed decision aid at any table of a
 * qualifier (start + overflow tables, seated or watching), with the stable code
 * `help_tools_off_qualifier`:
 *  - toggleTraining is refused (`trainingToggled {enabled:false, refused:true, code}`)
 *    and the session flag forced off; a session moved onto a qualifier table has it
 *    cleared;
 *  - getGameStateForPlayer never stamps trainingData at a qualifier table, whatever
 *    the session flag says, and every frame carries `isQualifier` + `qualifierId`;
 *  - the coachWhisper relay is refused when the sender OR the student is at one;
 *  - coachHand and requestSessionRecap (LLM) are refused before any rate-limit stamp
 *    or Anthropic client;
 *  - tableCommentary is never generated for a qualifier table.
 * Cash and non-qualifier tables are unchanged (the controls).
 *
 * The REAL index.ts source (sliced) on the REAL PokerTable / TournamentManager.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { SRC, slice, fnSrc, handlerSrc, load, flush, SEAT_SESSION_FOR_SRC } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const QS: Record<string, any> = require('../src/game/qualifierSchedule');

const CODE_OFF = 'help_tools_off_qualifier';
const OFF_TEXT = 'Help tools are off in qualifier tournaments.';
const HELP = [
  slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  fnSrc('function qualifierOfTournament('),
  slice('// ===== Help tools off at qualifier tables', '// ===== end help tools off =====\n'),
].join('\n');

/**
 * A running QUALIFIER (start table QS1 + overflow table QOV), a running Sit & Go
 * (SG1) and a cash table (C1), two seats each; sockets with rooms.
 */
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
  const mkSocket = (id: string, userId: number) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers, rooms: new Set<string>([id]),
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      emit: (ev: string, p: any) => emitted.push([id, ev, p]),
      join(r: string) { s.rooms.add(r); }, leave(r: string) { s.rooms.delete(r); },
    };
    sockets.set(id, s);
    authSessions.set(id, { userId, username: `u${userId}`, masterUserId: `m-${userId}` });
    return s;
  };
  /** Seated at `tableId` seat `seat` (main session), in that table's room. */
  const seat = (s: any, tableId: string, seatIndex: number, extra: Record<string, unknown> = {}) => {
    playerSessions.set(s.id, { socketId: s.id, tableId, seatIndex, playerName: `${tableId}-x`, playerId: `${tableId}-p`, trainingEnabled: false, sittingOut: false, ...extra });
    s.join(`table:${tableId}`);
  };
  const of = (sid: string, ev: string) => emitted.filter(([s, e]) => s === sid && e === ev).map(([, , p]) => p);
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, SEAT_RESERVE_MS: 6 * 3600_000,
    tableManager: { getTable: (id: string) => tables.get(id) },
    playerSessions, multiTableSessions, authSessions,
    io: { sockets: { sockets }, to: () => ({ emit() {} }) },
    QUALIFIER_HELP_TOOLS_OFF_TEXT: QS.QUALIFIER_HELP_TOOLS_OFF_TEXT,
    console: { log: (...a: any[]) => logs.push(a.join(' ')), warn() {}, error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`) },
  };
  return { tm, qtid, sng, tables, tournamentTables, qualifierTournaments, playerSessions, multiTableSessions, authSessions, sockets, emitted, logs, scope, mkSocket, seat, of };
}
const refusedLines = (logs: string[], tool: string) => logs.filter((l) => l.includes('"event":"help_tools_refused_at_qualifier"') && l.includes(`"tool":"${tool}"`));

describe('the help-tools helpers: which table / socket is at a qualifier', () => {
  it('qualifierIdOfTable: the start table and an overflow table → the qualifier id; a Sit & Go and a cash table → null; socketAtQualifierTable: seated, on an extra seat, or only watching (the table room)', () => {
    const w = world();
    const { exports: m } = load(HELP, w.scope, '{ qualifierIdOfTable, socketAtQualifierTable, qualifierHelpToolsOff }');
    expect(['QS1', 'QOV', 'SG1', 'C1', 'nope', ''].map((id) => m.qualifierIdOfTable(id))).toEqual(['Q-weekly', 'Q-weekly', null, null, null, null]);
    const seated = w.mkSocket('S1', 1); w.seat(seated, 'QS1', 0);
    const extra = w.mkSocket('S2', 2); w.seat(extra, 'C1', 0); w.multiTableSessions.set('S2', [{ socketId: 'S2', tableId: 'QOV', seatIndex: 1 }]);
    const watching = w.mkSocket('S3', 3); watching.join('table:QS1');
    const cash = w.mkSocket('S4', 4); w.seat(cash, 'C1', 1); cash.join('table:SG1');
    expect([seated, extra, watching, cash].map((s) => m.socketAtQualifierTable(s))).toEqual(['Q-weekly', 'Q-weekly', 'Q-weekly', null]);
    expect(m.qualifierHelpToolsOff).toEqual({ trainingRefused: 0, sessionsForcedOff: 0, whispersRefused: 0, coachRefused: 0, recapRefused: 0, commentarySkipped: 0 });
    expect(QS.QUALIFIER_HELP_TOOLS_OFF_TEXT).toBe(OFF_TEXT);
    expect(/^[\x20-\x7e]+$/.test(QS.QUALIFIER_HELP_TOOLS_OFF_TEXT)).toBe(true);
  });
});

describe('HT1 — toggleTraining is refused at a qualifier table (the session flag forced off, no training frame); a cash table is unchanged', () => {
  function wired(w: ReturnType<typeof world>) {
    const code = `${HELP}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${handlerSrc('toggleTraining', '\n  });\n')}\n}`;
    const scope = { ...w.scope, getGameStateForPlayer: (_t: unknown, seatIndex: number, training: boolean) => ({ seatIndex, training, trainingData: training ? { equity: 0.5 } : undefined }) };
    return load(code, scope, '{ wire, qualifierHelpToolsOff }');
  }
  it('qualifier start table + overflow extra seat: trainingToggled {enabled:false, refused:true, code}, flag false, no gameState; cash: enabled, the frame carries trainingData (9c37499: enabled at the qualifier table too)', async () => {
    const w = world();
    const { exports: m, stubbed } = wired(w);
    const s = w.mkSocket('S1', 1);
    w.seat(s, 'QS1', 0, { trainingEnabled: true });                          // a flag left on from before
    m.wire(s);
    await s.handlers.toggleTraining({ tableId: 'QS1' });
    expect(w.of('S1', 'trainingToggled')).toEqual([{ enabled: false, tableId: 'QS1', refused: true, code: CODE_OFF, message: OFF_TEXT }]);
    expect(w.playerSessions.get('S1').trainingEnabled).toBe(false);
    await s.handlers.toggleTraining({ tableId: 'QS1' });                     // a second tap: still off
    expect(w.playerSessions.get('S1').trainingEnabled).toBe(false);
    expect(w.of('S1', 'gameState')).toEqual([]);
    // An EXTRA seat at the qualifier's overflow table: the same.
    const extra = { socketId: 'S1', tableId: 'QOV', seatIndex: 1, trainingEnabled: false };
    w.multiTableSessions.set('S1', [extra]);
    await s.handlers.toggleTraining({ tableId: 'QOV' });
    expect(extra.trainingEnabled).toBe(false);
    expect(w.of('S1', 'trainingToggled').slice(-1)[0]).toMatchObject({ enabled: false, refused: true, code: CODE_OFF, tableId: 'QOV' });
    expect(m.qualifierHelpToolsOff.trainingRefused).toBe(3);
    expect(refusedLines(w.logs, 'training')).toHaveLength(3);
    // CONTROL — a cash table: enabled, and the frame carries trainingData.
    const c = w.mkSocket('S2', 2);
    w.seat(c, 'C1', 1);
    m.wire(c);
    await c.handlers.toggleTraining({ tableId: 'C1' });
    expect(w.of('S2', 'trainingToggled')).toEqual([{ enabled: true, tableId: 'C1' }]);
    expect(w.of('S2', 'gameState')).toEqual([expect.objectContaining({ training: true, trainingData: { equity: 0.5 } })]);
    expect([...stubbed].filter((n) => /qualifier|Qualifier|tournamentIdOfTable/.test(n))).toEqual([]);
  });
});

describe('HT2 — getGameStateForPlayer never stamps trainingData at a qualifier table and always says isQualifier / qualifierId', () => {
  function stateFn(w: ReturnType<typeof world>) {
    const code = HELP + fnSrc('function getGameStateForPlayer(');
    return load(code, {
      ...w.scope, progressionManager: { getProgress: () => null, equippedTheme: () => null },
      getVariantInfo: () => ({ variant: 'texas-holdem', variantName: "Texas Hold'em", holeCardCount: 2, hasDrawPhase: false, isStudGame: false }),
      turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
      MAX_SEATS: 9, GamePhase, cardToString: (c: any) => `${c.rank}${c.suit}`,
      getFullTrainingData: () => ({ handStrength: 0.42 }),
    }, '{ getGameStateForPlayer }');
  }
  it('trainingEnabled=true mid-hand: start + overflow table → no trainingData, isQualifier true, qualifierId; Sit & Go and cash → trainingData, isQualifier false, qualifierId null (9c37499: trainingData at the qualifier table, no isQualifier)', () => {
    const w = world();
    const { exports: m } = stateFn(w);
    for (const id of ['QS1', 'QOV', 'SG1', 'C1']) expect(w.tables.get(id)!.startNewHand()).toBe(true);
    const st = (id: string) => m.getGameStateForPlayer(w.tables.get(id)!, 0, true);
    for (const id of ['QS1', 'QOV']) {
      const s = st(id);
      expect({ id, trainingData: s.trainingData, isQualifier: s.isQualifier, qualifierId: s.qualifierId, isTournament: s.isTournament })
        .toEqual({ id, trainingData: undefined, isQualifier: true, qualifierId: 'Q-weekly', isTournament: true });
    }
    for (const id of ['SG1', 'C1']) {
      const s = st(id);
      expect({ id, trainingData: s.trainingData, isQualifier: s.isQualifier, qualifierId: s.qualifierId })
        .toEqual({ id, trainingData: { handStrength: 0.42 }, isQualifier: false, qualifierId: null });
    }
    // A spectator frame says so too.
    expect(m.getGameStateForPlayer(w.tables.get('QS1')!, -1, false)).toMatchObject({ isQualifier: true, qualifierId: 'Q-weekly' });
  });
});

describe('HT3 — the coachWhisper relay is refused when the sender OR the student is at a qualifier table', () => {
  function wired(w: ReturnType<typeof world>) {
    const code = `${HELP}\n${fnSrc('function relayPeerSharingRoom(')}\nfunction wire(socket) {\n${handlerSrc('coachWhisper', '\n  });\n')}\n}`;
    return load(code, { ...w.scope, publicNameForUser: async () => 'Coach' }, '{ wire, qualifierHelpToolsOff }');
  }
  it('cash sender → student watching a qualifier table / seated there on an extra seat: not relayed, the sender gets error {code, event}; a qualifier sender → a cash student: refused; cash → cash: relayed (9c37499: relayed)', async () => {
    const w = world();
    const { exports: m } = wired(w);
    const coach = w.mkSocket('SC', 1); w.seat(coach, 'C1', 0); coach.join('table:QS1'); coach.join('table:C1');
    m.wire(coach);
    const watcher = w.mkSocket('SW', 2); watcher.join('table:QS1'); watcher.join('table:C1');   // watching the qualifier (and in the cash room)
    await coach.handlers.coachWhisper({ targetSocketId: 'SW', message: 'raise here' });
    expect(w.of('SW', 'coachWhisper')).toEqual([]);
    expect(w.of('SC', 'error')).toEqual([{ code: CODE_OFF, message: OFF_TEXT, event: 'coachWhisper' }]);
    const extra = w.mkSocket('SX', 3); w.seat(extra, 'C1', 1); w.multiTableSessions.set('SX', [{ socketId: 'SX', tableId: 'QOV', seatIndex: 0 }]);
    await coach.handlers.coachWhisper({ targetSocketId: 'SX', message: 'fold' });
    expect(w.of('SX', 'coachWhisper')).toEqual([]);
    // A sender seated at the qualifier table whispering into a shared cash room.
    const qcoach = w.mkSocket('SQ', 4); w.seat(qcoach, 'QS1', 1); qcoach.join('table:C1');
    m.wire(qcoach);
    const cashStudent = w.mkSocket('SS', 5); w.seat(cashStudent, 'C1', 2);
    await qcoach.handlers.coachWhisper({ targetSocketId: 'SS', message: 'call' });
    expect(w.of('SS', 'coachWhisper')).toEqual([]);
    expect(w.of('SQ', 'error')).toEqual([expect.objectContaining({ code: CODE_OFF })]);
    expect(m.qualifierHelpToolsOff.whispersRefused).toBe(3);
    // CONTROL — cash to cash.
    const coach2 = w.mkSocket('SC2', 6); w.seat(coach2, 'C1', 3);
    m.wire(coach2);
    await coach2.handlers.coachWhisper({ targetSocketId: 'SS', message: 'nice hand' });
    expect(w.of('SS', 'coachWhisper')).toEqual([{ message: 'nice hand', coachName: 'Coach' }]);
  });
});

describe('HT4 — coachHand and requestSessionRecap (LLM aids) are refused at a qualifier table before the rate limit or any Anthropic client', () => {
  function wired(w: ReturnType<typeof world>, made: string[]) {
    class Anthropic {
      messages: any;
      constructor() {
        made.push('client');
        this.messages = { create: async () => ({ content: [{ type: 'text', text: '{"score": 7, "summary": "ok", "decisions": [], "keyLesson": "x"}\n\nb\n\nc' }] }) };
      }
    }
    const code = `${HELP}\nfunction wire(socket) {\n  const coachLastRequest = new Map();\n${handlerSrc('coachHand', '\n  });\n')}\n  const recapLastRequest = new Map();\n${handlerSrc('requestSessionRecap', '\n  });\n')}\n}`;
    return load(code, { ...w.scope, process: { env: { ANTHROPIC_API_KEY: 'k' } }, Anthropic }, '{ wire, qualifierHelpToolsOff }');
  }
  const HAND = { handHistory: { players: [{ name: 'P', actions: ['call'] }], communityCards: [], winners: [] }, playerName: 'P' };
  const STATS = { handsPlayed: 10, netChips: 100, winRate: 50, biggestPot: 500, sessionMinutes: 20 };
  it('seated at / watching a qualifier table: coachResult {error, code} and sessionRecapResult {success:false, code}, no client made; moved to a cash table, the next request goes through AT ONCE (no rate-limit stamp was taken) (9c37499: answered)', async () => {
    const w = world();
    const made: string[] = [];
    const { exports: m } = wired(w, made);
    const s = w.mkSocket('S1', 1);
    w.seat(s, 'QS1', 0);
    m.wire(s);
    await s.handlers.coachHand(HAND);
    await s.handlers.requestSessionRecap(STATS);
    expect(w.of('S1', 'coachResult')).toEqual([{ error: OFF_TEXT, code: CODE_OFF }]);
    expect(w.of('S1', 'sessionRecapResult')).toEqual([{ success: false, code: CODE_OFF, error: OFF_TEXT }]);
    expect(made).toEqual([]);
    // Only watching the qualifier table: refused too.
    const watcher = w.mkSocket('S2', 2);
    watcher.join('table:QOV');
    m.wire(watcher);
    await watcher.handlers.coachHand(HAND);
    expect(w.of('S2', 'coachResult')).toEqual([{ error: OFF_TEXT, code: CODE_OFF }]);
    expect(m.qualifierHelpToolsOff).toMatchObject({ coachRefused: 2, recapRefused: 1 });
    // He leaves for a cash table: the next requests are answered at once.
    s.leave('table:QS1');
    w.seat(s, 'C1', 0);
    await s.handlers.coachHand(HAND);
    await s.handlers.requestSessionRecap(STATS);
    expect(w.of('S1', 'coachResult').slice(-1)[0]).toMatchObject({ success: true, analysis: expect.objectContaining({ score: 7 }) });
    expect(w.of('S1', 'sessionRecapResult').slice(-1)[0]).toMatchObject({ success: true });
    expect(made).toEqual(['client', 'client']);
  });
});

describe('HT5 — tableCommentary is never generated for a qualifier table', () => {
  const BLOCK = slice('    // 2026-07-07 gap-fill [7] — LLM table commentary.', '    } catch { /* commentary is best-effort — never let it disrupt the hand */ }\n');
  function commentaryWorld(w: ReturnType<typeof world>) {
    const created: string[] = [];
    class Anthropic { messages = { create: async () => { created.push('create'); return { content: [{ type: 'text', text: 'What a pot!' }] }; } }; }
    const roomEmits: Array<[string, string, any]> = [];
    const code = `${HELP}\nfunction commentary(table, tableId, data) {\n${BLOCK}\n}`;
    const { exports: m } = load(code, {
      ...w.scope, process: { env: { ANTHROPIC_API_KEY: 'k' } }, Anthropic, tableCommentaryLastEmit: new Map(), TABLE_COMMENTARY_MIN_INTERVAL_MS: 0,
      io: { to: (r: string) => ({ emit: (ev: string, d: any) => roomEmits.push([r, ev, d]) }) },
    }, '{ commentary, qualifierHelpToolsOff }');
    return { m, created, roomEmits };
  }
  it('a notable hand at the qualifier start table and its overflow table: 0 model calls, nothing emitted; at a cash table: 1 call, the line emitted (9c37499: called at the qualifier table)', async () => {
    const w = world();
    const x = commentaryWorld(w);
    const notable = { results: [{ playerName: 'A', chipsWon: 5000, handName: 'Flush' }] };
    x.m.commentary(w.tables.get('QS1'), 'QS1', notable);
    x.m.commentary(w.tables.get('QOV'), 'QOV', notable);
    await flush();
    expect(x.created).toEqual([]);
    expect(x.roomEmits).toEqual([]);
    expect(x.m.qualifierHelpToolsOff.commentarySkipped).toBe(2);
    x.m.commentary(w.tables.get('C1'), 'C1', notable);
    await flush();
    expect(x.created).toEqual(['create']);
    expect(x.roomEmits).toEqual([['table:C1', 'tableCommentary', { text: 'What a pot!', type: 'llm' }]]);
  });
});

describe('HT6 — a session moved onto a qualifier table has training cleared (moveTournamentSeatPointers)', () => {
  it('a rebalance move to a qualifier table clears trainingEnabled on the main and the extra-table session; a move between non-qualifier tournament tables keeps it', () => {
    const w = world();
    const code = `${HELP}\n${fnSrc('function moveTournamentSeatPointers(')}`;
    const { exports: m } = load(code, {
      ...w.scope, reservedSeats: new Map(), lastSentState: new Map(), lastSentJson: new Map(),
      tournamentHandStartSafety: { reconnectedSessionsMoved: 0, reservationsMoved: 0 }, noteAbsentTournamentSeatMoved() {},
    }, '{ moveTournamentSeatPointers, qualifierHelpToolsOff }');
    const s = w.mkSocket('S1', 1);
    w.seat(s, 'QS1', 0, { trainingEnabled: true });
    const extra = w.mkSocket('S2', 2);
    w.seat(extra, 'C1', 0);
    const ms = { socketId: 'S2', tableId: 'QS1', seatIndex: 1, trainingEnabled: true };
    w.multiTableSessions.set('S2', [ms]);
    m.moveTournamentSeatPointers({ playerId: 'p', socketId: 'S1' }, 'QS1', 0, 'QOV', 4, w.qtid);
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 'QOV', seatIndex: 4, trainingEnabled: false });
    m.moveTournamentSeatPointers(undefined, 'QS1', 1, 'QOV', 5, w.qtid);
    expect(ms).toMatchObject({ tableId: 'QOV', seatIndex: 5, trainingEnabled: false });
    expect(m.qualifierHelpToolsOff.sessionsForcedOff).toBe(2);
    // CONTROL — a Sit & Go move keeps the player's own choice.
    w.tables.set('SG2', w.tables.get('SG1')!);
    w.tournamentTables.set('SG2', w.sng);
    const t = w.mkSocket('S3', 3);
    w.seat(t, 'SG1', 0, { trainingEnabled: true });
    m.moveTournamentSeatPointers({ playerId: 'q', socketId: 'S3' }, 'SG1', 0, 'SG2', 2, w.sng);
    expect(w.playerSessions.get('S3')).toMatchObject({ tableId: 'SG2', trainingEnabled: true });
  });
});

describe('HT7 — wiring: every handler asks, the health keys, the manifest tokens', () => {
  it('the checks sit where the design puts them', () => {
    expect(handlerSrc('toggleTraining', '\n  });\n')).toContain('qualifierIdOfTable(session.tableId)');
    const coach = handlerSrc('coachHand', '\n  });\n');
    expect(coach.indexOf('socketAtQualifierTable(socket)')).toBeGreaterThan(-1);
    expect(coach.indexOf('socketAtQualifierTable(socket)')).toBeLessThan(coach.indexOf('Payload size cap'));
    const recap = handlerSrc('requestSessionRecap', '\n  });\n');
    expect(recap.indexOf('socketAtQualifierTable(socket)')).toBeLessThan(recap.indexOf('recapLastRequest.set('));
    expect(handlerSrc('coachWhisper', '\n  });\n')).toContain('socketAtQualifierTable(student)');
    expect(fnSrc('function getGameStateForPlayer(')).toContain('!stateQualifierId &&');
    expect(SRC).toContain('helpToolsOff: { ...qualifierHelpToolsOff },');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['help_tools_off_qualifier', 'help_tools_refused_at_qualifier']) expect(manifest).toContain(tok);
  });
});

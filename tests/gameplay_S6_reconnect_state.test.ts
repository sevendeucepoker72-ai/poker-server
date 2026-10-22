/**
 * 2026-10-21 — gameplay audit, server cluster S6: reconnect / restore /
 * reservations, state deltas and privacy. (The sign-in / disconnect fixes —
 * F46, F80, F87's restore, F89, F77, G183, G184 — run in the absentSeat.test.ts
 * harness, block "S6"; F21's queue also in showMuckedHand.test.ts.)
 *   G174 a new-hand delta always carries yourCards (same two cards as last hand)
 *   F60  a leave drops the socket's delta baseline: the next table's frame is full
 *   F155 syncTableState / requestState watch a table the socket has no seat at,
 *        close a table that is gone, notice a released seat; a seated socket is
 *        never also that table's spectator
 *   G181 every seat carries `sittingOut` (the AWAY badge), broadcast at once
 *   G182 `maxSeats`; moveSeat refuses a seat past the cap; a failed / cancelled
 *        move is always answered moveSeatCancelled
 *   F87  sitOut {sittingOut:boolean} SETS the state (a repeat is 'unchanged')
 *   F21  a folded seat's Show Hand mid-hand is queued, revealed at the hand's end
 *   F82  a rejoin (joinTable) restores the account's reservation at that table
 *   G189 a dead socket's queued seat move never runs
 *   F88  seatVacated is sent after the session ended and the room was left
 * Every test runs the REAL src/index.ts text (sliced + transpiled — index.ts
 * boots a server on import) against the REAL PokerTable engine; each fix has a
 * CONTROL that runs the pre-fix text and shows the defect.
 */
import fs from 'fs';
import path from 'path';
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { cardToString } from '../src/game/Card';
import {
  SRC, slice, fnSrc, handlerSrc, load, flush, deferred,
  SEAT_TEARDOWN_SRC, SEAT_SESSION_FOR_SRC, SEAT_RESTORE_SRC, MUCK_SHOWS_SRC, JOIN_PRECHECK_SRC,
} from './helpers/indexSource';
import { installSocketListenerGuard, socketGuardStats } from '../src/socketGuard';

const quiet ={ log() {}, warn() {}, error() {} };
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const cfg = (tableId: string, over: Record<string, unknown> = {}) =>
  ({ tableId, tableName: tableId, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxPlayers: 9, ...over } as any);

function fakeSocket(id: string) {
  const emitted: Array<[string, any]> = [];
  const handlers: Record<string, (...a: any[]) => any> = {};
  const rooms = new Set<string>([id]);
  return {
    id, emitted, handlers, rooms, connected: true, handshake: { address: '10.0.0.1' },
    on: (ev: string, fn: any) => { handlers[ev] = fn; },
    listeners: (ev: string) => (handlers[ev] ? [handlers[ev]] : []),
    emit: (ev: string, d: any) => { emitted.push([ev, d]); },
    join: (r: string) => { rooms.add(r); },
    leave: (r: string) => { rooms.delete(r); },
  };
}
type FakeSocket = ReturnType<typeof fakeSocket>;
const events = (s: FakeSocket, ev: string) => s.emitted.filter(([e]) => e === ev).map(([, d]) => d);

/** Replace `from` (which must be present) in a source slice — the CONTROLs' pre-fix text. */
function without(src: string, from: string, to = ''): string {
  expect(src).toContain(from);
  return src.split(from).join(to);
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// ══════════════════════════════════════════════════════════════════ G174 ══
describe('G174 — a delta that starts a new hand always carries the hero\'s cards (dealt the same two cards again)', () => {
  const EMIT_PARTS = [
    slice('function shallowDiff(', '\n}\n'),
    slice('const ALWAYS_EMIT_KEYS = [', '];\n'),
    fnSrc('function pickAlwaysEmit('),
  ].join('\n');
  const EMIT = fnSrc('function emitGameState(');
  const G174_BLOCK = slice('    if (state && state.handNumber !== prev.handNumber) {', '\n    }\n');
  function emitter(emitSrc: string) {
    const lastSentState = new Map<string, any>();
    const lastSentJson = new Map<string, any>();
    const { exports: m } = load(`${EMIT_PARTS}\n${emitSrc}`, { lastSentState, lastSentJson }, '{ emitGameState }');
    const sock = fakeSocket('S');
    return { emit: (state: any, full = false) => m.emitGameState(sock, state, full), sock };
  }
  const cards = [{ suit: 's', rank: 13, display: 'Ks' }, { suit: 'c', rank: 13, display: 'Kc' }];
  const frame = (handNumber: number, phase: string, extra: Record<string, unknown> = {}) => ({
    tableId: 'T', handNumber, phase, activeSeatIndex: 0, yourSeat: 0, yourCards: cards, pot: 75, ...extra,
  });

  it('hand N (KsKc) → hand N+1 dealt KsKc again: the new-hand delta CONTAINS yourCards (and the client keeps its cards)', () => {
    const e = emitter(EMIT);
    e.emit(frame(7, 'HandComplete'), true);
    e.emit(frame(8, 'PreFlop'));
    const last = e.sock.emitted[e.sock.emitted.length - 1][1];
    expect(last.full).toBe(false);
    expect(last.delta.handNumber).toBe(8);
    expect(last.delta.yourCards).toEqual(cards);
    // …a delta within the same hand still leaves an unchanged yourCards out (absent = unchanged).
    e.emit(frame(8, 'PreFlop', { pot: 175 }));
    const next = e.sock.emitted[e.sock.emitted.length - 1][1];
    expect(next.delta).not.toHaveProperty('yourCards');
  });

  it('Stud: yourCardVisibility rides along too; a spectator\'s new hand carries yourCards: []', () => {
    const e = emitter(EMIT);
    const vis = [{ card: cards[0], faceUp: false }];
    e.emit({ ...frame(3, 'HandComplete'), yourCardVisibility: vis }, true);
    e.emit({ ...frame(4, 'ThirdStreet'), yourCardVisibility: vis });
    expect(e.sock.emitted[1][1].delta).toMatchObject({ yourCards: cards, yourCardVisibility: vis });
    const sp = emitter(EMIT);
    sp.emit({ ...frame(3, 'HandComplete'), yourSeat: -1, yourCards: [] }, true);
    sp.emit({ ...frame(4, 'PreFlop'), yourSeat: -1, yourCards: [] });
    expect(sp.sock.emitted[1][1].delta.yourCards).toEqual([]);
  });

  it('CONTROL — pre-G174: the new-hand delta leaves the identical yourCards out (the client wiped them: no cards, no action bar)', () => {
    const e = emitter(without(EMIT, G174_BLOCK, '').replace('let delta = shallowDiff(', 'const delta = shallowDiff('));
    e.emit(frame(7, 'HandComplete'), true);
    e.emit(frame(8, 'PreFlop'));
    const last = e.sock.emitted[1][1];
    expect(last.delta.handNumber).toBe(8);
    expect(last.delta).not.toHaveProperty('yourCards');
  });
});

// ══════════════════════════════════════════════════════════════════ F60 ══
describe('F60 — a leave drops the socket\'s delta baseline: the next frame (any table) is a FULL one', () => {
  const EMIT_SRC = [
    slice('function shallowDiff(', '\n}\n'), slice('const ALWAYS_EMIT_KEYS = [', '];\n'),
    fnSrc('function pickAlwaysEmit('), fnSrc('function emitGameState('),
  ].join('\n');
  const LEAVE = fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind');
  const DROP = '  lastSentState.delete(socket.id);\n  lastSentJson.delete(socket.id);\n\n  // #12 (2026-07-01 audit)';
  function world(leaveSrc: string) {
    const table = new PokerTable(cfg('A'));
    for (let i = 0; i < 3; i++) expect(table.sitDown(i, `P${i}`, 5000, `p${i}`, i > 0)).toBe(true);
    const playerSessions = new Map<string, any>([['S', { socketId: 'S', tableId: 'A', seatIndex: 0, playerName: 'P0', playerId: 'p0', sittingOut: false }]]);
    const lastSentState = new Map<string, any>();
    const lastSentJson = new Map<string, any>();
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 'A' ? table : undefined) }, playerSessions, lastSentState, lastSentJson,
      authSessions: new Map([['S', { userId: 1, username: 'u1' }]]), multiTableSessions: new Map(), spectators: new Map(),
      settleDecidedQuickGame() {}, leavePrizeFormatSeat: () => false, keepTournamentSeatOnLeave: () => false,
      sitOutTracker: new Map(), syncSitOutToTable() {}, teardownSeat: () => 'stood_up', pendingSeatRemovalAfterHand: new Map(),
      stripBotsWhenNoHumans() {}, botStripAfterHand: new Set(), broadcastGameState() {}, releaseSeatedSlot() {},
      quickTables: new Set(), lastEmoteTime: new Map(), lastReactionTime: new Map(), lastChatTime: new Map(), console: quiet,
    };
    const { exports: m } = load(`${EMIT_SRC}\n${leaveSrc}`, scope, '{ emitGameState, handlePlayerLeave }');
    const sock = fakeSocket('S');
    return { m, sock, lastSentState };
  }
  const frameA = (pot: number) => ({ tableId: 'A', handNumber: 5, phase: 'PreFlop', yourSeat: 0, bigBlind: 50, currentBetToMatch: 50, pot, yourCards: [] });

  it('seat 0 at A → Back to Lobby → seated at A again (a quick-play / waitlist pick): its first frame is FULL (yourSeat, blinds, bet to match all present)', () => {
    const w = world(LEAVE);
    w.m.emitGameState(w.sock, frameA(75), true);
    w.m.handlePlayerLeave(w.sock);
    expect(w.lastSentState.has('S')).toBe(false);
    w.m.emitGameState(w.sock, frameA(75));
    const f = w.sock.emitted[1][1];
    expect(f.full).toBe(true);
    expect(f.state).toMatchObject({ yourSeat: 0, bigBlind: 50, currentBetToMatch: 50 });
  });

  it('CONTROL — pre-F60 (the leave kept the baseline): the next frame for the same table is a FRAGMENT — yourSeat, blinds and the bet to match left out', () => {
    const w = world(without(LEAVE, DROP, '  // #12 (2026-07-01 audit)'));
    w.m.emitGameState(w.sock, frameA(75), true);
    w.m.handlePlayerLeave(w.sock);
    expect(w.lastSentState.has('S')).toBe(true);
    w.m.emitGameState(w.sock, frameA(75));
    const f = w.sock.emitted[1][1];
    expect(f.full).toBe(false);
    expect(f.delta).not.toHaveProperty('yourSeat');
    expect(f.delta).not.toHaveProperty('currentBetToMatch');
  });

  it('wiring: a frame for ANOTHER table than the baseline is always full (F64), and the leave drops the baseline after the session', () => {
    expect(fnSrc('function emitGameState(')).toContain('if (!prev || forceFullState || prev.tableId !== state?.tableId) {');
    expect(LEAVE.indexOf('lastSentState.delete(socket.id);')).toBeGreaterThan(LEAVE.indexOf('playerSessions.delete(socket.id);'));
  });
});

// ═══════════════════════════════════════════════════════════════ F155 ══
describe('F155 — a resync (syncTableState / requestState) never leaves a frozen table', () => {
  const H = {
    sync: handlerSrc('syncTableState', '\n  });\n'),
    request: handlerSrc('requestState', '\n  });\n'),
  };
  const OLD_SYNC = `socket.on('syncTableState', (data: { tableId?: string } = {}) => {
    const session = playerSessions.get(socket.id);
    const tableId = session?.tableId || data?.tableId;
    if (!tableId) return;
    const table = tableManager.getTable(tableId);
    if (!table) return;
    const state = getGameStateForPlayer(table, session?.seatIndex ?? -1, session?.trainingEnabled || false);
    emitGameState(socket, state, true);
  });
`;
  const EMIT_SRC = [
    slice('function shallowDiff(', '\n}\n'), slice('const ALWAYS_EMIT_KEYS = [', '];\n'),
    fnSrc('function pickAlwaysEmit('), fnSrc('function emitGameState('),
  ].join('\n');
  function world(sync = H.sync, wOpts: { request?: string; guard?: boolean } = {}) {
    const table = new PokerTable(cfg('A'));
    for (let i = 0; i < 3; i++) expect(table.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
    const B = new PokerTable(cfg('B'));
    expect(B.sitDown(4, 'Hero', 5000, 'hero-b', false)).toBe(true);
    const tables = new Map<string, PokerTable>([['A', table], ['B', B]]);
    const playerSessions = new Map<string, any>();
    const multiTableSessions = new Map<string, any[]>();
    const authSessions = new Map<string, any>();
    const reservedSeats = new Map<number, any>();
    const spectators = new Map<string, Set<string>>();
    const lastSentState = new Map<string, any>();
    const sockets = new Map<string, FakeSocket>();
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => tables.get(id) }, playerSessions, multiTableSessions, authSessions, reservedSeats,
      spectators, lastSentState, lastSentJson: new Map(), io: { sockets: { sockets } },
      getGameStateForPlayer: (t: PokerTable, seat: number, training?: boolean) => ({ tableId: t.config.tableId, yourSeat: seat, handNumber: t.handNumber, training: !!training }),
      releaseSeatedSlot() {}, isTournamentTable: () => false, tableViewDetaches: { calls: 0, spectatorViewsEnded: 0, roomsLeft: 0, deadSeatSessionsEnded: 0 },
      console: quiet,
    };
    const code = `${EMIT_SRC}\n${fnSrc('function detachSocketFromOtherTables(')}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${sync}\n${wOpts.request ?? H.request}\n}`;
    const { exports: m, stubbed } = load(code, scope, '{ wire }');
    const mk = (id: string) => {
      const s = fakeSocket(id);
      sockets.set(id, s);
      // S6 fix-up — the REAL listener guard index.ts installs first on every connection.
      if (wOpts.guard) installSocketListenerGuard(s, { log: () => {} });
      m.wire(s);
      return s;
    };
    return { table, B, m, stubbed, mk, playerSessions, multiTableSessions, authSessions, reservedSeats, spectators, lastSentState, sockets };
  }

  it('no seat, the table exists: he WATCHES it — spectators set, table room, isSpectator full state, \'spectating\'', () => {
    const w = world();
    const s = w.mk('S2');
    s.handlers.syncTableState({ tableId: 'A' });
    expect(w.spectators.get('A')?.has('S2')).toBe(true);
    expect(s.rooms.has('table:A')).toBe(true);
    expect(events(s, 'gameState')).toEqual([expect.objectContaining({ full: true, state: expect.objectContaining({ tableId: 'A', yourSeat: -1, isSpectator: true, spectatorCount: 1 }) })]);
    expect(events(s, 'spectating')).toEqual([{ tableId: 'A', tableName: 'A' }]);
    expect([...w.stubbed].filter((n) => /detach|spectat|Session|emitGameState/.test(n))).toEqual([]);
  });

  it('the table is gone (a redeploy): tableClosed {table_gone}; requestState with the same payload too', () => {
    const w = world();
    const s = w.mk('S2');
    s.handlers.syncTableState({ tableId: 'old-uuid' });
    s.handlers.requestState({ tableId: 'old-uuid' });
    expect(events(s, 'tableClosed')).toEqual([{ tableId: 'old-uuid', reason: 'table_gone' }, { tableId: 'old-uuid', reason: 'table_gone' }]);
    expect(events(s, 'gameState')).toEqual([]);
  });

  it('wasSeated and his seat is gone (no reservation, no seat of his account there): watching + seatReleased; with a live reservation there: no notice', () => {
    const w = world();
    const s = w.mk('S2');
    w.authSessions.set('S2', { userId: 7, username: 'u7' });
    s.handlers.syncTableState({ tableId: 'A', wasSeated: true });
    expect(events(s, 'seatReleased')).toEqual([{ tableId: 'A', reason: 'seat_released' }]);
    const w2 = world();
    const s2 = w2.mk('S3');
    w2.authSessions.set('S3', { userId: 7, username: 'u7' });
    w2.reservedSeats.set(7, { tableId: 'A', seatIndex: 1, expiresAt: Date.now() + 60_000 });
    s2.handlers.syncTableState({ tableId: 'A', wasSeated: true });
    expect(events(s2, 'seatReleased')).toEqual([]);
    expect(w2.spectators.get('A')?.has('S3')).toBe(true);
  });

  it('a seated socket: its own seat\'s full state (main = the delta baseline; an EXTRA seat named = a raw full snapshot); never made a spectator', () => {
    const w = world();
    const s = w.mk('SH');
    w.playerSessions.set('SH', { socketId: 'SH', tableId: 'A', seatIndex: 1, sittingOut: true, trainingEnabled: false });
    w.multiTableSessions.set('SH', [{ socketId: 'SH', tableId: 'B', seatIndex: 4, sittingOut: false, trainingEnabled: true }]);
    s.handlers.syncTableState({ tableId: 'A' });
    s.handlers.requestState({ tableId: 'B' });
    s.handlers.requestState({ tableId: 'Z' });                         // a table he has no seat at: his MAIN seat
    s.handlers.requestState();                                         // bare (older client): his main seat
    const frames = events(s, 'gameState');
    expect(frames.map((f) => [f.full, f.state.tableId, f.state.yourSeat])).toEqual([[true, 'A', 1], [true, 'B', 4], [true, 'A', 1], [true, 'A', 1]]);
    expect(frames[0].state.sittingOut).toBe(true);
    expect(frames[1].state.training).toBe(true);
    expect(w.lastSentState.get('SH').tableId).toBe('A');               // the extra table never became the baseline
    expect(w.spectators.size).toBe(0);
  });

  it('no seat, nothing named: nothing (a bare requestState from the lobby)', () => {
    const w = world();
    const s = w.mk('S2');
    s.handlers.requestState();
    s.handlers.syncTableState({});
    expect(s.emitted).toEqual([]);
  });

  it('CONTROL — pre-F155: one seat -1 snapshot, no room, no spectators entry (frozen); a gone table answers nothing', () => {
    const w = world(OLD_SYNC);
    const s = w.mk('S2');
    s.handlers.syncTableState({ tableId: 'A' });
    expect(s.rooms.has('table:A')).toBe(false);
    expect(w.spectators.size).toBe(0);
    expect(events(s, 'gameState')[0].state.isSpectator).toBeUndefined();
    s.handlers.syncTableState({ tableId: 'old-uuid' });
    expect(events(s, 'tableClosed')).toEqual([]);
  });

  // S6 fix-up — every LIVE client emits requestState BARE (visibility resume,
  // TableErrorBoundary). Through the REAL socket listener guard.
  describe('through the socket listener guard (installSocketListenerGuard), as index.ts registers it', () => {
    const OPTIONAL = "socket.on('requestState', (data?: { tableId?: string; wasSeated?: boolean }) => {";
    const DEFAULTED = "socket.on('requestState', (data: { tableId?: string; wasSeated?: boolean } = {}) => {";

    it('a BARE requestState on a seated socket passes the guard and is answered with his seat\'s full state (nothing rejected)', () => {
      const w = world(H.sync, { guard: true });
      const s = w.mk('SH');
      w.playerSessions.set('SH', { socketId: 'SH', tableId: 'A', seatIndex: 1, sittingOut: false, trainingEnabled: false });
      const rejectedBefore = socketGuardStats.payloadsRejected;
      s.handlers.requestState();
      s.handlers.requestState({ tableId: 'A' });
      expect(socketGuardStats.payloadsRejected).toBe(rejectedBefore);
      expect(events(s, 'gameState').map((f) => [f.full, f.state.tableId, f.state.yourSeat])).toEqual([[true, 'A', 1], [true, 'A', 1]]);
    });

    it('CONTROL — the S6 text `(data?: …)` (one declared parameter): the guard REJECTS the bare requestState — no frame, [socket-payload-rejected]', () => {
      expect(H.request).toContain(DEFAULTED);
      const w = world(H.sync, { guard: true, request: H.request.replace(DEFAULTED, OPTIONAL) });
      const s = w.mk('SH');
      w.playerSessions.set('SH', { socketId: 'SH', tableId: 'A', seatIndex: 1, sittingOut: false, trainingEnabled: false });
      const rejectedBefore = socketGuardStats.payloadsRejected;
      s.handlers.requestState();
      expect(socketGuardStats.payloadsRejected).toBe(rejectedBefore + 1);
      expect(events(s, 'gameState')).toEqual([]);
    });

    it('no socket listener in index.ts declares an OPTIONAL first parameter (`x?:` — compiled to one declared parameter, the guard refuses a bare emit); a payload-optional listener uses a default (`= {}`)', () => {
      const optional = SRC.match(/socket\.on\(\s*'[A-Za-z]+',\s*(?:trackLogin\([^)]*?,\s*)?(?:async\s*)?\(\s*[A-Za-z_$][\w$]*\?\s*:/g) || [];
      expect(optional).toEqual([]);
    });
  });

  describe('broadcastGameState — a socket SEATED at the table is never also its spectator', () => {
    const BC = fnSrc('function broadcastGameState(');
    const CHOKE = slice('  if (tableSpectators && tableSpectators.size > 0) {\n    for (const specId of [...tableSpectators]) {', '\n  }\n');
    function bcWorld(bc: string) {
      const table = new PokerTable(cfg('A'));
      for (let i = 0; i < 2; i++) expect(table.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
      const sockets = new Map<string, FakeSocket>([['SH', fakeSocket('SH')], ['SPEC', fakeSocket('SPEC')]]);
      const playerSessions = new Map<string, any>([['SH', { socketId: 'SH', tableId: 'A', seatIndex: 0 }]]);
      const spectators = new Map<string, Set<string>>([['A', new Set(['SH', 'SPEC'])]]);
      const sent: Array<[string, any]> = [];
      const scope: Record<string, unknown> = {
        tableManager: { getTable: () => table }, playerSessions, multiTableSessions: new Map(), spectators, reservedSeats: new Map(),
        io: { sockets: { sockets }, to: () => ({ emit() {} }) }, ensureTurnTimerWired() {}, ensureInsuranceHoldWired() {},
        getGameStateForPlayer: (_t: PokerTable, seat: number) => ({ tableId: 'A', yourSeat: seat }),
        emitGameState: (s: FakeSocket, st: any) => sent.push([s.id, st]), armTurnTimer() {}, isHandStoreReady: () => false,
        DrawPhases: DRAWS, console: quiet,
      };
      const { exports: m } = load(bc, scope, '{ broadcastGameState }');
      return { m, sent, spectators };
    }
    it('SH sits at A and is still in A\'s spectators (a resync attached it before a restore seated it): it gets its seat frame only, and leaves the set', () => {
      const w = bcWorld(BC);
      w.m.broadcastGameState('A');
      expect(w.sent.filter(([id]) => id === 'SH').map(([, st]) => st.yourSeat)).toEqual([0]);
      expect(w.sent.filter(([id]) => id === 'SPEC').map(([, st]) => [st.yourSeat, st.isSpectator, st.spectatorCount])).toEqual([[-1, true, 1]]);
      expect([...w.spectators.get('A')!]).toEqual(['SPEC']);
    });
    it('CONTROL — pre-F155: SH gets its seat frame AND a spectator frame (yourSeat -1) right after it', () => {
      const w = bcWorld(without(BC, CHOKE, ''));
      w.m.broadcastGameState('A');
      expect(w.sent.filter(([id]) => id === 'SH').map(([, st]) => st.yourSeat)).toEqual([0, -1]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════ G181 / G182 state ══
describe('G181 / G182 — every seat says whether its player SITS OUT; the state says how many seats the table has', () => {
  const STATE = [fnSrc('function getVariantInfo('), fnSrc('function getGameStateForPlayer(')].join('\n');
  function stateOf(table: PokerTable, seat: number, sitOutTracker = new Map<string, Set<number>>()): any {
    const { exports } = load(STATE, {
      isTournamentTable: () => false, PokerTable, OmahaTable, ShortDeckTable, FiveCardDrawTable, SevenStudTable, MAX_SEATS, GamePhase, cardToString,
      playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
      dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null, sitOutTracker,
      tournamentIdOfTable: () => undefined, rebuyAllowedAt: () => true, progressionManager: { getProgress: () => null },
      tableKindOf: () => 'cash', bombPotAllowedAt: () => false, straddleAllowedAt: () => false, drawClockStart: () => 0,
    }, 'getGameStateForPlayer');
    return exports(table, seat, false);
  }

  it('G181: a sitting-out seat has sittingOut true for EVERY viewer (spectators too); the others false; an empty seat false (always present)', () => {
    const t = new PokerTable(cfg('A'));
    for (let i = 0; i < 4; i++) expect(t.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
    const tracker = new Map([['A', new Set([1])]]);
    t.setSittingOutSeats(tracker.get('A')!);
    expect(t.startNewHand()).toBe(true);
    for (const viewer of [0, 2, -1]) {
      const s = stateOf(t, viewer, tracker);
      expect(s.seats.map((x: any) => x.sittingOut)).toEqual([false, true, false, false, false, false, false, false, false]);
      expect(s.seats[1].state).toBe('occupied');                       // never 'sitting_out' (the engine keys on 'occupied')
    }
  });

  it('G182: maxSeats = the table\'s cap — 9 Hold\'em, 6 Triple Draw / 6-card Omaha, 2 heads-up — always present', () => {
    expect(stateOf(new PokerTable(cfg('A')), -1).maxSeats).toBe(9);
    expect(stateOf(new FiveCardDrawTable(cfg('D'), true), -1).maxSeats).toBe(6);
    const hu = new PokerTable(cfg('H'));
    (hu as any).maxOccupiableSeats = 2;
    expect(stateOf(hu, -1).maxSeats).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════ sitOut / AFK / back (F87 a, G181) ══
describe('F87 (a) — sitOut {sittingOut:boolean} SETS the state; G181 — the change is broadcast at once', () => {
  const H = {
    sitOut: handlerSrc('sitOut', '\n  });\n'),
    playerAFK: handlerSrc('playerAFK', '\n  });\n'),
    playerBack: handlerSrc('playerBack', '\n  });\n'),
  };
  function world() {
    const A = new PokerTable(cfg('A'));
    for (let i = 0; i < 3; i++) expect(A.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
    const main = { socketId: 'S', tableId: 'A', seatIndex: 0, playerName: 'P0', playerId: 'p0', sittingOut: false };
    const sitOutTracker = new Map<string, Set<number>>();
    const broadcasts: string[] = [];
    const scope: Record<string, unknown> = {
      tableManager: { getTable: () => A }, playerSessions: new Map([['S', main]]), multiTableSessions: new Map(), sitOutTracker,
      syncSitOutToTable() {}, broadcastGameState: (id: string) => broadcasts.push(id), scheduleAIAction() {},
      DrawPhases: DRAWS, isTournamentTable: () => false, FiveCardDrawTable, autoActForSeat() {}, console: quiet,
    };
    const { exports: m } = load(`function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${Object.values(H).join('\n')}\n}`, scope, '{ wire }');
    const sock = fakeSocket('S');
    m.wire(sock);
    return { A, main, sitOutTracker, broadcasts, sock };
  }

  it('sitOut {sittingOut:true} twice = ONE sit-out (the second is answered unchanged, nothing changes); {sittingOut:false} sits him in', async () => {
    const w = world();
    await w.sock.handlers.sitOut({ sittingOut: true });
    await w.sock.handlers.sitOut({ sittingOut: true });
    expect(w.main.sittingOut).toBe(true);
    expect([...(w.sitOutTracker.get('A') || [])]).toEqual([0]);
    expect(events(w.sock, 'sitOutToggled')).toEqual([
      { sittingOut: true, tableId: 'A' },
      { sittingOut: true, reason: 'unchanged', tableId: 'A' },
    ]);
    await w.sock.handlers.sitOut({ sittingOut: false });
    expect(w.main.sittingOut).toBe(false);
    expect(w.sitOutTracker.get('A')?.has(0)).toBe(false);
  });

  it('a payload-less sitOut still TOGGLES (older clients)', async () => {
    const w = world();
    await w.sock.handlers.sitOut();
    expect(w.main.sittingOut).toBe(true);
    await w.sock.handlers.sitOut({});
    expect(w.main.sittingOut).toBe(false);
  });

  it('CONTROL — pre-F87: a replayed {sittingOut:true} on a seat already sitting out TOGGLES it back IN', async () => {
    const OLD = without(H.sitOut,
      "    const want = typeof data?.sittingOut === 'boolean' ? data.sittingOut : !session.sittingOut;\n    if (want === !!session.sittingOut) {\n      socket.emit('sitOutToggled', { sittingOut: !!session.sittingOut, reason: 'unchanged', tableId: session.tableId });\n      return;\n    }\n    session.sittingOut = want;",
      '    session.sittingOut = !session.sittingOut;');
    const A = new PokerTable(cfg('A'));
    const main = { socketId: 'S', tableId: 'A', seatIndex: 0, sittingOut: true };
    const { exports: m } = load(`function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${OLD}\n}`, {
      tableManager: { getTable: () => A }, playerSessions: new Map([['S', main]]), multiTableSessions: new Map(), sitOutTracker: new Map(),
      syncSitOutToTable() {}, broadcastGameState() {}, DrawPhases: DRAWS,
    }, '{ wire }');
    const s = fakeSocket('S');
    m.wire(s);
    await s.handlers.sitOut({ sittingOut: true });
    expect(main.sittingOut).toBe(false);
  });

  it('G181: Sit Out off his turn, AFK, I\'m back — each change broadcast ONCE (the table sees the AWAY badge now); an AFK of a seat already out broadcasts nothing', async () => {
    const w = world();
    await w.sock.handlers.sitOut({ sittingOut: true });
    expect(w.broadcasts).toEqual(['A']);
    await w.sock.handlers.playerAFK();
    expect(w.broadcasts).toEqual(['A']);                              // already out: no change
    await w.sock.handlers.playerBack();
    expect(w.broadcasts).toEqual(['A', 'A']);
    await w.sock.handlers.playerAFK();
    expect(w.broadcasts).toEqual(['A', 'A', 'A']);
  });

  it('…and on his turn the sit-out\'s own fold broadcast is the only one', async () => {
    const w = world();
    expect(w.A.startNewHand()).toBe(true);
    const a = w.A.activeSeatIndex;
    w.main.seatIndex = a;
    await w.sock.handlers.sitOut({ sittingOut: true });
    expect(w.A.seats[a].folded).toBe(true);
    expect(w.broadcasts).toEqual(['A']);
  });
});

// ═══════════════════════════════════════════════════════════════ G182 moves ══
describe('G182 — a seat move past the cap is refused; every move that does not happen is answered moveSeatCancelled', () => {
  const H = { moveSeat: handlerSrc('moveSeat', '\n  });\n'), cancelMoveSeat: handlerSrc('cancelMoveSeat', '\n  });\n') };
  const EXEC = fnSrc('function executePendingMove(');
  function world(moveSrc = H.moveSeat, execSrc = EXEC) {
    const D = new FiveCardDrawTable(cfg('D'), true);                     // Triple Draw: 6 seats
    expect(D.sitDown(0, 'Hero', 5000, 'hero', false)).toBe(true);
    expect(D.sitDown(1, 'V1', 5000, 'v1', false)).toBe(true);
    const session: any = { socketId: 'S', tableId: 'D', seatIndex: 0, playerName: 'Hero', playerId: 'hero', sittingOut: false };
    const sock = fakeSocket('S');
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 'D' ? D : undefined) }, playerSessions: new Map([['S', session]]),
      multiTableSessions: new Map(), isTournamentTable: () => false, MAX_SEATS, aiProfiles: new Map(), sitOutTracker: new Map(),
      lastSentState: new Map(), lastSentJson: new Map(), io: { sockets: { sockets: new Map([['S', sock]]) } },
      broadcastGameState() {}, log: { debug() {} }, console: quiet,
    };
    const { exports: m } = load(`${execSrc}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${moveSrc}\n${H.cancelMoveSeat}\n}`, scope, '{ wire, executePendingMove }');
    m.wire(sock);
    return { D, session, sock, m };
  }

  it('moveSeat to seat 7 on a 6-seat table: refused invalid_target_seat — nothing queued, no pill', async () => {
    const w = world();
    await w.sock.handlers.moveSeat({ targetSeatIndex: 7 });
    expect(events(w.sock, 'error')).toEqual([{ message: 'Invalid target seat', code: 'invalid_target_seat' }]);
    expect(w.session.pendingSeatIndex).toBeUndefined();
    expect(events(w.sock, 'moveSeatPending')).toEqual([]);
  });

  it('CONTROL — pre-G182: the move to seat 7 is queued (moveSeatPending), sitDown refuses it at the boundary, and NOTHING tells the client (the pill stays)', async () => {
    const CAP = slice('      // 2026-10-21 (gameplay G182) — a seat past this table', "        return;\n      }\n");
    const OLD_EXEC = EXEC
      .replace(slice('  // G182 — a seat past the table', "    return cancelled('seat_unavailable');\n  }\n"), '')
      .replace("    io.sockets.sockets.get(session.socketId)?.emit('error', { message: 'That seat is not available — you stayed in your seat.', code: 'move_seat_failed' });\n    return cancelled('seat_unavailable');   // G182\n", '    return false;\n');
    const w = world(without(H.moveSeat, CAP, ''), OLD_EXEC);
    expect(w.D.startNewHand()).toBe(true);
    await w.sock.handlers.moveSeat({ targetSeatIndex: 7 });
    expect(events(w.sock, 'moveSeatPending')).toEqual([{ tableId: 'D', currentSeat: 0, pendingSeat: 7 }]);
    expect(w.m.executePendingMove('D', w.session)).toBe(false);
    expect(events(w.sock, 'moveSeatCancelled')).toEqual([]);
  });

  it('a queued move whose target a human took meanwhile: moveSeatCancelled {seat_taken} (+ the old error for older clients); the player stays', () => {
    const w = world();
    w.session.pendingSeatIndex = 3;
    expect(w.D.sitDown(3, 'Late', 5000, 'late', false)).toBe(true);
    expect(w.m.executePendingMove('D', w.session)).toBe(false);
    expect(events(w.sock, 'moveSeatCancelled')).toEqual([{ tableId: 'D', reason: 'seat_taken' }]);
    expect(events(w.sock, 'error')).toEqual([{ message: 'Target seat was taken — move cancelled' }]);
    expect(w.D.seats[0].playerName).toBe('Hero');
  });

  it('a pending move past the cap (queued by an older server) ends with moveSeatCancelled {seat_unavailable} BEFORE he is stood up', () => {
    const w = world();
    w.session.pendingSeatIndex = 8;
    expect(w.m.executePendingMove('D', w.session)).toBe(false);
    expect(events(w.sock, 'moveSeatCancelled')).toEqual([{ tableId: 'D', reason: 'seat_unavailable' }]);
    expect(w.D.seats[0]).toMatchObject({ state: 'occupied', playerName: 'Hero', chipCount: 5000 });
  });

  it('cancelMoveSeat is ALWAYS answered (idempotent): a pending move is dropped; with none (or an unknown table) it still answers', async () => {
    const w = world();
    w.session.pendingSeatIndex = 3;
    await w.sock.handlers.cancelMoveSeat({ tableId: 'D' });
    expect(w.session.pendingSeatIndex).toBeUndefined();
    await w.sock.handlers.cancelMoveSeat();
    await w.sock.handlers.cancelMoveSeat({ tableId: 'Z' });
    expect(events(w.sock, 'moveSeatCancelled')).toEqual([
      { tableId: 'D', reason: 'cancelled' }, { tableId: 'D', reason: 'cancelled' }, { tableId: 'Z', reason: 'cancelled' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════ F21 ══
describe('F21 — a folded seat\'s cards are never shown while the hand is still being played', () => {
  const HANDLER = handlerSrc('showMuckedHand', '\n  });\n');
  function world(handler = HANDLER) {
    const t = new PokerTable(cfg('T'));
    for (let i = 0; i < 3; i++) expect(t.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
    const playerSessions = new Map<string, any>();
    for (let i = 0; i < 3; i++) playerSessions.set(`S${i}`, { socketId: `S${i}`, tableId: 'T', seatIndex: i, playerName: `P${i}`, playerId: `p${i}` });
    const room: Array<[string, any]> = [];
    const { exports: m } = load(`${MUCK_SHOWS_SRC}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${handler}\n}`, {
      playerSessions, multiTableSessions: new Map(), tableManager: { getTable: () => t },
      GamePhase, cardToString, io: { to: () => ({ emit: (ev: string, d: any) => room.push([ev, d]) }) },
    }, '{ wire, flushPendingMuckShows, dropPendingMuckShows, pendingMuckShows }');
    const socks = [0, 1, 2].map((i) => { const s = fakeSocket(`S${i}`); m.wire(s); return s; });
    return { t, room, m, socks };
  }

  it('fold on the flop, Show Hand: nothing to the room while the others bet; revealed when the hand ends — the REAL cards, once', async () => {
    const w = world();
    expect(w.t.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && w.t.currentPhase === GamePhase.PreFlop; g++) {
      const a = w.t.activeSeatIndex;
      if (!w.t.playerCall(a)) w.t.playerCheck(a);
    }
    expect(w.t.currentPhase).toBe(GamePhase.Flop);
    const f = w.t.activeSeatIndex;
    expect(w.t.playerFold(f)).toBe(true);
    await w.socks[f].handlers.showMuckedHand({ tableId: 'T', handNumber: w.t.handNumber });
    expect(w.room).toEqual([]);
    expect(events(w.socks[f], 'muckedHandShowQueued')).toEqual([{ tableId: 'T', handNumber: w.t.handNumber, seatIndex: f }]);
    const cards = w.t.seats[f].holeCards.map((c) => ({ suit: c.suit, rank: c.rank, display: cardToString(c) }));
    for (let g = 0; g < 100 && w.t.isHandInProgress(); g++) {
      const a = w.t.activeSeatIndex;
      if (!w.t.playerCheck(a)) w.t.playerCall(a);
    }
    expect(w.m.flushPendingMuckShows('T', w.t)).toBe(1);
    expect(w.room).toEqual([['muckedHandRevealed', expect.objectContaining({ seatIndex: f, tableId: 'T', handNumber: w.t.handNumber, cards })]]);
    expect(w.m.flushPendingMuckShows('T', w.t)).toBe(0);
  });

  it('a show queued in hand N is dropped if hand N+1 is what ends (never revealed for the wrong hand); a stale handNumber tap is ignored', async () => {
    const w = world();
    expect(w.t.startNewHand()).toBe(true);
    const a = w.t.activeSeatIndex;
    expect(w.t.playerFold(a)).toBe(true);
    const handN = w.t.handNumber;
    await w.socks[a].handlers.showMuckedHand({ handNumber: handN });
    expect(w.m.pendingMuckShows.size).toBe(1);
    (w.t as any).handNumber = handN + 1;                                // the next hand reached its end first
    expect(w.m.flushPendingMuckShows('T', w.t)).toBe(0);
    expect(w.m.pendingMuckShows.size).toBe(0);
    await w.socks[a].handlers.showMuckedHand({ handNumber: handN });   // a stale tap
    expect(w.m.pendingMuckShows.size).toBe(0);
    expect(w.room).toEqual([]);
  });

  it('a table that goes away drops its queued shows', async () => {
    const w = world();
    expect(w.t.startNewHand()).toBe(true);
    const a = w.t.activeSeatIndex;
    expect(w.t.playerFold(a)).toBe(true);
    await w.socks[a].handlers.showMuckedHand({});
    w.m.dropPendingMuckShows('T');
    expect(w.m.pendingMuckShows.size).toBe(0);
    expect(fnSrc('function endTableViewsAndTimers(')).toContain('dropPendingMuckShows(tableId);');
  });

  it('wiring: the handResult listener reveals the queue FIRST, before any seat is stood up (processPendingSeatRemovals)', () => {
    const L = fnSrc('function ensureTableProgressListener(');
    const hr = L.indexOf("table.on('handResult', async (data: { results: any[]; handNumber: number }) => {");
    const flushAt = L.indexOf('flushPendingMuckShows(tableId, table)', hr);
    expect(hr).toBeGreaterThan(-1);
    expect(flushAt).toBeGreaterThan(hr);
    expect(flushAt).toBeLessThan(L.indexOf('processPendingSeatRemovals(tableId);', hr));
    expect(flushAt).toBeLessThan(L.indexOf('await', hr) === -1 ? Infinity : L.indexOf('await', hr));
  });

  it('CONTROL — pre-F21: a folded seat\'s Show Hand on the flop is BROADCAST to the players still in the pot', async () => {
    const QUEUE = slice('    if (!handOver) {\n      // F21', '\n      return;\n    }\n');
    const w = world(without(HANDLER, QUEUE, ''));
    expect(w.t.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && w.t.currentPhase === GamePhase.PreFlop; g++) {
      const a = w.t.activeSeatIndex;
      if (!w.t.playerCall(a)) w.t.playerCheck(a);
    }
    const f = w.t.activeSeatIndex;
    expect(w.t.playerFold(f)).toBe(true);
    expect(w.t.isHandInProgress()).toBe(true);
    await w.socks[f].handlers.showMuckedHand({});
    expect(w.room.map(([ev]) => ev)).toEqual(['muckedHandRevealed']);
  });
});

// ═══════════════════════════════════════════════════════════════ F82 / G189 world ══
/**
 * A cash table T1 (SB 25 / BB 50) with Bob (seat 0) and Carl (seat 6) live and
 * Alice (user 9) at seat 4 with 3,000 on socket X. The REAL disconnect handler,
 * reserveSeatForDeparture, the seat teardown, the ghost-seat clear, the shared
 * restore and joinTable / executePendingMove / autoStartNextHand.
 */
const DEP = [
  fnSrc('function otherSessionHoldsSeat('), fnSrc('function seatHasLiveSession('),
  fnSrc('function reserveSeatForDeparture('), fnSrc('function cashOutAdditionalSeatsOnDeparture('),
  fnSrc('function isTournamentReservation('), fnSrc('function noteTournamentReservationNotCashed('),
  fnSrc('function creditSeatStackToWallet('), SEAT_TEARDOWN_SRC, SEAT_RESTORE_SRC,
  fnSrc('function clearGhostSeatsForUser('), fnSrc('function seatPlayedByAnotherAccount('),
  fnSrc('function seatReservedByOtherAccount('), fnSrc('function detachSocketFromOtherTables('),
  fnSrc('function restoreFastModeOnSeatRestore('), fnSrc('function executePendingMove('),
].join('\n');
const DISCONNECT = slice("  socket.on('disconnect', async () => {\n    console.log(`Player disconnected: ${socket.id}`);", '\n  });\n');
const JOIN = handlerSrc('joinTable', '\n    })(); }\n  );');
const AUTO_START = fnSrc('function autoStartNextHand(tableId: string): void {');
const ALICE = 9;

function seatWorld(opts: { disconnect?: string; join?: string; autoStart?: string } = {}) {
  const T1 = new PokerTable(cfg('T1'));
  expect(T1.sitDown(0, 'Bob', 5000, 'p-bob', false)).toBe(true);
  expect(T1.sitDown(6, 'Carl', 5000, 'p-carl', false)).toBe(true);
  expect(T1.sitDown(4, 'Alice', 3000, 'player-x1', false)).toBe(true);
  const tables = new Map<string, PokerTable>([['T1', T1]]);
  const playerSessions = new Map<string, any>([
    ['SB', { socketId: 'SB', tableId: 'T1', seatIndex: 0, playerName: 'Bob', playerId: 'p-bob', sittingOut: false }],
    ['SC', { socketId: 'SC', tableId: 'T1', seatIndex: 6, playerName: 'Carl', playerId: 'p-carl', sittingOut: false }],
    ['X', { socketId: 'X', tableId: 'T1', seatIndex: 4, playerName: 'Alice', playerId: 'player-x1', sittingOut: false }],
  ]);
  const authSessions = new Map<string, any>([
    ['SB', { userId: 2, username: 'bob' }], ['SC', { userId: 3, username: 'carl' }],
    ['X', { userId: ALICE, username: 'alice', masterUserId: 'm-alice', secondary: true }],
  ]);
  const reservedSeats = new Map<number, any>();
  const sockets = new Map<string, FakeSocket>();
  const credits: Array<{ uid: number; amount: number }> = [];
  const deducts: Array<{ uid: number; amount: number }> = [];
  const save = { gate: null as Promise<void> | null };
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id), getTableList: () => [...tables.keys()].map((tableId) => ({ tableId })) },
    playerSessions, authSessions, reservedSeats, multiTableSessions: new Map(), spectators: new Map(), tournamentTables: new Map(),
    brokenTournamentTables: new Map(), pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(),
    aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), quickTables: new Set(), lastSentState: new Map(), lastSentJson: new Map(),
    io: { sockets: { sockets }, to: () => ({ emit() {} }), emit() {} }, MAX_SEATS, DrawPhases: DRAWS, GamePhase, FiveCardDrawTable,
    SEAT_RESERVE_MS: 6 * 3600_000, DISCONNECT_HANDS_LIMIT: 20, reservationsDisplaced: { count: 0 }, shutdownFlushActive: () => false,
    isTournamentTable: () => false, isPrizeFormatTable: () => false, leaverKeepsAllInHand: () => true,
    progressionManager: { getClientProgress: () => ({ hydrated: true, xp: 1, level: 1, achievements: [] }), getOrCreateProgress() {} },
    saveProgress: async () => { if (save.gate) await save.gate; return true; },
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    deductChips: async (uid: number, amount: number) => { deducts.push({ uid, amount }); return true; },
    ensureChipsForBuyIn: async () => 100_000, auditLog() {}, Sentry: null,
    getGameStateForPlayer: () => ({}), emitGameState() {}, broadcastGameState() {}, scheduleAIAction() {}, syncSitOutToTable() {},
    blockedByMaintenance: () => false, assertPlayable: async () => null, isUserBanned: async () => false,
    buyInSocketGone: async () => false, joinTableRefusalReason: () => null, clubJoinGrants: new WeakSet(),
    seatNameForSocket: (_s: unknown, n: string) => n, sanitizeSeatAvatar: () => undefined, ipSeatedSlots: new Map(), clientIp: '10.0.0.1',
    noteSameNetworkSeat() {}, uuidv4: () => 'new', challengeTables: new Map(), ensureTableProgressListener() {}, fillWithAI() {},
    isFixedRosterTable: () => false, sendProgressToPlayer() {}, takeAiSeatForJoin: () => -1, aiSeatTakeableNow: () => false,
    releaseSeatedSlot() {}, reconnectTournamentFields: () => ({}),
    // autoStartNextHand's side steps
    reloadAndCapBotStacks() {}, isFixedRosterQuickTable: () => false, trimExcessAI() {}, dealersChoiceState: new Map(),
    activateBombPotIfPending() {}, tournamentManager: { getTournament: () => undefined }, log: { debug() {}, info() {} },
    console: quiet,
  };
  const code = `${DEP}\n${JOIN_PRECHECK_SRC}\n${opts.autoStart ?? AUTO_START}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${opts.join ?? JOIN}\n${opts.disconnect ?? DISCONNECT}\n}`;
  const { exports: m, stubbed } = load(code, scope, '{ wire, autoStartNextHand }');
  const mk = (id: string) => { const s = fakeSocket(id); sockets.set(id, s); m.wire(s); return s; };
  for (const id of ['SB', 'SC']) mk(id);
  const x = mk('X');
  /** socket.io order: out of the namespace and connected=false, THEN 'disconnect'. */
  const drop = (s: FakeSocket) => { s.connected = false; sockets.delete(s.id); return s.handlers.disconnect(); };
  return { T1, m, stubbed, mk, x, drop, playerSessions, authSessions, reservedSeats, credits, deducts, save, scope };
}

// ═══════════════════════════════════════════════════════════════ F82 ══
describe('F82 — a rejoin (joinTable) RESTORES the account\'s reservation at that table: same seat, same stack, his hand kept, nothing bought', () => {
  /** Alice's extra-table socket X blips off her turn with chips in the pot; X2 signs in (skipSeatRecovery) and re-joins T1. */
  async function blipAndRejoin(over: { join?: string } = {}) {
    const w = seatWorld(over);
    expect(w.T1.startNewHand()).toBe(true);
    for (let g = 0; g < 4 && w.T1.activeSeatIndex === 4; g++) w.T1.playerCall(4);
    expect(w.T1.activeSeatIndex).not.toBe(4);
    const stackBefore = w.T1.seats[4].chipCount;
    await w.drop(w.x);
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'T1', seatIndex: 4, secondary: true });
    expect(w.T1.seats[4].folded).toBe(false);
    const x2 = w.mk('X2');
    w.authSessions.set('X2', { userId: ALICE, username: 'alice', masterUserId: 'm-alice', secondary: true });
    await x2.handlers.joinTable({ tableId: 'T1', playerName: 'Alice', seatIndex: -1, buyIn: 1000 });
    await flush();
    return { w, x2, stackBefore };
  }

  it('the reserved seat comes back on X2 UNFOLDED with its stack; no deduct, no credit; reconnectedToTable; the reservation consumed', async () => {
    const { w, x2, stackBefore } = await blipAndRejoin();
    expect(w.playerSessions.get('X2')).toMatchObject({ tableId: 'T1', seatIndex: 4, seatPlayerId: 'player-x1' });
    expect(w.T1.seats[4]).toMatchObject({ state: 'occupied', folded: false, chipCount: stackBefore, playerId: 'player-x1' });
    expect(w.deducts).toEqual([]);
    expect(w.credits).toEqual([]);
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(events(x2, 'reconnectedToTable')).toEqual([{ tableId: 'T1', seatIndex: 4, sittingOut: false }]);
    expect([...w.stubbed].filter((n) => /restore|Reserv|Ghost|seat|Seat|detach/.test(n) && !n.includes('.'))).toEqual([]);
  });

  it('CONTROL — pre-F82: the rejoin ghost-clears his own reserved seat — his live hand FOLDED — and buys him in again at another seat', async () => {
    const NEXT = '      // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.\n';
    const REJOIN = slice('      // 2026-10-21 (gameplay F82) — a REJOIN', NEXT);
    const { w } = await blipAndRejoin({ join: without(JOIN, REJOIN, NEXT) });
    expect(w.T1.seats[4].folded).toBe(true);
    expect(w.deducts).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(w.playerSessions.get('X2')?.seatIndex).not.toBe(4);
  });

  it('a join naming ANOTHER seat, or a reservation at another table, is an ordinary join (the rejoin needs this table and seatIndex -1 / the same seat)', async () => {
    const w = seatWorld();
    await w.drop(w.x);
    const x2 = w.mk('X2');
    w.authSessions.set('X2', { userId: ALICE, username: 'alice' });
    await x2.handlers.joinTable({ tableId: 'T1', playerName: 'Alice', seatIndex: 2, buyIn: 1000 });
    await flush();
    expect(events(x2, 'reconnectedToTable')).toEqual([]);
    expect(w.deducts).toEqual([{ uid: ALICE, amount: 1000 }]);
  });

  // ── S6 fix-up: the HALF-OPEN variant — X is not reaped yet (the server holds it
  // open until its ping timeout), so there is NO reservation when X2 rejoins.
  describe('half-open: X2 rejoins while the server still holds X on the seat (no reservation yet)', () => {
    const TAKEOVER = slice('      // F82 fix-up (2026-10-21) — the HALF-OPEN rejoin', '      // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.\n');
    async function halfOpenRejoin(over: { join?: string } = {}, payload: Record<string, unknown> = { seatIndex: -1 }, prep?: (w: ReturnType<typeof seatWorld>) => void) {
      const w = seatWorld(over);
      expect(w.T1.startNewHand()).toBe(true);
      for (let g = 0; g < 4 && w.T1.activeSeatIndex === 4; g++) w.T1.playerCall(4);
      expect(w.T1.activeSeatIndex).not.toBe(4);
      expect(w.T1.seats[4].totalInvestedThisHand).toBeGreaterThan(0);   // his chips are in the pot
      const stackBefore = w.T1.seats[4].chipCount;
      w.x.rooms.add('table:T1');
      prep?.(w);
      const x2 = w.mk('X2');
      w.authSessions.set('X2', { userId: ALICE, username: 'alice', masterUserId: 'm-alice', secondary: true });
      await x2.handlers.joinTable({ tableId: 'T1', playerName: 'Alice', buyIn: 1000, ...payload });
      await flush();
      return { w, x2, stackBefore };
    }

    it('the seat MOVES to X2: unfolded, same stack, no deduct, no credit; X2 told reconnectedToTable; X told seatVacated {joined_new_seat} and out of the room', async () => {
      const { w, x2, stackBefore } = await halfOpenRejoin();
      expect(w.playerSessions.get('X2')).toMatchObject({ socketId: 'X2', tableId: 'T1', seatIndex: 4, playerId: 'player-x1' });
      expect(w.playerSessions.has('X')).toBe(false);
      expect(w.T1.seats[4]).toMatchObject({ state: 'occupied', folded: false, chipCount: stackBefore, playerId: 'player-x1' });
      expect(w.T1.isHandInProgress()).toBe(true);
      expect(w.deducts).toEqual([]);
      expect(w.credits).toEqual([]);
      expect(events(x2, 'reconnectedToTable')).toEqual([{ tableId: 'T1', seatIndex: 4, sittingOut: false }]);
      expect(events(x2, 'fastModeSet')).toEqual([{ enabled: false }]);
      expect(x2.rooms.has('table:T1')).toBe(true);
      expect(events(w.x, 'seatVacated')).toEqual([{ tableId: 'T1', seatIndex: 4, reason: 'joined_new_seat' }]);
      expect(w.x.rooms.has('table:T1')).toBe(false);
      expect([...w.stubbed].filter((n) => /takeOver|restore|Reserv|Ghost|seat|Seat|detach/.test(n) && !n.includes('.'))).toEqual([]);
    });

    it('…X is reaped later: nothing reserved, nothing credited — X2 keeps playing the seat', async () => {
      const { w } = await halfOpenRejoin();
      await w.drop(w.x);
      await flush();
      expect(w.reservedSeats.has(ALICE)).toBe(false);
      expect(w.credits).toEqual([]);
      expect(w.playerSessions.get('X2')).toMatchObject({ tableId: 'T1', seatIndex: 4 });
      expect(w.T1.seats[4]).toMatchObject({ state: 'occupied', folded: false });
    });

    it('his Sit Out and fast mode move with the seat (tracker kept, sitOutToggled restored); a queued seat move ends (moveSeatCancelled to X)', async () => {
      const { w, x2 } = await halfOpenRejoin({}, { seatIndex: 4 }, (wd) => {
        Object.assign(wd.playerSessions.get('X'), { sittingOut: true, sitOutHands: 3, fastMode: true, pendingSeatIndex: 2 });
        (wd.scope.sitOutTracker as Map<string, Set<number>>).set('T1', new Set([4]));
      });
      expect(w.playerSessions.get('X2')).toMatchObject({ seatIndex: 4, sittingOut: true, sitOutHands: 3, fastMode: true });
      expect(w.playerSessions.get('X2').pendingSeatIndex).toBeUndefined();
      expect((w.scope.sitOutTracker as Map<string, Set<number>>).get('T1')?.has(4)).toBe(true);
      expect(events(x2, 'reconnectedToTable')).toEqual([{ tableId: 'T1', seatIndex: 4, sittingOut: true }]);
      expect(events(x2, 'sitOutToggled')).toEqual([{ sittingOut: true, reason: 'restored', tableId: 'T1' }]);
      expect(events(x2, 'fastModeSet')).toEqual([{ enabled: true }]);
      expect(events(w.x, 'moveSeatCancelled')).toEqual([{ tableId: 'T1', reason: 'cancelled' }]);
    });

    it('a join naming ANOTHER seat is a seat change, as before (the ghost clear, a buy-in); another ACCOUNT\'s seat is never taken over', async () => {
      const { w, x2 } = await halfOpenRejoin({}, { seatIndex: 2 });
      expect(events(x2, 'reconnectedToTable')).toEqual([]);
      expect(w.deducts).toEqual([{ uid: ALICE, amount: 1000 }]);
      const w2 = seatWorld();
      const bob2 = w2.mk('B2');
      w2.authSessions.set('B2', { userId: 77, username: 'mallory' });
      await bob2.handlers.joinTable({ tableId: 'T1', playerName: 'Mallory', seatIndex: -1, buyIn: 1000 });
      await flush();
      expect(w2.playerSessions.get('X')).toMatchObject({ seatIndex: 4 });
      expect(w2.playerSessions.get('B2')?.seatIndex).not.toBe(4);
      expect(events(bob2, 'reconnectedToTable')).toEqual([]);
    });

    it('CONTROL — pre-fix-up (no takeover): the ghost clear FOLDS his live hand and buys him in again at another seat', async () => {
      const NEXT = '      // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.\n';
      const { w } = await halfOpenRejoin({ join: without(JOIN, TAKEOVER, NEXT) });
      expect(w.T1.seats[4].folded).toBe(true);
      expect(w.deducts).toEqual([{ uid: ALICE, amount: 1000 }]);
      expect(w.playerSessions.get('X2')?.seatIndex).not.toBe(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════ G189 ══
describe('G189 — a socket that drops with a seat move queued: the move never runs on the dead socket; the seat he holds is reserved', () => {
  // The two layers, sliced from the CURRENT source (the CONTROLs remove them).
  const CLEAR = slice('    let queuedMovesDropped = 0;\n', "count: queuedMovesDropped })}`);\n    }\n");
  const SKIP = slice('      if (!io.sockets.sockets.get(sid)) {\n', '        return;\n      }\n');
  async function dropDuringSaveWithMove(over: { disconnect?: string; autoStart?: string } = {}) {
    const w = seatWorld(over);
    expect(w.T1.startNewHand()).toBe(true);
    w.playerSessions.get('X').pendingSeatIndex = 2;                   // "Move here" tapped mid-hand
    for (let g = 0; g < 20 && w.T1.isHandInProgress(); g++) w.T1.playerFold(w.T1.activeSeatIndex);
    expect(w.T1.currentPhase).toBe(GamePhase.HandComplete);
    const hold = deferred();
    w.save.gate = hold.p;
    const disc = w.drop(w.x);
    await flush();                                                     // inside the disconnect's saveProgress await
    w.m.autoStartNextHand('T1');                                       // the 1.5s auto-start fires meanwhile
    hold.resolve();
    await disc;
    await flush();
    return w;
  }

  it('the move is dropped: the seat he holds (4) is reserved — the 20-hand limit and the 6h expiry protect it', async () => {
    const w = await dropDuringSaveWithMove();
    expect(w.T1.seats[4]).toMatchObject({ state: 'occupied', playerName: 'Alice' });
    expect(w.T1.seats[2].state).toBe('empty');
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'T1', seatIndex: 4 });
  });

  it('either layer alone is enough: the disconnect drops the queued move before its await; the hand boundary skips a gone socket\'s move', async () => {
    const onlyAutoStart = await dropDuringSaveWithMove({ disconnect: without(DISCONNECT, CLEAR, '') });
    expect(onlyAutoStart.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'T1', seatIndex: 4 });
    const onlyDisconnect = await dropDuringSaveWithMove({ autoStart: without(AUTO_START, SKIP, '') });
    expect(onlyDisconnect.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'T1', seatIndex: 4 });
  });

  it('CONTROL — pre-G189: the move runs on the dead socket during the save; the moved seat has no session, no reservation, no cash-out', async () => {
    const w = await dropDuringSaveWithMove({ disconnect: without(DISCONNECT, CLEAR, ''), autoStart: without(AUTO_START, SKIP, '') });
    expect(w.T1.seats[2]).toMatchObject({ state: 'occupied', playerName: 'Alice' });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.playerSessions.has('X')).toBe(false);
  });

  it('canonical-features.txt locks EACH layer by a literal only that layer produces: removing either layer from the source removes its lock token (the CI grep then fails)', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const layer of [CLEAR, SKIP]) {
      const lockedHere = manifest.filter((t) => layer.includes(t));
      expect(lockedHere.length).toBeGreaterThan(0);
      const srcWithout = without(SRC, layer, '');
      // At least one of the layer's tokens appears NOWHERE else (a token shared with
      // the move / cancel paths — the old `delete session.pendingSeatIndex;` — locks nothing).
      expect(lockedHere.filter((t) => !srcWithout.includes(t)).length).toBeGreaterThan(0);
    }
    expect(manifest).toContain('queued_seat_move_dropped_socket_gone');
    expect(manifest).toContain('queued_seat_moves_dropped_on_disconnect');
  });
});

// ═══════════════════════════════════════════════════════════════ F88 ══
describe('F88 — seatVacated is sent on the socket whose session the server ENDED, after it left the room (server contract, no change)', () => {
  it('clearGhostSeatsForUser rule 1: the other socket\'s session is deleted and the room left BEFORE seatVacated {tableId, seatIndex, reason:joined_new_seat}', () => {
    const G = fnSrc('function clearGhostSeatsForUser(');
    const del = G.indexOf('playerSessions.delete(otherSocketId);');
    const leave = G.indexOf('ghostSocket.leave(`table:${tableId}`);');
    const emit = G.indexOf("ghostSocket.emit('seatVacated', { tableId, seatIndex: otherSession.seatIndex, reason: 'joined_new_seat' });");
    expect(del).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(del);
    expect(emit).toBeGreaterThan(leave);
  });

  it('end to end: Alice joins on a second device — her first socket is told seatVacated, and no frame for that table follows (its session is gone)', () => {
    const w = seatWorld();
    w.authSessions.get('X').secondary = undefined;
    const t = w.T1;
    const { exports: m } = load(`${DEP}`, w.scope, '{ clearGhostSeatsForUser }');
    m.clearGhostSeatsForUser(ALICE, 'T1', 'X2', undefined);
    expect(events(w.x, 'seatVacated')).toEqual([{ tableId: 'T1', seatIndex: 4, reason: 'joined_new_seat' }]);
    expect(w.playerSessions.has('X')).toBe(false);
    expect(w.x.rooms.has('table:T1')).toBe(false);
    expect(t.seats[4].state).toBe('empty');
    expect(w.credits).toEqual([{ uid: ALICE, amount: 3000 }]);
    void SRC;
  });
});

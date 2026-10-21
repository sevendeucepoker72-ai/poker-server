/**
 * 2026-10-21 — gameplay audit, server cluster S5 (multi-table): EXTRA-table
 * (joinAdditionalTable) seats and action routing. A player can hold his main
 * seat (playerSessions) plus extra seats on the same socket (multiTableSessions);
 * several paths only ever looked at the main session.
 *   F45  the 500ms orphan auto-act counts an extra-table session as LIVE
 *   F156 every table-scoped seat control takes an optional tableId (seatSessionFor)
 *   F73  a disconnect whose socket holds ONLY extra seats cashes them out
 *   F85  a departure keeps an extra seat's live hand (Z6 on the clock)
 *   F62  one socket never holds two seats at one table
 *   F64  a stale action on an extra table re-pushes a RAW snapshot; a frame for
 *        another table than the delta baseline is always full
 *   G166 insuranceSettled reaches an extra-table seat
 *   G191 the ghost-seat clear ends another socket's EXTRA seat of the same account
 *   F51  an action naming a table he holds no seat at is refused (never the main seat)
 * Every test runs the REAL src/index.ts text (sliced + transpiled — index.ts
 * boots a server on import) against the REAL PokerTable engine; each fix has a
 * CONTROL that runs the pre-fix text and shows the defect.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { cardToString } from '../src/game/Card';
import { insuranceSettlementDelta } from '../src/game/insurance';
import {
  SRC, slice, fnSrc, handlerSrc, load, flush, deferred, SEAT_TEARDOWN_SRC, SEAT_SESSION_FOR_SRC,
} from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const cfg = (tableId: string, over: Record<string, unknown> = {}) =>
  ({ tableId, tableName: tableId, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxPlayers: 9, ...over } as any);

function fakeSocket(id: string) {
  const emitted: Array<[string, any]> = [];
  const handlers: Record<string, (...a: any[]) => any> = {};
  const rooms = new Set<string>();
  return {
    id, emitted, handlers, rooms, connected: true,
    on: (ev: string, fn: any) => { handlers[ev] = fn; },
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

// ═══════════════════════════════════════════════════════════════════ F45 ══
describe('F45 — a LIVE extra-table seat is never checked / folded 500ms into its turn', () => {
  const BC = fnSrc('function broadcastGameState(');
  const OLD_LIVE = '[...playerSessions.values()].some((s) => s.tableId === tableId && s.seatIndex === activeIdx)';
  const PRE_F45 = without(without(BC,
    'const hasLiveSession = seatHasAnySession(tableId, activeIdx);', `const hasLiveSession = ${OLD_LIVE};`),
  'const nowHasLiveSession = seatHasAnySession(tableId, activeIdx);', `const nowHasLiveSession = ${OLD_LIVE};`);

  function world(bc: string, hero: 'extra' | 'main' | 'none') {
    const table = new PokerTable(cfg('A'));
    for (let i = 0; i < 3; i++) expect(table.sitDown(i, `P${i}`, 5000, `p${i}`, false)).toBe(true);
    expect(table.startNewHand()).toBe(true);
    const seat = table.activeSeatIndex;                                     // first to act, facing the big blind
    const playerSessions = new Map<string, any>();
    const multiTableSessions = new Map<string, any[]>();
    for (let i = 0; i < 3; i++) if (i !== seat) playerSessions.set(`S${i}`, { socketId: `S${i}`, tableId: 'A', seatIndex: i });
    if (hero === 'main') playerSessions.set('SH', { socketId: 'SH', tableId: 'A', seatIndex: seat });
    if (hero === 'extra') {
      playerSessions.set('SH', { socketId: 'SH', tableId: 'B', seatIndex: 4 });          // his MAIN seat is at another table
      multiTableSessions.set('SH', [{ socketId: 'SH', tableId: 'A', seatIndex: seat }]); // "Open another table" → A
    }
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 'A' ? table : undefined) },
      playerSessions, multiTableSessions, reservedSeats: new Map(), spectators: new Map(),
      io: { to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
      getGameStateForPlayer: () => ({}), emitGameState() {}, DrawPhases: DRAWS, isHandStoreReady: () => false,
      armTurnTimer() {}, ensureTurnTimerWired() {}, ensureInsuranceHoldWired() {}, scheduleAIAction() {},
      absentTournamentSeatMayLimp: () => false, tournamentHandStartSafety: { allAbsentAutoCalls: 0 }, console: quiet,
    };
    const code = bc + fnSrc('function seatHasLiveSession(') + fnSrc('function seatHasAnySession(') + fnSrc('function autoActForSeat(');
    const { exports: m, stubbed } = load(code, scope, '{ broadcastGameState }');
    expect([...stubbed].filter((n) => /seatHas|autoAct|Sessions/.test(n))).toEqual([]);
    return { table, seat, m };
  }
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('his extra seat (multiTableSessions only) on the clock: NOT acted for after 500ms — the turn stays his', () => {
    const w = world(BC, 'extra');
    w.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(w.table.seats[w.seat].folded).toBe(false);
    expect(w.table.activeSeatIndex).toBe(w.seat);
  });

  it('CONTROL — pre-F45 (playerSessions only): the live extra seat is folded 500ms into its turn', () => {
    const w = world(PRE_F45, 'extra');
    w.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(w.table.seats[w.seat].folded).toBe(true);
  });

  it('a main-session seat is untouched; a seat with NO session (a real orphan) is still acted for at 500ms', () => {
    const main = world(BC, 'main');
    main.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(main.table.seats[main.seat].folded).toBe(false);
    const orphan = world(BC, 'none');
    orphan.m.broadcastGameState('A');
    jest.advanceTimersByTime(600);
    expect(orphan.table.seats[orphan.seat].folded).toBe(true);           // facing a bet: fold (check when free)
  });
});

// ═══════════════════════════════════════════════════ F156 / F51 harness ══
/**
 * Hero's MAIN seat is at A (seat 0), his EXTRA seat at B (seat 0) on the same
 * socket 'SH'. Two other humans at each table. The real handlers + the real
 * socket-scoped resolver (seatSessionFor / notSeatedThere).
 */
const RESOLVE_NEW = `      const session: PlayerSession | undefined = seatSessionFor(data?.tableId);
      if (!session && typeof data?.tableId === 'string' && data.tableId) {
        socket.emit('error', { message: 'You are not seated at that table.', code: 'not_at_table', tableId: data.tableId });
        return;
      }`;
const RESOLVE_OLD = `      let session: PlayerSession | undefined = playerSessions.get(socket.id);
      if (data.tableId && session?.tableId !== data.tableId) {
        const multi = multiTableSessions.get(socket.id) || [];
        const match = multi.find((s) => s.tableId === data.tableId);
        if (match) session = match;
      }`;
const H = {
  action: handlerSrc('action', '\n  );\n'),
  sitOut: handlerSrc('sitOut', '\n  });\n'),
  playerAFK: handlerSrc('playerAFK', '\n  });\n'),
  playerBack: handlerSrc('playerBack', '\n  });\n'),
  rebuy: handlerSrc('rebuy', '\n  })(); });'),
  postMissedBlinds: handlerSrc('postMissedBlinds', '\n  });\n'),
  playerDraw: handlerSrc('playerDraw', '\n  });\n'),
  chatMessage: handlerSrc('chatMessage', '\n  });\n'),
  straddle: handlerSrc('straddle', '\n  });\n'),
  triggerBombPot: handlerSrc('triggerBombPot', '\n  });\n'),
  rabbitHunt: handlerSrc('rabbitHunt', '\n  });\n'),
  toggleTraining: handlerSrc('toggleTraining', '\n  });\n'),
  startHand: handlerSrc('startHand', '\n  });\n'),
  showMuckedHand: handlerSrc('showMuckedHand', '\n  });\n'),
  moveSeat: handlerSrc('moveSeat', '\n  });\n'),
};
/** The table-kind block (tableKindOf, rebuyRefusalAt, bombPotAllowedAt, straddleAllowedAt, …). */
const KIND = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', "    code: 'rebuy_not_allowed',\n  };\n}\n")
  + fnSrc('function isPlainHoldemTable(');
/** buyInSocketGone + buyInStateChanged (the rebuy's P3 re-validation) + the F62 helper. */
const BUY_IN = slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n') + fnSrc('function socketHasSessionAt(');
const EMIT = [slice('const ALWAYS_EMIT_KEYS = [', '];\n'), fnSrc('function shallowDiff('), fnSrc('function pickAlwaysEmit('), fnSrc('function emitGameState(')].join('\n');

function seatWorld(opts: { handlers?: Partial<typeof H>; drawB?: boolean } = {}) {
  const A = new PokerTable(cfg('A'));
  const B = opts.drawB ? new FiveCardDrawTable(cfg('B'), false) : new PokerTable(cfg('B'));
  for (const [t, p] of [[A, 'a'], [B, 'b']] as const) {
    expect(t.sitDown(0, 'Hero', 5000, `hero-${p}`, false)).toBe(true);
    expect(t.sitDown(1, `${p}1`, 5000, `${p}1`, false)).toBe(true);
    expect(t.sitDown(2, `${p}2`, 5000, `${p}2`, false)).toBe(true);
  }
  const tables = new Map<string, PokerTable>([['A', A], ['B', B]]);
  const main = { socketId: 'SH', tableId: 'A', seatIndex: 0, playerName: 'Hero', playerId: 'hero-a', sittingOut: false, trainingEnabled: false };
  const extra = { socketId: 'SH', tableId: 'B', seatIndex: 0, playerName: 'Hero', playerId: 'hero-b', sittingOut: false, trainingEnabled: false };
  const playerSessions = new Map<string, any>([['SH', main]]);
  const multiTableSessions = new Map<string, any[]>([['SH', [extra]]]);
  const authSessions = new Map<string, any>([['SH', { userId: 101, username: 'hero' }]]);
  const sitOutTracker = new Map<string, Set<number>>();
  const wallet = new Map<number, number>([[101, 100_000]]);
  const deducts: Array<[number, number]> = [];
  const refunds: Array<[number, number]> = [];
  const room: Array<[string, string, any]> = [];
  const broadcasts: string[] = [];
  const bombPotPending = new Map<string, boolean>();
  const lastSentState = new Map<string, any>();
  const gates: { deduct: Promise<void> | null } = { deduct: null };
  const sock = fakeSocket('SH');
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id) },
    playerSessions, multiTableSessions, authSessions, sitOutTracker, reservedSeats: new Map(),
    isTournamentTable: () => false, spinGoMultipliers: new Map(), careerTables: new Map(), allInOrFoldTables: new Set(),
    quickTables: new Set(), challengeTables: new Map(), tournamentTables: new Map(), brokenTournamentTables: new Map(),
    PokerTable, OmahaTable, FiveCardDrawTable, GamePhase, DrawPhases: DRAWS, MAX_SEATS, cardToString,
    assertPlayable: async () => null, emitPlayRefusal() {},
    ensureChipsForBuyIn: async (uid: number) => wallet.get(uid) ?? 0,
    deductChips: async (uid: number, n: number) => {
      if (gates.deduct) await gates.deduct;
      wallet.set(uid, (wallet.get(uid) ?? 0) - n); deducts.push([uid, n]); return true;
    },
    addChipsToUser: async (uid: number, n: number) => { wallet.set(uid, (wallet.get(uid) ?? 0) + n); refunds.push([uid, n]); return true; },
    auditLog() {}, Sentry: null, shutdownFlushActive: () => false,
    broadcastGameState: (id: string) => broadcasts.push(id), scheduleAIAction() {}, autoStartNextHand() {},
    autoActForSeat: (_id: string, t: PokerTable, i: number) => { t.playerFold(i); return 'fold'; },
    io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }), sockets: { sockets: new Map([['SH', sock]]) } },
    seatNameForSocket: (_s: unknown, n: string) => n, progressionManager: { recordAction() {} }, lastChatTime: new Map(),
    actionNonces: new Map(), actionTimings: new Map(), pendingAutoStartTimers: new Map(),
    bombPotPending, bombPotCooldownUntil: new Map(), BOMB_POT_COOLDOWN_MS: 300_000,
    shownMuckedHands: new Set(), lastSentState, lastSentJson: new Map(),
    getGameStateForPlayer: (t: PokerTable, seat: number, training?: boolean) => ({
      tableId: t.config.tableId, yourSeat: seat, trainingData: training ? {} : undefined,
      currentBetToMatch: t.currentBetToMatch, stateVersion: t.stateVersion,
    }),
    log: { debug() {}, info() {}, warn() {} }, console: quiet,
  };
  const h = { ...H, ...(opts.handlers || {}) };
  const code = `${KIND}\n${BUY_IN}\n${EMIT}\n${fnSrc('function syncSitOutToTable(')}\n${slice('const bombPotStats', '};\n')}\n`
    + `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${Object.values(h).join('\n')}\n}`;
  const { exports: m, stubbed } = load(code, scope, '{ wire, buyInStateChanged }');
  m.wire(sock);
  expect([...stubbed].filter((n) => /seatSessionFor|notSeatedThere|Sessions|buyIn|syncSitOut/.test(n))).toEqual([]);
  return { A, B, tables, main, extra, playerSessions, multiTableSessions, sitOutTracker, wallet, deducts, refunds, room, broadcasts, bombPotPending, lastSentState, gates, sock, m };
}
/** Deal both tables and bring the action to Hero at A (seat 0), facing a bet. */
function heroToActAtA(w: ReturnType<typeof seatWorld>) {
  expect(w.A.startNewHand()).toBe(true);
  for (let g = 0; g < 6 && w.A.activeSeatIndex !== 0; g++) w.A.playerCall(w.A.activeSeatIndex);
  expect(w.A.activeSeatIndex).toBe(0);
}

// ═══════════════════════════════════════════════════════════════════ F51 ══
describe('F51 — an action naming a table he holds NO seat at is refused, never applied to his main seat', () => {
  it('his extra seat at B is gone (a reconnect cashed it out); a tap on the dead B pane — stateVersion ahead of A\'s — does NOT fold his live hand at A', async () => {
    const w = seatWorld();
    heroToActAtA(w);
    w.multiTableSessions.delete('SH');
    await w.sock.handlers.action({ type: 'fold', nonce: 'n1', tableId: 'B', stateVersion: w.A.stateVersion + 100 });
    expect(w.A.seats[0].folded).toBe(false);
    expect(w.A.activeSeatIndex).toBe(0);
    expect(events(w.sock, 'error')).toEqual([{ message: 'You are not seated at that table.', code: 'not_at_table', tableId: 'B' }]);
  });

  it('CONTROL — pre-F51 (fell back to the PRIMARY session): the B tap folds his hand at A', async () => {
    const w = seatWorld({ handlers: { action: without(H.action, RESOLVE_NEW, RESOLVE_OLD) } });
    heroToActAtA(w);
    w.multiTableSessions.delete('SH');
    await w.sock.handlers.action({ type: 'fold', nonce: 'n1', tableId: 'B', stateVersion: w.A.stateVersion + 100 });
    expect(w.A.seats[0].folded).toBe(true);
  });

  it('a tableId he holds a seat at acts THERE (the extra seat at B); no tableId = the main seat, as before', async () => {
    const w = seatWorld();
    expect(w.B.startNewHand()).toBe(true);
    for (let g = 0; g < 6 && w.B.activeSeatIndex !== 0; g++) w.B.playerCall(w.B.activeSeatIndex);
    expect(w.B.activeSeatIndex).toBe(0);
    await w.sock.handlers.action({ type: 'fold', nonce: 'b1', tableId: 'B' });
    expect(w.B.seats[0].folded).toBe(true);
    heroToActAtA(w);
    await w.sock.handlers.action({ type: 'fold', nonce: 'a1' });
    expect(w.A.seats[0].folded).toBe(true);
  });

  it('moveSeat: a tableId he holds no seat at is refused (not_at_table), never queued at the main table', async () => {
    const w = seatWorld();
    await w.sock.handlers.moveSeat({ targetSeatIndex: 5, tableId: 'Z' });
    expect(w.main).not.toHaveProperty('pendingSeatIndex');
    expect(events(w.sock, 'error')).toEqual([expect.objectContaining({ code: 'not_at_table', tableId: 'Z' })]);
  });
});

// ═══════════════════════════════════════════════════════════════════ F64 ══
describe('F64 — an extra table\'s frame never becomes the MAIN table\'s delta baseline', () => {
  it('a STALE action on the extra table re-pushes B as a RAW full snapshot; the socket\'s delta baseline stays A\'s', async () => {
    const w = seatWorld();
    w.lastSentState.set('SH', { tableId: 'A', currentBetToMatch: 50 });          // the main table's baseline
    expect(w.B.startNewHand()).toBe(true);
    for (let g = 0; g < 6 && w.B.activeSeatIndex !== 0; g++) w.B.playerCall(w.B.activeSeatIndex);
    expect(w.B.activeSeatIndex).toBe(0);
    await w.sock.handlers.action({ type: 'call', nonce: 's1', tableId: 'B', stateVersion: w.B.stateVersion - 1 });
    expect(events(w.sock, 'error')).toEqual([expect.objectContaining({ code: 'STALE_STATE' })]);
    expect(events(w.sock, 'gameState')).toEqual([expect.objectContaining({ full: true, state: expect.objectContaining({ tableId: 'B', yourSeat: 0, sittingOut: false, fastMode: false }) })]);
    expect(w.lastSentState.get('SH')).toEqual({ tableId: 'A', currentBetToMatch: 50 });
  });

  it('CONTROL — pre-F64 (emitGameState for the extra session): B\'s frame became the socket\'s baseline', async () => {
    const STALE_NEW = `        if (session === playerSessions.get(socket.id)) emitGameState(socket, staleState, true);
        else socket.emit('gameState', { full: true, state: staleState, _serverTs: Date.now() });`;
    const w = seatWorld({ handlers: { action: without(H.action, STALE_NEW, '        emitGameState(socket, staleState, true);') } });
    w.lastSentState.set('SH', { tableId: 'A', currentBetToMatch: 50 });
    expect(w.B.startNewHand()).toBe(true);
    for (let g = 0; g < 6 && w.B.activeSeatIndex !== 0; g++) w.B.playerCall(w.B.activeSeatIndex);
    await w.sock.handlers.action({ type: 'call', nonce: 's1', tableId: 'B', stateVersion: w.B.stateVersion - 1 });
    expect(w.lastSentState.get('SH').tableId).toBe('B');
  });

  function emitWorld(code = EMIT) {
    const lastSentState = new Map<string, any>();
    const lastSentJson = new Map<string, any>();
    const { exports: e } = load(code, { lastSentState, lastSentJson }, '{ emitGameState }');
    const sock = fakeSocket('S1');
    return { e, sock, lastSentState, lastSentJson };
  }
  const MAIN_PREFLOP = { tableId: 'P', phase: 'PreFlop', currentBetToMatch: 50, minRaise: 100, pot: 75, seats: [{ chips: 950 }] };
  const EXTRA = { tableId: 'S', phase: 'Flop', currentBetToMatch: 0, minRaise: 50, pot: 150, seats: [{ chips: 4000 }] };
  const MAIN_FLOP = { tableId: 'P', phase: 'Flop', currentBetToMatch: 0, minRaise: 50, pot: 150, seats: [{ chips: 950 }] };

  it('emitGameState: a frame for ANOTHER table than the baseline goes out FULL, and the next same-table delta carries every changed key', () => {
    const w = emitWorld();
    w.e.emitGameState(w.sock, MAIN_PREFLOP, true);
    w.e.emitGameState(w.sock, EXTRA, true);                     // a foreign frame on the main channel (any path)
    w.e.emitGameState(w.sock, MAIN_FLOP);                       // the main table moves on
    const frames = events(w.sock, 'gameState');
    expect(frames[2]).toMatchObject({ full: true, state: MAIN_FLOP });
    w.e.emitGameState(w.sock, { ...MAIN_FLOP, currentBetToMatch: 100, minRaise: 100 });
    expect(events(w.sock, 'gameState')[3]).toMatchObject({ full: false, delta: { currentBetToMatch: 100, minRaise: 100 } });
  });

  it('CONTROL — pre-F64 emitGameState: the main table\'s delta against the extra frame DROPS currentBetToMatch / minRaise / pot (the client kept Call 50 on a free check)', () => {
    const w = emitWorld(without(EMIT, ' || prev.tableId !== state?.tableId'));
    w.e.emitGameState(w.sock, MAIN_PREFLOP, true);
    w.e.emitGameState(w.sock, EXTRA, true);
    w.e.emitGameState(w.sock, MAIN_FLOP);
    const delta = events(w.sock, 'gameState')[2];
    expect(delta.full).toBe(false);
    expect(delta.delta).not.toHaveProperty('currentBetToMatch');
    expect(delta.delta).not.toHaveProperty('minRaise');
    expect(delta.delta).not.toHaveProperty('pot');
  });

  it('a full frame starts a fresh per-key JSON cache (a key reverting to its pre-full value is still sent)', () => {
    const w = emitWorld();
    w.e.emitGameState(w.sock, { tableId: 'P', seats: [{ chips: 1 }] }, true);
    w.e.emitGameState(w.sock, { tableId: 'P', seats: [{ chips: 2 }] });       // delta: caches seats=[2]
    w.e.emitGameState(w.sock, { tableId: 'P', seats: [{ chips: 3 }] }, true); // full: 3
    w.e.emitGameState(w.sock, { tableId: 'P', seats: [{ chips: 2 }] });       // back to 2 — must be sent
    expect(events(w.sock, 'gameState')[3]).toMatchObject({ full: false, delta: { seats: [{ chips: 2 }] } });
    const old = emitWorld(without(EMIT, '    lastSentJson.delete(socket.id);\n'));
    old.e.emitGameState(old.sock, { tableId: 'P', seats: [{ chips: 1 }] }, true);
    old.e.emitGameState(old.sock, { tableId: 'P', seats: [{ chips: 2 }] });
    old.e.emitGameState(old.sock, { tableId: 'P', seats: [{ chips: 3 }] }, true);
    old.e.emitGameState(old.sock, { tableId: 'P', seats: [{ chips: 2 }] });
    expect(events(old.sock, 'gameState')[3].delta).not.toHaveProperty('seats');   // CONTROL: the stale cache dropped it
  });
});

// ══════════════════════════════════════════════════════════════════ F156 ══
describe('F156 — table-scoped seat controls act on the seat at the NAMED table (main or extra), never the wrong one', () => {
  const SITOUT_NEW = '    const session = seatSessionFor(data?.tableId);\n    if (!session) { notSeatedThere(data?.tableId); return; }\n\n    session.sittingOut = !session.sittingOut;';
  const SITOUT_OLD = '    const session = playerSessions.get(socket.id);\n    if (!session) return;\n\n    session.sittingOut = !session.sittingOut;';

  it('sitOut {tableId:B} while it is his turn at A: B sits out; his live hand at A is NOT folded', async () => {
    const w = seatWorld();
    heroToActAtA(w);
    await w.sock.handlers.sitOut({ tableId: 'B' });
    expect(w.A.seats[0].folded).toBe(false);
    expect(w.main.sittingOut).toBe(false);
    expect(w.extra.sittingOut).toBe(true);
    expect([...(w.sitOutTracker.get('B') || [])]).toEqual([0]);
    expect(w.sitOutTracker.get('A')?.has(0) ?? false).toBe(false);
    expect(events(w.sock, 'sitOutToggled')).toEqual([{ sittingOut: true, tableId: 'B' }]);
    // …and B deals him out from the next hand (the engine's sit-out set).
    expect(w.B.startNewHand()).toBe(true);
    expect(w.B.seats[0].holeCards).toHaveLength(0);
  });

  it('CONTROL — pre-F156 (the main session only): Sit Out tapped on B folds his live hand at A and B keeps dealing him', async () => {
    const w = seatWorld({ handlers: { sitOut: without(H.sitOut, SITOUT_NEW, SITOUT_OLD) } });
    heroToActAtA(w);
    await w.sock.handlers.sitOut({ tableId: 'B' });
    expect(w.A.seats[0].folded).toBe(true);
    expect(w.extra.sittingOut).toBe(false);
  });

  it('a payload-less sitOut still acts on the MAIN seat (older clients); an unknown tableId is refused and changes nothing', async () => {
    const w = seatWorld();
    await w.sock.handlers.sitOut();
    expect(w.main.sittingOut).toBe(true);
    expect(events(w.sock, 'sitOutToggled')).toEqual([{ sittingOut: true, tableId: 'A' }]);
    await w.sock.handlers.sitOut({ tableId: 'Z' });
    expect(events(w.sock, 'error')).toEqual([{ message: 'You are not seated at that table.', code: 'not_at_table', tableId: 'Z' }]);
    expect(w.main.sittingOut).toBe(true);
    expect(w.extra.sittingOut).toBe(false);
  });

  it('playerAFK / playerBack {tableId:B} key the extra seat; an unknown table is ignored', async () => {
    const w = seatWorld();
    await w.sock.handlers.playerAFK({ tableId: 'B' });
    expect(w.extra.sittingOut).toBe(true);
    expect(w.sitOutTracker.get('B')?.has(0)).toBe(true);
    await w.sock.handlers.playerBack({ tableId: 'B' });
    expect(w.extra.sittingOut).toBe(false);
    expect(w.sitOutTracker.get('B')?.has(0)).toBe(false);
    await w.sock.handlers.playerAFK({ tableId: 'Z' });
    expect(w.main.sittingOut).toBe(false);
    expect(events(w.sock, 'sitOutToggled')).toEqual([
      { sittingOut: true, reason: 'afk', tableId: 'B' }, { sittingOut: false, reason: 'back', tableId: 'B' },
    ]);
  });

  it('rebuy {tableId:B}: the busted extra seat is topped up from the wallet once; the main seat is untouched', async () => {
    const w = seatWorld();
    w.B.seats[0].chipCount = 0;
    await w.sock.handlers.rebuy({ amount: 2000, tableId: 'B' });
    await flush();
    expect(w.B.seats[0].chipCount).toBe(2000);
    expect(w.A.seats[0].chipCount).toBe(5000);
    expect(w.deducts).toEqual([[101, 2000]]);
    expect(w.refunds).toEqual([]);                                   // not refunded as 'seat_gone' (the extra-session identity check)
    expect(events(w.sock, 'rebuyComplete')).toEqual([{ success: true, newStack: 2000, added: 2000, tableId: 'B' }]);
  });

  it('CONTROL — pre-F156: the extra table\'s auto-rebuy topped up the MAIN seat (A 1500 → 2000) and B stayed busted', async () => {
    const OLD = without(H.rebuy, '    const session = seatSessionFor(data?.tableId);\n    if (!session) {\n      if (!notSeatedThere(data?.tableId)) socket.emit(\'error\', { message: \'Not at a table\' });\n      return;\n    }',
      "    const session = playerSessions.get(socket.id);\n    if (!session) { socket.emit('error', { message: 'Not at a table' }); return; }");
    const w = seatWorld({ handlers: { rebuy: OLD } });
    w.B.seats[0].chipCount = 0;
    w.A.seats[0].chipCount = 1500;
    await w.sock.handlers.rebuy({ amount: 2000, tableId: 'B' });
    await flush();
    expect(w.A.seats[0].chipCount).toBe(2000);
    expect(w.B.seats[0].chipCount).toBe(0);
  });

  it('rebuy for the extra seat whose session ENDED during the deduct is refunded once (seat_gone); an unknown table is refused before any deduct', async () => {
    const w = seatWorld();
    w.B.seats[0].chipCount = 0;
    const gate = deferred();
    w.gates.deduct = gate.p;
    void w.sock.handlers.rebuy({ amount: 2000, tableId: 'B' });
    await flush();
    w.multiTableSessions.set('SH', []);                              // leaveAdditionalTable meanwhile
    gate.resolve();
    await flush();
    expect(w.B.seats[0].chipCount).toBe(0);
    expect(w.refunds).toEqual([[101, 2000]]);
    expect(w.wallet.get(101)).toBe(100_000);
    w.gates.deduct = null;
    await w.sock.handlers.rebuy({ amount: 2000, tableId: 'Z' });
    await flush();
    expect(w.deducts).toEqual([[101, 2000]]);                       // only the first one
    expect(events(w.sock, 'error')).toContainEqual({ message: 'You are not seated at that table.', code: 'not_at_table', tableId: 'Z' });
  });

  it('buyInStateChanged: an extraSession still in the socket\'s list passes; one removed is seat_gone', () => {
    const w = seatWorld();
    const sock = { id: 'SH' } as any;
    const seat = { tableId: 'B', table: w.B, seatIndex: 0, seat: w.B.seats[0] };
    expect(w.m.buyInStateChanged(sock, { userId: 101, extraSession: w.extra, table: { tableId: 'B', table: w.B }, seat })).toBeNull();
    w.multiTableSessions.set('SH', []);
    expect(w.m.buyInStateChanged(sock, { userId: 101, extraSession: w.extra, table: { tableId: 'B', table: w.B }, seat })).toBe('seat_gone');
  });

  it('playerDraw {tableId:B} draws at the extra DRAW table (it went to the main table: "Not a draw game", stood pat by the clock)', async () => {
    const w = seatWorld({ drawB: true });
    const B = w.B as FiveCardDrawTable;
    expect(B.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && B.currentPhase === GamePhase.PreFlop; g++) B.playerCall(B.activeSeatIndex) || B.playerCheck(B.activeSeatIndex);
    expect(B.currentPhase).toBe(GamePhase.Draw1);
    await w.sock.handlers.playerDraw({ discardIndices: [0, 1], tableId: 'B' });
    expect(B.drawsCompleted.has(0)).toBe(true);
    expect(events(w.sock, 'error')).toEqual([]);
    const old = seatWorld({ drawB: true, handlers: { playerDraw: without(H.playerDraw, 'seatSessionFor(data?.tableId)', 'playerSessions.get(socket.id)') } });
    const OB = old.B as FiveCardDrawTable;
    OB.startNewHand();
    for (let g = 0; g < 10 && OB.currentPhase === GamePhase.PreFlop; g++) OB.playerCall(OB.activeSeatIndex) || OB.playerCheck(OB.activeSeatIndex);
    await old.sock.handlers.playerDraw({ discardIndices: [0, 1], tableId: 'B' });
    expect(OB.drawsCompleted.has(0)).toBe(false);                   // CONTROL
    expect(events(old.sock, 'error')).toEqual([expect.objectContaining({ message: 'Not a draw game' })]);
  });

  it('chatMessage {tableId:B} is said at B and names the table; startHand / straddle / bomb pot / rabbit hunt / training / show hand follow the named table', async () => {
    const w = seatWorld();
    await w.sock.handlers.chatMessage({ message: 'gl', tableId: 'B' });
    expect(w.room).toEqual([['table:B', 'chatMessage', expect.objectContaining({ playerName: 'Hero', message: 'gl', tableId: 'B' })]]);
    w.room.length = 0;
    // startHand at B deals B only.
    await w.sock.handlers.startHand({ tableId: 'B' });
    expect(w.B.isHandInProgress()).toBe(true);
    expect(w.A.isHandInProgress()).toBe(false);
    // the bomb pot is armed for B (it was ignored unless it named the main table).
    await w.sock.handlers.triggerBombPot({ tableId: 'B' });
    expect(w.bombPotPending.get('B')).toBe(true);
    expect(w.bombPotPending.has('A')).toBe(false);
    // straddle / startHand at a table he holds no seat at: refused.
    await w.sock.handlers.straddle({ tableId: 'Z' });
    await w.sock.handlers.startHand({ tableId: 'Z' });
    await w.sock.handlers.triggerBombPot({ tableId: 'Z' });
    expect(events(w.sock, 'error').filter((e) => e.code === 'not_at_table').map((e) => e.tableId)).toEqual(['Z', 'Z', 'Z']);
    // Hero folds at B; Show Hand names B: B's room sees B's cards.
    for (let g = 0; g < 6 && w.B.activeSeatIndex !== 0; g++) w.B.playerCall(w.B.activeSeatIndex);
    expect(w.B.playerFold(0)).toBe(true);
    w.room.length = 0;
    await w.sock.handlers.showMuckedHand({ tableId: 'B' });
    expect(w.room).toEqual([['table:B', 'muckedHandRevealed', expect.objectContaining({ tableId: 'B', seatIndex: 0, playerName: 'Hero' })]]);
    // the hand ends; the rabbit hunt is B's and says so.
    for (let g = 0; g < 50 && w.B.isHandInProgress(); g++) w.B.playerFold(w.B.activeSeatIndex);
    expect(w.B.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.B.communityCards).toHaveLength(0);                      // ended pre-flop: the whole board is huntable
    w.sock.handlers.rabbitHunt({ tableId: 'B' });
    expect(events(w.sock, 'rabbitHuntResult')).toEqual([{ cards: expect.any(Array), tableId: 'B' }]);
    expect(events(w.sock, 'rabbitHuntResult')[0].cards).toHaveLength(5);
    // training at B: a RAW full snapshot, never the main delta baseline.
    await w.sock.handlers.toggleTraining({ tableId: 'B' });
    expect(w.extra.trainingEnabled).toBe(true);
    expect(w.main.trainingEnabled).toBe(false);
    expect(events(w.sock, 'trainingToggled')).toEqual([{ enabled: true, tableId: 'B' }]);
    expect(events(w.sock, 'gameState')).toEqual([expect.objectContaining({ full: true, state: expect.objectContaining({ tableId: 'B', yourSeat: 0 }) })]);
    expect(w.lastSentState.has('SH')).toBe(false);
  });

  it('postMissedBlinds: an unknown table answers no_session FOR that table; the extra seat answers for B; payload-less = the main seat', async () => {
    const w = seatWorld();
    await w.sock.handlers.postMissedBlinds({ tableId: 'Z' });
    await w.sock.handlers.postMissedBlinds({ tableId: 'B' });
    await w.sock.handlers.postMissedBlinds();
    expect(events(w.sock, 'missedBlindsError')).toEqual([
      { code: 'no_session', message: 'Not seated at that table.', tableId: 'Z' },
      expect.objectContaining({ code: 'not_in_hand', tableId: 'B' }),
      expect.objectContaining({ code: 'not_in_hand', tableId: 'A' }),
    ]);
  });
});

// ── F156 — the sit-out limit holds an extra seat too ──
describe('F156 — an EXTRA seat that sits out SIT_OUT_HANDS_LIMIT hands is stood up and credited (only that seat)', () => {
  const CODE = [
    slice('const SIT_OUT_HANDS_LIMIT = 30;', '\n}\n'),
    fnSrc('function processPendingSeatRemovals('),
    SEAT_TEARDOWN_SRC,
    fnSrc('function seatPlayedByAnotherAccount('),
  ].join('\n');
  const EXTRA_LOOP = slice('  // 2026-10-21 (gameplay F156) — an EXTRA-table (multi-table) seat sitting out', '  if (extraStoodUp) broadcastGameState(tableId);\n');
  function world(code = CODE) {
    const B = new PokerTable(cfg('B'));
    B.sitDown(0, 'Hero', 5000, 'hero-b', false);
    B.sitDown(1, 'Bot1', 5000, 'ai-1', true);
    B.sitDown(2, 'Bot2', 5000, 'ai-2', true);
    const sock = fakeSocket('SH');
    sock.join('table:B');
    const credits: Array<{ userId: number; chips: number; reason: string }> = [];
    const extra = { socketId: 'SH', tableId: 'B', seatIndex: 0, playerName: 'Hero', playerId: 'hero-b', sittingOut: true };
    const main = { socketId: 'SH', tableId: 'A', seatIndex: 3, playerName: 'Hero', playerId: 'hero-a', sittingOut: false };
    const playerSessions = new Map<string, any>([['SH', main]]);
    const multiTableSessions = new Map<string, any[]>([['SH', [extra]]]);
    const scope: Record<string, unknown> = {
      tableKindOf: () => 'cash', challengeTables: new Map(), isTournamentTable: () => false, isFixedRosterQuickTable: () => false,
      tableManager: { getTable: (id: string) => (id === 'B' ? B : undefined) }, playerSessions, multiTableSessions,
      authSessions: new Map([['SH', { userId: 101, username: 'hero' }]]), spectators: new Map(), pendingSeatRemovalAfterHand: new Map(),
      sitOutTracker: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), reservedSeats: new Map(),
      io: { sockets: { sockets: new Map([['SH', sock]]) } },
      creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ userId, chips: seat.chipCount, reason }),
      scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {}, handlePlayerLeave() { throw new Error('the MAIN seat is not at B'); },
      DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    };
    const { exports: m } = load(code, scope, '{ standUpSeatsPastSitOutLimit, SIT_OUT_HANDS_LIMIT }');
    const hand = () => {
      B.setSittingOutSeats(extra.sittingOut ? [0] : []);
      expect(B.startNewHand()).toBe(true);
      for (let g = 0; g < 200 && B.isHandInProgress(); g++) {
        const a = B.activeSeatIndex;
        if (!(B.playerCheck(a) || B.playerCall(a))) B.playerFold(a);
      }
      m.standUpSeatsPastSitOutLimit('B', B);
    };
    return { B, m, sock, credits, extra, main, playerSessions, multiTableSessions, hand };
  }

  it('limit 30: seated through hand 29; at 30 the extra seat is credited once and stood up; the main session and its table are untouched', () => {
    const w = world();
    for (let h = 1; h < 30; h++) w.hand();
    expect(w.B.seats[0].state).toBe('occupied');
    w.hand();
    expect(w.B.seats[0].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 101, chips: 5000, reason: 'sit_out_limit' }]);
    expect(w.multiTableSessions.has('SH')).toBe(false);
    expect(w.playerSessions.get('SH')).toBe(w.main);
    expect(w.sock.rooms.has('table:B')).toBe(false);
    expect(w.sock.emitted).toEqual(expect.arrayContaining([
      ['seatVacated', { tableId: 'B', seatIndex: 0, reason: 'sit_out_limit' }],
      ['sitOutToggled', expect.objectContaining({ sittingOut: false, reason: 'sit_out_limit', stoodUp: true, tableId: 'B' })],
      ['error', expect.objectContaining({ code: 'sit_out_limit', tableId: 'B' })],
    ]));
  });

  it('CONTROL — without the extra-seat loop the sitting-out extra seat holds its seat forever', () => {
    const w = world(without(CODE, EXTRA_LOOP));
    for (let h = 0; h < 35; h++) w.hand();
    expect(w.B.seats[0].state).toBe('occupied');
    expect(w.credits).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════ F73 / F85 harness ══
/** The LAST 'disconnect' handler (the seat one; the first is the socket guard's IP / rate-limit cleanup). */
const DISCONNECT = slice("socket.on('disconnect', async () => {", '\n  });', SRC.lastIndexOf("socket.on('disconnect', async () => {"));
const DEPARTURE = fnSrc('function cashOutAdditionalSeatsOnDeparture(');

function departureWorld(code: string) {
  const B = new PokerTable(cfg('B'));
  for (let i = 0; i < 3; i++) expect(B.sitDown(i, `P${i}`, 5000, `b${i}`, false)).toBe(true);
  const sock = fakeSocket('SH');
  const credits: Array<{ userId: number; chips: number; reason: string }> = [];
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>([['SH', [{ socketId: 'SH', tableId: 'B', seatIndex: 0, playerName: 'P0', playerId: 'b0' }]]]);
  const authSessions = new Map<string, any>([['SH', { userId: 101, username: 'hero' }]]);
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 'B' ? B : undefined) },
    playerSessions, multiTableSessions, authSessions, pendingSeatRemovalAfterHand, reservedSeats: new Map(),
    sitOutTracker: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), spectators: new Map(),
    lastSentState: new Map(), lastSentJson: new Map(), lastEmoteTime: new Map(), lastReactionTime: new Map(), lastChatTime: new Map(),
    isTournamentTable: () => false, isFixedRosterQuickTable: () => false, quickTables: new Set(),
    io: { sockets: { sockets: new Map() } },
    creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ userId, chips: seat.chipCount, reason }),
    scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {}, releaseSeatedSlot() {},
    DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
  };
  const { exports: m } = load(code, scope, '{ wire, cashOutAdditionalSeatsOnDeparture, processPendingSeatRemovals }');
  B.on('handResult', () => m.processPendingSeatRemovals('B'));
  m.wire(sock);
  return { B, sock, m, credits, pendingSeatRemovalAfterHand, multiTableSessions, authSessions };
}
const DEPARTURE_CODE = (disconnect = DISCONNECT, departure = DEPARTURE) => [
  fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind'),
  departure, fnSrc('function processPendingSeatRemovals('), fnSrc('function endStaleSessionsAtSeat('),
  SEAT_TEARDOWN_SRC, fnSrc('function seatPlayedByAnotherAccount('),
  `function wire(socket) {\n${disconnect}\n}`,
].join('\n');

// ═══════════════════════════════════════════════════════════════════ F73 ══
describe('F73 — a disconnect whose socket holds ONLY extra-table seats cashes them out', () => {
  it('no main seat (stood up by the sit-out limit), an extra seat at B between hands: the drop credits its 5,000 once and frees the seat and the socket\'s entry', async () => {
    const w = departureWorld(DEPARTURE_CODE());
    w.sock.connected = false;
    await w.sock.handlers.disconnect();
    expect(w.B.seats[0].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 101, chips: 5000, reason: 'additional_table_disconnect' }]);
    expect(w.multiTableSessions.has('SH')).toBe(false);              // the next sign-in's orphan scan is not blocked
    expect(w.authSessions.has('SH')).toBe(false);
  });

  it('CONTROL — pre-F73 (handlePlayerLeave returned at once with no main session): the stack stranded, the dead entry kept', async () => {
    const LINE = "    cashOutAdditionalSeatsOnDeparture(socket, authSession, 'additional_table_disconnect');\n    handlePlayerLeave(socket, 'kept');";
    const w = departureWorld(DEPARTURE_CODE(without(DISCONNECT, LINE, "    handlePlayerLeave(socket, 'kept');")));
    await w.sock.handlers.disconnect();
    expect(w.B.seats[0].state).toBe('occupied');
    expect(w.credits).toEqual([]);
    expect(w.multiTableSessions.has('SH')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════ F85 ══
describe('F85 — a dropped socket keeps its extra seat\'s LIVE hand (it is no longer folded out of turn)', () => {
  /** B: hero (seat 0) has chips in the pot, is still in the hand and is NOT on the clock. */
  function heroInPotOffClock(w: ReturnType<typeof departureWorld>) {
    expect(w.B.startNewHand()).toBe(true);
    for (let g = 0; g < 6 && w.B.activeSeatIndex !== 0; g++) w.B.playerCall(w.B.activeSeatIndex);
    expect(w.B.activeSeatIndex).toBe(0);
    expect(w.B.playerCall(0)).toBe(true);                             // he calls; the action moves on
    expect(w.B.activeSeatIndex).not.toBe(0);
    expect(w.B.seats[0].totalInvestedThisHand).toBeGreaterThan(0);
  }
  /** What the session-less turn clock does for him (autoActForSeat: check when free, else fold); others check / call. */
  const playOut = (t: PokerTable) => {
    for (let g = 0; g < 200 && t.isHandInProgress(); g++) {
      const a = t.activeSeatIndex;
      if (a === 0) { if (!t.playerCheck(0)) t.playerFold(0); continue; }
      if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
    }
  };

  it('off the clock: not folded, the stand-up waits for the hand\'s end; then his FINAL stack is credited once; no chip created or lost', async () => {
    const w = departureWorld(DEPARTURE_CODE());
    heroInPotOffClock(w);
    const total = () => w.B.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (w.B.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0)
      + w.credits.reduce((s, c) => s + c.chips, 0);
    const before = total();
    w.m.cashOutAdditionalSeatsOnDeparture(w.sock, w.authSessions.get('SH'), 'additional_table_disconnect');
    expect(w.B.seats[0].folded).toBe(false);
    expect(w.B.seats[0].state).toBe('occupied');
    expect(w.pendingSeatRemovalAfterHand.get('B')?.has(0)).toBe(true);
    expect(w.multiTableSessions.has('SH')).toBe(false);
    playOut(w.B);
    expect(w.B.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.B.seats[0].state).toBe('empty');
    expect(w.credits).toHaveLength(1);
    expect(w.credits[0]).toMatchObject({ userId: 101, reason: 'leave_after_hand' });
    expect(total()).toBe(before);
  });

  it('CONTROL — pre-F85 (the leave teardown): folded out of turn at once, his chips in the pot forfeited', () => {
    const w = departureWorld(DEPARTURE_CODE(DISCONNECT, without(DEPARTURE, ',\n            { keepHandOnDeparture: true });   // F85', ');')));
    heroInPotOffClock(w);
    w.m.cashOutAdditionalSeatsOnDeparture(w.sock, w.authSessions.get('SH'), 'additional_table_disconnect');
    expect(w.B.seats[0].folded).toBe(true);
  });

  it('on the clock with a free check (the big blind\'s option): CHECKED for him, never folded (Z6)', () => {
    const w = departureWorld(DEPARTURE_CODE());
    expect(w.B.startNewHand()).toBe(true);
    const bb = w.B.seats.findIndex((s) => s.currentBet === 50);
    w.multiTableSessions.set('SH', [{ socketId: 'SH', tableId: 'B', seatIndex: bb, playerName: `P${bb}`, playerId: `b${bb}` }]);
    for (let g = 0; g < 6 && w.B.activeSeatIndex !== bb; g++) w.B.playerCall(w.B.activeSeatIndex);
    expect(w.B.activeSeatIndex).toBe(bb);
    expect(w.B.currentBetToMatch - w.B.seats[bb].currentBet).toBe(0);
    w.m.cashOutAdditionalSeatsOnDeparture(w.sock, w.authSessions.get('SH'), 'additional_table_disconnect');
    expect(w.B.seats[bb].folded).toBe(false);
    expect(w.B.currentPhase).toBe(GamePhase.Flop);
  });
});

// ═══════════════════════════════════════════════════════════════════ F62 ══
describe('F62 — one socket never holds two seats (two hands) at one table', () => {
  const JOIN_EXTRA = handlerSrc('joinAdditionalTable', '\n  });\n');
  const JOIN_TABLE = handlerSrc('joinTable', '\n    })(); }\n  );');
  const EXTRA_REFUSAL = "    if (socketHasSessionAt(socket.id, tableId)) {\n      socket.emit('error', { message: 'You already have a seat at this table.', code: 'already_seated', tableId });\n      return;\n    }\n";
  function joinWorld(handlers: string) {
    const T = new PokerTable(cfg('T'));
    T.sitDown(0, 'Bob', 5000, 'p-bob', false);
    const tables = new Map<string, PokerTable>([['T', T]]);
    const playerSessions = new Map<string, any>();
    const multiTableSessions = new Map<string, any[]>();
    const deducts: number[] = [];
    const sock = fakeSocket('SA');
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => tables.get(id) }, playerSessions, multiTableSessions,
      authSessions: new Map([['SA', { userId: 101, username: 'alice' }]]), reservedSeats: new Map(), spectators: new Map(),
      assertPlayable: async () => null, emitPlayRefusal() {}, buyInSocketGone: async () => false, blockedByMaintenance: () => false,
      isUserBanned: async () => false, isTournamentTable: () => false, isPublicCashTable: () => true, joinTableRefusalReason: () => null,
      clubJoinGrants: new WeakSet(), challengeTables: new Map(), isFixedRosterTable: () => false,
      seatNameForSocket: () => 'Alice', sanitizeSeatAvatar: () => undefined, takeAiSeatForJoin: () => -1, aiSeatTakeableNow: () => false,
      ensureChipsForBuyIn: async () => 1_000_000, deductChips: async (_u: number, n: number) => { deducts.push(n); return true; },
      addChipsToUser: async () => true, auditLog() {}, clearGhostSeatsForUser: () => 0, detachSocketFromOtherTables() {},
      uuidv4: () => `u${Math.random().toString(36).slice(2, 8)}`, progressionManager: { getOrCreateProgress() {} },
      ensureTableProgressListener() {}, fillWithAI() {}, getGameStateForPlayer: () => ({}), broadcastGameState() {}, scheduleAIAction() {},
      sendProgressToPlayer() {}, ipSeatedSlots: new Map(), clientIp: '10.0.0.1', noteSameNetworkSeat() {}, MAX_SEATS,
      handlePlayerLeave: (s: any) => { playerSessions.delete(s.id); }, console: quiet,
    };
    const { exports: m } = load(`${fnSrc('function socketHasSessionAt(')}\nfunction wire(socket) {\n${handlers}\n}`, scope, '{ wire }');
    m.wire(sock);
    const aliceSeats = () => T.seats.filter((s) => s.state === 'occupied' && s.playerName === 'Alice').length;
    return { T, sock, playerSessions, multiTableSessions, deducts, aliceSeats };
  }

  it('joinAdditionalTable at the table of his MAIN seat: refused (already_seated) before the buy-in; one seat', async () => {
    const w = joinWorld(JOIN_EXTRA);
    w.T.sitDown(2, 'Alice', 1000, 'p-alice', false);
    w.playerSessions.set('SA', { socketId: 'SA', tableId: 'T', seatIndex: 2, playerName: 'Alice', playerId: 'p-alice' });
    await w.sock.handlers.joinAdditionalTable({ tableId: 'T', playerName: 'Alice', buyIn: 1000 });
    await flush();
    expect(events(w.sock, 'error')).toEqual([{ message: 'You already have a seat at this table.', code: 'already_seated', tableId: 'T' }]);
    expect(w.deducts).toEqual([]);
    expect(w.aliceSeats()).toBe(1);
    expect(w.multiTableSessions.has('SA')).toBe(false);
  });

  it('CONTROL — pre-F62: the same request bought a SECOND seat at the same table (both dealt in: four hole cards)', async () => {
    const w = joinWorld(without(JOIN_EXTRA, EXTRA_REFUSAL));
    w.T.sitDown(2, 'Alice', 1000, 'p-alice', false);
    w.playerSessions.set('SA', { socketId: 'SA', tableId: 'T', seatIndex: 2, playerName: 'Alice', playerId: 'p-alice' });
    await w.sock.handlers.joinAdditionalTable({ tableId: 'T', playerName: 'Alice', buyIn: 1000 });
    await flush();
    expect(w.deducts).toEqual([1000]);
    expect(w.aliceSeats()).toBe(2);
  });

  it('joinTable at a table this socket already plays an EXTRA seat at: refused before anything is left, deducted or seated', async () => {
    const w = joinWorld(JOIN_TABLE);
    w.T.sitDown(2, 'Alice', 1000, 'p-alice', false);
    w.multiTableSessions.set('SA', [{ socketId: 'SA', tableId: 'T', seatIndex: 2, playerName: 'Alice', playerId: 'p-alice' }]);
    await w.sock.handlers.joinTable({ tableId: 'T', playerName: 'Alice', seatIndex: -1, buyIn: 1000 });
    await flush();
    expect(events(w.sock, 'error')).toEqual([{ message: 'You already have a seat at this table.', code: 'already_seated', tableId: 'T' }]);
    expect(w.deducts).toEqual([]);
    expect(w.aliceSeats()).toBe(1);
  });

  it('a buy-in racing another seat of this socket at the same table is cancelled (BuyInExpectation.notSeatedAt → already_seated)', () => {
    const playerSessions = new Map<string, any>();
    const multiTableSessions = new Map<string, any[]>();
    const { exports: m } = load(slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n') + fnSrc('function socketHasSessionAt('), {
      playerSessions, multiTableSessions, authSessions: new Map([['SA', { userId: 101 }]]), tableManager: { getTable: () => undefined },
    }, '{ buyInStateChanged }');
    const sock = { id: 'SA' } as any;
    expect(m.buyInStateChanged(sock, { userId: 101, notSeatedAt: 'T' })).toBeNull();
    multiTableSessions.set('SA', [{ tableId: 'T', seatIndex: 4 }]);
    expect(m.buyInStateChanged(sock, { userId: 101, notSeatedAt: 'T' })).toBe('already_seated');
    multiTableSessions.clear();
    playerSessions.set('SA', { tableId: 'T', seatIndex: 2 });
    expect(m.buyInStateChanged(sock, { userId: 101, notSeatedAt: 'T' })).toBe('already_seated');
  });

  it('wiring: joinAdditionalTable refuses before the AI stand-up and the deduct; joinTable before the leave; quickPlay skips such a table', () => {
    expect(JOIN_EXTRA.indexOf(EXTRA_REFUSAL)).toBeLessThan(JOIN_EXTRA.indexOf('takeAiSeatForJoin('));
    expect(JOIN_EXTRA).toContain('notSeatedAt: tableId');
    expect(JOIN_TABLE.indexOf("code: 'already_seated'")).toBeLessThan(JOIN_TABLE.indexOf('handlePlayerLeave(socket)'));
    expect(JOIN_TABLE).toContain('mainSession: null, notSeatedAt: tableId');
    const qp = handlerSrc('quickPlay', '\n    })(); }\n  );');
    expect(qp).toContain('if (socketHasSessionAt(socket.id, candidate.tableId)) continue;');
    expect(qp).toContain('notSeatedAt: chosenTableId');
  });
});

// ══════════════════════════════════════════════════════════════════ G166 ══
describe('G166 — insuranceSettled reaches the seat\'s socket when it is an EXTRA-table seat', () => {
  const SETTLE = fnSrc('function settleInsuranceForHand(');
  const NEW_EMIT = `    const settledSid = socketIdForSeat(tableId, co.seatIndex);
    if (settledSid) {
      io.sockets.sockets.get(settledSid)?.emit('insuranceSettled', { cashout: co.cashout, delta, stack: iseat!.chipCount, tableId, handNumber: co.handNumber });
    }`;
  const OLD_EMIT = `    for (const [sid, s] of playerSessions) {
      if (s.tableId === tableId && s.seatIndex === co.seatIndex) {
        io.sockets.sockets.get(sid)?.emit('insuranceSettled', { cashout: co.cashout, delta, stack: iseat!.chipCount, tableId, handNumber: co.handNumber });
        break;
      }
    }`;
  function world(settle = SETTLE) {
    const X = new PokerTable(cfg('X'));
    X.sitDown(0, 'Hero', 3000, 'p-hero', false);
    X.sitDown(1, 'Opp', 9000, 'p-opp', false);
    const sock = fakeSocket('SH');
    const insuranceCashouts = new Map<string, any[]>([['X', [{ seatIndex: 0, playerId: 'p-hero', cashout: 4000, handNumber: X.handNumber, equityPct: 70, pot: 6000 }]]]);
    const scope: Record<string, unknown> = {
      insuranceCashouts, insuranceSettlementDelta, insuranceStats: { settled: 0, voided: 0 }, auditLog() {}, broadcastGameState() {},
      playerSessions: new Map([['SH', { socketId: 'SH', tableId: 'MAIN', seatIndex: 3 }]]),          // his main seat: another table
      multiTableSessions: new Map([['SH', [{ socketId: 'SH', tableId: 'X', seatIndex: 0 }]]]),       // the insured seat: an extra seat
      io: { sockets: { sockets: new Map([['SH', sock]]) } },
    };
    const code = `const lastInsuranceSettlement = new Map();\n${fnSrc('function socketIdForSeat(')}\n${settle}`;
    const { exports: m } = load(code, scope, '{ settleInsuranceForHand }');
    return { X, sock, m };
  }

  it('the house pays an outdrawn extra-table seat: its socket is told (insuranceSettled with the table)', () => {
    const w = world();
    w.m.settleInsuranceForHand('X', w.X, new Map([[0, 0]]));
    expect(w.X.seats[0].chipCount).toBe(3000 + 4000);
    expect(events(w.sock, 'insuranceSettled')).toEqual([expect.objectContaining({ cashout: 4000, delta: 4000, stack: 7000, tableId: 'X' })]);
  });

  it('CONTROL — pre-G166 (main sessions only): the stack changed and the extra-table player was told nothing', () => {
    const w = world(without(SETTLE, NEW_EMIT, OLD_EMIT));
    w.m.settleInsuranceForHand('X', w.X, new Map([[0, 0]]));
    expect(w.X.seats[0].chipCount).toBe(7000);
    expect(events(w.sock, 'insuranceSettled')).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════ G191 ══
describe('G191 — a second device joining a table the first device MULTI-TABLES there never gives the account two seats', () => {
  const CLEAR = fnSrc('function clearGhostSeatsForUser(');
  const STEP_1B = slice('  // 1b. 2026-10-21 (gameplay G191)', '  // 2. This account');
  function world(clear = CLEAR) {
    const T = new PokerTable(cfg('T'));
    T.sitDown(5, 'Alice', 4000, 'player-x', false);                  // device A's extra seat (joinAdditionalTable stamps player-<uuid>)
    T.sitDown(1, 'Bob', 5000, 'p-bob', false);
    const sockA = fakeSocket('sA');
    sockA.join('table:T');
    const credits: Array<{ userId: number; chips: number; reason: string }> = [];
    const playerSessions = new Map<string, any>([['sA', { socketId: 'sA', tableId: 'T2', seatIndex: 0, playerName: 'Alice', playerId: 'p-main' }]]);
    const multiTableSessions = new Map<string, any[]>([['sA', [{ socketId: 'sA', tableId: 'T', seatIndex: 5, playerName: 'Alice', playerId: 'player-x' }]]]);
    const authSessions = new Map<string, any>([['sA', { userId: 101, username: 'alice' }], ['sB', { userId: 101, username: 'alice' }]]);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 'T' ? T : undefined) }, playerSessions, multiTableSessions, authSessions,
      reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(),
      pendingAutoStartTimers: new Map(), isTournamentTable: () => false, isFixedRosterQuickTable: () => false,
      io: { sockets: { sockets: new Map([['sA', sockA]]) } },
      creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ userId, chips: seat.chipCount, reason }),
      scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {}, auditLog() {},
      DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    };
    const code = [clear, fnSrc('function seatPlayedByAnotherAccount('), fnSrc('function seatReservedByOtherAccount('),
      fnSrc('function otherSessionHoldsSeat('), fnSrc('function processPendingSeatRemovals('), fnSrc('function endStaleSessionsAtSeat('), SEAT_TEARDOWN_SRC].join('\n');
    const { exports: m } = load(code, scope, '{ clearGhostSeatsForUser, processPendingSeatRemovals }');
    return { T, m, sockA, credits, playerSessions, multiTableSessions };
  }

  it('device B joins T: device A\'s extra seat at T is credited once and stood up, its entry removed, device A told (seatVacated); its main seat stays', () => {
    const w = world();
    expect(w.m.clearGhostSeatsForUser(101, 'T', 'sB')).toBe(1);
    expect(w.T.seats[5].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 101, chips: 4000, reason: 'ghost_seat_extra_session_scan' }]);
    expect(w.multiTableSessions.has('sA')).toBe(false);
    expect(w.playerSessions.get('sA')).toMatchObject({ tableId: 'T2' });
    expect(w.sockA.rooms.has('table:T')).toBe(false);
    expect(events(w.sockA, 'seatVacated')).toEqual([{ tableId: 'T', seatIndex: 5, reason: 'joined_new_seat' }]);
  });

  it('CONTROL — pre-G191 (step 1 scanned playerSessions only): nothing cleared — the account kept that seat and got a second one', () => {
    const w = world(without(CLEAR, STEP_1B, '  // 2. This account'));
    expect(w.m.clearGhostSeatsForUser(101, 'T', 'sB')).toBe(0);
    expect(w.T.seats[5].state).toBe('occupied');
  });

  it('mid-hand: the extra seat\'s blind stays in the pot (teardownSeat defers the stand-up); its final stack is credited once; another account\'s extra seat is never touched', () => {
    const w = world();
    w.T.on('handResult', () => w.m.processPendingSeatRemovals('T'));
    expect(w.T.startNewHand()).toBe(true);                             // heads-up: Alice (seat 5) posted a blind
    const blind = w.T.seats[5].totalInvestedThisHand;
    expect(blind).toBeGreaterThan(0);
    expect(w.m.clearGhostSeatsForUser(102, 'T', 'sB')).toBe(0);         // a different account: untouched
    expect(w.multiTableSessions.get('sA')).toHaveLength(1);
    expect(w.m.clearGhostSeatsForUser(101, 'T', 'sB')).toBe(1);
    expect(w.multiTableSessions.has('sA')).toBe(false);
    expect(w.T.currentPhase).toBe(GamePhase.HandComplete);              // folded out → Bob wins the blinds
    expect(w.T.seats[5].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 101, chips: 4000 - blind, reason: 'leave_after_hand' }]);
    expect(w.T.seats[1].chipCount + w.credits[0].chips).toBe(9000);      // nothing created or lost
  });
});

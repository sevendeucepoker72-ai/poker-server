/**
 * .online R2 (2026-10-11) — S2 table state + handlers, running the REAL
 * src/index.ts text (sliced + transpiled) against the REAL engine:
 *   GAME-11 / ECON-13  progression, scratch ticks and ELO only for seats DEALT
 *           INTO the hand; a cash seat sat out SIT_OUT_HANDS_LIMIT hands is
 *           stood up + cashed out; fast mode is per player
 *   C11     isFirstActor / canBombPot (always-present booleans)
 *   GAME-12 bomb pots only at Hold'em / Omaha ring tables; no straddle at a
 *           tournament or quick table
 *   TABLEUI-11  spectate next/prev and spectateTournament send a FULL state;
 *           seat moves drop the delta baseline
 *   GAME-5  a human's draw hands the turn on (scheduleAIAction)
 *   Addendum  tickReservedSeatHands runs after the insurance settlement
 *   GAME P3 joinByInviteCode never pushes the spectator view to seated peers;
 *           the chip-velocity monitor runs on table winnings, alerts once,
 *           and bans only when CHIP_VELOCITY_AUTOBAN=1
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { cardToString } from '../src/game/Card';
import { HandRank } from '../src/game/HandEvaluator';
import { SRC, slice, fnSrc, handlerSrc, load, flush, SEAT_TEARDOWN_SRC, SEAT_SESSION_FOR_SRC } from './helpers/indexSource';

const T = 'cash-1';
const quiet = { log() {}, warn() {}, error() {} };
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const cfg = (over: Record<string, unknown> = {}) => ({ tableId: T, tableName: T, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, ...over } as any);
const playOut = (t: PokerTable) => {
  let g = 0;
  while (t.isHandInProgress() && g++ < 200) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
};
/** The table-kind registries + tableKindOf / straddleAllowedAt / bombPotAllowedAt / isPlainHoldemTable. */
const KIND_SRC = [
  fnSrc('function tableKindOf('),
  fnSrc('function bombPotAllowedAt('),
  fnSrc('function straddleAllowedAt('),
  fnSrc('function isPlainHoldemTable('),
].join('\n');
function registries(over: { tournament?: boolean; private?: boolean; aof?: boolean } = {}) {
  return {
    isTournamentTable: () => !!over.tournament, spinGoMultipliers: new Map(), careerTables: new Map(),
    allInOrFoldTables: new Set(over.aof ? [T] : []), quickTables: new Set(over.aof ? [T] : []), challengeTables: new Map(),
    clubTableIds: new Set(), privateTableIds: new Set(over.private ? [T] : []), PokerTable, OmahaTable,
  };
}
function fakeSocket(id: string) {
  const emitted: Array<[string, any]> = [];
  const handlers: Record<string, (...a: any[]) => any> = {};
  return { id, emitted, handlers, connected: true, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, d: any) => emitted.push([ev, d]), join() {}, leave() {} };
}

describe('GAME-11 / ECON-13 — only seats DEALT INTO the hand are credited with it', () => {
  const HHC = slice('async function handleHandComplete(', '\n}\n');
  function hhcWorld(code = HHC) {
    const table = new PokerTable(cfg());
    table.sitDown(0, 'Ann', 5000, 'pA', false);
    table.sitDown(1, 'Ben', 5000, 'pB', false);                   // sitting out
    table.sitDown(2, 'Bot', 5000, 'ai-2', true);
    table.setSittingOutSeats([1]);
    const calls: Array<[string, unknown]> = [];
    const progressionManager = new Proxy({}, {
      get: (_t, k) => (k === 'getClientProgress' ? () => ({ hydrated: true, xp: 1, level: 1, achievements: [] })
        : k === 'getProgress' ? () => ({}) : (...a: unknown[]) => { calls.push([String(k), a[0]]); }),
    });
    const scratch: number[] = [];
    const merges: number[] = [];
    const playerSessions = new Map<string, any>([
      ['sA', { socketId: 'sA', tableId: T, seatIndex: 0, playerName: 'Ann', playerId: 'pA', sittingOut: false }],
      ['sB', { socketId: 'sB', tableId: T, seatIndex: 1, playerName: 'Ben', playerId: 'pB', sittingOut: true }],
    ]);
    const authSessions = new Map<string, any>([['sA', { userId: 101, username: 'ann' }], ['sB', { userId: 102, username: 'ben' }]]);
    const scope = {
      tableManager: { getTable: () => table }, bombPotActive: new Map(), playerSessions, authSessions, progressionManager, HandRank,
      mergeUserStats: async (uid: number) => { merges.push(uid); }, saveProgress: async () => true,
      tickScratchProgress: async (uid: number) => { scratch.push(uid); return false; },
      io: { sockets: { sockets: new Map() } }, console: quiet,
      // R3 (S3-2) — the per-seat chips-won resolution (only read when a chips-won gate is open).
      multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
    };
    const R3_HELPERS = [fnSrc('function chipsWonSeatsOfHand('), fnSrc('function dealtInSeatAccount('), fnSrc('function seatPlayedByAnotherAccount(')].join('\n');
    const { exports: m } = load(`${code}\n${R3_HELPERS}`, scope, 'handleHandComplete');
    table.startNewHand();
    expect(table.seats[1].holeCards).toHaveLength(0);               // sitting out: not dealt
    playOut(table);
    return { table, m, calls, scratch, merges };
  }

  it('the sitting-out seat gets no hand played, no XP, no win/loss, no ELO, no save, no scratch tick; the dealt-in human does', async () => {
    const w = hhcWorld();
    await w.m(T, w.table.lastHandResult!.winners.map((x) => ({ seatIndex: x.seatIndex, amount: x.chipsWon })));
    await flush();
    const of = (pid: string) => w.calls.filter(([, p]) => p === pid).map(([k]) => k);
    expect(of('pA')).toEqual(expect.arrayContaining(['recordHandPlayed', 'addXP']));
    expect(of('pB')).toEqual([]);
    expect(w.scratch).toEqual([101]);
    expect(w.merges).toEqual([101]);
  });

  it('CONTROL — pre-R2 (every session at the table): the sitting-out seat was credited a hand, XP and a scratch tick', async () => {
    const code = HHC.replace('dealtInSeats.has(session.seatIndex)', 'true').replace('dealtInSockets.has(socketId) ? authSessions.get(socketId) : undefined', 'authSessions.get(socketId)');
    expect(code).not.toBe(HHC);
    const w = hhcWorld(code);
    await w.m(T, w.table.lastHandResult!.winners.map((x) => ({ seatIndex: x.seatIndex, amount: x.chipsWon })));
    await flush();
    expect(w.calls.filter(([, p]) => p === 'pB').map(([k]) => k)).toEqual(expect.arrayContaining(['recordHandPlayed', 'addXP']));
    expect(w.scratch.sort()).toEqual([101, 102]);
  });

  it('Addendum — wiring: tickReservedSeatHands runs AFTER settleInsuranceForHand (and before the bust-check capture)', () => {
    const settle = HHC.indexOf('settleInsuranceForHand(tableId, table, totalWonPerSeat);');
    const tick = HHC.indexOf('tickReservedSeatHands(tableId);');
    const capture = HHC.indexOf('const tournamentBustCheck = captureTournamentBustCheck(');
    expect(settle).toBeGreaterThan(-1);
    expect(tick).toBeGreaterThan(settle);
    expect(capture).toBeGreaterThan(tick);
    expect(HHC.split('tickReservedSeatHands(tableId);').length).toBe(2);   // exactly once
  });
});

describe('GAME-11 — a cash seat that sat out SIT_OUT_HANDS_LIMIT hands is stood up and cashed out', () => {
  const CODE = [
    slice('const SIT_OUT_HANDS_LIMIT = 30;', '\n}\n'),
    fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind'),
    fnSrc('function processPendingSeatRemovals('),
    SEAT_TEARDOWN_SRC,
    fnSrc('function seatPlayedByAnotherAccount('),
    KIND_SRC,
  ].join('\n');
  function sitOutWorld(opts: { tournament?: boolean } = {}) {
    const table = new PokerTable(cfg());
    table.sitDown(0, 'Ann', 5000, 'pA', false);
    table.sitDown(1, 'Bot1', 5000, 'ai-1', true);
    table.sitDown(2, 'Bot2', 5000, 'ai-2', true);
    const sock = fakeSocket('sA');
    const credits: Array<{ userId: number; chips: number; reason: string }> = [];
    const playerSessions = new Map<string, any>([['sA', { socketId: 'sA', tableId: T, seatIndex: 0, playerName: 'Ann', playerId: 'pA', sittingOut: true }]]);
    const spectators = new Map<string, Set<string>>();
    const scope = {
      ...registries({ tournament: opts.tournament }),
      tableManager: { getTable: () => table }, playerSessions, authSessions: new Map([['sA', { userId: 101, username: 'ann' }]]),
      multiTableSessions: new Map(), spectators, pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(),
      aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), lastEmoteTime: new Map(), lastReactionTime: new Map(), lastChatTime: new Map(),
      io: { sockets: { sockets: new Map([['sA', sock]]) } },
      creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ userId, chips: seat.chipCount, reason }),
      scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {}, releaseSeatedSlot() {}, cleanupQuickTable() {},
      detachSocketFromOtherTables() {}, getGameStateForPlayer: () => ({}), emitGameState: (s: any, st: any, full: boolean) => s.emit('gameState', { full, state: st }),
      DrawPhases: DRAWS, FiveCardDrawTable, GamePhase, MAX_SEATS, console: quiet,
    };
    const { exports: m } = load(CODE, scope, '{ standUpSeatsPastSitOutLimit, SIT_OUT_HANDS_LIMIT }');
    const hand = (sitOut: boolean) => {
      table.setSittingOutSeats(sitOut ? [0] : []);
      playerSessions.get('sA') && (playerSessions.get('sA').sittingOut = sitOut);
      expect(table.startNewHand()).toBe(true);
      playOut(table);
      m.standUpSeatsPastSitOutLimit(T, table);
    };
    return { table, m, sock, credits, playerSessions, spectators, hand };
  }

  it('limit 30: seated through hand 29; at 30 stood up, his stack credited once, kept as a spectator, told why', () => {
    const w = sitOutWorld();
    expect(w.m.SIT_OUT_HANDS_LIMIT).toBe(30);
    for (let h = 1; h < 30; h++) w.hand(true);
    expect(w.table.seats[0].state).toBe('occupied');
    expect(w.credits).toEqual([]);
    w.hand(true);
    expect(w.table.seats[0].state).toBe('empty');
    expect(w.credits).toEqual([{ userId: 101, chips: 5000, reason: 'handlePlayerLeave' }]);
    expect(w.playerSessions.has('sA')).toBe(false);
    expect(w.spectators.get(T)?.has('sA')).toBe(true);
    expect(w.sock.emitted).toEqual(expect.arrayContaining([
      ['sitOutToggled', expect.objectContaining({ sittingOut: false, reason: 'sit_out_limit', stoodUp: true })],
      ['error', expect.objectContaining({ code: 'sit_out_limit' })],
      ['gameState', expect.objectContaining({ full: true })],
    ]));
  });

  it('a hand he is dealt into resets the count', () => {
    const w = sitOutWorld();
    for (let h = 0; h < 29; h++) w.hand(true);
    w.hand(false);
    for (let h = 0; h < 29; h++) w.hand(true);
    expect(w.table.seats[0].state).toBe('occupied');
  });

  it('never at a tournament table (P-j: dealt in and acted for while away)', () => {
    const w = sitOutWorld({ tournament: true });
    for (let h = 0; h < 35; h++) {
      w.table.setSittingOutSeats([0]);
      w.table.startNewHand();
      playOut(w.table);
      w.m.standUpSeatsPastSitOutLimit(T, w.table);
    }
    expect(w.table.seats[0].state).toBe('occupied');
  });
});

describe('GAME-11 — fast mode is per player', () => {
  const FAST = fnSrc('function tableWantsFastBots(');
  const world = (sessions: Array<{ fast?: boolean; out?: boolean; table?: string }>, multi: Array<{ fast?: boolean }> = []) => {
    const playerSessions = new Map(sessions.map((s, i) => [`s${i}`, { tableId: s.table ?? T, fastMode: s.fast, sittingOut: !!s.out }]));
    const multiTableSessions = new Map([['m0', multi.map((s) => ({ tableId: T, fastMode: s.fast, sittingOut: false }))]]);
    return load(FAST, { playerSessions, multiTableSessions }, 'tableWantsFastBots').exports as (t: string) => boolean;
  };
  it('fast only while EVERY human playing here chose it; one player can never impose it on another', () => {
    expect(world([{ fast: true }])(T)).toBe(true);
    expect(world([{ fast: true }, { fast: false }])(T)).toBe(false);
    expect(world([{ fast: true }, {}])(T)).toBe(false);
    expect(world([{ fast: true }, { fast: false, out: true }])(T)).toBe(true);   // a sitting-out player does not count
    expect(world([{ fast: true }, { fast: false, table: 'other' }])(T)).toBe(true);
    expect(world([{ fast: true }], [{ fast: false }])(T)).toBe(false);        // an extra-table player here too
    expect(world([])(T)).toBe(false);                                          // a bot-only table: normal speed
  });

  it('setFastMode stores the player\'s own choice; it never writes the table turbo (fastModeTables)', async () => {
    const h = handlerSrc('setFastMode', '\n  });');
    expect(h).not.toContain('fastModeTables.set(');
    const sock = fakeSocket('s1');
    const session: any = { tableId: T, fastMode: undefined };
    const { exports: wire } = load(`function wire(socket) {\n${h}\n}`, {
      playerSessions: new Map([['s1', session]]), authSessions: new Map([['s1', { userId: 1 }]]),
    }, 'wire');
    wire(sock);
    await sock.handlers.setFastMode({ enabled: true });
    expect(session.fastMode).toBe(true);
    await sock.handlers.setFastMode({ enabled: false });
    expect(session.fastMode).toBe(false);
    expect(sock.emitted).toEqual([['fastModeSet', { enabled: true }], ['fastModeSet', { enabled: false }]]);
    expect(fnSrc('function scheduleAIAction(')).toContain('fastModeTables.get(tableId) || tableWantsFastBots(tableId)');
  });
});

describe('C11 — isFirstActor and canBombPot are always-present booleans', () => {
  const STATE = [fnSrc('function getVariantInfo('), fnSrc('function getGameStateForPlayer('), KIND_SRC].join('\n');
  function stateOf(table: PokerTable, seat: number, kinds: Parameters<typeof registries>[0] = {}) {
    const { exports } = load(STATE, {
      ...registries(kinds), ShortDeckTable, FiveCardDrawTable, SevenStudTable, MAX_SEATS, GamePhase, cardToString,
      playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
      dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null,
      tournamentIdOfTable: () => undefined, rebuyAllowedAt: () => true, progressionManager: { getProgress: () => null },
    }, 'getGameStateForPlayer');
    return exports(table, seat, false) as any;
  }
  const four = (t: PokerTable) => { for (let i = 0; i < 4; i++) t.sitDown(i, `P${i}`, 5000, `p${i}`, false); t.startNewHand(); return t; };

  it("cash Hold'em: the UTG seat may straddle (isFirstActor true), nobody else; canBombPot true; a spectator gets false / false", () => {
    const t = four(new PokerTable(cfg()));
    const utg = t.activeSeatIndex;
    for (let i = 0; i < 4; i++) {
      const s = stateOf(t, i);
      expect(s.isFirstActor).toBe(i === utg);
      expect(s.canBombPot).toBe(true);
    }
    const spec = stateOf(t, -1);
    expect(spec.isFirstActor).toBe(false);
    expect(spec.canBombPot).toBe(false);
    t.playerCall(utg);
    expect(stateOf(t, t.activeSeatIndex).isFirstActor).toBe(false);
  });

  it('Omaha cash: canBombPot true; Short Deck / Stud / Draw cash: false', () => {
    expect(stateOf(four(new OmahaTable(cfg(), false, 4)), 0).canBombPot).toBe(true);
    expect(stateOf(four(new ShortDeckTable(cfg())), 0).canBombPot).toBe(false);
    expect(stateOf(four(new SevenStudTable(cfg({ ante: 5 }), false, false)), 0).canBombPot).toBe(false);
    expect(stateOf(four(new FiveCardDrawTable(cfg(), false)), 0).canBombPot).toBe(false);
  });

  it("a tournament / all-in-or-fold Hold'em table: no straddle, no bomb pot", () => {
    for (const kinds of [{ tournament: true }, { aof: true }]) {
      const t = four(new PokerTable(cfg()));
      const s = stateOf(t, t.activeSeatIndex, kinds);
      expect(s.isFirstActor).toBe(false);
      expect(s.canBombPot).toBe(false);
    }
  });
});

describe('GAME-12 — bomb pots only at Hold\'em / Omaha ring tables; no straddle at tournament / quick tables', () => {
  const ACTIVATE = [fnSrc('function activateBombPotIfPending('), slice('const bombPotStats', '};\n'), KIND_SRC].join('\n');
  function activateWorld(mk: () => PokerTable, kinds: Parameters<typeof registries>[0] = { private: true }) {
    const table = mk();
    for (let i = 0; i < 4; i++) table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    const bombPotPending = new Map([[T, true]]);
    const bombPotActive = new Map<string, boolean>();
    const { exports } = load(ACTIVATE, { ...registries(kinds), bombPotPending, bombPotActive, MAX_SEATS, GamePhase }, '{ activateBombPotIfPending, bombPotStats }');
    table.startNewHand();
    return { table, ...exports, bombPotPending, bombPotActive };
  }

  it('a private OMAHA table (the create option): the bomb pot is dealt by the table — equal ante, the flop', () => {
    const w = activateWorld(() => new OmahaTable(cfg({ smallBlind: 50, bigBlind: 100 }), false, 4));
    expect(w.activateBombPotIfPending(T, w.table)).toBe(true);
    expect(w.table.currentPhase).toBe(GamePhase.Flop);
    expect(w.table.seats.slice(0, 4).map((s: any) => s.totalInvestedThisHand)).toEqual([200, 200, 200, 200]);
    expect(w.bombPotActive.get(T)).toBe(true);
  });

  it('a private SHORT DECK table: the pending bomb pot is dropped (the old code flopped base-deck cards there)', () => {
    const w = activateWorld(() => new ShortDeckTable(cfg({ smallBlind: 50, bigBlind: 100 })));
    expect(w.activateBombPotIfPending(T, w.table)).toBe(false);
    expect(w.table.currentPhase).toBe(GamePhase.PreFlop);
    expect(w.table.communityCards).toHaveLength(0);
    expect(w.bombPotPending.has(T)).toBe(false);
    expect(w.bombPotStats.refusedAtActivation).toBe(1);
  });

  it("a TOURNAMENT Hold'em table: dropped too", () => {
    const w = activateWorld(() => new PokerTable(cfg()), { tournament: true });
    expect(w.activateBombPotIfPending(T, w.table)).toBe(false);
    expect(w.table.currentPhase).toBe(GamePhase.PreFlop);
  });

  it('triggerBombPot refuses (bomb_pot_not_allowed) before spending the cooldown; at a Hold\'em cash table it is armed', async () => {
    const h = handlerSrc('triggerBombPot', '\n  });');
    for (const [mk, ok] of [[() => new SevenStudTable(cfg({ ante: 5 }), false, false), false], [() => new PokerTable(cfg()), true]] as const) {
      const table = (mk as () => PokerTable)();
      const sock = fakeSocket('s1');
      const roomEmits: string[] = [];
      const bombPotPending = new Map<string, boolean>();
      const bombPotCooldownUntil = new Map<string, number>();
      // F156 (2026-10-21): the handler resolves its seat through seatSessionFor.
      const { exports: wire } = load(`function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${h}\n}\n${KIND_SRC}\n${slice('const bombPotStats', '};\n')}`, {
        ...registries(), playerSessions: new Map([['s1', { tableId: T, seatIndex: 0 }]]), tableManager: { getTable: () => table },
        bombPotPending, bombPotCooldownUntil, BOMB_POT_COOLDOWN_MS: 300000, io: { to: () => ({ emit: (ev: string) => roomEmits.push(ev) }) },
      }, 'wire');
      wire(sock);
      await sock.handlers.triggerBombPot({ tableId: T });
      expect(bombPotPending.get(T) === true).toBe(ok);
      expect(bombPotCooldownUntil.has(T)).toBe(ok);
      if (ok) expect(roomEmits).toEqual(['bombPotTriggered']);
      else expect(sock.emitted).toEqual([['error', expect.objectContaining({ code: 'bomb_pot_not_allowed' })]]);
    }
  });

  it('the straddle handler refuses at a tournament table (straddle_not_allowed) and straddles at a cash table', () => {
    const h = handlerSrc('straddle', '\n  });');
    for (const tournament of [true, false]) {
      const table = new PokerTable(cfg());
      for (let i = 0; i < 4; i++) table.sitDown(i, `P${i}`, 5000, `p${i}`, false);
      table.startNewHand();
      const sock = fakeSocket('s1');
      const { exports: wire } = load(`function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${h}\n}\n${KIND_SRC}`, {   // F156: seatSessionFor
        ...registries({ tournament }), playerSessions: new Map([['s1', { tableId: T, seatIndex: table.activeSeatIndex }]]),
        tableManager: { getTable: () => table }, broadcastGameState() {}, scheduleAIAction() {},
      }, 'wire');
      wire(sock);
      sock.handlers.straddle();
      expect(table.currentBetToMatch).toBe(tournament ? 50 : 100);
      if (tournament) expect(sock.emitted).toEqual([['error', expect.objectContaining({ code: 'straddle_not_allowed' })]]);
    }
  });
});

describe('TABLEUI-11 — spectate next / prev, spectateTournament and seat moves send a FULL state', () => {
  const EMIT = [slice('const ALWAYS_EMIT_KEYS = [', '];\n'), fnSrc('function shallowDiff('), fnSrc('function pickAlwaysEmit('), fnSrc('function emitGameState(')].join('\n');
  function spectateWorld(handler: string, emit = EMIT) {
    const tables = new Map<string, PokerTable>([['A', new PokerTable(cfg({ tableId: 'A' }))], ['B', new PokerTable(cfg({ tableId: 'B' }))]]);
    const sock = fakeSocket('s1');
    const lastSentState = new Map<string, any>();
    const lastSentJson = new Map<string, any>();
    const { exports: wire } = load(`${emit}\nfunction wire(socket) {\n${handler}\n}`, {
      tableManager: { getTable: (id: string) => tables.get(id) }, lastSentState, lastSentJson, spectators: new Map(),
      tournamentManager: {
        getTournament: () => ({ status: 'running', tableIds: ['A', 'B'] }), getTournamentStatus: () => ({}),
        getAlivePlayersOnTable: (_t: string, id: string) => (id === 'B' ? [1, 2, 3] : [1]),
      },
      getGameStateForPlayer: (t: PokerTable) => ({ tableId: t.config.tableId, phase: t.currentPhase, seats: [], blinds: 'x' }),
      detachSocketFromOtherTables() {}, handlePlayerLeave() {}, playerSessions: new Map(),
    }, 'wire');
    wire(sock);
    lastSentState.set('s1', { tableId: 'A', phase: 'PreFlop', seats: [], blinds: 'x', isSpectator: true });   // watching A
    return { sock };
  }
  const frames = (sock: ReturnType<typeof fakeSocket>) => sock.emitted.filter(([ev]) => ev === 'gameState').map(([, d]) => d);

  it.each([
    ['spectateNextTable', { tournamentId: 't', currentTableId: 'A', direction: 'next' }],
    ['spectateTournament', { tournamentId: 't' }],
  ])('%s → full:true (it was a delta against the previous table)', async (ev, payload) => {
    const w = spectateWorld(handlerSrc(ev as string, '\n  });'));
    await w.sock.handlers[ev as string](payload);
    expect(frames(w.sock)).toEqual([expect.objectContaining({ full: true, state: expect.objectContaining({ tableId: 'B', isSpectator: true }) })]);
  });

  it('CONTROL — the pre-R2 call sends a DELTA fragment', async () => {
    const h = handlerSrc('spectateNextTable', '\n  });');
    const old = h.replace('emitGameState(socket, state, true);', 'emitGameState(socket, state);');
    expect(old).not.toBe(h);
    // F64 (2026-10-21): emitGameState itself now sends a frame for ANOTHER table
    // full; the control runs the pre-F64 emitGameState too (both guards off).
    const F64 = ' || prev.tableId !== state?.tableId';
    expect(EMIT).toContain(F64);
    const w = spectateWorld(old, EMIT.replace(F64, ''));
    await w.sock.handlers.spectateNextTable({ tournamentId: 't', currentTableId: 'A' });
    expect(frames(w.sock)[0].full).toBe(false);
  });

  it('wiring: a rebalance move and a cash seat move drop the moved socket\'s delta baseline', () => {
    const move = fnSrc('function moveTournamentSeatPointers(');
    expect(move).toMatch(/s\.seatIndex = toSeat;[\s\S]*lastSentState\.delete\(sid\);[\s\S]*sock\.emit\('playerMoved'/);
    expect(fnSrc('function executePendingMove(')).toContain('lastSentState.delete(session.socketId);');
  });
});

describe('GAME-5 — a human\'s draw hands the turn on', () => {
  function drawWorld(handler: string) {
    const table = new FiveCardDrawTable(cfg(), false);
    table.sitDown(0, 'Human', 5000, 'h', false);
    table.sitDown(1, 'Bot', 5000, 'ai-1', true);
    table.startNewHand();
    let g = 0;
    while (table.currentPhase === GamePhase.PreFlop && g++ < 10) table.playerCall(table.activeSeatIndex) || table.playerCheck(table.activeSeatIndex);
    expect(table.currentPhase).toBe(GamePhase.Draw1);
    table.playerDraw(1, []);                                       // the bot drew first (0.5-1.5s)
    const scheduled: string[] = [];
    const sock = fakeSocket('sH');
    const { exports: wire } = load(`function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${handler}\n}`, {   // F156: seatSessionFor
      playerSessions: new Map([['sH', { tableId: T, seatIndex: 0 }]]), tableManager: { getTable: () => table }, FiveCardDrawTable,
      broadcastGameState() {}, scheduleAIAction: (id: string) => scheduled.push(id),
    }, 'wire');
    wire(sock);
    return { table, sock, scheduled };
  }

  it('the human draws last: the round completes and the next actor (the bot) is scheduled at once', async () => {
    const w = drawWorld(handlerSrc('playerDraw', '\n  });'));
    await w.sock.handlers.playerDraw({ discardIndices: [0, 1] });
    expect(w.table.currentPhase).toBe(GamePhase.Bet2);
    expect(w.scheduled).toEqual([T]);
  });

  it('CONTROL — the pre-R2 handler scheduled nothing (the bot waited for its 30s clock)', async () => {
    const h = handlerSrc('playerDraw', '\n  });');
    const old = h.replace('    scheduleAIAction(session.tableId);\n  });', '  });');
    expect(old).not.toBe(h);
    const w = drawWorld(old);
    await w.sock.handlers.playerDraw({ discardIndices: [] });
    expect(w.scheduled).toEqual([]);
  });

  it('a draw outside the draw round (or a bad payload) is refused with invalid_draw', async () => {
    const w = drawWorld(handlerSrc('playerDraw', '\n  });'));
    await w.sock.handlers.playerDraw({ discardIndices: 'all' });
    expect(w.sock.emitted).toEqual([['error', expect.objectContaining({ code: 'invalid_draw' })]]);
  });
});

describe('wiring — every leave / fold path goes through the ONE teardown; joinByInviteCode never pushes the spectator view', () => {
  it.each([
    ['handlePlayerLeave', fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind')],
    ['leaveAdditionalTable', handlerSrc('leaveAdditionalTable', '\n  });')],
    ['cashOutAdditionalSeatsOnDeparture', fnSrc('function cashOutAdditionalSeatsOnDeparture(')],
    ['clearGhostSeatsForUser', fnSrc('function clearGhostSeatsForUser(')],
    ['standUpRefusedSeat', fnSrc('function standUpRefusedSeat(')],
    ['endCashReservation', fnSrc('function endCashReservation(')],
  ])('%s tears a human seat down only through teardownSeat (no bare standUp / fold of its own)', (_n, src) => {
    expect(src).toContain('teardownSeat(');
    expect(src).not.toMatch(/\.standUp\(/);
    expect(src).not.toMatch(/\.playerFold\(/);
    expect(src).not.toMatch(/\.forceFoldSeat\(/);
  });

  it('joinByInviteCode: broadcastGameState (each seat its own view), never getGameStateForPlayer(table, -1) to peers', () => {
    const h = handlerSrc('joinByInviteCode', '\n  });');
    expect(h).not.toContain('getGameStateForPlayer(table, -1)');
    expect(h).toContain('broadcastGameState(tableId);');
  });

  it('join paths take an AI seat only through takeAiSeatForJoin / aiSeatTakeableNow', () => {
    for (const ev of ['joinTable', 'quickPlay', 'joinAdditionalTable']) {
      const h = handlerSrc(ev, ev === 'joinAdditionalTable' ? '\n  });' : '\n  );');
      expect(h).toMatch(/takeAiSeatForJoin\(|aiSeatTakeableNow\(/);
      expect(h).not.toMatch(/if \(table\.seats\[i\]\.state === 'occupied' && table\.seats\[i\]\.isAI\) \{\s*table\.standUp/);
    }
  });
});

describe('GAME P3 — the chip-velocity monitor runs on table winnings', () => {
  const CV = [slice('const CHIP_VELOCITY_MIN_HANDS = 5;', '\n}\n'), fnSrc('function incrementChipVelocityAlert(')].join('\n');
  function cvWorld(code = CV, tournament = false) {
    const table = new PokerTable(cfg());
    table.sitDown(0, 'Ann', 1000, 'pA', false);
    table.seats[0].holeCards = [{ rank: 14, suit: 0 }, { rank: 13, suit: 0 }] as any;
    const audits: Array<{ action: string; d: any }> = [];
    const bans: number[] = [];
    const chipVelocity = new Map<number, any>();
    const chipVelocityAlerts = new Map<number, any>();
    const { exports } = load(code, {
      isTournamentTable: () => tournament, playerSessions: new Map([['sA', { tableId: T, seatIndex: 0 }]]),
      authSessions: new Map([['sA', { userId: 101 }]]), chipVelocity, chipVelocityAlerts, CHIP_VELOCITY_DECAY_MS: 86400000,
      auditLog: (_a: string, action: string, d: any) => audits.push({ action, d }), banUserDB: (uid: number) => bans.push(uid), console: quiet,
    }, '{ recordChipVelocity, chipVelocityStats }');
    /** One hand: he starts it with `start`, ends it with `end`, and wins chips in it. */
    const hand = (start: number, end: number) => {
      table.startChips = new Map([[0, start]]);
      table.seats[0].chipCount = end;
      exports.recordChipVelocity(T, table, [{ seatIndex: 0, isAI: false, chipsWon: Math.max(1, end - start), playerId: 'pA' }]);
    };
    return { table, ...exports, audits, bans, chipVelocity, chipVelocityAlerts, hand };
  }

  it('a session that nets more than 10x its first stack (5+ hands) alerts ONCE — audited, not banned (auto-ban is opt-in)', () => {
    const w = cvWorld();
    let stack = 1000;
    for (let h = 0; h < 8; h++) { w.hand(stack, stack + 3000); stack += 3000; }
    expect(w.chipVelocity.get(101)).toMatchObject({ handsThisSession: 8, netWon: 24000, alerted: true });
    expect(w.audits.filter((a: any) => a.action === "CHIP_VELOCITY_ALERT")).toHaveLength(1);
    expect(w.bans).toEqual([]);
    expect(w.chipVelocityStats.alerts).toBe(1);
  });

  it('with CHIP_VELOCITY_AUTOBAN=1 the third alert in the decay window bans (the old rule)', () => {
    const code = CV.replace("process.env.CHIP_VELOCITY_AUTOBAN === '1'", 'true');
    expect(code).not.toBe(CV);
    const w = cvWorld(code);
    w.chipVelocityAlerts.set(101, { count: 2, lastAlertAt: Date.now() });
    let stack = 1000;
    for (let h = 0; h < 6; h++) { w.hand(stack, stack + 3000); stack += 3000; }
    expect(w.bans).toEqual([101]);
  });

  it('normal winning (under 10x) never alerts; tournament chips are never measured', () => {
    const w = cvWorld();
    for (let h = 0; h < 20; h++) w.hand(1000, 1400);
    expect(w.audits).toEqual([]);
    const t = cvWorld(CV, true);
    for (let h = 0; h < 8; h++) t.hand(1000, 9000);
    expect(t.chipVelocity.size).toBe(0);
  });

  it('wiring: the handResult listener calls it; the wallet (getUserChips) is no longer read per win', () => {
    const listener = slice("table.on('handResult', async (data: { results: any[]; handNumber: number }) => {", '\n  });');
    expect(listener).toContain('recordChipVelocity(tableId, table, data.results);');
    expect(listener).not.toContain('getUserChips(');
  });
});

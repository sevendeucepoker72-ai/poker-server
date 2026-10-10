/**
 * 2026-10-10 — the tournament REBALANCE, follow-up to F1 (owner: "fix all").
 *
 * P1. The rebalance stranded ALIVE entrants. checkRebalance broke tables with
 * no capacity check (TA 6 / TB 4 alive: TB's 4 players met 3 free seats on TA
 * — one was left without a seat and the tournament could never finish), and a
 * BUSTED seat (handleHandComplete leaves it occupied: eliminated, 0 chips)
 * looked taken, so a moved player found "no empty seats" at a table with
 * room. Now a table is broken only when the other tables' free seats (empty +
 * busted, the busted ones stood up right before the move) hold every player
 * it moves; otherwise the short table plays on. A table is also never broken
 * in the MIDDLE of a hand (its pot would be left behind on a table about to be
 * removed) — the break waits for that table's hand boundary — and a 0-chip
 * player the bust check is eliminating right now is not moved (he used to be
 * resurrected on the target table with his STARTING stack).
 *
 * P2. The rebalance's "restart hands on tables that were waiting" step ran
 * inside the bust's elimination — i.e. inside a table's own 'handResult' emit
 * — and started that table's NEXT hand there: determineWinners then revealed
 * the NEW hand's deck seed (published by the unauthenticated /api/fairness
 * endpoints) and never the finished hand's. Now the restart hands a finished
 * table to the hand-boundary scheduler, and PokerTable refuses startNewHand
 * while a hand is completing (and reveals the commitment it read BEFORE any
 * listener ran).
 *
 * P6. The rebalance moved a human's session only through the socket he
 * REGISTERED with; a player who had reconnected since stayed on the broken
 * table while his stack played on at the new one. Now every live session at
 * his old seat, on any socket, and his reservation, follow the stack.
 *
 * Q1/Q2 (2026-10-10, review of P1). The 'pending bust is never moved' skip
 * assumed the rebalance ran INSIDE the broken table's own bust loop: when
 * ANOTHER table's bust (or the 5s sweep) broke a table whose bust check was
 * still in its DB awaits, the 0-chip entrant was neither moved nor (the table
 * having left tournamentTables) ever eliminated — the tournament could never
 * finish. Now such a break is DEFERRED until that bust check has run, and the
 * bust check resolves a just-broken table's tournament through the broken-table
 * registry. And the mover's seat is his LIVE seat (occupied, not eliminated):
 * a re-entered qualifier player's OLD busted seat carries the same playerId.
 *
 * Everything runs the REAL source of src/index.ts (sliced + transpiled) with
 * the REAL PokerTable and TournamentManager.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
import { planHandStartGate, masterIdFromStats, resolveSessionMasterId, HAND_GATE_MAX_STATUS_AGE_MS } from '../src/auth/playGate';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { SRC, slice, fnSrc, handlerSrc, load, flush, deferred } from './helpers/indexSource';

const P = {
  absentIds: slice('const ABSENT_SEAT_MASTER_ID_TTL_MS', '\n}\n'),
  absentSeatMasterId: fnSrc('function absentSeatMasterId('),
  brokenTables: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  isTournamentReservation: fnSrc('function isTournamentReservation('),
  gateState: slice('const playGateHandStart = {', '\n}\n'),
  rebalanceIsHeld: fnSrc('function tournamentRebalanceIsHeld('),
  releaseRebalance: fnSrc('function releaseTournamentRebalance('),
  absentEntrantIdentity: fnSrc('function absentEntrantIdentity('),
  qualifierEntrantMasterId: fnSrc('function qualifierEntrantMasterId('),
  reservationHolderAt: fnSrc('function reservationHolderAt('),
  seatOwnerSocket: fnSrc('function seatOwnerSocket('),
  gate: fnSrc('function standUpSuspendedSeatsBeforeDeal('),
  canStandUp: fnSrc('function suspendedSeatCanStandUp('),
  standUpAbsent: fnSrc('function standUpAbsentTournamentSeat('),
  standUpSuspended: fnSrc('function standUpSuspendedSeat('),
  handlePlayerLeave: fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind'),
  creditSeat: fnSrc('function creditSeatStackToWallet('),
  helpers: slice('// ===== Tournament rebalance helpers', '// ===== end tournament rebalance helpers =====\n'),
  rebalance: fnSrc('function handleTableRebalance(tournamentId: string): void {'),
  autoStart: fnSrc('function autoStartNextHand(tableId: string): void {'),
  handComplete: fnSrc('async function handleHandComplete('),
  events: slice('  tournamentManager.onEvent(tournamentId, (event, data) => {', '\n  });\n', SRC.indexOf('function bootstrapTournamentTables(')),
  // S1/S2/M3 (2026-10-10): the socket 'startHand' and 'returnToTournamentSeat' handlers, the seat-keep
  // region (keepTournamentSeatOnLeave / restoreAbsentTournamentSeat / detachTournamentEntrantSockets),
  // the disconnect's reservation (the keep reuses it) and the account switch.
  startHand: handlerSrc('startHand', '\n  });\n'),
  returnToTournament: handlerSrc('returnToTournamentSeat', '\n  });\n'),
  seatKeep: slice('// ===== Tournament seat kept on leave', '// ===== end tournament seat kept on leave =====\n'),
  departure: fnSrc('function otherSessionHoldsSeat(') + fnSrc('function reserveSeatForDeparture(') + fnSrc('function cashOutAdditionalSeatsOnDeparture('),
  noteNotCashed: fnSrc('function noteTournamentReservationNotCashed('),
  accountSwitch: slice('const socketAccountSwitches = {', '\n}\n'),
  // Round 5 (2026-10-10): the REAL seat / spectate handlers P-g covers and the admin removals (P-f gap).
  quickHeadsUp: handlerSrc('quickHeadsUp', '\n  });\n'),
  joinByInviteCode: handlerSrc('joinByInviteCode', '\n  });\n'),
  spectate: slice("socket.on('spectate', async", '\n  });\n'),
  adminKick: handlerSrc('adminKickPlayer', '\n  });\n'),
  adminIPBan: handlerSrc('adminIPBan', '\n  });\n'),
  // Round 6 (2026-10-10): spectateNextTable (pe5 X5 — a busted player's dead seat) and banUser (P-k).
  spectateNextTable: handlerSrc('spectateNextTable', '\n  });\n'),
  banUser: handlerSrc('banUser', '\n  });\n'),
  // Z1 (2026-10-10): the main (last-registered) disconnect handler — its seat reserve runs after the save await.
  disconnect: slice("  socket.on('disconnect', async () => {\n    console.log(`Player disconnected: ${socket.id}`);", '\n  });\n'),
};

/** The pre-P1 planning: no capacity check (every table "has room"), no "not enough seats" abort. */
const PLAN = 'planTournamentRebalance(tournamentId)';
const ABORT = 'if (targets.length < movers.length) {';
function withoutCapacityPlan(rebalance: string): string {
  expect(rebalance).toContain(PLAN);
  expect(rebalance).toContain(ABORT);
  return rebalance.split(PLAN).join('tournamentManager.checkRebalance(tournamentId, () => 99)').replace(ABORT, 'if (false) {');
}
/** Q1 — the deferral of a break whose table still holds a pending bust (removed by the controls). */
const PENDING_DEFER = '  if (pendingBustIdx >= 0) {';
function withoutPendingBustDeferral(rebalance: string): string {
  expect(rebalance).toContain(PENDING_DEFER);
  return rebalance.replace(PENDING_DEFER, '  if (false) {');
}
/** The P1 (pre-Q1) skip of a 0-chip mover, put back for the controls. */
const MOVER_PUSH = '    movers.push({ player, breakSeatIdx, breakSeat });';
function withPendingBustSkip(rebalance: string): string {
  expect(rebalance).toContain(MOVER_PUSH);
  return rebalance.replace(MOVER_PUSH, "    if (breakSeat && breakSeat.chipCount <= 0) { console.log('rebalance_pending_bust_not_moved ' + player.playerId); continue; }\n" + MOVER_PUSH);
}
/** Q2 — the pre-Q2 (P1) mover lookup: by playerId alone. */
const LIVE_LOOKUP = '    const breakSeatIdx = tournamentLiveSeatIndex(breakTable, player.playerId);';
function withPlayerIdOnlyLookup(rebalance: string): string {
  expect(rebalance).toContain(LIVE_LOOKUP);
  return rebalance.replace(LIVE_LOOKUP, "    const breakSeatIdx = breakTable ? breakTable.seats.findIndex(s => s.state === 'occupied' && s.playerId === player.playerId) : -1;");
}
/**
 * Q1 — the pre-Q1 bust-check lookup: tournamentTables alone. S1 (2026-10-10): the bust check is
 * runTournamentBustCheck (in the rebalance helpers), so the control mutates the helpers.
 */
const BUST_LOOKUP = 'const tournamentId = tournamentTables.get(tableId) ?? brokenTournamentTables.get(tableId)?.tournamentId;';
function withLiveOnlyBustLookup(helpers: string): string {
  expect(helpers).toContain(BUST_LOOKUP);
  return helpers.replace(BUST_LOOKUP, 'const tournamentId = tournamentTables.get(tableId);');
}
/** M1 (2026-10-10) — the pre-M1 mover stack: his record's starting stack / 5000 when his seat had none, an AI by default. */
const MOVER_STACK = '    const chips = breakSeat.chipCount;\n    const isAI = !!breakSeat.isAI;';
function withPreM1MoverStack(rebalance: string): string {
  expect(rebalance).toContain(MOVER_STACK);
  return rebalance.replace(MOVER_STACK,
    '    const chips = breakSeat?.chipCount || tournament.players.find(p => p.playerId === player.playerId)?.chips || 5000;\n    const isAI = breakSeat?.isAI ?? true;');
}
/** The pre-P1 seat search: a busted (occupied) seat is never placeable. */
const BUSTED_PLACEABLE = "  if (seat.state !== 'occupied' || !seat.eliminated || seat.chipCount > 0) return false;\n";

function compile(over: Partial<typeof P> = {}): string {
  const p = { ...P, ...over };
  return `
${p.absentIds}
${p.absentSeatMasterId}
${p.brokenTables}
${p.isTournamentReservation}
${p.gateState}
${p.rebalanceIsHeld}
${p.releaseRebalance}
${p.absentEntrantIdentity}
${p.qualifierEntrantMasterId}
${p.reservationHolderAt}
${p.seatOwnerSocket}
${p.gate}
${p.canStandUp}
${p.standUpAbsent}
${p.standUpSuspended}
${p.seatKeep}
${p.departure}
${p.noteNotCashed}
${p.accountSwitch}
${p.handlePlayerLeave}
${p.creditSeat}
${p.helpers}
${p.rebalance}
${p.autoStart}
${p.handComplete}
function registerEvents(tournamentId) {
${p.events}
}
function wireSocket(socket) {
  ${p.startHand}
  ${p.returnToTournament}
  ${p.quickHeadsUp}
  ${p.joinByInviteCode}
  ${p.spectate}
  ${p.adminKick}
  ${p.adminIPBan}
  ${p.spectateNextTable}
  ${p.banUser}
  ${p.disconnect}
}`;
}

interface Entrant { pid: string; name: string; stack: number; uid?: number; master?: string }
const SB = 100;
const BB = 200;

function world(opts: {
  layout: Record<string, Entrant[]>; startingStack?: number; over?: Partial<typeof P>;
  /** Q1: extra module-scope fakes (e.g. the hand-complete persistence awaits). */
  scope?: Record<string, unknown>;
  /** Extra tournament config (e.g. a bounty tournament). */
  config?: Record<string, unknown>;
}) {
  const startingStack = opts.startingStack ?? 5000;
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Rebalance Cup', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: [{ sb: SB, bb: BB, ante: 0, duration: 600 }],
    ...(opts.config || {}),
  } as any);
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  for (const list of Object.values(opts.layout)) for (const e of list) tm.registerPlayer(tid, e.pid, e.name, `reg-${e.pid}`, e.uid);
  expect(tm.startTournament(tid)).toBeTruthy();
  tm.setTableIds(tid, Object.keys(opts.layout));
  for (const [id, list] of Object.entries(opts.layout)) {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: SB, bigBlind: BB, minBuyIn: startingStack, maxBuyIn: startingStack * 10, maxPlayers: 9 } as any);
    tables.set(id, t);
    tournamentTables.set(id, tid);
    list.forEach((e, i) => {
      expect(t.sitDown(i, e.name, e.stack, e.pid, false, true)).toBe(true);
      tm.setPlayerTable(tid, e.pid, id);
    });
  }

  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const spectators = new Map<string, Set<string>>();
  const live = new Map<string, any>();
  const statusCache = new Map<string, boolean>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const credits: Array<{ uid: number; amount: number }> = [];
  const logs: string[] = [];
  const scheduled: string[] = [];
  const pendingAutoStartTimers = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tournamentTables, tournamentManager: tm, qualifierTournaments: new Map(),
    tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id) },
    DEFAULT_BLIND_LEVELS, GamePhase,
    reservedSeats, playerSessions, authSessions, multiTableSessions, spectators, aiProfiles: new Map(),
    tableProgressListeners: new Set(), sitOutTracker: new Map(), pendingSeatRemovalAfterHand: new Map(),
    pendingAutoStartTimers, scheduleAutoStart: (id: string) => { scheduled.push(id); },
    io: { to: () => { const op: any = { emit() {}, except: () => op }; return op; }, emit() {}, sockets: { sockets: live } },
    loadLocalStats: async () => '{}', masterIdFromStats, planHandStartGate, HAND_GATE_MAX_STATUS_AGE_MS, resolveSessionMasterId,
    playStatusClient: {
      peek: (id: string) => (statusCache.has(id) ? { status: { suspended: statusCache.get(id)!, failedOpen: false }, ageMs: 0, expired: false } : null),
      getPlayStatus: async () => ({ suspended: false, failedOpen: false }),
    },
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    payTournamentPrizes: async () => {}, postQualifierResults() {},
    syncSitOutToTable() {}, broadcastGameState() {}, scheduleAIAction() {}, releaseSeatedSlot() {}, cleanupQuickTable() {},
    getGameStateForPlayer: () => ({}), emitGameState() {}, notifyPlayer: async () => {}, userIdForSeat: () => undefined,
    ensureTableProgressListener() {}, activateBombPotIfPending() {},
    dealersChoiceState: new Map(), bombPotActive: new Map(), bombPotPending: new Map(), insuranceCashouts: new Map(),
    quickTables: new Set(), tickReservedSeatHands() {},
    playGateRefusals: { player_suspended: 0 }, PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED', SEAT_RESERVE_MS: 6 * 3600_000, MAX_SEATS: 9,
    // S2: the disconnect reservation's hand limit; the play gate of 'returnToTournamentSeat' (allowed by default).
    DISCONNECT_HANDS_LIMIT: 20, assertPlayable: async () => null,
    Sentry: null,
    console: {
      log: (...a: any[]) => logs.push(a.join(' ')), warn: (...a: any[]) => logs.push(a.join(' ')), error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`),
    },
    process: { env: {} },
    ...(opts.scope || {}),
  };
  const { exports: m, stubbed } = load(compile(opts.over), scope, `{
    standUpSuspendedSeatsBeforeDeal, registerEvents, handleTableRebalance, autoStartNextHand, handleHandComplete,
    tournamentHandStartSafety, tournamentBreaksAwaitingHandEnd, isTournamentTable, brokenTournamentTables,
    wireSocket, handlePlayerLeave, tournamentSeatKeep, restoreAbsentTournamentSeat, releaseSocketForAccountSwitch,
    tournamentBustChecksPending, tournamentDealsHeldForBustCheck, runPendingTournamentBustChecks,
    leaveTournamentSeatOnAdminRemoval, tellKeptTournamentSeats, voluntarilyAbsentTournamentEntrants,
    detachSocketFromOtherTables, tableViewDetaches, disqualifyAwayTournamentEntriesOnAdminRemoval,
    finishedTournamentRecords, tournamentFinishedNotices,
  }`);
  m.registerEvents(tid);
  for (const [id, t] of tables) {
    t.on('beforeHandStart', () => { try { m.standUpSuspendedSeatsBeforeDeal(t, id); } catch (e: any) { logs.push(`gate threw ${e?.message}`); } });
  }
  const mkSocket = (sid: string) => {
    const s: any = { id: sid, connected: true, emitted: [] as any[], rooms: new Set<string>() };
    s.emit = (ev: string, d: any) => s.emitted.push([ev, d]);
    s.join = (r: string) => s.rooms.add(r);
    s.leave = (r: string) => s.rooms.delete(r);
    live.set(sid, s);
    return s;
  };
  /** A live, signed-in socket seated at (tableId, seat). */
  const seatLive = (sid: string, tableId: string, seatIndex: number, uid: number, master: string) => {
    const s = mkSocket(sid);
    authSessions.set(sid, { userId: uid, username: `u${uid}`, masterUserId: master });
    const seat = tables.get(tableId)!.seats[seatIndex];
    playerSessions.set(sid, { socketId: sid, tableId, seatIndex, playerName: seat.playerName, playerId: seat.playerId, sittingOut: false });
    s.join(`table:${tableId}`);
    return s;
  };
  /** Every alive entrant's seats on the tables still in play. */
  const seatsOf = () => {
    const t = tm.getTournament(tid)!;
    const out = new Map<string, string[]>();
    for (const p of t.players) if (!p.eliminated) out.set(p.playerId, []);
    for (const id of t.tableIds) tables.get(id)?.seats.forEach((s) => { if (s.state === 'occupied' && out.has(s.playerId)) out.get(s.playerId)!.push(id); });
    return out;
  };
  const seatless = () => [...seatsOf().entries()].filter(([, at]) => at.length === 0).map(([p]) => p);
  const chipsInPlay = () => {
    let sum = 0;
    for (const id of tm.getTournament(tid)!.tableIds) for (const s of tables.get(id)!.seats) if (s.state === 'occupied') sum += s.chipCount + (s.totalInvestedThisHand || 0);
    return sum;
  };
  const couldNotPlace = () => logs.filter((l) => /Could not place/.test(l));
  /** S1/S2 — a live socket with the real 'startHand' / 'returnToTournamentSeat' handlers wired on it. */
  const wireSocket = (sid: string) => {
    const s: any = live.get(sid) || mkSocket(sid);
    s.handlers = {};
    s.on = (ev: string, fn: any) => { s.handlers[ev] = fn; };
    m.wireSocket(s);
    return s;
  };
  return {
    m, stubbed, tm, tid, tables, tournamentTables, reservedSeats, playerSessions, authSessions, multiTableSessions, spectators,
    live, statusCache, audits, credits, logs, scheduled, pendingAutoStartTimers, mkSocket, seatLive, seatsOf, seatless, chipsInPlay, couldNotPlace,
    wireSocket,
  };
}

const field = (prefix: string, n: number, stack: number, uidBase: number): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ pid: `${prefix}${i}`, name: `${prefix}${i}`, stack, uid: uidBase + i, master: `m-${prefix}${i}` }));

/** Every seated entrant on a live socket except `skipPid`. */
function seatEveryoneLiveExcept(w: ReturnType<typeof world>, skipPid: string) {
  let n = 0;
  for (const [id, t] of w.tables) {
    t.seats.forEach((s, i) => {
      if (s.state === 'occupied' && !s.eliminated && s.playerId !== skipPid) w.seatLive(`S-${s.playerId}`, id, i, 500 + n++, `m-${s.playerId}`);
    });
  }
}
/** `pid` is ABSENT (disconnected, reserved with the master-id snapshot) and suspended (cached). */
function absentSuspended(w: ReturnType<typeof world>, pid: string, uid: number) {
  seatEveryoneLiveExcept(w, pid);
  const tableId = w.tm.getTournament(w.tid)!.playerTableMap.get(pid)!;
  const seatIndex = w.tables.get(tableId)!.seats.findIndex((s) => s.playerId === pid);
  w.reservedSeats.set(uid, {
    tableId, seatIndex, playerName: pid, chips: 5000, expiresAt: Date.now() + 3600e3, cleanupTimer: setTimeout(() => {}, 1e9),
    handsRemaining: 20, tournament: true, masterUserId: `m-${pid}`,
  });
  w.statusCache.set(`m-${pid}`, true);
}
/**
 * Busts from EARLIER hands, the way handleHandComplete leaves them: 0 chips,
 * eliminated, the seat still occupied. (Set on the tournament record directly —
 * set-up, not an elimination event.)
 */
function bust(w: ReturnType<typeof world>, tableId: string, seatIdxs: number[]) {
  const t = w.tables.get(tableId)!;
  const players = w.tm.getTournament(w.tid)!.players;
  for (const i of seatIdxs) {
    t.seats[i].chipCount = 0;
    t.seats[i].eliminated = true;
    const p = players.find((x) => x.playerId === t.seats[i].playerId)!;
    p.eliminated = true;
    p.finishPosition = players.filter((x) => !x.eliminated).length + 1;
  }
}
/** Fold the current hand down to one player. */
function foldOut(t: PokerTable) {
  let guard = 0;
  while (t.isHandInProgress() && guard++ < 20) {
    const i = t.activeSeatIndex;
    if (i < 0) break;
    t.playerFold(i);
  }
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('P1 — a rebalance never leaves an alive entrant without a seat', () => {
  it('TA 6 / TB 5, an absent suspended entrant at TB: TB (4 left) cannot fit into TA (3 free) — NOT broken, plays on short-handed, nobody seatless', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    absentSuspended(w, 'b4', 204);
    const TB = w.tables.get('TB')!;
    expect(TB.startNewHand()).toBe(true);                                    // dealt 4-handed
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TA', 'TB']);
    expect(w.couldNotPlace()).toEqual([]);
    expect(w.seatless()).toEqual([]);
    expect(w.tm.getAliveCount(w.tid)).toBe(10);
    expect(w.m.tournamentHandStartSafety).toMatchObject({ handStartsVetoed: 0, breaksAbortedNoSeats: 0 });
    expect(TB.seats.filter((s) => s.state === 'occupied' && s.holeCards.length === 2)).toHaveLength(4);
  });

  it('CONTROL — the pre-P1 plan (no capacity check) breaks TB anyway: b3 is left seatless while still alive', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over: { rebalance: withoutCapacityPlan(P.rebalance) } });
    absentSuspended(w, 'b4', 204);
    expect(w.tables.get('TB')!.startNewHand()).toBe(false);                 // vetoed: TB was broken
    expect(w.couldNotPlace()).toHaveLength(1);
    expect(w.seatless()).toEqual(['b3']);
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);
  });

  it('TA has 5 alive + 3 BUSTED seats (still occupied), TB 5 incl. an absent suspended entrant: the busted seats are stood up and TB\'s 4 players take them — TB broken, nobody seatless', () => {
    const w = world({ layout: { TA: field('a', 8, 5000, 100), TB: field('b', 5, 5000, 200) } });
    bust(w, 'TA', [5, 6, 7]);
    absentSuspended(w, 'b4', 204);
    // a5 busted but is still watching on a live socket whose session points at his old seat.
    const a5 = w.seatLive('S-a5', 'TA', 5, 105, 'm-a5');
    const TA = w.tables.get('TA')!;
    const TB = w.tables.get('TB')!;
    const before = w.chipsInPlay();
    expect(TB.startNewHand()).toBe(false);                                    // TB broken by the held rebalance → its deal vetoed
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);
    expect(w.couldNotPlace()).toEqual([]);
    expect(w.seatless()).toEqual([]);
    expect(TA.seats.filter((s) => s.state === 'occupied')).toHaveLength(9);
    expect(TA.seats.filter((s) => s.eliminated)).toHaveLength(0);
    expect(w.m.tournamentHandStartSafety).toMatchObject({ bustedSeatsVacated: 3, handStartsVetoed: 1 });
    // a5's stale session no longer points at the seat b-something now holds — he spectates instead.
    expect(w.playerSessions.has('S-a5')).toBe(false);
    expect(w.spectators.get('TA')?.has('S-a5')).toBe(true);
    expect(a5.connected).toBe(true);
    // Conservation: the 4 moved stacks are on TA; b4's (disqualified) stack is gone from play, never credited.
    expect(w.chipsInPlay()).toBe(before - 5000);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — the pre-P1 seat search (empty seats only) and plan: 3 of TB\'s 4 players are left seatless', () => {
    const w = world({
      layout: { TA: field('a', 8, 5000, 100), TB: field('b', 5, 5000, 200) },
      over: { rebalance: withoutCapacityPlan(P.rebalance), helpers: P.helpers.replace(BUSTED_PLACEABLE, '  return false;\n') },
    });
    expect(P.helpers).toContain(BUSTED_PLACEABLE);
    bust(w, 'TA', [5, 6, 7]);
    absentSuspended(w, 'b4', 204);
    w.tables.get('TB')!.startNewHand();
    expect(w.couldNotPlace()).toHaveLength(3);
    expect(w.seatless()).toHaveLength(3);
    expect(w.tables.get('TA')!.seats.filter((s) => s.state === 'occupied')).toHaveLength(9);   // 6 + 3 busted
  });

  it('a short table that cannot be broken DEALS (it used to wait for a rebalance that never came — a stall)', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 4, 5000, 200) } });
    const TB = w.tables.get('TB')!;
    (TB as any).currentPhase = GamePhase.HandComplete;
    const start = jest.spyOn(TB, 'startNewHand');
    w.m.autoStartNextHand('TB');
    expect(start).toHaveBeenCalledTimes(1);
    expect(TB.handNumber).toBe(1);
  });

  it('CONTROL — the pre-P1 guard (< 5 alive → wait for a rebalance) never deals that table', () => {
    const NEW = 'if (aliveOnTable < 5 && planTournamentRebalance(tId)) {';
    expect(P.autoStart).toContain(NEW);
    // The P1 plan says "no break possible"; the old guard waits for one anyway — forever.
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 4, 5000, 200) }, over: { autoStart: P.autoStart.replace(NEW, 'if (aliveOnTable < 5) {') } });
    const TB = w.tables.get('TB')!;
    (TB as any).currentPhase = GamePhase.HandComplete;
    const start = jest.spyOn(TB, 'startNewHand');
    w.m.autoStartNextHand('TB');
    expect(start).not.toHaveBeenCalled();
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TA', 'TB']);
  });

  it('a table is never broken MID-HAND: the break waits for its hand boundary, and every chip of the pot travels with the players', () => {
    // 9 alive on 2 tables → Rule 1: TB (3) fits into TA (3 free).
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 3, 5000, 200) } });
    const TB = w.tables.get('TB')!;
    const total = w.chipsInPlay();
    expect(TB.startNewHand()).toBe(true);                                    // TB's hand is live: blinds in the pot
    w.m.handleTableRebalance(w.tid);
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TA', 'TB']);   // deferred
    expect(w.m.tournamentBreaksAwaitingHandEnd.get('TB')).toBe(w.tid);
    expect(w.m.tournamentHandStartSafety.breaksDeferredMidHand).toBe(1);
    w.m.handleTableRebalance(w.tid);                                         // asked again (5s sweep): counted once
    expect(w.m.tournamentHandStartSafety.breaksDeferredMidHand).toBe(1);
    foldOut(TB);                                                             // TB's hand ends
    expect(TB.currentPhase).toBe(GamePhase.HandComplete);
    w.m.autoStartNextHand('TB');                                             // its hand boundary: the break runs now
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);
    expect(w.m.tournamentBreaksAwaitingHandEnd.has('TB')).toBe(false);
    expect(w.seatless()).toEqual([]);
    expect(w.chipsInPlay()).toBe(total);                                     // nothing left behind on TB
  });

  it('CONTROL — without the deferral a mid-hand break leaves the live pot on the broken table (tournament chips destroyed)', () => {
    const DEFER = '  if (breakTable && breakTable.isHandInProgress()) {';
    expect(P.rebalance).toContain(DEFER);
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 3, 5000, 200) }, over: { rebalance: P.rebalance.replace(DEFER, '  if (false) {') } });
    const total = w.chipsInPlay();
    expect(w.tables.get('TB')!.startNewHand()).toBe(true);
    w.m.handleTableRebalance(w.tid);
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);
    expect(w.chipsInPlay()).toBe(total - (SB + BB));                         // the blinds stayed in TB's pot
  });

  it('a 0-chip player the bust check is eliminating is NOT moved (he used to be resurrected with his starting stack) — the break waits for his elimination (Q1)', () => {
    // TA 5 / TB 5: two busts on TB in ONE hand — the FIRST elimination (9 alive ≤ 9) asks to break TB from
    // inside TB's own bust loop, while the second bust (b4, 0 chips) is still alive in the tournament:
    // Q1 defers that break; b4's own elimination (next in the loop) re-runs it and TB breaks then.
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const TB = w.tables.get('TB')!;
    TB.seats[3].chipCount = 0;                                               // b3 and b4 lost everything this hand
    TB.seats[4].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    const before = w.chipsInPlay();
    void w.m.handleHandComplete('TB', []);
    expect(w.tm.getTournament(w.tid)!.players.filter((p) => ['b3', 'b4'].includes(p.playerId)).every((p) => p.eliminated)).toBe(true);
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);
    const TA = w.tables.get('TA')!;
    expect(TA.seats.filter((s) => s.state === 'occupied').map((s) => s.playerId).sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'b0', 'b1', 'b2']);
    expect(w.seatless()).toEqual([]);
    expect(w.chipsInPlay()).toBe(before);                                    // no starting stack conjured for b3/b4
    expect(w.logs.filter((l) => l.includes('rebalance_pending_bust_not_moved'))).toEqual([expect.stringContaining('"playerId":"b4"')]);
    expect(w.logs.filter((l) => l.includes('rebalance_pending_bust_not_moved'))).toEqual([expect.stringContaining('"outcome":"break_deferred"')]);
    expect(w.m.tournamentHandStartSafety.breaksDeferredPendingBust).toBe(1);
    expect(w.m.tournamentBreaksAwaitingHandEnd.has('TB')).toBe(false);
    expect(w.couldNotPlace()).toEqual([]);
  });

  it('CONTROL — moving the pending bust (pre-P1) seats him on TA with a phantom stack while he is eliminated', () => {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 5, 5000, 200) }, over: { rebalance: withPreM1MoverStack(withoutPendingBustDeferral(P.rebalance)) } });
    const TB = w.tables.get('TB')!;
    TB.seats[3].chipCount = 0;
    TB.seats[4].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    const before = w.chipsInPlay();
    void w.m.handleHandComplete('TB', []);
    const zombie = w.tables.get('TA')!.seats.find((s) => s.state === 'occupied' && s.playerId === 'b4');
    expect(zombie!.chipCount).toBeGreaterThan(0);                            // a stack conjured (his record's starting chips) for an eliminated player
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b4')!.eliminated).toBe(true);
    expect(w.chipsInPlay()).toBeGreaterThan(before);
  });
});

describe('P2 — a hand is never started inside the previous hand\'s completion; the FINISHED hand\'s seed is the one revealed', () => {
  function bustOnTA() {
    // TA 7 / TB 5 / TC 6 = 18 on 3 tables; a6 busts on TA → TB (smallest) is broken from INSIDE TA's 'handResult'.
    const w = world({ layout: { TA: field('a', 7, 5000, 100), TB: field('b', 5, 5000, 200), TC: field('c', 6, 5000, 300) } });
    const TA = w.tables.get('TA')!;
    const commits: Array<{ h: number; hash: string }> = [];
    const reveals: Array<{ h: number; hash: string; seed: string }> = [];
    TA.on('deckCommitment', (c: any) => commits.push({ h: c.handNumber, hash: c.hash }));
    TA.on('deckSeedRevealed', (c: any) => reveals.push({ h: c.handNumber, hash: c.hash, seed: c.seed }));
    let duringHandResult: { hand: number; phase: string } | null = null;
    // The real wiring: ensureTableProgressListener's 'handResult' → handleHandComplete (sync up to the bust check here).
    TA.on('handResult', (d: any) => {
      void w.m.handleHandComplete('TA', d.results);
      duringHandResult = { hand: TA.handNumber, phase: TA.currentPhase };
    });
    return { w, TA, commits, reveals, get duringHandResult() { return duringHandResult; } };
  }

  it('a bust on TA breaks TB inside TA.determineWinners: TA is NOT restarted there; the revealed seed is hand 1\'s (its committed hash); hand 2\'s seed is never revealed', async () => {
    const x = bustOnTA();
    const refusedBefore = PokerTable.completingHandStartsRefused;
    expect(x.TA.startNewHand()).toBe(true);
    const a6 = x.TA.seats.find((s) => s.playerId === 'a6')!;
    a6.chipCount = 0; a6.folded = true;                                       // a6 lost everything this hand
    foldOut(x.TA);
    await flush();
    expect(x.w.tm.getTournament(x.w.tid)!.tableIds.sort()).toEqual(['TA', 'TC']);   // TB broken by the bust
    expect(x.duringHandResult).toEqual({ hand: 1, phase: GamePhase.HandComplete });   // not restarted inside its own handResult
    expect(x.TA.handNumber).toBe(1);
    expect(PokerTable.completingHandStartsRefused).toBe(refusedBefore);              // the restart never even tried
    expect(x.reveals).toHaveLength(1);
    expect(x.reveals[0].h).toBe(1);
    expect(x.reveals[0].hash).toBe(x.commits.find((c) => c.h === 1)!.hash);
    // Its next hand comes from the hand-boundary scheduler (autoStartNextHand), later:
    expect(x.TA.startNewHand()).toBe(true);
    expect(x.TA.handNumber).toBe(2);
    expect(x.reveals.map((r) => r.h)).toEqual([1]);                          // hand 2 is live: its seed stays secret
  });

  it('CONTROL — the pre-P2 restart loop (start a finished table right there) tries to deal TA inside its own handResult; only PokerTable\'s completing-hand guard refuses it', async () => {
    const SKIP = ' || table.isCompletingHand()';
    const SCHEDULE = '    if (table.currentPhase === GamePhase.HandComplete) {\n      if (!pendingAutoStartTimers.has(tid)) scheduleAutoStart(tid);\n      continue;\n    }\n';
    expect(P.helpers).toContain(SKIP);
    expect(P.helpers).toContain(SCHEDULE);
    const w = world({ layout: { TA: field('a', 7, 5000, 100), TB: field('b', 5, 5000, 200), TC: field('c', 6, 5000, 300) }, over: { helpers: P.helpers.replace(SKIP, '').replace(SCHEDULE, '') } });
    const TA = w.tables.get('TA')!;
    const reveals: number[] = [];
    TA.on('deckSeedRevealed', (c: any) => reveals.push(c.handNumber));
    TA.on('handResult', (d: any) => { void w.m.handleHandComplete('TA', d.results); });
    const refusedBefore = PokerTable.completingHandStartsRefused;
    expect(TA.startNewHand()).toBe(true);
    const a6 = TA.seats.find((s) => s.playerId === 'a6')!;
    a6.chipCount = 0; a6.folded = true;
    foldOut(TA);
    await flush();
    expect(PokerTable.completingHandStartsRefused).toBe(refusedBefore + 1);   // the nested start WAS attempted…
    expect(TA.handNumber).toBe(1);                                            // …and refused
    expect(reveals).toEqual([1]);
  });

  it('PokerTable: a handResult listener calling startNewHand is refused (counted); the revealed commitment is the finished hand\'s', () => {
    const t = new PokerTable({ tableId: 'x', tableName: 'x', smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 } as any);
    for (let i = 0; i < 3; i++) t.sitDown(i, `p${i}`, 1000, `p${i}`, true);
    const commits: any[] = [];
    const reveals: any[] = [];
    t.on('deckCommitment', (c: any) => commits.push(c));
    t.on('deckSeedRevealed', (c: any) => reveals.push(c));
    const before = PokerTable.completingHandStartsRefused;
    let inner: boolean | null = null;
    let completingInside = false;
    t.once('handResult', () => { completingInside = t.isCompletingHand(); inner = t.startNewHand(); });
    expect(t.startNewHand()).toBe(true);
    foldOut(t);
    expect(completingInside).toBe(true);
    expect(inner).toBe(false);
    expect(PokerTable.completingHandStartsRefused).toBe(before + 1);
    expect(t.isCompletingHand()).toBe(false);
    expect(t.handNumber).toBe(1);
    expect(reveals.map((r) => [r.handNumber, r.hash])).toEqual([[1, commits[0].hash]]);
    expect(t.startNewHand()).toBe(true);                                     // the next start (after the completion) deals normally
    expect(t.handNumber).toBe(2);
  });

  it('CONTROL — without the completing-hand guard a handResult listener deals hand 2 INSIDE hand 1\'s completion', () => {
    class PreP2Table extends PokerTable {
      protected whileCompletingHand(fn: () => void): void { fn(); }
    }
    const t = new PreP2Table({ tableId: 'y', tableName: 'y', smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 } as any);
    for (let i = 0; i < 3; i++) t.sitDown(i, `p${i}`, 1000, `p${i}`, true);
    let inner: boolean | null = null;
    t.once('handResult', () => { inner = t.startNewHand(); });
    expect(t.startNewHand()).toBe(true);
    foldOut(t);
    expect(inner).toBe(true);                                                // dealt from inside the previous hand's emit
    expect(t.handNumber).toBe(2);
  });

  it('variants: an Omaha / Stud override emitting handResult itself is covered too (startNewHand refused inside it)', () => {
    // The guard is in PokerTable.emit for every 'handResult' / 'handHistory' emit, whichever determineWinners sent it.
    const t = new PokerTable({ tableId: 'z', tableName: 'z', smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 } as any);
    for (let i = 0; i < 3; i++) t.sitDown(i, `p${i}`, 1000, `p${i}`, true);
    let inner: boolean | null = null;
    t.once('handResult', () => { inner = t.startNewHand(); });
    t.emit('handResult', { results: [], handNumber: 0 });                    // as OmahaTable / SevenStudTable hi-lo do
    expect(inner).toBe(false);
    expect(t.isCompletingHand()).toBe(false);
  });
});

describe('P6 — the rebalance moves a player by his SEAT, on every live socket, and his reservation', () => {
  /** T1 4 / T2 5 = 9 alive on 2 tables → threshold 9 → T1 breaks. Alice = T1 seat 0, registered on socket reg-alice (gone). */
  function twoTables() {
    const w = world({
      layout: {
        T1: [{ pid: 'p-alice', name: 'alice', stack: 7000, uid: 101 }, ...field('d', 3, 5000, 110)],
        T2: field('g', 5, 5000, 120),
      },
    });
    return w;
  }

  it('a player who RECONNECTED (session on S2, not his registration socket): his session, room and tournament socket follow the stack to T2; playerMoved is sent', () => {
    const w = twoTables();
    const s2 = w.seatLive('S2', 'T1', 0, 101, 'm-alice');
    w.m.handleTableRebalance(w.tid);
    const T2 = w.tables.get('T2')!;
    const seat = T2.seats.findIndex((s) => s.playerId === 'p-alice');
    expect(seat).toBeGreaterThan(-1);
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 'T2', seatIndex: seat });
    expect([...s2.rooms]).toEqual(['table:T2']);
    expect(s2.emitted).toEqual([['playerMoved', { fromTable: 'T1', toTable: 'T2', toSeat: seat, tableId: 'T2' }]]);
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'p-alice')!.socketId).toBe('S2');
    expect(w.m.tournamentHandStartSafety.reconnectedSessionsMoved).toBe(1);
  });

  it('CONTROL — moving only the REGISTRATION socket\'s session (pre-P6) leaves the reconnected player on the broken table', () => {
    const OLD = "(fromSeat >= 0 ? s.seatIndex === fromSeat : sid === tp?.socketId)";
    expect(P.helpers).toContain(OLD);
    const w = world({
      layout: { T1: [{ pid: 'p-alice', name: 'alice', stack: 7000, uid: 101 }, ...field('d', 3, 5000, 110)], T2: field('g', 5, 5000, 120) },
      over: { helpers: P.helpers.replace(OLD, 'sid === tp?.socketId') },
    });
    w.seatLive('S2', 'T1', 0, 101, 'm-alice');
    w.m.handleTableRebalance(w.tid);
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 'T1', seatIndex: 0 });   // stuck on the broken table
    expect(w.tables.get('T2')!.seats.some((s) => s.playerId === 'p-alice')).toBe(true);  // while his stack plays on T2
  });

  it('a DISCONNECTED player\'s reservation follows the stack (his reconnect restores the NEW seat)', () => {
    const w = twoTables();
    w.reservedSeats.set(101, { tableId: 'T1', seatIndex: 0, playerName: 'alice', chips: 7000, expiresAt: Date.now() + 3600e3, cleanupTimer: null, handsRemaining: 20, tournament: true });
    w.m.handleTableRebalance(w.tid);
    const seat = w.tables.get('T2')!.seats.findIndex((s) => s.playerId === 'p-alice');
    expect(w.reservedSeats.get(101)).toMatchObject({ tableId: 'T2', seatIndex: seat, tournament: true });
    expect(w.m.tournamentHandStartSafety.reservationsMoved).toBe(1);
  });

  it('a session of ANOTHER account that points at the old seat is never moved onto the stack', () => {
    const w = twoTables();
    w.seatLive('S-mallory', 'T1', 0, 999, 'm-mallory');                    // stale pointer, someone else's account
    w.m.handleTableRebalance(w.tid);
    expect(w.playerSessions.get('S-mallory')).toMatchObject({ tableId: 'T1', seatIndex: 0 });
    expect(w.logs.some((l) => l.includes('rebalance_session_not_moved_other_account'))).toBe(true);
  });

  it('a session on a socket that is GONE is left to its disconnect handler', () => {
    const w = twoTables();
    const s = w.seatLive('S2', 'T1', 0, 101, 'm-alice');
    s.connected = false;
    w.live.delete('S2');
    w.m.handleTableRebalance(w.tid);
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 'T1' });
  });
});

describe('P1/P2 — wiring', () => {
  it('every rebalance decision uses the capacity plan; the restart loop never starts a finished table itself', () => {
    expect(P.rebalance).not.toContain('tournamentManager.checkRebalance(');
    expect(P.autoStart).toContain('planTournamentRebalance(tId)');
    expect(SRC).toContain('return tournamentManager.checkRebalance(tournamentId, (tid) => tournamentFreeSeats(tournamentId, tid));');
    const interval = fnSrc('function sweepTournamentRebalances(');
    expect(interval).toContain('planTournamentRebalance(tournamentId)');
    expect(interval).toContain('pruneBrokenTournamentTables();');
    expect(SRC).toContain('setInterval(sweepTournamentRebalances, 5000);');
    // The only startNewHand in the restart path is for a WaitingForPlayers table.
    const restart = fnSrc('function restartWaitingTournamentTables(');
    expect(restart.indexOf('scheduleAutoStart(tid)')).toBeLessThan(restart.indexOf('table.startNewHand()'));
    expect(SRC).toContain("completingHandStartsRefused: PokerTable.completingHandStartsRefused,");
  });
});

// ───────────────────────────── Q1 / Q2 (2026-10-10, review of P1) ─────────────────────────────

/**
 * The hand-complete persistence handleHandComplete awaits for every signed-in
 * human BEFORE its bust check (mergeUserStats → saveProgress → tickScratchProgress).
 * `hold` gates the first one so a test can run another table's events meanwhile.
 */
function persistenceScope(hold: Promise<void> | null) {
  const noop = () => undefined;
  const progressionManager = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => {
      if (k === 'getClientProgress') return () => ({ hydrated: true, xp: 0, level: 1, achievements: [] });
      if (k === 'getProgress') return () => ({});
      return noop;
    },
  });
  return {
    progressionManager,
    sendProgressToPlayer: noop,
    mergeUserStats: async () => { if (hold) await hold; },
    saveProgress: async () => true,
    tickScratchProgress: async () => false,
    pushActivity: noop,
  };
}

/** Every playerEliminated event (eliminator attribution) for this world's tournament. */
function eliminations(w: ReturnType<typeof world>) {
  const out: Array<{ playerId: string; eliminatorId?: string }> = [];
  w.tm.onEvent(w.tid, (ev, d) => { if (ev === 'playerEliminated') out.push({ playerId: d.playerId, eliminatorId: d.eliminatorId }); });
  return out;
}

/**
 * Play the tournament down: everyone alive except `keep` busts (TournamentManager
 * directly) — everyone who HAS a seat: a seatless entrant can never bust.
 */
function playDownTo(w: ReturnType<typeof world>, keep: string) {
  const t = w.tm.getTournament(w.tid)!;
  const seatless = new Set(w.seatless());
  for (const p of [...t.players]) if (!p.eliminated && p.playerId !== keep && !seatless.has(p.playerId)) w.tm.eliminatePlayer(w.tid, p.playerId);
  return t;
}

describe('Q1 — a break never strands a bust whose check is still pending (another table\'s bust breaks TB during TB\'s hand-complete awaits)', () => {
  /**
   * The reviewer's e1, with the REAL awaits: TA 6 / TB 4. TB's hand ends with
   * b3 at 0 chips and TB's handleHandComplete is suspended in a signed-in
   * player's persistence (its bust check has not run). TA's hand ends with a5
   * busting → playerEliminated → handleTableRebalance: 9 alive ≤ 9 → Rule 1
   * breaks TB (4) into TA (3 empty + a5's busted seat).
   */
  async function e1(over: Partial<typeof P> = {}) {
    const hold = deferred();
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 4, 5000, 200) }, over, scope: persistenceScope(hold.p) });
    const elim = eliminations(w);
    const TA = w.tables.get('TA')!;
    const TB = w.tables.get('TB')!;
    const sB1 = w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');                     // a signed-in human on TB
    TB.seats[3].chipCount = 0;                                                 // b3 lost everything this hand
    (TB as any).currentPhase = GamePhase.HandComplete;
    TA.seats[5].chipCount = 0;                                                 // a5 too, on TA
    (TA as any).currentPhase = GamePhase.HandComplete;
    const before = w.chipsInPlay();
    const tbDone = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 400 }]);   // b0 won TB's pot
    await flush();                                                            // …TB is now inside mergeUserStats
    await w.m.handleHandComplete('TA', []);                                   // TA's bust check runs first
    const mid = {
      tableIds: [...w.tm.getTournament(w.tid)!.tableIds].sort(),
      b3Alive: !w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b3')!.eliminated,
      seatless: w.seatless(),
    };
    return { w, elim, TA, TB, sB1, before, tbDone, hold, mid };
  }

  it('the break is DEFERRED until TB\'s bust check has run; then b3 is eliminated (by b0), TB broken, nobody seatless, no chip lost or minted, the tournament finishes', async () => {
    const x = await e1();
    expect(x.mid).toEqual({ tableIds: ['TA', 'TB'], b3Alive: true, seatless: [] });   // NOT broken under the pending bust
    expect(x.w.m.tournamentBreaksAwaitingHandEnd.get('TB')).toBe(x.w.tid);
    expect(x.w.m.tournamentHandStartSafety.breaksDeferredPendingBust).toBe(1);
    expect(x.w.logs.some((l) => l.includes('rebalance_pending_bust_not_moved') && l.includes('"outcome":"break_deferred"') && l.includes('"playerId":"b3"'))).toBe(true);
    // TB's own hand boundary meanwhile (its scheduled autoStartNextHand): it neither deals nor breaks.
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(0);
    expect(x.w.tm.getTournament(x.w.tid)!.tableIds.sort()).toEqual(['TA', 'TB']);
    // TB's persistence finishes → its bust check eliminates b3 → that elimination breaks TB.
    x.hold.resolve();
    await x.tbDone;
    await flush();
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(t.tableIds).toEqual(['TA']);
    expect(t.players.find((p) => p.playerId === 'b3')!.eliminated).toBe(true);
    expect(x.elim.filter((e) => e.playerId === 'b3')).toEqual([{ playerId: 'b3', eliminatorId: 'b0' }]);
    expect(x.w.seatless()).toEqual([]);
    expect(x.w.couldNotPlace()).toEqual([]);
    expect(x.w.chipsInPlay()).toBe(x.before);                                 // every chip is on TA, none conjured
    expect(x.w.credits).toEqual([]);                                          // nothing credited to any wallet
    expect(x.w.m.tournamentBreaksAwaitingHandEnd.has('TB')).toBe(false);
    expect(x.w.playerSessions.get('S-b1')).toMatchObject({ tableId: 'TA' });  // P6: b1's session followed his stack
    // Exactly once: TB's bust check running again finds nothing new.
    await x.w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 400 }]);
    expect(x.elim.filter((e) => e.playerId === 'b3')).toHaveLength(1);
    expect(t.eliminationOrder.filter((id: string) => id === 'b3')).toHaveLength(1);
    // The tournament can finish.
    playDownTo(x.w, 'a0');
    expect(t.status).toBe('finished');
    expect(x.w.seatless()).toEqual([]);
  });

  it('CONTROL — pre-Q1 (P1\'s "pending bust is never moved" skip, no deferral, bust check by tournamentTables alone): b3 is left seatless and ALIVE — the tournament can never finish', async () => {
    const x = await e1({ rebalance: withPendingBustSkip(withoutPendingBustDeferral(P.rebalance)), helpers: withLiveOnlyBustLookup(P.helpers) });
    expect(x.mid).toEqual({ tableIds: ['TA'], b3Alive: true, seatless: ['b3'] });   // TB broken under him
    x.hold.resolve();
    await x.tbDone;
    await flush();
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(t.players.find((p) => p.playerId === 'b3')!.eliminated).toBe(false);   // never eliminated
    expect(x.w.seatless()).toEqual(['b3']);
    playDownTo(x.w, 'a0');
    expect(t.status).toBe('running');                                                // a0 + the seatless b3: stuck forever
    expect(t.players.filter((p) => !p.eliminated).map((p) => p.playerId).sort()).toEqual(['a0', 'b3']);
  });

  it('(a) alone — even when TB WAS broken under the pending bust, its late bust check resolves the tournament through the broken-table registry: b3 eliminated once (by b0), the tournament finishes', async () => {
    const x = await e1({ rebalance: withPendingBustSkip(withoutPendingBustDeferral(P.rebalance)) });
    expect(x.mid).toEqual({ tableIds: ['TA'], b3Alive: true, seatless: ['b3'] });   // broken (the deferral is off)
    x.hold.resolve();
    await x.tbDone;
    await flush();
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(x.w.logs.some((l) => l.includes('bust_check_on_broken_table'))).toBe(true);
    expect(x.elim.filter((e) => e.playerId === 'b3')).toEqual([{ playerId: 'b3', eliminatorId: 'b0' }]);
    expect(x.w.seatless()).toEqual([]);
    await x.w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 400 }]);         // and only once
    expect(x.elim.filter((e) => e.playerId === 'b3')).toHaveLength(1);
    playDownTo(x.w, 'a0');
    expect(t.status).toBe('finished');
  });

  it('(b) alone — with the bust check still looking at tournamentTables only, the deferral keeps TB a tournament table until b3 is eliminated: same good outcome', async () => {
    const x = await e1({ helpers: withLiveOnlyBustLookup(P.helpers) });
    expect(x.mid).toEqual({ tableIds: ['TA', 'TB'], b3Alive: true, seatless: [] });
    x.hold.resolve();
    await x.tbDone;
    await flush();
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(t.tableIds).toEqual(['TA']);
    expect(x.w.seatless()).toEqual([]);
    playDownTo(x.w, 'a0');
    expect(t.status).toBe('finished');
  });

  it('the 5s sweep asking for the same break while the bust check is pending defers it too (no break, counted once)', async () => {
    const x = await e1();
    x.w.m.handleTableRebalance(x.w.tid);                                      // sweep / admin rebalance
    x.w.m.handleTableRebalance(x.w.tid);
    expect(x.w.tm.getTournament(x.w.tid)!.tableIds.sort()).toEqual(['TA', 'TB']);
    expect(x.w.m.tournamentHandStartSafety.breaksDeferredPendingBust).toBe(1);
    x.hold.resolve();
    await x.tbDone;
    await flush();
    expect(x.w.tm.getTournament(x.w.tid)!.tableIds).toEqual(['TA']);
    expect(x.w.seatless()).toEqual([]);
  });

  it('a throw in one player\'s hand-complete persistence no longer skips the bust check', async () => {
    const w = world({
      layout: { TA: field('a', 5, 5000, 100), TB: field('b', 5, 5000, 200) },
      scope: { ...persistenceScope(null), mergeUserStats: async () => { throw new Error('pool exhausted'); } },
    });
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    const TB = w.tables.get('TB')!;
    TB.seats[3].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await expect(w.m.handleHandComplete('TB', [])).resolves.toBeUndefined();
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b3')!.eliminated).toBe(true);
    expect(w.logs.some((l) => l.includes('progress persistence failed'))).toBe(true);
  });
});

/** The REAL qualifier re-entry re-seat block (registerQualifierTournament, step (d)). */
const REENTRY = slice('        const startingStack = qt.startingStack || 50000;', '          if (seated) break;\n        }\n');
function reenter(w: ReturnType<typeof world>, pid: string, socket: any, body: string = REENTRY) {
  const code = `function reenterSeat(tournament, qt, existingEntry, socket) {\n${body}\n  return seated;\n}`;
  const f = load(code, {
    tableManager: { getTable: (id: string) => w.tables.get(id) }, tournamentManager: w.tm, playerSessions: w.playerSessions,
    spectators: w.spectators, tournamentHandStartSafety: w.m.tournamentHandStartSafety, console: { log() {} },
  }, '{ reenterSeat }').exports.reenterSeat;
  return f(w.tm.getTournament(w.tid)!, { startingStack: 5000, tournamentId: w.tid }, { playerId: pid, playerName: pid }, socket);
}
const seatsOfTable = (t: PokerTable) => t.seats.filter((x) => x.state === 'occupied').map((x) => `${x.seatIndex}:${x.playerId}:${x.chipCount}:${x.eliminated ? 'E' : 'A'}`);

describe('Q2 — the rebalance finds a mover by his LIVE seat (a re-entered qualifier player\'s OLD busted seat has the same playerId)', () => {
  /** The reviewer's e3: a3 busted at TA seat 3, re-entered at TA seat 4 (5000); TA 4 alive / TB 5 → Rule 1 breaks TA into TB. */
  function e3(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 4, 5000, 100), TB: field('b', 5, 5000, 200) }, over });
    bust(w, 'TA', [3]);
    const s = w.seatLive('S-a3', 'TA', 3, 103, 'm-a3');
    expect(reenter(w, 'a3', s)).toBe(true);                                   // the REAL re-entry block: seat 4
    const TA = w.tables.get('TA')!;
    expect(seatsOfTable(TA)).toEqual(['0:a0:5000:A', '1:a1:5000:A', '2:a2:5000:A', '3:a3:0:E', '4:a3:5000:A']);
    expect(w.playerSessions.get('S-a3')).toMatchObject({ tableId: 'TA', seatIndex: 4 });
    const before = w.chipsInPlay();
    w.m.handleTableRebalance(w.tid);
    return { w, s, before };
  }

  it('a3 is moved from his LIVE seat with his live stack; his session follows; nobody seatless; no chip lost or minted', () => {
    const { w, s, before } = e3();
    const TB = w.tables.get('TB')!;
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TB']);
    expect(w.seatless()).toEqual([]);
    const a3 = TB.seats.find((x) => x.state === 'occupied' && x.playerId === 'a3')!;
    expect(a3.chipCount).toBe(5000);
    expect(w.playerSessions.get('S-a3')).toMatchObject({ tableId: 'TB', seatIndex: a3.seatIndex });
    expect(s.emitted).toContainEqual(['playerMoved', expect.objectContaining({ fromTable: 'TA', toTable: 'TB', toSeat: a3.seatIndex })]);
    expect(w.chipsInPlay()).toBe(before);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — the P1 lookup (playerId only) hits a3\'s OLD busted seat: he is taken for a pending bust, left seatless, and his 5000 go with TA', () => {
    const { w, before } = e3({ rebalance: withPendingBustSkip(withPlayerIdOnlyLookup(P.rebalance)) });
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TB']);
    expect(w.seatless()).toEqual(['a3']);
    expect(w.chipsInPlay()).toBe(before - 5000);
  });

  it('a re-entered player\'s OLD busted seat is free capacity (and is stood up for a mover); his live seat is never touched', () => {
    // TA: a0-a4 + a5 busted at seat 5, re-entered at seat 6; seats 7, 8 empty. TB: 3 alive.
    // 9 alive ≤ 9 → Rule 1: TB fits only if a5's dead seat counts (2 empty + 1 = 3).
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 3, 5000, 200) } });
    bust(w, 'TA', [5]);
    expect(reenter(w, 'a5', w.mkSocket('S-a5'))).toBe(true);
    const TA = w.tables.get('TA')!;
    expect(seatsOfTable(TA).slice(5)).toEqual(['5:a5:0:E', '6:a5:5000:A']);
    const before = w.chipsInPlay();
    w.m.handleTableRebalance(w.tid);
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);
    expect(w.seatless()).toEqual([]);
    expect(TA.seats[6]).toMatchObject({ playerId: 'a5', chipCount: 5000, state: 'occupied' });
    expect(TA.seats.filter((x) => x.state === 'occupied' && x.eliminated)).toHaveLength(0);   // the dead seat went to a mover
    expect(w.m.tournamentHandStartSafety.bustedSeatsVacated).toBe(1);
    expect(w.chipsInPlay()).toBe(before);
  });

  it('CONTROL — the P1 placeability (alive entrant → never placeable) ignores that dead seat: TB cannot be broken', () => {
    const NEW = "  if (!tp || tp.eliminated) return true;\n  // Q2 — alive again (re-entry): placeable only if his LIVE seat is elsewhere.\n  return !!tournamentLiveSeatOf(tournamentId, tp.playerId);\n";
    expect(P.helpers).toContain(NEW);
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 3, 5000, 200) }, over: { helpers: P.helpers.replace(NEW, '  return !tp || !!tp.eliminated;\n') } });
    bust(w, 'TA', [5]);
    expect(reenter(w, 'a5', w.mkSocket('S-a5'))).toBe(true);
    w.m.handleTableRebalance(w.tid);
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TA', 'TB']);
  });

  it('a bounty is credited to the eliminator\'s LIVE seat, never to his old busted seat', async () => {
    const OLD = "const bountySeat = table.seats.find((es) => es?.playerId === eliminatorId && es.state === 'occupied');";
    // S1/M2 (2026-10-10): the bust check is runTournamentBustCheck (rebalance helpers); "broken" is read after the elimination.
    const NEW = 'const bountySeat = tournamentLiveSeatOf(tournamentId, eliminatorId, brokenNow ? undefined : tableId);';
    expect(P.helpers).toContain(NEW);
    const run = async (helpers: string) => {
      const w = world({ layout: { TA: field('a', 4, 5000, 100) }, config: { isBounty: true, bountyAmount: 1000 }, over: { helpers } });
      bust(w, 'TA', [0]);
      expect(reenter(w, 'a0', w.mkSocket('S-a0'))).toBe(true);              // a0 re-entered at seat 4
      const TA = w.tables.get('TA')!;
      TA.seats[1].chipCount = 0;                                              // a1 busts; a0 (seat 4) won the pot
      (TA as any).currentPhase = GamePhase.HandComplete;
      await w.m.handleHandComplete('TA', [{ seatIndex: 4, amount: 5000 }]);
      return { dead: TA.seats[0].chipCount, live: TA.seats[4].chipCount };
    };
    expect(await run(P.helpers)).toEqual({ dead: 0, live: 6000 });
    expect(await run(P.helpers.replace(NEW, OLD))).toEqual({ dead: 1000, live: 5000 });   // CONTROL: the dead seat got it
  });
});

describe('minor (2026-10-10) — a qualifier re-entry after his busted seat was vacated gets a session (he can act)', () => {
  function vacatedThenReentered(reentryBody: string = REENTRY) {
    // TA: a0-a4 alive + a5-a8 busted, a5 still watching on his live socket; TB 3; TC 7.
    // 15 alive on 3 tables → Rule 1 breaks TB: TC's 2 empty seats first, then a5's busted seat (vacated).
    const w = world({ layout: { TA: field('a', 9, 5000, 100), TB: field('b', 3, 5000, 200), TC: field('c', 7, 5000, 300) } });
    bust(w, 'TA', [5, 6, 7, 8]);
    const s = w.seatLive('S-a5', 'TA', 5, 105, 'm-a5');
    w.m.handleTableRebalance(w.tid);
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA', 'TC']);
    expect(w.playerSessions.has('S-a5')).toBe(false);                        // vacated: he spectates
    expect(w.spectators.get('TA')?.has('S-a5')).toBe(true);
    const TA = w.tables.get('TA')!;
    TA.standUp(6);                                                            // later, a seat frees up
    expect(reenter(w, 'a5', s, reentryBody)).toBe(true);                     // re-entered at TA seat 6
    return { w, TA };
  }

  it('the re-entry creates his session at the new seat (and he no longer spectates)', () => {
    const { w, TA } = vacatedThenReentered();
    expect(TA.seats[6]).toMatchObject({ playerId: 'a5', chipCount: 5000, state: 'occupied' });
    expect(w.playerSessions.get('S-a5')).toMatchObject({ tableId: 'TA', seatIndex: 6, playerId: 'a5' });
    expect(w.spectators.get('TA')?.has('S-a5')).toBe(false);
    expect(w.m.tournamentHandStartSafety.reentrySessionsCreated).toBe(1);
  });

  it('CONTROL — the pre-fix re-entry only MOVED an existing session: seated with no session, he could never act', () => {
    const OLD = "            if (sess) { sess.tableId = tid; sess.seatIndex = s; }\n            else {";
    expect(REENTRY).toContain(OLD);
    const { w, TA } = vacatedThenReentered(REENTRY.replace(OLD, "            if (sess) { sess.tableId = tid; sess.seatIndex = s; }\n            else if (false) {"));
    expect(TA.seats[6]).toMatchObject({ playerId: 'a5', state: 'occupied' });
    expect(w.playerSessions.has('S-a5')).toBe(false);
  });
});

describe('minor (2026-10-10) — the 5s sweep services EVERY tournament, even while one tournament\'s break is deferred', () => {
  const SWEEP = fnSrc('function sweepTournamentRebalances(');
  function run(sweep: string) {
    const tournamentTables = new Map([['T1a', 'tour1'], ['T1b', 'tour1'], ['T2a', 'tour2'], ['T2b', 'tour2']]);
    const calls: string[] = [];
    const { exports } = load(sweep, {
      tournamentTables, tournamentBreaksAwaitingHandEnd: new Map([['T1a', 'tour1']]),
      pruneBrokenTournamentTables() {},
      tournamentManager: { getTournament: (id: string) => ({ status: 'running', tableIds: id === 'tour1' ? ['T1a', 'T1b'] : ['T2a', 'T2b'] }) },
      planTournamentRebalance: (id: string) => ({ breakTableId: id === 'tour1' ? 'T1a' : 'T2b', playersToMove: [] }),
      handleTableRebalance: (id: string) => { calls.push(id); },                // tour1's break stays deferred (mid-hand)
      // S1 (2026-10-10): the sweep also prunes removed tables' bust-check captures.
      tournamentBustChecksPending: new Map(), tournamentDealsHeldForBustCheck: new Set(), tableManager: { getTable: () => ({}) },
    }, '{ sweepTournamentRebalances }');
    exports.sweepTournamentRebalances();
    exports.sweepTournamentRebalances();
    return calls;
  }
  it('both tournaments are rebalanced on every tick, each once', () => {
    expect(run(SWEEP)).toEqual(['tour1', 'tour2', 'tour1', 'tour2']);
  });
  it('CONTROL — the old `break` after the first tournament starves tour2 while tour1\'s break is deferred', () => {
    const CONT = 'continue; // never stop servicing the other tournaments (a deferred break re-asks every tick)';
    expect(SWEEP).toContain(CONT);
    expect(run(SWEEP.replace(CONT, 'break;'))).toEqual(['tour1', 'tour1']);
  });
});

describe('minor (2026-10-10) — Omaha / Stud HI-LO hands reveal their deck seed like every other hand (fairness)', () => {
  const cfg = (id: string) => ({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 } as any);
  function playOne(t: PokerTable) {
    for (let i = 0; i < 3; i++) t.sitDown(i, `p${i}`, 1000, `p${i}`, true);
    const commits: any[] = [];
    const reveals: any[] = [];
    t.on('deckCommitment', (c: any) => commits.push(c));
    t.on('deckSeedRevealed', (c: any) => reveals.push(c));
    let inner: boolean | null = null;
    let potNames: string[] = [];
    t.once('handResult', (d: any) => { potNames = d.results.map((r: any) => r.potName); inner = t.startNewHand(); });   // P2 holds inside the hi-lo emit too
    expect(t.startNewHand()).toBe(true);
    foldOut(t);
    return { commits, reveals, inner, potNames };
  }
  it('Omaha Hi-Lo: the finished hand\'s committed seed is revealed', () => {
    const x = playOne(new OmahaTable(cfg('o8'), true));
    expect(x.commits).toHaveLength(1);
    expect(x.reveals.map((r) => [r.handNumber, r.hash])).toEqual([[1, x.commits[0].hash]]);
    expect(x.inner).toBe(false);
  });
  it('Seven Card Stud Hi-Lo: the finished hand\'s committed seed is revealed', () => {
    // An ante, so the winner has invested and the HI-LO split runs (with nothing invested it defers to the base class).
    const x = playOne(new SevenStudTable({ ...cfg('s8'), ante: 10 }, false, true));
    expect(x.potNames).toEqual(['Main Pot (High)']);                    // the hi-lo override's own award
    expect(x.commits).toHaveLength(1);
    expect(x.reveals.map((r) => [r.handNumber, r.hash])).toEqual([[1, x.commits[0].hash]]);
    expect(x.inner).toBe(false);
  });
  it('wiring: both hi-lo overrides end through the base emitHandCompletion (no bare handResult emit left)', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['OmahaTable.ts', 'SevenStudTable.ts']) {
      const src: string = fs.readFileSync(path.join(__dirname, '..', 'src', 'game', 'variants', f), 'utf8');
      expect({ f, bare: src.includes("this.emit('handResult'") }).toEqual({ f, bare: false });
      expect({ f, via: src.includes('this.emitHandCompletion(results, ') }).toEqual({ f, via: true });
    }
  });
});

describe('minor (2026-10-10) — a tournament start binds a registrant\'s seat only to a socket still signed in as HIM', () => {
  const HELPERS = slice('const registrantBindings = {', 'return bound;\n}\n');
  const START = fnSrc('function startTournamentGame(');
  const START_Q = fnSrc('function startQualifierTournament(');
  function harness(start: string) {
    const tm = new TournamentManager();
    const tables = new Map<string, PokerTable>();
    let n = 0;
    const authSessions = new Map<string, any>();
    const playerSessions = new Map<string, any>();
    const live = new Map<string, any>();
    const mkSocket = (sid: string) => {
      const s: any = { id: sid, connected: true, emitted: [] as any[], rooms: new Set<string>() };
      s.emit = (ev: string, d: any) => s.emitted.push([ev, d]);
      s.join = (r: string) => s.rooms.add(r);
      s.leave = (r: string) => s.rooms.delete(r);
      live.set(sid, s);
      return s;
    };
    const { exports } = load(`${HELPERS}\n${start}`, {
      tournamentManager: tm, tournamentTables: new Map(), fastModeTables: new Map(), authSessions, playerSessions,
      io: { to: () => { const op: any = { emit() {}, except: () => op }; return op; }, emit() {}, sockets: { sockets: live } }, DEFAULT_BLIND_LEVELS,
      tableManager: {
        createQuickTable: (name: string, _seats: number, sb: number, bb: number, buyIn: number) => {
          const id = `T${++n}`;
          tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn: buyIn, maxBuyIn: buyIn * 10, maxPlayers: 9 } as any));
          return id;
        },
        getTable: (id: string) => tables.get(id),
      },
      notifyPlayer: async () => {}, ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {},
      bootstrapTournamentTables() {}, console: { log() {}, warn() {}, error() {} },
    }, '{ startTournamentGame: typeof startTournamentGame !== "undefined" ? startTournamentGame : null, startQualifierTournament: typeof startQualifierTournament !== "undefined" ? startQualifierTournament : null, registrantBindings }');
    return { tm, tables, authSessions, playerSessions, mkSocket, m: exports };
  }

  it('startTournamentGame: Alice\'s registration socket now signed in as BOB (with his own seat) → Alice is bound to her OWN other socket; Carl\'s signed-out socket → his seat is absent; Dave unchanged', () => {
    const h = harness(START);
    const tid = h.tm.createTournament({ name: 'SNG', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    for (const [pid, sid, uid] of [['p-alice', 'S1', 101], ['p-carl', 'S3', 103], ['p-dave', 'S4', 104]] as const) {
      h.mkSocket(sid);
      h.tm.registerPlayer(tid, pid, pid, sid, uid);
    }
    h.authSessions.set('S1', { userId: 102, username: 'bob' });               // B's stored sign-in landed on A's socket
    const bobSeat = { socketId: 'S1', tableId: 'cash', seatIndex: 2, playerName: 'bob', playerId: 'p-bob' };
    h.playerSessions.set('S1', bobSeat);
    h.mkSocket('S1b');
    h.authSessions.set('S1b', { userId: 101, username: 'alice' });            // Alice reconnected on S1b (no seat)
    h.authSessions.set('S4', { userId: 104, username: 'dave' });
    h.m.startTournamentGame(tid);
    const t = h.tm.getTournament(tid)!;
    expect(h.playerSessions.get('S1')).toBe(bobSeat);                         // Bob's own session untouched
    expect(h.playerSessions.get('S1b')).toMatchObject({ playerId: 'p-alice' });
    expect(h.playerSessions.get('S3')).toBeUndefined();                       // Carl: absent seat, no session
    expect(h.playerSessions.get('S4')).toMatchObject({ playerId: 'p-dave' });
    expect(Object.fromEntries(t.players.map((p) => [p.playerId, p.socketId]))).toEqual({ 'p-alice': 'S1b', 'p-carl': '', 'p-dave': 'S4' });
    expect(h.m.registrantBindings).toEqual({ rebound: 1, unbound: 1 });
    expect(h.tables.get('T1')!.seats.filter((s) => s.state === 'occupied')).toHaveLength(3);   // every registrant is seated
  });

  it('CONTROL — the pre-fix start binds Alice\'s seat to whoever holds her registration socket (Bob), overwriting his session', () => {
    const OLD = '    const boundSid = bindRegistrantSocket(tournamentId, tp);\n    if (!boundSid) continue;\n';
    expect(START).toContain(OLD);
    const h = harness(START.replace(OLD, '    const boundSid = tp.socketId;\n'));
    const tid = h.tm.createTournament({ name: 'SNG', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
    h.mkSocket('S1'); h.mkSocket('S4');
    h.tm.registerPlayer(tid, 'p-alice', 'alice', 'S1', 101);
    h.tm.registerPlayer(tid, 'p-dave', 'dave', 'S4', 104);
    h.authSessions.set('S1', { userId: 102, username: 'bob' });
    h.m.startTournamentGame(tid);
    expect(h.playerSessions.get('S1')).toMatchObject({ playerId: 'p-alice' });   // Bob's socket now plays Alice's stack
  });

  it('startQualifierTournament: by the registration\'s attested MASTER id', () => {
    const h = harness(START_Q);
    h.mkSocket('Q1'); h.mkSocket('Q2');
    h.authSessions.set('Q1', { userId: 102, username: 'bob', masterUserId: 'm-bob' });   // Alice's registration socket, now Bob
    h.authSessions.set('Q2', { userId: 103, username: 'carl', masterUserId: 'm-carl' });
    const r = h.m.startQualifierTournament([
      { id: 'q-alice', name: 'Alice A.', socketId: 'Q1', masterId: 'm-alice' },
      { id: 'q-carl', name: 'Carl C.', socketId: 'Q2', masterId: 'm-carl' },
    ], 50000);
    expect(r).toBeTruthy();
    expect(h.playerSessions.get('Q1')).toBeUndefined();
    expect(h.playerSessions.get('Q2')).toMatchObject({ playerId: 'q-carl' });
    const t = h.tm.getTournament(r.tournamentId)!;
    expect(t.players.find((p) => p.playerId === 'q-alice')!.socketId).toBe('');
  });
});

describe('Q1/Q2 + minors — wiring', () => {
  it('the mover lookup is the live-seat one; the pending-bust deferral precedes any move; no playerId-only seat lookup is left in the rebalance', () => {
    expect(P.rebalance).toContain(LIVE_LOOKUP);
    // The P1 log tag now names the DEFERRAL (outcome break_deferred) — no mover is skipped any more.
    expect(P.rebalance.indexOf("event: 'rebalance_pending_bust_not_moved', outcome: 'break_deferred'")).toBeGreaterThan(P.rebalance.indexOf(PENDING_DEFER));
    expect(P.rebalance.indexOf(PENDING_DEFER)).toBeLessThan(P.rebalance.indexOf('const movers'));
    // M1 (2026-10-10): the ONLY mover not moved is one with no live seat there (settled after the break).
    const moverLoop = P.rebalance.slice(P.rebalance.indexOf('const movers'), P.rebalance.indexOf(MOVER_PUSH));
    expect(moverLoop.split('continue;').length - 1).toBe(1);
    expect(moverLoop).toContain('if (!breakSeat) { withoutLiveSeat.push(player); continue; }');
    expect(P.rebalance).not.toMatch(/seats\.find(Index)?\(s => s\.state === 'occupied' && s\.playerId ===/);
    expect(P.helpers).toContain(BUST_LOOKUP);   // S1: runTournamentBustCheck
    expect(P.helpers).toContain("return table.seats.findIndex((s) => s.state === 'occupied' && !s.eliminated && s.playerId === playerId);");
    expect(SRC).toContain('breaksDeferredPendingBust: 0, reentrySessionsCreated: 0,');
  });
});

// ───────────────────────────── S1 / S2 / M1-M4 (2026-10-10, review pe2) ─────────────────────────────

/** S1 controls: the pieces the fix added, taken out again. */
const DEAL_GUARD = '    if (tournamentDealWaitsForBustCheck(tableId, tId, table)) {';
const LEFTOVER = '    if (!s.eliminated || unsettledLeftover(s)) bustedSeatIdx.push(i);';
const START_ROUTE = '    if (liveTournamentId) {';
function withoutDealGuard(autoStart: string): string {
  expect(autoStart).toContain(DEAL_GUARD);
  return autoStart.replace(DEAL_GUARD, '    if (false) {');
}
function withoutLeftoverBusts(helpers: string): string {
  expect(helpers).toContain(LEFTOVER);
  return helpers.replace(LEFTOVER, '    if (!s.eliminated) bustedSeatIdx.push(i);');
}
function withoutStartHandRoute(startHand: string): string {
  expect(startHand).toContain(START_ROUTE);
  return startHand.replace(START_ROUTE, '    if (false) {');
}
/** All three S1 locks out: the pre-S1 code. */
const PRE_S1 = { autoStart: withoutDealGuard(P.autoStart), helpers: withoutLeftoverBusts(P.helpers), startHand: withoutStartHandRoute(P.startHand) };
const STALE_MS = (() => {
  const m = /const TOURNAMENT_BUST_CHECK_STALE_MS = ([0-9_]+);/.exec(SRC);
  if (!m) throw new Error('TOURNAMENT_BUST_CHECK_STALE_MS not found');
  return Number(m[1].replace(/_/g, ''));
})();

describe('S1 — a tournament table never deals before its bust check has run', () => {
  /**
   * The reviewer's X1: TA 7 / TB 5 / TC 7 (19 alive). TB's hand ends with b4 at 0 (b0 won it) and
   * TB's handleHandComplete is held in a signed-in player's persistence (its bust check has not run).
   * TA's hand busts a6 → 18 alive → Rule 1 wants TB broken: DEFERRED (Q1 — pending bust). TB has
   * 5 alive, so the under-5 wait never held its deal: the server's timer — and the client's
   * auto-deal 'startHand' — dealt it, and PokerTable flagged b4 eliminated on the table only.
   */
  async function x1(over: Partial<typeof P> = {}) {
    const hold = deferred();
    const w = world({ layout: { TA: field('a', 7, 5000, 100), TB: field('b', 5, 5000, 200), TC: field('c', 7, 5000, 300) }, over, scope: persistenceScope(hold.p) });
    const elim = eliminations(w);
    const TA = w.tables.get('TA')!;
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    const sB1 = w.wireSocket('S-b1');
    TB.seats[4].chipCount = 0;
    TB.seats[0].chipCount = 10000;                                          // b0 won b4's stack
    (TB as any).currentPhase = GamePhase.HandComplete;
    TA.seats[6].chipCount = 0;
    TA.seats[0].chipCount = 10000;
    (TA as any).currentPhase = GamePhase.HandComplete;
    const before = w.chipsInPlay();
    const tbDone = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    await flush();                                                          // …TB is inside mergeUserStats
    await w.m.handleHandComplete('TA', [{ seatIndex: 0, amount: 5000 }]);   // a6 busts → TB's break deferred
    expect(w.m.tournamentBreaksAwaitingHandEnd.get('TB')).toBe(w.tid);
    return { w, elim, TA, TB, sB1, hold, tbDone, before };
  }
  const b4 = (x: Awaited<ReturnType<typeof x1>>) => ({
    hand: x.TB.handNumber, seat: { chips: x.TB.seats[4].chipCount, eliminated: x.TB.seats[4].eliminated },
    aliveInTM: !x.w.tm.getTournament(x.w.tid)!.players.find((p) => p.playerId === 'b4')!.eliminated,
  });

  it('TB (5 alive) does NOT deal while its bust check is pending — neither the server timer nor the client\'s startHand; then b4 is eliminated ONCE by b0, TB breaks, nobody seatless, nothing minted or credited, the tournament finishes', async () => {
    const x = await x1();
    x.w.m.autoStartNextHand('TB');                                          // the server's own hand-boundary timer
    await x.sB1.handlers.startHand();                                       // poker-3d auto-deal (~2s after HandComplete)
    expect(b4(x)).toEqual({ hand: 0, seat: { chips: 0, eliminated: false }, aliveInTM: true });
    expect(x.w.m.tournamentHandStartSafety).toMatchObject({ dealsHeldForBustCheck: 1, clientHandStartsRouted: 1 });
    expect(x.w.m.tournamentDealsHeldForBustCheck.has('TB')).toBe(true);
    expect(x.w.scheduled).toContain('TB');                                  // re-scheduled (the stale backstop)
    x.w.scheduled.length = 0;
    x.hold.resolve();
    await x.tbDone;
    await flush();
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(x.elim.filter((e) => e.playerId === 'b4')).toEqual([{ playerId: 'b4', eliminatorId: 'b0' }]);
    expect([...t.tableIds].sort()).toEqual(['TA', 'TC']);                   // b4's elimination ran the deferred break
    expect(x.w.m.tournamentDealsHeldForBustCheck.has('TB')).toBe(false);    // re-kicked
    expect(x.w.scheduled).toContain('TB');
    expect(x.w.seatless()).toEqual([]);
    expect(x.w.couldNotPlace()).toEqual([]);
    expect(x.w.chipsInPlay()).toBe(x.before);
    expect(x.w.credits).toEqual([]);
    expect(x.w.m.tournamentHandStartSafety.bustLeftoversEliminated).toBe(0);
    expect([...x.w.stubbed].filter((n) => /BustCheck|bustCheck|Tournament|tournament|scheduleAutoStart/.test(n))).toEqual([]);
    playDownTo(x.w, 'a0');
    expect(t.status).toBe('finished');
  });

  it('CONTROL — pre-S1 (no deal guard, no startHand route, no leftover lock): TB deals hand 1, b4 is flagged on the table only and stays ALIVE in the tournament after his bust check', async () => {
    const x = await x1(PRE_S1);
    x.w.m.autoStartNextHand('TB');
    expect(b4(x)).toEqual({ hand: 1, seat: { chips: 0, eliminated: true }, aliveInTM: true });
    x.hold.resolve();
    await x.tbDone;
    await flush();
    expect(b4(x).aliveInTM).toBe(true);                                     // the bust check skipped him: never eliminated
    expect(x.elim.filter((e) => e.playerId === 'b4')).toEqual([]);
  });

  it('CONTROL — the pre-S1 socket startHand (the client\'s auto-deal) deals TB at once, bypassing the tournament guards', async () => {
    const x = await x1({ startHand: withoutStartHandRoute(P.startHand) });
    await x.sB1.handlers.startHand();
    expect(b4(x)).toMatchObject({ hand: 1, seat: { chips: 0, eliminated: true } });
  });

  it('(c) alone — a deal that slipped in first (no deal guard): the bust check still eliminates b4, ONCE, attributed to b0 (his hand\'s capture)', async () => {
    const x = await x1({ autoStart: withoutDealGuard(P.autoStart) });
    x.w.m.autoStartNextHand('TB');
    expect(b4(x)).toMatchObject({ hand: 1, seat: { chips: 0, eliminated: true } });
    x.hold.resolve();
    await x.tbDone;
    await flush();
    expect(x.elim.filter((e) => e.playerId === 'b4')).toEqual([{ playerId: 'b4', eliminatorId: 'b0' }]);
    expect(x.w.m.tournamentHandStartSafety.bustLeftoversEliminated).toBe(1);
    expect(x.w.logs.some((l) => l.includes('bust_check_leftover_eliminated') && l.includes('"attributed":true'))).toBe(true);
    await x.w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 1 }]);   // a later check: nothing new
    expect(x.elim.filter((e) => e.playerId === 'b4')).toHaveLength(1);
  });

  it('(a) alone — the deal guard without the leftover lock: same good outcome (b4 eliminated once by b0)', async () => {
    const x = await x1({ helpers: withoutLeftoverBusts(P.helpers) });
    x.w.m.autoStartNextHand('TB');
    expect(b4(x).hand).toBe(0);
    x.hold.resolve();
    await x.tbDone;
    await flush();
    expect(x.elim.filter((e) => e.playerId === 'b4')).toEqual([{ playerId: 'b4', eliminatorId: 'b0' }]);
  });

  it('startHand on a live tournament table obeys the director pause and a deferred break (a table not at a hand end is refused, code tournament_hand_held)', async () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 3, 5000, 200) } });
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    const s = w.wireSocket('S-b1');
    (TB as any).currentPhase = GamePhase.HandComplete;
    w.tm.pauseTournament(w.tid, true);
    await s.handlers.startHand();
    expect(TB.handNumber).toBe(0);                                          // paused: held at the boundary
    w.tm.pauseTournament(w.tid, false);
    (TB as any).currentPhase = GamePhase.WaitingForPlayers;                 // its first deal never happened
    w.m.tournamentBreaksAwaitingHandEnd.set('TB', w.tid);
    await s.handlers.startHand();
    expect(TB.handNumber).toBe(0);
    expect(s.emitted).toContainEqual(['error', expect.objectContaining({ code: 'tournament_hand_held', reason: 'break_pending' })]);
  });

  /** X1b — one table: TB 4. b3 busts; TB's bust check is held in persistence. */
  async function single(over: Partial<typeof P> = {}, hold: Promise<void> | null = null) {
    const w = world({ layout: { TB: field('b', 4, 5000, 200) }, over, scope: persistenceScope(hold) });
    const elim = eliminations(w);
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    const s = w.wireSocket('S-b1');
    TB.seats[3].chipCount = 0;
    TB.seats[0].chipCount = 10000;
    (TB as any).currentPhase = GamePhase.HandComplete;
    const tbDone = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    await flush();
    return { w, elim, TB, s, tbDone };
  }
  /** b0 busts b1 and b2 in the next hand (real bust check). */
  async function bustTheRest(x: Awaited<ReturnType<typeof single>>) {
    if (x.TB.currentPhase === GamePhase.HandComplete) x.w.m.autoStartNextHand('TB');
    foldOut(x.TB);
    x.TB.seats[0].chipCount = 20000;
    x.TB.seats[1].chipCount = 0;
    x.TB.seats[2].chipCount = 0;
    (x.TB as any).currentPhase = GamePhase.HandComplete;
    await x.w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 1 }]);
  }

  it('single table: the next deal (timer AND client startHand) waits for the bust check; b3 is eliminated by b0; the tournament FINISHES', async () => {
    const hold = deferred();
    const x = await single({}, hold.p);
    x.w.m.autoStartNextHand('TB');
    await x.s.handlers.startHand();
    expect(x.TB.handNumber).toBe(0);
    hold.resolve();
    await x.tbDone;
    await flush();
    expect(x.elim).toEqual([{ playerId: 'b3', eliminatorId: 'b0' }]);
    await bustTheRest(x);
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(t.status).toBe('finished');
    expect(t.players.filter((p) => !p.eliminated).map((p) => p.playerId)).toEqual(['b0']);
    expect(x.w.credits).toEqual([]);
  });

  it('CONTROL — single table pre-S1 (X1b): the deal lands first, b3 is never eliminated — the tournament can never finish', async () => {
    const hold = deferred();
    const x = await single(PRE_S1, hold.p);
    x.w.m.autoStartNextHand('TB');
    hold.resolve();
    await x.tbDone;
    await flush();
    await bustTheRest(x);
    const t = x.w.tm.getTournament(x.w.tid)!;
    expect(t.status).toBe('running');
    expect(t.players.filter((p) => !p.eliminated).map((p) => p.playerId).sort()).toEqual(['b0', 'b3']);
    expect(x.TB.startNewHand()).toBe(false);                                // no hand can ever be dealt again
  });

  it(`a bust check whose handler HANGS is run by the deal guard after ${STALE_MS}ms, from its capture (b3 by b0); the table deals; the late handler then does nothing`, async () => {
    const hold = deferred();
    const x = await single({}, hold.p);
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(0);
    jest.advanceTimersByTime(STALE_MS + 1);
    x.w.m.autoStartNextHand('TB');
    expect(x.elim).toEqual([{ playerId: 'b3', eliminatorId: 'b0' }]);
    expect(x.TB.handNumber).toBe(1);
    expect(x.w.m.tournamentHandStartSafety.bustChecksRunLate).toBe(1);
    expect(x.w.logs.some((l) => l.includes('bust_check_run_late') && l.includes('"reason":"stale"'))).toBe(true);
    hold.resolve();
    await x.tbDone;
    await flush();
    expect(x.elim).toHaveLength(1);
  });

  it('a hand-complete handler that THROWS after its capture: the handResult listener\'s catch (runPendingTournamentBustChecks) runs the check at once and re-kicks the held deal', async () => {
    const w = world({
      layout: { TB: field('b', 4, 5000, 200) },
      scope: {
        ...persistenceScope(null),
        progressionManager: new Proxy({} as Record<string, unknown>, {
          get: (_t, k) => (k === 'recordHandPlayed' ? () => { throw new Error('progression boom'); } : () => undefined),
        }),
      },
    });
    const elim = eliminations(w);
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    TB.seats[3].chipCount = 0;
    TB.seats[0].chipCount = 10000;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await expect(w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }])).rejects.toThrow('progression boom');
    expect(w.m.tournamentBustChecksPending.has('TB')).toBe(true);
    w.m.autoStartNextHand('TB');
    expect(TB.handNumber).toBe(0);                                          // held (not dealt over a pending bust)
    w.scheduled.length = 0;
    w.m.runPendingTournamentBustChecks('TB', 'hand_complete_threw');
    expect(elim).toEqual([{ playerId: 'b3', eliminatorId: 'b0' }]);
    expect(w.scheduled).toContain('TB');                                // re-kicked
    expect(w.m.tournamentDealsHeldForBustCheck.has('TB')).toBe(false);
    expect(w.m.tournamentBustChecksPending.has('TB')).toBe(false);
  });

  it('V1 (a) — a hand with NO bust holds the next deal too, until ITS check has run; then the table deals', async () => {
    const hold = deferred();
    const w = world({ layout: { TB: field('b', 4, 5000, 200) }, scope: persistenceScope(hold.p) });
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    (TB as any).currentPhase = GamePhase.HandComplete;
    const done = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 300 }]);
    await flush();
    expect(w.m.tournamentBustChecksPending.get('TB')?.size).toBe(1);        // pending although nobody busted
    w.m.autoStartNextHand('TB');
    expect(TB.handNumber).toBe(0);
    expect(w.m.tournamentHandStartSafety.dealsHeldForBustCheck).toBe(1);
    w.scheduled.length = 0;
    hold.resolve();
    await done;
    await flush();
    expect(w.m.tournamentBustChecksPending.has('TB')).toBe(false);
    expect(w.scheduled).toContain('TB');                                  // re-kicked by the check
    w.m.autoStartNextHand('TB');
    expect(TB.handNumber).toBe(1);
  });

  it('wiring: handleHandComplete captures before its first await and runs + re-kicks at its end; the handResult listener catches; startHand routes live tournament tables', () => {
    const hhc = P.handComplete;
    const capAt = hhc.indexOf('const tournamentBustCheck = captureTournamentBustCheck(tableId, table, results);');
    expect(capAt).toBeGreaterThan(-1);
    expect(capAt).toBeLessThan(hhc.indexOf('await mergeUserStats('));
    expect(hhc.indexOf("runTournamentBustCheck(tableId, table, tournamentBustCheck, 'hand_complete');")).toBeLessThan(hhc.indexOf('rekickTournamentDealAfterBustCheck(tableId);'));
    expect(SRC).toContain('handleHandComplete(tableId, data.results).catch((e: any) => {');
    expect(SRC).toContain("runPendingTournamentBustChecks(tableId, 'hand_complete_threw');");
    expect(P.autoStart.indexOf(DEAL_GUARD)).toBeLessThan(P.autoStart.indexOf('const started = table.startNewHand();'));
    expect(P.autoStart.indexOf(DEAL_GUARD)).toBeLessThan(P.autoStart.indexOf('if (tournamentBreaksAwaitingHandEnd.get(tableId) === tId) {'));
    expect(P.startHand.indexOf(START_ROUTE)).toBeLessThan(P.startHand.indexOf('const started = table.startNewHand();'));
    expect(P.startHand).toContain('autoStartNextHand(session.tableId);');
  });
});

describe('S2 — a voluntary leave from a LIVE tournament seat keeps the seat in play, absent; he can come back', () => {
  /** TA 6 / TB 5; b2 seated on his live, signed-in socket at TB. */
  function leaveWorld(over: Partial<typeof P> = {}, scope: Record<string, unknown> = {}) {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over, scope });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    return { w, s, TB: w.tables.get('TB')! };
  }
  const PRE_S2 = { handlePlayerLeave: P.handlePlayerLeave.replace('  if (table && !keepTournamentSeatOnLeave(socket, session, table, tournamentSeat)) {', '  if (table) {') };

  it('Back to Lobby (leaveTable → handlePlayerLeave): his seat stays occupied with his 5000, absent (no session, out of the room), reserved past its hand limit (short clock); nothing credited; he is told (tournamentSeatKept)', () => {
    const { w, s, TB } = leaveWorld();
    const before = w.chipsInPlay();
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000, eliminated: false, playerId: 'b2' });
    expect(w.playerSessions.has('S-b2')).toBe(false);
    expect(s.rooms.has('table:TB')).toBe(false);
    expect(w.reservedSeats.get(202)).toMatchObject({ tableId: 'TB', seatIndex: 2, tournament: true, handsRemaining: 0, masterUserId: 'm-b2' });
    expect(w.seatless()).toEqual([]);
    expect(w.chipsInPlay()).toBe(before);
    expect(w.credits).toEqual([]);
    expect(s.emitted).toContainEqual(['tournamentSeatKept', { tournamentId: w.tid, tableId: 'TB', seatIndex: 2, tournamentName: 'Rebalance Cup', chips: 5000 }]);
    expect(w.audits).toContainEqual(expect.objectContaining({
      action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ userId: 202, amount: 5000, reason: 'voluntary_leave_seat_kept', seatKept: true }),
    }));
    expect(w.m.tournamentSeatKeep).toMatchObject({ kept: 1, keptUnreserved: 0 });
    // the real reservation / keep / audit code ran (nothing it relies on was an inert stub)
    expect([...w.stubbed].filter((n) => /reserve|keep|Tournament|tournament|auditLog|noteAbsent/.test(n))).toEqual([]);
  });

  it('CONTROL — pre-S2 the leave stood the seat up: his 5000 gone, b2 ALIVE with no seat (the X3 repro)', () => {
    const { w, s, TB } = leaveWorld(PRE_S2);
    const before = w.chipsInPlay();
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2].state).toBe('empty');
    expect(w.seatless()).toEqual(['b2']);
    expect(w.chipsInPlay()).toBe(before - 5000);
  });

  it('mid-hand, on his turn FACING a raise: folded at once, the seat stays in the hand (no deferred stand-up, no pot erased)', () => {
    const { w, s, TB } = leaveWorld();
    expect(TB.startNewHand()).toBe(true);
    expect(TB.playerRaise(TB.activeSeatIndex, 400)).toBe(true);             // the first to act raises
    for (let g = 0; g < 10 && TB.activeSeatIndex !== 2; g++) { const a = TB.activeSeatIndex; if (!TB.playerCall(a)) TB.playerCheck(a); }
    expect(TB.activeSeatIndex).toBe(2);
    expect(TB.currentBetToMatch - TB.seats[2].currentBet).toBeGreaterThan(0);
    const total = w.chipsInPlay();
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', folded: true });
    expect(TB.activeSeatIndex).not.toBe(2);
    expect(w.chipsInPlay()).toBe(total);
    expect(w.credits).toEqual([]);
  });

  it('Z6 — mid-hand, on his turn with a FREE check (the big blind\'s option): CHECKED, not folded — the seat stays live in the hand; nothing moves', () => {
    const { w, s, TB } = leaveWorld();
    expect(TB.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && TB.activeSeatIndex !== 2; g++) { const a = TB.activeSeatIndex; if (!TB.playerCall(a)) TB.playerCheck(a); }
    expect(TB.activeSeatIndex).toBe(2);
    expect(TB.currentBetToMatch - TB.seats[2].currentBet).toBe(0);           // b2 is the big blind, everyone limped
    const total = w.chipsInPlay();
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', folded: false });
    expect(TB.currentPhase).toBe(GamePhase.Flop);                            // his check closed the pre-flop round
    expect(w.chipsInPlay()).toBe(total);
    expect(w.credits).toEqual([]);
  });

  it('the absent seat is played out: when its stack is gone the bust check eliminates him; the reservation\'s 6h expiry credits nothing; the tournament finishes; no wallet credit ever', async () => {
    const { w, s, TB } = leaveWorld();
    const elim = eliminations(w);
    w.m.handlePlayerLeave(s);
    TB.seats[0].chipCount += TB.seats[2].chipCount;                         // blinded / folded out to b0
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    expect(elim).toEqual([{ playerId: 'b2', eliminatorId: 'b0' }]);
    jest.advanceTimersByTime(6 * 3600_000);
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ reason: 'reserve_expiry' }) }));
    const t = playDownTo(w, 'a0');
    expect(t.status).toBe('finished');
    expect(w.credits).toEqual([]);
  });

  it('Return to tournament (returnToTournamentSeat): back on the SAME seat (the seat\'s entrant id), his reservation consumed (its timer cleared), reconnectedToTable + success on the ack and returnToTournamentResult', async () => {
    const { w, s, TB } = leaveWorld();
    w.m.handlePlayerLeave(s);
    const sock = w.wireSocket('S-b2');
    const acks: unknown[] = [];
    await sock.handlers.returnToTournamentSeat({}, (r: unknown) => acks.push(r));
    expect(acks).toEqual([{ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 }]);
    expect(sock.emitted).toContainEqual(['returnToTournamentResult', { success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 }]);
    expect(sock.emitted).toContainEqual(['reconnectedToTable', { tableId: 'TB', seatIndex: 2, tournamentId: w.tid }]);
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'TB', seatIndex: 2, playerId: 'b2' });
    expect(sock.rooms.has('table:TB')).toBe(true);
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    jest.advanceTimersByTime(6 * 3600_000);
    expect(w.audits.filter((a) => a.d?.reason === 'reserve_expiry')).toEqual([]);   // the consumed reservation's timer was cleared
    expect(w.m.tournamentSeatKeep.returned).toBe(1);
  });

  it('a cash join from that socket leaves the seat in play too; an existing CASH reservation of his is never overwritten (its stack would be stranded) — the seat stays absent unreserved and is still found by account', async () => {
    const { w, s, TB } = leaveWorld();
    const cashTimer = setTimeout(() => {}, 6 * 3600_000);
    const cashRes = { tableId: 'CASH-1', seatIndex: 3, playerName: 'b2', chips: 2000, expiresAt: Date.now() + 3600e3, cleanupTimer: cashTimer, handsRemaining: 20, tournament: false };
    w.reservedSeats.set(202, cashRes);
    w.m.handlePlayerLeave(s);                                               // what joinTable / quickPlay / the waitlist do first
    expect(w.reservedSeats.get(202)).toBe(cashRes);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.m.tournamentSeatKeep).toMatchObject({ kept: 1, keptUnreserved: 1 });
    const sock = w.wireSocket('S-b2');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat(undefined, (r: unknown) => acks.push(r));
    expect(acks[0]).toMatchObject({ success: true, tableId: 'TB', seatIndex: 2 });
    expect(w.reservedSeats.get(202)).toBe(cashRes);                         // the cash seat's own reservation, untouched
  });

  it('not kept for an entrant who is OUT (the hand-start suspension stand-up disqualifies first): stood up as before, nothing credited', () => {
    const { w, s, TB } = leaveWorld();
    w.tm.disqualifyPlayers(w.tid, ['b2']);
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2].state).toBe('empty');
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(w.credits).toEqual([]);
    expect(w.m.tournamentSeatKeep.kept).toBe(0);
  });

  it('return refusals: a SUSPENDED player is not put back (play gate; the seat stays absent for the hand-start gate); another account has no seat there; a socket seated at ANOTHER (cash) table gets already_seated', async () => {
    let refusal: any = { code: 'player_suspended', message: 'SUSPENDED' };
    const { w, s } = leaveWorld({}, { assertPlayable: async () => refusal });
    w.m.handlePlayerLeave(s);
    const sock = w.wireSocket('S-b2');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({}, (r: unknown) => acks.push(r));
    expect(acks).toEqual([{ success: false, error: 'SUSPENDED', code: 'player_suspended' }]);
    expect(w.playerSessions.has('S-b2')).toBe(false);
    refusal = null;
    const other = w.wireSocket('S-x');
    w.authSessions.set('S-x', { userId: 999, username: 'x', masterUserId: 'm-x' });
    await other.handlers.returnToTournamentSeat({}, (r: unknown) => acks.push(r));
    expect(acks[1]).toMatchObject({ success: false, code: 'no_tournament_seat' });
    // b2 sits at a CASH table on the same socket (P-c: the server's answer is authoritative).
    const cash = new PokerTable({ tableId: 'CASH-1', tableName: 'Beginner', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    w.tables.set('CASH-1', cash);
    expect(cash.sitDown(4, 'b2', 2000, 'user_202', false)).toBe(true);
    w.playerSessions.set('S-b2', { socketId: 'S-b2', tableId: 'CASH-1', seatIndex: 4, playerName: 'b2', playerId: 'user_202', sittingOut: false });
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks[2]).toMatchObject({ success: false, code: 'already_seated' });
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'CASH-1', seatIndex: 4 });   // untouched
    expect(w.tables.get('TB')!.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    // A socket seated at ITS OWN live tournament seat is answered success (already there), never already_seated.
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    const seated = w.wireSocket('S-b1');
    await seated.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks[3]).toEqual({ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 1 });
    expect(w.m.tournamentSeatKeep.returnAlreadyThere).toBe(1);
  });

  it('a single-table tournament still FINISHES after a player left it (his absent seat is played out and busts)', async () => {
    const w = world({ layout: { TB: field('b', 3, 5000, 200) } });
    const elim = eliminations(w);
    const TB = w.tables.get('TB')!;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(s);
    TB.seats[0].chipCount = 15000;
    TB.seats[1].chipCount = 0;
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 10000 }]);
    expect(elim.map((e) => e.playerId).sort()).toEqual(['b1', 'b2']);
    expect(w.tm.getTournament(w.tid)!.status).toBe('finished');
    expect(w.credits).toEqual([]);
  });

  it('wiring: handlePlayerLeave asks keepTournamentSeatOnLeave before any teardown; returnToTournamentSeat is gated first', () => {
    const hpl = P.handlePlayerLeave;
    expect(hpl.indexOf('if (table && !keepTournamentSeatOnLeave(socket, session, table, tournamentSeat)) {')).toBeLessThan(hpl.indexOf('const deferRemoval ='));
    const rts = P.returnToTournament;
    expect(rts.indexOf("await assertPlayable(socket, 'returnToTournamentSeat')")).toBeLessThan(rts.indexOf('restoreAbsentTournamentSeat('));
    expect(P.seatKeep).toContain('if (!tp || tp.eliminated) return false;');
    expect(P.seatKeep).toContain('if (!existing || (existing.tableId === session.tableId && existing.seatIndex === session.seatIndex)) {');
  });
});

describe('M1 — a break mover with no live seat is never seated with a stack nobody paid for', () => {
  const PRE_M1 = (rebalance: string) => withPreM1MoverStack(rebalance.replace('    if (!breakSeat) { withoutLiveSeat.push(player); continue; }\n', ''));

  /** The reviewer's X4: b3's 0-chip seat was flagged by PokerTable before his bust check; TA 5 + TB 4 → Rule 1 breaks TB. */
  function zombie(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 4, 5000, 200) }, over });
    const TB = w.tables.get('TB')!;
    TB.seats[3].chipCount = 0;
    TB.seats[3].eliminated = true;
    const before = w.chipsInPlay();
    w.m.handleTableRebalance(w.tid);
    const t = w.tm.getTournament(w.tid)!;
    const b3Seats = [...w.tables.values()].flatMap((tb) => (t.tableIds.includes(tb.config.tableId)
      ? tb.seats.filter((x) => x.state === 'occupied' && x.playerId === 'b3' && !x.eliminated).map((x) => ({ chips: x.chipCount, isAI: x.isAI }))
      : []));
    return { w, t, b3Seats, chipsDelta: w.chipsInPlay() - before };
  }

  it('his 0-chip (PokerTable-flagged) seat: not moved — eliminated through TournamentManager, audited; nobody seatless; chips conserved', () => {
    const z = zombie();
    expect(z.t.tableIds).toEqual(['TA']);
    expect(z.b3Seats).toEqual([]);
    expect(z.t.players.find((p) => p.playerId === 'b3')!.eliminated).toBe(true);
    expect(z.chipsDelta).toBe(0);
    expect(z.w.seatless()).toEqual([]);
    expect(z.w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_ENTRANT_ELIMINATED_NO_LIVE_SEAT', d: expect.objectContaining({ playerId: 'b3', reason: 'busted_seat', credited: 0 }) }));
    expect(z.w.m.tournamentHandStartSafety.moversWithoutLiveSeat).toBe(1);
  });

  it('CONTROL — the pre-M1 mover seats him on TA as an AI with a stack nobody paid for (X4)', () => {
    const z = zombie({ rebalance: PRE_M1(P.rebalance) });
    expect(z.b3Seats).toEqual([{ chips: expect.any(Number), isAI: true }]);
    expect(z.b3Seats[0].chips).toBeGreaterThan(0);
    expect(z.chipsDelta).toBeGreaterThan(0);
  });

  it('no seat at all on the break table (a pre-S2 leave stood him up): eliminated, audited no_seat — never re-seated', () => {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 4, 5000, 200) } });
    w.tables.get('TB')!.standUp(2);
    w.m.handleTableRebalance(w.tid);
    const t = w.tm.getTournament(w.tid)!;
    expect(t.tableIds).toEqual(['TA']);
    expect(t.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(true);
    expect(w.tables.get('TA')!.seats.some((x) => x.state === 'occupied' && x.playerId === 'b2')).toBe(false);
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_ENTRANT_ELIMINATED_NO_LIVE_SEAT', d: expect.objectContaining({ playerId: 'b2', reason: 'no_seat' }) }));
  });

  it('a live seat on ANOTHER table (a stale map): re-mapped, not moved, not eliminated', () => {
    // TA 5 + b2 physically on TA (3 free), TC 5 (4 free), TB 4 by the map (3 seated) → Rule 1 breaks TB.
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 4, 5000, 200), TC: field('c', 5, 5000, 300) } });
    const TA = w.tables.get('TA')!;
    expect(TA.sitDown(8, 'b2', 5000, 'b2', false, true)).toBe(true);        // his real seat is on TA…
    w.tables.get('TB')!.standUp(2);                                         // …the map still says TB
    const before = w.chipsInPlay();
    w.m.handleTableRebalance(w.tid);
    const t = w.tm.getTournament(w.tid)!;
    expect(t.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
    expect([...t.tableIds].sort()).toEqual(['TA', 'TC']);                  // TB was the table broken
    expect(t.playerTableMap.get('b2')).toBe('TA');
    expect(w.m.tournamentHandStartSafety.moversWithoutLiveSeat).toBe(1);
    expect(TA.seats.filter((x) => x.state === 'occupied' && x.playerId === 'b2')).toHaveLength(1);
    expect(w.chipsInPlay()).toBe(before);
  });
});

describe('M2 — a bounty whose bust breaks the eliminator\'s own table reaches his NEW live seat', () => {
  const NEW = 'const bountySeat = tournamentLiveSeatOf(tournamentId, eliminatorId, brokenNow ? undefined : tableId);';
  async function run(helpers: string) {
    // TA 5 / TB 5: b0 busts b4 on TB → 9 alive → b4's elimination itself breaks TB (b0's stack moves to TA).
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: persistenceScope(null), config: { isBounty: true, bountyAmount: 1000 }, over: { helpers } });
    const TB = w.tables.get('TB')!;
    TB.seats[4].chipCount = 0;
    TB.seats[0].chipCount = 10000;
    (TB as any).currentPhase = GamePhase.HandComplete;
    const before = w.chipsInPlay();
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    const t = w.tm.getTournament(w.tid)!;
    const b0 = w.tables.get('TA')!.seats.find((s) => s.state === 'occupied' && s.playerId === 'b0');
    return { tableIds: t.tableIds, b0OnTA: b0?.chipCount, bountyEarnings: t.players.find((p) => p.playerId === 'b0')!.bountyEarnings, chipsDelta: w.chipsInPlay() - before };
  }
  it('the 1000 bounty is on b0\'s TA seat (11000), in play', async () => {
    expect(P.helpers).toContain(NEW);
    expect(await run(P.helpers)).toEqual({ tableIds: ['TA'], b0OnTA: 11000, bountyEarnings: 1000, chipsDelta: 1000 });
  });
  it('CONTROL — "broken?" read before the elimination: the bounty lands on the discarded TB copy (b0 plays on with 10000)', async () => {
    expect(await run(P.helpers.replace(NEW, 'const bountySeat = tournamentLiveSeatOf(tournamentId, eliminatorId, tableBroken ? undefined : tableId);')))
      .toEqual({ tableIds: ['TA'], b0OnTA: 10000, bountyEarnings: 1000, chipsDelta: 0 });
  });
});

describe('M3 — an elimination notice never goes to a socket now signed in as ANOTHER account', () => {
  const NOTICE = 'const bustSid = bustTp ? tournamentEntrantSocket(tournamentId, bustTp, tableId, i) : null;';
  /** Round 5 (P-e') — the "plays the seat AT this table" gate; a control switches it off (pre-P-e': any socket not seated elsewhere). */
  const PE_PRIME = '    const bustSidPlaysHere = !!bustSid && playerSessions.get(bustSid)?.tableId === tableId;\n';
  async function bustAbsentB3(helpers: string = P.helpers) {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 6, 5000, 200) }, over: { helpers } });
    // b3's tournament record names his registration socket 'reg-b3' — now signed in as Bob (999); b3 is away.
    const bob = w.mkSocket('reg-b3');
    w.authSessions.set('reg-b3', { userId: 999, username: 'bob', masterUserId: 'm-bob' });
    const TB = w.tables.get('TB')!;
    TB.seats[3].chipCount = 0;
    TB.seats[0].chipCount = 10000;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    return { w, bob };
  }
  it('b3 busts while away: Bob\'s socket gets no eliminatedToSpectator, no plain notice, and is not made a spectator of b3\'s table', async () => {
    expect(P.helpers).toContain(NOTICE);
    const { w, bob } = await bustAbsentB3();
    expect(bob.emitted.filter(([ev]: [string]) => ev === 'eliminatedToSpectator' || ev === 'playerEliminated')).toEqual([]);
    expect(w.spectators.get('TB')?.has('reg-b3') ?? false).toBe(false);
  });
  it('M3 alone (the P-e\' gate off) — still never Bob\'s socket: the ownership check keeps it out', async () => {
    expect(P.helpers).toContain(PE_PRIME);
    const { w, bob } = await bustAbsentB3(P.helpers.replace(PE_PRIME, '    const bustSidPlaysHere = !!bustSid;\n'));
    expect(bob.emitted.filter(([ev]: [string]) => ev === 'eliminatedToSpectator')).toEqual([]);
    expect(w.spectators.get('TB')?.has('reg-b3') ?? false).toBe(false);
  });
  it('CONTROL — the pre-M3 notice (tp.socketId, no ownership check) goes to Bob and makes him spectate b3\'s table', async () => {
    const { w, bob } = await bustAbsentB3(P.helpers.replace(NOTICE, 'const bustSid = bustTp ? bustTp.socketId : null;').replace(PE_PRIME, '    const bustSidPlaysHere = !!bustSid;\n'));
    expect(bob.emitted.filter(([ev]: [string]) => ev === 'eliminatedToSpectator')).toHaveLength(1);
    expect(w.spectators.get('TB')?.has('reg-b3')).toBe(true);
  });
  it('his OWN live socket at the seat is told', async () => {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 6, 5000, 200) } });
    const own = w.seatLive('S-b3', 'TB', 3, 203, 'm-b3');
    const TB = w.tables.get('TB')!;
    TB.seats[3].chipCount = 0;
    TB.seats[0].chipCount = 10000;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    expect(own.emitted.filter(([ev]: [string]) => ev === 'eliminatedToSpectator')).toHaveLength(1);
  });
  it('an account switch (P4) detaches the tournament record from the socket: to his own other live socket, else none', () => {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 6, 5000, 200) } });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    const t = w.tm.getTournament(w.tid)!;
    const b2 = t.players.find((p) => p.playerId === 'b2')!;
    b2.socketId = 'S-b2';
    w.m.releaseSocketForAccountSwitch(s, 999, 'test');                      // Bob's sign-in lands on b2's socket
    expect(b2.socketId).toBe('');
    expect(w.reservedSeats.get(202)).toMatchObject({ tableId: 'TB', seatIndex: 2, tournament: true });   // P4: kept for b2
    // with another live socket of his own:
    const s3 = w.seatLive('S-b3', 'TB', 3, 203, 'm-b3');
    w.mkSocket('S-b3-phone');
    w.authSessions.set('S-b3-phone', { userId: 203, username: 'u203', masterUserId: 'm-b3' });
    const b3 = t.players.find((p) => p.playerId === 'b3')!;
    b3.socketId = 'S-b3';
    w.m.releaseSocketForAccountSwitch(s3, 999, 'test');
    expect(b3.socketId).toBe('S-b3-phone');
    expect(w.m.tournamentHandStartSafety.entrantSocketsDetached).toBe(2);
  });
});

describe('M4 — the waitlist link\'s state-changed cancellation never says "try again" (its ticket is burned)', () => {
  it('the waitlist answers with its own sentence: tap Play Online in the app again', () => {
    const m = /const WAITLIST_BUY_IN_CANCELLED_MESSAGE = '([^']+)';/.exec(SRC);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/try again/i);
    expect(m![1]).toContain('Tap Play Online in the American Pub Poker app again');
    // pe3 minor (2026-10-10): + the machine-readable cancelCode on both frames (error + loginResult).
    expect(SRC).toContain("answer: (reason) => failWaitlist('handler_exception', WAITLIST_BUY_IN_CANCELLED_MESSAGE, { stage: 'state_changed', reason }, { cancelCode: WAITLIST_BUY_IN_CANCEL_CODE }),");
    expect(SRC).toContain("const WAITLIST_BUY_IN_CANCEL_CODE = 'buy_in_cancelled';");
    expect(SRC).not.toContain("failWaitlist('handler_exception', BUY_IN_CANCELLED_MESSAGE");
  });
});

describe('S1 — the 5s sweep bounds the bust-check bookkeeping of removed tables', () => {
  it('a removed table\'s stale capture and held-deal mark are dropped; a fresh capture and a live table\'s are kept', () => {
    const now = Date.now();
    const pending = new Map<string, Map<number, any>>([
      ['GONE', new Map([[3, { handNumber: 3, capturedAt: now - STALE_MS - 1 }], [4, { handNumber: 4, capturedAt: now }]])],
      ['GONE2', new Map([[7, { handNumber: 7, capturedAt: now - STALE_MS - 1 }]])],
      ['LIVE', new Map([[9, { handNumber: 9, capturedAt: now - STALE_MS - 1 }]])],
    ]);
    const held = new Set(['GONE', 'LIVE']);
    const { exports } = load(fnSrc('function sweepTournamentRebalances('), {
      tournamentTables: new Map(), tournamentBreaksAwaitingHandEnd: new Map(), pruneBrokenTournamentTables() {},
      tournamentBustChecksPending: pending, tournamentDealsHeldForBustCheck: held, TOURNAMENT_BUST_CHECK_STALE_MS: STALE_MS,
      tableManager: { getTable: (id: string) => (id === 'LIVE' ? {} : undefined) },
    }, '{ sweepTournamentRebalances }');
    exports.sweepTournamentRebalances();
    expect([...pending.keys()].sort()).toEqual(['GONE', 'LIVE']);
    expect([...pending.get('GONE')!.keys()]).toEqual([4]);
    expect([...pending.get('LIVE')!.keys()]).toEqual([9]);                 // a live table's stale capture is its deal guard's to run
    expect([...held]).toEqual(['LIVE']);
  });
});

// ───────────────── V1-V5 + minors (2026-10-10, review pe3 — the FIXED S2 protocol, CONTRACTS C5) ─────────────────

/** V1 controls: the two pieces V1 added, taken out again. */
const V1A_PENDING = '  // V1 (a) — pending whatever the hand left (see above).\n  let pend = tournamentBustChecksPending.get(tableId);';
const V1B_SKIP = '    if (inHandInProgress(s)) continue;\n';
const V1B_LOOP = ' || inHandInProgress(seat)) continue;';
/** Pre-V1 (a): only a hand that left a 0-chip seat registers a pending capture. */
function withPreV1aCapture(helpers: string): string {
  expect(helpers).toContain(V1A_PENDING);
  return helpers.replace(V1A_PENDING, '  if (bustedThisHand.size === 0) return check;\n  let pend = tournamentBustChecksPending.get(tableId);');
}
/** Pre-V1 (b): the bust check also takes a 0-chip seat that is all-in in a hand in progress. */
function withoutInHandGuard(helpers: string): string {
  expect(helpers).toContain(V1B_SKIP);
  expect(helpers).toContain(V1B_LOOP);
  return helpers.replace(V1B_SKIP, '').replace(V1B_LOOP, ') continue;');
}
const PRE_V1 = { helpers: withoutInHandGuard(withPreV1aCapture(P.helpers)) };

/** Everyone else calls / checks until `victim` is all-in. */
function driveToAllIn(t: PokerTable, victim: number) {
  let g = 0;
  while (t.isHandInProgress() && g++ < 30) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (a === victim) { t.playerAllIn(a); if (t.seats[victim].allIn) break; continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
}
/** Play the hand out (calls / checks); its handResult results. */
function playOut(t: PokerTable): any[] {
  let results: any[] = [];
  t.once('handResult', (d: any) => { results = d.results; });
  let g = 0;
  while (t.isHandInProgress() && g++ < 80) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  expect(t.isHandInProgress()).toBe(false);
  return results;
}
/** After a hand's OWN bust check: exactly the 0-chip seats are out, chips conserved, finished iff one is left. */
function expectSettled(w: ReturnType<typeof world>, t: PokerTable, total: number) {
  const tour = w.tm.getTournament(w.tid)!;
  const seats = t.seats.filter((s) => s.state === 'occupied');
  expect(seats.reduce((a, s) => a + s.chipCount, 0)).toBe(total);
  for (const s of seats) {
    const tp = tour.players.find((p) => p.playerId === s.playerId)!;
    expect({ p: s.playerId, out: tp.eliminated }).toEqual({ p: s.playerId, out: s.chipCount === 0 });
  }
  expect(tour.status).toBe(tour.players.filter((p) => !p.eliminated).length === 1 ? 'finished' : 'running');
}

describe('V1 — a late bust check never eliminates a player who is all-in in the NEXT, already dealt hand', () => {
  /** The reviewer's E1: heads-up TB, b0 9000 / b1 1000; hand N ends with NO bust, its check held in mergeUserStats. */
  async function headsUp(over: Partial<typeof P> = {}) {
    const hold = deferred();
    const w = world({ layout: { TB: [{ pid: 'b0', name: 'b0', stack: 9000, uid: 200 }, { pid: 'b1', name: 'b1', stack: 1000, uid: 201 }] }, over, scope: persistenceScope(hold.p) });
    const elim = eliminations(w);
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b0', 'TB', 0, 200, 'm-b0');
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    (TB as any).currentPhase = GamePhase.HandComplete;
    const done = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 300 }]);
    await flush();
    return { w, elim, TB, hold, done };
  }

  it('E1 heads-up: hand N+1 waits for hand N\'s (no-bust) check; dealt after it; b1 all-in there is never eliminated mid-hand; the hand plays out and ITS check settles it (the final finishes correctly)', async () => {
    const x = await headsUp();
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(0);                                         // V1 (a): held
    x.hold.resolve();
    await x.done;
    await flush();
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(1);
    driveToAllIn(x.TB, 1);
    expect(x.TB.seats[1]).toMatchObject({ chipCount: 0, allIn: true, eliminated: false });
    expect(x.elim).toEqual([]);
    const results = playOut(x.TB);
    await x.w.m.handleHandComplete('TB', results);
    await flush();
    expectSettled(x.w, x.TB, 10000);
    expect(x.elim).toEqual(x.TB.seats[1].chipCount === 0 ? [{ playerId: 'b1', eliminatorId: 'b0' }] : []);
  });

  it('E1 (b) alone — the deal slips in before hand N\'s check (no deal guard): the late check does NOT take the all-in b1; the hand plays out; its own check settles it', async () => {
    const x = await headsUp({ autoStart: withoutDealGuard(P.autoStart) });
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(1);
    driveToAllIn(x.TB, 1);
    x.hold.resolve();
    await x.done;                                                            // hand N's check runs NOW, mid hand N+1
    await flush();
    expect(x.TB.isHandInProgress()).toBe(true);
    expect(x.TB.seats[1]).toMatchObject({ chipCount: 0, allIn: true, eliminated: false });
    expect(x.elim).toEqual([]);
    expect(x.w.tm.getTournament(x.w.tid)!.status).toBe('running');
    const results = playOut(x.TB);
    await x.w.m.handleHandComplete('TB', results);
    await flush();
    expectSettled(x.w, x.TB, 10000);
  });

  it('CONTROL — pre-V1 (no-bust hands never pending, no in-hand guard): the E1 repro — b1 is eliminated mid-hand and the tournament is FINISHED with the hand unplayed', async () => {
    const x = await headsUp(PRE_V1);
    expect(x.w.m.tournamentBustChecksPending.has('TB')).toBe(false);
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(1);
    driveToAllIn(x.TB, 1);
    x.hold.resolve();
    await x.done;
    await flush();
    expect(x.TB.isHandInProgress()).toBe(true);
    expect(x.elim).toEqual([{ playerId: 'b1' }]);
    expect(x.w.tm.getTournament(x.w.tid)!.status).toBe('finished');
  });

  /** The reviewer's E1c: 3-handed, b1 / b2 150 each against blinds 100/200 — a forced blind puts a short stack all-in at the deal. */
  async function threeHanded(over: Partial<typeof P> = {}) {
    const hold = deferred();
    const w = world({
      layout: { TB: [{ pid: 'b0', name: 'b0', stack: 9000, uid: 200 }, { pid: 'b1', name: 'b1', stack: 150, uid: 201 }, { pid: 'b2', name: 'b2', stack: 150, uid: 202 }] },
      over, scope: persistenceScope(hold.p),
    });
    const elim = eliminations(w);
    const TB = w.tables.get('TB')!;
    w.seatLive('S-b0', 'TB', 0, 200, 'm-b0');
    (TB as any).currentPhase = GamePhase.HandComplete;
    const done = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 300 }]);   // no bust
    await flush();
    const blindAllIns = () => TB.seats.filter((s) => s.state === 'occupied' && s.allIn && s.chipCount === 0).map((s) => s.playerId);
    return { w, elim, TB, hold, done, blindAllIns };
  }

  it('E1c 3-handed: held until hand N\'s check, then dealt; the blind all-in is never eliminated before his hand ends; settled by that hand\'s own check', async () => {
    const x = await threeHanded();
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(0);
    x.hold.resolve();
    await x.done;
    await flush();
    x.w.m.autoStartNextHand('TB');
    expect(x.TB.handNumber).toBe(1);
    expect(x.blindAllIns().length).toBeGreaterThan(0);
    expect(x.elim).toEqual([]);
    const results = playOut(x.TB);
    await x.w.m.handleHandComplete('TB', results);
    await flush();
    expectSettled(x.w, x.TB, 9300);
  });

  it('E1c (b) alone — dealt during hand N\'s pending check: its late run leaves the blind all-in alone', async () => {
    const x = await threeHanded({ autoStart: withoutDealGuard(P.autoStart) });
    x.w.m.autoStartNextHand('TB');
    const allIn = x.blindAllIns();
    expect(allIn.length).toBeGreaterThan(0);
    x.hold.resolve();
    await x.done;
    await flush();
    expect(x.TB.isHandInProgress()).toBe(true);
    expect(x.elim).toEqual([]);
    const results = playOut(x.TB);
    await x.w.m.handleHandComplete('TB', results);
    await flush();
    expectSettled(x.w, x.TB, 9300);
  });

  it('CONTROL — E1c pre-V1: the blind all-in is eliminated at the deal by the previous hand\'s late check', async () => {
    const x = await threeHanded(PRE_V1);
    x.w.m.autoStartNextHand('TB');
    const allIn = x.blindAllIns();
    expect(allIn.length).toBeGreaterThan(0);
    x.hold.resolve();
    await x.done;
    await flush();
    expect(x.TB.isHandInProgress()).toBe(true);
    expect(x.elim.map((e) => e.playerId).sort()).toEqual([...allIn].sort());
  });

  it('wiring: every completed tournament hand is pending; the in-hand guard sits in both bust-check loops', () => {
    const cap = P.helpers.slice(P.helpers.indexOf('function captureTournamentBustCheck('), P.helpers.indexOf('function runTournamentBustCheck('));
    expect(cap).toContain(V1A_PENDING);
    expect(cap).not.toContain('if (bustedThisHand.size > 0)');
    expect(P.helpers).toContain('const inHandInProgress = (s: Seat): boolean => table.isHandInProgress() && (s.totalInvestedThisHand || 0) > 0;');
  });
});

describe('V3 / P-a — a voluntary leave ends the socket\'s session BEFORE any fold / broadcast it triggers', () => {
  /** broadcastGameState recorded: who it would reach (sessions, spectators, the room). */
  function recWorld(over: Partial<typeof P> = {}) {
    const sent: Array<{ tableId: string; to: string[] }> = [];
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({
      layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over,
      scope: {
        broadcastGameState: (tid: string) => {
          const to: string[] = [];
          for (const [sid, s] of ref.w!.playerSessions) if (s.tableId === tid) to.push(`session:${sid}`);
          for (const sid of ref.w!.spectators.get(tid) || []) to.push(`spectator:${sid}`);
          for (const [sid, sock] of ref.w!.live) if (sock.rooms?.has(`table:${tid}`)) to.push(`room:${sid}`);
          sent.push({ tableId: tid, to });
        },
      },
    });
    ref.w = w;
    const TB = w.tables.get('TB')!;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    expect(TB.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && TB.activeSeatIndex !== 2; g++) { const a = TB.activeSeatIndex; if (!TB.playerCall(a)) TB.playerCheck(a); }
    expect(TB.activeSeatIndex).toBe(2);
    return { w, sent, TB, s };
  }
  const EARLY = '  socket.leave(`table:${session.tableId}`);\n  if (playerSessions.get(socket.id) === session) playerSessions.delete(socket.id);\n';

  it('leave on his own turn: he is acted for (Z6: his free check — the big blind\'s option — is checked) and the table is broadcast — none of it reaches the leaving socket (no session, not in the room); only tournamentSeatKept is sent to it', () => {
    const { w, sent, TB, s } = recWorld();
    expect(TB.currentBetToMatch - TB.seats[2].currentBet).toBe(0);
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', folded: false, chipCount: expect.any(Number) });
    expect(TB.activeSeatIndex === 2 && TB.currentPhase === GamePhase.PreFlop).toBe(false);   // acted for
    const tb = sent.filter((x) => x.tableId === 'TB');
    expect(tb.length).toBeGreaterThan(0);                                   // the action was broadcast…
    expect(tb.flatMap((x) => x.to).filter((r) => r.endsWith(':S-b2'))).toEqual([]);   // …never to him
    expect(s.emitted.map(([ev]: [string]) => ev)).toEqual(['tournamentSeatKept']);
    expect(w.reservedSeats.get(202)).toMatchObject({ voluntary: true, handsRemaining: 0 });
  });

  it('CONTROL — the pre-P-a order (session ended only after the keep\'s fold + broadcast): the fold\'s broadcast reaches the leaving socket (the late delta poker-3d merged into a stale seat)', () => {
    expect(P.seatKeep).toContain(EARLY);
    const { w, sent, s } = recWorld({ seatKeep: P.seatKeep.replace(EARLY, '') });
    w.m.handlePlayerLeave(s);
    const tb = sent.filter((x) => x.tableId === 'TB');
    expect(tb.flatMap((x) => x.to).filter((r) => r.endsWith(':S-b2')).length).toBeGreaterThan(0);
  });
});

/** The REAL broadcastGameState, recording what each socket is sent. */
function realBroadcast(w: ReturnType<typeof world>) {
  const got: Array<{ sid: string; tableId: string; yourSeat: number; isSpectator?: boolean }> = [];
  const { exports } = load(fnSrc('function broadcastGameState('), {
    tableManager: { getTable: (id: string) => w.tables.get(id) },
    playerSessions: w.playerSessions, multiTableSessions: w.multiTableSessions, spectators: w.spectators, reservedSeats: w.reservedSeats,
    io: { to: () => ({ emit() {} }), sockets: { sockets: w.live } },
    getGameStateForPlayer: (t: PokerTable, seat: number) => ({ tableId: t.config.tableId, yourSeat: seat }),
    emitGameState: (sock: any, state: any) => got.push({ sid: sock.id, tableId: state.tableId, yourSeat: state.yourSeat, ...(state.isSpectator ? { isSpectator: true } : {}) }),
    DrawPhases: [], isHandStoreReady: () => false, console: { log() {}, warn() {}, error() {} },
  }, '{ broadcastGameState }');
  return { bc: exports.broadcastGameState as (id: string) => void, got };
}

describe('V2 / P-e — a kept-absent seat that busts while its player sits at CASH on the same socket never makes that socket a spectator', () => {
  async function bustWhileAtCash(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over, scope: persistenceScope(null) });
    const TB = w.tables.get('TB')!;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.socketId = 'S-b2';   // registered from this socket
    w.m.handlePlayerLeave(s);                                                // Back to Lobby: kept absent (P-a)
    // …then a cash seat on the SAME socket (what joinTable does after the leave).
    const cash = new PokerTable({ tableId: 'CASH-1', tableName: 'Beginner', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    w.tables.set('CASH-1', cash);
    expect(cash.sitDown(4, 'b2', 2000, 'user_202', false)).toBe(true);
    w.playerSessions.set('S-b2', { socketId: 'S-b2', tableId: 'CASH-1', seatIndex: 4, playerName: 'b2', playerId: 'user_202', sittingOut: false });
    s.join('table:CASH-1');
    s.emitted.length = 0;
    // His absent stack is blinded / folded away and busts.
    TB.seats[0].chipCount += TB.seats[2].chipCount;
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    return { w, s, TB };
  }

  it('b2 is eliminated; his socket (seated at CASH-1) is NOT made a spectator and gets the plain notice (playerEliminated + tournamentId); TB\'s broadcasts never reach it, CASH-1\'s do', async () => {
    const { w, s } = await bustWhileAtCash();
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(true);
    expect(w.spectators.get('TB')?.has('S-b2') ?? false).toBe(false);
    expect(s.rooms.has('table:TB')).toBe(false);
    const evs = s.emitted.map(([ev]: [string]) => ev);
    expect(evs).not.toContain('eliminatedToSpectator');
    expect(s.emitted.find(([ev]: [string]) => ev === 'playerEliminated')![1]).toEqual({ tournamentId: w.tid, playerId: 'b2', playerName: 'b2', position: expect.any(Number) });
    expect(w.m.tournamentHandStartSafety.eliminationsToSocketSeatedElsewhere).toBe(1);
    const { bc, got } = realBroadcast(w);
    bc('TB');
    bc('CASH-1');
    expect(got.filter((g) => g.sid === 'S-b2')).toEqual([{ sid: 'S-b2', tableId: 'CASH-1', yourSeat: 4 }]);
  });

  /** Round 5 — the 'plays the seat AT this table' gate of runTournamentBustCheck (P-e'). */
  const PE_PRIME_GATE = '    const bustSidPlaysHere = !!bustSid && playerSessions.get(bustSid)?.tableId === tableId;\n';
  /** Round 5 — the spectator switch's combined gate (P-e + P-e'). */
  const TO_SPECTATOR = '    const toSpectator = !!bustSid && !!bustSock && bustSidPlaysHere && !seatedElsewhere;\n';

  it('CONTROL — without the P-e / P-e\' gates (the E2 repro): his socket joins TB\'s spectators and TB\'s spectator state is pushed on the same channel as his cash seat', async () => {
    const CHECK = 'const seatedElsewhere = !!bustSid && !!bustSock && socketHoldsPlayerSessionElsewhere(bustSid, tableId);';
    expect(P.helpers).toContain(CHECK);
    expect(P.helpers).toContain(TO_SPECTATOR);
    const { w, s } = await bustWhileAtCash({
      helpers: P.helpers.replace(CHECK, 'const seatedElsewhere = false;').replace(TO_SPECTATOR, '    const toSpectator = !!bustSid && !!bustSock;\n'),
    });
    expect(w.spectators.get('TB')?.has('S-b2')).toBe(true);
    expect(s.emitted.map(([ev]: [string]) => ev)).toContain('eliminatedToSpectator');
    const { bc, got } = realBroadcast(w);
    bc('TB');
    bc('CASH-1');
    expect(got.filter((g) => g.sid === 'S-b2').map((g) => g.tableId)).toEqual(['TB', 'CASH-1']);   // interleaved
  });

  // ── P-e' (round 5, 2026-10-10) — an AWAY seat's bust never makes a socket a
  // spectator / joins it to the table's room unless it plays the seat there.
  /** b2 left TB (Back to Lobby: kept absent, voluntary) and is in the lobby on S-b2; `prep` runs before his absent stack busts. */
  async function bustInLobby(over: Partial<typeof P> = {}, prep?: (w: ReturnType<typeof world>, s: any) => void, scope?: (ref: { w?: ReturnType<typeof world> }) => Record<string, unknown>) {
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over, scope: scope ? scope(ref) : persistenceScope(null) });
    ref.w = w;
    const TB = w.tables.get('TB')!;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.socketId = 'S-b2';
    w.m.handlePlayerLeave(s);
    if (prep) prep(w, s);
    s.emitted.length = 0;
    TB.seats[0].chipCount += TB.seats[2].chipCount;
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(true);
    return { w, s, TB };
  }
  const plainNotice = (w: ReturnType<typeof world>) => ['playerEliminated', { tournamentId: w.tid, playerId: 'b2', playerName: 'b2', position: expect.any(Number) }];

  it('P-e\': a busted AWAY entrant in the lobby is NOT made a spectator and NOT joined to TB\'s room — the plain notice only (playerEliminated + tournamentId)', async () => {
    const { w, s } = await bustInLobby();
    expect(w.spectators.get('TB')?.has('S-b2') ?? false).toBe(false);
    expect(s.rooms.has('table:TB')).toBe(false);
    expect(s.emitted).toEqual([plainNotice(w)]);
    expect(w.m.tournamentHandStartSafety.eliminationsToAwaySocket).toBe(1);
  });

  it('CONTROL — round 4 (P-e only: any socket not seated elsewhere): the lobby socket became TB\'s spectator, re-joined its room and was sent eliminatedToSpectator (the pe4 W2 start)', async () => {
    expect(P.helpers).toContain(PE_PRIME_GATE);
    const { w, s } = await bustInLobby({ helpers: P.helpers.replace(PE_PRIME_GATE, '    const bustSidPlaysHere = !!bustSid;\n') });
    expect(w.spectators.get('TB')?.has('S-b2')).toBe(true);
    expect(s.rooms.has('table:TB')).toBe(true);
    expect(s.emitted.map(([ev]: [string]) => ev)).toEqual(['eliminatedToSpectator']);
  });

  it('P-e\': a lobby socket WATCHING another table when his absent seat busts keeps watching THAT table only (never switched to TB); plain notice', async () => {
    const { w, s } = await bustInLobby({}, (w2, s2) => { w2.spectators.set('TA', new Set(['S-b2'])); s2.join('table:TA'); });
    expect(w.spectators.get('TA')?.has('S-b2')).toBe(true);
    expect(w.spectators.get('TB')?.has('S-b2') ?? false).toBe(false);
    expect([...s.rooms]).toEqual(['table:TA']);
    expect(s.emitted).toEqual([plainNotice(w)]);
  });

  it('CONTROL — round 4: his TA view was ended and he was switched to TB\'s spectator view', async () => {
    const { w, s } = await bustInLobby({ helpers: P.helpers.replace(PE_PRIME_GATE, '    const bustSidPlaysHere = !!bustSid;\n') }, (w2, s2) => { w2.spectators.set('TA', new Set(['S-b2'])); s2.join('table:TA'); });
    expect(w.spectators.get('TB')?.has('S-b2')).toBe(true);
    expect(w.spectators.get('TA')?.has('S-b2') ?? false).toBe(false);
    expect([...s.rooms]).toEqual(['table:TB']);
  });

  it('P-e\': an away socket WATCHING his own tournament table (in TB\'s room) is told the plain notice too — the room\'s broadcast carries no tournamentId', async () => {
    const { w, s } = await bustInLobby({}, (w2, s2) => { w2.spectators.set('TB', new Set(['S-b2'])); s2.join('table:TB'); });
    expect(s.emitted).toEqual([plainNotice(w)]);
    expect(s.emitted.map(([ev]: [string]) => ev)).not.toContain('eliminatedToSpectator');
  });

  /** Round 6 — an io whose room broadcasts record their .except() list; "delivered" = in the room and not excepted. */
  function exceptIo(ref: { w?: ReturnType<typeof world> }) {
    const roomEmits: Array<{ room: string; ev: string; except: string[]; d: any }> = [];
    const io: any = {
      to: (room: string) => {
        const op: any = { ex: [] as string[] };
        op.except = (ids: string | string[]) => { op.ex = [...op.ex, ...(Array.isArray(ids) ? ids : [ids])]; return op; };
        op.emit = (ev: string, d: any) => roomEmits.push({ room, ev, except: op.ex, d });
        return op;
      },
      emit() {},
      sockets: { get sockets() { return ref.w!.live; } },
    };
    return { io, roomEmits };
  }
  const watchTB = (w2: ReturnType<typeof world>, s2: any) => { w2.spectators.set('TB', new Set(['S-b2'])); s2.join('table:TB'); };
  /** Every playerEliminated for b2 that reached S-b2: the direct ones, plus the room copies of rooms he is in that did not except him. */
  const noticesFor = (s: any, roomEmits: Array<{ room: string; ev: string; except: string[]; d: any }>) => [
    ...s.emitted.filter(([ev, d]: [string, any]) => ev === 'playerEliminated' && d.playerId === 'b2').map(() => 'direct'),
    ...roomEmits.filter((e) => e.ev === 'playerEliminated' && e.d.playerId === 'b2' && s.rooms.has(e.room) && !e.except.includes('S-b2')).map(() => 'room'),
  ];

  it('round 6 — ONE notice: watching his own table, the away entrant gets the direct notice (with tournamentId) and the room\'s copy skips him (.except) — one toast, not two', async () => {
    let roomEmits: Array<{ room: string; ev: string; except: string[]; d: any }> = [];
    const { s } = await bustInLobby({}, watchTB, (ref) => { const x = exceptIo(ref); roomEmits = x.roomEmits; return { ...persistenceScope(null), io: x.io }; });
    expect(noticesFor(s, roomEmits)).toEqual(['direct']);
    const room = roomEmits.filter((e) => e.ev === 'playerEliminated' && e.d.playerId === 'b2');
    expect(room.length).toBeGreaterThan(0);
    for (const e of room) expect(e.except).toEqual(['S-b2']);
  });

  it('CONTROL — round 5 (no except): the room\'s generic copy reaches him as well as the direct one (two toasts)', async () => {
    const SET = '      eliminationDirectNotice = noticeSids.length > 0 ? { playerId: seat.playerId, sids: noticeSids } : null;\n';
    expect(P.helpers).toContain(SET);
    let roomEmits: Array<{ room: string; ev: string; except: string[]; d: any }> = [];
    const { s } = await bustInLobby({ helpers: P.helpers.replace(SET, '      eliminationDirectNotice = null;\n') }, watchTB, (ref) => { const x = exceptIo(ref); roomEmits = x.roomEmits; return { ...persistenceScope(null), io: x.io }; });
    expect(noticesFor(s, roomEmits).sort()).toEqual(['direct', 'room']);
  });

  it('the socket that PLAYED the seat still gets the room\'s copy (never excepted) plus eliminatedToSpectator — unchanged', async () => {
    const ref: { w?: ReturnType<typeof world> } = {};
    const x = exceptIo(ref);
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: { ...persistenceScope(null), io: x.io } });
    ref.w = w;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    const TB = w.tables.get('TB')!;
    TB.seats[0].chipCount += TB.seats[2].chipCount;
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    expect(noticesFor(s, x.roomEmits)).toEqual(['room']);
    expect(s.emitted.map(([ev]: [string]) => ev)).toContain('eliminatedToSpectator');
  });

  it('CONTROL — the round-4 notice skipped a socket in the table\'s room: his away seat could never end', async () => {
    const PUSH = '    if (io.sockets.sockets.get(sid)?.connected) out.push(sid);\n';
    expect(P.seatKeep).toContain(PUSH);
    const { s } = await bustInLobby({ seatKeep: P.seatKeep.replace(PUSH, "    if (io.sockets.sockets.get(sid)?.connected && !io.sockets.sockets.get(sid).rooms?.has('table:TB')) out.push(sid);\n") },
      (w2, s2) => { w2.spectators.set('TB', new Set(['S-b2'])); s2.join('table:TB'); });
    expect(s.emitted).toEqual([]);
  });

  it('the socket that PLAYED the seat still gets eliminatedToSpectator when this very elimination breaks another table INTO his (his busted seat vacated for a mover — read before the elimination)', async () => {
    // TA 6 / TB 4: a5 busts on TA (his live socket S-a5 plays it) → 9 alive → TB is broken into TA, a5's busted seat taken.
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 4, 5000, 200) }, scope: persistenceScope(null) });
    const a5 = w.seatLive('S-a5', 'TA', 5, 105, 'm-a5');
    const TA = w.tables.get('TA')!;
    TA.seats[0].chipCount += TA.seats[5].chipCount;
    TA.seats[5].chipCount = 0;
    (TA as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TA', [{ seatIndex: 0, amount: 5000 }]);
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TA']);                // TB broken into TA
    expect(w.playerSessions.has('S-a5')).toBe(false);                           // his busted seat was vacated
    expect(a5.emitted.map(([ev]: [string]) => ev)).toContain('eliminatedToSpectator');
    expect(w.spectators.get('TA')?.has('S-a5')).toBe(true);
  });

  it('CONTROL — "plays here" read AFTER the elimination: the vacated seat holder is never told eliminatedToSpectator', async () => {
    const BEFORE = '    const bustSidPlaysHere = !!bustSid && playerSessions.get(bustSid)?.tableId === tableId;\n';
    const AFTER_IF = '        if (toSpectator && sid && sock) {\n';
    const AFTER_RECOMPUTE = '        toSpectator = !!sid && !!sock && playerSessions.get(sid)?.tableId === tableId && !seatedElsewhere;\n';
    expect(P.helpers).toContain(BEFORE);
    expect(P.helpers).toContain(TO_SPECTATOR);
    expect(P.helpers).toContain(AFTER_IF);
    const w = world({
      layout: { TA: field('a', 6, 5000, 100), TB: field('b', 4, 5000, 200) }, scope: persistenceScope(null),
      over: { helpers: P.helpers.replace(TO_SPECTATOR, '    let toSpectator = false;\n').replace(AFTER_IF, AFTER_RECOMPUTE + AFTER_IF) },
    });
    const a5 = w.seatLive('S-a5', 'TA', 5, 105, 'm-a5');
    const TA = w.tables.get('TA')!;
    TA.seats[0].chipCount += TA.seats[5].chipCount;
    TA.seats[5].chipCount = 0;
    (TA as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TA', [{ seatIndex: 0, amount: 5000 }]);
    expect(a5.emitted.map(([ev]: [string]) => ev)).not.toContain('eliminatedToSpectator');
  });

  /** Round 5 — the REAL quickHeadsUp / joinByInviteCode handlers need a table factory and a buy-in. */
  function seatPathScope(ref: { w?: ReturnType<typeof world> }): Record<string, unknown> {
    return {
      ...persistenceScope(null),
      tableManager: {
        getTable: (id: string) => ref.w!.tables.get(id),
        removeTable: (id: string) => ref.w!.tables.delete(id),
        createHeadsUpTable: () => {
          ref.w!.tables.set('HU-1', new PokerTable({ tableId: 'HU-1', tableName: 'HU-1', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any));
          return 'HU-1';
        },
        getTableByInviteCode: (code: string) => (ref.w!.tables.get('PRIV-1') && code === 'priv-1' ? { tableId: 'PRIV-1', table: ref.w!.tables.get('PRIV-1') } : null),
      },
      ensureChipsForBuyIn: async () => 1_000_000, deductChips: async () => true,
      generateRandomProfile: () => ({ botName: 'HU-Bot' }),
    };
  }
  const HU_DETACH = "    detachSocketFromOtherTables(socket, tableId, 'seat', 'quickHeadsUp');   // P-g (round 5) — one table view per socket\n";

  it('W2 end to end: busted while away in the lobby, then a REAL quickHeadsUp on the same socket — only HU-1\'s state reaches it, never TB\'s; not in TB\'s room', async () => {
    const { w, s } = await bustInLobby({}, undefined, seatPathScope);
    const sock = w.wireSocket('S-b2');
    await sock.handlers.quickHeadsUp({ playerName: 'b2' });
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'HU-1', seatIndex: 0 });
    expect(s.rooms.has('table:TB')).toBe(false);
    const { bc, got } = realBroadcast(w);
    bc('TB');
    bc('HU-1');
    expect(got.filter((g) => g.sid === 'S-b2').map((g) => g.tableId)).toEqual(['HU-1']);
  });

  it('CONTROL — round 4 (P-e\' off) with the pre-P-g quickHeadsUp (no detach): TB\'s spectator state and HU-1\'s seat interleave on his one delta channel (the pe4 W2 repro)', async () => {
    expect(P.quickHeadsUp).toContain(HU_DETACH);
    const { w, s } = await bustInLobby({ helpers: P.helpers.replace(PE_PRIME_GATE, '    const bustSidPlaysHere = !!bustSid;\n'), quickHeadsUp: P.quickHeadsUp.replace(HU_DETACH, '') }, undefined, seatPathScope);
    const sock = w.wireSocket('S-b2');
    await sock.handlers.quickHeadsUp({ playerName: 'b2' });
    expect(s.rooms.has('table:TB')).toBe(true);
    const { bc, got } = realBroadcast(w);
    bc('TB');
    bc('HU-1');
    expect(got.filter((g) => g.sid === 'S-b2').map((g) => g.tableId)).toEqual(['TB', 'HU-1']);
  });

  it('P-g: a socket WATCHING TA (the real spectate handler) that starts a quick game stops watching TA and leaves its room; only HU-1 reaches it', async () => {
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: seatPathScope(ref) });
    ref.w = w;
    w.mkSocket('S-x');
    w.authSessions.set('S-x', { userId: 901, username: 'x', masterUserId: 'm-x' });
    const sock = w.wireSocket('S-x');
    await sock.handlers.spectate({ tableId: 'TA' });
    expect(w.spectators.get('TA')?.has('S-x')).toBe(true);
    expect(sock.rooms.has('table:TA')).toBe(true);
    await sock.handlers.quickHeadsUp({ playerName: 'x' });
    expect(w.spectators.get('TA')?.has('S-x') ?? false).toBe(false);
    expect([...sock.rooms]).toEqual(['table:HU-1']);
    const { bc, got } = realBroadcast(w);
    bc('TA');
    bc('HU-1');
    expect(got.filter((g) => g.sid === 'S-x').map((g) => g.tableId)).toEqual(['HU-1']);
    expect(w.m.tableViewDetaches.calls).toBeGreaterThan(0);
  });

  it('CONTROL — the pre-P-g quickHeadsUp: still TA\'s spectator; TA\'s state and HU-1\'s interleave', async () => {
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: seatPathScope(ref), over: { quickHeadsUp: P.quickHeadsUp.replace(HU_DETACH, '') } });
    ref.w = w;
    w.mkSocket('S-x');
    w.authSessions.set('S-x', { userId: 901, username: 'x', masterUserId: 'm-x' });
    const sock = w.wireSocket('S-x');
    await sock.handlers.spectate({ tableId: 'TA' });
    await sock.handlers.quickHeadsUp({ playerName: 'x' });
    expect(w.spectators.get('TA')?.has('S-x')).toBe(true);
    const { bc, got } = realBroadcast(w);
    bc('TA');
    bc('HU-1');
    expect(got.filter((g) => g.sid === 'S-x').map((g) => g.tableId)).toEqual(['TA', 'HU-1']);
  });

  it('P-g / P-a: joinByInviteCode from a LIVE tournament seat goes through handlePlayerLeave — the seat is kept (voluntary, reserved, told tournamentSeatKept), the socket leaves TB\'s room and sits at the private table', async () => {
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: seatPathScope(ref) });
    ref.w = w;
    w.tables.set('PRIV-1', new PokerTable({ tableId: 'PRIV-1', tableName: 'Home', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any));
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    const sock = w.wireSocket('S-b2');
    await sock.handlers.joinByInviteCode({ inviteCode: 'PRIV-1', playerName: 'b2', buyIn: 1000 });
    expect(w.tables.get('TB')!.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.reservedSeats.get(202)).toMatchObject({ tableId: 'TB', seatIndex: 2, voluntary: true });
    expect(s.emitted.find(([ev]: [string]) => ev === 'tournamentSeatKept')?.[1]).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'PRIV-1' });
    expect(s.rooms.has('table:TB')).toBe(false);
    expect(s.rooms.has('table:PRIV-1')).toBe(true);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — the pre-fix invite join (no leave): the session is overwritten — the seat absent with NO reservation, no voluntary mark, nothing told; the socket still in TB\'s room', async () => {
    const LEAVE = "    if (playerSessions.get(socket.id)) handlePlayerLeave(socket);\n    detachSocketFromOtherTables(socket, tableId, 'seat', 'joinByInviteCode');\n";
    const COMMIT = "    detachSocketFromOtherTables(socket, tableId, 'seat', 'joinByInviteCode');   // P-g — at the commit too\n";
    expect(P.joinByInviteCode).toContain(LEAVE);
    expect(P.joinByInviteCode).toContain(COMMIT);
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: seatPathScope(ref), over: { joinByInviteCode: P.joinByInviteCode.replace(LEAVE, '').replace(COMMIT, '') } });
    ref.w = w;
    w.tables.set('PRIV-1', new PokerTable({ tableId: 'PRIV-1', tableName: 'Home', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any));
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    const sock = w.wireSocket('S-b2');
    await sock.handlers.joinByInviteCode({ inviteCode: 'PRIV-1', playerName: 'b2', buyIn: 1000 });
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(w.m.voluntarilyAbsentTournamentEntrants.size).toBe(0);
    expect(s.emitted.map(([ev]: [string]) => ev)).not.toContain('tournamentSeatKept');
    expect(s.rooms.has('table:TB')).toBe(true);
  });
});

describe('V4 — a rebalance that moves an ABSENT seat tells his sockets; Return follows the seat', () => {
  /** TA 5 / TB 4 → Rule 1 breaks TB. b2 left TB (kept absent) and sits in the lobby on S-b2. */
  function movedWorld(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 4, 5000, 200) }, over });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(s);
    s.emitted.length = 0;
    w.m.handleTableRebalance(w.tid);
    const t = w.tm.getTournament(w.tid)!;
    expect(t.tableIds).toEqual(['TA']);
    const seat = w.tables.get('TA')!.seats.findIndex((x) => x.state === 'occupied' && x.playerId === 'b2' && !x.eliminated);
    expect(seat).toBeGreaterThan(-1);
    return { w, s, seat };
  }

  it('his lobby socket gets an updated tournamentSeatKept (TA, the new seat); his reservation (still voluntary) moved; Return puts him there — reconnectedToTable {TA, seat, tournamentId}', async () => {
    const { w, s, seat } = movedWorld();
    expect(s.emitted).toEqual([['tournamentSeatKept', { tournamentId: w.tid, tableId: 'TA', seatIndex: seat, tournamentName: 'Rebalance Cup', chips: 5000 }]]);
    expect(w.reservedSeats.get(202)).toMatchObject({ tableId: 'TA', seatIndex: seat, voluntary: true });
    expect(w.m.tournamentHandStartSafety.absentSeatsMovedNotified).toBe(1);
    const sock = w.wireSocket('S-b2');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks).toEqual([{ success: true, tournamentId: w.tid, tableId: 'TA', seatIndex: seat }]);
    expect(sock.emitted).toContainEqual(['reconnectedToTable', { tableId: 'TA', seatIndex: seat, tournamentId: w.tid }]);
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'TA', seatIndex: seat });
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(w.m.voluntarilyAbsentTournamentEntrants.size).toBe(0);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — without the V4 notice the away socket is never told where the seat went', () => {
    const NOTE = '  if (tp && !firstLive && tournamentId) noteAbsentTournamentSeatMoved(tournamentId, tp, toTableId, toSeat);\n';
    expect(P.helpers).toContain(NOTE);
    const { s } = movedWorld({ helpers: P.helpers.replace(NOTE, '') });
    expect(s.emitted).toEqual([]);
  });
});

describe('P-c — returnToTournamentSeat answers authoritatively; a repeated tap for the seat he holds again is success', () => {
  it('Return, then Return again: both success (the second answered from the seat he holds — reconnectedToTable + a full gameState again), never already_seated', async () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(s);
    const sock = w.wireSocket('S-b2');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks).toEqual([
      { success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 },
      { success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 },
    ]);
    expect(sock.emitted.filter(([ev]: [string]) => ev === 'reconnectedToTable')).toHaveLength(2);
    expect(sock.emitted.filter(([ev]: [string]) => ev === 'returnToTournamentResult')).toHaveLength(2);
    expect(w.m.tournamentSeatKeep).toMatchObject({ returned: 1, returnAlreadyThere: 1 });
  });

  it('a session left on his DEAD (busted) seat of another tournament table is cleared, his spectating ends, and the return goes on', async () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(s);
    // a stale session of this socket on a busted seat (eliminated, 0 chips), and spectating TA
    bust(w, 'TA', [5]);
    w.playerSessions.set('S-b2', { socketId: 'S-b2', tableId: 'TA', seatIndex: 5, playerName: 'a5', playerId: 'a5', sittingOut: false });
    w.spectators.set('TA', new Set(['S-b2']));
    const sock = w.wireSocket('S-b2');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks).toEqual([{ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 }]);
    expect(w.spectators.get('TA')?.has('S-b2') ?? false).toBe(false);
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
  });
});

describe('P-b — what a sign-in tells about kept seats (tellKeptTournamentSeats)', () => {
  it('a VOLUNTARY seat is told to every sign-in; a disconnect (non-voluntary) absent seat only to authWithTicket (\'all\'); nothing to another account', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s2 = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(s2);                                               // b2: voluntary
    w.seatLive('S-b3', 'TB', 3, 203, 'm-b3');
    w.playerSessions.delete('S-b3');                                         // b3: absent, NOT voluntary (a dropped socket)
    const fresh2 = w.mkSocket('F-b2');
    w.authSessions.set('F-b2', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
    const fresh3 = w.mkSocket('F-b3');
    w.authSessions.set('F-b3', { userId: 203, username: 'u203', masterUserId: 'm-b3' });
    expect(w.m.tellKeptTournamentSeats(fresh2, w.authSessions.get('F-b2'), 'voluntary', 'test')).toBe(1);
    expect(fresh2.emitted).toEqual([['tournamentSeatKept', { tournamentId: w.tid, tableId: 'TB', seatIndex: 2, tournamentName: 'Rebalance Cup', chips: 5000 }]]);
    expect(w.m.tellKeptTournamentSeats(fresh3, w.authSessions.get('F-b3'), 'voluntary', 'test')).toBe(0);
    expect(w.m.tellKeptTournamentSeats(fresh3, w.authSessions.get('F-b3'), 'all', 'authWithTicket')).toBe(1);
    expect(fresh3.emitted).toEqual([['tournamentSeatKept', { tournamentId: w.tid, tableId: 'TB', seatIndex: 3, tournamentName: 'Rebalance Cup', chips: 5000 }]]);
    const other = w.mkSocket('F-x');
    w.authSessions.set('F-x', { userId: 999, username: 'x', masterUserId: 'm-x' });
    expect(w.m.tellKeptTournamentSeats(other, w.authSessions.get('F-x'), 'all', 'test')).toBe(0);
    expect(w.m.tournamentSeatKeep.signInNotices).toBe(2);
  });

  it('wiring: every sign-in tells AFTER its loginResult — oauthLogin, tokenLogin ×2, resumeSession, the waitlist bootstrap (voluntary), authWithTicket (all)', () => {
    const after = (body: string, result: string, tell: string) => {
      const r = body.indexOf(result);
      const t = body.indexOf(tell);
      expect({ tell, r: r > -1, t: t > -1 }).toEqual({ tell, r: true, t: true });
      expect({ tell, order: t > r }).toEqual({ tell, order: true });
    };
    const oauth = slice("socket.on('oauthLogin', trackLogin(socket, 'oauthLogin', async", '\n  }));\n');
    after(oauth, "socket.emit('loginResult', {\n        success: true,", "if (!data?.skipSeatRecovery) tellKeptTournamentSeats(socket, oauthSession, 'voluntary', 'oauthLogin');");
    const tl = slice("socket.on('tokenLogin', trackLogin(socket, 'tokenLogin', async", '\n  }));\n');
    after(tl, 'success: true, token: data.token, userData: progress.userData,', "tellKeptTournamentSeats(socket, tlSession, 'voluntary', 'tokenLogin');");
    after(tl, "socket.emit('loginResult', { ...result,", "tellKeptTournamentSeats(socket, legacyAuthNow, 'voluntary', 'tokenLogin_legacy');");
    const rs = slice('  let resumeWindowStart = 0;', '\n    })\n  );\n');
    after(rs, "socket.emit('loginResult', {\n          success: true,", "if (!data?.skipSeatRecovery) tellKeptTournamentSeats(socket, rsSession, 'voluntary', 'resumeSession');");
    const tk = slice("    'authWithTicket',", '\n    })\n  );\n');
    after(tk, "socket.emit('loginResult', {\n          success: true, token: data.token, userData,", "tellKeptTournamentSeats(socket, tkSession, 'all', 'authWithTicket');");
    const wl = handlerSrc('joinWithWaitlistContext', '\n    }\n  );');
    after(wl, "socket.emit('gameState', getGameStateForPlayer(table, targetSeat));", "if (wlAuthNow) tellKeptTournamentSeats(socket, wlAuthNow, 'voluntary', 'joinWithWaitlistContext');");
    // Every reservation-path reconnectedToTable carries the tournament (P-b).
    for (const [name, body] of [['oauthLogin', oauth], ['tokenLogin', tl], ['resumeSession', rs]] as const) {
      const n = body.split("socket.emit('reconnectedToTable'").length - 1;
      expect({ name, withTournament: body.split('...reconnectTournamentFields(reserved)').length - 1 }).toEqual({ name, withTournament: n });
    }
  });
});

describe('P-f — an admin kick / IP-ban from a LIVE tournament seat disqualifies the entrant; the seat is never kept', () => {
  function kickWorld() {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    return { w, s, TB: w.tables.get('TB')! };
  }

  it('between hands: b2 disqualified (no prize, no eliminator), his seat stood up, its 5000 NEVER credited (audited), no reservation, no tournamentSeatKept; audited TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN', () => {
    const { w, s, TB } = kickWorld();
    const elim = eliminations(w);
    const before = w.chipsInPlay();
    w.m.leaveTournamentSeatOnAdminRemoval(s, 'admin_kick', 'the.admin');
    const b2 = w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!;
    expect(b2).toMatchObject({ eliminated: true, disqualified: true });
    expect(elim).toEqual([{ playerId: 'b2' }]);
    expect(TB.seats[2].state).toBe('empty');
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(w.playerSessions.has('S-b2')).toBe(false);
    expect(s.emitted.map(([ev]: [string]) => ev)).not.toContain('tournamentSeatKept');
    expect(w.credits).toEqual([]);
    expect(w.chipsInPlay()).toBe(before - 5000);                            // out of play, never minted into a wallet
    expect(w.audits).toContainEqual(expect.objectContaining({
      actor: 'the.admin', action: 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN',
      d: expect.objectContaining({ via: 'admin_kick', playerId: 'b2', targetUserId: 202, disqualified: true, credited: 0 }),
    }));
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ amount: 5000 }) }));
    expect(w.m.tournamentHandStartSafety.adminRemovalsDisqualified).toBe(1);
    expect(w.m.voluntarilyAbsentTournamentEntrants.size).toBe(0);
  });

  it('CONTROL — the pre-P-f kick (a plain leave): his seat is KEPT absent and reserved, he stays alive — he could sign back into it', () => {
    const { w, s, TB } = kickWorld();
    w.m.handlePlayerLeave(s);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.reservedSeats.has(202)).toBe(true);
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
  });

  it('mid-hand with chips in the pot: disqualified at once, his seat folded and left for the hand\'s end (no pot erased), nothing credited', () => {
    const { w, s, TB } = kickWorld();
    expect(TB.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && TB.activeSeatIndex !== 2; g++) { const a = TB.activeSeatIndex; if (!TB.playerCall(a)) TB.playerCheck(a); }
    TB.playerCall(2);                                                        // b2 has chips in the pot
    expect(TB.seats[2].totalInvestedThisHand).toBeGreaterThan(0);
    const total = w.chipsInPlay();
    w.m.leaveTournamentSeatOnAdminRemoval(s, 'admin_ip_ban', 'the.admin');
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.disqualified).toBe(true);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', folded: true });
    expect(w.chipsInPlay()).toBe(total);
    expect(w.credits).toEqual([]);
  });

  it('a cash seat is the normal leave (credited to his wallet as before); both admin handlers route through it', async () => {
    const { w } = kickWorld();
    const cash = new PokerTable({ tableId: 'CASH-1', tableName: 'Beginner', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    w.tables.set('CASH-1', cash);
    expect(cash.sitDown(4, 'x', 2000, 'user_901', false)).toBe(true);
    const c = w.mkSocket('S-x');
    w.authSessions.set('S-x', { userId: 901, username: 'x' });
    w.playerSessions.set('S-x', { socketId: 'S-x', tableId: 'CASH-1', seatIndex: 4, playerName: 'x', playerId: 'user_901', sittingOut: false });
    w.m.leaveTournamentSeatOnAdminRemoval(c, 'admin_kick', 'the.admin');
    await flush();
    expect(w.credits).toEqual([{ uid: 901, amount: 2000 }]);
    expect(w.audits.filter((a) => a.action === 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN')).toEqual([]);
    expect(handlerSrc('adminKickPlayer', '\n  });\n')).toContain("leaveTournamentSeatOnAdminRemoval(s, 'admin_kick', auth.username, target)");
    expect(handlerSrc('adminIPBan', '\n  });\n')).toContain("leaveTournamentSeatOnAdminRemoval(s, 'admin_ip_ban', auth.username)");
    expect(handlerSrc('adminKickPlayer', '\n  });\n')).not.toContain('handlePlayerLeave(s)');
  });
});

describe('P-d — every full gameState says whether its table is a tournament table (isTournament + tournamentId)', () => {
  function stateFn(tournamentTables: Map<string, string>) {
    const code = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n') + fnSrc('function getGameStateForPlayer(');
    return load(code, {
      tournamentTables, playerSessions: new Map(), progressionManager: { getProgress: () => null },
      getVariantInfo: () => ({ variant: 'texas-holdem', variantName: "Texas Hold'em", holeCardCount: 2, hasDrawPhase: false, isStudGame: false }),
      turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
      MAX_SEATS: 9, GamePhase, SEAT_RESERVE_MS: 6 * 3600_000, cardToString: (c: any) => `${c.rank}${c.suit}`,
    }, '{ getGameStateForPlayer, noteBrokenTournamentTable }').exports;
  }
  const mk = (id: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    t.sitDown(0, 'p0', 2000, 'p0', false);
    return t;
  };

  it('tournament table → isTournament:true + its tournamentId (a just-broken one too); cash table → false / null (always present)', () => {
    const m = stateFn(new Map([['TB', 'tour-1']]));
    expect(m.getGameStateForPlayer(mk('TB'), 0)).toMatchObject({ tableId: 'TB', isTournament: true, tournamentId: 'tour-1' });
    expect(m.getGameStateForPlayer(mk('CASH-1'), 0)).toMatchObject({ tableId: 'CASH-1', isTournament: false, tournamentId: null });
    m.noteBrokenTournamentTable('TX', 'tour-1');
    expect(m.getGameStateForPlayer(mk('TX'), -1)).toMatchObject({ isTournament: true, tournamentId: 'tour-1' });
  });

  it('the per-socket delta carries the change when one socket moves from a tournament table to a cash table (never a stale isTournament:true)', () => {
    const m = stateFn(new Map([['TB', 'tour-1']]));
    const code = slice('const ALWAYS_EMIT_KEYS', ';\n') + fnSrc('function shallowDiff(') + fnSrc('function pickAlwaysEmit(') + fnSrc('function emitGameState(');
    const { exports: e } = load(code, { lastSentState: new Map(), lastSentJson: new Map() }, '{ emitGameState }');
    const sent: any[] = [];
    const sock = { id: 'S1', emit: (_ev: string, d: any) => sent.push(d) };
    e.emitGameState(sock, m.getGameStateForPlayer(mk('TB'), 0), true);
    e.emitGameState(sock, m.getGameStateForPlayer(mk('CASH-1'), 0));
    expect(sent[0].state).toMatchObject({ isTournament: true, tournamentId: 'tour-1' });
    expect(sent[1].full).toBe(false);
    expect(sent[1].delta).toMatchObject({ tableId: 'CASH-1', isTournament: false, tournamentId: null });
  });
});

// ══ Round 5 (2026-10-10, pe4 review, owner "fix all") — protocol amendments P-e' / P-g / P-h / P-c' + server minors ══

describe('P-g (round 5) — one socket, one table view: detachSocketFromOtherTables', () => {
  it('a seat at Y: every other spectating ends (Y\'s too), every other table room is left except the main seat\'s and the extra seats\'; the delta baseline is dropped', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s = w.mkSocket('S-x');
    w.spectators.set('TA', new Set(['S-x', 'S-other']));
    w.spectators.set('Y', new Set(['S-x']));
    for (const r of ['table:TA', 'table:TB', 'table:Y', 'table:MAIN', 'table:EXTRA', 'club:7']) s.join(r);
    const mainTable = new PokerTable({ tableId: 'MAIN', tableName: 'MAIN', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    expect(mainTable.sitDown(1, 'x', 2000, 'px', false)).toBe(true);         // a LIVE main seat (cash) — never ended
    w.tables.set('MAIN', mainTable);
    w.playerSessions.set('S-x', { socketId: 'S-x', tableId: 'MAIN', seatIndex: 1, playerName: 'x', playerId: 'px' });
    w.multiTableSessions.set('S-x', [{ socketId: 'S-x', tableId: 'EXTRA', seatIndex: 2, playerName: 'x', playerId: 'px2' }]);
    w.m.detachSocketFromOtherTables(s, 'Y', 'seat', 'test');
    expect(w.spectators.get('TA')).toEqual(new Set(['S-other']));
    expect(w.spectators.has('Y')).toBe(false);
    expect([...s.rooms].sort()).toEqual(['club:7', 'table:EXTRA', 'table:MAIN', 'table:Y']);
    expect(w.m.tableViewDetaches).toMatchObject({ calls: 1, spectatorViewsEnded: 2, roomsLeft: 2, deadSeatSessionsEnded: 0 });
    expect(w.playerSessions.get('S-x')).toMatchObject({ tableId: 'MAIN' });
  });

  it('spectating X: X\'s own spectating is kept; nothing detached → nothing counted', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s = w.mkSocket('S-x');
    w.spectators.set('TA', new Set(['S-x']));
    s.join('table:TA');
    w.m.detachSocketFromOtherTables(s, 'TA', 'spectate', 'test');
    expect(w.spectators.get('TA')?.has('S-x')).toBe(true);
    expect([...s.rooms]).toEqual(['table:TA']);
    expect(w.m.tableViewDetaches.calls).toBe(0);
  });

  /** pe5 X5: b2 PLAYS TB on S-b2 and busts there — eliminatedToSpectator; then he taps Next Table (the REAL spectateNextTable). */
  async function bustedSpectatorMovesOn(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over, scope: persistenceScope(null) });
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    const TB = w.tables.get('TB')!;
    TB.seats[0].chipCount += TB.seats[2].chipCount;
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    expect(s.emitted.map(([ev]: [string]) => ev)).toContain('eliminatedToSpectator');
    expect(w.spectators.get('TB')?.has('S-b2')).toBe(true);
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'TB', seatIndex: 2 });   // his DEAD seat's session (he watches his own table)
    const sock = w.wireSocket('S-b2');
    await sock.handlers.spectateNextTable({ tournamentId: w.tid, currentTableId: 'TB' });
    return { w, s };
  }

  it('pe5 X5 (round 6): a busted player who moves on with spectateNextTable loses his DEAD seat\'s session — only TA\'s spectator frames reach him, never TB\'s player view; the seat itself is untouched', async () => {
    const { w, s } = await bustedSpectatorMovesOn();
    expect(w.playerSessions.has('S-b2')).toBe(false);
    expect(w.spectators.get('TA')?.has('S-b2')).toBe(true);
    expect(w.spectators.get('TB')?.has('S-b2') ?? false).toBe(false);
    expect([...s.rooms]).toEqual(['table:TA']);
    expect(w.m.tableViewDetaches.deadSeatSessionsEnded).toBe(1);
    expect(w.tables.get('TB')!.seats[2]).toMatchObject({ state: 'occupied', chipCount: 0, eliminated: true });
    const { bc, got } = realBroadcast(w);
    bc('TB');
    bc('TA');
    expect(got.filter((g) => g.sid === 'S-b2').map((g) => [g.tableId, !!g.isSpectator])).toEqual([['TA', true]]);
  });

  it('CONTROL — round 5 (the detach kept any main session): TB\'s player-view frames and TA\'s spectator frames interleave on his one socket (the pe5 X5 repro)', async () => {
    const DEAD = '  if (main && main.tableId !== tableId) {\n';
    expect(P.seatKeep).toContain(DEAD);
    const { w } = await bustedSpectatorMovesOn({ seatKeep: P.seatKeep.replace(DEAD, '  if (false) {\n') });
    expect(w.playerSessions.get('S-b2')).toMatchObject({ tableId: 'TB' });
    const { bc, got } = realBroadcast(w);
    bc('TB');
    bc('TA');
    expect(got.filter((g) => g.sid === 'S-b2').map((g) => g.tableId)).toEqual(['TB', 'TA']);
  });

  it('a sign-in restore BY ACCOUNT (restoreAbsentTournamentSeat) from a socket watching TA: seated at TB, no longer TA\'s spectator, out of TA\'s room (pe4 minor, RVX D4)', () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) } });
    const s = w.mkSocket('S-b2');
    w.authSessions.set('S-b2', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
    w.spectators.set('TA', new Set(['S-b2']));
    s.join('table:TA');
    const r = w.m.restoreAbsentTournamentSeat(s, w.authSessions.get('S-b2'), 'oauthLogin');
    expect(r).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.spectators.get('TA')?.has('S-b2') ?? false).toBe(false);
    expect([...s.rooms]).toEqual(['table:TB']);
    expect(s.emitted.map(([ev]: [string]) => ev)).toEqual(['reconnectedToTable']);
  });

  it('CONTROL — the round-4 restore (only THIS table\'s spectating ended): still TA\'s spectator and in its room while seated at TB', () => {
    const DETACH = "  detachSocketFromOtherTables(socket, tableId, 'seat', via);\n";
    expect(P.seatKeep).toContain(DETACH);
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over: { seatKeep: P.seatKeep.replace(DETACH, '') } });
    const s = w.mkSocket('S-b2');
    w.authSessions.set('S-b2', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
    w.spectators.set('TA', new Set(['S-b2']));
    s.join('table:TA');
    w.m.restoreAbsentTournamentSeat(s, w.authSessions.get('S-b2'), 'oauthLogin');
    expect(w.spectators.get('TA')?.has('S-b2')).toBe(true);
    expect([...s.rooms].sort()).toEqual(['table:TA', 'table:TB']);
  });

  it('wiring: every seat / spectate path detaches the socket BEFORE it binds the session or the spectator view', () => {
    const cases: Array<[string, string, string]> = [
      // [handler start needle, detach call, the binding it must precede]
      ["    'joinTable',\n", "detachSocketFromOtherTables(socket, tableId, 'seat', 'joinTable');\n      playerSessions.set(socket.id, session);", 'playerSessions.set(socket.id, session);'],
      ["    'quickPlay',\n", "detachSocketFromOtherTables(socket, chosenTableId, 'seat', 'quickPlay');", 'playerSessions.set(socket.id, session);'],
      ["    'joinWithWaitlistContext',\n", "detachSocketFromOtherTables(socket, bestTable.tableId, 'seat', 'joinWithWaitlistContext');", 'playerSessions.set(socket.id, session);'],
      ["socket.on('quickHeadsUp'", "detachSocketFromOtherTables(socket, tableId, 'seat', 'quickHeadsUp');", 'playerSessions.set(socket.id, session);'],
      ["socket.on('quickSpinGo'", "detachSocketFromOtherTables(socket, tableId, 'seat', 'quickSpinGo');", 'playerSessions.set(socket.id, session);'],
      ["socket.on('quickAllInOrFold'", "detachSocketFromOtherTables(socket, tableId, 'seat', 'quickAllInOrFold');", 'playerSessions.set(socket.id, session);'],
      ["socket.on('startCareerGame'", "detachSocketFromOtherTables(socket, tableId, 'seat', 'startCareerGame');", 'playerSessions.set(socket.id, session);'],
      ["socket.on('joinByInviteCode'", "detachSocketFromOtherTables(socket, tableId, 'seat', 'joinByInviteCode');   // P-g — at the commit too", 'playerSessions.set(socket.id, session);'],
      ["socket.on('joinAdditionalTable'", "detachSocketFromOtherTables(socket, tableId, 'seat', 'joinAdditionalTable');", 'multiTableSessions.get(socket.id)!.push(session);'],
      ["socket.on('spectate', async", "detachSocketFromOtherTables(socket, tableId, 'spectate', 'spectate');", 'spectators.get(tableId)!.add(socket.id);'],
      ["socket.on('spectateTournament'", "detachSocketFromOtherTables(socket, bestTable, 'spectate', 'spectateTournament');", 'specSet.add(socket.id);'],
      ["socket.on('spectateNextTable'", "detachSocketFromOtherTables(socket, nextTableId, 'spectate', 'spectateNextTable');", 'newSet.add(socket.id);'],
      ["socket.on('oauthLogin'", "detachSocketFromOtherTables(socket, reserved.tableId, 'seat', 'oauthLogin');", 'playerSessions.set(socket.id, {'],
      ["socket.on('tokenLogin'", "detachSocketFromOtherTables(socket, reserved.tableId, 'seat', 'tokenLogin');", 'playerSessions.set(socket.id, restoredSession);'],
      ["socket.on('tokenLogin'", "detachSocketFromOtherTables(socket, reserved.tableId, 'seat', 'tokenLogin_legacy');", 'playerSessions.set(socket.id, restoredSession);'],
      ["    'resumeSession',\n", "detachSocketFromOtherTables(socket, reserved.tableId, 'seat', 'resumeSession');", 'playerSessions.set(socket.id, {'],
      ['function restoreAbsentTournamentSeat(', "detachSocketFromOtherTables(socket, tableId, 'seat', via);", 'playerSessions.set(socket.id, {'],
      ['function startTournamentGame(', "detachSocketFromOtherTables(sock, tableId, 'seat', 'startTournamentGame');", 'playerSessions.set(boundSid, session);'],
      ['function startQualifierTournament(', "detachSocketFromOtherTables(sock, tid, 'seat', 'startQualifierTournament');", 'playerSessions.set(boundSid, sess);'],
      ['function startMultiTableTournament(', "detachSocketFromOtherTables(sock, tid, 'seat', 'startMultiTableTournament');", 'playerSessions.set(humanSocketId, session);'],
    ];
    for (const [handler, detach, bind] of cases) {
      const at = SRC.indexOf(handler);
      const d = SRC.indexOf(detach, at);
      const b = SRC.indexOf(bind, d);
      expect({ handler, detach, ok: at > -1 && d > at && b > d }).toEqual({ handler, detach, ok: true });
    }
    // joinByInviteCode leaves a held seat through handlePlayerLeave first (P-a).
    const invite = handlerSrc('joinByInviteCode', '\n  });\n');
    expect(invite.indexOf('if (playerSessions.get(socket.id)) handlePlayerLeave(socket);')).toBeLessThan(invite.indexOf('playerSessions.set(socket.id, session);'));
    // The old spectator-only scrubs are gone (they left the socket in the rooms).
    expect(SRC).not.toContain('if (s.delete(socket.id) && s.size === 0) spectators.delete(tid);');
  });
});

describe('P-g (round 5) — a busted seat vacated for a mover never pulls a socket away from the table it now watches', () => {
  /** TA: a0-a4 alive + a5 BUSTED (his live socket S-a5 still points at it, but he cycled to watch TC); TB 4 → broken into TA (a5's seat taken). */
  function vacateWorld(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 4, 5000, 200), TC: field('c', 9, 5000, 300) }, over });
    bust(w, 'TA', [5]);
    const s = w.seatLive('S-a5', 'TA', 5, 105, 'm-a5');
    w.spectators.set('TC', new Set(['S-a5']));                               // spectateNextTable took him to TC
    s.leave('table:TA');
    s.join('table:TC');
    w.m.handleTableRebalance(w.tid);
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TA', 'TC']);   // TB broken into TA
    expect(w.playerSessions.has('S-a5')).toBe(false);                         // his busted seat was vacated
    return { w, s };
  }
  it('he keeps watching TC only — not pulled back to TA, not in TA\'s room', () => {
    const { w, s } = vacateWorld();
    expect(w.spectators.get('TC')?.has('S-a5')).toBe(true);
    expect(w.spectators.get('TA')?.has('S-a5') ?? false).toBe(false);
    expect([...s.rooms]).toEqual(['table:TC']);
  });
  it('CONTROL — the pre-round-5 vacate: he is ALSO made TA\'s spectator (two spectator views on one delta channel)', () => {
    const NEW = slice('    const vacatedSock = io.sockets.sockets.get(sid);\n', '      }\n    }\n', SRC.indexOf('function vacateBustedTournamentSeat('));
    expect(P.helpers).toContain(NEW);
    const OLD = '    if (io.sockets.sockets.get(sid)) {\n      if (!spectators.has(tableId)) spectators.set(tableId, new Set());\n      spectators.get(tableId)!.add(sid);\n    }\n';
    const { w } = vacateWorld({ helpers: P.helpers.replace(NEW, OLD) });
    expect(w.spectators.get('TC')?.has('S-a5')).toBe(true);
    expect(w.spectators.get('TA')?.has('S-a5')).toBe(true);
  });
});

describe('P-h / P-h\' — the end of a tournament reaches EVERY entrant (tournamentFinishedForEntrant outside the rooms); a Return after the end says so (tournamentFinished + position)', () => {
  function recIo() {
    const roomEmits: Array<[string, string, any]> = [];
    const io: any = { to: (room: string) => ({ emit: (ev: string, d: any) => roomEmits.push([room, ev, d]) }), emit() {}, sockets: { sockets: new Map() } };
    return { io, roomEmits };
  }
  /** T1 heads-up; b1 taps Back to Lobby (kept absent); his last opponent busts → b1 WINS while away (RVX D2). */
  function awayWinner(over: Partial<typeof P> = {}, config?: Record<string, unknown>) {
    const { io, roomEmits } = recIo();
    const w = world({ layout: { T1: field('b', 2, 5000, 200) }, over, config, scope: { ...persistenceScope(null), io } });
    io.sockets = { sockets: w.live };
    const s0 = w.seatLive('S-b0', 'T1', 0, 200, 'm-b0');
    const s1 = w.seatLive('S-b1', 'T1', 1, 201, 'm-b1');
    w.m.handlePlayerLeave(s1);
    s0.emitted.length = 0;
    s1.emitted.length = 0;
    w.tm.eliminatePlayer(w.tid, 'b0', 'b1');
    return { w, s0, s1, roomEmits };
  }

  it('P-h\' (round 6): the away winner\'s lobby socket gets its OWN event tournamentFinishedForEntrant {tournamentId, position 1, prize, tournamentName} — never a second tournamentFinished; the table room gets tournamentFinished as before; the seated socket only through the room', () => {
    const { w, s0, s1, roomEmits } = awayWinner({}, { prizePool: 1000 });
    const t = w.tm.getTournament(w.tid)!;
    expect(t.status).toBe('finished');
    expect(roomEmits.filter(([, ev]) => ev === 'tournamentFinished').map(([room]) => room)).toEqual(['table:T1']);
    expect(s1.emitted.filter(([ev]: [string]) => ev === 'tournamentFinished')).toEqual([]);
    expect(s1.emitted.filter(([ev]: [string]) => ev === 'tournamentFinishedForEntrant')).toEqual([
      ['tournamentFinishedForEntrant', { tournamentId: w.tid, position: 1, prize: 500, tournamentName: 'Rebalance Cup' }],
    ]);
    expect(s0.emitted.filter(([ev]: [string]) => ev === 'tournamentFinishedForEntrant' || ev === 'tournamentFinished')).toEqual([]);   // he is in the room
    expect(w.m.tournamentFinishedNotices).toEqual({ roomBroadcasts: 1, entrantSockets: 1 });
  });

  it('P-h\': an unpaid place carries no `prize`', () => {
    const { w, s1 } = awayWinner();
    expect(s1.emitted.find(([ev]: [string]) => ev === 'tournamentFinishedForEntrant')?.[1]).toEqual({ tournamentId: w.tid, position: 1, tournamentName: 'Rebalance Cup' });
  });

  it('CONTROL — round 4 (room only): the away winner is never told', () => {
    const CALL = '      emitTournamentFinishedToEntrants(tournamentId, tournamentManager.getTournament(tournamentId)?.tableIds || [], data);\n';
    expect(P.events).toContain(CALL);
    const { s1, roomEmits } = awayWinner({ events: P.events.replace(CALL, "      for (const tid of tournamentManager.getTournament(tournamentId)?.tableIds || []) io.to(`table:${tid}`).emit('tournamentFinished', data);\n") });
    expect(roomEmits.filter(([, ev]) => ev === 'tournamentFinished')).toHaveLength(1);
    expect(s1.emitted.filter(([ev]: [string]) => ev === 'tournamentFinished' || ev === 'tournamentFinishedForEntrant')).toEqual([]);
  });

  it('his Return after the end: no_tournament_seat + tournamentFinished:true + position 1 — also after TournamentManager dropped the tournament (kept by the server for the late tap)', async () => {
    const { w } = awayWinner();
    const sock = w.wireSocket('S-b1');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    (w.tm as any).tournaments.delete(w.tid);                                  // a template tournament is dropped 10s after its end
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    for (const a of acks) {
      expect(a).toEqual({
        success: false, code: 'no_tournament_seat', tournamentId: w.tid, tournamentFinished: true, position: 1,
        error: 'This tournament has finished — you placed 1st.',
      });
    }
    expect(sock.emitted.filter(([ev]: [string]) => ev === 'returnToTournamentResult').map(([, d]: [string, any]) => d.tournamentFinished)).toEqual([true, true]);
    expect(w.m.tournamentSeatKeep.returnAfterFinish).toBe(2);
    expect(w.m.finishedTournamentRecords.get(w.tid).entrants.map((e: any) => [e.playerId, e.position])).toEqual([['b0', 2], ['b1', 1]]);
  });

  it('a Return with NO tournamentId never guesses (plain no_tournament_seat)', async () => {
    const { w } = awayWinner();
    const sock = w.wireSocket('S-b1');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({}, (r: unknown) => acks.push(r));
    expect(acks).toEqual([{ success: false, code: 'no_tournament_seat', error: 'You have no seat waiting in a running tournament.' }]);
  });

  it('out of a RUNNING tournament (his away seat busted): eliminated:true + his position', async () => {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, scope: persistenceScope(null) });
    const TB = w.tables.get('TB')!;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(s);
    TB.seats[0].chipCount += TB.seats[2].chipCount;
    TB.seats[2].chipCount = 0;
    (TB as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    const pos = w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.finishPosition;
    const sock = w.wireSocket('S-b2');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks).toEqual([{ success: false, code: 'no_tournament_seat', tournamentId: w.tid, eliminated: true, position: pos, error: `You are out of this tournament — you finished ${pos}th.` }]);
  });
});

describe('P-c\'\' (round 6) — LATEST CONNECTION WINS: a Return takes the seat from another live socket of the SAME account; never "held elsewhere"', () => {
  /** b2 left TB (Back to Lobby, voluntary) on tab A (S-A); tab B (S-B) is signed in as him too. */
  function twoTabs(over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over });
    const a = w.seatLive('S-A', 'TB', 2, 202, 'm-b2');
    w.m.handlePlayerLeave(a);                                                  // tab A: Back to Lobby
    w.mkSocket('S-B');
    w.authSessions.set('S-B', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
    return { w, a: w.wireSocket('S-A'), b: w.wireSocket('S-B') };
  }
  const ret = async (w: ReturnType<typeof world>, sock: any) => {
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    return acks[0];
  };
  const TAKEN = (w: ReturnType<typeof world>) => ['tournamentSeatTakenOver', { tournamentId: w.tid, tableId: 'TB', seatIndex: 2 }];

  it('tab B returns, then tab A returns: A gets the seat; B\'s session ends, B leaves TB\'s room and is told tournamentSeatTakenOver; B again — ping-pong, the latest Return always wins; the stack never moves', async () => {
    const { w, a, b } = twoTabs();
    expect(await ret(w, b)).toEqual({ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 });
    b.emitted.length = 0;
    expect(await ret(w, a)).toEqual({ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 });
    expect(w.playerSessions.get('S-A')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.playerSessions.has('S-B')).toBe(false);
    expect(a.rooms.has('table:TB')).toBe(true);
    expect(b.rooms.has('table:TB')).toBe(false);
    expect(b.emitted).toEqual([TAKEN(w)]);                                    // and no further frame for TB
    a.emitted.length = 0;
    expect(await ret(w, b)).toMatchObject({ success: true, tableId: 'TB', seatIndex: 2 });
    expect(a.emitted).toEqual([TAKEN(w)]);
    expect(w.playerSessions.has('S-A')).toBe(false);
    expect(w.playerSessions.get('S-B')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.m.tournamentSeatKeep.returnTakeOvers).toBe(2);
    expect(w.tables.get('TB')!.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.socketId).toBe('S-B');
    expect(w.credits).toEqual([]);
    expect(SRC).not.toContain('seatHeldElsewhere');
  });

  it('a repeated / duplicated Return on the socket that already holds the seat is an idempotent success (a lost answer is simply re-sent) — nobody is told taken over', async () => {
    const { w, a, b } = twoTabs();
    const r1 = await ret(w, b);
    const r2 = await ret(w, b);
    expect(r1).toEqual({ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 });
    expect(r2).toEqual(r1);
    expect(w.m.tournamentSeatKeep).toMatchObject({ returnAlreadyThere: 1, returnTakeOvers: 0 });
    expect([...a.emitted, ...b.emitted].map(([ev]: [string]) => ev)).not.toContain('tournamentSeatTakenOver');
  });

  /**
   * pe5 X1: his Return on S1 was processed (the seat is bound to S1) but every
   * answer was lost in a network change; the server still counts S1 connected
   * (pingTimeout). The phone reconnects as S2 and taps Return again.
   */
  async function staleConnection(over: Partial<typeof P> = {}) {
    const { w, a } = twoTabs(over);
    expect(await ret(w, a)).toMatchObject({ success: true });                 // processed on S-A — its answer "lost"
    w.mkSocket('S-A2');
    w.authSessions.set('S-A2', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
    const a2 = w.wireSocket('S-A2');
    a.emitted.length = 0;
    return { w, a, a2, answer: await ret(w, a2) };
  }

  it('X1: his OWN stale connection still holds the seat — the new connection\'s Return takes it (success, never "held elsewhere"); the stale one is told tournamentSeatTakenOver and gets no more frames', async () => {
    const { w, a, answer } = await staleConnection();
    expect(answer).toEqual({ success: true, tournamentId: w.tid, tableId: 'TB', seatIndex: 2 });
    expect(w.playerSessions.get('S-A2')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.playerSessions.has('S-A')).toBe(false);
    expect(a.emitted).toEqual([TAKEN(w)]);
    expect(a.rooms.has('table:TB')).toBe(false);
  });

  it('CONTROL — round 5 (no takeover): the new connection is refused no_tournament_seat while the stale socket holds the seat (the X1 lock-out)', async () => {
    // Z4 (2026-10-10): the takeover flag is `takeOver` (a NAMED tournament) — off here.
    const R1 = "    const takeOver = wanted !== undefined;\n";
    const R2 = "    const restored = restoreAbsentTournamentSeat(socket, auth, 'returnToTournamentSeat', wanted, 'any', takeOver);\n";
    expect(P.returnToTournament).toContain(R1);
    expect(P.returnToTournament).toContain(R2);
    const { w, answer } = await staleConnection({
      returnToTournament: P.returnToTournament.replace(R1, '    const takeOver = false;\n'),
    });
    expect(answer).toMatchObject({ success: false, code: 'no_tournament_seat' });
    expect(w.playerSessions.get('S-A')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
  });

  it('a seat a live socket of ANOTHER account plays is never taken (no account mixing): plain no_tournament_seat, nothing moved', async () => {
    const { w, b } = twoTabs();
    w.mkSocket('S-X');
    w.authSessions.set('S-X', { userId: 999, username: 'x', masterUserId: 'm-x' });
    w.playerSessions.set('S-X', { socketId: 'S-X', tableId: 'TB', seatIndex: 2, playerName: 'b2', playerId: 'b2', sittingOut: false });
    expect(await ret(w, b)).toEqual({ success: false, code: 'no_tournament_seat', tournamentId: w.tid, error: 'You have no seat waiting in a running tournament.' });
    expect(w.playerSessions.get('S-X')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.playerSessions.has('S-B')).toBe(false);
  });

  it('a sign-in never takes a seat another live socket of his plays (only a Return does)', () => {
    const { w, a, b } = twoTabs();
    expect(w.m.restoreAbsentTournamentSeat(b, w.authSessions.get('S-B'), 'oauthLogin', w.tid, 'any')).toMatchObject({ tableId: 'TB' });
    expect(w.m.restoreAbsentTournamentSeat(a, w.authSessions.get('S-A'), 'oauthLogin', w.tid, 'any')).toBeNull();
    expect(w.playerSessions.get('S-B')).toMatchObject({ tableId: 'TB', seatIndex: 2 });
  });
});

describe('P-f gap / P-k — IP-ban and banUser disqualify his AWAY entries (never paid); a kick acts only on the table it targets', () => {
  /** b2 tapped Back to Lobby (kept absent, voluntary); his lobby socket S-b2 is live. The admin socket has the REAL handlers. */
  function awayBanWorld(over: Partial<typeof P> = {}, extraScope: Record<string, unknown> = {}) {
    const ref: { w?: ReturnType<typeof world> } = {};
    const pendingSeatRemovalAfterHand = new Map<string, Map<number, unknown>>();
    const w = world({
      layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over,
      scope: {
        pendingSeatRemovalAfterHand,
        isUserAdmin: async (uid: number) => uid === 1,
        revokeTokensOnSignOut: async () => 'revoked',
        socketsForUser: (uid: number) => [...ref.w!.authSessions].filter(([, a]) => a.userId === uid).map(([sid]) => sid),
        ...extraScope,
      },
    });
    ref.w = w;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    s.disconnect = () => { s.connected = false; w.live.delete('S-b2'); };
    w.m.handlePlayerLeave(s);
    w.mkSocket('S-admin');
    w.authSessions.set('S-admin', { userId: 1, username: 'the.admin' });
    const admin = w.wireSocket('S-admin');
    return { w, s, admin, TB: w.tables.get('TB')!, pendingSeatRemovalAfterHand };
  }
  /** A NEW socket signed in as b2 taps Return (RVX D3: oauthLogin is not ban-gated). */
  async function returnAgain(w: ReturnType<typeof world>) {
    w.mkSocket('S-b2x');
    w.authSessions.set('S-b2x', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
    const sock = w.wireSocket('S-b2x');
    const acks: any[] = [];
    await sock.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    return acks[0];
  }

  it('IP-ban: his away entry is disqualified (no prize, no eliminator), the seat stood up, its 5000 NEVER credited (audited), reservation + voluntary mark gone; a later Return finds no seat', async () => {
    const { w, admin, TB } = awayBanWorld();
    const before = w.chipsInPlay();
    await admin.handlers.adminIPBan({ userId: 202 });
    const b2 = w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!;
    expect(b2).toMatchObject({ eliminated: true, disqualified: true });
    expect(TB.seats[2].state).toBe('empty');
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(w.m.voluntarilyAbsentTournamentEntrants.size).toBe(0);
    expect(w.credits).toEqual([]);
    expect(w.chipsInPlay()).toBe(before - 5000);
    expect(w.audits).toContainEqual(expect.objectContaining({
      actor: 'the.admin', action: 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN',
      d: expect.objectContaining({ via: 'admin_ip_ban', away: true, playerId: 'b2', targetUserId: 202, disqualified: true, credited: 0 }),
    }));
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ amount: 5000, reason: 'admin_ip_ban_away_disqualified' }) }));
    expect(admin.emitted.find(([ev]: [string]) => ev === 'adminIPBanResult')?.[1]).toMatchObject({ success: true, awayTournamentEntriesDisqualified: 1 });
    expect(w.m.tournamentHandStartSafety).toMatchObject({ adminRemovalsDisqualified: 1, adminRemovalsAwayDisqualified: 1 });
    expect(await returnAgain(w)).toMatchObject({ success: false, code: 'no_tournament_seat', eliminated: true });
  });

  it('CONTROL — round 4 (only a seat a kicked SOCKET sat at): the away entry is untouched and he Returns to it (RVX D3)', async () => {
    const CALL = "      try { awayDisqualified = disqualifyAwayTournamentEntriesOnAdminRemoval(banAccount, 'admin_ip_ban', auth.username); } catch (e: any) {\n";
    expect(P.adminIPBan).toContain(CALL);
    const { w, admin, TB } = awayBanWorld({ adminIPBan: P.adminIPBan.replace(CALL, '      try { awayDisqualified = 0; } catch (e: any) {\n') });
    await admin.handlers.adminIPBan({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(await returnAgain(w)).toMatchObject({ success: true, tableId: 'TB', seatIndex: 2 });
  });

  it('P-k (round 6): a kick from the dashboard (no table named) acts only on his MAIN seat\'s table — he is away, so NOTHING is disqualified; his away seat stays in play; tokens still revoked (pe5 X4)', async () => {
    const { w, admin, TB } = awayBanWorld();
    await admin.handlers.adminKickPlayer({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(admin.emitted.find(([ev]: [string]) => ev === 'adminKickResult')?.[1]).toMatchObject({ success: true, tokensRevoked: true, awayTournamentEntriesDisqualified: 0 });
    expect(w.audits.filter((a) => a.action === 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN')).toEqual([]);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — round 5: the same dashboard kick disqualified EVERY away entry he held (a kick from a cash table or another tournament\'s seat too)', async () => {
    const ACCT = "    const kickAccount = typeof target === 'string' && Number.isInteger(targetUserId) && targetUserId > 0\n";
    const GATE = "    if (kickAccount && typeof target === 'string') {\n";
    expect(P.adminKick).toContain(ACCT);
    expect(P.adminKick).toContain(GATE);
    const { w, admin, TB } = awayBanWorld({
      adminKick: P.adminKick.replace(ACCT, "    const kickAccount = target !== null && Number.isInteger(targetUserId) && targetUserId > 0\n").replace(GATE, '    if (kickAccount) {\n'),
    });
    await admin.handlers.adminKickPlayer({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!).toMatchObject({ eliminated: true, disqualified: true });
    expect(TB.seats[2].state).toBe('empty');
  });

  it('P-k: a kick NAMING a cash table never disqualifies the tournament seat his socket plays — the seat is kept absent (unflagged), never stood up or credited', async () => {
    const ref: { w?: ReturnType<typeof world> } = {};
    const w = world({
      layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) },
      scope: {
        isUserAdmin: async (uid: number) => uid === 1, revokeTokensOnSignOut: async () => 'revoked',
        socketsForUser: (uid: number) => [...ref.w!.authSessions].filter(([, a]) => a.userId === uid).map(([sid]) => sid),
      },
    });
    ref.w = w;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    s.disconnect = () => { s.connected = false; w.live.delete('S-b2'); };
    w.mkSocket('S-admin');
    w.authSessions.set('S-admin', { userId: 1, username: 'the.admin' });
    const admin = w.wireSocket('S-admin');
    await admin.handlers.adminKickPlayer({ userId: 202, tableId: 'CASH-9' } as any);
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
    expect(w.tables.get('TB')!.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.reservedSeats.get(202)).toMatchObject({ tableId: 'TB', seatIndex: 2 });
    expect(w.reservedSeats.get(202).voluntary).toBeUndefined();
    expect(s.connected).toBe(false);
    expect(w.credits).toEqual([]);
  });

  it('P-k: banUser disqualifies EVERY away entry (audited admin_ban, never credited) and THEN writes the ban; his Return afterwards is refused player_suspended', async () => {
    const banned = new Set<number>();
    const { w, admin, TB } = awayBanWorld({}, {
      banUserDB: async (uid: number) => { banned.add(uid); return true; },
      isUserBanned: async (uid: number) => banned.has(uid),
    });
    const before = w.chipsInPlay();
    await admin.handlers.banUser({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!).toMatchObject({ eliminated: true, disqualified: true });
    expect(TB.seats[2].state).toBe('empty');
    expect(w.reservedSeats.has(202)).toBe(false);
    expect(w.credits).toEqual([]);
    expect(w.chipsInPlay()).toBe(before - 5000);
    expect(banned.has(202)).toBe(true);
    expect(w.audits).toContainEqual(expect.objectContaining({
      actor: 'the.admin', action: 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN',
      d: expect.objectContaining({ via: 'admin_ban', away: true, playerId: 'b2', disqualified: true, credited: 0 }),
    }));
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ amount: 5000, reason: 'admin_ban_away_disqualified' }) }));
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'BAN_USER', d: { targetUserId: 202, seatedTournamentEntriesDisqualified: 0, awayTournamentEntriesDisqualified: 1 } }));
    expect(admin.emitted).toContainEqual(['userBanned', { userId: 202 }]);
    expect(await returnAgain(w)).toMatchObject({ success: false, code: 'player_suspended' });
  });

  it('CONTROL — the pre-P-k banUser (the DB flag only, no ban check on Return): his away entry stays in play and he Returns to it', async () => {
    const CALL = "      try { awayDisqualified = disqualifyAwayTournamentEntriesOnAdminRemoval(banAccount, 'admin_ban', auth.username); } catch (e: any) {\n";
    expect(P.banUser).toContain(CALL);
    const { w, admin, TB } = awayBanWorld({ banUser: P.banUser.replace(CALL, '      try { awayDisqualified = 0; } catch (e: any) {\n') }, {
      banUserDB: async () => true, isUserBanned: async () => false,
    });
    await admin.handlers.banUser({ userId: 202 });
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(await returnAgain(w)).toMatchObject({ success: true, tableId: 'TB', seatIndex: 2 });
  });

  it('kick naming a CASH table: his away tournament entry is left alone (the tournament of the table he was kicked from — none)', async () => {
    const { w, admin, TB } = awayBanWorld();
    await admin.handlers.adminKickPlayer({ userId: 202, tableId: 'CASH-9' } as any);
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
    expect(TB.seats[2].state).toBe('occupied');
    await admin.handlers.adminKickPlayer({ userId: 202, tableId: 'TB' } as any);   // naming his tournament's table
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(true);
  });

  it('away with chips in a LIVE pot: disqualified at once, his seat folded and left for the hand\'s end (no pot erased, stood up by the after-hand removal, which never credits a tournament table)', async () => {
    const { w, admin, TB, pendingSeatRemovalAfterHand } = awayBanWorld();
    // b2 is back on another socket, calls into a hand, then that socket drops (absent, chips in the pot).
    w.reservedSeats.delete(202);
    w.m.voluntarilyAbsentTournamentEntrants.clear();
    expect(TB.startNewHand()).toBe(true);
    for (let g = 0; g < 10 && TB.activeSeatIndex !== 2; g++) { const a = TB.activeSeatIndex; if (!TB.playerCall(a)) TB.playerCheck(a); }
    TB.playerCall(2);
    expect(TB.seats[2].totalInvestedThisHand).toBeGreaterThan(0);
    const total = w.chipsInPlay();
    await admin.handlers.adminIPBan({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.disqualified).toBe(true);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', folded: true });
    expect(w.chipsInPlay()).toBe(total);
    expect(w.credits).toEqual([]);
    expect([...pendingSeatRemovalAfterHand.get('TB')!.keys()]).toEqual([2]);
  });

  it('wiring: both admin handlers read the account BEFORE dropping his sockets and disqualify the away entries AFTER', () => {
    for (const [ev, via] of [['adminKickPlayer', 'admin_kick'], ['adminIPBan', 'admin_ip_ban']] as const) {
      const body = handlerSrc(ev, '\n  });\n');
      const acct = body.indexOf('await adminRemovalTargetAccount(targetUserId, socketsForUser(targetUserId))');
      const drop = body.indexOf('s.disconnect(true)');
      const dq = body.indexOf(`disqualifyAwayTournamentEntriesOnAdminRemoval(${ev === 'adminKickPlayer' ? 'kickAccount' : 'banAccount'}, '${via}', auth.username`);
      expect({ ev, order: acct > -1 && acct < drop && drop < dq }).toEqual({ ev, order: true });
    }
    // P-k (round 6): banUser reads the account, disqualifies every away entry, THEN writes the ban; the kick only a NAMED tournament's.
    const ban = handlerSrc('banUser', '\n  });\n');
    const bAcct = ban.indexOf('await adminRemovalTargetAccount(banTargetId, socketsForUser(banTargetId))');
    const bDq = ban.indexOf("disqualifyAwayTournamentEntriesOnAdminRemoval(banAccount, 'admin_ban', auth.username)");
    const bWrite = ban.indexOf('await banUserDB(data.userId);');
    expect({ order: bAcct > -1 && bAcct < bDq && bDq < bWrite }).toEqual({ order: true });
    expect(handlerSrc('adminKickPlayer', '\n  });\n')).toContain("disqualifyAwayTournamentEntriesOnAdminRemoval(kickAccount, 'admin_kick', auth.username, target)");
  });
});

describe('round 5 (pe4 nit, RVX D1) — a leave whose own fold ends the hand and synchronously breaks the table tells the leaving socket the FINAL seat only', () => {
  /** TB: b0 (250, all-in), b1, b2 — b2 the only live session; b2 leaves on his turn after b1 called: his fold ends the hand, b0 busts, TB (2 alive) is broken into TA. */
  function leaveBreaks(over: Partial<typeof P> = {}) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const w = world({
        layout: { TA: field('a', 6, 5000, 100), TB: [
          { pid: 'b0', name: 'b0', stack: 250, uid: 200, master: 'm-b0' },
          { pid: 'b1', name: 'b1', stack: 5000, uid: 201, master: 'm-b1' },
          { pid: 'b2', name: 'b2', stack: 5000, uid: 202, master: 'm-b2' },
        ] },
        over, scope: persistenceScope(null),
      });
      const TB = w.tables.get('TB')!;
      TB.on('handResult', (d: any) => { void w.m.handleHandComplete('TB', d.results); });
      const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
      if (!TB.startNewHand()) continue;
      let left = false;
      for (let g = 0; g < 40 && TB.isHandInProgress() && !left; g++) {
        const a = TB.activeSeatIndex;
        if (a < 0) break;
        const st = TB.seats;
        if (a === 0) { if (!TB.playerAllIn(0)) TB.playerCall(0); continue; }
        if (a === 1) { if (!TB.playerCall(1)) TB.playerCheck(1); continue; }
        const toMatch = (TB as any).currentBetToMatch;
        if (st[0].allIn && st[1].currentBet === toMatch && (st[1] as any).lastAction !== 'none') {
          s.emitted.length = 0;
          w.m.handlePlayerLeave(s);
          left = true;
        } else if (!TB.playerCall(2)) TB.playerCheck(2);
      }
      if (!left) continue;
      const t = w.tm.getTournament(w.tid)!;
      if (!t.players.find((p) => p.playerId === 'b0')!.eliminated || t.tableIds.includes('TB')) continue;
      const seatOnTA = w.tables.get('TA')!.seats.findIndex((x) => x.state === 'occupied' && x.playerId === 'b2' && !x.eliminated);
      return { w, s, seatOnTA };
    }
    throw new Error('no deal produced the synchronous break in 80 attempts');
  }

  it('exactly ONE tournamentSeatKept, carrying the NEW seat on TA (where the reservation moved too)', () => {
    const { w, s, seatOnTA } = leaveBreaks();
    expect(seatOnTA).toBeGreaterThan(-1);
    expect(s.emitted.filter(([ev]: [string]) => ev === 'tournamentSeatKept').map(([, d]: [string, any]) => [d.tableId, d.seatIndex])).toEqual([['TA', seatOnTA]]);
    expect(w.reservedSeats.get(202)).toMatchObject({ tableId: 'TA', seatIndex: seatOnTA, voluntary: true });
  });

  it('CONTROL — round 4 (V4 told this socket during the keep; the keep then told the OLD seat): NEW then OLD (broken TB) — the stale one last', () => {
    const SKIP = '    if (keepingTournamentSeatOnLeave.has(sid)) continue;\n';
    const FINAL = 'socket.emit(\'tournamentSeatKept\', tournamentSeatKeptPayload(tournamentId, now.tableId, now.seatIndex, now.seat));';
    expect(P.seatKeep).toContain(SKIP);
    expect(P.seatKeep).toContain(FINAL);
    const { s, seatOnTA } = leaveBreaks({
      seatKeep: P.seatKeep.replace(SKIP, '').replace(FINAL, 'socket.emit(\'tournamentSeatKept\', tournamentSeatKeptPayload(tournamentId, session.tableId, session.seatIndex, seat));'),
    });
    expect(s.emitted.filter(([ev]: [string]) => ev === 'tournamentSeatKept').map(([, d]: [string, any]) => [d.tableId, d.seatIndex])).toEqual([['TA', seatOnTA], ['TB', 2]]);
  });
});

describe('P-l (round 6) — the hand-complete DB writes run SERIALLY again (round 5\'s parallel writes reverted: pool max 10, db-f1-micro); the bust check still follows all of them', () => {
  function twoWriters(over: Partial<typeof P> = {}) {
    const started: number[] = [];
    const holds = new Map<number, { p: Promise<void>; resolve: () => void }>([[201, deferred()], [202, deferred()]]);
    const w = world({
      layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over,
      scope: { ...persistenceScope(null), mergeUserStats: async (uid: number) => { started.push(uid); await holds.get(uid)?.p; } },
    });
    w.seatLive('S-b1', 'TB', 1, 201, 'm-b1');
    w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    const TB = w.tables.get('TB')!;
    TB.seats[0].chipCount += TB.seats[3].chipCount;
    TB.seats[3].chipCount = 0;                                                 // b3 busted this hand
    (TB as any).currentPhase = GamePhase.HandComplete;
    const b3Out = () => w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b3')!.eliminated;
    return { w, started, holds, b3Out };
  }

  it('one player at a time: the second player\'s write starts only after the first resolves; the check (and so the next deal — V1 a) waits for both; b3 eliminated only after both', async () => {
    const { w, started, holds, b3Out } = twoWriters();
    const done = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    await flush();
    expect(started).toEqual([201]);                                           // serial: one connection at a time
    expect(b3Out()).toBe(false);
    expect(w.m.tournamentBustChecksPending.get('TB')?.size).toBe(1);          // the deal still waits (V1 a)
    holds.get(201)!.resolve();
    await flush();
    expect(started).toEqual([201, 202]);
    expect(b3Out()).toBe(false);                                              // 202 still writing
    holds.get(202)!.resolve();
    await done;
    expect(b3Out()).toBe(true);
    expect(w.m.tournamentBustChecksPending.has('TB')).toBe(false);
  });

  it('CONTROL — writes that do not wait for each other (round 5\'s shape: one pool connection per player at once) start together', async () => {
    const AWAIT = '            await mergeUserStats(authSession.userId, {';
    expect(P.handComplete).toContain(AWAIT);
    const { w, started, holds } = twoWriters({ handComplete: P.handComplete.replace(AWAIT, '            void mergeUserStats(authSession.userId, {') });
    const done = w.m.handleHandComplete('TB', [{ seatIndex: 0, amount: 5000 }]);
    await flush();
    expect(started.sort()).toEqual([201, 202]);
    holds.get(201)!.resolve();
    holds.get(202)!.resolve();
    await done;
  });

  it('wiring: no parallel fan-out is left in handleHandComplete', () => {
    expect(P.handComplete).not.toContain('persistOne');
    expect(P.handComplete).not.toContain('Promise.all(persisting)');
    expect(P.handComplete).toContain('for (const [socketId, session] of playerSessions) {');
  });
});

// ===================== 2026-10-10 fourteenth pass (pe6 review, owner "fix all") — Z1 / Z2 / Z4 / Z5 =====================

describe('Z1 — a disconnect acts on its seat only while the seat is still its own AFTER the save await (pe6 RV6_F5)', () => {
  const GUARD = '          if (currentSession !== session || !seatStillHis || playedElsewhere) {\n';
  /**
   * Heads-up T1: b0 live on S-b0, b1 live on S1. S1 drops when it is NOT his
   * turn; its saveProgress is HELD. With `returnInWindow` his new socket S2
   * taps Return meanwhile. Then b0 acts, so it is b1's turn, and the save is
   * released.
   */
  async function dropDuringSave(returnInWindow: boolean, over: Partial<typeof P> = {}) {
    const hold = deferred();
    let holdSave = true;
    const saved: number[] = [];
    const scope = { ...persistenceScope(null), saveProgress: async (uid: number) => { saved.push(uid); if (holdSave) await hold.p; return true; } };
    const w = world({ layout: { T1: field('b', 2, 5000, 200) }, scope, over });
    const T1 = w.tables.get('T1')!;
    w.seatLive('S-b0', 'T1', 0, 200, 'm-b0');
    w.seatLive('S1', 'T1', 1, 201, 'm-b1');
    w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b1')!.socketId = 'S1';
    const s1 = w.wireSocket('S1');
    expect(T1.startNewHand()).toBe(true);
    if (T1.activeSeatIndex === 1) { if (!T1.playerCall(1)) T1.playerCheck(1); }
    expect(T1.activeSeatIndex).toBe(0);
    // socket.io 4.x: out of the namespace and connected=false BEFORE 'disconnect' fires.
    s1.connected = false;
    w.live.delete('S1');
    const disc = s1.handlers.disconnect();
    await flush();
    expect(saved).toEqual([201]);                                             // inside its save await
    const acks: any[] = [];
    if (returnInWindow) {
      const s2 = w.wireSocket('S2');
      w.authSessions.set('S2', { userId: 201, username: 'u201', masterUserId: 'm-b1' });
      await s2.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
      await flush();
    }
    if (!T1.playerCall(0)) T1.playerCheck(0);                                  // b0 acts: b1's turn now
    expect(T1.activeSeatIndex).toBe(1);
    const at = { hand: T1.handNumber, phase: T1.currentPhase };
    const before = w.chipsInPlay();
    holdSave = false;
    hold.resolve();
    await disc;
    await flush();
    const r = w.reservedSeats.get(201);
    const s2s = w.playerSessions.get('S2');
    return {
      w, T1, ack: acks[0],
      s2Session: s2s ? { tableId: s2s.tableId, seatIndex: s2s.seatIndex } : null,
      stillHisTurn: T1.handNumber === at.hand && T1.currentPhase === at.phase && T1.activeSeatIndex === 1,
      reservation: r ? { tableId: r.tableId, seatIndex: r.seatIndex, handsRemaining: r.handsRemaining } : null,
      s1Left: !w.authSessions.has('S1') && !w.playerSessions.has('S1'),
      chipsKept: w.chipsInPlay() === before,
    };
  }

  it('his new socket Returns during the save await: the seat is NOT re-reserved and NOT acted for — still his turn, played by S2; S1\'s auth ends; logged', async () => {
    const x = await dropDuringSave(true);
    expect(x.ack).toMatchObject({ success: true, tableId: 'T1', seatIndex: 1 });
    expect(x.s2Session).toEqual({ tableId: 'T1', seatIndex: 1 });
    expect(x.stillHisTurn).toBe(true);
    expect(x.T1.seats[1].folded).toBe(false);
    expect(x.reservation).toBeNull();
    expect(x.s1Left).toBe(true);
    expect(x.chipsKept).toBe(true);
    expect(x.w.credits).toEqual([]);
    expect(x.w.logs.some((l) => l.includes('disconnect_session_replaced_during_save'))).toBe(true);
  });

  it('CONTROL — pre-Z1 (no re-check after the await): the seat S2 now plays is re-reserved and the server acts for it on its turn', async () => {
    expect(P.disconnect).toContain(GUARD);
    const x = await dropDuringSave(true, { disconnect: P.disconnect.replace(GUARD, '          if (false) {\n') });
    expect(x.s2Session).toEqual({ tableId: 'T1', seatIndex: 1 });
    expect(x.reservation).toEqual({ tableId: 'T1', seatIndex: 1, handsRemaining: 20 });
    expect(x.stillHisTurn).toBe(false);
  });

  it('no Return in the window: the plain disconnect reserves the seat exactly as before (S1 session + auth end)', async () => {
    const x = await dropDuringSave(false);
    expect(x.reservation).toEqual({ tableId: 'T1', seatIndex: 1, handsRemaining: 20 });
    expect(x.s1Left).toBe(true);
    expect(x.stillHisTurn).toBe(false);                                       // acted for on his turn (Z6: a free check)
    expect(x.T1.seats[1].folded).toBe(false);
    expect(x.chipsKept).toBe(true);
    expect(x.w.logs.some((l) => l.includes('disconnect_session_replaced_during_save'))).toBe(false);
  });
});

describe('Z2 — the FINAL bust tells the runner-up HIS place (2nd), never the winner\'s 1st (pe6 RV6_F2)', () => {
  const BUST_POS = 'const bustPosition = bustTp && bustTp.eliminated && bustTp.finishPosition > 0\n        ? bustTp.finishPosition : (result ? result.position : 0);';
  function recExceptIo(ref: { w?: ReturnType<typeof world> }) {
    const roomEmits: Array<{ room: string; ev: string; except: string[]; d: any }> = [];
    const io: any = {
      to: (room: string) => {
        const op: any = { ex: [] as string[] };
        op.except = (ids: string | string[]) => { op.ex = [...op.ex, ...(Array.isArray(ids) ? ids : [ids])]; return op; };
        op.emit = (ev: string, d: any) => roomEmits.push({ room, ev, except: op.ex, d });
        return op;
      },
      emit() {},
      sockets: { get sockets() { return ref.w!.live; } },
    };
    return { io, roomEmits };
  }
  /** Heads-up final: b1's stack busts, b0 wins. 'lobby' / 'watching': b1 tapped Back to Lobby (watching T1 or not); 'played': S-b1 plays the seat. */
  async function finalBust(mode: 'lobby' | 'watching' | 'played', over: Partial<typeof P> = {}) {
    const ref: { w?: ReturnType<typeof world> } = {};
    const x = recExceptIo(ref);
    const w = world({ layout: { T1: field('b', 2, 5000, 200) }, over, scope: { ...persistenceScope(null), io: x.io }, config: { prizePool: 1000 } });
    ref.w = w;
    const T1 = w.tables.get('T1')!;
    w.seatLive('S-b0', 'T1', 0, 200, 'm-b0');
    const s1 = w.seatLive('S-b1', 'T1', 1, 201, 'm-b1');
    w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b1')!.socketId = 'S-b1';
    if (mode !== 'played') w.m.handlePlayerLeave(s1);
    if (mode === 'watching') { w.spectators.set('T1', new Set(['S-b1'])); s1.join('table:T1'); }
    s1.emitted.length = 0;
    T1.seats[0].chipCount += T1.seats[1].chipCount;
    T1.seats[1].chipCount = 0;
    (T1 as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('T1', [{ seatIndex: 0, amount: 5000 }]);
    const t = w.tm.getTournament(w.tid)!;
    return {
      status: t.status,
      place: t.players.find((p) => p.playerId === 'b1')!.finishPosition,
      told: s1.emitted
        .filter(([ev]: [string]) => ['playerEliminated', 'eliminatedToSpectator', 'tournamentFinishedForEntrant'].includes(ev))
        .map(([ev, d]: [string, any]) => [ev, d.position]),
      roomCopies: x.roomEmits.filter((e) => e.ev === 'playerEliminated' && e.d.playerId === 'b1' && s1.rooms.has(e.room) && !e.except.includes('S-b1')).map((e) => e.d.position),
    };
  }

  it('away in the lobby: his finished notice AND his elimination notice both say 2nd', async () => {
    const r = await finalBust('lobby');
    expect(r).toEqual({ status: 'finished', place: 2, told: [['tournamentFinishedForEntrant', 2], ['playerEliminated', 2]], roomCopies: [] });
  });

  it('away, watching his own table: ONE notice (the direct one), 2nd', async () => {
    const r = await finalBust('watching');
    expect(r).toEqual({ status: 'finished', place: 2, told: [['playerEliminated', 2]], roomCopies: [] });
  });

  it('the socket that PLAYED the seat: eliminatedToSpectator says 2nd too (the room copy, unchanged, also 2nd)', async () => {
    const r = await finalBust('played');
    expect(r).toEqual({ status: 'finished', place: 2, told: [['eliminatedToSpectator', 2]], roomCopies: [2] });
  });

  it('a bust that does NOT finish the tournament: unchanged (his place)', async () => {
    const w = world({ layout: { T1: field('b', 3, 5000, 200) }, scope: persistenceScope(null) });
    const T1 = w.tables.get('T1')!;
    w.seatLive('S-b0', 'T1', 0, 200, 'm-b0');
    const s2 = w.seatLive('S-b2', 'T1', 2, 202, 'm-b2');
    w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.socketId = 'S-b2';
    w.m.handlePlayerLeave(s2);
    s2.emitted.length = 0;
    T1.seats[0].chipCount += T1.seats[2].chipCount;
    T1.seats[2].chipCount = 0;
    (T1 as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('T1', [{ seatIndex: 0, amount: 5000 }]);
    expect(w.tm.getTournament(w.tid)!.status).toBe('running');
    expect(s2.emitted.filter(([ev]: [string]) => ev === 'playerEliminated').map(([, d]: [string, any]) => d.position)).toEqual([3]);
  });

  it('CONTROL — pre-Z2 (eliminatePlayer\'s result.position): the runner-up is told 1st — the WINNER\'s place', async () => {
    expect(P.helpers).toContain(BUST_POS);
    const over = { helpers: P.helpers.replace(BUST_POS, 'const bustPosition = result ? result.position : 0;') };
    expect((await finalBust('lobby', over)).told).toEqual([['tournamentFinishedForEntrant', 2], ['playerEliminated', 1]]);
    expect((await finalBust('played', over)).told).toEqual([['eliminatedToSpectator', 1]]);
  });
});

describe('Z4 — a Return WITHOUT tournamentId restores an ABSENT seat only; the P-c\'\' takeover needs a NAMED tournament (pe6 RV6_F3)', () => {
  const TAKE = '    const takeOver = wanted !== undefined;\n';
  /** Tab 1 PLAYS his tournament-A seat (TA) live; with `awayAtTX` his tournament-B seat (TX) is away. Tab 2 (same account) taps Return with `payload`. */
  async function twoTournaments(payload: (tidA: string, tidB: string | null) => unknown, awayAtTX: boolean, over: Partial<typeof P> = {}) {
    const w = world({ layout: { TA: field('a', 2, 5000, 100) }, scope: persistenceScope(null), over });
    let tid2: string | null = null;
    if (awayAtTX) {
      tid2 = w.tm.createTournament({ name: 'Second Cup', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 100, bb: 200, ante: 0, duration: 600 }] } as any);
      w.tm.registerPlayer(tid2, 'x-me', 'a1', 'reg-x-me', 101);
      w.tm.registerPlayer(tid2, 'x-other', 'other', 'reg-x-other', 999);
      expect(w.tm.startTournament(tid2)).toBeTruthy();
      w.tm.setTableIds(tid2, ['TX']);
      const tx = new PokerTable({ tableId: 'TX', tableName: 'TX', smallBlind: 100, bigBlind: 200, minBuyIn: 5000, maxBuyIn: 50000, maxPlayers: 9 } as any);
      expect(tx.sitDown(0, 'a1', 5000, 'x-me', false, true)).toBe(true);
      expect(tx.sitDown(1, 'other', 5000, 'x-other', false, true)).toBe(true);
      w.tm.setPlayerTable(tid2, 'x-me', 'TX'); w.tm.setPlayerTable(tid2, 'x-other', 'TX');
      w.tables.set('TX', tx); w.tournamentTables.set('TX', tid2);
    }
    const tab1 = w.seatLive('S-tab1', 'TA', 1, 101, 'm-a1');
    const tab2 = w.wireSocket('S-tab2');
    w.authSessions.set('S-tab2', { userId: 101, username: 'u101', masterUserId: 'm-a1' });
    const acks: any[] = [];
    await tab2.handlers.returnToTournamentSeat(payload(w.tid, tid2), (r: unknown) => acks.push(r));
    await flush();
    return {
      ack: acks[0],
      tab1Plays: w.playerSessions.get('S-tab1')?.tableId ?? null,
      tab1Told: tab1.emitted.map(([ev]: [string]) => ev),
      tab2Plays: w.playerSessions.get('S-tab2')?.tableId ?? null,
      takeOvers: w.m.tournamentSeatKeep.returnTakeOvers,
    };
  }

  it('no tournamentId, an away seat at TX and a live one at TA (tab 1): he is put back on TX — tab 1 keeps playing TA, untouched', async () => {
    const r = await twoTournaments(() => ({}), true);
    expect(r.ack).toMatchObject({ success: true, tableId: 'TX', seatIndex: 0 });
    expect(r).toMatchObject({ tab1Plays: 'TA', tab1Told: [], tab2Plays: 'TX', takeOvers: 0 });
  });

  it('no tournamentId and NO away seat (his only seat is played by tab 1): no_tournament_seat — nothing guessed, tab 1 untouched', async () => {
    const r = await twoTournaments(() => ({}), false);
    expect(r.ack).toEqual({ success: false, code: 'no_tournament_seat', error: 'You have no seat waiting in a running tournament.' });
    expect(r).toMatchObject({ tab1Plays: 'TA', tab1Told: [], tab2Plays: null, takeOvers: 0 });
  });

  it('a NAMED tournament is unchanged (P-c\'\' latest connection wins): naming TA\'s tournament takes the seat from tab 1, which is told', async () => {
    const r = await twoTournaments((tidA) => ({ tournamentId: tidA }), true);
    expect(r.ack).toMatchObject({ success: true, tableId: 'TA', seatIndex: 1 });
    expect(r).toMatchObject({ tab1Plays: null, tab1Told: ['tournamentSeatTakenOver'], tab2Plays: 'TA', takeOvers: 1 });
  });

  it('CONTROL — round 6 (takeover with no tournamentId): tab 2 takes tab 1\'s LIVE TA seat while his TX seat stays away', async () => {
    expect(P.returnToTournament).toContain(TAKE);
    const over = { returnToTournament: P.returnToTournament.replace(TAKE, '    const takeOver = true;\n') };
    const r = await twoTournaments(() => ({}), true, over);
    expect(r).toMatchObject({ tab1Plays: null, tab1Told: ['tournamentSeatTakenOver'], tab2Plays: 'TA', takeOvers: 1 });
  });
});

describe('Z5 — banUser on an entrant whose live socket PLAYS his tournament seat disqualifies that entry too (as IP-ban does): audited, never credited, never paid', () => {
  const SEATED = "        try { if (leaveTournamentSeatOnAdminRemoval(s, 'admin_ban', auth.username, undefined, true)) seatedDisqualified++; } catch (e: any) {\n";
  /** b2 plays TB seat 2 on his live socket S-b2; with `withCashSeat` his second socket S-c sits at a CASH table. The admin socket has the REAL handler. */
  function seatedBanWorld(over: Partial<typeof P> = {}, withCashSeat = false) {
    const ref: { w?: ReturnType<typeof world> } = {};
    const banned = new Set<number>();
    const w = world({
      layout: { TA: field('a', 6, 5000, 100), TB: field('b', 5, 5000, 200) }, over,
      scope: {
        isUserAdmin: async (uid: number) => uid === 1,
        socketsForUser: (uid: number) => [...ref.w!.authSessions].filter(([, a]) => a.userId === uid).map(([sid]) => sid),
        banUserDB: async (uid: number) => { banned.add(uid); return true; },
        isUserBanned: async (uid: number) => banned.has(uid),
      },
    });
    ref.w = w;
    const s = w.seatLive('S-b2', 'TB', 2, 202, 'm-b2');
    let cash: PokerTable | null = null;
    if (withCashSeat) {
      cash = new PokerTable({ tableId: 'CASH-1', tableName: 'CASH-1', smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000, maxPlayers: 9 } as any);
      expect(cash.sitDown(0, 'b2', 3000, 'user_202', false, true)).toBe(true);
      expect(cash.sitDown(1, 'zed', 3000, 'user_900', false, true)).toBe(true);
      w.tables.set('CASH-1', cash);
      w.mkSocket('S-c');
      w.authSessions.set('S-c', { userId: 202, username: 'u202', masterUserId: 'm-b2' });
      w.playerSessions.set('S-c', { socketId: 'S-c', tableId: 'CASH-1', seatIndex: 0, playerName: 'b2', playerId: 'user_202', sittingOut: false });
    }
    w.mkSocket('S-admin');
    w.authSessions.set('S-admin', { userId: 1, username: 'the.admin' });
    const admin = w.wireSocket('S-admin');
    return { w, s, admin, TB: w.tables.get('TB')!, banned, cash };
  }

  it('his seat is disqualified (no prize), stood up, its 5000 NEVER credited (audited); BAN_USER counts it; his socket is not kicked; a later Return is refused', async () => {
    const { w, s, admin, TB, banned } = seatedBanWorld();
    const before = w.chipsInPlay();
    await admin.handlers.banUser({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!).toMatchObject({ eliminated: true, disqualified: true });
    expect(TB.seats[2].state).toBe('empty');
    expect(w.playerSessions.has('S-b2')).toBe(false);
    expect(w.credits).toEqual([]);
    expect(w.chipsInPlay()).toBe(before - 5000);
    expect(w.audits).toContainEqual(expect.objectContaining({
      actor: 'the.admin', action: 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN',
      d: expect.objectContaining({ via: 'admin_ban', playerId: 'b2', targetUserId: 202, disqualified: true, credited: 0 }),
    }));
    expect(w.audits.find((a) => a.action === 'TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN')!.d.away).toBeUndefined();
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ userId: 202, amount: 5000 }) }));
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'BAN_USER', d: { targetUserId: 202, seatedTournamentEntriesDisqualified: 1, awayTournamentEntriesDisqualified: 0 } }));
    expect(w.m.tournamentHandStartSafety).toMatchObject({ adminRemovalsDisqualified: 1, adminRemovalsAwayDisqualified: 0 });
    expect(banned.has(202)).toBe(true);
    expect(s.connected).toBe(true);
    expect(s.emitted.map(([ev]: [string]) => ev)).not.toContain('kickedByAdmin');
    const acks: any[] = [];
    await w.wireSocket('S-b2').handlers.returnToTournamentSeat({ tournamentId: w.tid }, (r: unknown) => acks.push(r));
    expect(acks[0]).toMatchObject({ success: false, code: 'player_suspended' });
  });

  it('CONTROL — round 6 (away entries only): his played seat is untouched; once he leaves it the seat is kept in play and he is never disqualified — he can still finish in the money', async () => {
    expect(P.banUser).toContain(SEATED);
    const { w, s, admin, TB } = seatedBanWorld({ banUser: P.banUser.replace(SEATED, '        try { void s; } catch (e: any) {\n') });
    await admin.handlers.banUser({ userId: 202 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.eliminated).toBe(false);
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    w.m.handlePlayerLeave(s);                                                 // Back to Lobby: kept absent, in play
    expect(TB.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b2')!.disqualified).toBeUndefined();
  });

  it('only a LIVE tournament seat: his CASH seat on another socket is left exactly as it was (never stood up, never credited; banUser never kicks)', async () => {
    const { w, admin, TB, cash } = seatedBanWorld({}, true);
    await admin.handlers.banUser({ userId: 202 });
    expect(TB.seats[2].state).toBe('empty');                                  // the tournament seat: disqualified
    expect(cash!.seats[0]).toMatchObject({ state: 'occupied', chipCount: 3000 });
    expect(w.playerSessions.get('S-c')).toMatchObject({ tableId: 'CASH-1', seatIndex: 0 });
    expect(w.credits).toEqual([]);
    expect(w.audits).toContainEqual(expect.objectContaining({ action: 'BAN_USER', d: expect.objectContaining({ seatedTournamentEntriesDisqualified: 1 }) }));
  });

  it('wiring: banUser reads the account, then disqualifies the seats his sockets play, then the away entries, THEN writes the ban', () => {
    const ban = handlerSrc('banUser', '\n  });\n');
    const acct = ban.indexOf('await adminRemovalTargetAccount(banTargetId, socketsForUser(banTargetId))');
    const seated = ban.indexOf("leaveTournamentSeatOnAdminRemoval(s, 'admin_ban', auth.username, undefined, true)");
    const away = ban.indexOf("disqualifyAwayTournamentEntriesOnAdminRemoval(banAccount, 'admin_ban', auth.username)");
    const write = ban.indexOf('await banUserDB(data.userId);');
    expect({ order: acct > -1 && acct < seated && seated < away && away < write }).toEqual({ order: true });
    expect(ban).not.toContain('s.disconnect(');
  });
});

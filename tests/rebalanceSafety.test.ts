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
import { SRC, slice, fnSrc, load, flush, deferred } from './helpers/indexSource';

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
  handlePlayerLeave: fnSrc('function handlePlayerLeave(socket: Socket): void {'),
  creditSeat: fnSrc('function creditSeatStackToWallet('),
  helpers: slice('// ===== Tournament rebalance helpers', '// ===== end tournament rebalance helpers =====\n'),
  rebalance: fnSrc('function handleTableRebalance(tournamentId: string): void {'),
  autoStart: fnSrc('function autoStartNextHand(tableId: string): void {'),
  handComplete: fnSrc('async function handleHandComplete('),
  events: slice('  tournamentManager.onEvent(tournamentId, (event, data) => {', '\n  });\n', SRC.indexOf('function bootstrapTournamentTables(')),
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
/** Q1 — the pre-Q1 bust-check lookup: tournamentTables alone. */
const BUST_LOOKUP = 'const tournamentId = tournamentTables.get(tableId) ?? brokenTournamentTables.get(tableId)?.tournamentId;';
function withLiveOnlyBustLookup(handComplete: string): string {
  expect(handComplete).toContain(BUST_LOOKUP);
  return handComplete.replace(BUST_LOOKUP, 'const tournamentId = tournamentTables.get(tableId);');
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
${p.handlePlayerLeave}
${p.creditSeat}
${p.helpers}
${p.rebalance}
${p.autoStart}
${p.handComplete}
function registerEvents(tournamentId) {
${p.events}
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
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: live } },
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
  return {
    m, stubbed, tm, tid, tables, tournamentTables, reservedSeats, playerSessions, authSessions, multiTableSessions, spectators,
    live, statusCache, audits, credits, logs, scheduled, pendingAutoStartTimers, mkSocket, seatLive, seatsOf, seatless, chipsInPlay, couldNotPlace,
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
    const w = world({ layout: { TA: field('a', 5, 5000, 100), TB: field('b', 5, 5000, 200) }, over: { rebalance: withoutPendingBustDeferral(P.rebalance) } });
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
    const x = await e1({ rebalance: withPendingBustSkip(withoutPendingBustDeferral(P.rebalance)), handComplete: withLiveOnlyBustLookup(P.handComplete) });
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
    const x = await e1({ handComplete: withLiveOnlyBustLookup(P.handComplete) });
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
    const NEW = 'const bountySeat = tournamentLiveSeatOf(tournamentId, eliminatorId, tableBroken ? undefined : tableId);';
    expect(P.handComplete).toContain(NEW);
    const run = async (handComplete: string) => {
      const w = world({ layout: { TA: field('a', 4, 5000, 100) }, config: { isBounty: true, bountyAmount: 1000 }, over: { handComplete } });
      bust(w, 'TA', [0]);
      expect(reenter(w, 'a0', w.mkSocket('S-a0'))).toBe(true);              // a0 re-entered at seat 4
      const TA = w.tables.get('TA')!;
      TA.seats[1].chipCount = 0;                                              // a1 busts; a0 (seat 4) won the pot
      (TA as any).currentPhase = GamePhase.HandComplete;
      await w.m.handleHandComplete('TA', [{ seatIndex: 4, amount: 5000 }]);
      return { dead: TA.seats[0].chipCount, live: TA.seats[4].chipCount };
    };
    expect(await run(P.handComplete)).toEqual({ dead: 0, live: 6000 });
    expect(await run(P.handComplete.replace(NEW, OLD))).toEqual({ dead: 1000, live: 5000 });   // CONTROL: the dead seat got it
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
      io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: live } }, DEFAULT_BLIND_LEVELS,
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
    expect(P.rebalance.slice(P.rebalance.indexOf('const movers'), P.rebalance.indexOf(MOVER_PUSH))).not.toContain('continue;');
    expect(P.rebalance).not.toMatch(/seats\.find(Index)?\(s => s\.state === 'occupied' && s\.playerId ===/);
    expect(P.handComplete).toContain(BUST_LOOKUP);
    expect(P.helpers).toContain("return table.seats.findIndex((s) => s.state === 'occupied' && !s.eliminated && s.playerId === playerId);");
    expect(SRC).toContain('breaksDeferredPendingBust: 0, reentrySessionsCreated: 0,');
  });
});

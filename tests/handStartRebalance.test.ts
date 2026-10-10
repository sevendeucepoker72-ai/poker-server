/**
 * 2026-10-10 — F1 (a hand is never started twice; nobody is left seatless; no
 * blinds lost) and F4 (an ABSENT suspended QUALIFIER entrant is disqualified).
 *
 * F1. The hand-start play gate runs INSIDE PokerTable.startNewHand
 * ('beforeHandStart'). Disqualifying a suspended entrant there eliminates him;
 * TournamentManager emits 'playerEliminated' synchronously and the
 * multi-table handler ran handleTableRebalance right there — before the
 * boundary's suspended seats were stood up (a moved player found no free seat)
 * — and its "restart hands on tables that were waiting" branch called
 * startNewHand on the table still inside its own startNewHand: the hand was
 * started twice and the outer start reset the inner hand's posted blinds.
 * Now the rebalance is HELD until the stand-ups are done, runs before the
 * deal, a deal on a table that rebalance broke is vetoed, and PokerTable
 * refuses a nested startNewHand outright. The rebalance also relocates stacks
 * with allowBelowMin (tournament tables' minBuyIn is the STARTING stack — a
 * short stack was refused by every seat and left seatless).
 *
 * F4. A qualifier entrant has no local userId (startQualifierTournament
 * registers him by the registration's playerId), so the U2 absent-seat branch
 * skipped him: a suspended qualifier entrant who was away kept his seat and
 * got a qualifier result. He is now identified by the master id the qualifier
 * registration holds.
 *
 * Everything runs the REAL source of src/index.ts (sliced + transpiled) with
 * the REAL PokerTable, TournamentManager and play-gate helpers.
 */
import { PokerTable } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
import { planHandStartGate, masterIdFromStats, resolveSessionMasterId, HAND_GATE_MAX_STATUS_AGE_MS } from '../src/auth/playGate';
import { SRC, slice, fnSrc, load, flush } from './helpers/indexSource';

const P = {
  absentIds: slice('const ABSENT_SEAT_MASTER_ID_TTL_MS', '\n}\n'),
  absentSeatMasterId: fnSrc('function absentSeatMasterId('),
  brokenTables: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  isTournamentReservation: fnSrc('function isTournamentReservation('),
  gateState: slice('const playGateHandStart = {', '\n}\n'),   // + the F1 hold state and holdTournamentRebalance
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
  rebalance: fnSrc('function handleTableRebalance(tournamentId: string): void {'),
  events: slice('  tournamentManager.onEvent(tournamentId, (event, data) => {', '\n  });\n', SRC.indexOf('function bootstrapTournamentTables(')),
  postQualifierResults: slice('const postedQualifierResults = new Set<string>();', '\n}\n'),
  startQualifier: fnSrc('function startQualifierTournament('),
};

const HOLD_CHECK = '  if (tournamentRebalanceIsHeld(tournamentId)) return;\n';

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
${p.rebalance}
${p.postQualifierResults}
${p.startQualifier}
function registerEvents(tournamentId) {
${p.events}
}`;
}

interface Entrant { pid: string; name: string; stack: number; uid?: number; master?: string }
const SB = 100;
const BB = 200;

function world(opts: {
  layout: Record<string, Entrant[]>;
  /** STARTING stack = every tournament table's minBuyIn (as createQuickTable sets it). */
  startingStack?: number;
  registration?: 'buyin' | 'qualifier';
  over?: Partial<typeof P>;
}) {
  const startingStack = opts.startingStack ?? 5000;
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: [{ sb: SB, bb: BB, ante: 0, duration: 600 }],
  } as any);
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  const reg = opts.registration ?? 'buyin';
  for (const list of Object.values(opts.layout)) {
    for (const e of list) {
      if (reg === 'qualifier') tm.registerPlayer(tid, e.pid, e.name, `reg-${e.pid}`, undefined, e.master);
      else tm.registerPlayer(tid, e.pid, e.name, `reg-${e.pid}`, e.uid);
    }
  }
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
  const reservedSeats = new Map<number, any>();
  const live = new Map<string, any>();
  const statusCache = new Map<string, boolean>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const credits: Array<{ uid: number; amount: number }> = [];
  const logs: string[] = [];
  const posted: any[] = [];
  const results: any[] = [];
  const qualifierTournaments = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tournamentTables, tournamentManager: tm, qualifierTournaments,
    tableManager: {
      getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id),
      createQuickTable: (name: string, _max: number, sb: number, bb: number, minBuyIn: number) => {
        const id = `new${tables.size}`;
        tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn, maxBuyIn: minBuyIn * 10, maxPlayers: 9 } as any));
        return id;
      },
    },
    DEFAULT_BLIND_LEVELS,
    reservedSeats, playerSessions, authSessions, multiTableSessions: new Map(), spectators: new Map(), aiProfiles: new Map(),
    tableProgressListeners: new Set(), sitOutTracker: new Map(), pendingSeatRemovalAfterHand: new Map(),
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: live } },
    loadLocalStats: async () => '{}', masterIdFromStats, planHandStartGate, HAND_GATE_MAX_STATUS_AGE_MS, resolveSessionMasterId,
    playStatusClient: {
      peek: (id: string) => (statusCache.has(id) ? { status: { suspended: statusCache.get(id)!, failedOpen: false }, ageMs: 0, expired: false } : null),
      getPlayStatus: async () => ({ suspended: false, failedOpen: false }),
    },
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    payTournamentPrizes: async (d: any) => { results.push(d); },
    fetch: async (url: string, init: any) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true }; },
    syncSitOutToTable() {}, broadcastGameState() {}, scheduleAIAction() {}, releaseSeatedSlot() {}, cleanupQuickTable() {},
    getGameStateForPlayer: () => ({}), emitGameState() {}, notifyPlayer: async () => {}, userIdForSeat: () => undefined,
    playGateRefusals: { player_suspended: 0 }, PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED', SEAT_RESERVE_MS: 6 * 3600_000, MAX_SEATS: 9,
    Sentry: null,
    console: {
      log: (...a: any[]) => logs.push(a.join(' ')), warn: (...a: any[]) => logs.push(a.join(' ')), error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`),
    },
    process: { env: { INTERNAL_NOTIFY_TOKEN: 't', MASTER_API_URL: 'https://master.test' } },
  };
  const { exports: m, stubbed } = load(compile(opts.over), scope, `{
    standUpSuspendedSeatsBeforeDeal, registerEvents, handleTableRebalance, playGateHandStart, tournamentHandStartSafety,
    isTournamentTable, startQualifierTournament, postQualifierResults,
  }`);
  m.registerEvents(tid);
  // ensureTableProgressListener's hook, verbatim in effect (pinned by playGate.test.ts).
  const handStarts = new Map<string, number>();
  for (const [id, t] of tables) {
    t.on('beforeHandStart', () => {
      try { m.standUpSuspendedSeatsBeforeDeal(t, id); } catch (e: any) { logs.push(`gate threw ${e?.message}`); }
    });
    t.on('handStarted', () => handStarts.set(id, (handStarts.get(id) || 0) + 1));
  }
  /** A live, signed-in socket seated at (tableId, seat). */
  const seatLive = (sid: string, tableId: string, seatIndex: number, uid: number, master: string) => {
    live.set(sid, { id: sid, connected: true, emit() {}, join() {}, leave() {} });
    authSessions.set(sid, { userId: uid, username: `u${uid}`, masterUserId: master });
    const seat = tables.get(tableId)!.seats[seatIndex];
    playerSessions.set(sid, { socketId: sid, tableId, seatIndex, playerName: seat.playerName, playerId: seat.playerId, sittingOut: false });
  };
  /** Every other entrant: a live socket (so only the one under test is absent). */
  const seatEveryoneLiveExcept = (skipPid: string) => {
    let n = 0;
    for (const [id, t] of tables) {
      t.seats.forEach((s, i) => {
        if (s.state === 'occupied' && s.playerId !== skipPid) seatLive(`S-${s.playerId}`, id, i, 500 + n++, `m-${s.playerId}`);
      });
    }
  };
  /** Every alive entrant's seats on the tables still in play. */
  const seatsOf = () => {
    const t = tm.getTournament(tid)!;
    const out = new Map<string, string[]>();
    for (const p of t.players) if (!p.eliminated) out.set(p.playerId, []);
    for (const id of t.tableIds) {
      tables.get(id)?.seats.forEach((s) => { if (s.state === 'occupied' && out.has(s.playerId)) out.get(s.playerId)!.push(id); });
    }
    return out;
  };
  /** Chips in play on the tables still in the tournament: stacks + everything committed this hand. */
  const chipsInPlay = () => {
    let sum = 0;
    for (const id of tm.getTournament(tid)!.tableIds) {
      for (const s of tables.get(id)!.seats) if (s.state === 'occupied') sum += s.chipCount + (s.totalInvestedThisHand || 0);
    }
    return sum;
  };
  return {
    m, stubbed, tm, tid, tables, tournamentTables, reservedSeats, playerSessions, authSessions, statusCache, audits, credits,
    logs, posted, results, qualifierTournaments, handStarts, seatLive, seatEveryoneLiveExcept, seatsOf, chipsInPlay,
  };
}

const field = (prefix: string, n: number, stack: number, uidBase: number): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ pid: `${prefix}${i}`, name: `${prefix}${i}`, stack, uid: uidBase + i, master: `m-${prefix}${i}` }));

/** TA 5 / TB 7 / TC 7 = 19 alive on 3 tables: the Rule-1 threshold is 18, so ONE elimination breaks the smallest table (TA). */
function threeTables(over?: Partial<typeof P>) {
  return world({
    // TA's players are SHORT (below the 5,000 starting stack = minBuyIn): the break must still place them.
    layout: { TA: field('a', 5, 3000, 100), TB: field('b', 7, 5000, 200), TC: field('c', 7, 5000, 300) },
    over,
  });
}

/** b6 (TB seat 6) is ABSENT: disconnected, his seat reserved with the master-id snapshot; suspended (cached). */
function absentSuspended(w: ReturnType<typeof world>, pid = 'b6', uid = 206) {
  w.seatEveryoneLiveExcept(pid);
  const t = w.tm.getTournament(w.tid)!;
  const tableId = t.playerTableMap.get(pid)!;
  const seatIndex = w.tables.get(tableId)!.seats.findIndex((s) => s.playerId === pid);
  w.reservedSeats.set(uid, {
    tableId, seatIndex, playerName: pid, chips: 5000, expiresAt: Date.now() + 3600e3, cleanupTimer: setTimeout(() => {}, 1e9),
    handsRemaining: 20, tournament: true, masterUserId: `m-${pid}`,
  });
  w.statusCache.set(`m-${pid}`, true);
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('F1 — disqualification at hand start never starts the hand twice, loses no blinds, leaves nobody seatless', () => {
  it('3 tables (TA 5 / TB 7 / TC 7), an ABSENT suspended entrant at TB: one hand on TB, blinds intact, TA broken AFTER the stand-up, every alive entrant seated once', () => {
    const w = threeTables();
    absentSuspended(w);
    const before = w.chipsInPlay();                                     // 5×3000 + 14×5000 = 85,000
    const refusedBefore = PokerTable.reentrantStartsRefused;
    const TB = w.tables.get('TB')!;

    expect(TB.startNewHand()).toBe(true);                               // autoStartNextHand at TB's boundary

    expect(w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'b6')).toMatchObject({ eliminated: true, disqualified: true });
    expect(TB.handNumber).toBe(1);                                      // started ONCE
    expect(w.handStarts.get('TB')).toBe(1);
    expect(PokerTable.reentrantStartsRefused).toBe(refusedBefore);       // never even attempted twice
    expect(w.m.tournamentHandStartSafety).toMatchObject({ rebalancesHeld: 1, handStartsVetoed: 0 });
    // TA was broken by the HELD rebalance (after b6's seat was freed), before TB's deal.
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TB', 'TC']);
    expect(w.m.isTournamentTable('TA')).toBe(true);                     // F2: still a tournament table to every cash-out decision
    expect(w.logs.filter((l) => /Could not place/.test(l))).toEqual([]);
    for (const [pid, at] of w.seatsOf()) expect({ pid, seats: at.length }).toEqual({ pid, seats: 1 });
    // Blinds: TB's live hand holds exactly SB + BB; the moved short stacks were dealt in on TB.
    const invested = TB.seats.reduce((a, s) => a + (s.state === 'occupied' ? (s.totalInvestedThisHand || 0) : 0), 0);
    expect(invested).toBe(SB + BB);
    expect(TB.seats.filter((s) => s.state === 'occupied' && s.chipCount === 3000 && s.holeCards.length === 2).length)
      .toBeGreaterThan(0);
    // Conservation: everything in play = before − the disqualified stack (tournament chips; never credited).
    expect(w.chipsInPlay()).toBe(before - 5000);
    expect(w.credits).toEqual([]);
    expect(w.audits).toEqual([expect.objectContaining({ action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ reason: 'suspended_absent_disqualified', userId: 206 }) })]);
  });

  it('a LIVE suspended entrant at TB: same — stood up, one hand, nobody seatless', () => {
    const w = threeTables();
    w.seatEveryoneLiveExcept('__none__');
    const sid = 'S-b6';
    w.statusCache.set(w.authSessions.get(sid).masterUserId, true);
    const TB = w.tables.get('TB')!;
    expect(TB.startNewHand()).toBe(true);
    expect(TB.handNumber).toBe(1);
    expect(w.playerSessions.has(sid)).toBe(false);
    expect(w.logs.filter((l) => /Could not place/.test(l))).toEqual([]);
    for (const [pid, at] of w.seatsOf()) expect({ pid, seats: at.length }).toEqual({ pid, seats: 1 });
    expect(TB.seats.reduce((a, s) => a + (s.state === 'occupied' ? (s.totalInvestedThisHand || 0) : 0), 0)).toBe(SB + BB);
  });

  it('the held rebalance BREAKS THE STARTING TABLE ITSELF: its deal is vetoed (no blinds posted on a table being removed), its players seated elsewhere', () => {
    // TA 7 / TB 5 / TC 7 = 19: after the disqualification TB has 4 alive and is the smallest → TB is broken.
    const w = world({ layout: { TA: field('a', 7, 5000, 100), TB: field('b', 5, 4000, 200), TC: field('c', 7, 5000, 300) } });
    absentSuspended(w, 'b4', 204);
    const TB = w.tables.get('TB')!;
    const stacksBefore = TB.seats.map((s) => s.chipCount);
    expect(TB.startNewHand()).toBe(false);
    expect(TB.handNumber).toBe(0);
    expect(w.handStarts.get('TB')).toBeUndefined();
    expect(TB.seats.every((s) => !(s.totalInvestedThisHand > 0))).toBe(true);
    expect(TB.seats.slice(0, 4).map((s) => s.chipCount)).toEqual(stacksBefore.slice(0, 4));   // nothing posted / reset
    expect(w.m.tournamentHandStartSafety).toMatchObject({ rebalancesHeld: 1, handStartsVetoed: 1 });
    expect(w.tm.getTournament(w.tid)!.tableIds.sort()).toEqual(['TA', 'TC']);
    expect(w.logs.filter((l) => /Could not place/.test(l))).toEqual([]);
    for (const [pid, at] of w.seatsOf()) expect({ pid, seats: at.length }).toEqual({ pid, seats: 1 });
  });

  it('CONTROL — without the hold, the rebalance runs before the suspended seat is freed: a moved player is left seatless (and the restart re-enters TB, refused only by PokerTable)', () => {
    expect(P.rebalance).toContain(HOLD_CHECK);
    const RESTART_SKIP = ' && !table.isStartingHand()';
    expect(P.rebalance).toContain(RESTART_SKIP);
    const w = threeTables({ rebalance: P.rebalance.replace(HOLD_CHECK, '').replace(RESTART_SKIP, '') });
    absentSuspended(w);
    const refusedBefore = PokerTable.reentrantStartsRefused;
    const TB = w.tables.get('TB')!;
    expect(TB.startNewHand()).toBe(true);
    expect(w.logs.filter((l) => /Could not place/.test(l))).toHaveLength(1);
    expect([...w.seatsOf().values()].filter((at) => at.length === 0)).toHaveLength(1);   // seatless
    expect(PokerTable.reentrantStartsRefused).toBe(refusedBefore + 1);                    // the nested start was attempted
    expect(TB.handNumber).toBe(1);                                                         // …and refused: still one hand
  });

  it('CONTROL — without allowBelowMin the break cannot place a short stack (tournament minBuyIn = starting stack)', () => {
    const needle = 'targetTable.sitDown(seatIdx, player.playerName, chips, player.playerId, isAI, true)';
    expect(P.rebalance).toContain(needle);
    const w = threeTables({ rebalance: P.rebalance.replace(needle, 'targetTable.sitDown(seatIdx, player.playerName, chips, player.playerId, isAI)') });
    absentSuspended(w);
    w.tables.get('TB')!.startNewHand();
    expect(w.logs.filter((l) => /Could not place/.test(l))).toHaveLength(5);              // every TA short stack
  });
});

describe('F1 — PokerTable refuses a nested startNewHand and honours a veto', () => {
  const mk = (T: any = PokerTable) => {
    const t = new T({ tableId: 'x', tableName: 'x', smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 });
    for (let i = 0; i < 4; i++) t.sitDown(i, `p${i}`, 1000, `p${i}`, false);
    return t;
  };

  it.each([['PokerTable', PokerTable], ['FiveCardDrawTable', FiveCardDrawTable]])('%s: a listener calling startNewHand is refused; the hand is started once, blinds intact', (_n, T) => {
    const t = mk(T);
    const before = PokerTable.reentrantStartsRefused;
    let inner: boolean | null = null;
    t.once('beforeHandStart', () => { inner = t.startNewHand(); });
    expect(t.startNewHand()).toBe(true);
    expect(inner).toBe(false);
    expect(PokerTable.reentrantStartsRefused).toBe(before + 1);
    expect(t.handNumber).toBe(1);
    expect(t.seats.reduce((a: number, s: any) => a + (s.totalInvestedThisHand || 0), 0)).toBe(30);
    expect(t.seats.reduce((a: number, s: any) => a + s.chipCount + (s.totalInvestedThisHand || 0), 0)).toBe(4000);
    expect(t.isStartingHand()).toBe(false);
  });

  it('a veto from a beforeHandStart listener: nothing dealt, reset or posted; the next start deals normally', () => {
    const t = mk();
    t.once('beforeHandStart', () => t.vetoHandStart('test'));
    expect(t.startNewHand()).toBe(false);
    expect(t.handNumber).toBe(0);
    expect(t.seats.slice(0, 4).map((s: any) => s.chipCount)).toEqual([1000, 1000, 1000, 1000]);
    t.vetoHandStart('outside a start');                                  // no-op
    expect(t.startNewHand()).toBe(true);
    expect(t.handNumber).toBe(1);
  });
});

describe('F4 — an ABSENT suspended QUALIFIER entrant (no local userId) is disqualified and gets no qualifier result', () => {
  function qualifier(opts: { onEntrant: boolean; reservation: boolean; over?: Partial<typeof P> }) {
    const entrants: Entrant[] = [
      { pid: 'alice.player', name: 'Alice', stack: 50000, master: opts.onEntrant ? 'm-alice' : undefined },
      { pid: 'bob.player', name: 'Bob', stack: 50000, master: 'm-bob' },
      { pid: 'carl.player', name: 'Carl', stack: 50000, master: 'm-carl' },
    ];
    const w = world({ layout: { Q1: entrants }, startingStack: 50000, registration: 'qualifier', over: opts.over });
    w.qualifierTournaments.set('weekly-qualifier', {
      qualifierId: 'weekly-qualifier', masterQualifierId: '77', tournamentId: w.tid, status: 'running',
      players: entrants.map((e) => ({ playerId: e.pid, masterPlayerId: `m-${e.pid.split('.')[0]}`, playerName: e.name, phone: '', socketId: `reg-${e.pid}` })),
    });
    w.seatLive('S-bob', 'Q1', 1, 102, 'm-bob');
    w.seatLive('S-carl', 'Q1', 2, 103, 'm-carl');
    if (opts.reservation) {
      w.reservedSeats.set(101, {
        tableId: 'Q1', seatIndex: 0, playerName: 'Alice', chips: 50000, expiresAt: Date.now() + 3600e3,
        cleanupTimer: setTimeout(() => {}, 1e9), handsRemaining: 20, tournament: true, masterUserId: 'm-alice',
      });
    }
    w.statusCache.set('m-alice', true);
    w.statusCache.set('m-bob', false);
    w.statusCache.set('m-carl', false);
    return w;
  }
  const alice = (w: ReturnType<typeof world>) => w.tm.getTournament(w.tid)!.players.find((p) => p.playerId === 'alice.player')!;

  it('reserved + suspended: disqualified at the boundary (registered master id), seat stood up, reservation ended, nothing credited, NO qualifier result posted for her', async () => {
    const w = qualifier({ onEntrant: true, reservation: true });
    expect(alice(w)).toMatchObject({ userId: undefined, masterUserId: 'm-alice' });
    w.m.standUpSuspendedSeatsBeforeDeal(w.tables.get('Q1')!, 'Q1');
    expect(alice(w)).toMatchObject({ eliminated: true, disqualified: true });
    expect(w.tables.get('Q1')!.seats[0].state).toBe('empty');
    expect(w.reservedSeats.has(101)).toBe(false);
    expect(w.m.playGateHandStart).toMatchObject({ absentDisqualified: 1, standUps: 1 });
    expect(w.audits).toEqual([expect.objectContaining({ actor: '101', action: 'TOURNAMENT_STACK_NOT_CASHED', d: expect.objectContaining({ userId: 101, reason: 'suspended_absent_disqualified', chips: 50000 }) })]);
    expect(w.credits).toEqual([]);

    w.tm.eliminatePlayer(w.tid, 'carl.player');                         // Bob wins
    await flush();
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].url).toBe('https://master.test/qualifiers/77/results/internal');
    const ids = w.posted[0].body.results.map((r: any) => r.playerId);
    expect(ids).toEqual(expect.arrayContaining(['m-bob', 'm-carl']));
    expect(ids).not.toContain('m-alice');                               // never a qualifier result
    expect(w.results[0].results.find((r: any) => r.playerId === 'alice.player')).toMatchObject({ disqualified: true, payout: 0 });
  });

  it('no reservation left and no master id on the entrant record: the qualifier REGISTRATION identifies him — still disqualified (audited by playerId, no local id)', () => {
    const w = qualifier({ onEntrant: false, reservation: false });
    expect(alice(w).masterUserId).toBeUndefined();
    w.m.standUpSuspendedSeatsBeforeDeal(w.tables.get('Q1')!, 'Q1');
    expect(alice(w)).toMatchObject({ eliminated: true, disqualified: true });
    expect(w.tables.get('Q1')!.seats[0].state).toBe('empty');
    expect(w.audits).toEqual([expect.objectContaining({ actor: 'alice.player', d: expect.objectContaining({ userId: null, masterId: 'm-alice', reason: 'suspended_absent_disqualified' }) })]);
  });

  it('an absent qualifier entrant who is NOT suspended stays in play', () => {
    const w = qualifier({ onEntrant: true, reservation: true });
    w.statusCache.set('m-alice', false);
    w.m.standUpSuspendedSeatsBeforeDeal(w.tables.get('Q1')!, 'Q1');
    expect(alice(w).eliminated).toBe(false);
    expect(w.tables.get('Q1')!.seats[0].state).toBe('occupied');
    expect(w.reservedSeats.has(101)).toBe(true);
  });

  it('CONTROL — the pre-F4 absent branch (skip entrants without a local userId): kept in play and POSTED as the qualifier winner', async () => {
    const newBranch = P.gate.slice(P.gate.indexOf('      if (!tp || tp.eliminated) continue;'), P.gate.indexOf('      seats.push({ seatIndex: i, masterId: who.masterId });'));
    expect(newBranch).toContain('absentEntrantIdentity(');
    const oldBranch = `      if (!tp || tp.eliminated || tp.userId === undefined) continue;
      const masterId = absentSeatMasterId(tp.userId, reservedSeats.get(tp.userId));
      if (masterId === undefined) continue;
      absent.set(i, { localUserId: tp.userId, staleOwner: owner });
      const who = { masterId };
`;
    const w = qualifier({ onEntrant: true, reservation: true, over: { gate: P.gate.replace(newBranch, oldBranch) } });
    w.m.standUpSuspendedSeatsBeforeDeal(w.tables.get('Q1')!, 'Q1');
    expect(alice(w).eliminated).toBe(false);
    w.tm.eliminatePlayer(w.tid, 'carl.player');
    w.tm.eliminatePlayer(w.tid, 'bob.player');
    await flush();
    expect(w.posted[0].body.results).toEqual(expect.arrayContaining([{ playerId: 'm-alice', finishPosition: 1, pointsAwarded: 0 }]));
  });

  it('startQualifierTournament puts the registration master id on every entrant (and still no local userId)', () => {
    const w = qualifier({ onEntrant: true, reservation: false });
    // The REAL startQualifierTournament, against the same TournamentManager.
    const r = w.m.startQualifierTournament([
      { id: 'dora.player', name: 'Dora', socketId: 's-d', masterId: 'm-dora' },
      { id: 'evan.player', name: 'Evan', socketId: 's-e', masterId: 'm-evan' },
    ], 50000, false);
    expect(r).toBeTruthy();
    const t = w.tm.getTournament(r.tournamentId)!;
    expect(t.players.map((p) => [p.playerId, p.userId, p.masterUserId])).toEqual([
      ['dora.player', undefined, 'm-dora'], ['evan.player', undefined, 'm-evan'],
    ]);
    expect(t.config.buyIn).toBe(0);                                    // a qualifier still pays no wallet prize
  });
});

describe('F1/F4 — wiring', () => {
  it('the gate holds the rebalance across its disqualify + stand-up and releases it in finally; the restart loop skips a table that is mid-start', () => {
    const holdAt = P.gate.indexOf('if (tournamentIdForGate) holdTournamentRebalance(tournamentIdForGate);');
    const dqAt = P.gate.indexOf('tournamentManager.disqualifyPlayers(tournamentIdForGate, targets.map(');
    const loopAt = P.gate.indexOf('standUpSuspendedSeat(table, tableId, seatIndex, owners.get(seatIndex)!, masterId, disqualifiedSeats.get(seatIndex) === true);');
    const releaseAt = P.gate.indexOf('if (tournamentIdForGate) releaseTournamentRebalance(tournamentIdForGate, table, tableId);');
    expect(holdAt).toBeGreaterThan(-1);
    expect(dqAt).toBeGreaterThan(holdAt);
    expect(loopAt).toBeGreaterThan(dqAt);
    expect(releaseAt).toBeGreaterThan(loopAt);
    expect(P.gate.slice(loopAt, releaseAt)).toContain('} finally {');
    expect(P.rebalance.indexOf(HOLD_CHECK)).toBeLessThan(P.rebalance.indexOf('tournamentManager.checkRebalance(tournamentId)'));
    expect(P.rebalance).toContain('if (table && !table.isHandInProgress() && !table.isStartingHand()) {');
    expect(SRC).toContain("masterId: p.masterPlayerId || null,");
    expect(P.startQualifier).toContain('tournamentManager.registerPlayer(tournamentId, p.id, p.name, p.socketId, undefined, p.masterId || undefined);');
  });
});

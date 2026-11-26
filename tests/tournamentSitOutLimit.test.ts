/**
 * 2026-11-25 (owner: "A tournament player can't sit out more than 30 hands in a
 * row") — FIX 2, every tournament (weekly / monthly qualifiers, the nightly
 * Online League, Sit & Go, club, custom, template events, simulation).
 *
 *  - A hand COUNTS as sat out (per ENTRY: TournamentPlayer.sitOutHands) when the
 *    seat was dealt in, is the entrant's live seat, is human, nobody PLAYS it at
 *    the hand's end (no session that is not sitting out on a live socket) and it
 *    made no voluntary action (an un-stamped fold / check / call / bet / raise /
 *    all-in; blinds, antes, dead blinds are not actions).
 *  - A voluntary action, I'm back and acting from sit-out reset it; a hand played
 *    with no action leaves it; a restore alone never resets it.
 *  - At 3: ONE 'tournamentSitOutWarning' to every live socket of the entrant.
 *  - At 30: REMOVED at that hand's end through the bust check, as if busted (next
 *    place, no bounty, not disqualified, chips out of play, same-hand ties and
 *    hand-for-hand rounds like busts), never mid-hand, never twice, never the
 *    last one standing; the notices say why (reason 'sat_out_limit').
 *  - The Online League's first hour (owner 2026-11-25 11:15 PM: "A player who
 *    is seated before 6 and then leaves before never played a hand so they
 *    should get the 1st hour to play a hand"): every entrant who has NOT PLAYED
 *    A HAND yet (playedAHand unset) is protected until lateRegUntil (7:00 PM
 *    MT); if he still has not played and is away then, he is removed at the
 *    first hand end after it whatever his count (notices add noShow: true).
 *    Once he played a hand it is gone for good (a re-entry keeps playedAHand).
 *    The weekly / every other tournament has no first hour.
 *  - Sitting back IN through 'sitOut' {sittingOut:false} resets like I'm back
 *    (review fix 2026-11-26).
 *
 * Runs the REAL source of src/index.ts (sliced + transpiled) with the REAL
 * PokerTable and TournamentManager. CONTROL cases put the pre-fix code back.
 */
import fs from 'fs';
import path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS, clearAwayStreak } from '../src/game/TournamentManager';
import { planHandStartGate, masterIdFromStats, resolveSessionMasterId, HAND_GATE_MAX_STATUS_AGE_MS } from '../src/auth/playGate';
import { SRC, slice, fnSrc, handlerSrc, load, flush, deferred, SEAT_TEARDOWN_SRC, SEAT_SESSION_FOR_SRC, SEAT_RESTORE_SRC, JOIN_PRECHECK_SRC } from './helpers/indexSource';

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
  chipsWonSeats: fnSrc('function chipsWonSeatsOfHand(') + fnSrc('function dealtInSeatAccount('),
  events: slice('  tournamentManager.onEvent(tournamentId, (event, data) => {', '\n  });\n', SRC.indexOf('function bootstrapTournamentTables(')),
  seatKeep: slice('// ===== Tournament seat kept on leave', '// ===== end tournament seat kept on leave =====\n'),
  fastModeRestore: fnSrc('function restoreFastModeOnSeatRestore('),
  departure: fnSrc('function otherSessionHoldsSeat(') + fnSrc('function reserveSeatForDeparture(') + fnSrc('function cashOutAdditionalSeatsOnDeparture(') + SEAT_RESTORE_SRC,
  noteNotCashed: fnSrc('function noteTournamentReservationNotCashed('),
  accountSwitch: slice('const socketAccountSwitches = {', '\n}\n'),
  // 2026-11-25 — the away test, the absent clock (with the sit-out limit section) and the seat controls.
  liveSession: fnSrc('function seatHasLiveSession('),
  playing: slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
  absentClock: slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n'),
  playerBack: handlerSrc('playerBack', '\n  });\n'),
  sitOut: handlerSrc('sitOut', '\n  });\n'),
};

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
${p.fastModeRestore}
${p.departure}
${p.noteNotCashed}
${p.accountSwitch}
${p.handlePlayerLeave}
${p.creditSeat}
${SEAT_TEARDOWN_SRC}
${p.helpers}
${p.rebalance}
${p.autoStart}
${p.handComplete}
${p.chipsWonSeats}
${JOIN_PRECHECK_SRC}
${p.liveSession}
${p.playing}
${p.absentClock}
function registerEvents(tournamentId) {
${p.events}
}
function wireSocket(socket) {
${SEAT_SESSION_FOR_SRC}
  ${p.playerBack}
  ${p.sitOut}
}`;
}

interface Entrant { pid: string; name: string; stack: number; uid?: number; master?: string; ai?: boolean }
const SB = 100;
const BB = 200;
const ANTE = 25;   // every hand posts an ante: an un-stamped 'posted ante' line for every dealt-in seat

function world(opts: {
  layout: Record<string, Entrant[]>; over?: Partial<typeof P>; scope?: Record<string, unknown>; config?: Record<string, unknown>;
}) {
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Sit Out Cup', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: [{ sb: SB, bb: BB, ante: ANTE, duration: 600 }],
    ...(opts.config || {}),
  } as any);
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  for (const list of Object.values(opts.layout)) for (const e of list) tm.registerPlayer(tid, e.pid, e.name, `reg-${e.pid}`, e.ai ? undefined : e.uid);
  expect(tm.startTournament(tid)).toBeTruthy();
  tm.setTableIds(tid, Object.keys(opts.layout));
  for (const [id, list] of Object.entries(opts.layout)) {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: SB, bigBlind: BB, ante: ANTE, minBuyIn: 1000, maxBuyIn: 100000, maxPlayers: 9 } as any);
    tables.set(id, t);
    tournamentTables.set(id, tid);
    list.forEach((e, i) => {
      expect(t.sitDown(i, e.name, e.stack, e.pid, !!e.ai, true)).toBe(true);
      tm.setPlayerTable(tid, e.pid, id);
    });
  }
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const spectators = new Map<string, Set<string>>();
  const live = new Map<string, any>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const logs: string[] = [];
  const scheduled: string[] = [];
  const roomEmits: Array<[string, string, any]> = [];
  const scope: Record<string, unknown> = {
    tournamentTables, tournamentManager: tm, qualifierTournaments: new Map(),
    recordTournamentResultsBust() {}, recordTournamentResultsStart() {}, recordTournamentResultsFinish() {},
    // A qualifier-like event by default: outside the durable results (a removal nobody heard of waits for his sign-in).
    tournamentResultsInScope: () => false,
    qualifierOfTournament: () => null, qualifierEngineTournamentIds: new Set<string>(), createHmac, randomBytes,
    tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id) },
    tournamentIdOfTable: (id: string) => tournamentTables.get(id),
    DEFAULT_BLIND_LEVELS, GamePhase,
    reservedSeats, playerSessions, authSessions, multiTableSessions, spectators, aiProfiles: new Map(),
    tableProgressListeners: new Set(), sitOutTracker: new Map(), pendingSeatRemovalAfterHand: new Map(),
    pendingAutoStartTimers: new Map(), scheduleAutoStart: (id: string) => { scheduled.push(id); },
    io: {
      to: (room: string) => {
        const op: any = { emit: (ev: string, d: any) => { roomEmits.push([room, ev, d]); }, except: () => op };
        return op;
      },
      emit() {}, sockets: { sockets: live },
    },
    loadLocalStats: async () => '{}', masterIdFromStats, planHandStartGate, HAND_GATE_MAX_STATUS_AGE_MS, resolveSessionMasterId,
    playStatusClient: { peek: () => null, getPlayStatus: async () => ({ suspended: false, failedOpen: false }) },
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    addChipsToUser: async () => true,
    payTournamentPrizes: async () => {}, postQualifierResults() {}, markQualifierFinished() {},
    syncSitOutToTable() {}, broadcastGameState() {}, scheduleAIAction() {}, releaseSeatedSlot() {}, cleanupQuickTable() {},
    isPrizeFormatTable: () => false, leavePrizeFormatSeat: () => false, quickGameEndCheck: () => false,
    settleDecidedQuickGame: () => false, shutdownFlushActive: () => false,
    getGameStateForPlayer: () => ({}), emitGameState() {}, notifyPlayer: async () => {}, userIdForSeat: () => undefined,
    ensureTableProgressListener() {}, activateBombPotIfPending() {},
    dealersChoiceState: new Map(), bombPotActive: new Map(), bombPotPending: new Map(), insuranceCashouts: new Map(),
    quickTables: new Set(), tickReservedSeatHands() {}, challengeTables: new Map(),
    playGateRefusals: { player_suspended: 0 }, PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED', SEAT_RESERVE_MS: 6 * 3600_000, MAX_SEATS: 9,
    DISCONNECT_HANDS_LIMIT: 20, assertPlayable: async () => null, Sentry: null,
    console: {
      log: (...a: any[]) => logs.push(a.join(' ')), warn: (...a: any[]) => logs.push(a.join(' ')), error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`),
    },
    log: { debug() {}, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    process: { env: {} },
    qualifierOverflowTablesMax: 6, broadcastFeed: null, forceVoiceOffAtQualifierTable: () => 0,
    ...(opts.scope || {}),
  };
  const { exports: m, stubbed } = load(compile(opts.over), scope, `{
    registerEvents, handleTableRebalance, autoStartNextHand, handleHandComplete, wireSocket,
    tournamentBustChecksPending, tournamentDealsHeldForBustCheck, runTournamentBustCheck, captureTournamentBustCheck,
    restoreAbsentTournamentSeat, restoreSeatReservation, tellKeptTournamentSeats, returnTournamentSessionFromSitOut,
    sitOutTournamentSeatAfterTimeout, autoActForSeat, seatHasPlayingSession, awayStreakAtHandEnd, awayStreakResetAt, awayStreakViewOf, awayStreakStats,
    markLeagueFirstHour, removalSignInNotices, handForHandStates, placeAndTellHandForHandBusts,
    TOURNAMENT_SIT_OUT_HANDS_LIMIT, TOURNAMENT_SIT_OUT_WARN_AT,
  }`);
  m.registerEvents(tid);
  const pending = new Map<string, Promise<void>>();
  for (const [id, t] of tables) t.on('handResult', (d: any) => { pending.set(id, m.handleHandComplete(id, d.results)); });
  const mkSocket = (sid: string, uid?: number) => {
    const s: any = { id: sid, connected: true, emitted: [] as any[], rooms: new Set<string>() };
    s.emit = (ev: string, d: any) => s.emitted.push([ev, d]);
    s.join = (r: string) => s.rooms.add(r);
    s.leave = (r: string) => s.rooms.delete(r);
    live.set(sid, s);
    if (uid !== undefined) authSessions.set(sid, { userId: uid, username: `u${uid}`, masterUserId: `m-${uid}` });
    return s;
  };
  /** A live, signed-in socket PLAYING (tableId, seat). */
  const seatLive = (sid: string, tableId: string, seatIndex: number) => {
    const seat = tables.get(tableId)!.seats[seatIndex];
    const tp = tm.getTournament(tid)!.players.find((p) => p.playerId === seat.playerId)!;
    const s = mkSocket(sid, tp.userId);
    playerSessions.set(sid, { socketId: sid, tableId, seatIndex, playerName: seat.playerName, playerId: seat.playerId, sittingOut: false });
    s.join(`table:${tableId}`);
    return s;
  };
  /** Every human seat a live session except the `away` player ids. */
  const seatEveryoneExcept = (...away: string[]) => {
    for (const [id, t] of tables) t.seats.forEach((s, i) => {
      if (s.state === 'occupied' && !s.isAI && !away.includes(s.playerId)) seatLive(`S-${s.playerId}`, id, i);
    });
  };
  const tp = (pid: string) => tm.getTournament(tid)!.players.find((p) => p.playerId === pid)!;
  /** His live seat on a table still IN PLAY (a broken table keeps its old copy until it is removed). */
  const seatOf = (pid: string) => {
    for (const id of tm.getTournament(tid)!.tableIds) {
      const t = tables.get(id);
      if (!t) continue;
      const i = t.seats.findIndex((s) => s.state === 'occupied' && !s.eliminated && s.playerId === pid);
      if (i >= 0) return { tableId: id, table: t, seatIndex: i, seat: t.seats[i] };
    }
    return null;
  };
  /**
   * Deal `tableId` and play the hand out: a seat nobody plays is acted for by the REAL
   * autoActForSeat (stamped auto 'away'); a played seat checks, else folds (voluntary),
   * unless `act` says otherwise. Waits for its handleHandComplete (bust check included).
   */
  const playHand = async (
    tableId: string, act?: (seatIndex: number, t: PokerTable) => boolean,
    o: { deal?: boolean; onDeal?: (t: PokerTable) => void } = {},
  ) => {
    const t = tables.get(tableId)!;
    if (o.deal !== false) expect(t.startNewHand()).toBe(true);
    o.onDeal?.(t);
    for (let g = 0; g < 300 && t.isHandInProgress(); g++) {
      const a = t.activeSeatIndex;
      if (a < 0) break;
      if (act && act(a, t)) continue;
      if (t.seats[a].isAI || !m.seatHasPlayingSession(tableId, a)) { m.autoActForSeat(tableId, t, a, 'away'); continue; }
      if (!t.playerCheck(a)) t.playerFold(a);
    }
    expect(t.isHandInProgress()).toBe(false);
    await pending.get(tableId);
    await flush();
  };
  return {
    m, stubbed, tm, tid, tables, tournamentTables, reservedSeats, playerSessions, authSessions, spectators, live, audits, logs,
    scheduled, roomEmits, pending, mkSocket, seatLive, seatEveryoneExcept, tp, seatOf, playHand, scope,
  };
}
type World = ReturnType<typeof world>;

const field = (prefix: string, n: number, stack: number, uidBase: number): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ pid: `${prefix}${i}`, name: `${prefix}${i}`, stack, uid: uidBase + i, master: `m-${prefix}${i}` }));

const evs = (s: any, ev: string) => s.emitted.filter(([e]: [string]) => e === ev).map(([, d]: [string, any]) => d);
const LIMIT = 30;

/** Play `n` hands at `tableId` (counts only what the rules count). */
async function hands(w: World, tableId: string, n: number) {
  for (let k = 0; k < n; k++) await w.playHand(tableId);
}

// -------------------------------------------------------------------------------------------------
// Review fix (2026-11-26, owner rule: "played a hand" must mean HE played it, never the server) — a
// session holding his seat at the hand end PLAYED the hand only when the server never acted for his
// seat that hand (awayStreakServerActed). The flag and the count share the rule: a hand is either
// played (playedAHand set, not counted) or sat out (counted).
// CONTROL = the pre-fix line (any connected, not-sitting-out session at the hand end = played).
// -------------------------------------------------------------------------------------------------
const NEW_PLAYED = '      const played = awayStreakPlayedNow(tableId, i) && !awayStreakServerActed(table, i);';
const OLD_PLAYED = '      const played = awayStreakPlayedNow(tableId, i);';
function prePlayedFix(): Partial<typeof P> {
  expect(P.absentClock.split(NEW_PLAYED).length).toBe(2);
  return { absentClock: P.absentClock.replace(NEW_PLAYED, OLD_PLAYED) };
}

describe('the count: per ENTRY, only dealt-in hands nobody plays and the seat never acted in', () => {
  it('an AWAY seat (no session) at a level WITH antes counts 1, 2, 3 …: blind / ante lines are never actions; the played seats stay 0', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    await w.playHand('TA');
    const t = w.tables.get('TA')!;
    // The hand really posted antes (un-stamped lines) for the away seat.
    expect(t.actionLog.some((e) => e.seatIndex === 0 && /^posted ante/.test(e.action) && !e.auto)).toBe(true);
    expect(w.tp('a0').sitOutHands).toBe(1);
    await hands(w, 'TA', 4);
    expect(w.tp('a0').sitOutHands).toBe(5);
    expect(w.tp('a1').sitOutHands ?? 0).toBe(0);
    expect(w.tp('a2').sitOutHands ?? 0).toBe(0);
    expect(w.m.TOURNAMENT_SIT_OUT_HANDS_LIMIT).toBe(30);
    expect(w.m.TOURNAMENT_SIT_OUT_WARN_AT).toBe(3);
  });

  it('CONTROL: the naive rule (any un-stamped log line is an action) — the ante line resets him every hand: he never gets past 0', async () => {
    const naive = P.absentClock.replace(
      "    if (a === 'folded' || a === 'checked' || /^(called|bet|raised to|went all-in for) /.test(a)) return true;",
      '    return true;',
    );
    expect(naive).not.toBe(P.absentClock);
    const w = world({ layout: { TA: field('a', 3, 20000, 100) }, over: { absentClock: naive } });
    w.seatEveryoneExcept('a0');
    await hands(w, 'TA', 5);
    expect(w.tp('a0').sitOutHands ?? 0).toBe(0);
  });

  it('a session SITTING OUT counts; a session on a DEAD socket counts (nobody plays it); the same hand is never counted twice', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept();
    w.playerSessions.get('S-a0').sittingOut = true;
    await w.playHand('TA');
    expect(w.tp('a0').sitOutHands).toBe(1);
    expect(w.tp('a0').playedAHand).toBeUndefined();     // 2026-11-26 — sitting out is not PLAYING a hand
    expect(w.tp('a1').playedAHand).toBe(true);          // acted voluntarily at his live seat
    w.playerSessions.get('S-a0').sittingOut = false;
    w.live.get('S-a0').connected = false;            // dropped; the disconnect handler has not run yet
    await w.playHand('TA', (a, t) => {
      if (a !== 0) return false;
      w.m.autoActForSeat('TA', t, 0, 'timeout');     // his clock runs out: the server acts for him
      return true;
    });
    expect(w.tp('a0').sitOutHands).toBe(2);
    expect(w.tp('a0').playedAHand).toBeUndefined();     // a dead socket's session plays nothing
    // Review fix (2026-11-26, owner: "played a hand" means HE played it, never the server) — the
    // same seat on a LIVE socket whose every act that hand was the SERVER's is NOT played: counted
    // (it used to read as "played", unchanged, and set playedAHand).
    w.live.get('S-a0').connected = true;
    await w.playHand('TA', (a, t) => {
      if (a !== 0) return false;
      w.m.autoActForSeat('TA', t, 0, 'timeout');
      return true;
    });
    expect(w.tp('a0').sitOutHands).toBe(3);
    expect(w.tp('a0').playedAHand).toBeUndefined();
    // Idempotent per tableId:handNumber: the same hand again changes nothing.
    const t = w.tables.get('TA')!;
    const c = w.m.captureTournamentBustCheck('TA', t, []);
    w.m.awayStreakAtHandEnd('TA', t, c);
    w.m.awayStreakAtHandEnd('TA', t, c);
    expect(w.tp('a0').sitOutHands).toBe(3);
    w.m.runTournamentBustCheck('TA', t, c, 'test');
  });

  it('what is a PLAYED hand: his voluntary FOLD (un-stamped) is one; a voluntary call then a timed-out check later in the hand is one; the server\'s act for a connected seat is NOT (counted); CONTROL: the pre-fix rule called the server\'s act a played hand', async () => {
    const run = async (over?: Partial<typeof P>) => {
      const w = world({ layout: { TA: field('a', 4, 20000, 100) }, over });
      w.seatEveryoneExcept();
      const TA = w.tables.get('TA')!;
      const mine = (seat: number) => TA.actionLog.filter((e) => e.seatIndex === seat && !/^posted /.test(e.action));
      // Hand 1: a1 FOLDS himself (no auto stamp); everyone else plays it out (check / call).
      await w.playHand('TA', (a, t) => {
        if (a === 1) { expect(t.playerFold(1)).toBe(true); return true; }
        if (!t.playerCheck(a)) t.playerCall(a);
        return true;
      });
      expect(mine(1)).toEqual([expect.objectContaining({ action: 'folded' })]);
      expect(mine(1)[0].auto).toBeUndefined();
      const fold = { played: w.tp('a1').playedAHand, n: w.tp('a1').sitOutHands ?? 0 };
      // Hand 2: a2 CALLS / CHECKS himself on his first turn, then his clock runs out on a later turn
      // (the server checks for him): he acted voluntarily, so it is his hand.
      let a2Turns = 0;
      await w.playHand('TA', (a, t) => {
        if (a === 2 && ++a2Turns > 1) { w.m.autoActForSeat('TA', t, 2, 'timeout'); return true; }
        if (!t.playerCheck(a)) t.playerCall(a);
        return true;
      });
      expect(a2Turns).toBeGreaterThan(1);
      expect(mine(2).some((e) => e.auto === 'timeout')).toBe(true);
      expect(mine(2).some((e) => !e.auto)).toBe(true);
      const mixed = { played: w.tp('a2').playedAHand, n: w.tp('a2').sitOutHands ?? 0 };
      // A fresh table's first hand: c3 is connected and not sitting out, but EVERY act of his seat is the server's.
      const w3 = world({ layout: { TC: field('c', 4, 20000, 300) }, over });
      w3.seatEveryoneExcept();
      const TC = w3.tables.get('TC')!;
      await w3.playHand('TC', (a, t) => {
        if (a === 3) { w3.m.autoActForSeat('TC', t, 3, 'timeout'); return true; }
        if (!t.playerCheck(a)) t.playerCall(a);
        return true;
      });
      const c3 = TC.actionLog.filter((e) => e.seatIndex === 3 && !/^(posted |uncalled bet)/.test(e.action));
      expect(c3.length).toBeGreaterThan(0);
      expect(c3.every((e) => e.auto === 'timeout')).toBe(true);
      expect(w3.playerSessions.get('S-c3')).toMatchObject({ sittingOut: false });
      expect(w3.live.get('S-c3').connected).toBe(true);
      expect(w3.tp('c0').playedAHand).toBe(true);            // the others played it themselves
      const server = { played: w3.tp('c3').playedAHand, n: w3.tp('c3').sitOutHands ?? 0 };
      // A fresh table: its first hand is a WALK for the big blind (present, everyone folds to him):
      // nothing of his and nothing the server did for him — a session played his seat.
      const w2 = world({ layout: { TB: field('b', 4, 20000, 200) }, over });
      w2.seatEveryoneExcept();
      const TB = w2.tables.get('TB')!;
      let bb = -1;
      await w2.playHand('TB', (a, t) => {
        if (a === bb) return false;
        expect(t.playerFold(a)).toBe(true);
        return true;
      }, { onDeal: (t) => { bb = t.actionLog.find((e) => /^posted BB/.test(e.action))!.seatIndex; } });
      expect(bb).toBeGreaterThanOrEqual(0);
      // (only his blind / ante and the uncalled part of his blind returned: no action of his, no auto stamp)
      expect(TB.actionLog.filter((e) => e.seatIndex === bb && (e.auto || /^(folded|checked|called |bet |raised to |went all-in)/.test(e.action)))).toEqual([]);
      const bbTp = w2.tp(TB.seats[bb].playerId);
      const walk = { played: bbTp.playedAHand, n: bbTp.sitOutHands ?? 0 };
      return { fold, mixed, server, walk };
    };
    const fixed = await run();
    expect(fixed.fold).toEqual({ played: true, n: 0 });
    expect(fixed.mixed).toEqual({ played: true, n: 0 });
    expect(fixed.server).toEqual({ played: undefined, n: 1 });   // NOT his hand: a sat-out hand, counted
    expect(fixed.walk).toEqual({ played: true, n: 0 });          // a walk while present IS his hand
    // CONTROL: the pre-fix rule — the server's act for a connected seat was "played" (flag set, not counted).
    const ctl = await run(prePlayedFix());
    expect(ctl.fold).toEqual({ played: true, n: 0 });
    expect(ctl.server).toEqual({ played: true, n: 0 });
    // CONTROL (the other side): a rule that kept only voluntary actions would lose the walk.
    const voluntaryOnly = await run({ absentClock: P.absentClock.replace(NEW_PLAYED, '      const played = false;') });
    expect(voluntaryOnly.walk).toEqual({ played: undefined, n: 1 });
    expect(voluntaryOnly.fold).toEqual({ played: true, n: 0 });
  });

  it('a WALK while present (he is back, the others fold to his big blind) leaves the run unchanged; then his first voluntary action resets it to 0', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    const TA = w.tables.get('TA')!;
    const isBB0 = (t: PokerTable) => t.actionLog.some((e) => e.seatIndex === 0 && /^posted BB/.test(e.action));
    const a0Acted = () => TA.actionLog.some((e) => e.seatIndex === 0 && !e.auto && /^(folded|checked|called |bet |raised to |went all-in)/.test(e.action));
    // Away hands until (after 3+) a hand deals him the big blind: he comes back for it.
    let walkedAt = -1;
    for (let k = 0; k < 12 && walkedAt < 0; k++) {
      const before = w.tp('a0').sitOutHands || 0;
      let back = false;
      await w.playHand('TA', (a, t) => {
        if (!back || a === 0) return false;
        t.playerFold(a);                                // the others fold to him
        return true;
      }, { onDeal: (t) => { if (before >= 3 && isBB0(t)) { w.seatLive('S-a0', 'TA', 0); back = true; } } });
      if (back) {
        expect(a0Acted()).toBe(false);                  // a walk: nothing of his
        expect(TA.actionLog.some((e) => e.seatIndex === 0 && e.auto)).toBe(false);   // … and nothing the server did for him
        expect(w.tp('a0').sitOutHands).toBe(before);    // played, no action: unchanged
        expect(w.tp('a0').playedAHand).toBe(true);      // 2026-11-26 — but he PLAYED a hand (a session at the hand end)
        walkedAt = k;
      } else {
        expect(w.tp('a0').playedAHand).toBeUndefined();  // away hands are never a played hand
      }
    }
    expect(walkedAt).toBeGreaterThanOrEqual(0);
    // Present from now on: the first hand he acts in resets it.
    for (let k = 0; k < 4 && (w.tp('a0').sitOutHands || 0) > 0; k++) {
      const before = w.tp('a0').sitOutHands;
      await w.playHand('TA');
      expect(w.tp('a0').sitOutHands).toBe(a0Acted() ? 0 : before);
    }
    expect(w.tp('a0').sitOutHands).toBe(0);
    expect(w.m.awayStreakStats.resetsByAction).toBeGreaterThanOrEqual(1);
  });

  it('I\'m back (the REAL playerBack handler) resets to 0; acting from sit-out (returnTournamentSessionFromSitOut) resets to 0; counted in health', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept();
    w.playerSessions.get('S-a0').sittingOut = true;
    await hands(w, 'TA', 3);
    expect(w.tp('a0').sitOutHands).toBe(3);
    const sock = w.live.get('S-a0');
    sock.handlers = {};
    sock.on = (ev: string, fn: any) => { sock.handlers[ev] = fn; };
    w.m.wireSocket(sock);
    await sock.handlers.playerBack({ tableId: 'TA' });
    expect(w.tp('a0').sitOutHands).toBe(0);
    expect(w.m.awayStreakStats.resetsByBack).toBe(1);
    w.playerSessions.get('S-a0').sittingOut = true;
    await hands(w, 'TA', 2);
    expect(w.tp('a0').sitOutHands).toBe(2);
    w.m.returnTournamentSessionFromSitOut(sock, w.playerSessions.get('S-a0'), 'action');
    expect(w.tp('a0').sitOutHands).toBe(0);
    expect(w.m.awayStreakStats.resetsByAction).toBe(1);
    expect([...w.stubbed].filter((n) => /awayStreak|SIT_OUT|removal|Removal|NoShow/.test(n))).toEqual([]);
  });

  // Review fix (2026-11-26) — the app's "Sitting Out · I'm back" menu button and the quick Sit Out
  // button come back through 'sitOut' {sittingOut:false} (tableStore.toggleSitOut), not 'playerBack'.
  // That sit-in used to leave the run (and the warned flag) as it was: one timeout before his first
  // action and a 27-hand run went on from 28.
  const sitOutWorld = (over?: Partial<typeof P>) => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) }, over, scope: { DrawPhases: [] } });
    w.seatEveryoneExcept();
    const sock = w.live.get('S-a0');
    sock.handlers = {};
    sock.on = (ev: string, fn: any) => { sock.handlers[ev] = fn; };
    w.m.wireSocket(sock);
    return { w, sock, TA: w.tables.get('TA')! };
  };

  it('sitting back IN through the REAL \'sitOut\' handler ({sittingOut:false}, and its toggle) resets the run to 0 like I\'m back', async () => {
    const { w, sock, TA } = sitOutWorld();
    expect(TA.activeSeatIndex).not.toBe(0);                   // between hands: the sit-out never acts for him
    await sock.handlers.sitOut({ tableId: 'TA', sittingOut: true });
    expect(w.playerSessions.get('S-a0').sittingOut).toBe(true);
    await hands(w, 'TA', 4);
    expect(w.tp('a0')).toMatchObject({ sitOutHands: 4, sitOutWarned: true });
    await sock.handlers.sitOut({ tableId: 'TA', sittingOut: false });
    expect(w.playerSessions.get('S-a0').sittingOut).toBe(false);
    expect(evs(sock, 'sitOutToggled').pop()).toEqual({ sittingOut: false, tableId: 'TA' });
    expect(w.tp('a0')).toMatchObject({ sitOutHands: 0, sitOutWarned: false });
    expect(w.m.awayStreakStats.resetsByBack).toBe(1);
    // The toggle (no boolean), out and back in again.
    await sock.handlers.sitOut({ tableId: 'TA' });
    expect(w.playerSessions.get('S-a0').sittingOut).toBe(true);
    await hands(w, 'TA', 2);
    expect(w.tp('a0').sitOutHands).toBe(2);
    await sock.handlers.sitOut({ tableId: 'TA' });
    expect(w.playerSessions.get('S-a0').sittingOut).toBe(false);
    expect(w.tp('a0').sitOutHands).toBe(0);
    expect(w.m.awayStreakStats.resetsByBack).toBe(2);
    // Sitting OUT never resets anything.
    await sock.handlers.sitOut({ tableId: 'TA', sittingOut: true });
    await hands(w, 'TA', 1);
    await sock.handlers.sitOut({ tableId: 'TA', sittingOut: true });   // 'unchanged'
    expect(w.tp('a0').sitOutHands).toBe(1);
    expect([...w.stubbed].filter((n) => /awayStreak|SIT_OUT|isTournamentTable|seatSessionFor/.test(n))).toEqual([]);
  });

  it('CONTROL: without the reset in the sit-in branch, the run and the warned flag survive his return (27 stays 27)', async () => {
    const line = "      awayStreakResetAt(session.tableId, session.seatIndex, 'back');\n";
    expect(P.sitOut).toContain(line);
    const { w, sock } = sitOutWorld({ sitOut: P.sitOut.replace(line, '') });
    await sock.handlers.sitOut({ tableId: 'TA', sittingOut: true });
    await hands(w, 'TA', 3);
    preCount(w, 'a0', 27);
    await sock.handlers.sitOut({ tableId: 'TA', sittingOut: false });
    expect(w.playerSessions.get('S-a0').sittingOut).toBe(false);
    expect(w.tp('a0')).toMatchObject({ sitOutHands: 27, sitOutWarned: true });
    expect(w.m.awayStreakStats.resetsByBack).toBe(0);
  });

  it('a RESTORE alone never resets it (restoreAbsentTournamentSeat / restoreSeatReservation); the count follows the ENTRY through a reservation', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    await hands(w, 'TA', 6);
    expect(w.tp('a0').sitOutHands).toBe(6);
    // His sign-in restores the absent seat by account: PLAYING again, the run unchanged.
    const s = w.mkSocket('S-back', 100);
    const restored = w.m.restoreAbsentTournamentSeat(s, w.authSessions.get('S-back'), 'test');
    expect(restored).toMatchObject({ tableId: 'TA', seatIndex: 0 });
    expect(w.tp('a0').sitOutHands).toBe(6);
    // His socket drops: a reservation keeps the seat; the hands count on the ENTRY.
    w.playerSessions.delete('S-back');
    w.reservedSeats.set(100, { tableId: 'TA', seatIndex: 0, playerName: 'a0', chips: 1, sittingOut: false, expiresAt: Date.now() + 600_000, handsRemaining: 20, tournament: true, playerId: 'a0' });
    await hands(w, 'TA', 2);
    expect(w.tp('a0').sitOutHands).toBe(8);
    const s2 = w.mkSocket('S-back2', 100);
    expect(w.m.restoreSeatReservation(s2, 100, 'test')).toMatchObject({ outcome: 'restored' });
    expect(w.tp('a0').sitOutHands).toBe(8);
  });

  it('the count survives a table BREAK (the stack moves under the same playerId) and keeps counting at the new table', async () => {
    const w = world({ layout: { TA: field('a', 2, 20000, 100), TB: field('b', 3, 20000, 200) } });
    w.seatEveryoneExcept('a0');
    await hands(w, 'TA', 4);
    expect(w.tp('a0').sitOutHands).toBe(4);
    // a1 busts at TA: 4 alive fit one table → TA breaks into TB (the real rebalance).
    const TA = w.tables.get('TA')!;
    TA.seats[1].chipCount = 0;
    (TA as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TA', []);
    await flush();
    expect(w.tm.getTournament(w.tid)!.tableIds).toEqual(['TB']);
    const at = w.seatOf('a0')!;
    expect(at.tableId).toBe('TB');
    expect(w.tp('a0').sitOutHands).toBe(4);
    await w.playHand('TB');
    expect(w.tp('a0').sitOutHands).toBe(5);
  });

  it('AI seats are never counted; a busted seat is never counted', async () => {
    const layout = { TA: [{ pid: 'bot', name: 'Bot', stack: 20000, ai: true }, ...field('a', 2, 20000, 100)] };
    const w = world({ layout });
    w.seatEveryoneExcept();
    await hands(w, 'TA', 4);
    expect(w.tp('bot').sitOutHands ?? 0).toBe(0);
  });

  it('a re-entry starts a fresh run (reinstateForReentry clears the count, the warning and the reason) but KEEPS playedAHand (2026-11-26)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    const p = w.tp('a0');
    Object.assign(p, { sitOutHands: 12, sitOutWarned: true, sitOutLastHand: 'TA:9', playedAHand: true, removedFor: 'sat_out_limit', removedSatOutHands: 30 });
    w.tm.eliminatePlayer(w.tid, 'a0');
    expect(w.tm.reinstateForReentry(w.tid, 'a0', 20000)).toBe(true);
    expect(p).not.toHaveProperty('sitOutHands');
    expect(p).not.toHaveProperty('sitOutWarned');
    expect(p).not.toHaveProperty('sitOutLastHand');
    expect(p).not.toHaveProperty('removedFor');
    expect(p.playedAHand).toBe(true);                   // he played: no league first hour on the new entry
    // The other un-elimination path (index.ts's re-entry fallback) calls clearAwayStreak directly: same.
    p.eliminated = true;
    clearAwayStreak(p);
    expect(p.playedAHand).toBe(true);
  });

  it('a CASH table (no capture) counts nothing', () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    const t = w.tables.get('TA')!;
    w.tournamentTables.delete('TA');
    expect(t.startNewHand()).toBe(true);
    while (t.isHandInProgress()) w.m.autoActForSeat('TA', t, t.activeSeatIndex, 'away');
    w.m.awayStreakAtHandEnd('TA', t, null);
    expect(w.tp('a0').sitOutHands ?? 0).toBe(0);
  });
});

describe('the 3-hand warning', () => {
  it('ONCE per run, at 3, to every live socket signed in as him (lobby + another tab); a reset starts a new run', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    const lobby = w.mkSocket('L1', 100);
    const tab = w.mkSocket('L2', 100);
    const stranger = w.mkSocket('X', 999);
    await hands(w, 'TA', 2);
    expect(evs(lobby, 'tournamentSitOutWarning')).toEqual([]);
    await w.playHand('TA');
    const expected = {
      tournamentId: w.tid, tableId: 'TA', handsSatOut: 3, handsLimit: 30, handsLeft: 27, protectedUntil: null,
      message: 'You have sat out 3 hands in a row. Come back within 27 hands or you will be removed from the tournament.',
    };
    expect(evs(lobby, 'tournamentSitOutWarning')).toEqual([expected]);
    expect(evs(tab, 'tournamentSitOutWarning')).toEqual([expected]);
    expect(evs(stranger, 'tournamentSitOutWarning')).toEqual([]);
    await hands(w, 'TA', 3);
    expect(evs(lobby, 'tournamentSitOutWarning')).toHaveLength(1);
    expect(w.audits.filter((a) => a.action === 'TOURNAMENT_SIT_OUT_WARNED')).toHaveLength(1);
    expect(w.logs.some((l) => l.includes('"event":"tournament_sit_out_warned"'))).toBe(true);
    // A reset (I'm back) and three more hands: a new run, a new warning.
    w.m.awayStreakResetAt('TA', 0, 'back');            // no session at the seat: the helper still ends his run
    await hands(w, 'TA', 3);
    expect(evs(lobby, 'tournamentSitOutWarning')).toHaveLength(2);
  });

  it('a protected league entrant (no hand played yet) is told the late-entry wording (protectedUntil set)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    const until = Date.now() + 3600_000;
    expect(w.m.markLeagueFirstHour(w.tid, until)).toBe(3);   // nobody has played a hand yet
    const lobby = w.mkSocket('L1', 100);
    await hands(w, 'TA', 3);
    expect(evs(lobby, 'tournamentSitOutWarning')).toEqual([expect.objectContaining({
      handsSatOut: 3, protectedUntil: until,
      message: 'You have sat out 3 hands in a row. If you are still away when late entry closes, you will be removed from the tournament.',
    })]);
    expect(w.m.awayStreakViewOf(w.tid, w.tables.get('TA'), 0)).toEqual({ handsSatOut: 3, handsLimit: 30, handsLeft: 27, protectedUntil: until });
    expect(w.m.awayStreakViewOf(w.tid, w.tables.get('TA'), 1)).toBeNull();   // nobody's run at a played seat
  });
});

/** Bring `pid` (away) to `n` hands sat out without dealing 30 real hands. */
function preCount(w: World, pid: string, n: number) {
  Object.assign(w.tp(pid), { sitOutHands: n, sitOutWarned: n >= 3 });
}

describe('the removal at 30 — as if busted, at the hand end, through the bust check', () => {
  it('the 30th hand: removed at its end — place alive+1, NOT disqualified, seat dead (0 chips, eliminated), no bounty, the rebalance runs, every notice says why', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100), TB: field('b', 3, 20000, 200) }, config: { isBounty: true, bountyAmount: 500 } });
    w.seatEveryoneExcept('a0');
    const lobby = w.mkSocket('L1', 100);
    preCount(w, 'a0', LIMIT - 1);
    const TA = w.tables.get('TA')!;
    await w.playHand('TA');
    const p = w.tp('a0');
    expect(p).toMatchObject({ eliminated: true, finishPosition: 6, removedFor: 'sat_out_limit' });
    expect(p.disqualified).toBeUndefined();
    const t = w.tm.getTournament(w.tid)!;
    expect(t.players.reduce((n, x) => n + x.bounties, 0)).toBe(0);         // nobody collects a bounty
    // His seat is dead: 0 chips, eliminated (his chips left play).
    expect({ chips: TA.seats[0].chipCount, eliminated: TA.seats[0].eliminated, pid: TA.seats[0].playerId }).toEqual({ chips: 0, eliminated: true, pid: 'a0' });
    // The rebalance ran at once: 5 alive fit one table, TA broke into TB.
    expect(t.tableIds).toEqual(['TB']);
    // His own socket: the plain notice WITH the reason; the room copy too.
    expect(evs(lobby, 'playerEliminated')).toEqual([{ tournamentId: w.tid, playerId: 'a0', playerName: 'a0', position: 6, reason: 'sat_out_limit', handsSatOut: 30 }]);
    const room = w.roomEmits.filter(([, ev, d]) => ev === 'playerEliminated' && d.reason === 'sat_out_limit');
    expect(room.length).toBeGreaterThan(0);
    expect(room[0][2]).toMatchObject({ position: 6, reason: 'sat_out_limit', handsSatOut: 30 });
    expect(room[0][2].eliminatorId).toBeUndefined();
    // Durable record + log + health.
    expect(w.audits.filter((a) => a.action === 'TOURNAMENT_SIT_OUT_REMOVED').map((a) => a.d)).toEqual([expect.objectContaining({
      tournamentId: w.tid, tableId: 'TA', playerId: 'a0', place: 6, placeFinal: true, handsSatOut: 30,
    })]);
    expect(w.logs.some((l) => l.includes('"event":"tournament_sit_out_removed"'))).toBe(true);
    expect(w.m.awayStreakStats.removed).toBe(1);
    // He kept his place: the event plays out and a0 is 6th, paid as a 6th (not dropped as disqualified).
    for (const x of [...t.players]) if (!x.eliminated && x.playerId !== 'b0') w.tm.eliminatePlayer(w.tid, x.playerId);
    expect(t.status).toBe('finished');
    expect(t.players.map((x) => x.finishPosition).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(w.tp('a0').finishPosition).toBe(6);
  });

  it('CONTROL: without the removal in the bust check, the 30th hand leaves him alive with his chips', async () => {
    const helpers = P.helpers.replace(
      '  const removedNow: Set<number> = check?.awayLimitSeats && check.awayLimitSeats.size > 0',
      '  const removedNow: Set<number> = false',
    );
    expect(helpers).not.toBe(P.helpers);
    const w = world({ layout: { TA: field('a', 3, 20000, 100) }, over: { helpers } });
    w.seatEveryoneExcept('a0');
    preCount(w, 'a0', LIMIT - 1);
    await w.playHand('TA');
    expect(w.tp('a0').eliminated).toBe(false);
    expect(w.seatOf('a0')!.seat.chipCount).toBeGreaterThan(0);
  });

  it('the table does NOT deal again before the check removed him (the deal waits for the pending capture)', async () => {
    const gate = deferred();
    const noop = () => undefined;
    const progressionManager = new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => {
        if (k === 'getClientProgress') return () => ({ hydrated: true, xp: 0, level: 1, achievements: [] });
        if (k === 'getProgress') return () => ({});
        return noop;
      },
    });
    const w = world({
      layout: { TA: field('a', 3, 20000, 100) },
      scope: {
        progressionManager, sendProgressToPlayer: noop, saveProgress: async () => true, tickScratchProgress: async () => false, pushActivity: noop,
        mergeUserStats: async () => { await gate.p; },
      },
    });
    w.seatEveryoneExcept('a0');
    preCount(w, 'a0', LIMIT - 1);
    const t = w.tables.get('TA')!;
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 300 && t.isHandInProgress(); g++) {
      const a = t.activeSeatIndex;
      if (!w.m.seatHasPlayingSession('TA', a)) w.m.autoActForSeat('TA', t, a, 'away');
      else if (!t.playerCheck(a)) t.playerFold(a);
    }
    const hand = t.handNumber;
    await flush();
    expect(w.m.tournamentBustChecksPending.get('TA')?.get(hand)?.awayLimitSeats?.get(0)).toBe('a0');
    w.m.autoStartNextHand('TA');
    expect(t.handNumber).toBe(hand);                                          // held for the bust check
    expect(w.tp('a0').eliminated).toBe(false);
    gate.resolve();
    await w.pending.get('TA');
    await flush();
    expect(w.tp('a0').eliminated).toBe(true);
    expect(t.handNumber).toBe(hand);
  });

  it('never MID-HAND: a (late) check that runs while the next hand is in progress skips him; he is removed at THAT hand\'s end', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    preCount(w, 'a0', LIMIT);
    const t = w.tables.get('TA')!;
    expect(t.startNewHand()).toBe(true);                    // a hand in progress
    const stack = t.seats[0].chipCount;
    const late = {
      handNumber: t.handNumber - 1, capturedAt: Date.now() - 30_000, orderedWinnerIds: [], eliminatorBySeat: new Map(), ran: false,
      startChips: new Map([[0, 20000], [1, 20000], [2, 20000]]), bustedThisHand: new Map(), awayLimitSeats: new Map([[0, 'a0']]),
    };
    w.m.runTournamentBustCheck('TA', t, late, 'deal_guard_stale');
    expect(w.tp('a0').eliminated).toBe(false);
    expect(t.seats[0].chipCount).toBe(stack);
    expect(w.logs.some((l) => l.includes('"skip":"hand_in_progress"'))).toBe(true);
    // The hand plays out (he is still away): its own hand end removes him.
    await w.playHand('TA', undefined, { deal: false });
    expect(w.tp('a0').sitOutHands).toBe(LIMIT + 1);
    expect(w.tp('a0')).toMatchObject({ eliminated: true, removedFor: 'sat_out_limit' });
  });

  it('never TWICE: at 30 on the very hand he busts, he is busted ONCE (by the pot winner), not removed', async () => {
    const w = world({ layout: { TA: field('a', 2, 20000, 100), TB: field('b', 2, 20000, 200) } });
    w.seatEveryoneExcept('a0');
    preCount(w, 'a0', LIMIT - 1);
    const t = w.tables.get('TA')!;
    // a0 is all-in for his whole stack and loses: simulate a finished hand (0 chips, a1 won).
    t.seats[0].holeCards = [{ rank: 2, suit: 0 }, { rank: 7, suit: 1 }] as any;
    t.seats[1].holeCards = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }] as any;
    t.seats[0].chipCount = 0;
    t.seats[1].chipCount = 40000;
    (t as any).currentPhase = GamePhase.HandComplete;
    await w.m.handleHandComplete('TA', [{ seatIndex: 1, amount: 20000 }]);
    await flush();
    expect(w.tp('a0')).toMatchObject({ eliminated: true });
    expect(w.tp('a0').removedFor).toBeUndefined();
    expect(w.tm.getTournament(w.tid)!.eliminationOrder.filter((x) => x === 'a0')).toHaveLength(1);
  });

  it('two removed on the SAME hand with EQUAL pre-hand stacks TIE (as same-hand busts); a bigger pre-hand stack finishes better', async () => {
    const w = world({ layout: { TA: [...field('a', 2, 20000, 100), ...field('c', 2, 20000, 300)], TB: field('b', 2, 20000, 200) } });
    const TA = w.tables.get('TA')!;
    // TA: a0, a1 away (equal stacks); c0, c1 present. TB: b0, b1 present.
    w.seatEveryoneExcept('a0', 'a1');
    preCount(w, 'a0', LIMIT - 1);
    preCount(w, 'a1', LIMIT - 1);
    // Both start the hand with 20000 (PokerTable.startChips: the stacks BEFORE blinds / antes).
    await w.playHand('TA');
    expect([TA.startChips.get(0), TA.startChips.get(1)]).toEqual([20000, 20000]);
    const a0 = w.tp('a0');
    const a1 = w.tp('a1');
    expect([a0.eliminated, a1.eliminated]).toEqual([true, true]);
    expect([a0.finishPosition, a1.finishPosition].sort()).toEqual([5, 6]);
    expect(a0.tieGroup).toBeDefined();
    expect(a0.tieGroup).toBe(a1.tieGroup);
  });

  it('equal pre-hand stacks of two removals on one hand → one tie group (direct capture)', () => {
    const w = world({ layout: { TA: [...field('a', 2, 20000, 100), ...field('c', 2, 20000, 300)], TB: field('b', 2, 20000, 200) } });
    w.seatEveryoneExcept('a0', 'a1');
    const TA = w.tables.get('TA')!;
    preCount(w, 'a0', LIMIT);
    preCount(w, 'a1', LIMIT);
    const c = {
      handNumber: 7, capturedAt: Date.now(), orderedWinnerIds: ['c0'], eliminatorBySeat: new Map(), ran: false,
      startChips: new Map([[0, 18000], [1, 18000], [2, 20000], [3, 20000]]), bustedThisHand: new Map(),
      awayLimitSeats: new Map([[0, 'a0'], [1, 'a1']]),
    };
    w.m.runTournamentBustCheck('TA', TA, c, 'test');
    const a0 = w.tp('a0');
    const a1 = w.tp('a1');
    expect([a0.eliminated, a1.eliminated]).toEqual([true, true]);
    expect(a0.tieGroup).toBeDefined();
    expect(a0.tieGroup).toBe(a1.tieGroup);
    expect([a0.finishPosition, a1.finishPosition].sort()).toEqual([5, 6]);
    // CONTROL: without the removal in the tie grouping, they are ordered by seat number only.
    const helpers = P.helpers.replace(
      "      if (!s || (check.bustedThisHand.get(i) !== s.playerId && !removedNow.has(i))) continue;   // + this hand's removals (2026-11-25)",
      '      if (!s || check.bustedThisHand.get(i) !== s.playerId) continue;',
    );
    expect(helpers).not.toBe(P.helpers);
    const w2 = world({ layout: { TA: [...field('a', 2, 20000, 100), ...field('c', 2, 20000, 300)], TB: field('b', 2, 20000, 200) }, over: { helpers } });
    w2.seatEveryoneExcept('a0', 'a1');
    preCount(w2, 'a0', LIMIT);
    preCount(w2, 'a1', LIMIT);
    w2.m.runTournamentBustCheck('TA', w2.tables.get('TA'), { ...c, ran: false, awayLimitSeats: new Map([[0, 'a0'], [1, 'a1']]) }, 'test');
    expect(w2.tp('a0').tieGroup).toBeUndefined();
  });

  it('a removal and a BUST on the same hand are ordered together by pre-hand stack (the bigger stack finishes better)', () => {
    const w = world({ layout: { TA: [...field('a', 2, 20000, 100), ...field('c', 2, 20000, 300)], TB: field('b', 2, 20000, 200) } });
    w.seatEveryoneExcept('a0');
    const TA = w.tables.get('TA')!;
    preCount(w, 'a0', LIMIT);
    TA.seats[1].chipCount = 0;                               // a1 busted this hand (pre-hand 30000)
    const c = {
      handNumber: 3, capturedAt: Date.now(), orderedWinnerIds: ['c0'], eliminatorBySeat: new Map([[1, 'c0']]), ran: false,
      startChips: new Map([[0, 12000], [1, 30000], [2, 20000], [3, 20000]]), bustedThisHand: new Map([[1, 'a1']]),
      awayLimitSeats: new Map([[0, 'a0']]),
    };
    w.m.runTournamentBustCheck('TA', TA, c, 'test');
    expect(w.tp('a0').finishPosition).toBe(6);              // the smaller pre-hand stack: worse
    expect(w.tp('a1').finishPosition).toBe(5);
  });

  it('an I\'m back (or an action) during the hand-end awaits CANCELS the removal; nobody playing the seat NOW is required', () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    const TA = w.tables.get('TA')!;
    preCount(w, 'a0', LIMIT);
    const mk = () => ({
      handNumber: 4, capturedAt: Date.now(), orderedWinnerIds: [], eliminatorBySeat: new Map(), ran: false,
      startChips: new Map([[0, 20000], [1, 20000], [2, 20000]]), bustedThisHand: new Map(), awayLimitSeats: new Map([[0, 'a0']]),
    });
    w.m.awayStreakResetAt('TA', 0, 'back');
    w.m.runTournamentBustCheck('TA', TA, mk(), 'test');
    expect(w.tp('a0').eliminated).toBe(false);
    // A restore (a sign-in) during the awaits: he plays the seat now — not removed now (counted on).
    preCount(w, 'a0', LIMIT);
    w.seatLive('S-a0', 'TA', 0);
    w.m.runTournamentBustCheck('TA', TA, mk(), 'test');
    expect(w.tp('a0').eliminated).toBe(false);
    expect(w.logs.filter((l) => l.includes('tournament_sit_out_removal_skipped')).map((l) => JSON.parse(l.slice(l.indexOf('{'))).skip)).toEqual(['back', 'playing']);
  });

  it('heads-up, BOTH at 30 on one hand: never the last one standing — the smaller stack is removed, the other WINS', () => {
    const w = world({ layout: { TA: field('a', 2, 20000, 100) } });
    const TA = w.tables.get('TA')!;
    preCount(w, 'a0', LIMIT);
    preCount(w, 'a1', LIMIT);
    TA.seats[0].chipCount = 15000;
    TA.seats[1].chipCount = 25000;
    const c = {
      handNumber: 50, capturedAt: Date.now(), orderedWinnerIds: [], eliminatorBySeat: new Map(), ran: false,
      startChips: new Map([[0, 15000], [1, 25000]]), bustedThisHand: new Map(), awayLimitSeats: new Map([[0, 'a0'], [1, 'a1']]),
    };
    w.m.runTournamentBustCheck('TA', TA, c, 'test');
    const t = w.tm.getTournament(w.tid)!;
    expect(t.status).toBe('finished');
    expect(w.tp('a0').finishPosition).toBe(2);
    expect(w.tp('a1').finishPosition).toBe(1);
    expect(w.tp('a1').removedFor).toBeUndefined();
    expect(TA.seats[1].chipCount).toBe(25000);
  });

  it('a removal during an engaged HAND-FOR-HAND round is one of the round\'s busts: placed at the settle by starting stack, told then (with the reason)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100), TB: field('b', 3, 20000, 200) } });
    w.seatEveryoneExcept('a0');
    const lobby = w.mkSocket('L1', 100);
    const TA = w.tables.get('TA')!;
    const TB = w.tables.get('TB')!;
    const st: any = {
      tournamentId: w.tid, qualifierId: null, engagedAt: Date.now(), rounds: 1,
      round: { no: 1, order: ['TA', 'TB'], base: new Map([['TA', 6], ['TB', 8]]), attempted: new Set(), startedAt: Date.now(), busts: [] },
      held: new Set(), heldSince: null, watchdog: null, progress: new Map(), extendedRound: null,
    };
    w.m.handForHandStates.set(w.tid, st);
    preCount(w, 'a0', LIMIT);
    // TB's round hand (9): b1 busts first (pre-hand 15000) → provisional 6th.
    TB.seats[1].chipCount = 0;
    w.m.runTournamentBustCheck('TB', TB, {
      handNumber: 9, capturedAt: Date.now(), orderedWinnerIds: ['b0'], eliminatorBySeat: new Map([[1, 'b0']]), ran: false,
      startChips: new Map([[0, 20000], [1, 15000], [2, 20000]]), bustedThisHand: new Map([[1, 'b1']]),
    }, 'test');
    expect(w.tp('b1').finishPosition).toBe(6);
    // TA's round hand (7), checked later: a0 removed (pre-hand 9000) → provisional 5th.
    TA.seats[0].chipCount = 9000;
    w.m.runTournamentBustCheck('TA', TA, {
      handNumber: 7, capturedAt: Date.now(), orderedWinnerIds: [], eliminatorBySeat: new Map(), ran: false,
      startChips: new Map([[0, 9000], [1, 20000], [2, 20000]]), bustedThisHand: new Map(), awayLimitSeats: new Map([[0, 'a0']]),
    }, 'test');
    expect(w.tp('a0')).toMatchObject({ eliminated: true, finishPosition: 5 });
    expect(st.round.busts.map((b: any) => b.playerId)).toEqual(['b1', 'a0']);
    expect(evs(lobby, 'playerEliminated')).toEqual([]);                     // quiet until the settle
    w.m.placeAndTellHandForHandBusts(st);
    // Re-placed with the round's busts by starting stack: the smaller (a0, 9000) takes the worse place.
    expect(w.tp('a0').finishPosition).toBe(6);
    expect(w.tp('b1').finishPosition).toBe(5);
    expect(evs(lobby, 'playerEliminated')).toEqual([expect.objectContaining({ playerId: 'a0', position: 6, reason: 'sat_out_limit', handsSatOut: 30 })]);
    const roomA0 = w.roomEmits.filter(([, ev, d]) => ev === 'playerEliminated' && d.handForHand && d.reason === 'sat_out_limit');
    expect(roomA0.length).toBeGreaterThan(0);
    expect(w.audits.find((a) => a.action === 'TOURNAMENT_SIT_OUT_REMOVED')!.d).toMatchObject({ placeFinal: false });
  });
});

describe('a removed player nobody could tell: one notice at his next sign-in', () => {
  it('qualifier / league (outside the durable results): told ONCE at sign-in with the reason; a non-qualifier event queues nothing (its durable result tells him)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100), TB: field('b', 3, 20000, 200) } });
    w.seatEveryoneExcept('a0');
    preCount(w, 'a0', LIMIT - 1);
    await w.playHand('TA');
    expect(w.tp('a0').eliminated).toBe(true);
    expect(w.m.removalSignInNotices.size).toBe(1);
    const s = w.mkSocket('S-signin', 100);
    w.m.tellKeptTournamentSeats(s, w.authSessions.get('S-signin'), 'voluntary', 'oauthLogin');
    expect(evs(s, 'playerEliminated')).toEqual([expect.objectContaining({
      tournamentId: w.tid, playerId: 'a0', position: 6, atSignIn: true, reason: 'sat_out_limit', handsSatOut: 30,
    })]);
    w.m.tellKeptTournamentSeats(s, w.authSessions.get('S-signin'), 'voluntary', 'oauthLogin');
    expect(evs(s, 'playerEliminated')).toHaveLength(1);                      // once
    const w2 = world({ layout: { TA: field('a', 3, 20000, 100), TB: field('b', 3, 20000, 200) }, scope: { tournamentResultsInScope: () => true } });
    w2.seatEveryoneExcept('a0');
    preCount(w2, 'a0', LIMIT - 1);
    await w2.playHand('TA');
    expect(w2.tp('a0').eliminated).toBe(true);
    expect(w2.m.removalSignInNotices.size).toBe(0);
  });
});

describe('a non-qualifier event: its durable untold result tells him at sign-in, now with the reason', () => {
  it('tellUnseenTournamentResults adds reason / handsSatOut for a removed entrant still known here (running and finished)', async () => {
    const tm = new TournamentManager();
    const tid = tm.createTournament({ name: 'Cup', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: SB, bb: BB, ante: 0, duration: 600 }] } as any);
    for (let i = 0; i < 3; i++) tm.registerPlayer(tid, `user-${i}`, `P${i}`, `s${i}`, i + 1);
    tm.startTournament(tid);
    Object.assign(tm.getTournament(tid)!.players[0], { removedFor: 'sat_out_limit', removedSatOutHands: 30 });
    tm.eliminatePlayer(tid, 'user-0');
    const rows = [
      { tournamentId: tid, playerId: 'user-0', playerName: 'P0', place: 3, prize: 0, name: 'Cup', status: 'running' },
      { tournamentId: tid, playerId: 'user-1', playerName: 'P1', place: 9, prize: 0, name: 'Cup', status: 'finished' },
    ];
    const emitted: Array<[string, any]> = [];
    const socket: any = { id: 'S1', connected: true, emit: (ev: string, d: any) => emitted.push([ev, d]) };
    const auth = { userId: 1, masterUserId: 'm-1' };
    const { exports: m } = load(fnSrc('function removalNoticeFields(') + fnSrc('function tellUnseenTournamentResults('), {
      tournamentResults: { unseenFor: async () => rows, markTold: async () => {} },
      tournamentManager: tm, authSessions: new Map([['S1', auth]]), console: { log() {}, warn() {}, error() {} },
    }, '{ tellUnseenTournamentResults }');
    m.tellUnseenTournamentResults(socket, auth, null);
    await flush();
    expect(emitted).toEqual([
      ['playerEliminated', { tournamentId: tid, playerId: 'user-0', playerName: 'P0', position: 3, atSignIn: true, reason: 'sat_out_limit', handsSatOut: 30 }],
      ['tournamentFinishedForEntrant', { tournamentId: tid, position: 9, tournamentName: 'Cup', atSignIn: true }],   // not removed: no reason
    ]);
    const t = tm.getTournament(tid)!;
    if (t.blindTimer) clearTimeout(t.blindTimer);
  });
});

describe('the Online League first hour: protected until he plays a hand, removed at the first hand end after it', () => {
  it('seated absent at the start: hands count, never removed before lateRegUntil; removed at the first hand end after it (health removedProtectedAfterHour)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    let now = Date.parse('2026-11-26T01:00:00.000Z');           // 6:00 PM MT
    const until = now + 60 * 60_000;                            // 7:00 PM MT
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect(w.m.markLeagueFirstHour(w.tid, until)).toBe(3);   // the whole night: nobody has played a hand yet
      expect(w.tm.getTournament(w.tid)!.leagueFirstHourUntil).toBe(until);
      preCount(w, 'a0', LIMIT + 5);
      now = until - 1000;
      await w.playHand('TA');
      expect(w.tp('a0').eliminated).toBe(false);
      expect(w.tp('a0').sitOutHands).toBe(LIMIT + 6);            // still counting
      expect(w.m.awayStreakStats.protectedHands).toBe(1);
      now = until + 1000;
      await w.playHand('TA');
      expect(w.tp('a0').eliminated).toBe(true);
      expect(w.tp('a0').removedFor).toBe('sat_out_limit');
      expect(w.m.awayStreakStats.removedProtectedAfterHour).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Review fix (2026-11-26) — the owner's order: "if still away then, removed at the first hand end
  // after lateRegUntil". The removal used to wait for 30 as well: a no-show at 22 hands at 7:00 PM
  // stayed in, blinded, until about his 30th hand — against his own warning ("If you are still away
  // when late entry closes, you will be removed") and the client's noShow line (never sent).
  const SIX_PM_MT = Date.parse('2026-11-26T01:00:00.000Z');          // 6:00 PM MT
  const noShowNight = (over?: Partial<typeof P>) => {
    const w = world({ layout: { TA: field('a', 4, 20000, 100) }, over });
    w.seatEveryoneExcept('a0');                                   // a1 is HERE at the start: not a no-show
    return w;
  };

  it('a no-show still away when late entry closes is removed at the FIRST hand end after it at ANY count (22 here): noShow: true, his real count, next place', async () => {
    const w = noShowNight();
    let now = SIX_PM_MT;
    const until = now + 60 * 60_000;                              // 7:00 PM MT
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect(w.m.markLeagueFirstHour(w.tid, until)).toBe(4);
      await w.playHand('TA');                                     // 6:00 PM: a1..a3 PLAY a hand, a0 is away
      expect(w.tp('a1').playedAHand).toBe(true);
      w.playerSessions.delete('S-a1');                            // a1 leaves AFTER playing a hand: away, NOT protected
      const lobby = w.mkSocket('L1', 100);
      preCount(w, 'a0', 21);
      preCount(w, 'a1', 21);
      now = until - 1000;
      await w.playHand('TA');
      expect(w.tp('a0')).toMatchObject({ eliminated: false, sitOutHands: 22 });
      // Before 7:00 PM his view is protected; after it, he goes at THIS hand's end: 1 left.
      expect(w.m.awayStreakViewOf(w.tid, w.tables.get('TA'), 0)).toEqual({ handsSatOut: 22, handsLimit: 30, handsLeft: 8, protectedUntil: until });
      now = until + 1000;
      expect(w.m.awayStreakViewOf(w.tid, w.tables.get('TA'), 0)).toEqual({ handsSatOut: 22, handsLimit: 30, handsLeft: 1, protectedUntil: null });
      await w.playHand('TA');
      expect(w.tp('a0')).toMatchObject({
        eliminated: true, finishPosition: 4, sitOutHands: 23, removedFor: 'sat_out_limit', removedSatOutHands: 23, removedNoShow: true,
      });
      expect(w.tp('a0').disqualified).toBeUndefined();
      // a1 (away, played a hand: no first hour, 23) is NOT touched by the no-show rule: he still has 7 hands.
      expect(w.tp('a1')).toMatchObject({ eliminated: false, sitOutHands: 23 });
      expect(w.tp('a1').removedNoShow).toBeUndefined();
      expect(evs(lobby, 'playerEliminated')).toEqual([{
        tournamentId: w.tid, playerId: 'a0', playerName: 'a0', position: 4, reason: 'sat_out_limit', handsSatOut: 23, noShow: true,
      }]);
      // The room copy (TournamentManager's, its player id masked for the room) carries the flag too.
      const room = w.roomEmits.filter(([, ev, d]) => ev === 'playerEliminated' && d.reason === 'sat_out_limit');
      expect(room).toHaveLength(1);
      expect(room[0][2]).toMatchObject({ position: 4, reason: 'sat_out_limit', handsSatOut: 23, noShow: true });
      expect(w.audits.find((a) => a.action === 'TOURNAMENT_SIT_OUT_REMOVED')!.d).toMatchObject({ playerId: 'a0', place: 4, noShow: true, handsSatOut: 23 });
      expect(w.m.awayStreakStats.removedProtectedAfterHour).toBe(1);
      // A re-entry clears the no-show reason with the rest.
      expect(w.tm.reinstateForReentry(w.tid, 'a0', 20000)).toBe(true);
      expect(w.tp('a0')).not.toHaveProperty('removedNoShow');
    } finally {
      spy.mockRestore();
    }
  });

  it('CONTROL: with the pre-fix hand-end rule (30 needed) the same no-show stays in after 7:00 PM, blinded', async () => {
    const old = P.absentClock.replace(
      '      if (tp.sitOutHands < TOURNAMENT_SIT_OUT_HANDS_LIMIT && !noShowDue) continue;',
      '      if (tp.sitOutHands < TOURNAMENT_SIT_OUT_HANDS_LIMIT) continue;',
    );
    expect(old).not.toBe(P.absentClock);
    const w = noShowNight({ absentClock: old });
    let now = SIX_PM_MT;
    const until = now + 60 * 60_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect(w.m.markLeagueFirstHour(w.tid, until)).toBe(4);
      preCount(w, 'a0', 21);
      now = until + 1000;
      await w.playHand('TA');
      expect(w.tp('a0')).toMatchObject({ eliminated: false, sitOutHands: 22 });
    } finally {
      spy.mockRestore();
    }
  });

  it('the bust check re-checks the same rule: a due entrant (no hand played, past 7:00 PM) at 10 is removed; one who PLAYED a hand is skipped as back, one a sign-in plays NOW as playing; CONTROL: the pre-fix re-check skipped the due one', () => {
    const mk = () => ({
      handNumber: 4, capturedAt: Date.now(), orderedWinnerIds: [], eliminatorBySeat: new Map(), ran: false,
      startChips: new Map([[0, 20000], [1, 20000], [2, 20000], [3, 20000]]), bustedThisHand: new Map(), awayLimitSeats: new Map([[0, 'a0']]),
    });
    const due = (w: World) => {
      w.tm.getTournament(w.tid)!.leagueFirstHourUntil = Date.now() - 1000;   // the league night's first hour is over
      Object.assign(w.tp('a0'), { sitOutHands: 10, sitOutWarned: true });    // no hand played (playedAHand unset)
    };
    const w = noShowNight();
    due(w);
    w.m.runTournamentBustCheck('TA', w.tables.get('TA'), mk(), 'test');
    expect(w.tp('a0')).toMatchObject({ eliminated: true, removedNoShow: true, removedSatOutHands: 10 });
    // He PLAYED a hand (the flag a played hand end sets): not removed at 10.
    const w2 = noShowNight();
    due(w2);
    w2.tp('a0').playedAHand = true;
    w2.m.runTournamentBustCheck('TA', w2.tables.get('TA'), mk(), 'test');
    expect(w2.tp('a0').eliminated).toBe(false);
    expect(w2.logs.some((l) => l.includes('"skip":"back"'))).toBe(true);
    // A sign-in during the hand-end awaits put a session on his seat: he is not away now.
    const w2b = noShowNight();
    due(w2b);
    w2b.seatLive('S-a0', 'TA', 0);
    w2b.m.runTournamentBustCheck('TA', w2b.tables.get('TA'), mk(), 'test');
    expect(w2b.tp('a0').eliminated).toBe(false);
    expect(w2b.logs.some((l) => l.includes('"skip":"playing"'))).toBe(true);
    // CONTROL: the pre-fix re-check.
    const helpers = P.helpers.replace(
      '    else if ((tp.sitOutHands || 0) < TOURNAMENT_SIT_OUT_HANDS_LIMIT && !awayStreakNoShowDue(t, tp, now)) skip = \'back\';',
      '    else if ((tp.sitOutHands || 0) < TOURNAMENT_SIT_OUT_HANDS_LIMIT) skip = \'back\';',
    );
    expect(helpers).not.toBe(P.helpers);
    const w3 = noShowNight({ helpers });
    due(w3);
    w3.m.runTournamentBustCheck('TA', w3.tables.get('TA'), mk(), 'test');
    expect(w3.tp('a0').eliminated).toBe(false);
  });

  it('a no-show whose 3rd hand ends after 7:00 PM is removed WITHOUT a "come back within 27 hands" warning first (CONTROL: the warning went out)', async () => {
    const run = async (over?: Partial<typeof P>) => {
      const w = noShowNight(over);
      let now = SIX_PM_MT;
      const until = now + 60 * 60_000;
      const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        w.m.markLeagueFirstHour(w.tid, until);
        const lobby = w.mkSocket('L1', 100);
        preCount(w, 'a0', 2);
        now = until + 1000;
        await w.playHand('TA');
        return { w, warned: evs(lobby, 'tournamentSitOutWarning') };
      } finally {
        spy.mockRestore();
      }
    };
    const fixed = await run();
    expect(fixed.w.tp('a0')).toMatchObject({ eliminated: true, removedNoShow: true, removedSatOutHands: 3 });
    expect(fixed.warned).toEqual([]);
    const old = P.absentClock.replace(
      '!tp.sitOutWarned && !noShowDue) awayStreakWarn(',
      '!tp.sitOutWarned) awayStreakWarn(',
    );
    expect(old).not.toBe(P.absentClock);
    const ctl = await run({ absentClock: old });
    expect(ctl.warned).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------------
  // 2026-11-26 (owner 2026-11-25 ~11:15 PM MT, replaces the "never arrived" rule): "A player who is
  // seated before 6 and then leaves before never played a hand so they should get the 1st hour to
  // play a hand." The first hour belongs to EVERY entrant who has NOT PLAYED A HAND yet in the event
  // (a hand end dealt in at his live seat with a voluntary action, or a session PLAYING the seat).
  // runNight: 4 entrants at TA, everyone at his seat but a0 (never came: away at the start); the
  // league start marks the night (markLeagueFirstHour, 7:00 PM); `pid` (a1 unless named) is brought
  // to 29 hands sat out; his 30th ends at 6:20 PM (inside the first hour); then one hand ends at
  // 7:00:01 PM (the first hand end after it).
  // CONTROL `previous` = the PREVIOUS rule (039757f): a per-ENTRY mark (sitOutProtectedUntil) on
  // the start's NAMED "never arrived" no-shows only (marked here as the start named them), ended
  // by a sign-in restore or by a played / acted hand. tests/r2Qualifiers.test.ts E7e / E7f run the
  // REAL starts.
  // ---------------------------------------------------------------------------------------------
  const MIN = 60_000;
  const SEVEN_PM_MT = SIX_PM_MT + 60 * MIN;
  const MARK_PLAYED = '      if (acted || played) tp.playedAHand = true;';
  const previousRule = (): Partial<typeof P> => {
    const firstHour = fnSrc('function awayStreakFirstHourUntil(');
    const returned = '  tournamentSeatKeep.returned++;\n';
    expect(P.absentClock).toContain(firstHour);
    expect(P.absentClock).toContain(MARK_PLAYED);
    expect(P.seatKeep.split(returned).length).toBe(2);
    return {
      absentClock: P.absentClock
        .replace(firstHour, "function awayStreakFirstHourUntil(t, tp) {\n  return typeof tp.sitOutProtectedUntil === 'number' ? tp.sitOutProtectedUntil : null;\n}\n")
        .replace(MARK_PLAYED, '      if (acted || played) delete tp.sitOutProtectedUntil;'),
      // The previous sign-in restore ended the mark ("he arrived").
      seatKeep: P.seatKeep.replace(returned, `  delete tp.sitOutProtectedUntil;\n${returned}`),
    };
  };
  interface Night {
    pid?: string;
    /** Who is where at 6:00 PM (before the start's mark). */
    before?: (w: World) => void;
    /** After the mark, before his 30th hand. */
    after?: (w: World) => void | Promise<void>;
    /** CONTROL: the previous rule; the start NAMED these "never arrived" no-shows. */
    previous?: string[];
    over?: Partial<typeof P>;
    /** false = no league mark (the weekly / every other tournament). */
    league?: boolean;
    /** Who acts for a seat in the 6:20 PM / 7:00 PM hands (default: playHand's own rule). */
    act?: (w: World) => (seatIndex: number, t: PokerTable) => boolean;
  }
  interface NightRun { w: World; at30: any; view: any; after: any }
  const runNight = async (c: Night): Promise<NightRun> => {
    const pid = c.pid ?? 'a1';
    const over = c.previous ? { ...previousRule(), ...(c.over || {}) } : c.over;
    const w = world({ layout: { TA: field('a', 4, 20000, 100) }, over });
    w.seatEveryoneExcept('a0');
    c.before?.(w);
    let now = SIX_PM_MT;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      if (c.league !== false) w.m.markLeagueFirstHour(w.tid, SEVEN_PM_MT);
      for (const id of c.previous || []) (w.tp(id) as any).sitOutProtectedUntil = SEVEN_PM_MT;
      await c.after?.(w);
      preCount(w, pid, LIMIT - 1);
      const act = c.act?.(w);
      now = SIX_PM_MT + 20 * MIN;
      await w.playHand('TA', act);                              // his 30th hand sat out, at 6:20 PM
      const at = w.seatOf(pid);
      const at30 = { ...w.tp(pid) };
      const view = at ? w.m.awayStreakViewOf(w.tid, at.table, at.seatIndex) : null;
      now = SEVEN_PM_MT + 1000;
      await w.playHand('TA', act);                              // the first hand end after 7:00 PM
      return { w, at30, view, after: { ...w.tp(pid) } };
    } finally {
      spy.mockRestore();
    }
  };
  /** The first hour: kept at 30 through 7:00 PM (protectedUntil shown), removed at the first hand end after it (noShow, real count). */
  const expectFirstHour = (r: NightRun) => {
    expect(r.at30).toMatchObject({ eliminated: false, sitOutHands: LIMIT });
    expect(r.view).toEqual({ handsSatOut: LIMIT, handsLimit: LIMIT, handsLeft: 0, protectedUntil: SEVEN_PM_MT });
    expect(r.after).toMatchObject({
      eliminated: true, sitOutHands: LIMIT + 1, removedFor: 'sat_out_limit', removedSatOutHands: LIMIT + 1, removedNoShow: true,
    });
    expect(r.after.playedAHand).toBeUndefined();
    expect(r.after.disqualified).toBeUndefined();
  };
  /** No first hour: removed at 30 at 6:20 PM by the 30-hand rule (not as a no-show). */
  const expectRemovedAt30 = (r: NightRun) => {
    expect(r.at30).toMatchObject({ eliminated: true, sitOutHands: LIMIT, removedFor: 'sat_out_limit', removedSatOutHands: LIMIT });
    expect(r.at30.removedNoShow).toBeUndefined();
  };

  it('THE OWNER\'S CASE: SEATED at his early-room seat before 6:00 PM and LEFT before any hand — protected at 30 through 7:00 PM, removed at the first hand end after it (noShow); CONTROL: the previous rule (not named) removed him at 30 at 6:20 PM', async () => {
    const leftHisSeat = (w: World) => { w.playerSessions.delete('S-a1'); };   // back to the lobby: nobody plays his seat
    const r = await runNight({ before: leftHisSeat });
    expectFirstHour(r);
    // a0 never came: protected too, removed at the same hand end at his real count.
    expect(r.w.tp('a0')).toMatchObject({ eliminated: true, sitOutHands: 2, removedNoShow: true, removedSatOutHands: 2 });
    // Review fix (2026-11-26): the mark counts the whole field (firstHourEntrants); the REAL no-shows (a0, a1) at 7:00 PM.
    expect(r.w.m.awayStreakStats).toMatchObject({ firstHourEntrants: 4, noShowsAtHourEnd: 2, protectedHands: 1, removed: 2, removedProtectedAfterHour: 2 });
    const ctl = await runNight({ before: leftHisSeat, previous: ['a0'] });
    expectRemovedAt30(ctl);
    expect(ctl.w.tp('a0')).toMatchObject({ eliminated: true, removedNoShow: true });   // the named no-show: as now
  });

  it('AWAY at the start (never came): protected, removed after 7:00 PM — unchanged (the previous rule named him too)', async () => {
    expectFirstHour(await runNight({ pid: 'a0' }));
    expectFirstHour(await runNight({ pid: 'a0', previous: ['a0'] }));
  });

  it('PLAYING at another table at the start (his live socket sits at a cash table): protected; CONTROL: the previous rule (he was here) removed him at 30', async () => {
    const elsewhere = (w: World) => { w.playerSessions.set('S-a1', { ...w.playerSessions.get('S-a1'), tableId: 'CASH', seatIndex: 3 }); };
    const r = await runNight({ before: elsewhere });
    expectFirstHour(r);
    expect(r.w.playerSessions.get('S-a1')).toMatchObject({ tableId: 'CASH', seatIndex: 3 });   // his cash seat is untouched
    expectRemovedAt30(await runNight({ before: elsewhere, previous: ['a0'] }));
  });

  it('DROPPED less than 2 minutes before the start (his session is on a dead socket): protected; CONTROL: the previous rule (inside the grace: here) removed him at 30', async () => {
    const dropped = (w: World) => { w.live.get('S-a1').connected = false; };
    // A dead socket sends nothing: his clock runs out and the server acts for him (stamped auto).
    const serverActs = (w: World) => (a: number, t: PokerTable) => {
      if (a !== 1) return false;
      w.m.autoActForSeat('TA', t, 1, 'timeout');
      return true;
    };
    expectFirstHour(await runNight({ before: dropped, act: serverActs }));
    expectRemovedAt30(await runNight({ before: dropped, act: serverActs, previous: ['a0'] }));
  });

  // Review fix (2026-11-26, owner rule: "played a hand" must mean HE played it, never the server).
  it('THE OWNER\'S TAB-OPEN CASE: at his early-room seat on a LIVE socket, he walked away; his clock runs out at the 6:00 PM deal and the server\'s fold ENDS the hand (its hand end runs before the timeout sits him out) — not a played hand: protected at 30, removed after 7:00 PM; CONTROL: the pre-fix rule (a connected session at the hand end = played) took his first hour: removed at 30 at 6:20 PM', async () => {
    const timedOutAtTheDeal = async (w: World) => {
      const TA = w.tables.get('TA')!;
      TA.presetFirstButton(3);                                  // the 6:00 PM hand: a1 (seat 1) is the big blind, last to act
      let timedOut = false;
      await w.playHand('TA', (a, t) => {
        if (a === 2) { expect(t.playerRaise(2, 3 * BB)).toBe(true); return true; }   // a2 raises
        if (a === 3) { expect(t.playerFold(3)).toBe(true); return true; }            // a3 folds
        if (a !== 1) return false;                              // a0 (away): the server folds for him
        // His 30 s clock runs out (armTurnTimer's order): the server acts for him, THEN the
        // timeout rule sits him out (sitOutTournamentSeatAfterTimeout).
        expect(w.playerSessions.get('S-a1')).toMatchObject({ sittingOut: false });
        expect(w.live.get('S-a1').connected).toBe(true);    // the tab is open
        w.m.autoActForSeat('TA', t, 1, 'timeout');
        expect(t.isHandInProgress()).toBe(false);             // his fold ENDED the hand (its hand end has run)
        expect(w.m.sitOutTournamentSeatAfterTimeout('TA', 1)).toBe(true);
        timedOut = true;
        return true;
      });
      expect(timedOut).toBe(true);
      expect(TA.actionLog.some((e) => e.seatIndex === 1 && /^posted BB/.test(e.action))).toBe(true);
      expect(TA.actionLog.filter((e) => e.seatIndex === 1 && !/^posted /.test(e.action))).toEqual([
        expect.objectContaining({ action: 'folded', auto: 'timeout' }),
      ]);
      expect(w.playerSessions.get('S-a1')).toMatchObject({ sittingOut: true });   // sat out by the timeout, after the hand end
    };
    const r = await runNight({ after: timedOutAtTheDeal });
    expectFirstHour(r);
    expect(r.w.tp('a2').playedAHand).toBe(true);                // the raiser played (voluntary)
    expect(r.w.tp('a3').playedAHand).toBe(true);                // the folder played (voluntary)
    const ctl = await runNight({ after: timedOutAtTheDeal, over: prePlayedFix() });
    expect(ctl.at30.playedAHand).toBe(true);
    expectRemovedAt30(ctl);
  });

  it('SITTING OUT at his seat on a live socket from the start (sitting out is not playing a hand): protected; CONTROL: removed at 30', async () => {
    const satOut = (w: World) => { w.playerSessions.get('S-a1').sittingOut = true; };
    expectFirstHour(await runNight({ before: satOut }));
    expectRemovedAt30(await runNight({ before: satOut, previous: ['a0'] }));
  });

  it('SIGNED IN after the start (a sign-in restored his seat) but never played a hand, then LEFT: still protected; CONTROL: the previous rule (named, the restore ended the mark) removed him at 30', async () => {
    const away = (w: World) => { w.playerSessions.delete('S-a1'); };
    const signInThenLeave = (w: World) => {
      const s = w.mkSocket('S-back', 101);
      expect(w.m.restoreAbsentTournamentSeat(s, w.authSessions.get('S-back'), 'test')).toMatchObject({ tableId: 'TA', seatIndex: 1 });
      expect(w.tp('a1').playedAHand).toBeUndefined();          // a sign-in / restore alone is not a played hand
      w.playerSessions.delete('S-back');                         // he leaves before any hand ends
    };
    expectFirstHour(await runNight({ before: away, after: signInThenLeave }));
    expectRemovedAt30(await runNight({ before: away, after: signInThenLeave, previous: ['a0', 'a1'] }));
  });

  it('a LATE entrant who left before his first hand: protected (a fresh entry has played no hand); CONTROL: the previous rule never marked a late entrant: removed at 30', async () => {
    const lateEntry = (w: World) => {
      expect(w.tm.addLateEntrant(w.tid, 'late1', 'late1', 'reg-late1', 20000, { userId: 150 })).toBeTruthy();
      expect(w.tables.get('TA')!.sitDown(4, 'late1', 20000, 'late1', false, true)).toBe(true);
      w.tm.setPlayerTable(w.tid, 'late1', 'TA');
      expect(w.tp('late1').playedAHand).toBeUndefined();
    };
    expectFirstHour(await runNight({ pid: 'late1', after: lateEntry }));
    expectRemovedAt30(await runNight({ pid: 'late1', after: lateEntry, previous: ['a0'] }));
  });

  it('PLAYED one hand, then LEFT: NOT protected — the 30-hand rule at 6:20 PM; CONTROL: without the played-a-hand mark he would keep the first hour', async () => {
    const playOneThenLeave = async (w: World) => {
      await w.playHand('TA');                                   // 6:00 PM: he plays (checks / folds himself)
      w.playerSessions.delete('S-a1');
    };
    const r = await runNight({ after: playOneThenLeave });
    expect(r.at30.playedAHand).toBe(true);
    expectRemovedAt30(r);
    const noMark = P.absentClock.replace(MARK_PLAYED, '');
    expect(noMark).not.toBe(P.absentClock);
    const ctl = await runNight({ after: playOneThenLeave, over: { absentClock: noMark } });
    expect(ctl.at30).toMatchObject({ eliminated: false, sitOutHands: LIMIT });
  });

  it('a RE-ENTRANT (played a hand, busted, re-entered, left) is NOT protected: playedAHand survives the re-entry; CONTROL: a re-entry that cleared it would give the first hour back', async () => {
    const reenter = (clear: boolean) => async (w: World) => {
      await w.playHand('TA');                                   // he plays a hand …
      w.tm.eliminatePlayer(w.tid, 'a1');                        // … busts …
      expect(w.tm.reinstateForReentry(w.tid, 'a1', 20000)).toBe(true);   // … re-enters …
      if (clear) delete w.tp('a1').playedAHand;                 // (CONTROL: as if clearAwayStreak dropped it)
      expect(!!w.tp('a1').playedAHand).toBe(!clear);
      w.playerSessions.delete('S-a1');                          // … and leaves
    };
    expectRemovedAt30(await runNight({ after: reenter(false) }));
    const ctl = await runNight({ after: reenter(true) });
    expect(ctl.at30).toMatchObject({ eliminated: false, sitOutHands: LIMIT });
  });

  it('a WEEKLY (no league mark) is unchanged: one who never played is removed at 30 at 6:20 PM and an away one under 30 is NOT removed after 7:00 PM; CONTROL: the league mark protects the first and removes the second', async () => {
    const away = (w: World) => { w.playerSessions.delete('S-a1'); };
    const weekly = await runNight({ before: away, league: false });
    expectRemovedAt30(weekly);
    expect(weekly.w.tp('a0')).toMatchObject({ eliminated: false, sitOutHands: 2 });
    expect(weekly.w.tp('a0').removedNoShow).toBeUndefined();
    expect(weekly.w.tm.getTournament(weekly.w.tid)!.leagueFirstHourUntil).toBeUndefined();
    const league = await runNight({ before: away });
    expectFirstHour(league);
    expect(league.w.tp('a0')).toMatchObject({ eliminated: true, removedNoShow: true });
  });

  it('markLeagueFirstHour marks the NIGHT (nobody named): it counts the alive entrants with no hand played; a bad time or an unknown event marks nothing', async () => {
    const w = world({ layout: { TA: field('a', 4, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    await w.playHand('TA');                                     // a1..a3 played a hand; a0 is away
    expect(w.m.markLeagueFirstHour(w.tid, Number.NaN)).toBe(0);
    expect(w.m.markLeagueFirstHour('no-such-event', SEVEN_PM_MT)).toBe(0);
    expect(w.tm.getTournament(w.tid)!.leagueFirstHourUntil).toBeUndefined();
    expect(w.m.markLeagueFirstHour(w.tid, SEVEN_PM_MT)).toBe(1);   // a0 is the only one who has not played
    expect(w.tm.getTournament(w.tid)!.leagueFirstHourUntil).toBe(SEVEN_PM_MT);
    expect(w.m.awayStreakStats.firstHourEntrants).toBe(1);
    expect(w.logs.filter((l) => l.includes('"event":"tournament_no_show_protected"')).map((l) => JSON.parse(l.slice(l.indexOf('{'))))).toEqual([
      { event: 'tournament_no_show_protected', tournamentId: w.tid, until: SEVEN_PM_MT, entrants: 1 },
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // Review fix (2026-11-26) — health: `noShowsProtected` always equalled the whole field (both
  // league starts mark the night before any of its hands ends). Renamed `firstHourEntrants`; the
  // REAL no-show count is `noShowsAtHourEnd`: the alive entrants still with no hand played at the
  // night's FIRST hand end (any table) after 7:00 PM, once per night (Tournament.leagueNoShowsCounted).
  // ---------------------------------------------------------------------------------------------
  const NOTE_NO_SHOWS = '    noteLeagueNoShowsAtHourEnd(t, tournamentId, now);   // review fix 2026-11-26 — after this hand\'s played flags\n';
  const ONCE_GUARD = ' || t.leagueNoShowsCounted) return;\n  t.leagueNoShowsCounted = true;\n';
  /** 12 entrants on two tables; a0 (TA) and b0 (TB) never came; everyone else plays a hand at 6:10 PM. */
  const twoTableNight = async (o: { league?: boolean; over?: Partial<typeof P> } = {}) => {
    const w = world({ layout: { TA: field('a', 6, 20000, 100), TB: field('b', 6, 20000, 200) }, over: o.over });
    w.seatEveryoneExcept('a0', 'b0');
    let now = SIX_PM_MT;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      if (o.league !== false) expect(w.m.markLeagueFirstHour(w.tid, SEVEN_PM_MT)).toBe(12);   // the whole field
      now = SIX_PM_MT + 10 * MIN;
      await w.playHand('TA');
      await w.playHand('TB');
      now = SEVEN_PM_MT - 1000;
      await w.playHand('TA');                                   // inside the hour: nothing counted
      const before = w.m.awayStreakStats.noShowsAtHourEnd;
      now = SEVEN_PM_MT + 1000;
      await w.playHand('TA');                                   // the night's FIRST hand end after 7:00 PM
      const atFirst = w.m.awayStreakStats.noShowsAtHourEnd;
      now = SEVEN_PM_MT + 5 * MIN;
      await w.playHand('TA');                                   // later hand ends, either table: never again
      await w.playHand('TB');
      const noShowLogs = w.logs.filter((l) => l.includes('"event":"tournament_no_shows_at_hour_end"')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
      return { w, before, atFirst, stats: { ...w.m.awayStreakStats }, noShowLogs };
    } finally {
      spy.mockRestore();
    }
  };

  it('noShowsAtHourEnd = the night\'s REAL no-shows (2 of 12), counted ONCE at its first hand end after 7:00 PM, across tables; firstHourEntrants = the whole field; a weekly counts nothing', async () => {
    const r = await twoTableNight();
    expect(r.before).toBe(0);
    expect(r.atFirst).toBe(2);                                  // a0 (this table) AND b0 (the other table)
    expect(r.stats).toMatchObject({ firstHourEntrants: 12, noShowsAtHourEnd: 2 });
    expect(r.noShowLogs).toEqual([{ event: 'tournament_no_shows_at_hour_end', tournamentId: r.w.tid, until: SEVEN_PM_MT, noShows: 2 }]);
    expect(r.w.tm.getTournament(r.w.tid)!.leagueNoShowsCounted).toBe(true);
    // Both were removed as no-shows (the count is taken before this hand's bust check removes them).
    expect(r.w.tp('a0')).toMatchObject({ eliminated: true, removedNoShow: true });
    expect(r.w.tp('b0')).toMatchObject({ eliminated: true, removedNoShow: true });
    expect(r.stats.removedProtectedAfterHour).toBe(2);
    expect('noShowsProtected' in r.stats).toBe(false);
    const weekly = await twoTableNight({ league: false });
    expect(weekly.stats).toMatchObject({ firstHourEntrants: 0, noShowsAtHourEnd: 0 });
    expect(weekly.noShowLogs).toEqual([]);
    expect(weekly.w.tm.getTournament(weekly.w.tid)!.leagueNoShowsCounted).toBeUndefined();
  });

  it('CONTROL: before the fix only the mark-time counter existed — it says 12 (the whole field), the no-shows are never counted; without the once-per-night flag every later hand end adds them again', async () => {
    expect(P.absentClock.split(NOTE_NO_SHOWS).length).toBe(2);
    const noCount = await twoTableNight({ over: { absentClock: P.absentClock.replace(NOTE_NO_SHOWS, '') } });
    expect(noCount.stats).toMatchObject({ firstHourEntrants: 12, noShowsAtHourEnd: 0 });
    expect(P.absentClock.split(ONCE_GUARD).length).toBe(2);
    const everyHand = await twoTableNight({ over: { absentClock: P.absentClock.replace(ONCE_GUARD, ') return;\n') } });
    expect(everyHand.atFirst).toBe(2);
    expect(everyHand.stats.noShowsAtHourEnd).toBeGreaterThan(2);   // b0 again at 7:05 (TA), and at TB's hand end
    expect(everyHand.noShowLogs.length).toBeGreaterThan(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Review fix (2026-11-26) — the client's timeout toast promised "You can't sit out more than 30
  // hands in a row" to a league entrant who has not played a hand: the server removes him at the
  // first hand end after 7:00 PM whatever his count. The timeout's 'sitOutToggled' {reason:'timeout'}
  // now says which: protectedUntil (7:00 PM ms, inside his first hour) / noShowDue (past it).
  // CONTROL = the pre-fix emit (neither field).
  // ---------------------------------------------------------------------------------------------
  const NEW_TIMEOUT_EMIT = "    io.sockets.sockets.get(sid)?.emit('sitOutToggled', { sittingOut: true, reason: 'timeout', tableId, ...firstHour });";
  const OLD_TIMEOUT_EMIT = "    io.sockets.sockets.get(sid)?.emit('sitOutToggled', { sittingOut: true, reason: 'timeout', tableId });";
  const timeoutToggles = async (over?: Partial<typeof P>, league = true) => {
    const w = noShowNight(over);                                // a1..a3 at their seats, a0 never came
    let now = SIX_PM_MT;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const timeOut = (pid: string, at: number) => {
      now = at;
      const sid = `S-${pid}`;
      w.playerSessions.get(sid).sittingOut = false;
      const s = w.live.get(sid);
      s.emitted.length = 0;
      expect(w.m.sitOutTournamentSeatAfterTimeout('TA', w.seatOf(pid)!.seatIndex)).toBe(true);
      return evs(s, 'sitOutToggled');
    };
    try {
      if (league) w.m.markLeagueFirstHour(w.tid, SEVEN_PM_MT);
      w.tp('a2').playedAHand = true;                            // a2 has played a hand (the flag a played hand end sets)
      const out = {
        inHour: timeOut('a1', SIX_PM_MT + 40 * MIN),            // 6:40 PM, never played
        dueNow: timeOut('a1', SEVEN_PM_MT + 60_000),            // 7:01 PM, never played
        played: timeOut('a2', SEVEN_PM_MT + 60_000),            // 7:01 PM, played a hand
      };
      // Every other 'sitOutToggled' stays as it was (acting from sit-out: reason 'action').
      const s1 = w.live.get('S-a1');
      s1.emitted.length = 0;
      w.m.returnTournamentSessionFromSitOut(s1, w.playerSessions.get('S-a1'), 'action');
      return { ...out, back: evs(s1, 'sitOutToggled') };
    } finally {
      spy.mockRestore();
    }
  };

  it('the timeout\'s sitOutToggled says the first hour: protectedUntil = 7:00 PM inside it, noShowDue once it is over (never played), neither once he played or on a weekly; other sitOutToggled events unchanged; CONTROL: the pre-fix payload had neither', async () => {
    const r = await timeoutToggles();
    expect(r.inHour).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA', protectedUntil: SEVEN_PM_MT, noShowDue: false }]);
    expect(r.dueNow).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA', protectedUntil: null, noShowDue: true }]);
    expect(r.played).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA', protectedUntil: null, noShowDue: false }]);
    expect(r.back).toEqual([{ sittingOut: false, reason: 'action', tableId: 'TA' }]);
    const weekly = await timeoutToggles(undefined, false);
    expect(weekly.inHour).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA', protectedUntil: null, noShowDue: false }]);
    expect(weekly.dueNow).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA', protectedUntil: null, noShowDue: false }]);
    // CONTROL: the pre-fix emit — the client could not tell (its toast promised 30 hands to both).
    expect(P.absentClock.split(NEW_TIMEOUT_EMIT).length).toBe(2);
    const ctl = await timeoutToggles({ absentClock: P.absentClock.replace(NEW_TIMEOUT_EMIT, OLD_TIMEOUT_EMIT) });
    expect(ctl.inHour).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA' }]);
    expect(ctl.dueNow).toEqual([{ sittingOut: true, reason: 'timeout', tableId: 'TA' }]);
  });

  // ---------------------------------------------------------------------------------------------
  // Review fix (2026-11-26) — a removal nobody could tell waits up to 24 h for his sign-in, but a
  // qualifier / league record is pruned an hour after the finish: the notice then said "30 hands",
  // without noShow, and the place he had at the removal (before later late-entry shifts). The queued
  // notice now keeps handsSatOut / noShow; the place comes from the kept finished roster (25 h).
  // CONTROL = the pre-fix queue + tell lines.
  // ---------------------------------------------------------------------------------------------
  const SIGN_IN_FIX: Array<[string, string]> = [
    [
      '\n      // Review fix (2026-11-26) — WHY, kept with the notice: the record is pruned an hour after the finish.\n      handsSatOut: tp.removedSatOutHands ?? TOURNAMENT_SIT_OUT_HANDS_LIMIT, noShow: !!tp.removedNoShow,',
      '',
    ],
    [
      '      const position = tp && tp.eliminated && tp.finishPosition > 0\n        ? tp.finishPosition\n        : (!tp ? tournamentManager.keptFinishPositionOf(n.tournamentId, n.playerId, now) : null) ?? n.position;',
      '      const position = tp && tp.eliminated && tp.finishPosition > 0 ? tp.finishPosition : n.position;',
    ],
    [
      "        reason: 'sat_out_limit' as const, handsSatOut: tp?.removedSatOutHands ?? n.handsSatOut,\n        ...(tp?.removedNoShow || n.noShow ? { noShow: true as const } : {}),",
      "        reason: 'sat_out_limit' as const, handsSatOut: tp?.removedSatOutHands ?? TOURNAMENT_SIT_OUT_HANDS_LIMIT,\n        ...(tp?.removedNoShow ? { noShow: true as const } : {}),",
    ],
  ];
  const preSignInFix = (): Partial<typeof P> => {
    let helpers = P.helpers;
    for (const [now, was] of SIGN_IN_FIX) {
      expect(helpers.split(now).length).toBe(2);
      helpers = helpers.replace(now, was);
    }
    return { helpers };
  };
  /** Sign in as a0 (uid 100) on a fresh socket; his notices. */
  const signInAsA0 = (w: World) => {
    const s = w.mkSocket(`S-signin-${w.live.size}`, 100);
    w.m.tellKeptTournamentSeats(s, w.authSessions.get(s.id), 'voluntary', 'oauthLogin');
    return { finished: evs(s, 'tournamentFinishedForEntrant'), running: evs(s, 'playerEliminated') };
  };

  it('a league NO-SHOW removed while away (no socket), told at the next morning\'s sign-in AFTER the night\'s record was pruned: noShow + his real count; CONTROL: the pre-fix notice said 30 hands with no noShow', async () => {
    const night = async (over?: Partial<typeof P>) => {
      const w = noShowNight(over);
      let now = SIX_PM_MT;
      const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        w.m.markLeagueFirstHour(w.tid, SEVEN_PM_MT);
        await w.playHand('TA');                                 // 6:00 PM: a1..a3 play a hand, a0 never came
        now = SEVEN_PM_MT + 1000;
        await w.playHand('TA');                                 // the first hand end after 7:00 PM: a0 removed
        expect(w.tp('a0')).toMatchObject({ eliminated: true, finishPosition: 4, removedNoShow: true, removedSatOutHands: 2 });
        expect(w.m.removalSignInNotices.size).toBe(1);          // nobody to tell: queued for his sign-in
        for (const id of ['a3', 'a2']) w.tm.eliminatePlayer(w.tid, id);   // the night plays out (a1 wins)
        expect(w.tm.getTournament(w.tid)!.status).toBe('finished');
        now += 61 * MIN;
        expect(w.tm.pruneEndedTournaments(now)).toEqual([w.tid]);   // its record goes an hour after the finish
        expect(w.tm.getTournament(w.tid)).toBeUndefined();
        now = SEVEN_PM_MT + 14 * 60 * MIN;                       // 9:00 AM: he signs in
        return signInAsA0(w);
      } finally {
        spy.mockRestore();
      }
    };
    const fixed = await night();
    expect(fixed.running).toEqual([]);
    expect(fixed.finished).toEqual([{
      tournamentId: expect.any(String), position: 4, tournamentName: 'Sit Out Cup', atSignIn: true,
      reason: 'sat_out_limit', handsSatOut: 2, noShow: true,
    }]);
    const ctl = await night(preSignInFix());
    expect(ctl.finished).toEqual([{
      tournamentId: expect.any(String), position: 4, tournamentName: 'Sit Out Cup', atSignIn: true,
      reason: 'sat_out_limit', handsSatOut: 30,
    }]);
  });

  it('a WEEKLY-style removal at 30, then a late entry moves every busted place down one: told after the prune with his STORED place from the kept roster (5th); CONTROL: the pre-fix notice used the place at the removal (4th)', async () => {
    const run = async (over?: Partial<typeof P>) => {
      const w = world({ layout: { TA: field('a', 4, 20000, 100) }, over });
      w.seatEveryoneExcept('a0');
      preCount(w, 'a0', LIMIT - 1);
      await w.playHand('TA');                                   // his 30th: removed 4th, nobody to tell
      expect(w.tp('a0')).toMatchObject({ eliminated: true, finishPosition: 4, removedSatOutHands: LIMIT });
      expect(w.m.removalSignInNotices.size).toBe(1);
      expect(w.tm.addLateEntrant(w.tid, 'late', 'late', 'sock-late', 20000, { userId: 999 })).toBeTruthy();
      expect(w.tp('a0').finishPosition).toBe(5);                // the field grew: he is 5th now
      for (const id of ['late', 'a3', 'a2']) w.tm.eliminatePlayer(w.tid, id);
      expect(w.tm.getTournament(w.tid)!.status).toBe('finished');
      expect(w.tp('a0').finishPosition).toBe(5);
      expect(w.tm.pruneEndedTournaments(Date.now() + 61 * MIN)).toEqual([w.tid]);
      expect(w.tm.keptFinishPositionOf(w.tid, 'a0')).toBe(5);   // the kept roster (25 h)
      return signInAsA0(w);
    };
    const fixed = await run();
    expect(fixed.finished).toEqual([{
      tournamentId: expect.any(String), position: 5, tournamentName: 'Sit Out Cup', atSignIn: true, reason: 'sat_out_limit', handsSatOut: LIMIT,
    }]);
    const ctl = await run(preSignInFix());
    expect(ctl.finished).toEqual([expect.objectContaining({ position: 4, handsSatOut: LIMIT })]);
  });
});

describe('wiring + locks (source)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('handleHandComplete counts right after the capture and before its first await; the check runs after', () => {
    const hhc = fnSrc('async function handleHandComplete(');
    const cap = hhc.indexOf('const tournamentBustCheck = captureTournamentBustCheck(tableId, table, results);');
    const count = hhc.indexOf('awayStreakAtHandEnd(tableId, table, tournamentBustCheck);');
    expect(cap).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(cap);
    expect(count).toBeLessThan(hhc.indexOf('await mergeUserStats('));   // the first await
    expect(hhc.indexOf("runTournamentBustCheck(tableId, table, tournamentBustCheck, 'hand_complete');")).toBeGreaterThan(count);
  });

  it('the resets are wired: I\'m back, acting from sit-out, any voluntary action; a restore resets nothing and ends no first hour', () => {
    expect(handlerSrc('playerBack', '\n  });\n')).toContain("awayStreakResetAt(session.tableId, session.seatIndex, 'back');");
    // Review fix (2026-11-26) — the sit-IN branch of 'sitOut' (the app's "Sitting Out · I'm back" button), never its sit-out branch.
    const sitOut = handlerSrc('sitOut', '\n  });\n');
    const sitIn = sitOut.indexOf('// Returning from sit-out');
    expect(sitIn).toBeGreaterThan(0);
    expect(sitOut.indexOf("awayStreakResetAt(session.tableId, session.seatIndex, 'back');")).toBeGreaterThan(sitIn);
    expect(sitOut.split('awayStreakResetAt(').length).toBe(2);
    expect(fnSrc('function returnTournamentSessionFromSitOut(')).toContain("awayStreakResetAt(session.tableId, session.seatIndex, 'action');");
    const action = handlerSrc('action', '\n  );\n');
    expect(action).toContain("else awayStreakResetAt(session.tableId, session.seatIndex, 'action');");
    // 2026-11-26 (owner: "seated before 6 and then leaves before never played a hand") — a sign-in /
    // restore ends NO first hour any more (only a played hand end does), and resets no run.
    for (const src of [fnSrc('function restoreAbsentTournamentSeat('), SEAT_RESTORE_SRC]) {
      expect(src).not.toContain('awayStreakResetAt');
      expect(src).not.toContain('sitOutProtectedUntil');
      expect(src).not.toContain('playedAHand');
      expect(src).not.toContain('awayStreakArrivedAt');
    }
    expect(SRC).not.toContain('function awayStreakArrivedAt(');
    expect(SRC).not.toContain('sitOutProtectedUntil');
    expect(fnSrc('function awayStreakResetAt(')).not.toContain('playedAHand');
    // The ONE writer of playedAHand: a played hand end (never cleared, a re-entry keeps it).
    expect(SRC.split('playedAHand = ').length).toBe(2);
    expect(fnSrc('function awayStreakAtHandEnd(')).toContain('      if (acted || played) tp.playedAHand = true;');
    // Review fix (2026-11-26) — a session at the hand end plays it only when the server never acted for the seat.
    expect(fnSrc('function awayStreakAtHandEnd(')).toContain(NEW_PLAYED);
    expect(fnSrc('function awayStreakServerActed(')).toContain("if (e.auto || e.action === 'folded (left table)') return true;");
    const tmSrc = read('src/game/TournamentManager.ts');
    const clearAt = tmSrc.indexOf('export function clearAwayStreak(');
    const clear = tmSrc.slice(clearAt, tmSrc.indexOf('\n}\n', clearAt));
    expect(clear).toContain('delete p.sitOutHands;');
    expect(clear).not.toContain('playedAHand');
    expect(tmSrc).not.toContain('sitOutProtectedUntil');
  });

  it('both league start paths mark the NIGHT (nobody named); the gameState carries mySitOutLimit (always present); the lobby item says 30', () => {
    // 2026-11-26 (owner 2026-11-25 11:15 PM) — no list of "never arrived" no-shows: the whole night.
    const tick = fnSrc('function tickQualifierAutoStart(');
    expect(tick).toContain('if (noShowsSeatedAbsent(qt.kind)) markLeagueFirstHour(result.tournamentId, qualifierWindows(scheduledTime, qt.qualifierType).lateRegUntil);');
    expect(tick.split('markLeagueFirstHour(').length).toBe(2);
    const deal = fnSrc('function runPreStartDeal(');
    // Review fix (2026-11-26) — in the ALWAYS-run part (its own try), after the (1)-(6) try, before the hold ends.
    const markAt = deal.indexOf('      markLeagueFirstHour(tournamentId, qualifierWindows(new Date(qt.scheduledAt).getTime(), qt.qualifierType).lateRegUntil);');
    expect(markAt).toBeGreaterThan(deal.indexOf("step: 'prepare'"));
    expect(markAt).toBeLessThan(deal.indexOf("tournamentManager.pauseTournament(tournamentId, false, 'prestart');"));
    expect(deal).toContain('if (qt && qt.tournamentId === tournamentId && noShowsSeatedAbsent(qt.kind) && tournamentManager.getTournament(tournamentId)?.status === \'running\') {');
    expect(deal).not.toContain('if (keepNoShows) markLeagueFirstHour(');
    expect(deal.split('markLeagueFirstHour(').length).toBe(2);
    expect(deal).not.toContain('noShowIds');
    expect(SRC).not.toContain('markNoShowProtection');
    // Only those two starts mark a night (a weekly / monthly / any other tournament never has a first hour).
    expect(SRC.split('markLeagueFirstHour(').length).toBe(4);   // the two calls + the definition
    expect(SRC.split('leagueFirstHourUntil = ').length).toBe(2);
    expect(fnSrc('function markLeagueFirstHour(')).toContain('t.leagueFirstHourUntil = until;');
    const gs = fnSrc('function getGameStateForPlayer(');
    expect(gs).toContain('stateObj.mySitOutLimit = stateTournamentId && playerSeatIndex >= 0');
    expect(gs).toContain('(awayStreakViewOf(stateTournamentId, table, playerSeatIndex) ?? null) : null;');
    expect(fnSrc('function qualifierListItem(')).toContain('sitOutLimitHands: 30,');
    expect(SRC).toContain('const TOURNAMENT_SIT_OUT_HANDS_LIMIT = 30;');
    // The cash rule is untouched.
    expect(SRC).toContain('const SIT_OUT_HANDS_LIMIT = 30;');
  });

  it('the elimination notices carry the reason (spectator switch, direct, hand-for-hand room copy, TournamentManager room copy)', () => {
    expect(fnSrc('function tellTournamentBustNow(')).toContain('...removalNoticeFields(tournamentId, bust.playerId),');
    expect(fnSrc('function noticeTournamentEliminationToEntrant(')).toContain('...removalNoticeFields(tournamentId, playerId),');
    expect(fnSrc('function emitHandForHandRoomBust(')).toContain('...removalNoticeFields(tournamentId, payload.playerId),');
    expect(read('src/game/TournamentManager.ts')).toContain("...(player.removedFor ? { reason: player.removedFor, handsSatOut: player.removedSatOutHands, ...(player.removedNoShow ? { noShow: true } : {}) } : {}),");
    // Review fix (2026-11-26): the no-show flag rides on every copy (removalNoticeFields, the sign-in notice).
    expect(fnSrc('function removalNoticeFields(')).toContain('...(tp.removedNoShow ? { noShow: true as const } : {})');
    // Review fix (2026-11-26): + the queued notice's own noShow (the record is pruned an hour after the finish).
    expect(fnSrc('function tellRemovalSignInNotices(')).toContain('...(tp?.removedNoShow || n.noShow ? { noShow: true as const } : {}),');
    expect(fnSrc('function queueRemovalSignInNotice(')).toContain('handsSatOut: tp.removedSatOutHands ?? TOURNAMENT_SIT_OUT_HANDS_LIMIT, noShow: !!tp.removedNoShow,');
    // The timeout's first-hour fields ride ONLY on the timeout's sitOutToggled.
    expect(SRC.split('...firstHour }').length).toBe(2);
    expect(fnSrc('function sitOutTournamentSeatAfterTimeout(')).toContain("emit('sitOutToggled', { sittingOut: true, reason: 'timeout', tableId, ...firstHour });");
  });

  it('a removal is a DURABLE audit row (it decides places / seats); the warning stays stdout-only', () => {
    const durable = slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);');
    expect(durable).toContain("'TOURNAMENT_SIT_OUT_REMOVED'");
    expect(durable).not.toContain("'TOURNAMENT_SIT_OUT_WARNED'");
  });

  it('canonical-features.txt locks the tokens', () => {
    const manifest = read('canonical-features.txt');
    for (const tok of [
      'TOURNAMENT_SIT_OUT_HANDS_LIMIT = 30', 'TOURNAMENT_SIT_OUT_WARN_AT = 3', 'tournamentSitOutWarning', 'tournament_sit_out_warned',
      'TOURNAMENT_SIT_OUT_WARNED', 'tournament_sit_out_removed', 'TOURNAMENT_SIT_OUT_REMOVED', 'sat_out_limit', 'mySitOutLimit',
      'sitOutLimitHands', 'tournamentSitOutLimit', 'tournament_no_show_protected', 'tournament_sit_out_removal_told_on_sign_in',
    ]) expect(manifest).toContain(tok);
    // Review fix (2026-11-26) tokens.
    // + the owner's first-hour rule (2026-11-26): the night's mark and the one played-a-hand writer.
    for (const tok of ['function awayStreakNoShowDue(', 'removedNoShow', 'function markLeagueFirstHour(', 'leagueFirstHourUntil', 'tp.playedAHand = true', 'function awayStreakServerActed(']) {
      expect(manifest.split('\n')).toContain(tok);
      expect(SRC + read('src/game/TournamentManager.ts')).toContain(tok);
    }
    // Review fixes (2026-11-26, tourney-1126): the renamed / new health counters, the timeout's first-hour fields, the kept place.
    for (const tok of ['firstHourEntrants', 'noShowsAtHourEnd', 'tournament_no_shows_at_hour_end', 'function timeoutSitOutFirstHourFields(', 'keptFinishPositionOf']) {
      expect(manifest.split('\n')).toContain(tok);
      expect(SRC + read('src/game/TournamentManager.ts')).toContain(tok);
    }
    expect(slice('const awayStreakStats = {', '\n};\n')).not.toContain('noShowsProtected');
    expect(SRC).not.toContain('awayStreakStats.noShowsProtected');
    // No token of the replaced "never arrived" rule is left in the manifest.
    for (const gone of ['markNoShowProtection', 'sitOutProtectedUntil', 'awayStreakArrivedAt']) expect(manifest).not.toContain(gone);
    // The existing locks stay.
    for (const tok of ['tournament_timeout_sit_out', 'QUALIFIER_NO_SHOW_SEATED_ABSENT']) expect(manifest).toContain(tok);
  });

  it('the CASH sit-out lock cannot be satisfied by the tournament constant (review fix 2026-11-26: \'SIT_OUT_HANDS_LIMIT = 30\' was a substring of it)', () => {
    const tokens = read('canonical-features.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(tokens).toContain('const SIT_OUT_HANDS_LIMIT = 30');
    expect(tokens).not.toContain('SIT_OUT_HANDS_LIMIT = 30');
    // The CI check is `blob.includes(token)`: with the cash constant gone (or changed), only the
    // tournament line is left, and the cash token must then be MISSING.
    const cashLine = 'const SIT_OUT_HANDS_LIMIT = 30;';
    expect(SRC).toContain(cashLine);
    const withoutCash = SRC.replace(cashLine, 'const SIT_OUT_HANDS_LIMIT = 20;');
    expect(withoutCash.includes('const SIT_OUT_HANDS_LIMIT = 30')).toBe(false);
    expect(withoutCash.includes('const TOURNAMENT_SIT_OUT_HANDS_LIMIT = 30')).toBe(true);
    // CONTROL: the old bare token still "passed" with the cash constant changed.
    expect(withoutCash.includes('SIT_OUT_HANDS_LIMIT = 30')).toBe(true);
  });
});

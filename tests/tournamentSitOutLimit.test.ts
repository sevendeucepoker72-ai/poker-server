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
 *  - An Online League no-show is protected until lateRegUntil (7:00 PM MT).
 *
 * Runs the REAL source of src/index.ts (sliced + transpiled) with the REAL
 * PokerTable and TournamentManager. CONTROL cases put the pre-fix code back.
 */
import fs from 'fs';
import path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
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
    autoActForSeat, seatHasPlayingSession, awayStreakAtHandEnd, awayStreakResetAt, awayStreakViewOf, awayStreakStats,
    markNoShowProtection, removalSignInNotices, handForHandStates, placeAndTellHandForHandBusts,
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
    w.playerSessions.get('S-a0').sittingOut = false;
    w.live.get('S-a0').connected = false;            // dropped; the disconnect handler has not run yet
    await w.playHand('TA', (a, t) => {
      if (a !== 0) return false;
      w.m.autoActForSeat('TA', t, 0, 'timeout');     // his clock runs out: the server acts for him
      return true;
    });
    expect(w.tp('a0').sitOutHands).toBe(2);
    // CONTROL: the same seat on a LIVE socket that never acted is "played" (unchanged), not counted.
    w.live.get('S-a0').connected = true;
    await w.playHand('TA', (a, t) => {
      if (a !== 0) return false;
      w.m.autoActForSeat('TA', t, 0, 'timeout');
      return true;
    });
    expect(w.tp('a0').sitOutHands).toBe(2);
    // Idempotent per tableId:handNumber: the same hand again changes nothing.
    const t = w.tables.get('TA')!;
    const c = w.m.captureTournamentBustCheck('TA', t, []);
    w.m.awayStreakAtHandEnd('TA', t, c);
    w.m.awayStreakAtHandEnd('TA', t, c);
    expect(w.tp('a0').sitOutHands).toBe(2);
    w.m.runTournamentBustCheck('TA', t, c, 'test');
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
        expect(w.tp('a0').sitOutHands).toBe(before);    // played, no action: unchanged
        walkedAt = k;
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

  it('a re-entry starts a fresh run (reinstateForReentry clears the count, the warning, the protection and the reason)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    const p = w.tp('a0');
    Object.assign(p, { sitOutHands: 12, sitOutWarned: true, sitOutLastHand: 'TA:9', sitOutProtectedUntil: Date.now() + 1000, removedFor: 'sat_out_limit', removedSatOutHands: 30 });
    w.tm.eliminatePlayer(w.tid, 'a0');
    expect(w.tm.reinstateForReentry(w.tid, 'a0', 20000)).toBe(true);
    expect(p).not.toHaveProperty('sitOutHands');
    expect(p).not.toHaveProperty('sitOutWarned');
    expect(p).not.toHaveProperty('sitOutLastHand');
    expect(p).not.toHaveProperty('sitOutProtectedUntil');
    expect(p).not.toHaveProperty('removedFor');
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

  it('a protected league no-show is told the late-entry wording (protectedUntil set)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    const until = Date.now() + 3600_000;
    expect(w.m.markNoShowProtection(w.tid, until)).toBe(1);
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

describe('the Online League no-show: protected for the first hour, removed at the first hand end after it', () => {
  it('seated absent at the start: hands count, never removed before lateRegUntil; removed at the first hand end after it (health removedProtectedAfterHour)', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    let now = Date.parse('2026-11-26T01:00:00.000Z');           // 6:00 PM MT
    const until = now + 60 * 60_000;                            // 7:00 PM MT
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect(w.m.markNoShowProtection(w.tid, until)).toBe(1);   // only a0: the others have sessions
      expect(w.tp('a0').sitOutProtectedUntil).toBe(until);
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

  it('a player who ARRIVED (a sign-in restored his seat) and then left is NOT protected', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept('a0');
    const until = Date.now() + 3600_000;
    w.m.markNoShowProtection(w.tid, until);
    const s = w.mkSocket('S-back', 100);
    expect(w.m.restoreAbsentTournamentSeat(s, w.authSessions.get('S-back'), 'test')).toBeTruthy();
    expect(w.tp('a0').sitOutProtectedUntil).toBeUndefined();
    w.playerSessions.delete('S-back');                          // he leaves again
    preCount(w, 'a0', LIMIT - 1);
    await w.playHand('TA');
    expect(w.tp('a0').eliminated).toBe(true);
  });

  it('a player who PLAYED a hand (no restore) is not protected either: the first played hand ends the mark', async () => {
    const w = world({ layout: { TA: field('a', 3, 20000, 100) } });
    w.seatEveryoneExcept();
    w.playerSessions.delete('S-a0');
    w.m.markNoShowProtection(w.tid, Date.now() + 3600_000);
    expect(w.tp('a0').sitOutProtectedUntil).toBeDefined();
    w.playerSessions.set('S-a0', { socketId: 'S-a0', tableId: 'TA', seatIndex: 0, playerName: 'a0', playerId: 'a0', sittingOut: false });
    await w.playHand('TA');
    expect(w.tp('a0').sitOutProtectedUntil).toBeUndefined();
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

  it('the resets are wired: I\'m back, acting from sit-out, any voluntary action; a restore only ends the no-show mark', () => {
    expect(handlerSrc('playerBack', '\n  });\n')).toContain("awayStreakResetAt(session.tableId, session.seatIndex, 'back');");
    expect(fnSrc('function returnTournamentSessionFromSitOut(')).toContain("awayStreakResetAt(session.tableId, session.seatIndex, 'action');");
    const action = handlerSrc('action', '\n  );\n');
    expect(action).toContain("else awayStreakResetAt(session.tableId, session.seatIndex, 'action');");
    expect(fnSrc('function restoreAbsentTournamentSeat(')).toContain('delete tp.sitOutProtectedUntil;');
    expect(fnSrc('function restoreAbsentTournamentSeat(')).not.toContain('awayStreakResetAt');
    expect(SEAT_RESTORE_SRC).toContain('awayStreakArrivedAt(reserved.tableId, reserved.seatIndex);');
    expect(SEAT_RESTORE_SRC).not.toContain('awayStreakResetAt');
  });

  it('both league start paths mark the no-shows; the gameState carries mySitOutLimit (always present); the lobby item says 30', () => {
    expect(fnSrc('function tickQualifierAutoStart(')).toContain('if (noShowsSeatedAbsent(qt.kind)) markNoShowProtection(result.tournamentId, qualifierWindows(scheduledTime, qt.qualifierType).lateRegUntil);');
    expect(fnSrc('function runPreStartDeal(')).toContain('if (keepNoShows) markNoShowProtection(tournamentId, qualifierWindows(new Date(qt.scheduledAt).getTime(), qt.qualifierType).lateRegUntil);');
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
    expect(read('src/game/TournamentManager.ts')).toContain("...(player.removedFor ? { reason: player.removedFor, handsSatOut: player.removedSatOutHands } : {}),");
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
    // The existing locks stay.
    for (const tok of ['SIT_OUT_HANDS_LIMIT = 30', 'tournament_timeout_sit_out', 'QUALIFIER_NO_SHOW_SEATED_ABSENT']) expect(manifest).toContain(tok);
  });
});

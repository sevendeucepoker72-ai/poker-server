/**
 * 2026-10-09 (round 6) — ABSENT / reserved seats: U1-U4.
 *
 * U1 [major]: a login that is still awaiting (resumeSession's DB read or its
 * seat-restore play gate; oauthLogin / tokenLogin likewise) when its socket
 * drops used to finish anyway: it consumed the seat reservation AND the
 * reservation's cash-out timer, bound the seat to the dead socket, and the
 * stack was never cashed out. Every login now checks the socket after each
 * await (loginSocketGone) and the seat-restore gate acts on nothing once the
 * socket is gone: the reservation and its timer are left for the next
 * reconnect, no session stays on the dead socket.
 *
 * U2: a suspended player whose TOURNAMENT seat has no live socket behind it
 * (reserved / absent) is disqualified at the hand-start gate (same batch as
 * the live ones) and never paid; the seat-restore gate never bare-stands a
 * tournament seat (it is left to that gate).
 *
 * U3: the reservation consumers decide "tournament?" by isTournamentReservation
 * (the snapshot survives a table break) — a table break never credits a
 * tournament stack.
 *
 * U4: an absent tournament seat past its reservation's hand limit acts on a
 * short clock, not the full 30s turn clock (a reconnect gets the rest of it).
 *
 * Everything runs the REAL source text of src/index.ts (sliced and transpiled
 * with the repo's TypeScript; index.ts itself starts a server on import)
 * against the REAL PokerTable, TournamentManager, login tracker and play-gate
 * helpers, with an in-memory users table and recorded wallet credits.
 */

import fs from 'fs';
import path from 'path';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
import { sanitizeSeatAvatar } from '../src/seatProfile';
import { SEAT_TEARDOWN_SRC, SEAT_RESTORE_SRC } from './helpers/indexSource';
import {
  createLoginTracker, seatRestoreAction, planHandStartGate, masterIdFromStats, resolveSessionMasterId,
  HAND_GATE_MAX_STATUS_AGE_MS,
} from '../src/auth/playGate';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

function slice(startNeedle: string, endNeedle: string, from = 0): string {
  const at = SRC.indexOf(startNeedle, from);
  if (at < 0) throw new Error(`not found in src/index.ts: ${startNeedle}`);
  const end = SRC.indexOf(endNeedle, at);
  if (end < 0) throw new Error(`no end for: ${startNeedle}`);
  return SRC.slice(at, end + endNeedle.length);
}
const fnSrc = (signature: string) => slice(signature, '\n}\n');

const P = {
  trackLogin: fnSrc('function trackLogin<A extends unknown[]>('),
  loginSocketGone: slice('const loginsOnDeadSocket = { abandoned: 0 };', '\n}\n'),
  // Q3 (2026-10-10): the overtake guard every seat-restoring login runs after its gate await.
  loginOvertake: slice('// ===== Login overtake guard', '// ===== end login overtake guard =====\n'),
  absentIds: slice('const ABSENT_SEAT_MASTER_ID_TTL_MS', '\n}\n'),
  absentSeatMasterId: fnSrc('function absentSeatMasterId('),
  isTournamentReservation: fnSrc('function isTournamentReservation('),
  // F2 (2026-10-10): broken-tournament-table registry + isTournamentTable.
  brokenTables: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  // F1 (2026-10-10): the hand-start gate holds the rebalance its disqualifications cause.
  rebalanceHold: slice('const tournamentRebalanceHolds = new Map', '\n}\n'),
  rebalanceIsHeld: fnSrc('function tournamentRebalanceIsHeld('),
  releaseRebalance: fnSrc('function releaseTournamentRebalance('),
  // F4 (2026-10-10): a qualifier entrant's identity (registered master id).
  absentEntrantIdentity: fnSrc('function absentEntrantIdentity('),
  qualifierEntrantMasterId: fnSrc('function qualifierEntrantMasterId('),
  reservationHolderAt: fnSrc('function reservationHolderAt('),
  noteNotCashed: fnSrc('function noteTournamentReservationNotCashed('),
  creditSeat: fnSrc('function creditSeatStackToWallet('),
  // S2 (2026-10-10): a leave keeps a LIVE tournament seat in play (absent); logins + the gate
  // restore an absent tournament seat by ACCOUNT. M3: the entrant/account test those use.
  seatKeep: slice('// ===== Tournament seat kept on leave', '// ===== end tournament seat kept on leave =====\n'),
  entrantIsAccount: fnSrc('function tournamentEntrantIsAccount('),
  liveSeatIndex: fnSrc('function tournamentLiveSeatIndex('),
  handlePlayerLeave: fnSrc('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind'),
  // AUTH-3 (2026-10-11): ghost seats by account only — the helper it uses comes along.
  clearGhost: fnSrc('function clearGhostSeatsForUser(') + fnSrc('function seatPlayedByAnotherAccount('),
  standUpRefusedSeat: fnSrc('function standUpRefusedSeat('),
  refuseSeatRestore: fnSrc('async function refuseSeatRestoreIfBarred('),
  cashOutGuest: fnSrc('async function cashOutSeatsBeforeGuestClaim('),
  seatOwnerSocket: fnSrc('function seatOwnerSocket('),
  handStartGate: fnSrc('function standUpSuspendedSeatsBeforeDeal('),
  canStandUp: fnSrc('function suspendedSeatCanStandUp('),
  standUpSuspendedSeat: fnSrc('function standUpSuspendedSeat('),
  standUpAbsent: fnSrc('function standUpAbsentTournamentSeat('),
  // round-7 review: tokenLogin's orphan scan + the disconnect re-validation use otherSessionHoldsSeat.
  seatHasLiveSession: fnSrc('function otherSessionHoldsSeat(') + fnSrc('function seatHasLiveSession('),
  isAbsentPastLimit: fnSrc('function isAbsentTournamentSeatPastHandLimit('),
  // Round 6 (2026-10-10): P-i / P-j — the absent auto-action (autoActForSeat) and "sitting out = absent".
  autoAct: slice('function seatHasPlayingSession(', "  t.playerFold(seatIndex);\n  return 'fold';\n}\n"),
  armTurnTimer: fnSrc('function armTurnTimer('),
  // 2026-10-24 (Sit & Go fix-all F10) — the absent-seat streak clock armTurnTimer reads.
  absentClock: slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n'),
  tick: fnSrc('function tickReservedSeatHands('),
  resume: slice('  let resumeWindowStart = 0;', "\n    })\n  );\n"),
  oauth: slice("socket.on('oauthLogin', trackLogin(socket, 'oauthLogin', async", '\n  }));\n'),
  tokenLogin: slice("socket.on('tokenLogin', trackLogin(socket, 'tokenLogin', async", '\n  }));\n'),
  // The main (last-registered) disconnect handler — the one with the seat reserve.
  disconnect: slice("socket.on('disconnect', async () => {", '\n  });', SRC.lastIndexOf("socket.on('disconnect', async () => {")),
  // P4 (2026-10-10): the disconnect's seat reservation + extra-table cash-out are two
  // functions, shared with the account switch every login now runs first.
  departure: slice('function reserveSeatForDeparture(', '\n}\n')
    + slice('function cashOutAdditionalSeatsOnDeparture(', '\n}\n'),
  accountSwitch: slice('const socketAccountSwitches = {', '\n}\n'),
  // S2 fixed protocol (2026-10-10): the lobby's Return to tournament (P-c).
  returnToTournament: slice("socket.on('returnToTournamentSeat'", '\n  });\n'),
  // R3 (K1-6): every seat restore gives the session its fast-mode choice back and tells the socket.
  fastModeRestore: fnSrc('function restoreFastModeOnSeatRestore('),
  // 2026-10-21 (gameplay S6) — the ONE reservation restore every sign-in's step (b) calls,
  // the F80 claims the sign-ins / disconnect use, and the G183 / G184 dead-seat test.
  seatRestore: SEAT_RESTORE_SRC + fnSrc('function tournamentEntrantHasLiveSeat('),
};

const constOf = (name: string): number => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return Number(m[1].replace(/_/g, ''));
};
const TURN_TIMEOUT_MS = constOf('TURN_TIMEOUT_MS');
const ABSENT_TOURNAMENT_SEAT_TURN_MS = constOf('ABSENT_TOURNAMENT_SEAT_TURN_MS');

function compile(over: Partial<typeof P> = {}): string {
  const p = { ...P, ...over };
  const code = `
${p.trackLogin}
${p.loginSocketGone}
${p.loginOvertake}
${p.absentIds}
${p.absentSeatMasterId}
${p.brokenTables}
${p.isTournamentReservation}
${p.rebalanceHold}
${p.rebalanceIsHeld}
${p.releaseRebalance}
${p.absentEntrantIdentity}
${p.qualifierEntrantMasterId}
${p.reservationHolderAt}
${p.noteNotCashed}
${p.creditSeat}
${SEAT_TEARDOWN_SRC}
${p.entrantIsAccount}
${p.liveSeatIndex}
${p.seatKeep}
${p.handlePlayerLeave}
${p.departure}
${p.accountSwitch}
${p.clearGhost}
${p.standUpRefusedSeat}
${p.refuseSeatRestore}
${p.cashOutGuest}
${p.seatOwnerSocket}
${p.handStartGate}
${p.canStandUp}
${p.standUpSuspendedSeat}
${p.standUpAbsent}
${p.seatHasLiveSession}
${p.isAbsentPastLimit}
${p.autoAct}
${p.absentClock}
${p.armTurnTimer}
${p.tick}
${p.fastModeRestore}
${p.seatRestore}
function wire(socket) {
${p.resume}
  ${p.oauth}
  ${p.tokenLogin}
  ${p.disconnect}
  ${p.returnToTournament}
}
module.exports = {
  wire, standUpSuspendedSeatsBeforeDeal, armTurnTimer, tickReservedSeatHands, cashOutSeatsBeforeGuestClaim,
  refuseSeatRestoreIfBarred, clearGhostSeatsForUser, loginsOnDeadSocket, absentSeatMasterIds,
  handlePlayerLeave, socketAccountSwitches, loginsOvertaken, releaseSocketForAccountSwitch,
  tournamentHandStartSafety,
};
`;
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

const ALICE = 101;
const SEAT_RESERVE_MS = 6 * 60 * 60 * 1000;
const HANDS_LIMIT = 3;

type Seat = [number, string, number, string];
interface WorldOpts {
  tournament?: boolean;
  seats?: Seat[];
  over?: Partial<typeof P>;
}

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  return { p, resolve };
}

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

function world(opts: WorldOpts = {}) {
  const credits: Array<{ uid: number; amount: number }> = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const emitted = new Map<string, Array<[string, any]>>();
  const tables = new Map<string, PokerTable>();
  const mkTable = (id: string) => {
    const t = new PokerTable({
      tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9,
    } as any);
    tables.set(id, t);
    return t;
  };
  const table = mkTable('t1');
  const seats: Seat[] = opts.seats ?? [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102'], [2, 'Carl', 5000, 'user_103']];
  for (const [i, n, c, pid] of seats) expect(table.sitDown(i, n, c, pid, false, true)).toBe(true);

  const tournamentTables = new Map<string, string>();
  let tm: TournamentManager | null = null;
  let tid = '';
  let results: any[] | null = null;
  if (opts.tournament) {
    tm = new TournamentManager();
    tid = tm.createTournament({
      name: 'U-CUP', buyIn: 500, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS,
    } as any);
    for (const [i, n, , pid] of seats) tm.registerPlayer(tid, pid, n, `reg-${i}`, Number(pid.slice(5)));
    tm.onEvent(tid, (ev, d) => { if (ev === 'tournamentFinished') results = d.results; });
    expect(tm.startTournament(tid)).toBeTruthy();
    tournamentTables.set('t1', tid);
  }

  const users = new Map<number, any>();
  for (const [, n, , pid] of seats) {
    const id = Number(pid.slice(5));
    users.set(id, {
      id, username: `${n.toLowerCase()}.player`, display_name: n, chips: 100_000, level: 3, xp: 10,
      stats: JSON.stringify({ masterUserId: `m-${n.toLowerCase()}` }), achievements: '[]', token_version: 1, is_admin: false,
    });
  }

  const ctl: {
    dbGate: Promise<void> | null; gateGate: Promise<void> | null; loadProgressGate: Promise<void> | null;
    legacyGate: Promise<void> | null; suspended: Set<string>; banned: Set<number>;
  } = { dbGate: null, gateGate: null, loadProgressGate: null, legacyGate: null, suspended: new Set(), banned: new Set() };
  const statusCache = new Map<string, boolean>();
  const statusLookups: string[] = [];

  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const reservedSeats = new Map<number, any>();
  const multiTableSessions = new Map<string, any[]>();
  const sockets = new Map<string, any>();
  const io = { sockets: { sockets }, to: () => ({ emit() {} }), emit() {} };
  const playGateHandStart = { standUps: 0, disqualified: 0, absentDisqualified: 0, refreshes: 0, errors: 0 };

  const g: Record<string, unknown> = {
    tableManager: {
      getTable: (id: string) => tables.get(id),
      getTableList: () => [...tables.keys()].map((tableId) => ({ tableId })),
    },
    authSessions, playerSessions, reservedSeats, multiTableSessions, tournamentTables, io,
    tournamentManager: tm,
    qualifierTournaments: new Map(),
    pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), spectators: new Map(), aiProfiles: new Map(),
    aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), quickTables: new Set(), lastSentState: new Map(),
    lastSentJson: new Map(), MAX_SEATS: 9, SEAT_RESERVE_MS, DISCONNECT_HANDS_LIMIT: HANDS_LIMIT,
    reservationsDisplaced: { count: 0 },   // 2026-10-21 (S6): reserveSeatForDeparture's displacement counter (F77 / G184 CONTROLs reach it)
    // handlePlayerLeave's tail (P4 tests run a full leave).
    lastEmoteTime: new Map(), lastReactionTime: new Map(), lastChatTime: new Map(),
    syncSitOutToTable() {}, broadcastGameState() {}, releaseSeatedSlot() {}, cleanupQuickTable() {},
    // R2 (S1): the Spin & Go (prize format) helpers the leave / reservation paths ask.
    isPrizeFormatTable: () => false, leavePrizeFormatSeat: () => false, quickGameEndCheck: () => false,
    // S6 fix-up: leaverKeepsAllInHand (a departure that keeps a live hand) asks it — no quick tables here.
    isFixedRosterQuickTable: () => false,
    emitGameState() {},
    settleDecidedQuickGame: () => false,   // R3 (S1-4) — no quick game decided here
    shutdownFlushActive: () => false,   // R2 (item 1) — the shutdown flush is not running
    tellQualifierNoShowReleases: () => 0,   // 2026-10-20 — no qualifier no-show releases here (r2Qualifiers tests them)
    // 2026-10-24 hand-for-hand review fix-up: a Return / sign-in asks whether a bust's place is still
    // pending (a hand-for-hand round not settled) — never here (rebalanceSafety "H" tests it).
    handForHandBustPending: () => false,
    getGameStateForPlayer: () => ({}), scheduleAIAction() {}, log: { debug() {}, info() {} },
    // R2 (2026-10-11): the seat-teardown helper block (SEAT_TEARDOWN_SRC) tests it.
    FiveCardDrawTable: class {},
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    saveProgress: async () => true,
    progressionManager: { getClientProgress: () => ({ hydrated: true, xp: 10, level: 3, achievements: [] }) },
    // Play gate: the seat-restore lookup (awaitable), the cache the hand loop peeks.
    assertPlayable: async (socket: any) => {
      const a = authSessions.get(socket.id);
      const m = a?.masterUserId ?? a?.statsMasterUserId ?? null;
      if (ctl.gateGate) await ctl.gateGate;
      if (m && ctl.suspended.has(m)) {
        statusCache.set(m, true);
        return { code: 'player_suspended', message: 'SUSPENDED', masterId: m };
      }
      return null;
    },
    seatRestoreAction, planHandStartGate, HAND_GATE_MAX_STATUS_AGE_MS, masterIdFromStats, resolveSessionMasterId,
    playStatusClient: {
      peek: (id: string) => (statusCache.has(id)
        ? { status: { suspended: statusCache.get(id)!, failedOpen: false }, ageMs: 0, expired: false } : null),
      getPlayStatus: async (id: string) => {
        statusLookups.push(id);
        const s = ctl.suspended.has(id);
        statusCache.set(id, s);
        return { suspended: s, failedOpen: false };
      },
    },
    loadLocalStats: async (uid: number) => users.get(uid)?.stats,
    playGateHandStart, playGateRefusals: { player_suspended: 0 }, PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED',
    isUserBanned: async (uid: number) => ctl.banned.has(uid),
    // Login plumbing.
    loginTracker: createLoginTracker(),
    normalizeRequestId: (x: unknown) => (typeof x === 'string' ? x : undefined),
    failLogin: (s: any, f: any) => s.emit('loginResult', { success: false, code: f.code }),
    RESUME_INVALID_MESSAGE: 'invalid', RESUME_SIGNING_KEY: 'k',
    verifyResumeToken: (_k: string, tok: string) => (tok
      ? { ok: true, claims: { localUserId: ALICE, masterUserId: 'm-alice', orig_iat: 0, phone: null } }
      : { ok: false, reason: 'missing' }),
    checkResumeRow: () => null, maintenanceBlocksLogin: () => false,
    parseStatsColumn: (s: unknown) => (typeof s === 'string' ? JSON.parse(s || '{}') : (s || {})),
    parseAchievements: () => [],
    resumeFieldsFor: () => ({ resumeToken: 'fresh', resumeExpiresAt: 'later' }),
    resumeStats: { invalid: 0, transientFailures: 0, resumed: 0 },
    getPool: () => ({
      query: async (_sql: string, params: unknown[]) => {
        if (ctl.dbGate) await ctl.dbGate;
        const r = users.get(Number(params[0]));
        return { rows: r ? [{ ...r }] : [] };
      },
    }),
    emitPlayRefusal: (s: any, r: any) => s.emit('error', { message: r.message, code: r.code }),
    hydrateAndPushProgress: async () => {},
    // 2026-10-10 — trackLogin awaits the account-merge identity gate (open here).
    awaitIdentityGate: async () => {},
    validateOAuthToken: async (tok: string) => (tok === 'oidc-alice'
      ? { valid: true, sub: 'm-alice', username: 'Alice', isAdmin: false }
      // Q3 (2026-10-10): a second account's OIDC sign-in on a shared browser.
      : tok === 'oidc-bob' ? { valid: true, sub: 'm-bob', username: 'Bob', isAdmin: false } : { valid: false }),
    reportAuthEvent() {},
    resolveLoginIdentity: () => ({ ok: true, identity: { key: 'alice.player', displayName: 'Alice', source: 'username' } }),
    sanitizeSeatAvatar,   // R1 (2026-10-11): the orphan scans allowlist the reservation avatar
    upsertOidcLocalUser: async (a: { sub: string }) => ({ ok: true, user: { ...users.get(a.sub === 'm-bob' ? 102 : ALICE) } }),
    loadProgress: async (uid: number) => {
      if (ctl.loadProgressGate) await ctl.loadProgressGate;
      const r = users.get(uid);
      return { success: true, userData: { id: r.id, username: r.username, stats: {} } };
    },
    tokenLoginAttempts: new Map(),
    getUserFromToken: async (tok: string) => {
      if (ctl.legacyGate) await ctl.legacyGate;
      return tok === 'legacy-alice'
        ? { success: true, userData: { id: ALICE, username: 'alice.player', stats: JSON.stringify({ masterUserId: 'm-alice' }) } }
        : { success: false, error: 'bad' };
    },
    Sentry: null,
    console: { log() {}, warn() {}, error() {} },
    // armTurnTimer's state.
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], GamePhase,
    TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS,
    qualifierIdOfTable: () => null,   // F10 — no qualifier tables in this world
  };
  const mod: { exports: any } = { exports: {} };
  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(g), 'module', 'exports', 'require', compile(opts.over));
  run(...Object.values(g), mod, mod.exports, require);
  const m = mod.exports;

  const mkSocket = (id: string) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers,
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      emit: (ev: string, payload: any) => { if (!emitted.has(id)) emitted.set(id, []); emitted.get(id)!.push([ev, payload]); },
      join() {}, leave() {},
    };
    sockets.set(id, s);
    m.wire(s);
    return s;
  };
  /** socket.io order: connected=false and the socket leaves the namespace, THEN 'disconnect' fires. */
  const drop = async (s: any) => { s.connected = false; sockets.delete(s.id); await s.handlers.disconnect(); };
  /** A live, signed-in socket seated at (t1, seatIndex). */
  const seatLive = (sid: string, uid: number, seatIndex: number) => {
    const s = mkSocket(sid);
    const u = users.get(uid);
    authSessions.set(sid, { userId: uid, username: u.username, masterUserId: `m-${u.display_name.toLowerCase()}` });
    playerSessions.set(sid, {
      socketId: sid, tableId: 't1', seatIndex, playerName: u.display_name, playerId: `user_${uid}`, sittingOut: false,
    });
    return s;
  };
  const notCashed = () => audits.filter((a) => a.action === 'TOURNAMENT_STACK_NOT_CASHED').map((a) => a.d);
  return {
    m, g, ctl, table, tables, mkTable, tournamentTables, tm, tid, getResults: () => results, users, credits, audits,
    emitted: (sid: string) => emitted.get(sid) || [], authSessions, playerSessions, reservedSeats, statusCache,
    statusLookups, playGateHandStart, mkSocket, drop, seatLive, notCashed,
    gate: () => m.standUpSuspendedSeatsBeforeDeal(table, 't1'),
  };
}

/** Alice is seated on a live socket S1, which drops: the normal reserve path (6h timer + hand count). */
async function aliceReserved(w: ReturnType<typeof world>) {
  const s1 = w.seatLive('S1', ALICE, 0);
  await w.drop(s1);
  const r = w.reservedSeats.get(ALICE);
  expect(r).toMatchObject({ tableId: 't1', seatIndex: 0, handsRemaining: HANDS_LIMIT, masterUserId: 'm-alice' });
  expect(r.cleanupTimer).toBeTruthy();
  return r;
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// ── U1 ────────────────────────────────────────────────────────────────────
describe('U1 — a login that outlives its socket never consumes the reservation or binds the seat to the dead socket', () => {
  it.each(['db_read', 'seat_restore_gate'] as const)(
    'resumeSession, socket dropped during the %s: reservation + its cash-out timer intact, no session on the dead socket; the 6h expiry later credits the 7,000 stack EXACTLY ONCE',
    async (stage) => {
      const w = world();
      const r = await aliceReserved(w);
      const gate = deferred();
      if (stage === 'db_read') w.ctl.dbGate = gate.p; else w.ctl.gateGate = gate.p;

      const s2 = w.mkSocket('S2');
      const pending = s2.handlers.resumeSession({ resumeToken: 'tok' });
      await flush();
      if (stage === 'seat_restore_gate') expect(w.authSessions.has('S2')).toBe(true); // set before the gate
      await w.drop(s2);                                       // the disconnect runs while the resume awaits
      gate.resolve();
      await pending;
      await flush();

      expect(w.reservedSeats.get(ALICE)).toBe(r);             // the SAME reservation, untouched
      expect(w.authSessions.has('S2')).toBe(false);
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(w.emitted('S2').filter(([ev]) => ev === 'loginResult' || ev === 'reconnectedToTable')).toEqual([]);
      expect(w.m.loginsOnDeadSocket.abandoned).toBe(1);
      expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
      expect(w.credits).toEqual([]);

      jest.advanceTimersByTime(SEAT_RESERVE_MS);               // its own timer still fires
      await flush();
      expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
      expect(w.table.seats[0].state).toBe('empty');
      expect(w.reservedSeats.has(ALICE)).toBe(false);
      jest.advanceTimersByTime(SEAT_RESERVE_MS);
      await flush();
      expect(w.credits).toHaveLength(1);
    },
  );

  it('…and the NEXT reconnect still restores the seat from that reservation (then nothing is credited at 6h)', async () => {
    const w = world();
    await aliceReserved(w);
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    await w.drop(s2);
    gate.resolve();
    await pending;

    w.ctl.gateGate = null;
    const s3 = w.mkSocket('S3');
    await s3.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.playerSessions.get('S3')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.authSessions.get('S3')).toMatchObject({ userId: ALICE, masterUserId: 'm-alice' });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    // R3 (K1-6): the restore also tells the socket its fast-mode choice (off here) right after reconnectedToTable.
    expect(w.emitted('S3').map(([ev]) => ev)).toEqual(['reconnectedToTable', 'fastModeSet', 'loginResult']);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);                 // the consumed reservation's timer was cleared
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
  });

  it('TOURNAMENT seat: resume dropped during the gate leaves the reservation; at 6h nothing is credited and the seat stays in play (T1)', async () => {
    const w = world({ tournament: true });
    const r = await aliceReserved(w);
    expect(r.tournament).toBe(true);
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    await w.drop(s2);
    gate.resolve();
    await pending;
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.playerSessions.has('S2')).toBe(false);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    expect(w.notCashed()).toEqual([expect.objectContaining({ userId: ALICE, reason: 'reserve_expiry', seatKept: true })]);
  });

  it('oauthLogin: dropped during the gate → the REAL reservation is left intact; dropped before its session → no session set', async () => {
    const w = world();
    const r = await aliceReserved(w);
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    await w.drop(s2);
    gate.resolve();
    await pending;
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.authSessions.has('S2')).toBe(false);
    expect(w.playerSessions.has('S2')).toBe(false);

    w.ctl.gateGate = null;
    const lp = deferred();
    w.ctl.loadProgressGate = lp.p;
    const s3 = w.mkSocket('S3');
    const pending3 = s3.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    await w.drop(s3);
    lp.resolve();
    await pending3;
    expect(w.authSessions.has('S3')).toBe(false);
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.m.loginsOnDeadSocket.abandoned).toBe(2);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('oauthLogin post-restart ORPHAN: the synthetic reservation its scan built is dropped (it must not block the next scan); the seat stays the orphan it was', async () => {
    const w = world();                                         // Alice's seat survived a restart: no session, no reservation
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, cleanupTimer: undefined }); // synthetic
    await w.drop(s2);
    gate.resolve();
    await pending;
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    expect(w.playerSessions.size).toBe(0);
    expect(w.credits).toEqual([]);

    w.ctl.gateGate = null;                                     // the next login re-finds and restores it
    const s3 = w.mkSocket('S3');
    await s3.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    expect(w.playerSessions.get('S3')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.table.seats[0].chipCount).toBe(7000);
  });

  it('tokenLogin (legacy HS256): dropped during the gate → reservation intact, no session; expiry credits once', async () => {
    const w = world();
    const r = await aliceReserved(w);
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.tokenLogin({ token: 'legacy-alice' });
    await flush();
    expect(w.authSessions.has('S2')).toBe(true);
    await w.drop(s2);
    gate.resolve();
    await pending;
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.authSessions.has('S2')).toBe(false);
    expect(w.playerSessions.has('S2')).toBe(false);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('a suspended player whose socket drops during the gate: the gate acts on NOTHING (no stand-up / credit there) — the reservation ends by itself, once', async () => {
    const w = world();
    const r = await aliceReserved(w);
    w.ctl.suspended.add('m-alice');
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    await w.drop(s2);
    gate.resolve();
    await pending;
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.table.seats[0].state).toBe('occupied');
    expect(w.credits).toEqual([]);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('CONTROL — without the U1 checks the resume consumes the reservation and its timer, binds the seat to the dead socket, and the stack is never cashed out', async () => {
    // Q3 (2026-10-10): the overtake check would ALSO stop this login (the disconnect removed its
    // session) — off too, so the control shows the pre-U1 behaviour.
    const off = (s: string) => s.split('loginSocketGone(').join('(() => false)(').split('loginSessionReplaced(').join('(() => false)(');
    const over = {
      resume: off(P.resume),
      refuseSeatRestore: P.refuseSeatRestore.replace('if (!socket.connected) return refusal;', '').replace('if (mine && socketSessionOvertaken(socket, mine)) return refusal;', ''),
    };
    expect(over.resume).not.toBe(P.resume);
    expect(over.refuseSeatRestore).not.toBe(P.refuseSeatRestore);
    const w = world({ over });
    await aliceReserved(w);
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const s2 = w.mkSocket('S2');
    const pending = s2.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    await w.drop(s2);
    gate.resolve();
    await pending;
    expect(w.reservedSeats.has(ALICE)).toBe(false);            // consumed
    expect(w.playerSessions.has('S2')).toBe(true);             // bound to the dead socket
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);                             // never cashed out
    expect(w.table.seats[0].state).toBe('occupied');
  });

  it('wiring: in every login handler, no session is set and no seat is bound after an await without a socket check in between; the seat-restore gate checks right after its own await', () => {
    const handler = (start: string, end: string) =>
      slice(start, end).split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const bodies: Record<string, string> = {
      resumeSession: handler("    'resumeSession',\n", "\n    })\n  );\n"),
      oauthLogin: handler("socket.on('oauthLogin', trackLogin(socket, 'oauthLogin', async", '\n  }));\n'),
      tokenLogin: handler("socket.on('tokenLogin', trackLogin(socket, 'tokenLogin', async", '\n  }));\n'),
      authWithTicket: handler("    trackLogin(socket, 'authWithTicket', async", "\n    })\n  );\n"),
    };
    // 2026-10-21 (gameplay S6) — a reservation restore binds the seat inside the
    // shared (synchronous) restoreSeatReservation: each call is a bind here.
    const expectedSets: Record<string, [number, number]> = {
      resumeSession: [1, 1], oauthLogin: [1, 1], tokenLogin: [2, 2], authWithTicket: [1, 0],
    };
    const restoreBody = SEAT_RESTORE_SRC.slice(SEAT_RESTORE_SRC.indexOf('function restoreSeatReservation('));
    expect(restoreBody.slice(0, restoreBody.indexOf('\n}\n'))).not.toContain('await ');
    for (const [name, body] of Object.entries(bodies)) {
      const at = (needle: string) => {
        const out: number[] = [];
        for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) out.push(i);
        return out;
      };
      const sets = at('authSessions.set(socket.id');
      const binds = [...at('playerSessions.set(socket.id'), ...at('restoreSeatReservation(socket,')];
      expect({ name, sets: sets.length, binds: binds.length }).toEqual({ name, sets: expectedSets[name][0], binds: expectedSets[name][1] });
      for (const pos of [...sets, ...binds]) {
        const before = body.slice(0, pos);
        const lastAwait = before.lastIndexOf('await ');
        const lastCheck = before.lastIndexOf('loginSocketGone(socket,');
        expect({ name, pos, checkedAfterLastAwait: lastCheck > lastAwait }).toEqual({ name, pos, checkedAfterLastAwait: true });
      }
    }
    const gate = fnSrc('async function refuseSeatRestoreIfBarred(');
    const awaitAt = gate.indexOf("const refusal = (await assertPlayable(socket, `${via}:seatRestore`, [], { waitForLogin: false }))");
    // P-k (round 6): the local-ban lookup is the gate's second (and last) await — the check follows both.
    const banAwaitAt = gate.indexOf('?? (await bannedAccountRefusal(userId, `${via}:seatRestore`));');
    const checkAt = gate.indexOf('if (!socket.connected) return refusal;');
    expect(awaitAt).toBeGreaterThan(-1);
    expect(banAwaitAt).toBeGreaterThan(awaitAt);
    expect(gate.lastIndexOf('await ', checkAt)).toBeLessThan(checkAt);
    expect(gate.lastIndexOf('await ', checkAt)).toBeLessThanOrEqual(banAwaitAt + 4);
    expect(checkAt).toBeGreaterThan(banAwaitAt);
    expect(checkAt).toBeLessThan(gate.indexOf('reservedSeats.delete(userId)'));
    expect(checkAt).toBeLessThan(gate.indexOf("handlePlayerLeave(socket, 'kept')"));
    // A REAL reservation is never touched by the bail-out; only a synthetic one (no timer), and only on request.
    const gone = P.loginSocketGone;
    expect(gone).toContain('if (socket.connected) return false;');
    expect(gone).toContain('if (r && !r.cleanupTimer) { reservedSeats.delete(opts.dropSyntheticReservationOf); syntheticDropped = true; }');
    expect(gone.split('reservedSeats.delete(').length - 1).toBe(1);
  });
});

// ── U2 ────────────────────────────────────────────────────────────────────
describe('U2 — a suspended player with an ABSENT tournament seat is disqualified at the hand-start gate and never paid', () => {
  it('reserved (disconnected) + suspended: disqualified at the next boundary (master id from the reservation snapshot), seat stood up, reservation + timer gone, nothing credited, paid NOTHING', async () => {
    const w = world({ tournament: true });
    w.seatLive('SB', 102, 1);
    w.seatLive('SC', 103, 2);
    await aliceReserved(w);
    w.ctl.suspended.add('m-alice');

    w.gate();                                                  // first boundary: no cached status yet → refresh
    expect(w.statusLookups).toContain('m-alice');              // (the live seats' ids are refreshed too)
    expect(w.table.seats[0].state).toBe('occupied');
    await flush();
    w.gate();                                                  // next boundary: cached suspended → disqualified
    const alice = w.tm!.getTournament(w.tid)!.players.find((p) => p.playerId === 'user_101')!;
    expect(alice).toMatchObject({ eliminated: true, disqualified: true, chips: 0 });
    expect(w.table.seats[0].state).toBe('empty');
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.playGateHandStart).toMatchObject({ disqualified: 1, absentDisqualified: 1, standUps: 1 });
    expect(w.notCashed()).toEqual([expect.objectContaining({ userId: ALICE, reason: 'suspended_absent_disqualified', chips: 7000 })]);
    expect(w.table.seats[1].state).toBe('occupied');           // the others play on
    expect(w.table.seats[2].state).toBe('occupied');
    jest.advanceTimersByTime(SEAT_RESERVE_MS);                 // its timer was cleared: no reserve_expiry
    await flush();
    expect(w.notCashed()).toHaveLength(1);

    w.tm!.eliminatePlayer(w.tid, 'user_103');                 // the tournament finishes
    const results = w.getResults()!;
    expect(results.find((r) => r.playerId === 'user_102')).toMatchObject({ position: 1 });
    expect(results.find((r) => r.playerId === 'user_101')).toMatchObject({ payout: 0, disqualified: true });
    expect(w.credits).toEqual([]);
  });

  it('heads-up, the absent player suspended: the batch disqualification finishes the tournament — the present player wins, the suspended one is paid nothing', async () => {
    const w = world({ tournament: true, seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']] });
    w.seatLive('SB', 102, 1);
    await aliceReserved(w);
    w.ctl.suspended.add('m-alice');
    w.statusCache.set('m-alice', true);
    w.gate();
    expect(w.tm!.getTournament(w.tid)!.status).toBe('finished');
    const results = w.getResults()!;
    expect(results.find((r) => r.playerId === 'user_102')).toMatchObject({ position: 1 });
    expect(results.find((r) => r.playerId === 'user_102').payout).toBeGreaterThan(0);
    expect(results.find((r) => r.playerId === 'user_101')).toMatchObject({ position: 2, payout: 0, disqualified: true });
  });

  it('absent AND live suspended entrants at one boundary are disqualified in ONE batch — the eligible survivor wins', async () => {
    const w = world({ tournament: true });
    w.seatLive('SB', 102, 1);
    w.seatLive('SC', 103, 2);
    await aliceReserved(w);
    for (const m of ['m-alice', 'm-bob']) { w.ctl.suspended.add(m); w.statusCache.set(m, true); }
    w.gate();
    const results = w.getResults()!;
    expect(results.find((r) => r.playerId === 'user_103')).toMatchObject({ position: 1 });
    expect(results.find((r) => r.playerId === 'user_101')).toMatchObject({ payout: 0, disqualified: true });
    expect(results.find((r) => r.playerId === 'user_102')).toMatchObject({ payout: 0, disqualified: true });
  });

  it('absent with NO reservation left (6h expiry / post-restart): the master id is resolved in the background, the seat is acted on at a later boundary', async () => {
    const w = world({ tournament: true });
    w.seatLive('SB', 102, 1);
    w.seatLive('SC', 103, 2);                                  // Alice's seat: no session, no reservation
    w.ctl.suspended.add('m-alice');
    w.gate();                                                  // id unknown → background lookup, nothing done
    expect(w.table.seats[0].state).toBe('occupied');
    await flush();
    expect(w.m.absentSeatMasterIds.get(ALICE)).toMatchObject({ masterId: 'm-alice' });
    expect(w.statusLookups).toContain('m-alice');              // …and its status warmed for the next boundary
    w.gate();                                                  // next boundary: known + cached → disqualified
    expect(w.table.seats[0].state).toBe('empty');
    expect(w.tm!.getTournament(w.tid)!.players.find((p) => p.playerId === 'user_101')).toMatchObject({ disqualified: true });
  });

  it('an absent tournament player who is NOT suspended is left in play; a CASH table absent seat is untouched (left to its reservation)', async () => {
    const t = world({ tournament: true });
    t.seatLive('SB', 102, 1);
    await aliceReserved(t);
    t.statusCache.set('m-alice', false);
    t.gate();
    expect(t.table.seats[0].state).toBe('occupied');
    expect(t.reservedSeats.has(ALICE)).toBe(true);

    const c = world();
    c.seatLive('SB', 102, 1);
    await aliceReserved(c);
    c.ctl.suspended.add('m-alice');
    c.statusCache.set('m-alice', true);
    c.gate();
    expect(c.table.seats[0].state).toBe('occupied');
    expect(c.reservedSeats.has(ALICE)).toBe(true);
    expect(c.credits).toEqual([]);
  });

  it('the seat-restore gate never bare-stands a TOURNAMENT seat: a suspended absent player who reconnects is refused, his seat kept for the hand-start gate, which disqualifies it', async () => {
    const w = world({ tournament: true });
    w.seatLive('SB', 102, 1);
    w.seatLive('SC', 103, 2);
    await aliceReserved(w);
    w.ctl.suspended.add('m-alice');
    const s2 = w.mkSocket('S2');
    await s2.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.emitted('S2').map(([ev, p]) => [ev, p?.code ?? null])).toEqual([['loginResult', null], ['error', 'player_suspended']]);
    expect(w.playerSessions.has('S2')).toBe(false);            // not restored
    expect(w.table.seats[0].state).toBe('occupied');           // NOT bare-stood-up
    expect(w.tm!.getTournament(w.tid)!.players.find((p) => p.playerId === 'user_101')!.eliminated).toBe(false);
    w.gate();                                                  // status cached by the gate's lookup
    expect(w.table.seats[0].state).toBe('empty');
    expect(w.tm!.getTournament(w.tid)!.players.find((p) => p.playerId === 'user_101')).toMatchObject({ eliminated: true, disqualified: true });
    expect(w.credits).toEqual([]);
  });

  it('an absent seat is stood up ONLY once he is really disqualified — if the disqualification fails, the seat stays in play (a stood-up but live entrant would wedge the tournament)', async () => {
    const w = world({ tournament: true });
    w.seatLive('SB', 102, 1);
    w.seatLive('SC', 103, 2);
    const r = await aliceReserved(w);
    w.ctl.suspended.add('m-alice');
    w.statusCache.set('m-alice', true);
    (w.tm as any).disqualifyPlayers = () => { throw new Error('boom'); };
    w.gate();
    expect(w.playGateHandStart.errors).toBe(1);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.playGateHandStart).toMatchObject({ disqualified: 0, absentDisqualified: 0, standUps: 0 });
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — without the U2 branch the absent suspended entrant is never screened, kept in play (T1) and PAID as the survivor', async () => {
    const needle = 'if (tournamentIdForGate && (!owner || !io.sockets.sockets.get(owner.socketId))) {';
    expect(P.handStartGate).toContain(needle);
    const w = world({ tournament: true, over: { handStartGate: P.handStartGate.replace(needle, 'if (false) {') } });
    w.seatLive('SB', 102, 1);
    w.seatLive('SC', 103, 2);
    await aliceReserved(w);
    w.ctl.suspended.add('m-alice');
    w.statusCache.set('m-alice', true);
    w.gate();
    expect(w.table.seats[0].state).toBe('occupied');
    w.tm!.eliminatePlayer(w.tid, 'user_103');
    w.tm!.eliminatePlayer(w.tid, 'user_102');
    const alice = w.getResults()!.find((r) => r.playerId === 'user_101');
    expect(alice).toMatchObject({ position: 1 });
    expect(alice.payout).toBeGreaterThan(0);                   // a suspended player paid 1st place
  });
});

// ── U3 ────────────────────────────────────────────────────────────────────
describe('U3 — a table break never credits a tournament reservation (isTournamentReservation, not tournamentTables)', () => {
  /** The ≤5s break window: the broken table's id is gone from tournamentTables, the table itself still exists, his stack is also on the target. */
  function breakWindow(w: ReturnType<typeof world>) {
    const target = w.mkTable('t2');
    expect(target.sitDown(5, 'Alice', w.table.seats[0].chipCount, 'user_101', false, true)).toBe(true);
    w.tournamentTables.set('t2', w.tid);
    w.tournamentTables.delete('t1');
    return target;
  }

  it('cashOutSeatsBeforeGuestClaim: a tournament reservation on a broken table is NOT credited (the stack is still on the target table)', async () => {
    const w = world({ tournament: true });
    const r = await aliceReserved(w);
    const target = breakWindow(w);
    expect(r.tournament).toBe(true);
    await w.m.cashOutSeatsBeforeGuestClaim(ALICE);
    expect(w.credits).toEqual([]);
    expect(target.seats[5].chipCount).toBe(7000);
  });

  it('refuseSeatRestoreIfBarred (suspended): a tournament reservation on a broken table is neither credited nor stood up', async () => {
    const w = world({ tournament: true });
    await aliceReserved(w);
    breakWindow(w);
    w.ctl.suspended.add('m-alice');
    const s2 = w.mkSocket('S2');
    w.authSessions.set('S2', { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice' });
    const refusal = await w.m.refuseSeatRestoreIfBarred(s2, ALICE, 'alice.player', 'resumeSession');
    expect(refusal).toMatchObject({ code: 'player_suspended' });
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.table.seats[0].state).toBe('occupied');
  });

  it('clearGhostSeatsForUser (a join on the reserved table): a tournament reservation on a broken table is not credited; on a live tournament table behaviour is as before (no credit, audited)', async () => {
    const w = world({ tournament: true });
    await aliceReserved(w);
    breakWindow(w);
    w.authSessions.set('S7', { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice' });
    expect(w.m.clearGhostSeatsForUser(ALICE, 't1', 'S7')).toBe(1);
    await flush();
    expect(w.credits).toEqual([]);                             // creditSeatStackToWallet alone would mint 7000 here
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.notCashed()).toEqual([expect.objectContaining({ userId: ALICE, reason: 'ghost_seat_reserved', chips: 7000 })]);

    const live = world({ tournament: true });                  // no break: the same audit as before, no credit
    await aliceReserved(live);
    live.authSessions.set('S7', { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice' });
    expect(live.m.clearGhostSeatsForUser(ALICE, 't1', 'S7')).toBe(1);
    await flush();
    expect(live.credits).toEqual([]);
    expect(live.notCashed()).toEqual([expect.objectContaining({ userId: ALICE, reason: 'ghost_seat_reserved', chips: 7000 })]);

    const cash = world();                                       // a cash reservation is still credited, once
    await aliceReserved(cash);
    cash.authSessions.set('S7', { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice' });
    expect(cash.m.clearGhostSeatsForUser(ALICE, 't1', 'S7')).toBe(1);
    await flush();
    expect(cash.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('a CASH reservation is unchanged: the guest-claim pre-step credits it exactly once', async () => {
    const w = world();
    await aliceReserved(w);
    await w.m.cashOutSeatsBeforeGuestClaim(ALICE);
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
    expect(w.table.seats[0].state).toBe('empty');
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toHaveLength(1);
  });

  it('wiring: every consumer that ends a reservation decides by isTournamentReservation(reserved)', () => {
    const guest = fnSrc('async function cashOutSeatsBeforeGuestClaim(');
    expect(guest).toContain("cashOut(reserved.tableId, reserved.seatIndex, 'guest_claim_reserved_seat', isTournamentReservation(reserved));");
    const gate = fnSrc('async function refuseSeatRestoreIfBarred(');
    // S2 (2026-10-10): or an absent tournament seat found by account — kept the same way.
    expect(gate).toContain('const tournamentSeatKept = (!!reserved && isTournamentReservation(reserved)) || absentTournamentSeat;');
    expect(gate).toContain('if (reserved && !tournamentSeatKept && !(own && ');
    const ghost = fnSrc('function clearGhostSeatsForUser(');
    expect(ghost).toContain('if (isTournamentReservation(reserved)) {');
    expect(fnSrc('function tickReservedSeatHands(')).toContain('if (isTournamentReservation(reserved)) {');
    expect(P.departure).toContain('if (isTournamentReservation(reserved)) {');   // P4: the disconnect's reservation function
    expect(P.disconnect).toContain('reserveSeatForDeparture(authSession, session, table, seat);');
    // R2 (item 1, 2026-10-11): the shutdown flush's reserved-seat claim (claimSeatsForShutdown).
    expect(fnSrc('function claimSeatsForShutdown('))
      .toContain('if (isTournamentReservation(reserved)) { shutdownFlushStats.seatsNotCashed++; continue; }');
  });
});

// ── U4 ────────────────────────────────────────────────────────────────────
describe('U4 — an absent tournament seat past its hand limit acts on a short clock', () => {
  expect(ABSENT_TOURNAMENT_SEAT_TURN_MS).toBeGreaterThanOrEqual(1000);
  expect(ABSENT_TOURNAMENT_SEAT_TURN_MS).toBeLessThanOrEqual(5000);

  /** Heads-up, Alice (seat 0) absent with a reservation; returns once it is her turn. */
  async function aliceToAct(opts: { tournament: boolean; handsRemaining: number }) {
    const w = world({ tournament: opts.tournament, seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']] });
    w.seatLive('SB', 102, 1);
    const r = await aliceReserved(w);
    r.handsRemaining = opts.handsRemaining;
    expect(w.table.startNewHand()).toBe(true);
    for (let guard = 0; guard < 6 && w.table.activeSeatIndex !== 0; guard++) {
      const a = w.table.activeSeatIndex;
      if (!w.table.playerCall(a)) w.table.playerCheck(a);
    }
    expect(w.table.activeSeatIndex).toBe(0);
    const phase0 = w.table.currentPhase;
    w.m.armTurnTimer('t1');
    // Acted for = the street moved on (his check closed it), the turn passed, or the hand ended.
    const acted = () => w.table.currentPhase !== phase0 || w.table.activeSeatIndex !== 0 || !w.table.isHandInProgress();
    return { w, acted };
  }

  it(`tournament seat past the limit (handsRemaining 0): acted for after ${ABSENT_TOURNAMENT_SEAT_TURN_MS}ms, not ${TURN_TIMEOUT_MS}ms`, async () => {
    const { acted } = await aliceToAct({ tournament: true, handsRemaining: 0 });
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);
  });

  it('BEFORE the limit he keeps the full clock (he may be reconnecting)', async () => {
    const { acted } = await aliceToAct({ tournament: true, handsRemaining: 2 });
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(acted()).toBe(true);
  });

  it('a player who reconnects during the short clock gets the REST of the normal clock, not an auto-action', async () => {
    const { w, acted } = await aliceToAct({ tournament: true, handsRemaining: 0 });
    jest.advanceTimersByTime(1000);
    w.playerSessions.set('S9', { socketId: 'S9', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'user_101', sittingOut: false });
    w.reservedSeats.delete(ALICE);                              // the restore consumed it
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1000 - ABSENT_TOURNAMENT_SEAT_TURN_MS - 1);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(1);                                // 30s after the turn began
    expect(acted()).toBe(true);
  });

  it('a CASH reservation never gets the short clock', async () => {
    const { acted } = await aliceToAct({ tournament: false, handsRemaining: 0 });
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS);
    expect(acted()).toBe(false);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS - ABSENT_TOURNAMENT_SEAT_TURN_MS);
    expect(acted()).toBe(true);
  });

  it('end to end with the real hand tick: after DISCONNECT_HANDS_LIMIT hands the reservation is kept (T1) and the next turn is short', async () => {
    const w = world({ tournament: true, seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']] });
    w.seatLive('SB', 102, 1);
    await aliceReserved(w);
    for (let i = 0; i < HANDS_LIMIT; i++) {
      expect(w.table.startNewHand()).toBe(true);
      for (let guard = 0; guard < 40 && w.table.isHandInProgress(); guard++) w.table.playerFold(w.table.activeSeatIndex);
      w.m.tickReservedSeatHands('t1');
    }
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ handsRemaining: 0 });
    expect(w.credits).toEqual([]);
    expect(w.table.startNewHand()).toBe(true);
    for (let guard = 0; guard < 6 && w.table.activeSeatIndex !== 0; guard++) {
      const a = w.table.activeSeatIndex;
      if (!w.table.playerCall(a)) w.table.playerCheck(a);
    }
    expect(w.table.activeSeatIndex).toBe(0);
    const phase0 = w.table.currentPhase;
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(ABSENT_TOURNAMENT_SEAT_TURN_MS - 1);
    expect(w.table.currentPhase === phase0 && w.table.activeSeatIndex === 0 && w.table.isHandInProgress()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(w.table.currentPhase !== phase0 || w.table.activeSeatIndex !== 0 || !w.table.isHandInProgress()).toBe(true);
  });
});

// ── P4 (2026-10-10) ────────────────────────────────────────────────────────
/**
 * A login that binds a socket to a DIFFERENT account (shared browser: a Play
 * Online / waitlist deep link for one account and the stored refresh-token
 * sign-in of another race on ONE socket) used to rebind authSessions while
 * playerSessions still held the previous account's seat — and every cash-out
 * reads authSessions. Every login now releases the socket first
 * (releaseSocketForAccountSwitch): the previous account's seat is reserved
 * for IT, exactly as if its socket had dropped.
 */
describe('P4 — a login that switches a socket to ANOTHER account never inherits the previous account\'s seat', () => {
  /**
   * Bob (102) is signed in on S1 and seated at t1 seat 1 (5,000). Alice has no
   * seat of her own here (her seat 0 is vacated), so nothing of hers can be restored.
   */
  const bobSeated = (w: ReturnType<typeof world>) => { w.table.standUp(0); return w.seatLive('S1', 102, 1); };

  it.each([
    ['resumeSession', (s: any) => s.handlers.resumeSession({ resumeToken: 'tok' })],
    ['oauthLogin', (s: any) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
  ] as const)('%s for Alice on Bob\'s seated socket: Bob\'s seat is RESERVED for Bob; a leave credits Alice nothing; Bob\'s reservation cashes out to BOB', async (_via, login) => {
    const w = world();
    const s1 = bobSeated(w);
    await login(s1);
    await flush();
    expect(w.authSessions.get('S1')).toMatchObject({ userId: ALICE });
    expect(w.playerSessions.has('S1')).toBe(false);                            // Alice did not inherit Bob's seat
    expect(w.reservedSeats.get(102)).toMatchObject({ tableId: 't1', seatIndex: 1, tournament: false });
    expect(w.table.seats[1]).toMatchObject({ state: 'occupied', chipCount: 5000 });
    expect(w.m.socketAccountSwitches).toMatchObject({ switches: 1, seatsReserved: 1 });
    w.m.handlePlayerLeave(s1);                                                 // Alice leaves "her" table
    await flush();
    expect(w.credits).toEqual([]);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);                                 // Bob never came back
    await flush();
    expect(w.credits).toEqual([{ uid: 102, amount: 5000 }]);                    // his own stack, to HIS wallet, once
  });

  it('CONTROL — without the release (pre-P4) the resume rebinds the socket under Bob\'s seat and Alice\'s leave credits BOB\'s 5,000 to ALICE', async () => {
    const CALL = "        releaseSocketForAccountSwitch(socket, userId, 'resumeSession');\n";
    expect(P.resume).toContain(CALL);
    const w = world({ over: { resume: P.resume.replace(CALL, '') } });
    const s1 = bobSeated(w);
    await s1.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    expect(w.authSessions.get('S1')).toMatchObject({ userId: ALICE });
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 't1', seatIndex: 1 });   // Bob's seat, now under Alice
    w.m.handlePlayerLeave(s1);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 5000 }]);                  // the theft
  });

  it('a TOURNAMENT seat is reserved as a tournament seat (kept in play, never cashed out — T1)', async () => {
    const w = world({ tournament: true });
    const s1 = bobSeated(w);
    await s1.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    expect(w.reservedSeats.get(102)).toMatchObject({ tournament: true });
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.table.seats[1]).toMatchObject({ state: 'occupied', chipCount: 5000 });
  });

  it('the SAME account signing in again on its socket (a token refresh) changes nothing: seat, session and no reservation', async () => {
    const w = world();
    const s1 = w.seatLive('S1', ALICE, 0);
    await s1.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.m.socketAccountSwitches.switches).toBe(0);
  });

  it('a seat on the socket with NO account behind it is stood up without any credit — a login never adopts a stack it did not buy', async () => {
    const w = world();
    w.table.standUp(0);                                                         // (Alice has no orphan seat to recover)
    const s1 = w.mkSocket('S1');
    w.playerSessions.set('S1', { socketId: 'S1', tableId: 't1', seatIndex: 2, playerName: 'Carl', playerId: 'user_103', sittingOut: false });
    await s1.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    expect(w.table.seats[2].state).toBe('empty');
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.credits).toEqual([]);
    expect(w.m.socketAccountSwitches.unownedSeatsCleared).toBe(1);
  });

  it('wiring: every login releases the socket right before it binds the new account', () => {
    const sites = [
      ["socket.on('register'", "releaseSocketForAccountSwitch(socket, result.userData.id, 'register');"],
      ["socket.on('oauthLogin'", "releaseSocketForAccountSwitch(socket, userId, 'oauthLogin');"],
      ["socket.on('tokenLogin'", "releaseSocketForAccountSwitch(socket, userId, 'tokenLogin');"],
      ["socket.on('tokenLogin'", "releaseSocketForAccountSwitch(socket, userId, 'tokenLogin_legacy');"],
      ["'authWithTicket',", "releaseSocketForAccountSwitch(socket, localUser.id, 'authWithTicket');"],
      ["'resumeSession',", "releaseSocketForAccountSwitch(socket, userId, 'resumeSession');"],
      // 2026-10-11 (AUTH-11) — the waitlist bootstrap resolves master-first and,
      // for a first-time master, creates his row (auth/masterRow.ts): ONE bind site.
      ["'joinWithWaitlistContext',", "releaseSocketForAccountSwitch(socket, wlRow.id, 'joinWithWaitlistContext');"],
    ];
    for (const [handler, call] of sites) {
      const at = SRC.indexOf(handler);
      const callAt = SRC.indexOf(call, at);
      expect({ call, found: at > -1 && callAt > at }).toEqual({ call, found: true });
      // The very next statement binds the session (nothing awaited in between).
      const next = SRC.slice(callAt + call.length).trimStart();
      expect({ call, next: next.slice(0, 26) }).toEqual({ call, next: 'authSessions.set(socket.id' });
    }
    // No other authSessions.set on a socket outside these (and the gate tests' fakes).
    expect(SRC.split('authSessions.set(socket.id').length - 1).toBe(sites.length);
  });
});

// ── Q3 (2026-10-10) ────────────────────────────────────────────────────────
/**
 * The rest of P4's server half. A login sets its auth session, then awaits the
 * seat-restore play gate before it binds the seat. On a shared browser (an old
 * bundle starts a Play Online ticket for one account and the stored sign-in of
 * another at once) a DIFFERENT account's login can take the socket during that
 * await (releaseSocketForAccountSwitch + its own authSessions.set). The
 * overtaken login used to restore its seat under the other account — and every
 * cash-out reads authSessions. Now it restores nothing (loginSessionReplaced).
 */
describe('Q3 — a login OVERTAKEN by another account on its socket never restores its seat under that account', () => {
  /** Bob's ticket sign-in reaching its set point on S2 — exactly what authWithTicket does (release + set, synchronous). */
  const bobTakesSocket = (w: ReturnType<typeof world>, s: any) => {
    w.m.releaseSocketForAccountSwitch(s, 102, 'authWithTicket');
    w.authSessions.set(s.id, { userId: 102, username: 'bob.player', masterUserId: 'm-bob', phone: 'x' });
  };

  async function overtaken(login: (s: any) => Promise<unknown>, over: Partial<typeof P> = {}) {
    const w = world({ over });
    const r = await aliceReserved(w);                                          // Alice: 7,000 reserved (her old socket dropped)
    const s2 = w.mkSocket('S2');                                               // the shared browser's socket
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const pending = login(s2);
    await flush();
    expect(w.authSessions.get('S2')).toMatchObject({ userId: ALICE });        // set — now held in the seat-restore gate
    bobTakesSocket(w, s2);
    gate.resolve();
    w.ctl.gateGate = null;
    await pending;
    await flush();
    return { w, r, s2 };
  }

  it.each([
    ['oauthLogin', (s: any) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
    ['tokenLogin (OIDC branch)', (s: any) => s.handlers.tokenLogin({ token: 'oidc-alice' })],
    ['tokenLogin (legacy branch)', (s: any) => s.handlers.tokenLogin({ token: 'legacy-alice' })],
    ['resumeSession', (s: any) => s.handlers.resumeSession({ resumeToken: 'tok' })],
  ] as const)('%s for Alice, overtaken by Bob during its gate: nothing restored under Bob, her reservation + timer intact, credited ONCE to her at expiry', async (_via, login) => {
    const { w, r, s2 } = await overtaken(login);
    expect(w.authSessions.get('S2')).toMatchObject({ userId: 102 });          // Bob's session untouched
    expect(w.playerSessions.has('S2')).toBe(false);                            // Alice's seat NOT bound under Bob
    expect(w.reservedSeats.get(ALICE)).toBe(r);                                // her REAL reservation, untouched…
    expect(w.reservedSeats.get(ALICE).cleanupTimer).toBe(r.cleanupTimer);      // …with its cash-out timer
    expect(w.emitted('S2').map(([ev]) => ev)).not.toContain('reconnectedToTable');
    expect(w.emitted('S2').filter(([ev, d]) => ev === 'loginResult' && d.success)).toEqual([]);
    expect(w.m.loginsOvertaken.abandoned).toBe(1);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    w.m.handlePlayerLeave(s2);                                                 // Bob leaves: nothing of Alice's to credit
    await flush();
    expect(w.credits).toEqual([]);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);                                 // Alice never came back
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);                  // her stack, to HER wallet, exactly once
    // …and a later sign-in of Alice's would have restored it instead (the reservation was hers to the end).
  });

  it('…and Alice\'s NEXT sign-in restores the seat from that intact reservation', async () => {
    const { w } = await overtaken((s) => s.handlers.resumeSession({ resumeToken: 'tok' }));
    const s3 = w.mkSocket('S3');
    await s3.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    expect(w.playerSessions.get('S3')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);                                             // seated again: nothing cashed out
  });

  it('CONTROL — without the overtake checks (pre-Q3) Alice\'s seat is restored under BOB, and Bob\'s leave credits Alice\'s 7,000 to BOB', async () => {
    const OFF = 'if (mine && socketSessionOvertaken(socket, mine)) return refusal;';
    expect(P.refuseSeatRestore).toContain(OFF);
    expect(P.oauth).toContain('loginSessionReplaced(');
    const { w, s2 } = await overtaken((s) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' }), {
      oauth: P.oauth.split('loginSessionReplaced(').join('(() => false)('),
      refuseSeatRestore: P.refuseSeatRestore.replace(OFF, ''),
    });
    expect(w.authSessions.get('S2')).toMatchObject({ userId: 102 });
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });   // Alice's seat, under Bob
    w.m.handlePlayerLeave(s2);
    await flush();
    expect(w.credits).toEqual([{ uid: 102, amount: 7000 }]);                    // the theft
  });

  it('a parallel sign-in of the SAME account is not an overtake: the seat is restored once, no reservation left, nothing credited', async () => {
    const w = world();
    await aliceReserved(w);
    const s2 = w.mkSocket('S2');
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const a = s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    const b = s2.handlers.tokenLogin({ token: 'oidc-alice' });                 // the same player's second boot sign-in
    await flush();
    gate.resolve();
    w.ctl.gateGate = null;
    await a;
    await b;
    await flush();
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.m.loginsOvertaken.abandoned).toBe(0);
    expect(w.emitted('S2').filter(([ev]) => ev === 'reconnectedToTable')).toHaveLength(1);
    expect(w.emitted('S2').filter(([ev, d]) => ev === 'loginResult' && d.success)).toHaveLength(2);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);
  });

  it('wiring: every seat-restoring login passes its OWN session to the gate and checks the overtake right after it, before any restore', () => {
    const all = (body: string, needle: string) => {
      const out: number[] = [];
      for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) out.push(i);
      return out;
    };
    for (const [name, body, n] of [['oauthLogin', P.oauth, 1], ['tokenLogin', P.tokenLogin, 2], ['resumeSession', P.resume, 1]] as const) {
      const gates = all(body, 'await refuseSeatRestoreIfBarred(socket, userId,');
      // 2026-10-21 (gameplay S6) — the restore binds through restoreSeatReservation.
      const restores = all(body, 'restoreSeatReservation(socket, userId,');
      expect({ name, gates: gates.length, restores: restores.length }).toEqual({ name, gates: n, restores: n });
      gates.forEach((g, i) => {
        const call = body.slice(g, body.indexOf(');', g) + 2);
        expect({ name, passesSession: /, (oauthSession|tlSession|legacySession|rsSession)\);$/.test(call) }).toEqual({ name, passesSession: true });
        const check = body.indexOf('loginSessionReplaced(socket,', g);
        expect({ name, i, checkedBeforeRestore: check > g && check < restores[i] }).toEqual({ name, i, checkedBeforeRestore: true });
      });
    }
    const gate = P.refuseSeatRestore;
    const overtakeAt = gate.indexOf('if (mine && socketSessionOvertaken(socket, mine)) return refusal;');
    expect(overtakeAt).toBeGreaterThan(gate.indexOf('const refusal = await assertPlayable('));
    expect(overtakeAt).toBeLessThan(gate.indexOf('reservedSeats.delete(userId)'));
    expect(overtakeAt).toBeLessThan(gate.indexOf("handlePlayerLeave(socket, 'kept')"));
    // The bail-out never touches the other account's session, and drops only a SYNTHETIC reservation.
    expect(P.loginOvertake).not.toContain('authSessions.delete(');
    expect(P.loginOvertake).toContain('if (r && !r.cleanupTimer) { reservedSeats.delete(opts.dropSyntheticReservationOf); syntheticDropped = true; }');
  });
});

describe('minor (2026-10-10) — the post-restart orphan-seat scans never claim a seat RESERVED for another account', () => {
  it('Bob\'s oauthLogin, his display name equal to Alice\'s seat name (ticket names collide), does not take Alice\'s reserved seat', async () => {
    const w = world();
    const r = await aliceReserved(w);                                          // seat 0 'Alice', reserved for ALICE
    w.users.get(102).display_name = 'Alice';
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-bob' });
    await flush();
    expect(w.authSessions.get('S2')).toMatchObject({ userId: 102 });
    expect(w.reservedSeats.has(102)).toBe(false);                              // no synthetic reservation onto her seat
    // 2026-10-11 (R1REV-1): oauthLogin's recovery is BY ACCOUNT — Bob may get HIS OWN
    // session-less seat 1 (user_102) back, never Alice's seat 0, whatever his name.
    const bob = w.playerSessions.get('S2');
    if (bob) expect(bob).toMatchObject({ tableId: 't1', seatIndex: 1 });
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('CONTROL (R1REV-1, 2026-10-11) — even WITHOUT the reserved-for-another check, the account-based scan cannot reach Alice\'s seat: Bob never sits on seat 0 and never collects her 7,000', async () => {
    // Pre-R1REV-1 this control removed the check and Bob's NAME scan stole Alice's
    // seat (his leave credited her 7,000 to him). oauthLogin no longer matches by
    // name at all; the check stays as defense in depth (it guards tokenLogin too).
    const CHECK = 'if (seatReservedByOtherAccount(userId, t.tableId, i)) continue;';
    expect(P.oauth).toContain(CHECK);
    expect(P.tokenLogin).toContain(CHECK);
    const w = world({ over: { oauth: P.oauth.replace(CHECK, '') } });
    await aliceReserved(w);
    w.users.get(102).display_name = 'Alice';
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-bob' });
    await flush();
    expect(w.playerSessions.get('S2')?.seatIndex).not.toBe(0);
    w.m.handlePlayerLeave(s2);
    await flush();
    expect(w.credits).not.toContainEqual({ uid: 102, amount: 7000 });
  });
});

// ── S2 / M5 (2026-10-10, review pe2) ─────────────────────────────────────────
describe('S2/M5 — a sign-in restores the account\'s ABSENT tournament seat by ACCOUNT (no reservation needed)', () => {
  /** Alice's tournament seat is absent with NO reservation (a start that dealt her in absent, a reservation past 6h, a taken reservation slot). */
  function absentAlice(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, over });
    w.tm!.setTableId(w.tid, 't1');                                         // what the single-table start records
    // A ticket-style seat name, so oauthLogin's post-restart NAME scan (which would build a reservation) does not
    // match: the seat is found by ACCOUNT only.
    w.table.seats[0].playerName = 'Alice A.';
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    return w;
  }
  const signIn = async (s: any, via: 'resumeSession' | 'oauthLogin' | 'tokenLogin_legacy') => {
    if (via === 'resumeSession') await s.handlers.resumeSession({ resumeToken: 'tok' });
    else if (via === 'oauthLogin') await s.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    else await s.handlers.tokenLogin({ token: 'legacy-alice' });
  };

  it.each(['resumeSession', 'oauthLogin', 'tokenLogin_legacy'] as const)(
    '%s: her absent seat comes back (the seat\'s entrant id), reconnectedToTable before loginResult, nothing credited',
    async (via) => {
      const w = absentAlice();
      const s = w.mkSocket('S9');
      await signIn(s, via);
      expect(w.playerSessions.get('S9')).toMatchObject({ tableId: 't1', seatIndex: 0, playerId: 'user_101' });
      const evs = w.emitted('S9').map(([ev]) => ev);
      expect(evs).toContain('reconnectedToTable');
      expect(evs.indexOf('loginResult')).toBeGreaterThan(evs.indexOf('reconnectedToTable'));
      expect(w.emitted('S9').find(([ev]) => ev === 'reconnectedToTable')![1]).toEqual({ tableId: 't1', seatIndex: 0, tournamentId: w.tid, sittingOut: false });   // F87 (2026-10-21): + sittingOut
      expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
      expect(w.credits).toEqual([]);
    },
  );

  it('a SUSPENDED account is not put back: the gate runs (an absent tournament seat is something to restore), the seat stays in play absent, the refusal follows loginResult', async () => {
    const w = absentAlice();
    w.ctl.suspended.add('m-alice');
    const s = w.mkSocket('S9');
    await s.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.playerSessions.has('S9')).toBe(false);
    expect(w.statusLookups.length + (w.statusCache.has('m-alice') ? 1 : 0)).toBeGreaterThan(0);
    const evs = w.emitted('S9').map(([ev, d]) => (ev === 'error' ? `error:${d.code}` : ev));
    expect(evs).toEqual(['loginResult', 'error:player_suspended']);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });   // left for the hand-start gate
    expect(w.credits).toEqual([]);
  });

  it('a seat another LIVE socket of hers holds is not taken over; another account\'s sign-in never gets it', async () => {
    const w = absentAlice();
    w.seatLive('S1', ALICE, 0);                                            // her desktop is playing it
    const s = w.mkSocket('S9');
    await signIn(s, 'resumeSession');
    expect(w.playerSessions.has('S9')).toBe(false);
    expect(w.playerSessions.get('S1')).toMatchObject({ seatIndex: 0 });
    const w2 = absentAlice();
    const bob = w2.mkSocket('S8');
    await bob.handlers.oauthLogin({ accessToken: 'oidc-bob' });
    expect(w2.playerSessions.get('S8')).toMatchObject({ seatIndex: 1, playerId: 'user_102' });   // HIS own absent seat, never hers
  });

  it('CONTROL — without the account restore (pre-S2) her absent seat is never found: she signs in to the lobby while her stack is blinded away', async () => {
    const w = absentAlice({
      resume: P.resume.replace("          if (!rsSeatRestoreRefusal) restoreAbsentTournamentSeat(socket, rsSession, 'resumeSession');\n", ''),
    });
    const s = w.mkSocket('S9');
    await signIn(s, 'resumeSession');
    expect(w.playerSessions.has('S9')).toBe(false);
    expect(w.emitted('S9').map(([ev]) => ev)).toEqual(['loginResult']);
  });

  it('wiring: every seat-restoring login (oauthLogin, tokenLogin both branches, resumeSession) restores by account after its gate + overtake checks, and skips it on a refusal', () => {
    const cases: Array<[string, string, string]> = [
      [P.oauth, "if (!seatRestoreRefusal) restoreAbsentTournamentSeat(socket, oauthSession, 'oauthLogin');", "if (loginSessionReplaced(socket, oauthSession, 'oauthLogin', 'after_seat_restore_gate'"],
      [P.tokenLogin, "try { restoreAbsentTournamentSeat(socket, tlSession, 'tokenLogin'); }", "if (loginSessionReplaced(socket, tlSession, 'tokenLogin', 'after_seat_restore_gate'"],
      [P.tokenLogin, "try { restoreAbsentTournamentSeat(socket, legacySession, 'tokenLogin_legacy'); }", "if (loginSessionReplaced(socket, legacySession, 'tokenLogin_legacy', 'after_seat_restore_gate'"],
      [P.resume, "if (!rsSeatRestoreRefusal) restoreAbsentTournamentSeat(socket, rsSession, 'resumeSession');", "if (loginSessionReplaced(socket, rsSession, 'resumeSession', 'after_seat_restore_gate'"],
    ];
    for (const [body, restore, overtake] of cases) {
      const at = body.indexOf(restore);
      expect({ restore, found: at > -1 }).toEqual({ restore, found: true });
      expect(body.indexOf(overtake)).toBeGreaterThan(-1);
      expect(body.indexOf(overtake)).toBeLessThan(at);
      expect(body.slice(body.indexOf(overtake), at)).not.toContain('await ');
    }
    expect(P.tokenLogin).toContain('if (!tlSeatRestoreRefusal) {');
    expect(P.tokenLogin).toContain('if (!legacySeatRestoreRefusal) {');
    expect(P.refuseSeatRestore).toContain('const absentTournamentSeat = !hasReservation && !playerSessions.has(socket.id) && !!account');
  });
});

// ── S2 FIXED PROTOCOL (2026-10-10, review pe3 — CONTRACTS C5) ────────────────
describe('P-b — no sign-in auto-restores a seat he LEFT on purpose: it TELLS him (tournamentSeatKept); a disconnect\'s seat comes back as before, with tournamentId', () => {
  /** Alice plays t1 seat 0 on S1 and taps Back to Lobby (P-a: a VOLUNTARY keep). */
  function aliceLeft(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, over });
    w.tm!.setTableId(w.tid, 't1');
    const s1 = w.seatLive('S1', ALICE, 0);
    w.m.handlePlayerLeave(s1);
    const r = w.reservedSeats.get(ALICE);
    expect(r).toMatchObject({ tableId: 't1', seatIndex: 0, voluntary: true, handsRemaining: 0, tournament: true });
    expect(w.emitted('S1')).toEqual([['tournamentSeatKept', { tournamentId: w.tid, tableId: 't1', seatIndex: 0, tournamentName: 'U-CUP', chips: 7000 }]]);
    return { w, s1, r };
  }
  const SIGN_INS: Array<[string, (s: any) => Promise<unknown>]> = [
    ['oauthLogin', (s) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
    ['resumeSession', (s) => s.handlers.resumeSession({ resumeToken: 'tok' })],
    ['tokenLogin (OIDC branch)', (s) => s.handlers.tokenLogin({ token: 'oidc-alice' })],
    ['tokenLogin (legacy branch)', (s) => s.handlers.tokenLogin({ token: 'legacy-alice' })],
  ];

  it.each(SIGN_INS)('%s: NOT put back — no session, no reconnectedToTable; her reservation intact (voluntary, its timer still armed); loginResult THEN tournamentSeatKept (current table/seat); no gate lookup', async (_via, signIn) => {
    const { w, r } = aliceLeft();
    const s = w.mkSocket('S9');
    await signIn(s);
    expect(w.playerSessions.has('S9')).toBe(false);
    const evs = w.emitted('S9').map(([ev]) => ev);
    expect(evs).not.toContain('reconnectedToTable');
    expect(evs.indexOf('tournamentSeatKept')).toBeGreaterThan(evs.indexOf('loginResult'));
    expect(evs.indexOf('loginResult')).toBeGreaterThan(-1);
    expect(w.emitted('S9').find(([ev]) => ev === 'tournamentSeatKept')![1]).toEqual({ tournamentId: w.tid, tableId: 't1', seatIndex: 0, tournamentName: 'U-CUP', chips: 7000 });
    expect(w.reservedSeats.get(ALICE)).toBe(r);
    expect(w.statusLookups).toEqual([]);                                     // nothing to restore → no play-status lookup
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    expect(w.credits).toEqual([]);
  });

  it('then Return to tournament (returnToTournamentSeat) puts her back on that socket: ack + returnToTournamentResult + reconnectedToTable {tournamentId}; her reservation consumed', async () => {
    const { w } = aliceLeft();
    const s = w.mkSocket('S9');
    await s.handlers.resumeSession({ resumeToken: 'tok' });
    const acks: any[] = [];
    await s.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (a: unknown) => acks.push(a));
    expect(acks).toEqual([{ success: true, tournamentId: w.tid, tableId: 't1', seatIndex: 0 }]);
    expect(w.emitted('S9')).toContainEqual(['returnToTournamentResult', { success: true, tournamentId: w.tid, tableId: 't1', seatIndex: 0 }]);
    expect(w.emitted('S9')).toContainEqual(['reconnectedToTable', { tableId: 't1', seatIndex: 0, tournamentId: w.tid, sittingOut: false }]);   // F87: + sittingOut
    expect(w.playerSessions.get('S9')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    // From now on it is his seat again: a later DISCONNECT is an ordinary (non-voluntary) reservation, auto-restored.
    await w.drop(s);
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.reservedSeats.get(ALICE).voluntary).toBeUndefined();
    const s10 = w.mkSocket('S10');
    await s10.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.playerSessions.get('S10')).toMatchObject({ tableId: 't1', seatIndex: 0 });
  });

  it('the voluntary mark outlives the reservation: after its expiry (T1: nothing credited) a sign-in still does NOT auto-restore her seat by account — it tells her', async () => {
    const { w } = aliceLeft();
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.credits).toEqual([]);
    const s = w.mkSocket('S9');
    await s.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    expect(w.playerSessions.has('S9')).toBe(false);
    expect(w.emitted('S9').map(([ev]) => ev)).toEqual(['loginResult', 'tournamentSeatKept']);
  });

  it.each([
    ['oauthLogin', (s: any) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
    ['resumeSession', (s: any) => s.handlers.resumeSession({ resumeToken: 'tok' })],
    ['tokenLogin (OIDC branch)', (s: any) => s.handlers.tokenLogin({ token: 'oidc-alice' })],
    ['tokenLogin (legacy branch)', (s: any) => s.handlers.tokenLogin({ token: 'legacy-alice' })],
  ] as Array<[string, (s: any) => Promise<unknown>]>)('%s: a DISCONNECT\'s tournament reservation is auto-restored as before, and its reconnectedToTable carries tournamentId; nothing extra is told', async (_via, signIn) => {
    const w = world({ tournament: true });
    await aliceReserved(w);
    const s = w.mkSocket('S9');
    await signIn(s);
    expect(w.playerSessions.get('S9')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    // F87 (2026-10-21): + sittingOut (a tournament restore is never kept sitting out).
    expect(w.emitted('S9').find(([ev]) => ev === 'reconnectedToTable')![1]).toEqual({ tableId: 't1', seatIndex: 0, tournamentId: w.tid, sittingOut: false });
    expect(w.emitted('S9').map(([ev]) => ev)).not.toContain('tournamentSeatKept');
  });

  it('a CASH reservation\'s reconnectedToTable is unchanged (no tournamentId)', async () => {
    const w = world();
    await aliceReserved(w);
    const s = w.mkSocket('S9');
    await s.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.emitted('S9').find(([ev]) => ev === 'reconnectedToTable')![1]).toEqual({ tableId: 't1', seatIndex: 0, sittingOut: false });   // F87: + sittingOut
  });

  it('CONTROL — without the P-b skip, a sign-in restores the seat she LEFT (pre-fix: every reconnect / re-auth put her back, even out of the avatar editor)', async () => {
    // 2026-10-21 (gameplay S6) — the skip lives in the ONE restore every sign-in calls.
    const GUARD = "if (!reserved || reserved.voluntary || !(reserved.expiresAt > Date.now())) return { outcome: 'none' };";
    expect(P.seatRestore).toContain(GUARD);
    const { w } = aliceLeft({ seatRestore: P.seatRestore.replace(GUARD, "if (!reserved || !(reserved.expiresAt > Date.now())) return { outcome: 'none' };") });
    const s = w.mkSocket('S9');
    await s.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.playerSessions.get('S9')).toMatchObject({ tableId: 't1', seatIndex: 0 });
  });

  it('the seat-restore gate never counts a VOLUNTARY reservation as something to restore (and the suspended stand-up branch leaves it alone)', () => {
    expect(P.refuseSeatRestore).toContain('const hasReservation = !!(pending && !pending.voluntary && pending.expiresAt > Date.now());');
    expect(P.refuseSeatRestore).toContain('const held = heldNow && !heldNow.voluntary ? heldNow : undefined;');
    expect(P.refuseSeatRestore).toContain('const reserved = reservedNow && !reservedNow.voluntary ? reservedNow : undefined;');
  });
});

describe('pe3 minor — oauthLogin\'s display-name orphan scan never hands a TOURNAMENT seat to a same-named account', () => {
  /** Carl's absent tournament seat carries the display name "Alice" (ticket names collide); Alice's own seat is held by her desktop. */
  function sameName(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, over });
    w.tm!.setTableId(w.tid, 't1');
    w.seatLive('S1', ALICE, 0);                                             // her own seat: live on her desktop
    w.table.seats[2].playerName = 'Alice';                                  // Carl's seat, absent (no session, no reservation)
    return w;
  }
  const SCAN_SKIP = '            if (isTournamentTable(t.tableId)) continue;\n';

  it('her phone signs in (oauthLogin): Carl\'s seat is NOT matched by name — no session on it, his stack untouched', async () => {
    const w = sameName();
    const s = w.mkSocket('S9');
    await s.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    expect(w.playerSessions.has('S9')).toBe(false);
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.table.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000, playerId: 'user_103' });
  });

  it('CONTROL (R1REV-1, 2026-10-11) — even WITHOUT the tournament skip, the account-based scan never puts Alice\'s phone on CARL\'s seat (user_103)', async () => {
    // Pre-R1REV-1 this control removed the skip and the NAME scan seated Alice's
    // phone on Carl's same-named tournament seat. The skip stays as defense in
    // depth; the account match alone already refuses Carl's seat.
    expect(P.oauth).toContain(SCAN_SKIP);
    const w = sameName({ oauth: P.oauth.replace(SCAN_SKIP, '') });
    const s = w.mkSocket('S9');
    await s.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    expect(w.playerSessions.get('S9')?.seatIndex).not.toBe(2);
    expect(w.table.seats[2]).toMatchObject({ state: 'occupied', chipCount: 5000, playerId: 'user_103' });
  });

  it('tokenLogin\'s post-restart playerId scan skips tournament tables too', () => {
    expect(P.tokenLogin).toContain('              if (isTournamentTable(t.tableId)) continue;\n');
  });
});

// ── Round 5 (pe4 minor, 2026-10-10) — the ALL-ABSENT tournament hand ─────────
// ── P-i (round 6, 2026-10-10) — replaces round 5's unbounded all-absent CALL ──
/**
 * The server's action for an ABSENT tournament seat (autoActForSeat): CHECK
 * when nothing is owed; CALL only at most ONE big blind that leaves chips
 * behind, and only when every seat still in the hand is absent too; otherwise
 * FOLD. Round 5 called any bet in an all-absent hand — a player who shoved and
 * then tapped Back to Lobby got the other absent stack called all-in (pe5 X2).
 */
describe('P-i (round 6) — an absent tournament seat checks, limps at most ONE big blind only when every seat in the hand is absent, else folds; never all-in by a call', () => {
  const LIMP = 'if (absentTournamentSeatMayLimp(tableId, t, seatIndex, callAmt) && t.playerCall(seatIndex)) {';
  const BOUND = 'if (!seat || callAmt <= 0 || callAmt > handBB || callAmt >= seat.chipCount) return false;';
  const NO_RAISE = '  if (t.currentPhase !== GamePhase.PreFlop || t.currentBetToMatch > handBB) return false;\n';
  // Z3 (2026-10-10): the ceiling is the big blind the HAND was dealt at.
  const HAND_BB = 'const handBB = t.handBigBlind > 0 ? t.handBigBlind : t.config.bigBlind;';
  /** Plays ONE hand on the turn timer alone (nobody acts). Returns the folds and the auto-calls seen. */
  function playOnTimer(w: ReturnType<typeof world>) {
    const folds: number[] = [];
    const calls: number[] = [];
    w.table.on('playerAction', (d: { seatIndex: number; action: PlayerAction }) => {
      if (d.action === PlayerAction.Fold) folds.push(d.seatIndex);
      if (d.action === PlayerAction.Call || d.action === PlayerAction.AllIn) calls.push(d.seatIndex);
    });
    expect(w.table.startNewHand()).toBe(true);
    for (let g = 0; g < 40 && w.table.isHandInProgress(); g++) {
      w.m.armTurnTimer('t1');
      jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    }
    return { folds, calls };
  }
  const total = (w: ReturnType<typeof world>) => w.table.seats.reduce((n, x) => n + (x.state === 'occupied' ? x.chipCount : 0), 0);

  it('three entrants, every one away (no session at the table): each timeout checks or limps the blind (≤ 1 BB); the hand reaches showdown; chips conserved; counted', () => {
    const w = world({ tournament: true });
    const before = total(w);
    const amounts: number[] = [];
    w.table.on('playerAction', (d: { action: PlayerAction; amount?: number }) => { if (d.action === PlayerAction.Call) amounts.push(d.amount || 0); });
    const { folds, calls } = playOnTimer(w);
    expect(w.table.isHandInProgress()).toBe(false);
    expect(folds).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);                                   // the blind was completed, never folded to
    expect(Math.max(...amounts)).toBeLessThanOrEqual(50);                       // never more than one big blind
    expect(w.table.wentToShowdown).toBe(true);
    expect(w.table.communityCards).toHaveLength(5);
    expect(total(w)).toBe(before);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(calls.length);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — without the limp (check-or-fold only): the small blind folds to the big blind; no showdown (the round-5 stall the limp fixes)', () => {
    expect(P.autoAct).toContain(LIMP);
    const w = world({ tournament: true, over: { autoAct: P.autoAct.replace(LIMP, 'if (false) {') } });
    const { folds } = playOnTimer(w);
    expect(folds.length).toBeGreaterThan(0);
    expect(w.table.wentToShowdown).toBe(false);
  });

  /**
   * pe5 X2, heads-up: Alice (7000) shoves at the table and then taps Back to
   * Lobby (her session ends — kept absent, P-a); Bob (5000) is away. Every seat
   * in the hand is now absent, and Bob faces 7000.
   */
  function shoveThenLeave(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']], over });
    const alice = w.seatLive('SA', ALICE, 0);
    expect(w.table.startNewHand()).toBe(true);
    if (w.table.activeSeatIndex === 1) expect(w.table.playerCall(1)).toBe(true);   // Bob (the button) had limped before he left
    expect(w.table.activeSeatIndex).toBe(0);
    expect(w.table.playerAllIn(0)).toBe(true);                                   // Alice shoves…
    w.m.handlePlayerLeave(alice);                                               // …and taps Back to Lobby
    expect(w.playerSessions.size).toBe(0);
    expect(w.table.activeSeatIndex).toBe(1);
    const bobBefore = w.table.seats[1].chipCount;
    const actions: Array<[number, PlayerAction]> = [];
    w.table.on('playerAction', (d: { seatIndex: number; action: PlayerAction }) => actions.push([d.seatIndex, d.action]));
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    return { w, actions, bobBefore };
  }

  it('X2: Bob is never called into the shove — he FOLDS (only a ≤ 1 BB limp is ever called for an absent seat); he keeps his stack', () => {
    const { w, actions, bobBefore } = shoveThenLeave();
    expect(actions[0]).toEqual([1, PlayerAction.Fold]);
    expect(w.table.seats[1].chipCount).toBe(bobBefore);
    expect(w.table.seats[1].chipCount).toBeGreaterThan(4000);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(0);
    expect(w.credits).toEqual([]);
  });

  it('CONTROL — round 5 (any call in an all-absent hand): Bob is called ALL-IN for his whole stack while away (pe5 X2)', () => {
    expect(P.autoAct).toContain(BOUND);
    expect(P.autoAct).toContain(NO_RAISE);
    const { w, actions } = shoveThenLeave({ autoAct: P.autoAct.replace(BOUND, 'if (!seat || callAmt <= 0) return false;').replace(NO_RAISE, '') });
    expect(actions[0]).toEqual([1, PlayerAction.AllIn]);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(1);
  });

  /** All three away; the first seat to act facing the big blind has EXACTLY one big blind behind. */
  function shortStackToAct(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, over });
    expect(w.table.startNewHand()).toBe(true);
    const first = w.table.activeSeatIndex;
    expect(w.table.currentBetToMatch - w.table.seats[first].currentBet).toBe(50);
    w.table.seats[first].chipCount = 50;                                        // a call would put him all-in
    const actions: Array<[number, PlayerAction]> = [];
    w.table.on('playerAction', (d: { seatIndex: number; action: PlayerAction }) => actions.push([d.seatIndex, d.action]));
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    return { w, first, actions };
  }

  it('never ALL-IN by a call: an absent seat whose call would take every chip it has folds, even facing just the big blind', () => {
    const { w, first, actions } = shortStackToAct();
    expect(actions[0]).toEqual([first, PlayerAction.Fold]);
    expect(w.table.seats[first].chipCount).toBe(50);
  });

  it('CONTROL — without the chip guard the same timeout puts him all-in', () => {
    const { first, actions } = shortStackToAct({ autoAct: P.autoAct.replace(BOUND, 'if (!seat || callAmt <= 0 || callAmt > handBB) return false;') });
    expect(actions[0]).toEqual([first, PlayerAction.AllIn]);
  });

  /**
   * Heads-up, both away by the time it matters: Alice min-raises to 2 BB at the
   * table and then her session ends; Bob, the big blind, owes just ONE big blind
   * more — still a raise.
   */
  function bigBlindFacingMinRaise(over: Partial<typeof P> = {}, beforeTimer?: (t: PokerTable) => void) {
    const w = world({ tournament: true, seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']], over });
    const alice = w.seatLive('SA', ALICE, 0);
    expect(w.table.startNewHand()).toBe(true);
    if (w.table.activeSeatIndex !== 0) {                                       // Bob is the button: he limps, Alice is the big blind
      expect(w.table.playerCall(1)).toBe(true);
    }
    expect(w.table.activeSeatIndex).toBe(0);
    expect(w.table.playerRaise(0, 100)).toBe(true);                            // to 2 BB
    w.m.handlePlayerLeave(alice);
    expect(w.table.activeSeatIndex).toBe(1);
    expect(w.table.currentBetToMatch - w.table.seats[1].currentBet).toBeLessThanOrEqual(50);   // ≤ 1 BB to call
    if (beforeTimer) beforeTimer(w.table);
    const actions: Array<[number, PlayerAction]> = [];
    w.table.on('playerAction', (d: { seatIndex: number; action: PlayerAction }) => actions.push([d.seatIndex, d.action]));
    w.m.armTurnTimer('t1');
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    return { w, actions };
  }

  it('never calls a RAISE: facing a min-raise (one big blind more to call) the absent seat folds — only the blind itself is ever limped', () => {
    const { w, actions } = bigBlindFacingMinRaise();
    expect(actions[0]).toEqual([1, PlayerAction.Fold]);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(0);
  });

  it('CONTROL — "≤ 1 BB to call" alone: the same seat calls the raise', () => {
    expect(P.autoAct).toContain(NO_RAISE);
    const { actions } = bigBlindFacingMinRaise({ autoAct: P.autoAct.replace(NO_RAISE, '') });
    expect(actions[0]).toEqual([1, PlayerAction.Call]);
  });

  /** The blindLevelUp handlers' own mutation (index.ts), applied to the live table mid-hand: 25/50 -> 50/100. */
  const LEVEL_UP_SRC = 't.config.smallBlind = data.sb;\n        t.config.bigBlind = data.bb;';
  const levelUpMidHand = (t: PokerTable) => { t.config.smallBlind = 50; t.config.bigBlind = 100; };

  it('Z3: a blind level-up DURING the hand (config.bigBlind doubled) never widens the limp — facing a min-raise the absent seat still FOLDS', () => {
    expect(SRC).toContain(LEVEL_UP_SRC);                                        // the real handlers rewrite the live config mid-hand
    expect(P.autoAct).toContain(HAND_BB);
    const { w, actions } = bigBlindFacingMinRaise({}, levelUpMidHand);
    expect(w.table.config.bigBlind).toBe(100);
    expect(w.table.handBigBlind).toBe(50);                                      // captured when the hand was dealt
    expect(actions[0]).toEqual([1, PlayerAction.Fold]);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(0);
  });

  it('CONTROL — the pre-Z3 ceiling (the LIVE config.bigBlind): after the same level-up the absent seat CALLS the raise (pe6 RV6_F1)', () => {
    const { actions } = bigBlindFacingMinRaise({ autoAct: P.autoAct.replace(HAND_BB, 'const handBB = t.config.bigBlind;') }, levelUpMidHand);
    expect(actions[0]).toEqual([1, PlayerAction.Call]);
  });

  it('Z3: the level-up does not stop the limp of the blind itself — every seat away, the hand still limps / checks down to showdown at the hand\'s own level (<= 50)', () => {
    const w = world({ tournament: true });
    const before = total(w);
    const amounts: number[] = [];
    w.table.on('playerAction', (d: { action: PlayerAction; amount?: number }) => { if (d.action === PlayerAction.Call) amounts.push(d.amount || 0); });
    expect(w.table.startNewHand()).toBe(true);
    levelUpMidHand(w.table);
    for (let g = 0; g < 40 && w.table.isHandInProgress(); g++) {
      w.m.armTurnTimer('t1');
      jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    }
    expect(w.table.wentToShowdown).toBe(true);
    expect(amounts.length).toBeGreaterThan(0);
    expect(Math.max(...amounts)).toBeLessThanOrEqual(50);
    expect(total(w)).toBe(before);
  });

  it('PokerTable: handBigBlind is the level a hand was DEALT at; the next hand takes the new level; a snapshot carries it (an older one reads 0)', () => {
    const t = new PokerTable({ tableId: 'z3', tableName: 'z3', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    expect(t.sitDown(0, 'A', 5000, 'pa', false, true)).toBe(true);
    expect(t.sitDown(1, 'B', 5000, 'pb', false, true)).toBe(true);
    expect(t.handBigBlind).toBe(0);
    expect(t.startNewHand()).toBe(true);
    levelUpMidHand(t);
    expect(t.handBigBlind).toBe(50);
    const snap: any = t.serializeSnapshot();
    expect(snap.handBigBlind).toBe(50);
    const t2 = new PokerTable({ tableId: 'z3', tableName: 'z3', smallBlind: 50, bigBlind: 100, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9 } as any);
    t2.rehydrateFromSnapshot(snap);
    expect(t2.handBigBlind).toBe(50);
    delete snap.handBigBlind;
    t2.rehydrateFromSnapshot(snap);
    expect(t2.handBigBlind).toBe(0);
    for (let g = 0; g < 20 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    expect(t.isHandInProgress()).toBe(false);
    expect(t.startNewHand()).toBe(true);
    expect(t.handBigBlind).toBe(100);
  });

  it('a PRESENT player in the hand (live session): the absent seats fold facing a bet (no limp)', () => {
    const w = world({ tournament: true });
    w.seatLive('SB', 102, 1);                                                  // Bob is at the table
    const { folds } = playOnTimer(w);
    expect(folds.length).toBeGreaterThan(0);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(0);
  });

  it('a CASH table of absent players: folds as before (an absent player\'s wallet chips are never called for him)', () => {
    const w = world({ tournament: false });
    const { folds } = playOnTimer(w);
    expect(folds.length).toBeGreaterThan(0);
    expect(w.m.tournamentHandStartSafety.allAbsentAutoCalls).toBe(0);
  });

  it('wiring: the turn timer, the 500ms orphan auto-act and a tournament Sit Out / AFK on the clock all act through autoActForSeat; round 5\'s unbounded rule is gone', () => {
    // 2026-10-24 (Sit & Go fix-all F3) — the turn clock's action is stamped auto: 'timeout'.
    expect(P.armTurnTimer).toContain("const did = autoActForSeat(tableId, t, activeSeat, 'timeout');");
    const bc = fnSrc('function broadcastGameState(');
    expect(bc).toContain('autoActForSeat(tableId, t, activeIdx);');
    expect(bc).not.toContain('t.playerFold(activeIdx);');
    for (const ev of ['sitOut', 'playerAFK']) {
      // F156 (2026-10-21): both handlers now take an optional `{ tableId }`.
      // F87 (2026-10-21): sitOut's payload also takes `sittingOut?` — the slice starts at the common prefix.
      const body = slice(`socket.on('${ev}', async (data: { tableId?: string`, '\n  });\n');
      // F102 (2026-10-21): a club challenge seat is acted for the same way.
      expect(body).toContain('if (isTournamentTable(session.tableId) || challengeTables.has(session.tableId)) autoActForSeat(session.tableId, table, session.seatIndex);');
    }
    expect(SRC).not.toContain('tournamentHandAllAbsent');
  });
});

// ── P-k (round 6, 2026-10-10) — a BANNED account gets no seat back ──
describe('P-k (round 6) — a locally BANNED account (banUser / adminIPBan) is refused player_suspended by Return and by every sign-in restore', () => {
  const RETURN_BAN = "    if (!rtsGate && banChecked) rtsGate = await bannedAccountRefusal(banChecked.userId, 'returnToTournamentSeat');\n";
  const RESTORE_BAN = "\n    ?? (await bannedAccountRefusal(userId, `${via}:seatRestore`));";
  /** Alice left her tournament seat (Back to Lobby, voluntary); she signs in again on S2 and taps Return. */
  async function bannedReturn(over: Partial<typeof P> = {}) {
    const w = world({ tournament: true, over });
    w.tm!.setTableId(w.tid, 't1');
    const s1 = w.seatLive('S1', ALICE, 0);
    w.m.handlePlayerLeave(s1);
    w.ctl.banned.add(ALICE);
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    const acks: unknown[] = [];
    await s2.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (a: unknown) => acks.push(a));
    return { w, acks };
  }
  it('Return: { success:false, code:"player_suspended" }; nothing bound; the seat stays absent and is never credited', async () => {
    const { w, acks } = await bannedReturn();
    expect(acks).toEqual([{ success: false, error: 'SUSPENDED', code: 'player_suspended' }]);
    expect(w.playerSessions.has('S2')).toBe(false);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    expect(w.credits).toEqual([]);
  });
  it('CONTROL — without the ban check (round 5): the banned account is put back on the seat', async () => {
    expect(P.returnToTournament).toContain(RETURN_BAN);
    const { w, acks } = await bannedReturn({ returnToTournament: P.returnToTournament.replace(RETURN_BAN, '') });
    expect(acks).toEqual([{ success: true, tournamentId: w.tid, tableId: 't1', seatIndex: 0 }]);
  });

  /** Alice's socket drops at a CASH table (a disconnect's reservation); she is banned; she signs in again. */
  async function bannedSignIn(over: Partial<typeof P> = {}) {
    const w = world({ over });
    await aliceReserved(w);
    w.ctl.banned.add(ALICE);
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    return { w, evs: w.emitted('S2').map(([ev, d]) => [ev, ev === 'error' ? d.code : undefined]) };
  }
  it('sign-in restore (oauthLogin, a disconnect\'s reservation): not restored — refused player_suspended after loginResult; the cash seat is stood up and its stack credited back (no chip lost)', async () => {
    const { w, evs } = await bannedSignIn();
    expect(evs).toEqual([['loginResult', undefined], ['error', 'player_suspended']]);
    expect(w.playerSessions.has('S2')).toBe(false);
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.table.seats[0].state).toBe('empty');
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });
  it('CONTROL — without the ban check in the seat-restore gate: the banned account is reconnected to the seat', async () => {
    expect(P.refuseSeatRestore).toContain(RESTORE_BAN);
    const { w, evs } = await bannedSignIn({ refuseSeatRestore: P.refuseSeatRestore.replace(RESTORE_BAN, ';') });
    expect(evs.map(([ev]) => ev)).toContain('reconnectedToTable');
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
  });
  it('a TOURNAMENT reservation of a banned account is not restored either, and never credited (kept absent)', async () => {
    const w = world({ tournament: true });
    await aliceReserved(w);
    w.ctl.banned.add(ALICE);
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    expect(w.emitted('S2').map(([ev]) => ev)).toContain('error');
    expect(w.playerSessions.has('S2')).toBe(false);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    expect(w.credits).toEqual([]);
  });
});

// ── Round 5 (pe4 W1, P-c') — the server side of a Return whose answer is lost ──
describe('W1 / P-c\' (round 5, server side) — a Return lost with its transport: the reconnect\'s sign-in re-announces the kept seat; the client\'s one re-emit succeeds', () => {
  it('the Return\'s socket drops while its gate waits: never answered, nothing bound to it, the voluntary reservation intact; the NEW socket\'s oauthLogin tells tournamentSeatKept again; its returnToTournamentSeat puts her back', async () => {
    const w = world({ tournament: true });
    w.tm!.setTableId(w.tid, 't1');
    const s1 = w.seatLive('S1', ALICE, 0);
    w.m.handlePlayerLeave(s1);                                              // Back to Lobby (P-a: voluntary)
    const r = w.reservedSeats.get(ALICE);
    expect(r).toMatchObject({ voluntary: true });
    // Her Return goes out just as the phone sleeps: the gate is still waiting when the socket drops.
    const gate = deferred();
    w.ctl.gateGate = gate.p;
    const acks: unknown[] = [];
    const pending = s1.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (a: unknown) => acks.push(a));
    await flush();
    await w.drop(s1);
    gate.resolve();
    w.ctl.gateGate = null;
    await pending;
    expect(acks).toEqual([]);                                               // a dead socket is not answered
    expect(w.emitted('S1').map(([ev]) => ev)).not.toContain('returnToTournamentResult');
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.reservedSeats.get(ALICE)).toBe(r);                             // still kept, still voluntary
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
    // The reconnect (a new socket): its sign-in never auto-restores the voluntary seat — it RE-ANNOUNCES it.
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    expect(w.emitted('S2').map(([ev]) => ev)).toEqual(['loginResult', 'tournamentSeatKept']);
    expect(w.emitted('S2')[1][1]).toEqual({ tournamentId: w.tid, tableId: 't1', seatIndex: 0, tournamentName: 'U-CUP', chips: 7000 });
    // The client re-emits returnToTournamentSeat once (P-c'): answered success.
    const acks2: unknown[] = [];
    await s2.handlers.returnToTournamentSeat({ tournamentId: w.tid }, (a: unknown) => acks2.push(a));
    expect(acks2).toEqual([{ success: true, tournamentId: w.tid, tableId: 't1', seatIndex: 0 }]);
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.credits).toEqual([]);
  });
});

// ── Z6 (2026-10-10, pe6 nit) — a departure ON his turn checks when a check is free ──
describe('Z6 — a leave / disconnect on his own turn CHECKS when a check is free and FOLDS only facing a bet (consistent with P-i)', () => {
  const ACT = '    if (!(owed <= 0 && table.playerCheck(session.seatIndex))) table.playerFold(session.seatIndex);\n';
  /** Heads-up, both live: the first to act pre-flop (the button / small blind) calls or min-raises; then it is the big blind's turn. */
  function bigBlindToAct(tournament: boolean, first: 'call' | 'raise', over: Partial<typeof P> = {}) {
    const w = world({ tournament, seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']], over });
    const sa = w.seatLive('SA', ALICE, 0);
    const sb = w.seatLive('SB', 102, 1);
    expect(w.table.startNewHand()).toBe(true);
    const btn = w.table.activeSeatIndex;
    const bb = 1 - btn;
    if (first === 'call') expect(w.table.playerCall(btn)).toBe(true);
    else expect(w.table.playerRaise(btn, 100)).toBe(true);
    expect(w.table.activeSeatIndex).toBe(bb);
    const chips = () => w.table.seats.reduce((n, x) => n + x.chipCount + (x.totalInvestedThisHand || 0), 0);
    return { w, bb, sock: bb === 0 ? sa : sb, uid: bb === 0 ? ALICE : 102, chips, before: chips() };
  }

  // F46 (2026-10-21) — a DROPPED socket is no longer acted for at the drop: the
  // turn clock armed when his turn began acts at its end with the same Z6 rule
  // (check when free, else fold), so a reconnect inside it still plays.
  it('cash, his socket drops with the big blind\'s OPTION (nothing to call): his turn waits for his clock, which CHECKS — the hand goes on to the flop with his seat in it (reserved); no chip moves', async () => {
    const { w, bb, sock, uid, chips, before } = bigBlindToAct(false, 'call');
    w.m.armTurnTimer('t1');                                                   // armed when his turn began (turnChanged)
    await w.drop(sock);
    expect(w.table.seats[bb].folded).toBe(false);
    expect(w.table.activeSeatIndex).toBe(bb);                                 // F46 — still his turn
    expect(w.table.currentPhase).toBe(GamePhase.PreFlop);
    expect(w.reservedSeats.get(uid)).toMatchObject({ tableId: 't1', seatIndex: bb });
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(w.table.seats[bb].folded).toBe(false);
    expect(w.table.isHandInProgress()).toBe(true);
    expect(w.table.currentPhase).toBe(GamePhase.Flop);
    expect(chips()).toBe(before);
    expect(w.credits).toEqual([]);
  });

  it('cash, his socket drops FACING a raise: not folded at the drop; his clock FOLDS him at its end (the hand ends)', async () => {
    const { w, bb, sock } = bigBlindToAct(false, 'raise');
    w.m.armTurnTimer('t1');
    await w.drop(sock);
    expect(w.table.seats[bb].folded).toBe(false);
    expect(w.table.activeSeatIndex).toBe(bb);
    jest.advanceTimersByTime(TURN_TIMEOUT_MS);
    expect(w.table.seats[bb].folded).toBe(true);
    expect(w.table.isHandInProgress()).toBe(false);
  });

  it('CONTROL — pre-Z6 (fold whatever is owed): a CHOSEN departure (Back to Lobby — the voluntary keep acts at once) with the free check FOLDS — the pot handed to the other player', () => {
    expect(P.departure).toContain(ACT);
    const { w, bb, sock } = bigBlindToAct(true, 'call', { departure: P.departure.replace(ACT, '    table.playerFold(session.seatIndex);\n') });
    w.m.handlePlayerLeave(sock);
    expect(w.table.seats[bb].folded).toBe(true);
  });

  it('tournament, Back to Lobby with the big blind\'s option (the voluntary keep): CHECKED — the kept seat stays in the hand; nothing credited', () => {
    const { w, bb, sock, uid, chips, before } = bigBlindToAct(true, 'call');
    w.m.handlePlayerLeave(sock);
    expect(w.playerSessions.has(bb === 0 ? 'SA' : 'SB')).toBe(false);
    expect(w.table.seats[bb]).toMatchObject({ state: 'occupied', folded: false });
    expect(w.table.currentPhase).toBe(GamePhase.Flop);
    expect(w.reservedSeats.get(uid)).toMatchObject({ tableId: 't1', seatIndex: bb, voluntary: true });
    expect(chips()).toBe(before);
    expect(w.credits).toEqual([]);
  });

  it('tournament, Back to Lobby FACING a raise: folded (kept, out of this hand only)', () => {
    const { w, bb, sock } = bigBlindToAct(true, 'raise');
    w.m.handlePlayerLeave(sock);
    expect(w.table.seats[bb]).toMatchObject({ state: 'occupied', folded: true });
  });

  it('wiring: the keep\'s unreserved branch acts the same way; a cash LEAVE (the seat is torn down) still folds', () => {
    expect(P.seatKeep).toContain('      if (!(owed <= 0 && table.playerCheck(session.seatIndex))) table.playerFold(session.seatIndex);\n');
    // R2 (2026-10-11): the cash leave tears the seat down through teardownSeat,
    // which folds the seat on its own turn (outside a draw round) — as before.
    expect(P.handlePlayerLeave).toContain('teardownSeat(session.tableId, table, session.seatIndex,');
    // (foldSeatOutOfHand — teardownSeat's fold step, shared with the admin-DQ absent stand-up.)
    expect(SEAT_TEARDOWN_SRC).toContain('  if (!DrawPhases.includes(table.currentPhase) && table.activeSeatIndex === seatIndex) {\n    table.playerFold(seatIndex);');
    expect(SEAT_TEARDOWN_SRC).toContain('      foldSeatOutOfHand(table, seatIndex);');
  });
});

// ===================== 2026-10-10 round-7 review — two sessions on one seat =====================
describe('round-7 review (major) — a seat is never played by two sessions; a stale disconnect never acts for a seat someone plays', () => {
  const sessionsOnSeat = (w: any, tableId: string, seatIndex: number) =>
    [...w.playerSessions.entries()].filter(([, s]: any) => s.tableId === tableId && s.seatIndex === seatIndex).map(([sid]: any) => sid);

  it('tokenLogin\'s orphan-seat scan never binds a SECOND session to a seat a live session plays (as oauthLogin\'s)', async () => {
    const w = world({ seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']] });
    w.seatLive('S1', ALICE, 0);
    w.seatLive('SB', 102, 1);
    const s2 = w.mkSocket('S2');
    await s2.handlers.tokenLogin({ token: 'oidc-alice' });
    await flush();
    expect(sessionsOnSeat(w, (w.playerSessions.get('S1') as any).tableId, 0)).toEqual(['S1']);
    expect(w.playerSessions.get('S2')).toBeUndefined();
  });

  it('a disconnect whose seat ANOTHER socket now plays neither reserves it nor acts for it (her live hand is untouched)', async () => {
    const w = world({ seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']] });
    const s1 = w.seatLive('S1', ALICE, 0);
    w.seatLive('SB', 102, 1);
    expect(w.table.startNewHand()).toBe(true);
    // However it got there, a second live session now plays seat 0.
    const tableId = (w.playerSessions.get('S1') as any).tableId;
    const s2 = w.mkSocket('S2');
    w.playerSessions.set('S2', { ...(w.playerSessions.get('S1') as any), socketId: 'S2' });
    w.authSessions.set('S2', { ...(w.authSessions.get('S1') as any) });
    if (w.table.activeSeatIndex === 1) expect(w.table.playerRaise(1, 200)).toBe(true);
    expect(w.table.activeSeatIndex).toBe(0);
    await w.drop(s1);
    await flush();
    expect(w.table.seats[0].folded).toBe(false);          // not folded for her
    expect(w.reservedSeats.has(ALICE)).toBe(false);        // no stale reservation on the seat S2 plays
    expect(sessionsOnSeat(w, tableId, 0)).toEqual(['S2']); // S2 still plays it
    void s2;
  });
});

// ── R3 (K1-6) — a player's fast mode survives a seat restore ──
describe('R3 (K1-6) — the fast-mode choice survives a seat restore (and the client is told)', () => {
  const signInAs = async (s: any, via: 'resumeSession' | 'oauthLogin' | 'tokenLogin_legacy') => {
    if (via === 'resumeSession') await s.handlers.resumeSession({ resumeToken: 'tok' });
    else if (via === 'oauthLogin') await s.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    else await s.handlers.tokenLogin({ token: 'legacy-alice' });
  };

  it.each(['resumeSession', 'oauthLogin', 'tokenLogin_legacy'] as const)(
    '%s: Alice had fast mode ON; her socket dropped; the restored session has it ON and her socket gets fastModeSet {enabled:true} after reconnectedToTable',
    async (via) => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      w.playerSessions.get('S1').fastMode = true;          // what setFastMode {enabled:true} set
      await w.drop(s1);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, fastMode: true });
      const s2 = w.mkSocket('S2');
      await signInAs(s2, via);
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0, fastMode: true });
      const evs = w.emitted('S2');
      const at = (ev: string) => evs.findIndex(([e]) => e === ev);
      expect(evs).toContainEqual(['fastModeSet', { enabled: true }]);
      expect(at('fastModeSet')).toBeGreaterThan(at('reconnectedToTable'));
      expect(at('fastModeSet')).toBeLessThan(at('loginResult'));
    },
  );

  it('fast mode OFF stays off — the socket is told {enabled:false} (a toggle left showing ON resyncs)', async () => {
    const w = world();
    const s1 = w.seatLive('S1', ALICE, 0);
    await w.drop(s1);
    expect(w.reservedSeats.get(ALICE).fastMode).toBeUndefined();
    const s2 = w.mkSocket('S2');
    await s2.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.playerSessions.get('S2').fastMode).toBe(false);
    expect(w.emitted('S2')).toContainEqual(['fastModeSet', { enabled: false }]);
  });

  it('CONTROL — pre-R3 (no carry, no tell): the restored session had no fastMode (normal-speed bots) and nothing told the client', async () => {
    const DEPART = '    ...(session.fastMode ? { fastMode: true } : {}),\n';
    expect(P.departure).toContain(DEPART);
    const strip = (src: string) => src.split('restoreFastModeOnSeatRestore(socket, reserved);').join('');
    // 2026-10-21 (gameplay S6) — the restore's tell lives in the ONE shared restore.
    const w = world({ over: { departure: P.departure.replace(DEPART, ''), resume: strip(P.resume), seatRestore: strip(P.seatRestore) } });
    const s1 = w.seatLive('S1', ALICE, 0);
    w.playerSessions.get('S1').fastMode = true;
    await w.drop(s1);
    const s2 = w.mkSocket('S2');
    await s2.handlers.resumeSession({ resumeToken: 'tok' });
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    expect(w.playerSessions.get('S2').fastMode).toBeUndefined();
    expect(w.emitted('S2').map(([ev]) => ev)).not.toContain('fastModeSet');
  });
});

// ── R3 (live P1, 2026-10-11) ─────────────────────────────────────────────
// Live logs 2026-10-12: users 4198 and 4492 were reserved, restored by a
// sign-in, then dropped AGAIN — `disconnect_seat_not_his_after_save`: the
// restored session carried `user_<id>` while the seat kept its buy-in id, so
// the second disconnect reserved nothing and the seat was orphaned with its
// stack (auto-folded, blinded away, never cashed out).
describe('R3 (live P1) — a sign-in-RESTORED seat is still his on the NEXT disconnect: reserved again, never orphaned', () => {
  const BUY_IN_ID = 'player-alice-buyin';
  async function restoredOnce(w: ReturnType<typeof world>, login: (s: any) => Promise<unknown>) {
    w.table.seats[0].playerId = BUY_IN_ID;                                    // a real cash buy-in id (never user_<id>)
    const s1 = w.seatLive('S1', ALICE, 0);
    w.playerSessions.get('S1').playerId = BUY_IN_ID;                          // the buy-in session carries the seat's own id
    await w.drop(s1);
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
    const s2 = w.mkSocket('S2');
    await login(s2);
    await flush();
    expect(w.playerSessions.get('S2')).toMatchObject({
      tableId: 't1', seatIndex: 0, playerId: `user_${ALICE}`, seatPlayerId: BUY_IN_ID,
    });
    return s2;
  }

  it.each([
    ['oauthLogin', (s: any) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
    ['tokenLogin (OIDC branch)', (s: any) => s.handlers.tokenLogin({ token: 'oidc-alice' })],
    ['tokenLogin (legacy branch)', (s: any) => s.handlers.tokenLogin({ token: 'legacy-alice' })],
    ['resumeSession', (s: any) => s.handlers.resumeSession({ resumeToken: 'tok' })],
  ] as const)('%s restores her; her second drop RESERVES the seat again and the expiry credits her 7,000 exactly once', async (_via, login) => {
    const w = world();
    const s2 = await restoredOnce(w, login);
    await w.drop(s2);
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('…and a THIRD sign-in restores it again (the seat stays hers across any number of drops)', async () => {
    const w = world();
    const s2 = await restoredOnce(w, (s) => s.handlers.resumeSession({ resumeToken: 'tok' }));
    await w.drop(s2);
    const s3 = w.mkSocket('S3');
    await s3.handlers.resumeSession({ resumeToken: 'tok' });
    await flush();
    expect(w.playerSessions.get('S3')).toMatchObject({ tableId: 't1', seatIndex: 0, seatPlayerId: BUY_IN_ID });
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);                                             // seated again: nothing cashed out
  });

  it('CONTROL — the pre-R3 check (seat.playerId === session.playerId): the second drop reserves NOTHING and the 7,000 is orphaned, never credited', async () => {
    const ON = 'sessionHoldsSeat(session, seat) && !brokeMeanwhile';
    expect(P.disconnect).toContain(ON);
    const w = world({ over: { disconnect: P.disconnect.replace(ON, 'seat.playerId === session.playerId && !brokeMeanwhile') } });
    const s2 = await restoredOnce(w, (s) => s.handlers.resumeSession({ resumeToken: 'tok' }));
    await w.drop(s2);
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000, playerId: BUY_IN_ID });
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([]);
  });
});

// ── R3 review (SFC-1) ────────────────────────────────────────────────────
describe('R3 review (SFC-1) — a sign-in never puts a player back on a seat he LEFT that waits for its after-hand removal', () => {
  const LEFT_ID = 'player-alice-left';
  /** Alice left mid-hand with chips in the pot: teardownSeat queued the seat for the hand's end and ended her session. */
  function leftMidHand(w: ReturnType<typeof world>) {
    w.table.seats[0].playerId = LEFT_ID;
    (w.g.progressionManager as any).getProgress = (pid: string) => (pid === LEFT_ID ? { userId: ALICE } : undefined);
    (w.g.pendingSeatRemovalAfterHand as Map<string, Map<number, any>>)
      .set('t1', new Map([[0, { userId: ALICE, username: 'alice.player', playerId: LEFT_ID }]]));
  }

  it.each([
    ['oauthLogin', (s: any) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
    ['tokenLogin (OIDC branch)', (s: any) => s.handlers.tokenLogin({ token: 'oidc-alice' })],
  ] as const)('%s on a new socket before the hand ends: NOT restored (no session, no reservation, no reconnectedToTable)', async (_via, login) => {
    const w = world();
    leftMidHand(w);
    const s2 = w.mkSocket('S2');
    await login(s2);
    await flush();
    expect(w.playerSessions.has('S2')).toBe(false);
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.emitted('S2').map(([ev]) => ev)).not.toContain('reconnectedToTable');
  });

  it('CONTROL — without the pending-removal skip, the buy-in alias scan binds her new socket to the seat she left', async () => {
    const SKIP = 'if (pendingSeatRemovalAfterHand.get(t.tableId)?.has(i)) continue;';
    expect(P.oauth).toContain(SKIP);
    const w = world({ over: { oauth: P.oauth.split(SKIP).join('') } });
    leftMidHand(w);
    const s2 = w.mkSocket('S2');
    await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
    await flush();
    expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
  });
});

// ══════════════════════ 2026-10-21 — gameplay audit, server cluster S6 ══════════════════════
// Reconnect / restore / reservations. Real disconnect + sign-in handlers + the
// ONE shared restore (restoreSeatReservation) on the real PokerTable; every fix
// has a CONTROL that runs the pre-fix text.
describe('S6 — reconnect, restore and reservations (gameplay 2026-10-21)', () => {
  const SIGN_INS_S6: Array<[string, (s: any) => Promise<unknown>]> = [
    ['oauthLogin', (s) => s.handlers.oauthLogin({ accessToken: 'oidc-alice' })],
    ['tokenLogin (OIDC branch)', (s) => s.handlers.tokenLogin({ token: 'oidc-alice' })],
    ['tokenLogin (legacy branch)', (s) => s.handlers.tokenLogin({ token: 'legacy-alice' })],
    ['resumeSession', (s) => s.handlers.resumeSession({ resumeToken: 'tok' })],
  ];
  /** A live socket of `uid` seated at (tableId, seatIndex) — seatLive for any table. */
  const seatAt = (w: ReturnType<typeof world>, sid: string, uid: number, tableId: string, seatIndex: number, extra: Record<string, unknown> = {}) => {
    const s = w.mkSocket(sid);
    const u = w.users.get(uid);
    w.authSessions.set(sid, { userId: uid, username: u.username, masterUserId: `m-${u.display_name.toLowerCase()}`, ...extra });
    w.playerSessions.set(sid, {
      socketId: sid, tableId, seatIndex, playerName: u.display_name, playerId: `user_${uid}`, sittingOut: false,
    });
    return s;
  };
  const evNames = (w: ReturnType<typeof world>, sid: string) => w.emitted(sid).map(([ev]) => ev);
  const payloadOf = (w: ReturnType<typeof world>, sid: string, ev: string) => w.emitted(sid).find(([e]) => e === ev)?.[1];

  // ── F46 ──
  describe('F46 — a socket drop on his own turn facing a bet is NOT folded at the drop; a reconnect inside his clock still plays', () => {
    const ACT_NOW = 'if (opts.actNow && table.isHandInProgress() && table.activeSeatIndex === session.seatIndex';
    function aliceFacingRaise(over: Partial<typeof P> = {}) {
      const w = world({ seats: [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102']], over });
      const sa = w.seatLive('SA', ALICE, 0);
      w.seatLive('SB', 102, 1);
      // Alice must be the one facing the raise: deal until Bob opens (Bob is first to act pre-flop).
      for (let k = 0; k < 4; k++) {
        expect(w.table.startNewHand()).toBe(true);
        if (w.table.activeSeatIndex === 1) break;
        for (let g = 0; g < 10 && w.table.isHandInProgress(); g++) w.table.playerFold(w.table.activeSeatIndex);
      }
      expect(w.table.activeSeatIndex).toBe(1);
      expect(w.table.playerRaise(1, 200)).toBe(true);
      expect(w.table.activeSeatIndex).toBe(0);
      w.m.armTurnTimer('t1');                                               // armed when her turn began
      return { w, sa };
    }

    it('drop facing a raise → not folded, still her turn; she signs in 2s later (oauthLogin) → same seat, her CALL is accepted', async () => {
      const { w, sa } = aliceFacingRaise();
      await w.drop(sa);
      expect(w.table.seats[0].folded).toBe(false);
      expect(w.table.activeSeatIndex).toBe(0);
      jest.advanceTimersByTime(2000);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      await flush();
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
      expect(w.table.seats[0].folded).toBe(false);
      expect(w.table.playerCall(0)).toBe(true);
    });

    it('…and when she never comes back, her clock folds her at its end (the table never wedges)', async () => {
      const { w, sa } = aliceFacingRaise();
      await w.drop(sa);
      jest.advanceTimersByTime(TURN_TIMEOUT_MS - 1);
      expect(w.table.seats[0].folded).toBe(false);
      jest.advanceTimersByTime(1);
      expect(w.table.seats[0].folded).toBe(true);
    });

    it('CONTROL — pre-F46 (the departure acts at once): folded at the drop, her reconnect 2s later finds the hand lost', async () => {
      expect(P.departure).toContain(ACT_NOW);
      const { w, sa } = aliceFacingRaise({ departure: P.departure.replace(ACT_NOW, 'if (table.isHandInProgress() && table.activeSeatIndex === session.seatIndex') });
      await w.drop(sa);
      expect(w.table.seats[0].folded).toBe(true);
    });

    it('wiring: only a CHOSEN departure acts at once (the voluntary keep, an account switch); the disconnect handler never asks for it', () => {
      expect(P.disconnect).toContain('reserveSeatForDeparture(authSession, session, table, seat);');
      expect(P.disconnect).not.toContain('actNow');
      expect(P.seatKeep).toContain('reserveSeatForDeparture(auth, session, table, seat, { handsRemaining: 0, voluntary, actNow: true });');
      expect(P.accountSwitch).toContain('reserveSeatForDeparture(prev, session, table, seat, { actNow: true });');
    });
  });

  // ── F80 ──
  describe('F80 — a half-open reconnect: the reservation made when the OLD socket is reaped goes to his live NEW socket at once', () => {
    const NOTE = "noteHeldSeatClaim(socket, userId, 'oauthLogin');";

    it.each(SIGN_INS_S6)('%s on S2 while S1 still holds the seat: nothing restored yet; S1 reaped → S2 gets reconnectedToTable + the seat; the reservation (and its timer) consumed', async (_via, signIn) => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      const s2 = w.mkSocket('S2');
      await signIn(s2);
      await flush();
      expect(w.playerSessions.has('S2')).toBe(false);                      // never two sessions on one seat
      expect(evNames(w, 'S2')).not.toContain('reconnectedToTable');
      await w.drop(s1);                                                    // the ping timeout reaps S1
      await flush();
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
      expect(payloadOf(w, 'S2', 'reconnectedToTable')).toEqual({ tableId: 't1', seatIndex: 0, sittingOut: false });
      expect(w.reservedSeats.has(ALICE)).toBe(false);
      jest.advanceTimersByTime(SEAT_RESERVE_MS);
      await flush();
      expect(w.credits).toEqual([]);                                       // seated again: never cashed out
    });

    it('CONTROL — without the claim (pre-F80): S1 reaped → the seat is reserved for 6h and S2, signed in and live, is told nothing', async () => {
      expect(P.oauth).toContain(NOTE);
      const w = world({ over: { oauth: P.oauth.replace(NOTE, 'false;') } });
      const s1 = w.seatLive('S1', ALICE, 0);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      await w.drop(s1);
      await flush();
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
      expect(evNames(w, 'S2')).toEqual(['loginResult']);
    });

    it('a claim older than two ping cycles is not used (a real second tab opened long ago is never pulled in)', async () => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      jest.advanceTimersByTime(2 * (20_000 + 45_000) + 1);
      await w.drop(s1);
      await flush();
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
    });

    it('the adoption is gated like a sign-in restore: suspended meanwhile → not seated (the cash seat is stood up and credited once), the refusal sent', async () => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      w.ctl.suspended.add('m-alice');
      await w.drop(s1);
      await flush();
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(w.emitted('S2')).toContainEqual(['error', { message: 'SUSPENDED', code: 'player_suspended' }]);
      expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
      expect(w.table.seats[0].state).toBe('empty');
    });

    // S6 fix-up — the claim waits for the socket(s) that HOLD the seat, never any reap of the account.
    describe('Multi-Table View user, phone changes networks: BOTH sockets half-open; the secondary SX is reaped FIRST', () => {
      const NEW_ADOPT = slice('function adoptReservationByPendingClaim(', '\n}\n');
      // The S6 text (541161d): the claim was used up by the first reservation-producing reap.
      const OLD_ADOPT = `function adoptReservationByPendingClaim(userId) {
  const claim = pendingSeatClaims.get(userId);
  if (!claim) return;
  pendingSeatClaims.delete(userId);
  if (!(claim.until > Date.now())) { pendingSeatClaimStats.expired++; return; }
  const sock = io.sockets.sockets.get(claim.socketId);
  const auth = authSessions.get(claim.socketId);
  if (!sock || !sock.connected || !auth || auth.userId !== userId || auth.secondary || playerSessions.has(claim.socketId)) return;
  const r = reservedSeats.get(userId);
  if (!r || r.voluntary || r.secondary) return;
  void (async () => {
    const refusal = await refuseSeatRestoreIfBarred(sock, userId, auth.username, 'reaped_claim', auth);
    if (!sock.connected || authSessions.get(claim.socketId) !== auth || playerSessions.has(claim.socketId)) return;
    if (refusal) { pendingSeatClaimStats.refused++; emitPlayRefusal(sock, refusal); return; }
    const res = restoreSeatReservation(sock, userId, 'reaped_claim', { clearGhosts: true });
    if (res.outcome === 'restored') { pendingSeatClaimStats.adopted++; return; }
    if (res.dead) tellDeadTournamentSeat(sock, auth, res.dead);
    restoreAbsentTournamentSeat(sock, auth, 'reaped_claim');
  })().catch(() => {});
}
`;
      async function mtvHandoff(over: Partial<typeof P> = {}) {
        const w = world({ over });
        const t2 = w.mkTable('t2');
        expect(t2.sitDown(4, 'Alice', 3000, 'player-x', false, true)).toBe(true);
        const s1 = w.seatLive('S1', ALICE, 0);                              // primary: t1 seat 0, 7000
        const sx = seatAt(w, 'SX', ALICE, 't2', 4, { secondary: true });    // Multi-Table View socket: t2 seat 4, 3000
        w.playerSessions.get('SX').playerId = 'player-x';
        const s2 = w.mkSocket('S2');
        await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });     // the phone's new primary socket
        await flush();
        expect(w.playerSessions.has('S2')).toBe(false);
        await w.drop(sx);                                                   // reaped first
        await flush();
        await w.drop(s1);
        await flush();
        return { w, t2 };
      }

      it('SX\'s reap leaves the claim alone; S1\'s reap hands HIS seat to S2 at once (reconnectedToTable); the secondary seat is settled (3,000 credited) — nothing lost', async () => {
        const { w, t2 } = await mtvHandoff();
        expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
        expect(payloadOf(w, 'S2', 'reconnectedToTable')).toEqual({ tableId: 't1', seatIndex: 0, sittingOut: false });
        expect(w.reservedSeats.has(ALICE)).toBe(false);
        expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
        expect(t2.seats[4].state).toBe('empty');
        expect(w.credits).toEqual([{ uid: ALICE, amount: 3000 }]);
      });

      it('CONTROL — the S6 adoption (claim used up by ANY reap): SX\'s secondary reservation burns the claim; S1\'s seat is reserved and S2 is told nothing (the original strand)', async () => {
        expect(P.seatRestore).toContain(NEW_ADOPT);
        const { w } = await mtvHandoff({ seatRestore: P.seatRestore.replace(NEW_ADOPT, OLD_ADOPT) });
        expect(w.playerSessions.has('S2')).toBe(false);
        expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
        expect(evNames(w, 'S2')).toEqual(['loginResult']);
      });
    });

    it('a Multi-Table View (secondary) socket never claims: its sign-in skips recovery', async () => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice', skipSeatRecovery: true });
      await w.drop(s1);
      await flush();
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
    });
  });

  // ── F87 ──
  describe('F87 — a sign-in restore keeps a CASH Sit Out: tracker kept, dead-blind debt kept, the client told', () => {
    const KEEP = 'const keepSitOut = reserved.sittingOut === true && !isTournamentReservation(reserved);';
    function satOutThenDropped(over: Partial<typeof P> = {}, tournament = false) {
      const w = world({ over, tournament });
      const s1 = w.seatLive('S1', ALICE, 0);
      w.playerSessions.get('S1').sittingOut = true;                         // what 'sitOut' set
      w.playerSessions.get('S1').sitOutHands = 4;
      (w.g.sitOutTracker as Map<string, Set<number>>).set('t1', new Set([0]));
      w.table.seats[0].deadBlindOwedChips = 75;
      w.table.seats[0].missedBlind = 'big';
      return { w, s1 };
    }

    it.each(SIGN_INS_S6)('%s: still sitting out (session + tracker + 30-hand count), debt kept; reconnectedToTable.sittingOut true, then sitOutToggled {restored}; the next deal pre-folds him and takes no chip', async (_via, signIn) => {
      const { w, s1 } = satOutThenDropped();
      await w.drop(s1);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ sittingOut: true, sitOutHands: 4 });
      const s2 = w.mkSocket('S2');
      await signIn(s2);
      await flush();
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0, sittingOut: true, sitOutHands: 4 });
      expect([...((w.g.sitOutTracker as Map<string, Set<number>>).get('t1') || [])]).toEqual([0]);
      expect(w.table.seats[0]).toMatchObject({ deadBlindOwedChips: 75, missedBlind: 'big' });
      expect(payloadOf(w, 'S2', 'reconnectedToTable')).toEqual({ tableId: 't1', seatIndex: 0, sittingOut: true });
      const evs = evNames(w, 'S2');
      expect(evs.indexOf('sitOutToggled')).toBeGreaterThan(evs.indexOf('reconnectedToTable'));
      expect(payloadOf(w, 'S2', 'sitOutToggled')).toEqual({ sittingOut: true, reason: 'restored', tableId: 't1' });
      // syncSitOutToTable (inert in this world) pushes the tracker to the engine: the next deal skips him.
      w.table.setSittingOutSeats((w.g.sitOutTracker as Map<string, Set<number>>).get('t1')!);
      const chips = w.table.seats[0].chipCount;
      expect(w.table.startNewHand()).toBe(true);
      expect(w.table.seats[0].holeCards).toHaveLength(0);
      expect(w.table.seats[0].chipCount).toBe(chips);
    });

    it('CONTROL — pre-F87 (a restore always sat him in): not sitting out, tracker cleared, the debt still owed — the next deal deals him in and bills him', async () => {
      expect(P.seatRestore).toContain(KEEP);
      const { w, s1 } = satOutThenDropped({ seatRestore: P.seatRestore.replace(KEEP, 'const keepSitOut = false;') });
      await w.drop(s1);
      const s2 = w.mkSocket('S2');
      await s2.handlers.resumeSession({ resumeToken: 'tok' });
      expect(w.playerSessions.get('S2').sittingOut).toBe(false);
      expect(((w.g.sitOutTracker as Map<string, Set<number>>).get('t1') || new Set()).has(0)).toBe(false);
      expect(w.table.seats[0].deadBlindOwedChips).toBe(75);
    });

    it('a reservation NOT sitting out is restored exactly as before: tracker cleared, dead-blind debt forgiven (E5), no sitOutToggled', async () => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      w.table.seats[0].deadBlindOwedChips = 25;
      w.table.seats[0].missedBlind = 'small';
      await w.drop(s1);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ sittingOut: false });
      expect(w.table.seats[0]).toMatchObject({ deadBlindOwedChips: 0, missedBlind: 'none' });
      expect(evNames(w, 'S2')).not.toContain('sitOutToggled');
    });

    it('a TOURNAMENT reservation is restored NOT sitting out, as before (P-j / Z12)', async () => {
      const { w, s1 } = satOutThenDropped({}, true);
      await w.drop(s1);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0, sittingOut: false });
      expect(payloadOf(w, 'S2', 'reconnectedToTable')).toEqual({ tableId: 't1', seatIndex: 0, tournamentId: w.tid, sittingOut: false });
    });
  });

  // ── F89 ──
  describe('F89 — a reservation dropped because its table is gone takes its timer with it; a stale timer never ends the NEXT reservation', () => {
    const GUARD = '    if (reserved && reserved !== mine) return;   // F89 — another reservation\'s; never ours to end\n';
    const CLEAR = '  if (reserved.cleanupTimer) clearTimeout(reserved.cleanupTimer);   // F89 — every branch below ends it\n';
    const PRE_CLEAR = "  if (rTable && rSeat && rSeat.state === 'occupied' && !rSeat.isAI && !dead && reserved.cleanupTimer) clearTimeout(reserved.cleanupTimer);\n";
    async function staleTimerThenSecondReservation(over: Partial<typeof P> = {}) {
      const w = world({ over });
      const tX = w.mkTable('tX');
      expect(tX.sitDown(3, 'Alice', 4000, 'user_101', false, true)).toBe(true);
      const sx = seatAt(w, 'SX', ALICE, 'tX', 3);
      await w.drop(sx);                                                    // R1 (tX) — timer at t0 + 6h
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'tX' });
      w.tables.delete('tX');                                               // that table is removed
      jest.advanceTimersByTime(5 * 60 * 60 * 1000);
      const s2 = w.mkSocket('S2');
      await s2.handlers.resumeSession({ resumeToken: 'tok' });             // (b): table gone → R1 dropped
      expect(w.reservedSeats.has(ALICE)).toBe(false);
      const s3 = w.seatLive('S3', ALICE, 0);
      jest.advanceTimersByTime(50 * 60 * 1000);
      await w.drop(s3);                                                    // R2 (t1 seat 0), 10 min before R1's old timer
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);                        // R1's stale timer would fire now
      await flush();
      return w;
    }

    it('R2 survives R1\'s old expiry time: still reserved, seat still occupied, nothing credited', async () => {
      const w = await staleTimerThenSecondReservation();
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
      expect(w.table.seats[0].state).toBe('occupied');
      expect(w.credits).toEqual([]);
    });

    it('CONTROL — pre-F89 (no clearTimeout on the gone-table drop, a timer ends whatever reservation it finds): R2 is cashed out and stood up minutes after its own drop', async () => {
      expect(P.departure).toContain(GUARD);
      expect(P.seatRestore).toContain(CLEAR);
      const w = await staleTimerThenSecondReservation({
        departure: P.departure.replace(GUARD, ''),
        seatRestore: P.seatRestore.replace(CLEAR, PRE_CLEAR),
      });
      expect(w.reservedSeats.has(ALICE)).toBe(false);
      expect(w.table.seats[0].state).toBe('empty');
      expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
    });
  });

  // ── F77 ──
  describe('F77 — a Multi-Table View (secondary) socket never displaces the primary reservation; a primary sign-in never restores the secondary\'s table', () => {
    const SECONDARY = 'if (existing && authSession.secondary && !existing.secondary && !isTournamentTable(session.tableId)';
    const SKIP = "  if (reserved.secondary && !opts.allowSecondary) return { outcome: 'none' };\n";
    function twoSockets(over: Partial<typeof P> = {}) {
      const w = world({ over });
      const t2 = w.mkTable('t2');
      expect(t2.sitDown(4, 'Alice', 3000, 'player-x', false, true)).toBe(true);
      const sp = w.seatLive('SP', ALICE, 0);                               // primary: t1 seat 0, 7000
      const sx = seatAt(w, 'SX', ALICE, 't2', 4, { secondary: true });     // the extra view's socket: t2 seat 4, 3000
      w.playerSessions.get('SX').playerId = 'player-x';
      return { w, t2, sp, sx };
    }

    it('one blip drops both (primary first): the PRIMARY reservation is kept; the secondary seat is settled like an extra seat (3,000 credited, stood up)', async () => {
      const { w, t2, sp, sx } = twoSockets();
      await w.drop(sp);
      await w.drop(sx);
      await flush();
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
      expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
      expect(t2.seats[4].state).toBe('empty');
      expect(w.credits).toEqual([{ uid: ALICE, amount: 3000 }]);
      // …and the primary's sign-in restores HIS table.
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    });

    // S6 fix-up — the OTHER order of the same blip, with a hand in progress at t2.
    describe('one blip drops both, the SECONDARY FIRST, his chips in a live hand at t2', () => {
      const KEEP = 'keepHand ? { keepHandOnDeparture: true } : {}';
      async function secondaryFirst(over: Partial<typeof P> = {}) {
        const { w, t2, sp, sx } = twoSockets(over);
        expect(t2.sitDown(5, 'Yan', 5000, 'p-yan', false, true)).toBe(true);
        expect(t2.startNewHand()).toBe(true);
        for (let g = 0; g < 4 && t2.activeSeatIndex === 4; g++) t2.playerCall(4);
        expect(t2.activeSeatIndex).not.toBe(4);
        expect(t2.seats[4].totalInvestedThisHand).toBeGreaterThan(0);
        await w.drop(sx);
        expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't2', seatIndex: 4, secondary: true });
        await w.drop(sp);                                                   // displaces the secondary reservation
        await flush();
        return { w, t2 };
      }

      it('settled like the primary-first order: the t2 hand is KEPT (not folded), the stand-up and credit wait for the hand\'s end; the PRIMARY seat is reserved', async () => {
        const { w, t2 } = await secondaryFirst();
        expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0 });
        expect(w.table.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
        expect(t2.seats[4]).toMatchObject({ state: 'occupied', folded: false });
        expect(t2.isHandInProgress()).toBe(true);
        expect((w.g.pendingSeatRemovalAfterHand as Map<string, Map<number, any>>).get('t2')?.get(4)).toMatchObject({ userId: ALICE });
        expect(w.credits).toEqual([]);                                      // credited at the hand's end, once
      });

      it('CONTROL — the S6 displacement (endCashReservation with no keep): his live t2 hand is FOLDED out of turn', async () => {
        expect(P.departure).toContain(KEEP);
        const { t2 } = await secondaryFirst({ departure: P.departure.replace(KEEP, '{}') });
        expect(t2.seats[4].folded).toBe(true);
      });
    });

    it('CONTROL — pre-F77: the secondary drop DISPLACES the primary reservation — t1 cashed out and stood up, and the primary sign-in lands on t2', async () => {
      expect(P.departure).toContain(SECONDARY);
      const { w, sp, sx } = twoSockets({ departure: P.departure.replace(SECONDARY, 'if (false && existing'), seatRestore: P.seatRestore.replace(SKIP, '') });
      await w.drop(sp);
      await w.drop(sx);
      await flush();
      expect(w.table.seats[0].state).toBe('empty');
      expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't2', seatIndex: 4 });
    });

    it('the secondary drops alone: ITS seat is reserved (secondary) — a primary sign-in leaves it for that socket\'s rejoin', async () => {
      const { w, sx } = twoSockets();
      await w.drop(sx);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't2', seatIndex: 4, secondary: true });
      const s2 = w.mkSocket('S2');
      await s2.handlers.resumeSession({ resumeToken: 'tok' });
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't2', seatIndex: 4, secondary: true });
    });

    it('CONTROL — pre-F77: the primary sign-in takes the secondary\'s reservation (the other device\'s table)', async () => {
      expect(P.seatRestore).toContain(SKIP);
      const { w, sx } = twoSockets({ seatRestore: P.seatRestore.replace(SKIP, '') });
      await w.drop(sx);
      const s2 = w.mkSocket('S2');
      await s2.handlers.resumeSession({ resumeToken: 'tok' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't2', seatIndex: 4 });
    });

    it('a secondary socket is marked by its sign-in (skipSeatRecovery) — oauthLogin and resumeSession', async () => {
      const w = world();
      const a = w.mkSocket('SA2');
      await a.handlers.oauthLogin({ accessToken: 'oidc-alice', skipSeatRecovery: true });
      expect(w.authSessions.get('SA2')).toMatchObject({ userId: ALICE, secondary: true });
      const b = w.mkSocket('SB2');
      await b.handlers.resumeSession({ resumeToken: 'tok', skipSeatRecovery: true });
      expect(w.authSessions.get('SB2')).toMatchObject({ userId: ALICE, secondary: true });
      const c = w.mkSocket('SC2');
      await c.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.authSessions.get('SC2').secondary).toBeUndefined();
    });
  });

  // ── G183 ──
  describe('G183 — a sign-in never puts an ELIMINATED tournament player back on his busted seat; he is told his place', () => {
    const DEAD = 'const dead = !!rSeat && isTournamentReservation(reserved) && isDeadTournamentSeat(reserved.tableId, rSeat, true);';
    async function bustedWhileAway(over: Partial<typeof P> = {}) {
      const w = world({ tournament: true, over });
      w.tm!.setTableId(w.tid, 't1');
      const s1 = w.seatLive('S1', ALICE, 0);
      await w.drop(s1);
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, tournament: true });
      // blinded out while away: the bust check eliminates him (seat stays occupied, eliminated, 0 chips)
      w.table.seats[0].chipCount = 0;
      w.table.seats[0].eliminated = true;
      const r = w.tm!.eliminatePlayer(w.tid, 'user_101');
      expect(r).toMatchObject({ position: 3 });
      return w;
    }

    it.each(SIGN_INS_S6)('%s: NOT restored (no session, no reconnectedToTable); the reservation and its timer dropped; after loginResult: playerEliminated with his place', async (_via, signIn) => {
      const w = await bustedWhileAway();
      const s2 = w.mkSocket('S2');
      await signIn(s2);
      await flush();
      expect(w.playerSessions.has('S2')).toBe(false);
      expect(evNames(w, 'S2')).not.toContain('reconnectedToTable');
      expect(w.reservedSeats.has(ALICE)).toBe(false);
      const evs = evNames(w, 'S2');
      expect(evs.indexOf('playerEliminated')).toBeGreaterThan(evs.indexOf('loginResult'));
      expect(payloadOf(w, 'S2', 'playerEliminated')).toEqual({ tournamentId: w.tid, playerId: 'user_101', playerName: 'Alice', position: 3, prize: 300 });   // Sit & Go fix-all F7: + his prize (a paid place)
    });

    it('CONTROL — pre-G183 (occupied + not AI was enough): his socket is bound to the dead 0-chip seat as if it were his live seat', async () => {
      expect(P.seatRestore).toContain(DEAD);
      const w = await bustedWhileAway({ seatRestore: P.seatRestore.replace(DEAD, 'const dead = false;') });
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
      expect(evNames(w, 'S2')).toContain('reconnectedToTable');
      expect(evNames(w, 'S2')).not.toContain('playerEliminated');
    });

    // S6 fix-up — the reservation's TABLE is gone (broken / removed) by the time he signs in.
    describe('his tournament table is GONE (a table break / removal) when he signs in', () => {
      const GONE = slice('    // G183 fix-up (2026-10-21) — a TOURNAMENT reservation whose table or seat', '\n    }\n');
      async function tableGone(busted: boolean, over: Partial<typeof P> = {}) {
        const w = world({ tournament: true, over });
        w.tm!.setTableId(w.tid, 't1');
        const s1 = w.seatLive('S1', ALICE, 0);
        await w.drop(s1);
        expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, tournament: true, playerId: 'user_101' });
        if (busted) expect(w.tm!.eliminatePlayer(w.tid, 'user_101')).toMatchObject({ position: 3 });
        w.tables.delete('t1');
        const s2 = w.mkSocket('S2');
        await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
        await flush();
        return w;
      }

      it('busted meanwhile: the reservation is dropped and he is TOLD his place after loginResult (playerEliminated)', async () => {
        const w = await tableGone(true);
        expect(w.playerSessions.has('S2')).toBe(false);
        expect(w.reservedSeats.has(ALICE)).toBe(false);
        const evs = evNames(w, 'S2');
        expect(evs.indexOf('playerEliminated')).toBeGreaterThan(evs.indexOf('loginResult'));
        expect(payloadOf(w, 'S2', 'playerEliminated')).toEqual({ tournamentId: w.tid, playerId: 'user_101', playerName: 'Alice', position: 3, prize: 300 });   // Sit & Go fix-all F7: + his prize (a paid place)
      });

      it('still ALIVE (not eliminated): told nothing — no false elimination notice', async () => {
        const w = await tableGone(false);
        expect(w.reservedSeats.has(ALICE)).toBe(false);
        expect(evNames(w, 'S2')).not.toContain('playerEliminated');
        expect(evNames(w, 'S2')).not.toContain('tournamentFinishedForEntrant');
      });

      it('CONTROL — the S6 text (`dead` only with the seat still there): the busted player is told NOTHING', async () => {
        expect(P.seatRestore).toContain(GONE);
        const w = await tableGone(true, { seatRestore: P.seatRestore.replace(GONE, '') });
        expect(w.reservedSeats.has(ALICE)).toBe(false);
        expect(evNames(w, 'S2')).toEqual(['loginResult']);
      });
    });

    it('a CASH seat at 0 chips (flagged eliminated until a rebuy) is still restored — he can rebuy', async () => {
      const w = world();
      const s1 = w.seatLive('S1', ALICE, 0);
      w.table.seats[0].chipCount = 0;
      w.table.seats[0].eliminated = true;
      await w.drop(s1);
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    });

    it('a seat flagged eliminated whose bust check is still PENDING (entrant alive) is restored as before — that check tells him', async () => {
      const w = world({ tournament: true });
      w.tm!.setTableId(w.tid, 't1');
      const s1 = w.seatLive('S1', ALICE, 0);
      await w.drop(s1);
      w.table.seats[0].chipCount = 0;
      w.table.seats[0].eliminated = true;                                  // the engine's flag; no bust check yet
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 't1', seatIndex: 0 });
    });
  });

  // ── G184 ──
  describe('G184 — a busted tournament spectator\'s socket drop never reserves his DEAD seat (nor displaces his live cash reservation)', () => {
    const GUARD = '  if (isDeadTournamentSeat(session.tableId, seat)) {';
    async function bustedSpectatorAndCashSeat(over: Partial<typeof P> = {}) {
      const w = world({ tournament: true, over });
      w.tm!.setTableId(w.tid, 't1');
      const phone = w.seatLive('SPH', ALICE, 0);                           // his session stays on the busted seat
      w.table.seats[0].chipCount = 0;
      w.table.seats[0].eliminated = true;
      expect(w.tm!.eliminatePlayer(w.tid, 'user_101')).toMatchObject({ position: 3 });
      const c1 = w.mkTable('c1');                                          // a CASH table (not in tournamentTables)
      expect(c1.sitDown(3, 'Alice', 4000, 'player-c', false, true)).toBe(true);
      const laptop = seatAt(w, 'SLP', ALICE, 'c1', 3);
      w.playerSessions.get('SLP').playerId = 'player-c';
      await w.drop(laptop);                                                // the laptop blips first: cash reservation
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'c1', seatIndex: 3 });
      await w.drop(phone);                                                 // then the phone (busted spectator) drops
      await flush();
      return { w, c1 };
    }

    it('the cash reservation survives (nothing displaced, nothing credited), and the next sign-in restores the CASH seat', async () => {
      const { w, c1 } = await bustedSpectatorAndCashSeat();
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'c1', seatIndex: 3 });
      expect(c1.seats[3]).toMatchObject({ state: 'occupied', chipCount: 4000 });
      expect(w.credits).toEqual([]);
      expect(w.table.seats[0]).toMatchObject({ state: 'occupied', eliminated: true });   // the bust flow owns the dead seat
      const s2 = w.mkSocket('S2');
      await s2.handlers.oauthLogin({ accessToken: 'oidc-alice' });
      expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 'c1', seatIndex: 3 });
    });

    it('CONTROL — pre-G184: the dead seat is reserved, the cash seat cashed out (4,000) and stood up', async () => {
      expect(P.departure).toContain(GUARD);
      const { w, c1 } = await bustedSpectatorAndCashSeat({ departure: P.departure.replace(GUARD, '  if (false) {') });
      expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, tournament: true });
      expect(c1.seats[3].state).toBe('empty');
      expect(w.credits).toEqual([{ uid: ALICE, amount: 4000 }]);
    });
  });
});

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
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
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
  handlePlayerLeave: fnSrc('function handlePlayerLeave(socket: Socket): void {'),
  clearGhost: fnSrc('function clearGhostSeatsForUser('),
  standUpRefusedSeat: fnSrc('function standUpRefusedSeat('),
  refuseSeatRestore: fnSrc('async function refuseSeatRestoreIfBarred('),
  cashOutGuest: fnSrc('async function cashOutSeatsBeforeGuestClaim('),
  seatOwnerSocket: fnSrc('function seatOwnerSocket('),
  handStartGate: fnSrc('function standUpSuspendedSeatsBeforeDeal('),
  canStandUp: fnSrc('function suspendedSeatCanStandUp('),
  standUpSuspendedSeat: fnSrc('function standUpSuspendedSeat('),
  standUpAbsent: fnSrc('function standUpAbsentTournamentSeat('),
  seatHasLiveSession: fnSrc('function seatHasLiveSession('),
  isAbsentPastLimit: fnSrc('function isAbsentTournamentSeatPastHandLimit('),
  armTurnTimer: fnSrc('function armTurnTimer('),
  tick: fnSrc('function tickReservedSeatHands('),
  resume: slice('  let resumeWindowStart = 0;', "\n    })\n  );\n"),
  oauth: slice("socket.on('oauthLogin', trackLogin(socket, 'oauthLogin', async", '\n  }));\n'),
  tokenLogin: slice("socket.on('tokenLogin', trackLogin(socket, 'tokenLogin', async", '\n  }));\n'),
  // The main (last-registered) disconnect handler — the one with the seat reserve.
  disconnect: slice("socket.on('disconnect', async () => {", '\n  });', SRC.lastIndexOf("socket.on('disconnect', async () => {")),
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
${p.handlePlayerLeave}
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
${p.armTurnTimer}
${p.tick}
function wire(socket) {
${p.resume}
  ${p.oauth}
  ${p.tokenLogin}
  ${p.disconnect}
}
module.exports = {
  wire, standUpSuspendedSeatsBeforeDeal, armTurnTimer, tickReservedSeatHands, cashOutSeatsBeforeGuestClaim,
  refuseSeatRestoreIfBarred, clearGhostSeatsForUser, loginsOnDeadSocket, absentSeatMasterIds,
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
    legacyGate: Promise<void> | null; suspended: Set<string>;
  } = { dbGate: null, gateGate: null, loadProgressGate: null, legacyGate: null, suspended: new Set() };
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
    syncSitOutToTable() {}, broadcastGameState() {}, releaseSeatedSlot() {}, cleanupQuickTable() {}, emitGameState() {},
    getGameStateForPlayer: () => ({}), scheduleAIAction() {}, log: { debug() {} },
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
    validateOAuthToken: async (tok: string) => (tok === 'oidc-alice'
      ? { valid: true, sub: 'm-alice', username: 'Alice', isAdmin: false } : { valid: false }),
    reportAuthEvent() {},
    resolveLoginIdentity: () => ({ ok: true, identity: { key: 'alice.player', displayName: 'Alice', source: 'username' } }),
    upsertOidcLocalUser: async () => ({ ok: true, user: { ...users.get(ALICE) } }),
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
    turnStartedHandMap: new Map(), globalTurnId: 0, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3],
    TURN_TIMEOUT_MS, ABSENT_TOURNAMENT_SEAT_TURN_MS,
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
    expect(w.emitted('S3').map(([ev]) => ev)).toEqual(['reconnectedToTable', 'loginResult']);
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
    const off = (s: string) => s.split('loginSocketGone(').join('(() => false)(');
    const over = {
      resume: off(P.resume),
      refuseSeatRestore: P.refuseSeatRestore.replace('if (!socket.connected) return refusal;', ''),
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
    const expectedSets: Record<string, [number, number]> = {
      resumeSession: [1, 1], oauthLogin: [1, 1], tokenLogin: [2, 2], authWithTicket: [1, 0],
    };
    for (const [name, body] of Object.entries(bodies)) {
      const at = (needle: string) => {
        const out: number[] = [];
        for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) out.push(i);
        return out;
      };
      const sets = at('authSessions.set(socket.id');
      const binds = at('playerSessions.set(socket.id');
      expect({ name, sets: sets.length, binds: binds.length }).toEqual({ name, sets: expectedSets[name][0], binds: expectedSets[name][1] });
      for (const pos of [...sets, ...binds]) {
        const before = body.slice(0, pos);
        const lastAwait = before.lastIndexOf('await ');
        const lastCheck = before.lastIndexOf('loginSocketGone(socket,');
        expect({ name, pos, checkedAfterLastAwait: lastCheck > lastAwait }).toEqual({ name, pos, checkedAfterLastAwait: true });
      }
    }
    const gate = fnSrc('async function refuseSeatRestoreIfBarred(');
    const awaitAt = gate.indexOf("const refusal = await assertPlayable(socket, `${via}:seatRestore`, [], { waitForLogin: false });");
    const checkAt = gate.indexOf('if (!socket.connected) return refusal;');
    expect(awaitAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(awaitAt);
    expect(checkAt).toBeLessThan(gate.indexOf('reservedSeats.delete(userId)'));
    expect(checkAt).toBeLessThan(gate.indexOf('handlePlayerLeave(socket)'));
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
    expect(gate).toContain('const tournamentSeatKept = !!reserved && isTournamentReservation(reserved);');
    expect(gate).toContain('if (reserved && !tournamentSeatKept && !(own && ');
    const ghost = fnSrc('function clearGhostSeatsForUser(');
    expect(ghost).toContain('if (isTournamentReservation(reserved)) {');
    expect(fnSrc('function tickReservedSeatHands(')).toContain('if (isTournamentReservation(reserved)) {');
    expect(P.disconnect).toContain('if (isTournamentReservation(reserved)) {');
    expect(slice('// 2. Cash out every reserved seat (disconnected but not yet expired).', '// 3. Flush every pending debounced hand-snapshot'))
      .toContain('!isTournamentReservation(reserved)');
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

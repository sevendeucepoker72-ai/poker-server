/**
 * 2026-10-09 — sign-out and seat teardown.
 *
 * S1 [blocker]: a socket sign-out event must never stand a seated player up
 * or end his session itself. Until S1 the server's `logout` handler deleted
 * the socket's authSessions entry first, so the 'disconnect' that followed
 * found no auth session, skipped its seat-reserve branch and fell through to
 * handlePlayerLeave WITHOUT auth: the at-table stack was stood up and never
 * credited, and mid-hand the seat was stood up at once, erasing its pot
 * contribution.
 *
 * T2: poker-3d's Sign Out now emits a DEDICATED `revokeSignInTokens` (ack);
 * the live HEAD server (5ea0f80) still has the destructive `logout`, and it
 * IGNORES the new event — so whatever the deploy / rollback order, the new
 * client can never trigger that handler. Both events ONLY bump
 * users.token_version (awaited; a claimable guest row is exempt) and ack,
 * share one 5s rate limit per socket, and (T3) wait for a sign-in in flight
 * before answering not_signed_in. The 'disconnect' handler owns the teardown.
 *
 * T1: a reserved TOURNAMENT seat's reservation ending (the hand limit or the
 * SEAT_RESERVE_MS expiry) never credits the tournament stack to the wallet (a
 * mint) and never bare-stands the seat up (the tournament could not finish):
 * the seat is blinded out and the normal bust check eliminates it.
 *
 * These tests run the REAL source text of index.ts's `revokeSignInTokens` /
 * `logout` handlers and their helpers, revokeTokensOnSignOut, the main
 * 'disconnect' handler, tickReservedSeatHands, the tournament bust check of
 * handleHandComplete, handlePlayerLeave and creditSeatStackToWallet
 * (transpiled with the repo's TypeScript; index.ts itself starts a server on
 * import) against the REAL PokerTable, the REAL TournamentManager and the
 * REAL login tracker, with an in-memory users table and recorded wallet
 * credits.
 */

import fs from 'fs';
import path from 'path';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SEAT_TEARDOWN_SRC, SEAT_RESTORE_SRC } from './helpers/indexSource';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
import { Suit, Rank, Card } from '../src/game/Card';
import { isClaimableGuestRow } from '../src/auth/guestClaim';
import { createLoginTracker, DEFAULT_LOGIN_WAIT_MS } from '../src/auth/playGate';
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

const LOGOUT_HANDLER = slice("socket.on('logout', async (...args: unknown[]) => {", '\n  });');
const REVOKE_HANDLER = slice("socket.on('revokeSignInTokens', async (...args: unknown[]) => {", '\n  });');
const REVOKE_FN = slice('async function revokeTokensOnSignOut(', '\n}\n');
const SIGN_OUT_STATE = slice('const SIGN_IN_REVOCATION_MIN_INTERVAL_MS', 'notSignedIn: 0 };');
const REVOKE_FOR_SOCKET = slice('async function revokeSignInTokensForSocket(', '\n}\n');
const ANSWER_REVOCATION = slice('async function answerSignInTokenRevocation(', '\n}\n');
const IS_TOURNAMENT_RESERVATION = slice('function isTournamentReservation(', '\n}\n');
// F2 (2026-10-10): the broken-tournament-table registry + isTournamentTable (used by the above, the leave and the credit helper).
const BROKEN_TABLES = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const NOTE_NOT_CASHED = slice('function noteTournamentReservationNotCashed(', '\n}\n');
const TICK_RESERVED = slice('function tickReservedSeatHands(tableId: string): void {', '\n}\n');
const HANDLE_PLAYER_LEAVE = slice('function handlePlayerLeave(socket: Socket, tournamentSeat: TournamentSeatLeaveKind', '\n}\n');
const CREDIT_SEAT = slice('function creditSeatStackToWallet(', '\n}\n');
// The main (last-registered) disconnect handler — the one with the seat reserve.
// P4 (2026-10-10): its seat reservation + extra-table cash-out are two functions
// (shared with the account switch, releaseSocketForAccountSwitch); the handler
// text is prefixed with them so it runs — and is mutated — as before.
const DISCONNECT_HANDLER = slice('function otherSessionHoldsSeat(', '\n}\n') // round-7 review: the disconnect re-validates the seat with it
    + slice('function reserveSeatForDeparture(', '\n}\n')
    + slice('function cashOutAdditionalSeatsOnDeparture(', '\n}\n')
  + slice("socket.on('disconnect', async () => {", '\n  });', SRC.lastIndexOf("socket.on('disconnect', async () => {"));
// handleHandComplete's tournament bust check (runs after tickReservedSeatHands). S1 (2026-10-10):
// extracted — captured when the hand ends (captureTournamentBustCheck) and run after the awaits
// (runTournamentBustCheck); the helpers it reads come along. Q1: the id resolves through the
// broken-table registry too (a bust on a just-broken table).
const fnSrc = (signature: string): string => slice(signature, '\n}\n');
const BUST_CHECK = [
  slice('const tournamentBustChecksPending = new Map', ';\n'),
  // OPS-3 (2026-10-11): runTournamentBustCheck ASSIGNS this module-level `let`
  // (round 6, one elimination notice). Without its declaration the transpiled
  // slice assigns an undeclared name — a ReferenceError in the strict-mode
  // CommonJS that the lockfile's TypeScript 6 emits ("use strict"), so CI failed
  // here on every push since 2026-10-10 while a stale local TS 5.x passed.
  slice('let eliminationDirectNotice', ';\n'),
  // 2026-10-24 (hand-for-hand at the seat bubble): the bust check asks for its
  // round (handForHandRoundOf → handForHandStates), ASSIGNS the quiet-bust `let`,
  // and tells a bust through the extracted tellTournamentBustNow.
  slice('const handForHandStates = new Map', ';\n'),
  // Review fix-up: handForHandRoundOf also reads an open DRAIN (a released round still waiting for a round hand).
  slice('const handForHandDrains = new Map', ';\n'),
  slice('let handForHandQuietBust', ';\n'),
  fnSrc('function handForHandRoundOf('),
  fnSrc('function captureTournamentBustCheck('),
  fnSrc('function runTournamentBustCheck('),
  fnSrc('function tellTournamentBustNow('),
  fnSrc('function tournamentEntrantHasLiveSeat('),
  fnSrc('function tournamentLiveSeatIndex('),
  fnSrc('function tournamentLiveSeatOf('),
  fnSrc('function tournamentEntrantSocket('),
  fnSrc('function tournamentEntrantIsAccount('),
  fnSrc('function qualifierEntrantMasterId('),
].join('\n');
// S2 (2026-10-10): handlePlayerLeave keeps a LIVE tournament seat in play (absent) instead of standing it up.
const SEAT_KEEP = slice('// ===== Tournament seat kept on leave', '// ===== end tournament seat kept on leave =====\n');
/** The live HEAD (5ea0f80) `logout` handler, verbatim (`git show HEAD:src/index.ts`, lines 6391-6393). */
const HEAD_LOGOUT_HANDLER = "socket.on('logout', async () => {\n    authSessions.delete(socket.id);\n  });";

interface Parts { logout?: string | null; revoke?: string | null; tick?: string; disconnect?: string; credit?: string }

function compile(parts: Parts): string {
  const code = `
${SIGN_OUT_STATE}
${REVOKE_FN}
${REVOKE_FOR_SOCKET}
${ANSWER_REVOCATION}
${BROKEN_TABLES}
${IS_TOURNAMENT_RESERVATION}
${NOTE_NOT_CASHED}
${parts.tick ?? TICK_RESERVED}
${parts.credit ?? CREDIT_SEAT}
${SEAT_TEARDOWN_SRC}
${SEAT_KEEP}
// 2026-10-21 (gameplay S6): the disconnect handler and reserveSeatForDeparture call into the restore block.
${SEAT_RESTORE_SRC}
${HANDLE_PLAYER_LEAVE}
${BUST_CHECK}
function bustCheck(tableId, table, results) {
  runTournamentBustCheck(tableId, table, captureTournamentBustCheck(tableId, table, results), 'test');
}
function wire(socket) {
  ${parts.logout === undefined ? LOGOUT_HANDLER : (parts.logout ?? '')}
  ${parts.revoke === undefined ? REVOKE_HANDLER : (parts.revoke ?? '')}
  ${parts.disconnect ?? DISCONNECT_HANDLER}
}
module.exports = { wire, tickReservedSeatHands, bustCheck, signOutStats };
`;
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

const ALICE = 101;
const BOB = 102;
const SEAT_RESERVE_MS = 10 * 60 * 1000;
const HANDS_LIMIT = 3;

interface UserRow { id: number; username: string; stats: string; banned: boolean; created_at: string; token_version: number }

interface HarnessOpts extends Parts {
  aliceRow?: Partial<UserRow> | null;
  dbDown?: boolean;
  /** Seats: [seatIndex, name, stack, playerId]. Default: Alice 7000, Bob 5000, Carl 5000 (cash). */
  seats?: Array<[number, string, number, string]>;
  /** TOURNAMENT table: t1 belongs to this tournament (TournamentManager given too). */
  tournament?: { tm: TournamentManager; id: string };
  loginWaitMs?: number;
}

function harness(opts: HarnessOpts = {}) {
  const credits: Array<{ uid: number; amount: number }> = [];
  const audits: Array<[string, string, Record<string, unknown>]> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clock = { now: 1_800_000_000_000 };
  const users = new Map<number, UserRow>();
  if (opts.aliceRow !== null) {
    users.set(ALICE, {
      id: ALICE, username: 'alice.player', stats: JSON.stringify({ masterUserId: 'm-alice' }), banned: false,
      created_at: '2026-05-01T00:00:00Z', token_version: 3, ...opts.aliceRow,
    });
  }
  const table = new PokerTable({
    tableId: 't1', tableName: 'T', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9,
  } as any);
  const seats: Array<[number, string, number, string]> = opts.seats
    ?? [[0, 'Alice', 7000, 'user_101'], [1, 'Bob', 5000, 'user_102'], [2, 'Carl', 5000, 'user_103']];
  // allowBelowMin: a tournament stack may be under the table's cash minBuyIn.
  for (const [i, name, stack, pid] of seats) expect(table.sitDown(i, name, stack, pid, false, true)).toBe(true);
  const tables = new Map<string, PokerTable>([['t1', table]]);
  const tournamentTables = new Map<string, string>(opts.tournament ? [['t1', opts.tournament.id]] : []);

  const authSessions = new Map<string, any>([['sockA', { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice' }]]);
  const playerSessions = new Map<string, any>([['sockA', {
    socketId: 'sockA', tableId: 't1', seatIndex: 0, playerName: 'Alice', playerId: 'user_101', sittingOut: false,
  }]]);
  const reservedSeats = new Map<number, any>();
  const handlers: Record<string, (...a: any[]) => any> = {};
  const socket = { id: 'sockA', on: (ev: string, fn: any) => { handlers[ev] = fn; }, leave() {}, emit() {}, join() {} };
  const saves: unknown[] = [];
  const loginTracker = createLoginTracker();

  const g: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id) },
    authSessions, playerSessions, reservedSeats, tournamentTables,
    tournamentManager: opts.tournament?.tm ?? null,
    // S1/S2 (2026-10-10): the extracted bust check's + the seat-keep region's module state.
    qualifierTournaments: new Map(),
    tournamentHandStartSafety: { bustLeftoversEliminated: 0, entrantSocketsDetached: 0 },
    emitGameState() {}, getGameStateForPlayer: () => ({}),
    io: { to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
    pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), multiTableSessions: new Map(),
    spectators: new Map(), aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(),
    quickTables: new Set(), lastEmoteTime: new Map(), lastReactionTime: new Map(), lastChatTime: new Map(),
    lastSentState: new Map(), lastSentJson: new Map(), MAX_SEATS: 9, SEAT_RESERVE_MS, DISCONNECT_HANDS_LIMIT: HANDS_LIMIT,
    syncSitOutToTable() {}, broadcastGameState() {}, releaseSeatedSlot() {}, cleanupQuickTable() {},
    // R2 (2026-10-11): the seat-teardown helper block (SEAT_TEARDOWN_SRC) reads these.
    scheduleAIAction() {}, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], GamePhase, FiveCardDrawTable: class {},
    seatPlayedByAnotherAccount: () => false,
    // R2 (S1): the Spin & Go (prize format) helpers the leave / reservation paths ask.
    isPrizeFormatTable: () => false, leavePrizeFormatSeat: () => false, quickGameEndCheck: () => false,
    settleDecidedQuickGame: () => false,   // R3 (S1-4) — no quick game decided here
    shutdownFlushActive: () => false,   // R2 (item 1) — the shutdown flush is not running
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    auditLog: (actor: string, action: string, details: Record<string, unknown>) => { audits.push([actor, action, details]); },
    saveProgress: async (...a: unknown[]) => { saves.push(a); return true; },
    progressionManager: { getClientProgress: () => ({ hydrated: true, xp: 10, level: 2, achievements: [] }) },
    getPool: () => ({
      query: async (_sql: string, params: unknown[]) => {
        if (opts.dbDown) throw new Error('db down');
        const r = users.get(Number(params[0]));
        return { rows: r ? [{ ...r }] : [] };
      },
    }),
    bumpTokenVersion: async (uid: number) => {
      if (opts.dbDown) throw new Error('db down');
      const r = users.get(uid);
      if (r) r.token_version += 1;
    },
    isClaimableGuestRow,
    loginTracker,
    DEFAULT_LOGIN_WAIT_MS: opts.loginWaitMs ?? DEFAULT_LOGIN_WAIT_MS,
    Date: { now: () => clock.now },
    resumeStats: { logoutRevocations: 0, kickRevocations: 0 },
    Sentry: null,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t: any) => { if (t) t.cleared = true; },
  };
  const mod: { exports: any } = { exports: {} };
  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(g), 'module', 'exports', 'require', compile(opts));
  run(...Object.values(g), mod, mod.exports, require);
  mod.exports.wire(socket);

  /** Fire the seat-reservation expiry (the cash-out). */
  const expireReservation = () => {
    for (const t of timers) if (!t.cleared && t.ms === SEAT_RESERVE_MS) { t.cleared = true; t.fn(); }
  };
  /** Emit like a socket.io client WITH an ack. An event the server has no handler for is ignored (no ack) — like socket.io. */
  const emitWithAck = async (event: string, ...payload: unknown[]): Promise<unknown[] | 'ignored'> => {
    if (!handlers[event]) return 'ignored';
    const acks: unknown[] = [];
    await handlers[event](...payload, (r: unknown) => acks.push(r));
    return acks;
  };
  const emit = (event: string, ...payload: unknown[]) => (handlers[event] ? handlers[event](...payload) : undefined);
  const tableChips = () =>
    table.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount : 0), 0) + table.getTotalPot();
  const notCashed = () => audits.filter(([, action]) => action === 'TOURNAMENT_STACK_NOT_CASHED').map(([, , d]) => d);
  return {
    table, tables, tournamentTables, users, credits, audits, saves, authSessions, playerSessions, reservedSeats, timers,
    clock, loginTracker, handlers, signOutStats: mod.exports.signOutStats as Record<string, number>,
    emitWithAck, emit, disconnect: () => handlers.disconnect(), expireReservation, tableChips, notCashed,
    tickReservedSeatHands: (id: string) => mod.exports.tickReservedSeatHands(id),
    bustCheck: (results: unknown[]) => mod.exports.bustCheck('t1', table, results),
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const SIGN_OUT_EVENTS = ['revokeSignInTokens', 'logout'] as const;

/** Act for whoever is to act until seat 0 has chips in the pot (blind or call). */
function untilSeat0Invested(t: PokerTable): void {
  for (let guard = 0; guard < 12 && !((t.seats[0].totalInvestedThisHand || 0) > 0); guard++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!t.playerCall(a)) t.playerCheck(a);
  }
}

/** Finish the hand: seat 0 (gone) is folded on its turn, the others check/call. */
function playOut(t: PokerTable): void {
  for (let guard = 0; guard < 60 && t.isHandInProgress(); guard++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (a === 0) { t.playerFold(0); continue; }
    if (!t.playerCheck(a)) t.playerCall(a);
  }
}

describe('S1 + T2 — a sign-out event only revokes + acks; the disconnect handler owns the seat teardown', () => {
  it.each(SIGN_OUT_EVENTS)('between hands (%s): then disconnect → the 7,000 cash stack is credited EXACTLY ONCE (at the reservation cash-out), token_version bumped', async (event) => {
    const h = harness();
    expect(await h.emitWithAck(event)).toEqual([{ success: true, revoked: true }]);
    expect(h.users.get(ALICE)!.token_version).toBe(4);           // bumped (awaited before the ack)
    // The sign-out touched nothing else: still signed in, still seated, nothing credited.
    expect(h.authSessions.has('sockA')).toBe(true);
    expect(h.playerSessions.has('sockA')).toBe(true);
    expect(h.table.seats[0].state).toBe('occupied');
    expect(h.table.seats[0].chipCount).toBe(7000);
    expect(h.credits).toEqual([]);

    await h.disconnect();
    // The normal disconnect path: seat reserved, progress flushed, session ended.
    expect(h.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, chips: 7000, tournament: false });
    expect(h.saves).toHaveLength(1);
    expect(h.authSessions.has('sockA')).toBe(false);
    expect(h.table.seats[0].state).toBe('occupied');
    expect(h.credits).toEqual([]);

    h.expireReservation();
    await flush();
    expect(h.credits).toEqual([{ uid: ALICE, amount: 7000 }]);   // exactly once, the whole stack
    expect(h.table.seats[0].state).toBe('empty');
    h.expireReservation();                                         // nothing left to fire
    await flush();
    expect(h.credits).toHaveLength(1);
  });

  it.each(SIGN_OUT_EVENTS)('mid-hand (%s): his pot contribution stays in the pot; after the hand his stack is credited once; no chip is lost or minted', async (event) => {
    const h = harness();
    expect(h.table.startNewHand()).toBe(true);
    untilSeat0Invested(h.table);
    const invested = h.table.seats[0].totalInvestedThisHand || 0;
    expect(invested).toBeGreaterThan(0);
    expect(h.table.isHandInProgress()).toBe(true);
    const total = h.tableChips();
    expect(total).toBe(17000);
    const potBefore = h.table.getTotalPot();

    expect(await h.emitWithAck(event)).toEqual([{ success: true, revoked: true }]);
    expect(h.table.seats[0].state).toBe('occupied');
    expect(h.table.getTotalPot()).toBe(potBefore);

    await h.disconnect();
    expect(h.reservedSeats.has(ALICE)).toBe(true);
    expect(h.table.seats[0].state).toBe('occupied');              // NOT stood up mid-hand
    expect(h.table.getTotalPot()).toBe(potBefore);                // contribution preserved
    expect(h.table.seats[0].totalInvestedThisHand).toBe(invested);
    expect(h.tableChips()).toBe(total);

    playOut(h.table);
    expect(h.table.isHandInProgress()).toBe(false);
    expect(h.tableChips()).toBe(total);                           // the pot went to the winner, nothing vanished
    const aliceStack = h.table.seats[0].chipCount;

    h.expireReservation();
    await flush();
    expect(h.credits).toEqual([{ uid: ALICE, amount: aliceStack }]);
    expect(h.table.seats[0].state).toBe('empty');
    expect(h.tableChips() + aliceStack).toBe(total);              // conservation: table + wallet credit
  });

  it('CONTROL — the live HEAD `logout` handler (session deleted, no ack) loses the stack: the test catches the regression', async () => {
    expect(SRC).not.toContain(HEAD_LOGOUT_HANDLER);               // gone from this tree
    const h = harness({ logout: HEAD_LOGOUT_HANDLER, revoke: null });
    expect(await h.emitWithAck('logout')).toEqual([]);            // never acks
    await h.disconnect();
    h.expireReservation();
    await flush();
    expect(h.reservedSeats.has(ALICE)).toBe(false);
    expect(h.table.seats[0].state).toBe('empty');
    expect(h.credits).toEqual([]);                                // 7,000 chips gone

    // Mid-hand under the HEAD handler: no account left to credit — nothing is
    // ever paid to her. (R2, 2026-10-11: the leave is the ONE seat teardown now,
    // so even this account-less leave keeps her chips in the live pot until the
    // hand's end — it used to stand the seat up at once, destroying them — but
    // the stack still never reaches her wallet: the regression this catches.)
    const m = harness({ logout: HEAD_LOGOUT_HANDLER, revoke: null });
    m.table.startNewHand();
    untilSeat0Invested(m.table);
    expect(m.table.isHandInProgress()).toBe(true);
    await m.emitWithAck('logout');
    await m.disconnect();
    expect(m.table.seats[0].state).toBe('occupied');              // R2: the stand-up waits for the hand's end
    expect(m.reservedSeats.has(ALICE)).toBe(false);
    playOut(m.table);
    m.expireReservation();
    await flush();
    expect(m.credits).toEqual([]);                                // never credited
  });

  it('T2 ROLLBACK SAFETY — the new client against the live HEAD server: `revokeSignInTokens` is ignored (no ack), the disconnect reserves the seat and credits it exactly once; mid-hand nothing is lost', async () => {
    // HEAD has ONLY the destructive `logout`, and no `revokeSignInTokens` handler.
    const h = harness({ logout: HEAD_LOGOUT_HANDLER, revoke: null });
    expect(await h.emitWithAck('revokeSignInTokens')).toBe('ignored'); // the client waits ≤2s, then disconnects
    expect(h.authSessions.has('sockA')).toBe(true);
    expect(h.users.get(ALICE)!.token_version).toBe(3);            // nothing revoked on an old server …
    await h.disconnect();
    expect(h.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, chips: 7000 });
    h.expireReservation();
    await flush();
    expect(h.credits).toEqual([{ uid: ALICE, amount: 7000 }]);   // … and no chip lost

    const m = harness({ logout: HEAD_LOGOUT_HANDLER, revoke: null });
    m.table.startNewHand();
    untilSeat0Invested(m.table);
    const total = m.tableChips();
    expect(await m.emitWithAck('revokeSignInTokens')).toBe('ignored');
    await m.disconnect();
    expect(m.table.seats[0].state).toBe('occupied');              // reserved, not stood up mid-hand
    playOut(m.table);
    const stack = m.table.seats[0].chipCount;
    m.expireReservation();
    await flush();
    expect(m.credits).toEqual([{ uid: ALICE, amount: stack }]);
    expect(m.tableChips() + stack).toBe(total);                   // conservation
  });

  it.each(SIGN_OUT_EVENTS)('a claimable pre-shutoff GUEST row is not bumped (its token is the carry-over proof) — %s acks success, revoked:false', async (event) => {
    const h = harness({ aliceRow: { username: 'Guest1971', stats: '{"handsPlayed":812}', created_at: '2026-08-21T01:48:18.979Z' } });
    expect(await h.emitWithAck(event)).toEqual([{ success: true, revoked: false }]);
    expect(h.users.get(ALICE)!.token_version).toBe(3);
    expect(h.authSessions.has('sockA')).toBe(true);
  });

  it.each(SIGN_OUT_EVENTS)('%s acks {success:false} when it could not revoke (DB down, or the row is gone), or the socket is not signed in — and still ends nothing', async (event) => {
    const down = harness({ dbDown: true });
    expect(await down.emitWithAck(event)).toEqual([{ success: false, code: 'revoke_failed' }]);
    expect(down.authSessions.has('sockA')).toBe(true);
    expect(down.table.seats[0].state).toBe('occupied');

    const noRow = harness({ aliceRow: null });
    expect(await noRow.emitWithAck(event)).toEqual([{ success: false, code: 'revoke_failed' }]);
    expect(noRow.authSessions.has('sockA')).toBe(true);

    const anon = harness();
    anon.authSessions.delete('sockA');
    expect(await anon.emitWithAck(event)).toEqual([{ success: false, code: 'not_signed_in' }]);
  });

  it.each(SIGN_OUT_EVENTS)('%s: the ack is found after a payload too (emit(ev, {...}, ack)); no ack = still revokes, nothing thrown', async (event) => {
    const h = harness();
    expect(await h.emitWithAck(event, { reason: 'sign_out' })).toEqual([{ success: true, revoked: true }]);
    expect(h.users.get(ALICE)!.token_version).toBe(4);
    h.clock.now += 5_000;                                          // past the per-socket rate limit
    await expect(h.emit(event)).resolves.toBeUndefined();
    expect(h.users.get(ALICE)!.token_version).toBe(5);
    expect(h.table.seats[0].state).toBe('occupied');
  });

  it('T2 rate limit: ONE revocation per socket per 5s across BOTH events — the extra ones answer rate_limited and touch the DB not at all', async () => {
    const h = harness();
    expect(await h.emitWithAck('revokeSignInTokens')).toEqual([{ success: true, revoked: true }]);
    expect(h.users.get(ALICE)!.token_version).toBe(4);
    h.clock.now += 4_999;
    expect(await h.emitWithAck('revokeSignInTokens')).toEqual([{ success: false, code: 'rate_limited' }]);
    expect(await h.emitWithAck('logout')).toEqual([{ success: false, code: 'rate_limited' }]);
    expect(h.users.get(ALICE)!.token_version).toBe(4);            // no second bump
    expect(h.signOutStats).toMatchObject({ requests: 3, rateLimited: 2, legacyLogoutEvents: 1 });
    h.clock.now += 1;                                              // 5s after the first
    expect(await h.emitWithAck('logout')).toEqual([{ success: true, revoked: true }]);
    expect(h.users.get(ALICE)!.token_version).toBe(5);
    expect(h.authSessions.has('sockA')).toBe(true);               // never touched
  });

  it('T3: a sign-in still in flight on the socket is WAITED for (bounded), then revoked — not answered not_signed_in', async () => {
    const h = harness();
    h.authSessions.delete('sockA');                                // reconnected socket, resumeSession running
    const release = h.loginTracker.begin('sockA');
    const answer = h.emitWithAck('revokeSignInTokens');
    await flush();
    // The resume completes: the session is set, then the login releases its mark.
    h.authSessions.set('sockA', { userId: ALICE, username: 'alice.player', masterUserId: 'm-alice' });
    release();
    expect(await answer).toEqual([{ success: true, revoked: true }]);
    expect(h.users.get(ALICE)!.token_version).toBe(4);
    expect(h.signOutStats.waitedForLogin).toBe(1);
  });

  it('T3: the wait is bounded — a sign-in that never finishes is answered not_signed_in after the bound; nothing in flight → at once', async () => {
    const h = harness({ loginWaitMs: 30 });
    h.authSessions.delete('sockA');
    h.loginTracker.begin('sockA');                                 // never released
    const t0 = Date.now();
    expect(await h.emitWithAck('revokeSignInTokens')).toEqual([{ success: false, code: 'not_signed_in' }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(h.users.get(ALICE)!.token_version).toBe(3);

    const idle = harness();
    idle.authSessions.delete('sockA');
    expect(await idle.emitWithAck('logout')).toEqual([{ success: false, code: 'not_signed_in' }]);
    expect(idle.signOutStats.waitedForLogin).toBe(0);
    // index.ts bounds the wait with the play gate's constant.
    expect(REVOKE_FOR_SOCKET).toContain('loginTracker.waitFor(socket.id, DEFAULT_LOGIN_WAIT_MS)');
  });
});

// ── T1 ────────────────────────────────────────────────────────────────────

const card = (rank: Rank, suit: Suit): Card => ({ rank, suit });

/**
 * When the absent seat is all-in from a blind, the hand runs out to a
 * showdown: rig it (hole cards + the rest of the deck) so he loses — the
 * board gives the opponent four aces. Deterministic; no shuffle involved.
 */
function rigShowdownLoss(t: PokerTable, loserSeat: number, winnerSeat: number): void {
  const loser = [card(Rank.Two, Suit.Hearts), card(Rank.Seven, Suit.Diamonds)];
  const winner = [card(Rank.Ace, Suit.Hearts), card(Rank.Ace, Suit.Spades)];
  const board = [
    card(Rank.Three, Suit.Clubs), card(Rank.Ace, Suit.Clubs), card(Rank.Ace, Suit.Diamonds), card(Rank.King, Suit.Hearts),
    card(Rank.Four, Suit.Clubs), card(Rank.King, Suit.Spades),
    card(Rank.Five, Suit.Clubs), card(Rank.Nine, Suit.Clubs),
  ]; // burn, flop x3, burn, turn, burn, river
  t.seats[loserSeat].holeCards = loser;
  t.seats[winnerSeat].holeCards = winner;
  const used = new Set([...loser, ...winner, ...board].map((c) => `${c.rank}:${c.suit}`));
  const rest: Card[] = [];
  for (let s = Suit.Hearts; s <= Suit.Spades; s++) {
    for (let r = Rank.Two; r <= Rank.Ace; r++) if (!used.has(`${r}:${s}`)) rest.push(card(r, s));
  }
  const deck = (t as any).deck;
  const dealt: Card[] = deck.cards.slice(0, deck.currentIndex);
  deck.cards = [...dealt, ...board, ...rest];
}

/**
 * One hand with seat 0 ABSENT (reserved): the turn timer acts for him —
 * fold when facing a bet, check otherwise (index.ts armTurnTimer). The
 * present player raises whenever the absent one could still fold, else calls
 * or checks. Then handleHandComplete's order: tickReservedSeatHands, bust check.
 * Returns false when no hand could start.
 */
function playTournamentHand(h: ReturnType<typeof harness>): boolean {
  const t = h.table;
  if (!t.startNewHand()) return false;
  if (t.seats[0].allIn) rigShowdownLoss(t, 0, 1);
  for (let guard = 0; guard < 40 && t.isHandInProgress(); guard++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    const seat = t.seats[a];
    const callAmt = t.currentBetToMatch - (seat.currentBet || 0);
    if (a === 0) {
      if (callAmt > 0) t.playerFold(0); else t.playerCheck(0);
      continue;
    }
    if (!t.seats[0].allIn && !t.seats[0].folded && t.playerRaise(a, t.getMinRaise())) continue;
    if (!(callAmt > 0 ? t.playerCall(a) : t.playerCheck(a))) t.playerFold(a);
  }
  expect(t.isHandInProgress()).toBe(false);
  h.tickReservedSeatHands('t1');
  h.bustCheck([]);
  return true;
}

describe('T1 — a reserved TOURNAMENT seat is never cashed out to the wallet and never bare-stood-up', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function tournamentHarness(parts: Parts = {}) {
    const tm = new TournamentManager();
    const id = tm.createTournament({
      name: 'T1-CUP', buyIn: 0, prizePool: 1000, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS,
    } as any);
    tm.registerPlayer(id, 'user_101', 'Alice', 'sockA', ALICE);
    tm.registerPlayer(id, 'user_102', 'Bob', 'sockB', BOB);
    let results: any[] | null = null;
    tm.onEvent(id, (event, data) => { if (event === 'tournamentFinished') results = data.results; });
    expect(tm.startTournament(id)).toBeTruthy();
    const h = harness({
      ...parts,
      seats: [[0, 'Alice', 300, 'user_101'], [1, 'Bob', 5000, 'user_102']],
      tournament: { tm, id },
    });
    return { h, tm, id, getResults: () => results };
  }

  it('sign-out + disconnect at a tournament table: the hand limit and the expiry credit NOTHING, the seat stays in play, and the tournament still FINISHES (he is blinded out and eliminated)', async () => {
    const { h, tm, id, getResults } = tournamentHarness();
    expect(await h.emitWithAck('revokeSignInTokens')).toEqual([{ success: true, revoked: true }]);
    await h.disconnect();
    expect(h.reservedSeats.get(ALICE)).toMatchObject({ tableId: 't1', seatIndex: 0, chips: 300, tournament: true });

    // Hands 1..HANDS_LIMIT: the hand limit is reached — audited once, NOT cashed, NOT stood up.
    for (let i = 0; i < HANDS_LIMIT; i++) expect(playTournamentHand(h)).toBe(true);
    expect(h.credits).toEqual([]);
    expect(h.table.seats[0].state).toBe('occupied');
    expect(h.reservedSeats.has(ALICE)).toBe(true);                 // still restorable on reconnect
    expect(h.notCashed()).toEqual([
      expect.objectContaining({ userId: ALICE, tableId: 't1', reason: 'reserve_hand_limit', chips: h.table.seats[0].chipCount, seatKept: true }),
    ]);
    expect(playTournamentHand(h)).toBe(true);                      // past the limit: nothing more happens
    expect(h.notCashed()).toHaveLength(1);

    // The reservation expires: audited, the reservation ends, the seat stays.
    const stackAtExpiry = h.table.seats[0].chipCount;
    expect(stackAtExpiry).toBeGreaterThan(0);
    h.expireReservation();
    await flush();
    expect(h.credits).toEqual([]);
    expect(h.reservedSeats.has(ALICE)).toBe(false);
    expect(h.table.seats[0].state).toBe('occupied');
    expect(h.table.seats[0].chipCount).toBe(stackAtExpiry);
    expect(h.notCashed()[1]).toEqual(expect.objectContaining({ userId: ALICE, reason: 'reserve_expiry', chips: stackAtExpiry, seatKept: true }));
    expect(tm.getTournament(id)!.players.find((p) => p.playerId === 'user_101')!.eliminated).toBe(false);

    // He is blinded out; the bust check eliminates him; the tournament finishes.
    for (let i = 0; i < 40 && tm.getTournament(id)!.status === 'running'; i++) expect(playTournamentHand(h)).toBe(true);
    expect(tm.getTournament(id)!.status).toBe('finished');
    const results = getResults()!;
    expect(results.find((r) => r.playerId === 'user_102')).toMatchObject({ position: 1 });
    expect(results.find((r) => r.playerId === 'user_101')).toMatchObject({ position: 2 });
    expect(h.credits).toEqual([]);                                 // never a wallet credit for tournament chips
    expect(h.tableChips()).toBe(5300);                             // tournament chips conserved on the table
  });

  it('a table break before the expiry (tournamentTables entry + table gone) still credits nothing — the reservation carries a tournament snapshot', async () => {
    const { h } = tournamentHarness();
    await h.disconnect();
    expect(h.reservedSeats.get(ALICE)!.tournament).toBe(true);
    h.tournamentTables.delete('t1');                               // rebalance: tournamentTables.delete(breakTableId)
    h.tables.delete('t1');                                         // … and the table is removed 5s later
    h.expireReservation();
    await flush();
    expect(h.credits).toEqual([]);                                 // HEAD minted reserved.chips (300) here
    expect(h.reservedSeats.has(ALICE)).toBe(false);
    expect(h.notCashed()).toEqual([expect.objectContaining({ reason: 'reserve_expiry', chips: 300 })]);
  });

  it('CONTROL — without the T1 guard (HEAD behaviour) the hand limit MINTS the tournament stack into the wallet and stands the seat up, and the tournament can never finish', async () => {
    const tick = TICK_RESERVED.replace('if (isTournamentReservation(reserved)) {', 'if (false) {');
    const disconnect = DISCONNECT_HANDLER.replace('if (isTournamentReservation(reserved)) {', 'if (false) {');
    // R2 (2026-10-11): a reservation's cash-out now goes through teardownSeat →
    // creditSeatStackToWallet, whose OWN tournament-table guard is a second lock;
    // HEAD credited with a bare addChipsToUser, so the control removes both.
    const credit = CREDIT_SEAT.replace('if (isTournamentTable(tableId)) {', 'if (false) {');
    expect(tick).not.toBe(TICK_RESERVED);
    expect(disconnect).not.toBe(DISCONNECT_HANDLER);
    expect(credit).not.toBe(CREDIT_SEAT);
    const { h, tm, id } = tournamentHarness({ tick, disconnect, credit });
    await h.disconnect();
    let started = 0;
    for (let i = 0; i < HANDS_LIMIT; i++) if (playTournamentHand(h)) started++;
    expect(started).toBe(HANDS_LIMIT);
    expect(h.credits).toEqual([{ uid: ALICE, amount: expect.any(Number) }]); // tournament chips paid into the wallet
    expect(h.credits[0].amount).toBeGreaterThan(0);
    expect(h.table.seats[0].state).toBe('empty');                 // bare stand-up
    expect(playTournamentHand(h)).toBe(false);                     // no hand can start …
    expect(tm.getTournament(id)!.status).toBe('running');          // … and the tournament never finishes
    expect(tm.getTournament(id)!.players.find((p) => p.playerId === 'user_101')!.eliminated).toBe(false);

    // The expiry under HEAD with the table gone mints the reservation snapshot.
    const b = tournamentHarness({ tick, disconnect, credit }).h;
    await b.disconnect();
    b.tournamentTables.delete('t1');
    b.tables.delete('t1');
    b.expireReservation();
    expect(b.credits).toEqual([{ uid: ALICE, amount: 300 }]);
  });

  it('a CASH table is unchanged: at the hand limit the stack is credited exactly once and the seat stood up', async () => {
    const h = harness();
    await h.disconnect();
    expect(h.reservedSeats.get(ALICE)!.tournament).toBe(false);
    for (let i = 0; i < HANDS_LIMIT; i++) {
      expect(h.table.startNewHand()).toBe(true);
      playOut(h.table);
      if (i < HANDS_LIMIT - 1) { h.tickReservedSeatHands('t1'); expect(h.credits).toEqual([]); }
    }
    const stack = h.table.seats[0].chipCount;
    h.tickReservedSeatHands('t1');
    expect(h.credits).toEqual([{ uid: ALICE, amount: stack }]);
    expect(h.table.seats[0].state).toBe('empty');
    expect(h.reservedSeats.has(ALICE)).toBe(false);
    expect(h.notCashed()).toEqual([]);
    h.expireReservation();                                          // its timer was cleared
    expect(h.credits).toHaveLength(1);
  });

  it('wiring: handleHandComplete runs tickReservedSeatHands before the bust check; the reservation snapshots the tournament flag; the SIGTERM reserved-seat flush uses the same guard', () => {
    const hhc = slice('async function handleHandComplete(', '\n}\n');
    const tickAt = hhc.indexOf('tickReservedSeatHands(tableId);');
    expect(tickAt).toBeGreaterThan(0);
    // S1 (2026-10-10): captured after the tick (before any await), run at the end.
    const captureAt = hhc.indexOf('const tournamentBustCheck = captureTournamentBustCheck(tableId, table, results);');
    expect(captureAt).toBeGreaterThan(tickAt);
    expect(captureAt).toBeLessThan(hhc.indexOf('await mergeUserStats('));   // the first await
    expect(hhc.indexOf("runTournamentBustCheck(tableId, table, tournamentBustCheck, 'hand_complete');")).toBeGreaterThan(captureAt);
    expect(fnSrc('function runTournamentBustCheck(')).toContain('const tournamentId = tournamentTables.get(tableId) ?? brokenTournamentTables.get(tableId)?.tournamentId;');
    // F2 (2026-10-10): the snapshot uses isTournamentTable — a table a rebalance just broke still counts.
    expect(DISCONNECT_HANDLER).toContain('tournament: isTournamentTable(session.tableId),');
    expect(DISCONNECT_HANDLER).not.toContain('tournament: tournamentTables.has(session.tableId),');
    // R2 (item 1, 2026-10-11): the flush claims every seat in claimSeatsForShutdown — the reserved-seat part keeps T1.
    const shutdown = fnSrc('function claimSeatsForShutdown(');
    expect(shutdown).toContain('if (isTournamentReservation(reserved)) { shutdownFlushStats.seatsNotCashed++; continue; }');
    expect(shutdown).not.toContain('tournamentTables.has(reserved.tableId)');
  });
});

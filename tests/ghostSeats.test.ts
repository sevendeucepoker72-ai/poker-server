/**
 * 2026-10-11 — AUTH-3 (P0 chip theft): clearGhostSeatsForUser identifies ghost
 * seats by ACCOUNT only.
 *
 * Before: its step 3 scanned the table for seats whose playerName equalled the
 * caller's display name / username, credited each one's stack to the CALLER and
 * stood the seat's player up. Seat names were client-sent, so: the attacker sits
 * down under the victim's name, opens a second tab and joins (joinTable /
 * quickPlay / joinAdditionalTable all run clearGhostSeatsForUser first) — he is
 * paid the victim's whole stack and the victim is stood up mid-session.
 *
 * Runs the REAL clearGhostSeatsForUser (+ the helpers it calls) sliced from
 * src/index.ts against a REAL PokerTable. The CONTROL runs the pre-fix function
 * (tests/fixtures/clearGhostSeatsForUser.b7fcd15.ts.txt, verbatim from the live
 * commit b7fcd15) on the same scenario and shows the theft.
 */

import fs from 'fs';
import path from 'path';
import { fnSrc, slice, load, SEAT_TEARDOWN_SRC } from './helpers/indexSource';
import { PokerTable } from '../src/game/PokerTable';

const T = 'cash-1';
const VICTIM = 100;
const ATTACKER = 200;

const CURRENT = fnSrc('function clearGhostSeatsForUser(')
  + fnSrc('function seatPlayedByAnotherAccount(')
  + fnSrc('function otherSessionHoldsSeat(')
  + slice('function seatReservedByOtherAccount(', '\n}\n')
  // R2 (2026-10-11): every ghost seat is stood up through the ONE seat teardown.
  + SEAT_TEARDOWN_SRC;
const HEAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'clearGhostSeatsForUser.b7fcd15.ts.txt'), 'utf8');

function world(code: string, opts: { tournament?: boolean } = {}) {
  const table = new PokerTable({ tableId: T, tableName: 'T', smallBlind: 50, bigBlind: 100, minBuyIn: 1000, maxBuyIn: 100000, maxPlayers: 9 } as any);
  const playerSessions = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const credits: Array<{ to: number; chips: number; reason: string }> = [];
  const vacated: string[] = [];
  const sockets = new Map<string, any>();
  const scope = {
    tableManager: { getTable: (id: string) => (id === T ? table : undefined) },
    playerSessions, authSessions, multiTableSessions, reservedSeats,
    io: { sockets: { sockets } },
    isTournamentReservation: () => false,
    isTournamentTable: () => !!opts.tournament,
    creditSeatStackToWallet: (userId: number, _u: string, _t: string, seat: any, reason: string) => credits.push({ to: userId, chips: seat.chipCount, reason }),
    auditLog: () => {}, broadcastGameState: () => {},
    console: { log() {}, warn() {}, error() {} },
  };
  const loaded = load(code, scope, 'clearGhostSeatsForUser');
  const sit = (sid: string, uid: number, seat: number, name: string, chips: number, playerId = `player-${sid}`) => {
    expect(table.sitDown(seat, name, chips, playerId, false)).toBe(true);
    playerSessions.set(sid, { socketId: sid, tableId: T, seatIndex: seat, playerName: name, playerId, sittingOut: false });
    authSessions.set(sid, { userId: uid, username: `user${uid}` });
    sockets.set(sid, { leave() {}, emit: (ev: string) => { if (ev === 'seatVacated') vacated.push(sid); } });
  };
  return { table, playerSessions, authSessions, multiTableSessions, reservedSeats, credits, vacated, sit, clear: loaded.exports as (...a: any[]) => number };
}

/** The audit repro: V sits at seat 2; A sits at seat 5 under V's name; A's second socket joins. */
function repro(code: string) {
  const w = world(code);
  w.sit('sockV', VICTIM, 2, 'Victim V.', 8000);
  w.sit('sockA1', ATTACKER, 5, 'Victim V.', 1000);
  w.authSessions.set('sockA2', { userId: ATTACKER, username: `user${ATTACKER}` });   // A's second tab
  const cleared = w.clear(ATTACKER, T, 'sockA2');
  return { w, cleared };
}

describe('AUTH-3 — ghost seats are found by ACCOUNT only', () => {
  it('CONTROL — the pre-fix function (b7fcd15) pays the attacker the victim\'s 8,000 stack and stands the victim up', () => {
    const { w } = repro(HEAD);
    expect(w.credits).toContainEqual({ to: ATTACKER, chips: 8000, reason: 'ghost_seat_name_scan' });
    expect(w.table.seats[2].state).toBe('empty');
  });

  it('the repro: only the attacker\'s OWN seat is cleared (credited to him); the victim keeps his seat, stack and session', () => {
    const { w, cleared } = repro(CURRENT);
    expect(cleared).toBe(1);
    expect(w.credits).toEqual([{ to: ATTACKER, chips: 1000, reason: 'ghost_seat_session_scan' }]);
    expect(w.table.seats[2]).toMatchObject({ state: 'occupied', chipCount: 8000, playerName: 'Victim V.' });
    expect(w.table.seats[5].state).toBe('empty');
    expect(w.playerSessions.has('sockV')).toBe(true);
    expect(w.vacated).toEqual(['sockA1']);
  });

  it('a STALE reservation of this account pointing at a seat another account\'s live session now plays: dropped, nothing credited, nobody stood up', () => {
    const w = world(CURRENT);
    w.sit('sockV', VICTIM, 2, 'Victim V.', 8000);
    w.reservedSeats.set(ATTACKER, { userId: ATTACKER, tableId: T, seatIndex: 2, playerName: 'Victim V.', chips: 500, expiresAt: Date.now() + 60_000, cleanupTimer: undefined });
    expect(w.clear(ATTACKER, T, 'sockA2')).toBe(0);
    expect(w.credits).toEqual([]);
    expect(w.table.seats[2]).toMatchObject({ state: 'occupied', chipCount: 8000 });
    expect(w.reservedSeats.has(ATTACKER)).toBe(false);
  });

  it('… and one whose seat is held by ANOTHER account\'s reservation (its player away): not credited either', () => {
    const w = world(CURRENT);
    w.sit('sockV', VICTIM, 2, 'Same Name', 8000);
    w.playerSessions.delete('sockV');                         // V disconnected: his seat is reserved for him
    w.reservedSeats.set(VICTIM, { userId: VICTIM, tableId: T, seatIndex: 2, playerName: 'Same Name', chips: 8000, expiresAt: Date.now() + 60_000, cleanupTimer: {} });
    w.reservedSeats.set(ATTACKER, { userId: ATTACKER, tableId: T, seatIndex: 2, playerName: 'Same Name', chips: 500, expiresAt: Date.now() + 60_000, cleanupTimer: undefined });
    expect(w.clear(ATTACKER, T, 'sockA2')).toBe(0);
    expect(w.credits).toEqual([]);
    expect(w.table.seats[2].state).toBe('occupied');
    expect(w.reservedSeats.get(VICTIM)).toBeTruthy();
  });

  it('this account\'s OWN reservation (its seat still its own, nobody on it) is cleared and credited exactly once — unchanged', () => {
    const w = world(CURRENT);
    expect(w.table.sitDown(4, 'Alice A.', 7000, 'player-x', false)).toBe(true);
    w.reservedSeats.set(ATTACKER, { userId: ATTACKER, tableId: T, seatIndex: 4, playerName: 'Alice A.', chips: 7000, expiresAt: Date.now() + 60_000, cleanupTimer: undefined });
    expect(w.clear(ATTACKER, T, 'sockNew')).toBe(1);
    expect(w.credits).toEqual([{ to: ATTACKER, chips: 7000, reason: 'ghost_seat_reserved' }]);
    expect(w.table.seats[4].state).toBe('empty');
  });

  it('a seat STAMPED with this account (playerId user_<id>) and played by nobody is his orphan; one played by a live session is never touched', () => {
    const w = world(CURRENT);
    expect(w.table.sitDown(1, 'Orphan', 3000, `user_${ATTACKER}`, false)).toBe(true);
    w.sit('sockLive', VICTIM, 6, 'Someone', 9000, `user_${ATTACKER}`);   // a live session plays it (whatever its stamp)
    expect(w.clear(ATTACKER, T, 'sockA2')).toBe(1);
    expect(w.credits).toEqual([{ to: ATTACKER, chips: 3000, reason: 'ghost_seat_account_stamp' }]);
    expect(w.table.seats[6]).toMatchObject({ state: 'occupied', chipCount: 9000 });
  });

  it('step 3 never touches a TOURNAMENT table: a stamped seat there is never stood up bare (T1)', () => {
    const w = world(CURRENT, { tournament: true });
    expect(w.table.sitDown(1, 'Away', 3000, `user_${ATTACKER}`, false)).toBe(true);
    expect(w.clear(ATTACKER, T, 'sockA2')).toBe(0);
    expect(w.credits).toEqual([]);
    expect(w.table.seats[1].state).toBe('occupied');
  });

  it('a same-NAMED seat with no session and no reservation (a true orphan of SOMEONE) is never credited to the caller', () => {
    const w = world(CURRENT);
    expect(w.table.sitDown(3, 'Victim V.', 6000, 'player-orphan', false)).toBe(true);
    w.authSessions.set('sockA2', { userId: ATTACKER, username: 'Victim V.' });
    expect(w.clear(ATTACKER, T, 'sockA2')).toBe(0);
    expect(w.credits).toEqual([]);
    expect(w.table.seats[3].state).toBe('occupied');
  });

  it('wiring: no name matching left; every caller uses the 4-argument form', () => {
    const fn = fnSrc('function clearGhostSeatsForUser(');
    expect(fn).not.toContain('namesToMatch');
    expect(fn).not.toMatch(/opts\.nameScan/);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src).not.toContain('{ nameScan: false }');
    expect(src).not.toContain("'ghost_seat_name_scan'");
  });
});

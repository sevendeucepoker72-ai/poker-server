/**
 * R3 (2026-10-11, SF-A) — S1-5 / CLUBS-5, cross-lane contract I1: a friend's
 * table invite that can be ACCEPTED.
 *
 * Before: inviteFriendToTable relayed `{ from, tableId }` for ANY tableId to
 * ANY account. Since R2 joinTable refuses a private home game
 * (invite_code_only), a club table (club_members_via_club) and every quick
 * table, so the invite from exactly the tables friends play together was a
 * dead `table_not_joinable`; a quick / tournament table could be offered and a
 * stranger spammed.
 *
 * Now (contract I1): the inviter must hold a live seat at that table (main or
 * extra-table), it must be a ring table (cash / private / club — never a quick
 * game, a tournament or a club challenge), the invitee an ACCEPTED friend with
 * a live socket, at most 10 invites a minute per account. Refusals are
 * `friendError {code, message}`; the invitee's every live socket gets
 * `tableInvite {from, tableId, tableKind, inviteCode?, clubId?, clubTableId?}`
 * and the inviter `friendInviteSent {userId}`.
 *
 * The REAL handler and table-kind helpers of src/index.ts (sliced +
 * transpiled), the REAL rate limiter.
 */
import { PokerTable } from '../src/game/PokerTable';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { validateTableConfig } from '../src/game/tableConfigValidation';
import { slice, handlerSrc, load, flush } from './helpers/indexSource';

const ALICE = 101;
const BOB = 102;
const CARL = 103;

const WHO = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', '}, 60_000).unref?.();\n');
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const LIMITER = slice('/** R3 (S1-5, contract I1) — friend table invites', 'createWindowRateLimiter(10, 60_000);\n');
const INVITE = handlerSrc('inviteFriendToTable', '\n  });\n');

function world() {
  const tables = new Map<string, PokerTable>();
  const mk = (id: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
    tables.set(id, t);
    return t;
  };
  const sockets = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const friends = new Set<string>([`${ALICE}:${BOB}`]);          // accepted pairs (Carl: a pending request / a stranger)
  const clubRows = new Map<string, { clubTableId: number; clubId: number }>();
  const friendLookups: Array<[number, number]> = [];
  const scope: Record<string, unknown> = {
    MAX_SEATS: 9,
    tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id) },
    io: { sockets: { sockets }, emit() {}, to: () => ({ emit() {} }) },
    authSessions, playerSessions, multiTableSessions,
    tournamentTables: new Map(), quickTables: new Set(), spinGoMultipliers: new Map(), careerTables: new Map(),
    allInOrFoldTables: new Set(), challengeTables: new Map(),
    areAcceptedFriends: async (a: number, b: number) => { friendLookups.push([a, b]); return friends.has(`${Math.min(a, b)}:${Math.max(a, b)}`); },
    getClubTableRowForRuntimeTable: async (id: string) => clubRows.get(id) ?? null,
    publicNameForUser: async (uid: number) => (uid === ALICE ? 'Alice' : `P${uid}`),
    createWindowRateLimiter, validateTableConfig,
    console: { log() {}, warn() {}, error() {} },
  };
  const { exports: m } = load(`${BROKEN}\n${WHO}\n${LIMITER}\nfunction wire(socket) {\n${INVITE}\n}`, scope,
    '{ wire, privateTableIds, clubTableIds, friendInviteLimiter }');
  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (id: string, userId: number) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = { id, connected: true, handlers, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, p: any) => emitted.push([id, ev, p]) };
    sockets.set(id, s);
    authSessions.set(id, { userId, username: `u${userId}` });
    m.wire(s);
    return s;
  };
  const of = (id: string, ev: string) => emitted.filter(([sid, e]) => sid === id && e === ev).map(([, , p]) => p);
  /** Alice seated at `tableId` (main session), Bob online on two tabs. */
  const setup = (tableId: string) => {
    const t = tables.get(tableId) ?? mk(tableId);
    t.sitDown(0, 'Alice', 1000, 'p-a', false);
    const a = mkSocket('SA', ALICE);
    playerSessions.set('SA', { socketId: 'SA', tableId, seatIndex: 0, playerId: 'p-a' });
    mkSocket('SB1', BOB);
    mkSocket('SB2', BOB);
    return { a, t };
  };
  return { m, scope, tables, mk, sockets, playerSessions, multiTableSessions, friends, clubRows, friendLookups, mkSocket, of, setup, emitted };
}

describe('S1-5 / contract I1 — inviteFriendToTable', () => {
  it('a PUBLIC cash table: every live socket of the friend gets tableInvite {from, tableId, tableKind:\'cash\'}; the inviter friendInviteSent', async () => {
    const w = world();
    const { a } = w.setup('cash1');
    await a.handlers.inviteFriendToTable({ userId: BOB, tableId: 'cash1' });
    const invite = { from: 'Alice', tableId: 'cash1', tableKind: 'cash' };
    expect([w.of('SB1', 'tableInvite'), w.of('SB2', 'tableInvite')]).toEqual([[invite], [invite]]);
    expect(w.of('SA', 'friendInviteSent')).toEqual([{ userId: BOB }]);
    expect(w.of('SA', 'friendError')).toEqual([]);
  });

  it('a PRIVATE home game: tableKind \'private\' + its inviteCode (the joinByInviteCode way in)', async () => {
    const w = world();
    const id = 'abcdef12-0000-4000-8000-000000000000';
    w.m.privateTableIds.add(id);
    const { a } = w.setup(id);
    await a.handlers.inviteFriendToTable({ userId: BOB, tableId: id });
    expect(w.of('SB1', 'tableInvite')).toEqual([{ from: 'Alice', tableId: id, tableKind: 'private', inviteCode: 'ABCDEF12' }]);
  });

  it('a CLUB table: tableKind \'club\' + clubId + clubTableId (the club_tables row joinClubTable takes); a club table with no row is not joinable', async () => {
    const w = world();
    w.m.clubTableIds.add('club1');
    w.clubRows.set('club1', { clubTableId: 33, clubId: 7 });
    const { a } = w.setup('club1');
    await a.handlers.inviteFriendToTable({ userId: BOB, tableId: 'club1' });
    expect(w.of('SB1', 'tableInvite')).toEqual([{ from: 'Alice', tableId: 'club1', tableKind: 'club', clubId: 7, clubTableId: 33 }]);
    w.clubRows.delete('club1');
    await a.handlers.inviteFriendToTable({ userId: BOB, tableId: 'club1' });
    expect(w.of('SA', 'friendError')).toEqual([expect.objectContaining({ code: 'invite_not_joinable' })]);
    expect(w.of('SB1', 'tableInvite')).toHaveLength(1);
  });

  it('an EXTRA-table seat counts as seated', async () => {
    const w = world();
    const t = w.mk('cash2');
    t.sitDown(4, 'Alice', 1000, 'p-a2', false);
    const a = w.mkSocket('SA', ALICE);
    w.mkSocket('SB1', BOB);
    w.multiTableSessions.set('SA', [{ socketId: 'SA', tableId: 'cash2', seatIndex: 4, playerId: 'p-a2' }]);
    await a.handlers.inviteFriendToTable({ userId: BOB, tableId: 'cash2' });
    expect(w.of('SB1', 'tableInvite')).toEqual([{ from: 'Alice', tableId: 'cash2', tableKind: 'cash' }]);
  });

  it('refusals (friendError {code, message}), nothing sent: not seated there / a quick, tournament or challenge table / not an ACCEPTED friend / offline', async () => {
    const w = world();
    const { a } = w.setup('cash1');
    w.mk('other');
    await a.handlers.inviteFriendToTable({ userId: BOB, tableId: 'other' });     // he does not sit there
    await a.handlers.inviteFriendToTable({ userId: BOB });                         // no table at all
    for (const [id, register] of [
      ['spin', () => (w.scope.spinGoMultipliers as Map<string, number>).set('spin', 2)],
      ['tour', () => (w.scope.tournamentTables as Map<string, string>).set('tour', 'T1')],
      ['hu', () => (w.scope.quickTables as Set<string>).add('hu')],
      ['chal', () => { (w.scope.challengeTables as Map<string, any>).set('chal', { challengeId: 1 }); (w.scope.quickTables as Set<string>).add('chal'); }],
    ] as Array<[string, () => void]>) {
      register();
      const t = w.mk(id);
      t.sitDown(1, 'Alice', 1000, `p-${id}`, false);
      w.playerSessions.set('SA', { socketId: 'SA', tableId: id, seatIndex: 1, playerId: `p-${id}` });
      await a.handlers.inviteFriendToTable({ userId: BOB, tableId: id });
    }
    w.playerSessions.set('SA', { socketId: 'SA', tableId: 'cash1', seatIndex: 0, playerId: 'p-a' });
    w.mkSocket('SC', CARL);
    await a.handlers.inviteFriendToTable({ userId: CARL, tableId: 'cash1' });     // pending / no friendship
    await a.handlers.inviteFriendToTable({ userId: ALICE, tableId: 'cash1' });    // himself
    w.friends.add(`${ALICE}:104`);
    await a.handlers.inviteFriendToTable({ userId: 104, tableId: 'cash1' });      // a friend with no live socket
    expect(w.of('SA', 'friendError').map((e) => e.code)).toEqual([
      'invite_not_seated', 'invite_not_seated',
      'invite_not_joinable', 'invite_not_joinable', 'invite_not_joinable', 'invite_not_joinable',
      'not_friends', 'not_friends', 'invite_target_offline',
    ]);
    for (const e of w.of('SA', 'friendError')) expect(typeof e.message).toBe('string');
    expect(w.emitted.filter(([, ev]) => ev === 'tableInvite')).toEqual([]);
    expect(w.of('SA', 'friendInviteSent')).toEqual([]);
  });

  it('presence is never revealed to a non-friend: the friendship is checked before the online check', async () => {
    const w = world();
    const { a } = w.setup('cash1');
    await a.handlers.inviteFriendToTable({ userId: 999, tableId: 'cash1' });      // a stranger, offline
    expect(w.of('SA', 'friendError').map((e) => e.code)).toEqual(['not_friends']);
  });

  it('at most 10 invites a minute per account (rate_limited), checked before any DB lookup', async () => {
    const w = world();
    const { a } = w.setup('cash1');
    for (let i = 0; i < 12; i++) await a.handlers.inviteFriendToTable({ userId: BOB, tableId: 'cash1' });
    await flush();
    expect(w.of('SB1', 'tableInvite')).toHaveLength(10);
    expect(w.of('SA', 'friendError').map((e) => e.code)).toEqual(['rate_limited', 'rate_limited']);
    expect(w.friendLookups).toHaveLength(10);
  });
});

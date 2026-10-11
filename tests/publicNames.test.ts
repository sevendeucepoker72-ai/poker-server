/**
 * R1 (2026-10-11) — ECON-3 / AUTH-7 / APPUI-1 / APPUI-14 (P0 PII): no other
 * player is ever sent users.username (a login handle: phone numbers — the
 * admin seed row sat at #1 of the leaderboard under the owner's phone — and
 * first.last slugs).
 *
 *  - getLeaderboard: display names (else 'Player'), no admin / banned /
 *    tombstone / retired-guest rows, the viewer's row flagged `isYou`, no ids;
 *  - searchPlayers: signed-in + rate-limited, display names, no chips / ids;
 *  - checkUsername: signed-in + rate-limited, display-name availability (no
 *    login-handle oracle);
 *  - staking offers, tournament standings, profiles, friend lists / events,
 *    voice + coach names, club views: public names;
 *  - sendFriendRequest by name: an EXACT display-name match of exactly one
 *    account (never the first partial LIKE match).
 */
import { createHash } from 'crypto';
import { slice, handlerSrc, load, flush, SRC } from './helpers/indexSource';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import {
  publicDisplayName, isPublicDisplayName, publicNameOf, isPhoneLike, escapeLikePattern, LISTABLE_USER_SQL, PUBLIC_NAME_FALLBACK,
} from '../src/social/publicIdentity';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authManager = require('../src/auth/authManager') as typeof import('../src/auth/authManager');

describe('publicDisplayName — what other players may see', () => {
  it.each([
    ['Josh Hall', 'Josh Hall'], ['josh.hall', 'josh.hall'], ["O'Neil", "O'Neil"], ['Bob 2000', 'Bob 2000'], ['  Ann  ', 'Ann'],
    ['3035551234', 'Player'], ['303 555 1234', 'Player'], ['+13035551234', 'Player'], ['Joe 5551234', 'Player'],
    [null, 'Player'], [undefined, 'Player'], ['', 'Player'], ['A', 'Player'], ['x'.repeat(21), 'Player'],
    ['João', 'Player'], ['<b>x</b>', 'Player'], ['---', 'Player'], [42, 'Player'],
  ])('%p -> %p', (input, want) => {
    expect(publicDisplayName(input)).toBe(want);
  });
  it('helpers', () => {
    expect(isPhoneLike('call 555-123-4567')).toBe(true);
    expect(isPublicDisplayName('Josh Hall')).toBe(true);
    expect(isPublicDisplayName('3035551234')).toBe(false);
    expect(isPublicDisplayName('Player')).toBe(false);
    expect(publicNameOf('Bot Ace')).toBe('Bot Ace');
    expect(escapeLikePattern('50%_a\\b')).toBe('50\\%\\_a\\\\b');
    for (const k of ['COALESCE(banned, FALSE) = FALSE', 'COALESCE(is_admin, FALSE) = FALSE', '"mergedInto"', '"claimedBy"']) expect(LISTABLE_USER_SQL).toContain(k);
  });
});

describe('authManager readers (against a recording test double)', () => {
  const rec = (rows: any[]) => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    return { calls, query: async (text: string, params?: unknown[]) => { calls.push({ text, params: params || [] }); return { rows }; } };
  };

  it('getLeaderboard selects display_name (never username), only listable rows; phone-like / missing names show as Player', async () => {
    const db = rec([
      { id: 5, display_name: 'Josh Hall', chips: 900, level: 7, stats: '{"handsPlayed":10,"handsWon":4}' },
      { id: 6, display_name: '3035551234', chips: 800, level: 3, stats: '{}' },
      { id: 7, display_name: null, chips: 700, level: 1, stats: null },
    ]);
    const out = await authManager.getLeaderboard(50, 'alltime', db);
    expect(db.calls[0].text).toContain('SELECT id, display_name, chips, level, stats FROM users WHERE ' + LISTABLE_USER_SQL);
    expect(db.calls[0].text).not.toMatch(/\busername\b/);
    expect(out.map((e) => [e.rank, e.username, e.displayName, e.userId])).toEqual([[1, 'Josh Hall', 'Josh Hall', 5], [2, 'Player', 'Player', 6], [3, 'Player', 'Player', 7]]);
    expect(out[0]).toMatchObject({ handsPlayed: 10, handsWon: 4, winRate: 40 });
  });

  it('searchUsers matches the display name with escaped wildcards and returns name + level only', async () => {
    const db = rec([{ id: 1, display_name: 'Josh Hall', level: 4 }, { id: 2, display_name: '3035551234', level: 1 }]);
    expect(await authManager.searchUsers('50%_', 10, db)).toEqual([{ id: 1, displayName: 'Josh Hall', level: 4 }]);
    expect(db.calls[0].text).toContain("LOWER(display_name) LIKE $1 ESCAPE '\\'");
    expect(db.calls[0].text).toContain(LISTABLE_USER_SQL);
    expect(db.calls[0].params[0]).toBe('%50\\%\\_%');
    expect(await authManager.searchUsers('x', 10, db)).toEqual([]);          // < 2 chars: no query
    expect(db.calls).toHaveLength(1);
  });

  it('findUsersByDisplayName is an exact, case-insensitive match (a non-public name is never looked up)', async () => {
    const db = rec([{ id: 9, display_name: 'Josh Hall' }]);
    expect(await authManager.findUsersByDisplayName('josh hall', 2, db)).toEqual([{ id: 9, displayName: 'Josh Hall' }]);
    expect(db.calls[0].text).toContain('LOWER(TRIM(display_name)) = LOWER($1)');
    expect(await authManager.findUsersByDisplayName('3035551234', 2, db)).toEqual([]);
    expect(db.calls).toHaveLength(1);
  });
});

// ── the socket handlers (real src/index.ts source) ──
const HELPERS = slice('// ========== Public names (R1 2026-10-11', '      finishPosition: p.finishPosition,\n    })),\n  };\n}\n');
const HANDLERS = ['getLeaderboard', 'searchPlayers', 'checkUsername', 'sendFriendRequest', 'inviteFriendToTable', 'requestProfile', 'getTournamentStandings', 'getStakes']
  .map((ev) => handlerSrc(ev, '\n  });\n')).join('\n');

function world() {
  const authSessions = new Map<string, any>([['S1', { userId: 42, username: '3035551234' }], ['S2', { userId: 43, username: 'jane.doe' }]]);
  const names = new Map<number, string>([[42, 'Josh Hall'], [43, 'Jane D'], [44, 'Bob']]);
  const accounts = [{ id: 44, displayName: 'Bob' }, { id: 45, displayName: 'Bobby' }, { id: 46, displayName: 'Twin' }, { id: 47, displayName: 'twin' }];
  const toEmits: Array<[string, string, any]> = [];
  const friendRequests: Array<[number, number]> = [];
  const stakingOffers = new Map<string, any>([['o1', {
    id: 'o1', tournamentId: 't1', totalPct: 20, pricePerPct: 100, playerName: '3035551234', sellerId: 42, remaining: 10,
    backers: [{ name: 'jane.doe', userId: 43, pct: 10 }], createdAt: 1,
  }]]);
  const scope: Record<string, unknown> = {
    authSessions, createWindowRateLimiter, publicNameOf, PUBLIC_NAME_FALLBACK, isPublicDisplayName, createHash,
    getLeaderboard: async () => [
      { rank: 1, username: 'Bob', displayName: 'Bob', chips: 500, level: 2, handsPlayed: 0, handsWon: 0, winRate: 0, biggestPot: 0, userId: 44 },
      { rank: 2, username: 'Josh Hall', displayName: 'Josh Hall', chips: 400, level: 2, handsPlayed: 0, handsWon: 0, winRate: 0, biggestPot: 0, userId: 42 },
    ],
    searchUsers: async (q: string) => accounts.filter((a) => a.displayName.toLowerCase().includes(q.toLowerCase())).map((a) => ({ id: a.id, displayName: a.displayName, level: 3 })),
    findUsersByDisplayName: async (n: string, limit = 2) => accounts.filter((a) => a.displayName.toLowerCase() === n.trim().toLowerCase()).slice(0, limit),
    getPublicNames: async (ids: number[]) => new Map(ids.filter((i) => names.has(i)).map((i) => [i, names.get(i)!])),
    sendFriendRequest: async (from: number, to: number) => { friendRequests.push([from, to]); return { ok: true, status: 'pending' }; },
    io: { to: (sid: string) => ({ emit: (ev: string, d: any) => { toEmits.push([sid, ev, d]); } }) },
    getPool: () => ({ query: async (_t: string, p: unknown[]) => ({ rows: p[0] === 44 ? [{ level: 9, stats: '{"handsPlayed":20,"handsWon":5}', achievements: '[]' }] : [] }) }),
    tournamentManager: {
      getTournamentList: () => [{ tournamentId: 'Q1', status: 'running' }],
      getTournamentStandings: () => ({
        tournamentId: 'Q1', name: 'Qualifier Tournament', status: 'running',
        eliminationOrder: ['3035551234'],
        players: [
          { playerId: '3035551234', playerName: '3035551234', chipCount: 0, finishPosition: 3 },
          { playerId: 'jane.doe', playerName: 'Jane D', chipCount: 9000, finishPosition: null },
          { playerId: 'ai-1', playerName: 'Bot Ace', chipCount: 6000, finishPosition: null },
        ],
      }),
    },
    tableManager: {},
  };
  const code = `${HELPERS}\nconst stakingOffers = stakingOffersMap;\nfunction wire(socket) {\n${HANDLERS}\n}`;
  scope.stakingOffersMap = stakingOffers;
  const { exports: m } = load(code, scope, '{ wire, publicNameForUser }');
  const mk = (id: string) => {
    const emitted: Array<[string, any]> = [];
    const handlers: Record<string, (d?: any) => any> = {};
    m.wire({ id, emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { handlers[ev] = fn; } });
    const call = async (ev: string, d?: any) => { await handlers[ev](d); await flush(); return emitted[emitted.length - 1]?.[1]; };
    return { emitted, handlers, call };
  };
  return { m, mk, toEmits, friendRequests, authSessions };
}

describe('the socket surface sends public names only', () => {
  it('getLeaderboard: no account ids, the viewer\'s own row is isYou (server-side)', async () => {
    const w = world();
    const d = await w.mk('S1').call('getLeaderboard', { period: 'alltime' });
    expect(d.entries.map((e: any) => [e.username, e.isYou])).toEqual([['Bob', false], ['Josh Hall', true]]);
    expect(d.entries.every((e: any) => !('userId' in e))).toBe(true);
    const anon = await w.mk('S9').call('getLeaderboard', {});
    expect(anon.entries.every((e: any) => e.isYou === false)).toBe(true);
  });

  it('searchPlayers: signed-in only, rate-limited per account, name + level (no chips / ids)', async () => {
    const w = world();
    expect(await w.mk('S9').call('searchPlayers', { query: 'bo' })).toEqual({ results: [], error: 'login_required' });
    const s = w.mk('S1');
    const r = await s.call('searchPlayers', { query: 'bo' });
    expect(r.results).toEqual([{ id: 'r0', username: 'Bob', displayName: 'Bob', level: 3 }, { id: 'r1', username: 'Bobby', displayName: 'Bobby', level: 3 }]);
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await s.call('searchPlayers', { query: 'bo' })).error === 'rate_limited') limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('checkUsername: signed-in only; display-name availability (the caller\'s own counts as free)', async () => {
    const w = world();
    expect(await w.mk('S9').call('checkUsername', { username: 'Bob' })).toMatchObject({ available: null, error: 'login_required' });
    const s = w.mk('S1');
    expect(await s.call('checkUsername', { username: 'bob' })).toEqual({ available: false, username: 'bob' });
    expect(await s.call('checkUsername', { username: 'Brand New' })).toEqual({ available: true, username: 'Brand New' });
    expect(await s.call('checkUsername', { username: '3035551234' })).toEqual({ available: null, username: '3035551234' });
  });

  it('sendFriendRequest {name}: EXACT match of one account; partial / ambiguous / unknown names are refused; the target hears a public name', async () => {
    const w = world();
    const s = w.mk('S1');
    w.authSessions.set('S44', { userId: 44, username: '7205550000' });
    expect(await s.call('sendFriendRequest', { name: 'bo' })).toMatchObject({ code: 'friend_not_found' });     // the old LIKE took Bob/Bobby
    expect(await s.call('sendFriendRequest', { name: 'twin' })).toMatchObject({ code: 'friend_name_ambiguous' });
    expect(await s.call('sendFriendRequest', { name: 'BOB' })).toEqual({ status: 'pending' });
    expect(w.friendRequests).toEqual([[42, 44]]);
    expect(w.toEmits).toContainEqual(['S44', 'friendRequestReceived', { from: 'Josh Hall' }]);
    expect(await s.call('sendFriendRequest', { userId: 999 })).toMatchObject({ code: 'friend_not_found' });   // not a real account
    await s.call('inviteFriendToTable', { userId: 44, tableId: 'T1' });
    expect(w.toEmits).toContainEqual(['S44', 'tableInvite', { from: 'Josh Hall', tableId: 'T1' }]);
  });

  it('requestProfile: looked up by exact display name, echoes the requested name, never a login handle', async () => {
    const w = world();
    const s = w.mk('S1');
    expect(await s.call('requestProfile', { username: 'bob' })).toMatchObject({ username: 'bob', displayName: 'Bob', level: 9, totalHands: 20, wins: 5 });
    expect(await s.call('requestProfile', { username: '3035551234' })).toMatchObject({ username: '3035551234', notFound: true });
  });

  it('getTournamentStandings: public names, opaque but stable entrant ids (incl. the elimination order)', async () => {
    const w = world();
    const a = await w.mk('S1').call('getTournamentStandings', {});
    const b = await w.mk('S2').call('getTournamentStandings', {});
    expect(a).toEqual(b);
    expect(a.players.map((p: any) => p.playerName)).toEqual(['Player', 'Jane D', 'Bot Ace']);
    expect(JSON.stringify(a)).not.toContain('3035551234');
    expect(JSON.stringify(a)).not.toContain('jane.doe');
    expect(a.eliminationOrder).toEqual([a.players[0].playerId]);
    expect(a.players[0].playerId).toMatch(/^e[0-9a-f]{12}$/);
  });

  it('stakingUpdated: display names, no seller / backer account ids', async () => {
    const w = world();
    const d = await w.mk('S1').call('getStakes');
    // R2 (C4, 2026-10-11): + `isMine` per socket, and the seller's id on HIS OWN offer only (S1 is the seller, 42).
    expect(d.offers).toEqual([{ id: 'o1', tournamentId: 't1', totalPct: 20, pricePerPct: 100, playerName: 'Josh Hall', remaining: 10, backers: [{ name: 'Jane D', pct: 10 }], createdAt: 1, isMine: true, sellerUserId: 42 }]);
    // Another account (the backer, 43) sees no seller id at all.
    const other = await w.mk('S2').call('getStakes');
    expect(other.offers).toEqual([{ id: 'o1', tournamentId: 't1', totalPct: 20, pricePerPct: 100, playerName: 'Josh Hall', remaining: 10, backers: [{ name: 'Jane D', pct: 10 }], createdAt: 1, isMine: false, sellerUserId: null }]);
  });

  it('wiring: no handler emits a login handle to another player any more', () => {
    for (const bad of [
      "{ from: auth.username }", "from: auth.username, tableId", "emit('voicePeerJoined', { socketId: socket.id, username: auth.username })",
      'offer: data.offer, username: auth.username', 'coachName: data.coachName || auth.username',
      "socket.emit('leaderboardData', { period, entries });", "results: await searchUsers(q) }", 'SELECT username, level, stats, achievements FROM users WHERE LOWER(username)',
      "io.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });",
      "'SELECT id, username, chips FROM users WHERE banned = FALSE ORDER BY chips DESC LIMIT 3'",
    ]) expect([bad, SRC.includes(bad)]).toEqual([bad, false]);
    expect(SRC).toContain("socket.emit('tournamentStandings', tid ? publicTournamentStandings(");
    expect(SRC).toContain('results.push({ userId: u.id, displayName: publicNameOf(u.display_name), place: rw.place');
  });
});

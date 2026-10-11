/**
 * 2026-10-11 — R1 contract #3 (audit AUTH-6, APPUI-13, TOURNEY-12, AUTH-10):
 * what a seat shows to every player at the table.
 *
 *  - NAMES: for a signed-in socket the server IGNORES the client's playerName
 *    on every seat / quick-game / tournament / waitlist / chat path and shows the
 *    ACCOUNT's display name (session displayName, set at sign-in and by
 *    setDisplayName) through the setDisplayName whitelist — never a phone, never
 *    the `m:<id>` username — else 'Player'. Before: joinTable stripped only
 *    <>&"' (any name — impersonation), quick games used the raw value (a
 *    non-string made `(name||'?')[0].toUpperCase()` throw for every viewer).
 *  - AVATARS: only the customizer's known fields (style ids, #hex colors, face
 *    sliders 0..1); `photo` and everything else dropped.
 *
 * Runs the REAL joinTable / quickHeadsUp / registerTournament / chatMessage
 * handlers sliced from src/index.ts against a real PokerTable and
 * TournamentManager.
 */

import { handlerSrc, slice, load, flush, SRC } from './helpers/indexSource';
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';
import { accountDisplayName } from '../src/auth/displayName';
import { sanitizeSeatAvatar } from '../src/seatProfile';

const SEAT_NAME = slice('function seatNameForSocket(', '\n}\n');
const H = {
  joinTable: handlerSrc('joinTable', '\n    })(); }\n  );'),
  quickHeadsUp: handlerSrc('quickHeadsUp', '\n  });\n'),
  registerTournament: handlerSrc('registerTournament', '\n  });\n'),
  chatMessage: handlerSrc('chatMessage', '\n  });\n'),
};

const ALICE = 101;

// quickHeadsUp arms a 60s blind interval and a 5-minute game timer: keep them fake.
beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
const EVIL_AVATAR = {
  photo: 'https://tracker.example/pixel.png',
  seatColor: 'url(javascript:alert(1))',
  skinTone: '#C68642',
  hairStyle: 'short',
  topColor: 'red; background-image: url(x)',
  faceShape: { jawWidth: 7, eyeSize: 0.25, nose: 'x' },
  onload: 'alert(1)',
};

function world(session: { displayName?: string | null } | null) {
  const tables = new Map<string, PokerTable>();
  const mk = (id: string, maxPlayers = 9) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10000, maxPlayers } as any);
    (t as any).variantId = 'texas-holdem';
    tables.set(id, t);
    return t;
  };
  const cash = mk('t1');
  const tm = new TournamentManager();
  const tid = tm.createTournament({ name: 'Free', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: DEFAULT_BLIND_LEVELS } as any);
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const roomEmits: Array<[string, any]> = [];
  let created = 0;
  const scope: Record<string, unknown> = {
    tableManager: {
      getTable: (id: string) => tables.get(id),
      createHeadsUpTable: (name: string) => { const id = `hu${++created}`; mk(id, 2).config.tableName = name; return id; },
    },
    tournamentManager: tm,
    authSessions, playerSessions, multiTableSessions: new Map(), reservedSeats: new Map(), spectators: new Map(),
    aiProfiles: new Map(), ipSeatedSlots: new Map(), quickTables: new Set(), quickGameTimers: new Map(),
    MAX_SEATS: 9, clientIp: '10.0.0.1', lastChatTime: new Map(),
    io: { emit() {}, to: () => ({ emit: (ev: string, d: any) => roomEmits.push([ev, d]) }), sockets: { sockets: new Map() } },
    uuidv4: () => `u${Math.random().toString(36).slice(2, 10)}`,
    generateRandomProfile: () => ({ botName: 'Bot' }),
    blockedByMaintenance: () => false, quickPlayRateLimited: () => false,
    assertPlayable: async () => null, isUserBanned: async () => false, buyInSocketGone: async () => false,
    isTournamentTable: () => false,
    ensureChipsForBuyIn: async () => 1_000_000, deductChips: async () => true, addChipsToUser: async () => true,
    progressionManager: { getOrCreateProgress() {}, recordAction() {} },
    getGameStateForPlayer: () => ({}),
    auditLog() {}, Sentry: null, console: { log() {}, warn() {}, error() {} }, log: { debug() {} },
    accountDisplayName, sanitizeSeatAvatar,
  };
  const loaded = load(`${SEAT_NAME}\nfunction wire(socket) {\n${Object.values(H).join('\n')}\n}`, scope, '{ wire }');
  const handlers: Record<string, (...a: any[]) => any> = {};
  const emitted: Array<[string, any]> = [];
  const socket: any = {
    id: 'S1', connected: true, handshake: { address: '10.0.0.1' },
    on: (ev: string, fn: any) => { handlers[ev] = fn; },
    emit: (ev: string, d: any) => { emitted.push([ev, d]); },
    join() {}, leave() {},
  };
  if (session) authSessions.set('S1', { userId: ALICE, username: 'm:4f1c2d3e-uuid', masterUserId: 'm-alice', ...session });
  loaded.exports.wire(socket);
  for (const name of ['seatNameForSocket', 'accountDisplayName', 'sanitizeSeatAvatar']) expect(loaded.stubbed.has(name)).toBe(false);
  return { tables, cash, tm, tid, authSessions, playerSessions, handlers, emitted, roomEmits };
}

describe('names — the ACCOUNT\'s display name on every seat path; the client\'s name is ignored', () => {
  it.each([
    ['another player\'s name', 'Victim V.'],
    ['markup', '<img src=x onerror=alert(1)>'],
    ['a non-string (crashed every viewer before)', { length: 1, 0: 'x' }],
    ['nothing', undefined],
  ])('joinTable with %s → the seat shows "Josh Hall"; the avatar keeps only the allowlisted fields', async (_l, clientName) => {
    const w = world({ displayName: 'Josh Hall' });
    await w.handlers.joinTable({ tableId: 't1', playerName: clientName, seatIndex: 3, buyIn: 1000, avatar: EVIL_AVATAR });
    await flush();
    expect(w.cash.seats[3]).toMatchObject({ state: 'occupied', playerName: 'Josh Hall' });
    expect(w.playerSessions.get('S1')).toMatchObject({ playerName: 'Josh Hall' });
    expect(w.playerSessions.get('S1').avatar).toEqual({ skinTone: '#C68642', hairStyle: 'short', faceShape: { jawWidth: 1, eyeSize: 0.25 } });
  });

  it('an account display name that is a phone number / an m: key / non-ASCII is never shown — "Player"', async () => {
    for (const displayName of ['7205551234', 'm:4f1c2d3e-uuid', '美琪', null]) {
      const w = world({ displayName });
      await w.handlers.joinTable({ tableId: 't1', playerName: 'Chosen Name', seatIndex: 2, buyIn: 1000 });
      await flush();
      expect(w.cash.seats[2].playerName).toBe('Player');
    }
  });

  it('a long account name becomes "First L." (whitelist max 20)', async () => {
    const w = world({ displayName: 'Christopher Montgomery' });
    await w.handlers.joinTable({ tableId: 't1', playerName: 'x', seatIndex: 1, buyIn: 1000 });
    await flush();
    expect(w.cash.seats[1].playerName).toBe('Christopher M.');
  });

  it('quickHeadsUp: seat AND the table\'s public title use the account name, not the client\'s', async () => {
    const w = world({ displayName: 'Josh Hall' });
    await w.handlers.quickHeadsUp({ playerName: '<script>Impostor' });
    await flush();
    const hu = w.tables.get('hu1')!;
    expect(hu.config.tableName).toBe('Heads-Up Snap: Josh Hall');
    expect(hu.seats[0].playerName).toBe('Josh Hall');
  });

  it('registerTournament: the registration (standings, ticker, results) carries the account name', async () => {
    const w = world({ displayName: 'Josh Hall' });
    await w.handlers.registerTournament({ tournamentId: w.tid, playerName: 'Someone Else' });
    await flush();
    expect(w.tm.getTournament(w.tid)!.players.map((p) => p.playerName)).toEqual(['Josh Hall']);
  });

  it('chat: the line carries the account name', async () => {
    const w = world({ displayName: 'Josh Hall' });
    w.playerSessions.set('S1', { socketId: 'S1', tableId: 't1', seatIndex: 0, playerName: 'Stale Name', playerId: 'p1' });
    await w.handlers.chatMessage({ message: 'gg' });
    expect(w.roomEmits).toContainEqual(['chatMessage', expect.objectContaining({ playerName: 'Josh Hall', message: 'gg' })]);
  });

  it('a socket with NO account (guest rollback only) gets its client name through the same whitelist', async () => {
    const ok = world(null);
    await ok.handlers.joinTable({ tableId: 't1', playerName: 'Guest42', seatIndex: 4, buyIn: 1000 });
    await flush();
    expect(ok.cash.seats[4].playerName).toBe('Guest42');
    const bad = world(null);
    await bad.handlers.joinTable({ tableId: 't1', playerName: { toString: () => 'x' }, seatIndex: 4, buyIn: 1000 });
    await flush();
    expect(bad.cash.seats[4].playerName).toBe('Player');
  });
});

describe('avatars — sanitizeSeatAvatar', () => {
  it('drops photo and every unknown key, keeps hex colors / style ids / clamped sliders', () => {
    expect(sanitizeSeatAvatar(EVIL_AVATAR)).toEqual({ skinTone: '#C68642', hairStyle: 'short', faceShape: { jawWidth: 1, eyeSize: 0.25 } });
    expect(sanitizeSeatAvatar({ seatColor: '#0f0', topColor: '#0C1A44', accessory: 'gold_chain' })).toEqual({ seatColor: '#0f0', topColor: '#0C1A44', accessory: 'gold_chain' });
    expect(sanitizeSeatAvatar({ seatColor: 'red', hairStyle: 'Short Hair', bodyType: 'x'.repeat(30) })).toBeUndefined();
    for (const v of [undefined, null, 'avatar.png', 42, ['#fff']]) expect(sanitizeSeatAvatar(v)).toBeUndefined();
  });
});

describe('wiring — every seat / registration / chat path names the seat through seatNameForSocket', () => {
  /** Body of the handler registered for `event` (up to the next registration), comments dropped. */
  function body(event: string): string {
    let at = SRC.indexOf(`socket.on('${event}'`);
    if (at < 0) at = SRC.indexOf(`'${event}',\n`);
    const rest = SRC.slice(at + 10);
    const next = rest.search(/\n {2}socket\.on\(/);
    return SRC.slice(at, at + 10 + (next >= 0 ? next : rest.length)).split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  }
  it.each([
    'joinTable', 'quickPlay', 'quickHeadsUp', 'quickSpinGo', 'quickAllInOrFold', 'startCareerGame',
    'joinAdditionalTable', 'joinByInviteCode', 'registerTournament', 'registerQualifierTournament',
    'joinWithWaitlistContext', 'chatMessage', 'emote', 'tableReaction', 'sendClubMessage',
  ])('%s', (event) => {
    const b = body(event);
    expect(b).toContain('seatNameForSocket(socket');
    expect(b).not.toMatch(/const \{[^}]*\bplayerName\b[^}]*\} = data/);
    expect(b).not.toMatch(/data\.playerName \|\|/);
  });
  it('every seat path that stores an avatar allowlists it first', () => {
    for (const event of ['joinTable', 'quickPlay', 'joinAdditionalTable', 'joinByInviteCode']) {
      const b = body(event);
      expect({ event, ok: b.includes('sanitizeSeatAvatar(data.avatar)') }).toEqual({ event, ok: true });
      expect(b).not.toMatch(/avatar: data\.avatar \|\|/);
    }
  });
  it('every sign-in puts the account display name on its session', () => {
    for (const needle of [
      'displayName: localUser.display_name || localUser.username,   // R1 contract #3',
      'displayName: _tlLocalUser.display_name || _tlLocalUser.username,   // R1 contract #3',
      'statsMasterUserId: masterIdFromStats(result.userData.stats), displayName: result.userData.username });',
      "phone: String(phone), displayName: localUser.display_name || localUser.username });",
      'displayName: row.display_name || row.username,   // R1 contract #3',
      'displayName: wlRow.display_name || wlRow.username };',
    ]) expect({ needle, found: SRC.includes(needle) }).toEqual({ needle, found: true });
    expect(SRC).toContain('for (const a of authSessions.values()) if (a.userId === auth.userId) a.displayName = data.name.trim();');
  });
});

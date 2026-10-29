/**
 * 2026-10-28 (error sweep: api-logs / api-http / db / jobs-infra) — .online
 * pushes go to the MASTER account id, never poker-server's LOCAL integer id.
 * The blind_level_up hook (startTournamentGame + bootstrapTournamentTables)
 * and the simulation start's tournament_start sent userIdForSeat / auth.userId:
 * the master answered 202, then its dispatcher died on 'invalid input syntax
 * for type uuid' (477 in a week, 397 on the 10-25 qualifier, 0 ever delivered).
 *  - masterUserIdForSeat: the entrant's masterUserId, the bound session's
 *    masterUserId / statsMasterUserId, the reservation snapshot, the absent-seat
 *    cache (notifyTournamentStart's order); null = skipped (one debug line).
 *  - notifyClient: refuses a non-uuid without a request; the master's 400
 *    (invalid_user_id) is taken quietly — counted, never retried, never thrown.
 *  - Review fix 2026-10-28: the blind push itself stays OFF unless
 *    BLIND_LEVEL_PUSH_ENABLED=1 (it had never been delivered; turning it on is
 *    an owner decision). Off: nothing sent, `disabled` counts would-be pushes.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { masterIdFromStats } from '../src/auth/playGate';
import { SRC, slice, fnSrc, load, flush } from './helpers/indexSource';

const U = {
  a: 'a9d0d643-0000-4000-8000-00000000000a',
  b: 'b9d0d643-0000-4000-8000-00000000000b',
  c: 'c9d0d643-0000-4000-8000-00000000000c',
  d: 'd9d0d643-0000-4000-8000-00000000000d',
  q: 'e9d0d643-0000-4000-8000-00000000000e',
  other: 'f9d0d643-0000-4000-8000-00000000000f',
};

const PUSH_SRC = [fnSrc('function userIdForSeat('), fnSrc('function masterUserIdForSeat('),
  slice('const blindLevelUpPushes = ', ';\n'), fnSrc('function notifyBlindLevelUp(')].join('\n');

type Sent = { to: unknown; type: string; title: string; body: string; opts: any };

describe('masterUserIdForSeat + notifyBlindLevelUp — the blind push by MASTER id', () => {
  const savedFlag = process.env.BLIND_LEVEL_PUSH_ENABLED;
  beforeEach(() => { process.env.BLIND_LEVEL_PUSH_ENABLED = '1'; });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.BLIND_LEVEL_PUSH_ENABLED;
    else process.env.BLIND_LEVEL_PUSH_ENABLED = savedFlag;
  });
  function world() {
    const tm = new TournamentManager();
    const tid = tm.createTournament({ name: 'Cup', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, minPlayers: 2, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }, { sb: 20, bb: 40, ante: 0, duration: 300 }] } as any);
    const table = new PokerTable({ tableId: 'T1', tableName: 'Cup — Table 1', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: 9 } as any);
    const playerSessions = new Map<string, any>();
    const authSessions = new Map<string, any>();
    const reservedSeats = new Map<number, any>();
    const absentSeatMasterIds = new Map<number, any>();
    const seat = (i: number, pid: string, sid: string | null, auth: any, reg?: { userId?: number; masterUserId?: string }) => {
      table.sitDown(i, `P-${pid}`, 1500, pid, false);
      tm.registerPlayer(tid, pid, `P-${pid}`, sid || `gone-${pid}`, reg?.userId, reg?.masterUserId);
      if (sid) { playerSessions.set(sid, { tableId: 'T1', seatIndex: i }); if (auth) authSessions.set(sid, auth); }
    };
    seat(0, 'pa', 'SA', { userId: 1, masterUserId: U.a }, { userId: 1 });                           // attested session
    seat(1, 'pb', 'SB', { userId: 2, statsMasterUserId: U.b }, { userId: 2 });                      // legacy session: the row's stamp
    seat(2, 'pc', 'SC', { userId: 3 }, { userId: 3 });                                              // reservation snapshot
    reservedSeats.set(3, { masterUserId: U.c });
    seat(3, 'pd', 'SD', { userId: 4 }, { userId: 4 });                                              // absent-seat cache
    absentSeatMasterIds.set(4, { masterId: U.d, at: Date.now() });
    seat(4, 'pe', 'SE', { userId: 5 }, { userId: 5 });                                              // nothing known: skipped
    seat(5, 'pq', 'SQ', { userId: 6, masterUserId: U.other }, { masterUserId: U.q });               // qualifier entrant: his registration wins
    seat(6, 'pf', 'SF', { userId: 99, masterUserId: U.other }, { userId: 7 });                      // ANOTHER account's socket on his seat: never that id
    seat(7, 'pg', null, null, { userId: 8, masterUserId: U.other });                                // away (no bound session): not a recipient (unchanged)
    table.sitDown(8, 'Bot', 1500, 'ai-1', true);                                                    // AI: never
    const sent: Sent[] = [];
    const debug: string[] = [];
    const scope: Record<string, unknown> = {
      tableManager: { getTable: (id: string) => (id === 'T1' ? table : undefined) }, tournamentManager: tm,
      playerSessions, authSessions, reservedSeats, absentSeatMasterIds,
      notifyPlayer: async (to: unknown, type: string, title: string, body: string, opts: any) => { sent.push({ to, type, title, body, opts }); },
      log: { debug: (m: string) => debug.push(m) }, console: { log() {}, warn() {}, error() {} },
    };
    const { exports: m, stubbed } = load(PUSH_SRC, scope, '{ masterUserIdForSeat, notifyBlindLevelUp, blindLevelUpPushes, userIdForSeat }');
    return { tm, tid, table, m, stubbed, sent, debug, authSessions };
  }

  it('each seat resolves to its MASTER uuid in notifyTournamentStart\'s order; AI / unknown / another account\'s socket: null', () => {
    const w = world();
    const ids = Array.from({ length: 9 }, (_, i) => w.m.masterUserIdForSeat('T1', i, w.tid));
    expect(ids).toEqual([U.a, U.b, U.c, U.d, null, U.q, null, U.other, null]);
    // Without the tournament (a cash seat): the session chain only.
    expect(w.m.masterUserIdForSeat('T1', 5)).toBe(U.other);
    expect(w.m.masterUserIdForSeat('T1', 0)).toBe(U.a);
    expect(w.m.masterUserIdForSeat('NOPE', 0)).toBeNull();
    expect([...w.stubbed]).toEqual([]);
  });

  it('notifyBlindLevelUp (BLIND_LEVEL_PUSH_ENABLED=1): every bound human seat with a master id gets it BY MASTER ID (never a number); the rest are skipped with one debug line each', () => {
    const w = world();
    w.m.notifyBlindLevelUp('T1', w.tid, 2);
    expect(w.sent.map((s) => s.to)).toEqual([U.a, U.b, U.c, U.d, U.q]);
    for (const s of w.sent) {
      expect(typeof s.to).toBe('string');
      expect(s.type).toBe('blind_level_up');
      expect(s.title).toBe('Blinds increasing');
      expect(s.body).toBe('Level 2 now in play at Cup — Table 1');
      expect(s.opts).toEqual({ priority: 'normal', metadata: { gameId: 'T1', tournamentId: w.tid, level: 2 } });
    }
    // Seat 4 (nothing known) and seat 6 (another account's socket) — skipped, one debug line each.
    expect(w.debug.map((l) => JSON.parse(l.slice(l.indexOf('{'))).seatIndex)).toEqual([4, 6]);
    expect(w.debug.every((l) => l.includes('blind_level_up_push_skipped_no_master_id'))).toBe(true);
    expect(w.m.blindLevelUpPushes).toEqual({ sent: 5, noMasterId: 2, disabled: 0 });
  });

  it('OFF by default (flag unset) and for any value but exactly "1": nothing sent; disabled counts the would-be pushes', () => {
    for (const flag of [undefined, '0', 'true', '', ' 1']) {
      if (flag === undefined) delete process.env.BLIND_LEVEL_PUSH_ENABLED;
      else process.env.BLIND_LEVEL_PUSH_ENABLED = flag;
      const w = world();
      w.m.notifyBlindLevelUp('T1', w.tid, 2);
      expect(w.sent).toEqual([]);
      expect(w.m.blindLevelUpPushes).toEqual({ sent: 0, noMasterId: 2, disabled: 5 });
      expect([...w.stubbed]).toEqual([]);
    }
  });

  it('CONTROL — the pre-fix fan-out (userIdForSeat) sent the LOCAL integer ids the master cannot use', () => {
    const w = world();
    const local: unknown[] = [];
    for (let i = 0; i < w.table.seats.length; i++) {
      const s = w.table.seats[i];
      if (s.state !== 'occupied' || s.isAI || !s.playerName) continue;
      const uid = w.m.userIdForSeat('T1', i);
      if (uid) local.push(uid);
    }
    expect(local).toEqual([1, 2, 3, 4, 5, 6, 99]);                           // what /internal/notify got (22P02 each)
  });

  it('never throws into the blind-up state machine', () => {
    const w = world();
    w.authSessions.get('SA').masterUserId = undefined;
    Object.defineProperty(w.authSessions.get('SA'), 'statsMasterUserId', { get() { throw new Error('boom'); } });
    expect(() => w.m.notifyBlindLevelUp('T1', w.tid, 3)).not.toThrow();
  });
});

describe('wiring — every notifyPlayer call site sends a master id', () => {
  it('both blindLevelUp listeners call notifyBlindLevelUp; no call site passes a local id', () => {
    const sng = fnSrc('function startTournamentGame(');
    const boot = fnSrc('function bootstrapTournamentTables(');
    expect(sng).toContain('notifyBlindLevelUp(tableId, tournamentId, data?.level ?? 0);');
    expect(boot).toContain('notifyBlindLevelUp(tid, tournamentId, data?.level ?? 0);');
    expect(sng).not.toContain('userIdForSeat(');
    expect(boot).not.toContain('userIdForSeat(');
    const firstArgs = [...SRC.matchAll(/\bnotifyPlayer\(\s*([A-Za-z_$][\w$.]*)/g)].map((x) => x[1]);
    expect(firstArgs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(firstArgs)).toEqual(new Set(['masterId']));
  });
});

describe('startMultiTableTournament — the start push by master id (was auth.userId)', () => {
  function simWorld(auth: any) {
    const tm = new TournamentManager();
    const tables = new Map<string, PokerTable>();
    let n = 0;
    const sent: Sent[] = [];
    const debug: string[] = [];
    const authSessions = new Map<string, any>(auth ? [['HS', auth]] : []);
    const scope: Record<string, unknown> = {
      tournamentManager: tm, tournamentTables: new Map(), fastModeTables: new Map(), playerSessions: new Map(),
      tableManager: {
        createQuickTable: (name: string, max: number, sb: number, bb: number) => {
          const id = `T${++n}`;
          tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: max } as any));
          return id;
        },
        getTable: (id: string) => tables.get(id),
      },
      DEFAULT_BLIND_LEVELS: [{ sb: 10, bb: 20, ante: 0, duration: 300 }], AI_NAMES_POOL: ['Ann', 'Ben', 'Cal', 'Dee', 'Eve'],
      uuidv4: () => `${Math.random().toString(16).slice(2)}00000000`, generateRandomProfile: () => ({}), aiProfiles: new Map(),
      io: { sockets: { sockets: new Map([['HS', { join() {}, emit() {} }]]) } }, detachSocketFromOtherTables() {},
      bootstrapTournamentTables() {}, authSessions, reservedSeats: new Map(), absentSeatMasterIds: new Map(),
      notifyPlayer: async (to: unknown, type: string, title: string, body: string, opts: any) => { sent.push({ to, type, title, body, opts }); },
      log: { debug: (m: string) => debug.push(m) }, console: { log() {}, warn() {}, error() {} },
    };
    const code = [fnSrc('function startMultiTableTournament('), fnSrc('function masterUserIdForSeat(')].join('\n');
    const { exports: m } = load(code, scope, '{ startMultiTableTournament }');
    return { m, sent, debug, tables };
  }

  it('the human\'s MASTER id (attested, else the stats stamp); never auth.userId', async () => {
    for (const [auth, want] of [[{ userId: 42, masterUserId: U.a }, U.a], [{ userId: 42, statsMasterUserId: U.b }, U.b]] as const) {
      const w = simWorld(auth);
      const r = w.m.startMultiTableTournament(4, 'HS', 'human-1', 'Hero');
      await flush();
      expect(r).toBeTruthy();
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0].to).toBe(want);
      expect(w.sent[0].type).toBe('tournament_start');
      expect(w.sent[0].opts.metadata).toEqual(expect.objectContaining({ gameId: 'T1', seatNumber: 0, tableNum: 1 }));
    }
  });

  it('a signed-in human with no master id known: no push, one debug line; no session: nothing (as before)', async () => {
    const w = simWorld({ userId: 42 });
    w.m.startMultiTableTournament(4, 'HS', 'human-1', 'Hero');
    await flush();
    expect(w.sent).toEqual([]);
    expect(w.debug).toHaveLength(1);
    expect(w.debug[0]).toContain('tournament_start_push_skipped_no_master_id');
    const w2 = simWorld(null);
    w2.m.startMultiTableTournament(4, 'HS', 'human-1', 'Hero');
    await flush();
    expect(w2.sent).toEqual([]);
    expect(w2.debug).toEqual([]);
  });
});

jest.mock('../src/logger', () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

describe('notifyClient — master ids only; the master\'s 400 is quiet', () => {
  const realFetch = global.fetch;
  let mod: typeof import('../src/notifyClient');
  let debug: jest.Mock;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    process.env.INTERNAL_NOTIFY_TOKEN = 'x'.repeat(40);
    process.env.POKER_API_URL = 'https://api.test/poker-api';
    jest.isolateModules(() => { mod = require('../src/notifyClient'); debug = require('../src/logger').log.debug; });
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
    delete process.env.INTERNAL_NOTIFY_TOKEN;
    delete process.env.POKER_API_URL;
    jest.restoreAllMocks();
  });

  it('a local integer id (number or string) or junk is refused WITHOUT a request', async () => {
    for (const id of [12345 as any, '12345', 'm:abc', 'user-1', '', ' a9d0d643-0000-4000-8000-00000000000a']) {
      await mod.notifyPlayer(id, 'blind_level_up', 't', 'b');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.notifyClientStats()).toEqual({ posted: 0, accepted: 0, skippedNotMasterId: 5, rejected: 0, failed: 0 });   // '' is the old silent no-op
    expect(debug).toHaveBeenCalledTimes(5);                                   // one debug line each, no id echoed
    expect(debug.mock.calls.every(([l]) => String(l).includes('notify_skipped_not_master_id') && !String(l).includes('12345'))).toBe(true);
  });

  it('every spelling Postgres reads as a uuid is posted as given (the master canonicalises it)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    const ids = [U.a, U.a.toUpperCase(), U.a.replace(/-/g, ''), `{${U.a}}`];
    for (const id of ids) await mod.notifyPlayer(id, 'blind_level_up', 'Blinds increasing', 'Level 2', { priority: 'normal', metadata: { level: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/poker-api/internal/notify');
    expect(init.headers['X-Internal-Token']).toBe('x'.repeat(40));
    expect(JSON.parse(init.body)).toEqual({ userId: U.a, eventType: 'blind_level_up', title: 'Blinds increasing', body: 'Level 2', priority: 'normal', metadata: { level: 2 } });
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).userId)).toEqual(ids);
    expect(mod.notifyClientStats()).toMatchObject({ posted: 4, accepted: 4 });
  });

  it('the master\'s 400 invalid_user_id: resolved quietly — no throw, no retry, no warn; counted', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ success: false, code: 'invalid_user_id' }) });
    await expect(mod.notifyPlayer(U.a, 'blind_level_up', 't', 'b')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][0])).toContain('notify_rejected_400');
    expect(mod.notifyClientStats()).toMatchObject({ posted: 1, accepted: 0, rejected: 1, failed: 0 });
  });

  it('a 5xx / network error never throws either (fire-and-forget, as before)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }).mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(mod.notifyPlayer(U.a, 'x', 't', 'b')).resolves.toBeUndefined();
    await expect(mod.notifyPlayer(U.a, 'x', 't', 'b')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);                                    // the network error, as before
    expect(mod.notifyClientStats()).toMatchObject({ posted: 2, failed: 2, rejected: 0 });
  });

  it('no token configured: the old silent no-op', async () => {
    delete process.env.INTERNAL_NOTIFY_TOKEN;
    let bare!: typeof import('../src/notifyClient');
    jest.isolateModules(() => { bare = require('../src/notifyClient'); });
    await bare.notifyPlayer(U.a, 'x', 't', 'b');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isMasterUserId mirrors the master\'s PG_UUID_RE', () => {
    expect(mod.isMasterUserId(U.a)).toBe(true);
    expect(mod.isMasterUserId('a9d0-d643-0000-4000-8000-0000-0000-000a')).toBe(true);   // a hyphen after any group of 4
    expect(mod.isMasterUserId('a9d0d643--0000-4000-8000-00000000000a')).toBe(false);
    expect(mod.isMasterUserId('{a9d0d643-0000-4000-8000-00000000000a')).toBe(false);
    expect(mod.isMasterUserId(123)).toBe(false);
    expect(mod.isMasterUserId(masterIdFromStats(JSON.stringify({ masterUserId: U.b })))).toBe(true);
  });
});

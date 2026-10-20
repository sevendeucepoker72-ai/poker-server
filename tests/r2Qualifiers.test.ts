/**
 * R2 (2026-10-11, S1) — online qualifiers from the MASTER schedule (contract C3;
 * TOURNEY-2 / TOURNEY-3 / TOURNEY-13 / AUTH-9 / APPUI-44 server half).
 *
 * Before: the schedule sync read `body.schedule` while the master answers
 * `{ success, data: { schedule } }` — the registry was always EMPTY, so the
 * first Register created a FAKE event 7 days out ("Signup opens in 165h"; 0
 * registrations in 30 days for 637 qualified players). The registry was per
 * TYPE, never 'finished'; a late entry consumed a credit and was never seated;
 * registrations were keyed on the login handle / a client-sent phone (another
 * player could unregister you); the server ran 10/20 blinds on a 50,000 stack
 * while the lobby advertised 15 levels of 20 minutes; the Game Over screen said
 * "<winner> wins 0 chips". Now: one registry entry per MASTER qualifier, only
 * what the master lists, seat-or-refund late entry, the master account as the
 * key, the structure the server runs, `myResult {place, wonSeat}` per socket.
 *
 * Everything runs the REAL src/index.ts source (sliced + transpiled) with the
 * REAL TournamentManager / PokerTable and the pure qualifierSchedule module.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import {
  parseMasterSchedule, qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, qualifierBlindLevels,
  QUALIFIER_BASE_STACK,
} from '../src/game/qualifierSchedule';
import { SRC, slice, fnSrc, handlerSrc, load, flush } from './helpers/indexSource';

// The master's REAL answer (captured from prod 2026-10-11, read-only): one weekly event + a TOC with no time.
const MASTER_BODY = {
  success: true,
  data: {
    schedule: [
      { id: '0e10e632-5a4c-4d0d-a5e9-b785266149fb', name: 'Weekly Qualifier — 2026-10-05', type: 'weekly', clientQualifierId: 'weekly-qualifier', scheduledAt: '2026-10-11T12:00:00.000Z', weekStarting: '2026-10-05T00:00:00.000Z', status: 'open' },
      { id: '9dd976d7-5e97-4a52-9c54-52935814f430', name: 'Tournament of Champions — 2026', type: 'toc', clientQualifierId: '9dd976d7-5e97-4a52-9c54-52935814f430', scheduledAt: null, weekStarting: '2026-01-01T00:00:00.000Z', status: 'open' },
    ],
  },
};
const WEEKLY = '0e10e632-5a4c-4d0d-a5e9-b785266149fb';
const H = 3600_000;

describe('qualifierSchedule (pure)', () => {
  it('reads the master\'s REAL shape (data.schedule); an event with no time is not playable online', () => {
    const list = parseMasterSchedule(MASTER_BODY);
    expect(list).toEqual([{
      id: WEEKLY, name: 'Weekly Qualifier — 2026-10-05', type: 'weekly', clientQualifierId: 'weekly-qualifier',
      scheduledAt: Date.parse('2026-10-11T12:00:00.000Z'), status: 'open',
    }]);
    expect(parseMasterSchedule({ schedule: MASTER_BODY.data.schedule })).toHaveLength(1);   // a bare {schedule} too
    expect(parseMasterSchedule(null)).toEqual([]);
  });

  it('CONTROL — the pre-R2 read (`body.schedule`) finds NOTHING in that answer: the registry stayed empty', () => {
    expect((MASTER_BODY as any).schedule).toBeUndefined();
  });

  it('windows: signup opens 3h before, closes (late registration included) 90 min after; status from them', () => {
    const at = Date.parse('2026-10-11T12:00:00.000Z');
    expect(qualifierWindows(at)).toEqual({ signupOpensAt: at - 3 * H, signupClosesAt: at + 1.5 * H, lateRegUntil: at + 1.5 * H });
    expect(qualifierStatusOf('pending', at, at - 4 * H)).toBe('scheduled');
    expect(qualifierStatusOf('pending', at, at - 2 * H)).toBe('registering');
    expect(qualifierStatusOf('running', at, at + H)).toBe('running');
    expect(qualifierStatusOf('finished', at, at)).toBe('finished');
  });

  it('seats for the top: the master\'s rules (weekly top 3, monthly top 6, TOC winner)', () => {
    expect([seatsForTopOf('weekly'), seatsForTopOf('console_weekly'), seatsForTopOf('monthly'), seatsForTopOf('console_monthly'), seatsForTopOf('toc'), seatsForTopOf('x')])
      .toEqual([3, 3, 6, 6, 1, 0]);
  });

  it('the structure the server RUNS: the 15 advertised levels for 50,000 (12 minutes each since 2026-10-20, owner "about 4-5 hours"), then continued to a big blind of four stacks; scaled to the real stack', () => {
    const s = qualifierStructure(QUALIFIER_BASE_STACK);
    expect(s.startingStack).toBe(50_000);
    expect(s.levels.slice(0, 3)).toEqual([{ sb: 25, bb: 50, ante: 0, minutes: 12 }, { sb: 50, bb: 100, ante: 0, minutes: 12 }, { sb: 75, bb: 150, ante: 25, minutes: 12 }]);
    expect(s.levels[14]).toEqual({ sb: 3000, bb: 6000, ante: 1000, minutes: 12 });
    expect(s.levels[s.levels.length - 1].bb).toBe(4 * 50_000);
    for (const l of s.levels) { expect(l.bb).toBeGreaterThanOrEqual(2 * l.sb); expect(l.minutes).toBe(12); }
    expect(qualifierStructure(10_000).levels[0]).toEqual({ sb: 5, bb: 10, ante: 0, minutes: 12 });
    expect(qualifierBlindLevels(50_000)[0]).toEqual({ sb: 25, bb: 50, ante: 0, duration: 720 });
  });
});

// ─────────────────────────── the real index.ts paths ───────────────────────────
const CODE = [
  fnSrc('function applyQualifierSchedule('),
  fnSrc('function qualifierEventFor('),
  fnSrc('function qualifierListItem('),
  fnSrc('function qualifierList('),
  fnSrc('function releaseQualifierRegistration('),
  fnSrc('function socketsOfMaster('),
  slice('/** R2 (TOURNEY-9) — the answer when a qualifier seat would take over', '\n  return null;\n}\n'),
  slice('const qualifierCancellations = { cancelled: 0, creditsRefunded: 0 };', '\n}\n'),
  fnSrc('function markQualifierFinished('),
  fnSrc('function qualifierOfTournament('),
  fnSrc('function qualifierResultOf('),
  fnSrc('function pruneFinishedQualifiers('),
  fnSrc('function tickQualifierAutoStart('),
  slice('const postedQualifierResults = new Set<string>();', '\n}\n'),
  fnSrc('function emitTournamentFinishedToEntrants('),
  fnSrc('function socketPlaysLiveSeatElsewhere('),
  fnSrc('function tournamentEntrantPlayerId('),
  slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n'),
  // 2026-10-20 — late entry / re-entry take a busted seat (the rebalance's rule).
  fnSrc('function tournamentLiveSeatIndex('),
  fnSrc('function tournamentLiveSeatOf('),
  fnSrc('function tournamentSeatIsPlaceable('),
  fnSrc('function vacateBustedTournamentSeat('),
].join('\n');
const HANDLERS = ['registerQualifierTournament', 'unregisterQualifierTournament', 'getQualifierTournaments', 'spectateTournament']
  .map((ev) => handlerSrc(ev, '\n  });\n')).join('\n  ');

const ALICE = 101;
const BOB = 102;

function world(opts: { now?: number } = {}) {
  const qualifierTournaments = new Map<string, any>();
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const spectators = new Map<string, Set<string>>();
  const sockets = new Map<string, any>();
  const globalEmits: Array<[string, any]> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const consumed: Array<{ masterId: string; tier: string; label: string }> = [];
  const creditRefunds: string[] = [];
  const fetches: Array<{ url: string; method: string; body: any }> = [];
  const postAnswers: Array<{ ok: boolean; status: number }> = [];
  const progress: string[] = [];
  const started: Array<{ players: any[]; stack: number }> = [];
  const wallet = new Map<number, number>([[ALICE, 100_000], [BOB, 100_000]]);
  const tournamentTables = new Map<string, string>();
  const leaves: string[] = [];
  let creditN = 0;
  const scope: Record<string, unknown> = {
    qualifierTournaments, tournamentManager: tm, authSessions, playerSessions, multiTableSessions, spectators,
    tableManager: { getTable: (id: string) => tables.get(id) },
    io: {
      emit: (ev: string, d: any) => globalEmits.push([ev, d]),
      to: (room: string) => ({ emit: (ev: string, d: any) => roomEmits.push([room, ev, d]) }),
      sockets: { sockets },
    },
    qualifierSyncStats: { syncs: 0, failures: 0, lastSyncAt: null, listed: 0, cancelledOffSchedule: 0 },
    qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, QUALIFIER_BASE_STACK,
    assertPlayable: async () => null,
    isPlayerQualified: async () => true,
    consumeQualifierCreditOnMaster: async (masterId: string, tier: string, _q: string, label: string) => {
      consumed.push({ masterId, tier, label });
      return { consumed: true, creditId: `credit-${++creditN}` };
    },
    refundQualifierCreditOnMaster: async (id: string) => { creditRefunds.push(id); return true; },
    realClientIp: (s: any) => s.ip || '10.0.0.1',
    seatNameForSocket: (s: any) => authSessions.get(s.id)?.displayName || 'Player',
    progressionManager: { getOrCreateProgress: (pid: string) => { progress.push(pid); } },
    publicNameOf: (n: unknown) => String(n ?? 'Player'),
    detachSocketFromOtherTables() {}, broadcastGameState() {},
    startQualifierTournament: (players: any[], stack: number) => { started.push({ players, stack }); return { tournamentId: 'TQ', tableIds: ['Q9'], tableCount: 1 }; },
    noteFinishedTournament: () => ({ finishedAt: Date.now(), entrants: [] }),
    finishedEntrantIsAccount: () => false,
    tournamentFinishedNotices: { roomBroadcasts: 0, entrantSockets: 0 },
    ensureChipsForBuyIn: async (uid: number) => wallet.get(uid) ?? 0,
    deductChips: async (uid: number, a: number) => { const h = wallet.get(uid) ?? 0; if (h < a) return false; wallet.set(uid, h - a); return true; },
    addChipsToUser: async (uid: number, a: number) => { wallet.set(uid, (wallet.get(uid) ?? 0) + a); return true; },
    auditLog: (actor: string, action: string, d: any) => audits.push({ actor, action, d }),
    PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED', lastQualifierFetch: 1,
    process: { env: { INTERNAL_NOTIFY_TOKEN: 't', MASTER_API_URL: 'https://master.test' } },
    fetch: async (url: string, init: any) => {
      fetches.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
      if (/results\/internal$/.test(url)) return postAnswers.shift() ?? { ok: true, status: 200 };
      return { ok: true, status: 200, json: async () => ({}) };
    },
    uuidv4: () => `u${Math.random().toString(36).slice(2, 10)}`,
    console: { log() {}, warn() {}, error() {} },
    // 2026-10-20 — the busted-seat helpers' world + Watch Live.
    MAX_SEATS: 9, reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(),
    syncSitOutToTable() {}, tournamentHandStartSafety: { bustedSeatsVacated: 0 }, tournamentTables,
    handlePlayerLeave: (sock: any) => { leaves.push(sock.id); },
    getGameStateForPlayer: () => ({}), emitGameState() {},
  };
  const { exports: m } = load(`${CODE}\nfunction wire(socket) {\n  ${HANDLERS}\n}`, scope, `{
    wire, applyQualifierSchedule, qualifierList, qualifierEventFor, markQualifierFinished, emitTournamentFinishedToEntrants,
    tickQualifierAutoStart, postQualifierResults, cancelQualifierEvent, qualifierLateEntries, qualifierResultPosts,
  }`);
  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (id: string, userId: number | null, master: string | null, name = 'Player') => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id, connected: true, handlers, rooms: new Set<string>(), ip: `10.0.0.${sockets.size + 2}`,
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      emit: (ev: string, p: any) => emitted.push([id, ev, p]),
      join(r: string) { s.rooms.add(r); }, leave(r: string) { s.rooms.delete(r); },
    };
    sockets.set(id, s);
    if (userId !== null) authSessions.set(id, { userId, username: `${name.toLowerCase()}.x`, masterUserId: master ?? undefined, displayName: name });
    m.wire(s);
    return s;
  };
  const of = (sid: string, ev: string) => emitted.filter(([s, e]) => s === sid && e === ev).map(([, , p]) => p);
  /** The real master answer with the weekly event moved to `at` (ms). */
  const sync = (at: number, now: number = opts.now ?? Date.now()) => {
    const body = JSON.parse(JSON.stringify(MASTER_BODY));
    body.data.schedule[0].scheduledAt = new Date(at).toISOString();
    m.applyQualifierSchedule(parseMasterSchedule(body), now);
  };
  return {
    m, tm, tables, scope, qualifierTournaments, authSessions, playerSessions, sockets, emitted, globalEmits, roomEmits, audits,
    consumed, creditRefunds, fetches, postAnswers, progress, started, wallet, mkSocket, of, sync, tournamentTables, leaves,
  };
}

describe('C3 — the registry is the master schedule (one entry per master qualifier)', () => {
  it('the real answer → ONE entry keyed by its master id, registering; a re-sync keeps one entry and follows a moved start', () => {
    const w = world();
    const at = Date.now() + 2 * H;
    w.sync(at);
    expect([...w.qualifierTournaments.keys()]).toEqual([WEEKLY]);
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ masterQualifierId: WEEKLY, clientQualifierId: 'weekly-qualifier', qualifierType: 'weekly', status: 'registering', startingStack: 50_000 });
    w.sync(at + H);
    expect(w.qualifierTournaments.size).toBe(1);
    expect(w.qualifierTournaments.get(WEEKLY).scheduledAt).toBe(new Date(at + H).toISOString());
  });

  it('the C3 list item: exactly the contract fields (players a NUMBER, the structure it runs, seatsForTop) — no names, no phones', () => {
    const w = world();
    const at = Date.now() + 2 * H;
    w.sync(at);
    const [item] = w.m.qualifierList(null);
    expect(item).toMatchObject({
      qualifierId: WEEKLY, masterQualifierId: WEEKLY, type: 'weekly', scheduledAt: new Date(at).toISOString(),
      signupOpensAt: new Date(at - 3 * H).toISOString(), signupClosesAt: new Date(at + 1.5 * H).toISOString(),
      lateRegUntil: new Date(at + 1.5 * H).toISOString(), status: 'registering', registered: false, players: 0,
      structure: qualifierStructure(50_000), seatsForTop: 3, myResult: null,
    });
    w.sync(Date.now() + 5 * H);
    expect(w.m.qualifierList(null)[0].status).toBe('scheduled');          // signup not open yet: never assumed open
  });

  it('an event dropped from the schedule before its start is CANCELLED: every consumed credit refunded, the registrant told', async () => {
    const w = world();
    w.sync(Date.now() + H);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    w.m.applyQualifierSchedule([], Date.now());
    await flush();
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.of('SA', 'qualifierCancelled')).toEqual([{ qualifierId: WEEKLY, reason: 'removed_from_schedule', creditRefunded: true }]);
    expect(w.fetches.filter((f) => f.method === 'DELETE').map((f) => f.body)).toEqual([{ userId: 'm-alice' }]);
  });

  it('a brand-new event whose late registration already ended is not opened', () => {
    const w = world();
    w.sync(Date.now() - 2 * H);
    expect(w.qualifierTournaments.size).toBe(0);
  });
});

describe('registerQualifierTournament — only listed events, the master account, seat-or-refund', () => {
  it('an id the schedule does not list is refused (qualifier_not_found) — nothing is invented', async () => {
    const w = world();
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: 'weekly-qualifier', playerName: 'Alice' });
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: false, code: 'qualifier_not_found' })]);
    expect(w.qualifierTournaments.size).toBe(0);
    expect(w.consumed).toEqual([]);
    expect(handlerSrc('registerQualifierTournament', '\n  });\n')).not.toContain('7 * 86400000');
  });

  it('signup not open yet → signup_not_open (+ when it opens), no credit touched', async () => {
    const w = world();
    const at = Date.now() + 5 * H;
    w.sync(at);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: false, code: 'signup_not_open', signupOpensAt: new Date(at - 3 * H).toISOString() })]);
    expect(w.consumed).toEqual([]);
  });

  it('by the lobby catalog key too; the entry is the MASTER account\'s (stable entrant id, progression), one credit, a NUMBER broadcast', async () => {
    const w = world();
    w.sync(Date.now() + H);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: 'weekly-qualifier', playerName: 'Mallory', phone: '5550000' });
    const qt = w.qualifierTournaments.get(WEEKLY);
    expect(qt.players).toEqual([expect.objectContaining({ playerId: 'user-101', masterPlayerId: 'm-alice', localUserId: ALICE, playerName: 'Alice', phone: '', consumedCreditId: 'credit-1' })]);
    expect(w.consumed).toEqual([{ masterId: 'm-alice', tier: 'weekly', label: 'entry' }]);
    expect(w.progress).toEqual(['user-101']);
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([{ success: true, qualifierId: WEEKLY, registered: true, registeredCount: 1 }]);
    expect(w.globalEmits.filter(([ev]) => ev === 'qualifierTournamentUpdate').map(([, d]) => d)).toEqual([
      { qualifierId: WEEKLY, status: 'registering', registeredCount: 1, players: 1, tournamentId: null },
    ]);
    expect(w.fetches.filter((f) => f.method === 'POST').map((f) => [f.url, f.body])).toEqual([[`https://master.test/qualifiers/${WEEKLY}/register/internal`, { userId: 'm-alice' }]]);
  });

  it('the same account on a second tab → already_registered, no second credit', async () => {
    const w = world();
    w.sync(Date.now() + H);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await a2.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(w.of('SA2', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: false, code: 'already_registered', registered: true })]);
    expect(w.consumed).toHaveLength(1);
  });

  it('two taps at once (both pass the check before either consumes): ONE entry, the second credit goes back', async () => {
    const w = world();
    w.sync(Date.now() + H);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    await Promise.all([
      a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' }),
      a2.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' }),
    ]);
    expect(w.qualifierTournaments.get(WEEKLY).players).toHaveLength(1);
    expect(w.consumed).toHaveLength(2);
    expect(w.creditRefunds).toEqual(['credit-2']);
    expect(w.audits.find((x) => x.action === 'QUALIFIER_ENTRY_CREDIT_REFUND')?.d).toMatchObject({ creditId: 'credit-2', reason: 'already_registered' });
  });

  it('AUTH-9 — another account (same name, same login handle) cannot unregister her; her own unregister refunds her credit and drops the master row', async () => {
    const w = world();
    w.sync(Date.now() + H);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const b = w.mkSocket('SB', BOB, 'm-bob', 'Alice');                 // display name + handle 'alice.x' too
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await b.handlers.unregisterQualifierTournament({ qualifierId: WEEKLY });
    expect(w.qualifierTournaments.get(WEEKLY).players).toHaveLength(1);
    expect(w.of('SB', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, unregistered: true, registered: false, registeredCount: 1 })]);
    await a.handlers.unregisterQualifierTournament({ qualifierId: WEEKLY });
    await flush();
    expect(w.qualifierTournaments.get(WEEKLY).players).toEqual([]);
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.fetches.filter((f) => f.method === 'DELETE').map((f) => f.body)).toEqual([{ userId: 'm-alice' }]);
  });

  it('getQualifierTournaments: `registered` for the ASKING account (the lobby knows its own registration after a reload)', async () => {
    const w = world();
    w.sync(Date.now() + H);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const b = w.mkSocket('SB', BOB, 'm-bob', 'Bob');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await a.handlers.getQualifierTournaments();
    await b.handlers.getQualifierTournaments();
    expect(w.of('SA', 'qualifierTournamentList')[0][0]).toMatchObject({ registered: true, players: 1 });
    expect(w.of('SB', 'qualifierTournamentList')[0][0]).toMatchObject({ registered: false, players: 1 });
    expect(JSON.stringify(w.of('SB', 'qualifierTournamentList'))).not.toMatch(/Alice|alice|m-alice/);
  });
});

describe('late entry into a RUNNING qualifier — seated at once or the credit goes back (TOURNEY-3), never over a live seat elsewhere (TOURNEY-9)', () => {
  function running(seatsFree = true) {
    const w = world();
    w.sync(Date.now() - 10 * 60_000);
    // sync does not open a past event that ended; this one is inside its late window → listed.
    const qt = w.qualifierTournaments.get(WEEKLY);
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 2, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    w.tm.registerPlayer(tid, 'user-201', 'Bob', 'sb', undefined, 'm-201');
    w.tm.registerPlayer(tid, 'user-202', 'Carl', 'sc', undefined, 'm-202');
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    if (!seatsFree) t.maxOccupiableSeats = 2;                                // a full (heads-up) table
    t.sitDown(0, 'Bob', 50_000, 'user-201', false, true);
    t.sitDown(1, 'Carl', 50_000, 'user-202', false, true);
    w.tables.set('Q1', t);
    w.tm.setTableIds(tid, ['Q1']);
    w.tm.setPlayerTable(tid, 'user-201', 'Q1');
    w.tm.setPlayerTable(tid, 'user-202', 'Q1');
    Object.assign(qt, {
      status: 'running', tournamentId: tid,
      players: [
        { playerId: 'user-201', masterPlayerId: 'm-201', playerName: 'Bob', phone: '', socketId: 'sb' },
        { playerId: 'user-202', masterPlayerId: 'm-202', playerName: 'Carl', phone: '', socketId: 'sc' },
      ],
    });
    return { w, tid, t, qt };
  }

  it('seated NOW: a new entrant with the starting stack, his session bound, told like a start (qualifierTournamentStarted)', async () => {
    const { w, tid, t, qt } = running();
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    const seat = t.seats.findIndex((s) => s.state === 'occupied' && s.playerId === 'user-101');
    expect(seat).toBeGreaterThanOrEqual(2);
    expect(t.seats[seat].chipCount).toBe(50_000);
    expect(w.tm.getTournament(tid)!.players.find((p) => p.playerId === 'user-101')).toMatchObject({ masterUserId: 'm-alice', eliminated: false });
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'Q1', seatIndex: seat, playerId: 'user-101' });
    expect(a.rooms.has('table:Q1')).toBe(true);
    expect(qt.players.map((p: any) => p.playerId)).toEqual(['user-201', 'user-202', 'user-101']);
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, lateEntry: true, tableId: 'Q1', tournamentId: tid })]);
    expect(w.of('SA', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({ qualifierId: WEEKLY, tournamentId: tid, tableId: 'Q1', lateEntry: true })]);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.qualifierLateEntries.seated).toBe(1);
  });

  it('no seat free → the consumed credit goes back (no_seat) and he is NOT in the field', async () => {
    const { w, tid, qt } = running(false);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(qt.players).toHaveLength(2);
    expect(w.tm.getTournament(tid)!.players).toHaveLength(2);
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: false, code: 'no_seat' })]);
  });

  // 2026-10-20 — a FULL field: every seat was taken at the start; one entrant
  // has busted (his seat stays occupied at 0 chips). The late entrant takes that
  // seat — it used to be "no_seat" and the credit went back.
  it('a full table with a BUSTED seat: the late entrant is seated there (the busted entrant becomes a spectator)', async () => {
    const w = world();
    w.sync(Date.now() - 10 * 60_000);
    const qt = w.qualifierTournaments.get(WEEKLY);
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 3, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    for (const [id, n, sid] of [['user-201', 'Bob', 'sb'], ['user-202', 'Carl', 'sc'], ['user-203', 'Dan', 'sd']]) w.tm.registerPlayer(tid, id, n, sid, undefined, `m-${id.slice(5)}`);
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    t.maxOccupiableSeats = 3;                                                  // every seat taken at the start
    t.sitDown(0, 'Bob', 50_000, 'user-201', false, true);
    t.sitDown(1, 'Carl', 50_000, 'user-202', false, true);
    t.sitDown(2, 'Dan', 50_000, 'user-203', false, true);
    w.tables.set('Q1', t);
    w.tm.setTableIds(tid, ['Q1']);
    for (const id of ['user-201', 'user-202', 'user-203']) w.tm.setPlayerTable(tid, id, 'Q1');
    Object.assign(qt, { status: 'running', tournamentId: tid, players: [
      { playerId: 'user-201', masterPlayerId: 'm-201', playerName: 'Bob', phone: '', socketId: 'sb' },
      { playerId: 'user-202', masterPlayerId: 'm-202', playerName: 'Carl', phone: '', socketId: 'sc' },
      { playerId: 'user-203', masterPlayerId: 'm-203', playerName: 'Dan', phone: '', socketId: 'sd' },
    ] });
    // Carl busts: 0 chips, eliminated, his seat still occupied; his socket's session still points at it.
    w.tm.eliminatePlayer(tid, 'user-202');
    t.seats[1].chipCount = 0;
    (t.seats[1] as any).eliminated = true;
    w.mkSocket('sc', 202, 'm-202', 'Carl');
    w.playerSessions.set('sc', { socketId: 'sc', tableId: 'Q1', seatIndex: 1, playerName: 'Carl', playerId: 'user-202' });
    expect(w.tm.getTournament(tid)!.status).toBe('running');

    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(t.seats[1]).toMatchObject({ state: 'occupied', playerId: 'user-101', chipCount: 50_000 });
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'Q1', seatIndex: 1, playerId: 'user-101' });
    expect(w.playerSessions.has('sc')).toBe(false);                            // Carl's dead session ended
    expect(w.scope.spectators && (w.scope.spectators as Map<string, Set<string>>).get('Q1')?.has('sc')).toBe(true);
    expect(w.creditRefunds).toEqual([]);
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, lateEntry: true, tableId: 'Q1' })]);
    // Live seats are never taken.
    expect(t.seats[0]).toMatchObject({ playerId: 'user-201', chipCount: 50_000 });
    expect(t.seats[2]).toMatchObject({ playerId: 'user-203', chipCount: 50_000 });
  });

  it('Watch Live from a socket that PLAYS a live seat in that tournament: refused, the seat untouched (it used to stand him up)', async () => {
    const { w, tid } = running();
    w.tournamentTables.set('Q1', tid);
    const b = w.mkSocket('sb', 201, 'm-201', 'Bob');
    const bobSession = { socketId: 'sb', tableId: 'Q1', seatIndex: 0, playerName: 'Bob', playerId: 'user-201' };
    w.playerSessions.set('sb', bobSession);
    await b.handlers.spectateTournament({ tournamentId: tid });
    expect(w.leaves).toEqual([]);
    expect(w.playerSessions.get('sb')).toBe(bobSession);
    expect(w.of('sb', 'error')).toEqual([expect.objectContaining({ code: 'playing_in_tournament' })]);
    expect(w.of('sb', 'spectatingTournament')).toEqual([]);
    // CONTROL — a socket with no seat there watches as before.
    const x = w.mkSocket('SX', ALICE, 'm-alice', 'Alice');
    await x.handlers.spectateTournament({ tournamentId: tid });
    expect(w.of('SX', 'spectatingTournament')).toEqual([expect.objectContaining({ tournamentId: tid, tableId: 'Q1' })]);
  });

  it('TOURNEY-9 — his socket plays a live cash seat: refused already_seated BEFORE any credit; the cash session untouched', async () => {
    const { w } = running();
    const cash = new PokerTable({ tableId: 'cash1', tableName: 'cash1', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10_000, maxPlayers: 9 } as any);
    cash.sitDown(3, 'Alice', 4000, 'p-cash', false);
    w.tables.set('cash1', cash);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const cashSession = { socketId: 'SA', tableId: 'cash1', seatIndex: 3, playerName: 'Alice', playerId: 'p-cash' };
    w.playerSessions.set('SA', cashSession);
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: false, code: 'already_seated' })]);
    expect(w.consumed).toEqual([]);
    expect(w.playerSessions.get('SA')).toBe(cashSession);
  });

  it('TOURNEY-9 — a busted entrant\'s RE-ENTRY from a socket that plays a live cash seat: refused before the buy-in or the credit', async () => {
    const { w, tid, qt } = running();
    // Alice entered (3-handed) and busted; the tournament runs on.
    w.tm.addLateEntrant(tid, 'user-101', 'Alice', 'old', 50_000, { masterUserId: 'm-alice' });
    qt.players.push({ playerId: 'user-101', masterPlayerId: 'm-alice', playerName: 'Alice', phone: '', socketId: 'old', reEntries: 0 });
    qt.buyIn = 1000;
    w.tm.eliminatePlayer(tid, 'user-101');
    expect(w.tm.getTournament(tid)!.status).toBe('running');
    const cash = new PokerTable({ tableId: 'cash1', tableName: 'cash1', smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10_000, maxPlayers: 9 } as any);
    cash.sitDown(3, 'Alice', 4000, 'p-cash', false);
    w.tables.set('cash1', cash);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    w.playerSessions.set('SA', { socketId: 'SA', tableId: 'cash1', seatIndex: 3, playerName: 'Alice', playerId: 'p-cash' });
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: false, code: 'already_seated' })]);
    expect(w.wallet.get(ALICE)).toBe(100_000);
    expect(w.consumed).toEqual([]);
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'cash1', seatIndex: 3 });
  });
});

describe('the qualifier lifecycle — started, cancelled for too few players, finished with each finisher\'s place + seat', () => {
  it('at its time with fewer than 2 players it WAITS; still short after late registration → cancelled, credits refunded', async () => {
    const w = world();
    const at = Date.now() + H;
    w.sync(at);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    w.m.tickQualifierAutoStart(at + 60_000);
    expect(w.qualifierTournaments.get(WEEKLY).status).toBe('registering');
    w.m.tickQualifierAutoStart(at + 1.5 * H + 1);
    await flush();
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.of('SA', 'qualifierCancelled')).toEqual([{ qualifierId: WEEKLY, reason: 'too_few_players', creditRefunded: true }]);
    expect(w.started).toEqual([]);
  });

  it('two players at its time → started with the 50,000 stack and the master ids', async () => {
    const w = world();
    const at = Date.now() + H;
    w.sync(at);
    await w.mkSocket('SA', ALICE, 'm-alice', 'Alice').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await w.mkSocket('SB', BOB, 'm-bob', 'Bob').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Bob' });
    w.m.tickQualifierAutoStart(at);
    expect(w.started).toEqual([{ stack: 50_000, players: [
      expect.objectContaining({ id: 'user-101', masterId: 'm-alice' }), expect.objectContaining({ id: 'user-102', masterId: 'm-bob' }),
    ] }]);
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'running', tournamentId: 'TQ' });
  });

  it('the start signal tells each registrant whether THIS socket is seated (the client takes him to his table)', async () => {
    const w = world();
    const at = Date.now() + H;
    w.sync(at);
    await w.mkSocket('SA', ALICE, 'm-alice', 'Alice').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await w.mkSocket('SB', BOB, 'm-bob', 'Bob').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Bob' });
    // A real tournament: Alice's socket is bound to her seat, Bob's seat is
    // kept absent (his socket plays elsewhere — no session at Q9).
    w.scope.startQualifierTournament = (players: any[]) => {
      const id = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 2, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
      for (const p of players) w.tm.registerPlayer(id, p.id, p.name, p.socketId, undefined, p.masterId);
      w.tm.startTournament(id);
      w.tm.setTableIds(id, ['Q9']);
      for (const p of players) w.tm.setPlayerTable(id, p.id, 'Q9');
      w.playerSessions.set('SA', { socketId: 'SA', tableId: 'Q9', seatIndex: 0, playerName: 'Alice', playerId: players[0].id });
      return { tournamentId: id, tableIds: ['Q9'], tableCount: 1 };
    };
    w.m.tickQualifierAutoStart(at);
    expect(w.of('SA', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({ qualifierId: WEEKLY, tableId: 'Q9', seated: true })]);
    expect(w.of('SB', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({ qualifierId: WEEKLY, tableId: 'Q9', seated: false })]);
  });

  function finished() {
    const w = world();
    w.sync(Date.now() + H);
    const qt = w.qualifierTournaments.get(WEEKLY);
    Object.assign(qt, {
      status: 'running', tournamentId: 'TQ',
      players: ['a', 'b', 'c', 'd'].map((x, i) => ({ playerId: `user-${300 + i}`, masterPlayerId: `m-${x}`, playerName: x.toUpperCase(), phone: '', socketId: `S${x}` })),
    });
    const data = {
      tournamentId: 'TQ',
      results: [
        { playerId: 'user-300', playerName: 'A', position: 1, payout: 0 }, { playerId: 'user-301', playerName: 'B', position: 2, payout: 0 },
        { playerId: 'user-302', playerName: 'C', position: 3, payout: 0 }, { playerId: 'user-303', playerName: 'D', position: 4, payout: 0 },
      ],
    };
    return { w, qt, data };
  }

  it('FINISHED: each finisher\'s place + wonSeat (weekly: top 3), myResult to each registrant, the list shows the asker\'s own result', () => {
    const { w, qt, data } = finished();
    const sd = w.mkSocket('Sd', 303, 'm-d', 'D');
    const sa = w.mkSocket('Sa', 300, 'm-a', 'A');
    w.m.markQualifierFinished('TQ', data);
    expect(qt.status).toBe('finished');
    expect(w.of('Sa', 'qualifierResults')[0]).toMatchObject({ qualifierId: WEEKLY, myResult: { place: 1, wonSeat: true }, place: 1, wonSeat: true, seatsForTop: 3 });
    expect(w.of('Sd', 'qualifierResults')[0]).toMatchObject({ myResult: { place: 4, wonSeat: false }, wonSeat: false });
    expect(w.of('Sd', 'qualifierResults')[0].results.map((r: any) => [r.place, r.wonSeat])).toEqual([[1, true], [2, true], [3, true], [4, false]]);
    expect(w.m.qualifierList('m-c')[0]).toMatchObject({ status: 'finished', myResult: { place: 3, wonSeat: true } });
    void sd; void sa;
  });

  it('the room\'s tournamentFinished carries EACH socket\'s own myResult (one frame per socket) — never "wins 0 chips"', () => {
    const { w, data } = finished();
    const sa = w.mkSocket('Sa', 300, 'm-a', 'A'); sa.join('table:Q1');
    const sd = w.mkSocket('Sd', 303, 'm-d', 'D'); sd.join('table:Q1');
    const spec = w.mkSocket('Sx', null, null); spec.join('table:Q1');
    w.m.markQualifierFinished('TQ', data);
    w.m.emitTournamentFinishedToEntrants('TQ', ['Q1'], data);
    expect(w.of('Sa', 'tournamentFinished')).toEqual([expect.objectContaining({ tournamentId: 'TQ', results: data.results, isQualifier: true, qualifierId: WEEKLY, seatsForTop: 3, myResult: { place: 1, wonSeat: true }, place: 1, wonSeat: true })]);
    expect(w.of('Sd', 'tournamentFinished')).toEqual([expect.objectContaining({ myResult: { place: 4, wonSeat: false }, place: 4, wonSeat: false })]);
    expect(w.of('Sx', 'tournamentFinished')).toEqual([expect.objectContaining({ isQualifier: true, myResult: null })]);
    expect(w.roomEmits).toEqual([]);                                          // per socket, not one broadcast
  });

  it('CONTROL — any other tournament: the rooms\' broadcast exactly as before', () => {
    const w = world();
    const data = { tournamentId: 'T-other', results: [] };
    w.m.emitTournamentFinishedToEntrants('T-other', ['X1'], data);
    expect(w.roomEmits).toEqual([['table:X1', 'tournamentFinished', data]]);
  });

  it('results reach the master: a failed POST is RETRIED (it awards the seats), audited when it never lands', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { w, qt, data } = finished();
      w.postAnswers.push({ ok: false, status: 500 });
      w.m.postQualifierResults('TQ', data);
      await flush();
      jest.advanceTimersByTime(5_000);
      await flush();
      const posts = w.fetches.filter((f) => /results\/internal$/.test(f.url));
      expect(posts).toHaveLength(2);
      expect(posts[1].body).toEqual({ results: [
        { playerId: 'm-a', finishPosition: 1, pointsAwarded: 0 }, { playerId: 'm-b', finishPosition: 2, pointsAwarded: 0 },
        { playerId: 'm-c', finishPosition: 3, pointsAwarded: 0 }, { playerId: 'm-d', finishPosition: 4, pointsAwarded: 0 },
      ] });
      expect(w.m.qualifierResultPosts).toMatchObject({ posted: 1, retried: 1, failed: 0 });
      // 2026-10-20 — the full finish order is in the audit log before the POST.
      const order = [
        { playerId: 'm-a', finishPosition: 1, pointsAwarded: 0 }, { playerId: 'm-b', finishPosition: 2, pointsAwarded: 0 },
        { playerId: 'm-c', finishPosition: 3, pointsAwarded: 0 }, { playerId: 'm-d', finishPosition: 4, pointsAwarded: 0 },
      ];
      expect(w.audits.filter((a) => a.action === 'QUALIFIER_RESULTS_RECORDED')).toEqual([
        expect.objectContaining({ actor: 'SYSTEM', d: expect.objectContaining({ tournamentId: 'TQ', masterQualifierId: WEEKLY, finishOrder: order }) }),
      ]);
      // Another event whose POST never lands: 8 attempts (~10 minutes), then
      // the audit row — with the finish order, so it can be replayed.
      const other = { ...qt, tournamentId: 'TQ2' };
      w.qualifierTournaments.set('other', other);
      for (let i = 0; i < 8; i++) w.postAnswers.push({ ok: false, status: 503 });
      w.m.postQualifierResults('TQ2', { ...data, tournamentId: 'TQ2' });
      for (let i = 0; i < 6; i++) { await flush(); jest.advanceTimersByTime(100_000); }
      await flush();
      expect(w.audits.filter((a) => a.action === 'QUALIFIER_RESULTS_POST_FAILED')).toEqual([]);   // still retrying after ~5 minutes
      for (let i = 0; i < 6; i++) { await flush(); jest.advanceTimersByTime(400_000); }
      await flush();
      expect(w.fetches.filter((f) => /results\/internal$/.test(f.url) && f.body).length).toBe(2 + 8);
      expect(w.audits.filter((a) => a.action === 'QUALIFIER_RESULTS_POST_FAILED')).toEqual([expect.objectContaining({ d: expect.objectContaining({ tournamentId: 'TQ2', results: 4, finishOrder: order }) })]);
    } finally { jest.useRealTimers(); }
  });
});

describe('wiring', () => {
  it('the qualifier list never carries names; every count broadcast is a number', () => {
    const body = fnSrc('function screenQualifierRegistrants(');
    expect(body).not.toContain('players: qt.players.map(');
    expect(SRC).not.toContain("players: qt.players.map(p => ({ name: p.playerName })),");
  });
  it('the schedule sync reads the master\'s real answer (parseMasterSchedule), every 10 minutes', () => {
    expect(fnSrc('async function syncQualifierSchedule(')).toContain('applyQualifierSchedule(parseMasterSchedule(await resp.json()), Date.now());');
    expect(SRC).toContain('setInterval(() => syncQualifierSchedule(), 10 * 60 * 1000);');
  });
  it('a finished qualifier tournament marks the event finished BEFORE the rooms are told (so the frames carry the results)', () => {
    const ev = slice('  tournamentManager.onEvent(tournamentId, (event, data) => {', '\n  });\n', SRC.indexOf('function bootstrapTournamentTables('));
    expect(ev.indexOf('markQualifierFinished(')).toBeGreaterThan(-1);
    expect(ev.indexOf('markQualifierFinished(')).toBeLessThan(ev.indexOf('emitTournamentFinishedToEntrants('));
  });
});

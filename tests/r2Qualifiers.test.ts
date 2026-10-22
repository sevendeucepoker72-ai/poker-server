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
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import {
  parseMasterSchedule, qualifierWindows, qualifierStatusOf, seatsForTopOf, qualifierStructure, qualifierBlindLevels,
  parseSeatPackage, seatsForTopWith, seatsWonAt,
  QUALIFIER_BASE_STACK, QUALIFIER_LATE_REG_MS, QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft,
} from '../src/game/qualifierSchedule';
import { samplePresence, partitionByPresence, QUALIFIER_PRESENCE_LEAD_MS } from '../src/game/qualifierNoShow';
import { SRC, slice, fnSrc, handlerSrc, load, flush, deferred } from './helpers/indexSource';

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
/** 2026-10-22 (owner: "late entries until 2pm") — the late window: 3 hours (11:00 AM start → 2:00 PM). */
const LATE = QUALIFIER_LATE_REG_MS;

describe('qualifierSchedule (pure)', () => {
  it('reads the master\'s REAL shape (data.schedule); an event with no time is not playable online', () => {
    const list = parseMasterSchedule(MASTER_BODY);
    expect(list).toEqual([{
      id: WEEKLY, name: 'Weekly Qualifier — 2026-10-05', type: 'weekly', clientQualifierId: 'weekly-qualifier',
      scheduledAt: Date.parse('2026-10-11T12:00:00.000Z'), status: 'open', seatPackage: null,
    }]);
    expect(parseMasterSchedule({ schedule: MASTER_BODY.data.schedule })).toHaveLength(1);   // a bare {schedule} too
    expect(parseMasterSchedule(null)).toEqual([]);
  });

  it('CONTROL — the pre-R2 read (`body.schedule`) finds NOTHING in that answer: the registry stayed empty', () => {
    expect((MASTER_BODY as any).schedule).toBeUndefined();
  });

  it('windows: signup opens 3h before, closes (late registration included) QUALIFIER_LATE_REG_MS after; status from them', () => {
    const at = Date.parse('2026-10-11T12:00:00.000Z');
    expect(qualifierWindows(at)).toEqual({ signupOpensAt: at - 3 * H, signupClosesAt: at + LATE, lateRegUntil: at + LATE });
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
  // 2026-10-20 — no-shows released at the start + their sign-in notice.
  slice('const qualifierNoShows = { released: 0, toldOnSignIn: 0 };', '\n    return 0;\n  }\n}\n'),
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
  // 2026-10-22 — a re-entry takes a busted seat when no never-used seat is left.
  fnSrc('function seatQualifierReentrantOnBustedSeat('),
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
  // 2026-10-22 — the cached credit list (tier → [{playerId, creditCount}]); empty = never read.
  const qualifiedPlayers = new Map<string, Array<{ playerId: string; creditCount: number }>>();
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
    qualifierWindows, qualifierStatusOf, seatsForTopOf, seatsForTopWith, seatsWonAt, qualifierStructure, QUALIFIER_BASE_STACK,
    QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers,
    samplePresence, partitionByPresence, QUALIFIER_PRESENCE_LEAD_MS,
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
    qualifierNoShows, tellQualifierNoShowReleases, qualifierCreditHeldByConcurrentEntry,
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
    qualifiedPlayers,
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
      signupOpensAt: new Date(at - 3 * H).toISOString(), signupClosesAt: new Date(at + LATE).toISOString(),
      lateRegUntil: new Date(at + LATE).toISOString(), status: 'registering', registered: false, players: 0,
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
    w.sync(Date.now() - LATE - 60_000);
    expect(w.qualifierTournaments.size).toBe(0);
    // 2026-10-22 — 2 hours after its start it is still inside its late window (until 2 PM): opened.
    w.sync(Date.now() - 2 * H);
    expect(w.qualifierTournaments.size).toBe(1);
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

describe('F142 (2026-10-21) — a busted entrant is told he is OUT (and his re-entries left); a re-entry opens his new seat', () => {
  /** A running qualifier (Bob + Carl at Q1) that Alice entered late and busted out of. */
  function bustedAlice() {
    const w = world();
    w.sync(Date.now() - 10 * 60_000);
    const qt = w.qualifierTournaments.get(WEEKLY);
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    w.tm.registerPlayer(tid, 'user-201', 'Bob', 'sb', undefined, 'm-201');
    w.tm.registerPlayer(tid, 'user-202', 'Carl', 'sc', undefined, 'm-202');
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
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
    w.tm.addLateEntrant(tid, 'user-101', 'Alice', 'old', 50_000, { masterUserId: 'm-alice' });
    qt.players.push({ playerId: 'user-101', masterPlayerId: 'm-alice', playerName: 'Alice', phone: '', socketId: 'old', reEntries: 0 });
    w.tm.eliminatePlayer(tid, 'user-101');
    expect(w.tm.getTournament(tid)!.status).toBe('running');
    return { w, tid, qt, t };
  }

  it('the list item, per viewer: his busted entry → registered + eliminated, re-entries left = his unused credits (2026-10-22, was a fixed 3); a live entrant → not eliminated; no entry → reEntriesLeft null', () => {
    const { w } = bustedAlice();
    w.qualifiedPlayers.set('weekly', [{ playerId: 'm-alice', creditCount: 3 }, { playerId: 'm-201', creditCount: 1 }]);
    expect(w.m.qualifierList('m-alice')[0]).toMatchObject({ status: 'running', registered: true, eliminated: true, reEntriesLeft: 3 });
    expect(w.m.qualifierList('m-201')[0]).toMatchObject({ registered: true, eliminated: false, reEntriesLeft: 1 });
    expect(w.m.qualifierList('m-nobody')[0]).toMatchObject({ registered: false, eliminated: false, reEntriesLeft: null });
    expect(w.m.qualifierList(null)[0]).toMatchObject({ registered: false, eliminated: false, reEntriesLeft: null });
  });

  it('his re-entry seats him AND tells him like a late entry (qualifierTournamentStarted {reentry, lateEntry, tableId}); the list then says 2 left, not out', async () => {
    const { w, tid, t } = bustedAlice();
    w.qualifiedPlayers.set('weekly', [{ playerId: 'm-alice', creditCount: 3 }]);
    const before = w.globalEmits.length;
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await flush();
    expect(t.seats.find((s) => s.playerId === 'user-101')).toMatchObject({ state: 'occupied', chipCount: 50_000 });
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, reentry: true, tableId: 'Q1' })]);
    expect(w.of('SA', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({
      qualifierId: WEEKLY, tournamentId: tid, tableId: 'Q1', lateEntry: true, reentry: true,
    })]);
    // The lobby list everyone sees follows (broadcastQualifierUpdate).
    expect(w.globalEmits.slice(before).filter(([ev]) => ev === 'qualifierTournamentUpdate').map(([, d]) => d))
      .toEqual([expect.objectContaining({ qualifierId: WEEKLY, status: 'running', tournamentId: tid })]);
    // 2026-10-22 — the consume dropped the cached credit list (re-read on the next gate / qualifications);
    // the master now holds one credit fewer for her.
    expect(w.scope.lastQualifierFetch).toBe(0);
    w.qualifiedPlayers.set('weekly', [{ playerId: 'm-alice', creditCount: 2 }]);
    expect(w.m.qualifierList('m-alice')[0]).toMatchObject({ registered: true, eliminated: false, reEntriesLeft: 2, creditsHeld: 2, reEntries: 1 });
  });
});

describe('2026-10-22 (owner: "late entries until 2pm, re entries if they have more credits and each entry consume a credit")', () => {
  const MIN = 60_000;
  const SUNDAY_11AM_DENVER = Date.parse('2026-10-25T17:00:00.000Z');   // the weekly, 7a8dd4a8 (MDT)
  const MONTHLY_11AM_DENVER = Date.parse('2026-11-21T18:00:00.000Z');  // the monthly, 3rd Saturday (MST)
  const enter = (s: any) => s.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'x' });
  const last = (w: any, sid: string) => w.of(sid, 'qualifierRegistrationResult').slice(-1)[0];

  /** A RUNNING qualifier that started `ago` ms ago: Bob (seat 0) + Carl (seat 1) at Q1, `usable` seats there. */
  function field(ago: number, usable = 9) {
    const w = world();
    w.sync(Date.now() - ago);
    const qt = w.qualifierTournaments.get(WEEKLY);
    expect(qt).toBeTruthy();                                                   // listed (inside its late window)
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    w.tm.registerPlayer(tid, 'user-201', 'Bob', 'sb', undefined, 'm-201');
    w.tm.registerPlayer(tid, 'user-202', 'Carl', 'sc', undefined, 'm-202');
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    t.maxOccupiableSeats = usable;
    t.sitDown(0, 'Bob', 50_000, 'user-201', false, true);
    t.sitDown(1, 'Carl', 50_000, 'user-202', false, true);
    w.tables.set('Q1', t);
    w.tournamentTables.set('Q1', tid);
    w.tm.setTableIds(tid, ['Q1']);
    w.tm.setPlayerTable(tid, 'user-201', 'Q1');
    w.tm.setPlayerTable(tid, 'user-202', 'Q1');
    Object.assign(qt, { status: 'running', tournamentId: tid, players: [
      { playerId: 'user-201', masterPlayerId: 'm-201', playerName: 'Bob', phone: '', socketId: 'sb' },
      { playerId: 'user-202', masterPlayerId: 'm-202', playerName: 'Carl', phone: '', socketId: 'sc' },
    ] });
    return { w, qt, tid, t };
  }
  /** The bust check ran on `pid`'s LIVE seat: 0 chips, eliminated, the seat left occupied (as handleHandComplete leaves it). */
  function bust(w: any, tid: string, t: PokerTable, pid: string): number {
    const i = t.seats.findIndex((s) => s.state === 'occupied' && !s.eliminated && s.playerId === pid);
    expect(i).toBeGreaterThanOrEqual(0);
    t.seats[i].chipCount = 0;
    (t.seats[i] as any).eliminated = true;
    w.tm.eliminatePlayer(tid, pid);
    return i;
  }
  const liveSeatsOf = (t: PokerTable, pid: string) => t.seats.filter((s) => s.state === 'occupied' && !s.eliminated && s.playerId === pid);
  const entrant = (w: any, tid: string, pid: string) => w.tm.getTournament(tid)!.players.find((p: any) => p.playerId === pid);

  it('ONE constant: late registration closes 3 hours after the start = 2:00 PM Denver, for the weekly AND the monthly (both start at 11:00 AM)', () => {
    expect(LATE).toBe(3 * H);
    expect(new Date(qualifierWindows(SUNDAY_11AM_DENVER).lateRegUntil).toISOString()).toBe('2026-10-25T20:00:00.000Z');   // 2:00 PM MDT
    expect(qualifierWindows(SUNDAY_11AM_DENVER).signupClosesAt).toBe(qualifierWindows(SUNDAY_11AM_DENVER).lateRegUntil);
    expect(new Date(qualifierWindows(MONTHLY_11AM_DENVER).lateRegUntil).toISOString()).toBe('2026-11-21T21:00:00.000Z');  // 2:00 PM MST
    expect(SRC).not.toMatch(/MAX_RE_ENTRIES_DEFAULT\s*=\s*3/);
  });

  it('the re-entries left: his unused credits (each re-entry consumes one), within a cap only if one is set; no cap by default', () => {
    expect(QUALIFIER_MAX_REENTRIES).toBeNull();
    expect(qualifierReEntriesLeft(4, null, 0)).toBe(4);
    expect(qualifierReEntriesLeft(4, null, 7)).toBe(4);                 // re-entries made do not count; credits do
    expect(qualifierReEntriesLeft(0, null, 2)).toBe(0);
    expect(qualifierReEntriesLeft(null, null, 2)).toBeNull();           // never read: unknown
    expect(qualifierReEntriesLeft(4, 3, 1)).toBe(2);
    expect(qualifierReEntriesLeft(1, 3, 1)).toBe(1);
    expect(qualifierReEntriesLeft(null, 3, 1)).toBe(2);
    expect(qualifierReEntriesLeft(5, 3, 4)).toBe(0);
  });

  it('LATE ENTRY at 1:50 PM (2h50 after the start) is seated with ONE credit (refused after 12:30 before); after 2:00 PM → signup_closed, no credit touched', async () => {
    const { w, t } = field(2 * H + 50 * MIN);
    expect(w.m.qualifierList(null)[0]).toMatchObject({ status: 'running', signupOpen: true });
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: true, lateEntry: true, tableId: 'Q1' }));
    expect(liveSeatsOf(t, 'user-101')).toEqual([expect.objectContaining({ chipCount: 50_000 })]);
    expect(w.consumed).toEqual([{ masterId: 'm-alice', tier: 'weekly', label: 'entry' }]);
    expect(w.creditRefunds).toEqual([]);

    const { w: w2 } = field(2 * H + 50 * MIN);
    const b = w2.mkSocket('SB', BOB, 'm-bob', 'Bob');
    const realNow = Date.now;
    const after2pm = realNow() + 11 * MIN;                                    // 3h01 after the start
    Date.now = () => after2pm;
    try {
      await enter(b);
    } finally { Date.now = realNow; }
    expect(last(w2, 'SB')).toEqual(expect.objectContaining({ success: false, code: 'signup_closed' }));
    expect(w2.consumed).toEqual([]);
    expect(w2.m.qualifierList(null, after2pm)[0]).toMatchObject({ status: 'running', signupOpen: false });
  });

  it('RE-ENTRY while she holds credits: every entry consumes exactly ONE credit and there is no cap of 3; out of credits → no_credit, still out, nothing seated', async () => {
    const { w, tid, t, qt } = field(10 * MIN);
    let held = 5;                                                              // 5 weekly credits
    const kept: string[] = [];
    w.scope.consumeQualifierCreditOnMaster = async (masterId: string, tier: string, _q: string, label: string) => {
      w.consumed.push({ masterId, tier, label });
      if (held <= 0) return { consumed: false };
      held--;
      kept.push(`credit-${kept.length + 1}`);
      return { consumed: true, creditId: kept[kept.length - 1] };
    };
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);                                                            // the first entry: credit 1
    for (let n = 1; n <= 4; n++) {                                             // re-entries 1..4 (the 4th was 'reentry_limit')
      bust(w, tid, t, 'user-101');
      await enter(a);
      expect({ n, result: last(w, 'SA') }).toEqual({ n, result: expect.objectContaining({ success: true, reentry: true, tableId: 'Q1' }) });
      expect(liveSeatsOf(t, 'user-101')).toEqual([expect.objectContaining({ chipCount: 50_000 })]);
      expect(entrant(w, tid, 'user-101')).toMatchObject({ eliminated: false, chips: 50_000, finishPosition: 0 });
    }
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 're-entry', 're-entry', 're-entry', 're-entry']);
    expect(held).toBe(0);
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-alice')).toMatchObject({
      consumedCreditId: 'credit-1', reEntries: 4, reentryCreditIds: ['credit-2', 'credit-3', 'credit-4', 'credit-5'],
    });
    expect(w.creditRefunds).toEqual([]);
    expect(w.tm.getTournament(tid)!.players).toHaveLength(3);                  // re-entries never add entrants

    // Out of credits: the master says no — refused (no_credit), still out, nothing seated or refunded.
    bust(w, tid, t, 'user-101');
    await enter(a);
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'no_credit', qualifierId: WEEKLY }));
    expect(w.consumed).toHaveLength(6);
    expect(entrant(w, tid, 'user-101')!.eliminated).toBe(true);
    expect(liveSeatsOf(t, 'user-101')).toEqual([]);
    expect(w.creditRefunds).toEqual([]);
  });

  it('the lobby item: reEntriesLeft = her unused credits of the event\'s tier (+ creditsHeld, maxReEntries null, reEntries); never read → null; anonymous → null', async () => {
    const { w, tid, t, qt } = field(10 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    bust(w, tid, t, 'user-101');
    expect(w.m.qualifierList('m-alice')[0]).toMatchObject({ registered: true, eliminated: true, reEntriesLeft: null, creditsHeld: null, maxReEntries: null, reEntries: 0 });
    w.qualifiedPlayers.set('weekly', [{ playerId: 'm-alice', creditCount: 7 }, { playerId: 'm-201', creditCount: 2 }]);
    w.qualifiedPlayers.set('monthly', [{ playerId: 'm-alice', creditCount: 1 }]);
    expect(w.m.qualifierList('m-alice')[0]).toMatchObject({ eliminated: true, reEntriesLeft: 7, creditsHeld: 7, maxReEntries: null, reEntries: 0 });
    expect(w.m.qualifierList('m-201')[0]).toMatchObject({ registered: true, eliminated: false, reEntriesLeft: 2, creditsHeld: 2 });
    expect(w.m.qualifierList('m-202')[0]).toMatchObject({ registered: true, reEntriesLeft: 0, creditsHeld: 0 });   // read, holds none
    expect(w.m.qualifierList('m-nobody')[0]).toMatchObject({ registered: false, reEntriesLeft: null, creditsHeld: 0, reEntries: null });
    expect(w.m.qualifierList(null)[0]).toMatchObject({ registered: false, reEntriesLeft: null, creditsHeld: null, reEntries: null, maxReEntries: null });
    // A per-event cap still caps: cap - re-entries made, within her credits.
    qt.maxReEntries = 2;
    qt.players.find((p: any) => p.masterPlayerId === 'm-alice').reEntries = 1;
    expect(w.m.qualifierList('m-alice')[0]).toMatchObject({ reEntriesLeft: 1, maxReEntries: 2, reEntries: 1, creditsHeld: 7 });
  });

  it('two re-entries of ONE account at once (two tabs): one seat, one credit kept — the second is refused already_registered and its credit refunded', async () => {
    const { w, tid, t, qt } = field(10 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    bust(w, tid, t, 'user-101');
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    await Promise.all([enter(a), enter(a2)]);
    await flush();
    expect(liveSeatsOf(t, 'user-101')).toHaveLength(1);
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 're-entry', 're-entry']);
    expect(w.creditRefunds).toEqual(['credit-3']);
    const results = [...w.of('SA', 'qualifierRegistrationResult').slice(1), ...w.of('SA2', 'qualifierRegistrationResult')];
    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ success: true, reentry: true }),
      expect.objectContaining({ success: false, code: 'already_registered', registered: true }),
    ]));
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-alice')).toMatchObject({ reEntries: 1, reentryCreditIds: ['credit-2'] });
    expect(entrant(w, tid, 'user-101')).toMatchObject({ eliminated: false, chips: 50_000 });
    expect(w.m.qualifierLateEntries.reentryRefusedAlreadyBack).toBe(1);
    expect(w.audits.find((x) => x.action === 'QUALIFIER_REENTRY_CREDIT_REFUND')?.d).toMatchObject({ creditId: 'credit-3', reason: 'already_reentered' });
  });

  // ── Review fix-up of 7dad8e0 ──────────────────────────────────────────────
  /** The master BEFORE mono d01522e6: two concurrent consumes for one player both answer the SAME credit row. */
  function sharedCreditMaster(w: any) {
    let n = 0;
    let pendingShared: string | null = null;
    w.scope.consumeQualifierCreditOnMaster = async (masterId: string, tier: string, _q: string, label: string) => {
      w.consumed.push({ masterId, tier, label });
      // A second call while the first's credit is "in flight" gets the same id.
      const id = pendingShared ?? `shared-${++n}`;
      pendingShared = id;
      await Promise.resolve();
      setImmediate(() => { pendingShared = null; });
      return { consumed: true, creditId: id };
    };
  }

  it('review fix-up — the OLD master gives two concurrent re-entries the SAME credit: one seat, that credit KEPT (it used to be refunded: a free re-entry)', async () => {
    const { w, tid, t, qt } = field(10 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);                                                            // credit-1, the first entry
    bust(w, tid, t, 'user-101');
    sharedCreditMaster(w);
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    await Promise.all([enter(a), enter(a2)]);
    await flush();
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 're-entry', 're-entry']);
    const entry = qt.players.find((p: any) => p.masterPlayerId === 'm-alice');
    const shared = entry.reentryCreditIds[0];
    expect(entry).toMatchObject({ reEntries: 1, reentryCreditIds: [shared] });
    expect(liveSeatsOf(t, 'user-101')).toHaveLength(1);
    expect(w.creditRefunds).toEqual([]);                                       // the one credit redeemed pays for the one seat
    const results = [...w.of('SA', 'qualifierRegistrationResult').slice(1), ...w.of('SA2', 'qualifierRegistrationResult')];
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ success: true, reentry: true }),
      expect.objectContaining({ success: false, code: 'already_registered', registered: true }),
    ]));
    expect(w.m.qualifierLateEntries.sharedCreditKept).toBe(1);
    expect(w.audits.filter((x) => x.action === 'QUALIFIER_REENTRY_CREDIT_SHARED_KEPT').map((x) => x.d)).toEqual([{ qualifierId: WEEKLY, creditId: shared }]);
    expect(w.audits.some((x) => x.action === 'QUALIFIER_REENTRY_CREDIT_REFUND')).toBe(false);

    // A double tap on ONE socket (it would have been refused seated_elsewhere — and refunded) is kept too.
    bust(w, tid, t, 'user-101');
    await Promise.all([enter(a), enter(a)]);
    await flush();
    expect(liveSeatsOf(t, 'user-101')).toHaveLength(1);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.qualifierLateEntries.sharedCreditKept).toBe(2);
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-alice').reEntries).toBe(2);
  });

  it('review fix-up — the OLD master gives two concurrent FIRST entries the same credit: one entry, that credit kept (not refunded)', async () => {
    const w = world();
    w.sync(Date.now() + H);
    sharedCreditMaster(w);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    await Promise.all([enter(a), enter(a2)]);
    await flush();
    const qt = w.qualifierTournaments.get(WEEKLY);
    expect(qt.players).toHaveLength(1);
    expect(w.consumed).toHaveLength(2);
    expect(w.creditRefunds).toEqual([]);
    expect(w.audits.filter((x) => x.action === 'QUALIFIER_ENTRY_CREDIT_SHARED_KEPT').map((x) => x.d)).toEqual([{ qualifierId: WEEKLY, creditId: qt.players[0].consumedCreditId }]);
    expect([...w.of('SA', 'qualifierRegistrationResult'), ...w.of('SA2', 'qualifierRegistrationResult')]).toEqual(expect.arrayContaining([
      expect.objectContaining({ success: true, registered: true }),
      expect.objectContaining({ success: false, code: 'already_registered' }),
    ]));
  });

  it('review fix-up — the shared-credit test: only an id the SAME account\'s entry recorded during this call (not one it held before)', () => {
    const held = world().m.qualifierCreditHeldByConcurrentEntry;
    expect(held({ consumedCreditId: 'c1' }, 'c1')).toBe(true);
    expect(held({ consumedCreditId: 'c1', reentryCreditIds: ['c2'] }, 'c2')).toBe(true);
    expect(held({ consumedCreditId: 'c1', reentryCreditIds: ['c2'] }, 'c3')).toBe(false);   // the NEW master: distinct ids
    expect(held({ consumedCreditId: 'c1' }, 'c1', new Set(['c1']))).toBe(false);             // he held it before this call
    expect(held(undefined, 'c1')).toBe(false);
    expect(held({ consumedCreditId: 'c1' }, null)).toBe(false);
  });

  /** Two re-entries of one account in flight: the first answered at once, the second when `release` is called. */
  function overlappingReentries(w: any) {
    const gate = deferred();
    let n = 1;
    w.scope.consumeQualifierCreditOnMaster = async (masterId: string, tier: string, _q: string, label: string) => {
      w.consumed.push({ masterId, tier, label });
      const id = `credit-${++n}`;
      if (n === 3) await gate.p;
      return { consumed: true, creditId: id };
    };
    return gate;
  }

  it('review fix-up — overlapping re-entries with a bust in between: BOTH count (reEntries 2, not prior + 1), two credits, one live seat', async () => {
    const { w, tid, t, qt } = field(10 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);                                                            // credit-1
    bust(w, tid, t, 'user-101');
    const gate = overlappingReentries(w);
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    const p1 = enter(a);
    const p2 = enter(a2);
    await p1;                                                                  // re-entry 1 (credit-2) seated
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: true, reentry: true }));
    bust(w, tid, t, 'user-101');                                               // out again before re-entry 2 is answered
    gate.resolve();
    await p2;                                                                  // re-entry 2 (credit-3): a real, second re-entry
    expect(last(w, 'SA2')).toEqual(expect.objectContaining({ success: true, reentry: true }));
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-alice')).toMatchObject({ reEntries: 2, reentryCreditIds: ['credit-2', 'credit-3'] });
    expect(liveSeatsOf(t, 'user-101')).toHaveLength(1);
    expect(w.creditRefunds).toEqual([]);
  });

  it('review fix-up — a per-event cap is re-read after the consume: the overlapping re-entry made meanwhile counts (refused reentry_limit, its credit refunded)', async () => {
    const { w, tid, t, qt } = field(10 * MIN);
    qt.maxReEntries = 1;
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    bust(w, tid, t, 'user-101');
    const gate = overlappingReentries(w);
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    const p1 = enter(a);
    const p2 = enter(a2);
    await p1;
    bust(w, tid, t, 'user-101');
    gate.resolve();
    await p2;
    expect(last(w, 'SA2')).toEqual(expect.objectContaining({ success: false, code: 'reentry_limit' }));
    expect(w.creditRefunds).toEqual(['credit-3']);
    expect(w.audits.find((x) => x.action === 'QUALIFIER_REENTRY_CREDIT_REFUND')?.d).toMatchObject({ creditId: 'credit-3', reason: 'reentry_limit' });
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-alice')).toMatchObject({ reEntries: 1, reentryCreditIds: ['credit-2'] });
    expect(liveSeatsOf(t, 'user-101')).toEqual([]);
    expect(entrant(w, tid, 'user-101')!.eliminated).toBe(true);
  });

  it('the late window closes DURING the re-entry\'s credit consume: refused registration_closed, the credit refunded, not seated', async () => {
    const { w, tid, t } = field(2 * H + 59 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    bust(w, tid, t, 'user-101');
    const realNow = Date.now;
    const base = w.scope.consumeQualifierCreditOnMaster as (...x: any[]) => Promise<any>;
    w.scope.consumeQualifierCreditOnMaster = async (...x: any[]) => {
      const r = await base(...x);
      const later = realNow() + 2 * MIN;                                       // 2:01 PM when the master answers
      Date.now = () => later;
      return r;
    };
    try {
      await enter(a);
    } finally { Date.now = realNow; }
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'registration_closed' }));
    expect(w.creditRefunds).toEqual(['credit-2']);
    expect(liveSeatsOf(t, 'user-101')).toEqual([]);
    expect(entrant(w, tid, 'user-101')!.eliminated).toBe(true);
  });

  it('no never-used seat left: the re-entry takes her OWN busted seat (it was refunded no_seat) — one credit, her session bound, places stay 1..N', async () => {
    const { w, tid, t } = field(10 * MIN, 3);                                 // 3 usable seats: the table is full
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(t.seats[2]).toMatchObject({ state: 'occupied', playerId: 'user-101' });
    expect(bust(w, tid, t, 'user-101')).toBe(2);
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'Q1', seatIndex: 2 });   // still on her dead seat
    await enter(a);
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: true, reentry: true, tableId: 'Q1' }));
    expect(w.of('SA', 'qualifierTournamentStarted').slice(-1)[0]).toEqual(expect.objectContaining({ tableId: 'Q1', lateEntry: true, reentry: true }));
    expect(t.seats[2]).toMatchObject({ state: 'occupied', playerId: 'user-101', chipCount: 50_000, eliminated: false });
    expect(t.seats.filter((s) => s.state === 'occupied' && s.playerId === 'user-101')).toHaveLength(1);   // no dead seat of hers left
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'Q1', seatIndex: 2, playerId: 'user-101' });
    expect(a.rooms.has('table:Q1')).toBe(true);
    expect([...((w.scope.spectators as Map<string, Set<string>>).get('Q1') || [])]).not.toContain('SA');
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 're-entry']);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.qualifierLateEntries.reentrySeatedOnBustedSeat).toBe(1);
    expect(entrant(w, tid, 'user-101')).toMatchObject({ eliminated: false, finishPosition: 0, chips: 50_000 });
    bust(w, tid, t, 'user-202');
    expect(entrant(w, tid, 'user-202')!.finishPosition).toBe(3);               // 3 entrants: the next bust is 3rd
  });

  it('her own dead seat was taken (a late entrant): every seat alive → no_seat, the credit returned; once another seat busts she takes THAT one', async () => {
    const { w, tid, t } = field(10 * MIN, 3);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);                                                            // Alice: seat 2, credit-1
    bust(w, tid, t, 'user-101');
    const d = w.mkSocket('SD', 103, 'm-dan', 'Dan');
    await enter(d);                                                            // Dan takes her busted seat 2, credit-2
    expect(t.seats[2]).toMatchObject({ playerId: 'user-103', eliminated: false });

    await enter(a);                                                            // credit-3 consumed, then returned
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'no_seat', qualifierId: WEEKLY }));
    expect(w.creditRefunds).toEqual(['credit-3']);
    expect(entrant(w, tid, 'user-101')!.eliminated).toBe(true);

    bust(w, tid, t, 'user-202');                                               // Carl busts at seat 1
    await enter(a);                                                            // credit-4
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: true, reentry: true }));
    expect(t.seats[1]).toMatchObject({ state: 'occupied', playerId: 'user-101', chipCount: 50_000, eliminated: false });
    expect(w.creditRefunds).toEqual(['credit-3']);
    // 4 entrants (Bob, Carl, Alice, Dan): Carl is out 4th, the three alive hold no place.
    expect(w.tm.getTournament(tid)!.players.map((p: any) => [p.playerId, p.eliminated, p.finishPosition]).sort()).toEqual([
      ['user-101', false, 0], ['user-103', false, 0], ['user-201', false, 0], ['user-202', true, 4],
    ]);
  });

  it('a re-entry is open until 2 PM too: 2h50 after the start she re-enters (one credit); after 2 PM → signup_closed, nothing consumed', async () => {
    const { w, tid, t } = field(2 * H + 50 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    bust(w, tid, t, 'user-101');
    await enter(a);
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: true, reentry: true }));
    bust(w, tid, t, 'user-101');
    const realNow = Date.now;
    const after2pm = realNow() + 11 * MIN;
    Date.now = () => after2pm;
    try {
      await enter(a);
    } finally { Date.now = realNow; }
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'signup_closed' }));
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 're-entry']);
    expect(liveSeatsOf(t, 'user-101')).toEqual([]);
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
    // 2026-10-22 — late registration now runs until 2 PM: still waiting at the OLD close (start + 90 min).
    w.m.tickQualifierAutoStart(at + 1.5 * H + 1);
    await flush();
    expect(w.qualifierTournaments.get(WEEKLY).status).toBe('registering');
    expect(w.creditRefunds).toEqual([]);
    w.m.tickQualifierAutoStart(at + LATE + 1);
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
    expect(w.of('Sa', 'tournamentFinished')).toEqual([expect.objectContaining({ tournamentId: 'TQ', results: data.results, isQualifier: true, qualifierId: WEEKLY, seatsForTop: 3, myResult: { place: 1, wonSeat: true, seats: 1 }, place: 1, wonSeat: true })]);
    expect(w.of('Sd', 'tournamentFinished')).toEqual([expect.objectContaining({ myResult: { place: 4, wonSeat: false, seats: 0 }, place: 4, wonSeat: false })]);
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

describe('2026-10-20 (owner: "Remove + refund at start") — no-shows are released at the start', () => {
  const CAROL = 103;
  async function three(w: ReturnType<typeof world>) {
    const at = Date.now() + H;
    w.sync(at);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const b = w.mkSocket('SB', BOB, 'm-bob', 'Bob');
    const c = w.mkSocket('SC', CAROL, 'm-carol', 'Carol');
    for (const [s, n] of [[a, 'Alice'], [b, 'Bob'], [c, 'Carol']] as const) await s.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: n });
    expect(w.qualifierTournaments.get(WEEKLY).players).toHaveLength(3);
    return { at, a, b, c };
  }
  const offline = (w: ReturnType<typeof world>, s: any) => { s.connected = false; };
  const online = (w: ReturnType<typeof world>, s: any) => { s.connected = true; };

  it('offline at the start → released: credit refunded, master registration deleted, audited, not seated; the two online start', async () => {
    const w = world();
    const { at, c } = await three(w);
    offline(w, c);
    w.m.tickQualifierAutoStart(at);
    await flush();
    expect(w.started).toHaveLength(1);
    expect(w.started[0].players.map((p: any) => p.masterId)).toEqual(['m-alice', 'm-bob']);
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'running' });
    expect(w.qualifierTournaments.get(WEEKLY).players.map((p: any) => p.masterPlayerId)).toEqual(['m-alice', 'm-bob']);
    expect(w.creditRefunds).toEqual(['credit-3']);
    expect(w.fetches.filter((f) => f.method === 'DELETE' && /register\/internal$/.test(f.url)).map((f) => f.body)).toEqual([{ userId: 'm-carol' }]);
    expect(w.audits.filter((x) => x.action === 'QUALIFIER_NO_SHOW_RELEASED')).toEqual([
      expect.objectContaining({ d: expect.objectContaining({ qualifierId: WEEKLY, masterId: 'm-carol', creditRefunded: true }) }),
    ]);
    expect(w.m.qualifierNoShows.released).toBe(1);
    // The start broadcast counts the field that actually started.
    expect(w.globalEmits.filter(([e]) => e === 'qualifierTournamentUpdate').pop()![1]).toMatchObject({ status: 'running', playerCount: 2 });
  });

  it('CONTROL — everyone online: nobody released', async () => {
    const w = world();
    const { at } = await three(w);
    w.m.tickQualifierAutoStart(at);
    await flush();
    expect(w.started[0].players).toHaveLength(3);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.qualifierNoShows.released).toBe(0);
  });

  it('a blip is not a no-show: seen online a minute before the start, offline AT the start → still seated', async () => {
    const w = world();
    const { at, c } = await three(w);
    w.m.tickQualifierAutoStart(at - 60_000);          // the tick before the start sees Carol
    expect(w.qualifierTournaments.get(WEEKLY).status).toBe('registering');
    offline(w, c);
    w.m.tickQualifierAutoStart(at);
    await flush();
    expect(w.started[0].players).toHaveLength(3);
    expect(w.creditRefunds).toEqual([]);
  });

  it('seen online 5 minutes before but not since → a no-show', async () => {
    const w = world();
    const { at, c } = await three(w);
    w.m.tickQualifierAutoStart(at - 5 * 60_000);
    offline(w, c);
    w.m.tickQualifierAutoStart(at);
    await flush();
    expect(w.started[0].players.map((p: any) => p.masterId)).toEqual(['m-alice', 'm-bob']);
  });

  it('a no-show who signs in on ANOTHER socket before the start is online (the master account counts, not the registration socket)', async () => {
    const w = world();
    const { at, c } = await three(w);
    offline(w, c);
    w.mkSocket('SC2', CAROL, 'm-carol', 'Carol');      // a reload: a new socket, same account
    w.m.tickQualifierAutoStart(at);
    await flush();
    expect(w.started[0].players).toHaveLength(3);
  });

  it('fewer than 2 online: NOBODY is released, it waits; one comes back → it starts with the two, the third released then', async () => {
    const w = world();
    const { at, b, c } = await three(w);
    offline(w, b); offline(w, c);
    w.m.tickQualifierAutoStart(at);
    await flush();
    expect(w.started).toEqual([]);
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'registering' });
    expect(w.qualifierTournaments.get(WEEKLY).players).toHaveLength(3);
    expect(w.creditRefunds).toEqual([]);
    online(w, b);
    w.m.tickQualifierAutoStart(at + 60_000);
    await flush();
    expect(w.started[0].players.map((p: any) => p.masterId)).toEqual(['m-alice', 'm-bob']);
    expect(w.creditRefunds).toEqual(['credit-3']);
  });

  it('still fewer than 2 online when late registration ends → cancelled, EVERY credit refunded (as with too few registered)', async () => {
    const w = world();
    const { at, b, c } = await three(w);
    offline(w, b); offline(w, c);
    w.m.tickQualifierAutoStart(at);
    w.m.tickQualifierAutoStart(at + LATE + 1);
    await flush();
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.creditRefunds.sort()).toEqual(['credit-1', 'credit-2', 'credit-3']);
    expect(w.started).toEqual([]);
  });

  it('the released player is told at the next sign-in, once: qualifierCancelled {reason absent_at_start, late registration open, credit refunded}', async () => {
    const w = world();
    const { at, c } = await three(w);
    offline(w, c);
    w.m.tickQualifierAutoStart(at);
    await flush();
    const back = w.mkSocket('SC3', CAROL, 'm-carol', 'Carol');
    const realNow = Date.now;
    Date.now = () => at + 10 * 60_000;
    try {
      expect(w.m.tellQualifierNoShowReleases(back, w.authSessions.get('SC3'), 'test')).toBe(1);
      expect(w.of('SC3', 'qualifierCancelled')).toEqual([{
        qualifierId: WEEKLY, reason: 'absent_at_start', qualifierName: expect.any(String),
        lateRegUntil: new Date(at + LATE).toISOString(), lateRegOpen: true, creditRefunded: true,
      }]);
      expect(w.m.tellQualifierNoShowReleases(back, w.authSessions.get('SC3'), 'test')).toBe(0);   // once
      // Nobody else is told anything.
      const alice = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
      expect(w.m.tellQualifierNoShowReleases(alice, w.authSessions.get('SA2'), 'test')).toBe(0);
    } finally { Date.now = realNow; }
  });

  it('wiring: every sign-in path that tells kept seats also tells a no-show release (one hook)', () => {
    const tell = fnSrc('function tellKeptTournamentSeats(');
    expect(tell).toContain('tellQualifierNoShowReleases(socket, auth, via);');
    expect(tell.indexOf('tellQualifierNoShowReleases(')).toBeLessThan(tell.indexOf('absentTournamentSeatsOf('));
    for (const via of ['oauthLogin', 'tokenLogin', 'authWithTicket', 'resumeSession', 'joinWithWaitlistContext']) {
      expect(SRC).toContain(`'${via}')`);
    }
  });
});

describe('2026-10-20 — the credit list (the entry gate) survives a master blip and sees new / refunded credits', () => {
  const LIST = slice('const qualifiedPlayers = new Map<string, QualifiedPlayer[]>();', '\n  return false;\n}\n');
  function gate(answers: Array<'ok' | 'throw' | '500' | 'bad'>, credits: () => Array<{ player_id: string; tier: string }>) {
    const calls: string[] = [];
    const scope: Record<string, unknown> = {
      process: { env: { MASTER_API_URL: 'https://master.test', INTERNAL_NOTIFY_TOKEN: 't' } },
      console: { log() {}, warn() {}, error() {} },
      fetch: async (url: string) => {
        calls.push(url);
        const a = answers.length > 1 ? answers.shift()! : answers[0];
        if (a === 'throw') throw new Error('ECONNRESET');
        if (a === '500') return { ok: false, status: 500, json: async () => ({ success: false }) };
        if (a === 'bad') return { ok: true, status: 200, json: async () => ({ success: false }) };
        return { ok: true, status: 200, json: async () => ({ success: true, credits: credits() }) };
      },
    };
    const { exports: g } = load(LIST, scope, '{ isPlayerQualified, getQualifiedPlayers }');
    return { g, calls };
  }
  let clock = 0;
  const realNow = Date.now;
  beforeEach(() => { clock = Date.parse('2026-10-25T16:55:00Z'); Date.now = () => clock; });
  afterEach(() => { Date.now = realNow; });

  it('a failed read KEEPS the last good list (it used to cache [] and refuse every qualified player for 5 minutes)', async () => {
    const { g, calls } = gate(['ok', 'throw'], () => [{ player_id: 'm1', tier: 'weekly' }]);
    expect(await g.isPlayerQualified('m1', 'weekly')).toBe(true);
    clock += 6 * 60_000;                                // cache expired; the master is down
    expect(await g.isPlayerQualified('m1', 'weekly')).toBe(true);
    expect(calls).toHaveLength(2);
    clock += 5_000;                                     // inside the 15 s retry back-off: no new read
    expect(await g.isPlayerQualified('m1', 'weekly')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a non-2xx or a success:false answer is a failed read too (last good list kept)', async () => {
    for (const bad of ['500', 'bad'] as const) {
      const { g } = gate(['ok', bad], () => [{ player_id: 'm1', tier: 'weekly' }]);
      expect(await g.isPlayerQualified('m1', 'weekly')).toBe(true);
      clock += 6 * 60_000;
      expect(await g.isPlayerQualified('m1', 'weekly')).toBe(true);
    }
  });

  it('a credit earned (or refunded) after the list was read: "not in the list" re-reads it once before refusing (at most every 30 s)', async () => {
    let credits = [{ player_id: 'm1', tier: 'weekly' }];
    const { g, calls } = gate(['ok'], () => credits);
    expect(await g.isPlayerQualified('m2', 'weekly')).toBe(false);     // fresh list: no re-read
    expect(calls).toHaveLength(1);
    credits = [...credits, { player_id: 'm2', tier: 'weekly' }];         // m2 finished top 5 / was refunded
    clock += 10_000;
    expect(await g.isPlayerQualified('m2', 'weekly')).toBe(false);     // list 10 s old: no re-read yet
    expect(calls).toHaveLength(1);
    clock += 25_000;
    expect(await g.isPlayerQualified('m2', 'weekly')).toBe(true);      // 35 s old: re-read, now qualified
    expect(calls).toHaveLength(2);
  });

  it('never read and the master is down → not qualified (the consume on the master stays the real gate)', async () => {
    const { g } = gate(['throw'], () => []);
    expect(await g.isPlayerQualified('m1', 'weekly')).toBe(false);
  });
});

describe('review fix-up (7dad8e0) — the cached credit list follows every consume / refund this server makes (the lobby item reads it synchronously)', () => {
  // Sliced per test (an index.ts without these helpers fails each test, not the whole file).
  const cacheSrc = () => [
    slice('const qualifiedPlayers = new Map<string, QualifiedPlayer[]>();', '\n  return false;\n}\n'),
    slice('const qualifierCreditOwners = new Map', ';\n'),
    fnSrc('async function consumeQualifierCreditOnMaster('),
    fnSrc('async function refundQualifierCreditOnMaster('),
    fnSrc('async function issueQualifierCreditOnMaster('),
  ].join('\n');
  /** A fake master: `credits` = its UNUSED credits; a list read answers what it held when the read STARTED. */
  function master(initial: Array<{ id: string; player_id: string; tier: string }>) {
    const credits = initial.map((c) => ({ ...c }));
    const redeemed = new Map<string, { id: string; player_id: string; tier: string }>();
    const reads: string[] = [];
    const held: Array<() => void> = [];
    const ctl = { holdReads: false };
    let issued = 0;
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const scope: Record<string, unknown> = {
      process: { env: { MASTER_API_URL: 'https://master.test', INTERNAL_NOTIFY_TOKEN: 't' } },
      console: { log() {}, warn() {}, error() {} },
      fetch: async (url: string, init: any) => {
        if (url.includes('/qualifier-credits?')) {
          reads.push(url);
          const snapshot = credits.map((c) => ({ ...c }));
          if (ctl.holdReads) await new Promise<void>((r) => held.push(r));
          return ok({ success: true, credits: snapshot });
        }
        const body = JSON.parse(init.body);
        if (url.endsWith('/consume/internal')) {
          const i = credits.findIndex((c) => c.player_id === body.playerId && c.tier === body.tier);
          if (i < 0) return ok({ consumed: false });
          const [c] = credits.splice(i, 1);
          redeemed.set(c.id, c);
          return ok({ consumed: true, creditId: c.id });
        }
        if (url.endsWith('/refund/internal')) {
          const c = redeemed.get(body.creditId);
          if (!c) return ok({ refunded: body.creditId === 'from-an-earlier-process' });
          redeemed.delete(body.creditId);
          credits.push(c);
          return ok({ refunded: true });
        }
        if (url.endsWith('/issue/internal')) {
          const c = { id: `issued-${++issued}`, player_id: body.playerId, tier: body.tier };
          credits.push(c);
          return ok({ issued: true, creditId: c.id });
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    };
    const { exports: m } = load(cacheSrc(), scope, `{
      getQualifiedPlayers, isPlayerQualified, consumeQualifierCreditOnMaster, refundQualifierCreditOnMaster,
      issueQualifierCreditOnMaster, qualifiedPlayers, state: () => ({ lastQualifierFetch, qualifierCacheGen }),
    }`);
    const count = (id: string, tier = 'weekly') => {
      const list = m.qualifiedPlayers.get(tier);
      return list ? (list.find((p: any) => p.playerId === id)?.creditCount ?? 0) : null;
    };
    return { m, reads, held, ctl, count };
  }
  let clock = 0;
  const realNow = Date.now;
  beforeEach(() => { clock = Date.parse('2026-10-25T18:05:00Z'); Date.now = () => clock; });
  afterEach(() => { Date.now = realNow; });

  it('a consume takes his credit off the cached count AT ONCE (it stayed until something re-read: an old lobby offered Re-enter after his last credit); a refund gives it back; no extra read', async () => {
    const f = master([
      { id: 'a1', player_id: 'm1', tier: 'weekly' }, { id: 'a2', player_id: 'm1', tier: 'weekly' }, { id: 'b1', player_id: 'm2', tier: 'weekly' },
      { id: 'c1', player_id: 'm1', tier: 'monthly' },
    ]);
    await f.m.getQualifiedPlayers('weekly');
    expect([f.count('m1'), f.count('m2')]).toEqual([2, 1]);
    expect(f.reads).toHaveLength(1);

    expect(await f.m.consumeQualifierCreditOnMaster('m1', 'weekly', 'q', 're-entry')).toEqual({ consumed: true, creditId: 'a1' });
    expect(f.count('m1')).toBe(1);                                          // was still 2 until a re-read
    expect(f.m.state().lastQualifierFetch).toBe(0);                         // and the list is stale
    await f.m.consumeQualifierCreditOnMaster('m2', 'weekly', 'q', 'entry');
    expect(f.m.qualifiedPlayers.get('weekly').some((p: any) => p.playerId === 'm2')).toBe(false);   // at 0: off the list, as a read lists him
    expect(await f.m.consumeQualifierCreditOnMaster('m2', 'weekly', 'q', 're-entry')).toEqual({ consumed: false, creditId: undefined });
    expect(f.count('m2')).toBe(0);

    expect(await f.m.refundQualifierCreditOnMaster('a1')).toBe(true);       // a refused entry: his credit back
    expect(f.count('m1')).toBe(2);
    expect(await f.m.refundQualifierCreditOnMaster('b1')).toBe(true);
    expect(f.count('m2')).toBe(1);                                          // back on the list
    expect(await f.m.issueQualifierCreditOnMaster('m3', 'weekly', '[entry-code:X]')).toMatchObject({ issued: true });
    expect(f.count('m3')).toBe(1);
    // A credit an EARLIER process consumed (its owner unknown here): the list is only marked stale.
    const before = f.m.qualifiedPlayers.get('weekly').map((p: any) => [p.playerId, p.creditCount]);
    expect(await f.m.refundQualifierCreditOnMaster('from-an-earlier-process')).toBe(true);
    expect(f.m.qualifiedPlayers.get('weekly').map((p: any) => [p.playerId, p.creditCount])).toEqual(before);
    // A tier never read stays unknown (null), not invented.
    expect(await f.m.consumeQualifierCreditOnMaster('m1', 'monthly', 'q', 'entry')).toEqual({ consumed: true, creditId: 'c1' });
    expect(f.m.qualifiedPlayers.has('monthly')).toBe(false);
    expect(f.reads).toHaveLength(1);                                        // none of this read the 1.6 MB list
    // The next read is the master's word again (and matches).
    await f.m.getQualifiedPlayers('weekly');
    expect([f.count('m1'), f.count('m2'), f.count('m3')]).toEqual([2, 1, 1]);
  });

  it('a list read IN FLIGHT across a consume is not cached as fresh (it was, for 5 minutes, with the pre-consume count): it serves its caller; the next caller reads again', async () => {
    const f = master([{ id: 'a1', player_id: 'm1', tier: 'weekly' }, { id: 'a2', player_id: 'm1', tier: 'weekly' }]);
    await f.m.getQualifiedPlayers('weekly');
    clock += 6 * 60_000;                                                    // the cache expired
    f.ctl.holdReads = true;
    const inFlight = f.m.getQualifiedPlayers('weekly');                     // reads the master's 2 credits ...
    await flush();
    await f.m.consumeQualifierCreditOnMaster('m1', 'weekly', 'q', 'entry'); // ... while one is consumed
    expect(f.count('m1')).toBe(1);
    f.ctl.holdReads = false;
    f.held.splice(0).forEach((r) => r());
    const answer = await inFlight;
    expect(answer.find((p: any) => p.playerId === 'm1').creditCount).toBe(2);   // its caller gets the master's (older) word
    expect(f.count('m1')).toBe(1);                                          // the cache keeps the consume
    expect(f.m.state().lastQualifierFetch).toBe(0);                         // and stays stale
    await f.m.getQualifiedPlayers('weekly');                                // so the next caller reads again
    expect(f.reads).toHaveLength(3);
    expect(f.count('m1')).toBe(1);
    // CONTROL — a read with no change during it is cached fresh: no read for the next 5 minutes.
    clock += 60_000;
    await f.m.getQualifiedPlayers('weekly');
    expect(f.reads).toHaveLength(3);
  });

  it('a tier never read: a read across a change is still cached (better than nothing), but stale', async () => {
    const f = master([{ id: 'a1', player_id: 'm1', tier: 'weekly' }]);
    f.ctl.holdReads = true;
    const inFlight = f.m.getQualifiedPlayers('weekly');
    await flush();
    await f.m.issueQualifierCreditOnMaster('m2', 'weekly', '[entry-code:Y]');
    f.ctl.holdReads = false;
    f.held.splice(0).forEach((r) => r());
    await inFlight;
    expect(f.count('m1')).toBe(1);
    expect(f.m.state().lastQualifierFetch).toBe(0);
    await f.m.getQualifiedPlayers('weekly');
    expect([f.count('m1'), f.count('m2')]).toEqual([1, 1]);
    expect(f.reads).toHaveLength(2);
  });
});

describe('2026-10-21 (owner) — a SEAT PACKAGE: 1st 3 seats, 2nd-4th 2, 5th-10th 1', () => {
  const PKG = { 1: 3, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 };

  it('parseSeatPackage: the master\'s package; junk -> null', () => {
    expect(parseSeatPackage({ '1': 3, '2': 2, '3': 2, '4': 2, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1, '10': 1 })).toEqual(PKG);
    for (const bad of [null, undefined, 'x', [], {}, { 1: 0 }, { 0: 1 }, { 1: 1.5 }, { 1: 11 }]) expect(parseSeatPackage(bad)).toBeNull();
    expect(seatsForTopWith('weekly', PKG)).toBe(10);
    expect(seatsForTopWith('weekly', null)).toBe(3);
    expect([1, 2, 4, 5, 10, 11].map((pl) => seatsWonAt('weekly', PKG, pl))).toEqual([3, 2, 2, 1, 1, 0]);
    expect([1, 3, 4].map((pl) => seatsWonAt('weekly', null, pl))).toEqual([1, 1, 0]);
  });

  function withPackage() {
    const w = world();
    const body = JSON.parse(JSON.stringify(MASTER_BODY));
    body.data.schedule[0].scheduledAt = new Date(Date.now() + H).toISOString();
    body.data.schedule[0].seatPackage = { '1': 3, '2': 2, '3': 2, '4': 2, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1, '10': 1 };
    w.m.applyQualifierSchedule(parseMasterSchedule(body), Date.now());
    return { w, body };
  }

  it('the lobby item shows it: seatsForTop 10 + seatPackage; a re-sync without it falls back to the standard top 3', () => {
    const { w, body } = withPackage();
    expect(w.m.qualifierList(null)[0]).toMatchObject({ qualifierId: WEEKLY, seatsForTop: 10, seatPackage: PKG });
    delete body.data.schedule[0].seatPackage;
    w.m.applyQualifierSchedule(parseMasterSchedule(body), Date.now());
    expect(w.m.qualifierList(null)[0]).toMatchObject({ seatsForTop: 3, seatPackage: null });
  });

  it('results: places 1-10 win, each told how many seats; 11th does not', () => {
    const { w } = withPackage();
    const qt = w.qualifierTournaments.get(WEEKLY);
    Object.assign(qt, {
      status: 'running', tournamentId: 'TQ',
      players: Array.from({ length: 12 }, (_, i) => ({ playerId: `user-${400 + i}`, masterPlayerId: `m-${i + 1}`, playerName: `P${i + 1}`, phone: '', socketId: `S${i + 1}` })),
    });
    const data = { tournamentId: 'TQ', results: Array.from({ length: 12 }, (_, i) => ({ playerId: `user-${400 + i}`, playerName: `P${i + 1}`, position: i + 1, payout: 0 })) };
    const s1 = w.mkSocket('S1x', 401, 'm-1', 'P1');
    const s2 = w.mkSocket('S2x', 402, 'm-2', 'P2');
    const s11 = w.mkSocket('S11x', 411, 'm-11', 'P11');
    w.m.markQualifierFinished('TQ', data);
    expect(w.of('S1x', 'qualifierResults')[0]).toMatchObject({ myResult: { place: 1, wonSeat: true, seats: 3 }, seatsForTop: 10, seatPackage: PKG });
    expect(w.of('S2x', 'qualifierResults')[0]).toMatchObject({ myResult: { place: 2, wonSeat: true, seats: 2 } });
    expect(w.of('S11x', 'qualifierResults')[0]).toMatchObject({ myResult: { place: 11, wonSeat: false, seats: 0 }, wonSeat: false });
    expect(w.of('S1x', 'qualifierResults')[0].results.map((r: any) => r.seats)).toEqual([3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(w.m.qualifierList('m-4')[0]).toMatchObject({ myResult: { place: 4, wonSeat: true, seats: 2 } });
    void s1; void s2; void s11;
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

describe('F95 (2026-10-21) — a late entry or re-entry seated at an IDLE table gets that table\'s next deal scheduled', () => {
  /**
   * Q1: Bob alone alive (Carl busted — his seat occupied at 0 chips), its hand
   * over and nothing scheduled: it waits for a rebalance that cannot come (Q2,
   * Dan + Eve, plays on). With
   * `aliceBusted`, Alice entered late and busted (no seat left: she re-enters).
   */
  function idle(phase: GamePhase = GamePhase.HandComplete, aliceBusted = false) {
    const w = world();
    w.sync(Date.now() - 10 * 60_000);
    const qt = w.qualifierTournaments.get(WEEKLY);
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    w.tm.registerPlayer(tid, 'user-201', 'Bob', 'sb', undefined, 'm-201');
    w.tm.registerPlayer(tid, 'user-202', 'Carl', 'sc', undefined, 'm-202');
    w.tm.registerPlayer(tid, 'user-203', 'Dan', 'sd', undefined, 'm-203');
    w.tm.registerPlayer(tid, 'user-204', 'Eve', 'se', undefined, 'm-204');
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    t.sitDown(0, 'Bob', 100_000, 'user-201', false, true);
    t.sitDown(1, 'Carl', 50_000, 'user-202', false, true);
    const t2 = new PokerTable({ tableId: 'Q2', tableName: 'Q2', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    t2.sitDown(0, 'Dan', 50_000, 'user-203', false, true);
    t2.sitDown(1, 'Eve', 50_000, 'user-204', false, true);
    w.tables.set('Q1', t);
    w.tables.set('Q2', t2);
    w.tm.setTableIds(tid, ['Q1', 'Q2']);
    w.tm.setPlayerTable(tid, 'user-201', 'Q1');
    w.tm.setPlayerTable(tid, 'user-202', 'Q1');
    w.tm.setPlayerTable(tid, 'user-203', 'Q2');
    w.tm.setPlayerTable(tid, 'user-204', 'Q2');
    w.tm.eliminatePlayer(tid, 'user-202');
    t.seats[1].chipCount = 0;
    t.seats[1].eliminated = true;
    (t as any).currentPhase = phase;
    Object.assign(qt, {
      status: 'running', tournamentId: tid,
      players: [
        { playerId: 'user-201', masterPlayerId: 'm-201', playerName: 'Bob', phone: '', socketId: 'sb' },
        { playerId: 'user-202', masterPlayerId: 'm-202', playerName: 'Carl', phone: '', socketId: 'sc' },
        { playerId: 'user-203', masterPlayerId: 'm-203', playerName: 'Dan', phone: '', socketId: 'sd' },
        { playerId: 'user-204', masterPlayerId: 'm-204', playerName: 'Eve', phone: '', socketId: 'se' },
      ],
    });
    if (aliceBusted) {
      w.tm.addLateEntrant(tid, 'user-101', 'Alice', 'old', 50_000, { masterUserId: 'm-alice' });
      qt.players.push({ playerId: 'user-101', masterPlayerId: 'm-alice', playerName: 'Alice', phone: '', socketId: 'old', reEntries: 0 });
      w.tm.eliminatePlayer(tid, 'user-101');
    }
    expect(w.tm.getTournament(tid)!.status).toBe('running');
    const scheduled: string[] = [];
    const pendingAutoStartTimers = new Map<string, any>();
    Object.assign(w.scope, { GamePhase, pendingAutoStartTimers, scheduleAutoStart: (id: string) => { scheduled.push(id); } });
    return { w, tid, t, qt, scheduled, pendingAutoStartTimers };
  }

  it('a LATE ENTRY onto the idle table: seated on the busted seat AND the table\'s deal is scheduled (it sat frozen: nothing ever dealt it)', async () => {
    const { w, t, scheduled } = idle();
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(t.seats[1]).toMatchObject({ state: 'occupied', playerId: 'user-101', chipCount: 50_000 });
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, lateEntry: true, tableId: 'Q1' })]);
    // Old: [] — scheduled by nothing.
    expect(scheduled).toEqual(['Q1']);
  });

  it('a RE-ENTRY onto the idle table: seated on its empty seat AND the deal is scheduled', async () => {
    const { w, t, scheduled } = idle(GamePhase.HandComplete, true);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await flush();
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, reentry: true, tableId: 'Q1' })]);
    expect(t.seats.find((s) => s.state === 'occupied' && !s.eliminated && s.playerId === 'user-101')).toMatchObject({ chipCount: 50_000 });
    // Old: [].
    expect(scheduled).toEqual(['Q1']);
  });

  it('a table MID-HAND (the normal case) or one whose deal is already scheduled is left alone', async () => {
    const mid = idle(GamePhase.PreFlop);
    await mid.w.mkSocket('SA', ALICE, 'm-alice', 'Alice').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(mid.t.seats[1]).toMatchObject({ playerId: 'user-101' });
    expect(mid.scheduled).toEqual([]);
    const already = idle();
    const pending = setTimeout(() => {}, 1500);
    already.pendingAutoStartTimers.set('Q1', pending);
    await already.w.mkSocket('SA', ALICE, 'm-alice', 'Alice').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    clearTimeout(pending);
    expect(already.t.seats[1]).toMatchObject({ playerId: 'user-101' });
    expect(already.scheduled).toEqual([]);
  });
});

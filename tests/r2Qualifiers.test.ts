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
  QUALIFIER_OVERFLOW_TABLES_MAX, qualifierOverflowTablesCap, parseQualifierOverflowCapUpdate, qualifierOverflowCapLabel,
} from '../src/game/qualifierSchedule';
import { samplePresence, partitionByPresence, QUALIFIER_PRESENCE_LEAD_MS } from '../src/game/qualifierNoShow';
import { SRC, slice, fnSrc, handlerSrc, load, flush, deferred } from './helpers/indexSource';
// Review fix-up (ff9a1cb) — the runtime overflow cap's X-Internal-Token check.
import { createHash, timingSafeEqual } from 'crypto';

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
  // 2026-10-23 (qualifier lifecycle S1) — the on-time start timer's state.
  slice('const QUALIFIER_START_TIMER_LEAD_MS', ';\n'),
  slice('const qualifierStartTimers = new Map', ';\n'),
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
  // 2026-10-22 (owner: "Build it for Sunday") — every seat alive: an OVERFLOW table
  // (its state + the helpers it shares with the rebalance block, the REAL source).
  slice('const qualifierOverflowTables = new Map', ';\n'),
  slice('const qualifierOverflow = {', ';\n'),
  slice('const qualifierOverflowTableNumbers = new Map', ';\n'),
  fnSrc('function tournamentFreeSeats('),
  fnSrc('function nextQualifierTableNumber('),
  fnSrc('function openQualifierOverflowTable('),
  fnSrc('function closeUnusedQualifierOverflowTable('),
  fnSrc('function seatQualifierLateEntrantOnOverflowTable('),
  fnSrc('function seatQualifierReentrantOnOverflowTable('),
  fnSrc('function qualifierOverflowSeatFlags('),
  fnSrc('function startFreshTournamentTable('),
  // Review fix-up (ff9a1cb) — the runtime cap / kill switch: its setter, the
  // token check and the REAL route (registered on the world's fake `app`).
  fnSrc('function setQualifierOverflowTablesMax('),
  fnSrc('function internalTokenMatches('),
  slice("app.post('/api/qualifiers/overflow'", '\n});\n'),
].join('\n');
/**
 * Review fix-up (ff9a1cb) — the REAL tournament deal hold (it used to be a stub
 * that always allowed the deal) and what it reads: the rebalance plan, the
 * bust-check wait. Appended only for worlds built with `realDealHold`.
 */
const REAL_DEAL_HOLD = [
  fnSrc('function tournamentDealHoldReason('),
  fnSrc('function tournamentDealWaitsForBustCheck('),
  fnSrc('function tournamentUnsettledBustSeat('),
  fnSrc('function tournamentEntrantHasLiveSeat('),
  fnSrc('function planTournamentRebalance('),
].join('\n');
const HANDLERS = ['registerQualifierTournament', 'unregisterQualifierTournament', 'getQualifierTournaments', 'spectateTournament']
  .map((ev) => handlerSrc(ev, '\n  });\n')).join('\n  ');

const ALICE = 101;
const BOB = 102;

function world(opts: {
  now?: number;
  /**
   * 2026-10-22 — QUALIFIER_OVERFLOW_TABLES_MAX for this world. Default 0 = the
   * kill switch: every test written before overflow tables keeps its meaning
   * (every seat alive → no_seat, the credit returned).
   */
  overflowMax?: number;
  /** The new table cannot seat anyone ('zeroSeats') or cannot be created ('throw'). */
  overflowCreate?: 'zeroSeats' | 'throw';
  /** The new table's usable seats (default 9). */
  overflowSeats?: number;
  /**
   * Review fix-up (ff9a1cb) — run the REAL tournamentDealHoldReason (+ the
   * rebalance plan it asks). Default: the old stub that always allows the deal.
   */
  realDealHold?: boolean;
} = {}) {
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
  // 2026-10-22 — overflow tables: the tables it creates (a REAL PokerTable each), listeners, AI kicks.
  const overflowCreates: Array<{ name: string; max: number; sb: number; bb: number; minBuyIn: number; variant: unknown; ante: number }> = [];
  const tableProgressListeners = new Set<string>();
  const progressListeners: string[] = [];
  const aiKicks: string[] = [];
  let overflowN = 0;
  const scope: Record<string, unknown> = {
    qualifierTournaments, tournamentManager: tm, authSessions, playerSessions, multiTableSessions, spectators,
    tableManager: {
      getTable: (id: string) => tables.get(id),
      createQuickTable: (name: string, max: number, sb: number, bb: number, minBuyIn: number, variant?: unknown, ante = 0) => {
        overflowCreates.push({ name, max, sb, bb, minBuyIn, variant, ante });
        if (opts.overflowCreate === 'throw') throw new Error('createQuickTable failed');
        const id = `OV${++overflowN}`;
        const t = new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante, minBuyIn, maxBuyIn: minBuyIn * 10, maxPlayers: max } as any);
        if (opts.overflowCreate === 'zeroSeats') t.maxOccupiableSeats = 0;
        else if (opts.overflowSeats !== undefined) t.maxOccupiableSeats = opts.overflowSeats;
        tables.set(id, t);
        return id;
      },
      removeTable: (id: string) => tables.delete(id),
    },
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
    // 2026-10-22 — overflow tables (the cap; the table's wiring; its first deal's gate).
    qualifierOverflowTablesMax: opts.overflowMax ?? 0,
    fastModeTables: new Map(), tableProgressListeners, GamePhase,
    ensureTableProgressListener: (_t: unknown, id: string) => { progressListeners.push(id); tableProgressListeners.add(id); },
    scheduleAIAction: (id: string) => { aiKicks.push(id); },
    // Review fix-up (ff9a1cb) — the REAL deal hold's state when `realDealHold` (else the old always-deal stub).
    ...(opts.realDealHold
      ? { tournamentBustChecksPending: new Map(), tournamentBreaksAwaitingHandEnd: new Map(), TOURNAMENT_BUST_CHECK_STALE_MS: 30_000, runTournamentBustCheck() {} }
      : { tournamentDealHoldReason: () => null }),
    // Review fix-up (ff9a1cb) — the runtime cap route registers on this fake express app.
    app: { post: (p: string, fn: (req: any, res: any) => void) => { routes.set(p, fn); } },
    createHash, timingSafeEqual, parseQualifierOverflowCapUpdate, qualifierOverflowCapLabel,
  };
  const routes = new Map<string, (req: any, res: any) => void>();
  const { exports: m } = load(`${CODE}\n${opts.realDealHold ? REAL_DEAL_HOLD : ''}\nfunction wire(socket) {\n  ${HANDLERS}\n}`, scope, `{
    wire, applyQualifierSchedule, qualifierList, qualifierEventFor, markQualifierFinished, emitTournamentFinishedToEntrants,
    tickQualifierAutoStart, postQualifierResults, cancelQualifierEvent, qualifierLateEntries, qualifierResultPosts,
    qualifierNoShows, tellQualifierNoShowReleases, qualifierCreditHeldByConcurrentEntry,
    qualifierOverflow, qualifierOverflowTables, openQualifierOverflowTable, startFreshTournamentTable, tournamentDealHoldReason,
    qualifierStartTimers,
  }`);
  /** POST /api/qualifiers/overflow through the REAL route: {status, body}. */
  const postOverflowCap = (body: unknown, token?: string) => {
    const out: { status: number; body: any } = { status: 200, body: null };
    const res = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
    routes.get('/api/qualifiers/overflow')!({ headers: token === undefined ? {} : { 'x-internal-token': token }, body }, res);
    return out;
  };
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
    qualifiedPlayers, overflowCreates, tableProgressListeners, progressListeners, aiKicks, postOverflowCap,
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

  // 2026-10-22 — B6: this world runs with QUALIFIER_OVERFLOW_TABLES_MAX = 0 (the
  // kill switch): exactly the behaviour before overflow tables.
  it('B6 CONTROL / kill switch (QUALIFIER_OVERFLOW_TABLES_MAX=0) — no seat free → the consumed credit goes back (no_seat) and he is NOT in the field; no table is opened', async () => {
    const { w, tid, qt } = running(false);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await a.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    expect(w.overflowCreates).toEqual([]);
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 0, refusedCap: 0, openFailed: 0 });
    expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1']);
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

  // 2026-10-22 — this world runs with the overflow kill switch (QUALIFIER_OVERFLOW_TABLES_MAX = 0); B8 is the same with overflow tables on.
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

describe('S1 (2026-10-23) — the start lands ON the scheduled second (it could be up to 30 s late)', () => {
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  /** Alice + Bob registered an hour before an 11:00:00 MDT start; the clock is jest's. */
  async function registered() {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const at = Date.parse('2026-10-25T17:00:00.000Z');
    jest.setSystemTime(at - H);
    const w = world();
    w.sync(at);
    await w.mkSocket('SA', ALICE, 'm-alice', 'Alice').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Alice' });
    await w.mkSocket('SB', BOB, 'm-bob', 'Bob').handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'Bob' });
    expect(w.qualifierTournaments.get(WEEKLY).players).toHaveLength(2);
    const startedAt: number[] = [];
    const stub = w.scope.startQualifierTournament as (players: any[], stack: number) => unknown;
    w.scope.startQualifierTournament = (players: any[], stack: number) => { startedAt.push(Date.now()); return stub(players, stack); };
    return { w, at, startedAt };
  }

  it('a tick 20 s before arms exactly ONE timer and a second tick arms none; the timer starts the event between 11:00:00 and 11:00:01', async () => {
    const { w, at, startedAt } = await registered();
    jest.setSystemTime(at - 20_000);
    const before = jest.getTimerCount();
    w.m.tickQualifierAutoStart(at - 60_000);                       // outside the last 30 s: nothing armed
    expect(jest.getTimerCount()).toBe(before);
    w.m.tickQualifierAutoStart(at - 20_000);
    expect(jest.getTimerCount()).toBe(before + 1);
    expect([...w.m.qualifierStartTimers.keys()]).toEqual([`${WEEKLY}|${new Date(at).toISOString()}`]);
    w.m.tickQualifierAutoStart(at - 15_000);                       // the next 30 s tick could land here too
    expect(jest.getTimerCount()).toBe(before + 1);
    expect(w.qualifierTournaments.get(WEEKLY).status).toBe('registering');
    expect(startedAt).toEqual([]);
    jest.advanceTimersByTime(20_000 + 250);                        // the clock reaches 11:00:00.250
    expect(startedAt).toHaveLength(1);
    expect(startedAt[0]).toBeGreaterThanOrEqual(at);
    expect(startedAt[0]).toBeLessThanOrEqual(at + 1000);
    expect(w.started).toHaveLength(1);
    expect(w.qualifierTournaments.get(WEEKLY)).toMatchObject({ status: 'running', tournamentId: 'TQ' });
    expect(w.m.qualifierStartTimers.size).toBe(0);                 // the key is dropped when it fires
    // A late 30 s tick right after it is harmless: the event already left 'registering'.
    w.m.tickQualifierAutoStart(at + 9_000);
    expect(w.started).toHaveLength(1);
  });

  it('a start the master MOVES gets its own timer; the old one only runs a tick that finds nothing due', async () => {
    const { w, at, startedAt } = await registered();
    jest.setSystemTime(at - 20_000);
    w.m.tickQualifierAutoStart(at - 20_000);
    w.sync(at + 60 * 60_000, at - 19_000);                          // moved one hour later, before it started
    jest.advanceTimersByTime(20_250);
    expect(startedAt).toEqual([]);
    expect(w.qualifierTournaments.get(WEEKLY).status).toBe('registering');
    expect(w.m.qualifierStartTimers.size).toBe(0);
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

// ───────────── 2026-10-22 (owner: "Build it for Sunday") — OVERFLOW tables ─────────────
describe('2026-10-22 (owner: "Build it for Sunday") — every seat alive: a late entry / re-entry opens an OVERFLOW table instead of a no_seat refund', () => {
  const MIN = 60_000;
  const enter = (s: any) => s.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'x' });
  const last = (w: any, sid: string, ev = 'qualifierRegistrationResult') => w.of(sid, ev).slice(-1)[0];

  /**
   * A RUNNING qualifier started 10 minutes ago: Bob (seat 0) + Carl (seat 1) at
   * 'Qualifier Table 1', `usable` seats there (2 = every seat taken), overflow
   * tables ON (cap 6) unless `overflowMax` says otherwise.
   */
  function full(o: { overflowMax?: number; usable?: number; overflowCreate?: 'zeroSeats' | 'throw'; overflowSeats?: number; realDealHold?: boolean } = {}) {
    const w = world({ overflowMax: o.overflowMax ?? 6, overflowCreate: o.overflowCreate, overflowSeats: o.overflowSeats, realDealHold: o.realDealHold });
    w.sync(Date.now() - 10 * MIN);
    const qt = w.qualifierTournaments.get(WEEKLY);
    expect(qt).toBeTruthy();
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 2, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    w.tm.registerPlayer(tid, 'user-201', 'Bob', 'sb', undefined, 'm-201');
    w.tm.registerPlayer(tid, 'user-202', 'Carl', 'sc', undefined, 'm-202');
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Qualifier Table 1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    t.maxOccupiableSeats = o.usable ?? 2;
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
  /**
   * Review fix-up (ff9a1cb) — the PRODUCTION shape: Q1 a real 9-seat table with
   * every seat alive (P201 … P209, user-201 … user-209, masters m-201 … m-209)
   * and the REAL tournament deal hold (no stub).
   */
  const NINE = [201, 202, 203, 204, 205, 206, 207, 208, 209];
  function fullNine(o: { overflowMax?: number } = {}) {
    const w = world({ overflowMax: o.overflowMax ?? 6, realDealHold: true });
    w.sync(Date.now() - 10 * MIN);
    const qt = w.qualifierTournaments.get(WEEKLY);
    expect(qt).toBeTruthy();
    const tid = w.tm.createTournament({ name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: qualifierBlindLevels(50_000), startingChips: 50_000 } as any);
    for (const n of NINE) w.tm.registerPlayer(tid, `user-${n}`, `P${n}`, `s${n}`, undefined, `m-${n}`);
    w.tm.startTournament(tid);
    const t = new PokerTable({ tableId: 'Q1', tableName: 'Qualifier Table 1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
    NINE.forEach((n, i) => {
      expect(t.sitDown(i, `P${n}`, 50_000, `user-${n}`, false, true)).toBe(true);
      w.tm.setPlayerTable(tid, `user-${n}`, 'Q1');
    });
    w.tables.set('Q1', t);
    w.tournamentTables.set('Q1', tid);
    w.tm.setTableIds(tid, ['Q1']);
    Object.assign(qt, {
      status: 'running', tournamentId: tid,
      players: NINE.map((n) => ({ playerId: `user-${n}`, masterPlayerId: `m-${n}`, playerName: `P${n}`, phone: '', socketId: `s${n}` })),
    });
    return { w, qt, tid, t };
  }
  /** The bust check ran on `pid`'s LIVE seat at `t`: 0 chips, eliminated, the seat left occupied. */
  function bust(w: any, tid: string, t: PokerTable, pid: string): number {
    const i = t.seats.findIndex((s) => s.state === 'occupied' && !s.eliminated && s.playerId === pid);
    expect(i).toBeGreaterThanOrEqual(0);
    t.seats[i].chipCount = 0;
    (t.seats[i] as any).eliminated = true;
    w.tm.eliminatePlayer(tid, pid);
    return i;
  }
  /** `pid`'s live seats on every table of the world. */
  const liveSeats = (w: any, pid: string): string[] => [...(w.tables as Map<string, PokerTable>).entries()].flatMap(([id, t]) =>
    t.seats.filter((s) => s.state === 'occupied' && !s.eliminated && s.playerId === pid).map((s) => `${id}:${s.seatIndex}`));
  const entrant = (w: any, tid: string, pid: string) => w.tm.getTournament(tid)!.players.find((p: any) => p.playerId === pid);

  // 2026-10-23 — owner (2026-10-22): "No cap on extra tables". Default = unlimited; 0 = off; no upper clamp.
  it('B1 — the cap: QUALIFIER_OVERFLOW_TABLES_MAX = unlimited (Infinity); a number sets a cap (floored, >= 0, no upper clamp); 0 = off; garbage → unlimited', () => {
    expect(QUALIFIER_OVERFLOW_TABLES_MAX).toBe(Infinity);
    expect([undefined, '', '  ', 'x', 'NaN', 'Infinity', 'unlimited', ' UNLIMITED '].map((v) => qualifierOverflowTablesCap(v))).toEqual(Array(8).fill(Infinity));
    expect(['0', '3', '2.7', '99', '-2', ' 4 '].map((v) => qualifierOverflowTablesCap(v))).toEqual([0, 3, 2, 99, 0, 4]);
    // Review fix-up (ff9a1cb) — the RUNTIME value (POST /api/qualifiers/overflow): garbage is refused (null); "unlimited" = no cap.
    expect([0, 3, '2', 2.7, 99, -1, ' 4 ', 'unlimited', 'Unlimited'].map((v) => parseQualifierOverflowCapUpdate(v))).toEqual([0, 3, 2, 2, 99, 0, 4, Infinity, Infinity]);
    expect([undefined, null, '', ' ', 'x', 'NaN', 'Infinity', Infinity, NaN, true, {}, [1]].map((v) => parseQualifierOverflowCapUpdate(v))).toEqual(Array(12).fill(null));
    expect([0, 6, Infinity].map((v) => qualifierOverflowCapLabel(v))).toEqual([0, 6, 'unlimited']);
  });

  it('B2 — a late entry with every seat alive: a NEW table at the CURRENT level, he is seated there (one credit, kept), told overflowTable + waitingForPlayers; the one bootstrap listener is not re-registered', async () => {
    const { w, qt, tid } = full();
    w.tm.advanceLevel(tid);
    w.tm.advanceLevel(tid);                                                   // level 3: 75/150, ante 25
    const onEvent = jest.spyOn(w.tm, 'onEvent');
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    // Old: no_seat, credit-1 refunded.
    expect(w.overflowCreates).toEqual([{ name: 'Qualifier Table 2', max: 9, sb: 75, bb: 150, minBuyIn: 50_000, variant: undefined, ante: 25 }]);
    expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1', 'OV1']);
    expect(w.tournamentTables.get('OV1')).toBe(tid);
    expect(w.m.qualifierOverflowTables.get('OV1')).toBe(tid);
    expect(w.progressListeners).toEqual(['OV1']);                             // its progress listener (bust check, hand results)
    expect(onEvent).not.toHaveBeenCalled();                                   // never a second tournament listener
    const OV = w.tables.get('OV1')!;
    expect(OV.config).toMatchObject({ smallBlind: 75, bigBlind: 150, ante: 25, minBuyIn: 50_000 });
    expect(OV.seats[0]).toMatchObject({ state: 'occupied', playerId: 'user-101', chipCount: 50_000 });
    expect(entrant(w, tid, 'user-101')).toMatchObject({ eliminated: false, masterUserId: 'm-alice' });
    expect(w.tm.getTournament(tid)!.playerTableMap.get('user-101')).toBe('OV1');
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'OV1', seatIndex: 0, playerId: 'user-101' });
    expect(a.rooms.has('table:OV1')).toBe(true);
    expect(w.consumed.map((c) => c.label)).toEqual(['entry']);
    expect(w.creditRefunds).toEqual([]);
    expect(qt.players.map((p: any) => p.playerId)).toEqual(['user-201', 'user-202', 'user-101']);
    expect(w.of('SA', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({
      success: true, lateEntry: true, tableId: 'OV1', tournamentId: tid, overflowTable: true, waitingForPlayers: true,
    })]);
    expect(w.of('SA', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({
      tableId: 'OV1', tableCount: 2, lateEntry: true, overflowTable: true, waitingForPlayers: true,
    })]);
    expect(OV.currentPhase).toBe(GamePhase.WaitingForPlayers);                // alone: no hand, no blinds
    expect(OV.handNumber).toBe(0);
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 1, lateEntriesSeated: 1, firstDeals: 0, refusedCap: 0, openFailed: 0, closedUnused: 0 });
    expect(w.m.qualifierLateEntries).toMatchObject({ seated: 1, refundedNoSeat: 0 });
    expect(w.audits.find((x) => x.action === 'QUALIFIER_LATE_ENTRY_SEATED')?.d).toMatchObject({ tableId: 'OV1', overflowTable: true });
  });

  it('B3 — a second late entrant joins THAT table (no second table): its FIRST hand is dealt through the REAL deal hold, right AFTER his registration is recorded and told; he is not told "waiting"', async () => {
    // Review fix-up (ff9a1cb): production-shaped (9-seat Q1, every seat alive) with the REAL
    // tournamentDealHoldReason — this test used to run against a stub that always allowed the deal.
    const { w, tid, qt } = fullNine();
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    expect(w.overflowCreates).toHaveLength(1);
    const OV = w.tables.get('OV1')!;
    expect(OV.seats[1]).toMatchObject({ state: 'occupied', playerId: 'user-103' });
    // His registration is complete before anything is dealt (the first deal is deferred): recorded, told, credit kept.
    expect(qt.players.map((p: any) => p.playerId)).toContain('user-103');
    const res = last(w, 'SD');
    expect(res).toEqual(expect.objectContaining({ success: true, lateEntry: true, tableId: 'OV1', overflowTable: true }));
    expect(res.waitingForPlayers).toBeUndefined();
    const started = last(w, 'SD', 'qualifierTournamentStarted');
    expect(started).toEqual(expect.objectContaining({ tableId: 'OV1', tableCount: 2, overflowTable: true }));
    expect(started.waitingForPlayers).toBeUndefined();
    expect(OV.handNumber).toBe(0);                                            // ff9a1cb: dealt INSIDE the handler, before all of the above
    // The REAL hold lets it deal: 11 alive on 2 tables — Rule 1 (11 > 9) and Rule 2 (Q1 has no room for OV1's 2) plan nothing.
    expect(w.m.tournamentDealHoldReason('OV1', tid, OV)).toBeNull();
    await flush();
    expect(OV.handNumber).toBe(1);
    expect(OV.currentPhase).toBe(GamePhase.PreFlop);
    expect(OV.seats.filter((s) => s.state === 'occupied' && s.holeCards.length === 2)).toHaveLength(2);
    expect(w.aiKicks).toEqual(['OV1']);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 1, firstDeals: 1, lateEntriesSeated: 1, firstDealErrors: 0 });
  });

  it('B3 CONTROL — the toy world (Q1 has 2 usable seats) under the REAL hold: 4 alive fit one table, so Rule 1 plans a break and OV1\'s first deal waits for it (rebalance_pending) — the old stub hid this', async () => {
    const { w, tid } = full({ realDealHold: true });
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    await flush();
    const OV = w.tables.get('OV1')!;
    expect(OV.seats.filter((s) => s.state === 'occupied')).toHaveLength(2);
    expect(w.m.tournamentDealHoldReason('OV1', tid, OV)).toBe('rebalance_pending');
    expect(OV.handNumber).toBe(0);
    expect(w.m.qualifierOverflow.firstDeals).toBe(0);
  });

  it('B11 — a RE-ENTRY onto a lone overflow table (production shape, REAL hold): seated on its empty seat, his re-entry recorded and told FIRST, then the table\'s first hand is dealt', async () => {
    const { w, tid, t, qt } = fullNine();
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));                // OV1: Alice alone, waiting
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ tableId: 'OV1', waitingForPlayers: true }));
    bust(w, tid, t, 'user-201');                                              // P201 out at Q1 (his seat busted)
    const b = w.mkSocket('S201', 201, 'm-201', 'P201');
    await enter(b);                                                           // the empty-seat search finds OV1 seat 1 first
    const OV = w.tables.get('OV1')!;
    expect(OV.seats[1]).toMatchObject({ state: 'occupied', playerId: 'user-201', chipCount: 50_000 });
    expect(liveSeats(w, 'user-201')).toEqual(['OV1:1']);
    // Recorded (refundable by the shutdown flush) and told BEFORE the deal.
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-201')).toMatchObject({ reEntries: 1, reentryCreditIds: ['credit-2'] });
    expect(last(w, 'S201')).toEqual(expect.objectContaining({ success: true, reentry: true, tableId: 'OV1', overflowTable: true }));
    expect(last(w, 'S201').waitingForPlayers).toBeUndefined();
    expect(last(w, 'S201', 'qualifierTournamentStarted')).toEqual(expect.objectContaining({ tableId: 'OV1', reentry: true, overflowTable: true }));
    expect(OV.handNumber).toBe(0);
    expect(w.m.tournamentDealHoldReason('OV1', tid, OV)).toBeNull();          // 8 + 2 alive; Q1's 1 busted seat cannot take OV1's 2
    await flush();
    expect(OV.handNumber).toBe(1);
    expect(OV.seats.filter((s) => s.state === 'occupied' && s.holeCards.length === 2)).toHaveLength(2);
    expect(w.creditRefunds).toEqual([]);
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 're-entry']);
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 1, firstDeals: 1, firstDealErrors: 0 });
  });

  it('B12 — the first deal THROWS (late entry, then re-entry): the registration is recorded, told and keeps its credit; nothing escapes; firstDealErrors counts it and the 5s sweep deals the table later', async () => {
    const { w, tid, t, qt } = fullNine();
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    await flush();                                                            // her own (deferred) seat hook: alone, nothing to deal
    const OV = w.tables.get('OV1')!;
    const realStart = OV.startNewHand.bind(OV);
    OV.startNewHand = () => { throw new Error('deal boom'); };
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    await flush();
    expect(qt.players.map((p: any) => p.playerId)).toContain('user-103');
    expect(last(w, 'SD')).toEqual(expect.objectContaining({ success: true, lateEntry: true, tableId: 'OV1' }));
    expect(w.m.qualifierLateEntries.seated).toBe(2);
    expect(OV.handNumber).toBe(0);
    expect(w.m.qualifierOverflow).toMatchObject({ firstDeals: 0, firstDealErrors: 1 });
    // A re-entry whose seat hook hits the same throwing deal: still recorded (the shutdown flush refunds by these ids).
    bust(w, tid, t, 'user-202');
    await enter(w.mkSocket('S202', 202, 'm-202', 'P202'));
    await flush();
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-202')).toMatchObject({ reEntries: 1, reentryCreditIds: ['credit-3'] });
    expect(last(w, 'S202')).toEqual(expect.objectContaining({ success: true, reentry: true, tableId: 'OV1' }));
    expect(w.m.qualifierOverflow.firstDealErrors).toBe(2);
    expect(w.creditRefunds).toEqual([]);
    // The backstop (the 5s sweep calls this) deals it once the deal works again.
    OV.startNewHand = realStart;
    expect(w.m.startFreshTournamentTable('OV1')).toBe(true);
    expect(OV.handNumber).toBe(1);
    expect(w.m.qualifierOverflow.firstDeals).toBe(1);
  });

  it('B13 — the runtime kill switch / cap (no restart): POST /api/qualifiers/overflow with the internal token; refused without it (fails closed) or with a bad value; 0 = the old no_seat refund, raised again = a new table', async () => {
    const { w, tid, qt } = fullNine({ overflowMax: Infinity });   // 2026-10-23: the new default (owner: no cap)
    const before = w.m.qualifierOverflow.capChanges;
    // Refused: no token, a wrong one, and (fails closed) any token when none is configured — nothing changes.
    expect(w.postOverflowCap({ max: 0 })).toEqual({ status: 403, body: { success: false, error: 'forbidden' } });
    expect(w.postOverflowCap({ max: 0 }, 'wrong')).toMatchObject({ status: 403 });
    const env = (w.scope.process as any).env;
    env.INTERNAL_NOTIFY_TOKEN = '';
    expect(w.postOverflowCap({ max: 0 }, '')).toMatchObject({ status: 403 });
    env.INTERNAL_NOTIFY_TOKEN = 't';
    for (const bad of [undefined, null, '', ' ', 'off', 'NaN', {}, [3], true]) {
      expect(w.postOverflowCap({ max: bad }, 't')).toMatchObject({ status: 400, body: { success: false, cap: 'unlimited' } });
    }
    expect(w.scope.qualifierOverflowTablesMax).toBe(Infinity);
    expect(w.m.qualifierOverflow.capChanges).toBe(before);
    // OFF at runtime: a late entry with every seat alive → exactly the pre-overflow no_seat, one refund, no table.
    expect(w.postOverflowCap({ max: 0 }, 't')).toEqual({ status: 200, body: { success: true, previous: 'unlimited', cap: 0, live: 0 } });
    expect(w.scope.qualifierOverflowTablesMax).toBe(0);
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'no_seat' }));
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.overflowCreates).toEqual([]);
    expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1']);
    expect(qt.players).toHaveLength(9);
    // Back ON (a numeric string, clamped like the env): the next arrival gets a table.
    expect(w.postOverflowCap({ max: '2' }, 't')).toEqual({ status: 200, body: { success: true, previous: 0, cap: 2, live: 0 } });
    expect(w.postOverflowCap({ max: 99 }, 't').body).toMatchObject({ cap: 99 });             // no upper clamp any more
    expect(w.postOverflowCap({ max: 'unlimited' }, 't').body).toMatchObject({ previous: 99, cap: 'unlimited' });
    expect(w.postOverflowCap({ max: 2.9 }, 't').body).toMatchObject({ previous: 'unlimited', cap: 2 });
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    expect(last(w, 'SD')).toEqual(expect.objectContaining({ success: true, lateEntry: true, tableId: 'OV1', overflowTable: true }));
    expect(w.m.qualifierOverflow.capChanges).toBe(before + 5);
    expect(w.audits.filter((x) => x.action === 'QUALIFIER_OVERFLOW_CAP_SET').map((x) => [x.d.previous, x.d.cap])).toEqual([['unlimited', 0], [0, 2], [2, 99], [99, 'unlimited'], ['unlimited', 2]]);
  });

  it('B4 CONTROL — a free seat anywhere (an empty one, or a busted one) → no table is opened; that seat is used', async () => {
    const empty = full({ usable: 3 });
    await enter(empty.w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    expect(empty.t.seats[2]).toMatchObject({ playerId: 'user-101' });
    expect(empty.w.overflowCreates).toEqual([]);
    expect(empty.w.of('SA', 'qualifierRegistrationResult')[0].overflowTable).toBeUndefined();

    const busted = full({ usable: 3 });
    await enter(busted.w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    bust(busted.w, busted.tid, busted.t, 'user-202');                         // Carl's seat 1: busted
    await enter(busted.w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    expect(busted.t.seats[1]).toMatchObject({ playerId: 'user-103', chipCount: 50_000, eliminated: false });
    expect(busted.w.overflowCreates).toEqual([]);
    expect(busted.w.m.qualifierOverflow.opened).toBe(0);
    expect(busted.w.creditRefunds).toEqual([]);
  });

  it('B5 — the cap reached (cap 1, its table full) → no_seat: the credit refunded exactly once, not in the field, no table created', async () => {
    const { w, tid, qt } = full({ overflowMax: 1, overflowSeats: 1 });
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));                // opens OV1 (1 usable seat) — now full
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    expect(last(w, 'SD')).toEqual(expect.objectContaining({ success: false, code: 'no_seat' }));
    expect(w.creditRefunds).toEqual(['credit-2']);
    expect(w.overflowCreates).toHaveLength(1);
    expect(w.tm.getTournament(tid)!.players.map((p: any) => p.playerId)).not.toContain('user-103');
    expect(qt.players.map((p: any) => p.playerId)).not.toContain('user-103');
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 1, refusedCap: 1 });
    expect(w.m.qualifierLateEntries.refundedNoSeat).toBe(1);
  });

  it('B6 CONTROL / kill switch — cap 0 (QUALIFIER_OVERFLOW_TABLES_MAX=0): exactly the pre-overflow no_seat with one refund', async () => {
    const { w, tid, qt } = full({ overflowMax: 0 });
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'no_seat' }));
    expect(w.creditRefunds).toEqual(['credit-1']);
    expect(w.overflowCreates).toEqual([]);
    expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1']);
    expect(qt.players).toHaveLength(2);
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 0, refusedCap: 0 });
  });

  it('B7 — the new table cannot seat him (no usable seat) or cannot be created (throws): it is gone again, the credit refunded once, no_seat', async () => {
    for (const mode of ['zeroSeats', 'throw'] as const) {
      const { w, tid, qt } = full({ overflowCreate: mode });
      await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
      expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: false, code: 'no_seat' }));
      expect(w.creditRefunds).toEqual(['credit-1']);
      expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1']);
      expect(w.tournamentTables.has('OV1')).toBe(false);
      expect(w.m.qualifierOverflowTables.has('OV1')).toBe(false);
      expect(w.tables.has('OV1')).toBe(false);
      expect(w.tableProgressListeners.has('OV1')).toBe(false);
      expect(w.tm.getTournament(tid)!.players.map((p: any) => p.playerId)).not.toContain('user-101');
      expect(qt.players).toHaveLength(2);
      expect(w.playerSessions.has('SA')).toBe(false);
      if (mode === 'zeroSeats') expect(w.m.qualifierOverflow).toMatchObject({ opened: 1, closedUnused: 1, openFailed: 0 });
      else expect(w.m.qualifierOverflow).toMatchObject({ opened: 0, openFailed: 1 });
    }
  });

  it('B8 — a RE-ENTRY with every seat alive (her dead seat taken by a late entrant) → a NEW table: reinstated (places stay 1..N), one credit kept, told overflowTable + waitingForPlayers', async () => {
    const { w, tid, t, qt } = full({ usable: 3 });
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);                                                           // Alice: seat 2, credit-1
    expect(bust(w, tid, t, 'user-101')).toBe(2);
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));                       // Dan takes her busted seat 2, credit-2
    expect(t.seats[2]).toMatchObject({ playerId: 'user-103', eliminated: false });
    await enter(a);                                                           // credit-3 — old: no_seat, refunded
    expect(last(w, 'SA')).toEqual(expect.objectContaining({ success: true, reentry: true, tableId: 'OV1', overflowTable: true, waitingForPlayers: true }));
    expect(last(w, 'SA', 'qualifierTournamentStarted')).toEqual(expect.objectContaining({
      tableId: 'OV1', tableCount: 2, lateEntry: true, reentry: true, overflowTable: true, waitingForPlayers: true,
    }));
    expect(w.tables.get('OV1')!.seats[0]).toMatchObject({ state: 'occupied', playerId: 'user-101', chipCount: 50_000, eliminated: false });
    expect(liveSeats(w, 'user-101')).toEqual(['OV1:0']);
    expect(entrant(w, tid, 'user-101')).toMatchObject({ eliminated: false, finishPosition: 0, chips: 50_000 });
    expect(w.tm.getTournament(tid)!.playerTableMap.get('user-101')).toBe('OV1');
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'OV1', seatIndex: 0, playerId: 'user-101' });
    expect(a.rooms.has('table:OV1')).toBe(true);
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 'entry', 're-entry']);
    expect(w.creditRefunds).toEqual([]);
    expect(qt.players.find((p: any) => p.masterPlayerId === 'm-alice')).toMatchObject({ reEntries: 1, reentryCreditIds: ['credit-3'] });
    expect(w.m.qualifierOverflow).toMatchObject({ opened: 1, reentriesSeated: 1 });
    bust(w, tid, t, 'user-202');                                              // 4 entrants: Carl is out 4th
    expect(entrant(w, tid, 'user-202')!.finishPosition).toBe(4);
  });

  it('B9 — two tabs re-enter at once with every seat alive: ONE live seat on ONE new table; the second tab is refused already_registered and its credit refunded', async () => {
    const { w, tid, t } = full({ usable: 3 });
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    bust(w, tid, t, 'user-101');
    await enter(w.mkSocket('SD', 103, 'm-dan', 'Dan'));
    const a2 = w.mkSocket('SA2', ALICE, 'm-alice', 'Alice');
    await Promise.all([enter(a), enter(a2)]);
    await flush();
    expect(w.overflowCreates).toHaveLength(1);
    expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1', 'OV1']);
    expect(liveSeats(w, 'user-101')).toEqual(['OV1:0']);
    expect(w.consumed.map((c) => c.label)).toEqual(['entry', 'entry', 're-entry', 're-entry']);
    expect(w.creditRefunds).toHaveLength(1);
    const results = [...w.of('SA', 'qualifierRegistrationResult').slice(1), ...w.of('SA2', 'qualifierRegistrationResult')];
    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ success: true, reentry: true, tableId: 'OV1', overflowTable: true }),
      expect.objectContaining({ success: false, code: 'already_registered' }),
    ]));
  });

  it('B10 — an overflow-seated late entrant is a tournament entrant like any other: a cancelled event refunds his credit once; the table is a tournament table', async () => {
    const { w, qt, tid } = full();
    await enter(w.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
    expect(w.tournamentTables.get('OV1')).toBe(tid);                          // never cashed out (isTournamentTable)
    await w.m.cancelQualifierEvent(WEEKLY, qt, 'test_cancel');
    await flush();
    expect(w.creditRefunds).toEqual(['credit-1']);
  });

  it('wiring — the overflow helpers sit OUTSIDE the late-entry slice; the handler falls back to them after the existing seat searches', () => {
    const lateSlice = slice('/** R2 (TOURNEY-9) — the answer when a qualifier seat would take over', '\n  return null;\n}\n');
    expect(lateSlice).toContain('function seatQualifierLateEntrant(');
    expect(lateSlice).not.toContain('function openQualifierOverflowTable(');
    // Review fix-up (ff9a1cb) — deferred: never dealt inside the registration that seated him.
    expect(lateSlice).toContain('if (table.currentPhase === GamePhase.WaitingForPlayers) { setImmediate(() => startFreshTournamentTable(tableId)); return; }');
    expect(lateSlice).not.toContain('{ startFreshTournamentTable(tableId); return; }');
    const h = handlerSrc('registerQualifierTournament', '\n  });\n');
    const late = h.indexOf('let seat = seatQualifierLateEntrant(socket, qt, registrant);');
    expect(late).toBeGreaterThan(0);
    expect(h.indexOf('if (!seat) seat = seatQualifierLateEntrantOnOverflowTable(socket, qt, registrant);')).toBeGreaterThan(late);
    const busted = h.indexOf('if (!seated && seatQualifierReentrantOnBustedSeat(socket, qt, tournament, existingEntry, startingStack)) seated = true;');
    expect(busted).toBeGreaterThan(0);
    expect(h.indexOf('if (!seated && seatQualifierReentrantOnOverflowTable(socket, qt, tournament, existingEntry, startingStack)) seated = true;')).toBeGreaterThan(busted);
    expect(fnSrc('function openQualifierOverflowTable(')).not.toContain('bootstrapTournamentTables(');
    expect(fnSrc('function openQualifierOverflowTable(')).not.toContain('tournamentManager.onEvent(');
  });
});

// ═══════════════════════════════ 2026-10-23 (qualifier lifecycle S4) — the EARLY ROOMS ══
// Owner 2026-10-22: "open the rooms 10 minutes before game start so people can
// join and then start the game on time". Before S4 the tables existed only from
// the first tick at / after the start second, and hand 1 was dealt in that same
// tick. Everything below runs the REAL src/index.ts source (the tick, the early
// rooms block, the screen, the register / Return / startHand handlers, the REAL
// startQualifierTournament + bootstrap listener, the rebalance helpers, the
// rebalance itself, the S3 clock and pause, the shutdown claims) with the REAL
// TournamentManager / PokerTable, under jest fake timers.
import { qualifierBreakConfig as s4BreakConfig, qualifierTestTimeScale as s4TimeScale, qualifierTablesOpenBeforeMin, parseQualifierTablesOpenUpdate, QUALIFIER_TABLES_OPEN_BEFORE_MIN } from '../src/game/qualifierSchedule';
import { partitionSuspendedRegistrants as s4PartitionSuspended } from '../src/auth/playGate';
import { randomInt as s4RandomInt } from 'crypto';
import { SEAT_SESSION_FOR_SRC as S4_SEAT_SESSION_FOR } from './helpers/indexSource';

const S4_CODE = [
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
  fnSrc('function pruneFinishedQualifiers('),
  slice('const qualifierNoShows = { released: 0, toldOnSignIn: 0 };', '\n    return 0;\n  }\n}\n'),
  slice('const QUALIFIER_START_TIMER_LEAD_MS', ';\n'),
  slice('const qualifierStartTimers = new Map', ';\n'),
  fnSrc('function tickQualifierAutoStart('),
  slice('// ===== Early rooms (qualifier lifecycle S4', '// ===== end early rooms =====\n'),
  // (without its 20 s interval: the tests run the screen themselves)
  slice('const QUALIFIER_SCREEN_LEAD_MS = 5 * 60 * 1000;', '\nsetInterval(() => tickQualifierScreens(), 20000);')
    .replace('setInterval(() => tickQualifierScreens(), 20000);', ''),
  fnSrc('function socketPlaysLiveSeatElsewhere('),
  fnSrc('function tournamentEntrantPlayerId('),
  slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n'),
  slice('const registrantBindings = ', '\n}\n'),
  fnSrc('function bindRegistrantSocket('),
  slice('const tournamentStartsKeptAbsent = { seats: 0 };', '\n  return true;\n}\n'),
  fnSrc('function seatQualifierReentrantOnBustedSeat('),
  fnSrc('function nextQualifierTableNumber('),
  fnSrc('function openQualifierOverflowTable('),
  fnSrc('function seatQualifierLateEntrantOnOverflowTable('),
  fnSrc('function seatQualifierReentrantOnOverflowTable('),
  fnSrc('function qualifierOverflowSeatFlags('),
  fnSrc('function internalTokenMatches('),
  slice('// ===== Tournament rebalance helpers', '// ===== end tournament rebalance helpers =====\n'),
  fnSrc('function handleTableRebalance(tournamentId: string): void {'),
  fnSrc('function sweepTournamentRebalances('),
  fnSrc('function startQualifierTournament('),
  slice('const tournamentBootstrapStats = {', ';\n'),
  fnSrc('function bootstrapTournamentTables('),
  slice('// ===== Director pause + scheduled breaks', '// ===== end director pause + scheduled breaks =====\n'),
  slice('// ===== Tournament level clock (qualifier lifecycle S3', '// ===== end tournament level clock =====\n'),
  fnSrc('function claimTournamentRefundsForShutdown('),
  fnSrc('function claimQuickAndQualifierRefundsForShutdown('),
].join('\n');
const S4_HANDLERS = ['registerQualifierTournament', 'returnToTournamentSeat', 'startHand', 'getQualifierTournaments', 'unregisterQualifierTournament']
  .map((ev) => handlerSrc(ev, '\n  });\n')).join('\n  ');
/**
 * S4 review fix-up — the held tables CLOSING (a cancel at the late close, the
 * operator's way back): the REAL table retirement and its view / timer teardown.
 * Opt-in (earlyRoomsWorld extraCode) so the worlds above stay exactly as they were.
 */
const S4_CLOSE_CODE = [
  slice('const finishedTournamentTablesRetired = { tables: 0 };', ';\n'),
  fnSrc('function retireFinishedTournamentTable('),
  fnSrc('function endTableViewsAndTimers('),
].join('\n');
/**
 * S4 review fix-up — the deal's rebind of a present seated entrant nobody plays:
 * the REAL seat restore by account (restoreAbsentTournamentSeat and its finders)
 * and the REAL sessionHoldsSeat (so liveSessionAt sees who sits where — the
 * default world's stub reads every seat as absent). Opt-in, as above.
 */
const S4_SEATS_CODE = [
  fnSrc('function sessionHoldsSeat('),
  fnSrc('function tournamentSeatLocationNow('),
  fnSrc('function absentTournamentSeatsOf('),
  fnSrc('function absentTournamentSeatOf('),
  fnSrc('function restoreAbsentTournamentSeat('),
  fnSrc('function tournamentSeatLeftVoluntarily('),
  fnSrc('function tournamentEntrantIsAccount('),
  fnSrc('function qualifierEntrantMasterId('),
].join('\n');

const S4_AT = Date.parse('2026-10-25T17:00:00.000Z');   // Sunday 11:00:00 MT
const S4_MIN = 60_000;

function earlyRoomsWorld(opts: { leadEnv?: string; overflowMax?: number; balance?: '0' | '1'; suspended?: string[]; screenGate?: Promise<void>; extraCode?: string } = {}) {
  jest.setSystemTime(S4_AT - 30 * S4_MIN);
  const qualifierTournaments = new Map<string, any>();
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const spectators = new Map<string, Set<string>>();
  const sockets = new Map<string, any>();
  const tournamentTables = new Map<string, string>();
  const globalEmits: Array<[string, any]> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const consumed: Array<{ masterId: string; tier: string; label: string }> = [];
  const creditRefunds: string[] = [];
  const fetches: Array<{ url: string; method: string; body: any }> = [];
  const logs: string[] = [];
  const broadcasts: string[] = [];
  const qualifiedCalls: string[] = [];
  const suspended = new Set<string>(opts.suspended || []);
  const routes = new Map<string, (req: any, res: any) => void>();
  let creditN = 0;
  let tableN = 0;
  const env: Record<string, string> = { INTERNAL_NOTIFY_TOKEN: 't', MASTER_API_URL: 'https://master.test' };
  if (opts.leadEnv !== undefined) env.QUALIFIER_TABLES_OPEN_BEFORE_MIN = opts.leadEnv;
  if (opts.balance !== undefined) env.QUALIFIER_TABLE_BALANCE = opts.balance;
  const scope: Record<string, unknown> = {
    qualifierTournaments, tournamentManager: tm, authSessions, playerSessions, multiTableSessions, spectators, tournamentTables,
    reservedSeats: new Map(), sitOutTracker: new Map(), pendingSeatRemovalAfterHand: new Map(), aiProfiles: new Map(),
    pendingAutoStartTimers: new Map(), fastModeTables: new Map(), tableProgressListeners: new Set(), quickGames: new Map(),
    clubLiveTournaments: new Map(), voluntarilyAbsentTournamentEntrants: new Map(),
    voluntaryAbsenceKey: (a: string, b: string) => `${a}\u0000${b}`,
    tableManager: {
      getTable: (id: string) => tables.get(id),
      createQuickTable: (name: string, max: number, sb: number, bb: number, minBuyIn: number, _v?: unknown, ante = 0) => {
        const id = `T${++tableN}`;
        tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante, minBuyIn, maxBuyIn: minBuyIn * 10, maxPlayers: max } as any));
        return id;
      },
      removeTable: (id: string) => tables.delete(id),
    },
    io: {
      emit: (ev: string, d: any) => globalEmits.push([ev, d]),
      to: (room: string) => { const op: any = { emit: (ev: string, d: any) => roomEmits.push([room, ev, d]), except: () => op }; return op; },
      sockets: { sockets },
    },
    qualifierSyncStats: { syncs: 0, failures: 0, lastSyncAt: null, listed: 0, cancelledOffSchedule: 0 },
    qualifierWindows, qualifierStatusOf, seatsForTopOf, seatsForTopWith, seatsWonAt, qualifierStructure, QUALIFIER_BASE_STACK,
    QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers: new Map(),
    samplePresence, partitionByPresence, QUALIFIER_PRESENCE_LEAD_MS,
    qualifierBlindLevels, qualifierBreakConfig: s4BreakConfig, qualifierTestTimeScale: s4TimeScale,
    qualifierTablesOpenBeforeMin, parseQualifierTablesOpenUpdate,
    partitionSuspendedRegistrants: s4PartitionSuspended,
    playStatusClient: { getPlayStatus: async (id: string) => { if (opts.screenGate) await opts.screenGate; return { suspended: suspended.has(id), failedOpen: false }; } },
    process: { env },
    assertPlayable: async () => null, bannedAccountRefusal: async () => null,
    isPlayerQualified: async (masterId: string) => { qualifiedCalls.push(masterId); return true; },
    consumeQualifierCreditOnMaster: async (masterId: string, tier: string, _q: string, label: string) => {
      consumed.push({ masterId, tier, label });
      return { consumed: true, creditId: `credit-${++creditN}` };
    },
    refundQualifierCreditOnMaster: async (id: string) => { creditRefunds.push(id); return true; },
    realClientIp: (s: any) => s.ip || '10.0.0.1',
    seatNameForSocket: (s: any) => authSessions.get(s.id)?.displayName || 'Player',
    progressionManager: { getOrCreateProgress() {} },
    publicNameOf: (n: unknown) => String(n ?? 'Player'),
    detachSocketFromOtherTables() {}, broadcastGameState: (id: string) => { broadcasts.push(id); },
    getGameStateForPlayer: () => ({}), emitGameState() {}, releaseSeatedSlot() {},
    auditLog: (actor: string, action: string, d: any) => audits.push({ actor, action, d }),
    PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED', lastQualifierFetch: 1,
    fetch: async (url: string, init: any) => {
      fetches.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    uuidv4: () => `u${Math.random().toString(36).slice(2, 10)}`,
    randomInt: (max: number) => s4RandomInt(max), createHash, timingSafeEqual,
    console: { log: (...a: any[]) => logs.push(a.join(' ')), warn: (...a: any[]) => logs.push(a.join(' ')), error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`) },
    MAX_SEATS: 9, GamePhase, syncSitOutToTable() {},
    tournamentHandStartSafety: { bustedSeatsVacated: 0, clientHandStartsRouted: 0, breaksDeferredMidHand: 0, reservationsMoved: 0 },
    tournamentSeatKeep: { returnRefused: 0, returnAlreadyThere: 0, returned: 0 },
    qualifierOverflowTablesMax: opts.overflowMax ?? 6,
    ensureTableProgressListener() {}, scheduleAIAction() {}, scheduleAutoStart() {},
    payTournamentPrizes: async () => {}, postQualifierResults() {}, notifyPlayer: async () => {},
    tournamentRebalanceIsHeld: () => false, noteBrokenTournamentTable() {}, broadcastTournamentList() {},
    shutdownFlushStats: { qualifierRegistrationsReleased: 0, qualifierRegistrantsTold: 0, spinGoSettled: 0, spinGoFeesRefunded: 0, tournamentsCancelled: 0, tournamentsVoided: 0 },
    PROCESS_INSTANCE_ID: 'proc-1',
    ensureChipsForBuyIn: async () => 0, deductChips: async () => false, addChipsToUser: async () => true,
    app: { post: (p: string, fn: (req: any, res: any) => void) => { routes.set(p, fn); } },
  };
  const { exports: m } = load(`${S4_CODE}\n${opts.extraCode || ''}\nfunction wire(socket) {\n${S4_SEAT_SESSION_FOR}\n  ${S4_HANDLERS}\n}`, scope, `{
    wire, applyQualifierSchedule, qualifierList, tickQualifierAutoStart, tickQualifierScreens, runPreStartDeal, qualifierPreStartHolds,
    qualifierPreStart, qualifierPreStartHealth, qualifierNoShows, sweepTournamentRebalances, handleTableRebalance,
    serviceQualifierOverflowTables, startFreshTournamentTable, qualifierOverflowTables, applyDirectorPause, tournamentClockStateFor,
    claimTournamentRefundsForShutdown, claimQuickAndQualifierRefundsForShutdown, tournamentDealHoldReason, qualifierLateEntries,
    seatPendingQualifierRegistrant,
  }`);
  const emitted: Array<[string, string, any]> = [];
  const mkSocket = (sid: string, n: number) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = {
      id: sid, connected: true, handlers, rooms: new Set<string>(), ip: `10.0.${n}.2`,
      on: (ev: string, fn: any) => { handlers[ev] = fn; },
      emit: (ev: string, p: any) => emitted.push([sid, ev, p]),
      join(r: string) { s.rooms.add(r); }, leave(r: string) { s.rooms.delete(r); },
    };
    sockets.set(sid, s);
    authSessions.set(sid, { userId: 1000 + n, username: `p${n}.x`, masterUserId: `m-${n}`, displayName: `P${n}` });
    m.wire(s);
    return s;
  };
  /** Player n leaves (his socket is gone). */
  const offline = (sid: string) => { const s = sockets.get(sid); if (s) s.connected = false; sockets.delete(sid); authSessions.delete(sid); };
  const of = (sid: string, ev: string) => emitted.filter(([s, e]) => s === sid && e === ev).map(([, , p]) => p);
  const route = (path: string, body: unknown, token?: string) => {
    const out: { status: number; body: any } = { status: 200, body: null };
    const res = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
    routes.get(path)!({ headers: token === undefined ? {} : { 'x-internal-token': token }, body }, res);
    return out;
  };
  const sync = () => {
    const body = JSON.parse(JSON.stringify(MASTER_BODY));
    body.data.schedule[0].scheduledAt = new Date(S4_AT).toISOString();
    m.applyQualifierSchedule(parseMasterSchedule(body), Date.now());
  };
  const qt = () => qualifierTournaments.get(WEEKLY);
  const tour = () => tm.getTournament(qt().tournamentId)!;
  /** The world's clock moves to `at` (timers due on the way fire) and the 30 s tick runs there. */
  const tickAt = (at: number) => { if (at > Date.now()) jest.advanceTimersByTime(at - Date.now()); m.tickQualifierAutoStart(Date.now()); };
  /** The suspension screen runs at `at` and completes. */
  const screenAt = async (at: number) => { if (at > Date.now()) jest.advanceTimersByTime(at - Date.now()); m.tickQualifierScreens(Date.now()); await flush(); };
  /** n registrants (S1..Sn, masters m-1..m-n), registered 30 min before the start; returns their sockets. */
  const register = async (n: number, from = 1) => {
    const out: any[] = [];
    for (let i = from; i < from + n; i++) {
      const s = mkSocket(`S${i}`, i);
      await s.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: `P${i}` });
      out.push(s);
    }
    return out;
  };
  /** The live tables of the event with their alive counts. */
  const tableAlive = () => tour().tableIds.map((id) => tm.getAlivePlayersOnTable(qt().tournamentId, id).length);
  const logEvents = (name: string) => logs.filter((l) => l.includes(`"event":"${name}"`)).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  return {
    m, tm, tables, qualifierTournaments, authSessions, playerSessions, sockets, emitted, globalEmits, roomEmits, audits, consumed,
    creditRefunds, fetches, logs, broadcasts, qualifiedCalls, suspended, env, scope, mkSocket, offline, of, route, sync, qt, tour,
    tickAt, screenAt, register, tableAlive, logEvents,
  };
}

/** The standard morning: n registrants; `away` of them (the LAST ones) offline before the screen; screen at T-15, the open at T-10. */
async function openedEarly(n: number, away: number, opts: Parameters<typeof earlyRoomsWorld>[0] = {}) {
  const w = earlyRoomsWorld(opts);
  w.sync();
  const socks = await w.register(n);
  for (let i = n - away + 1; i <= n; i++) w.offline(`S${i}`);
  await w.screenAt(S4_AT - 15 * S4_MIN);
  w.tickAt(S4_AT - 10 * S4_MIN);
  return { w, socks };
}

describe('2026-10-23 (qualifier lifecycle S4, owner: "open the rooms 10 minutes before game start") — the EARLY ROOMS', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('the lead: env unset / blank / garbage → 10, floored, clamped 0..30 (0 = off); the runtime parse refuses non-numbers', () => {
    expect(QUALIFIER_TABLES_OPEN_BEFORE_MIN).toBe(10);
    expect([undefined, '', '  ', 'abc', 'NaN'].map((v) => qualifierTablesOpenBeforeMin(v as any))).toEqual([10, 10, 10, 10, 10]);
    expect(['0', '5', '7.9', '-3', '45', ' 12 '].map((v) => qualifierTablesOpenBeforeMin(v))).toEqual([0, 5, 7, 0, 30, 12]);
    expect([undefined, null, '', 'x', {}, true].map((v) => parseQualifierTablesOpenUpdate(v))).toEqual([null, null, null, null, null, null]);
    expect([0, '0', 10, '10', 99, -1, 4.5].map((v) => parseQualifierTablesOpenUpdate(v))).toEqual([0, 0, 10, 10, 30, 0, 4]);
  });

  it('E1 — at T-10 the tables open: ONLY the online registrants are seated, tables for ALL registrants (ceil(20/9) = 3), held (prestart, no card, no clock); the offline ones stay PENDING with their credit', async () => {
    const w = earlyRoomsWorld();
    w.sync();
    await w.register(20);
    for (let i = 13; i <= 20; i++) w.offline(`S${i}`);
    await w.screenAt(S4_AT - 15 * S4_MIN);
    w.tickAt(S4_AT - 10 * S4_MIN - 1000);                 // CONTROL: one second early — nothing
    expect(w.qt().status).toBe('registering');
    w.tickAt(S4_AT - 10 * S4_MIN);
    const qt = w.qt();
    expect(qt.status).toBe('running');
    const t = w.tour();
    expect(t.tableIds).toHaveLength(3);
    expect(t.players.map((p: any) => p.playerId).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `user-${1001 + i}`).sort());
    expect(w.tableAlive().reduce((a, b) => a + b, 0)).toBe(12);
    expect(Math.max(...w.tableAlive()) - Math.min(...w.tableAlive())).toBeLessThanOrEqual(1);
    for (const id of t.tableIds) expect({ id, phase: w.tables.get(id)!.currentPhase, hand: w.tables.get(id)!.handNumber }).toEqual({ id, phase: GamePhase.WaitingForPlayers, hand: 0 });
    expect(t.paused).toBe(true);
    expect(t.pauseReason).toBe('prestart');
    expect(t.levelEndsAt).toBeNull();
    expect(t.levelRemainingMs).toBe(12 * S4_MIN);
    // The pending ones: registered, credit held, no entrant, nothing refunded.
    expect(qt.players).toHaveLength(20);
    const pending = qt.players.filter((p: any) => !t.players.some((x: any) => x.playerId === p.playerId));
    expect(pending.map((p: any) => p.masterPlayerId)).toEqual(Array.from({ length: 8 }, (_, i) => `m-${13 + i}`));
    expect(pending.every((p: any) => typeof p.consumedCreditId === 'string')).toBe(true);
    expect(w.creditRefunds).toEqual([]);
    expect(w.consumed).toHaveLength(20);
    // Told, with the seat and the deal second (additive).
    const dealsAt = new Date(S4_AT).toISOString();
    expect(w.of('S1', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({
      qualifierId: WEEKLY, tournamentId: qt.tournamentId, seated: true, seatIndex: expect.any(Number), dealsAt, preStart: true, tableCount: 3,
    })]);
    expect(w.playerSessions.get('S1')).toMatchObject({ playerId: 'user-1001' });
    // The lobby: tablesOpen + dealsAt (only while held); the update frame too.
    expect(w.m.qualifierList(null)[0]).toMatchObject({ status: 'running', tablesOpen: true, dealsAt, signupOpen: true, tournamentId: qt.tournamentId });
    expect(w.globalEmits.filter(([ev, d]) => ev === 'qualifierTournamentUpdate' && d.status === 'running').map(([, d]) => d))
      .toEqual([expect.objectContaining({ tablesOpen: true, dealsAt, tableCount: 3, registeredCount: 20 })]);
    expect(w.m.qualifierPreStartHealth()).toMatchObject({ leadMin: 10, opened: 1, seatedAtOpen: 12, held: [{ qualifierId: WEEKLY, tournamentId: qt.tournamentId, dealsAt }] });
    expect(w.logEvents('qualifier_tables_opened_early')).toEqual([expect.objectContaining({ tables: 3, seated: 12, pending: 8, dealsAt })]);
    // The S3 clock in every state: held, dealsAt = the start second.
    expect(w.m.tournamentClockStateFor(qt.tournamentId).tournamentClock).toMatchObject({ paused: true, pauseReason: 'prestart', dealsAt: S4_AT, levelEndsAt: null, level: 1 });
  });

  it('E2 — during the hold nothing deals: hand 0 everywhere, startHand refused \'paused\', the sweep and handleTableRebalance break nothing, an overflow table is not dealt, levelEndsAt null', async () => {
    const { w } = await openedEarly(20, 8);
    const t = w.tour();
    const before = [...t.tableIds];
    for (let k = 0; k < 6; k++) { jest.advanceTimersByTime(30_000); w.m.sweepTournamentRebalances(); w.m.tickQualifierAutoStart(Date.now()); }
    w.m.handleTableRebalance(w.qt().tournamentId);
    expect(t.tableIds).toEqual(before);                                  // Rule 1 would have broken one of 3 tables holding 12
    for (const id of before) expect(w.tables.get(id)!.handNumber).toBe(0);
    expect(t.levelEndsAt).toBeNull();
    expect(t.currentBlindLevel).toBe(0);
    // A client's auto-deal / Deal button.
    await w.sockets.get('S1').handlers.startHand({ tableId: w.playerSessions.get('S1').tableId });
    expect(w.of('S1', 'error')).toEqual([expect.objectContaining({ code: 'tournament_hand_held', reason: 'paused' })]);
    // An overflow table's first deal is held too.
    const ov = before[0];
    w.m.qualifierOverflowTables.set(ov, w.qt().tournamentId);
    expect(w.m.startFreshTournamentTable(ov)).toBe(false);
    w.m.serviceQualifierOverflowTables();
    expect(w.tables.get(ov)!.handNumber).toBe(0);
    // A director resume is refused (S3's 'prestart' reason).
    expect(w.m.applyDirectorPause(w.qt().tournamentId, false, 'admin')).toMatchObject({ ok: false, code: 'not_started' });
    expect(w.route('/api/qualifiers/pause', { paused: 0 }, 't')).toMatchObject({ status: 409, body: { error: 'not_started' } });
    expect(t.paused).toBe(true);
    expect(t.pauseReason).toBe('prestart');
  });

  it('E3 — a PENDING registrant who comes online is seated with ZERO consumes, through each path: the 5 s sweep, Return ("Take your seat"), a Register tap', async () => {
    const { w } = await openedEarly(20, 8);
    const tid = w.qt().tournamentId;
    const consumedBefore = w.consumed.length;
    const entries0 = w.tour().entries;
    // (i) the sweep
    w.mkSocket('S13', 13);
    w.m.sweepTournamentRebalances();
    expect(w.playerSessions.get('S13')).toMatchObject({ playerId: 'user-1013' });
    expect(w.of('S13', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({ seated: true, tableId: w.playerSessions.get('S13').tableId, seatIndex: w.playerSessions.get('S13').seatIndex, dealsAt: new Date(S4_AT).toISOString(), preStart: true })]);
    // (ii) Return — answered like a return (reconnectedToTable + the ack's success shape)
    const s14 = w.mkSocket('S14', 14);
    const acks: any[] = [];
    await s14.handlers.returnToTournamentSeat({ tournamentId: tid }, (r: any) => acks.push(r));
    const sess14 = w.playerSessions.get('S14');
    expect(sess14).toMatchObject({ playerId: 'user-1014' });
    expect(acks).toEqual([{ success: true, tournamentId: tid, tableId: sess14.tableId, seatIndex: sess14.seatIndex }]);
    expect(w.of('S14', 'returnToTournamentResult')).toEqual(acks);
    expect(w.of('S14', 'reconnectedToTable')).toEqual([{ tableId: sess14.tableId, seatIndex: sess14.seatIndex, tournamentId: tid, sittingOut: false }]);
    // (iii) a Register tap — BEFORE the qualification gate (his one credit is already used)
    const s15 = w.mkSocket('S15', 15);
    const gate0 = w.qualifiedCalls.length;
    await s15.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'P15' });
    const sess15 = w.playerSessions.get('S15');
    expect(sess15).toMatchObject({ playerId: 'user-1015' });
    expect(w.of('S15', 'qualifierRegistrationResult').slice(-1)).toEqual([expect.objectContaining({ success: true, registered: true, preStart: true, tableId: sess15.tableId, seatIndex: sess15.seatIndex, tablesOpen: true })]);
    expect(w.qualifiedCalls.length).toBe(gate0);
    // Zero consumes, zero refunds; entrants +3; nothing dealt.
    expect(w.consumed.length).toBe(consumedBefore);
    expect(w.creditRefunds).toEqual([]);
    expect(w.tour().entries).toBe(entries0 + 3);
    for (const id of w.tour().tableIds) expect(w.tables.get(id)!.handNumber).toBe(0);
    expect(w.m.qualifierPreStart.seatedDuringHold).toBe(3);
    // A second tap / Return of a seated one changes nothing (not pending any more).
    await s15.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'P15' });
    expect(w.of('S15', 'qualifierRegistrationResult').slice(-1)[0]).toEqual(expect.objectContaining({ success: false, code: 'already_registered' }));
    expect(w.consumed.length).toBe(consumedBefore);
  });

  it('E4 — a NEW registrant during the hold consumes exactly 1 and is seated (late entry), told preStart + dealsAt, audited preStart; nothing dealt', async () => {
    const { w } = await openedEarly(20, 8);
    const s = w.mkSocket('S31', 31);
    await s.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'P31' });
    expect(w.consumed.slice(-1)).toEqual([{ masterId: 'm-31', tier: 'weekly', label: 'entry' }]);
    expect(w.consumed).toHaveLength(21);
    expect(w.playerSessions.get('S31')).toMatchObject({ playerId: 'user-1031' });
    const dealsAt = new Date(S4_AT).toISOString();
    expect(w.of('S31', 'qualifierRegistrationResult')).toEqual([expect.objectContaining({ success: true, lateEntry: true, preStart: true, tablesOpen: true, dealsAt })]);
    expect(w.of('S31', 'qualifierTournamentStarted')).toEqual([expect.objectContaining({ lateEntry: true, preStart: true, dealsAt, seatIndex: w.playerSessions.get('S31').seatIndex })]);
    expect(w.audits.find((a) => a.action === 'QUALIFIER_LATE_ENTRY_SEATED')!.d).toMatchObject({ preStart: true });
    expect(w.m.qualifierPreStart.lateEntriesDuringHold).toBe(1);
    for (const id of w.tour().tableIds) expect(w.tables.get(id)!.handNumber).toBe(0);
  });

  it('E5 — AT the start second: absent pending AND absent seated registrants are released and refunded once each, present pending ones seated, tables broken + balanced within 1, every table dealt, levelEndsAt = dealsAt + 12 min', async () => {
    const { w } = await openedEarly(20, 8);
    const tid = w.qt().tournamentId;
    jest.advanceTimersByTime(5 * S4_MIN);                                     // 10:55
    w.offline('S1'); w.offline('S2');                                        // two SEATED registrants leave
    jest.advanceTimersByTime(4 * S4_MIN + 30_000);                           // 10:59:30
    for (const n of [13, 14, 15]) w.mkSocket(`S${n}`, n);                    // three pending ones are back (no sweep before the deal)
    const credits = new Map(w.qt().players.map((p: any) => [p.masterPlayerId, p.consumedCreditId]));
    jest.advanceTimersByTime(30_000);                                        // 11:00:00 — the hold's own timer deals
    await flush();
    expect(Date.now()).toBe(S4_AT);
    const t = w.tour();
    expect(w.m.qualifierPreStartHolds.has(tid)).toBe(false);
    // Released: the 2 seated + the 5 still-offline pending ones — each credit refunded exactly once.
    const gone = ['m-1', 'm-2', 'm-16', 'm-17', 'm-18', 'm-19', 'm-20'];
    expect([...w.creditRefunds].sort()).toEqual(gone.map((m) => credits.get(m)).sort());
    expect(w.audits.filter((a) => a.action === 'QUALIFIER_NO_SHOW_RELEASED')).toHaveLength(7);
    expect(w.qt().players.map((p: any) => p.masterPlayerId).sort()).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => `m-${n}`).sort());
    // The seated no-shows' seats are gone; the entrants are exactly the 13 here.
    expect(t.players.map((p: any) => p.playerId).sort()).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => `user-${1000 + n}`).sort());
    expect(t.entries).toBe(13);
    for (const id of t.tableIds) for (const s of w.tables.get(id)!.seats) if (s.state === 'occupied') expect(['user-1001', 'user-1002']).not.toContain(s.playerId);
    // Present pending ones seated on their sockets (told: a plain seated start, no preStart now).
    for (const n of [13, 14, 15]) {
      expect(w.playerSessions.get(`S${n}`)).toMatchObject({ playerId: `user-${1000 + n}` });
      expect(w.of(`S${n}`, 'qualifierTournamentStarted')).toEqual([expect.objectContaining({ seated: true })]);
      expect(w.of(`S${n}`, 'qualifierTournamentStarted')[0].preStart).toBeUndefined();
    }
    // 13 alive fit 2 tables: Rule 1 broke one; the rest balanced within one; every table dealt.
    expect(t.tableIds).toHaveLength(2);
    const alive = w.tableAlive();
    expect(alive.reduce((a, b) => a + b, 0)).toBe(13);
    expect(Math.max(...alive) - Math.min(...alive)).toBeLessThanOrEqual(1);
    for (const id of t.tableIds) expect({ id, hand: w.tables.get(id)!.handNumber, live: w.tables.get(id)!.isHandInProgress() }).toEqual({ id, hand: 1, live: true });
    // The clock: the FULL level 1 from the start second.
    expect(t.paused).toBe(false);
    expect(t.pauseReason).toBeNull();
    expect(t.levelEndsAt).toBe(S4_AT + 12 * S4_MIN);
    expect(w.m.tournamentClockStateFor(tid).tournamentClock).toMatchObject({ paused: false, dealsAt: null, levelEndsAt: S4_AT + 12 * S4_MIN });
    // The lobby: tablesOpen gone; the update says so.
    expect(w.m.qualifierList(null)[0].tablesOpen).toBeUndefined();
    expect(w.globalEmits.filter(([ev]) => ev === 'qualifierTournamentUpdate').map(([, d]) => d).pop()).toMatchObject({ tablesOpen: false, dealsAt: null, players: 13 });
    expect(w.m.qualifierPreStart).toMatchObject({ dealt: 1, released: 7, holdErrors: 0 });
    expect(w.logEvents('qualifier_prestart_deal')).toEqual([expect.objectContaining({ lateByMs: 0, tables: 2, dealtTables: 2, seated: 3, released: 7, alive: 13 })]);
    expect(w.logs.filter((l) => l.startsWith('ERR'))).toEqual([]);
  });

  it('E6 — runPreStartDeal called twice acts once (the timer, the tick and the sweep may all reach it)', async () => {
    const { w } = await openedEarly(20, 8);
    const tid = w.qt().tournamentId;
    jest.setSystemTime(S4_AT);
    w.m.runPreStartDeal(tid);
    w.m.runPreStartDeal(tid);
    w.m.tickQualifierAutoStart(Date.now());
    w.m.sweepTournamentRebalances();
    jest.advanceTimersByTime(1000);
    await flush();
    expect(w.creditRefunds).toHaveLength(8);                                 // the 8 offline pending ones, once each
    expect(new Set(w.creditRefunds).size).toBe(8);
    expect(w.m.qualifierPreStart.dealt).toBe(1);
    expect(w.logEvents('qualifier_prestart_deal')).toHaveLength(1);
    for (const id of w.tour().tableIds) expect(w.tables.get(id)!.handNumber).toBe(1);
  });

  // Review fix-up — E7 asserted the defect: with fewer than 2 present the seated
  // ABSENT entrants were dealt (a no-show lost his credit and could finish in a
  // seat-paying place). Now: the wait of before, then the deal or the cancel.
  it('E7 — fewer than 2 present at the start second: NO card and NOBODY released, the hold stays (the wait of before); two present again → the next sweep deals, the absent ones released + refunded then', async () => {
    const { w } = await openedEarly(4, 2);                                   // S1, S2 seated; S3, S4 pending (offline)
    const tid = w.qt().tournamentId;
    const credits = new Map(w.qt().players.map((p: any) => [p.masterPlayerId, p.consumedCreditId]));
    w.offline('S2');                                                         // one seated leaves: 1 present
    jest.advanceTimersByTime(10 * S4_MIN);                                   // 11:00:00 — the hold's timer
    await flush();
    const t = w.tour();
    expect(w.m.qualifierPreStartHolds.has(tid)).toBe(true);
    expect(t).toMatchObject({ status: 'running', paused: true, pauseReason: 'prestart', levelEndsAt: null });
    for (const id of t.tableIds) expect(w.tables.get(id)!.handNumber).toBe(0);
    expect(w.creditRefunds).toEqual([]);
    expect(w.qt().players.map((p: any) => p.masterPlayerId)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(t.players.map((p: any) => p.playerId)).toEqual(['user-1001', 'user-1002']);
    // The 5 s sweep and the 30 s tick keep waiting; it is logged ONCE.
    for (let k = 0; k < 4; k++) { jest.advanceTimersByTime(30_000); w.m.sweepTournamentRebalances(); w.m.tickQualifierAutoStart(Date.now()); }
    await flush();
    for (const id of t.tableIds) expect(w.tables.get(id)!.handNumber).toBe(0);
    expect(w.creditRefunds).toEqual([]);
    expect(w.logEvents('qualifier_prestart_deal_waiting')).toEqual([expect.objectContaining({ qualifierId: WEEKLY, tournamentId: tid, present: 1, registrants: 4 })]);
    expect(w.m.qualifierPreStart).toMatchObject({ dealsWaiting: 1, dealt: 0, released: 0, holdErrors: 0 });
    expect(w.m.qualifierPreStartHealth().held).toEqual([{ qualifierId: WEEKLY, tournamentId: tid, dealsAt: new Date(S4_AT).toISOString(), waitingSince: new Date(S4_AT).toISOString() }]);
    expect(w.m.qualifierList(null)[0]).toMatchObject({ tablesOpen: true });
    // 11:02 — a pending one is back: two present → the next sweep deals.
    w.mkSocket('S3', 3);
    w.m.sweepTournamentRebalances();
    await flush();
    const dealtAt = Date.now();
    expect(w.m.qualifierPreStartHolds.has(tid)).toBe(false);
    expect([...w.creditRefunds].sort()).toEqual([credits.get('m-2'), credits.get('m-4')].sort());   // the absent ones, once each
    expect(w.qt().players.map((p: any) => p.masterPlayerId)).toEqual(['m-1', 'm-3']);
    expect(t.players.map((p: any) => p.playerId).sort()).toEqual(['user-1001', 'user-1003']);
    expect(w.playerSessions.get('S3')).toMatchObject({ playerId: 'user-1003' });
    expect(w.tables.get(t.tableIds[0])!.handNumber).toBe(1);
    expect(t).toMatchObject({ paused: false, pauseReason: null, levelEndsAt: dealtAt + 12 * S4_MIN });   // the FULL level 1 from the deal
    expect(w.logEvents('qualifier_prestart_deal')).toEqual([expect.objectContaining({ released: 2, seated: 1, alive: 2, waitedMs: 2 * S4_MIN })]);
    expect(w.logs.filter((l) => l.startsWith('ERR'))).toEqual([]);
  });

  it('E7b — still fewer than 2 present when late registration ends: CANCELLED as before — the held tables close (nothing was dealt), every credit (seated and pending) refunded exactly once, everyone online told too_few_players', async () => {
    const { w } = await openedEarly(4, 2, { extraCode: S4_CLOSE_CODE });
    const tid = w.qt().tournamentId;
    const tables0 = [...w.tour().tableIds];
    const credits = w.qt().players.map((p: any) => p.consumedCreditId);
    w.offline('S2');
    jest.advanceTimersByTime(10 * S4_MIN);                                   // 11:00 — waiting
    w.tickAt(S4_AT + LATE - 30_000);                                         // 1:59:30 PM — still waiting
    await flush();
    expect(w.m.qualifierPreStartHolds.has(tid)).toBe(true);
    expect(w.qt().status).toBe('running');
    expect(w.creditRefunds).toEqual([]);
    w.tickAt(S4_AT + LATE + 1000);                                           // past the late close
    await flush();
    expect(w.qt()).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.m.qualifierPreStartHolds.size).toBe(0);
    expect([...w.creditRefunds].sort()).toEqual([...credits].sort());
    expect(new Set(w.creditRefunds).size).toBe(4);
    expect(w.tm.getTournament(tid)!.status).toBe('cancelled');
    for (const id of tables0) {
      expect(w.tables.has(id)).toBe(false);
      expect(w.roomEmits).toContainEqual([`table:${id}`, 'tableClosed', { tableId: id, reason: 'tournament_cancelled', tournamentId: tid }]);
    }
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.of('S1', 'qualifierCancelled')).toEqual([{ qualifierId: WEEKLY, reason: 'too_few_players', creditRefunded: true }]);
    expect(w.m.qualifierPreStart).toMatchObject({ dealt: 0, cancelledTooFew: 1, dealsWaiting: 1 });
    expect(w.logEvents('qualifier_prestart_cancelled')).toEqual([expect.objectContaining({ tournamentId: tid, reason: 'too_few_players', tables: 1, registrants: 4 })]);
    // Nothing more: no deal, no second refund.
    jest.advanceTimersByTime(60_000);
    w.m.sweepTournamentRebalances();
    w.m.tickQualifierAutoStart(Date.now());
    await flush();
    expect(w.creditRefunds).toHaveLength(4);
    expect(w.m.qualifierPreStart.dealt).toBe(0);
  });

  it('E8 — lead 0 (QUALIFIER_TABLES_OPEN_BEFORE_MIN=0): nothing opens early; the start second takes the path of before (dealt at once, no hold)', async () => {
    const w = earlyRoomsWorld({ leadEnv: '0' });
    w.sync();
    await w.register(4);
    w.offline('S4');
    await w.screenAt(S4_AT - 5 * S4_MIN);
    w.tickAt(S4_AT - 10 * S4_MIN);
    w.tickAt(S4_AT - 60_000);
    expect(w.qt().status).toBe('registering');
    expect(w.m.qualifierPreStart.opened).toBe(0);
    w.tickAt(S4_AT);
    const t = w.tour();
    expect(w.qt().players.map((p: any) => p.masterPlayerId)).toEqual(['m-1', 'm-2', 'm-3']);   // the no-show released at the start
    expect(t.paused).toBe(false);
    expect(w.tables.get(t.tableIds[0])!.handNumber).toBe(1);
    expect(w.m.qualifierPreStartHolds.size).toBe(0);
    expect(w.m.qualifierPreStartHealth()).toMatchObject({ leadMin: 0, opened: 0, held: [] });
  });

  it('E9 — the lead set to 0 DURING a hold (POST /api/qualifiers/tables-open) does not strand it: it still deals at the start second', async () => {
    const { w } = await openedEarly(6, 0);
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0 }, 't')).toEqual({ status: 200, body: { success: true, previous: 10, minutes: 0, held: 1 } });
    jest.advanceTimersByTime(10 * S4_MIN);
    const t = w.tour();
    expect(t.paused).toBe(false);
    expect(w.tables.get(t.tableIds[0])!.handNumber).toBe(1);
    expect(t.levelEndsAt).toBe(S4_AT + 12 * S4_MIN);
  });

  it('E10 — a restart DURING the hold: every credit refunded exactly once (seated and pending), the pending registrants told qualifierCancelled server_restart, no deal afterwards', async () => {
    const { w } = await openedEarly(6, 3);
    w.mkSocket('S5', 5);                                                     // a pending one online, not seated yet
    const credits = w.qt().players.map((p: any) => p.consumedCreditId);
    const tourneys = w.m.claimTournamentRefundsForShutdown();
    const tasks = w.m.claimQuickAndQualifierRefundsForShutdown(tourneys.entryFees);
    await Promise.all(tasks);
    await flush();
    expect([...w.creditRefunds].sort()).toEqual([...credits].sort());
    expect(new Set(w.creditRefunds).size).toBe(6);
    expect(w.of('S5', 'qualifierCancelled')).toEqual([{ qualifierId: WEEKLY, reason: 'server_restart', creditRefunded: true }]);
    expect(w.of('S1', 'qualifierCancelled')).toEqual([{ qualifierId: WEEKLY, reason: 'server_restart', creditRefunded: true }]);
    expect(w.qt()).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.m.qualifierPreStartHolds.size).toBe(0);
    jest.advanceTimersByTime(15 * S4_MIN);
    for (const id of w.tour().tableIds) expect(w.tables.get(id)!.handNumber).toBe(0);
    expect(w.creditRefunds).toHaveLength(6);
  });

  it('E11 — the suspension screen completes BEFORE the open: none yet / one in flight → no open; a suspended registrant is removed (credit back) and never seated', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = earlyRoomsWorld({ suspended: ['m-3'], screenGate: gate });
    w.sync();
    await w.register(5);
    w.tickAt(S4_AT - 10 * S4_MIN);                                           // no screen has run: not opened
    expect(w.qt().status).toBe('registering');
    w.m.tickQualifierScreens(Date.now());                                    // the screen starts (master slow)
    w.tickAt(S4_AT - 9 * S4_MIN);                                            // in flight: still not opened
    expect(w.qt().status).toBe('registering');
    release();
    await flush();
    expect(w.qt().players.map((p: any) => p.masterPlayerId)).toEqual(['m-1', 'm-2', 'm-4', 'm-5']);
    expect(w.creditRefunds).toEqual(['credit-3']);
    w.tickAt(S4_AT - 8 * S4_MIN - 30_000);
    expect(w.qt().status).toBe('running');
    expect(w.tour().players.map((p: any) => p.playerId)).not.toContain('user-1003');
    expect(w.tour().players).toHaveLength(4);
  });

  it('E12 — the screen window follows the lead (lead + 5 min): 15 minutes before with the default, 5 with the lead at 0', async () => {
    const w = earlyRoomsWorld();
    w.sync();
    await w.register(2);
    await w.screenAt(S4_AT - 15 * S4_MIN - 20_000);
    expect(w.qt().lastScreenAt).toBeUndefined();
    await w.screenAt(S4_AT - 15 * S4_MIN);
    expect(w.qt().lastScreenAt).toBe(S4_AT - 15 * S4_MIN);
    const z = earlyRoomsWorld({ leadEnv: '0' });
    z.sync();
    await z.register(2);
    await z.screenAt(S4_AT - 6 * S4_MIN);
    expect(z.qt().lastScreenAt).toBeUndefined();
    await z.screenAt(S4_AT - 5 * S4_MIN);
    expect(z.qt().lastScreenAt).toBe(S4_AT - 5 * S4_MIN);
  });

  it('E13 — a \'registering\' event first ticked AT / after its start (a late boot, or fewer than 2 online all through the lead) takes the path of before', async () => {
    const w = earlyRoomsWorld();
    w.sync();
    await w.register(3);
    w.offline('S2'); w.offline('S3');
    await w.screenAt(S4_AT - 15 * S4_MIN);
    w.tickAt(S4_AT - 10 * S4_MIN);                                           // 1 online: no open
    w.tickAt(S4_AT - 5 * S4_MIN);
    expect(w.qt().status).toBe('registering');
    w.mkSocket('S2', 2);                                                     // back at 10:55 (one more online: 2)
    w.tickAt(S4_AT + 5_000);                                                 // the late tick: today's path
    const t = w.tour();
    expect(w.m.qualifierPreStart.opened).toBe(0);
    expect(t.paused).toBe(false);
    expect(w.tables.get(t.tableIds[0])!.handNumber).toBe(1);
    expect(w.qt().players.map((p: any) => p.masterPlayerId)).toEqual(['m-1', 'm-2']);
  });

  it('E14 — POST /api/qualifiers/tables-open: 403 without / with a wrong token / with none configured (fails closed), 400 on a bad value (nothing changes), 200 {success, previous, minutes, held}; audited QUALIFIER_TABLES_OPEN_SET; health follows', () => {
    const w = earlyRoomsWorld();
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0 })).toMatchObject({ status: 403 });
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0 }, 'nope')).toMatchObject({ status: 403 });
    expect(w.route('/api/qualifiers/tables-open', { minutes: 'soon' }, 't')).toMatchObject({ status: 400, body: { success: false, minutes: 10 } });
    expect(w.route('/api/qualifiers/tables-open', {}, 't')).toMatchObject({ status: 400 });
    expect(w.m.qualifierPreStartHealth().leadMin).toBe(10);
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0 }, 't')).toEqual({ status: 200, body: { success: true, previous: 10, minutes: 0, held: 0 } });
    expect(w.route('/api/qualifiers/tables-open', { minutes: '45' }, 't')).toEqual({ status: 200, body: { success: true, previous: 0, minutes: 30, held: 0 } });
    expect(w.m.qualifierPreStartHealth()).toMatchObject({ leadMin: 30, leadChanges: 2 });
    expect(w.audits.filter((a) => a.action === 'QUALIFIER_TABLES_OPEN_SET').map((a) => [a.d.previous, a.d.minutes])).toEqual([[10, 0], [0, 30]]);
    w.env.INTERNAL_NOTIFY_TOKEN = '';
    expect(w.route('/api/qualifiers/tables-open', { minutes: 5 }, '')).toMatchObject({ status: 403 });
    expect(w.m.qualifierPreStartHealth().leadMin).toBe(30);
    // Boot value from the env (clamped / garbage → 10).
    expect(earlyRoomsWorld({ leadEnv: 'x' }).m.qualifierPreStartHealth().leadMin).toBe(10);
    expect(earlyRoomsWorld({ leadEnv: '3' }).m.qualifierPreStartHealth().leadMin).toBe(3);
  });

  it('E15 — the 5 s sweep\'s backstop deals a table of a just-dealt event the deal missed (still WaitingForPlayers, hand 0, >= 2 alive, no hold)', async () => {
    const { w } = await openedEarly(18, 0);
    const t = w.tour();
    const missed = w.tables.get(t.tableIds[1])!;
    const realStart = missed.startNewHand.bind(missed);
    let refused = 1;
    (missed as any).startNewHand = () => (refused-- > 0 ? false : realStart());
    jest.advanceTimersByTime(10 * S4_MIN);
    expect(missed.handNumber).toBe(0);
    expect(w.tables.get(t.tableIds[0])!.handNumber).toBe(1);
    w.m.sweepTournamentRebalances();
    expect(missed.handNumber).toBe(1);
    expect(w.m.qualifierPreStart.backstopDeals).toBe(1);
    expect(w.logEvents('qualifier_prestart_backstop_deal')).toHaveLength(1);
  });

  it('E16 — a pending registrant whose only socket plays a live seat elsewhere is NOT moved by the sweep; at the deal he is seated ABSENT and told tournamentSeatKept', async () => {
    const { w } = await openedEarly(6, 1);
    const s6 = w.mkSocket('S6', 6);
    // He plays a cash table elsewhere.
    const cash = new PokerTable({ tableId: 'CASH', tableName: 'Cash', smallBlind: 1, bigBlind: 2, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 } as any);
    w.tables.set('CASH', cash);
    expect(cash.sitDown(0, 'P6', 100, 'user-1006', false)).toBe(true);
    w.playerSessions.set('S6', { socketId: 'S6', tableId: 'CASH', seatIndex: 0, playerName: 'P6', playerId: 'user-1006' });
    w.m.sweepTournamentRebalances();
    expect(w.playerSessions.get('S6').tableId).toBe('CASH');
    expect(w.tour().players.map((p: any) => p.playerId)).not.toContain('user-1006');
    jest.advanceTimersByTime(10 * S4_MIN);
    expect(w.playerSessions.get('S6').tableId).toBe('CASH');
    expect(w.tour().players.map((p: any) => p.playerId)).toContain('user-1006');
    expect(w.of('S6', 'tournamentSeatKept')).toEqual([expect.objectContaining({ tournamentId: w.qt().tournamentId, atStart: true, chips: 50_000 })]);
    expect(w.creditRefunds).toEqual([]);
    void s6;
  });

  it('E17 — the way BACK after the open: POST tables-open {minutes:0, closeOpen:true} closes the held tables (nothing dealt, no credit touched); the event is registering again and starts at 11:00 exactly as with the lead at 0', async () => {
    const { w } = await openedEarly(20, 8, { extraCode: S4_CLOSE_CODE });
    const tid = w.qt().tournamentId;
    const tables0 = [...w.tour().tableIds];
    const late = w.mkSocket('S31', 31);                                      // a late entry during the hold: one consume
    await late.handlers.registerQualifierTournament({ qualifierId: WEEKLY, playerName: 'P31' });
    expect(w.consumed).toHaveLength(21);
    // Refused, nothing changes: closeOpen with a lead above 0, a bad closeOpen, no token.
    expect(w.route('/api/qualifiers/tables-open', { minutes: 5, closeOpen: true }, 't')).toMatchObject({ status: 400, body: { success: false, minutes: 10 } });
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0, closeOpen: 'yes' }, 't')).toMatchObject({ status: 400 });
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0, closeOpen: true })).toMatchObject({ status: 403 });
    expect(w.m.qualifierPreStartHolds.has(tid)).toBe(true);
    expect(w.m.qualifierPreStartHealth().leadMin).toBe(10);
    jest.advanceTimersByTime(3 * S4_MIN);                                    // 10:53
    expect(w.route('/api/qualifiers/tables-open', { minutes: 0, closeOpen: true }, 't'))
      .toEqual({ status: 200, body: { success: true, previous: 10, minutes: 0, held: 1, closed: 1 } });
    expect(w.m.qualifierPreStartHolds.size).toBe(0);
    expect(w.qt()).toMatchObject({ status: 'registering', tournamentId: null });
    expect(w.qt().players).toHaveLength(21);                                 // every registration stays…
    expect(w.creditRefunds).toEqual([]);                                     // …with its credit
    expect(w.consumed).toHaveLength(21);
    expect(w.tm.getTournament(tid)!.status).toBe('cancelled');
    for (const id of tables0) {
      expect(w.tables.has(id)).toBe(false);
      expect(w.roomEmits).toContainEqual([`table:${id}`, 'tableClosed', { tableId: id, reason: 'tables_reopen_at_start', tournamentId: tid }]);
    }
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.playerSessions.has('S31')).toBe(false);
    expect(w.m.qualifierList(null)[0]).toMatchObject({ status: 'registering' });
    expect(w.m.qualifierList(null)[0].tablesOpen).toBeUndefined();
    expect(w.globalEmits.filter(([ev]) => ev === 'qualifierTournamentUpdate').map(([, d]) => d).pop()).toMatchObject({ status: 'registering', tournamentId: null, registeredCount: 21 });
    expect(w.audits.filter((a) => a.action === 'QUALIFIER_TABLES_OPEN_CLOSED').map((a) => a.d)).toEqual([{ qualifierId: WEEKLY, tournamentId: tid, tables: 3, registrants: 21 }]);
    expect(w.m.qualifierPreStart.closedByOperator).toBe(1);
    // It never re-opens before the start (the lead is 0)…
    w.tickAt(S4_AT - 5 * S4_MIN);
    w.tickAt(S4_AT - 20_000);
    expect(w.qt().status).toBe('registering');
    expect(w.m.qualifierPreStart.opened).toBe(1);
    // …and 11:00 is the start of before: the 8 no-shows released + refunded, the 13 here seated and dealt at once.
    jest.advanceTimersByTime(20_000 + 250);                                  // S1's on-time timer
    await flush();
    const t = w.tour();
    expect(w.qt().tournamentId).not.toBe(tid);
    expect(t.paused).toBe(false);
    expect(w.qt().players).toHaveLength(13);
    expect(w.creditRefunds).toHaveLength(8);
    expect(t.players).toHaveLength(13);
    for (const id of t.tableIds) expect(w.tables.get(id)!.handNumber).toBe(1);
    expect(w.consumed).toHaveLength(21);
    expect(w.m.qualifierPreStartHolds.size).toBe(0);
  });

  it('E18 — a seated registrant who went back to the lobby during the hold (a voluntary absence) and is online at the deal is put back on his seat, as the start of before bound every online registrant; CONTROL: one whose socket plays a cash table stays absent; one at his table is not touched', async () => {
    const { w } = await openedEarly(6, 0, { extraCode: S4_SEATS_CODE });
    const tid = w.qt().tournamentId;
    const va = w.scope.voluntarilyAbsentTournamentEntrants as Map<string, number>;
    // S1 leaves the idle table for the lobby (keepTournamentSeatOnLeave: the session ends, the voluntary mark).
    const seat1 = { ...w.playerSessions.get('S1') };
    w.playerSessions.delete('S1');
    va.set(`${tid}\u0000user-1001`, Date.now());
    // S2 leaves too and sits down at a cash table on the same socket.
    const seat2 = { ...w.playerSessions.get('S2') };
    const cash = new PokerTable({ tableId: 'CASH', tableName: 'Cash', smallBlind: 1, bigBlind: 2, minBuyIn: 100, maxBuyIn: 1000, maxPlayers: 9 } as any);
    w.tables.set('CASH', cash);
    expect(cash.sitDown(0, 'P2', 100, 'user-1002', false)).toBe(true);
    w.playerSessions.set('S2', { socketId: 'S2', tableId: 'CASH', seatIndex: 0, playerName: 'P2', playerId: 'user-1002' });
    va.set(`${tid}\u0000user-1002`, Date.now());
    const seat3 = { ...w.playerSessions.get('S3') };
    jest.advanceTimersByTime(10 * S4_MIN);                                   // 11:00 — the deal
    await flush();
    const t = w.tour();
    expect(t.paused).toBe(false);
    expect(w.tables.get(seat1.tableId)!.handNumber).toBe(1);
    // S1 is back on HIS seat (the seat kept its stack; nothing moved it — one table).
    expect(w.playerSessions.get('S1')).toMatchObject({ tableId: seat1.tableId, seatIndex: seat1.seatIndex, playerId: 'user-1001' });
    expect(w.of('S1', 'reconnectedToTable')).toEqual([{ tableId: seat1.tableId, seatIndex: seat1.seatIndex, tournamentId: tid, sittingOut: false }]);
    expect(va.has(`${tid}\u0000user-1001`)).toBe(false);
    expect(w.sockets.get('S1').rooms.has(`table:${seat1.tableId}`)).toBe(true);
    // CONTROL — S2's socket plays the cash seat: untouched, his tournament seat stays absent.
    expect(w.playerSessions.get('S2').tableId).toBe('CASH');
    expect(w.of('S2', 'reconnectedToTable')).toEqual([]);
    expect(va.has(`${tid}\u0000user-1002`)).toBe(true);
    expect(w.tables.get(seat2.tableId)!.seats[seat2.seatIndex].playerId).toBe('user-1002');
    // CONTROL — S3 was at his table: no restore frame.
    expect(w.playerSessions.get('S3')).toMatchObject({ tableId: seat3.tableId, seatIndex: seat3.seatIndex });
    expect(w.of('S3', 'reconnectedToTable')).toEqual([]);
    expect(w.m.qualifierPreStart.reboundAtDeal).toBe(1);
    expect(w.logEvents('qualifier_prestart_deal')).toEqual([expect.objectContaining({ rebound: 1, released: 0, alive: 6 })]);
    expect(w.logs.filter((l) => l.startsWith('ERR'))).toEqual([]);
  });

  it('E19 — a registrant may still WITHDRAW while held (as until 11:00 before the open): a seated one\'s seat goes (told seatVacated; nothing was dealt), a pending one is dropped; each credit refunded once; after the deal, the refusal of before', async () => {
    const { w } = await openedEarly(6, 2);                                   // S1-S4 seated, S5 + S6 pending (offline)
    const tid = w.qt().tournamentId;
    const credits = new Map(w.qt().players.map((p: any) => [p.masterPlayerId, p.consumedCreditId]));
    const seat1 = { ...w.playerSessions.get('S1') };
    await w.sockets.get('S1').handlers.unregisterQualifierTournament({ qualifierId: WEEKLY });
    await flush();
    expect(w.of('S1', 'qualifierRegistrationResult').pop()).toMatchObject({ success: true, unregistered: true, registered: false });
    expect(w.creditRefunds).toEqual([credits.get('m-1')]);
    expect(w.qt().players.map((p: any) => p.masterPlayerId)).not.toContain('m-1');
    expect(w.tour().players.map((p: any) => p.playerId)).not.toContain('user-1001');
    expect(w.tour().entries).toBe(3);
    expect(w.tables.get(seat1.tableId)!.seats[seat1.seatIndex].state).toBe('empty');
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.of('S1', 'seatVacated')).toEqual([{ tableId: seat1.tableId, seatIndex: seat1.seatIndex, reason: 'withdrawn' }]);
    expect(w.sockets.get('S1').rooms.has(`table:${seat1.tableId}`)).toBe(false);
    // A PENDING one (back online, not seated yet) withdraws.
    const s5 = w.mkSocket('S5', 5);
    await s5.handlers.unregisterQualifierTournament({ qualifierId: WEEKLY });
    await flush();
    expect(w.of('S5', 'qualifierRegistrationResult').pop()).toMatchObject({ success: true, unregistered: true });
    expect(w.creditRefunds).toEqual([credits.get('m-1'), credits.get('m-5')]);
    expect(w.m.qualifierPreStart.withdrawnDuringHold).toBe(2);
    for (const id of w.tour().tableIds) expect(w.tables.get(id)!.handNumber).toBe(0);
    // 11:00 — S2-S4 dealt; S6 (absent, pending) released + refunded.
    jest.advanceTimersByTime(10 * S4_MIN);
    await flush();
    expect(w.tables.get(w.tour().tableIds[0])!.handNumber).toBe(1);
    expect([...w.creditRefunds].sort()).toEqual([credits.get('m-1'), credits.get('m-5'), credits.get('m-6')].sort());
    // After the deal: "already started", as before; nothing refunded.
    await w.sockets.get('S2').handlers.unregisterQualifierTournament({ qualifierId: WEEKLY });
    await flush();
    expect(w.of('S2', 'qualifierRegistrationResult').pop()).toMatchObject({ success: false, code: 'registration_closed' });
    expect(w.creditRefunds).toHaveLength(3);
    expect(w.tour().players.map((p: any) => p.playerId)).toContain('user-1002');
    void tid;
  });

  it('E20 — the balance switch OFF: the deal still levels the tables (the start\'s seating — [9,9,1] after 8 no-shows on one table is left within one, every table dealt)', async () => {
    const { w } = await openedEarly(27, 0, { balance: '0', extraCode: S4_SEATS_CODE });
    const t = w.tour();
    expect(w.tableAlive()).toEqual([9, 9, 9]);
    // 10:51 — eight of the third table's players go offline (absent at 11:00: released).
    jest.advanceTimersByTime(S4_MIN);
    const third = t.tableIds[2];
    const leaving = [...w.playerSessions].filter(([, s]) => s.tableId === third).map(([sid]) => sid).slice(0, 8);
    expect(leaving).toHaveLength(8);
    for (const sid of leaving) w.offline(sid);
    jest.advanceTimersByTime(9 * S4_MIN);                                    // 11:00
    await flush();
    const alive = w.tableAlive();
    expect(alive.reduce((a, b) => a + b, 0)).toBe(19);
    expect(alive).toHaveLength(3);
    expect(Math.max(...alive) - Math.min(...alive)).toBeLessThanOrEqual(1);   // [9,9,1] before the fix
    for (const id of t.tableIds) expect({ id, hand: w.tables.get(id)!.handNumber }).toEqual({ id, hand: 1 });
    expect(w.logEvents('qualifier_prestart_deal')[0].balanceMoves).toBeGreaterThan(0);
    expect(w.creditRefunds).toHaveLength(8);
    expect(w.logs.filter((l) => l.startsWith('ERR'))).toEqual([]);
  });

  it('wiring — the hold guards sit where the rebalance runs; the default bootstrap still deals; the manifest locks the log tags', () => {
    expect(fnSrc('function handleTableRebalance(tournamentId: string): void {')).toContain('if (qualifierPreStartHolds.has(tournamentId)) return;');
    expect(fnSrc('function sweepTournamentRebalances(')).toContain('if (qualifierPreStartHolds.has(tournamentId)) continue;');
    expect(fnSrc('function serviceQualifierOverflowTables(')).toContain('servicePreStartDealBackstop();');
    expect(fnSrc('function startQualifierTournament(')).toContain("if (opts.hold) tournamentManager.pauseTournament(tournamentId, true, 'prestart');");
    expect(fnSrc('function startMultiTableTournament(')).not.toContain('deal: false');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['qualifier_tables_opened_early', 'qualifier_prestart_deal', '/api/qualifiers/tables-open']) expect(manifest).toContain(tok);
    expect(slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);')).toContain("'QUALIFIER_TABLES_OPEN_SET'");
    expect(SRC).toContain('let qualifierTablesOpenLeadMin = qualifierTablesOpenBeforeMin(process.env.QUALIFIER_TABLES_OPEN_BEFORE_MIN);');
    // Review fix-up — the wait comes BEFORE the hold is dropped; only the early rooms' deal levels with the switch off;
    // the break end and a director's resume still read it; the new tags and the durable audit are locked.
    const deal = fnSrc('function runPreStartDeal(');
    expect(deal.indexOf('if (preStartDealMustWait(tournamentId, hold, now)) return;')).toBeGreaterThan(0);
    expect(deal.indexOf('if (preStartDealMustWait(tournamentId, hold, now)) return;')).toBeLessThan(deal.indexOf('qualifierPreStartHolds.delete(tournamentId);'));
    expect(SRC.split('ignoreSwitch: true').length - 1).toBe(1);
    expect(deal).toContain('balanceQualifierTablesNow(tournamentId, { ignoreSwitch: true })');
    expect(fnSrc('function applyDirectorPause(')).toContain('balanceQualifierTablesNow(tournamentId);');
    for (const tok of ['qualifier_prestart_deal_waiting', 'qualifier_prestart_cancelled', 'qualifier_tables_open_closed']) expect(manifest).toContain(tok);
    expect(slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);')).toContain("'QUALIFIER_TABLES_OPEN_CLOSED'");
  });
});

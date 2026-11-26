/**
 * 2026-11-21 (owner decisions, binding) — the ONLINE LEAGUE on
 * americanpubpoker.online: a FREE No-Limit Hold'em tournament every Monday to
 * Saturday at 6:00 PM America/Denver. The master lists it as type
 * 'online_league' (one row per night) ONLY to a caller that asks
 * (GET /qualifiers/schedule?kinds=league), and this server is the only caller
 * that asks.
 *
 *  - free: no qualifier credit is checked or consumed, buy-in 0;
 *  - ONE re-entry (a 2nd is refused 'reentry_limit');
 *  - sign-up opens at 3:00 PM (3 h before; owner 2026-11-25, was 2 h), late entry and the re-entry until
 *    7:00 PM (1 h after), 10-minute levels, a 5-minute break every 5 levels,
 *    the weekly's 50,000 stack, no seats / bubble / hand-for-hand;
 *  - never broadcast (it never takes the weekly / main channels);
 *  - league items reach only a lobby that asks ({kinds:['league']} / ?kinds=league);
 *  - frames of a league event carry kind:'league' (+ the league fields);
 *  - the results POST to the master is unchanged.
 * Every other qualifier type keeps today's exact values (pinned below).
 *
 * Index paths run the REAL src/index.ts source (sliced + transpiled) with the
 * REAL TournamentManager / PokerTable, as tests/r2Qualifiers.test.ts does.
 */
import fs from 'fs';
import path from 'path';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import {
  qualifierEventConfig, isLeagueEvent, leagueFinishFrameFields, ONLINE_LEAGUE_TYPE, parseMasterSchedule, qualifierWindows, qualifierStatusOf,
  qualifierStructure, qualifierBlindLevels, qualifierBreakConfig, qualifierTestTimeScale, seatsForTopOf, seatsForTopWith, seatsWonAt,
  QUALIFIER_BASE_STACK, QUALIFIER_MAX_REENTRIES, QUALIFIER_SIGNUP_OPENS_BEFORE_MS, QUALIFIER_LATE_REG_MS, QUALIFIER_LEVEL_MINUTES,
  QUALIFIER_BREAK_EVERY_LEVELS, QUALIFIER_BREAK_MINUTES, qualifierReEntriesLeft, parseQualifierOverflowCapUpdate,
  qualifierOverflowCapLabel, QUALIFIER_LATE_REG_CLOSED_BUBBLE_TEXT, qualifierLateRegClosedText,
  notQualifiedText, onlineLeagueGivesWeeklyCredits,
} from '../src/game/qualifierSchedule';
import { samplePresence, partitionByPresence, QUALIFIER_PRESENCE_LEAD_MS, noShowsSeatedAbsent, presentNeededToStart } from '../src/game/qualifierNoShow';
import { resolveEventKey, resolveNext, isBroadcastableQualifier, type EventWorld } from '../src/broadcast/eventKey';
import { SRC, slice, fnSrc, handlerSrc, load, flush } from './helpers/indexSource';
import { registrantNamesOf, qualifierResultsPointer } from '../src/game/lobbyLists';
import { qualifierWorld } from './helpers/broadcastWorld';
import { broadcastRig } from './helpers/broadcastRig';
import { createHash, timingSafeEqual } from 'crypto';

const H = 3600_000;
const MIN = 60_000;
const LEAGUE = 'c0ffee00-1111-4222-8333-444455556666';          // a master online_qualifiers row id (one night)
const LEAGUE_ID = '2e4d68d2-c71e-4447-b16d-38e31f3a9ffd';      // the Online League (master utils/onlineLeague.js)
const WEEKLY = '0e10e632-5a4c-4d0d-a5e9-b785266149fb';
/** Wed Nov 25 2026, 6:00 PM MST = 2026-11-26T01:00:00Z — the first night. */
const FIRST_NIGHT = Date.parse('2026-11-26T01:00:00.000Z');

/** A schedule item exactly as the master sends it to ?kinds=league (scheduleContract example). */
const leagueItem = (at: number, extra: Record<string, unknown> = {}) => ({
  id: LEAGUE, name: 'Online League — Wed, Nov 25', type: 'online_league', clientQualifierId: LEAGUE,
  scheduledAt: new Date(at).toISOString(), weekStarting: '2026-11-25', status: 'open', seatPackage: null,
  kind: 'league', leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 1, ...extra,
});
const weeklyItem = (at: number) => ({
  id: WEEKLY, name: 'Weekly Qualifier — 2026-11-23', type: 'weekly', clientQualifierId: 'weekly-qualifier',
  scheduledAt: new Date(at).toISOString(), weekStarting: '2026-11-23', status: 'open', seatPackage: null,
  kind: 'qualifier', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null,
});

/** Today's exact values for every non-league type (pinned: the weekly / monthly / TOC never change). */
const QUALIFIER_CFG = {
  kind: 'qualifier', requiresQualifierCredit: true, maxReEntries: null,
  signupOpensBeforeMs: 3 * H, lateRegMs: 3 * H, levelMinutes: 12,
  tournamentName: 'Qualifier Tournament', tableLabel: 'Qualifier Table', noun: 'qualifier',
};
const LEAGUE_CFG = {
  kind: 'league', requiresQualifierCredit: false, maxReEntries: 1,
  signupOpensBeforeMs: 3 * H, lateRegMs: 60 * MIN, levelMinutes: 10,
  tournamentName: 'Online League', tableLabel: 'Online League Table', noun: 'Online League game',
};

// ═══════════════════════════════════════════════════════════════ pure
describe('qualifierSchedule (pure): the event config, windows, structure and the schedule fields', () => {
  it('qualifierEventConfig: today\'s exact values for every existing type (and unknown / missing); the league\'s own', () => {
    for (const t of ['weekly', 'monthly', 'console_weekly', 'console_monthly', 'toc', 'yearly', 'nonsense', '', undefined, null, 7]) {
      expect({ t, cfg: qualifierEventConfig(t) }).toEqual({ t, cfg: QUALIFIER_CFG });
    }
    // The existing constants ARE those values.
    expect(QUALIFIER_CFG).toMatchObject({
      maxReEntries: QUALIFIER_MAX_REENTRIES, signupOpensBeforeMs: QUALIFIER_SIGNUP_OPENS_BEFORE_MS,
      lateRegMs: QUALIFIER_LATE_REG_MS, levelMinutes: QUALIFIER_LEVEL_MINUTES,
    });
    expect(ONLINE_LEAGUE_TYPE).toBe('online_league');
    expect(qualifierEventConfig('online_league')).toEqual(LEAGUE_CFG);
    // Case-sensitive, like the master's CHECK constraint value.
    expect(qualifierEventConfig('ONLINE_LEAGUE')).toEqual(QUALIFIER_CFG);
    // The config objects are frozen: nothing can change a rule at runtime.
    expect(Object.isFrozen(qualifierEventConfig('weekly'))).toBe(true);
    expect(Object.isFrozen(qualifierEventConfig('online_league'))).toBe(true);
  });

  it('isLeagueEvent: by the registry entry\'s type only', () => {
    expect(isLeagueEvent({ qualifierType: 'online_league' })).toBe(true);
    for (const t of ['weekly', 'monthly', 'toc', undefined]) expect(isLeagueEvent({ qualifierType: t as any })).toBe(false);
    expect(isLeagueEvent(null)).toBe(false);
    expect(isLeagueEvent(undefined)).toBe(false);
  });

  it('leagueFinishFrameFields: {} on any qualifier; on a league night kind + the league fields + field', () => {
    expect(leagueFinishFrameFields({ qualifierType: 'weekly', leagueId: LEAGUE_ID, leaguePoints: true } as any, 9)).toEqual({});
    expect(leagueFinishFrameFields(null, 3)).toEqual({});
    expect(leagueFinishFrameFields({ qualifierType: 'online_league', leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 6 }, 12))
      .toEqual({ kind: 'league', leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 6, field: 12 });
    expect(leagueFinishFrameFields({ qualifierType: 'online_league' }, NaN))
      .toEqual({ kind: 'league', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null, field: 0 });
  });

  it('qualifierWindows: no type === \'weekly\' === today, byte for byte; the league opens 3 h before (3:00 PM) and closes 60 min after (7:00 PM)', () => {
    const at = Date.parse('2026-11-29T18:00:00.000Z');           // Sun 11:00 AM MST
    expect(JSON.stringify(qualifierWindows(at))).toBe(JSON.stringify(qualifierWindows(at, 'weekly')));
    expect(qualifierWindows(at)).toEqual({ signupOpensAt: at - 3 * H, signupClosesAt: at + 3 * H, lateRegUntil: at + 3 * H });
    for (const t of ['monthly', 'toc', 'console_weekly']) expect(qualifierWindows(at, t)).toEqual(qualifierWindows(at));
    const w = qualifierWindows(FIRST_NIGHT, 'online_league');
    expect(new Date(w.signupOpensAt).toISOString()).toBe('2026-11-25T22:00:00.000Z');     // 3:00 PM MST
    expect(new Date(w.lateRegUntil).toISOString()).toBe('2026-11-26T02:00:00.000Z');      // 7:00 PM MST
    expect(w.signupClosesAt).toBe(w.lateRegUntil);
  });

  it('qualifierStatusOf follows the type\'s signup window', () => {
    const now = FIRST_NIGHT - 150 * MIN;                          // 3:30 PM: inside the weekly's 3 h AND the league's 3 h (owner 2026-11-25)
    expect(qualifierStatusOf('pending', FIRST_NIGHT, now)).toBe('registering');
    expect(qualifierStatusOf('pending', FIRST_NIGHT, now, 'weekly')).toBe('registering');
    expect(qualifierStatusOf('pending', FIRST_NIGHT, now, 'online_league')).toBe('registering');
    expect(qualifierStatusOf('pending', FIRST_NIGHT, FIRST_NIGHT - 181 * MIN, 'online_league')).toBe('scheduled');   // 2:59 PM
    expect(qualifierStatusOf('pending', FIRST_NIGHT, FIRST_NIGHT - 179 * MIN, 'online_league')).toBe('registering'); // 3:01 PM
    expect(qualifierStatusOf('running', FIRST_NIGHT, now, 'online_league')).toBe('running');
  });

  it('structure: the weekly\'s 12-minute JSON is identical to today; the league runs the SAME blinds at 10 minutes; breaks unchanged', () => {
    const weekly = qualifierStructure(QUALIFIER_BASE_STACK);
    expect(JSON.stringify(weekly)).toBe(JSON.stringify(qualifierStructure(QUALIFIER_BASE_STACK, 12)));
    expect(weekly.levels.every((l) => l.minutes === 12)).toBe(true);
    expect(weekly.levels[0]).toEqual({ sb: 25, bb: 50, ante: 0, minutes: 12 });
    const league = qualifierStructure(QUALIFIER_BASE_STACK, qualifierEventConfig('online_league').levelMinutes);
    expect(league.levels.every((l) => l.minutes === 10)).toBe(true);
    expect(league.levels.map((l) => [l.sb, l.bb, l.ante])).toEqual(weekly.levels.map((l) => [l.sb, l.bb, l.ante]));
    expect(league.startingStack).toBe(50_000);                    // the weekly's stack
    expect(league.breaks).toEqual({ everyLevels: QUALIFIER_BREAK_EVERY_LEVELS, minutes: QUALIFIER_BREAK_MINUTES });
    expect(league.breaks).toEqual({ everyLevels: 5, minutes: 5 });
    for (const bad of [0, -3, NaN, Infinity, undefined as any]) {
      expect(qualifierStructure(QUALIFIER_BASE_STACK, bad).levels.every((l) => l.minutes === 12)).toBe(true);
    }
    // The engine's levels.
    expect(JSON.stringify(qualifierBlindLevels(50_000))).toBe(JSON.stringify(qualifierBlindLevels(50_000, 1, 12)));
    expect(qualifierBlindLevels(50_000).every((l) => l.duration === 720)).toBe(true);
    expect(qualifierBlindLevels(50_000, 1, 10).every((l) => l.duration === 600)).toBe(true);
    expect(qualifierBlindLevels(50_000, 60, 10).every((l) => l.duration === 10)).toBe(true);    // the rig's time scale
    expect(qualifierBreakConfig(1)).toEqual({ everyLevels: 5, seconds: 300 });
  });

  it('the longest league night (every level played + 5 breaks) ends by 10:45 PM MT, inside the 11:30 PM no-deploy window', () => {
    const s = qualifierStructure(QUALIFIER_BASE_STACK, 10);
    const levelMinutes = s.levels.reduce((n, l) => n + l.minutes, 0);
    const breaks = Math.floor((s.levels.length - 1) / s.breaks.everyLevels);    // never after the last level
    expect(s.levels.length).toBe(26);
    expect(levelMinutes + breaks * s.breaks.minutes).toBe(285);
    const end = FIRST_NIGHT + 285 * MIN;
    expect(new Date(end).toISOString()).toBe('2026-11-26T05:45:00.000Z');       // 10:45 PM MST
    expect(end).toBeLessThan(Date.parse('2026-11-26T06:30:00.000Z'));           // 11:30 PM MST
  });

  it('no championship seats, so no seat bubble, no hand-for-hand, no late close at the bubble', () => {
    expect(seatsForTopOf('online_league')).toBe(0);
    expect(seatsForTopWith('online_league', null)).toBe(0);
    expect(seatsWonAt('online_league', null, 1)).toBe(0);
  });

  it('parseMasterSchedule: the league fields of an online_league item; the old shape → kind from the type, the rest null', () => {
    const list = parseMasterSchedule({ success: true, data: { schedule: [leagueItem(FIRST_NIGHT), weeklyItem(FIRST_NIGHT + 4 * 24 * H)] } });
    expect(list).toEqual([
      {
        id: LEAGUE, name: 'Online League — Wed, Nov 25', type: 'online_league', clientQualifierId: LEAGUE, scheduledAt: FIRST_NIGHT,
        status: 'open', seatPackage: null, kind: 'league', leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 1,
      },
      expect.objectContaining({ id: WEEKLY, type: 'weekly', kind: 'qualifier', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null }),
    ]);
    // An old master (no new fields at all).
    const old = parseMasterSchedule({ schedule: [{ id: LEAGUE, type: 'online_league', scheduledAt: new Date(FIRST_NIGHT).toISOString(), status: 'open' }] });
    expect(old[0]).toMatchObject({ kind: 'league', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null });
    const oldWeekly = parseMasterSchedule({ schedule: [{ id: WEEKLY, type: 'weekly', scheduledAt: new Date(FIRST_NIGHT).toISOString(), status: 'open' }] });
    expect(oldWeekly[0]).toMatchObject({ kind: 'qualifier', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null });
  });

  it('parseMasterSchedule: junk league fields are null; a NON-league item never carries league fields; kind comes from the TYPE, never the item', () => {
    const junk = parseMasterSchedule({ schedule: [leagueItem(FIRST_NIGHT, { leagueId: 'not-an-id', leaguePoints: 'yes', leaguePrize: 'cash', leagueAwardsMinField: 0 })] })[0];
    expect(junk).toMatchObject({ kind: 'league', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null });
    expect(parseMasterSchedule({ schedule: [leagueItem(FIRST_NIGHT, { leagueAwardsMinField: 1.5 })] })[0].leagueAwardsMinField).toBeNull();
    expect(parseMasterSchedule({ schedule: [leagueItem(FIRST_NIGHT, { leagueAwardsMinField: 6, leaguePoints: false, leaguePrize: null })] })[0])
      .toMatchObject({ leagueAwardsMinField: 6, leaguePoints: false, leaguePrize: null });
    // A hyphen-less id is accepted (the master canonicalises; 32-36 hex / hyphen chars).
    expect(parseMasterSchedule({ schedule: [leagueItem(FIRST_NIGHT, { leagueId: LEAGUE_ID.replace(/-/g, '') })] })[0].leagueId).toBe(LEAGUE_ID.replace(/-/g, ''));
    // A weekly that (wrongly) carries league fields, and an item claiming kind 'league' with a weekly type.
    const w = parseMasterSchedule({ schedule: [{ ...weeklyItem(FIRST_NIGHT), kind: 'league', leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 1 }] })[0];
    expect(w).toMatchObject({ type: 'weekly', kind: 'qualifier', leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null });
  });
});

// ═══════════════════════════════════════════════════════════════ the schedule fetch (opt-in)
describe('syncQualifierSchedule asks for league rows (?kinds=league) — the ONLY league request', () => {
  it('the fetch URL ends /qualifiers/schedule?kinds=league; the answer is applied as before', async () => {
    const fetches: string[] = [];
    const applied: unknown[] = [];
    const { exports: m } = load([slice('const qualifierSyncStats = {', '\n}\n'), fnSrc('async function syncQualifierSchedule(')].join('\n'), {
      qualifierTournaments: new Map(),
      process: { env: { INTERNAL_NOTIFY_TOKEN: 't', MASTER_API_URL: 'https://master.test' } },
      fetch: async (url: string) => { fetches.push(url); return { ok: true, status: 200, json: async () => ({ success: true, data: { schedule: [] } }) }; },
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      parseMasterSchedule: (b: unknown) => b, applyQualifierSchedule: (l: unknown) => { applied.push(l); },
      console: { log() {}, warn() {}, error() {} },
    }, '{ syncQualifierSchedule }');
    await m.syncQualifierSchedule();
    expect(fetches).toEqual(['https://master.test/qualifiers/schedule?kinds=league']);
    expect(fetches[0].endsWith('/qualifiers/schedule?kinds=league')).toBe(true);
    expect(applied).toHaveLength(1);
    // Exactly one league request in the whole server.
    expect(SRC.split('qualifiers/schedule?kinds=league').length - 1).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════ the real index.ts paths
const CODE = [
  fnSrc('function applyQualifierSchedule('),
  fnSrc('function qualifierEventFor('),
  fnSrc('function qualifierListItem('),
  fnSrc('function qualifierList('),
  // 2026-11-25 (owner: lobby lists) — registrantNames / resultsTournamentId (lobbyLists.ts).
  fnSrc('function qualifierLobbyListFields('),
  fnSrc('function releaseQualifierRegistration('),
  fnSrc('function socketsOfMaster('),
  slice('/** R2 (TOURNEY-9) — the answer when a qualifier seat would take over', '\n  return null;\n}\n'),
  slice('const qualifierCancellations = { cancelled: 0, creditsRefunded: 0 };', '\n}\n'),
  fnSrc('function markQualifierFinished('),
  fnSrc('function qualifierOfTournament('),
  fnSrc('function qualifierResultOf('),
  fnSrc('function pruneFinishedQualifiers('),
  slice('const qualifierNoShows = { released: 0, toldOnSignIn: 0 };', '\n    return 0;\n  }\n}\n'),
  slice('const QUALIFIER_START_TIMER_LEAD_MS', ';\n'),
  slice('const qualifierStartTimers = new Map', ';\n'),
  fnSrc('function tickQualifierAutoStart('),
  slice('const postedQualifierResults = new Set<string>();', '\n}\n'),
  fnSrc('function emitTournamentFinishedToEntrants('),
  fnSrc('function socketPlaysLiveSeatElsewhere('),
  fnSrc('function tournamentEntrantPlayerId('),
  slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n'),
  fnSrc('function tournamentLiveSeatIndex('),
  fnSrc('function tournamentLiveSeatOf('),
  fnSrc('function tournamentSeatIsPlaceable('),
  fnSrc('function vacateBustedTournamentSeat('),
  fnSrc('function seatQualifierReentrantOnBustedSeat('),
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
  fnSrc('function setQualifierOverflowTablesMax('),
  fnSrc('function internalTokenMatches('),
  slice("app.post('/api/qualifiers/overflow'", '\n});\n'),
  fnSrc('function qualifierLateEntryBubbleOf('),
  fnSrc('function noteQualifierLateRegClosedAtBubble('),
  // 2026-11-21 — the Online League's health counters and the REST lobby list.
  slice('const onlineLeagueStats = {', ';\n'),
  slice("app.get('/api/qualifier-tournaments', ", '\n});\n'),
].join('\n');
const HANDLERS = ['registerQualifierTournament', 'unregisterQualifierTournament', 'getQualifierTournaments']
  .map((ev) => handlerSrc(ev, '\n  });\n')).join('\n  ');

const ALICE = 101;
const BOB = 102;

function world(opts: { overflowMax?: number; qualified?: (masterId: string, tier: string) => boolean } = {}) {
  const qualifierTournaments = new Map<string, any>();
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const sockets = new Map<string, any>();
  const globalEmits: Array<[string, any]> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const consumed: Array<{ masterId: string; tier: string; label: string }> = [];
  const qualifiedChecks: Array<{ masterId: string; tier: string }> = [];
  const creditRefunds: string[] = [];
  const fetches: Array<{ url: string; method: string; body: any }> = [];
  const started: Array<{ players: any[]; stack: number; turbo: boolean; opts: any }> = [];
  const tournamentTables = new Map<string, string>();
  const overflowCreates: Array<{ name: string; max: number; sb: number; bb: number; minBuyIn: number; variant: unknown; ante: number }> = [];
  const routes = new Map<string, (req: any, res: any) => void>();
  let creditN = 0;
  let overflowN = 0;
  const scope: Record<string, unknown> = {
    qualifierTournaments, tournamentManager: tm, authSessions, playerSessions, multiTableSessions: new Map(), spectators: new Map(),
    tableManager: {
      getTable: (id: string) => tables.get(id),
      createQuickTable: (name: string, max: number, sb: number, bb: number, minBuyIn: number, variant?: unknown, ante = 0) => {
        overflowCreates.push({ name, max, sb, bb, minBuyIn, variant, ante });
        const id = `OV${++overflowN}`;
        tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante, minBuyIn, maxBuyIn: minBuyIn * 10, maxPlayers: max } as any));
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
    // 2026-11-21 — the event config and the finish frames' league fields (the REAL pure module).
    qualifierEventConfig, leagueFinishFrameFields,
    // 2026-11-25 (owner: lobby lists) — the REAL pure helpers qualifierLobbyListFields reads.
    registrantNamesOf, qualifierResultsPointer,
    // Repair round 2 (mechanical harness addition) — the not_qualified text (the REAL pure module).
    notQualifiedText, onlineLeagueGivesWeeklyCredits,
    qualifierWindows, qualifierStatusOf, seatsForTopOf, seatsForTopWith, seatsWonAt, qualifierStructure, QUALIFIER_BASE_STACK,
    QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers: new Map(),
    samplePresence, partitionByPresence, QUALIFIER_PRESENCE_LEAD_MS, noShowsSeatedAbsent, presentNeededToStart,
    assertPlayable: async () => null,
    isPlayerQualified: async (masterId: string, tier: string) => { qualifiedChecks.push({ masterId, tier }); return opts.qualified ? opts.qualified(masterId, tier) : true; },
    consumeQualifierCreditOnMaster: async (masterId: string, tier: string, _q: string, label: string) => {
      consumed.push({ masterId, tier, label });
      return { consumed: true, creditId: `credit-${++creditN}` };
    },
    refundQualifierCreditOnMaster: async (id: string) => { creditRefunds.push(id); return true; },
    realClientIp: (s: any) => s.ip || '10.0.0.1',
    seatNameForSocket: (s: any) => authSessions.get(s.id)?.displayName || 'Player',
    progressionManager: { getOrCreateProgress() {} },
    publicNameOf: (n: unknown) => String(n ?? 'Player'),
    detachSocketFromOtherTables() {}, broadcastGameState() {},
    startQualifierTournament: (players: any[], stack: number, turbo: boolean, o: any) => {
      started.push({ players, stack, turbo, opts: o });
      return { tournamentId: 'TQ', tableIds: ['Q9'], tableCount: 1 };
    },
    noteFinishedTournament: () => ({ finishedAt: Date.now(), entrants: [] }),
    finishedEntrantIsAccount: () => false,
    tournamentFinishedNotices: { roomBroadcasts: 0, entrantSockets: 0 },
    ensureChipsForBuyIn: async () => 0,
    deductChips: async () => false,
    addChipsToUser: async () => true,
    auditLog: (actor: string, action: string, d: any) => audits.push({ actor, action, d }),
    PLAYER_SUSPENDED_MESSAGE: 'SUSPENDED', lastQualifierFetch: 1,
    process: { env: { INTERNAL_NOTIFY_TOKEN: 't', MASTER_API_URL: 'https://master.test' } },
    fetch: async (url: string, init: any) => {
      fetches.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    uuidv4: () => `u${Math.random().toString(36).slice(2, 10)}`,
    console: { log() {}, warn() {}, error() {} },
    MAX_SEATS: 9, reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(),
    syncSitOutToTable() {}, tournamentHandStartSafety: { bustedSeatsVacated: 0 }, tournamentTables,
    handlePlayerLeave() {},
    getGameStateForPlayer: () => ({}), emitGameState() {},
    qualifierOverflowTablesMax: opts.overflowMax ?? 0,
    fastModeTables: new Map(), tableProgressListeners: new Set(), GamePhase,
    ensureTableProgressListener() {}, scheduleAIAction() {},
    tournamentDealHoldReason: () => null,
    app: {
      post: (p: string, fn: (req: any, res: any) => void) => { routes.set(`POST ${p}`, fn); },
      get: (p: string, fn: (req: any, res: any) => void) => { routes.set(`GET ${p}`, fn); },
    },
    createHash, timingSafeEqual, parseQualifierOverflowCapUpdate, qualifierOverflowCapLabel,
    QUALIFIER_LATE_REG_CLOSED_BUBBLE_TEXT, qualifierLateRegClosedText,
  };
  const { exports: m, stubbed } = load(`${CODE}\nfunction wire(socket) {\n  ${HANDLERS}\n}`, scope, `{
    wire, applyQualifierSchedule, qualifierList, qualifierEventFor, markQualifierFinished, emitTournamentFinishedToEntrants,
    tickQualifierAutoStart, postQualifierResults, cancelQualifierEvent, qualifierLateEntries, onlineLeagueStats,
    openQualifierOverflowTable, qualifierLateEntryBubbleOf,
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
  const last = (sid: string, ev = 'qualifierRegistrationResult') => of(sid, ev).slice(-1)[0];
  /** The master's answer to ?kinds=league with these items, applied at `now`. */
  const sync = (items: unknown[], now: number = Date.now()) => m.applyQualifierSchedule(parseMasterSchedule({ success: true, data: { schedule: items } }), now);
  /** GET /api/qualifier-tournaments through the REAL route. */
  const rest = (query: Record<string, unknown> = {}) => {
    let body: any = null;
    routes.get('GET /api/qualifier-tournaments')!({ query, params: {}, headers: {} }, { json: (b: unknown) => { body = b; } });
    return body;
  };
  return {
    m, stubbed, tm, tables, scope, qualifierTournaments, authSessions, playerSessions, sockets, emitted, globalEmits, roomEmits, audits,
    consumed, qualifiedChecks, creditRefunds, fetches, started, tournamentTables, overflowCreates, mkSocket, of, last, sync, rest,
  };
}
type World = ReturnType<typeof world>;

/** A RUNNING league night that started `ago` ms ago: Bob (seat 0) + Carl (seat 1) at Q1, `usable` seats there. */
function runningLeague(ago: number, o: { usable?: number; overflowMax?: number } = {}) {
  const w = world({ overflowMax: o.overflowMax });
  w.sync([leagueItem(Date.now() - ago)]);
  const qt = w.qualifierTournaments.get(LEAGUE);
  expect(qt).toBeTruthy();
  const tid = w.tm.createTournament({ name: 'Online League', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: qualifierBlindLevels(50_000, 1, 10), startingChips: 50_000 } as any);
  w.tm.registerPlayer(tid, 'user-201', 'Bob', 'sb', undefined, 'm-201');
  w.tm.registerPlayer(tid, 'user-202', 'Carl', 'sc', undefined, 'm-202');
  w.tm.startTournament(tid);
  const t = new PokerTable({ tableId: 'Q1', tableName: 'Q1', smallBlind: 25, bigBlind: 50, minBuyIn: 50_000, maxBuyIn: 500_000, maxPlayers: 9 } as any);
  t.maxOccupiableSeats = o.usable ?? 9;
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
/** The bust check ran on `pid`'s live seat (0 chips, eliminated, the seat left occupied). */
function bust(w: World, tid: string, t: PokerTable, pid: string): void {
  const i = t.seats.findIndex((s) => s.state === 'occupied' && !s.eliminated && s.playerId === pid);
  expect(i).toBeGreaterThanOrEqual(0);
  t.seats[i].chipCount = 0;
  (t.seats[i] as any).eliminated = true;
  w.tm.eliminatePlayer(tid, pid);
}
const enter = (s: any, qualifierId = LEAGUE) => s.handlers.registerQualifierTournament({ qualifierId, playerName: 'x' });

describe('applyQualifierSchedule: the league entry is free, one re-entry, 10-minute levels; the weekly entry is unchanged', () => {
  it('a listed league night → requiresQualifierCredit false, maxReEntries 1, kind + league fields, a 10-minute structure; the weekly: exactly as before', () => {
    const w = world();
    w.sync([leagueItem(Date.now() + H), weeklyItem(Date.now() + 2 * 24 * H)]);
    expect(w.qualifierTournaments.get(LEAGUE)).toMatchObject({
      qualifierType: 'online_league', qualifierName: 'Online League — Wed, Nov 25', clientQualifierId: LEAGUE, status: 'registering',
      startingStack: 50_000, requiresQualifierCredit: false, maxReEntries: 1, kind: 'league',
      leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 1,
    });
    expect(w.qualifierTournaments.get(LEAGUE).blindStructure.every((l: any) => l.minutes === 10)).toBe(true);
    const weekly = w.qualifierTournaments.get(WEEKLY);
    expect(weekly).toMatchObject({ qualifierType: 'weekly', requiresQualifierCredit: true, status: 'registering' });
    for (const k of ['kind', 'maxReEntries', 'leagueId', 'leaguePoints', 'leaguePrize', 'leagueAwardsMinField']) expect({ k, has: k in weekly }).toEqual({ k, has: false });
    expect(weekly.blindStructure).toEqual(qualifierStructure(QUALIFIER_BASE_STACK).levels);
    expect(w.m.onlineLeagueStats.eventsOpened).toBe(1);
  });

  it('a NEW league night is not opened after 7:00 PM (its late entry ended); the weekly keeps its 3-hour window', () => {
    const w = world();
    w.sync([leagueItem(Date.now() - 61 * MIN), weeklyItem(Date.now() - 61 * MIN)]);
    expect(w.qualifierTournaments.has(LEAGUE)).toBe(false);
    expect(w.qualifierTournaments.has(WEEKLY)).toBe(true);
    const w2 = world();
    w2.sync([leagueItem(Date.now() - 59 * MIN)]);
    expect(w2.qualifierTournaments.has(LEAGUE)).toBe(true);
  });

  it('an existing league entry follows the master\'s league fields on every sync (like seatPackage); a night dropped before its start is cancelled', async () => {
    const w = world();
    w.sync([leagueItem(Date.now() + H)]);
    w.sync([leagueItem(Date.now() + H, { leaguePrize: null, leaguePoints: false, leagueAwardsMinField: 6 })]);
    expect(w.qualifierTournaments.get(LEAGUE)).toMatchObject({ leaguePrize: null, leaguePoints: false, leagueAwardsMinField: 6, kind: 'league' });
    // The kill switch (ONLINE_LEAGUE_ENABLED off): the night leaves the schedule → cancelled before it starts.
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    w.sync([]);
    await flush();
    expect(w.qualifierTournaments.get(LEAGUE)).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.of('SA', 'qualifierCancelled')).toEqual([{ qualifierId: LEAGUE, reason: 'removed_from_schedule', creditRefunded: false, kind: 'league' }]);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.onlineLeagueStats.cancelled).toBe(1);
  });
});

describe('the lobby list: league items only for a caller that asks', () => {
  it('qualifierList: no league item by default; {includeLeague:true} → the league item with its fields; the weekly item gains kind:\'qualifier\' + nulls', () => {
    const w = world();
    const at = Date.now() + H;
    w.sync([leagueItem(at), weeklyItem(Date.now() + 2 * 24 * H)]);
    expect(w.m.qualifierList(null).map((q: any) => q.qualifierId)).toEqual([WEEKLY]);
    const items = w.m.qualifierList(null, Date.now(), { includeLeague: true });
    expect(items.map((q: any) => q.qualifierId)).toEqual([LEAGUE, WEEKLY]);
    const [league, weekly] = items;
    expect(league).toMatchObject({
      qualifierId: LEAGUE, type: 'online_league', name: 'Online League — Wed, Nov 25', kind: 'league', requiresCredit: false,
      leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 1, maxReEntries: 1,
      scheduledAt: new Date(at).toISOString(), signupOpensAt: new Date(at - 3 * H).toISOString(),
      signupClosesAt: new Date(at + H).toISOString(), lateRegUntil: new Date(at + H).toISOString(),
      status: 'registering', seatsForTop: 0, seatPackage: null, lateRegClosesAtBubble: false,
    });
    expect(league.structure.levels.every((l: any) => l.minutes === 10)).toBe(true);
    expect(league.structure.breaks).toMatchObject({ everyLevels: 5, minutes: 5 });
    expect(league.structure.startingStack).toBe(50_000);
    expect(weekly).toMatchObject({
      kind: 'qualifier', requiresCredit: true, leagueId: null, leaguePoints: null, leaguePrize: null, leagueAwardsMinField: null,
      lateRegClosesAtBubble: true, seatsForTop: 3,
    });
    expect(weekly.structure.levels.every((l: any) => l.minutes === 12)).toBe(true);
    // Nothing the list reads is stubbed.
    expect([...w.stubbed].filter((n) => /qualifierEventConfig|qualifierWindows|qualifierStatusOf|qualifierStructure|onlineLeagueStats/.test(n))).toEqual([]);
  });

  it('signup opens at 3:00 PM: 3.5 h before the start the league card says scheduled; 2.5 h before it says registering', () => {
    const w0 = world();
    const at0 = Date.now() + 150 * MIN;
    w0.sync([leagueItem(at0)]);
    expect(w0.m.qualifierList(null, Date.now(), { includeLeague: true })[0].status).toBe('registering');
    const w = world();
    const at = Date.now() + 210 * MIN;
    w.sync([leagueItem(at)]);
    expect(w.m.qualifierList(null, Date.now(), { includeLeague: true })[0].status).toBe('scheduled');
  });

  it('socket getQualifierTournaments: no payload / null / a non-array kinds → no league item; {kinds:[\'league\']} → the league item; the listener takes no required parameter', async () => {
    const w = world();
    w.sync([leagueItem(Date.now() + H), weeklyItem(Date.now() + 2 * 24 * H)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    expect(a.handlers.getQualifierTournaments.length).toBe(0);                 // socketGuard: never payload-checked
    expect(handlerSrc('getQualifierTournaments', '\n  });\n')).toContain('async (data: { kinds?: unknown } = {}) =>');
    await a.handlers.getQualifierTournaments();
    await a.handlers.getQualifierTournaments(null);
    await a.handlers.getQualifierTournaments({ kinds: 'league' });
    await a.handlers.getQualifierTournaments({ kinds: ['weekly'] });
    await a.handlers.getQualifierTournaments({ kinds: ['league'] });
    const lists = w.of('SA', 'qualifierTournamentList').map((l: any[]) => l.map((q) => q.qualifierId));
    expect(lists).toEqual([[WEEKLY], [WEEKLY], [WEEKLY], [WEEKLY], [LEAGUE, WEEKLY]]);
    expect(w.m.onlineLeagueStats.listRequests).toBe(1);
  });

  it('REST /api/qualifier-tournaments: league items only with ?kinds=league (a comma list)', () => {
    const w = world();
    w.sync([leagueItem(Date.now() + H), weeklyItem(Date.now() + 2 * 24 * H)]);
    expect(w.rest().tournaments.map((q: any) => q.qualifierId)).toEqual([WEEKLY]);
    expect(w.rest({ kinds: 'weekly' }).tournaments.map((q: any) => q.qualifierId)).toEqual([WEEKLY]);
    expect(w.rest({ kinds: 'league' }).tournaments.map((q: any) => q.qualifierId)).toEqual([LEAGUE, WEEKLY]);
    expect(w.rest({ kinds: 'qualifier, LEAGUE' }).tournaments.map((q: any) => q.qualifierId)).toEqual([LEAGUE, WEEKLY]);
    expect(w.rest().success).toBe(true);
  });
});

describe('registerQualifierTournament: the league is FREE (no credit), ONE re-entry, no credit words', () => {
  it('a league registration with ZERO credits succeeds: no qualification check, no consume, no credit list read; the master registration row is written', async () => {
    const w = world({ qualified: () => false });                              // she holds NO credit of any tier
    w.sync([leagueItem(Date.now() + H)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toEqual({ success: true, qualifierId: LEAGUE, registered: true, registeredCount: 1 });
    expect(w.qualifiedChecks).toEqual([]);
    expect(w.consumed).toEqual([]);
    expect(w.scope.lastQualifierFetch).toBe(1);                              // the cached credit list was not touched
    expect(w.qualifierTournaments.get(LEAGUE).players).toEqual([expect.objectContaining({ masterPlayerId: 'm-alice', consumedCreditId: undefined })]);
    expect(w.fetches.filter((f) => f.method === 'POST').map((f) => f.url)).toEqual([`https://master.test/qualifiers/${LEAGUE}/register/internal`]);
    expect(w.m.onlineLeagueStats.entries).toBe(1);
    // Unregister: nothing to refund.
    await a.handlers.unregisterQualifierTournament({ qualifierId: LEAGUE });
    await flush();
    expect(w.creditRefunds).toEqual([]);
    expect(w.qualifierTournaments.get(LEAGUE).players).toEqual([]);
  });

  // Repair round 2 (owner-approved copy change): the refusal no longer names the
  // hidden monthly route (owner: monthlies OFF and hidden everywhere); the code,
  // the gate and the consume are unchanged. It used to pin "... top-5 in a live
  // game (weekly) or finishing top-20% of your league standings (monthly)."
  it('CONTROL — the weekly: no credit → not_qualified (no monthly route named); with a credit → exactly ONE consumed', async () => {
    const w = world({ qualified: () => false });
    w.sync([weeklyItem(Date.now() + H)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a, WEEKLY);
    expect(w.last('SA')).toEqual(expect.objectContaining({
      success: false, code: 'not_qualified',
      error: 'You need a weekly qualifier credit to enter. Earn one by finishing top-5 in a live game.',
    }));
    expect(w.consumed).toEqual([]);
    const w2 = world();
    w2.sync([weeklyItem(Date.now() + H)]);
    const b = w2.mkSocket('SB', BOB, 'm-bob', 'Bob');
    await enter(b, WEEKLY);
    expect(w2.last('SB')).toEqual({ success: true, qualifierId: WEEKLY, registered: true, registeredCount: 1 });
    expect(w2.consumed).toEqual([{ masterId: 'm-bob', tier: 'weekly', label: 'entry' }]);
    expect(w2.m.onlineLeagueStats.entries).toBe(0);
  });

  // Repair round 2 (added): the owner gave the Online League's top 5 the weekly credit.
  it('repair round 2 — the weekly refusal names the Online League route while a league night that gives credits is listed (never with points off)', async () => {
    const w = world({ qualified: () => false });
    w.sync([leagueItem(Date.now() + 20 * H), weeklyItem(Date.now() + H)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a, WEEKLY);
    expect(w.last('SA')).toEqual(expect.objectContaining({
      success: false, code: 'not_qualified',
      error: 'You need a weekly qualifier credit to enter. Earn one by finishing top-5 in a live game or in a nightly Online League game on americanpubpoker.online.',
    }));
    expect([...w.stubbed].filter((n) => /notQualifiedText|onlineLeagueGivesWeeklyCredits/.test(n))).toEqual([]);
    const off = world({ qualified: () => false });
    off.sync([leagueItem(Date.now() + 20 * H, { leaguePoints: false, leaguePrize: null }), weeklyItem(Date.now() + H)]);
    const b = off.mkSocket('SB', BOB, 'm-bob', 'Bob');
    await enter(b, WEEKLY);
    expect(off.last('SB').error).toBe('You need a weekly qualifier credit to enter. Earn one by finishing top-5 in a live game.');
    expect(off.consumed).toEqual([]);
  });

  it('repair round 2 — notQualifiedText: never names the monthly; the Online League route only on the weekly; onlineLeagueGivesWeeklyCredits reads type + points', () => {
    for (const t of ['weekly', 'console_weekly', 'toc', 'yearly', 'monthly', 'console_monthly']) {
      for (const on of [false, true]) expect(notQualifiedText(t, on)).not.toMatch(/monthly|top-20%|league standings/);
    }
    expect(notQualifiedText('monthly', true)).toBe('You need a qualifier credit to enter this event.');
    expect(notQualifiedText('weekly', true)).toMatch(/or in a nightly Online League game on americanpubpoker\.online\.$/);
    expect(notQualifiedText('console_weekly', true)).toBe('You need a console_weekly qualifier credit to enter. Earn one by finishing top-5 in a live game.');
    expect(onlineLeagueGivesWeeklyCredits([{ qualifierType: 'weekly' }])).toBe(false);
    expect(onlineLeagueGivesWeeklyCredits([{ qualifierType: 'online_league', leaguePoints: null }])).toBe(false);
    expect(onlineLeagueGivesWeeklyCredits([{ qualifierType: 'online_league', leaguePoints: false }])).toBe(false);
    expect(onlineLeagueGivesWeeklyCredits(new Map([['x', { qualifierType: 'online_league', leaguePoints: true }]]).values())).toBe(true);
  });

  it('sign-up before 3:00 PM is refused signup_not_open (3 h; owner 2026-11-25); after 7:00 PM signup_closed — no credit ever touched', async () => {
    const w = world();
    const at = Date.now() + 210 * MIN;
    w.sync([leagueItem(at)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ success: false, code: 'signup_not_open', signupOpensAt: new Date(at - 3 * H).toISOString() }));
    const { w: w2 } = runningLeague(50 * MIN);
    const b = w2.mkSocket('SB', BOB, 'm-bob', 'Bob');
    const realNow = Date.now;
    const after7pm = realNow() + 11 * MIN;                                   // 61 minutes after the start
    Date.now = () => after7pm;
    try { await enter(b); } finally { Date.now = realNow; }
    expect(w2.last('SB')).toEqual(expect.objectContaining({ success: false, code: 'signup_closed' }));
    expect([...w.consumed, ...w2.consumed]).toEqual([]);
  });

  it('LATE ENTRY (6:50 PM) is seated at once for free; ONE re-entry for free; the 2nd re-entry is refused reentry_limit (1)', async () => {
    const { w, tid, t, qt } = runningLeague(50 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ success: true, lateEntry: true, tableId: 'Q1', tournamentId: tid }));
    expect(w.m.qualifierList('m-alice', Date.now(), { includeLeague: true })[0]).toMatchObject({ registered: true, reEntriesLeft: 1, creditsHeld: null, maxReEntries: 1, reEntries: 0 });

    bust(w, tid, t, 'user-101');
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ success: true, reentry: true, tableId: 'Q1' }));
    expect(w.of('SA', 'qualifierTournamentStarted').slice(-1)[0]).toEqual(expect.objectContaining({ reentry: true, lateEntry: true }));
    const aliceReg = qt.players.find((p: any) => p.masterPlayerId === 'm-alice');
    expect(aliceReg).toMatchObject({ reEntries: 1 });
    expect(aliceReg.consumedCreditId).toBeUndefined();
    expect(aliceReg.reentryCreditIds ?? []).toEqual([]);                     // no credit to refund at a shutdown
    expect(w.m.qualifierList('m-alice', Date.now(), { includeLeague: true })[0]).toMatchObject({ reEntriesLeft: 0, reEntries: 1 });

    bust(w, tid, t, 'user-101');
    await enter(a);
    expect(w.last('SA')).toEqual({ success: false, code: 'reentry_limit', error: 'Re-entry limit reached (1)', qualifierId: LEAGUE });
    expect(w.tm.getTournament(tid)!.players.find((p) => p.playerId === 'user-101')!.eliminated).toBe(true);
    expect(w.qualifiedChecks).toEqual([]);
    expect(w.consumed).toEqual([]);
    expect(w.creditRefunds).toEqual([]);
    expect(w.m.onlineLeagueStats).toMatchObject({ entries: 1, reEntries: 1, reEntryRefused: 1 });
    expect(JSON.stringify(w.of('SA', 'qualifierRegistrationResult'))).not.toMatch(/credit/i);
  });

  it('repair round 1: a cached credit list for the league type (GET /api/qualifiers/online_league fills one with []) never zeroes the free re-entry; the weekly still reads its credits', async () => {
    const { w, tid, t } = runningLeague(50 * MIN);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ success: true, lateEntry: true }));
    // What an unauthenticated GET /api/qualifiers/online_league leaves behind:
    // no credit has the 'online_league' tier, so the cached list is empty.
    const cache = w.scope.qualifiedPlayers as Map<string, unknown[]>;
    cache.set('online_league', []);
    expect(w.m.qualifierList('m-alice', Date.now(), { includeLeague: true })[0])
      .toMatchObject({ registered: true, reEntriesLeft: 1, creditsHeld: null, maxReEntries: 1 });
    bust(w, tid, t, 'user-101');
    expect(w.m.qualifierList('m-alice', Date.now(), { includeLeague: true })[0])
      .toMatchObject({ eliminated: true, reEntriesLeft: 1, creditsHeld: null });
    // CONTROL — a credit-bound event (the weekly) still reads its tier's list.
    w.sync([weeklyItem(Date.now() + 2 * 24 * H)]);
    const weekly = [...w.qualifierTournaments.entries()].find(([, q]: [string, any]) => q.qualifierType === 'weekly');
    expect(weekly).toBeTruthy();
    weekly![1].players.push({ playerId: 'user-101', masterPlayerId: 'm-alice', playerName: 'Alice', phone: '', socketId: 'SA' });
    cache.set('weekly', [{ playerId: 'm-alice', creditCount: 2 }]);
    const wItem = w.m.qualifierList('m-alice', Date.now(), { includeLeague: true }).find((q: any) => q.type === 'weekly');
    expect(wItem).toMatchObject({ registered: true, creditsHeld: 2 });
  });

  it('no seat free: the refusals say nothing about a credit (late entry and re-entry); the weekly\'s words are unchanged', async () => {
    // Late entry: a full table, overflow tables off.
    const full = runningLeague(10 * MIN, { usable: 2 });
    const a = full.w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(full.w.last('SA')).toEqual({ success: false, code: 'no_seat', error: 'No seat is free right now. Try again in a minute.', qualifierId: LEAGUE });

    // Re-entry: her busted seat was taken by a late entrant; every seat alive.
    const { w, tid, t } = runningLeague(10 * MIN, { usable: 3 });
    const b = w.mkSocket('SB', ALICE, 'm-alice', 'Alice');
    await enter(b);
    bust(w, tid, t, 'user-101');
    const d = w.mkSocket('SD', 103, 'm-dan', 'Dan');
    await enter(d);
    await enter(b);
    expect(w.last('SB')).toEqual({ success: false, code: 'no_seat', qualifierId: LEAGUE, error: 'No seat is free for a re-entry right now. Try again in a minute.' });
    expect(w.creditRefunds).toEqual([]);
    for (const src of [handlerSrc('registerQualifierTournament', '\n  });\n')]) {
      expect(src).toContain('No seat is free for a re-entry right now — your qualifier credit was returned. Try again in a minute.');
      expect(src).toContain('No seat is free in this qualifier right now — your qualifier credit was returned.');
    }
  });

  it('a finished / cancelled league night is refused in its own words (the weekly keeps "This qualifier …")', async () => {
    const w = world();
    w.sync([leagueItem(Date.now() + H)]);
    Object.assign(w.qualifierTournaments.get(LEAGUE), { status: 'finished', cancelled: true });
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ success: false, code: 'registration_closed', error: 'This Online League game was cancelled.' }));
    Object.assign(w.qualifierTournaments.get(LEAGUE), { cancelled: false });
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ code: 'registration_closed', error: 'This Online League game has finished.' }));
    const w2 = world();
    w2.sync([weeklyItem(Date.now() + H)]);
    Object.assign(w2.qualifierTournaments.get(WEEKLY), { status: 'finished', cancelled: true });
    const b = w2.mkSocket('SB', BOB, 'm-bob', 'Bob');
    await enter(b, WEEKLY);
    expect(w2.last('SB')).toEqual(expect.objectContaining({ code: 'registration_closed', error: 'This qualifier was cancelled.' }));
  });
});

describe('the night itself: start, too-few cancel at 7:00 PM, overflow tables, results', () => {
  it('the start hands the event TYPE to startQualifierTournament (its name, tables and 10-minute levels follow it)', async () => {
    const w = world();
    const at = Date.now() + H;
    w.sync([leagueItem(at)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    const b = w.mkSocket('SB', BOB, 'm-bob', 'Bob');
    await enter(a);
    await enter(b);
    w.m.tickQualifierAutoStart(at + 1000);
    expect(w.started).toHaveLength(1);
    expect(w.started[0].opts).toEqual({ eventType: 'online_league' });
    expect(w.qualifierTournaments.get(LEAGUE)).toMatchObject({ status: 'running', tournamentId: 'TQ' });
  });

  it('fewer than 2 here: still waiting at 6:59 PM; CANCELLED after 7:00 PM (not 9:00 PM) — told with kind:\'league\', nothing refunded', async () => {
    const w = world();
    const at = Date.now() - 30 * MIN;
    w.sync([leagueItem(at), weeklyItem(at)]);
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toMatchObject({ success: true, registered: true });
    const sw = w.mkSocket('SW', BOB, 'm-bob', 'Bob');
    await enter(sw, WEEKLY);
    w.m.tickQualifierAutoStart(at + 59 * MIN);
    expect(w.qualifierTournaments.get(LEAGUE).status).toBe('registering');
    w.m.tickQualifierAutoStart(at + 61 * MIN);
    await flush();
    expect(w.qualifierTournaments.get(LEAGUE)).toMatchObject({ status: 'finished', cancelled: true });
    expect(w.of('SA', 'qualifierCancelled')).toEqual([{ qualifierId: LEAGUE, reason: 'too_few_players', creditRefunded: false, kind: 'league' }]);
    // The weekly in the same state keeps waiting (its window is 3 hours) — and its frames never carry `kind`.
    expect(w.qualifierTournaments.get(WEEKLY).status).toBe('registering');
    w.m.tickQualifierAutoStart(at + 3 * H + MIN);
    await flush();
    expect(w.of('SW', 'qualifierCancelled')).toEqual([{ qualifierId: WEEKLY, reason: 'too_few_players', creditRefunded: true }]);
    expect(w.started).toEqual([]);
  });

  // 2026-11-25 (owner: "It currently says if your not online at start you are
  // removed. It should seat you and blind you out", then "Online League only").
  describe('owner 2026-11-25: a league night SEATS its no-shows (blinded out); the weekly still releases them', () => {
    /** Player `sid` leaves (no live socket of his master any more). */
    const offline = (w: World, sid: string) => { const s = w.sockets.get(sid); if (s) s.connected = false; w.sockets.delete(sid); w.authSessions.delete(sid); };
    const actions = (w: World) => w.audits.map((a) => a.action);

    it('one here + one away at 6:00 PM: it STARTS with both (the away one seated absent); nothing released, no DELETE, no refund, no sign-in notice queued', async () => {
      const w = world();
      const at = Date.now() + H;
      w.sync([leagueItem(at)]);
      const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
      const b = w.mkSocket('SB', BOB, 'm-bob', 'Bob');
      await enter(a);
      await enter(b);
      offline(w, 'SB');
      w.m.tickQualifierAutoStart(at + 1000);
      expect(w.started).toHaveLength(1);
      expect(w.started[0].players.map((p: any) => p.masterId).sort()).toEqual(['m-alice', 'm-bob']);
      const qt = w.qualifierTournaments.get(LEAGUE);
      expect(qt).toMatchObject({ status: 'running', tournamentId: 'TQ' });
      expect(qt.players.map((p: any) => p.masterPlayerId).sort()).toEqual(['m-alice', 'm-bob']);
      await flush();
      expect(actions(w)).not.toContain('QUALIFIER_NO_SHOW_RELEASED');
      expect(w.audits.filter((x) => x.action === 'QUALIFIER_NO_SHOW_SEATED_ABSENT').map((x) => x.d)).toEqual([
        expect.objectContaining({ qualifierId: LEAGUE, masterId: 'm-bob', where: 'start' }),
      ]);
      expect(w.fetches.filter((f) => f.method === 'DELETE')).toEqual([]);
      expect(w.creditRefunds).toEqual([]);
      expect(w.of('SA', 'qualifierCancelled')).toEqual([]);
      // The weekly's helper rule, unchanged: a league night needs one here.
      expect([presentNeededToStart('league'), presentNeededToStart(undefined), presentNeededToStart('weekly')]).toEqual([1, 2, 2]);
      expect([noShowsSeatedAbsent('league'), noShowsSeatedAbsent(undefined), noShowsSeatedAbsent('weekly')]).toEqual([true, false, false]);
      expect([...w.stubbed].filter((n) => /noShowsSeatedAbsent|presentNeededToStart|noteLeagueNoShowsSeatedAbsent|qualifierLeagueNoShowsSeated/.test(n))).toEqual([]);
    });

    it('NOBODY here: it waits (nobody released) and is cancelled after 7:00 PM, as before; one registrant alone never starts', async () => {
      const w = world();
      const at = Date.now() + H;
      w.sync([leagueItem(at)]);
      const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
      const b = w.mkSocket('SB', BOB, 'm-bob', 'Bob');
      await enter(a);
      await enter(b);
      offline(w, 'SA');
      offline(w, 'SB');
      w.m.tickQualifierAutoStart(at + 1000);
      w.m.tickQualifierAutoStart(at + 59 * MIN);
      expect(w.qualifierTournaments.get(LEAGUE).status).toBe('registering');
      expect(w.started).toEqual([]);
      expect(actions(w)).not.toContain('QUALIFIER_NO_SHOW_RELEASED');
      expect(actions(w)).not.toContain('QUALIFIER_NO_SHOW_SEATED_ABSENT');
      w.m.tickQualifierAutoStart(at + 61 * MIN);
      await flush();
      expect(w.qualifierTournaments.get(LEAGUE)).toMatchObject({ status: 'finished', cancelled: true });
      // One registrant, here: never a one-player start (2 registered, as always).
      const w2 = world();
      w2.sync([leagueItem(at)]);
      await enter(w2.mkSocket('SA', ALICE, 'm-alice', 'Alice'));
      w2.m.tickQualifierAutoStart(at + 1000);
      expect(w2.started).toEqual([]);
      expect(w2.qualifierTournaments.get(LEAGUE).status).toBe('registering');
    });

    it('CONTROL — the WEEKLY in the same states: the away one is released (credit refunded, master row deleted); one here + one away waits', async () => {
      const w = world();
      const at = Date.now() + H;
      w.sync([weeklyItem(at)]);
      const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
      const b = w.mkSocket('SB', BOB, 'm-bob', 'Bob');
      const c = w.mkSocket('SC', 103, 'm-carl', 'Carl');
      await enter(a, WEEKLY);
      await enter(b, WEEKLY);
      await enter(c, WEEKLY);
      offline(w, 'SC');
      w.m.tickQualifierAutoStart(at + 1000);
      await flush();
      expect(w.started).toHaveLength(1);
      expect(w.started[0].players.map((p: any) => p.masterId).sort()).toEqual(['m-alice', 'm-bob']);
      expect(w.audits.filter((x) => x.action === 'QUALIFIER_NO_SHOW_RELEASED').map((x) => x.d.masterId)).toEqual(['m-carl']);
      expect(actions(w)).not.toContain('QUALIFIER_NO_SHOW_SEATED_ABSENT');
      expect(w.creditRefunds).toHaveLength(1);
      expect(w.fetches.filter((f) => f.method === 'DELETE')).toHaveLength(1);
      // One here + one away: the weekly waits (2 here needed), nobody released.
      const w2 = world();
      w2.sync([weeklyItem(at)]);
      await enter(w2.mkSocket('SA', ALICE, 'm-alice', 'Alice'), WEEKLY);
      await enter(w2.mkSocket('SB', BOB, 'm-bob', 'Bob'), WEEKLY);
      offline(w2, 'SB');
      w2.m.tickQualifierAutoStart(at + 1000);
      expect(w2.started).toEqual([]);
      expect(w2.qualifierTournaments.get(WEEKLY).status).toBe('registering');
      expect(w2.audits.map((x) => x.action)).not.toContain('QUALIFIER_NO_SHOW_RELEASED');
    });
  });

  it('an overflow table of a league night is an "Online League Table"', async () => {
    const { w, tid } = runningLeague(10 * MIN, { usable: 2, overflowMax: 3 });
    const a = w.mkSocket('SA', ALICE, 'm-alice', 'Alice');
    await enter(a);
    expect(w.last('SA')).toEqual(expect.objectContaining({ success: true, lateEntry: true, tableId: 'OV1', overflowTable: true }));
    expect(w.overflowCreates.map((c) => c.name)).toEqual(['Online League Table 2']);
    expect(w.tm.getTournament(tid)!.tableIds).toEqual(['Q1', 'OV1']);
    expect(w.consumed).toEqual([]);
  });

  it('no seat bubble: qualifierLateEntryBubbleOf is null for a league night (no late close at a bubble, no hand-for-hand)', () => {
    const { w, tid } = runningLeague(10 * MIN);
    expect(w.m.qualifierLateEntryBubbleOf(tid)).toBeNull();
  });

  function finishedLeague() {
    const { w, qt, tid } = runningLeague(50 * MIN);
    qt.players = ['a', 'b', 'c'].map((x, i) => ({ playerId: `user-${300 + i}`, masterPlayerId: `m-${x}`, playerName: x.toUpperCase(), phone: '', socketId: `S${x}` }));
    const data = {
      tournamentId: tid,
      results: [
        { playerId: 'user-300', playerName: 'A', position: 1, payout: 0 }, { playerId: 'user-301', playerName: 'B', position: 2, payout: 0 },
        { playerId: 'user-302', playerName: 'C', position: 3, payout: 0, disqualified: true },
      ],
    };
    return { w, qt, tid, data };
  }

  it('FINISHED: qualifierResults + each room socket\'s tournamentFinished carry kind:\'league\', the league fields and the field size; no seats', () => {
    const { w, qt, tid, data } = finishedLeague();
    const sa = w.mkSocket('Sa', 300, 'm-a', 'A'); sa.join('table:Q1');
    const sb = w.mkSocket('Sb', 301, 'm-b', 'B');
    const spec = w.mkSocket('Sx', null, null); spec.join('table:Q1');
    w.m.markQualifierFinished(tid, data);
    expect(qt.status).toBe('finished');
    const LEAGUE_FIELDS = { kind: 'league', leagueId: LEAGUE_ID, leaguePoints: true, leaguePrize: 'chair_month', leagueAwardsMinField: 1, field: 2 };
    expect(w.of('Sa', 'qualifierResults')).toEqual([expect.objectContaining({
      qualifierId: LEAGUE, myResult: { place: 1, wonSeat: false, seats: 0 }, place: 1, wonSeat: false, seatsForTop: 0, ...LEAGUE_FIELDS,
    })]);
    expect(w.of('Sb', 'qualifierResults')).toEqual([expect.objectContaining({ place: 2, ...LEAGUE_FIELDS })]);
    w.m.emitTournamentFinishedToEntrants(tid, ['Q1'], data);
    expect(w.of('Sa', 'tournamentFinished')).toEqual([expect.objectContaining({ isQualifier: true, qualifierId: LEAGUE, seatsForTop: 0, myResult: { place: 1, wonSeat: false, seats: 0 }, ...LEAGUE_FIELDS })]);
    expect(w.of('Sx', 'tournamentFinished')).toEqual([expect.objectContaining({ myResult: null, ...LEAGUE_FIELDS })]);
    expect(w.m.onlineLeagueStats.finished).toBe(1);
    expect([...w.stubbed].filter((n) => /leagueFinishFrameFields|qualifierEventConfig|onlineLeagueStats/.test(n))).toEqual([]);
  });

  it('CONTROL — a weekly\'s finish frames carry no kind / league fields', () => {
    const w = world();
    w.sync([weeklyItem(Date.now() + H)]);
    const qt = w.qualifierTournaments.get(WEEKLY);
    Object.assign(qt, { status: 'running', tournamentId: 'TW', players: [{ playerId: 'user-300', masterPlayerId: 'm-a', playerName: 'A', phone: '', socketId: 'Sa' }] });
    const sa = w.mkSocket('Sa', 300, 'm-a', 'A'); sa.join('table:W1');
    const data = { tournamentId: 'TW', results: [{ playerId: 'user-300', playerName: 'A', position: 1, payout: 0 }] };
    w.m.markQualifierFinished('TW', data);
    w.m.emitTournamentFinishedToEntrants('TW', ['W1'], data);
    for (const f of [...w.of('Sa', 'qualifierResults'), ...w.of('Sa', 'tournamentFinished')]) {
      for (const k of ['kind', 'leagueId', 'leaguePoints', 'leaguePrize', 'leagueAwardsMinField', 'field']) expect({ k, has: k in f }).toEqual({ k, has: false });
    }
  });

  it('the results POST to the master is UNCHANGED: {results:[{playerId, finishPosition, pointsAwarded:0}]}, a disqualified player left out', async () => {
    const { w, tid, data } = finishedLeague();
    w.m.postQualifierResults(tid, data);
    await flush();
    const posts = w.fetches.filter((f) => f.url.endsWith('/results/internal'));
    expect(posts).toEqual([{
      url: `https://master.test/qualifiers/${LEAGUE}/results/internal`, method: 'POST',
      body: { results: [{ playerId: 'm-a', finishPosition: 1, pointsAwarded: 0 }, { playerId: 'm-b', finishPosition: 2, pointsAwarded: 0 }] },
    }]);
  });
});

describe('wiring of the other league frames (source)', () => {
  it('no-show notices, the deal\'s no_seat release and the shutdown flush add kind:\'league\' for a league event only', () => {
    expect(fnSrc('function releaseQualifierNoShows(')).toContain("...(qt.kind === 'league' ? { kind: 'league' as const } : {})");
    expect(fnSrc('function tellQualifierNoShowReleases(')).toContain("...(n.kind === 'league' ? { kind: 'league' } : {})");
    expect(fnSrc('function seatPresentPendingAtDeal(')).toContain("s.emit('qualifierCancelled', { qualifierId: qualId, reason: 'no_seat', creditRefunded, ...(qt.kind === 'league' ? { kind: 'league' } : {}) });");
    expect(SRC).toContain("s.emit('qualifierCancelled', { qualifierId: qualId, reason: 'server_restart', creditRefunded, ...(qt.kind === 'league' ? { kind: 'league' } : {}) });");
  });

  it('every window read passes the event type; both starts pass it to startQualifierTournament', () => {
    // Every qualifierWindows( call in index.ts has a 2nd (type) argument at the top level of its parentheses.
    const calls: string[] = [];
    for (let at = SRC.indexOf('qualifierWindows('); at >= 0; at = SRC.indexOf('qualifierWindows(', at + 1)) {
      if (SRC.slice(Math.max(0, at - 40), at).includes('import {') || /[A-Za-z_]$/.test(SRC.slice(at - 1, at))) continue;
      let depth = 0;
      let topComma = false;
      let i = at + 'qualifierWindows'.length;
      for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
        else if (c === ',' && depth === 1) topComma = true;
      }
      const call = SRC.slice(at, i + 1);
      if (call.startsWith('qualifierWindows(scheduledAt: number')) continue;   // (not in index.ts; defensive)
      calls.push(call);
      expect({ call, typed: topComma }).toEqual({ call, typed: true });
    }
    expect(calls.length).toBeGreaterThanOrEqual(9);
    expect(fnSrc('function tickQualifierAutoStart(')).toContain('startQualifierTournament(humanPlayers, qt.startingStack || 50000, turbo, { eventType: qt.qualifierType });');
    expect(fnSrc('function openQualifierTablesEarly(')).toContain('startQualifierTournament(humanPlayers, qt.startingStack || 50000, false, { tableCount, hold: true, eventType: qt.qualifierType });');
  });

  it('the health endpoint reports r2Play.qualifiers.onlineLeague (the REAL route): the counters + listed league nights', async () => {
    expect(SRC).toContain("onlineLeague: healthSection('r2Play.qualifiers.onlineLeague'");
    let handler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
    const stats = { eventsOpened: 2, listRequests: 5, entries: 7, reEntries: 1, reEntryRefused: 1, cancelled: 0, finished: 1 };
    const { stubbed } = load(`${slice('const healthSectionStats = { errors: 0 };', '\n}\n')}\n${slice("app.get('/api/health', async (_req, res) => {", '\n});\n')}`, {
      app: { get: (p: string, h: any) => { if (p === '/api/health') handler = h; } },
      getPool: () => ({ query: async () => ({ rows: [{ '?column?': 1 }] }) }),
      pingRedis: async () => 'PONG', setTimeout: () => 0,
      tableManager: { getTableList: () => [], getAllTableIds: () => [], getTable: () => undefined },
      qualifierTournaments: new Map<string, any>([
        ['L1', { kind: 'league', status: 'registering' }], ['L0', { kind: 'league', status: 'finished' }], ['W1', { status: 'registering' }],
      ]),
      onlineLeagueStats: stats,
      console: { log() {}, warn() {}, error() {} },
    }, '{}');
    let body: any = null;
    let status = 200;
    await handler!({}, { json: (b: unknown) => { body = b; }, status: (c: number) => ({ json: (b: unknown) => { status = c; body = b; } }) });
    expect(status).toBe(200);
    expect(JSON.parse(JSON.stringify(body)).r2Play.qualifiers.onlineLeague).toEqual({ ...stats, listed: 1 });
    expect([...stubbed].filter((n) => /onlineLeagueStats|qualifierTournaments/.test(n))).toEqual([]);
  });

  it('canonical-features.txt locks the league tokens', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8').split('\n').map((l) => l.trim());
    for (const tok of ['qualifierEventConfig', 'online_league', 'requiresCredit:', 'isBroadcastableQualifier', 'qualifiers/schedule?kinds=league']) {
      expect({ tok, listed: manifest.includes(tok) }).toEqual({ tok, listed: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════ startQualifierTournament (REAL)
describe('startQualifierTournament (REAL source): the league\'s name, tables and 10-minute levels; the weekly unchanged', () => {
  const START_Q = fnSrc('function startQualifierTournament(');
  function start(eventType: string | undefined, env: Record<string, string> = { RAILWAY_ENVIRONMENT: 'production' }) {
    const tm = new TournamentManager();
    const tables = new Map<string, PokerTable>();
    const { exports: m, stubbed } = load(START_Q, {
      tournamentManager: tm, tournamentTables: new Map(), fastModeTables: new Map(),
      qualifierEventConfig, qualifierBlindLevels, qualifierBreakConfig, qualifierTestTimeScale, process: { env },
      playerSessions: new Map(), io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
      tableManager: {
        createQuickTable: (name: string, seats: number, sb: number, bb: number, buyIn: number) => {
          const id = `T${tables.size + 1}`;
          tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn: buyIn, maxBuyIn: buyIn * 10, maxPlayers: seats } as any));
          return id;
        },
        getTable: (id: string) => tables.get(id),
      },
      bindRegistrantSocket: () => '', bootstrapTournamentTables() {}, randomInt: () => 0, markQualifierEngineTournament() {},
      console: { log() {}, warn() {}, error() {} },
    }, '{ startQualifierTournament }');
    const players = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, name: `P${i}`, socketId: `S${i}`, masterId: `m${i}` }));
    const r = m.startQualifierTournament(players, 50_000, false, eventType === undefined ? undefined : { eventType });
    return { t: tm.getTournament(r.tournamentId)!, tables, r, stubbed };
  }

  it('league: "Online League", "Online League Table 1/2", every level 600 s, breaks every 5 levels for 300 s, buy-in 0, the 50,000 stack', () => {
    const { t, tables, stubbed } = start('online_league');
    expect(t.config).toMatchObject({ name: 'Online League', buyIn: 0, startingChips: 50_000, breaks: { everyLevels: 5, seconds: 300 } });
    expect(t.config.blindLevels.every((l) => l.duration === 600)).toBe(true);
    expect([...tables.values()].map((x) => x.config.tableName)).toEqual(['Online League Table 1', 'Online League Table 2']);
    expect([...stubbed].filter((n) => /qualifierEventConfig|qualifierBlindLevels/.test(n))).toEqual([]);
    // The rig's time scale divides the league's 10 minutes too.
    const rig = start('online_league', { QUALIFIER_TEST_TIME_SCALE: '60', NODE_ENV: 'development' });
    expect(rig.t.config.blindLevels.every((l) => l.duration === 10)).toBe(true);
  });

  it('CONTROL — no eventType, or a weekly: "Qualifier Tournament", "Qualifier Table N", 720 s levels (today)', () => {
    for (const e of [undefined, 'weekly', 'monthly']) {
      const { t, tables } = start(e);
      expect(t.config.name).toBe('Qualifier Tournament');
      expect(t.config.blindLevels.every((l) => l.duration === 720)).toBe(true);
      expect([...tables.values()].map((x) => x.config.tableName)).toEqual(['Qualifier Table 1', 'Qualifier Table 2']);
    }
  });
});

// ═══════════════════════════════════════════════════════════════ broadcast
describe('broadcast: a league night is never broadcastable (never the weekly / main channel)', () => {
  function bworld(entries: Array<[string, any]>): EventWorld {
    const q = new Map<string, any>(entries);
    return { now: () => Date.now(), qualifiers: () => q.entries(), tournament: () => undefined, isQualifierEngineTournament: () => false };
  }
  const reg = (type: string, status: string, at: number, extra: Record<string, unknown> = {}) => ({
    qualifierType: type, qualifierName: type, scheduledAt: new Date(at).toISOString(), startingStack: 50_000, players: [], status,
    tournamentId: null, finishedAt: null, ...extra,
  });

  it('isBroadcastableQualifier: false only for online_league', () => {
    expect(isBroadcastableQualifier({ qualifierType: 'online_league' } as any)).toBe(false);
    for (const t of ['weekly', 'monthly', 'toc', 'console_weekly']) expect(isBroadcastableQualifier({ qualifierType: t } as any)).toBe(true);
    expect(isBroadcastableQualifier(null as any)).toBe(true);
  });

  it('next:weekly / next:any skip a RUNNING league night for the upcoming Sunday weekly; q: / t: league keys → not_broadcastable', () => {
    const now = Date.now();
    const world = bworld([
      ['L1', reg('online_league', 'running', now - 10 * MIN, { tournamentId: 'TL1', masterQualifierId: 'L1' })],
      ['W1', reg('weekly', 'registering', now + 2 * 24 * H)],
    ]);
    expect(resolveNext(world, ['weekly'])?.qualifierId).toBe('W1');
    expect(resolveEventKey(world, 'next:weekly')).toMatchObject({ ok: true, ev: { qualifierId: 'W1', kind: 'weekly' } });
    expect(resolveEventKey(world, 'next:any')).toMatchObject({ ok: true, ev: { qualifierId: 'W1' } });
    expect(resolveEventKey(world, 'q:L1')).toEqual({ ok: false, code: 'not_broadcastable' });
    expect(resolveEventKey(world, 't:TL1')).toEqual({ ok: false, code: 'not_broadcastable' });
    expect(resolveEventKey(world, 'q:W1')).toMatchObject({ ok: true });
  });

  it('only league nights listed: next:weekly / next:any find nothing (the channels stay unbound)', () => {
    const now = Date.now();
    const world = bworld([['L1', reg('online_league', 'registering', now + H)], ['L2', reg('online_league', 'finished', now - H, { finishedAt: now - 5 * MIN })]]);
    expect(resolveNext(world, ['weekly', 'monthly'])).toBeNull();
    expect(resolveEventKey(world, 'next:weekly')).toEqual({ ok: false, code: 'event_not_found' });
    expect(resolveEventKey(world, 'next:any')).toEqual({ ok: false, code: 'event_not_found' });
  });

  it('GET /api/broadcast/events (eventsList) never lists a league night', async () => {
    const w = qualifierWorld();
    w.qualifiers.set('L1', reg('online_league', 'registering', Date.now() + H, { masterQualifierId: 'L1' }));
    const r = await broadcastRig({ world: w });
    try {
      expect(r.handle.eventsList().map((e) => e.eventKey)).toEqual([`q:${w.qualId}`]);
    } finally { await r.close(); }
  });
});

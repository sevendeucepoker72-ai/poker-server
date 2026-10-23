/**
 * 2026-10-23 (qualifier lifecycle S3, owner 2026-10-22: "run the blinds and
 * raise them, take breaks, and anything else a tournament would need") — the
 * blind clock the players can see, scheduled breaks (5 minutes after every 5th
 * level), a director pause that resumes the time that was LEFT, and the
 * internal pause / breaks routes.
 *
 * Before: a qualifier ran its 26 levels back to back (no break existed — the
 * '+ Break' rows saved in the .online Admin were never read by the engine), a
 * director's Resume restarted the level at its FULL length, and no state of a
 * tournament table carried the level clock (the client's level widget never
 * showed). Every test here fails on that code.
 *
 * Runs the REAL TournamentManager / PokerTable and the REAL src/index.ts
 * source (sliced + transpiled), under jest fake timers (Date.now() follows them).
 */
import { createHash, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { cardToString } from '../src/game/Card';
import {
  qualifierBlindLevels, qualifierBreakConfig, qualifierStructure, qualifierTestTimeScale, seatsForTopWith,
  QUALIFIER_BREAK_EVERY_LEVELS, QUALIFIER_BREAK_MINUTES, QUALIFIER_BASE_STACK,
  qualifierWindows, qualifierStatusOf, qualifierReEntriesLeft, QUALIFIER_MAX_REENTRIES,
} from '../src/game/qualifierSchedule';
import { SRC, slice, fnSrc, handlerSrc, load } from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };
const LEVEL_MS = 12 * 60 * 1000;          // the qualifier's 12-minute level
const BREAK_MS = 5 * 60 * 1000;           // the 5-minute break
const STACK = 50_000;
const LEVELS = qualifierBlindLevels(STACK);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-10-25T17:00:00.000Z'));
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

/** A running qualifier-shaped tournament on the REAL TournamentManager (no tables). */
function tmWorld(opts: { breaks?: boolean; levels?: typeof LEVELS; entrants?: number } = {}) {
  const tm = new TournamentManager();
  const events: Array<[string, any]> = [];
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: opts.levels ?? LEVELS, startingChips: STACK,
    ...(opts.breaks === false ? {} : { breaks: qualifierBreakConfig() }),
  } as any);
  const n = opts.entrants ?? 4;
  for (let i = 0; i < n; i++) tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, undefined, `m-${i}`);
  tm.onEvent(tid, (ev, d) => { events.push([ev, d]); });
  expect(tm.startTournament(tid)).toBeTruthy();
  const t = tm.getTournament(tid)!;
  const evs = (name: string) => events.filter(([e]) => e === name).map(([, d]) => d);
  return { tm, tid, t, events, evs };
}

// ═══════════════════════════════════════ the level clock ══
describe('the level clock (TournamentManager)', () => {
  it('levelEndsAt is set at the start and moves on at each level; blindLevelUp carries it (additive)', () => {
    const w = tmWorld();
    const t0 = Date.now();
    expect(w.t.levelEndsAt).toBe(t0 + LEVEL_MS);
    jest.advanceTimersByTime(LEVEL_MS);
    expect(w.t.currentBlindLevel).toBe(1);
    expect(w.t.levelEndsAt).toBe(t0 + 2 * LEVEL_MS);
    const up = w.evs('blindLevelUp');
    expect(up).toEqual([{ level: 2, sb: LEVELS[1].sb, bb: LEVELS[1].bb, ante: LEVELS[1].ante, levelEndsAt: t0 + 2 * LEVEL_MS }]);
    jest.advanceTimersByTime(LEVEL_MS);
    expect(w.t.currentBlindLevel).toBe(2);
    expect(w.t.levelEndsAt).toBe(t0 + 3 * LEVEL_MS);
    // getLevelClock: live remaining time, the next level's blinds.
    jest.advanceTimersByTime(60_000);
    const c = w.tm.getLevelClock(w.tid)!;
    expect(c).toEqual({
      level: 3, levels: LEVELS.length, durationSec: 720, levelEndsAt: t0 + 3 * LEVEL_MS, remainingMs: LEVEL_MS - 60_000,
      paused: false, pauseReason: null, breakUntil: null, sb: LEVELS[2].sb, bb: LEVELS[2].bb, ante: LEVELS[2].ante,
      next: { sb: LEVELS[3].sb, bb: LEVELS[3].bb, ante: LEVELS[3].ante }, entries: 4, alive: 4,
    });
  });

  it('a director pause with 3:00 left resumes with 3:00 left (it used to restart the level at 12:00)', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(9 * 60_000);                 // 3:00 left in level 1
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);
    expect(w.t.paused).toBe(true);
    expect(w.t.pauseReason).toBe('director');
    expect(w.t.levelRemainingMs).toBe(3 * 60_000);
    expect(w.tm.getLevelClock(w.tid)).toMatchObject({ paused: true, pauseReason: 'director', remainingMs: 180_000, levelEndsAt: null });
    jest.advanceTimersByTime(30 * 60_000);                // a long pause: the clock stays stopped
    expect(w.t.currentBlindLevel).toBe(0);
    expect(w.tm.pauseTournament(w.tid, false)).toBe(true);
    expect(w.t.levelEndsAt).toBe(Date.now() + 3 * 60_000);
    jest.advanceTimersByTime(3 * 60_000 - 1000);
    expect(w.t.currentBlindLevel).toBe(0);
    jest.advanceTimersByTime(1000);
    expect(w.t.currentBlindLevel).toBe(1);                // old: still level 1 until 12:00 after the resume
  });

  it('a pause in the last second keeps at least 1 s; an idempotent pause / resume changes nothing', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(LEVEL_MS - 200);
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);
    expect(w.t.levelRemainingMs).toBe(1000);
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);   // already paused
    expect(w.t.levelRemainingMs).toBe(1000);
    expect(w.tm.pauseTournament(w.tid, false)).toBe(true);
    expect(w.tm.pauseTournament(w.tid, false)).toBe(true);  // already running: no second timer
    jest.advanceTimersByTime(1000);
    expect(w.t.currentBlindLevel).toBe(1);
    jest.advanceTimersByTime(LEVEL_MS - 1);
    expect(w.t.currentBlindLevel).toBe(1);
  });

  it('entries: the field at the start, +1 per late entry and re-entry, -1 for an undone late entry', () => {
    const w = tmWorld({ entrants: 4 });
    expect(w.t.entries).toBe(4);
    expect(w.tm.addLateEntrant(w.tid, 'late1', 'L1', 'sl1', STACK, { masterUserId: 'm-l1' })).toBeTruthy();
    expect(w.tm.addLateEntrant(w.tid, 'late2', 'L2', 'sl2', STACK, { masterUserId: 'm-l2' })).toBeTruthy();
    expect(w.t.entries).toBe(6);
    expect(w.tm.removeLateEntrant(w.tid, 'late2')).toBe(true);
    expect(w.t.entries).toBe(5);
    expect(w.tm.eliminatePlayer(w.tid, 'p0')).toBeTruthy();
    expect(w.tm.reinstateForReentry(w.tid, 'p0', STACK)).toBe(true);
    expect(w.t.entries).toBe(6);
    expect(w.tm.getLevelClock(w.tid)).toMatchObject({ entries: 6, alive: 5 });   // 4 + late1 alive; p0 back
  });
});

// ═══════════════════════════════════════ breaks (TournamentManager) ══
describe('scheduled breaks (TournamentManager)', () => {
  it('the end of L5 starts a 5-minute break (paused, reason break, breakUntil); its end gives L6 with its FULL time', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(4 * LEVEL_MS);
    expect(w.t.currentBlindLevel).toBe(4);                // level 5 in play
    expect(w.t.paused).toBe(false);
    jest.advanceTimersByTime(LEVEL_MS);                   // the end of level 5
    const at = Date.now();
    expect(w.t.currentBlindLevel).toBe(4);                // still level 5: the break comes first
    expect(w.t.paused).toBe(true);
    expect(w.t.pauseReason).toBe('break');
    expect(w.t.breakUntil).toBe(at + BREAK_MS);
    expect(w.t.levelEndsAt).toBeNull();
    expect(w.t.advanceOnResume).toBe(true);
    expect(w.evs('tournamentBreak')).toEqual([{ tournamentId: w.tid, afterLevel: 5, resumesAt: at + BREAK_MS }]);
    expect(w.tm.getLevelClock(w.tid)).toMatchObject({ level: 5, paused: true, pauseReason: 'break', breakUntil: at + BREAK_MS, remainingMs: null });
    expect(w.tm.breakStats.taken).toBe(1);
    jest.advanceTimersByTime(BREAK_MS - 1);
    expect(w.t.paused).toBe(true);
    jest.advanceTimersByTime(1);
    expect(w.t.paused).toBe(false);
    expect(w.t.pauseReason).toBeNull();
    expect(w.t.breakUntil).toBeNull();
    expect(w.t.currentBlindLevel).toBe(5);                // level 6
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
    expect(w.evs('blindLevelUp').pop()).toMatchObject({ level: 6, sb: LEVELS[5].sb, bb: LEVELS[5].bb });
    expect(w.evs('tournamentBreakEnded')).toEqual([{ tournamentId: w.tid, level: 6 }]);
    // The event order: the break, then L6's blind-up, then the break end.
    const names = w.events.map(([e]) => e);
    expect(names.slice(-3)).toEqual(['tournamentBreak', 'blindLevelUp', 'tournamentBreakEnded']);
  });

  it('breaks after levels 5, 10, 15, 20 and 25 — never after the last level (26)', () => {
    const w = tmWorld();
    for (let lvl = 1; lvl <= LEVELS.length; lvl++) {
      jest.advanceTimersByTime(LEVEL_MS);
      if (lvl % 5 === 0 && lvl < LEVELS.length) jest.advanceTimersByTime(BREAK_MS);
    }
    expect(w.evs('tournamentBreak').map((b) => b.afterLevel)).toEqual([5, 10, 15, 20, 25]);
    expect(w.t.currentBlindLevel).toBe(LEVELS.length - 1);
    expect(w.t.paused).toBe(false);
    jest.advanceTimersByTime(10 * LEVEL_MS);
    expect(w.evs('tournamentBreak')).toHaveLength(5);
  });

  it('no break after the last level even when it is a multiple of everyLevels (5 levels, every 5)', () => {
    const w = tmWorld({ levels: LEVELS.slice(0, 5) });
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.paused).toBe(false);
    expect(w.evs('tournamentBreak')).toEqual([]);
    expect(w.t.currentBlindLevel).toBe(4);
  });

  it('a tournament without a break schedule (every non-qualifier) never breaks', () => {
    const w = tmWorld({ breaks: false });
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.paused).toBe(false);
    expect(w.t.currentBlindLevel).toBe(5);
    expect(w.evs('tournamentBreak')).toEqual([]);
  });

  it('the switch off (breaksEnabled false, read at the level boundary): no break', () => {
    const w = tmWorld();
    w.tm.breaksEnabled = false;
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.paused).toBe(false);
    expect(w.t.currentBlindLevel).toBe(5);
    expect(w.evs('tournamentBreak')).toEqual([]);
  });

  it('turning the switch off does NOT end a break already running', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.pauseReason).toBe('break');
    w.tm.breaksEnabled = false;
    jest.advanceTimersByTime(BREAK_MS - 1000);
    expect(w.t.pauseReason).toBe('break');
    jest.advanceTimersByTime(1000);
    expect(w.t.paused).toBe(false);
    expect(w.t.currentBlindLevel).toBe(5);
  });

  it('a director pause DURING a break replaces it (its timer stops); his resume gives L6 with its full time', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS + 60_000);      // one minute into the break
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);
    expect(w.t.pauseReason).toBe('director');
    expect(w.t.breakUntil).toBeNull();
    expect(w.t.advanceOnResume).toBe(true);
    expect(w.tm.breakStats.endedEarly).toBe(1);
    jest.advanceTimersByTime(30 * 60_000);                // the break's own end passes: nothing happens
    expect(w.t.paused).toBe(true);
    expect(w.t.currentBlindLevel).toBe(4);
    expect(w.evs('tournamentBreakEnded')).toEqual([]);
    expect(w.tm.pauseTournament(w.tid, false)).toBe(true);
    expect(w.t.paused).toBe(false);
    expect(w.t.currentBlindLevel).toBe(5);                // L6
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
    jest.advanceTimersByTime(LEVEL_MS - 1);
    expect(w.t.currentBlindLevel).toBe(5);
  });

  it('a director RESUME during a break ends it at once: L6, full time (POST /api/qualifiers/pause {paused:false})', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS + 60_000);
    expect(w.tm.pauseTournament(w.tid, false)).toBe(true);
    expect(w.t.paused).toBe(false);
    expect(w.t.currentBlindLevel).toBe(5);
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
    expect(w.tm.breakStats.endedEarly).toBe(1);
    jest.advanceTimersByTime(BREAK_MS);                   // the old break timer is gone
    expect(w.t.currentBlindLevel).toBe(5);
    expect(w.evs('tournamentBreakEnded')).toEqual([]);
  });

  it("a 'prestart' hold refuses a director resume; only a 'prestart' resume ends it, arming the FULL first level", () => {
    const w = tmWorld();
    jest.advanceTimersByTime(5 * 60_000);
    expect(w.tm.pauseTournament(w.tid, true, 'prestart')).toBe(true);
    expect(w.t.pauseReason).toBe('prestart');
    expect(w.tm.getLevelClock(w.tid)).toMatchObject({ paused: true, pauseReason: 'prestart', remainingMs: LEVEL_MS });
    expect(w.tm.pauseTournament(w.tid, false)).toBe(false);              // director resume refused
    expect(w.tm.pauseTournament(w.tid, false, 'director')).toBe(false);
    expect(w.t.paused).toBe(true);
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);                // a director pause on top: no-op
    expect(w.t.pauseReason).toBe('prestart');
    jest.advanceTimersByTime(60 * 60_000);
    expect(w.t.currentBlindLevel).toBe(0);
    expect(w.tm.pauseTournament(w.tid, false, 'prestart')).toBe(true);
    expect(w.t.paused).toBe(false);
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
  });

  it('a void during a break clears its timer (no break end, no level-up)', () => {
    const w = tmWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.pauseReason).toBe('break');
    w.tm.voidRunningTournament(w.tid);
    expect(w.t.blindTimer).toBeNull();
    jest.advanceTimersByTime(BREAK_MS * 3);
    expect(w.evs('tournamentBreakEnded')).toEqual([]);
    expect(w.t.currentBlindLevel).toBe(4);
  });

  it('a finish during a break clears its timer (the last bust of the hand that was running)', () => {
    const w = tmWorld({ entrants: 2 });
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.pauseReason).toBe('break');
    expect(w.tm.eliminatePlayer(w.tid, 'p1')).toMatchObject({ finished: true });
    expect(w.t.status).toBe('finished');
    expect(w.t.blindTimer).toBeNull();
    jest.advanceTimersByTime(BREAK_MS * 3);
    expect(w.evs('tournamentBreakEnded')).toEqual([]);
    expect(w.evs('blindLevelUp').map((b) => b.level)).toEqual([2, 3, 4, 5]);
  });
});

// ═══════════════════════════════════════ qualifierSchedule ══
describe('qualifierSchedule: break constants, the additive structure, the rig-only time scale', () => {
  it('a 5-minute break after every 5th level; the lobby structure gains `breaks` and keeps its 12-minute levels', () => {
    expect(QUALIFIER_BREAK_EVERY_LEVELS).toBe(5);
    expect(QUALIFIER_BREAK_MINUTES).toBe(5);
    const s = qualifierStructure(QUALIFIER_BASE_STACK);
    expect(s.breaks).toEqual({ everyLevels: 5, minutes: 5 });
    expect(s.levels.every((l) => l.minutes === 12)).toBe(true);
    expect(qualifierBreakConfig()).toEqual({ everyLevels: 5, seconds: 300 });
    expect(qualifierBlindLevels(STACK).every((l) => l.duration === 720)).toBe(true);
  });

  it('the scale divides ONLY the engine level and break lengths (at least 1 s)', () => {
    expect(qualifierBlindLevels(STACK, 60).every((l) => l.duration === 12)).toBe(true);
    expect(qualifierBlindLevels(STACK, 60).map((l) => [l.sb, l.bb, l.ante])).toEqual(qualifierBlindLevels(STACK).map((l) => [l.sb, l.bb, l.ante]));
    expect(qualifierBreakConfig(60)).toEqual({ everyLevels: 5, seconds: 5 });
    expect(qualifierBreakConfig(120)).toEqual({ everyLevels: 5, seconds: 3 });
    for (const bad of [0, -5, NaN, undefined as any, 'x' as any]) {
      expect(qualifierBlindLevels(STACK, bad)[0].duration).toBe(720);
      expect(qualifierBreakConfig(bad).seconds).toBe(300);
    }
  });

  it('qualifierTestTimeScale: 1 when RAILWAY_ENVIRONMENT (or any Railway runtime var) is set, 1 when NODE_ENV=production, 60 only in dev with the env var', () => {
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '60', RAILWAY_ENVIRONMENT: 'production' })).toBe(1);
    for (const k of ['RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID']) {
      expect({ k, scale: qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '60', [k]: 'x' }) }).toEqual({ k, scale: 1 });
    }
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '60', NODE_ENV: 'production' })).toBe(1);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '60', NODE_ENV: 'development' })).toBe(60);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '60' })).toBe(60);
    expect(qualifierTestTimeScale({ NODE_ENV: 'development' })).toBe(1);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '' })).toBe(1);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: 'fast' })).toBe(1);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '500' })).toBe(120);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '0.5' })).toBe(1);
    expect(qualifierTestTimeScale({ QUALIFIER_TEST_TIME_SCALE: '7.9' })).toBe(7);
  });

  it('startQualifierTournament (REAL source) passes the break schedule and the scaled durations; production-shaped env = real time', () => {
    const START_Q = fnSrc('function startQualifierTournament(');
    function start(env: Record<string, string>) {
      const tm = new TournamentManager();
      const tables = new Map<string, PokerTable>();
      const { exports: m } = load(START_Q, {
        tournamentManager: tm, tournamentTables: new Map(), fastModeTables: new Map(),
        qualifierBlindLevels, qualifierBreakConfig, qualifierTestTimeScale, process: { env },
        playerSessions: new Map(), io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
        tableManager: {
          createQuickTable: (name: string, seats: number, sb: number, bb: number, buyIn: number) => {
            const id = `T${tables.size + 1}`;
            tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn: buyIn, maxBuyIn: buyIn * 10, maxPlayers: seats } as any));
            return id;
          },
          getTable: (id: string) => tables.get(id),
        },
        bindRegistrantSocket: () => '', bootstrapTournamentTables() {}, randomInt: () => 0, console: quiet,
      }, '{ startQualifierTournament }');
      const players = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, name: `P${i}`, socketId: `S${i}`, masterId: `m${i}` }));
      const r = m.startQualifierTournament(players, STACK, false);
      return tm.getTournament(r.tournamentId)!;
    }
    const rig = start({ QUALIFIER_TEST_TIME_SCALE: '60', NODE_ENV: 'development' });
    expect(rig.config.breaks).toEqual({ everyLevels: 5, seconds: 5 });
    expect(rig.config.blindLevels.every((l) => l.duration === 12)).toBe(true);
    expect(rig.levelEndsAt).toBe(Date.now() + 12_000);
    const prod = start({ QUALIFIER_TEST_TIME_SCALE: '60', RAILWAY_ENVIRONMENT: 'production' });
    expect(prod.config.breaks).toEqual({ everyLevels: 5, seconds: 300 });
    expect(prod.config.blindLevels.every((l) => l.duration === 720)).toBe(true);
    expect(prod.entries).toBe(12);
  });
});

// ═══════════════════════════════ the tables: the bootstrap listener + the hand boundary ══
// The REAL bootstrap listener (blindLevelUp / tournamentBreak / tournamentBreakEnded)
// and the REAL autoStartNextHand, on real PokerTables. T3 is an OVERFLOW table
// (TournamentManager.addTable, never bootstrapped — the listener reads the live tableIds).
const EVENTS = slice('  tournamentManager.onEvent(tournamentId, (event, data) => {', '\n  });\n', SRC.indexOf('function bootstrapTournamentTables('));
const AUTO_START = fnSrc('function autoStartNextHand(tableId: string): void {');

function foldOut(t: PokerTable): void {
  for (let g = 0; g < 30 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

function tablesWorld() {
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: LEVELS, startingChips: STACK, breaks: qualifierBreakConfig(),
  } as any);
  const layout: Record<string, number> = { T1: 6, T2: 6, T3: 2 };
  let k = 0;
  const seats: Array<[string, string]> = [];
  for (const [id, n] of Object.entries(layout)) for (let i = 0; i < n; i++) { const pid = `p${k++}`; seats.push([id, pid]); tm.registerPlayer(tid, pid, pid.toUpperCase(), `s-${pid}`); }
  expect(tm.startTournament(tid)).toBeTruthy();
  tm.setTableIds(tid, ['T1', 'T2']);
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  for (const id of Object.keys(layout)) {
    tables.set(id, new PokerTable({ tableId: id, tableName: id, smallBlind: LEVELS[0].sb, bigBlind: LEVELS[0].bb, minBuyIn: STACK, maxBuyIn: STACK * 10, maxPlayers: 9 } as any));
    tournamentTables.set(id, tid);
  }
  const perTable = new Map<string, number>();
  for (const [id, pid] of seats) {
    const i = perTable.get(id) ?? 0;
    perTable.set(id, i + 1);
    expect(tables.get(id)!.sitDown(i, pid.toUpperCase(), STACK, pid, false, true)).toBe(true);
    tm.setPlayerTable(tid, pid, id);
  }
  expect(tm.addTable(tid, 'T3')).toBe(true);                // the overflow table (opened in play)
  const roomEmits: Array<[string, string, any]> = [];
  const broadcasts: string[] = [];
  const scheduled: string[] = [];
  const balanced: string[] = [];
  const logs: string[] = [];
  const { exports: m } = load(`function registerEvents(tournamentId) {\n${EVENTS}\n}\n${AUTO_START}`, {
    tournamentManager: tm, tournamentTables, GamePhase, dealersChoiceState: new Map(), quickTables: new Set(),
    tableManager: { getTable: (id: string) => tables.get(id) },
    io: { to: (room: string) => { const op: any = { emit: (ev: string, d: any) => roomEmits.push([room, ev, d]), except: () => op }; return op; } },
    broadcastGameState: (id: string) => { broadcasts.push(id); },
    scheduleAutoStart: (id: string) => { scheduled.push(id); },
    balanceQualifierTablesNow: (id: string) => { balanced.push(id); return 0; },
    broadcastTournamentList() {}, ensureTableProgressListener() {}, scheduleAIAction() {}, activateBombPotIfPending() {},
    userIdForSeat: () => undefined, notifyPlayer: async () => {},
    tournamentDealWaitsForBustCheck: () => false, planTournamentRebalance: () => null,
    tournamentBreaksAwaitingHandEnd: new Map(), brokenTournamentTables: new Map(),
    feedLoneQualifierTable: () => false, balanceQualifierTables: () => false,
    console: { log: (...a: any[]) => logs.push(a.join(' ')), warn: (...a: any[]) => logs.push(a.join(' ')), error: (...a: any[]) => logs.push(`ERR ${a.join(' ')}`) },
  }, '{ registerEvents, autoStartNextHand }');
  m.registerEvents(tid);
  return { tm, tid, t: tm.getTournament(tid)!, tables, roomEmits, broadcasts, scheduled, balanced, logs, m };
}

describe('the break at the tables (REAL bootstrap listener + REAL autoStartNextHand)', () => {
  it("tournamentPaused {reason:'break', resumesAt} reaches EVERY table room (the overflow table included), each table's state is re-sent; qualifier_break_started is logged", () => {
    const w = tablesWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS);
    const resumesAt = new Date(Date.now() + BREAK_MS).toISOString();
    const paused = w.roomEmits.filter(([, ev]) => ev === 'tournamentPaused');
    expect(paused).toEqual(['T1', 'T2', 'T3'].map((id) => [`table:${id}`, 'tournamentPaused', { tournamentId: w.tid, reason: 'break', resumesAt, afterLevel: 5 }]));
    expect(w.broadcasts.slice(-3)).toEqual(['T1', 'T2', 'T3']);
    const line = w.logs.find((l) => l.includes('"event":"qualifier_break_started"'))!;
    expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual({ event: 'qualifier_break_started', tournamentId: w.tid, afterLevel: 5, resumesAt, tables: 3 });
    expect(w.logs.filter((l) => l.startsWith('ERR'))).toEqual([]);
  });

  it('autoStartNextHand HOLDS at the hand end during the break; after the break the table deals again', () => {
    const w = tablesWorld();
    const T1 = w.tables.get('T1')!;
    expect(T1.startNewHand()).toBe(true);
    jest.advanceTimersByTime(5 * LEVEL_MS);              // the break starts while T1's hand runs
    expect(w.t.pauseReason).toBe('break');
    foldOut(T1);
    w.m.autoStartNextHand('T1');
    expect(T1.currentPhase).toBe(GamePhase.HandComplete);   // held — old: a new hand at the L5 blinds
    expect(T1.isHandInProgress()).toBe(false);
    jest.advanceTimersByTime(BREAK_MS);
    w.m.autoStartNextHand('T1');
    expect(T1.isHandInProgress()).toBe(true);
    expect(T1.handBigBlind).toBe(LEVELS[5].bb);               // dealt at L6
  });

  it('the break end: L6 on EVERY table (full time), tables balanced first, tournamentResumed {reason:break} to every room, scheduleAutoStart for each table; qualifier_break_ended logged', () => {
    const w = tablesWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS);
    w.roomEmits.length = 0;
    jest.advanceTimersByTime(BREAK_MS);
    for (const id of ['T1', 'T2', 'T3']) {
      const T = w.tables.get(id)!;
      expect({ id, sb: T.config.smallBlind, bb: T.config.bigBlind, ante: T.config.ante }).toEqual({ id, sb: LEVELS[5].sb, bb: LEVELS[5].bb, ante: LEVELS[5].ante });
    }
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
    expect(w.balanced).toEqual([w.tid]);
    expect(w.scheduled).toEqual(['T1', 'T2', 'T3']);
    const ups = w.roomEmits.filter(([, ev]) => ev === 'blindLevelUp').map(([room, , d]) => [room, d.level, d.levelEndsAt]);
    expect(ups).toEqual(['T1', 'T2', 'T3'].map((id) => [`table:${id}`, 6, Date.now() + LEVEL_MS]));
    const resumed = w.roomEmits.filter(([, ev]) => ev === 'tournamentResumed');
    expect(resumed).toEqual(['T1', 'T2', 'T3'].map((id) => [`table:${id}`, 'tournamentResumed', { tournamentId: w.tid, reason: 'break' }]));
    // Order: the blind-up, then the resume notice.
    const order = w.roomEmits.filter(([room]) => room === 'table:T1').map(([, ev]) => ev);
    expect(order).toEqual(['blindLevelUp', 'tournamentResumed']);
    const line = w.logs.find((l) => l.includes('"event":"qualifier_break_ended"'))!;
    expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual({ event: 'qualifier_break_ended', tournamentId: w.tid, level: 6, tables: 3, balanceMoves: 0 });
  });

  it('a throw in the break notice never escapes the blind timer (it would crash the process and void the event)', () => {
    const w = tablesWorld();
    // A table whose state broadcast throws.
    const orig = w.broadcasts.push.bind(w.broadcasts);
    w.broadcasts.push = ((id: string) => { if (id === 'T2') throw new Error('emit failed'); return orig(id); }) as any;
    expect(() => jest.advanceTimersByTime(5 * LEVEL_MS)).not.toThrow();
    expect(w.t.pauseReason).toBe('break');
    expect(w.roomEmits.filter(([, ev]) => ev === 'tournamentPaused').map(([room]) => room)).toEqual(['table:T1', 'table:T2', 'table:T3']);
    expect(w.logs.some((l) => l.includes('qualifier_break_notice_failed') && l.includes('T2'))).toBe(true);
  });
});

// ═══════════════════════════════ the routes + the director pause ══
const ROUTES = slice('// ===== Director pause + scheduled breaks', '// ===== end director pause + scheduled breaks =====\n');
const TOKEN_FN = fnSrc('function internalTokenMatches(');

function routesWorld(opts: { token?: string; routes?: string; balanceThrows?: boolean } = {}) {
  const w = tmWorld();
  const routes = new Map<string, (req: any, res: any) => void>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const scheduled: string[] = [];
  const broadcasts: string[] = [];
  // Review fix-up — the pre-deal balance at a director Resume (S2's REAL pass is
  // covered by its own tests; here: called, when, and before the re-kick).
  const balanced: string[] = [];
  const seq: string[] = [];
  const qualifierTournaments = new Map<string, any>();
  w.tm.setTableIds(w.tid, ['T1', 'T2']);
  const logs: string[] = [];
  const { exports: m } = load(`${TOKEN_FN}\n${opts.routes ?? ROUTES}\nfunction wire(socket) {\n${handlerSrc('pauseTournament', '\n  });\n')}\n}`, {
    app: { post: (p: string, fn: any) => { routes.set(p, fn); } },
    createHash, timingSafeEqual,
    process: { env: { INTERNAL_NOTIFY_TOKEN: opts.token ?? 'tok' } },
    tournamentManager: w.tm, qualifierTournaments,
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    io: { to: (room: string) => ({ emit: (ev: string, d: any) => roomEmits.push([room, ev, d]) }) },
    balanceQualifierTablesNow: (id: string) => {
      balanced.push(id);
      seq.push(`balance:${id}:paused=${w.tm.getTournament(id)?.paused}`);
      if (opts.balanceThrows) throw new Error('balance failed');
      return 0;
    },
    scheduleAutoStart: (id: string) => { scheduled.push(id); seq.push(`kick:${id}`); },
    broadcastGameState: (id: string) => { broadcasts.push(id); },
    broadcastTournamentList() {},
    authSessions: new Map([['ADMIN', { userId: 1, username: 'admin' }]]), isUserAdmin: async () => true,
    console: { log: (...a: any[]) => logs.push(a.join(' ')), warn() {}, error() {} },
  }, '{ applyDirectorPause, setQualifierBreaks, wire }');
  const call = (p: string, body: any, token?: string) => {
    let status = 200;
    let json: any;
    const res = { status: (s: number) => { status = s; return res; }, json: (j: any) => { json = j; return res; } };
    routes.get(p)!({ headers: token === undefined ? {} : { 'x-internal-token': token }, body }, res);
    return { status, body: json };
  };
  return { ...w, routes, audits, roomEmits, scheduled, broadcasts, balanced, seq, qualifierTournaments, call, m, logs };
}

describe('POST /api/qualifiers/breaks (the break switch, no restart)', () => {
  it('403 without / with a wrong token and whenever no token is configured (fails closed); 400 on a bad value (nothing changes); 200 {success, previous, on}; audited QUALIFIER_BREAKS_SET', () => {
    const w = routesWorld();
    expect(w.call('/api/qualifiers/breaks', { on: 0 }).status).toBe(403);
    expect(w.call('/api/qualifiers/breaks', { on: 0 }, 'nope').status).toBe(403);
    for (const bad of ['0', 'off', 2, null, undefined]) {
      const r = w.call('/api/qualifiers/breaks', { on: bad }, 'tok');
      expect({ bad, status: r.status }).toEqual({ bad, status: 400 });
    }
    expect(w.tm.breaksEnabled).toBe(true);
    expect(w.call('/api/qualifiers/breaks', { on: 0 }, 'tok')).toEqual({ status: 200, body: { success: true, previous: true, on: false } });
    expect(w.tm.breaksEnabled).toBe(false);
    expect(w.audits).toEqual([{ actor: 'internal:breaks', action: 'QUALIFIER_BREAKS_SET', d: { previous: true, on: false } }]);
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.paused).toBe(false);                       // OFF: L6 with no break
    expect(w.t.currentBlindLevel).toBe(5);
    expect(w.call('/api/qualifiers/breaks', { on: true }, 'tok').body).toEqual({ success: true, previous: false, on: true });
    const noTok = routesWorld({ token: '' });
    expect(noTok.call('/api/qualifiers/breaks', { on: 0 }, '').status).toBe(403);
    expect(noTok.call('/api/qualifiers/breaks', { on: 0 }, 'tok').status).toBe(403);
  });
});

describe('POST /api/qualifiers/pause + the admin socket pause (applyDirectorPause)', () => {
  function withRunningQualifier(w: ReturnType<typeof routesWorld>, id = 'Q1', tournamentId = w.tid) {
    w.qualifierTournaments.set(id, { qualifierId: id, status: 'running', tournamentId, qualifierType: 'weekly' });
  }

  it('403 / 400 / 404 (none running) / 409 (several); 200 pauses then resumes the ONE running qualifier, every room told {reason:director}, audited TOURNAMENT_PAUSE', () => {
    const w = routesWorld();
    expect(w.call('/api/qualifiers/pause', { paused: 1 }).status).toBe(403);
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'bad').status).toBe(403);
    expect(w.call('/api/qualifiers/pause', { paused: 'yes' }, 'tok').status).toBe(400);
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'tok')).toEqual({ status: 404, body: { success: false, error: 'no_running_qualifier' } });
    withRunningQualifier(w);
    jest.advanceTimersByTime(9 * 60_000);
    const r = w.call('/api/qualifiers/pause', { paused: 1 }, 'tok');
    expect(r).toEqual({ status: 200, body: { success: true, qualifierId: 'Q1', tournamentId: w.tid, paused: true, pauseReason: 'director' } });
    expect(w.roomEmits).toEqual(['T1', 'T2'].map((id) => [`table:${id}`, 'tournamentPaused', { tournamentId: w.tid, reason: 'director' }]));
    expect(w.broadcasts).toEqual(['T1', 'T2']);
    expect(w.scheduled).toEqual([]);
    jest.advanceTimersByTime(20 * 60_000);
    expect(w.call('/api/qualifiers/pause', { paused: false, qualifierId: 'Q1' }, 'tok').body).toMatchObject({ success: true, paused: false, pauseReason: null });
    expect(w.scheduled).toEqual(['T1', 'T2']);
    expect(w.t.levelEndsAt).toBe(Date.now() + 3 * 60_000);   // the 3:00 that was left
    expect(w.audits).toEqual([
      { actor: 'internal:pause', action: 'TOURNAMENT_PAUSE', d: { tournamentId: w.tid, paused: true } },
      { actor: 'internal:pause', action: 'TOURNAMENT_PAUSE', d: { tournamentId: w.tid, paused: false } },
    ]);
    expect(w.call('/api/qualifiers/pause', { paused: 1, qualifierId: 'nope' }, 'tok')).toEqual({ status: 404, body: { success: false, error: 'qualifier_not_running' } });
    withRunningQualifier(w, 'Q2', 'other-tournament');
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'tok')).toEqual({ status: 409, body: { success: false, error: 'several_running', qualifierIds: ['Q1', 'Q2'] } });
  });

  it('{paused:false} during a break ends it early: L6 at once, full time, the tables re-kicked', () => {
    const w = routesWorld();
    withRunningQualifier(w);
    jest.advanceTimersByTime(5 * LEVEL_MS + 30_000);
    expect(w.t.pauseReason).toBe('break');
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok').body).toMatchObject({ success: true, paused: false });
    expect(w.t.currentBlindLevel).toBe(5);
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
    expect(w.scheduled).toEqual(['T1', 'T2']);
    expect(w.tm.breakStats).toEqual({ taken: 1, endedEarly: 1 });
  });

  it("a resume of the 'prestart' hold is refused: 409 not_started, and the admin socket hears 'This tournament has not started yet.'", async () => {
    const w = routesWorld();
    withRunningQualifier(w);
    expect(w.tm.pauseTournament(w.tid, true, 'prestart')).toBe(true);
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok')).toEqual({ status: 409, body: { success: false, error: 'not_started', message: 'This tournament has not started yet.' } });
    const socket: any = { id: 'ADMIN', handlers: {}, emitted: [] as any[] };
    socket.on = (ev: string, fn: any) => { socket.handlers[ev] = fn; };
    socket.emit = (ev: string, d: any) => socket.emitted.push([ev, d]);
    w.m.wire(socket);
    await socket.handlers.pauseTournament({ tournamentId: w.tid, paused: false });
    // A director's PAUSE of the hold is refused too (the tables would read "paused by the director").
    await socket.handlers.pauseTournament({ tournamentId: w.tid, paused: true });
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'tok').status).toBe(409);
    expect(socket.emitted).toEqual([
      ['error', { message: 'This tournament has not started yet.', code: 'not_started' }],
      ['error', { message: 'This tournament has not started yet.', code: 'not_started' }],
    ]);
    expect(w.t.paused).toBe(true);
    expect(w.t.pauseReason).toBe('prestart');
    expect(w.audits).toEqual([]);
    expect(w.roomEmits).toEqual([]);
    // A tournament that is not running: the old message.
    await socket.handlers.pauseTournament({ tournamentId: 'nope', paused: true });
    expect(socket.emitted[2]).toEqual(['error', { message: 'Tournament not running', code: 'not_running' }]);
    // The start's own resume ends the hold; the director's controls work again.
    expect(w.tm.pauseTournament(w.tid, false, 'prestart')).toBe(true);
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'tok').body).toMatchObject({ success: true, paused: true, pauseReason: 'director' });
  });
});

// ═══════════════════════════════ the level clock in every full state ══
const STATE = [
  fnSrc('function getVariantInfo('),
  slice('// ===== Tournament level clock', '// ===== end tournament level clock =====\n'),
  fnSrc('function getGameStateForPlayer('),
  fnSrc('function qualifierOfTournament('),
].join('\n');

/** `extra` (2026-10-24, C1): more source + scope + exports on top of STATE (the hand-for-hand block). */
function stateWorld(extra: { code?: string; scope?: Record<string, unknown>; exports?: string } = {}) {
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 99, startInterval: 0,
    blindLevels: LEVELS, startingChips: STACK, breaks: qualifierBreakConfig(),
  } as any);
  for (let i = 0; i < 4; i++) tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, undefined, `m-${i}`);
  expect(tm.startTournament(tid)).toBeTruthy();
  const mk = (id: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: LEVELS[0].sb, bigBlind: LEVELS[0].bb, minBuyIn: STACK, maxBuyIn: STACK * 10, maxPlayers: 9 } as any);
    for (let i = 0; i < 4; i++) t.sitDown(i, `P${i}`, STACK, `p${i}`, false, true);
    return t;
  };
  const tourT = mk('TT');
  const cashT = mk('CASH');
  const tournamentTables = new Map([['TT', tid]]);
  const qualifierTournaments = new Map<string, any>([['Q1', {
    status: 'running', tournamentId: tid, qualifierType: 'weekly',
    seatPackage: { 1: 3, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 },
  }]]);
  const { exports: m } = load(extra.code ? `${STATE}\n${extra.code}` : STATE, {
    tournamentManager: tm, qualifierTournaments, seatsForTopWith, MAX_SEATS, GamePhase, cardToString,
    playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
    dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null,
    tournamentIdOfTable: (id: string) => tournamentTables.get(id), rebuyAllowedAt: () => false,
    progressionManager: { getProgress: () => null, equippedTheme: () => null }, sitOutTracker: new Map(),
    console: quiet,
    ...(extra.scope || {}),
  }, `{ getGameStateForPlayer, tournamentClockStateFor${extra.exports ?? ''} }`);
  return { tm, tid, t: tm.getTournament(tid)!, tourT, cashT, qualifierTournaments, m };
}

describe('gameState: the level clock in every full state (always-present keys; additive tournamentClock)', () => {
  it('a tournament table: blindLevel, nextBlindIn > 0, blindLevelDuration 720 and tournamentClock (blinds, next, levelEndsAt, serverNow, standings, paidPlaces 10)', () => {
    const w = stateWorld();
    jest.advanceTimersByTime(60_000);
    const s = w.m.getGameStateForPlayer(w.tourT, 0, false);
    expect(s.isTournament).toBe(true);
    expect(s.blindLevel).toBe(1);
    expect(s.nextBlindIn).toBe(660);
    expect(s.blindLevelDuration).toBe(720);
    expect(s.tournamentClock).toEqual({
      level: 1, levels: LEVELS.length, sb: LEVELS[0].sb, bb: LEVELS[0].bb, ante: LEVELS[0].ante,
      next: { sb: LEVELS[1].sb, bb: LEVELS[1].bb, ante: LEVELS[1].ante },
      levelEndsAt: w.t.levelEndsAt, serverNow: Date.now(), paused: false, pauseReason: null, breakUntil: null, dealsAt: null,
      playersLeft: 4, entries: 4, avgStack: STACK, paidPlaces: 10,
      levelDurationMs: LEVEL_MS, levelRemainingMs: null, resumesAt: null,
    });
    // The spectator view carries it too.
    expect(w.m.getGameStateForPlayer(w.tourT, -1, false).tournamentClock.level).toBe(1);
  });

  it('a cash table: the keys are PRESENT with null / 0 (so the per-socket delta clears them after a move)', () => {
    const w = stateWorld();
    const s = w.m.getGameStateForPlayer(w.cashT, 0, false);
    for (const k of ['blindLevel', 'nextBlindIn', 'blindLevelDuration', 'tournamentClock']) expect(k in s).toBe(true);
    expect(s.blindLevel).toBeNull();
    expect(s.nextBlindIn).toBe(0);
    expect(s.blindLevelDuration).toBeNull();
    expect(s.tournamentClock).toBeNull();
  });

  it('a break: nextBlindIn 0, paused with reason break, breakUntil = resumesAt; shown at the VERY next state (the memo is keyed by the clock)', () => {
    const w = stateWorld();
    jest.advanceTimersByTime(5 * LEVEL_MS - 100);
    const before = w.m.getGameStateForPlayer(w.tourT, 0, false);
    expect(before.tournamentClock.paused).toBe(false);
    jest.advanceTimersByTime(100);                       // the break starts 100 ms later (inside the 500 ms memo)
    const s = w.m.getGameStateForPlayer(w.tourT, 0, false);
    expect(s.blindLevel).toBe(5);
    expect(s.nextBlindIn).toBe(0);
    expect(s.tournamentClock).toMatchObject({
      level: 5, paused: true, pauseReason: 'break', breakUntil: Date.now() + BREAK_MS, resumesAt: Date.now() + BREAK_MS,
      levelEndsAt: null, levelRemainingMs: null, next: { sb: LEVELS[5].sb, bb: LEVELS[5].bb, ante: LEVELS[5].ante },
    });
    // A director pause: the frozen time.
    jest.advanceTimersByTime(BREAK_MS + 2 * 60_000);
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);
    const p = w.m.getGameStateForPlayer(w.tourT, 0, false);
    expect(p.nextBlindIn).toBe(0);
    expect(p.tournamentClock).toMatchObject({ level: 6, paused: true, pauseReason: 'director', levelRemainingMs: LEVEL_MS - 2 * 60_000, levelEndsAt: null });
  });

  it('memoised per tournament for 500 ms: one build serves every socket; it is rebuilt after 500 ms', () => {
    const w = stateWorld();
    const spy = jest.spyOn(w.tm, 'getLevelClock');
    const a = w.m.getGameStateForPlayer(w.tourT, 0, false);
    const b = w.m.getGameStateForPlayer(w.tourT, 1, false);
    expect(b.tournamentClock).toBe(a.tournamentClock);
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(499);
    w.m.getGameStateForPlayer(w.tourT, 2, false);
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    const c = w.m.getGameStateForPlayer(w.tourT, 2, false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(c.tournamentClock.serverNow).toBe(Date.now());
  });

  it('at the last level: nextBlindIn 0 and next null', () => {
    const w = stateWorld();
    w.tm.breaksEnabled = false;
    jest.advanceTimersByTime((LEVELS.length - 1) * LEVEL_MS + 1000);
    const s = w.m.getGameStateForPlayer(w.tourT, 0, false);
    expect(s.blindLevel).toBe(LEVELS.length);
    expect(s.nextBlindIn).toBe(0);
    expect(s.tournamentClock.next).toBeNull();
  });

  it('avgStack follows late entries and re-entries: entries x 50,000 / alive', () => {
    const w = stateWorld();
    expect(w.tm.addLateEntrant(w.tid, 'late1', 'L1', 'x1', STACK, { masterUserId: 'm-l1' })).toBeTruthy();
    expect(w.tm.addLateEntrant(w.tid, 'late2', 'L2', 'x2', STACK, { masterUserId: 'm-l2' })).toBeTruthy();
    expect(w.tm.eliminatePlayer(w.tid, 'p0')).toBeTruthy();
    expect(w.tm.eliminatePlayer(w.tid, 'p1')).toBeTruthy();
    expect(w.tm.reinstateForReentry(w.tid, 'p0', STACK)).toBe(true);
    // 4 + 2 late + 1 re-entry = 7 entries; 5 alive.
    const c = w.m.getGameStateForPlayer(w.tourT, 0, false).tournamentClock;
    expect(c).toMatchObject({ entries: 7, playersLeft: 5, avgStack: Math.round((7 * STACK) / 5) });
  });

  it('a non-qualifier tournament: paidPlaces null', () => {
    const w = stateWorld();
    w.qualifierTournaments.clear();
    expect(w.m.getGameStateForPlayer(w.tourT, 0, false).tournamentClock.paidPlaces).toBeNull();
  });
});

// ═══════════════════════════════ review fix-up (on 8c7d9ca) ══
// The block applyDirectorPause gained (the CONTROL below removes it).
const BALANCE_ON_RESUME = '  if (!paused && wasPaused) {\n    try { balanceQualifierTablesNow(tournamentId); } catch (_) { /* never blocks the resume */ }\n  }\n';
/** poker-3d utils/tournamentClock.js marksDirectorPause, as TournamentLobby applies it to a list item. */
const lobbyOffersResume = (item: any): boolean => !!item.paused && item.pauseReason !== 'break' && item.pauseReason !== 'prestart';

describe('review fix-up: the lobby list names the pause', () => {
  it("getTournamentList: pauseReason 'break' during a break (the lobby's TD control then offers no '▶ Resume'), 'director' for his pause, 'prestart' for the start hold, null while running", () => {
    const w = tmWorld();
    const item = () => (w.tm.getTournamentList(null) as any[]).find((x) => x.tournamentId === w.tid);
    expect(item()).toMatchObject({ status: 'running', paused: false, pauseReason: null });
    jest.advanceTimersByTime(5 * LEVEL_MS);                                   // break 1
    expect(item()).toMatchObject({ paused: true, pauseReason: 'break' });
    expect(lobbyOffersResume(item())).toBe(false);
    // Old list item (no pauseReason): the client read the break as a director pause.
    expect(lobbyOffersResume({ ...item(), pauseReason: undefined })).toBe(true);
    expect(w.tm.pauseTournament(w.tid, true)).toBe(true);                    // his pause replaces the break
    expect(item()).toMatchObject({ paused: true, pauseReason: 'director' });
    expect(lobbyOffersResume(item())).toBe(true);
    expect(w.tm.pauseTournament(w.tid, false)).toBe(true);
    expect(item()).toMatchObject({ paused: false, pauseReason: null });
    expect(w.tm.pauseTournament(w.tid, true, 'prestart')).toBe(true);
    expect(item()).toMatchObject({ paused: true, pauseReason: 'prestart' });
    expect(lobbyOffersResume(item())).toBe(false);
    // The rest of the item is unchanged (additive).
    expect(Object.keys(item())).toEqual([
      'registered', 'entryId', 'minPlayers', 'tournamentId', 'name', 'buyIn', 'prizePool', 'fundedPool', 'isFreeroll',
      'maxPlayers', 'registeredPlayers', 'status', 'paused', 'pauseReason', 'nextStartTime', 'currentBlinds', 'blindLevel', 'blindLevelCount',
    ]);
  });
});

describe('review fix-up: a director Resume evens the tables before the re-kick (as the break end does)', () => {
  function withRunningQualifier(w: ReturnType<typeof routesWorld>) {
    w.qualifierTournaments.set('Q1', { qualifierId: 'Q1', status: 'running', tournamentId: w.tid, qualifierType: 'weekly' });
  }

  it('Resume of a director pause: balanceQualifierTablesNow runs once, after the clock restarts and BEFORE every table is re-kicked; Pause and an idempotent Resume do not balance', () => {
    expect(ROUTES).toContain(BALANCE_ON_RESUME);
    const w = routesWorld();
    withRunningQualifier(w);
    jest.advanceTimersByTime(4 * 60_000);
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'tok').status).toBe(200);
    expect(w.balanced).toEqual([]);                                          // Pause: nothing moves
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok').body).toMatchObject({ success: true, paused: false });
    expect(w.seq).toEqual([`balance:${w.tid}:paused=false`, 'kick:T1', 'kick:T2']);
    expect(w.t.levelEndsAt).toBe(Date.now() + 8 * 60_000);                   // the time left, unchanged by the fix
    // A Resume of a tournament that is not paused (idempotent): no balance.
    w.seq.length = 0;
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok').status).toBe(200);
    expect(w.seq).toEqual(['kick:T1', 'kick:T2']);
    expect(w.balanced).toEqual([w.tid]);
  });

  it('the admin socket Resume balances the same way (one body: applyDirectorPause)', async () => {
    const w = routesWorld();
    const socket: any = { id: 'ADMIN', handlers: {}, emitted: [] as any[] };
    socket.on = (ev: string, fn: any) => { socket.handlers[ev] = fn; };
    socket.emit = (ev: string, d: any) => socket.emitted.push([ev, d]);
    w.m.wire(socket);
    await socket.handlers.pauseTournament({ tournamentId: w.tid, paused: true });
    expect(w.balanced).toEqual([]);
    await socket.handlers.pauseTournament({ tournamentId: w.tid, paused: false });
    expect(w.seq).toEqual([`balance:${w.tid}:paused=false`, 'kick:T1', 'kick:T2']);
    expect(socket.emitted).toEqual([]);
  });

  it('a Resume that ends a BREAK, and one that ends a director pause which replaced a break: the next level in force, then the balance, then the re-kick', () => {
    const w = routesWorld();
    withRunningQualifier(w);
    jest.advanceTimersByTime(5 * LEVEL_MS + 30_000);
    expect(w.t.pauseReason).toBe('break');
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok').status).toBe(200);
    expect(w.t.currentBlindLevel).toBe(5);                                   // L6, full time
    expect(w.seq).toEqual([`balance:${w.tid}:paused=false`, 'kick:T1', 'kick:T2']);
    // Break 2 (after L10), replaced by the director's pause, then his Resume.
    w.seq.length = 0;
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.pauseReason).toBe('break');
    expect(w.call('/api/qualifiers/pause', { paused: 1 }, 'tok').body).toMatchObject({ paused: true, pauseReason: 'director' });
    expect(w.seq).toEqual([]);
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok').status).toBe(200);
    expect(w.t.currentBlindLevel).toBe(10);                                  // L11, full time
    expect(w.t.levelEndsAt).toBe(Date.now() + LEVEL_MS);
    expect(w.seq).toEqual([`balance:${w.tid}:paused=false`, 'kick:T1', 'kick:T2']);
  });

  it('a throwing balance never blocks the Resume: the clock runs, every table is told and re-kicked', () => {
    const w = routesWorld({ balanceThrows: true });
    withRunningQualifier(w);
    w.call('/api/qualifiers/pause', { paused: 1 }, 'tok');
    w.roomEmits.length = 0;
    expect(w.call('/api/qualifiers/pause', { paused: 0 }, 'tok').body).toMatchObject({ success: true, paused: false });
    expect(w.t.paused).toBe(false);
    expect(w.scheduled).toEqual(['T1', 'T2']);
    expect(w.roomEmits.map(([room, ev]) => [room, ev])).toEqual([['table:T1', 'tournamentResumed'], ['table:T2', 'tournamentResumed']]);
  });

  it('CONTROL — without the fix-up block a director Resume (of a pause or of a break) never balances', () => {
    const w = routesWorld({ routes: ROUTES.replace(BALANCE_ON_RESUME, '') });
    withRunningQualifier(w);
    w.call('/api/qualifiers/pause', { paused: 1 }, 'tok');
    w.call('/api/qualifiers/pause', { paused: 0 }, 'tok');
    jest.advanceTimersByTime(5 * LEVEL_MS);
    expect(w.t.pauseReason).toBe('break');
    w.call('/api/qualifiers/pause', { paused: 0 }, 'tok');
    expect(w.balanced).toEqual([]);
    expect(w.scheduled).toEqual(['T1', 'T2', 'T1', 'T2']);
  });
});

describe('review fix-up: the qualifier card follows the break switch (structure.breaks.on)', () => {
  function listWorld() {
    const tm = new TournamentManager();
    const at = Date.now() + 2 * 60 * 60_000;
    const qt: any = {
      qualifierId: 'Q1', masterQualifierId: 'Q1', qualifierType: 'weekly', qualifierName: 'Weekly Qualifier',
      scheduledAt: new Date(at).toISOString(), startingStack: QUALIFIER_BASE_STACK, players: [], status: 'registering',
      tournamentId: null, results: null, seatPackage: null,
    };
    const { exports: m, stubbed } = load(fnSrc('function qualifierListItem('), {
      tournamentManager: tm, qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
      QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers: new Map(),
    }, '{ qualifierListItem }');
    return { tm, qt, item: () => m.qualifierListItem('Q1', qt, Date.now(), null), stubbed };
  }

  it("breaks on: {everyLevels:5, minutes:5, on:true}; switched off (QUALIFIER_BREAKS=0 / POST /api/qualifiers/breaks {on:0}): on:false — the levels unchanged either way", () => {
    const w = listWorld();
    const s = qualifierStructure(QUALIFIER_BASE_STACK);
    expect(w.item().structure).toEqual({ ...s, breaks: { everyLevels: 5, minutes: 5, on: true } });
    w.tm.breaksEnabled = false;
    expect(w.item().structure).toEqual({ ...s, breaks: { everyLevels: 5, minutes: 5, on: false } });
    w.tm.breaksEnabled = true;
    expect(w.item().structure.breaks.on).toBe(true);
    expect([...w.stubbed]).toEqual([]);                                     // nothing it reads was silently stubbed
  });

  it('the route flips what the card says (setQualifierBreaks writes the same switch the list reads)', () => {
    const r = routesWorld();
    const w = listWorld();
    // One TournamentManager for both: the route's.
    const { exports: m } = load(fnSrc('function qualifierListItem('), {
      tournamentManager: r.tm, qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
      QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers: new Map(),
    }, '{ qualifierListItem }');
    const item = () => m.qualifierListItem('Q1', w.qt, Date.now(), null);
    expect(item().structure.breaks.on).toBe(true);
    expect(r.call('/api/qualifiers/breaks', { on: 0 }, 'tok').body).toEqual({ success: true, previous: true, on: false });
    expect(item().structure.breaks.on).toBe(false);
    expect(r.call('/api/qualifiers/breaks', { on: 1 }, 'tok').status).toBe(200);
    expect(item().structure.breaks.on).toBe(true);
  });
});

// ═══════════════════════════════ wiring ══
describe('wiring', () => {
  it('the admin socket handler runs applyDirectorPause; the routes are registered; the durable audit names; health; the manifest tokens', () => {
    const handler = handlerSrc('pauseTournament', '\n  });\n');
    expect(handler).toContain('applyDirectorPause(data.tournamentId, !!data.paused, auth.username)');
    expect(handler.indexOf('isUserAdmin(auth.userId)')).toBeLessThan(handler.indexOf('applyDirectorPause('));
    expect(SRC).toContain("app.post('/api/qualifiers/breaks'");
    expect(SRC).toContain("app.post('/api/qualifiers/pause'");
    const durable = slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);');
    for (const a of ['QUALIFIER_BREAKS_SET', 'TOURNAMENT_PAUSE']) expect(durable).toContain(`'${a}'`);
    expect(SRC).toContain('breaks: { on: tournamentManager.breaksEnabled, everyLevels: QUALIFIER_BREAK_EVERY_LEVELS, minutes: QUALIFIER_BREAK_MINUTES, ...tournamentManager.breakStats },');
    expect(SRC).toContain('testTimeScale: qualifierTestTimeScale(process.env),');
    expect(SRC).toContain("tournamentManager.breaksEnabled = process.env.QUALIFIER_BREAKS !== '0';");
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const tok of ['qualifier_break_started', 'tournamentClock', '/api/qualifiers/breaks', '/api/qualifiers/pause']) {
      expect({ tok, listed: manifest.includes(tok) }).toEqual({ tok, listed: true });
    }
  });
});

// ═══════════════════════════════ 2026-10-24 — hand-for-hand in the clock (additive) ══
describe('2026-10-24 (owner 2026-10-23: "Build it for Sunday") — hand-for-hand: the table clock says so while it is engaged (additive keys)', () => {
  it('C1 — engaged: tournamentClock gains {handForHand:true, handForHandRound, handForHandText} at the VERY next state (the memo is keyed by it); released: the keys are gone (the exact S3 baseline)', () => {
    // require (not import): the names do not exist on 5b8ad77 and the rest of this file must still compile.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QS: Record<string, any> = require('../src/game/qualifierSchedule');
    const HFH = slice('// ===== Hand-for-hand at the qualifier seat bubble', '// ===== end hand-for-hand =====\n');
    const w = stateWorld({
      code: HFH,
      scope: { qualifierHandForHandOnAtBoot: QS.qualifierHandForHandOnAtBoot, QUALIFIER_HAND_FOR_HAND_TEXT: QS.QUALIFIER_HAND_FOR_HAND_TEXT, process: { env: {} } },
      exports: ', handForHandStates',
    });
    const base = w.m.getGameStateForPlayer(w.tourT, 0, false).tournamentClock;
    for (const k of ['handForHand', 'handForHandRound', 'handForHandText']) expect(k in base).toBe(false);
    // Engaged, round 2 running — inside the 500 ms memo window: rebuilt at once.
    w.m.handForHandStates.set(w.tid, { tournamentId: w.tid, round: { no: 2 }, rounds: 2, held: new Set(), heldSince: null, watchdog: null });
    const on = w.m.getGameStateForPlayer(w.tourT, 1, false).tournamentClock;
    expect(on).toEqual({ ...base, handForHand: true, handForHandRound: 2, handForHandText: 'Hand-for-hand: waiting for the other tables to finish their hand' });
    // Gathering (between rounds / after a pause): still engaged, no round number.
    w.m.handForHandStates.get(w.tid).round = null;
    expect(w.m.getGameStateForPlayer(w.tourT, 2, false).tournamentClock).toMatchObject({ handForHand: true, handForHandRound: null });
    // Released: the keys are gone at once (the per-socket delta replaces the object, so the client clears them).
    w.m.handForHandStates.delete(w.tid);
    const off = w.m.getGameStateForPlayer(w.tourT, 3, false).tournamentClock;
    expect(off).toEqual(base);
    // A cash table: still null.
    expect(w.m.getGameStateForPlayer(w.cashT, 0, false).tournamentClock).toBeNull();
  });

  it('C2 — the manifest locks the feature: its tokens are in canonical-features.txt and in src/index.ts; the clock wires the fields + the memo key', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'canonical-features.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const tok of ['qualifier_hand_for_hand_engaged', 'qualifier_hand_for_hand_busts_placed', '/api/qualifiers/hand-for-hand']) {
      expect({ tok, listed: manifest.includes(tok), inSource: SRC.includes(tok) }).toEqual({ tok, listed: true, inSource: true });
    }
    const clock = slice('// ===== Tournament level clock', '// ===== end tournament level clock =====\n');
    expect(clock).toContain('...handForHandClockFields(tournamentId),');
    expect(clock).toContain('|${handForHandClockSig(tournamentId)}');
  });
});

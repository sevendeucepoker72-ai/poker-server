/**
 * Bots review 2026-11-04 (stud-draw-lowball SD7, A-drawhang) — a missing
 * aiProfiles entry can no longer stall a draw table.
 *
 * Before (0dc1b96), scheduleAIAction:
 *  (a) scheduled the bots' draws only `if (profiles)` — the draw reads no
 *      profile, yet with the table's map missing no bot ever drew;
 *  (b) the 30 s draw clock stood only HUMANS pat, so a bot whose draw timer was
 *      lost left the round waiting forever;
 *  (c) a bot BETTING turn returned ('[AI] No profiles found') when the map was
 *      missing, so every bot action waited for the 20 s wedge watchdog.
 * Now: (a) the draw block is unconditional; (b) the clock stands ANY undrawn
 * seat pat; (c) the missing map is recreated and the per-seat profile
 * synthesized (the existing TAG default).
 *
 * The REAL scheduleAIAction (sliced from src/index.ts) under fake timers on a
 * REAL FiveCardDrawTable. (The SD6 bot-discard wiring case joins this file
 * with the studDrawStrength contract.)
 */
import { GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { fnSrc, load } from './helpers/indexSource';

const T = 'T';
const cfg = () => ({ tableId: T, tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];

describe('SD7 — a missing aiProfiles entry can no longer stall a draw table', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); jest.setSystemTime(1_000_000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function world(t: FiveCardDrawTable, aiProfiles: Map<string, any>) {
    const executed: any[] = [];
    const warnings: string[] = [];
    const { exports: schedule, stubbed } = load(fnSrc('function scheduleAIAction('), {
      tableManager: { getTable: () => t }, GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, drawTimers: new Map(),
      aiProfiles, aiTimeouts: new Map(), TURN_TIMEOUT_MS: 30000, drawClockStart: () => Date.now(),
      broadcastGameState() {}, armAbsentDrawerStandPat() {},
      fastModeTables: new Map(), tableWantsFastBots: () => true, getThinkingDelay: () => 500,
      executeAIAction: (id: string, seat: number, profile: any) => executed.push([id, seat, profile]),
      console: { log() {}, warn: (m: string) => warnings.push(m), error() {} },
    }, 'scheduleAIAction');
    return { schedule, executed, warnings, stubbed };
  }
  function toDraw1(t: FiveCardDrawTable) {
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    expect(t.currentPhase).toBe(GamePhase.Draw1);
  }

  it('(a) no profile map for the table: every bot still draws and the hand reaches Bet2 (0dc1b96: no draw, stuck in Draw1)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    for (const i of [0, 1, 2]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    toDraw1(t);
    const w = world(t, new Map());
    w.schedule(T);
    jest.advanceTimersByTime(2000);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
    expect([...w.stubbed].filter((n) => /aiProfiles|playerDraw|drawsCompleted|DrawPhases/.test(n))).toEqual([]);
  });

  it('(b) the 30 s draw clock stands an undrawn BOT pat (0dc1b96: humans only — the round waited forever)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    for (const i of [0, 1]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    t.sitDown(2, 'Human', 5000, 'h', false);
    toDraw1(t);
    const w = world(t, new Map([[T, new Map()]]));
    w.schedule(T);
    // The bots' draw timers are lost (what a missing map / a crashed callback did): only the clock is left.
    const realDraw = t.playerDraw.bind(t);
    let botsBlocked = true;
    t.playerDraw = (seat: number, idx: number[]) => (botsBlocked && t.seats[seat].isAI ? false : realDraw(seat, idx));
    jest.advanceTimersByTime(2000);
    botsBlocked = false;
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(realDraw(2, [])).toBe(true);                // the human draws
    expect(t.currentPhase).toBe(GamePhase.Draw1);       // the two bots are still owed
    jest.advanceTimersByTime(28_100);                   // the 30 s deadline
    expect(t.currentPhase).not.toBe(GamePhase.Draw1);  // both bots stood pat; the round completed
  });

  it('(c) a bot betting turn with no profile map recreates the map, synthesizes a TAG profile and acts (0dc1b96: returned — waited for the 20 s watchdog)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    for (const i of [0, 1, 2]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    expect(t.startNewHand()).toBe(true);
    const aiProfiles = new Map<string, any>();
    const w = world(t, aiProfiles);
    w.schedule(T);
    jest.advanceTimersByTime(200);
    expect(w.executed).toHaveLength(1);
    expect(w.executed[0][1]).toBe(t.activeSeatIndex);
    expect(aiProfiles.get(T)?.get(t.activeSeatIndex)?.archetype).toBe('TAG');
    expect(w.warnings.some((m) => m.includes(`Missing profile map for ${T}`))).toBe(true);
  });

  it('GUARD (passes at 0dc1b96 too) — with its profile map present a bot betting turn acts with its own profile (no warning)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    for (const i of [0, 1, 2]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    expect(t.startNewHand()).toBe(true);
    const own = new Map<number, any>([0, 1, 2].map((i) => [i, { botName: `B${i}`, difficulty: 'hard', archetype: 'LAG' }]));
    const w = world(t, new Map([[T, own]]));
    w.schedule(T);
    jest.advanceTimersByTime(200);
    expect(w.executed).toEqual([[T, t.activeSeatIndex, own.get(t.activeSeatIndex)]]);
    expect(w.warnings).toEqual([]);
  });
});

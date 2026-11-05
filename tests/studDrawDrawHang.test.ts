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
 * REAL FiveCardDrawTable.
 *
 * SD6 (bots review 2026-11-04, B3 / B15 / Badugi-greedy) — the bot's draw timer
 * now hands playerDraw the indices from studDrawStrength.chooseBotDiscards
 * (unit-tested in tests/studDrawDiscards.test.ts). At 0dc1b96 the inline picker
 * kept pairs or the two highest cards, so a pat straight threw three cards
 * ([0,1,2]) and a four-flush threw three too.
 */
import { GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { BadugiTable } from '../src/game/variants/BadugiTable';
import { Card } from '../src/game/Card';
import { studDrawKindOf, chooseBotDiscards } from '../src/ai/studDrawStrength';
import { fnSrc, load } from './helpers/indexSource';

const T = 'T';
const cfg = () => ({ tableId: T, tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));

function world(t: FiveCardDrawTable, aiProfiles: Map<string, any>) {
  const executed: any[] = [];
  const warnings: string[] = [];
  const { exports: schedule, stubbed } = load(fnSrc('function scheduleAIAction('), {
    tableManager: { getTable: () => t }, GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, MAX_SEATS, drawTimers: new Map(),
    aiProfiles, aiTimeouts: new Map(), TURN_TIMEOUT_MS: 30000, drawClockStart: () => Date.now(),
    broadcastGameState() {}, armAbsentDrawerStandPat() {}, studDrawKindOf, chooseBotDiscards,
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
const STUBBED_DRAW_NAMES = /aiProfiles|playerDraw|drawsCompleted|DrawPhases|studDrawKindOf|chooseBotDiscards/;

describe('SD6 — the bot draw timer hands playerDraw the chooseBotDiscards pick', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); jest.setSystemTime(1_000_000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('(1) Five Card Draw: a pat straight stands pat ([]) and a four-flush draws one (0dc1b96: [0,1,2] and [2,3,4])', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    for (const i of [0, 1, 2]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    toDraw1(t);
    t.seats[0].holeCards = cs('9h Td Jc Qs Kh');   // a made straight
    t.seats[1].holeCards = cs('Kh Qh 8h 4h 2c');   // four hearts: throw the 2c
    t.seats[2].holeCards = cs('9h 9d 5c 3s 2h');   // a pair: keep it, draw three
    const drawn = new Map<number, number[]>();
    const real = t.playerDraw.bind(t);
    t.playerDraw = (seat: number, idx: number[]) => { drawn.set(seat, [...idx].sort((a, b) => a - b)); return real(seat, idx); };
    const w = world(t, new Map([[T, new Map()]]));
    w.schedule(T);
    jest.advanceTimersByTime(2000);
    expect(drawn.get(0)).toEqual([]);
    expect(drawn.get(1)).toEqual([4]);
    expect(drawn.get(2)).toEqual([2, 3, 4]);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
    expect([...w.stubbed].filter((n) => STUBBED_DRAW_NAMES.test(n))).toEqual([]);
  });

  it('(1b) Badugi: the best badugi subset is kept (0dc1b96: the greedy pick kept Ah 3c and 2d Ks)', () => {
    const t = new BadugiTable(cfg());
    for (const i of [0, 1]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    toDraw1(t);
    t.seats[0].holeCards = cs('Ah As 2h 3c');      // best three-card badugi: As 2h 3c (draw the Ah)
    t.seats[1].holeCards = cs('7d 2d 2s Ks');      // best two-card badugi: 7d 2s
    const drawn = new Map<number, number[]>();
    const real = t.playerDraw.bind(t);
    t.playerDraw = (seat: number, idx: number[]) => { drawn.set(seat, [...idx].sort((a, b) => a - b)); return real(seat, idx); };
    const w = world(t, new Map([[T, new Map()]]));
    w.schedule(T);
    jest.advanceTimersByTime(2000);
    const keptOf = (seat: number, hand: string) => cs(hand).filter((_, i) => !(drawn.get(seat) || []).includes(i)).map((c) => `${c.rank}/${c.suit}`).sort();
    expect(drawn.has(0) && drawn.has(1)).toBe(true);
    expect(keptOf(0, 'Ah As 2h 3c')).toEqual(['14/3', '2/0', '3/2'].sort());
    expect(keptOf(1, '7d 2d 2s Ks')).toEqual(['2/3', '7/1'].sort());
    expect([...w.stubbed].filter((n) => STUBBED_DRAW_NAMES.test(n))).toEqual([]);
  });
});

describe('SD7 — a missing aiProfiles entry can no longer stall a draw table', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); jest.setSystemTime(1_000_000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('(a) no profile map for the table: every bot still draws and the hand reaches Bet2 (0dc1b96: no draw, stuck in Draw1)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    for (const i of [0, 1, 2]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    toDraw1(t);
    const w = world(t, new Map());
    w.schedule(T);
    jest.advanceTimersByTime(2000);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
    expect([...w.stubbed].filter((n) => STUBBED_DRAW_NAMES.test(n))).toEqual([]);
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

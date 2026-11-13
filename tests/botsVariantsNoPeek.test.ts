/**
 * tests/botsVariantsNoPeek.test.ts (2026-11 bots review, equity-variants C4 wiring; ai-core).
 *
 * (1) No peeking: on Omaha-5 / Omaha-6 / Omaha Hi-Lo / Short Deck / Pineapple / Crazy
 *     Pineapple, replacing every opponent's hidden hole cards with other unseen cards
 *     leaves the bot's decision AND every calculateEquity argument identical. The clock
 *     steps 50 ms per read inside decideAction only, so every budgeted equity stops at
 *     exactly its minimum simulations (deterministic and cheap).
 * (2) Fuzz: bot-only hands through the real executeAIAction (sliced from src/index.ts,
 *     as r2AiBots.playBotHands does) with the real clock: 0 throws, 0 stuck hands.
 * GUARD suite: it passes on 0dc1b96 too (the bots never read hidden cards there either);
 * it pins that the new Omaha / Short Deck / Pineapple wiring keeps it that way.
 * 2026-11-12 (Short Deck reset): 'short-deck' is the shipped path, live 0dc1b96 (SHORT_DECK_BOTS_PLAY_LIVE; its equity is
 * the frozen copy's calculateEquity, spied too); 'short-deck-lane' runs the dormant lane code through the Jest-only hook.
 */
import { Card } from '../src/game/Card';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import * as TE from '../src/training/TrainingEngine';
import * as LIVE_TE from '../src/ai/live0dc1b96/TrainingEngine';
import { decideAction, generateRandomProfile, setShortDeckLaneForTests } from '../src/ai/AIPlayer';
import { fnSrc, load } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');

const cfg = (bb = 100) => ({ tableId: 'np', tableName: 'np', smallBlind: bb / 2, bigBlind: bb, ante: 0, minBuyIn: bb * 100 } as any);
const MK: Record<string, () => PokerTable> = {
  omaha: () => new OmahaTable(cfg(), false, 4),
  'omaha-5': () => new OmahaTable(cfg(), false, 5),
  'omaha-6': () => new OmahaTable(cfg(), false, 6),
  'omaha-hi-lo': () => new OmahaTable(cfg(), true, 4),
  'omaha-6-hilo': () => new OmahaTable(cfg(), true, 6),
  'short-deck': () => new ShortDeckTable(cfg()),
  'short-deck-lane': () => new ShortDeckTable(cfg()),   // the dormant lane code (setShortDeckLaneForTests)
  pineapple: () => new PineappleTable(cfg(50), false),
  'crazy-pineapple': () => new PineappleTable(cfg(50), true),
};
const ARCH = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const prof = (archetype: string) =>
  ({ botName: 'B', difficulty: 'hard', personality: 'tight', archetype, vpip: 0.22, pfr: 0.18, aggressionFactor: 2.75, bluffFrequency: 0.15 } as any);

/** Seeded Math.random + a deterministic crypto.randomBytes (the deal repeats) around fn. */
function seededDeal<T>(seed: number, fn: () => T): T {
  const rb = nodeCrypto.randomBytes, r = Math.random;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`np-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  try { return fn(); } finally { nodeCrypto.randomBytes = rb; Math.random = r; }
}
/** Seeded Math.random and a clock that steps 50 ms per read, only around fn. */
function steppedDecision<T>(seed: number, fn: () => T): T {
  const r = Math.random, now = Date.now;
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  let clock = 1_700_000_000_000; Date.now = () => (clock += 50);
  try { return fn(); } finally { Math.random = r; Date.now = now; }
}
/** Runs fn with the dormant Short Deck lane code on for the 'short-deck-lane' case. */
function laneIf<T>(v: string, fn: () => T): T {
  if (v !== 'short-deck-lane') return fn();
  setShortDeckLaneForTests(true);
  try { return fn(); } finally { setShortDeckLaneForTests(false); }
}
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('(1) no peeking: opponents\' hidden cards never change a decision', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['omaha-5', 'omaha-6', 'omaha-hi-lo', 'short-deck', 'short-deck-lane', 'pineapple', 'crazy-pineapple'])('%s: 40 decision points (pre-flop, flop, turn)', (v) => laneIf(v, () => {
    // Every calculateEquity call in call order, from either equity module (the shipped Short Deck path reads the frozen copy's).
    const calls: any[][] = [];
    const origNew = TE.calculateEquity, origLive = LIVE_TE.calculateEquity;
    jest.spyOn(TE, 'calculateEquity').mockImplementation((...a: any[]) => { calls.push(['new', ...a]); return (origNew as any)(...a); });
    jest.spyOn(LIVE_TE, 'calculateEquity').mockImplementation((...a: any[]) => { calls.push(['0dc1b96', ...a]); return (origLive as any)(...a); });
    const spy = { mock: { calls } };
    let checks = 0;
    for (let k = 0; k < 40; k++) {
      const ready = seededDeal(300 + k, () => {
        const t = MK[v]();
        for (let i = 0; i < 4; i++) t.sitDown(i, 'B' + i, t.config.minBuyIn, `ai-np-${v}-${i}`, true);
        t.startNewHand();
        const street = k % 3;
        let g = 0;
        while (t.isHandInProgress() && g++ < 60 && t.communityCards.length < [0, 3, 4][street]) {
          const a = t.activeSeatIndex; if (a < 0) break;
          if (!t.playerCall(a)) t.playerCheck(a);
        }
        return t.isHandInProgress() && t.activeSeatIndex >= 0 ? t : null;
      });
      if (!ready) continue;
      const t = ready;
      const me = t.activeSeatIndex;
      const p = prof(ARCH[k % ARCH.length]);
      const argsOf = (from: number) => JSON.stringify(spy.mock.calls.slice(from));
      let mark = spy.mock.calls.length;
      const d0 = steppedDecision(77 + k, () => decideAction(t, me, p));
      const a0 = argsOf(mark);
      // Replace every opponent's hole cards with cards nobody holds and the board does not show.
      const lo = v.startsWith('short-deck') ? 6 : 2;
      const used = new Set<number>();
      for (const s of t.seats) for (const c of s.holeCards || []) used.add(c.suit * 16 + c.rank);
      for (const c of t.communityCards) used.add(c.suit * 16 + c.rank);
      const pool: Card[] = [];
      for (let s = 0; s < 4; s++) for (let r = lo; r <= 14; r++) if (!used.has(s * 16 + r)) pool.push({ rank: r, suit: s } as Card);
      const rnd = lcg(1000 + k);
      const saved = t.seats.map((s) => s.holeCards);
      let replaced = 0;
      for (const s of t.seats) {
        if (s.seatIndex === me || !s.holeCards || s.holeCards.length === 0) continue;
        s.holeCards = s.holeCards.map(() => pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
        replaced++;
      }
      mark = spy.mock.calls.length;
      const d1 = steppedDecision(77 + k, () => decideAction(t, me, p));
      const a1 = argsOf(mark);
      t.seats.forEach((s, i) => { s.holeCards = saved[i]; });
      expect(replaced).toBeGreaterThan(0);
      expect([v, k, d1.action, d1.raiseAmount]).toEqual([v, k, d0.action, d0.raiseAmount]);
      expect(a1).toBe(a0);
      checks++;
    }
    expect(checks).toBeGreaterThanOrEqual(30);
    if (v === 'short-deck') expect(calls.some((c) => c[0] === '0dc1b96') && !calls.some((c) => c[0] === 'new')).toBe(true);
    if (v === 'short-deck-lane') expect(calls.some((c) => c[0] === 'new') && !calls.some((c) => c[0] === '0dc1b96')).toBe(true);
  }), 120_000);
});

describe('(2) fuzz: bot-only hands through the real executeAIAction', () => {
  it.each(['omaha', 'omaha-5', 'omaha-6', 'omaha-hi-lo', 'omaha-6-hilo', 'short-deck', 'short-deck-lane', 'pineapple', 'crazy-pineapple'])('%s: 20 hands, 0 throws, 0 stuck', (v) => laneIf(v, () => {
    const t = MK[v]();
    const bots = v.startsWith('omaha-6') ? 6 : 5;
    let throws = 0;
    const counting = (...a: any[]) => {
      try { return (decideAction as any)(...a); } catch (e) { throws++; throw e; }
    };
    const { exports } = load(fnSrc('function executeAIAction('), {
      tableManager: { getTable: () => t }, decideAction: counting, PlayerAction, GamePhase,
      allInOrFoldTables: new Set<string>(),
      broadcastGameState() {}, scheduleAIAction() {}, clearHandSnapshot: async () => {}, autoStartNextHand() {},
      pendingAutoStartTimers: new Map(), console: { log() {}, warn() {}, error() {} },
    }, 'executeAIAction');
    const exec = exports as (tableId: string, seat: number, profile: any) => void;
    const profiles = new Map<number, any>();
    for (let i = 0; i < bots; i++) {
      const p = generateRandomProfile('hard');
      profiles.set(i, p);
      expect(t.sitDown(i, `${p.botName}${i}`, t.config.minBuyIn, `ai-fz-${v}-${i}`, true)).toBe(true);
    }
    let stuck = 0, hands = 0, decisions = 0;
    for (let h = 0; h < 20; h++) {
      for (const s of t.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = t.config.minBuyIn; s.eliminated = false; }
      if (!t.startNewHand()) { stuck++; break; }
      hands++;
      let guard = 0;
      while (t.isHandInProgress() && guard++ < 400) {
        const a = t.activeSeatIndex;
        if (a < 0) { stuck++; break; }
        exec('np', a, profiles.get(a));
        decisions++;
      }
      if (guard >= 400) stuck++;
    }
    expect(hands).toBe(20);
    expect(decisions).toBeGreaterThan(20);
    expect(throws).toBe(0);
    expect(stuck).toBe(0);
  }), 120_000);
});

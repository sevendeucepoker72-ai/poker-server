/**
 * tests/botsPineappleBots.test.ts (2026-11 bots review, equity-variants B7 / C3 / C4 wired
 * into the bots; ai-core lane — the keep rule itself is botsPineappleKeep).
 *
 *   #3  a bot prices exactly the two cards the engine will keep: holdemHoleCards(hole)
 *       before the Pineapple flop, holdemHoleCards(hole, flop) on the Crazy Pineapple
 *       flop (it priced the lowest-rank pair while the engine kept the board-aware best
 *       pair: 22.4% of Crazy flops mismatched).
 *   #4  on a real Crazy Pineapple table, AhKd7s on 7c7d2s is priced as A-7 (trips), not A-K.
 *
 * The plain-Pineapple parity case also needs the engine half of the ONE keep rule
 * (PineappleTable's no-pick fallback through pineappleDiscardIndex, the equity lane's C3
 * commit): it passes once both halves are merged.
 */
import { Card } from '../src/game/Card';
import { GamePhase, PlayerAction } from '../src/game/PokerTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import * as TE from '../src/training/TrainingEngine';
import { decideAction, holdemHoleCards } from '../src/ai/AIPlayer';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const SU: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] =>
  s.trim() ? s.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] } as Card)) : [];
const key = (c: Card) => c.suit * 16 + c.rank;
const same = (a: Card[], b: Card[]) => a.map(key).sort((x, y) => x - y).join() === b.map(key).sort((x, y) => x - y).join();
/** Seeded Math.random, a frozen clock and a deterministic crypto.randomBytes (the engine's deck shuffle repeats). */
function detEnv<T>(seed: number, fn: () => T): T {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`pine-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  try { return fn(); } finally { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; }
}
const cfg = () => ({ tableId: 'p', tableName: 'p', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 } as any);
const tagHard = { botName: 'B', difficulty: 'hard', personality: 'tight', archetype: 'TAG', vpip: 0.22, pfr: 0.18, aggressionFactor: 2.75, bluffFrequency: 0.15 } as any;
function threeHanded(crazy: boolean): PineappleTable {
  const t = new PineappleTable(cfg(), crazy);
  for (let s = 0; s < 3; s++) expect(t.sitDown(s, 'P' + s, 5000, 'ai-p' + s, true)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}
function callAround(t: PineappleTable, more: () => boolean): void {
  let g = 0;
  while (more() && t.isHandInProgress() && g++ < 40) { const a = t.activeSeatIndex; if (a < 0) break; if (!t.playerCheck(a)) t.playerCall(a); }
}

describe('B7 (#3) — parity on the real engine: the pair a bot prices is the pair the engine keeps', () => {
  it('Pineapple: holdemHoleCards(hole) before the flop === the two cards held after the flop, 300 deals', () => {
    let n = 0, match = 0;
    for (let i = 0; i < 300; i++) {
      detEnv(7000 + i, () => {
        const t = threeHanded(false);
        const priced = t.seats.slice(0, 3).map((s) => holdemHoleCards(s.holeCards.slice()));
        callAround(t, () => t.currentPhase === GamePhase.PreFlop);
        if (t.communityCards.length < 3) return;
        for (let s = 0; s < 3; s++) { n++; if (same(priced[s], t.seats[s].holeCards)) match++; }
      });
    }
    expect(n).toBeGreaterThan(800);
    expect(match).toBe(n);
  }, 60_000);

  it('Crazy Pineapple: holdemHoleCards(hole, flop) on the flop === the two cards held on the turn, 300 deals (0dc1b96: 77.6%)', () => {
    let n = 0, match = 0;
    for (let i = 0; i < 300; i++) {
      detEnv(8000 + i, () => {
        const t = threeHanded(true);
        callAround(t, () => t.currentPhase === GamePhase.PreFlop);
        if (t.currentPhase !== GamePhase.Flop) return;
        const flop = t.communityCards.slice();
        const priced = t.seats.slice(0, 3).map((s) => holdemHoleCards(s.holeCards.slice(), flop));
        callAround(t, () => t.currentPhase === GamePhase.Flop);
        if (t.communityCards.length < 4) return;
        for (let s = 0; s < 3; s++) { n++; if (same(priced[s], t.seats[s].holeCards)) match++; }
      });
    }
    expect(n).toBeGreaterThan(800);
    expect(match).toBe(n);
  }, 60_000);
});

describe('B7 (#4) — a Crazy Pineapple bot on the flop prices the pair it will keep', () => {
  afterEach(() => jest.restoreAllMocks());
  /** 3-handed Crazy Pineapple called to the flop, flop 7c 7d 2s, a 300 bet, the next seat holds Ah Kd 7s. */
  function spot(): { t: PineappleTable; me: number } {
    const t = threeHanded(true);
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    t.communityCards = cs('7c 7d 2s');
    const bettor = t.activeSeatIndex;
    expect(t.playerRaise(bettor, 300)).toBe(true);
    const me = t.activeSeatIndex;
    t.seats[me].holeCards = cs('Ah Kd 7s');
    return { t, me };
  }
  it('calculateEquity sees [Ah, 7s] (0dc1b96: [Ah, Kd]); TAG raises in >= 50% of 200 seeded decisions', () => {
    const seen: string[] = [];
    const spy = jest.spyOn(TE, 'calculateEquity');
    let raises = 0;
    for (let i = 0; i < 200; i++) {
      const d = detEnv(9000 + i, () => { const { t, me } = spot(); return decideAction(t, me, tagHard); });
      if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) raises++;
    }
    for (const c of spy.mock.calls) seen.push(JSON.stringify((c[0] as Card[]).map((x) => [x.rank, x.suit])));
    expect(spy).toHaveBeenCalled();
    expect([...new Set(seen)]).toEqual([JSON.stringify(cs('Ah 7s').map((x) => [x.rank, x.suit]))]);
    expect(raises).toBeGreaterThanOrEqual(100);
  }, 120_000);
});

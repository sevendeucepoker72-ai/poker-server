/**
 * tests/fix3Hr21ShortAllInHold.test.ts (2026-11-05, bots review fix round 3: HR2-1).
 * All-In or Fold (20/40, 1,000 chips): a blind posted all-in SHORT, or an all-in for less, is not "in for the
 * bet", so the value set (JJ+, AKs, AKo) still never folds to the one real shove. On 2b5ac52 inForBet counted
 * every all-in and AKo folded 95-100% (AKs 56-92%) in these spots. Real PokerTable + real decideAction, seeded
 * with the LCG of tests/botPremiumHold.test.ts.
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { decideAction } from '../src/ai/AIPlayer';

function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}
const prof = (archetype: string, difficulty: string) =>
  ({ botName: 'B', difficulty, personality: 'tight', archetype, vpip: 0.2, pfr: 0.15, aggressionFactor: 2.5, bluffFrequency: 0.15 } as any);
let tableNo = 0;
/** 6 seats at 20/40; stacks in big blinds per seat. btn 0, sb 1, bb 2, utg 3, mp 4, co 5. */
function aof(stacks: number[]): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 20, bigBlind: 40, ante: 0, minBuyIn: 1 } as any);
  const id = tableNo++;
  stacks.forEach((bb, i) => expect(t.sitDown(i, 'P' + i, Math.round(bb * 40), `ai-hr21-${id}-${i}`, true)).toBe(true));
  expect(t.startNewHand()).toBe(true);
  return t;
}
const RC: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11 };
const hand = (c: string) => [{ rank: RC[c[0]], suit: 0 }, { rank: RC[c[1]], suit: c[2] === 's' ? 0 : 1 }] as any;
const ARCHS = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];

/** Folds of JJ / QQ / AKs / AKo per archetype (100 seeded decisions each) in the spot `build` makes. */
function folds(build: () => { t: PokerTable; me: number }, diff: string): string[] {
  const bad: string[] = [];
  for (const a of ARCHS) for (const c of ['JJ', 'QQ', 'AKs', 'AKo']) {
    const { t, me } = build();
    const restore = seedRandom(4242);
    let f = 0;
    try {
      for (let i = 0; i < 100; i++) {
        t.seats[me].holeCards = hand(c);
        if (decideAction(t, me, prof(a, diff), { allInOrFold: true }).action === PlayerAction.Fold) f++;
      }
    } finally { restore(); }
    if (f > 0) bad.push(`${a}/${diff} ${c} folds ${f}%`);
  }
  return bad;
}

describe('HR2-1 — an all-in for less in front does not turn a single shove into a multiway stack-off (All-In or Fold)', () => {
  it.each(['easy', 'medium', 'hard'])('%s: BB posted all-in for 20 (0.5 BB), UTG shoves, MP never folds JJ+/AK', (diff) => {
    expect(folds(() => {
      const t = aof([25, 25, 0.5, 25, 25, 25]);
      expect(t.seats[2].allIn).toBe(true);
      expect(t.playerAllIn(3)).toBe(true);
      return { t, me: 4 };
    }, diff)).toEqual([]);
  });
  it.each(['easy', 'medium', 'hard'])('%s: UTG shoves, MP (2 BB) all-in for less, CO never folds JJ+/AK', (diff) => {
    expect(folds(() => {
      const t = aof([25, 25, 25, 25, 2, 25]);
      expect(t.playerAllIn(3)).toBe(true);
      expect(t.playerAllIn(4)).toBe(true);
      return { t, me: 5 };
    }, diff)).toEqual([]);
  });
  it.each(['easy', 'medium', 'hard'])('%s: BB posted all-in for 20, UTG shoves, folds to the SB (closing): never folds JJ+/AK', (diff) => {
    expect(folds(() => {
      const t = aof([25, 25, 0.5, 25, 25, 25]);
      expect(t.playerAllIn(3)).toBe(true);
      for (const s of [4, 5, 0]) expect(t.playerFold(s)).toBe(true);
      return { t, me: 1 };
    }, diff)).toEqual([]);
  });
  it('control: two FULL shoves in front (UTG and MP both all-in for 25 BB) keep the disclosed multiway stack-off: AKo can fold', () => {
    // The value set holds against ONE opponent in for the bet; against two that match it, QQ / JJ / AK play the
    // stack-off line (2b5ac52 design, unchanged). Pins that the fix counts players who MATCH the bet, not none.
    const { t, me } = (() => {
      const tt = aof([25, 25, 25, 25, 25, 25]);
      expect(tt.playerAllIn(3)).toBe(true);
      expect(tt.playerAllIn(4)).toBe(true);
      return { t: tt, me: 5 };
    })();
    const restore = seedRandom(4242);
    let f = 0;
    try {
      for (let i = 0; i < 100; i++) {
        t.seats[me].holeCards = hand('AKo');
        if (decideAction(t, me, prof('TAG', 'hard'), { allInOrFold: true }).action === PlayerAction.Fold) f++;
      }
    } finally { restore(); }
    expect(f).toBeGreaterThan(0);
  });
});

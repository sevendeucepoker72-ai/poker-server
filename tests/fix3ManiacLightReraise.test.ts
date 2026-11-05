/**
 * tests/fix3ManiacLightReraise.test.ts (2026-11-05, bots review fix round 3: MANIAC-RTF, node level).
 * No-limit Hold'em: a MANIAC re-raise by a hand that fails the stack-off range is made only up to
 * HOLDEM_LIGHT_RERAISE_FRACTION (5%) of the street stack; larger, it calls (top 70%) or folds. On 2b5ac52 it
 * re-raised ~93% of hands to 2.5-4x the bet (25-59 BB over a 10 BB open) and then folded ~89% of them to a
 * shove (the round-1 stack-off gate). Real PokerTable + real decideAction, seeded Math.random (the LCG of
 * tests/botPremiumHold.test.ts). The bounds below are literal chip counts, so raising the constant fails them.
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { decideAction } from '../src/ai/AIPlayer';
import * as AI from '../src/ai/AIPlayer';
import { getStackOffPercentile } from '../src/ai/preflopRanges';

function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'aggressive', archetype, vpip: 0.6, pfr: 0.5, aggressionFactor: 5, bluffFrequency: 0.4 } as any);
let tableNo = 0;
/** 6 seats at 50/100, every stack `bb` big blinds: btn 0, sb 1, bb 2, utg 3, mp 4, co 5. UTG (a human) opens to `open` BB, folds to the big blind. */
function bbFacingOpen(open: number, bb = 100): { t: PokerTable; me: number } {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, bb * 100, (i === 3 ? 'human-mlr-' : 'ai-mlr-') + id + '-' + i, i !== 3)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  expect(t.playerRaise(3, open * 100)).toBe(true);
  for (const s of [4, 5, 0, 1]) expect(t.playerFold(s)).toBe(true);
  expect(t.activeSeatIndex).toBe(2);
  return { t, me: 2 };
}
/** n seeded random hands for `me` that are not dealt elsewhere at the table, with their raw stack-off percentile. */
function* hands(t: PokerTable, me: number, n: number): Generator<number> {
  const used = new Set<number>();
  for (const s of t.seats) if (s.seatIndex !== me) for (const c of s.holeCards) used.add(c.rank * 4 + c.suit);
  for (let k = 0; k < n; k++) {
    let a = 0, b = 0;
    do { a = Math.floor(Math.random() * 52); b = Math.floor(Math.random() * 52); }
    while (a === b || used.has((2 + (a % 13)) * 4 + Math.floor(a / 13)) || used.has((2 + (b % 13)) * 4 + Math.floor(b / 13)));
    t.seats[me].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }] as any;
    yield getStackOffPercentile(t.seats[me].holeCards);
  }
}

describe('MANIAC-RTF — a MANIAC light re-raise stays within 5% of the stack (no-limit Hold\'em)', () => {
  it('the constant is 5% of the street stack', () => {
    expect(AI.HOLDEM_LIGHT_RERAISE_FRACTION).toBe(0.05);
  });

  it('100 BB, facing a 2 / 2.5 / 3 / 4 / 6 / 10 / 15 / 20 / 30 BB open: a hand under the stack-off range (raw stack-off pct < 0.75) never re-raises to more than 5 BB without moving in, at every difficulty', () => {
    const bad: string[] = [];
    for (const diff of ['easy', 'medium', 'hard', 'expert']) for (const open of [2, 2.5, 3, 4, 6, 10, 15, 20, 30]) {
      const { t, me } = bbFacingOpen(open);
      const restore = seedRandom(4242);
      let weak = 0, big = 0, calls = 0;
      try {
        for (const so of hands(t, me, 300)) {
          if (so >= 0.75) continue;
          weak++;
          const d = decideAction(t, me, prof('MANIAC', diff));
          if (d.action === PlayerAction.Raise && d.raiseAmount > 500) big++;
          if (d.action === PlayerAction.Call) calls++;
        }
      } finally { restore(); }
      if (big > 0) bad.push(`${diff} open ${open} BB: ${big}/${weak} weak hands re-raised above 5 BB`);
      // ... and it still plays: the weak hands it does not re-raise are called (top 70%), not folded wholesale.
      if (calls === 0) bad.push(`${diff} open ${open} BB: no calls`);
    }
    expect(bad).toEqual([]);
  });

  it('200 BB deep, facing a 3 BB open: it still re-raises light (2.5-4x the open, kept when at most 10 BB, 5% of 200 BB) with a third of hands or more', () => {
    const { t, me } = bbFacingOpen(3, 200);
    const restore = seedRandom(4242);
    let weak = 0, light = 0, above = 0;
    try {
      for (const so of hands(t, me, 400)) {
        if (so >= 0.75) continue;
        weak++;
        const d = decideAction(t, me, prof('MANIAC', 'hard'));
        if (d.action === PlayerAction.Raise) { light++; if (d.raiseAmount > 1000) above++; }
      }
    } finally { restore(); }
    expect(above).toBe(0);
    expect(light / weak).toBeGreaterThan(0.3);
  });

  it('it stays a maniac where the rule does not bind: first in at 100 BB it opens >= 85% of hands, and it still re-raises its stack-off hands', () => {
    // CO first in (UTG / MP fold): every MANIAC open is 2.5-4 BB, within any cap.
    const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
    for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 10000, 'ai-mlr-open-' + i, true)).toBe(true);
    expect(t.startNewHand()).toBe(true);
    for (const s of [3, 4]) expect(t.playerFold(s)).toBe(true);
    const restore = seedRandom(4242);
    let n = 0, opens = 0;
    try {
      for (const _ of hands(t, 5, 400)) { n++; if (decideAction(t, 5, prof('MANIAC')).action === PlayerAction.Raise) opens++; }
    } finally { restore(); }
    expect(opens / n).toBeGreaterThanOrEqual(0.85);
    // AA facing a 10 BB open: a re-raise (or a jam), never a call / fold.
    const { t: t2, me } = bbFacingOpen(10);
    t2.seats[me].holeCards = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }] as any;
    const r2 = seedRandom(4242);
    try {
      for (let k = 0; k < 50; k++) expect([PlayerAction.Raise, PlayerAction.AllIn]).toContain(decideAction(t2, me, prof('MANIAC')).action);
    } finally { r2(); }
  });
});

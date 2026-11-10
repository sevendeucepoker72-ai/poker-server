/**
 * tests/fix3ManiacLightReraise.test.ts (2026-11-05, bots review fix round 3: MANIAC-RTF, node level).
 * Round 3 capped a MANIAC light re-raise at HOLDEM_LIGHT_RERAISE_FRACTION (5%) of the street stack (round 4: of the depth
 * at risk) and this file pinned that cap. Fix-up 5 (2026-11-10, THE MANIAC CLASS) removed it, so this file now pins what
 * replaced it: facing a raise, a MANIAC plays 0dc1b96's MANIAC (maniacFacingRaise0dc1b96). It re-raises ~93% of hands to
 * 2.5-4x the bet (all-in from 70% of its stack) and folds the rest; it never flat-calls a raise. With the cap the MANIACs
 * flat-called each other and the human, and limping or flat-calling any two then moving in on the flop with a pair or a
 * draw won +215 to +379 BB/100 (live 0dc1b96 -83 to -100). The raise-then-fold the cap was for (2b5ac52: ~89% of the
 * re-raises folded to a shove) does not come back: after its own raise it continues as 0dc1b96 does
 * (tests/fix3ManiacRaisedStackoff.test.ts). Real PokerTable + real decideAction, seeded Math.random.
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

describe('fix-up 5 — a MANIAC facing a raise re-raises light again, as 0dc1b96 (no-limit Hold\'em)', () => {
  it('the light re-raise cap is gone (HOLDEM_LIGHT_RERAISE_FRACTION removed with the rule)', () => {
    expect((AI as any).HOLDEM_LIGHT_RERAISE_FRACTION).toBeUndefined();
  });

  it('100 BB, facing a 2 / 2.5 / 3 / 4 / 6 / 10 / 15 / 20 / 30 BB open: it re-raises 85-100% of hands (to 2.5-4x the open, all-in from 70% of its stack), never flat-calls, at every difficulty', () => {
    const bad: string[] = [];
    for (const diff of ['easy', 'medium', 'hard', 'expert']) for (const open of [2, 2.5, 3, 4, 6, 10, 15, 20, 30]) {
      const { t, me } = bbFacingOpen(open);
      const restore = seedRandom(4242);
      let n = 0, raises = 0, calls = 0, offSize = 0;
      try {
        for (const _ of hands(t, me, 300)) {
          n++;
          const d = decideAction(t, me, prof('MANIAC', diff));
          if (d.action === PlayerAction.Call) calls++;
          if (d.action === PlayerAction.AllIn) raises++;
          if (d.action === PlayerAction.Raise) {
            raises++;
            const to = d.raiseAmount;
            if (to < Math.max(t.getMinRaise(), 2.5 * open * 100 - 1) || to > 4 * open * 100 + 1 || to >= 0.7 * t.seats[me].chipCount) offSize++;
          }
        }
      } finally { restore(); }
      if (raises / n < 0.85) bad.push(`${diff} open ${open} BB: re-raised ${raises}/${n}`);
      if (calls > 0) bad.push(`${diff} open ${open} BB: ${calls} flat calls`);
      if (offSize > 0) bad.push(`${diff} open ${open} BB: ${offSize} re-raises off 2.5-4x`);
    }
    expect(bad).toEqual([]);
  });

  it('200 BB deep, facing a 3 BB open: it re-raises >= 85% of hands to 7.5-12 BB', () => {
    const { t, me } = bbFacingOpen(3, 200);
    const restore = seedRandom(4242);
    let n = 0, light = 0;
    try {
      for (const _ of hands(t, me, 400)) {
        n++;
        const d = decideAction(t, me, prof('MANIAC', 'hard'));
        if (d.action === PlayerAction.Raise && d.raiseAmount >= 750 && d.raiseAmount <= 1200) light++;
      }
    } finally { restore(); }
    expect(light / n).toBeGreaterThanOrEqual(0.85);
  });

  it('first in at 100 BB it opens >= 85% of hands, and AA facing a 10 BB open re-raises or moves in (never calls or folds)', () => {
    // CO first in (UTG / MP fold): every MANIAC open is 2.5-5 BB.
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
    const { t: t2, me } = bbFacingOpen(10);
    t2.seats[me].holeCards = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }] as any;
    const r2 = seedRandom(4242);
    try {
      for (let k = 0; k < 50; k++) expect([PlayerAction.Raise, PlayerAction.AllIn]).toContain(decideAction(t2, me, prof('MANIAC')).action);
    } finally { r2(); }
  });
});

/**
 * tests/fix4NitStealSize.test.ts (2026-11-08, bots review fix round 4: NIT steal size, node level).
 * No-limit Hold'em. B4 narrows every call range facing a raise in proportion to the open size
 * (OPEN_REFERENCE_BB / open). A NIT only flats its 3-bet range (the top ~6-9%), so narrowed in proportion it
 * continued 5.6% against a 4-6 BB open, where live 0dc1b96 continued 6.2-9.0% at every size (the same as vs
 * 2.5-3 BB). Opening 4-6 BB with any two and folding to a re-raise then won +20 to +34 BB/100 against five NITs
 * (live -6 to +21). Fix round 4: a NIT's flat range narrows only past NIT_SIZE_NARROW_SLACK (2) x the reference
 * open (6 BB) and reaches the SIZE_NARROW_MAX_TH floor by ~10 BB as before, so B4's 15 / 60 BB rows are unchanged.
 * Every one of the 1,326 starting hands is decided once per size, with the same seeded noise stream per size
 * (the LCG of tests/botPremiumHold.test.ts), on a real PokerTable through the real decideAction.
 * 25 BB and shallower (the push/fold zone's depth): fix-up 6 removed B4's narrowing there for every archetype (last test).
 * 6 seats at 50/100, 100 BB unless stated: btn 0, sb 1, bb 2, utg 3, mp 4, co 5. The human opens.
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { decideAction, NIT_SIZE_NARROW_SLACK, OPEN_REFERENCE_BB } from '../src/ai/AIPlayer';

function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}
const prof = (difficulty: string) =>
  ({ botName: 'B', difficulty, personality: 'tight', archetype: 'NIT', vpip: 0.1, pfr: 0.08, aggressionFactor: 1.5, bluffFrequency: 0.02 } as any);
const BB = 100;
let tableNo = 0;
/** spot 'mp': the human opens UTG, MP decides. spot 'bb': folded to the human on the button, he opens, the SB folds, the BB decides. */
function build(spot: 'mp' | 'bb', openBB: number, depthBB: number): { t: PokerTable; me: number } {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const human = spot === 'mp' ? 3 : 0;
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, depthBB * BB, (i === human ? 'player-nss-' : 'ai-nss-') + id + '-' + i, i !== human)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  if (spot === 'mp') {
    expect(t.playerRaise(3, openBB * BB)).toBe(true);
    return { t, me: 4 };
  }
  for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
  expect(t.playerRaise(0, openBB * BB)).toBe(true);
  expect(t.playerFold(1)).toBe(true);
  return { t, me: 2 };
}
/** Share (%) of the 1,326 starting hands with which the NIT does not fold. */
function contPct(spot: 'mp' | 'bb', openBB: number, difficulty: string, depthBB = 100): number {
  const { t, me } = build(spot, openBB, depthBB);
  expect(t.activeSeatIndex).toBe(me);
  let n = 0, c = 0;
  const restore = seedRandom(9091);
  try {
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) {
      // pre-flop the bot reads only its own two cards
      t.seats[me].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }] as any;
      n++;
      if (decideAction(t, me, prof(difficulty)).action !== PlayerAction.Fold) c++;
    }
  } finally { restore(); }
  return (100 * c) / n;
}

describe('NIT steal size (fix round 4) — a NIT does not over-fold to a 4-6 BB open', () => {
  it('the slack is 2 x the 3 BB reference open', () => {
    expect([NIT_SIZE_NARROW_SLACK, OPEN_REFERENCE_BB]).toEqual([2, 3]);
  });

  it('MP vs a UTG open and the BB vs a button open, hard and medium: it continues as often against 4 / 5 / 6 BB as against 3 BB (0bc7529: 5.9-7.3% vs 6.6-9.0%)', () => {
    const bad: string[] = [];
    for (const spot of ['mp', 'bb'] as const) for (const diff of ['hard', 'medium']) {
      const ref = contPct(spot, 3, diff);
      for (const x of [4, 5, 6]) { const v = contPct(spot, x, diff); if (v !== ref) bad.push(`${spot} ${diff} ${x} BB: ${v.toFixed(1)}% vs ${ref.toFixed(1)}% at 3 BB`); }
    }
    expect(bad).toEqual([]);
  });

  it('B4 still narrows a big open: the BB vs a 15 BB button open continues <= 6.5% (vs 2.5 BB: >= 8%)', () => {
    for (const diff of ['hard', 'medium']) {
      expect(contPct('bb', 2.5, diff)).toBeGreaterThanOrEqual(8);
      expect(contPct('bb', 15, diff)).toBeLessThanOrEqual(6.5);
    }
  });

  // Fix-up 6 (2026-11-10, sweep: short-stack steals): at 25 BB and shallower B4 narrows nothing any more, for every archetype
  // (0dc1b96's unsized ranges; the big blind still widens against a small raise). Narrowed, the big blind folded a third more
  // to a 4-6 BB open, and an any-two 4-6 BB steal won +19 to +42 BB/100 at Spin & Go 25 BB and 20 BB six-max NIT / ROCK
  // tables (live -40 to +15). This row pinned the old narrowing at 20 BB ("unchanged" by fix round 4); it now pins its removal.
  it('fix-up 6: 25 BB and shallower narrow nothing: at 20 BB the big blind continues as often against a 4 / 5 / 6 BB open as against 3 BB', () => {
    for (const diff of ['hard', 'medium']) for (const x of [4, 5, 6]) expect(contPct('bb', x, diff, 20)).toBe(contPct('bb', 3, diff, 20));
  });
});

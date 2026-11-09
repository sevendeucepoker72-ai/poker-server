/**
 * tests/fix4ManiacDepthAtRisk.test.ts (2026-11-08, bots review fix round 4: HOLDEM-R3-REG-1, node level).
 * No-limit Hold'em: a MANIAC light re-raise (a hand that fails the stack-off range) is capped at
 * HOLDEM_LIGHT_RERAISE_FRACTION (5%) of the DEPTH AT RISK: the smallest street stack that can still shove over it
 * (its own, and every live opponent's with chips: the raiser, the callers, the players to act). Round 3
 * (0bc7529) capped it at 5% of the MANIAC's OWN stack. Bots have no stack cap and only grow, while a human buys
 * in for at most 100 BB: a 200-1,000 BB MANIAC re-raised a 100 BB opener light again (~93% of hands, to 8-33 BB)
 * and folded ~78% of those re-raises to his 100 BB shove. The spots below pin the basis: the MANIAC's own stack
 * fails them all, the largest opponent's stack (a review candidate) fails the second deep stack, the raisers'
 * stacks only fail the cold 4-bet shove from a player still to act, and a folded short stack does not bind.
 * Real PokerTable + real decideAction, seeded Math.random (the LCG of tests/botPremiumHold.test.ts) AND a seeded
 * deck: PokerTable deals the other seats from crypto.randomBytes, and deal() rejection-samples against those
 * cards, so an unseeded deck changed the MANIAC's hands run to run (fixup 1 of round 4: test 1 failed ~1 run in
 * 11 on an unchanged tree). The re-raise bound is 25% (the head re-raises ~10-17%, 0bc7529 50-94%); the fold
 * bound (<= 10% of the re-raises; 0bc7529 77-81%) is the pin.
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { decideAction } from '../src/ai/AIPlayer';
import { getStackOffPercentile } from '../src/ai/preflopRanges';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
/** Seeded Math.random AND a seeded deck (crypto.randomBytes, the sha256 stream of tests/fix4ManiacDeepFullLine). */
function seedRandom(seed: number): () => void {
  const orig = Math.random, rb = nodeCrypto.randomBytes;
  let s = seed >>> 0, ctr = 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  nodeCrypto.randomBytes = (n: number) => {
    let buf = Buffer.alloc(0);
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix4-mdr-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; };
}
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'aggressive', archetype, vpip: 0.6, pfr: 0.5, aggressionFactor: 5, bluffFrequency: 0.4 } as any);
const BB = 100;
let tableNo = 0;
/** 6 seats at 50/100 (btn 0, sb 1, bb 2, utg 3, mp 4, co 5) with the given stacks in BB; `human` is the human seat. */
function table(stacksBB: number[], human: number): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacksBB[i] * BB, (i === human ? 'player-mdr-' : 'ai-mdr-') + id + '-' + i, i !== human)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}
/** A random hand for `me` that is not dealt elsewhere at the table. */
function deal(t: PokerTable, me: number): void {
  const used = new Set<number>();
  for (const s of t.seats) if (s.seatIndex !== me) for (const c of s.holeCards) used.add(c.rank * 4 + c.suit);
  let a = 0, b = 0;
  do { a = Math.floor(Math.random() * 52); b = Math.floor(Math.random() * 52); }
  while (a === b || used.has((2 + (a % 13)) * 4 + Math.floor(a / 13)) || used.has((2 + (b % 13)) * 4 + Math.floor(b / 13)));
  t.seats[me].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }] as any;
}
interface Spot {
  /** A fresh table at the MANIAC's decision. */
  build: () => PokerTable;
  maniac: number;
  /** After a MANIAC re-raise: the other seats' actions, then the 100 BB shove the MANIAC then faces. */
  shoveBack: (t: PokerTable) => void;
}
/** Over n random hands: the MANIAC's non-all-in re-raises, and how many of them it then folded to the shove. */
function run(spot: Spot, n: number, difficulty = 'hard'): { n: number; reraises: number; folds: number } {
  let reraises = 0, folds = 0;
  const restore = seedRandom(4242);
  try {
    for (let k = 0; k < n; k++) {
      const t = spot.build();
      deal(t, spot.maniac);
      const d = decideAction(t, spot.maniac, prof('MANIAC', difficulty));
      if (d.action !== PlayerAction.Raise) continue;
      reraises++;
      expect(t.playerRaise(spot.maniac, d.raiseAmount)).toBe(true);
      spot.shoveBack(t);
      expect(t.activeSeatIndex).toBe(spot.maniac);
      if (decideAction(t, spot.maniac, prof('MANIAC', difficulty)).action === PlayerAction.Fold) folds++;
    }
  } finally { restore(); }
  return { n, reraises, folds };
}

describe('HOLDEM-R3-REG-1 — a MANIAC light re-raise is capped at 5% of the depth at risk, not of its own stack', () => {
  it('a 200 / 300 / 500 / 1,000 BB MANIAC in the big blind vs a 100 BB human\'s button open (2.5 / 3 / 6 / 10 BB): it re-raises like a 100 BB MANIAC (<= 25%), and folds at most 10% of those re-raises to the human\'s 100 BB shove (difficulty noise; 0bc7529 folded ~78%)', () => {
    const bad: string[] = [];
    for (const [deep, open] of [[200, 2.5], [300, 3], [500, 6], [1000, 10]]) for (const diff of ['medium', 'hard']) {
      // UTG / MP / CO (100 BB bots) fold, the human on the button opens, the small blind folds; the MANIAC decides.
      const spot: Spot = {
        build: () => {
          const t = table([100, 100, deep, 100, 100, 100], 0);
          for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
          expect(t.playerRaise(0, open * BB)).toBe(true);
          expect(t.playerFold(1)).toBe(true);
          return t;
        },
        maniac: 2,
        shoveBack: (t) => { expect(t.playerAllIn(0)).toBe(true); },
      };
      const r = run(spot, 300, diff);
      if (r.reraises > 0.25 * r.n || r.folds > 0.1 * r.reraises) bad.push(`${diff} ${deep} BB vs open ${open}: re-raised ${r.reraises}/${r.n}, folded ${r.folds} of them to the shove`);
    }
    expect(bad).toEqual([]);
  });

  it('a second deep stack still to act does not lift the cap (the largest opponent\'s stack would): a 500 BB MANIAC on the cutoff vs a 100 BB human\'s UTG open, the blinds and the button at 500 BB', () => {
    const spot: Spot = {
      build: () => {
        const t = table([500, 500, 500, 100, 100, 500], 3);
        expect(t.playerRaise(3, 3 * BB)).toBe(true);
        expect(t.playerFold(4)).toBe(true);
        return t;
      },
      maniac: 5,
      shoveBack: (t) => { for (const s of [0, 1, 2]) expect(t.playerFold(s)).toBe(true); expect(t.playerAllIn(3)).toBe(true); },
    };
    const r = run(spot, 400);
    expect(r.folds).toBeLessThanOrEqual(0.1 * r.reraises);
    expect(r.reraises).toBeLessThanOrEqual(0.25 * r.n);
  });

  it('a short player still to act binds (the raisers\' stacks alone would not): a 500 BB LAG opens UTG, the 500 BB MANIAC on the cutoff decides, a 100 BB human in the big blind can cold-shove', () => {
    const spot: Spot = {
      build: () => {
        const t = table([500, 500, 100, 500, 100, 500], 2);
        expect(t.playerRaise(3, 3 * BB)).toBe(true);   // the deep LAG's open
        expect(t.playerFold(4)).toBe(true);
        return t;
      },
      maniac: 5,
      // the button and the small blind fold, the human cold 4-bet-shoves 100 BB, the opener folds.
      shoveBack: (t) => { for (const s of [0, 1]) expect(t.playerFold(s)).toBe(true); expect(t.playerAllIn(2)).toBe(true); expect(t.playerFold(3)).toBe(true); },
    };
    const r = run(spot, 400);
    expect(r.folds).toBeLessThanOrEqual(0.1 * r.reraises);
    expect(r.reraises).toBeLessThanOrEqual(0.25 * r.n);
  });

  it('only LIVE opponents count: with everyone at the table 1,000 BB deep and a 100 BB player folded, a MANIAC still re-raises light (up to 50 BB, 5% of 1,000 BB) with a third of its weak hands or more', () => {
    const restore = seedRandom(4242);   // before the table: its deck is dealt from the seeded stream too
    let weak = 0, light = 0, above = 0;
    try {
      const t = table([1000, 1000, 1000, 1000, 100, 1000], 3);
      expect(t.playerRaise(3, 3 * BB)).toBe(true);
      expect(t.playerFold(4)).toBe(true);   // the 100 BB player
      for (let k = 0; k < 400; k++) {
        deal(t, 5);
        if (getStackOffPercentile(t.seats[5].holeCards) >= 0.75) continue;
        weak++;
        const d = decideAction(t, 5, prof('MANIAC'));
        if (d.action === PlayerAction.Raise) { light++; if (d.raiseAmount > 50 * BB) above++; }
      }
    } finally { restore(); }
    expect(above).toBe(0);
    expect(light / weak).toBeGreaterThan(0.3);
  });
});

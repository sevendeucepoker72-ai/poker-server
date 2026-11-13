/**
 * tests/botPremiumHold.test.ts (2026-11-05, bots review fix round 2: HAI-1, HAI-2, HAI-3, HAI-4 and the
 * easy / medium premium limps).
 * Real PokerTable + real decideAction, seeded Math.random (the LCG of tests/botPreflopFixes.test.ts), at the
 * difficulties the live formats seat: cash tables 'hard', career / Spin & Go / All-In or Fold 'easy', 'medium'
 * and 'hard' (expert where it is cheap). Every block fails on d1ec56a (fix round 1) and passes with the fix.
 * The fix round 3 blocks (end of file) also pin each round-2/3 mechanism on its own: reverting only the
 * multiway cap, the size floor, its taper or the All-In or Fold archetype damping fails at least one of them.
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { decideAction } from '../src/ai/AIPlayer';
import * as AI from '../src/ai/AIPlayer';
import * as PR from '../src/ai/preflopRanges';
import { PREFLOP_TABLE } from '../src/ai/preflopTable';
import * as PF from '../src/ai/pushFoldSolver';

const BB = 100;
function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'tight', archetype, vpip: 0.2, pfr: 0.15, aggressionFactor: 2.5, bluffFrequency: 0.15 } as any);
type Spot = () => { t: PokerTable; me: number };
let tableNo = 0;
/** n seats, every stack `stacks` BB (or per seat); hand started. 6-handed: btn 0, sb 1, bb 2, utg 3, mp 4, co 5. */
function mk(n: number, stacks: number | number[] = 100, sb = 50, bb = BB): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: 100 } as any);
  const id = tableNo++;
  for (let i = 0; i < n; i++) expect(t.sitDown(i, 'P' + i, (Array.isArray(stacks) ? stacks[i] : stacks) * bb, `ai-h${id}-${i}`, true)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}
/** The All-In or Fold table: 6 seats, 20/40, 1,000 chips (25 BB). */
const aof = (): PokerTable => mk(6, 25, 20, 40);
const RC: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const hand = (code: string) => [{ rank: RC[code[0]] ?? +code[0], suit: 0 }, { rank: RC[code[1]] ?? +code[1], suit: code[2] === 's' ? 0 : 1 }] as any;
function randHand(): any {
  const a = Math.floor(Math.random() * 52); let b = Math.floor(Math.random() * 51); if (b >= a) b++;
  return [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }];
}
/**
 * Share of `n` seeded decisions (random hands unless `code`) for which `pred` holds. The spot is built
 * once: decideAction only reads the table (only the bot's hole cards change between decisions).
 */
function rate(build: Spot, p: any, pred: (d: any) => boolean, n: number, code?: string, opts = {}): number {
  const { t, me } = build();
  const restore = seedRandom(4242);
  try {
    let k = 0;
    for (let i = 0; i < n; i++) {
      t.seats[me].holeCards = code ? hand(code) : randHand();
      if (pred(decideAction(t, me, p, opts))) k++;
    }
    return k / n;
  } finally { restore(); }
}
const isFold = (d: any) => d.action === PlayerAction.Fold;
const cont = (d: any) => d.action !== PlayerAction.Fold;
const ARCHS = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const AOF = { allInOrFold: true };

/** Every [spot label, archetype, hand] whose fold rate is not 0 (an empty list passes). */
function premiumFolds(spots: Array<[string, Spot, any?]>, diff: string, codes: string[], archs = ARCHS, n = 150): string[] {
  const bad: string[] = [];
  for (const [label, build, opts] of spots) for (const a of archs) for (const c of codes) {
    const r = rate(build, prof(a, diff), isFold, n, c, opts || {});
    if (r > 0) bad.push(`${label} | ${a}/${diff} ${c} folds ${(100 * r).toFixed(1)}%`);
  }
  return bad;
}
/** The first seat to act shoves; the next seat decides. */
const utgShove = (n: number, bb: number): Spot => () => {
  const t = mk(n, bb); expect(t.playerAllIn(t.activeSeatIndex)).toBe(true); return { t, me: t.activeSeatIndex };
};

describe('HAI-1 — AA and KK never fold pre-flop (judged before the difficulty noise)', () => {
  const spots: Array<[string, Spot]> = [
    ['6-max 100 BB, UTG all-in, MP decides (4 behind)', utgShove(6, 100)],
    ['9-max 100 BB, UTG all-in, UTG+1 decides (7 behind)', utgShove(9, 100)],
    ['5-handed 100 BB (the cash fill), UTG all-in', utgShove(5, 100)],
    ['6-max 22 BB, UTG all-in', utgShove(6, 22)],
    ['9-max 12 BB, UTG all-in', utgShove(9, 12)],
    ['6-max 100 BB, UTG raises to 40 BB (not all-in), MP decides', () => { const t = mk(6); expect(t.playerRaise(3, 4000)).toBe(true); return { t, me: 4 }; }],
    ['6-max 100 BB, a lone UTG shove, BB closes', () => { const t = mk(6); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; }],
    ['6-max 100 BB, UTG all-in, MP and CO call all-in, BB closes', () => {
      const t = mk(6); t.playerAllIn(3); t.playerAllIn(4); t.playerAllIn(5); t.playerFold(0); t.playerFold(1); return { t, me: 2 };
    }],
  ];
  it.each(DIFFS)('%s: 0 AA / KK folds in 8 shove and commit spots, every archetype', (diff) => {
    expect(premiumFolds(spots, diff, ['AA', 'KK'])).toEqual([]);
  });

  it.each(DIFFS)('All-In or Fold (20/40, 1,000 chips), %s: AA / KK never fold, and always shove unopened', (diff) => {
    const spotsAof: Array<[string, Spot, any]> = [
      ['UTG shove, MP decides (4 others live)', () => { const t = aof(); t.playerAllIn(3); return { t, me: 4 }; }, AOF],
      ['UTG shove, CO decides', () => { const t = aof(); t.playerAllIn(3); t.playerFold(4); return { t, me: 5 }; }, AOF],
      ['UTG shove, folds to the BB (closing)', () => { const t = aof(); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; }, AOF],
      ['UTG, MP and CO all-in, BB closes', () => { const t = aof(); t.playerAllIn(3); t.playerAllIn(4); t.playerAllIn(5); t.playerFold(0); t.playerFold(1); return { t, me: 2 }; }, AOF],
      ['UTG unopened (5 behind)', () => ({ t: aof(), me: 3 }), AOF],
    ];
    expect(premiumFolds(spotsAof, diff, ['AA', 'KK'])).toEqual([]);
    for (const a of ARCHS) for (const c of ['AA', 'KK']) {
      expect([a, c, rate(() => ({ t: aof(), me: 3 }), prof(a, diff), (d) => d.action === PlayerAction.AllIn, 150, c, AOF)]).toEqual([a, c, 1]);
    }
  });

  it('the stack-off premium set is exactly AA and KK (12 combos)', () => {
    const th = (PR as any).PREMIUM_STACKOFF_THRESHOLD;
    const set = PREFLOP_TABLE.filter((r) => r[3] >= th).map((r) => r[0]).sort();
    expect(set).toEqual(['AA', 'KK']);
    expect(PREFLOP_TABLE.filter((r) => r[3] >= th).reduce((s, r) => s + r[1], 0)).toBe(12);
  });
});

describe('HAI-1 / HAI-2 — the value set (JJ+, AKs, AKo) never folds to a single bet', () => {
  /** The bot (BTN) opened 2.5 BB; the BB 3-bets to `to`. */
  const facing3bet = (to: number, allIn = false): Spot => () => {
    const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s);
    expect(t.playerRaise(0, 250)).toBe(true); t.playerFold(1);
    expect(allIn ? t.playerAllIn(2) : t.playerRaise(2, to)).toBe(true);
    return { t, me: 0 };
  };
  /** The BTN opened 2.5 BB; the bot (BB) 3-bet to 10 BB; the BTN 4-bets to `to` (or all-in). */
  const facing4bet = (to: number, allIn = false): Spot => () => {
    const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s);
    expect(t.playerRaise(0, 250)).toBe(true); t.playerFold(1);
    expect(t.playerRaise(2, 1000)).toBe(true);
    expect(allIn ? t.playerAllIn(0) : t.playerRaise(0, to)).toBe(true);
    return { t, me: 2 };
  };
  /** UTG opens to `sz` BB (below the 1/3-of-stack commit line); MP, or the BB folded to, decides. */
  const open = (sz: number, bbSeat: boolean): Spot => () => {
    const t = mk(6); expect(t.playerRaise(3, sz * BB)).toBe(true);
    if (bbSeat) for (const s of [4, 5, 0, 1]) t.playerFold(s);
    const me = bbSeat ? 2 : 4;
    expect(t.getCallAmount(t.seats[me])).toBeLessThan(t.seats[me].chipCount / 3);
    return { t, me };
  };
  const spots: Array<[string, Spot, any?]> = [
    ['6-max 100 BB, UTG all-in, MP decides', utgShove(6, 100)],
    ['9-max 100 BB, UTG all-in, UTG+1 decides', utgShove(9, 100)],
    ['6-max 22 BB, UTG all-in, MP decides', utgShove(6, 22)],
    ...[15, 20, 25, 30, 33].map((sz): [string, Spot] => [`UTG opens ${sz} BB, MP decides`, open(sz, false)]),
    ...[15, 25, 33].map((sz): [string, Spot] => [`UTG opens ${sz} BB, folds to the BB`, open(sz, true)]),
    ['BTN opener vs a 10 BB 3-bet', facing3bet(1000)],
    ['BTN opener vs a 3-bet all-in', facing3bet(0, true)],
    ['BB 3-bettor vs a 25 BB 4-bet', facing4bet(2500)],
    ['BB 3-bettor vs a 4-bet all-in', facing4bet(0, true)],
    ['All-In or Fold: UTG shove, MP decides', () => { const t = aof(); t.playerAllIn(3); return { t, me: 4 }; }, AOF],
    ['All-In or Fold: UTG shove, BB closes', () => { const t = aof(); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; }, AOF],
  ];
  it.each(['easy', 'medium', 'hard'])('%s: JJ, QQ, AKs and AKo never fold in 16 single-bet spots, NIT included', (diff) => {
    expect(premiumFolds(spots, diff, ['JJ', 'QQ', 'AKs', 'AKo'], ARCHS, 100)).toEqual([]);
  });

  it('HAI-2: vs big opens that do not commit the stack, a hard TAG MP still folds K9o / QTo and continues <= 8% (B4 kept)', () => {
    // The premium part fails on d1ec56a (TAG/hard MP folded AA 22.5% to a 30 BB open); the B4 bounds pin the narrowing.
    for (const sz of [15, 20, 25, 30, 33]) {
      expect(rate(open(sz, false), prof('TAG'), isFold, 200, 'AA')).toBe(0);
      expect(rate(open(sz, false), prof('TAG'), isFold, 200, 'KK')).toBe(0);
      expect(rate(open(sz, false), prof('TAG'), cont, 1500)).toBeLessThanOrEqual(0.08);
      for (const c of ['K9o', 'QTo']) expect(rate(open(sz, false), prof('TAG'), cont, 50, c)).toBe(0);
    }
  });
});

describe('HAI-1 — the continue range is monotone in depth (10-40 BB)', () => {
  it.each([[6, 'TAG', 'hard'], [6, 'TAG', 'medium'], [6, 'NIT', 'hard'], [9, 'TAG', 'hard']])(
    '%s-max %s/%s vs a UTG shove: never wider deeper; 20-25 BB never narrower than 26 BB', (n, a, d) => {
      const depths = Array.from({ length: 31 }, (_, i) => 10 + i);
      const r = depths.map((bb) => rate(utgShove(n as number, bb), prof(a as string, d as string), cont, 1500));
      for (let i = 1; i < r.length; i++) expect([depths[i], r[i] - r[i - 1] <= 0.005]).toEqual([depths[i], true]);
      expect(Math.min(...r.slice(10, 16))).toBeGreaterThanOrEqual(r[16]);   // 20-25 BB vs 26 BB
    });
});

describe('HAI-3 — the micro-call floor is per opponent in the pot', () => {
  const closes: Array<[string, Spot, any?]> = [
    ['6-max 100 BB: UTG all-in, MP and CO call all-in, BB closes', () => {
      const t = mk(6); t.playerAllIn(3); t.playerAllIn(4); t.playerAllIn(5); t.playerFold(0); t.playerFold(1); return { t, me: 2 };
    }],
    ['6-max: UTG all-in 100 BB, MP and CO (200 BB) call, BB closes', () => {
      const t = mk(6, [100, 100, 100, 100, 200, 200]); t.playerAllIn(3); t.playerCall(4); t.playerCall(5); t.playerFold(0); t.playerFold(1);
      expect(t.seats[4].chipCount).toBeGreaterThan(0); return { t, me: 2 };
    }],
    ['All-In or Fold: UTG, MP and CO all-in, BB closes', () => {
      const t = aof(); t.playerAllIn(3); t.playerAllIn(4); t.playerAllIn(5); t.playerFold(0); t.playerFold(1); return { t, me: 2 };
    }, AOF],
  ];
  // Fix-up 5 (2026-11-10, THE MANIAC CLASS): outside All-In or Fold a MANIAC facing all-ins plays 0dc1b96's MANIAC
  // (maniacFacingRaise0dc1b96: 0dc1b96's push/fold on the chips-left depth, or its random raise of a bottom hand with callers
  // still holding chips), not the stack-off range: it continues 50-97% of hands (~65% when every shover is all-in, ~93% when
  // the callers have chips behind), 72o / 32o at most 60% (0dc1b96 ~45% with the callers' chips behind). Every other archetype, and the MANIAC in All-In or Fold, keep the 0 / <= 12% bounds.
  it.each(['easy', 'medium', 'hard'])('%s: 72o and 32o fold in the deep multiway all-ins (every archetype called 100%%)', (diff) => {
    for (const [label, build, opts] of closes) for (const a of ARCHS) {
      for (const c of ['72o', '32o']) {
        const w = rate(build, prof(a, diff), cont, 40, c, opts || {});
        if (a === 'MANIAC' && !opts) expect([label, a, c, w <= 0.6]).toEqual([label, a, c, true]);
        else expect([label, a, c, w]).toEqual([label, a, c, 0]);
      }
      const r = rate(build, prof(a, diff), cont, 600, undefined, opts || {});
      if (a === 'MANIAC' && !opts) expect([label, r >= 0.5 && r <= 0.97]).toEqual([label, true]);
      else expect(r).toBeLessThanOrEqual(0.12);
    }
  });
  it('...while every archetype still calls a genuinely small all-in that it closes with any two cards (C14)', () => {
    const micro: Array<[string, Spot]> = [
      ['BB vs a lone 1.5 BB shove', () => { const t = mk(6, [100, 100, 100, 1.5, 100, 100]); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; }],
      ['BB vs a lone 2 BB shove', () => { const t = mk(6, [100, 100, 100, 2, 100, 100]); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; }],
      ['BTN opener vs a 3.5 BB short re-shove', () => {
        const t = mk(6, [100, 100, 3.5, 100, 100, 100]); for (const s of [3, 4, 5]) t.playerFold(s); t.playerRaise(0, 250); t.playerFold(1); t.playerAllIn(2); return { t, me: 0 };
      }],
      ['BB vs a 1.5 BB shove and an MP flat', () => {
        const t = mk(6, [100, 100, 100, 1.5, 100, 100]); t.playerAllIn(3); t.playerCall(4); for (const s of [5, 0, 1]) t.playerFold(s); return { t, me: 2 };
      }],
    ];
    for (const [label, build] of micro) for (const a of ARCHS) expect([label, a, rate(build, prof(a), cont, 600)]).toEqual([label, a, 1]);
    // the fix half: three 100 BB all-ins in front no longer price in any two cards
    expect(rate(closes[0][1], prof('TAG'), cont, 50, '72o')).toBe(0);
  });
});

describe('HAI-4 — a bot never folds when checking is free', () => {
  const never = (build: Spot, archs: string[]) => {
    for (const d of ['medium', 'hard']) for (const a of archs) expect([a, d, rate(build, prof(a, d), isFold, 400)]).toEqual([a, d, 0]);
  };
  it('the straddler\'s option (everyone called the 2 BB straddle)', () => {
    never(() => {
      const t = mk(6); expect(t.straddle(3)).toBe(true); for (const s of [4, 5, 0, 1, 2]) t.playerCall(s);
      expect([t.activeSeatIndex, t.getCallAmount(t.seats[3])]).toEqual([3, 0]);
      return { t, me: 3 };
    }, ARCHS);
  });
  it('F22: the bot opened, a flat, then the 3-bettor left the table (his raise voided, raisesThisStreet back to 1)', () => {
    never(() => {
      const t = mk(6); t.playerRaise(3, 300); t.playerCall(4); t.playerRaise(5, 900); for (const s of [0, 1, 2]) t.playerFold(s);
      expect(t.activeSeatIndex).toBe(3);
      expect(t.forceFoldSeat(5)).toBe(true);
      expect(t.awardIfUncontested()).toBe(false);
      expect([t.activeSeatIndex, t.getCallAmount(t.seats[3]), (t as any).raisesThisStreet]).toEqual([3, 0, 1]);
      return { t, me: 3 };
    }, ARCHS);
  });
  it('F22: the bot 3-bet, a flat, then the 4-bettor left (raisesThisStreet back to 2)', () => {
    never(() => {
      const t = mk(6); t.playerRaise(3, 300); t.playerRaise(4, 900); t.playerCall(5); t.playerRaise(0, 2700); for (const s of [1, 2, 3]) t.playerFold(s);
      expect(t.activeSeatIndex).toBe(4);
      expect(t.forceFoldSeat(0)).toBe(true);
      expect(t.awardIfUncontested()).toBe(false);
      expect([t.activeSeatIndex, t.getCallAmount(t.seats[4]), (t as any).raisesThisStreet]).toEqual([4, 0, 2]);
      return { t, me: 4 };
    }, ['TAG', 'LAG', 'NIT', 'ROCK']);
  });
});

describe('B5 residual — NIT / ROCK / FISH never limp (or fold) a value hand unopened', () => {
  const seats: Array<[string, Spot]> = [
    ['UTG', () => ({ t: mk(6), me: 3 })],
    ['BTN', () => { const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s); return { t, me: 0 }; }],
    ['SB', () => { const t = mk(6); for (const s of [3, 4, 5, 0]) t.playerFold(s); return { t, me: 1 }; }],
  ];
  // Expert (noise +-0.01) already raised every one of them on d1ec56a.
  it.each(['easy', 'medium', 'hard'])('%s: AA, KK, QQ, JJ, AKs and AKo raise from UTG, the BTN and the SB', (diff) => {
    const bad: string[] = [];
    for (const [pos, build] of seats) for (const a of ['NIT', 'ROCK', 'FISH', 'TAG', 'LAG']) for (const c of ['AA', 'KK', 'QQ', 'JJ', 'AKs', 'AKo']) {
      const r = rate(build, prof(a, diff), (d) => d.action !== PlayerAction.Raise && d.action !== PlayerAction.AllIn, 100, c);
      if (r > 0) bad.push(`${pos} ${a}/${diff} ${c} limps or folds ${(100 * r).toFixed(1)}%`);
    }
    expect(bad).toEqual([]);
  });
});

describe('HAI-1 / HAI-2 on Short Deck (no-limit, its own pre-flop table)', () => {
  // 2026-11-12 (Short Deck reset): the lane's Short Deck code is dormant behind SHORT_DECK_BOTS_PLAY_LIVE; this pin runs it
  // through the Jest-only hook (tests/sdLiveGolden pins the shipped, live behaviour).
  beforeAll(() => AI.setShortDeckLaneForTests(true));
  afterAll(() => AI.setShortDeckLaneForTests(false));
  const sd = (): ShortDeckTable => {
    const t = new ShortDeckTable({ tableId: 's', tableName: 's', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: 100 } as any);
    const id = tableNo++;
    for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 100 * BB, `ai-s${id}-${i}`, true);
    t.startNewHand();
    return t;
  };
  const spots: Array<[string, Spot]> = [
    ['UTG opens 10 BB', () => { const t = sd(); t.playerRaise(t.activeSeatIndex, 1000); return { t, me: t.activeSeatIndex }; }],
    ['UTG opens 30 BB', () => { const t = sd(); t.playerRaise(t.activeSeatIndex, 3000); return { t, me: t.activeSeatIndex }; }],
    ['UTG shoves 100 BB', () => { const t = sd(); t.playerAllIn(t.activeSeatIndex); return { t, me: t.activeSeatIndex }; }],
  ];
  it.each(['easy', 'medium', 'hard'])('%s: AA, KK and QQ never fold', (diff) => {
    expect(premiumFolds(spots, diff, ['AA', 'KK', 'QQ'], ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH'])).toEqual([]);
  });
});

describe('Fix round 3 (review of the round-2 lane) — pins for the multiway cap, the size floor and its taper', () => {
  /** UTG opens to `sz` BB at 100 BB; MP decides. */
  const openMp = (sz: number): Spot => () => { const t = mk(6); expect(t.playerRaise(3, sz * BB)).toBe(true); return { t, me: 4 }; };

  it.each([['TAG', 'hard'], ['NIT', 'hard'], ['TAG', 'medium']])(
    'HAI-1 cap, %s/%s: a 22 BB UTG shove is called as at 6-max with 7 players behind (not only AA-JJ / AK)', (a, d) => {
      // CALL_WIDTH_MAX_PLAYERS: uncapped (8 live at 9-max) the width falls to ~4%, on d1ec56a ~1% (AA-QQ).
      const r9 = rate(utgShove(9, 22), prof(a, d), cont, 3000);
      const r6 = rate(utgShove(6, 22), prof(a, d), cont, 3000);
      expect(Math.abs(r9 - r6)).toBeLessThanOrEqual(0.003);
      expect(r9).toBeGreaterThanOrEqual(0.065);
    });

  it.each([['TAG', 'hard'], ['NIT', 'hard']])(
    'HAI-2 floor, %s/%s: vs a 15 BB UTG open MP keeps 88 / 99 / TT (the call line stops at the top ~5.4%%)', (a, d) => {
      // Without SIZE_NARROW_MAX_TH the line narrows to ~0.98: 3-4% continue, 88 19-62%.
      expect(rate(openMp(15), prof(a, d), cont, 3000)).toBeGreaterThanOrEqual(0.05);
      for (const c of ['88', '99', 'TT']) expect([c, rate(openMp(15), prof(a, d), cont, 200, c) >= 0.95]).toEqual([c, true]);
      for (const c of ['K9o', 'QTo']) expect([c, rate(openMp(15), prof(a, d), cont, 100, c)]).toEqual([c, 0]);
    });

  it.each([['TAG', 'hard'], ['NIT', 'hard'], ['TAG', 'medium'], ['LAG', 'easy']])(
    'size taper, %s/%s: vs 15-60 BB opens the range narrows smoothly into the 1/3-stack stack-off range', (a, d) => {
      // Without the taper: flat 5.4% to 33 BB, then 3.3% at 34 BB (a 2 pp cliff; 77 / 88 / AJs flat a third of
      // the stack). Without the floor, or on d1ec56a, the range WIDENS at the commit line and AA-JJ fold to it.
      const sizes = [15, 17, 20, 22, 25, 28, 30, 32, 33, 34, 36, 40, 60];
      const r = sizes.map((sz) => rate(openMp(sz), prof(a, d), cont, 3000));
      for (let i = 1; i < r.length; i++) expect([sizes[i], r[i] - r[i - 1] <= 0.003]).toEqual([sizes[i], true]);
      expect(r[sizes.indexOf(33)] - r[sizes.indexOf(34)]).toBeLessThanOrEqual(0.006);
      for (const sz of sizes) for (const c of ['AA', 'KK', 'QQ', 'JJ', 'AKo']) {
        expect([sz, c, rate(openMp(sz), prof(a, d), isFold, 100, c)]).toEqual([sz, c, 0]);
      }
      if (d === 'hard') for (const c of ['77', '88', 'AJs']) expect([c, rate(openMp(33), prof(a, d), cont, 200, c) <= 0.05]).toEqual([c, true]);
    });
});

describe('Fix round 3 — All-In or Fold calibration (the economy target)', () => {
  /** UTG (seat 3) observed voluntarily in `vpip` of `hands` hands, then shoves; MP decides with 4 others live. */
  const aofObservedShove = (hands: number, vpip: number): Spot => () => {
    const t = aof();
    const key = AI.opponentModelKey(t.seats[3]);
    for (let h = 1; h <= hands; h++) { AI.recordOpponentObservation(key, 'hand_start', { handNumber: 1000 + h }); if (h <= vpip) AI.recordOpponentObservation(key, 'vpip'); }
    expect(t.playerAllIn(3)).toBe(true);
    return { t, me: 4 };
  };

  it('HAI-1 cap in All-In or Fold: vs a shover seen in 12 of 30 hands, MP (4 others live) calls as with 2 others live', () => {
    // aofCallPctile(25, ~0.32, CALL_WIDTH_MAX_PLAYERS - 1): ~7.5% for a hard TAG; uncapped (4 others) ~5%.
    const r = rate(aofObservedShove(30, 12), prof('TAG', 'hard'), cont, 3000, undefined, AOF);
    expect(r).toBeGreaterThanOrEqual(0.065);
    expect(r).toBeLessThanOrEqual(0.095);
  });

  it('AOF_ARCHETYPE_DAMP: a loose archetype shoves and calls at most ~1.45x a TAG\'s width (it was 1.67-1.77x)', () => {
    const spots: Array<[string, Spot]> = [
      ['UTG unopened (5 behind)', () => ({ t: aof(), me: 3 })],
      ['BB vs an SB shove', () => { const t = aof(); for (const s of [3, 4, 5, 0]) t.playerFold(s); expect(t.playerAllIn(1)).toBe(true); return { t, me: 2 }; }],
    ];
    for (const [label, build] of spots) {
      const tag = rate(build, prof('TAG', 'hard'), cont, 4000, undefined, AOF);
      for (const a of ['MANIAC', 'FISH', 'CALLING_STATION', 'LAG']) {
        const r = rate(build, prof(a, 'hard'), cont, 4000, undefined, AOF);
        expect([label, a, r / tag <= 1.45]).toEqual([label, a, true]);
        expect([label, a, r / tag >= 1.0]).toEqual([label, a, true]);   // the personality stays: never tighter than a TAG
      }
      const nit = rate(build, prof('NIT', 'hard'), cont, 4000, undefined, AOF);
      expect([label, nit <= tag && nit / tag >= 0.85]).toEqual([label, true]);
    }
  });

  it('AOF_NOISE_KEEP: an easy bot\'s All-In or Fold shove is never more than half its noise (0.0625) off its line', () => {
    // UTG unopened, 5 behind. Undamped, an easy bot shoved hands 0.07-0.115 under its line 4-22% of the time
    // and folded hands as far above it.
    const damp = (AI as any).AOF_ARCHETYPE_DAMP ?? 1;
    const line = PR.adjustThreshold(PF.aofPushPctile(25, 5) as number, Math.pow(PR.ARCHETYPE_RANGE_FACTOR.TAG, damp));
    const codes = PREFLOP_TABLE.map((r) => r[0] as string);
    const pct = (c: string) => PR.getPreflopPercentile(hand(c));
    const below = codes.filter((c) => pct(c) > line - 0.115 && pct(c) < line - 0.07);
    const above = codes.filter((c) => pct(c) > line + 0.07 && pct(c) < line + 0.115);
    expect(below.length).toBeGreaterThan(3);
    expect(above.length).toBeGreaterThan(0);
    const shoves = (c: string) => rate(() => ({ t: aof(), me: 3 }), prof('TAG', 'easy'), (d) => d.action === PlayerAction.AllIn, 200, c, AOF);
    for (const c of below) expect([c, shoves(c)]).toEqual([c, 0]);
    for (const c of above) expect([c, shoves(c)]).toEqual([c, 1]);
  });
});

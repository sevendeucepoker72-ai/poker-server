/**
 * tests/botPreflopFixes.test.ts (2026-11 bots review, holdem-preflop group).
 * Real PokerTable + real decideAction, seeded Math.random for the bots' choices and the dealt hands.
 * Every block fails on 0dc1b96 and passes with the fix, except the blocks marked GUARD
 * (they pass on 0dc1b96 too and pin behaviour the fix must NOT change; the review-round
 * guards failed on the first prototype).
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { decideAction, getEffectiveStackBB } from '../src/ai/AIPlayer';

const BB = 100;
function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'tight', archetype, vpip: 0.2, pfr: 0.15, aggressionFactor: 2.5, bluffFrequency: 0.15 } as any);
/** n seats, every stack `stacks` BB (or per seat); hand started. 6-handed: btn 0, sb 1, bb 2, utg 3, mp 4, co 5. */
function mk(n: number, stacks: number | number[] = 100): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: 100 } as any);
  for (let i = 0; i < n; i++) expect(t.sitDown(i, 'P' + i, (Array.isArray(stacks) ? stacks[i] : stacks) * BB, 'ai-' + i, true)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}
const RC: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const hand = (code: string) => [{ rank: RC[code[0]] ?? +code[0], suit: 0 }, { rank: RC[code[1]] ?? +code[1], suit: code[2] === 's' ? 0 : 1 }] as any;
function randHand(): any {
  const a = Math.floor(Math.random() * 52); let b = Math.floor(Math.random() * 51); if (b >= a) b++;
  return [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }];
}
/** Share of `n` decisions (random hands unless `code`) for which `pred` holds. */
function rate(build: () => { t: PokerTable; me: number }, p: any, pred: (d: any) => boolean, n = 800, code?: string, opts = {}): number {
  const restore = seedRandom(4242);
  try {
    let k = 0;
    for (let i = 0; i < n; i++) {
      const { t, me } = build();
      t.seats[me].holeCards = code ? hand(code) : randHand();
      if (pred(decideAction(t, me, p, opts))) k++;
    }
    return k / n;
  } finally { restore(); }
}
const cont = (d: any) => d.action !== PlayerAction.Fold;
const ARCHS = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const utgShovesFoldsToBB = () => { const t = mk(6); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; };

describe('NEW-1 — a lone all-in is priced at the real depth, not at the shover\'s 0 chips left', () => {
  it('effective stack after a lone 100 BB shove is 100 BB (was 1)', () => {
    const { t, me } = utgShovesFoldsToBB();
    expect(getEffectiveStackBB(t, me)).toBe(100);
  });
  // Fix-up 5 (2026-11-10, THE MANIAC CLASS): a MANIAC facing a raise or an all-in plays 0dc1b96's MANIAC again
  // (maniacFacingRaise0dc1b96): it answers the lone shove with 0dc1b96's push/fold on the chips-left depth (the next row);
  // every other archetype keeps NEW-1.
  it.each(ARCHS.filter((a) => a !== 'MANIAC'))('%s in the BB calls a lone 100 BB shove with 3-12%% of hands (was 53-66%%)', (a) => {
    const r = rate(utgShovesFoldsToBB, prof(a), cont);
    expect(r).toBeGreaterThanOrEqual(0.03);
    expect(r).toBeLessThanOrEqual(0.12);
  });
  it('fix-up 5: the MANIAC in the BB answers it as 0dc1b96 does (50-80% of hands; 0dc1b96 ~65%, f605403 ~8%)', () => {
    const r = rate(utgShovesFoldsToBB, prof('MANIAC'), cont);
    expect(r).toBeGreaterThanOrEqual(0.5);
    expect(r).toBeLessThanOrEqual(0.8);
  });
  it('AA always calls it, 72o never', () => {
    expect(rate(utgShovesFoldsToBB, prof('NIT'), cont, 100, 'AA')).toBe(1);
    expect(rate(utgShovesFoldsToBB, prof('MANIAC'), cont, 100, '72o')).toBe(0);
  });
  it('a 90 BB open that leaves 10 BB behind is a stack-off for the BB, not push/fold (was 44-68%)', () => {
    const b = () => { const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s); t.playerRaise(0, 9000); t.playerFold(1); return { t, me: 2 }; };
    expect(rate(b, prof('TAG'), cont)).toBeLessThanOrEqual(0.12);
  });
  it('genuinely short stacks still call the baked Nash range: heads-up 10 BB ~36%, 20 BB ~21%', () => {
    const hu = (bb: number) => () => { const t = mk(2, bb); t.playerAllIn(t.activeSeatIndex); return { t, me: t.activeSeatIndex }; };
    const r10 = rate(hu(10), prof('TAG'), cont), r20 = rate(hu(20), prof('TAG'), cont);
    expect(r10).toBeGreaterThan(0.28); expect(r10).toBeLessThan(0.45);
    expect(r20).toBeGreaterThan(0.14); expect(r20).toBeLessThan(0.28);
  });
  // Fix-up 5 (2026-11-10, THE MANIAC CLASS) returned this spot to 0dc1b96 for the MANIAC: with the stack-off ranges (NEW-5)
  // and the light re-raise cap, MANIACs that had not raised folded where 0dc1b96's call, and the raises of the others were
  // dead money for a human's shove (five 200 BB MANIACs, open any two, shove over the re-raise: +218 BB/100, live -85).
  it('NEW-5 (fix-up 5: as 0dc1b96) — a MANIAC with three players behind answers a 100 BB shove as 0dc1b96 again: >= 85% (f605403 <= 10%)', () => {
    const b = () => { const t = mk(6); t.playerAllIn(3); t.playerFold(4); return { t, me: 5 }; };
    expect(rate(b, prof('MANIAC'), cont)).toBeGreaterThanOrEqual(0.85);
  });
  it('All-In or Fold: the big blind calls a lone 50 BB shove with the 25 BB Nash range (was ~65-70%)', () => {
    const b = () => { const t = mk(6, 50); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; };
    for (const d of ['easy', 'medium', 'hard']) expect(rate(b, prof('TAG', d), cont, 800, undefined, { allInOrFold: true })).toBeLessThanOrEqual(0.25);
  });
});

describe('B5 — NIT / ROCK / FISH open normally from every seat', () => {
  const utg = () => ({ t: mk(6), me: 3 });
  it.each(['NIT', 'ROCK', 'FISH'])('%s never open-shoves 100 BB from UTG (NIT was 3%%, FISH 11%%)', (a) => {
    expect(rate(utg, prof(a), (d) => d.action === PlayerAction.AllIn, 1500)).toBe(0);
  });
  it('ROCK raises AA (it limped it 100%); NIT opens AA to 2.5 BB (it shoved 100 BB)', () => {
    expect(rate(utg, prof('ROCK'), (d) => d.action === PlayerAction.Raise, 100, 'AA')).toBe(1);
    expect(rate(utg, prof('NIT'), (d) => d.action === PlayerAction.Raise && d.raiseAmount === 250, 100, 'AA')).toBe(1);
  });
  it('NIT never limps; plays <= 10% from UTG', () => {
    expect(rate(utg, prof('NIT'), (d) => d.action === PlayerAction.Call, 1500)).toBe(0);
    expect(rate(utg, prof('NIT'), cont, 1500)).toBeLessThanOrEqual(0.10);
  });
});

describe('CALLING_STATION — loose, not 100%, and the price matters', () => {
  const cs = prof('CALLING_STATION');
  const bbVs = (sz: number) => () => { const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s); t.playerRaise(0, sz * BB); t.playerFold(1); return { t, me: 2 }; };
  it('folds >= 30% unopened from UTG (was 0%)', () => { expect(rate(() => ({ t: mk(6), me: 3 }), cs, (d) => d.action === PlayerAction.Fold)).toBeGreaterThanOrEqual(0.30); });
  it('calls >= 45% vs a 3 BB open but <= 30% vs a 9 BB open (was 100% / 100%)', () => {
    expect(rate(bbVs(3), cs, cont)).toBeGreaterThanOrEqual(0.45);
    expect(rate(bbVs(9), cs, cont)).toBeLessThanOrEqual(0.30);
  });
});

describe('B4 / NEW-4 — the size of the raise matters', () => {
  const bbVs = (sz: number) => () => { const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s); t.playerRaise(0, sz * BB); t.playerFold(1); return { t, me: 2 }; };
  it('TAG BB continues >= 40% vs 2.5 BB, <= 15% vs 15 BB, <= 10% vs 60 BB (was ~42% at every size)', () => {
    expect(rate(bbVs(2.5), prof('TAG'), cont)).toBeGreaterThanOrEqual(0.40);
    expect(rate(bbVs(15), prof('TAG'), cont)).toBeLessThanOrEqual(0.15);
    expect(rate(bbVs(60), prof('TAG'), cont)).toBeLessThanOrEqual(0.10);
  });
  it.each(['K9o', 'QTo'])('%s folds to a 15 BB and a 60 BB open (called 100%%)', (code) => {
    for (const sz of [15, 60]) expect(rate(bbVs(sz), prof('TAG'), cont, 100, code)).toBe(0);
  });
});

describe('B9 — the big blind facing a min-raise is facing a raise', () => {
  const b = () => { const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s); t.playerRaise(0, 2 * BB); t.playerFold(1); return { t, me: 2 }; };
  it('AA / KK 3-bet to 6 BB (were min re-raises to 3 BB); QJs calls (was a 3 BB re-raise)', () => {
    for (const c of ['AA', 'KK']) expect(rate(b, prof('TAG'), (d) => d.action === PlayerAction.Raise && d.raiseAmount === 600, 100, c)).toBe(1);
    expect(rate(b, prof('TAG'), (d) => d.action === PlayerAction.Call, 100, 'QJs')).toBe(1);
  });
  it('TAG folds <= 50% of hands to a min-raise (was ~53-58%)', () => { expect(rate(b, prof('TAG'), (d) => d.action === PlayerAction.Fold, 1500)).toBeLessThanOrEqual(0.50); });
});

describe('B8 — an opener facing a 3-bet defends by the price', () => {
  function foldRate(mult: number): number {
    const restore = seedRandom(77);
    try {
      let opens = 0, folds = 0;
      for (let i = 0; i < 3000 && opens < 600; i++) {
        const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s);
        t.seats[0].holeCards = randHand();
        const d = decideAction(t, 0, prof('TAG'));
        if (d.action !== PlayerAction.Raise) continue;
        opens++;
        t.playerRaise(0, d.raiseAmount); t.playerFold(1);
        t.playerRaise(2, mult === 0 ? t.getMinRaise() : Math.round(t.currentBetToMatch * mult));
        if (decideAction(t, 0, prof('TAG')).action === PlayerAction.Fold) folds++;
      }
      return folds / opens;
    } finally { restore(); }
  }
  it('folds <= 50% to a min 3-bet (was ~73%), and more to a 4.5x 3-bet than to a min one', () => {
    const fMin = foldRate(0), fBig = foldRate(4.5);
    expect(fMin).toBeLessThanOrEqual(0.50);
    expect(fBig - fMin).toBeGreaterThanOrEqual(0.10);
  });
});

describe('B16 — push/fold counts the players actually left to act', () => {
  const shove = (d: any) => d.action === PlayerAction.AllIn;
  it('6-handed 10 BB: the SB folded to shoves >= 10 points wider than UTG (were equal ~46%)', () => {
    const utg = rate(() => ({ t: mk(6, 10), me: 3 }), prof('TAG'), shove, 1500);
    const sb = rate(() => { const t = mk(6, 10); for (const s of [3, 4, 5, 0]) t.playerFold(s); return { t, me: 1 }; }, prof('TAG'), shove, 1500);
    expect(sb - utg).toBeGreaterThanOrEqual(0.10);
  });
  it('the SB folded to at 14 BB shoves (was never: outside the 3-player zone)', () => {
    expect(rate(() => { const t = mk(6, 14); for (const s of [3, 4, 5, 0]) t.playerFold(s); return { t, me: 1 }; }, prof('TAG'), shove, 1500)).toBeGreaterThan(0.30);
  });
});

describe('NEW-3 — first-in opens are position-sized', () => {
  it('a TAG button open is sometimes under 3 BB (was always exactly 3 BB)', () => {
    const b = () => { const t = mk(6); for (const s of [3, 4, 5]) t.playerFold(s); return { t, me: 0 }; };
    expect(rate(b, prof('TAG'), (d) => d.action === PlayerAction.Raise && d.raiseAmount < 300, 1500)).toBeGreaterThan(0.1);
  });
});

describe('GUARD (review) — a short all-in with live players still to act is routed like any raise', () => {
  const shove = (d: any) => d.action === PlayerAction.AllIn;
  const mkS = (n: number, stacks: number[]) => mk(n, stacks);
  it.each([1.5, 3, 5])('6-max 100 BB, UTG all-in for %s BB, MP decides with 4 deep behind: TAG and NIT continue <= 12%%', (sz) => {
    const b = () => { const t = mkS(6, [100, 100, 100, sz, 100, 100]); t.playerAllIn(3); return { t, me: 4 }; };
    for (const a of ['TAG', 'NIT']) expect(rate(b, prof(a), cont)).toBeLessThanOrEqual(0.12);
  });
  it('all stacks 10 BB, UTG 2 BB all-in, MP decides: TAG goes all-in <= 50%', () => {
    const b = () => { const t = mkS(6, [10, 10, 10, 2, 10, 10]); t.playerAllIn(3); return { t, me: 4 }; };
    expect(rate(b, prof('TAG'), shove)).toBeLessThanOrEqual(0.50);
  });
  it('All-In or Fold 50 BB, UTG 5 BB all-in, MP decides with 4 behind: TAG and NIT all-in <= 12%', () => {
    const b = () => { const t = mkS(6, [50, 50, 50, 5, 50, 50]); t.playerAllIn(3); return { t, me: 4 }; };
    for (const a of ['TAG', 'NIT']) expect(rate(b, prof(a), shove, 800, undefined, { allInOrFold: true })).toBeLessThanOrEqual(0.12);
  });
});

describe('GUARD (review) — B16 widens the push/fold zone only in unopened pots', () => {
  const shove = (d: any) => d.action === PlayerAction.AllIn;
  it('all 14 BB, BTN opens 2.5 BB, SB folds, BB decides: NIT all-in <= 10%, TAG all-in <= 25%', () => {
    const b = () => { const t = mk(6, 14); for (const s of [3, 4, 5]) t.playerFold(s); t.playerRaise(0, 250); t.playerFold(1); return { t, me: 2 }; };
    expect(rate(b, prof('NIT'), shove)).toBeLessThanOrEqual(0.10);
    expect(rate(b, prof('TAG'), shove)).toBeLessThanOrEqual(0.25);
  });
  it('all 12 BB, CO opens 2.5 BB, BTN folds, SB decides with the BB behind: NIT all-in <= 10%, TAG all-in <= 25%', () => {
    const b = () => { const t = mk(6, 12); for (const s of [3, 4]) t.playerFold(s); t.playerRaise(5, 250); t.playerFold(0); return { t, me: 1 }; };
    expect(rate(b, prof('NIT'), shove)).toBeLessThanOrEqual(0.10);
    expect(rate(b, prof('TAG'), shove)).toBeLessThanOrEqual(0.25);
  });
});

describe('NEW-1 price floor — a micro all-in that the call closes is always called', () => {
  it.each(ARCHS)('%s in the BB calls a lone 1.5 BB all-in (0.5 BB into 3 BB) with every hand (TAG was ~69%%, CS 70%% on the first prototype)', (a) => {
    const b = () => { const t = mk(6, [100, 100, 100, 1.5, 100, 100]); t.playerAllIn(3); for (const s of [4, 5, 0, 1]) t.playerFold(s); return { t, me: 2 }; };
    expect(rate(b, prof(a), cont)).toBe(1);
  });
});

describe('GUARD (review) — a straddled pot sizes raises against the straddle', () => {
  it('ROCK in the CO facing a 3x-straddle open (6 BB) continues >= 18% (0dc1b96 ~21%; the first prototype halved it to ~10%)', () => {
    const b = () => { const t = mk(6); expect(t.straddle(3)).toBe(true); expect(t.playerRaise(4, 600)).toBe(true); return { t, me: 5 }; };
    expect(rate(b, prof('ROCK'), cont)).toBeGreaterThanOrEqual(0.18);
  });
});

describe('GUARD (review) — pot-limit Omaha commit spots keep their ranges', () => {
  it('PLO 25 BB: the CO opener facing a pot-size 3-bet continues <= 10% (TAG; 0dc1b96 3.5%)', () => {
    const cfg = { tableId: 'o', tableName: 'o', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: 100 } as any;
    const restore = seedRandom(4242);
    try {
      let k = 0; const n = 600;
      for (let i = 0; i < n; i++) {
        const t: any = new OmahaTable(cfg, false, 4);
        for (let s = 0; s < 6; s++) t.sitDown(s, 'P' + s, 25 * BB, 'ai-o' + s, true);
        t.startNewHand();
        t.playerFold(3); t.playerFold(4); t.playerRaise(5, t.getMaxRaise(5)); t.playerRaise(0, t.getMaxRaise(0)); t.playerFold(1); t.playerFold(2);
        const used = new Set<number>(); const h: any[] = [];
        while (h.length < 4) { const c = Math.floor(Math.random() * 52); if (used.has(c)) continue; used.add(c); h.push({ rank: 2 + (c % 13), suit: Math.floor(c / 13) }); }
        t.seats[5].holeCards = h;
        if (decideAction(t, 5, prof('TAG')).action !== PlayerAction.Fold) k++;
      }
      expect(k / n).toBeLessThanOrEqual(0.10);
    } finally { restore(); }
  });
});

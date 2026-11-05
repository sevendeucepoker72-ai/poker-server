/**
 * tests/botsShortDeckBots.test.ts (2026-11 bots review, equity-variants B13 / C4 / C5 wired
 * into the bots; ai-core lane — the table / equity half is botsShortDeckEquity).
 *
 *   #4  Short Deck pre-flop reads its own equity-ranked table (SHORT_DECK_PREFLOP_PCTILE):
 *       the full-deck percentile opened 30% of combos UTG 6-max (a 36-card deck has no
 *       2-5, so every hand sat higher on the full-deck scale).
 *   #5  the medium / easy static strength ranks hands in the 6+ order (trips over a
 *       straight, a flush over a full house, A-6-7-8-9 a straight).
 * Every case fails on 0dc1b96 (#5 needs the new getPostFlopStrength export and order).
 */
import { Card } from '../src/game/Card';
import { PlayerAction } from '../src/game/PokerTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { decideAction, getPostFlopStrength } from '../src/ai/AIPlayer';

const RK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const SU: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] =>
  s.trim() ? s.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] } as Card)) : [];
function seeded<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  try { return fn(); } finally { Math.random = orig; }
}
const tagHard = { botName: 'B', difficulty: 'hard', personality: 'tight', archetype: 'TAG', vpip: 0.22, pfr: 0.18, aggressionFactor: 2.75, bluffFrequency: 0.15 } as any;
const NAMES = 'xxxxxx6789TJQKA';

describe('B13 / C5 (#4) — Short Deck pre-flop: UTG 6-max on a real ShortDeckTable, all 630 combos', () => {
  it('a TAG opens 10-18% of combos (0dc1b96: 30.0%); AA and KK always open, 76o never does', () => {
    const t = new ShortDeckTable({ tableId: 'sd', tableName: 'sd', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 } as any);
    for (let s = 0; s < 6; s++) expect(t.sitDown(s, 'B' + s, 10000, 'ai-sd' + s, true)).toBe(true);
    expect(t.startNewHand()).toBe(true);
    const me = t.activeSeatIndex;
    expect(me).toBe(3);   // UTG: btn 0, sb 1, bb 2
    const deck: Card[] = [];
    for (let s = 0; s < 4; s++) for (let r = 6; r <= 14; r++) deck.push({ rank: r, suit: s } as Card);
    const opensByCode = new Map<string, { opens: number; n: number }>();
    let opens = 0, n = 0;
    for (let i = 0; i < 36; i++) for (let j = i + 1; j < 36; j++) {
      const a = deck[i], b = deck[j];
      const [hi, lo] = a.rank >= b.rank ? [a, b] : [b, a];
      const code = hi.rank === lo.rank ? NAMES[hi.rank] + NAMES[lo.rank] : NAMES[hi.rank] + NAMES[lo.rank] + (hi.suit === lo.suit ? 's' : 'o');
      t.seats[me].holeCards = [a, b];
      const d = seeded(i * 64 + j, () => decideAction(t, me, tagHard));
      const open = d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn;
      if (open) opens++;
      n++;
      const e = opensByCode.get(code) || { opens: 0, n: 0 };
      e.n++; if (open) e.opens++;
      opensByCode.set(code, e);
    }
    expect(n).toBe(630);
    const share = opens / n;
    expect(share).toBeGreaterThanOrEqual(0.10);
    expect(share).toBeLessThanOrEqual(0.18);
    for (const c of ['AA', 'KK']) expect([c, opensByCode.get(c)]).toEqual([c, { opens: 6, n: 6 }]);
    expect(opensByCode.get('76o')).toEqual({ opens: 0, n: 12 });
  }, 60_000);
});

describe('B13 (#5) — getPostFlopStrength, medium difficulty, Short Deck: the 6+ hand order', () => {
  const sd = (h: string, b: string) => getPostFlopStrength(cs(h), cs(b), 1, 'medium', false, 0, true);
  it('trips 7s7d on 7c8hKs (0.720) rank above a straight 9hTd on 6c7d8s (0.623) (0dc1b96: 0.610 < 0.729)', () => {
    expect(sd('7s 7d', '7c 8h Ks')).toBeCloseTo(0.72, 3);
    expect(sd('9h Td', '6c 7d 8s')).toBeCloseTo(0.623, 3);
    expect(sd('7s 7d', '7c 8h Ks')).toBeGreaterThan(sd('9h Td', '6c 7d 8s'));
  });
  it('A-6-7-8-9 is a straight: Ah6d on 7s8d9c >= 0.58 (0dc1b96: 0.160)', () => {
    expect(sd('Ah 6d', '7s 8d 9c')).toBeGreaterThanOrEqual(0.58);
  });
  it('a full house QsQd on Qh9c9s (0.814) ranks below a flush AhKh on Qh9h6h (0.890) (0dc1b96: 0.884 > 0.820)', () => {
    expect(sd('Qs Qd', 'Qh 9c 9s')).toBeCloseTo(0.814, 3);
    expect(sd('Ah Kh', 'Qh 9h 6h')).toBeCloseTo(0.89, 3);
    expect(sd('Qs Qd', 'Qh 9c 9s')).toBeLessThan(sd('Ah Kh', 'Qh 9h 6h'));
  });
  it('playing the board on the river is very weak (x 0.4)', () => {
    const board = 'Ah Kh Qh Jh Th';   // a royal flush on board
    expect(sd('6c 7d', board)).toBeCloseTo(0.4, 6);
  });
  it('GUARD: full-deck Hold\'em (shortDeck = false) keeps its own ladder', () => {
    expect(getPostFlopStrength(cs('9h Td'), cs('6c 7d 8s'), 1, 'medium', false, 0, false)).toBeCloseTo(0.70 + (10 / 14) * 0.04, 6);
  });
});

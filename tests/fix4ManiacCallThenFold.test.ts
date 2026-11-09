/**
 * tests/fix4ManiacCallThenFold.test.ts (2026-11-08, bots review fix round 4: MANIAC call-then-fold, node level).
 * No-limit Hold'em. With its light re-raises capped (MANIAC-RTF), a MANIAC flat-calls ~70% of opens. Two leaks
 * followed, both measured on the whole line (fix round 4):
 *  1. A MANIAC that FLATTED and then faced a shove continued at the plain stack-off width: it folded 72-90% of
 *     its flats (live 0dc1b96 ~30-38%). With five 40 BB MANIACs a squeeze all-in over an open and a flat with any
 *     two won +144 BB/100 (live +30). Deeper than the push/fold zone it now continues with
 *     MANIAC_RAISED_STACKOFF_WIDEN x the width, as a MANIAC that raised does; 25 BB and shallower are unchanged.
 *  2. A deep MANIAC facing a short all-in it does not close (players still to act) skipped the stack-off gate
 *     (the call was under a third of ITS stack) and the MANIAC branch called with ~70% of hands. It now continues
 *     only with the stack-off range for the depth at risk (the shover's stack), by calling: a 40 BB re-shove with
 *     any two over five 500 BB MANIACs won +250 BB/100 (live -138). A short all-in (within the push/fold zone,
 *     25 BB) keeps the MANIAC branch, so it still isolates a micro shove.
 * Fix-up 1 (HOLDEM-R4-EXPLOIT-1): the OPENER with a flatter behind is no longer held to the stack-off width for
 * the shover's depth counting the flatter (it folded 77-86% of its opens, and a big-blind squeeze of any two won
 * +30..+55 BB/100): the flatter is dead money (MANIAC_FLATTER_WIDEN), and it continues by an isolation re-raise,
 * never a flat call, so the call-then-fold this file pins stays gone (tests/fix4ManiacOpenerFlatters.test.ts).
 * Fix-up 2 (HOLDEM-RR1-EXPLOIT-1 / -2, MANIAC_SHORT_SHOVE_MAX_BB): against a 26-75 BB all-in the opener keeps its
 * MANIAC branch (~70%, by calling: isolating made the flatters' chips dead money for the shover), and a flatter reads
 * the stack-off range for the shover's depth counting him alone (the players behind narrowed it to ~23%; now ~36%,
 * still far from the ~70% this file pins against). Test 2's opener row and flatter bound follow.
 * Real PokerTable + real decideAction, seeded Math.random (the LCG of tests/botPremiumHold.test.ts) and a seeded
 * deck (crypto.randomBytes: an unseeded deck changed the hands deal() draws run to run). 6 seats at
 * 50/100: btn 0 (the human), sb 1, bb 2, utg 3, mp 4, co 5. The bounds below fail on 0bc7529 and on the
 * HOLDEM-R3-REG-1 commit alone (equal 40 / 60 / 100 BB: 19 / 13 / 10% continued; deep: 63-72%).
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { decideAction } from '../src/ai/AIPlayer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
function seedRandom(seed: number): () => void {
  const orig = Math.random, rb = nodeCrypto.randomBytes;
  let s = seed >>> 0, ctr = 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  nodeCrypto.randomBytes = (n: number) => {
    let buf = Buffer.alloc(0);
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix4-mctf-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; };
}
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'maniac', archetype, vpip: 0.6, pfr: 0.5, aggressionFactor: 4, bluffFrequency: 0.3 } as any);
const BB = 100;
let tableNo = 0;
function table(stacksBB: number[]): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacksBB[i] * BB, (i === 0 ? 'player-mctf-' : 'ai-mctf-') + id + '-' + i, i !== 0)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}
function deal(t: PokerTable, me: number): void {
  const used = new Set<number>();
  for (const s of t.seats) if (s.seatIndex !== me) for (const c of s.holeCards) used.add(c.rank * 4 + c.suit);
  let a = 0, b = 0;
  do { a = Math.floor(Math.random() * 52); b = Math.floor(Math.random() * 52); }
  while (a === b || used.has((2 + (a % 13)) * 4 + Math.floor(a / 13)) || used.has((2 + (b % 13)) * 4 + Math.floor(b / 13)));
  t.seats[me].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }] as any;
}
/** Share of n random hands for which the MANIAC at `me` continues (does not fold); `calls`: the share it flat-calls. */
function contRate(build: () => PokerTable, me: number, difficulty: string, n = 400, out?: { calls: number }): number {
  let k = 0, c = 0;
  const restore = seedRandom(4242);
  try {
    for (let i = 0; i < n; i++) {
      const t = build();
      deal(t, me);
      expect(t.activeSeatIndex).toBe(me);
      const d = decideAction(t, me, prof('MANIAC', difficulty));
      if (d.action !== PlayerAction.Fold) k++;
      if (d.action === PlayerAction.Call) c++;
    }
  } finally { restore(); }
  if (out) out.calls = c / n;
  return k / n;
}

describe('MANIAC call-then-fold (fix round 4) — a MANIAC that flat-called does not fold its flat to a shove at the plain width', () => {
  it('equal stacks 40 / 60 / 100 BB: UTG opens, the MANIAC flats in MP, the human shoves from the button, the rest fold — MP continues >= 27 / 20 / 15% (was 19 / 13 / 10%)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) for (const [D, min] of [[40, 0.27], [60, 0.20], [100, 0.15]]) {
      const r = contRate(() => {
        const t = table([D, D, D, D, D, D]);
        expect(t.playerRaise(3, 3 * BB)).toBe(true);
        expect(t.playerCall(4)).toBe(true);
        expect(t.playerFold(5)).toBe(true);
        expect(t.playerAllIn(0)).toBe(true);
        for (const s of [1, 2, 3]) expect(t.playerFold(s)).toBe(true);
        return t;
      }, 4, diff);
      if (r < min) bad.push(`${diff} ${D} BB: continued ${(100 * r).toFixed(1)}% < ${100 * min}%`);
    }
    expect(bad).toEqual([]);
  });

  it('a deep (500 BB) MANIAC facing a 40 BB all-in with players still to act no longer calls ~70%: the unraised big blind <= 15%, a flatter <= 45% (fix-up 2: the shover alone counted, ~36%); the opener (a flatter behind it) continues >= 50% (fix-up 2: by calling, the MANIAC branch)', () => {
    const bad: string[] = [];
    const deep = [40, 500, 500, 500, 500, 500];
    const spots: Array<[string, () => PokerTable, number, number]> = [
      // the big blind (posted, no voluntary chips) with the opener and a flatter behind
      ['big blind', () => { const t = table(deep); t.playerRaise(3, 3 * BB); t.playerCall(4); t.playerFold(5); t.playerAllIn(0); t.playerFold(1); return t; }, 2, 0.15],
      // a flatter with a second flatter behind
      ['flatter', () => { const t = table(deep); t.playerRaise(3, 3 * BB); t.playerCall(4); t.playerCall(5); t.playerAllIn(0); for (const s of [1, 2, 3]) t.playerFold(s); return t; }, 4, 0.45],
    ];
    for (const diff of ['hard', 'medium']) for (const [name, build, me, max] of spots) {
      const r = contRate(build, me, diff);
      if (r > max) bad.push(`${diff} ${name}: continued ${(100 * r).toFixed(1)}% > ${100 * max}%`);
    }
    // the opener with a flatter behind (fix-up 1 isolated; fix-up 2: a 40 BB all-in keeps the MANIAC branch, which calls)
    const opener = () => { const t = table(deep); t.playerRaise(3, 3 * BB); t.playerCall(4); t.playerFold(5); t.playerAllIn(0); t.playerFold(1); t.playerFold(2); return t; };
    for (const diff of ['hard', 'medium']) {
      const o = { calls: 0 };
      const r = contRate(opener, 3, diff, 400, o);
      if (r < 0.5 || o.calls < 0.4) bad.push(`${diff} opener: continued ${(100 * r).toFixed(1)}%, flat-called ${(100 * o.calls).toFixed(1)}%`);
    }
    expect(bad).toEqual([]);
  });

  it('a short all-in (within the push/fold zone) keeps the MANIAC branch: a 100 BB MANIAC in MP facing a UTG 1.5 BB all-in with 4 deep behind still isolates it (re-raises >= 30%; 0bc7529 52%)', () => {
    for (const diff of ['hard', 'medium']) {
      let raises = 0;
      const n = 300;
      const restore = seedRandom(4242);
      try {
        for (let k = 0; k < n; k++) {
          const t = table([100, 100, 100, 1.5, 100, 100]);
          expect(t.playerAllIn(3)).toBe(true);
          deal(t, 4);
          expect(t.activeSeatIndex).toBe(4);
          if (decideAction(t, 4, prof('MANIAC', diff)).action === PlayerAction.Raise) raises++;
        }
      } finally { restore(); }
      expect([diff, raises / n >= 0.3]).toEqual([diff, true]);
    }
  });

  it('it still plays: AA in the deep big-blind spot always continues, and 72o folds', () => {
    const restore = seedRandom(4242);
    try {
      for (const [cards, want] of [[[{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], true], [[{ rank: 7, suit: 0 }, { rank: 2, suit: 1 }], false]] as Array<[any[], boolean]>) {
        for (let k = 0; k < 40; k++) {
          const t = table([40, 500, 500, 500, 500, 500]);
          t.playerRaise(3, 3 * BB); t.playerCall(4); t.playerFold(5); t.playerAllIn(0); t.playerFold(1);
          for (const s of t.seats) if (s.seatIndex !== 2) s.holeCards = s.holeCards.filter((c: any) => !cards.some((w) => w.rank === c.rank && w.suit === c.suit));
          t.seats[2].holeCards = cards.slice() as any;
          expect(decideAction(t, 2, prof('MANIAC')).action !== PlayerAction.Fold).toBe(want);
        }
      }
    } finally { restore(); }
  });
});

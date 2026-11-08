/**
 * tests/studDrawDeepStacks.test.ts (2026-11 bots review, fix round 4: unequal stacks).
 * Five Card Draw: a bot's LIGHT re-raise (a hand that fails the stack-off range) is at most
 * FIVE_DRAW_LIGHT_RERAISE_FRACTION of the shortest live stack whose shove commits it (lightRaiseDepth), not of its
 * own stack. Fix round 3's review fix-up made a 100 BB shove commit a 400 BB bot (FIVE_DRAW_ALLIN_COMMIT_BB), but a
 * 400 BB MANIAC still re-raised light up to 40 BB (10% of its own stack) and then folded to the shove: opening
 * 3 BB with any five cards and shoving over every re-raise won +894 BB/100 vs MANIAC x4 at 400 BB (cdb31dd -88,
 * live 0dc1b96 -165), measured over whole hands. Real tables and the real decideAction, deterministic.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`deep-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const same = (a: any, b: any) => a.rank === b.rank && a.suit === b.suit;
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const JUNK = ['9h 7d 5c 3s 2h', 'Jh 8d 6c 4s 2c', 'Th 8d 5c 4s 2d', 'Qh 9d 6c 4s 3h'];

/**
 * Five Card Draw, 6 seats at 25/50: seat 3 (UTG, first to act) is a human with `heroBB`, every bot `botBB`. The
 * human opens to 3 BB; the bot next to act (seat 4) holds `cards` and decides as a MANIAC (`diff`).
 */
function maniacVsOpen(cards: any[], heroBB: number, botBB: number, diff: string): any {
  const t = new FiveCardDrawTable({ tableId: 'deep', tableName: 'deep', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
  for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 3 ? 'human-deep-' : 'ai-deep-') + i, i !== 3);
  for (let i = 0; i < 6; i++) t.seats[i].chipCount = (i === 3 ? heroBB : botBB) * 50;
  t.startNewHand();
  expect(t.activeSeatIndex).toBe(3);
  expect(t.playerRaise(3, 150)).toBe(true);
  const me = t.activeSeatIndex; expect(me).toBe(4);
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  return AI.decideAction(t, me, { ...AI.generateRandomProfile(diff), archetype: 'MANIAC', difficulty: diff });
}

describe('fix round 4 (unequal stacks): a deep bot sizes a light re-raise against the shortest stack that can shove over it', () => {
  it('a 400 BB MANIAC re-raises a 100 BB human\'s 3 BB open with junk to at most 10 BB (10% of 100 BB), every difficulty (9da6450: up to 12 BB)', () => {
    const restore = detEnv(4301);
    try {
      const big: string[] = []; let raises = 0, n = 0;
      for (const h of JUNK) for (const diff of DIFFS) for (let k = 0; k < 15; k++) {
        const d = maniacVsOpen(C(h), 100, 400, diff); n++;
        if (d.action === PlayerAction.Raise) raises++;
        if (d.action === PlayerAction.AllIn || (d.action === PlayerAction.Raise && d.raiseAmount > 500)) big.push(`${h} ${diff} ${d.action} ${d.raiseAmount}`);
      }
      expect(n).toBe(4 * 4 * 15);
      expect(raises).toBeGreaterThan(0);   // it still re-raises light, small
      expect(big).toEqual([]);
    } finally { restore(); }
  }, 120_000);

  it('CONTROL: with every stack at 400 BB the same junk re-raises are sized against 400 BB (some go over 10 BB), and at 100 BB all are at most 10 BB', () => {
    const restore = detEnv(4302);
    try {
      let over10deep = 0, over10eq = 0;
      for (const h of JUNK) for (const diff of DIFFS) for (let k = 0; k < 15; k++) {
        const a = maniacVsOpen(C(h), 400, 400, diff);
        if (a.action === PlayerAction.Raise && a.raiseAmount > 500) over10deep++;
        const b = maniacVsOpen(C(h), 100, 100, diff);
        if (b.action === PlayerAction.AllIn || (b.action === PlayerAction.Raise && b.raiseAmount > 500)) over10eq++;
      }
      expect(over10deep).toBeGreaterThan(0);
      expect(over10eq).toBe(0);
    } finally { restore(); }
  }, 120_000);
});

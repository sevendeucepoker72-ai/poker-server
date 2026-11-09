/**
 * tests/studDrawLaterRounds.test.ts (2026-11 bots review, fix round 4: studdraw MEAS-1 / EXPLOIT-1, MEAS-2 / EXPLOIT-2).
 * The rounds after the first, Stud / Draw only (postFlopStrategy behind studDrawKindOfTable):
 *  1. Five Card Draw after the draw: a call of the pot or more that commits a third of the depth at risk needs a
 *     stack-off hand by made-hand class (FIVE_DRAW_POST_STACKOFF_CLASS). The later-round strength is the pot share
 *     vs the bettor's STARTING range, so a 100 BB shove after the draw was priced like a small bet: NITs called it
 *     with one pair (32 of 103 callers; live 0dc1b96 0 of 14) and limping any five cards, then shoving two pair or
 *     better after the draw, won +180 BB/100 vs NIT x4 and MANIAC x4 (live -121 / -97) over whole hands.
 *  2. Fixed limit: facing ONE bet, a NIT / ROCK / MANIAC whose pot share clears the price calls
 *     (STUD_DRAW_FL_CALL_MARGIN). The NIT folded everything under 0.55 to one bet: calling the first round with any
 *     hand, betting when checked to and folding to any bet won +83 BB/100 vs NIT x4 in Badugi (live -49).
 * Real tables and the real decideAction, deterministic (seeded Math.random, frozen Date.now, seeded deck).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction, GamePhase } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const { BadugiTable } = require('../src/game/variants/BadugiTable');
const { SevenStudTable } = require('../src/game/variants/SevenStudTable');
const AI = require('../src/ai/AIPlayer');
const SDS = require('../src/ai/studDrawStrength');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`later-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const live = (o: any = {}) => ({ tableId: 'later', tableName: 'later', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000, ...o });
const make: Record<string, () => any> = {
  'five-card-draw': () => new FiveCardDrawTable(live(), false), 'triple-draw': () => new FiveCardDrawTable(live(), true),
  badugi: () => new BadugiTable(live()), 'seven-stud': () => new SevenStudTable(live({ ante: 5 }), false, false),
  'stud-hi-lo': () => new SevenStudTable(live({ ante: 5 }), false, true), razz: () => new SevenStudTable(live({ ante: 5 }), true, false),
};
const ARCH = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const prof = (a: string, diff: string) => ({ ...AI.generateRandomProfile(diff), archetype: a, difficulty: diff });
const same = (a: any, b: any) => a.rank === b.rank && a.suit === b.suit;
const DRAW = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];

/** Plays the table to the next betting round: everyone checks / calls the round, then stands pat at the draw. */
function checkThrough(t: any, stopPhase: string): void {
  let g = 0;
  while (t.isHandInProgress() && t.currentPhase !== stopPhase && g++ < 200) {
    if (DRAW.includes(t.currentPhase)) {
      for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
      continue;
    }
    const a = t.activeSeatIndex; if (a < 0) break;
    if (!t.playerCheck(a)) t.playerCall(a);
  }
}

/**
 * Five Card Draw, 5 seats at 25/50: seat 0 a human with 100 BB, the bots `botBB` each. Everyone limps / checks the
 * first round and stands pat; after the draw the seats before the human check, the human moves all-in (100 BB into
 * a 5 BB pot) and the bot to act next holds `cards` (a seat that held one of them takes one of the bot's own cards
 * instead, so no card is dealt twice). null when the deal does not take that shape.
 */
function postDrawShove(cards: any[], botBB: number): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-later-' : 'ai-later-') + i, i !== 0);
  for (let i = 1; i < 5; i++) t.seats[i].chipCount = botBB * 50;
  if (!t.startNewHand()) return null;
  checkThrough(t, GamePhase.Bet2);
  let g = 0;
  while (t.currentPhase === GamePhase.Bet2 && t.activeSeatIndex > 0 && g++ < 10) t.playerCheck(t.activeSeatIndex);
  if (t.currentPhase !== GamePhase.Bet2 || t.activeSeatIndex !== 0) return null;
  expect(t.playerAllIn(0)).toBe(true);
  const me = t.activeSeatIndex; if (me <= 0) return null;
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  const all = t.seats.flatMap((x: any) => x.holeCards);
  expect(all.every((c: any, i: number) => c && !all.some((d: any, j: number) => j !== i && same(c, d)))).toBe(true);
  return { t, me };
}

describe('fix round 4 (MEAS-1 / EXPLOIT-1): Five Card Draw after the draw, a call that commits the stack needs a stack-off hand', () => {
  const ONE_PAIR = ['Ah Ad Kc Qs 9h', 'Kh Kd Ac Js 8h', 'Qh Qd Ac Ks 7h'];
  const LOW_TWO_PAIR = ['9h 9d 5c 5s Kh', 'Jh Jd 3c 3s Ah'];
  for (const botBB of [100, 400]) {
    it(`one pair (A-A, K-K, Q-Q) never calls a 100 BB shove after the draw, bots at ${botBB} BB, every archetype and difficulty (cdb31dd: NIT / TAG called it)`, () => {
      const restore = detEnv(4101 + botBB);
      try {
        const calls: string[] = []; let n = 0;
        for (const h of ONE_PAIR) for (const a of ARCH) for (const diff of DIFFS) {
          for (let k = 0, got = 0; got < 3 && k < 30; k++) {
            const r = postDrawShove(C(h), botBB); if (!r) continue; got++; n++;
            const d = AI.decideAction(r.t, r.me, prof(a, diff));
            if (d.action !== PlayerAction.Fold) calls.push(`${h} ${a}/${diff} ${d.action}`);
          }
        }
        expect(n).toBe(3 * 7 * 4 * 3);
        expect(calls).toEqual([]);
      } finally { restore(); }
    }, 300_000);
  }

  it('two pair below aces up never calls it for NIT / ROCK / TAG / LAG; trips or better is never folded by the class gate', () => {
    const restore = detEnv(4103);
    try {
      const calls: string[] = []; let n = 0;
      for (const h of LOW_TWO_PAIR) for (const a of ['NIT', 'ROCK', 'TAG', 'LAG']) for (const diff of DIFFS) {
        for (let k = 0, got = 0; got < 3 && k < 30; k++) {
          const r = postDrawShove(C(h), 100); if (!r) continue; got++; n++;
          const d = AI.decideAction(r.t, r.me, prof(a, diff));
          if (d.action !== PlayerAction.Fold) calls.push(`${h} ${a}/${diff} ${d.action}`);
        }
      }
      expect(n).toBe(2 * 4 * 4 * 3);
      expect(calls).toEqual([]);
      for (const h of ['7h 7d 7c Ks 2h', 'Ah Ad As 9s 4h', '5h 6d 7c 8s 9h', 'Kh Kd Ks 4s 4h']) expect([h, AI.fiveDrawMadeClass(C(h)) >= 4]).toEqual([h, true]);
      for (const a of ARCH) expect([a, AI.FIVE_DRAW_POST_STACKOFF_CLASS[a] <= 4]).toEqual([a, true]);
    } finally { restore(); }
  }, 300_000);

  it('fiveDrawMadeClass orders the made hands: no pair < one pair < two pair < aces up < trips < straight or better (pure)', () => {
    const cases: [string, number][] = [
      ['Ah Kd 9c 7s 3h', 0], ['Ah Ad 9c 7s 3h', 1], ['Kh Kd Qc Qs 3h', 2], ['Ah Ad 2c 2s 3h', 3], ['2h 2d 2c 7s 3h', 4],
      ['Ah 2d 3c 4s 5h', 5], ['9h Td Jc Qs Kh', 5], ['Ah Kh 9h 7h 3h', 5], ['2h 2d 2c 3s 3h', 5], ['9h 9d 9c 9s 3h', 5],
    ];
    for (const [h, c] of cases) expect([h, AI.fiveDrawMadeClass(C(h))]).toEqual([h, c]);
    expect(AI.fiveDrawStackOffPremium(C('Ah Ad 2c 2s 3h'))).toBe(true);
    expect(AI.fiveDrawStackOffPremium(C('Kh Kd Qc Qs 3h'))).toBe(false);
  });
});

/**
 * Fixed limit, heads-up after the first round: the human completes / raises first in, every bot folds but the next
 * one to act (the big blind in the draw games), which calls; both stand pat; on the next round the bot checks if it
 * is first, the human bets ONE bet, and the bot decides. null when the deal does not take that shape.
 */
const FIRST = [GamePhase.PreFlop, GamePhase.ThirdStreet];
function oneBetSpot(v: string): { t: any; me: number } | null {
  const t = make[v]();
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-later-' : 'ai-later-') + i, i !== 0);
  if (!t.startNewHand()) return null;
  let g = 0, bot = -1, raised = false;
  while (FIRST.includes(t.currentPhase) && g++ < 40) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    const ca = t.getCallAmount(t.seats[a]);
    if (a === 0) { if (!raised) { if (!t.playerRaise(0, t.getMinRaise())) return null; raised = true; } else if (!t.playerCall(0)) t.playerCheck(0); continue; }
    if (!raised) { if (ca === 0) t.playerCheck(a); else t.playerFold(a); continue; }
    if (bot < 0) { bot = a; if (!t.playerCall(a)) return null; continue; }
    if (a === bot) { if (!t.playerCall(a)) t.playerCheck(a); continue; }
    if (ca === 0) t.playerCheck(a); else t.playerFold(a);
  }
  if (bot < 0 || !t.isHandInProgress()) return null;
  g = 0;
  while (DRAW.includes(t.currentPhase) && g++ < 10) {
    for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
  }
  if (!t.isHandInProgress()) return null;
  if (t.activeSeatIndex === bot && !t.playerCheck(bot)) return null;
  if (t.activeSeatIndex !== 0 || !t.playerRaise(0, t.getMinRaise())) return null;
  if (t.activeSeatIndex !== bot || t.raisesThisStreet !== 1) return null;
  return { t, me: bot };
}
function foldRate(v: string, a: string, perDiff: number): { folds: number; n: number } {
  let folds = 0, n = 0;
  for (const diff of DIFFS) {
    for (let k = 0, got = 0; got < perDiff && k < perDiff * 5; k++) {
      const r = oneBetSpot(v); if (!r) continue; got++; n++;
      if (AI.decideAction(r.t, r.me, prof(a, diff)).action === PlayerAction.Fold) folds++;
    }
  }
  return { folds, n };
}

describe('fix round 4 (MEAS-2 / EXPLOIT-2): fixed limit, the rounds after the first, ONE bet is called by the price', () => {
  it.each([['badugi'], ['triple-draw'], ['seven-stud'], ['stud-hi-lo'], ['razz']])('%s: a NIT heads-up facing one bet folds at most half the time, every difficulty pooled (cdb31dd: 84-99%)', (v) => {
    const restore = detEnv(4201);
    try {
      const r = foldRate(v, 'NIT', 40);
      process.stdout.write(`NIT facing one bet after the first round, ${v}: folds ${r.folds}/${r.n}\n`);
      expect(r.n).toBe(160);
      expect(r.folds / r.n).toBeLessThanOrEqual(0.5);
    } finally { restore(); }
  }, 300_000);

  it.each([['badugi'], ['triple-draw']])('%s: a ROCK heads-up facing one bet folds at most 30%, every difficulty pooled (cdb31dd: 54-65%)', (v) => {
    const restore = detEnv(4202);
    try {
      const r = foldRate(v, 'ROCK', 40);
      process.stdout.write(`ROCK facing one bet after the first round, ${v}: folds ${r.folds}/${r.n}\n`);
      expect(r.n).toBe(160);
      expect(r.folds / r.n).toBeLessThanOrEqual(0.3);
    } finally { restore(); }
  }, 300_000);

  it('the margin over the price is 0.05 (pinned)', () => {
    expect(AI.STUD_DRAW_FL_CALL_MARGIN).toBe(0.05);
  });
});

/**
 * Fix round 4 (unequal stacks): Five Card Draw, 5 seats at 25/50, seat 0 a human with `heroBB`, the bots 100 BB. The
 * first actor raises to 10 BB and everyone calls (a 50 BB pot), all stand pat, the seats before the human check after
 * the draw and the human moves all-in for his last `heroBB - 10` BB; the bot to act next holds `cards` (planted as
 * postDrawShove does). null when the deal does not take that shape.
 */
function postDrawShortShove(cards: any[], heroBB: number): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-later-' : 'ai-later-') + i, i !== 0);
  t.seats[0].chipCount = heroBB * 50;
  if (!t.startNewHand()) return null;
  let g = 0, raised = false;
  while (t.currentPhase === GamePhase.PreFlop && g++ < 20) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    if (!raised) { if (!t.playerRaise(a, 500)) return null; raised = true; continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  checkThrough(t, GamePhase.Bet2);
  g = 0;
  while (t.currentPhase === GamePhase.Bet2 && t.activeSeatIndex > 0 && g++ < 10) t.playerCheck(t.activeSeatIndex);
  if (t.currentPhase !== GamePhase.Bet2 || t.activeSeatIndex !== 0 || t.seats.some((x: any) => x.folded)) return null;
  expect(t.playerAllIn(0)).toBe(true);
  const me = t.activeSeatIndex; if (me <= 0) return null;
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  return { t, me };
}

describe('fix round 4 (unequal stacks): Five Card Draw after the draw, a smaller all-in that commits the depth at risk needs two pair', () => {
  it('one pair (A-A, K-K, Q-Q) never calls a 40 BB human\'s 30 BB all-in into a 50 BB pot (price ~0.27), every archetype and difficulty (05248ab / cdb31dd / 2b5ac52 called it)', () => {
    const restore = detEnv(4111);
    try {
      const calls: string[] = []; let n = 0;
      for (const h of ['Ah Ad Kc Qs 9h', 'Kh Kd Ac Js 8h', 'Qh Qd Ac Ks 7h']) for (const a of ARCH) for (const diff of DIFFS) {
        for (let k = 0, got = 0; got < 2 && k < 30; k++) {
          const r = postDrawShortShove(C(h), 40); if (!r) continue; got++; n++;
          const ca = r.t.getCallAmount(r.t.seats[r.me]), pot = r.t.getTotalPot();
          expect(ca).toBe(1500);
          expect(ca / (pot + ca)).toBeGreaterThanOrEqual(0.25);
          expect(ca / (pot + ca)).toBeLessThan(1 / 3);
          const d = AI.decideAction(r.t, r.me, prof(a, diff));
          if (d.action !== PlayerAction.Fold) calls.push(`${h} ${a}/${diff} ${d.action}`);
        }
      }
      expect(n).toBe(3 * 7 * 4 * 2);
      expect(calls).toEqual([]);
    } finally { restore(); }
  }, 300_000);

  it('the small all-in rule: from a third of the pot (price 0.25), two pair (pinned)', () => {
    expect([AI.FIVE_DRAW_POST_ALLIN_MIN_PO, AI.FIVE_DRAW_POST_ALLIN_CLASS]).toEqual([0.25, 2]);
  });
});

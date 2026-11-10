/**
 * tests/studDrawLaterRounds.test.ts (2026-11 bots review, fix round 4: studdraw MEAS-1 / EXPLOIT-1, MEAS-2 / EXPLOIT-2).
 * The rounds after the first, Stud / Draw only (postFlopStrategy behind studDrawKindOfTable):
 *  1. Five Card Draw after the draw: a call of the pot or more that commits a third of the depth at risk needs a
 *     stack-off hand by made-hand class (FIVE_DRAW_POST_STACKOFF_CLASS). The later-round strength is the pot share
 *     vs the bettor's STARTING range, so a 100 BB shove after the draw was priced like a small bet: NITs called it
 *     with one pair (32 of 103 callers; live 0dc1b96 0 of 14) and limping any five cards, then shoving two pair or
 *     better after the draw, won +180 BB/100 vs NIT x4 and MANIAC x4 (live -121 / -97) over whole hands.
 *     Review fix-ups: the hand needed rises smoothly with the price (fiveDrawPostFolds), eases against a SHORT stack,
 *     and an OVERCALL needs more than a lone call (FIVE_DRAW_POST_OVERCALL).
 *     Re-review fix-ups: no step at a third of the depth (FIVE_DRAW_POST_COMMIT_RAMP) nor at 15 BB of depth
 *     (FIVE_DRAW_POST_SHALLOW_RAMP_BB); an all-in asks one pair by rank up to two pair unless it raises this seat's
 *     own bet; FISH / CALLING_STATION and a MANIAC that checked read the price lower; every LEAD is capped at
 *     FIVE_DRAW_POST_LEAD_CAP of the depth (one size for every hand), the depth skips opponents under 15 BB behind,
 *     and a MANIAC leads polarized (FIVE_DRAW_POST_MANIAC_LEAD), never a lower pair (fix-up 4).
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
function postDrawShove(cards: any[], botBB: number, heroBB = 100): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-later-' : 'ai-later-') + i, i !== 0);
  for (let i = 1; i < 5; i++) t.seats[i].chipCount = botBB * 50;
  t.seats[0].chipCount = heroBB * 50;
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

// Re-review fix-ups (STUDDRAW-RR1-MEASUREMENT-1 / R4R-EXPLOIT-2): fix round 4 asked two pair of every such all-in
// from 0.25, so every archetype folded A-A to it and shoving ANY five cards into a checked pot after the draw with
// 25-30 BB won +97 to +100 BB/100 vs MANIAC x4 (live -224 to -236). It now asks one pair by rank (the all-in ramp).
describe('fix round 4 (unequal stacks) / re-review fix-ups: Five Card Draw after the draw, a smaller all-in that commits the depth at risk asks one pair by rank', () => {
  it('a 40 BB human\'s 30 BB all-in into a 50 BB pot (price ~0.27): the class gate never folds A-A / K-K / Q-Q (every archetype; cdfc8a1 folded every one pair) and still folds deuces for TAG / LAG / NIT / ROCK / MANIAC', () => {
    const restore = detEnv(4111);
    try {
      let n = 0;
      for (let k = 0; k < 30 && n < 1; k++) {
        const r = postDrawShortShove(C('Ah Ad Kc Qs 9h'), 40); if (!r) continue; n++;
        const ca = r.t.getCallAmount(r.t.seats[r.me]), pot = r.t.getTotalPot();
        expect(ca).toBe(1500);
        const po = ca / (pot + ca);
        expect(po).toBeGreaterThanOrEqual(0.25);
        expect(po).toBeLessThan(1 / 3);
        for (const a of ARCH) for (const h of ['Ah Ad Kc Qs 9h', 'Kh Kd Ac Js 8h', 'Qh Qd Ac Ks 7h']) expect([a, h, AI.fiveDrawPostFolds(C(h), po, a, true, 30)]).toEqual([a, h, false]);
        for (const a of ['TAG', 'LAG', 'NIT', 'ROCK', 'MANIAC']) for (const h of ['2h 2d Ac Ks 7h']) expect([a, h, AI.fiveDrawPostFolds(C(h), po, a, true, 30)]).toEqual([a, h, true]);
      }
      expect(n).toBe(1);
    } finally { restore(); }
  }, 300_000);

  it('the all-in ramp: every pair from a third of the pot (price 0.25), two pair at FIVE_DRAW_POST_CLASS_PO[0] (pinned)', () => {
    expect([AI.FIVE_DRAW_POST_ALLIN_MIN_PO, AI.FIVE_DRAW_POST_ALLIN_CLASS, AI.FIVE_DRAW_POST_CLASS_PO[0]]).toEqual([0.25, 2, 0.36]);
  });

  it('heads-up after the draw, a 20 / 30 BB all-in into a 30 BB pot: a FISH / CALLING_STATION / MANIAC with A-A or Q-Q one pair does not fold every time (cdfc8a1: every archetype folded both every time)', () => {
    const restore = detEnv(4112);
    try {
      const out: string[] = []; let tot = 0, cont = 0;
      for (const heroBB of [35, 45]) for (const a of ['FISH', 'CALLING_STATION', 'MANIAC']) for (const h of ['Ah Ad Kc 9s 4h', 'Qh Qd Ac 9s 4h']) {
        let c = 0, m = 0;
        for (const diff of DIFFS) for (let k = 0, got = 0; got < 2 && k < 30; k++) {
          const r = headsUpPostDraw(C(h), 'shove', 1, 30, heroBB); if (!r) continue; got++; m++;
          if (AI.decideAction(r.t, r.me, prof(a, diff)).action !== PlayerAction.Fold) c++;
        }
        out.push(`${heroBB - 15} BB ${a} ${h.slice(0, 5)} ${c}/${m}`); tot += m; cont += c;
        expect([heroBB, a, h, m]).toEqual([heroBB, a, h, 8]);
        expect([heroBB, a, h, c > 0]).toEqual([heroBB, a, h, true]);
      }
      process.stdout.write(`HU all-in into 30 BB after the draw, continues: ${out.join(', ')}\n`);
      expect(cont / tot).toBeGreaterThanOrEqual(0.5);
    } finally { restore(); }
  }, 300_000);
});

/**
 * Fix round 4 review: Five Card Draw heads-up after the draw. Seat 0 (a human) raises to `potBB / 2` BB before the
 * draw and the bot (seat 1) calls, so the pot is `potBB` BB with `100 - potBB / 2` BB behind each; both stand pat.
 * 'face': the bot checks and the human bets `betFrac` of the pot (not an all-in); 'lead': the bot acts first (the
 * human checks if he is first); 'shove': the bot checks and the human (`heroBB`) moves all-in. The bot holds `cards`.
 * null when the deal does not take that shape.
 */
function headsUpPostDraw(cards: any[], spot: 'face' | 'lead' | 'shove', betFrac = 1, potBB = 40, heroBB = 100): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  t.sitDown(0, 'Hero', 5000, 'human-later-hu', false); t.sitDown(1, 'Bot', 5000, 'ai-later-hu', true);
  t.seats[0].chipCount = heroBB * 50;
  if (!t.startNewHand()) return null;
  let g = 0, raised = false;
  while (t.currentPhase === GamePhase.PreFlop && g++ < 10) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    if (!raised) { if (!t.playerRaise(a, (potBB / 2) * 50)) return null; raised = true; continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  g = 0;
  while (DRAW.includes(t.currentPhase) && g++ < 10) {
    for (const x of t.seats) if (x.state === 'occupied' && !x.folded && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
  }
  if (t.currentPhase !== GamePhase.Bet2 || t.getTotalPot() !== potBB * 50) return null;
  if (spot === 'lead') {
    if (t.activeSeatIndex === 0 && !t.playerCheck(0)) return null;
  } else {
    if (t.activeSeatIndex === 1 && !t.playerCheck(1)) return null;
    if (t.activeSeatIndex !== 0) return null;
    if (spot === 'shove' ? !t.playerAllIn(0) : !t.playerRaise(0, Math.floor(potBB * 50 * betFrac))) return null;
  }
  if (t.activeSeatIndex !== 1) return null;
  const spare = t.seats[1].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  t.seats[0].holeCards = t.seats[0].holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[1].holeCards = cards.map((c) => ({ ...c }));
  return { t, me: 1 };
}

describe('fix round 4 review (MEASUREMENT-1 / EXPLOIT-1): Five Card Draw after the draw, no step at a pot-size bet that is not an all-in', () => {
  it('heads-up, 40 BB pot, 80 BB behind: two pair (K-K-Q-Q) facing an exact-pot bet is never folded by the class gate, every archetype but the NIT (c2b81d4: TAG / LAG / FISH / MANIAC folded it every time)', () => {
    const restore = detEnv(4121);
    try {
      const folds: string[] = []; let n = 0;
      for (const a of ['TAG', 'LAG', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION']) for (const diff of DIFFS) {
        for (let k = 0, got = 0; got < 3 && k < 30; k++) {
          const r = headsUpPostDraw(C('Kh Kd Qc Qs 3h'), 'face', 1); if (!r) continue; got++; n++;
          const ca = r.t.getCallAmount(r.t.seats[r.me]);
          expect(ca / (r.t.getTotalPot() + ca)).toBeCloseTo(1 / 3, 3);
          if (AI.decideAction(r.t, r.me, prof(a, diff)).action === PlayerAction.Fold) folds.push(`${a}/${diff}`);
        }
      }
      expect(n).toBe(6 * 4 * 3);
      expect(folds).toEqual([]);
    } finally { restore(); }
  }, 300_000);

  // Re-review fix-ups: with FISH / CALLING_STATION reading the price lower (FIVE_DRAW_POST_LOOSE_PO) their pair ramp
  // crosses the pot size, so one hand may flip there; what must not come back is a step (c2b81d4 folded every hand
  // under aces up at the pot and none at 0.95).
  it('a bet just under the pot and one just over it get nearly the same answer from the class gate (0.95 / 1.0 / 1.05 pot): over every one pair and two pair, at most two hands differ, every archetype', () => {
    const hands: string[] = [];
    for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) hands.push(`${r}h ${r}d ${r === 'A' ? 'K' : 'A'}c ${r === '9' ? '8' : '9'}s ${r === '4' ? '3' : '4'}h`);
    for (const t of ['3', '5', '7', '9', 'J', 'K']) hands.push(`${t}h ${t}d 2c 2s ${t === 'K' ? 'Q' : 'K'}h`);
    for (const a of ARCH) {
      const folded = (po: number) => hands.filter((h) => AI.fiveDrawPostFolds(C(h), po, a, false, 80));
      const f95 = folded(0.95 / 2.9), f100 = folded(1 / 3), f105 = folded(1.05 / 3.1);
      expect([a, f105.length - f95.length <= 2, f100.length - f95.length <= 2, f105.length >= f95.length]).toEqual([a, true, true, true]);
    }
  });

  it('fiveDrawGateScore (pure): one pair by rank, two pair by its top pair, then aces up / trips / straights', () => {
    const cases: [string, number][] = [
      ['Ah Kd 9c 7s 3h', 0], ['2h 2d 9c 7s 3h', 1], ['Ah Ad 9c 7s 3h', 1 + 12 / 13], ['3h 3d 2c 2s 9h', 2],
      ['Kh Kd Qc Qs 3h', 2 + 10 / 11], ['Ah Ad 2c 2s 3h', 3], ['2h 2d 2c 7s 3h', 4], ['9h Td Jc Qs Kh', 5],
    ];
    for (const [h, v] of cases) expect([h, AI.fiveDrawGateScore(C(h))]).toEqual([h, v]);
  });

  it('fiveDrawPostFolds (pure): the hand needed rises smoothly with the price, an all-in and any other bet alike from a 1.3x-pot bet on, never above the stack-off class', () => {
    const P = (h: string, po: number, a = 'TAG', shove = false, depth = 80) => AI.fiveDrawPostFolds(C(h), po, a, shove, depth);
    // a bet that is not an all-in
    expect(P('2h 2d 9c 7s 3h', 0.20)).toBe(false);            // every pair vs a third of the pot
    expect(P('2h 2d 9c 7s 3h', 0.25)).toBe(true);             // deuces fold half-pot ...
    expect(P('Th Td 9c 7s 3h', 0.25)).toBe(false);            // ... tens continue (rank 10 >= 8.5)
    expect(P('Ah Ad 9c 7s 3h', 0.29)).toBe(false);
    expect(P('Ah Ad 9c 7s 3h', 0.30)).toBe(true);             // no pair continues from three quarters of the pot
    expect(P('Ah Kd 9c 7s 3h', 0.15)).toBe(true);             // no pair always folds a committing bet
    expect(P('3h 3d 2c 2s 9h', 0.35)).toBe(false);            // any two pair up to ~1.3x the pot
    expect(P('9h 9d 5c 5s Kh', 0.40)).toBe(true);             // vs 2x the pot: two pair needs nines-up+ ... (need 2.67)
    expect(P('Kh Kd Qc Qs 3h', 0.40)).toBe(false);            // ... kings up continue
    expect(P('Kh Kd Qc Qs 3h', 0.42)).toBe(true);             // from ~2.6x the pot: aces up (TAG's stack-off class)
    expect(P('Ah Ad Kc Ks 3h', 0.42)).toBe(false);
    expect(P('Ah Ad Kc Ks 3h', 0.44, 'NIT')).toBe(true);      // NIT: rising to trips (need 3.5)
    expect(P('Ah Ad Kc Ks 3h', 0.40, 'NIT')).toBe(false);
    expect(P('3h 3d 2c 2s 9h', 0.48, 'CALLING_STATION')).toBe(false);   // CALLING_STATION: two pair at any price
    // an all-in (or a call that puts the bot all-in)
    expect(P('Kh Kd Qc Qs 3h', 1 / 3, 'TAG', true)).toBe(false);   // a pot-size all-in: two pair (c2b81d4: aces up)
    expect(P('Ah Ad 9c 7s 3h', 0.30, 'TAG', true)).toBe(false);    // a smaller one: the all-in ramp, eights or better at 0.30 (re-review fix-ups; cdfc8a1: two pair)
    expect(P('5h 5d 9c 7s 3h', 0.30, 'TAG', true)).toBe(true);     // ... fives fold (need 1.45)
    expect(P('Ah Ad 9c 7s 3h', 0.24, 'TAG', true)).toBe(false);    // under a third of the pot: the strategy decides
    expect(P('4h 4d 3c 3s 9h', 0.39, 'TAG', true)).toBe(true);     // vs ~2x the pot the same ramp as any bet
    expect(P('9h 9d 5c 5s Kh', 0.39, 'TAG', true)).toBe(false);
    expect(P('Ah Ad 9c 7s 3h', 0.31, 'TAG', true, 10)).toBe(false); // under FIVE_DRAW_POST_SHALLOW_RAMP_BB[0]: no gate
    // the all-in gate phases in with the depth (no step at 15 BB: cdfc8a1 folded A-A there and nothing at 14)
    for (const d of [13, 14, 15, 16]) expect([d, P('Th Td 9c 7s 3h', 1 / 3, 'TAG', true, d)]).toEqual([d, false]);
    expect(P('2h 2d 9c 7s 3h', 1 / 3, 'TAG', true, 29)).toBe(true);
    // ... and is whole from 20 BB: a 25 BB all-in into 30 BB (price 0.31) folds the pairs under eights, jacks continue
    // (ab51c1b ended the ramp at 33 BB: every pair continued, and shoving two pair or better with 30 BB won +54 BB/100 vs MANIAC x4)
    for (const a of ['TAG', 'LAG', 'MANIAC']) expect([a, P('5h 5d 9c 7s 3h', 0.3125, a, true, 25), P('Jh Jd 9c 7s 3h', 0.3125, a, true, 25)]).toEqual([a, true, false]);
    // FISH / CALLING_STATION read the price lower (FIVE_DRAW_POST_LOOSE_PO): vs 0.75 pot sevens fold for a FISH, eights continue, any pair for a CALLING_STATION; TAG two pair
    expect([P('7h 7d 9c 5s 3h', 0.30, 'FISH'), P('8h 8d 9c 5s 3h', 0.30, 'FISH'), P('2h 2d 9c 5s 3h', 0.30, 'CALLING_STATION'), P('Ah Ad 9c 5s 3h', 0.30, 'TAG')]).toEqual([true, false, false, true]);
    expect(P('Ah Ad Kc Ks 3h', 0.44, 'NIT', true, 19)).toBe(false); // under FIVE_DRAW_ALLIN_COMMIT_BB: aces up is enough
    expect(P('Ah Ad Kc Ks 3h', 0.44, 'NIT', true, 80)).toBe(true);
    // a 100 BB shove into a limped pot (price ~0.48): the stack-off class, as fix round 4 made it (MEAS-1)
    for (const a of ['TAG', 'LAG', 'FISH', 'MANIAC']) expect([a, P('Kh Kd Qc Qs 3h', 0.48, a, true)]).toEqual([a, true]);
    for (const a of ['NIT', 'ROCK']) expect([a, P('Ah Ad Kc Ks 3h', 0.48, a, true), P('2h 2d 2c 7s 3h', 0.48, a, true)]).toEqual([a, true, false]);
  });

  it('the price bands and the shallow depth are pinned', () => {
    expect([...AI.FIVE_DRAW_POST_CLASS_PO]).toEqual([0.36, 0.42, 0.46]);
    expect([...AI.FIVE_DRAW_POST_PAIR_PO]).toEqual([0.20, 0.30]);
    expect(AI.FIVE_DRAW_POST_SHALLOW_BB).toBe(15);
    expect([...AI.FIVE_DRAW_POST_SHALLOW_RAMP_BB]).toEqual([12, 20]);
    expect([...AI.FIVE_DRAW_POST_COMMIT_RAMP]).toEqual([1 / 6, 1 / 3]);
    expect(AI.FIVE_DRAW_POST_LOOSE_PO).toEqual({ NIT: 0, ROCK: 0, TAG: 0, LAG: 0, MANIAC: 0, FISH: 0.06, CALLING_STATION: 0.10 });
  });

  it('heads-up, a 60 BB human\'s pot-size ALL-IN after the draw (40 BB into a 40 BB pot): two pair continues for TAG / LAG / FISH / MANIAC (c2b81d4 and 977fd0e asked aces up: betting 1.5x the pot with any hand won +210 to +500 BB/100 vs MANIAC x4)', () => {
    const restore = detEnv(4122);
    try {
      const folds: string[] = []; let n = 0;
      for (const a of ['TAG', 'LAG', 'FISH', 'MANIAC']) for (const diff of DIFFS) {
        for (let k = 0, got = 0; got < 3 && k < 30; k++) {
          const r = headsUpPostDraw(C('Kh Kd Qc Qs 3h'), 'shove', 1, 40, 60); if (!r) continue; got++; n++;
          const ca = r.t.getCallAmount(r.t.seats[r.me]);
          expect(ca).toBe(2000);
          expect(ca / (r.t.getTotalPot() + ca)).toBeCloseTo(1 / 3, 3);
          if (AI.decideAction(r.t, r.me, prof(a, diff)).action === PlayerAction.Fold) folds.push(`${a}/${diff}`);
        }
      }
      expect(n).toBe(4 * 4 * 3);
      expect(folds).toEqual([]);
    } finally { restore(); }
  }, 300_000);
});

/**
 * Fix round 4 review (REGRESSION-1): a SHORT human after the draw. postDrawShove with `heroBB` (everyone limps, the
 * human moves all-in into the ~5 BB pot); postDrawPotBet: the human (heroBB) opens to 3 BB, every bot calls, all
 * stand pat, the bots before him check and he bets exactly the pot (not an all-in); the next bot holds `cards` (with
 * `overcall`, the next bot calls first and the one after it holds `cards`).
 */
function postDrawPotBet(cards: any[], heroBB: number, overcall = false): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-later-' : 'ai-later-') + i, i !== 0);
  t.seats[0].chipCount = heroBB * 50;
  if (!t.startNewHand()) return null;
  let g = 0, opened = false;
  while (t.currentPhase === GamePhase.PreFlop && g++ < 30) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    if (a === 0 && !opened) { if (!t.playerRaise(0, 150)) return null; opened = true; continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  if (!opened) return null;
  g = 0;
  while (DRAW.includes(t.currentPhase) && g++ < 10) for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
  g = 0; while (t.currentPhase === GamePhase.Bet2 && t.activeSeatIndex > 0 && g++ < 10) t.playerCheck(t.activeSeatIndex);
  if (t.currentPhase !== GamePhase.Bet2 || t.activeSeatIndex !== 0) return null;
  if (!t.playerRaise(0, t.getTotalPot())) return null;
  if (overcall) { const c = t.activeSeatIndex; if (c <= 0 || !t.playerCall(c)) return null; }   // the next bot calls first
  const me = t.activeSeatIndex; if (me <= 0) return null;
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  return { t, me };
}
function shortHuman(spot: (c: any[]) => { t: any; me: number } | null, h: string, archs: string[], per: number): { cont: number; n: number; out: string[] } {
  let cont = 0, n = 0; const out: string[] = [];
  for (const a of archs) {
    let c = 0, m = 0;
    for (const diff of DIFFS) for (let k = 0, got = 0; got < per && k < per * 10; k++) {
      const r = spot(C(h)); if (!r) continue; got++; m++;
      if (AI.decideAction(r.t, r.me, prof(a, diff)).action !== PlayerAction.Fold) c++;
    }
    out.push(`${a} ${c}/${m}`); cont += c; n += m;
  }
  return { cont, n, out };
}

describe('fix round 4 review (REGRESSION-1): Five Card Draw after the draw, a SHORT human\'s bet is not a stack-off for the bots', () => {
  it('a 30 BB human\'s pot-size bet into a raised multiway pot (not an all-in): two pair (K-K-Q-Q) continues for TAG / FISH / MANIAC / CALLING_STATION (c2b81d4: only CALLING_STATION)', () => {
    const restore = detEnv(4131);
    try {
      const r = shortHuman((c) => postDrawPotBet(c, 30), 'Kh Kd Qc Qs 3h', ['TAG', 'FISH', 'MANIAC', 'CALLING_STATION'], 3);
      process.stdout.write(`30 BB human's pot bet, K-K-Q-Q: continues ${r.out.join(', ')}\n`);
      expect(r.n).toBe(4 * 4 * 3);
      expect(r.cont / r.n).toBeGreaterThanOrEqual(0.9);
    } finally { restore(); }
  }, 300_000);

  // The class gate no longer folds these (fiveDrawPostFolds); what a bot does is the strategy's own answer, as on
  // cdb31dd (a TAG / MANIAC still folds a pair of aces to the 5 BB all-in there: the later-round strength reads any
  // all-in as a strong range - studDrawRangeFloor, rounds 1-2).
  it('a 5 BB human\'s 4 BB all-in into a limped 5 BB pot: the class gate never folds a pair of aces (every archetype), and FISH / CALLING_STATION call it (c2b81d4: none)', () => {
    const restore = detEnv(4132);
    try {
      for (const a of ARCH) expect([a, AI.fiveDrawPostFolds(C('Ah Ad Kc Qs 9h'), 200 / 650, a, true, 4)]).toEqual([a, false]);
      const r = shortHuman((c) => postDrawShove(c, 100, 5), 'Ah Ad Kc Qs 9h', ['FISH', 'CALLING_STATION'], 3);
      process.stdout.write(`5 BB human's all-in, A-A: continues ${r.out.join(', ')}\n`);
      expect(r.n).toBe(2 * 4 * 3);
      expect(r.cont / r.n).toBeGreaterThanOrEqual(0.8);
    } finally { restore(); }
  }, 300_000);

  it('a 20 BB human\'s all-in into a limped pot (an overbet, price ~0.44): the class gate asks aces up of every archetype, so A-A-K-K is never folded by it, and a ROCK calls (c2b81d4: NIT / ROCK folded it every time)', () => {
    const restore = detEnv(4133);
    try {
      for (const a of ARCH) expect([a, AI.fiveDrawPostFolds(C('Ah Ad Kc Ks 3h'), 950 / 2150, a, true, 19)]).toEqual([a, false]);
      const r = shortHuman((c) => postDrawShove(c, 100, 20), 'Ah Ad Kc Ks 3h', ['ROCK'], 3);
      process.stdout.write(`20 BB human's all-in, A-A-K-K: continues ${r.out.join(', ')}\n`);
      expect(r.n).toBe(4 * 3);
      expect(r.cont / r.n).toBeGreaterThanOrEqual(0.9);
    } finally { restore(); }
  }, 300_000);
});

describe('fix round 4 review (REGRESSION-3): Five Card Draw after the draw, the bet gate (postFlopStrategy) keeps a weak hand from betting a third of the depth at risk', () => {
  it('heads-up, 40 BB pot, 80 BB behind, the bot first to act: a MANIAC / LAG with one pair or two pair below aces up never bets a third of the depth at risk (cdb31dd: MANIAC bet Q-Q every time); aces up still bets', () => {
    const restore = detEnv(4141);
    try {
      const big: string[] = []; let n = 0; const aBets: Record<string, number> = { MANIAC: 0, LAG: 0 }, aN: Record<string, number> = { MANIAC: 0, LAG: 0 };
      for (const a of ['MANIAC', 'LAG']) for (const diff of DIFFS) {
        for (const h of ['Qh Qd 9c 5s 2h', 'Ah Ad 9c 6s 3h', 'Kh Kd Qc Qs 3h']) {
          for (let k = 0, got = 0; got < 3 && k < 30; k++) {
            const r = headsUpPostDraw(C(h), 'lead'); if (!r) continue; got++; n++;
            const me = r.t.seats[r.me];
            const d = AI.decideAction(r.t, r.me, prof(a, diff));
            const put = d.action === PlayerAction.AllIn ? me.chipCount : d.action === PlayerAction.Raise ? d.raiseAmount - me.currentBet : 0;
            if (put >= (me.chipCount + me.currentBet) / 3) big.push(`${h} ${a}/${diff} ${d.action} ${put}`);
          }
        }
        for (let k = 0, got = 0; got < 3 && k < 30; k++) {
          const r = headsUpPostDraw(C('Ah Ad Kc Ks 3h'), 'lead'); if (!r) continue; got++; aN[a]++;
          const d = AI.decideAction(r.t, r.me, prof(a, diff));
          if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) aBets[a]++;
        }
      }
      expect(n).toBe(2 * 4 * 3 * 3);
      expect(big).toEqual([]);
      expect([aN.MANIAC, aN.LAG]).toEqual([4 * 3, 4 * 3]);
      expect(aBets.LAG / aN.LAG).toBeGreaterThanOrEqual(0.9);
      // fix-up 3: a MANIAC first to act checks (traps) a share of its kings or better (FIVE_DRAW_POST_MANIAC_MIX)
      expect(aBets.MANIAC / aN.MANIAC).toBeGreaterThanOrEqual(0.5);
    } finally { restore(); }
  }, 300_000);
});

describe('fix round 4 review fix-ups (MEASUREMENT-2): Five Card Draw after the draw, an OVERCALL needs more than a lone call', () => {
  it('fiveDrawPostFolds (pure): an overcall needs FIVE_DRAW_POST_OVERCALL[0] more and at least [1] (two pair), never above the stack-off class; a lone call is unchanged', () => {
    const P = (h: string, po: number, a = 'TAG', shove = false, depth = 37, over = false) => AI.fiveDrawPostFolds(C(h), po, a, shove, depth, over);
    expect([...AI.FIVE_DRAW_POST_OVERCALL]).toEqual([1, 2]);
    // a bet of the pot already called once: the overcall is priced 0.25
    expect([P('Qh Qd 9c 5s 2h', 0.25), P('Qh Qd 9c 5s 2h', 0.25, 'TAG', false, 37, true)]).toEqual([false, true]);
    expect([P('Ah Ad 9c 5s 2h', 0.25), P('Ah Ad 9c 5s 2h', 0.25, 'FISH', false, 37, true)]).toEqual([false, true]);
    expect([P('4h 4d 3c 3s 9h', 0.25), P('4h 4d 3c 3s 9h', 0.25, 'MANIAC', false, 37, true)]).toEqual([false, true]);
    expect(P('9h 9d 5c 5s Kh', 0.25, 'TAG', false, 37, true)).toBe(false);          // nines up: 2.55 >= 2.5
    // vs a pot-size bet (0.33) two pair below aces up overcalls only up to the stack-off class
    expect([P('Kh Kd Qc Qs 3h', 1 / 3), P('Kh Kd Qc Qs 3h', 1 / 3, 'TAG', false, 37, true)]).toEqual([false, true]);
    expect(P('Ah Ad Kc Ks 3h', 1 / 3, 'TAG', false, 37, true)).toBe(false);
    expect(P('Kh Kd Qc Qs 3h', 1 / 3, 'CALLING_STATION', false, 37, true)).toBe(false);   // its class is two pair
    expect(P('Ah Ad 9c 5s 2h', 0.25, 'CALLING_STATION', false, 37, true)).toBe(true);
    // a small all-in (under FIVE_DRAW_POST_ALLIN_MIN_PO): no gate for a lone call, two pair for an overcall
    expect([P('Ah Ad 9c 5s 2h', 0.2, 'TAG', true), P('Ah Ad 9c 5s 2h', 0.2, 'TAG', true, 37, true), P('3h 3d 2c 2s 9h', 0.2, 'TAG', true, 37, true)]).toEqual([false, true, false]);
    expect(P('Ah Ad 9c 5s 2h', 0.2, 'TAG', true, 10, true)).toBe(false);            // under FIVE_DRAW_POST_SHALLOW_BB: no gate
  });

  it('a 40 BB human\'s pot-size bet after the draw, already called by one bot: the next bot never overcalls with a pair of aces (every archetype) or with 4-4-3-3 / 7-7-5-5 (every archetype but the CALLING_STATION, whose class is two pair); ca66fff: FISH / CALLING_STATION overcalled every time', () => {
    const restore = detEnv(4151);
    try {
      const over: string[] = []; let n = 0;
      for (const h of ['Ah Ad Kc Qs 9h', '4h 4d 3c 3s 9h', '7h 7d 5c 5s Kh']) for (const a of ARCH) {
        if (a === 'CALLING_STATION' && h !== 'Ah Ad Kc Qs 9h') continue;
        for (const diff of DIFFS) for (let k = 0, got = 0; got < 3 && k < 30; k++) {
          const r = postDrawPotBet(C(h), 40, true); if (!r) continue; got++; n++;
          const ca = r.t.getCallAmount(r.t.seats[r.me]);
          expect(ca / (r.t.getTotalPot() + ca)).toBeCloseTo(0.25, 3);
          if (AI.decideAction(r.t, r.me, prof(a, diff)).action !== PlayerAction.Fold) over.push(`${h} ${a}/${diff}`);
        }
      }
      expect(n).toBe((7 + 6 + 6) * 4 * 3);
      expect(over).toEqual([]);
    } finally { restore(); }
  }, 300_000);

  it('CONTROL: K-K-Q-Q still overcalls it (TAG / LAG / FISH / MANIAC / CALLING_STATION), and the FIRST caller (no caller ahead) with 7-7-5-5 still calls (FISH / CALLING_STATION)', () => {
    const restore = detEnv(4152);
    try {
      const a1 = shortHuman((c) => postDrawPotBet(c, 40, true), 'Kh Kd Qc Qs 3h', ['TAG', 'LAG', 'FISH', 'MANIAC', 'CALLING_STATION'], 3);
      const a2 = shortHuman((c) => postDrawPotBet(c, 40), '7h 7d 5c 5s Kh', ['FISH', 'CALLING_STATION'], 3);
      process.stdout.write(`overcall K-K-Q-Q: ${a1.out.join(', ')} | first call 7-7-5-5: ${a2.out.join(', ')}\n`);
      expect([a1.n, a2.n]).toEqual([5 * 4 * 3, 2 * 4 * 3]);
      expect(a1.cont / a1.n).toBeGreaterThanOrEqual(0.9);
      expect(a2.cont / a2.n).toBeGreaterThanOrEqual(0.85);
    } finally { restore(); }
  }, 300_000);
});

/**
 * Review fix-ups (MEASUREMENT-2): Five Card Draw, 5 seats; seat 0 (a human with `heroBB`) opens to `openBB` BB, every bot
 * calls, all stand pat; after the draw the first seat to act is a bot holding `cards` (nothing to call). null otherwise.
 */
function postDrawMultiLead(cards: any[], heroBB = 40, openBB = 5): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-later-' : 'ai-later-') + i, i !== 0);
  t.seats[0].chipCount = heroBB * 50;
  if (!t.startNewHand()) return null;
  let g = 0, opened = false;
  while (t.currentPhase === GamePhase.PreFlop && g++ < 30) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    if (a === 0 && !opened) { if (!t.playerRaise(0, openBB * 50)) return null; opened = true; continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  if (!opened) return null;
  g = 0;
  while (DRAW.includes(t.currentPhase) && g++ < 10) for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
  if (t.currentPhase !== GamePhase.Bet2 || t.seats.some((x: any) => x.folded)) return null;
  const me = t.activeSeatIndex; if (me <= 0) return null;
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  return { t, me };
}

describe('fix round 4 review fix-ups (MEASUREMENT-2): Five Card Draw after the draw, the bet gate measures the depth on the SHORTEST live opponent', () => {
  // Re-review fix-ups: every lead is capped at FIVE_DRAW_POST_LEAD_CAP of the depth, aces up and trips included (they
  // bet a third of it on cdfc8a1, so a big lead told the class); they still bet.
  it('a 5-way pot with a 40 BB human (35 BB behind) and 100 BB bots: a LAG / MANIAC first to act never bets a third of the human\'s depth with Q-Q, 9-9-5-5 or K-K-Q-Q (b8cca39: LAG 9-11 of 12, MANIAC 2-6 of 12); aces up and trips still bet, under a third too', () => {
    const restore = detEnv(4161);
    try {
      const big: string[] = []; let n = 0, strong = 0, sN = 0;
      for (const a of ['LAG', 'MANIAC']) for (const diff of DIFFS) {
        for (const h of ['Qh Qd 9c 5s 2h', '9h 9d 5c 5s Kh', 'Kh Kd Qc Qs 3h', 'Ah Ad Kc Ks 3h', '2h 2d 2c 7s 3h']) {
          for (let k = 0, got = 0; got < 3 && k < 30; k++) {
            const r = postDrawMultiLead(C(h)); if (!r) continue; got++;
            const me = r.t.seats[r.me], hero = r.t.seats[0];
            const depth = Math.min(me.chipCount + me.currentBet, hero.chipCount + hero.currentBet);
            const d = AI.decideAction(r.t, r.me, prof(a, diff));
            const put = d.action === PlayerAction.AllIn ? me.chipCount : d.action === PlayerAction.Raise ? d.raiseAmount - me.currentBet : 0;
            if (put >= depth / 3) big.push(`${h} ${a}/${diff} ${d.action} ${put}`);
            if (h.startsWith('A') || h.startsWith('2')) { sN++; if (put > 0) strong++; continue; }
            n++;
          }
        }
      }
      expect([n, sN]).toEqual([2 * 4 * 3 * 3, 2 * 4 * 2 * 3]);
      expect(big).toEqual([]);
      expect(strong / sN).toBeGreaterThanOrEqual(0.7);
    } finally { restore(); }
  }, 300_000);
});

/**
 * Re-review fix-ups (STUDDRAW-R4F-REGRESSION-1): Five Card Draw, 5 seats at 25/50. Seat 0 (a human) opens to 3 BB.
 * 'hu': seat 0 holds `behindBB` BB behind after the open, the first bot to act calls and the rest fold (heads-up).
 * 'third': seat 0 holds 100 BB, every seat calls, and seat 3 is a short human left with `behindBB` BB behind.
 * All stand pat; after the draw the humans check and the first bot to act (nothing to call) holds `cards`.
 * null when the deal does not take that shape.
 */
function postDrawShortLead(cards: any[], shape: 'hu' | 'third', behindBB: number): { t: any; me: number } | null {
  const t = make['five-card-draw']();
  const human = (i: number) => i === 0 || (shape === 'third' && i === 3);
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (human(i) ? 'human-later-' : 'ai-later-') + i, !human(i));
  if (shape === 'hu') t.seats[0].chipCount = 150 + behindBB * 50; else t.seats[3].chipCount = 150 + behindBB * 50;
  if (!t.startNewHand()) return null;
  let g = 0, opened = false;
  while (t.currentPhase === GamePhase.PreFlop && g++ < 30) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    if (a === 0 && !opened) { if (!t.playerRaise(0, 150)) return null; opened = true; continue; }
    if (shape === 'hu' && a !== 0 && t.seats.some((x: any) => x.seatIndex !== 0 && !x.folded && x.currentBet >= 150)) { t.playerFold(a); continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  if (!opened || t.seats[shape === 'hu' ? 0 : 3].chipCount !== behindBB * 50) return null;
  g = 0;
  while (DRAW.includes(t.currentPhase) && g++ < 10) for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
  g = 0; while (t.currentPhase === GamePhase.Bet2 && human(t.activeSeatIndex) && g++ < 10) t.playerCheck(t.activeSeatIndex);
  if (t.currentPhase !== GamePhase.Bet2) return null;
  const me = t.activeSeatIndex; if (me < 0 || human(me) || t.getCallAmount(t.seats[me]) !== 0) return null;
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  return { t, me };
}

function leadShare(seed: number, spot: (c: any[]) => { t: any; me: number } | null, hands: string[], per: number): { bets: number; n: number; out: string[]; by: Record<string, { bets: number; n: number }> } {
  const restore = detEnv(seed);
  try {
    const out: string[] = []; let bets = 0, n = 0; const by: Record<string, { bets: number; n: number }> = { MANIAC: { bets: 0, n: 0 }, LAG: { bets: 0, n: 0 } };
    for (const h of hands) for (const a of ['MANIAC', 'LAG']) {
      let b = 0, m = 0;
      for (const diff of DIFFS) for (let k = 0, got = 0; got < per && k < per * 15; k++) {
        const r = spot(C(h)); if (!r) continue; got++; m++;
        const d = AI.decideAction(r.t, r.me, prof(a, diff));
        if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) b++;
      }
      out.push(`${h} ${a} ${b}/${m}`); bets += b; n += m; by[a].bets += b; by[a].n += m;
    }
    return { bets, n, out, by };
  } finally { restore(); }
}

describe('re-review fix-ups (STUDDRAW-R4F-REGRESSION-1 / R4R-EXPLOIT-1 / RR1-MEASUREMENT-2): Five Card Draw after the draw, one lead size for every hand, and short stacks are bet into', () => {
  it('heads-up vs a human with 10 / 25 BB behind, checked to: a MANIAC / LAG still leads K-K-Q-Q, 9-9-5-5 and a pair of aces (cdfc8a1: 0 of 15 at 10 BB and for MANIAC at 25 BB; live 15 of 15)', () => {
    const hands = ['Kh Kd Qc Qs 3h', '9h 9d 5c 5s Kh', 'Ah Ad Kc Qs 9h'];
    const r10 = leadShare(4171, (c) => postDrawShortLead(c, 'hu', 10), hands, 3);
    const r25 = leadShare(4172, (c) => postDrawShortLead(c, 'hu', 25), hands, 3);
    process.stdout.write(`HU short human, leads: 10 BB ${r10.out.join(', ')} | 25 BB ${r25.out.join(', ')}\n`);
    expect([r10.n, r25.n]).toEqual([3 * 2 * 4 * 3, 3 * 2 * 4 * 3]);
    // the LAG leads them all; a MANIAC with seats behind it traps a share of these hands (fix-up 3, FIVE_DRAW_POST_MANIAC_MIX)
    for (const r of [r10, r25]) expect([r.by.LAG.bets / r.by.LAG.n >= 0.9, r.by.MANIAC.bets / r.by.MANIAC.n >= 0.5]).toEqual([true, true]);
  }, 300_000);

  it('a 5-way pot with a 100 BB human and a THIRD seat left with 1 / 3 / 10 BB behind: a MANIAC / LAG still leads K-K-Q-Q (cdfc8a1: 0 of 90; c2b81d4 and live 28 of 90, MANIAC / LAG 13-15 of 15)', () => {
    let n = 0; const out: string[] = []; const by: Record<string, { bets: number; n: number }> = { MANIAC: { bets: 0, n: 0 }, LAG: { bets: 0, n: 0 } };
    for (const [seed, bb] of [[4173, 1], [4174, 3], [4175, 10]]) {
      const r = leadShare(seed, (c) => postDrawShortLead(c, 'third', bb), ['Kh Kd Qc Qs 3h'], 3);
      n += r.n; out.push(`${bb} BB: ${r.out.join(', ')}`);
      for (const a of ['MANIAC', 'LAG']) { by[a].bets += r.by[a].bets; by[a].n += r.by[a].n; }
    }
    process.stdout.write(`third seat short, K-K-Q-Q leads: ${out.join(' | ')}\n`);
    expect(n).toBe(3 * 2 * 4 * 3);
    // the LAG leads it; a MANIAC with seats behind it traps a share of it (fix-up 3, FIVE_DRAW_POST_MANIAC_MIX)
    expect([by.LAG.bets / by.LAG.n >= 0.75, by.MANIAC.bets / by.MANIAC.n >= 0.5]).toEqual([true, true]);
  }, 300_000);

  it('a 5-way pot with a 40 BB human: one capped lead size for every hand; a LAG leads one pair and no pair too, a MANIAC (seats behind it) leads most of its kings or better, no lower pair and a third of its no-pair hands (cdfc8a1: a big lead was aces up or better 473 times in 476; one pair never led, no pair never led; fix-up 3 led half the lower pairs, fix-up 4 none: a lower pair led folds to an all-in over the lead)', () => {
    const restore = detEnv(4176);
    try {
      const groups: Record<string, string[]> = { low: ['Qh Qd 9c 5s 2h', '7h 7d Ac 9s 4h'], air: ['Ah Kd 9c 7s 3h', 'Kh Qd 9c 6s 2h'], value: ['Kh Kd Ac 9s 4h', 'Ah Ad Kc Ks 3h', '2h 2d 2c 7s 3h'] };
      const st: Record<string, { bets: number; n: number; size: number }> = {};
      let over = 0;
      for (const a of ['MANIAC', 'LAG']) for (const g of Object.keys(groups)) for (const diff of DIFFS) for (const h of groups[g]) {
        const key = `${a} ${g}`; st[key] = st[key] || { bets: 0, n: 0, size: 0 };
        for (let k = 0, got = 0; got < 3 && k < 30; k++) {
          const r = postDrawMultiLead(C(h)); if (!r) continue; got++;
          const me = r.t.seats[r.me], hero = r.t.seats[0];
          const depth = Math.min(me.chipCount + me.currentBet, hero.chipCount + hero.currentBet);
          const d = AI.decideAction(r.t, r.me, prof(a, diff));
          const put = d.action === PlayerAction.AllIn ? me.chipCount : d.action === PlayerAction.Raise ? d.raiseAmount - me.currentBet : 0;
          st[key].n++;
          if (put > 0) { st[key].bets++; st[key].size += put / depth; }
          if (put > AI.FIVE_DRAW_POST_LEAD_CAP * depth) over++;
        }
      }
      const share = (k: string) => st[k].bets / st[k].n, mean = (k: string) => st[k].size / Math.max(1, st[k].bets);
      process.stdout.write(`40 BB human, leads: ${Object.keys(st).map((k) => `${k} ${st[k].bets}/${st[k].n} (${mean(k).toFixed(3)})`).join(', ')}\n`);
      expect(over).toBe(0);
      expect([share('LAG low') >= 0.6, share('LAG air') >= 0.3, share('LAG value') >= 0.75]).toEqual([true, true, true]);
      expect([share('MANIAC low') === 0, share('MANIAC value') >= 0.5, share('MANIAC value') <= 0.95]).toEqual([true, true, true]);
      expect(share('MANIAC air')).toBeGreaterThanOrEqual(0.1);
      expect(share('MANIAC air')).toBeLessThanOrEqual(0.6);
      // every lead the same size: value and bluffs alike
      for (const k of ['LAG low', 'LAG air', 'MANIAC air']) expect([k, Math.abs(mean(k) - mean(k.split(' ')[0] + ' value')) <= 0.03]).toEqual([k, true]);
    } finally { restore(); }
  }, 300_000);

  it('the MANIAC lead rule and the checked-range price are pinned', () => {
    expect([...AI.FIVE_DRAW_POST_MANIAC_LEAD]).toEqual([1 + 11 / 13, 0.35]);
    expect(AI.FIVE_DRAW_POST_CHECKED_PO).toEqual({ NIT: 0, ROCK: 0, TAG: 0, LAG: 0, MANIAC: 0.08, FISH: 0, CALLING_STATION: 0 });
  });

  it('fiveDrawPostFolds (pure): a MANIAC that checked reads the price of a bet lower (its checked range holds its middle pairs), never of an all-in nor of an overcall; an all-in over this seat\'s own bet asks two pair, no ramp', () => {
    const P = (h: string, po: number, a: string, shove: boolean, over: boolean, checked: boolean, raised: boolean) => AI.fiveDrawPostFolds(C(h), po, a, shove, 80, over, 1, checked, raised);
    expect(P('9h 9d Kc 7s 3h', 0.30, 'MANIAC', false, false, false, false)).toBe(true);    // two pair asked ...
    expect(P('9h 9d Kc 7s 3h', 0.30, 'MANIAC', false, false, true, false)).toBe(false);    // ... after its check the price reads 0.22
    expect(P('9h 9d Kc 7s 3h', 0.30, 'TAG', false, false, true, false)).toBe(true);        // MANIAC only
    expect(P('9h 9d Kc 7s 3h', 0.33, 'MANIAC', true, false, true, false)).toBe(true);      // not an all-in (the ramp: 1.75)
    expect(P('Ah Ad Kc 7s 3h', 0.25, 'MANIAC', false, true, true, false)).toBe(true);      // an overcall: no shift
    expect(P('Ah Ad Kc 7s 3h', 0.30, 'TAG', true, false, false, false)).toBe(false);       // the all-in ramp ...
    expect(P('Ah Ad Kc 7s 3h', 0.30, 'TAG', true, false, false, true)).toBe(true);         // ... not over its own bet: two pair
    expect(P('Kh Kd Qc Qs 3h', 0.30, 'TAG', true, false, false, true)).toBe(false);
  });

  it('the lead cap is pinned', () => {
    expect(AI.FIVE_DRAW_POST_LEAD_CAP).toBe(0.3);
  });
});

describe('re-review fix-ups (STUDDRAW-RR1-MEASUREMENT-2 / R4R-EXPLOIT-1): Five Card Draw after the draw, the gate phases in with the share of the depth a call puts in', () => {
  it('fiveDrawPostFolds (pure): `commit` scales the hand needed (0 = no gate, 1 = all of it), so the answer moves with the size of the call, not at one edge', () => {
    const P = (h: string, po: number, a: string, commit: number) => AI.fiveDrawPostFolds(C(h), po, a, false, 80, false, commit);
    expect(P('Ah Kd 9c 7s 3h', 0.30, 'TAG', 0)).toBe(false);       // nothing brought in: the strategy decides
    expect(P('Ah Kd 9c 7s 3h', 0.30, 'TAG', 0.3)).toBe(true);      // no pair folds as soon as any of it is
    expect(P('2h 2d Kc 7s 3h', 0.30, 'TAG', 0.5)).toBe(false);     // half of two pair: every pair continues
    expect(P('8h 8d Kc 7s 3h', 0.30, 'TAG', 0.75)).toBe(true);     // three quarters: 1.5, eights fold ...
    expect(P('9h 9d Kc 7s 3h', 0.30, 'TAG', 0.75)).toBe(false);    // ... nines continue
    expect(P('Ah Ad Kc 7s 3h', 0.30, 'TAG', 1)).toBe(true);        // all of it: two pair
  });

  // (A FISH's own call rule folds its weakest hands to a bet over 0.4 of the pot, as on live 0dc1b96: that step is the
  // strategy's, not the gate's, so the FISH is checked on the gate alone in the pure test above and with Q-Q below.)
  it('heads-up, 40 BB pot, 80 BB behind: facing a bet just under a third of the depth (0.65 pot) and one just over it (0.70 pot), a CALLING_STATION / MANIAC / TAG / LAG folds at most two more pair ranks to the bigger one (cdfc8a1: none folded to the gate at 0.65, every pair below aces at 0.70)', () => {
    const restore = detEnv(4181);
    try {
      const out: string[] = [];
      const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
      for (const a of ['CALLING_STATION', 'MANIAC', 'TAG', 'LAG']) {
        const folds: Record<string, number> = { '0.65': 0, '0.7': 0 }; let n = 0;
        for (const frac of [0.65, 0.7]) for (const r of ranks) for (const diff of ['hard', 'expert']) {
          for (let k = 0, got = 0; got < 1 && k < 30; k++) {
            const h = `${r}h ${r}d ${r === 'K' ? 'Q' : 'K'}c ${r === '9' ? '8' : '9'}s ${r === '4' ? '3' : '4'}h`;
            const res = headsUpPostDraw(C(h), 'face', frac, 40); if (!res) continue; got++; n++;
            if (AI.decideAction(res.t, res.me, prof(a, diff)).action === PlayerAction.Fold) folds[String(frac)]++;
          }
        }
        out.push(`${a} ${folds['0.65']}/26 -> ${folds['0.7']}/26`);
        expect([a, n]).toEqual([a, 52]);
        expect([a, folds['0.7'] - folds['0.65'] <= 2 * 2 + 1]).toEqual([a, true]);
      }
      process.stdout.write(`HU 0.65 / 0.70 pot, pair folds: ${out.join(', ')}\n`);
    } finally { restore(); }
  }, 300_000);

  it('the same two bets: a pair of queens gets the same answer from a FISH and a CALLING_STATION (it calls both; cdfc8a1 folded it to the bigger one every time)', () => {
    const restore = detEnv(4182);
    try {
      const out: string[] = [];
      for (const a of ['FISH', 'CALLING_STATION']) for (const frac of [0.65, 0.7]) {
        let c = 0, n = 0;
        for (const diff of DIFFS) for (let k = 0, got = 0; got < 2 && k < 30; k++) {
          const res = headsUpPostDraw(C('Qh Qd Kc 9s 4h'), 'face', frac, 40); if (!res) continue; got++; n++;
          if (AI.decideAction(res.t, res.me, prof(a, diff)).action !== PlayerAction.Fold) c++;
        }
        out.push(`${a} ${frac}: ${c}/${n}`);
        expect([a, frac, n, c]).toEqual([a, frac, 8, 8]);
      }
      process.stdout.write(`HU Q-Q vs 0.65 / 0.70 pot, continues: ${out.join(', ')}\n`);
    } finally { restore(); }
  }, 300_000);
});

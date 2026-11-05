/**
 * tests/studDrawFiveCardDrawNoLimit.test.ts (2026-11 bots review, fix round 2: VA-1, NEW-5, B4, B8, B16).
 * Five Card Draw is the one no-limit game on studDrawFirstRound. Real FiveCardDrawTable + the real
 * decideAction, 25/50 with 100 BB stacks (the "Draw Poker Lounge" lobby table). Deterministic: seeded
 * Math.random, frozen Date.now (every Monte Carlo runs its full sim count), seeded crypto.randomBytes
 * (the deck). Every case fails on d1ec56a: the big blind there continued a lone 100 BB shove with
 * 38-91% of hands (ROCK / FISH / MANIAC / CALLING_STATION), MANIAC jammed 93% of hands over a 30 BB open,
 * the call range ignored the size of the raise, an opener defended every 3-bet size alike, and the
 * push/fold zone assumed 3 players behind from every seat. Planted hands skip any card-clash check: the
 * draw games' first-round strength reads only the bot's own five cards.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { GamePhase, PlayerAction } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const AI = require('../src/ai/AIPlayer');
const SDS = require('../src/ai/studDrawStrength');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fcd-nl-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const ARCH = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const prof = (a: string, diff = 'hard') => ({ ...AI.generateRandomProfile(diff), archetype: a, difficulty: diff });
const CONT = (d: any) => d.action === PlayerAction.Call || d.action === PlayerAction.AllIn || d.action === PlayerAction.Raise;
function table(n = 5): any {
  const t = new FiveCardDrawTable({ tableId: 'nl', tableName: 'nl', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
  for (let i = 0; i < n; i++) t.sitDown(i, 'P' + i, 5000, `ai-nl-${i}`, true);
  return t;
}
function deal(t: any, stack = 5000): boolean {
  for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = stack; x.eliminated = false; x.sittingOut = false; }
  return t.startNewHand();
}
function dist(t: any, si: number, p: any, n = 40): Record<string, number> {
  const m: Record<string, number> = {};
  for (let i = 0; i < n; i++) { const d = AI.decideAction(t, si, p); m[d.action] = (m[d.action] || 0) + 1; }
  return m;
}
/** The first actor shoves 100 BB; every later seat folds until `stopAtBB` (the big blind) is to act. */
function loneShoveToBB(t: any): number {
  const sh = t.activeSeatIndex; t.playerAllIn(sh);
  let g = 0;
  while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== sh) {
    const a = t.activeSeatIndex;
    if (t.seats[a].currentBet === 50) return a;
    t.playerFold(a);
  }
  return -1;
}
const pct = (cards: any[]) => SDS.equityToPercentile('draw-hi', SDS.firstRoundEquity('draw-hi', cards, [], 1, 0));

describe('VA-1 / NEW-1: Five Card Draw facing a lone 100 BB pre-draw shove', () => {
  it('the big blind continues with at most 12% of hands, every archetype; seats with players behind continue less', () => {
    const restore = detEnv(31);
    try {
      let lone = 0, loneN = 0, behind = 0, behindN = 0;
      const rates: string[] = [];
      for (const a of ARCH) {
        const p = prof(a); const t = table(); let c = 0, n = 0, cb = 0, nb = 0;
        // 300 deals for the big blind (the others fold unasked); every seat decides in the first 60
        for (let k = 0; k < 300; k++) {
          if (!deal(t)) break;
          const sh = t.activeSeatIndex; t.playerAllIn(sh); let g = 0;
          while (g++ < 10 && t.currentPhase === GamePhase.PreFlop && t.activeSeatIndex >= 0 && t.activeSeatIndex !== sh) {
            const s = t.activeSeatIndex;
            const toAct = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.seatIndex !== s && x.seatIndex !== sh && x.currentBet < t.currentBetToMatch).length;
            if (toAct === 0) { n++; if (CONT(AI.decideAction(t, s, p))) c++; }
            else if (k < 60) { nb++; if (CONT(AI.decideAction(t, s, p))) cb++; }
            t.playerFold(s);
          }
        }
        rates.push(`${a} ${(100 * c / n).toFixed(1)}/${(100 * cb / nb).toFixed(1)}`);
        expect([a, c / n <= 0.12]).toEqual([a, true]);
        expect([a, cb / nb <= 0.12]).toEqual([a, true]);
        lone += c; loneN += n; behind += cb; behindN += nb;
      }
      process.stdout.write(`VA-1 lone/behind continue %: ${rates.join(', ')}\n`);
      expect(behind / behindN).toBeLessThan(lone / loneN);
    } finally { restore(); }
  }, 300_000);

  it('junk folds and trips / a pat flush continue for all 7 archetypes; CALLING_STATION folds J-J-9-6-2 (its all-in branch passes the gate)', () => {
    const restore = detEnv(32);
    try {
      for (const a of ARCH) {
        for (const [h, cont] of [['Kh 9d 7c 4s 2h', false], ['Jh Jd 9c 6s 2h', false], ['Qh Qd Qc 7s 2h', true], ['Ah Jh 8h 5h 2h', true]] as [string, boolean][]) {
          const t = table(); deal(t); const bb = loneShoveToBB(t); expect(bb).toBeGreaterThanOrEqual(0);
          const hand = C(h);
          t.seats[bb].holeCards = hand;
          const m = dist(t, bb, prof(a));
          if (cont) expect([a, h, m[PlayerAction.Fold] || 0]).toEqual([a, h, 0]);
          else expect([a, h, m[PlayerAction.Fold] || 0]).toEqual([a, h, 40]);
        }
        // the premium floor (FIVE_DRAW_STACKOFF_PREMIUM, read before the noise): no difficulty folds them
        for (const diff of ['medium', 'easy']) {
          for (const h of ['Kh Kd Kc 7s 7h', 'Ah Jh 8h 5h 2h', '9h 8d 7c 6s 5h', 'Qh Qd Qc 7s 2h', 'Ah Ad Kc Ks 3h']) {
            const t = table(); deal(t); const bb = loneShoveToBB(t); expect(bb).toBeGreaterThanOrEqual(0);
            t.seats[bb].holeCards = C(h);
            expect([a, diff, h, dist(t, bb, prof(a, diff), 12)[PlayerAction.Fold] || 0]).toEqual([a, diff, h, 0]);
          }
        }
      }
    } finally { restore(); }
  }, 300_000);

  it('a seeded shove-the-top-10% line loses chips: UTG 100 BB shoves vs [ROCK, CALLING_STATION, FISH, MANIAC], all-in equity EV < 0', () => {
    const restore = detEnv(33);
    try {
      const lineup = ['ROCK', 'CALLING_STATION', 'FISH', 'MANIAC'];
      const t = table(); const profs: any[] = [];
      let ev = 0, spots = 0, calls = 0;
      let ms = 7; const mrnd = () => ((ms = (Math.imul(ms, 1664525) + 1013904223) >>> 0) / 4294967296);
      for (let k = 0; spots < 100 && k < 400; k++) {
        if (!deal(t)) break;
        const utg = t.activeSeatIndex;
        // the shover's seat gets a random top-10% hand (by the public 5CD percentile) from the cards still unseen
        const seen = new Set<number>(); for (const x of t.seats) if (x.seatIndex !== utg) for (const c of x.holeCards) seen.add(c.rank * 4 + c.suit);
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!seen.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let hand: any[] = [];
        for (let tries = 0; tries < 200; tries++) {
          for (let i = 0; i < 5; i++) { const j = i + Math.floor(mrnd() * (deck.length - i)); const z = deck[i]; deck[i] = deck[j]; deck[j] = z; }
          if (pct(deck.slice(0, 5)) >= 0.90) { hand = deck.slice(0, 5); break; }
        }
        if (!hand.length) continue;
        t.seats[utg].holeCards = hand;
        let i = 0; for (const x of t.seats) if (x.seatIndex !== utg) profs[x.seatIndex] = prof(lineup[i++ % lineup.length]);
        t.playerAllIn(utg); spots++;
        let g = 0;
        while (g++ < 10 && t.currentPhase === GamePhase.PreFlop && t.activeSeatIndex >= 0 && t.activeSeatIndex !== utg) {
          const a = t.activeSeatIndex; const d = AI.decideAction(t, a, profs[a]);
          if (CONT(d)) { calls++; if (!t.playerCall(a)) t.playerAllIn(a); } else t.playerFold(a);
        }
        const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length);
        if (live.length < 2) { ev += 75; continue; }   // the blinds
        // called: the shover's pot share over 400 draws (every live hand draws by the bots' keep rule)
        const used = new Set<number>(); for (const x of t.seats) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
        const rest: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!used.has(r * 4 + su)) rest.push({ rank: r, suit: su });
        let share = 0;
        for (let sim = 0; sim < 400; sim++) {
          for (let q = rest.length - 1; q > 0; q--) { const j = Math.floor(mrnd() * (q + 1)); const z = rest[q]; rest[q] = rest[j]; rest[j] = z; }
          let p = 0, best = -1, nb = 0, mine = 0;
          for (const x of live) {
            const drop = SDS.chooseBotDiscards('draw-hi', x.holeCards, 'Draw1');
            const fin = x.holeCards.filter((_: any, q: number) => !drop.includes(q)).concat(rest.slice(p, p + drop.length)); p += drop.length;
            const v = SDS.hiValue(fin); if (x.seatIndex === utg) mine = v;
            if (v > best) { best = v; nb = 1; } else if (v === best) nb++;
          }
          share += mine === best ? 1 / nb : 0;
        }
        ev += (share / 400) * t.getTotalPot() - 5000;
      }
      process.stdout.write(`VA-1 exploit: ${spots} top-10% shoves, ${calls} bot calls, EV ${(ev / spots / 50).toFixed(2)} BB per shove\n`);
      expect(spots).toBeGreaterThanOrEqual(80);
      expect(ev / spots).toBeLessThan(0);
    } finally { restore(); }
  }, 300_000);
});

describe('NEW-5: MANIAC never jams a hand that does not pass the stack-off range', () => {
  it('first in, and over a 20 BB / 30 BB open (neither commits it), junk and middling hands are never moved all-in, nor raised to a third of the stack', () => {
    const restore = detEnv(34);
    try {
      for (const X of [0, 20, 30]) {
        for (const h of ['Kh 9d 7c 4s 2h', '7h 7d Kc 9s 3h', 'Jh Jd 9c 6s 2h']) {
          const t = table(); deal(t);
          if (X) t.playerRaise(t.activeSeatIndex, X * 50);
          const me = t.activeSeatIndex; const hand = C(h);
          t.seats[me].holeCards = hand;
          let big = 0; const m: Record<string, number> = {};
          for (let i = 0; i < 60; i++) {
            const d = AI.decideAction(t, me, prof('MANIAC')); m[d.action] = (m[d.action] || 0) + 1;
            if (d.action === PlayerAction.Raise && d.raiseAmount >= 5000 * AI.STACKOFF_COMMIT_FRACTION) big++;
          }
          expect([X, h, m[PlayerAction.AllIn] || 0, big]).toEqual([X, h, 0, 0]);
        }
      }
    } finally { restore(); }
  }, 120_000);
});

describe('B4: the call range narrows with the size of the open (no-limit)', () => {
  it('the big blind continues far less vs a 10 BB or 30 BB open than vs a 3 BB one (TAG, ROCK, CALLING_STATION)', () => {
    const restore = detEnv(35);
    try {
      for (const a of ['TAG', 'ROCK', 'CALLING_STATION']) {
        const p = prof(a); const c: Record<number, number> = {};
        for (const X of [3, 10, 30]) {
          const t = table(); let n = 0, k = 0;
          for (let i = 0; i < 150; i++) {
            if (!deal(t)) break;
            t.playerRaise(t.activeSeatIndex, X * 50); let g = 0;
            while (g++ < 10 && t.seats[t.activeSeatIndex].currentBet !== 50) t.playerFold(t.activeSeatIndex);
            n++; if (CONT(AI.decideAction(t, t.activeSeatIndex, p))) k++;
          }
          c[X] = k / n;
        }
        process.stdout.write(`B4 ${a} BB continue vs 3/10/30 BB: ${[3, 10, 30].map((x) => (100 * c[x]).toFixed(1)).join(' / ')}\n`);
        expect([a, c[10] <= 0.6 * c[3]]).toEqual([a, true]);
        expect([a, c[30] <= c[10] + 0.03]).toEqual([a, true]);
      }
    } finally { restore(); }
  }, 300_000);

  it('the value set still never folds: A-A-K-7-3 in the big blind vs a 30 BB open, every archetype at hard and medium', () => {
    const restore = detEnv(36);
    try {
      for (const diff of ['hard', 'medium']) {
        for (const a of ARCH) {
          const t = table(); deal(t);
          t.playerRaise(t.activeSeatIndex, 1500); let g = 0;
          while (g++ < 10 && t.seats[t.activeSeatIndex].currentBet !== 50) t.playerFold(t.activeSeatIndex);
          const me = t.activeSeatIndex; const hand = C('Ah Ad Kc 7s 3h');
          t.seats[me].holeCards = hand;
          expect([diff, a, dist(t, me, prof(a, diff))[PlayerAction.Fold] || 0]).toEqual([diff, a, 0]);
        }
      }
    } finally { restore(); }
  }, 120_000);
});

describe('B8: an opener defends a 3-bet by its price (no-limit)', () => {
  it('TAG opening hands continue more often vs a min 3-bet than vs a 10x one (the same deals for both sizes)', () => {
    const c: Record<number, number> = {};
    for (const m of [2, 10]) {
      // One seed for both sizes: the same deals, opens and noise draws, so the two rates are a paired comparison.
      const restore = detEnv(37);
      try {
        const p = prof('TAG'); const t = table(); let n = 0, k = 0, guard = 0;
        while (n < 150 && guard++ < 3000) {
          if (!deal(t)) break;
          const op = t.activeSeatIndex; const d0 = AI.decideAction(t, op, p);
          if (d0.action !== PlayerAction.Raise) continue;
          t.playerRaise(op, d0.raiseAmount);
          const tb = t.activeSeatIndex; t.playerRaise(tb, Math.round(t.currentBetToMatch * m));
          let g = 0;
          while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== op) t.playerFold(t.activeSeatIndex);
          if (t.activeSeatIndex !== op) continue;
          n++; if (CONT(AI.decideAction(t, op, p))) k++;
        }
        c[m] = k / n;
      } finally { restore(); }
    }
    process.stdout.write(`B8 TAG opener continue vs 2x / 10x 3-bet: ${(100 * c[2]).toFixed(1)} / ${(100 * c[10]).toFixed(1)}\n`);
    expect(c[2]).toBeGreaterThanOrEqual(c[10] + 0.05);
  }, 300_000);
});

describe('B16: push/fold counts the players still live (no-limit)', () => {
  it('15 BB, folded to the small blind (one player left): a TAG shoves or folds, it never min-opens', () => {
    const restore = detEnv(38);
    try {
      for (const h of ['Th Td 9c 6s 2h', 'Kh Kd Qc 7s 3h', 'Ah Ad Kc 7s 3h']) {
        const t = table(); deal(t, 750);
        let g = 0;
        while (g++ < 10 && t.seats[t.activeSeatIndex].currentBet === 0) t.playerFold(t.activeSeatIndex);
        const sb = t.activeSeatIndex; expect(t.seats[sb].currentBet).toBe(25);
        const hand = C(h);
        t.seats[sb].holeCards = hand;
        expect([h, dist(t, sb, prof('TAG'))]).toEqual([h, { [PlayerAction.AllIn]: 40 }]);
      }
    } finally { restore(); }
  }, 120_000);
  it('10 BB: the small blind folded to shoves more often than the first seat with 4 players behind', () => {
    const restore = detEnv(39);
    try {
      const p = prof('TAG'); const t = table(); const by: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
      for (let k = 0; k < 300; k++) {
        if (!deal(t, 500)) break;
        for (let pos = 0; pos < 4; pos++) {
          const a = t.activeSeatIndex; const d = AI.decideAction(t, a, p);
          by[pos][1]++; if (d.action === PlayerAction.AllIn) by[pos][0]++;
          t.playerFold(a);
        }
      }
      const r = by.map(([a, b]) => a / b);
      process.stdout.write(`B16 TAG 10 BB open-shove by position (first .. small blind): ${r.map((x) => (100 * x).toFixed(1)).join(' / ')}\n`);
      expect(r[3]).toBeGreaterThanOrEqual(r[0] + 0.06);
    } finally { restore(); }
  }, 300_000);
});

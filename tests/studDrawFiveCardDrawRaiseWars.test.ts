/**
 * tests/studDrawFiveCardDrawRaiseWars.test.ts (2026-11 bots review, fix round 2 follow-up: the two
 * adversarial reviews of the studdraw lane). Five Card Draw is the one no-limit game on studDrawFirstRound.
 * Real FiveCardDrawTable + the real decideAction, 25/50, deterministic (seeded Math.random, frozen
 * Date.now, seeded deck).
 *  - R1: the B4 sizing put ROCK / FISH's call threshold at 0.98 facing a 3-bet or a short all-in that does
 *    not commit the stack: 98e2568 folded full houses / flushes / trips 17-47% there (d1ec56a: 0%); a NIT
 *    folded them 10-43% to any 3-bet at medium on both (its 4-bet line read the noisy percentile).
 *  - R2: a MANIAC re-raised 91% of hands to 33-59% of its stack and folded 89% of them to a shove (98e2568):
 *    opening 15 BB with any two and shoving over any re-raise won +333..+955 BB/100. On d1ec56a it moved
 *    junk all-in instead (93% over a 30 BB open). Fix round 3 (TI-R2-1): the 4 BB open is where
 *    FIVE_DRAW_LIGHT_RERAISE_FRACTION binds (a MANIAC re-raise to 10-16 BB): at 0.125 / 0.15 instead of 0.10 a
 *    MANIAC re-raised and folded 51 / 84 of 120 deals there (0.10: 1), and every other size stayed green.
 *  - NEW-1 in the push/fold zone: a short all-in the bot faces alone was re-shoved on the PUSH range.
 * Planted hands skip any card-clash check where only the bot's own five cards matter.
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
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fcd-rw-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const prof = (a: string, diff = 'hard') => ({ ...AI.generateRandomProfile(diff), archetype: a, difficulty: diff });
function table(n = 5, human = -1): any {
  const t = new FiveCardDrawTable({ tableId: 'rw', tableName: 'rw', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
  for (let i = 0; i < n; i++) t.sitDown(i, 'P' + i, 5000, (i === human ? 'human-rw-' : 'ai-rw-') + i, i !== human);
  return t;
}
function deal(t: any, stack = 5000): boolean {
  for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = stack; x.eliminated = false; x.sittingOut = false; }
  return t.startNewHand();
}
const rawPct = (cards: any[]) => SDS.equityToPercentile('draw-hi', SDS.firstRoundEquity('draw-hi', cards, [], 1, 0));
const PREMIUMS = ['Kh Kd Kc 7s 7h', 'Ah Jh 8h 5h 2h', '9h 8d 7c 6s 5h', 'Qh Qd Qc 7s 2h'];   // full house, flush, straight, trips

describe('R1: a premium never folds to a 3-bet or a short all-in that does not commit it', () => {
  it('an opener (ROCK, FISH, NIT, TAG) facing a 3-bet to 10 / 25 / 32 BB, hard and medium: full house, flush, straight, trips fold 0 times', () => {
    const restore = detEnv(51);
    try {
      for (const h of PREMIUMS) expect([h, rawPct(C(h)) >= AI.FIVE_DRAW_STACKOFF_PREMIUM]).toEqual([h, true]);
      for (const X of [10, 25, 32]) for (const a of ['ROCK', 'FISH', 'NIT', 'TAG']) for (const diff of ['hard', 'medium']) {
        for (const h of PREMIUMS) {
          let folds = 0, n = 0;
          for (let k = 0; k < 12; k++) {
            const t = table(); deal(t);
            const op = t.activeSeatIndex; t.playerRaise(op, 125);
            const tb = t.activeSeatIndex; t.playerRaise(tb, X * 50);
            let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== op) t.playerFold(t.activeSeatIndex);
            expect(t.activeSeatIndex).toBe(op);
            t.seats[op].holeCards = C(h);
            n++; if (AI.decideAction(t, op, prof(a, diff)).action === PlayerAction.Fold) folds++;
          }
          expect([X, a, diff, h, folds]).toEqual([X, a, diff, h, 0]);
        }
      }
    } finally { restore(); }
  }, 300_000);

  it('a 100 BB seat facing a 15 / 20 BB all-in with players still to act behind it folds none of them (ROCK, FISH, NIT, TAG, CALLING_STATION)', () => {
    const restore = detEnv(52);
    try {
      for (const X of [15, 20]) for (const a of ['ROCK', 'FISH', 'NIT', 'TAG', 'CALLING_STATION']) for (const diff of ['hard', 'medium']) {
        for (const h of PREMIUMS) {
          let folds = 0;
          for (let k = 0; k < 12; k++) {
            const t = table(); deal(t);
            const sh = t.activeSeatIndex; t.seats[sh].chipCount = X * 50; t.playerAllIn(sh);
            const me = t.activeSeatIndex;
            t.seats[me].holeCards = C(h);
            if (AI.decideAction(t, me, prof(a, diff)).action === PlayerAction.Fold) folds++;
          }
          expect([X, a, diff, h, folds]).toEqual([X, a, diff, h, 0]);
        }
      }
    } finally { restore(); }
  }, 300_000);
});

describe('R2: no raise war the bot cannot finish (no-limit)', () => {
  it('facing a 4 / 6 / 10 / 15 BB open, a MANIAC (also FISH / LAG / TAG) re-raises and then folds to a 100 BB shove in <= 10% of deals, never makes a non-all-in raise of a third of its stack, and never moves a hand under the 80th percentile all-in', () => {
    const restore = detEnv(53);
    try {
      const rows: string[] = [];
      for (const a of ['MANIAC', 'FISH', 'LAG', 'TAG']) for (const X of [4, 6, 10, 15]) {
        const p = prof(a); const t = table(5, 0);
        let deals = 0, rrFold = 0, jamJunk = 0, bigRaise = 0;
        for (let k = 0; deals < 120 && k < 1200; k++) {
          if (!deal(t)) break;
          if (t.activeSeatIndex !== 0) continue;           // the human (seat 0) opens first in
          t.playerRaise(0, X * 50);
          let g = 0, bb = -1;
          while (g++ < 10 && t.activeSeatIndex > 0) {
            const s = t.activeSeatIndex;
            if (t.seats[s].currentBet === 50) { bb = s; break; }
            t.playerFold(s);
          }
          if (bb < 0) continue;
          deals++;
          const d = AI.decideAction(t, bb, p);
          if (d.action === PlayerAction.AllIn && rawPct(t.seats[bb].holeCards) < 0.80) jamJunk++;
          if (d.action !== PlayerAction.Raise) continue;
          if (d.raiseAmount >= 5000 / 3) bigRaise++;
          if (!t.playerRaise(bb, d.raiseAmount)) continue;
          t.playerAllIn(0);
          if (AI.decideAction(t, bb, p).action === PlayerAction.Fold) rrFold++;
        }
        rows.push(`${a} ${X} BB: re-raise-fold ${rrFold}/${deals}, junk jams ${jamJunk}, raises >= 1/3 stack ${bigRaise}`);
        expect([a, X, rrFold / deals <= 0.10, jamJunk, bigRaise]).toEqual([a, X, true, 0, 0]);
      }
      process.stdout.write(`R2 raise wars: ${rows.join('; ')}\n`);
    } finally { restore(); }
  }, 300_000);

  it('open 10 / 15 BB with any two and shove over any re-raise: loses vs [MANIAC x4] (scored at the end of the first round: pre-draw equity x pot, 300 hands per size)', () => {
    const restore = detEnv(54);
    try {
      const p = prof('MANIAC');
      let ms = 11; const mrnd = () => ((ms = (Math.imul(ms, 1664525) + 1013904223) >>> 0) / 4294967296);
      const rows: string[] = [];
      for (const OPEN of [10, 15]) {
        const t = table(5, 0);
        /** The human's pot share when every live hand draws once by the bots' keep rule and shows down. */
        const preDrawEV = (): number => {
          const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length);
          const used = new Set<number>(); for (const x of t.seats) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
          const rest: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!used.has(r * 4 + su)) rest.push({ rank: r, suit: su });
          let share = 0;
          for (let sim = 0; sim < 300; sim++) {
            for (let q = rest.length - 1; q > 0; q--) { const j = Math.floor(mrnd() * (q + 1)); const z = rest[q]; rest[q] = rest[j]; rest[j] = z; }
            let pos = 0, best = -1, nb = 0, mine = 0;
            for (const x of live) {
              const keep = SDS.keepForDraw('draw-hi', x.holeCards, 1);
              const fin = keep.map((q: number) => x.holeCards[q]).concat(rest.slice(pos, pos + 5 - keep.length)); pos += 5 - keep.length;
              const v = SDS.hiValue(fin); if (x.seatIndex === 0) mine = v;
              if (v > best) { best = v; nb = 1; } else if (v === best) nb++;
            }
            share += mine === best ? 1 / nb : 0;
          }
          return (share / 300) * t.getTotalPot() - t.seats[0].totalInvestedThisHand;
        };
        let total = 0, hands = 0, shoves = 0, g = 0;
        for (let h = 0; h < 300; h++) {
          if (!deal(t)) break;
          hands++; g = 0;
          while (t.isHandInProgress() && t.currentPhase === GamePhase.PreFlop && g++ < 60) {
            const a = t.activeSeatIndex; if (a < 0) break;
            if (a === 0) {
              const opened = (Number(t.raisesThisStreet) || 0) >= 1 || t.currentBetToMatch > 50;
              const shoved = t.seats.some((x: any) => x.seatIndex !== 0 && !x.folded && x.allIn && x.currentBet === t.currentBetToMatch);
              if (!opened) { if (!t.playerRaise(0, OPEN * 50)) t.playerFold(0); }
              else if (t.seats[0].currentBet >= OPEN * 50 && !shoved) { shoves++; t.playerAllIn(0); }
              else t.playerFold(0);
              continue;
            }
            const d = AI.decideAction(t, a, p);
            const ok = d.action === PlayerAction.Fold ? t.playerFold(a)
              : d.action === PlayerAction.Check ? (t.playerCheck(a) || t.playerFold(a))
                : d.action === PlayerAction.Call ? (t.playerCall(a) || t.playerCheck(a) || t.playerAllIn(a))
                  : d.action === PlayerAction.Raise ? (t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a))
                    : (t.playerAllIn(a) || t.playerFold(a));
            if (!ok) t.playerFold(a);
          }
          total += t.isHandInProgress() && !t.seats[0].folded ? preDrawEV() : t.seats[0].chipCount - 5000;
        }
        const bb100 = (100 * total) / hands / 50;
        rows.push(`open ${OPEN} BB: ${hands} hands, ${shoves} shoves over a re-raise, ${bb100.toFixed(1)} BB/100`);
        expect([OPEN, hands, bb100 < 0]).toEqual([OPEN, 300, true]);
      }
      process.stdout.write(`R2 open-any-two + shove over re-raises vs MANIAC x4: ${rows.join('; ')}
`);
    } finally { restore(); }
  }, 300_000);
});

describe('NEW-1 in the push/fold zone: a short all-in faced alone is a call, priced on the Nash CALL range', () => {
  it('heads-up, a 12 BB TAG big blind facing a 6 BB all-in (it covers it) continues about the Nash call width, not the push width', () => {
    const restore = detEnv(55);
    try {
      const p = prof('TAG'); const t = table(2); let n = 0, cont = 0;
      for (let k = 0; n < 200 && k < 400; k++) {
        if (!deal(t, 600)) break;
        const sh = t.activeSeatIndex; const bb = t.seats.find((x: any) => x.state === 'occupied' && x.seatIndex !== sh).seatIndex;
        if (t.seats[bb].currentBet !== 50) continue;
        t.seats[sh].chipCount = 300 - t.seats[sh].currentBet; t.playerAllIn(sh);
        if (t.activeSeatIndex !== bb) continue;
        expect(t.getCallAmount(t.seats[bb])).toBeLessThan(t.seats[bb].chipCount);   // it covers the shover
        n++;
        if (AI.decideAction(t, bb, p).action !== PlayerAction.Fold) cont++;
      }
      // TAG (x1.06): the Nash call at 6 BB (0.472) is ~50% of hands; the push range (0.334) ~63%.
      process.stdout.write(`NEW-1 push/fold: heads-up TAG big blind vs a 6 BB all-in continues ${(100 * cont / n).toFixed(1)}% of ${n}\n`);
      expect(n).toBe(200);
      expect(cont / n).toBeLessThanOrEqual(0.56);
      expect(cont / n).toBeGreaterThanOrEqual(0.38);
    } finally { restore(); }
  }, 120_000);
});

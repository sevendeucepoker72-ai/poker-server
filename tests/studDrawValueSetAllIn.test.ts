/**
 * tests/studDrawValueSetAllIn.test.ts (2026-11 bots review, fix round 3: SD2-1 / SD2-2). Item 4's value set
 * (AIPlayer STUD_DRAW_VALUE_PCTILE; Five Card Draw also fiveDrawAcesOrBetter) never folds to ONE completion /
 * raise / short all-in that does not commit the stack, counted by the table (raisesThisStreet), also when a
 * short stack is all-in in the pot. modelOpponents reads every all-in as two raises, so on 2b5ac52:
 *  - SD2-1: Five Card Draw ROCK / FISH (hard) folded aces and two pair 95-100% to a lone 15-25 BB all-in with
 *    players behind, CALLING_STATION up to 63% (d1ec56a: 0%); NIT / TAG / LAG folded them on both;
 *  - SD2-2: a short stack's all-in CALL (or a short all-in under the Stud completion) turned one completion /
 *    one open into a "3-bet": a hard NIT folded Razz A-2-3 58%, Stud 8 A-2-3 suited 71%, Five Card Draw aces 100%.
 * The stack-off gate still prices every call that commits a third of the stack (GUARD). Real tables, the real
 * decideAction, deterministic (seeded Math.random, frozen Date.now, seeded deck).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction } = require('../src/game/PokerTable');
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
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`vsai-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
/** Ranks only ('AAK73'): random suits, distinct within a pair, never a flush. */
function ranks(pattern: string): any[] {
  for (;;) {
    const used = new Map<number, Set<number>>();
    const cards = pattern.split('').map((ch) => {
      const r = RK[ch] ?? Number(ch); const u = used.get(r) || new Set<number>(); used.set(r, u);
      let s: number; do { s = Math.floor(Math.random() * 4); } while (u.has(s)); u.add(s);
      return { rank: r, suit: s };
    });
    if (!cards.every((c) => c.suit === cards[0].suit)) return cards;
  }
}
const live = (o: any = {}) => ({ tableId: 'vsai', tableName: 'vsai', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000, ...o });
const make: Record<string, () => any> = {
  'five-card-draw': () => new FiveCardDrawTable(live(), false), 'triple-draw': () => new FiveCardDrawTable(live(), true),
  badugi: () => new BadugiTable(live()), 'seven-stud': () => new SevenStudTable(live({ ante: 5 }), false, false),
  'stud-hi-lo': () => new SevenStudTable(live({ ante: 5 }), false, true), razz: () => new SevenStudTable(live({ ante: 5 }), true, false),
};
const CUT: Record<string, number> = { 'stud-hi': 0.92, stud8: 0.90, razz: 0.85, 'draw-hi': 0.90, deuce7: 0.95, badugi: 0.95 };
const ARCH = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const prof = (a: string, diff: string) => ({ ...AI.generateRandomProfile(diff), archetype: a, difficulty: diff });
const same = (a: any, b: any) => a.rank === b.rank && a.suit === b.suit;

/**
 * Five Card Draw, 6 seats at 25/50, every bot 100 BB. Seat 3 (UTG, first to act) is a human with X BB who moves
 * all-in: the round's only raise. `closer` false: the bot to act is seat 4, with four players behind it; true: the
 * others fold to the big blind (seat 2), whose call closes the action.
 */
function shoveSpot(X: number, closer: boolean): { t: any; me: number } {
  const t = make['five-card-draw']();
  for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 3 ? 'human-vsai-' : 'ai-vsai-') + i, i !== 3);
  t.seats[3].chipCount = X * 50;
  t.startNewHand();
  expect(t.activeSeatIndex).toBe(3);
  expect(t.playerAllIn(3)).toBe(true);
  expect(t.raisesThisStreet).toBe(1);
  if (closer) { let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 2) t.playerFold(t.activeSeatIndex); }
  expect(t.activeSeatIndex).toBe(closer ? 2 : 4);
  return { t, me: t.activeSeatIndex };
}

/**
 * A fresh 5-handed table, `h` planted for the seat to act; null on a card clash or an off-shape deal.
 *  'callai'  - one completion (Stud family) / one 3 BB open (Five Card Draw) / one fixed-limit bet (2-7, Badugi),
 *              then the next seat, `short` chips behind, CALLS: all-in for less (lastAction AllIn, no raise);
 *  'shortai' - (Stud family) the first seat after the bring-in moves all-in for `short`, under the completion.
 */
function spot(v: string, h: string, mode: 'callai' | 'shortai', short: number): { t: any; me: number; raw: number; kind: string } | null {
  const t = make[v](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-vsai-${i}`, true); t.startNewHand();
  const kind = SDS.studDrawKindOf(t.variantId, t); const stud = SDS.isStudKind(kind);
  let a0 = t.activeSeatIndex;
  if (stud && t.seats[a0].currentBet > 0 && t.getCallAmount(t.seats[a0]) === 0) { t.playerCheck(a0); a0 = t.activeSeatIndex; }   // the bring-in stays
  let shorty = a0;
  if (mode === 'shortai') { t.seats[a0].chipCount = short; if (!t.playerAllIn(a0) || !t.seats[a0].allIn) return null; }
  else {
    if (!t.playerRaise(a0, kind === 'draw-hi' ? 150 : t.getMinRaise())) return null;
    shorty = t.activeSeatIndex; if (shorty < 0 || shorty === a0) return null;
    t.seats[shorty].chipCount = short;
    if (!t.playerCall(shorty) || !t.seats[shorty].allIn || t.seats[shorty].currentBet >= t.currentBetToMatch) return null;
  }
  // The precondition: the short stack is all-in (read as two raises by modelOpponents), ONE raise this round.
  expect([t.seats[shorty].lastAction, t.raisesThisStreet]).toEqual([PlayerAction.AllIn, 1]);
  const me = t.activeSeatIndex; if (me < 0 || me === shorty) return null;
  const hand = C(h);
  const others: any[] = []; for (const x of t.seats) if (x.seatIndex !== me) others.push(...x.holeCards);
  if (others.some((c) => hand.some((y: any) => same(y, c)))) return null;
  t.seats[me].holeCards = hand;
  const doors: any[] = []; if (stud) for (const x of t.seats) if (x.seatIndex !== me && x.state === 'occupied' && x.holeCards.length) doors.push(...t.getFaceUpCards(x.seatIndex));
  const raw = SDS.equityToPercentile(kind, SDS.firstRoundEquity(kind, hand, doors, SDS.drawsLeftAt(kind, t.currentPhase), 0));
  return { t, me, raw, kind };
}

describe('SD2-1: Five Card Draw - a value-set hand never folds to one short all-in that does not commit it', () => {
  const HANDS = ['AAK73', 'AA962', '3322K', '55449'];
  it('100 BB, players behind, vs a 12 / 15 / 20 / 25 BB all-in: a pair of aces / two pair folds 0 times, every archetype and difficulty', () => {
    const restore = detEnv(3101);
    try {
      const folds: string[] = []; let n = 0;
      for (const X of [12, 15, 20, 25]) for (const a of ARCH) for (const diff of DIFFS) for (const h of HANDS) {
        for (let k = 0; k < 2; k++) {
          const { t, me } = shoveSpot(X, false);
          t.seats[me].holeCards = ranks(h);
          expect(AI.fiveDrawAcesOrBetter(t.seats[me].holeCards)).toBe(true);
          n++; if (AI.decideAction(t, me, prof(a, diff)).action === PlayerAction.Fold) folds.push(`${X} BB ${a}/${diff} ${h}`);
        }
      }
      expect(n).toBe(4 * 7 * 4 * 4 * 2);
      expect(folds).toEqual([]);
    } finally { restore(); }
  }, 300_000);

  it('the big blind closing the action vs a 12 / 15 / 20 / 25 / 33 BB all-in (a call under a third of its stack): 0 folds, every archetype and difficulty', () => {
    const restore = detEnv(3102);
    try {
      const folds: string[] = []; let n = 0;
      for (const X of [12, 15, 20, 25, 33]) for (const a of ARCH) for (const diff of DIFFS) for (const h of HANDS) {
        const { t, me } = shoveSpot(X, true);
        t.seats[me].holeCards = ranks(h);
        expect(t.getCallAmount(t.seats[me])).toBeLessThan(t.seats[me].chipCount / 3);
        n++; if (AI.decideAction(t, me, prof(a, diff)).action === PlayerAction.Fold) folds.push(`${X} BB ${a}/${diff} ${h}`);
      }
      expect(n).toBe(5 * 7 * 4 * 4);
      expect(folds).toEqual([]);
    } finally { restore(); }
  }, 300_000);

  it('GUARD: below the set the short all-in still prices the hand (T-T-9-5-2 folds to a 20 BB all-in, ROCK / NIT hard)', () => {
    const restore = detEnv(3103);
    try {
      for (const a of ['ROCK', 'NIT']) {
        let folds = 0;
        for (let k = 0; k < 10; k++) {
          const { t, me } = shoveSpot(20, false);
          t.seats[me].holeCards = ranks('TT952');
          if (AI.decideAction(t, me, prof(a, 'hard')).action === PlayerAction.Fold) folds++;
        }
        expect([a, folds]).toEqual([a, 10]);
      }
    } finally { restore(); }
  }, 120_000);

  it('GUARD: a call that commits the stack stays the stack-off gate\'s (3-3-2-2-K, the big blind vs a lone 100 BB shove, hard: folds in most deals)', () => {
    const restore = detEnv(3104);
    try {
      let folds = 0, n = 0;
      for (const a of ARCH) for (let k = 0; k < 8; k++) {
        const { t, me } = shoveSpot(100, true);
        t.seats[me].holeCards = ranks('3322K');
        n++; if (AI.decideAction(t, me, prof(a, 'hard')).action === PlayerAction.Fold) folds++;
      }
      expect(folds / n).toBeGreaterThan(0.7);
    } finally { restore(); }
  }, 120_000);
});

describe('SD2-2: the value set holds with a short stack all-in in the pot (an all-in call is not a raise)', () => {
  const PROFS: [string, string][] = [['NIT', 'hard'], ['NIT', 'medium'], ['NIT', 'easy'], ['TAG', 'hard'], ['LAG', 'medium'], ['ROCK', 'hard'], ['FISH', 'medium'], ['MANIAC', 'hard'], ['CALLING_STATION', 'medium']];
  it.each([
    ['razz', 'Ad 2c 3h', 'callai', 30], ['stud-hi-lo', 'Ah 2h 3h', 'callai', 30], ['seven-stud', 'Kd Kc 9h', 'callai', 30],
    ['razz', 'Ad 2c 3h', 'shortai', 40], ['stud-hi-lo', 'Ah 2h 3h', 'shortai', 40], ['seven-stud', 'Kd Kc 9h', 'shortai', 40],
    ['five-card-draw', 'Ah Ad Kc 7s 3h', 'callai', 100], ['five-card-draw', '3h 3d 2c 2s Kh', 'callai', 100], ['five-card-draw', '7h 7d 3c 3s Ah', 'callai', 100],
    ['triple-draw', '7h 5d 3c 2s Kh', 'callai', 60], ['badugi', 'As 2h 3d 8c', 'callai', 60],
  ] as [string, string, 'callai' | 'shortai', number][])('%s %s, %s (%d chips): no archetype folds it when it is in the set', (v, h, mode, short) => {
    const restore = detEnv(3201);
    try {
      let inSet = 0, deals = 0; const folds: string[] = [];
      for (let g = 0; deals < 10 && g < 400; g++) {
        const r = spot(v, h, mode, short); if (!r) continue; deals++;
        const byClass = r.kind === 'draw-hi' && AI.fiveDrawAcesOrBetter(r.t.seats[r.me].holeCards);
        if (r.raw < CUT[r.kind] && !byClass) continue;
        inSet++;
        for (const [a, d] of PROFS) { const p = prof(a, d); for (let i = 0; i < 4; i++) if (AI.decideAction(r.t, r.me, p).action === PlayerAction.Fold) folds.push(`${a}/${d} raw=${r.raw.toFixed(3)}`); }
      }
      expect(deals).toBe(10);
      expect(inSet).toBeGreaterThanOrEqual(5);
      expect(folds).toEqual([]);
    } finally { restore(); }
  }, 180_000);

  it('GUARD: below the cut a NIT still folds in the same spot (Razz K-Q-J vs a completion plus an all-in call)', () => {
    const restore = detEnv(3202);
    try {
      let folds = 0, n = 0;
      for (let g = 0, got = 0; got < 10 && g < 200; g++) {
        const r = spot('razz', 'Kd Qc Jh', 'callai', 30); if (!r) continue; got++;
        expect(r.raw).toBeLessThan(CUT.razz);
        for (let i = 0; i < 6; i++) { n++; if (AI.decideAction(r.t, r.me, prof('NIT', 'hard')).action === PlayerAction.Fold) folds++; }
      }
      expect(n).toBe(60);
      expect(folds / n).toBeGreaterThan(0.9);
    } finally { restore(); }
  }, 120_000);
});

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
 * Review fix-ups (on cdb31dd):
 *  - REG-1 / MEAS-4: "one" counts FULL raises (betLevelsThisStreet): an all-in for less than a full raise made
 *    before or after the completion / open still read as a second raise (hard NIT Razz A-2-3 64%, Stud 8 A-2-3
 *    suited 76-86%, Five Card Draw aces and 3-3-2-2-K 100%);
 *  - REG-2: facing an all-in, a call that commits a third of a 100 BB stack (the depth at risk) is a stack-off
 *    however deep the bot is (a 400 BB bot called a lone 100 BB shove with a pair of aces: 9-15% continues);
 *  - MEAS-3: Five Card Draw stack-off premiums (aces up, trips, pat hands) by made-hand class (the percentile
 *    put 6-21% of their suit combinations under FIVE_DRAW_STACKOFF_PREMIUM and they folded to a 100 BB shove).
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

type Mode = 'callai' | 'shortai' | 'shortFirst' | 'shortAfter';
/**
 * A fresh 5-handed table, `h` planted for the seat to act; null on a card clash or an off-shape deal.
 *  'callai'     - one completion (Stud family) / one 3 BB open (Five Card Draw) / one fixed-limit bet (2-7, Badugi),
 *                 then the next seat, `short` chips behind, CALLS: all-in for less (lastAction AllIn, no raise);
 *  'shortai'    - (Stud family) the first seat after the bring-in moves all-in for `short`, under the completion;
 *  'shortFirst' - (review REG-1) the first seat moves all-in for `short`, LESS than a full raise (Stud: under the
 *                 completion; Five Card Draw: 80 over the 50 big blind), then the next seat makes the full bet
 *                 (the completion / an open to 150);
 *  'shortAfter' - (review REG-1) the full bet first, then the next seat moves all-in TO `short`, a raise of less
 *                 than a full one (Stud 50 -> 70, Five Card Draw 150 -> 200, 2-7 / Badugi 100 -> 130).
 * The shortFirst / shortAfter rounds hold TWO raises (raisesThisStreet 2) but ONE full raise (one bet level).
 */
function spot(v: string, h: string, mode: Mode, short: number): { t: any; me: number; raw: number; kind: string } | null {
  const t = make[v](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-vsai-${i}`, true); t.startNewHand();
  const kind = SDS.studDrawKindOf(t.variantId, t); const stud = SDS.isStudKind(kind);
  let a0 = t.activeSeatIndex;
  if (stud && t.seats[a0].currentBet > 0 && t.getCallAmount(t.seats[a0]) === 0) { t.playerCheck(a0); a0 = t.activeSeatIndex; }   // the bring-in stays
  const fullBet = (s: number): boolean => t.playerRaise(s, stud ? t.getCompleteAmount() : kind === 'draw-hi' ? 150 : t.getMinRaise());
  let shorty = a0;
  if (mode === 'shortai') { t.seats[a0].chipCount = short; if (!t.playerAllIn(a0) || !t.seats[a0].allIn) return null; }
  else if (mode === 'shortFirst') {
    t.seats[a0].chipCount = short; if (!t.playerAllIn(a0) || !t.seats[a0].allIn) return null;
    const a1 = t.activeSeatIndex; if (a1 < 0 || a1 === a0 || !fullBet(a1)) return null;
  } else if (mode === 'shortAfter') {
    if (!fullBet(a0)) return null;
    shorty = t.activeSeatIndex; if (shorty < 0 || shorty === a0) return null;
    t.seats[shorty].chipCount = short - t.seats[shorty].currentBet;
    if (!t.playerAllIn(shorty) || !t.seats[shorty].allIn) return null;
  } else {
    if (!fullBet(a0)) return null;
    shorty = t.activeSeatIndex; if (shorty < 0 || shorty === a0) return null;
    t.seats[shorty].chipCount = short;
    if (!t.playerCall(shorty) || !t.seats[shorty].allIn || t.seats[shorty].currentBet >= t.currentBetToMatch) return null;
  }
  if (mode === 'shortFirst' || mode === 'shortAfter') {
    // The precondition: two raises this round, ONE of them full (a draw game's posted big blind is its first level).
    expect([t.seats[shorty].allIn, t.raisesThisStreet, t.betLevelsThisStreet - (stud ? 0 : 1)]).toEqual([true, 2, 1]);
  } else {
    // The precondition: the short stack is all-in (read as two raises by modelOpponents), ONE raise this round.
    expect([t.seats[shorty].lastAction, t.raisesThisStreet]).toEqual([PlayerAction.AllIn, 1]);
  }
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

  it('review REG-2: a 400 BB bot facing a lone 100 BB shove decides as a 100 BB bot does (100 BB is at risk either way), closing and with players behind, every archetype and difficulty', () => {
    const restore = detEnv(3105);
    try {
      // One decision on a table where every bot holds `deep` BB; Math.random reseeded per decision (the same noise).
      const decide = (deep: number, closer: boolean, cards: any[], p: any, seed: number): any => {
        const t = make['five-card-draw']();
        for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 3 ? 'human-vsai-' : 'ai-vsai-') + i, i !== 3);
        for (let i = 0; i < 6; i++) t.seats[i].chipCount = i === 3 ? 100 * 50 : deep * 50;
        t.startNewHand();
        expect(t.activeSeatIndex).toBe(3);
        expect(t.playerAllIn(3)).toBe(true);
        if (closer) { let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 2) t.playerFold(t.activeSeatIndex); }
        const me = t.activeSeatIndex; expect(me).toBe(closer ? 2 : 4);
        t.seats[me].holeCards = cards.map((c) => ({ ...c }));
        const r = Math.random; let s = seed >>> 0;
        Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
        try { return AI.decideAction(t, me, p); } finally { Math.random = r; }
      };
      const randomHand = (): any[] => {
        const out: any[] = [];
        while (out.length < 5) { const c = { rank: 2 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) }; if (!out.some((x) => same(x, c))) out.push(c); }
        return out;
      };
      const diffs: string[] = []; let n = 0, folds100 = 0, valueSet = 0;
      for (const closer of [true, false]) for (const a of ARCH) for (const diff of DIFFS) {
        const p = prof(a, diff);
        for (const cards of [ranks('AAK73'), ranks('AA962'), ranks('3322K'), ranks('QQJJ5'), randomHand(), randomHand(), randomHand()]) {
          const seed = Math.floor(Math.random() * 4294967296);
          const f100 = decide(100, closer, cards, p, seed).action === PlayerAction.Fold;
          const f400 = decide(400, closer, cards, p, seed).action === PlayerAction.Fold;
          n++; if (f100) folds100++; if (AI.fiveDrawAcesOrBetter(cards)) valueSet++;
          if (f100 !== f400) diffs.push(`${closer ? 'closer' : 'behind'} ${a}/${diff} ${cards.map((c: any) => c.rank).join('-')}: 100 BB ${f100 ? 'fold' : 'continue'}, 400 BB ${f400 ? 'fold' : 'continue'}`);
        }
      }
      expect(n).toBe(2 * 7 * 4 * 7);
      expect(valueSet).toBeGreaterThanOrEqual(2 * 7 * 4 * 4);   // the planted value-set hands
      expect(folds100 / n).toBeGreaterThan(0.5);                 // the 100 BB gate folds most of them
      expect(diffs).toEqual([]);
    } finally { restore(); }
  }, 300_000);
});

describe('review MEAS-3: Five Card Draw stack-off premiums by made-hand class', () => {
  it('fiveDrawStackOffPremium is exactly "aces up or better" (hiValue >= A-A-2-2-3) over 20,000 random hands', () => {
    const restore = detEnv(3401);
    try {
      const floor = SDS.hiValue(C('As Ah 2d 2c 3s'));
      for (let k = 0; k < 20000; k++) {
        const deck: any[] = []; for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
        for (let i = 0; i < 5; i++) { const j = i + Math.floor(Math.random() * (deck.length - i)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
        const h = deck.slice(0, 5); const want = SDS.hiValue(h) >= floor;
        if (AI.fiveDrawStackOffPremium(h) !== want) expect([h, want]).toEqual([h, !want]);
      }
      expect(AI.fiveDrawStackOffPremium(C('Kd Kh Qd Qh As'))).toBe(false);   // kings up: by its percentile only
      expect(AI.fiveDrawStackOffPremium(C('2s 3d 4h 5c Ad'))).toBe(true);    // the wheel
    } finally { restore(); }
  }, 60_000);

  it('every suit combination of A-A-K-K-3 / A-A-2-2-3 / 2-2-2-3-4 read under FIVE_DRAW_STACKOFF_PREMIUM continues vs a lone 100 BB shove, closing and with players behind, every archetype and difficulty', () => {
    const restore = detEnv(3402);
    try {
      const folds: string[] = []; let n = 0;
      for (const pattern of ['AAKK3', 'AA223', '22234']) {
        const rk = pattern.split('').map((ch) => RK[ch] ?? Number(ch));
        const below: any[][] = [];
        for (let m = 0; m < 1024; m++) {
          const cards = rk.map((rank, i) => ({ rank, suit: (m >> (2 * i)) & 3 }));
          if (cards.some((c, i) => cards.some((d, j) => j > i && same(c, d)))) continue;
          const raw = SDS.equityToPercentile('draw-hi', SDS.firstRoundEquity('draw-hi', cards, [], SDS.drawsLeftAt('draw-hi', GamePhase.PreFlop), 0));
          if (raw < AI.FIVE_DRAW_STACKOFF_PREMIUM) below.push(cards);
        }
        // The precondition (2b5ac52 / cdb31dd read these on the percentile): some suit combinations fall under it.
        expect([pattern, below.length >= 3]).toEqual([pattern, true]);
        const step = Math.max(1, Math.floor(below.length / 6));
        for (let i = 0; i < below.length; i += step) for (const closer of [true, false]) for (const a of ARCH) for (const diff of DIFFS) {
          const { t, me } = shoveSpot(100, closer);
          t.seats[me].holeCards = below[i].map((c) => ({ ...c }));
          expect(AI.fiveDrawStackOffPremium(t.seats[me].holeCards)).toBe(true);
          n++; if (AI.decideAction(t, me, prof(a, diff)).action === PlayerAction.Fold) folds.push(`${pattern} ${below[i].map((c: any) => c.rank + 'hdcs'[c.suit]).join('')} ${closer ? 'closer' : 'behind'} ${a}/${diff}`);
        }
      }
      expect(n).toBeGreaterThanOrEqual(3 * 3 * 2 * 7 * 4);
      expect(folds).toEqual([]);
    } finally { restore(); }
  }, 300_000);
});

describe('SD2-2: the value set holds with a short stack all-in in the pot (an all-in call is not a raise)', () => {
  const PROFS: [string, string][] = [['NIT', 'hard'], ['NIT', 'medium'], ['NIT', 'easy'], ['TAG', 'hard'], ['LAG', 'medium'], ['ROCK', 'hard'], ['FISH', 'medium'], ['MANIAC', 'hard'], ['CALLING_STATION', 'medium']];
  it.each([
    ['razz', 'Ad 2c 3h', 'callai', 30], ['stud-hi-lo', 'Ah 2h 3h', 'callai', 30], ['seven-stud', 'Kd Kc 9h', 'callai', 30],
    ['razz', 'Ad 2c 3h', 'shortai', 40], ['stud-hi-lo', 'Ah 2h 3h', 'shortai', 40], ['seven-stud', 'Kd Kc 9h', 'shortai', 40],
    ['five-card-draw', 'Ah Ad Kc 7s 3h', 'callai', 100], ['five-card-draw', '3h 3d 2c 2s Kh', 'callai', 100], ['five-card-draw', '7h 7d 3c 3s Ah', 'callai', 100],
    ['triple-draw', '7h 5d 3c 2s Kh', 'callai', 60], ['badugi', 'As 2h 3d 8c', 'callai', 60],
    // review REG-1 / MEAS-4: an all-in for less than a full raise, before or after the one full bet
    ['razz', 'Ad 2c 3h', 'shortFirst', 40], ['stud-hi-lo', 'Ah 2h 3h', 'shortFirst', 40], ['seven-stud', 'Kd Kc 9h', 'shortFirst', 40],
    ['five-card-draw', 'Ah Ad Kc 7s 3h', 'shortFirst', 80], ['five-card-draw', '3h 3d 2c 2s Kh', 'shortFirst', 80],
    ['razz', 'Ad 2c 3h', 'shortAfter', 70], ['stud-hi-lo', 'Ah 2h 3h', 'shortAfter', 70], ['seven-stud', 'Kd Kc 9h', 'shortAfter', 70],
    ['five-card-draw', 'Ah Ad Kc 7s 3h', 'shortAfter', 200], ['five-card-draw', '3h 3d 2c 2s Kh', 'shortAfter', 200],
    ['triple-draw', '7h 5d 3c 2s Kh', 'shortAfter', 130], ['badugi', 'As 2h 3d 8c', 'shortAfter', 130],
  ] as [string, string, Mode, number][])('%s %s, %s (%d chips): no archetype folds it when it is in the set', (v, h, mode, short) => {
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

  it('GUARD (review REG-1): two FULL raises are still a 3-bet (Five Card Draw 3-3-2-2-K: an open to 150, then a short stack all-in to 300, a full raise): a hard NIT folds it', () => {
    const restore = detEnv(3203);
    try {
      let folds = 0, n = 0;
      for (let g = 0, got = 0; got < 10 && g < 200; g++) {
        const t = make['five-card-draw'](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-vsai-${i}`, true); t.startNewHand();
        const a0 = t.activeSeatIndex; if (!t.playerRaise(a0, 150)) continue;
        const a1 = t.activeSeatIndex; t.seats[a1].chipCount = 300 - t.seats[a1].currentBet;
        if (!t.playerAllIn(a1) || !t.seats[a1].allIn) continue;
        expect([t.raisesThisStreet, t.betLevelsThisStreet]).toEqual([2, 3]);
        const me = t.activeSeatIndex; const hand = C('3h 3d 2c 2s Kh');
        const others: any[] = []; for (const x of t.seats) if (x.seatIndex !== me) others.push(...x.holeCards);
        if (others.some((c) => hand.some((y: any) => same(y, c)))) continue;
        t.seats[me].holeCards = hand; got++;
        for (let i = 0; i < 6; i++) { n++; if (AI.decideAction(t, me, prof('NIT', 'hard')).action === PlayerAction.Fold) folds++; }
      }
      expect(n).toBe(60);
      expect(folds / n).toBeGreaterThan(0.9);
    } finally { restore(); }
  }, 120_000);
});

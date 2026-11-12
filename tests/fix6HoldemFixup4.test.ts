/**
 * tests/fix6HoldemFixup4.test.ts (2026-11-10, bots review fix round 4, fix-up 4), node level. No-limit Hold'em.
 *  1. HOLDEM-F3-REGRESSION-1 — the price floor after the flop is a MICRO floor (POSTFLOP_MICRO_CALL_NEED, 0.10).
 *     Fix-up 3 used the pre-flop MICRO_CALL_NEED (0.25: heads-up a half-pot bet), and the committed-bettor test
 *     (nearAllInRaiser: no more than the pot behind) reaches ordinary river bets: every archetype called a 0.33 / 0.45-pot
 *     river bet with air (folded 0%; live 0dc1b96 86-100%).
 *  2. HOLDEM-F3-MEASUREMENT-2 / EXPLOIT-3 — the MANIAC price rule reads Monte Carlo equity at every difficulty. Below hard
 *     getPostFlopStrength is a static ladder, so a medium / easy MANIAC folded one pair 162 / 171 and two pair 14 / 40 to a
 *     heads-up any-two overbet all-in (live 35 / 0).
 *  3. HOLDEM-F3-EXPLOIT-1 — a dry side pot is checked down (sidePotAgainstShortStack). Deep MANIACs flat-call a short
 *     player's all-in (or his raise to 75-95% of 12-25 BB) three or four handed under the light re-raise cap; after the flop
 *     one of them bet the side pot (or raised his last chips) with air and the others folded: their calls were dead money in
 *     his main pot (+204 to +328 BB/100 against five 100 BB MANIACs, live -52 to -76). Now a bet or raise there below
 *     MANIAC_ALLIN_VALUE_STRENGTH is a check or a call.
 * Real PokerTable + real decideAction; seeded Math.random, a seeded deck (crypto.randomBytes) and a frozen clock.
 */
import { PokerTable, PlayerAction, GamePhase } from '../src/game/PokerTable';
import { decideAction, nearAllInRaiser } from '../src/ai/AIPlayer';
import { evaluateHand, HandRank } from '../src/game/HandEvaluator';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
function seedAll(seed: number): () => void {
  const orig = Math.random, rb = nodeCrypto.randomBytes, now = Date.now;
  let s = seed >>> 0, ctr = 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  nodeCrypto.randomBytes = (n: number) => {
    let buf = Buffer.alloc(0);
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix6-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  Date.now = () => 1_700_000_000_000;
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; Date.now = now; };
}
const BB = 100;
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'p', archetype, vpip: 0.5, pfr: 0.3, aggressionFactor: 2, bluffFrequency: 0.2 } as any);
let tableNo = 0;
function sit(t: PokerTable, stacks: number[]): void {
  const id = tableNo++;
  for (let i = 0; i < stacks.length; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-fx6-' : 'ai-fx6-') + id + '-' + i, i !== 0)).toBe(true);
}
const pot = (t: PokerTable): number => t.seats.reduce((s, x) => s + (x.totalInvestedThisHand || 0), 0);
/** Air: no pair or better that uses a hole card (playing the board counts as air). */
function isAir(hole: any[], board: any[]): boolean {
  const r = evaluateHand([...hole, ...board]).handRank;
  if (r === HandRank.HighCard) return true;
  return r === evaluateHand([...board]).handRank && hole[0].rank !== hole[1].rank && !hole.some((c) => board.some((b) => b.rank === c.rank));
}

/**
 * Heads-up to the river: UTG (seat 1, a 100 BB bot) opens to 3 BB (forced), the others fold, the human (big blind, 40 BB)
 * calls; on the flop and the turn he bets half the pot and the bot calls (forced); on the river he bets `rivF` of the pot
 * (not all-in: he keeps chips, and is committed). The bot's answer with air.
 */
function riverBet(arch: string, difficulty: string, rivF: number, n: number, seed: number): { spots: number; near: number; air: number; airFold: number } {
  let spots = 0, near = 0, air = 0, airFold = 0;
  const restore = seedAll(seed);
  try {
    for (let k = 0; k < n; k++) {
      const t = new PokerTable({ tableId: 'r', tableName: 'r', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
      sit(t, [40, 100, 100, 100, 100, 100]);
      (t as any).presetFirstButton(4);
      expect(t.startNewHand()).toBe(true);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      for (const s of [2, 3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerCall(0)).toBe(true);
      for (const ph of [GamePhase.Flop, GamePhase.Turn]) {
        expect([t.currentPhase, t.activeSeatIndex]).toEqual([ph, 0]);
        expect(t.playerRaise(0, Math.max(BB, Math.round(0.5 * pot(t) / 50) * 50))).toBe(true);
        expect(t.playerCall(1)).toBe(true);
      }
      expect([t.currentPhase, t.activeSeatIndex]).toEqual([GamePhase.River, 0]);
      const rb = Math.max(BB, Math.round(rivF * pot(t) / 50) * 50);
      expect(rb < t.seats[0].chipCount).toBe(true);
      expect(t.playerRaise(0, rb)).toBe(true);
      spots++;
      if (nearAllInRaiser(t, t.seats[1])) near++;
      if (!isAir(t.seats[1].holeCards, t.communityCards)) continue;
      air++;
      if (decideAction(t, 1, prof(arch, difficulty)).action === PlayerAction.Fold) airFold++;
    }
  } finally { restore(); }
  return { spots, near, air, airFold };
}

/**
 * Heads-up, 100 BB each: the human raises to 3 BB, the bot calls (forced); on the flop the bot checks (forced) and the human
 * moves all-in (97 BB into 6 BB: 48% needed). The bot's answer by its hand: one pair with a hole card, two pair or better.
 */
function overbetShove(arch: string, difficulty: string, n: number, seed: number): { pair: number; pairCont: number; two: number; twoCont: number } {
  let pair = 0, pairCont = 0, two = 0, twoCont = 0;
  const restore = seedAll(seed);
  try {
    for (let k = 0; k < n; k++) {
      const t = new PokerTable({ tableId: 'o', tableName: 'o', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
      sit(t, [100, 100]);
      expect(t.startNewHand()).toBe(true);
      let g = 0;
      while (t.currentPhase === GamePhase.PreFlop && t.isHandInProgress() && g++ < 6) {
        const a = t.activeSeatIndex;
        if (a === 0 && t.seats[0].currentBet < 3 * BB) expect(t.playerRaise(0, 3 * BB)).toBe(true);
        else if (t.getCallAmount(t.seats[a]) > 0) expect(t.playerCall(a)).toBe(true);
        else expect(t.playerCheck(a)).toBe(true);
      }
      expect(t.currentPhase).toBe(GamePhase.Flop);
      if (t.activeSeatIndex === 1) expect(t.playerCheck(1)).toBe(true);
      expect(t.activeSeatIndex).toBe(0);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      const hole = t.seats[1].holeCards, board = t.communityCards;
      const r = evaluateHand([...hole, ...board]).handRank;
      const holePair = hole[0].rank === hole[1].rank || hole.some((c) => board.some((b) => b.rank === c.rank));
      const cont = decideAction(t, 1, prof(arch, difficulty)).action !== PlayerAction.Fold;
      if (r >= HandRank.TwoPair && holePair) { two++; if (cont) twoCont++; }
      else if (r === HandRank.OnePair && holePair) { pair++; if (cont) pairCont++; }
    }
  } finally { restore(); }
  return { pair, pairCont, two, twoCont };
}

/**
 * Six-handed: the human (big blind, humanBB) faces UTG's 3 BB open (seat 1); MP and CO call (forced), the button and the small
 * blind fold; the human moves all-in (frac 1) or raises to `frac` of his stack; the three bots call (forced). On the flop each
 * bot that acts before the human (no bet to call) decides, then the human moves in his last chips (if any) and each bot faces
 * that micro all-in. A side-pot bet / raise with air (no pair with a hole card, no four-flush, no four to a straight) or with
 * trips or better (with a hole card) is counted. Every bot is a hard MANIAC with botBB.
 */
function sidePot(humanBB: number, frac: number, botBB: number, n: number, seed: number): { airSpots: number; airAgg: number; valSpots: number; valAgg: number } {
  let airSpots = 0, airAgg = 0, valSpots = 0, valAgg = 0;
  const restore = seedAll(seed);
  try {
    for (let k = 0; k < n; k++) {
      const t = new PokerTable({ tableId: 's', tableName: 's', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
      sit(t, [humanBB, botBB, botBB, botBB, botBB, botBB]);
      (t as any).presetFirstButton(4);
      expect(t.startNewHand()).toBe(true);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      for (const x of [2, 3]) expect(t.playerCall(x)).toBe(true);
      for (const x of [4, 5]) expect(t.playerFold(x)).toBe(true);
      expect(frac >= 1 ? t.playerAllIn(0) : t.playerRaise(0, Math.round(frac * humanBB * 2) * BB / 2)).toBe(true);
      for (const x of [1, 2, 3]) expect(t.playerCall(x)).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Flop);
      let g = 0;
      while (t.currentPhase === GamePhase.Flop && t.isHandInProgress() && g++ < 8) {
        const a = t.activeSeatIndex;
        if (a < 0) break;
        if (a === 0) { expect(t.playerAllIn(0)).toBe(true); continue; }
        const hole = t.seats[a].holeCards, board = t.communityCards, all = [...hole, ...board];
        const pairWithHole = hole[0].rank === hole[1].rank || hole.some((c) => board.some((b) => b.rank === c.rank));
        const fourFlush = [0, 1, 2, 3].some((su) => all.filter((c) => c.suit === su).length >= 4);
        const ranks = new Set<number>(all.map((c) => c.rank as number)); if (ranks.has(14)) ranks.add(1);
        let fourStraight = false; for (let lo = 1; lo <= 11; lo++) { let m = 0; for (let r = lo; r < lo + 5; r++) if (ranks.has(r)) m++; if (m >= 4) fourStraight = true; }
        const air = !pairWithHole && !fourFlush && !fourStraight;
        const value = pairWithHole && evaluateHand(all).handRank >= HandRank.ThreeOfAKind;
        const d = decideAction(t, a, prof('MANIAC'));
        const agg = d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn;
        if (air) { airSpots++; if (agg) airAgg++; }
        if (value) { valSpots++; if (agg) valAgg++; }
        // continue the street passively: the human's main pot is what is scored here
        const ok = t.getCallAmount(t.seats[a]) > 0 ? (t.playerCall(a) || t.playerAllIn(a)) : t.playerCheck(a);
        if (!ok) t.playerFold(a);
      }
    }
  } finally { restore(); }
  return { airSpots, airAgg, valSpots, valAgg };
}

describe('fix-up 4 — a micro floor after the flop; the MANIAC price on real equity; a dry side pot is checked down', () => {
  const log: string[] = [];
  afterAll(() => process.stdout.write(`fix6 holdem fix-up 4: ${log.join('; ')}\n`));

  it('the post-flop floor is micro: POSTFLOP_MICRO_CALL_NEED is 0.10, the pre-flop MICRO_CALL_NEED stays 0.25', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AI = require('../src/ai/AIPlayer');
    expect([AI.POSTFLOP_MICRO_CALL_NEED, AI.MICRO_CALL_NEED]).toEqual([0.10, 0.25]);
  });

  it('a committed 40 BB human\'s 0.33 / 0.45-pot river bet (not all-in) is folded by TAG / LAG / NIT / ROCK / MANIAC air >= 75% (9cfda99: 0%; live 0dc1b96 86-100%)', () => {
    const bad: string[] = [];
    for (const arch of ['TAG', 'LAG', 'NIT', 'ROCK', 'MANIAC']) {
      for (const f of [0.33, 0.45]) {
        const r = riverBet(arch, 'medium', f, 120, 6600 + Math.round(f * 100));
        log.push(`${arch} river ${f} pot: air ${r.airFold}/${r.air} fold (near ${r.near}/${r.spots})`);
        if (r.spots < 100 || r.near < r.spots || r.air < 30 || r.airFold < 0.75 * r.air) bad.push(`${arch} ${f}: ${r.airFold}/${r.air} air folds, near ${r.near}/${r.spots}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('a medium / easy MANIAC keeps one pair (>= 70%) and two pair or better (>= 90%) against a heads-up any-two overbet all-in on the flop (9cfda99: 2% / 67%; live 0dc1b96 80% / 100%)', () => {
    const bad: string[] = [];
    for (const diff of ['medium', 'easy']) {
      const r = overbetShove('MANIAC', diff, 200, 6700);
      log.push(`MANIAC ${diff} vs a 97 BB flop all-in into 6 BB: one pair ${r.pairCont}/${r.pair}, two pair+ ${r.twoCont}/${r.two} continue`);
      if (r.pair < 40 || r.pairCont < 0.70 * r.pair || r.two < 10 || r.twoCont < 0.90 * r.two) bad.push(`${diff}: one pair ${r.pairCont}/${r.pair}, two pair+ ${r.twoCont}/${r.two}`);
    }
    expect(bad).toEqual([]);
  });

  it('a dry side pot is checked down: with a 12 BB human all-in (or a 20 BB human with 1 BB left) and three 100 BB MANIACs in, MANIAC air never bets or raises the side pot after the flop (9cfda99: it bets / raises most of it), trips or better still do (>= 60%)', () => {
    const bad: string[] = [];
    for (const [h, f] of [[12, 1], [20, 0.95]]) {
      const r = sidePot(h, f, 100, 160, 6900 + h);
      log.push(`side pot vs a ${h} BB human (${f < 1 ? 'raise to ' + f : 'all-in'}): air bets / raises ${r.airAgg}/${r.airSpots}, trips+ ${r.valAgg}/${r.valSpots}`);
      if (r.airSpots < 60 || r.airAgg > 0 || r.valSpots < 5 || r.valAgg < 0.6 * r.valSpots) bad.push(`${h} BB: air ${r.airAgg}/${r.airSpots}, trips+ ${r.valAgg}/${r.valSpots}`);
    }
    expect(bad).toEqual([]);
  });
});

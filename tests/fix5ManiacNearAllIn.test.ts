/**
 * tests/fix5ManiacNearAllIn.test.ts (2026-11-09, bots review fix round 4, fix-up 3: HOLDEM-RR2-EXPLOIT-1 / -2), node level.
 * Fix-up 5 (2026-11-10, THE MANIAC CLASS): a MANIAC facing a raise or an all-in now plays 0dc1b96's MANIAC
 * (maniacFacingRaise0dc1b96): against a committed raise it re-raises / moves in ~95% (never a flat call), against the all-in
 * ~70% (0dc1b96's push/fold on the chips-left depth), so tests 2-4 pin that instead of the stack-off range (no flat call
 * is the part of fix-up 3 that stays). The post-flop rows (5-9) are unchanged.
 * No-limit Hold'em. A raise that leaves the raiser half of his hand-start stack or less, or no more than the pot a call
 * would make (stack-to-pot ratio <= 1), is the all-in it effectively is: he calls any re-raise. 7740996 keyed every all-in rule on a real all-in only. A human who re-raised a MANIAC's raise to
 * 50-95% of his stack, NOT all-in, then met either
 *  (a) the commit gate at the depth of the LARGEST live opponent: a 100 BB MANIAC continued 16% against a 40 BB human's
 *      raise to 38 BB (69% against his all-in, 91% on live 0dc1b96), and 16% against a 75 BB human's raise to 45; or
 *  (b) the light re-raise cap: a 300 BB MANIAC flat-called ~70%, and on the flop it folded air to his last 2-5 BB
 *      (postFlopStrategy's MANIAC "raise or fold" has no price; NIT and ROCK fold below a fixed strength too).
 * Re-raise to 95% of the stack, call any re-raise, shove any flop (hard, whole line, BB/100): +82 (5) for a 40 BB human
 * against two 100 BB MANIACs, +1,285 (104) for a 100 BB human against five 300 BB MANIACs (live 0dc1b96 -28 / -131).
 * With NEAR_ALLIN_SPR every pre-flop all-in rule reads such a raise as the all-in (deeper than the push/fold zone; a bot
 * that continues re-raises to cover him), and after the flop, in the Hold'em family, against an all-in or a bet from a
 * committed player: a FOLD at no more than a micro price per opponent (POSTFLOP_MICRO_CALL_NEED, fix-up 4) becomes a call, and
 * a MANIAC continues only with MANIAC_ALLIN_VALUE_STRENGTH or above the price (its "raise or fold" called 45% of its air
 * there at any price: flat a MANIAC raise with any two, move in on the flop with a pair or a draw, won +41 (9) BB/100 with
 * two 100 BB MANIACs and a 40 BB stack, live -3 (10)); not in pot-limit Omaha (the floor only there).
 * Real PokerTable + real decideAction; seeded Math.random, a seeded deck (crypto.randomBytes) and a frozen clock.
 * 6 seats at 50/100, button 4: small blind 5, big blind 0 (the human), UTG 1, MP 2, CO 3.
 */
import { PokerTable, PlayerAction, GamePhase } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { decideAction } from '../src/ai/AIPlayer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
function seedAll(seed: number): () => void {
  const orig = Math.random, rb = nodeCrypto.randomBytes, now = Date.now;
  let s = seed >>> 0, ctr = 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  nodeCrypto.randomBytes = (n: number) => {
    let buf = Buffer.alloc(0);
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix5-mna-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  Date.now = () => 1_700_000_000_000;
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; Date.now = now; };
}
const BB = 100;
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'p', archetype, vpip: 0.9, pfr: 0.8, aggressionFactor: 5, bluffFrequency: 0.4 } as any);
let tableNo = 0;
function table(stacks: number[]): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-mna-' : 'ai-mna-') + id + '-' + i, i !== 0)).toBe(true);
  (t as any).presetFirstButton(4);
  expect(t.startNewHand()).toBe(true);
  return t;
}
type Resp = { spots: number; cont: number; flats: number };
/**
 * The MANIAC (UTG, seat 1, maniacBB) opens first in (its own decision; no spot when it limps or folds); MP / CO / button /
 * small blind fold; the human (big blind, humanBB) re-raises to `frac` of his stack (frac 1 = all-in); the MANIAC's response.
 * flats = it called with chips left over the human's (he keeps chips, the hand goes to the flop).
 */
function opener(maniacBB: number, humanBB: number, frac: number, difficulty = 'hard', n = 300): Resp {
  let spots = 0, cont = 0, flats = 0;
  const restore = seedAll(6150 + maniacBB + humanBB);   // the same deals for every frac
  try {
    for (let k = 0; k < n; k++) {
      const t = table([humanBB, maniacBB, 100, 100, 100, 100]);
      expect(t.activeSeatIndex).toBe(1);
      const open = decideAction(t, 1, prof('MANIAC', difficulty));
      if (open.action !== PlayerAction.Raise || !t.playerRaise(1, open.raiseAmount)) continue;
      for (const s of [2, 3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(frac >= 1 ? t.playerAllIn(0) : t.playerRaise(0, Math.floor(frac * humanBB * BB / 50) * 50)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      spots++;
      const d = decideAction(t, 1, prof('MANIAC', difficulty));
      if (d.action !== PlayerAction.Fold) cont++;
      if (d.action === PlayerAction.Call && frac < 1) flats++;
    }
  } finally { restore(); }
  return { spots, cont, flats };
}
const pct = (r: Resp): string => `${(100 * r.cont / Math.max(1, r.spots)).toFixed(1)}% (flats ${(100 * r.flats / Math.max(1, r.spots)).toFixed(1)}%, ${r.spots} spots)`;

/**
 * Post-flop: UTG (seat 1, botBB) opens to 3 BB (forced), `others` of MP / CO call, button and small blind fold, the human
 * (big blind, humanBB) re-raises to humanBB - leftBB, everyone calls (forced); on the flop the human (first to act) moves
 * all-in for his last leftBB (bet < 1: he bets that share of it, keeping the rest); each bot's decision.
 */
function flopSpot(arch: string, difficulty: string, botBB: number, humanBB: number, leftBB: number, others: number, bet: number, n: number, seed: number): { spots: number; folds: number } {
  let spots = 0, folds = 0;
  const restore = seedAll(seed);
  try {
    for (let k = 0; k < n; k++) {
      const t = table([humanBB, botBB, botBB, botBB, 100, 100]);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      for (const s of [2, 3]) expect(s - 2 < others ? t.playerCall(s) : t.playerFold(s)).toBe(true);
      for (const s of [4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerRaise(0, (humanBB - leftBB) * BB)).toBe(true);
      for (let s = 1; s <= 1 + others; s++) expect(t.playerCall(s)).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Flop);
      expect(t.activeSeatIndex).toBe(0);
      expect(bet >= 1 ? t.playerAllIn(0) : t.playerRaise(0, Math.max(t.getMinRaise(), Math.round(bet * leftBB * BB)))).toBe(true);
      for (let g = 0; g < 1 + others && t.activeSeatIndex > 0 && t.currentPhase === GamePhase.Flop; g++) {
        const a = t.activeSeatIndex;
        spots++;
        const d = decideAction(t, a, prof(arch, difficulty));
        if (d.action === PlayerAction.Fold) { folds++; expect(t.playerFold(a)).toBe(true); }
        else expect(t.playerCall(a) || t.playerAllIn(a)).toBe(true);
      }
    }
  } finally { restore(); }
  return { spots, folds };
}

/**
 * UTG (the MANIAC, seat 1, 100 BB) opens to 3 BB (forced), the others fold, the human (big blind, 40 BB) calls; on the flop
 * he moves all-in (37 BB into 6.5 BB: 46% needed). The MANIAC's answers, by its hand on the flop: air (no pair with a hole
 * card, no four-flush, no four to a straight) and strong (three of a kind or better with a hole card).
 */
function flopShoveVsManiac(difficulty: string, n: number, seed: number, humanBB = 40): { air: number; airCont: number; strong: number; strongCont: number } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const HE = require('../src/game/HandEvaluator');
  let air = 0, airCont = 0, strong = 0, strongCont = 0;
  const restore = seedAll(seed);
  try {
    for (let k = 0; k < n; k++) {
      const t = table([humanBB, 100, 100, 100, 100, 100]);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      for (const s of [2, 3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerCall(0)).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Flop);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      const hole = t.seats[1].holeCards, board = t.communityCards, all = [...hole, ...board];
      const rank = HE.evaluateHand(all).handRank;
      const pairWithHole = hole[0].rank === hole[1].rank || hole.some((c: any) => board.some((b: any) => b.rank === c.rank));
      const fourFlush = [0, 1, 2, 3].some((su) => all.filter((c: any) => c.suit === su).length >= 4);
      const ranks = new Set(all.map((c: any) => c.rank)); if (ranks.has(14)) ranks.add(1);
      let fourStraight = false; for (let lo = 1; lo <= 11; lo++) { let m = 0; for (let r = lo; r < lo + 5; r++) if (ranks.has(r)) m++; if (m >= 4) fourStraight = true; }
      const d = decideAction(t, 1, prof('MANIAC', difficulty));
      const cont = d.action !== PlayerAction.Fold;
      if (!pairWithHole && !fourFlush && !fourStraight) { air++; if (cont) airCont++; }
      else if (pairWithHole && rank >= HE.HandRank.ThreeOfAKind) { strong++; if (cont) strongCont++; }
    }
  } finally { restore(); }
  return { air, airCont, strong, strongCont };
}

/**
 * Pot-limit Omaha: UTG (seat 1) opens to 3 BB (forced), MP and CO call, the button and small blind fold, the human (big
 * blind, humanBB) calls; on the flop he bets his last chips first (a pot-sized bet: all-in for humanBB - 3 BB into 12.5 BB).
 * Each MANIAC's answer (all three are MANIACs).
 */
function ploFlopShove(humanBB: number, n: number, seed: number): { spots: number; cont: number } {
  let spots = 0, cont = 0;
  const restore = seedAll(seed);
  try {
    for (let k = 0; k < n; k++) {
      const t: any = new OmahaTable({ tableId: 'p', tableName: 'p', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any, false, 4);
      const id = tableNo++;
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, (i === 0 ? humanBB : 100) * BB, (i === 0 ? 'player-mna-' : 'ai-mna-') + id + '-' + i, i !== 0)).toBe(true);
      t.presetFirstButton(4);
      expect(t.startNewHand()).toBe(true);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      for (const s of [2, 3]) expect(t.playerCall(s)).toBe(true);
      for (const s of [4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerCall(0)).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Flop);
      expect(t.playerAllIn(0)).toBe(true);
      for (let g = 0; g < 3 && t.activeSeatIndex > 0 && t.currentPhase === GamePhase.Flop; g++) {
        const a = t.activeSeatIndex;
        spots++;
        const d = decideAction(t, a, prof('MANIAC'));
        if (d.action !== PlayerAction.Fold) { cont++; expect(t.playerCall(a) || t.playerAllIn(a)).toBe(true); }
        else expect(t.playerFold(a)).toBe(true);
      }
    }
  } finally { restore(); }
  return { spots, cont };
}

describe('fix-up 3 (HOLDEM-RR2-EXPLOIT-1 / -2) — a near-all-in raise is an all-in; a micro all-in is called on every street', () => {
  const log: string[] = [];
  afterAll(() => process.stdout.write(`fix5 MANIAC near all-in: ${log.join('; ')}\n`));

  it('the constant: a stack-to-pot ratio of 1 (fix-up 4: the half-stack clause, NEAR_ALLIN_LEFT_FRACTION, never fired alone and is gone)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AI = require('../src/ai/AIPlayer');
    expect([AI.NEAR_ALLIN_SPR, AI.NEAR_ALLIN_LEFT_FRACTION]).toEqual([1, undefined]);
  });

  it('the opener answers a 40-75 BB human\'s raise to 35-95% of his stack (a stack-to-pot ratio <= 1 left) at least as often as his all-in less 10 points, >= 58%, and never by a flat call (7740996, hard: 41% against 95% of 40 BB, 23% against 60% of 75 BB; a 500 BB MANIAC flat-called 58-63%; fix-up 5: 0dc1b96, ~95% / ~70%)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) {
      for (const [m, h, f] of [[100, 40, 0.95], [100, 75, 0.6], [100, 75, 0.5], [500, 60, 0.95], [500, 75, 0.6], [100, 40, 0.4], [500, 40, 0.35]]) {
        const near = opener(m, h, f, diff), all = opener(m, h, 1, diff);
        log.push(`${diff} ${m}/${h} raise ${f}: ${pct(near)} vs all-in ${pct(all)}`);
        if (near.spots < 200 || near.cont < 0.58 * near.spots || near.cont / near.spots < all.cont / all.spots - 0.10 || near.flats > 0) {
          bad.push(`${diff} MANIAC ${m} BB vs a ${h} BB human's raise to ${f}: ${pct(near)}, all-in ${pct(all)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('a 300 BB MANIAC answers a 100 BB human\'s raise to 60-95% of his stack as 0dc1b96 (>= 58%) and never flat-calls it (7740996: continued 73%, 64% by a flat call; f605403: the stack-off range for 100 BB, <= 32%)', () => {
    const bad: string[] = [];
    for (const f of [0.95, 0.75, 0.6]) {
      const near = opener(300, 100, f);
      log.push(`300/100 raise ${f}: ${pct(near)}`);
      if (near.spots < 200 || near.cont < 0.58 * near.spots || near.flats > 0) bad.push(`raise to ${f}: ${pct(near)}`);
    }
    expect(bad).toEqual([]);
  });

  it('a 3-bet that leaves the raiser more than the pot behind (a 100 BB human\'s 3-bet to 12 BB): the 300 BB MANIAC re-raises it as 0dc1b96 (>= 85%), not a flat call (7740996 and f605403 flat-called it)', () => {
    const r = opener(300, 100, 0.12);
    log.push(`300/100 3-bet to 12 BB: ${pct(r)}`);
    expect([r.cont >= 0.85 * r.spots, r.flats]).toEqual([true, 0]);
  });

  it('flop: facing the human\'s last 2-5 BB all-in (or a bet that leaves him less) in an 80-400 BB pot, no archetype folds (7740996: MANIAC, NIT and ROCK fold air)', () => {
    const bad: string[] = [];
    const ARCHS = ['MANIAC', 'NIT', 'ROCK', 'TAG', 'LAG', 'FISH', 'CALLING_STATION'];
    for (const arch of ARCHS) {
      for (const [diff, botBB, humanBB, left, others, bet, n] of [
        ['medium', 100, 40, 2, 0, 1, 120], ['medium', 300, 100, 5, 2, 1, 60], ['medium', 100, 40, 2, 0, 0.75, 120], ['hard', 100, 40, 2, 0, 1, 25],
      ] as Array<[string, number, number, number, number, number, number]>) {
        const r = flopSpot(arch, diff, botBB, humanBB, left, others, bet, n, 8100 + botBB + others);
        log.push(`${arch} ${diff} ${botBB}/${humanBB} left ${left} ${others ? others + 1 + '-way' : 'HU'}${bet < 1 ? ' bet' : ''}: ${r.folds}/${r.spots} folds`);
        if (r.spots < n || r.folds > 0) bad.push(`${arch} ${diff} ${botBB}/${humanBB} left ${left} others ${others} bet ${bet}: ${r.folds} of ${r.spots} folded`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the floor is for micro prices only: facing a 25 BB all-in into a ~30 BB pot (31% needed), a NIT still folds its air', () => {
    const r = flopSpot('NIT', 'medium', 100, 40, 25, 0, 1, 120, 8500);
    log.push(`NIT 25 BB all-in: ${r.folds}/${r.spots} folds`);
    expect(r.folds > 0.3 * r.spots).toBe(true);
  });

  it('a MANIAC prices a flop all-in: against 37 BB into 6.5 BB it folds its air (>= 80%; 7740996 continued 61% / 72% of it, hard / medium: its "raise" there is a call) and keeps three of a kind or better (>= 90%, hard)', () => {
    const bad: string[] = [];
    for (const [diff, n] of [['hard', 400], ['medium', 300]] as Array<[string, number]>) {
      const r = flopShoveVsManiac(diff, n, 8800);
      log.push(`MANIAC ${diff} vs a 37 BB flop all-in: air ${r.airCont}/${r.air} continue, trips+ ${r.strongCont}/${r.strong}`);
      if (r.air < 0.3 * n || r.airCont > 0.2 * r.air) bad.push(`${diff} air ${r.airCont}/${r.air}`);
      if (diff === 'hard' && (r.strong < 5 || r.strongCont < 0.9 * r.strong)) bad.push(`${diff} trips+ ${r.strongCont}/${r.strong}`);
    }
    expect(bad).toEqual([]);
  });

  it('it prices the all-in against any two cards too: against a 12 BB human\'s last 9 BB into 6.5 BB (37% needed) it still continues with >= 25% of its air (81eeba3, read only against the range a raise implies: 11%)', () => {
    const r = flopShoveVsManiac('hard', 300, 8900, 12);
    log.push(`MANIAC hard vs a 9 BB flop all-in: air ${r.airCont}/${r.air} continue`);
    expect(r.air >= 60 && r.airCont >= 0.25 * r.air).toBe(true);
  });

  it('pot-limit Omaha keeps the 7740996 MANIAC against a short flop all-in (no price rule there): three MANIACs facing a 12 / 20 BB human\'s last 9 / 17 BB continue >= 70% (7740996 76% / 77%; 96a901f, priced on its share against every live opponent: 58% / 56%)', () => {
    const bad: string[] = [];
    for (const h of [12, 20]) {
      const r = ploFlopShove(h, 150, 9100 + h);
      log.push(`PLO MANIAC 3-way vs a ${h} BB human's flop all-in: ${r.cont}/${r.spots} continue`);
      if (r.spots < 400 || r.cont < 0.70 * r.spots) bad.push(`${h} BB: ${r.cont}/${r.spots}`);
    }
    expect(bad).toEqual([]);
  });
});

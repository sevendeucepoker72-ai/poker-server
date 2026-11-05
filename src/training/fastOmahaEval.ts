// ============================================================================
// Allocation-free Omaha scoring for the bots' and the coach's equity and outs
// (.online bots review 2026-11-04, equity-variants C1: B6, Omaha Hi-Lo, B14).
//
// The engine's showdown never uses this module: OmahaTable still decides every
// pot with HandEvaluatorExtensions. This is only the fast inner loop of
// TrainingEngine.calculateEquity's Omaha path and of the bots' Omaha outs, so a
// 5- or 6-card Omaha simulation fits BOT_EQUITY_BUDGET_MS.
//
// Cards are packed ints: code = (suit << 4) | rank (rank 2..14, suit 0..3).
// ============================================================================
import { Card } from '../game/Card';

/** A card as a packed int: (suit << 4) | rank. */
export const cardCode = (c: { rank: number; suit: number }): number => (c.suit << 4) | c.rank;

const C5 = 1048576; // 16^5 — the category unit
const C4 = 65536;
const C3 = 4096;
const C2 = 256;
const C1 = 16;
const MUL = [1, C1, C2, C3, C4];
const WHEEL_MASK = (1 << 14) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
/** score5 of a royal flush: a 14-high straight flush, the highest possible score. */
const ROYAL_SCORE = 8 * C5 + 14 * C4;
/** Rank counts for paired hands; every slot read is zeroed again as it is read. */
const CNT = new Int8Array(15);

/** The distinct ranks in `mask`, packed highest first (one nibble each). */
function packDesc(mask: number): number {
  let s = 0;
  let k = 4;
  let mm = mask;
  while (mm) {
    const hi = 31 - Math.clz32(mm);
    s += hi * MUL[k--];
    mm &= ~(1 << hi);
  }
  return s;
}

/**
 * Comparable strength of exactly five cards (packed codes). Higher is better;
 * equal means a split.
 *
 * The encoding is exactly src/game/handEquity.ts fastHandScore's: category *
 * 16^5 plus the deciding ranks, one nibble each, highest first (a royal flush is
 * the 14-high straight flush, 8 * 16^5 + 14 * 16^4). tests/botsOmahaEquity
 * pins score5 === fastHandScore on random and edge-case hands, and
 * fastHandScore is pinned to the engine's evaluateHand + compareTo by
 * tests/insuranceEquity. score5 exists because fastHandScore takes Card
 * objects and allocates on every call — about 5x slower in the Omaha inner
 * loop. No allocation here.
 */
export function score5(a: number, b: number, c: number, d: number, e: number): number {
  const ra = a & 15, rb = b & 15, rc = c & 15, rd = d & 15, re = e & 15;
  const mask = (1 << ra) | (1 << rb) | (1 << rc) | (1 << rd) | (1 << re);
  let m = mask;
  let distinct = 0;
  while (m) { m &= m - 1; distinct++; }
  if (distinct === 5) {
    const flush = (((a ^ b) | (a ^ c) | (a ^ d) | (a ^ e)) >> 4) === 0;
    let straightHigh = 0;
    if (mask === WHEEL_MASK) straightHigh = 5;
    else {
      const low = mask & -mask;
      if (mask === low * 31) straightHigh = 31 - Math.clz32(mask);
    }
    if (straightHigh) {
      // Straight flush (a royal included: 8 | 14) or a straight. A straight has no kickers.
      return (flush ? 8 : 4) * C5 + straightHigh * C4;
    }
    return (flush ? 5 * C5 : 0) + packDesc(mask);
  }
  // A repeated rank: no flush or straight is possible with five cards.
  CNT[ra]++; CNT[rb]++; CNT[rc]++; CNT[rd]++; CNT[re]++;
  let quad = 0, trip = 0, pHi = 0, pLo = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = CNT[r];
    if (n === 0) continue;
    CNT[r] = 0;
    if (n === 4) quad = r;
    else if (n === 3) trip = r;
    else if (n === 2) { if (!pHi) pHi = r; else pLo = r; }
    else if (!s1) s1 = r;
    else if (!s2) s2 = r;
    else s3 = r;
  }
  if (quad) return 7 * C5 + quad * C4 + s1 * C3;
  if (trip && pHi) return 6 * C5 + trip * C4 + pHi * C3;
  if (trip) return 3 * C5 + trip * C4 + s1 * C3 + s2 * C2;
  if (pLo) return 2 * C5 + pHi * C4 + pLo * C3 + s1 * C2;
  return 1 * C5 + pHi * C4 + s1 * C3 + s2 * C2 + s3 * C1;
}

/** The C(bn, 3) board index triples, flattened, for bn = 3, 4 and 5. */
const TRIPLES: Int8Array[] = [];
for (let n = 3; n <= 5; n++) {
  const t: number[] = [];
  for (let x = 0; x < n; x++) for (let y = x + 1; y < n; y++) for (let z = y + 1; z < n; z++) t.push(x, y, z);
  TRIPLES[n] = Int8Array.from(t);
}

/**
 * Best Omaha HIGH score: exactly 2 of the first `hn` codes of `hole` plus
 * exactly 3 of the first `bn` (3, 4 or 5) codes of `board`. -1 when no hand
 * can be made (fewer than 2 hole cards, or an unsupported board size).
 */
export function omahaHighScore(hole: number[], hn: number, board: number[], bn = 5): number {
  const tr = TRIPLES[bn];
  if (!tr || hn < 2) return -1;
  let best = -1;
  for (let i = 0; i < hn; i++) {
    const h1 = hole[i];
    for (let j = i + 1; j < hn; j++) {
      const h2 = hole[j];
      for (let t = 0; t < tr.length; t += 3) {
        const s = score5(h1, h2, board[tr[t]], board[tr[t + 1]], board[tr[t + 2]]);
        if (s > best) best = s;
      }
    }
  }
  return best;
}

/** No qualifying 8-or-better low. Any real low scores below it. */
export const NO_LOW = 0x7fffffff;

/** Low value: an ace is 1, every other card its rank. A low card is 8 or below. */
const lowVal = (code: number): number => {
  const r = code & 15;
  return r === 14 ? 1 : r;
};

/**
 * Best Omaha 8-or-better LOW over a 5-card board: exactly 2 of the first `hn`
 * hole codes plus exactly 3 board codes, five distinct low values (ace low,
 * straights and flushes ignored). The five values are packed highest first,
 * so LOWER is better; NO_LOW when no low qualifies. Orders lows exactly like
 * evaluateOmahaLowHand + compareLowHands.
 */
export function omahaLowScore(hole: number[], hn: number, board5: number[]): number {
  const tr = TRIPLES[5];
  let best = NO_LOW;
  for (let t = 0; t < tr.length; t += 3) {
    const b0 = lowVal(board5[tr[t]]), b1 = lowVal(board5[tr[t + 1]]), b2 = lowVal(board5[tr[t + 2]]);
    if (b0 > 8 || b1 > 8 || b2 > 8 || b0 === b1 || b0 === b2 || b1 === b2) continue;
    const bm = (1 << b0) | (1 << b1) | (1 << b2);
    for (let i = 0; i < hn; i++) {
      const x = lowVal(hole[i]);
      if (x > 8 || ((bm >> x) & 1)) continue;
      for (let j = i + 1; j < hn; j++) {
        const y = lowVal(hole[j]);
        if (y > 8 || y === x || ((bm >> y) & 1)) continue;
        const s = packDesc(bm | (1 << x) | (1 << y));
        if (s < best) best = s;
      }
    }
  }
  return best;
}

/** Can this 5-card board give ANYONE a low? (at least 3 distinct low values, ace low) */
export function boardAllowsLow(board5: number[]): boolean {
  let m = 0;
  for (let i = 0; i < 5; i++) {
    const v = lowVal(board5[i]);
    if (v <= 8) m |= 1 << v;
  }
  let n = 0;
  while (m) { m &= m - 1; n++; }
  return n >= 3;
}

/** The engine's category of a score5 value (HandRank order: the royal flush is 9). */
function categoryOf(score: number): number {
  return score === ROYAL_SCORE ? 9 : Math.floor(score / C5);
}

/**
 * B14 — the bots' Omaha outs on the flop or turn: the unseen cards that lift
 * the bot's best exactly-2-hole + 3-board hand to a straight, a flush or a
 * straight flush (royal included) above what it holds now. Unseen = the 52-card
 * deck minus the bot's OWN hole cards and the board (opponents' cards and burns
 * stay in: the bot cannot see them). No overcard term — Hold'em's +3 per hole
 * card over the board gave a 6-card hand up to +18 phantom outs. 0 unless the
 * board has 3 or 4 cards. Reads only the cards passed in; no Math.random.
 */
export function countOmahaDrawOuts(holeCards: Card[], communityCards: Card[]): number {
  const bn = communityCards ? communityCards.length : 0;
  if (bn < 3 || bn > 4 || !holeCards || holeCards.length < 2) return 0;
  const hole = holeCards.map(cardCode);
  const hn = hole.length;
  const board = communityCards.map(cardCode);
  board.push(0);
  const nowCat = categoryOf(omahaHighScore(hole, hn, board, bn));
  const seen = new Uint8Array(64);
  for (const c of hole) seen[c] = 1;
  for (let i = 0; i < bn; i++) seen[board[i]] = 1;
  let outs = 0;
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      const u = (s << 4) | r;
      if (seen[u]) continue;
      board[bn] = u;
      const cat = categoryOf(omahaHighScore(hole, hn, board, bn + 1));
      if ((cat === 4 || cat === 5 || cat === 8 || cat === 9) && cat > nowCat) outs++;
    }
  }
  return outs;
}

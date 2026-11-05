// 2026-11 (bots review B1/B2/B3/B11/B12/B15, stud-draw-lowball).
// Stud / Razz / Stud 8 / Five Card Draw / 2-7 Triple Draw / Badugi: bot hand values, discards, equity.
// Pure: reads only the cards it is handed (the bot's own + public up cards), never a table, deck or seed.
import { Card } from '../game/Card';
import { evaluateLowHand, evaluateRazzHand } from '../game/HandEvaluatorExtensions';
import { FIRST_ROUND_CDF } from './studDrawCdf';

export type StudDrawKind = 'stud-hi' | 'stud8' | 'razz' | 'draw-hi' | 'deuce7' | 'badugi';
const KINDS: StudDrawKind[] = ['stud-hi', 'stud8', 'razz', 'draw-hi', 'deuce7', 'badugi'];

/** The game a Stud / Draw table plays (by variantId, else by the table's own shape). null = not one. */
export function studDrawKindOf(variantId: string, table: any): StudDrawKind | null {
  switch (variantId) {
    case 'seven-stud': case 'seven-card-stud': return 'stud-hi';
    case 'seven-card-stud-hi-lo': return 'stud8';
    case 'razz': return 'razz';
    case 'five-card-draw': return 'draw-hi';
    case 'triple-draw': return 'deuce7';
    case 'badugi': return 'badugi';
  }
  if (table && typeof table.getStudFirstActor === 'function') return table.variant?.isRazz ? 'razz' : (table.isHiLo ? 'stud8' : 'stud-hi');
  if (table && typeof table.playerDraw === 'function') return table.holeCardCount === 4 ? 'badugi' : (table.variant?.isTripleDraw ? 'deuce7' : 'draw-hi');
  return null;
}
export const isStudKind = (k: StudDrawKind): boolean => k === 'stud-hi' || k === 'stud8' || k === 'razz';

// ─────────────── hand values: one number per hand, HIGHER = better, equal = tie ───────────────
// Each is test-pinned to the engine's own evaluator + comparator (tests/studDrawEvaluators.test.ts).
const P5 = 16 ** 5, P4 = 16 ** 4, P3 = 16 ** 3, P2 = 16 ** 2;
const enc = (cat: number, r: number[]): number => cat * P5 + (r[0] || 0) * P4 + (r[1] || 0) * P3 + (r[2] || 0) * P2 + (r[3] || 0) * 16 + (r[4] || 0);
const MAXV = 16 * P5;
const aceLow = (r: number): number => (r === 14 ? 1 : r);

function straightHigh(mask: number): number {
  let m = mask;
  if (m & (1 << 14)) m |= 1 << 1;                         // the ace plays low too (wheel)
  for (let hi = 14; hi >= 5; hi--) { const need = 0x1f << (hi - 4); if ((m & need) === need) return hi; }
  return 0;
}
function topRanks(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) if (mask & (1 << r)) out.push(r);
  return out;
}

/** High hand, 1-7 cards: for 5-7 cards the same order as HandEvaluator.evaluateHand + compareTo. */
export function hiValue(cards: Card[]): number {
  const cnt = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const sMask = [0, 0, 0, 0], sCnt = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) { cnt[c.rank]++; sMask[c.suit] |= 1 << c.rank; sCnt[c.suit]++; mask |= 1 << c.rank; }
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (sCnt[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) { const sf = straightHigh(sMask[flushSuit]); if (sf) return enc(8, [sf]); }
  const quads: number[] = [], trips: number[] = [], pairs: number[] = [], singles: number[] = [];
  for (let r = 14; r >= 2; r--) {
    const n = cnt[r];
    if (n === 4) quads.push(r); else if (n === 3) trips.push(r); else if (n === 2) pairs.push(r); else if (n === 1) singles.push(r);
  }
  if (quads.length) {
    let k = 0; for (let r = 14; r >= 2; r--) if (r !== quads[0] && cnt[r] > 0) { k = r; break; }
    return enc(7, [quads[0], k]);
  }
  if (trips.length >= 2 || (trips.length && pairs.length)) return enc(6, [trips[0], Math.max(trips[1] || 0, pairs[0] || 0)]);
  if (flushSuit >= 0) return enc(5, topRanks(sMask[flushSuit], 5));
  const st = straightHigh(mask);
  if (st) return enc(4, [st]);
  if (trips.length) return enc(3, [trips[0], ...singles.slice(0, 2)]);
  if (pairs.length >= 2) return enc(2, [pairs[0], pairs[1], Math.max(pairs[2] || 0, singles[0] || 0)]);
  if (pairs.length === 1) return enc(1, [pairs[0], ...singles.slice(0, 3)]);
  return enc(0, singles.slice(0, 5));
}

/** Razz (ace-to-five low, pairs bad): for 5-7 cards the same order as evaluateRazzHand + compareRazzHands. */
export function razzValue(cards: Card[]): number {
  const cnt = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of cards) cnt[aceLow(c.rank)]++;
  const distinct: number[] = [];
  for (let v = 1; v <= 13; v++) if (cnt[v]) distinct.push(v);
  if (cards.length < 5) return MAXV - enc(cards.length - distinct.length, distinct.slice().reverse());   // partial holding
  if (distinct.length >= 5) return MAXV - enc(0, distinct.slice(0, 5).reverse());
  if (distinct.length === 4) {
    let pair = 0; for (const v of distinct) if (cnt[v] >= 2) { pair = v; break; }
    return MAXV - enc(1, [pair, ...distinct.filter((v) => v !== pair).reverse()]);
  }
  const r = evaluateRazzHand(cards);                       // <= 3 distinct ranks (rare): the engine itself
  return MAXV - enc(r.handRank as number, [r.primaryValue, ...r.kickers]);
}

/** Stud 8 low half: 0 = no 8-or-better low, else higher = better (evaluateLowHand + compareLowHands). */
export function low8Value(cards: Card[]): number {
  const r = evaluateLowHand(cards);
  return r ? MAXV - enc(0, [r.primaryValue, ...r.kickers]) : 0;
}
/** A Stud 8 holding's low prospects (narrowing only): more distinct cards 8-or-lower, then lower. */
function lowPartial(cards: Card[]): number {
  let m = 0; for (const c of cards) { const v = aceLow(c.rank); if (v <= 8) m |= 1 << v; }
  const d: number[] = []; for (let v = 1; v <= 8 && d.length < 5; v++) if (m & (1 << v)) d.push(v);
  return d.length * P5 + (P5 - 1 - enc(0, d.reverse()));
}

/** 2-7 lowball, exactly 5 cards: the same order as evaluate27LowHand + compare27Hands. */
const CNT27 = new Int8Array(16);
export function deuce7Value(cards: Card[]): number {
  CNT27.fill(0);
  let flush = true, lo = 15, hi = 0;
  for (const c of cards) { CNT27[c.rank]++; if (c.suit !== cards[0].suit) flush = false; if (c.rank < lo) lo = c.rank; if (c.rank > hi) hi = c.rank; }
  let distinct = 0, pairCount = 0, trips = false, quads = false;
  for (let r = 2; r <= 14; r++) { const n = CNT27[r]; if (!n) continue; distinct++; if (n >= 4) quads = true; else if (n === 3) trips = true; else if (n === 2) pairCount++; }
  const straight = distinct === 5 && hi - lo === 4;        // the ace is high only
  let bad = 0;
  if (flush && straight) bad = 8; else if (quads) bad = 7; else if (trips && pairCount) bad = 6; else if (flush) bad = 5;
  else if (straight) bad = 4; else if (trips) bad = 3; else if (pairCount >= 2) bad = 2; else if (pairCount) bad = 1;
  let v = bad * P5, k = 4;                                  // groups: count desc, then rank desc
  for (let n = 4; n >= 1; n--) for (let r = 14; r >= 2; r--) if (CNT27[r] === n) { v += r * Math.pow(16, k); k--; }
  return MAXV - v;
}

/** Best badugi subset — the engine's findBestBadugi rule (most cards, then lowest highest-first). */
export function bestBadugi(cards: Card[]): { idx: number[]; key: number } {
  const n = cards.length;
  let bestKey = -1, bestMask = 0;
  for (let m = 1; m < (1 << n); m++) {
    let rs = 0, ss = 0, size = 0, ok = true;
    for (let i = 0; i < n; i++) if (m & (1 << i)) {
      const rb = 1 << aceLow(cards[i].rank), sb = 1 << cards[i].suit;
      if ((rs & rb) || (ss & sb)) { ok = false; break; }
      rs |= rb; ss |= sb; size++;
    }
    if (!ok) continue;
    let low = 0, k = 4;
    for (let v = 13; v >= 1; v--) if (rs & (1 << v)) { low += v * Math.pow(16, k); k--; }
    const key = size * P5 + (P5 - 1 - low);
    if (key > bestKey) { bestKey = key; bestMask = m; }
  }
  const idx: number[] = []; for (let i = 0; i < n; i++) if (bestMask & (1 << i)) idx.push(i);
  return { idx, key: bestKey };
}
/** Badugi: the same order as evaluateBadugiHand + compareBadugiHands. */
export function badugiValue(cards: Card[]): number { return bestBadugi(cards).key; }

// ─────────────── discards (round-aware) ───────────────
/** Draw rounds still to come INCLUDING the current one (a betting round: the draws after it). */
export function drawsLeftAt(kind: StudDrawKind, phase: string): number {
  const multi = kind === 'deuce7' || kind === 'badugi';
  switch (phase) {
    case 'PreFlop': case 'Draw1': return multi ? 3 : 1;
    case 'Bet2': return multi ? 2 : 0;
    case 'Draw2': return 2;
    case 'Bet3': case 'Draw3': return 1;
    default: return 0;
  }
}

/** Indices to KEEP at a draw. drawsLeft = this draw and the ones after it (>= 1). */
export function keepForDraw(kind: StudDrawKind, cards: Card[], drawsLeft: number): number[] {
  const all = cards.map((_, i) => i);
  if (kind === 'badugi') {
    const b = bestBadugi(cards);                                    // B15: the best subset, never a greedy one
    if (b.idx.length === 4) return all;                              // a badugi stands pat
    const keepMax = drawsLeft >= 2 ? 8 : 13;                         // B15: no drawing to a K/Q with draws to come
    return b.idx.filter((i) => aceLow(cards[i].rank) <= keepMax);
  }
  if (kind === 'deuce7') {
    const patMax = drawsLeft >= 3 ? 8 : drawsLeft === 2 ? 9 : 10;    // B15: the last draw stands pat on a 9 or 10
    const keepMax = drawsLeft >= 2 ? 8 : 9;
    let top = 0; for (const c of cards) if (c.rank > top) top = c.rank;
    if (deuce7Value(cards) > MAXV - P5 && top <= patMax) return all; // unpaired, no straight / flush, low enough
    const order = all.slice().sort((a, b) => cards[a].rank - cards[b].rank);
    const keep: number[] = []; let seen = 0;
    for (const i of order) {
      const r = cards[i].rank;
      if (r > keepMax || (seen & (1 << r))) continue;
      keep.push(i); seen |= 1 << r;
    }
    if (keep.length === 5) {                                         // a low straight / flush: break the highest
      let h = keep[0]; for (const i of keep) if (cards[i].rank > cards[h].rank) h = i;
      return keep.filter((i) => i !== h);
    }
    return keep;
  }
  // Five Card Draw (high) — B3
  const cat = Math.floor(hiValue(cards) / P5);
  if (cat >= 4) return all;                                          // straight or better stands pat
  if (cat >= 1) {                                                    // pair / two pair / trips: keep the matched cards
    const cnt = new Map<number, number>(); for (const c of cards) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
    return all.filter((i) => (cnt.get(cards[i].rank) || 0) >= 2);
  }
  for (let s = 0; s < 4; s++) { const f = all.filter((i) => cards[i].suit === s); if (f.length === 4) return f; }   // four-flush: draw one
  let mask = 0; for (const c of cards) mask |= 1 << c.rank;
  for (let lo = 10; lo >= 2; lo--) {                                 // open-ended four-straight (both ends live)
    const need = 0xf << lo;
    if (lo + 3 <= 13 && (mask & need) === need) return all.filter((i) => cards[i].rank >= lo && cards[i].rank <= lo + 3);
  }
  return all.slice().sort((a, b) => cards[b].rank - cards[a].rank).slice(0, 2);   // the two highest, draw three (as before)
}

/** The bot's discard indices for the current draw round (what index.ts hands to playerDraw). */
export function chooseBotDiscards(kind: StudDrawKind, cards: Card[], phase: string): number[] {
  const keep = new Set(keepForDraw(kind, cards, Math.max(1, drawsLeftAt(kind, phase))));
  return cards.map((_, i) => i).filter((i) => !keep.has(i));
}

// ─────────────── Monte Carlo pot share — public information only ───────────────
export interface StudDrawSpot {
  kind: StudDrawKind;
  /** The bot's own cards. */
  mine: Card[];
  /** Visible cards that are neither mine nor an active opponent's (folded seats' up cards). */
  dead: Card[];
  /** A Stud shared 7th-street card (the deck ran short): counted in every hand. */
  shared: Card[];
  /** Active opponents: their face-up cards (Stud), how many cards each holds now, and the
   *  range floor his own action this round earned (cut that fraction of his holdings from the bottom). */
  opps: { known: Card[]; total: number; floor: number }[];
  /** Draw games: draw rounds still to come. */
  drawsLeft: number;
}

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const code = (c: Card): number => c.rank * 4 + c.suit;
/** Seed from the public spot only: the same spot always gets the same answer (no per-boot randomness). */
function seedOf(s: StudDrawSpot): number {
  let h = 2166136261;
  const mix = (x: number) => { h ^= x; h = Math.imul(h, 16777619); };
  mix(KINDS.indexOf(s.kind));
  for (const arr of [s.mine, s.dead, s.shared]) { for (const x of arr.map(code).sort((a, b) => a - b)) mix(x); mix(255); }
  for (const o of s.opps) { for (const x of o.known.map(code).sort((a, b) => a - b)) mix(x); mix(o.total); mix(Math.round(o.floor * 100)); mix(254); }
  mix(s.drawsLeft);
  return h >>> 0;
}

/**
 * A STARTING holding's standing, for range narrowing (higher = stronger): Stud = his two down cards
 * + door card (Third Street), a draw game = the hand he was dealt. Narrowing on the start, as Hold'em
 * narrows on the pre-flop percentile, keeps the busted draws / bluffs a bettor really has in his range.
 */
function startScore(kind: StudDrawKind, start: Card[]): number {
  switch (kind) {
    case 'stud-hi': case 'stud8': case 'draw-hi': return hiValue(start);
    case 'razz': return razzValue(start);
    case 'badugi': return badugiValue(start);
    case 'deuce7': {
      const keep = keepForDraw('deuce7', start, 3).map((i) => start[i].rank).sort((x, y) => y - x);
      return keep.length * P5 + (P5 - 1 - enc(0, keep));
    }
  }
}

export const STUD_DRAW_MAX_SIMS = 400;
export const STUD_DRAW_MIN_SIMS = 64;
const WARMUP = 96;
const MAX_TRIES = 25;

/**
 * The bot's pot share (0..1) vs the active opponents, by Monte Carlo over the cards it cannot see.
 * Deterministic for a given public spot; stops after STUD_DRAW_MIN_SIMS once `budgetMs` is spent.
 */
export function studDrawEquity(s: StudDrawSpot, maxSims = STUD_DRAW_MAX_SIMS, budgetMs = 40, stats?: { sims: number }): number {
  const nOpp = s.opps.length;
  if (nOpp === 0) return 1;
  const rnd = mulberry32(seedOf(s));
  const used = new Set<number>([...s.mine, ...s.dead, ...s.shared, ...s.opps.flatMap((o) => o.known)].map(code));
  const deck: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) if (!used.has(rank * 4 + suit)) deck.push({ rank, suit } as Card);
  const stud = isStudKind(s.kind);
  const target = 7 - s.shared.length;
  const handSize = s.kind === 'badugi' ? 4 : 5;

  let pos = 0;                                             // the deck is dealt from the front
  const take = (want: number): Card[] => {
    const k = Math.max(0, Math.min(want, deck.length - pos));   // never past the end of the deck
    for (let q = 0; q < k; q++) { const at = pos + q; const j = at + Math.floor(rnd() * (deck.length - at)); const t = deck[at]; deck[at] = deck[j]; deck[j] = t; }
    const out = deck.slice(pos, pos + k); pos += k; return out;
  };
  // An opponent's unseen cards: Stud — his down cards (the first two are his Third Street
  // downs); a draw game — the hand he was dealt, then the draws already made by the bots' own
  // keep rule (how many he drew is not public).
  const totalDraws = s.kind === 'draw-hi' ? 1 : 3;
  const drawsDone = stud ? 0 : Math.max(0, totalDraws - s.drawsLeft);
  const dealStart = (o: { known: Card[]; total: number }): { unk: Card[]; start: Card[] } => {
    const unk = take((stud ? o.total : handSize) - o.known.length);
    return { unk, start: stud ? (o.known.length ? [unk[0], unk[1], o.known[0]] : unk) : unk };
  };
  const finish = (o: { known: Card[] }, unk: Card[]): Card[] => {
    if (stud) return [...o.known, ...unk];
    let h = unk;
    for (let i = 0; i < drawsDone; i++) {
      const keep = keepForDraw(s.kind, h, totalDraws - i);
      const drop = h.length - keep.length;
      if (drop > 0 && deck.length - pos >= drop) h = keep.map((x) => h[x]).concat(take(drop));
    }
    return h;
  };

  // Range narrowing on the STARTING holding: a warm-up sample sets the score it must reach.
  const scorer: (((h: Card[]) => number) | null)[] = s.opps.map(() => null);
  const thr: number[] = s.opps.map(() => -Infinity);
  s.opps.forEach((o, i) => {
    if (!(o.floor > 0)) return;
    const warm: Card[][] = [];
    for (let w = 0; w < WARMUP; w++) { pos = 0; warm.push(dealStart(o).start); }
    let f: (h: Card[]) => number;
    if (s.kind === 'stud8') {                              // either half: the better of its high and low standing
      const his = warm.map(hiValue).sort((x, y) => x - y), los = warm.map(lowPartial).sort((x, y) => x - y);
      const q = (arr: number[], v: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo / arr.length; };
      f = (h) => Math.max(q(his, hiValue(h)), q(los, lowPartial(h)));
    } else f = (h) => startScore(s.kind, h);
    const sc = warm.map(f).sort((x, y) => x - y);
    scorer[i] = f; thr[i] = sc[Math.min(WARMUP - 1, Math.floor(o.floor * WARMUP))];
  });

  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  let total = 0, n = 0;
  const hands: Card[][] = new Array(nOpp + 1);
  for (let sim = 0; sim < maxSims; sim++) {
    if (sim >= STUD_DRAW_MIN_SIMS && (sim & 15) === 0 && Date.now() > deadline) break;
    pos = 0;
    let ok = true;
    for (let i = 0; i < nOpp; i++) {
      const o = s.opps[i];
      let d = dealStart(o);
      // Fix round 2 (VA-2): a start still outside his range after MAX_TRIES deals drops the
      // whole simulation. It used to be scored as dealt: a random hand in a tight range
      // (~7% of them at floor 0.90) put the bot's pot share 1-3 points too high.
      for (let tr = 1; scorer[i] && scorer[i]!(d.start) < thr[i]; tr++) {
        if (tr >= MAX_TRIES) { ok = false; break; }
        pos -= d.unk.length;                               // rejected: re-deal the same slots
        d = dealStart(o);
      }
      if (!ok || pos > deck.length) { ok = false; break; }
      hands[i + 1] = finish(o, d.unk);
    }
    if (!ok) continue;
    hands[0] = s.mine.slice();
    if (stud) {                                            // the streets still to come
      for (let p = 0; p <= nOpp; p++) {
        const more = Math.min(target - hands[p].length, deck.length - pos);
        if (more > 0) hands[p] = hands[p].concat(take(more));
      }
    } else {                                               // the draws still to come, by the same keep rule
      for (let d = s.drawsLeft; d >= 1; d--) {
        for (let p = 0; p <= nOpp; p++) {
          const keep = keepForDraw(s.kind, hands[p], d);
          const drop = hands[p].length - keep.length;
          if (drop === 0 || deck.length - pos < drop) continue;
          hands[p] = keep.map((x) => hands[p][x]).concat(take(drop));
        }
      }
    }
    if (s.kind === 'stud8') {                              // high half + qualifying low half (scoop if no low)
      let bestHi = -1, nHi = 0, myHi = 0, bestLo = 0, nLo = 0, myLo = 0;
      for (let p = 0; p <= nOpp; p++) {
        const c = s.shared.length ? hands[p].concat(s.shared) : hands[p];
        const hv = hiValue(c), lv = low8Value(c);
        if (p === 0) { myHi = hv; myLo = lv; }
        if (hv > bestHi) { bestHi = hv; nHi = 1; } else if (hv === bestHi) nHi++;
        if (lv > bestLo) { bestLo = lv; nLo = 1; } else if (lv === bestLo && lv > 0) nLo++;
      }
      const hiShare = myHi === bestHi ? 1 / nHi : 0;
      total += bestLo > 0 ? 0.5 * hiShare + 0.5 * (myLo === bestLo ? 1 / nLo : 0) : hiShare;
    } else {
      let best = -1, nb = 0, mineV = 0;
      for (let p = 0; p <= nOpp; p++) {
        const c = s.shared.length ? hands[p].concat(s.shared) : hands[p];
        const v = s.kind === 'razz' ? razzValue(c) : s.kind === 'deuce7' ? deuce7Value(c) : s.kind === 'badugi' ? badugiValue(c) : hiValue(c);
        if (p === 0) mineV = v;
        if (v > best) { best = v; nb = 1; } else if (v === best) nb++;
      }
      total += mineV === best ? 1 / nb : 0;
    }
    n++;
  }
  if (stats) stats.sims = n;
  return n > 0 ? total / n : 0.5;
}

// ─────────────── first-round percentile ───────────────
/** Simulations for the first-round heads-up equity (cheap Stud evaluators get more). */
export const FIRST_ROUND_SIMS: Record<StudDrawKind, number> = { 'stud-hi': 1000, stud8: 1000, razz: 1000, 'draw-hi': 600, deuce7: 400, badugi: 400 };

/** Heads-up pot share vs ONE random holding — the Hold'em percentile's definition — every visible card dead. */
export function firstRoundEquity(kind: StudDrawKind, mine: Card[], dead: Card[], drawsLeft: number, budgetMs = 40, stats?: { sims: number }): number {
  const total = isStudKind(kind) ? mine.length : kind === 'badugi' ? 4 : 5;
  return studDrawEquity({ kind, mine, dead, shared: [], opps: [{ known: [], total, floor: 0 }], drawsLeft }, FIRST_ROUND_SIMS[kind], budgetMs, stats);
}

/** Baked heads-up-equity quantiles q[0..100] per game: src/ai/studDrawCdf.ts, written by bake-stud-draw-cdf.ts. */
export { FIRST_ROUND_CDF };

/** Percentile (0..1) of a first-round heads-up equity among that game's random starting hands. */
export function equityToPercentile(kind: StudDrawKind, eq: number): number {
  const q = FIRST_ROUND_CDF[kind];
  if (!q || q.length < 2) return eq;
  if (eq <= q[0]) return 0;
  if (eq >= q[q.length - 1]) return 1;
  let lo = 0, hi = q.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= eq) lo = mid; else hi = mid; }
  const span = q[hi] - q[lo];
  return (lo + (span > 0 ? (eq - q[lo]) / span : 0.5)) / (q.length - 1);
}

/**
 * tests/fix8HoldemFixup6.test.ts (2026-11-10, bots review fix round 4, fix-up 6: the Hold'em lane).
 *
 * 1. HOLDEM-F5-MEASUREMENT-1 = HOLDEM-F5-EXPLOIT-1 / HOLDEM-F5-EXPLOIT-2: facing a raise from a player who is neither all-in
 *    nor committed, the push/fold zone is read on 0dc1b96's chips-left depth again (preFlopStrategy zoneBB). Heads-up 20 BB, a
 *    4-6 BB open leaves 14-16 BB: 0dc1b96 jammed or folded there; 94108d5 read the hand-start 20 BB, flat-called (ROCK / TAG /
 *    LAG / FISH) or folded (NIT, ~92%) and then folded the flop. Opening any two to 20-30% of the stack won +98 to +151 BB/100
 *    against a ROCK (live -78 to -161), +33 to +41 against a NIT. At five 100 BB NITs a 12 BB human's 2 BB steal won +21 to
 *    +39 (live -41 to +1): the big blind is 10 BB deep on the chips left, inside the 3-player zone.
 * 2. HOLDEM-F5-REGRESSION-1: short-handed (three dealt or fewer) a first-in ROCK limps its premiums, as 0dc1b96 did
 *    (ROCK_LIMP_TRAP_MAX_PLAYERS). B5's raise left its limp range capped: an iso-raise over the limp, then any flop all-in,
 *    beat live by +16 to +39 BB/100 (Heads-Up Snap, Spin & Go). Six-max keeps B5 (botPreflopFixes: the ROCK raises AA).
 * 3. The fix-up 6 sweep (short-stack steals): at a hand-start effective stack of 25 BB or less a bigger open narrows no call /
 *    3-bet range (B4), as 0dc1b96 (the big blind still widens against a small one). Narrowed, a 25 BB big blind continued
 *    against a 4-6 BB open only 49-78% as often as against 3 BB, and an any-two 4-6 BB steal won +8 to +42 BB/100 in Spin & Go
 *    against NIT / ROCK lineups (live -40 to +15).
 *
 * Whole lines are played on a real PokerTable through AI.decideAction, applied as index.ts executeAIAction applies them,
 * scored as fix7HoldemFixup5.test.ts scores them (the human's all-in at its equity from the board of his all-in when nobody
 * acts after that street, else by chips). Deterministic: seeded Math.random, seeded deck, frozen Date.now.
 *   osn:F:R    first in (or over limpers), raise to F x the stack with any two; re-raised: continue with the top 6% (stack-off
 *              percentile >= 0.94), else fold; after the flop R = a: move in at the first action; R = p: only with a pair (a
 *              hole card used), a flush draw or an open-ended straight draw; R = x: never (check / fold).
 *   opn:F:R    raise to F x the stack with any two when first in or over ONE (not all-in) raise; call any re-raise; after the
 *              flop as osn.
 *   pf:F:R     as osn, but fold to any re-raise.
 *   mrn:0:R    first in (or over limpers), a minimum raise with any two; call any re-raise; after the flop as osn.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PokerTable, PlayerAction, GamePhase } = require('../src/game/PokerTable');
const AI = require('../src/ai/AIPlayer');
const HE = require('../src/game/HandEvaluator');
const PR = require('../src/ai/preflopRanges');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix8-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100;
const prof = (a: string, i: number, diff = 'hard') => ({ botName: 'B' + i, difficulty: diff, personality: 'x', archetype: a, vpip: 0.5, pfr: 0.3, aggressionFactor: 2, bluffFrequency: 0.2 });
const kindOf = (d: any): string => (d.action === PlayerAction.Fold ? 'fold' : d.action === PlayerAction.Check ? 'check'
  : d.action === PlayerAction.Call ? 'call' : d.action === PlayerAction.Raise ? 'raise' : 'allin');

/** Apply a bot decision as index.ts executeAIAction does. */
function apply(t: any, a: number, d: any): void {
  const ok = d.action === PlayerAction.Fold ? t.playerFold(a)
    : d.action === PlayerAction.Check ? (t.playerCheck(a) || t.playerFold(a))
      : d.action === PlayerAction.Call ? (t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
        : d.action === PlayerAction.Raise ? (t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
          : (t.playerAllIn(a) || t.playerFold(a));
  if (!ok) t.playerFold(a);
}

/** A pair with a hole card, a flush draw or made flush, an open-ended straight draw or a made straight. */
function pairOrDraw(h: any[], b: any[]): boolean {
  if (h[0].rank === h[1].rank) return true;
  for (const x of h) for (const c of b) if (x.rank === c.rank) return true;
  for (let su = 0; su < 4; su++) if ([...h, ...b].filter((c: any) => c.suit === su).length >= 4 && h.some((c: any) => c.suit === su)) return true;
  const all = new Set<number>([...h, ...b].map((c: any) => c.rank)); if (all.has(14)) all.add(1);
  const hr = new Set<number>(h.map((c: any) => c.rank)); if (hr.has(14)) hr.add(1);
  for (let lo = 1; lo <= 10; lo++) {
    let k = 0, useH = false; for (let r = lo; r <= lo + 4; r++) { if (all.has(r)) k++; if (hr.has(r)) useH = true; }
    if (k === 5 && useH) return true;
  }
  for (let lo = 2; lo <= 10; lo++) {
    let k = 0, useH = false; for (let r = lo; r <= lo + 3; r++) { if (all.has(r)) k++; if (hr.has(r)) useH = true; }
    if (k === 4 && useH && lo - 1 >= 2 && lo + 4 <= 14) return true;
  }
  return false;
}

/** BB/100 of the human (seat 0, heroBB) over `hands` hands of `line` against `lineup` (bots at `botBB`). */
function play(line: string, lineup: string[], botBB: number, hands: number, seed: number, heroBB: number, diff = 'hard'): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const [kind, f, rule] = line.split(':');
    const F = Number(f);
    const ns = lineup.length + 1;
    const start = [heroBB * BB, ...lineup.map(() => botBB * BB)];
    const TOTAL = start.reduce((a, x) => a + x, 0);
    const t = new PokerTable({ tableId: 'fx8', tableName: 'fx8', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
    for (let i = 0; i < ns; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', start[i], (i ? 'ai-fx8-' : 'player-fx8-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => prof(a, i + 1, diff))];
    let raised = false, sidePlay = false, evBoard = -1, ev: number | null = null;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      const shove = () => (t.playerAllIn(0) || t.playerCall(0) || fold());
      if (t.currentPhase !== GamePhase.PreFlop) {
        if (s0.chipCount > 0 && (rule === 'a' || (rule === 'p' && pairOrDraw(s0.holeCards, t.communityCards)))) { shove(); return; }
        fold(); return;
      }
      const raises = Number(t.raisesThisStreet) || 0;
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      const to = kind === 'mrn' ? t.getMinRaise() : Math.floor(F * (s0.chipCount + s0.currentBet) / 50) * 50;
      if (raised && ca > 0) {
        if (kind === 'pf') { fold(); return; }
        if (kind === 'opn' || kind === 'mrn' || PR.getStackOffPercentile(s0.holeCards) >= 0.94) { t.playerCall(0) || t.playerAllIn(0) || fold(); return; }
        fold(); return;
      }
      if (raises === 0 || (kind === 'opn' && raises === 1 && !facingAllIn)) {
        raised = true;
        if (to >= s0.chipCount + s0.currentBet) { t.playerAllIn(0); return; }
        if (!t.playerRaise(0, Math.max(to, t.getMinRaise()))) { raised = false; fold(); }
        return;
      }
      fold();
    };
    const dw = t.determineWinners.bind(t);
    t.determineWinners = (...args: any[]) => {
      const h0 = t.seats[0];
      if (h0.allIn && !h0.folded && t.communityCards.length === 5 && ev === null && evBoard >= 0 && !sidePlay) {
        const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length === 2);
        const used = new Set<number>(); for (const x of live) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
        for (const c of t.communityCards.slice(0, evBoard)) used.add(c.rank * 4 + c.suit);
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!used.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let share = 0; const SIMS = 300;
        for (let i = 0; i < SIMS; i++) {
          for (let j = 0; j < 5 - evBoard; j++) { const k = j + Math.floor(mrnd() * (deck.length - j)); const z = deck[j]; deck[j] = deck[k]; deck[k] = z; }
          const board = [...t.communityCards.slice(0, evBoard), ...deck.slice(0, 5 - evBoard)];
          const e2 = live.map((x: any) => HE.evaluateHand([...x.holeCards, ...board]));
          let best = [0];
          for (let k = 1; k < e2.length; k++) { const c = HE.compareTo(e2[k], e2[best[0]]); if (c > 0) best = [k]; else if (c === 0) best.push(k); }
          if (best.includes(live.findIndex((x: any) => x.seatIndex === 0))) share += 1 / best.length;
        }
        const inv = h0.totalInvestedThisHand;
        const pot = t.seats.reduce((q: number, x: any) => q + Math.min(x.totalInvestedThisHand || 0, inv), 0);
        ev = (share / SIMS) * pot - inv;
      }
      return dw(...args);
    };
    let total = 0, drift = 0, n = 0;
    for (let h = 0; h < hands; h++) {
      for (let i = 0; i < ns; i++) { const x = t.seats[i]; x.chipCount = start[i]; x.eliminated = false; x.sittingOut = false; }
      raised = false; sidePlay = false; ev = null; evBoard = -1;
      expect(t.startNewHand()).toBe(true);
      let g = 0;
      while (t.isHandInProgress() && g++ < 300) {
        const a = t.activeSeatIndex; if (a < 0) break;
        const board = t.communityCards.length;
        if (a === 0) { hero(); if (t.seats[0].allIn && evBoard < 0) evBoard = board; continue; }
        if (t.seats[0].folded) { if (!t.playerFold(a)) t.playerCheck(a); continue; }   // the human's result is final
        if (evBoard >= 0 && board > evBoard) sidePlay = true;   // a decision after his all-in street: scored by chips
        apply(t, a, AI.decideAction(t, a, profs[a]));
        if (t.seats[0].allIn && evBoard < 0) evBoard = board;
      }
      expect(t.isHandInProgress()).toBe(false);
      if (t.seats.reduce((q: number, x: any) => q + (x.state === 'occupied' ? x.chipCount : 0), 0) !== TOTAL) drift++;
      total += (ev ?? (t.seats[0].chipCount - start[0])) / BB; n++;
    }
    return { bb100: (100 * total) / n, drift, hands: n };
  } finally { restore(); }
}

/** Decisions of the bot at seat `me` over `n` deals of `build` (the table is rebuilt each deal: fresh cards). */
function decisions(build: () => any, me: number, arch: string, n: number, seed: number, diff = 'hard'): Record<string, number> {
  const restore = detEnv(seed);
  const out: Record<string, number> = { fold: 0, check: 0, call: 0, raise: 0, allin: 0 };
  try {
    for (let k = 0; k < n; k++) {
      const t = build();
      expect(t.activeSeatIndex).toBe(me);
      out[kindOf(AI.decideAction(t, me, prof(arch, me, diff)))]++;
    }
  } finally { restore(); }
  return out;
}
/** Heads-up at 50/100, `bb` BB each: seat 0 the human, seat 1 the bot; `btn` the button (= the small blind, first to act). */
function hu(bb: number, btn: number, tag: string): any {
  const t = new PokerTable({ tableId: tag, tableName: tag, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
  expect(t.sitDown(0, 'Hero', bb * BB, 'player-' + tag, false)).toBe(true);
  expect(t.sitDown(1, 'B1', bb * BB, 'ai-' + tag, true)).toBe(true);
  t.presetFirstButton(btn);
  expect(t.startNewHand()).toBe(true);
  return t;
}

describe('HOLDEM-F5-MEASUREMENT-1 = EXPLOIT-1 / EXPLOIT-2 — facing an uncommitted raise, the push/fold zone is on the chips-left depth (node level)', () => {
  it.each(['ROCK', 'NIT', 'TAG', 'LAG', 'FISH'])('heads-up 20 BB, a %s in the big blind facing a 4 / 5 / 6 BB open (14-16 BB left) never flat-calls it: it moves in (>= 30%%) or folds (94108d5: ROCK / TAG / LAG / FISH flat-called it, a NIT folded ~92%%)', (arch) => {
    const tot: Record<string, number> = { fold: 0, check: 0, call: 0, raise: 0, allin: 0 };
    for (const open of [4, 5, 6]) {
      const r = decisions(() => {
        const t = hu(20, 0, 'z' + arch + open);
        expect(t.activeSeatIndex).toBe(0);
        expect(t.playerRaise(0, open * BB)).toBe(true);
        expect(AI.nearAllInRaiser(t, t.seats[1])).toBeNull();   // not committed: more than the pot behind
        return t;
      }, 1, arch, 150, 8100 + open);
      for (const k of Object.keys(tot)) tot[k] += r[k];
    }
    expect([arch, tot.call, tot.raise, tot.check]).toEqual([arch, 0, 0, 0]);
    expect(tot.allin / 450).toBeGreaterThanOrEqual(0.3);
  });
  it('heads-up 20 BB, a 3 BB open (17 BB left: outside the zone) is still played on the normal ranges: a ROCK / TAG flat-calls some of it', () => {
    for (const arch of ['ROCK', 'TAG']) {
      const r = decisions(() => { const t = hu(20, 0, 'y' + arch); expect(t.playerRaise(0, 3 * BB)).toBe(true); return t; }, 1, arch, 200, 8110);
      expect([arch, r.call > 0]).toEqual([arch, true]);
    }
  });
  it('five 100 BB NITs, a 12 BB human\'s 2 BB open from UTG folded round to the big blind (10 BB left, three-player zone): the NIT moves in >= 15% and never flat-calls (94108d5 ~8%)', () => {
    const r = decisions(() => {
      const t = new PokerTable({ tableId: 'n12', tableName: 'n12', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, (i === 1 ? 12 : 100) * BB, (i === 1 ? 'player-n12-' : 'ai-n12-') + i, i !== 1)).toBe(true);
      t.presetFirstButton(4);
      expect(t.startNewHand()).toBe(true);   // button 4, small blind 5, big blind 0, UTG 1 (the human)
      expect(t.playerRaise(1, 2 * BB)).toBe(true);
      for (const s of [2, 3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      return t;
    }, 0, 'NIT', 400, 8120);
    expect([r.call, r.raise]).toEqual([0, 0]);
    expect(r.allin / 400).toBeGreaterThanOrEqual(0.15);
  });
  it('an all-in or a committed raise keeps the hand-start depth (NEW-1): heads-up 20 BB, a TAG facing a 50% open continues on the 20 BB stack-off range (<= 35%), not the 10 BB push range', () => {
    const r = decisions(() => {
      const t = hu(20, 0, 'c50');
      expect(t.playerRaise(0, 10 * BB)).toBe(true);
      expect(AI.nearAllInRaiser(t, t.seats[1])?.seatIndex).toBe(0);
      return t;
    }, 1, 'TAG', 300, 8130);
    expect(r.call).toBe(0);
    expect((r.allin + r.raise) / 300).toBeLessThanOrEqual(0.35);
  });
});

/** Share (%) of the 1,326 starting hands with which the big blind (`arch`) does not fold to the human's `openBB` button open. */
function bbContPct(arch: string, ns: number, depthBB: number, openBB: number, diff = 'hard'): number {
  const t = new PokerTable({ tableId: 'sz', tableName: 'sz', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
  for (let i = 0; i < ns; i++) expect(t.sitDown(i, 'P' + i, depthBB * BB, (i === 0 ? 'player-sz-' : 'ai-sz-') + i, i !== 0)).toBe(true);
  t.presetFirstButton(0);
  expect(t.startNewHand()).toBe(true);   // button 0 (the human), small blind 1, big blind 2 (6-max: UTG 3 .. CO 5 fold first)
  for (let s = 3; s < ns; s++) expect(t.playerFold(s)).toBe(true);
  expect(t.playerRaise(0, openBB * BB)).toBe(true);
  expect(t.playerFold(1)).toBe(true);
  expect(t.activeSeatIndex).toBe(2);
  let n = 0, c = 0;
  const restore = detEnv(8300);
  try {
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) {
      t.seats[2].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }];
      n++;
      if (AI.decideAction(t, 2, prof(arch, 2, diff)).action !== PlayerAction.Fold) c++;
    }
  } finally { restore(); }
  return (100 * c) / n;
}
describe('fix-up 6 sweep (Spin & Go steals) — at 25 BB and shallower a bigger open narrows nothing (node level)', () => {
  it.each(['ROCK', 'NIT', 'TAG', 'LAG'])('Spin & Go 25 BB, a %s in the big blind continues against a 4 / 5 / 6 BB open at least 90%% as often as against 3 BB (94108d5: 49-78%%)', (arch) => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) {
      const ref = bbContPct(arch, 3, 25, 3, diff);
      for (const o of [4, 5, 6]) { const v = bbContPct(arch, 3, 25, o, diff); if (v < 0.9 * ref) bad.push(`${diff} ${o} BB: ${v.toFixed(1)}% vs ${ref.toFixed(1)}% at 3 BB`); }
    }
    expect(bad).toEqual([]);
  });
  it('B4 is unchanged deeper: at 100 BB a TAG in the big blind still narrows against a 6 BB open (< 75% of its 3 BB rate)', () => {
    expect(bbContPct('TAG', 6, 100, 6)).toBeLessThan(0.75 * bbContPct('TAG', 6, 100, 3));
  });
});

describe('HOLDEM-F5-REGRESSION-1 — short-handed, a first-in ROCK limps its premiums (ROCK_LIMP_TRAP_MAX_PLAYERS)', () => {
  it('heads-up (20 and 100 BB) and 3-handed, a ROCK first in limps AA / KK (94108d5 raised them: its limp range was capped)', () => {
    const bad: string[] = [];
    for (const code of ['AA', 'KK']) for (const bb of [20, 100]) {
      const restore = detEnv(8200 + bb);
      try {
        const t = hu(bb, 1, 'r' + code + bb);   // the bot is the button / small blind: first in
        expect(t.activeSeatIndex).toBe(1);
        t.seats[1].holeCards = code === 'AA' ? [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }] : [{ rank: 13, suit: 0 }, { rank: 13, suit: 1 }];
        const d = AI.decideAction(t, 1, prof('ROCK', 1));
        if (d.action !== PlayerAction.Call) bad.push(`HU ${bb} BB ${code}: ${d.action}`);
      } finally { restore(); }
    }
    const restore = detEnv(8210);
    try {
      const t = new PokerTable({ tableId: 'r3', tableName: 'r3', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
      for (let i = 0; i < 3; i++) expect(t.sitDown(i, 'P' + i, 25 * BB, (i === 0 ? 'player-r3-' : 'ai-r3-') + i, i !== 0)).toBe(true);
      t.presetFirstButton(1);
      expect(t.startNewHand()).toBe(true);   // 3-handed: the button (seat 1) acts first pre-flop
      expect(t.activeSeatIndex).toBe(1);
      t.seats[1].holeCards = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }];
      const d = AI.decideAction(t, 1, prof('ROCK', 1));
      if (d.action !== PlayerAction.Call) bad.push(`3-handed 25 BB AA: ${d.action}`);
    } finally { restore(); }
    expect(bad).toEqual([]);
  });
  it('heads-up, a ROCK with AA limps, then continues against an iso-raise (the value its capped limp range was missing)', () => {
    const restore = detEnv(8220);
    try {
      const t = hu(20, 1, 'rl');
      t.seats[1].holeCards = [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }];
      apply(t, 1, AI.decideAction(t, 1, prof('ROCK', 1)));
      expect(t.seats[1].currentBet).toBe(BB);   // limped
      expect(t.playerRaise(0, 3 * BB)).toBe(true);
      expect(kindOf(AI.decideAction(t, 1, prof('ROCK', 1)))).not.toBe('fold');
    } finally { restore(); }
  });
});

describe('HOLDEM-F5 whole lines — uncommitted opens and steals against short-handed ROCK / NIT bots lose (real engine)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix8 whole lines (BB/100): ${rows.join('; ')}\n`));
  const NITS = ['NIT', 'NIT', 'NIT', 'NIT', 'NIT'];
  const CASES: Array<[string, string, string[], number, number, number, number, string]> = [
    ['osn:0.3:a', 'heads-up, a 20 BB ROCK (hard)', ['ROCK'], 20, 1500, 81, 20, 'hard'],
    ['opn:0.25:p', 'heads-up, a 20 BB ROCK (medium)', ['ROCK'], 20, 1500, 82, 20, 'medium'],
    ['opn:0.25:p', 'heads-up, a 20 BB NIT (hard)', ['NIT'], 20, 1500, 83, 20, 'hard'],
    ['osn:0.25:x', 'heads-up, a 20 BB NIT (hard): a 5 BB steal, fold to a re-raise, check / fold after the flop', ['NIT'], 20, 1500, 84, 20, 'hard'],
    ['osn:0.17:x', 'five 100 BB NITs, the human 12 BB: a 2 BB steal, check / fold after the flop', NITS, 100, 1500, 85, 12, 'hard'],
    ['osn:0.2:x', 'Spin & Go 25 BB, a NIT and a FISH (hard): a 5 BB steal, check / fold after the flop', ['NIT', 'FISH'], 25, 1500, 86, 25, 'hard'],
    ['osn:0.2:x', 'Spin & Go 25 BB, two ROCKs (hard): a 5 BB steal, check / fold after the flop', ['ROCK', 'ROCK'], 25, 1500, 87, 25, 'hard'],
  ];
  it.each(CASES)('%s loses against %s', (line, name, lineup, botBB, hands, seed, heroBB, diff) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, botBB, hands, seed, heroBB, diff);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < 0]).toEqual([line, hands, 0, true]);
  }, 1_200_000);
});

describe('HOLDEM-F5-REGRESSION-1 whole lines — iso-raise the ROCK\'s limp, fold to a re-raise, any flop all-in: no better than live (real engine)', () => {
  // These 3 BB any-two raises are profitable on live 0dc1b96 too (its own leak): the bound is live's level on the same seeds
  // (heads-up seed 89: live +51.6, 94108d5 +64.5; Spin & Go seed 87: live +20.0, 94108d5 +37.4; 3,000 hands each).
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix8 ROCK limp-trap lines (BB/100): ${rows.join('; ')}\n`));
  const CASES: Array<[string, string, string[], number, number, number, number, number]> = [
    ['pf:0.15:a', 'heads-up, a 20 BB ROCK (hard)', ['ROCK'], 20, 3000, 89, 20, 56],
    ['pf:0.12:a', 'Spin & Go 25 BB, two ROCKs (hard)', ['ROCK', 'ROCK'], 25, 3000, 87, 25, 25],
  ];
  it.each(CASES)('%s against %s', (line, name, lineup, botBB, hands, seed, heroBB, bound) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, botBB, hands, seed, heroBB);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (bound ${bound}; ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 <= bound]).toEqual([line, hands, 0, true]);
  }, 1_200_000);
});

describe('re-review 5 P3 — the Short Deck MANIAC reads 0dc1b96\'s Hold\'em percentile (ctx.maniacPctile) facing a raise or an all-in', () => {
  // 2026-11-12 (Short Deck reset): the lane's Short Deck code is dormant behind SHORT_DECK_BOTS_PLAY_LIVE; this pin runs it
  // through the Jest-only hook (tests/sdLiveGolden pins the shipped, live behaviour).
  beforeAll(() => AI.setShortDeckLaneForTests(true));
  afterAll(() => AI.setShortDeckLaneForTests(false));
  it('Short Deck 100 BB: a MANIAC that isolated a limper continues >= 85% against his shove (96.0%; on the Short Deck percentile 65.5%; 0dc1b96 92.8%)', () => {
    const { ShortDeckTable } = require('../src/game/variants/ShortDeckTable');
    let n = 0, k = 0;
    const restore = detEnv(8400);
    try {
      for (let d = 0; d < 400; d++) {
        const t = new ShortDeckTable({ tableId: 'sdm' + d, tableName: 'sdm', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
        for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 100 * BB, (i === 0 ? 'player-sdm-' : 'ai-sdm-') + i, i !== 0)).toBe(true);
        t.presetFirstButton(0);
        expect(t.startNewHand()).toBe(true);   // button 0 (the human), small blind 1, big blind 2, UTG 3
        for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
        expect(t.playerCall(0)).toBe(true);   // the human limps
        expect(t.playerRaise(1, 4 * BB)).toBe(true);   // the small-blind MANIAC isolates
        expect(t.playerFold(2)).toBe(true);
        expect(t.playerAllIn(0)).toBe(true);
        expect(t.activeSeatIndex).toBe(1);
        n++; if (AI.decideAction(t, 1, prof('MANIAC', 1)).action !== PlayerAction.Fold) k++;
      }
    } finally { restore(); }
    process.stdout.write(`fix8 Short Deck MANIAC continue: ${(100 * k / n).toFixed(1)}%\n`);
    expect(k / n).toBeGreaterThanOrEqual(0.85);
  });
});

describe('fix-up 6 sweep (FISH re-raise) — at 25 BB or less the FISH\'s raise over a raise is the jam, as 0dc1b96 (node level)', () => {
  it('heads-up 20 BB, a FISH in the big blind facing a 2 / 3 BB open moves in with its top hands (94108d5: a 3x re-raise); at 100 BB it still re-raises 3x (B5)', () => {
    const bad: string[] = [];
    const H: Record<string, any[]> = {
      AA: [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], KK: [{ rank: 13, suit: 0 }, { rank: 13, suit: 1 }],
      QQ: [{ rank: 12, suit: 0 }, { rank: 12, suit: 1 }], AKs: [{ rank: 14, suit: 2 }, { rank: 13, suit: 2 }],
    };
    for (const code of Object.keys(H)) for (const open of [2, 3]) for (const bb of [20, 100]) {
      const restore = detEnv(8500 + open + bb);
      try {
        const t = hu(bb, 0, 'fj' + code + open + bb);
        expect(t.playerRaise(0, open * BB)).toBe(true);
        t.seats[1].holeCards = H[code];
        const d = kindOf(AI.decideAction(t, 1, prof('FISH', 1)));
        if (d !== (bb === 20 ? 'allin' : 'raise')) bad.push(`${bb} BB ${code} vs ${open} BB: ${d}`);
      } finally { restore(); }
    }
    expect(bad).toEqual([]);
  });
});

describe('fix-up 6 sweep (FISH re-raise) whole line — min-raise any two, call any re-raise, pair-or-draw flop all-in: no better than live (real engine)', () => {
  // Profitable on live 0dc1b96 too (a FISH calls too wide): the bound is live's level on the same seed (seed 91, 3,000 hands:
  // live +31.1, ec837a7 +61.1 (its 3x re-raise was called and the flop all-in folded to), with the jam +23.3).
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix8 FISH re-raise line (BB/100): ${rows.join('; ')}\n`));
  const CASES: Array<[string, string, string[], number, number, number, number, number]> = [
    ['mrn:0:p', 'heads-up, a 20 BB FISH (hard)', ['FISH'], 20, 3000, 91, 20, 35],
  ];
  it.each(CASES)('%s against %s', (line, name, lineup, botBB, hands, seed, heroBB, bound) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, botBB, hands, seed, heroBB);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (bound ${bound}; ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 <= bound]).toEqual([line, hands, 0, true]);
  }, 1_200_000);
});

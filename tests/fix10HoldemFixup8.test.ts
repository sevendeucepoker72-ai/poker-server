/**
 * tests/fix10HoldemFixup8.test.ts (2026-11-12, bots review fix round 4, fix-up 8: the Hold'em lane).
 *
 * Fix-up 7 put a Short Deck non-MANIAC on 0dc1b96's strength (ctx.sdLivePctile, the Hold'em percentile of the two cards) facing
 * a single uncommitted raise, and first in with three dealt or fewer (sdLiveSpot). Re-review 7 found the same hand read on two
 * scales: a bot opened on 0dc1b96's strength and answered the re-raise or the all-in on the Short Deck percentile, and a big
 * open was flat-called at 0dc1b96's width (no size term) while the re-raise that 0dc1b96 made was capped by the Short Deck
 * stack-off range. Fix-up 8 makes every pre-flop read of one decision use one scale:
 *  - HOLDEM-F7-EXPLOIT-1 = MEASUREMENT-1 (= REGRESSION-1 for TAG / LAG): the short-handed first-in rule keeps only the ROCK
 *    and the CALLING_STATION, whose first-in decision is a limp or a fold (the limp is answered in sdLiveSpot); a raiser's
 *    first in reads the Short Deck percentile again, as the re-raise it meets. Facing an all-in or a committed raise with no
 *    more than SHORT_DECK_LIVE_ALLIN_MAX_BB (40) at risk, a non-MANIAC reads 0dc1b96's strength (the 6-max lone 100 BB
 *    all-in keeps the Short Deck stack-off range: fix9's GUARD).
 *  - HOLDEM-F7-EXPLOIT-2: in sdLiveSpot the stack-off reads (the re-raise's jam gate) read the same 0dc1b96 strength, and
 *    deeper than 25 BB a bigger open narrows the ranges (B4, no widening).
 *  - HOLDEM-F7-REGRESSION-1 (NIT, B5's class, every no-limit variant): with NIT_LIMP_TRAP_MAX_PLAYERS (3) dealt or fewer a
 *    NIT with a call to make in an unopened pot plays 0dc1b96's NIT without its 100 BB jam: its 4-bet value hands raise to
 *    2.5 BB, the rest of its 3-bet range limps and calls an iso-raise. B5's open folded every hand but those to a 3-bet.
 *
 * Whole lines are played on a real PokerTable / ShortDeckTable through AI.decideAction, applied as index.ts executeAIAction
 * applies them; the human's all-in is scored at its equity from the board of his all-in when nobody acts after that street,
 * else by chips. Deterministic: seeded Math.random, seeded deck, frozen Date.now.
 *   rsj        never first in (fold the small blind, check the big blind's option); over a single raise move in with any two.
 *   osn:F      first in (or over limpers) raise to F x the stack with any two; re-raised: continue with QQ+ / AK only; move
 *              in at the first action after the flop.
 *   cb3:B:F:M  first in (or over limpers) raise to B BB with any two, and over a single raise re-raise to M x it; re-raised
 *              or all-in: continue with QQ+ / AK only; after the flop bet F x the pot once when checked to, else check / fold.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PokerTable, PlayerAction, GamePhase } = require('../src/game/PokerTable');
const { ShortDeckTable } = require('../src/game/variants/ShortDeckTable');
const { evaluateShortDeckHand } = require('../src/game/HandEvaluatorExtensions');
const HE = require('../src/game/HandEvaluator');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

type Variant = 'holdem' | 'shortdeck';
function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix10-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100;
const prof = (a: string, i: number, diff = 'hard') => ({ botName: 'B' + i, difficulty: diff, personality: 'x', archetype: a, vpip: 0.5, pfr: 0.3, aggressionFactor: 2, bluffFrequency: 0.2 });
const mkTable = (v: Variant, tag: string) => {
  const cfg = { tableId: tag, tableName: tag, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB };
  return v === 'shortdeck' ? new ShortDeckTable(cfg) : new PokerTable(cfg);
};
const combos = (v: Variant): any[][] => {
  const c: any[] = []; for (let r = v === 'shortdeck' ? 6 : 2; r <= 14; r++) for (let s = 0; s < 4; s++) c.push({ rank: r, suit: s });
  const out: any[][] = []; for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) out.push([c[i], c[j]]);
  return out;
};
const isFold = (d: any): boolean => d.action === PlayerAction.Fold;
const premium = (h: any[]): boolean => {
  const [x, y] = h[0].rank >= h[1].rank ? [h[0], h[1]] : [h[1], h[0]];
  return (x.rank === y.rank && x.rank >= 12) || (x.rank === 14 && y.rank === 13);
};

/** Apply a bot decision as index.ts executeAIAction does. */
function apply(t: any, a: number, d: any): void {
  const ok = d.action === PlayerAction.Fold ? t.playerFold(a)
    : d.action === PlayerAction.Check ? (t.playerCheck(a) || t.playerFold(a))
      : d.action === PlayerAction.Call ? (t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
        : d.action === PlayerAction.Raise ? (t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
          : (t.playerAllIn(a) || t.playerFold(a));
  if (!ok) t.playerFold(a);
}
/** Heads-up, `bb` BB each: seat 0 the human, seat 1 the bot; `btn` the button (= the small blind, first to act). */
function hu(v: Variant, bb: number, btn: number, tag: string): any {
  const t = mkTable(v, tag);
  expect(t.sitDown(0, 'Hero', bb * BB, 'player-' + tag, false)).toBe(true);
  expect(t.sitDown(1, 'B1', bb * BB, 'ai-' + tag, true)).toBe(true);
  t.presetFirstButton(btn);
  expect(t.startNewHand()).toBe(true);
  return t;
}
/** Share (%) of every starting combo with which the bot at `me` makes a decision `what` accepts (`build` sets the spot). */
function pct(v: Variant, build: () => any, me: number, arch: string, what: (d: any) => boolean, diff = 'hard'): number {
  let n = 0, k = 0;
  const restore = detEnv(9200);
  try {
    for (const hc of combos(v)) {
      const t = build();
      expect(t.activeSeatIndex).toBe(me);
      t.seats[me].holeCards = hc;
      n++;
      if (what(AI.decideAction(t, me, prof(arch, me, diff)))) k++;
    }
  } finally { restore(); }
  return (100 * k) / n;
}
/**
 * Heads-up at `bb` BB, the bot first in on the button: its first-in decision for every combo; when it raises (not all-in), the
 * human answers (re-raise to `m` x the open, or all-in when m = 0) and the bot decides again with the same cards.
 * Returns the share of combos it raised with and the share of those raises that continue against the answer.
 */
function openThenAnswer(v: Variant, bb: number, arch: string, m: number, first: 'raise' | 'limp' = 'raise'): { open: number; cont: number } {
  let n = 0, opened = 0, cont = 0;
  const restore = detEnv(9300);
  try {
    for (const hc of combos(v)) {
      const t = hu(v, bb, 1, 'oa');
      t.seats[1].holeCards = hc;
      n++;
      const d = AI.decideAction(t, 1, prof(arch, 1));
      if (d.action !== (first === 'raise' ? PlayerAction.Raise : PlayerAction.Call)) continue;
      apply(t, 1, d);
      if (t.activeSeatIndex !== 0) continue;
      opened++;
      if (m === 0) expect(t.playerAllIn(0)).toBe(true);
      else expect(t.playerRaise(0, first === 'limp' ? m * BB : Math.round(m * t.currentBetToMatch / 50) * 50)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      if (!isFold(AI.decideAction(t, 1, prof(arch, 1)))) cont++;
    }
  } finally { restore(); }
  return { open: (100 * opened) / n, cont: (100 * cont) / Math.max(1, opened) };
}

describe('HOLDEM-F7-EXPLOIT-1 = MEASUREMENT-1 — a Short Deck opener answers the all-in on the scale it opened on (node level)', () => {
  it('heads-up 20 BB, a TAG first in raises on the Short Deck percentile (<= 60% of combos; 70ffc14 76.6%) and continues >= 60% of its opens against a 20 BB all-in (70ffc14 27%, 5cf7147 41%)', () => {
    const r = openThenAnswer('shortdeck', 20, 'TAG', 0);
    process.stdout.write(`fix10 Short Deck HU 20 BB TAG: opens ${r.open.toFixed(1)}%, continues ${r.cont.toFixed(1)}% of them against the all-in\n`);
    expect(r.open).toBeLessThanOrEqual(60);
    expect(r.cont).toBeGreaterThanOrEqual(60);
  });
  it('heads-up 30 BB, a TAG continues >= 35% of its opens against a 30 BB all-in (70ffc14 16%, 5cf7147 21%; 0dc1b96 100%)', () => {
    const r = openThenAnswer('shortdeck', 30, 'TAG', 0);
    process.stdout.write(`fix10 Short Deck HU 30 BB TAG: opens ${r.open.toFixed(1)}%, continues ${r.cont.toFixed(1)}% of them against the all-in\n`);
    expect(r.cont).toBeGreaterThanOrEqual(35);
  });
  it.each([['TAG', 30, 22], ['NIT', 30, 20], ['ROCK', 40, 15]])('heads-up %s BB-defence: facing a %s BB all-in from the button it continues >= %s%% (on the Short Deck stack-off range half that)', (arch, bb, min) => {
    const v = pct('shortdeck', () => { const t = hu('shortdeck', bb as number, 0, 'lj'); expect(t.playerAllIn(0)).toBe(true); return t; }, 1, arch as string, (d) => !isFold(d));
    expect([arch, bb, v >= (min as number)]).toEqual([arch, bb, true]);
  });
  it('the ROCK keeps the first-in rule: heads-up 20 BB it plays >= 45% first in (a limp: answered on the same scale)', () => {
    const v = pct('shortdeck', () => hu('shortdeck', 20, 1, 'rf'), 1, 'ROCK', (d) => !isFold(d));
    expect(v).toBeGreaterThanOrEqual(45);
  });
});

describe('HOLDEM-F7-EXPLOIT-2 — in Short Deck a bigger open narrows the defence deeper than 25 BB (node level)', () => {
  it('heads-up 30 BB, a TAG / ROCK big blind continues against a 7.5 BB open at least 25 points less often than against 3 BB (70ffc14: 96% at both)', () => {
    for (const arch of ['TAG', 'ROCK']) {
      const at = (open: number) => pct('shortdeck', () => { const t = hu('shortdeck', 30, 0, 'bo'); expect(t.playerRaise(0, open * BB)).toBe(true); return t; }, 1, arch, (d) => !isFold(d));
      const small = at(3), big = at(7.5);
      process.stdout.write(`fix10 Short Deck HU 30 BB ${arch} big blind: continues ${small.toFixed(1)}% vs 3 BB, ${big.toFixed(1)}% vs 7.5 BB\n`);
      expect([arch, small >= 80, big <= small - 25]).toEqual([arch, true, true]);
    }
  });
});

describe('HOLDEM-F7-REGRESSION-1 (B5\'s class) — short-handed, a NIT limps its 3-bet range and raises only its 4-bet value hands (NIT_LIMP_TRAP_MAX_PLAYERS)', () => {
  it.each(['holdem', 'shortdeck'])('%s heads-up 40 BB, a NIT first in raises <= 6%% of combos, limps >= 8%%, and continues >= 85%% of its raises against a 3x 3-bet (the 4-bet value hands, on a fresh noise draw; 70ffc14: raised 14-31%%, folded 76-87%% of them)', (v) => {
    const raise = pct(v as Variant, () => hu(v as Variant, 40, 1, 'nf'), 1, 'NIT', (d) => d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn);
    const limp = pct(v as Variant, () => hu(v as Variant, 40, 1, 'nl'), 1, 'NIT', (d) => d.action === PlayerAction.Call);
    const r = openThenAnswer(v as Variant, 40, 'NIT', 3);
    process.stdout.write(`fix10 ${v} HU 40 BB NIT first in: raises ${raise.toFixed(1)}%, limps ${limp.toFixed(1)}%, continues ${r.cont.toFixed(1)}% of its raises vs a 3-bet\n`);
    expect([v, raise <= 6, limp >= 8, r.cont >= 85]).toEqual([v, true, true, true]);
  });
  it.each(['holdem', 'shortdeck'])('%s heads-up 40 BB, the NIT continues against a 4 BB iso-raise over its limp with >= 90%% of its limps (0dc1b96: every one)', (v) => {
    const r = openThenAnswer(v as Variant, 40, 'NIT', 4, 'limp');
    expect([v, r.open >= 8, r.cont >= 90]).toEqual([v, true, true]);
  });
  it('a six-max NIT keeps B5: first in under the gun it never limps', () => {
    const v = pct('holdem', () => {
      const t = mkTable('holdem', 'n6');
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 100 * BB, (i === 0 ? 'player-n6-' : 'ai-n6-') + i, i !== 0)).toBe(true);
      t.presetFirstButton(0);
      expect(t.startNewHand()).toBe(true);   // button 0, blinds 1 / 2, UTG 3
      return t;
    }, 3, 'NIT', (d) => d.action === PlayerAction.Call);
    expect(v).toBe(0);
  });
});

/** BB/100 of the human (seat 0, heroBB) over `hands` hands of `line` against `lineup` (bots at `botBB`). */
function play(v: Variant, line: string, lineup: string[], botBB: number, hands: number, seed: number, heroBB: number, diff = 'hard'): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const [kind, a1, a2, a3] = line.split(':');
    const ns = lineup.length + 1;
    const start = [heroBB * BB, ...lineup.map(() => botBB * BB)];
    const TOTAL = start.reduce((a, x) => a + x, 0);
    const t = mkTable(v, 'fx10');
    for (let i = 0; i < ns; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', start[i], (i ? 'ai-fx10-' : 'player-fx10-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => prof(a, i + 1, diff))];
    let raised = false, betFlop = false, sidePlay = false, evBoard = -1, ev: number | null = null;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      const shove = () => (t.playerAllIn(0) || t.playerCall(0) || fold());
      if (t.currentPhase !== GamePhase.PreFlop) {
        if (kind === 'osn' && raised && s0.chipCount > 0) { shove(); return; }
        if (kind === 'cb3' && raised && ca === 0 && !betFlop && t.currentPhase === GamePhase.Flop) {
          betFlop = true;
          const pot = t.seats.reduce((q: number, x: any) => q + (x.totalInvestedThisHand || 0), 0);
          const amt = Math.max(t.getMinRaise(), Math.round(Number(a2) * pot / 50) * 50);
          if (amt >= s0.chipCount + s0.currentBet) shove(); else (t.playerRaise(0, amt) || fold());
          return;
        }
        fold(); return;
      }
      const raises = Number(t.raisesThisStreet) || 0;
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      if (facingAllIn) { if (premium(s0.holeCards)) (t.playerCall(0) || t.playerAllIn(0)); else fold(); return; }
      if (kind === 'rsj') { if (raises === 1 && !raised && ca > 0) { raised = true; shove(); return; } fold(); return; }
      if (raised && ca > 0) { if (premium(s0.holeCards)) (t.playerCall(0) || t.playerAllIn(0) || fold()); else fold(); return; }
      if (raises === 0 && !raised) {
        raised = true;
        const to = kind === 'osn' ? Math.floor(Number(a1) * (s0.chipCount + s0.currentBet) / 50) * 50 : Number(a1) * BB;
        if (to >= s0.chipCount + s0.currentBet) { t.playerAllIn(0); return; }
        if (!t.playerRaise(0, Math.max(to, t.getMinRaise()))) { raised = false; fold(); }
        return;
      }
      if (kind === 'cb3' && raises === 1 && !raised) {
        raised = true;
        const to = Math.round(Number(a3) * t.currentBetToMatch / 50) * 50;
        if (to >= s0.chipCount + s0.currentBet) { t.playerAllIn(0); return; }
        if (!t.playerRaise(0, Math.max(to, t.getMinRaise()))) { raised = false; fold(); }
        return;
      }
      fold();
    };
    const lo = v === 'shortdeck' ? 6 : 2;
    const evalHand = (cards: any[]) => (v === 'shortdeck' ? evaluateShortDeckHand(cards) : HE.evaluateHand(cards));
    const dw = t.determineWinners.bind(t);
    t.determineWinners = (...args: any[]) => {
      const h0 = t.seats[0];
      if (h0.allIn && !h0.folded && t.communityCards.length === 5 && ev === null && evBoard >= 0 && !sidePlay) {
        const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length === 2);
        const used = new Set<number>(); for (const x of live) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
        for (const c of t.communityCards.slice(0, evBoard)) used.add(c.rank * 4 + c.suit);
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = lo; r <= 14; r++) if (!used.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let share = 0; const SIMS = 300;
        for (let i = 0; i < SIMS; i++) {
          for (let j = 0; j < 5 - evBoard; j++) { const k = j + Math.floor(mrnd() * (deck.length - j)); const z = deck[j]; deck[j] = deck[k]; deck[k] = z; }
          const board = [...t.communityCards.slice(0, evBoard), ...deck.slice(0, 5 - evBoard)];
          const e2 = live.map((x: any) => evalHand([...x.holeCards, ...board]));
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
      raised = false; betFlop = false; sidePlay = false; ev = null; evBoard = -1;
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

describe('HOLDEM-F7 whole lines — no better than live (real engine, hard)', () => {
  // Bounds (BB/100). rsj against a TAG: < 0 (review harness xr16, EV v3: live -59 / -81 at 20 / 30 BB, 70ffc14 +26 / +38,
  // here -50 / -35 over 4,500-6,000 hands). osn:0.25 against a 40 BB TAG: < 0 (live -72, 70ffc14 +62, here -72). cb3 against
  // a 40 BB NIT: live's best line there + 2 se (Short Deck cb3 +48 (4) -> 56; Hold'em cb3 +54 (2) -> 58; 70ffc14 +77 / +62).
  // On these seeds 70ffc14: +15.8 / +32.1 / +67.8 / +71.9 / +63.4; here -52.4 / -34.0 / -87.7 / +37.7 / +40.5.
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix10 whole lines (BB/100): ${rows.join('; ')}\n`));
  const CASES: Array<[string, Variant, string, string[], number, number, number, number, number]> = [
    ['rsj', 'shortdeck', 'heads-up, a 20 BB TAG', ['TAG'], 20, 2000, 101, 20, 0],
    ['rsj', 'shortdeck', 'heads-up, a 30 BB TAG', ['TAG'], 30, 2000, 102, 30, 0],
    ['osn:0.25', 'shortdeck', 'heads-up, a 40 BB TAG', ['TAG'], 40, 2000, 103, 40, 0],
    ['cb3:2.5:0.5:3', 'shortdeck', 'heads-up, a 40 BB NIT', ['NIT'], 40, 2000, 104, 40, 56],
    ['cb3:2.5:0.5:3', 'holdem', 'heads-up, a 40 BB NIT', ['NIT'], 40, 2000, 105, 40, 58],
  ];
  it.each(CASES)('%s %s against %s', (line, v, name, lineup, botBB, hands, seed, heroBB, bound) => {
    const t0 = process.hrtime.bigint();
    const r = play(v, line, lineup, botBB, hands, seed, heroBB);
    rows.push(`${line} ${v} vs ${name}: ${r.bb100.toFixed(1)} (bound ${bound}; ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < bound]).toEqual([line, hands, 0, true]);
  }, 2_400_000);
});

/**
 * tests/fix9HoldemFixup7.test.ts (2026-11-12, bots review fix round 4, fix-up 7: the Hold'em lane).
 *
 * HOLDEM-F6-REGRESSION-1 = HOLDEM-F6-EXPLOIT-1 (pre-existing since rounds 1-2, a32dcf2 / C8). Short Deck pre-flop reads its
 * own percentile table (SHORT_DECK_PREFLOP_PCTILE) against thresholds tuned on the Hold'em percentile. On that scale a
 * NIT defended its blinds against a 2.5 BB steal about half as often as 0dc1b96 (8.9 / 9.8% vs 17.8 / 20.3%), a ROCK or TAG
 * about 70% as often, and heads-up 20 BB a ROCK defended 70% (live 85%) and limped 33.5% first in (live 53.5%). An any-two
 * 2-2.5 BB steal that folds to a re-raise won +35 to +53 BB/100 at Short Deck NIT tables (live +1 to +24), and heads-up at
 * 20 BB against a ROCK a 2 BB open that moves in over a re-raise (os:2) turned profitable (+6.8; live -10.2).
 * Fix-up 7 restores 0dc1b96's strength (the Hold'em percentile of the two cards with the same noise draw and 0dc1b96's
 * hard / expert aggression adjustment: ctx.sdLivePctile) where a non-MANIAC faces a single raise from a player who is neither
 * all-in nor committed, and where it is first in with three dealt or fewer, with no size term there (0dc1b96 had none). The
 * 6-max first-in opens (C8's pin, botsShortDeckBots), the value set, the premium holds and the stack-off ranges keep the
 * Short Deck percentile. After the flop the opponents' range floor is carried onto the Short Deck table at the share of hands
 * 0dc1b96 kept with it (shortDeckRangeFloor): since 39f043a the Monte Carlo samples Short Deck ranges on the Short Deck table,
 * where the Hold'em-tuned floor kept about half of 0dc1b96's range, and a heads-up 20 BB ROCK folded its flop bets to an
 * all-in (open any two, move in on every flop: +45 BB/100, 0dc1b96 +24).
 * Fix-up 8 (tests/fix10HoldemFixup8.test.ts): the first-in rule keeps only the ROCK and the CALLING_STATION (a raiser met the
 * re-raise on the other scale), all-ins with no more than 40 BB at risk are read on 0dc1b96's strength, and inside sdLiveSpot
 * the stack-off reads are too; every pin here still holds.
 *
 * Whole lines are played on a real ShortDeckTable through AI.decideAction, applied as index.ts executeAIAction applies them;
 * the human's all-in is scored at its Short Deck equity from the board of his all-in when nobody acts after that street, else
 * by chips. Deterministic: seeded Math.random, seeded deck, frozen Date.now.
 *   osf:B   first in (or over limpers), raise to B BB with any two; fold to any re-raise (call an all-in only with QQ+ / AK);
 *           after the flop check / fold.
 *   os:B    as osf, but move in over a re-raise that is not an all-in.
 *   pf:B    as osf, but move in at the first action after the flop.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction, GamePhase } = require('../src/game/PokerTable');
const { ShortDeckTable } = require('../src/game/variants/ShortDeckTable');
const { evaluateShortDeckHand } = require('../src/game/HandEvaluatorExtensions');
const HE = require('../src/game/HandEvaluator');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix9-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100;
const prof = (a: string, i: number, diff = 'hard') => ({ botName: 'B' + i, difficulty: diff, personality: 'x', archetype: a, vpip: 0.5, pfr: 0.3, aggressionFactor: 2, bluffFrequency: 0.2 });
const sdTable = (tag: string) => new ShortDeckTable({ tableId: tag, tableName: tag, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
/** The 630 Short Deck starting combos (ranks 6-A). */
const COMBOS: any[][] = [];
{ const c: any[] = []; for (let r = 6; r <= 14; r++) for (let s = 0; s < 4; s++) c.push({ rank: r, suit: s });
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) COMBOS.push([c[i], c[j]]); }

/** Apply a bot decision as index.ts executeAIAction does. */
function apply(t: any, a: number, d: any): void {
  const ok = d.action === PlayerAction.Fold ? t.playerFold(a)
    : d.action === PlayerAction.Check ? (t.playerCheck(a) || t.playerFold(a))
      : d.action === PlayerAction.Call ? (t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
        : d.action === PlayerAction.Raise ? (t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
          : (t.playerAllIn(a) || t.playerFold(a));
  if (!ok) t.playerFold(a);
}

/** Share (%) of the 630 combos with which the bot at `me` does not fold (`build` sets the spot; seeded per combo). */
function contPct(build: () => any, me: number, arch: string, diff = 'hard', what: (d: any) => boolean = (d) => d.action !== PlayerAction.Fold): number {
  let n = 0, k = 0;
  const restore = detEnv(9100);
  try {
    for (const hc of COMBOS) {
      const t = build();
      expect(t.activeSeatIndex).toBe(me);
      t.seats[me].holeCards = hc;
      n++;
      if (what(AI.decideAction(t, me, prof(arch, me, diff)))) k++;
    }
  } finally { restore(); }
  return (100 * k) / n;
}
/** Short Deck 6-max at `bb` BB: the human on the button (seat 0) opens to `open` BB, UTG..CO fold. Small blind 1, big blind 2. */
function sixMaxSteal(bb: number, open: number, sbFolds: boolean): any {
  const t = sdTable('s6');
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, bb * BB, (i === 0 ? 'player-s6-' : 'ai-s6-') + i, i !== 0)).toBe(true);
  t.presetFirstButton(0);
  expect(t.startNewHand()).toBe(true);
  for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
  expect(t.playerRaise(0, open * BB)).toBe(true);
  if (sbFolds) expect(t.playerFold(1)).toBe(true);
  return t;
}
/** Short Deck heads-up at `bb` BB: seat 0 the human, seat 1 the bot; `btn` the button (= the small blind, first to act). */
function sdHu(bb: number, btn: number, tag: string): any {
  const t = sdTable(tag);
  expect(t.sitDown(0, 'Hero', bb * BB, 'player-' + tag, false)).toBe(true);
  expect(t.sitDown(1, 'B1', bb * BB, 'ai-' + tag, true)).toBe(true);
  t.presetFirstButton(btn);
  expect(t.startNewHand()).toBe(true);
  return t;
}

describe('HOLDEM-F6-REGRESSION-1 = EXPLOIT-1 — Short Deck blind defence on 0dc1b96\'s strength (node level, all 630 combos)', () => {
  it('six-max 100 BB, a NIT facing a 2.5 BB button open continues >= 16% from the big blind and >= 14% from the small blind (5cf7147: 9.8 / 8.9%; 0dc1b96: 20.3 / 17.8%)', () => {
    const bb = contPct(() => sixMaxSteal(100, 2.5, true), 2, 'NIT');
    const sb = contPct(() => sixMaxSteal(100, 2.5, false), 1, 'NIT');
    process.stdout.write(`fix9 Short Deck NIT vs a 2.5 BB steal: BB ${bb.toFixed(1)}%, SB ${sb.toFixed(1)}%\n`);
    expect(bb).toBeGreaterThanOrEqual(16);
    expect(sb).toBeGreaterThanOrEqual(14);
  });
  it.each(['ROCK', 'TAG'])('six-max 100 BB, a %s facing a 2.5 BB button open continues >= 60%% from the big blind and >= 38%% from the small blind (5cf7147: 50.3 / 25.6%%; 0dc1b96: 68.6 / 45.6%%)', (arch) => {
    const bb = contPct(() => sixMaxSteal(100, 2.5, true), 2, arch);
    const sb = contPct(() => sixMaxSteal(100, 2.5, false), 1, arch);
    expect([arch, bb >= 60, sb >= 38]).toEqual([arch, true, true]);
  });
  it('heads-up 20 BB, a ROCK defends its big blind against a 2 BB open 78-90% and plays >= 45% first in (5cf7147: 70 / 33.5%; 0dc1b96: 85.1 / 53.5%; with the NEW-4 widening on 0dc1b96 strength: 96%)', () => {
    const bbDef = contPct(() => { const t = sdHu(20, 0, 'rb'); expect(t.playerRaise(0, 2 * BB)).toBe(true); return t; }, 1, 'ROCK');
    const sbIn = contPct(() => sdHu(20, 1, 'rs'), 1, 'ROCK');
    process.stdout.write(`fix9 Short Deck HU 20 BB ROCK: BB defence ${bbDef.toFixed(1)}%, first in ${sbIn.toFixed(1)}%\n`);
    expect(bbDef).toBeGreaterThanOrEqual(78);
    expect(bbDef).toBeLessThanOrEqual(90);
    expect(sbIn).toBeGreaterThanOrEqual(45);
  });
  it('GUARD: a lone 100 BB all-in keeps the Short Deck stack-off range: a NIT / TAG / ROCK big blind continues <= 10% (NEW-1)', () => {
    for (const arch of ['NIT', 'TAG', 'ROCK']) {
      const v = contPct(() => {
        const t = sdTable('ls');
        for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 100 * BB, (i === 0 ? 'player-ls-' : 'ai-ls-') + i, i !== 0)).toBe(true);
        t.presetFirstButton(3);
        expect(t.startNewHand()).toBe(true);   // button 3, small blind 4, big blind 5, UTG 0 (the human)
        expect(t.playerAllIn(0)).toBe(true);
        for (const s of [1, 2, 3, 4]) expect(t.playerFold(s)).toBe(true);
        return t;
      }, 5, arch);
      expect([arch, v <= 10]).toEqual([arch, true]);
    }
  });
  it('a flat-caller facing an all-in it closes (more than 25 BB at risk) makes 0dc1b96\'s continue decision on 0dc1b96\'s strength: a FISH continues >= 25% (5cf7147, on the Short Deck percentile: 15.6%)', () => {
    const v = contPct(() => {
      const t = sdTable('fl');
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 100 * BB, (i === 0 ? 'player-fl-' : 'ai-fl-') + i, i !== 0)).toBe(true);
      t.presetFirstButton(0);
      expect(t.startNewHand()).toBe(true);   // button 0 (the human), small blind 1, big blind 2, UTG 3, MP 4, CO 5
      expect(t.playerRaise(3, 2.5 * BB)).toBe(true);
      expect(t.playerCall(4)).toBe(true);   // the FISH flat-calls
      expect(t.playerFold(5)).toBe(true);
      expect(t.playerAllIn(0)).toBe(true);
      for (const s of [1, 2, 3]) expect(t.playerFold(s)).toBe(true);
      return t;
    }, 4, 'FISH');
    process.stdout.write(`fix9 Short Deck FISH flatter vs the all-in: ${v.toFixed(1)}%\n`);
    expect(v).toBeGreaterThanOrEqual(25);
  });
});

const premium = (h: any[]): boolean => {
  const [x, y] = h[0].rank >= h[1].rank ? [h[0], h[1]] : [h[1], h[0]];
  return (x.rank === y.rank && x.rank >= 12) || (x.rank === 14 && y.rank === 13);
};
/** BB/100 of the human (seat 0, heroBB) over `hands` Short Deck hands of `line` against `lineup` (bots at `botBB`). */
function playSD(line: string, lineup: string[], botBB: number, hands: number, seed: number, heroBB: number, diff = 'hard'): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const [kind, b] = line.split(':');
    const B = Number(b);
    const ns = lineup.length + 1;
    const start = [heroBB * BB, ...lineup.map(() => botBB * BB)];
    const TOTAL = start.reduce((a, x) => a + x, 0);
    const t = sdTable('fx9');
    for (let i = 0; i < ns; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', start[i], (i ? 'ai-fx9-' : 'player-fx9-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => prof(a, i + 1, diff))];
    let raised = false, sidePlay = false, evBoard = -1, ev: number | null = null;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      if (t.currentPhase !== GamePhase.PreFlop) { if (kind === 'pf' && raised && s0.chipCount > 0) (t.playerAllIn(0) || fold()); else fold(); return; }
      const raises = Number(t.raisesThisStreet) || 0;
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      if (facingAllIn) { if (premium(s0.holeCards)) (t.playerCall(0) || t.playerAllIn(0)); else fold(); return; }
      if (raised && ca > 0) { if (kind === 'os') (t.playerAllIn(0) || t.playerCall(0) || fold()); else fold(); return; }
      if (raises === 0 && !raised) {
        raised = true;
        if (B * BB >= s0.chipCount + s0.currentBet) { t.playerAllIn(0); return; }
        if (!t.playerRaise(0, Math.max(B * BB, t.getMinRaise()))) { raised = false; fold(); }
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
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 6; r <= 14; r++) if (!used.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let share = 0; const SIMS = 300;
        for (let i = 0; i < SIMS; i++) {
          for (let j = 0; j < 5 - evBoard; j++) { const k = j + Math.floor(mrnd() * (deck.length - j)); const z = deck[j]; deck[j] = deck[k]; deck[k] = z; }
          const board = [...t.communityCards.slice(0, evBoard), ...deck.slice(0, 5 - evBoard)];
          const e2 = live.map((x: any) => evaluateShortDeckHand([...x.holeCards, ...board]));
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

describe('HOLDEM-F6-REGRESSION-1 = EXPLOIT-1 whole lines — Short Deck steals: no better than live (real engine)', () => {
  // Bounds (BB/100, hard). osf:2 at five 100 BB NITs, a 40 BB human: 0dc1b96 +15 (6) over 6,000 hands of the review harness
  // (xr14, EV v3); fix-up 8 (re-review 7 P3, HOLDEM-F7-MEASUREMENT-2): with the three reviewers' live runs it pools to about
  // +11 (3) over 17,000 hands, so the bound is +20 (live + 2 se; it was +27); this seed: 5cf7147 +51.8, here +12.6. os:2 heads-up
  // against a 20 BB ROCK
  // (the ROCK never re-raises, so it is the steal itself): < 0 (5cf7147 +7.5 on this seed, +11 (2) over 9,000 hands; here -4.3,
  // -4 (2) over 9,000; 0dc1b96 -7 (2)). pf:2 (any flop all-in) against the same ROCK: 0dc1b96 +24 (5) over 9,000 hands, the bound
  // +40 (live + 2 se of 3,000 hands); this seed: 5cf7147 +48.3, here +23.5 (on the Short Deck table's range floor: +45 (5)).
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix9 Short Deck whole lines (BB/100): ${rows.join('; ')}\n`));
  const NITS = ['NIT', 'NIT', 'NIT', 'NIT', 'NIT'];
  const CASES: Array<[string, string, string[], number, number, number, number, number]> = [
    ['osf:2', 'five 100 BB NITs, the human 40 BB (hard)', NITS, 100, 2000, 93, 40, 20],
    ['os:2', 'heads-up, a 20 BB ROCK (hard)', ['ROCK'], 20, 3000, 96, 20, 0],
    ['pf:2', 'heads-up, a 20 BB ROCK (hard)', ['ROCK'], 20, 3000, 97, 20, 40],
  ];
  it.each(CASES)('%s against %s', (line, name, lineup, botBB, hands, seed, heroBB, bound) => {
    const t0 = process.hrtime.bigint();
    const r = playSD(line, lineup, botBB, hands, seed, heroBB);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (bound ${bound}; ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < bound]).toEqual([line, hands, 0, true]);
  }, 2_400_000);   // fix-up 8 (re-review 7 P3): the os:2 row took 1,189 s of its 1,200 s under load
});

describe('HOLDEM-F6-REGRESSION-1 after the flop — the Short Deck range floor keeps 0dc1b96\'s share of hands (shortDeckRangeFloor)', () => {
  it('carries each Hold\'em-tuned floor onto the Short Deck table at the share of the 630 combos 0dc1b96 kept (within 3 points); no floor stays none', () => {
    const PR = require('../src/ai/preflopRanges');
    const SDP = require('../src/ai/shortDeckPreflop');
    const hp: number[] = [], sp: number[] = [];
    for (let a = 0; a < 36; a++) for (let b = a + 1; b < 36; b++) {
      const r1 = 6 + (a >> 2), r2 = 6 + (b >> 2), su = (a & 3) === (b & 3);
      hp.push(PR.percentileByRanks(r1, r2, su)); sp.push(SDP.shortDeckPercentileByRanks(r1, r2, su));
    }
    const bad: string[] = [];
    for (const x of [0.45, 0.62, 0.67, 0.72, 0.80, 0.85, 0.92]) {
      const live = hp.filter((v) => v >= x).length / hp.length;
      const y = AI.shortDeckRangeFloor(x);
      const now = sp.filter((v) => v >= y).length / sp.length;
      const old = sp.filter((v) => v >= x).length / sp.length;   // 5cf7147: the Hold'em-tuned floor on the Short Deck table
      if (!(now >= live && now <= live + 0.03 && old < live - 0.05)) bad.push(`${x}: 0dc1b96 ${live.toFixed(3)}, now ${now.toFixed(3)}, 5cf7147 ${old.toFixed(3)}`);
    }
    expect(bad).toEqual([]);
    expect(AI.shortDeckRangeFloor(0)).toBe(0);
    expect(AI.shortDeckRangeFloor(0.2)).toBe(0);   // 0dc1b96 kept every Short Deck combo (its lowest is 0.255)
  });
});

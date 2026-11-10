/**
 * tests/fix7HoldemFixup5.test.ts (2026-11-10, bots review fix round 4, fix-up 5: the Hold'em lane).
 *
 * 1. HOLDEM-F4-REGRESSION-1 = HOLDEM-F4-MEASUREMENT-1: fix-up 4 read a committed raise (no more than the pot behind,
 *    NEAR_ALLIN_SPR) as the all-in at 25 BB or less and continued it by a CALL. Heads-up (Heads-Up Snap: 20 BB, any
 *    archetype) the call left the raiser his flop all-in, which the bot then folded: opening any two to 40-50% of the
 *    stack and moving in on any flop won +68 to +139 BB/100 against NIT / ROCK (live 0dc1b96 -152 to -338), opening to
 *    35% and moving in with a pair or a draw +23 to +80 against every archetype (live -58 to -117). When the raiser is the
 *    only other player with chips the bot now covers him (the jam) at every depth; multiway it still calls.
 * 2. HOLDEM-F4-EXPLOIT-2: the same cover at a NIT table (a 15 BB human opening any two to 35% of his stack, folding to a
 *    re-raise and moving in on any flop: +23 BB/100 on f605403, live -136).
 * 3. HOLDEM-F4-EXPLOIT-1 / THE MANIAC CLASS: a MANIAC facing a raise or an all-in plays 0dc1b96's MANIAC
 *    (maniacFacingRaise0dc1b96): the opener isolates a short all-in with a flatter behind (f605403 flat-called it ~70%:
 *    the flatter's chips were dead money), and limping any two then moving in on the flop with a pair or a draw loses
 *    again at the MANIAC tables (f605403 +215..+307 BB/100 at the default tables; live -85 / -13).
 * 4. HOLDEM-F4-EXPLOIT-2, the uncommitted open: a NIT that would flat-call a single raise from a player with 25 BB or less at
 *    risk, nobody else in, moves in over it (nitShortRaiserCover; f605403 flat-called its 3-bet range and folded the flop:
 *    an any-two open to 25-30% of a 20-25 BB stack won +28 to +33 BB/100 against five NITs, live -1 to -25).
 *
 * Whole lines are played on a real PokerTable through AI.decideAction, applied as index.ts executeAIAction applies
 * them. An all-in of the human that is called is scored at its equity from the board of his all-in, on the pot he can
 * win (sum of min(invested, his investment)), when nobody acts after that street; when the deeper stacks play a side
 * pot after it, the hand is scored by its chips (the equity at the board of a later fold is not an unbiased score: the
 * fold depends on the cards that come). Deterministic: seeded Math.random, seeded deck (crypto.randomBytes), frozen Date.now.
 *   osn:F:R    first in, raise to F x the stack with any two; re-raised: continue with the top 6% (stack-off
 *              percentile >= 0.94), else fold; after the flop R = a: move in at the first action, R = p: only with a
 *              pair (a hole card used), a flush draw or an open-ended straight draw, else check / fold.
 *   opn:F:R    raise to F x the stack with any two when first in or over ONE (not all-in) raise; call any re-raise;
 *              after the flop as osn.
 *   lg:C:R     limp any two first in (check the option), call ONE raise of at most C BB, fold to more; after the flop as osn.
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
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix7-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100;
const prof = (a: string, i: number, diff = 'hard') => ({ botName: 'B' + i, difficulty: diff, personality: 'x', archetype: a, vpip: 0.5, pfr: 0.3, aggressionFactor: 2, bluffFrequency: 0.2 });

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
    const t = new PokerTable({ tableId: 'fx7', tableName: 'fx7', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
    for (let i = 0; i < ns; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', start[i], (i ? 'ai-fx7-' : 'player-fx7-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => prof(a, i + 1, diff))];
    let raised = false, limped = false, called = false, sidePlay = false, evBoard = -1, ev: number | null = null;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      const shove = () => (t.playerAllIn(0) || t.playerCall(0) || fold());
      if (t.currentPhase !== GamePhase.PreFlop) {
        if (s0.chipCount > 0 && (rule === 'a' || pairOrDraw(s0.holeCards, t.communityCards))) { shove(); return; }
        fold(); return;
      }
      const raises = Number(t.raisesThisStreet) || 0;
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      const to = Math.floor(F * (s0.chipCount + s0.currentBet) / 50) * 50;
      if (kind === 'lg') {
        if (raises === 0 && !limped) { limped = true; if (ca > 0) { t.playerCall(0) || fold(); } else { t.playerCheck(0) || fold(); } return; }
        if (raises === 0) { if (ca > 0) { t.playerCall(0) || fold(); } else { t.playerCheck(0) || fold(); } return; }
        if (raises === 1 && !called && ca > 0 && ca <= F * BB && !facingAllIn) { called = true; t.playerCall(0) || fold(); return; }
        fold(); return;
      }
      if (raised && ca > 0) {
        if (kind === 'opn' || PR.getStackOffPercentile(s0.holeCards) >= 0.94) { t.playerCall(0) || t.playerAllIn(0) || fold(); return; }
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
      raised = false; limped = false; called = false; sidePlay = false; ev = null; evBoard = -1;
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

/**
 * Heads-up 20 BB: the bot facing the human's committed raise (an open, or a 3-bet over its own open, to F of his stack:
 * no more than the pot left behind). Returns the bot's decisions by action.
 */
function huCommitted(arch: string, F: number, threeBet: boolean, deals: number, seed: number): Record<string, number> {
  const restore = detEnv(seed);
  const out: Record<string, number> = { fold: 0, call: 0, raise: 0, allin: 0, other: 0 };
  try {
    for (let d = 0; d < deals; d++) {
      const t = new PokerTable({ tableId: 'hu' + d, tableName: 'hu', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
      expect(t.sitDown(0, 'Hero', 20 * BB, 'player-hu', false)).toBe(true);
      expect(t.sitDown(1, 'B1', 20 * BB, 'ai-hu', true)).toBe(true);
      t.presetFirstButton(threeBet ? 1 : 0);   // heads-up the button is the small blind and acts first pre-flop
      expect(t.startNewHand()).toBe(true);
      const p = prof(arch, 1);
      let g = 0, done = false;
      while (!done && t.isHandInProgress() && t.currentPhase === GamePhase.PreFlop && g++ < 10) {
        const a = t.activeSeatIndex;
        const raises = Number(t.raisesThisStreet) || 0;
        if (a === 0) {
          if (raises === 0 && !threeBet) { t.playerRaise(0, Math.round(F * 20 * BB)); continue; }
          if (raises === 1 && threeBet) { t.playerRaise(0, Math.round(F * 20 * BB)); continue; }
          break;   // not this spot
        }
        if ((Number(t.raisesThisStreet) || 0) === (threeBet ? 2 : 1) && t.seats[0].currentBet === Math.round(F * 20 * BB)) {
          expect(AI.nearAllInRaiser(t, t.seats[1])?.seatIndex).toBe(0);
          const dec = AI.decideAction(t, 1, p);
          const k = dec.action === PlayerAction.Fold ? 'fold' : dec.action === PlayerAction.Call ? 'call'
            : dec.action === PlayerAction.Raise ? 'raise' : dec.action === PlayerAction.AllIn ? 'allin' : 'other';
          out[k]++;
          done = true; break;
        }
        if (threeBet && raises === 0) { apply(t, 1, { action: PlayerAction.Raise, raiseAmount: 250 }); continue; }   // the bot's open
        apply(t, 1, AI.decideAction(t, 1, p));
      }
    }
  } finally { restore(); }
  return out;
}

describe('HOLDEM-F4-REGRESSION-1 / MEASUREMENT-1 — heads-up, a committed raise is covered, never flat-called', () => {
  const ARCHS = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'CALLING_STATION', 'MANIAC'];
  it.each(ARCHS)('%s at 20 BB never flat-calls a committed open (35-50%%) or 3-bet (40%%)', (arch) => {
    const tot: Record<string, number> = { fold: 0, call: 0, raise: 0, allin: 0, other: 0 };
    let spots = 0;
    for (const [F, tb, seed] of [[0.35, false, 71], [0.5, false, 72], [0.4, true, 73]] as Array<[number, boolean, number]>) {
      const r = huCommitted(arch, F, tb, 150, seed);
      for (const k of Object.keys(tot)) tot[k] += r[k];
      spots += r.fold + r.call + r.raise + r.allin + r.other;
    }
    // f605403 flat-called 17-24% of these (TAG / NIT / ROCK / FISH), the CALLING_STATION and the MANIAC more.
    expect([arch, tot.call, tot.other]).toEqual([arch, 0, 0]);
    expect(spots).toBeGreaterThan(150);
    expect(tot.raise + tot.allin).toBeGreaterThan(0);
  }, 120_000);
});

describe('HOLDEM-F4-REGRESSION-1 / MEASUREMENT-1 / EXPLOIT-2 — committed-raise lines lose (whole line, real engine)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix7 committed-raise lines (BB/100): ${rows.join('; ')}\n`));
  const NITS = ['NIT', 'NIT', 'NIT', 'NIT', 'NIT'];
  // f605403 on these seeds: [filled in from the proof run]
  const CASES: Array<[string, string, string[], number, number, number, number]> = [
    ['osn:0.5:a', 'heads-up, a 20 BB ROCK (Heads-Up Snap)', ['ROCK'], 20, 1500, 81, 20],
    ['osn:0.4:a', 'heads-up, a 20 BB NIT (Heads-Up Snap)', ['NIT'], 20, 1500, 82, 20],
    ['opn:0.35:p', 'heads-up, a 20 BB TAG (Heads-Up Snap)', ['TAG'], 20, 3000, 83, 20],
    ['osn:0.35:a', 'five 100 BB NITs, the human 15 BB', NITS, 100, 3000, 84, 15],
    ['osn:0.25:a', 'five 100 BB NITs, the human 25 BB (an open that leaves more than the pot behind)', NITS, 100, 3000, 85, 25],
  ];
  it.each(CASES)('%s loses against %s', (line, name, lineup, botBB, hands, seed, heroBB) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, botBB, hands, seed, heroBB);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < 0]).toEqual([line, hands, 0, true]);
  }, 1_200_000);
});

/** A 6-max table at 50/100 (button 4: small blind 5, big blind 0), stacks in BB by seat, every seat but 0 a bot. */
function six(stacks: number[], tag: string): any {
  const t = new PokerTable({ tableId: tag, tableName: tag, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-' : 'ai-') + tag + '-' + i, i !== 0)).toBe(true);
  t.presetFirstButton(4);
  expect(t.startNewHand()).toBe(true);
  return t;
}
/** Decisions of `arch` at seat `me` over `n` deals of `build` (the table is rebuilt each deal: fresh cards). */
function decisions(build: () => any, me: number, arch: string, n: number, seed: number): Record<string, number> {
  const restore = detEnv(seed);
  const out: Record<string, number> = { fold: 0, check: 0, call: 0, raise: 0, allin: 0 };
  try {
    for (let k = 0; k < n; k++) {
      const t = build();
      expect(t.activeSeatIndex).toBe(me);
      const d = AI.decideAction(t, me, prof(arch, me));
      out[d.action === PlayerAction.Fold ? 'fold' : d.action === PlayerAction.Check ? 'check' : d.action === PlayerAction.Call ? 'call'
        : d.action === PlayerAction.Raise ? 'raise' : 'allin']++;
    }
  } finally { restore(); }
  return out;
}

describe('HOLDEM-F4-EXPLOIT-1 / -2 — a short player\'s raise is isolated, not flat-called (node level)', () => {
  it('a 100 BB MANIAC that opened, facing a 20 / 25 BB human\'s all-in with a flatter still to act, isolates it (>= 85% re-raise / all-in) and never flat-calls (f605403 flat-called ~70%: the flatter\'s chips were dead money for the human)', () => {
    const bad: string[] = [];
    for (const hbb of [20, 25]) for (const flatter of ['TAG', 'FISH']) {
      // UTG (seat 1, the MANIAC) opens to 3 BB, MP (seat 2) flat-calls, CO / button / small blind fold, the human (big blind) shoves.
      const r = decisions(() => { const t = six([hbb, 100, 100, 100, 100, 100], 'iso' + hbb + flatter); t.playerRaise(1, 3 * BB); t.playerCall(2); for (const s of [3, 4, 5]) t.playerFold(s); t.playerAllIn(0); return t; }, 1, 'MANIAC', 300, 7100 + hbb);
      if (r.call > 0 || r.raise + r.allin < 0.85 * 300) bad.push(`${hbb} BB vs ${flatter} flatter: ${JSON.stringify(r)}`);
    }
    expect(bad).toEqual([]);
  });
  it('a 100 BB NIT facing a 20 / 25 BB human\'s open to 25-30% of his stack, nobody else in, never flat-calls it: it moves in or folds (f605403 flat-called its 3-bet range and folded the flop)', () => {
    const bad: string[] = [];
    for (const [hbb, f] of [[20, 0.3], [20, 0.25], [25, 0.25], [15, 0.25]]) {
      // the human UTG... here the human is the big blind's left: seat 1 (UTG) is the human; seats 2-5 and 0 are NITs.
      const r = decisions(() => {
        const t = new PokerTable({ tableId: 'nit' + hbb, tableName: 'nit', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
        for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, (i === 1 ? hbb : 100) * BB, (i === 1 ? 'player-nit-' : 'ai-nit-') + i, i !== 1)).toBe(true);
        t.presetFirstButton(4);
        expect(t.startNewHand()).toBe(true);   // button 4, small blind 5, big blind 0, UTG 1 (the human)
        expect(t.playerRaise(1, Math.round(f * hbb) * BB)).toBe(true);
        for (const s of [2, 3, 4, 5]) expect(t.playerFold(s)).toBe(true);
        return t;
      }, 0, 'NIT', 400, 7200 + hbb);
      if (r.call > 0 || r.raise + r.allin === 0) bad.push(`${hbb} BB open to ${f}: ${JSON.stringify(r)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('THE MANIAC CLASS (HOLDEM-F3-REGRESSION-2 = MEASUREMENT-1 = EXPLOIT-2) — limp any two, move in on the flop with a pair or a draw: loses (whole line)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix7 MANIAC class lines (BB/100): ${rows.join('; ')}\n`));
  const M5 = ['MANIAC', 'MANIAC', 'MANIAC', 'MANIAC', 'MANIAC'];
  const CASES: Array<[string, string, string[], number, number, number, number, string]> = [
    ['lg:5:p', 'five 100 BB MANIACs, the human 100 BB (the default table, hard)', M5, 100, 1500, 91, 100, 'hard'],
    ['lg:5:p', 'two 100 BB MANIACs + TAG / FISH / LAG, the human 100 BB (medium)', ['MANIAC', 'MANIAC', 'TAG', 'FISH', 'LAG'], 100, 1500, 92, 100, 'medium'],
  ];
  it.each(CASES)('%s loses against %s', (line, name, lineup, botBB, hands, seed, heroBB, diff) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, botBB, hands, seed, heroBB, diff);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < 0]).toEqual([line, hands, 0, true]);
  }, 1_200_000);
});

const card = (r: number, s: number) => ({ rank: r, suit: s });
/** 4 players at 50/100 (button 3: small blind 0 = the human, big blind 1, UTG 2, button 3); everyone puts in 15 BB pre-flop; the human starts with humanBB. Flop K-Q-3 rainbow; the bots hold air. */
function flopSpot(humanBB: number, tag: string): any {
  const t = new PokerTable({ tableId: tag, tableName: tag, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
  for (let i = 0; i < 4; i++) expect(t.sitDown(i, 'P' + i, (i === 0 ? humanBB : 100) * BB, (i === 0 ? 'player-' : 'ai-') + tag + i, i !== 0)).toBe(true);
  t.presetFirstButton(3);
  expect(t.startNewHand()).toBe(true);
  // pre-flop order: UTG 2, button 3, small blind 0, big blind 1
  expect(t.playerRaise(2, 15 * BB)).toBe(true); expect(t.playerCall(3)).toBe(true); expect(t.playerCall(0)).toBe(true); expect(t.playerCall(1)).toBe(true);
  expect(t.currentPhase).toBe(GamePhase.Flop);
  t.communityCards = [card(13, 0), card(12, 1), card(3, 2)];
  const air = [[card(7, 3), card(2, 0)], [card(9, 3), card(4, 0)], [card(8, 2), card(5, 3)]];
  for (let i = 1; i <= 3; i++) t.seats[i].holeCards = air[i - 1];
  t.seats[0].holeCards = [card(14, 3), card(14, 2)];
  return t;
}
describe('re-review 4 P3 — the two fix-up 4 sub-rules no node test caught (each test fails only with its own rule reverted)', () => {
  it('the post-flop price floor is flat: three MANIACs with air facing a short human\'s last 5 BB flop all-in into 60 BB (7.7% needed) never fold (per opponent, 3.3%, they did)', () => {
    let folds = 0, n = 0;
    const restore = detEnv(901);
    try {
      for (let k = 0; k < 60; k++) {
        const t = flopSpot(20, 'fl' + k);
        expect(t.activeSeatIndex).toBe(0);
        expect(t.playerAllIn(0)).toBe(true);
        const a = t.activeSeatIndex; expect(a).toBe(1);
        n++; if (AI.decideAction(t, a, prof('MANIAC', a)).action === PlayerAction.Fold) folds++;
      }
    } finally { restore(); }
    expect([n, folds]).toEqual([60, 0]);
  });
  it('a dry side pot against a short human who is not all-in (no more than 10% of the pot behind) is checked down: MANIAC air never bets it', () => {
    let bets = 0, n = 0;
    const restore = detEnv(902);
    try {
      for (let k = 0; k < 60; k++) {
        const t = flopSpot(15.5, 'mc' + k);   // the human keeps 0.5 BB behind a 60 BB pot
        expect(t.seats[0].allIn).toBe(false);
        expect(t.activeSeatIndex).toBe(0);
        expect(t.playerCheck(0)).toBe(true);
        const a = t.activeSeatIndex; expect(a).toBe(1);
        n++; const d = AI.decideAction(t, a, prof('MANIAC', a));
        if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) bets++;
      }
    } finally { restore(); }
    expect([n, bets]).toEqual([60, 0]);
  });
});

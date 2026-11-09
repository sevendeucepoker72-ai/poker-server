/**
 * tests/fix4ManiacDeepFullLine.test.ts (2026-11-08, bots review fix round 4: HOLDEM-R3-REG-1, the whole line).
 * UNEQUAL stacks, the norm on the ring tables: bots have no stack cap and only grow, a human buys in for at
 * most 100 BB. A 100 (or 40) BB human plays an ANY-TWO-CARDS line against MANIACs deeper than him; the bots play
 * every street through the real decideAction, applied as index.ts executeAIAction applies them, on a real
 * PokerTable. Stacks are reset every hand. The human check/folds after the flop. A pre-flop all-in of his that
 * is called is scored at its all-in equity on the pot he can win (sum of min(invested, his investment)), by a
 * seeded Monte Carlo over the cards still to come at the LAST fold of a player in that pot (deeper bots keep
 * betting side pots and fold hands that missed; equity from the all-in board against the survivors overstated
 * the human). Chips are conserved.
 *   os:B       first in, raise to B BB; shove over any non-all-in re-raise; facing an all-in call QQ+/AK only.
 *   osrr:B:M   os:B, and facing exactly one raise 3-bet to M x the bet; shove over the 4-bet.
 *   tg:B:M     the deep MANIAC as the target: open B BB first in; 3-bet M x over a single raise only when a deep
 *              bot (>= 200 BB) made it; shove over a re-raise only when a deep bot made it; else fold.
 *   rsj        re-shove any two over exactly one (not all-in) raise; else fold.
 *   sq         squeeze all-in with any two over exactly one raise and at least one caller; else fold.
 *   rsjm       all-in with any two only when the one raise this street is the MANIAC's (seat 1), callers or not
 *              (fix-up 1, HOLDEM-R4-EXPLOIT-1 / -2: with the MANIAC in seat 1 it fires from the big blind over its
 *              UTG open; b4d567f folded the opener 77-86% when a flatter was behind; hard, as the review measured:
 *              +30 BB/100 at a 500 BB MANIAC, +30 at equal 100 BB stacks; live 0dc1b96 -36 / -30). A 40 BB human's
 *              squeeze is pinned at node level (tests/fix4ManiacOpenerFlatters.test.ts): on the whole line it sits
 *              near 0 (dead money of the flatter; live is -13), too close to 0 for a seeded sign test.
 *   rsjma      as rsjm, over the one raise of ANY MANIAC (fix-up 2, HOLDEM-RR1-EXPLOIT-1: two 100 BB MANIACs, a 40 BB
 *              human: they no longer re-raise each other, so a lone MANIAC raise reaches him ~2x as often; the opener
 *              then folded 65% of its raises to his all-in (the stack-off range for 40 BB) or isolated over flatters:
 *              +24 (5) BB/100 on 09fe8d2, hard, exploit review harness; live 0dc1b96 -28. With
 *              MANIAC_SHORT_SHOVE_MAX_BB it keeps its MANIAC branch: ~0 there, and this harness's row below).
 * On 0bc7529 the light re-raise cap was 5% of the MANIAC's OWN stack, so a deep MANIAC re-raised ~93% of hands
 * again and folded ~78% of them to the 100 BB shove (hard, BB/100): tg:4:3 +445, osrr:3:3 +172 vs a 1,000 BB
 * MANIAC + 100 BB TAG/LAG/NIT/FISH; os:2.5 +182 vs five 200 BB MANIACs; heads-up os:4 +66 vs a 300 BB MANIAC
 * (live 0dc1b96: -280 / -468 / -386 to -505 / -194). Fix round 4 (call-then-fold): a MANIAC that flat-called
 * folded its flat to a squeeze or re-shove at the plain stack-off width, and a deep one called a short all-in it
 * did not close with ~70% (hard, 40 BB human): sq +144 vs five 40 BB MANIACs (live +30), rsj +250 vs five 500 BB
 * MANIACs (live -138). Deterministic: seeded Math.random, seeded deck (crypto.randomBytes), frozen Date.now.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PokerTable, PlayerAction, GamePhase } = require('../src/game/PokerTable');
const AI = require('../src/ai/AIPlayer');
const HE = require('../src/game/HandEvaluator');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix4-mdf-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100;
/** 'medium' bots price post-flop without Monte Carlo (fast); the MANIAC pre-flop line is the same at every difficulty. */
const DIFF = process.env.FIX4_MDF_DIFF || 'medium';

/** BB/100 of the human (seat 0, heroBB) over `hands` hands of `line` against `lineup` with `depths` (BB, seats 1..). */
function play(line: string, lineup: string[], depths: number[], hands: number, seed: number, heroBB = 100, diff = DIFF): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const [kind, b, m] = line.split(':');
    const open = Number(b) * BB, mult = Number(m || 3);
    const ns = lineup.length + 1;
    const start = [heroBB * BB, ...depths.map((d) => d * BB)];
    const TOTAL = start.reduce((a, x) => a + x, 0);
    const t = new PokerTable({ tableId: 'mdf', tableName: 'mdf', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
    for (let i = 0; i < ns; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', start[i], (i ? 'ai-mdf-' : 'player-mdf-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => ({ botName: 'B' + (i + 1), difficulty: diff, personality: 'maniac', archetype: a, vpip: 0.5, pfr: 0.4, aggressionFactor: 4, bluffFrequency: 0.3 }))];
    const premium = (h: any[]) => { const [x, y] = h[0].rank >= h[1].rank ? h : [h[1], h[0]]; return (x.rank === y.rank && x.rank >= 12) || (x.rank === 14 && y.rank === 13); };
    const deepRaiser = (): boolean => {   // the last voluntary raise this street was a deep bot's
      let last = -1;
      for (const e of t.actionLog) if (e.street === t.currentPhase && e.seatIndex !== 0 && /^(raised to|bet |went all-in)/.test(String(e.action))) last = e.seatIndex;
      return last > 0 && start[last] >= 200 * BB;
    };
    let raised = false;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      if (t.currentPhase !== GamePhase.PreFlop) { fold(); return; }
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      const raises = Number(t.raisesThisStreet) || 0;
      if (raised && ca > 0) {
        if (facingAllIn) { if (premium(s0.holeCards)) t.playerCall(0) || t.playerAllIn(0); else t.playerFold(0); return; }
        if (kind === 'tg' && !deepRaiser()) { fold(); return; }
        t.playerAllIn(0); return;
      }
      if (kind === 'rsjm' || kind === 'rsjma') {
        let last = -1;
        for (const e of t.actionLog) if (e.street === t.currentPhase && e.seatIndex !== 0 && /^(raised to|bet |went all-in)/.test(String(e.action))) last = e.seatIndex;
        const maniacRaise = kind === 'rsjm' ? last === 1 : last > 0 && (profs[last] as any).archetype === 'MANIAC';
        if (raises === 1 && !facingAllIn && maniacRaise) { raised = true; t.playerAllIn(0); return; }
        if (facingAllIn && premium(s0.holeCards)) { t.playerCall(0) || t.playerAllIn(0); return; }
        fold(); return;
      }
      if (kind === 'rsj' || kind === 'sq') {
        const callers = t.seats.filter((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.currentBet >= t.currentBetToMatch).length;
        if (raises === 1 && !facingAllIn && (kind === 'rsj' || callers >= 2)) { raised = true; t.playerAllIn(0); return; }
        if (facingAllIn && premium(s0.holeCards)) { t.playerCall(0) || t.playerAllIn(0); return; }
        fold(); return;
      }
      if (raises === 0) { raised = true; if (!t.playerRaise(0, open)) { raised = false; fold(); } return; }
      if ((kind === 'osrr' || (kind === 'tg' && deepRaiser())) && raises === 1 && !facingAllIn) {
        raised = true; if (!t.playerRaise(0, Math.round(mult * t.currentBetToMatch / 50) * 50)) { raised = false; fold(); } return;
      }
      if (facingAllIn && premium(s0.holeCards)) { t.playerCall(0) || t.playerAllIn(0); return; }
      fold();
    };
    let ev: number | null = null, evBoard = 0;
    const dw = t.determineWinners.bind(t);
    t.determineWinners = (...args: any[]) => {
      const h0 = t.seats[0];
      if (h0.allIn && !h0.folded && t.communityCards.length === 5 && ev === null && (t as any).__allInPre) {
        const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length === 2);
        const used = new Set<number>(); for (const x of live) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
        for (const c of t.communityCards.slice(0, evBoard)) used.add(c.rank * 4 + c.suit);
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!used.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let share = 0; const SIMS = 400;
        for (let i = 0; i < SIMS; i++) {
          for (let j = 0; j < 5 - evBoard; j++) { const k = j + Math.floor(mrnd() * (deck.length - j)); const z = deck[j]; deck[j] = deck[k]; deck[k] = z; }
          const board = [...t.communityCards.slice(0, evBoard), ...deck.slice(0, 5 - evBoard)];
          const ev2 = live.map((x: any) => HE.evaluateHand([...x.holeCards, ...board]));
          let best = [0];
          for (let k = 1; k < ev2.length; k++) { const c = HE.compareTo(ev2[k], ev2[best[0]]); if (c > 0) best = [k]; else if (c === 0) best.push(k); }
          const me = live.findIndex((x: any) => x.seatIndex === 0);
          if (best.includes(me)) share += 1 / best.length;
        }
        // The human is the shortest stack: he can win only sum(min(invested, his investment)) (no side pots).
        const inv = h0.totalInvestedThisHand;
        const pot = t.seats.reduce((q: number, x: any) => q + Math.min(x.totalInvestedThisHand || 0, inv), 0);
        ev = (share / SIMS) * pot - inv;
      }
      return dw(...args);
    };
    let total = 0, drift = 0, n = 0;
    for (let h = 0; h < hands; h++) {
      for (let i = 0; i < ns; i++) { const x = t.seats[i]; x.chipCount = start[i]; x.eliminated = false; x.sittingOut = false; }
      raised = false; ev = null; evBoard = 0; (t as any).__allInPre = false;
      expect(t.startNewHand()).toBe(true);
      let g = 0;
      while (t.isHandInProgress() && g++ < 300) {
        const a = t.activeSeatIndex; if (a < 0) break;
        if (a === 0) { hero(); if (t.seats[0].allIn && t.currentPhase === GamePhase.PreFlop) (t as any).__allInPre = true; continue; }
        if (t.seats[0].folded) { if (!t.playerFold(a)) t.playerCheck(a); continue; }   // the human's result is final
        const wasIn = !t.seats[a].folded;
        const d = AI.decideAction(t, a, profs[a]);
        const ok = d.action === PlayerAction.Fold ? t.playerFold(a)
          : d.action === PlayerAction.Check ? (t.playerCheck(a) || t.playerFold(a))
            : d.action === PlayerAction.Call ? (t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
              : d.action === PlayerAction.Raise ? (t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
                : (t.playerAllIn(a) || t.playerFold(a));
        if (!ok) t.playerFold(a);
        if ((t as any).__allInPre && wasIn && t.seats[a].folded) evBoard = t.communityCards.length;   // a player of his pot folded
      }
      expect(t.isHandInProgress()).toBe(false);
      if (t.seats.reduce((q: number, x: any) => q + (x.state === 'occupied' ? x.chipCount : 0), 0) !== TOTAL) drift++;
      total += (ev ?? (t.seats[0].chipCount - start[0])) / BB; n++;
    }
    return { bb100: (100 * total) / n, drift, hands: n };
  } finally { restore(); }
}

describe('HOLDEM-R3-REG-1 + call-then-fold — any two cards does not profit from deep MANIACs (unequal stacks, whole line, real engine)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix4 deep MANIAC full line (BB/100): ${rows.join('; ')}\n`));
  const MPLUS = ['MANIAC', 'TAG', 'LAG', 'NIT', 'FISH'];
  const N = Number(process.env.FIX4_MDF_HANDS || 400);
  const M5 = ['MANIAC', 'MANIAC', 'MANIAC', 'MANIAC', 'MANIAC'];
  // rsjm folds every hand but the big blind's: cheap, so more hands (the spot is ~1 hand in 6).
  const RSJM_N = Number(process.env.FIX4_MDF_RSJM_HANDS || 12 * N);
  // rsjma at 40 BB sits within ~10 BB/100 of 0 on 6,000 hands either way: 30 x N (12,000) hands.
  const RSJMA_N = Number(process.env.FIX4_MDF_RSJMA_HANDS || 30 * N);
  // Every row names its difficulty: jest-each passes a `done` callback to a test function with more parameters than
  // the row has (fix-up 1: rows without it timed out after 600 s with `done` read as the difficulty).
  const CASES: Array<[string, string, string[], number[], number, number, number, string]> = [
    ['tg:4:3', 'a 1,000 BB MANIAC + 100 BB TAG/LAG/NIT/FISH', MPLUS, [1000, 100, 100, 100, 100], N, 41, 100, DIFF],
    ['osrr:3:3', 'a 1,000 BB MANIAC + 100 BB TAG/LAG/NIT/FISH', MPLUS, [1000, 100, 100, 100, 100], N, 42, 100, DIFF],
    ['os:2.5', 'five 200 BB MANIACs', M5, [200, 200, 200, 200, 200], N, 43, 100, DIFF],
    ['os:4', 'heads-up, a 300 BB MANIAC', ['MANIAC'], [300], 4 * N, 44, 100, DIFF],
    ['sq', 'five 40 BB MANIACs, the human 40 BB', M5, [40, 40, 40, 40, 40], 3 * N, 45, 40, DIFF],
    ['rsj', 'five 500 BB MANIACs, the human 40 BB', M5, [500, 500, 500, 500, 500], 3 * N, 46, 40, DIFF],
    ['rsjm', 'a 500 BB MANIAC + 100 BB TAG/LAG/NIT/FISH (hard), the human 100 BB', MPLUS, [500, 100, 100, 100, 100], RSJM_N, 47, 100, 'hard'],
    ['rsjm', 'MANIAC/TAG/LAG/NIT/FISH all 100 BB (hard), the human 100 BB', MPLUS, [100, 100, 100, 100, 100], RSJM_N, 48, 100, 'hard'],
    ['rsjma', 'two MANIACs + TAG/FISH/LAG all 100 BB (hard), the human 40 BB', ['MANIAC', 'MANIAC', 'TAG', 'FISH', 'LAG'], [100, 100, 100, 100, 100], RSJMA_N, 51, 40, 'hard'],
  ];
  it.each(CASES)('%s loses against %s', (line, _name, lineup, depths, hands, seed, heroBB, diff) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, depths, hands, seed, heroBB, diff);
    rows.push(`${line} vs ${_name}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < 0]).toEqual([line, hands, 0, true]);
  }, 1_200_000);   // synchronous and slow under load (rsj took up to 332 s in review, rsjma 423 s): a generous ceiling
});

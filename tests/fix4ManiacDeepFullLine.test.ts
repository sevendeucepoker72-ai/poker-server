/**
 * tests/fix4ManiacDeepFullLine.test.ts (2026-11-08, bots review fix round 4: HOLDEM-R3-REG-1, the whole line).
 * UNEQUAL stacks, the norm on the ring tables: bots have no stack cap and only grow, a human buys in for at
 * most 100 BB. A 100 BB human plays an ANY-TWO-CARDS line against a MANIAC 2-10x deeper than him; the bots play
 * every street through the real decideAction, applied as index.ts executeAIAction applies them, on a real
 * PokerTable. Stacks are reset every hand. The human check/folds after the flop. A pre-flop all-in of his that
 * is called is scored at its all-in equity on the pot he can win (sum of min(invested, his investment)), by a
 * seeded Monte Carlo over the board; chips are conserved.
 *   os:B       first in, raise to B BB; shove over any non-all-in re-raise; facing an all-in call QQ+/AK only.
 *   osrr:B:M   os:B, and facing exactly one raise 3-bet to M x the bet; shove over the 4-bet.
 *   tg:B:M     the deep MANIAC as the target: open B BB first in; 3-bet M x over a single raise only when a deep
 *              bot (>= 200 BB) made it; shove over a re-raise only when a deep bot made it; else fold.
 * On 0bc7529 the light re-raise cap was 5% of the MANIAC's OWN stack, so a deep MANIAC re-raised ~93% of hands
 * again and folded ~78% of them to the 100 BB shove (hard, BB/100): tg:4:3 +445, osrr:3:3 +172 vs a 1,000 BB
 * MANIAC + 100 BB TAG/LAG/NIT/FISH; os:2.5 +182 vs five 200 BB MANIACs; heads-up os:4 +66 vs a 300 BB MANIAC
 * (live 0dc1b96: -280 / -468 / -386 to -505 / -194). Deterministic: seeded Math.random, seeded deck
 * (crypto.randomBytes), frozen Date.now.
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
const BB = 100, HERO = 100;
/** 'medium' bots price post-flop without Monte Carlo (fast); the MANIAC pre-flop line is the same at every difficulty. */
const DIFF = process.env.FIX4_MDF_DIFF || 'medium';

/** BB/100 of the human (seat 0, 100 BB) over `hands` hands of `line` against `lineup` with `depths` (BB, seats 1..). */
function play(line: string, lineup: string[], depths: number[], hands: number, seed: number): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const [kind, b, m] = line.split(':');
    const open = Number(b) * BB, mult = Number(m || 3);
    const ns = lineup.length + 1;
    const start = [HERO * BB, ...depths.map((d) => d * BB)];
    const TOTAL = start.reduce((a, x) => a + x, 0);
    const t = new PokerTable({ tableId: 'mdf', tableName: 'mdf', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
    for (let i = 0; i < ns; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', start[i], (i ? 'ai-mdf-' : 'player-mdf-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => ({ botName: 'B' + (i + 1), difficulty: DIFF, personality: 'maniac', archetype: a, vpip: 0.5, pfr: 0.4, aggressionFactor: 4, bluffFrequency: 0.3 }))];
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
      if (raises === 0) { raised = true; if (!t.playerRaise(0, open)) { raised = false; fold(); } return; }
      if ((kind === 'osrr' || (kind === 'tg' && deepRaiser())) && raises === 1 && !facingAllIn) {
        raised = true; if (!t.playerRaise(0, Math.round(mult * t.currentBetToMatch / 50) * 50)) { raised = false; fold(); } return;
      }
      if (facingAllIn && premium(s0.holeCards)) { t.playerCall(0) || t.playerAllIn(0); return; }
      fold();
    };
    let ev: number | null = null;
    const dw = t.determineWinners.bind(t);
    t.determineWinners = (...args: any[]) => {
      const h0 = t.seats[0];
      if (h0.allIn && !h0.folded && t.communityCards.length === 5 && ev === null && (t as any).__allInPre) {
        const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length === 2);
        const used = new Set<number>(); for (const x of live) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!used.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let share = 0; const SIMS = 400;
        for (let i = 0; i < SIMS; i++) {
          for (let j = 0; j < 5; j++) { const k = j + Math.floor(mrnd() * (deck.length - j)); const z = deck[j]; deck[j] = deck[k]; deck[k] = z; }
          const ev2 = live.map((x: any) => HE.evaluateHand([...x.holeCards, ...deck.slice(0, 5)]));
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
      raised = false; ev = null; (t as any).__allInPre = false;
      expect(t.startNewHand()).toBe(true);
      let g = 0;
      while (t.isHandInProgress() && g++ < 300) {
        const a = t.activeSeatIndex; if (a < 0) break;
        if (a === 0) { hero(); if (t.seats[0].allIn && t.currentPhase === GamePhase.PreFlop) (t as any).__allInPre = true; continue; }
        if (t.seats[0].folded) { if (!t.playerFold(a)) t.playerCheck(a); continue; }   // the human's result is final
        const d = AI.decideAction(t, a, profs[a]);
        const ok = d.action === PlayerAction.Fold ? t.playerFold(a)
          : d.action === PlayerAction.Check ? (t.playerCheck(a) || t.playerFold(a))
            : d.action === PlayerAction.Call ? (t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
              : d.action === PlayerAction.Raise ? (t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a) || t.playerFold(a))
                : (t.playerAllIn(a) || t.playerFold(a));
        if (!ok) t.playerFold(a);
      }
      expect(t.isHandInProgress()).toBe(false);
      if (t.seats.reduce((q: number, x: any) => q + (x.state === 'occupied' ? x.chipCount : 0), 0) !== TOTAL) drift++;
      total += (ev ?? (t.seats[0].chipCount - start[0])) / BB; n++;
    }
    return { bb100: (100 * total) / n, drift, hands: n };
  } finally { restore(); }
}

describe('HOLDEM-R3-REG-1 — any two cards does not profit from a deep MANIAC\'s light re-raise (unequal stacks, whole line, real engine)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix4 deep MANIAC full line (BB/100): ${rows.join('; ')}\n`));
  const MPLUS = ['MANIAC', 'TAG', 'LAG', 'NIT', 'FISH'];
  const N = Number(process.env.FIX4_MDF_HANDS || 400);
  const CASES: Array<[string, string, string[], number[], number, number]> = [
    ['tg:4:3', 'a 1,000 BB MANIAC + 100 BB TAG/LAG/NIT/FISH', MPLUS, [1000, 100, 100, 100, 100], N, 41],
    ['osrr:3:3', 'a 1,000 BB MANIAC + 100 BB TAG/LAG/NIT/FISH', MPLUS, [1000, 100, 100, 100, 100], N, 42],
    ['os:2.5', 'five 200 BB MANIACs', ['MANIAC', 'MANIAC', 'MANIAC', 'MANIAC', 'MANIAC'], [200, 200, 200, 200, 200], N, 43],
    ['os:4', 'heads-up, a 300 BB MANIAC', ['MANIAC'], [300], 4 * N, 44],
  ];
  it.each(CASES)('%s loses against %s', (line, _name, lineup, depths, hands, seed) => {
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, depths, hands, seed);
    rows.push(`${line} vs ${_name}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < 0]).toEqual([line, hands, 0, true]);
  }, 300_000);
});

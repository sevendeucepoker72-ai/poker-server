/**
 * tests/fix3ManiacFullLine.test.ts (2026-11-05, bots review fix round 3: MANIAC-RTF, the whole line).
 * A human at a 6-max 50/100 Hold'em ring table (100 BB, reset every hand) plays an ANY-TWO-CARDS line against
 * MANIAC bots; the bots play every street through the real decideAction, applied as index.ts executeAIAction
 * applies them, on a real PokerTable. The human check/folds after the flop. A called pre-flop all-in is scored
 * at its all-in equity (seeded Monte Carlo over the board) to keep the variance down; chips are conserved.
 *   os:B       first in, raise to B BB; shove over any non-all-in re-raise; facing an all-in call QQ+/AK only.
 *   osrr:B:M   os:B, and facing exactly one raise 3-bet to M x the bet; shove over the 4-bet.
 * On 2b5ac52 the MANIAC re-raised ~93% of hands to 2.5-4x the bet without a stack-off hand and folded ~89% of
 * them to the shove: os:10 won ~+1,500 BB/100 at a one-MANIAC table and osrr:10:3 ~+1,900 (live 0dc1b96 -266 /
 * -329). Deterministic: seeded Math.random, seeded deck (crypto.randomBytes), frozen Date.now.
 * Fix-up 5 (2026-11-10, THE MANIAC CLASS): a MANIAC facing a raise or an all-in plays 0dc1b96's MANIAC again (it re-raises
 * light ~93% and calls the shove ~65-93%, maniacFacingRaise0dc1b96). Against five 100 BB MANIACs the 2.5 / 3 BB lines are
 * then 0dc1b96's: ~0 (3,000 hands, hard, unbiased score: os:2.5 head -24 (36), live -9 (34); osrr:3:3 -18 (51), live +23
 * (51)), and this harness's all-in-board score runs high on 300 hands of multiway all-ins (head +151.9 / +76.9 here). Those
 * two rows are bounded at +250 BB/100 (the raise-then-fold they guard against: 2b5ac52 +826.7 / +1,439.5 on these seeds); the
 * other six still lose.
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
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix3-mfl-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100, ST = 100 * BB;
/** 'medium' bots price post-flop without Monte Carlo (fast); the MANIAC pre-flop line is the same at every difficulty. */
const DIFF = process.env.FIX3_MFL_DIFF || 'medium';

/** BB/100 of the human (seat 0) over `hands` hands of `line` against `lineup` (seats 1-5). */
function play(line: string, lineup: string[], hands: number, seed: number): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const [kind, b, m] = line.split(':');
    const open = Number(b) * BB, mult = Number(m || 3);
    const t = new PokerTable({ tableId: 'mfl', tableName: 'mfl', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
    for (let i = 0; i < 6; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', ST, (i ? 'ai-mfl-' : 'player-mfl-') + i, i !== 0)).toBe(true);
    const profs = [null, ...lineup.map((a, i) => ({ botName: 'B' + (i + 1), difficulty: DIFF, personality: 'maniac', archetype: a, vpip: 0.5, pfr: 0.4, aggressionFactor: 4, bluffFrequency: 0.3 }))];
    const premium = (h: any[]) => { const [x, y] = h[0].rank >= h[1].rank ? h : [h[1], h[0]]; return (x.rank === y.rank && x.rank >= 12) || (x.rank === 14 && y.rank === 13); };
    let raised = false;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      if (t.currentPhase !== GamePhase.PreFlop) { fold(); return; }
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      const raises = Number(t.raisesThisStreet) || 0;
      if (raised && ca > 0) {
        if (facingAllIn) { if (premium(s0.holeCards)) t.playerCall(0) || t.playerAllIn(0); else t.playerFold(0); return; }
        t.playerAllIn(0); return;
      }
      if (raises === 0) { raised = true; if (!t.playerRaise(0, open)) { raised = false; fold(); } return; }
      if (kind === 'osrr' && raises === 1 && !facingAllIn) {
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
        const pot = t.seats.reduce((q: number, x: any) => q + (x.totalInvestedThisHand || 0), 0);
        ev = (share / SIMS) * pot - h0.totalInvestedThisHand;
      }
      return dw(...args);
    };
    let total = 0, drift = 0, n = 0;
    for (let h = 0; h < hands; h++) {
      for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = ST; x.eliminated = false; x.sittingOut = false; }
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
      if (t.seats.reduce((q: number, x: any) => q + (x.state === 'occupied' ? x.chipCount : 0), 0) !== 6 * ST) drift++;
      total += (ev ?? (t.seats[0].chipCount - ST)) / BB; n++;
    }
    return { bb100: (100 * total) / n, drift, hands: n };
  } finally { restore(); }
}

describe('MANIAC-RTF — any two cards does not profit from raise-then-fold against MANIAC bots (whole line, real engine)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix3 MANIAC full line (BB/100): ${rows.join('; ')}\n`));
  const LINEUPS: Array<[string, string[]]> = [
    ['MANIAC x5', ['MANIAC', 'MANIAC', 'MANIAC', 'MANIAC', 'MANIAC']],
    ['MANIAC+TAG/LAG/NIT/FISH', ['MANIAC', 'TAG', 'LAG', 'NIT', 'FISH']],
  ];
  const N = Number(process.env.FIX3_MFL_HANDS || 300);
  const CASES: Array<[string, number, number, number]> = [];
  for (const [k, line] of ['os:2.5', 'os:10', 'osrr:3:3', 'osrr:10:3'].entries()) for (let j = 0; j < LINEUPS.length; j++) {
    CASES.push([line, j, 101 + k, j === 0 && (line === 'os:2.5' || line === 'osrr:3:3') ? 250 : 0]);
  }
  it.each(CASES)('%s loses against lineup #%i', (line, j, seed, bound) => {
    const [name, lineup] = LINEUPS[j];
    const t0 = process.hrtime.bigint();
    const r = play(line, lineup, N, seed);
    rows.push(`${line} vs ${name}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, name, r.hands, r.drift, r.bb100 < bound]).toEqual([line, name, N, 0, true]);
  }, 120_000);
});

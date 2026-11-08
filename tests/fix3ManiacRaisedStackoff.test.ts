/**
 * tests/fix3ManiacRaisedStackoff.test.ts (2026-11-08, bots review fix round 3: MANIAC-RTF part 2).
 * No-limit: a MANIAC that has raised this street (its any-two open, an isolation raise over a limper, a light
 * 3-bet) and then faces a stack-off continues with MANIAC_RAISED_STACKOFF_WIDEN (2) x the stack-off width.
 * It raises ~93% of hands and the round-1 stack-off gate folded ~80-90% of those raises to a shove. Part 1
 * (HOLDEM_LIGHT_RERAISE_FRACTION) took the big light re-raises away, and a MANIAC then flat-called opens
 * instead: 3-handed at 25 BB (the Spin & Go start) a 25 BB squeeze with any two over a MANIAC open and a
 * MANIAC flat won ~+32 BB/100, and in Short Deck "limp, then shove over the isolation raise" ~+32 BB/100
 * (live 0dc1b96: -75 / -97). Real PokerTable / ShortDeckTable + real decideAction, seeded Math.random (the LCG
 * of tests/botPremiumHold.test.ts) and seeded crypto; the full-line block plays every street. The node bounds
 * bind: each one fails with the constant lowered 25% (1.5x), and on 2b5ac52.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PokerTable, PlayerAction, GamePhase } = require('../src/game/PokerTable');
const { ShortDeckTable } = require('../src/game/variants/ShortDeckTable');
const AI = require('../src/ai/AIPlayer');
const HE = require('../src/game/HandEvaluator');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix3-mrs-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const BB = 100;
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'aggressive', archetype, vpip: 0.6, pfr: 0.5, aggressionFactor: 5, bluffFrequency: 0.4 } as any);
let tableNo = 0;
/** Share of n random hands (not dealt elsewhere; Short Deck: 6-A) for which the bot at `me` continues (does not fold). */
function contRate(t: any, me: number, n: number, archetype = 'MANIAC', difficulty = 'hard', low = 2): number {
  const used = new Set<number>();
  for (const s of t.seats) if (s.seatIndex !== me) for (const c of s.holeCards || []) used.add(c.rank * 4 + c.suit);
  const ranks = 15 - low;
  let k = 0;
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0, ca: any, cb: any;
    do {
      a = Math.floor(Math.random() * ranks * 4); b = Math.floor(Math.random() * ranks * 4);
      ca = { rank: low + (a % ranks), suit: Math.floor(a / ranks) }; cb = { rank: low + (b % ranks), suit: Math.floor(b / ranks) };
    } while (a === b || used.has(ca.rank * 4 + ca.suit) || used.has(cb.rank * 4 + cb.suit));
    t.seats[me].holeCards = [ca, cb];
    if (AI.decideAction(t, me, prof(archetype, difficulty)).action !== PlayerAction.Fold) k++;
  }
  return k / n;
}
/** 6 seats at 50/100 (btn 0, sb 1, bb 2, utg 3, mp 4, co 5), every stack `stbb` BB; `human` sits seat 0. */
function six(stbb: number, Table: any = PokerTable): any {
  const t = new Table({ tableId: 'm', tableName: 'm', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stbb * BB, (i === 0 ? 'player-mrs-' : 'ai-mrs-') + id + '-' + i, i !== 0)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}

describe('MANIAC-RTF part 2 — a MANIAC that raised this street does not fold its raise to a shove at the stack-off width', () => {
  it('the constant is 2', () => {
    expect(AI.MANIAC_RAISED_STACKOFF_WIDEN).toBe(2);
  });

  it('100 BB: the MANIAC opened the CO, the button (a human) shoves, the blinds fold: it continues 21-30% (24%; 2b5ac52 12%, 1.5x 18%; live 0dc1b96 called ~91%, NEW-5)', () => {
    const restore = detEnv(4242);
    try {
      const t = six(100);
      for (const s of [3, 4]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerRaise(5, 250)).toBe(true);
      expect(t.playerAllIn(0)).toBe(true);
      for (const s of [1, 2]) expect(t.playerFold(s)).toBe(true);
      expect(t.activeSeatIndex).toBe(5);
      const r = contRate(t, 5, 600);
      expect(r).toBeGreaterThanOrEqual(0.21);
      expect(r).toBeLessThanOrEqual(0.30);
    } finally { restore(); }
  });

  it('control: a MANIAC that did not raise (the big blind facing a lone 100 BB shove) keeps the stack-off width (<= 13%; 8.5% on every tree)', () => {
    const restore = detEnv(4243);
    try {
      const t = six(100);
      for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.playerFold(1)).toBe(true);
      expect(t.activeSeatIndex).toBe(2);
      expect(contRate(t, 2, 600)).toBeLessThanOrEqual(0.13);
    } finally { restore(); }
  });

  it('3-handed 25 BB (the Spin & Go start): the button MANIAC opened, the small blind MANIAC flatted, the big blind (a human) shoves 25 BB: the opener continues >= 28.5% (30.5%; 2b5ac52 16.8%, 1.5x 26%)', () => {
    const restore = detEnv(4244);
    try {
      const t = new PokerTable({ tableId: 'm3', tableName: 'm3', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
      for (let i = 0; i < 3; i++) expect(t.sitDown(i, 'P' + i, 25 * BB, (i === 2 ? 'player-mrs3-' : 'ai-mrs3-') + i, i !== 2)).toBe(true);
      expect(t.startNewHand()).toBe(true);
      // 3-handed, button seat 0 acts first pre-flop, then the small blind (1), then the big blind (2).
      expect(t.activeSeatIndex).toBe(0);
      expect(t.playerRaise(0, 250)).toBe(true);
      expect(t.playerCall(1)).toBe(true);
      expect(t.playerAllIn(2)).toBe(true);
      expect(t.activeSeatIndex).toBe(0);
      expect(contRate(t, 0, 600)).toBeGreaterThanOrEqual(0.285);
    } finally { restore(); }
  });

  it('Short Deck 100 BB: the MANIAC isolated a limper (a human), who then shoves: it continues >= 17% (20.5%; 2b5ac52 9.5%, 1.5x 14%)', () => {
    const restore = detEnv(4245);
    try {
      const t = six(100, ShortDeckTable);
      for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerCall(0)).toBe(true);   // the button (human) limps
      expect(t.playerRaise(1, 400)).toBe(true);   // the small-blind MANIAC isolates to 4 BB
      expect(t.playerFold(2)).toBe(true);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      expect(contRate(t, 1, 600, 'MANIAC', 'hard', 6)).toBeGreaterThanOrEqual(0.17);
    } finally { restore(); }
  });
});

/** BB/100 of the human (seat 0) over `hands` hands of a line, 3-handed (2 MANIAC bots), every stack 25 BB each hand. */
function play3(line: string, hands: number, seed: number): { bb100: number; drift: number; hands: number } {
  const restore = detEnv(seed);
  let ms = (seed * 7919 + 17) >>> 0;
  const mrnd = () => ((ms = (Math.imul(ms, 1103515245) + 12345) >>> 0) / 4294967296);
  try {
    const ST = 25 * BB;
    const t = new PokerTable({ tableId: 'mrs-fl', tableName: 'mrs-fl', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB });
    for (let i = 0; i < 3; i++) expect(t.sitDown(i, i ? 'B' + i : 'Hero', ST, (i ? 'ai-mrs-fl-' : 'player-mrs-fl-') + i, i !== 0)).toBe(true);
    const profs = [null, prof('MANIAC', 'medium'), prof('MANIAC', 'medium')];
    const premium = (h: any[]) => { const [x, y] = h[0].rank >= h[1].rank ? h : [h[1], h[0]]; return (x.rank === y.rank && x.rank >= 12) || (x.rank === 14 && y.rank === 13); };
    const [kind, b] = line.split(':');
    let raised = false;
    const hero = (): void => {
      const s0 = t.seats[0], ca = t.getCallAmount(s0);
      const fold = () => (ca > 0 ? t.playerFold(0) : (t.playerCheck(0) || t.playerFold(0)));
      if (t.currentPhase !== GamePhase.PreFlop) { fold(); return; }
      const facingAllIn = t.seats.some((x: any) => x.seatIndex !== 0 && x.state === 'occupied' && !x.folded && x.allIn && x.currentBet > s0.currentBet);
      const raises = Number(t.raisesThisStreet) || 0;
      if (facingAllIn && ca > 0) { if (premium(s0.holeCards)) t.playerCall(0) || t.playerAllIn(0); else t.playerFold(0); return; }
      if (kind === 'rsj') { if (raises === 1 && !raised) { raised = true; t.playerAllIn(0); return; } fold(); return; }
      // os:B — open B BB first in, shove over any non-all-in re-raise.
      if (raised && ca > 0) { t.playerAllIn(0); return; }
      if (raises === 0) { raised = true; if (!t.playerRaise(0, Number(b) * BB)) { raised = false; fold(); } return; }
      fold();
    };
    let ev: number | null = null, allInPre = false;
    const dw = t.determineWinners.bind(t);
    t.determineWinners = (...args: any[]) => {
      const h0 = t.seats[0];
      if (h0.allIn && !h0.folded && allInPre && ev === null) {
        const live = t.seats.filter((x: any) => x.state === 'occupied' && !x.folded && x.holeCards.length === 2);
        const used = new Set<number>(); for (const x of live) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
        const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) if (!used.has(r * 4 + su)) deck.push({ rank: r, suit: su });
        let share = 0; const SIMS = 300;
        for (let i = 0; i < SIMS; i++) {
          for (let j = 0; j < 5; j++) { const k = j + Math.floor(mrnd() * (deck.length - j)); const z = deck[j]; deck[j] = deck[k]; deck[k] = z; }
          const e = live.map((x: any) => HE.evaluateHand([...x.holeCards, ...deck.slice(0, 5)]));
          let best = [0];
          for (let k = 1; k < e.length; k++) { const c = HE.compareTo(e[k], e[best[0]]); if (c > 0) best = [k]; else if (c === 0) best.push(k); }
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
      raised = false; ev = null; allInPre = false;
      expect(t.startNewHand()).toBe(true);
      let g = 0;
      while (t.isHandInProgress() && g++ < 300) {
        const a = t.activeSeatIndex; if (a < 0) break;
        if (a === 0) { hero(); if (t.seats[0].allIn && t.currentPhase === GamePhase.PreFlop) allInPre = true; continue; }
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
      if (t.seats.reduce((q: number, x: any) => q + (x.state === 'occupied' ? x.chipCount : 0), 0) !== 3 * ST) drift++;
      total += (ev ?? (t.seats[0].chipCount - ST)) / BB; n++;
    }
    return { bb100: (100 * total) / n, drift, hands: n };
  } finally { restore(); }
}

describe('MANIAC-RTF parts 1 + 2 — 3-handed 25 BB against two MANIACs, any two cards loses (whole line, real engine)', () => {
  const rows: string[] = [];
  afterAll(() => process.stdout.write(`fix3 MANIAC 3-handed 25 BB (BB/100): ${rows.join('; ')}\n`));
  const N = Number(process.env.FIX3_MRS_HANDS || 1000);
  // os:2.5 (open, shove over the re-raise): 2b5ac52 +118 BB/100 here (light 3-bets folded to the shove).
  // rsj (a 25 BB squeeze / re-shove over a single open): +34 with part 1 alone (the MANIAC flatted instead).
  // This tree: -158 / -35 (1,000 medium hands each, seeds 211 / 212).
  it.each([['os:2.5', 211], ['rsj', 212]])('%s loses', (line, seed) => {
    const t0 = process.hrtime.bigint();
    const r = play3(line as string, N, seed as number);
    rows.push(`${line}: ${r.bb100.toFixed(1)} (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    expect([line, r.hands, r.drift, r.bb100 < 0]).toEqual([line, N, 0, true]);
  }, 120_000);
});

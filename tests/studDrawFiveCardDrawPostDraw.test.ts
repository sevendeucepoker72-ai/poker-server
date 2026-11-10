/**
 * tests/studDrawFiveCardDrawPostDraw.test.ts (2026-11 bots review, fix round 4, studdraw fix-ups 3 and 4).
 * Five Card Draw no-limit AFTER the draw (postFlopStrategy behind studDrawKindOfTable), through the real decideAction:
 *  1. a MANIAC's check is not a capped range: with seats behind it, it traps a share of its kings or better
 *     (FIVE_DRAW_POST_MANIAC_MIX; STUDDRAW-RR2-EXPLOIT-1);
 *  2. a MANIAC's bet is not a range that folds most of itself to an all-in over it: it never bets a lower pair, and
 *     checked to by every seat it bets every king or better and half its no-pair hands (FIVE_DRAW_POST_MANIAC_LAST;
 *     fix-up 4, STUDDRAW-F3-MEASUREMENT-1 / F3-EXPLOIT-1 / F3-REGRESSION-1);
 *  3. the call-site wiring of fiveDrawPostFolds' `checked` and `raised` arguments (STUDDRAW-R4RR-REGRESSION-3), and
 *     fiveDrawPostShoveLike (a bet that leaves its maker all but a chip);
 *  4. a short bot whose capped lead is under the minimum bet leads its whole stack (STUDDRAW-R4RR-REGRESSION-2).
 * Real tables, deterministic (seeded Math.random, frozen Date.now, seeded deck).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction, GamePhase } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`postdraw-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const cfg = () => ({ tableId: 'postdraw', tableName: 'postdraw', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 });
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const prof = (a: string, diff: string) => ({ ...AI.generateRandomProfile(diff), archetype: a, difficulty: diff });
const same = (a: any, b: any) => a.rank === b.rank && a.suit === b.suit;
const DRAW = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const bets = (d: any) => d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn;

/** Gives seat `me` the cards `cards` (a seat that held one of them takes one of the bot's own cards instead). */
function plant(t: any, me: number, cards: any[]): void {
  const spare = t.seats[me].holeCards.filter((c: any) => !cards.some((y: any) => same(y, c)));
  for (const x of t.seats) if (x.seatIndex !== me) x.holeCards = x.holeCards.map((c: any) => (cards.some((y: any) => same(y, c)) ? spare.pop() : c));
  t.seats[me].holeCards = cards.map((c) => ({ ...c }));
  const all = t.seats.flatMap((x: any) => x.holeCards);
  expect(all.every((c: any, i: number) => c && !all.some((d: any, j: number) => j !== i && same(c, d)))).toBe(true);
}

/** Every seat still to draw stands pat. */
function standPat(t: any): void {
  let g = 0;
  while (DRAW.includes(t.currentPhase) && g++ < 10) for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) { t.playerDraw(x.seatIndex, []); if (!DRAW.includes(t.currentPhase)) break; }
}

/**
 * Five Card Draw, 5 seats at 25/50: seat 0 a human with 100 BB opens to 3 BB; the first bot to act calls (it has
 * `botBehindBB` BB left behind), the rest fold. Both stand pat; after the draw the human checks when he is first, and
 * the bot (nothing to call) holds `cards`. null when the deal does not take that shape.
 */
function shortBotLead(cards: any[], botBehindBB: number): { t: any; me: number } | null {
  const t = new FiveCardDrawTable(cfg(), false);
  for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-postdraw-' : 'ai-postdraw-') + i, i !== 0);
  for (let i = 1; i < 5; i++) t.seats[i].chipCount = 150 + botBehindBB * 50;
  if (!t.startNewHand()) return null;
  let g = 0, opened = false;
  while (t.currentPhase === GamePhase.PreFlop && g++ < 30) {
    const a = t.activeSeatIndex; if (a < 0) return null;
    if (a === 0 && !opened) { if (!t.playerRaise(0, 150)) return null; opened = true; continue; }
    if (a !== 0 && t.seats.some((x: any) => x.seatIndex !== 0 && !x.folded && x.currentBet >= 150)) { t.playerFold(a); continue; }
    if (!t.playerCall(a)) t.playerCheck(a);
  }
  if (!opened) return null;
  standPat(t);
  if (t.currentPhase === GamePhase.Bet2 && t.activeSeatIndex === 0) t.playerCheck(0);
  if (t.currentPhase !== GamePhase.Bet2) return null;
  const me = t.activeSeatIndex;
  if (me <= 0 || t.getCallAmount(t.seats[me]) !== 0 || t.seats[me].chipCount !== botBehindBB * 50) return null;
  plant(t, me, cards);
  return { t, me };
}

/**
 * Heads-up Five Card Draw at 25/50: a human with `heroBB` BB and a bot with 100 BB, the bot in seat 1 or seat 0 (whichever
 * makes the bot first to act after the draw when `botFirst`, the human otherwise). The first round is raised to
 * `potBB` / 2 BB and called, both stand pat; null unless the pot is `potBB` BB after the draw. The bot then holds `cards`.
 */
function huAfterDraw(cards: any[], heroBB: number, botFirst: boolean, potBB = 40): { t: any; bot: number; hero: number } | null {
  for (const bot of [1, 0]) {
    const hero = 1 - bot;
    const t = new FiveCardDrawTable(cfg(), false);
    t.sitDown(bot, 'Bot', 5000, 'ai-postdraw-hu', true); t.sitDown(hero, 'Hero', 5000, 'human-postdraw-hu', false);
    t.seats[hero].chipCount = heroBB * 50;
    if (!t.startNewHand()) return null;
    let g = 0, raised = false;
    while (t.currentPhase === GamePhase.PreFlop && g++ < 10) {
      const a = t.activeSeatIndex; if (a < 0) return null;
      if (!raised) { if (!t.playerRaise(a, (potBB / 2) * 50)) return null; raised = true; continue; }
      if (!t.playerCall(a)) t.playerCheck(a);
    }
    standPat(t);
    if (t.currentPhase !== GamePhase.Bet2 || t.getTotalPot() !== potBB * 50) return null;
    if (t.activeSeatIndex !== (botFirst ? bot : hero)) continue;
    plant(t, bot, cards);
    return { t, bot, hero };
  }
  return null;
}

/**
 * Five Card Draw, 5 seats at 25/50: a human with 100 BB opens to 5 BB, every bot calls, all stand pat. After the draw:
 * 'first' — the first seat to act is a bot (four seats behind it); 'last' — every seat checks until the last one, a bot
 * (every other seat has checked to it; the human sits where that holds). That bot (nothing to call) holds `cards`.
 * null otherwise.
 */
function multiwayPostDraw(cards: any[], spot: 'first' | 'last'): { t: any; me: number } | null {
  for (const human of spot === 'first' ? [0] : [1, 2, 3, 4, 0]) {
    const t = new FiveCardDrawTable(cfg(), false);
    for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, (i === human ? 'human-postdraw-' : 'ai-postdraw-') + i, i !== human);
    if (!t.startNewHand()) return null;
    let g = 0, opened = false;
    while (t.currentPhase === GamePhase.PreFlop && g++ < 30) {
      const a = t.activeSeatIndex; if (a < 0) return null;
      if (a === human && !opened) { if (!t.playerRaise(human, 250)) return null; opened = true; continue; }
      if (!t.playerCall(a)) t.playerCheck(a);
    }
    if (!opened) return null;
    standPat(t);
    if (t.currentPhase !== GamePhase.Bet2 || t.seats.some((x: any) => x.folded)) return null;
    if (spot === 'last') { g = 0; while (t.currentPhase === GamePhase.Bet2 && g++ < 4) if (!t.playerCheck(t.activeSeatIndex)) return null; }
    if (t.currentPhase !== GamePhase.Bet2) return null;
    const me = t.activeSeatIndex;
    if (me < 0 || me === human || t.getCallAmount(t.seats[me]) !== 0) continue;
    const checked = t.actionLog.filter((e: any) => e.street === GamePhase.Bet2 && e.action === 'checked').length;
    if (checked !== (spot === 'last' ? 4 : 0)) continue;
    plant(t, me, cards);
    return { t, me };
  }
  return null;
}

const MANIAC_GROUPS: Record<string, string[]> = {
  low: ['Qh Qd 9c 5s 2h', '7h 7d Ac 9s 4h'], air: ['Ah Kd 9c 7s 3h', 'Kh Qd 9c 6s 2h'],
  kings: ['Kh Kd Ac 9s 4h', 'Ah Ad Qc 9s 4h'], twoPairUp: ['Ah Ad Kc Ks 3h', '9h 9d 5c 5s Kh', '2h 2d 2c 7s 3h', '8h 8d 8c 4s 4h'],
};
function maniacLeads(seed: number, spot: 'first' | 'last', per: number): Record<string, { bets: number; n: number }> {
  const restore = detEnv(seed);
  try {
    const st: Record<string, { bets: number; n: number }> = {};
    for (const g of Object.keys(MANIAC_GROUPS)) for (const h of MANIAC_GROUPS[g]) for (const diff of DIFFS) {
      st[g] = st[g] || { bets: 0, n: 0 };
      for (let k = 0, got = 0; got < per && k < per * 40; k++) {
        const r = multiwayPostDraw(C(h), spot); if (!r) continue; got++; st[g].n++;
        if (bets(AI.decideAction(r.t, r.me, prof('MANIAC', diff)))) st[g].bets++;
      }
    }
    return st;
  } finally { restore(); }
}
const fmt = (st: Record<string, { bets: number; n: number }>) => Object.keys(st).map((k) => `${k} ${st[k].bets}/${st[k].n}`).join(', ');

/** How often each class comes after the draw (the bots' own discard rule on random deals; scratch cls3 Monte Carlo): two pair or better, K-K / A-A, a lower pair, no pair. */
const CLASS_W: Record<string, number> = { twoPairUp: 0.24, kings: 0.11, low: 0.39, air: 0.26 };

/**
 * Heads-up after the draw (40 BB pot, 80 BB behind each): the MANIAC acts first (`botFirst`) or the human checks to it.
 * Per class (MANIAC_GROUPS): how often it bets, at what sizes, and, when it bets, whether it continues against the
 * human's all-in over the bet; `cont` = the share of its bets that continue, weighted by CLASS_W.
 */
function huBetThenShove(seed: number, botFirst: boolean, per: number): { st: Record<string, { bets: number; n: number; faced: number; cont: number }>; sizes: Set<number>; cont: number } {
  const restore = detEnv(seed);
  try {
    const st: Record<string, { bets: number; n: number; faced: number; cont: number }> = {};
    const sizes = new Set<number>();
    for (const g of Object.keys(MANIAC_GROUPS)) for (const h of MANIAC_GROUPS[g]) for (const diff of DIFFS) {
      st[g] = st[g] || { bets: 0, n: 0, faced: 0, cont: 0 };
      for (let k = 0, got = 0; got < per && k < per * 40; k++) {
        const r = huAfterDraw(C(h), 100, botFirst); if (!r) continue;
        const { t, bot, hero } = r;
        if (!botFirst && (!t.playerCheck(hero) || t.activeSeatIndex !== bot)) continue;
        got++; st[g].n++;
        const p = prof('MANIAC', diff);
        const d = AI.decideAction(t, bot, p);
        if (!bets(d)) continue;
        st[g].bets++;
        if (!(d.action === PlayerAction.AllIn ? t.playerAllIn(bot) : t.playerRaise(bot, d.raiseAmount))) continue;
        sizes.add(t.seats[bot].currentBet);
        if (t.seats[bot].allIn || !t.playerAllIn(hero) || t.activeSeatIndex !== bot) continue;
        st[g].faced++;
        if (AI.decideAction(t, bot, p).action !== PlayerAction.Fold) st[g].cont++;
      }
    }
    let num = 0, den = 0;
    for (const g of Object.keys(st)) { const b = CLASS_W[g] * st[g].bets / st[g].n; den += b; num += b * (st[g].faced ? st[g].cont / st[g].faced : 0); }
    return { st, sizes, cont: den > 0 ? num / den : 0 };
  } finally { restore(); }
}
const fmt2 = (st: Record<string, { bets: number; n: number; faced: number; cont: number }>) => Object.keys(st).map((k) => `${k} ${st[k].bets}/${st[k].n} (vs all-in ${st[k].cont}/${st[k].faced})`).join(', ');

describe('fix-up 3 (STUDDRAW-RR2-EXPLOIT-1 / R4RR-REGRESSION-1): Five Card Draw after the draw, a MANIAC\'s check is not a capped range', () => {
  it('a 5-way pot, the MANIAC first to act (four seats behind it): it checks some of its two pair or better and some of its kings or aces, and leads no lower pair (280dc09: every K-K or better led, so a check never held two pair or K-K; fix-up 4: fix-up 3 led half the lower pairs, a bet that folds to an all-in over it)', () => {
    const st = maniacLeads(5331, 'first', 3);
    process.stdout.write(`MANIAC first to act, leads: ${fmt(st)}\n`);
    expect([st.low.n, st.air.n, st.kings.n, st.twoPairUp.n]).toEqual([24, 24, 24, 48]);
    expect(st.twoPairUp.n - st.twoPairUp.bets).toBeGreaterThanOrEqual(5);   // checks with two pair or better
    expect(st.kings.n - st.kings.bets).toBeGreaterThanOrEqual(2);           // checks with K-K / A-A
    expect(st.twoPairUp.bets / st.twoPairUp.n).toBeGreaterThanOrEqual(0.5); // still leads most of them
    expect(st.low.bets).toBe(0);
    expect(st.air.bets / st.air.n).toBeGreaterThanOrEqual(0.1);
    expect(st.air.bets / st.air.n).toBeLessThanOrEqual(0.65);
  }, 300_000);

  it('the same pot with every other seat checked to the MANIAC (it acts last): it bets every K-K or better and two pair or better (nobody is left to act: no traps), about half its no-pair hands and no lower pair (fix-up 4; 89ee502 bet every hand there, and every one pair folded to an all-in over the bet)', () => {
    const st = maniacLeads(5332, 'last', 2);
    process.stdout.write(`MANIAC checked to by every seat, leads: ${fmt(st)}\n`);
    expect([st.low.n, st.air.n, st.kings.n, st.twoPairUp.n]).toEqual([16, 16, 16, 32]);
    expect([st.kings.bets / st.kings.n >= 0.9, st.twoPairUp.bets / st.twoPairUp.n >= 0.9]).toEqual([true, true]);
    expect(st.low.bets).toBe(0);
    expect(st.air.bets / st.air.n).toBeGreaterThanOrEqual(0.2);
    expect(st.air.bets / st.air.n).toBeLessThanOrEqual(0.8);
  }, 300_000);

  it('the MANIAC lead mix and its checked-to-last bet are pinned', () => {
    expect([...AI.FIVE_DRAW_POST_MANIAC_MIX]).toEqual([0, 0.3]);
    expect([...AI.FIVE_DRAW_POST_MANIAC_LAST]).toEqual([0, 0.5]);
  });
});

describe('fix-up 4 (STUDDRAW-F3-MEASUREMENT-1 / F3-EXPLOIT-1 / F3-REGRESSION-1): Five Card Draw after the draw, a MANIAC\'s bet is not a range that folds most of itself to an all-in over it', () => {
  it('heads-up, 40 BB pot, 80 BB behind, the human checks to the MANIAC: it bets every K-K or better at one size but only a share of the rest, so at least 40% of its bets (weighted by how often each class comes) continue against an all-in over them (89ee502 bet every hand and folded all but two pair or better: 24%; checking every hand and shoving any hand over that bet won +249 BB/100 vs MANIAC x4, 280dc09 -102, live 0dc1b96 -388)', () => {
    const r = huBetThenShove(5401, false, 3);
    process.stdout.write(`HU MANIAC checked to: ${fmt2(r.st)}; weighted continue ${r.cont.toFixed(3)}; sizes ${[...r.sizes].join(' ')}\n`);
    expect([r.st.low.n, r.st.air.n, r.st.kings.n, r.st.twoPairUp.n]).toEqual([24, 24, 24, 48]);
    expect([r.st.kings.bets / r.st.kings.n >= 0.9, r.st.twoPairUp.bets / r.st.twoPairUp.n >= 0.9]).toEqual([true, true]);   // nobody is left to act: no traps
    expect(r.st.twoPairUp.cont).toBe(r.st.twoPairUp.faced);
    expect(r.sizes.size).toBe(1);   // one size for every hand
    expect(r.cont).toBeGreaterThanOrEqual(0.4);
  }, 300_000);

  it('heads-up, the MANIAC first to act (the human behind it): it leads no pair under K-K, traps a share of its K-K or better, and at least 40% of its leads (weighted) continue against an all-in over them (89ee502 led half its lower pairs too: about 32%)', () => {
    const r = huBetThenShove(5402, true, 3);
    process.stdout.write(`HU MANIAC first to act: ${fmt2(r.st)}; weighted continue ${r.cont.toFixed(3)}; sizes ${[...r.sizes].join(' ')}\n`);
    expect([r.st.low.n, r.st.air.n, r.st.kings.n, r.st.twoPairUp.n]).toEqual([24, 24, 24, 48]);
    expect(r.st.low.bets).toBe(0);
    expect(r.st.twoPairUp.n - r.st.twoPairUp.bets).toBeGreaterThanOrEqual(5);   // traps
    expect(r.st.kings.n - r.st.kings.bets).toBeGreaterThanOrEqual(2);
    expect(r.st.twoPairUp.cont).toBe(r.st.twoPairUp.faced);
    expect(r.sizes.size).toBe(1);
    expect(r.cont).toBeGreaterThanOrEqual(0.4);
  }, 300_000);
});

describe('fix-up 3 (STUDDRAW-R4RR-REGRESSION-3): the call site passes fiveDrawPostFolds whether the bot checked and whether it has chips in', () => {
  it('heads-up after the draw, 40 BB pot, 80 BB behind, the human bets 0.75 pot: a MANIAC that CHECKED continues with T-T (its checked range reads the price FIVE_DRAW_POST_CHECKED_PO lower), one that has not acted folds it to the gate', () => {
    const restore = detEnv(5311);
    try {
      const res: Record<string, { cont: number; n: number }> = { checked: { cont: 0, n: 0 }, first: { cont: 0, n: 0 } };
      for (const spot of ['checked', 'first']) for (const diff of DIFFS) for (let k = 0, got = 0; got < 3 && k < 60; k++) {
        const r = huAfterDraw(C('Th Td Kc 8s 4h'), 100, spot === 'checked'); if (!r) continue;
        const { t, bot, hero } = r;
        if (spot === 'checked' && !t.playerCheck(bot)) continue;
        if (!t.playerRaise(hero, 1500) || t.activeSeatIndex !== bot) continue;
        got++; res[spot].n++;
        if (AI.decideAction(t, bot, prof('MANIAC', diff)).action !== PlayerAction.Fold) res[spot].cont++;
      }
      process.stdout.write(`MANIAC T-T vs a 0.75-pot bet: checked ${res.checked.cont}/${res.checked.n}, not acted ${res.first.cont}/${res.first.n}\n`);
      expect([res.checked.n, res.first.n]).toEqual([12, 12]);
      expect(res.checked.cont).toBeGreaterThanOrEqual(10);   // the strategy itself may still fold it
      expect(res.first.cont).toBe(0);
    } finally { restore(); }
  }, 300_000);

  it('heads-up after the draw, 40 BB pot: a bot\'s capped lead (0.3 of 80 BB) shoved over at a price of 0.28 folds A-A / K-K one pair (the all-in raises chips it already put in), while a 25.5 BB shove at about the same price after its check keeps the all-in ramp and is called (MANIAC / LAG)', () => {
    const restore = detEnv(5312);
    try {
      const res: Record<string, { cont: number; n: number; po: number }> = { lead: { cont: 0, n: 0, po: 0 }, check: { cont: 0, n: 0, po: 0 } };
      for (const spot of ['lead', 'check']) for (const a of ['MANIAC', 'LAG']) for (const h of ['Ah Ad Kc 8s 4h', 'Kh Kd Qc 8s 4h']) {
        for (const diff of DIFFS) for (let k = 0, got = 0; got < 2 && k < 60; k++) {
          const r = huAfterDraw(C(h), spot === 'lead' ? 100 : 45.5, true); if (!r) continue;
          const { t, bot, hero } = r;
          if (spot === 'lead' ? !t.playerRaise(bot, 1200) : !t.playerCheck(bot)) continue;
          if (!t.playerAllIn(hero) || t.activeSeatIndex !== bot) continue;
          got++; res[spot].n++;
          const call = t.getCallAmount(t.seats[bot]); res[spot].po = Math.max(res[spot].po, call / (t.getTotalPot() + call));
          if (AI.decideAction(t, bot, prof(a, diff)).action !== PlayerAction.Fold) res[spot].cont++;
        }
      }
      process.stdout.write(`A-A / K-K vs a shove: over its own lead ${res.lead.cont}/${res.lead.n} (po ${res.lead.po.toFixed(3)}), after its check ${res.check.cont}/${res.check.n} (po ${res.check.po.toFixed(3)})\n`);
      expect([res.lead.n, res.check.n]).toEqual([32, 32]);
      expect([res.lead.po > 0.25 && res.lead.po < 0.36, res.check.po > 0.25 && res.check.po < 0.36]).toEqual([true, true]);
      expect(res.lead.cont).toBe(0);
      expect(res.check.cont).toBeGreaterThanOrEqual(24);
    } finally { restore(); }
  }, 300_000);
});

describe('fix-up 3 (re-review note): a bet that leaves its maker all but a chip is priced as the all-in it is (fiveDrawPostShoveLike)', () => {
  it('heads-up after the draw, 40 BB pot, the human bets 30 BB first: with 1 BB left behind a TAG / LAG calls A-A / J-J on the all-in ramp; with 10 BB left behind (a bet) it folds them to the gate (two pair from a price of 0.30)', () => {
    const restore = detEnv(5321);
    try {
      const res: Record<string, { cont: number; n: number }> = { allButAChip: { cont: 0, n: 0 }, bet: { cont: 0, n: 0 } };
      for (const spot of ['allButAChip', 'bet']) for (const a of ['TAG', 'LAG']) for (const h of ['Ah Ad Kc 8s 4h', 'Jh Jd Kc 8s 4h']) {
        for (const diff of DIFFS) for (let k = 0, got = 0; got < 2 && k < 60; k++) {
          const r = huAfterDraw(C(h), spot === 'allButAChip' ? 51 : 60, false); if (!r) continue;
          const { t, bot, hero } = r;
          if (!t.playerRaise(hero, 1500) || t.activeSeatIndex !== bot) continue;
          expect(t.seats[hero].chipCount).toBe(spot === 'allButAChip' ? 50 : 500);
          got++; res[spot].n++;
          if (AI.decideAction(t, bot, prof(a, diff)).action !== PlayerAction.Fold) res[spot].cont++;
        }
      }
      process.stdout.write(`A-A / J-J vs a 30 BB bet into 40 BB: maker 1 BB behind ${res.allButAChip.cont}/${res.allButAChip.n}, 10 BB behind ${res.bet.cont}/${res.bet.n}\n`);
      expect([res.allButAChip.n, res.bet.n]).toEqual([32, 32]);
      expect(res.allButAChip.cont).toBeGreaterThanOrEqual(28);
      expect(res.bet.cont).toBe(0);
    } finally { restore(); }
  }, 300_000);
});

describe('fix-up 3 (STUDDRAW-R4RR-REGRESSION-2): Five Card Draw after the draw, a short bot still leads', () => {
  it('a bot with 2 BB behind, checked to or first: a TAG (and a MANIAC, less its trap share) leads a full house with its whole stack (280dc09: the lead cap was under the minimum bet, so it checked, 0 of 54; live 0dc1b96 MANIAC 9 of 9, TAG 7 of 9)', () => {
    const restore = detEnv(5301);
    try {
      const out: string[] = []; let n = 0, b = 0, allIn = 0; const by: Record<string, number> = { MANIAC: 0, TAG: 0 };
      for (const a of ['MANIAC', 'TAG']) for (const h of ['Kh Kd Kc 3s 3h', 'Kh Kd Kc 7s 7h']) {
        let m = 0, c = 0;
        for (const diff of DIFFS) for (let k = 0, got = 0; got < 3 && k < 40; k++) {
          const r = shortBotLead(C(h), 2); if (!r) continue; got++; m++;
          const d = AI.decideAction(r.t, r.me, prof(a, diff));
          if (bets(d)) { c++; if (d.action === PlayerAction.AllIn) allIn++; }
        }
        out.push(`${a} ${h} ${c}/${m}`); n += m; b += c; by[a] += c;
      }
      process.stdout.write(`short bot (2 BB behind) leads: ${out.join(', ')}\n`);
      expect(n).toBe(2 * 2 * 4 * 3);
      expect(by.TAG).toBeGreaterThanOrEqual(22);      // of 24
      expect(by.MANIAC).toBeGreaterThanOrEqual(10);   // of 24: with seats behind it a MANIAC traps a share (FIVE_DRAW_POST_MANIAC_MIX)
      expect(allIn).toBe(b);   // one size: the whole short stack
    } finally { restore(); }
  }, 300_000);
});

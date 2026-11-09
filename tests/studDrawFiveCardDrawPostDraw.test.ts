/**
 * tests/studDrawFiveCardDrawPostDraw.test.ts (2026-11 bots review, fix round 4, studdraw fix-up 3).
 * Five Card Draw no-limit AFTER the draw (postFlopStrategy behind studDrawKindOfTable), through the real decideAction:
 *  1. a MANIAC's check is not a capped range: with seats behind it, it traps a share of its kings or better and leads
 *     a share of its lower pairs (FIVE_DRAW_POST_MANIAC_MIX); checked to by every seat it bets every hand
 *     (STUDDRAW-RR2-EXPLOIT-1 / R4RR-REGRESSION-1);
 *  2. a short bot whose capped lead is under the minimum bet leads its whole stack (STUDDRAW-R4RR-REGRESSION-2).
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

describe('fix-up 3 (STUDDRAW-RR2-EXPLOIT-1 / R4RR-REGRESSION-1): Five Card Draw after the draw, a MANIAC\'s check is not a capped range', () => {
  it('a 5-way pot, the MANIAC first to act (four seats behind it): it checks some of its two pair or better and some of its kings or aces, and leads some of its lower pairs (280dc09: every K-K or better led, every pair under K-K checked, so a check never held two pair or K-K)', () => {
    const st = maniacLeads(5331, 'first', 3);
    process.stdout.write(`MANIAC first to act, leads: ${fmt(st)}\n`);
    expect([st.low.n, st.air.n, st.kings.n, st.twoPairUp.n]).toEqual([24, 24, 24, 48]);
    expect(st.twoPairUp.n - st.twoPairUp.bets).toBeGreaterThanOrEqual(5);   // checks with two pair or better
    expect(st.kings.n - st.kings.bets).toBeGreaterThanOrEqual(2);           // checks with K-K / A-A
    expect(st.twoPairUp.bets / st.twoPairUp.n).toBeGreaterThanOrEqual(0.5); // still leads most of them
    expect(st.low.bets).toBeGreaterThanOrEqual(5);                          // leads some lower pairs
    expect(st.low.bets / st.low.n).toBeLessThanOrEqual(0.75);
    expect(st.air.bets / st.air.n).toBeGreaterThanOrEqual(0.25);
    expect(st.air.bets / st.air.n).toBeLessThanOrEqual(0.75);
  }, 300_000);

  it('the same pot with every other seat checked to the MANIAC (it acts last): it bets every class, as the core MANIAC does (280dc09 checked every pair under K-K and half its no-pair hands there too, so a short stack\'s checked hands reached showdown free)', () => {
    const st = maniacLeads(5332, 'last', 2);
    process.stdout.write(`MANIAC checked to by every seat, leads: ${fmt(st)}\n`);
    expect([st.low.n, st.air.n, st.kings.n, st.twoPairUp.n]).toEqual([16, 16, 16, 32]);
    for (const g of Object.keys(st)) expect([g, st[g].bets / st[g].n >= 0.9]).toEqual([g, true]);
  }, 300_000);

  it('the MANIAC lead mix is pinned', () => {
    expect([...AI.FIVE_DRAW_POST_MANIAC_MIX]).toEqual([0.5, 0.3]);
  });
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

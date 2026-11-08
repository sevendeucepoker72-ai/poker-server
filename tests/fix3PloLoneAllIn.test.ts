/**
 * tests/fix3PloLoneAllIn.test.ts (2026-11-05/08, bots review fix round 3: the critic's PLO NEW-1 check).
 * Pot-limit Omaha keeps the 0dc1b96 chips-left depth (chipsLeftEffectiveStackBB), and a lone all-in that the call
 * closes is called with any hand when it needs at most PLO_LONE_ALLIN_CALL_NEED (30%) of equity per opponent.
 * Round 1's hand-start depth (NEW-1, a Hold'em fix) took short and committing all-ins out of the push/fold zone
 * and into the deep Omaha ranges: on 2b5ac52 a TAG that pot-opened the button folded 66% of random hands (43% of
 * its own opening range) to an 8 BB shove needing 26.5%, folded 96% to a 20 BB player's pot 3-bet (33% needed,
 * 8.5 BB behind) and 97% to the last all-in of a 100 BB pot war (31% needed); live 0dc1b96: 0% / 28% / 1%.
 * Four-card hands run close (a random hand has 34% against AAxx on average). Hold'em keeps NEW-1.
 * Real OmahaTable + real decideAction, seeded Math.random (the LCG of tests/botPremiumHold.test.ts), seeded deck.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PokerTable, PlayerAction } = require('../src/game/PokerTable');
const { OmahaTable } = require('../src/game/variants/OmahaTable');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`fix3-plo-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; };
}
const BB = 100;
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'tight', archetype, vpip: 0.2, pfr: 0.15, aggressionFactor: 2.5, bluffFrequency: 0.15 } as any);
/** 6 seats (btn 0, sb 1, bb 2, utg 3, mp 4, co 5), stacks in BB; hand started. */
function plo(stacks: number[]): any {
  const t = new OmahaTable({ tableId: 'p', tableName: 'p', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: 1 } as any, false, 4);
  stacks.forEach((bb, i) => expect(t.sitDown(i, 'P' + i, bb * BB, 'ai-plo-' + i, true)).toBe(true));
  expect(t.startNewHand()).toBe(true);
  return t;
}
const potTo = (t: any, s: number) => expect(t.playerRaise(s, t.getMaxRaise(s))).toBe(true);
/** Share of `n` random 4-card hands (not dealt elsewhere) for which the bot at `me` does not fold. */
function contRate(t: any, me: number, a: string, n: number): number {
  const used = new Set<number>();
  for (const s of t.seats) if (s.seatIndex !== me) for (const c of s.holeCards || []) used.add((c.rank - 2) + 13 * c.suit);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const h: any[] = []; const u = new Set(used);
    while (h.length < 4) { const c = Math.floor(Math.random() * 52); if (u.has(c)) continue; u.add(c); h.push({ rank: 2 + (c % 13), suit: Math.floor(c / 13) }); }
    t.seats[me].holeCards = h;
    if (AI.decideAction(t, me, prof(a)).action !== PlayerAction.Fold) k++;
  }
  return k / n;
}
const ARCHS = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];

describe('PLO NEW-1 — a cheap lone all-in is called (pot-limit Omaha)', () => {
  it('the constant is 30% of equity needed per opponent', () => {
    expect(AI.PLO_LONE_ALLIN_CALL_NEED).toBe(0.30);
  });

  it.each(ARCHS)('%s on the button pot-opens, the SB moves in for 8 BB, the BB folds: it calls (26.5%% needed) with every hand', (a) => {
    const restore = detEnv(61);
    try {
      const t = plo([100, 8, 100, 100, 100, 100]);
      for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      potTo(t, 0);
      expect(t.playerAllIn(1)).toBe(true);
      expect(t.playerFold(2)).toBe(true);
      expect(t.activeSeatIndex).toBe(0);
      const need = t.getCallAmount(t.seats[0]) / (t.getTotalPot() + t.getCallAmount(t.seats[0]));
      expect(need).toBeGreaterThan(0.25);
      expect(need).toBeLessThan(0.30);
      expect(contRate(t, 0, a, 300)).toBe(1);
    } finally { restore(); }
  });

  it.each(['TAG', 'LAG', 'NIT', 'ROCK', 'FISH'])('%s re-potted the CO open, the CO (25 BB) jams: it calls (25.2%% needed) with every hand', (a) => {
    const restore = detEnv(62);
    try {
      const t = plo([100, 100, 100, 100, 100, 25]);
      for (const s of [3, 4]) expect(t.playerFold(s)).toBe(true);
      potTo(t, 5); potTo(t, 0);
      for (const s of [1, 2]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerAllIn(5)).toBe(true);
      expect(t.activeSeatIndex).toBe(0);
      expect(contRate(t, 0, a, 300)).toBe(1);
    } finally { restore(); }
  });

  it.each([['TAG', 0.55], ['LAG', 0.80], ['NIT', 0.55], ['ROCK', 0.60]])('%s pot-opened the button, a 20 BB player pot-3-bets from the small blind (8.5 BB behind, 33%% needed): it continues >= %p (0dc1b96 65-92%%; 2b5ac52 1-17%%)', (a, min) => {
    const restore = detEnv(64);
    try {
      const t = plo([100, 20, 100, 100, 100, 100]);
      for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      potTo(t, 0); potTo(t, 1);
      expect(t.playerFold(2)).toBe(true);
      expect(t.seats[1].allIn).toBe(false);
      expect(t.activeSeatIndex).toBe(0);
      expect(contRate(t, 0, a as string, 300)).toBeGreaterThanOrEqual(min as number);
    } finally { restore(); }
  });

  it.each(['TAG', 'LAG', 'NIT', 'ROCK'])('%s re-potted twice in a 100 BB pot war, the last all-in (31%% needed) comes: it continues >= 95%% (0dc1b96 99-100%%; 2b5ac52 0-17%%)', (a) => {
    const restore = detEnv(63);
    try {
      const t = plo([100, 100, 100, 100, 100, 100]);
      for (const s of [3, 4]) expect(t.playerFold(s)).toBe(true);
      potTo(t, 5); potTo(t, 0);
      for (const s of [1, 2]) expect(t.playerFold(s)).toBe(true);
      potTo(t, 5);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.activeSeatIndex).toBe(5);
      expect(contRate(t, 5, a, 300)).toBeGreaterThanOrEqual(0.95);
    } finally { restore(); }
  });

  it("control: Hold'em keeps the hand-start depth (NEW-1): the big blind TAG calls a lone 100 BB shove with <= 13% of hands", () => {
    const restore = detEnv(65);
    try {
      const t = new PokerTable({ tableId: 'h', tableName: 'h', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: 1 } as any);
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 100 * BB, 'ai-plo-h-' + i, true)).toBe(true);
      expect(t.startNewHand()).toBe(true);
      expect(t.playerAllIn(3)).toBe(true);
      for (const s of [4, 5, 0, 1]) expect(t.playerFold(s)).toBe(true);
      expect(t.activeSeatIndex).toBe(2);
      let k = 0; const n = 400;
      const used = new Set<number>(); for (const x of t.seats) if (x.seatIndex !== 2) for (const c of x.holeCards) used.add(c.rank * 4 + c.suit);
      for (let q = 0; q < n; q++) {
        let a = 0, b = 0; do { a = Math.floor(Math.random() * 52); b = Math.floor(Math.random() * 52); }
        while (a === b || used.has((2 + (a % 13)) * 4 + Math.floor(a / 13)) || used.has((2 + (b % 13)) * 4 + Math.floor(b / 13)));
        t.seats[2].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }];
        if (AI.decideAction(t, 2, prof('TAG')).action !== PlayerAction.Fold) k++;
      }
      expect(k / n).toBeLessThanOrEqual(0.13);
    } finally { restore(); }
  });
});

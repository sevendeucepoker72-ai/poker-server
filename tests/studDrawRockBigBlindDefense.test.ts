/**
 * tests/studDrawRockBigBlindDefense.test.ts (2026-11 bots review, fix round 3 review: EXPLOIT-3).
 * Fixed-limit draw games (2-7 Triple Draw, Badugi): a ROCK in the big blind facing ONE first-in raise
 * defends its pot-odds range (STUD_DRAW_FL_ROCK_BB_DEFEND, the top 70%). On its flat range it folded
 * ~58% (cdb31dd; live 0dc1b96 ~29%), and completing / raising any hand first in, then folding to any bet,
 * beat ROCK x4 in Badugi over whole hands: +11.6 +- 3.9 BB/100 (live -139; now -7.8 +- 4.1). Real tables
 * and the real decideAction, deterministic (seeded Math.random, frozen Date.now, seeded deck).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const { BadugiTable } = require('../src/game/variants/BadugiTable');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`rockbb-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const live = () => ({ tableId: 'rbb', tableName: 'rbb', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 });
const make: Record<string, () => any> = { 'triple-draw': () => new FiveCardDrawTable(live(), true), badugi: () => new BadugiTable(live()) };
const rock = (diff: string) => ({ ...AI.generateRandomProfile(diff), archetype: 'ROCK', difficulty: diff });

/** 5-handed, 25/50 fixed limit; the first seat to act (a human) raises, everyone folds to the big blind, a ROCK. */
function bbVsOneRaise(v: string, diff: string, deals: number): { folds: number; n: number } {
  let folds = 0, n = 0;
  for (let k = 0; n < deals && k < deals * 3; k++) {
    const t = make[v]();
    for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, 'ai-rbb-' + i, true);
    if (!t.startNewHand()) continue;
    const a0 = t.activeSeatIndex;
    t.seats[a0].isAI = false;
    if (!t.playerRaise(a0, t.getMinRaise())) continue;
    let g = 0; while (g++ < 8 && t.activeSeatIndex >= 0 && t.seats[t.activeSeatIndex].currentBet !== 50) t.playerFold(t.activeSeatIndex);
    const me = t.activeSeatIndex;
    if (me < 0 || t.seats[me].currentBet !== 50 || t.raisesThisStreet !== 1) continue;
    n++;
    if (AI.decideAction(t, me, rock(diff)).action === PlayerAction.Fold) folds++;
  }
  return { folds, n };
}

describe('review EXPLOIT-3: a fixed-limit ROCK big blind defends its pot-odds range vs ONE raise', () => {
  it.each([['badugi'], ['triple-draw']])('%s: the ROCK big blind folds at most 40% to one first-in raise over every difficulty, at most 50% at each (cdb31dd: ~58%)', (v) => {
    const restore = detEnv(3501);
    try {
      let folds = 0, n = 0;
      for (const diff of ['easy', 'medium', 'hard', 'expert']) {
        const r = bbVsOneRaise(v, diff, 60);
        process.stdout.write(`ROCK big blind vs one raise, ${v} ${diff}: folds ${r.folds}/${r.n}\n`);
        expect([diff, r.n]).toEqual([diff, 60]);
        expect([diff, r.folds / r.n <= 0.50]).toEqual([diff, true]);
        folds += r.folds; n += r.n;
      }
      expect(folds / n).toBeLessThanOrEqual(0.40);
    } finally { restore(); }
  }, 300_000);

  it('the threshold is the top 70% of first-round hands', () => {
    expect(AI.STUD_DRAW_FL_ROCK_BB_DEFEND).toBe(0.30);
  });
});

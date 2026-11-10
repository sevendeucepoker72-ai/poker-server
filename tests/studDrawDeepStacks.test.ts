/**
 * tests/studDrawDeepStacks.test.ts (2026-11 bots review, fix round 4: unequal stacks).
 * Five Card Draw: the fix round 3 review fix-up (9da6450, REG-2) made a 100 BB shove a stack-off for a 400 BB bot
 * (FIVE_DRAW_ALLIN_COMMIT_BB) - right for a LONE shove, but it also fired in raise wars: a 400 BB MANIAC re-raised
 * light (or cold-called a raise), then folded ~94% to a 100 BB shove over it, and opening 3 BB with any five cards
 * and shoving over every re-raise won +894 BB/100 vs MANIAC x4 at 400 BB (cdb31dd -88, live 0dc1b96 -165), measured
 * over whole hands. Now the depth rule is for a lone shove (the round's one raise); in a raise war a seat prices the
 * shove on its own stack, as cdb31dd did (the same line: -146). Real tables and the real decideAction, deterministic.
 * The other way round (a human SHORTER than the bots): a bot's re-raise above the light share of the depth at risk
 * is priced in against his all-in (reRaisePricedIn). A MANIAC re-raised a 40 BB human's 3 BB open to ~10 BB and
 * folded ~90% to his shove: the same any-two line won +98 BB/100 vs MANIAC x4 (live 0dc1b96 +4; since fix round 2).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const AI = require('../src/ai/AIPlayer');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`deep-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const DIFFS = ['easy', 'medium', 'hard', 'expert'];

/**
 * Five Card Draw, 6 seats at 25/50: seat 3 (UTG, first to act) is a human with 100 BB, every bot `botBB`. The human
 * opens to 3 BB; `own`: seat 4 re-raises to 9 BB and seat 5 calls; else seat 4 cold-calls and seat 5 re-raises to
 * 12 BB. The rest fold, the human moves all-in, and seat 4 (a MANIAC, its own random cards) decides with seat 5
 * still to act behind it.
 */
function shoveInRaiseWar(botBB: number, diff: string, own = true): any {
  const t = new FiveCardDrawTable({ tableId: 'deep', tableName: 'deep', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
  for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 3 ? 'human-deep-' : 'ai-deep-') + i, i !== 3);
  for (let i = 0; i < 6; i++) t.seats[i].chipCount = (i === 3 ? 100 : botBB) * 50;
  t.startNewHand();
  expect(t.activeSeatIndex).toBe(3);
  expect(t.playerRaise(3, 150)).toBe(true);
  if (own) { expect(t.playerRaise(4, 450)).toBe(true); expect(t.playerCall(5)).toBe(true); }
  else { expect(t.playerCall(4)).toBe(true); expect(t.playerRaise(5, 600)).toBe(true); }
  let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 3) t.playerFold(t.activeSeatIndex);
  expect(t.activeSeatIndex).toBe(3);
  expect(t.playerAllIn(3)).toBe(true);
  expect(t.activeSeatIndex).toBe(4);
  return AI.decideAction(t, 4, { ...AI.generateRandomProfile(diff), archetype: 'MANIAC', difficulty: diff });
}
function foldShare(seed: number, botBB: number, own: boolean, label: string): number {
  const restore = detEnv(seed);
  try {
    let folds = 0, n = 0;
    for (const diff of DIFFS) for (let k = 0; k < 40; k++) { n++; if (shoveInRaiseWar(botBB, diff, own).action === PlayerAction.Fold) folds++; }
    process.stdout.write(`${botBB} BB MANIAC, ${label}: folds ${folds}/${n}\n`);
    expect(n).toBe(160);
    return folds / n;
  } finally { restore(); }
}

describe('fix round 4 (unequal stacks): in a raise war a deep bot prices a 100 BB shove on its own stack (the depth rule is for a lone shove)', () => {
  it('a 400 BB MANIAC that re-raised a 100 BB human\'s open keeps its flat range vs his 100 BB shove over it (folds at most half; 9da6450: ~94%)', () => {
    expect(foldShare(4301, 400, true, 'shove over its own re-raise')).toBeLessThanOrEqual(0.5);
  }, 120_000);

  it('a 400 BB MANIAC that cold-called in the raise war keeps its flat range vs the shove too (folds at most half)', () => {
    expect(foldShare(4303, 400, false, 'cold caller facing the shove')).toBeLessThanOrEqual(0.5);
  }, 120_000);

  it('CONTROL: at 100 BB the same shove commits its own stack, and the stack-off range prices it (folds most)', () => {
    expect(foldShare(4302, 100, true, 'shove over its own re-raise')).toBeGreaterThan(0.75);
  }, 120_000);
});

/**
 * Fix round 4 (unequal stacks, the other way round): seat 3 is a human with `heroBB`, every bot 100 BB. The human
 * opens to 3 BB, seat 4 (a bot of `arch`, its own random cards) re-raises to `reBB`, everyone else folds, the human
 * moves all-in and seat 4 decides, closing the action.
 */
function shortShoveOverReRaise(heroBB: number, reBB: number, arch: string, diff: string): any {
  const t = new FiveCardDrawTable({ tableId: 'short', tableName: 'short', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
  for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 3 ? 'human-short-' : 'ai-short-') + i, i !== 3);
  t.seats[3].chipCount = heroBB * 50;
  t.startNewHand();
  expect(t.activeSeatIndex).toBe(3);
  expect(t.playerRaise(3, 150)).toBe(true);
  expect(t.playerRaise(4, reBB * 50)).toBe(true);
  let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 3) t.playerFold(t.activeSeatIndex);
  expect(t.activeSeatIndex).toBe(3);
  expect(t.playerAllIn(3)).toBe(true);
  expect(t.activeSeatIndex).toBe(4);
  return AI.decideAction(t, 4, { ...AI.generateRandomProfile(diff), archetype: arch, difficulty: diff });
}
function shortShoveFolds(seed: number, heroBB: number, reBB: number, archs: string[], perCell: number): { folds: number; n: number } {
  const restore = detEnv(seed);
  try {
    let folds = 0, n = 0;
    for (const arch of archs) for (const diff of DIFFS) for (let k = 0; k < perCell; k++) {
      n++; if (shortShoveOverReRaise(heroBB, reBB, arch, diff).action === PlayerAction.Fold) folds++;
    }
    process.stdout.write(`${heroBB} BB human shoves over a ${reBB} BB re-raise (${archs.join('/')}): folds ${folds}/${n}\n`);
    return { folds, n };
  } finally { restore(); }
}

describe('fix round 4 (unequal stacks): a bot\'s re-raise is priced in against a SHORTER all-in over it (reRaisePricedIn)', () => {
  const ARCH = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
  it('a 100 BB bot that re-raised a 40 / 60 BB human\'s 3 BB open to 10 BB never folds to his all-in, every archetype and difficulty (2b5ac52 to 05248ab: a MANIAC folded ~90% of its light re-raises)', () => {
    const r40 = shortShoveFolds(4311, 40, 10, ARCH, 6);
    const r60 = shortShoveFolds(4312, 60, 10, ARCH, 6);
    expect([r40.n, r60.n]).toEqual([168, 168]);
    expect([r40.folds, r60.folds]).toEqual([0, 0]);
  }, 300_000);

  it('CONTROL: at 100 BB a light 10 BB re-raise is the light share of the depth at risk, and the stack-off range prices the shove (a MANIAC folds most)', () => {
    const r = shortShoveFolds(4313, 100, 10, ['MANIAC'], 40);
    expect(r.n).toBe(160);
    expect(r.folds / r.n).toBeGreaterThan(0.75);
  }, 120_000);

  it('CONTROL: an OPEN is not a re-raise: a MANIAC\'s 5 BB open facing a 40 BB human\'s all-in is still priced by the stack-off range (folds most)', () => {
    const restore = detEnv(4314);
    try {
      let folds = 0, n = 0;
      for (const diff of DIFFS) for (let k = 0; k < 40; k++) {
        const t = new FiveCardDrawTable({ tableId: 'open', tableName: 'open', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
        for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 4 ? 'human-open-' : 'ai-open-') + i, i !== 4);
        t.seats[4].chipCount = 40 * 50;
        t.startNewHand();
        expect(t.activeSeatIndex).toBe(3);
        expect(t.playerRaise(3, 250)).toBe(true);   // the bot opens to 5 BB (more than a tenth of 40 BB)
        expect(t.playerAllIn(4)).toBe(true);
        let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 3) t.playerFold(t.activeSeatIndex);
        expect(t.activeSeatIndex).toBe(3);
        n++;
        if (AI.decideAction(t, 3, { ...AI.generateRandomProfile(diff), archetype: 'MANIAC', difficulty: diff }).action === PlayerAction.Fold) folds++;
      }
      process.stdout.write(`40 BB human shoves over a MANIAC's 5 BB open: folds ${folds}/${n}\n`);
      expect(n).toBe(160);
      expect(folds / n).toBeGreaterThan(0.6);
    } finally { restore(); }
  }, 120_000);

  // Fix round 4 review (REGRESSION-2): an all-in CALL for less than the big blind made before the bot's open is
  // not a raise, so the open is still not a re-raise (c2b81d4 read 'went all-in for 30' as one: 0 of 160 folds
  // for MANIAC / LAG / TAG / FISH; cdb31dd 140-148).
  it('CONTROL: an all-in CALL for less than the big blind before the bot\'s 5 BB open does not make the open a re-raise (folds most, every loose archetype)', () => {
    const restore = detEnv(4315);
    try {
      const out: string[] = [];
      for (const arch of ['MANIAC', 'LAG', 'TAG', 'FISH']) {
        let folds = 0, n = 0;
        for (const diff of DIFFS) for (let k = 0; k < 12; k++) {
          const t = new FiveCardDrawTable({ tableId: 'micro', tableName: 'micro', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
          for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (i === 3 || i === 5 ? 'human-micro-' : 'ai-micro-') + i, !(i === 3 || i === 5));
          t.seats[3].chipCount = 30;          // UTG: less than the big blind
          t.seats[5].chipCount = 40 * 50;     // the shover: 40 BB
          t.startNewHand();
          expect(t.activeSeatIndex).toBe(3);
          expect(t.playerAllIn(3)).toBe(true);           // 'went all-in for 30': a call for less
          expect(t.playerRaise(4, 250)).toBe(true);      // the bot opens to 5 BB
          expect(t.playerAllIn(5)).toBe(true);           // the 40 BB human shoves
          let g = 0; while (g++ < 10 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 4) t.playerFold(t.activeSeatIndex);
          expect(t.activeSeatIndex).toBe(4);
          n++;
          if (AI.decideAction(t, 4, { ...AI.generateRandomProfile(diff), archetype: arch, difficulty: diff }).action === PlayerAction.Fold) folds++;
        }
        out.push(`${arch} ${folds}/${n}`);
        expect(n).toBe(48);
        expect(folds / n).toBeGreaterThan(0.6);
      }
      process.stdout.write(`micro all-in call, then the bot's open, then a 40 BB shove: folds ${out.join(', ')}\n`);
    } finally { restore(); }
  }, 120_000);

  // Re-review fix-ups (STUDDRAW-R4F-REGRESSION-2): a UTG straddle is the round's posted blind. An all-in CALL for
  // less than the straddle (80 under a 100 straddle) is a call, not a raise, so the bot's open after it is still
  // not a re-raise (cdfc8a1 counted the level from the 50 big blind: 0 of 160 folds for MANIAC / LAG / TAG / FISH;
  // the straddled pot without the short call 132-144).
  it('CONTROL: in a STRADDLED pot an all-in call for less than the straddle before the bot\'s 5 BB open does not make the open a re-raise (folds most, every loose archetype)', () => {
    const restore = detEnv(4316);
    try {
      const out: string[] = [];
      for (const arch of ['MANIAC', 'LAG', 'TAG', 'FISH']) {
        let folds = 0, n = 0;
        for (const diff of DIFFS) for (let k = 0; k < 12; k++) {
          const t = new FiveCardDrawTable({ tableId: 'mstr', tableName: 'mstr', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 }, false);
          const human = (i: number) => i === 0 || i === 3 || i === 4;
          for (let i = 0; i < 6; i++) t.sitDown(i, 'P' + i, 5000, (human(i) ? 'human-mstr-' : 'ai-mstr-') + i, !human(i));
          t.seats[0].chipCount = 40 * 50;     // the shover: 40 BB
          t.seats[4].chipCount = 80;          // more than the big blind, less than the straddle
          t.startNewHand();
          expect(t.activeSeatIndex).toBe(3);
          expect(t.straddle(3)).toBe(true);              // UTG straddles to 100
          expect(t.playerAllIn(4)).toBe(true);           // 'went all-in for 80': a call for less
          expect(t.playerRaise(5, 250)).toBe(true);      // the bot opens to 5 BB
          expect(t.playerAllIn(0)).toBe(true);           // the 40 BB human shoves
          let g = 0; while (g++ < 12 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== 5) t.playerFold(t.activeSeatIndex);
          expect(t.activeSeatIndex).toBe(5);
          n++;
          if (AI.decideAction(t, 5, { ...AI.generateRandomProfile(diff), archetype: arch, difficulty: diff }).action === PlayerAction.Fold) folds++;
        }
        out.push(`${arch} ${folds}/${n}`);
        expect(n).toBe(48);
        expect(folds / n).toBeGreaterThan(0.6);
      }
      process.stdout.write(`straddle, an all-in call for less than it, the bot's open, then a 40 BB shove: folds ${out.join(', ')}\n`);
    } finally { restore(); }
  }, 120_000);
});

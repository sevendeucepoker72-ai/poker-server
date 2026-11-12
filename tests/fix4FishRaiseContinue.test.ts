/**
 * tests/fix4FishRaiseContinue.test.ts (2026-11-09, bots review fix round 4, fix-up 1: HOLDEM-R4-MEASUREMENT-1).
 * No-limit Hold'em, node level. B5 (fix rounds 1-2) turned the FISH "weird raise" from a 100 BB jam into a 3x raise
 * with its top 10% (FISH_RAISE_PCTILE). Facing a 100 BB shove over that 3-bet the FISH then read the shove as a big
 * bet: the 0.12-of-its-own-stack call rule and the size-narrowed call range (or, when its call closed the action, the
 * stack-off range) folded part of the hands it had just raised with (this test on b870456: 59-82% continued at hard,
 * 48-63% at easy; all of them only with a caller behind at 1,000 BB). Opening 10 BB with any two and shoving over
 * a FISH 3-bet broke even against five 500 BB FISH (+17 (29) BB/100 on b4d567f; live 0dc1b96 -274: the FISH jammed).
 * Now a FISH that raised this street continues against an all-in deeper than 25 BB with every hand it raises for,
 * read on the strength before this decision's noise less half the noise width (the raise drew its own noise).
 * 25 BB and shallower are unchanged.
 * Real PokerTable + real decideAction; seeded Math.random and a seeded deck (crypto.randomBytes).
 * 6 seats at 50/100, button 3: small blind 4, big blind 5, UTG 0 (the human), MP 1 (the FISH), CO 2 (a second FISH).
 */
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { decideAction } from '../src/ai/AIPlayer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');
function seedAll(seed: number): () => void {
  const orig = Math.random, rb = nodeCrypto.randomBytes;
  let s = seed >>> 0, ctr = 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  nodeCrypto.randomBytes = (n: number) => {
    let buf = Buffer.alloc(0);
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix4-frc-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; };
}
const BB = 100;
const fish = (difficulty: string) =>
  ({ botName: 'F', difficulty, personality: 'fish', archetype: 'FISH', vpip: 0.5, pfr: 0.1, aggressionFactor: 1, bluffFrequency: 0.08 } as any);
let tableNo = 0;

interface Spot { hands: number; raises: number; jams: number; cont: number }
/**
 * The human (UTG, humanBB) opens to `open` BB; the FISH (MP, fishBB) acts. When it raises, the CO FISH (fishBB) calls
 * (callerBehind) or folds, the blinds fold, the human moves all-in and the FISH answers.
 */
function run(fishBB: number, humanBB: number, open: number, callerBehind: boolean, difficulty: string, n = 1000): Spot {
  const r: Spot = { hands: 0, raises: 0, jams: 0, cont: 0 };
  const restore = seedAll(9001 + fishBB + humanBB + (callerBehind ? 7 : 0) + difficulty.length);
  try {
    for (let k = 0; k < n; k++) {
      const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
      const id = tableNo++;
      const stacks = [humanBB, fishBB, fishBB, 100, 100, 100];
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-frc-' : 'ai-frc-') + id + '-' + i, i !== 0)).toBe(true);
      if (typeof (t as any).presetFirstButton === 'function') (t as any).presetFirstButton(3);
      expect(t.startNewHand()).toBe(true);
      expect(t.activeSeatIndex).toBe(0);
      expect(t.playerRaise(0, open * BB)).toBe(true);
      r.hands++;
      const d = decideAction(t, 1, fish(difficulty));
      if (d.action === PlayerAction.AllIn) { r.jams++; continue; }
      if (d.action !== PlayerAction.Raise || !t.playerRaise(1, d.raiseAmount)) continue;
      r.raises++;
      expect(callerBehind ? t.playerCall(2) : t.playerFold(2)).toBe(true);
      for (const s of [3, 4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.activeSeatIndex).toBe(0);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      const d2 = decideAction(t, 1, fish(difficulty));
      if (d2.action !== PlayerAction.Fold) r.cont++;
    }
  } finally { restore(); }
  return r;
}

describe('fix-up 1 (HOLDEM-R4-MEASUREMENT-1) — a FISH does not 3-bet and then fold to the all-in', () => {
  it('a FISH that 3-bet a 10 BB open continues every one of them against the 100 BB shove (300 / 500 / 1,000 BB, its call closing or a caller behind; b870456 48-82%)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'easy']) {
      for (const fbb of [300, 500, 1000]) {
        for (const behind of [false, true]) {
          const r = run(fbb, 100, 10, behind, diff);
          const tag = `${diff} ${fbb} BB ${behind ? 'caller behind' : 'closes'}`;
          if (r.raises < 70) bad.push(`${tag}: only ${r.raises} 3-bets of ${r.hands}`);
          if (r.cont < 0.98 * r.raises) bad.push(`${tag}: continued ${r.cont}/${r.raises}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('B5 is unchanged: the FISH still 3-bets its top ~10% to 3x, never a jam (hard / medium / easy)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium', 'easy']) {
      const r = run(500, 100, 3, false, diff);
      const pct = r.raises / r.hands;
      if (r.jams > 0) bad.push(`${diff}: ${r.jams} jams`);
      if (pct < 0.07 || pct > 0.15) bad.push(`${diff}: 3-bet ${(100 * pct).toFixed(1)}%`);
    }
    expect(bad).toEqual([]);
  }, 300_000);
});

/**
 * tests/fix4ManiacOpenerFlatters.test.ts (2026-11-08, bots review fix round 4, fix-up 1: HOLDEM-R4-EXPLOIT-1 / -2).
 * No-limit Hold'em, node level. A MANIAC opens (any two, ~95% from UTG), a player flat-calls, and the human in the
 * big blind squeezes all-in. Round 4 (b4d567f) counted the flatter still to act as a player at risk (the stack-off
 * width / 1.5) and continued by calling: a 500 BB MANIAC folded 77% of its opens to a 40 BB squeeze and 86% to a
 * 100 BB one (block 2), a 100 BB MANIAC 86% to both (the commit gate read the 100 BB of the deepest opponent, not
 * the 40 BB at risk). Each fold paid the human the dead money, and squeezing any two from the big blind over a
 * MANIAC open won +30 to +55 BB/100 (hard, whole line; live 0dc1b96 -7 to -36). With MANIAC_FLATTER_WIDEN the
 * flatters are dead money: the opener reads the stack-off range for the shover's depth counting only the other
 * players, at (1 + 1 per flatter) x its raised width, and continues by an isolation re-raise (as the MANIAC branch
 * and 0dc1b96 do), never by a flat call (0bc7529 flat-called ~70%: the call-then-fold of fix round 4).
 * Two deep MANIACs (one opens, the other flats behind: the light re-raise cap turned its 3-bets into flats) made the
 * squeeze profitable whatever the opener did (+14..+39 BB/100 for a 40 BB human, live -20): with
 * MANIAC_SQUEEZE_BEHIND_MAX_BB a MANIAC flats only what continues against the squeeze when a 26-50 BB player is still
 * to act (the last test).
 * Fix-up 2 (HOLDEM-RR1-EXPLOIT-1 / -2, MANIAC_SHORT_SHOVE_MAX_BB): against an all-in of 26-75 BB at risk the opener keeps
 * its MANIAC branch (~68-74% continue, by CALLING, so the flatters keep their overcall: isolating made their chips dead
 * money, and a 40 BB squeeze over a MANIAC open still won +24 BB/100 with two 100 BB MANIACs). The opener rule this file
 * pinned binds against deeper all-ins (the 100 BB rows); the 40 BB rows now pin the fix-up 2 behaviour
 * (tests/fix4ManiacShortShove.test.ts has the rest).
 * Real PokerTable + real decideAction; seeded Math.random and a seeded deck (crypto.randomBytes).
 * 6 seats at 50/100, button 4: small blind 5, big blind 0 (the human), UTG 1 (the MANIAC), MP 2, CO 3.
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
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix4-mof-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; };
}
const BB = 100;
const maniac = (difficulty = 'hard') =>
  ({ botName: 'M', difficulty, personality: 'maniac', archetype: 'MANIAC', vpip: 0.9, pfr: 0.8, aggressionFactor: 5, bluffFrequency: 0.4 } as any);
let tableNo = 0;
/** The MANIAC (UTG, seat 1) at maniacBB opens first in; `flats` of MP / CO / button call; the small blind folds; the human (big blind, humanBB) shoves. */
function squeezed(maniacBB: number, humanBB: number, flats: number, difficulty: string): PokerTable | null {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const id = tableNo++;
  const stacks = [humanBB, maniacBB, 100, 100, 100, 100];
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-mof-' : 'ai-mof-') + id + '-' + i, i !== 0)).toBe(true);
  if (typeof (t as any).presetFirstButton === 'function') (t as any).presetFirstButton(4);
  expect(t.startNewHand()).toBe(true);
  expect(t.activeSeatIndex).toBe(1);
  const open = decideAction(t, 1, maniac(difficulty));
  if (open.action !== PlayerAction.Raise || !t.playerRaise(1, open.raiseAmount)) return null;   // it limped / folded: no spot
  for (const s of [2, 3, 4]) expect(s - 2 < flats ? t.playerCall(s) : t.playerFold(s)).toBe(true);
  expect(t.playerFold(5)).toBe(true);
  expect(t.activeSeatIndex).toBe(0);
  expect(t.playerAllIn(0)).toBe(true);
  expect(t.activeSeatIndex).toBe(1);
  return t;
}
/** Over n hands: the spots, and the MANIAC's response to the squeeze (continue = not fold; calls = flat calls). */
function respond(maniacBB: number, humanBB: number, flats: number, difficulty = 'hard', n = 400): { spots: number; cont: number; calls: number } {
  let spots = 0, cont = 0, calls = 0;
  const restore = seedAll(4242 + maniacBB + humanBB + flats);
  try {
    for (let k = 0; k < n; k++) {
      const t = squeezed(maniacBB, humanBB, flats, difficulty);
      if (!t) continue;
      spots++;
      const d = decideAction(t, 1, maniac(difficulty));
      if (d.action !== PlayerAction.Fold) cont++;
      if (d.action === PlayerAction.Call) calls++;
    }
  } finally { restore(); }
  return { spots, cont, calls };
}

describe('fix-up 1 (HOLDEM-R4-EXPLOIT-1 / -2) — a MANIAC opener squeezed with flatters behind treats them as dead money', () => {
  it('one flatter: a 500 BB MANIAC continues >= 35% vs a 100 BB squeeze, never by a flat call; >= 60% vs a 40 BB one, a 100 / 200 BB MANIAC too (b4d567f: 14 / 23 / 14%; the 40 BB rows by calling since fix-up 2)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) {
      for (const [mbb, hbb, min] of [[500, 40, 0.6], [500, 100, 0.35], [100, 40, 0.6], [200, 40, 0.6]]) {
        const r = respond(mbb, hbb, 1, diff);
        if (r.spots < 300) bad.push(`${diff} ${mbb}/${hbb}: only ${r.spots} spots`);
        if (r.cont < min * r.spots || (hbb > 75 && r.calls > 0)) bad.push(`${diff} MANIAC ${mbb} BB vs ${hbb} BB squeeze: continued ${r.cont}/${r.spots}, flat-called ${r.calls}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('two flatters: wider still vs a 100 BB squeeze (>= 50%, never a flat call; b4d567f 10%); vs a 40 BB one >= 60% (b4d567f 17%; by calling since fix-up 2)', () => {
    const bad: string[] = [];
    for (const [mbb, hbb, min] of [[500, 40, 0.6], [500, 100, 0.5]]) {
      const r = respond(mbb, hbb, 2);
      if (r.cont < min * r.spots || (hbb > 75 && r.calls > 0)) bad.push(`MANIAC ${mbb} BB vs ${hbb} BB squeeze, 2 flatters: continued ${r.cont}/${r.spots}, flat-called ${r.calls}`);
    }
    expect(bad).toEqual([]);
  });

  it('a deep MANIAC facing a single open with a 40 BB player still to act flats only what continues against his squeeze (<= 30%; b4d567f ~65%); with a 100 BB player there, or when it is less than twice as deep as the 40 BB player (60 BB), it still flats ~65%', () => {
    const flats = (bbBB: number, maniacBB = 500): number => {
      let calls = 0;
      const n = 400;
      const restore = seedAll(9100 + bbBB + (maniacBB === 500 ? 0 : maniacBB));
      try {
        for (let k = 0; k < n; k++) {
          // seats: 0 = big blind (the human, bbBB), 1 = UTG (a 500 BB bot) opens to 3 BB, 2 = MP (the maniacBB MANIAC) decides
          const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
          const id = tableNo++;
          const stacks = [bbBB, 500, maniacBB, 100, 100, 100];
          for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-mof-' : 'ai-mof-') + id + '-' + i, i !== 0)).toBe(true);
          (t as any).presetFirstButton(4);
          expect(t.startNewHand()).toBe(true);
          expect(t.playerRaise(1, 3 * BB)).toBe(true);
          expect(t.activeSeatIndex).toBe(2);
          if (decideAction(t, 2, maniac()).action === PlayerAction.Call) calls++;
        }
      } finally { restore(); }
      return calls / n;
    };
    const short = flats(40), deep = flats(100), similar = flats(40, 60);
    expect([short <= 0.3, deep >= 0.5, similar >= 0.5]).toEqual([true, true, true]);
  });

  it('no flatter (its call closes the action): untouched by the opener rule; vs 100 BB the raised stack-off width (~21%), vs 40 BB the MANIAC branch since fix-up 2 (>= 60%; the stack-off width gave ~37%)', () => {
    const r40 = respond(500, 40, 0), r100 = respond(500, 100, 0);
    expect(r40.cont / r40.spots).toBeGreaterThan(0.6);
    expect(r100.cont / r100.spots).toBeGreaterThan(0.12);
    expect(r100.cont / r100.spots).toBeLessThan(0.3);
  });
});

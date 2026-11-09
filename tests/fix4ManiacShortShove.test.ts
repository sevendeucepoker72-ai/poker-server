/**
 * tests/fix4ManiacShortShove.test.ts (2026-11-09, bots review fix round 4, fix-up 2: HOLDEM-RR1-EXPLOIT-1 / -2), node level.
 * No-limit Hold'em. A MANIAC raises any two. A human of 26-75 BB who shoves any two over that raise risks his stack against
 * a range that must call ~42% equity: ~70% of hands have it, and 0dc1b96's MANIAC branch continues 69%. Fix-up 1
 * (09fe8d2) held the MANIAC that raised to the stack-off range for the shover's depth (x2): it continued 51 / 35 / 26% of
 * its raises against a 30 / 40 / 60 BB all-in it closed, and with a flatter behind it isolated, so the flatter's chips
 * were dead money for the shover. Shoving any two over a MANIAC's raise then won (hard, whole line, BB/100) +8 (2) for a
 * 30 BB human with every bot at 100 BB, +24 (5) for a 40 BB human with two 100 BB MANIACs, ~+18 at 50-60 BB (live
 * 0dc1b96 -20 / -28 / -18). With MANIAC_SHORT_SHOVE_MAX_BB a MANIAC that raised keeps its MANIAC branch against such an
 * all-in (it continues ~68%, by calling), and one that only flat-called plays the stack-off range for the shover's depth
 * counting him alone. A deeper all-in (100 BB) keeps the round-3 / round-4 stack-off rules. The MANIAC flat rule
 * (MANIAC_SQUEEZE_BEHIND_MAX_BB) no longer lets a 25 BB or shorter player still to act hide a 26-50 BB one.
 * Real PokerTable + real decideAction; seeded Math.random and a seeded deck (crypto.randomBytes).
 * 6 seats at 50/100, button 4: small blind 5, big blind 0 (the human), UTG 1, MP 2, CO 3.
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
    while (buf.length < n) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`fix4-mss-${seed}-${ctr++}`).digest()]);
    return buf.subarray(0, n);
  };
  return () => { Math.random = orig; nodeCrypto.randomBytes = rb; };
}
const BB = 100;
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'B', difficulty, personality: 'p', archetype, vpip: 0.9, pfr: 0.8, aggressionFactor: 5, bluffFrequency: 0.4 } as any);
let tableNo = 0;
function table(stacks: number[]): PokerTable {
  const t = new PokerTable({ tableId: 't', tableName: 't', smallBlind: 50, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
  const id = tableNo++;
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, stacks[i] * BB, (i === 0 ? 'player-mss-' : 'ai-mss-') + id + '-' + i, i !== 0)).toBe(true);
  (t as any).presetFirstButton(4);
  expect(t.startNewHand()).toBe(true);
  return t;
}
type Resp = { spots: number; cont: number; calls: number };
/**
 * The MANIAC (UTG, seat 1, maniacBB) opens first in (its own decision; no spot when it limps or folds); `flats` of MP / CO /
 * button call; the small blind folds; the human (big blind, humanBB) moves all-in; the MANIAC's response.
 */
function opener(maniacBB: number, humanBB: number, flats: number, difficulty = 'hard', n = 400): Resp {
  let spots = 0, cont = 0, calls = 0;
  const restore = seedAll(5150 + maniacBB + humanBB + 7 * flats);
  try {
    for (let k = 0; k < n; k++) {
      const t = table([humanBB, maniacBB, 100, 100, 100, 100]);
      expect(t.activeSeatIndex).toBe(1);
      const open = decideAction(t, 1, prof('MANIAC', difficulty));
      if (open.action !== PlayerAction.Raise || !t.playerRaise(1, open.raiseAmount)) continue;
      for (const s of [2, 3, 4]) expect(s - 2 < flats ? t.playerCall(s) : t.playerFold(s)).toBe(true);
      expect(t.playerFold(5)).toBe(true);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.activeSeatIndex).toBe(1);
      spots++;
      const d = decideAction(t, 1, prof('MANIAC', difficulty));
      if (d.action !== PlayerAction.Fold) cont++;
      if (d.action === PlayerAction.Call) calls++;
    }
  } finally { restore(); }
  return { spots, cont, calls };
}
/** UTG (100 BB) opens to 3 BB, the MANIAC (MP, seat 2, maniacBB) flat-calls, CO (100 BB) flat-calls, button / small blind fold, the human (big blind) squeezes all-in, UTG folds: the MANIAC's response (the CO still to act behind it). */
function flatter(maniacBB: number, humanBB: number, difficulty = 'hard', n = 400): Resp {
  let spots = 0, cont = 0, calls = 0;
  const restore = seedAll(7300 + maniacBB + humanBB);
  try {
    for (let k = 0; k < n; k++) {
      const t = table([humanBB, 100, maniacBB, 100, 100, 100]);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      expect(t.playerCall(2)).toBe(true);
      expect(t.playerCall(3)).toBe(true);
      for (const s of [4, 5]) expect(t.playerFold(s)).toBe(true);
      expect(t.playerAllIn(0)).toBe(true);
      expect(t.playerFold(1)).toBe(true);
      expect(t.activeSeatIndex).toBe(2);
      spots++;
      const d = decideAction(t, 2, prof('MANIAC', difficulty));
      if (d.action !== PlayerAction.Fold) cont++;
      if (d.action === PlayerAction.Call) calls++;
    }
  } finally { restore(); }
  return { spots, cont, calls };
}
const pct = (r: Resp): string => `${(100 * r.cont / Math.max(1, r.spots)).toFixed(1)}% (calls ${(100 * r.calls / Math.max(1, r.spots)).toFixed(1)}%, ${r.spots} spots)`;

/** UTG (500 BB) opens to 3 BB; the MANIAC (MP, seat 2, 500 BB) decides, with the CO (coBB), the button and small blind (100 BB) and the human (big blind, 40 BB) still to act: its share of flat calls. */
function flatsBehind(coBB: number, n = 400): number {
  let calls = 0;
  const restore = seedAll(9500 + coBB);
  try {
    for (let k = 0; k < n; k++) {
      const t = table([40, 500, 500, coBB, 100, 100]);
      expect(t.playerRaise(1, 3 * BB)).toBe(true);
      expect(t.activeSeatIndex).toBe(2);
      if (decideAction(t, 2, prof('MANIAC')).action === PlayerAction.Call) calls++;
    }
  } finally { restore(); }
  return calls / n;
}

describe('fix-up 2 (HOLDEM-RR1-EXPLOIT-1 / -2) — a MANIAC that raised keeps its MANIAC branch against a 26-75 BB all-in', () => {
  const log: string[] = [];
  afterAll(() => process.stdout.write(`fix4 MANIAC short shove: ${log.join('; ')}\n`));

  it('the constant is 75 BB', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('../src/ai/AIPlayer').MANIAC_SHORT_SHOVE_MAX_BB).toBe(75);
  });

  it('no flatter (its call closes the action): the opener continues >= 58% against a 30 / 40 / 60 / 75 BB all-in (09fe8d2: 48 / 34 / 30 / 24%)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) {
      for (const [m, h] of [[100, 30], [100, 40], [500, 40], [500, 60], [500, 75]]) {
        const r = opener(m, h, 0, diff);
        log.push(`${diff} ${m}/${h} ${pct(r)}`);
        if (r.spots < 300 || r.cont < 0.58 * r.spots) bad.push(`${diff} MANIAC ${m} BB vs ${h} BB: ${pct(r)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('one / two flatters: the opener continues >= 58% against a 40 / 60 BB squeeze, mostly by CALLING (>= 45% of spots: the flatters keep their overcall; 09fe8d2 isolated, 0 calls)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) {
      for (const [m, h, f] of [[100, 40, 1], [500, 40, 1], [500, 60, 1], [500, 40, 2]]) {
        const r = opener(m, h, f, diff);
        log.push(`${diff} ${m}/${h} fl${f} ${pct(r)}`);
        if (r.spots < 300 || r.cont < 0.58 * r.spots || r.calls < 0.45 * r.spots) bad.push(`${diff} MANIAC ${m} BB vs ${h} BB, ${f} flatter(s): ${pct(r)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('a deeper all-in keeps the round-3 / round-4 rules: against an 80 / 100 BB all-in the opener continues <= 32% (the raised stack-off width), and with a flatter behind it isolates a 100 BB squeeze, never a flat call', () => {
    const r80 = opener(500, 80, 0), r100 = opener(500, 100, 0), f100 = opener(500, 100, 1);
    log.push(`80 ${pct(r80)}; 100 ${pct(r100)}; 100 fl1 ${pct(f100)}`);
    expect([r80.cont <= 0.32 * r80.spots, r100.cont <= 0.32 * r100.spots, f100.calls]).toEqual([true, true, 0]);
  });

  it('a MANIAC that flat-called continues against a 30 / 40 BB squeeze with the stack-off range for the shover alone (>= 42 / 28%; 09fe8d2 counted the players behind: 33 / 23%, 12% for a 100 BB MANIAC)', () => {
    const bad: string[] = [];
    for (const diff of ['hard', 'medium']) {
      for (const [m, h, min] of [[500, 30, 0.42], [500, 40, 0.28], [100, 40, 0.28]]) {
        const r = flatter(m, h, diff);
        log.push(`${diff} flatter ${m}/${h} ${pct(r)}`);
        if (r.cont < min * r.spots) bad.push(`${diff} flatter ${m} BB vs ${h} BB: ${pct(r)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the MANIAC flat rule: a 15 BB player still to act does not hide the 40 BB one (flat-calls <= 30%; 09fe8d2 ~69%), as with a 100 BB one', () => {
    const micro = flatsBehind(15), deep = flatsBehind(100);
    log.push(`flat with a 15 BB CO ${(100 * micro).toFixed(1)}%, a 100 BB CO ${(100 * deep).toFixed(1)}%`);
    expect([micro <= 0.3, deep <= 0.3]).toEqual([true, true]);
  });
});

/**
 * tests/econAofCalibration.test.ts (2026-11 bots review, economy-farming E3, ai-core part).
 * All-In or Fold bot calibration at 20/40 (1,000 chips = 25 BB):
 *  - the open-shove width shrinks x AOF_PUSH_WIDTH_PER_PLAYER per extra player behind;
 *  - a call is priced against the range the shover is read to shove (his seat, blended
 *    with his VPIP observed this game);
 *  - nothing changes off All-In or Fold.
 * Real PokerTable + real decideAction, seeded Math.random.
 * (1) and (2) fail on 0dc1b96 and on the pre-E3 tree; (3) is a GUARD (identity off AoF),
 * with a wiring check that the mocked functions really are reached on an AoF spot.
 */
import { PokerTable, PlayerAction, GamePhase } from '../src/game/PokerTable';
import { decideAction, generateRandomProfile, recordOpponentObservation } from '../src/ai/AIPlayer';
import { getPreflopPercentile, adjustThreshold, ARCHETYPE_RANGE_FACTOR } from '../src/ai/preflopRanges';
import {
  nashPushPctile, nashCallPctile, aofPushPctile, aofCallPctile, AOF_OBS_PRIOR_HANDS, AOF_PUSH_WIDTH_PER_PLAYER,
} from '../src/ai/pushFoldSolver';

function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}

const SB = 20, BB = 40, STACK = 1000;   // the AoF table: 25 BB
const RC: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const hand = (code: string): any[] => [
  { rank: RC[code[0]] ?? +code[0], suit: 0 },
  { rank: RC[code[1]] ?? +code[1], suit: code[2] === 's' ? 0 : 1 },
];
const CODES: string[] = [];
{
  const ch = 'AKQJT98765432';
  for (let i = 0; i < 13; i++) for (let j = i; j < 13; j++) {
    if (i === j) CODES.push(ch[i] + ch[i]);
    else { CODES.push(ch[i] + ch[j] + 's'); CODES.push(ch[i] + ch[j] + 'o'); }
  }
}
/** Hand classes whose pre-flop percentile lies strictly inside (lo, hi). */
const handsBetween = (lo: number, hi: number): string[] => CODES.filter((c) => {
  const p = getPreflopPercentile(hand(c));
  return p > lo && p < hi;
});

/** 6 seats, 1,000 each, hand started: btn 0, sb 1, bb 2, utg 3, mp 4, co 5. */
function aofTable(ids: string[] = []): PokerTable {
  const t = new PokerTable({ tableId: 'aof', tableName: 'aof', smallBlind: SB, bigBlind: BB, ante: 0, minBuyIn: 100 } as any);
  for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, STACK, ids[i] || `ai-aof-${i}`, true)).toBe(true);
  expect(t.startNewHand()).toBe(true);
  return t;
}
const TAG_F = ARCHETYPE_RANGE_FACTOR.TAG;
const tagExpert = () => ({ ...generateRandomProfile('expert'), archetype: 'TAG' as const });

describe('E3 (1) — pushFoldSolver All-In or Fold widths', () => {
  it('the push width shrinks x0.7 per extra player behind (heads-up unchanged)', () => {
    expect(AOF_PUSH_WIDTH_PER_PLAYER).toBe(0.7);
    expect(aofPushPctile(25, 1)).toBe(nashPushPctile(25, 1));
    expect(aofPushPctile(25, 1)).toBeCloseTo(0.647, 3);
    expect(aofPushPctile(25, 5)).toBeCloseTo(0.915, 3);
    expect(nashPushPctile(25, 5)).toBeCloseTo(0.827, 3);   // the old multiway rule (+0.045 per player)
    expect(aofPushPctile(10, 5)).toBeCloseTo(0.866, 3);
    expect(aofPushPctile(26, 1)).toBeNull();               // above the baked table, like nashPushPctile
  });
  it('the call width follows the shover\'s width, never wider than the heads-up call, narrower multiway', () => {
    expect(aofCallPctile(25, 0.353, 0)).toBeCloseTo(0.83, 3);    // the heads-up Nash call, unchanged
    expect(aofCallPctile(25, 0.353, 0)).toBeCloseTo(nashCallPctile(25, 1), 3);
    expect(aofCallPctile(25, 0.0848, 0)).toBeCloseTo(0.959, 3);  // vs an unobserved UTG shove, closing
    expect(aofCallPctile(25, 0.0848, 4)).toBeCloseTo(0.986, 3);  // same, 4 others live
    expect(aofCallPctile(25, 0.353, 2)).toBeCloseTo(0.915, 3);   // vs an SB shove, 2 others live
    expect(aofCallPctile(25, 0.9, 0)).toBeCloseTo(0.83, 3);      // never wider than the heads-up call
    expect(aofCallPctile(25, 0, 0)).toBeCloseTo(0.995, 6);       // width floored at 0.5% of hands
  });
});

describe('E3 (2) — decideAction on a real 20/40 All-In or Fold table', () => {
  it('UTG unopened folds a hand between the old and the new shove thresholds (it shoved)', () => {
    const oldTh = adjustThreshold(nashPushPctile(25, 5)!, TAG_F);
    const newTh = adjustThreshold(aofPushPctile(25, 5)!, TAG_F);
    const codes = handsBetween(oldTh + 0.02, newTh - 0.02);
    expect(codes.length).toBeGreaterThan(0);
    const restore = seedRandom(31);
    try {
      for (const code of codes) {
        const t = aofTable();
        expect(t.activeSeatIndex).toBe(3);
        t.seats[3].holeCards = hand(code);
        expect([code, decideAction(t, 3, tagExpert(), { allInOrFold: true }).action]).toEqual([code, PlayerAction.Fold]);
      }
      // ...and the top of the range still shoves.
      const t = aofTable(); t.seats[3].holeCards = hand('AKs');
      expect(decideAction(t, 3, tagExpert(), { allInOrFold: true }).action).toBe(PlayerAction.AllIn);
    } finally { restore(); }
  });

  /** Everyone folds to the small blind (`sbId`), who moves all-in; the big blind decides. */
  function bbVsSbShove(sbId: string): PokerTable {
    const t = aofTable(['ai-b0', sbId, 'ai-b2', 'ai-b3', 'ai-b4', 'ai-b5']);
    for (const s of [3, 4, 5, 0]) expect(t.playerFold(s)).toBe(true);
    expect(t.playerAllIn(1)).toBe(true);
    expect(t.activeSeatIndex).toBe(2);
    return t;
  }
  const sbPrior = 1 - aofPushPctile(25, 1)!;                       // the SB has one player behind
  const observedW = (3 + AOF_OBS_PRIOR_HANDS * sbPrior) / (30 + AOF_OBS_PRIOR_HANDS);
  const controlTh = adjustThreshold(aofCallPctile(25, sbPrior, 0), TAG_F);
  const observedTh = adjustThreshold(aofCallPctile(25, observedW, 0), TAG_F);
  const MID = handsBetween(controlTh + 0.02, observedTh - 0.02);

  it('the BB folds a ~top-12% hand to a shover seen voluntarily in 3 of 30 hands (it called)', () => {
    expect(aofCallPctile(25, observedW, 0)).toBeCloseTo(0.921, 3);
    expect(MID.length).toBeGreaterThan(0);
    for (let k = 1; k <= 30; k++) recordOpponentObservation('player-x', 'hand_start', { handNumber: k });
    for (let k = 0; k < 3; k++) recordOpponentObservation('player-x', 'vpip');
    const restore = seedRandom(32);
    try {
      for (const code of MID) {
        const t = bbVsSbShove('player-x'); t.seats[2].holeCards = hand(code);
        expect([code, decideAction(t, 2, tagExpert(), { allInOrFold: true }).action]).toEqual([code, PlayerAction.Fold]);
      }
    } finally { restore(); }
  });

  it('control: the same hands call the same shove from an unobserved small blind', () => {
    const restore = seedRandom(33);
    try {
      for (const code of MID) {
        const t = bbVsSbShove('player-unseen'); t.seats[2].holeCards = hand(code);
        expect([code, decideAction(t, 2, tagExpert(), { allInOrFold: true }).action]).toEqual([code, PlayerAction.AllIn]);
      }
    } finally { restore(); }
  });

  it('every All-In or Fold pre-flop decision is still all-in, fold or a free check', () => {
    const restore = seedRandom(34);
    try {
      const ok = new Set([PlayerAction.AllIn, PlayerAction.Fold, PlayerAction.Check]);
      const archs = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
      let n = 0;
      for (let i = 0; i < 300; i++) {
        const t = aofTable();
        // a random prefix of folds / all-ins, then the next seat to act decides
        const steps = Math.floor(Math.random() * 5);
        for (let k = 0; k < steps && t.activeSeatIndex >= 0; k++) {
          const a = t.activeSeatIndex;
          if (Math.random() < 0.3) t.playerAllIn(a); else t.playerFold(a);
        }
        const me = t.activeSeatIndex;
        if (me < 0 || t.currentPhase !== GamePhase.PreFlop) continue;
        const used = new Set<number>(); const h: any[] = [];
        for (const s of t.seats) for (const c of s.holeCards) used.add(c.rank * 4 + c.suit);
        while (h.length < 2) {
          const r = 2 + Math.floor(Math.random() * 13), su = Math.floor(Math.random() * 4);
          if (used.has(r * 4 + su)) continue; used.add(r * 4 + su); h.push({ rank: r, suit: su });
        }
        t.seats[me].holeCards = h;
        const p = { ...generateRandomProfile(['easy', 'medium', 'hard', 'expert'][i % 4] as any), archetype: archs[i % archs.length] as any };
        const d = decideAction(t, me, p, { allInOrFold: true });
        expect(ok.has(d.action)).toBe(true);
        n++;
      }
      expect(n).toBeGreaterThan(200);
    } finally { restore(); }
  });
});

describe('E3 (3) GUARD — nothing changes off All-In or Fold', () => {
  const PFS = '../src/ai/pushFoldSolver';
  /** 500 seeded non-AoF pre-flop spots (6-max 100 BB ring, 6-max 10 BB, 3-handed 100 BB). */
  function runSpots(mockAof: boolean): { decisions: string[]; aofReached: boolean } {
    const decisions: string[] = [];
    let aofReached = false;
    jest.isolateModules(() => {
      if (mockAof) {
        jest.doMock(PFS, () => ({
          ...jest.requireActual(PFS),
          aofPushPctile: () => { throw new Error('aofPushPctile called off All-In or Fold'); },
          aofCallPctile: () => { throw new Error('aofCallPctile called off All-In or Fold'); },
        }));
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PT = require('../src/game/PokerTable');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AI = require('../src/ai/AIPlayer');
      const restore = seedRandom(4040);
      try {
        for (let i = 0; i < 500; i++) {
          const kind = i % 3;
          const n = kind === 2 ? 3 : 6;
          const stack = kind === 1 ? 10 * 100 : 100 * 100;
          const t = new PT.PokerTable({ tableId: 'g', tableName: 'g', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 });
          for (let s = 0; s < n; s++) t.sitDown(s, 'P' + s, stack, `ai-g-${s}`, true);
          t.startNewHand();
          const steps = Math.floor(Math.random() * (n - 1));
          for (let k = 0; k < steps; k++) {
            const a = t.activeSeatIndex; const r = Math.random();
            if (r < 0.55) t.playerFold(a);
            else if (r < 0.75) t.playerCall(a);
            else if (r < 0.92) t.playerRaise(a, Math.max(t.getMinRaise(), Math.round(t.currentBetToMatch * 3)));
            else t.playerAllIn(a);
          }
          const me = t.activeSeatIndex;
          // The hero's two cards from the seeded RNG only (the deck itself is shuffled
          // from crypto, so its cards must not steer the RNG; pre-flop Hold'em reads no
          // other seat's cards).
          const a = Math.floor(Math.random() * 52); let b = Math.floor(Math.random() * 51); if (b >= a) b++;
          t.seats[me].holeCards = [{ rank: 2 + (a % 13), suit: Math.floor(a / 13) }, { rank: 2 + (b % 13), suit: Math.floor(b / 13) }];
          const arch = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'][i % 7];
          const p = { ...AI.generateRandomProfile(['hard', 'expert', 'medium'][i % 3]), archetype: arch };
          const d = AI.decideAction(t, me, p);
          decisions.push(`${i}:${t.currentPhase}:${d.action}:${d.raiseAmount}`);
        }
        // Wiring check: an All-In or Fold spot DOES reach the (mocked) calibration.
        const t = new PT.PokerTable({ tableId: 'w', tableName: 'w', smallBlind: SB, bigBlind: BB, ante: 0, minBuyIn: 100 });
        for (let s = 0; s < 6; s++) t.sitDown(s, 'P' + s, STACK, `ai-w-${s}`, true);
        t.startNewHand();
        t.seats[t.activeSeatIndex].holeCards = hand('AKs');
        try { AI.decideAction(t, t.activeSeatIndex, { ...AI.generateRandomProfile('hard'), archetype: 'TAG' }, { allInOrFold: true }); }
        catch { aofReached = true; }
      } finally { restore(); }
    });
    if (mockAof) jest.dontMock(PFS);
    return { decisions, aofReached };
  }

  it('500 seeded non-AoF pre-flop spots decide identically with the AoF functions throwing', () => {
    const plain = runSpots(false);
    const mocked = runSpots(true);
    expect(plain.aofReached).toBe(false);
    expect(mocked.aofReached).toBe(true);              // the mock is live: AoF reaches it
    expect(mocked.decisions).toHaveLength(500);
    expect(mocked.decisions).toEqual(plain.decisions);
  });
});

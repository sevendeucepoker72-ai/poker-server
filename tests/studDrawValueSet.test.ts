/**
 * tests/studDrawValueSet.test.ts (2026-11 bots review, fix round 2, item 4: the NIT first-round residuals).
 * Each Stud / draw game has a VALUE SET on the first-round percentile read BEFORE the difficulty noise
 * (AIPlayer STUD_DRAW_VALUE_PCTILE). A hand in it never folds to one completion (Stud family) or one open
 * that does not commit the stack (draw games), for every archetype and difficulty. On d1ec56a a NIT folded
 * them on its noisy percentile: hard Razz A-2-3 21%, Stud 8 A-2-3 suited 28%, Five Card Draw A-A-K 36%;
 * medium Stud K-K-9 8%; easy up to 53%. Real tables and the real decideAction, deterministic (seeded
 * Math.random, frozen Date.now, seeded deck). Each spot is a freshly dealt 5-handed table; the hand's
 * pre-noise percentile in THAT deal (the door cards showing move it in Stud) is computed with the same
 * public-information functions the bot uses, and only deals at or above the cut are asserted.
 * Follow-up (second review): Five Card Draw's set also holds every pair of aces or better by class
 * (AIPlayer fiveDrawAcesOrBetter: the 0.90 cut on the noisy percentile left out most low two pairs and
 * ~12% of pairs of aces, and a NIT folded 3-3-2-2-K 70% / 7-7-3-3-A 40% to one 3 BB open on 98e2568,
 * 86% / 64% on d1ec56a), and a value-set hand facing only the bring-in / big blind never folds either
 * (easy / medium bots folded A-A-K-7-3 in Five Card Draw up to 24%, Razz 2-4-6 10%, Stud 8 A-2-3 suited 12%).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const { BadugiTable } = require('../src/game/variants/BadugiTable');
const { SevenStudTable } = require('../src/game/variants/SevenStudTable');
const AI = require('../src/ai/AIPlayer');
const SDS = require('../src/ai/studDrawStrength');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`value-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const live = (o: any = {}) => ({ tableId: 'v', tableName: 'v', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000, ...o });
const make: Record<string, () => any> = {
  'five-card-draw': () => new FiveCardDrawTable(live(), false), 'triple-draw': () => new FiveCardDrawTable(live(), true),
  badugi: () => new BadugiTable(live()), 'seven-stud': () => new SevenStudTable(live({ ante: 5 }), false, false),
  'stud-hi-lo': () => new SevenStudTable(live({ ante: 5 }), false, true), razz: () => new SevenStudTable(live({ ante: 5 }), true, false),
};
/** The value cuts this test pins (AIPlayer STUD_DRAW_VALUE_PCTILE). */
const CUT: Record<string, number> = { 'stud-hi': 0.92, stud8: 0.90, razz: 0.85, 'draw-hi': 0.90, deuce7: 0.95, badugi: 0.95 };
const ARCH = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const prof = (a: string, diff: string) => ({ ...AI.generateRandomProfile(diff), archetype: a, difficulty: diff });
const same = (a: any, b: any) => a.rank === b.rank && a.suit === b.suit;

/** A fresh 5-handed table facing ONE completion / one non-committing open, `h` planted for the seat to act; null on a door-card clash. */
function spot(v: string, h: string): { t: any; me: number; raw: number } | null {
  const t = make[v](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-v-${i}`, true); t.startNewHand();
  const kind = SDS.studDrawKindOf(t.variantId, t); const stud = SDS.isStudKind(kind);
  if (stud) { t.playerCheck(t.activeSeatIndex); t.playerRaise(t.activeSeatIndex, t.getMinRaise()); }   // the bring-in stays, the next seat completes
  else t.playerRaise(t.activeSeatIndex, kind === 'draw-hi' ? 150 : t.getMinRaise());                     // a 3 BB open / one fixed-limit bet
  const me = t.activeSeatIndex; const hand = C(h);
  const doors: any[] = []; if (stud) for (const x of t.seats) if (x.seatIndex !== me && x.state === 'occupied') doors.push(...t.getFaceUpCards(x.seatIndex));
  if (doors.some((c) => hand.some((y: any) => same(y, c)))) return null;
  t.seats[me].holeCards = hand;
  const raw = SDS.equityToPercentile(kind, SDS.firstRoundEquity(kind, hand, doors, SDS.drawsLeftAt(kind, t.currentPhase), 0));
  return { t, me, raw };
}
/** The same table with nobody in yet: the seat to act faces only the bring-in (Stud family) or the big blind (draw games). */
function unopened(v: string, h: string): { t: any; me: number; raw: number } | null {
  const t = make[v](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-v-${i}`, true); t.startNewHand();
  const kind = SDS.studDrawKindOf(t.variantId, t); const stud = SDS.isStudKind(kind);
  if (stud) t.playerCheck(t.activeSeatIndex);   // the bring-in seat keeps its forced bet
  const me = t.activeSeatIndex; const hand = C(h);
  if (t.getCallAmount(t.seats[me]) <= 0 || (Number(t.raisesThisStreet) || 0) > 0) return null;
  const doors: any[] = []; if (stud) for (const x of t.seats) if (x.seatIndex !== me && x.state === 'occupied') doors.push(...t.getFaceUpCards(x.seatIndex));
  if (doors.some((c) => hand.some((y: any) => same(y, c)))) return null;
  t.seats[me].holeCards = hand;
  const raw = SDS.equityToPercentile(kind, SDS.firstRoundEquity(kind, hand, doors, SDS.drawsLeftAt(kind, t.currentPhase), 0));
  return { t, me, raw };
}
const SPOTS: [string, string][] = [
  ['seven-stud', 'Kd Kc 9h'], ['seven-stud', 'Qd Qc 7h'], ['razz', 'Ad 2c 3h'], ['razz', '2d 4c 6h'], ['stud-hi-lo', 'Ah 2h 3h'],
  ['five-card-draw', 'Ah Ad Kc 7s 3h'], ['five-card-draw', 'Jh Jd 4c 4s 2h'], ['triple-draw', '7h 5d 3c 2s Kh'], ['badugi', 'As 2h 3d 8c'],
];

describe('item 4: a value-set hand never folds to one completion / one non-committing open', () => {
  it('pins the per-game cuts', () => {
    expect(AI.STUD_DRAW_VALUE_PCTILE).toEqual(CUT);
  });
  it.each(SPOTS)('%s %s: NIT at hard / medium / easy never folds it when its pre-noise percentile is in the set', (v, h) => {
    const restore = detEnv(41);
    try {
      let inSet = 0, deals = 0;
      for (let g = 0; deals < 12 && g < 60; g++) {
        const r = spot(v, h); if (!r) continue; deals++;
        const kind = SDS.studDrawKindOf(r.t.variantId, r.t);
        if (r.raw < CUT[kind]) continue;
        inSet++;
        for (const diff of ['hard', 'medium', 'easy']) {
          const p = prof('NIT', diff); let folds = 0;
          for (let i = 0; i < 8; i++) if (AI.decideAction(r.t, r.me, p).action === PlayerAction.Fold) folds++;
          expect([v, h, diff, r.raw.toFixed(3), folds]).toEqual([v, h, diff, r.raw.toFixed(3), 0]);
        }
      }
      expect(inSet / deals).toBeGreaterThanOrEqual(0.75);   // the named start is in its game's set in most deals
    } finally { restore(); }
  }, 120_000);
  it('every other archetype (medium) holds the same hands too', () => {
    const restore = detEnv(42);
    try {
      for (const [v, h] of SPOTS) {
        for (let g = 0, done = 0; done < 2 && g < 20; g++) {
          const r = spot(v, h); if (!r) continue;
          if (r.raw < CUT[SDS.studDrawKindOf(r.t.variantId, r.t)]) continue;
          done++;
          for (const a of ARCH) {
            let folds = 0; const p = prof(a, 'medium');
            for (let i = 0; i < 6; i++) if (AI.decideAction(r.t, r.me, p).action === PlayerAction.Fold) folds++;
            expect([v, h, a, folds]).toEqual([v, h, a, 0]);
          }
        }
      }
    } finally { restore(); }
  }, 180_000);
  it.each(SPOTS)('%s %s: facing only the bring-in / big blind, NIT / TAG / ROCK at medium and easy never fold it in the set', (v, h) => {
    const restore = detEnv(44);
    try {
      let inSet = 0, deals = 0;
      for (let g = 0; deals < 6 && g < 40; g++) {
        const r = unopened(v, h); if (!r) continue; deals++;
        const kind = SDS.studDrawKindOf(r.t.variantId, r.t);
        if (r.raw < CUT[kind]) continue;
        inSet++;
        for (const a of ['NIT', 'TAG', 'ROCK']) for (const diff of ['medium', 'easy']) {
          const p = prof(a, diff); let folds = 0;
          for (let i = 0; i < 8; i++) if (AI.decideAction(r.t, r.me, p).action === PlayerAction.Fold) folds++;
          expect([v, h, a, diff, folds]).toEqual([v, h, a, diff, 0]);
        }
      }
      expect(inSet).toBeGreaterThanOrEqual(3);
    } finally { restore(); }
  }, 120_000);
  it('Five Card Draw: fiveDrawAcesOrBetter is exactly "a pair of aces or better" (hiValue >= A-A-4-3-2) over 20,000 random hands', () => {
    let s = 9; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const floor = SDS.hiValue(C('As Ah 4d 3c 2s'));
    let yes = 0;
    for (let k = 0; k < 20000; k++) {
      const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: su });
      for (let i = 0; i < 5; i++) { const j = i + Math.floor(rnd() * (52 - i)); const z = deck[i]; deck[i] = deck[j]; deck[j] = z; }
      const h = deck.slice(0, 5); const want = SDS.hiValue(h) >= floor;
      if (want) yes++;
      if (AI.fiveDrawAcesOrBetter(h) !== want) expect([h, want]).toEqual([h, !want]);
    }
    expect(yes / 20000).toBeGreaterThan(0.09);
    expect(yes / 20000).toBeLessThan(0.13);
  });
  it('Five Card Draw: a NIT never folds any two pair or any pair of aces (random suits and kickers) to one 3 BB open or first in, hard / medium / easy', () => {
    const restore = detEnv(45);
    try {
      let s = 17; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      const pick = (n: number) => Math.floor(rnd() * n);
      /** A random five-card hand of the class: two pair (kind 0) or a pair of aces with three odd kickers (kind 1). */
      const make5 = (cls: number): any[] => {
        for (;;) {
          const deck: any[] = []; for (let su = 0; su < 4; su++) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: su });
          const take = (pred: (c: any) => boolean) => { const ok = deck.filter(pred); const c = ok[pick(ok.length)]; deck.splice(deck.indexOf(c), 1); return c; };
          let h: any[];
          if (cls === 0) {
            const a = 2 + pick(13); let b = 2 + pick(13); while (b === a) b = 2 + pick(13);
            h = [take((c) => c.rank === a), take((c) => c.rank === a), take((c) => c.rank === b), take((c) => c.rank === b), take((c) => c.rank !== a && c.rank !== b)];
          } else {
            h = [take((c) => c.rank === 14), take((c) => c.rank === 14)];
            while (h.length < 5) h.push(take((c) => c.rank !== 14 && !h.some((x: any) => x.rank === c.rank)));
          }
          if (cls === 1 && h.every((c) => c.suit === h[0].suit)) continue;   // keep it a plain pair of aces
          return h;
        }
      };
      let n = 0;
      for (let k = 0; k < 40; k++) {
        const hand = make5(k % 2);
        expect(SDS.hiValue(hand) >= SDS.hiValue(C('As Ah 4d 3c 2s'))).toBe(true);
        for (const first of [false, true]) {
          const t = make['five-card-draw'](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-v-${i}`, true); t.startNewHand();
          if (!first) t.playerRaise(t.activeSeatIndex, 150);
          const me = t.activeSeatIndex; t.seats[me].holeCards = hand;
          for (const diff of ['hard', 'medium', 'easy']) {
            const p = prof('NIT', diff);
            for (let i = 0; i < 3; i++) { n++; expect([hand.map((c: any) => c.rank).join('-'), first, diff, AI.decideAction(t, me, p).action === PlayerAction.Fold]).toEqual([hand.map((c: any) => c.rank).join('-'), first, diff, false]); }
          }
        }
      }
      expect(n).toBe(720);
    } finally { restore(); }
  }, 180_000);
  it('GUARD: below the cut a NIT still folds (Badugi A-2-3 with a king, a 3-card hand vs an open)', () => {
    const restore = detEnv(43);
    try {
      let folds = 0, n = 0;
      for (let g = 0; g < 10; g++) {
        const r = spot('badugi', 'As 2h 3d Kc'); if (!r) continue;
        expect(r.raw).toBeLessThan(CUT.badugi);
        for (let i = 0; i < 10; i++) { n++; if (AI.decideAction(r.t, r.me, prof('NIT', 'hard')).action === PlayerAction.Fold) folds++; }
      }
      expect(folds / n).toBeGreaterThan(0.5);
    } finally { restore(); }
  }, 60_000);
});

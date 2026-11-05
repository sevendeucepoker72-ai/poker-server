/**
 * tests/studDrawBots.test.ts (2026-11 bots review, stud-draw-lowball SD3/SD4/SD5).
 * Real engine tables + the real decideAction. Deterministic: seeded Math.random, frozen
 * Date.now (every Monte Carlo runs its full sim count) and a deterministic
 * crypto.randomBytes (the deck's own seeded shuffle and its foreign-card reshuffle
 * repeat exactly). Every case fails on 0dc1b96 (22 of 23) except the "same seed, same
 * numbers" determinism GUARD, which passes on both.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { GamePhase, PlayerAction } = require('../src/game/PokerTable');
const { FiveCardDrawTable } = require('../src/game/variants/FiveCardDrawTable');
const { BadugiTable } = require('../src/game/variants/BadugiTable');
const { SevenStudTable } = require('../src/game/variants/SevenStudTable');
const PF = require('../src/ai/pushFoldSolver');
const AI = require('../src/ai/AIPlayer');
const SDS = require('../src/ai/studDrawStrength');
const nodeCrypto = require('crypto');
export {};   // a module: its top-level names stay file-scoped (other suites declare GamePhase too)

function detEnv(seed: number): () => void {
  const rb = nodeCrypto.randomBytes, r = Math.random, now = Date.now;
  let ctr = 0;
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`det-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const SU: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (x: string) => x.trim().split(/\s+/).map((t) => ({ rank: RK[t[0]] ?? Number(t[0]), suit: SU[t[1]] }));
const live = (o: any = {}) => ({ tableId: 'x', tableName: 'x', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000, ...o });
const make: Record<string, () => any> = {
  'five-card-draw': () => new FiveCardDrawTable(live(), false), 'triple-draw': () => new FiveCardDrawTable(live(), true),
  badugi: () => new BadugiTable(live()), 'seven-stud': () => new SevenStudTable(live({ ante: 5 }), false, false),
  'stud-hi-lo': () => new SevenStudTable(live({ ante: 5 }), false, true), razz: () => new SevenStudTable(live({ ante: 5 }), true, false),
};
const DRAW = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const prof = (a: string) => ({ ...AI.generateRandomProfile('hard'), archetype: a });
function exec(t: any, si: number, d: any) {
  switch (d.action) {
    case PlayerAction.Fold: return t.playerFold(si);
    case PlayerAction.Check: return t.playerCheck(si) || t.playerFold(si);
    case PlayerAction.Call: return t.playerCall(si) || t.playerCheck(si) || t.playerFold(si);
    case PlayerAction.Raise: return t.playerRaise(si, d.raiseAmount) || t.playerCall(si) || t.playerCheck(si) || t.playerFold(si);
    default: return t.playerAllIn(si) || t.playerFold(si);
  }
}
const kindOf = (t: any) => SDS.studDrawKindOf(t.variantId, t);
function playHand(t: any, profs: any[], hero: boolean, onFirst?: (a: number, d: any) => void): boolean {
  for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = 5000; x.eliminated = false; x.sittingOut = false; }
  if (!t.startNewHand()) return false;
  const first = t.currentPhase; let g = 0;
  while (t.isHandInProgress() && g++ < 800) {
    if (DRAW.includes(t.currentPhase)) {
      for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) {
        t.playerDraw(x.seatIndex, hero && x.seatIndex === 0 ? [] : SDS.chooseBotDiscards(kindOf(t), x.holeCards, t.currentPhase));
        if (!DRAW.includes(t.currentPhase)) break;
      }
      continue;
    }
    const a = t.activeSeatIndex; if (a < 0) break;
    if (hero && a === 0) {   // complete / open every unopened first round, fold to a raise, then check/fold
      if (t.currentPhase === first) {
        const rs0 = Number(t.raisesThisStreet) || 0;
        if (rs0 === 0 && t.playerRaise(0, t.getMinRaise())) continue;
        if (rs0 >= 1 && t.getCallAmount(t.seats[0]) > 0) { t.playerFold(0); continue; }
        if (t.playerCall(0) || t.playerCheck(0)) continue; t.playerFold(0); continue;
      }
      t.playerCheck(0) || t.playerFold(0); continue;
    }
    const d = AI.decideAction(t, a, profs[a]);
    if (onFirst && t.currentPhase === first) onFirst(a, d);
    exec(t, a, d);
  }
  return true;
}
function seatBots(t: any, arch: string[], hero: boolean, tag: string) {
  const profs: any[] = []; let i = 0;
  if (hero) { t.sitDown(0, 'Hero', 5000, `human-${tag}`, false); profs.push(null); i = 1; }
  for (const a of arch) { profs.push(prof(a)); t.sitDown(i, 'B' + i, 5000, `ai-${tag}-${i}`, true); i++; }
  return profs;
}
function tagVpip(v: string, seed: number): number {
  const restore = detEnv(seed);
  try {
    const t = make[v](); const profs = seatBots(t, ['TAG', 'TAG', 'LAG', 'NIT', 'FISH'], false, v);
    let dealt = 0, vol = 0;
    for (let h = 0; h < 60; h++) {
      const seen = new Set<number>();
      if (!playHand(t, profs, false, (a, d) => { if (profs[a].archetype === 'TAG' && d.action !== PlayerAction.Fold && d.action !== PlayerAction.Check) seen.add(a); })) break;
      dealt += 2; vol += seen.size;
    }
    return vol / dealt;
  } finally { restore(); }
}
function completeAndFold(v: string, seed: number): number {
  const restore = detEnv(seed);
  try {
    const t = make[v](); const profs = seatBots(t, ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH'], true, v);
    let net = 0, played = 0;
    for (let h = 0; h < 150; h++) { if (!playHand(t, profs, true)) break; played++; net += t.seats[0].chipCount - 5000; }
    return (net / 50 / played) * 100;
  } finally { restore(); }
}
function dist(t: any, si: number, p: any, n = 40): Record<string, number> {
  const m: Record<string, number> = {};
  for (let i = 0; i < n; i++) { const d = AI.decideAction(t, si, p); m[d.action] = (m[d.action] || 0) + 1; }
  return m;
}

describe('B1 / B1x: first round on the percentile scale (deterministic)', () => {
  it.each(['seven-stud', 'razz', 'stud-hi-lo', 'five-card-draw', 'triple-draw', 'badugi'])('%s: TAG first-round VPIP is 10-45 percent (seed 7)', (v) => {
    const r = tagVpip(v, 7);
    // eslint-disable-next-line no-console
    process.stdout.write(`VPIP ${v} ${r.toFixed(3)}\n`);
    expect(r).toBeGreaterThanOrEqual(0.10);
    expect(r).toBeLessThanOrEqual(0.45);
  }, 120_000);
  it('same seed, same numbers (determinism)', () => { expect(tagVpip('razz', 7)).toBe(tagVpip('razz', 7)); }, 120_000);
  it.each(['seven-stud', 'razz', 'stud-hi-lo'])('%s: complete-and-fold vs [TAG,LAG,NIT,ROCK,FISH] is below +20 BB/100 (seed 7)', (v) => {
    const r = completeAndFold(v, 7);
    process.stdout.write(`CAF ${v} ${r.toFixed(1)}\n`);
    expect(r).toBeLessThan(20);
  }, 180_000);

  const STUD: [string, string][] = [['seven-stud', 'Ad Ac Kh'], ['seven-stud', '7d 7c 7h'], ['razz', 'Ad 2c 3h'], ['stud-hi-lo', 'Ad Ac Kh']];
  it.each(STUD)('%s %s facing ONE completion: no archetype folds', (v, h) => {
    const restore = detEnv(11);
    try {
      for (const a of ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION']) {
        const t = make[v](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-c-${i}`, true); t.startNewHand();
        t.playerCheck(t.activeSeatIndex); t.playerRaise(t.activeSeatIndex, t.getMinRaise());
        const me = t.activeSeatIndex; t.seats[me].holeCards = C(h);
        const m = dist(t, me, prof(a));
        // NIT calls a raise only with its 3-bet range (~top 7%): Razz A-2-3 sits on that line (pct ~0.95)
        if (v === 'razz' && a === 'NIT') expect(m[PlayerAction.Fold] || 0).toBeLessThanOrEqual(10);
        else expect([a, m[PlayerAction.Fold] || 0]).toEqual([a, 0]);
      }
    } finally { restore(); }
  }, 60_000);
  it('Stud bring-in seat with split aces completes (TAG/LAG/NIT/ROCK; old: checked 100%)', () => {
    const restore = detEnv(12);
    try {
      for (const a of ['TAG', 'LAG', 'NIT', 'ROCK']) {
        const t = make['seven-stud'](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-b-${i}`, true); t.startNewHand();
        const bi = t.activeSeatIndex; t.seats[bi].holeCards = [...C('Ad Ac'), t.seats[bi].holeCards[2]];
        expect([a, dist(t, bi, prof(a))]).toEqual([a, { [PlayerAction.Raise]: 40 }]);
      }
    } finally { restore(); }
  }, 60_000);
  it('Five Card Draw UTG first-in: pat straight / pat flush / AA-K open-raise for TAG/LAG/NIT; FISH never moves all-in pre-draw', () => {
    const restore = detEnv(13);
    try {
      for (const h of ['9h Td Jc Qs Kh', 'Ah Jh 8h 5h 2h', 'Ah Ad Kc 7s 3h']) {
        for (const a of ['TAG', 'LAG', 'NIT', 'FISH']) {
          const t = make['five-card-draw'](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-f-${i}`, true); t.startNewHand();
          const me = t.activeSeatIndex; t.seats[me].holeCards = C(h);
          const m = dist(t, me, prof(a));
          expect([h, a, m[PlayerAction.AllIn] || 0, m[PlayerAction.Fold] || 0]).toEqual([h, a, 0, 0]);
          if (a !== 'FISH') expect([h, a, m[PlayerAction.Raise]]).toEqual([h, a, 40]);
        }
      }
    } finally { restore(); }
  }, 60_000);
  it('Five Card Draw big blind facing a 2 BB open is FACING A RAISE: J-J-9-6-2 (pct ~0.80) calls, never re-raises', () => {
    const restore = detEnv(14);
    try {
      const pct = SDS.equityToPercentile('draw-hi', SDS.firstRoundEquity('draw-hi', C('Jh Jd 9c 6s 2h'), [], 1, 0));
      expect(pct).toBeGreaterThan(0.75); expect(pct).toBeLessThan(0.88);
      const t = make['five-card-draw'](); for (let i = 0; i < 5; i++) t.sitDown(i, 'P' + i, 5000, `ai-bb-${i}`, true); t.startNewHand();
      let g = 0;
      while (g++ < 10) { const a = t.activeSeatIndex; if (t.getCallAmount(t.seats[a]) <= 50 && Number(t.raisesThisStreet) >= 1 && t.seats[a].currentBet === 50) break; if (Number(t.raisesThisStreet) === 0) t.playerRaise(a, 100); else t.playerFold(a); }
      const me = t.activeSeatIndex; expect(t.seats[me].currentBet).toBe(50); expect(t.getCallAmount(t.seats[me])).toBe(50);
      t.seats[me].holeCards = C('Jh Jd 9c 6s 2h');
      expect(dist(t, me, prof('TAG'))).toEqual({ [PlayerAction.Call]: 40 });
    } finally { restore(); }
  }, 60_000);
  it('fixed limit: the no-limit Nash push/fold chart is never consulted (a 6 BB 2-7 Triple Draw stack opens a raise, not an all-in)', () => {
    const restore = detEnv(15);
    const spy = jest.spyOn(PF, 'nashPushPctile');
    try {
      const t = make['triple-draw'](); for (let i = 0; i < 5; i++) { t.sitDown(i, 'P' + i, 5000, `ai-pf-${i}`, true); t.seats[i].chipCount = 300; } t.startNewHand();
      expect(AI.getEffectiveStackBB(t, t.activeSeatIndex)).toBeLessThanOrEqual(6);
      const me = t.activeSeatIndex; t.seats[me].holeCards = C('7h 5d 4c 3s 2h');
      expect(dist(t, me, prof('TAG'))).toEqual({ [PlayerAction.Raise]: 40 });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); restore(); }
  }, 60_000);
});

/** A 3-handed (heads-up for `n=2`) table driven to `last` with everyone checking / calling and standing pat. */
function driveTo(v: string, last: any, n = 3): any {
  const t = make[v](); for (let i = 0; i < n; i++) t.sitDown(i, 'B' + i, 5000, `ai-lr-${v}-${i}`, true);
  t.startNewHand(); let g = 0;
  while (t.currentPhase !== last && g++ < 300) {
    if (DRAW.includes(t.currentPhase)) { for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) t.playerDraw(x.seatIndex, []); continue; }
    const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a);
  }
  expect(t.currentPhase).toBe(last);
  return t;
}
/** Decisions of `arch` holding `h` on the last round: first to act (checked to) and facing a 1-bet. */
function lastRound(v: string, last: any, h: string, arch: string, facingBet: boolean): Record<string, number> {
  const t = driveTo(v, last);
  if (facingBet) { const a = t.activeSeatIndex; expect(t.playerRaise(a, t.getMinRaise())).toBe(true); }
  const me = t.activeSeatIndex; t.seats[me].holeCards = C(h);
  return dist(t, me, prof(arch), 60);
}

describe('B2 / B12: the last betting round (deterministic, 3-handed)', () => {
  const R = PlayerAction.Raise, K = PlayerAction.Check, F = PlayerAction.Fold;
  it('2-7 Triple Draw Bet4: TAG bets 75432 and checks 23456 (a straight); range archetypes fold K-Q-9-8-3 to a bet', () => {
    const restore = detEnv(21);
    try {
      expect(lastRound('triple-draw', GamePhase.Bet4, '7h 5d 4c 3s 2h', 'TAG', false)).toEqual({ [R]: 60 });
      expect(lastRound('triple-draw', GamePhase.Bet4, '2h 3d 4c 5s 6h', 'TAG', false)).toEqual({ [K]: 60 });
      for (const a of ['TAG', 'ROCK', 'NIT', 'LAG']) expect([a, lastRound('triple-draw', GamePhase.Bet4, 'Kh Qd 9c 8s 3h', a, true)]).toEqual([a, { [F]: 60 }]);
    } finally { restore(); }
  }, 120_000);
  it('Badugi Bet4: TAG/ROCK/NIT fold a one-suit A-2-3-4 (a 1-card hand) to a bet', () => {
    const restore = detEnv(22);
    try {
      for (const a of ['TAG', 'ROCK', 'NIT']) expect([a, lastRound('badugi', GamePhase.Bet4, 'Ah 2h 3h 4h', a, true)]).toEqual([a, { [F]: 60 }]);
    } finally { restore(); }
  }, 120_000);
  it('made hands bet when checked to: Stud 7th flush, Five Card Draw pat flush (Bet2), Razz wheel + K-K; Stud 8 TAG never folds A-2-3-4-5', () => {
    const restore = detEnv(23);
    try {
      expect(lastRound('seven-stud', GamePhase.SeventhStreet, 'Ah 2h Kh 9h 5h 3c 7d', 'TAG', false)).toEqual({ [R]: 60 });
      expect(lastRound('five-card-draw', GamePhase.Bet2, 'Ah Jh 8h 5h 2h', 'TAG', false)).toEqual({ [R]: 60 });
      expect(lastRound('razz', GamePhase.SeventhStreet, 'Ah 2c 3d 4s 5h Kc Kd', 'TAG', false)).toEqual({ [R]: 60 });
      expect(lastRound('stud-hi-lo', GamePhase.SeventhStreet, 'Ah 2c 3d 4s 5h Kc Qd', 'TAG', true)[F] || 0).toBe(0);
    } finally { restore(); }
  }, 120_000);
  it('B12: a checked-to TAG on Stud 7th with a weak pair on a paired up-board vs A-K-Q-8 showing sometimes bets (bluff story live; 0dc1b96: 0.00%)', () => {
    const restore = detEnv(24);
    try {
      const t = driveTo('seven-stud', GamePhase.SeventhStreet, 2);
      // pair of sevens, up-board 7-7-J-4 (paired), against an opponent showing A-K-Q-8 (pot share ~0.26: the bluff band)
      const me = t.activeSeatIndex; t.seats[me].holeCards = C('2h 3d 7c 7s Jd 4c 9d'); t.seats[1 - me].holeCards = C('Th 5s Ah Kd Qs 8c 6d');
      const m = dist(t, me, prof('TAG'), 600);
      process.stdout.write(`B12 ${JSON.stringify(m)}\n`);
      expect(m[R] || 0).toBeGreaterThan(0);
      expect(m[R] || 0).toBeLessThan(90);   // a bluff frequency, not a value bet
    } finally { restore(); }
  }, 120_000);
  it('holdemEquivalentStreet: Stud 4th/5th/6th/7th = Flop/Turn/Turn/River; TD/Badugi Bet2/3/4 = Flop/Turn/River; 5CD Bet2 = River; identity without a kind', () => {
    const H = AI.holdemEquivalentStreet;
    expect([GamePhase.FourthStreet, GamePhase.FifthStreet, GamePhase.SixthStreet, GamePhase.SeventhStreet].map((p) => H(p, 'stud-hi')))
      .toEqual([GamePhase.Flop, GamePhase.Turn, GamePhase.Turn, GamePhase.River]);
    expect([GamePhase.Bet2, GamePhase.Bet3, GamePhase.Bet4].map((p) => H(p, 'deuce7'))).toEqual([GamePhase.Flop, GamePhase.Turn, GamePhase.River]);
    expect(H(GamePhase.Bet2, 'draw-hi')).toBe(GamePhase.River);
    for (const p of Object.values(GamePhase)) expect(H(p, null)).toBe(p);
  });
});

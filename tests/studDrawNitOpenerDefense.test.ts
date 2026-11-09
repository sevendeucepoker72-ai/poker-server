/**
 * tests/studDrawNitOpenerDefense.test.ts (2026-11 bots review, fix round 3: the studdraw full-line exploit sweep).
 * A NIT that OPENED (completed / raised first in) and then faces ONE re-raise folded every hand under
 * FOURBET_THRESHOLD on 2b5ac52 (studDrawFirstRound: facingThreeBet && pctile < fourBetTh -> FOLD_VS_RAISE):
 * 3-betting any two cards won +59 BB/100 vs NIT x4 in Five Card Draw (live 0dc1b96: -4) and re-raising any
 * hand every time won +80 BB/100 vs NIT x4 in Badugi (live: +2), measured over whole hands (real engine, bots
 * on every round). Now an opener keeps a share of its opening range: fixed limit all of it, no-limit by the
 * price (B8's DEF3B_* rule), a value-set hand always. Real tables and the real decideAction, deterministic
 * (seeded Math.random, frozen Date.now, seeded deck).
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { PlayerAction, GamePhase } = require('../src/game/PokerTable');
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
  nodeCrypto.randomBytes = (n: number) => { const h = nodeCrypto.createHash('sha256').update(`nitdef-${seed}-${ctr++}`).digest(); return Buffer.concat([h, h, h]).subarray(0, n); };
  let s = seed >>> 0; Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000;
  return () => { nodeCrypto.randomBytes = rb; Math.random = r; Date.now = now; };
}
const live = (o: any = {}) => ({ tableId: 'nd', tableName: 'nd', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000, ...o });
const make: Record<string, () => any> = {
  'five-card-draw': () => new FiveCardDrawTable(live(), false), 'triple-draw': () => new FiveCardDrawTable(live(), true),
  badugi: () => new BadugiTable(live()), 'seven-stud': () => new SevenStudTable(live({ ante: 5 }), false, false),
  'stud-hi-lo': () => new SevenStudTable(live({ ante: 5 }), false, true), razz: () => new SevenStudTable(live({ ante: 5 }), true, false),
};
const nit = (diff = 'hard') => ({ ...AI.generateRandomProfile(diff), archetype: 'NIT', difficulty: diff });
function exec(t: any, s: number, d: any): void {
  const ok = d.action === PlayerAction.Fold ? t.playerFold(s)
    : d.action === PlayerAction.Check ? (t.playerCheck(s) || t.playerFold(s))
      : d.action === PlayerAction.Call ? (t.playerCall(s) || t.playerCheck(s) || t.playerFold(s))
        : d.action === PlayerAction.Raise ? (t.playerRaise(s, d.raiseAmount) || t.playerCall(s) || t.playerCheck(s) || t.playerFold(s))
          : (t.playerAllIn(s) || t.playerFold(s));
  if (!ok) t.playerFold(s);
}

/**
 * 5-handed, seat 0 a human, the rest NIT bots. Deals until the bots open first in (each bot seat that acts
 * before the human decides with the real decideAction); when one OPENS, the human 3-bets (fixed limit: one
 * more bet; Five Card Draw: to 3x the open), the rest fold, and the opener decides. Returns its decisions.
 */
function openerFacing3bet(v: string, opens: number): { folds: number; n: number } {
  const t = make[v](); const profs: any[] = [null];
  for (let i = 0; i < 5; i++) { t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-nd-' : 'ai-nd-') + i, i !== 0); if (i) profs.push(nit()); }
  let folds = 0, n = 0;
  for (let h = 0; n < opens && h < opens * 40; h++) {
    for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = 5000; x.eliminated = false; x.sittingOut = false; }
    if (!t.startNewHand()) break;
    let opener = -1, g = 0;
    while (g++ < 12 && t.activeSeatIndex > 0 && opener < 0) {
      const s = t.activeSeatIndex;
      const d = AI.decideAction(t, s, profs[s]);
      exec(t, s, d);
      if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) opener = s;
    }
    if (opener < 0 || t.activeSeatIndex < 0 || (Number(t.raisesThisStreet) || 0) !== 1 || t.seats[opener].allIn) continue;
    // the human (and only he) re-raises; everyone else between him and the opener folds
    g = 0; while (g++ < 12 && t.activeSeatIndex > 0 && t.activeSeatIndex !== opener) t.playerFold(t.activeSeatIndex);
    if (t.activeSeatIndex !== 0) continue;
    const to = v === 'five-card-draw' ? 3 * t.currentBetToMatch : t.getMinRaise();
    if (!t.playerRaise(0, to)) continue;
    g = 0; while (g++ < 12 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== opener) t.playerFold(t.activeSeatIndex);
    if (t.activeSeatIndex !== opener || (Number(t.raisesThisStreet) || 0) !== 2) continue;
    n++;
    if (AI.decideAction(t, opener, profs[opener]).action === PlayerAction.Fold) folds++;
  }
  return { folds, n };
}

describe('fix round 3: a NIT that opened does not fold most of its range to ONE re-raise', () => {
  it.each([['badugi'], ['triple-draw'], ['seven-stud'], ['stud-hi-lo'], ['razz']])('%s (fixed limit): the opener continues with its opening range (<= 10% folds; 2b5ac52: 85-90%)', (v) => {
    const restore = detEnv(3301);
    try {
      const r = openerFacing3bet(v, 60);
      process.stdout.write(`NIT opener vs one re-raise, ${v}: folds ${r.folds}/${r.n}\n`);
      expect(r.n).toBe(60);
      expect(r.folds / r.n).toBeLessThanOrEqual(0.10);
    } finally { restore(); }
  }, 240_000);

  // Fix round 4 review (regression lens, non-blocking): the opener's ONE re-raise is counted in FULL raises (REG-1,
  // fullRaisesThisRound). A short all-in for less than a full raise between the open and the re-raise is not one:
  // read on the raw raisesThisStreet (3) the NIT folded its opening range again.
  it('Badugi (fixed limit): a short all-in raise for less than a full bet between the open and the re-raise does not make it two re-raises (<= 10% folds)', () => {
    const restore = detEnv(3308);
    try {
      const t = make.badugi(); const profs: any[] = [];   // profs[i] for seat i (seats 0 and 5 are humans)
      for (let i = 0; i < 6; i++) { t.sitDown(i, 'P' + i, 5000, (i === 0 || i === 5 ? 'human-nd-' : 'ai-nd-') + i, !(i === 0 || i === 5)); profs.push(i >= 1 && i <= 4 ? nit() : null); }
      let folds = 0, n = 0;
      for (let h = 0; n < 60 && h < 60 * 60; h++) {
        for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = x.seatIndex === 5 ? 120 : 5000; x.eliminated = false; x.sittingOut = false; }
        if (!t.startNewHand()) break;
        let opener = -1, g = 0, shortOut = false;
        while (g++ < 12 && t.activeSeatIndex > 0 && opener < 0) {
          const s = t.activeSeatIndex;
          if (s === 5) { t.playerFold(5); shortOut = true; continue; }
          const d = AI.decideAction(t, s, profs[s]);
          exec(t, s, d);
          if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) opener = s;
        }
        if (shortOut || opener < 0 || t.activeSeatIndex < 0 || (Number(t.raisesThisStreet) || 0) !== 1 || t.seats[opener].allIn) continue;
        // the short human (120 chips in all: a raise of 20 over the 100 open, under a full 50 bet) moves in, then the deep human re-raises
        g = 0; let shortIn = false;
        while (g++ < 12 && t.activeSeatIndex > 0 && t.activeSeatIndex !== opener) {
          if (t.activeSeatIndex === 5) { if (!t.playerAllIn(5)) break; shortIn = true; } else t.playerFold(t.activeSeatIndex);
        }
        if (!shortIn || t.activeSeatIndex !== 0 || (Number(t.raisesThisStreet) || 0) !== 2) continue;
        if (!t.playerRaise(0, t.getMinRaise())) continue;
        g = 0; while (g++ < 12 && t.activeSeatIndex >= 0 && t.activeSeatIndex !== opener) t.playerFold(t.activeSeatIndex);
        if (t.activeSeatIndex !== opener || (Number(t.raisesThisStreet) || 0) !== 3) continue;
        n++;
        if (AI.decideAction(t, opener, profs[opener]).action === PlayerAction.Fold) folds++;
      }
      process.stdout.write(`NIT opener vs a short all-in raise for less, then one re-raise, badugi: folds ${folds}/${n}\n`);
      expect(n).toBe(60);
      expect(folds / n).toBeLessThanOrEqual(0.10);
    } finally { restore(); }
  }, 240_000);

  it('Five Card Draw (no-limit): vs a 3-bet to 3x the open it keeps its value set and a share by the price (<= 60% folds; 2b5ac52: 82%)', () => {
    const restore = detEnv(3302);
    try {
      const r = openerFacing3bet('five-card-draw', 80);
      process.stdout.write(`NIT opener vs one 3x re-raise, five-card-draw: folds ${r.folds}/${r.n}\n`);
      expect(r.n).toBe(80);
      expect(r.folds / r.n).toBeLessThanOrEqual(0.60);
    } finally { restore(); }
  }, 240_000);

  // Review REG-3: one 300-hand seed is noise (+-15 BB/100, cdb31dd -26..+52 over 7 seeds); this pins the 2b5ac52
  // hole over 1,500 hands pooled. The bound held in 6 of 6 disjoint 5-seed groups (seeds 1-30) on the fix round 4
  // head; with the fixed-limit pot-odds call (studDrawLaterRounds) the line loses there.
  it('Badugi, whole hands: the 2b5ac52 hole stays closed - re-raising any hand at every chance vs NIT x4, pooled over 5 seeds x 300 hands, stays under +30 BB/100 (2b5ac52: +69)', () => {
    let net = 0, hands = 0;
    for (const seed of [3303, 3304, 3305, 3306, 3307]) {
      const restore = detEnv(seed);
      try {
        const t = make.badugi(); const profs: any[] = [null];
        for (let i = 0; i < 5; i++) { t.sitDown(i, 'P' + i, 5000, (i === 0 ? 'human-nd-' : 'ai-nd-') + i, i !== 0); if (i) profs.push(nit()); }
        const DRAW = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
        let seedNet = 0, seedHands = 0;
        for (let h = 0; h < 300; h++) {
          for (const x of t.seats) if (x.state === 'occupied') { x.chipCount = 5000; x.eliminated = false; x.sittingOut = false; }
          if (!t.startNewHand()) break;
          seedHands++;
          let g = 0;
          while (t.isHandInProgress() && g++ < 400) {
            if (DRAW.includes(t.currentPhase)) {
              for (const x of t.seats) if (x.state === 'occupied' && !x.folded && x.holeCards.length && !t.drawsCompleted.has(x.seatIndex)) {
                t.playerDraw(x.seatIndex, SDS.chooseBotDiscards('badugi', x.holeCards, t.currentPhase));
                if (!DRAW.includes(t.currentPhase)) break;
              }
              continue;
            }
            const a = t.activeSeatIndex; if (a < 0) break;
            if (a === 0) { if (!t.playerRaise(0, t.getMinRaise())) { if (!t.playerCall(0)) t.playerCheck(0) || t.playerFold(0); } continue; }
            exec(t, a, AI.decideAction(t, a, profs[a]));
          }
          expect(t.seats.reduce((s: number, x: any) => s + x.chipCount, 0)).toBe(25000);   // chips conserved
          seedNet += t.seats[0].chipCount - 5000;
        }
        process.stdout.write(`Badugi raise-war any hand vs NIT x4, seed ${seed}: ${((100 * seedNet) / seedHands / 50).toFixed(1)} BB/100 over ${seedHands} hands\n`);
        expect(seedHands).toBe(300);
        net += seedNet; hands += seedHands;
      } finally { restore(); }
    }
    const bb100 = (100 * net) / hands / 50;
    process.stdout.write(`Badugi raise-war any hand vs NIT x4, pooled: ${bb100.toFixed(1)} BB/100 over ${hands} hands\n`);
    expect(hands).toBe(1500);
    expect(bb100).toBeLessThan(30);
  }, 1_200_000);
});

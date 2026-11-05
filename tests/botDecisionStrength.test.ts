/**
 * GUARD (bots review 2026-11-04, "dead adjustments"): hard-bot decision strength stays the Monte Carlo equity. Passes on 0dc1b96 too.
 */
import * as AIP from '../src/ai/AIPlayer';
import { GamePhase, PlayerAction } from '../src/game/PokerTable';
import { PokerTable } from '../src/game/PokerTable';
import * as TE from '../src/training/TrainingEngine';

const S: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const cards = (s: string) => s.trim().split(/\s+/).map(t => ({ rank: RK[t[0]] ?? Number(t[0]), suit: S[t[1]] })) as any;
function seedRandom(seed: number): () => void {
  const orig = Math.random; let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}

describe('GUARD — hard-bot decision strength stays Monte Carlo equity (no double-counted multiway / aggression terms)', () => {
  afterEach(() => jest.restoreAllMocks());
  const tag = { botName: 'B', difficulty: 'hard', personality: 'tight', archetype: 'TAG', vpip: .2, pfr: .15, aggressionFactor: 2.5, bluffFrequency: .15 } as any;
  function flopBetRate(players: number): number {
    // calculateEquity is the Monte Carlo the hard tier decides on; pin it so only the adjustments vary.
    jest.spyOn(TE, 'calculateEquity').mockReturnValue(70);
    const restore = seedRandom(99);
    try {
      let bets = 0; const N = 400;
      for (let i = 0; i < N; i++) {
        const t = new PokerTable({ tableId: 'g', tableName: 'g', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 100 } as any);
        for (let s = 0; s < players; s++) t.sitDown(s, 'P' + s, 10000, 'ai-g' + s, true);
        t.startNewHand();
        let g = 0; while (t.currentPhase === GamePhase.PreFlop && g++ < 20) { const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a); }
        const f = t.activeSeatIndex;
        t.communityCards = cards('Kh 7d 2c');
        t.seats[f].holeCards = cards('Ks Qd');
        const d = AIP.decideAction(t, f, tag);
        if (d.action === PlayerAction.Raise || d.action === PlayerAction.AllIn) bets++;
      }
      return bets / N;
    } finally { restore(); }
  }
  it("Hold'em flop, TAG first to act, same equity: bets as often 4-handed as heads-up (the x0.92 multiway term would drop 4-handed to ~0%)", () => {
    const hu = flopBetRate(2), four = flopBetRate(4);
    expect(hu).toBeGreaterThan(0.5);
    expect(four).toBeGreaterThanOrEqual(hu - 0.10);
  });
});

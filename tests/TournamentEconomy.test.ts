/**
 * Tournament economy — funded prize pool (2026-06-11 gameplay audit).
 *
 * The prize pool is FUNDED by collected entry fees (sum of buyIn over paying
 * human entrants), not the advertised template `prizePool`. Payouts are
 * 50/30/20 of the funded pool, so Σpayouts ≤ Σcollected — the tournament can
 * never mint chips. These guards lock that invariant.
 *
 * Run: `npm test` from poker-server/.
 */
import { TournamentManager, DEFAULT_BLIND_LEVELS } from '../src/game/TournamentManager';

function makeTemplate(overrides: Partial<any> = {}): any {
  return {
    name: 'TEST-CUP',
    buyIn: 500,
    prizePool: 999999, // advertised constant — must NOT be what we pay out
    maxPlayers: 9,
    startInterval: 0,
    blindLevels: DEFAULT_BLIND_LEVELS,
    ...overrides,
  };
}

describe('Tournament economy — funded, mint-free prize pool', () => {
  test('collectedEntryFees accrues only for paying (userId) entrants, not AI', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(makeTemplate());
    tm.registerPlayer(id, 'p1', 'Alice', 's1', 101); // paying human
    tm.registerPlayer(id, 'p2', 'Bob', 's2', 102);   // paying human
    tm.registerPlayer(id, 'ai1', 'Bot', 's3');        // AI — no userId
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(1000); // 2×500, AI excluded
  });

  test('a free tournament (buyIn 0) funds no pool', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(makeTemplate({ buyIn: 0 }));
    tm.registerPlayer(id, 'p1', 'A', 's1', 201);
    tm.registerPlayer(id, 'p2', 'B', 's2', 202);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(0);
  });

  test('refundEntryFee backs out a contribution (lockstep with a wallet refund)', () => {
    const tm = new TournamentManager();
    const id = tm.createTournament(makeTemplate());
    tm.registerPlayer(id, 'p1', 'Alice', 's1', 101);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(500);
    tm.refundEntryFee(id, 101);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(0);
    // never goes negative
    tm.refundEntryFee(id, 101);
    expect(tm.getTournament(id)!.collectedEntryFees).toBe(0);
  });

  test('total payouts NEVER exceed collected fees (mint-free invariant) + results carry userId', () => {
    jest.useFakeTimers();
    try {
      const tm = new TournamentManager();
      const id = tm.createTournament(makeTemplate());
      for (let i = 1; i <= 3; i++) tm.registerPlayer(id, `p${i}`, `P${i}`, `s${i}`, 100 + i);
      const collected = tm.getTournament(id)!.collectedEntryFees; // 3×500 = 1500

      let results: any[] = [];
      tm.onEvent(id, (event, data) => { if (event === 'tournamentFinished') results = data.results; });

      tm.startTournament(id);
      // Eliminate down to one survivor → triggers finishTournament synchronously.
      tm.eliminatePlayer(id, 'p1');
      tm.eliminatePlayer(id, 'p2');

      expect(collected).toBe(1500);
      expect(results.length).toBe(3);
      const sumPayouts = results.reduce((s, r) => s + (r.payout || 0), 0);
      expect(sumPayouts).toBeLessThanOrEqual(collected); // the whole point: never mints
      // 50/30/20 of 1500 = 750/450/300 = 1500 distributed (no leak beyond rounding)
      expect(sumPayouts).toBe(1500);
      // every result carries a userId so index.ts can credit the right wallet
      expect(results.every((r) => 'userId' in r)).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('single paying human can only ever win back ≤ their own fee (the documented vs-AI rake)', () => {
    jest.useFakeTimers();
    try {
      const tm = new TournamentManager();
      const id = tm.createTournament(makeTemplate());
      tm.registerPlayer(id, 'human', 'Solo', 's1', 999); // the only payer
      tm.registerPlayer(id, 'ai1', 'Bot1', 's2');         // AI fill (no fee)
      tm.registerPlayer(id, 'ai2', 'Bot2', 's3');
      const collected = tm.getTournament(id)!.collectedEntryFees; // 500 (human only)

      let results: any[] = [];
      tm.onEvent(id, (event, data) => { if (event === 'tournamentFinished') results = data.results; });
      tm.startTournament(id);
      tm.eliminatePlayer(id, 'ai1');
      tm.eliminatePlayer(id, 'ai2'); // human survives → 1st

      const humanPayout = results.find((r) => r.userId === 999)?.payout || 0;
      expect(collected).toBe(500);
      // Pool is only the human's own fee; 1st = 50% of 500 = 250. They can never
      // be credited more than they paid (mint-free). This is the vs-AI "rake"
      // documented for the owner to tune (set vs-AI tournaments to buyIn:0).
      expect(humanPayout).toBeLessThanOrEqual(collected);
      expect(humanPayout).toBe(250);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Staking settlement split (Batch 5c, 2026-07-01 .online audit). Backers who
// bought a % of a player's tournament action must receive their share of the
// prize, and the seller keeps the rest — the total paid must ALWAYS equal the
// prize (chips are never minted or destroyed).
// ─────────────────────────────────────────────────────────────────────────
import { computeStakingSplit } from '../src/game/staking';

describe('Staking split — chip conservation', () => {
  const sum = (s: ReturnType<typeof computeStakingSplit>) =>
    s.sellerAmount + s.backerPayouts.reduce((a, b) => a + b.amount, 0);

  test('conserves the prize exactly across a range of splits', () => {
    const cases: Array<[number, { userId: number; name: string; pct: number }[]]> = [
      [10000, [{ userId: 2, name: 'b1', pct: 50 }]],
      [10000, [{ userId: 2, name: 'b1', pct: 25 }, { userId: 3, name: 'b2', pct: 25 }]],
      [7777,  [{ userId: 2, name: 'b1', pct: 33 }, { userId: 3, name: 'b2', pct: 33 }, { userId: 4, name: 'b3', pct: 34 }]],
      [1,     [{ userId: 2, name: 'b1', pct: 99 }]], // rounding floor → backer 0, seller keeps 1
      [10000, []],                                    // no backers → seller keeps all
    ];
    for (const [payout, backers] of cases) {
      const split = computeStakingSplit(payout, backers);
      expect(sum(split)).toBe(payout);       // exact conservation
      expect(split.sellerAmount).toBeGreaterThanOrEqual(0);
      split.backerPayouts.forEach((b) => expect(b.amount).toBeGreaterThan(0));
    }
  });

  test('oversold action (Σpct > 100) is capped — backers never exceed the prize', () => {
    const split = computeStakingSplit(10000, [
      { userId: 2, name: 'b1', pct: 80 },
      { userId: 3, name: 'b2', pct: 80 }, // 160% sold — must scale to 100%
    ]);
    expect(sum(split)).toBe(10000);
    expect(split.sellerAmount).toBeGreaterThanOrEqual(0);
    const toBackers = split.backerPayouts.reduce((a, b) => a + b.amount, 0);
    expect(toBackers).toBeLessThanOrEqual(10000);
  });

  test('unresolvable backer (userId<=0) is not paid; their share stays with the seller', () => {
    const split = computeStakingSplit(10000, [
      { userId: 0, name: 'ghost', pct: 50 }, // can't resolve → not paid
      { userId: 3, name: 'b2', pct: 25 },
    ]);
    expect(sum(split)).toBe(10000);
    expect(split.backerPayouts.find((b) => b.name === 'ghost')).toBeUndefined();
    expect(split.backerPayouts.find((b) => b.userId === 3)?.amount).toBe(2500);
    expect(split.sellerAmount).toBe(7500); // 10000 - 2500 (ghost's 50% stays with seller)
  });
});

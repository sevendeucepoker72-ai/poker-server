/**
 * 2026-10-11 (.online R2, S1) — when a QUICK game is over (TOURNEY-6 / GAME-7 /
 * ECON-8 / CLUBS-1 + the R1 money reviewer's P2).
 *
 * Every quick format (Heads-Up Snap, Spin & Go, all-in-or-fold, career) and a
 * club challenge is a FIXED-ROSTER game: the seats it started with, no AI
 * reload (index.ts isFixedRosterTable), no rebuy (R1 contract #2). Before R2 a
 * busted bot was reloaded to minBuyIn at every hand boundary, so a heads-up or
 * all-in-or-fold game never ended, a career stage could never be won, a Spin &
 * Go never settled and every "win" was a cash-out of house chips. Now the game
 * is decided by its seats after every hand:
 *   - a vs-bots format is OVER when its human has no chips left (lost — the
 *     bots never play on alone) or only one seat has chips left (that seat
 *     won — the human when he is the one);
 *   - a club challenge (two humans) is OVER when at most one player has chips
 *     (or is still seated: a player who left forfeited the match).
 * Pure: index.ts settles (cash-out / Spin & Go prize / career reward /
 * challenge result) and removes the table.
 */

export type QuickFormat = 'headsUp' | 'spinGo' | 'allInOrFold' | 'career' | 'challenge';

export interface QuickSeatView {
  seatIndex: number;
  state: string;
  isAI: boolean;
  chipCount: number;
  eliminated?: boolean;
}

export type QuickOutcome =
  | { over: false }
  | { over: true; winnerSeat: number | null; humanWon: boolean; reason: 'last_standing' | 'humans_busted' | 'no_players' };

const inPlay = (s: QuickSeatView): boolean => s.state === 'occupied' && !s.eliminated && (s.chipCount || 0) > 0;

export function quickGameOutcome(format: QuickFormat, seats: QuickSeatView[]): QuickOutcome {
  const alive = seats.filter(inPlay);
  if (format === 'challenge') {
    if (alive.length > 1) return { over: false };
    if (alive.length === 0) return { over: true, winnerSeat: null, humanWon: false, reason: 'no_players' };
    return { over: true, winnerSeat: alive[0].seatIndex, humanWon: !alive[0].isAI, reason: 'last_standing' };
  }
  const humansAlive = alive.filter((s) => !s.isAI);
  if (humansAlive.length === 0) {
    return {
      over: true,
      winnerSeat: alive.length === 1 ? alive[0].seatIndex : null,
      humanWon: false,
      reason: alive.length === 0 ? 'no_players' : 'humans_busted',
    };
  }
  if (alive.length <= 1) {
    return { over: true, winnerSeat: alive[0].seatIndex, humanWon: !alive[0].isAI, reason: 'last_standing' };
  }
  return { over: false };
}

/**
 * Spin & Go prize odds (percent of a roll in [0, 100)), top prize first.
 * 2026-11 (bots review, E1): mean 2.90x = 1 / 34.4%, the best simple
 * strategy's win rate against the merged bots (Nash push/fold). HEAD was
 * 2x 60 / 3x 25 / 5x 10 / 10x 4 / 25x 1 (mean 3.10x), which paid that strategy
 * +6.6% per game. The multipliers {2, 3, 5, 10, 25} and the 1% top prize the
 * lobby advertises are unchanged. The pct values sum to 100.
 */
export const SPIN_GO_MULTIPLIER_ODDS: ReadonlyArray<{ multiplier: number; pct: number }> = [
  { multiplier: 25, pct: 1 },
  { multiplier: 10, pct: 3 },
  { multiplier: 5, pct: 7 },
  { multiplier: 3, pct: 22 },
  { multiplier: 2, pct: 67 },
];

/**
 * The Spin & Go prize multiplier for a roll in [0, 100), from
 * SPIN_GO_MULTIPLIER_ODDS: below 1 gives 25x, below 4 gives 10x, below 11
 * gives 5x, below 33 gives 3x, otherwise 2x.
 */
export function spinGoMultiplierFor(roll: number): number {
  let edge = 0;
  for (const o of SPIN_GO_MULTIPLIER_ODDS) {
    edge += o.pct;
    if (roll < edge) return o.multiplier;
  }
  return 2;
}

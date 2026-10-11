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

/** The Spin & Go prize multiplier for a roll in [0, 100): 2x 60%, 3x 25%, 5x 10%, 10x 4%, 25x 1%. */
export function spinGoMultiplierFor(roll: number): number {
  if (roll < 1) return 25;
  if (roll < 5) return 10;
  if (roll < 15) return 5;
  if (roll < 40) return 3;
  return 2;
}

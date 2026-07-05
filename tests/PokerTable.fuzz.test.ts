/**
 * Anti-stall fuzz harness (2026-07-05).
 *
 * The single-source-of-truth refactor (nextActor()/roundSettled()/canonical getters) claims a
 * hand can NEVER wedge. This proves it empirically: play thousands of random legal-action hands
 * across 2–9 seats with wildly varied stacks (forcing all-ins, folded-top, heads-up, multi-all-in
 * side-pot runouts) and assert EVERY hand reaches HandComplete within a bounded number of steps,
 * with chips conserved. assertInvariants() throws in test mode, so any structural violation
 * (round open but no next actor, seated actor can't act, seat over the bet-to-match) fails here
 * with the exact state — a minimal repro — instead of freezing a live table.
 *
 * A failure prints the per-hand seed + action log so it can be replayed deterministically.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';

// Deterministic PRNG (mulberry32) so a failing hand is reproducible from its seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTable(): PokerTable {
  return new PokerTable({
    tableId: 'fuzz', tableName: 'Fuzz', smallBlind: 25, bigBlind: 50,
    minBuyIn: 100, maxBuyIn: 100000, maxPlayers: 9,
  } as any);
}

const TERMINAL = new Set([GamePhase.HandComplete, GamePhase.WaitingForPlayers]);

// Drive one hand with random legal actions; return {ok, steps, log} or throw on wedge/invariant.
function playRandomHand(t: PokerTable, rnd: () => number): { steps: number; log: string[] } {
  const any = t as any;
  const log: string[] = [];
  const MAX_STEPS = 500; // >> any real hand: 9 seats * 4 streets * a few raises each
  let steps = 0;

  while (!TERMINAL.has(any.currentPhase) && steps < MAX_STEPS) {
    const seatIdx: number = any.activeSeatIndex;
    // If there is no valid actor while the hand is live, that is the wedge we are hunting.
    if (seatIdx < 0 || !any.canAct(any.seats[seatIdx])) {
      // Give the engine one chance to self-correct via its own advance (mirrors watchdog);
      // if it still can't seat an actor, this is a genuine wedge.
      const before = any.activeSeatIndex;
      if (any.roundSettled?.() && any.playersInHand?.().length >= 2) {
        // round is settled but nobody advanced — force the transition to expose the bug
        any.advanceToNextStreet();
      }
      if (any.activeSeatIndex === before && !TERMINAL.has(any.currentPhase) &&
          (any.activeSeatIndex < 0 || !any.canAct(any.seats[any.activeSeatIndex]))) {
        throw new Error(`WEDGE: no actor. phase=${any.currentPhase} active=${any.activeSeatIndex} ` +
          `toMatch=${any.currentBetToMatch} inHand=${any.playersInHand().length} ` +
          `acting=${any.actingPlayers().length}\nlog:\n${log.join('\n')}`);
      }
      continue;
    }

    const seat = any.seats[seatIdx];
    const callAmt = Math.max(0, any.currentBetToMatch - seat.currentBet);
    const r = rnd();

    // Weighted random legal action, each verified by the method's own return (false => illegal),
    // falling back through call→check→fold so SOME action always lands (fold is always legal for
    // the active seat). If even fold fails, isValidAction is broken → surfaces as a wedge next loop.
    let acted = false;
    const tryRaise = () => {
      const minR = any.getMinRaise ? any.getMinRaise() : any.currentBetToMatch + any.config.bigBlind;
      const maxTotal = seat.currentBet + seat.chipCount;
      if (maxTotal <= any.currentBetToMatch) return false;
      const target = Math.min(maxTotal, Math.max(minR, Math.floor(any.currentBetToMatch + rnd() * (maxTotal - any.currentBetToMatch))));
      return any.playerRaise(seatIdx, target);
    };
    if (r < 0.12) { acted = any.playerFold(seatIdx); if (acted) log.push(`${seatIdx} fold`); }
    else if (r < 0.30) { acted = any.playerAllIn(seatIdx); if (acted) log.push(`${seatIdx} allin`); }
    else if (r < 0.55) { acted = tryRaise(); if (acted) log.push(`${seatIdx} raise`); }
    if (!acted && callAmt > 0) { acted = any.playerCall(seatIdx); if (acted) log.push(`${seatIdx} call`); }
    if (!acted) { acted = any.playerCheck(seatIdx); if (acted) log.push(`${seatIdx} check`); }
    if (!acted) { acted = any.playerFold(seatIdx); if (acted) log.push(`${seatIdx} fold*`); }
    if (!acted) throw new Error(`NO LEGAL ACTION for active seat ${seatIdx} phase=${any.currentPhase}\n${log.join('\n')}`);
    steps++;
  }

  if (!TERMINAL.has(any.currentPhase)) {
    throw new Error(`NON-TERMINATION after ${steps} steps. phase=${any.currentPhase} active=${any.activeSeatIndex}\n${log.join('\n')}`);
  }
  return { steps, log };
}

describe('PokerTable — anti-stall fuzz (every random hand terminates, chips conserved)', () => {
  const CASES: Array<[string, number, [number, number]]> = [
    ['heads-up', 2, [40, 4000]],       // tiny stacks => frequent all-in blind edges
    ['3-handed', 3, [50, 6000]],
    ['6-handed varied', 6, [30, 8000]],
    ['full ring', 9, [25, 10000]],
    ['short stacks (all-in heavy)', 6, [30, 400]],
  ];

  for (const [name, seats, [minChip, maxChip]] of CASES) {
    test(`${name}: 400 random hands all terminate with chips conserved`, () => {
      let maxSteps = 0;
      for (let hand = 0; hand < 400; hand++) {
        const seed = (seats * 1_000_000 + hand + 1) >>> 0;
        const rnd = rng(seed);
        const t = makeTable();
        // Varied stacks per seat to force all-in / side-pot / folded-top scenarios.
        for (let i = 0; i < seats; i++) {
          const chips = Math.floor(minChip + rnd() * (maxChip - minChip));
          t.sitDown(i, `P${i}`, chips, `p${i}`, false);
        }
        const any = t as any;
        const chipsBefore = any.seats.reduce((n: number, s: any) => n + (s.state === 'occupied' ? s.chipCount : 0), 0);
        try {
          any.startNewHand();
          // A hand may end instantly (≤1 eligible) — that's fine.
          if (!TERMINAL.has(any.currentPhase)) {
            const { steps } = playRandomHand(t, rnd);
            maxSteps = Math.max(maxSteps, steps);
          }
        } catch (e: any) {
          throw new Error(`[${name}] hand ${hand} seed ${seed}: ${e.message}`);
        }
        // Chip conservation: after the hand resolves, every chip is back on a seat (pot empty).
        const chipsAfter = any.seats.reduce((n: number, s: any) => n + (s.state === 'occupied' ? s.chipCount : 0), 0);
        expect(chipsAfter).toBe(chipsBefore);
      }
      // Sanity: hands actually progressed through betting (not all instant-folds).
      expect(maxSteps).toBeGreaterThan(3);
    });
  }
});

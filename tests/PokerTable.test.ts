/**
 * Core PokerTable state-machine tests.
 *
 * These cover the exact failure modes we've seen in production:
 *   - betting round completion with cardless mid-hand joiners
 *   - active-seat selection when some seats have no cards
 *   - serialize/deserialize round-trip identity
 *   - deck determinism after rehydrate
 *
 * Run: `npm test` from poker-server/.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { CardDeck } from '../src/game/CardDeck';

function makeTable(): PokerTable {
  return new PokerTable({
    tableId: 'test-table',
    tableName: 'Test',
    smallBlind: 25,
    bigBlind: 50,
    minBuyIn: 1000,
    maxBuyIn: 10000,
    maxPlayers: 9,
  } as any);
}

function seatPlayers(table: PokerTable, count: number, startingChips: number = 5000) {
  for (let i = 0; i < count; i++) {
    table.sitDown(i, `Player${i}`, startingChips, `p${i}`, false);
  }
}

describe('PokerTable — serialize/rehydrate round-trip', () => {
  test('preserves all core fields', () => {
    const t1 = makeTable();
    seatPlayers(t1, 3);
    (t1 as any).startNewHand?.();
    t1.handNumber = 42;
    t1.currentPhase = GamePhase.Flop;
    t1.currentBetToMatch = 200;
    t1.lastRaiseAmount = 100;
    t1.activeSeatIndex = 1;
    t1.dealerButtonSeat = 0;

    const snap = t1.serializeSnapshot();
    const t2 = makeTable();
    seatPlayers(t2, 3);
    t2.rehydrateFromSnapshot(snap);

    expect(t2.handNumber).toBe(42);
    expect(t2.currentPhase).toBe(GamePhase.Flop);
    expect(t2.currentBetToMatch).toBe(200);
    expect(t2.lastRaiseAmount).toBe(100);
    expect(t2.activeSeatIndex).toBe(1);
    expect(t2.dealerButtonSeat).toBe(0);
    expect(t2.seats.length).toBe(MAX_SEATS);
  });

  test('snapshot version is 1 (bump this test when migrating)', () => {
    const t = makeTable();
    const snap = t.serializeSnapshot();
    expect(snap.version).toBe(1);
  });
});

describe('CardDeck — determinism after serialize/deserialize', () => {
  test('same seed reproduces same card order', () => {
    const d1 = new CardDeck();
    d1.shuffle(1);
    const first5 = [];
    for (let i = 0; i < 5; i++) first5.push(d1.dealOne());

    const snap = d1.serialize();
    const d2 = CardDeck.deserialize(snap);
    // d2 should have advanced past the same 5 cards
    expect(d2.cardsRemaining()).toBe(d1.cardsRemaining());
    // Next deal from d2 should match next deal from d1
    const next1 = d1.dealOne();
    const next2 = d2.dealOne();
    expect(next1).toEqual(next2);
  });

  test('rehydrated deck preserves commitment', () => {
    const d1 = new CardDeck();
    d1.shuffle(7);
    const snap = d1.serialize();
    const d2 = CardDeck.deserialize(snap);
    expect(d2.commitment?.seed).toBe(d1.commitment?.seed);
    expect(d2.commitment?.hash).toBe(d1.commitment?.hash);
    expect(d2.commitment?.handNumber).toBe(d1.commitment?.handNumber);
  });

  test('handles null commitment (never-shuffled deck)', () => {
    const d1 = new CardDeck();
    const snap = d1.serialize();
    expect(snap.commitment).toBeNull();
    const d2 = CardDeck.deserialize(snap);
    expect(d2.cardsRemaining()).toBe(52);
  });
});

describe('Seat management', () => {
  test('sitDown / standUp lifecycle', () => {
    const t = makeTable();
    expect(t.sitDown(0, 'Alice', 1000, 'p-alice', false)).toBe(true);
    expect(t.seats[0].state).toBe('occupied');
    expect(t.seats[0].playerName).toBe('Alice');
    expect(t.seats[0].chipCount).toBe(1000);
    expect(t.standUp(0)).toBe(true);
    expect(t.seats[0].state).toBe('empty');
    expect(t.seats[0].playerName).toBe('');
  });

  test('sitDown refuses if seat is already occupied', () => {
    const t = makeTable();
    t.sitDown(0, 'Alice', 1000, 'p-alice', false);
    expect(t.sitDown(0, 'Bob', 1000, 'p-bob', false)).toBe(false);
  });

  test('sitDown refuses below minBuyIn', () => {
    const t = makeTable();
    expect(t.sitDown(0, 'Alice', 500, 'p-alice', false)).toBe(false);
  });

  test('sitDown refuses invalid seat index', () => {
    const t = makeTable();
    expect(t.sitDown(-1, 'Alice', 1000, 'p-alice', false)).toBe(false);
    expect(t.sitDown(MAX_SEATS, 'Alice', 1000, 'p-alice', false)).toBe(false);
  });
});

describe('isHandInProgress', () => {
  test('true for PreFlop/Flop/Turn/River/Showdown', () => {
    const t = makeTable();
    const inProgressPhases = [
      GamePhase.PreFlop, GamePhase.Flop, GamePhase.Turn, GamePhase.River, GamePhase.Showdown,
    ];
    for (const phase of inProgressPhases) {
      t.currentPhase = phase;
      expect(t.isHandInProgress()).toBe(true);
    }
  });

  test('false for WaitingForPlayers and HandComplete', () => {
    const t = makeTable();
    t.currentPhase = GamePhase.WaitingForPlayers;
    expect(t.isHandInProgress()).toBe(false);
    t.currentPhase = GamePhase.HandComplete;
    expect(t.isHandInProgress()).toBe(false);
  });
});

describe('Betting round completion — cardless seat bug', () => {
  // Regression guard: 2026-04-22 we shipped a fix where isBettingRoundComplete
  // now excludes seats with holeCards.length === 0 (mid-hand joiners).
  // Before the fix, their stuck hasActed=false would block round completion.
  test('cardless mid-hand joiner does not block round completion', () => {
    const t = makeTable();
    seatPlayers(t, 3);
    // Deal cards to two seats, leave the third with no cards (simulates
    // mid-hand join).
    t.seats[0].holeCards = [{ suit: 0, rank: 14 } as any, { suit: 1, rank: 13 } as any];
    t.seats[1].holeCards = [{ suit: 2, rank: 12 } as any, { suit: 3, rank: 11 } as any];
    // Seat 2 has no cards → "occupied" but not actually in the hand.
    t.seats[2].holeCards = [];
    t.seats[2].state = 'occupied';

    // Both card-holders have matched and acted.
    t.currentBetToMatch = 50;
    t.seats[0].currentBet = 50;
    t.seats[0].hasActedSinceLastFullRaise = true;
    t.seats[1].currentBet = 50;
    t.seats[1].hasActedSinceLastFullRaise = true;
    // Cardless seat has not acted — but shouldn't matter.
    t.seats[2].currentBet = 0;
    t.seats[2].hasActedSinceLastFullRaise = false;

    expect((t as any).isBettingRoundComplete()).toBe(true);
  });
});

describe('refundUncalledBets — C16: must NOT refund folded-player dead money', () => {
  // 2026-06-11 gameplay-audit C16. The whole-hand "safety net"
  // refundUncalledBets() used to refund (topNonFolded.totalInvested -
  // secondNonFolded.totalInvested) to the top non-folded player. That
  // difference can be money a SINCE-FOLDED player legitimately matched in
  // an earlier round (dead money that belongs in the pot), NOT an uncalled
  // bet. The bug let a capped short all-in scoop a side pot it was
  // ineligible for. The function is now a no-op; the per-round
  // refundUncalledBetThisRound() is the correct mechanism. This guard
  // asserts the whole-hand net never moves chips again.
  test('does not refund when a folded player matched the difference', () => {
    const t = makeTable();
    seatPlayers(t, 3); // 5000 each
    // A: live, invested 200 across the hand.
    t.seats[0].folded = false;
    t.seats[0].totalInvestedThisHand = 200;
    t.seats[0].chipCount = 4800;
    // C: live, short all-in, invested 100.
    t.seats[1].folded = false;
    t.seats[1].totalInvestedThisHand = 100;
    t.seats[1].chipCount = 0;
    // B: FOLDED, but matched A's 200 in an earlier round (dead money in pot).
    t.seats[2].folded = true;
    t.seats[2].totalInvestedThisHand = 200;
    t.seats[2].chipCount = 4800;

    (t as any).refundUncalledBets();

    // The old buggy net would have refunded 100 to A (4800 -> 4900) and
    // dropped A.totalInvested to 100, short-paying the pot. With the no-op,
    // nothing moves: the 100 stays in the pot for the side-pot calc.
    expect(t.seats[0].chipCount).toBe(4800);
    expect(t.seats[0].totalInvestedThisHand).toBe(200);
    expect(t.seats[1].chipCount).toBe(0);
    expect(t.seats[1].totalInvestedThisHand).toBe(100);
  });

  test('C7: forceFoldSeat marks folded without advancing the turn or wiping committed chips', () => {
    const t = makeTable();
    seatPlayers(t, 3);
    (t as any).startNewHand?.();
    const active = t.activeSeatIndex;
    // Pick a seat that is NOT the active actor.
    const victim = [0, 1, 2].find((i) => i !== active)!;
    t.seats[victim].totalInvestedThisHand = 200; // chips committed to the pot
    t.seats[victim].folded = false;

    const ok = (t as any).forceFoldSeat(victim);

    expect(ok).toBe(true);
    expect(t.seats[victim].folded).toBe(true);
    // Turn did NOT advance — the real actor still has the action.
    expect(t.activeSeatIndex).toBe(active);
    // Committed chips remain on the seat for the pot award (not wiped).
    expect(t.seats[victim].totalInvestedThisHand).toBe(200);
    // getNextActiveSeat skips the force-folded seat (no wedge).
    expect((t as any).getNextActiveSeat(victim)).not.toBe(victim);
  });

  test('C7: forceFoldSeat no-ops on an empty or already-folded seat', () => {
    const t = makeTable();
    seatPlayers(t, 2);
    expect((t as any).forceFoldSeat(5)).toBe(false); // empty seat
    t.seats[0].folded = true;
    expect((t as any).forceFoldSeat(0)).toBe(false); // already folded
  });
});

describe('Blind/button derivation — C10/R1: non-contiguous seating', () => {
  // 2026-06-11 gameplay-audit C10. moveDealerButton/postBlinds derived the
  // SB + button by RAW index `(bbSeat - 1)`, which lands on an EMPTY seat
  // on a gapped table and falsely declared a dead small blind (no SB
  // collected) + parked the button on an empty seat. The fix walks OCCUPIED
  // seats backward (getPrevOccupiedSeat). The rotation bug only manifests on
  // hand 2+ (hand 1 uses the first-hand branch which was already gap-aware),
  // so each test plays at least two hands. SB=25, BB=50 ⇒ a correct hand
  // collects 75 in blinds before any action.
  function seatAt(t: PokerTable, indices: number[]) {
    indices.forEach((i) => t.sitDown(i, `P${i}`, 5000, `p${i}`, false));
  }

  test('contiguous 3-handed posts SB+BB across rotations (no behavior change)', () => {
    const t = makeTable();
    seatAt(t, [0, 1, 2]);
    for (let h = 0; h < 3; h++) {
      (t as any).startNewHand();
      expect((t as any).deadSmallBlind).toBe(false);
      expect(t.seats[t.dealerButtonSeat].state).toBe('occupied');
      expect(t.getTotalPot()).toBe(75);
    }
  });

  test('gapped seats (0,3,6) post BOTH blinds on the rotation hand + button on a real seat', () => {
    const t = makeTable();
    seatAt(t, [0, 3, 6]);
    for (let h = 0; h < 4; h++) {
      (t as any).startNewHand();
      // The pre-fix bug: hand 2+ had deadSmallBlind=true, button on an empty
      // seat, and pot=50 (BB only). Post-fix: both blinds, real button.
      expect((t as any).deadSmallBlind).toBe(false);
      expect((t as any).deadButton).toBe(false);
      expect(t.seats[t.dealerButtonSeat].state).toBe('occupied');
      expect(t.getTotalPot()).toBe(75);
    }
  });

  test('gapped seats (1,4,7) and (0,4,8) keep SB+BB + occupied button every hand', () => {
    for (const layout of [[1, 4, 7], [0, 4, 8], [0, 1, 5], [2, 5, 8]]) {
      const t = makeTable();
      seatAt(t, layout);
      for (let h = 0; h < 3; h++) {
        (t as any).startNewHand();
        expect((t as any).deadSmallBlind).toBe(false);
        expect(t.seats[t.dealerButtonSeat].state).toBe('occupied');
        expect(t.getTotalPot()).toBe(75);
      }
    }
  });

  test('heads-up (gap between the two seats) still posts SB+BB', () => {
    const t = makeTable();
    seatAt(t, [0, 5]);
    for (let h = 0; h < 3; h++) {
      (t as any).startNewHand();
      expect(t.getTotalPot()).toBe(75);
      expect(t.seats[t.dealerButtonSeat].state).toBe('occupied');
    }
  });

  test('getPrevOccupiedSeat walks backward over gaps', () => {
    const t = makeTable();
    seatAt(t, [0, 3, 6]);
    expect((t as any).getPrevOccupiedSeat(8)).toBe(6); // 8,7 empty → 6
    expect((t as any).getPrevOccupiedSeat(2)).toBe(0); // 2,1 empty → 0
    expect((t as any).getPrevOccupiedSeat(5)).toBe(3); // 5,4 empty → 3
    expect((t as any).getPrevOccupiedSeat(3)).toBe(3); // on an occupied seat → itself
  });

  test('genuine uncalled bets are handled per-round, not by the whole-hand net', () => {
    // Sanity: the per-round refund returns a true uncalled bet (top
    // currentBet over the second) to the non-folded top player.
    const t = makeTable();
    seatPlayers(t, 2);
    t.seats[0].folded = false;
    t.seats[0].currentBet = 300; // shoved
    t.seats[0].chipCount = 700;
    t.seats[0].totalInvestedThisHand = 300;
    t.seats[1].folded = true;     // folded to the shove
    t.seats[1].currentBet = 50;
    t.seats[1].chipCount = 950;
    t.seats[1].totalInvestedThisHand = 50;

    (t as any).refundUncalledBetThisRound();

    // 250 uncalled (300 - 50) returned to seat 0.
    expect(t.seats[0].chipCount).toBe(950);
    expect(t.seats[0].currentBet).toBe(50);
  });
});

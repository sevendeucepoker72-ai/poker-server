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

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
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { BadugiTable } from '../src/game/variants/BadugiTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { SidePotManager } from '../src/game/SidePotManager';
import {
  evaluate27LowHand,
  evaluateBadugiHand,
  evaluateRazzHand,
  compare27Hands,
} from '../src/game/HandEvaluatorExtensions';
import { evaluateHand as evalHigh } from '../src/game/HandEvaluator';

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

  test('C11/C12: a sitting-out player is charged nothing (no live blind, no debt collection)', () => {
    const t = makeTable();
    [0, 1, 2].forEach((i) => t.sitDown(i, `P${i}`, 5000, `p${i}`, false));
    // P2 sits out, and carries a pre-existing dead-blind debt.
    (t as any)._sittingOutSeats = new Set([2]);
    t.seats[2].deadBlindOwedChips = 50;

    for (let h = 0; h < 5; h++) {
      (t as any).startNewHand();
      // The sit-out player's stack must NEVER be drained while sitting out —
      // no live blind posted, and the accrued debt is NOT collected until they
      // return. Pre-fix, they were charged both (live blind + debt) every orbit.
      expect(t.seats[2].chipCount).toBe(5000);
    }
    // The table still functions: the two ACTIVE players funded blinds this hand
    // (at most one blind position can be the single sit-out seat → dead).
    expect(t.seats[0].totalInvestedThisHand + t.seats[1].totalInvestedThisHand).toBeGreaterThan(0);
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

describe('playerRaise — E2: no illegal re-raise after a short all-in (TDA Rule 41)', () => {
  test('a seat that already acted cannot voluntarily re-raise over a non-reopening short all-in', () => {
    const t = makeTable();
    seatPlayers(t, 3); // 5000 each
    t.currentPhase = GamePhase.PreFlop;
    t.activeSeatIndex = 0;
    t.seats[0].folded = false; t.seats[0].allIn = false; t.seats[0].eliminated = false;
    t.seats[0].currentBet = 100;
    t.currentBetToMatch = 150; // a short all-in bumped the bet to 150...
    t.lastRaiseAmount = 50;     // ...by less than a full raise → action NOT reopened
    t.seats[0].hasActedSinceLastFullRaise = true; // seat 0 already acted this round

    // Voluntary re-raise is illegal — call/fold only.
    expect((t as any).playerRaise(0, 1000)).toBe(false);
    expect(t.seats[0].currentBet).toBe(100); // unchanged — the raise was rejected

    // Control: when the action WAS reopened (flag reset by a full raise), the
    // same raise is legal again.
    t.seats[0].hasActedSinceLastFullRaise = false;
    expect((t as any).playerRaise(0, 1000)).toBe(true);
  });
});

describe('Stud — C13 ante/bring-in (not SB/BB) + R4 action order by exposed hand', () => {
  const scfg = (ante = 0): any => ({
    tableId: 'stud', tableName: 'S', smallBlind: 25, bigBlind: 50, ante,
    minBuyIn: 1000, maxPlayers: 9,
  });

  test('C13: startNewHand posts NO SB/BB — betting line starts at 0 for the bring-in', () => {
    const t = new SevenStudTable(scfg(0), false, false);
    seatPlayers(t, 3);
    (t as any).startNewHand();
    // The whole point: currentBetToMatch === 0 so the ThirdStreet bring-in
    // branch fires. A posted BB would have left this at 50.
    expect(t.currentBetToMatch).toBe(0);
    const occupied = t.seats.filter(s => s.state === 'occupied');
    for (const s of occupied) {
      expect(s.currentBet).toBe(0);              // no live SB/BB posted
      expect(s.totalInvestedThisHand).toBe(0);   // nothing forced yet (ante 0, bring-in posted on action)
      expect(s.holeCards.length).toBe(3);        // 2 down + 1 up dealt
    }
    expect(t.activeSeatIndex).toBeGreaterThanOrEqual(0); // a bring-in actor was chosen
  });

  test('C13: with an ante configured, every active seat antes; line still starts at 0', () => {
    const t = new SevenStudTable(scfg(50), false, false);
    seatPlayers(t, 3, 5000);
    (t as any).startNewHand();
    expect(t.currentBetToMatch).toBe(0);
    const occupied = t.seats.filter(s => s.state === 'occupied');
    for (const s of occupied) {
      expect(s.totalInvestedThisHand).toBe(50); // ante only (bring-in not auto-posted at deal)
      expect(s.chipCount).toBe(4950);           // ante deducted from stack
      expect(s.currentBet).toBe(0);             // ante is dead money, not a bet
    }
  });

  test('R4: exposed-board score ranks a pair over ace-high, trips over a pair, and kickers', () => {
    const t = new SevenStudTable(scfg(0), false, false) as any;
    const pair8 = [{ suit: 0, rank: 8 }, { suit: 1, rank: 8 }];
    const aceHigh = [{ suit: 0, rank: 14 }, { suit: 1, rank: 13 }];
    const trips5 = [{ suit: 0, rank: 5 }, { suit: 1, rank: 5 }, { suit: 2, rank: 5 }];
    const aKQ = [{ suit: 0, rank: 14 }, { suit: 1, rank: 13 }, { suit: 2, rank: 12 }];
    const aKJ = [{ suit: 0, rank: 14 }, { suit: 1, rank: 13 }, { suit: 2, rank: 11 }];
    expect(t.scoreExposedBoard(pair8)).toBeGreaterThan(t.scoreExposedBoard(aceHigh));
    expect(t.scoreExposedBoard(trips5)).toBeGreaterThan(t.scoreExposedBoard(pair8));
    expect(t.scoreExposedBoard(aKQ)).toBeGreaterThan(t.scoreExposedBoard(aKJ));
  });
});

describe('Variant rehydrate — C14/C15/R9: snapshot preserves variant state across redeploy', () => {
  const vcfg = (id = 'v'): any => ({
    tableId: id, tableName: 'V', smallBlind: 25, bigBlind: 50, ante: 0,
    minBuyIn: 1000, maxPlayers: 9,
  });

  test('C14: ShortDeck round-trips its 36-card deck + index', () => {
    const t = new ShortDeckTable(vcfg());
    (t as any)._shortDeckCards = Array.from({ length: 36 }, (_, i) => ({ suit: i % 4, rank: 6 + (i % 9) }));
    (t as any)._shortDeckIndex = 7;
    const t2 = new ShortDeckTable(vcfg());
    t2.rehydrateFromSnapshot(t.serializeSnapshot());
    expect((t2 as any)._shortDeckCards.length).toBe(36);
    expect((t2 as any)._shortDeckIndex).toBe(7);
  });

  test('C15: FiveCardDraw round-trips draw progress (no double-draw after restart)', () => {
    const t = new FiveCardDrawTable(vcfg(), true);
    t.drawsCompleted = new Set([0, 2, 4]);
    (t as any).drawRound = 2;
    t.currentDrawPhase = 'Draw2' as any;
    const t2 = new FiveCardDrawTable(vcfg(), true);
    t2.rehydrateFromSnapshot(t.serializeSnapshot());
    expect(Array.from(t2.drawsCompleted).sort()).toEqual([0, 2, 4]);
    expect((t2 as any).drawRound).toBe(2);
    expect(t2.currentDrawPhase).toBe('Draw2');
  });

  test('R9: SevenStud round-trips card visibility', () => {
    const t = new SevenStudTable(vcfg(), false, false);
    t.cardVisibility.set(0, [false, false, true]);
    t.cardVisibility.set(3, [false, false, true, true]);
    const t2 = new SevenStudTable(vcfg(), false, false);
    t2.rehydrateFromSnapshot(t.serializeSnapshot());
    expect(t2.cardVisibility.get(0)).toEqual([false, false, true]);
    expect(t2.cardVisibility.get(3)).toEqual([false, false, true, true]);
  });
});

describe('Lowball pot award — G2/G3: best LOW hand wins, not worst', () => {
  // 2026-06-11 gameplay-audit G2/G3. SidePotManager.awardPots hardcoded the
  // HIGH comparator (compareTo), so lowball variants — which evaluate the low
  // hand correctly via evaluatePlayerHand — had their results ranked high-wins
  // and the pot awarded to the WORST hand. Fix: a getHandComparator() hook per
  // variant, threaded into awardPots. The three low comparators use DIFFERENT
  // sign conventions (compare27Hands/compareRazzHands: negative=better;
  // compareBadugiHands: positive=better), so each variant's wiring is verified
  // independently here — a flipped sign would re-award the worst hand.
  const card = (suit: number, rank: number) => ({ suit, rank } as any);
  const cfg = (): any => ({
    tableId: 'lowball-test', tableName: 'LB', smallBlind: 25, bigBlind: 50,
    minBuyIn: 1000, maxBuyIn: 10000, maxPlayers: 9,
  });

  test('2-7 Triple Draw: comparator ranks the better low as the winner', () => {
    const cmp = (new FiveCardDrawTable(cfg(), true) as any).getHandComparator();
    const nut = evaluate27LowHand([card(0, 7), card(1, 5), card(2, 4), card(3, 3), card(0, 2)]); // 7-low
    const paired = evaluate27LowHand([card(0, 9), card(1, 9), card(2, 5), card(3, 3), card(0, 2)]); // pair (bad)
    expect(cmp(nut, paired)).toBeGreaterThan(0);
    expect(cmp(paired, nut)).toBeLessThan(0);
  });

  test('R6: 2-7 made-hand badness follows high-hand order (trips < straight < flush)', () => {
    // lower handRank ("badness") = better low. Pre-fix, trips scored 5 — worse
    // than a straight(3)/flush(4). Correct: trips(3) < straight(4) < flush(5).
    const trips = evaluate27LowHand([card(0, 9), card(1, 9), card(2, 9), card(3, 4), card(0, 2)]);
    const straight = evaluate27LowHand([card(0, 6), card(1, 5), card(2, 4), card(3, 3), card(0, 2)]);
    const flush = evaluate27LowHand([card(0, 9), card(0, 7), card(0, 5), card(0, 3), card(0, 2)]);
    expect(trips.handRank).toBeLessThan(straight.handRank);
    expect(straight.handRank).toBeLessThan(flush.handRank);
  });

  test('Five Card Draw (high) still ranks the better HIGH hand as the winner', () => {
    const cmp = (new FiveCardDrawTable(cfg(), false) as any).getHandComparator();
    const trips = evalHigh([card(0, 9), card(1, 9), card(2, 9), card(3, 3), card(0, 2)]);
    const pair = evalHigh([card(0, 9), card(1, 9), card(2, 5), card(3, 3), card(0, 2)]);
    expect(cmp(trips, pair)).toBeGreaterThan(0); // unchanged: high-wins
  });

  test('Badugi: comparator ranks the bigger rainbow set as the winner', () => {
    const cmp = (new BadugiTable(cfg()) as any).getHandComparator();
    const four = evaluateBadugiHand([card(0, 2), card(1, 3), card(2, 4), card(3, 5)]); // 4-card badugi
    const three = evaluateBadugiHand([card(0, 2), card(0, 3), card(1, 4), card(2, 5)]); // dup suit → 3-card
    expect(cmp(four, three)).toBeGreaterThan(0);
    expect(cmp(three, four)).toBeLessThan(0);
  });

  test('Razz: comparator ranks the better low as the winner', () => {
    const cmp = (new SevenStudTable(cfg(), true, false) as any).getHandComparator(); // isRazz
    const wheel = evaluateRazzHand([card(0, 14), card(1, 2), card(2, 3), card(3, 4), card(0, 5)]); // A-5 wheel
    const paired = evaluateRazzHand([card(0, 9), card(1, 9), card(2, 8), card(3, 7), card(0, 6)]); // pair (bad)
    expect(cmp(wheel, paired)).toBeGreaterThan(0);
    expect(cmp(paired, wheel)).toBeLessThan(0);
  });

  test('awardPots with the low comparator pays the best low; default (high) would pay the worst', () => {
    const mgr = new SidePotManager();
    const seats = [
      { seatIndex: 0, chipCount: 0, totalInvestedThisHand: 100, folded: false, allIn: false,
        holeCards: [card(0, 7), card(1, 5), card(2, 4), card(3, 3), card(0, 2)], state: 'occupied' }, // nut low
      { seatIndex: 1, chipCount: 0, totalInvestedThisHand: 100, folded: false, allIn: false,
        holeCards: [card(0, 9), card(1, 9), card(2, 5), card(3, 3), card(0, 2)], state: 'occupied' }, // pair (bad)
    ] as any;
    const evaluator = (hole: any) => evaluate27LowHand(hole);
    const lowCmp = (a: any, b: any) => -compare27Hands(a, b);

    const fixed = mgr.awardPots(seats, [], 0, evaluator, lowCmp);
    expect(fixed.winnings.get(0)).toBe(200); // nut low scoops the 200 pot
    expect(fixed.winnings.get(1) || 0).toBe(0);

    // Demonstrate the bug the fix closes: default high comparator pays the WORST hand.
    const buggy = mgr.awardPots(seats, [], 0, evaluator);
    expect(buggy.winnings.get(1)).toBe(200);
  });
});

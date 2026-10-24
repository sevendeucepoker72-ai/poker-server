/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F4) — a pot tier
 * only a FOLDED player contributed to is returned to him as an uncalled bet,
 * never awarded to a live seat.
 *
 * Evidence hand 11 of the 9-player Sit & Go (500/1000 ante 100): the big blind
 * (Dominic, 2,635) folded with a free check facing two short all-ins (Wesley
 * 740, Collin 895). The 105 of his big blind nobody matched went into Collin's
 * side pot (415) instead of back to him (Side Pot 2 should have been 310;
 * Dominic should have ended at 1,640, not 1,535).
 *
 * Rule (SidePotManager.unmatchedFoldedExcess, applied by refundUncalledBets
 * before any pot math in every determineWinners — Hold'em, Omaha, Stud): when
 * EVERY seat still in the hand is all-in, each folded seat's LIVE investment
 * (dead blinds excluded) above the largest contender's live investment is
 * returned to it, logged `uncalled bet (N) returned`. A live seat that is not
 * all-in can win every tier, so nothing is returned then (the F22 leaver rule:
 * his unmatched bet stays dead money). Chips are conserved.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SidePotManager, SeatInfo } from '../src/game/SidePotManager';

const si = (seatIndex: number, invested: number, o: Partial<SeatInfo> = {}): SeatInfo => ({
  seatIndex, chipCount: 0, totalInvestedThisHand: invested, folded: false, allIn: false, holeCards: [], state: 'occupied', ...o,
});

describe('F4 — SidePotManager.unmatchedFoldedExcess', () => {
  const fx = (seats: SeatInfo[]) => (SidePotManager as any).unmatchedFoldedExcess(seats);
  it('hand 11 shape: contenders all-in at 195 / 840 / 995, the folded big blind at 1,100 → 105 back to him', () => {
    expect(fx([si(0, 0, { folded: true }), si(3, 195, { allIn: true }), si(4, 1100, { folded: true }), si(5, 840, { allIn: true }), si(7, 100, { folded: true }), si(8, 995, { allIn: true })]))
      .toEqual([{ seatIndex: 4, amount: 105 }]);
  });
  it('a live seat that is NOT all-in contests every tier: nothing is returned (F22)', () => {
    expect(fx([si(1, 600, { folded: true }), si(2, 50), si(3, 30, { allIn: true })])).toEqual([]);
  });
  it('two folded seats above the largest contender: only the part the other folder did not match comes back (review fix-up)', () => {
    // Seat 2's 700 matched seat 1's first 700: called money, it stays in the pot (calculatePots' rule).
    expect(fx([si(1, 900, { folded: true }), si(2, 700, { folded: true }), si(3, 400, { allIn: true }), si(4, 500, { allIn: true })]))
      .toEqual([{ seatIndex: 1, amount: 200 }]);
  });
  it('dead money is not live: a folded seat whose LIVE part is at or below the contenders gets nothing back', () => {
    expect(fx([si(1, 600, { folded: true, deadMoney: 150 }), si(3, 450, { allIn: true })])).toEqual([]);
    expect(fx([si(1, 600, { folded: true, deadMoney: 100 }), si(3, 450, { allIn: true })])).toEqual([{ seatIndex: 1, amount: 50 }]);
  });
  it('no contender (everyone folded) → nothing here (the all-fold refund handles it)', () => {
    expect(fx([si(1, 100, { folded: true }), si(2, 50, { folded: true })])).toEqual([]);
  });
});

function holdem(sb: number, bb: number, ante: number, stacks: Array<[number, number]>, Ctor: any = PokerTable, extra: any[] = []): PokerTable {
  const t = new Ctor({ tableId: 'T', tableName: 'T', smallBlind: sb, bigBlind: bb, ante, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: 9 } as any, ...extra);
  for (const [seat, chips] of stacks) t.sitDown(seat, `P${seat}`, chips, `p${seat}`, false);
  return t;
}
const HAND11: Array<[number, number]> = [[0, 1920], [3, 195], [4, 2635], [5, 840], [7, 2415], [8, 995]];
const total = (t: PokerTable) => t.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount : 0), 0);

function playHand11(t: PokerTable): any {
  let hh: any = null;
  t.on('handHistory', (h: any) => { hh = h; });
  expect(t.startNewHand()).toBe(true);
  expect(t.dealerButtonSeat).toBe(0);
  const acts: Array<[number, 'a' | 'f']> = [[5, 'a'], [7, 'f'], [8, 'a'], [0, 'f'], [4, 'f']];
  for (const [seat, a] of acts) {
    expect(t.activeSeatIndex).toBe(seat);
    expect(a === 'a' ? t.playerAllIn(seat) : t.playerFold(seat)).toBe(true);
  }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
  return hh;
}

describe('F4 — the real engine: evidence hand 11 rebuilt', () => {
  it("Hold'em: Dominic (BB, seat 4) ends at 2,635 - 995 = 1,640 whoever wins; no pot only Collin can win holds more than 310; chips conserved", () => {
    const t = holdem(500, 1000, 100, HAND11);
    const hh = playHand11(t);
    expect(t.seats[4].chipCount).toBe(1640);                 // e038f7b: 1,535
    expect(total(t)).toBe(9000);
    // Main 980 (everyone's first 195), Side Pot 1 1,935 (to 840), Side Pot 2 = Collin's tier: 310 (e038f7b: 415).
    expect(hh.pots.map((p: any) => [p.name, p.amount])).toEqual([['Main Pot', 980], ['Side Pot 1', 1935], ['Side Pot 2', 310]]);
    expect(hh.pots.reduce((s: number, p: any) => s + p.amount, 0)).toBe(600 + 95 + 740 + 895 + 1000 - 105);
    expect(hh.actionLog).toContainEqual({ seatIndex: 4, playerName: 'P4', action: 'uncalled bet (105) returned' });
    expect(hh.players.find((p: any) => p.seatIndex === 4).endChips).toBe(1640);
  });

  it('Omaha hi-lo (pot-limit): the same hand returns the same 105', () => {
    const t = holdem(500, 1000, 100, HAND11, OmahaTable, [true]);
    playHand11(t);
    expect(t.seats[4].chipCount).toBe(1640);
    expect(total(t)).toBe(9000);
  });

  it('heads-up: the small blind all-in for 150 under a 200 big blind, the big blind folds with a free check → 50 comes back to him', () => {
    const t = holdem(100, 200, 0, [[0, 150], [1, 1000]]);
    expect(t.startNewHand()).toBe(true);
    const sbSeat = t.actionLog.find((a) => a.action.startsWith('posted SB'))!.seatIndex;
    const bbSeat = t.actionLog.find((a) => a.action.startsWith('posted BB'))!.seatIndex;
    expect(sbSeat).toBe(0);
    expect(t.activeSeatIndex).toBe(0);
    expect(t.playerAllIn(0)).toBe(true);
    expect(t.activeSeatIndex).toBe(bbSeat);
    expect(t.playerFold(bbSeat)).toBe(true);
    expect(t.seats[1].chipCount).toBe(1000 - 150);   // e038f7b: 800
    expect(t.seats[0].chipCount).toBe(300);          // e038f7b: 350
    expect(total(t)).toBe(1150);
  });

  it('control: a live seat that is not all-in still wins a folded seat\'s unmatched bet (nothing returned)', () => {
    const t = holdem(25, 50, 0, [[0, 5000], [1, 5000], [2, 5000]]);
    expect(t.startNewHand()).toBe(true);
    // Button 0, SB 1, BB 2. Seat 0 raises to 600, seat 1 folds, seat 2 calls; flop: seat 2 checks, seat 0 bets 1000, seat 2 folds.
    expect(t.playerRaise(0, 600)).toBe(true);
    expect(t.playerFold(1)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.playerCheck(2)).toBe(true);
    expect(t.playerRaise(0, 1000)).toBe(true);
    expect(t.playerFold(2)).toBe(true);
    expect(t.seats[0].chipCount).toBe(5000 + 600 + 25);
    expect(total(t)).toBe(15000);
  });
});

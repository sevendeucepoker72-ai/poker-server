/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F4, review fix-up)
 * — F4 returns ONLY the uncalled part of a folded seat's bet.
 *
 * The first F4 rule refunded EVERY folded seat its live investment above the
 * largest all-in, including chips another FOLDED seat had matched (called).
 * That happens when every remaining player is all-in after the last players
 * able to act folded on a later street (the engine still gives the lone
 * non-all-in seat a turn, and he can fold with a free check): each folder got
 * his share back and the history said 'uncalled bet (N) returned' for a bet
 * that was called. The spec is "a pot tier only a FOLDED player contributed
 * to": the part of a folded seat's live bet above BOTH the largest contender
 * AND every other folded seat. Matched money stays with the existing rule
 * (calculatePots: the orphan tier goes to the most-invested contender), as on
 * e038f7b.
 *
 * Also (review fix-up, dormant while ALLIN_INSURANCE is off): the insurance
 * quote's exclusive pot is priced net of that return (PokerTable
 * .getCurrentPotsNetOfReturns), so the house never pays the insured seat for
 * chips F4 hands back to the folded seat.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SidePotManager, SeatInfo } from '../src/game/SidePotManager';
import { fnSrc, load } from './helpers/indexSource';

const si = (seatIndex: number, invested: number, o: Partial<SeatInfo> = {}): SeatInfo => ({
  seatIndex, chipCount: 0, totalInvestedThisHand: invested, folded: false, allIn: false, holeCards: [], state: 'occupied', ...o,
});
const fx = (seats: SeatInfo[]) => (SidePotManager as any).unmatchedFoldedExcess(seats);
const total = (t: PokerTable) => t.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount : 0), 0);

describe('F4 review fix-up — only the part no other seat matched is returned', () => {
  it('two folded seats at the same 800 above all-ins of 200 / 300: nothing is returned (each matched the other)', () => {
    expect(fx([si(0, 800, { folded: true }), si(1, 800, { folded: true }), si(2, 200, { allIn: true }), si(3, 300, { allIn: true })])).toEqual([]);
  });

  it('folded 900 and 700 above contenders 400 / 500: only the 200 the top folder alone put in comes back to him', () => {
    expect(fx([si(1, 900, { folded: true }), si(2, 700, { folded: true }), si(3, 400, { allIn: true }), si(4, 500, { allIn: true })]))
      .toEqual([{ seatIndex: 1, amount: 200 }]);
  });

  it('the fuzz example: three folders at 1,525 against all-ins of 465 / 325 → nothing back', () => {
    expect(fx([si(0, 1525, { folded: true }), si(1, 465, { allIn: true }), si(2, 1525, { folded: true }), si(3, 1525, { folded: true }), si(4, 325, { allIn: true })])).toEqual([]);
  });

  it('a lower folded seat never caps a higher one below the contenders: hand 11 still returns 105', () => {
    expect(fx([si(0, 0, { folded: true }), si(3, 195, { allIn: true }), si(4, 1100, { folded: true }), si(5, 840, { allIn: true }), si(7, 100, { folded: true }), si(8, 995, { allIn: true })]))
      .toEqual([{ seatIndex: 4, amount: 105 }]);
  });

  it('dead money is not live for the other folded seat either', () => {
    // seat 2's 900 includes 300 dead: its live 600 does not match seat 1's live 800.
    expect(fx([si(1, 800, { folded: true }), si(2, 900, { folded: true, deadMoney: 300 }), si(3, 500, { allIn: true })]))
      .toEqual([{ seatIndex: 1, amount: 200 }]);
  });
});

/** The reviewer's probe (rev-probes/f4case.js) on the real engine. */
function sidePotBothFold(): { t: PokerTable; hh: any } {
  const t = new PokerTable({ tableId: 'X', tableName: 'X', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 1, maxBuyIn: 1e9, maxPlayers: 9 } as any);
  t.sitDown(0, 'Deep0', 5000, 'p0', false);
  t.sitDown(1, 'Deep1', 5000, 'p1', false);
  t.sitDown(2, 'Short2', 200, 'p2', false);
  t.sitDown(3, 'Short3', 300, 'p3', false);
  let hh: any = null;
  t.on('handHistory', (h: any) => { hh = h; });
  expect(t.startNewHand()).toBe(true);
  for (let g = 0; g < 20 && t.currentPhase === GamePhase.PreFlop; g++) {
    const a = t.activeSeatIndex;
    if (a === 2 || a === 3) expect(t.playerAllIn(a)).toBe(true);
    else expect(t.playerCall(a) || t.playerCheck(a)).toBe(true);
  }
  expect(t.currentPhase).toBe(GamePhase.Flop);
  const first = t.activeSeatIndex;
  expect(t.playerRaise(first, 500)).toBe(true);
  expect(t.playerCall(t.activeSeatIndex)).toBe(true);
  expect(t.currentPhase).toBe(GamePhase.Turn);
  expect(t.playerFold(t.activeSeatIndex)).toBe(true);
  if (t.isHandInProgress() && t.activeSeatIndex >= 0) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
  for (let g = 0; g < 10 && t.isHandInProgress() && t.activeSeatIndex >= 0; g++) t.playerCheck(t.activeSeatIndex);
  expect(t.isHandInProgress()).toBe(false);
  return { t, hh };
}

describe('F4 review fix-up — the reviewer probe: a side pot both deep players built, then both folded', () => {
  it('no "uncalled bet" line for a called bet; the deep stacks each end at 4,200 as on e038f7b; chips conserved', () => {
    const { t, hh } = sidePotBothFold();
    expect(total(t)).toBe(10500);
    expect((hh.actionLog || []).filter((a: any) => /uncalled/.test(a.action))).toEqual([]);   // HEAD: both seats 'uncalled bet (500) returned'
    expect(t.seats[0].chipCount).toBe(4200);                                                   // HEAD: 4,700
    expect(t.seats[1].chipCount).toBe(4200);
    // Their matched 1,000 stays in the pots (e038f7b: Side Pot 1 = 1,300 to the 300 all-in).
    expect(hh.pots.reduce((s: number, p: any) => s + p.amount, 0)).toBe(800 + 800 + 200 + 300);
  });
});

describe('F4 review fix-up — the insurance quote is priced net of the F4 return (dormant: ALLIN_INSURANCE off)', () => {
  const EXCL = fnSrc('function insuranceExclusivePot(');
  const CONT = fnSrc('function insuranceContestedPot(');
  const { exports: m } = load(`${EXCL}\n${CONT}`, {}, '{ insuranceExclusivePot, insuranceContestedPot }');

  it('Hero all-in 180 vs Shorty all-in 150, the big blind (200) folded: Hero\'s exclusive pot is 60 (the BB\'s unmatched 20 goes back to him), and it is what the hand pays', () => {
    const t = new PokerTable({ tableId: 'I', tableName: 'I', smallBlind: 100, bigBlind: 200, ante: 0, minBuyIn: 1, maxBuyIn: 1e9, maxPlayers: 9 } as any);
    t.sitDown(0, 'Hero', 180, 'p0', false);     // button
    t.sitDown(1, 'Shorty', 150, 'p1', false);   // small blind
    t.sitDown(2, 'BigB', 5000, 'p2', false);    // big blind
    t.runoutHoldDecider = () => true;           // the insurance window: the runout is held
    let hh: any = null;
    t.on('handHistory', (h: any) => { hh = h; });
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(0);
    expect(t.playerAllIn(0)).toBe(true);
    expect(t.playerAllIn(1)).toBe(true);
    expect(t.playerFold(2)).toBe(true);         // folds his big blind with a free check
    expect(t.isRunoutHeld()).toBe(true);
    const exclusive = m.insuranceExclusivePot(t, 0);
    expect(exclusive).toBe(60);                 // HEAD: 80 (the BB's 20 counted as Hero's)
    expect(m.insuranceContestedPot(t, 0, 1)).toBe(450);
    expect(t.releaseRunoutHold()).toBe(true);
    expect(t.isHandInProgress()).toBe(false);
    // Main 450 (everyone's first 150), Side Pot 1 = Hero's tier (his 30 + the BB's matching 30) = the quoted exclusive.
    expect(hh.pots.map((p: any) => [p.name, p.amount])).toEqual([['Main Pot', 450], ['Side Pot 1', exclusive]]);
    expect(hh.pots[1].winners).toEqual([0]);
    expect(hh.actionLog).toContainEqual({ seatIndex: 2, playerName: 'BigB', action: 'uncalled bet (20) returned' });
    expect(total(t)).toBe(5330);
  });

  it('the display pots (getCurrentPots) are unchanged by the fix-up (qualifier / every table display byte-identical)', () => {
    const t = new PokerTable({ tableId: 'J', tableName: 'J', smallBlind: 100, bigBlind: 200, ante: 0, minBuyIn: 1, maxBuyIn: 1e9, maxPlayers: 9 } as any);
    t.sitDown(0, 'Hero', 180, 'p0', false);
    t.sitDown(1, 'Shorty', 150, 'p1', false);
    t.sitDown(2, 'BigB', 5000, 'p2', false);
    t.runoutHoldDecider = () => true;
    expect(t.startNewHand()).toBe(true);
    t.playerAllIn(0); t.playerAllIn(1); t.playerFold(2);
    expect(t.getCurrentPots().reduce((s, p) => s + p.amount, 0)).toBe(530);
    expect((t as any).getCurrentPotsNetOfReturns().reduce((s: number, p: any) => s + p.amount, 0)).toBe(510);
  });
});

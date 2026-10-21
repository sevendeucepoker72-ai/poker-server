/**
 * Gameplay audit 2026-10-21 — cluster S1 (pots, dead blinds, money
 * conservation), on the REAL engine (src/game) and the real index.ts source.
 *
 *   F1   a dead blind no longer makes its poster the only seat eligible for
 *        the pot: a live seat that is not all-in contests every tier, and
 *        dead blinds go to the main pot (SidePotManager.calculatePots).
 *   F2   a tier only folded seats built is inherited by the live seat(s) that
 *        invested the most — never by a short all-in that did not cover it.
 *   F4   Post Blinds is refused from a seat dealt into the hand ('in_hand').
 *   F5   a player back in time for his big blind owes nothing more.
 *   F6   missed-blind debt is one set (SB + BB) at most.
 *   F14  a bomb pot gives a dead blind back AS DEBT (not forgiven).
 *   F22  a leaver's unmatched top bet is dead money, not a bet the remaining
 *        player must call (forceFoldSeat lowers the bet to match).
 *   F38  Stud / Razz / Stud 8 (no blinds) never accrue or charge blind debt.
 *   (G165 lives in insuranceIntegration.test.ts — its harness is there.)
 *
 * Every test fails on the pre-fix code (the old numbers are quoted inline).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SidePotManager, SeatInfo } from '../src/game/SidePotManager';
import { Card } from '../src/game/Card';
import { SRC } from './helpers/indexSource';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const key = (c: Card) => c.suit * 16 + c.rank;

const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: 't', tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, ...over } as any);
const seatN = (t: PokerTable, n: number, chips = 5000) => {
  for (let i = 0; i < n; i++) expect(t.sitDown(i, `P${i}`, chips, `p${i}`, false)).toBe(true);
};
/** Chips on the table: every stack plus what is in the pot of a hand in progress. */
const tableChips = (t: PokerTable) =>
  t.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (t.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0);

/** Fix the hole cards of the given seats and the board (burn, flop, burn, turn, burn, river). */
function rig(t: PokerTable, holes: Record<number, string>, board: string): void {
  const used = new Set<number>();
  for (const [i, h] of Object.entries(holes)) {
    t.seats[Number(i)].holeCards = cs(h);
    for (const c of cs(h)) used.add(key(c));
  }
  const b = cs(board);
  for (const c of b) used.add(key(c));
  const rest: Card[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) if (!used.has(suit * 16 + rank)) rest.push({ suit, rank } as Card);
  const deck = (t as any).deck;
  deck.cards = [rest[0], b[0], b[1], b[2], rest[1], b[3], rest[2], b[4], ...rest.slice(3)];
  deck.currentIndex = 0;
}

/** Everyone calls / checks to the end of the hand. */
function checkDown(t: PokerTable): void {
  for (let g = 0; g < 60 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    expect(a).toBeGreaterThanOrEqual(0);
    const owes = t.currentBetToMatch > t.seats[a].currentBet;
    expect(owes ? t.playerCall(a) : t.playerCheck(a)).toBe(true);
  }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

/** Everyone folds to the last player. */
function foldOut(t: PokerTable): void {
  for (let g = 0; g < 20 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

const deadPosts = (t: PokerTable, seat: number) =>
  t.actionLog.filter((a) => a.seatIndex === seat && a.action.startsWith('posted dead blind'));

const info = (seatIndex: number, invested: number, o: Partial<SeatInfo> = {}): SeatInfo =>
  ({ seatIndex, chipCount: 1000, totalInvestedThisHand: invested, folded: false, allIn: false, holeCards: [], state: 'occupied', ...o });
const shape = (pots: Array<{ amount: number; eligibleSeatIndices: number[] }>) =>
  pots.map((p) => [p.amount, [...p.eligibleSeatIndices].sort((a, b) => a - b)]);

describe('F1 — a returning player\'s dead blind never makes him the only seat that can win', () => {
  it('calculatePots: every live seat that is not all-in contests the tier (old: only the 100-invested seat was eligible)', () => {
    const spm = new SidePotManager();
    // No all-in; seat 3 has 50 more in (dead money, or any reason): one pot, all four contest it.
    const seats = [info(0, 50), info(1, 50), info(2, 50), info(3, 100)];
    expect(shape(spm.calculatePots(seats))).toEqual([[250, [0, 1, 2, 3]]]);
    // ... and marked as dead money: the same single main pot.
    seats[3].deadMoney = 50;
    expect(shape(spm.calculatePots(seats))).toEqual([[250, [0, 1, 2, 3]]]);
  });

  it('calculatePots: a dead-blind poster who is all-in wins at most his LIVE call from each player plus the dead money', () => {
    const spm = new SidePotManager();
    // He posted 50 dead, then shoved 100 live; two players put in 400 each.
    const seats = [info(0, 150, { deadMoney: 50, allIn: true }), info(1, 400), info(2, 400)];
    // main = 50 dead + 100 x 3 = 350 (the old total-invested tiers made it 450)
    expect(shape(spm.calculatePots(seats))).toEqual([[350, [0, 1, 2]], [600, [1, 2]]]);
  });

  it('engine: sit out across the blinds, come back on the button, the 75 dead blind is collected — and the BEST hand wins the check-down (old: 7-2 scooped against quad aces)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.setSittingOutSeats([3]);
    for (let h = 0; h < 3; h++) { expect(t.startNewHand()).toBe(true); foldOut(t); }
    expect(t.seats[3]).toMatchObject({ deadBlindOwedChips: 75, missedBlind: 'both' });
    t.setSittingOutSeats([]);                                   // playerBack
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(3);                          // not a blind: the debt is collected
    expect(deadPosts(t, 3).map((a) => a.action)).toEqual(['posted dead blind 75']);
    expect(t.seats[3]).toMatchObject({ deadMoneyThisHand: 75, totalInvestedThisHand: 75, currentBet: 0, deadBlindOwedChips: 0 });
    const start = t.seats.map((s) => s.chipCount + s.totalInvestedThisHand);
    const total = tableChips(t);
    rig(t, { 0: 'Ah Ad', 1: 'Kc Kd', 2: 'Qh Qs', 3: '7c 2d' }, 'Ac As 9d 4h 3s');
    checkDown(t);
    expect(tableChips(t)).toBe(total);
    expect(t.lastHandResult!.winners.map((w) => [w.seatIndex, w.chipsWon])).toEqual([[0, 275]]);
    expect(t.seats[0].chipCount).toBe(start[0] - 50 + 275);
    expect(t.seats[3].chipCount).toBe(start[3] - 125);           // his dead 75 + the 50 call, lost
    expect(t.lastHandResult!.pots.map((p) => [p.amount, p.winners])).toEqual([[275, [0]]]);
  });

  it('engine: the same with Omaha Hi-Lo (its own pot loop) — the dead-blind poster\'s junk does not scoop', () => {
    const t = new OmahaTable(cfg(), true, 4);
    seatN(t, 3);
    t.seats[2].deadBlindOwedChips = 50; t.seats[2].missedBlind = 'big';
    expect(t.startNewHand()).toBe(true);                         // button 0, SB 1, BB 2
    // Seat 2 is the big blind on the first hand, so (F5) his debt is settled by the live BB.
    expect(t.seats[2].deadBlindOwedChips).toBe(0);
    foldOut(t);
    // Debt on a seat that is NOT a blind next hand (button 1, SB 2, BB 0): seat 1 posts it dead.
    t.seats[1].deadBlindOwedChips = 50; t.seats[1].missedBlind = 'big';
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(1);
    expect(t.seats[1].deadMoneyThisHand).toBe(50);
    const total = tableChips(t);
    // Seat 0: aces full. Seat 1 (the dead-blind poster): two pair. Nobody has a low.
    rig(t, { 0: 'Ah Ad Ac Ks', 1: '9h 9d 5c 5s', 2: 'Kh Kd Qc Qs' }, 'As 7d 4h 2s 2c');
    checkDown(t);
    expect(tableChips(t)).toBe(total);
    const won = new Map<number, number>();
    for (const w of t.lastHandResult!.winners) won.set(w.seatIndex, (won.get(w.seatIndex) || 0) + w.chipsWon);
    expect([...won.entries()]).toEqual([[0, 200]]);              // 50 x 3 + the 50 dead (old: seat 1 alone)
  });
});

describe('F2 — a tier only folded seats built never goes to a short all-in that did not cover it', () => {
  it('calculatePots, dead blind folded above a short all-in: the dead money is main pot, the live overcall a side pot (old: one 205 pot for all three)', () => {
    const spm = new SidePotManager();
    const seats = [info(0, 50), info(1, 50), info(2, 30, { allIn: true }), info(3, 75, { folded: true, deadMoney: 75 })];
    expect(shape(spm.calculatePots(seats, 0))).toEqual([[165, [0, 1, 2]], [40, [0, 1]]]);
  });

  it('calculatePots, a folded BET above a short all-in: layered — the all-in wins 30 from each, the covering seats contest the rest (old: 205 for all three)', () => {
    const spm = new SidePotManager();
    const seats = [info(0, 50), info(1, 50), info(2, 30, { allIn: true }), info(3, 75, { folded: true })];
    expect(shape(spm.calculatePots(seats, 0))).toEqual([[120, [0, 1, 2]], [85, [0, 1]]]);
  });

  it('calculatePots, every live seat all-in below a folded bet: the deepest all-in inherits the orphan tier, never the shorter one', () => {
    const spm = new SidePotManager();
    const seats = [info(0, 75, { folded: true }), info(1, 30, { allIn: true }), info(2, 50, { allIn: true })];
    // old: [[90,[1,2]],[40,[2]],[25,[1,2]]] — the 30 all-in could win the folded seat's top 25
    expect(shape(spm.calculatePots(seats, 0))).toEqual([[90, [1, 2]], [65, [2]]]);
    // The best hand is the short all-in: he takes 90 (30 x 3), never more.
    seats[1].holeCards = cs('Ah Ad'); seats[2].holeCards = cs('Kh Kd');
    const { winnings } = spm.awardPots(seats, cs('2c 7d 9s 3h 4c'), 0);
    expect([...winnings.entries()].sort()).toEqual([[1, 90], [2, 65]]);
  });

  it('engine: dead 75 posted and folded, a short big blind all-in for 30, two limpers check down — AA wins 165 (main + dead), KK the 40 side pot (old: AA won all 205)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.seats[2].chipCount = 30;
    t.seats[3].deadBlindOwedChips = 75; t.seats[3].missedBlind = 'both';
    expect(t.startNewHand()).toBe(true);
    expect([t.dealerButtonSeat, t.seats[2].allIn, t.seats[2].currentBet]).toEqual([0, true, 30]);
    expect(deadPosts(t, 3).map((a) => a.action)).toEqual(['posted dead blind 75']);
    const total = tableChips(t);
    rig(t, { 0: 'Kc Ks', 1: 'Qh Qd', 2: 'Ah Ad', 3: '7c 2d' }, '2c 7d 9s 3h 4c');
    expect(t.activeSeatIndex).toBe(3);
    expect(t.playerFold(3)).toBe(true);
    checkDown(t);
    expect(tableChips(t)).toBe(total);
    expect(t.seats.slice(0, 4).map((s) => s.chipCount)).toEqual([4990, 4950, 165, 4925]);
  });
});

describe('F4 — Post Blinds is refused from a seat dealt into the hand', () => {
  it('a live seat with debt is refused (in_hand): no chips move, the debt stays for a later deal', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    expect(t.startNewHand()).toBe(true);
    const s = t.seats.find((x) => x.seatIndex !== t.activeSeatIndex && !x.folded)!;
    s.deadBlindOwedChips = 75; s.missedBlind = 'both';
    const before = { chips: s.chipCount, inv: s.totalInvestedThisHand };
    expect(t.postOwedBlindsNow(s.seatIndex)).toEqual({ ok: false, reason: 'in_hand' });
    expect({ chips: s.chipCount, inv: s.totalInvestedThisHand, debt: s.deadBlindOwedChips }).toEqual({ ...before, debt: 75 });
  });

  it('the actor whose stack equals his debt cannot make himself all-in on dead money (old: allIn + every action refused until the watchdog)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    expect(t.startNewHand()).toBe(true);
    const a = t.activeSeatIndex;
    t.seats[a].chipCount = 75; t.seats[a].deadBlindOwedChips = 75; t.seats[a].missedBlind = 'both';
    expect(t.postOwedBlindsNow(a).reason).toBe('in_hand');
    expect(t.seats[a].allIn).toBe(false);
    expect(t.playerFold(a)).toBe(true);                           // he can still act
  });

  it('a seat sitting this hand out (folded, no cards) may still post: the chips are dead money he cannot win', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.setSittingOutSeats([3]);
    expect(t.startNewHand()).toBe(true);
    t.seats[3].deadBlindOwedChips = 75; t.seats[3].missedBlind = 'both';
    expect(t.seats[3]).toMatchObject({ folded: true, holeCards: [] });
    const total = tableChips(t);
    expect(t.postOwedBlindsNow(3)).toEqual({ ok: true, amount: 75 });
    expect(t.seats[3]).toMatchObject({ chipCount: 4925, deadMoneyThisHand: 75, deadBlindOwedChips: 0, missedBlind: 'none' });
    foldOut(t);
    expect(tableChips(t)).toBe(total);
    expect(t.seats[3].chipCount).toBe(4925);
  });

  it('index.ts: the postMissedBlinds handler explains the in_hand refusal', () => {
    const at = SRC.indexOf("socket.on('postMissedBlinds'");
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at, at + 2500)).toMatch(/\bin_hand: '[^']+'/);   // not the older not_in_hand
  });
});

describe('F5 — a player back in time for his big blind owes nothing more', () => {
  it('posts the BB live, the debt is cleared at once, and no dead blind is taken on the next hands (old: 75 dead two hands later)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.setSittingOutSeats([3]);
    // Hands 1-5 sitting out: BB passes him on hand 2, SB on hand 3 (75 'both').
    for (let h = 0; h < 5; h++) { expect(t.startNewHand()).toBe(true); foldOut(t); }
    expect(t.seats[3]).toMatchObject({ deadBlindOwedChips: 75, missedBlind: 'both' });
    t.setSittingOutSeats([]);
    expect(t.startNewHand()).toBe(true);                           // hand 6: his big blind
    expect(t.actionLog.filter((a) => a.seatIndex === 3).map((a) => a.action)).toEqual(['posted BB 50']);
    expect(t.seats[3]).toMatchObject({ deadBlindOwedChips: 0, missedBlind: 'none', deadMoneyThisHand: 0 });
    foldOut(t);
    for (let h = 0; h < 3; h++) {                                  // SB, button, cut-off: never a dead post
      expect(t.startNewHand()).toBe(true);
      expect(deadPosts(t, 3)).toEqual([]);
      foldOut(t);
    }
  });

  it('CONTROL: a big blind that is STILL sitting out keeps accruing (the clear never wipes a growing debt)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.setSittingOutSeats([3]);
    expect(t.startNewHand()).toBe(true); foldOut(t);
    expect(t.startNewHand()).toBe(true);                           // hand 2: his (dead) BB
    expect(t.seats[3]).toMatchObject({ deadBlindOwedChips: 50, missedBlind: 'big' });
  });
});

describe('F6 — missed-blind debt is one set at most', () => {
  it('12 hands sat out at 25/50 owe 75 (SB + BB), not 225; the debt never exceeds one set on the way', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.setSittingOutSeats([3]);
    const seen: number[] = [];
    for (let h = 0; h < 12; h++) {
      expect(t.startNewHand()).toBe(true);
      seen.push(t.seats[3].deadBlindOwedChips);
      foldOut(t);
    }
    expect(Math.max(...seen)).toBe(75);
    expect(t.seats[3]).toMatchObject({ deadBlindOwedChips: 75, missedBlind: 'both', chipCount: 5000 });
  });

  it('only a missed big blind owes only the big blind, however often it was missed', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    t.markMissedBlind(1, 'big');
    t.markMissedBlind(1, 'big');
    expect(t.seats[1]).toMatchObject({ deadBlindOwedChips: 50, missedBlind: 'big' });
    t.markMissedBlind(1, 'small');
    t.markMissedBlind(1, 'small');
    expect(t.seats[1]).toMatchObject({ deadBlindOwedChips: 75, missedBlind: 'both' });
  });
});

describe('F14 — a bomb pot gives a dead blind back as debt', () => {
  it('the dead 75 is refunded with the blinds AND owed again; the next normal hand collects it; chips conserved', () => {
    const t = new PokerTable(cfg());
    seatN(t, 5);
    t.seats[4].deadBlindOwedChips = 75; t.seats[4].missedBlind = 'both';
    expect(t.startNewHand()).toBe(true);                           // button 0, SB 1, BB 2: seat 4 posts dead
    expect(deadPosts(t, 4)).toHaveLength(1);
    const total = tableChips(t);
    expect(t.applyBombPot(100)).toBe(true);
    expect(t.seats[4]).toMatchObject({ chipCount: 4900, totalInvestedThisHand: 100, deadMoneyThisHand: 0, deadBlindOwedChips: 75, missedBlind: 'both' });
    expect(deadPosts(t, 4)).toEqual([]);                           // that post no longer counts
    expect(tableChips(t)).toBe(total);
    checkDown(t);
    expect(tableChips(t)).toBe(total);
    expect(t.startNewHand()).toBe(true);                           // button 1, SB 2, BB 3: seat 4 pays now
    expect(deadPosts(t, 4).map((a) => a.action)).toEqual(['posted dead blind 75']);
    expect(t.seats[4].deadBlindOwedChips).toBe(0);
  });
});

describe('F22 — a leaver\'s unmatched top bet is dead money, not a bet to call', () => {
  const play = () => {
    const t = new PokerTable(cfg({ smallBlind: 10, bigBlind: 20, minBuyIn: 100 }));
    expect(t.sitDown(0, 'A', 2000, 'a')).toBe(true);
    expect(t.sitDown(1, 'B', 2000, 'b')).toBe(true);
    expect(t.sitDown(2, 'C', 2000, 'c')).toBe(true);
    t.seats[1].chipCount = 100;
    expect(t.startNewHand()).toBe(true);                            // button A, SB B, BB C
    expect(t.playerCall(0)).toBe(true);                              // A limps
    expect(t.playerAllIn(1)).toBe(true);                             // B all-in 100
    expect(t.playerCall(2)).toBe(true);                              // C calls
    expect(t.playerCall(0)).toBe(true);                              // A calls
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.activeSeatIndex).toBe(2);
    expect(t.playerCheck(2)).toBe(true);                             // C checks
    expect(t.playerRaise(0, 300)).toBe(true);                        // A bets 300
    expect(t.activeSeatIndex).toBe(2);
    return t;
  };

  it('A bets and leaves before C acts: C may CHECK (old: refused — call 300 or fold); A\'s 300 goes to C, never to the 100 all-in', () => {
    const t = play();
    const total = tableChips(t);
    const v = t.stateVersion;
    expect(t.forceFoldSeat(0)).toBe(true);
    expect(t.awardIfUncontested()).toBe(false);
    expect(t.currentBetToMatch).toBe(0);
    expect(t.getCallAmount(t.seats[2])).toBe(0);
    expect(t.stateVersion).toBeGreaterThan(v);                       // a stale "call 300" is refused
    rig(t, { 1: 'Ah Ad', 2: 'Kh Kd' }, '2c 7d 9s 3h 4c');            // B holds the best hand
    t.seats[0].holeCards = cs('Qc Qd');
    (t as any).deck.currentIndex = 4;                                // the flop is already out
    t.communityCards = cs('2c 7d 9s');
    expect(t.playerCheck(2)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(tableChips(t)).toBe(total);
    // B: the 300 main pot (100 x 3). C: A's dead 300 (old: B 'won by fold' 600 when C folded).
    expect(t.seats.slice(0, 3).map((s) => s.chipCount)).toEqual([1600, 300, 2200]);
  });

  it('CONTROL: a bet another live player already called stays the bet (nothing is lowered)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    expect(t.startNewHand()).toBe(true);                             // button 0, SB 1, BB 2, UTG 3
    expect(t.playerRaise(3, 200)).toBe(true);
    expect(t.playerCall(0)).toBe(true);
    expect(t.activeSeatIndex).toBe(1);
    expect(t.forceFoldSeat(3)).toBe(true);
    expect(t.currentBetToMatch).toBe(200);
  });

  it('pre-flop the big blind stays the bet: a raiser who leaves leaves the field facing the BB, with a BB min-raise', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    expect(t.startNewHand()).toBe(true);                             // button 0 (UTG), SB 1, BB 2
    expect(t.playerRaise(0, 300)).toBe(true);
    expect(t.activeSeatIndex).toBe(1);
    expect(t.forceFoldSeat(0)).toBe(true);
    expect(t.currentBetToMatch).toBe(50);
    expect(t.lastRaiseAmount).toBe(50);
    expect(t.getCallAmount(t.seats[1])).toBe(25);
    expect(t.playerCall(1)).toBe(true);
    expect(t.playerCheck(2)).toBe(true);                             // the BB's option, round closes
    expect(t.currentPhase).toBe(GamePhase.Flop);
  });

  it('Stud Third Street: a completer who leaves puts the bet back to the bring-in, and the next player can still complete', () => {
    const t = new SevenStudTable(cfg({ minBuyIn: 100 }), false, false);
    seatN(t, 3);
    expect(t.startNewHand()).toBe(true);
    expect(t.currentBetToMatch).toBe(25);                            // the bring-in
    const completer = t.activeSeatIndex;
    expect(t.playerRaise(completer, 50)).toBe(true);
    const next = t.activeSeatIndex;
    const bringIn = t.seats.find((s) => s.currentBet === 25)!;
    if (next === bringIn.seatIndex) return;                          // 3-handed order: nothing left to check here
    expect(t.forceFoldSeat(completer)).toBe(true);
    expect(t.currentBetToMatch).toBe(25);
    expect(t.playerRaise(next, 50)).toBe(true);                      // the completion is still legal
    expect(t.currentBetToMatch).toBe(50);
  });
});

describe('F38 — games without blinds never owe blinds', () => {
  for (const [name, razz, hiLo] of [['Stud', false, false], ['Razz', true, false], ['Stud 8', false, true]] as const) {
    it(`${name}: sitting out 6 hands accrues no debt; a stray debt is cleared, never charged (old: 125 'both', and Post Blinds took it)`, () => {
      const t = new SevenStudTable(cfg({ ante: 5 }), razz, hiLo);
      seatN(t, 4);
      t.setSittingOutSeats([3]);
      for (let h = 0; h < 6; h++) {
        expect(t.startNewHand()).toBe(true);
        expect(t.seats[3]).toMatchObject({ deadBlindOwedChips: 0, missedBlind: 'none' });
        foldOut(t);
      }
      t.setSittingOutSeats([]);
      expect(t.startNewHand()).toBe(true);
      t.seats[3].deadBlindOwedChips = 125; t.seats[3].missedBlind = 'both';   // e.g. carried over
      const chips = t.seats[3].chipCount;
      expect(t.postOwedBlindsNow(3)).toEqual({ ok: false, reason: 'no_debt' });
      expect(t.seats[3]).toMatchObject({ chipCount: chips, deadBlindOwedChips: 0, missedBlind: 'none' });
    });
  }
});

describe('money conservation with dead blinds, sit-outs, leaves and bomb pots (randomised)', () => {
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  it('400 hands: chips are conserved every hand and no invariant is broken', () => {
    const r = rng(20261021);
    const t = new PokerTable(cfg({ minBuyIn: 100 }));
    for (let i = 0; i < 6; i++) expect(t.sitDown(i, `P${i}`, 400 + Math.floor(r() * 3000), `p${i}`)).toBe(true);
    let total = tableChips(t);
    let dealt = 0;
    for (let h = 0; h < 400; h++) {
      for (const s of t.seats) {                                     // a busted seat re-buys (counted in)
        if (s.state !== 'occupied' || s.chipCount > 0) continue;
        const buy = 400 + Math.floor(r() * 3000);
        t.standUp(s.seatIndex);
        expect(t.sitDown(s.seatIndex, `P${s.seatIndex}`, buy, `p${s.seatIndex}`)).toBe(true);
        total += buy;
      }
      const out = [0, 1, 2, 3, 4, 5].filter(() => r() < 0.2);
      t.setSittingOutSeats(out);
      if (!t.startNewHand()) continue;
      dealt++;
      if (r() < 0.1) t.applyBombPot(100);
      for (let g = 0; g < 200 && t.isHandInProgress(); g++) {
        const roll = r();
        if (roll < 0.05) {                                           // a seat sitting out posts its debt
          const s = t.seats[Math.floor(r() * 6)];
          if (s.state === 'occupied') t.postOwedBlindsNow(s.seatIndex);
          continue;
        }
        if (roll < 0.09) {                                           // someone leaves out of turn
          const s = t.seats[Math.floor(r() * 6)];
          if (s.state === 'occupied' && s.seatIndex !== t.activeSeatIndex && !s.allIn) {
            t.forceFoldSeat(s.seatIndex);
            t.awardIfUncontested();
          }
          continue;
        }
        const a = t.activeSeatIndex;
        if (a < 0) break;
        const owes = t.currentBetToMatch > t.seats[a].currentBet;
        const pick = r();
        const ok = pick < 0.15 ? t.playerFold(a)
          : pick < 0.25 ? t.playerAllIn(a)
          : pick < 0.4 ? t.playerRaise(a, t.getMinRaise())
          : owes ? t.playerCall(a) : t.playerCheck(a);
        if (!ok) expect(t.playerFold(a) || t.playerCheck(a) || t.playerCall(a)).toBe(true);
      }
      expect(t.currentPhase).toBe(GamePhase.HandComplete);
      expect(tableChips(t)).toBe(total);
      for (const s of t.seats) if (s.state === 'occupied') expect(s.deadBlindOwedChips).toBeLessThanOrEqual(75);
    }
    expect(dealt).toBeGreaterThan(300);
  });
});

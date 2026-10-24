/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F2) — the FIRST bet
 * on a street is saved as `bet N`; a raise stays `raised to N`. The engine used
 * the same words for both: 8 opening bets of the 9-player Sit & Go read as
 * raises in the replay step labels and the in-game action strip.
 *  - Pre-flop opens stay `raised to N` (the big blind is the bet).
 *  - A pot-limit opening shove capped below the stack: `bet N (pot-limit cap)`.
 *  - A true all-in stays `went all-in for N`; a straddle stays `straddle`.
 *  - Stud: a completion over the bring-in stays a raise.
 *  - The seat's lastAction enum is unchanged (Raise).
 *  - The bots' own-raise cap counts `bet N` (AIPlayer OWN_RAISE_RE): a bot that
 *    bet and then raised has raised twice.
 */
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { limitBotRaiseWar } from '../src/ai/AIPlayer';

function holdem(n: number, chips = 1000, sb = 10, bb = 20): PokerTable {
  const t = new PokerTable({ tableId: 'T', tableName: 'T', smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: 9 } as any);
  for (let i = 0; i < n; i++) t.sitDown(i, `P${i}`, chips, `p${i}`, false);
  return t;
}
type Act = [number, 'f' | 'x' | 'c' | 'r' | 'a', number?];
function play(t: PokerTable, acts: Act[]): void {
  for (const [seat, a, n] of acts) {
    expect({ seat, active: t.activeSeatIndex, phase: t.currentPhase }).toEqual({ seat, active: seat, phase: t.currentPhase });
    const ok = a === 'f' ? t.playerFold(seat) : a === 'x' ? t.playerCheck(seat) : a === 'c' ? t.playerCall(seat)
      : a === 'r' ? t.playerRaise(seat, n!) : t.playerAllIn(seat);
    expect({ seat, a, n, ok }).toEqual({ seat, a, n, ok: true });
  }
}
const lineOf = (t: PokerTable, seat: number, street: string) => t.actionLog.filter((e) => e.seatIndex === seat && e.street === street).map((e) => e.action);

describe('F2 — an opening bet is saved as bet N', () => {
  it("Hold'em: the first post-flop bet of 40 is 'bet 40'; a re-raise to 120 is 'raised to 120'; lastAction stays Raise", () => {
    const t = holdem(3);
    expect(t.startNewHand()).toBe(true);
    // Button 0, SB 1, BB 2: pre-flop 0 calls, 1 calls, 2 checks.
    play(t, [[0, 'c'], [1, 'c'], [2, 'x']]);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    play(t, [[1, 'r', 40], [2, 'r', 120]]);
    expect(lineOf(t, 1, GamePhase.Flop)).toEqual(['bet 40']);         // e038f7b: 'raised to 40'
    expect(lineOf(t, 2, GamePhase.Flop)).toEqual(['raised to 120']);
    expect(t.seats[1].lastAction).toBe(PlayerAction.Raise);
  });

  it("a pre-flop open to 60 stays 'raised to 60'", () => {
    const t = holdem(3);
    expect(t.startNewHand()).toBe(true);
    play(t, [[0, 'r', 60]]);
    expect(lineOf(t, 0, GamePhase.PreFlop)).toEqual(['raised to 60']);
  });

  it("pot-limit Omaha: an opening shove capped below the stack is 'bet N (pot-limit cap)'", () => {
    const t = new OmahaTable({ tableId: 'O', tableName: 'O', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: 9 } as any);
    for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    expect(t.startNewHand()).toBe(true);
    play(t, [[0, 'c'], [1, 'c'], [2, 'x']]);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.bettingStructure).toBe('pot-limit');
    play(t, [[1, 'a']]);
    expect(lineOf(t, 1, GamePhase.Flop)).toEqual(['bet 60 (pot-limit cap)']);   // the pot was 60
    expect(t.seats[1].allIn).toBe(false);
  });

  it('a true all-in stays went all-in for N, opening or not', () => {
    const t = holdem(3, 1000);
    expect(t.startNewHand()).toBe(true);
    play(t, [[0, 'c'], [1, 'c'], [2, 'x'], [1, 'a']]);
    expect(lineOf(t, 1, GamePhase.Flop)).toEqual(['went all-in for 980']);
  });

  it("Stud: bring-in 25 then completion 50 stays ['posted ante 5', 'posted bring-in 25', 'raised to 50'] (gameplay_S4 G168)", () => {
    const t = new SevenStudTable({ tableId: 'S', tableName: 'S', smallBlind: 25, bigBlind: 50, ante: 5, minBuyIn: 1, maxBuyIn: 100000, maxPlayers: 8 } as any);
    for (let i = 0; i < 4; i++) t.sitDown(i, `P${i}`, 2000, `p${i}`, false);
    expect(t.startNewHand()).toBe(true);
    const b = t.activeSeatIndex;
    expect(t.playerRaise(b, 50)).toBe(true);
    expect(t.actionLog.filter((a) => a.seatIndex === b).map((a) => a.action)).toEqual(['posted ante 5', 'posted bring-in 25', 'raised to 50']);
  });

  it("the bots' own-raise cap counts 'bet N': a bot whose street log is ['bet 40', 'raised to 160'] is capped (e038f7b counted 1 and let it raise again)", () => {
    const t = holdem(3, 5000);
    expect(t.startNewHand()).toBe(true);
    play(t, [[0, 'c'], [1, 'c'], [2, 'x']]);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    // Seat 1 bets 40, seat 2 raises to 80, seat 0 folds, seat 1 raises to 160, seat 2 re-raises to 320: seat 1 to act.
    play(t, [[1, 'r', 40], [2, 'r', 80], [0, 'f'], [1, 'r', 160], [2, 'r', 320]]);
    expect(lineOf(t, 1, GamePhase.Flop)).toEqual(['bet 40', 'raised to 160']);
    (t as any).raisesThisStreet = 0;   // isolate the own-raise count from the street cap
    const d = limitBotRaiseWar(t, t.seats[1], { action: PlayerAction.Raise, raiseAmount: 640 } as any, false, 0.5);
    expect(d.action).toBe(PlayerAction.Call);
  });

  it('evidence hand 1 (9 seats, 10/20): the turn line of seat 1 is bet 20, seat 5 raised to 60; the river line of seat 5 is bet 60', () => {
    const t = holdem(9, 1000);
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(0);
    play(t, [[3, 'f'], [4, 'f'], [5, 'c'], [6, 'c'], [7, 'c'], [8, 'f'], [0, 'f'], [1, 'c'], [2, 'x']]);
    play(t, [[1, 'x'], [2, 'x'], [5, 'x'], [6, 'x'], [7, 'x']]);
    play(t, [[1, 'r', 20], [2, 'f'], [5, 'r', 60], [6, 'f'], [7, 'f'], [1, 'c']]);
    play(t, [[1, 'x'], [5, 'r', 60], [1, 'c']]);
    expect(lineOf(t, 1, GamePhase.Turn)).toEqual(['bet 20', 'called 40']);
    expect(lineOf(t, 5, GamePhase.Turn)).toEqual(['raised to 60']);
    expect(lineOf(t, 5, GamePhase.River)).toEqual(['bet 60']);
  });
});

/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F1) — ANTES IN THE
 * HAND HISTORY. Antes were taken and paid out correctly, but never written into
 * the saved hand: from hand 4 of the 9-player Sit & Go on, each saved hand's
 * actions added up to less than its pot by the ante total (3,385 chips over the
 * event; the replay showed the pot short until its last step).
 *
 * Now every ante posted is an actionLog entry `posted ante N` (no street — the
 * same as the blinds — so it reads street '' in the saved record), one per seat,
 * in the order dead blinds, antes, SB, BB; an ante that takes the whole stack
 * carries `allIn: true` (a separate field: the text always ends in the number,
 * which the existing client parsers read). Stud / Razz log their antes too. A
 * bomb pot (cash only) refunds every post: the refunded ante / blind lines go
 * and its own antes are logged instead.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';

function holdem(sb: number, bb: number, ante: number, stacks: Array<[number, number]>): PokerTable {
  const t = new PokerTable({ tableId: 'T', tableName: 'T', smallBlind: sb, bigBlind: bb, ante, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: 9 } as any);
  for (const [seat, chips] of stacks) t.sitDown(seat, `P${seat}`, chips, `p${seat}`, false);
  return t;
}
const amountOf = (a: string) => Number((/([\d,]+)\s*(\(.*\))?$/.exec(a) || [])[1]?.replace(/,/g, '') || 0);
const posts = (t: PokerTable) => t.actionLog.filter((a) => a.action.startsWith('posted '));
const anteLines = (log: any[]) => log.filter((a) => a.action.startsWith('posted ante '));

describe('F1 — every ante posted is logged', () => {
  it("Hold'em 50/100 ante 25, four seats, one with 10 chips: 'posted ante 25' x3 + 'posted ante 10' {allIn}; no street; posts add up to the pot", () => {
    const t = holdem(50, 100, 25, [[0, 5000], [1, 5000], [2, 5000], [3, 10]]);
    expect(t.startNewHand()).toBe(true);
    const antes = anteLines(t.actionLog);
    expect(antes.map((a) => a.action).sort()).toEqual(['posted ante 10', 'posted ante 25', 'posted ante 25', 'posted ante 25']);
    const short = antes.find((a) => a.seatIndex === 3)!;
    expect(short).toEqual({ seatIndex: 3, playerName: 'P3', action: 'posted ante 10', allIn: true });
    for (const a of antes) expect(a.street).toBeUndefined();
    for (const a of antes.filter((x) => x.seatIndex !== 3)) expect(a.allIn).toBeUndefined();
    // e038f7b: no ante lines - the posts summed to 150 against a pot of 235.
    expect(posts(t).reduce((s, a) => s + amountOf(a.action), 0)).toBe(t.getTotalPot());
  });

  it('order: dead blinds, antes, SB, BB', () => {
    const t = holdem(50, 100, 25, [[0, 5000], [1, 5000], [2, 5000]]);
    expect(t.startNewHand()).toBe(true);
    const kinds = t.actionLog.map((a) => a.action.replace(/ \d+$/, ''));
    expect(kinds).toEqual(['posted ante', 'posted ante', 'posted ante', 'posted SB', 'posted BB']);
  });

  it('a sitting-out seat antes nothing and gets no line; ante 0 = no lines at all', () => {
    const t0 = holdem(50, 100, 0, [[0, 5000], [1, 5000], [2, 5000]]);
    expect(t0.startNewHand()).toBe(true);
    expect(anteLines(t0.actionLog)).toEqual([]);
  });

  it('canStraddle(UTG) is still true with ante lines in the log', () => {
    const t = holdem(50, 100, 25, [[0, 5000], [1, 5000], [2, 5000], [3, 5000], [4, 5000]]);
    expect(t.startNewHand()).toBe(true);
    expect(anteLines(t.actionLog)).toHaveLength(5);
    expect(t.canStraddle(t.activeSeatIndex)).toBe(true);
  });

  it('the ante lines reach the saved hand: handHistory.actionLog (street-less) and players[].actions', () => {
    const t = holdem(50, 100, 25, [[0, 5000], [1, 5000], [2, 5000]]);
    let hh: any = null;
    t.on('handHistory', (h: any) => { hh = h; });
    expect(t.startNewHand()).toBe(true);
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(hh).toBeTruthy();
    expect(anteLines(hh.actionLog)).toHaveLength(3);
    for (const p of hh.players) expect(p.actions[0]).toBe('posted ante 25');
    const pot = hh.pots.reduce((s: number, p: any) => s + p.amount, 0);
    // The winner's whole pot = antes + blinds (the uncalled part of the BB is returned and logged).
    const logged = hh.actionLog.filter((a: any) => a.action.startsWith('posted ')).reduce((s: number, a: any) => s + amountOf(a.action), 0);
    const returned = hh.actionLog.filter((a: any) => /^uncalled bet/.test(a.action)).reduce((s: number, a: any) => s + Number(/\((\d+)\)/.exec(a.action)![1]), 0);
    expect(logged - returned).toBe(pot);
  });

  it('Seven Card Stud ante 5: one posted ante per seat dealt in, before the bring-in', () => {
    const t = new SevenStudTable({ tableId: 'S', tableName: 'S', smallBlind: 10, bigBlind: 20, ante: 5, minBuyIn: 1, maxBuyIn: 100000, maxPlayers: 8 } as any);
    for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 1000, `p${i}`, false);
    expect(t.startNewHand()).toBe(true);
    const antes = anteLines(t.actionLog);
    expect(antes.map((a) => [a.seatIndex, a.action]).sort()).toEqual([[0, 'posted ante 5'], [1, 'posted ante 5'], [2, 'posted ante 5']]);
    // The bring-in comes after them; the posts add up to the pot.
    const firstOther = t.actionLog.findIndex((a) => !a.action.startsWith('posted ante '));
    expect(firstOther).toBe(3);
    expect(t.actionLog[3].action).toMatch(/^posted bring-in \d+$/);
    expect(posts(t).reduce((s, a) => s + amountOf(a.action), 0)).toBe(t.getTotalPot());
  });

  it('a bomb pot refunds every post: the refunded ante / blind lines go, its own antes are logged (posts = pot)', () => {
    const t = holdem(50, 100, 25, [[0, 5000], [1, 5000], [2, 5000], [3, 5000]]);
    expect(t.startNewHand()).toBe(true);
    expect(t.applyBombPot(200)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(anteLines(t.actionLog).map((a) => a.action)).toEqual(['posted ante 200', 'posted ante 200', 'posted ante 200', 'posted ante 200']);
    expect(t.actionLog.filter((a) => /^posted (SB|BB) /.test(a.action))).toEqual([]);
    expect(posts(t).reduce((s, a) => s + amountOf(a.action), 0)).toBe(t.getTotalPot());
  });

  it('evidence hand 11 (6 seats, 500/1000 ante 100, Chris M. 195): the posts add up to the pot after the deal', () => {
    const t = holdem(500, 1000, 100, [[0, 1920], [3, 195], [4, 2635], [5, 840], [7, 2415], [8, 995]]);
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(0);
    expect(anteLines(t.actionLog)).toHaveLength(6);
    expect(t.actionLog.find((a) => a.action.startsWith('posted SB'))).toMatchObject({ seatIndex: 3, action: 'posted SB 95' });
    // 6 x 100 + 95 + 1000 = 1,695 (e038f7b logged 1,095).
    expect(posts(t).reduce((s, a) => s + amountOf(a.action), 0)).toBe(1695);
    expect(t.getTotalPot()).toBe(1695);
  });
});

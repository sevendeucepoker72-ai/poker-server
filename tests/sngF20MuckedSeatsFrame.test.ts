/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F20, review fix-up)
 * — the auto-muck frame the poker-3d K9 display reads.
 *
 * poker-3d K9 lists other players' mucked hands from `handResult.muckedSeats`
 * and marks the viewer's OWN mucked hand inside `handResult.showdownHands`
 * ('Mucked - only you see your cards'). Server F20 sent neither: it dropped
 * every mucked seat from showdownHands (the viewer's own included) and only
 * set `seats[i].mucked`. With both new builds the mucked players vanished from
 * the showdown panel and the own line never rendered.
 *  - handResult.muckedSeats (additive, every viewer, spectators included): the
 *    seats mucked at this showdown, ascending ([] when none) - who mucked is
 *    public (the seat already says `mucked: true`); never their cards.
 *  - The viewer's OWN mucked entry stays in HIS showdownHands (his cards, his
 *    hand name - he already has them as yourCards). Every other viewer and a
 *    spectator still never get a mucked hand's entry.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { Card, Suit, Rank } from '../src/game/Card';
import { fnSrc, load } from './helpers/indexSource';

const S: Record<string, Suit> = { h: Suit.Hearts, d: Suit.Diamonds, c: Suit.Clubs, s: Suit.Spades };
const R: Record<string, Rank> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 } as any;
const cards = (str: string): Card[] => str.split(' ').map((x) => ({ rank: R[x[0]], suit: S[x[1]] }));

function table3(chips = 5000): PokerTable {
  const t = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: 25, bigBlind: 50, minBuyIn: 100, maxBuyIn: 100000, maxPlayers: 9 } as any);
  for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, chips, `p${i}`, false);
  return t;
}
/** Button 0, SB 1, BB 2: limped pre-flop, flop + turn checked, board + hands rigged on the river. */
function toRiver(t: PokerTable, board: string, hands: Record<number, string>): void {
  expect(t.startNewHand()).toBe(true);
  expect(t.playerCall(0)).toBe(true);
  expect(t.playerCall(1)).toBe(true);
  expect(t.playerCheck(2)).toBe(true);
  for (const street of [GamePhase.Flop, GamePhase.Turn]) {
    expect(t.currentPhase).toBe(street);
    for (const s of [1, 2, 0]) expect(t.playerCheck(s)).toBe(true);
  }
  t.communityCards = cards(board);
  for (const [seat, h] of Object.entries(hands)) t.seats[Number(seat)].holeCards = cards(h);
}
function stateFn() {
  return load(fnSrc('function getGameStateForPlayer('), {
    playerSessions: new Map(), sitOutTracker: new Map(),
    progressionManager: { getProgress: () => null, equippedTheme: () => null, seatCosmetics: () => null, userRecord: () => null },
    seatAccountsOfTable: () => new Map(),
    getVariantInfo: () => ({ variant: 'texas-holdem', variantName: "Texas Hold'em", holeCardCount: 2, hasDrawPhase: false, isStudGame: false }),
    turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
    MAX_SEATS: 9, GamePhase, SevenStudTable, FiveCardDrawTable, cardToString: (c: any) => `${c.rank}${c.suit}`,
    tournamentIdOfTable: () => null, qualifierIdOfTable: () => null, tournamentClockStateFor: () => null,
    tableKindOf: () => 'cash', rebuyAllowedAt: () => false, insuranceQuoteForSeat: () => null,
    straddleAllowedAt: () => false, bombPotAllowedAt: () => false,
  }, '{ getGameStateForPlayer }').exports.getGameStateForPlayer as (t: PokerTable, seat: number) => any;
}

describe('F20 review fix-up — handResult.muckedSeats and the viewer\'s own mucked entry', () => {
  function riverBettorWins(): PokerTable {
    const t = table3();
    toRiver(t, '2c 7d 9h Js 3s', { 1: 'Jh Jd', 2: '9c 9d', 0: 'Ah Kc' });
    expect(t.playerRaise(1, 100)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    expect(t.playerCall(0)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect([...(t as any).showdownMuckedSeats()].sort()).toEqual([0, 2]);
    return t;
  }

  it('every viewer and a spectator get muckedSeats [0, 2] (78e2981: no key)', () => {
    const t = riverBettorWins();
    const get = stateFn();
    for (const viewer of [0, 1, 2, -1]) expect({ viewer, m: get(t, viewer).handResult.muckedSeats }).toEqual({ viewer, m: [0, 2] });
  });

  it('a mucked viewer keeps HIS OWN entry (his cards) in showdownHands; nobody else gets it (78e2981: dropped for him too)', () => {
    const t = riverBettorWins();
    const get = stateFn();
    const own2 = get(t, 2).handResult.showdownHands;
    expect(own2.map((h: any) => h.seatIndex).sort()).toEqual([1, 2]);
    expect(own2.find((h: any) => h.seatIndex === 2).holeCards).toEqual([{ suit: S.c, rank: 9, display: '9' + S.c }, { suit: S.d, rank: 9, display: '9' + S.d }]);
    const own0 = get(t, 0).handResult.showdownHands;
    expect(own0.map((h: any) => h.seatIndex).sort()).toEqual([0, 1]);
    // the winner and a spectator: only the shown hand
    expect(get(t, 1).handResult.showdownHands.map((h: any) => h.seatIndex)).toEqual([1]);
    expect(get(t, -1).handResult.showdownHands.map((h: any) => h.seatIndex)).toEqual([1]);
    // the seat rows stay as F20 made them: no cards of a mucked hand in another viewer's seat row
    expect(get(t, 1).seats[2].holeCards).toBeUndefined();
    expect(get(t, 1).seats[2].mucked).toBe(true);
  });

  it('nothing mucked (an all-in showdown): muckedSeats [] and every hand listed, as before', () => {
    const t = table3(1000);
    expect(t.startNewHand()).toBe(true);
    expect(t.playerAllIn(0)).toBe(true);
    expect(t.playerCall(1)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    const st = stateFn()(t, -1);
    expect(st.handResult.muckedSeats).toEqual([]);
    expect(st.handResult.showdownHands).toHaveLength(3);
  });
});

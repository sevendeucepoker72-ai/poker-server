/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F20) — AUTO-MUCK.
 * At a contested showdown that is NOT an all-in, a losing hand that does not
 * have to be shown is mucked: not revealed in any other player's state, not in
 * the shared hand-history record (its own player keeps his cards: yourCards,
 * viewerHoleCards). TDA show order: the last aggressor of the final street
 * shows first, then clockwise; with no bet on the final street, the first seat
 * left of the button. Each later hand is shown only if it beats or ties the
 * best hand shown so far. Winners (any share of any pot) and ties are always
 * shown; when any seat still in the hand is all-in, every hand is shown.
 * A mucked seat's player may still Show Hand (showMuckedHand) afterwards.
 * Internal facts are unchanged (lastHandResult.showdownHands keeps every
 * tabled seat, flagged `mucked`: the prediction "showdown" fact counts them).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { Card, Suit, Rank } from '../src/game/Card';
import { fnSrc, load, handlerSrc, flush, SEAT_SESSION_FOR_SRC, MUCK_SHOWS_SRC } from './helpers/indexSource';
import { cardToString } from '../src/game/Card';

const S: Record<string, Suit> = { h: Suit.Hearts, d: Suit.Diamonds, c: Suit.Clubs, s: Suit.Spades };
const R: Record<string, Rank> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 } as any;
const cards = (str: string): Card[] => str.split(' ').map((x) => ({ rank: R[x[0]], suit: S[x[1]] }));

function table3(chips = 5000): PokerTable {
  const t = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: 25, bigBlind: 50, minBuyIn: 100, maxBuyIn: 100000, maxPlayers: 9 } as any);
  for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, chips, `p${i}`, false);
  return t;
}

/**
 * Button 0, SB 1, BB 2. Pre-flop limped, flop + turn checked; on the river
 * `river` is played after the board / hands are rigged.
 */
function toRiver(t: PokerTable, board: string, hands: Record<number, string>): void {
  expect(t.startNewHand()).toBe(true);
  expect(t.playerCall(0)).toBe(true);
  expect(t.playerCall(1)).toBe(true);
  expect(t.playerCheck(2)).toBe(true);
  for (const street of [GamePhase.Flop, GamePhase.Turn]) {
    expect(t.currentPhase).toBe(street);
    for (const s of [1, 2, 0]) expect(t.playerCheck(s)).toBe(true);
  }
  expect(t.currentPhase).toBe(GamePhase.River);
  t.communityCards = cards(board);
  for (const [seat, h] of Object.entries(hands)) t.seats[Number(seat)].holeCards = cards(h);
}
const BOARD = '2c 7d 9h Js 3s';
const mucked = (t: PokerTable) => [...(t as any).showdownMuckedSeats()].sort();

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

describe('F20 — auto-muck at a non-all-in showdown', () => {
  it('the river bettor (seat 1) holds the best hand: both callers lose and are mucked; only his cards are shown', () => {
    const t = table3();
    let hh: any = null;
    t.on('handHistory', (h: any) => { hh = h; });
    toRiver(t, BOARD, { 1: 'Jh Jd', 2: '9c 9d', 0: 'Ah Kc' });
    expect(t.playerRaise(1, 100)).toBe(true);   // the last aggressor
    expect(t.playerCall(2)).toBe(true);
    expect(t.playerCall(0)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.wentToShowdown).toBe(true);
    expect(mucked(t)).toEqual([0, 2]);                       // e038f7b: every hand revealed
    const row = (s: number) => hh.players.find((p: any) => p.seatIndex === s);
    expect(row(1).holeCards).toHaveLength(2);
    expect(row(1).handName).toBeTruthy();
    for (const s of [0, 2]) expect({ s, cards: row(s).holeCards, name: row(s).handName, mucked: row(s).mucked }).toEqual({ s, cards: null, name: null, mucked: true });
    // Internal facts keep every tabled seat (the prediction 'showdown' fact).
    expect(t.lastHandResult!.showdownHands).toHaveLength(3);
    // The state: another player and a spectator never see a mucked hand; its owner keeps his own.
    const get = stateFn();
    for (const viewer of [1, -1]) {
      const st = get(t, viewer);
      expect(st.seats[1].holeCards).toHaveLength(2);
      for (const s of [0, 2]) {
        expect(st.seats[s].holeCards).toBeUndefined();
        expect(st.seats[s].mucked).toBe(true);
      }
      expect(st.handResult.showdownHands.map((h: any) => h.seatIndex)).toEqual([1]);
    }
    expect(get(t, 2).yourCards).toHaveLength(2);
  });

  it('the river bettor loses: he still shows first; seat 2 beats him and shows; seat 0 (better than seat 1, worse than seat 2) is mucked', () => {
    const t = table3();
    toRiver(t, BOARD, { 1: '4c 5c', 2: 'Jh Jd', 0: '9c 9d' });
    expect(t.playerRaise(1, 100)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    expect(t.playerCall(0)).toBe(true);
    expect(mucked(t)).toEqual([0]);
  });

  it('checked down (no aggressor): the first seat left of the button shows first; a tie is shown', () => {
    const t = table3();
    toRiver(t, '2c 7d 9h Js Qs', { 1: 'Ah Kh', 2: 'Ad Kd', 0: '3c 4h' });
    for (const s of [1, 2]) expect(t.playerCheck(s)).toBe(true);
    expect(t.playerCheck(0)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    // Seat 1 shows first (left of the button), seat 2 ties (shown), seat 0 loses (mucked).
    expect(mucked(t)).toEqual([0]);
    const w = t.lastHandResult!.winners.map((x) => x.seatIndex).sort();
    expect(w).toEqual([1, 2]);
  });

  it('an ALL-IN showdown shows every hand', () => {
    const t = table3(1000);
    expect(t.startNewHand()).toBe(true);
    expect(t.playerAllIn(0)).toBe(true);
    expect(t.playerCall(1)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    // Run out (no one left to act): the hand is over.
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.wentToShowdown).toBe(true);
    expect(mucked(t)).toEqual([]);
  });

  it('a hand won by a fold mucks nothing (nothing is revealed anyway)', () => {
    const t = table3();
    expect(t.startNewHand()).toBe(true);
    t.playerFold(0); t.playerFold(1);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(mucked(t)).toEqual([]);
  });

  it('a mucked hand may still be shown by its player (Show Hand) once the hand is over; a shown loser cannot "show" again', async () => {
    const t = table3();
    toRiver(t, BOARD, { 1: 'Jh Jd', 2: '9c 9d', 0: 'Ah Kc' });
    expect(t.playerRaise(1, 100)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    expect(t.playerCall(0)).toBe(true);
    expect(mucked(t)).toEqual([0, 2]);
    const playerSessions = new Map<string, any>();
    for (let i = 0; i < 3; i++) playerSessions.set(`S${i}`, { socketId: `S${i}`, tableId: 'T1', seatIndex: i, playerName: `P${i}`, playerId: `p${i}` });
    const room: Array<[string, string, any]> = [];
    const handler = handlerSrc('showMuckedHand', '\n  });\n');
    const { exports: m } = load(`${MUCK_SHOWS_SRC}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${handler}\n}`, {
      playerSessions, multiTableSessions: new Map(), tableManager: { getTable: (id: string) => (id === 'T1' ? t : undefined) },
      GamePhase, cardToString, io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) },
    }, '{ wire }');
    const show = async (id: string) => {
      const handlers: Record<string, (d?: any) => any> = {};
      m.wire({ id, emit() {}, on: (ev: string, fn: any) => { handlers[ev] = fn; } });
      await handlers.showMuckedHand({});
      await flush();
    };
    await show('S2');
    expect(room).toEqual([['table:T1', 'muckedHandRevealed', expect.objectContaining({ seatIndex: 2, handNumber: t.handNumber })]]);
    await show('S1');   // the shown winner: nothing to show
    expect(room).toHaveLength(1);
  });
});

/**
 * Gameplay audit 2026-10-21 — cluster S2 (betting rules: raises, reopening,
 * blinds / button, legal-action fields), on the REAL engine (src/game) and the
 * real getGameStateForPlayer text of src/index.ts.
 *
 *   F3   a shove by a seat the betting was NOT reopened to is only a call
 *        (playerAllIn re-raised the whole stack — TDA 41).
 *   F7   short all-ins that ADD UP to a full raise reopen the betting (TDA 47).
 *   F8   after a UTG straddle the min-raise is two straddles (4 BB), and a
 *        short all-in under it does not reopen the betting.
 *   F91  a mid-hand blind level-up does not change the hand in progress: its
 *        opening bet / min-raise stay at the level it was dealt at.
 *   F10  going heads-up after the button leaves / busts: nobody posts the big
 *        blind twice in a row (TDA 34).
 *   F11  the big blind leaves / busts: no small blind next hand (dead), the
 *        button moves to the old small blind, then a dead button (TDA 33).
 *   F13  a player who sits down between the small and big blind is not dealt
 *        in on the button: the old small blind gets it, the newcomer waits
 *        out that one hand (TDA dead zone). Stud deals him in.
 *   F30  fixed limit: the big-bet streets take exactly the big bet (Stud
 *        5th-7th, Triple Draw / Badugi Bet2-Bet4).
 *   F12 / F41  the state says whether this seat may raise (`canRaise`), the
 *        largest legal raise-to (`maxRaise`) and the `bettingStructure`.
 *   F19  a hand won by fold names its winner in the pot list.
 *   F23  "Split Pot!" (isChoppedPot) only when one pot was really split.
 *
 * Every test fails on the pre-fix code (the old numbers are quoted inline).
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { BadugiTable } from '../src/game/variants/BadugiTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { Card, cardToString } from '../src/game/Card';
import { fnSrc, load } from './helpers/indexSource';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const key = (c: Card) => c.suit * 16 + c.rank;

const T = 't';
const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: T, tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 100, ...over } as any);
const seatAt = (t: PokerTable, stacks: Record<number, number>) => {
  for (const [i, chips] of Object.entries(stacks)) expect(t.sitDown(Number(i), `P${i}`, chips, `p${i}`, false)).toBe(true);
};
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

/** Everyone calls / checks while `more()` holds. */
function callAround(t: PokerTable, more: () => boolean): void {
  for (let g = 0; g < 80 && more(); g++) {
    const a = t.activeSeatIndex;
    expect(a).toBeGreaterThanOrEqual(0);
    const owes = t.currentBetToMatch > t.seats[a].currentBet;
    expect(owes ? t.playerCall(a) : t.playerCheck(a)).toBe(true);
  }
}
const callDown = (t: PokerTable) => {
  callAround(t, () => t.isHandInProgress());
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
};

/** Everyone folds to the last player. */
function foldOut(t: PokerTable): void {
  for (let g = 0; g < 20 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

/** Who posted the live small / big blind this hand (-1 = nobody). */
function blinds(t: PokerTable): { sb: number; bb: number } {
  const find = (p: string) => t.actionLog.find((a) => a.action.startsWith(p))?.seatIndex ?? -1;
  return { sb: find('posted SB'), bb: find('posted BB') };
}

/** Deal the next hand; returns { button, sb, bb }. */
function deal(t: PokerTable): { button: number; sb: number; bb: number } {
  expect(t.startNewHand()).toBe(true);
  return { button: t.dealerButtonSeat, ...blinds(t) };
}

// The REAL getGameStateForPlayer (sliced from src/index.ts), as r2TableState.test.ts runs it.
const STATE = [
  fnSrc('function getVariantInfo('), fnSrc('function getGameStateForPlayer('),
  fnSrc('function tableKindOf('), fnSrc('function bombPotAllowedAt('),
  fnSrc('function straddleAllowedAt('), fnSrc('function isPlainHoldemTable('),
].join('\n');
function stateOf(table: PokerTable, seat: number): any {
  const { exports } = load(STATE, {
    isTournamentTable: () => false, spinGoMultipliers: new Map(), careerTables: new Map(),
    allInOrFoldTables: new Set(), quickTables: new Set(), challengeTables: new Map(),
    clubTableIds: new Set(), privateTableIds: new Set(), PokerTable, OmahaTable,
    ShortDeckTable, FiveCardDrawTable, SevenStudTable, MAX_SEATS, GamePhase, cardToString,
    playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
    dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null,
    tournamentIdOfTable: () => undefined, rebuyAllowedAt: () => true, progressionManager: { getProgress: () => null },
  }, 'getGameStateForPlayer');
  return exports(table, seat, false);
}

/**
 * A 4-handed flop: P1 bets 100, P2 (150 behind) shoves +50 — short, it does
 * not reopen — and P3, P0 call 150. The action is back on P1, who already acted.
 */
function shortAllInSpot(): PokerTable {
  const t = new PokerTable(cfg());
  seatAt(t, { 0: 5000, 1: 5000, 2: 200, 3: 5000 });
  t.startNewHand();                                   // button 0, SB 1, BB 2, UTG 3
  callAround(t, () => t.currentPhase === GamePhase.PreFlop);
  expect(t.currentPhase).toBe(GamePhase.Flop);
  expect(t.activeSeatIndex).toBe(1);
  expect(t.playerRaise(1, 100)).toBe(true);
  expect(t.playerAllIn(2)).toBe(true);                // 150: +50 < the 100 bet
  expect(t.currentBetToMatch).toBe(150);
  expect(t.playerCall(3)).toBe(true);
  expect(t.playerCall(0)).toBe(true);
  expect(t.activeSeatIndex).toBe(1);
  return t;
}

describe('F3 — a shove the betting was not reopened to is only a call (TDA 41)', () => {
  it('playerAllIn by the bettor facing a short all-in calls; it no longer re-raises the whole stack', () => {
    const t = shortAllInSpot();
    const chips = tableChips(t);
    expect(t.seats[1].hasActedSinceLastFullRaise).toBe(true);
    expect(t.canRaise(1)).toBe(false);
    expect(t.playerRaise(1, 1000)).toBe(false);       // Raise was already refused
    // The callers' "acted" flags at the moment P1's action lands (before the street moves on).
    const flagsAtAction: boolean[] = [];
    t.on('playerAction', (a: any) => { if (a.seatIndex === 1) flagsAtAction.push(t.seats[3].hasActedSinceLastFullRaise, t.seats[0].hasActedSinceLastFullRaise); });
    expect(t.playerAllIn(1)).toBe(true);              // the All-In button / a bot's AllIn
    expect(flagsAtAction).toEqual([true, true]);      // old: both reset (the shove counted as a full raise)
    // Old: P1 shoved to 4,950 (currentBetToMatch 4,950, P3 + P0 back on the
    // clock owing 4,800). Now: a call of 50 — the round closes, P1 keeps 4,800.
    expect(t.seats[1].allIn).toBe(false);
    expect(t.seats[1].chipCount).toBe(4800);
    expect(t.actionLog.filter((a) => a.seatIndex === 1).pop()!.action).toBe('called 50');
    expect(t.currentPhase).toBe(GamePhase.Turn);
    expect(tableChips(t)).toBe(chips);
  });

  it('an all-in for no more than the call is still an all-in call; a reopened seat may still shove', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 300, 2: 5000 });
    t.startNewHand();                                 // button 0, SB 1, BB 2, UTG 0
    expect(t.playerRaise(0, 400)).toBe(true);
    expect(t.playerAllIn(1)).toBe(true);              // 300 < the 400 call: all-in for less
    expect(t.seats[1].allIn).toBe(true);
    expect(t.canRaise(2)).toBe(true);                 // the big blind has not acted
    expect(t.playerAllIn(2)).toBe(true);
    expect(t.seats[2].allIn).toBe(true);
  });
});

describe('F7 — short all-ins that add up to a full raise reopen the betting (TDA 47)', () => {
  /** 5-handed flop: P1 bets 100, P2 shoves to 160, P3 calls 160, P4 shoves to 220, P0 folds. */
  function cumulativeSpot(): PokerTable {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 210, 3: 5000, 4: 270 });
    t.startNewHand();                                 // button 0, SB 1, BB 2
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.activeSeatIndex).toBe(1);
    expect(t.playerRaise(1, 100)).toBe(true);
    expect(t.playerAllIn(2)).toBe(true);              // 160 (+60, short)
    expect(t.playerCall(3)).toBe(true);               // P3 acts at 160
    expect(t.playerAllIn(4)).toBe(true);              // 220 (+60, short)
    expect(t.lastRaiseAmount).toBe(100);
    expect(t.playerFold(0)).toBe(true);
    expect(t.activeSeatIndex).toBe(1);
    return t;
  }

  it('the bettor faces 120 (>= the 100 full raise): his re-raise is legal (old: refused)', () => {
    const t = cumulativeSpot();
    expect(t.canRaise(1)).toBe(true);
    expect(t.playerRaise(1, 500)).toBe(true);
    expect(t.currentBetToMatch).toBe(500);
  });

  it('a seat that acted after the first short all-in faces only 60: call or fold', () => {
    const t = cumulativeSpot();
    expect(t.playerCall(1)).toBe(true);
    expect(t.activeSeatIndex).toBe(3);
    expect(t.canRaise(3)).toBe(false);
    expect(t.playerRaise(3, 600)).toBe(false);
    expect(t.playerAllIn(3)).toBe(true);              // F3: a call of 60
    expect(t.seats[3].allIn).toBe(false);
    expect(t.seats[3].chipCount).toBe(5000 - 50 - 220);
  });
});

describe('F8 — after a UTG straddle a full raise is a straddle more', () => {
  it('min-raise 4 BB (old 3 BB: a raise to 150 was accepted)', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000 });
    t.startNewHand();
    const utg = t.activeSeatIndex;
    expect(t.straddle(utg)).toBe(true);
    expect(t.getMinRaise()).toBe(200);
    const next = t.activeSeatIndex;
    expect(t.playerRaise(next, 150)).toBe(false);
    expect(t.playerRaise(next, 200)).toBe(true);
  });

  it('a 60-chip all-in over the straddle is short: a caller of the straddle is not reopened', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000, 4: 5000, 5: 160 });
    t.startNewHand();                                 // button 0, SB 1, BB 2, UTG 3
    expect(t.straddle(3)).toBe(true);
    expect(t.playerCall(4)).toBe(true);               // P4 calls the straddle (100)
    expect(t.playerAllIn(5)).toBe(true);              // 160: +60 < the 100 straddle
    expect(t.seats[4].hasActedSinceLastFullRaise).toBe(true);   // old: reset (60 >= the old 50)
    expect(t.canRaise(4)).toBe(false);
    expect(t.getMinRaise()).toBe(260);
    expect(t.seats[3].hasActedSinceLastFullRaise).toBe(false);  // the straddler keeps his option
  });

  it('fixed limit keeps its one-small-bet raise after a straddle', () => {
    const t = new FiveCardDrawTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000 });
    t.startNewHand();
    const utg = t.activeSeatIndex;
    expect(t.straddle(utg)).toBe(true);
    expect(t.getMinRaise()).toBe(150);
    expect(t.maxRaiseFor(t.activeSeatIndex)).toBe(150);
  });
});

describe('F91 — a mid-hand blind level-up applies from the next hand', () => {
  it('the flop / turn minimum stays the dealt level; the bet the state offers is accepted', () => {
    const t = new PokerTable(cfg({ smallBlind: 10, bigBlind: 20 }));
    seatAt(t, { 0: 1000, 1: 1000, 2: 1000 });
    t.startNewHand();
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    // The blindLevelUp listener rewrites the live config at once.
    t.config.smallBlind = 20;
    t.config.bigBlind = 40;
    expect(t.getMinRaise()).toBe(20);                 // what the client offers
    const a = t.activeSeatIndex;
    expect(t.playerRaise(a, 20)).toBe(true);          // old: refused (20 < the new 40)
    callAround(t, () => t.currentPhase === GamePhase.Flop);
    expect(t.currentPhase).toBe(GamePhase.Turn);
    expect(t.getMinRaise()).toBe(20);                 // old: 40 (lastRaiseAmount = config.bigBlind)
    callDown(t);
    t.startNewHand();                                 // the new level starts here
    expect(t.handBigBlind).toBe(40);
    expect(t.getMinRaise()).toBe(80);
  });
});

describe('F10 — going heads-up never makes one player post the big blind twice', () => {
  for (const how of ['stands up', 'busts'] as const) {
    it(`3-handed, the button ${how}: the old SB takes the big blind`, () => {
      const t = new PokerTable(cfg());
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
      expect(deal(t)).toEqual({ button: 0, sb: 1, bb: 2 });
      foldOut(t);
      if (how === 'stands up') t.standUp(0); else t.seats[0].chipCount = 0;
      // Old: button 1 / SB 1 / BB 2 — seat 2 posted the big blind again.
      expect(deal(t)).toEqual({ button: 2, sb: 2, bb: 1 });
      foldOut(t);
      expect(deal(t)).toEqual({ button: 1, sb: 1, bb: 2 });   // steady heads-up alternates
      foldOut(t);
      expect(deal(t)).toEqual({ button: 2, sb: 2, bb: 1 });
    });
  }

  it('3-handed, the big blind leaves: same as before (nobody repeats the big blind)', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    deal(t); foldOut(t);
    t.standUp(2);
    expect(deal(t)).toEqual({ button: 1, sb: 1, bb: 0 });
  });
});

describe('F11 — the big blind leaves or busts: dead small blind, then a dead button (TDA 33)', () => {
  for (const how of ['stands up', 'busts'] as const) {
    it(`4-handed, the big blind ${how}`, () => {
      const t = new PokerTable(cfg());
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000 });
      expect(deal(t)).toEqual({ button: 0, sb: 1, bb: 2 });
      foldOut(t);
      if (how === 'stands up') t.standUp(2); else t.seats[2].chipCount = 0;
      // Old: button 0 again, P1 posted the small blind again.
      expect(deal(t)).toEqual({ button: 1, sb: -1, bb: 3 });
      expect(t.deadSmallBlind).toBe(true);
      expect(t.getTotalPot()).toBe(50);
      foldOut(t);
      // The button moves onto the empty seat 2 (dead button); P3 posts the small blind.
      expect(deal(t)).toEqual({ button: 2, sb: 3, bb: 0 });
      expect(t.deadButton).toBe(true);
      foldOut(t);
      expect(deal(t)).toEqual({ button: 3, sb: 0, bb: 1 });
      expect(t.deadButton).toBe(false);
      expect(t.deadSmallBlind).toBe(false);
    });
  }

  it('missed blinds are marked at the positions really dealt (a sitting-out UTG owes nothing)', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000, 4: 5000 });
    deal(t); foldOut(t);                               // button 0, SB 1, BB 2
    t.standUp(2);
    t.setSittingOutSeats([4]);
    expect(deal(t)).toEqual({ button: 1, sb: -1, bb: 3 });
    // Seat 4 is UTG this hand — not the big blind the old walk from the button
    // (1 -> 3 -> 4) would have named.
    expect(t.seats[4].deadBlindOwedChips).toBe(0);
  });
});

describe('F13 — a newcomer between the small and big blind waits out the dead zone', () => {
  it('the old small blind gets the button; the newcomer is dealt out one hand, then plays, then posts the big blind', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 2: 5000, 4: 5000 });
    expect(deal(t)).toEqual({ button: 0, sb: 2, bb: 4 });
    foldOut(t);
    expect(t.sitDown(3, 'New', 5000, 'pNew', false)).toBe(true);
    // Old: the newcomer at seat 3 had the button, dealt in without posting.
    expect(deal(t)).toEqual({ button: 2, sb: 4, bb: 0 });
    expect(t.seats[3].folded).toBe(true);
    expect(t.seats[3].holeCards).toHaveLength(0);
    expect(t.seats[3].totalInvestedThisHand).toBe(0);
    foldOut(t);
    expect(t.seats[3].chipCount).toBe(5000);
    expect(deal(t)).toEqual({ button: 4, sb: 0, bb: 2 });
    expect(t.seats[3].holeCards).toHaveLength(2);     // dealt in from the next hand on
    foldOut(t);
    expect(deal(t)).toEqual({ button: 0, sb: 2, bb: 3 });
  });

  it('a dealt-out newcomer pays no ante', () => {
    const t = new PokerTable(cfg({ ante: 10 }));
    seatAt(t, { 0: 5000, 2: 5000, 4: 5000 });
    deal(t); foldOut(t);
    t.sitDown(3, 'New', 5000, 'pNew', false);
    deal(t);
    expect(t.seats[3].chipCount).toBe(5000);
    expect(t.seats[3].totalInvestedThisHand).toBe(0);
  });

  it('never deals a hand down to two players: 3 seats + a newcomer after one leaves is dealt in', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 2: 5000, 4: 5000 });
    deal(t); foldOut(t);                               // button 0, SB 2, BB 4
    t.standUp(2);
    t.sitDown(3, 'New', 5000, 'pNew', false);
    deal(t);
    expect(t.seats[3].holeCards).toHaveLength(2);
  });

  it('a table everyone left and new players filled starts its rotation afresh (no dead blind, nobody dealt out)', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 2: 5000, 4: 5000 });
    deal(t); foldOut(t);
    for (const i of [0, 2, 4]) t.standUp(i);
    for (const i of [1, 3, 5, 7]) t.sitDown(i, `N${i}`, 5000, `n${i}`, false);
    expect(deal(t)).toEqual({ button: 1, sb: 3, bb: 5 });
    for (const i of [1, 3, 5, 7]) expect(t.seats[i].holeCards).toHaveLength(2);
  });

  it('Stud (no blinds) deals a newcomer into the next hand', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatAt(t, { 0: 5000, 2: 5000, 4: 5000 });
    t.startNewHand(); foldOut(t);
    t.sitDown(3, 'New', 5000, 'pNew', false);
    expect(t.startNewHand()).toBe(true);
    expect(t.seats[3].holeCards.length).toBeGreaterThan(0);
  });
});

describe('F30 — fixed limit: every big-bet street takes exactly the big bet', () => {
  function expectBigBetStreet(t: PokerTable): void {
    const a = t.activeSeatIndex;
    expect(t.getMinRaise()).toBe(100);                // old: 50
    expect(t.maxRaiseFor(a)).toBe(100);
    expect(t.playerRaise(a, 50)).toBe(false);         // old: a half-size bet was accepted
    expect(t.playerRaise(a, 100)).toBe(true);
    const b = t.activeSeatIndex;
    expect(t.getMinRaise()).toBe(200);
    expect(t.playerRaise(b, 125)).toBe(false);        // old: an odd-size raise was accepted
    expect(t.playerRaise(b, 200)).toBe(true);
    expect(t.lastRaiseAmount).toBe(100);
  }

  it('Seven Card Stud 25/50: 5th street', () => {
    const t = new SevenStudTable(cfg(), false, false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    callAround(t, () => t.currentPhase === GamePhase.ThirdStreet || t.currentPhase === GamePhase.FourthStreet);
    expect(t.currentPhase).toBe(GamePhase.FifthStreet);
    expectBigBetStreet(t);
  });

  it('a leaver\'s bet lowered away (F22) leaves the street\'s big bet as the raise size', () => {
    const t = new SevenStudTable(cfg(), false, false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    callAround(t, () => t.currentPhase === GamePhase.ThirdStreet || t.currentPhase === GamePhase.FourthStreet);
    const a = t.activeSeatIndex;
    expect(t.playerCheck(a)).toBe(true);
    const b = t.activeSeatIndex;
    expect(t.playerRaise(b, 100)).toBe(true);
    const c = t.activeSeatIndex;
    expect(t.forceFoldSeat(b)).toBe(true);            // the bettor leaves: his bet is dead money
    expect(t.currentBetToMatch).toBe(0);
    expect(t.getMinRaise()).toBe(100);                // old: 50 (one big blind)
    expect(t.playerRaise(c, 50)).toBe(false);
  });

  it('4th street (the small bet) is unchanged', () => {
    const t = new SevenStudTable(cfg(), false, false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    callAround(t, () => t.currentPhase === GamePhase.ThirdStreet);
    expect(t.currentPhase).toBe(GamePhase.FourthStreet);
    expect(t.getMinRaise()).toBe(50);
    expect(t.maxRaiseFor(t.activeSeatIndex)).toBe(50);
  });

  // 2026-10-21 (gameplay S3, F39) — the big bet starts after the SECOND draw
  // (Bet3); Bet2 is a small-bet round (gameplay_S3 tests it). This case used
  // to check Bet2.
  for (const [name, mk] of [
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true)],
    ['Badugi', () => new BadugiTable(cfg())],
  ] as Array<[string, () => FiveCardDrawTable]>) {
    it(`${name}: Bet3`, () => {
      const t = mk();
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
      t.startNewHand();
      callAround(t, () => t.currentPhase === GamePhase.PreFlop);
      expect(t.currentPhase).toBe(GamePhase.Draw1);
      for (const i of [0, 1, 2]) expect(t.playerDraw(i, [])).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Bet2);
      callAround(t, () => t.currentPhase === GamePhase.Bet2);
      expect(t.currentPhase).toBe(GamePhase.Draw2);
      for (const i of [0, 1, 2]) expect(t.playerDraw(i, [])).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Bet3);
      expectBigBetStreet(t);
    });
  }
});

describe('F12 / F41 — canRaise, maxRaise and bettingStructure in the game state', () => {
  it('always present: no-limit -> maxRaise null; a spectator may not raise', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    const me = stateOf(t, t.activeSeatIndex);
    expect(me.canRaise).toBe(true);
    expect(me.maxRaise).toBeNull();
    expect(me.bettingStructure).toBe('no-limit');
    const spec = stateOf(t, -1);
    expect(spec.canRaise).toBe(false);
    expect('maxRaise' in spec).toBe(true);
    expect(spec.maxRaise).toBeNull();
    // Between hands nobody may raise.
    foldOut(t);
    expect(stateOf(t, 0).canRaise).toBe(false);
  });

  it('the bettor facing a short all-in: canRaise false (Raise hidden, All-In is a call)', () => {
    const t = shortAllInSpot();
    expect(stateOf(t, 1).canRaise).toBe(false);
  });

  it('Pot-Limit Omaha: maxRaise is the pot-limit cap, not the stack', () => {
    const t = new OmahaTable(cfg({ smallBlind: 50, bigBlind: 100 }), false, 4);
    seatAt(t, { 0: 10000, 1: 10000, 2: 10000 });
    t.startNewHand();
    const s = stateOf(t, t.activeSeatIndex);          // UTG facing the 100 big blind, pot 150
    expect(s.bettingStructure).toBe('pot-limit');
    expect(s.maxRaise).toBe(350);
    expect(s.canRaise).toBe(true);
  });

  it('a short PLO stack: maxRaise is its stack (no cap below it)', () => {
    const t = new OmahaTable(cfg({ smallBlind: 50, bigBlind: 100 }), false, 4);
    seatAt(t, { 0: 300, 1: 10000, 2: 10000 });
    t.startNewHand();                                 // UTG = seat 0
    expect(t.activeSeatIndex).toBe(0);
    expect(stateOf(t, 0).maxRaise).toBe(300);
  });

  it('Stud facing only the bring-in: maxRaise is the completion', () => {
    const t = new SevenStudTable(cfg(), false, false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    expect(t.currentBetToMatch).toBe(25);             // the bring-in
    expect(stateOf(t, t.activeSeatIndex)).toMatchObject({ bettingStructure: 'fixed-limit', maxRaise: 50, canRaise: true });
  });

  it('fixed limit: maxRaise is the street bet; capped rounds cannot raise', () => {
    const t = new FiveCardDrawTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    const a = t.activeSeatIndex;
    expect(stateOf(t, a)).toMatchObject({ bettingStructure: 'fixed-limit', maxRaise: 100, canRaise: true });
    // Bet + three raises: capped.
    let g = 0;
    while (!t.isRaiseCapped() && g++ < 10) expect(t.playerRaise(t.activeSeatIndex, t.getMinRaise())).toBe(true);
    expect(stateOf(t, t.activeSeatIndex).canRaise).toBe(false);
  });
});

describe('F19 — a hand won by fold names its winner in the pot list', () => {
  it('lastHandResult.pots and handHistory.pots carry the winner and the amount', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    let history: any = null;
    t.on('handHistory', (h) => { history = h; });
    t.startNewHand();                                 // UTG = seat 0
    expect(t.playerRaise(0, 150)).toBe(true);
    foldOut(t);
    const won = t.lastHandResult!.winners[0];
    expect(won.seatIndex).toBe(0);
    // Old: [{ name: 'Main Pot', amount: 125, winners: [], winnerAmounts: [] }].
    expect(t.lastHandResult!.pots).toEqual([{ name: 'Main Pot', amount: won.chipsWon, winners: [0], winnerAmounts: [{ seatIndex: 0, amount: won.chipsWon }] }]);
    expect(history.pots).toEqual(t.lastHandResult!.pots);
  });

  it('the all-fold refund names nobody', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    t.forceFoldSeat(1);
    t.forceFoldSeat(2);
    expect(t.playerFold(0)).toBe(true);
    for (const p of t.lastHandResult!.pots as any[]) expect(p.winnerAmounts).toEqual([]);
  });

  it('pot names match exactly ("Side Pot 1" never takes "Side Pot 10"), hi/lo halves sum per seat', () => {
    const t = new PokerTable(cfg());
    const out = (t as any).buildPotBreakdown(
      [{ name: 'Side Pot 1', amount: 40 }, { name: 'Side Pot 10', amount: 60 }],
      [
        { seatIndex: 2, amount: 30, potName: 'Side Pot 10 (High)' },
        { seatIndex: 2, amount: 30, potName: 'Side Pot 10 (Low)' },
        { seatIndex: 1, amount: 40, potName: 'Side Pot 1' },
      ],
      null,
    );
    expect(out).toEqual([
      { name: 'Side Pot 1', amount: 40, winners: [1], winnerAmounts: [{ seatIndex: 1, amount: 40 }] },
      { name: 'Side Pot 10', amount: 60, winners: [2], winnerAmounts: [{ seatIndex: 2, amount: 60 }] },
    ]);
  });

  it('Omaha Hi-Lo: a split pot names both winners; a scoop is one entry with the whole pot', () => {
    const split = new OmahaTable(cfg(), true, 4);
    seatAt(split, { 0: 1000, 1: 1000 });
    split.startNewHand();
    rig(split, { 0: 'Ah 2h Kc Kd', 1: 'Qs Qh 9c 9d' }, '3c 4d 8s Qd Jc');
    callDown(split);
    const sp: any = split.lastHandResult!.pots[0];
    expect(sp.winners.slice().sort()).toEqual([0, 1]);
    expect(sp.winnerAmounts.slice().sort((a: any, b: any) => a.seatIndex - b.seatIndex)).toEqual([{ seatIndex: 0, amount: 50 }, { seatIndex: 1, amount: 50 }]);
    expect(stateOf(split, 0).isChoppedPot).toBe(true);

    const scoop = new OmahaTable(cfg(), true, 4);
    seatAt(scoop, { 0: 1000, 1: 1000 });
    scoop.startNewHand();
    rig(scoop, { 0: 'Ah 2h Kc Kd', 1: 'Qs Qh Ts Td' }, '3c 4d 5s Kh 9c');
    callDown(scoop);
    expect(scoop.lastHandResult!.pots[0]).toMatchObject({ winners: [0], winnerAmounts: [{ seatIndex: 0, amount: 100 }] });
    expect(stateOf(scoop, 0).isChoppedPot).toBeUndefined();
  });
});

describe('F23 — "Split Pot!" only when one pot was really split', () => {
  it('3-way all-in, the short stack wins the main pot and another the side pot: no chop', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 100, 1: 300, 2: 600 });
    t.startNewHand();                                 // button 0, SB 1, BB 2, UTG 0
    rig(t, { 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd' }, '2c 7d 9h Js 3s');
    expect(t.playerAllIn(0)).toBe(true);
    expect(t.playerAllIn(1)).toBe(true);
    expect(t.playerCall(2)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.lastHandResult!.winners.map((w) => w.seatIndex).sort()).toEqual([0, 1]);
    const s = stateOf(t, 0);
    // Old: isChoppedPot true, "Split Pot! P0 300 / P1 400".
    expect(s.isChoppedPot).toBeUndefined();
    expect(s.chopDetails).toBeUndefined();
  });

  it('an equal-hand chop is still a split pot, with each share', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 1000, 1: 1000 });
    t.startNewHand();
    rig(t, { 0: 'Ah Kd', 1: 'As Kc' }, '2c 7d 9h Js 3s');
    expect(t.playerAllIn(0)).toBe(true);
    expect(t.playerCall(1)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    const s = stateOf(t, 0);
    expect(s.isChoppedPot).toBe(true);
    expect(s.chopDetails.slice().sort((a: any, b: any) => a.seatIndex - b.seatIndex)).toEqual([
      { seatIndex: 0, playerName: 'P0', share: 1000 },
      { seatIndex: 1, playerName: 'P1', share: 1000 },
    ]);
  });

  it('a chopped main pot lists only its two winners and their shares, not the side-pot winner', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 100, 1: 100, 2: 600, 3: 600 });
    t.startNewHand();                                 // button 0, SB 1, BB 2, UTG 3
    // AK / AK chop the 400 main pot (kings, ace kicker); QQ beats J-high for the 1,000 side pot.
    rig(t, { 0: 'Ah Kd', 1: 'As Kc', 2: 'Qh Qd', 3: 'Jh Td' }, 'Kh 7d 9c 4s 3c');
    expect(t.playerAllIn(3)).toBe(true);              // 600
    expect(t.playerAllIn(0)).toBe(true);              // 100
    expect(t.playerAllIn(1)).toBe(true);              // 100
    expect(t.playerCall(2)).toBe(true);               // 600 (all-in call)
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    const s = stateOf(t, 0);
    expect(s.isChoppedPot).toBe(true);
    // Old: the side-pot winner was listed as a chopper too (P2: 1,000).
    expect(s.chopDetails.slice().sort((a: any, b: any) => a.seatIndex - b.seatIndex)).toEqual([
      { seatIndex: 0, playerName: 'P0', share: 200 },
      { seatIndex: 1, playerName: 'P1', share: 200 },
    ]);
  });
});

/**
 * Gameplay audit 2026-10-21 — cluster S4 (Stud / Razz rules, lowball
 * evaluation, variant labels, progression ranks), on the REAL engine
 * (src/game, src/ai, src/progression) and the real text of src/index.ts
 * (sliced and transpiled by tests/helpers/indexSource).
 *
 *   F31  2-7 / Razz: a paired hand is decided by its PAIR, not its top kicker.
 *   F32  Stud 8 counts the shared 7th-street card (8-handed deck shortage).
 *   F36  Razz: the Ace is LOW for the bring-in and the later-street order.
 *   F37  Stud: two pair showing acts before any one pair.
 *   G167 Third Street: after a short all-in under the completion, the
 *        completion is still legal and is a FULL bet (Raise or All-In).
 *   G168 the bring-in seat decides first: stay or complete.
 *   F40  the in-table variant label names the table's own game.
 *   F42  progression gets a STANDARD hand rank (lowball / Badugi / hi-lo low /
 *        Short Deck / uncontested Stud 8 no longer pay bluff / rare-hand rewards).
 *   F117 bots read their position from the button / big blind.
 *   G180 the hand-history record carries the variant.
 *   G171 (server contract) a Stud hand is never broadcast in PreFlop; the
 *        state always says isStudGame / hasDrawPhase.
 *   F15  Dealer's Choice is refused — covered in tests/r3SfcFixes.test.ts.
 *
 * Every test fails on the pre-fix code (the old behaviour is quoted inline).
 */
import { PokerTable, GamePhase, MAX_SEATS, PlayerAction } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { BadugiTable } from '../src/game/variants/BadugiTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import { Card, cardToString } from '../src/game/Card';
import { HandRank } from '../src/game/HandEvaluator';
import {
  evaluate27LowHand, compare27Hands, evaluateRazzHand, compareRazzHands,
  evaluateShortDeckHand, evaluateBadugiHand, evaluateLowHand,
} from '../src/game/HandEvaluatorExtensions';
import { seatPositions, decideAction, generateRandomProfile, opponentModelKey } from '../src/ai/AIPlayer';
import * as preflopRanges from '../src/ai/preflopRanges';
import { posBucket } from '../src/ai/preflopRanges';
import { progressionHandRank } from '../src/progression/progressionHandRank';
import { ProgressionManager } from '../src/progression/ProgressionManager';
import { denverDateKey } from '../src/economy/denverTime';
import { publicNameOf, PUBLIC_NAME_FALLBACK } from '../src/social/publicIdentity';
import { SRC, slice, fnSrc, load, flush, SEAT_IDENTITY_SRC, INSURANCE_HISTORY_SRC } from './helpers/indexSource';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const key = (c: Card) => c.suit * 16 + c.rank;

const T = 't';
const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: T, tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 10, ...over } as any);
const seatN = (t: PokerTable, n: number, chips = 5000, ai = false) => {
  for (let i = 0; i < n; i++) expect(t.sitDown(i, `P${i}`, chips, ai ? `ai-${i}` : `p${i}`, ai, true)).toBe(true);
};
const tableChips = (t: PokerTable) =>
  t.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (t.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0);

/** Every seat to act calls (or checks) until the street changes. */
function finishStreet(t: PokerTable): void {
  const start = t.currentPhase;
  const hand = t.handNumber;
  for (let g = 0; g < 40 && t.currentPhase === start && t.handNumber === hand && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    expect(a).toBeGreaterThanOrEqual(0);
    const owes = t.currentBetToMatch > t.seats[a].currentBet;
    expect(owes ? t.playerCall(a) : t.playerCheck(a)).toBe(true);
  }
}

/** The next shuffle deals `first` in order (then the rest of the deck). */
function stackDeck(t: PokerTable, first: Card[]): void {
  const deck = (t as any).deck;
  const orig = deck.shuffle.bind(deck);
  deck.shuffle = (h: number) => {
    const c = orig(h);
    const used = new Set(first.map(key));
    deck.cards = [...first, ...(deck.cards as Card[]).filter((x) => !used.has(key(x)))];
    deck.currentIndex = 0;
    deck.shuffle = orig;
    return c;
  };
}

/** Stud deal order for seats 0..n-1: 2 down + 1 up each, then the 4th / 5th / 6th up cards seat by seat. */
function studOrder(per: Array<{ down: string; ups: string }>): Card[] {
  const out: Card[] = [];
  const downs = per.map((p) => cs(p.down));
  const ups = per.map((p) => cs(p.ups));
  per.forEach((_, i) => out.push(downs[i][0], downs[i][1], ups[i][0]));
  for (let street = 1; street < 4; street++) per.forEach((_, i) => { if (ups[i][street]) out.push(ups[i][street]); });
  return out;
}

// ---------------------------------------------------------------- F31 ----

describe('F31 — lowball: a paired hand is decided by its pair, not by its top kicker', () => {
  const b27 = (s: string) => evaluate27LowHand(cs(s));
  const razz = (s: string) => evaluateRazzHand(cs(s));

  it.each([
    ['one pair', '2s 2h Kd Qc Js', '3s 3h 7d 6c 5s'],          // old: K vs 7 -> the threes won
    ['two pair', '3s 3h 2d 2c Ks', '4s 4h 3d 3c 5s'],          // old: K vs 5
    ['two pair, lower top pair', '8s 8h 7d 7c Ks', '9s 9h 2d 2c 3s'],
    ['trips', '2s 2h 2d Kc Qs', '3s 3h 3d 7c 6s'],
    ['full house', '2s 2h 2d Kc Ks', '3s 3h 3d 4c 4s'],
  ])('2-7 %s: %s beats %s', (_n, better, worse) => {
    expect(compare27Hands(b27(better), b27(worse))).toBeLessThan(0);
    expect(compare27Hands(b27(worse), b27(better))).toBeGreaterThan(0);
  });

  it('2-7 unpaired / straight / flush ordering is unchanged (highest card first)', () => {
    expect(compare27Hands(b27('7s 5h 4d 3c 2s'), b27('8s 5h 4d 3c 2s'))).toBeLessThan(0);
    expect(compare27Hands(b27('8s 6h 4d 3c 2s'), b27('8s 7h 4d 3c 2s'))).toBeLessThan(0);
    expect(b27('2s 2h Kd Qc Js')).toMatchObject({ handRank: 1, primaryValue: 2, kickers: [13, 12, 11], handName: 'Pair (bad)' });
    expect(b27('8s 6h 4d 3c 2s')).toMatchObject({ handRank: 0, primaryValue: 8, kickers: [6, 4, 3, 2], handName: 'Eight-low' });
  });

  it('Razz: A-A-2-3-9 beats 2-2-3-4-5 (aces are the lowest pair); best five of seven keeps the lowest pair', () => {
    expect(compareRazzHands(razz('Ah Ad 2c 3h 9s'), razz('2h 2d 3s 4c 5d'))).toBeLessThan(0);   // old: 9 vs 5 -> the deuces
    const a = razz('Ah Ad Ac 2c 3h 9s 9d');
    const b = razz('2h 2d 3s 4c 4h 5d 5c');
    expect(a.handName).toBe('Low: 1-1-2-3-9');
    expect(b.handName).toBe('Low: 2-2-3-4-5');
    expect(compareRazzHands(a, b)).toBeLessThan(0);
    // trips < full house < quads (a full house used to share trips' badness)
    expect(razz('2h 2d 2s 3c 4h').handRank).toBe(3);
    expect(razz('2h 2d 2s 3c 3h').handRank).toBe(4);
    expect(razz('2h 2d 2s 2c 3h').handRank).toBe(5);
    expect(compareRazzHands(razz('Kh Kd Ks Qc Jh'), razz('2h 2d 2s 3c 3h'))).toBeLessThan(0);
    // unpaired lows are unchanged
    expect(compareRazzHands(razz('Ah 2d 3s 4c 5h'), razz('Ah 2d 3s 4c 6h'))).toBeLessThan(0);
  });

  it('engine: Triple Draw 2-7 showdown — the pair of deuces takes the pot (old: the threes)', () => {
    const t = new FiveCardDrawTable(cfg(), true);
    seatN(t, 2, 1000);
    expect(t.startNewHand()).toBe(true);
    finishStreet(t);                                    // the first betting round (both in for 50)
    const before = tableChips(t);
    t.seats[0].holeCards = cs('2s 2h Kd Qc Js');
    t.seats[1].holeCards = cs('3s 3h 7d 6c 5s');
    (t as any).determineWinners();
    expect(t.lastHandResult!.winners.map((w) => w.seatIndex)).toEqual([0]);
    expect(t.seats[0].chipCount).toBe(1050);
    expect(t.seats[1].chipCount).toBe(950);
    expect(tableChips(t)).toBe(before);
  });

  it('engine: Razz showdown — A-A-2-3-9 takes the pot from 2-2-3-4-5 (old: the deuces)', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), true, false);
    seatN(t, 2, 1000);
    expect(t.startNewHand()).toBe(true);
    finishStreet(t);                                    // Third Street: bring-in stays, the other calls
    const before = tableChips(t);
    t.seats[0].holeCards = cs('Ah Ad Ac 2c 3h 9s 9d');
    t.seats[1].holeCards = cs('2h 2d 3s 4c 4h 5d 5c');
    (t as any).determineWinners();
    expect(t.lastHandResult!.winners.map((w) => w.seatIndex)).toEqual([0]);
    expect(t.seats[0].chipCount).toBe(1000 + 30);
    expect(tableChips(t)).toBe(before);
  });
});

// ---------------------------------------------------------------- F32 ----

describe('F32 — Stud 8 counts the shared 7th-street card', () => {
  /** 8 seats called down to 7th street; returns the table with ONE shared community card. */
  function toSeventh(hiLo: boolean): SevenStudTable {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, hiLo);
    seatN(t, 8, 5000);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 5 && t.currentPhase !== GamePhase.SeventhStreet; g++) finishStreet(t);
    expect(t.currentPhase).toBe(GamePhase.SeventhStreet);
    expect(t.communityCards).toHaveLength(1);           // 8 x 6 = 48 dealt: the deck cannot give 8 more
    for (const s of t.seats.filter((x) => x.state === 'occupied')) expect(s.holeCards).toHaveLength(6);
    return t;
  }
  function showdown(t: SevenStudTable, a: string, b: string, shared: string) {
    t.seats[0].holeCards = cs(a);
    t.seats[1].holeCards = cs(b);
    t.communityCards = cs(shared);
    for (let i = 2; i < 8; i++) t.seats[i].folded = true;
    const before = t.seats.map((s) => s.chipCount);
    const total = tableChips(t);
    (t as any).determineWinners();
    expect(tableChips(t)).toBe(total);
    return t.seats.map((s, i) => s.chipCount - before[i]);
  }

  it('a full house made with the shared 8 wins the high (and scoops: no low) — old: two pair nines scooped', () => {
    const t = toSeventh(true);
    const pot = t.seats.reduce((s, x) => s + x.totalInvestedThisHand, 0);
    const won = showdown(t, '2s 2h 9d 9c Ks Qh', '8s 8h 7d 7c Js Th', '8d');
    expect(won[0]).toBe(0);
    expect(won[1]).toBe(pot);
    expect(t.lastHandResult!.communityCards).toEqual(cs('8d'));    // old: []
    expect(t.lastHandResult!.showdownHands.find((h) => h.seatIndex === 1)!.handName).toBe('Full House');
  });

  it('a wheel made with the shared 5 scoops (straight high + A-5 low) — old: two pair kings scooped', () => {
    const t = toSeventh(true);
    const pot = t.seats.reduce((s, x) => s + x.totalInvestedThisHand, 0);
    const won = showdown(t, 'As 2h 3d 4c Ks Qh', 'Kh Kd Qd Qc Js Th', '5d');
    expect(won[0]).toBe(pot);
    expect(won[1]).toBe(0);
    const results = t.lastHandResult!.winners;
    expect(results.map((w) => w.seatIndex)).toEqual([0]);
  });

  it('CONTROL — plain Stud already counted it (base path): the full house wins', () => {
    const t = toSeventh(false);
    const pot = t.seats.reduce((s, x) => s + x.totalInvestedThisHand, 0);
    const won = showdown(t, '2s 2h 9d 9c Ks Qh', '8s 8h 7d 7c Js Th', '8d');
    expect(won[1]).toBe(pot);
  });
});

// ---------------------------------------------------------------- F36 ----

describe('F36 — Razz: the Ace is LOW for the bring-in and the later-street order', () => {
  it('Third Street: an Ace door card never brings it in — the 7 does (old: the Ace posted it); Fourth Street: A-2 acts before 7-5', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), true, false);
    seatN(t, 2, 1000);
    stackDeck(t, studOrder([{ down: 'Kc Qc', ups: 'Ah 2c' }, { down: 'Kd Qd', ups: '7h 5c' }]));
    expect(t.startNewHand()).toBe(true);
    expect(t.getFaceUpCards(0).map(cardToString)).toEqual([cardToString(cs('Ah')[0])]);
    expect(t.seats[1].currentBet).toBe(25);               // the 7 brought it in
    expect(t.seats[0].currentBet).toBe(0);
    expect(t.getStudFirstActor()).toBe(1);
    finishStreet(t);
    expect(t.currentPhase).toBe(GamePhase.FourthStreet);
    expect(t.activeSeatIndex).toBe(0);                    // A-2 is the best Razz board (old: 7-5 acted first)
  });

  it('a King door brings it in against an Ace; the highest SUIT breaks a rank tie', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), true, false);
    seatN(t, 3, 1000);
    stackDeck(t, studOrder([{ down: '2c 3c', ups: 'Ks' }, { down: '2d 3d', ups: 'Ah' }, { down: '4c 4d', ups: 'Kh' }]));
    expect(t.startNewHand()).toBe(true);
    expect(t.seats.map((s) => s.currentBet)).toEqual([25, 0, 0, ...new Array(MAX_SEATS - 3).fill(0)]);   // K spades > K hearts
  });

  it('CONTROL — Seven Card Stud keeps the Ace HIGH: the 2 brings it in, never the Ace', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatN(t, 2, 1000);
    stackDeck(t, studOrder([{ down: 'Kc Qc', ups: 'Ah' }, { down: 'Kd Qd', ups: '2h' }]));
    expect(t.startNewHand()).toBe(true);
    expect(t.seats[1].currentBet).toBe(25);
  });
});

// ---------------------------------------------------------------- F37 ----

describe('F37 — two pair showing acts before any one pair', () => {
  const sc = (t: SevenStudTable, s: string) => (t as any).scoreExposedBoard(cs(s));

  it('board scores: K-K-5-5 > A-A-2-3; K-K-5-5 > K-K-A-2; trips > two pair; quads > trips; the old cases still hold', () => {
    const t = new SevenStudTable(cfg(), false, false);
    expect(sc(t, 'Ks Kh 5d 5c')).toBeGreaterThan(sc(t, 'As Ah 2d 3c'));   // old: A-A-2-3 higher
    expect(sc(t, 'Ks Kh 5d 5c')).toBeGreaterThan(sc(t, 'Ks Kh Ad 2c'));
    expect(sc(t, '3s 3h 2d 2c')).toBeGreaterThan(sc(t, 'As Ah Kd Qc'));
    expect(sc(t, 'Ks Kh 3d 3c')).toBeGreaterThan(sc(t, 'Qs Qh Jd Jc'));   // top pair first
    expect(sc(t, 'Ks Kh 3d 3c')).toBeGreaterThan(sc(t, 'Ks Kh 2d 2c'));   // then the second pair
    expect(sc(t, '2s 2h 2d 3c')).toBeGreaterThan(sc(t, 'As Ah Kd Kc'));
    expect(sc(t, '2s 2h 2d 2c')).toBeGreaterThan(sc(t, 'As Ah Ad Kc'));
    expect(sc(t, '8s 8h')).toBeGreaterThan(sc(t, 'As Kh'));
    expect(sc(t, 'As Kh Qd')).toBeGreaterThan(sc(t, 'As Kh Jd'));
  });

  it('engine, Sixth Street: K-K-5-5 showing acts before A-A-2-3 (old: the aces), and again on Seventh', () => {
    for (const hiLo of [false, true]) {
      const t = new SevenStudTable(cfg({ ante: 5 }), false, hiLo);
      seatN(t, 2, 5000);
      stackDeck(t, studOrder([{ down: '9c 8c', ups: 'As Ah 2c 3d' }, { down: '9d 8d', ups: 'Ks Kh 5c 5d' }]));
      expect(t.startNewHand()).toBe(true);
      expect(t.seats[1].currentBet).toBe(25);             // K door (lower than the Ace) brings it in
      for (let g = 0; g < 3; g++) finishStreet(t);
      expect(t.currentPhase).toBe(GamePhase.SixthStreet);
      expect(t.getFaceUpCards(0).map((c) => c.rank)).toEqual([14, 14, 2, 3]);
      expect(t.getFaceUpCards(1).map((c) => c.rank)).toEqual([13, 13, 5, 5]);
      expect(t.activeSeatIndex).toBe(1);
      finishStreet(t);
      expect(t.currentPhase).toBe(GamePhase.SeventhStreet);
      expect(t.activeSeatIndex).toBe(1);
    }
  });

  it('Razz (lowest acts first): one pair acts before two pair; A-2-3-4 is the best board', () => {
    const t = new SevenStudTable(cfg(), true, false);
    expect(sc(t, 'Ks Kh Qd Jc')).toBeLessThan(sc(t, '2s 2h 3d 3c'));     // old: 2-2-3-3 acted first
    expect(sc(t, 'As 2h 3d 4c')).toBeLessThan(sc(t, '2s 3h 4d 5c'));
    expect(sc(t, 'As Ah Kd Qc')).toBeLessThan(sc(t, '2s 2h 3d 4c'));     // A-A is the lowest pair
  });
});

// ---------------------------------------------------------------- G168 ----

describe('G168 — the bring-in seat decides first: stay or complete', () => {
  for (const [name, razz, hiLo] of [['Stud', false, false], ['Razz', true, false], ['Stud 8', false, true]] as const) {
    it(`${name}: the bring-in is posted, then it is HIS turn; completing makes it a full bet the others must answer`, () => {
      const t = new SevenStudTable(cfg({ ante: 5 }), razz, hiLo);
      seatN(t, 4);
      expect(t.startNewHand()).toBe(true);
      const b = t.seats.findIndex((s) => s.currentBet === 25);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(t.activeSeatIndex).toBe(b);                  // old: the seat on his left
      expect(t.canRaise(b)).toBe(true);
      expect(t.getMinRaise()).toBe(50);
      expect(t.maxRaiseFor(b)).toBe(50);
      expect(t.playerRaise(b, 50)).toBe(true);            // old: refused (not his turn)
      expect(t.currentBetToMatch).toBe(50);
      expect(t.betLevelsThisStreet).toBe(1);
      expect(t.getMinRaise()).toBe(100);
      expect(t.activeSeatIndex).toBe((b + 1) % 4);
      for (const s of t.seats.filter((x) => x.state === 'occupied' && x.seatIndex !== b)) expect(s.hasActedSinceLastFullRaise).toBe(false);
      // 2026-10-24 (Sit & Go fix-all F1) — the seat's ante is in the log first.
      expect(t.actionLog.filter((a) => a.seatIndex === b).map((a) => a.action)).toEqual(['posted ante 5', 'posted bring-in 25', 'raised to 50']);
    });
  }

  it('CONTROL — a short stack all-in on the bring-in has no decision left: the action starts on its left (unchanged)', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatN(t, 3);
    stackDeck(t, studOrder([{ down: 'Kc Qc', ups: '2h' }, { down: 'Kd Qd', ups: '9h' }, { down: 'Ks Qs', ups: 'Th' }]));
    t.seats[0].chipCount = 20;                            // 15 after the ante: all-in on the bring-in
    expect(t.startNewHand()).toBe(true);
    expect(t.seats[0]).toMatchObject({ currentBet: 15, allIn: true });
    expect(t.activeSeatIndex).toBe(1);
  });

  it('a bot bring-in gets a legal decision (never the fold fallback)', () => {
    for (let k = 0; k < 30; k++) {
      const t = new SevenStudTable(cfg({ ante: 5 }), k % 2 === 1, false);
      seatN(t, 4, 5000, true);
      expect(t.startNewHand()).toBe(true);
      const b = t.activeSeatIndex;
      const d = decideAction(t, b, generateRandomProfile('hard'));
      const ok = d.action === PlayerAction.Raise ? t.playerRaise(b, d.raiseAmount)
        : d.action === PlayerAction.AllIn ? t.playerAllIn(b)
        : d.action === PlayerAction.Check ? t.playerCheck(b)
        : d.action === PlayerAction.Call ? (t.playerCall(b) || t.playerCheck(b))
        : t.playerFold(b);
      expect([d.action, ok]).toEqual([d.action, true]);
      expect(t.seats[b].folded).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- G167 ----

describe('G167 — a short all-in under the completion: the completion is still legal and a full bet', () => {
  /** 4 seats at 25/50 ante 5: the bring-in stays, the next seat (40 behind) shoves short. */
  function shortAllIn(razz: boolean, hiLo: boolean) {
    const t = new SevenStudTable(cfg({ ante: 5 }), razz, hiLo);
    seatN(t, 4);
    expect(t.startNewHand()).toBe(true);
    const b = t.activeSeatIndex;
    const s1 = (b + 1) % 4, s2 = (b + 2) % 4, s3 = (b + 3) % 4;
    t.seats[s1].chipCount = 40;
    const chips = tableChips(t);
    expect(t.playerCheck(b)).toBe(true);                  // G168: he stays at the bring-in
    expect(t.playerAllIn(s1)).toBe(true);
    expect(t.seats[s1].allIn).toBe(true);
    expect(t.currentBetToMatch).toBe(40);
    expect(t.lastRaiseAmount).toBe(25);
    return { t, b, s1, s2, s3, chips };
  }

  for (const [name, razz, hiLo] of [['Stud', false, false], ['Razz', true, false], ['Stud 8', false, true]] as const) {
    it(`${name}: Raise completes to 50 (old: refused for 50, 65 and 100 — min-raise 65 above the 50 cap); the bring-in may then re-raise`, () => {
      const w = shortAllIn(razz, hiLo);
      expect(w.t.getMinRaise()).toBe(50);                 // old: 65
      expect(w.t.maxRaiseFor(w.s2)).toBe(50);
      expect(w.t.canRaise(w.s2)).toBe(true);
      expect(w.t.playerRaise(w.s2, 65)).toBe(true);       // any request completes to exactly 50
      expect(w.t.currentBetToMatch).toBe(50);
      expect(w.t.betLevelsThisStreet).toBe(1);
      expect(w.t.lastRaiseAmount).toBe(50);
      expect(w.t.getMinRaise()).toBe(100);
      expect(w.t.playerRaise(w.s3, 75)).toBe(false);      // a half-bet raise is never accepted
      expect(w.t.playerCall(w.s3)).toBe(true);
      expect(w.t.activeSeatIndex).toBe(w.b);
      expect(w.t.seats[w.b].hasActedSinceLastFullRaise).toBe(false);   // reopened to the bring-in
      expect(w.t.playerRaise(w.b, 100)).toBe(true);       // old: refused
      expect(w.t.betLevelsThisStreet).toBe(2);
      expect(tableChips(w.t)).toBe(w.chips);
    });
  }

  it('All-In by a deep stack is the completion itself — a full bet (old: a non-full 50 that reopened nothing, then a 75 raise was accepted)', () => {
    const w = shortAllIn(false, false);
    expect(w.t.playerAllIn(w.s2)).toBe(true);
    expect(w.t.seats[w.s2]).toMatchObject({ currentBet: 50, allIn: false });
    expect(w.t.betLevelsThisStreet).toBe(1);              // old: 0
    expect(w.t.lastRaiseAmount).toBe(50);                 // old: 25
    expect(w.t.getMinRaise()).toBe(100);                  // old: 75
    expect(w.t.playerRaise(w.s3, 75)).toBe(false);        // old: accepted
    expect(tableChips(w.t)).toBe(w.chips);
  });

  it('TDA 41 kept: a seat that already acted and faces ONLY the short all-in can only call (Raise refused, All-In calls)', () => {
    const w = shortAllIn(false, false);
    expect(w.t.playerCall(w.s2)).toBe(true);
    expect(w.t.playerCall(w.s3)).toBe(true);
    expect(w.t.activeSeatIndex).toBe(w.b);
    expect(w.t.canRaise(w.b)).toBe(false);
    expect(w.t.playerRaise(w.b, 50)).toBe(false);
    expect(w.t.lastRaiseAmount).toBe(25);                 // restored after the refusal
    expect(w.t.playerAllIn(w.b)).toBe(true);              // a call of the 15
    expect(w.t.seats[w.b].allIn).toBe(false);
    expect(w.t.currentPhase).toBe(GamePhase.FourthStreet);
    expect(w.t.lastRaiseAmount).toBe(50);                 // Fourth Street's own small bet (untouched)
    expect(tableChips(w.t)).toBe(w.chips);
  });

  it('an all-in for exactly the completion is a full bet too', () => {
    const w = shortAllIn(false, false);
    w.t.seats[w.s2].chipCount = 50;
    const chips = tableChips(w.t);
    expect(w.t.playerAllIn(w.s2)).toBe(true);
    expect(w.t.seats[w.s2]).toMatchObject({ currentBet: 50, allIn: true });
    expect(w.t.betLevelsThisStreet).toBe(1);
    expect(w.t.getMinRaise()).toBe(100);
    expect(tableChips(w.t)).toBe(chips);
  });
});

// ---------------------------------------------------------------- F40 / G171 (index) ----

const STATE_SRC = [
  slice('const drawStartedAtMap = ', '\n}\n'),
  fnSrc('function getVariantInfo('), fnSrc('function getGameStateForPlayer('),
  fnSrc('function tableKindOf('), fnSrc('function bombPotAllowedAt('),
  fnSrc('function straddleAllowedAt('), fnSrc('function isPlainHoldemTable('),
].join('\n');
const STATE_SCOPE = () => ({
  isTournamentTable: () => false, spinGoMultipliers: new Map(), careerTables: new Map(),
  allInOrFoldTables: new Set(), quickTables: new Set(), challengeTables: new Map(),
  clubTableIds: new Set(), privateTableIds: new Set(), PokerTable, OmahaTable,
  ShortDeckTable, FiveCardDrawTable, SevenStudTable, MAX_SEATS, GamePhase, cardToString,
  DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3],
  playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
  dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null,
  tournamentIdOfTable: () => undefined, rebuyAllowedAt: () => true, progressionManager: { getProgress: () => null },
});
function stateOf(table: PokerTable, seat: number): any {
  const { exports } = load(STATE_SRC, STATE_SCOPE(), 'getGameStateForPlayer');
  return exports(table, seat, false);
}

describe('F40 — the in-table label names the table\'s own game; the variant id is unchanged', () => {
  it.each([
    ['Badugi', () => new BadugiTable(cfg()), 'Badugi', 'triple-draw'],                                  // old: '2-7 Triple Draw'
    ['Stud 8', () => new SevenStudTable(cfg({ ante: 5 }), false, true), 'Seven Card Stud Hi-Lo (Stud 8)', 'seven-card-stud'],   // old: 'Seven Card Stud'
    ['5-Card Omaha', () => new OmahaTable(cfg(), false, 5), '5-Card Omaha', 'omaha'],                     // old: 'Pot-Limit Omaha'
    ['6-Card Omaha', () => new OmahaTable(cfg(), false, 6), '6-Card Omaha', 'omaha'],
    ['5-Card Omaha Hi-Lo', () => new OmahaTable(cfg(), true, 5), '5-Card Omaha Hi-Lo', 'omaha-hi-lo'],
    ['Pot-Limit Omaha', () => new OmahaTable(cfg()), 'Pot-Limit Omaha', 'omaha'],
    ['Razz', () => new SevenStudTable(cfg({ ante: 5 }), true, false), 'Razz', 'razz'],
    ['Seven Card Stud', () => new SevenStudTable(cfg({ ante: 5 }), false, false), 'Seven Card Stud', 'seven-card-stud'],
    ['Triple Draw', () => new FiveCardDrawTable(cfg(), true), '2-7 Triple Draw', 'triple-draw'],
    ['Five Card Draw', () => new FiveCardDrawTable(cfg(), false), 'Five Card Draw', 'five-card-draw'],
  ] as Array<[string, () => PokerTable, string, string]>)('%s', (_n, make, name, variant) => {
    const t = make();
    seatN(t, 2);
    expect(t.startNewHand()).toBe(true);
    const st = stateOf(t, 0);
    expect(st.variantName).toBe(name);
    expect(st.variant).toBe(variant);
  });
});

describe('G171 (server contract) — a Stud hand is never broadcast in PreFlop; isStudGame / hasDrawPhase are always sent', () => {
  it('Stud / Razz / Stud 8: every state from the deal on is ThirdStreet or later, isStudGame true, hasDrawPhase false', () => {
    for (const [razz, hiLo] of [[false, false], [true, false], [false, true]]) {
      const t = new SevenStudTable(cfg({ ante: 5 }), razz, hiLo);
      seatN(t, 3);
      for (let h = 0; h < 3; h++) {
        expect(t.startNewHand()).toBe(true);
        const st = stateOf(t, 0);
        expect(st.phase).toBe('ThirdStreet');
        expect(st).toMatchObject({ isStudGame: true, hasDrawPhase: false });
        let g = 0;
        while (t.isHandInProgress() && g++ < 20) t.playerFold(t.activeSeatIndex);
      }
    }
  });

  it('draw games say hasDrawPhase true; Hold\'em / Omaha / Pineapple say both false (the keys are always present)', () => {
    const cases: Array<[PokerTable, boolean, boolean]> = [
      [new FiveCardDrawTable(cfg(), true), false, true], [new BadugiTable(cfg()), false, true],
      [new PokerTable(cfg()), false, false], [new OmahaTable(cfg()), false, false], [new PineappleTable(cfg(), false), false, false],
    ];
    for (const [t, stud, draw] of cases) {
      seatN(t, 2);
      expect(t.startNewHand()).toBe(true);
      const st = stateOf(t, 0);
      expect([('isStudGame' in st), st.isStudGame, ('hasDrawPhase' in st), st.hasDrawPhase]).toEqual([true, stud, true, draw]);
    }
  });
});

// ---------------------------------------------------------------- F42 ----

describe('F42 — progression gets a STANDARD hand rank', () => {
  const R = (handRank: number, potName = 'Main Pot') => ({ handResult: { handRank }, potName });

  it('the normaliser: lowball / Badugi -> none; Short Deck mapped; a hi-lo low half -> none; uncontested -> none; high games unchanged', () => {
    expect(progressionHandRank('razz', [R(0)], true)).toBeUndefined();            // old: 0 = a "bluff"
    expect(progressionHandRank('triple-draw', [R(0)], true)).toBeUndefined();
    expect(progressionHandRank('badugi', [R(4)], true)).toBeUndefined();           // old: 4 = 'Straight'
    expect(progressionHandRank('short-deck', [R(6)], true)).toBe(HandRank.Flush);  // old: 6 = Full House
    expect(progressionHandRank('short-deck', [R(5)], true)).toBe(HandRank.FullHouse);
    expect(progressionHandRank('short-deck', [R(4)], true)).toBe(HandRank.ThreeOfAKind);
    expect(progressionHandRank('short-deck', [R(3)], true)).toBe(HandRank.Straight);
    expect(progressionHandRank('short-deck', [R(9)], true)).toBe(HandRank.RoyalFlush);
    expect(progressionHandRank('omaha-hi-lo', [R(0, 'Main Pot (Low)')], true)).toBeUndefined();
    expect(progressionHandRank('omaha-hi-lo', [R(0, 'Main Pot (Low)'), R(4, 'Main Pot (High)')], true)).toBe(HandRank.Straight);
    expect(progressionHandRank('omaha-5', [R(0, 'Side Pot 1 (Low)')], true)).toBeUndefined();   // a 5-card hi-lo table's low
    expect(progressionHandRank('seven-card-stud-hi-lo', [R(0, 'Main Pot (High)')], false)).toBeUndefined();   // won by fold
    expect(progressionHandRank('holdem', [R(0)], true)).toBe(HandRank.HighCard);   // a real bluff still counts
    expect(progressionHandRank('holdem', [{ potName: 'Main Pot' }], false)).toBeUndefined();
    expect(progressionHandRank('omaha', [R(6), R(6, 'Side Pot 1')], true)).toBe(HandRank.FullHouse);
  });

  it('engine ranks through the normaliser: a Razz wheel, a 2-7 seven-low, a Badugi -> none; a Short Deck flush -> Flush; an O8 low -> none', () => {
    const wheel = evaluateRazzHand(cs('Ah 2d 3s 4c 5h 9d Kc'));
    expect(wheel.handRank).toBe(0);
    expect(progressionHandRank('razz', [{ handResult: wheel, potName: 'Main Pot' }], true)).toBeUndefined();
    const seven = evaluate27LowHand(cs('7h 5d 4s 3c 2h'));
    expect(progressionHandRank('triple-draw', [{ handResult: seven, potName: 'Main Pot' }], true)).toBeUndefined();
    const bd = evaluateBadugiHand(cs('Ah 2d 3s 4c'));
    expect(progressionHandRank('badugi', [{ handResult: bd, potName: 'Main Pot' }], true)).toBeUndefined();
    const sdFlush = evaluateShortDeckHand(cs('Ah 9h 8h 7h Jh 6c Ts'));
    expect(sdFlush.handName).toBe('Flush');
    expect(progressionHandRank('short-deck', [{ handResult: sdFlush, potName: 'Main Pot' }], true)).toBe(HandRank.Flush);
    const low = evaluateLowHand(cs('Ah 2d 3s 4c 6h'))!;
    expect(progressionHandRank('omaha-hi-lo', [{ handResult: low, potName: 'Main Pot (Low)' }], true)).toBeUndefined();
  });

  // The REAL ensureTableProgressListener + handleHandComplete with the REAL ProgressionManager.
  const LISTENER = fnSrc('function ensureTableProgressListener(');
  const HAND_COMPLETE = fnSrc('async function handleHandComplete(');
  const R3_HELPERS = [
    fnSrc('function chipsWonSeatsOfHand('), fnSrc('function dealtInSeatAccount('), fnSrc('function handHistoryViewerOf('), SEAT_IDENTITY_SRC,
    fnSrc('function seatPlayedByAnotherAccount('), INSURANCE_HISTORY_SRC,
  ].join('\n');
  function world(table: PokerTable) {
    const pm = new ProgressionManager();
    pm.hydrateBackoffMs = [0];
    pm.hydrateRetryDelaysMs = [];
    table.sitDown(1, 'Ann', 5000, 'player-A', false, true);
    table.sitDown(2, 'Ben', 5000, 'player-B', false, true);
    const playerSessions = new Map<string, any>([
      ['SA', { socketId: 'SA', tableId: 'T1', seatIndex: 1, playerId: 'player-A', playerName: 'Ann', sittingOut: false }],
      ['SB', { socketId: 'SB', tableId: 'T1', seatIndex: 2, playerId: 'player-B', playerName: 'Ben', sittingOut: false }],
    ]);
    const authSessions = new Map<string, any>([['SA', { userId: 7, username: 'u7' }], ['SB', { userId: 8, username: 'u8' }]]);
    pm.getOrCreateProgress('player-A', 'Ann', 7);
    pm.getOrCreateProgress('player-B', 'Ben', 8);
    const scope: Record<string, unknown> = {
      tableManager: { getTable: () => table }, playerSessions, authSessions, progressionManager: pm,
      tableProgressListeners: new Set<string>(), bombPotActive: new Map(), GamePhase, PlayerAction, HandRank,
      recordOpponentObservation() {}, opponentModelKey, incrementHandsPlayed() {}, settlePredictionsForHand: async () => {}, processPendingSeatRemovals() {},
      scheduleAutoStart() {}, chipVelocity: new Map(), getUserChips: async () => 0, standUpSuspendedSeatsBeforeDeal() {},
      tickReservedSeatHands() {}, settleInsuranceForHand() {}, captureTournamentBustCheck: () => null,
      runTournamentBustCheck() {}, rekickTournamentDealAfterBustCheck() {}, runPendingTournamentBustChecks() {}, broadcastGameState() {},
      tableCountsForChipsWon: () => true, denverDateKey, economyStats: { chipsWonWrites: 0, chipsWonWriteFailures: 0 },
      recordChipWins: async () => {}, recordClubHand() {}, publicNameOf, PUBLIC_NAME_FALLBACK, recordHand: async () => {},
      pushActivity() {}, progressionHandRank,
      mergeUserStats: async () => {}, saveProgress: async () => true,
      tickScratchProgress: async () => ({ awarded: false, chips: 1, stars: 2, scratchCardsAvailable: 0 }),
      sendProgressToPlayer() {}, io: { sockets: { sockets: new Map() }, to: () => ({ emit() {} }), emit() {} },
      multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
    };
    const { exports: m } = load(`${LISTENER}\n${HAND_COMPLETE}\n${R3_HELPERS}`, scope, '{ ensureTableProgressListener, handleHandComplete }');
    return { m, pm, table };
  }
  async function winShowdown(table: PokerTable, handRank: number, potName = 'Main Pot') {
    const w = world(table);
    await flush();
    expect(table.startNewHand()).toBe(true);
    (table as any).wentToShowdown = true;
    await w.m.handleHandComplete('T1', [{ seatIndex: 1, amount: 400, handResult: { handRank }, potName }]);
    await flush();
    return w.pm.getProgress('player-A')!;
  }
  const t1 = (over: Record<string, unknown> = {}) => cfg({ tableId: 'T1', ...over });

  it('a Razz showdown win (badness 0) is no bluff and files no hand rank (old: bluffWins 1, "High Card")', async () => {
    const p = await winShowdown(new SevenStudTable(t1({ ante: 5 }), true, false), 0);
    expect(p.handsWon).toBe(1);
    expect(p.bluffWins).toBe(0);
    expect(p.handsPerRank).toEqual({});
  });

  it('a Short Deck flush (ShortDeckHandRank 6) counts as a Flush, never a full house (old: fullHouseHits 1)', async () => {
    const p = await winShowdown(new ShortDeckTable(t1()), 6);
    expect(p.fullHouseHits || 0).toBe(0);
    expect(p.handsPerRank).toEqual({ Flush: 1 });
  });

  it('an Omaha hi-lo LOW-only winner is no bluff', async () => {
    const p = await winShowdown(new OmahaTable(t1(), true), 0, 'Main Pot (Low)');
    expect(p.bluffWins).toBe(0);
    expect(p.handsWon).toBe(1);
  });

  it('CONTROL — Hold\'em: a high-card showdown win is still a bluff', async () => {
    const p = await winShowdown(new PokerTable(t1()), 0);
    expect(p.bluffWins).toBe(1);
    expect(p.handsPerRank).toEqual({ 'High Card': 1 });
  });

  it('wiring: recordHandWon and the ticker / royal-flush checks read the normalised rank', () => {
    const hc = fnSrc('async function handleHandComplete(');
    expect(hc).toContain('const handRank = progressionHandRank(');
    expect(hc).toContain('progressionManager.recordHandWon(session.playerId, potSize, handRank, wasAllIn);');
    expect(hc).not.toContain('handResultPerSeat');
    expect(SRC).toContain("import { progressionHandRank } from './progression/progressionHandRank';");
  });
});

// ---------------------------------------------------------------- F117 ----

describe('F117 — bots read their position from the button / big blind', () => {
  it('6-handed, every hand: UTG is EP, the button BTN, the blinds SB / BB; postflop the small blind is first and the button last', () => {
    const t = new PokerTable(cfg());
    seatN(t, 6, 5000, true);
    const seen = new Set<number>();
    for (let h = 0; h < 6; h++) {
      expect(t.startNewHand()).toBe(true);
      seen.add(t.dealerButtonSeat);
      const utg = t.activeSeatIndex;
      const bucket = (s: number) => { const p = seatPositions(t, s); return posBucket(p.preflop, p.total); };
      expect(bucket(utg)).toBe('EP');
      expect(bucket(t.dealerButtonSeat)).toBe('BTN');
      expect(bucket(t.smallBlindSeat)).toBe('SB');
      expect(bucket(t.previousBigBlindSeat)).toBe('BB');
      expect(seatPositions(t, t.smallBlindSeat).postflop).toBe(0);
      expect(seatPositions(t, t.dealerButtonSeat).postflop).toBe(5);
      expect(seatPositions(t, utg).preflop).toBe(0);
      let g = 0;
      while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
    }
    expect(seen.size).toBe(6);                            // the button really went round
  });

  it('heads-up: the button (small blind) is SB pre-flop and last post-flop; the big blind is BB and first post-flop', () => {
    const t = new PokerTable(cfg());
    seatN(t, 2, 5000, true);
    for (let h = 0; h < 2; h++) {
      expect(t.startNewHand()).toBe(true);
      const btn = t.dealerButtonSeat, bb = t.previousBigBlindSeat;
      expect(posBucket(seatPositions(t, btn).preflop, 2)).toBe('SB');
      expect(posBucket(seatPositions(t, bb).preflop, 2)).toBe('BB');
      expect(seatPositions(t, bb).postflop).toBe(0);
      expect(seatPositions(t, btn).postflop).toBe(1);
      let g = 0;
      while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
    }
  });

  it('a sitting-out seat is not a position (only seats dealt in count)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4, 5000, true);
    t.setSittingOutSeats([3]);
    expect(t.startNewHand()).toBe(true);
    expect(seatPositions(t, t.activeSeatIndex)).toMatchObject({ preflop: 0, total: 3 });
  });

  it('decideAction hands posBucket the UTG index 0 on every hand (old: the seat number)', () => {
    const spy = jest.spyOn(preflopRanges, 'posBucket');
    try {
      const t = new PokerTable(cfg());
      seatN(t, 6, 5000, true);
      for (let h = 0; h < 6; h++) {
        expect(t.startNewHand()).toBe(true);
        spy.mockClear();
        decideAction(t, t.activeSeatIndex, generateRandomProfile('hard'));
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0]).toEqual([0, 6]);
        let g = 0;
        while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
      }
    } finally {
      spy.mockRestore();
    }
  }, 60_000);   // the first decideAction builds the pre-flop percentile table (~10s)

  it('Stud (no button): counted from the street\'s first actor — the bring-in is 0 on Third Street', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatN(t, 4, 5000, true);
    expect(t.startNewHand()).toBe(true);
    const b = t.activeSeatIndex;
    expect(seatPositions(t, b)).toEqual({ preflop: 0, postflop: 0, total: 4 });
    expect(seatPositions(t, (b + 3) % 4).preflop).toBe(3);
  });
});

// ---------------------------------------------------------------- G180 ----

describe('G180 — the hand-history record carries the variant', () => {
  it.each([
    ['holdem', () => new PokerTable(cfg())],
    ['omaha', () => new OmahaTable(cfg())],
    ['omaha-hi-lo', () => new OmahaTable(cfg(), true)],
    ['omaha-5', () => new OmahaTable(cfg(), false, 5)],
    ['omaha-6', () => new OmahaTable(cfg(), true, 6)],
    ['short-deck', () => new ShortDeckTable(cfg())],
    ['pineapple', () => new PineappleTable(cfg(), false)],
    ['crazy-pineapple', () => new PineappleTable(cfg(), true)],
    ['triple-draw', () => new FiveCardDrawTable(cfg(), true)],
    ['five-card-draw', () => new FiveCardDrawTable(cfg(), false)],
    ['badugi', () => new BadugiTable(cfg())],
    ['seven-stud', () => new SevenStudTable(cfg({ ante: 5 }), false, false)],
    ['razz', () => new SevenStudTable(cfg({ ante: 5 }), true, false)],
  ] as Array<[string, () => PokerTable]>)('%s', (variant, make) => {
    const t = make();
    seatN(t, 3);
    const records: any[] = [];
    t.on('handHistory', (h: any) => records.push(h));
    expect(t.startNewHand()).toBe(true);
    let g = 0;
    while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
    expect(records).toHaveLength(1);
    expect(records[0].variant).toBe(variant);             // old: undefined
  });

  it('the handHistory listener spreads the record into every copy it emits and stores', () => {
    const listener = fnSrc('function ensureTableProgressListener(');
    expect(listener).toContain('const serializedHistory = {\n      ...history,');
    expect(listener).toContain('const forViewer: Record<string, unknown> = { ...serializedHistory, tableId };');
  });
});

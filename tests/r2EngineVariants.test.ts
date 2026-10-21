/**
 * .online R2 (2026-10-11) — S2 engine lane, on the REAL engine (src/game):
 *   GAME-10  a seat taken mid-hand is not in that hand (Hold'em / Stud / Draw)
 *   GAME-6   a draw only in a draw round, only by a dealt-in seat, whole-number indices
 *   GAME-9   fixed limit is capped at a bet and three raises per round
 *   GAME-14  Omaha Hi-Lo zero-survivor all-fold refunds every stake
 *   GAME-12  the engine's bomb pot: equal ante, flop off the table's OWN deck
 *   C11      canStraddle (isFirstActor)
 *   GAME P3  odd chip to the first seat left of the button; Short Deck commits
 *            its deck, rabbit-hunts its own deck and never deals a sitting-out
 *            seat; Stud never deals a sitting-out seat and its bring-in is
 *            mandatory; 'handResult' entries carry playerId / isAI / chipsWon
 *   GAME-15  awardIfUncontested + completeDrawRoundIfDone (used by the seat teardown)
 * Each fix has a CONTROL where the pre-R2 behaviour can be reproduced on the
 * same engine (e.g. un-folding the joiner shows the second lock).
 */
import { PokerTable, GamePhase, FIXED_LIMIT_MAX_BET_LEVELS, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { SidePotManager } from '../src/game/SidePotManager';
import { HandRank } from '../src/game/HandEvaluator';

const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: 't', tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, ...over } as any);
/** Chips on the table: every stack plus what is in the pot of a hand in progress. */
const tableChips = (t: PokerTable) =>
  t.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (t.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0);
const seatN = (t: PokerTable, n: number, chips = 5000, ai = false) => {
  for (let i = 0; i < n; i++) expect(t.sitDown(i, `P${i}`, chips, `p${i}`, ai)).toBe(true);
};

describe('GAME-10 — a seat taken mid-hand is NOT in that hand', () => {
  it("Hold'em: the joiner sits folded with no cards; an uncontested win reveals nothing; he is dealt in next hand", () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    let hist: any = null;
    t.on('handHistory', (h: any) => { hist = h; });
    expect(t.startNewHand()).toBe(true);
    expect(t.sitDown(5, 'Joiner', 5000, 'j')).toBe(true);
    expect(t.seats[5].folded).toBe(true);
    expect(t.seats[5].holeCards).toHaveLength(0);
    const raiser = t.activeSeatIndex;
    expect(t.playerRaise(raiser, 150)).toBe(true);
    let g = 0;
    while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.wentToShowdown).toBe(false);
    expect(t.lastHandResult!.winners.map((w) => w.seatIndex)).toEqual([raiser]);
    expect(t.lastHandResult!.showdownHands).toHaveLength(0);
    expect(hist.players.filter((p: any) => p.holeCards)).toHaveLength(0);
    // Next hand: he plays.
    expect(t.startNewHand()).toBe(true);
    expect(t.seats[5].folded).toBe(false);
    expect(t.seats[5].holeCards).toHaveLength(2);
  });

  it('second lock (CONTROL — the old un-folded cardless joiner): determineWinners still treats a cardless seat as out — no showdown, nothing revealed', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    let hist: any = null;
    t.on('handHistory', (h: any) => { hist = h; });
    t.startNewHand();
    t.sitDown(5, 'Joiner', 5000, 'j');
    t.seats[5].folded = false;                                // the pre-R2 sitDown
    const raiser = t.activeSeatIndex;
    t.playerRaise(raiser, 150);
    let g = 0;
    while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
    expect(t.wentToShowdown).toBe(false);
    expect(hist.players.filter((p: any) => p.holeCards)).toHaveLength(0);
    expect(t.lastHandResult!.winners.map((w) => w.seatIndex)).toEqual([raiser]);
  });

  it('a seat taken BETWEEN hands is dealt in normally (never pre-folded)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 2);
    expect(t.sitDown(4, 'Late', 5000, 'l')).toBe(true);
    expect(t.seats[4].folded).toBe(false);
    t.startNewHand();
    expect(t.seats[4].holeCards).toHaveLength(2);
  });

  it('Seven Card Stud / Razz: the mid-hand joiner is never dealt a later street, never given the action, never paid (60 hands each)', () => {
    for (const razz of [false, true]) {
      let dealt = 0, acted = 0, won = 0;
      for (let k = 0; k < 60; k++) {
        const t = new SevenStudTable(cfg({ ante: 5 }), razz, false);
        seatN(t, 3);
        t.startNewHand();
        t.sitDown(3, 'Joiner', 5000, 'j');
        const start = t.seats[3].chipCount;
        let g = 0;
        while (t.isHandInProgress() && g++ < 300) {
          const a = t.activeSeatIndex;
          if (a < 0) break;
          if (a === 3) acted++;
          if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
        }
        if (t.seats[3].holeCards.length > 0) dealt++;
        if (t.seats[3].chipCount > start) won++;
      }
      expect({ razz, dealt, acted, won }).toEqual({ razz, dealt: 0, acted: 0, won: 0 });
    }
  });

  it('Draw: a draw round never waits for a mid-hand joiner — the two dealt-in players draw and the round moves on', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    t.sitDown(0, 'B0', 5000, 'b0', true);
    t.sitDown(1, 'B1', 5000, 'b1', true);
    t.startNewHand();
    t.sitDown(3, 'Joiner', 5000, 'j');
    let g = 0;
    while (t.currentPhase === GamePhase.PreFlop && g++ < 10) {
      const a = t.activeSeatIndex;
      if (!(t.playerCheck(a) || t.playerCall(a))) break;
    }
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(t.playerDraw(0, [])).toBe(true);
    expect(t.playerDraw(1, [])).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
    expect(t.playerDraw(3, [])).toBe(false);                  // he holds no cards
  });
});

describe('GAME-6 — playerDraw only in a draw round, only by a dealt-in seat', () => {
  const toDraw1 = (t: FiveCardDrawTable) => {
    let g = 0;
    while (t.currentPhase === GamePhase.PreFlop && g++ < 10) {
      const a = t.activeSeatIndex;
      if (!(t.playerCheck(a) || t.playerCall(a))) break;
    }
  };

  it('refused during a BETTING round (the cheat: swap cards before the draw); allowed once per draw round', () => {
    for (const triple of [false, true]) {
      const t = new FiveCardDrawTable(cfg(), triple);
      seatN(t, 2);
      t.startNewHand();
      const before = JSON.stringify(t.seats[0].holeCards);
      expect(t.playerDraw(0, [0, 1, 2, 3, 4])).toBe(false);
      expect(JSON.stringify(t.seats[0].holeCards)).toBe(before);
      toDraw1(t);
      expect(t.currentPhase).toBe(GamePhase.Draw1);
      expect(t.playerDraw(0, [0, 1])).toBe(true);
      expect(t.playerDraw(0, [0])).toBe(false);               // already drew this round
    }
  });

  it('refuses non-integer / out-of-range / non-array discards', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    seatN(t, 2);
    t.startNewHand();
    toDraw1(t);
    expect(t.playerDraw(0, [0.5] as any)).toBe(false);
    expect(t.playerDraw(0, ['1'] as any)).toBe(false);
    expect(t.playerDraw(0, '01' as any)).toBe(false);
    expect(t.playerDraw(0, [5])).toBe(false);
    expect(t.playerDraw(0, [-1])).toBe(false);
    expect(t.playerDraw(0, [1, 1])).toBe(false);
    expect(t.playerDraw(0, [0, 4])).toBe(true);
    expect(t.seats[0].holeCards).toHaveLength(5);
  });

  it('completeDrawRoundIfDone: a player folded out of turn during a draw round no longer leaves the round waiting for him', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    seatN(t, 3);
    t.startNewHand();
    toDraw1(t);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(t.playerDraw(0, [])).toBe(true);
    expect(t.playerDraw(1, [])).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Draw1);             // waiting for seat 2
    expect(t.forceFoldSeat(2)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Draw1);             // CONTROL: the fold alone advances nothing
    expect(t.completeDrawRoundIfDone()).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
  });
});

describe('GAME-9 — fixed limit: a bet and three raises per betting round', () => {
  it(`2-7 Triple Draw pre-flop: the big blind + 3 raises = ${FIXED_LIMIT_MAX_BET_LEVELS} levels, then call or fold only (an all-in is a call)`, () => {
    const t = new FiveCardDrawTable(cfg(), true);
    seatN(t, 5);
    t.startNewHand();
    expect(t.betLevelsThisStreet).toBe(1);
    for (let r = 0; r < 3; r++) {
      const a = t.activeSeatIndex;
      expect(t.playerRaise(a, t.getMinRaise())).toBe(true);
    }
    expect(t.betLevelsThisStreet).toBe(FIXED_LIMIT_MAX_BET_LEVELS);
    expect(t.isRaiseCapped()).toBe(true);
    const a = t.activeSeatIndex;
    const toMatch = t.currentBetToMatch;
    expect(t.playerRaise(a, toMatch + 50)).toBe(false);
    expect(t.playerAllIn(a)).toBe(true);                     // capped: becomes a call
    expect(t.seats[a].allIn).toBe(false);
    expect(t.seats[a].currentBet).toBe(toMatch);
    expect(t.currentBetToMatch).toBe(toMatch);
  });

  it('Seven Card Stud Third Street: the completion is the bet, then 3 raises — capped; the bring-in is not a level', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatN(t, 6);
    t.startNewHand();
    expect(t.betLevelsThisStreet).toBe(0);                   // the bring-in posted, not a bet
    for (let r = 0; r < 4; r++) expect(t.playerRaise(t.activeSeatIndex, 10_000)).toBe(true);
    expect(t.betLevelsThisStreet).toBe(4);
    expect(t.currentBetToMatch).toBe(50 + 3 * 50);           // completion 50, then +50 each (small bet)
    expect(t.playerRaise(t.activeSeatIndex, 10_000)).toBe(false);
  });

  it("CONTROL — no-limit Hold'em is never capped by the engine", () => {
    const t = new PokerTable(cfg());
    seatN(t, 6, 1_000_000);
    t.startNewHand();
    for (let r = 0; r < 8; r++) expect(t.playerRaise(t.activeSeatIndex, t.getMinRaise())).toBe(true);
    expect(t.isRaiseCapped()).toBe(false);
    expect(t.raisesThisStreet).toBe(8);
  });

  it('counters reset every street', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    t.startNewHand();
    t.playerRaise(t.activeSeatIndex, 150);
    expect(t.raisesThisStreet).toBe(1);
    let g = 0;
    while (t.currentPhase === GamePhase.PreFlop && g++ < 10) t.playerCall(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.raisesThisStreet).toBe(0);
    expect(t.betLevelsThisStreet).toBe(0);
  });
});

describe('Stud bring-in is mandatory (GAME P3)', () => {
  // 2026-10-21 (gameplay G168) — the bring-in is still POSTED for him, but the
  // bring-in seat then decides first: stay (check) or complete. It used to be
  // marked as acted with the action handed to its left.
  it('the low door card POSTS the bring-in, then decides first (stay); nobody after him can check it; a completion is exactly the small bet', () => {
    for (let k = 0; k < 20; k++) {
      const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
      seatN(t, 4);
      expect(t.startNewHand()).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.ThirdStreet);
      const bringIn = t.seats.findIndex((s) => s.currentBet === 25);
      expect(bringIn).toBeGreaterThanOrEqual(0);
      expect(t.seats[bringIn].totalInvestedThisHand).toBe(5 + 25);
      expect(t.currentBetToMatch).toBe(25);
      expect(t.activeSeatIndex).toBe(bringIn);               // G168: his decision first
      expect(t.getMinRaise()).toBe(50);                      // ... the completion
      expect(t.playerCheck(bringIn)).toBe(true);             // he stays at the bring-in
      const a = t.activeSeatIndex;
      expect(a).not.toBe(bringIn);
      expect(t.playerCheck(a)).toBe(false);                   // 25 to call
      expect(t.getMinRaise()).toBe(50);
      expect(t.playerRaise(a, 400)).toBe(true);              // any bigger request completes
      expect(t.currentBetToMatch).toBe(50);
      expect(t.getMinRaise()).toBe(100);                     // next raise: a full small bet
    }
  });

  it('when he stays and everyone just calls the bring-in, the round ends without a second option for the bring-in seat', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatN(t, 3);
    t.startNewHand();
    const bringIn = t.activeSeatIndex;
    expect(t.seats[bringIn].currentBet).toBe(25);
    expect(t.playerCheck(bringIn)).toBe(true);               // stays
    let calls = 0;
    while (t.currentPhase === GamePhase.ThirdStreet && calls < 10) { expect(t.playerCall(t.activeSeatIndex)).toBe(true); calls++; }
    expect(calls).toBe(2);                                    // the two other seats call; no second option for the bring-in
    expect(t.currentPhase).toBe(GamePhase.FourthStreet);
  });

  it('Razz: the HIGHEST door card brings it in (the Ace counts LOW — F36)', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), true, false);
    seatN(t, 4);
    t.startNewHand();
    const bringIn = t.seats.findIndex((s) => s.currentBet === 25);
    const door = (i: number) => { const r = t.getFaceUpCards(i)[0].rank; return r === 14 ? 1 : r; };
    for (let i = 0; i < 4; i++) expect(door(bringIn)).toBeGreaterThanOrEqual(door(i));
  });

  it('a SITTING-OUT seat is never dealt Stud cards (it used to be — the base deal skips it)', () => {
    const t = new SevenStudTable(cfg({ ante: 5 }), false, false);
    seatN(t, 4);
    t.setSittingOutSeats([2]);
    t.startNewHand();
    expect(t.seats[2].holeCards).toHaveLength(0);
    expect(t.seats[2].totalInvestedThisHand).toBe(0);
    for (const i of [0, 1, 3]) expect(t.seats[i].holeCards).toHaveLength(3);
  });
});

describe('GAME-14 — Omaha Hi-Lo zero-survivor all-fold refunds every stake', () => {
  it.each([
    ["Hold'em (base — control)", () => new PokerTable(cfg({ smallBlind: 50, bigBlind: 100 }))],
    ['Omaha Hi-Lo', () => new OmahaTable(cfg({ smallBlind: 50, bigBlind: 100 }), true, 4)],
  ])('%s: the blind posters leave (force-folded), the last live seat folds — not one chip destroyed', (_name, mk) => {
    const t = (mk as () => PokerTable)();
    seatN(t, 3);
    const total0 = tableChips(t);
    t.startNewHand();
    const active = t.activeSeatIndex;
    for (let i = 0; i < 3; i++) if (i !== active) t.forceFoldSeat(i);
    t.playerFold(active);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(tableChips(t)).toBe(total0);
  });
});

describe('GAME-12 — PokerTable.applyBombPot: an equal ante, the flop off the table\'s OWN deck', () => {
  it('Omaha: every dealt-in seat puts exactly the ante in (blinds returned), flop dealt, a real actor, chips conserved', () => {
    const t = new OmahaTable(cfg({ smallBlind: 50, bigBlind: 100 }), false, 4);
    seatN(t, 4);
    const total0 = tableChips(t);
    t.startNewHand();
    expect(t.applyBombPot(200)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.communityCards).toHaveLength(3);
    for (let i = 0; i < 4; i++) expect(t.seats[i].totalInvestedThisHand).toBe(200);
    expect(t.currentBetToMatch).toBe(0);
    expect(t.activeSeatIndex).toBeGreaterThanOrEqual(0);
    expect(t.seats[t.activeSeatIndex].allIn).toBe(false);
    const all = [...t.communityCards, ...t.seats.flatMap((s) => s.holeCards)].map((c) => `${c.rank}.${c.suit}`);
    expect(new Set(all).size).toBe(all.length);              // no card dealt twice
    expect(tableChips(t)).toBe(total0);
  });

  it('Short Deck (engine level): the flop comes from the 36-card deck — no 2-5 (the old code flopped base-deck cards)', () => {
    for (let k = 0; k < 30; k++) {
      const t = new ShortDeckTable(cfg({ smallBlind: 50, bigBlind: 100 }));
      seatN(t, 4);
      t.startNewHand();
      expect(t.applyBombPot(200)).toBe(true);
      for (const c of t.communityCards) expect(c.rank).toBeGreaterThanOrEqual(6);
    }
  });

  it('everyone all-in on the ante: the board runs out and the hand completes; chips conserved', () => {
    const t = new PokerTable(cfg({ smallBlind: 50, bigBlind: 100, minBuyIn: 100 }));
    seatN(t, 3, 200);
    const total0 = tableChips(t);
    t.startNewHand();
    expect(t.applyBombPot(200)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(tableChips(t)).toBe(total0);
  });

  it('refused once anyone has acted (nothing changes)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    t.startNewHand();
    t.playerCall(t.activeSeatIndex);
    const snapshot = JSON.stringify(t.seats.map((s) => [s.chipCount, s.totalInvestedThisHand]));
    expect(t.applyBombPot(100)).toBe(false);
    expect(JSON.stringify(t.seats.map((s) => [s.chipCount, s.totalInvestedThisHand]))).toBe(snapshot);
  });
});

describe('C11 — canStraddle (isFirstActor)', () => {
  it('UTG, pre-flop, nobody acted, 3+ dealt in: true; after an action / heads-up / unaffordable: false', () => {
    const t = new PokerTable(cfg());
    seatN(t, 4);
    t.startNewHand();
    const utg = t.activeSeatIndex;
    expect(t.canStraddle(utg)).toBe(true);
    for (let i = 0; i < 4; i++) if (i !== utg) expect(t.canStraddle(i)).toBe(false);
    t.playerCall(utg);
    expect(t.canStraddle(t.activeSeatIndex)).toBe(false);

    const hu = new PokerTable(cfg());
    seatN(hu, 2);
    hu.startNewHand();
    expect(hu.canStraddle(hu.activeSeatIndex)).toBe(false);

    const short = new PokerTable(cfg({ minBuyIn: 50 }));
    seatN(short, 3, 5000);
    short.startNewHand();
    short.seats[short.activeSeatIndex].chipCount = 100;     // 2 BB would put him all-in
    expect(short.canStraddle(short.activeSeatIndex)).toBe(false);
  });
});

describe('GAME P3 — the odd chip goes to the first winner LEFT of the button', () => {
  it('orderClockwiseFromDealer starts left of the button; the button is last', () => {
    expect(SidePotManager.orderClockwiseFromDealer([3, 4, 6], 3)).toEqual([4, 6, 3]);
    expect(SidePotManager.orderClockwiseFromDealer([0, 8], 8)).toEqual([0, 8]);
  });

  it('a split pot of 101 between the button and the seat left of it: the left seat gets 51, the button 50', () => {
    const spm = new SidePotManager();
    const tie = { handRank: HandRank.Straight, primaryValue: 10, kickers: [], bestFiveCards: [], handName: 'Straight' } as any;
    const seats = [
      { seatIndex: 2, chipCount: 0, totalInvestedThisHand: 51, folded: false, allIn: false, holeCards: [{ rank: 2, suit: 0 }] as any, state: 'occupied' as const },
      { seatIndex: 3, chipCount: 0, totalInvestedThisHand: 50, folded: false, allIn: false, holeCards: [{ rank: 3, suit: 0 }] as any, state: 'occupied' as const },
    ];
    // Equal investments are what a real tie pot holds; make it 101 with a folded seat's dead chip.
    seats[0].totalInvestedThisHand = 50;
    const dead = { seatIndex: 7, chipCount: 0, totalInvestedThisHand: 1, folded: true, allIn: false, holeCards: [] as any, state: 'occupied' as const };
    const { winnings } = spm.awardPots([...seats, dead], [], 2, () => tie);
    expect(winnings.get(3)).toBe(51);                        // left of the button (2)
    expect(winnings.get(2)).toBe(50);                        // the button
  });
});

describe('GAME P3 — Short Deck commitment, rabbit hunt and sitting-out deal', () => {
  it('commits the deck hash BEFORE dealing (this override never emitted it)', () => {
    const t = new ShortDeckTable(cfg({ smallBlind: 50, bigBlind: 100 }));
    seatN(t, 3);
    const order: string[] = [];
    t.on('deckCommitment', (c: any) => order.push(`commit:${c.handNumber}:${typeof c.hash}`));
    t.on('cardDealt', () => order.push('card'));
    t.startNewHand();
    expect(order[0]).toBe('commit:1:string');
    expect(order.indexOf('card')).toBeGreaterThan(0);
  });

  it('the rabbit hunt comes off the 36-card deck (same burn rule as the deal) and rewinds it', () => {
    for (let k = 0; k < 20; k++) {
      const t = new ShortDeckTable(cfg({ smallBlind: 50, bigBlind: 100 }));
      seatN(t, 3);
      t.startNewHand();
      let g = 0;
      while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
      expect(t.currentPhase).toBe(GamePhase.HandComplete);
      const cards = (t as any)._shortDeckCards;
      const idx = (t as any)._shortDeckIndex;
      const board = t.computeRabbitBoard();
      expect(board).toHaveLength(5);
      expect(board).toEqual([cards[idx + 1], cards[idx + 2], cards[idx + 3], cards[idx + 5], cards[idx + 7]]);
      for (const c of board) expect(c.rank).toBeGreaterThanOrEqual(6);
      expect((t as any)._shortDeckIndex).toBe(idx);            // non-mutating
    }
  });

  it('a SITTING-OUT seat is not dealt (the override skipped the base guard)', () => {
    const t = new ShortDeckTable(cfg({ smallBlind: 50, bigBlind: 100 }));
    seatN(t, 4);
    t.setSittingOutSeats([1]);
    t.startNewHand();
    expect(t.seats[1].holeCards).toHaveLength(0);
    for (const i of [0, 2, 3]) expect(t.seats[i].holeCards).toHaveLength(2);
  });
});

describe('GAME P3 — every handResult entry names its player (anti-cheat chip velocity)', () => {
  it.each([
    ["Hold'em", () => new PokerTable(cfg())],
    ['Omaha Hi-Lo', () => new OmahaTable(cfg(), true, 4)],
    ['Stud Hi-Lo', () => new SevenStudTable(cfg({ ante: 5 }), false, true)],
  ])('%s', (_n, mk) => {
    const t = (mk as () => PokerTable)();
    t.sitDown(0, 'Human', 5000, 'player-h', false);
    t.sitDown(1, 'Bot', 5000, 'ai-1', true);
    let results: any[] = [];
    t.on('handResult', (d: any) => { results = d.results; });
    t.startNewHand();
    let g = 0;
    while (t.isHandInProgress() && g++ < 10) t.playerFold(t.activeSeatIndex);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.playerId).toBe(t.seats[r.seatIndex].playerId);
      expect(r.isAI).toBe(t.seats[r.seatIndex].isAI);
      expect(r.chipsWon).toBe(r.amount);
    }
  });
});

describe('GAME-15 — awardIfUncontested (after an out-of-turn fold)', () => {
  it('two leavers folded out of turn: the last player is paid at once, without having to act (or call the leaver\'s bet)', () => {
    const t = new PokerTable(cfg());
    seatN(t, 3);
    const total0 = tableChips(t);
    t.startNewHand();
    const a = t.activeSeatIndex;
    expect(t.playerRaise(a, 300)).toBe(true);                 // a raises, then leaves out of turn
    const others = [0, 1, 2].filter((i) => i !== a);
    const actor = t.activeSeatIndex;
    const third = others.find((i) => i !== actor)!;
    expect(t.awardIfUncontested()).toBe(false);               // 3 still in: nothing
    t.forceFoldSeat(a);
    t.forceFoldSeat(third);
    expect(t.isHandInProgress()).toBe(true);                  // CONTROL: forceFoldSeat alone ends nothing
    expect(t.awardIfUncontested()).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.lastHandResult!.winners.map((w) => w.seatIndex)).toEqual([actor]);
    expect(tableChips(t)).toBe(total0);
  });

  it('MAX_SEATS sanity', () => { expect(MAX_SEATS).toBe(9); });
});

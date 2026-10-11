/**
 * R1 (2026-10-11) — APPUI-2 (P0 hole-card leak) + TABLEUI-6: a hand's record
 * never shows cards — or their strength — that were not tabled.
 *
 *  - Omaha Hi-Lo built its own history and revealed EVERY non-folded seat: the
 *    UNCONTESTED winner's four hole cards went to the whole table and into
 *    every player's stored hand history (wentToShowdown was never set).
 *  - The base history computed `handName` for every non-folded seat, so the
 *    replay of an uncontested pot named the winner's hand next to hidden cards
 *    (888 / 8,463 stored records).
 *  - Stud Hi-Lo put an uncontested winner's cards (down cards included) and his
 *    hand's name into the hand result every player's state carries.
 * Rule everywhere: cards + hand name only for a non-folded seat at a CONTESTED
 * showdown (>= 2 tabled); masked cards = null hand name.
 */
import { PokerTable, GamePhase, HandHistoryRecord } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';

const cfg = (id: string) => ({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, ante: 2, minBuyIn: 400 } as any);

function seat3(t: PokerTable) {
  for (let i = 0; i < 3; i++) expect(t.sitDown(i, `P${i}`, 2000, `p${i}`, false)).toBe(true);
  const records: HandHistoryRecord[] = [];
  t.on('handHistory', (h: HandHistoryRecord) => records.push(h));
  return records;
}

/** Everyone but the last live seat folds (checks when a fold is refused). */
function foldToOne(t: PokerTable) {
  for (let g = 0; g < 50 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!t.playerFold(a)) t.playerCheck(a);
  }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

/** Call / check down to showdown. */
function checkDown(t: PokerTable) {
  for (let g = 0; g < 200 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    const s = t.seats[a];
    if (t.currentBetToMatch > s.currentBet) expect(t.playerCall(a)).toBe(true);
    else expect(t.playerCheck(a)).toBe(true);
  }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}

const winnerRow = (h: HandHistoryRecord) => h.players.find((p) => !p.folded)!;

describe('uncontested pots reveal nothing — no cards, no hand name', () => {
  it("Hold'em, won on the flop by a bet nobody calls: holeCards null AND handName null (TABLEUI-6)", () => {
    const t = new PokerTable(cfg('H1'));
    const records = seat3(t);
    expect(t.startNewHand()).toBe(true);
    // Limp / check to the flop …
    for (let g = 0; g < 20 && t.currentPhase === GamePhase.PreFlop; g++) {
      const a = t.activeSeatIndex;
      if (t.currentBetToMatch > t.seats[a].currentBet) expect(t.playerCall(a)).toBe(true);
      else expect(t.playerCheck(a)).toBe(true);
    }
    expect(t.currentPhase).toBe(GamePhase.Flop);
    // … the first actor bets, everyone else folds: 5 cards known to the engine, nothing tabled.
    expect(t.playerRaise(t.activeSeatIndex, 40)).toBe(true);
    foldToOne(t);
    expect(t.wentToShowdown).toBe(false);
    const w = winnerRow(records[0]);
    expect(w.holeCards).toBeNull();
    expect(w.handName).toBeNull();                          // pre-R1: e.g. "One Pair" next to hidden cards
    expect(records[0].players.every((p) => p.holeCards === null && p.handName === null)).toBe(true);
    expect(records[0].winners[0].handName).toBe('Won by fold');
  });

  it('Omaha Hi-Lo: the uncontested winner\'s four hole cards are NOT in the record (APPUI-2)', () => {
    const t = new OmahaTable(cfg('O1'), true, 4);
    const records = seat3(t);
    expect(t.startNewHand()).toBe(true);
    const secret = JSON.stringify(t.seats.map((s) => s.holeCards));
    foldToOne(t);
    expect(t.wentToShowdown).toBe(false);
    const w = winnerRow(records[0]);
    expect(w.holeCards).toBeNull();
    expect(w.handName).toBeNull();
    expect(records[0].players.every((p) => p.holeCards === null && p.handName === null)).toBe(true);
    expect(JSON.stringify(records[0])).not.toContain(JSON.stringify(t.seats[records[0].winners[0].seatIndex].holeCards));
    expect(secret.length).toBeGreaterThan(10);
  });

  it('Stud Hi-Lo: the uncontested winner\'s cards and hand name are NOT in the hand result ("Won by fold")', () => {
    const t = new SevenStudTable(cfg('S1'), false, true);
    const records = seat3(t);
    let potNames: string[] = [];
    t.once('handResult', (d: any) => { potNames = d.results.map((r: any) => r.potName); });
    expect(t.startNewHand()).toBe(true);
    foldToOne(t);
    expect(t.wentToShowdown).toBe(false);
    expect(potNames[0]).toBe('Main Pot (High)');            // still the hi-lo override's own award
    expect(t.lastHandResult!.showdownHands).toEqual([]);
    expect(t.lastHandResult!.winners.map((w) => [w.handName, w.bestFiveCards])).toEqual([['Won by fold', []]]);
    expect(records).toEqual([]);                             // Stud hi-lo records no history (unchanged)
  });
});

describe('contested showdowns still reveal the tabled hands (cards + hand name)', () => {
  it("Hold'em", () => {
    const t = new PokerTable(cfg('H2'));
    const records = seat3(t);
    t.startNewHand();
    checkDown(t);
    expect(t.wentToShowdown).toBe(true);
    for (const p of records[0].players) {
      expect(p.holeCards).toHaveLength(2);
      expect(typeof p.handName).toBe('string');
    }
  });

  it('Omaha Hi-Lo', () => {
    const t = new OmahaTable(cfg('O2'), true, 4);
    const records = seat3(t);
    t.startNewHand();
    checkDown(t);
    expect(t.wentToShowdown).toBe(true);
    for (const p of records[0].players) {
      expect(p.holeCards).toHaveLength(4);
      expect(typeof p.handName).toBe('string');
    }
  });

  it('Stud Hi-Lo: the showdown hands are in the result and the engine marks the showdown', () => {
    const t = new SevenStudTable(cfg('S2'), false, true);
    seat3(t);
    t.startNewHand();
    checkDown(t);
    expect(t.wentToShowdown).toBe(true);
    expect(t.lastHandResult!.showdownHands.length).toBe(3);
  });

  it('a folded seat at a contested showdown stays hidden', () => {
    const t = new PokerTable(cfg('H3'));
    const records = seat3(t);
    t.startNewHand();
    // The first actor folds, the rest check / call down.
    expect(t.playerFold(t.activeSeatIndex)).toBe(true);
    checkDown(t);
    const folded = records[0].players.filter((p) => p.folded);
    expect(folded).toHaveLength(1);
    expect(folded[0].holeCards).toBeNull();
    expect(folded[0].handName).toBeNull();
  });
});

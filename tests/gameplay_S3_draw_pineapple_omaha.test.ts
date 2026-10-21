/**
 * Gameplay audit 2026-10-21 — cluster S3 (draw games, Pineapple, Omaha hi-lo),
 * on the REAL engine (src/game) and the real text of src/index.ts (sliced and
 * transpiled by tests/helpers/indexSource).
 *
 *   F28  a draw round has no betting: the seat that closed the betting before
 *        it (still activeSeatIndex) could call / raise / all-in / fold there.
 *   F29  that seat sitting out mid-draw folded and froze the draw round.
 *   F26  a draw reshuffle handed the drawer his own discards back and dropped
 *        the rest of the reshuffled stub.
 *   F27  an all-in player could never draw.
 *   F39  Triple Draw / Badugi: Bet2 is a small-bet round (the big bet starts
 *        after the second draw).
 *   F44  a lone player with chips (the others all-in) was handed a pointless
 *        betting turn in every later round.
 *   G169 the draw clock (drawStartedAt / drawTimeout) is sent, and the
 *        stand-pat fires at that start + 30s.
 *   F116 2-7 bots break A-K highs, straights and flushes.
 *   F16  Crazy Pineapple: an all-in before the flop gets a discard window on
 *        the flop; the server's own pick keeps the best hand with the board.
 *   F17  a discard pick never carries into another hand / another player.
 *   F18  a discarded card is never named in the shared hand history.
 *   F34  the state sends isPineapple / pineappleDiscardActive (the picker).
 *   F20  Omaha hi-lo pot lists name their winners (fixed with S2's shared
 *        buildPotBreakdown; the side-pot case is locked here).
 *
 * Every test fails on the pre-fix code (the old behaviour is quoted inline).
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { BadugiTable } from '../src/game/variants/BadugiTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { Card, cardToString } from '../src/game/Card';
import { slice, fnSrc, handlerSrc, load, SEAT_IDENTITY_SRC } from './helpers/indexSource';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const key = (c: Card) => c.suit * 16 + c.rank;
const same = (a: Card[], b: Card[]) => a.map(key).sort((x, y) => x - y).join() === b.map(key).sort((x, y) => x - y).join();

const T = 't';
const cfg = (over: Record<string, unknown> = {}) =>
  ({ tableId: T, tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 100, ...over } as any);
const seatAt = (t: PokerTable, stacks: Record<number, number>, ai = false) => {
  for (const [i, chips] of Object.entries(stacks)) expect(t.sitDown(Number(i), `P${i}`, chips, ai ? `ai-${i}` : `p${i}`, ai, true)).toBe(true);
};
const tableChips = (t: PokerTable) =>
  t.seats.reduce((s, x) => s + (x.state === 'occupied' ? x.chipCount + (t.isHandInProgress() ? x.totalInvestedThisHand : 0) : 0), 0);
const DRAWS = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];

/** Everyone calls / checks while `more()` holds. */
function callAround(t: PokerTable, more: () => boolean): void {
  for (let g = 0; g < 80 && more(); g++) {
    const a = t.activeSeatIndex;
    expect(a).toBeGreaterThanOrEqual(0);
    const owes = t.currentBetToMatch > t.seats[a].currentBet;
    expect(owes ? t.playerCall(a) : t.playerCheck(a)).toBe(true);
  }
}
/** Pre-flop: `shover` moves all-in when on the clock, everyone else calls / checks. */
function shoveAndCall(t: PokerTable, shover: number): void {
  for (let g = 0; g < 30 && t.currentPhase === GamePhase.PreFlop; g++) {
    const a = t.activeSeatIndex;
    if (a === shover) expect(t.playerAllIn(a)).toBe(true);
    else expect(t.currentBetToMatch > t.seats[a].currentBet ? t.playerCall(a) : t.playerCheck(a)).toBe(true);
  }
}
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
function fakeSocket(id: string) {
  const emitted: Array<[string, any]> = [];
  const handlers: Record<string, (...a: any[]) => any> = {};
  return { id, emitted, handlers, connected: true, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, d: any) => emitted.push([ev, d]), join() {}, leave() {} };
}

/** A draw table brought to Draw1 by calls / checks; returns the seat that closed the betting (still activeSeatIndex). */
function toDraw1(t: FiveCardDrawTable): number {
  t.startNewHand();
  callAround(t, () => t.currentPhase === GamePhase.PreFlop);
  expect(t.currentPhase).toBe(GamePhase.Draw1);
  return t.activeSeatIndex;
}

// ---------------------------------------------------------------- F28 ----

describe('F28 — no betting in a draw round', () => {
  for (const [name, mk] of [
    ['Five Card Draw', () => new FiveCardDrawTable(cfg(), false)],
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true)],
    ['Badugi', () => new BadugiTable(cfg())],
  ] as Array<[string, () => FiveCardDrawTable]>) {
    it(`${name}: the seat that closed the betting cannot call / raise / all-in / fold in Draw1; nothing is owed`, () => {
      const t = mk();
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
      const stale = toDraw1(t);
      expect(stale).toBeGreaterThanOrEqual(0);
      expect(t.currentBetToMatch).toBe(0);              // old: 50 (the pre-draw bet, owed by every seat)
      const before = t.seats.map((s) => s.chipCount);
      expect(t.playerCall(stale)).toBe(false);          // old: true — 50 more chips into the pot mid-draw
      expect(t.playerRaise(stale, 100)).toBe(false);
      expect(t.playerAllIn(stale)).toBe(false);         // old: true — an un-bet-into shove
      expect(t.playerCheck(stale)).toBe(false);
      expect(t.playerFold(stale)).toBe(false);          // old: true — a phantom turn moved on
      expect(t.seats.map((s) => s.chipCount)).toEqual(before);
      expect(t.currentPhase).toBe(GamePhase.Draw1);
      expect(t.canRaise(stale)).toBe(false);
      // The draw itself still works and the round completes.
      for (const i of [0, 1, 2]) expect(t.playerDraw(i, [0])).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Bet2);
      const invested = t.seats.filter((s) => s.state === 'occupied').map((s) => s.totalInvestedThisHand);
      expect(new Set(invested).size).toBe(1);           // old probe: [50, 50, 100]
    });
  }

  it("the 'action' handler refuses any betting action during a draw round (code draw_round)", () => {
    const t = new FiveCardDrawTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    const stale = toDraw1(t);
    const sock = fakeSocket('s');
    const scope = {
      playerSessions: new Map([['s', { tableId: T, seatIndex: stale, playerId: 'p', trainingEnabled: false }]]),
      multiTableSessions: new Map(), tableManager: { getTable: () => t }, actionNonces: new Map(), actionTimings: new Map(),
      DrawPhases: DRAWS, GamePhase, allInOrFoldTables: new Set(), pendingAutoStartTimers: new Map(),
      broadcastGameState() {}, scheduleAIAction() {},
    };
    const { exports: wire } = load(`function wire(socket) {\n${handlerSrc('action', '\n  );\n')}\n}`, scope, 'wire');
    wire(sock);
    const before = t.seats[stale].chipCount;
    sock.handlers.action({ type: 'call', nonce: 'n1', stateVersion: t.stateVersion });
    expect(sock.emitted).toEqual([['error', expect.objectContaining({ code: 'draw_round' })]]);
    expect(t.seats[stale].chipCount).toBe(before);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
  });
});

// ---------------------------------------------------------------- F29 ----

describe('F29 — sitting out during a draw round never freezes it', () => {
  const P = {
    broken: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
    isTournamentReservation: fnSrc('function isTournamentReservation('),
    sync: fnSrc('function syncSitOutToTable('),
  };
  function world(event: 'sitOut' | 'playerAFK') {
    const t = new FiveCardDrawTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    const stale = toDraw1(t);
    // Everyone else draws first (the bots' 0.5-1.5s); only the stale seat is left.
    for (const i of [0, 1, 2]) if (i !== stale) expect(t.playerDraw(i, [])).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    const sock = fakeSocket('sH');
    const broadcasts: string[] = [];
    const scope = {
      tableManager: { getTable: (id: string) => (id === T ? t : undefined) },
      tournamentTables: new Map(), reservedSeats: new Map(), sitOutTracker: new Map(),
      playerSessions: new Map([['sH', { socketId: 'sH', tableId: T, seatIndex: stale, playerName: `P${stale}`, playerId: `p${stale}`, sittingOut: false }]]),
      DrawPhases: DRAWS, GamePhase, FiveCardDrawTable,
      broadcastGameState: (id: string) => broadcasts.push(id), scheduleAIAction() {},
    };
    const code = `${P.broken}\n${P.isTournamentReservation}\n${P.sync}\nfunction wire(socket) {\n${handlerSrc(event, '\n  });\n')}\n}`;
    const { exports: wire } = load(code, scope, 'wire');
    wire(sock);
    return { t, stale, sock, broadcasts };
  }

  for (const ev of ['sitOut', 'playerAFK'] as const) {
    it(`${ev} by the last undrawn seat (the stale active seat): stood pat, the round completes (old: folded, Draw1 forever)`, async () => {
      const w = world(ev);
      await w.sock.handlers[ev]();
      expect(w.t.seats[w.stale].folded).toBe(false);   // old: true — and nothing completed the round
      expect(w.t.currentPhase).toBe(GamePhase.Bet2);
      expect(w.broadcasts).toContain(T);
    });
  }
});

// ---------------------------------------------------------------- F26 ----

describe('F26 — a draw never hands back the drawer\'s own discards; the reshuffled stub is never lost', () => {
  it('6-handed Triple Draw, the stub runs out in Draw1: every card stays in play, nobody gets his own discards', () => {
    const t = new FiveCardDrawTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000, 4: 5000, 5: 5000 });
    toDraw1(t);
    const deck = (t as any).deck;
    expect(deck.cardsRemaining()).toBe(22);
    const allCards = () => {
      const held = t.seats.flatMap((s) => s.holeCards);
      const pile = (t as any).discardPile as Card[];
      const over = (t as any)._discardOverflow as Card[];
      const rest = (deck.cards as Card[]).slice(deck.currentIndex);
      return [...held, ...pile, ...over, ...rest];
    };
    for (const [seat, idx] of [[0, [0, 1, 2, 3, 4]], [1, [0, 1, 2, 3, 4]], [2, [0, 1, 2, 3, 4]], [3, [0, 1, 2, 3, 4]], [4, [0, 1, 2, 3, 4]], [5, [0, 1]]] as Array<[number, number[]]>) {
      const thrown = idx.map((i) => t.seats[seat].holeCards[i]);
      expect(t.playerDraw(seat, idx)).toBe(true);
      const got = t.seats[seat].holeCards;
      expect(got).toHaveLength(5);
      for (const c of thrown) expect(got.some((g) => key(g) === key(c))).toBe(false);   // old: seat 5 got exactly his 2 back
      const every = allCards().map(key);
      expect(new Set(every).size).toBe(every.length);                                  // never a duplicate
      expect(every).toHaveLength(52);                                                  // old: 22 cards vanished at seat 5
    }
  });

  it('a second reshuffle in a hand uses its own shuffle domain', () => {
    const t = new FiveCardDrawTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000, 3: 5000, 4: 5000, 5: 5000 });
    toDraw1(t);
    const domains: string[] = [];
    const deck = (t as any).deck;
    const real = deck.shuffleForeignCards.bind(deck);
    deck.shuffleForeignCards = (cards: Card[], domain: string) => { domains.push(domain); return real(cards, domain); };
    for (const s of [0, 1, 2, 3, 4, 5]) expect(t.playerDraw(s, [0, 1, 2, 3, 4])).toBe(true);
    expect(domains).toHaveLength(1);
    callAround(t, () => t.currentPhase === GamePhase.Bet2);
    expect(t.currentPhase).toBe(GamePhase.Draw2);
    for (const s of [0, 1, 2, 3, 4, 5]) expect(t.playerDraw(s, [0, 1, 2, 3, 4])).toBe(true);
    expect(domains.length).toBeGreaterThanOrEqual(2);
    expect(domains[1]).toBe(`discards-h${t.handNumber}-r2`);
    expect(new Set(domains).size).toBe(domains.length);
    expect(domains[0]).toBe(`discards-h${t.handNumber}`);
  });
});

// ---------------------------------------------------------------- F27 / F44 ----

describe('F27 — an all-in player draws like everyone else', () => {
  it('Five Card Draw 3-handed: the short stack shoves pre-draw and is called; he draws (old: refused, frozen at his dealt hand)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 300 });
    t.startNewHand();
    shoveAndCall(t, 2);
    expect(t.currentPhase).toBe(GamePhase.Draw1);
    expect(t.seats[2].allIn).toBe(true);
    expect(t.drawsCompleted.has(2)).toBe(false);       // old: pre-marked as drawn
    const dealt = [...t.seats[2].holeCards];
    expect(t.playerDraw(0, [])).toBe(true);
    expect(t.playerDraw(1, [])).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Draw1);       // waits for the all-in seat (old: Bet2)
    expect(t.playerDraw(2, [0, 1, 2])).toBe(true);      // old: false
    expect(same(t.seats[2].holeCards, dealt)).toBe(false);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
  });

  for (const [name, mk, draws] of [
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true), 3],
    ['Badugi', () => new BadugiTable(cfg()), 3],
    ['Five Card Draw', () => new FiveCardDrawTable(cfg(), false), 1],
  ] as Array<[string, () => FiveCardDrawTable, number]>) {
    it(`${name} heads-up, both all-in: every draw round runs and both draw in each (old: no draw at all); no betting turn (F44)`, () => {
      const t = mk();
      seatAt(t, { 0: 60, 1: 60 });   // under the fixed-limit cap: a real all-in
      const turns: Array<[string, number]> = [];
      t.on('turnChanged', (d: any) => turns.push([String(t.currentPhase), d.seatIndex]));
      const chips0 = tableChips(t);
      t.startNewHand();
      const a = t.activeSeatIndex;
      expect(t.playerAllIn(a)).toBe(true);
      expect(t.playerCall(t.activeSeatIndex)).toBe(true);
      turns.length = 0;
      const seen: GamePhase[] = [];
      for (let r = 0; r < draws; r++) {
        expect(DRAWS).toContain(t.currentPhase);
        seen.push(t.currentPhase);
        expect(t.playerDraw(0, [0])).toBe(true);
        expect(t.playerDraw(1, [0, 1])).toBe(true);
      }
      expect(seen).toEqual(DRAWS.slice(0, draws));
      expect(t.currentPhase).toBe(GamePhase.HandComplete);
      expect(turns.filter(([, s]) => s >= 0)).toEqual([]);
      expect(tableChips(t)).toBe(chips0);
    });
  }
});

describe('F44 — no betting turn when nobody can call', () => {
  for (const [name, mk, rounds] of [
    ['Five Card Draw', () => new FiveCardDrawTable(cfg(), false), 1],
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true), 3],
    ['Badugi', () => new BadugiTable(cfg()), 3],
  ] as Array<[string, () => FiveCardDrawTable, number]>) {
    it(`${name}: the short stack is all-in and called; the live player only draws (old: a Check turn every betting round)`, () => {
      const t = mk();
      seatAt(t, { 0: 5000, 1: 60 });
      const chips0 = tableChips(t);
      t.startNewHand();
      shoveAndCall(t, 1);
      const turns: Array<[string, number]> = [];
      t.on('turnChanged', (d: any) => turns.push([String(t.currentPhase), d.seatIndex]));
      for (let r = 0; r < rounds; r++) {
        expect(DRAWS).toContain(t.currentPhase);
        expect(t.playerDraw(0, [])).toBe(true);
        expect(t.playerDraw(1, [])).toBe(true);
      }
      expect(t.currentPhase).toBe(GamePhase.HandComplete);
      expect(turns.filter(([, s]) => s >= 0)).toEqual([]);   // old: [['Bet2', 0], ...]
      expect(tableChips(t)).toBe(chips0);
    });
  }

  it('two players with chips behind still bet after the draw (3-handed, one all-in)', () => {
    const t = new FiveCardDrawTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 60 });
    t.startNewHand();
    shoveAndCall(t, 2);
    for (const i of [0, 1, 2]) expect(t.playerDraw(i, [])).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.Bet2);
    expect(t.activeSeatIndex).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------- F39 ----

describe('F39 — Triple Draw / Badugi: Bet2 is a small-bet round', () => {
  for (const [name, mk] of [
    ['2-7 Triple Draw', () => new FiveCardDrawTable(cfg(), true)],
    ['Badugi', () => new BadugiTable(cfg())],
  ] as Array<[string, () => FiveCardDrawTable]>) {
    it(`${name} 25/50: a Bet2 bet is 50 (old: 100), raises in 50s`, () => {
      const t = mk();
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
      toDraw1(t);
      for (const i of [0, 1, 2]) expect(t.playerDraw(i, [])).toBe(true);
      expect(t.currentPhase).toBe(GamePhase.Bet2);
      const a = t.activeSeatIndex;
      expect(t.getMinRaise()).toBe(50);
      expect(t.maxRaiseFor(a)).toBe(50);                 // old: 100
      expect(t.playerRaise(a, 10000)).toBe(true);        // clamped to the cap
      expect(t.currentBetToMatch).toBe(50);              // old: 100
      const b = t.activeSeatIndex;
      expect(t.maxRaiseFor(b)).toBe(100);
      expect(t.playerRaise(b, 100)).toBe(true);
      expect(t.lastRaiseAmount).toBe(50);
    });
  }
});

// ---------------------------------------------------------------- G169 / F27 (index) ----

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
  ShortDeckTable, FiveCardDrawTable, SevenStudTable, MAX_SEATS, GamePhase, cardToString, DrawPhases: DRAWS,
  playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
  dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null,
  tournamentIdOfTable: () => undefined, rebuyAllowedAt: () => true, progressionManager: { getProgress: () => null },
});
function stateOf(table: PokerTable, seat: number): any {
  const { exports } = load(STATE_SRC, STATE_SCOPE(), 'getGameStateForPlayer');
  return exports(table, seat, false);
}

describe('G169 — the draw clock is sent, and the stand-pat fires at its deadline', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); jest.setSystemTime(1_000_000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function world(stacks: Record<number, number>, ai: number[] = []) {
    const t = new FiveCardDrawTable(cfg(), true);
    for (const [i, chips] of Object.entries(stacks)) t.sitDown(Number(i), `P${i}`, chips, ai.includes(Number(i)) ? `ai-${i}` : `p${i}`, ai.includes(Number(i)), true);
    const broadcasts: number[] = [];
    const scope: Record<string, unknown> = {
      ...STATE_SCOPE(),
      tableManager: { getTable: () => t }, drawTimers: new Map(),
      aiProfiles: new Map(ai.length ? [[T, new Map()]] : []),
      broadcastGameState: () => broadcasts.push(Date.now()),
    };
    const code = `${STATE_SRC}\n${fnSrc('function scheduleAIAction(')}`;
    const { exports: m } = load(code, scope, '{ getGameStateForPlayer, scheduleAIAction }');
    return { t, m, broadcasts };
  }

  it('drawStartedAt is the Draw1 start, stays put, and moves on at Draw2 / Draw3; drawTimeout 30s; 0 outside a draw', () => {
    const w = world({ 0: 5000, 1: 5000 });
    w.t.startNewHand();
    const pre = w.m.getGameStateForPlayer(w.t, 0, false);
    expect(pre.drawStartedAt).toBe(0);                 // old: key absent
    expect(pre.drawTimeout).toBe(30000);
    callAround(w.t, () => w.t.currentPhase === GamePhase.PreFlop);
    const start1 = Date.now();
    const s1 = w.m.getGameStateForPlayer(w.t, 1, false);
    expect(s1.drawStartedAt).toBe(start1);
    jest.advanceTimersByTime(4000);
    expect(w.m.getGameStateForPlayer(w.t, 0, false).drawStartedAt).toBe(start1);   // one clock for everyone
    w.t.playerDraw(0, []); w.t.playerDraw(1, []);
    expect(w.m.getGameStateForPlayer(w.t, 0, false).drawStartedAt).toBe(0);         // Bet2
    callAround(w.t, () => w.t.currentPhase === GamePhase.Bet2);
    jest.advanceTimersByTime(2000);
    expect(w.t.currentPhase).toBe(GamePhase.Draw2);
    const start2 = Date.now();
    expect(w.m.getGameStateForPlayer(w.t, 0, false).drawStartedAt).toBe(start2);   // Draw2: a new start
    expect(start2).not.toBe(start1);
    w.t.playerDraw(0, []); w.t.playerDraw(1, []);
    callAround(w.t, () => w.t.currentPhase === GamePhase.Bet3);
    jest.advanceTimersByTime(3000);
    expect(w.t.currentPhase).toBe(GamePhase.Draw3);
    expect(w.m.getGameStateForPlayer(w.t, 1, false).drawStartedAt).toBe(start2 + 3000);   // Draw3: another
    expect(slice('const ALWAYS_EMIT_KEYS = [', '];')).toMatch(/'drawStartedAt',\s*'drawTimeout',/);
  });

  it('the stand-pat fires at drawStartedAt + 30s even when the timer is armed late (old: 30s after arming)', () => {
    const w = world({ 0: 5000, 1: 5000 });
    w.t.startNewHand();
    callAround(w.t, () => w.t.currentPhase === GamePhase.PreFlop);
    const start = w.m.getGameStateForPlayer(w.t, 0, false).drawStartedAt;
    jest.advanceTimersByTime(10000);
    w.m.scheduleAIAction(T);
    jest.advanceTimersByTime(19999);
    expect(w.t.currentPhase).toBe(GamePhase.Draw1);
    jest.advanceTimersByTime(1);
    expect(Date.now()).toBe(start + 30000);
    expect(w.t.currentPhase).toBe(GamePhase.Bet2);       // both humans stood pat
  });

  it('F27 — the bot loop draws an all-in bot, and the clock stands pat an all-in human (old: both skipped)', () => {
    const w = world({ 0: 5000, 1: 60, 2: 60 }, [0, 1]);   // seat 2 is the human (60: a real fixed-limit all-in)
    const drew: number[] = [];
    const real = w.t.playerDraw.bind(w.t);
    w.t.playerDraw = (seat: number, idx: number[]) => { const ok = real(seat, idx); if (ok) drew.push(seat); return ok; };
    w.t.startNewHand();
    for (let g = 0; g < 30 && w.t.currentPhase === GamePhase.PreFlop; g++) {
      const a = w.t.activeSeatIndex;
      if (a === 0) expect(w.t.currentBetToMatch > w.t.seats[0].currentBet ? w.t.playerCall(0) : w.t.playerCheck(0)).toBe(true);
      else expect(w.t.playerAllIn(a)).toBe(true);
    }
    expect(w.t.currentPhase).toBe(GamePhase.Draw1);
    expect(w.t.seats[1].allIn && w.t.seats[2].allIn).toBe(true);
    w.m.scheduleAIAction(T);
    jest.advanceTimersByTime(2000);
    expect(drew.sort()).toEqual([0, 1]);                 // the all-in bot drew (old: pre-marked, never drew)
    expect(w.t.currentPhase).toBe(GamePhase.Draw1);      // waiting for the all-in human
    jest.advanceTimersByTime(28000);
    expect(w.t.currentPhase).not.toBe(GamePhase.Draw1);  // stood pat at the deadline
    expect(drew).toContain(2);
  });
});

// ---------------------------------------------------------------- F116 ----

describe('F116 — 2-7 bots draw to a low', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('A-K high breaks K and A; a straight / a flush break their top card; 9-K draws five; a 7-low stands pat', () => {
    const t = new FiveCardDrawTable(cfg(), true);
    for (const i of [0, 1, 2, 3]) t.sitDown(i, `B${i}`, 5000, `ai-${i}`, true);
    t.sitDown(4, 'Human', 5000, 'h', false);             // never draws: the round stays open
    toDraw1(t);
    t.seats[0].holeCards = cs('2c 3d 4h Ks Ac');
    t.seats[1].holeCards = cs('9c Td Jh Qs Kc');
    t.seats[2].holeCards = cs('2c 3c 4c 5c 7c');
    t.seats[3].holeCards = cs('2c 3d 4h 5s 7c');
    const drawn = new Map<number, number[]>();
    const real = t.playerDraw.bind(t);
    t.playerDraw = (seat: number, idx: number[]) => { drawn.set(seat, [...idx].sort()); return real(seat, idx); };
    const { exports: schedule } = load(fnSrc('function scheduleAIAction('), {
      tableManager: { getTable: () => t }, GamePhase, DrawPhases: DRAWS, FiveCardDrawTable, drawTimers: new Map(),
      aiProfiles: new Map([[T, new Map()]]), TURN_TIMEOUT_MS: 30000, drawClockStart: () => Date.now(),
      broadcastGameState() {},
    }, 'scheduleAIAction');
    schedule(T);
    jest.advanceTimersByTime(2000);
    expect(drawn.get(0)).toEqual([3, 4]);                // old: [] (stood pat on A-K high)
    expect(drawn.get(1)).toEqual([0, 1, 2, 3, 4]);       // old: [] (a made straight); 5 cards (old cap 3)
    expect(drawn.get(2)).toEqual([4]);                   // old: [] (a flush): breaks the 7
    expect(drawn.get(3)).toEqual([]);                    // 7-5-4-3-2: the nuts, stand pat
  });
});

// ---------------------------------------------------------------- F16 ----

describe('F16 — Crazy Pineapple: an all-in before the flop still gets its discard', () => {
  /** Heads-up, 500 each: A (seat 0) 7s 7h Kd, B (seat 1) Ac Ad Qc; board 7d 3s 9c Jh 4d. */
  function spot(decider?: (t: PineappleTable) => boolean) {
    const t = new PineappleTable(cfg(), true);
    seatAt(t, { 0: 500, 1: 500 });
    if (decider) t.discardHoldDecider = decider;
    t.startNewHand();
    rig(t, { 0: '7s 7h Kd', 1: 'Ac Ad Qc' }, '7d 3s 9c Jh 4d');
    return t;
  }
  const allInPreflop = (t: PineappleTable) => {
    expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    expect(t.playerCall(t.activeSeatIndex)).toBe(true);
  };

  it('no window (no decider): the server keeps the best hand with the flop — A keeps his set and wins (old: dropped 7h, lost)', () => {
    const t = spot();
    allInPreflop(t);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(same(t.seats[0].holeCards, cs('7s 7h'))).toBe(true);
    expect(same(t.seats[1].holeCards, cs('Ac Ad'))).toBe(true);
    expect(t.seats[0].chipCount).toBe(1000);
    expect(t.seats[1].chipCount).toBe(0);
  });

  it('with the window: the runout holds on the flop (no actor), a pick is honoured, release runs it out', () => {
    const asked: number[] = [];
    const t = spot((tt) => { asked.push(tt.handNumber); return true; });
    allInPreflop(t);
    expect(asked).toEqual([t.handNumber]);
    expect(t.currentPhase).toBe(GamePhase.Flop);         // old: HandComplete in the same tick
    expect(t.communityCards).toHaveLength(3);
    expect(t.activeSeatIndex).toBe(-1);
    expect(t.isDiscardHeld()).toBe(true);
    expect(t.isRunoutHeld()).toBe(true);
    expect(t.seatsAwaitingDiscard()).toEqual([0, 1]);
    expect(t.canRaise(0) || t.canRaise(1)).toBe(false);
    expect(t.selectPineappleDiscard(0, 0)).toBe(true);   // A throws the 7s (his choice, not the server's)
    expect(t.hasDiscardChoice(0)).toBe(true);
    expect(t.releaseDiscardHold()).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(same(t.seats[0].holeCards, cs('7h Kd'))).toBe(true);
    expect(t.discardOf(0)).toEqual(cs('7s')[0]);
    expect(t.actionLog.find((a) => a.seatIndex === 0 && /discarded/.test(a.action))!.action).toBe('discarded a card');
    expect(t.releaseDiscardHold()).toBe(false);
  });

  it('a lost window timer cannot wedge it: the watchdog\'s advanceTurn fallback releases the hold', () => {
    const t = spot(() => true);
    allInPreflop(t);
    expect(t.isDiscardHeld()).toBe(true);
    (t as any).advanceTurn();
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount + t.seats[1].chipCount).toBe(1000);
  });

  it('plain Pineapple never holds (its discard is before the flop, during pre-flop betting)', () => {
    const t = new PineappleTable(cfg(), false);
    seatAt(t, { 0: 500, 1: 500 });
    let asked = 0;
    t.discardHoldDecider = () => { asked++; return true; };
    t.startNewHand();
    allInPreflop(t);
    expect(asked).toBe(0);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
  });

  describe('index.ts — the window (decidePineappleDiscardHold / release / the handler)', () => {
    beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

    const BLOCK = slice('const PINEAPPLE_DISCARD_WINDOW_MS = ', 'releasePineappleDiscardHold(tableId, handNumber);\n}\n')
      + '\n' + fnSrc('function ensureInsuranceHoldWired(');
    function world(sessions: number[]) {
      const t = new PineappleTable(cfg(), true);
      seatAt(t, { 0: 500, 1: 500 });
      const scheduled: string[] = [];
      const playerSessions = new Map<string, any>(sessions.map((s) => [`s${s}`, { tableId: T, seatIndex: s }]));
      const scope = {
        tableManager: { getTable: () => t }, GamePhase, log: { info() {} }, wiredInsuranceHold: new WeakSet(),
        seatHasAnySession: (_id: string, i: number) => sessions.includes(i), playerSessions, multiTableSessions: new Map(),
        broadcastGameState() {}, scheduleAutoStart: (id: string) => scheduled.push(`auto:${id}`), scheduleAIAction: (id: string) => scheduled.push(`ai:${id}`),
        decideInsuranceHold: () => false,
      };
      const code = `${BLOCK}\nfunction wire(socket) {\n${slice('  const seatSessionFor = ', '  };\n')}\n${handlerSrc('selectPineappleDiscard', '\n  });\n')}\n}`;
      const { exports: m } = load(code, scope, '{ ensureInsuranceHoldWired, wire, PINEAPPLE_DISCARD_WINDOW_MS, pineappleDiscardHolds }');
      m.ensureInsuranceHoldWired(T, t);
      t.startNewHand();
      rig(t, { 0: '7s 7h Kd', 1: 'Ac Ad Qc' }, '7d 3s 9c Jh 4d');
      allInPreflop(t);
      return { t, m, scheduled };
    }

    it('holds when a human with a session still holds 3 cards; the window timer releases it and schedules the next hand', () => {
      const w = world([0]);
      expect(w.t.isDiscardHeld()).toBe(true);
      jest.advanceTimersByTime(w.m.PINEAPPLE_DISCARD_WINDOW_MS - 1);
      expect(w.t.isDiscardHeld()).toBe(true);
      jest.advanceTimersByTime(1);
      expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
      expect(w.scheduled).toEqual([`auto:${T}`]);
      expect(w.m.pineappleDiscardHolds.size).toBe(0);
    });

    it('no human can pick (bots / absent players): no window, the board runs out at once', () => {
      const w = world([]);
      expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
    });

    it('every waiting human picked: released at once (selectPineappleDiscard)', () => {
      const w = world([0, 1]);
      const s0 = fakeSocket('s0'); w.m.wire(s0);
      const s1 = fakeSocket('s1'); w.m.wire(s1);
      s0.handlers.selectPineappleDiscard({ cardIndex: 0 });
      expect(w.t.isDiscardHeld()).toBe(true);
      s1.handlers.selectPineappleDiscard({ cardIndex: 2, tableId: T });
      expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
      expect(s1.emitted).toContainEqual(['pineappleDiscardAck', { success: true, cardIndex: 2, tableId: T }]);
    });
  });
});

// ---------------------------------------------------------------- F17 ----

describe('F17 — a discard pick belongs to its own hand and its own player', () => {
  /** Deal; seat 0 picks `idx`; everyone folds before the flop. */
  function pickThenWalk(t: PineappleTable, idx: number): void {
    t.startNewHand();
    expect(t.selectPineappleDiscard(0, idx)).toBe(true);
    for (let g = 0; g < 10 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
  }
  function nextHandToFlop(t: PineappleTable, seat0: string): void {
    t.startNewHand();
    t.seats[0].holeCards = cs(seat0);
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.currentPhase).toBe(GamePhase.Flop);
  }

  it('a pick from a hand that ended pre-flop is NOT applied to the next hand (old: it threw his 7h, logged as his choice)', () => {
    const t = new PineappleTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    pickThenWalk(t, 0);
    expect(t.selectPineappleDiscard(0, 1)).toBe(false);   // between hands: refused (old: accepted)
    nextHandToFlop(t, '7h Tc 2c');
    expect(same(t.seats[0].holeCards, cs('7h Tc'))).toBe(true);   // the server's pick: the 2c
    expect(t.actionLog.find((a) => a.seatIndex === 0 && /discarded/.test(a.action))!.action).toBe('auto-discarded a card');
  });

  it('nor to the next player in that seat', () => {
    const t = new PineappleTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    pickThenWalk(t, 1);
    expect(t.standUp(0)).toBeTruthy();
    expect(t.sitDown(0, 'Newbie', 5000, 'pN', false)).toBe(true);
    nextHandToFlop(t, 'Ah As 3d');
    expect(same(t.seats[0].holeCards, cs('Ah As'))).toBe(true);   // old: threw the As (the last player's pick)
  });

  it('Crazy Pineapple: a pick on a flop everyone folded is not applied at the next hand\'s turn', () => {
    const t = new PineappleTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(t.selectPineappleDiscard(0, 0)).toBe(true);
    expect(t.playerRaise(t.activeSeatIndex, 200)).toBe(true);
    for (let g = 0; g < 10 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
    t.startNewHand();
    rig(t, { 0: 'Kh Kc 4d' }, '2c 7d 9s Jh 3s');
    callAround(t, () => t.currentPhase === GamePhase.PreFlop || t.currentPhase === GamePhase.Flop);
    expect(t.currentPhase).toBe(GamePhase.Turn);
    expect(t.seats[0].holeCards.some((c) => c.rank === 13 && c.suit === 0)).toBe(true);   // old: Kh thrown
  });
});

// ---------------------------------------------------------------- F18 ----

describe('F18 — the shared hand history never names a discarded card', () => {
  const CARD_LABEL = /(10|[2-9JQKA])[♥♦♣♠]/;
  for (const crazy of [false, true]) {
    it(`${crazy ? 'Crazy ' : ''}Pineapple, won uncontested: no card in players[].actions / actionLog; the owner's copy carries his discard`, () => {
      const t = new PineappleTable(cfg(), crazy);
      seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
      let history: any = null;
      t.on('handHistory', (h) => { history = h; });
      t.startNewHand();
      const street = crazy ? GamePhase.Turn : GamePhase.Flop;
      callAround(t, () => t.currentPhase !== street);
      const bettor = t.activeSeatIndex;
      expect(t.playerRaise(bettor, 200)).toBe(true);
      for (let g = 0; g < 10 && t.isHandInProgress(); g++) expect(t.playerFold(t.activeSeatIndex)).toBe(true);
      expect(history.wentToShowdown ?? false).toBe(false);
      const lines = [...history.players.flatMap((p: any) => p.actions), ...history.actionLog.map((a: any) => a.action)];
      expect(lines.filter((l: string) => /discard/.test(l))).toHaveLength(6);   // 3 seats, both copies
      for (const l of lines) expect(l).not.toMatch(CARD_LABEL);                 // old: 'auto-discarded 3♣' …
      // index.ts — HIS copy: viewerDiscard (handHistoryViewerOf).
      const { exports: viewerOf } = load(`${fnSrc('function handHistoryViewerOf(')}\n${SEAT_IDENTITY_SRC}`, {}, 'handHistoryViewerOf');
      const v = viewerOf(t, history, { seatIndex: 1, playerName: 'P1', playerId: 'p1' });
      expect(v.discard).toEqual(t.discardOf(1));
      expect(v.discard).toBeTruthy();
      expect(slice("  table.on('handHistory', (history: HandHistoryRecord) => {", '\n  });\n')).toContain('forViewer.viewerDiscard = serializeCard(viewer.discard);');
    });
  }
});

// ---------------------------------------------------------------- F34 ----

describe('F34 — the Pineapple discard picker keys are in the state', () => {
  it('Pineapple pre-flop: both true for a seat holding 3 cards; a folded seat has no picker; a spectator none', () => {
    const t = new PineappleTable(cfg(), false);
    seatAt(t, { 0: 5000, 1: 5000, 2: 5000 });
    t.startNewHand();
    const a = t.activeSeatIndex;
    expect(t.playerFold(a)).toBe(true);
    const other = [0, 1, 2].find((i) => i !== a)!;
    expect(stateOf(t, other)).toMatchObject({ isPineapple: true, pineappleDiscardActive: true });   // old: keys absent
    expect(stateOf(t, a)).toMatchObject({ isPineapple: true, pineappleDiscardActive: false });
    expect(stateOf(t, -1)).toMatchObject({ isPineapple: true, pineappleDiscardActive: false });
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(stateOf(t, other).pineappleDiscardActive).toBe(false);                                   // discarded: the window closed
  });

  it('Crazy Pineapple: the window is the flop', () => {
    const t = new PineappleTable(cfg(), true);
    seatAt(t, { 0: 5000, 1: 5000 });
    t.startNewHand();
    expect(stateOf(t, 0).pineappleDiscardActive).toBe(false);
    callAround(t, () => t.currentPhase === GamePhase.PreFlop);
    expect(stateOf(t, 0)).toMatchObject({ isPineapple: true, pineappleDiscardActive: true });
  });

  it('every other table sends both keys as false (the delta clears them)', () => {
    const t = new PokerTable(cfg());
    seatAt(t, { 0: 5000, 1: 5000 });
    t.startNewHand();
    const s = stateOf(t, 0);
    expect(s.isPineapple).toBe(false);
    expect(s.pineappleDiscardActive).toBe(false);
  });

  it('selectPineappleDiscard { cardIndex, tableId }: an extra multi-table seat; an unknown table is refused (not_at_table); the ack names the table', () => {
    const A = new PineappleTable(cfg({ tableId: 'A' }), false);
    const B = new PineappleTable(cfg({ tableId: 'B' }), false);
    for (const t of [A, B]) { seatAt(t, { 0: 5000, 1: 5000 }); t.startNewHand(); }
    const tables: Record<string, PineappleTable> = { A, B };
    const sock = fakeSocket('s');
    const { exports: wire } = load(`function wire(socket) {\n${slice('  const seatSessionFor = ', '  };\n')}\n${handlerSrc('selectPineappleDiscard', '\n  });\n')}\n}`, {
      playerSessions: new Map([['s', { tableId: 'A', seatIndex: 0 }]]),
      multiTableSessions: new Map([['s', [{ tableId: 'B', seatIndex: 1 }]]]),
      tableManager: { getTable: (id: string) => tables[id] }, broadcastGameState() {}, releasePineappleDiscardHoldIfDecided() {},
    }, 'wire');
    wire(sock);
    sock.handlers.selectPineappleDiscard({ cardIndex: 2, tableId: 'B' });
    expect(B.hasDiscardChoice(1)).toBe(true);           // old: applied to the MAIN seat (A seat 0)
    expect(A.hasDiscardChoice(0)).toBe(false);
    sock.handlers.selectPineappleDiscard({ cardIndex: 1 });
    expect(A.hasDiscardChoice(0)).toBe(true);           // no tableId: the main seat, as before
    sock.handlers.selectPineappleDiscard({ cardIndex: 1, tableId: 'C' });
    expect(sock.emitted).toEqual([
      ['pineappleDiscardAck', { success: true, cardIndex: 2, tableId: 'B' }],
      ['pineappleDiscardAck', { success: true, cardIndex: 1, tableId: 'A' }],
      ['error', { message: 'You are not seated at that table.', code: 'not_at_table', tableId: 'C' }],
    ]);
  });
});

// ---------------------------------------------------------------- F20 ----

describe('F20 — Omaha hi-lo pot lists name their winners (main + side pot)', () => {
  it('a short stack scoops the main pot (high + low), another player the side pot: each pot names its winner with its amount', () => {
    const t = new OmahaTable(cfg(), true, 4);
    seatAt(t, { 0: 100, 1: 1000, 2: 1000 });   // 100: a real all-in under the pot limit
    t.startNewHand();
    rig(t, { 0: 'Ah 2h Kc Kd', 1: 'Qs Qh 9c 9d', 2: 'Js Jh Tc Td' }, '3c 4d 8s Qd 5c');
    shoveAndCall(t, 0);
    expect(t.currentPhase).toBe(GamePhase.Flop);
    expect(t.playerRaise(t.activeSeatIndex, 100)).toBe(true);
    expect(t.playerCall(t.activeSeatIndex)).toBe(true);
    callAround(t, () => t.isHandInProgress());
    const pots = t.lastHandResult!.pots as any[];
    expect(pots.map((p) => p.name)).toEqual(['Main Pot', 'Side Pot 1']);
    // Old: [{ name: 'Main Pot', winners: [], winnerAmounts: [] }, { name: 'Side Pot 1', winners: [], … }].
    expect(pots[0]).toMatchObject({ amount: 300, winners: [0], winnerAmounts: [{ seatIndex: 0, amount: 300 }] });
    expect(pots[1]).toMatchObject({ amount: 200, winners: [1], winnerAmounts: [{ seatIndex: 1, amount: 200 }] });
  });
});

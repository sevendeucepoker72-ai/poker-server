/**
 * R1 (2026-10-11) — ECON-1 / TABLEUI-1 END TO END: all-in insurance from the
 * engine's runout through the quote in the player's game state, the
 * `acceptInsurance` handler and the hand-complete settlement.
 *
 * The old unit test (InsuranceSettlement.test.ts) only fed 0..1 values to the
 * pure helpers, so it could never see the live bug: the handler passed the
 * training engine's PERCENT equity against a RANDOM hand (clamped to 100%, so
 * every accept paid 90% of the pot), let a player insure before the opponent
 * had called, and at tournament tables. This file drives the REAL PokerTable
 * and the REAL src/index.ts code (sliced + transpiled — index.ts boots a
 * server on import): runOutBoard -> runoutHoldDecider (decideInsuranceHold:
 * exact / seeded equity against the opponent's ACTUAL cards) ->
 * getGameStateForPlayer.insuranceQuote -> acceptInsurance -> the window ends
 * -> the board runs out -> settleInsuranceForHand: the insured stack ends the
 * hand with EXACTLY the quoted cashout.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { Card, cardToString } from '../src/game/Card';
import { priceInsuranceQuote, insuranceSettlementDelta } from '../src/game/insurance';
import { headsUpEquity } from '../src/game/handEquity';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const cs = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map((t) => ({ rank: RANKS[t[0]], suit: SUITS[t[1]] } as Card));
const key = (c: Card) => c.suit * 16 + c.rank;

const INSURANCE_BLOCK = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========',
  '  broadcastGameState(tableId); // reflect the adjusted stack to all clients\n}\n');
const HANDLERS = slice('  const insuranceSessionFor = ', '  // ========== Straddle ==========').replace('  // ========== Straddle ==========', '');
const STATE = fnSrc('function getVariantInfo(') + fnSrc('function getGameStateForPlayer(');

interface Socket { id: string; emitted: Array<[string, any]>; handlers: Record<string, (d?: any) => void>; emit: (ev: string, d: any) => void; on: (ev: string, fn: any) => void }

function world() {
  const tables = new Map<string, PokerTable>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const authSessions = new Map<string, any>();
  const tournamentIds = new Set<string>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const broadcasts: string[] = [];
  const autoStarts: Array<[string, number]> = [];
  const sockets = new Map<string, Socket>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id) },
    playerSessions, multiTableSessions, authSessions,
    isTournamentTable: (id: string) => tournamentIds.has(id),
    tournamentIdOfTable: (id: string) => (tournamentIds.has(id) ? 'tour-1' : undefined),
    spinGoMultipliers: new Map(), careerTables: new Map(), allInOrFoldTables: new Set(), quickTables: new Set(), challengeTables: new Map(),
    insuranceCashouts: new Map(),
    PokerTable, OmahaTable, ShortDeckTable, FiveCardDrawTable, SevenStudTable, GamePhase, MAX_SEATS: 9,
    priceInsuranceQuote, insuranceSettlementDelta,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    io: { sockets: { sockets } },
    broadcastGameState: (tid: string) => { broadcasts.push(tid); },
    scheduleAutoStart: (tid: string, ms: number) => { autoStarts.push([tid, ms]); },
    scheduleAIAction() {},
    // getGameStateForPlayer's other inputs
    cardToString, progressionManager: { getProgress: () => null }, turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000,
    bombPotActive: new Map(), dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [],
  };
  const code = INSURANCE_BLOCK + fnSrc('function seatHasLiveSession(') + STATE
    + `\nfunction registerInsurance(socket) {\n${HANDLERS}\n}\n`;
  const { exports: m, stubbed } = load(code, scope, `{
    tableKindOf, rebuyAllowedAt, rebuyRefusalAt, insuranceCandidates, ensureInsuranceHoldWired, insuranceQuoteForSeat,
    releaseInsuranceHold, settleInsuranceForHand, getGameStateForPlayer, registerInsurance,
    insuranceOffers, insuranceStats, privateTableIds, clubTableIds, INSURANCE_DECISION_MS }`);

  const mkSocket = (id: string): Socket => {
    const s: Socket = {
      id, emitted: [], handlers: {},
      emit: (ev, d) => { s.emitted.push([ev, d]); },
      on: (ev, fn) => { s.handlers[ev] = fn; },
    };
    sockets.set(id, s);
    m.registerInsurance(s);
    return s;
  };

  /** A Hold'em table (SB 50 / BB 100, min buy-in 1,000) with Hero (human) at seat 0 and Villain at seat 1. */
  const mkTable = (opts: { id?: string; heroStack?: number; villainStack?: number; villainHuman?: boolean; omaha?: boolean } = {}) => {
    const id = opts.id ?? 'T1';
    const cfg = { tableId: id, tableName: id, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 1000 };
    const t: PokerTable = opts.omaha ? new OmahaTable(cfg as any, false, 4) : new PokerTable(cfg as any);
    tables.set(id, t);
    expect(t.sitDown(0, 'Hero', opts.heroStack ?? 1000, 'player-hero', false)).toBe(true);
    expect(t.sitDown(1, 'Villain', opts.villainStack ?? 5000, opts.villainHuman ? 'player-vill' : 'ai-vill', !opts.villainHuman)).toBe(true);
    const hero = mkSocket('S-hero');
    playerSessions.set('S-hero', { socketId: 'S-hero', tableId: id, seatIndex: 0, playerName: 'Hero', playerId: 'player-hero', trainingEnabled: false, sittingOut: false });
    authSessions.set('S-hero', { userId: 42, username: 'hero.slug' });
    let villain: Socket | null = null;
    if (opts.villainHuman) {
      villain = mkSocket('S-vill');
      playerSessions.set('S-vill', { socketId: 'S-vill', tableId: id, seatIndex: 1, playerName: 'Villain', playerId: 'player-vill', trainingEnabled: false, sittingOut: false });
      authSessions.set('S-vill', { userId: 43, username: 'vill.slug' });
    }
    m.ensureInsuranceHoldWired(id, t);
    // What handleHandComplete does with the engine's results (aggregate per seat, then settle).
    t.on('handResult', (d: any) => {
      const won = new Map<number, number>();
      for (const r of d.results) won.set(r.seatIndex, (won.get(r.seatIndex) || 0) + (r.amount || 0));
      m.settleInsuranceForHand(id, t, won);
    });
    return { t, hero, villain, id };
  };

  /** Deal: fixed hole cards, then the remaining deck in runout order (burn, flop, burn, turn, burn, river). */
  const rig = (t: PokerTable, hero: string, villain: string, board: string) => {
    t.seats[0].holeCards = cs(hero);
    t.seats[1].holeCards = cs(villain);
    const b = cs(board);
    const used = new Set([...t.seats[0].holeCards, ...t.seats[1].holeCards, ...b].map(key));
    const rest: Card[] = [];
    for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) if (!used.has(suit * 16 + rank)) rest.push({ suit, rank } as Card);
    const order = [rest[0], b[0], b[1], b[2], rest[1], b[3], rest[2], b[4], ...rest.slice(3)];
    const deck = (t as any).deck;
    deck.cards = order;
    deck.currentIndex = 0;
  };

  /** Play until the hand is held for insurance or over. Hero shoves when it is his turn (on `shoveOn`); Villain calls / checks. */
  const play = (t: PokerTable, shoveOn: GamePhase = GamePhase.PreFlop) => {
    for (let guard = 0; guard < 20 && t.isHandInProgress() && !t.isRunoutHeld(); guard++) {
      const a = t.activeSeatIndex;
      const s = t.seats[a];
      const owes = t.currentBetToMatch > s.currentBet;
      if (a === 0 && t.currentPhase === shoveOn) expect(t.playerAllIn(0)).toBe(true);
      else if (owes) expect(t.playerCall(a)).toBe(true);
      else expect(t.playerCheck(a)).toBe(true);
    }
  };

  return { m, stubbed, scope, tables, playerSessions, multiTableSessions, authSessions, tournamentIds, audits, broadcasts, autoStarts, mkTable, mkSocket, rig, play };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('the decision window: the runout is held only for an eligible all-in human, and the quote is priced against the opponent\'s actual cards', () => {
  it('pre-flop shove called: the board is NOT dealt; Hero\'s state carries the quote (seeded equity vs QQ), nobody else\'s does', () => {
    const w = world();
    const { t } = w.mkTable();
    expect(t.startNewHand()).toBe(true);
    w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');
    w.play(t);
    expect(t.isRunoutHeld()).toBe(true);
    expect(t.communityCards).toEqual([]);
    expect(t.activeSeatIndex).toBe(-1);
    expect(t.isHandInProgress()).toBe(true);

    const eq = headsUpEquity(cs('Ah Kh'), cs('Qs Qd'), [], {}).equity;   // ~46%
    const q = w.m.insuranceQuoteForSeat('T1', t, 0);
    expect(q).toMatchObject({ handNumber: t.handNumber, pot: 2000 });
    expect(Math.abs(q.equityPct - eq * 100)).toBeLessThan(2);               // seeded Monte Carlo pre-flop
    expect(Number.isInteger(q.cashout)).toBe(true);
    expect(q.cashout).toBeGreaterThan(700);                                   // ~0.9 * 0.46 * 2000 = ~830
    expect(q.cashout).toBeLessThan(900);                                      // never 90% of the pot (1,800)
    expect(q.expiresAt).toBeGreaterThan(Date.now());

    const hero = w.m.getGameStateForPlayer(t, 0);
    expect(hero.insuranceQuote).toEqual(q);
    expect(hero).toMatchObject({ tableKind: 'cash', rebuyAllowed: true, minBuyIn: 1000, maxBuyIn: 10000 });
    expect(w.m.getGameStateForPlayer(t, 1).insuranceQuote).toBeNull();   // the (AI) opponent
    expect(w.m.getGameStateForPlayer(t, -1).insuranceQuote).toBeNull();  // spectators
    expect(w.stubbed.has('priceInsuranceQuote')).toBe(false);
  });

  it('flop all-in: the quote is EXACT (all 990 runouts) — equal to the enumerated equity against QQ', () => {
    const w = world();
    const { t } = w.mkTable();
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', '2h 7h Jc 3s 4d');
    w.play(t, GamePhase.Flop);
    expect(t.isRunoutHeld()).toBe(true);
    expect(t.communityCards.map(cardToString)).toEqual(cs('2h 7h Jc').map(cardToString));
    const exact = headsUpEquity(cs('Ah Kh'), cs('Qs Qd'), cs('2h 7h Jc'));
    expect(exact.exact).toBe(true);
    const q = w.m.insuranceQuoteForSeat('T1', t, 0);
    expect(q).toEqual({ handNumber: t.handNumber, pot: 2000, equityPct: Math.round(exact.equity * 100), cashout: Math.round(2000 * exact.equity * 0.9), expiresAt: q.expiresAt });
  });

  it('no window (the board runs out at once, as before) on tournament / quick / challenge tables, or for an AI or session-less shover', () => {
    const cases: Array<[string, (w: ReturnType<typeof world>, t: PokerTable) => void]> = [
      ['tournament table', (w) => w.tournamentIds.add('T1')],
      ['heads-up snap (quick table)', (w) => (w.scope.quickTables as Set<string>).add('T1')],
      ['spin & go', (w) => (w.scope.spinGoMultipliers as Map<string, number>).set('T1', 3)],
      ['career', (w) => (w.scope.careerTables as Map<string, any>).set('T1', { venue: 0, stage: 0 })],
      ['all-in or fold', (w) => (w.scope.allInOrFoldTables as Set<string>).add('T1')],
      ['club challenge', (w) => (w.scope.challengeTables as Map<string, any>).set('T1', { challengeId: 1 })],
      ['hero has no live session', (w) => w.playerSessions.delete('S-hero')],
      ['hero is a bot', (_w, t) => { t.seats[0].isAI = true; }],
    ];
    for (const [name, setup] of cases) {
      const w = world();
      const { t } = w.mkTable();
      setup(w, t);
      t.startNewHand();
      w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');
      w.play(t);
      expect([name, t.isRunoutHeld()]).toEqual([name, false]);
      expect([name, t.currentPhase]).toEqual([name, GamePhase.HandComplete]);
      expect([name, w.m.insuranceStats.windows]).toEqual([name, 0]);
    }
  });

  it('Texas Hold\'em only: an Omaha table in the very same all-in spot has no candidate (a Hold\'em table does)', () => {
    for (const omaha of [false, true]) {
      const w = world();
      const { t } = w.mkTable({ omaha });
      t.startNewHand();
      // The spot by hand: Hero all-in on the flop, Villain in, nothing to call.
      t.seats[0].holeCards = omaha ? cs('Ah Kh Qc Jd') : cs('Ah Kh');
      t.seats[1].holeCards = omaha ? cs('Qs Qd 2c 3c') : cs('Qs Qd');
      t.communityCards = cs('2h 7h Jc');
      (t as any).currentPhase = GamePhase.Flop;
      t.seats[0].allIn = true;
      expect([omaha, w.m.insuranceCandidates('T1', t).length]).toEqual([omaha, omaha ? 0 : 1]);
    }
  });

  it('a 3-way all-in is never insured (exactly two players must be in the hand)', () => {
    const w = world();
    const { t } = w.mkTable();
    expect(t.sitDown(2, 'Third', 1000, 'ai-third', true)).toBe(true);
    t.startNewHand();
    for (let guard = 0; guard < 20 && t.isHandInProgress(); guard++) {
      const a = t.activeSeatIndex;
      if (t.seats[a].chipCount > 0 && t.currentBetToMatch < 1000) expect(t.playerAllIn(a)).toBe(true);
      else expect(t.playerCall(a) || t.playerCheck(a)).toBe(true);
    }
    expect(t.isRunoutHeld()).toBe(false);
    expect(w.m.insuranceStats.windows).toBe(0);
  });

  it('private and club cash tables are eligible (tableKind private / club, rebuy allowed)', () => {
    for (const kind of ['private', 'club'] as const) {
      const w = world();
      (kind === 'private' ? w.m.privateTableIds : w.m.clubTableIds).add('T1');
      const { t } = w.mkTable();
      t.startNewHand();
      w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');
      w.play(t);
      expect(t.isRunoutHeld()).toBe(true);
      expect(w.m.getGameStateForPlayer(t, 0)).toMatchObject({ tableKind: kind, rebuyAllowed: true });
    }
  });
});

describe('acceptInsurance -> the window ends -> the insured stack ends the hand with EXACTLY the quoted cashout', () => {
  const accepted = (s: any) => s.emitted.filter(([ev]: [string]) => ev === 'insuranceAccepted').map(([, d]: [string, any]) => d);
  const errors = (s: any) => s.emitted.filter(([ev]: [string]) => ev === 'error').map(([, d]: [string, any]) => d.code);

  it('OUTDRAWN: the house pays — Hero 0 from the pot + delta = cashout; the opponent keeps the whole pot', () => {
    const w = world();
    const { t, hero } = w.mkTable();
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');        // QQ holds
    w.play(t);
    const q = w.m.insuranceQuoteForSeat('T1', t, 0);
    hero.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber, cashout: 1_000_000, equityPct: 100 }); // client numbers ignored
    expect(accepted(hero)).toEqual([{ cashout: q.cashout, equityPct: q.equityPct, tableId: 'T1', handNumber: t.handNumber }]);
    // Hero was the only quoted seat → the window closed at once: the board ran out and the hand settled.
    expect(t.isRunoutHeld()).toBe(false);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.communityCards).toHaveLength(5);
    expect(t.seats[0].chipCount).toBe(q.cashout);
    expect(t.seats[1].chipCount).toBe(6000);
    expect(w.audits.find((a) => a.action === 'INSURANCE_PAYOUT')?.d).toMatchObject({ cashout: q.cashout, actualWon: 0, delta: q.cashout, newStack: q.cashout });
    expect(w.autoStarts).toEqual([['T1', 3000]]);           // next hand scheduled like after a hand-ending action
    expect(w.m.insuranceStats).toMatchObject({ windows: 1, accepted: 1, releasedDecided: 1, settled: 1 });
  });

  it('HERO WINS: the house collects the margin — Hero ends with the cashout, not the 2,000 pot', () => {
    const w = world();
    const { t, hero } = w.mkTable();
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', 'Ac 7d 9s 3h 4c');        // AK pairs the ace
    w.play(t);
    const q = w.m.insuranceQuoteForSeat('T1', t, 0);
    hero.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber });
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount).toBe(q.cashout);
    expect(t.seats[1].chipCount).toBe(4000);
    expect(w.audits.find((a) => a.action === 'INSURANCE_COLLECT')?.d).toMatchObject({ cashout: q.cashout, actualWon: 2000, delta: q.cashout - 2000 });
  });

  it('nobody accepts: the window times out after INSURANCE_DECISION_MS and the hand plays out normally (no insurance)', () => {
    const w = world();
    const { t } = w.mkTable();
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', 'Ac 7d 9s 3h 4c');
    w.play(t);
    expect(t.isRunoutHeld()).toBe(true);
    jest.advanceTimersByTime(w.m.INSURANCE_DECISION_MS - 1);
    expect(t.isRunoutHeld()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(t.isRunoutHeld()).toBe(false);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount).toBe(2000);                // won the real pot
    expect(w.m.insuranceStats).toMatchObject({ releasedTimeout: 1, settled: 0 });
    expect(w.autoStarts).toEqual([['T1', 3000]]);
  });

  it('refusals with stable codes: no / another handNumber (an old client), not seated there, nothing quoted — nothing recorded', () => {
    const w = world();
    const { t, hero } = w.mkTable();
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', 'Ac 7d 9s 3h 4c');
    w.play(t);
    hero.handlers.acceptInsurance({ equityPct: 46, cashoutAmount: 830 });          // the pre-R1 client payload
    hero.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber - 1 });
    hero.handlers.acceptInsurance({ tableId: 'OTHER', handNumber: t.handNumber });
    expect(errors(hero)).toEqual(['insurance_stale_hand', 'insurance_stale_hand', 'insurance_not_seated']);
    expect((w.scope.insuranceCashouts as Map<string, any>).size).toBe(0);
    expect(t.isRunoutHeld()).toBe(true);
    // A spectator socket (no seat) — and the socket of a seat with no quote.
    const spec = w.mkSocket('S-spec');
    spec.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber });
    expect(errors(spec)).toEqual(['insurance_not_seated']);
  });

  it('both players all-in and human: each gets his own quote; a second accept is refused; the window closes when both decided', () => {
    const w = world();
    const { t, hero, villain } = w.mkTable({ heroStack: 1000, villainStack: 1000, villainHuman: true });
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');
    for (let g = 0; g < 10 && t.isHandInProgress() && !t.isRunoutHeld(); g++) expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    expect(t.isRunoutHeld()).toBe(true);
    const qh = w.m.insuranceQuoteForSeat('T1', t, 0);
    const qv = w.m.insuranceQuoteForSeat('T1', t, 1);
    expect(qh.equityPct + qv.equityPct).toBeGreaterThanOrEqual(99);
    expect(qh.equityPct + qv.equityPct).toBeLessThanOrEqual(101);
    hero.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber });
    hero.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber });
    expect(errors(hero)).toEqual(['insurance_already_accepted']);
    expect(t.isRunoutHeld()).toBe(true);                    // villain has not decided
    expect(w.m.getGameStateForPlayer(t, 0).insuranceQuote).toBeNull();
    expect(w.m.getGameStateForPlayer(t, 1).insuranceQuote).toEqual(qv);
    villain!.handlers.declineInsurance({ tableId: 'T1', handNumber: t.handNumber });
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount).toBe(qh.cashout);          // insured, outdrawn
    expect(t.seats[1].chipCount).toBe(2000);                // won the pot, not insured
    expect(w.m.insuranceStats).toMatchObject({ accepted: 1, declined: 1, releasedDecided: 1 });
  });

  it('insure-then-leave forfeits: a folded insured seat gets NOTHING (no cashout while the opponent takes the pot)', () => {
    // Both all-in and human, so the window stays open after Hero's accept.
    const w = world();
    const { t, hero, villain } = w.mkTable({ heroStack: 1000, villainStack: 1000, villainHuman: true });
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', 'Ac 7d 9s 3h 4c');        // Hero would even win the runout
    for (let g = 0; g < 10 && t.isHandInProgress() && !t.isRunoutHeld(); g++) expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    hero.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber });
    expect(t.isRunoutHeld()).toBe(true);
    // Hero leaves: handlePlayerLeave folds a non-active in-pot seat with forceFoldSeat.
    expect(t.forceFoldSeat(0)).toBe(true);
    // One player left in the hand: nobody can be quoted any more.
    expect(w.m.getGameStateForPlayer(t, 1).insuranceQuote).toBeNull();
    villain!.handlers.acceptInsurance({ tableId: 'T1', handNumber: t.handNumber });
    expect(errors(villain)).toEqual(['insurance_unavailable']);
    jest.advanceTimersByTime(w.m.INSURANCE_DECISION_MS);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount).toBe(0);
    expect(t.seats[1].chipCount).toBe(2000);
    expect(w.audits.find((a) => a.action === 'INSURANCE_VOID')?.d).toMatchObject({ reason: 'forfeited' });
    expect(w.audits.some((a) => a.action === 'INSURANCE_PAYOUT' || a.action === 'INSURANCE_COLLECT')).toBe(false);
  });

  it('a lost timer cannot wedge the table: a second runOutBoard (the wedge watchdog\'s advanceTurn) runs the board out', () => {
    const w = world();
    const { t } = w.mkTable();
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');
    w.play(t);
    expect(t.isRunoutHeld()).toBe(true);
    (t as any).advanceTurn();                               // what WedgeWatchdog calls for activeSeat -1
    expect(t.isRunoutHeld()).toBe(false);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.seats[0].chipCount + t.seats[1].chipCount).toBe(6000);    // nobody called a phantom bet
    expect(t.seats[1].chipCount).toBe(6000);                // QQ held: the whole pot, no insurance
    jest.advanceTimersByTime(w.m.INSURANCE_DECISION_MS);    // the window's own timer then finds nothing to release
    expect(w.m.insuranceStats.releasedTimeout).toBe(0);
  });

  it('a record from another hand is void (never settled against the next hand)', () => {
    const w = world();
    const { t } = w.mkTable();
    (w.scope.insuranceCashouts as Map<string, any>).set('T1', [{ seatIndex: 0, playerId: 'player-hero', cashout: 900, handNumber: 0, equityPct: 50, pot: 2000 }]);
    t.startNewHand();
    w.rig(t, 'Ah Kh', 'Qs Qd', '2c 7d 9s 3h 4c');
    for (let g = 0; g < 10 && t.isHandInProgress(); g++) {
      const a = t.activeSeatIndex;
      if (t.currentBetToMatch > t.seats[a].currentBet) expect(t.playerFold(a)).toBe(true);
      else expect(t.playerCheck(a)).toBe(true);
    }
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.audits.find((a) => a.action === 'INSURANCE_VOID')?.d).toMatchObject({ reason: 'other_hand' });
  });
});

describe('wiring in src/index.ts', () => {
  it('handleHandComplete aggregates the pot winnings per seat and settles insurance BEFORE the tournament bust capture', () => {
    const hc = fnSrc('async function handleHandComplete(');
    expect(hc).toContain('totalWonPerSeat.set(r.seatIndex, (totalWonPerSeat.get(r.seatIndex) || 0) + (r.amount || 0));');
    const at = hc.indexOf('settleInsuranceForHand(tableId, table, totalWonPerSeat);');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(hc.indexOf('captureTournamentBustCheck(tableId, table, results)'));
    expect(hc.slice(0, at)).not.toContain('await ');
  });

  it('every table broadcast wires the decision window; the per-player state always carries insuranceQuote / tableKind / rebuyAllowed', () => {
    expect(fnSrc('function broadcastGameState(')).toContain('ensureInsuranceHoldWired(tableId, table);');
    const gs = fnSrc('function getGameStateForPlayer(');
    for (const k of ['stateObj.insuranceQuote = ', 'stateObj.tableKind = ', 'stateObj.rebuyAllowed = ', 'stateObj.minBuyIn = ']) expect(gs).toContain(k);
  });

  it('the training engine\'s percent equity is gone from the insurance path', () => {
    expect(SRC).not.toContain('calculateEquity(seat.holeCards');
    expect(SRC).not.toContain('insuranceCashoutAmount(pot, equity)');
  });
});

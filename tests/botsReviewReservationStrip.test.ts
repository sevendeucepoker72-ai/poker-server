/**
 * Bots review 2026-11-04 — the LAST human's seat ending by a path other than
 * handlePlayerLeave strips the table's bots (GAME-17), the same rule.
 *
 * Before: bots were stripped only by handlePlayerLeave, the hand-end mark and
 * stripBotsAfterHandIfMarked. A last human who disconnected reached reservation
 * expiry → endCashReservation → teardownSeat with no strip, so up to 5 bots
 * dealt to each other forever (live: Shark Tank, 4 bots, no human). Leaving an
 * extra table (leaveAdditionalTable) and an extra-table cash-out on departure
 * (cashOutAdditionalSeatsOnDeparture) had the same hole.
 * Now: stripBotsIfLastHumanLeft (a copy of handlePlayerLeave's GAME-17 block)
 * runs after each of those teardowns — between hands at once, mid-hand at the
 * hand's end (marked). Never a quick game's fixed roster; never a tournament
 * table (stripBotsWhenNoHumans' F99 skip).
 *
 * REAL src/index.ts text (the seat-teardown block with endCashReservation,
 * processPendingSeatRemovals, the leave handlers) on the REAL PokerTable.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { fnSrc, handlerSrc, load, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const T = 'cash-1';
const quiet = { log() {}, warn() {}, error() {} };
const occ = (t: PokerTable) => t.seats.map((s) => (s.state !== 'occupied' ? '.' : s.isAI ? 'B' : 'H')).join('');

function world(o: { quick?: boolean; tournament?: boolean } = {}) {
  const table = new PokerTable({ tableId: T, tableName: T, smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 } as any);
  const aiProfiles = new Map<string, Map<number, any>>([[T, new Map()]]);
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const pendingAutoStartTimers = new Map<string, any>();
  const aiTimeouts = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const authSessions = new Map<string, any>();
  const credits: Array<[number, number]> = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === T ? table : undefined) }, MAX_SEATS, GamePhase, FiveCardDrawTable,
    DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], aiProfiles, aiTimeouts, pendingAutoStartTimers,
    pendingSeatRemovalAfterHand, sitOutTracker: new Map(), quickTables: new Set(o.quick ? [T] : []), playerSessions: new Map(),
    multiTableSessions, authSessions, io: { sockets: { sockets: new Map() } },
    scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {}, endStaleSessionsAtSeat() {},
    isTournamentTable: () => !!o.tournament, isFixedRosterQuickTable: () => !!o.quick,
    seatPlayedByAnotherAccount: () => false, refreshWalletAfterCashOut() {}, auditLog() {}, addChipsToUser: async () => true,
    creditSeatStackToWallet: (uid: number, _u: string, _t: string, seat: any) => { credits.push([uid, seat.chipCount]); return Promise.resolve(true); },
    console: quiet,
  };
  const code = [
    fnSrc('function processPendingSeatRemovals('), SEAT_TEARDOWN_SRC, fnSrc('function cashOutAdditionalSeatsOnDeparture('),
    `function wire(socket) {\n${handlerSrc('leaveAdditionalTable', '\n  });\n')}\n}`,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope,
    '{ wire, endCashReservation, processPendingSeatRemovals, stripBotsAfterHandIfMarked, stripBotsIfLastHumanLeft, cashOutAdditionalSeatsOnDeparture, botStripAfterHand, seatTeardownStats }');
  // The 'handResult' listener's order: the deferred stand-ups, then the bot strip mark.
  table.on('handResult', () => { m.processPendingSeatRemovals(T); m.stripBotsAfterHandIfMarked(T); });
  const bot = (i: number) => { expect(table.sitDown(i, `Bot${i}`, 10000, `ai-${i}`, true)).toBe(true); aiProfiles.get(T)!.set(i, { botName: `Bot${i}` }); };
  const playOut = () => {
    for (let g = 0; g < 400 && table.isHandInProgress(); g++) {
      const a = table.activeSeatIndex;
      if (a < 0) break;
      if (!(table.playerCheck(a) || table.playerCall(a))) table.playerFold(a);
    }
  };
  const mkSocket = (id: string) => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const s: any = { id, handlers, rooms: new Set<string>(), on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit() {}, join() {}, leave() {} };
    authSessions.set(id, { userId: 7, username: 'u7' });
    m.wire(s);
    return s;
  };
  return { table, m, stubbed, aiProfiles, pendingSeatRemovalAfterHand, pendingAutoStartTimers, multiTableSessions, credits, bot, playOut, mkSocket };
}

describe('endCashReservation — the last human\'s reservation ends: the bots go too', () => {
  it('(1) between hands, 1 human + 4 bots, reserve_expiry: every bot stood up, the profiles and the pending start dropped, lastHumanBotStrips=1 (0dc1b96: the 4 bots stayed and dealt on)', () => {
    const w = world();
    w.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 5; i++) w.bot(i);
    const timer = setTimeout(() => {}, 60_000);
    w.pendingAutoStartTimers.set(T, timer);
    expect(w.m.endCashReservation(7, 'u7', { tableId: T, seatIndex: 0, chips: 10000 }, 'reserve_expiry')).toBe(10000);
    clearTimeout(timer);
    expect(occ(w.table)).toBe('.........');
    expect(w.aiProfiles.has(T)).toBe(false);
    expect(w.pendingAutoStartTimers.has(T)).toBe(false);
    expect(w.m.seatTeardownStats.lastHumanBotStrips).toBe(1);
    expect(w.credits).toEqual([[7, 10000]]);
    expect([...w.stubbed].filter((n) => /strip|Strip|teardown/.test(n))).toEqual([]);
  });

  it('(2) mid-hand with his blind in the pot: the seat waits for the hand\'s end, the table is marked; after the hand it is empty (0dc1b96: "B.BBB....")', () => {
    for (let hs = 0; hs < 5; hs++) {
      const w = world();
      for (let i = 0; i < 5; i++) { if (i === hs) w.table.sitDown(i, 'H', 10000, 'h', false); else w.bot(i); }
      expect(w.table.startNewHand()).toBe(true);
      if (!(w.table.seats[hs].totalInvestedThisHand > 0)) continue;   // the human posted a blind
      w.m.endCashReservation(7, 'u7', { tableId: T, seatIndex: hs, chips: 10000 }, 'reserve_expiry');
      expect(w.pendingSeatRemovalAfterHand.get(T)?.has(hs)).toBe(true);
      expect(w.m.botStripAfterHand.has(T)).toBe(true);
      expect(occ(w.table).replace(/\./g, '').length).toBe(5);         // nothing stood up mid-hand
      w.playOut();
      expect(w.table.currentPhase).toBe(GamePhase.HandComplete);
      expect(occ(w.table)).toBe('.........');
      expect(w.m.seatTeardownStats.lastHumanBotStrips).toBe(1);
      return;
    }
    throw new Error('no seat posted a blind');
  });

  it('GUARD (passes at 0dc1b96 too) — (3) another human still seated: nothing stripped', () => {
    const w = world();
    w.table.sitDown(0, 'H0', 10000, 'h0', false); w.table.sitDown(5, 'H5', 10000, 'h5', false);
    for (let i = 1; i < 5; i++) w.bot(i);
    w.m.endCashReservation(7, 'u7', { tableId: T, seatIndex: 0, chips: 10000 }, 'reserve_expiry');
    expect(occ(w.table)).toBe('.BBBBH...');
  });

  it('GUARD (passes at 0dc1b96 too) — (4) a quick game (fixed roster): nothing stripped', () => {
    const w = world({ quick: true });
    w.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 3; i++) w.bot(i);
    w.m.endCashReservation(7, 'u7', { tableId: T, seatIndex: 0, chips: 10000 }, 'reserve_expiry');
    expect(occ(w.table)).toBe('.BB......');
  });

  it('GUARD (passes at 0dc1b96 too) — (5) a tournament table: stripBotsWhenNoHumans\' F99 skip still applies (the bots are entrants)', () => {
    const w = world({ tournament: true });
    w.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 4; i++) w.bot(i);
    w.m.endCashReservation(7, 'u7', { tableId: T, seatIndex: 0, chips: 10000 }, 'reserve_expiry');
    expect(occ(w.table)).toBe('.BBB.....');
    expect(w.m.botStripAfterHand.has(T)).toBe(false);
  });
});

describe('the extra-table paths: the last human gone strips the bots', () => {
  it('(6a) leaveAdditionalTable between hands: the bots go at once', async () => {
    const w = world();
    w.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 5; i++) w.bot(i);
    const s = w.mkSocket('S1');
    w.multiTableSessions.set('S1', [{ socketId: 'S1', tableId: T, seatIndex: 0, playerName: 'H0', playerId: 'h0' }]);
    await s.handlers.leaveAdditionalTable({ tableId: T });
    expect(occ(w.table)).toBe('.........');
    expect(w.m.seatTeardownStats.lastHumanBotStrips).toBe(1);
  });

  it('(6b) leaveAdditionalTable with his chips in the pot: deferred, the bots go at the hand\'s end', async () => {
    for (let hs = 0; hs < 5; hs++) {
      const w = world();
      for (let i = 0; i < 5; i++) { if (i === hs) w.table.sitDown(i, 'H', 10000, 'h', false); else w.bot(i); }
      expect(w.table.startNewHand()).toBe(true);
      if (!(w.table.seats[hs].totalInvestedThisHand > 0)) continue;
      const s = w.mkSocket('S1');
      w.multiTableSessions.set('S1', [{ socketId: 'S1', tableId: T, seatIndex: hs, playerName: 'H', playerId: 'h' }]);
      await s.handlers.leaveAdditionalTable({ tableId: T });
      expect(w.m.botStripAfterHand.has(T)).toBe(true);
      w.playOut();
      expect(occ(w.table)).toBe('.........');
      return;
    }
    throw new Error('no seat posted a blind');
  });

  it('(6c) cashOutAdditionalSeatsOnDeparture as the last human: the bots go', () => {
    const w = world();
    w.table.sitDown(0, 'H0', 10000, 'h0', false);
    for (let i = 1; i < 5; i++) w.bot(i);
    const s: any = { id: 'S1', leave() {} };
    w.multiTableSessions.set('S1', [{ socketId: 'S1', tableId: T, seatIndex: 0, playerName: 'H0', playerId: 'h0' }]);
    w.m.cashOutAdditionalSeatsOnDeparture(s, { userId: 7, username: 'u7' }, 'disconnect');
    expect(occ(w.table)).toBe('.........');
    expect(w.m.seatTeardownStats.lastHumanBotStrips).toBe(1);
  });
});

describe('(7) the helper stays a copy of handlePlayerLeave\'s GAME-17 rule', () => {
  it('the humansStaying expression is the same text in both', () => {
    const expr = (src: string) => {
      const m = /const humansStaying = ([^\n]+);\n/.exec(src);
      if (!m) throw new Error('no humansStaying');
      return m[1];
    };
    const helper = fnSrc('function stripBotsIfLastHumanLeft(');
    const leave = fnSrc('function handlePlayerLeave(');
    expect(expr(helper)).toBe("table.seats.some((s) => s.state === 'occupied' && !s.isAI && !pendingHere?.has(s.seatIndex))");
    expect(expr(helper)).toBe(expr(leave));
    expect(SEAT_TEARDOWN_SRC).toContain('function stripBotsIfLastHumanLeft(');
  });
});

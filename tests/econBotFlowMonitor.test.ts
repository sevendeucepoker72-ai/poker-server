/**
 * Bots review 2026-11-04 (economy-farming E10 / E11) — the bot chip flow is
 * an independent tally.
 *
 * E10: every chip a bot holds on a wallet-chip table is created (seated,
 * reloaded) and destroyed (capped, its seat removed) at an explicit point, so
 *   seatedChips + minted - burned - removedChips - liveBotChips()
 * is what humans took from bots (health engine.botStacks.humansTookFromBots).
 * At 0dc1b96 `burned` counted only the (now off) cap, and a stripped / taken /
 * trimmed bot's stack vanished uncounted — no identity was possible.
 * E11: quickGameStats.byFormat (games started / won by the human per format)
 * and the Spin & Go house sums (fees in, prizes out, refunds).
 *
 * The REAL index.ts code, sliced: botStackStats + noteBotSeated /
 * noteBotStackRemoved / liveBotChips, reloadAndCapBotStacks, the seat-teardown
 * block (takeAiSeatForJoin, takePlannedAiSeat, stripBotsWhenNoHumans),
 * fillWithAI, trimExcessAI, and the quick-game registry (registerQuickGame,
 * quickGameEndCheck, finishQuickGame, refundQuickEntryFee), on REAL
 * PokerTables.
 *
 * Fails on 0dc1b96: none of noteBotSeated / noteBotStackRemoved / liveBotChips
 * / quickGameStats.byFormat exist.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { quickGameOutcome } from '../src/game/quickGames';
import { slice, fnSrc, load, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const BOT_FLOW_SRC = [
  slice('const botStackStats = {', '\n};\n'),
  fnSrc('function noteBotSeated('),
  fnSrc('function noteBotStackRemoved('),
  fnSrc('function liveBotChips('),
  fnSrc('function reloadAndCapBotStacks('),
  SEAT_TEARDOWN_SRC,
  fnSrc('function fillWithAI('),
  fnSrc('function trimExcessAI('),
].join('\n');
const QUICK_SRC = [
  slice('const quickGameStats = {', '\n};\n'),
  fnSrc('function registerQuickGame('),
  fnSrc('function quickGameEndCheck('),
  fnSrc('function finishQuickGame('),
  fnSrc('function refundQuickEntryFee('),
].join('\n');

function world(opts: { tournamentTables?: string[]; prizeTables?: string[] } = {}) {
  const tables = new Map<string, PokerTable>();
  const mk = (id: string, buyIn: number) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: buyIn / 100, bigBlind: buyIn / 50, ante: 0, minBuyIn: buyIn } as any);
    tables.set(id, t);
    return t;
  };
  let n = 0;
  const quickGames = new Map<string, any>();
  const settled: any[] = [];
  const timers: Array<() => void> = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id), getAllTableIds: () => [...tables.keys()] },
    isTournamentTable: (id: string) => !!opts.tournamentTables?.includes(id),
    isPrizeFormatTable: (id: string) => !!opts.prizeTables?.includes(id),
    MAX_SEATS, GamePhase, BOT_STACK_CAP_BUYINS: 0, CASH_TABLE_TARGET_OCCUPIED: 6,
    aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), pendingSeatRemovalAfterHand: new Map(),
    generateRandomProfile: () => ({ botName: `Bot${++n}` }), uuidv4: () => `u${++n}`,
    log: { debug() {}, info() {}, warn() {} }, console: { log() {}, warn() {}, error() {} },
    // quick games
    quickGames, quickGameOutcome, quickGameTimers: new Map(), CHALLENGE_JOIN_GRACE_MS: 180_000,
    QUICK_GAME_RESULT_DELAY_MS: 1000, QUICK_GAME_CLEANUP_DELAY_MS: 5000,
    setTimeout: (fn: () => void) => { timers.push(fn); return 0; },
    tableHasHumanSeat: (t: PokerTable) => t.seats.some((s) => s.state === 'occupied' && !s.isAI),
    prizeLedger: { settle: async (x: any) => { settled.push(x); return { status: 'committed', attempts: 1 }; } },
    auditLog() {}, emitQuickGameEvent() {}, cleanupQuickTable() {}, resolveChallenge: async () => {},
  };
  const { exports: m, stubbed } = load(`${BOT_FLOW_SRC}\n${QUICK_SRC}`, scope,
    '{ botStackStats, noteBotSeated, noteBotStackRemoved, liveBotChips, reloadAndCapBotStacks, takeAiSeatForJoin, takePlannedAiSeat, stripBotsWhenNoHumans, fillWithAI, trimExcessAI, quickGameStats, registerQuickGame, quickGameEndCheck, finishQuickGame, refundQuickEntryFee }');
  const took = () => m.botStackStats.seatedChips + m.botStackStats.minted - m.botStackStats.burned - m.botStackStats.removedChips - m.liveBotChips();
  const runTimers = () => { while (timers.length) timers.shift()!(); };
  return { m, stubbed, mk, tables, took, quickGames, settled, runTimers, scope };
}
const bots = (t: PokerTable) => t.seats.filter((s) => s.state === 'occupied' && s.isAI);

describe('E10 — every bot chip on a wallet-chip table is created and destroyed at a counted point', () => {
  it('(2) fillWithAI at a 5,000 table seating 3 bots counts seatedBy.ring = 15,000', () => {
    const w = world();
    const t = w.mk('ring', 5000);
    t.sitDown(0, 'Human', 5000, 'p-h', false);
    w.m.fillWithAI(t, 'ring', 'hard', 4);
    expect(bots(t)).toHaveLength(3);
    expect(w.m.botStackStats.seatedBy.ring).toBe(15_000);
    expect(w.m.botStackStats.seatedChips).toBe(15_000);
    expect(w.m.liveBotChips()).toBe(15_000);
    expect(w.took()).toBe(0);
    expect([...w.stubbed].filter((x) => /noteBot|liveBotChips|botStackStats/.test(x))).toEqual([]);
  });

  it('(3) removal reasons: strip, seat_taken (between hands and at a planned commit), trim, quick_end; a tournament / Spin & Go table counts nothing', () => {
    const w = world({ tournamentTables: ['tour'], prizeTables: ['sng'] });
    // trim
    const t1 = w.mk('t1', 1000);
    t1.sitDown(0, 'Human', 1000, 'p-h', false);
    w.m.fillWithAI(t1, 't1', 'hard', 6);
    expect(bots(t1)).toHaveLength(5);
    bots(t1)[0].chipCount = 1300;
    w.m.trimExcessAI(t1, 't1', 4);
    expect(bots(t1)).toHaveLength(3);
    expect(w.m.botStackStats.removedBy.trim).toBe(1300 + 1000);
    // seat_taken, between hands
    expect(w.m.takeAiSeatForJoin(t1, 't1')).toBeGreaterThanOrEqual(0);
    expect(w.m.botStackStats.removedBy.seat_taken).toBe(1000);
    // seat_taken at a planned commit (mid-hand: a folded bot with nothing in)
    const t2 = w.mk('t2', 1000);
    for (let i = 0; i < 4; i++) t2.sitDown(i, `B${i}`, 1000, `ai-${i}`, true);
    t2.sitDown(4, 'Human', 1000, 'p-h', false);
    expect(t2.startNewHand()).toBe(true);
    const folder = t2.activeSeatIndex;
    expect(t2.seats[folder].isAI && t2.seats[folder].totalInvestedThisHand === 0).toBe(true);
    expect(t2.playerFold(folder)).toBe(true);
    const before = w.m.botStackStats.removedBy.seat_taken;
    expect(w.m.takePlannedAiSeat(t2, 't2', folder)).toBe(true);
    expect(w.m.botStackStats.removedBy.seat_taken - before).toBe(1000);
    // strip (the last human left)
    const t3 = w.mk('t3', 2000);
    for (let i = 0; i < 3; i++) t3.sitDown(i, `B${i}`, 2000, `ai-${i}`, true);
    w.m.stripBotsWhenNoHumans('t3', t3);
    expect(bots(t3)).toHaveLength(0);
    expect(w.m.botStackStats.removedBy.strip).toBe(6000);
    // quick_end: a Heads-Up game the bot won (the human busted) — the bot's seat goes with its 2,000
    const q = w.mk('hu', 1000);
    q.sitDown(0, 'Human', 1000, 'p-h', false); q.seats[0].chipCount = 0; q.seats[0].eliminated = true;
    q.sitDown(1, 'B1', 2000, 'ai-1', true);
    w.m.registerQuickGame('hu', q, { format: 'headsUp', ownerUserId: 7, ownerName: 'Human', entryFee: 1000 });
    expect(w.m.quickGameEndCheck('hu', 'hand_result')).toBe(true);
    expect(bots(q)).toHaveLength(0);
    expect(w.m.botStackStats.removedBy.quick_end).toBe(2000);
    // tournament / Spin & Go tables: nothing counted either way
    for (const id of ['tour', 'sng']) {
      const t = w.mk(id, 1000);
      for (let i = 0; i < 2; i++) t.sitDown(i, `B${i}`, 1000, `ai-${i}`, true);
      const was = { ...w.m.botStackStats, removedBy: { ...w.m.botStackStats.removedBy }, seatedBy: { ...w.m.botStackStats.seatedBy } };
      w.m.noteBotSeated(id, 1000, 'quick');
      w.m.noteBotStackRemoved(id, t, 0, 'strip');
      expect(w.m.botStackStats.seatedChips).toBe(was.seatedChips);
      expect(w.m.botStackStats.removedChips).toBe(was.removedChips);
    }
    expect(w.m.liveBotChips()).toBe(bots(t1).reduce((a, s) => a + s.chipCount, 0) + bots(t2).reduce((a, s) => a + s.chipCount + s.totalInvestedThisHand, 0));
  });

  it('(4) identity over a scripted sequence — fill, 3 hands humans net +700 from bots, a reload, a strip: seated + minted - burned - removed - live === 700', () => {
    const w = world();
    const t = w.mk('ring', 5000);
    t.sitDown(0, 'Human', 5000, 'p-h', false);
    w.m.fillWithAI(t, 'ring', 'hard', 4);
    const [b1, b2, b3] = bots(t);
    const human = t.seats[0];
    const move = (from: any, to: any, chips: number) => { from.chipCount -= chips; to.chipCount += chips; };
    move(b1, human, 300);            // hand 1: +300
    move(b2, human, 600);            // hand 2: +600
    move(human, b3, 200);            // hand 3: -200
    const humanNet = human.chipCount - 5000;
    expect(humanNet).toBe(700);
    expect(w.took()).toBe(700);
    move(b1, b2, b1.chipCount);      // bot-to-bot: b1 busts (no human flow)
    expect(w.m.reloadAndCapBotStacks(t, 'ring', false)).toMatchObject({ reloaded: 1, minted: 5000 });
    expect(w.took()).toBe(700);
    t.standUp(0);                    // the human leaves with his stack (a wallet cash-out, not a bot flow)
    w.m.stripBotsWhenNoHumans('ring', t);
    expect(w.m.liveBotChips()).toBe(0);
    expect(w.m.botStackStats.removedBy.strip).toBe(5000 + (5000 - 600 + 4700) + 5200);
    const s = w.m.botStackStats;
    expect(s.seatedChips + s.minted - s.burned - s.removedChips - w.m.liveBotChips()).toBe(700);
  });

  it('(4b) the identity holds MID-HAND (bots\' chips in the pot are still theirs) and after a real hand equals the humans\' net', () => {
    const w = world();
    const t = w.mk('ring', 5000);
    t.sitDown(0, 'Human', 5000, 'p-h', false);
    w.m.fillWithAI(t, 'ring', 'hard', 4);
    expect(t.startNewHand()).toBe(true);
    expect(w.took()).toBe(0);                    // blinds posted: nothing has changed hands yet
    for (let g = 0; g < 20 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.took()).toBe(t.seats[0].chipCount - 5000);
  });
});

describe('E11 — per-format quick-game counts and the Spin & Go house sums', () => {
  it('(5) byFormat started / humanWins, Spin & Go fees in, prizes out, refunds', async () => {
    const w = world({ prizeTables: ['sng1', 'sng2'] });
    const q = w.m.quickGameStats;
    // an All-In or Fold game the human wins
    const a = w.mk('aof', 1000);
    a.sitDown(0, 'Human', 6000, 'p-h', false);
    a.sitDown(1, 'B1', 1000, 'ai-1', true); a.seats[1].chipCount = 0; a.seats[1].eliminated = true;
    w.m.registerQuickGame('aof', a, { format: 'allInOrFold', ownerUserId: 7, ownerName: 'Human', entryFee: 1000 });
    expect(q.byFormat.allInOrFold).toEqual({ started: 1, humanWins: 0 });
    expect(w.m.quickGameEndCheck('aof', 'hand_result')).toBe(true);
    expect(q.byFormat.allInOrFold).toEqual({ started: 1, humanWins: 1 });
    // a Heads-Up game the bot wins
    const h = w.mk('hu', 1000);
    h.sitDown(0, 'Human', 1000, 'p-h', false); h.seats[0].chipCount = 0; h.seats[0].eliminated = true;
    h.sitDown(1, 'B1', 2000, 'ai-1', true);
    w.m.registerQuickGame('hu', h, { format: 'headsUp', ownerUserId: 7, ownerName: 'Human', entryFee: 1000 });
    expect(w.m.quickGameEndCheck('hu', 'hand_result')).toBe(true);
    expect(q.byFormat.headsUp).toEqual({ started: 1, humanWins: 0 });
    // a Spin & Go the human wins at 3x: fee in 500, prize out 1,500
    const s1 = w.mk('sng1', 500);
    s1.sitDown(0, 'Human', 1500, 'p-h', false);
    s1.sitDown(1, 'B1', 500, 'ai-1', true); s1.seats[1].chipCount = 0; s1.seats[1].eliminated = true;
    w.m.registerQuickGame('sng1', s1, { format: 'spinGo', ownerUserId: 7, ownerName: 'Human', entryFee: 500, multiplier: 3 });
    expect(w.m.quickGameEndCheck('sng1', 'hand_result')).toBe(true);
    w.runTimers();                                // the result (finishQuickGame) runs after its delay
    expect(q.byFormat.spinGo).toEqual({ started: 1, humanWins: 1 });
    expect(q.spinGoFeesIn).toBe(500);
    expect(q.spinGoPrizesOut).toBe(1500);
    // a Spin & Go refunded (interrupted): fee in 500, refunded 500
    const s2 = w.mk('sng2', 500);
    s2.sitDown(0, 'Human', 500, 'p-h', false);
    w.m.registerQuickGame('sng2', s2, { format: 'spinGo', ownerUserId: 7, ownerName: 'Human', entryFee: 500, multiplier: 2 });
    await w.m.refundQuickEntryFee('sng2', w.quickGames.get('sng2'), 'test');
    expect(q.spinGoFeesIn).toBe(1000);
    expect(q.spinGoRefunded).toBe(500);
    expect(q.byFormat.spinGo.started).toBe(2);
    // the existing totals still count as before
    expect(q.started).toBe(4);
    expect(q.humanWins).toBe(2);
    expect(q.spinGoPrizes).toBe(1);
    expect(q.entryFeesRefunded).toBe(1);
    // a club challenge counts started, never humanWins (two humans)
    const c = w.mk('ch', 1000);
    w.m.registerQuickGame('ch', c, { format: 'challenge', ownerUserId: null, ownerName: '', entryFee: 0 });
    expect(q.byFormat.challenge).toEqual({ started: 1, humanWins: 0 });
  });
});

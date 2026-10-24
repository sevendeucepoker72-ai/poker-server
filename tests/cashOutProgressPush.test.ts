/**
 * 2026-10-24 (owner: "when people win the pot the chips just disappear and dont
 * go in peoples banks") — after a cash-out credit COMMITS, the account's fresh
 * wallet is pushed ('playerProgress') to its live sockets.
 *
 * No cash-out path pushed anything: the .online lobby bank is set only by
 * 'playerProgress', so after a player won pots and left, it kept showing the
 * wallet minus the buy-in (the whole stack looked gone) until a reload.
 * F1 / F2 fail on 5b8ad77 (bank 40,000 while users.chips is 50,100 / 60,000).
 *
 * Harness: the REAL src/index.ts leave path (leaveTable handler ->
 * handlePlayerLeave -> teardownSeat -> creditSeatStackToWallet), the deferred
 * after-hand removal (processPendingSeatRemovals) and the progress push
 * (refreshWalletAfterCashOut -> pushProgressToUser), sliced + transpiled; a
 * real PokerTable; a fake users table.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { slice, fnSrc, load, SEAT_TEARDOWN_SRC } from './helpers/indexSource';

const CODE = [
  SEAT_TEARDOWN_SRC,
  fnSrc('function processPendingSeatRemovals('),
  fnSrc('function endStaleSessionsAtSeat('),
  fnSrc('function creditSeatStackToWallet('),
  fnSrc('function handlePlayerLeave('),
  fnSrc('function sendProgressToPlayer('),
  slice('const economyStats = {', '};\n'),
  fnSrc('function refreshWalletAfterCashOut('),
  fnSrc('function socketIdsOfUser('),
  fnSrc('async function pushProgressToUser('),
  'function wire(socket) {\n  ' + slice("socket.on('leaveTable', async () => {", '\n  });') + '\n}\n',
].join('\n');

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const HERO = 1, VILLAIN = 2, START = 50_000, BUY_IN = 10_000;

function world(opts: { failCredits?: boolean } = {}) {
  const db = new Map<number, number>([[HERO, START - BUY_IN], [VILLAIN, START - BUY_IN]]);
  const table = new PokerTable({ tableId: 't1', tableName: 'T', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 1000 } as any);
  table.sitDown(0, 'Hero', BUY_IN, 'user_1');
  table.sitDown(1, 'Villain', BUY_IN, 'user_2');
  const emitted: Array<[string, any]> = [];
  const handlers: Record<string, any> = {};
  const socket: any = { id: 'sockHero', connected: true, emit: (ev: string, d: any) => { emitted.push([ev, d]); }, leave() {}, join() {}, on(ev: string, fn: any) { handlers[ev] = fn; } };
  const authSessions = new Map<string, any>([['sockHero', { userId: HERO, username: 'hero' }]]);
  const playerSessions = new Map<string, any>([
    ['sockHero', { socketId: 'sockHero', tableId: 't1', seatIndex: 0, playerName: 'Hero', playerId: 'user_1', sittingOut: false }],
    ['sockVillain', { socketId: 'sockVillain', tableId: 't1', seatIndex: 1, playerName: 'Villain', playerId: 'user_2', sittingOut: false }],
  ]);
  const audits: Array<{ action: string; d: any }> = [];
  const rec = { playerId: 'user_1', userId: HERO, hydrated: true, chips: db.get(HERO)! };
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 't1' ? table : undefined) },
    io: { to: () => ({ emit() {} }), sockets: { sockets: new Map([['sockHero', socket]]) } },
    authSessions, playerSessions,
    multiTableSessions: new Map(), spectators: new Map(), quickTables: new Set(), ipSeatedSlots: new Map(),
    lastSentState: new Map(), lastSentJson: new Map(), lastEmoteTime: new Map(), lastReactionTime: new Map(), lastChatTime: new Map(),
    pendingSeatRemovalAfterHand: new Map(), sitOutTracker: new Map(), reservedSeats: new Map(),
    aiProfiles: new Map(), aiTimeouts: new Map(), pendingAutoStartTimers: new Map(), MAX_SEATS: 9,
    GamePhase,
    isTournamentTable: () => false, isPrizeFormatTable: () => false,
    shutdownFlushActive: () => false, scheduleAIAction() {}, syncSitOutToTable() {}, broadcastGameState() {}, releaseSeatedSlot() {},
    Sentry: null, console: { log() {}, warn() {}, error() {} },
    auditLog: (_actor: string, action: string, d: any) => { audits.push({ action, d }); },
    // authManager.addChipsToUser semantics: a pg error is swallowed and returned as false.
    addChipsToUser: async (uid: number, amount: number) => {
      if (opts.failCredits) return false;
      db.set(uid, (db.get(uid) || 0) + amount); return true;
    },
    userProgressKey: (uid: number) => `user_${uid}`,
    readWallet: async (uid: number) => ({ chips: db.get(uid) ?? 0, stars: 0, scratchCardsAvailable: 0, loginStreak: 0, lastLoginClaimDate: null }),
    progressionManager: {
      getProgress: (pid: string) => (pid === 'user_1' ? rec : undefined),
      userRecord: (uid: number) => (uid === HERO ? rec : undefined),
      applyWallet: (uid: number, w: any) => { if (uid === HERO) rec.chips = w.chips; },
      getClientProgress: () => ({ userId: HERO, hydrated: true, chips: rec.chips }),
      consumeEvents: () => [],
    },
  };
  const { exports: api, stubbed } = load(CODE, scope, '{ wire, processPendingSeatRemovals, sendProgressToPlayer, economyStats }');
  api.wire(socket);
  // The .online client (App.jsx 'playerProgress' handler): the lobby bank = the last playerProgress.chips.
  const client = { bank: START };
  const apply = () => { for (const [ev, d] of emitted.splice(0)) if (ev === 'playerProgress' && Number.isFinite(d?.chips)) client.bank = d.chips; };
  return { db, table, handlers, api, client, apply, audits, stubbed };
}

function heroWinsByFold(table: any) {
  for (let g = 0; g < 50 && table.currentPhase !== GamePhase.HandComplete; g++) {
    const s = table.activeSeatIndex; if (s < 0) break;
    if (s === 1) table.playerFold(1);
    else if (table.currentBetToMatch > (table.seats[0].currentBet || 0)) table.playerCall(0); else table.playerCheck(0);
  }
}

describe('a cash-out credit refreshes the lobby bank (playerProgress with the credited wallet)', () => {
  test('F1: win a pot, leave between hands -> the lobby bank equals users.chips', async () => {
    const w = world();
    w.api.sendProgressToPlayer('sockHero'); await flush(); w.apply();          // join push: 40,000
    expect(w.client.bank).toBe(START - BUY_IN);
    expect(w.table.startNewHand()).toBe(true);
    heroWinsByFold(w.table);
    expect(w.table.seats[0].chipCount).toBeGreaterThan(BUY_IN);                // he won the pot
    await w.handlers.leaveTable(); await flush(); w.apply();
    expect(w.db.get(HERO)).toBeGreaterThan(START);                             // banked
    expect(w.client.bank).toBe(w.db.get(HERO));                                // and shown (was 40,000)
    expect(w.audits.filter((a) => a.action === 'CASH_OUT')).toHaveLength(1);
    expect(w.api.economyStats.cashOutPushes).toBe(1);
    for (const name of ['pushProgressToUser', 'refreshWalletAfterCashOut', 'creditSeatStackToWallet', 'readWallet']) expect(w.stubbed.has(name)).toBe(false);
  });

  test('F2: all-in, leave mid-hand, the all-in wins -> after the deferred credit the bank equals users.chips', async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const w = world();
      w.api.sendProgressToPlayer('sockHero'); await flush(); w.apply();
      w.table.startNewHand();
      let shoved = false;
      for (let g = 0; g < 10 && !shoved; g++) {
        const s = w.table.activeSeatIndex;
        if (s === 0) { w.table.playerAllIn(0); shoved = true; }
        else if (s === 1) { if (w.table.currentBetToMatch > (w.table.seats[1].currentBet || 0)) w.table.playerCall(1); else w.table.playerCheck(1); }
        else break;
      }
      if (!shoved || w.table.activeSeatIndex !== 1) continue;
      await w.handlers.leaveTable(); await flush();
      w.table.playerCall(1);
      if (w.table.seats[0].chipCount <= BUY_IN) continue;                     // want the winning all-in
      w.api.processPendingSeatRemovals('t1'); await flush(); w.apply();       // index.ts 'handResult' listener
      expect(w.db.get(HERO)).toBeGreaterThan(START);
      expect(w.client.bank).toBe(w.db.get(HERO));
      return;
    }
    throw new Error('no winning all-in in 40 deals');
  });

  test('a FAILED credit pushes nothing (the bank is never shown chips that are not there) and is audited CASH_OUT_FAILED', async () => {
    const w = world({ failCredits: true });
    w.api.sendProgressToPlayer('sockHero'); await flush(); w.apply();
    w.table.startNewHand();
    heroWinsByFold(w.table);
    await w.handlers.leaveTable(); await flush(); w.apply();
    expect(w.db.get(HERO)).toBe(START - BUY_IN);
    expect(w.client.bank).toBe(START - BUY_IN);
    expect(w.api.economyStats.cashOutPushes).toBe(0);
    expect(w.audits.filter((a) => a.action === 'CASH_OUT_FAILED')).toHaveLength(1);
  });
});

describe('wiring in src/index.ts', () => {
  test('every direct cash-out credit refreshes the wallet only on success; the refill "not broke" answer does too', () => {
    expect(fnSrc('function creditSeatStackToWallet(')).toContain('try { refreshWalletAfterCashOut(userId); } catch { /* display only */ }');
    expect(fnSrc('function endCashReservation(')).toContain('if (ok) { try { refreshWalletAfterCashOut(userId); } catch { /* display only */ } }');
    const quick = fnSrc('function cleanupQuickTable(');
    expect(quick).toContain("reason: 'quick_game_end' });\n                if (ok) { try { refreshWalletAfterCashOut(owner.userId); } catch { /* display only */ } }");
    expect(slice("socket.on('adminForceCloseTable'", '\n  });')).toContain("reason: 'admin_force_close' });\n                  if (ok) { try { refreshWalletAfterCashOut(owner.userId); } catch { /* display only */ } }");
    expect(slice("error: 'not_broke', chips: current });", 'return;')).toContain('refreshWalletAfterCashOut(ctx.userId);');
  });

  test('a failed cash-out, the insurance settlements and a bug refund get the durable audit row', () => {
    const durable = slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);');
    for (const a of ['CASH_OUT_FAILED', 'INSURANCE_PAYOUT', 'INSURANCE_COLLECT', 'INSURANCE_VOID', 'BUG_REFUND']) expect(durable).toContain(`'${a}'`);
  });
});

/**
 * Bots review 2026-11-04 (economy-farming E3, handler part) — All-In or Fold is
 * dealt at blinds 20/40, so its 1,000 stack is 25 BB: the deepest stack the
 * bots' push/fold table covers (PUSH_FOLD_MAX_BB = 25). At 0dc1b96 the table
 * was 10/20 (50 BB) and every bot decision was clamped to 25 BB (measured: a
 * tight shover netted +37% to +48% of the buy-in per game).
 *
 * The REAL socket.on('quickAllInOrFold') handler, sliced from src/index.ts. The
 * AOF_SMALL_BLIND / AOF_BIG_BLIND constants live INSIDE the handler, so the
 * slice carries them. Everything else the handler does is unchanged: the 1,000
 * deduct and its QUICK_BUYIN_DEDUCT audit, the bot difficulties, the quick-game
 * registration and the All-In or Fold mark. (The Spin & Go odds — part 1 of
 * this group's test — are the economy lane's tests/econSpinGoOdds.test.ts.)
 *
 * Fails on 0dc1b96: createQuickTable was called with (…, 10, 20, 1000).
 */
import { PokerTable } from '../src/game/PokerTable';
import { slice, fnSrc, handlerSrc, load } from './helpers/indexSource';

const ALICE = 101;

function world() {
  const tables = new Map<string, PokerTable>();
  const created: unknown[][] = [];
  const profilesAsked: string[] = [];
  const deducted: Array<[number, number]> = [];
  const audits: Array<[string, string, any]> = [];
  const registered: Array<[string, any]> = [];
  const allInOrFoldTables = new Set<string>();
  let n = 0;
  const scope: Record<string, unknown> = {
    tableManager: {
      createQuickTable: (...args: unknown[]) => {
        created.push(args);
        const [name, maxPlayers, sb, bb, minBuyIn] = args as [string, number, number, number, number];
        const id = `qt${++n}`;
        tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn, maxBuyIn: minBuyIn * 10, maxPlayers } as any));
        return id;
      },
      getTable: (id: string) => tables.get(id),
    },
    quickPlayRateLimited: () => false, blockedByMaintenance: () => false, assertPlayable: async () => null,
    buyInSocketGone: async () => false, seatNameForSocket: (_s: unknown, name: string) => name,
    playerSessions: new Map(), authSessions: new Map([['S1', { userId: ALICE, username: 'alice.player' }]]),
    ensureChipsForBuyIn: async () => 50_000,
    deductChips: async (uid: number, amount: number) => { deducted.push([uid, amount]); return true; },
    auditLog: (actor: string, action: string, d: any) => audits.push([actor, action, d]),
    quickTables: new Set<string>(), uuidv4: () => `u${++n}`,
    detachSocketFromOtherTables() {}, progressionManager: { getOrCreateProgress() {} }, ensureTableProgressListener() {},
    aiProfiles: new Map(),
    generateRandomProfile: (d: string) => { profilesAsked.push(d); return { botName: `Bot${profilesAsked.length}`, difficulty: d }; },
    allInOrFoldTables,
    registerQuickGame: (id: string, _t: unknown, state: any) => registered.push([id, state]),
    broadcastGameState() {}, sendProgressToPlayer() {}, scheduleAIAction() {},
    isTournamentTable: () => false, isPrizeFormatTable: () => false,
    console: { log() {}, warn() {}, error() {} },
  };
  const E10 = [slice('const botStackStats = {', '\n};\n'), fnSrc('function noteBotSeated(')].join('\n');
  const { exports: m, stubbed } = load(`${E10}\nfunction wire(socket) {\n${handlerSrc('quickAllInOrFold', '\n  });\n')}\n}`, scope, '{ wire, botStackStats }');
  const handlers: Record<string, (...a: any[]) => any> = {};
  const emitted: Array<[string, any]> = [];
  const socket = { id: 'S1', on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit: (ev: string, p: any) => emitted.push([ev, p]), join() {} };
  m.wire(socket);
  return { m, stubbed, handlers, emitted, tables, created, profilesAsked, deducted, audits, registered, allInOrFoldTables };
}

describe('E3 — All-In or Fold deals at 20/40: a 1,000 stack is 25 BB', () => {
  it('the table is created with (\'All-In or Fold\', 6, 20, 40, 1000); everything else the handler does is unchanged', async () => {
    const w = world();
    await w.handlers.quickAllInOrFold({ playerName: 'Alice' });
    expect(w.created).toEqual([['All-In or Fold', 6, 20, 40, 1000]]);
    const [tableId] = [...w.tables.keys()];
    const t = w.tables.get(tableId)!;
    expect(t.config.bigBlind).toBe(40);
    expect(t.config.minBuyIn / t.config.bigBlind).toBe(25);
    // unchanged: the buy-in, its audit, the bots, the registration, the format mark, the deal
    expect(w.deducted).toEqual([[ALICE, 1000]]);
    expect(w.audits).toContainEqual(['alice.player', 'QUICK_BUYIN_DEDUCT', { mode: 'allInOrFold', buyIn: 1000 }]);
    expect(w.profilesAsked).toEqual(['easy', 'medium', 'medium', 'hard', 'easy']);
    expect(t.seats.slice(0, 6).map((s) => [s.isAI, s.chipCount + s.totalInvestedThisHand])).toEqual([[false, 1000], [true, 1000], [true, 1000], [true, 1000], [true, 1000], [true, 1000]]);
    // the first hand is dealt at 20/40: the blinds posted are exactly those
    expect(t.seats.map((s) => s.totalInvestedThisHand).filter((x) => x > 0).sort((a, b) => a - b)).toEqual([20, 40]);
    expect(w.registered).toEqual([[tableId, { format: 'allInOrFold', ownerUserId: ALICE, ownerName: 'Alice', entryFee: 1000 }]]);
    expect(w.allInOrFoldTables.has(tableId)).toBe(true);
    expect(t.isHandInProgress()).toBe(true);
    expect(w.emitted).toContainEqual(['quickGameStarted', { type: 'allInOrFold' }]);
    // E10 — the five bots' stacks are counted as seated quick-table chips
    expect(w.m.botStackStats.seatedBy.quick).toBe(5000);
    expect(w.m.botStackStats.seatedChips).toBe(5000);
    expect([...w.stubbed].filter((x) => /AOF_|createQuickTable|deductChips|registerQuickGame|allInOrFoldTables|generateRandomProfile|noteBotSeated/.test(x))).toEqual([]);
  });

  it('GUARD — the blinds are named constants inside the handler (the slice carries them)', () => {
    const h = handlerSrc('quickAllInOrFold', '\n  });\n');
    expect(h).toContain('const AOF_SMALL_BLIND = 20;');
    expect(h).toContain('const AOF_BIG_BLIND = 40;');
    expect(h).toContain('AOF_SMALL_BLIND,\n      AOF_BIG_BLIND,\n      AOF_BUYIN');
  });
});

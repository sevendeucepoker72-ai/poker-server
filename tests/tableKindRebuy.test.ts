/**
 * R1 (2026-10-11) — contract #2 (TOURNEY-1 server part): every per-player game
 * state says what kind of table it is (`tableKind`) and whether a rebuy is
 * allowed there (`rebuyAllowed`) — ALWAYS present — and the `rebuy` handler
 * refuses with the stable code `rebuy_not_allowed` at tournament and quick
 * tables (and club challenges) BEFORE anything is deducted.
 *
 * Live harm: poker-3d's auto-rebuy topped a Spin & Go stack up with
 * minBuyIn || 5000; the Spin & Go settlement zeroes the winner's stack and pays
 * the multiplier prize, so the top-up was destroyed (users 1541 + 4481 lost
 * 5,000 each).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { cardToString } from '../src/game/Card';
import { slice, fnSrc, handlerSrc, load, flush } from './helpers/indexSource';

const KIND = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', "    code: 'rebuy_not_allowed',\n  };\n}\n");
const REBUY = handlerSrc('rebuy', '\n  })(); });');

function world() {
  const tables = new Map<string, PokerTable>();
  const tournament = new Set<string>();
  const quickTables = new Set<string>();
  const spinGoMultipliers = new Map<string, number>();
  const careerTables = new Map<string, any>();
  const allInOrFoldTables = new Set<string>();
  const challengeTables = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const authSessions = new Map<string, any>();
  const deducts: Array<[number, number]> = [];
  const scope: Record<string, unknown> = {
    isTournamentTable: (id: string) => tournament.has(id),
    quickTables, spinGoMultipliers, careerTables, allInOrFoldTables, challengeTables,
    tableManager: { getTable: (id: string) => tables.get(id) },
    playerSessions, authSessions,
    assertPlayable: async () => null, emitPlayRefusal() {}, buyInSocketGone: async () => false,
    ensureChipsForBuyIn: async () => 1_000_000,
    deductChips: async (uid: number, n: number) => { deducts.push([uid, n]); return true; },
    addChipsToUser: async () => true, auditLog() {}, broadcastGameState() {},
    log: { debug() {}, info() {}, warn() {} },
  };
  const code = KIND + `\nfunction registerRebuy(socket) {\n${REBUY}\n}\n`;
  const { exports: m } = load(code, scope, '{ tableKindOf, rebuyAllowedAt, rebuyRefusalAt, privateTableIds, clubTableIds, registerRebuy }');
  const mkTable = (id: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 500 } as any);
    tables.set(id, t);
    return t;
  };
  return { m, scope, tables, tournament, quickTables, spinGoMultipliers, careerTables, allInOrFoldTables, challengeTables, playerSessions, authSessions, deducts, mkTable };
}

describe('tableKind / rebuyAllowed', () => {
  it('every kind of table, and whether a rebuy is allowed there', () => {
    const w = world();
    w.tournament.add('tour'); w.spinGoMultipliers.set('sng', 3); w.quickTables.add('sng');
    w.careerTables.set('car', { venue: 1, stage: 1 }); w.quickTables.add('car');
    w.allInOrFoldTables.add('aof'); w.quickTables.add('aof');
    w.quickTables.add('hu');
    w.m.privateTableIds.add('home'); w.m.clubTableIds.add('club'); w.challengeTables.set('chal', { challengeId: 1 });
    const want: Array<[string, string, boolean]> = [
      ['lobby', 'cash', true], ['home', 'private', true], ['club', 'club', true],
      ['tour', 'tournament', false], ['sng', 'spingo', false], ['car', 'career', false], ['aof', 'aof', false], ['hu', 'headsup', false],
      ['chal', 'club', false],   // a club CHALLENGE is a freezeout
    ];
    for (const [id, kind, rebuy] of want) {
      expect([id, w.m.tableKindOf(id), w.m.rebuyAllowedAt(id)]).toEqual([id, kind, rebuy]);
      expect([id, w.m.rebuyRefusalAt(id)?.code ?? null]).toEqual([id, rebuy ? null : 'rebuy_not_allowed']);
    }
    expect(w.m.rebuyRefusalAt('tour').message).toBe('Rebuys are disabled in tournaments');
  });

  it('the per-player game state ALWAYS carries tableKind, rebuyAllowed, minBuyIn and insuranceQuote (Spin & Go: rebuy not allowed)', () => {
    const quick = new Set(['sng']);
    const code = KIND + fnSrc('function getVariantInfo(') + fnSrc('function getGameStateForPlayer(');
    const { exports: g } = load(code, {
      isTournamentTable: () => false, quickTables: quick, spinGoMultipliers: new Map([['sng', 2]]), careerTables: new Map(),
      allInOrFoldTables: new Set(), challengeTables: new Map(), playerSessions: new Map(), progressionManager: { getProgress: () => null },
      turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
      MAX_SEATS: 9, GamePhase, cardToString, tournamentIdOfTable: () => undefined, insuranceQuoteForSeat: () => null,
    }, '{ getGameStateForPlayer }');
    const t = new PokerTable({ tableId: 'sng', tableName: 'Spin', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 500 } as any);
    t.sitDown(0, 'p', 500, 'p0', false);
    for (const seat of [0, -1]) {
      const s = g.getGameStateForPlayer(t, seat);
      expect(s).toMatchObject({ tableKind: 'spingo', rebuyAllowed: false, minBuyIn: 500, maxBuyIn: 5000, insuranceQuote: null });
    }
  });
});

describe('the rebuy handler refuses rebuy_not_allowed before any deduction', () => {
  const setup = (kind: 'sng' | 'tour' | 'hu' | 'car' | 'aof' | 'chal' | 'lobby') => {
    const w = world();
    const t = w.mkTable(kind);
    if (kind === 'sng') { w.quickTables.add('sng'); w.spinGoMultipliers.set('sng', 2); }
    if (kind === 'tour') w.tournament.add('tour');
    if (kind === 'hu') w.quickTables.add('hu');
    if (kind === 'car') { w.quickTables.add('car'); w.careerTables.set('car', {}); }
    if (kind === 'aof') { w.quickTables.add('aof'); w.allInOrFoldTables.add('aof'); }
    if (kind === 'chal') w.challengeTables.set('chal', { challengeId: 1 });
    expect(t.sitDown(0, 'Hero', 500, 'p-hero', false)).toBe(true);
    t.seats[0].chipCount = 100;                                       // short — a rebuy would top it up
    w.playerSessions.set('S1', { socketId: 'S1', tableId: kind, seatIndex: 0, playerName: 'Hero', playerId: 'p-hero' });
    w.authSessions.set('S1', { userId: 7, username: 'hero' });
    const emitted: Array<[string, any]> = [];
    const handlers: Record<string, (d?: any) => void> = {};
    w.m.registerRebuy({ id: 'S1', emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { handlers[ev] = fn; } });
    return { w, t, emitted, handlers };
  };

  it.each(['sng', 'tour', 'hu', 'car', 'aof', 'chal'] as const)('%s: refused with the stable code, wallet untouched, stack unchanged', async (kind) => {
    const { w, t, emitted, handlers } = setup(kind);
    handlers.rebuy({ amount: 5000 });
    await flush();
    expect(emitted).toContainEqual(['error', expect.objectContaining({ code: 'rebuy_not_allowed' })]);
    expect(emitted.some(([ev]) => ev === 'rebuyComplete')).toBe(false);
    expect(w.deducts).toEqual([]);
    expect(t.seats[0].chipCount).toBe(100);
  });

  it('control — a cash table still tops up (deducted once, rebuyComplete)', async () => {
    const { w, t, emitted, handlers } = setup('lobby');
    handlers.rebuy({ amount: 500 });
    await flush();
    expect(w.deducts).toEqual([[7, 400]]);
    expect(t.seats[0].chipCount).toBe(500);
    expect(emitted).toContainEqual(['rebuyComplete', { success: true, newStack: 500, added: 400 }]);
  });

  it('wiring: the refusal comes before the balance read and the deduct', () => {
    const at = REBUY.indexOf('const rebuyRefusal = rebuyRefusalAt(session.tableId);');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(REBUY.indexOf('ensureChipsForBuyIn('));
    expect(at).toBeLessThan(REBUY.indexOf('deductChips('));
  });
});

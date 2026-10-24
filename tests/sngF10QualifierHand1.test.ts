/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F10, review fix-up)
 * — a QUALIFIER table keeps the 500 ms orphan auto-act on HAND 1 too.
 *
 * F10 skips the 500 ms orphan act at NON-qualifier tournament tables
 * (absentShortClockScope = isTournamentTable && !qualifierIdOfTable). In the
 * qualifier start path used when the early rooms have not opened
 * (tickQualifierAutoStart -> startQualifierTournament with the default deal),
 * hand 1 is dealt and broadcast BEFORE `qt.tournamentId` is set: during that
 * broadcast qualifierIdOfTable returns null, the table looked like a Sit & Go,
 * and a registrant seated absent who was first to act waited the full 30 s
 * clock instead of ~0.5 s. Nothing broadcasts again after the id is set.
 *
 * Fix: startQualifierTournament marks its tournament (markQualifierEngine-
 * Tournament) right after creating it, before any table is dealt;
 * absentShortClockScope treats a marked tournament's tables as qualifier
 * tables. The early-rooms path and every non-qualifier path are unchanged.
 *
 * The REAL startQualifierTournament, bootstrapTournamentTables, the F10 block
 * and broadcastGameState's auto-act block (sliced from src/index.ts), the REAL
 * TournamentManager and PokerTable.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { qualifierBlindLevels } from '../src/game/qualifierSchedule';
import { slice, fnSrc, load } from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };
const AUTO_ACT_BLOCK = slice("  // Auto-fold sitting-out players when it's their turn\n  if (table.isHandInProgress()) {", '      }, 500);\n    }\n  }\n');

function world(opts: { registryHasTournamentId?: boolean; sitAndGo?: boolean } = {}) {
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  const qualifierTournaments = new Map<string, any>([['Q-weekly', { qualifierName: 'Weekly', players: [], status: 'starting' }]]);
  const acted: Array<[string, number]> = [];
  let created = 0;
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, fastModeTables: new Map(), qualifierBlindLevels,
    playerSessions: new Map(), multiTableSessions: new Map(), reservedSeats: new Map(), SEAT_RESERVE_MS: 6 * 3600_000,
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
    tableManager: {
      createQuickTable: (name: string, seats: number, sb: number, bb: number, buyIn: number) => {
        const id = `T${++created}`;
        tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, minBuyIn: buyIn, maxBuyIn: buyIn * 10, maxPlayers: seats } as any));
        return id;
      },
      getTable: (id: string) => tables.get(id),
    },
    // Every registrant ABSENT at the start (no live socket bound to his seat).
    bindRegistrantSocket: () => '',
    randomInt: () => 0,
    DrawPhases: [],
    seatHasAnySession: () => false, seatHasAnyPlayingSession: () => false,
    autoActForSeat: (tid: string, t: PokerTable, i: number) => { acted.push([tid, i]); t.playerFold(i); return 'fold'; },
    ensureTableProgressListener() {}, scheduleAIAction() {},
    Sentry: null, tournamentBootstrapStats: { tableFailures: 0 }, console: quiet,
  };
  const code = [
    slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
    fnSrc('function qualifierOfTournament('),
    fnSrc('function qualifierIdOfTable('),
    slice('// ===== Absent tournament seat clock (Sit & Go fix-all F10) =====', '// ===== end absent tournament seat clock =====\n'),
    fnSrc('function startQualifierTournament('),
    fnSrc('function bootstrapTournamentTables('),
    // broadcastGameState(tid): the real auto-act block on that table.
    `function broadcastGameState(tableId) {\n  const table = tableManager.getTable(tableId);\n  if (!table) return;\n${AUTO_ACT_BLOCK}\n}`,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ startQualifierTournament, absentShortClockScope, broadcastGameState }');
  const field = Array.from({ length: 4 }, (_, i) => ({ id: `q-${i}`, name: `P${i}`, socketId: `S${i}`, masterId: `m-${i}` }));
  const startQualifier = (startOpts?: any) => {
    const r = m.startQualifierTournament(field, 50_000, false, startOpts);
    // tickQualifierAutoStart sets qt.tournamentId only AFTER startQualifierTournament returns.
    qualifierTournaments.get('Q-weekly').tournamentId = r.tournamentId;
    return r;
  };
  /** A non-qualifier tournament table (a Sit & Go) dealt and broadcast the same way. */
  const startSitAndGo = () => {
    const tid = tm.createTournament({ name: 'Sit & Go X', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, minPlayers: 2, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    const table = new PokerTable({ tableId: 'SNG1', tableName: 'SNG1', smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 1e6, maxPlayers: 9 } as any);
    for (let i = 0; i < 4; i++) table.sitDown(i, `S${i}`, 1500, `s-${i}`, false);
    tables.set('SNG1', table);
    tournamentTables.set('SNG1', tid);
    expect(table.startNewHand()).toBe(true);
    m.broadcastGameState('SNG1');
    return table;
  };
  return { m, stubbed, tables, acted, startQualifier, startSitAndGo, tm };
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('F10 review fix-up — a qualifier table keeps the 500 ms orphan act on hand 1', () => {
  it('the start path that deals at once (tickQualifierAutoStart): the absent first-to-act seat is acted for ~0.5 s into hand 1 (0e71b42: not at all - the full 30 s clock)', () => {
    const w = world();
    const r = w.startQualifier();
    const t = w.tables.get(r.tableIds[0])!;
    expect(t.handNumber).toBe(1);
    const first = t.activeSeatIndex;
    expect(first).toBeGreaterThanOrEqual(0);
    jest.advanceTimersByTime(600);
    expect(w.acted).toEqual([[r.tableIds[0], first]]);
    // and the scope says "qualifier" for the table both before and after the registry names it
    expect(w.m.absentShortClockScope(r.tableIds[0])).toBe(false);
    expect([...w.stubbed].filter((s) => /qualifierEngine|absentShortClock|qualifierIdOfTable|qualifierOfTournament|tournamentIdOfTable/.test(s))).toEqual([]);
  });

  it('control: a Sit & Go (non-qualifier) table still skips the 500 ms act (F10 unchanged)', () => {
    const w = world();
    const t = w.startSitAndGo();
    expect(t.activeSeatIndex).toBeGreaterThanOrEqual(0);
    jest.advanceTimersByTime(600);
    expect(w.acted).toEqual([]);
    expect(w.m.absentShortClockScope('SNG1')).toBe(true);
  });

  it('startQualifierTournament marks its tournament BEFORE it deals (source order)', () => {
    const q = fnSrc('function startQualifierTournament(');
    const mark = q.indexOf('markQualifierEngineTournament(tournamentId)');
    expect(mark).toBeGreaterThan(0);
    expect(mark).toBeLessThan(q.indexOf('bootstrapTournamentTables('));
    expect(mark).toBeLessThan(q.indexOf('tournamentManager.startTournament('));
  });
});

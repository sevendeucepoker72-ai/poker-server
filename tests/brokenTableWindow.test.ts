/**
 * 2026-10-10 (F2) — the ≤5s after a tournament table break.
 *
 * handleTableRebalance deletes the broken table's id from tournamentTables at
 * once, but the table lives on for 5s, and a session can still point at it:
 * the rebalance moves a human's session only through his REGISTRATION socket
 * (TournamentPlayer.socketId — never updated on reconnect), so a player who
 * reconnected once is left on the broken table while his stack is copied to
 * the target table. Before F2, every "is this a tournament seat?" decision
 * that read tournamentTables alone treated the broken table as a CASH table:
 * a disconnect in the window reserved the seat with `tournament:false` and
 * the 6h expiry credited the stack to the wallet — a mint (the stack is still
 * in play on the target table); a leave credited it at once. Broken
 * tournament table ids are now retained (brokenTournamentTables) and every
 * such decision goes through isTournamentTable.
 *
 * REAL src/index.ts source (handleTableRebalance, the main disconnect handler,
 * handlePlayerLeave, creditSeatStackToWallet, the reservation consumers,
 * autoStartNextHand) against the REAL PokerTable and TournamentManager.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { SRC, slice, fnSrc, load, flush } from './helpers/indexSource';

const ALICE = 101;
const SEAT_RESERVE_MS = 6 * 3600_000;

const P = {
  brokenTables: slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  isTournamentReservation: fnSrc('function isTournamentReservation('),
  noteNotCashed: fnSrc('function noteTournamentReservationNotCashed('),
  gateState: slice('const playGateHandStart = {', '\n}\n'),
  rebalanceIsHeld: fnSrc('function tournamentRebalanceIsHeld('),
  creditSeat: fnSrc('function creditSeatStackToWallet('),
  handlePlayerLeave: fnSrc('function handlePlayerLeave(socket: Socket): void {'),
  // P1/P2/P6 (2026-10-10): capacity plan, busted-seat vacating, seat-pointer moves, the idle-table restart.
  helpers: slice('// ===== Tournament rebalance helpers', '// ===== end tournament rebalance helpers =====\n'),
  rebalance: fnSrc('function handleTableRebalance(tournamentId: string): void {'),
  autoStart: fnSrc('function autoStartNextHand(tableId: string): void {'),
  // P4 (2026-10-10): its seat reservation + extra-table cash-out are two functions
  // (shared with the account switch); the handler text is prefixed with them.
  disconnect: slice('function reserveSeatForDeparture(', '\n}\n')
    + slice('function cashOutAdditionalSeatsOnDeparture(', '\n}\n')
    + slice("socket.on('disconnect', async () => {", '\n  });', SRC.lastIndexOf("socket.on('disconnect', async () => {")),
};

function world(over: Partial<typeof P> = {}) {
  const p = { ...P, ...over };
  const tm = new TournamentManager();
  const tid = tm.createTournament({ name: 'F2 Cup', buyIn: 0, prizePool: 0, maxPlayers: 20, startInterval: 0, blindLevels: [{ sb: 50, bb: 100, ante: 0, duration: 600 }] } as any);
  // T1: Alice + 3 (registration sockets reg-*); T2: 5. 9 alive on 2 tables → threshold 9 → T1 (the smaller) breaks.
  const t1 = [['alice', 7000], ['dan', 5000], ['eve', 5000], ['fay', 5000]] as const;
  const t2 = [['gus', 5000], ['hal', 5000], ['ivy', 5000], ['jon', 5000], ['kim', 5000]] as const;
  for (const [n] of [...t1, ...t2]) tm.registerPlayer(tid, `p-${n}`, n, n === 'alice' ? 'S1' : `reg-${n}`, n === 'alice' ? ALICE : undefined);
  tm.startTournament(tid);
  tm.setTableIds(tid, ['T1', 'T2']);
  const tables = new Map<string, PokerTable>();
  const tournamentTables = new Map<string, string>();
  for (const [id, list] of [['T1', t1], ['T2', t2]] as const) {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 50, bigBlind: 100, minBuyIn: 5000, maxBuyIn: 50000, maxPlayers: 9 } as any);
    tables.set(id, t);
    tournamentTables.set(id, tid);
    list.forEach(([n, c], i) => { t.sitDown(i, n, c, `p-${n}`, false, true); tm.setPlayerTable(tid, `p-${n}`, id); });
  }
  const credits: Array<{ uid: number; amount: number }> = [];
  const audits: Array<{ action: string; d: any }> = [];
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const reservedSeats = new Map<number, any>();
  const live = new Map<string, any>();
  const scope: Record<string, unknown> = {
    tournamentTables, tournamentManager: tm,
    tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id) },
    authSessions, playerSessions, reservedSeats, multiTableSessions: new Map(), spectators: new Map(), aiProfiles: new Map(),
    tableProgressListeners: new Set(), sitOutTracker: new Map(), pendingSeatRemovalAfterHand: new Map(), quickTables: new Set(),
    pendingAutoStartTimers: new Map(), aiTimeouts: new Map(), lastSentState: new Map(), lastSentJson: new Map(),
    scheduleAutoStart() {}, broadcastGameState() {}, scheduleAIAction() {}, syncSitOutToTable() {},
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: live } },
    SEAT_RESERVE_MS, DISCONNECT_HANDS_LIMIT: 20, MAX_SEATS: 9, GamePhase,
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    auditLog: (_a: string, action: string, d: any) => { audits.push({ action, d }); },
    saveProgress: async () => true,
    progressionManager: { getClientProgress: () => ({ hydrated: true, xp: 1, level: 1, achievements: [] }) },
    Sentry: null, console: { log() {}, warn() {}, error() {} },
  };
  const code = `
${p.brokenTables}
${p.isTournamentReservation}
${p.noteNotCashed}
${p.gateState}
${p.rebalanceIsHeld}
${p.creditSeat}
${p.handlePlayerLeave}
${p.helpers}
${p.rebalance}
${p.autoStart}
function wire(socket) {
  ${p.disconnect}
}`;
  const { exports: m } = load(code, scope, '{ wire, handleTableRebalance, handlePlayerLeave, creditSeatStackToWallet, isTournamentTable, isTournamentReservation, autoStartNextHand, brokenTournamentTables, noteBrokenTournamentTable }');

  // Alice reconnected ONCE: her live session is S2 (on T1), her registration socket S1 is gone.
  const handlers: Record<string, () => Promise<void>> = {};
  const s2: any = { id: 'S2', connected: true, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit() {}, join() {}, leave() {} };
  m.wire(s2);
  live.set('S2', s2);
  authSessions.set('S2', { userId: ALICE, username: 'alice', masterUserId: 'm-alice' });
  playerSessions.set('S2', { socketId: 'S2', tableId: 'T1', seatIndex: 0, playerName: 'alice', playerId: 'p-alice', sittingOut: false });
  const drop = async () => { s2.connected = false; live.delete('S2'); await handlers.disconnect(); await flush(); };
  const notCashed = () => audits.filter((a) => a.action === 'TOURNAMENT_STACK_NOT_CASHED').map((a) => a.d);
  return { m, tm, tid, tables, tournamentTables, credits, audits, reservedSeats, playerSessions, s2, drop, notCashed, live };
}

/**
 * The break: T1's players copied to T2, T1 out of tournamentTables (alive 5
 * more seconds), Alice's session left on T1. P6 (2026-10-10): the rebalance now
 * moves every LIVE session of a moved player, whatever socket it is on; the
 * window still exists for a session whose socket is going away (gone from the
 * live registry, its 'disconnect' not yet run) — modelled by taking S2 off the
 * registry for the break.
 */
function breakT1(w: ReturnType<typeof world>) {
  w.live.delete('S2');
  w.m.handleTableRebalance(w.tid);
  w.live.set('S2', w.s2);
  expect(w.tournamentTables.has('T1')).toBe(false);
  expect(w.tables.has('T1')).toBe(true);                                  // the ≤5s window
  expect(w.playerSessions.get('S2')).toMatchObject({ tableId: 'T1' });    // not moved (registration socket S1 is dead)
  expect(w.tables.get('T2')!.seats.some((s) => s.playerId === 'p-alice')).toBe(true);   // her stack is in play on T2
  expect(w.tables.get('T1')!.seats[0]).toMatchObject({ state: 'occupied', chipCount: 7000 });
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('F2 — a disconnect / leave in the break window never credits a tournament stack', () => {
  it('disconnect in the window: the reservation is a TOURNAMENT one; at the 6h expiry NOTHING is credited (audited, kept in play on T2)', async () => {
    const w = world();
    breakT1(w);
    expect(w.m.isTournamentTable('T1')).toBe(true);
    await w.drop();
    const r = w.reservedSeats.get(ALICE);
    expect(r).toMatchObject({ tableId: 'T1', tournament: true });
    expect(w.m.isTournamentReservation(r)).toBe(true);
    jest.advanceTimersByTime(5000);                                       // the broken table is removed
    expect(w.tables.has('T1')).toBe(false);
    jest.advanceTimersByTime(SEAT_RESERVE_MS);                            // the reservation expires
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.reservedSeats.has(ALICE)).toBe(false);
    expect(w.notCashed()).toEqual([expect.objectContaining({ userId: ALICE, reason: 'reserve_expiry', seatKept: true })]);
    expect(w.tables.get('T2')!.seats.find((s) => s.playerId === 'p-alice')!.state).toBe('occupied');
  });

  it('leave in the window (handlePlayerLeave on the broken table): nothing credited, audited', async () => {
    const w = world();
    breakT1(w);
    w.m.handlePlayerLeave(w.s2);
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.notCashed()).toEqual([expect.objectContaining({ userId: ALICE, reason: 'handlePlayerLeave', amount: 7000 })]);
  });

  it('creditSeatStackToWallet (ghost-seat cleanup, refused seat, extra-table teardown) on the broken table: nothing credited', async () => {
    const w = world();
    breakT1(w);
    w.m.creditSeatStackToWallet(ALICE, 'alice', 'T1', w.tables.get('T1')!.seats[0], 'ghost_seat_session_scan');
    await flush();
    expect(w.credits).toEqual([]);
    expect(w.notCashed()).toEqual([expect.objectContaining({ reason: 'ghost_seat_session_scan', chips: 7000 })]);
  });

  it('a broken tournament table never deals again (autoStartNextHand returns before the cash branches)', () => {
    const w = world();
    breakT1(w);
    const T1 = w.tables.get('T1')!;
    (T1 as any).currentPhase = GamePhase.HandComplete;                    // the hand left running at the break ended
    const start = jest.spyOn(T1, 'startNewHand');
    w.m.autoStartNextHand('T1');
    expect(start).not.toHaveBeenCalled();
  });

  it('a CASH table is unchanged: a disconnect reserves it as cash and the 6h expiry credits the stack exactly once', async () => {
    const w = world();
    w.tournamentTables.delete('T1');                                      // T1 is a plain cash table here (never broken)
    await w.drop();
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tableId: 'T1', tournament: false });
    jest.advanceTimersByTime(SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });

  it('broken ids are retained longer than a reservation lives, then pruned on a later break', () => {
    const w = world();
    breakT1(w);
    expect(w.m.brokenTournamentTables.get('T1')).toMatchObject({ tournamentId: w.tid });
    jest.setSystemTime(Date.now() + SEAT_RESERVE_MS);                    // a reservation made in the window has ended by now…
    w.m.noteBrokenTournamentTable('T8', 'other');
    expect(w.m.isTournamentTable('T1')).toBe(true);                       // …but the id is still kept
    jest.setSystemTime(Date.now() + 2 * 3600_000);
    w.m.noteBrokenTournamentTable('T9', 'other');                        // a later break prunes it
    expect(w.m.isTournamentTable('T1')).toBe(false);
    expect(w.m.isTournamentTable('T9')).toBe(true);
  });
});

describe('P8 (2026-10-10) — broken-table retention is by TIME, not "until the next break"', () => {
  it('an entry past SEAT_RESERVE_MS + 1h is dropped on its next READ — no later break needed — and /api/health prunes before counting', () => {
    const w = world();
    breakT1(w);
    jest.setSystemTime(Date.now() + SEAT_RESERVE_MS + 30 * 60_000);
    expect(w.m.isTournamentTable('T1')).toBe(true);                        // still within retention
    jest.setSystemTime(Date.now() + 31 * 60_000);
    expect(w.m.brokenTournamentTables.has('T1')).toBe(true);               // nothing has pruned it yet…
    expect(w.m.isTournamentTable('T1')).toBe(false);                       // …the read does
    expect(w.m.brokenTournamentTables.has('T1')).toBe(false);
    expect(SRC).toContain('pruneBrokenTournamentTables(); // P8 — brokenTablesRetained counts only entries still retained');
    expect(slice('function sweepTournamentRebalances(', '\n}\n')).toContain('pruneBrokenTournamentTables(); // P8');
    expect(SRC).toContain('setInterval(sweepTournamentRebalances, 5000);');
  });
});

describe('F2 — CONTROL: deciding by tournamentTables alone (pre-F2) MINTS the stack', () => {
  it('disconnect in the window → reservation tournament:false → the 6h expiry credits 7,000 that are still in play on T2', async () => {
    const w = world({
      disconnect: P.disconnect.replace('tournament: isTournamentTable(session.tableId),', 'tournament: tournamentTables.has(session.tableId),'),
      isTournamentReservation: P.isTournamentReservation.replace('isTournamentTable(reserved.tableId)', 'tournamentTables.has(reserved.tableId)'),
    });
    breakT1(w);
    await w.drop();
    expect(w.reservedSeats.get(ALICE)).toMatchObject({ tournament: false });
    jest.advanceTimersByTime(5000 + SEAT_RESERVE_MS);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);           // the mint
  });

  it('without the broken-table guard, the hand left running at the break ends and autoStartNextHand deals a NEW hand on the broken table (cash branches)', () => {
    const guard = '  if (brokenTournamentTables.has(tableId)) return;\n';
    expect(P.autoStart).toContain(guard);
    const w = world({ autoStart: P.autoStart.replace(guard, '') });
    breakT1(w);
    const T1 = w.tables.get('T1')!;
    (T1 as any).currentPhase = GamePhase.HandComplete;
    const start = jest.spyOn(T1, 'startNewHand');
    w.m.autoStartNextHand('T1');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('leave in the window → credited at once (pre-F2)', async () => {
    const w = world({ handlePlayerLeave: P.handlePlayerLeave.replace('const isTournamentSeat = isTournamentTable(session.tableId);', 'const isTournamentSeat = tournamentTables.has(session.tableId);') });
    breakT1(w);
    w.m.handlePlayerLeave(w.s2);
    await flush();
    expect(w.credits).toEqual([{ uid: ALICE, amount: 7000 }]);
  });
});

describe('F2 — wiring: every "tournament seat?" chip decision uses isTournamentTable, never tournamentTables alone', () => {
  it('no chip decision reads tournamentTables.has( directly', () => {
    const uses = SRC.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('tournamentTables.has('));
    // The ONLY remaining direct reads: isTournamentTable itself, and autoStartNextHand's cash branches,
    // which a broken table never reaches (it returns before them).
    // P8 / P5 (2026-10-10): isTournamentTable's live-table read, and "is this table still LIVE in
    // the tournament" checks (the broken-table startHand refusal) — no chip decision among them.
    const allowed = uses.filter(([, l]) => /return tournamentTables\.has\(tableId\) \|\| brokenTournamentTables\.has\(tableId\);/.test(l)
      || /if \(tournamentTables\.has\(tableId\)\) return true;/.test(l)
      || /!tournamentTables\.has\(tableId\)/.test(l)
      || /brokenTournamentTables\.has\(session\.tableId\) && !tournamentTables\.has\(session\.tableId\)/.test(l));
    expect(uses.length - allowed.length).toBe(0);
    const auto = P.autoStart;
    expect(auto.indexOf('if (brokenTournamentTables.has(tableId)) return;')).toBeGreaterThan(-1);
    expect(auto.indexOf('if (brokenTournamentTables.has(tableId)) return;')).toBeLessThan(auto.indexOf('if (!tournamentTables.has(tableId)) {'));
    expect(P.rebalance.indexOf('noteBrokenTournamentTable(breakTableId, tournamentId);')).toBeLessThan(P.rebalance.indexOf('tournamentTables.delete(breakTableId);'));
    expect(SRC).toContain('!creditedSeats.has(seatKey) && !isTournamentTable(session.tableId)');   // SIGTERM flush
    expect(SRC).toContain("cashOut(ps.tableId, ps.seatIndex, 'guest_claim_live_seat', isTournamentTable(ps.tableId));");
  });
});

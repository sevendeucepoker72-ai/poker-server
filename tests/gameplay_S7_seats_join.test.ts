/**
 * 2026-10-21 — gameplay audit, server cluster S7 (seat lifecycle: join, invite,
 * move, force-close, buy-in limits).
 *
 *   F100 a seat move is never allowed at a FIXED-ROSTER table (quick formats,
 *        club challenges): a move onto a bot's seat stood the bot up and the
 *        Spin & Go / career stage was then won with no hand played
 *   F65  a sitting-out player's seat move keeps his Sit Out and drops the OLD
 *        seat from the sit-out tracker (its next occupant was dealt out forever)
 *   F66  a seat move keeps the mover's owed dead blinds
 *   G188 a move that puts the big blind further away owes the big blind it skips
 *   F69  admin force-close credits EVERY human stack exactly once (extra-table,
 *        reserved, leaving-after-the-hand seats too) and ends their claims
 *   F147 admin force-close also sends 'tableClosed' {reason:'admin_force_close'}
 *        and ends every session / view / timer of the table
 *   F143 joinTable / joinByInviteCode refuse (no seat / not enough chips / chips
 *        still in a live pot) BEFORE leaving the player's seat; a refusal after
 *        the leave names the table left (leftTableId); the leave's own credit is
 *        awaited before the wallet read
 *   G190 two racing joins of one account to one table end with ONE seat
 *   F72  an invite join ends the account's other seat at that home game
 *   F110 a club table's Max Buy-In caps join, rebuy and the state's maxBuyIn
 *   (F140 / F142 are covered in buyInSocketGone.test.ts / r2Qualifiers.test.ts;
 *    F78 by the S6 G182 tests — the queued-move answers.)
 *
 * Every test runs the REAL src/index.ts source (sliced + transpiled) against the
 * REAL PokerTable; each fix has a CONTROL on the pre-fix text.
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { cardToString } from '../src/game/Card';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { accountDisplayName } from '../src/auth/displayName';
import {
  SRC, slice, fnSrc, handlerSrc, load, flush, deferred,
  SEAT_TEARDOWN_SRC, SEAT_SESSION_FOR_SRC, JOIN_PRECHECK_SRC, SEAT_RESTORE_SRC,
} from './helpers/indexSource';

const quiet = { log() {}, warn() {}, error() {} };

type FakeSocket = {
  id: string; connected: boolean; rooms: Set<string>; handlers: Record<string, (...a: any[]) => any>;
  emitted: Array<[string, any]>; emit: (ev: string, p?: any) => void; on: (ev: string, fn: any) => void;
  join: (r: string) => void; leave: (r: string) => void; listeners: (ev: string) => any[]; handshake: any;
};
function fakeSocket(id: string): FakeSocket {
  const s: FakeSocket = {
    id, connected: true, rooms: new Set(), handlers: {}, emitted: [], handshake: { address: '10.0.0.1', headers: {} },
    emit: (ev, p) => { s.emitted.push([ev, p]); },
    on: (ev, fn) => { s.handlers[ev] = fn; },
    join: (r) => { s.rooms.add(r); }, leave: (r) => { s.rooms.delete(r); },
    listeners: (ev) => (s.handlers[ev] ? [s.handlers[ev]] : []),
  };
  return s;
}
const events = (s: FakeSocket, ev: string) => s.emitted.filter(([e]) => e === ev).map(([, p]) => p);
const cfg = (tableId: string, o: { sb?: number; bb?: number; minBuyIn?: number } = {}) =>
  ({ tableId, tableName: tableId, smallBlind: o.sb ?? 25, bigBlind: o.bb ?? 50, ante: 0, minBuyIn: o.minBuyIn ?? 1000 } as any);
const seatMap = (t: PokerTable) => t.seats.map((s) => (s.state !== 'occupied' ? '.' : s.isAI ? 'B' : 'H')).join('');
/** Play the hand in progress out (every actor checks / calls, else folds). */
function playOut(t: PokerTable): void {
  for (let g = 0; g < 400 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (a < 0) break;
    if (!(t.playerCheck(a) || t.playerCall(a))) t.playerFold(a);
  }
}
/** The text between two needles of a source text (inclusive). */
function cut(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`not found: ${start.slice(0, 60)}`);
  const e = src.indexOf(end, at);
  if (e < 0) throw new Error(`no end for: ${start.slice(0, 60)}`);
  return src.slice(at, e + end.length);
}
function without(src: string, part: string, by = ''): string {
  expect(src).toContain(part);
  return src.replace(part, by);
}

// ═══════════════════════════════════════════════════════════════ seat moves ══
const MOVE = handlerSrc('moveSeat', '\n  });\n');
const EXEC = fnSrc('function executePendingMove(');
const SYNC = fnSrc('function syncSitOutToTable(');
const FIXED = fnSrc('function isFixedRosterTable(');

function moveWorld(opts: { exec?: string; move?: string; table?: PokerTable; quick?: boolean } = {}) {
  const T = opts.table ?? new PokerTable(cfg('T'));
  const sockets = new Map<string, FakeSocket>();
  const playerSessions = new Map<string, any>();
  const sitOutTracker = new Map<string, Set<number>>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => (id === 'T' ? T : undefined) }, playerSessions, multiTableSessions: new Map(),
    isTournamentTable: () => false, quickTables: new Set<string>(opts.quick ? ['T'] : []), challengeTables: new Map(),
    MAX_SEATS, aiProfiles: new Map(), sitOutTracker, lastSentState: new Map(), lastSentJson: new Map(),
    io: { sockets: { sockets } }, SevenStudTable, broadcastGameState() {}, log: { debug() {} }, console: quiet,
  };
  const { exports: m, stubbed } = load(
    `${SYNC}\n${FIXED}\n${opts.exec ?? EXEC}\nfunction wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${opts.move ?? MOVE}\n}`,
    scope, '{ wire, executePendingMove, syncSitOutToTable }',
  );
  /** A human seat with its own socket + session. */
  const human = (sid: string, seat: number, name: string, chips = 5000) => {
    expect(T.sitDown(seat, name, chips, `p-${name}`, false)).toBe(true);
    const session: any = { socketId: sid, tableId: 'T', seatIndex: seat, playerName: name, playerId: `p-${name}`, sittingOut: false };
    playerSessions.set(sid, session);
    const s = fakeSocket(sid);
    sockets.set(sid, s);
    m.wire(s);
    return { s, session };
  };
  return { T, m, stubbed, human, playerSessions, sitOutTracker };
}

describe('F100 — a seat move never happens at a FIXED-ROSTER table (a bot seat is never emptied for a free win)', () => {
  function spinGo(over: { exec?: string; move?: string } = {}) {
    const w = moveWorld({ quick: true, ...over });
    const hero = w.human('S', 0, 'Hero', 1000);
    expect(w.T.sitDown(1, 'Bot1', 1000, 'b1', true)).toBe(true);
    expect(w.T.sitDown(2, 'Bot2', 1000, 'b2', true)).toBe(true);
    return { w, hero };
  }

  it('moveSeat onto a bot\'s seat (between hands — the Spin & Go reveal): refused seat_move_not_allowed, nothing queued, the bots stay', async () => {
    const { w, hero } = spinGo();
    await hero.s.handlers.moveSeat({ targetSeatIndex: 1 });
    await hero.s.handlers.moveSeat({ targetSeatIndex: 2 });
    expect(events(hero.s, 'error')).toEqual([
      { message: 'Seat changes are not available in this game.', code: 'seat_move_not_allowed', tableId: 'T' },
      { message: 'Seat changes are not available in this game.', code: 'seat_move_not_allowed', tableId: 'T' },
    ]);
    expect(events(hero.s, 'moveSeatPending')).toEqual([]);
    expect(seatMap(w.T).slice(0, 3)).toBe('HBB');
    expect(hero.session.pendingSeatIndex).toBeUndefined();
  });

  it('a move queued there anyway (an older server, a crafted frame) is dropped at the boundary: moveSeatCancelled, the bot stays', () => {
    const { w, hero } = spinGo();
    hero.session.pendingSeatIndex = 2;
    expect(w.m.executePendingMove('T', hero.session)).toBe(false);
    expect(events(hero.s, 'moveSeatCancelled')).toEqual([{ tableId: 'T', reason: 'seat_unavailable' }]);
    expect(seatMap(w.T).slice(0, 3)).toBe('HBB');
    expect(w.T.seats[0]).toMatchObject({ playerName: 'Hero', chipCount: 1000 });
  });

  it('a ring cash table keeps its seat moves (onto an empty seat or a bot\'s)', async () => {
    const w = moveWorld();
    const hero = w.human('S', 0, 'Hero');
    expect(w.T.sitDown(1, 'Bot1', 1000, 'b1', true)).toBe(true);
    await hero.s.handlers.moveSeat({ targetSeatIndex: 1 });
    expect(events(hero.s, 'moveSeatComplete')).toEqual([{ tableId: 'T', newSeat: 1 }]);
    expect(seatMap(w.T).slice(0, 2)).toBe('.H');
  });

  it('CONTROL — pre-F100: both moves stand the bots up; the human is alone and the quick game is "won" with no hand played', async () => {
    const GATE = cut(MOVE, '      // 2026-10-21 (gameplay F100)', "        return;\n      }\n");
    const GUARD = "  if (isFixedRosterTable(tableId)) return cancelled('seat_unavailable');\n";
    const { w, hero } = spinGo({ move: without(MOVE, GATE), exec: without(EXEC, GUARD) });
    await hero.s.handlers.moveSeat({ targetSeatIndex: 1 });
    await hero.s.handlers.moveSeat({ targetSeatIndex: 2 });
    expect(seatMap(w.T).slice(0, 3)).toBe('..H');
    expect(w.T.seats.filter((s) => s.state === 'occupied' && s.isAI)).toHaveLength(0);
  });
});

describe('F65 — a sitting-out player\'s seat move keeps his Sit Out and never leaves the OLD seat in the tracker', () => {
  function setup(exec?: string) {
    const w = moveWorld({ exec });
    w.human('SA', 0, 'Ann');
    w.human('SB', 4, 'Ben');
    const p = w.human('SP', 2, 'Pat');
    // Pat taps Sit Out (the tracker + his session; the engine's set synced).
    p.session.sittingOut = true;
    w.sitOutTracker.set('T', new Set([2]));
    w.m.syncSitOutToTable('T');
    return { w, p };
  }

  it('Pat (sitting out) moves 2 → 5: the tracker holds 5 (not 2), he is still sitting out; Quinn takes seat 2 and is DEALT IN, Pat is not', async () => {
    const { w, p } = setup();
    await p.s.handlers.moveSeat({ targetSeatIndex: 5 });
    expect(events(p.s, 'moveSeatComplete')).toEqual([{ tableId: 'T', newSeat: 5 }]);
    expect([...w.sitOutTracker.get('T')!]).toEqual([5]);
    expect(p.session).toMatchObject({ seatIndex: 5, sittingOut: true });
    // Quinn sits in the seat Pat left; any later sync (another player's toggle, a teardown) runs.
    expect(w.T.sitDown(2, 'Quinn', 5000, 'p-Quinn', false)).toBe(true);
    w.m.syncSitOutToTable('T');
    expect(w.T.startNewHand()).toBe(true);
    expect(w.T.seats[2]).toMatchObject({ playerName: 'Quinn', folded: false });
    expect(w.T.seats[2].holeCards).toHaveLength(2);
    expect(w.T.seats[2].deadBlindOwedChips).toBe(0);
    expect(w.T.seats[5]).toMatchObject({ playerName: 'Pat', folded: true });   // still sitting out — not dealt, not blinded live
    expect(w.T.seats[5].holeCards).toHaveLength(0);
  });

  it('a player NOT sitting out moves and stays in (nothing added to the tracker)', async () => {
    const w = moveWorld();
    w.human('SA', 0, 'Ann');
    const p = w.human('SP', 2, 'Pat');
    await p.s.handlers.moveSeat({ targetSeatIndex: 5 });
    expect(p.session).toMatchObject({ seatIndex: 5, sittingOut: false });
    expect([...(w.sitOutTracker.get('T') || [])]).toEqual([]);
  });

  it('CONTROL — pre-F65: the tracker keeps seat 2, Pat is silently sat back in; Quinn at seat 2 is dealt OUT (no cards) every hand', async () => {
    const NEW_TRACK = cut(EXEC, "  if (!sitOutTracker.has(tableId)) sitOutTracker.set(tableId, new Set());\n", '  syncSitOutToTable(tableId);\n');
    const OLD_EXEC = without(without(EXEC, NEW_TRACK, '  const tracker = sitOutTracker.get(tableId);\n  if (tracker) {\n    tracker.delete(target);\n  }\n'),
      '  session.sittingOut = wasSittingOut;\n', '  session.sittingOut = false;\n');
    const { w, p } = setup(OLD_EXEC);
    await p.s.handlers.moveSeat({ targetSeatIndex: 5 });
    expect([...w.sitOutTracker.get('T')!]).toEqual([2]);
    expect(p.session.sittingOut).toBe(false);
    expect(w.T.sitDown(2, 'Quinn', 5000, 'p-Quinn', false)).toBe(true);
    w.m.syncSitOutToTable('T');
    expect(w.T.startNewHand()).toBe(true);
    expect(w.T.seats[2]).toMatchObject({ playerName: 'Quinn', folded: true });
    expect(w.T.seats[2].holeCards).toHaveLength(0);
    expect(w.T.seats[5].holeCards).toHaveLength(2);                        // Pat dealt in while away
  });
});

describe('F66 — a seat move keeps the dead blinds the mover owes', () => {
  const DEBT = '  table.seats[target].missedBlind = owedMissedBlind;\n  table.seats[target].deadBlindOwedChips = owedDeadBlindChips;\n';
  function setup(exec?: string) {
    const w = moveWorld({ exec });
    w.human('SA', 0, 'Ann');
    w.human('SB', 3, 'Ben');
    w.human('SC', 4, 'Cal');
    const h = w.human('SH', 2, 'Hero');
    // He sat out through both blinds: one set owed (SB 25 + BB 50).
    w.T.seats[2].missedBlind = 'both';
    w.T.seats[2].deadBlindOwedChips = 75;
    return { w, h };
  }

  it('2 → 6 between hands: seat 6 owes the same 75 (both); the next deal takes it as dead money', async () => {
    const { w, h } = setup();
    await h.s.handlers.moveSeat({ targetSeatIndex: 6 });
    expect(w.T.seats[6]).toMatchObject({ playerName: 'Hero', missedBlind: 'both', deadBlindOwedChips: 75, chipCount: 5000 });
    expect(w.T.startNewHand()).toBe(true);                                 // button 0, blinds 3 / 4: seat 6 posts no live blind
    expect(w.T.seats[6]).toMatchObject({ chipCount: 4925, deadBlindOwedChips: 0, deadMoneyThisHand: 75 });
  });

  it('a move that cannot happen (seat taken) leaves the debt on his own seat', () => {
    const { w, h } = setup();
    h.session.pendingSeatIndex = 6;
    expect(w.T.sitDown(6, 'Late', 5000, 'late', false)).toBe(true);
    expect(w.m.executePendingMove('T', h.session)).toBe(false);
    expect(w.T.seats[2]).toMatchObject({ playerName: 'Hero', missedBlind: 'both', deadBlindOwedChips: 75 });
  });

  it('CONTROL — pre-F66: the move erases the debt (seat 6 owes 0; nothing is ever posted)', async () => {
    const { w, h } = setup(without(EXEC, DEBT));
    await h.s.handlers.moveSeat({ targetSeatIndex: 6 });
    expect(w.T.seats[6]).toMatchObject({ missedBlind: 'none', deadBlindOwedChips: 0 });
    expect(w.T.startNewHand()).toBe(true);
    expect(w.T.seats[6]).toMatchObject({ chipCount: 5000, deadMoneyThisHand: 0 });
  });
});

describe('G188 — a seat move AWAY from the big blind owes the big blind it skips', () => {
  /** Hero 0, A 2, B 4, C 6, D 8; hand 1: button 0, SB 2, BB 4 — the BB reaches Hero (0) in 3 hands. */
  function afterHandOne(exec?: string, table?: PokerTable) {
    const w = moveWorld({ exec, table });
    const h = w.human('SH', 0, 'Hero');
    // (Stud seats 8 at most: its last player sits at 7.)
    const lastSeat = w.T.maxOccupiableSeats > 8 ? 8 : 7;
    for (const [i, n] of [[2, 'A'], [4, 'B'], [6, 'C'], [lastSeat, 'D']] as const) w.human(`S${n}`, i, n);
    expect(w.T.startNewHand()).toBe(true);
    playOut(w.T);
    expect(w.T.isHandInProgress()).toBe(false);
    return { w, h };
  }

  it('Hero moves 0 → 3 (the big blind now reaches him LAST): he owes the big blind (50) — the debt the next deals collect', async () => {
    const { w, h } = afterHandOne();
    if (w.T.previousBigBlindSeat !== 4) throw new Error(`unexpected rotation: BB ${w.T.previousBigBlindSeat}`);
    const stack = w.T.seats[0].chipCount;
    await h.s.handlers.moveSeat({ targetSeatIndex: 3 });
    expect(w.T.seats[3]).toMatchObject({ playerName: 'Hero', chipCount: stack, missedBlind: 'big', deadBlindOwedChips: 50 });
    // Over the next deals he pays it (as dead money) — never dealt for free.
    let paid = 0;
    for (let k = 0; k < 4; k++) {
      expect(w.T.startNewHand()).toBe(true);
      paid += w.T.seats[3].deadMoneyThisHand || 0;
      playOut(w.T);
    }
    expect(paid).toBe(50);
    expect(w.T.seats[3].deadBlindOwedChips).toBe(0);
  });

  it('a move TOWARD the big blind (0 → 5: he is the next big blind) owes nothing', async () => {
    const { w, h } = afterHandOne();
    await h.s.handlers.moveSeat({ targetSeatIndex: 5 });
    expect(w.T.seats[5]).toMatchObject({ playerName: 'Hero', missedBlind: 'none', deadBlindOwedChips: 0 });
  });

  it('before the first hand (no rotation yet) a move owes nothing', async () => {
    const w = moveWorld();
    const h = w.human('SH', 0, 'Hero');
    w.human('SA', 2, 'A');
    await h.s.handlers.moveSeat({ targetSeatIndex: 7 });
    expect(w.T.seats[7]).toMatchObject({ missedBlind: 'none', deadBlindOwedChips: 0 });
  });

  it('Stud has no blinds: the same move owes nothing', async () => {
    const stud = new SevenStudTable({ ...cfg('T'), ante: 5 } as any);
    const { w, h } = afterHandOne(undefined, stud);
    await h.s.handlers.moveSeat({ targetSeatIndex: 3 });
    expect(w.T.seats[3]).toMatchObject({ playerName: 'Hero', missedBlind: 'none', deadBlindOwedChips: 0 });
  });

  it('CONTROL — pre-G188: the move owes nothing; he is dealt the next deals and never posts a blind', async () => {
    const { w, h } = afterHandOne(without(EXEC, '  if (skipsBigBlind) {', '  if (false) {'));
    await h.s.handlers.moveSeat({ targetSeatIndex: 3 });
    expect(w.T.seats[3]).toMatchObject({ missedBlind: 'none', deadBlindOwedChips: 0 });
    let posted = 0;
    for (let k = 0; k < 2; k++) {
      expect(w.T.startNewHand()).toBe(true);
      posted += w.T.seats[3].totalInvestedThisHand;
      playOut(w.T);
    }
    expect(posted).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════ admin force-close ══
const FORCE_CLOSE = handlerSrc('adminForceCloseTable', '\n  });\n');
const NEW_CLOSE = cut(FORCE_CLOSE, '      if (!seat.isAI) {\n        // 2026-10-21 (gameplay F69)', '    bombPotPending.delete(data.tableId);\n');
const OLD_CLOSE = [
  '      if (!seat.isAI && !isTournament) {',
  '        const uid = userIdForSeat(data.tableId, i);',
  '        if (uid) {',
  '          let uname = String(uid);',
  '          for (const [, a] of authSessions) if (a.userId === uid) { uname = a.username; break; }',
  '          const refund = seat.chipCount + (inHand ? (seat.totalInvestedThisHand || 0) : 0);',
  '          if (refund > 0) {',
  '            addChipsToUser(uid, refund)',
  "              .then((ok) => auditLog(uname, ok ? 'CASH_OUT' : 'CASH_OUT_FAILED', { userId: uid, tableId: data.tableId, amount: refund, reason: 'admin_force_close' }))",
  '              .catch(() => {});',
  '          }',
  '        }',
  '      } else if (!seat.isAI && isTournament) {',
  "        auditLog(String(userIdForSeat(data.tableId, i) || ''), 'TOURNAMENT_STACK_NOT_CASHED', { tableId: data.tableId, reason: 'admin_force_close' });",
  '      }',
  '      table.standUp(i);',
  '    }',
  '    // Clear timers + boot everyone from the room.',
  '    const at = turnTimers.get(data.tableId); if (at) { clearTimeout(at.timeout); turnTimers.delete(data.tableId); }',
  '    const aw = turnWarningTimers.get(data.tableId); if (aw) { clearTimeout(aw.timeout); turnWarningTimers.delete(data.tableId); } // #12',
  '    const pa = pendingAutoStartTimers.get(data.tableId); if (pa) { clearTimeout(pa); pendingAutoStartTimers.delete(data.tableId); }',
  "    io.to(`table:${data.tableId}`).emit('tableClosedByAdmin', { tableId: data.tableId });",
  '    tableManager.removeTable(data.tableId);',
  '    tableProgressListeners.delete(data.tableId); // #7: don\'t leak the listener key',
  '    quickTables.delete(data.tableId);',
  '',
].join('\n');

const ALICE = 101; const BOB = 102; const CARL = 103; const DAN = 104;

function closeWorld(handler = FORCE_CLOSE) {
  const tables = new Map<string, PokerTable>();
  const T = new PokerTable(cfg('T'));
  tables.set('T', T);
  const sockets = new Map<string, FakeSocket>();
  const authSessions = new Map<string, any>([['ADMIN', { userId: 1, username: 'admin' }]]);
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const credits: Array<{ uid: number; amount: number }> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id) },
    authSessions, playerSessions, multiTableSessions, reservedSeats, pendingSeatRemovalAfterHand,
    isUserAdmin: async () => true, auditLog() {}, quickTables: new Set(), quickGames: new Map(), isPrizeFormatTable: () => false,
    isTournamentTable: () => false, MAX_SEATS, spectators: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(),
    turnTimers: new Map(), turnWarningTimers: new Map(), pendingAutoStartTimers: new Map(), aiTimeouts: new Map(),
    insuranceCashouts: new Map(), lastInsuranceSettlement: new Map(), drawStartedAtMap: new Map(), lastSentState: new Map(),
    lastSentJson: new Map(), tableProgressListeners: new Set(), privateTableIds: new Set(), privateTableMeta: new Map(),
    bombPotPending: new Map(), releaseSeatedSlot() {}, clearInsuranceOffer() {}, clearPineappleDiscardHold() {}, dropPendingMuckShows() {},
    addChipsToUser: async (uid: number, amount: number) => { credits.push({ uid, amount }); return true; },
    io: { to: (room: string) => ({ emit: (ev: string, p: any) => roomEmits.push([room, ev, p]) }), sockets: { sockets } },
    console: quiet,
  };
  const code = [
    fnSrc('function userIdForSeat('), fnSrc('function quickSeatOwner('), fnSrc('function endQuickSeatClaims('),
    fnSrc('function endTableViewsAndTimers('), `function wire(socket) {\n${handler}\n}`,
  ].join('\n');
  const { exports: m } = load(code, scope, '{ wire }');
  const admin = fakeSocket('ADMIN');
  sockets.set('ADMIN', admin);
  m.wire(admin);
  const sock = (id: string, uid: number, name: string) => {
    const s = fakeSocket(id);
    sockets.set(id, s);
    authSessions.set(id, { userId: uid, username: name });
    s.join('table:T');
    return s;
  };
  return { T, tables, scope, admin, sock, credits, roomEmits, playerSessions, multiTableSessions, reservedSeats, pendingSeatRemovalAfterHand };
}

describe('F69 / F147 — an admin force-close credits EVERY human stack once and closes the table for everyone', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  /**
   * T, a hand in progress: Alice (main session, 5000), Bob's EXTRA-table seat
   * (3000), Carl DISCONNECTED (reserved — snapshot 2000, live stack 4500), Dan
   * LEFT mid-hand (folded, waiting for the hand's end), a seat with no account
   * (noCredit), a bot.
   */
  function midHand(handler?: string) {
    const w = closeWorld(handler);
    const T = w.T;
    T.sitDown(0, 'Alice', 5000, 'p-alice', false);
    T.sitDown(1, 'Bob', 3000, 'p-bob', false);
    T.sitDown(2, 'Carl', 4500, 'p-carl', false);
    T.sitDown(3, 'Dan', 1000, 'p-dan', false);
    T.sitDown(4, 'Ghost', 800, 'p-ghost', false);
    T.sitDown(5, 'Bot', 2000, 'bot', true);
    const sa = w.sock('SA', ALICE, 'alice');
    w.playerSessions.set('SA', { socketId: 'SA', tableId: 'T', seatIndex: 0, playerName: 'Alice', playerId: 'p-alice' });
    const sb = w.sock('SB', BOB, 'bob');
    w.playerSessions.set('SB', { socketId: 'SB', tableId: 'OTHER', seatIndex: 4, playerName: 'Bob', playerId: 'p-bob-main' });
    w.multiTableSessions.set('SB', [{ socketId: 'SB', tableId: 'T', seatIndex: 1, playerName: 'Bob', playerId: 'p-bob' }]);
    const staleTimer = setTimeout(() => w.credits.push({ uid: CARL, amount: 2000 }), 60_000);   // the reservation's own cash-out (snapshot)
    w.reservedSeats.set(CARL, { tableId: 'T', seatIndex: 2, playerName: 'Carl', chips: 2000, cleanupTimer: staleTimer, expiresAt: Date.now() + 60_000 });
    expect(T.startNewHand()).toBe(true);
    for (let g = 0; g < 3; g++) { const a = T.activeSeatIndex; if (a >= 0) T.playerCall(a); }
    // Dan leaves with chips in the pot: folded, his stand-up deferred to the hand's end.
    if ((T.seats[3].totalInvestedThisHand || 0) === 0) { T.seats[3].chipCount -= 50; T.seats[3].totalInvestedThisHand += 50; }
    T.forceFoldSeat(3);
    w.pendingSeatRemovalAfterHand.set('T', new Map<number, any>([
      [3, { userId: DAN, username: 'dan', playerId: 'p-dan' }],
      [4, { userId: 0, username: '', noCredit: true, playerId: 'p-ghost' }],
    ]));
    expect(T.isHandInProgress()).toBe(true);
    const owed = (i: number) => T.seats[i].chipCount + (T.seats[i].totalInvestedThisHand || 0);
    const expected = new Map<number, number>([[ALICE, owed(0)], [BOB, owed(1)], [CARL, owed(2)], [DAN, owed(3)]]);
    return { w, sa, sb, expected };
  }
  const byUser = (credits: Array<{ uid: number; amount: number }>) => {
    const out = new Map<number, number>();
    for (const c of credits) out.set(c.uid, (out.get(c.uid) || 0) + c.amount);
    return out;
  };

  it('every human is credited his LIVE stack plus his chips in the pot, exactly once; nothing for a seat with no account; nothing left to pay later', async () => {
    const { w, sa, sb, expected } = midHand();
    await w.admin.handlers.adminForceCloseTable({ tableId: 'T' });
    await flush();
    jest.advanceTimersByTime(120_000);                                     // a stale reservation timer would pay its snapshot here
    await flush();
    expect(byUser(w.credits)).toEqual(expected);
    expect(w.credits.some((c) => c.uid === 0)).toBe(false);
    expect(w.reservedSeats.has(CARL)).toBe(false);
    expect(w.pendingSeatRemovalAfterHand.has('T')).toBe(false);
    // F147 — told the way every close tells them (both events, the room still joined), then every view of T ended.
    expect(w.roomEmits).toEqual([
      ['table:T', 'tableClosedByAdmin', { tableId: 'T' }],
      ['table:T', 'tableClosed', { tableId: 'T', reason: 'admin_force_close' }],
    ]);
    expect(w.playerSessions.has('SA')).toBe(false);
    expect(w.playerSessions.get('SB')).toMatchObject({ tableId: 'OTHER' });  // his main seat elsewhere untouched
    expect(w.multiTableSessions.has('SB')).toBe(false);
    expect(sa.rooms.has('table:T')).toBe(false);
    expect(sb.rooms.has('table:T')).toBe(false);
    expect(w.tables.has('T')).toBe(false);
    expect(events(w.admin, 'adminForceCloseTableResult')).toEqual([{ success: true, tableId: 'T' }]);
  });

  it('CONTROL — pre-F69/F147: only the main-session seat is paid; the reservation later pays its stale snapshot; only a toast event; sessions left on the removed table', async () => {
    const { w, expected } = midHand(without(FORCE_CLOSE, NEW_CLOSE, OLD_CLOSE));
    await w.admin.handlers.adminForceCloseTable({ tableId: 'T' });
    await flush();
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(byUser(w.credits)).toEqual(new Map([[ALICE, expected.get(ALICE)], [CARL, 2000]]));   // Bob 0, Dan 0, Carl short
    expect(w.roomEmits).toEqual([['table:T', 'tableClosedByAdmin', { tableId: 'T' }]]);
    expect(w.playerSessions.has('SA')).toBe(true);
    expect(w.multiTableSessions.get('SB')).toEqual([expect.objectContaining({ tableId: 'T' })]);
  });
});

// ═══════════════════════════════════════════════════════════════ joins ══
const JOIN = handlerSrc('joinTable', '\n    })(); }\n  );');
const INVITE = handlerSrc('joinByInviteCode', '\n  });\n');
const REBUY = handlerSrc('rebuy', '\n  })(); });');
const WHO = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', '}, 60_000).unref?.();\n');
const BUY_IN_GONE = slice('const buyInsOnDeadSocket = {', '\n  return true;\n}\n') + fnSrc('function socketHasSessionAt(');
const BROKEN = slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n');
const GHOSTS = [
  fnSrc('function clearGhostSeatsForUser('), fnSrc('function seatPlayedByAnotherAccount('),
  fnSrc('function seatReservedByOtherAccount('), fnSrc('function otherSessionHoldsSeat('),
  fnSrc('function isTournamentReservation('),
].join('\n');
const LEAVE = fnSrc('function handlePlayerLeave(');
const CREDIT_SEAT = fnSrc('function creditSeatStackToWallet(');
const CLUB_TABLE = fnSrc('async function createClubRuntimeTable(');

/** joinTable text without the F143 pre-leave checks (the pre-fix order). */
const PRE_SEAT = cut(JOIN, '      {\n        let seatFound = false;', '          return;\n        }\n      }\n');
const PRE_CHIPS = cut(JOIN, '      if (authAtJoin) {\n        // P3 — priced against', '          return;\n        }\n      }\n');
const JOIN_PRE_F143 = JOIN.replace(PRE_SEAT, '').replace(PRE_CHIPS, '');

/**
 * `precheck`: the join pre-check block text (a CONTROL swaps in a pre-fix one);
 * `extra`: more real source appended before the handlers (the S7 fix-up tests
 * add the seat-reservation restore block — restoreSeatReservation and
 * takeOverOwnSeatOnRejoin — that the invite rejoin calls).
 */
function joinWorld(opts: { join?: string; invite?: string; wallets?: Record<number, number>; precheck?: string; extra?: string } = {}) {
  const tables = new Map<string, PokerTable>();
  const sockets = new Map<string, FakeSocket>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const wallet = new Map<number, number>(Object.entries(opts.wallets ?? {}).map(([k, v]) => [Number(k), v]));
  const credits: Array<{ uid: number; amount: number }> = [];
  const deductions: Array<{ uid: number; amount: number }> = [];
  const gates: { balance: Promise<void> | null; credit: Promise<void> | null } = { balance: null, credit: null };
  let uid = 0;
  const scope: Record<string, unknown> = {
    MAX_SEATS, GamePhase, DrawPhases: [], FiveCardDrawTable, SEAT_RESERVE_MS: 6 * 3600_000,
    tableManager: { getTable: (id: string) => tables.get(id), removeTable: (id: string) => tables.delete(id), getTableList: () => [] },
    io: { to: () => ({ emit() {}, except: () => ({ emit() {} }) }), emit() {}, sockets: { sockets } },
    authSessions, playerSessions, multiTableSessions: new Map(), reservedSeats: new Map(), pendingSeatRemovalAfterHand: new Map(),
    spectators: new Map(), sitOutTracker: new Map(), aiProfiles: new Map(), quickTables: new Set(), spinGoMultipliers: new Map(),
    allInOrFoldTables: new Set(), careerTables: new Map(), challengeTables: new Map(), tournamentTables: new Map(),
    ipSeatedSlots: new Map(), clientIp: '10.0.0.1', lastSentState: new Map(), lastSentJson: new Map(), createWindowRateLimiter,
    blockedByMaintenance: () => false, assertPlayable: async () => null, isUserBanned: async () => false, shutdownFlushActive: () => false,
    seatNameForSocket: (s: any, n?: unknown) => accountDisplayName(authSessions.get(s.id)?.displayName ?? n),
    sanitizeSeatAvatar: () => undefined, uuidv4: () => `u${++uid}`, Sentry: null, auditLog() {},
    ensureChipsForBuyIn: async (u: number) => { if (gates.balance) await gates.balance; return wallet.get(u) ?? 0; },
    deductChips: async (u: number, amount: number) => {
      const have = wallet.get(u) ?? 0;
      if (have < amount) return false;
      wallet.set(u, have - amount);
      deductions.push({ uid: u, amount });
      return true;
    },
    addChipsToUser: async (u: number, amount: number) => {
      if (gates.credit) await gates.credit;                                // the DB write lands a moment later
      wallet.set(u, (wallet.get(u) ?? 0) + amount);
      credits.push({ uid: u, amount });
      return true;
    },
    detachSocketFromOtherTables() {}, releaseSeatedSlot() {}, broadcastGameState() {}, scheduleAIAction() {}, sendProgressToPlayer() {},
    ensureTableProgressListener() {}, fillWithAI() {}, emitGameState() {}, getGameStateForPlayer: () => ({}), noteSameNetworkSeat() {},
    progressionManager: { getOrCreateProgress() {} }, keepTournamentSeatOnLeave: () => false, leavePrizeFormatSeat: () => false,
    settleDecidedQuickGame() {}, stripBotsWhenNoHumans() {}, getClubInfo: async () => ({ club: { name: 'Club' } }),
    log: { debug() {}, info() {}, warn() {} }, console: quiet,
  };
  const code = [
    BROKEN, WHO, BUY_IN_GONE, GHOSTS, SYNC, SEAT_TEARDOWN_SRC, CREDIT_SEAT, LEAVE, opts.precheck ?? JOIN_PRECHECK_SRC, CLUB_TABLE,
    opts.extra ?? '',
    `function wire(socket) {\n${SEAT_SESSION_FOR_SRC}\n${opts.join ?? JOIN}\n${opts.invite ?? INVITE}\n${REBUY}\n}`,
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ wire, privateTableIds, clubTableIds, clubJoinGrants, createClubRuntimeTable }');
  const mkTable = (id: string, o: { sb?: number; bb?: number; minBuyIn?: number } = {}) => {
    const t = new PokerTable(cfg(id, o));
    (t as any).variantId = 'holdem';
    tables.set(id, t);
    return t;
  };
  (scope.tableManager as any).createTable = (c: any) => { const id = `club-${tables.size + 1}`; mkTable(id, { sb: c.smallBlind, bb: c.bigBlind, minBuyIn: c.minBuyIn }); return id; };
  const mkSocket = (id: string, userId: number, name: string) => {
    const s = fakeSocket(id);
    sockets.set(id, s);
    authSessions.set(id, { userId, username: `${name.toLowerCase()}.player`, masterUserId: `m-${userId}`, displayName: name });
    m.wire(s);
    return s;
  };
  /** A seat this socket already plays (its own buy-in, already out of the wallet). */
  const seatAt = (s: FakeSocket, tableId: string, seat: number, name: string, chips: number) => {
    const t = tables.get(tableId)!;
    expect(t.sitDown(seat, name, chips, `seat-${s.id}`, false)).toBe(true);
    playerSessions.set(s.id, { socketId: s.id, tableId, seatIndex: seat, playerName: name, playerId: `seat-${s.id}`, sittingOut: false });
    s.join(`table:${tableId}`);
  };
  return { m, stubbed, scope, tables, mkTable, mkSocket, seatAt, wallet, credits, deductions, gates, playerSessions, authSessions };
}

describe('F143 — a join is refused BEFORE it leaves the player\'s seat (no seat, not enough chips, chips still in a live pot)', () => {
  /** Alice plays table A (5000 on the table, a hand in progress with her chips in the pot); her wallet holds 500. B's minimum is 2000. */
  function midHand(join?: string, invite?: string) {
    const w = joinWorld({ join, invite, wallets: { [ALICE]: 500, [BOB]: 100_000 } });
    const A = w.mkTable('A');
    const B = w.mkTable('B', { minBuyIn: 2000 });
    const alice = w.mkSocket('SA', ALICE, 'Alice');
    const bob = w.mkSocket('SBOB', BOB, 'Bob');
    w.seatAt(bob, 'A', 0, 'Bob', 5000);
    w.seatAt(alice, 'A', 3, 'Alice', 5000);
    expect(A.startNewHand()).toBe(true);
    if ((A.seats[3].totalInvestedThisHand || 0) === 0) expect(A.playerCall(A.activeSeatIndex)).toBe(true);
    expect(A.seats[3].totalInvestedThisHand).toBeGreaterThan(0);
    return { w, A, B, alice };
  }
  const stillSeated = (w: ReturnType<typeof joinWorld>, A: PokerTable, alice: FakeSocket) => {
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'A', seatIndex: 3 });
    expect(A.seats[3]).toMatchObject({ state: 'occupied', playerName: 'Alice', folded: false });
    expect(alice.rooms.has('table:A')).toBe(true);
    expect(w.deductions).toEqual([]);
  };

  it('joinTable: his chips are in the live pot at A and the wallet cannot cover B → refused finish_hand_first (names A); still seated at A, his hand alive', async () => {
    const { w, A, alice } = midHand();
    await alice.handlers.joinTable({ tableId: 'B', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    await flush();
    expect(events(alice, 'error')).toEqual([{
      message: 'Your chips are in a hand at your current table. Finish that hand first - they return to your balance when it ends.',
      code: 'finish_hand_first', tableId: 'A',
    }]);
    stillSeated(w, A, alice);
  });

  it('joinTable: no chips anywhere that could cover it → insufficient_chips before the leave', async () => {
    const { w, A, B, alice } = midHand();
    B.config.minBuyIn = 50_000;
    await alice.handlers.joinTable({ tableId: 'B', playerName: 'Alice', seatIndex: -1, buyIn: 50_000 });
    await flush();
    expect(events(alice, 'error')).toEqual([{ message: 'Insufficient chips', code: 'insufficient_chips' }]);
    stillSeated(w, A, alice);
  });

  it('joinTable: B is full of players → No seats available before the leave', async () => {
    const { w, A, B, alice } = midHand();
    B.config.minBuyIn = 100;
    for (let i = 0; i < MAX_SEATS; i++) B.sitDown(i, `P${i}`, 1000, `px${i}`, false);
    await alice.handlers.joinTable({ tableId: 'B', playerName: 'Alice', seatIndex: -1, buyIn: 100 });
    await flush();
    expect(events(alice, 'error')).toEqual([{ message: 'No seats available', code: 'no_seat_available' }]);
    stillSeated(w, A, alice);
  });

  it('joinByInviteCode: the same refusal on joinError, before the leave', async () => {
    const { w, A, alice } = midHand();
    const H = w.mkTable('abcdef12-0000-4000-8000-000000000000', { minBuyIn: 2000 });
    w.m.privateTableIds.add('abcdef12-0000-4000-8000-000000000000');
    expect(H).toBeTruthy();
    await alice.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 2000 });
    await flush();
    expect(events(alice, 'joinError')).toEqual([expect.objectContaining({ code: 'finish_hand_first', tableId: 'A' })]);
    stillSeated(w, A, alice);
  });

  it('between hands the move pays for itself: the leave credits A\'s 5000 (awaited — the write lands late) and he buys in at B', async () => {
    const w = joinWorld({ wallets: { [ALICE]: 500 } });
    w.mkTable('A');
    const B = w.mkTable('B', { minBuyIn: 2000 });
    const alice = w.mkSocket('SA', ALICE, 'Alice');
    w.seatAt(alice, 'A', 3, 'Alice', 5000);
    const late = deferred();
    w.gates.credit = late.p;                                               // A's cash-out lands only after a moment
    void alice.handlers.joinTable({ tableId: 'B', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    await flush();
    expect(w.deductions).toEqual([]);                                      // the wallet read waits for the credit
    late.resolve();
    await flush();
    expect(events(alice, 'error')).toEqual([]);
    expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'B' });
    expect(B.seats.filter((s) => s.playerName === 'Alice')).toHaveLength(1);
    expect(w.wallet.get(ALICE)).toBe(500 + 5000 - 2000);
  });

  it('CONTROL — the same join without the await: the read races the cash-out, he is refused AFTER leaving A (the refusal names A — leftTableId)', async () => {
    const w = joinWorld({ join: without(JOIN, '        await seatCreditsSettled(authForJoin.userId);\n'), wallets: { [ALICE]: 500 } });
    w.mkTable('A');
    w.mkTable('B', { minBuyIn: 2000 });
    const alice = w.mkSocket('SA', ALICE, 'Alice');
    w.seatAt(alice, 'A', 3, 'Alice', 5000);
    const late = deferred();
    w.gates.credit = late.p;
    void alice.handlers.joinTable({ tableId: 'B', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    await flush();
    expect(events(alice, 'error')).toEqual([{ message: 'Insufficient chips', code: 'insufficient_chips', leftTableId: 'A' }]);
    expect(w.playerSessions.has('SA')).toBe(false);
    late.resolve();
    await flush();
    expect(w.wallet.get(ALICE)).toBe(5500);                                // nothing lost — but no seat anywhere
  });

  it('CONTROL — pre-F143 (checks after the leave): folded out of A, session gone, THEN refused "Insufficient chips"', async () => {
    const { w, A, alice } = midHand(JOIN_PRE_F143);
    await alice.handlers.joinTable({ tableId: 'B', playerName: 'Alice', seatIndex: -1, buyIn: 2000 });
    await flush();
    expect(events(alice, 'error')).toEqual([expect.objectContaining({ message: 'Insufficient chips', leftTableId: 'A' })]);
    expect(w.playerSessions.has('SA')).toBe(false);
    expect(A.seats[3].folded).toBe(true);
    expect(alice.rooms.has('table:A')).toBe(false);
  });

  it('wiring: the pre-leave refusals precede handlePlayerLeave( in joinTable and the chip refusal precedes it in joinByInviteCode', () => {
    const leaveAt = JOIN.indexOf('handlePlayerLeave(socket)');
    expect(JOIN.indexOf("'No seats available', code: 'no_seat_available'")).toBeLessThan(leaveAt);
    expect(JOIN.indexOf("code: 'finish_hand_first'")).toBeLessThan(leaveAt);
    expect(JOIN.indexOf("code: 'insufficient_chips'")).toBeLessThan(leaveAt);
    const iLeave = INVITE.indexOf('if (playerSessions.get(socket.id)) handlePlayerLeave(socket);');
    expect(INVITE.indexOf("code: 'insufficient_chips'")).toBeLessThan(iLeave);
    expect(INVITE.indexOf("code: 'finish_hand_first'")).toBeLessThan(iLeave);
    expect(INVITE.indexOf('socket.emit(\'joinError\', noInviteSeat());')).toBeLessThan(iLeave);
  });
});

describe('G190 — two joins of ONE account racing through the buy-in awaits end with ONE seat', () => {
  async function race(join?: string) {
    const w = joinWorld({ join, wallets: { [ALICE]: 100_000 } });
    const T1 = w.mkTable('T1');
    const a = w.mkSocket('SA', ALICE, 'Alice');
    const b = w.mkSocket('SB', ALICE, 'Alice');
    const gate = deferred();
    w.gates.balance = gate.p;                                              // both reads in flight before either sits
    void a.handlers.joinTable({ tableId: 'T1', playerName: 'Alice', seatIndex: 6, buyIn: 2000 });
    void b.handlers.joinTable({ tableId: 'T1', playerName: 'Alice', seatIndex: 7, buyIn: 2000 });
    await flush();
    gate.resolve();
    await flush();
    return { w, T1, a, b };
  }

  it('the later join ends the earlier one\'s seat (credited back, seatVacated joined_new_seat): one seat, one net buy-in', async () => {
    const { w, T1, a, b } = await race();
    const aliceSeats = T1.seats.filter((s) => s.state === 'occupied' && s.playerName === 'Alice').map((s) => s.seatIndex);
    expect(aliceSeats).toHaveLength(1);
    expect([...w.playerSessions.keys()]).toHaveLength(1);
    const [winner] = [...w.playerSessions.keys()];
    const loser = winner === 'SA' ? b : a;
    expect(w.playerSessions.get(winner)).toMatchObject({ tableId: 'T1', seatIndex: aliceSeats[0] });
    expect(events(loser, 'seatVacated')).toEqual([expect.objectContaining({ tableId: 'T1', reason: 'joined_new_seat' })]);
    expect(w.wallet.get(ALICE)).toBe(100_000 - 2000);
  });

  it('CONTROL — pre-G190 (no clear at the commit): both sit — one account, two seats at one table', async () => {
    const COMMIT_CLEAR = cut(JOIN, '      {\n        const authNow = authSessions.get(socket.id);\n        if (authNow) clearGhostSeatsForUser(authNow.userId, tableId, socket.id, seatIndex);', '      }\n');
    const { w, T1 } = await race(without(JOIN, COMMIT_CLEAR));
    expect(T1.seats.filter((s) => s.state === 'occupied' && s.playerName === 'Alice').map((s) => s.seatIndex)).toEqual([6, 7]);
    expect(w.wallet.get(ALICE)).toBe(100_000 - 4000);
  });
});

describe('F72 — an invite join ends the account\'s other seat at that home game (one seat per account per table)', () => {
  const HOME = 'abcdef12-0000-4000-8000-000000000000';
  async function phoneJoins(invite?: string) {
    const w = joinWorld({ invite, wallets: { [ALICE]: 100_000, [BOB]: 100_000 } });
    const T = w.mkTable(HOME);
    w.m.privateTableIds.add(HOME);
    const laptop = w.mkSocket('SL', ALICE, 'Alice');
    const bob = w.mkSocket('SBOB', BOB, 'Bob');
    const phone = w.mkSocket('SP', ALICE, 'Alice');
    await laptop.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
    await flush();
    await bob.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Bob', buyIn: 1000 });
    await flush();
    await phone.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
    await flush();
    return { w, T, laptop, phone };
  }

  it('the phone\'s join: the laptop\'s seat is ended (credited, seatVacated), the phone holds the ONE Alice seat', async () => {
    const { w, T, laptop } = await phoneJoins();
    // The laptop seat's blind is in the hand being played: it leaves at that hand's end (pendingSeatRemovalAfterHand).
    const leaving = (w.scope.pendingSeatRemovalAfterHand as Map<string, Map<number, any>>).get(HOME);
    const playing = T.seats.filter((s) => s.state === 'occupied' && s.playerName === 'Alice' && !leaving?.has(s.seatIndex));
    expect(playing).toHaveLength(1);
    expect(w.playerSessions.get('SP')).toMatchObject({ seatIndex: playing[0].seatIndex });
    expect(w.playerSessions.has('SL')).toBe(false);
    expect(w.playerSessions.get('SP')).toMatchObject({ tableId: HOME });
    expect(events(laptop, 'seatVacated')).toEqual([expect.objectContaining({ tableId: HOME, reason: 'joined_new_seat' })]);
  });

  it('CONTROL — pre-F72: the phone gets a SECOND Alice seat at the same table (two hands for one account)', async () => {
    const CLEAR = '    if (authAtInvite) clearGhostSeatsForUser(authAtInvite.userId, tableId, socket.id);\n';
    const COMMIT = cut(INVITE, '    {\n      const authNow = authSessions.get(socket.id);\n      if (authNow) clearGhostSeatsForUser(authNow.userId, tableId, socket.id, openSeat);', '    }\n');
    const { w, T } = await phoneJoins(without(without(INVITE, CLEAR), COMMIT));
    expect(T.seats.filter((s) => s.state === 'occupied' && s.playerName === 'Alice')).toHaveLength(2);
    expect(w.playerSessions.has('SL')).toBe(true);
    expect(w.playerSessions.has('SP')).toBe(true);
  });
});

describe('F110 — a club table\'s Max Buy-In caps the join, the rebuy and the state\'s maxBuyIn', () => {
  async function clubTable(maxBuyIn: number | undefined) {
    const w = joinWorld({ wallets: { [ALICE]: 100_000 } });
    const tableId = await w.m.createClubRuntimeTable(7, { tableName: 'Club', smallBlind: 10, bigBlind: 20, minBuyIn: 200, maxBuyIn });
    const t = w.tables.get(tableId)!;
    return { w, tableId, t };
  }
  /** A member's join: joinClubTable re-dispatches into joinTable with a grant (the payload object). */
  async function memberJoin(w: ReturnType<typeof joinWorld>, tableId: string, buyIn: number) {
    const alice = w.mkSocket('SA', ALICE, 'Alice');
    const data = { tableId, playerName: 'Alice', seatIndex: -1, buyIn };
    w.m.clubJoinGrants.add(data);
    await alice.handlers.joinTable(data);
    await flush();
    return alice;
  }

  it('min 200 / max 1000: a 2000 join seats 1000 (it was 10 x min = 2000)', async () => {
    const { w, tableId, t } = await clubTable(1000);
    expect(t.maxBuyInSetting).toBe(1000);
    expect(w.m.clubTableIds.has(tableId)).toBe(true);
    const alice = await memberJoin(w, tableId, 2000);
    expect(events(alice, 'error')).toEqual([]);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
    expect(t.seats.find((s) => s.playerName === 'Alice')?.chipCount).toBe(1000);
  });

  it('the rebuy tops up to the club max at most', async () => {
    const { w, tableId, t } = await clubTable(1000);
    const alice = w.mkSocket('SA', ALICE, 'Alice');
    w.seatAt(alice, tableId, 0, 'Alice', 300);
    await alice.handlers.rebuy({ amount: 5000 });
    await flush();
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 700 }]);
    expect(t.seats[0].chipCount).toBe(1000);
  });

  it('a stored max below the minimum (an older row) is ignored: the 10x cap applies', async () => {
    const { t } = await clubTable(100);
    expect(t.maxBuyInSetting).toBeNull();
  });

  it('the per-player state\'s maxBuyIn is the club max (a table without one keeps 10 x min)', () => {
    const KIND = slice('// ========== Table kind (R1 contract #2, 2026-10-11) ==========', "    code: 'rebuy_not_allowed',\n  };\n}\n");
    const { exports: g } = load(KIND + fnSrc('function getVariantInfo(') + fnSrc('function getGameStateForPlayer('), {
      isTournamentTable: () => false, quickTables: new Set(), spinGoMultipliers: new Map(), careerTables: new Map(),
      allInOrFoldTables: new Set(), challengeTables: new Map(), playerSessions: new Map(), progressionManager: { getProgress: () => null },
      turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
      MAX_SEATS, GamePhase, cardToString, tournamentIdOfTable: () => undefined, insuranceQuoteForSeat: () => null,
      sitOutTracker: new Map(), console: quiet,
    }, '{ getGameStateForPlayer }');
    const club = new PokerTable(cfg('club', { minBuyIn: 200 }));
    club.maxBuyInSetting = 1000;
    club.sitDown(0, 'p', 500, 'p0', false);
    expect(g.getGameStateForPlayer(club, 0)).toMatchObject({ minBuyIn: 200, maxBuyIn: 1000 });
    const cash = new PokerTable(cfg('cash', { minBuyIn: 200 }));
    cash.sitDown(0, 'p', 500, 'p0', false);
    expect(g.getGameStateForPlayer(cash, 0)).toMatchObject({ minBuyIn: 200, maxBuyIn: 2000 });
  });

  it('CONTROL — pre-F110: the runtime table never kept the max, the join clamps at 10 x min (2000 seated on a max-1000 table)', async () => {
    const OLD_CLUB = without(CLUB_TABLE, '  if (t && Number.isInteger(maxBuyIn) && maxBuyIn >= cfg.minBuyIn) t.maxBuyInSetting = maxBuyIn;\n');
    const w = joinWorld({ wallets: { [ALICE]: 100_000 } });
    const { exports: c } = load(OLD_CLUB, { ...w.scope, clubTableIds: w.m.clubTableIds, clubIdByTable: new Map() }, '{ createClubRuntimeTable }');
    const tableId = await c.createClubRuntimeTable(7, { tableName: 'Club', smallBlind: 10, bigBlind: 20, minBuyIn: 200, maxBuyIn: 1000 });
    const t = w.tables.get(tableId)!;
    expect(t.maxBuyInSetting).toBeNull();
    await memberJoin(w, tableId, 2000);
    expect(w.deductions).toEqual([{ uid: ALICE, amount: 2000 }]);
    expect(t.seats.find((s) => s.playerName === 'Alice')?.chipCount).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════ S7 fix-up (review) ══
/**
 * S7 fix-up (2026-10-21) — the reviewers of 958e190:
 *   F72 / F143  accountHoldsSeatAt let a join skip the pre-leave "no seat"
 *               refusal whenever the account held ANY seat at the target — one
 *               with chips in the live pot too, which the leave / ghost clear
 *               only folds and frees at the hand's end. A full table then left
 *               the player's seat (or ghost-cleared the other device — its hand
 *               folded) and refused afterwards: seatless everywhere.
 *   F72 (P3)    the invite join had no rejoin: the F72 ghost clear FOLDED the
 *               account's own reserved / other-socket seat at the home game and
 *               bought him in again, where joinTable's F82 blocks keep the hand.
 */
describe('S7 fix-up — an account seat in the live pot frees nothing for a join; an invite join rejoins the account\'s own seat', () => {
  const HOME = 'abcdef12-0000-4000-8000-000000000000';
  const REAL_HOLDS = fnSrc('function accountHoldsSeatAt(');
  /** The 958e190 text: any seat of the account at the target counted. */
  const OLD_HOLDS = [
    'function accountHoldsSeatAt(socketId: string, userId: number | undefined, tableId: string): boolean {',
    '  if (playerSessions.get(socketId)?.tableId === tableId) return true;',
    '  if (userId === undefined) return false;',
    '  for (const [sid, s] of playerSessions) {',
    '    if (s.tableId === tableId && authSessions.get(sid)?.userId === userId) return true;',
    '  }',
    '  for (const [sid, list] of multiTableSessions) {',
    '    if (!Array.isArray(list) || authSessions.get(sid)?.userId !== userId) continue;',
    '    if (list.some((ms) => ms && ms.tableId === tableId)) return true;',
    '  }',
    '  if (reservedSeats.get(userId)?.tableId === tableId) return true;',
    '  const t = tableManager.getTable(tableId);',
    '  const stamp = `user_${userId}`;',
    "  return !!t && t.seats.some((s) => s.state === 'occupied' && !s.isAI && s.playerId === stamp);",
    '}\n',
  ].join('\n');
  const oldPrecheck = () => without(JOIN_PRECHECK_SRC, REAL_HOLDS, OLD_HOLDS);
  const RESTORE = `${SEAT_RESTORE_SRC}\n${fnSrc('function restoreFastModeOnSeatRestore(')}`;
  const NEXT = "    // R3 (S1-1 / XL-1 / K3-1) — the seat is one BELOW the home game's cap";
  const inviteWithoutRejoin = () => without(INVITE, cut(INVITE, '    // S7 fix-up (2026-10-21, gameplay F72 / F82) — a REJOIN through the invite', NEXT), NEXT);
  const pending = (w: ReturnType<typeof joinWorld>) => (w.scope.pendingSeatRemovalAfterHand as Map<string, Map<number, any>>);

  /** Alice's socket `holderId` plays `tableId` seat 0 with chips in the hand in progress; with `full`, seats 1-8 are other players. */
  function aliceInPot(w: ReturnType<typeof joinWorld>, tableId: string, holderId: string, o: { full?: boolean; home?: boolean } = {}) {
    const t = w.mkTable(tableId);
    if (o.home) w.m.privateTableIds.add(tableId);
    const holder = w.mkSocket(holderId, ALICE, 'Alice');
    w.seatAt(holder, tableId, 0, 'Alice', 5000);
    const others = o.full ? MAX_SEATS - 1 : 2;
    for (let i = 1; i <= others; i++) expect(t.sitDown(i, `P${i}`, 5000, `px${i}`, false)).toBe(true);
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 20 && (t.seats[0].totalInvestedThisHand || 0) === 0; g++) {
      const a = t.activeSeatIndex;
      if (!(t.playerCall(a) || t.playerCheck(a))) break;
    }
    expect(t.isHandInProgress()).toBe(true);
    expect(t.seats[0].totalInvestedThisHand).toBeGreaterThan(0);
    expect(t.seats[0].folded).toBe(false);
    return { t, holder, stack: t.seats[0].chipCount, invested: t.seats[0].totalInvestedThisHand };
  }
  /** The account's seat at `t` seat 0 is untouched: still played by `holderId`, unfolded, its chips in the pot, not leaving. */
  const untouched = (w: ReturnType<typeof joinWorld>, t: PokerTable, holderId: string, invested: number) => {
    expect(w.playerSessions.get(holderId)).toMatchObject({ tableId: t.config.tableId, seatIndex: 0 });
    expect(t.seats[0]).toMatchObject({ state: 'occupied', playerName: 'Alice', folded: false, totalInvestedThisHand: invested });
    expect(pending(w).get(t.config.tableId)?.has(0) ?? false).toBe(false);
  };

  describe('F143 / F72 — a full table is refused BEFORE the leave when the account\'s seat there is in the live pot', () => {
    it('joinTable from table A: the account\'s other device plays full table T with chips in the pot → No seats available; A kept, T\'s hand untouched', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 } });
      const A = w.mkTable('A');
      const { t: T, holder, invested } = aliceInPot(w, 'T', 'SP', { full: true });
      const sa = w.mkSocket('SA', ALICE, 'Alice');
      w.seatAt(sa, 'A', 3, 'Alice', 5000);
      await sa.handlers.joinTable({ tableId: 'T', playerName: 'Alice', seatIndex: -1, buyIn: 1000 });
      await flush();
      expect(events(sa, 'error')).toEqual([{ message: 'No seats available', code: 'no_seat_available' }]);
      expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'A', seatIndex: 3 });
      expect(A.seats[3]).toMatchObject({ state: 'occupied', playerName: 'Alice', chipCount: 5000 });
      expect(sa.rooms.has('table:A')).toBe(true);
      untouched(w, T, 'SP', invested);
      expect(events(holder, 'seatVacated')).toEqual([]);
      expect(w.deductions).toEqual([]);
      expect(w.credits).toEqual([]);
    });

    it('joinTable seat change at the SAME full table, his own chips in the pot → No seats available; his seat and hand untouched', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 } });
      const { t: T, holder, invested } = aliceInPot(w, 'T', 'SA', { full: true });
      await holder.handlers.joinTable({ tableId: 'T', playerName: 'Alice', seatIndex: -1, buyIn: 1000 });
      await flush();
      expect(events(holder, 'error')).toEqual([{ message: 'No seats available', code: 'no_seat_available' }]);
      untouched(w, T, 'SA', invested);
      expect(w.deductions).toEqual([]);
    });

    it('joinByInviteCode from a socket seated at A: the laptop plays the full home game in the pot → table_full on joinError; A kept, the laptop\'s hand untouched', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, extra: RESTORE });
      w.mkTable('A');
      const { t: H, holder, invested } = aliceInPot(w, HOME, 'SL', { full: true, home: true });
      const sa = w.mkSocket('SA', ALICE, 'Alice');
      w.seatAt(sa, 'A', 3, 'Alice', 5000);
      await sa.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
      await flush();
      expect(events(sa, 'joinError')).toEqual([{ message: 'Table is full.', code: 'table_full' }]);
      expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'A', seatIndex: 3 });
      untouched(w, H, 'SL', invested);
      expect(events(holder, 'seatVacated')).toEqual([]);
      expect(w.deductions).toEqual([]);
      expect(w.credits).toEqual([]);
    });

    it('a seat of the account that the leave frees AT ONCE (between hands) still counts: the seat change at a full table goes through', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 } });
      const T = w.mkTable('T');
      const sa = w.mkSocket('SA', ALICE, 'Alice');
      w.seatAt(sa, 'T', 0, 'Alice', 5000);
      for (let i = 1; i < MAX_SEATS; i++) expect(T.sitDown(i, `P${i}`, 5000, `px${i}`, false)).toBe(true);
      await sa.handlers.joinTable({ tableId: 'T', playerName: 'Alice', seatIndex: -1, buyIn: 1000 });
      await flush();
      expect(events(sa, 'error')).toEqual([]);
      expect(w.playerSessions.get('SA')).toMatchObject({ tableId: 'T', seatIndex: 0 });
      expect(T.seats[0]).toMatchObject({ playerName: 'Alice', chipCount: 1000 });
      expect(w.wallet.get(ALICE)).toBe(100_000 + 5000 - 1000);
    });

    it('CONTROL — the 958e190 accountHoldsSeatAt: joinTable leaves A, folds the other device\'s T hand, THEN refuses (leftTableId A) — seatless everywhere', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, precheck: oldPrecheck() });
      w.mkTable('A');
      const { t: T, holder } = aliceInPot(w, 'T', 'SP', { full: true });
      const sa = w.mkSocket('SA', ALICE, 'Alice');
      w.seatAt(sa, 'A', 3, 'Alice', 5000);
      await sa.handlers.joinTable({ tableId: 'T', playerName: 'Alice', seatIndex: -1, buyIn: 1000 });
      await flush();
      expect(events(sa, 'error')).toEqual([{ message: 'No seats available', code: 'no_seat_available', leftTableId: 'A' }]);
      expect(w.playerSessions.has('SA')).toBe(false);
      expect(w.playerSessions.has('SP')).toBe(false);
      expect(T.seats[0]).toMatchObject({ state: 'occupied', folded: true });
      expect(pending(w).get('T')?.has(0)).toBe(true);
      expect(events(holder, 'seatVacated')).toEqual([expect.objectContaining({ tableId: 'T', seatIndex: 0, reason: 'joined_new_seat' })]);
    });

    it('CONTROL — the 958e190 accountHoldsSeatAt: the invite join from A leaves A, folds the laptop\'s hand, THEN refuses table_full (leftTableId A)', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, precheck: oldPrecheck(), extra: RESTORE });
      w.mkTable('A');
      const { t: H, holder } = aliceInPot(w, HOME, 'SL', { full: true, home: true });
      const sa = w.mkSocket('SA', ALICE, 'Alice');
      w.seatAt(sa, 'A', 3, 'Alice', 5000);
      await sa.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
      await flush();
      expect(events(sa, 'joinError')).toEqual([{ message: 'Table is full.', code: 'table_full', leftTableId: 'A' }]);
      expect(w.playerSessions.has('SA')).toBe(false);
      expect(w.playerSessions.has('SL')).toBe(false);
      expect(H.seats[0].folded).toBe(true);
      expect(events(holder, 'seatVacated')).toEqual([expect.objectContaining({ seatIndex: 0, reason: 'joined_new_seat' })]);
    });
  });

  describe('F72 (P2 / P3) — the invite join of a socket with no seat rejoins the account\'s own seat at the home game (as joinTable\'s F82)', () => {
    it('the laptop plays the FULL home game with chips in the pot, the phone taps the invite: the seat MOVES to the phone — hand, stack kept; nothing bought, nothing credited', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, extra: RESTORE });
      const { t: H, holder, stack, invested } = aliceInPot(w, HOME, 'SL', { full: true, home: true });
      const phone = w.mkSocket('SP', ALICE, 'Alice');
      await phone.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
      await flush();
      expect(events(phone, 'joinError')).toEqual([]);
      expect(w.playerSessions.get('SP')).toMatchObject({ socketId: 'SP', tableId: HOME, seatIndex: 0, playerId: 'seat-SL' });
      expect(w.playerSessions.has('SL')).toBe(false);
      expect(H.seats[0]).toMatchObject({ state: 'occupied', folded: false, chipCount: stack, totalInvestedThisHand: invested });
      expect(H.isHandInProgress()).toBe(true);
      expect(pending(w).get(HOME)?.has(0) ?? false).toBe(false);
      expect(events(phone, 'reconnectedToTable')).toEqual([{ tableId: HOME, seatIndex: 0, sittingOut: false }]);
      expect(events(holder, 'seatVacated')).toEqual([{ tableId: HOME, seatIndex: 0, reason: 'joined_new_seat' }]);
      expect(w.deductions).toEqual([]);
      expect(w.credits).toEqual([]);
      expect([...w.stubbed].filter((n) => /takeOver|restore|Reserv|Ghost|accountHolds/.test(n) && !n.includes('.'))).toEqual([]);
    });

    it('…without that rejoin, the pre-check alone already refuses BEFORE the ghost clear (table_full): the laptop keeps its seat and hand', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, invite: inviteWithoutRejoin(), extra: RESTORE });
      const { t: H, holder, invested } = aliceInPot(w, HOME, 'SL', { full: true, home: true });
      const phone = w.mkSocket('SP', ALICE, 'Alice');
      await phone.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
      await flush();
      expect(events(phone, 'joinError')).toEqual([{ message: 'Table is full.', code: 'table_full' }]);
      expect(w.playerSessions.has('SP')).toBe(false);
      untouched(w, H, 'SL', invested);
      expect(events(holder, 'seatVacated')).toEqual([]);
      expect(w.deductions).toEqual([]);
    });

    it('CONTROL — 958e190 (no rejoin, the old accountHoldsSeatAt): the laptop\'s hand is folded, its session ended, and the phone is STILL refused table_full', async () => {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, invite: inviteWithoutRejoin(), precheck: oldPrecheck(), extra: RESTORE });
      const { t: H, holder } = aliceInPot(w, HOME, 'SL', { full: true, home: true });
      const phone = w.mkSocket('SP', ALICE, 'Alice');
      await phone.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
      await flush();
      expect(events(phone, 'joinError')).toEqual([{ message: 'Table is full.', code: 'table_full' }]);
      expect(events(holder, 'seatVacated')).toEqual([expect.objectContaining({ seatIndex: 0, reason: 'joined_new_seat' })]);
      expect(w.playerSessions.has('SL')).toBe(false);
      expect(w.playerSessions.has('SP')).toBe(false);
      expect(H.seats[0]).toMatchObject({ state: 'occupied', folded: true });
      expect(pending(w).get(HOME)?.has(0)).toBe(true);
      expect(w.deductions).toEqual([]);
    });

    /** The phone dropped mid-hand with its chips in the pot: its seat is RESERVED (no session); the laptop taps the invite. */
    async function reservedThenInvite(invite?: string) {
      const w = joinWorld({ wallets: { [ALICE]: 100_000 }, invite, extra: RESTORE });
      const { t: H, stack, invested } = aliceInPot(w, HOME, 'SP', { home: true });
      w.playerSessions.delete('SP');
      (w.scope.reservedSeats as Map<number, any>).set(ALICE, {
        tableId: HOME, seatIndex: 0, playerName: 'Alice', chips: stack, sittingOut: false,
        expiresAt: Date.now() + 6 * 3600_000, cleanupTimer: undefined, handsRemaining: 20, playerId: 'seat-SP', tournament: false,
      });
      const laptop = w.mkSocket('SL', ALICE, 'Alice');
      await laptop.handlers.joinByInviteCode({ inviteCode: 'abcdef12', playerName: 'Alice', buyIn: 1000 });
      await flush();
      return { w, H, laptop, stack, invested };
    }

    it('a live reservation at the home game is RESTORED onto the laptop: same seat, unfolded, same stack; no deduct, no credit; the reservation consumed', async () => {
      const { w, H, laptop, stack, invested } = await reservedThenInvite();
      expect(events(laptop, 'joinError')).toEqual([]);
      expect(w.playerSessions.get('SL')).toMatchObject({ tableId: HOME, seatIndex: 0, playerId: `user_${ALICE}`, seatPlayerId: 'seat-SP' });
      expect(H.seats[0]).toMatchObject({ state: 'occupied', folded: false, chipCount: stack, totalInvestedThisHand: invested });
      expect(pending(w).get(HOME)?.has(0) ?? false).toBe(false);
      expect((w.scope.reservedSeats as Map<number, any>).has(ALICE)).toBe(false);
      expect(events(laptop, 'reconnectedToTable')).toEqual([{ tableId: HOME, seatIndex: 0, sittingOut: false }]);
      expect(H.seats.filter((s) => s.state === 'occupied' && s.playerName === 'Alice')).toHaveLength(1);
      expect(w.deductions).toEqual([]);
      expect(w.credits).toEqual([]);
    });

    it('CONTROL — no invite rejoin: the F72 clear FOLDS the reserved hand and buys the laptop in again at another seat', async () => {
      const { w, H } = await reservedThenInvite(inviteWithoutRejoin());
      expect(H.seats[0].folded).toBe(true);
      expect(pending(w).get(HOME)?.has(0)).toBe(true);
      expect(w.deductions).toEqual([{ uid: ALICE, amount: 1000 }]);
      expect(w.playerSessions.get('SL')?.seatIndex).not.toBe(0);
    });

    it('wiring: the invite rejoin runs before the seat pre-check, the leave and the F72 ghost clear', () => {
      const at = INVITE.indexOf('takeOverOwnSeatOnRejoin(socket, rjAuth.userId, tableId, undefined, \'joinByInviteCode\')');
      const restoreAt = INVITE.indexOf("restoreSeatReservation(socket, rjAuth.userId, 'joinByInviteCode'");
      expect(restoreAt).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(restoreAt);
      expect(at).toBeLessThan(INVITE.indexOf('!accountHoldsSeatAt(socket.id, authAtInvite?.userId, tableId)'));
      expect(at).toBeLessThan(INVITE.indexOf('if (playerSessions.get(socket.id)) handlePlayerLeave(socket);'));
      expect(at).toBeLessThan(INVITE.indexOf('if (authAtInvite) clearGhostSeatsForUser(authAtInvite.userId, tableId, socket.id);'));
    });
  });
});

describe('S7 harness sanity — nothing the tests rely on was silently stubbed', () => {
  it('the join world runs the real teardown, ghost clear, leave and pre-checks', () => {
    const w = joinWorld();
    const real = /^(teardownSeat|clearGhostSeatsForUser|handlePlayerLeave|creditSeatStackToWallet|projectedJoinCredits|accountHoldsSeatAt|seatCreditsSettled|buyInSocketGone|syncSitOutToTable)$/;
    expect([...w.stubbed].filter((n) => real.test(n))).toEqual([]);
    expect(SRC).toContain('function projectedJoinCredits(');
  });
});

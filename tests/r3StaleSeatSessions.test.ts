/**
 * R3 review (SFC-1, 2026-10-12) — when a seat is stood up at the hand's end
 * (processPendingSeatRemovals), any session (main or extra-table) or
 * reservation still pointing at it is ended: a stale session would otherwise
 * see and act for the seat's NEXT occupant (its state is built from the seat
 * index).
 */
import { PokerTable } from '../src/game/PokerTable';
import { fnSrc, load } from './helpers/indexSource';

function world() {
  const table = new PokerTable({ tableId: 'T', tableName: 'T', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
  table.sitDown(0, 'Alice', 3000, 'player-alice', false);
  table.sitDown(1, 'Bob', 3000, 'player-bob', false);
  const credits: Array<[number, string]> = [];
  const emitted: Array<[string, string, any]> = [];
  const left: Array<[string, string]> = [];
  const mkSock = (id: string) => ({ id, leave: (room: string) => left.push([id, room]), emit: (ev: string, d: any) => emitted.push([id, ev, d]) });
  const sockets = new Map([['S1', mkSock('S1')], ['S2', mkSock('S2')], ['S3', mkSock('S3')]]);
  const playerSessions = new Map<string, any>([
    ['S1', { socketId: 'S1', tableId: 'T', seatIndex: 0, playerId: 'user_7', seatPlayerId: 'player-alice' }],   // the stale one
    ['S2', { socketId: 'S2', tableId: 'T', seatIndex: 1, playerId: 'player-bob' }],                            // Bob, untouched
  ]);
  const multiTableSessions = new Map<string, any[]>([['S3', [{ tableId: 'T', seatIndex: 0, playerId: 'player-alice' }, { tableId: 'U', seatIndex: 2, playerId: 'x' }]]]);
  const timer = setTimeout(() => {}, 1e9);
  const reservedSeats = new Map<number, any>([[7, { tableId: 'T', seatIndex: 0, cleanupTimer: timer }], [9, { tableId: 'T', seatIndex: 1 }]]);
  const pendingSeatRemovalAfterHand = new Map([['T', new Map([[0, { userId: 7, username: 'alice', playerId: 'player-alice' }]])]]);
  const code = [fnSrc('function processPendingSeatRemovals('), fnSrc('function endStaleSessionsAtSeat(')].join('\n');
  const { exports: m } = load(code, {
    pendingSeatRemovalAfterHand, playerSessions, multiTableSessions, reservedSeats,
    tableManager: { getTable: (id: string) => (id === 'T' ? table : undefined) },
    io: { sockets: { sockets } },
    creditSeatStackToWallet: (uid: number, _u: string, tid: string) => { credits.push([uid, tid]); },
    sitOutTracker: new Map(), syncSitOutToTable() {}, broadcastGameState() {},
    console: { warn() {}, log() {} },
  }, '{ processPendingSeatRemovals }');
  return { m, table, credits, emitted, left, playerSessions, multiTableSessions, reservedSeats, timer };
}

describe('R3 review (SFC-1) — a seat removed at the hand\'s end ends every session and reservation still pointing at it', () => {
  it('the stale main session, the stale extra-table entry and the reservation go; Bob\'s seat and everything elsewhere stay', () => {
    const w = world();
    w.m.processPendingSeatRemovals('T');
    expect(w.credits).toEqual([[7, 'T']]);                                     // credited once, as before
    expect(w.table.seats[0].state).toBe('empty');
    expect(w.playerSessions.has('S1')).toBe(false);
    expect(w.playerSessions.has('S2')).toBe(true);
    expect(w.multiTableSessions.get('S3')).toEqual([{ tableId: 'U', seatIndex: 2, playerId: 'x' }]);
    expect(w.reservedSeats.has(7)).toBe(false);
    expect(w.reservedSeats.has(9)).toBe(true);
    expect(w.emitted.filter(([, ev]) => ev === 'seatVacated').map(([sid]) => sid).sort()).toEqual(['S1', 'S3']);
    expect(w.left).toEqual(expect.arrayContaining([['S1', 'table:T'], ['S3', 'table:T']]));
    clearTimeout(w.timer);
  });
});

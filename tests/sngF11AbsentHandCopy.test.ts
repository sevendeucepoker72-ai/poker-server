/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F11) — every
 * seated account gets its OWN hand-history copy, even while disconnected.
 * The 'handHistory' listener wrote a copy only for a LIVE main session at the
 * table: an absent player (disconnected, Back to Lobby, away at a tournament
 * start) and an extra-table seat (joinAdditionalTable) had no record of the
 * hands they were dealt.
 *  - Live main sessions: unchanged (socket emit + recordHand).
 *  - Extra-table sessions at this table: recordHand (no socket emit).
 *  - Every other human seat dealt into the hand: its account by
 *    dealtInSeatAccount (a reservation of the same occupant, a pending
 *    removal); at a tournament table, else the entrant's local userId.
 *    recordHand with HIS seat / cards (handHistoryViewerOfSeat). No emit.
 *  - One copy per account per hand; never for a seat another player now holds.
 *
 * The REAL listener (sliced from src/index.ts) on a REAL PokerTable hand.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { cardToString } from '../src/game/Card';
import { slice, fnSrc, load, SEAT_IDENTITY_SRC, INSURANCE_HISTORY_SRC } from './helpers/indexSource';

const LISTENER = slice("  table.on('handHistory', (history: HandHistoryRecord) => {", '\n  });\n');

function world(opts: { tournament?: boolean } = {}) {
  const table = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 100000, maxPlayers: 9 } as any);
  table.sitDown(0, 'Josh', 2000, 'p-josh', false);
  table.sitDown(1, 'Away', 2000, 'p-away', false);
  table.sitDown(2, 'Extra', 2000, 'p-extra', false);
  const playerSessions = new Map<string, any>([['SA', { socketId: 'SA', tableId: 'T1', seatIndex: 0, playerName: 'Josh', playerId: 'p-josh' }]]);
  const multiTableSessions = new Map<string, any[]>([['SX', [{ socketId: 'SX', tableId: 'T1', seatIndex: 2, playerName: 'Extra', playerId: 'p-extra' }]]]);
  const authSessions = new Map<string, any>([['SA', { userId: 7 }], ['SX', { userId: 9 }]]);
  const reservedSeats = new Map<number, any>();
  const tm = new TournamentManager();
  const tournamentTables = new Map<string, string>();
  if (opts.tournament) {
    const tid = tm.createTournament({ name: 'T', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 600 }] } as any);
    tm.registerPlayer(tid, 'p-josh', 'Josh', 'SA', 7);
    tm.registerPlayer(tid, 'p-away', 'Away', '', 61);
    tm.registerPlayer(tid, 'p-extra', 'Extra', 'SX', 9);
    tournamentTables.set('T1', tid);
  }
  const recorded: Array<{ uid: number; data: any }> = [];
  const emitted: Array<[string, string, any]> = [];
  const sockets = new Map<string, any>([['SA', { emit: (ev: string, d: any) => emitted.push(['SA', ev, d]) }], ['SX', { emit: (ev: string, d: any) => emitted.push(['SX', ev, d]) }]]);
  const scope: Record<string, unknown> = {
    playerSessions, multiTableSessions, authSessions, reservedSeats, pendingSeatRemovalAfterHand: new Map(),
    io: { sockets: { sockets } }, cardToString, recordHand: async (uid: number, _id: string, data: any) => { recorded.push({ uid, data }); },
    tournamentManager: tm, tournamentTables, brokenTournamentTables: new Map(),
    tournamentIdOfTable: (id: string) => tournamentTables.get(id),
  };
  const code = [
    `function wireHH(table, tableId) {\n${LISTENER}\n}`,
    fnSrc('function handHistoryViewerOf('), fnSrc('function dealtInSeatAccount('), fnSrc('function seatPlayedByAnotherAccount('),
    SEAT_IDENTITY_SRC, INSURANCE_HISTORY_SRC,
    slice('// ===== Hand-history copies for every seated account (Sit & Go fix-all F11) =====', '// ===== end hand-history copies =====\n'),
  ].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ wireHH }');
  m.wireHH(table, 'T1');
  return { table, recorded, emitted, reservedSeats, playerSessions, stubbed };
}

function playOut(t: PokerTable): void {
  expect(t.startNewHand()).toBe(true);
  for (let g = 0; g < 40 && t.isHandInProgress(); g++) {
    const a = t.activeSeatIndex;
    if (!t.playerCheck(a)) t.playerCall(a);
  }
  expect(t.currentPhase).toBe(GamePhase.HandComplete);
}
const real = (t: PokerTable, seat: number) => t.seats[seat].holeCards.map((c) => ({ suit: c.suit, rank: c.rank, display: cardToString(c) }));

describe('F11 — a hand-history copy for every seated account', () => {
  it('a DISCONNECTED player (live reservation, no session) gets his copy: his seat and his own hole cards (e038f7b: none); the extra-table seat too; the live one as before', () => {
    const w = world();
    w.reservedSeats.set(54, { tableId: 'T1', seatIndex: 1, playerId: 'p-away', playerName: 'Away', expiresAt: Date.now() + 60_000, handsRemaining: 3 });
    playOut(w.table);
    const byUid = new Map(w.recorded.map((r) => [r.uid, r.data]));
    expect([...byUid.keys()].sort((a, b) => a - b)).toEqual([7, 9, 54]);
    expect(byUid.get(54)).toMatchObject({ tableId: 'T1', viewerSeat: 1, viewerHoleCards: real(w.table, 1) });
    expect(byUid.get(9)).toMatchObject({ tableId: 'T1', viewerSeat: 2, viewerHoleCards: real(w.table, 2) });
    expect(byUid.get(7)).toMatchObject({ viewerSeat: 0 });
    expect(w.recorded).toHaveLength(3);                                         // one copy each
    // Only the live main socket is emitted to (as before).
    expect(w.emitted.map(([sid, ev]) => [sid, ev])).toEqual([['SA', 'handHistory']]);
    expect([...w.stubbed].filter((s) => /Viewer|dealtIn|handHistoryCopy/i.test(s))).toEqual([]);
  });

  it('a tournament seat with no session and no reservation (away at the start): his copy through the entrant\'s userId', () => {
    const w = world({ tournament: true });
    playOut(w.table);
    const r = w.recorded.find((x) => x.uid === 61);
    expect(r?.data).toMatchObject({ viewerSeat: 1, viewerHoleCards: real(w.table, 1) });
  });

  it('a reservation whose occupant changed (another player now holds that seat): no copy for the reservation\'s account', () => {
    const w = world();
    w.reservedSeats.set(54, { tableId: 'T1', seatIndex: 1, playerId: 'p-someone-else', playerName: 'Someone', expiresAt: Date.now() + 60_000, handsRemaining: 3 });
    playOut(w.table);
    expect(w.recorded.map((r) => r.uid).sort((a, b) => a - b)).toEqual([7, 9]);
  });

  it('an account with a live session AND a reservation path gets ONE copy', () => {
    const w = world();
    w.reservedSeats.set(7, { tableId: 'T1', seatIndex: 0, playerId: 'p-josh', playerName: 'Josh', expiresAt: Date.now() + 60_000, handsRemaining: 3 });
    playOut(w.table);
    expect(w.recorded.filter((r) => r.uid === 7)).toHaveLength(1);
  });
});

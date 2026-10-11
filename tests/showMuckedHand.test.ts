/**
 * R1 (2026-10-11) — TABLEUI-5, contract #4: `showMuckedHand` broadcasts the
 * seat's REAL hole cards; the client's `cards` are ignored.
 *
 * Live bug: the handler relayed `data.cards` to the whole table, so a player
 * could "show" any cards he liked — or `[null]` / 'x', which threw in every
 * client's renderer (root ErrorBoundary) — and the winner of an uncontested
 * pot could not show at all (only `seat.folded` was allowed).
 * Real handler source (sliced from src/index.ts) on a real PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { cardToString } from '../src/game/Card';
import { handlerSrc, load, flush } from './helpers/indexSource';

const HANDLER = handlerSrc('showMuckedHand', '\n  });\n');

function world() {
  const t = new PokerTable({ tableId: 'T', tableName: 'T', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
  for (let i = 0; i < 3; i++) expect(t.sitDown(i, `P${i}`, 2000, `p${i}`, false)).toBe(true);
  const playerSessions = new Map<string, any>();
  for (let i = 0; i < 3; i++) playerSessions.set(`S${i}`, { socketId: `S${i}`, tableId: 'T', seatIndex: i, playerName: `P${i}`, playerId: `p${i}` });
  const room: Array<[string, string, any]> = [];
  const { exports: m } = load(`const shownMuckedHands = new Set();\nfunction wire(socket) {\n${HANDLER}\n}`, {
    playerSessions, multiTableSessions: new Map(), tableManager: { getTable: (id: string) => (id === 'T' ? t : undefined) },
    GamePhase, cardToString, io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) },
  }, '{ wire }');
  const sock = (id: string) => {
    const handlers: Record<string, (d?: any) => any> = {};
    m.wire({ id, emit() {}, on: (ev: string, fn: any) => { handlers[ev] = fn; } });
    return async (d?: any) => { await handlers.showMuckedHand(d); await flush(); };
  };
  return { t, room, sock, playerSessions };
}
const real = (t: PokerTable, seat: number) => t.seats[seat].holeCards.map((c) => ({ suit: c.suit, rank: c.rank, display: cardToString(c) }));

describe('showMuckedHand — real cards only (contract #4)', () => {
  it('a folded player shows his REAL cards; forged / malformed client cards are ignored', async () => {
    const w = world();
    w.t.startNewHand();
    const a = w.t.activeSeatIndex;
    expect(w.t.playerFold(a)).toBe(true);
    await w.sock(`S${a}`)({ cards: [{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }] });
    expect(w.room).toEqual([['table:T', 'muckedHandRevealed', expect.objectContaining({
      seatIndex: a, playerName: `P${a}`, tableId: 'T', handNumber: w.t.handNumber, cards: real(w.t, a),
    })]]);
    // once per seat per hand — a repeat (or a [null] / 'x' payload) relays nothing more
    await w.sock(`S${a}`)({ cards: [null] });
    await w.sock(`S${a}`)({ cards: 'x' });
    expect(w.room).toHaveLength(1);
  });

  it('a player still in the hand cannot show (nothing broadcast)', async () => {
    const w = world();
    w.t.startNewHand();
    const a = w.t.activeSeatIndex;
    await w.sock(`S${a}`)({ cards: [] });
    expect(w.room).toEqual([]);
  });

  it('the UNCONTESTED winner may show once the hand is over; a spectator / unknown socket never', async () => {
    const w = world();
    w.t.startNewHand();
    for (let g = 0; g < 10 && w.t.isHandInProgress(); g++) w.t.playerFold(w.t.activeSeatIndex);
    expect(w.t.currentPhase).toBe(GamePhase.HandComplete);
    expect(w.t.wentToShowdown).toBe(false);
    const winner = w.t.lastHandResult!.winners[0].seatIndex;
    await w.sock('SPEC')({});
    expect(w.room).toEqual([]);
    await w.sock(`S${winner}`)({});
    expect(w.room).toEqual([['table:T', 'muckedHandRevealed', expect.objectContaining({ seatIndex: winner, cards: real(w.t, winner) })]]);
  });

  it('a contested showdown\'s winner has nothing to show (his cards were tabled)', async () => {
    const w = world();
    w.t.startNewHand();
    for (let g = 0; g < 100 && w.t.isHandInProgress(); g++) {
      const a = w.t.activeSeatIndex;
      if (w.t.currentBetToMatch > w.t.seats[a].currentBet) w.t.playerCall(a); else w.t.playerCheck(a);
    }
    expect(w.t.wentToShowdown).toBe(true);
    const winner = w.t.lastHandResult!.winners[0].seatIndex;
    await w.sock(`S${winner}`)({});
    expect(w.room).toEqual([]);
  });

  it('a stale request after the next hand started shows nothing (the seat is no longer folded / the result is old)', async () => {
    const w = world();
    w.t.startNewHand();
    for (let g = 0; g < 10 && w.t.isHandInProgress(); g++) w.t.playerFold(w.t.activeSeatIndex);
    const winner = w.t.lastHandResult!.winners[0].seatIndex;
    expect(w.t.startNewHand()).toBe(true);
    await w.sock(`S${winner}`)({});
    expect(w.room).toEqual([]);
  });
});

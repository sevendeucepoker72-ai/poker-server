/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all C2 + C1, review
 * fix-up) — every hand-history record says what kind of table it came from
 * and the level the hand was played at.
 *
 * poker-3d C2 leaves tournament hands out of the bankroll / analytics only when
 * it can tell them apart: live records are stamped from the table state, but a
 * STORED record (durableState.handHistory after a reload or a fresh sign-in,
 * and every F11 copy of an absent player) carried no kind, so it counted as a
 * wallet result again (a 1,500-chip Sit & Go stack loss plotted as a bankroll
 * loss). And C1's header stakes were guessed from the log (wrong when both
 * blinds were short all-ins) although the engine knows the hand's level (F18).
 *  - handHistory record (engine, every variant through emitHandCompletion):
 *    + `smallBlind`, `bigBlind`, `ante` = the hand's level (handSmallBlind /
 *    handBigBlind / handAnte; a mid-hand level-up does not change them).
 *  - index.ts handHistory listener: + `tableKind` (tableKindOf: 'tournament',
 *    'spingo', 'cash', ...) and `tournamentId` (tournament tables) on the
 *    emitted copy, the saved copy and every F11 copy.
 * All additive (an old bundle ignores them; C2 / C1 read them).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { cardToString } from '../src/game/Card';
import { slice, fnSrc, load, INSURANCE_HISTORY_SRC, SEAT_IDENTITY_SRC } from './helpers/indexSource';

function mk(Ctor: any = PokerTable, extra: any[] = []): PokerTable {
  const t = new Ctor({ tableId: 'T1', tableName: 'T1', smallBlind: 100, bigBlind: 200, ante: 25, minBuyIn: 1, maxBuyIn: 1e9, maxPlayers: 9 } as any, ...extra);
  for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 10_000, `p${i}`, false);
  return t;
}

describe('C1 review fix-up — the record carries the hand\'s level', () => {
  it("Hold'em: 100/200 ante 25 dealt; the level goes up mid-hand (300/600/75); the record still says 100/200/25, the next hand 300/600/75 (a154b20: no keys)", () => {
    const t = mk();
    const recs: any[] = [];
    t.on('handHistory', (h: any) => recs.push(h));
    expect(t.startNewHand()).toBe(true);
    t.config.smallBlind = 300; t.config.bigBlind = 600; t.config.ante = 75;   // a tournament level-up mid-hand
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(recs[0]).toMatchObject({ smallBlind: 100, bigBlind: 200, ante: 25 });
    expect(t.startNewHand()).toBe(true);
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(recs[1]).toMatchObject({ smallBlind: 300, bigBlind: 600, ante: 75 });
  });

  it('Omaha hi-lo (its own record builder) too; ante 0 is sent as 0', () => {
    const t = mk(OmahaTable, [true]);
    t.config.ante = 0;
    const recs: any[] = [];
    t.on('handHistory', (h: any) => recs.push(h));
    expect(t.startNewHand()).toBe(true);
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(recs[0]).toMatchObject({ smallBlind: 100, bigBlind: 200, ante: 0, variant: expect.any(String) });
  });
});

describe('C2 review fix-up — the listener stamps tableKind / tournamentId on every copy', () => {
  const LISTENER = slice("  table.on('handHistory', (history: HandHistoryRecord) => {", '\n  });\n');
  function world(kind: string, tournamentId?: string) {
    const t = mk();
    const emitted: any[] = [];
    const recorded: Array<{ userId: number; rec: any }> = [];
    const copies: any[] = [];
    const sock = { id: 'S1', emit: (ev: string, d: any) => { if (ev === 'handHistory') emitted.push(d); } };
    const scope: Record<string, unknown> = {
      cardToString,
      playerSessions: new Map([['S1', { socketId: 'S1', tableId: 'T1', seatIndex: 1, playerName: 'P1', playerId: 'p1' }]]),
      authSessions: new Map([['S1', { userId: 77, username: 'p1' }]]),
      io: { sockets: { sockets: new Map([['S1', sock]]) } },
      recordHand: (userId: number, _id: string, rec: any) => { recorded.push({ userId, rec }); return Promise.resolve(); },
      recordHandHistoryCopiesForEverySeat: (_t: any, _id: string, _h: any, serialized: any) => { copies.push(serialized); },
      tableKindOf: () => kind,
      tournamentIdOfTable: () => tournamentId,
    };
    const code = `${INSURANCE_HISTORY_SRC}\n${SEAT_IDENTITY_SRC}\n${fnSrc('function handHistoryViewerOf(')}\n${fnSrc('function handRecordKindOf(')}\nfunction wire(tableId, table) {\n${LISTENER}\n}`;
    const { exports: m, stubbed } = load(code, scope, '{ wire }');
    m.wire('T1', t);
    expect(t.startNewHand()).toBe(true);
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    return { emitted, recorded, copies, stubbed };
  }

  it('a Sit & Go table: tableKind tournament + its tournamentId on the emitted, saved and F11 copies; and the hand\'s level', () => {
    const w = world('tournament', 'TOURN-9');
    for (const rec of [w.emitted[0], w.recorded[0].rec, w.copies[0]]) {
      expect(rec).toMatchObject({ tableKind: 'tournament', tournamentId: 'TOURN-9', smallBlind: 100, bigBlind: 200, ante: 25 });
    }
    expect([...w.stubbed].filter((s) => /handRecordKindOf|tableKindOf|tournamentIdOfTable/.test(s))).toEqual([]);
  });

  it('a Spin & Go: tableKind spingo, no tournamentId', () => {
    const w = world('spingo');
    expect(w.recorded[0].rec.tableKind).toBe('spingo');
    expect('tournamentId' in w.recorded[0].rec).toBe(false);
  });

  it('a cash table: tableKind cash, no tournamentId (C2 keeps it a wallet result)', () => {
    const w = world('cash');
    expect(w.emitted[0].tableKind).toBe('cash');
    expect('tournamentId' in w.emitted[0]).toBe(false);
  });
});

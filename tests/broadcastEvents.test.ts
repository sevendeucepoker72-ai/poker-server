/**
 * 2026-11-02 (.online tournament broadcast, P2-S2) — THE TICKER, end to end:
 * the REAL TournamentManager's events → the index.ts hooks → /broadcast
 * 'bc:frame' {kind:'event'} and program.ticker (a REAL in-process socket.io
 * Server, a raw websocket client).
 *  - a bust carries its FINAL place, of (entries), byName, tableNo and — at a
 *    qualifier — the championship seats that place wins (a seat-winning bust is
 *    'bust' with seatsWon > 0); names are emit-time (opt-out → 'Player');
 *  - a deferred hand-for-hand bust is emitted ONCE, at its settle, with its final
 *    place (never at the provisional elimination);
 *  - levelUp / breakStart / breakEnd / lateRegClosed / tableBroken / finalTable /
 *    hfhOn / hfhOff / finished fire once each;
 *  - doubleUp: an ALL-IN winner whose stack at least doubled (a real hand);
 *  - the index.ts wiring: every hook is one guarded line.
 */
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PokerTable } from '../src/game/PokerTable';
import { registerBroadcast, type BroadcastHandle } from '../src/broadcast/wire';
import { doubleUpsOf } from '../src/broadcast/broadcastTicker';
import { TICKER_KINDS } from '../src/broadcast/contract';
import { SRC, fnSrc, slice } from './helpers/indexSource';
import { qualifierWorld, deepScanPublic, type BroadcastTestWorld } from './helpers/broadcastWorld';
import { rawClient, type RawClient } from './helpers/rawSocketClient';

async function rig(deferred: Set<string> = new Set()) {
  const http = createServer();
  const io = new Server(http);
  const w = qualifierWorld();
  const handle: BroadcastHandle = registerBroadcast(io, {
    world: w.world, realClientIp: () => '127.0.0.1', bannedIPs: new Set(), internalTokenMatches: () => false,
    isDeferredBust: (pid) => typeof pid === 'string' && deferred.has(pid), timers: false, log: () => {},
  });
  // The index.ts onEvent hook, on the REAL engine.
  w.tm.onEvent(w.tid, (event, data) => handle.hooks.tournamentEvent(w.tid, event, data));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const client = rawClient((http.address() as any).port, '/broadcast');
  expect((await client.ready).ok).toBe(true);
  // follow 'none' (2026-11-02, P2-S3): the ticker on the program stream; table frames are tested elsewhere.
  expect(await client.request('bc:subscribe', { v: 1, channel: 'weekly', layout: '16x9', follow: 'none' })).toMatchObject({ ok: true });
  const events = () => client.events('bc:frame').filter((f: any) => f.kind === 'event').map((f: any) => f.event);
  const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 150)); };
  const close = async () => { client.close(); handle.stop(); await new Promise<void>((d) => io.close(() => d())); };
  return { w, handle, client, events, flush, close };
}
const forbidden = (w: BroadcastTestWorld) => w.players.flatMap((p) => [p.playerId, p.masterId]);

describe('bust events: the final place, entries, the eliminator, the table, the seats won; emit-time names', () => {
  it('busts from 8th down to 3rd (seat package {1:3, 2:2, 3:1}): 8th..4th no seats; 3rd seatsWon 1; the opted-out bust shows "Player"; no account id on the wire', async () => {
    const r = await rig();
    try {
      const order = ['user-108', 'user-105', 'user-107', 'user-104', 'user-103'];   // Kim, Opt Out Guy, Avery…, 720-…, Zed
      for (const id of order) r.w.bust(id, 'user-101');
      await r.flush();
      const busts = r.events().filter((e: any) => e.kind === 'bust');
      expect(busts.map((b: any) => [b.place, b.of, b.name, b.byName, b.seatsWon ?? 0])).toEqual([
        [8, 8, 'Kim P.', 'John S.', 0], [7, 8, 'Player', 'John S.', 0], [6, 8, 'Player', 'John S.', 0], [5, 8, 'Player', 'John S.', 0], [4, 8, 'Zed', 'John S.', 0],
      ]);
      r.w.bust('user-102', 'user-101');                                               // Mary Ann Lee, 3rd: wins 1 seat
      await r.flush();
      const third = r.events().filter((e: any) => e.kind === 'bust').pop();
      expect(third).toMatchObject({ kind: 'bust', place: 3, of: 8, name: 'Mary L.', seatsWon: 1, tableNo: 2 });
      expect(third.pid).toMatch(/^b-[0-9a-f]{16}$/);
      expect(deepScanPublic(r.client.packets.map((p) => p.data), forbidden(r.w))).toEqual([]);
      for (const e of r.events()) expect(TICKER_KINDS).toContain(e.kind);
      // Frames carry consecutive seqs (one stream).
      const seqs = r.client.events('bc:frame').map((f: any) => f.seq);
      expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
    } finally { await r.close(); }
  });

  it('a DEFERRED hand-for-hand bust: nothing at the elimination; ONE bust at the settle with the FINAL place (handForHand: true)', async () => {
    const deferred = new Set<string>(['user-108']);
    const r = await rig(deferred);
    try {
      r.w.bust('user-108');                                                            // provisional: deferred
      await r.flush();
      expect(r.events().filter((e: any) => e.kind === 'bust')).toEqual([]);
      deferred.clear();
      r.handle.hooks.handForHandBust(r.w.tid, { playerId: 'user-108', position: 7 });   // the settle placed him 7th
      await r.flush();
      const busts = r.events().filter((e: any) => e.kind === 'bust');
      expect(busts).toHaveLength(1);
      expect(busts[0]).toMatchObject({ kind: 'bust', place: 7, name: 'Kim P.', handForHand: true });
    } finally { await r.close(); }
  });
});

describe('level, break, late reg, table broken, final table, hand-for-hand, finished — once each', () => {
  it('the engine / hook events and the observed ones (hfhOn/hfhOff, finalTable) each fire exactly once; the program ticker holds them, newest last', async () => {
    const r = await rig();
    try {
      r.handle.hooks.tournamentEvent(r.w.tid, 'blindLevelUp', { level: 2, sb: 50, bb: 100, ante: 0 });
      r.handle.hooks.tournamentEvent(r.w.tid, 'tournamentBreak', { afterLevel: 5, resumesAt: Date.now() + 300_000 });
      r.handle.hooks.tournamentEvent(r.w.tid, 'tournamentBreakEnded', { level: 6 });
      r.handle.hooks.tournamentEvent(r.w.tid, 'lateEntryClosedAtBubble', { alive: 4, closeAtAlive: 4 });
      r.handle.hooks.tournamentEvent(r.w.tid, 'tournamentPaused', { reason: 'director' });   // not a ticker kind
      await r.flush();
      // Hand-for-hand engages, then ends (observed by the 1 s flush; a second flush adds nothing).
      r.w.hfh.set(r.w.tid, { round: null });
      r.handle.tick(); r.handle.tick();
      r.w.hfh.delete(r.w.tid);
      r.handle.tick(); r.handle.tick();
      // Table 2 breaks (handleTableRebalance's hook, before it leaves the event), one table left.
      r.handle.hooks.tableBroken(r.w.tid, 'QT2');
      r.w.tm.removeTable(r.w.tid, 'QT2');
      r.handle.tick(); r.handle.tick();
      await r.flush();
      expect(r.events().map((e: any) => [e.kind, e.level ?? e.tableNo ?? null])).toEqual([
        ['levelUp', 2], ['breakStart', 5], ['breakEnd', 6], ['lateRegClosed', null],
        ['hfhOn', null], ['hfhOff', null], ['tableBroken', 2], ['finalTable', 1],
      ]);
      r.client.emit('bc:resync', {});
      const snap = await r.client.next((p) => p.type === 2 && p.data[0] === 'bc:snapshot');
      expect(snap!.data[1].program.ticker.map((e: any) => e.kind)).toEqual(['levelUp', 'breakStart', 'breakEnd', 'lateRegClosed', 'hfhOn', 'hfhOff', 'tableBroken', 'finalTable']);
      // The finish: one 'finished' with the winner.
      for (const id of ['user-108', 'user-107', 'user-106', 'user-105', 'user-104', 'user-103', 'user-102']) r.w.bust(id, 'user-101');
      await r.flush();
      expect(r.events().filter((e: any) => e.kind === 'finished')).toEqual([expect.objectContaining({ kind: 'finished', name: 'John S.', place: 1 })]);
    } finally { await r.close(); }
  });
});

describe('doubleUp — an ALL-IN winner whose stack at least doubled', () => {
  it('a real all-in hand at a qualifier table: the winner who doubled is in the ticker (name, hand number, table number)', async () => {
    const r = await rig();
    try {
      let seen: any[] = [];
      for (let attempt = 0; attempt < 10 && seen.length === 0; attempt++) {
        const id = `QT9-${attempt}`;
        const t = new PokerTable({ tableId: id, tableName: 'Qualifier Table 9', smallBlind: 25, bigBlind: 50, minBuyIn: 5000, maxBuyIn: 5000, maxPlayers: 9 } as any);
        t.sitDown(0, 'John Smith', 5000, 'user-101', false);
        t.sitDown(1, 'Zed', 5000, 'user-103', false);
        r.w.tables.set(id, t);
        r.w.tableOf.set(id, r.w.tid);
        t.on('handResult', (d: any) => r.handle.hooks.handResult(id, t, d.results));   // the index.ts hook
        expect(t.startNewHand()).toBe(true);
        expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
        for (let g = 0; g < 4 && t.isHandInProgress(); g++) t.playerCall(t.activeSeatIndex);
        await r.flush();
        seen = r.events().filter((e: any) => e.kind === 'doubleUp');
        if (seen.length) {
          const winner = t.seats.find((s) => s.chipCount >= 10_000)!;
          expect(seen).toEqual([expect.objectContaining({ kind: 'doubleUp', name: winner.playerName === 'Zed' ? 'Zed' : 'John S.', handNumber: t.handNumber, tableNo: 9 })]);
        }
      }
      expect(seen).toHaveLength(1);                                                   // a split pot doubles nobody: retried
    } finally { await r.close(); }
  });

  it('doubleUpsOf: all-in AND >= 2x the stack at the deal; once per seat; a non-all-in winner or 1.5x is not a double up', () => {
    const seats = [
      { seatIndex: 0, state: 'occupied', chipCount: 10_050, playerId: 'a', allIn: true, eliminated: false },
      { seatIndex: 1, state: 'occupied', chipCount: 12_000, playerId: 'b', allIn: false, eliminated: false },
      { seatIndex: 2, state: 'occupied', chipCount: 7_500, playerId: 'c', allIn: true, eliminated: false },
    ];
    const table = { config: { tableName: 'Qualifier Table 1' }, handNumber: 7, startChips: new Map([[0, 5000], [1, 5000], [2, 5000]]), seats };
    expect(doubleUpsOf(table, [{ seatIndex: 0 }, { seatIndex: 0 }, { seatIndex: 1 }, { seatIndex: 2 }])).toEqual([{ playerId: 'a', seatIndex: 0 }]);
    expect(doubleUpsOf(table, [])).toEqual([]);
  });
});

describe('index.ts wiring — one registerBroadcast call, every hook one guarded line', () => {
  it('the hooks sit where the design puts them, each in try/catch (never throws into the game)', () => {
    expect(SRC.match(/registerBroadcast\(io, \{/g)).toHaveLength(1);
    expect(SRC).toContain('let broadcastFeed: BroadcastHandle | null = null;');
    const guarded = SRC.match(/try \{ broadcastFeed\?\.hooks\.[a-zA-Z]+\([^)]*\); \} catch \(_\) \{ \/\* never \*\/ \}/g) || [];
    expect(guarded.map((g) => /hooks\.([a-zA-Z]+)/.exec(g)![1]).sort()).toEqual(
      ['handForHandBust', 'handResult', 'tableBroken', 'tableChanged', 'tournamentEvent', 'tournamentEvent'].sort());
    const bgs = fnSrc('function broadcastGameState(');
    expect(bgs.indexOf('broadcastFeed?.hooks.tableChanged(tableId)')).toBeGreaterThan(bgs.indexOf('armTurnTimer(tableId);'));
    expect(fnSrc('function emitHandForHandRoomBust(')).toContain('broadcastFeed?.hooks.handForHandBust(tournamentId, payload)');
    const reb = fnSrc('function handleTableRebalance(');
    expect(reb.indexOf('broadcastFeed?.hooks.tableBroken(tournamentId, breakTableId)')).toBeGreaterThan(reb.indexOf('tournamentManager.removeTable(tournamentId, breakTableId);'));
    const hr = slice("table.on('handResult', async (data: { results: any[]; handNumber: number }) => {", 'handleHandComplete(tableId, data.results)');
    expect(hr).toContain('broadcastFeed?.hooks.handResult(tableId, table, data.results)');
    for (const sig of ['function startTournamentGame(', 'function bootstrapTournamentTables(']) {
      const body = fnSrc(sig);
      const listener = body.indexOf('tournamentManager.onEvent(tournamentId, (event, data) => {');
      expect(listener).toBeGreaterThan(-1);
      const hook = body.indexOf('broadcastFeed?.hooks.tournamentEvent(tournamentId, event, data)', listener);
      expect(hook).toBeGreaterThan(listener);
      expect(hook).toBeLessThan(body.indexOf("if (event === 'blindLevelUp')", listener));
    }
    expect(SRC).toContain('...(broadcastFeed ? broadcastFeed.health() : { feedOn: false, registered: false }),');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['/broadcast', 'bc:subscribe', 'bc:heartbeat', 'bc:snapshot', 'feed_off', 'not_broadcastable', '/api/broadcast/events', '/api/broadcast/on-air', 'lateRegClosed', 'doubleUp']) {
      expect(manifest.split('\n')).toContain(tok);
    }
  });
});

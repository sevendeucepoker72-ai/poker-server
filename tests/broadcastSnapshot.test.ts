/**
 * 2026-11-02 (.online tournament broadcast, P2-S2) — the PUBLIC PROGRAM DATA
 * (src/broadcast/broadcastSnapshot.ts buildProgramData) and the EVENT KEYS
 * (src/broadcast/eventKey.ts), on the REAL TournamentManager and PokerTables.
 *
 * A hole-card leak on a public path is a P0: the program is deep-scanned over
 * dealt hands (mid-hand with hole cards dealt and a board out, an all-in
 * showdown, a fold win) for ANY {rank, suit} object (no hole cards AND no
 * community cards) and any id / seed / card key; the builder's source never
 * reads holeCards / communityCards / the deck.
 */
import fs from 'fs';
import path from 'path';
import { GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { buildProgramData, programSignature, autoSceneOf } from '../src/broadcast/broadcastSnapshot';
import { resolveEventKey, parseEventKey, NEXT_HOLD_FINISHED_MS } from '../src/broadcast/eventKey';
import { BROADCAST_LEGAL_LINE } from '../src/broadcast/contract';
import { qualifierStructure } from '../src/game/qualifierSchedule';
import { qualifierWorld, deepScanPublic, type BroadcastTestWorld } from './helpers/broadcastWorld';

function build(w: BroadcastTestWorld, mem?: any) {
  const r = resolveEventKey(w.world, `q:${w.qualId}`);
  if (!r.ok) throw new Error(`not resolved: ${r.code}`);
  return buildProgramData({ world: w.world, ev: r.ev, channel: 'weekly', now: Date.now(), ticker: [], rankMemory: mem });
}
const forbidden = (w: BroadcastTestWorld) => w.players.flatMap((p) => [p.playerId, p.masterId, `"${p.localUserId}"`]);

describe('S2 deep scan — the public program carries NO card (hole or board), NO id / seed key, over dealt hands', () => {
  it('mid-hand (hole cards dealt, a board out), after an all-in showdown, after a fold win: no {rank,suit}, no banned key, no account id', () => {
    const w = qualifierWorld();
    const [t1, t2] = [w.tables.get('QT1')!, w.tables.get('QT2')!];
    const scans: string[][] = [];
    const scan = () => { const b = build(w); scans.push(deepScanPublic({ program: b.program, tables: b.tables }, forbidden(w))); return b; };
    // Hand 1 at table 1: dealt; to the flop (call / check around).
    expect(t1.startNewHand()).toBe(true);
    expect(t1.seats.filter((s) => s.holeCards.length > 0).length).toBe(4);   // hole cards really are dealt
    scan();
    for (let g = 0; g < 12 && t1.currentPhase === GamePhase.PreFlop; g++) {
      const a = t1.activeSeatIndex;
      if (!t1.playerCall(a)) expect(t1.playerCheck(a)).toBe(true);
    }
    expect(t1.communityCards.length).toBeGreaterThanOrEqual(3);              // a board really is out
    scan();
    // Table 2: a fold win.
    expect(t2.startNewHand()).toBe(true);
    for (let g = 0; g < 8 && t2.isHandInProgress(); g++) expect(t2.playerFold(t2.activeSeatIndex)).toBe(true);
    expect(t2.currentPhase).toBe(GamePhase.HandComplete);
    scan();
    // Table 2 again: an ALL-IN showdown (run out, every hand tabled).
    expect(t2.startNewHand()).toBe(true);
    expect(t2.playerAllIn(t2.activeSeatIndex)).toBe(true);
    for (let g = 0; g < 8 && t2.isHandInProgress(); g++) expect(t2.playerCall(t2.activeSeatIndex)).toBe(true);
    expect(t2.currentPhase).toBe(GamePhase.HandComplete);
    expect(t2.wentToShowdown).toBe(true);
    const last = scan();
    for (const s of scans) expect(s).toEqual([]);
    // The program says what it should (sanity: the scan scanned real data).
    expect(last.program.standings.leaders.length).toBeGreaterThan(0);
    expect(last.tables.map((x) => x.tableNo)).toEqual([1, 2]);
    expect(JSON.stringify(last)).not.toMatch(/"suit"\s*:/);
  });

  it('the builder never reads a card: no holeCards / communityCards / deck access in the broadcast sources (comments stripped)', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    for (const f of ['broadcastSnapshot.ts', 'broadcastTicker.ts', 'eventKey.ts', 'broadcastNames.ts']) {
      const src = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'broadcast', f), 'utf8'));
      expect({ f, hits: src.match(/holeCards|communityCards|\.deck\b|revealSeed|\.seed\b/g) }).toEqual({ f, hits: null });
    }
    const wire = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'broadcast', 'wire.ts'), 'utf8'));
    // wire.ts: only the Feed flag `holeCards: false` (the public feed says so); never a read.
    expect(wire.match(/\.holeCards|communityCards|\.deck\b|revealSeed|\.seed\b/g)).toBeNull();
    expect(wire.match(/holeCards/g)).toEqual(['holeCards']);
    expect(wire).toContain("holeCards: false");
  });
});

describe('S2 — names, keys, leaders, average stack, seat package, bubble', () => {
  it('names: First L. / alias / "Player" for phone-like, over-20, opted out and UNKNOWN opt-out; keys are opaque and stable across builds', () => {
    const w = qualifierWorld();
    const a = build(w);
    const b = build(w);
    const byRaw = new Map(w.players.map((p) => [p.playerId, p.name]));
    const names = a.program.standings.leaders.map((l) => l.name).sort();
    expect(names).toEqual(['John S.', 'Kim P.', 'Mary L.', 'Player', 'Player', 'Player', 'Player', 'Zed'].sort());
    for (const l of a.program.standings.leaders) expect(l.name === 'Player' || /^[A-Za-z0-9 _.'-]+$/.test(l.name)).toBe(true);
    expect(a.program.standings.leaders.map((l) => l.pid)).toEqual(b.program.standings.leaders.map((l) => l.pid));
    for (const l of a.program.standings.leaders) {
      expect(l.pid).toMatch(/^b-[0-9a-f]{16}$/);
      for (const id of byRaw.keys()) expect(l.pid).not.toContain(id);
    }
    expect(programSignature(a.program)).toBe(programSignature(b.program));
    expect(a.program.legal).toEqual({ line: BROADCAST_LEGAL_LINE, platformLine: null });
    expect(BROADCAST_LEGAL_LINE).toBe('Free to play · Play money only · No purchase necessary · 21+ to enter.');
  });

  it('leaders sorted by chips (rank 1..n, bb = chips / big blind); prevRank follows the order BEFORE the latest change; avgStack = entries x start / alive', () => {
    const w = qualifierWorld();
    const seatOf = (name: string) => [...w.tables.values()].flatMap((t) => t.seats).find((s) => s.playerName === name)!;
    // Review fix (flake ~1 in 56): a DETERMINISTIC starting order. With all eight stacks equal,
    // ties rank by the opaque pid (random per process), and when Kim already ranked 1st and Zed
    // 8th the change below did not move the order (prevRank then correctly stays null). Zed
    // starts 1st and Kim 8th, so the change always reorders.
    seatOf('Zed').chipCount = 5100;
    seatOf('Kim Park').chipCount = 4900;
    const a = build(w);
    expect(a.program.standings.leaders.map((l) => l.prevRank)).toEqual(Array(8).fill(null));
    expect(a.program.standings.leaders[0].name).toBe('Zed');
    expect(a.program.standings.leaders[7].name).toBe('Kim P.');
    // Kim Park (Qualifier Table 2) wins big; Zed (Table 1) loses chips.
    seatOf('Kim Park').chipCount = 9000;
    seatOf('Zed').chipCount = 1000;
    const b = build(w, a.rankMemory);
    const chips = b.program.standings.leaders.map((l) => l.chips);
    expect([...chips].sort((x, y) => y - x)).toEqual(chips);
    expect(b.program.standings.leaders[0]).toMatchObject({ name: 'Kim P.', chips: 9000, bb: 180, rank: 1, tableNo: 2 });
    expect(b.program.standings.leaders[7]).toMatchObject({ name: 'Zed', chips: 1000, rank: 8, tableNo: 1 });
    // Equal stacks rank by the opaque pid (random per process): her rank BEFORE the change is whatever it was.
    const kimBefore = a.program.standings.leaders.find((l) => l.name === 'Kim P.')!.rank;
    const kimPrev = b.program.standings.leaders[0].prevRank;
    expect(kimPrev).toBe(kimBefore);
    expect(b.program.standings.leaders[7].prevRank).toBe(a.program.standings.leaders.find((l) => l.name === 'Zed')!.rank);
    // No change since: prevRank stays (the arrow stays up until the order moves again).
    const c = build(w, b.rankMemory);
    expect(c.program.standings.leaders[0].prevRank).toBe(kimPrev);
    expect(b.program.standings).toMatchObject({ playersLeft: 8, entries: 8, avgStack: 5000, avgStackBb: 100, tables: 2 });
    w.bust('user-104');
    const d = build(w, c.rankMemory);
    expect(d.program.standings).toMatchObject({ playersLeft: 7, entries: 8, avgStack: Math.round((8 * 5000) / 7) });
    // With a clock, its avgStack (index.ts tournamentClockStateFor) is used as is.
    w.clock.value = { level: 1, bb: 50, avgStack: 1234, serverNow: Date.now(), pauseReason: null, dealsAt: null };
    expect(build(w).program.standings.avgStack).toBe(1234);
  });

  it('seat package rows + the bubble flag; the clock and late reg; the event fields', () => {
    const w = qualifierWorld();
    const p = build(w).program;
    expect(p.event).toMatchObject({
      kind: 'weekly', qualifierId: w.qualId, tournamentId: w.tid, name: 'Sunday Weekly Qualifier', status: 'running',
      registered: 8, entries: 8, startingStack: 5000,
    });
    expect(p.event.prizes).toEqual({
      kind: 'seats', seatsForTop: 3, seatPackage: { 1: 3, 2: 2, 3: 1 }, paidPlaces: 3,
      rows: [{ place: 1, seats: 3 }, { place: 2, seats: 2 }, { place: 3, seats: 1 }], bubblePlace: 4, onBubble: false,
    });
    expect(p.event.lateReg.open).toBe(true);
    expect(p.event.levels).toEqual(qualifierStructure(5000).levels);   // the lobby's advertised structure, scaled to the stack
    for (const id of ['user-101', 'user-102', 'user-103', 'user-105']) w.bust(id);
    const q = build(w).program;
    expect(q.standings.playersLeft).toBe(4);
    expect(q.event.prizes.onBubble).toBe(true);
    expect(q.scene).toMatchObject({ id: 'table', auto: true });
  });

  it('hand-for-hand: per-table waiting / playing / done from the round; the scene says hfh', () => {
    const w = qualifierWorld();
    const [t1, t2] = [w.tables.get('QT1')!, w.tables.get('QT2')!];
    w.hfh.set(w.tid, { round: null });
    let p = build(w).program;
    expect(p.handForHand).toEqual({ on: true, round: null, tables: [{ tableId: 'QT1', tableNo: 1, state: 'waiting' }, { tableId: 'QT2', tableNo: 2, state: 'waiting' }] });
    expect(p.scene.id).toBe('hfh');
    const base = new Map([['QT1', t1.handNumber], ['QT2', t2.handNumber]]);
    expect(t1.startNewHand()).toBe(true);
    for (let g = 0; g < 8 && t1.isHandInProgress(); g++) t1.playerFold(t1.activeSeatIndex);
    expect(t2.startNewHand()).toBe(true);
    w.hfh.set(w.tid, { round: { no: 2, base, attempted: new Set(['QT1', 'QT2']) } });
    p = build(w).program;
    expect(p.handForHand).toEqual({ on: true, round: 2, tables: [{ tableId: 'QT1', tableNo: 1, state: 'done' }, { tableId: 'QT2', tableNo: 2, state: 'playing' }] });
    w.hfh.delete(w.tid);
    expect(build(w).program.handForHand).toBeNull();
  });

  it('the final table: one table left → finalTable seats (pid, name, chips); the scene machine hints', () => {
    const w = qualifierWorld({ tables: 1, names: ['John Smith', 'Zed', 'Kim Park'] });
    const p = build(w).program;
    expect(p.finalTable!.seats.map((s) => s.name)).toEqual(['John S.', 'Zed', 'Kim P.']);
    expect(p.finalTable!.seats.every((s) => /^b-[0-9a-f]{16}$/.test(s.pid))).toBe(true);
    expect(autoSceneOf('registering', null, false)).toBe('starting');
    expect(autoSceneOf('running', { pauseReason: 'break' }, false)).toBe('break');
    expect(autoSceneOf('finished', null, false)).toBe('results');
  });

  it('finished results honour the opt-out (and unknown → "Player"); seats won; no account id', () => {
    const w = qualifierWorld();
    w.qt.status = 'finished';
    w.qt.finishedAt = Date.now();
    w.qt.results = [
      { masterUserId: 'm-0000-105', playerName: 'Opt Out Guy', place: 2, wonSeat: true, seats: 2 },
      { masterUserId: 'm-0000-101', playerName: 'John Smith', place: 1, wonSeat: true, seats: 3 },
      { masterUserId: 'm-0000-106', playerName: 'Unknown Person', place: 3, wonSeat: true, seats: 1 },
      { masterUserId: 'm-0000-108', playerName: 'Kim Park', place: 4, wonSeat: false, seats: 0 },
    ];
    const b = build(w);
    expect(b.program.event.status).toBe('finished');
    expect(b.program.scene.id).toBe('results');
    expect(b.program.results!.map((r) => [r.place, r.name, r.seatsWon])).toEqual([[1, 'John S.', 3], [2, 'Player', 2], [3, 'Player', 1], [4, 'Kim P.', 0]]);
    expect(deepScanPublic(b.program, forbidden(w))).toEqual([]);
    // A later opt-out applies to the results too (names resolved at emit time).
    w.optOuts.set(101, true);
    expect(build(w).program.results![0].name).toBe('Player');
  });
});

describe('S2 — event keys: q:, t:, next:, not_broadcastable', () => {
  it('parseEventKey accepts only the four shapes', () => {
    expect(parseEventKey('q:abc-1')).toEqual({ kind: 'q', id: 'abc-1' });
    expect(parseEventKey('t:7f1c')).toEqual({ kind: 't', id: '7f1c' });
    expect(parseEventKey('next:weekly')).toEqual({ kind: 'next', type: 'weekly' });
    for (const bad of ['next:daily', 'x:1', 'q:', 'q:<script>', 42, null, `q:${'a'.repeat(200)}`]) expect(parseEventKey(bad)).toBeNull();
  });

  it('t:<qualifier tournament> → the qualifier; a template Sit & Go → ok (Sit & Go streaming on; off → not_broadcastable); a club (unlisted) or custom tournament → not_broadcastable; unknown → event_not_found', () => {
    const w = qualifierWorld();
    const r = resolveEventKey(w.world, `t:${w.tid}`);
    expect(r).toMatchObject({ ok: true, ev: { key: `q:${w.qualId}`, kind: 'weekly', qualifierId: w.qualId, tournamentId: w.tid } });
    const tm = w.tm;
    const template = tm.tournamentIdsWithStatus('registering').map((id) => tm.getTournament(id)!).find((t) => t.config.fromTemplate)!;
    expect(template).toBeDefined();
    // Fix round 2: a Sit & Go is broadcastable only while Sit & Go streaming is on (env BROADCAST_SITGO=1 → the world's switch).
    expect(resolveEventKey(w.world, `t:${template.config.tournamentId}`)).toEqual({ ok: false, code: 'not_broadcastable' });
    expect(resolveEventKey({ ...w.world, sitGoBroadcastOn: () => true }, `t:${template.config.tournamentId}`)).toMatchObject({ ok: true, ev: { kind: 'sitgo', qualifierId: null } });
    const custom = tm.createTournament({ name: 'My Home Game', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    expect(resolveEventKey(w.world, `t:${custom}`)).toEqual({ ok: false, code: 'not_broadcastable' });
    const club = tm.createTournament({ name: 'Club Night', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, unlisted: true, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any, { fromTemplate: true });
    expect(resolveEventKey(w.world, `t:${club}`)).toEqual({ ok: false, code: 'not_broadcastable' });
    expect(resolveEventKey(w.world, 't:nope')).toEqual({ ok: false, code: 'event_not_found' });
    expect(resolveEventKey(w.world, 'q:nope')).toEqual({ ok: false, code: 'event_not_found' });
  });

  it('next:weekly → a running one; else one finished < 2 h ago (not cancelled); else the soonest unfinished; main spans both kinds', () => {
    const now = Date.now();
    const reg = new Map<string, any>();
    const mk = (id: string, type: string, status: string, atOffsetMs: number, extra: Record<string, unknown> = {}) =>
      reg.set(id, { qualifierType: type, qualifierName: id, scheduledAt: new Date(now + atOffsetMs).toISOString(), startingStack: 50000, players: [], status, tournamentId: null, ...extra });
    const world: any = { now: () => now, qualifiers: () => reg.entries(), tournament: () => undefined, isQualifierEngineTournament: () => false };
    mk('W-next', 'weekly', 'registering', 6 * 86400_000);
    mk('W-later', 'weekly', 'registering', 13 * 86400_000);
    mk('M-next', 'monthly', 'registering', 3 * 86400_000);
    expect(resolveEventKey(world, 'next:weekly')).toMatchObject({ ok: true, ev: { key: 'q:W-next', kind: 'weekly' } });
    expect(resolveEventKey(world, 'next:monthly')).toMatchObject({ ok: true, ev: { key: 'q:M-next', kind: 'monthly' } });
    expect(resolveEventKey(world, 'next:any')).toMatchObject({ ok: true, ev: { key: 'q:M-next' } });
    mk('W-done', 'weekly', 'finished', -5 * 3600_000, { finishedAt: now - 60 * 60_000 });
    expect(resolveEventKey(world, 'next:weekly')).toMatchObject({ ev: { key: 'q:W-done' } });   // results stay on air
    reg.get('W-done').finishedAt = now - NEXT_HOLD_FINISHED_MS - 1;
    expect(resolveEventKey(world, 'next:weekly')).toMatchObject({ ev: { key: 'q:W-next' } });
    mk('W-cancel', 'weekly', 'finished', -60_000, { finishedAt: now - 60_000, cancelled: true });
    expect(resolveEventKey(world, 'next:weekly')).toMatchObject({ ev: { key: 'q:W-next' } });
    mk('W-live', 'weekly', 'running', -30 * 60_000);
    expect(resolveEventKey(world, 'next:weekly')).toMatchObject({ ev: { key: 'q:W-live' } });
    expect(resolveEventKey(world, 'next:any')).toMatchObject({ ev: { key: 'q:W-live' } });
    reg.clear();
    expect(resolveEventKey(world, 'next:weekly')).toEqual({ ok: false, code: 'event_not_found' });
  });
});

describe('S2 — a Sit & Go program: chips prizes, results with amounts', () => {
  it('a running template Sit & Go: kind sitgo, prizes kind chips from its payout table; finished: results with amounts, opt-out applied', () => {
    const tm = new TournamentManager();
    const t = tm.tournamentIdsWithStatus('registering').map((id) => tm.getTournament(id)!).find((x) => x.config.fromTemplate && (x.config.buyIn || 0) > 0)!;
    expect(t).toBeDefined();
    const tid = t.config.tournamentId;
    const names = ['John Smith', 'Mary Ann Lee', 'Zed'];
    names.forEach((n, i) => tm.registerPlayer(tid, `user-${201 + i}`, n, `s${i}`, 201 + i));
    t.collectedEntryFees = (t.config.buyIn || 0) * names.length;
    expect(tm.startTournament(tid)).toBeTruthy();
    const optOuts = new Map<number, boolean>([[201, false], [202, true], [203, false]]);
    const world: any = {
      now: () => Date.now(), qualifiers: () => new Map().entries(), tournament: (id: string) => tm.getTournament(id),
      isQualifierEngineTournament: () => false, table: () => undefined, clockOf: () => null, handForHandOf: () => null,
      payoutTableOf: (id: string) => { const x = tm.getTournament(id); return x ? tm.payoutTableOf(x) : null; },
      lateEntryClosedAtBubble: () => null, optOut: (ids: any) => optOuts.get(ids.userId),
      sitGoBroadcastOn: () => true,   // fix round 2: Sit & Go streaming on (env BROADCAST_SITGO=1)
    };
    const r = resolveEventKey(world, `t:${tid}`);
    expect(r.ok).toBe(true);
    const ev = (r as any).ev;
    let p = buildProgramData({ world, ev, channel: 'sitgo', now: Date.now(), ticker: [] }).program;
    expect(p.event).toMatchObject({ kind: 'sitgo', qualifierId: null, tournamentId: tid, status: 'running' });
    expect(p.event.prizes.kind).toBe('chips');
    expect(p.event.prizes.rows.length).toBeGreaterThan(0);
    expect(p.event.prizes.rows.every((x) => typeof x.amount === 'number' && x.amount > 0)).toBe(true);
    tm.eliminatePlayer(tid, 'user-203', 'user-201');
    tm.eliminatePlayer(tid, 'user-202', 'user-201');
    p = buildProgramData({ world, ev, channel: 'sitgo', now: Date.now(), ticker: [] }).program;
    expect(p.event.status).toBe('finished');
    expect(p.results!.map((x) => [x.place, x.name])).toEqual([[1, 'John S.'], [2, 'Player'], [3, 'Zed']]);
    expect(p.results![0].amount).toBeGreaterThan(0);
    expect(deepScanPublic(p, ['user-201', 'user-202', 'user-203'])).toEqual([]);
  });
});

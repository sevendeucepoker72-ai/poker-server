/**
 * 2026-11-02 (.online tournament broadcast, P2-S3) — THE PUBLIC TABLE FRAME
 * (src/broadcast/broadcastFrame.ts toBroadcastTableFrame) on REAL PokerTables.
 *
 * A hole-card leak on a public path is a P0. Proven three ways:
 *  1. the builder NEVER reads seat.holeCards: over many real hands, every frame is
 *     built a second time from a view whose seats' holeCards getter THROWS — no
 *     throw, and the two frames are identical;
 *  2. every frame passes the frame-aware deep scan (faces only at a contested
 *     showdown, for seats that did not fold or muck; no id / name / seed key);
 *  3. the source has no seat hole-card read (only the engine's showdown record).
 * Plus: names rewritten (First L. / alias / 'Player') in seats AND winners; a fold
 * win and an auto-muck show nothing; the board; liveHandEndedAt passes through.
 */
import fs from 'fs';
import path from 'path';
import { GamePhase, PokerTable } from '../src/game/PokerTable';
import { toBroadcastTableFrame, showdownReveal, seatIdentityResolver, type FrameTableView } from '../src/broadcast/broadcastFrame';
import { resolveEventKey } from '../src/broadcast/eventKey';
import { qualifierWorld, deepScanBroadcast } from './helpers/broadcastWorld';

const names: Record<string, string> = { a: 'John Smith', b: 'Mary Ann Lee', c: 'Zed', d: '720-555-1234' };
const identityOf = (s: { playerId: string; playerName: string }) => ({ pid: `b-${'0'.repeat(15)}${'abcd'.indexOf(s.playerId)}`, name: s.playerId === 'd' ? 'Player' : (s.playerId === 'b' ? 'Mary L.' : (s.playerId === 'a' ? 'John S.' : 'Zed')) });

function table4(id = 'T1'): PokerTable {
  const t = new PokerTable({ tableId: id, tableName: 'Qualifier Table 1', smallBlind: 25, bigBlind: 50, minBuyIn: 5000, maxBuyIn: 5000, maxPlayers: 9 } as any);
  ['a', 'b', 'c', 'd'].forEach((pid, i) => t.sitDown(i, names[pid], 5000, pid, false));
  return t;
}

/** The same table seen through seats whose holeCards THROW; the engine's methods stay bound to the real table. */
function trapView(t: PokerTable): FrameTableView {
  const seats = t.seats.map((s) => {
    const o: any = {
      seatIndex: s.seatIndex, state: s.state, playerName: s.playerName, playerId: s.playerId, isAI: s.isAI,
      chipCount: s.chipCount, currentBet: s.currentBet, folded: s.folded, allIn: s.allIn, eliminated: s.eliminated,
    };
    Object.defineProperty(o, 'holeCards', { get() { throw new Error(`seat ${s.seatIndex} holeCards READ by the broadcast frame builder`); } });
    return o;
  });
  return {
    config: t.config, seats, handNumber: t.handNumber, currentPhase: t.currentPhase, communityCards: t.communityCards.slice(),
    dealerButtonSeat: t.dealerButtonSeat, smallBlindSeat: t.smallBlindSeat, previousBigBlindSeat: t.previousBigBlindSeat,
    deadSmallBlind: t.deadSmallBlind, activeSeatIndex: t.activeSeatIndex, handSmallBlind: t.handSmallBlind, handBigBlind: t.handBigBlind,
    handAnte: t.handAnte, maxOccupiableSeats: t.maxOccupiableSeats, wentToShowdown: t.wentToShowdown, lastHandResult: t.lastHandResult,
    actionLog: t.actionLog.slice(),
    getTotalPot: () => t.getTotalPot(),
    getCurrentPots: () => t.getCurrentPots(),
    showdownMuckedSeats: () => t.showdownMuckedSeats(),
    isDealtOut: (i: number) => t.isDealtOut(i),
  };
}

const ctx = (over: Record<string, unknown> = {}) => ({ now: 1_000, tableNo: 1, featured: true, identityOf, ...over });

/** Builds the frame from the real table AND the trap view; both must agree and scan clean. */
function frameChecked(t: PokerTable, problems: string[]) {
  const real = toBroadcastTableFrame(t, ctx());
  let trapped: any = null;
  try { trapped = toBroadcastTableFrame(trapView(t), ctx()); } catch (e: any) { problems.push(String(e?.message || e)); }
  if (trapped && JSON.stringify(trapped) !== JSON.stringify(real)) problems.push(`trap frame differs at hand ${t.handNumber} ${t.currentPhase}`);
  problems.push(...deepScanBroadcast(real, ['John Smith', 'Mary Ann Lee', '720-555-1234']));
  return real;
}

/** One random action for the seat to act. */
function act(t: PokerTable, rnd: () => number): void {
  const a = t.activeSeatIndex;
  const r = rnd();
  if (r < 0.2 && t.playerFold(a)) return;
  if (r < 0.3 && t.playerAllIn(a)) return;
  if (t.playerCheck(a)) return;
  if (t.playerCall(a)) return;
  t.playerFold(a);
}

describe('P2-S3 frame — the builder never reads seat.holeCards (trap seats), over many real hands', () => {
  it('40 hands, every state: the trap view never throws, equals the real frame, and scans clean', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const problems: string[] = [];
    let showdowns = 0;
    let shownSeats = 0;
    let foldWins = 0;
    let t = table4();
    for (let hand = 0; hand < 40; hand++) {
      if (t.seats.filter((s) => s.state === 'occupied' && s.chipCount > 0).length < 2) t = table4(`T${hand}`);
      for (const s of t.seats) if (s.state === 'occupied' && s.chipCount <= 0) { s.chipCount = 5000; s.eliminated = false; }
      expect(t.startNewHand()).toBe(true);
      frameChecked(t, problems);
      for (let g = 0; g < 60 && t.isHandInProgress(); g++) {
        act(t, rnd);
        frameChecked(t, problems);
      }
      const f = frameChecked(t, problems);
      expect(t.currentPhase).toBe(GamePhase.HandComplete);
      if (t.wentToShowdown) { showdowns++; shownSeats += f.seats.filter((s) => s.holeCards).length; }
      else { foldWins++; expect(f.seats.every((s) => s.holeCards === null)).toBe(true); }
    }
    expect(problems).toEqual([]);
    // The run really covered both kinds of endings, with faces at the showdowns.
    expect(showdowns).toBeGreaterThan(3);
    expect(foldWins).toBeGreaterThan(3);
    expect(shownSeats).toBeGreaterThan(showdowns);
  });

  it('the sources: broadcastFrame.ts reads hole cards only from the engine\'s showdown record (h.holeCards); no other broadcast module reads any', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const src = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'broadcast', 'broadcastFrame.ts'), 'utf8'));
    const reads = [...src.matchAll(/(\w+)\??\.holeCards/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThan(0);
    expect([...new Set(reads)]).toEqual(['h']);
    expect(src).not.toMatch(/\.deck\b|revealSeed|\.seed\b|publicId|yourCards/);
    for (const f of ['featuredTable.ts', 'programStore.ts', 'producer.ts', 'broadcastToken.ts']) {
      // 2026-11-02 (P5) — the producer's hole-card SWITCH is named holeCardsSwitch (the event
      // 'bc:producer:holeCardsSwitch' and its audit action): a name, not a card. Exactly that
      // word is set aside; any other hit still fails.
      const s = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'broadcast', f), 'utf8')).replace(/\bholeCardsSwitch\b/g, 'P5_SWITCH_NAME');
      expect({ f, hits: s.match(/holeCards|communityCards|\.deck\b|revealSeed|\.seed\b/g) }).toEqual({ f, hits: null });
    }
  });
});

describe('P2-S3 frame — what a public frame shows', () => {
  it('mid-hand: card backs only (hasCards), no faces, the board once out; names and pids rewritten; no playerName / publicId / yourCards / playerId', () => {
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    const f0 = toBroadcastTableFrame(t, ctx());
    expect(f0.seats.map((s) => [s.seatIndex, s.name, s.hasCards, s.holeCards])).toEqual([
      [0, 'John S.', true, null], [1, 'Mary L.', true, null], [2, 'Zed', true, null], [3, 'Player', true, null],
    ]);
    expect(f0.board).toEqual([]);
    expect(f0.handResult).toBeNull();
    expect(f0.liveHandEndedAt).toBeNull();
    for (let g = 0; g < 12 && t.currentPhase === GamePhase.PreFlop; g++) { const a = t.activeSeatIndex; if (!t.playerCall(a)) t.playerCheck(a); }
    const f1 = toBroadcastTableFrame(t, ctx());
    expect(f1.board).toHaveLength(3);
    expect(f1.board.every((c) => Object.keys(c).sort().join() === 'rank,suit')).toBe(true);
    expect(f1.seats.every((s) => s.holeCards === null)).toBe(true);
    const json = JSON.stringify(f1);
    for (const k of ['playerName', 'publicId', 'yourCards', 'playerId', 'John Smith', 'Mary Ann Lee', '720-555']) expect(json).not.toContain(k);
    expect(f1.lastAction).toMatchObject({ text: expect.stringMatching(/^(called|checked) ?\d*$/) });
    expect(f1).toMatchObject({ tableId: 'T1', tableNo: 1, tableName: 'Qualifier Table 1', maxSeats: 9, featured: true, handLevel: { sb: 25, bb: 50, ante: 0 } });
  });

  it('a fold win shows nothing: no faces, winner without a hand name, showdownSeats []', () => {
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) t.playerFold(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(t.wentToShowdown).toBe(false);
    const f = toBroadcastTableFrame(t, ctx({ liveHandEndedAt: 999 }));
    expect(f.seats.every((s) => s.holeCards === null)).toBe(true);
    expect(f.handResult).toEqual({ winners: [expect.objectContaining({ seatIndex: expect.any(Number), name: expect.any(String), amount: expect.any(Number) })], showdownSeats: [], muckedSeats: [] });
    expect(f.handResult!.winners[0]).not.toHaveProperty('handName');
    expect(f.liveHandEndedAt).toBe(999);
  });

  it('a contested all-in showdown shows exactly the tabled hands (the engine\'s showdown record), with hand names; folded seats show nothing', () => {
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    const folder = t.activeSeatIndex;
    expect(t.playerFold(folder)).toBe(true);
    expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) if (!t.playerCall(t.activeSeatIndex)) t.playerFold(t.activeSeatIndex);
    expect(t.wentToShowdown).toBe(true);
    const f = toBroadcastTableFrame(t, ctx());
    const tabled = new Map(t.lastHandResult!.showdownHands.map((h) => [h.seatIndex, h]));
    for (const s of f.seats) {
      if (s.seatIndex === folder) { expect(s.holeCards).toBeNull(); continue; }
      const h = tabled.get(s.seatIndex);
      if (h && !s.folded) {
        expect(s.holeCards).toEqual(h.holeCards.map((c) => ({ rank: c.rank, suit: c.suit })));
        expect(s.handName).toBe(h.handName);
      } else expect(s.holeCards).toBeNull();
    }
    expect(f.handResult!.showdownSeats).toEqual([...tabled.keys()].filter((i) => !t.seats[i].folded).sort((a, b) => a - b));
    expect(deepScanBroadcast(f)).toEqual([]);
  });

  it('an auto-muck (a losing hand that did not have to be shown) shows nothing for that seat: mucked: true, in muckedSeats', () => {
    let found = false;
    for (let attempt = 0; attempt < 60 && !found; attempt++) {
      const t = table4(`M${attempt}`);
      expect(t.startNewHand()).toBe(true);
      for (let g = 0; g < 40 && t.isHandInProgress(); g++) { const a = t.activeSeatIndex; if (!t.playerCheck(a)) t.playerCall(a); }
      const mucked = t.showdownMuckedSeats();
      if (mucked.size === 0) continue;
      found = true;
      const f = toBroadcastTableFrame(t, ctx());
      for (const i of mucked) {
        const s = f.seats.find((x) => x.seatIndex === i)!;
        expect(s).toMatchObject({ mucked: true, holeCards: null });
        expect(s).not.toHaveProperty('handName');
      }
      expect(f.handResult!.muckedSeats).toEqual([...mucked].sort((a, b) => a - b));
      expect(f.handResult!.showdownSeats.some((i) => mucked.has(i))).toBe(false);
      expect(deepScanBroadcast(f)).toEqual([]);
    }
    expect(found).toBe(true);
  });

  it('showdownReveal fails closed: a throwing muck rule, another hand\'s record or a live phase reveal nothing', () => {
    const t = table4();
    expect(t.startNewHand()).toBe(true);
    expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
    for (let g = 0; g < 8 && t.isHandInProgress(); g++) t.playerCall(t.activeSeatIndex);
    expect(showdownReveal(t).shown.size).toBeGreaterThan(0);
    expect(showdownReveal({ ...trapView(t), showdownMuckedSeats: () => { throw new Error('x'); } }).shown.size).toBe(0);
    expect(showdownReveal({ ...trapView(t), handNumber: t.handNumber + 1 }).shown.size).toBe(0);
    expect(showdownReveal({ ...trapView(t), currentPhase: 'River' }).shown.size).toBe(0);
    expect(showdownReveal({ ...trapView(t), wentToShowdown: false }).shown.size).toBe(0);
  });

  it('seatIdentityResolver: First L. / alias / Player (opted out, unknown, phone-like), opaque per-event pids; never the raw name', () => {
    const w = qualifierWorld();
    const r = resolveEventKey(w.world, `q:${w.qualId}`);
    if (!r.ok) throw new Error('no event');
    const idOf = seatIdentityResolver(w.world, r.ev);
    const t1 = w.tables.get('QT1')!;
    const ids = t1.seats.filter((s) => s.state === 'occupied').map((s) => idOf(s));
    expect(ids.map((x) => x.name)).toEqual(['John S.', 'Zed', 'Player', 'Player']);   // John, Zed, Opt Out Guy, Averyvery… (over 20)
    for (const x of ids) expect(x.pid).toMatch(/^b-[0-9a-f]{16}$/);
    const f = toBroadcastTableFrame(t1, { now: 5, tableNo: 1, featured: false, identityOf: idOf });
    expect(deepScanBroadcast(f, w.players.flatMap((p) => [p.playerId, p.masterId, p.name]).filter((s) => s !== 'Zed'))).toEqual([]);
  });
});

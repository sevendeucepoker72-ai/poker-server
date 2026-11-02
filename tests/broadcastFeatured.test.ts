/**
 * 2026-11-02 (.online tournament broadcast, P2-S3) — THE FEATURED TABLE:
 *  - the pure recommender (src/broadcast/featuredTable.ts): final table forced, a
 *    producer lock (held, expired, broken), never away from a contested all-in,
 *    dwell + margin hysteresis at the hand boundary, the all-in cut after 20 s,
 *    chip-leader preference, deterministic tie-break, auto off;
 *  - on the REAL namespace (in-process socket.io + raw clients): the featured
 *    table's frames reach followers of the program (bc:tbl:<tableId> rooms, never a
 *    `table:` room), coalesced to 5 Hz, ONE seq per stream across program / event /
 *    table frames; a table break re-points followers in place (a 'featured' event +
 *    a fresh full frame); one table left = 'final_table'; a pinned table; follow
 *    'none' gets no table frame; frames carry no hole card outside a contested
 *    showdown (frame-aware deep scan).
 */
import { recommendFeatured, scoreTable, FEATURED_RULES, type FeaturedTableInput, type FeaturedState } from '../src/broadcast/featuredTable';
import { BROADCAST_TABLE_MIN_INTERVAL_MS } from '../src/broadcast/contract';
import { broadcastRig, settle, framesOf, type Rig } from './helpers/broadcastRig';
import { deepScanBroadcast } from './helpers/broadcastWorld';

const T = (id: string, order: number, o: Partial<FeaturedTableInput> = {}): FeaturedTableInput => ({
  tableId: id, order, tableNo: order + 1, tableName: `Qualifier Table ${order + 1}`, alive: 6, handInProgress: true, contestedAllIn: false,
  pot: 0, chipLeaderHere: false, topThreeHere: 0, shortStackPressure: false, ...o,
});
const CTX = { avgStack: 10_000 };
const at = (tableId: string, since: number, mode: FeaturedState['mode'] = 'auto'): FeaturedState => ({ tableId, mode, reason: null, since });

describe('S3 recommender — the rules', () => {
  it('first pick: the best score (chip leader preferred), ties by table order; no "changed" on the first pick', () => {
    const d = recommendFeatured([T('A', 0), T('B', 1, { chipLeaderHere: true }), T('C', 2)], CTX, null, 1000);
    expect(d.state).toEqual({ tableId: 'B', mode: 'auto', reason: 'chip_leader', since: 1000 });
    expect(d.changed).toBe(false);
    expect(recommendFeatured([T('A', 0), T('B', 1)], CTX, null, 1).state.tableId).toBe('A');
    expect(recommendFeatured([T('B', 1), T('A', 0)], CTX, null, 1).state.tableId).toBe('A');
    expect(scoreTable(T('X', 0, { alive: 5, contestedAllIn: true, pot: 20_000, chipLeaderHere: true, topThreeHere: 2, shortStackPressure: true }), CTX)).toBe(10 + 80 + 40 + 25 + 20 + 20);
  });

  it('one table left is forced: mode final_table — over a producer lock too', () => {
    const d = recommendFeatured([T('A', 0)], CTX, at('B', 0), 5000, { lock: { tableId: 'B', until: null } });
    expect(d.state).toMatchObject({ tableId: 'A', mode: 'final_table', reason: 'final_table', since: 5000 });
    expect(d.changed).toBe(true);
  });

  it('a producer lock holds (no matter the scores) until it expires; then the same table on auto (no change); a lock on a table that left the event → the best, table_broken', () => {
    const tables = [T('A', 0, { contestedAllIn: true }), T('B', 1)];
    let d = recommendFeatured(tables, CTX, at('A', 0), 1000, { lock: { tableId: 'B', until: 61_000 } });
    expect(d.state).toMatchObject({ tableId: 'B', mode: 'producer', reason: 'producer', since: 1000 });
    d = recommendFeatured(tables, CTX, d.state, 30_000, { lock: { tableId: 'B', until: 61_000 } });
    expect(d.state).toMatchObject({ tableId: 'B', mode: 'producer', since: 1000 });
    d = recommendFeatured([T('A', 0), T('B', 1)], CTX, d.state, 62_000, { lock: { tableId: 'B', until: 61_000 } });
    expect(d.state).toMatchObject({ tableId: 'B', mode: 'auto', since: 1000 });
    expect(d.changed).toBe(false);
    d = recommendFeatured([T('A', 0), T('C', 2)], CTX, at('B', 0, 'producer'), 70_000, { lock: { tableId: 'B', until: null } });
    expect(d.state).toMatchObject({ tableId: 'A', mode: 'auto', reason: 'table_broken', since: 70_000 });
    expect(d.changed).toBe(true);
  });

  it('never cuts away mid-hand from a contested all-in; the all-in cut only after 20 s and only when the featured hand has none', () => {
    const big = T('B', 1, { contestedAllIn: true, pot: 30_000, chipLeaderHere: true });
    // Featured A has its own contested all-in: stays, whatever B scores.
    expect(recommendFeatured([T('A', 0, { contestedAllIn: true }), big], CTX, at('A', 0), 500_000).state.tableId).toBe('A');
    // A has none: B's contested all-in is cut to, but not before 20 s of dwell.
    expect(recommendFeatured([T('A', 0), big], CTX, at('A', 0), FEATURED_RULES.ALL_IN_CUT_DWELL_MS - 1).state.tableId).toBe('A');
    const cut = recommendFeatured([T('A', 0), big], CTX, at('A', 0), FEATURED_RULES.ALL_IN_CUT_DWELL_MS);
    expect(cut.state).toMatchObject({ tableId: 'B', reason: 'all_in' });
    expect(cut.changed).toBe(true);
  });

  it('at the hand boundary: switch only when the best scores >= current + 40 AND the dwell is >= 90 s', () => {
    const cur = T('A', 0, { handInProgress: false });
    const better = T('B', 1, { handInProgress: false, pot: 10_000, chipLeaderHere: true });        // +40 +25 = 65 more
    const slightly = T('B', 1, { handInProgress: false, pot: 5_000, chipLeaderHere: false });      // +20
    expect(recommendFeatured([cur, better], CTX, at('A', 0), FEATURED_RULES.DWELL_MS - 1).state.tableId).toBe('A');
    expect(recommendFeatured([cur, slightly], CTX, at('A', 0), FEATURED_RULES.DWELL_MS * 3).state.tableId).toBe('A');
    const d = recommendFeatured([cur, better], CTX, at('A', 0), FEATURED_RULES.DWELL_MS);
    expect(d.state).toMatchObject({ tableId: 'B', mode: 'auto', reason: 'big_pot', since: FEATURED_RULES.DWELL_MS });
    // Mid-hand (no all-in anywhere): no boundary, no switch.
    expect(recommendFeatured([T('A', 0), better], CTX, at('A', 0), FEATURED_RULES.DWELL_MS * 3).state.tableId).toBe('A');
  });

  it('auto featured table OFF: the table stays (even past dwell and margin); a break or the final table still move it', () => {
    const better = T('B', 1, { handInProgress: false, pot: 10_000, chipLeaderHere: true });
    expect(recommendFeatured([T('A', 0, { handInProgress: false }), better], CTX, at('A', 0), 10 * 60_000, { autoTable: false }).state.tableId).toBe('A');
    expect(recommendFeatured([T('C', 2), better], CTX, at('A', 0), 1, { autoTable: false }).state).toMatchObject({ tableId: 'B', reason: 'table_broken' });
    expect(recommendFeatured([better], CTX, at('A', 0), 1, { autoTable: false }).state.mode).toBe('final_table');
  });
});

// ---------------------------------------------------------------- on the namespace

async function followRig(tables = 3): Promise<Rig> {
  return broadcastRig({ tables, names: ['John Smith', 'Mary Ann Lee', 'Zed', 'Kim Park', 'Ann Bell', 'Bo Diaz', 'Cy Endo', 'Di Fox', 'Ed Gray'] });
}
const SUB = { v: 1, channel: 'weekly', layout: '16x9' };

describe('S3 on /broadcast — featured-table frames to followers', () => {
  it('subscribe (follow program): the snapshot carries the featured table\'s frame; the socket is in bc:tbl:<id>, never a table: room', async () => {
    const r = await followRig();
    try {
      const a = r.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      const ack = await a.request('bc:subscribe', SUB);
      expect(ack.ok).toBe(true);
      const snap = ack.snapshot;
      expect(snap.table).toMatchObject({ tableId: snap.program.featured.tableId, featured: true, tableNo: snap.program.featured.tableNo });
      expect(snap.program.featured).toMatchObject({ mode: 'auto' });
      expect(r.w.tableIds).toContain(snap.table.tableId);
      const [sock] = await r.io.of('/broadcast').fetchSockets();
      const rooms = [...sock.rooms];
      expect(rooms).toContain(`bc:tbl:${snap.table.tableId}`);
      expect(rooms.filter((x) => x.startsWith('table:') || x.startsWith('voice_'))).toEqual([]);
      expect(deepScanBroadcast(snap, r.w.players.flatMap((p) => [p.playerId, p.masterId]))).toEqual([]);
    } finally { await r.close(); }
  });

  it('a change at the featured table → one table frame (seq + 1, the same for both layouts); a change elsewhere → none; coalesced to at most 5 Hz', async () => {
    const r = await followRig();
    try {
      r.clock.t = Date.now();
      const a = r.client('/broadcast');
      const v = r.client('/broadcast');
      await a.ready; await v.ready;
      const snap = (await a.request('bc:subscribe', SUB)).snapshot;
      await v.request('bc:subscribe', { ...SUB, layout: '9x16' });
      const fid = snap.table.tableId as string;
      const other = r.w.tableIds.find((x) => x !== fid)!;
      // A deal at ANOTHER table: no table frame for these followers.
      r.w.tables.get(other)!.startNewHand();
      r.handle.hooks.tableChanged(other);
      r.clock.t += 1000;
      r.handle.flushTables();
      await settle();
      expect(framesOf(a).filter((f: any) => f.kind === 'table')).toEqual([]);
      // A deal at the featured table: one frame.
      r.w.tables.get(fid)!.startNewHand();
      r.handle.hooks.tableChanged(fid);
      r.handle.flushTables();
      const fa = await a.next((p) => p.type === 2 && p.data[0] === 'bc:frame' && p.data[1].kind === 'table');
      const fv = await v.next((p) => p.type === 2 && p.data[0] === 'bc:frame' && p.data[1].kind === 'table');
      expect(fa!.data[1]).toMatchObject({ v: 1, seq: 1, kind: 'table', table: { tableId: fid, featured: true, phase: 'PreFlop' } });
      expect(fv!.data[1].seq).toBe(1);
      expect(fa!.data[1].table.seats.every((s: any) => s.holeCards === null && s.hasCards === true)).toBe(true);
      // Two more changes inside the 200 ms window: held back, then ONE frame with the latest state.
      const t1 = r.w.tables.get(fid)!;
      t1.playerCall(t1.activeSeatIndex);
      r.handle.hooks.tableChanged(fid);
      r.clock.t += 50;
      r.handle.flushTables();
      t1.playerCall(t1.activeSeatIndex);
      r.handle.hooks.tableChanged(fid);
      r.clock.t += 50;
      r.handle.flushTables();
      await settle();
      expect(framesOf(a).filter((f: any) => f.kind === 'table')).toHaveLength(1);
      r.clock.t += BROADCAST_TABLE_MIN_INTERVAL_MS;
      r.handle.flushTables();
      await settle();
      const tf = framesOf(a).filter((f: any) => f.kind === 'table');
      expect(tf).toHaveLength(2);
      expect(tf[1].seq).toBe(2);
      // Nothing changed: no frame.
      r.clock.t += 1000;
      r.handle.flushTables();
      await settle();
      expect(framesOf(a).filter((f: any) => f.kind === 'table')).toHaveLength(2);
      expect(deepScanBroadcast(a.packets.map((p) => p.data))).toEqual([]);
    } finally { await r.close(); }
  });

  it('the featured table breaks → followers re-pointed in place: a "featured" event, then the new table\'s full frame; rooms moved; one seq; program.featured says table_broken; one table left → final_table', async () => {
    const r = await followRig();
    try {
      const a = r.client('/broadcast');
      await a.ready;
      const snap = (await a.request('bc:subscribe', SUB)).snapshot;
      const fid = snap.table.tableId as string;
      // handleTableRebalance: the table leaves the event, then the hook.
      r.w.tm.removeTable(r.w.tid, fid);
      r.handle.hooks.tableBroken(r.w.tid, fid);
      r.handle.flushTables();
      await settle();
      const frames = framesOf(a);
      const featuredEv = frames.find((f: any) => f.kind === 'event' && f.event.kind === 'featured');
      const tableF = frames.find((f: any) => f.kind === 'table');
      expect(featuredEv).toBeDefined();
      expect(tableF).toBeDefined();
      expect(tableF.table.tableId).not.toBe(fid);
      expect(tableF.table.featured).toBe(true);
      expect(featuredEv.event.tableNo).toBe(tableF.table.tableNo);
      expect(tableF.seq).toBe(featuredEv.seq + 1);
      const [sock] = await r.io.of('/broadcast').fetchSockets();
      expect([...sock.rooms]).toContain(`bc:tbl:${tableF.table.tableId}`);
      expect([...sock.rooms]).not.toContain(`bc:tbl:${fid}`);
      r.handle.tick();
      await settle();
      const prog = framesOf(a).filter((f: any) => f.kind === 'program').pop();
      expect(prog.program.featured).toMatchObject({ tableId: tableF.table.tableId, mode: 'auto', reason: 'table_broken' });
      // Down to one table: forced final table.
      const left = r.w.tm.getTournament(r.w.tid)!.tableIds.filter((x) => x !== tableF.table.tableId);
      for (const x of left) { r.w.tm.removeTable(r.w.tid, x); r.handle.hooks.tableBroken(r.w.tid, x); }
      r.handle.flushTables();
      r.handle.tick();
      await settle();
      const last = framesOf(a).filter((f: any) => f.kind === 'program').pop();
      expect(last.program.featured).toMatchObject({ tableId: tableF.table.tableId, mode: 'final_table', reason: 'final_table' });
      const seqs = framesOf(a).map((f: any) => f.seq);
      expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
      expect((r.handle.health() as any).featuredSwitches.auto).toBeGreaterThanOrEqual(1);
      expect(r.logs.some((l) => l.includes('broadcast_featured_changed'))).toBe(true);
    } finally { await r.close(); }
  });

  it('follow "none": program frames only (no table frame, no featured event); follow {tableId}: that table, featured:false when it is not the featured one; a table not in the event → wrong_event', async () => {
    const r = await followRig();
    try {
      const n = r.client('/broadcast');
      const p = r.client('/broadcast');
      const f = r.client('/broadcast');
      await n.ready; await p.ready; await f.ready;
      const featured = (await f.request('bc:subscribe', SUB)).snapshot.table.tableId as string;
      const pinId = r.w.tableIds.find((x) => x !== featured)!;
      const ns = (await n.request('bc:subscribe', { ...SUB, follow: 'none' })).snapshot;
      expect(ns.table).toBeNull();
      const ps = (await p.request('bc:subscribe', { ...SUB, follow: { tableId: pinId } })).snapshot;
      expect(ps.table).toMatchObject({ tableId: pinId, featured: false });
      const x = r.client('/broadcast');
      await x.ready;
      expect(await x.request('bc:subscribe', { ...SUB, follow: { tableId: 'NOPE' } })).toEqual({ ok: false, code: 'wrong_event' });
      for (const id of r.w.tableIds) { r.w.tables.get(id)!.startNewHand(); r.handle.hooks.tableChanged(id); }
      r.clock.t = Date.now() + BROADCAST_TABLE_MIN_INTERVAL_MS;   // past the 5 Hz window of the snapshots' frames
      r.handle.flushTables();
      await settle();
      expect(framesOf(n)).toEqual([]);
      expect(framesOf(p).filter((x: any) => x.kind === 'table').map((x: any) => x.table.tableId)).toEqual([pinId]);
      expect(framesOf(f).filter((x: any) => x.kind === 'table').map((x: any) => x.table.tableId)).toEqual([featured]);
    } finally { await r.close(); }
  });

  it('a contested all-in showdown at the featured table: the frame shows the tabled hands; mid-hand frames never a face (deep scan of everything sent)', async () => {
    const r = await followRig(2);
    try {
      const a = r.client('/broadcast');
      await a.ready;
      const fid = (await a.request('bc:subscribe', SUB)).snapshot.table.tableId as string;
      const t = r.w.tables.get(fid)!;
      r.clock.t = Date.now();
      const step = () => { r.handle.hooks.tableChanged(fid); r.clock.t! += 1000; r.handle.flushTables(); };
      expect(t.startNewHand()).toBe(true);
      step();
      expect(t.playerAllIn(t.activeSeatIndex)).toBe(true);
      step();
      for (let g = 0; g < 8 && t.isHandInProgress(); g++) { t.playerCall(t.activeSeatIndex); step(); }
      r.handle.hooks.handResult(fid, t, t.lastHandResult ? t.lastHandResult.winners.map((x) => ({ seatIndex: x.seatIndex })) : []);
      step();
      await settle();
      const tf = framesOf(a).filter((x: any) => x.kind === 'table');
      const last = tf[tf.length - 1].table;
      expect(last.phase).toBe('HandComplete');
      expect(last.handResult.showdownSeats.length).toBeGreaterThanOrEqual(2);
      expect(last.seats.filter((s: any) => s.holeCards).length).toBe(last.handResult.showdownSeats.length);
      expect(last.liveHandEndedAt).toEqual(expect.any(Number));
      for (const x of tf.slice(0, -1)) if (x.table.phase !== 'HandComplete' && x.table.phase !== 'Showdown') expect(x.table.seats.every((s: any) => s.holeCards === null)).toBe(true);
      expect(deepScanBroadcast(a.packets.map((p) => p.data), r.w.players.flatMap((p) => [p.playerId, p.masterId]))).toEqual([]);
    } finally { await r.close(); }
  });
});

/**
 * 2026-11-02 (.online tournament broadcast, P2-S2) — THE TICKER: what happened
 * in an event, newest last, at most BROADCAST_TICKER_MAX per event (spec §3
 * TickerEvent; kinds TICKER_KINDS — a seat-winning bust is 'bust' with
 * seatsWon > 0).
 *
 * Records are CAPTURED from the game server's own events (the tournament onEvent
 * listeners, the hand-for-hand settle, a table break, a hand result) and keep
 * the internal playerId; NAMES and pids are resolved at EMIT time
 * (resolveTicker), so an opt-out taken mid-event also covers the ticker. A
 * record never leaves this process with a playerId in it.
 *
 * Capture runs inside game paths (an elimination, the blind timer, handResult):
 * every function here is O(the record) or O(the table's seats), never awaits,
 * and the wire wraps each call in try/catch.
 */
import { seatsWonAt } from '../game/qualifierSchedule';
import { broadcastPid } from './broadcastNames';
import { entrantName, tableNoOf, type BroadcastWorld } from './broadcastSnapshot';
import { BROADCAST_TICKER_MAX, type TickerEvent, type TickerKind } from './contract';
import type { QualifierRegView, ResolvedEvent } from './eventKey';

export interface TickerRecord {
  id: string;
  t: number;
  kind: TickerKind;
  /** INTERNAL — resolved to pid + name at emit; never sent. */
  playerId?: string;
  /** INTERNAL — the eliminator (byName at emit). */
  byPlayerId?: string;
  place?: number;
  of?: number;
  tableNo?: number;
  handNumber?: number;
  level?: number;
  seatsWon?: number;
  amount?: number;
  tied?: boolean;
  handForHand?: boolean;
}
export type TickerCapture = Omit<TickerRecord, 'id' | 't'>;

export interface TickerBook {
  record(tournamentId: string, rec: TickerCapture, t: number): TickerRecord;
  list(tournamentId: string): TickerRecord[];
  /** The id of the event's newest record ('' = none): a build memo is stale once it moved. */
  lastId(tournamentId: string): string;
  drop(tournamentId: string): void;
  tournaments(): string[];
}

/** Events whose ticker is kept (oldest dropped first past this). */
const TICKER_EVENTS_MAX = 64;

export function createTickerBook(): TickerBook {
  const rings = new Map<string, TickerRecord[]>();
  let n = 0;
  return {
    record(tournamentId, rec, t) {
      let ring = rings.get(tournamentId);
      if (!ring) {
        if (rings.size >= TICKER_EVENTS_MAX) { const oldest = rings.keys().next().value; if (oldest !== undefined) rings.delete(oldest); }
        ring = [];
        rings.set(tournamentId, ring);
      }
      const full: TickerRecord = { ...rec, id: `k${(++n).toString(36)}-${t.toString(36)}`, t };
      ring.push(full);
      if (ring.length > BROADCAST_TICKER_MAX) ring.splice(0, ring.length - BROADCAST_TICKER_MAX);
      return full;
    },
    list: (tournamentId) => (rings.get(tournamentId) || []).slice(),
    lastId: (tournamentId) => { const r = rings.get(tournamentId); return r && r.length > 0 ? r[r.length - 1].id : ''; },
    drop: (tournamentId) => { rings.delete(tournamentId); },
    tournaments: () => [...rings.keys()],
  };
}

function qualifierOf(world: BroadcastWorld, tournamentId: string): QualifierRegView | null {
  for (const [, qt] of world.qualifiers()) if (qt.tournamentId === tournamentId) return qt;
  return null;
}

/** The table number a player plays / played at in this event, if known. */
function tableNoOfPlayer(world: BroadcastWorld, tournamentId: string, playerId: string): number | undefined {
  const t = world.tournament(tournamentId);
  if (!t) return undefined;
  const tableId = t.playerTableMap?.get(playerId) ?? t.tableId ?? undefined;
  if (!tableId) return undefined;
  const table = world.table(tableId);
  const idx = t.tableIds.indexOf(tableId);
  const no = tableNoOf(table?.config.tableName, idx);
  return no === null ? undefined : no;
}

/**
 * A bust's capture: final place, of (the event's entries), the eliminator, the
 * table, and its prize — championship seats for a qualifier (seatsWonAt), the
 * payout of that place for a Sit & Go.
 */
export function bustCapture(world: BroadcastWorld, tournamentId: string,
  data: { playerId?: unknown; position?: unknown; eliminatorId?: unknown }, handForHand: boolean): TickerCapture | null {
  const playerId = typeof data?.playerId === 'string' ? data.playerId : '';
  const place = Number(data?.position);
  if (!playerId) return null;
  const t = world.tournament(tournamentId);
  const tp = t?.players.find((p) => p.playerId === playerId);
  const rec: TickerCapture = { kind: 'bust', playerId };
  if (Number.isInteger(place) && place > 0) rec.place = place;
  if (t) rec.of = t.entries || t.players.length;
  if (typeof data?.eliminatorId === 'string' && data.eliminatorId && data.eliminatorId !== playerId) rec.byPlayerId = data.eliminatorId;
  const tableNo = tableNoOfPlayer(world, tournamentId, playerId);
  if (tableNo !== undefined) rec.tableNo = tableNo;
  if (tp && tp.tieGroup !== undefined) rec.tied = true;
  if (handForHand) rec.handForHand = true;
  if (rec.place) {
    const qt = qualifierOf(world, tournamentId);
    if (qt) {
      const seats = seatsWonAt(qt.qualifierType, qt.seatPackage ?? null, rec.place);
      if (seats > 0) rec.seatsWon = seats;
    } else {
      let row: { amount: number } | undefined;
      try { row = world.payoutTableOf(tournamentId)?.payouts.find((r) => r.place === rec.place); } catch { row = undefined; }
      if (row && row.amount > 0 && !rec.tied) rec.amount = row.amount;
    }
  }
  return rec;
}

/**
 * The capture of one tournament onEvent (blindLevelUp, tournamentBreak,
 * tournamentBreakEnded, lateEntryClosedAtBubble, playerEliminated,
 * tournamentFinished), else null. `deferredBust`: a hand-for-hand round bust —
 * its place is settled later and captured then (handForHandBust), never twice.
 */
export function tickerFromTournamentEvent(world: BroadcastWorld, tournamentId: string, event: string, data: any, deferredBust: boolean): TickerCapture | null {
  switch (event) {
    case 'blindLevelUp': {
      const level = Number(data?.level);
      return Number.isInteger(level) && level > 0 ? { kind: 'levelUp', level } : { kind: 'levelUp' };
    }
    case 'tournamentBreak': {
      const level = Number(data?.afterLevel);
      return Number.isInteger(level) && level > 0 ? { kind: 'breakStart', level } : { kind: 'breakStart' };
    }
    case 'tournamentBreakEnded': {
      const level = Number(data?.level);
      return Number.isInteger(level) && level > 0 ? { kind: 'breakEnd', level } : { kind: 'breakEnd' };
    }
    case 'lateEntryClosedAtBubble':
      return { kind: 'lateRegClosed' };
    case 'playerEliminated':
      return deferredBust ? null : bustCapture(world, tournamentId, data || {}, false);
    case 'tournamentFinished': {
      const win = Array.isArray(data?.results) ? data.results.find((r: any) => r && r.position === 1 && !r.disqualified) : null;
      return win && typeof win.playerId === 'string' ? { kind: 'finished', playerId: win.playerId, place: 1 } : { kind: 'finished' };
    }
    default:
      return null;
  }
}

/** A table at handResult, as the doubleUp check reads it (stacks only — no cards). */
export interface HandResultTableView {
  config: { tableName: string };
  handNumber: number;
  startChips: ReadonlyMap<number, number>;
  seats: ReadonlyArray<{ seatIndex: number; state: string; chipCount: number; playerId: string; allIn: boolean; eliminated: boolean }>;
}

/**
 * doubleUp: an ALL-IN winner whose stack at least doubled this hand (its stack at
 * handResult >= 2 x its stack at the deal). One per seat per hand. O(results).
 */
export function doubleUpsOf(table: HandResultTableView, results: ReadonlyArray<{ seatIndex?: unknown }>): Array<{ playerId: string; seatIndex: number }> {
  const out: Array<{ playerId: string; seatIndex: number }> = [];
  const seen = new Set<number>();
  for (const r of results || []) {
    const si = Number(r?.seatIndex);
    if (!Number.isInteger(si) || seen.has(si)) continue;
    seen.add(si);
    const seat = table.seats[si];
    const start = table.startChips.get(si);
    if (!seat || seat.state !== 'occupied' || seat.eliminated || !seat.allIn || !seat.playerId) continue;
    if (!(typeof start === 'number' && start > 0) || seat.chipCount < 2 * start) continue;
    out.push({ playerId: seat.playerId, seatIndex: si });
  }
  return out;
}

/** The emit-time ticker of an event: pids and names resolved now; no playerId leaves. */
export function resolveTicker(world: BroadcastWorld, ev: ResolvedEvent, recs: ReadonlyArray<TickerRecord>): TickerEvent[] {
  const tid = ev.tournamentId;
  const t = tid ? world.tournament(tid) : undefined;
  const players = t ? t.players : (tid ? world.archived?.(tid)?.players : undefined) || [];
  const reg = new Map<string, { localUserId?: number; masterPlayerId?: string; playerName?: string }>();
  for (const p of ev.qt?.players || []) reg.set(p.playerId, p);
  const nameOf = (playerId: string): string => {
    const tp = players.find((p) => p.playerId === playerId);
    const r = reg.get(playerId);
    return entrantName(world, {
      rawName: tp ? tp.playerName : r?.playerName,
      userId: tp?.userId ?? r?.localUserId,
      masterUserId: tp?.masterUserId ?? r?.masterPlayerId,
      bot: false,
    });
  };
  return recs.map((rec) => {
    const out: TickerEvent = { id: rec.id, t: rec.t, kind: rec.kind };
    if (rec.playerId && tid) { out.pid = broadcastPid(tid, rec.playerId); out.name = nameOf(rec.playerId); }
    if (rec.byPlayerId && tid) out.byName = nameOf(rec.byPlayerId);
    for (const k of ['place', 'of', 'tableNo', 'handNumber', 'level', 'seatsWon', 'amount'] as const) {
      if (typeof rec[k] === 'number') out[k] = rec[k];
    }
    if (rec.tied) out.tied = true;
    if (rec.handForHand) out.handForHand = true;
    return out;
  });
}

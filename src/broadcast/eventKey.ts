/**
 * 2026-11-02 (.online tournament broadcast, P2-S2) — EVENT KEYS: what a
 * broadcast stream is bound to, and how a key resolves to a live event.
 *
 *   'q:<masterQualifierId>'  an online qualifier (the qualifierTournaments
 *                            registry: keyed by its master id) — known a week
 *                            ahead; its tournament id once tables open.
 *   't:<tournamentId>'       ONLY a qualifier's engine tournament or a TEMPLATE
 *                            Sit & Go (config.fromTemplate && !config.unlisted).
 *                            A club (unlisted) or custom tournament is
 *                            'not_broadcastable' (spec N8). A template Sit & Go
 *                            is ALSO 'not_broadcastable' unless Sit & Go
 *                            streaming is on (env BROADCAST_SITGO=1, read once
 *                            at boot by wire.ts: see sitGoBroadcastOnOf).
 *   'next:weekly' / 'next:monthly'
 *                            the event of that kind to show NOW, so a fixed OBS
 *                            URL (?ch=weekly) works week after week:
 *                              1. one that is running (tables open or playing);
 *                              2. else one that FINISHED less than
 *                                 NEXT_HOLD_FINISHED_MS ago (the results stay on
 *                                 air; a cancelled one is skipped);
 *                              3. else the soonest unfinished one.
 * Channels: weekly → next:weekly, monthly → next:monthly, main → the same rule
 * across both kinds, sitgo → unbound until a producer binds it (P2-S9; a Sit &
 * Go only while BROADCAST_SITGO=1 — a qualifier may be bound to it either way).
 *
 * Pure: reads the game server only through the EventWorld view. Never throws.
 */
import type { Tournament, TournamentPlayer } from '../game/TournamentManager';
import type { ChannelId, EventKey } from './contract';

/** The fields of a qualifierTournaments entry the broadcast reads (index.ts QualifierTournamentReg). */
export interface QualifierRegView {
  qualifierType: string;
  qualifierName: string;
  scheduledAt: string;
  startingStack: number;
  masterQualifierId?: string;
  players: Array<{ playerId: string; masterPlayerId?: string; localUserId?: number; playerName?: string }>;
  status: 'registering' | 'starting' | 'running' | 'finished';
  tournamentId: string | null;
  finishedAt?: number | null;
  cancelled?: boolean;
  results?: Array<{ masterUserId: string | null; playerName: string; place: number; wonSeat: boolean; seats?: number }> | null;
  seatPackage?: Record<number, number> | null;
}

/** A finished template Sit & Go kept after TournamentManager drops its record (10 s after the finish). */
export interface ArchivedTournament {
  tournamentId: string;
  name: string;
  finishedAt: number;
  entries: number;
  startingStack: number;
  players: TournamentPlayer[];
  finalResults: NonNullable<Tournament['finalResults']>;
}

export interface EventWorld {
  now(): number;
  qualifiers(): Iterable<[string, QualifierRegView]>;
  tournament(tournamentId: string): Tournament | undefined;
  /** A qualifier's engine tournament (index.ts qualifierEngineTournamentIds), known before its first deal. */
  isQualifierEngineTournament(tournamentId: string): boolean;
  /** A finished Sit & Go the broadcast archived (results after the engine dropped it). */
  archived?(tournamentId: string): ArchivedTournament | undefined;
  /**
   * 2026-11-02 (broadcast fix round 2) — Sit & Go streaming on (env BROADCAST_SITGO=1).
   * Absent or false = OFF: every Sit & Go key is 'not_broadcastable'. wire.ts sets it
   * from its env; index.ts's world never does.
   */
  sitGoBroadcastOn?(): boolean;
}

export type EventKind = 'weekly' | 'monthly' | 'sitgo';

export interface ResolvedEvent {
  /** The concrete key: 'q:<id>' for a qualifier (also when asked as t: or next:), 't:<id>' for a Sit & Go. */
  key: EventKey;
  kind: EventKind;
  qualifierId: string | null;
  tournamentId: string | null;
  qt: QualifierRegView | null;
}

export type ParsedEventKey =
  | { kind: 'q'; id: string }
  | { kind: 't'; id: string }
  | { kind: 'next'; type: 'weekly' | 'monthly' };

/** A key the server can never resolve is refused before any lookup. Ids: 1-128 chars of [A-Za-z0-9_.:-]. */
export function parseEventKey(raw: unknown): ParsedEventKey | null {
  if (typeof raw !== 'string' || raw.length > 140) return null;
  if (raw === 'next:weekly') return { kind: 'next', type: 'weekly' };
  if (raw === 'next:monthly') return { kind: 'next', type: 'monthly' };
  const m = /^(q|t):([A-Za-z0-9_.:-]{1,128})$/.exec(raw);
  if (!m) return null;
  return m[1] === 'q' ? { kind: 'q', id: m[2] } : { kind: 't', id: m[2] };
}

/** The default binding of a channel ('next:any' = the main channel's rule over both kinds; null = unbound). */
export function channelDefaultBinding(channel: ChannelId): EventKey | 'next:any' | null {
  if (channel === 'weekly') return 'next:weekly';
  if (channel === 'monthly') return 'next:monthly';
  if (channel === 'main') return 'next:any';
  return null;
}

/** How long a finished event stays the answer of a next: key (the results scene stays on air). */
export const NEXT_HOLD_FINISHED_MS = 2 * 60 * 60 * 1000;

export function qualifierKind(qt: Pick<QualifierRegView, 'qualifierType'>): 'weekly' | 'monthly' {
  return /monthly/i.test(String(qt.qualifierType || '')) ? 'monthly' : 'weekly';
}

/**
 * 2026-11-02 (broadcast fix round 2) — SIT & GO STREAMING IS OFF BY DEFAULT. Sit & Go
 * players get no streaming notice and no opt-out UI yet, so a template Sit & Go may be
 * broadcast only when env BROADCAST_SITGO is exactly '1' (surrounding spaces ignored;
 * unset, '0', 'true', anything else = off). Read once at boot (wire.ts). Off: a Sit & Go
 * event key answers 'not_broadcastable' at bc:subscribe (public and delayed keys), the key
 * mint, the producer's channel bind and the results route; GET /api/broadcast/events lists
 * none; nothing is archived. Qualifiers are unchanged.
 */
export function sitGoBroadcastOnOf(env: Record<string, string | undefined> | undefined): boolean {
  return String(env?.BROADCAST_SITGO ?? '').trim() === '1';
}

/** The world's Sit & Go switch (absent / false / a throw = off). */
function sitGoOnIn(world: EventWorld): boolean {
  try { return world.sitGoBroadcastOn?.() === true; } catch { return false; }
}

/**
 * A template Sit & Go anybody may join (spec N8): never a club (unlisted), custom or
 * qualifier event — and only while Sit & Go streaming is on (`sitGoOn`, env BROADCAST_SITGO=1).
 */
export function isBroadcastableSitGo(t: Pick<Tournament, 'config'> | undefined, sitGoOn: boolean): boolean {
  return sitGoOn === true && !!t && t.config.fromTemplate === true && !t.config.unlisted;
}

function qualifierResolved(id: string, qt: QualifierRegView): ResolvedEvent {
  return { key: `q:${id}`, kind: qualifierKind(qt), qualifierId: id, tournamentId: qt.tournamentId || null, qt };
}

/** The registry entry of a qualifier by its registry key or its master id. */
function findQualifier(world: EventWorld, id: string): [string, QualifierRegView] | null {
  for (const [qid, qt] of world.qualifiers()) if (qid === id) return [qid, qt];
  for (const [qid, qt] of world.qualifiers()) if (qt.masterQualifierId && qt.masterQualifierId === id) return [qid, qt];
  return null;
}

/** The registry entry whose engine tournament this is. */
function qualifierOfTournament(world: EventWorld, tournamentId: string): [string, QualifierRegView] | null {
  for (const [qid, qt] of world.qualifiers()) if (qt.tournamentId === tournamentId) return [qid, qt];
  return null;
}

/** next: rule (see the header) over the qualifiers whose kind is in `kinds`. */
export function resolveNext(world: EventWorld, kinds: ReadonlyArray<'weekly' | 'monthly'>): ResolvedEvent | null {
  const now = world.now();
  let running: [string, QualifierRegView, number] | null = null;
  let held: [string, QualifierRegView, number] | null = null;
  let soonest: [string, QualifierRegView, number] | null = null;
  for (const [qid, qt] of world.qualifiers()) {
    if (!kinds.includes(qualifierKind(qt))) continue;
    const at = Date.parse(qt.scheduledAt);
    if (!Number.isFinite(at)) continue;
    if (qt.status === 'running' || qt.status === 'starting') {
      if (!running || at < running[2]) running = [qid, qt, at];
    } else if (qt.status === 'finished') {
      const fin = Number(qt.finishedAt) || 0;
      if (!qt.cancelled && fin > 0 && now - fin < NEXT_HOLD_FINISHED_MS && (!held || fin > held[2])) held = [qid, qt, fin];
    } else if (!soonest || at < soonest[2]) {
      soonest = [qid, qt, at];
    }
  }
  const pick = running || held || soonest;
  return pick ? qualifierResolved(pick[0], pick[1]) : null;
}

export type ResolveResult = { ok: true; ev: ResolvedEvent } | { ok: false; code: 'event_not_found' | 'not_broadcastable' };

/** An event key (or a channel binding) → the event it means now. Never throws. */
export function resolveEventKey(world: EventWorld, key: EventKey | 'next:any'): ResolveResult {
  try {
    if (key === 'next:any') {
      const ev = resolveNext(world, ['weekly', 'monthly']);
      return ev ? { ok: true, ev } : { ok: false, code: 'event_not_found' };
    }
    const p = parseEventKey(key);
    if (!p) return { ok: false, code: 'event_not_found' };
    if (p.kind === 'next') {
      const ev = resolveNext(world, [p.type]);
      return ev ? { ok: true, ev } : { ok: false, code: 'event_not_found' };
    }
    if (p.kind === 'q') {
      const q = findQualifier(world, p.id);
      return q ? { ok: true, ev: qualifierResolved(q[0], q[1]) } : { ok: false, code: 'event_not_found' };
    }
    // 't:' — a qualifier's tournament (shown as its qualifier) or a template Sit & Go
    // (only while Sit & Go streaming is on: env BROADCAST_SITGO=1).
    const q = qualifierOfTournament(world, p.id);
    if (q) return { ok: true, ev: qualifierResolved(q[0], q[1]) };
    const t = world.tournament(p.id);
    if (!t) {
      const a = world.archived?.(p.id);
      if (!a) return { ok: false, code: 'event_not_found' };
      if (!sitGoOnIn(world)) return { ok: false, code: 'not_broadcastable' };
      return { ok: true, ev: { key: `t:${p.id}`, kind: 'sitgo', qualifierId: null, tournamentId: p.id, qt: null } };
    }
    if (world.isQualifierEngineTournament(p.id)) return { ok: false, code: 'event_not_found' };   // its registry entry is gone
    if (!isBroadcastableSitGo(t, sitGoOnIn(world))) return { ok: false, code: 'not_broadcastable' };
    return { ok: true, ev: { key: `t:${p.id}`, kind: 'sitgo', qualifierId: null, tournamentId: p.id, qt: null } };
  } catch {
    return { ok: false, code: 'event_not_found' };
  }
}

/**
 * 2026-11-25 (owner: "for all online tournaments to be able to see who is
 * registered in the lobby and a list for it to show who busted in each
 * position") — the two lobby lists, server side. Pure: no socket, no DB.
 *
 *  1. REGISTERED: every lobby item (qualifier list AND tournament list) gains
 *     `registrantNames: string[]` — the PUBLIC names (publicNameOf: a
 *     whitelisted display name, else 'Player'; never an id, master id, login
 *     handle, phone or email) of the field in registration order, each entry
 *     once, at most REGISTRANT_NAMES_MAX (the item's own count says how many
 *     there are in all).
 *  2. RESULTS: a FINISHED tournament's standings are kept here (the public
 *     roster shape getTournamentStandings answers) for at least 24 h after
 *     TournamentManager drops its record (a template 10 s after its finish,
 *     every other one an hour after), so the lobby can still open the finish
 *     order of the latest finished event of each card. Bounded: at most
 *     FINISHED_STANDINGS_MAX records; past it the OLDEST record that is not the
 *     latest of its card is dropped first (a busy Sit & Go template never pushes
 *     out a qualifier's or the league's results), then the oldest of all.
 */
import { publicNameOf } from '../social/publicIdentity';

/** At most this many names per lobby item (the item's count carries the rest). ~20 chars each: <= ~7 KB. */
export const REGISTRANT_NAMES_MAX = 300;

/**
 * The public names of a field: in the order given (registration order), each
 * `key` once (the first entry wins; an entry without a key is kept), through
 * publicNameOf, at most `max`.
 */
export function registrantNamesOf(
  entries: ReadonlyArray<{ key?: unknown; name?: unknown }> | null | undefined,
  max: number = REGISTRANT_NAMES_MAX,
): string[] {
  const out: string[] = [];
  if (!Array.isArray(entries)) return out;
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : REGISTRANT_NAMES_MAX;
  const seen = new Set<string>();
  for (const e of entries) {
    if (out.length >= cap) break;
    if (!e || typeof e !== 'object') continue;
    const key = e.key === undefined || e.key === null || e.key === '' ? null : String(e.key);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(publicNameOf(e.name));
  }
  return out;
}

/** A finished tournament's standings are kept this long after its finish (>= the qualifier item's 24 h listing). */
export const FINISHED_STANDINGS_KEEP_MS = 25 * 60 * 60_000;
/** At most this many finished standings are kept. */
export const FINISHED_STANDINGS_MAX = 200;

/** One kept roster: the getTournamentStandings shape of a finished tournament. */
export interface FinishedStandingsRecord {
  tournamentId: string;
  name: string;
  status: 'finished';
  eliminationOrder: string[];
  players: Array<{ playerId: string; playerName: string; chipCount: number; finishPosition: number | null }>;
  finishedAt: number;
  /** Whose card it belongs to: a template's name ('template:<name>'), else the tournament itself ('tournament:<id>'). */
  cardKey: string;
}

export interface FinishedStandingsStats {
  /** Finished rosters recorded. */
  noted: number;
  /** getTournamentStandings answers served from a kept roster (the live record was already dropped). */
  served: number;
  /** Rosters dropped past FINISHED_STANDINGS_KEEP_MS. */
  expired: number;
  /** Rosters dropped by the FINISHED_STANDINGS_MAX bound (should stay ~0). */
  evicted: number;
  /** A roster that could not be recorded (logged `finished_standings_note_failed`; the finish itself is unaffected). Should stay 0. */
  noteErrors: number;
}

export class FinishedStandingsStore {
  private readonly records = new Map<string, FinishedStandingsRecord>();
  readonly stats: FinishedStandingsStats = { noted: 0, served: 0, expired: 0, evicted: 0, noteErrors: 0 };

  constructor(
    private readonly keepMs: number = FINISHED_STANDINGS_KEEP_MS,
    private readonly max: number = FINISHED_STANDINGS_MAX,
  ) {}

  get size(): number { return this.records.size; }

  /** Record (or replace) a finished roster, then apply the bounds. */
  note(rec: FinishedStandingsRecord, now: number = Date.now()): void {
    this.records.delete(rec.tournamentId);   // a re-note moves it to the newest end
    this.records.set(rec.tournamentId, rec);
    this.stats.noted++;
    this.prune(now);
  }

  /** The kept roster (a copy), or null (never kept / past the keep window). */
  get(tournamentId: string, now: number = Date.now()): FinishedStandingsRecord | null {
    const r = this.records.get(tournamentId);
    if (!r) return null;
    if (now - r.finishedAt > this.keepMs) return null;
    return { ...r, eliminationOrder: [...r.eliminationOrder], players: r.players.map((p) => ({ ...p })) };
  }

  has(tournamentId: string, now: number = Date.now()): boolean {
    const r = this.records.get(tournamentId);
    return !!r && now - r.finishedAt <= this.keepMs;
  }

  /** The id of the latest kept roster of a card (null = none in the keep window). */
  latestIdFor(cardKey: string, now: number = Date.now()): string | null {
    let best: FinishedStandingsRecord | null = null;
    for (const r of this.records.values()) {
      if (r.cardKey !== cardKey || now - r.finishedAt > this.keepMs) continue;
      if (!best || r.finishedAt >= best.finishedAt) best = r;
    }
    return best ? best.tournamentId : null;
  }

  /** Drop what is past the keep window, then enforce the size bound (oldest non-latest-of-its-card first). */
  prune(now: number = Date.now()): void {
    for (const [id, r] of this.records) {
      if (now - r.finishedAt > this.keepMs) { this.records.delete(id); this.stats.expired++; }
    }
    while (this.records.size > this.max) {
      const latestOfCard = new Map<string, FinishedStandingsRecord>();
      for (const r of this.records.values()) {
        const b = latestOfCard.get(r.cardKey);
        if (!b || r.finishedAt >= b.finishedAt) latestOfCard.set(r.cardKey, r);
      }
      let victim: FinishedStandingsRecord | null = null;
      for (const r of this.records.values()) {
        if (latestOfCard.get(r.cardKey) === r) continue;
        if (!victim || r.finishedAt < victim.finishedAt) victim = r;
      }
      if (!victim) {
        for (const r of this.records.values()) if (!victim || r.finishedAt < victim.finishedAt) victim = r;
      }
      if (!victim) break;
      this.records.delete(victim.tournamentId);
      this.stats.evicted++;
    }
  }
}

/** The parts of a qualifier registry entry the results pointer reads. */
export interface QualifierResultsSource {
  qualifierType: string;
  status: string;
  cancelled?: boolean;
  tournamentId: string | null;
  finishedAt?: number | null;
}

/**
 * The lobby's results pointer for one qualifier item (the shared contract's
 * `resultsTournamentId`, + `resultsQualifierId` = the event those results
 * belong to): its OWN tournament while it runs ('starting' / 'running') or
 * once it finished PLAYED (not cancelled) and its standings can still be read;
 * a cancelled event → none; otherwise (scheduled / registering) the latest
 * finished, played event of the SAME type whose standings can still be read
 * (the league card before tonight's start: last night's results), else none.
 */
export function qualifierResultsPointer(
  selfId: string,
  self: QualifierResultsSource,
  events: Iterable<[string, QualifierResultsSource]>,
  hasStandings: (tournamentId: string) => boolean,
): { resultsTournamentId: string | null; resultsQualifierId: string | null } {
  const none = { resultsTournamentId: null, resultsQualifierId: null };
  const readable = (tid: string | null): tid is string => typeof tid === 'string' && tid !== '' && hasStandings(tid);
  if (self.status === 'running' || self.status === 'starting') {
    return readable(self.tournamentId) ? { resultsTournamentId: self.tournamentId, resultsQualifierId: selfId } : none;
  }
  if (self.status === 'finished') {
    if (self.cancelled) return none;
    return readable(self.tournamentId) ? { resultsTournamentId: self.tournamentId, resultsQualifierId: selfId } : none;
  }
  let best: [string, QualifierResultsSource] | null = null;
  for (const [id, q] of events) {
    if (id === selfId || q.qualifierType !== self.qualifierType || q.status !== 'finished' || q.cancelled) continue;
    if (!readable(q.tournamentId)) continue;
    if (!best || (q.finishedAt ?? 0) >= (best[1].finishedAt ?? 0)) best = [id, q];
  }
  return best ? { resultsTournamentId: best[1].tournamentId, resultsQualifierId: best[0] } : none;
}

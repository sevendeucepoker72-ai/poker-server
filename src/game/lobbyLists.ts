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
 *
 * 2026-11-26 review fixes:
 *  - SURVIVES A RESTART (finding 1): every kept roster is written through a
 *    pluggable `FinishedStandingsPersistence` (index.ts: Redis, key
 *    `poker:finishedStandings:<id>`, TTL = what is left of the keep window) and
 *    read back at boot (`parseFinishedStandings` -> `restore`). A qualifier's
 *    roster is TAGGED with its event (`tagQualifier`, index.ts
 *    markQualifierFinished), so after a restart `latestQualifier(type)` still
 *    names the latest finished event of a type for qualifierResultsPointer
 *    (its registry entry died with the old process). No Redis = in memory only.
 *  - A FINISHED CUSTOM / CLUB EVENT STAYS LISTED (finding 3): the roster keeps
 *    the event's lobby card (`keptCardOf`), `unlisted` and the entrants'
 *    ACCOUNT keys (server-side only: never served, never listed), so
 *    TournamentManager lists it as a 'finished' item (`keptFinishedItemOf`)
 *    for the whole keep window once its live record is dropped — a club one
 *    only to its own entrants (`rosterHasAccount`, the entryOfAccount rule).
 *    Template rosters are reached from the template's registering card
 *    (resultsTournamentId), qualifier rosters from the qualifier lobby.
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
  /** 2026-11-26 review fix — a club (unlisted) event: its kept 'finished' item reaches only its own entrants. */
  unlisted?: boolean;
  /**
   * 2026-11-26 review fix — the entrants' ACCOUNT keys (local userId / master
   * id), for the club rule and the kept item's `registered`. SERVER-SIDE ONLY:
   * getTournamentStandings and the kept item never carry them.
   */
  accounts?: Array<{ userId?: number; masterUserId?: string }>;
  /** 2026-11-26 review fix — the event's lobby card at the finish (keptCardOf: viewer-independent, whitelisted fields). */
  card?: Record<string, unknown>;
  /** 2026-11-26 review fix — the qualifier event these results belong to (index.ts markQualifierFinished; null / absent = not a qualifier's). */
  qualifier?: { type: string; id: string } | null;
}

/**
 * 2026-11-26 review fix (finding 1) — where kept rosters are written so a
 * restart does not lose them (index.ts: Redis). Both calls are fire-and-forget:
 * `save` resolving `false` = not written (no store configured), a throw / a
 * rejection is counted (persistErrors), never thrown into the finish.
 */
export interface FinishedStandingsPersistence {
  /** Keep this roster for `ttlMs` more (what is left of the keep window). */
  save(rec: FinishedStandingsRecord, ttlMs: number): unknown;
  /** The roster left the store before its window ended (the size bound). */
  drop(tournamentId: string): unknown;
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
  /** 2026-11-26 — rosters written to the persistence (Redis) — 0 without one. */
  persisted: number;
  /** 2026-11-26 — a persistence write / delete that threw or rejected (should stay 0). */
  persistErrors: number;
  /** 2026-11-26 — rosters read back at boot (the previous process's, still inside the keep window). */
  restored: number;
}

export class FinishedStandingsStore {
  private readonly records = new Map<string, FinishedStandingsRecord>();
  readonly stats: FinishedStandingsStats = { noted: 0, served: 0, expired: 0, evicted: 0, noteErrors: 0, persisted: 0, persistErrors: 0, restored: 0 };
  private persistence: FinishedStandingsPersistence | null = null;

  constructor(
    private readonly keepMs: number = FINISHED_STANDINGS_KEEP_MS,
    private readonly max: number = FINISHED_STANDINGS_MAX,
  ) {}

  get size(): number { return this.records.size; }

  /** 2026-11-26 (finding 1) — where kept rosters are written (null = memory only). */
  setPersistence(p: FinishedStandingsPersistence | null): void { this.persistence = p; }

  /** Write one roster through the persistence; never throws (a failure is counted). */
  private persist(rec: FinishedStandingsRecord, now: number): void {
    const p = this.persistence;
    if (!p) return;
    const ttlMs = this.keepMs - (now - rec.finishedAt);
    if (!(ttlMs > 0)) return;
    this.settle(() => p.save(rec, ttlMs), true);
  }

  /** Run one persistence call: a sync / async throw is counted; `countWrite` counts a save that did not answer `false`. */
  private settle(call: () => unknown, countWrite: boolean): void {
    try {
      const r = call();
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).then(
          (ok) => { if (countWrite && ok !== false) this.stats.persisted++; },
          () => { this.stats.persistErrors++; },
        );
      } else if (countWrite && r !== false) {
        this.stats.persisted++;
      }
    } catch {
      this.stats.persistErrors++;
    }
  }

  /** Record (or replace) a finished roster, then apply the bounds. */
  note(rec: FinishedStandingsRecord, now: number = Date.now()): void {
    this.records.delete(rec.tournamentId);   // a re-note moves it to the newest end
    this.records.set(rec.tournamentId, rec);
    this.stats.noted++;
    this.prune(now);
    if (this.records.get(rec.tournamentId) === rec) this.persist(rec, now);
  }

  /**
   * 2026-11-26 (finding 1) — the previous process's rosters, read back at boot:
   * each one inside the keep window and not already here is kept (never
   * re-written: it is already persisted), then the bounds apply. Returns how
   * many were taken.
   */
  restore(recs: ReadonlyArray<FinishedStandingsRecord | null | undefined>, now: number = Date.now()): number {
    let n = 0;
    for (const rec of recs) {
      if (!rec || this.records.has(rec.tournamentId) || now - rec.finishedAt > this.keepMs) continue;
      this.records.set(rec.tournamentId, rec);
      n++;
    }
    this.stats.restored += n;
    this.prune(now);
    return n;
  }

  /**
   * 2026-11-26 (finding 1) — mark a kept roster as a qualifier event's results
   * (and write it again, so a restart keeps the mark). False when not kept.
   */
  tagQualifier(tournamentId: string, q: { type: string; id: string }, now: number = Date.now()): boolean {
    const r = this.records.get(tournamentId);
    if (!r || now - r.finishedAt > this.keepMs || !q || !q.type || !q.id) return false;
    r.qualifier = { type: String(q.type), id: String(q.id) };
    this.persist(r, now);
    return true;
  }

  /** 2026-11-26 (finding 1) — the latest kept roster of a QUALIFIER type (its event + when it finished), or null. */
  latestQualifier(qualifierType: string, now: number = Date.now()): { tournamentId: string; qualifierId: string; finishedAt: number } | null {
    let best: FinishedStandingsRecord | null = null;
    for (const r of this.records.values()) {
      if (!r.qualifier || r.qualifier.type !== qualifierType || now - r.finishedAt > this.keepMs) continue;
      if (!best || r.finishedAt >= best.finishedAt) best = r;
    }
    return best && best.qualifier ? { tournamentId: best.tournamentId, qualifierId: best.qualifier.id, finishedAt: best.finishedAt } : null;
  }

  /**
   * 2026-11-26 (finding 3) — the rosters the tournament lobby lists as kept
   * 'finished' items: inside the keep window, the event's OWN card (not a
   * template's: its registering card points at it) and not a qualifier's (the
   * qualifier lobby is its home), newest first. Read-only references.
   */
  listable(now: number = Date.now()): FinishedStandingsRecord[] {
    const out: FinishedStandingsRecord[] = [];
    for (const r of this.records.values()) {
      if (now - r.finishedAt > this.keepMs || r.qualifier || !r.cardKey.startsWith('tournament:')) continue;
      out.push(r);
    }
    return out.sort((a, b) => b.finishedAt - a.finishedAt);
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
      // 2026-11-26 — a roster pushed out by the bound leaves the persistence too
      // (one past its window simply expires there: the key's TTL).
      const p = this.persistence;
      const gone = victim.tournamentId;
      if (p) this.settle(() => p.drop(gone), false);
    }
  }
}

/** 2026-11-26 — the persisted roster's format version (parseFinishedStandings refuses any other). */
export const FINISHED_STANDINGS_FORMAT = 1;

/**
 * 2026-11-26 (finding 3) — the viewer-independent lobby-card fields a kept
 * 'finished' item carries (TournamentManager's list item at the finish).
 * Never `registered` / `entryId` (per viewer), never names (registrantNames is
 * rebuilt from the roster), never ids.
 */
export const KEPT_CARD_FIELDS = [
  'minPlayers', 'buyIn', 'prizePool', 'fundedPool', 'isFreeroll', 'maxPlayers', 'blindLevel', 'blindLevelCount',
  'payouts', 'payoutField', 'payoutsProjected', 'stallCancelMs', 'startingChips', 'levelSeconds', 'blindStructure',
] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A JSON-safe card value: a finite number, a boolean, null, or an array of flat objects of those. */
function cardValueOf(v: unknown): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    const rows: Array<Record<string, number | boolean | null>> = [];
    for (const row of v.slice(0, 200)) {
      if (!isPlainObject(row)) return undefined;
      const flat: Record<string, number | boolean | null> = {};
      for (const [k, x] of Object.entries(row)) {
        if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) flat[k] = x as number | boolean | null;
      }
      rows.push(flat);
    }
    return rows;
  }
  return undefined;
}

/** 2026-11-26 (finding 3) — the KEPT_CARD_FIELDS of a lobby item, each a JSON-safe value (anything else is left out). */
export function keptCardOf(item: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(item)) return out;
  for (const k of KEPT_CARD_FIELDS) {
    const v = cardValueOf(item[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 2026-11-26 (finding 3) — does this account hold an entry in the roster? The entryOfAccount rule: local userId, else master id. */
export function rosterHasAccount(rec: FinishedStandingsRecord, account: { userId?: number; masterUserId?: string | null } | null | undefined): boolean {
  if (!account || !Array.isArray(rec.accounts)) return false;
  return rec.accounts.some((a) =>
    (account.userId !== undefined && a.userId !== undefined && a.userId === account.userId)
    || (!!account.masterUserId && !!a.masterUserId && String(a.masterUserId) === String(account.masterUserId)));
}

/**
 * 2026-11-26 (finding 3) — the tournament lobby's item for a KEPT finished
 * roster (its live record already dropped): the card at the finish + status
 * 'finished', the field's public names, resultsTournamentId = itself, and the
 * additive `resultsKept: true`. Never an id, an account key or a login.
 */
export function keptFinishedItemOf(rec: FinishedStandingsRecord, viewerHolds: boolean): Record<string, unknown> {
  const field = rec.players.length;
  return {
    registered: !!viewerHolds,
    entryId: null,
    minPlayers: 2, buyIn: 0, prizePool: 0, fundedPool: 0, isFreeroll: true, maxPlayers: field,
    blindLevel: 1, blindLevelCount: 1, payouts: [], payoutField: field, payoutsProjected: false, stallCancelMs: null,
    ...keptCardOf(rec.card),
    tournamentId: rec.tournamentId,
    name: rec.name,
    registeredPlayers: field,
    status: 'finished',
    paused: false,
    pauseReason: null,
    nextStartTime: null,
    currentBlinds: null,
    stallCancelAt: null,
    seedsHeldUntilEnd: true,
    registrantNames: registrantNamesOf(rec.players.map((p) => ({ key: p.playerId, name: p.playerName }))),
    resultsTournamentId: rec.tournamentId,
    resultsKept: true,
    finishedAt: rec.finishedAt,
  };
}

/**
 * 2026-11-26 (finding 1) — the persisted text of a kept roster. Names at rest
 * are PUBLIC names only (publicNameOf — idempotent, and every serving path
 * applies it again, so what players see after a restart is identical): a
 * login handle / phone typed as a registration name never reaches Redis.
 */
export function serializeFinishedStandings(rec: FinishedStandingsRecord): string {
  return JSON.stringify({
    v: FINISHED_STANDINGS_FORMAT,
    ...rec,
    players: rec.players.map((p) => ({ playerId: p.playerId, playerName: publicNameOf(p.playerName), chipCount: p.chipCount, finishPosition: p.finishPosition })),
  });
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/**
 * 2026-11-26 (finding 1) — a persisted roster read back (a JSON string or the
 * parsed object), validated field by field; null for anything malformed, of
 * another format version, or without a usable id / finish time. Players keep
 * exactly {playerId, playerName, chipCount, finishPosition}; the card is
 * re-whitelisted (keptCardOf).
 */
export function parseFinishedStandings(raw: unknown): FinishedStandingsRecord | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { return null; }
  }
  if (!isPlainObject(o) || o.v !== FINISHED_STANDINGS_FORMAT) return null;
  const tournamentId = str(o.tournamentId);
  const cardKey = str(o.cardKey, 300);
  const finishedAt = typeof o.finishedAt === 'number' && Number.isFinite(o.finishedAt) && o.finishedAt > 0 ? o.finishedAt : null;
  if (!tournamentId || !cardKey || finishedAt === null || !Array.isArray(o.players) || o.players.length > 5000) return null;
  const players: FinishedStandingsRecord['players'] = [];
  for (const p of o.players) {
    if (!isPlainObject(p) || typeof p.playerId !== 'string') return null;
    const fp = p.finishPosition;
    players.push({
      playerId: p.playerId,
      playerName: typeof p.playerName === 'string' ? p.playerName : '',
      chipCount: typeof p.chipCount === 'number' && Number.isFinite(p.chipCount) ? p.chipCount : 0,
      finishPosition: typeof fp === 'number' && Number.isInteger(fp) && fp > 0 ? fp : null,
    });
  }
  const eliminationOrder = Array.isArray(o.eliminationOrder) ? o.eliminationOrder.filter((x): x is string => typeof x === 'string') : [];
  const rec: FinishedStandingsRecord = {
    tournamentId,
    name: typeof o.name === 'string' ? o.name : '',
    status: 'finished',
    eliminationOrder,
    players,
    finishedAt,
    cardKey,
  };
  if (o.unlisted === true) rec.unlisted = true;
  if (Array.isArray(o.accounts)) {
    rec.accounts = [];
    for (const a of o.accounts) {
      if (!isPlainObject(a)) continue;
      const acct: { userId?: number; masterUserId?: string } = {};
      if (typeof a.userId === 'number' && Number.isInteger(a.userId)) acct.userId = a.userId;
      const m = str(a.masterUserId);
      if (m) acct.masterUserId = m;
      if (acct.userId !== undefined || acct.masterUserId !== undefined) rec.accounts.push(acct);
    }
  }
  if (isPlainObject(o.card)) rec.card = keptCardOf(o.card);
  if (isPlainObject(o.qualifier)) {
    const type = str(o.qualifier.type);
    const id = str(o.qualifier.id);
    if (type && id) rec.qualifier = { type, id };
  }
  return rec;
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
 *
 * 2026-11-26 review fix (finding 1) — `keptLatest` (optional): the latest
 * KEPT roster of a type (FinishedStandingsStore.latestQualifier: survives a
 * restart, when the registry no longer holds the finished event). Used in the
 * scheduled / registering case when it is newer than the registry's best (or
 * the registry has none). Absent / throwing / unreadable = the rule above.
 */
export function qualifierResultsPointer(
  selfId: string,
  self: QualifierResultsSource,
  events: Iterable<[string, QualifierResultsSource]>,
  hasStandings: (tournamentId: string) => boolean,
  keptLatest?: (qualifierType: string) => { tournamentId: string; qualifierId: string; finishedAt: number } | null | undefined,
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
  let kept: { tournamentId: string; qualifierId: string; finishedAt: number } | null | undefined = null;
  try { kept = keptLatest ? keptLatest(self.qualifierType) : null; } catch { kept = null; }
  if (kept && typeof kept.qualifierId === 'string' && kept.qualifierId && readable(kept.tournamentId)
      && (!best || (Number(kept.finishedAt) || 0) > (best[1].finishedAt ?? 0))) {
    return { resultsTournamentId: kept.tournamentId, resultsQualifierId: kept.qualifierId };
  }
  return best ? { resultsTournamentId: best[1].tournamentId, resultsQualifierId: best[0] } : none;
}

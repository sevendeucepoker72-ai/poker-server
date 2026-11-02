/**
 * 2026-11-02 (.online tournament broadcast, P5-S5; owner 2026-11-02: "Hole
 * cards: shown on a 5-MINUTE delayed feed") — THE DELAYED HOLE-CARD BUFFER.
 *
 * Built DARK: env BROADCAST_HOLECARD_POLICY defaults to 'off', and nothing here
 * runs (nothing is armed, nothing captured) until the owner sets it AND an
 * allowlisted issuer turns the producer switch on (delayedFeed.ts).
 *
 * WHAT IT HOLDS, per ARMED event (an event a delayed session watches), in
 * process memory only:
 *   - the PUBLIC stream as it was: the event's program (no card at all), its
 *     ticker records, and a public table frame (broadcastFrame.ts: faces only
 *     at a contested showdown) of EVERY table of the event — the delayed feed
 *     follows the featured table as it was, and a producer may pin any table;
 *   - one HAND RECORD per hand dealt while armed: each seat's hole cards,
 *     cloned ONCE at 'handStarted' (captureHandStart — the ONLY read of a
 *     seat's hole cards in src/broadcast/**), and the moment the hand ended
 *     LIVE (its 'handResult').
 *
 * THE RELEASE RULE (owner HARD RULE, releaseTableFrame): a frame of time t is
 * released at t + delay to a delayed session. Its hand's hole cards ride along
 * ONLY when BOTH
 *   (a) the hand has ended live (handResult) — a hand still being played shows
 *       card BACKS on the delayed feed, however long it lasts, until it ends live;
 *   (b) at least the delay (>= 5 minutes, HOLECARD_MIN_DELAY_MS) has passed since t;
 * and the frame is the delayed feed's featured table (or the producer's pin),
 * the policy is on (after_event: only once the event is over), the table is
 * Hold'em / Omaha, and (BROADCAST_HOLECARD_TABLES=final_table) it was the
 * final table. So a hand's cards appear at max(t + delay, its live end).
 *
 * NEVER: persisted (no Redis, no Postgres, no file, no log line or Sentry extra
 * carries a card — this module imports neither redisStore nor pg), sent to a
 * room, mutated in place (a release clones), or kept past the longest delay in
 * use + HOLECARD_RETAIN_EXTRA_MS (purge; a hand still being played keeps its
 * record until it ends — or until a newer hand is dealt at its table, or an hour),
 * the event's end + that, a cap, or the kill switch (wipe). The deck seed, burn cards, the undealt runout, the deck
 * order and chat are never captured at all. A restart empties the buffer (a
 * restart cancels a running qualifier anyway).
 *
 * Names: frames are captured with the names of their time; at release every
 * entrant who has since opted out (or is now unknown) is shown 'Player'
 * (downgradeNames) — never the other way round.
 */
import { broadcastPid, BROADCAST_NAME_FALLBACK } from './broadcastNames';
import {
  HOLECARD_EVENT_BYTES_MAX, HOLECARD_HANDS_PER_TABLE_MAX, HOLECARD_MAX_DELAY_MS, HOLECARD_MIN_DELAY_MS, HOLECARD_POLICY_DEFAULT,
  HOLECARD_PURGED_TAG,
  type BroadcastTableFrame, type Card, type HoleCardPolicy, type ProgramState, type TableSummary,
} from './contract';
import type { ResolvedEvent } from './eventKey';
import type { TickerRecord } from './broadcastTicker';

// ================================================================ policy (env, read once)

export type HoleCardTables = 'featured' | 'final_table';
export type HoleCardShow = 'all' | 'vpip';

export interface HoleCardConfig {
  /** env BROADCAST_HOLECARD_POLICY: 'off' (default, built dark) | 'delayed' | 'after_event'. */
  policy: HoleCardPolicy;
  /** env BROADCAST_HOLECARD_DELAY_MIN (default 5; floor 5, cap 240) in ms. */
  defaultDelayMs: number;
  /** env BROADCAST_HOLECARD_TABLES: 'featured' (default; owner) | 'final_table'. */
  tables: HoleCardTables;
  /** env BROADCAST_HOLECARD_SHOW: 'all' (default) | 'vpip'. */
  show: HoleCardShow;
  /** env BROADCAST_HOLECARD_ISSUERS: master user ids. EMPTY = nobody (fail-closed); the intended value is the owner only. */
  issuers: ReadonlySet<string>;
}

/** A delay in ms, never under the 5-minute floor (no API can lower it) nor over 240 minutes. */
export function clampHoleCardDelayMs(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return HOLECARD_MIN_DELAY_MS;
  return Math.min(HOLECARD_MAX_DELAY_MS, Math.max(HOLECARD_MIN_DELAY_MS, Math.round(n)));
}

export function holeCardConfigOf(env: Record<string, string | undefined> | undefined): HoleCardConfig {
  const e = env || {};
  const p = String(e.BROADCAST_HOLECARD_POLICY ?? '').trim().toLowerCase();
  const policy: HoleCardPolicy = p === 'delayed' || p === 'after_event' ? p : HOLECARD_POLICY_DEFAULT;
  const rawMin = String(e.BROADCAST_HOLECARD_DELAY_MIN ?? '').trim();
  const minutes = rawMin === '' ? NaN : Number(rawMin);
  const defaultDelayMs = Number.isFinite(minutes) ? clampHoleCardDelayMs(minutes * 60_000) : HOLECARD_MIN_DELAY_MS;
  const tables: HoleCardTables = String(e.BROADCAST_HOLECARD_TABLES ?? '').trim() === 'final_table' ? 'final_table' : 'featured';
  const show: HoleCardShow = String(e.BROADCAST_HOLECARD_SHOW ?? '').trim() === 'vpip' ? 'vpip' : 'all';
  const issuers = new Set(String(e.BROADCAST_HOLECARD_ISSUERS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 128));
  return { policy, defaultDelayMs, tables, show, issuers };
}

/** Hold'em and Omaha only: draw, stud and pineapple change hole cards mid-hand (refused to arm, never captured). */
export const HOLECARD_VARIANTS: ReadonlySet<string> = new Set(['holdem', 'omaha', 'omaha-hi-lo', 'omaha-5', 'omaha-6']);
export function holeCardVariantOk(variantId: unknown): boolean {
  return typeof variantId === 'string' && HOLECARD_VARIANTS.has(variantId);
}

// ================================================================ the buffer

/** A seat as the CAPTURE reads it at the deal (PokerTable satisfies it). */
export interface HoleCardSeatView {
  seatIndex: number;
  state: string;
  playerId: string;
  holeCards: ReadonlyArray<{ rank: number; suit: number }>;
}
export interface HoleCardTableView {
  handNumber: number;
  variantId?: string;
  seats: ReadonlyArray<HoleCardSeatView>;
}

export interface HandRecord {
  tableId: string;
  handNumber: number;
  startedAt: number;
  /** When the hand ended LIVE (its handResult); null while it is played (or it never ended). */
  endedAt: number | null;
  /** seatIndex → the seat's pid at the deal and its hole cards (clones). */
  seats: Map<number, { pid: string; cards: Card[] }>;
  /** BROADCAST_HOLECARD_SHOW=vpip: the seats that voluntarily put chips in (known at the hand's end). */
  vpip: Set<number> | null;
  bytes: number;
}

export type ProgramEntry = { kind: 'program'; t: number; program: ProgramState; tables: TableSummary[]; bytes: number };
export type EventEntry = { kind: 'event'; t: number; rec: TickerRecord; bytes: number };
export type TableEntry = { kind: 'table'; t: number; tableId: string; handNumber: number; frame: BroadcastTableFrame; bytes: number };
export type DelayEntry = ProgramEntry | EventEntry | TableEntry;

interface ArmedEvent {
  eventKey: string;
  ev: ResolvedEvent;
  tournamentId: string | null;
  armedAt: number;
  /** Append-only, t non-decreasing (a capture is stamped max(t, the last t)). */
  entries: DelayEntry[];
  bytes: number;
  hands: Map<string, HandRecord>;
  /** tableId → its hand records' keys, oldest first (the per-table cap). */
  handOrder: Map<string, string[]>;
  tables: Set<string>;
  lastProgramSig: string | null;
  lastTableSig: Map<string, string>;
  /** ticker id → the eliminator's pid (a byName downgraded at release). */
  tickerBy: Map<string, string>;
  pin: { tableId: string; at: number; by: string } | null;
}

export interface HoleCardBufferStats {
  armedEvents: number;
  handsBuffered: number;
  entries: number;
  approxBytes: number;
  droppedAtCap: number;
  purges: number;
  handsCaptured: number;
  variantRefused: number;
}

export interface HoleCardDelayBuffer {
  /** Arm an event (idempotent). Returns true when newly armed. */
  arm(ev: ResolvedEvent, opts?: { ticker?: ReadonlyArray<TickerRecord> }): boolean;
  /** Disarm one event: everything it held is dropped (logged holecard_delay_purged). */
  disarm(eventKey: string, reason: string): void;
  /** Drop EVERY armed event (the kill switch). */
  wipeAll(reason: string): void;
  isArmed(eventKey: string | null | undefined): boolean;
  armedEvents(): string[];
  eventOf(eventKey: string): ResolvedEvent | null;
  /** O(1): the armed event a table belongs to (setTables). */
  eventOfTable(tableId: string): string | undefined;
  eventOfTournament(tournamentId: string): string | undefined;
  /**
   * The event's tables in play now (and its tournament id once it has one). `ev` = the event
   * as resolved NOW: it replaces the one stored at arm time (review fix: an event armed while
   * its qualifier was still registering had tournamentId null for good, so its frames and its
   * hand records were keyed by different pids and no face was ever merged).
   */
  setTables(eventKey: string, tableIds: Iterable<string>, tournamentId: string | null, ev?: ResolvedEvent): void;
  /** 'handStarted': clone each dealt seat's hole cards ONCE. O(seats). false = not captured. */
  captureHandStart(eventKey: string, tableId: string, view: HoleCardTableView, at: number): boolean;
  /** 'handResult': the hand ended LIVE now. `actions` = its action log (SHOW vpip). */
  markHandEnded(eventKey: string, tableId: string, handNumber: number, at: number, actions?: ReadonlyArray<{ seatIndex: number; action: string }>): void;
  /** A program as built at t (`sig` = its change signature; equal to the last = not stored). */
  captureProgram(eventKey: string, program: ProgramState, tables: TableSummary[], sig: string, t: number): boolean;
  captureEvent(eventKey: string, rec: TickerRecord): void;
  /** A PUBLIC table frame as built at t (`sig` its signature; equal to the table's last = not stored). */
  captureTable(eventKey: string, frame: BroadcastTableFrame, sig: string, t: number): boolean;
  /** Entries with afterT < t <= uptoT, in order. */
  entriesAfter(eventKey: string, afterT: number, uptoT: number): DelayEntry[];
  latestProgram(eventKey: string, uptoT: number): ProgramEntry | null;
  latestTable(eventKey: string, tableId: string, uptoT: number): TableEntry | null;
  hand(eventKey: string, tableId: string, handNumber: number): Readonly<HandRecord> | undefined;
  tickerBy(eventKey: string): ReadonlyMap<string, string>;
  setPin(eventKey: string, pin: { tableId: string; at: number; by: string } | null): void;
  pinOf(eventKey: string): { tableId: string; at: number; by: string } | null;
  /** How far back the event's buffer reaches (ms), 0 = nothing. */
  depthMs(eventKey: string, now: number): number;
  /** Drop what is older than `retentionMs` (keeping, per table and for the program, the newest older entry: the state AT the cutoff). */
  purge(now: number, retentionMs: number): void;
  stats(): HoleCardBufferStats;
  /** Tests: the card objects still held (0 after a wipe / purge of everything). */
  cardsHeld(): number;
}

const RANK_OK = (r: number) => Number.isInteger(r) && r >= 2 && r <= 14;
const SUIT_OK = (s: number) => Number.isInteger(s) && s >= 0 && s <= 3;
/** At most 6 hole cards (Omaha 6); anything malformed → no record for that seat (fail closed). */
function cloneCards(raw: unknown): Card[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) return null;
  const out: Card[] = [];
  for (const c of raw) {
    const rank = Number((c as { rank?: unknown })?.rank);
    const suit = Number((c as { suit?: unknown })?.suit);
    if (!RANK_OK(rank) || !SUIT_OK(suit)) return null;
    out.push({ rank, suit: suit as Card['suit'] });
  }
  return out;
}

/** The engine's voluntary action texts ('called 50', 'bet 100', 'raised to 600', 'went all-in for 1500'); blinds / antes ('posted …') are not. */
const VOLUNTARY = /^(called|bet |raised|went all-in|straddl)/i;
export function vpipSeatsOf(actions: ReadonlyArray<{ seatIndex: number; action: string }> | undefined): Set<number> {
  const out = new Set<number>();
  for (const a of actions || []) if (a && Number.isInteger(a.seatIndex) && typeof a.action === 'string' && VOLUNTARY.test(a.action)) out.add(a.seatIndex);
  return out;
}

const handKey = (tableId: string, handNumber: number) => `${tableId}#${handNumber}`;
/** A hand still "live" this long past the purge window is treated as abandoned (its record goes). */
const HOLECARD_STALE_LIVE_MS = 60 * 60_000;

/** First index whose t is > x (entries are t-sorted). */
function upperBound(entries: DelayEntry[], x: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function createHoleCardDelayBuffer(deps: {
  now?: () => number;
  log?: (line: string) => void;
  caps?: { handsPerTable?: number; eventBytes?: number };
} = {}): HoleCardDelayBuffer {
  const log = deps.log || ((l: string) => console.log(l));
  const handsPerTable = deps.caps?.handsPerTable ?? HOLECARD_HANDS_PER_TABLE_MAX;
  const eventBytes = deps.caps?.eventBytes ?? HOLECARD_EVENT_BYTES_MAX;
  const events = new Map<string, ArmedEvent>();
  const tableIndex = new Map<string, string>();
  const tournamentIndex = new Map<string, string>();
  const st = { droppedAtCap: 0, purges: 0, handsCaptured: 0, variantRefused: 0 };
  /** Counts only: never a card, a pid or a player id. */
  const note = (event: string, extra: Record<string, unknown>) => {
    try { log(`[broadcast] ${JSON.stringify({ event, ...extra })}`); } catch { /* logging only */ }
  };

  function dropHand(a: ArmedEvent, key: string): void {
    const h = a.hands.get(key);
    if (!h) return;
    a.hands.delete(key);
    a.bytes -= h.bytes;
    h.seats.clear();
    const order = a.handOrder.get(h.tableId);
    if (order) { const x = order.indexOf(key); if (x >= 0) order.splice(x, 1); }
  }

  function append(a: ArmedEvent, e: DelayEntry): void {
    const last = a.entries.length > 0 ? a.entries[a.entries.length - 1].t : -Infinity;
    if (e.t < last) e.t = last;   // monotonic: a capture a few ms late never lands behind a cursor
    a.entries.push(e);
    a.bytes += e.bytes;
    enforceBytes(a);
  }

  /** The 32 MB cap: the oldest entries go first (then the oldest hands), counted. */
  function enforceBytes(a: ArmedEvent): void {
    if (a.bytes <= eventBytes) return;
    let drop = 0;
    let freed = 0;
    while (drop < a.entries.length - 1 && a.bytes - freed > eventBytes) { freed += a.entries[drop].bytes; drop++; }
    if (drop > 0) { a.entries.splice(0, drop); a.bytes -= freed; st.droppedAtCap += drop; }
    if (a.bytes > eventBytes) {
      const byAge = [...a.hands.values()].sort((x, y) => x.startedAt - y.startedAt);
      for (const h of byAge) { if (a.bytes <= eventBytes) break; dropHand(a, handKey(h.tableId, h.handNumber)); st.droppedAtCap++; }
    }
  }

  function wipe(a: ArmedEvent, reason: string): void {
    const hands = a.hands.size;
    const entries = a.entries.length;
    for (const k of [...a.hands.keys()]) dropHand(a, k);
    a.entries.length = 0;
    a.handOrder.clear();
    a.tickerBy.clear();
    a.lastTableSig.clear();
    a.bytes = 0;
    for (const t of a.tables) if (tableIndex.get(t) === a.eventKey) tableIndex.delete(t);
    if (a.tournamentId && tournamentIndex.get(a.tournamentId) === a.eventKey) tournamentIndex.delete(a.tournamentId);
    events.delete(a.eventKey);
    st.purges++;
    note(HOLECARD_PURGED_TAG, { eventKey: a.eventKey, reason, hands, entries });
  }

  return {
    arm(ev, opts) {
      if (events.has(ev.key)) return false;
      const a: ArmedEvent = {
        eventKey: ev.key, ev, tournamentId: ev.tournamentId, armedAt: deps.now ? deps.now() : Date.now(),
        entries: [], bytes: 0, hands: new Map(), handOrder: new Map(), tables: new Set(),
        lastProgramSig: null, lastTableSig: new Map(), tickerBy: new Map(), pin: null,
      };
      events.set(ev.key, a);
      if (a.tournamentId) tournamentIndex.set(a.tournamentId, ev.key);
      for (const rec of opts?.ticker || []) if (rec.byPlayerId && a.tournamentId) a.tickerBy.set(rec.id, broadcastPid(a.tournamentId, rec.byPlayerId));
      note('holecard_delay_armed', { eventKey: ev.key });
      return true;
    },

    disarm(eventKey, reason) {
      const a = events.get(eventKey);
      if (a) wipe(a, reason);
    },

    wipeAll(reason) {
      for (const a of [...events.values()]) wipe(a, reason);
      tableIndex.clear();
      tournamentIndex.clear();
    },

    isArmed: (eventKey) => !!eventKey && events.has(eventKey),
    armedEvents: () => [...events.keys()],
    eventOf: (eventKey) => events.get(eventKey)?.ev ?? null,
    eventOfTable: (tableId) => tableIndex.get(tableId),
    eventOfTournament: (tournamentId) => tournamentIndex.get(tournamentId),

    setTables(eventKey, tableIds, tournamentId, ev) {
      const a = events.get(eventKey);
      if (!a) return;
      if (ev && ev.key === eventKey) a.ev = ev;
      if (tournamentId && a.tournamentId !== tournamentId) {
        if (a.tournamentId && tournamentIndex.get(a.tournamentId) === eventKey) tournamentIndex.delete(a.tournamentId);
        a.tournamentId = tournamentId;
        tournamentIndex.set(tournamentId, eventKey);
      }
      // The stored event always names the tournament the buffer is keyed by: the frame
      // resolver (broadcastFrame.seatIdentityResolver: ev.tournamentId || ev.key) and the hand
      // records (pidKeyOf) then derive every pid from the same key.
      if (a.tournamentId && a.ev.tournamentId !== a.tournamentId) a.ev = { ...a.ev, tournamentId: a.tournamentId };
      // A table that left the event keeps its index entry until the disarm (its last hand may still end live).
      for (const t of tableIds) {
        a.tables.add(t);
        tableIndex.set(t, eventKey);
      }
    },

    captureHandStart(eventKey, tableId, view, at) {
      const a = events.get(eventKey);
      if (!a || !view || !Number.isInteger(view.handNumber)) return false;
      if (!holeCardVariantOk(view.variantId)) { st.variantRefused++; return false; }
      // The SAME key the recorded frames' pids use (seatIdentityResolver: ev.tournamentId || ev.key).
      const pidKey = a.ev.tournamentId || a.eventKey;
      const seats = new Map<number, { pid: string; cards: Card[] }>();
      for (const s of view.seats || []) {
        if (!s || !s.playerId || s.state === 'empty') continue;
        const cards = cloneCards(s.holeCards);
        if (!cards) continue;
        seats.set(s.seatIndex, { pid: broadcastPid(pidKey, s.playerId), cards });
      }
      if (seats.size === 0) return false;
      const key = handKey(tableId, view.handNumber);
      dropHand(a, key);
      let n = 0;
      for (const v of seats.values()) n += v.cards.length;
      const h: HandRecord = { tableId, handNumber: view.handNumber, startedAt: at, endedAt: null, seats, vpip: null, bytes: 96 + 48 * seats.size + 32 * n };
      a.hands.set(key, h);
      a.bytes += h.bytes;
      st.handsCaptured++;
      const order = a.handOrder.get(tableId) || [];
      order.push(key);
      a.handOrder.set(tableId, order);
      while (order.length > handsPerTable) { dropHand(a, order[0]); st.droppedAtCap++; }
      enforceBytes(a);
      return true;
    },

    markHandEnded(eventKey, tableId, handNumber, at, actions) {
      const h = events.get(eventKey)?.hands.get(handKey(tableId, handNumber));
      if (!h || h.endedAt !== null) return;
      h.endedAt = at;
      if (actions) h.vpip = vpipSeatsOf(actions);
    },

    captureProgram(eventKey, program, tables, sig, t) {
      const a = events.get(eventKey);
      if (!a || sig === a.lastProgramSig) return false;
      a.lastProgramSig = sig;
      append(a, { kind: 'program', t, program, tables, bytes: sig.length + 64 * tables.length });
      return true;
    },

    captureEvent(eventKey, rec) {
      const a = events.get(eventKey);
      if (!a) return;
      if (rec.byPlayerId && a.tournamentId) a.tickerBy.set(rec.id, broadcastPid(a.tournamentId, rec.byPlayerId));
      append(a, { kind: 'event', t: rec.t, rec, bytes: 200 });
    },

    captureTable(eventKey, frame, sig, t) {
      const a = events.get(eventKey);
      if (!a || a.lastTableSig.get(frame.tableId) === sig) return false;
      a.lastTableSig.set(frame.tableId, sig);
      append(a, { kind: 'table', t, tableId: frame.tableId, handNumber: frame.handNumber, frame, bytes: sig.length });
      return true;
    },

    entriesAfter(eventKey, afterT, uptoT) {
      const a = events.get(eventKey);
      if (!a || uptoT <= afterT) return [];
      const from = upperBound(a.entries, afterT);
      const to = upperBound(a.entries, uptoT);
      return a.entries.slice(from, to);
    },

    latestProgram(eventKey, uptoT) {
      const a = events.get(eventKey);
      if (!a) return null;
      for (let i = upperBound(a.entries, uptoT) - 1; i >= 0; i--) { const e = a.entries[i]; if (e.kind === 'program') return e; }
      return null;
    },

    latestTable(eventKey, tableId, uptoT) {
      const a = events.get(eventKey);
      if (!a) return null;
      for (let i = upperBound(a.entries, uptoT) - 1; i >= 0; i--) { const e = a.entries[i]; if (e.kind === 'table' && e.tableId === tableId) return e; }
      return null;
    },

    hand: (eventKey, tableId, handNumber) => events.get(eventKey)?.hands.get(handKey(tableId, handNumber)),
    tickerBy: (eventKey) => events.get(eventKey)?.tickerBy ?? new Map(),

    setPin(eventKey, pin) {
      const a = events.get(eventKey);
      if (a) a.pin = pin;
    },
    pinOf: (eventKey) => events.get(eventKey)?.pin ?? null,

    depthMs(eventKey, now) {
      const a = events.get(eventKey);
      return a && a.entries.length > 0 ? Math.max(0, now - a.entries[0].t) : 0;
    },

    purge(now, retentionMs) {
      const cutoff = now - retentionMs;
      for (const a of events.values()) {
        const i = upperBound(a.entries, cutoff);
        if (i > 0) {
          // The state AT the cutoff stays: the newest older program and, per table, its newest older frame.
          const keep = new Set<number>();
          const seen = new Set<string>();
          for (let j = i - 1; j >= 0; j--) {
            const e = a.entries[j];
            const k = e.kind === 'program' ? '#program' : e.kind === 'table' ? e.tableId : null;
            if (k === null || seen.has(k)) continue;
            seen.add(k);
            keep.add(j);
          }
          const old = a.entries.splice(0, i);
          const kept: DelayEntry[] = [];
          old.forEach((e, j) => { if (keep.has(j)) kept.push(e); else a.bytes -= e.bytes; });
          a.entries.unshift(...kept);
        }
        // Hands: gone once both their deal and their end are older than the cutoff. A hand STILL
        // LIVE keeps its record (it must show its cards once it ends) unless a newer hand was
        // dealt at its table (it was abandoned: it never ends) or it is HOLECARD_STALE_LIVE_MS old.
        for (const [k, h] of [...a.hands]) {
          let gone: boolean;
          if (h.endedAt !== null) gone = Math.max(h.startedAt, h.endedAt) < cutoff;
          else {
            const order = a.handOrder.get(h.tableId);
            const newer = !!order && order.length > 0 && order[order.length - 1] !== k;
            gone = h.startedAt < cutoff && (newer || h.startedAt < cutoff - HOLECARD_STALE_LIVE_MS);
          }
          if (gone) dropHand(a, k);
        }
        if (a.tickerBy.size > 512) for (const k of [...a.tickerBy.keys()].slice(0, a.tickerBy.size - 512)) a.tickerBy.delete(k);
      }
    },

    stats() {
      let hands = 0;
      let entries = 0;
      let bytes = 0;
      for (const a of events.values()) { hands += a.hands.size; entries += a.entries.length; bytes += a.bytes; }
      return { armedEvents: events.size, handsBuffered: hands, entries, approxBytes: Math.max(0, bytes), ...st };
    },

    cardsHeld() {
      let n = 0;
      for (const a of events.values()) {
        for (const h of a.hands.values()) for (const s of h.seats.values()) n += s.cards.length;
        for (const e of a.entries) if (e.kind === 'table') for (const s of e.frame.seats) n += s.holeCards ? s.holeCards.length : 0;
      }
      return n;
    },
  };
}

// ================================================================ the release (pure)

export interface ReleaseContext {
  now: number;
  /** The session's delay (>= HOLECARD_MIN_DELAY_MS, else nothing is released face up). */
  delayMs: number;
  policy: HoleCardPolicy;
  show: HoleCardShow;
  tables: HoleCardTables;
  /** This frame's table is the delayed feed's featured table (as recorded, or the producer's pin). */
  featured: boolean;
  /** The recorded program at this frame's time had the final table (featured.mode 'final_table'). */
  finalTable: boolean;
  /** The event is over (policy after_event). */
  eventFinished: boolean;
}

export type HeldReason = 'hand_live' | 'delay_pending' | 'not_featured' | 'policy' | 'no_record' | 'not_in_hand' | null;

/** May this frame's hand show its hole cards at ctx.now? (the owner's rule + the knobs). */
export function faceUpDecision(frame: Pick<BroadcastTableFrame, 't' | 'tableId' | 'handNumber' | 'phase'>, hand: Readonly<HandRecord> | undefined, ctx: ReleaseContext): HeldReason {
  if (ctx.policy === 'off') return 'policy';
  if (!ctx.featured) return 'not_featured';
  if (ctx.tables === 'final_table' && !ctx.finalTable) return 'not_featured';
  if (ctx.policy === 'after_event' && !ctx.eventFinished) return 'policy';
  if (String(frame.phase) === 'WaitingForPlayers') return 'not_in_hand';
  if (!hand || hand.tableId !== frame.tableId || hand.handNumber !== frame.handNumber) return 'no_record';
  // (b) the delay — never under the 5-minute floor, whatever the caller says.
  if (!(ctx.delayMs >= HOLECARD_MIN_DELAY_MS) || !Number.isFinite(frame.t) || ctx.now < frame.t + ctx.delayMs) return 'delay_pending';
  // (a) the hand has ended LIVE.
  if (hand.endedAt === null || hand.endedAt > ctx.now) return 'hand_live';
  return null;
}

/**
 * A captured PUBLIC frame → the frame a delayed session gets now: a NEW object
 * (the captured one is never touched). Faces are merged only under
 * faceUpDecision; otherwise the seats keep exactly what the public feed showed
 * (backs; a contested showdown's tabled hands). liveHandEndedAt = the hand's live
 * end once it is past; holeCardsReleasedAt = now when faces ride, else null.
 */
export function releaseTableFrame(frame: BroadcastTableFrame, hand: Readonly<HandRecord> | undefined, ctx: ReleaseContext): { frame: BroadcastTableFrame; faces: boolean; held: HeldReason } {
  const held = faceUpDecision(frame, hand, ctx);
  const allowed = held === null && !!hand;
  // Review fix (2026-11-02): `faces` = at least one seat's recorded cards were MERGED (a frame
  // whose seats match no hand-record pid is not stamped holeCardsReleasedAt nor counted).
  let merged = 0;
  const seats = frame.seats.map((s) => {
    const out = { ...s, holeCards: s.holeCards ? s.holeCards.map((c) => ({ rank: c.rank, suit: c.suit })) : null };
    if (!allowed || !hand) return out;
    const rec = hand.seats.get(s.seatIndex);
    if (!rec || rec.pid !== s.pid) return out;
    const shownAtShowdown = Array.isArray(s.holeCards) && s.holeCards.length > 0;
    if (ctx.show === 'vpip' && !shownAtShowdown && !(hand.vpip && hand.vpip.has(s.seatIndex))) return out;
    out.holeCards = rec.cards.map((c) => ({ rank: c.rank, suit: c.suit }));
    merged++;
    return out;
  });
  const faces = allowed && merged > 0;
  const ended = hand && hand.endedAt !== null && hand.endedAt <= ctx.now ? hand.endedAt : null;
  const liveHandEndedAt = hand ? ended : (typeof frame.liveHandEndedAt === 'number' && frame.liveHandEndedAt <= ctx.now ? frame.liveHandEndedAt : null);
  const out: BroadcastTableFrame = {
    ...frame,
    featured: ctx.featured,
    board: frame.board.map((c) => ({ rank: c.rank, suit: c.suit })),
    seats,
    handResult: frame.handResult ? {
      winners: frame.handResult.winners.map((w) => ({ ...w })),
      showdownSeats: frame.handResult.showdownSeats.slice(),
      muckedSeats: frame.handResult.muckedSeats.slice(),
    } : null,
    liveHandEndedAt,
    holeCardsReleasedAt: faces ? ctx.now : null,
  };
  if (frame.pots) out.pots = frame.pots.map((p) => ({ amount: p.amount, eligibleSeats: p.eligibleSeats.slice() }));
  if (frame.lastAction) out.lastAction = { ...frame.lastAction };
  return { frame: out, faces, held };
}

/**
 * Names at RELEASE: every `{pid, name}` whose entrant has since opted out (or is
 * now unknown) → 'Player', a ticker byName likewise (through its eliminator's
 * pid), a hand-result winner through its seat. Never the other way round (a
 * name captured as 'Player' stays). Returns a deep copy.
 */
export function downgradeNames<T>(payload: T, optedOut: ReadonlySet<string>, tickerBy: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
    if (typeof o.pid === 'string' && typeof o.name === 'string' && optedOut.has(o.pid)) o.name = BROADCAST_NAME_FALLBACK;
    if (typeof o.id === 'string' && typeof o.byName === 'string') {
      const by = tickerBy.get(o.id);
      if (by && optedOut.has(by)) o.byName = BROADCAST_NAME_FALLBACK;
    }
    // A table frame's winners carry a seat, not a pid.
    if (Array.isArray(o.seats) && o.handResult && typeof o.handResult === 'object') {
      const hr = o.handResult as { winners?: Array<{ seatIndex: number; name: string }> };
      const seats = o.seats as Array<{ seatIndex: number; pid?: string }>;
      for (const w of hr.winners || []) {
        const s = seats.find((x) => x.seatIndex === w.seatIndex);
        if (s && typeof s.pid === 'string' && optedOut.has(s.pid)) w.name = BROADCAST_NAME_FALLBACK;
      }
    }
    return o;
  };
  return walk(payload) as T;
}

/**
 * 2026-11-02 (.online tournament broadcast, P2-NS / P2-S2 / P2-S3 / P2-S4 /
 * P2-S9) — THE /broadcast NAMESPACE: the public, anonymous program feed of a
 * tournament for the broadcast page (OBS browser source, later the cloud
 * worker), the featured-table frames, the broadcast tokens and the producer
 * API — spec §3, R1-R3, R9, R10. index.ts makes ONE call,
 * `registerBroadcast(io, deps)`, and calls the returned hooks (each O(1), each
 * wrapped here in try/catch — a hook can never throw into game-state building
 * or delay a hand).
 *
 * WHY A NAMESPACE (spec F1 / R1). A /broadcast socket is a different socket
 * from the game's: it can never call 'spectate' / 'joinTable' (no such handler
 * here), never joins a `table:` room, and never receives the default
 * namespace's global traffic — `io.emit('activityFeed')` (real big-pot and
 * finish text: a spoiler on a delayed stream), 'serverAnnouncement',
 * 'maintenanceMode' — nor any per-socket 'gameState' delta. The default
 * namespace's per-connection guards live in its own 'connection' handler, so
 * they are RE-APPLIED here: installSocketListenerGuard (crash safety), the real
 * client address (realClientIp), the in-memory IP ban (bannedIPs), a per-IP cap
 * (BCAST_MAX_PER_IP, default 8) and a total cap (BCAST_MAX_SOCKETS, default
 * 300) — Facebook is the audience, not this feed — and a handshake rate limit.
 *
 * KILL SWITCH. env BROADCAST_FEED ('0' = off at boot; default on) and, with no
 * restart, POST /api/broadcast/feed {on:0|1} + X-Internal-Token (fails closed:
 * 403). Off: every /broadcast socket is disconnected and every handshake is
 * refused `feed_off`. The game is untouched either way.
 *
 * SIT & GOS ARE OFF BY DEFAULT (2026-11-02 fix round 2). Sit & Go players get no
 * streaming notice and no opt-out UI yet: unless env BROADCAST_SITGO is exactly
 * '1' (at boot), a template Sit & Go's key answers `not_broadcastable` at
 * bc:subscribe, the mint, the producer bind and the results route, the events
 * list names none and nothing is archived (eventKey.ts sitGoBroadcastOnOf).
 * Qualifiers are unchanged. Shown as `broadcast.sitGoOn` on /api/health.
 *
 * WHAT FLOWS (§3): bc:subscribe {v:1, channel?|event?, layout, role?, follow?,
 * lastSeq?} → ack {ok:true, snapshot} | {ok:false, code}; bc:resync → bc:snapshot;
 * bc:frame {kind:'program'} on change at most 1 Hz; bc:frame {kind:'event'} at
 * once (deferred one tick, never inside a game path); bc:frame {kind:'table'}
 * (P2-S3) for the followed table, coalesced at most 5 Hz; bc:heartbeat every 2 s.
 *
 * STREAMS AND SEQ (R10). A PROGRAM is a channel ('ch:<channel>', the producer's
 * unit) or a subscribed event key ('ev:<key>'). A STREAM is a program plus a
 * follow mode — 'program' (the featured table), 'none' (no table frames) or
 * {tableId} (one pinned table) — so every socket of a stream receives exactly
 * the same frames and ONE seq per stream holds (the page resyncs on a gap and on
 * a heartbeat ahead of it). Both layouts of a stream share it (16:9 and 9:16
 * stay in step). Table frames go to the stream's room; every socket that sees a
 * table is ALSO in the namespace room `bc:tbl:<tableId>` (who watches what;
 * re-pointed in place when the featured table changes) — never a `table:` room.
 *
 * PUBLIC FEED ONLY. No hole card is ever read here: the program carries no card
 * at all (broadcastSnapshot.ts), and a table frame (broadcastFrame.ts) shows
 * faces only for hands tabled at a contested showdown. The delayed hole-card
 * feed is P5 (built dark: policy 'off', delayed keys answer holecards_off).
 *
 * TOKENS (P2-S4, broadcastToken.ts). Public output needs NO key. A key in the
 * handshake (`auth.key`) is verified (HS256 pinned, typ bcast+jwt, the
 * registry's revocation list): output / producer scopes. A key bound to an event
 * the subscription does not show → wrong_event; held by an entrant of the event
 * → entrant. Revoked / expired keys are dropped mid-session (bc:authExpired).
 *
 * PRODUCER (P2-S9, producer.ts + programStore.ts): scene, featured lock, lower
 * thirds, on air (auto-clears), channel bindings (persisted), keys.
 *
 * DELAYED HOLE CARDS (P5, owner 2026-11-02; holeCardDelay.ts + delayedFeed.ts).
 * Built dark: env BROADCAST_HOLECARD_POLICY defaults to 'off'. A session whose
 * key holds the 'delayed' scope is NOT a stream: it never joins a room; the
 * delayed feed RECORDS its event (a recording program 'dl:<eventKey>', every
 * table's public frame, the ticker; each hand's hole cards cloned once at its
 * deal by the handStarted hook) and releases it by direct socket.emit at least
 * 5 minutes later — a hand's cards only once that hand has ended live. Kill
 * switch: bc:producer:holeCardsSwitch {on:false} / POST /api/broadcast/holecards.
 */
import { randomUUID } from 'crypto';
import type { Namespace, Server, Socket } from 'socket.io';
import { installSocketListenerGuard } from '../socketGuard';
import { createWindowRateLimiter } from '../auth/rateLimit';
import {
  BC_EVENTS, BROADCAST_CHANNELS, BROADCAST_HEARTBEAT_MS, BROADCAST_NAMESPACE, BROADCAST_PROGRAM_MIN_INTERVAL_MS,
  BROADCAST_TABLE_MIN_INTERVAL_MS, FEATURED_CHANGED_TAG, FEATURED_EVAL_MIN_MS, HOLECARD_MAX_DELAY_MS, HOLECARD_MIN_DELAY_MS,
  HOLECARD_RELEASE_TICK_MS, HOLECARD_SWITCH_AUDIT,
  PRODUCER_EVENTS, PRODUCER_PUSH_MIN_MS,
  type BroadcastTableFrame, type ChannelId, type ChannelSummary, type EventSummary, type Feed, type HandshakeRefusalCode, type HoleCardPolicy,
  type OnAirView, type ProducerState, type ProgramState, type SceneId, type Snapshot, type TableSummary, type TickerEvent,
} from './contract';
import {
  buildProgramData, eventStatusOf, programSignature, tableNoOf,
  type BroadcastWorld, type ProgramBuild, type RankMemory,
} from './broadcastSnapshot';
import {
  isBroadcastableSitGo, parseEventKey, qualifierKind, resolveEventKey, sitGoBroadcastOnOf, NEXT_HOLD_FINISHED_MS,
  type ArchivedTournament, type ResolvedEvent,
} from './eventKey';
import {
  bustCapture, createTickerBook, doubleUpsOf, resolveTicker, tickerFromTournamentEvent,
  type HandResultTableView, type TickerCapture, type TickerRecord,
} from './broadcastTicker';
import { frameSignature, seatIdentityResolver, toBroadcastTableFrame, type FrameTableView } from './broadcastFrame';
import { featuredInputsOf, recommendFeatured, type FeaturedState } from './featuredTable';
import {
  BROADCAST_TOKEN_AUDIT_ISSUED, BROADCAST_TOKEN_REFUSED_TAG, createTokenRegistry, parseTokenEv, tokenSecretOf, validateMintRequest,
  type IssueResult, type MintIssuer, type MintRequest, type TokenClaims, type TokenDb, type TokenRegistry, type TokenRow,
} from './broadcastToken';
import { createProgramStore, type ProgramStore } from './programStore';
import { attachProducerHandlers, createProducerLimiters, type ProducerHost, type ProducerStats } from './producer';
import { broadcastPid } from './broadcastNames';
import { createHoleCardDelayBuffer, holeCardConfigOf, type HoleCardDelayBuffer, type HoleCardTableView } from './holeCardDelay';
import { createDelayedFeed, type DelayedFeed } from './delayedFeed';

/** What index.ts gives the namespace. Everything is a read except auditLog / the logs. */
export interface BroadcastWorldFull extends BroadcastWorld {
  tournamentIdOfTable(tableId: string): string | undefined;
  /** Template Sit & Gos registering or running (GET /api/broadcast/events). */
  sitGoTournaments(): Iterable<NonNullable<ReturnType<BroadcastWorld['tournament']>>>;
  /** The table for a featured frame (PokerTable satisfies FrameTableView: no seat hole cards by type). Absent = no table frames. */
  frameTable?(tableId: string): FrameTableView | undefined;
  /** index.ts turnStartedAtMap / currentTurnTimeoutMs of a table. */
  turnOf?(tableId: string): { startedAt: number | null; timeout: number | null } | null;
  /** index.ts sitOutTracker of a table. */
  sittingOutOf?(tableId: string): ReadonlySet<number> | null;
}

/** Minimal Express surface (the routes this module owns). */
export interface RouteApp {
  get(path: string, handler: (req: any, res: any) => void): unknown;
  post(path: string, handler: (req: any, res: any) => void): unknown;
}

export interface BroadcastDeps {
  world: BroadcastWorldFull;
  realClientIp: (socket: Socket) => string;
  bannedIPs: { has(ip: string): boolean };
  /** BROADCAST_FEED, BCAST_MAX_PER_IP, BCAST_MAX_SOCKETS, BROADCAST_TOKEN_SECRET. */
  env?: Record<string, string | undefined>;
  /** X-Internal-Token check (INTERNAL_NOTIFY_TOKEN, constant time; unset never matches). */
  internalTokenMatches: (given: unknown) => boolean;
  /** index.ts handForHandNoticeDeferred: a round bust is captured at its settle, with its final place. */
  isDeferredBust?: (playerId: unknown) => boolean;
  auditLog?: (actor: string, action: string, details: Record<string, unknown>) => void;
  commit?: () => string | null;
  app?: RouteApp;
  /** Postgres (broadcast_tokens, broadcast_channels). Absent = in memory only. */
  db?: TokenDb | null;
  log?: (line: string) => void;
  onHandlerError?: (event: string, err: unknown) => void;
  now?: () => number;
  /** false = no intervals / timeouts (tests drive tick / heartbeat / flushEvents / flushTables). */
  timers?: boolean;
}

export interface BroadcastHooks {
  /** broadcastGameState(tableId) ran: an O(1) dirty mark (nothing at all while nobody watches). */
  tableChanged(tableId: string): void;
  /** A tournament onEvent (blindLevelUp, tournamentBreak, …, playerEliminated, tournamentFinished). */
  tournamentEvent(tournamentId: string, event: string, data: unknown): void;
  /** emitHandForHandRoomBust: a round bust told with its FINAL place. */
  handForHandBust(tournamentId: string, payload: { playerId: string; position: number; eliminatorId?: string }): void;
  /** handleTableRebalance broke `tableId` (it still exists). */
  tableBroken(tournamentId: string, tableId: string): void;
  /** A table's 'handResult' (doubleUp; the moment its hand ended live — also the delayed feed's release gate). */
  handResult(tableId: string, table: HandResultTableView & { actionLog?: ReadonlyArray<{ seatIndex: number; action: string }> }, results: ReadonlyArray<{ seatIndex?: unknown }>): void;
  /**
   * 2026-11-02 (P5) — a table's 'handStarted' (after the deal): when its event is
   * ARMED for the delayed feed, each dealt seat's hole cards are cloned ONCE into the
   * buffer (holeCardDelay.ts). Nothing at all otherwise (an O(1) Map miss).
   */
  handStarted(tableId: string, table: HoleCardTableView): void;
}

export interface BroadcastHandle {
  hooks: BroadcastHooks;
  feedOn(): boolean;
  setFeedOn(on: boolean, actor: string): { previous: boolean; on: boolean; disconnected: number };
  health(): Record<string, unknown>;
  /** The 1 s program flush (also run by the interval). */
  tick(): void;
  /** The 2 s heartbeat (also run by the interval). */
  heartbeat(): void;
  /** Emit the queued event frames now (normally setImmediate). */
  flushEvents(): void;
  /** The table-frame / featured / producer-state flush (normally at most every 200 ms). */
  flushTables(): void;
  eventsList(): EventSummary[];
  onAirView(): OnAirView;
  /** The one minting path (default-namespace 'broadcastIssueToken' and bc:producer:mintKey). */
  mintToken(req: MintRequest, issuer: MintIssuer): Promise<IssueResult>;
  /** Spec R4: the account holds a live broadcast key for this event (registration refused broadcast_staff_cannot_enter). */
  staffHoldsKeyFor(masterUserId: string, target: { qualifierId?: string | null; tournamentId?: string | null }): boolean;
  /** Load the persisted tokens and channel bindings (after initDB). Never throws. */
  loadPersisted(): Promise<void>;
  tokens: TokenRegistry;
  store: ProgramStore;
  /** 2026-11-02 (P5) — the delayed hole-card feed: its 250 ms release (also run by the interval), sessions, buffer. */
  releaseTick(): void;
  delayed: DelayedFeed;
  delayBuffer: HoleCardDelayBuffer;
  stop(): void;
}

type Follow = 'program' | 'none' | { tableId: string };

/** A program: a channel (the producer's unit) or a subscribed event key. */
interface ProgramCtl {
  key: string;
  channel: ChannelId | null;
  /** An event-key program's binding (a channel reads the store each time). */
  binding: string | null;
  /** 2026-11-02 (P5) — the delayed feed's RECORDING program of an armed event ('dl:<eventKey>'): kept while armed. */
  recording?: boolean;
  ev: ResolvedEvent | null;
  featured: FeaturedState | null;
  evalAt: number;
  forceEval: boolean;
  dirty: boolean;
  autoSceneId: SceneId | null;
  autoSceneSince: number;
  watchers: number;
}

interface Stream {
  key: string;
  programKey: string;
  follow: Follow;
  /** The table whose frames this stream gets (null = none). */
  tableId: string | null;
  seq: number;
  lastSig: string | null;
  lastTableSig: string | null;
  lastTableAt: number;
  /** Subscribed while its program had no event: the flush sends a snapshot once it has one. */
  needsSnapshot: boolean;
  subscribers: { '16x9': number; '9x16': number };
  outputs: number;
  /**
   * Review fix (2026-11-02) — the last resync snapshot of this stream: reused (with a fresh
   * serverNow) by every bc:resync while the stream's seq and build are unchanged, for at most
   * RESYNC_SNAPSHOT_REUSE_MS. A resync never rebuilds frames per call.
   */
  resyncCache: { seq: number; build: ProgramBuild; at: number; snap: Snapshot } | null;
}

interface SocketState {
  ip: string;
  scopes: string[];
  claims: TokenClaims | null;
  row: TokenRow | null;
  sub: { stream: string; layout: '16x9' | '9x16'; role: 'viewer' | 'output' } | null;
  watching: ChannelId | null;
}

const roomOf = (streamKey: string): string => `bc:s:${streamKey}`;
/** Every socket that sees a table's frames is in this namespace room (spec P2-S3). */
const tableRoomOf = (tableId: string): string => `bc:tbl:${tableId}`;
const intEnv = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ARCHIVE_MAX = 32;
const BUILD_STALE_MS = 5000;
const TABLE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A producer state is re-sent at least this often even when nothing changed (the panel's "last state"). */
const PRODUCER_REFRESH_MS = 5000;
/**
 * Review fix (2026-11-02, P1) — bc:resync was unmetered: one anonymous socket looping it
 * rebuilt and sent a full snapshot per packet on the event loop every table shares. Now:
 * at most RESYNC_MAX per RESYNC_WINDOW_MS per socket (the page throttles itself to one
 * per 2 s: RESYNC_MIN_GAP_MS), excess dropped silently; a stream's resync snapshot is
 * reused for RESYNC_SNAPSHOT_REUSE_MS while nothing was sent to it; and every /broadcast
 * socket has a packet budget across ALL its events (BCAST_PACKETS_PER_10S, default 200 /
 * 10 s) — past it the socket is disconnected.
 */
/** The broadcast page's own origins (a keyless browser handshake from anywhere else is refused). */
const DEFAULT_BROADCAST_ORIGINS = ['https://americanpubpoker.online', 'https://www.americanpubpoker.online'];
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
/** A keyed handshake waits at most this long for the persisted key list after a restart (env BCAST_KEY_LIST_WAIT_MS). */
const KEY_LIST_WAIT_MS = 10_000;
/** The persisted key list / channel bindings are re-read after a failed load (backoff from env BCAST_PERSISTED_RETRY_MS, capped). */
const PERSISTED_RETRY_MIN_MS = 2000;
const PERSISTED_RETRY_MAX_MS = 60_000;
const RESYNC_MAX = 2;
const RESYNC_WINDOW_MS = 2000;
const RESYNC_SNAPSHOT_REUSE_MS = 1000;
const PACKET_WINDOW_MS = 10_000;

export function registerBroadcast(io: Server, deps: BroadcastDeps): BroadcastHandle {
  const env = deps.env || {};
  const now = deps.now || Date.now;
  const log = deps.log || ((l: string) => console.log(l));
  const note = (event: string, extra: Record<string, unknown> = {}) => {
    try { log(`[broadcast] ${JSON.stringify({ event, ...extra })}`); } catch { /* logging only */ }
  };
  const audit = (actor: string, action: string, details: Record<string, unknown>) => {
    try { deps.auditLog?.(actor, action, details); } catch { /* audit is best effort */ }
  };
  // BCAST_MAX_PER_IP / BCAST_MAX_SOCKETS cap KEYLESS (anonymous) sockets. Review fix: keyed
  // sessions (output / producer / delayed: a verified key) have their own budget,
  // BCAST_MAX_KEYED (default 50), and do not count against the anonymous ones.
  const maxPerIp = intEnv(env.BCAST_MAX_PER_IP, 8, 1, 1000);
  const maxSockets = intEnv(env.BCAST_MAX_SOCKETS, 300, 1, 10_000);
  const maxKeyed = intEnv(env.BCAST_MAX_KEYED, 50, 1, 10_000);
  // Review fix — a KEYLESS handshake from a browser page must come from the broadcast page's
  // origin (env BCAST_ALLOWED_ORIGINS: comma list; '*' = any; default the .online origins).
  // Local development (localhost / 127.0.0.1) is always allowed. No Origin header (not a
  // browser page: a script, the test rigs) is left to the caps.
  const originsRaw = String(env.BCAST_ALLOWED_ORIGINS ?? '').trim();
  const anyOrigin = originsRaw === '*';
  const normOrigin = (o: string) => o.trim().toLowerCase().replace(/\/+$/, '');
  const allowedOrigins = new Set(
    (originsRaw && !anyOrigin ? originsRaw.split(',') : DEFAULT_BROADCAST_ORIGINS).map(normOrigin).filter((x) => x.length > 0),
  );
  const originOk = (raw: unknown): boolean => {
    if (anyOrigin || raw === undefined || raw === null || raw === '') return true;
    const o = normOrigin(String(raw));
    return allowedOrigins.has(o) || LOCAL_ORIGIN_RE.test(o);
  };
  // P5 (built dark): env BROADCAST_HOLECARD_POLICY, 'off' unless the owner sets it (holeCardDelay.ts).
  const hc = holeCardConfigOf(env);
  const policy: HoleCardPolicy = hc.policy;
  let feedOn = String(env.BROADCAST_FEED ?? '1').trim() !== '0';
  // 2026-11-02 (broadcast fix round 2) — Sit & Go streaming OFF unless env BROADCAST_SITGO=1
  // (Sit & Go players get no streaming notice and no opt-out UI yet). Off: every Sit & Go
  // key answers not_broadcastable (eventKey.ts resolveEventKey reads it through the world
  // below), the events list names none, nothing is archived. Qualifiers unchanged.
  const sitGoOn = sitGoBroadcastOnOf(env);
  const timersOn = deps.timers !== false;

  const packetBudget = intEnv(env.BCAST_PACKETS_PER_10S, 200, 20, 100_000);
  const keyListWaitMs = intEnv(env.BCAST_KEY_LIST_WAIT_MS, KEY_LIST_WAIT_MS, 0, 30_000);
  const persistedRetryMinMs = intEnv(env.BCAST_PERSISTED_RETRY_MS, PERSISTED_RETRY_MIN_MS, 10, PERSISTED_RETRY_MAX_MS);

  const stats = {
    resyncsDropped: 0, resyncsReused: 0, overBudget: 0, keyWaits: 0, persistedRetries: 0,
    connections: 0, subscribes: 0, resyncs: 0, snapshotsSent: 0, programFrames: 0, eventFrames: 0, heartbeats: 0,
    eventsCaptured: 0, hookErrors: 0, buildErrors: 0, builds: 0, feedSwitches: 0,
    tableFrames: 0, frameErrors: 0, featuredEvals: 0, producerPushes: 0, commands: 0, sessionsDropped: 0,
    refusals: {} as Record<string, number>,
    featuredSwitches: { auto: 0, producer: 0, final_table: 0 } as Record<string, number>,
    snapshotBuildMs: { last: 0, max: 0 },
  };
  const countRefusal = (code: string) => { stats.refusals[code] = (stats.refusals[code] || 0) + 1; };
  const producerStats: ProducerStats = { calls: 0, refusals: {}, mutations: 0 };
  const producerLimiters = createProducerLimiters();

  // ---- the world, plus the archive of finished Sit & Gos (the engine drops them 10 s after the finish)
  // and the Sit & Go switch (env BROADCAST_SITGO: this module's env is its only source).
  const archive = new Map<string, ArchivedTournament & { keptUntil: number }>();
  const world: BroadcastWorldFull = Object.assign(Object.create(deps.world) as BroadcastWorldFull, {
    archived: (tid: string) => {
      const a = archive.get(tid);
      if (!a) return undefined;
      if (a.keptUntil < now()) { archive.delete(tid); return undefined; }
      return a;
    },
    sitGoBroadcastOn: () => sitGoOn,
  });

  // ---- tokens (P2-S4) and the program store (P2-S9)
  const tokens = createTokenRegistry({ secret: () => tokenSecretOf(env), db: deps.db ?? null, now, log });
  const store = createProgramStore({ db: deps.db ?? null, now, log });

  const nsp: Namespace = io.of(BROADCAST_NAMESPACE);
  /** KEYLESS sockets per IP, and the keyless / keyed totals (separate budgets). */
  const ipCounts = new Map<string, number>();
  let keylessSockets = 0;
  let keyedSockets = 0;
  const handshakeLimiter = createWindowRateLimiter(30, 60_000);
  const subscribeLimiter = createWindowRateLimiter(10, 10_000);
  const resyncLimiter = createWindowRateLimiter(RESYNC_MAX, RESYNC_WINDOW_MS);
  const packetLimiter = createWindowRateLimiter(packetBudget, PACKET_WINDOW_MS);
  const programs = new Map<string, ProgramCtl>();
  const streams = new Map<string, Stream>();
  const book = createTickerBook();
  const dirtyTables = new Set<string>();
  const dirtyTournaments = new Set<string>();
  const dirtyFrames = new Set<string>();
  const forceEvalTournaments = new Set<string>();
  /** Tables some stream follows (the O(1) test of the tableChanged hook). */
  let watchedTables = new Set<string>();
  /** tableId → the hand that ended live there and when (the handResult hook). */
  const handEnded = new Map<string, { handNumber: number; at: number }>();
  const builds = new Map<string, { at: number; build: ProgramBuild; tickerId: string }>();
  const rankMemory = new Map<string, RankMemory>();
  const broadcastable = new Map<string, { ok: boolean; at: number }>();
  const observed = new Map<string, { hfh: boolean; maxTables: number; finalAnnounced: boolean }>();
  const pendingEvents: Array<{ tournamentId: string; rec: TickerRecord }> = [];
  /** jti → its live /broadcast sockets (connected counts, revocation drops). */
  const sessionsByJti = new Map<string, Set<string>>();
  /** Producer sockets watching a channel: bc:producer:state at most twice a second. */
  const watchers = new Map<string, { channel: ChannelId; lastAt: number; lastSig: string }>();
  const outputsSince = new Map<ChannelId, number>();
  let eventsScheduled = false;
  let framesTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFramesAt = 0;
  let featuredSeq = 0;
  /** P5 — tables of an ARMED event whose public frame must be recorded (<= 5 Hz per table), and when each last was. */
  const dirtyCaptures = new Set<string>();
  const lastCaptureAt = new Map<string, number>();
  const delayBuffer = createHoleCardDelayBuffer({ now, log });

  const feed = (): Feed => ({ mode: 'public', delayMs: 0, holeCards: false, policy });
  const stateOf = (socket: Socket): SocketState | undefined => (socket.data as { bc?: SocketState }).bc;

  // ================================================================ handshake guards
  nsp.use((socket, next) => {
    // Typed to the contract's list: the handshake can send no code the page does not know.
    const refuse = (code: HandshakeRefusalCode) => {
      countRefusal(code);
      const err = new Error(code) as Error & { data?: { code: string } };
      err.data = { code };
      next(err);
    };
    const failed = (e: any) => {
      stats.hookErrors++;
      note('broadcast_handshake_failed', { error: String(e?.message || e).slice(0, 160) });
      refuse('bad_token');
    };
    try {
      if (!feedOn) return refuse('feed_off');
      const ip = deps.realClientIp(socket);
      if (deps.bannedIPs.has(ip)) return refuse('banned');
      if (!handshakeLimiter.hit(ip)) return refuse('rate_limited');
      const key = (socket.handshake.auth as { key?: unknown } | undefined)?.key;
      const st: SocketState = { ip, scopes: [], claims: null, row: null, sub: null, watching: null };
      if (key === undefined || key === null || key === '') {
        // KEYLESS (anonymous): a browser page must be the broadcast page's own origin (a
        // drive-by page cannot fill the pool), then the per-IP and the anonymous caps.
        if (!originOk(socket.handshake.headers?.origin)) return refuse('origin_not_allowed');
        if ((ipCounts.get(ip) || 0) >= maxPerIp || keylessSockets >= maxSockets) return refuse('too_many_connections');
        (socket.data as { bc?: SocketState }).bc = st;
        next();
        return;
      }
      // KEYED: verified FIRST (review fix: it used to meet the anonymous caps before its key
      // was read, so anonymous sockets could lock OBS / the producer out). A presented key is
      // verified, never silently downgraded to a viewer: a refused key is a refused handshake
      // (the page drops its key and reconnects keyless). Valid keys are admitted against their
      // OWN budget (BCAST_MAX_KEYED), which keyless sockets can never use.
      const admitKeyed = (c: ReturnType<typeof tokens.check>) => {
        if (!feedOn) return refuse('feed_off');
        if (!c.ok) {
          note(BROADCAST_TOKEN_REFUSED_TAG, { via: 'handshake', code: c.code });
          return refuse(c.code);
        }
        if (keyedSockets >= maxKeyed) return refuse('too_many_connections');
        st.scopes = c.row.scopes.slice();
        st.claims = c.claims;
        st.row = c.row;
        (socket.data as { bc?: SocketState }).bc = st;
        next();
      };
      const c = tokens.check(key);
      if (!c.ok && c.code === 'revoked' && !tokens.isLoaded()) {
        // The persisted key list is not read yet (a restart): this key is not KNOWN to be
        // revoked. Wait for the list (capped), then decide; still not loaded =
        // 'registry_loading' (fix round 2; it was 'starting'): retryable, the page keeps its
        // key and retries with backoff.
        stats.keyWaits++;
        void tokens.whenLoaded(keyListWaitMs).then((ok) => {
          try {
            if (!ok) {
              note(BROADCAST_TOKEN_REFUSED_TAG, { via: 'handshake', code: 'registry_loading' });
              return refuse('registry_loading');
            }
            admitKeyed(tokens.check(key));
          } catch (e: any) { failed(e); }
        }, (e: any) => failed(e));
        return;
      }
      admitKeyed(c);
    } catch (e: any) {
      failed(e);
    }
  });

  // ================================================================ programs, streams, events
  function channelEvent(channel: ChannelId): ResolvedEvent | null {
    const b = store.bindingOf(channel);
    if (!b) return null;
    const r = resolveEventKey(world, b as any);
    return r.ok ? r.ev : null;
  }

  function resolveCtl(ctl: ProgramCtl): ResolvedEvent | null {
    if (ctl.channel) return channelEvent(ctl.channel);
    if (!ctl.binding) return null;
    const r = resolveEventKey(world, ctl.binding as any);
    return r.ok ? r.ev : null;
  }

  function ctlFor(key: string, channel: ChannelId | null, binding: string | null): ProgramCtl {
    let c = programs.get(key);
    if (!c) {
      c = { key, channel, binding, ev: null, featured: null, evalAt: 0, forceEval: true, dirty: false, autoSceneId: null, autoSceneSince: now(), watchers: 0 };
      programs.set(key, c);
    }
    return c;
  }

  const streamsOf = (programKey: string): Stream[] => [...streams.values()].filter((s) => s.programKey === programKey);

  /**
   * One build per event per second (memo), rebuilt early when its tournament is
   * dirty (the flush passes force) or its ticker moved (an event frame already
   * went out: a snapshot / resync must include it).
   */
  function buildFor(ev: ResolvedEvent, force: boolean): { build: ProgramBuild } | null {
    const t = now();
    const hit = builds.get(ev.key);
    const tickerId = ev.tournamentId ? book.lastId(ev.tournamentId) : '';
    if (hit && !force && t - hit.at < BROADCAST_PROGRAM_MIN_INTERVAL_MS && hit.tickerId === tickerId) return hit;
    const started = Date.now();
    try {
      const ticker: TickerEvent[] = ev.tournamentId ? resolveTicker(world, ev, book.list(ev.tournamentId)) : [];
      const build = buildProgramData({ world, ev, channel: null, now: t, ticker, rankMemory: rankMemory.get(ev.key) });
      rankMemory.set(ev.key, build.rankMemory);
      const entry = { at: t, build, tickerId };
      builds.set(ev.key, entry);
      stats.builds++;
      const ms = Date.now() - started;
      stats.snapshotBuildMs.last = ms;
      if (ms > stats.snapshotBuildMs.max) stats.snapshotBuildMs.max = ms;
      if (builds.size > 64) for (const [k, v] of builds) if (t - v.at > 60_000) { builds.delete(k); rankMemory.delete(k); }
      return entry;
    } catch (e: any) {
      stats.buildErrors++;
      note('broadcast_build_failed', { eventKey: ev.key, error: String(e?.message || e).slice(0, 160) });
      return hit || null;
    }
  }

  /** The program's featured block (table number / name from the build's summaries). */
  function featuredView(ctl: ProgramCtl, build: ProgramBuild): ProgramState['featured'] {
    const f = ctl.featured;
    if (!f || !f.tableId) return { tableId: null, tableNo: null, tableName: null, mode: f ? f.mode : 'auto', reason: f ? f.reason : null, since: f ? f.since : 0 };
    const sum = build.tables.find((x) => x.tableId === f.tableId);
    return { tableId: f.tableId, tableNo: sum ? sum.tableNo : null, tableName: sum ? sum.tableName : null, mode: f.mode, reason: f.reason, since: f.since };
  }

  /** The program a stream shows: the event's build + this program's featured table, scene clock and (a channel) the producer's controls. */
  function programFor(ctl: ProgramCtl, build: ProgramBuild): ProgramState {
    const p = build.program;
    const autoScene = p.scene.id;
    if (ctl.autoSceneId !== autoScene) { ctl.autoSceneId = autoScene; ctl.autoSceneSince = now(); }
    const program: ProgramState = { ...p, channel: ctl.channel, scene: { ...p.scene, since: ctl.autoSceneSince }, featured: featuredView(ctl, build) };
    return ctl.channel ? store.applyTo(program, ctl.channel, { sceneId: autoScene, since: ctl.autoSceneSince }) : program;
  }

  /** The event's tables in play (the featured candidates), in event order. */
  function liveTablesOf(ev: ResolvedEvent | null): string[] {
    const tid = ev?.tournamentId;
    const t = tid ? world.tournament(tid) : undefined;
    if (!t || t.status !== 'running') return [];
    const ids = Array.isArray(t.tableIds) && t.tableIds.length > 0 ? t.tableIds : (t.tableId ? [t.tableId] : []);
    return ids.filter((id) => { const table = world.table(id); return !!table && table.seats.some((s) => s.state === 'occupied' && !s.eliminated); });
  }

  function followedTable(s: Stream, ctl: ProgramCtl): string | null {
    if (s.follow === 'none') return null;
    if (typeof s.follow === 'object' && liveTablesOf(ctl.ev).includes(s.follow.tableId)) return s.follow.tableId;
    return ctl.featured?.tableId ?? null;
  }

  function recomputeWatched(): void {
    const w = new Set<string>();
    for (const s of streams.values()) if (s.tableId) w.add(s.tableId);
    watchedTables = w;
  }

  /** Point a stream at its table (rooms moved in place). `announce`: a 'featured' event frame. */
  function retarget(s: Stream, ctl: ProgramCtl, announce: boolean, t: number): void {
    const want = followedTable(s, ctl);
    if (want === s.tableId) return;
    try {
      if (s.tableId) nsp.in(roomOf(s.key)).socketsLeave(tableRoomOf(s.tableId));
      if (want) nsp.in(roomOf(s.key)).socketsJoin(tableRoomOf(want));
    } catch { /* membership only */ }
    s.tableId = want;
    s.lastTableSig = null;
    s.lastTableAt = 0;
    if (want) dirtyFrames.add(want);
    if (announce && want) {
      const tour = ctl.ev?.tournamentId ? world.tournament(ctl.ev.tournamentId) : undefined;
      const no = tableNoOf(world.table(want)?.config.tableName, tour ? tour.tableIds.indexOf(want) : -1);
      const event: TickerEvent = { id: `f${(++featuredSeq).toString(36)}-${t.toString(36)}`, t, kind: 'featured', ...(no !== null ? { tableNo: no } : {}) };
      s.seq++;
      stats.eventFrames++;
      nsp.to(roomOf(s.key)).emit(BC_EVENTS.frame, { v: 1, seq: s.seq, at: t, kind: 'event', event });
    }
  }

  /**
   * The featured-table recommender of one program (at most twice a second, or now
   * when forced: a lock, a break, a new event). A table change re-points the
   * program's followers (announced: a 'featured' event + a fresh full frame).
   */
  function evaluateFeatured(ctl: ProgramCtl, build: ProgramBuild | null, t: number, announce: boolean): void {
    const ev = ctl.ev;
    if (!ev) return;
    const tid = ev.tournamentId;
    const forced = ctl.forceEval || (!!tid && forceEvalTournaments.has(tid));
    if (!forced && ctl.featured && t - ctl.evalAt < FEATURED_EVAL_MIN_MS) return;
    ctl.forceEval = false;
    ctl.evalAt = t;
    stats.featuredEvals++;
    const prev = ctl.featured;
    const tour = tid ? world.tournament(tid) : undefined;
    const control = ctl.channel ? store.control(ctl.channel) : null;
    let next: FeaturedState;
    let changed = false;
    if (!tour || tour.status !== 'running') {
      next = { tableId: null, mode: 'auto', reason: null, since: prev && prev.tableId === null ? prev.since : t };
      changed = !!prev && prev.tableId !== null;
    } else {
      const b = build || buildFor(ev, false)?.build;
      if (!b) return;
      const bb = num(b.program.clock?.bb) ?? (tour.config.blindLevels[tour.currentBlindLevel]?.bb ?? null);
      const inputs = featuredInputsOf(world, tour, { bubble: b.program.event.prizes.onBubble, handForHand: !!b.program.handForHand?.on, bigBlind: bb });
      const d = recommendFeatured(inputs, { avgStack: b.program.standings.avgStack }, prev, t, {
        lock: control?.lock ? { tableId: control.lock.tableId, until: control.lock.until } : null,
        autoTable: control ? control.autoTable : true,
      });
      next = d.state;
      changed = d.changed;
      // A lock whose table left the event is released (the producer sees auto again).
      if (control?.lock && ctl.channel && !inputs.some((x) => x.tableId === control.lock!.tableId)) store.setLock(ctl.channel, null);
    }
    ctl.featured = next;
    if (prev && (prev.tableId !== next.tableId || prev.mode !== next.mode)) ctl.dirty = true;
    if (changed && next.tableId) {
      stats.featuredSwitches[next.mode] = (stats.featuredSwitches[next.mode] || 0) + 1;
      note(FEATURED_CHANGED_TAG, { program: ctl.key, eventKey: ev.key, from: prev?.tableId ?? null, to: next.tableId, mode: next.mode, reason: next.reason });
    }
    for (const s of streamsOf(ctl.key)) retarget(s, ctl, announce && !s.needsSnapshot, t);
    recomputeWatched();
  }

  /** The PUBLIC frame of a table of a program's event (null: no such table / no frame view). */
  function frameOf(ctl: ProgramCtl, tableId: string, featured: boolean, t: number, resolvers: Map<string, ReturnType<typeof seatIdentityResolver>>): BroadcastTableFrame | null {
    return frameForEvent(ctl.ev, tableId, featured, t, resolvers);
  }

  /** The PUBLIC frame of a table of an event (also what the delayed feed records: P5). */
  function frameForEvent(ev: ResolvedEvent | null, tableId: string, featured: boolean, t: number, resolvers: Map<string, ReturnType<typeof seatIdentityResolver>>): BroadcastTableFrame | null {
    if (!ev || !world.frameTable) return null;
    let view: FrameTableView | undefined;
    try { view = world.frameTable(tableId); } catch { view = undefined; }
    if (!view) return null;
    const tour = ev.tournamentId ? world.tournament(ev.tournamentId) : undefined;
    let identityOf = resolvers.get(ev.key);
    if (!identityOf) { identityOf = seatIdentityResolver(world, ev); resolvers.set(ev.key, identityOf); }
    let turn: { startedAt: number | null; timeout: number | null } | null = null;
    let sittingOut: ReadonlySet<number> | null = null;
    try { turn = world.turnOf?.(tableId) ?? null; } catch { turn = null; }
    try { sittingOut = world.sittingOutOf?.(tableId) ?? null; } catch { sittingOut = null; }
    const ended = handEnded.get(tableId);
    try {
      return toBroadcastTableFrame(view, {
        now: t,
        tableNo: tableNoOf(view.config.tableName, tour ? tour.tableIds.indexOf(tableId) : -1),
        featured,
        turn,
        sittingOut,
        identityOf,
        liveHandEndedAt: ended && ended.handNumber === view.handNumber ? ended.at : null,
      });
    } catch (e: any) {
      stats.frameErrors++;
      note('broadcast_frame_failed', { tableId, error: String(e?.message || e).slice(0, 160) });
      return null;
    }
  }

  const isFeaturedOf = (ctl: ProgramCtl, tableId: string | null): boolean => !!tableId && ctl.featured?.tableId === tableId;

  /** A snapshot for a stream. `record`: it goes to the WHOLE stream (its table signature is now what they have). */
  function snapshotOf(s: Stream, ctl: ProgramCtl, build: ProgramBuild, program: ProgramState, record: boolean): Snapshot {
    const t = now();
    const table = s.tableId ? frameOf(ctl, s.tableId, isFeaturedOf(ctl, s.tableId), t, new Map()) : null;
    if (record) { s.lastTableSig = table ? frameSignature(table) : null; s.lastTableAt = t; }
    const tables: TableSummary[] = build.tables;
    return { v: 1, seq: s.seq, serverNow: t, feed: feed(), program, table, tables };
  }

  function streamFor(key: string, programKey: string, follow: Follow): Stream {
    let s = streams.get(key);
    if (!s) {
      s = { key, programKey, follow, tableId: null, seq: 0, lastSig: null, lastTableSig: null, lastTableAt: 0, needsSnapshot: false, subscribers: { '16x9': 0, '9x16': 0 }, outputs: 0, resyncCache: null };
      streams.set(key, s);
    }
    return s;
  }

  function channelOutputs(channel: ChannelId): number {
    let n = 0;
    for (const s of streams.values()) if (s.programKey === `ch:${channel}`) n += s.outputs;
    return n;
  }
  function noteOutputs(channel: ChannelId | null): void {
    if (!channel) return;
    const n = channelOutputs(channel);
    if (n > 0 && !outputsSince.has(channel)) outputsSince.set(channel, now());
    if (n === 0) outputsSince.delete(channel);
  }

  function leaveStream(socket: Socket): void {
    const st = stateOf(socket);
    if (!st?.sub) return;
    const s = streams.get(st.sub.stream);
    if (s) {
      s.subscribers[st.sub.layout] = Math.max(0, s.subscribers[st.sub.layout] - 1);
      if (st.sub.role === 'output') s.outputs = Math.max(0, s.outputs - 1);
      try { if (s.tableId) socket.leave(tableRoomOf(s.tableId)); } catch { /* gone */ }
      if (s.subscribers['16x9'] + s.subscribers['9x16'] === 0) streams.delete(s.key);
      noteOutputs(programs.get(s.programKey)?.channel ?? null);
    }
    try { socket.leave(roomOf(st.sub.stream)); } catch { /* gone */ }
    st.sub = null;
    recomputeWatched();
  }

  /** Is this account registered in the event (the owner's rule: staff who play it do not broadcast it)? */
  function isEntrant(issuer: { masterUserId: string | null; userId: number | null }, ev: ResolvedEvent): boolean {
    const m = issuer.masterUserId;
    const u = issuer.userId;
    if (!m && (u === null || u === undefined)) return false;
    if (ev.qt && ev.qt.players.some((p) => (!!m && p.masterPlayerId === m) || (u !== null && u !== undefined && p.localUserId === u))) return true;
    const t = ev.tournamentId ? world.tournament(ev.tournamentId) : undefined;
    return !!t && t.players.some((p) => (!!m && p.masterUserId === m) || (u !== null && u !== undefined && p.userId === u));
  }
  const issuerOfState = (st: SocketState) => ({ masterUserId: st.row?.issuedByMaster ?? st.claims?.iss_m ?? null, userId: st.row?.issuedByUser ?? null });

  // ================================================================ connection
  nsp.on('connection', (socket: Socket) => {
    // FIRST, before any listener: every listener below runs guarded (socketGuard.ts).
    installSocketListenerGuard(socket, {
      log: (line) => log(line),
      onHandlerError: (event, err) => { try { deps.onHandlerError?.(event, err); } catch { /* never */ } },
    });
    const st: SocketState = stateOf(socket) || { ip: deps.realClientIp(socket), scopes: [], claims: null, row: null, sub: null, watching: null };
    (socket.data as { bc?: SocketState }).bc = st;
    const keyedSocket = !!st.claims;
    if (keyedSocket) keyedSockets++;
    else { keylessSockets++; ipCounts.set(st.ip, (ipCounts.get(st.ip) || 0) + 1); }
    stats.connections++;
    // Review fix (P1) — a packet budget across EVERY event of this socket (bc:* and the
    // 16 producer events): past it the packet is dropped and the socket disconnected.
    let overBudget = false;
    socket.use((_packet, next) => {
      if (overBudget) return;
      if (packetLimiter.hit(socket.id, now())) { next(); return; }
      overBudget = true;
      stats.overBudget++;
      countRefusal('packet_budget');
      note('broadcast_packet_budget_exceeded', { budget: packetBudget, windowMs: PACKET_WINDOW_MS, keyed: !!st.claims });
      try { socket.disconnect(true); } catch { /* gone */ }
    });
    if (st.claims) {
      const set = sessionsByJti.get(st.claims.jti) || new Set<string>();
      set.add(socket.id);
      sessionsByJti.set(st.claims.jti, set);
    }

    socket.on(BC_EVENTS.subscribe, (data: Record<string, unknown>, ack?: (r: unknown) => void) => {
      const answer = (r: unknown) => { if (typeof ack === 'function') ack(r); };
      const refuse = (code: string, extra: Record<string, unknown> = {}) => { countRefusal(code); answer({ ok: false, code, ...extra }); };
      if (!subscribeLimiter.hit(socket.id)) return refuse('rate_limited');
      if (!data || data.v !== 1) return refuse('version_unsupported');
      const layout: '16x9' | '9x16' = data.layout === '9x16' ? '9x16' : '16x9';
      const channelRaw = data.channel;
      const eventRaw = data.event;
      let channel: ChannelId | null = null;
      if (channelRaw !== undefined && channelRaw !== null) {
        if (!BROADCAST_CHANNELS.includes(channelRaw as ChannelId)) return refuse('channel_unknown');
        channel = channelRaw as ChannelId;
      }
      if (!channel && (eventRaw === undefined || eventRaw === null)) return refuse('channel_unknown');
      let programKey: string;
      let ctl: ProgramCtl;
      let ev: ResolvedEvent | null;
      if (channel) {
        programKey = `ch:${channel}`;
        ev = channelEvent(channel);
        if (eventRaw !== undefined && eventRaw !== null) {
          // Both given: the event must be what the channel shows.
          const want = resolveEventKey(world, String(eventRaw));
          if (!want.ok || !ev || want.ev.key !== ev.key) return refuse('wrong_event');
        }
        ctl = ctlFor(programKey, channel, null);
      } else {
        if (!parseEventKey(eventRaw)) return refuse('event_not_found');
        const r = resolveEventKey(world, String(eventRaw));
        if (!r.ok) return refuse(r.code);
        ev = r.ev;
        // One program per REQUESTED key (its binding): 'next:weekly' moves on week to week, 'q:<id>' never.
        programKey = `ev:${String(eventRaw)}`;
        ctl = ctlFor(programKey, null, String(eventRaw));
      }
      // A keyed session: the key must cover what this shows, and its issuer must not play it.
      if (st.claims) {
        const p = parseTokenEv(st.claims.ev);
        if (!p) return refuse('wrong_event');
        if (p.kind === 'ch') {
          if (p.channel !== '*' && p.channel !== channel) return refuse('wrong_event');
        } else {
          const own = resolveEventKey(world, st.claims.ev);
          if (!own.ok || !ev || own.ev.key !== ev.key) return refuse('wrong_event');
        }
        if (ev && isEntrant(issuerOfState(st), ev)) return refuse('entrant');
      }
      let follow: Follow = 'program';
      if (data.follow === 'none') follow = 'none';
      else if (data.follow && typeof data.follow === 'object' && typeof (data.follow as { tableId?: unknown }).tableId === 'string'
        && TABLE_ID_RE.test((data.follow as { tableId: string }).tableId)) {
        follow = { tableId: (data.follow as { tableId: string }).tableId };
        // A pinned table must be one of this event's tables in play.
        if (ev && !liveTablesOf(ev).includes(follow.tableId)) return refuse('wrong_event');
      }
      const role: 'viewer' | 'output' = data.role === 'output' && st.scopes.includes('output') ? 'output' : 'viewer';
      // 2026-11-02 (P5) — a key with the 'delayed' scope is a DELAYED session: never a
      // stream, never a room; the delayed feed answers (holecards_off while the policy /
      // the producer switch / the issuer allowlist says no; parked until 5 minutes are recorded).
      if (st.scopes.includes('delayed') && st.claims && ev) {
        leaveStream(socket);
        stats.subscribes++;
        return answer(delayed.subscribe(socket, { ev, channel, layout, role, follow, jti: st.claims.jti, issuer: issuerOfState(st) }));
      }
      delayed.leave(socket);
      const streamKey = follow === 'program' ? programKey : follow === 'none' ? `${programKey}|none` : `${programKey}|t:${follow.tableId}`;
      leaveStream(socket);
      const isNew = !streams.has(streamKey);
      const s = streamFor(streamKey, programKey, follow);
      s.subscribers[layout]++;
      if (role === 'output') s.outputs++;
      st.sub = { stream: streamKey, layout, role };
      socket.join(roomOf(streamKey));
      noteOutputs(channel);
      stats.subscribes++;
      // No event bound right now: parked on the stream (its room); the flush sends
      // bc:snapshot to the room the moment it resolves.
      if (!ev) { s.needsSnapshot = true; return refuse('event_not_found', { parked: true }); }
      const b = buildFor(ev, false);
      if (!b) { s.needsSnapshot = true; return refuse('event_not_found', { parked: true }); }
      const t = now();
      // A program's first event: its featured table is picked now (no event frame).
      // A program that moved to another event is switched by the flush (one
      // bc:snapshot to every stream of it).
      if (ctl.ev === null) {
        ctl.ev = ev;
        ctl.featured = null;
        ctl.forceEval = true;
        evaluateFeatured(ctl, b.build, t, false);
      } else if (!ctl.featured) {
        evaluateFeatured(ctl, b.build, t, false);
      }
      const program = programFor(ctl, b.build);
      if (isNew) {
        s.lastSig = programSignature(program);
        s.needsSnapshot = ctl.ev.key !== ev.key;
      }
      // Its table (rooms moved for the whole stream; the frame rides in the snapshot).
      retarget(s, ctl, false, t);
      recomputeWatched();
      if (s.tableId) socket.join(tableRoomOf(s.tableId));
      stats.snapshotsSent++;
      answer({ ok: true, snapshot: snapshotOf(s, ctl, b.build, program, isNew) });
    });

    socket.on(BC_EVENTS.resync, (_data: unknown = {}) => {
      // Review fix (P1): metered per socket; the excess is dropped silently (the page
      // throttles itself to one per 2 s, so a real page never meets this).
      const t = now();
      if (!resyncLimiter.hit(socket.id, t)) { stats.resyncsDropped++; return; }
      if (delayed.has(socket.id)) { stats.resyncs++; delayed.resync(socket); return; }
      const sub = st.sub;
      const s = sub ? streams.get(sub.stream) : undefined;
      const ctl = s ? programs.get(s.programKey) : undefined;
      if (!s || !ctl || !ctl.ev || s.needsSnapshot) return;
      const b = buildFor(ctl.ev, false);
      if (!b) return;
      stats.resyncs++;
      stats.snapshotsSent++;
      // Nothing went to this stream since the last resync snapshot (same seq, same build):
      // the same snapshot, with the clock of now.
      const c = s.resyncCache;
      if (c && c.seq === s.seq && c.build === b.build && t - c.at < RESYNC_SNAPSHOT_REUSE_MS) {
        stats.resyncsReused++;
        socket.emit(BC_EVENTS.snapshot, { ...c.snap, serverNow: t });
        return;
      }
      const snap = snapshotOf(s, ctl, b.build, programFor(ctl, b.build), false);
      s.resyncCache = { seq: s.seq, build: b.build, at: t, snap };
      socket.emit(BC_EVENTS.snapshot, snap);
    });

    socket.on(BC_EVENTS.unsubscribe, (_data: unknown = {}) => { leaveStream(socket); delayed.leave(socket); });

    // The producer API (P2-S9): registered on every socket, the 'producer' scope checked per call.
    attachProducerHandlers(socket, producerHost, producerStats, producerLimiters);

    socket.on('disconnect', () => {
      leaveStream(socket);
      delayed.leave(socket);
      unwatch(socket.id);
      if (st.claims) {
        const set = sessionsByJti.get(st.claims.jti);
        if (set) { set.delete(socket.id); if (set.size === 0) sessionsByJti.delete(st.claims.jti); }
      }
      if (keyedSocket) keyedSockets = Math.max(0, keyedSockets - 1);
      else {
        keylessSockets = Math.max(0, keylessSockets - 1);
        const c = (ipCounts.get(st.ip) || 1) - 1;
        if (c <= 0) ipCounts.delete(st.ip); else ipCounts.set(st.ip, c);
      }
    });
  });

  // ================================================================ the flush (1 s) and the heartbeat (2 s)
  function observe(tid: string): void {
    const t = world.tournament(tid);
    if (!t || t.status !== 'running') return;
    const o = observed.get(tid) || { hfh: false, maxTables: 0, finalAnnounced: false };
    let hfh = false;
    try { hfh = !!world.handForHandOf(tid); } catch { hfh = false; }
    const tables = t.tableIds.filter((x) => !!world.table(x)).length || (t.tableId ? 1 : 0);
    const t0 = now();
    if (hfh !== o.hfh) { captureFor(tid, { kind: hfh ? 'hfhOn' : 'hfhOff' }, t0); o.hfh = hfh; }
    if (tables > o.maxTables) o.maxTables = tables;
    if (!o.finalAnnounced && o.maxTables > 1 && tables === 1) {
      const only = t.tableIds.find((x) => !!world.table(x));
      const no = only ? tableNoOf(world.table(only)?.config.tableName, t.tableIds.indexOf(only)) : null;
      captureFor(tid, no !== null ? { kind: 'finalTable', tableNo: no } : { kind: 'finalTable' }, t0);
      o.finalAnnounced = true;
    }
    observed.set(tid, o);
    if (observed.size > 128) observed.delete(observed.keys().next().value as string);
  }

  /** The finish time of a program's event (on-air auto-clear), else null. */
  function finishedAtOf(ev: ResolvedEvent | null): number | null {
    if (!ev) return null;
    if (ev.qt) return ev.qt.status === 'finished' ? (Number(ev.qt.finishedAt) || null) : null;
    const tid = ev.tournamentId;
    const a = tid ? world.archived?.(tid) : undefined;
    if (a) return a.finishedAt;
    const t = tid ? world.tournament(tid) : undefined;
    return t && t.status === 'finished' ? (t.finishedAt ?? null) : null;
  }

  function expireControls(t: number): void {
    for (const channel of BROADCAST_CHANNELS) {
      const c = store.control(channel);
      if (!c.onAir.on && c.lowerThirds.length === 0 && !c.lock) continue;
      const r = store.expire(channel, t, finishedAtOf(channelEvent(channel)));
      if (r.onAirCleared) audit('system:broadcast', 'BROADCAST_PRODUCER_ACTION', { action: 'onAirExpired', channel, reason: r.onAirCleared });
      if (r.onAirCleared || r.lowerThirdsDropped > 0) { const ctl = programs.get(`ch:${channel}`); if (ctl) ctl.dirty = true; }
    }
  }

  function tick(): void {
    // Review fix: the bounds run whether the feed is on or off (they used to sit after the
    // feed-off return, while the hooks kept adding).
    try {
      const t0 = now();
      for (const [k, v] of archive) if (v.keptUntil < t0) archive.delete(k);
      if (broadcastable.size > 256) broadcastable.clear();
      if (handEnded.size > 512) handEnded.clear();
    } catch { /* bounds only */ }
    try {
      if (!feedOn) {
        dirtyTables.clear();
        dirtyTournaments.clear();
        forceEvalTournaments.clear();
        pendingEvents.length = 0;
        return;
      }
      // Captures queued by the hooks land first (a table broken before this flush is
      // ticked before the final table this flush observes).
      if (deferredWork.length > 0) drainDeferred();
      for (const tableId of dirtyTables) {
        const tid = world.tournamentIdOfTable(tableId);
        if (tid) dirtyTournaments.add(tid);
      }
      dirtyTables.clear();
      const t = now();
      expireControls(t);
      for (const ctl of [...programs.values()]) {
        const own = streamsOf(ctl.key);
        const recording = !!ctl.recording && delayBuffer.isArmed(ctl.binding);
        if (own.length === 0 && ctl.watchers === 0 && !recording) { programs.delete(ctl.key); continue; }
        const ev = resolveCtl(ctl);
        if (!ev) { if (ctl.ev) { ctl.ev = null; ctl.featured = null; } continue; }
        if (ev.tournamentId) observe(ev.tournamentId);
        const changedEvent = !ctl.ev || ctl.ev.key !== ev.key;
        ctl.ev = ev;
        if (changedEvent) { ctl.featured = null; ctl.forceEval = true; }
        const hit = builds.get(ev.key);
        const force = changedEvent || ctl.dirty || (ev.tournamentId ? dirtyTournaments.has(ev.tournamentId) : false) || !hit || t - hit.at >= BUILD_STALE_MS;
        ctl.dirty = false;
        const b = buildFor(ev, force);
        if (!b) continue;
        evaluateFeatured(ctl, b.build, t, !changedEvent);
        const program = programFor(ctl, b.build);
        const sig = programSignature(program);
        // P5 — the armed event's program as it is now (no card), recorded for the delayed feed.
        if (recording && ctl.binding) recordProgram(ctl.binding, ev, b.build, program, sig, t);
        for (const s of own) {
          if (changedEvent || s.needsSnapshot) {
            // A new event on this program (the weekly channel moved on), or a parked
            // stream whose event resolved: a fresh snapshot to the whole stream.
            s.needsSnapshot = false;
            s.seq++;
            s.lastSig = sig;
            retarget(s, ctl, false, t);
            stats.snapshotsSent++;
            nsp.to(roomOf(s.key)).emit(BC_EVENTS.snapshot, snapshotOf(s, ctl, b.build, program, true));
            continue;
          }
          if (sig !== s.lastSig) {
            s.seq++;
            s.lastSig = sig;
            stats.programFrames++;
            nsp.to(roomOf(s.key)).emit(BC_EVENTS.frame, { v: 1, seq: s.seq, at: t, kind: 'program', program });
          }
        }
      }
      dirtyTournaments.clear();
      recomputeWatched();
    } catch (e: any) {
      stats.hookErrors++;
      note('broadcast_tick_failed', { error: String(e?.message || e).slice(0, 160) });
    }
    // P5 — purge the delay buffer past its window; disarm idle / long-finished events.
    try { delayed.housekeeping(); } catch (e: any) { stats.hookErrors++; note('holecard_delay_housekeeping_failed', { error: String(e?.message || e).slice(0, 160) }); }
    flushTables();
  }

  // ================================================================ P5: recording an armed event
  /** An armed event's program (+ its tables in play) into the delay buffer; the table index follows the event. */
  function recordProgram(eventKey: string, ev: ResolvedEvent, build: ProgramBuild, program: ProgramState, sig: string, t: number): void {
    try {
      const live = liveTablesOf(ev);
      // The event as resolved NOW (its tournament id once tables open): the buffer keys its frames and hands by it.
      delayBuffer.setTables(eventKey, live, ev.tournamentId, ev);
      for (const id of live) if (!lastCaptureAt.has(id)) dirtyCaptures.add(id);   // a table new to the event: its first frame
      delayBuffer.captureProgram(eventKey, program, build.tables.map((x) => ({ ...x })), sig, t);
      if (dirtyCaptures.size > 0) scheduleFrames();
    } catch (e: any) {
      stats.hookErrors++;
      note('holecard_delay_record_failed', { what: 'program', error: String(e?.message || e).slice(0, 160) });
    }
  }

  /** The armed tables that changed: their PUBLIC frame (no seat hole card is read), at most 5 Hz per table. */
  function recordTables(t: number, resolvers: Map<string, ReturnType<typeof seatIdentityResolver>>): void {
    const again = new Set<string>();
    for (const tableId of dirtyCaptures) {
      try {
        const ek = delayBuffer.eventOfTable(tableId);
        const ev = ek ? delayBuffer.eventOf(ek) : null;
        if (!ek || !ev) { lastCaptureAt.delete(tableId); continue; }
        const last = lastCaptureAt.get(tableId);
        if (last !== undefined && t - last < BROADCAST_TABLE_MIN_INTERVAL_MS) { again.add(tableId); continue; }
        const frame = frameForEvent(ev, tableId, false, t, resolvers);
        if (!frame) continue;
        lastCaptureAt.set(tableId, t);
        delayBuffer.captureTable(ek, frame, frameSignature(frame), t);
      } catch (e: any) {
        stats.frameErrors++;
        note('holecard_delay_record_failed', { what: 'table', error: String(e?.message || e).slice(0, 160) });
      }
    }
    dirtyCaptures.clear();
    for (const x of again) dirtyCaptures.add(x);
    if (lastCaptureAt.size > 512) for (const k of [...lastCaptureAt.keys()]) if (!delayBuffer.eventOfTable(k)) lastCaptureAt.delete(k);
    if (again.size > 0) scheduleFrames();
  }

  /**
   * Table frames (P2-S3): for each stream, its table's frame when that table
   * changed (or the stream was re-pointed), at most every
   * BROADCAST_TABLE_MIN_INTERVAL_MS per stream, only when the frame differs.
   * Also: the featured-table recommender (at most twice a second per program)
   * and the producers' bc:producer:state (at most twice a second each).
   */
  function flushTables(): void {
    if (framesTimer) { clearTimeout(framesTimer); framesTimer = null; }
    try {
      if (!feedOn) { dirtyFrames.clear(); dirtyCaptures.clear(); forceEvalTournaments.clear(); return; }
      const t = now();
      lastFramesAt = t;
      for (const ctl of programs.values()) if (ctl.ev) evaluateFeatured(ctl, null, t, true);
      forceEvalTournaments.clear();
      const resolvers = new Map<string, ReturnType<typeof seatIdentityResolver>>();
      const memo = new Map<string, BroadcastTableFrame | null>();
      const keep = new Set<string>();
      for (const s of streams.values()) {
        if (!s.tableId || s.needsSnapshot) continue;
        const ctl = programs.get(s.programKey);
        if (!ctl || !ctl.ev) continue;
        if (!dirtyFrames.has(s.tableId) && s.lastTableSig !== null) continue;
        if (s.lastTableSig !== null && t - s.lastTableAt < BROADCAST_TABLE_MIN_INTERVAL_MS) { keep.add(s.tableId); continue; }
        const featured = isFeaturedOf(ctl, s.tableId);
        const mk = `${ctl.ev.key}|${s.tableId}|${featured ? 1 : 0}`;
        let frame = memo.get(mk);
        if (frame === undefined) { frame = frameOf(ctl, s.tableId, featured, t, resolvers); memo.set(mk, frame); }
        if (!frame) continue;
        const sig = frameSignature(frame);
        if (sig === s.lastTableSig) continue;
        s.seq++;
        s.lastTableSig = sig;
        s.lastTableAt = t;
        stats.tableFrames++;
        nsp.to(roomOf(s.key)).emit(BC_EVENTS.frame, { v: 1, seq: s.seq, at: t, kind: 'table', table: frame });
      }
      dirtyFrames.clear();
      for (const x of keep) dirtyFrames.add(x);
      if (keep.size > 0) scheduleFrames();
      if (dirtyCaptures.size > 0) recordTables(t, resolvers);
      pushProducers(t, resolvers);
    } catch (e: any) {
      stats.hookErrors++;
      note('broadcast_table_flush_failed', { error: String(e?.message || e).slice(0, 160) });
    }
  }

  function scheduleFrames(): void {
    if (!timersOn || framesTimer) return;
    const wait = Math.max(0, lastFramesAt + BROADCAST_TABLE_MIN_INTERVAL_MS - now());
    framesTimer = setTimeout(() => { framesTimer = null; flushTables(); }, wait);
    (framesTimer as any).unref?.();
  }

  function heartbeat(): void {
    try {
      if (!feedOn) return;
      const t = now();
      for (const s of streams.values()) {
        const ctl = programs.get(s.programKey);
        const onAir = ctl?.channel ? store.control(ctl.channel).onAir.on : false;
        stats.heartbeats++;
        nsp.to(roomOf(s.key)).emit(BC_EVENTS.heartbeat, { seq: s.seq, serverNow: t, programNow: t, delayMs: 0, onAir });
      }
      // Keyed sessions: a key revoked or expired since its handshake is dropped.
      for (const jti of [...sessionsByJti.keys()]) {
        const v = tokens.stillValid(jti);
        if (!v.ok) dropSessionsOf(jti, v.code);
      }
      // P5 — delayed sessions (direct emit: programNow = now - their delay).
      delayed.heartbeat();
    } catch (e: any) {
      stats.hookErrors++;
      note('broadcast_heartbeat_failed', { error: String(e?.message || e).slice(0, 160) });
    }
  }

  function dropSessionsOf(jti: string, code: 'revoked' | 'expired'): number {
    const ids = [...(sessionsByJti.get(jti) || [])];
    let n = 0;
    for (const id of ids) {
      const sock = nsp.sockets.get(id);
      if (!sock) continue;
      try { sock.emit(BC_EVENTS.authExpired, { code }); } catch { /* gone */ }
      try { sock.disconnect(true); } catch { /* gone */ }
      n++;
    }
    sessionsByJti.delete(jti);
    stats.sessionsDropped += n;
    if (n > 0) note('broadcast_sessions_dropped', { code, sessions: n });
    return n;
  }

  // ================================================================ producers (P2-S9)
  function unwatch(socketId: string): void {
    const w = watchers.get(socketId);
    if (!w) return;
    watchers.delete(socketId);
    const ctl = programs.get(`ch:${w.channel}`);
    if (ctl) ctl.watchers = Math.max(0, ctl.watchers - 1);
  }

  /**
   * A producer's view of its channel: the program exactly as the channel's
   * sources get it + the PUBLIC live view. `program: null` = nothing bound;
   * null = skip this push (the channel just moved to another event: the 1 s flush
   * switches its sources first).
   */
  function producerStateOf(channel: ChannelId, t: number, resolvers: Map<string, ReturnType<typeof seatIdentityResolver>>): ProducerState | { program: null; live: ProducerState['live'] } | null {
    const ctl = ctlFor(`ch:${channel}`, channel, null);
    const ev = resolveCtl(ctl);
    const empty = { program: null, live: { liveNow: t, tables: [], featuredLive: null, bufferMs: 0 } };
    if (!ev) return empty;
    if (!ctl.ev || ctl.ev.key !== ev.key) {
      if (streamsOf(ctl.key).length > 0) return null;
      ctl.ev = ev;
      ctl.featured = null;
      ctl.forceEval = true;
    }
    const b = buildFor(ev, false);
    if (!b) return empty;
    if (!ctl.featured) evaluateFeatured(ctl, b.build, t, false);
    const program = programFor(ctl, b.build);
    const main = streams.get(ctl.key);
    const featuredLive = ctl.featured?.tableId ? frameOf(ctl, ctl.featured.tableId, true, t, resolvers) : null;
    // P5 — the channel's feed SETTING (setFeed): mode + delay, and still the public feed's
    // card flag (false): a producer never holds a hole card. bufferMs = how far back the
    // delay buffer reaches.
    const c = store.control(channel);
    const chFeed: Feed = c.feed.mode === 'delayed' ? { ...feed(), mode: 'delayed', delayMs: c.feed.delayMs } : feed();
    const snapshot: Snapshot = { v: 1, seq: main ? main.seq : 0, serverNow: t, feed: chFeed, program, table: featuredLive, tables: b.build.tables };
    return { program: snapshot, live: { liveNow: t, tables: b.build.tables, featuredLive, bufferMs: delayBuffer.depthMs(ev.key, t) } };
  }

  function pushProducers(t: number, resolvers: Map<string, ReturnType<typeof seatIdentityResolver>>): void {
    for (const [sid, w] of watchers) {
      if (t - w.lastAt < PRODUCER_PUSH_MIN_MS) continue;
      const sock = nsp.sockets.get(sid);
      if (!sock) { unwatch(sid); continue; }
      const state = producerStateOf(w.channel, t, resolvers);
      if (!state) continue;
      const sig = JSON.stringify({ p: state.program ? programSignature(state.program.program) : null, f: state.live.featuredLive ? frameSignature(state.live.featuredLive) : null, s: state.live.tables });
      if (sig === w.lastSig && t - w.lastAt < PRODUCER_REFRESH_MS) continue;
      w.lastAt = t;
      w.lastSig = sig;
      stats.producerPushes++;
      sock.emit(PRODUCER_EVENTS.state, state);
    }
  }

  function channelSummaries(): ChannelSummary[] {
    return BROADCAST_CHANNELS.map((channel) => {
      const ev = channelEvent(channel);
      const subscribers = { '16x9': 0, '9x16': 0 };
      let outputs = 0;
      for (const s of streams.values()) {
        if (s.programKey !== `ch:${channel}`) continue;
        subscribers['16x9'] += s.subscribers['16x9'];
        subscribers['9x16'] += s.subscribers['9x16'];
        outputs += s.outputs;
      }
      const t = ev?.tournamentId ? world.tournament(ev.tournamentId) : undefined;
      return {
        channel, onAir: store.control(channel).onAir.on || outputs > 0, eventKey: ev ? ev.key : null,
        eventName: ev ? (ev.qt ? ev.qt.qualifierName : (t ? t.config.name : (ev.tournamentId ? world.archived?.(ev.tournamentId)?.name ?? null : null))) : null,
        subscribers, outputs,
      };
    });
  }

  async function mintToken(req: MintRequest, issuer: MintIssuer): Promise<IssueResult> {
    if (!tokens.secretConfigured()) return { ok: false, code: 'secret_unset' };
    const v = validateMintRequest(req, now());
    if (!v.ok) return v;
    // Review fix (2026-11-02) — a key minted FROM a producer key (bc:producer:mintKey) is bound
    // to it: the parent must be live, the child must START before the parent expires (a panel
    // key can no longer pre-date keys up to 7 days ahead: its children reach at most the
    // parent's end + their own 12 h), its parent jti is stored + audited, and
    // bc:producer:revokeKey {jti, withChildren:true} revokes it with the parent. Its exp is NOT
    // capped at the parent's: the panel's key is short-lived and retired on Close / renewal,
    // and the OBS keys it made must outlive that.
    if (issuer.parent) {
      const p = tokens.row(issuer.parent.jti);
      if (!p || p.revokedAt !== null || now() >= p.exp) return { ok: false, code: 'not_producer' };
      if (v.nbf >= p.exp) return { ok: false, code: 'invalid_request' };
    }
    // P5 (built dark): the delayed hole-card scope needs the policy on (env
    // BROADCAST_HOLECARD_POLICY, 'off' by default) AND an issuer whose master id is in
    // BROADCAST_HOLECARD_ISSUERS (empty = nobody). Its ev is a q: / t: event (validateMintRequest).
    if (v.scopes.includes('delayed')) {
      if (policy === 'off') return { ok: false, code: 'holecards_off' };
      if (!issuer.masterUserId || !hc.issuers.has(issuer.masterUserId)) return { ok: false, code: 'issuer_not_allowlisted' };
    }
    const who = { masterUserId: issuer.masterUserId, userId: issuer.userId };
    if (v.parsed.kind !== 'ch') {
      const r = resolveEventKey(world, v.ev);
      // not_broadcastable passes through (a club / custom event, or a Sit & Go while
      // BROADCAST_SITGO is off): the same answer as bc:subscribe and the producer bind.
      if (!r.ok) return { ok: false, code: r.code === 'not_broadcastable' ? 'not_broadcastable' : 'event_not_found' };
      if (isEntrant(who, r.ev)) return { ok: false, code: 'issuer_is_entrant' };
    } else if (v.parsed.channel !== '*') {
      const ev = channelEvent(v.parsed.channel);
      if (ev && isEntrant(who, ev)) return { ok: false, code: 'issuer_is_entrant' };
    } else {
      // 'ch:*' produces every channel: its issuer may not play an event a channel SHOWS (the
      // events he would broadcast). Review fix (owner rule: "may not play an event they
      // broadcast"): a registration in some other open qualifier no longer refuses the panel —
      // every producer call is still refused producer_is_entrant on a channel showing an event
      // he plays (producer.ts gateChannel / setEvent / delayedPin), and mintKey checks the
      // entrant rule for the minted key's own event.
      for (const channel of BROADCAST_CHANNELS) {
        const ev = channelEvent(channel);
        if (ev && isEntrant(who, ev)) return { ok: false, code: 'issuer_is_entrant' };
      }
    }
    const m = await tokens.mint(v, who, { parentJti: issuer.parent ? issuer.parent.jti : null });
    if (!m.ok) return m;
    // The token itself is never logged or audited: only its jti and metadata. parentJti: the
    // producer key that minted it (null = the signed-in admin's own broadcastIssueToken).
    audit(issuer.username, BROADCAST_TOKEN_AUDIT_ISSUED, {
      jti: m.row.jti, ev: m.row.ev, scopes: m.row.scopes, label: m.row.label, nbf: m.row.nbf, exp: m.row.exp,
      byUserId: issuer.userId, byMasterUserId: issuer.masterUserId, persisted: m.persisted,
      parentJti: m.row.parentJti, via: issuer.parent ? 'producer_key' : 'admin',
    });
    return { ok: true, token: m.token, jti: m.row.jti, scopes: m.row.scopes.slice(), nbf: m.row.nbf, exp: m.row.exp };
  }

  function staffHoldsKeyFor(masterUserId: string, target: { qualifierId?: string | null; tournamentId?: string | null }): boolean {
    try {
      for (const row of tokens.liveRowsOf(masterUserId)) {
        const p = parseTokenEv(row.ev);
        if (!p) continue;
        if (p.kind === 'ch' && p.channel === '*') {
          // Review fix (2026-11-02): the producer panel's 'ch:*' key bars its holder from an event
          // only while the panel is CONNECTED and a channel shows that event (he is broadcasting
          // it). A key left over from opening the panel once no longer bars him from every
          // qualifier for 12 h; were he to reopen the panel while registered, every channel call
          // on his event is refused producer_is_entrant.
          if ((sessionsByJti.get(row.jti)?.size ?? 0) === 0) continue;
          for (const channel of BROADCAST_CHANNELS) {
            const ev = channelEvent(channel);
            if (ev && ((target.qualifierId && ev.qualifierId === target.qualifierId) || (target.tournamentId && ev.tournamentId === target.tournamentId))) return true;
          }
          continue;
        }
        let ev: ResolvedEvent | null;
        if (p.kind === 'ch') ev = channelEvent(p.channel as ChannelId);
        else { const r = resolveEventKey(world, row.ev); ev = r.ok ? r.ev : null; }
        if (!ev) continue;
        if ((target.qualifierId && ev.qualifierId === target.qualifierId) || (target.tournamentId && ev.tournamentId === target.tournamentId)) return true;
      }
    } catch { /* fail open for the player: a broken check never blocks an entry */ }
    return false;
  }

  const producerHost: ProducerHost = {
    world,
    store,
    tokens,
    now,
    policy: () => policy,
    sessionOf: (socket) => {
      const st = stateOf(socket);
      return st ? { scopes: st.scopes, claims: st.claims, row: st.row } : null;
    },
    channelEvent,
    isEntrant,
    liveTablesOf: (ev) => liveTablesOf(ev),
    currentSceneOf: (channel) => {
      const ctl = programs.get(`ch:${channel}`);
      return (ctl?.autoSceneId ?? 'starting') as SceneId;
    },
    channelSummaries,
    events: () => eventsList(),
    watch: (socket, channel) => {
      unwatch(socket.id);
      if (!channel) return;
      const ctl = ctlFor(`ch:${channel}`, channel, null);
      ctl.watchers++;
      watchers.set(socket.id, { channel, lastAt: 0, lastSig: '' });
      // The first state goes out at once (not after the next flush).
      try {
        const sock = nsp.sockets.get(socket.id);
        const t = now();
        const state = producerStateOf(channel, t, new Map());
        const w = watchers.get(socket.id);
        if (sock && w && state) { w.lastAt = t; stats.producerPushes++; sock.emit(PRODUCER_EVENTS.state, state); }
      } catch (e: any) { note('broadcast_producer_push_failed', { error: String(e?.message || e).slice(0, 160) }); }
    },
    programChanged: (channel, opts) => {
      const ctl = programs.get(`ch:${channel}`);
      if (ctl) { ctl.dirty = true; if (opts?.featured) ctl.forceEval = true; }
      for (const w of watchers.values()) if (w.channel === channel) w.lastAt = 0;
      scheduleFrames();
    },
    sendCommand: (channel, cmd) => {
      const id = randomUUID().slice(0, 8);
      stats.commands++;
      for (const s of streams.values()) if (s.programKey === `ch:${channel}`) nsp.to(roomOf(s.key)).emit(BC_EVENTS.command, { cmd, id });
      delayed.sendCommand(channel, { cmd, id });   // P5: a delayed source of the channel (direct emit)
      return id;
    },
    mint: mintToken,
    dropSessionsOf,
    connectedOf: (jti) => sessionsByJti.get(jti)?.size ?? 0,
    audit,
    note,
    // 2026-11-02 (P5) — the delayed hole-card feed's producer controls.
    delayedCards: {
      status: () => ({
        policy, on: delayed.switchOn(), delayMin: hc.defaultDelayMs / 60_000, minDelayMin: HOLECARD_MIN_DELAY_MS / 60_000,
        maxDelayMin: HOLECARD_MAX_DELAY_MS / 60_000, tables: hc.tables, show: hc.show, armed: delayBuffer.armedEvents().length,
      }),
      setSwitch: (on, actor, issuerMasterUserId) => delayed.setSwitch(on, actor, issuerMasterUserId, 'producer'),
      pin: (tableId, by, covers, entrantOf) => delayed.pin(tableId, by, covers, entrantOf),
    },
  };

  // ================================================================ P5: the delayed sessions
  /** The pids of an event's entrants opted out (or unknown) NOW: their names go 'Player' at release. Bots never. */
  function optedOutPids(ev: ResolvedEvent): Set<string> {
    const out = new Set<string>();
    const tid = ev.tournamentId;
    const t = tid ? world.tournament(tid) : undefined;
    const players = t ? t.players : (tid ? world.archived?.(tid)?.players : undefined) || [];
    const reg = new Map((ev.qt?.players || []).map((p) => [p.playerId, p] as const));
    const seen = new Set<string>();
    const check = (playerId: string, userId: number | undefined, masterUserId: string | undefined) => {
      if (userId === undefined && !masterUserId) return;   // a bot: never opted out
      let o: boolean | undefined;
      try { o = world.optOut({ userId, masterUserId }); } catch { o = undefined; }
      if (o !== false) out.add(broadcastPid(tid || ev.key, playerId));
    };
    for (const p of players) {
      seen.add(p.playerId);
      const r = reg.get(p.playerId);
      check(p.playerId, p.userId ?? r?.localUserId, p.masterUserId ?? r?.masterPlayerId);
    }
    for (const r of ev.qt?.players || []) if (!seen.has(r.playerId)) check(r.playerId, r.localUserId, r.masterPlayerId);
    return out;
  }

  /** The channel whose controls a delayed session gets: its own, else the first channel showing its event. */
  function controlChannelOf(ev: ResolvedEvent, subscribed: ChannelId | null): ChannelId | null {
    if (subscribed) return subscribed;
    for (const ch of BROADCAST_CHANNELS) { const e = channelEvent(ch); if (e && e.key === ev.key) return ch; }
    return null;
  }

  const delayed: DelayedFeed = createDelayedFeed({
    config: hc,
    buffer: delayBuffer,
    now,
    socketOf: (id) => nsp.sockets.get(id),
    tokens,
    isEntrant,
    liveTablesOf: (ev) => liveTablesOf(ev),
    variantOf: (tableId) => world.table(tableId)?.variantId,
    tickerOf: (ev) => (ev.tournamentId ? book.list(ev.tournamentId) : []),
    startRecording: (ev) => {
      const ctl = ctlFor(`dl:${ev.key}`, null, ev.key);
      ctl.recording = true;
      ctl.forceEval = true;
      ctl.dirty = true;
      const live = liveTablesOf(ev);
      delayBuffer.setTables(ev.key, live, ev.tournamentId, ev);
      for (const id of live) dirtyCaptures.add(id);
      scheduleFrames();
    },
    stopRecording: (eventKey) => {
      const ctl = programs.get(`dl:${eventKey}`);
      if (ctl && streamsOf(ctl.key).length === 0 && ctl.watchers === 0) programs.delete(ctl.key);
      else if (ctl) ctl.recording = false;
    },
    controlChannelOf,
    applyControls: (program, channel) => {
      // The producer's controls apply LIVE (a lower third shows when he shows it); its expiry is live time too.
      const p = store.applyTo({ ...program, programNow: now() }, channel, { sceneId: program.scene.id, since: program.scene.since });
      return { ...p, programNow: program.programNow };
    },
    onAirOf: (channel) => (channel ? store.control(channel).onAir.on : false),
    channelDelayMs: (eventKey) => {
      let m: number | null = null;
      for (const ch of BROADCAST_CHANNELS) {
        const c = store.control(ch);
        if (c.feed.mode !== 'delayed') continue;
        const e = channelEvent(ch);
        if (e && e.key === eventKey) m = Math.max(m ?? 0, c.feed.delayMs);
      }
      return m;
    },
    resolveTicker: (ev, rec) => resolveTicker(world, ev, [rec])[0] ?? null,
    optedOutPids,
    eventFinishedAt: (ev) => finishedAtOf(ev),
    programSignature,
    frameSignature,
    countRefusal,
    note,
    audit,
  });

  /** The 250 ms delayed release (the interval runs it; tests call it). Never throws. */
  function releaseTick(): void {
    try {
      if (!feedOn) return;
      delayed.releaseTick();
    } catch (e: any) {
      stats.hookErrors++;
      note('holecard_delay_release_failed', { error: String(e?.message || e).slice(0, 160) });
    }
  }

  // ================================================================ event capture (hooks)
  /**
   * May this tournament be broadcast at all? Memoized: a yes for good, a
   * structural no (a club / custom event: not_broadcastable) for 30 s; an
   * event_not_found is never remembered (a qualifier's tournament exists a moment
   * before its registry entry names it).
   */
  function isBroadcastable(tid: string): boolean {
    const hit = broadcastable.get(tid);
    const t = now();
    if (hit && (hit.ok || t - hit.at < 30_000)) return hit.ok;
    const r = resolveEventKey(world, `t:${tid}`);
    if (r.ok || r.code === 'not_broadcastable') broadcastable.set(tid, { ok: r.ok, at: t });
    return r.ok;
  }

  function captureFor(tid: string, rec: TickerCapture, t: number): void {
    const full = book.record(tid, rec, t);
    stats.eventsCaptured++;
    dirtyTournaments.add(tid);
    // P5 — an armed event's ticker is recorded for the delayed feed (its names resolved at release).
    const armedKey = delayBuffer.eventOfTournament(tid);
    if (armedKey) { try { delayBuffer.captureEvent(armedKey, full); } catch (e) { hookFailed('captureEvent', e); } }
    if (streams.size === 0) return;
    pendingEvents.push({ tournamentId: tid, rec: full });
    if (pendingEvents.length > 500) pendingEvents.splice(0, pendingEvents.length - 500);
    if (!eventsScheduled) {
      eventsScheduled = true;
      setImmediate(() => { eventsScheduled = false; flushEvents(); });
    }
  }

  function flushEvents(): void {
    try {
      if (!feedOn) { pendingEvents.length = 0; return; }
      const batch = pendingEvents.splice(0, pendingEvents.length);
      for (const { tournamentId, rec } of batch) {
        for (const s of streams.values()) {
          const ctl = programs.get(s.programKey);
          if (!ctl || !ctl.ev || ctl.ev.tournamentId !== tournamentId || s.needsSnapshot) continue;
          const [event] = resolveTicker(world, ctl.ev, [rec]);
          s.seq++;
          stats.eventFrames++;
          nsp.to(roomOf(s.key)).emit(BC_EVENTS.frame, { v: 1, seq: s.seq, at: rec.t, kind: 'event', event });
        }
      }
    } catch (e: any) {
      stats.hookErrors++;
      note('broadcast_event_flush_failed', { error: String(e?.message || e).slice(0, 160) });
    }
  }

  const hookFailed = (hook: string, e: any) => {
    stats.hookErrors++;
    note('broadcast_hook_failed', { hook, error: String(e?.message || e).slice(0, 160) });
  };

  /**
   * The hooks run INSIDE game paths (an elimination, the blind timer, a hand
   * result, a rebalance): each does only its O(1) part there — the memoized
   * broadcastable test, the facts that are true only at that instant (the
   * deferred-bust flag, the doubled-up seats, the time) — and queues the rest
   * (entrant lookups, names, frames) for setImmediate. Bounded; never throws.
   */
  const deferredWork: Array<() => void> = [];
  let deferredScheduled = false;
  let deferredDropped = 0;
  function defer(fn: () => void): void {
    deferredWork.push(fn);
    if (deferredWork.length > 1000) { deferredWork.shift(); deferredDropped++; }
    if (!deferredScheduled) {
      deferredScheduled = true;
      setImmediate(drainDeferred);
    }
  }
  function drainDeferred(): void {
    deferredScheduled = false;
    const batch = deferredWork.splice(0, deferredWork.length);
    for (const fn of batch) {
      try { fn(); } catch (e) { hookFailed('deferred', e); }
    }
    flushEvents();
  }

  const hooks: BroadcastHooks = {
    tableChanged(tableId) {
      try {
        if (!feedOn) return;
        // P5: a table of an event ARMED for the delayed feed is recorded (an O(1) Map lookup).
        const armed = delayBuffer.eventOfTable(tableId) !== undefined;
        if (streams.size === 0 && !armed) return;
        dirtyTables.add(tableId);
        // P2-S3: a FOLLOWED table's frame (coalesced, <= 5 Hz). Any other table (an all-in
        // elsewhere may change the featured pick) waits for the 1 s flush: nothing scheduled.
        if (watchedTables.has(tableId)) {
          dirtyFrames.add(tableId);
          scheduleFrames();
        }
        if (armed) {
          dirtyCaptures.add(tableId);
          scheduleFrames();
        }
      } catch (e) { hookFailed('tableChanged', e); }
    },
    tournamentEvent(tournamentId, event, data) {
      try {
        // Review fix: the feed switched off captures nothing (its cleanup runs only while on).
        if (!feedOn || !isBroadcastable(tournamentId)) return;
        // Only true NOW: a hand-for-hand round bust is being eliminated quietly (its settle tells it).
        const deferredBust = event === 'playerEliminated' && !!deps.isDeferredBust?.((data as { playerId?: unknown } | null)?.playerId);
        const at = now();
        defer(() => {
          const rec = tickerFromTournamentEvent(world, tournamentId, event, data, deferredBust);
          if (rec) captureFor(tournamentId, rec, at);
          if (event === 'tournamentFinished') archiveIfSitGo(tournamentId);
        });
      } catch (e) { hookFailed('tournamentEvent', e); }
    },
    handForHandBust(tournamentId, payload) {
      try {
        if (!feedOn || !isBroadcastable(tournamentId)) return;
        const at = now();
        const p = { playerId: payload?.playerId, position: payload?.position, eliminatorId: payload?.eliminatorId };
        defer(() => {
          const rec = bustCapture(world, tournamentId, p, true);
          if (rec) captureFor(tournamentId, rec, at);
        });
      } catch (e) { hookFailed('handForHandBust', e); }
    },
    tableBroken(tournamentId, tableId) {
      try {
        if (!feedOn || !isBroadcastable(tournamentId)) return;
        const at = now();
        const tableName = world.table(tableId)?.config.tableName;   // it still exists now (removed 5 s later)
        // P2-S3: a featured table that broke is replaced at the next flush (reason table_broken).
        forceEvalTournaments.add(tournamentId);
        scheduleFrames();
        defer(() => {
          const t = world.tournament(tournamentId);
          const no = tableNoOf(tableName, t ? t.tableIds.indexOf(tableId) : -1);
          captureFor(tournamentId, no !== null ? { kind: 'tableBroken', tableNo: no } : { kind: 'tableBroken' }, at);
        });
      } catch (e) { hookFailed('tableBroken', e); }
    },
    handResult(tableId, table, results) {
      // P5 — the delayed feed's release gate: THIS hand ended live now (O(1) unless armed;
      // the action log is read only for SHOW 'vpip'). Its own guard: never blocks the rest.
      try {
        const ek = delayBuffer.eventOfTable(tableId);
        if (ek) delayBuffer.markHandEnded(ek, tableId, table.handNumber, now(), hc.show === 'vpip' ? table.actionLog : undefined);
      } catch (e) { hookFailed('handResult.delay', e); }
      try {
        if (!feedOn) return;
        const tid = world.tournamentIdOfTable(tableId);
        if (!tid || !isBroadcastable(tid)) return;
        // The moment this hand ended LIVE (BroadcastTableFrame.liveHandEndedAt).
        handEnded.set(tableId, { handNumber: table.handNumber, at: now() });
        // Read NOW (before any seat is stood up): the all-in winners who doubled. O(the pots).
        const ups = doubleUpsOf(table, results);
        if (ups.length === 0) return;
        const at = now();
        const handNumber = table.handNumber;
        const tableName = table.config.tableName;
        defer(() => {
          const t = world.tournament(tid);
          const no = tableNoOf(tableName, t ? t.tableIds.indexOf(tableId) : -1);
          for (const d of ups) {
            const rec: TickerCapture = { kind: 'doubleUp', playerId: d.playerId, handNumber };
            if (no !== null) rec.tableNo = no;
            captureFor(tid, rec, at);
          }
        });
      } catch (e) { hookFailed('handResult', e); }
    },
    handStarted(tableId, table) {
      // P5 — only an ARMED event's table (O(1) miss otherwise): its seats' hole cards are
      // cloned once into the delay buffer (bounded: <= 10 seats x <= 6 cards). Never throws.
      try {
        const ek = delayBuffer.eventOfTable(tableId);
        if (ek) delayBuffer.captureHandStart(ek, tableId, table, now());
      } catch (e) { hookFailed('handStarted', e); }
    },
  };

  /** A finished template Sit & Go is kept for NEXT_HOLD_FINISHED_MS (its results stay on air). Sit & Go streaming off: never. */
  function archiveIfSitGo(tid: string): void {
    const t = world.tournament(tid);
    if (!t || !isBroadcastableSitGo(t, sitGoOn)) return;
    archive.set(tid, {
      tournamentId: tid, name: t.config.name, finishedAt: now(), entries: t.entries || t.players.length,
      startingStack: t.config.startingChips || 1000,
      players: t.players.map((p) => ({ ...p })), finalResults: (t.finalResults || []).map((r) => ({ ...r })),
      keptUntil: now() + NEXT_HOLD_FINISHED_MS,
    });
    if (archive.size > ARCHIVE_MAX) archive.delete(archive.keys().next().value as string);
  }

  // ================================================================ kill switch + REST
  function setFeedOn(on: boolean, actor: string): { previous: boolean; on: boolean; disconnected: number } {
    const previous = feedOn;
    feedOn = on;
    let disconnected = 0;
    if (!on) {
      disconnected = nsp.sockets.size;
      // P5 — delayed sessions dropped and the delay buffer wiped with the feed. Review fix:
      // the hole-card switch is LATCHED off too (audited BROADCAST_HOLECARDS_SET, via
      // feed_off), so feed on again never resumes hole cards without an allowlisted
      // issuer turning the switch on again.
      try {
        if (delayed.switchOn()) delayed.setSwitch(false, actor, null, 'feed_off');
        delayed.reset('feed_off');
      } catch { /* best effort */ }
      dirtyCaptures.clear();
      try { nsp.disconnectSockets(true); } catch { /* best effort */ }
      streams.clear();
      programs.clear();
      watchers.clear();
      sessionsByJti.clear();
      outputsSince.clear();
      watchedTables = new Set();
      pendingEvents.length = 0;
      dirtyFrames.clear();
    }
    if (previous !== on) stats.feedSwitches++;
    note('broadcast_feed_set', { previous, on, actor, disconnected });
    audit(actor, 'BROADCAST_FEED_SET', { previous, on, disconnected });
    return { previous, on, disconnected };
  }

  function eventsList(): EventSummary[] {
    const out: EventSummary[] = [];
    const t0 = now();
    for (const [qid, qt] of world.qualifiers()) {
      if (qt.status === 'finished' && !(Number(qt.finishedAt) > 0 && t0 - Number(qt.finishedAt) < NEXT_HOLD_FINISHED_MS)) continue;
      const ev: ResolvedEvent = { key: `q:${qid}`, kind: qualifierKind(qt), qualifierId: qid, tournamentId: qt.tournamentId || null, qt };
      const t = qt.tournamentId ? world.tournament(qt.tournamentId) : undefined;
      const phase = eventStatusOf(world, ev, t, undefined, t0);
      const at = Date.parse(qt.scheduledAt);
      out.push({
        eventKey: ev.key, name: qt.qualifierName, kind: ev.kind, scheduledAt: Number.isFinite(at) ? at : 0, phase,
        playersLeft: t && (phase === 'running' || phase === 'tables_open') ? t.players.filter((p) => !p.eliminated).length : 0,
        registered: qt.players.length,
      });
    }
    // Sit & Gos only while Sit & Go streaming is on (env BROADCAST_SITGO=1).
    for (const t of sitGoOn ? world.sitGoTournaments() : []) {
      if (!isBroadcastableSitGo(t, sitGoOn)) continue;
      const tid = t.config.tournamentId;
      const ev: ResolvedEvent = { key: `t:${tid}`, kind: 'sitgo', qualifierId: null, tournamentId: tid, qt: null };
      const phase = eventStatusOf(world, ev, t, undefined, t0);
      out.push({
        eventKey: ev.key, name: t.config.name, kind: 'sitgo', scheduledAt: t.startedAt || t.nextStartTime || t.createdAt || 0, phase,
        playersLeft: phase === 'running' ? t.players.filter((p) => !p.eliminated).length : 0, registered: t.players.length,
      });
    }
    return out.sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  /**
   * Spec R5: a channel is ON AIR when its producer says so (the toggle auto-clears
   * 9 h after it was set, or 2 h after the event finished) OR an OUTPUT-scope
   * source is connected to it. Any output session anywhere also makes the whole
   * server on air (deploy-online.mjs / the pre-push hook refuse a deploy).
   */
  function onAirView(): OnAirView {
    const channels = BROADCAST_CHANNELS.map((channel) => {
      const c = store.control(channel);
      const outs = channelOutputs(channel) + delayed.outputs(channel);   // P5: a delayed source counts too
      const ev = channelEvent(channel);
      const eventKey = ev ? ev.key : null;
      if (c.onAir.on) return { channel, onAir: true, since: c.onAir.since, eventKey, source: 'producer' as const };
      if (outs > 0) return { channel, onAir: true, since: outputsSince.get(channel) ?? null, eventKey, source: 'output' as const };
      return { channel, onAir: false, since: null, eventKey, source: null };
    });
    let anyOutput = delayed.outputs() > 0;
    for (const s of streams.values()) if (s.outputs > 0) { anyOutput = true; break; }
    return { onAir: anyOutput || channels.some((c) => c.onAir), channels };
  }

  const memo = new Map<string, { at: number; body: unknown }>();
  const memoized = (key: string, fn: () => unknown): unknown => {
    const hit = memo.get(key);
    const t = now();
    if (hit && t - hit.at < 1000) return hit.body;
    const body = fn();
    memo.set(key, { at: t, body });
    if (memo.size > 256) memo.clear();
    return body;
  };

  if (deps.app) {
    const app = deps.app;
    app.get('/api/broadcast/events', (_req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        res.json(memoized('events', eventsList));
      } catch (e: any) { res.status(500).json({ error: 'server_error' }); hookFailed('route_events', e); }
    });
    app.get('/api/broadcast/on-air', (_req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        res.json(memoized('on-air', onAirView));
      } catch (e: any) { res.status(500).json({ error: 'server_error' }); hookFailed('route_on_air', e); }
    });
    app.get('/api/broadcast/:eventKey/results', (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        const key = String(req.params?.eventKey || '');
        const body = memoized(`results:${key}`, () => {
          const r = parseEventKey(key) ? resolveEventKey(world, key) : null;
          if (!r || !r.ok) return null;
          const b = buildFor(r.ev, false);
          return b && b.build.program.results ? { results: b.build.program.results } : null;
        });
        if (!body) { res.status(404).json({ error: 'not_finished' }); return; }
        res.json(body);
      } catch (e: any) { res.status(500).json({ error: 'server_error' }); hookFailed('route_results', e); }
    });
    // The runtime kill switch, no restart: {on: 0|1|true|false} + X-Internal-Token (fails closed).
    app.post('/api/broadcast/feed', (req, res) => {
      if (!deps.internalTokenMatches(req.headers?.['x-internal-token'])) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      const raw = req.body?.on;
      const next = raw === true || raw === 1 ? true : raw === false || raw === 0 ? false : null;
      if (next === null) {
        res.status(400).json({ success: false, error: 'on must be 0, 1, true or false', on: feedOn });
        return;
      }
      res.json({ success: true, ...setFeedOn(next, 'internal:broadcast_feed') });
    });
    // 2026-11-02 (P5) — the hole-card KILL SWITCH, no restart: {on: 0|false} + X-Internal-Token
    // (fails closed: 403) drops every delayed session and wipes the delay buffer. Turning hole
    // cards ON is refused here (issuer_not_allowlisted): only the producer switch, from a key of
    // an issuer in BROADCAST_HOLECARD_ISSUERS, turns them on.
    app.post('/api/broadcast/holecards', (req, res) => {
      if (!deps.internalTokenMatches(req.headers?.['x-internal-token'])) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      const raw = req.body?.on;
      const next = raw === true || raw === 1 ? true : raw === false || raw === 0 ? false : null;
      if (next === null) {
        res.status(400).json({ success: false, error: 'on must be 0, 1, true or false', on: delayed.switchOn(), policy });
        return;
      }
      if (next) {
        res.status(409).json({ success: false, code: 'issuer_not_allowlisted', error: 'Hole cards are turned on from the producer panel by an allowlisted issuer.', on: delayed.switchOn(), policy });
        return;
      }
      const r = delayed.setSwitch(false, 'internal:broadcast_holecards', null, 'rest');
      res.json({ success: true, policy, ...(r.ok ? { on: r.on, previous: r.previous, dropped: r.dropped } : { code: r.code }) });
    });
  }

  // ================================================================ timers
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (timersOn) {
    const a = setInterval(tick, BROADCAST_PROGRAM_MIN_INTERVAL_MS);
    const b = setInterval(heartbeat, BROADCAST_HEARTBEAT_MS);
    // P5 — the delayed sessions' release + re-validation (returns at once while there are none).
    const c = setInterval(releaseTick, HOLECARD_RELEASE_TICK_MS);
    (a as any).unref?.();
    (b as any).unref?.();
    (c as any).unref?.();
    timers.push(a, b, c);
  }

  function health(): Record<string, unknown> {
    let subscribers = 0;
    let outputs = 0;
    const byLayout = { '16x9': 0, '9x16': 0 };
    for (const s of streams.values()) {
      byLayout['16x9'] += s.subscribers['16x9'];
      byLayout['9x16'] += s.subscribers['9x16'];
      outputs += s.outputs;
    }
    subscribers = byLayout['16x9'] + byLayout['9x16'];
    let producerSessions = 0;
    for (const sock of nsp.sockets.values()) if (stateOf(sock)?.scopes.includes('producer')) producerSessions++;
    const ts = tokens.stats();
    const ds = delayed.stats() as Record<string, any>;
    const bs = delayBuffer.stats();
    return {
      commit: deps.commit ? deps.commit() : null,
      secretConfigured: tokens.secretConfigured(),
      feedOn,
      sitGoOn,
      policy,
      delayMin: hc.defaultDelayMs / 60_000,
      onAir: onAirView().onAir,
      subscribers,
      subscribersByLayout: byLayout,
      sockets: nsp.sockets.size,
      streams: streams.size,
      programs: programs.size,
      outputs: outputs + delayed.outputs(),
      producerSessions,
      delayedSessions: ds.sessions,
      tokensIssued: ts.issued,
      refusals: { ...stats.refusals },
      handsBuffered: bs.handsBuffered,
      approxBytes: bs.approxBytes,
      releaseStalls: ds.releaseStalls,
      droppedAtCap: bs.droppedAtCap,
      // P5 (counts only: never a card, a key or an id). issuers = how many are allowlisted.
      delayedFeed: {
        switchOn: ds.switchOn, armedEvents: bs.armedEvents, entries: bs.entries, purges: bs.purges, handsCaptured: bs.handsCaptured,
        variantRefused: bs.variantRefused, parked: ds.parked, framesReleased: ds.framesReleased, facesReleased: ds.facesReleased,
        snapshots: ds.snapshots, replaced: ds.replaced, sessionsDropped: ds.sessionsDropped, dropped: ds.dropped, releaseErrors: ds.releaseErrors,
        issuers: hc.issuers.size, tables: hc.tables, show: hc.show, minDelayMin: HOLECARD_MIN_DELAY_MS / 60_000,
      },
      featuredSwitches: { auto: stats.featuredSwitches.auto || 0, producer: stats.featuredSwitches.producer || 0, final_table: stats.featuredSwitches.final_table || 0 },
      snapshotBuildMs: { ...stats.snapshotBuildMs },
      caps: { perIp: maxPerIp, sockets: maxSockets, keyed: maxKeyed, packetsPer10s: packetBudget, anyOrigin },
      connectionsNow: { keyless: keylessSockets, keyed: keyedSockets },
      tokens: ts,
      store: store.stats(),
      producer: { calls: producerStats.calls, mutations: producerStats.mutations, refusals: { ...producerStats.refusals }, watching: watchers.size },
      counters: {
        connections: stats.connections, subscribes: stats.subscribes, resyncs: stats.resyncs, snapshotsSent: stats.snapshotsSent,
        programFrames: stats.programFrames, eventFrames: stats.eventFrames, heartbeats: stats.heartbeats,
        eventsCaptured: stats.eventsCaptured, builds: stats.builds, buildErrors: stats.buildErrors, hookErrors: stats.hookErrors,
        feedSwitches: stats.feedSwitches, archived: archive.size, deferredDropped,
        tableFrames: stats.tableFrames, frameErrors: stats.frameErrors, featuredEvals: stats.featuredEvals,
        producerPushes: stats.producerPushes, commands: stats.commands, sessionsDropped: stats.sessionsDropped,
        watchedTables: watchedTables.size,
        resyncsDropped: stats.resyncsDropped, resyncsReused: stats.resyncsReused, overBudget: stats.overBudget,
        keyWaits: stats.keyWaits, persistedRetries: stats.persistedRetries,
      },
    };
  }

  /**
   * Review fix (2026-11-02) — the persisted key list / channel bindings are re-read with a
   * capped backoff until each has loaded once (a DB error at boot, or initDB still creating the
   * tables, no longer leaves every pre-restart key refused for the life of the process).
   */
  let persistedRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let persistedRetryN = 0;
  let channelsLoaded = !deps.db;
  function schedulePersistedRetry(): void {
    if (!timersOn || persistedRetryTimer || (tokens.isLoaded() && channelsLoaded)) return;
    const wait = Math.min(PERSISTED_RETRY_MAX_MS, persistedRetryMinMs * 2 ** Math.min(6, persistedRetryN++));
    persistedRetryTimer = setTimeout(() => { persistedRetryTimer = null; stats.persistedRetries++; void loadPersisted(); }, wait);
    (persistedRetryTimer as any).unref?.();
  }

  async function loadPersisted(): Promise<void> {
    try {
      const [t, c] = await Promise.all([
        tokens.isLoaded() && deps.db ? Promise.resolve({ loaded: 0, skipped: true } as { loaded: number; error?: string; skipped?: boolean }) : tokens.load(),
        channelsLoaded && deps.db ? Promise.resolve({ loaded: 0, skipped: true } as { loaded: number; error?: string; skipped?: boolean }) : store.load(),
      ]);
      if (!c.error) channelsLoaded = true;
      note('broadcast_persisted_loaded', { tokens: t.loaded, channels: c.loaded, ...(t.error || c.error ? { error: t.error || c.error } : {}) });
      if (t.error || c.error) schedulePersistedRetry();
      else persistedRetryN = 0;
    } catch (e: any) {
      note('broadcast_persisted_load_failed', { error: String(e?.message || e).slice(0, 160) });
      schedulePersistedRetry();
    }
  }

  return {
    hooks,
    feedOn: () => feedOn,
    setFeedOn,
    health,
    tick,
    heartbeat,
    flushEvents,
    flushTables,
    eventsList,
    onAirView,
    mintToken,
    staffHoldsKeyFor,
    loadPersisted,
    tokens,
    store,
    releaseTick,
    delayed,
    delayBuffer,
    stop: () => {
      for (const x of timers) clearInterval(x);
      timers.length = 0;
      if (framesTimer) { clearTimeout(framesTimer); framesTimer = null; }
      if (persistedRetryTimer) { clearTimeout(persistedRetryTimer); persistedRetryTimer = null; }
    },
  };
}

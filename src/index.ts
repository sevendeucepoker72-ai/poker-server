import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';

import { TableManager } from './game/TableManager';
import {
  PokerTable,
  GamePhase,
  PlayerAction,
  Seat,
  MAX_SEATS,
  HandHistoryRecord,
  PokerTableSnapshot,
} from './game/PokerTable';
import {
  connectRedis as connectHandStore,
  snapshotHand,
  clearHand as clearHandSnapshot,
  scanHands,
  flushAll as flushAllHandSnapshots,
  isRedisReady as isHandStoreReady,
  pingRedis,
  appendFairnessCommitment,
  scanFairnessBuffers,
} from './redisStore';
// Re-export GamePhase values for draw/stud phase checks
const DrawPhases = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];
const StudPhases = [GamePhase.ThirdStreet, GamePhase.FourthStreet, GamePhase.FifthStreet, GamePhase.SixthStreet, GamePhase.SeventhStreet];
const BetPhases = [GamePhase.Bet1, GamePhase.Bet2, GamePhase.Bet3, GamePhase.Bet4];
import { Card, cardToString } from './game/Card';
import {
  AIPlayerProfile,
  generateRandomProfile,
  decideAction,
  getThinkingDelay,
  Difficulty,
} from './ai/AIPlayer';
import { ProgressionManager } from './progression/ProgressionManager';
import { HandRank } from './game/HandEvaluator';
import { getFullTrainingData } from './training/TrainingEngine';
import { TournamentManager, DEFAULT_BLIND_LEVELS } from './game/TournamentManager';
import { OmahaTable } from './game/variants/OmahaTable';
import { ShortDeckTable } from './game/variants/ShortDeckTable';
import { FiveCardDrawTable } from './game/variants/FiveCardDrawTable';
import { SevenStudTable } from './game/variants/SevenStudTable';
import { VariantType } from './game/variants/PokerVariant';
import { initDB, loginUser, loginUserAsync, registerUser, isUsernameTaken, getUserFromToken, saveProgress, loadProgress, isUserAdmin, isUserBanned, getUserChips, deductChips, bumpTokenVersion, getAllUsers, banUser as banUserDB, unbanUser as unbanUserDB, addChipsToUser, getTotalUsers, getLeaderboard, searchUsers, mergeUserStats, setDisplayName, getPool, loadInventory, grantItem as dbGrantItem, equipItem as dbEquipItem, hasClaimedToday, recordDailyClaim, updateLoginStreak, tickScratchProgress, consumeScratchCard, claimBattlePassTier as dbClaimBattlePassTier, loadBattlePassClaims, persistCustomization, persistPreferences, recordHand, loadHandHistory, persistStars as dbPersistStars, addStarsToUser, deductStars, loadDurableProgress, DEFAULT_CHIPS, DEFAULT_LEVEL, DEFAULT_XP } from './auth/authManager';
import { validateOAuthToken } from './auth/oauthValidator';
import { notifyPlayer } from './notifyClient';
// 2026-05-12 audit: pino logger import. Hot-path console.log calls are
// being migrated to log.debug so they mute under production pino level
// (info+) without losing the field structure for ops/debug builds.
import { log } from './logger';
import {
  initClubTables,
  createClub,
  joinClub,
  leaveClub,
  getClubInfo,
  getClubMembers,
  getMyClubs,
  approveMember,
  removeMember,
  promoteToManager,
  createClubTable,
  getClubTables,
  updateClubSettings,
  deleteClub,
  searchClubs,
  isClubMember,
  updateClubTableId,
  getClubTableById,
  sendClubMessage,
  getClubMessages,
  getAnnouncements,
  pinMessage,
  unpinMessage,
  getClubLeaderboard,
  getClubStatistics,
  getActivityFeed,
  addActivity,
  createClubTournament,
  getClubTournaments,
  registerForClubTournament,
  startClubTournament,
  createChallenge,
  acceptChallenge,
  declineChallenge,
  getClubChallenges,
  scheduleTable,
  getScheduledTables,
  activateScheduledTable,
  deleteScheduledTable,
  createBlindStructure,
  getBlindStructures,
  deleteBlindStructure,
  inviteToClub,
  getMyInvitations,
  acceptInvitation,
  declineInvitation,
  createUnion,
  inviteToUnion,
  joinUnion,
  getUnionInfo,
  getMemberProfile,
  updateClubBadge,
  generateReferralCode,
  joinByReferral,
  getReferralStats,
  addClubXp,
  getClubLevel,
  getFeaturedClubs,
  getClubOfWeek,
  CLUB_LEVEL_THRESHOLDS,
  CLUB_LEVEL_PERKS,
} from './clubs/clubManager';
import { initFriendTables, listFriends, sendFriendRequest, acceptFriendRequest, removeFriend } from './social/friendManager';
import {
  initPredictionTables, getWallet as getPredictionWallet, placeMarketBet, placePick,
  getSpectatorStats, settleHand as settlePredictions, MARKET_ODDS,
  type PredictionFacts,
} from './social/predictionManager';
import {
  initBracketTables, getBracket, createBracket, eliminatePlayer as eliminateBracketPlayer,
  addSideBet as addBracketSideBet,
} from './social/bracketManager';

// ========== Sentry (optional, prod-only crash reporting) ==========
// Initialized BEFORE the express app + socket.io server so any synchronous
// throw during startup is captured. Loaded via require() so the dependency
// is genuinely optional — if @sentry/node isn't installed (local dev) the
// try/catch swallows the load error and Sentry stays null.
let Sentry: any = null;
if (process.env.SENTRY_DSN) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentryMod = require('@sentry/node');
    sentryMod.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,
    });
    Sentry = sentryMod;
    console.log('[Sentry] Initialized');
  } catch (e: any) {
    console.warn('[Sentry] Init failed (module missing?):', e?.message);
  }
}

// ========== Server Setup ==========

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Limit incoming message size to 16KB — prevents large-payload DoS
  maxHttpBufferSize: 16 * 1024,
  // 2026-05-26 — bump ping/pong cadence above socket.io defaults.
  //
  // Defaults: pingInterval=25000ms, pingTimeout=20000ms. For a tab in
  // foreground that's plenty — the pong fires in <100ms. But Chrome
  // throttles hidden-tab JS to ~1Hz timers, which starves socket.io's
  // pong-handler event loop. The 20s timeout is enough to lose pongs
  // from a user who tabbed away to read chat / glance at another window
  // for half a minute, after which the server force-closes with
  // `transport close`, the client's reconnect loop kicks in, and the
  // action-timer in the meantime auto-folds the user.
  //
  // Earned 2026-05-26: live-reproduced on .online via agent-controlled
  // tab (always `visibilityState: 'hidden'`). Sockets lived only
  // 30–100s before the server reaped them. Bumping pingInterval to 20s
  // and pingTimeout to 45s gives backgrounded tabs ~65s of grace
  // before any disconnect, which covers a typical "tab away to check
  // chat then come back" window without leaving genuinely dead sockets
  // around longer than ~1 min.
  //
  // Real cost: dead sockets sit in memory ~45s longer before cleanup
  // fires. Trivial — poker-server has 49 concurrent users and Railway
  // 1GB RAM; the extra retention is bounded by MAX_CONNECTIONS_PER_IP
  // (5) and per-socket state is small.
  pingInterval: 20_000,
  pingTimeout: 45_000,
});

const PORT = parseInt(process.env.PORT || '3001');

// Redis adapter for Socket.io (optional — for multi-instance scaling)
if (process.env.REDIS_URL) {
  import('@socket.io/redis-adapter').then(({ createAdapter }) => {
    import('redis').then(({ createClient }) => {
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('[Redis] Socket.io adapter connected');
      }).catch(err => console.warn('[Redis] Connection failed, running without:', err.message));
    });
  }).catch(() => console.warn('[Redis] @socket.io/redis-adapter not available'));
}

// ---------------------------------------------------------------------------
// Auth-error telemetry (observability ONLY)
// ---------------------------------------------------------------------------
// Best-effort, throttled reporter that forwards .online token / ticket /
// waitlist auth FAILURES to the central auth_events sink (the Auth Health page
// + watchdog). This NEVER changes an auth decision, validation, or socket
// flow — it only fires alongside the existing failure emits.
//
// - Fire-and-forget: never awaited in the socket hot path, never throws.
// - Throttled: each eventType posts at most once per ~2s so an outage storm
//   coalesces (the watchdog needs presence/volume trend, not every failure).
// - Reuses the SAME shared key env var (AUTH_SERVER_BYPASS_KEY) + base URL
//   (MASTER_API_URL) the unauth /users/:id/me fetches already use. If the key
//   env is missing, it no-ops silently.
const AUTH_EVENT_THROTTLE_MS = 2000;
const authEventLastSent = new Map<string, number>();
function reportAuthEvent(eventType: string, detail: Record<string, any>): void {
  try {
    const key = process.env.AUTH_SERVER_BYPASS_KEY || '';
    if (!key) return; // no shared key configured — no-op silently
    const now = Date.now();
    const last = authEventLastSent.get(eventType) || 0;
    if (now - last < AUTH_EVENT_THROTTLE_MS) return; // throttle storms
    authEventLastSent.set(eventType, now);

    const base =
      process.env.MASTER_API_URL ||
      'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
    // Fire-and-forget — do NOT await; swallow every failure. Uses the same
    // global fetch the other master-API calls in this file rely on.
    fetch(`${base}/auth-events/log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Server-Key': key,
        },
        body: JSON.stringify({ eventType, origin: 'poker-server', detail }),
      })
      .catch(() => {});
  } catch {
    /* telemetry must never affect auth flow */
  }
}

const tableManager = new TableManager();
const progressionManager = new ProgressionManager();
const tournamentManager = new TournamentManager();

// Track which socket is at which table/seat
interface PlayerSession {
  socketId: string;
  tableId: string;
  seatIndex: number;
  playerName: string;
  playerId: string;
  trainingEnabled: boolean;
  sittingOut: boolean;
  avatar?: any;
  // Seat-move queue — set by `moveSeat` handler; consumed by autoStartNextHand
  // on the next hand boundary. Cleared when the move completes or is cancelled.
  // Only meaningful on cash tables; tournament tables reject the event entirely.
  pendingSeatIndex?: number;
  // Deep-link context from player app — e.g. { source: 'waitlist', gameId, venue }
  context?: {
    source: string;
    gameId?: string | null;
    position?: number | null;
    venue?: string | null;
    startTime?: string | null;
  };
}

const playerSessions = new Map<string, PlayerSession>();

// Turn timeout: tableId -> { timeout, seatIndex, turnId }
const turnTimers = new Map<string, { timeout: ReturnType<typeof setTimeout>; seatIndex: number; turnId: number }>();
let globalTurnId = 0;
const TURN_TIMEOUT_MS = 30000; // 30 seconds
// 2026-06-11 audit R10: draw phases (5-card draw / 2-7 triple draw / Badugi)
// have no per-seat turn — the phase just waits for everyone to draw — so the
// per-turn betting timer above never covers them. Without a clock an
// unresponsive HUMAN freezes the table (AI auto-draw, but the phase waits for
// the human's playerDraw that never arrives). One draw-phase timer per table,
// keyed by (handNumber, phase) so it's idempotent across re-broadcasts.
const drawTimers = new Map<string, { timeout: ReturnType<typeof setTimeout>; handNumber: number; phase: GamePhase }>();
const TURN_WARNING_LEAD_MS = 10000; // fire warning 10s before timeout

// Push-notification "prior seat" tracker: tableId -> last seat we already
// fired a `your_turn` push for. MUST be a SEPARATE map from turnTimers
// because turnTimers entries get deleted by their own setTimeout callback;
// using turnTimers as the prior-seat reference caused the 551c785 -> 9128699
// turn-timer-restart regression. We compare this map's value against the
// table's current activeSeatIndex to decide whether the seat actually changed
// since the last broadcast — and only fire the push on real transitions.
const lastActiveSeatByTable = new Map<string, number>();

// Push-notification turn-warning timer: tableId -> { timeout, turnId }.
// Sibling to turnTimers; cleared on the same seatChanged transition so a
// stale warning never fires for a seat that already acted.
const turnWarningTimers = new Map<string, { timeout: ReturnType<typeof setTimeout>; turnId: number }>();

// Track when each table's current turn started (epoch ms) so clients can render
// a per-player countdown ring.
const turnStartedAtMap = new Map<string, number>();
// Tracks which seat "owns" the current turnStartedAt timestamp. Separate
// from turnTimers because timer entries get deleted on callback fire;
// this keeps a stable "prior seat" reference so a subsequent broadcast
// can tell if the active seat really changed or not.
const turnStartedSeatMap = new Map<string, number>();
// 2026-06-11 audit R11: the handNumber the turn timer was last armed for.
// A new hand whose first actor is the SAME seat that acted last in the prior
// hand has priorSeatForStart === activeSeat, so the seat-change check alone
// would skip arming the timer — leaving an unresponsive first actor able to
// stall the table forever. Comparing handNumber catches that case.
const turnStartedHandMap = new Map<string, number>();

// Delta state tracking: socketId -> last full state sent to that client
const lastSentState = new Map<string, Record<string, any>>();
// Cache per-key JSON of the last-sent state so we never double-stringify
// the same `prev` value every tick. Previously `shallowDiff` called
// `JSON.stringify(prevVal)` AND `JSON.stringify(nextVal)` for every
// changed-reference key on every emit, which on a 6-seat table with 30+
// nested objects cost ~3-5ms of event-loop time per player per emit.
// With this cache only `nextVal` is serialized; prevVal's JSON is recalled.
const lastSentJson = new Map<string, Record<string, string>>();

/**
 * Compute a shallow diff between two state objects.
 * Returns only the top-level keys whose values changed (by reference/JSON equality).
 *
 * `socketId` (optional) enables the per-key JSON cache — when passed, we
 * stringify next-side values exactly once and compare against the cached
 * serialization of the last emission for that socket.
 */
function shallowDiff(
  prev: Record<string, any>,
  next: Record<string, any>,
  socketId?: string
): Record<string, any> | null {
  const delta: Record<string, any> = {};
  const cache = socketId ? lastSentJson.get(socketId) : undefined;
  const nextCache: Record<string, string> = {};
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    const prevVal = prev[key];
    const nextVal = next[key];
    // Reference equality: same object → definitely unchanged, skip.
    if (prevVal === nextVal) {
      if (cache && key in cache) nextCache[key] = cache[key];
      continue;
    }
    // Primitives / null / undefined: !== is authoritative.
    const nextIsObj = typeof nextVal === 'object' && nextVal !== null;
    if (!nextIsObj) {
      delta[key] = nextVal;
      continue;
    }
    // Array fast path: differing lengths → guaranteed change, no stringify.
    if (Array.isArray(nextVal) && Array.isArray(prevVal) && nextVal.length !== prevVal.length) {
      const nextJson = JSON.stringify(nextVal);
      delta[key] = nextVal;
      if (socketId) nextCache[key] = nextJson;
      continue;
    }
    // Object / same-length-array: stringify next once; compare to cached
    // prev JSON if available, else stringify prev as a fallback.
    const nextJson = JSON.stringify(nextVal);
    const prevJson = cache && key in cache ? cache[key] : JSON.stringify(prevVal);
    if (prevJson !== nextJson) {
      delta[key] = nextVal;
    }
    if (socketId) nextCache[key] = nextJson;
  }
  if (socketId) lastSentJson.set(socketId, nextCache);
  return Object.keys(delta).length > 0 ? delta : null;
}

/**
 * Emit game state to a single socket using delta compression.
 * Sends a full state on first send or reconnect; subsequent sends only include changed keys.
 * Pass forceFullState=true to always send the full state (e.g. on joinTable / reconnect).
 */
// Fields that MUST survive every delta — turn/timer metadata that the
// client's countdown depends on. Previously a shallowDiff drop could strip
// these on a no-op tick and leave the client's timer frozen at a stale value
// until the next structural change, which presented as a "mid-hand freeze".
// We also always carry `phase`, `activeSeat`, and the variant identifiers so
// the client never has to guess what table it's at.
const ALWAYS_EMIT_KEYS = [
  'turnStartedAt',
  'turnTimeout',
  'serverTurnStartedAt',
  'serverTurnTimeout',
  'phase',
  'activeSeat',
  'activeSeatIndex',
  'variantId',
  'variant',
  'variantName',
  'tableId',
];
function pickAlwaysEmit(state: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!state || typeof state !== 'object') return out;
  for (const k of ALWAYS_EMIT_KEYS) {
    if (k in state) out[k] = state[k];
  }
  return out;
}

function emitGameState(socket: any, state: any, forceFullState = false): void {
  const prev = lastSentState.get(socket.id);
  if (!prev || forceFullState) {
    socket.emit('gameState', { full: true, state, _serverTs: Date.now() });
    lastSentState.set(socket.id, state);
  } else {
    const delta = shallowDiff(prev, state, socket.id) as Record<string, any> | null;
    // Always re-stamp the turn/variant metadata — even on a no-op tick — so
    // the client's timer + variant guards stay fresh. Merging these into the
    // delta is idempotent: equal values are a no-op on the client merger.
    const forceKeys = pickAlwaysEmit(state);
    if (delta) {
      const merged = { ...forceKeys, ...delta };
      socket.emit('gameState', { full: false, delta: merged, _serverTs: Date.now() });
      lastSentState.set(socket.id, { ...prev, ...merged });
    } else {
      // Heartbeat: still carry the always-emit keys so a tick through a
      // quiet period doesn't let turnStartedAt/Timeout grow stale.
      socket.emit('gameState', {
        full: false,
        delta: forceKeys,
        _serverTs: Date.now(),
        _heartbeat: true,
      });
      lastSentState.set(socket.id, { ...prev, ...forceKeys });
    }
  }
}

// Multi-table support: socket -> list of additional table sessions
const multiTableSessions = new Map<string, PlayerSession[]>();

// Spectator tracking: tableId -> Set of socket IDs
const spectators = new Map<string, Set<string>>();

// Emote rate limiting: socketId -> last emote timestamp
const lastEmoteTime = new Map<string, number>();
// Reaction rate limiting: socketId -> last reaction timestamp
const lastReactionTime = new Map<string, number>();
// Chat rate limiting: socketId -> last chat timestamp
const lastChatTime = new Map<string, number>();
// tokenLogin rate limiting: socketId -> { attempts, firstAt }
const tokenLoginAttempts = new Map<string, { attempts: number; firstAt: number }>();
// Per-IP connection tracking: ip -> Set of socketIds
const ipConnections = new Map<string, Set<string>>();
const MAX_CONNECTIONS_PER_IP = 5;
// Per-IP seated players: ip -> Set of tableId:seatIndex strings (collusion detection)
const ipSeatedSlots = new Map<string, Set<string>>();
// Chip velocity tracking: userId -> { chipsAtSessionStart, sessionStartAt }
const chipVelocity = new Map<number, { chipsAtStart: number; sessionStartAt: number; handsThisSession: number; lastActionMs: number[] }>();
// Bot detection: socketId -> list of action response times in ms
const actionTimings = new Map<string, number[]>();
// Action nonce tracking: tableId:seatIndex -> { last nonce used, last-write timestamp }
// The key is NOT a socket id — it's a table:seat composite, so the periodic
// sweeper must age entries by timestamp (not by socket-liveness), otherwise
// it nukes every entry on the first pass and silently disables replay
// protection. See sweeper below + /actions handler at write site.
const actionNonces = new Map<string, { nonce: string; ts: number }>();
// Chip velocity auto-ban counter: userId -> { count, lastAlertAt }
// Decays by 1 every CHIP_VELOCITY_DECAY_MS of quiet time so a user who
// got 2 false-positive alerts months ago isn't auto-banned on alert #3
// today. Without decay, innocent users accumulate permanent state that
// tips them over the ban threshold on a single future alert.
const chipVelocityAlerts = new Map<number, { count: number; lastAlertAt: number }>();
const CHIP_VELOCITY_DECAY_MS = 24 * 60 * 60 * 1000; // 24h quiet → count -= 1

function incrementChipVelocityAlert(userId: number): number {
  const now = Date.now();
  const entry = chipVelocityAlerts.get(userId);
  if (!entry) {
    chipVelocityAlerts.set(userId, { count: 1, lastAlertAt: now });
    return 1;
  }
  // Apply decay: subtract 1 for every full DECAY_MS window of quiet
  const decayWindows = Math.floor((now - entry.lastAlertAt) / CHIP_VELOCITY_DECAY_MS);
  const decayedCount = Math.max(0, entry.count - decayWindows);
  const newCount = decayedCount + 1;
  chipVelocityAlerts.set(userId, { count: newCount, lastAlertAt: now });
  return newCount;
}

// Module-scope audit log (used by anti-cheat auto-ban, admin ops, and buy-in audit).
//
// 2026-06-19 Phase-0 observability: was stdout-only — admin chip grants, restores,
// and bans left NO durable, queryable trail. Now those FORENSIC-CRITICAL events
// ALSO write a row to a durable `audit_log` Postgres table.
//
// 2026-06-19 SAME-DAY CORRECTION: my first version wrote EVERY auditLog call to
// the DB — but auditLog also fires on every buy-in / quickplay join / per-game
// SYSTEM event (high frequency). The shared Cloud SQL instance is db-f1-micro
// (~25 max connections for the WHOLE platform), so a per-game-event INSERT added
// real connection-pool pressure and plausibly aggravated the evening /public
// 500-burst. Fix: gate the durable write to an ALLOWLIST of low-frequency,
// forensic-critical actions (admin money/ban + qualifier credit moves). All
// events still hit stdout; only these few also persist. (The real fix for the
// 500s is upsizing the db-f1-micro tier — tracked separately.)
const DURABLE_AUDIT_ACTIONS = new Set([
  'GRANT_CHIPS', 'RESTORE_BALANCE', 'BAN_USER', 'UNBAN_USER',
  'QUALIFIER_REENTRY_CREDIT_CONSUME', 'QUALIFIER_REENTRY_CREDIT_REFUND',
]);
let _auditTableReady = false;
async function _ensureAuditTable(): Promise<void> {
  if (_auditTableReady) return;
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor TEXT,
    action TEXT NOT NULL,
    details JSONB
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, ts DESC)`);
  _auditTableReady = true;
}
function auditLog(actorUsername: string, action: string, details: Record<string, unknown> = {}) {
  const entry = `[AUDIT] ${new Date().toISOString()} | ${actorUsername} | ${action} | ${JSON.stringify(details)}`;
  console.log(entry);
  // Only forensic-critical, low-frequency actions get the durable DB row (see
  // the DURABLE_AUDIT_ACTIONS note above re: the db-f1-micro connection ceiling).
  if (!DURABLE_AUDIT_ACTIONS.has(action)) return;
  // Durable, best-effort, non-blocking — fire and forget. Audit must never be
  // on the critical path of a chip/ban mutation.
  void (async () => {
    try {
      await _ensureAuditTable();
      await getPool().query(
        'INSERT INTO audit_log (actor, action, details) VALUES ($1, $2, $3)',
        [actorUsername || null, action, details || {}]
      );
    } catch (e: any) {
      try { if (Sentry) Sentry.captureException(e, { tags: { area: 'auditLog' }, extra: { action } }); } catch (_) {}
      try { console.warn('[AUDIT] durable write failed (non-fatal):', e?.message); } catch (_) {}
    }
  })();
}

// ========== Testing-mode unlimited chip refills ==========
//
// On-demand auto-top-up: any buy-in path that finds `dbChips < buyIn`
// calls ensureChipsForBuyIn which credits the user enough to cover the
// buy-in plus a buffer, then proceeds.
//
// 2026-06-11 gameplay-audit finding C1: this is a CHIP FAUCET — the
// surplus (target = max(buyIn*2, 50000)) is farmable via buy-in →
// cash-out round-trips, and .online chips gate championship qualifiers
// (real value). Default flipped to OFF (secure-by-default, matching the
// ADMIN_AUTH_ENFORCE pattern): the faucet is enabled ONLY when
// UNLIMITED_CHIPS_TESTING=1 is explicitly set on Railway. A fresh /
// production deploy now has NO faucet. Set =1 on Railway only for a
// dedicated test environment, never on the live room.
const UNLIMITED_CHIPS_TESTING = process.env.UNLIMITED_CHIPS_TESTING === '1';
async function ensureChipsForBuyIn(
  userId: number,
  username: string,
  buyIn: number
): Promise<number> {
  const dbChips = await getUserChips(userId);
  if (dbChips >= buyIn) return dbChips;
  if (!UNLIMITED_CHIPS_TESTING) return dbChips;
  // Top to buyIn * 2 or 50k, whichever is larger. That gives the player
  // enough to bust once and rebuy without another top-up call.
  const target = Math.max(buyIn * 2, 50000);
  const toAdd = target - dbChips;
  try {
    await addChipsToUser(userId, toAdd);
    auditLog(username, 'TEST_MODE_AUTO_REFILL', {
      buyIn, oldBalance: dbChips, newBalance: target, added: toAdd,
    });
    return target;
  } catch (err) {
    auditLog(username, 'TEST_MODE_AUTO_REFILL_FAILED', { error: (err as Error).message });
    return dbChips;
  }
}

// Pending hand-complete autoStart timers per table, so we can cancel them if
// the table becomes empty / a player disconnects before the timer fires.
const pendingAutoStartTimers = new Map<string, NodeJS.Timeout>();

// 2026-06-11 audit C7: seats whose player LEFT mid-hand while still holding
// chips in the LIVE pot. We can't standUp immediately — SidePotManager
// only counts state==='occupied' seats, so wiping the seat (createEmptySeat)
// erases their committed chips from the pot and short-pays the winner.
// Instead handlePlayerLeave folds them (keeps their dead money in the pot,
// frees the action) and records the seat here; processPendingSeatRemovals()
// — called from the handResult hook AFTER pots are awarded — credits the
// remaining stack back to the wallet and stands the seat up.
//   tableId -> seatIndex -> { who to credit }
const pendingSeatRemovalAfterHand = new Map<string, Map<number, { userId: number; username: string }>>();

function processPendingSeatRemovals(tableId: string): void {
  const pending = pendingSeatRemovalAfterHand.get(tableId);
  if (!pending || pending.size === 0) return;
  pendingSeatRemovalAfterHand.delete(tableId);
  const table = tableManager.getTable(tableId);
  if (!table) return;
  for (const [seatIndex, who] of pending) {
    const seat = table.seats[seatIndex];
    if (seat && seat.state === 'occupied' && !seat.isAI) {
      creditSeatStackToWallet(who.userId, who.username, tableId, seat, 'leave_after_hand');
      table.standUp(seatIndex);
    }
  }
  broadcastGameState(tableId);
}

// Periodic sweeper: prunes stale entries from rate-limit maps so long-running
// servers don't accumulate unbounded memory from abandoned sockets.
const RATE_MAP_TTL_MS = 10 * 60 * 1000; // 10 minutes
setInterval(() => {
  const now = Date.now();
  // tokenLoginAttempts: drop entries whose window has expired
  for (const [sid, entry] of tokenLoginAttempts) {
    if (now - entry.firstAt > 60_000) tokenLoginAttempts.delete(sid);
  }
  // emote / reaction / chat timestamps: if older than TTL and the socket is gone
  for (const [sid, ts] of lastEmoteTime)    { if (now - ts > RATE_MAP_TTL_MS && !io.sockets.sockets.get(sid)) lastEmoteTime.delete(sid); }
  for (const [sid, ts] of lastReactionTime) { if (now - ts > RATE_MAP_TTL_MS && !io.sockets.sockets.get(sid)) lastReactionTime.delete(sid); }
  for (const [sid, ts] of lastChatTime)     { if (now - ts > RATE_MAP_TTL_MS && !io.sockets.sockets.get(sid)) lastChatTime.delete(sid); }
  // actionTimings: drop if socket is gone
  for (const sid of actionTimings.keys())   { if (!io.sockets.sockets.get(sid)) actionTimings.delete(sid); }
  // actionNonces: keyed by tableId:seatIndex (NOT socket id) — age by timestamp.
  // 10-minute TTL: an action older than 10 min can't realistically replay
  // because the table state has moved well past it. (Originally this loop
  // tested against io.sockets.sockets.get(key) and deleted EVERY entry on
  // every pass, silently disabling replay protection — see Map comment above.)
  for (const [key, entry] of actionNonces) {
    if (now - entry.ts > 10 * 60 * 1000) actionNonces.delete(key);
  }
  // chipVelocity: drop entries with no recent activity. Shortened from
  // 4h idle to 30min — the map doesn't need to live past the user's
  // active poker session. Long-tail retention was the main contributor
  // to slow memory climb between Railway redeploys.
  for (const [uid, v] of chipVelocity) {
    const lastMs = v.lastActionMs.length > 0
      ? v.lastActionMs[v.lastActionMs.length - 1]
      : v.sessionStartAt;
    if (now - lastMs > 30 * 60 * 1000) chipVelocity.delete(uid);
  }
}, 60_000).unref?.();

// Auth session tracking: socketId -> userId
// 2026-06-12 — masterUserId (the OIDC sub = master-API users.id) is the key
// qualifier credits are keyed on; userId is poker-server's OWN local users.id.
// Stored at oauthLogin so getQualifications can match the master id, not the
// local int. phone kept as a display/fallback match key.
const authSessions = new Map<string, { userId: number; username: string; masterUserId?: string; phone?: string }>();

/**
 * Resolve the human userId currently occupying a (tableId, seatIndex). Returns
 * undefined if the seat is empty, AI, or unauthenticated. Used by push-
 * notification fire sites so we never surface a notification to a bot/no-op.
 */
function userIdForSeat(tableId: string, seatIndex: number): number | undefined {
  for (const [socketId, session] of playerSessions) {
    if (session.tableId === tableId && session.seatIndex === seatIndex) {
      const auth = authSessions.get(socketId);
      return auth?.userId;
    }
  }
  return undefined;
}

// Tournament table mapping: tableId -> tournamentId
const tournamentTables = new Map<string, string>();

// Fast mode tracking per table (#12)
const fastModeTables = new Map<string, boolean>();

// Track which seats were sitting out when they missed blinds (#16).
// Kept because it's used by the broader sit-in/sit-out flow, but the
// per-seat missed-blind chip debt is now tracked on the `Seat` object
// itself (`seat.deadBlindOwedChips` + `seat.missedBlind`) — single
// source of truth. The old `missedBlinds` Map was removed in the
// missed-blinds audit refactor (resolved 20 findings).
const sitOutTracker = new Map<string, Set<number>>();

/**
 * Sync the current sit-out seat set to the PokerTable. Called after
 * every mutation of `sitOutTracker` so PokerTable.markSittingOutBlinds
 * sees the right set at EVERY startNewHand (there are 13 entry points;
 * previously only one of them pushed the set, which silently broke
 * missed-blind debt tracking for 24/7 cash-table heartbeat auto-starts).
 */
function syncSitOutToTable(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;
  const set = sitOutTracker.get(tableId) || new Set<number>();
  // Garbage-collect stale entries before pushing to the table. A seat
  // that used to be occupied by a sitting-out player but is now empty
  // (player stood up / seat re-assigned) must not propagate into the
  // table's _sittingOutSeats, or the NEXT occupant of that seat index
  // will be charged dead-blind debt on their very first hand. This was
  // the root cause of "first hand I sit down, missed blinds popup".
  for (const idx of [...set]) {
    const s = table.seats[idx];
    if (!s || s.state !== 'occupied' || s.eliminated) {
      set.delete(idx);
    }
  }
  sitOutTracker.set(tableId, set);
  table.setSittingOutSeats(set);
}

// Track AI profiles per table
const aiProfiles = new Map<string, Map<number, AIPlayerProfile>>();

// Seat reservations: userId -> reserved seat info (10-min expiry on disconnect)
interface ReservedSeat {
  tableId: string;
  seatIndex: number;
  playerName: string;
  chips: number;
  avatar?: any;
  sittingOut: boolean;
  expiresAt: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  handsRemaining: number; // disconnect = 20 hands to reconnect
}
const reservedSeats = new Map<number, ReservedSeat>();

// Deep-link ticket replay guard. The master API verifies tickets but does not
// currently mark them as consumed, so a leaked URL from marketing/player app
// could be replayed from multiple sockets to claim multiple seats. We hash the
// raw token string and remember the hash locally; a second attempt within the
// TTL window is rejected. Hashes expire after 2 hours (longer than any token
// lifetime we issue, so legitimate retries within the token window still work
// because the socket re-emit from the same tab doesn't create a new ticket).
const usedTicketHashes = new Map<string, number>(); // hash -> expiresAt (ms)
const TICKET_HASH_TTL_MS = 2 * 60 * 60 * 1000;
function hashTicketToken(token: string): string {
  // Tiny deterministic hash — we don't need cryptographic strength, just
  // enough to distinguish tokens without storing the token itself in memory.
  let h1 = 0x811c9dc5, h2 = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16) + '_' + h2.toString(16) + '_' + token.length.toString(16);
}
function markTicketUsed(token: string): boolean {
  const now = Date.now();
  // Opportunistic GC — drop entries older than TTL on every touch.
  for (const [k, exp] of usedTicketHashes) {
    if (exp <= now) usedTicketHashes.delete(k);
  }
  const hash = hashTicketToken(token);
  if (usedTicketHashes.has(hash)) return false;
  usedTicketHashes.set(hash, now + TICKET_HASH_TTL_MS);
  return true;
}

// Keep seats reserved for 6 hours of wall-clock time (was 30 minutes).
// The real limiter on involuntary stand-up is DISCONNECT_HANDS_LIMIT (20 hands)
// — this TTL is only the absolute hard cap for a silent/idle disconnect, and
// 30 minutes was short enough that a long ride home or overnight pause kicked
// people out of cash games. Expiry now covers typical session lengths.
const SEAT_RESERVE_MS = 6 * 60 * 60 * 1000; // 6 hours
const DISCONNECT_HANDS_LIMIT = 20; // player has 20 hands to reconnect

// Track AI decision timeouts
const aiTimeouts = new Map<string, { handle: NodeJS.Timeout; seatIndex: number }>();

// ========== Bomb Pot Tracking ==========
// tableId -> true means next hand is a bomb pot
const bombPotPending = new Map<string, boolean>();
// tableId -> true means current hand is a bomb pot (skip preflop betting)
const bombPotActive = new Map<string, boolean>();
// 2026-06-11 audit M1: per-table bomb-pot cooldown. Anyone seated could
// previously force 2×BB antes EVERY hand (griefing on public cash tables).
const bombPotCooldownUntil = new Map<string, number>();
const BOMB_POT_COOLDOWN_MS = 5 * 60 * 1000;

// ========== Dealer's Choice Tracking ==========
// tableId -> { enabled, orbitCount, currentVariantIndex }
interface DealersChoiceState {
  enabled: boolean;
  orbitCount: number;
  currentVariantIndex: number;
  dealerAtOrbitStart: number;
}
const dealersChoiceState = new Map<string, DealersChoiceState>();
const DEALERS_CHOICE_VARIANTS: VariantType[] = [
  'texas-holdem', 'omaha', 'short-deck', 'five-card-draw', 'seven-card-stud',
];

// ========== REST Endpoints ==========

app.get('/api/tables', (_req, res) => {
  const tables = tableManager.getTableList().map((t) => ({
    ...t,
    spectatorCount: spectators.get(t.tableId)?.size || 0,
  }));
  res.json(tables);
});

app.get('/api/health', async (_req, res) => {
  // A real liveness check: ping the DB + Redis (if configured) under a 1.5s
  // budget. A 200 here means the process can actually serve traffic; the
  // previous always-200 endpoint let Railway happily route requests at an
  // instance whose DB pool had died.
  try {
    const tDb = getPool().query('SELECT 1');
    const tRedis = pingRedis();
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('healthcheck timeout')), 1500),
    );
    await Promise.race([Promise.all([tDb, tRedis]), timeout]);
    res.json({ status: 'ok', tables: tableManager.getTableList().length });
  } catch (e: any) {
    res.status(503).json({ status: 'unhealthy', error: e?.message || String(e) });
  }
});

// ========== Provably-fair shuffle verification ==========
// Before each hand the server emits the SHA-256 hash of the seed. After the
// hand ends the seed itself is revealed. These endpoints let a client (or
// any 3rd party) verify the hash committed pre-hand matches the seed
// revealed post-hand — i.e. the server didn't swap decks mid-hand.

app.get('/api/fairness/:tableId', (req, res) => {
  const buf = revealedCommitmentsByTable.get(req.params.tableId) || [];
  res.json({ tableId: req.params.tableId, commitments: buf });
});

app.get('/api/fairness/:tableId/:handNumber', (req, res) => {
  const handNumber = Number(req.params.handNumber);
  const buf = revealedCommitmentsByTable.get(req.params.tableId) || [];
  const rc = buf.find((r) => r.handNumber === handNumber);
  if (!rc) { res.status(404).json({ error: 'no revealed commitment for that hand' }); return; }
  const computed = require('crypto').createHash('sha256').update(rc.seed).digest('hex');
  res.json({
    tableId: req.params.tableId,
    handNumber: rc.handNumber,
    seed: rc.seed,
    hash: rc.hash,
    computedHash: computed,
    verified: computed === rc.hash,
    revealedAt: rc.revealedAt,
  });
});

// ========== Qualifier Integration ==========
// Qualified players are fetched from the master API (americanpub.poker) and
// cached in memory. The frontend checks qualification status on login.

interface QualifiedPlayer {
  playerId: string;       // 2026-06-12 — master user id (= .online OIDC sub). THE match key.
  phone?: string;         // display only; may be undefined post-PII-strip. No longer matched on.
  firstName: string;
  lastName: string;
  tier: string;           // 'weekly' | 'monthly'
  creditCount: number;    // how many credits they have
  venueName?: string;
  earnedAt?: string;
}

// In-memory cache of qualified players, keyed by tier
const qualifiedPlayers = new Map<string, QualifiedPlayer[]>();
let lastQualifierFetch = 0;
const QUALIFIER_CACHE_MS = 5 * 60 * 1000; // 5-minute cache

async function fetchQualifiersFromMaster(tier: string = 'weekly'): Promise<QualifiedPlayer[]> {
  try {
    const masterApi = process.env.MASTER_API_URL || 'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
    // Fetch ALL credits (including redeemed) — credits stay valid until the
    // player actually plays in the tournament. Redemption on the master API
    // side is just a registration marker, not a consumption marker.
    //
    // 2026-06-12 — we key qualified players by player_id (master user id),
    // which /qualifier-credits returns to EVERY caller, so the lookup no
    // longer depends on phone_number. We still send X-Internal-Token to
    // enrich rows with phone_number for display, but matching does NOT
    // require it: if the token is unset we get the PII-stripped shape and
    // still populate the cache correctly (keyed by player_id).
    // (Prior 2026-05-20 behaviour keyed by phone and broke outright when the
    // 2026-05-06 PII strip removed phone_number — see CLAUDE.md Pattern A.)
    const internalToken = process.env.INTERNAL_NOTIFY_TOKEN || '';
    const headers: Record<string, string> = {};
    if (internalToken) headers['X-Internal-Token'] = internalToken;
    // 2026-06-12 — fetch ALL credits (?limit=50000). The master default limit
    // is 1000; the promotion already holds 1371 credits (951 weekly + 420
    // monthly) and grows, so the default truncated by earned_at and the gate
    // undercounted qualified players (324 weekly / 209 monthly seen as 248 /
    // 132). 50000 covers the whole promotion; revisit with a dedicated
    // distinct-qualified-players endpoint if credit volume ever approaches it.
    const res = await fetch(`${masterApi}/qualifier-credits?limit=50000`, { headers });
    const data: any = await res.json();
    if (!data.success || !data.credits) return [];

    // Group credits by master user-id + tier and count. Key on player_id
    // (the .online OIDC subject) — NOT phone_number, which was brittle
    // (exact-string match, null phones skipped, broke on the PII strip).
    const byKey = new Map<string, QualifiedPlayer>();
    for (const c of data.credits) {
      if (c.tier !== tier || !c.player_id) continue;
      const key = `${c.player_id}-${c.tier}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.creditCount++;
      } else {
        byKey.set(key, {
          playerId: String(c.player_id),
          phone: c.phone_number,   // display only; undefined when PII-stripped
          firstName: c.first_name || '',
          lastName: c.last_name || '',
          tier: c.tier,
          creditCount: 1,
          venueName: c.venue_name,
          earnedAt: c.earned_at,
        });
      }
    }
    return Array.from(byKey.values());
  } catch (err) {
    console.error('[Qualifiers] Failed to fetch from master API:', err);
    return [];
  }
}

async function getQualifiedPlayers(tier: string): Promise<QualifiedPlayer[]> {
  const now = Date.now();
  if (now - lastQualifierFetch > QUALIFIER_CACHE_MS || !qualifiedPlayers.has(tier)) {
    const players = await fetchQualifiersFromMaster(tier);
    qualifiedPlayers.set(tier, players);
    lastQualifierFetch = now;
  }
  return qualifiedPlayers.get(tier) || [];
}

// 2026-06-19 audit fix — server-authoritative qualifier-entry gate.
// A player is eligible for a tier's qualifier tournaments iff they hold at
// least one credit of that tier. Matches on the MASTER user id (= OIDC sub =
// qualifier_credits.player_id), NEVER poker-server's local int users.id. Per
// the master-side model (see fetchQualifiersFromMaster) a credit qualifies the
// player until they've actually played — redemption is a registration marker,
// not consumption — so this is a read-only check that never mutates credits.
async function isPlayerQualified(masterId: string, tier: string): Promise<boolean> {
  if (!masterId) return false;
  const list = await getQualifiedPlayers(tier);
  return list.some((p) => String(p.playerId) === masterId);
}

// REST endpoint: get qualified players for a tier
app.get('/api/qualifiers/:tier', async (req, res) => {
  const tier = req.params.tier || 'weekly';
  const players = await getQualifiedPlayers(tier);
  // 2026-06-19 audit fix — strip phone (PII) from this unauthenticated endpoint.
  const safe = players.map(({ phone, ...rest }) => rest);
  res.json({ success: true, tier, count: safe.length, players: safe });
});

// REST endpoint: force refresh qualifier cache
app.post('/api/qualifiers/refresh', async (_req, res) => {
  lastQualifierFetch = 0;
  const weekly = await getQualifiedPlayers('weekly');
  const monthly = await getQualifiedPlayers('monthly');
  res.json({ success: true, weekly: weekly.length, monthly: monthly.length });
});

// ========== Qualifier Tournament Registration ==========

interface QualifierTournamentReg {
  qualifierId: string;
  qualifierType: string; // 'weekly' | 'monthly'
  qualifierName: string;
  scheduledAt: string; // ISO timestamp
  startingStack: number;
  maxPlayers: number;
  // Re-entry economics — round-4 audit P0 #4 (2026-05-12). Defaults are
  // applied at registration if the qualifier was lazily created here.
  // TODO: when a `games`-backed qualifier schema lands (with buy_in,
  //       max_re_entries, late_entry_close_time columns), hydrate these
  //       from the row instead of in-memory defaults.
  buyIn?: number;
  maxReEntries?: number;
  requiresQualifierCredit?: boolean;
  players: { playerId: string; playerName: string; phone: string; socketId: string; reEntries?: number }[];
  status: 'registering' | 'starting' | 'running' | 'finished';
  tournamentId: string | null; // linked TournamentManager ID once started
  blindStructure: any[];
}

const qualifierTournaments = new Map<string, QualifierTournamentReg>();

// REST endpoint: get qualifier tournament registrations
app.get('/api/qualifier-tournaments', (_req, res) => {
  const list: any[] = [];
  for (const [id, qt] of qualifierTournaments) {
    list.push({
      qualifierId: id,
      qualifierType: qt.qualifierType,
      qualifierName: qt.qualifierName,
      scheduledAt: qt.scheduledAt,
      registeredCount: qt.players.length,
      maxPlayers: qt.maxPlayers,
      status: qt.status,
      tournamentId: qt.tournamentId,
      players: qt.players.map(p => ({ name: p.playerName })),
    });
  }
  res.json({ success: true, tournaments: list });
});

// REST endpoint: get specific qualifier tournament
app.get('/api/qualifier-tournaments/:qualifierId', (req, res) => {
  const qt = qualifierTournaments.get(req.params.qualifierId);
  if (!qt) return res.json({ success: false, error: 'Not found' });
  res.json({
    success: true,
    tournament: {
      ...qt,
      players: qt.players.map(p => ({ name: p.playerName, phone: p.phone.slice(-4) })),
    },
  });
});

/**
 * Auto-start qualifier tournaments when scheduled time arrives.
 * Runs every 30 seconds.
 */
setInterval(() => {
  const now = Date.now();
  for (const [qualId, qt] of qualifierTournaments) {
    if (qt.status !== 'registering') continue;
    const scheduledTime = new Date(qt.scheduledAt).getTime();
    if (now < scheduledTime) continue;
    if (qt.players.length < 2) continue;

    // Time to start!
    qt.status = 'starting';
    console.log(`[QualifierTournament] Auto-starting ${qt.qualifierName} with ${qt.players.length} players`);

    const turbo = false;
    const humanPlayers = qt.players.map(p => ({
      id: p.playerId,
      name: p.playerName,
      socketId: p.socketId,
    }));

    // Create multi-table tournament with registered players + AI fill
    const playerCount = Math.max(qt.players.length, 18); // minimum 2 tables
    const result = startMultiTableTournament(
      playerCount,
      humanPlayers[0]?.socketId,
      humanPlayers[0]?.id,
      humanPlayers[0]?.name,
      turbo,
    );

    if (result) {
      qt.status = 'running';
      qt.tournamentId = result.tournamentId;

      // Notify all registered players
      for (const p of qt.players) {
        const sock = io.sockets.sockets.get(p.socketId);
        if (sock) {
          const playerTable = tournamentManager.getPlayerTable(result.tournamentId, p.playerId);
          sock.emit('qualifierTournamentStarted', {
            qualifierId: qualId,
            tournamentId: result.tournamentId,
            tableId: playerTable || result.tableIds[0],
            tableCount: result.tableCount,
            playerCount: playerCount,
          });
        }
      }

      // Broadcast to all connected clients
      io.emit('qualifierTournamentUpdate', {
        qualifierId: qualId,
        status: 'running',
        tournamentId: result.tournamentId,
        playerCount: playerCount,
        tableCount: result.tableCount,
      });
    } else {
      qt.status = 'registering'; // revert on failure
      console.error(`[QualifierTournament] Failed to start ${qt.qualifierName}`);
    }
  }
}, 30000);

// ========== Helper Functions ==========

function getVariantInfo(table: PokerTable): { variant: VariantType; variantName: string; holeCardCount: number; hasDrawPhase: boolean; isStudGame: boolean; isPineapple?: boolean; pineappleDiscardActive?: boolean } {
  // Pineapple / Crazy Pineapple — client enables manual discard when the table
  // has 3 hole cards and the current phase precedes the discard transition.
  const vid = (table as any).variantId;
  const isCrazy = vid === 'crazy-pineapple';
  const isRegular = vid === 'pineapple';
  if (isRegular || isCrazy) {
    const discardActive = isCrazy
      ? table.currentPhase === GamePhase.Flop
      : table.currentPhase === GamePhase.PreFlop;
    return {
      variant: 'texas-holdem' as VariantType,
      variantName: table.variantName,
      holeCardCount: 3,
      hasDrawPhase: false,
      isStudGame: false,
      isPineapple: true,
      pineappleDiscardActive: discardActive,
    };
  }
  if (table instanceof OmahaTable) {
    return {
      variant: table.variant.type,
      variantName: table.variant.name,
      holeCardCount: table.holeCardCount,
      hasDrawPhase: false,
      isStudGame: false,
    };
  }
  if (table instanceof ShortDeckTable) {
    return {
      variant: table.variant.type,
      variantName: table.variant.name,
      holeCardCount: table.holeCardCount,
      hasDrawPhase: false,
      isStudGame: false,
    };
  }
  if (table instanceof FiveCardDrawTable) {
    return {
      variant: table.variant.type,
      variantName: table.variant.name,
      holeCardCount: table.holeCardCount,
      hasDrawPhase: true,
      isStudGame: false,
    };
  }
  if (table instanceof SevenStudTable) {
    return {
      variant: table.variant.type,
      variantName: table.variant.name,
      holeCardCount: table.holeCardCount,
      hasDrawPhase: false,
      isStudGame: true,
    };
  }
  return {
    variant: 'texas-holdem',
    variantName: table.variantName,
    holeCardCount: table.holeCardCount,
    hasDrawPhase: false,
    isStudGame: false,
  };
}

function getGameStateForPlayer(
  table: PokerTable,
  playerSeatIndex: number,
  trainingEnabled: boolean = false
): object {
  const variantInfo = getVariantInfo(table);

  // Build a name→session lookup for rank enrichment and avatar passthrough
  const nameToPlayerId = new Map<string, string>();
  const nameToAvatar = new Map<string, any>();
  for (const [, session] of playerSessions) {
    if (session.tableId === table.config.tableId) {
      nameToPlayerId.set(session.playerName, session.playerId);
      if (session.avatar) nameToAvatar.set(session.playerName, session.avatar);
    }
  }

  const seats = table.seats.map((seat) => {
    const seatData: any = {
      seatIndex: seat.seatIndex,
      playerName: seat.playerName,
      chipCount: seat.chipCount,
      currentBet: seat.currentBet,
      folded: seat.folded,
      allIn: seat.allIn,
      lastAction: seat.lastAction,
      isAI: seat.isAI,
      state: seat.state,
      hasCards: seat.holeCards.length > 0,
      eliminated: seat.eliminated,
      // Dead-blind debt surfaced to the client so the seat pod can
      // render a small "🎯 N" badge on seats currently owing dead
      // blinds (audit finding: observers couldn't see who owed).
      missedBlind: seat.missedBlind || 'none',
      deadBlindOwedChips: seat.deadBlindOwedChips || 0,
    };

    // Attach rank and avatar for display on nameplates/seats
    if (seat.playerName && !seat.isAI) {
      const pid = nameToPlayerId.get(seat.playerName);
      const prog = pid ? progressionManager.getProgress(pid) : null;
      if (prog) seatData.rank = prog.rank;
      const av = nameToAvatar.get(seat.playerName);
      if (av) seatData.avatar = av;
    }

    // For Stud games: show face-up cards to everyone
    if (table instanceof SevenStudTable && seat.holeCards.length > 0 && !seat.folded) {
      const studTable = table as SevenStudTable;
      const faceUpCards = studTable.getFaceUpCards(seat.seatIndex);
      seatData.faceUpCards = faceUpCards.map((c) => ({
        suit: c.suit,
        rank: c.rank,
        display: cardToString(c),
      }));
      seatData.faceUpCardCount = faceUpCards.length;
      seatData.totalCardCount = seat.holeCards.length;
    }

    // During showdown, reveal non-folded hands
    if (
      table.currentPhase === GamePhase.Showdown ||
      table.currentPhase === GamePhase.HandComplete
    ) {
      if (!seat.folded && seat.holeCards.length > 0) {
        seatData.holeCards = seat.holeCards.map((c) => ({
          suit: c.suit,
          rank: c.rank,
          display: cardToString(c),
        }));
      }
    }

    return seatData;
  });

  const pots = table.getCurrentPots();

  const stateObj: any = {
    tableId: table.config.tableId,
    tableName: table.config.tableName,
    phase: table.currentPhase,
    communityCards: table.communityCards.map((c) => ({
      suit: c.suit,
      rank: c.rank,
      display: cardToString(c),
    })),
    pot: table.getTotalPot(),
    pots: pots.map((p) => ({
      amount: p.amount,
      name: p.name,
      eligiblePlayers: p.eligibleSeatIndices,
    })),
    activeSeatIndex: table.activeSeatIndex,
    turnStartedAt: turnStartedAtMap.get(table.config.tableId) ?? 0,
    turnTimeout: TURN_TIMEOUT_MS,
    dealerButtonSeat: table.dealerButtonSeat,
    currentBetToMatch: table.currentBetToMatch,
    handNumber: table.handNumber,
    smallBlind: table.config.smallBlind,
    bigBlind: table.config.bigBlind,
    minRaise: table.getMinRaise(),
    seats,
    yourSeat: playerSeatIndex,
    yourCards:
      playerSeatIndex >= 0 && playerSeatIndex < MAX_SEATS
        ? table.seats[playerSeatIndex].holeCards.map((c) => ({
            suit: c.suit,
            rank: c.rank,
            display: cardToString(c),
          }))
        : [],
    variant: variantInfo.variant,
    variantName: variantInfo.variantName,
    holeCardCount: variantInfo.holeCardCount,
    hasDrawPhase: variantInfo.hasDrawPhase,
    isStudGame: variantInfo.isStudGame,
    sittingOut: false, // Will be overridden per-player in broadcastGameState
  };

  // Add draw phase info for draw games
  if (table instanceof FiveCardDrawTable) {
    const drawTable = table as FiveCardDrawTable;
    stateObj.isDrawPhase = drawTable.currentDrawPhase !== null;
    stateObj.drawPhase = drawTable.currentDrawPhase;
    stateObj.drawsCompleted = [...drawTable.drawsCompleted];
  }

  // Add stud card visibility info
  if (table instanceof SevenStudTable) {
    const studTable = table as SevenStudTable;
    stateObj.studPhase = studTable.currentStudPhase;
    if (playerSeatIndex >= 0 && playerSeatIndex < MAX_SEATS) {
      const cardInfo = studTable.getStudCardInfo(playerSeatIndex);
      stateObj.yourCardVisibility = cardInfo.map(ci => ({
        card: { suit: ci.card.suit, rank: ci.card.rank, display: cardToString(ci.card) },
        faceUp: ci.faceUp,
      }));
    }
  }

  // Add hand result data during Showdown/HandComplete phases
  if (
    (table.currentPhase === GamePhase.Showdown ||
      table.currentPhase === GamePhase.HandComplete) &&
    table.lastHandResult
  ) {
    const serializeCard = (c: Card) => ({
      suit: c.suit,
      rank: c.rank,
      display: cardToString(c),
    });

    stateObj.handResult = {
      winners: table.lastHandResult.winners.map((w) => ({
        seatIndex: w.seatIndex,
        playerName: w.playerName,
        chipsWon: w.chipsWon,
        handName: w.handName,
        bestFiveCards: w.bestFiveCards.map(serializeCard),
      })),
      showdownHands: table.lastHandResult.showdownHands.map((h) => ({
        seatIndex: h.seatIndex,
        playerName: h.playerName,
        handName: h.handName,
        bestFiveCards: h.bestFiveCards.map(serializeCard),
        holeCards: h.holeCards.map(serializeCard),
      })),
      // Per-pot breakdown for UI: who won what from which pot
      potBreakdown: table.lastHandResult.pots.map((p: any) => ({
        name: p.name || 'Main Pot',
        amount: p.amount,
        winnerAmounts: p.winnerAmounts || [],
      })),
    };
  }

  // Add bomb pot flag — ALWAYS emit (true OR false) so the delta
  // compression actually clears the flag client-side. Previously we
  // only set stateObj.bombPot = true when active; when it flipped back
  // to inactive the key was omitted, shallowDiff didn't see a change,
  // the client kept its stale `true` and the banner stayed stuck.
  stateObj.bombPot = !!bombPotActive.get(table.config.tableId);

  // Add dealer's choice info
  const dcState = dealersChoiceState.get(table.config.tableId);
  if (dcState?.enabled) {
    stateObj.dealersChoice = true;
    stateObj.dealersChoiceVariant = DEALERS_CHOICE_VARIANTS[dcState.currentVariantIndex];
    const nextIndex = (dcState.currentVariantIndex + 1) % DEALERS_CHOICE_VARIANTS.length;
    stateObj.dealersChoiceNext = DEALERS_CHOICE_VARIANTS[nextIndex];
  }

  // Add ante info if configured
  if (table.config.ante && table.config.ante > 0) {
    stateObj.ante = table.config.ante;
  }

  // Add missed-blind info for this player. Now sourced directly from the
  // seat object (seat.deadBlindOwedChips + seat.missedBlind) — single
  // source of truth after the audit refactor.
  //
  // 2026-05-26 — explicitly send `null` when the debt clears, not just
  // omit the field. The poker-3d delta-merge protocol treats absent
  // keys as "unchanged" (see App.jsx gameState handler), so omitting
  // the field left the stale `missedBlinds` value persisted in the
  // client's store, which kept rendering the "POST BLINDS: 50" panel
  // across multiple post-resolution hands. Sending null overwrites it
  // and the GameHUD's `missedBlindsAmount > 0` gate evaluates falsy.
  if (playerSeatIndex >= 0) {
    const seat = table.seats[playerSeatIndex];
    if (seat && (seat.deadBlindOwedChips || 0) > 0) {
      stateObj.missedBlinds = seat.deadBlindOwedChips;
      stateObj.missedBlindType = seat.missedBlind; // 'small' | 'big' | 'both'
    } else {
      // Explicitly clear via the delta protocol — null overwrites to null.
      stateObj.missedBlinds = null;
      stateObj.missedBlindType = null;
    }
  }

  // Add pots breakdown data for side pot display (#18)
  if (table.lastHandResult && (table.currentPhase === GamePhase.Showdown || table.currentPhase === GamePhase.HandComplete)) {
    stateObj.potBreakdown = table.lastHandResult.pots;
    // Add chop indicator (#19)
    const winnerSet = new Set(table.lastHandResult.winners.map(w => w.seatIndex));
    if (winnerSet.size > 1) {
      stateObj.isChoppedPot = true;
      stateObj.chopDetails = table.lastHandResult.winners.map(w => ({
        seatIndex: w.seatIndex,
        playerName: w.playerName,
        share: w.chipsWon,
      }));
    }
  }

  // Add training data if enabled
  if (
    trainingEnabled &&
    playerSeatIndex >= 0 &&
    playerSeatIndex < MAX_SEATS &&
    table.currentPhase !== GamePhase.WaitingForPlayers &&
    table.currentPhase !== GamePhase.HandComplete
  ) {
    const seat = table.seats[playerSeatIndex];
    if (seat.holeCards.length >= 2 && !seat.folded) {
      const numOpponents = table.seats.filter(
        (s) =>
          s.state === 'occupied' &&
          !s.folded &&
          !s.eliminated &&
          s.seatIndex !== playerSeatIndex
      ).length;

      const callAmount = Math.max(0, table.currentBetToMatch - seat.currentBet);
      const potSize = table.getTotalPot();
      const chipStack = seat.chipCount;

      try {
        stateObj.trainingData = getFullTrainingData(
          seat.holeCards,
          table.communityCards,
          numOpponents,
          callAmount,
          potSize,
          chipStack,
          table.currentPhase
        );
      } catch (e) {
        // Training data calculation failed, skip
      }
    }
  }

  return stateObj;
}

function broadcastGameState(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;

  // Send personalized state to each player at the table
  for (const [socketId, session] of playerSessions) {
    if (session.tableId === tableId) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        const state: any = getGameStateForPlayer(table, session.seatIndex, session.trainingEnabled);
        state.sittingOut = session.sittingOut || false;
        emitGameState(socket, state);
      }
    }
  }

  // Also broadcast to any spectators in the room.
  // Guard activeSeatIndex: when no hand is in progress PokerTable leaves it
  // at -1, which spectator clients can mis-use as an array index. Emit null
  // in that case — client code that checks `typeof activeSeatIndex === 'number'`
  // or `activeSeatIndex >= 0` both handle the nullish case correctly.
  io.to(`table:${tableId}`).emit('tableUpdate', {
    tableId,
    phase: table.currentPhase,
    pot: table.getTotalPot(),
    activeSeatIndex: table.activeSeatIndex < 0 ? null : table.activeSeatIndex,
    communityCards: table.communityCards.map((c) => ({
      suit: c.suit,
      rank: c.rank,
      display: cardToString(c),
    })),
  });

  // Auto-fold sitting-out players when it's their turn
  if (table.isHandInProgress()) {
    const activeIdx = table.activeSeatIndex;
    let shouldAutoAct = false;

    for (const [, session] of playerSessions) {
      if (session.tableId === tableId && session.sittingOut && activeIdx === session.seatIndex) {
        shouldAutoAct = true;
        break;
      }
    }

    // Also auto-act if the active seat belongs to a player whose socket is gone
    // (reserved seat scenario) so a disconnected human doesn't deadlock the table.
    if (!shouldAutoAct && activeIdx >= 0) {
      const seat = table.seats[activeIdx];
      if (seat && seat.state === 'occupied' && !seat.isAI) {
        const hasLiveSession = [...playerSessions.values()].some(
          (s) => s.tableId === tableId && s.seatIndex === activeIdx
        );
        if (!hasLiveSession) shouldAutoAct = true;
      }
    }

    if (shouldAutoAct) {
      setTimeout(() => {
        const t = tableManager.getTable(tableId);
        if (t && t.activeSeatIndex === activeIdx && t.isHandInProgress()) {
          const callAmt = t.currentBetToMatch - (t.seats[activeIdx]?.currentBet || 0);
          if (callAmt <= 0) {
            t.playerCheck(activeIdx);
          } else {
            t.playerFold(activeIdx);
          }
          broadcastGameState(tableId);
        }
      }, 500);
    }
  }

  // Server-side turn timeout: only reset the turn clock when the active
  // seat actually CHANGES from the prior one we remembered. We track the
  // seat-for-turnStartedAt separately from the turnTimers entry because
  // the timer entry gets deleted when the timeout callback fires — using
  // that as the "prior seat" source caused a bug where after the timer
  // expired (or was cleared silently), the next broadcast saw no entry
  // and treated it as a fresh turn, resetting the countdown to 30s on
  // the same seat. User observed: "his turn doesn't pause no more, the
  // turn timer just starts over when complete" (2026-04-22).
  {
    const existing = turnTimers.get(tableId);
    const activeSeat = table.activeSeatIndex;
    const priorSeatForStart = turnStartedSeatMap.get(tableId);
    // 2026-06-11 audit R11: a NEW HAND counts as a turn change even when its
    // first actor is the same seat that acted last in the prior hand — without
    // this the timer never armed for that opening turn and an idle player
    // stalled the table.
    const handChanged = turnStartedHandMap.get(tableId) !== table.handNumber;
    const seatChanged = priorSeatForStart !== activeSeat || handChanged;

    if (seatChanged) {
      if (existing) clearTimeout(existing.timeout);
      turnTimers.delete(tableId);
      // Cancel any in-flight warning timer for the prior seat — a stale
      // 'turn_warning' for the old seat would mislead the player.
      const existingWarn = turnWarningTimers.get(tableId);
      if (existingWarn) clearTimeout(existingWarn.timeout);
      turnWarningTimers.delete(tableId);
    }

    if (table.isHandInProgress() && activeSeat >= 0 && seatChanged) {
      const turnId = ++globalTurnId;
      turnStartedAtMap.set(tableId, Date.now());
      turnStartedSeatMap.set(tableId, activeSeat);
      turnStartedHandMap.set(tableId, table.handNumber); // R11: remember the hand we armed for
      const timeout = setTimeout(() => {
        const entry = turnTimers.get(tableId);
        if (!entry || entry.turnId !== turnId) return; // stale timer
        turnTimers.delete(tableId);
        const t = tableManager.getTable(tableId);
        if (!t || !t.isHandInProgress() || t.activeSeatIndex !== activeSeat) return;
        const seat = t.seats[activeSeat];
        if (!seat || !seat.playerName || seat.folded) return;
        const callAmt = t.currentBetToMatch - (seat.currentBet || 0);
        // 2026-05-12 audit: throttled to debug, was console.log
        log.debug(`[Timer] Seat ${activeSeat} (${seat.playerName}) timed out — ${callAmt > 0 ? 'folding' : 'checking'}`);
        if (callAmt > 0) {
          t.playerFold(activeSeat);
        } else {
          t.playerCheck(activeSeat);
        }
        broadcastGameState(tableId);
      }, TURN_TIMEOUT_MS);
      turnTimers.set(tableId, { timeout, seatIndex: activeSeat, turnId });

      // === Push notification: your_turn ===
      // Fire-and-forget on every real seat transition, for human players
      // only. We use lastActiveSeatByTable (separate from turnTimers) as
      // the prior-seat reference — per the 551c785 -> 9128699 regression
      // note, using a turnTimers entry would be unsafe because the entry
      // is deleted by the async timeout callback.
      try {
        const priorPushSeat = lastActiveSeatByTable.get(tableId);
        if (priorPushSeat !== activeSeat) {
          lastActiveSeatByTable.set(tableId, activeSeat);
          const seat = table.seats[activeSeat];
          if (seat && !seat.isAI && !seat.folded && seat.playerName) {
            const userId = userIdForSeat(tableId, activeSeat);
            if (userId) {
              void notifyPlayer(
                userId,
                'your_turn',
                "It's your turn!",
                'Tap to make your move.',
                { priority: 'high', metadata: { gameId: tableId, seatNumber: activeSeat } }
              );
            }
          }
        }

        // === Push notification: turn_warning ===
        // Sibling timer: fires ~10s before the action clock expires.
        // Stale-check via turnId (rolls each new turn) so a clock that
        // already advanced doesn't surface a misleading warning.
        const warnDelay = TURN_TIMEOUT_MS - TURN_WARNING_LEAD_MS;
        if (warnDelay > 0) {
          const warnTimeout = setTimeout(() => {
            const entry = turnWarningTimers.get(tableId);
            if (!entry || entry.turnId !== turnId) return; // stale
            turnWarningTimers.delete(tableId);
            const t = tableManager.getTable(tableId);
            if (!t || !t.isHandInProgress() || t.activeSeatIndex !== activeSeat) return;
            const seatNow = t.seats[activeSeat];
            if (!seatNow || seatNow.isAI || seatNow.folded || !seatNow.playerName) return;
            const uid = userIdForSeat(tableId, activeSeat);
            if (!uid) return;
            void notifyPlayer(
              uid,
              'turn_warning',
              'Time running out!',
              'Your action clock is about to expire.',
              { priority: 'urgent', metadata: { gameId: tableId, seatNumber: activeSeat } }
            );
          }, warnDelay);
          turnWarningTimers.set(tableId, { timeout: warnTimeout, turnId });
        }
      } catch (err) {
        console.warn('[notifyPlayer your_turn/turn_warning] hook failed:', (err as Error)?.message);
      }
    }
  }

  // Hand-state checkpoint: snapshot to Redis so a Railway restart can
  // rehydrate this exact table state. Only persist while a hand is
  // actually in progress — no point serializing WaitingForPlayers or
  // HandComplete states (they reset on startup anyway). On hand
  // completion, proactively clear any existing snapshot instead of
  // waiting for 2h TTL expiry.
  try {
    if (isHandStoreReady()) {
      if (table.isHandInProgress()) {
        snapshotHand(tableId, table.serializeSnapshot());
      } else {
        clearHandSnapshot(tableId).catch(() => {});
      }
    }
  } catch (err) {
    // Never let persistence failure break the broadcast.
    console.warn('[snapshot] failed:', (err as Error)?.message);
  }

  // Send spectator-specific state (no hole cards unless showdown)
  const tableSpectators = spectators.get(tableId);
  if (tableSpectators && tableSpectators.size > 0) {
    const spectatorState = getGameStateForPlayer(table, -1, false);
    (spectatorState as any).isSpectator = true;
    (spectatorState as any).spectatorCount = tableSpectators.size;
    for (const specId of tableSpectators) {
      const specSocket = io.sockets.sockets.get(specId);
      if (specSocket) {
        emitGameState(specSocket, spectatorState);
      }
    }
  }
}

// Track which tables already have handResult listeners
const tableProgressListeners = new Set<string>();

// Rolling buffer of revealed deck commitments per table, newest-first.
// Capped so memory stays bounded on long-lived tables. Used by the
// /api/fairness/* endpoints so players can verify the shuffle after a hand.
interface RevealedCommitment {
  handNumber: number;
  seed: string;
  hash: string;
  revealedAt: number;
}
const revealedCommitmentsByTable = new Map<string, RevealedCommitment[]>();
const FAIRNESS_BUFFER_SIZE = 50;

function recordRevealedCommitment(tableId: string, rc: RevealedCommitment) {
  let buf = revealedCommitmentsByTable.get(tableId);
  if (!buf) { buf = []; revealedCommitmentsByTable.set(tableId, buf); }
  buf.unshift(rc);
  if (buf.length > FAIRNESS_BUFFER_SIZE) buf.length = FAIRNESS_BUFFER_SIZE;
  // Mirror to Redis so the rolling buffer survives Railway restarts.
  // Fire-and-forget — the in-process Map is the authoritative read source
  // for /api/fairness/* during this process's lifetime; Redis only matters
  // after a restart. If Redis is unavailable the helper logs once and
  // no-ops, so this never blocks gameplay.
  appendFairnessCommitment(tableId, rc).catch((err) => {
    console.warn(`[Fairness] persist failed for table=${tableId} hand=${rc.handNumber}:`, (err as Error)?.message);
  });
}

// Build the authoritative prediction-market facts from the final hand state,
// resolve all open bets/picks for the hand, and push results to each affected
// user's sockets. Called from the handResult listener (3c). The facts are
// derived ONLY from server state — the client cannot influence the outcome.
async function settlePredictionsForHand(
  table: PokerTable,
  tableId: string,
  data: { results: any[]; handNumber: number }
): Promise<void> {
  const community: any[] = (table as any).communityCards || [];
  const flopRanks = community.slice(0, 3).map((c) => c?.rank);
  const potAwarded = (data.results || []).reduce((s: number, r: any) => s + (r?.amount || 0), 0);
  const showdownHands = (table as any).lastHandResult?.showdownHands || [];
  const facts: PredictionFacts = {
    showdown: showdownHands.length >= 2,
    flopPaired: flopRanks.length === 3 && new Set(flopRanks).size < 3,
    allIn: (table.seats || []).some((s: any) => s?.allIn),
    bigPot: potAwarded > 5000,
    riverSeen: community.length === 5,
    foldPreflop: community.length === 0,
  };
  const winnerSeats: number[] = ((table as any).lastHandResult?.winners || []).map((w: any) => w.seatIndex);

  const settled = await settlePredictions(tableId, data.handNumber, facts, winnerSeats);
  if (settled.bets.size === 0 && settled.picks.size === 0) return;

  // Reverse-map userId -> live socket ids (a user may have multiple tabs).
  const sidsFor = (uid: number): string[] => {
    const out: string[] = [];
    for (const [sid, a] of authSessions) if (a?.userId === uid) out.push(sid);
    return out;
  };
  for (const [uid, items] of settled.bets) {
    const balance = settled.wallets.get(uid);
    for (const sid of sidsFor(uid)) {
      io.to(sid).emit('predictionSettled', { handNumber: data.handNumber, balance, results: items });
    }
  }
  for (const [uid, p] of settled.picks) {
    for (const sid of sidsFor(uid)) {
      io.to(sid).emit('spectatorResult', { handNumber: data.handNumber, ...p });
    }
  }
}

function ensureTableProgressListener(table: PokerTable, tableId: string): void {
  if (tableProgressListeners.has(tableId)) return;
  tableProgressListeners.add(tableId);

  table.on('handResult', async (data: { results: any[]; handNumber: number }) => {
    incrementHandsPlayed();
    handleHandComplete(tableId, data.results);
    // Prediction games (3c): settle open market bets + spectator picks for
    // this hand from the AUTHORITATIVE final table state, then push results.
    // Runs before processPendingSeatRemovals so seat.allIn flags are still set.
    settlePredictionsForHand(table, tableId, data).catch((e) =>
      console.warn('[prediction] settle failed', e?.message)
    );
    // 2026-06-11 audit C7: the pot has now been awarded (determineWinners
    // ran before this event), so any seat we kept alive only to preserve
    // its committed chips in the pot can be torn down: credit the remaining
    // stack to the wallet + standUp.
    processPendingSeatRemovals(tableId);

    // Chip velocity monitoring
    for (const result of data.results) {
      if (!result.playerId || result.isAI) continue;
      const session = [...playerSessions.values()].find((s) => s.tableId === tableId && s.playerId === result.playerId);
      if (!session) continue;
      const auth = authSessions.get(session.socketId);
      if (!auth) continue;
      const userId = auth.userId;
      if (!chipVelocity.has(userId)) {
        chipVelocity.set(userId, {
          chipsAtStart: await getUserChips(userId),
          sessionStartAt: Date.now(),
          handsThisSession: 0,
          lastActionMs: [],
        });
      }
      const vel = chipVelocity.get(userId)!;
      vel.handsThisSession++;
      if (result.chipsWon && result.chipsWon > 0) {
        const currentChips = await getUserChips(userId);
        const gained = currentChips - vel.chipsAtStart;
        const sessionMinutes = (Date.now() - vel.sessionStartAt) / 60_000;
        if (vel.handsThisSession >= 5 && gained > vel.chipsAtStart * 10) {
          console.warn(`[AntiCheat] Chip velocity alert: userId=${userId} gained ${gained} chips (${vel.handsThisSession} hands, ${sessionMinutes.toFixed(1)}m)`);
          // Track alert count with decay; auto-ban after 3 alerts inside
          // the decay window (24h). Previously this was a permanent count
          // that could survive months of quiet play and then trip a ban
          // on a single new alert.
          const alertCount = incrementChipVelocityAlert(userId);
          if (alertCount >= 3) {
            console.warn(`[AntiCheat] Auto-banning userId=${userId} after ${alertCount} chip velocity alerts`);
            try {
              banUserDB(userId);
              auditLog('SYSTEM', 'AUTO_BAN_CHIP_VELOCITY', { userId, gained, handsThisSession: vel.handsThisSession });
            } catch (e) {
              console.error('[AntiCheat] Auto-ban failed:', e);
            }
            chipVelocityAlerts.delete(userId);
          }
        }
      }
    }
  });

  // Capture revealed deck seeds into the fairness buffer so /api/fairness/*
  // can serve them back to clients for provably-fair verification.
  table.on('deckSeedRevealed', (c: { seed: string; hash: string; handNumber: number }) => {
    recordRevealedCommitment(tableId, { ...c, revealedAt: Date.now() });
  });

  // Pre-hand commitment: clients receive the SHA-256 hash BEFORE the hand
  // starts so they can later verify it matches the seed revealed at hand
  // completion. Without this emit the fairness contract is broken — players
  // would only ever see the post-hand seed with nothing to compare it to.
  table.on('deckCommitment', (c: { hash: string; handNumber: number }) => {
    io.to(`table:${tableId}`).emit('deckCommitment', { ...c, committedAt: Date.now() });
  });

  // Emit hand history to all human players at the table (Part 3)
  table.on('handHistory', (history: HandHistoryRecord) => {
    const serializeCard = (c: Card) => ({
      suit: c.suit,
      rank: c.rank,
      display: cardToString(c),
    });

    const serializedHistory = {
      ...history,
      communityCards: history.communityCards.map(serializeCard),
      players: history.players.map((p) => ({
        ...p,
        holeCards: p.holeCards ? p.holeCards.map(serializeCard) : null,
      })),
    };

    for (const [socketId, session] of playerSessions) {
      if (session.tableId === tableId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('handHistory', serializedHistory);
        }
        // Persist the FULL serialized replay record to DB per-user so
        // the Last Hand viewer still works across logins. Previously
        // handleHandComplete wrote a minimal snapshot here (just chips +
        // holeCards + community), which the replay viewer couldn't use
        // — opening Last Hand after login threw inside buildReplaySteps
        // because history.players was undefined.
        const auth = authSessions.get(socketId);
        if (auth) {
          const handId = `${tableId}-${serializedHistory.handNumber}-${session.seatIndex}-${Date.now()}`;
          recordHand(auth.userId, handId, serializedHistory).catch(() => {});
        }
      }
    }
  });
}

// Target occupancy for cash tables. Keeps the game alive without hogging
// every seat — humans walking into the lobby always see open seats at
// every table. 5 = roughly half a 9-max, feels like a "busy" cash game.
const CASH_TABLE_TARGET_OCCUPIED = 5;

// 2026-06-11: AI seats may only be added or removed BETWEEN hands. Mutating the
// roster mid-hand (trimming a folded bot, or a join/leave event firing a refill
// during a live hand) makes opponents appear to vanish / "change seats" while a
// hand is in progress. The seat GEOMETRY is stable — confirmed by instrumenting
// the live client (zero mid-hand seat-position moves over 300+ samples); the
// churn was the only cause. Every AI seat add/remove path funnels through this
// guard so the on-table roster is frozen from the deal through HandComplete.
// autoStartNextHand only runs at HandComplete, so the between-hands top-up to
// target (CASH_TABLE_TARGET_OCCUPIED) still fires normally.
function aiSeatsMutableNow(table: PokerTable): boolean {
  return (
    table.currentPhase === GamePhase.WaitingForPlayers ||
    table.currentPhase === GamePhase.HandComplete
  );
}

function fillWithAI(
  table: PokerTable,
  tableId: string,
  difficulty: Difficulty = 'hard',
  targetMaxOccupied: number = CASH_TABLE_TARGET_OCCUPIED
): void {
  // No mid-hand roster changes — defer fills to the between-hands window.
  if (!aiSeatsMutableNow(table)) return;
  if (!aiProfiles.has(tableId)) {
    aiProfiles.set(tableId, new Map());
  }
  const profiles = aiProfiles.get(tableId)!;

  // Find empty seats and fill with AI
  const usedNames = new Set<string>();
  for (const seat of table.seats) {
    if (seat.state === 'occupied') {
      usedNames.add(seat.playerName);
    }
  }

  const emptySeats: number[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    if (table.seats[i].state === 'empty') {
      emptySeats.push(i);
    }
  }

  // Target-based fill: only add bots up to the cap, so humans always have
  // open seats and the table never shows "Full" (9/9) to walk-ups.
  const currentOccupied = table.getOccupiedSeatCount();
  const needed = Math.max(0, targetMaxOccupied - currentOccupied);
  // And always leave at least 1 seat open regardless of cap.
  const seatsToFill = emptySeats
    .slice(0, Math.min(needed, Math.max(0, emptySeats.length - 1)));

  for (const i of seatsToFill) {
    let profile = generateRandomProfile(difficulty);

    // Ensure unique bot name
    let attempts = 0;
    while (usedNames.has(profile.botName) && attempts < 50) {
      profile = generateRandomProfile(difficulty);
      attempts++;
    }
    usedNames.add(profile.botName);

    const aiPlayerId = `ai-${uuidv4()}`;
    table.sitDown(i, profile.botName, table.config.minBuyIn, aiPlayerId, true);
    profiles.set(i, profile);
  }
}

// Trim excess AI when a table is over the occupancy cap.
// BETWEEN HANDS ONLY — never mid-hand. Removing a bot during a live hand (even
// a folded one) makes opponents appear to vanish / change seats, which is the
// "players changing seats mid-hand" report. Deferred to the HandComplete window
// (autoStartNextHand + the heartbeat both trim there). Never touches humans.
function trimExcessAI(
  table: PokerTable,
  tableId: string,
  targetMaxOccupied: number = CASH_TABLE_TARGET_OCCUPIED
): void {
  // No mid-hand roster changes — defer trims to the between-hands window.
  if (!aiSeatsMutableNow(table)) return;
  const occupied = table.getOccupiedSeatCount();
  if (occupied <= targetMaxOccupied) return;
  const aiSeats: number[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    const s = table.seats[i];
    if (s.state !== 'occupied' || !s.isAI) continue;
    aiSeats.push(i);
  }
  const toRemove = Math.min(occupied - targetMaxOccupied, aiSeats.length);
  if (toRemove <= 0) return;
  const profiles = aiProfiles.get(tableId);
  for (let k = 0; k < toRemove; k++) {
    const i = aiSeats[k];
    table.standUp(i);
    if (profiles) profiles.delete(i);
  }
  // 2026-05-12 audit: throttled to debug, was console.log
  log.debug(`[LiveRoom] trimExcessAI ${tableId}: removed ${toRemove} AI seats (was ${occupied}, cap ${targetMaxOccupied}, phase ${table.currentPhase})`);
}

function scheduleAIAction(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (!table) { console.log('[AI] No table found'); return; }

  if (
    table.currentPhase === GamePhase.WaitingForPlayers ||
    table.currentPhase === GamePhase.HandComplete ||
    table.currentPhase === GamePhase.Showdown
  ) {
    // console.log(`[AI] Phase ${table.currentPhase}, skipping`);
    return;
  }

  // For draw phases, AI should auto-draw (stand pat or discard)
  if (DrawPhases.includes(table.currentPhase) && table instanceof FiveCardDrawTable) {
    const drawTable = table as FiveCardDrawTable;
    // Schedule AI draws for all AI players who haven't drawn yet
    const profiles = aiProfiles.get(tableId);
    if (profiles) {
      for (const seat of drawTable.seats) {
        if (seat.isAI && seat.state === 'occupied' && !seat.folded && !seat.allIn && !seat.eliminated) {
          if (!drawTable.drawsCompleted.has(seat.seatIndex)) {
            const delay = 500 + Math.floor(Math.random() * 1000);
            setTimeout(() => {
              // 2026-06-19 fix: discard the WORST cards deterministically (keep
              // pairs/trips/quads, else keep the two highest), capped at 3.
              // Previously this discarded a RANDOM count of the FIRST cards, so
              // the bot's post-draw hand had nothing to do with its betting.
              const cards = seat.holeCards;
              const byRank = new Map<number, number[]>();
              cards.forEach((c: any, i: number) => { const a = byRank.get(c.rank) || []; a.push(i); byRank.set(c.rank, a); });
              const keep = new Set<number>();
              for (const idxs of byRank.values()) if (idxs.length >= 2) idxs.forEach((i) => keep.add(i));
              if (keep.size === 0) {
                // No made pair — keep the two highest cards, draw the other three.
                [...cards.keys()].sort((a, b) => cards[b].rank - cards[a].rank).slice(0, 2).forEach((i) => keep.add(i));
              }
              const indices: number[] = [...cards.keys()].filter((i) => !keep.has(i)).slice(0, 3);
              drawTable.playerDraw(seat.seatIndex, indices);
              broadcastGameState(tableId);
              // After all draws, the table will advance and we need to schedule next AI action
              if (drawTable.currentPhase !== GamePhase.Draw1 && drawTable.currentPhase !== GamePhase.Draw2 && drawTable.currentPhase !== GamePhase.Draw3) {
                scheduleAIAction(tableId);
              }
            }, delay);
          }
        }
      }
    }

    // 2026-06-11 audit R10: arm a draw-phase clock for HUMAN players (the AI
    // loop above auto-draws bots). One per (hand, phase) so the many
    // scheduleAIAction re-entries don't stack timers; on fire, stand-pat
    // (draw 0) any non-AI player who hasn't drawn so the phase completes
    // instead of hanging forever on an unresponsive human.
    const armedHand = drawTable.handNumber;
    const dphase = drawTable.currentPhase;
    const existingDraw = drawTimers.get(tableId);
    const sameDraw = !!existingDraw && existingDraw.handNumber === armedHand && existingDraw.phase === dphase;
    if (!sameDraw) {
      if (existingDraw) clearTimeout(existingDraw.timeout);
      const drawTimeout = setTimeout(() => {
        const t = tableManager.getTable(tableId);
        if (!(t instanceof FiveCardDrawTable)) return;
        if (t.handNumber !== armedHand || t.currentPhase !== dphase) return; // stale: phase/hand moved on
        let forced = false;
        for (const s of t.seats) {
          if (!s.isAI && s.state === 'occupied' && !s.folded && !s.allIn && !s.eliminated && !t.drawsCompleted.has(s.seatIndex)) {
            t.playerDraw(s.seatIndex, []); // stand pat — timed out
            forced = true;
          }
        }
        if (forced) broadcastGameState(tableId);
        scheduleAIAction(tableId);
      }, TURN_TIMEOUT_MS);
      drawTimers.set(tableId, { timeout: drawTimeout, handNumber: armedHand, phase: dphase });
    }
    return;
  }

  const activeSeat = table.activeSeatIndex;
  if (activeSeat < 0 || activeSeat >= MAX_SEATS) { return; }

  const seat = table.seats[activeSeat];
  // console.log(`[AI] Active seat ${activeSeat}: ${seat.playerName}, isAI=${seat.isAI}, state=${seat.state}`);
  if (!seat.isAI) { return; }

  const profiles = aiProfiles.get(tableId);
  if (!profiles) { console.log('[AI] No profiles found'); return; }

  let profile = profiles.get(activeSeat);
  if (!profile) {
    // AI seat with no profile = silent dead-lock. Log + attempt recovery:
    // synthesize a default medium profile so the turn still progresses
    // instead of waiting 20s for the wedge watchdog. Root cause is
    // elsewhere (profile deleted mid-hand? AI re-seated without
    // re-profile?) but this keeps play flowing.
    const seat = table.seats[activeSeat];
    if (seat?.isAI) {
      console.warn(`[AI] Missing profile for seat ${activeSeat} (${seat.playerName}) on ${tableId} — synthesizing default`);
      profile = {
        botName: seat.playerName || `AI${activeSeat}`,
        difficulty: 'medium',
        personality: 'tight',
        archetype: 'TAG',
        vpip: 22,
        pfr: 17,
        aggressionFactor: 2.5,
        bluffFrequency: 0.15,
      } as AIPlayerProfile;
      profiles.set(activeSeat, profile);
    } else {
      return;
    }
  }

  // CRITICAL: don't reschedule if there's already a pending action for the
  // same seat. Otherwise repeated broadcastGameState → scheduleAIAction calls
  // will keep cancelling and re-arming the timer, so it never actually fires
  // and the table wedges until the 30s turn timer takes over.
  const timeoutKey = `${tableId}`;
  const existing = aiTimeouts.get(timeoutKey);
  if (existing && existing.seatIndex === activeSeat) {
    return; // already scheduled for this seat — let it fire
  }
  if (existing) {
    clearTimeout(existing.handle);
  }

  const isFastMode = fastModeTables.get(tableId) || false;
  // Trust getThinkingDelay's per-difficulty range for natural variance —
  // different bots act at different times so the table doesn't feel
  // robotic. Only a hard MAX cap (2500ms) is applied, well below the 30s
  // turn clock, so no bot can ever burn the full timer even on a bad RNG
  // draw. Removing the old [100, 300] squeeze 2026-04-22 per audit
  // feedback — that clamp made every bot act at ~identical 200ms which
  // felt mechanical.
  const naturalDelay = getThinkingDelay(profile.difficulty);
  const delay = isFastMode ? 120 : Math.min(2500, naturalDelay);
  // console.log(`[AI] Scheduling ${seat.playerName} (seat ${activeSeat}) in ${delay}ms${isFastMode ? ' (fast mode)' : ''}`);

  const handle = setTimeout(() => {
    aiTimeouts.delete(timeoutKey);
    // console.log(`[AI] Executing action for seat ${activeSeat}`);
    executeAIAction(tableId, activeSeat, profile);
  }, delay);

  aiTimeouts.set(timeoutKey, { handle, seatIndex: activeSeat });
}

function executeAIAction(
  tableId: string,
  seatIndex: number,
  profile: AIPlayerProfile
): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;

  // Verify it's still this AI's turn
  if (table.activeSeatIndex !== seatIndex) return;
  if (!table.seats[seatIndex].isAI) return;

  const decision = decideAction(table, seatIndex, profile);

  let success = false;
  switch (decision.action) {
    case PlayerAction.Fold:
      success = table.playerFold(seatIndex);
      break;
    case PlayerAction.Check:
      success = table.playerCheck(seatIndex);
      // If check fails, try fold
      if (!success) {
        success = table.playerFold(seatIndex);
      }
      break;
    case PlayerAction.Call:
      success = table.playerCall(seatIndex);
      if (!success) {
        success = table.playerCheck(seatIndex);
        if (!success) {
          success = table.playerFold(seatIndex);
        }
      }
      break;
    case PlayerAction.Raise:
      success = table.playerRaise(seatIndex, decision.raiseAmount);
      if (!success) {
        // Try calling instead
        success = table.playerCall(seatIndex);
        if (!success) {
          success = table.playerCheck(seatIndex);
          if (!success) {
            success = table.playerFold(seatIndex);
          }
        }
      }
      break;
    case PlayerAction.AllIn:
      success = table.playerAllIn(seatIndex);
      if (!success) {
        success = table.playerFold(seatIndex);
      }
      break;
    default:
      success = table.playerFold(seatIndex);
  }

  if (success) {
    broadcastGameState(tableId);

    // Check if hand is complete
    if (table.currentPhase === GamePhase.HandComplete) {
      // Completed hands don't need the Redis snapshot anymore — clear
      // so a restart doesn't try to rehydrate a finished hand.
      clearHandSnapshot(tableId).catch(() => {});
      // Cancel any previously scheduled auto-start for this table (defensive)
      const existing = pendingAutoStartTimers.get(tableId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        pendingAutoStartTimers.delete(tableId);
        autoStartNextHand(tableId);
      }, 1500);
      pendingAutoStartTimers.set(tableId, t);
    } else {
      // Schedule next AI action if needed
      scheduleAIAction(tableId);
    }
  } else {
    // All action attempts failed (active seat is somehow already folded/eliminated/invalid).
    // Force-advance the turn so the table doesn't wedge in an infinite reschedule loop.
    console.warn(`[AI] All action attempts failed for seat ${seatIndex} on ${tableId} — forcing turn advance`);
    try {
      (table as any).advanceTurn();
    } catch (e) {
      console.error('[AI] Forced advanceTurn failed:', e);
    }
    broadcastGameState(tableId);
    scheduleAIAction(tableId);
  }
}

// Atomically move a session's seat at a cash table. Transfers chip stack,
// avatar, all seat-level state from the old seat to the new seat; evicts
// an AI occupant if the target is held by a bot; clears sit-out state.
// Returns true on success, false if the target turned out invalid (e.g.
// a human took it between queue and execute — the player stays put).
//
// IMPORTANT: caller is expected to have already verified the table is
// between hands (or about to start one). Mid-hand moves would interrupt
// an active betting round.
function executePendingMove(tableId: string, session: PlayerSession): boolean {
  const target = session.pendingSeatIndex;
  if (target == null) return false;
  delete session.pendingSeatIndex;

  const table = tableManager.getTable(tableId);
  if (!table) return false;

  const src = table.seats[session.seatIndex];
  const dst = table.seats[target];
  if (!src || !dst) return false;

  // Re-check: target must still be empty or AI. A human may have joined
  // this seat between queue and execute.
  if (dst.state === 'occupied' && !dst.isAI) {
    const sock = io.sockets.sockets.get(session.socketId);
    if (sock) sock.emit('error', { message: 'Target seat was taken — move cancelled' });
    return false;
  }

  // Evict an AI from the target if any.
  if (dst.state === 'occupied' && dst.isAI) {
    table.standUp(target);
    const profiles = aiProfiles.get(tableId);
    if (profiles) profiles.delete(target);
  }

  // Snapshot the player's current seat data then wipe the source seat.
  const chipCount = src.chipCount;
  const avatar = session.avatar;
  const playerName = session.playerName;
  const playerId = session.playerId;
  table.standUp(session.seatIndex);

  // Sit down at the new seat with the preserved stack. `sitDown`'s buy-in
  // argument becomes the new chip count, so we pass the EXACT snapshot to
  // preserve every chip.
  const success = table.sitDown(target, playerName, chipCount, playerId, false);
  if (!success) {
    // Extremely rare — sitDown shouldn't fail on an empty seat — but fall
    // back by attempting to return to the original seat with the same stack.
    console.warn(`[MoveSeat] sitDown failed for ${playerName} on seat ${target}; restoring to ${session.seatIndex}`);
    table.sitDown(session.seatIndex, playerName, chipCount, playerId, false);
    return false;
  }

  // Carry avatar forward on the new seat.
  if (avatar && table.seats[target]) {
    (table.seats[target] as any).avatar = avatar;
  }

  // Update the session to reflect the new seat + clear sit-out.
  session.seatIndex = target;
  session.sittingOut = false;
  const tracker = sitOutTracker.get(tableId);
  if (tracker) {
    tracker.delete(target);
    // Clean up any lingering old-seat entry too.
  }

  // Notify the socket that their move completed.
  const sock = io.sockets.sockets.get(session.socketId);
  if (sock) {
    sock.emit('moveSeatComplete', { tableId, newSeat: target });
  }
  // 2026-05-12 audit: throttled to debug, was console.log
  log.debug(`[MoveSeat] ${playerName} moved to seat ${target} on ${tableId} (${chipCount} chips)`);
  return true;
}

function autoStartNextHand(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;

  if (table.currentPhase !== GamePhase.HandComplete) return;

  // Reload BUSTED-OUT seats only — humans AND AI — so cash tables never
  // empty out. Previously AI at 0 chips were removed from the table, which
  // drained it to heads-up over time. Now bots stay and get a fresh stack,
  // same as humans. BUT reload only triggers at chipCount === 0 (truly
  // busted), not just "below min buy-in" — that was giving free top-ups
  // every hand to anyone short-stacked, which is not how poker works.
  // A short stack is a real state; the player needs to play out of it
  // or leave. Only a full bust gets the safety-net reload.
  for (let i = 0; i < MAX_SEATS; i++) {
    const seat = table.seats[i];
    if (seat.state !== 'occupied') continue;
    if (seat.chipCount <= 0) {
      seat.chipCount = table.config.minBuyIn;
      seat.eliminated = false;
      console.log(`[Reload] ${seat.playerName} (${seat.isAI ? 'AI' : 'human'}) busted → reloaded to ${table.config.minBuyIn}`);
    }
  }

  // Execute any pending seat-move requests BEFORE we trim / refill AI.
  // A player's pendingSeatIndex was queued by the `moveSeat` socket
  // handler; this is the hand boundary where it takes effect. Only cash
  // tables allow these requests (the handler already refuses tournaments).
  if (!tournamentTables.has(tableId)) {
    const movedSockets: string[] = [];
    for (const [sid, session] of playerSessions) {
      if (session.tableId === tableId && session.pendingSeatIndex != null) {
        if (executePendingMove(tableId, session)) movedSockets.push(sid);
      }
    }
    // Also scan multi-table sessions that belong to this table.
    for (const [sid, multi] of multiTableSessions) {
      for (const session of multi) {
        if (session.tableId === tableId && session.pendingSeatIndex != null) {
          if (executePendingMove(tableId, session)) movedSockets.push(sid);
        }
      }
    }
    if (movedSockets.length > 0) {
      console.log(`[MoveSeat] executed ${movedSockets.length} queued moves on ${tableId} at hand boundary`);
    }
  }

  // Cap occupancy at each hand boundary — the 12s heartbeat might miss the
  // HandComplete window if we immediately transition back to PreFlop via the
  // 3s timer. Trim excess AI here too so tables packed by the old behavior
  // drop back to the target within one hand.
  if (!tournamentTables.has(tableId)) {
    trimExcessAI(table, tableId, CASH_TABLE_TARGET_OCCUPIED);
  }

  // Refill AI seats if needed (fill now respects CASH_TABLE_TARGET_OCCUPIED
  // by default, so this is a no-op at or above cap). Skip for tournament
  // tables — they manage their own seating via the rebalance flow.
  const humanCount = table.seats.filter(
    (s) => s.state === 'occupied' && !s.isAI
  ).length;
  if (humanCount > 0 && !tournamentTables.has(tableId)) {
    fillWithAI(table, tableId);
  }

  // Dealer's Choice: rotate variant each orbit
  const dcState = dealersChoiceState.get(tableId);
  if (dcState?.enabled) {
    // Check if dealer has rotated back to start (full orbit)
    if (table.dealerButtonSeat === dcState.dealerAtOrbitStart && table.handNumber > 1) {
      dcState.orbitCount++;
      dcState.currentVariantIndex = (dcState.currentVariantIndex + 1) % DEALERS_CHOICE_VARIANTS.length;
      // Advance the orbit start to the current dealer so the next orbit is measured correctly
      dcState.dealerAtOrbitStart = table.dealerButtonSeat;
    }
  }

  // Tournament table guard: don't start a new hand if table has < 5 alive players
  // and there are multiple tables still in play. Wait for rebalance to fill it.
  const tId = tournamentTables.get(tableId);
  if (tId) {
    const tourn = tournamentManager.getTournament(tId);
    if (tourn && tourn.tableIds.length > 1) {
      const aliveOnTable = tourn.players.filter(
        p => !p.eliminated && tourn.playerTableMap.get(p.playerId) === tableId
      ).length;
      if (aliveOnTable < 5) {
        // Trigger rebalance and don't start hand
        handleTableRebalance(tId);
        return;
      }
    }
  }

  // Start new hand
  const started = table.startNewHand();
  if (started) {
    // Bomb Pot: if pending, activate it for this hand (E6: centralized so
    // every hand-start path honors a pending bomb, not just this one).
    activateBombPotIfPending(tableId, table);

    broadcastGameState(tableId);
    scheduleAIAction(tableId);
  }
}

/**
 * 2026-06-11 audit E6: bomb-pot activation used to be inlined in
 * autoStartNextHand ONLY, so a hand started via any other path (notably the
 * live-room heartbeat's WaitingForPlayers kick-start) ignored a pending bomb
 * pot and it fired a hand late. Centralized here and called after every
 * startNewHand that should honor a pending bomb. Returns true if a bomb pot
 * was activated this hand.
 */
function activateBombPotIfPending(tableId: string, table: PokerTable): boolean {
  if (!bombPotPending.get(tableId)) {
    bombPotActive.delete(tableId);
    return false;
  }
  bombPotPending.delete(tableId);
  bombPotActive.set(tableId, true);

  // All players post 2x big blind as ante
  const bombAnte = table.config.bigBlind * 2;
  for (let i = 0; i < MAX_SEATS; i++) {
    const seat = table.seats[i];
    if (seat.state === 'occupied' && !seat.folded && !seat.eliminated) {
      const deduction = Math.min(bombAnte, seat.chipCount);
      seat.chipCount -= deduction;
      seat.currentBet = deduction;
      seat.totalInvestedThisHand += deduction;
      // 2026-06-11 audit C17: a player whose stack is fully consumed by the
      // bomb ante is all-in for this hand. Without this flag the engine treats
      // them as a live actor with 0 chips and auto-folds them on their turn —
      // folding them OUT of a pot they already paid into. Match every other
      // deduction site, which sets allIn on a 0 stack.
      if (seat.chipCount === 0) seat.allIn = true;
    }
  }

  // Skip preflop: advance directly to flop (hole cards already dealt in startNewHand).
  if (table.communityCards.length === 0) {
    const deck = (table as any).deck;
    deck.dealOne(); // burn card
    for (let c = 0; c < 3; c++) {
      const card = deck.dealOne();
      if (card) table.communityCards.push(card);
    }
    (table as any).currentPhase = GamePhase.Flop;
    // Ante posted — reset currentBet to 0 for the post-flop betting round.
    table.currentBetToMatch = 0;
    for (let i = 0; i < MAX_SEATS; i++) {
      table.seats[i].currentBet = 0;
    }
    // First non-folded player after the dealer acts first post-flop.
    const startIdx = (table.dealerButtonSeat + 1) % MAX_SEATS;
    for (let j = 0; j < MAX_SEATS; j++) {
      const checkSeat = (startIdx + j) % MAX_SEATS;
      const s = table.seats[checkSeat];
      if (s.state === 'occupied' && !s.folded && !s.eliminated && s.chipCount >= 0) {
        table.activeSeatIndex = checkSeat;
        break;
      }
    }
  }
  return true;
}

// ========== Live-Room Heartbeat ==========
//
// Keeps every non-tournament (cash) table running 24/7 so the app behaves
// like a real live poker room:
//   • Any table sitting in WaitingForPlayers with ≥ 2 players seated gets
//     a hand started immediately (no manual "Start Hand" tap required).
//   • Every cash table is kept topped up to a minimum of 3 players — AI
//     backfill so a walk-up human never lands at an empty table and the
//     lobby "players online" counts stay believable.
//   • Tournament tables are skipped entirely — TournamentManager owns their
//     scheduling and rebalancing.

const LIVE_ROOM_MIN_OCCUPIED = 3;

function backfillAIToMin(table: PokerTable, tableId: string, min: number): void {
  // No mid-hand roster changes — defer backfill to the between-hands window.
  if (!aiSeatsMutableNow(table)) return;
  if (!aiProfiles.has(tableId)) aiProfiles.set(tableId, new Map());
  const profiles = aiProfiles.get(tableId)!;
  const usedNames = new Set<string>();
  for (const seat of table.seats) {
    if (seat.state === 'occupied') usedNames.add(seat.playerName);
  }
  const emptySeats: number[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    if (table.seats[i].state === 'empty') emptySeats.push(i);
  }
  const occupied = table.getOccupiedSeatCount();
  const needed = Math.max(0, min - occupied);
  const seatsToFill = emptySeats.slice(0, needed);
  for (const i of seatsToFill) {
    let profile = generateRandomProfile('hard');
    let attempts = 0;
    while (usedNames.has(profile.botName) && attempts < 50) {
      profile = generateRandomProfile('hard');
      attempts++;
    }
    usedNames.add(profile.botName);
    const aiPlayerId = `ai-${uuidv4()}`;
    table.sitDown(i, profile.botName, table.config.minBuyIn, aiPlayerId, true);
    profiles.set(i, profile);
  }
}

function ensureCashTableRunning(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;
  // Skip tournament tables — those run on a different schedule.
  if (tournamentTables.has(tableId)) return;

  // Trim excess AI FIRST so we don't flip-flop: if autoStartNextHand /
  // legacy fillWithAI packed the table to 9/9, drop back to the target
  // between hands.
  trimExcessAI(table, tableId, CASH_TABLE_TARGET_OCCUPIED);

  // Keep a minimum floor of bots so any human walk-up has action immediately.
  if (table.getOccupiedSeatCount() < LIVE_ROOM_MIN_OCCUPIED) {
    backfillAIToMin(table, tableId, LIVE_ROOM_MIN_OCCUPIED);
  }

  // If stuck in WaitingForPlayers with ≥ 2 seated and no pending auto-start
  // already scheduled, kick off a new hand.
  if (
    table.currentPhase === GamePhase.WaitingForPlayers &&
    table.getOccupiedSeatCount() >= 2 &&
    !pendingAutoStartTimers.has(tableId)
  ) {
    const started = table.startNewHand();
    if (started) {
      // E6: honor a pending bomb pot started while the table was idle.
      activateBombPotIfPending(tableId, table);
      broadcastGameState(tableId);
      scheduleAIAction(tableId);
      console.log(`[LiveRoom] Auto-started hand on ${tableId} (occupied=${table.getOccupiedSeatCount()})`);
    }
  }
}

// 12-second heartbeat. Not faster — we don't want to spam seat churn while
// a HandComplete 3s timer is already scheduled. Tournament tables are
// skipped inside ensureCashTableRunning.
console.log('[LiveRoom] heartbeat installed (12s interval, target occupancy ' + CASH_TABLE_TARGET_OCCUPIED + ')');
setInterval(() => {
  try {
    const tables = tableManager.getTableList();
    let trimmedTables = 0;
    for (const t of tables) {
      const before = tableManager.getTable(t.tableId)?.getOccupiedSeatCount() ?? 0;
      ensureCashTableRunning(t.tableId);
      const after = tableManager.getTable(t.tableId)?.getOccupiedSeatCount() ?? 0;
      if (before !== after) trimmedTables++;
    }
    if (trimmedTables > 0) {
      // 2026-05-12 audit: throttled to debug, was console.log
      log.debug(`[LiveRoom] heartbeat: ${trimmedTables} table(s) changed occupancy`);
    }
  } catch (err) {
    console.error('[LiveRoom] heartbeat error:', (err as Error).message);
  }
}, 12000);

// Wedge watchdog — fires every 15s. Detects tables where a hand is
// in progress but hasn't progressed in 45s (activeSeatIndex unchanged,
// no broadcast). Recovery: force-advance the turn or abort the hand.
//
// Why this exists: observed 2026-04-22 that a Beginner's Table froze
// on pre-flop with the client showing one seat as active but that
// seat had already acted according to the log. Turn timer wasn't
// firing (possibly the `activeSeat` snapshot captured a stale index
// at `setTimeout` time, so the `t.activeSeatIndex !== activeSeat`
// bail on line 1150 kicked out silently). This watchdog is a
// belt-and-suspenders safety net — the real fix goes in PokerTable's
// phase-advance logic, but meanwhile this keeps tables playable.
// Tracks both classic wedges (active seat unchanged for 45s) AND
// oscillation wedges (active seat changes but pot/phase don't, meaning
// isBettingRoundComplete() is failing in a loop). Oscillation was
// observed 2026-04-22 during a playtest: the active-seat ring kept
// bouncing between Max (SB) and Knox (BB) for 60+ seconds without pot
// or phase changing. The original stuck-seat check missed it.
const wedgeWatchdog = new Map<string, {
  lastSeat: number;
  seatSince: number;
  lastPot: number;
  lastPhase: string;
  potPhaseSince: number;
}>();
setInterval(() => {
  try {
    const now = Date.now();
    const tables = tableManager.getTableList();
    for (const t of tables) {
      const table = tableManager.getTable(t.tableId);
      if (!table) continue;
      if (!table.isHandInProgress()) {
        wedgeWatchdog.delete(t.tableId);
        continue;
      }
      const activeSeat = table.activeSeatIndex;
      // PokerTable doesn't expose a single `.pot` — sum totalInvestedThisHand
      // + currentBet across seats as a "progress fingerprint". Any change
      // here means real chips moved (bet, call, raise, all-in, or refund).
      const pot = table.seats.reduce(
        (sum, s) => sum + (s.totalInvestedThisHand || 0) + (s.currentBet || 0),
        0,
      );
      const phase = String(table.currentPhase);
      const prior = wedgeWatchdog.get(t.tableId);

      if (!prior) {
        wedgeWatchdog.set(t.tableId, {
          lastSeat: activeSeat, seatSince: now,
          lastPot: pot, lastPhase: phase, potPhaseSince: now,
        });
        continue;
      }

      // Seat tracking — reset timer if seat changed
      if (prior.lastSeat !== activeSeat) {
        prior.lastSeat = activeSeat;
        prior.seatSince = now;
      }
      // Pot/phase tracking — reset timer if either moved (normal progress)
      if (prior.lastPot !== pot || prior.lastPhase !== phase) {
        prior.lastPot = pot;
        prior.lastPhase = phase;
        prior.potPhaseSince = now;
      }

      const seatStuck = now - prior.seatSince;
      const potPhaseStuck = now - prior.potPhaseSince;
      // Tightened 2026-04-22 after user observed repeated check-check loops.
      // Was 45s/60s — halved to 20s/25s so the user-visible stall caps at
      // ~25s instead of 60s. If the root bug keeps re-wedging after recovery
      // we want to recover faster between wedges so play still feels
      // continuous.
      const isWedged = seatStuck >= 20000 || potPhaseStuck >= 25000;

      if (isWedged) {
        const reason = seatStuck >= 20000
          ? `stuck on seat ${activeSeat} for ${seatStuck}ms`
          : `pot+phase unchanged ${potPhaseStuck}ms (oscillating seat ${activeSeat})`;
        console.warn(`[WedgeWatchdog] Table ${t.tableId} ${reason} — forcing advance`);
        try {
          const seat = table.seats[activeSeat];
          // Diagnostic: dump what the stuck state looks like so we can
          // trace the root cause. Logged once per wedge fire.
          const diag = table.seats.slice(0, 9).map((s, i) => {
            if (s.state !== 'occupied') return `${i}:-`;
            return `${i}:${s.folded?'F':''}${s.allIn?'A':''}cb=${s.currentBet || 0}h=${s.hasActedSinceLastFullRaise?'1':'0'}${s.holeCards.length === 0 ? 'nc' : ''}`;
          }).join(' ');
          console.warn(`[WedgeWatchdog] diag phase=${table.currentPhase} b2m=${table.currentBetToMatch} active=${activeSeat} | ${diag}`);

          let forced = false;
          if (seat && seat.state === 'occupied' && !seat.folded && !seat.allIn) {
            const callAmt = table.currentBetToMatch - (seat.currentBet || 0);
            if (callAmt > 0) forced = table.playerFold(activeSeat);
            else forced = table.playerCheck(activeSeat);
            if (!forced) {
              console.warn(`[WedgeWatchdog] playerCheck/Fold returned false for seat ${activeSeat} — advanceTurn fallback`);
              (table as any).advanceTurn?.();
            }
          } else {
            (table as any).advanceTurn?.();
          }
          broadcastGameState(t.tableId);
          scheduleAIAction(t.tableId);
          wedgeWatchdog.delete(t.tableId);
        } catch (err) {
          console.error(`[WedgeWatchdog] recovery failed for ${t.tableId}:`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    console.error('[WedgeWatchdog] tick error:', (err as Error).message);
  }
}, 15000);

// ========== Progression Helpers ==========

/**
 * Hydrate a user's in-memory progress from Postgres and push a
 * playerProgress event to the socket immediately. Safe to call right
 * after login — works even when the user hasn't joined a table yet
 * (no playerSession required). Prevents the "I logged in and I'm level 1"
 * flash that happens before the first ensureHydrated-gated handler runs.
 */
async function hydrateAndPushProgress(socket: Socket, userId: number, username: string): Promise<void> {
  try {
    const playerId = playerSessions.get(socket.id)?.playerId || `user-${userId}`;
    progressionManager.getOrCreateProgress(playerId, username);
    await progressionManager.hydrateFromDB(playerId, userId);
    const clientProgress = progressionManager.getClientProgress(playerId);
    if (clientProgress) socket.emit('playerProgress', clientProgress);
  } catch (err: any) {
    console.warn(`[hydrateAndPushProgress ${userId}]`, err?.message);
  }
}

function sendProgressToPlayer(socketId: string): void {
  const session = playerSessions.get(socketId);
  if (!session) return;

  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return;

  const clientProgress = progressionManager.getClientProgress(session.playerId);
  if (clientProgress) {
    socket.emit('playerProgress', clientProgress);
  }

  // Flush any pending events (levelUp, achievements, missionComplete)
  const events = progressionManager.consumeEvents(session.playerId);
  for (const event of events) {
    socket.emit(event.type, event.data);
  }
}

async function handleHandComplete(tableId: string, results: any[]): Promise<void> {
  const table = tableManager.getTable(tableId);
  if (!table) return;

  // Clear the bomb-pot flag as soon as the hand ends. Previously the flag
  // was cleared only on the NEXT startNewHand (line ~1734) — which left
  // the "BOMB POT!" banner flashing indefinitely whenever the next hand
  // didn't immediately start (empty table, still in showdown, tournament
  // pause, etc.). Clearing here makes the banner disappear the moment the
  // bomb-pot hand resolves, matching user intent.
  if (bombPotActive.get(tableId)) {
    bombPotActive.delete(tableId);
    // Force-broadcast so clients clear their local banner without waiting
    // for the next delta tick.
    broadcastGameState(tableId);
  }

  // Decrement sit-out hand counter for reserved (disconnected) seats on this table
  for (const [userId, reserved] of reservedSeats) {
    if (reserved.tableId === tableId) {
      reserved.handsRemaining--;
      if (reserved.handsRemaining <= 0) {
        // Player ran out of hands — remove them from the table
        const t = tableManager.getTable(reserved.tableId);
        const seatNow = t?.seats?.[reserved.seatIndex];
        // Cash out the at-table stack to the user's wallet before tearing
        // the seat down, so disconnect-timeouts don't destroy chips.
        const chipsToReturn = seatNow?.chipCount ?? reserved.chips ?? 0;
        if (chipsToReturn > 0) {
          addChipsToUser(userId, chipsToReturn).catch((e: any) =>
            console.warn(`[Reserve hand-limit cash-out ${userId}]`, e?.message)
          );
        }
        // Clean the sit-out tracker so the NEXT occupant of this seat
        // doesn't inherit a stale sitting-out flag.
        const tr = sitOutTracker.get(reserved.tableId);
        if (tr) tr.delete(reserved.seatIndex);
        if (t) {
          t.standUp(reserved.seatIndex);
          syncSitOutToTable(reserved.tableId);
          console.log(`[Reserve] ${reserved.playerName} removed after ${DISCONNECT_HANDS_LIMIT} hands of sitting out (returned ${chipsToReturn} chips)`);
        }
        clearTimeout(reserved.cleanupTimer);
        reservedSeats.delete(userId);
      }
    }
  }

  // Collect all human players at the table
  const humanSessions: PlayerSession[] = [];
  for (const [_socketId, session] of playerSessions) {
    if (session.tableId === tableId) {
      humanSessions.push(session);
    }
  }

  // Aggregate total chips won per seat (a player can appear in results multiple times
  // if they won chips from both Main Pot and Side Pots).
  const winnerSeatIndices = new Set(results.map((r: any) => r.seatIndex));
  const totalWonPerSeat = new Map<number, number>();
  const handResultPerSeat = new Map<number, any>();
  for (const r of results) {
    totalWonPerSeat.set(r.seatIndex, (totalWonPerSeat.get(r.seatIndex) || 0) + (r.amount || 0));
    if (!handResultPerSeat.has(r.seatIndex)) handResultPerSeat.set(r.seatIndex, r.handResult);
  }

  for (const session of humanSessions) {
    // Everyone who played gets recordHandPlayed + 5 XP. Pass variantId
    // so lifetime "all_variants" + daily/weekly variety achievements
    // can track it.
    const variantId: string | undefined = (table as any).config?.variantId || (table as any).variantId;
    progressionManager.recordHandPlayed(session.playerId, variantId);
    progressionManager.addXP(session.playerId, 5);

    const seat = table.seats[session.seatIndex];
    const isWinner = winnerSeatIndices.has(session.seatIndex);

    // Determine position category
    const totalOccupied = table.seats.filter((s) => s.state === 'occupied').length;
    const seatPos = session.seatIndex;
    const dealerSeat = table.dealerButtonSeat;
    let relativePos = (seatPos - dealerSeat + totalOccupied) % totalOccupied;
    let posCategory = 'middle';
    if (relativePos <= 1) posCategory = 'blind';
    else if (relativePos <= Math.floor(totalOccupied / 3)) posCategory = 'early';
    else if (relativePos >= totalOccupied - 2) posCategory = 'late';

    if (isWinner) {
      const potSize = totalWonPerSeat.get(session.seatIndex) || 0;
      const handRank = handResultPerSeat.get(session.seatIndex)?.handRank;
      const wasAllIn = seat?.allIn || false;

      progressionManager.recordHandWon(session.playerId, potSize, handRank, wasAllIn);
      progressionManager.recordPositionResult(session.playerId, posCategory, true);

      // Check for royal flush achievement
      if (handRank === HandRank.RoyalFlush) {
        progressionManager.recordRoyalFlush(session.playerId);
      }

      // === Push notification: hand_complete ===
      // Notify the winner with their pot win amount. Fire-and-forget;
      // skip 0-amount results (defensive — winnerSeatIndices is built from
      // results, which can include zero-amount split-pot ties; we only ping
      // when there's actual chips flowing).
      if (potSize > 0) {
        try {
          const auth = authSessions.get(session.socketId);
          const uid = auth?.userId;
          if (uid) {
            void notifyPlayer(
              uid,
              'hand_complete',
              `You won ${potSize.toLocaleString()} chips!`,
              'Tap to see the next hand.',
              {
                priority: 'normal',
                metadata: { gameId: tableId, seatNumber: session.seatIndex },
              }
            );
          }
        } catch (err) {
          console.warn('[notifyPlayer hand_complete] hook failed:', (err as Error)?.message);
        }
      }
    } else {
      progressionManager.recordHandLost(session.playerId);
      progressionManager.recordPositionResult(session.playerId, posCategory, false);
    }

    // Track chip history
    if (seat) {
      progressionManager.recordChipHistory(session.playerId, seat.chipCount);
    }
  }

  // ELO updates: pair each winner against each loser (human vs human only)
  const humanWinnerIds = humanSessions
    .filter((s) => winnerSeatIndices.has(s.seatIndex))
    .map((s) => s.playerId);
  const humanLoserIds = humanSessions
    .filter((s) => !winnerSeatIndices.has(s.seatIndex))
    .map((s) => s.playerId);
  if (humanWinnerIds.length > 0 && humanLoserIds.length > 0) {
    for (const winnerId of humanWinnerIds) {
      for (const loserId of humanLoserIds) {
        progressionManager.updateElo(winnerId, loserId);
      }
    }
  }

  // Send updated progress to all human players at the table
  // and persist key stats (incl. lastHandAt) to DB for leaderboard accuracy
  for (const [socketId, session] of playerSessions) {
    if (session.tableId === tableId) {
      sendProgressToPlayer(socketId);
      const authSession = authSessions.get(socketId);
      if (authSession) {
        const clientProgress = progressionManager.getClientProgress(session.playerId) as any;
        if (clientProgress) {
          // CRITICAL: refuse to write xp/level/achievements until
          // hydrateFromDB has filled the in-memory entry from Postgres.
          // Without this gate, a hand that resolves in <100ms after table
          // join reads fresh-init values (level 1 / xp 0 / achievements [])
          // and clobbers the user's real DB state. Repeated over sessions
          // this caused the "my level keeps resetting" bug.
          if (clientProgress.hydrated) {
            await mergeUserStats(authSession.userId, {
              handsPlayed: clientProgress.totalHandsPlayed || 0,
              handsWon: clientProgress.handsWon || 0,
              biggestPot: clientProgress.biggestPot || 0,
              lastHandAt: Date.now(),
            });

            // 2026-06-19 fix: also persist the COUNTER stats that feed
            // counter-based achievements. mergeUserStats above only covers
            // hands/biggestPot; without these, progress toward bluff/all-in/
            // rare-hand/tournament/variant/streak achievements was held only in
            // memory and reset to the last-saved value on every reconnect
            // (hydrateFromDB reads exactly these keys, ProgressionManager.ts:502-513).
            // saveProgress JSONB-merges, so other stats keys are preserved; the
            // hydrated gate + only-go-up nature means no regression.
            const raw = progressionManager.getProgress(session.playerId) as any;
            const counterStats = raw ? {
              bestStreak: raw.bestStreak,
              bluffWins: raw.bluffWins,
              allInWins: raw.allInWins,
              chatMessagesSent: raw.chatMessagesSent,
              straightFlushHits: raw.straightFlushHits,
              fullHouseHits: raw.fullHouseHits,
              quadsHits: raw.quadsHits,
              royalFlushHits: raw.royalFlushHits,
              tournamentsWon: raw.tournamentsWon,
              tournamentsPlayed: raw.tournamentsPlayed,
              variantsPlayed: raw.variantsPlayed,
            } : undefined;

            await saveProgress(authSession.userId, {
              xp: clientProgress.xp,
              level: clientProgress.level,
              achievements: clientProgress.achievements || [],
              ...(counterStats ? { stats: counterStats } : {}),
            }).catch((e) => console.warn(`[saveProgress hand-complete ${authSession.userId}]`, e?.message));
          } else {
            console.warn(`[hand-complete] SKIPPED save for userId=${authSession.userId} — progress not hydrated yet (would have overwritten real values with fresh-init)`);
          }

          // Hand persistence moved to the table.on('handHistory') listener
          // so the full replay-compatible record is stored (this handler
          // only has access to the minimal result data, which the replay
          // viewer couldn't render).

          const awarded = await tickScratchProgress(authSession.userId).catch(() => false);
          if (awarded) {
            const s = io.sockets.sockets.get(socketId);
            s?.emit('scratchCardEarned', { message: 'You earned a scratch card!' });
          }
        }
      }
    }
  }

  // Tournament elimination tracking: if this table is part of a tournament,
  // record busted players so finish positions and bounty payouts are correct.
  const tournamentId = tournamentTables.get(tableId);
  if (tournamentId) {
    // Identify winners of this hand to credit as bounty eliminators
    const winnerPlayerIds = new Set<string>();
    for (const r of results) {
      if ((r.amount || 0) > 0) {
        const seat = table.seats[r.seatIndex];
        if (seat?.playerId) winnerPlayerIds.add(seat.playerId);
      }
    }
    // 2026-06-11 audit R2: when multiple players bust the SAME hand, finish
    // position — and now the real funded prize payout — must be decided by
    // PRE-HAND stack (the bigger stack outlasted more, so finishes higher),
    // not raw seat-index order. eliminatePlayer assigns worsening positions in
    // call order, so eliminate the SHORTEST pre-hand stack FIRST (worst place).
    const bustedSeatIdx: number[] = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = table.seats[i];
      if (s?.state === 'occupied' && s.chipCount <= 0 && !s.eliminated) bustedSeatIdx.push(i);
    }
    bustedSeatIdx.sort((a, b) => (table.startChips.get(a) || 0) - (table.startChips.get(b) || 0));
    for (const i of bustedSeatIdx) {
      const seat = table.seats[i];
      if (seat?.state === 'occupied' && seat.chipCount <= 0 && !seat.eliminated) {
        seat.eliminated = true;
        const eliminatorId = winnerPlayerIds.values().next().value;
        try {
          const result = tournamentManager.eliminatePlayer(tournamentId, seat.playerId, eliminatorId);
          if (result && result.bountyPayout && eliminatorId) {
            // 2026-06-11 audit R3: actually CREDIT the bounty to the
            // eliminator's tournament stack — previously it was only emitted as
            // a UI event + counter, so the bounty mechanic did nothing. These
            // are tournament chips (wallet-isolated), so it's a play-chip
            // reward, not a wallet mint. The eliminator won the busting pot on
            // THIS table, so their seat is here.
            for (let j = 0; j < MAX_SEATS; j++) {
              const es = table.seats[j];
              if (es?.playerId === eliminatorId && es.state === 'occupied') {
                es.chipCount += result.bountyPayout;
                break;
              }
            }
            // Notify eliminator
            for (const [sid, s] of playerSessions) {
              if (s.playerId === eliminatorId) {
                io.to(sid).emit('bountyAwarded', { amount: result.bountyPayout, eliminated: seat.playerName });
                break;
              }
            }
          }

          // Auto-switch eliminated human players to spectator mode
          if (!seat.isAI && result) {
            const tp = tournamentManager.getTournament(tournamentId)?.players.find(p => p.playerId === seat.playerId);
            if (tp) {
              const sock = io.sockets.sockets.get(tp.socketId);
              if (sock) {
                // Add as spectator on their current table
                const specSet = spectators.get(tableId) || new Set();
                specSet.add(tp.socketId);
                spectators.set(tableId, specSet);

                sock.emit('eliminatedToSpectator', {
                  tournamentId,
                  tableId,
                  position: result.position,
                  totalPlayers: tournamentManager.getTournament(tournamentId)?.players.length || 0,
                  status: tournamentManager.getTournamentStatus(tournamentId),
                  tableIds: tournamentManager.getTournament(tournamentId)?.tableIds || [],
                });
              }
            }
          }
        } catch (e) {
          console.error('[Tournament] eliminatePlayer failed:', e);
        }
      }
    }
  }
}

// ========== Ghost-seat cleanup ==========
/**
 * Stand up any seat on `tableId` currently occupied by `userId` through a
 * different socket than `excludeSocketId` (or any socket, if no exclude).
 * Also clears any reservedSeats entry the user has on this table.
 *
 * This runs before every sitDown attempt so the invariant
 *   "one userId → at most one seat per table"
 * holds regardless of prior disconnects / tab reloads / multi-tab logins.
 * Fixes the "3-of-me" ghost-seat bug.
 */
function clearGhostSeatsForUser(userId: number, tableId: string, excludeSocketId?: string, excludeSeatIndex?: number): number {
  let cleared = 0;
  const table = tableManager.getTable(tableId);
  if (!table) return 0;

  // Resolve the user's display name and phone/username so we can match
  // seats even when no session record remains (e.g. orphaned seats
  // left behind after a crash or a non-joinTable seat path).
  let userDisplayName: string | null = null;
  let userUsername: string | null = null;
  try {
    // Best effort — find via any existing auth session, then via DB if needed.
    for (const [, auth] of authSessions) {
      if (auth.userId === userId) { userUsername = auth.username; break; }
    }
  } catch {}

  // 1. Scan active sessions — any prior socket of the same user on this table
  for (const [otherSocketId, otherSession] of playerSessions) {
    if (otherSocketId === excludeSocketId) continue;
    if (otherSession.tableId !== tableId) continue;
    if (excludeSeatIndex !== undefined && otherSession.seatIndex === excludeSeatIndex) continue;
    const otherAuth = authSessions.get(otherSocketId);
    if (!otherAuth || otherAuth.userId !== userId) continue;

    const seat = table.seats[otherSession.seatIndex];
    if (seat && seat.state === 'occupied' && !seat.isAI) {
      if (table.isHandInProgress() && table.activeSeatIndex === otherSession.seatIndex) {
        try { table.playerFold(otherSession.seatIndex); } catch {}
      }
      // Remember the name for step 3 (in case OTHER dead seats also match)
      userDisplayName = userDisplayName || seat.playerName;
      // C8: return the stack to the wallet before destroying the seat.
      creditSeatStackToWallet(otherAuth.userId, otherAuth.username, tableId, seat, 'ghost_seat_session_scan');
      table.standUp(otherSession.seatIndex);
      cleared++;
    }
    playerSessions.delete(otherSocketId);
    const ghostSocket = io.sockets.sockets.get(otherSocketId);
    if (ghostSocket) {
      ghostSocket.leave(`table:${tableId}`);
      ghostSocket.emit('seatVacated', { tableId, seatIndex: otherSession.seatIndex, reason: 'joined_new_seat' });
    }
  }

  // 2. Clear any reserved seat on this table
  const reserved = reservedSeats.get(userId);
  if (reserved && reserved.tableId === tableId
      && (excludeSeatIndex === undefined || reserved.seatIndex !== excludeSeatIndex)) {
    clearTimeout(reserved.cleanupTimer);
    reservedSeats.delete(userId);
    const rSeat = table.seats[reserved.seatIndex];
    if (rSeat && rSeat.state === 'occupied' && !rSeat.isAI) {
      userDisplayName = userDisplayName || rSeat.playerName;
      // C8: return the reserved seat's stack to the wallet before teardown.
      creditSeatStackToWallet(userId, userUsername || rSeat.playerName || '', tableId, rSeat, 'ghost_seat_reserved');
      table.standUp(reserved.seatIndex);
      cleared++;
    }
  }

  // 3. NAME-based scan — catch seats where the playerName matches our
  // user but NO session/reservation points at them (true orphans from
  // crashes, forced disconnects, or code paths that bypass cleanup).
  // Stronger than the session scan because it doesn't require any
  // lookup map to still hold the stale entry.
  const namesToMatch = new Set<string>();
  if (userDisplayName) namesToMatch.add(userDisplayName);
  if (userUsername) namesToMatch.add(userUsername);
  if (namesToMatch.size > 0) {
    for (let i = 0; i < table.seats.length; i++) {
      if (i === excludeSeatIndex) continue;
      const s = table.seats[i];
      if (s.state !== 'occupied' || s.isAI) continue;
      if (!namesToMatch.has(s.playerName)) continue;
      if (table.isHandInProgress() && table.activeSeatIndex === i) {
        try { table.playerFold(i); } catch {}
      }
      // C8: return the orphaned seat's stack to the wallet before teardown.
      // All name-matched seats belong to this userId (that's the match
      // criterion), so crediting userId is correct.
      creditSeatStackToWallet(userId, userUsername || s.playerName || '', tableId, s, 'ghost_seat_name_scan');
      table.standUp(i);
      cleared++;
    }
  }

  if (cleared > 0) {
    console.log(`[clearGhostSeatsForUser] userId=${userId} tableId=${tableId} cleared=${cleared} (name-match=${userDisplayName || userUsername || 'n/a'})`);
    broadcastGameState(tableId);
  }
  return cleared;
}

// ========== Server-wide stats tracking ==========
let handsPlayedToday = 0;
let handsPlayedTodayDate = new Date().toDateString();
function incrementHandsPlayed(): void {
  const today = new Date().toDateString();
  if (today !== handsPlayedTodayDate) { handsPlayedToday = 0; handsPlayedTodayDate = today; }
  handsPlayedToday++;
}

// ========== Quick-Play & Career Tracking ==========

const quickGameTimers = new Map<string, { blindInterval: NodeJS.Timeout; gameTimeout: NodeJS.Timeout }>();
const spinGoMultipliers = new Map<string, number>();
const allInOrFoldTables = new Set<string>();
const careerTables = new Map<string, { venue: number; stage: number }>();

function cleanupQuickTable(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (table) {
    for (let i = 0; i < MAX_SEATS; i++) {
      if (table.seats[i].state === 'occupied') {
        table.standUp(i);
      }
    }
  }
  aiProfiles.delete(tableId);
  tableManager.removeTable(tableId);
  tableProgressListeners.delete(tableId);

  const timers = quickGameTimers.get(tableId);
  if (timers) {
    clearInterval(timers.blindInterval);
    clearTimeout(timers.gameTimeout);
    quickGameTimers.delete(tableId);
  }

  spinGoMultipliers.delete(tableId);
  allInOrFoldTables.delete(tableId);
  careerTables.delete(tableId);

  const timeoutKey = tableId;
  if (aiTimeouts.has(timeoutKey)) {
    clearTimeout(aiTimeouts.get(timeoutKey)!.handle);
    aiTimeouts.delete(timeoutKey);
  }
}

// ========== Socket.io Events ==========

io.on('connection', (socket: Socket) => {
  // Per-IP connection limit
  const clientIp = socket.handshake.address;
  if (!ipConnections.has(clientIp)) ipConnections.set(clientIp, new Set());
  const ipSockets = ipConnections.get(clientIp)!;
  if (ipSockets.size >= MAX_CONNECTIONS_PER_IP) {
    socket.emit('error', { message: 'Too many connections from your IP' });
    socket.disconnect(true);
    return;
  }
  ipSockets.add(socket.id);

  socket.on('disconnect', async () => {
    ipSockets.delete(socket.id);
    if (ipSockets.size === 0) ipConnections.delete(clientIp);
    // Clean up seated slot tracking
    for (const [ip, slots] of ipSeatedSlots) {
      for (const slot of slots) {
        if (slot.startsWith(socket.id + ':')) slots.delete(slot);
      }
      if (slots.size === 0) ipSeatedSlots.delete(ip);
    }
    // NOTE: actionNonces is keyed by tableId:seatIndex, not socket.id —
    // disconnect cleanup happens via the timestamp sweeper above (10-min TTL).
    actionTimings.delete(socket.id);
    tokenLoginAttempts.delete(socket.id);
    lastEmoteTime.delete(socket.id);
    lastReactionTime.delete(socket.id);
    lastChatTime.delete(socket.id);
    // Spectator cleanup: explicit stopSpectating is the happy path, but a tab
    // close fires only `disconnect`, leaving stale socket ids in the per-table
    // Set and inflating the broadcasted spectatorCount forever.
    for (const [tableId, specs] of spectators) {
      if (specs.delete(socket.id) && specs.size === 0) spectators.delete(tableId);
    }
    lastSentState.delete(socket.id);
  });

  console.log(`Player connected: ${socket.id}`);

  // ========== Auth Events ==========

  socket.on('login', async (data: { phone?: string; username?: string; password: string }) => {
    const phone = data.phone || data.username || '';
    // Phone is PII — log only the last 4 digits so the audit trail is useful
    // for support without exposing the full number in shared log aggregators.
    console.log(`[Auth] Login attempt: phone="****${String(phone).slice(-4)}", hasPassword=${!!data?.password}`);
    const result = await loginUserAsync(phone, data.password);
    console.log(`[Auth] Login result: success=${result.success}, error=${result.error || 'none'}`);
    if (result.success && result.userData) {
      authSessions.set(socket.id, { userId: result.userData.id, username: result.userData.username });
    }
    socket.emit('loginResult', result);
    // Proactively hydrate + push playerProgress so the client never
    // renders the fresh-init level:1 / xp:0 state after a redeploy.
    if (result.success && result.userData) {
      hydrateAndPushProgress(socket, result.userData.id, result.userData.username).catch(() => {});
    }
  });

  socket.on('register', async (data: { username: string; password: string }) => {
    const result = await registerUser(data.username, data.password);
    if (result.success && result.userData) {
      authSessions.set(socket.id, { userId: result.userData.id, username: result.userData.username });
    }
    socket.emit('registerResult', result);
  });

  // Choose display name (after first login with phone)
  socket.on('setDisplayName', async (data: { name: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('setDisplayNameResult', { success: false, error: 'Not authenticated' }); return; }
    const result = await setDisplayName(auth.userId, data.name);
    if (result.success) {
      auth.username = data.name.trim(); // Update session
      socket.emit('setDisplayNameResult', { success: true, displayName: data.name.trim() });
    } else {
      socket.emit('setDisplayNameResult', result);
    }
  });

  // Qualifier status: the logged-in player checks if they're qualified.
  // 2026-06-12 — match on the AUTHENTICATED session's userId (master user id),
  // not a client-supplied phone. The socket's auth session (set at login)
  // already holds the trusted userId; the old client-phone match was brittle
  // (formatting) and spoofable. Any payload the client sends is ignored.
  socket.on('getQualifications', async () => {
    const auth = authSessions.get(socket.id);
    // 2026-06-12 — match on the MASTER user id (= qualifier_credits.player_id =
    // OIDC sub), NOT the session userId. The session userId is poker-server's
    // OWN local users.id (an INTEGER keyed by phone); qualifier player_ids are
    // master-API UUIDs, so a local-int-vs-master-UUID compare never matched.
    // oauthLogin now stashes masterUserId (the sub). Phone is a fallback for
    // any session that predates the stash.
    const masterId = auth?.masterUserId ? String(auth.masterUserId) : '';
    const phone = auth?.phone ? String(auth.phone) : '';
    if (!masterId && !phone) { socket.emit('qualifications', { weekly: false, monthly: false }); return; }
    const [weekly, monthly] = await Promise.all([
      getQualifiedPlayers('weekly'),
      getQualifiedPlayers('monthly'),
    ]);
    const match = (list: QualifiedPlayer[]) => list.find((p) =>
      (masterId && String(p.playerId) === masterId) ||
      (phone && p.phone && String(p.phone) === phone)
    );
    const weeklyEntry = match(weekly);
    const monthlyEntry = match(monthly);
    socket.emit('qualifications', {
      weekly: weeklyEntry ? { qualified: true, credits: weeklyEntry.creditCount, venue: weeklyEntry.venueName } : false,
      monthly: monthlyEntry ? { qualified: true, credits: monthlyEntry.creditCount, venue: monthlyEntry.venueName } : false,
    });
  });

  // 2026-06-12 — On-demand full-state resync. The 3D render loop pauses while a
  // tab is backgrounded, so on return the table can look a few frames stale
  // (delta compression means the next delta may not repaint everything). The
  // client emits this on visibilitychange->visible to snap straight to the live
  // hand. force=true sends a complete frame, not a delta. Read-only + per-socket.
  socket.on('requestState', () => {
    try {
      const session = playerSessions.get(socket.id);
      if (!session) return;
      const table = tableManager.getTable(session.tableId);
      if (!table) return;
      emitGameState(socket, getGameStateForPlayer(table, session.seatIndex), true);
    } catch { /* best-effort resync */ }
  });

  // ========== Qualifier Tournament Registration ==========

  // Register for a qualifier tournament
  socket.on('registerQualifierTournament', async (data: { qualifierId: string; playerName: string; phone: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Must be logged in' }); return; }

    // 2026-06-19 audit fix — identity for the qualification gate is the MASTER
    // user id (the OIDC sub stashed at oauthLogin), not the local int userId.
    const masterId = auth.masterUserId ? String(auth.masterUserId) : '';
    if (!masterId) {
      socket.emit('qualifierRegistrationResult', { success: false, error: 'Your account is not fully linked yet — please sign out and back in, then try again.' });
      return;
    }

    const qualId = data.qualifierId;
    let qt = qualifierTournaments.get(qualId);

    // Create registration if it doesn't exist yet
    if (!qt) {
      // Default config — frontend should send these but fallback to defaults
      qt = {
        qualifierId: qualId,
        qualifierType: qualId.includes('monthly') ? 'monthly' : 'weekly',
        qualifierName: qualId.includes('monthly') ? 'Monthly Major Qualifier' : 'Weekly Qualifier',
        scheduledAt: new Date(Date.now() + 7 * 86400000).toISOString(), // default: 7 days from now
        startingStack: 50000,
        maxPlayers: 999,
        players: [],
        status: 'registering',
        tournamentId: null,
        blindStructure: [],
        requiresQualifierCredit: true,
      };
      qualifierTournaments.set(qualId, qt);
    }

    const LATE_REG_WINDOW_MS = 1.5 * 60 * 60 * 1000; // 1.5 hours after start
    const SIGNUP_OPENS_BEFORE_MS = 3 * 60 * 60 * 1000; // 3 hours before start
    const phone = (data.phone || '').trim();

    // Signup window: opens 3 hours before scheduledAt, closes 1.5 hours after scheduledAt
    const scheduledTime = new Date(qt.scheduledAt).getTime();
    const now = Date.now();
    const signupOpensAt = scheduledTime - SIGNUP_OPENS_BEFORE_MS;
    const signupClosesAt = scheduledTime + LATE_REG_WINDOW_MS;

    if (now < signupOpensAt) {
      const opensIn = Math.ceil((signupOpensAt - now) / 60000);
      const h = Math.floor(opensIn / 60);
      const m = opensIn % 60;
      const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
      socket.emit('qualifierRegistrationResult', { success: false, error: `Signup opens in ${timeStr}` });
      return;
    }

    if (now > signupClosesAt) {
      socket.emit('qualifierRegistrationResult', { success: false, error: 'Signup window has closed' });
      return;
    }

    // Check if tournament is in late-registration window (running but within 1.5 hours)
    const isLateReg = qt.status === 'running' && qt.tournamentId &&
      (now - scheduledTime) < LATE_REG_WINDOW_MS;

    if (qt.status !== 'registering' && !isLateReg) {
      socket.emit('qualifierRegistrationResult', { success: false, error: 'Tournament is no longer accepting registrations' });
      return;
    }

    // 2026-06-19 audit fix (CRITICAL) — server-authoritative qualification gate.
    // Previously NOTHING here verified qualification: the ".online You're
    // Qualified!" button was UX-only, so any logged-in player could emit this
    // event and be registered + auto-seated into a qualifier they never earned.
    // Now require a credit of this tier (read-only check keyed on the master id).
    // Placed before BOTH the re-entry and first-entry branches so it covers all
    // entry paths.
    if (!(await isPlayerQualified(masterId, qt.qualifierType))) {
      socket.emit('qualifierRegistrationResult', { success: false, error: `You need a ${qt.qualifierType} qualifier credit to enter. Earn one by finishing top-5 in a live game (weekly) or finishing top-20% of your league standings (monthly).` });
      return;
    }

    // Check if player is already registered and NOT eliminated (can't double-enter)
    const existingEntry = qt.players.find(p => p.playerId === (auth.username || phone) || (phone && p.phone === phone));
    if (existingEntry) {
      // Check if they were eliminated — if so, allow re-entry (costs another credit)
      const tournament = qt.tournamentId ? tournamentManager.getTournament(qt.tournamentId) : null;
      const wasEliminated = tournament?.players.find(p => p.playerId === existingEntry.playerId)?.eliminated;

      if (!wasEliminated) {
        socket.emit('qualifierRegistrationResult', { success: false, error: 'Already registered and still playing' });
        return;
      }

      // Re-entry: enforce server-side caps + chip/credit consumption.
      // Round-4 audit P0 #4 (2026-05-12): handler previously deducted no
      // chips, consumed no qualifier credit, and trusted the frontend to
      // enforce the re-entry cap. That violates the
      // server-authoritative chip-mutations rule (CLAUDE.md). All gates
      // now run BEFORE sitDown; on any failure we bail without re-seating.
      if (isLateReg && tournament) {
        // (a) Max re-entry quota. Defensive default of 3 until a
        // games-backed schema with a per-tournament max_re_entries
        // column exists. TODO referenced on the interface above.
        const MAX_RE_ENTRIES_DEFAULT = 3;
        const maxReEntries = qt.maxReEntries ?? MAX_RE_ENTRIES_DEFAULT;
        const priorReEntries = (existingEntry as any).reEntries || 0;
        if (priorReEntries >= maxReEntries) {
          socket.emit('qualifierRegistrationResult', { success: false, error: `Re-entry limit reached (${maxReEntries})` });
          return;
        }

        // (b) Atomic chip deduction (mirrors cash-buy-in pattern at
        // index.ts:4471 and rebuy at index.ts:5878). Only runs when the
        // qualifier carries a chip buy-in.
        const buyIn = Math.floor(qt.buyIn || 0);
        if (buyIn > 0) {
          const dbChips = await ensureChipsForBuyIn(auth.userId, auth.username, buyIn);
          if (buyIn > dbChips) {
            socket.emit('qualifierRegistrationResult', { success: false, error: 'Insufficient chips for re-entry' });
            return;
          }
          if (!(await deductChips(auth.userId, buyIn))) {
            socket.emit('qualifierRegistrationResult', { success: false, error: 'Could not deduct chips — try again' });
            return;
          }
          auditLog(auth.username, 'QUALIFIER_REENTRY_BUYIN_DEDUCT', { qualifierId: qualId, buyIn, priorReEntries });
        }

        // (c) Qualifier-credit consumption — atomic conditional update
        // mirrors apps/lambdas/poker-api/src/handlers/qualifierCredits.js
        // redeemCredit(). Picks the oldest unredeemed credit owned by
        // this user and stamps it; if none are available we refund the
        // buy-in and abort.
        let consumedCreditId: string | null = null;
        if (qt.requiresQualifierCredit) {
          try {
            // 2026-06-19 audit fix — was keyed on auth.userId (local int) vs the
            // master-UUID player_id (matched 0 rows) AND wrote the slug qualId
            // into the UUID column redeemed_for_qualifier_id (cast error). Now
            // keys on masterId, filters by tier, and records the qualifier in
            // notes (a text column) instead of the UUID column.
            const credRes = await getPool().query(
              `UPDATE qualifier_credits
                  SET redeemed_at = NOW(),
                      notes = COALESCE(notes, '') || ' [re-entry:' || $1 || ']'
                WHERE id = (
                  SELECT id FROM qualifier_credits
                   WHERE player_id = $2 AND tier = $3 AND redeemed_at IS NULL
                   ORDER BY earned_at ASC NULLS LAST, created_at ASC
                   LIMIT 1
                )
                RETURNING id`,
              [qualId, masterId, qt.qualifierType]
            );
            if (credRes.rows.length === 0) {
              // Refund the chip buy-in we just took (if any) — the
              // re-entry isn't happening.
              if (buyIn > 0) {
                try {
                  await addChipsToUser(auth.userId, buyIn);
                  auditLog(auth.username, 'QUALIFIER_REENTRY_BUYIN_REFUND', { qualifierId: qualId, buyIn, reason: 'no_credit' });
                } catch (e) {
                  auditLog(auth.username, 'QUALIFIER_REENTRY_BUYIN_REFUND_FAILED', { qualifierId: qualId, buyIn, error: String(e) });
                }
              }
              socket.emit('qualifierRegistrationResult', { success: false, error: 'No qualifier credits available for re-entry' });
              return;
            }
            consumedCreditId = credRes.rows[0].id;
            auditLog(auth.username, 'QUALIFIER_REENTRY_CREDIT_CONSUME', { qualifierId: qualId, creditId: consumedCreditId });
          } catch (err: any) {
            // Refund the buy-in on DB error — never leave a player out
            // of pocket without a re-entry.
            if (buyIn > 0) {
              try {
                await addChipsToUser(auth.userId, buyIn);
                auditLog(auth.username, 'QUALIFIER_REENTRY_BUYIN_REFUND', { qualifierId: qualId, buyIn, reason: 'credit_db_error' });
              } catch (_) { /* logged below */ }
            }
            console.error('[QualifierReEntry] credit consume failed:', err);
            socket.emit('qualifierRegistrationResult', { success: false, error: 'Server error consuming qualifier credit' });
            return;
          }
        }

        // (d) NOW re-seat. Find a table with empty seats.
        const startingStack = qt.startingStack || 50000;
        let seated = false;
        for (const tid of tournament.tableIds) {
          const table = tableManager.getTable(tid);
          if (!table) continue;
          for (let s = 0; s < 9; s++) {
            if (table.seats[s].state !== 'empty') continue;
            table.sitDown(s, existingEntry.playerName, startingStack, existingEntry.playerId, false);
            tournamentManager.setPlayerTable(qt.tournamentId!, existingEntry.playerId, tid);
            // Un-eliminate the player in tournament manager
            const tp = tournament.players.find(p => p.playerId === existingEntry.playerId);
            if (tp) { tp.eliminated = false; tp.chips = startingStack; }
            // Update socket session
            const sess = playerSessions.get(socket.id);
            if (sess) { sess.tableId = tid; sess.seatIndex = s; }
            socket.join(`table:${tid}`);
            seated = true;
            console.log(`[Tournament] Re-entry: ${existingEntry.playerName} seated at table ${tid} seat ${s}`);
            break;
          }
          if (seated) break;
        }
        if (!seated) {
          // Roll back every charge so the player isn't billed for a
          // seat they never got. Mirrors the BUY_IN_REFUND path at
          // index.ts:4493.
          if (buyIn > 0) {
            try {
              await addChipsToUser(auth.userId, buyIn);
              auditLog(auth.username, 'QUALIFIER_REENTRY_BUYIN_REFUND', { qualifierId: qualId, buyIn, reason: 'no_seat' });
            } catch (e) {
              auditLog(auth.username, 'QUALIFIER_REENTRY_BUYIN_REFUND_FAILED', { qualifierId: qualId, buyIn, error: String(e) });
            }
          }
          if (consumedCreditId) {
            try {
              await getPool().query(
                `UPDATE qualifier_credits SET redeemed_at = NULL WHERE id = $1`,
                [consumedCreditId]
              );
              auditLog(auth.username, 'QUALIFIER_REENTRY_CREDIT_REFUND', { qualifierId: qualId, creditId: consumedCreditId, reason: 'no_seat' });
            } catch (e) {
              auditLog(auth.username, 'QUALIFIER_REENTRY_CREDIT_REFUND_FAILED', { qualifierId: qualId, creditId: consumedCreditId, error: String(e) });
            }
          }
          socket.emit('qualifierRegistrationResult', { success: false, error: 'No seats available for re-entry' });
          return;
        }
        // Bump in-memory re-entry counter — survives until the qt is
        // garbage-collected on tournament finish.
        (existingEntry as any).reEntries = priorReEntries + 1;
        socket.emit('qualifierRegistrationResult', { success: true, qualifierId: qualId, reentry: true });
        broadcastGameState(tournament.tableIds[0]);
        return;
      }

      socket.emit('qualifierRegistrationResult', { success: false, error: 'Re-entry not available at this time' });
      return;
    }
    // IP duplicate check — prevent multi-accounting from same device
    const regIp = socket.handshake.address;
    const sameIpCount = qt.players.filter(p => (p as any).ip === regIp).length;
    if (sameIpCount >= 2) {
      socket.emit('qualifierRegistrationResult', { success: false, error: 'Too many registrations from this device' });
      return;
    }

    // Consume a qualifier credit before registering (first-entry path).
    // Mirrors the re-entry credit-consume block above. Atomic conditional
    // UPDATE — stamps the oldest unredeemed credit for this user+tier.
    // If no credit exists, isPlayerQualified() would have already rejected
    // above, but we do the consume atomically here to prevent race conditions
    // where two simultaneous registrations both pass the read-only check.
    try {
      const credRes = await getPool().query(
        `UPDATE qualifier_credits
            SET redeemed_at = NOW(),
                notes = COALESCE(notes, '') || ' [entry:' || $1 || ']'
          WHERE id = (
            SELECT id FROM qualifier_credits
             WHERE player_id = $2 AND tier = $3 AND redeemed_at IS NULL
             ORDER BY earned_at ASC NULLS LAST, created_at ASC
             LIMIT 1
          )
          RETURNING id`,
        [qualId, masterId, qt.qualifierType]
      );
      if (credRes.rows.length === 0) {
        socket.emit('qualifierRegistrationResult', { success: false, error: 'No qualifier credits available — your credit may have already been used.' });
        return;
      }
      auditLog(auth.username, 'QUALIFIER_ENTRY_CREDIT_CONSUME', { qualifierId: qualId, creditId: credRes.rows[0].id, tier: qt.qualifierType });
    } catch (err: any) {
      console.error('[QualifierEntry] credit consume failed:', err);
      socket.emit('qualifierRegistrationResult', { success: false, error: 'Server error consuming qualifier credit — please try again.' });
      return;
    }

    qt.players.push({
      playerId: auth.username || phone,
      playerName: data.playerName || auth.username,
      phone: phone,
      socketId: socket.id,
      ip: regIp,
    } as any);

    socket.emit('qualifierRegistrationResult', {
      success: true,
      qualifierId: qualId,
      registeredCount: qt.players.length,
    });

    // Broadcast updated count to all clients
    io.emit('qualifierTournamentUpdate', {
      qualifierId: qualId,
      status: qt.status,
      registeredCount: qt.players.length,
      players: qt.players.map(p => ({ name: p.playerName })),
    });
  });

  // Unregister from a qualifier tournament
  socket.on('unregisterQualifierTournament', async (data: { qualifierId: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) return;

    const qt = qualifierTournaments.get(data.qualifierId);
    if (!qt || qt.status !== 'registering') return;

    qt.players = qt.players.filter(p => p.playerId !== auth.username);

    socket.emit('qualifierRegistrationResult', {
      success: true,
      qualifierId: data.qualifierId,
      registeredCount: qt.players.length,
      unregistered: true,
    });

    io.emit('qualifierTournamentUpdate', {
      qualifierId: data.qualifierId,
      status: qt.status,
      registeredCount: qt.players.length,
      players: qt.players.map(p => ({ name: p.playerName })),
    });
  });

  // Get qualifier tournament registrations
  socket.on('getQualifierTournaments', async () => {
    const SIGNUP_OPENS_BEFORE_MS = 3 * 60 * 60 * 1000;
    const SIGNUP_CLOSES_AFTER_MS = 1.5 * 60 * 60 * 1000;
    const now = Date.now();
    const list: any[] = [];
    for (const [id, qt] of qualifierTournaments) {
      const scheduledTime = new Date(qt.scheduledAt).getTime();
      const signupOpensAt = new Date(scheduledTime - SIGNUP_OPENS_BEFORE_MS).toISOString();
      const signupClosesAt = new Date(scheduledTime + SIGNUP_CLOSES_AFTER_MS).toISOString();
      const signupOpen = now >= (scheduledTime - SIGNUP_OPENS_BEFORE_MS) && now <= (scheduledTime + SIGNUP_CLOSES_AFTER_MS);
      list.push({
        qualifierId: id,
        qualifierType: qt.qualifierType,
        qualifierName: qt.qualifierName,
        scheduledAt: qt.scheduledAt,
        signupOpensAt,
        signupClosesAt,
        signupOpen,
        registeredCount: qt.players.length,
        maxPlayers: qt.maxPlayers,
        status: qt.status,
        tournamentId: qt.tournamentId,
        players: qt.players.map(p => ({ name: p.playerName })),
      });
    }
    socket.emit('qualifierTournamentList', list);
  });

  // ========== Tournament Spectator Mode ==========

  // Spectate a tournament (auto-picks busiest table)
  socket.on('spectateTournament', async (data: { tournamentId: string }) => {
    const tournament = tournamentManager.getTournament(data.tournamentId);
    if (!tournament || tournament.status !== 'running') {
      socket.emit('error', { message: 'Tournament not found or not running' });
      return;
    }

    // Find the table with the most alive players
    let bestTable = '';
    let bestCount = 0;
    for (const tid of tournament.tableIds) {
      const count = tournamentManager.getAlivePlayersOnTable(data.tournamentId, tid).length;
      if (count > bestCount) {
        bestCount = count;
        bestTable = tid;
      }
    }

    if (!bestTable) {
      socket.emit('error', { message: 'No active tables' });
      return;
    }

    // Use existing spectator system
    socket.emit('spectateTable', { tableId: bestTable });
    // Manually trigger spectate logic
    const specSet = spectators.get(bestTable) || new Set();
    specSet.add(socket.id);
    spectators.set(bestTable, specSet);
    socket.join(`table:${bestTable}`);

    const table = tableManager.getTable(bestTable);
    if (table) {
      const state: any = getGameStateForPlayer(table, -1, false);
      state.isSpectator = true;
      state.spectatorCount = specSet.size;
      state.tournamentStatus = tournamentManager.getTournamentStatus(data.tournamentId);
      state.tournamentTableIds = tournament.tableIds;
      emitGameState(socket, state);
    }

    socket.emit('spectatingTournament', {
      tournamentId: data.tournamentId,
      tableId: bestTable,
      tableIds: tournament.tableIds,
      status: tournamentManager.getTournamentStatus(data.tournamentId),
    });
  });

  // Cycle to next/prev tournament table
  socket.on('spectateNextTable', async (data: { tournamentId: string; currentTableId: string; direction?: string }) => {
    const tournament = tournamentManager.getTournament(data.tournamentId);
    if (!tournament) return;

    const tableIds = tournament.tableIds;
    const currentIdx = tableIds.indexOf(data.currentTableId);
    const dir = data.direction === 'prev' ? -1 : 1;
    const nextIdx = (currentIdx + dir + tableIds.length) % tableIds.length;
    const nextTableId = tableIds[nextIdx];

    // Leave current table
    const oldSet = spectators.get(data.currentTableId);
    if (oldSet) { oldSet.delete(socket.id); }
    socket.leave(`table:${data.currentTableId}`);

    // Join new table
    const newSet = spectators.get(nextTableId) || new Set();
    newSet.add(socket.id);
    spectators.set(nextTableId, newSet);
    socket.join(`table:${nextTableId}`);

    const table = tableManager.getTable(nextTableId);
    if (table) {
      const state: any = getGameStateForPlayer(table, -1, false);
      state.isSpectator = true;
      state.tournamentStatus = tournamentManager.getTournamentStatus(data.tournamentId);
      state.tournamentTableIds = tournament.tableIds;
      emitGameState(socket, state);
    }

    socket.emit('spectatingTournament', {
      tournamentId: data.tournamentId,
      tableId: nextTableId,
      tableIds: tournament.tableIds,
      status: tournamentManager.getTournamentStatus(data.tournamentId),
    });
  });

  socket.on('checkUsername', async (data: { username: string }) => {
    const name = (data.username || '').trim();
    if (name.length < 2) { socket.emit('checkUsernameResult', { available: null, username: name }); return; }
    const taken = await isUsernameTaken(name);
    socket.emit('checkUsernameResult', { available: !taken, username: name });
  });

  // ========== LLM Post-Hand Coach ==========
  // Rate limit: max 1 coach request per 10s per authenticated user
  const coachLastRequest = new Map<number, number>();
  socket.on('coachHand', async (data: { handHistory: any; playerName: string }) => {
    try {
      const auth = authSessions.get(socket.id);
      if (!auth) { socket.emit('coachResult', { error: 'Not authenticated' }); return; }

      // Payload size cap — prevents LLM token DoS
      const serialized = JSON.stringify(data || {});
      if (serialized.length > 8 * 1024) { // 8 KB
        socket.emit('coachResult', { error: 'Hand history too large' });
        return;
      }

      // Per-user rate limit
      const now = Date.now();
      const last = coachLastRequest.get(auth.userId) || 0;
      if (now - last < 10_000) {
        socket.emit('coachResult', { error: 'Please wait a moment before requesting another analysis' });
        return;
      }
      coachLastRequest.set(auth.userId, now);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { socket.emit('coachResult', { error: 'Coach unavailable — API key not configured' }); return; }
      const client = new Anthropic({ apiKey });
      const { handHistory, playerName } = data;
      if (!handHistory || typeof playerName !== 'string') {
        socket.emit('coachResult', { error: 'Invalid request' });
        return;
      }
      const actionLog = (handHistory.players || [])
        .find((p: any) => p.name === playerName)?.actions || [];
      const prompt = `You are an expert poker coach. Analyze this hand and give concise, actionable feedback on each decision.

Player: ${playerName}
Community cards: ${(handHistory.communityCards || []).map((c: any) => `${c.rank}${['♥','♦','♣','♠'][c.suit]}`).join(' ')}
Actions: ${actionLog.join(', ')}
Result: ${handHistory.winners?.find((w: any) => w.name === playerName) ? `Won ${handHistory.winners.find((w: any) => w.name === playerName).chipsWon} chips with ${handHistory.winners.find((w: any) => w.name === playerName).handName}` : 'Lost this hand'}

Give feedback in this JSON format:
{"score": 0-10, "summary": "one sentence", "decisions": [{"action": "...", "quality": "good|ok|poor", "advice": "..."}], "keyLesson": "..."}`;

      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = message.content[0].type === 'text' ? message.content[0].text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      let result: any;
      if (jsonMatch) {
        try {
          result = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
          socket.emit('coachResult', { error: 'parse_failed' });
          return;
        }
      } else {
        result = { score: 5, summary: text, decisions: [], keyLesson: '' };
      }
      socket.emit('coachResult', { success: true, analysis: result });
    } catch (err: any) {
      socket.emit('coachResult', { error: err.message || 'Coach error' });
    }
  });

  // ========== WebRTC Voice Chat Signaling ==========
  // All voice handlers require authentication and that the caller is actually
  // seated at the referenced table (prevents impersonation & room flooding).
  const isSeatedAt = (tableId: string): boolean => {
    const s = playerSessions.get(socket.id);
    return !!(s && s.tableId === tableId);
  };
  socket.on('voiceJoin', async (data: { tableId: string; username: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    if (!data?.tableId || !isSeatedAt(data.tableId)) { socket.emit('error', { message: 'Not seated at table' }); return; }
    const room = `voice_${data.tableId}`;
    socket.join(room);
    // Use the authenticated username, not the one the client sent.
    socket.to(room).emit('voicePeerJoined', { socketId: socket.id, username: auth.username });
  });
  socket.on('voiceLeave', async (data: { tableId: string }) => {
    if (!authSessions.get(socket.id)) return;
    if (!data?.tableId) return;
    socket.leave(`voice_${data.tableId}`);
    socket.to(`voice_${data.tableId}`).emit('voicePeerLeft', { socketId: socket.id });
  });
  socket.on('voiceOffer', async (data: { to: string; offer: any; username: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !data?.to) return;
    io.to(data.to).emit('voiceOffer', { from: socket.id, offer: data.offer, username: auth.username });
  });
  socket.on('voiceAnswer', async (data: { to: string; answer: any }) => {
    if (!authSessions.get(socket.id) || !data?.to) return;
    io.to(data.to).emit('voiceAnswer', { from: socket.id, answer: data.answer });
  });
  socket.on('voiceIce', async (data: { to: string; candidate: any }) => {
    if (!authSessions.get(socket.id) || !data?.to) return;
    io.to(data.to).emit('voiceIce', { from: socket.id, candidate: data.candidate });
  });

  // ========== Staking Marketplace ==========
  // In-memory cache hydrated from DB on first use. Chips move via deductChips /
  // addChipsToUser (atomic SQL) on each buyStake — no longer purely social.
  const stakingOffers: Map<string, any> = (global as any).__stakingOffers || ((global as any).__stakingOffers = new Map());
  if (!(global as any).__stakingHydrated) {
    (global as any).__stakingHydrated = true;
    getPool().query(`SELECT * FROM staking_offers WHERE settled_at IS NULL ORDER BY created_at ASC`)
      .then(({ rows }) => {
        for (const r of rows) {
          stakingOffers.set(r.id, {
            id: r.id,
            tournamentId: r.tournament_id,
            totalPct: Number(r.total_pct),
            pricePerPct: Number(r.price_per_pct),
            playerName: r.player_name,
            sellerId: r.seller_id,
            remaining: Number(r.remaining),
            backers: r.backers || [],
            createdAt: new Date(r.created_at).getTime(),
          });
        }
        console.log(`[Staking] Hydrated ${rows.length} open offers from DB`);
      })
      .catch((e: any) => console.warn('[Staking] Hydration failed:', e.message));
  }

  socket.on('createStake', async (data: { tournamentId: string; totalPct: number; pricePerPct: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) { socket.emit('error', { message: 'Sign in to create a staking offer' }); return; }
    if (!data.tournamentId || typeof data.totalPct !== 'number' || data.totalPct <= 0 || data.totalPct > 100) {
      socket.emit('error', { message: 'Invalid staking offer' }); return;
    }
    if (typeof data.pricePerPct !== 'number' || data.pricePerPct <= 0 || data.pricePerPct > 1_000_000) {
      socket.emit('error', { message: 'Invalid price per percent' }); return;
    }
    const id = uuidv4();
    const offer = {
      id,
      tournamentId: String(data.tournamentId).slice(0, 64),
      totalPct: data.totalPct,
      pricePerPct: data.pricePerPct,
      playerName: auth.username,        // server-derived, not client-supplied
      sellerId: auth.userId,
      remaining: data.totalPct,
      backers: [] as { name: string; pct: number }[],
      createdAt: Date.now(),
    };
    try {
      await getPool().query(
        `INSERT INTO staking_offers (id, tournament_id, total_pct, price_per_pct, remaining, seller_id, player_name, backers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '[]')`,
        [id, offer.tournamentId, offer.totalPct, offer.pricePerPct, offer.remaining, offer.sellerId, offer.playerName]
      );
      stakingOffers.set(id, offer);
      auditLog(auth.username, 'STAKING_OFFER_CREATED', { offerId: id, tournamentId: offer.tournamentId, totalPct: offer.totalPct, pricePerPct: offer.pricePerPct });
      io.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });
      socket.emit('stakeCreated', { id });
    } catch (e: any) {
      console.error('[Staking] createStake DB error:', e.message);
      socket.emit('error', { message: 'Failed to create staking offer' });
    }
  });

  socket.on('buyStake', async (data: { offerId: string; pct: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) { socket.emit('buyStakeResult', { success: false, error: 'Sign in to back a player' }); return; }
    if (!data.offerId || typeof data.pct !== 'number' || data.pct <= 0) {
      socket.emit('buyStakeResult', { success: false, error: 'Invalid purchase' }); return;
    }
    const offer = stakingOffers.get(data.offerId);
    if (!offer || offer.remaining < data.pct) { socket.emit('buyStakeResult', { success: false, error: 'Offer unavailable' }); return; }
    if (offer.sellerId === auth.userId) { socket.emit('buyStakeResult', { success: false, error: 'Cannot back your own offer' }); return; }

    const totalCost = Math.round(data.pct * offer.pricePerPct);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      // Deduct chips from backer — atomic check-and-subtract within the transaction.
      const { rowCount: deducted } = await client.query(
        'UPDATE users SET chips = chips - $1 WHERE id = $2 AND chips >= $1',
        [totalCost, auth.userId]
      );
      if (!deducted) {
        await client.query('ROLLBACK');
        socket.emit('buyStakeResult', { success: false, error: 'Insufficient chips' });
        return;
      }

      // Credit seller within the same transaction.
      await client.query('UPDATE users SET chips = chips + $1 WHERE id = $2', [totalCost, offer.sellerId]);

      // Update the offer row.
      const newRemaining = offer.remaining - data.pct;
      const newBackers = [...offer.backers, { name: auth.username, pct: data.pct }];
      const settled = newRemaining <= 0;
      if (settled) {
        await client.query(`UPDATE staking_offers SET remaining = 0, backers = $1, settled_at = NOW() WHERE id = $2`, [JSON.stringify(newBackers), data.offerId]);
      } else {
        await client.query(`UPDATE staking_offers SET remaining = $1, backers = $2 WHERE id = $3`, [newRemaining, JSON.stringify(newBackers), data.offerId]);
      }

      await client.query('COMMIT');

      // Only mutate in-memory state after DB commit succeeds.
      offer.remaining = newRemaining;
      offer.backers = newBackers;
      if (settled) stakingOffers.delete(data.offerId);

      auditLog(auth.username, 'STAKING_BUY', { offerId: data.offerId, pct: data.pct, totalCost, sellerId: offer.sellerId });
      io.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });
      socket.emit('buyStakeResult', { success: true });
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Staking] buyStake transaction failed:', e.message);
      socket.emit('buyStakeResult', { success: false, error: 'Purchase failed — no chips were moved' });
    } finally {
      client.release();
    }
  });

  socket.on('getStakes', async () => {
    socket.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });
  });

  // OAuth2 login: validate access token from auth server.
  //
  // The auth server's `sub` claim is the master-API users.id UUID. poker-server
  // has its OWN SQLite users table with integer IDs keyed on phone, so we
  // mirror the same upsert-by-phone pattern authWithTicket uses: look up the
  // local user by phone (or create a placeholder row on first login) and use
  // THAT integer id for authSessions and loadProgress. The previous
  // `parseInt(oauthResult.sub, 10)` just parsed the first digit of the UUID
  // and always failed with "User not found".
  socket.on('oauthLogin', async (data: { accessToken: string; skipSeatRecovery?: boolean }) => {
    if (!data?.accessToken) {
      socket.emit('loginResult', { success: false, error: 'No access token provided' });
      return;
    }
    try {
      const oauthResult = await validateOAuthToken(data.accessToken);
      if (!oauthResult.valid || !oauthResult.sub) {
        reportAuthEvent('introspection_failed', { error: oauthResult.error || 'invalid', via: 'oauthLogin' });
        socket.emit('loginResult', { success: false, error: oauthResult.error || 'Invalid token' });
        return;
      }

      const phone = oauthResult.phone || oauthResult.username;
      if (!phone) {
        socket.emit('loginResult', { success: false, error: 'Token missing phone/username claim' });
        return;
      }

      const displayName = oauthResult.username || String(phone);

      // Upsert local poker-server user keyed on phone (= username column).
      // Same convention as authWithTicket + syncMasterUser in authManager.
      const bcrypt = require('bcryptjs');
      const placeholderHash = bcrypt.hashSync(
        `oauth-placeholder-${oauthResult.sub}-${Date.now()}`,
        10
      );
      const { rows } = await getPool().query(
        `INSERT INTO users (username, display_name, password_hash, chips, level, xp, stats)
           VALUES ($1, $2, $3, ${DEFAULT_CHIPS}, ${DEFAULT_LEVEL}, ${DEFAULT_XP}, $4)
           ON CONFLICT (LOWER(username)) DO UPDATE
             SET display_name = COALESCE(users.display_name, $2)
         RETURNING *`,
        [
          String(phone),
          displayName,
          placeholderHash,
          JSON.stringify({ masterPhone: phone, masterUsername: oauthResult.username, masterUserId: oauthResult.sub }),
        ]
      );
      const localUser = rows[0];

      const userId = localUser.id;
      const progress = await loadProgress(userId);

      // Fall back to a minimal payload if loadProgress can't construct one
      // (e.g., brand-new user with no progression rows yet). Include phone so
      // the client can emit `getQualifications` — without it the qualifier
      // tournament lobby hangs on "Checking qualification..." forever.
      const baseUserData = (progress.success && progress.userData) ? progress.userData : {
        id: localUser.id,
        username: localUser.username,
        displayName: localUser.display_name,
        chips: localUser.chips,
        level: localUser.level,
        xp: localUser.xp,
        stats: typeof localUser.stats === 'string' ? JSON.parse(localUser.stats || '{}') : (localUser.stats || {}),
        achievements: typeof localUser.achievements === 'string' ? JSON.parse(localUser.achievements || '[]') : (localUser.achievements || []),
        isAdmin: !!oauthResult.isAdmin,
      };
      const userData = {
        ...baseUserData,
        phone: String(phone),
        phoneNumber: String(phone),
      };

      authSessions.set(socket.id, {
        userId,
        username: localUser.username,
        masterUserId: String(oauthResult.sub),  // master-API users.id = qualifier player_id
        phone: String(phone),
      });

      // 2026-06-12 — SEAT RECOVERY on the .online PRIMARY login/reconnect path.
      // oauthLogin previously had NONE (only tokenLogin did), so every reconnect
      // orphaned the player's seat (stuck "ghost") and never put them back. This
      // mirrors tokenLogin's proven restore. Seats carry no userId — only
      // playerName — so the post-restart orphan match is by name + "no live
      // session on that seat" (same approach as clearGhostSeatsForUser). Wrapped
      // in try/catch so a recovery miss can never break login itself.
      // 3f multi-table: SECONDARY sockets pass skipSeatRecovery=true so they
      // don't fight the PRIMARY socket over the single reservedSeats[userId]
      // slot / name-scan recovery (which would yank a secondary onto the
      // primary's table). The primary login path leaves skipSeatRecovery
      // falsy, so its proven reconnect behavior is unchanged.
      if (!data?.skipSeatRecovery) try {
        const recoverName = localUser.display_name || localUser.username;
        // (a) Post-restart orphan recovery: a Railway redeploy wipes the
        // in-memory reservedSeats Map, but the seat survives in Redis-rehydrated
        // table state. Find the player's orphaned seat (their name, no live
        // session pointing at it) and synthesize a reservation so (b) claims it.
        if (!reservedSeats.has(userId) && recoverName) {
          let found = false;
          for (const t of tableManager.getTableList()) {
            const table = tableManager.getTable(t.tableId);
            if (!table) continue;
            for (let i = 0; i < table.seats.length; i++) {
              const seat = table.seats[i];
              if (seat.state !== 'occupied' || seat.isAI) continue;
              if (seat.playerName !== recoverName) continue;
              let liveSession = false;
              for (const [sid, sess] of playerSessions) {
                if (sid === socket.id) continue;
                if (sess.tableId === t.tableId && sess.seatIndex === i) { liveSession = true; break; }
              }
              if (liveSession) continue;
              reservedSeats.set(userId, {
                userId, tableId: t.tableId, seatIndex: i,
                playerName: seat.playerName, chips: seat.chipCount,
                avatar: (progress.userData as any)?.avatar ?? undefined,
                expiresAt: Date.now() + 60_000, cleanupTimer: undefined,
              } as any);
              console.log(`[OAuth Reconnect] orphan-seat recovery (name): user ${userId} (${recoverName}) -> ${t.tableId} seat ${i}`);
              found = true; break;
            }
            if (found) break;
          }
        }
        // (b) Restore the reserved seat (the normal reconnect path).
        const reserved = reservedSeats.get(userId);
        if (reserved && reserved.expiresAt > Date.now()) {
          const rTable = tableManager.getTable(reserved.tableId);
          const rSeat = rTable?.seats?.[reserved.seatIndex];
          if (rTable && rSeat && rSeat.state === 'occupied' && !rSeat.isAI) {
            if (reserved.cleanupTimer) clearTimeout(reserved.cleanupTimer);
            reservedSeats.delete(userId);
            // Guarantee EXACTLY ONE seat: clear any OTHER seats this user holds
            // on this table (sessions + name-matched orphans) before claiming the
            // restored one. Kills the "two of me" duplicate; stacks are credited
            // back to the wallet inside clearGhostSeatsForUser.
            clearGhostSeatsForUser(userId, reserved.tableId, socket.id, reserved.seatIndex);
            playerSessions.set(socket.id, {
              socketId: socket.id, tableId: reserved.tableId, seatIndex: reserved.seatIndex,
              playerName: reserved.playerName, playerId: `user_${userId}`,
              trainingEnabled: false, sittingOut: false, avatar: reserved.avatar,
            } as PlayerSession);
            socket.join(`table:${reserved.tableId}`);
            const tracker = sitOutTracker.get(reserved.tableId);
            if (tracker) tracker.delete(reserved.seatIndex);
            syncSitOutToTable(reserved.tableId);
            if (!reserved.sittingOut) { rSeat.deadBlindOwedChips = 0; rSeat.missedBlind = 'none'; }
            socket.emit('reconnectedToTable', { tableId: reserved.tableId, seatIndex: reserved.seatIndex });
            emitGameState(socket, getGameStateForPlayer(rTable, reserved.seatIndex), true);
            broadcastGameState(reserved.tableId);
            console.log(`[OAuth Reserve] user ${userId} reconnected to seat ${reserved.seatIndex}`);
          } else {
            reservedSeats.delete(userId);
          }
        }
      } catch (e: any) {
        console.warn(`[OAuth seat-recovery] user ${userId}:`, e?.message);
      }

      socket.emit('loginResult', {
        success: true,
        token: data.accessToken,
        userData,
      });
      hydrateAndPushProgress(socket, userId, localUser.username).catch(() => {});

      console.log(
        `[OAuth] oauthLogin ok: localId=${localUser.id} phone=${phone} masterId=${oauthResult.sub}`
      );
    } catch (err: any) {
      console.error('[OAuth] oauthLogin error:', err);
      if (Sentry) Sentry.captureException(err, { tags: { area: 'auth.oauthLogin' } });
      socket.emit('loginResult', { success: false, error: 'Authentication failed' });
    }
  });

  socket.on('tokenLogin', async (data: { token: string }) => {
    // Rate limit: max 3 attempts per minute per socket
    const now = Date.now();
    const tlKey = socket.id;
    const tlEntry = tokenLoginAttempts.get(tlKey) || { attempts: 0, firstAt: now };
    if (now - tlEntry.firstAt > 60_000) {
      tlEntry.attempts = 0;
      tlEntry.firstAt = now;
    }
    tlEntry.attempts++;
    tokenLoginAttempts.set(tlKey, tlEntry);
    if (tlEntry.attempts > 3) {
      socket.emit('tokenLoginResult', { success: false, message: 'Too many login attempts' });
      return;
    }

    // Try OAuth2 RS256 token first, then fall back to legacy HS256 JWT
    const oauthResult = await validateOAuthToken(data.token);
    if (oauthResult.valid && oauthResult.sub) {
      const userId = parseInt(oauthResult.sub, 10);
      const progress = await loadProgress(userId);
      if (progress.success && progress.userData) {
        authSessions.set(socket.id, { userId, username: progress.userData.username });

        // Post-restart seat recovery: Railway redeploy wipes in-memory
        // state (including reservedSeats Map). But table state was
        // rehydrated from Redis so this user's seat still exists with
        // their playerId. Synthesize a reservedSeats entry so the
        // existing reconnect flow can claim the seat.
        if (!reservedSeats.has(userId)) {
          const expectedPlayerId = `user_${userId}`;
          for (const t of tableManager.getTableList()) {
            const table = tableManager.getTable(t.tableId);
            if (!table) continue;
            for (let i = 0; i < table.seats.length; i++) {
              const seat = table.seats[i];
              if (seat.state !== 'occupied' || seat.isAI) continue;
              if (seat.playerId !== expectedPlayerId) continue;
              // Found an orphaned seat for this user. Reserve it so the
              // block below treats it as a normal reconnect. No cleanupTimer
              // needed — this synthetic reservation will be consumed
              // immediately by the reconnect code below. Previous version
              // used a dummy `setTimeout(() => {}, 0)` which was a harmless
              // but confusing no-op and caused audit false-positives.
              // Consumers of cleanupTimer must guard with optional-chain.
              reservedSeats.set(userId, {
                userId,
                tableId: t.tableId,
                seatIndex: i,
                playerName: seat.playerName,
                chips: seat.chipCount,
                avatar: (progress.userData as any).avatar ?? undefined,
                expiresAt: Date.now() + 60_000,
                cleanupTimer: undefined,
              } as any);
              console.log(`[Reconnect] orphan-seat recovery: user ${userId} → ${t.tableId} seat ${i}`);
              break;
            }
            if (reservedSeats.has(userId)) break;
          }
        }

        // Check for reserved seat (same reconnection logic as legacy)
        const reserved = reservedSeats.get(userId);
        if (reserved && reserved.expiresAt > Date.now()) {
          const table = tableManager.getTable(reserved.tableId);
          if (table) {
            const seat = table.seats[reserved.seatIndex];
            if (seat && seat.state === 'occupied' && !seat.isAI) {
              if (reserved.cleanupTimer) clearTimeout(reserved.cleanupTimer);
              reservedSeats.delete(userId);
              const restoredSession: PlayerSession = {
                socketId: socket.id,
                tableId: reserved.tableId,
                seatIndex: reserved.seatIndex,
                playerName: reserved.playerName,
                playerId: `user_${userId}`,
                trainingEnabled: false,
                sittingOut: false,
                avatar: reserved.avatar,
              };
              playerSessions.set(socket.id, restoredSession);
              socket.join(`table:${reserved.tableId}`);
              // MISSED-BLINDS FIX: on reconnect, remove seat from
              // sit-out set AND push the fresh set to the table so
              // markSittingOutBlinds on next hand doesn't re-mark.
              // Also clear any dead-blind debt that accumulated during
              // the brief disconnect — the user didn't intentionally
              // sit out; their socket just blipped (PWA background,
              // WiFi hiccup). If they meant to sit out they'd use the
              // explicit Sit Out button.
              const tracker = sitOutTracker.get(reserved.tableId);
              if (tracker) tracker.delete(reserved.seatIndex);
              syncSitOutToTable(reserved.tableId);
              const reSeat = table.seats[reserved.seatIndex];
              // 2026-06-11 audit E5: only forgive dead-blind debt for a
              // genuine connectivity blip. If the player was SITTING OUT when
              // they dropped, they legitimately owe the accrued dead blinds —
              // preserve them so a drop+reconnect can't dodge owed blinds.
              if (reSeat && !reserved.sittingOut) {
                reSeat.deadBlindOwedChips = 0;
                reSeat.missedBlind = 'none';
              }
              socket.emit('reconnectedToTable', {
                tableId: reserved.tableId,
                seatIndex: reserved.seatIndex,
              });
              // Send a FORCED full state to the reconnecting socket so they
              // get hole cards + current phase + turn info immediately, not
              // wait for the next delta. `broadcastGameState` alone uses
              // delta compression and can send an empty frame if nothing
              // changed during the disconnect window.
              const rTable = tableManager.getTable(reserved.tableId);
              if (rTable) {
                emitGameState(socket, getGameStateForPlayer(rTable, reserved.seatIndex), true);
              }
              broadcastGameState(reserved.tableId);
              console.log(`[OAuth Reserve] User ${userId} reconnected to seat ${reserved.seatIndex}`);
            } else {
              reservedSeats.delete(userId);
            }
          } else {
            reservedSeats.delete(userId);
          }
        }

        socket.emit('loginResult', { success: true, token: data.token, userData: progress.userData });
        hydrateAndPushProgress(socket, progress.userData.id, progress.userData.username).catch(() => {});
        return;
      }
    }

    // Legacy HS256 JWT fallback
    const result = await getUserFromToken(data.token);
    if (result.success && result.userData) {
      const userId = result.userData.id;
      authSessions.set(socket.id, { userId, username: result.userData.username });

      // Check for a reserved seat and restore it
      const reserved = reservedSeats.get(userId);
      if (reserved && reserved.expiresAt > Date.now()) {
        const table = tableManager.getTable(reserved.tableId);
        if (table) {
          const seat = table.seats[reserved.seatIndex];
          // Seat still belongs to this player (state occupied, not AI)
          if (seat && seat.state === 'occupied' && !seat.isAI) {
            if (reserved.cleanupTimer) clearTimeout(reserved.cleanupTimer);
            reservedSeats.delete(userId);

            // Re-associate socket with the session
            const restoredSession: PlayerSession = {
              socketId: socket.id,
              tableId: reserved.tableId,
              seatIndex: reserved.seatIndex,
              playerName: reserved.playerName,
              playerId: `user_${userId}`,
              trainingEnabled: false,
              sittingOut: reserved.sittingOut,
              avatar: reserved.avatar,
            };
            playerSessions.set(socket.id, restoredSession);
            socket.join(`table:${reserved.tableId}`);

            // Remove from sit-out if they were marked out during disconnect
            // (they'll sit back in since they reconnected). MUST mirror the
            // OAuth reconnect path (line ~2866): clear the tracker entry,
            // sync the change into the PokerTable's _sittingOutSeats set,
            // AND zero out any dead-blind debt that accumulated during the
            // brief disconnect. Without this, a PWA backgrounding blip on
            // the legacy tokenLogin path left the user flagged + billed.
            restoredSession.sittingOut = false;
            const tracker = sitOutTracker.get(reserved.tableId);
            if (tracker) tracker.delete(reserved.seatIndex);
            syncSitOutToTable(reserved.tableId);
            const reSeatLegacy = table.seats[reserved.seatIndex];
            // E5: preserve owed dead blinds if they were sitting out (no dodge).
            if (reSeatLegacy && !reserved.sittingOut) {
              reSeatLegacy.deadBlindOwedChips = 0;
              reSeatLegacy.missedBlind = 'none';
            }

            socket.emit('reconnectedToTable', {
              tableId: reserved.tableId,
              seatIndex: reserved.seatIndex,
            });

            // Forced full state to the reconnecting socket — see the OAuth
            // branch above for rationale.
            const rTable2 = tableManager.getTable(reserved.tableId);
            if (rTable2) {
              emitGameState(socket, getGameStateForPlayer(rTable2, reserved.seatIndex), true);
            }
            broadcastGameState(reserved.tableId);
            console.log(`[Reserve] User ${userId} (${reserved.playerName}) reconnected to seat ${reserved.seatIndex}`);
          } else {
            reservedSeats.delete(userId);
          }
        } else {
          reservedSeats.delete(userId);
        }
      }
    }
    socket.emit('loginResult', result);
    // Hydrate + push progress for legacy tokenLogin path too so the
    // UI never sits at fresh-init level:1 after a redeploy.
    if (result.success && result.userData) {
      hydrateAndPushProgress(socket, result.userData.id, result.userData.username).catch(() => {});
    }
  });

  socket.on('logout', async () => {
    authSessions.delete(socket.id);
  });

  socket.on('loadProgress', async (data: { userId: number }) => {
    // 2026-06-10 audit (IDOR fix): loadProgress previously trusted the
    // client-supplied userId with no auth check, so any authenticated
    // socket could read ANY user's progression (xp/level/stats/stars/
    // inventory) by enumerating sequential userIds. Gate it the same
    // way saveProgress (directly below) already does — caller may only
    // load their OWN progress.
    const auth = authSessions.get(socket.id);
    if (!auth || auth.userId !== data.userId) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    const result = await loadProgress(data.userId);
    socket.emit('progressLoaded', result);
  });

  socket.on('saveProgress', async (data: { userId: number; chips?: number; level?: number; xp?: number; stats?: Record<string, any>; achievements?: string[] }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || auth.userId !== data.userId) {
      socket.emit('error', { message: 'Unauthorized' }); return;
    }
    // SECURITY + DATA-SAFETY:
    // - NEVER trust the client with chips writes — saveProgress would
    //   plain-overwrite users.chips, letting the client set any balance.
    //   All chip mutations must flow through server-authoritative paths
    //   (pot distribution, shop purchase, admin grant, etc.).
    // - Gate on progress.hydrated so a stale client push can't fire
    //   before we've loaded the real values from DB.
    const playerId = playerSessions.get(socket.id)?.playerId || `user-${auth.userId}`;
    const progress = progressionManager.getProgress(playerId);
    if (!progress || !progress.hydrated || progress.userId !== auth.userId) {
      // Hydrate, then retry once. Subsequent races fall through to error.
      await progressionManager.hydrateFromDB(playerId, auth.userId).catch(() => {});
      const rehydrated = progressionManager.getProgress(playerId);
      if (!rehydrated || !rehydrated.hydrated) {
        socket.emit('progressSaved', { success: false, error: 'not_ready' });
        return;
      }
    }
    const { userId, chips: _ignoredChips, ...progressData } = data;
    const success = await saveProgress(userId, progressData);
    socket.emit('progressSaved', { success });
  });

  // ========== End Auth Events ==========

  // ========== Spin Wheel / Reward Events ==========

  socket.on('claimSpinReward', async () => {
    // SECURITY: legacy handler used to trust a client-supplied `value`
    // for the chip reward amount — a blatant cheat vector. Deprecated in
    // favor of the server-authoritative `claimDailySpinServer` flow.
    // This shim emits the same acknowledgement shape so older clients
    // don't break, but does NOT credit any chips. Newer clients should
    // emit 'claimDailySpinServer' instead.
    socket.emit('spinRewardClaimed', { type: 'deprecated', value: 0 });
  });

  // ========== Leaderboard Events ==========

  socket.on('getLeaderboard', async (data: { period?: string }) => { // async
    try {
      const period = data?.period || 'alltime';
      const entries = await getLeaderboard(50, period);
      socket.emit('leaderboardData', { period, entries });
    } catch {
      socket.emit('leaderboardData', { period: data?.period || 'alltime', entries: [] });
    }
  });

  socket.on('searchPlayers', async (data: { query: string }) => {
    try {
      const q = (data?.query || '').trim();
      if (q.length < 2) { socket.emit('playerSearchResults', { results: [] }); return; }
      socket.emit('playerSearchResults', { results: await searchUsers(q) });
    } catch {
      socket.emit('playerSearchResults', { results: [] });
    }
  });

  // ========== Admin Events ==========
  // auditLog is declared at module scope

  socket.on('getAdminStats', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth || !(await isUserAdmin(auth.userId))) {
      socket.emit('adminStats', { error: 'Access denied' });
      return;
    }

    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const memUsage = process.memoryUsage();
    const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);

    socket.emit('adminStats', {
      totalUsers: await getTotalUsers(),
      activeConnections: io.engine.clientsCount,
      tablesRunning: tableManager.getTableList().length,
      handsPlayedToday,
      uptime: `${hours}h ${mins}m`,
      memoryUsage: `${memMB} MB`,
      users: await getAllUsers(),
    });
  });

  socket.on('adminGrantChips', async (data: { userId: number; amount: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !(await isUserAdmin(auth.userId))) {
      socket.emit('error', { message: 'Access denied' });
      return;
    }
    const CHIP_GRANT_ALERT_THRESHOLD = 1_000_000;
    const amount = Math.floor(data.amount);
    if (amount <= 0 || amount > 10_000_000_000) {
      socket.emit('error', { message: 'Invalid chip amount' });
      return;
    }
    auditLog(auth.username, 'GRANT_CHIPS', { targetUserId: data.userId, amount });
    if (amount >= CHIP_GRANT_ALERT_THRESHOLD) {
      console.warn(`[AntiCheat] LARGE CHIP GRANT ALERT: admin ${auth.username} granted ${amount} chips to userId=${data.userId}`);
    }
    const success = await addChipsToUser(data.userId, amount);
    socket.emit('adminGrantChipsResult', { success, userId: data.userId, amount });
  });

  // Restore previous balances — admin-only, grants 1B chips + 50K stars
  // to the caller's own account. No idempotency flag — callable any time
  // by admin. Backed by direct additive UPDATE so race conditions can't
  // clobber it. In-memory progress is also bumped so the UI sees the
  // new balance on the next playerProgress emit.
  socket.on('adminRestoreBalance', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth || !(await isUserAdmin(auth.userId))) {
      socket.emit('adminRestoreBalanceResult', { success: false, error: 'Access denied' });
      return;
    }
    try {
      const CHIP_AMOUNT = 1_000_000_000;
      const STAR_AMOUNT = 50_000;
      // Mirror the adminGrantChips anti-cheat alert path. adminRestoreBalance
      // bypassed it for months; round-4 audit P0 #5. Threshold value matches
      // the one defined locally in adminGrantChips above (1_000_000).
      const CHIP_GRANT_ALERT_THRESHOLD = 1_000_000;
      if (CHIP_AMOUNT >= CHIP_GRANT_ALERT_THRESHOLD) {
        console.warn(`[AntiCheat] LARGE CHIP GRANT ALERT: admin ${auth.username} restored ${CHIP_AMOUNT} chips to userId=${auth.userId}`);
      }
      await getPool().query(
        `UPDATE users SET chips = chips + $1, stars = stars + $2 WHERE id = $3`,
        [CHIP_AMOUNT, STAR_AMOUNT, auth.userId]
      );
      auditLog(auth.username, 'RESTORE_BALANCE', { chips: CHIP_AMOUNT, stars: STAR_AMOUNT });
      console.warn(`[Restore] Admin ${auth.username} restored ${CHIP_AMOUNT.toLocaleString()} chips + ${STAR_AMOUNT.toLocaleString()} stars`);
      const playerId = playerSessions.get(socket.id)?.playerId || `user-${auth.userId}`;
      const progress = progressionManager.getProgress(playerId);
      if (progress) {
        progress.chips = (progress.chips || 0) + CHIP_AMOUNT;
        progress.stars = (progress.stars || 0) + STAR_AMOUNT;
      }
      socket.emit('adminRestoreBalanceResult', { success: true, chips: CHIP_AMOUNT, stars: STAR_AMOUNT });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('[adminRestoreBalance]', err);
      if (Sentry) Sentry.captureException(err, { tags: { area: 'chip.adminRestoreBalance' } });
      socket.emit('adminRestoreBalanceResult', { success: false, error: 'Server error' });
    }
  });

  socket.on('banUser', async (data: { userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !(await isUserAdmin(auth.userId))) {
      socket.emit('error', { message: 'Access denied' });
      return;
    }
    auditLog(auth.username, 'BAN_USER', { targetUserId: data.userId });
    banUserDB(data.userId);
    socket.emit('userBanned', { userId: data.userId });
  });

  socket.on('unbanUser', async (data: { userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !(await isUserAdmin(auth.userId))) {
      socket.emit('error', { message: 'Access denied' });
      return;
    }
    auditLog(auth.username, 'UNBAN_USER', { targetUserId: data.userId });
    unbanUserDB(data.userId);
    socket.emit('userUnbanned', { userId: data.userId });
  });

  // ========== End Admin Events ==========

  // ========== Club Events ==========

  socket.on('createClub', async (data: { name: string; description: string; settings?: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await createClub(auth.userId, data.name, data.description, data.settings || {});
    if (result.success) {
      socket.emit('clubCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('joinClub', async (data: { clubCode: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await joinClub(auth.userId, data.clubCode);
    if (result.success) {
      socket.emit('clubJoined', result);
      if (result.club && result.status === 'active') {
        await addActivity(result.club.id, 'member_join', { username: auth.username });
        await sendClubMessage(result.club.id, auth.userId, auth.username, `${auth.username} joined the club`, 'system');
      }
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('leaveClub', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await leaveClub(auth.userId, data.clubId);
    if (result.success) {
      socket.emit('clubLeft', { clubId: data.clubId });
      await addActivity(data.clubId, 'member_leave', { username: auth.username });
      await sendClubMessage(data.clubId, auth.userId, auth.username, `${auth.username} left the club`, 'system');
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getMyClubs', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('myClubs', { success: false, clubs: [] }); return; }
    const result = await getMyClubs(auth.userId);
    socket.emit('myClubs', result);
  });

  socket.on('getClubInfo', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    const result = await getClubInfo(data.clubId, auth?.userId);
    socket.emit('clubInfo', result);
  });

  socket.on('getClubMembers', async (data: { clubId: number }) => {
    const result = await getClubMembers(data.clubId);
    socket.emit('clubMembers', result);
  });

  socket.on('approveMember', async (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await approveMember(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberApproved', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('removeMember', async (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await removeMember(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberRemoved', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('promoteToManager', async (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await promoteToManager(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberPromoted', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('createClubTable', async (data: { clubId: number; config: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await createClubTable(auth.userId, data.clubId, data.config);
    if (result.success && result.table) {
      // Create a real table in the TableManager
      const clubInfoResult = await getClubInfo(data.clubId);
      const clubName = clubInfoResult.club?.name || 'Club';
      const variant = (result.table.variant || 'texas-holdem') as VariantType;
      const tableConfig = {
        tableName: `[${clubName}] ${result.table.tableName}`,
        smallBlind: result.table.smallBlind,
        bigBlind: result.table.bigBlind,
        ante: 0,
        minBuyIn: result.table.minBuyIn,
      };
      const tableId = variant === 'texas-holdem'
        ? tableManager.createTable(tableConfig)
        : tableManager.createVariantTable(tableConfig, variant);
      if (tableId) {
        await updateClubTableId(result.table.id, tableId);
        result.table.tableId = tableId;
      }
      socket.emit('clubTableCreated', { success: true, table: result.table });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubTables', async (data: { clubId: number }) => {
    const result = await getClubTables(data.clubId);
    socket.emit('clubTables', result);
  });

  socket.on('joinClubTable', async (data: { clubTableId: number; playerName: string; seatIndex: number; buyIn: number; avatar?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }

    const clubTable = await getClubTableById(data.clubTableId);
    if (!clubTable) { socket.emit('error', { message: 'Club table not found' }); return; }
    if (!(await isClubMember(clubTable.clubId, auth.userId))) {
      socket.emit('error', { message: 'You must be a club member to join this table' });
      return;
    }
    if (!clubTable.tableId) {
      socket.emit('error', { message: 'Table not yet created. Ask a manager to create it.' });
      return;
    }

    // Redirect to the standard joinTable handler by triggering the same event on this socket
    const listeners = socket.listeners('joinTable');
    if (listeners.length > 0) {
      (listeners[0] as Function)({
        tableId: clubTable.tableId,
        playerName: data.playerName,
        seatIndex: data.seatIndex,
        buyIn: data.buyIn,
        avatar: data.avatar,
      });
    }
  });

  socket.on('searchClubs', async (data: { query: string }) => {
    const result = await searchClubs(data.query || '');
    socket.emit('clubSearchResults', result);
  });

  socket.on('updateClubSettings', async (data: { clubId: number; settings: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await updateClubSettings(auth.userId, data.clubId, data.settings);
    if (result.success) {
      socket.emit('clubSettingsUpdated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('deleteClub', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await deleteClub(auth.userId, data.clubId);
    if (result.success) {
      socket.emit('clubDeleted', { clubId: data.clubId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ─── Club Chat & Messages ───

  socket.on('joinClubRoom', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) return;
    if (!(await isClubMember(data.clubId, auth.userId))) return;
    socket.join(`club:${data.clubId}`);
  });

  socket.on('leaveClubRoom', async (data: { clubId: number }) => {
    socket.leave(`club:${data.clubId}`);
  });

  socket.on('sendClubMessage', async (data: { clubId: number; message: string; type?: 'chat' | 'announcement' | 'system' }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    if (!(await isClubMember(data.clubId, auth.userId))) { socket.emit('error', { message: 'Not a club member' }); return; }

    // Rate limit: min 800ms between messages per socket (reuses lastChatTime map)
    const now = Date.now();
    const last = lastChatTime.get(socket.id) || 0;
    if (now - last < 800) {
      socket.emit('error', { message: 'Chat rate limited' });
      return;
    }
    lastChatTime.set(socket.id, now);

    // Validate message length
    const msgText = typeof data.message === 'string' ? data.message.trim().slice(0, 500) : '';
    if (!msgText) { socket.emit('error', { message: 'Empty message' }); return; }

    const msgType = data.type || 'chat';
    const result = await sendClubMessage(data.clubId, auth.userId, auth.username, msgText, msgType);
    if (result.success && result.message) {
      io.to(`club:${data.clubId}`).emit('clubMessage', result.message);
      if (msgType === 'announcement') {
        await addActivity(data.clubId, 'announcement', { username: auth.username, message: data.message });
      }
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubMessages', async (data: { clubId: number; limit?: number }) => {
    const result = await getClubMessages(data.clubId, data.limit || 50);
    socket.emit('clubMessages', result);
  });

  socket.on('getClubAnnouncements', async (data: { clubId: number }) => {
    const result = await getAnnouncements(data.clubId);
    socket.emit('clubAnnouncements', result);
  });

  socket.on('pinClubMessage', async (data: { clubId: number; messageId: number; pin: boolean }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = data.pin ? await pinMessage(data.clubId, data.messageId) : await unpinMessage(data.clubId, data.messageId);
    if (result.success) {
      io.to(`club:${data.clubId}`).emit('clubMessagePinned', { messageId: data.messageId, pinned: data.pin });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ─── Club Leaderboard & Stats ───

  socket.on('getClubLeaderboard', async (data: { clubId: number; period?: 'today' | 'week' | 'alltime' }) => {
    const result = await getClubLeaderboard(data.clubId, data.period || 'alltime');
    socket.emit('clubLeaderboard', result);
  });

  socket.on('getClubStatistics', async (data: { clubId: number }) => {
    const result = await getClubStatistics(data.clubId);
    socket.emit('clubStatistics', result);
  });

  // ─── Club Activity Feed ───

  socket.on('getClubActivity', async (data: { clubId: number; limit?: number }) => {
    const result = await getActivityFeed(data.clubId, data.limit || 20);
    socket.emit('clubActivity', result);
  });

  // ========== Club Tournaments ==========

  socket.on('createClubTournament', async (data: { clubId: number; config: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    // 2026-06-11 audit R13: signature is (clubId, managerId, config). This was
    // called (managerId, clubId, ...) — swapped — so getMemberRole(clubId=userId,
    // managerId=clubId) never matched, and EVERY owner/manager got "Only owners
    // and managers can create tournaments".
    const result = await createClubTournament(data.clubId, auth.userId, data.config);
    if (result.success) {
      socket.emit('clubTournamentCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubTournaments', async (data: { clubId: number }) => {
    const result = await getClubTournaments(data.clubId);
    socket.emit('clubTournaments', result);
  });

  socket.on('registerClubTournament', async (data: { tournamentId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await registerForClubTournament(data.tournamentId, auth.userId);
    if (result.success) {
      socket.emit('clubTournamentRegistered', { tournamentId: data.tournamentId, registered: result.registered });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('startClubTournament', async (data: { tournamentId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await startClubTournament(data.tournamentId, auth.userId);
    if (result.success) {
      socket.emit('clubTournamentStarted', { tournamentId: data.tournamentId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ========== Club Challenges ==========

  socket.on('createClubChallenge', async (data: { clubId: number; challengedId: number; stakes: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await createChallenge(data.clubId, auth.userId, data.challengedId, data.stakes);
    if (result.success) {
      socket.emit('clubChallengeCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('acceptClubChallenge', async (data: { challengeId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await acceptChallenge(data.challengeId, auth.userId);
    if (result.success) {
      socket.emit('clubChallengeAccepted', { challengeId: data.challengeId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('declineClubChallenge', async (data: { challengeId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await declineChallenge(data.challengeId, auth.userId);
    if (result.success) {
      socket.emit('clubChallengeDeclined', { challengeId: data.challengeId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubChallenges', async (data: { clubId: number }) => {
    const result = await getClubChallenges(data.clubId);
    socket.emit('clubChallenges', result);
  });

  // ========== Table Scheduling ==========

  socket.on('scheduleClubTable', async (data: { clubId: number; config: any; scheduledTime: string; recurring: boolean; recurrencePattern?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await scheduleTable(data.clubId, auth.userId, data.config, data.scheduledTime, data.recurring, data.recurrencePattern);
    if (result.success) {
      socket.emit('clubTableScheduled', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getScheduledClubTables', async (data: { clubId: number }) => {
    const result = await getScheduledTables(data.clubId);
    socket.emit('scheduledClubTables', result);
  });

  socket.on('activateScheduledClubTable', async (data: { id: number; clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await activateScheduledTable(data.id, auth.userId);
    if (result.success && result.tableConfig) {
      // Create the actual table
      const clubInfoResult = await getClubInfo(data.clubId);
      const clubName = clubInfoResult.club?.name || 'Club';
      const cfg = result.tableConfig;
      const variant = (cfg.variant || 'texas-holdem') as VariantType;
      const tableConfig = {
        tableName: `[${clubName}] ${cfg.tableName || 'Scheduled Table'}`,
        smallBlind: cfg.smallBlind || 25,
        bigBlind: cfg.bigBlind || 50,
        ante: 0,
        minBuyIn: cfg.minBuyIn || 1000,
      };
      const tableId = variant === 'texas-holdem'
        ? tableManager.createTable(tableConfig)
        : tableManager.createVariantTable(tableConfig, variant);
      socket.emit('scheduledClubTableActivated', { success: true, tableId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('deleteScheduledClubTable', async (data: { id: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await deleteScheduledTable(data.id, auth.userId);
    if (result.success) {
      socket.emit('scheduledClubTableDeleted', { id: data.id });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ========== Custom Blind Structures ==========

  socket.on('createBlindStructure', async (data: { clubId: number; name: string; levels: any[] }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }

    // Validate blind levels: SB > 0, BB >= 2*SB, ante >= 0, monotonically non-decreasing
    if (!Array.isArray(data.levels) || data.levels.length === 0 || data.levels.length > 30) {
      socket.emit('error', { message: 'Invalid blind structure' });
      return;
    }
    let prevBB = 0;
    for (const lvl of data.levels) {
      const sb = Number(lvl?.sb);
      const bb = Number(lvl?.bb);
      const ante = Number(lvl?.ante || 0);
      if (!Number.isInteger(sb) || !Number.isInteger(bb) || !Number.isInteger(ante)) {
        socket.emit('error', { message: 'Blind amounts must be integers' }); return;
      }
      if (sb <= 0 || bb < sb * 2 || ante < 0 || ante > sb) {
        socket.emit('error', { message: 'Invalid blind level (BB must be ≥ 2×SB, ante ≤ SB)' }); return;
      }
      if (bb < prevBB) {
        socket.emit('error', { message: 'Blinds must not decrease between levels' }); return;
      }
      prevBB = bb;
    }

    const result = await createBlindStructure(data.clubId, auth.userId, data.name, data.levels);
    if (result.success) {
      socket.emit('blindStructureCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getBlindStructures', async (data: { clubId: number }) => {
    const result = await getBlindStructures(data.clubId);
    socket.emit('blindStructures', result);
  });

  socket.on('deleteBlindStructure', async (data: { id: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await deleteBlindStructure(data.id, auth.userId);
    if (result.success) {
      socket.emit('blindStructureDeleted', { id: data.id });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ── Feature 10: Club Invitations ──

  socket.on('inviteToClub', async (data: { clubId: number; invitedUsername: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await inviteToClub(data.clubId, auth.userId, auth.username || '', data.invitedUsername);
    if (result.success) {
      socket.emit('invitationSent', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getMyInvitations', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('myInvitations', { success: false, invitations: [] }); return; }
    const result = await getMyInvitations(auth.userId);
    socket.emit('myInvitations', result);
  });

  socket.on('acceptInvitation', async (data: { invitationId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await acceptInvitation(data.invitationId, auth.userId);
    if (result.success) {
      socket.emit('invitationAccepted', result);
      socket.emit('myClubs', await getMyClubs(auth.userId));
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('declineInvitation', async (data: { invitationId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await declineInvitation(data.invitationId, auth.userId);
    if (result.success) {
      socket.emit('invitationDeclined', { invitationId: data.invitationId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ── Feature 11: Club Unions ──

  socket.on('createUnion', async (data: { clubId: number; name: string; description: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await createUnion(data.clubId, auth.userId, data.name, data.description);
    if (result.success) {
      socket.emit('unionCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getUnionInfo', async (data: { clubId: number }) => {
    const result = await getUnionInfo(data.clubId);
    socket.emit('unionInfo', result);
  });

  // ── Feature 12: Member Profiles ──

  socket.on('getMemberProfile', async (data: { clubId: number; userId: number }) => {
    const result = await getMemberProfile(data.clubId, data.userId);
    socket.emit('memberProfile', result);
  });

  // ── Feature 13: Club Badges ──

  socket.on('updateClubBadge', async (data: { clubId: number; badge: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await updateClubBadge(data.clubId, auth.userId, data.badge);
    if (result.success) {
      socket.emit('clubBadgeUpdated', { clubId: data.clubId, badge: data.badge });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ── Feature 14: Referral Rewards ──

  socket.on('generateReferralCode', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await generateReferralCode(data.clubId, auth.userId);
    socket.emit('referralCode', result);
  });

  socket.on('joinByReferral', async (data: { referralCode: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await joinByReferral(data.referralCode, auth.userId);
    if (result.success) {
      socket.emit('referralJoined', result);
      socket.emit('myClubs', await getMyClubs(auth.userId));
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getReferralStats', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = await getReferralStats(data.clubId, auth.userId);
    socket.emit('referralStats', result);
  });

  // ── Feature 15: Club Levels ──

  socket.on('getClubLevel', async (data: { clubId: number }) => {
    const result = await getClubLevel(data.clubId);
    socket.emit('clubLevel', result);
  });

  // ── Feature 16: Featured Clubs ──

  socket.on('getFeaturedClubs', async () => {
    const featured = await getFeaturedClubs();
    const clubOfWeek = await getClubOfWeek();
    socket.emit('featuredClubs', { ...featured, clubOfWeek: clubOfWeek.club || null });
  });

  // ========== End Club Events ==========

  socket.on('getTableList', async () => {
    const tables = tableManager.getTableList().map((t) => ({
      ...t,
      spectatorCount: spectators.get(t.tableId)?.size || 0,
    }));
    socket.emit('tableList', tables);
  });

  socket.on(
    'joinTable',
    (data: {
      tableId: string;
      playerName: string;
      seatIndex: number;
      buyIn: number;
      avatar?: string;
      expectedVariant?: string;
    }) => { (async () => {
      let { tableId, playerName, seatIndex, buyIn } = data;
      const table = tableManager.getTable(tableId);

      if (!table) {
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      // Variant sanity check — if the client told us which variant they
      // thought they were joining, refuse to seat them at a different one.
      // The list view passes `expectedVariant` from the table row the user
      // tapped; if the server has since converted the tableId (rebalance,
      // auto-combine, etc.) this protects the user from landing at a Draw
      // table when they meant Hold'em.
      //
      // Normalize aliases — base PokerTable defaults `variantId = 'holdem'`
      // while the lobby list ships `'texas-holdem'`. Treat them as equivalent
      // so a direct Hold'em join doesn't false-positive as a mismatch.
      if (data.expectedVariant) {
        const rawActual =
          (table as any).variantId ||
          (table as any).variant?.type ||
          'texas-holdem';
        const normalize = (v: string) => {
          const s = String(v || '').toLowerCase();
          if (s === 'holdem' || s === 'texas-holdem' || s === 'texasholdem' || s === 'texas_holdem') return 'texas-holdem';
          return s;
        };
        const actualVariant = normalize(rawActual);
        const expected = normalize(data.expectedVariant);
        if (actualVariant !== expected) {
          socket.emit('error', {
            message: `This table is now ${actualVariant}, not ${expected}. Refreshing the lobby.`,
            code: 'variant_mismatch',
            actualVariant,
          });
          return;
        }
      }

      // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.
      // A socket that did `spectate` → `joinTable` would remain in the
      // `spectators` Map AND get added to `playerSessions`. The next
      // broadcastGameState then ran both loops and emitted two `gameState`
      // events to the same socket — the second (spectator) emit carried
      // `yourCards: []` and clobbered the seated-player emit, so the user
      // saw their hole cards flicker / clear mid-hand. handlePlayerLeave
      // already scrubs spectators (line ~7750), but it early-returns when
      // there's no playerSessions entry — so a spectator-only socket
      // calling joinTable skipped that cleanup entirely. Scrub here BEFORE
      // any other state changes so every joinTable entrant exits cleanly.
      for (const [tid, s] of spectators) {
        if (s.delete(socket.id) && s.size === 0) spectators.delete(tid);
      }

      // If player already has a session, leave old table first
      const existingSession = playerSessions.get(socket.id);
      if (existingSession) {
        handlePlayerLeave(socket);
      }

      // Ghost-seat cleanup: stand up any other seat on this table held by
      // the same authenticated user via a prior socket / reserved entry.
      // Without this, disconnect+rejoin-at-new-seat leaves the old seat
      // occupied, producing the "3-of-me at the table" bug.
      const authForGhostClear = authSessions.get(socket.id);
      if (authForGhostClear) {
        clearGhostSeatsForUser(authForGhostClear.userId, tableId, socket.id);
      }

      // Auto-find seat if seatIndex is -1 or invalid
      if (seatIndex < 0 || seatIndex >= MAX_SEATS || table.seats[seatIndex].state !== 'empty') {
        // Find an empty seat first
        seatIndex = -1;
        for (let i = 0; i < MAX_SEATS; i++) {
          if (table.seats[i].state === 'empty') {
            seatIndex = i;
            break;
          }
        }
        // If no empty seat, try taking an AI seat
        if (seatIndex === -1) {
          for (let i = 0; i < MAX_SEATS; i++) {
            if (table.seats[i].state === 'occupied' && table.seats[i].isAI) {
              table.standUp(i);
              const profiles = aiProfiles.get(tableId);
              if (profiles) profiles.delete(i);
              seatIndex = i;
              break;
            }
          }
        }
        if (seatIndex === -1) {
          socket.emit('error', { message: 'No seats available' });
          return;
        }
      }

      // If chosen seat is occupied by AI, remove the AI first
      if (
        table.seats[seatIndex].state === 'occupied' &&
        table.seats[seatIndex].isAI
      ) {
        table.standUp(seatIndex);
        const profiles = aiProfiles.get(tableId);
        if (profiles) profiles.delete(seatIndex);
      }

      // Check if the authenticated user is banned before seating
      const authForJoin = authSessions.get(socket.id);
      if (authForJoin && await isUserBanned(authForJoin.userId)) {
        socket.emit('error', { message: 'Your account has been banned' });
        return;
      }

      // Sanitize playerName
      playerName = playerName.trim().slice(0, 30).replace(/[<>&"']/g, '');
      if (!playerName) {
        socket.emit('error', { message: 'Invalid player name' });
        return;
      }

      // Block same-IP multi-seating at the same table (collusion prevention)
      const tableSlotKey = `${tableId}`;
      if (!ipSeatedSlots.has(clientIp)) ipSeatedSlots.set(clientIp, new Set());
      const mySlots = ipSeatedSlots.get(clientIp)!;
      for (const slot of mySlots) {
        if (slot.endsWith(`:${tableSlotKey}`)) {
          socket.emit('error', { message: 'Another connection from your network is already seated at this table' });
          return;
        }
      }

      // 2026-06-11 audit C6: clamp the CLIENT-supplied buy-in. PokerTable.sitDown
      // only enforced the minimum, so a crafted joinTable payload could seat an
      // arbitrarily large stack, distorting table economics / SPR. (Not a mint —
      // it's the player's own wallet chips, deducted + credited back — but a
      // fairness issue.) TableConfig has no maxBuyIn field, so the cap is a
      // generous heuristic: 10× the table minimum. A missing/zero buy-in
      // defaults to the minimum.
      if (table) {
        const cap = table.config.minBuyIn * 10;
        buyIn = Math.max(table.config.minBuyIn, Math.min(buyIn || table.config.minBuyIn, cap));
      }

      // Validate buy-in against DB balance for authenticated users. In
      // testing mode, ensureChipsForBuyIn auto-tops-up below-buyin balances
      // so no one ever hits "Insufficient chips" while we're iterating.
      if (authForJoin) {
        const dbChips = await ensureChipsForBuyIn(authForJoin.userId, authForJoin.username, buyIn);
        if (buyIn > dbChips) {
          socket.emit('error', { message: 'Insufficient chips' });
          return;
        }
        if (!(await deductChips(authForJoin.userId, buyIn))) {
          socket.emit('error', { message: 'Could not deduct chips — try again' });
          return;
        }
        auditLog(authForJoin.username, 'BUY_IN_DEDUCT', { tableId, buyIn });
      }

      mySlots.add(`${socket.id}:${tableSlotKey}`);

      const playerId = `player-${uuidv4()}`;
      const success = table.sitDown(
        seatIndex,
        playerName,
        buyIn,
        playerId,
        false
      );

      if (!success) {
        // Roll back the chip deduction we did above — otherwise the player
        // is debited with no seat. Previously this path silently swallowed
        // the deducted chips.
        if (authForJoin) {
          try {
            await addChipsToUser(authForJoin.userId, buyIn);
            auditLog(authForJoin.username, 'BUY_IN_REFUND', { tableId, buyIn, reason: 'sitDown_failed' });
          } catch (e) {
            auditLog(authForJoin.username, 'BUY_IN_REFUND_FAILED', { tableId, buyIn, error: String(e) });
          }
        }
        mySlots.delete(`${socket.id}:${tableSlotKey}`);
        socket.emit('error', { message: 'Could not sit down at that seat' });
        return;
      }

      // Track session
      const session: PlayerSession = {
        socketId: socket.id,
        tableId,
        seatIndex,
        playerName,
        playerId,
        trainingEnabled: false,
        sittingOut: false,
        avatar: data.avatar || undefined,
      };
      playerSessions.set(socket.id, session);

      // Initialize progression (userId → hydrate xp/level/achievements from DB)
      progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
      ensureTableProgressListener(table, tableId);

      // Join socket room for table
      socket.join(`table:${tableId}`);

      // Fill empty seats with AI
      fillWithAI(table, tableId);

      // Auto-start hand if not in progress
      if (!table.isHandInProgress() && table.getOccupiedSeatCount() >= 2) {
        table.startNewHand();
      }

      // Send current state and progress
      socket.emit(
        'gameState',
        getGameStateForPlayer(table, seatIndex, session.trainingEnabled)
      );
      sendProgressToPlayer(socket.id);

      // Broadcast updated state to all players at table
      broadcastGameState(tableId);

      // Schedule AI if it's an AI's turn
      scheduleAIAction(tableId);
    })(); }
  );

  socket.on(
    'quickPlay',
    (data: { playerName: string; avatar?: string }) => { (async () => {
      const { playerName } = data;

      // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.
      // See joinTable handler above for the full rationale — same bug
      // applies to quickPlay because handlePlayerLeave early-returns
      // for spectator-only sockets.
      for (const [tid, s] of spectators) {
        if (s.delete(socket.id) && s.size === 0) spectators.delete(tid);
      }

      // If the player already has a session on a table, leave it first
      const existingSession = playerSessions.get(socket.id);
      if (existingSession) {
        handlePlayerLeave(socket);
      }

      const tables = tableManager.getTableList();

      // Quick Play prefers Texas Hold'em tables. Sort: holdem first,
      // then by player count, then by smallest blinds.
      // STRICT: Use the variant field the list already serializes
      // (getTableList populates this from the concrete subclass via
      // `variant.type` / `variantId` depending on the class). Relying on
      // live-instance `.variantId` was fragile — only some subclasses set
      // that property, so a Five-Card-Draw or heads-up table (base PokerTable
      // with no variantId) passed the old `!id || === 'texas-holdem'` check
      // and Quick Play happily seated Hold'em players at Draw games.
      const isHoldem = (t: any) => t?.variant === 'texas-holdem';
      const sorted = [...tables].sort((a, b) => {
        const ah = isHoldem(a), bh = isHoldem(b);
        if (ah !== bh) return ah ? -1 : 1;
        if (a.playerCount !== b.playerCount)
          return a.playerCount - b.playerCount;
        return a.smallBlind - b.smallBlind;
      });

      if (sorted.length === 0) {
        socket.emit('error', { message: 'No tables available' });
        return;
      }

      // Race-safe seat selection with retry across candidate tables — walk
      // the sorted list until we find one where we can ATOMICALLY claim a
      // seat. Previous implementation picked a seat and then sat down a few
      // statements later, so two simultaneous quickPlay calls could both
      // pick the same empty seat and the second one silently failed.
      let chosen: { tableId: string; table: any; targetSeat: number } | null = null;
      for (const candidate of sorted) {
        const table = tableManager.getTable(candidate.tableId);
        if (!table) continue;
        let targetSeat = -1;
        for (let i = 0; i < MAX_SEATS; i++) {
          if (table.seats[i].state === 'empty') { targetSeat = i; break; }
        }
        if (targetSeat === -1) {
          for (let i = 0; i < MAX_SEATS; i++) {
            if (table.seats[i].state === 'occupied' && table.seats[i].isAI) {
              table.standUp(i);
              const profiles = aiProfiles.get(candidate.tableId);
              if (profiles) profiles.delete(i);
              targetSeat = i;
              break;
            }
          }
        }
        if (targetSeat === -1) continue;
        // Re-check right before commit — if another call has already claimed
        // this seat since we found it, try the next table.
        if (table.seats[targetSeat].state !== 'empty') continue;
        chosen = { tableId: candidate.tableId, table, targetSeat };
        break;
      }
      if (!chosen) {
        socket.emit('error', { message: 'No seats available' });
        return;
      }
      const { tableId: chosenTableId, table, targetSeat } = chosen;

      // Server-authoritative buy-in = table minimum. For authenticated users
      // we validate balance and deduct; anonymous users still get free chips
      // (legacy Quick Play behavior, preserved so unauthed demo play works).
      // Testing mode auto-tops-up via ensureChipsForBuyIn.
      const authForJoin = authSessions.get(socket.id);
      const buyIn = table.config.minBuyIn;
      let chipsDeducted = false;
      if (authForJoin) {
        const dbChips = await ensureChipsForBuyIn(authForJoin.userId, authForJoin.username, buyIn);
        if (buyIn > dbChips) {
          socket.emit('error', { message: 'Insufficient chips' });
          return;
        }
        if (!(await deductChips(authForJoin.userId, buyIn))) {
          socket.emit('error', { message: 'Could not deduct chips — try again' });
          return;
        }
        chipsDeducted = true;
        auditLog(authForJoin.username, 'QUICKPLAY_BUY_IN_DEDUCT', { tableId: chosenTableId, buyIn });
      }

      const playerId = `player-${uuidv4()}`;
      // Ghost-seat defense (quickplay path): same invariant as the main
      // joinTable handler. Prevents a prior socket's seat on this table
      // from lingering when the user comes back via quickplay.
      {
        const authNow = authSessions.get(socket.id);
        if (authNow) clearGhostSeatsForUser(authNow.userId, chosenTableId, socket.id, targetSeat);
      }
      const success = table.sitDown(
        targetSeat,
        playerName,
        buyIn,
        playerId,
        false
      );

      if (!success) {
        // Roll back deduction if the commit-time seat check failed.
        if (chipsDeducted && authForJoin) {
          try {
            await addChipsToUser(authForJoin.userId, buyIn);
            auditLog(authForJoin.username, 'QUICKPLAY_REFUND', { tableId: chosenTableId, buyIn, reason: 'sitDown_failed' });
          } catch (e) {
            // Refund failed AFTER the deduction succeeded. The user now
            // owes `buyIn` that the DB didn't credit back. Don't swallow —
            // log + audit loud so an operator can manually restore. Matches
            // the joinTable path's error handling at ~line 4255.
            console.error(`[Buy-in] QUICKPLAY_REFUND failed for userId=${authForJoin.userId}, amount=${buyIn}:`, e);
            if (Sentry) Sentry.captureException(e, { tags: { area: 'chip.quickplayRefund' }, extra: { userId: authForJoin.userId, buyIn } });
            auditLog(authForJoin.username, 'QUICKPLAY_REFUND_FAILED', { tableId: chosenTableId, buyIn, error: String(e) });
          }
        }
        socket.emit('error', { message: 'Could not join table' });
        return;
      }

      const session: PlayerSession = {
        socketId: socket.id,
        tableId: chosenTableId,
        seatIndex: targetSeat,
        playerName,
        playerId,
        trainingEnabled: false,
        sittingOut: false,
        avatar: data.avatar || undefined,
      };
      playerSessions.set(socket.id, session);
      socket.join(`table:${chosenTableId}`);

      // Initialize progression (userId → hydrate xp/level/achievements from DB)
      progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
      ensureTableProgressListener(table, chosenTableId);

      // Fill with AI
      fillWithAI(table, chosenTableId);

      // Auto-start hand if not in progress
      const inProgress = table.isHandInProgress();
      const occupied = table.getOccupiedSeatCount();
      // 2026-05-12 audit: throttled to debug, was console.log
      log.debug(`[QP] inProgress=${inProgress}, occupied=${occupied}, phase=${table.currentPhase}`);
      if (!inProgress && occupied >= 2) {
        const started = table.startNewHand();
        // 2026-05-12 audit: throttled to debug, was console.log
        log.debug(`[QP] startNewHand result: ${started}, phase now: ${table.currentPhase}, cards: ${table.seats[targetSeat].holeCards.length}`);
      }

      socket.emit(
        'gameState',
        getGameStateForPlayer(table, targetSeat)
      );
      broadcastGameState(chosenTableId);
      sendProgressToPlayer(socket.id);

      // Schedule AI if it's an AI's turn
      scheduleAIAction(chosenTableId);
    })(); }
  );

  /**
   * (placeholder — inline helpers live below)
   */

  // ───── Persistence sweep: socket handlers ──────────────────────────────────
  // Server-authoritative shop prices. Client cannot influence cost.
  const SHOP_PRICES: Record<string, Record<string, number>> = {
    // Card backs
    card_back: {
      classic_red: 0, royal_blue: 0,
      gold_premium: 500, neon_green: 500, silver_foil: 400,
      holographic: 800, dragon: 1200, phoenix: 1500,
      diamond_pattern: 2000, mythic: 5000,
    },
    // Table themes — moved off the broken "Browse Table Themes" modal
    // flow and into the main shop grid.
    theme: {
      classic_blue: 0, green_felt: 0,
      midnight_purple: 300, ocean_breeze: 400, casino_royale: 500,
      neon_vegas: 600, carbon_black: 700, royal_gold: 800,
      cherry_wood: 900, cosmic_nebula: 1500,
    },
    // Avatar frames
    frame: {
      bronze: 500, silver: 1000, gold: 2000, diamond: 5000,
      flame: 6000, ice: 6000, crown: 10000, platinum: 8000, mythic: 15000,
    },
    // Emotes
    emote: {
      nice_hand: 150, good_game: 150, well_played: 150,
      thumbs_up: 150, clap: 200, love: 250,
      big_brain: 200, money: 200, fire: 250,
      tears: 250, rocket: 300, crown: 400,
      sunglasses: 200, laughing: 200, surprised: 200,
      dead: 300, think: 300, poker_face: 400,
      mic_drop: 500, trophy: 600,
    },
    // Celebrations
    celebration: {
      confetti: 400, chip_rain: 800, fireworks: 1200, lightning: 1500,
      golden_shower: 2000, dragon_breath: 3000, cosmic_burst: 4000, supernova: 6000,
    },
    // Sound packs
    sound_pack: {
      silent_mode: 100, classic_casino: 300, vegas_casino: 300,
      old_school: 500, cyberpunk: 750, fantasy: 1000,
    },
    // Player titles
    title: {
      nitwit: 300, calling_station: 400, grinder: 500,
      river_rat: 600, chip_leader: 700, degenerate: 700,
      the_shark: 800, bad_beat_survivor: 800, final_table: 1000,
      bluff_master: 1200, all_in_legend: 1500, phantom: 1500,
      tournament_champ: 2000, royal: 3000, godmode: 8000,
    },
    // Chip packs — stars → chips conversion
    chip_pack: {
      refill: 50, small: 100, medium: 300, big: 600,
      pro: 1500, whale: 3000, kingpin: 6000, emperor: 12000,
    },
    // Mystery boxes — random reward
    mystery_box: {
      basic: 500, premium: 2000, legendary: 8000,
    },
    // Chip skins — how your chips look in your seat stack visual
    chip_skin: {
      classic: 0, crimson: 400, cobalt: 500, emerald: 600,
      amethyst: 800, gold_rimmed: 1200, neon: 1800, holographic: 2500, mythic: 4000,
    },
    // Card front designs — alt faces for your cards (hero only; others see default)
    card_front: {
      standard: 0, minimal: 400, retro: 600, modern: 800,
      futuristic: 1200, luxury: 1800, hanafuda: 2200, artistic: 2800,
    },
    // Dealer voice packs — audio pack for dealer callouts
    dealer_voice: {
      standard: 0, vegas_vet: 600, british_butler: 800,
      pirate: 900, robot: 1100, sportscaster: 1400, celebrity: 2200, mythic_sage: 4000,
    },
    // Profile backgrounds — the backdrop behind your avatar in the lobby
    profile_bg: {
      default: 0, sunset: 200, city_lights: 350, deep_space: 500,
      aurora: 700, volcano: 900, underwater: 1100, cherry_blossom: 1400, diamond_rain: 2500,
    },
    // XP & chip boosters (consumable — expiry handled server-side)
    booster: {
      xp_2x_15m: 200, xp_2x_1h: 600, xp_2x_1d: 2500,
      chip_1p5x_1h: 400, chip_1p5x_1d: 2000,
    },
    // VIP passes — future-use flag, gates premium-only perks
    vip_pass: {
      daily: 300, weekly: 1500, monthly: 5000, lifetime: 50000,
    },
    // Bundles — single-purchase multi-item grants. See BUNDLE_CONTENTS below.
    bundle: {
      starter:       800,    // 3 items
      collector:     2500,   // 5 items
      tournament:    4000,   // 6 items + chip pack
      whale_bundle:  10000,  // 8 items + chip pack
      mythic_bundle: 25000,  // everything mythic-tier
    },
  };
  const CHIP_PACK_PAYOUT: Record<string, number> = {
    refill: 10000, small: 25000, medium: 100000, big: 250000,
    pro: 750000, whale: 2000000, kingpin: 5000000, emperor: 15000000,
  };

  // Bundle contents: what items a single purchase grants.
  // Each entry is an array of [itemType, itemId] tuples. If the user
  // already owns any item, a 25% pro-rata stars refund is credited for
  // each duplicate.
  const BUNDLE_CONTENTS: Record<string, Array<[string, string]>> = {
    starter: [
      ['card_back', 'silver_foil'],
      ['emote', 'nice_hand'],
      ['frame', 'bronze'],
    ],
    collector: [
      ['card_back', 'gold_premium'],
      ['theme', 'casino_royale'],
      ['frame', 'silver'],
      ['emote', 'crown'],
      ['celebration', 'chip_rain'],
    ],
    tournament: [
      ['title', 'tournament_champ'],
      ['theme', 'royal_gold'],
      ['frame', 'gold'],
      ['card_back', 'holographic'],
      ['celebration', 'fireworks'],
      ['emote', 'trophy'],
    ],
    whale_bundle: [
      ['theme', 'cosmic_nebula'],
      ['card_back', 'diamond_pattern'],
      ['frame', 'diamond'],
      ['celebration', 'golden_shower'],
      ['emote', 'mic_drop'],
      ['title', 'royal'],
      ['sound_pack', 'fantasy'],
      ['dealer_voice', 'celebrity'],
    ],
    mythic_bundle: [
      ['card_back', 'mythic'],
      ['frame', 'mythic'],
      ['title', 'godmode'],
      ['celebration', 'supernova'],
      ['chip_skin', 'mythic'],
      ['card_front', 'artistic'],
      ['dealer_voice', 'mythic_sage'],
      ['profile_bg', 'diamond_rain'],
      ['theme', 'cosmic_nebula'],
    ],
  };

  // Booster durations in ms (for consumable activation record)
  const BOOSTER_DURATION: Record<string, { kind: 'xp' | 'chip'; mult: number; ms: number }> = {
    xp_2x_15m:    { kind: 'xp',   mult: 2,   ms: 15 * 60 * 1000 },
    xp_2x_1h:     { kind: 'xp',   mult: 2,   ms: 60 * 60 * 1000 },
    xp_2x_1d:     { kind: 'xp',   mult: 2,   ms: 24 * 60 * 60 * 1000 },
    chip_1p5x_1h: { kind: 'chip', mult: 1.5, ms: 60 * 60 * 1000 },
    chip_1p5x_1d: { kind: 'chip', mult: 1.5, ms: 24 * 60 * 60 * 1000 },
  };

  // VIP pass durations
  const VIP_PASS_DURATION: Record<string, number> = {
    daily:    24 * 60 * 60 * 1000,
    weekly:   7  * 24 * 60 * 60 * 1000,
    monthly:  30 * 24 * 60 * 60 * 1000,
    lifetime: 100 * 365 * 24 * 60 * 60 * 1000,
  };

  // Lazy hydration — first socket call after auth hydrates player progress from DB.
  async function ensureHydrated(s: Socket): Promise<{ userId: number; playerId: string; username: string } | null> {
    const auth = authSessions.get(s.id);
    if (!auth) return null;
    const playerId = playerSessions.get(s.id)?.playerId || `user-${auth.userId}`;
    const progress = progressionManager.getOrCreateProgress(playerId, auth.username);
    // Await hydration fully. Previously we only checked `!progress.userId`
    // which returns false the instant hydrateFromDB sets userId at the top
    // of its function, but `hydrated=true` isn't set until the very end
    // after all DB reads complete. That race window was enough for a
    // caller to mutate in-memory values (stars/xp/etc.) and then write
    // them to DB via a non-gated path, clobbering real data. Now we
    // always await hydrateFromDB — it's idempotent (early-returns if
    // already hydrated for this userId) so this is cheap.
    if (!progress.hydrated || progress.userId !== auth.userId) {
      await progressionManager.hydrateFromDB(playerId, auth.userId);
    }
    return { userId: auth.userId, playerId, username: auth.username };
  }

  // Shop: purchase an item. Deducts stars (or chips for chip_pack), inventory-inserts, emits update.
  socket.on('purchaseShopItem', async (data: { itemType: string; itemId: string }) => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) { socket.emit('purchaseResult', { success: false, error: 'Not authenticated' }); return; }
      const { itemType, itemId } = data || {};
      const prices = SHOP_PRICES[itemType];
      if (!prices || prices[itemId] == null) {
        socket.emit('purchaseResult', { success: false, error: 'Unknown item' });
        return;
      }
      const cost = prices[itemId];
      const progress = progressionManager.getProgress(ctx.playerId)!;
      if (progress.stars < cost) {
        socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
        return;
      }

      // Chip pack: spend stars → credit chips. No inventory row.
      if (itemType === 'chip_pack') {
        const payout = CHIP_PACK_PAYOUT[itemId] || 0;
        const ok = await deductStars(ctx.userId, cost);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: -cost, path: 'shop_chip_pack' });
          socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
          return;
        }
        // 2026-06-19 fix: the two DB ops aren't a single transaction, so if the
        // chip credit fails AFTER stars are already deducted, refund the stars
        // (otherwise: stars lost, no chips). Update the in-memory mirror only
        // after BOTH DB ops succeed.
        const credited = await addChipsToUser(ctx.userId, payout).catch(() => false);
        if (!credited) {
          try { await addStarsToUser(ctx.userId, cost); } catch { /* logged below */ }
          auditLog('SYSTEM', 'CHIP_PACK_CREDIT_FAILED_REFUND', { userId: ctx.userId, cost, payout });
          socket.emit('purchaseResult', { success: false, error: 'Purchase failed — stars refunded' });
          sendProgressToPlayer(socket.id);
          return;
        }
        progress.stars -= cost;
        progress.chips += payout;
        socket.emit('purchaseResult', { success: true, itemType, itemId, cost, payout });
        sendProgressToPlayer(socket.id);
        return;
      }

      // Mystery box: spend stars → roll a random reward (chips / stars
      // refund / cosmetic). Tier determines loot quality.
      if (itemType === 'mystery_box') {
        const ok = await deductStars(ctx.userId, cost);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: -cost, path: 'shop_mystery_box' });
          socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
          return;
        }
        progress.stars -= cost;

        const tierTable: Record<string, { chips: [number, number]; stars: [number, number]; itemPool?: Array<{ type: string; id: string }> }> = {
          basic: {
            chips: [5000, 25000], stars: [50, 150],
            itemPool: [
              { type: 'emote', id: 'nice_hand' }, { type: 'emote', id: 'fire' },
              { type: 'sound_pack', id: 'classic_casino' },
            ],
          },
          premium: {
            chips: [25000, 150000], stars: [200, 600],
            itemPool: [
              { type: 'frame', id: 'silver' }, { type: 'celebration', id: 'chip_rain' },
              { type: 'title', id: 'the_shark' }, { type: 'card_back', id: 'holographic' },
            ],
          },
          legendary: {
            chips: [150000, 1000000], stars: [800, 2500],
            itemPool: [
              { type: 'frame', id: 'diamond' }, { type: 'celebration', id: 'supernova' },
              { type: 'title', id: 'royal' }, { type: 'card_back', id: 'mythic' },
            ],
          },
        };
        const tier = tierTable[itemId] || tierTable.basic;
        const roll = Math.random();
        let payload: any = {};
        if (roll < 0.5) {
          // 50% chips
          const amt = Math.floor(tier.chips[0] + Math.random() * (tier.chips[1] - tier.chips[0]));
          progress.chips += amt;
          await addChipsToUser(ctx.userId, amt);
          payload = { kind: 'chips', amount: amt };
        } else if (roll < 0.8) {
          // 30% stars refund
          const amt = Math.floor(tier.stars[0] + Math.random() * (tier.stars[1] - tier.stars[0]));
          const ok = await addStarsToUser(ctx.userId, amt);
          if (!ok) {
            auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: amt, path: 'shop_mystery_box_refund' });
          }
          progress.stars += amt;
          payload = { kind: 'stars', amount: amt };
        } else if (tier.itemPool && tier.itemPool.length > 0) {
          // 20% cosmetic item
          const pick = tier.itemPool[Math.floor(Math.random() * tier.itemPool.length)];
          const granted = await dbGrantItem(ctx.userId, pick.type, pick.id);
          if (granted) {
            payload = { kind: 'item', itemType: pick.type, itemId: pick.id };
            const inv = await loadInventory(ctx.userId);
            socket.emit('inventoryUpdated', { inventory: inv });
          } else {
            // Duplicate — refund equivalent stars.
            const refund = Math.floor(cost * 0.4);
            const ok = await addStarsToUser(ctx.userId, refund);
            if (!ok) {
              auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: refund, path: 'shop_mystery_box_dup_refund' });
            }
            progress.stars += refund;
            payload = { kind: 'stars', amount: refund, reason: 'duplicate_refund' };
          }
        } else {
          payload = { kind: 'chips', amount: 0 };
        }

        socket.emit('purchaseResult', { success: true, itemType, itemId, cost, mysteryReward: payload });
        sendProgressToPlayer(socket.id);
        return;
      }

      // Bundle: multi-item grant in a single purchase. Duplicates refund
      // pro-rata stars so the user isn't penalized for partial overlap.
      if (itemType === 'bundle') {
        const contents = BUNDLE_CONTENTS[itemId] || [];
        if (contents.length === 0) {
          socket.emit('purchaseResult', { success: false, error: 'Unknown bundle' });
          return;
        }
        const deducted = await deductStars(ctx.userId, cost);
        if (!deducted) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: -cost, path: 'shop_bundle' });
          socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
          return;
        }
        progress.stars -= cost;
        const grantedItems: Array<[string, string]> = [];
        let duplicates = 0;
        for (const [t, id] of contents) {
          const ok = await dbGrantItem(ctx.userId, t, id);
          if (ok) grantedItems.push([t, id]);
          else duplicates++;
        }
        // Refund 25% of bundle cost per duplicate, averaged over item count.
        if (duplicates > 0) {
          const refund = Math.floor((cost * 0.25 * duplicates) / contents.length);
          if (refund > 0) {
            const refunded = await addStarsToUser(ctx.userId, refund);
            if (!refunded) {
              auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: refund, path: 'shop_bundle_dup_refund' });
            }
          }
          progress.stars += refund;
        }
        socket.emit('purchaseResult', {
          success: true, itemType, itemId, cost,
          bundleGranted: grantedItems, bundleDuplicates: duplicates,
        });
        const inv = await loadInventory(ctx.userId);
        socket.emit('inventoryUpdated', { inventory: inv });
        sendProgressToPlayer(socket.id);
        return;
      }

      // Booster (XP / chip multiplier): consumable with expiry. Applied
      // to the in-memory progress; future hands respect the multiplier.
      // Persistence is best-effort — a server restart clears boosters
      // (acceptable trade-off given short durations).
      if (itemType === 'booster') {
        const b = BOOSTER_DURATION[itemId];
        if (!b) {
          socket.emit('purchaseResult', { success: false, error: 'Unknown booster' });
          return;
        }
        const ok = await deductStars(ctx.userId, cost);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: -cost, path: 'shop_booster' });
          socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
          return;
        }
        progress.stars -= cost;
        const expiresAt = Date.now() + b.ms;
        (progress as any).activeBoosters = (progress as any).activeBoosters || {};
        (progress as any).activeBoosters[b.kind] = { mult: b.mult, expiresAt };
        socket.emit('purchaseResult', {
          success: true, itemType, itemId, cost,
          booster: { kind: b.kind, mult: b.mult, expiresAt },
        });
        sendProgressToPlayer(socket.id);
        return;
      }

      // VIP pass: timed premium flag; gates future premium-only perks.
      if (itemType === 'vip_pass') {
        const ms = VIP_PASS_DURATION[itemId];
        if (!ms) {
          socket.emit('purchaseResult', { success: false, error: 'Unknown VIP pass' });
          return;
        }
        const ok = await deductStars(ctx.userId, cost);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: -cost, path: 'shop_vip_pass' });
          socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
          return;
        }
        progress.stars -= cost;
        const current = (progress as any).vipExpiresAt || 0;
        const base = Math.max(Date.now(), current);
        (progress as any).vipExpiresAt = base + ms;
        socket.emit('purchaseResult', {
          success: true, itemType, itemId, cost,
          vipExpiresAt: (progress as any).vipExpiresAt,
        });
        sendProgressToPlayer(socket.id);
        return;
      }

      // Cosmetic: deduct stars + insert into inventory.
      const granted = await dbGrantItem(ctx.userId, itemType, itemId);
      if (!granted) {
        socket.emit('purchaseResult', { success: false, error: 'Already owned' });
        return;
      }
      const ok = await deductStars(ctx.userId, cost);
      if (!ok) {
        auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: -cost, path: 'shop_cosmetic' });
        socket.emit('purchaseResult', { success: false, error: 'Not enough stars' });
        return;
      }
      progress.stars -= cost;
      socket.emit('purchaseResult', { success: true, itemType, itemId, cost });
      // Push updated inventory snapshot too
      const inv = await loadInventory(ctx.userId);
      socket.emit('inventoryUpdated', { inventory: inv });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('purchaseShopItem error:', err);
      socket.emit('purchaseResult', { success: false, error: 'Server error' });
    }
  });

  // Shop: equip an owned item (unequips siblings of same type).
  socket.on('equipItem', async (data: { itemType: string; itemId: string }) => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) return;
      const { itemType, itemId } = data || {};
      const ok = await dbEquipItem(ctx.userId, itemType, itemId);
      socket.emit('equipResult', { success: ok, itemType, itemId, error: ok ? undefined : 'not_owned' });
      if (ok) {
        const inv = await loadInventory(ctx.userId);
        socket.emit('inventoryUpdated', { inventory: inv });
      }
    } catch (err: any) {
      console.error('equipItem error:', err);
    }
  });

  // Return the full inventory snapshot — called on login to hydrate the shop UI.
  socket.on('getInventory', async () => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) return;
      const inv = await loadInventory(ctx.userId);
      socket.emit('inventoryUpdated', { inventory: inv });
    } catch (err: any) {
      console.error('getInventory error:', err);
    }
  });

  // Daily login reward — real server-validated claim, awards actual stars+chips.
  socket.on('claimDailyLogin', async () => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) { socket.emit('dailyLoginClaimed', { success: false, error: 'Not authenticated' }); return; }

      if (await hasClaimedToday(ctx.userId, 'login')) {
        socket.emit('dailyLoginClaimed', { success: false, error: 'already_claimed' });
        return;
      }

      const durable = await loadDurableProgress(ctx.userId);
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const prev = durable?.lastLoginClaimDate;
      let newStreak: number;
      if (prev === yesterday) newStreak = (durable!.loginStreak || 0) + 1;
      else                    newStreak = 1;
      // Cap the streak display cycle at 7
      const day = ((newStreak - 1) % 7) + 1;

      // Reward table: Days 1-3 chips only; 4→+5⭐; 5→+10⭐; 6→+20⭐; 7→+50⭐
      const CHIPS_BY_DAY = [0, 1000, 2000, 3000, 5000, 7500, 10000, 20000];
      const STARS_BY_DAY = [0,    0,    0,    0,    5,   10,    20,    50];
      const chips = CHIPS_BY_DAY[day] || 0;
      const stars = STARS_BY_DAY[day] || 0;

      const progress = progressionManager.getProgress(ctx.playerId)!;
      progress.chips += chips;
      progress.stars += stars;
      progress.dailyLoginStreak = newStreak;

      if (chips > 0) await addChipsToUser(ctx.userId, chips);
      if (stars > 0) {
        const ok = await addStarsToUser(ctx.userId, stars);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: stars, path: 'daily_login' });
        }
      }
      await updateLoginStreak(ctx.userId, newStreak);
      await recordDailyClaim(ctx.userId, 'login', { day, chips, stars });

      socket.emit('dailyLoginClaimed', { success: true, day, streak: newStreak, chips, stars });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('claimDailyLogin error:', err);
      socket.emit('dailyLoginClaimed', { success: false, error: 'server_error' });
    }
  });

  // 2026-06-12 — Unlimited "broke refill". A player who has lost their bankroll
  // (under the cheapest cash table's 5,000 min buy-in) can claim +5,000 to keep
  // playing — unlimited, but ONLY when broke. You cannot stockpile: each refill
  // is just enough for one low-stakes buy-in, and you can't claim again until
  // you're under 5,000 again. This is NOT the farmable UNLIMITED_CHIPS_TESTING
  // faucet (which tops up to 50k and is off in prod). Server-authoritative grant.
  socket.on('claimRefill', async () => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) { socket.emit('refillResult', { success: false, error: 'Not authenticated' }); return; }
      const REFILL_THRESHOLD = 5000; // = cheapest cash table min buy-in
      const REFILL_AMOUNT = 5000;
      const current = await getUserChips(ctx.userId);
      if (current >= REFILL_THRESHOLD) {
        socket.emit('refillResult', { success: false, error: 'not_broke', chips: current });
        return;
      }
      const ok = await addChipsToUser(ctx.userId, REFILL_AMOUNT);
      if (!ok) { socket.emit('refillResult', { success: false, error: 'grant_failed' }); return; }
      const newBalance = current + REFILL_AMOUNT;
      try { const p = progressionManager.getProgress(ctx.playerId); if (p) p.chips += REFILL_AMOUNT; } catch {}
      const uname = authSessions.get(socket.id)?.username || String(ctx.userId);
      auditLog(uname, 'BROKE_REFILL', { old: current, added: REFILL_AMOUNT, newBalance });
      socket.emit('refillResult', { success: true, added: REFILL_AMOUNT, chips: newBalance });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('claimRefill error:', err);
      socket.emit('refillResult', { success: false, error: 'server_error' });
    }
  });

  // Daily spin — server-validated one-per-day with stars included in reward table.
  socket.on('claimDailySpinServer', async () => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) { socket.emit('dailySpinClaimed', { success: false, error: 'Not authenticated' }); return; }

      if (await hasClaimedToday(ctx.userId, 'spin')) {
        socket.emit('dailySpinClaimed', { success: false, error: 'already_claimed' });
        return;
      }

      // Reward roll: 5% big stars, 20% small stars, 50% chips, 25% big chips.
      const roll = Math.random();
      let reward: { chips: number; stars: number; label: string };
      if (roll < 0.05) reward = { chips: 0, stars: 100, label: '💰 100 stars!' };
      else if (roll < 0.25) reward = { chips: 0, stars: 25, label: '⭐ 25 stars' };
      else if (roll < 0.75) reward = { chips: 2500, stars: 0, label: '2,500 chips' };
      else                  reward = { chips: 10000, stars: 0, label: '🎰 10,000 chips' };

      const progress = progressionManager.getProgress(ctx.playerId)!;
      progress.chips += reward.chips;
      progress.stars += reward.stars;
      if (reward.chips > 0) await addChipsToUser(ctx.userId, reward.chips);
      if (reward.stars > 0) {
        const ok = await addStarsToUser(ctx.userId, reward.stars);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: reward.stars, path: 'daily_spin' });
        }
      }
      await recordDailyClaim(ctx.userId, 'spin', reward);

      socket.emit('dailySpinClaimed', { success: true, reward });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('claimDailySpinServer error:', err);
      socket.emit('dailySpinClaimed', { success: false, error: 'server_error' });
    }
  });

  // Scratch card — consume from user's banked inventory, reveal reward.
  socket.on('claimScratchCard', async () => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) { socket.emit('scratchCardRevealed', { success: false, error: 'Not authenticated' }); return; }

      const consumed = await consumeScratchCard(ctx.userId);
      if (!consumed) {
        socket.emit('scratchCardRevealed', { success: false, error: 'no_cards_available' });
        return;
      }

      // Reward roll: 20% stars, 10% cosmetic surprise, 70% chips.
      const roll = Math.random();
      let reward: { chips?: number; stars?: number; item?: { type: string; id: string }; label: string };
      if (roll < 0.20) {
        const amt = 10 + Math.floor(Math.random() * 40);
        reward = { stars: amt, label: `⭐ ${amt} stars` };
      } else if (roll < 0.30) {
        // Grant a cheap surprise emote
        const pool = ['nice_hand', 'good_game', 'fire', 'crown'];
        const id = pool[Math.floor(Math.random() * pool.length)];
        await dbGrantItem(ctx.userId, 'emote', id);
        reward = { item: { type: 'emote', id }, label: `🎁 Emote: ${id}` };
      } else {
        const amt = 1000 + Math.floor(Math.random() * 9000);
        reward = { chips: amt, label: `🪙 ${amt.toLocaleString()} chips` };
      }

      const progress = progressionManager.getProgress(ctx.playerId)!;
      if (reward.chips) {
        progress.chips += reward.chips;
        await addChipsToUser(ctx.userId, reward.chips);
      }
      if (reward.stars) {
        const ok = await addStarsToUser(ctx.userId, reward.stars);
        if (!ok) {
          auditLog('SYSTEM', 'STARS_WRITE_FAIL', { userId: ctx.userId, delta: reward.stars, path: 'scratch_card' });
        }
        progress.stars += reward.stars;
      }

      socket.emit('scratchCardRevealed', { success: true, reward });
      if (reward.item) {
        const inv = await loadInventory(ctx.userId);
        socket.emit('inventoryUpdated', { inventory: inv });
      }
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('claimScratchCard error:', err);
      socket.emit('scratchCardRevealed', { success: false, error: 'server_error' });
    }
  });

  // Battle pass tier claim — idempotent via unique constraint.
  socket.on('claimBattlePassTier', async (data: { seasonId: string; tierId: number; reward?: { chips?: number; stars?: number; itemType?: string; itemId?: string } }) => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) { socket.emit('battlePassTierClaimed', { success: false, error: 'Not authenticated' }); return; }

      const seasonId = data?.seasonId || 'season_1_the_river';
      const tierId = Number(data?.tierId);
      if (!Number.isInteger(tierId) || tierId < 1 || tierId > 50) {
        socket.emit('battlePassTierClaimed', { success: false, error: 'invalid_tier' });
        return;
      }

      const ok = await dbClaimBattlePassTier(ctx.userId, seasonId, tierId);
      if (!ok) {
        socket.emit('battlePassTierClaimed', { success: false, error: 'already_claimed', tierId });
        return;
      }

      // Server-side reward table per tier. Every 5th tier grants stars, rest grant chips.
      // DB-first ordering: award chips/stars in DB BEFORE mutating in-memory
      // progress. Reverse order could leave UI showing a reward that never
      // landed in users.chips / users.stars if the DB write failed. Audit
      // logs on failure so ops can reconcile.
      const progress = progressionManager.getProgress(ctx.playerId)!;
      // 2026-05-11 stats audit — added hydrated gate. Pre-fix, a claim
      // firing during the async hydrate window would modify in-memory stars
      // that got clobbered when hydrate finished and overwrote with DB
      // state — the claim reward was effectively lost until next login.
      if (!progress.hydrated) {
        socket.emit('battlePassTierClaimed', { success: false, error: 'NOT_HYDRATED' });
        return;
      }
      const chips = tierId % 5 === 0 ? 0 : 1000 + tierId * 200;
      const stars = tierId % 5 === 0 ? 25 + tierId : 0;
      if (chips > 0) {
        const ok = await addChipsToUser(ctx.userId, chips);
        if (!ok) {
          auditLog('SYSTEM', 'BATTLEPASS_CHIPS_DB_FAIL', { userId: ctx.userId, seasonId, tierId, amount: chips });
          socket.emit('battlePassTierClaimed', { success: false, error: 'db_failed' });
          return;
        }
        progress.chips += chips;
      }
      if (stars > 0) {
        // addStarsToUser is atomic-additive (UPDATE users SET stars = stars + $1).
        // Using the new helper instead of persistStars avoids clobbering
        // concurrent star grants (e.g. daily rewards) with a plain SET.
        const ok = await addStarsToUser(ctx.userId, stars);
        if (!ok) {
          auditLog('SYSTEM', 'BATTLEPASS_STARS_DB_FAIL', { userId: ctx.userId, seasonId, tierId, amount: stars });
          socket.emit('battlePassTierClaimed', { success: false, error: 'db_failed' });
          return;
        }
        progress.stars += stars;
      }

      socket.emit('battlePassTierClaimed', { success: true, tierId, chips, stars });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('claimBattlePassTier error:', err);
      socket.emit('battlePassTierClaimed', { success: false, error: 'server_error' });
    }
  });

  // Avatar customization sync.
  socket.on('updateAvatar', async (data: any) => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) return;
      await persistCustomization(ctx.userId, data || {});
      socket.emit('customizationUpdated', { success: true, customization: data || {} });
    } catch (err: any) {
      console.error('updateAvatar error:', err);
    }
  });

  // Settings / preferences sync.
  socket.on('updatePreferences', async (data: any) => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) return;
      await persistPreferences(ctx.userId, data || {});
      socket.emit('preferencesUpdated', { success: true });
    } catch (err: any) {
      console.error('updatePreferences error:', err);
    }
  });

  // Achievements panel — 3-bucket summary (daily / weekly / lifetime) with
  // per-entry unlock status + reward + window end timestamps for countdown.
  socket.on('getAchievements', async () => {
    const empty = { daily: [], weekly: [], lifetime: [], windowEndsAt: { daily: 0, weekly: 0 } };
    // Resolve playerId from the table seat if present, else from the auth
    // session (so the lobby Achievement Badges / panel work when not seated).
    let playerId = playerSessions.get(socket.id)?.playerId;
    if (!playerId) {
      const ctx = await ensureHydrated(socket);
      playerId = ctx?.playerId;
    }
    if (!playerId) { socket.emit('achievementsList', empty); return; }
    const summary = progressionManager.getAchievementsSummary(playerId);
    socket.emit('achievementsList', summary || empty);
  });

  // Load durable extras (inventory, battle pass claims, hand history, prefs) —
  // called by client once after login to hydrate UI.
  socket.on('getDurableState', async (data: { seasonId?: string } = {}) => {
    try {
      const ctx = await ensureHydrated(socket);
      if (!ctx) return;
      const [inventory, bpClaims, durable, handHistory] = await Promise.all([
        loadInventory(ctx.userId),
        loadBattlePassClaims(ctx.userId, data.seasonId || 'season_1_the_river'),
        loadDurableProgress(ctx.userId),
        loadHandHistory(ctx.userId, 100),
      ]);
      socket.emit('durableState', {
        inventory,
        battlePassClaims: bpClaims,
        customization: durable?.customization || {},
        preferences: durable?.preferences || {},
        stars: durable?.stars || 0,
        loginStreak: durable?.loginStreak || 0,
        lastLoginClaimDate: durable?.lastLoginClaimDate || null,
        scratchCardsAvailable: durable?.scratchCardsAvailable || 0,
        handHistory,
      });
    } catch (err: any) {
      console.error('getDurableState error:', err);
    }
  });

  /**
   * Deep-link from player app: "Play Online" tile (general play, not waitlist).
   * Player app issued a short-lived signed ticket via the master API; we
   * verify it here, resolve / sync the local user, set the auth session, and
   * emit loginResult. Does NOT auto-seat the player — they land on the lobby
   * logged in and choose their table.
   */
  socket.on(
    'authWithTicket',
    async (data: { token: string }) => {
      try {
        if (!data?.token) {
          socket.emit('loginResult', { success: false, error: 'Missing token' });
          return;
        }
        // Ticket replay guard — reject if this exact token has been used already.
        if (!markTicketUsed(data.token)) {
          socket.emit('loginResult', { success: false, error: 'Token already used — please request a new link' });
          return;
        }

        const MASTER_API_BASE =
          process.env.MASTER_API_URL ||
          'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
        // 2026-06-14 — send the shared bypass key on the unauth /users/:id/me
        // fetch so it keeps returning the public-safe shape after the master
        // API flips REQUIRE_AUTH_ENFORCE=1 (otherwise it 401s — Pattern A).
        // Requires AUTH_SERVER_BYPASS_KEY on Railway = the master API's value.
        // No header (no-op) until then, so safe to ship ahead of the env var.
        const AUTH_SERVER_BYPASS_KEY = process.env.AUTH_SERVER_BYPASS_KEY || '';
        const meBypassInit: RequestInit | undefined = AUTH_SERVER_BYPASS_KEY
          ? { headers: { 'X-Auth-Server-Key': AUTH_SERVER_BYPASS_KEY } }
          : undefined;

        // 6s hard timeout for every Master API hop. Without this the fetch
        // hangs on Node's default TCP timeout (~2 min) whenever the master
        // API has a cold start / DNS blip, which reliably causes the client
        // to time out before the server ever emits loginResult.
        const fetchWithTimeout = async (url: string, init?: RequestInit, ms = 6000) => {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), ms);
          try {
            return await fetch(url, { ...init, signal: ac.signal });
          } finally {
            clearTimeout(t);
          }
        };

        // 1. Verify ticket with master API
        let verifyRes;
        try {
          verifyRes = await fetchWithTimeout(`${MASTER_API_BASE}/online-link-token/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: data.token }),
          });
        } catch (err: any) {
          const isTimeout = err?.name === 'AbortError';
          socket.emit('loginResult', {
            success: false,
            error: isTimeout ? 'Auth service slow — please try again' : 'Auth service unreachable',
          });
          return;
        }
        if (!verifyRes.ok) {
          reportAuthEvent('ticket_auth_failed', { reason: `verify_http_${verifyRes.status}` });
          socket.emit('loginResult', { success: false, error: 'Token verify failed' });
          return;
        }
        const verifyJson: any = await verifyRes.json();
        const payload = verifyJson?.data || verifyJson;
        if (!payload?.valid) {
          reportAuthEvent('ticket_auth_failed', { reason: `invalid_token:${payload?.reason || 'unknown'}` });
          socket.emit('loginResult', { success: false, error: `Invalid token: ${payload?.reason || 'unknown'}` });
          return;
        }
        const remoteUserId = payload.payload?.userId;
        if (!remoteUserId) {
          reportAuthEvent('ticket_auth_failed', { reason: 'token_missing_userId' });
          socket.emit('loginResult', { success: false, error: 'Token missing userId' });
          return;
        }

        // 2. Fetch master user details
        let meRes;
        try {
          meRes = await fetchWithTimeout(`${MASTER_API_BASE}/users/${remoteUserId}/me`, meBypassInit);
        } catch (err: any) {
          const isTimeout = err?.name === 'AbortError';
          socket.emit('loginResult', {
            success: false,
            error: isTimeout ? 'Auth service slow — please try again' : 'Could not load user',
          });
          return;
        }
        if (!meRes.ok) {
          reportAuthEvent('ticket_auth_failed', { reason: `me_fetch_http_${meRes.status}` });
          socket.emit('loginResult', { success: false, error: 'Could not load user' });
          return;
        }
        const meJson: any = await meRes.json();
        const masterUser = meJson?.data || meJson;
        // 2026-05-19 — `/users/:id/me` is called UNAUTHENTICATED here, which
        // returns the public-safe shape (post-2026-05-07 PII hardening) — it
        // intentionally omits phoneNumber. The previous code used
        // `masterUser.phoneNumber || masterUser.phone_number` which evaluated
        // to undefined, then the INSERT below set username = $1 = undefined
        // and Postgres rejected with `null value in column "username"
        // violates not-null constraint`. The catch at the bottom would
        // emit loginResult({success:false}) but by then the spinner was
        // also racing the client's 15s "Connection timed out" UI, and
        // some users saw both — for many users the loginResult never
        // arrived at all because the socket had already churned (Railway
        // scale-up, network blip — same socket-race family as BUG 5
        // earlier this session).
        //
        // Fix: fall back to `username` (the master API's stable identifier,
        // always present in the public-safe shape — `josh.hall2`,
        // `jacob.barshay`, etc.) when phone isn't available. The local
        // users table just needs a unique key in the `username` column;
        // it doesn't care whether it's a phone number or a slug.
        // Existing rows that were created with phoneNumber-as-username
        // continue to match because the lookup is the same key the
        // master API returned to the original session (and player web's
        // bridge handoff uses the same username slug).
        const phone = masterUser.phoneNumber || masterUser.phone_number || masterUser.username;
        const displayName = masterUser.firstName
          ? `${masterUser.firstName} ${(masterUser.lastName || '')[0] || ''}.`.trim()
          : masterUser.username || phone;
        if (!phone) {
          // Final defense: if BOTH phone and username are missing, the
          // public-safe shape must have changed shape on us. Surface a
          // clear error instead of letting the INSERT NPE.
          socket.emit('loginResult', {
            success: false,
            error: 'Master API user shape missing username — please retry',
          });
          console.error('[authWithTicket] master /me public-safe shape missing both phoneNumber and username:', masterUser);
          return;
        }

        // 3. Lookup or insert local user.
        //
        // 2026-05-19 — augmented the lookup to also match by masterUserId in
        // the stats JSONB. The 2026-05-07 PII hardening of /users/:id/me
        // means our unauthenticated `meRes` no longer returns phoneNumber,
        // so for users who previously logged in via authenticateWithMasterAPI
        // (which DID get phoneNumber and stored that as the local username),
        // a fresh authWithTicket would now miss their existing row (lookup
        // by username='josh.hall2' wouldn't match the existing
        // username='7202780636') and create a duplicate. Look up by
        // masterUserId first — that's stable across both code paths.
        const bcrypt = require('bcryptjs');
        const placeholderHash = bcrypt.hashSync(
          `ticket-placeholder-${remoteUserId}-${Date.now()}`,
          10
        );

        let localUser: any = null;
        // 3a. Prefer matching by masterUserId in stats JSONB — works regardless
        // of whether the row was originally keyed by phone or by username.
        //
        // 2026-05-19 — relies on the partial functional index
        // `idx_users_stats_master_user_id` (created in authManager.ts:initDB).
        // Without that index this is a sequential scan that adds visible
        // latency on Railway cold-start.
        try {
          const byMasterId = await getPool().query(
            `SELECT * FROM users WHERE stats->>'masterUserId' = $1 LIMIT 1`,
            [String(remoteUserId)]
          );
          if (byMasterId.rows.length > 0) {
            localUser = byMasterId.rows[0];
            // 2026-05-19 — only run the JSONB UPDATE if something actually
            // changed (masterUsername drifted, missing masterPhone, missing
            // display_name). Previously this UPDATE fired on EVERY
            // authWithTicket, which is once per Play Online click — pure
            // overhead on the hot path of a deep-link sign-in. Now the
            // common case (returning user, no drift) skips the write and
            // the deep-link consumer's 15s timeout has more headroom on
            // top of Railway cold-start.
            const existingStats: any = typeof localUser.stats === 'object' && localUser.stats
              ? localUser.stats
              : {};
            const wantMasterPhone = phone && phone !== masterUser.username ? phone : undefined;
            const driftedUsername = existingStats.masterUsername !== masterUser.username;
            const driftedPhone = wantMasterPhone != null && existingStats.masterPhone !== wantMasterPhone;
            const missingDisplay = !localUser.display_name && displayName;
            if (driftedUsername || driftedPhone || missingDisplay) {
              try {
                const merged = {
                  ...existingStats,
                  masterUserId: String(remoteUserId),
                  masterUsername: masterUser.username,
                  ...(wantMasterPhone ? { masterPhone: wantMasterPhone } : {}),
                };
                await getPool().query(
                  `UPDATE users SET stats = $1, display_name = COALESCE(display_name, $2) WHERE id = $3`,
                  [JSON.stringify(merged), displayName, localUser.id]
                );
                localUser.stats = merged;
                localUser.display_name = localUser.display_name || displayName;
              } catch { /* non-fatal */ }
            }
          }
        } catch (e: any) {
          console.warn('[authWithTicket] masterUserId lookup failed (non-fatal):', e?.message || e);
        }

        // 3b. Fall back to UPSERT by username if no masterUserId match.
        if (!localUser) {
          const { rows } = await getPool().query(
            `INSERT INTO users (username, display_name, password_hash, chips, level, xp, stats)
               VALUES ($1, $2, $3, ${DEFAULT_CHIPS}, ${DEFAULT_LEVEL}, ${DEFAULT_XP}, $4)
               ON CONFLICT (LOWER(username)) DO UPDATE
                 SET display_name = COALESCE(users.display_name, $2)
             RETURNING *`,
            [phone, displayName, placeholderHash, JSON.stringify({ masterPhone: phone, masterUsername: masterUser.username, masterUserId: remoteUserId })]
          );
          localUser = rows[0];
        }

        // 4. Set auth session + emit loginResult in the shape the client expects.
        authSessions.set(socket.id, { userId: localUser.id, username: localUser.username });
        const userData = {
          id: localUser.id,
          username: localUser.username,
          displayName: localUser.display_name,
          chips: localUser.chips,
          level: localUser.level,
          xp: localUser.xp,
          stats: typeof localUser.stats === 'string' ? JSON.parse(localUser.stats || '{}') : (localUser.stats || {}),
          achievements: typeof localUser.achievements === 'string' ? JSON.parse(localUser.achievements || '[]') : (localUser.achievements || []),
          isAdmin: !!localUser.is_admin,
        };
        socket.emit('loginResult', { success: true, token: data.token, userData });
        hydrateAndPushProgress(socket, localUser.id, localUser.username).catch(() => {});

        console.log(
          `[authWithTicket] logged in userId=${localUser.id} (masterId=${remoteUserId}) username=${localUser.username}`
        );
      } catch (err: any) {
        console.error('authWithTicket error:', err);
        socket.emit('loginResult', { success: false, error: 'Server error authenticating ticket' });
      }
    }
  );

  /**
   * Deep-link from player app: a logged-in player on the live waitlist taps
   * "Play online while you wait". Player app issued a short-lived signed
   * token via the master API; we verify it here, then auto-seat the player
   * at the Beginner's Table (lowest blinds) with the context attached.
   */
  socket.on(
    'joinWithWaitlistContext',
    async (data: {
      token: string;
      context: {
        source?: string;
        gameId?: string | null;
        position?: number | null;
        venue?: string | null;
        startTime?: string | null;
      };
    }) => {
      try {
        if (!data || !data.token) {
          socket.emit('error', { message: 'Missing token' });
          return;
        }
        // Ticket replay guard for the waitlist path.
        if (!markTicketUsed(data.token)) {
          socket.emit('error', { message: 'Token already used — please request a new link' });
          return;
        }

        // 1) Verify token with master API
        const MASTER_API_BASE =
          process.env.MASTER_API_URL ||
          'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
        // 2026-06-14 — send the shared bypass key on the unauth /users/:id/me
        // fetch so it keeps returning the public-safe shape after the master
        // API flips REQUIRE_AUTH_ENFORCE=1 (otherwise it 401s — Pattern A).
        // Requires AUTH_SERVER_BYPASS_KEY on Railway = the master API's value.
        // No header (no-op) until then, so safe to ship ahead of the env var.
        const AUTH_SERVER_BYPASS_KEY = process.env.AUTH_SERVER_BYPASS_KEY || '';
        const meBypassInit: RequestInit | undefined = AUTH_SERVER_BYPASS_KEY
          ? { headers: { 'X-Auth-Server-Key': AUTH_SERVER_BYPASS_KEY } }
          : undefined;
        // 6s hard timeout — see authWithTicket handler for rationale.
        const fetchWithTimeout = async (url: string, init?: RequestInit, ms = 6000) => {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), ms);
          try {
            return await fetch(url, { ...init, signal: ac.signal });
          } finally {
            clearTimeout(t);
          }
        };
        let verifyRes;
        try {
          verifyRes = await fetchWithTimeout(`${MASTER_API_BASE}/online-link-token/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: data.token }),
          });
        } catch (err: any) {
          const isTimeout = err?.name === 'AbortError';
          socket.emit('error', { message: isTimeout ? 'Auth service slow — please try again' : 'Auth service unreachable' });
          return;
        }
        if (!verifyRes.ok) {
          socket.emit('error', { message: 'Token verify failed' });
          return;
        }
        const verifyJson: any = await verifyRes.json();
        const payload = verifyJson?.data || verifyJson;
        if (!payload || !payload.valid) {
          socket.emit('error', {
            message: `Invalid token: ${payload?.reason || 'unknown'}`,
          });
          return;
        }
        const claims = payload.payload || {};
        const remoteUserId = claims.userId;
        if (!remoteUserId) {
          socket.emit('error', { message: 'Token missing userId' });
          return;
        }

        // Resolve local user + set auth session BEFORE seating. Previously
        // this handler seated the player purely on the ticket claim, without
        // confirming authSessions[socket.id] — if the parallel oauthLogin from
        // the client never completed (stale refresh token, server hiccup), the
        // player would be visually seated but unable to take any later action
        // that requires auth (cash-out, switch tables). Resolving locally here
        // closes that gap: waitlist seat ALWAYS comes with a real auth session.
        if (!authSessions.has(socket.id)) {
          try {
            const meRes = await fetchWithTimeout(`${MASTER_API_BASE}/users/${remoteUserId}/me`, meBypassInit);
            if (meRes.ok) {
              const meJson: any = await meRes.json();
              const masterUser = meJson?.data || meJson;
              const phone = masterUser.phoneNumber || masterUser.phone_number;
              if (phone) {
                const { rows: urows } = await getPool().query(
                  'SELECT id, username FROM users WHERE username = $1 LIMIT 1',
                  [phone]
                );
                if (urows[0]) {
                  authSessions.set(socket.id, { userId: urows[0].id, username: urows[0].username });
                }
              }
            } else {
              reportAuthEvent('waitlist_auth_failed', { reason: `me_fetch_http_${meRes.status}` });
            }
          } catch (e) {
            reportAuthEvent('waitlist_auth_failed', { reason: 'me_fetch_error' });
            console.warn('[joinWithWaitlistContext] auth-bootstrap failed:', (e as Error).message);
          }
        }

        // If we still don't have an auth session after the bootstrap attempt,
        // abort rather than seating an unauthenticated player who will then
        // silently fail on every subsequent action.
        if (!authSessions.has(socket.id)) {
          reportAuthEvent('waitlist_auth_failed', { reason: 'no_auth_session' });
          socket.emit('error', { message: 'Authentication could not be established — please sign in and try again.' });
          return;
        }

        // 2026-05-12 round-5 audit P1: spectator dual-membership scrub.
        // See joinTable handler for the full rationale — same bug
        // applies on this seat-after-auth path.
        for (const [tid, s] of spectators) {
          if (s.delete(socket.id) && s.size === 0) spectators.delete(tid);
        }

        // 2) Pick lowest-stakes Texas Hold'em table (Beginner's Table)
        const existingSession = playerSessions.get(socket.id);
        if (existingSession) handlePlayerLeave(socket);
        const tables = tableManager.getTableList();
        const isHoldem = (t: any) => {
          const tbl = tableManager.getTable(t.tableId);
          const id = (tbl as any)?.variantId || '';
          return !id || id === 'texas-holdem';
        };
        const holdem = tables.filter(isHoldem);
        holdem.sort((a, b) => a.smallBlind - b.smallBlind);
        if (holdem.length === 0) {
          socket.emit('error', { message: 'No tables available' });
          return;
        }
        const bestTable = holdem[0];
        const table = tableManager.getTable(bestTable.tableId);
        if (!table) {
          socket.emit('error', { message: 'Table not found' });
          return;
        }

        // 3) Find empty or AI seat
        let targetSeat = -1;
        for (let i = 0; i < MAX_SEATS; i++) {
          if (table.seats[i].state === 'empty') {
            targetSeat = i;
            break;
          }
        }
        if (targetSeat === -1) {
          for (let i = 0; i < MAX_SEATS; i++) {
            if (table.seats[i].state === 'occupied' && table.seats[i].isAI) {
              table.standUp(i);
              const profiles = aiProfiles.get(bestTable.tableId);
              if (profiles) profiles.delete(i);
              targetSeat = i;
              break;
            }
          }
        }
        if (targetSeat === -1) {
          socket.emit('error', { message: 'No seats available' });
          return;
        }

        // 4) Seat the player. Use existing session's playerName if available,
        //    else fall back to a generic name (the client's auth flow supplies
        //    the real name via loginResult, this handler runs after login).
        const existingName = playerSessions.get(socket.id)?.playerName;
        const playerName = existingName || `Player-${remoteUserId.slice(0, 6)}`;
        const playerId = `player-${uuidv4()}`;
        // Ghost-seat defense (authWithTicket path): clear any lingering
        // seat from a previous session before re-seating.
        const authNow = authSessions.get(socket.id);
        if (authNow) clearGhostSeatsForUser(authNow.userId, bestTable.tableId, socket.id, targetSeat);

        // 2026-06-19 P0 chip-mint fix: deduct the buy-in from the wallet, exactly
        // like the normal joinTable path (index.ts:5056). This waitlist path
        // previously seated with minBuyIn but NEVER deducted — and on leave
        // creditSeatStackToWallet cashes the (cash-table) stack back to the
        // wallet (it only skips tournament tables), minting >= minBuyIn per
        // at-venue waitlist seating. Deducting here makes the seat wallet-neutral.
        const waitlistBuyIn = table.config.minBuyIn;
        if (authNow) {
          const dbChips = await ensureChipsForBuyIn(authNow.userId, authNow.username, waitlistBuyIn);
          if (waitlistBuyIn > dbChips) {
            socket.emit('error', { message: 'Insufficient chips' });
            return;
          }
          if (!(await deductChips(authNow.userId, waitlistBuyIn))) {
            socket.emit('error', { message: 'Could not deduct chips — try again' });
            return;
          }
          auditLog(authNow.username, 'BUY_IN_DEDUCT', { tableId: bestTable.tableId, buyIn: waitlistBuyIn, reason: 'waitlist' });
        }

        const success = table.sitDown(
          targetSeat,
          playerName,
          waitlistBuyIn,
          playerId,
          false
        );
        if (!success) {
          // Roll back the deduction so a failed seat can't debit the player.
          if (authNow) {
            try {
              await addChipsToUser(authNow.userId, waitlistBuyIn);
              auditLog(authNow.username, 'BUY_IN_REFUND', { tableId: bestTable.tableId, buyIn: waitlistBuyIn, reason: 'waitlist_sitDown_failed' });
            } catch (e) {
              auditLog(authNow.username, 'BUY_IN_REFUND_FAILED', { tableId: bestTable.tableId, buyIn: waitlistBuyIn, error: String(e) });
            }
          }
          socket.emit('error', { message: 'Could not join table' });
          return;
        }

        const session: PlayerSession = {
          socketId: socket.id,
          tableId: bestTable.tableId,
          seatIndex: targetSeat,
          playerName,
          playerId,
          trainingEnabled: false,
          sittingOut: false,
          context: {
            source: 'waitlist',
            gameId: data.context?.gameId ?? claims.gameId ?? null,
            position: data.context?.position ?? claims.position ?? null,
            venue: data.context?.venue ?? claims.venueName ?? null,
            startTime: data.context?.startTime ?? claims.startTime ?? null,
          },
        };
        playerSessions.set(socket.id, session);
        socket.join(`table:${bestTable.tableId}`);

        progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
        ensureTableProgressListener(table, bestTable.tableId);
        fillWithAI(table, bestTable.tableId);

        if (!table.isHandInProgress() && table.getOccupiedSeatCount() >= 2) {
          table.startNewHand();
        }

        socket.emit('gameState', getGameStateForPlayer(table, targetSeat));
        broadcastGameState(bestTable.tableId);
        sendProgressToPlayer(socket.id);
        scheduleAIAction(bestTable.tableId);

        console.log(
          `[waitlistContext] seated user=${remoteUserId} at table=${bestTable.tableId} seat=${targetSeat} gameId=${claims.gameId}`
        );
      } catch (err: any) {
        console.error('joinWithWaitlistContext error:', err);
        socket.emit('error', { message: 'Server error joining with context' });
      }
    }
  );

  // Pineapple / Crazy Pineapple manual discard. Player picks which of their 3
  // hole cards to throw away. If they don't pick before the deadline, the
  // server auto-discards their weakest card.
  socket.on('selectPineappleDiscard', (data: { cardIndex: number }) => {
    const session = playerSessions.get(socket.id);
    if (!session) { socket.emit('error', { message: 'Not at a table' }); return; }
    const table = tableManager.getTable(session.tableId) as any;
    if (!table || typeof table.selectPineappleDiscard !== 'function') {
      socket.emit('error', { message: 'Table does not support discard' });
      return;
    }
    const ok = table.selectPineappleDiscard(session.seatIndex, data?.cardIndex);
    socket.emit('pineappleDiscardAck', { success: !!ok, cardIndex: data?.cardIndex });
    if (ok) broadcastGameState(session.tableId);
  });

  // Top-up / rebuy — client calls this when their auto-rebuy fires (or a
  // manual "Add Chips" button if one existed). Refills the player's seat
  // stack to the requested amount, debiting from their DB balance. In
  // testing mode, ensureChipsForBuyIn auto-tops-up the DB balance if
  // needed so the rebuy never fails.
  // PWA audit #2/#11: client explicitly requests a state sync after
  // reconnect/app-resume so the player immediately sees the current
  // table state (phase, turn, community cards, chips) instead of
  // whatever stale gameState was last in their store.
  socket.on('syncTableState', (data: { tableId?: string } = {}) => {
    const session = playerSessions.get(socket.id);
    const tableId = session?.tableId || data?.tableId;
    if (!tableId) return;
    const table = tableManager.getTable(tableId);
    if (!table) return;
    const state = getGameStateForPlayer(table, session?.seatIndex ?? -1, session?.trainingEnabled || false);
    emitGameState(socket, state, true);
  });

  socket.on('rebuy', async (data: { amount?: number } = {}) => { (async () => {
    const session = playerSessions.get(socket.id);
    if (!session) { socket.emit('error', { message: 'Not at a table' }); return; }
    const table = tableManager.getTable(session.tableId);
    if (!table) { socket.emit('error', { message: 'Table not found' }); return; }
    const seat = table.seats[session.seatIndex];
    if (!seat || seat.state !== 'occupied') {
      socket.emit('error', { message: 'Seat not occupied' });
      return;
    }
    // 2026-06-11 audit C4: rebuy is a CASH-TABLE action only. In a
    // tournament a busted player is eliminated and their seat/stack is
    // owned by TournamentManager; a self-serve rebuy would let them
    // un-eliminate with a client-chosen stack and corrupt standings +
    // payouts. Mirror the moveSeat tournament gate.
    if (tournamentTables.has(session.tableId)) {
      socket.emit('error', { message: 'Rebuys are disabled in tournaments' });
      return;
    }
    // Don't allow rebuys in the middle of a hand while the player is
    // still in the pot — the stack is committed. Rebuy between hands or
    // while folded/sat-out only.
    if (table.isHandInProgress() && !seat.folded) {
      socket.emit('error', { message: 'Cannot rebuy while in a live hand — wait for the hand to finish' });
      return;
    }
    // 2026-06-19 Phase 4: clamp the client-supplied rebuy target to
    // [minBuyIn, minBuyIn*10], matching the joinTable audit-C6 cap. Not a mint
    // (it's the player's own wallet, deducted + balance-checked below) but
    // without an upper bound a crafted rebuy could seat an oversized stack and
    // distort table economics / SPR — the same fairness issue C6 addressed.
    const maxBuyIn = table.config.minBuyIn * 10;
    const requested = Math.min(maxBuyIn, Math.max(table.config.minBuyIn, data?.amount || table.config.minBuyIn));
    // How much are we actually trying to top up to?
    const topUpAmount = Math.max(0, requested - seat.chipCount);
    if (topUpAmount <= 0) {
      socket.emit('rebuyComplete', { success: true, newStack: seat.chipCount, added: 0 });
      return;
    }
    const authForRebuy = authSessions.get(socket.id);
    if (authForRebuy) {
      const dbChips = await ensureChipsForBuyIn(authForRebuy.userId, authForRebuy.username, topUpAmount);
      if (topUpAmount > dbChips) {
        socket.emit('error', { message: 'Insufficient chips for rebuy' });
        return;
      }
      if (!(await deductChips(authForRebuy.userId, topUpAmount))) {
        socket.emit('error', { message: 'Could not deduct chips — try again' });
        return;
      }
      auditLog(authForRebuy.username, 'REBUY_DEDUCT', { tableId: session.tableId, topUpAmount, newStack: requested });
    }
    // 2026-06-11 audit C5: a hand can auto-start during the awaits above
    // (ensureChipsForBuyIn / deductChips are DB round-trips). If it did,
    // the player may have already posted a blind out of seat.chipCount —
    // a flat `seat.chipCount = requested` would erase that posted blind
    // while it sits in the live pot, MINTING table chips. Two guards:
    //   (a) if a live hand started under us and the player is now in it,
    //       abort the top-up (their stack is committed) — the chips were
    //       already deducted from the wallet, so credit them back.
    //   (b) otherwise add the top-up ADDITIVELY rather than assigning a
    //       flat target, so any concurrent stack change is preserved.
    if (table.isHandInProgress() && !seat.folded) {
      if (authForRebuy) {
        await addChipsToUser(authForRebuy.userId, topUpAmount);
        auditLog(authForRebuy.username, 'REBUY_REFUND_HAND_STARTED', { tableId: session.tableId, topUpAmount });
      }
      socket.emit('error', { message: 'Hand started before rebuy completed — try again between hands' });
      return;
    }
    seat.chipCount += topUpAmount;
    seat.eliminated = false;
    broadcastGameState(session.tableId);
    socket.emit('rebuyComplete', { success: true, newStack: seat.chipCount, added: topUpAmount });
    // 2026-05-12 audit: throttled to debug, was console.log
    log.debug(`[Rebuy] ${seat.playerName} topped up by ${topUpAmount} to ${requested}`);
  })(); });

  // ========== Seat move (cash tables only) ==========
  //
  // Queued request to move the player to a different seat at the SAME
  // table. Takes effect at the next hand boundary (enforced by
  // autoStartNextHand). Disabled for tournament tables because the
  // TournamentManager owns seat assignment there (rebalance flow).
  //
  // Payload: { targetSeatIndex: number, tableId?: string (for multi-table) }
  socket.on('moveSeat', async (data: { targetSeatIndex?: number; tableId?: string } = {}) => {
    try {
      const targetSeat = Number(data?.targetSeatIndex);
      if (!Number.isInteger(targetSeat) || targetSeat < 0 || targetSeat >= MAX_SEATS) {
        socket.emit('error', { message: 'Invalid target seat' });
        return;
      }
      // Resolve the player's session. Multi-table support: if `tableId` is
      // passed and matches a secondary session, use that; otherwise the
      // primary session.
      let session: PlayerSession | undefined = playerSessions.get(socket.id);
      if (data?.tableId) {
        if (session?.tableId !== data.tableId) {
          const multi = multiTableSessions.get(socket.id) || [];
          const match = multi.find((s) => s.tableId === data.tableId);
          if (match) session = match;
        }
      }
      if (!session) {
        socket.emit('error', { message: 'Not at a table' });
        return;
      }
      const table = tableManager.getTable(session.tableId);
      if (!table) { socket.emit('error', { message: 'Table not found' }); return; }

      // Gate: cash tables only. Tournament table seat assignment is owned
      // by TournamentManager (rebalance logic); allowing self-serve seat
      // change there would race with table-balance decisions.
      if (tournamentTables.has(session.tableId)) {
        socket.emit('error', { message: 'Seat moves are disabled in tournaments' });
        return;
      }

      if (targetSeat === session.seatIndex) {
        // Same seat — treat as a cancel of any pending move.
        delete session.pendingSeatIndex;
        socket.emit('moveSeatCancelled', { tableId: session.tableId });
        broadcastGameState(session.tableId);
        return;
      }

      const dest = table.seats[targetSeat];
      if (!dest) {
        socket.emit('error', { message: 'Invalid target seat' });
        return;
      }
      // Target must be empty OR occupied by an AI we can evict. Refuse if
      // a real human (or reserved seat) sits there.
      if (dest.state === 'occupied' && !dest.isAI) {
        socket.emit('error', { message: 'That seat is occupied by another player' });
        return;
      }

      session.pendingSeatIndex = targetSeat;
      socket.emit('moveSeatPending', {
        tableId: session.tableId,
        currentSeat: session.seatIndex,
        pendingSeat: targetSeat,
      });
      console.log(`[MoveSeat] ${session.playerName} queued move ${session.seatIndex} → ${targetSeat} on ${session.tableId}`);

      // If the table isn't in an active hand right now, execute immediately
      // instead of waiting for the next HandComplete.
      if (!table.isHandInProgress()) {
        executePendingMove(session.tableId, session);
        broadcastGameState(session.tableId);
      }
    } catch (err: any) {
      console.error('[moveSeat] error:', err.message);
      socket.emit('error', { message: 'Server error queuing seat move' });
    }
  });

  socket.on('cancelMoveSeat', () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    if (session.pendingSeatIndex == null) return;
    delete session.pendingSeatIndex;
    socket.emit('moveSeatCancelled', { tableId: session.tableId });
    console.log(`[MoveSeat] ${session.playerName} cancelled pending move on ${session.tableId}`);
  });

  socket.on('startHand', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) {
      socket.emit('error', { message: 'Not at a table' });
      return;
    }

    const table = tableManager.getTable(session.tableId);
    if (!table) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    if (table.isHandInProgress()) {
      socket.emit('error', { message: 'Hand already in progress' });
      return;
    }

    const occupiedCount = table.getOccupiedSeatCount();
    if (occupiedCount < 2) {
      socket.emit('error', { message: 'Need at least 2 players' });
      return;
    }

    // Missed-blinds refactor: syncSitOutToTable keeps the table's
    // sit-out set current after every mutation to sitOutTracker, so
    // markSittingOutBlinds runs against the right set at EVERY
    // startNewHand (including the 24/7 heartbeat auto-starts). No
    // pre-start push needed here — the set is already cached.
    const started = table.startNewHand();
    if (started) {
      broadcastGameState(session.tableId);
      scheduleAIAction(session.tableId);
    }
  });

  socket.on(
    'action',
    (data: {
      type: 'fold' | 'check' | 'call' | 'raise' | 'allIn';
      amount?: number;
      // 2026-06-10 audit: required (was optional). The handler now
      // rejects actions with no nonce — the sanctioned client always
      // sends one. Kept as `string | undefined` at runtime via the
      // explicit guard below since socket payloads aren't type-checked
      // at the boundary, but the contract is: nonce is mandatory.
      nonce?: string;
    }) => {
      const session = playerSessions.get(socket.id);
      if (!session) {
        socket.emit('error', { message: 'Not at a table' });
        return;
      }

      const table = tableManager.getTable(session.tableId);
      if (!table) {
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      // Nonce replay prevention (keyed per table:seat so multi-table players
      // can't replay a nonce from one table at another). Stamped with ts so
      // the periodic sweeper can age entries out — the previous keys-only
      // shape (string) defeated the sweeper and silently disabled this guard.
      //
      // 2026-06-10 audit: the nonce is now REQUIRED. Previously the whole
      // block was gated on `if (data.nonce)`, so an action sent without a
      // nonce skipped replay protection entirely. The sanctioned client
      // path (poker-3d socketService.emitPlayerAction) ALWAYS attaches a
      // nonce via makeNonce(), on both the immediate-send and the
      // reconnect-queue-flush branches — so a missing nonce means a non-
      // sanctioned or tampered caller. Reject it rather than process an
      // un-deduped action.
      if (!data.nonce) {
        socket.emit('error', { message: 'Missing action nonce' });
        return;
      }
      {
        const nonceKey = `${session.tableId}:${session.seatIndex}`;
        const lastEntry = actionNonces.get(nonceKey);
        if (lastEntry && lastEntry.nonce === data.nonce) {
          socket.emit('error', { message: 'Duplicate action' });
          return;
        }
        actionNonces.set(nonceKey, { nonce: data.nonce, ts: Date.now() });
      }

      // Bot detection: track action timings
      const nowMs = Date.now();
      if (!actionTimings.has(socket.id)) actionTimings.set(socket.id, []);
      const timings = actionTimings.get(socket.id)!;
      timings.push(nowMs);
      if (timings.length > 20) timings.shift();
      if (timings.length >= 10) {
        const intervals = timings.slice(1).map((t, i) => t - timings[i]);
        const underThreshold = intervals.filter((ms) => ms < 200).length;
        if (underThreshold >= intervals.length * 0.8) {
          console.warn(`[AntiCheat] Possible bot detected: socket ${socket.id} — ${underThreshold}/${intervals.length} actions under 200ms`);
        }
      }

      // Validate it's this player's turn
      if (table.activeSeatIndex !== session.seatIndex) {
        socket.emit('error', { message: 'Not your turn' });
        return;
      }

      // All-In-Or-Fold: only fold or allIn allowed.
      // Reject check/call/raise outright — even "raise equal to stack" must use allIn.
      if (allInOrFoldTables.has(session.tableId) && data.type !== 'fold' && data.type !== 'allIn') {
        socket.emit('error', { message: 'Only fold or all-in allowed at this table' });
        return;
      }

      let success = false;
      switch (data.type) {
        case 'fold':
          success = table.playerFold(session.seatIndex);
          break;
        case 'check':
          success = table.playerCheck(session.seatIndex);
          break;
        case 'call':
          success = table.playerCall(session.seatIndex);
          break;
        case 'raise': {
          // Strict integer validation to prevent NaN/Infinity/negative/float exploits
          const amt = data.amount;
          if (
            typeof amt !== 'number' ||
            !Number.isFinite(amt) ||
            !Number.isInteger(amt) ||
            amt <= 0 ||
            amt > 1_000_000_000
          ) {
            socket.emit('error', { message: 'Invalid raise amount' });
            return;
          }
          success = table.playerRaise(session.seatIndex, amt);
          break;
        }
        case 'allIn':
          success = table.playerAllIn(session.seatIndex);
          // === Push notification: all_in_alert ===
          // Fire to every other live human seat at the table. Fire-and-forget;
          // never block the action handler. Only fires when the engine
          // accepted the all-in (success === true) so misfires don't ping
          // people on a rejected action.
          if (success) {
            try {
              const shoverSeat = session.seatIndex;
              const shoverName = table.seats[shoverSeat]?.playerName || 'A player';
              for (let i = 0; i < table.seats.length; i++) {
                if (i === shoverSeat) continue;
                const other = table.seats[i];
                if (!other || other.state !== 'occupied') continue;
                if (other.isAI || other.folded || !other.playerName) continue;
                const uid = userIdForSeat(session.tableId, i);
                if (!uid) continue;
                void notifyPlayer(
                  uid,
                  'all_in_alert',
                  'All-in!',
                  `${shoverName} just shoved all-in.`,
                  { priority: 'urgent', metadata: { gameId: session.tableId, seatNumber: i } }
                );
              }
            } catch (err) {
              console.warn('[notifyPlayer all_in_alert] hook failed:', (err as Error)?.message);
            }
          }
          break;
        default:
          socket.emit('error', { message: 'Unknown action type' });
          return;
      }

      if (!success) {
        socket.emit('error', { message: `Invalid action: ${data.type}` });
        return;
      }

      // Track action for progression (all actions tracked for stats)
      progressionManager.recordAction(session.playerId, data.type, {
        phase: table.currentPhase === GamePhase.PreFlop ? 'PreFlop' : undefined,
      });

      broadcastGameState(session.tableId);

      // Check if hand is complete
      if (table.currentPhase === GamePhase.HandComplete) {
        const existing = pendingAutoStartTimers.get(session.tableId);
        if (existing) clearTimeout(existing);
        const tid = session.tableId;
        const t = setTimeout(() => {
          pendingAutoStartTimers.delete(tid);
          autoStartNextHand(tid);
        }, 3000);
        pendingAutoStartTimers.set(tid, t);
      } else {
        // Schedule AI action if needed
        scheduleAIAction(session.tableId);
      }
    }
  );

  // ========== Draw Game: Player Draw Action ==========
  socket.on('playerDraw', async (data: { discardIndices: number[] }) => {
    const session = playerSessions.get(socket.id);
    if (!session) {
      socket.emit('error', { message: 'Not at a table' });
      return;
    }

    const table = tableManager.getTable(session.tableId);
    if (!table) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    if (!(table instanceof FiveCardDrawTable)) {
      socket.emit('error', { message: 'Not a draw game' });
      return;
    }

    const drawTable = table as FiveCardDrawTable;
    const success = drawTable.playerDraw(session.seatIndex, data.discardIndices || []);

    if (!success) {
      socket.emit('error', { message: 'Invalid draw action' });
      return;
    }

    broadcastGameState(session.tableId);
  });

  // Chat message handler
  socket.on('chatMessage', async (data: { message: string }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    if (!data.message || data.message.length > 200) return;

    // Rate limit: 1 message per 1.5 seconds
    const now = Date.now();
    const lastChat = lastChatTime.get(socket.id) || 0;
    if (now - lastChat < 1500) return;
    lastChatTime.set(socket.id, now);

    // Track chat for progression
    progressionManager.recordAction(session.playerId, 'chat');

    const chatMsg = {
      playerName: session.playerName,
      message: data.message,
      timestamp: Date.now(),
    };

    io.to(`table:${session.tableId}`).emit('chatMessage', chatMsg);
  });

  // ========== Progression Events ==========

  socket.on('getProgress', async () => {
    sendProgressToPlayer(socket.id);
  });

  socket.on('claimMission', async (data: { missionId: string }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const result = progressionManager.claimMissionReward(session.playerId, data.missionId);
    if (result.success) {
      socket.emit('missionClaimed', { missionId: data.missionId, reward: result.reward });
    }
    sendProgressToPlayer(socket.id);
  });

  socket.on('claimDailyBonus', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    // 2026-05-11 stats audit — claimDailyBonus used to be in-memory only,
    // letting a Railway redeploy + rehydrate desync state and double-credit
    // within seconds. user_daily_claims is now the source of truth.
    const ctx = await ensureHydrated(socket);
    if (!ctx) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    const progress = progressionManager.getProgress(ctx.playerId);
    if (!progress || !progress.hydrated) {
      socket.emit('error', { code: 'NOT_HYDRATED', message: 'Progress is still loading; try again' });
      return;
    }

    // DB write is the source of truth. If the row was already there for
    // today (INSERT ... ON CONFLICT DO NOTHING returned 0 rows), refuse.
    const newlyClaimed = await recordDailyClaim(ctx.userId, 'daily_bonus', null);
    if (!newlyClaimed) {
      socket.emit('error', { message: 'Daily bonus already claimed today' });
      return;
    }

    const result = progressionManager.claimDailyBonus(session.playerId);
    if (result.success) {
      socket.emit('dailyBonusClaimed', {
        chips: result.chips,
        stars: result.stars,
        streak: result.streak,
      });
    } else {
      // DB-write succeeded but in-memory claim refused (e.g. lastDailyBonusClaimed
      // matched today after rehydrate). The DB row is the lock; keep it.
      socket.emit('error', { message: 'Daily bonus already claimed today' });
    }
    sendProgressToPlayer(socket.id);
  });

  socket.on('getDailyMissions', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const missions = progressionManager.getDailyMissions(session.playerId);
    socket.emit('dailyMissions', missions);
    sendProgressToPlayer(socket.id);
  });

  // ========== Friends (durable, Postgres) — Phase 3a 2026-06-18 ==========
  const emitFriendsTo = (uid: number) => {
    for (const [sid, a] of authSessions) if (a?.userId === uid) io.to(sid).emit('friendsChanged');
  };
  socket.on('getFriends', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) return;
    try {
      const friends = await listFriends(auth.userId);
      const online = new Set<number>(); const inGame = new Set<number>();
      for (const [sid, a] of authSessions) {
        if (a?.userId) { online.add(a.userId); if (playerSessions.has(sid)) inGame.add(a.userId); }
      }
      const withPresence = friends.map(f => ({
        ...f,
        presence: f.status !== 'accepted' ? 'offline'
          : inGame.has(f.userId) ? 'in-game'
          : online.has(f.userId) ? 'online' : 'offline',
      }));
      socket.emit('friendsList', { friends: withPresence });
    } catch (e) { socket.emit('friendError', { message: 'Failed to load friends' }); }
  });
  socket.on('sendFriendRequest', async (data: { name?: string; userId?: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) return;
    try {
      let targetId = data?.userId;
      if (!targetId && data?.name) {
        const q = String(data.name).trim();
        const matches = await searchUsers(q, 5);
        const exact = matches.find(m => m.username.toLowerCase() === q.toLowerCase()) || matches[0];
        targetId = exact?.id;
      }
      if (!targetId) { socket.emit('friendError', { message: 'Player not found' }); return; }
      const res = await sendFriendRequest(auth.userId, targetId);
      if (!res.ok) { socket.emit('friendError', { message: res.error || 'Failed' }); return; }
      socket.emit('friendRequestSent', { status: res.status });
      for (const [sid, a] of authSessions) if (a?.userId === targetId) io.to(sid).emit('friendRequestReceived', { from: auth.username });
    } catch (e) { socket.emit('friendError', { message: 'Failed to send request' }); }
  });
  socket.on('acceptFriendRequest', async (data: { userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId || !data?.userId) return;
    const res = await acceptFriendRequest(auth.userId, data.userId);
    if (res.ok) { socket.emit('friendsChanged'); emitFriendsTo(data.userId); }
    else socket.emit('friendError', { message: res.error || 'Failed' });
  });
  socket.on('removeFriend', async (data: { userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId || !data?.userId) return;
    await removeFriend(auth.userId, data.userId);
    socket.emit('friendsChanged'); emitFriendsTo(data.userId);
  });
  socket.on('inviteFriendToTable', async (data: { userId: number; tableId?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId || !data?.userId) return;
    for (const [sid, a] of authSessions) if (a?.userId === data.userId) io.to(sid).emit('tableInvite', { from: auth.username, tableId: data.tableId || null });
    socket.emit('friendInviteSent', { userId: data.userId });
  });

  // ===== Prediction games (durable, server-authoritative) — Phase 3c 2026-06-18 =====
  socket.on('getPredictionWallet', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) return;
    try {
      const balance = await getPredictionWallet(auth.userId);
      socket.emit('predictionWallet', { balance });
    } catch { socket.emit('predictionError', { message: 'Failed to load wallet' }); }
  });
  socket.on('placePredictionBet', async (data: { tableId?: string; handId?: number; marketId?: string; outcome?: string; amount?: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) return;
    const tableId = data?.tableId || playerSessions.get(socket.id)?.tableId;
    const handNumber = Number(data?.handId);
    if (!tableId || !Number.isFinite(handNumber)) { socket.emit('predictionError', { message: 'No active hand' }); return; }
    try {
      const res = await placeMarketBet(auth.userId, tableId, handNumber, String(data?.marketId), String(data?.outcome), Number(data?.amount));
      if (!res.ok) { socket.emit('predictionError', { message: res.error || 'Bet rejected' }); return; }
      socket.emit('predictionBetPlaced', { handNumber, balance: res.balance, bet: res.bet });
    } catch { socket.emit('predictionError', { message: 'Bet failed' }); }
  });
  socket.on('getPredictionStats', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) return;
    try {
      const stats = await getSpectatorStats(auth.userId);
      socket.emit('predictionStats', { stats });
    } catch { socket.emit('predictionError', { message: 'Failed to load stats' }); }
  });
  socket.on('placePrediction', async (data: { tableId?: string; handId?: number; predictedSeat?: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) return;
    const tableId = data?.tableId || playerSessions.get(socket.id)?.tableId;
    const handNumber = Number(data?.handId);
    const seat = Number(data?.predictedSeat);
    if (!tableId || !Number.isFinite(handNumber) || !Number.isFinite(seat)) { socket.emit('predictionError', { message: 'No active hand' }); return; }
    try {
      const res = await placePick(auth.userId, tableId, handNumber, seat);
      if (!res.ok) { socket.emit('predictionError', { message: res.error || 'Pick rejected' }); return; }
      socket.emit('predictionPickPlaced', { handNumber, predictedSeat: seat });
    } catch { socket.emit('predictionError', { message: 'Pick failed' }); }
  });

  // ===== Social Bracket tournaments (durable + live) — Phase 3d 2026-06-18 =====
  const bracketRoom = (id: string) => `bracket:${String(id).toUpperCase()}`;
  socket.on('createSocialBracket', async (data: { bracketId?: string; name?: string; theme?: string; players?: string[] }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) { socket.emit('socialBracketError', { message: 'Sign in to create a bracket' }); return; }
    try {
      const res = await createBracket(auth.userId, String(data?.bracketId || ''), String(data?.name || 'Bracket'), String(data?.theme || 'neon'), Array.isArray(data?.players) ? data!.players! : []);
      if (!res.ok || !res.state) { socket.emit('socialBracketError', { message: res.error || 'Could not create' }); return; }
      socket.join(bracketRoom(res.state.bracketId));
      socket.emit('socialBracketRole', { bracketId: res.state.bracketId, isOrganizer: true });
      io.to(bracketRoom(res.state.bracketId)).emit('socialBracketState', res.state);
    } catch { socket.emit('socialBracketError', { message: 'Could not create' }); }
  });
  socket.on('getSocialBracket', async (data: { bracketId?: string }) => {
    const id = String(data?.bracketId || '').toUpperCase();
    if (!id) { socket.emit('socialBracketError', { message: 'No bracket id' }); return; }
    try {
      const state = await getBracket(id);
      if (!state) { socket.emit('socialBracketError', { message: 'Bracket not found' }); return; }
      const auth = authSessions.get(socket.id);
      socket.join(bracketRoom(id));
      socket.emit('socialBracketRole', { bracketId: id, isOrganizer: !!auth?.userId && auth.userId === state.createdBy });
      socket.emit('socialBracketState', state);
    } catch { socket.emit('socialBracketError', { message: 'Failed to load bracket' }); }
  });
  socket.on('socialBracketEliminate', async (data: { bracketId?: string; playerName?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth?.userId) { socket.emit('socialBracketError', { message: 'Not signed in' }); return; }
    try {
      const res = await eliminateBracketPlayer(String(data?.bracketId || ''), auth.userId, String(data?.playerName || ''));
      if (!res.ok || !res.state) { socket.emit('socialBracketError', { message: res.error || 'Could not eliminate' }); return; }
      io.to(bracketRoom(res.state.bracketId)).emit('socialBracketState', res.state);
    } catch { socket.emit('socialBracketError', { message: 'Could not eliminate' }); }
  });
  socket.on('placeSocialSideBet', async (data: { bracketId?: string; target?: string; amount?: number }) => {
    const auth = authSessions.get(socket.id);
    const bettor = auth?.username || 'Guest';
    try {
      const res = await addBracketSideBet(String(data?.bracketId || ''), bettor, String(data?.target || ''), Number(data?.amount));
      if (!res.ok || !res.state) { socket.emit('socialBracketError', { message: res.error || 'Could not place bet' }); return; }
      io.to(bracketRoom(res.state.bracketId)).emit('socialBracketState', res.state);
    } catch { socket.emit('socialBracketError', { message: 'Could not place bet' }); }
  });

  // ========== Sit Out ==========

  socket.on('sitOut', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    session.sittingOut = !session.sittingOut;
    socket.emit('sitOutToggled', { sittingOut: session.sittingOut });

    // Track sit-out for missed blinds (#16)
    if (session.sittingOut) {
      if (!sitOutTracker.has(session.tableId)) {
        sitOutTracker.set(session.tableId, new Set());
      }
      sitOutTracker.get(session.tableId)!.add(session.seatIndex);
      syncSitOutToTable(session.tableId);
    } else {
      // Returning from sit-out — remove from tracker and notify client of
      // any dead-blind debt still on the seat.
      sitOutTracker.get(session.tableId)?.delete(session.seatIndex);
      syncSitOutToTable(session.tableId);
      const tableForSitIn = tableManager.getTable(session.tableId);
      const seat = tableForSitIn?.seats?.[session.seatIndex];
      const owed = seat?.deadBlindOwedChips || 0;
      if (owed > 0) {
        socket.emit('missedBlinds', { amount: owed, type: seat?.missedBlind || 'big' });
      }
    }

    // If sitting out and it's currently their turn, auto-fold
    if (session.sittingOut) {
      const table = tableManager.getTable(session.tableId);
      if (table && table.activeSeatIndex === session.seatIndex) {
        table.playerFold(session.seatIndex);
        broadcastGameState(session.tableId);
      }
    }
  });

  // ========== AFK Handler ==========
  socket.on('playerAFK', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    session.sittingOut = true;
    if (!sitOutTracker.has(session.tableId)) sitOutTracker.set(session.tableId, new Set());
    sitOutTracker.get(session.tableId)!.add(session.seatIndex);
    syncSitOutToTable(session.tableId);

    socket.emit('sitOutToggled', { sittingOut: true, reason: 'afk' });

    // Auto-fold if it's currently their turn
    const table = tableManager.getTable(session.tableId);
    if (table && table.activeSeatIndex === session.seatIndex) {
      table.playerFold(session.seatIndex);
      broadcastGameState(session.tableId);
    }
  });

  socket.on('playerBack', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    session.sittingOut = false;
    const tracker = sitOutTracker.get(session.tableId);
    if (tracker) tracker.delete(session.seatIndex);
    // 2026-06-11 audit R12: push the cleared sit-out state into the engine.
    // Without this, the table's _sittingOutSeats still held this seat, so
    // markSittingOutBlinds kept accruing dead-blind debt against a player who
    // already came back (and the C11/C12 dead-blind skip kept treating them as
    // out). syncSitOutToTable rebuilds _sittingOutSeats from the live trackers.
    // (Their EXISTING owed dead blinds are intentionally preserved — they pay
    // those on their first hand back, standard missed-blind rule.)
    syncSitOutToTable(session.tableId);

    socket.emit('sitOutToggled', { sittingOut: false, reason: 'back' });
  });

  // ========== Fast Mode (#12) ==========
  socket.on('setFastMode', async (data: { enabled: boolean }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    // Only authenticated (registered) players can change fast mode
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Must be logged in to change fast mode' }); return; }
    fastModeTables.set(session.tableId, data.enabled);
    socket.emit('fastModeSet', { enabled: data.enabled });
  });

  // ========== Post Missed Blinds (refactored 2026-04-20) ==========
  // Delegates to PokerTable.postOwedBlindsNow which uses seat.deadBlindOwedChips
  // as the source of truth. Emits proper error codes so the client can
  // surface "Not enough chips" or "Nothing owed" instead of silently
  // failing. Adds dead money to totalInvestedThisHand ONLY — NOT currentBet
  // — so the post doesn't count toward the player's live call obligation.
  socket.on('postMissedBlinds', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) {
      socket.emit('missedBlindsError', { code: 'no_session', message: 'Not seated at a table.' });
      return;
    }
    const table = tableManager.getTable(session.tableId);
    if (!table) {
      socket.emit('missedBlindsError', { code: 'no_table', message: 'Table not found.' });
      return;
    }

    const result = table.postOwedBlindsNow(session.seatIndex);
    if (!result.ok) {
      const messages: Record<string, string> = {
        no_debt: 'You don\'t currently owe any dead blinds.',
        insufficient_chips: 'Not enough chips to post the owed blinds. Rebuy first.',
        invalid_seat: 'Invalid seat.',
      };
      socket.emit('missedBlindsError', {
        code: result.reason,
        message: messages[result.reason || ''] || 'Could not post blinds.',
      });
      return;
    }

    socket.emit('missedBlindsPosted', { amount: result.amount });
    const authSessionForAudit = authSessions.get(socket.id);
    if (authSessionForAudit) {
      auditLog(authSessionForAudit.username, 'DEAD_BLIND_POSTED', {
        tableId: session.tableId,
        seatIndex: session.seatIndex,
        amount: result.amount,
      });
    }
    broadcastGameState(session.tableId);
  });

  // ========== Show Mucked Hand ==========
  socket.on('showMuckedHand', async (data: { cards: any[] }) => {
    const session = playerSessions.get(socket.id);
    if (!session || !data?.cards?.length) return;

    const table = tableManager.getTable(session.tableId);
    if (!table) return;

    const seat = table.seats[session.seatIndex];
    // Only allow showing if player folded this hand
    if (!seat || !seat.folded) return;

    // Broadcast the reveal to everyone at the table
    io.to(`table:${session.tableId}`).emit('muckedHandRevealed', {
      playerName: session.playerName,
      seatIndex: session.seatIndex,
      cards: data.cards,
      timestamp: Date.now(),
    });
  });

  // ========== Training Mode ==========

  socket.on('toggleTraining', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    session.trainingEnabled = !session.trainingEnabled;
    socket.emit('trainingToggled', { enabled: session.trainingEnabled });

    // If training was just enabled, send current training data
    if (session.trainingEnabled) {
      const table = tableManager.getTable(session.tableId);
      if (table) {
        socket.emit(
          'gameState',
          getGameStateForPlayer(table, session.seatIndex, true)
        );
      }
    }
  });

  // ========== Bomb Pot ==========
  socket.on('triggerBombPot', async (data: { tableId?: string }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    // Only players seated at the table may trigger a bomb pot
    const tableId = data?.tableId || session.tableId;
    if (session.tableId !== tableId) return;

    // 2026-06-11 audit M1: rate-limit bomb pots so a seated griefer can't force
    // 2×BB antes every hand on a public cash table. One per 5 min per table.
    // (Full owner-only / private-only gating would need table-ownership
    // metadata these auto-created cash tables don't carry — cooldown is the
    // high-impact mitigation.)
    const nowMs = Date.now();
    const cdUntil = bombPotCooldownUntil.get(tableId) || 0;
    if (nowMs < cdUntil) {
      socket.emit('error', { message: `Bomb pot on cooldown — try again in ${Math.ceil((cdUntil - nowMs) / 1000)}s` });
      return;
    }
    bombPotCooldownUntil.set(tableId, nowMs + BOMB_POT_COOLDOWN_MS);
    bombPotPending.set(tableId, true);

    // Notify all players at the table
    io.to(`table:${tableId}`).emit('bombPotTriggered', { tableId });
  });

  // ========== Dealer's Choice ==========
  socket.on('enableDealersChoice', async (data: { tableId?: string; enabled: boolean }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    const tableId = data?.tableId || session.tableId;
    // Only players at this table may toggle dealer's choice
    if (session.tableId !== tableId) return;
    const table = tableManager.getTable(tableId);
    if (!table) return;

    if (data.enabled) {
      dealersChoiceState.set(tableId, {
        enabled: true,
        orbitCount: 0,
        currentVariantIndex: 0,
        dealerAtOrbitStart: table.dealerButtonSeat,
      });
    } else {
      dealersChoiceState.delete(tableId);
    }

    // Notify all players
    io.to(`table:${tableId}`).emit('dealersChoiceToggled', {
      tableId,
      enabled: data.enabled,
      currentVariant: data.enabled ? DEALERS_CHOICE_VARIANTS[0] : null,
    });

    broadcastGameState(tableId);
  });

  // ========== Quick-Play Formats ==========

  // Heads-Up Snap: 2 players, 5-minute fast game
  socket.on('quickHeadsUp', async (data: { playerName: string }) => {
    const { playerName } = data;

    // Leave existing table if any
    const existingSession = playerSessions.get(socket.id);
    if (existingSession) {
      handlePlayerLeave(socket);
    }

    // 2026-06-11 audit C2: real buy-in. An authed player pays the starting
    // stack from their wallet (and is credited the remaining stack on leave
    // via handlePlayerLeave) — without this deduct, the free stack was minted
    // on cash-out. Guests have no auth session, so handlePlayerLeave never
    // credits them: they stay wallet-isolated (free practice, no mint).
    const HEADS_UP_BUYIN = 1000;
    const authHU = authSessions.get(socket.id);
    if (authHU) {
      const dbChips = await ensureChipsForBuyIn(authHU.userId, authHU.username, HEADS_UP_BUYIN);
      if (HEADS_UP_BUYIN > dbChips) { socket.emit('error', { message: 'Not enough chips for the 1,000 buy-in' }); return; }
      if (!(await deductChips(authHU.userId, HEADS_UP_BUYIN))) { socket.emit('error', { message: 'Could not deduct chips — try again' }); return; }
      auditLog(authHU.username, 'QUICK_BUYIN_DEDUCT', { mode: 'headsUp', buyIn: HEADS_UP_BUYIN });
    }

    const tableId = tableManager.createHeadsUpTable(`Heads-Up Snap: ${playerName}`);
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, playerName, HEADS_UP_BUYIN, playerId, false);

    const session: PlayerSession = {
      socketId: socket.id,
      tableId,
      seatIndex: 0,
      playerName,
      playerId,
      trainingEnabled: false,
      sittingOut: false,
    };
    playerSessions.set(socket.id, session);
    socket.join(`table:${tableId}`);

    progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
    ensureTableProgressListener(table, tableId);

    // Add 1 Hard AI opponent
    if (!aiProfiles.has(tableId)) {
      aiProfiles.set(tableId, new Map());
    }
    const profiles = aiProfiles.get(tableId)!;
    const aiProfile = generateRandomProfile('hard');
    const aiPlayerId = `ai-${uuidv4()}`;
    table.sitDown(1, aiProfile.botName, 1000, aiPlayerId, true);
    profiles.set(1, aiProfile);

    // Start hand immediately
    table.startNewHand();
    broadcastGameState(tableId);
    sendProgressToPlayer(socket.id);
    scheduleAIAction(tableId);

    // Turbo blind escalation: double every 60 seconds
    const blindInterval = setInterval(() => {
      const t = tableManager.getTable(tableId);
      if (!t) {
        clearInterval(blindInterval);
        return;
      }
      t.config.smallBlind *= 2;
      t.config.bigBlind *= 2;
    }, 60000);

    // Store the interval and timeout for cleanup
    const headsUpKey = `headsup-${tableId}`;
    const headsUpTimers = new Map<string, { blindInterval: NodeJS.Timeout; gameTimeout: NodeJS.Timeout }>();

    // 5-minute game timer
    const gameTimeout = setTimeout(() => {
      clearInterval(blindInterval);
      const t = tableManager.getTable(tableId);
      if (!t) return;

      // Determine winner by chip count
      const seat0 = t.seats[0];
      const seat1 = t.seats[1];
      let winnerName = '';
      let winnerChips = 0;

      if (seat0.state === 'occupied' && seat1.state === 'occupied') {
        if (seat0.chipCount >= seat1.chipCount) {
          winnerName = seat0.playerName;
          winnerChips = seat0.chipCount;
        } else {
          winnerName = seat1.playerName;
          winnerChips = seat1.chipCount;
        }
      } else if (seat0.state === 'occupied') {
        winnerName = seat0.playerName;
        winnerChips = seat0.chipCount;
      } else if (seat1.state === 'occupied') {
        winnerName = seat1.playerName;
        winnerChips = seat1.chipCount;
      }

      io.to(`table:${tableId}`).emit('quickGameOver', {
        type: 'headsUp',
        winner: winnerName,
        chips: winnerChips,
        message: `Time's up! ${winnerName} wins with ${winnerChips} chips!`,
      });

      // Clean up
      cleanupQuickTable(tableId);
    }, 5 * 60 * 1000);

    quickGameTimers.set(tableId, { blindInterval, gameTimeout });
  });

  // Spin & Go: 3 players, random prize multiplier
  socket.on('quickSpinGo', async (data: { playerName: string }) => {
    const { playerName } = data;

    const existingSession = playerSessions.get(socket.id);
    if (existingSession) {
      handlePlayerLeave(socket);
    }

    // 2026-06-11 audit C2: real buy-in (500). Authed players pay from the
    // wallet; the winner's consolidated stack is credited back on leave via
    // handlePlayerLeave (3×500 in → up to 1500 out, no mint). The "prize" the
    // client shows is display-only — chips ARE the stack. Guests are
    // wallet-isolated (no auth → no credit on leave).
    const SPINGO_BUYIN = 500;
    const authSG = authSessions.get(socket.id);
    if (authSG) {
      const dbChips = await ensureChipsForBuyIn(authSG.userId, authSG.username, SPINGO_BUYIN);
      if (SPINGO_BUYIN > dbChips) { socket.emit('error', { message: 'Not enough chips for the 500 Spin & Go buy-in' }); return; }
      if (!(await deductChips(authSG.userId, SPINGO_BUYIN))) { socket.emit('error', { message: 'Could not deduct chips — try again' }); return; }
      auditLog(authSG.username, 'QUICK_BUYIN_DEDUCT', { mode: 'spinGo', buyIn: SPINGO_BUYIN });
    }

    // Random multiplier: 2x (60%), 3x (25%), 5x (10%), 10x (4%), 25x (1%)
    const roll = Math.random() * 100;
    let multiplier = 2;
    if (roll < 1) multiplier = 25;
    else if (roll < 5) multiplier = 10;
    else if (roll < 15) multiplier = 5;
    else if (roll < 40) multiplier = 3;
    else multiplier = 2;

    const tableId = tableManager.createQuickTable(
      `Spin & Go (${multiplier}x)`,
      3,
      10,
      20,
      SPINGO_BUYIN
    );
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, playerName, SPINGO_BUYIN, playerId, false);

    const session: PlayerSession = {
      socketId: socket.id,
      tableId,
      seatIndex: 0,
      playerName,
      playerId,
      trainingEnabled: false,
      sittingOut: false,
    };
    playerSessions.set(socket.id, session);
    socket.join(`table:${tableId}`);

    progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
    ensureTableProgressListener(table, tableId);

    // Add 2 AI opponents (medium-hard)
    if (!aiProfiles.has(tableId)) {
      aiProfiles.set(tableId, new Map());
    }
    const profiles = aiProfiles.get(tableId)!;
    const usedNames = new Set<string>([playerName]);

    for (let i = 1; i <= 2; i++) {
      const diff: Difficulty = Math.random() > 0.5 ? 'hard' : 'medium';
      let aiProfile = generateRandomProfile(diff);
      while (usedNames.has(aiProfile.botName)) {
        aiProfile = generateRandomProfile(diff);
      }
      usedNames.add(aiProfile.botName);
      const aiPlayerId = `ai-${uuidv4()}`;
      table.sitDown(i, aiProfile.botName, 500, aiPlayerId, true);
      profiles.set(i, aiProfile);
    }

    // Send spin reveal to client first
    socket.emit('spinReveal', { multiplier });

    // Start hand after reveal delay (3 seconds)
    setTimeout(() => {
      const t = tableManager.getTable(tableId);
      if (!t) return;
      t.startNewHand();
      broadcastGameState(tableId);
      sendProgressToPlayer(socket.id);
      scheduleAIAction(tableId);
    }, 3500);

    // Hyper-turbo blinds: double every 45 seconds
    const blindInterval = setInterval(() => {
      const t = tableManager.getTable(tableId);
      if (!t) {
        clearInterval(blindInterval);
        return;
      }
      t.config.smallBlind *= 2;
      t.config.bigBlind *= 2;
    }, 45000);

    // Store multiplier for prize calculation
    spinGoMultipliers.set(tableId, multiplier);

    // Listen for eliminations - last player standing wins
    const checkElimination = () => {
      const t = tableManager.getTable(tableId);
      if (!t) return;

      const alive = t.seats.filter(
        (s) => s.state === 'occupied' && s.chipCount > 0 && !s.eliminated
      );

      if (alive.length <= 1 && alive.length > 0) {
        clearInterval(blindInterval);
        const winner = alive[0];
        const prize = multiplier * 500; // multiplier * buy-in

        io.to(`table:${tableId}`).emit('quickGameOver', {
          type: 'spinGo',
          winner: winner.playerName,
          multiplier,
          prize,
          message: `${winner.playerName} wins ${prize} chips (${multiplier}x)!`,
        });

        // Clean up after a delay
        setTimeout(() => cleanupQuickTable(tableId), 5000);
      }
    };

    table.on('handResult', () => {
      setTimeout(checkElimination, 1000);
    });

    quickGameTimers.set(tableId, { blindInterval, gameTimeout: setTimeout(() => {}, 0) });
  });

  // All-In or Fold
  socket.on('quickAllInOrFold', async (data: { playerName: string }) => {
    const { playerName } = data;

    const existingSession = playerSessions.get(socket.id);
    if (existingSession) {
      handlePlayerLeave(socket);
    }

    // 2026-06-11 audit C2: real buy-in (1000). Authed players pay from the
    // wallet (credited back on leave); guests stay wallet-isolated.
    const AOF_BUYIN = 1000;
    const authAOF = authSessions.get(socket.id);
    if (authAOF) {
      const dbChips = await ensureChipsForBuyIn(authAOF.userId, authAOF.username, AOF_BUYIN);
      if (AOF_BUYIN > dbChips) { socket.emit('error', { message: 'Not enough chips for the 1,000 buy-in' }); return; }
      if (!(await deductChips(authAOF.userId, AOF_BUYIN))) { socket.emit('error', { message: 'Could not deduct chips — try again' }); return; }
      auditLog(authAOF.username, 'QUICK_BUYIN_DEDUCT', { mode: 'allInOrFold', buyIn: AOF_BUYIN });
    }

    const tableId = tableManager.createQuickTable(
      'All-In or Fold',
      6,
      10,
      20,
      AOF_BUYIN
    );
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, playerName, AOF_BUYIN, playerId, false);

    const session: PlayerSession = {
      socketId: socket.id,
      tableId,
      seatIndex: 0,
      playerName,
      playerId,
      trainingEnabled: false,
      sittingOut: false,
    };
    playerSessions.set(socket.id, session);
    socket.join(`table:${tableId}`);

    progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
    ensureTableProgressListener(table, tableId);

    // Fill with 5 AI (mixed difficulty)
    if (!aiProfiles.has(tableId)) {
      aiProfiles.set(tableId, new Map());
    }
    const profiles = aiProfiles.get(tableId)!;
    const usedNames = new Set<string>([playerName]);

    for (let i = 1; i <= 5; i++) {
      const difficulties: Difficulty[] = ['easy', 'medium', 'medium', 'hard', 'easy'];
      let aiProfile = generateRandomProfile(difficulties[i - 1]);
      while (usedNames.has(aiProfile.botName)) {
        aiProfile = generateRandomProfile(difficulties[i - 1]);
      }
      usedNames.add(aiProfile.botName);
      const aiPlayerId = `ai-${uuidv4()}`;
      table.sitDown(i, aiProfile.botName, 1000, aiPlayerId, true);
      profiles.set(i, aiProfile);
    }

    // Mark this as an all-in-or-fold table
    allInOrFoldTables.add(tableId);

    table.startNewHand();
    broadcastGameState(tableId);
    sendProgressToPlayer(socket.id);
    scheduleAIAction(tableId);

    // Notify client of game mode
    socket.emit('quickGameStarted', { type: 'allInOrFold' });
  });

  // ========== Career Mode ==========

  socket.on('startCareerGame', async (data: { venue: number; stage: number }) => {
    const { venue, stage } = data;

    const existingSession = playerSessions.get(socket.id);
    const careerPlayerName = existingSession?.playerName || 'Player';

    if (existingSession) {
      handlePlayerLeave(socket);
    }

    // Career venue configs
    const venueConfigs = [
      { name: 'Home Game', players: 4, difficulty: 'easy' as Difficulty, buyIn: 1000, blinds: [5, 10] },
      { name: 'Local Casino', players: 6, difficulty: 'medium' as Difficulty, buyIn: 5000, blinds: [25, 50] },
      { name: 'Vegas Strip', players: 8, difficulty: 'medium' as Difficulty, buyIn: 15000, blinds: [50, 100] },
      { name: 'Monte Carlo', players: 8, difficulty: 'hard' as Difficulty, buyIn: 50000, blinds: [100, 200] },
      { name: 'Macau', players: 9, difficulty: 'hard' as Difficulty, buyIn: 100000, blinds: [250, 500] },
      { name: 'WSOP Main Event', players: 9, difficulty: 'expert' as Difficulty, buyIn: 500000, blinds: [500, 1000] },
    ];

    if (venue < 0 || venue >= venueConfigs.length) {
      socket.emit('error', { message: 'Invalid venue' });
      return;
    }

    const config = venueConfigs[venue];

    // 2026-06-11 audit C2: real buy-in. Career seats the player with
    // config.buyIn (up to 500k at WSOP); an authed player pays it from the
    // wallet and is credited the remaining stack on leave (without this the
    // stack was minted on cash-out). Guests stay wallet-isolated.
    const authCareer = authSessions.get(socket.id);
    if (authCareer) {
      const dbChips = await ensureChipsForBuyIn(authCareer.userId, authCareer.username, config.buyIn);
      if (config.buyIn > dbChips) { socket.emit('error', { message: `Not enough chips for the ${config.name} buy-in (${config.buyIn.toLocaleString()})` }); return; }
      if (!(await deductChips(authCareer.userId, config.buyIn))) { socket.emit('error', { message: 'Could not deduct chips — try again' }); return; }
      auditLog(authCareer.username, 'QUICK_BUYIN_DEDUCT', { mode: 'career', venue: config.name, buyIn: config.buyIn });
    }

    // Stage 3 is the boss stage - harder AI
    const stageDifficulty: Difficulty =
      stage === 2
        ? (config.difficulty === 'easy' ? 'medium' : config.difficulty === 'medium' ? 'hard' : 'expert')
        : config.difficulty;

    const tableId = tableManager.createQuickTable(
      `${config.name} - Stage ${stage + 1}`,
      config.players,
      config.blinds[0],
      config.blinds[1],
      config.buyIn
    );
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, careerPlayerName, config.buyIn, playerId, false);

    const session: PlayerSession = {
      socketId: socket.id,
      tableId,
      seatIndex: 0,
      playerName: careerPlayerName,
      playerId,
      trainingEnabled: false,
      sittingOut: false,
    };
    playerSessions.set(socket.id, session);
    socket.join(`table:${tableId}`);

    progressionManager.getOrCreateProgress(playerId, careerPlayerName, authSessions.get(socket.id)?.userId);
    ensureTableProgressListener(table, tableId);

    // Fill with AI
    if (!aiProfiles.has(tableId)) {
      aiProfiles.set(tableId, new Map());
    }
    const profiles = aiProfiles.get(tableId)!;
    const usedNames = new Set<string>([careerPlayerName]);

    for (let i = 1; i < config.players; i++) {
      let aiProfile = generateRandomProfile(stageDifficulty);
      while (usedNames.has(aiProfile.botName)) {
        aiProfile = generateRandomProfile(stageDifficulty);
      }
      usedNames.add(aiProfile.botName);
      const aiPlayerId = `ai-${uuidv4()}`;
      table.sitDown(i, aiProfile.botName, config.buyIn, aiPlayerId, true);
      profiles.set(i, aiProfile);
    }

    // Mark as career table
    careerTables.set(tableId, { venue, stage });

    table.startNewHand();
    broadcastGameState(tableId);
    sendProgressToPlayer(socket.id);
    scheduleAIAction(tableId);

    socket.emit('careerGameStarted', { venue, stage, tableName: config.name });
  });

  // ========== Emote System ==========

  socket.on('emote', async (data: { emoteId: string }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    // Rate limit: 1 emote per 3 seconds
    const now = Date.now();
    const lastTime = lastEmoteTime.get(socket.id) || 0;
    if (now - lastTime < 3000) return;
    lastEmoteTime.set(socket.id, now);

    io.to(`table:${session.tableId}`).emit('emote', {
      seatIndex: session.seatIndex,
      emoteId: data.emoteId,
      playerName: session.playerName,
    });
  });

  // ========== Table Reactions ==========

  socket.on('tableReaction', async (data: { reactionId: string }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    // Rate limit: 1 reaction per 2 seconds
    const now = Date.now();
    const lastTime = lastReactionTime.get(socket.id) || 0;
    if (now - lastTime < 2000) return;
    lastReactionTime.set(socket.id, now);

    io.to(`table:${session.tableId}`).emit('tableReaction', {
      seatIndex: session.seatIndex,
      reactionId: data.reactionId,
      playerName: session.playerName,
    });
  });

  // ========== Spectator Mode ==========

  socket.on('spectate', async (data: { tableId: string }) => {
    const { tableId } = data;
    const table = tableManager.getTable(tableId);
    if (!table) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    // Leave current table if seated
    const existingSession = playerSessions.get(socket.id);
    if (existingSession) {
      handlePlayerLeave(socket);
    }

    // Add to spectators
    if (!spectators.has(tableId)) {
      spectators.set(tableId, new Set());
    }
    spectators.get(tableId)!.add(socket.id);
    socket.join(`table:${tableId}`);

    // Send spectator state (full state on first connect)
    const spectatorState = getGameStateForPlayer(table, -1, false);
    (spectatorState as any).isSpectator = true;
    (spectatorState as any).spectatorCount = spectators.get(tableId)!.size;
    emitGameState(socket, spectatorState, true);
    socket.emit('spectating', { tableId, tableName: table.config.tableName });
  });

  socket.on('stopSpectating', async () => {
    // Remove from all spectator lists
    for (const [tableId, specs] of spectators) {
      if (specs.has(socket.id)) {
        specs.delete(socket.id);
        socket.leave(`table:${tableId}`);
        if (specs.size === 0) spectators.delete(tableId);
      }
    }
    // Null state clears client — send as full reset and clear tracking
    socket.emit('gameState', { full: true, state: null });
    lastSentState.delete(socket.id); lastSentJson.delete(socket.id);
  });

  // ========== Theme Shop ==========

  socket.on('purchaseTheme', async (data: { themeId: string }) => {
    // 2026-06-19 fix: ThemeShop is opened from the LOBBY (not seated), so gate
    // on the auth session, not playerSessions (a table seat) — previously every
    // lobby purchase silently no-op'd. And the cost table now keys off the REAL
    // client theme ids; the old keys (gold/neon/classic/…) matched NONE of the
    // client's (classic_blue/casino_royale/…), so every buy fell through to the
    // flat `?? 400` regardless of the price shown.
    const ctx = await ensureHydrated(socket);
    if (!ctx) { socket.emit('error', { message: 'Not authenticated' }); return; }

    // Cost is looked up server-side — never trust cost from the client.
    const THEME_COSTS: Record<string, number> = {
      classic_blue: 0, casino_royale: 500, midnight_purple: 300,
      ocean_breeze: 400, royal_gold: 800, neon_vegas: 600,
    };
    const cost = THEME_COSTS[data.themeId] ?? 400;

    const result = progressionManager.purchaseTheme(ctx.playerId, data.themeId, cost);
    if (result.success) {
      socket.emit('themePurchased', { themeId: data.themeId });
    } else {
      socket.emit('error', { message: result.error || 'Purchase failed' });
    }
    const cp = progressionManager.getClientProgress(ctx.playerId);
    if (cp) socket.emit('playerProgress', cp);
  });

  socket.on('purchaseBattlePass', async (_data: unknown, callback?: (ack: { success: boolean; error?: string }) => void) => {
    const auth = authSessions.get(socket.id);
    const session = playerSessions.get(socket.id);
    const respond = (ack: { success: boolean; error?: string }) => { if (typeof callback === 'function') callback(ack); };
    if (!auth) { respond({ success: false, error: 'Not authenticated' }); return; }
    const playerId = session?.playerId;
    if (!playerId) { respond({ success: false, error: 'Not in a session' }); return; }
    const BATTLE_PASS_COST = 950;
    const result = progressionManager.purchaseTheme(playerId, '__battlepass_premium__', BATTLE_PASS_COST);
    if (!result.success) { respond({ success: false, error: result.error }); return; }
    await mergeUserStats(auth.userId, { battlePassPremium: true });
    sendProgressToPlayer(socket.id);
    respond({ success: true });
  });

  socket.on('equipTheme', async (data: { themeId: string }) => {
    // 2026-06-19 fix: same as purchaseTheme — equip is invoked from the lobby,
    // so gate on the auth session and push progress directly (sendProgressToPlayer
    // no-ops without a table seat).
    const ctx = await ensureHydrated(socket);
    if (!ctx) { socket.emit('error', { message: 'Not authenticated' }); return; }

    const result = progressionManager.equipTheme(ctx.playerId, data.themeId);
    if (result.success) {
      socket.emit('themeEquipped', { themeId: data.themeId });
    } else {
      socket.emit('error', { message: result.error || 'Equip failed' });
    }
    const cp = progressionManager.getClientProgress(ctx.playerId);
    if (cp) socket.emit('playerProgress', cp);
  });

  // ========== Detailed Stats ==========

  socket.on('getDetailedStats', async () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const stats = progressionManager.getDetailedStats(session.playerId);
    socket.emit('detailedStats', stats);
  });

  // ========== Tournament System ==========

  socket.on('getTournaments', async () => {
    socket.emit('tournamentList', tournamentManager.getTournamentList());
  });

  socket.on('registerTournament', async (data: { tournamentId: string; playerName: string }) => {
    const session = playerSessions.get(socket.id);
    const playerId = session?.playerId || `player-${uuidv4()}`;
    const playerName = data.playerName || session?.playerName || 'Player';

    // 2026-06-11 tournament economy: real entry fee. If the tournament has a
    // buy-in, the player must be logged in and pay it from their wallet — this
    // FUNDS the prize pool (TournamentManager.collectedEntryFees), and the
    // userId lets prizes credit back on finish. Free tournaments (buyIn 0) skip
    // the deduct. The deducted fee + the pool increment in registerPlayer stay
    // in lockstep so Σpayouts ≤ Σcollected (never mints).
    const tourn = tournamentManager.getTournament(data.tournamentId);
    if (!tourn) { socket.emit('error', { message: 'Tournament not found' }); return; }
    const entryFee = tourn.config.buyIn || 0;
    const authT = authSessions.get(socket.id);
    if (entryFee > 0) {
      if (!authT) { socket.emit('error', { message: 'Log in to enter a buy-in tournament' }); return; }
      const dbChips = await ensureChipsForBuyIn(authT.userId, authT.username, entryFee);
      if (entryFee > dbChips) { socket.emit('error', { message: `Not enough chips for the ${entryFee.toLocaleString()} entry fee` }); return; }
      if (!(await deductChips(authT.userId, entryFee))) { socket.emit('error', { message: 'Could not deduct entry fee — try again' }); return; }
      auditLog(authT.username, 'TOURNAMENT_ENTRY_DEDUCT', { tournamentId: data.tournamentId, entryFee });
    }

    const result = tournamentManager.registerPlayer(data.tournamentId, playerId, playerName, socket.id, authT?.userId);
    if (result.success) {
      socket.emit('tournamentRegistered', { tournamentId: data.tournamentId });

      // Check if tournament can auto-start
      if (tournamentManager.canStart(data.tournamentId)) {
        startTournamentGame(data.tournamentId);
      }
    } else {
      // Registration failed AFTER the deduct — refund the wallet. (registerPlayer
      // only increments the pool on success, so the pool needs no back-out here.)
      if (entryFee > 0 && authT) {
        await addChipsToUser(authT.userId, entryFee);
        auditLog(authT.username, 'TOURNAMENT_ENTRY_REFUND', { tournamentId: data.tournamentId, entryFee });
      }
      socket.emit('error', { message: result.error || 'Registration failed' });
    }

    // Broadcast updated list
    io.emit('tournamentList', tournamentManager.getTournamentList());
  });

  // Start a simulated multi-table tournament
  socket.on('startSimulatedTournament', async (data: { playerCount?: number; turbo?: boolean }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Must be logged in' }); return; }

    const session = playerSessions.get(socket.id);
    const playerCount = data?.playerCount || 200;
    const turbo = data?.turbo || false;

    const result = startMultiTableTournament(
      playerCount,
      socket.id,
      session?.playerId || auth.username,
      session?.playerName || auth.username,
      turbo,
    );

    if (result) {
      socket.emit('simulatedTournamentStarted', {
        tournamentId: result.tournamentId,
        tableCount: result.tableCount,
        playerCount,
        turbo,
      });
    } else {
      socket.emit('error', { message: 'Failed to start tournament simulation' });
    }
  });

  // Toggle tournament speed
  socket.on('setTournamentSpeed', async (data: { tournamentId: string; turbo: boolean }) => {
    // 2026-06-19 fix: gate on admin. Previously ANY connected socket could flip
    // ANY tournament's turbo mode (it only needed a tournamentId) — an
    // unauthorized control over every player's tournament pace.
    const auth = authSessions.get(socket.id);
    if (!auth || !(await isUserAdmin(auth.userId))) { socket.emit('error', { message: 'Access denied' }); return; }
    const tournament = tournamentManager.getTournament(data.tournamentId);
    if (!tournament) return;
    tournament.turboMode = data.turbo;
    for (const tid of tournament.tableIds) {
      fastModeTables.set(tid, data.turbo);
    }
  });

  // ========== Multi-Table Support ==========

  socket.on('joinAdditionalTable', async (data: { tableId: string; playerName: string; buyIn: number; avatar?: string }) => {
    const { tableId, playerName, buyIn, avatar } = data;
    const table = tableManager.getTable(tableId);
    if (!table) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    // Find empty seat
    let targetSeat = -1;
    for (let i = 0; i < MAX_SEATS; i++) {
      if (table.seats[i].state === 'empty') {
        targetSeat = i;
        break;
      }
      if (table.seats[i].state === 'occupied' && table.seats[i].isAI) {
        table.standUp(i);
        const profiles = aiProfiles.get(tableId);
        if (profiles) profiles.delete(i);
        targetSeat = i;
        break;
      }
    }

    if (targetSeat === -1) {
      socket.emit('error', { message: 'No seats available' });
      return;
    }

    // 2026-06-11 audit C9+C6: this path previously seated an additional cash
    // table for FREE (no deductChips). Combined with the cash-out credit on
    // leave (also added in C9) that's a mint. Make it a real cash buy-in:
    // clamp the client buy-in to the table's [minBuyIn, maxBuyIn] (C6) and
    // deduct it. The remaining stack is credited back on leave (multi-table
    // cleanup in handlePlayerLeave).
    const effectiveBuyIn = Math.max(
      table.config.minBuyIn,
      Math.min(buyIn || table.config.minBuyIn, table.config.minBuyIn * 10) // C6: 10× heuristic cap (no maxBuyIn field)
    );
    const authAdd = authSessions.get(socket.id);
    if (authAdd) {
      const dbChips = await ensureChipsForBuyIn(authAdd.userId, authAdd.username, effectiveBuyIn);
      if (effectiveBuyIn > dbChips) { socket.emit('error', { message: 'Insufficient chips for the additional-table buy-in' }); return; }
      if (!(await deductChips(authAdd.userId, effectiveBuyIn))) { socket.emit('error', { message: 'Could not deduct chips — try again' }); return; }
      auditLog(authAdd.username, 'ADDITIONAL_TABLE_BUYIN', { tableId, buyIn: effectiveBuyIn });
    }

    const playerId = `player-${uuidv4()}`;
    // Ghost-seat defense (multi-table / joinTableAsPlayer path).
    {
      const authNow = authSessions.get(socket.id);
      if (authNow) clearGhostSeatsForUser(authNow.userId, tableId, socket.id, targetSeat);
    }
    const success = table.sitDown(targetSeat, playerName, effectiveBuyIn, playerId, false);
    if (!success) {
      // Refund the buy-in we just deducted — we never seated them.
      if (authAdd) {
        await addChipsToUser(authAdd.userId, effectiveBuyIn);
        auditLog(authAdd.username, 'ADDITIONAL_TABLE_BUYIN_REFUND', { tableId, buyIn: effectiveBuyIn });
      }
      socket.emit('error', { message: 'Could not join table' });
      return;
    }

    const session: PlayerSession = {
      socketId: socket.id,
      tableId,
      seatIndex: targetSeat,
      playerName,
      playerId,
      trainingEnabled: false,
      sittingOut: false,
      avatar: avatar || undefined,
    };

    if (!multiTableSessions.has(socket.id)) {
      multiTableSessions.set(socket.id, []);
    }
    multiTableSessions.get(socket.id)!.push(session);
    socket.join(`table:${tableId}`);

    progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
    ensureTableProgressListener(table, tableId);
    fillWithAI(table, tableId);

    socket.emit('additionalTableJoined', {
      tableId,
      seatIndex: targetSeat,
      gameState: getGameStateForPlayer(table, targetSeat),
    });

    broadcastGameState(tableId);
  });

  socket.on('leaveAdditionalTable', async (data: { tableId: string }) => {
    const sessions = multiTableSessions.get(socket.id);
    if (!sessions) return;

    const idx = sessions.findIndex((s) => s.tableId === data.tableId);
    if (idx === -1) return;

    const session = sessions[idx];
    const table = tableManager.getTable(session.tableId);
    if (table) {
      if (table.isHandInProgress() && table.activeSeatIndex === session.seatIndex) {
        table.playerFold(session.seatIndex);
      }
      table.standUp(session.seatIndex);
      broadcastGameState(session.tableId);
    }

    sessions.splice(idx, 1);
    socket.leave(`table:${data.tableId}`);
  });

  socket.on('switchTable', async (data: { tableId: string }) => {
    // Client-side only - just acknowledge
    socket.emit('tableSwitched', { tableId: data.tableId });
  });

  socket.on('leaveTable', async () => {
    handlePlayerLeave(socket);
  });

  // ── Private Home Games ─────────────────────────────────────────────────────
  socket.on('createPrivateTable', (data: {
    tableName: string;
    variant: string;
    smallBlind: number;
    bigBlind: number;
    ante: number;
    minBuyIn: number;
    maxSeats: number;
    straddle: boolean;
    runItTwice: boolean;
    bombPot: boolean;
  }) => {
    const tableId = tableManager.createVariantTable({
      tableName: data.tableName || 'Private Table',
      smallBlind: Math.max(1, data.smallBlind || 25),
      bigBlind: Math.max(2, data.bigBlind || 50),
      ante: data.ante || 0,
      minBuyIn: data.minBuyIn || 1000,
    }, (data.variant as any) || 'texas-holdem');

    // 2026-06-11 audit M2: the createPrivateTable payload advertised straddle /
    // runItTwice / bombPot toggles but the handler dropped all three silently.
    // bombPot has a real mechanism (bombPotPending → activateBombPotIfPending),
    // so honor it for the table's first hand. straddle + runItTwice are not yet
    // implemented — log when requested so it's visible rather than a silent
    // no-op (a host who toggled them deserves to know they did nothing).
    if (data.bombPot) {
      bombPotPending.set(tableId, true);
    }
    if (data.straddle || data.runItTwice) {
      log.warn(`[createPrivateTable] ${tableId}: requested unimplemented option(s) ${[data.straddle && 'straddle', data.runItTwice && 'runItTwice'].filter(Boolean).join(', ')} — ignored`);
    }

    // Simple invite code = first 8 chars of tableId
    const inviteCode = tableId.slice(0, 8).toUpperCase();

    socket.emit('privateTableCreated', { tableId, inviteCode });
    console.log(`[privateTable] Created ${tableId} (invite: ${inviteCode})`);
  });

  socket.on('joinByInviteCode', async (data: { inviteCode: string; playerName: string; buyIn: number; avatar?: any }) => {
    const { inviteCode, playerName, buyIn, avatar } = data;
    // Find table whose ID starts with the invite code (lowercased)
    const target = tableManager.getTableByInviteCode(inviteCode.toLowerCase());
    if (!target) {
      socket.emit('joinError', { message: 'Table not found for that invite code.' });
      return;
    }
    const { tableId, table } = target;

    // Find an open seat
    const openSeat = table.seats.findIndex((s) => s.state === 'empty');
    if (openSeat === -1) {
      socket.emit('joinError', { message: 'Table is full.' });
      return;
    }

    // 2026-06-19 Phase 4: clamp the client buy-in to [minBuyIn, minBuyIn*10],
    // matching joinTable's audit-C6 cap (this invite path only enforced the
    // minimum). Own-wallet + balance-checked below, so not a mint — this is the
    // same table-economics/SPR fairness bound.
    const actualBuyIn = Math.min(table.config.minBuyIn * 10, Math.max(table.config.minBuyIn, buyIn || table.config.minBuyIn));

    // Server-authoritative chip deduction for authenticated users — previously
    // this path bypassed deductChips entirely, letting a player multi-table
    // the same chips across private invites. Testing mode auto-top-up too.
    const authForJoin = authSessions.get(socket.id);
    let chipsDeducted = false;
    if (authForJoin) {
      const dbChips = await ensureChipsForBuyIn(authForJoin.userId, authForJoin.username, actualBuyIn);
      if (actualBuyIn > dbChips) {
        socket.emit('joinError', { message: 'Insufficient chips for this table.' });
        return;
      }
      if (!(await deductChips(authForJoin.userId, actualBuyIn))) {
        socket.emit('joinError', { message: 'Could not deduct chips — try again.' });
        return;
      }
      chipsDeducted = true;
      auditLog(authForJoin.username, 'INVITE_BUY_IN_DEDUCT', { tableId, buyIn: actualBuyIn });
    }

    const playerId = `player-${uuidv4()}`;
    const success = table.sitDown(openSeat, playerName, actualBuyIn, playerId, false);

    if (!success) {
      if (chipsDeducted && authForJoin) {
        try {
          await addChipsToUser(authForJoin.userId, actualBuyIn);
          auditLog(authForJoin.username, 'INVITE_REFUND', { tableId, buyIn: actualBuyIn, reason: 'sitDown_failed' });
        } catch {}
      }
      socket.emit('joinError', { message: 'Could not seat you at that table.' });
      return;
    }

    const session: PlayerSession = {
      socketId: socket.id, tableId, seatIndex: openSeat, playerName, playerId,
      trainingEnabled: false, sittingOut: false, avatar: avatar || undefined,
    };
    playerSessions.set(socket.id, session);
    socket.join(`table:${tableId}`);
    progressionManager.getOrCreateProgress(playerId, playerName, authSessions.get(socket.id)?.userId);
    ensureTableProgressListener(table, tableId);
    fillWithAI(table, tableId);

    // Send full state to the joining player (force full on join/reconnect)
    emitGameState(socket, getGameStateForPlayer(table, openSeat), true);
    // Broadcast to all other players at the table using delta compression
    for (const [sid, sess] of playerSessions) {
      if (sess.tableId === tableId && sid !== socket.id) {
        const peerSocket = io.sockets.sockets.get(sid);
        if (peerSocket) emitGameState(peerSocket, getGameStateForPlayer(table, -1));
      }
    }
  });

  // ── Coach whisper (relay from coach to student) ───────────────────────
  socket.on('coachWhisper', async (data: { targetSocketId: string; message: string; coachName?: string }) => {
    // Must be authenticated to send whispers
    const auth = authSessions.get(socket.id);
    if (!auth) return;
    if (!data.targetSocketId || !data.message) return;
    // Prevent whisper to self
    if (data.targetSocketId === socket.id) return;
    io.to(data.targetSocketId).emit('coachWhisper', {
      message: data.message,
      coachName: data.coachName || auth.username,
    });
  });

  // ── Session recap — generate LLM recap at session end ─────────────────
  socket.on('requestSessionRecap', async (data: {
    handsPlayed: number; netChips: number; winRate: number;
    biggestPot: number; sessionMinutes: number;
  }) => {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const prompt = `You are a poker coach writing a brief post-session analysis. Session stats:
- Hands: ${data.handsPlayed}
- Net: ${data.netChips > 0 ? '+' : ''}${data.netChips} chips
- Win rate: ${data.winRate}%
- Biggest pot: ${data.biggestPot} chips
- Duration: ${data.sessionMinutes} minutes

Write exactly 3 short paragraphs (2-3 sentences each):
1. What went well (or a silver lining if losing session)
2. The biggest leak to work on
3. One specific tip for the next session

Keep it direct and encouraging. No headers, just 3 paragraphs separated by newlines.`;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = (msg.content[0] as any).text || '';
      const paragraphs = text.split('\n\n').filter((p: string) => p.trim());
      socket.emit('sessionRecapResult', {
        success: true,
        paragraphs: {
          whatWentWell: paragraphs[0] || '',
          biggestLeak: paragraphs[1] || '',
          nextSession: paragraphs[2] || '',
        },
      });
    } catch {
      socket.emit('sessionRecapResult', { success: false });
    }
  });

  // ── Prediction market ─────────────────────────────────────────────────
  // 2026-06-19 Phase 4: the old `marketBet`/`marketResolve` socket handlers
  // were REMOVED. They took the wager `amount` from the client, never
  // deducted it, had no auth/identity gate, and let ANY socket resolve a
  // market and declare the winning outcome — emitting a `marketResult`
  // payout. They were dead the moment Phase 3c replaced the client with the
  // server-authoritative `placePredictionBet` / `predictionSettled` path
  // (see social/predictionManager.ts) — nothing emits `marketBet` anymore.
  // Leaving an unauthenticated, client-amount payout path wired up is a
  // latent chip-mint, so it's deleted rather than left dormant.

  socket.on('disconnect', async () => {
    console.log(`Player disconnected: ${socket.id}`);

    const authSession = authSessions.get(socket.id);
    const session = playerSessions.get(socket.id);

    // Auto-save progress on disconnect
    if (authSession && session) {
      const table = tableManager.getTable(session.tableId);
      if (table) {
        const seat = table.seats[session.seatIndex];
        if (seat && seat.state === 'occupied') {
          // CRITICAL: do NOT write `chips: seat.chipCount` here.
          // seat.chipCount is the AT-TABLE stack. users.chips is the
          // OFF-TABLE wallet (already decremented by deductChips at
          // sit-down). Writing seat.chipCount into users.chips would
          // clobber the wallet with the tiny at-table amount — this
          // was the cause of "I had a billion chips, now I have 100K"
          // reports. The at-table stack is preserved in reservedSeats
          // below and restored on reconnect; the wallet stays untouched.
          const prog = progressionManager.getClientProgress(session.playerId) as any;
          // Per CLAUDE.md: never persist progress that hasn't been hydrated — pre-hydrate in-memory zeros can clobber real DB data.
          if (prog?.hydrated) {
            await saveProgress(authSession.userId, {
              xp: prog?.xp,
              level: prog?.level,
              achievements: prog?.achievements || [],
            });
          } else {
            console.warn(`[disconnect] SKIPPED saveProgress for userId=${authSession.userId} — progress not hydrated yet (would have overwritten real values with fresh-init)`);
          }

          // Reserve the seat for 10 minutes so the player can reconnect
          // Cancel any existing reservation for this user first
          const existing = reservedSeats.get(authSession.userId);
          if (existing) clearTimeout(existing.cleanupTimer);

          const cleanupTimer = setTimeout(() => {
            const reserved = reservedSeats.get(authSession.userId);
            if (reserved) {
              const t = tableManager.getTable(reserved.tableId);
              const seatNow = t?.seats?.[reserved.seatIndex];
              const chipsToReturn = seatNow?.chipCount ?? reserved.chips ?? 0;
              // Credit the at-table stack back to the wallet before
              // the seat is torn down. Otherwise the chips vanish.
              if (chipsToReturn > 0) {
                addChipsToUser(authSession.userId, chipsToReturn).catch((e: any) =>
                  console.warn(`[Reserve expiry cash-out ${authSession.userId}]`, e?.message)
                );
              }
              // Clean the sit-out tracker so the NEXT occupant of this
              // seat doesn't inherit a stale sitting-out flag (root cause
              // of recurring "missed blinds" popup on a fresh sit-down).
              const tr = sitOutTracker.get(reserved.tableId);
              if (tr) tr.delete(reserved.seatIndex);
              if (t) t.standUp(reserved.seatIndex);
              syncSitOutToTable(reserved.tableId);
              reservedSeats.delete(authSession.userId);
              console.log(`[Reserve] Seat reservation expired for user ${authSession.userId} (returned ${chipsToReturn} chips)`);
            }
          }, SEAT_RESERVE_MS);

          reservedSeats.set(authSession.userId, {
            tableId: session.tableId,
            seatIndex: session.seatIndex,
            playerName: session.playerName,
            chips: seat.chipCount,
            avatar: session.avatar,
            sittingOut: session.sittingOut,
            expiresAt: Date.now() + SEAT_RESERVE_MS,
            cleanupTimer,
            handsRemaining: DISCONNECT_HANDS_LIMIT,
          });

          // Auto-fold if it's their turn right now. That's the ONLY
          // behavior we need on disconnect. Previously we ALSO flagged
          // the seat as sitting-out after a 20s timer so future hands'
          // markSittingOutBlinds would charge dead-blind debt — but
          // PWA backgrounding / WiFi handoff / iOS suspend triggered
          // that timer on users who never actually sat out, leading to
          // a recurring "missed blinds" popup. The `reservedSeats`
          // mechanism + turn-auto-fold already handle the disconnect
          // case cleanly; there's no reason to double-flag with the
          // sit-out tracker. If the user really wants to sit out,
          // they'll tap the explicit Sit Out button.
          session.sittingOut = false;

          if (table.isHandInProgress() && table.activeSeatIndex === session.seatIndex) {
            table.playerFold(session.seatIndex);
            broadcastGameState(session.tableId);
          }

          console.log(`[Reserve] Seat ${session.seatIndex} on table ${session.tableId} reserved for user ${authSession.userId} (${session.playerName})`);

          // 2026-06-11 audit E4: only the MAIN seat is reserved here. Any
          // ADDITIONAL-table seats are NOT reserved, and this branch returns
          // before handlePlayerLeave's multi-table cleanup ever runs — so they
          // lingered occupied (auto-folding, unreconnectable). Cash them out +
          // stand up before the early return. (Tournament stacks are skipped
          // by creditSeatStackToWallet's guard, so this only affects cash.)
          const multiD = multiTableSessions.get(socket.id);
          if (multiD) {
            for (const ms of multiD) {
              const mt = tableManager.getTable(ms.tableId);
              if (mt) {
                if (mt.isHandInProgress() && mt.activeSeatIndex === ms.seatIndex) {
                  try { mt.playerFold(ms.seatIndex); } catch {}
                }
                const mSeat = mt.seats[ms.seatIndex];
                if (mSeat && mSeat.state === 'occupied' && !mSeat.isAI) {
                  creditSeatStackToWallet(authSession.userId, authSession.username, ms.tableId, mSeat, 'additional_table_disconnect');
                }
                mt.standUp(ms.seatIndex);
              }
              socket.leave(`table:${ms.tableId}`);
              broadcastGameState(ms.tableId);
            }
            multiTableSessions.delete(socket.id);
          }

          // Don't call handlePlayerLeave — main seat stays reserved
          playerSessions.delete(socket.id);
          authSessions.delete(socket.id);
          lastSentState.delete(socket.id); lastSentJson.delete(socket.id);
          return;
        }
      }
    }

    // 2026-06-11 audit C9: call handlePlayerLeave FIRST, then delete the auth
    // session. handlePlayerLeave's cash-out paths (main seat + additional
    // tables) read authSessions.get(socket.id) to know whom to credit;
    // deleting auth beforehand made those credits silently no-op. (The
    // common seated-disconnect case already returns early via the reserve
    // branch above; this guards the multi-table / fallthrough cases.)
    handlePlayerLeave(socket);
    if (authSession) authSessions.delete(socket.id);
    // Clear delta tracking so a reconnect gets a fresh full state
    lastSentState.delete(socket.id); lastSentJson.delete(socket.id);
  });
});

// 2026-06-11 audit C8: credit a seat's at-table stack back to the user's
// wallet before the seat is torn down. Mirrors the inline cash-out in
// handlePlayerLeave (fire-and-forget additive credit + auditable
// success/failure). Used by clearGhostSeatsForUser, which previously
// stood up occupied seats WITHOUT crediting — destroying a real, wallet-
// backed stack (e.g. an OAuth reconnect to a different seat that bypassed
// handlePlayerLeave). Safe against double-credit: callers only invoke it
// on seats still state==='occupied' (handlePlayerLeave sets them 'empty'),
// so a seat already cashed out won't be credited twice.
function creditSeatStackToWallet(
  userId: number, username: string, tableId: string, seat: any, reason: string
): void {
  const chips = (seat && seat.chipCount) || 0;
  if (chips <= 0) return;
  // 2026-06-11 audit (tournament economy): NEVER credit a tournament-table
  // stack to the wallet. Tournament stacks are tournament chips, not
  // wallet-funded — entry is a separate buy-in/fee and payouts come from the
  // prize pool by finish position. Crediting the stack on leave/bust both
  // MINTS chips (the stack was never deducted) AND, because these are
  // multi-table tournaments that rebalance, lets a player EXTRACT chips still
  // in play by leaving mid-tournament with a doubled-up stack. The prize
  // payout path (handleTournamentFinished) is the only sanctioned tournament
  // wallet credit.
  if (tournamentTables.has(tableId)) {
    auditLog(username, 'TOURNAMENT_STACK_NOT_CASHED', { userId, tableId, reason, chips });
    return;
  }
  addChipsToUser(userId, chips)
    .then((ok: boolean) => {
      if (!ok) {
        console.error(`[creditSeatStackToWallet] addChipsToUser false userId=${userId} amount=${chips} (${reason})`);
        auditLog(username, 'CASH_OUT_FAILED', { userId, tableId, amount: chips, reason: reason + '_returned_false' });
      } else {
        auditLog(username, 'CASH_OUT', { userId, tableId, amount: chips, reason });
      }
    })
    .catch((e: any) => {
      console.error(`[creditSeatStackToWallet ${userId}] amount=${chips} (${reason})`, e?.message || e);
      if (Sentry) Sentry.captureException(e, { tags: { area: 'chip.cashOut' }, extra: { userId, tableId, amount: chips, reason } });
      auditLog(username, 'CASH_OUT_FAILED', { userId, tableId, amount: chips, error: String(e?.message || e) });
    });
}

function handlePlayerLeave(socket: Socket): void {
  const session = playerSessions.get(socket.id);
  if (!session) return;

  const table = tableManager.getTable(session.tableId);
  if (table) {
    // 2026-06-11 audit C7: decide whether this seat's teardown must be
    // DEFERRED to hand-end. If the player is leaving mid-hand while still
    // holding chips in the live pot (totalInvestedThisHand > 0, not folded),
    // an immediate standUp would erase their pot contribution (calculatePots
    // only sees occupied seats) and short-pay the winner. In that case we
    // fold them now (dead money stays in the pot) and keep the seat until
    // the hand resolves; processPendingSeatRemovals() does the credit+standUp.
    const leavingSeatEarly = table.seats[session.seatIndex];
    const deferRemoval =
      table.isHandInProgress() &&
      !!leavingSeatEarly &&
      leavingSeatEarly.state === 'occupied' &&
      !leavingSeatEarly.isAI &&
      !leavingSeatEarly.folded &&
      (leavingSeatEarly.totalInvestedThisHand || 0) > 0;

    // Fold first if the hand is live. Active seat → playerFold (advances the
    // turn). Non-active deferred leaver → forceFoldSeat (mark folded WITHOUT
    // advancing, so the real actor keeps the action and the table doesn't
    // wedge waiting on a gone player).
    if (table.isHandInProgress()) {
      if (table.activeSeatIndex === session.seatIndex) {
        table.playerFold(session.seatIndex);
      } else if (deferRemoval) {
        table.forceFoldSeat(session.seatIndex);
      }
    }

    // Clear sit-out tracker + any dead-blind debt on the vacated seat
    // before standing up. Without this, the NEXT occupant of this seat
    // index inherits stale missed-blind state — the exact "first hand
    // I sit down, missed blinds popup" bug. syncSitOutToTable below
    // has a defensive filter too, but clearing explicitly here means
    // the tracker never even briefly contains a stale seat index.
    const tracker = sitOutTracker.get(session.tableId);
    if (tracker) tracker.delete(session.seatIndex);
    const leavingSeat = table.seats[session.seatIndex];
    if (leavingSeat) {
      leavingSeat.deadBlindOwedChips = 0;
      leavingSeat.missedBlind = 'none';
    }
    syncSitOutToTable(session.tableId);

    // CRITICAL: credit the at-table stack back to the user's wallet
    // before standUp clears it. deductChips() took the buy-in at sit-
    // down time; if we standUp without crediting, those chips vanish.
    //
    // Refund failures MUST be auditable — previously this only `console.warn`d
    // and the chips vanished silently. Now we auditLog(FAILED) so an operator
    // can manually reconcile from the audit trail. Still fire-and-forget
    // because we can't block the user's standUp on a DB retry loop — but
    // the failure is permanently recorded.
    if (deferRemoval) {
      // C7: do NOT credit/standUp yet — the seat stays occupied+folded so
      // its committed chips remain in the pot for the award. Record who to
      // credit; processPendingSeatRemovals() (handResult hook) finishes the
      // teardown after the hand resolves.
      const authDefer = authSessions.get(socket.id);
      if (authDefer) {
        let m = pendingSeatRemovalAfterHand.get(session.tableId);
        if (!m) { m = new Map(); pendingSeatRemovalAfterHand.set(session.tableId, m); }
        m.set(session.seatIndex, { userId: authDefer.userId, username: authDefer.username });
      } else {
        // No auth to credit (shouldn't happen for a seated player) — fall
        // back to immediate teardown rather than stranding the seat forever.
        table.standUp(session.seatIndex);
      }
      broadcastGameState(session.tableId);
    } else {
      const auth = authSessions.get(socket.id);
      const chipsToReturn = leavingSeat?.chipCount || 0;
      // 2026-06-11 audit (tournament economy): do NOT cash out a tournament-
      // table stack — it's tournament chips, not wallet-funded. Crediting it
      // mints chips / lets a player extract chips still in play. See the same
      // guard in creditSeatStackToWallet. Prizes are paid by finish position.
      const isTournamentSeat = tournamentTables.has(session.tableId);
      if (isTournamentSeat && auth && chipsToReturn > 0) {
        auditLog(auth.username, 'TOURNAMENT_STACK_NOT_CASHED', { userId: auth.userId, tableId: session.tableId, amount: chipsToReturn, reason: 'handlePlayerLeave' });
      }
      if (auth && chipsToReturn > 0 && !isTournamentSeat) {
        addChipsToUser(auth.userId, chipsToReturn)
          .then((ok) => {
            if (!ok) {
              console.error(`[handlePlayerLeave] addChipsToUser returned false for userId=${auth.userId}, amount=${chipsToReturn}`);
              auditLog(auth.username, 'CASH_OUT_FAILED', { userId: auth.userId, tableId: session.tableId, amount: chipsToReturn, reason: 'addChipsToUser_returned_false' });
            } else {
              auditLog(auth.username, 'CASH_OUT', { userId: auth.userId, tableId: session.tableId, amount: chipsToReturn });
            }
          })
          .catch((e: any) => {
            console.error(`[handlePlayerLeave cash-out ${auth.userId}] amount=${chipsToReturn}`, e?.message || e);
            if (Sentry) Sentry.captureException(e, { tags: { area: 'chip.cashOut' }, extra: { userId: auth.userId, tableId: session.tableId, amount: chipsToReturn } });
            auditLog(auth.username, 'CASH_OUT_FAILED', { userId: auth.userId, tableId: session.tableId, amount: chipsToReturn, error: String(e?.message || e) });
          });
      }

      table.standUp(session.seatIndex);

      // Check if any human players remain
      const humanCount = table.seats.filter(
        (s) => s.state === 'occupied' && !s.isAI
      ).length;

      if (humanCount === 0) {
        // Remove all AI players
        for (let i = 0; i < MAX_SEATS; i++) {
          if (table.seats[i].state === 'occupied' && table.seats[i].isAI) {
            table.standUp(i);
          }
        }
        aiProfiles.delete(session.tableId);

        // Clear any AI timeouts
        const timeoutKey = session.tableId;
        if (aiTimeouts.has(timeoutKey)) {
          clearTimeout(aiTimeouts.get(timeoutKey)!.handle);
          aiTimeouts.delete(timeoutKey);
        }
        // Cancel any pending auto-start hand timer — table is empty
        const pendingStart = pendingAutoStartTimers.get(session.tableId);
        if (pendingStart) {
          clearTimeout(pendingStart);
          pendingAutoStartTimers.delete(session.tableId);
        }
      } else {
        broadcastGameState(session.tableId);
      }
    }

    socket.leave(`table:${session.tableId}`);
  }

  playerSessions.delete(socket.id);

  // Clean up multi-table sessions
  const multiSessions = multiTableSessions.get(socket.id);
  if (multiSessions) {
    const authForMulti = authSessions.get(socket.id);
    for (const ms of multiSessions) {
      const mt = tableManager.getTable(ms.tableId);
      if (mt) {
        if (mt.isHandInProgress() && mt.activeSeatIndex === ms.seatIndex) {
          mt.playerFold(ms.seatIndex);
        }
        // 2026-06-11 audit C9: credit the additional-table stack back to the
        // wallet before teardown. joinAdditionalTable deducts a real buy-in
        // for each extra seat; the old code stood these seats up WITHOUT
        // crediting, so a multi-tabling player silently LOST every
        // additional-table stack on leave (only the main seat was cashed
        // out). Mirrors handlePlayerLeave's main-seat cash-out.
        const mSeat = mt.seats[ms.seatIndex];
        if (authForMulti && mSeat && mSeat.state === 'occupied' && !mSeat.isAI) {
          creditSeatStackToWallet(authForMulti.userId, authForMulti.username, ms.tableId, mSeat, 'additional_table_leave');
        }
        mt.standUp(ms.seatIndex);
      }
      socket.leave(`table:${ms.tableId}`);
    }
    multiTableSessions.delete(socket.id);
  }

  // Clean up spectator sessions
  for (const [tableId, specs] of spectators) {
    if (specs.has(socket.id)) {
      specs.delete(socket.id);
      socket.leave(`table:${tableId}`);
      if (specs.size === 0) spectators.delete(tableId);
    }
  }

  // Clean up rate limits
  lastEmoteTime.delete(socket.id);
  lastReactionTime.delete(socket.id);
  lastChatTime.delete(socket.id);
}

// ========== Tournament Helpers ==========

function startTournamentGame(tournamentId: string): void {
  const result = tournamentManager.startTournament(tournamentId);
  if (!result) return;

  const tournament = tournamentManager.getTournament(tournamentId);
  if (!tournament) return;

  const blinds = result.blinds;
  const tableId = tableManager.createQuickTable(
    `Tournament: ${tournament.config.name}`,
    Math.min(tournament.players.length, 9),
    blinds.sb,
    blinds.bb,
    result.startingChips
  );

  const table = tableManager.getTable(tableId)!;
  tournamentManager.setTableId(tournamentId, tableId);
  tournamentTables.set(tableId, tournamentId);

  // Seat all players
  for (let i = 0; i < tournament.players.length && i < 9; i++) {
    const tp = tournament.players[i];
    table.sitDown(i, tp.playerName, result.startingChips, tp.playerId, false);

    // Create session for each player
    const session: PlayerSession = {
      socketId: tp.socketId,
      tableId,
      seatIndex: i,
      playerName: tp.playerName,
      playerId: tp.playerId,
      trainingEnabled: false,
      sittingOut: false,
    };
    playerSessions.set(tp.socketId, session);

    const sock = io.sockets.sockets.get(tp.socketId);
    if (sock) {
      sock.join(`table:${tableId}`);
      sock.emit('tournamentStarted', {
        tournamentId,
        tableId,
        name: tournament.config.name,
        startingChips: result.startingChips,
        blinds: { sb: blinds.sb, bb: blinds.bb, ante: blinds.ante },
      });
    }
  }

  // === Push notification: tournament_start ===
  // Fan out to every registered human player on this tournament. Uses
  // Promise.allSettled so one bad subscription can't block the rest.
  // dedupeKey on the API side (60s window) prevents same-key replay.
  try {
    const tName = tournament.config.name;
    const notifyTargets: Promise<void>[] = [];
    for (let i = 0; i < tournament.players.length && i < 9; i++) {
      const tp = tournament.players[i];
      const auth = authSessions.get(tp.socketId);
      const uid = auth?.userId;
      if (!uid) continue; // skip unauthenticated / bots
      notifyTargets.push(
        notifyPlayer(
          uid,
          'tournament_start',
          'Tournament starting',
          `${tName} is starting now — you're seated at Table 1`,
          {
            priority: 'urgent',
            metadata: { gameId: tableId, tournamentId, seatNumber: i, tableNum: 1 },
          }
        )
      );
    }
    if (notifyTargets.length > 0) {
      void Promise.allSettled(notifyTargets);
    }
  } catch (err) {
    console.warn('[notifyPlayer tournament_start] hook failed:', (err as Error)?.message);
  }

  // Fill remaining seats with AI
  fillWithAI(table, tableId);
  ensureTableProgressListener(table, tableId);

  table.startNewHand();
  broadcastGameState(tableId);
  scheduleAIAction(tableId);

  // Listen for blind level changes
  tournamentManager.onEvent(tournamentId, (event, data) => {
    if (event === 'blindLevelUp') {
      const t = tableManager.getTable(tableId);
      if (t) {
        t.config.smallBlind = data.sb;
        t.config.bigBlind = data.bb;
        t.config.ante = data.ante;
      }
      io.to(`table:${tableId}`).emit('blindLevelUp', data);

      // === Push notification: blind_level_up ===
      // Fan out to every human seat at this tournament table. Fire-and-forget;
      // notification failure must never break the blind-up state machine.
      try {
        const t2 = tableManager.getTable(tableId);
        if (t2) {
          const newLevel = data?.level ?? 0;
          const tableLabel = t2.config.tableName || 'your table';
          for (let i = 0; i < t2.seats.length; i++) {
            const seat = t2.seats[i];
            if (!seat || seat.state !== 'occupied') continue;
            if (seat.isAI || !seat.playerName) continue;
            const uid = userIdForSeat(tableId, i);
            if (!uid) continue;
            void notifyPlayer(
              uid,
              'blind_level_up',
              'Blinds increasing',
              `Level ${newLevel} now in play at ${tableLabel}`,
              { priority: 'normal', metadata: { gameId: tableId, tournamentId, level: newLevel } }
            );
          }
        }
      } catch (err) {
        console.warn('[notifyPlayer blind_level_up] hook failed:', (err as Error)?.message);
      }
    }
    if (event === 'tournamentFinished') {
      payTournamentPrizes(data); // credit funded prize payouts (mint-free, idempotent)
      io.to(`table:${tableId}`).emit('tournamentFinished', data);
    }
    if (event === 'playerEliminated') {
      io.to(`table:${tableId}`).emit('playerEliminated', data);
    }
  });
}

// Periodically check for timed tournaments
setInterval(() => {
  const ready = tournamentManager.checkTimedTournaments();
  for (const id of ready) {
    startTournamentGame(id);
  }
}, 10000);

// ========== Multi-Table Tournament Simulation ==========

const AI_NAMES_POOL = [
  'Ace','Bear','Cobra','Duke','Eagle','Fox','Ghost','Hawk','Iron','Jester',
  'King','Lion','Maverick','Neon','Omega','Phoenix','Quest','Raven','Shadow','Tiger',
  'Ultra','Viper','Wolf','Xray','Yeti','Zeus','Blaze','Cliff','Drake','Echo',
  'Flint','Granite','Haze','Ivory','Jade','Knox','Lance','Mars','Nash','Onyx',
  'Pike','Quinn','Rex','Slate','Thor','Umbra','Volt','Wren','Axle','Bolt',
  'Cruz','Dash','Edge','Frost','Grit','Hex','Ink','Jet','Kite','Lux',
  'Mist','Nox','Opal','Pulse','Quill','Reef','Sage','Tusk','Ursa','Vale',
  'Wisp','Zap','Ash','Birch','Clay','Dune','Elm','Fern','Glen','Heath',
  'Isle','Juno','Kelp','Lark','Moss','Nile','Oak','Pine','Rain','Star',
  'Tide','Una','Vine','Wave','Yew','Zen','Aria','Bliss','Cove','Dawn',
  'Eve','Faith','Grace','Hope','Iris','Joy','Kit','Luna','Mia','Neve',
  'Ora','Pearl','Rue','Sky','Tara','Uma','Vera','Willow','Xena','Yara',
  'Zara','Abel','Beau','Colt','Dean','Ezra','Finn','Grey','Hugo','Ivan',
  'Jake','Kane','Leo','Max','Nico','Owen','Paul','Ray','Sam','Troy',
  'Vic','Wade','Zeke','Adam','Brad','Cole','Drew','Eli','Fred','Gene',
  'Hank','Ike','Joel','Kirk','Luke','Mark','Ned','Otto','Pete','Rick',
  'Seth','Todd','Vern','Will','York','Zach','Barb','Cara','Dina','Ella',
  'Faye','Gina','Hana','Ida','Jane','Kate','Lena','Mona','Nina','Opal',
  'Rosa','Sara','Tina','Wanda','Yoko','Zoe','Bret','Chip','Doug','Earl',
  'Glen','Hans','Juan','Kurt','Lars','Milo','Nate','Phil','Russ','Stan',
];

/**
 * Start a multi-table tournament simulation.
 * Creates `playerCount` AI bots + optionally 1 human player.
 */
function startMultiTableTournament(
  playerCount: number = 200,
  humanSocketId?: string,
  humanPlayerId?: string,
  humanPlayerName?: string,
  turbo: boolean = false,
): { tournamentId: string; tableIds: string[]; tableCount: number } | null {
  const startingChips = 5000;
  const seatsPerTable = 9;
  const tableCount = Math.ceil(playerCount / seatsPerTable);

  // Create tournament
  const tournamentId = tournamentManager.createTournament({
    name: `${playerCount}-Player Championship`,
    buyIn: 0,
    prizePool: playerCount * 100,
    maxPlayers: playerCount,
    startInterval: 0,
    blindLevels: DEFAULT_BLIND_LEVELS,
  });

  const tournament = tournamentManager.getTournament(tournamentId);
  if (!tournament) return null;

  // Register all players
  const allPlayers: { id: string; name: string; socketId: string; isHuman: boolean }[] = [];

  // Add human player first if provided
  if (humanSocketId && humanPlayerId && humanPlayerName) {
    allPlayers.push({ id: humanPlayerId, name: humanPlayerName, socketId: humanSocketId, isHuman: true });
  }

  // Add AI players
  const usedNames = new Set(allPlayers.map(p => p.name));
  const shuffledNames = [...AI_NAMES_POOL].sort(() => Math.random() - 0.5);
  let nameIdx = 0;
  while (allPlayers.length < playerCount) {
    let name = shuffledNames[nameIdx % shuffledNames.length];
    if (usedNames.has(name)) name = `${name}${Math.floor(Math.random() * 99)}`;
    if (usedNames.has(name)) { nameIdx++; continue; }
    usedNames.add(name);
    const playerId = `ai-${uuidv4().slice(0, 8)}`;
    allPlayers.push({ id: playerId, name, socketId: `ai-sock-${playerId}`, isHuman: false });
    nameIdx++;
  }

  // Register all with tournament manager
  for (const p of allPlayers) {
    tournamentManager.registerPlayer(tournamentId, p.id, p.name, p.socketId);
  }

  // Start the tournament
  const startResult = tournamentManager.startTournament(tournamentId);
  if (!startResult) return null;

  // Override starting chips
  for (const tp of tournament.players) {
    tp.chips = startingChips;
  }

  tournament.turboMode = turbo;

  // Create tables
  const tableIds: string[] = [];
  const blinds = startResult.blinds;

  for (let t = 0; t < tableCount; t++) {
    const tid = tableManager.createQuickTable(
      `Tournament Table ${t + 1}`,
      seatsPerTable,
      blinds.sb,
      blinds.bb,
      startingChips,
    );
    tableIds.push(tid);
    tournamentTables.set(tid, tournamentId);
    if (turbo) fastModeTables.set(tid, true);
  }

  tournamentManager.setTableIds(tournamentId, tableIds);

  // Distribute players round-robin across tables
  for (let i = 0; i < allPlayers.length; i++) {
    const p = allPlayers[i];
    const tableIdx = i % tableCount;
    const tid = tableIds[tableIdx];
    const seatIdx = Math.floor(i / tableCount);
    const table = tableManager.getTable(tid);
    if (!table || seatIdx >= seatsPerTable) continue;

    const isAI = !p.isHuman;
    table.sitDown(seatIdx, p.name, startingChips, p.id, isAI);
    tournamentManager.setPlayerTable(tournamentId, p.id, tid);

    if (p.isHuman && humanSocketId) {
      const session: PlayerSession = {
        socketId: humanSocketId,
        tableId: tid,
        seatIndex: seatIdx,
        playerName: p.name,
        playerId: p.id,
        trainingEnabled: false,
        sittingOut: false,
      };
      playerSessions.set(humanSocketId, session);
      const sock = io.sockets.sockets.get(humanSocketId);
      if (sock) {
        sock.join(`table:${tid}`);
        sock.emit('tournamentStarted', {
          tournamentId,
          tableId: tid,
          name: tournament.config.name,
          startingChips,
          blinds: { sb: blinds.sb, bb: blinds.bb, ante: blinds.ante },
          totalPlayers: playerCount,
          tableCount,
        });

        // === Push notification: tournament_start ===
        // Fire-and-forget per registered human. Promise.allSettled wraps
        // the (currently single-human) fan-out so a failing subscription
        // never blocks tournament startup.
        try {
          const auth = authSessions.get(humanSocketId);
          const uid = auth?.userId;
          if (uid) {
            const tableNum = tableIdx + 1;
            void Promise.allSettled([
              notifyPlayer(
                uid,
                'tournament_start',
                'Tournament starting',
                `${tournament.config.name} is starting now — you're seated at Table ${tableNum}`,
                {
                  priority: 'urgent',
                  metadata: {
                    gameId: tid,
                    tournamentId,
                    seatNumber: seatIdx,
                    tableNum,
                  },
                }
              ),
            ]);
          }
        } catch (err) {
          console.warn('[notifyPlayer tournament_start] hook failed:', (err as Error)?.message);
        }
      }
    }

    // Set up AI profiles for bots
    if (isAI) {
      if (!aiProfiles.has(tid)) aiProfiles.set(tid, new Map());
      const profile = generateRandomProfile('hard');
      profile.botName = p.name;
      aiProfiles.get(tid)!.set(seatIdx, profile);
    }
  }

  // Set up each table: listeners, start hands
  for (const tid of tableIds) {
    const table = tableManager.getTable(tid);
    if (!table) continue;
    ensureTableProgressListener(table, tid);
    table.startNewHand();
    broadcastGameState(tid);
    scheduleAIAction(tid);
  }

  // Listen for blind level changes → apply to ALL tables
  tournamentManager.onEvent(tournamentId, (event, data) => {
    if (event === 'blindLevelUp') {
      for (const tid of tournamentManager.getTournament(tournamentId)?.tableIds || []) {
        const t = tableManager.getTable(tid);
        if (t) {
          t.config.smallBlind = data.sb;
          t.config.bigBlind = data.bb;
          t.config.ante = data.ante;
        }
        io.to(`table:${tid}`).emit('blindLevelUp', data);

        // === Push notification: blind_level_up ===
        // Fan out to every human seat at this tournament table. Fire-and-forget;
        // notification failure must never break the blind-up state machine.
        try {
          const t2 = tableManager.getTable(tid);
          if (t2) {
            const newLevel = data?.level ?? 0;
            const tableLabel = t2.config.tableName || 'your table';
            for (let i = 0; i < t2.seats.length; i++) {
              const seat = t2.seats[i];
              if (!seat || seat.state !== 'occupied') continue;
              if (seat.isAI || !seat.playerName) continue;
              const uid = userIdForSeat(tid, i);
              if (!uid) continue;
              void notifyPlayer(
                uid,
                'blind_level_up',
                'Blinds increasing',
                `Level ${newLevel} now in play at ${tableLabel}`,
                { priority: 'normal', metadata: { gameId: tid, tournamentId, level: newLevel } }
              );
            }
          }
        } catch (err) {
          console.warn('[notifyPlayer blind_level_up] hook failed:', (err as Error)?.message);
        }
      }
    }
    if (event === 'playerEliminated') {
      for (const tid of tournamentManager.getTournament(tournamentId)?.tableIds || []) {
        io.to(`table:${tid}`).emit('playerEliminated', data);
      }
      // Check table rebalancing after elimination
      handleTableRebalance(tournamentId);
    }
    if (event === 'tournamentFinished') {
      payTournamentPrizes(data); // credit funded prize payouts (mint-free, idempotent)
      for (const tid of tournamentManager.getTournament(tournamentId)?.tableIds || []) {
        io.to(`table:${tid}`).emit('tournamentFinished', data);
      }
    }
  });

  console.log(`[Tournament] Started ${playerCount}-player tournament ${tournamentId} across ${tableCount} tables`);
  return { tournamentId, tableIds, tableCount };
}

/**
 * Handle table rebalancing after a player is eliminated.
 * Breaks the smallest table when alive players fit in fewer tables.
 */
// 2026-06-11 tournament economy: credit funded prize payouts to wallets when
// a tournament finishes. The payouts come from TournamentManager's
// collectedEntryFees pool (Σpayouts ≤ Σcollected — mint-free); we credit only
// results that carry a userId (paying humans). Idempotent per tournamentId so
// a duplicate tournamentFinished event can't double-pay.
const paidOutTournaments = new Set<string>();
function payTournamentPrizes(data: { tournamentId?: string; results?: Array<{ playerId: string; playerName: string; position: number; payout: number; userId?: number }> }): void {
  const tid = data?.tournamentId;
  if (!tid || paidOutTournaments.has(tid)) return;
  paidOutTournaments.add(tid);
  for (const r of data?.results || []) {
    if (r.userId === undefined || !(r.payout > 0)) continue;
    addChipsToUser(r.userId, r.payout)
      .then((ok: boolean) => {
        auditLog(r.playerName || String(r.userId), ok ? 'TOURNAMENT_PRIZE' : 'TOURNAMENT_PRIZE_FAILED',
          { userId: r.userId, tournamentId: tid, position: r.position, payout: r.payout });
      })
      .catch((e: any) => {
        console.error(`[TournamentPrize ${r.userId}] payout=${r.payout}`, e?.message || e);
        if (Sentry) Sentry.captureException(e, { tags: { area: 'chip.tournamentPrize' }, extra: { userId: r.userId, tournamentId: tid, payout: r.payout } });
        auditLog(r.playerName || String(r.userId), 'TOURNAMENT_PRIZE_FAILED', { userId: r.userId, tournamentId: tid, payout: r.payout, error: String(e?.message || e) });
      });
  }
}

function handleTableRebalance(tournamentId: string): void {
  const rebalance = tournamentManager.checkRebalance(tournamentId);
  if (!rebalance) return;

  const tournament = tournamentManager.getTournament(tournamentId);
  if (!tournament) return;

  const { breakTableId, playersToMove } = rebalance;
  const breakTable = tableManager.getTable(breakTableId);

  console.log(`[Tournament] Breaking table ${breakTableId} — moving ${playersToMove.length} players`);

  // Emit table breaking event
  io.to(`table:${breakTableId}`).emit('tableBroken', { tableId: breakTableId, reason: 'Table combining' });

  // Find seats on remaining tables
  const remainingTables = tournament.tableIds.filter(tid => tid !== breakTableId);

  for (const player of playersToMove) {
    // Find a table with an empty seat
    let placed = false;

    // Get player's current chips from the breaking table
    const breakSeat = breakTable?.seats.find(s => s.playerId === player.playerId);
    const chips = breakSeat?.chipCount || tournament.players.find(p => p.playerId === player.playerId)?.chips || 5000;
    const isAI = breakSeat?.isAI ?? true;

    for (const targetTid of remainingTables) {
      if (placed) break;
      const targetTable = tableManager.getTable(targetTid);
      if (!targetTable) continue;

      // Find ALL empty seats on this table, try each one
      for (let seatIdx = 0; seatIdx < 9; seatIdx++) {
        if (targetTable.seats[seatIdx].state !== 'empty') continue;

        // Sit down at new table — sitDown returns false if seat is taken
        const seated = targetTable.sitDown(seatIdx, player.playerName, chips, player.playerId, isAI);
        if (!seated) continue;

        tournamentManager.setPlayerTable(tournamentId, player.playerId, targetTid);
        const emptySeat = seatIdx;

        // Move AI profile if it's a bot
        if (isAI && breakSeat) {
          const oldSeatIdx = breakTable?.seats.findIndex(s => s.playerId === player.playerId) ?? -1;
          const oldProfile = aiProfiles.get(breakTableId)?.get(oldSeatIdx);
          if (oldProfile) {
            if (!aiProfiles.has(targetTid)) aiProfiles.set(targetTid, new Map());
            aiProfiles.get(targetTid)!.set(emptySeat, oldProfile);
          }
        } else {
          // Human player — update their session IF they're still connected.
          // If the socket disconnected during rebalance, playerSessions may
          // still hold a stale entry (cleanup race). Mutating it blindly
          // would leave a ghost session pointing at the wrong table. Check
          // the live socket registry first: no live socket → log + skip the
          // session mutation. The player's tournament seat is already
          // reassigned (setPlayerTable above); on reconnect, the orphan-seat
          // recovery flow (oauthLogin) will pick it up correctly.
          const tp = tournament.players.find(p => p.playerId === player.playerId);
          if (tp) {
            const sock = io.sockets.sockets.get(tp.socketId);
            const sockLive = sock && sock.connected;
            if (sockLive) {
              const session = playerSessions.get(tp.socketId);
              if (session) {
                session.tableId = targetTid;
                session.seatIndex = emptySeat;
              }
              sock.leave(`table:${breakTableId}`);
              sock.join(`table:${targetTid}`);
              sock.emit('playerMoved', {
                fromTable: breakTableId,
                toTable: targetTid,
                toSeat: emptySeat,
                tableId: targetTid,
              });
            } else {
              console.warn(`[Tournament] Rebalance: ${player.playerName} socket ${tp.socketId} not live — skipping session mutation; reconnect recovery will pick it up`);
            }
          }
        }

        placed = true;
        console.log(`[Tournament] Moved ${player.playerName} to table ${targetTid} seat ${emptySeat}`);
        break; // break out of seat loop
      }
    }

    if (!placed) {
      console.error(`[Tournament] Could not place ${player.playerName} — no empty seats!`);
    }
  }

  // Remove the broken table
  tournamentManager.removeTable(tournamentId, breakTableId);
  tournamentTables.delete(breakTableId);
  aiProfiles.delete(breakTableId);
  // Don't remove the table from tableManager yet — let current hand finish
  // Mark it for cleanup
  setTimeout(() => {
    tableManager.removeTable(breakTableId);
  }, 5000);

  // Broadcast updated state to remaining tables
  for (const tid of remainingTables) {
    broadcastGameState(tid);
    scheduleAIAction(tid);
  }

  const alive = tournamentManager.getAliveCount(tournamentId);
  const tables = tournamentManager.getActiveTableCount(tournamentId);
  console.log(`[Tournament] After rebalance: ${alive} players, ${tables} tables`);

  // Broadcast tournament status update
  const status = tournamentManager.getTournamentStatus(tournamentId);
  if (status) {
    for (const tid of tournament.tableIds) {
      io.to(`table:${tid}`).emit('tournamentUpdate', status);
    }
  }

  // Cascade: keep rebalancing until all tables have >= 5 players or only 1 table left
  const nextRebalance = tournamentManager.checkRebalance(tournamentId);
  if (nextRebalance) {
    // Delay slightly to let table state settle
    setTimeout(() => handleTableRebalance(tournamentId), 500);
  } else {
    // All tables are balanced — restart hands on tables that were waiting
    const t = tournamentManager.getTournament(tournamentId);
    if (t) {
      for (const tid of t.tableIds) {
        const table = tableManager.getTable(tid);
        if (table && !table.isHandInProgress()) {
          const alivePlayers = tournamentManager.getAlivePlayersOnTable(tournamentId, tid);
          const isFinalTable = t.tableIds.length === 1;
          if (alivePlayers.length >= 2 && (isFinalTable || alivePlayers.length >= 5)) {
            table.startNewHand();
            broadcastGameState(tid);
            scheduleAIAction(tid);
          }
        }
      }
    }
  }
}

// Periodic rebalance check — prevents stalls when tables have < 5 players
// and no eliminations are happening to trigger event-driven rebalance.
setInterval(() => {
  for (const [tableId, tournamentId] of tournamentTables) {
    const tournament = tournamentManager.getTournament(tournamentId);
    if (!tournament || tournament.status !== 'running') continue;
    if (tournament.tableIds.length <= 1) continue;

    // Check if any table has < 5 players
    const rebalance = tournamentManager.checkRebalance(tournamentId);
    if (rebalance) {
      handleTableRebalance(tournamentId);
      break; // handle one tournament at a time per tick
    }
  }
}, 5000);

// REST endpoint to start a simulated tournament
app.post('/api/tournament/simulate', (req, res) => {
  // 2026-06-19 fix: this was unauthenticated with an UNCAPPED playerCount —
  // a single POST with playerCount:100000 would spin up an enormous multi-table
  // tournament (resource-exhaustion DoS). Clamp to a sane range, and require the
  // internal token when one is configured (no-op if the env var is unset, so a
  // legit dev/admin caller without it still works in non-prod).
  const tok = process.env.INTERNAL_NOTIFY_TOKEN || '';
  if (tok && req.headers['x-internal-token'] !== tok) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const playerCount = Math.max(2, Math.min(1000, Math.floor(Number(req.body?.playerCount) || 200)));
  const turbo = req.body?.turbo || false;

  const result = startMultiTableTournament(playerCount, undefined, undefined, undefined, turbo);
  if (!result) {
    res.status(500).json({ error: 'Failed to start tournament' });
    return;
  }

  res.json({
    success: true,
    tournamentId: result.tournamentId,
    tableCount: result.tableCount,
    playerCount,
    turbo,
  });
});

// ========== Initialize Auth Database ==========
initDB().then(async () => {
  try { await initClubTables(); } catch (e) { console.error('[Clubs] initClubTables failed', e); }
  try { await initFriendTables(); } catch (e) { console.error('[friends] initFriendTables failed', e); }
  try { await initPredictionTables(); } catch (e) { console.error('[prediction] initPredictionTables failed', e); }
  try { await initBracketTables(); } catch (e) { console.error('[bracket] initBracketTables failed', e); }

  // One-time chip recovery grant for admin — compensates for the
  // "disconnect wiped my wallet" bug (fixed in commit 03b5170). Guarded
  // by a JSONB flag in users.stats so this only runs once per admin even
  // across redeploys.
  try {
    const adminPhone = process.env.ADMIN_PHONE || '7202780636';
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, chips, stats FROM users WHERE username = $1 OR username ILIKE $2 LIMIT 1`,
      [adminPhone, adminPhone]
    );
    if (rows.length > 0) {
      const user = rows[0];
      const stats = typeof user.stats === 'string' ? JSON.parse(user.stats || '{}') : (user.stats || {});

      // One-time 1B chip recovery grant — compensates for the disconnect
      // chip-wipe bug (fixed in 03b5170). Per CLAUDE.md, ALL chip mutations
      // must flow through the sanctioned `addChipsToUser` helper (atomic
      // `chips = chips + $1`) and be audited via `auditLog`. The
      // idempotency flag write goes through `mergeUserStats` (FOR UPDATE
      // locking) so concurrent stats writers can't clobber the marker.
      if (!stats.chipRecoveryGrantApplied) {
        const GRANT_AMOUNT = 1_000_000_000;
        const ok = await addChipsToUser(user.id, GRANT_AMOUNT);
        if (ok) {
          await mergeUserStats(user.id, {
            chipRecoveryGrantApplied: true,
            chipRecoveryGrantAt: new Date().toISOString(),
          });
          auditLog('SYSTEM', 'CHIP_RECOVERY_GRANT', {
            targetUserId: user.id,
            amount: GRANT_AMOUNT,
            reason: 'disconnect_chip_wipe_03b5170',
          });
          console.log(`[Recovery] Granted ${GRANT_AMOUNT.toLocaleString()} chips to admin userId=${user.id} (${adminPhone})`);
        } else {
          console.warn(`[Recovery] addChipsToUser failed for userId=${user.id} — grant NOT marked applied (will retry next boot)`);
        }
      }

      // One-time stars recovery grant — compensates for the persistStars
      // pre-hydration clobber bug (fixed this commit). Use the atomic
      // additive `addStarsToUser` for the same reason chips use
      // `addChipsToUser`, and route the idempotency flag through
      // `mergeUserStats` for FOR-UPDATE-locked safety.
      if (!stats.starsRecoveryGrantApplied) {
        const STARS_GRANT = 50000;
        const ok = await addStarsToUser(user.id, STARS_GRANT);
        if (ok) {
          await mergeUserStats(user.id, {
            starsRecoveryGrantApplied: true,
            starsRecoveryGrantAt: new Date().toISOString(),
          });
          auditLog('SYSTEM', 'STARS_RECOVERY_GRANT', {
            targetUserId: user.id,
            amount: STARS_GRANT,
            reason: 'persistStars_prehydrate_clobber',
          });
          console.log(`[Recovery] Granted ${STARS_GRANT.toLocaleString()} stars to admin userId=${user.id} (${adminPhone})`);
        } else {
          console.warn(`[Recovery] addStarsToUser failed for userId=${user.id} — grant NOT marked applied (will retry next boot)`);
        }
      }
    }
  } catch (err: any) {
    console.warn('[Recovery] grant failed:', err?.message);
  }
});

// ========== Start Server ==========

httpServer.listen(PORT, async () => {
  console.log(`Poker server running on port ${PORT}`);
  console.log(`Tables available: ${tableManager.getTableList().length}`);
  for (const table of tableManager.getTableList()) {
    console.log(
      `  - ${table.tableName} (${table.smallBlind}/${table.bigBlind} blinds, min buy-in: ${table.minBuyIn})`
    );
  }

  // Hand-state persistence: connect to Redis, then rehydrate any
  // in-progress hands left over from the previous process. Without
  // this, every Railway deploy evaporates mid-hand state and players
  // see a frozen table until the watchdog recovers.
  const redisConnected = await connectHandStore();
  if (redisConnected) {
    try {
      const snapshots = await scanHands();
      let rehydrated = 0;
      for (const { tableId, state } of snapshots) {
        const table = tableManager.getTable(tableId);
        const snap = state as PokerTableSnapshot;
        if (!table || !snap || snap.version !== 1) continue;
        try {
          table.rehydrateFromSnapshot(snap);
          rehydrated++;
          // Restore turn + AI scheduler so play continues from where it
          // left off. broadcastGameState handles timer arming; the
          // scheduler kicks the AI whose turn it is.
          broadcastGameState(tableId);
          scheduleAIAction(tableId);
        } catch (err) {
          console.warn(`[Rehydrate] failed for ${tableId}:`, (err as Error)?.message);
        }
      }
      if (rehydrated > 0) {
        console.log(`[Rehydrate] restored ${rehydrated} in-progress hand(s) from Redis`);
      }
    } catch (err) {
      console.warn('[Rehydrate] scan failed:', (err as Error)?.message);
    }

    // Rehydrate the provably-fair revealed-commitment buffer. Without
    // this, /api/fairness/:tableId returns empty after every Railway
    // restart even though the commitment was logged. The Redis copy
    // becomes the in-process Map directly — we never read from Redis
    // again during this process's lifetime.
    try {
      const fairnessBuffers = await scanFairnessBuffers();
      let totalEntries = 0;
      for (const { tableId, entries } of fairnessBuffers) {
        // Defensive cap in case Redis state somehow exceeds the limit.
        const capped = entries.slice(0, FAIRNESS_BUFFER_SIZE);
        revealedCommitmentsByTable.set(tableId, capped);
        totalEntries += capped.length;
      }
      if (totalEntries > 0) {
        console.log(`[Rehydrate] restored ${totalEntries} fairness commitment(s) across ${fairnessBuffers.length} table(s) from Redis`);
      }
    } catch (err) {
      console.warn('[Rehydrate] fairness scan failed:', (err as Error)?.message);
    }
  }
});

// ========== Graceful shutdown — preserve player state on Railway redeploys ==========
//
// Railway sends SIGTERM then kills the process ~30s later. Before the
// process dies, we MUST cash out every seated player's at-table stack
// back to their users.chips wallet, and flush in-memory progress
// (xp/level/achievements) to DB. Without this, every redeploy evaporates
// seated chip stacks and any mid-session XP/level gains that hadn't
// already been saved via hand-complete.
//
// Also flushes:
// - users.stars (via persistStars)
// - users.chips (at-table stack added back)
// - xp/level/achievements/stats (via saveProgress)
let shutdownInProgress = false;
async function gracefulShutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[Shutdown] ${signal} received — preserving player state...`);

  try {
    // 1. Cash out every seated human player and flush their progress.
    const seenUserIds = new Set<number>();
    // 2026-06-11 audit C3: dedupe the cash-out by PHYSICAL seat
    // (tableId:seatIndex), not just by userId. seenUserIds prevents the
    // active-vs-reserved double, but a single seat referenced by two live
    // sessions (a stale ghost socket + the real one, mid-reconnect) would
    // otherwise be credited TWICE. Crediting per distinct seat also still
    // pays a legitimately multi-seated user for each of their seats.
    const creditedSeats = new Set<string>();
    for (const [socketId, session] of playerSessions) {
      try {
        const auth = authSessions.get(socketId);
        if (!auth) continue;
        const table = tableManager.getTable(session.tableId);
        const seat = table?.seats?.[session.seatIndex];
        const seatKey = `${session.tableId}:${session.seatIndex}`;
        // Tournament stacks are NOT wallet-funded — never cash them out (would
        // mint). They persist with the tournament (or are lost if the
        // tournament can't rehydrate), but they must not hit the wallet.
        if (seat && seat.state === 'occupied' && seat.chipCount > 0 && !creditedSeats.has(seatKey) && !tournamentTables.has(session.tableId)) {
          creditedSeats.add(seatKey);
          await addChipsToUser(auth.userId, seat.chipCount);
          console.log(`[Shutdown] Cashed out ${seat.chipCount} chips for user ${auth.userId} (seat ${session.seatIndex})`);
        }
        const prog = progressionManager.getClientProgress(session.playerId) as any;
        if (prog && prog.hydrated) {
          await saveProgress(auth.userId, {
            xp: prog.xp,
            level: prog.level,
            achievements: prog.achievements || [],
            stats: {
              handsPlayed: prog.totalHandsPlayed,
              handsWon: prog.handsWon,
              biggestPot: prog.biggestPot,
              bestStreak: prog.bestStreak,
              bluffWins: prog.bluffWins,
              allInWins: prog.allInWins,
              chatMessagesSent: prog.chatMessagesSent,
              straightFlushHits: prog.straightFlushHits,
              fullHouseHits: prog.fullHouseHits,
              quadsHits: prog.quadsHits,
              royalFlushHits: prog.royalFlushHits,
              tournamentsWon: prog.tournamentsWon,
              tournamentsPlayed: prog.tournamentsPlayed,
              variantsPlayed: prog.variantsPlayed || [],
            },
          });
        }
        seenUserIds.add(auth.userId);
      } catch (e: any) {
        console.warn(`[Shutdown] flush failed for socket ${socketId}:`, e?.message);
      }
    }

    // 2. Cash out every reserved seat (disconnected but not yet expired).
    for (const [userId, reserved] of reservedSeats) {
      if (seenUserIds.has(userId)) continue;
      try {
        const table = tableManager.getTable(reserved.tableId);
        const seat = table?.seats?.[reserved.seatIndex];
        const chips = seat?.chipCount ?? reserved.chips ?? 0;
        const seatKey = `${reserved.tableId}:${reserved.seatIndex}`;
        if (chips > 0 && !creditedSeats.has(seatKey) && !tournamentTables.has(reserved.tableId)) {
          creditedSeats.add(seatKey);
          await addChipsToUser(userId, chips);
          console.log(`[Shutdown] Cashed out ${chips} reserved chips for user ${userId}`);
        }
      } catch (e: any) {
        console.warn(`[Shutdown] reserved flush failed for user ${userId}:`, e?.message);
      }
    }

    // 3. Flush every pending debounced hand-snapshot to Redis.
    //    Without this, the last ~100ms of state (the debounce window)
    //    could be lost on restart — the new process would rehydrate
    //    from a snapshot that's one action behind reality. Also
    //    proactively snapshot every in-progress hand even if its
    //    debounce window has already fired, so the latest state
    //    definitely makes it to Redis before SIGTERM kills us.
    try {
      for (const t of tableManager.getTableList()) {
        const table = tableManager.getTable(t.tableId);
        if (table?.isHandInProgress()) {
          snapshotHand(t.tableId, table.serializeSnapshot(), 0); // bypass debounce
        }
      }
      await flushAllHandSnapshots();
    } catch (e: any) {
      console.warn('[Shutdown] hand-snapshot flush failed:', e?.message);
    }

    console.log('[Shutdown] State preserved. Exiting.');
  } catch (err: any) {
    console.error('[Shutdown] fatal error during flush:', err?.message);
    if (Sentry) Sentry.captureException(err, { tags: { area: 'shutdown.flush' } });
  } finally {
    // Give the logger a moment, then exit so Railway can finish the redeploy.
    setTimeout(() => process.exit(0), 500);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

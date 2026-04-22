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
import { initDB, loginUser, loginUserAsync, registerUser, isUsernameTaken, getUserFromToken, saveProgress, loadProgress, isUserAdmin, isUserBanned, getUserChips, deductChips, bumpTokenVersion, getAllUsers, banUser as banUserDB, unbanUser as unbanUserDB, addChipsToUser, getTotalUsers, getLeaderboard, searchUsers, mergeUserStats, setDisplayName, getPool, loadInventory, grantItem as dbGrantItem, equipItem as dbEquipItem, hasClaimedToday, recordDailyClaim, updateLoginStreak, tickScratchProgress, consumeScratchCard, claimBattlePassTier as dbClaimBattlePassTier, loadBattlePassClaims, persistCustomization, persistPreferences, recordHand, loadHandHistory, persistStars as dbPersistStars, addStarsToUser, loadDurableProgress } from './auth/authManager';
import { validateOAuthToken } from './auth/oauthValidator';
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

// Track when each table's current turn started (epoch ms) so clients can render
// a per-player countdown ring.
const turnStartedAtMap = new Map<string, number>();
// Tracks which seat "owns" the current turnStartedAt timestamp. Separate
// from turnTimers because timer entries get deleted on callback fire;
// this keeps a stable "prior seat" reference so a subsequent broadcast
// can tell if the active seat really changed or not.
const turnStartedSeatMap = new Map<string, number>();

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
// Action nonce tracking: tableId:seatIndex -> last nonce used
const actionNonces = new Map<string, string>();
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

// Module-scope audit log (used by anti-cheat auto-ban, admin ops, and buy-in audit)
function auditLog(actorUsername: string, action: string, details: Record<string, unknown> = {}) {
  const entry = `[AUDIT] ${new Date().toISOString()} | ${actorUsername} | ${action} | ${JSON.stringify(details)}`;
  console.log(entry);
}

// ========== Testing-mode unlimited chip refills ==========
//
// While the .online room is still in testing we want every player to be
// able to sit at any table regardless of their current DB balance. Rather
// than granting a huge starting stack up front (which would distort
// progression testing) we auto-top-up ON-DEMAND: any buy-in path that
// finds `dbChips < buyIn` calls ensureChipsForBuyIn which credits the
// user enough to cover the buy-in plus a small buffer, then proceeds.
//
// Disable for production by setting UNLIMITED_CHIPS_TESTING=0 on Railway.
// Default ENABLED so a fresh deploy just works for live testers.
const UNLIMITED_CHIPS_TESTING = process.env.UNLIMITED_CHIPS_TESTING !== '0';
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
  for (const sid of actionNonces.keys())    { if (!io.sockets.sockets.get(sid)) actionNonces.delete(sid); }
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
const authSessions = new Map<string, { userId: number; username: string }>();

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', tables: tableManager.getTableList().length });
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
  phone: string;
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
    const res = await fetch(`${masterApi}/qualifier-credits`);
    const data: any = await res.json();
    if (!data.success || !data.credits) return [];

    // Group credits by phone+tier and count
    const byKey = new Map<string, QualifiedPlayer>();
    for (const c of data.credits) {
      if (c.tier !== tier || !c.phone_number) continue;
      const key = `${c.phone_number}-${c.tier}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.creditCount++;
      } else {
        byKey.set(key, {
          phone: c.phone_number,
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

// REST endpoint: get qualified players for a tier
app.get('/api/qualifiers/:tier', async (req, res) => {
  const tier = req.params.tier || 'weekly';
  const players = await getQualifiedPlayers(tier);
  res.json({ success: true, tier, count: players.length, players });
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
  players: { playerId: string; playerName: string; phone: string; socketId: string }[];
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
  if (playerSeatIndex >= 0) {
    const seat = table.seats[playerSeatIndex];
    if (seat && (seat.deadBlindOwedChips || 0) > 0) {
      stateObj.missedBlinds = seat.deadBlindOwedChips;
      stateObj.missedBlindType = seat.missedBlind; // 'small' | 'big' | 'both'
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

  // Also broadcast to any spectators in the room
  io.to(`table:${tableId}`).emit('tableUpdate', {
    tableId,
    phase: table.currentPhase,
    pot: table.getTotalPot(),
    activeSeatIndex: table.activeSeatIndex,
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
    const seatChanged = priorSeatForStart !== activeSeat;

    if (seatChanged) {
      if (existing) clearTimeout(existing.timeout);
      turnTimers.delete(tableId);
    }

    if (table.isHandInProgress() && activeSeat >= 0 && seatChanged) {
      const turnId = ++globalTurnId;
      turnStartedAtMap.set(tableId, Date.now());
      turnStartedSeatMap.set(tableId, activeSeat);
      const timeout = setTimeout(() => {
        const entry = turnTimers.get(tableId);
        if (!entry || entry.turnId !== turnId) return; // stale timer
        turnTimers.delete(tableId);
        const t = tableManager.getTable(tableId);
        if (!t || !t.isHandInProgress() || t.activeSeatIndex !== activeSeat) return;
        const seat = t.seats[activeSeat];
        if (!seat || !seat.playerName || seat.folded) return;
        const callAmt = t.currentBetToMatch - (seat.currentBet || 0);
        console.log(`[Timer] Seat ${activeSeat} (${seat.playerName}) timed out — ${callAmt > 0 ? 'folding' : 'checking'}`);
        if (callAmt > 0) {
          t.playerFold(activeSeat);
        } else {
          t.playerCheck(activeSeat);
        }
        broadcastGameState(tableId);
      }, TURN_TIMEOUT_MS);
      turnTimers.set(tableId, { timeout, seatIndex: activeSeat, turnId });
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
}

function ensureTableProgressListener(table: PokerTable, tableId: string): void {
  if (tableProgressListeners.has(tableId)) return;
  tableProgressListeners.add(tableId);

  table.on('handResult', async (data: { results: any[]; handNumber: number }) => {
    incrementHandsPlayed();
    handleHandComplete(tableId, data.results);

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

function fillWithAI(
  table: PokerTable,
  tableId: string,
  difficulty: Difficulty = 'hard',
  targetMaxOccupied: number = CASH_TABLE_TARGET_OCCUPIED
): void {
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
// Safe between-hands: WaitingForPlayers / HandComplete always OK.
// Safe mid-hand ONLY for folded AI seats (they're already out of the hand,
// standing them up changes nothing about the active action).
// Never touches humans. Logs what it does.
function trimExcessAI(
  table: PokerTable,
  tableId: string,
  targetMaxOccupied: number = CASH_TABLE_TARGET_OCCUPIED
): void {
  const occupied = table.getOccupiedSeatCount();
  if (occupied <= targetMaxOccupied) return;
  const betweenHands =
    table.currentPhase === GamePhase.WaitingForPlayers ||
    table.currentPhase === GamePhase.HandComplete;
  const aiSeats: number[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    const s = table.seats[i];
    if (s.state !== 'occupied' || !s.isAI) continue;
    // Between hands: any AI is fair game. Mid-hand: only folded AI so
    // we don't interrupt a live betting round.
    if (!betweenHands && !s.folded) continue;
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
  console.log(`[LiveRoom] trimExcessAI ${tableId}: removed ${toRemove} AI seats (was ${occupied}, cap ${targetMaxOccupied}, phase ${table.currentPhase})`);
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
              // Simple AI draw logic: stand pat if hand is decent, discard worst cards otherwise
              const discardCount = Math.floor(Math.random() * 3); // 0-2 cards
              const indices: number[] = [];
              for (let i = 0; i < discardCount && i < seat.holeCards.length; i++) {
                indices.push(i);
              }
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
  console.log(`[MoveSeat] ${playerName} moved to seat ${target} on ${tableId} (${chipCount} chips)`);
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
    // Bomb Pot: if pending, activate it for this hand
    if (bombPotPending.get(tableId)) {
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
        }
      }

      // Skip preflop: advance directly to flop
      // Deal 3 community cards (the table already dealt hole cards in startNewHand)
      if (table.communityCards.length === 0) {
        // Force phase to Flop by dealing community cards
        const deck = (table as any).deck;
        deck.dealOne(); // burn card
        for (let c = 0; c < 3; c++) {
          const card = deck.dealOne();
          if (card) table.communityCards.push(card);
        }
        (table as any).currentPhase = GamePhase.Flop;
        // Ante has already been posted — reset currentBet to 0 for the post-flop betting round
        table.currentBetToMatch = 0;
        for (let i = 0; i < MAX_SEATS; i++) {
          table.seats[i].currentBet = 0;
        }
        // Set active seat to first non-folded player after dealer
        let startIdx = (table.dealerButtonSeat + 1) % MAX_SEATS;
        for (let j = 0; j < MAX_SEATS; j++) {
          const checkSeat = (startIdx + j) % MAX_SEATS;
          const s = table.seats[checkSeat];
          if (s.state === 'occupied' && !s.folded && !s.eliminated && s.chipCount >= 0) {
            table.activeSeatIndex = checkSeat;
            break;
          }
        }
      }
    } else {
      bombPotActive.delete(tableId);
    }

    broadcastGameState(tableId);
    scheduleAIAction(tableId);
  }
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
      console.log(`[LiveRoom] heartbeat: ${trimmedTables} table(s) changed occupancy`);
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

            await saveProgress(authSession.userId, {
              xp: clientProgress.xp,
              level: clientProgress.level,
              achievements: clientProgress.achievements || [],
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
    for (let i = 0; i < MAX_SEATS; i++) {
      const seat = table.seats[i];
      if (seat?.state === 'occupied' && seat.chipCount <= 0 && !seat.eliminated) {
        seat.eliminated = true;
        const eliminatorId = winnerPlayerIds.values().next().value;
        try {
          const result = tournamentManager.eliminatePlayer(tournamentId, seat.playerId, eliminatorId);
          if (result && result.bountyPayout && eliminatorId) {
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
    actionNonces.delete(socket.id);
    actionTimings.delete(socket.id);
    tokenLoginAttempts.delete(socket.id);
    lastEmoteTime.delete(socket.id);
    lastReactionTime.delete(socket.id);
    lastChatTime.delete(socket.id);
  });

  console.log(`Player connected: ${socket.id}`);

  // ========== Auth Events ==========

  socket.on('login', async (data: { phone?: string; username?: string; password: string }) => {
    const phone = data.phone || data.username || '';
    console.log(`[Auth] Login attempt: phone="${phone}", hasPassword=${!!data?.password}`);
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

  // Qualifier status: client checks if the logged-in player is qualified
  socket.on('getQualifications', async (data: { phone: string }) => {
    const phone = (data?.phone || '').trim();
    if (!phone) { socket.emit('qualifications', { weekly: false, monthly: false }); return; }
    const [weekly, monthly] = await Promise.all([
      getQualifiedPlayers('weekly'),
      getQualifiedPlayers('monthly'),
    ]);
    const weeklyEntry = weekly.find(p => p.phone === phone);
    const monthlyEntry = monthly.find(p => p.phone === phone);
    socket.emit('qualifications', {
      weekly: weeklyEntry ? { qualified: true, credits: weeklyEntry.creditCount, venue: weeklyEntry.venueName } : false,
      monthly: monthlyEntry ? { qualified: true, credits: monthlyEntry.creditCount, venue: monthlyEntry.venueName } : false,
    });
  });

  // ========== Qualifier Tournament Registration ==========

  // Register for a qualifier tournament
  socket.on('registerQualifierTournament', async (data: { qualifierId: string; playerName: string; phone: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Must be logged in' }); return; }

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

      // Re-entry: check if they have remaining qualifier credits
      // (The frontend should verify credits before allowing re-entry)
      // Allow the re-entry — they'll be seated at a new table with starting stack
      if (isLateReg && tournament) {
        // Find a table with empty seats and seat them
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
          socket.emit('qualifierRegistrationResult', { success: false, error: 'No seats available for re-entry' });
          return;
        }
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
      const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 5, summary: text, decisions: [], keyLesson: '' };
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
  const stakingOffers: Map<string, any> = (global as any).__stakingOffers || ((global as any).__stakingOffers = new Map());
  socket.on('createStake', async (data: { tournamentId: string; totalPct: number; pricePerPct: number; playerName: string }) => {
    if (!data.tournamentId || typeof data.totalPct !== 'number' || data.totalPct <= 0 || data.totalPct > 100) {
      socket.emit('error', { message: 'Invalid staking offer' }); return;
    }
    if (typeof data.pricePerPct !== 'number' || data.pricePerPct <= 0) {
      socket.emit('error', { message: 'Invalid price per percent' }); return;
    }
    const id = uuidv4();
    const offer = { id, ...data, remaining: data.totalPct, backers: [], createdAt: Date.now() };
    stakingOffers.set(id, offer);
    io.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });
    socket.emit('stakeCreated', { id });
  });
  socket.on('buyStake', async (data: { offerId: string; pct: number; buyerName: string }) => {
    if (!data.offerId || typeof data.pct !== 'number' || data.pct <= 0) {
      socket.emit('buyStakeResult', { success: false, error: 'Invalid purchase' }); return;
    }
    const offer = stakingOffers.get(data.offerId);
    if (!offer || offer.remaining < data.pct) { socket.emit('buyStakeResult', { success: false, error: 'Offer unavailable' }); return; }
    offer.remaining -= data.pct;
    offer.backers.push({ name: data.buyerName || 'Anonymous', pct: data.pct });
    if (offer.remaining <= 0) stakingOffers.delete(data.offerId);
    io.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });
    socket.emit('buyStakeResult', { success: true });
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
  socket.on('oauthLogin', async (data: { accessToken: string }) => {
    if (!data?.accessToken) {
      socket.emit('loginResult', { success: false, error: 'No access token provided' });
      return;
    }
    try {
      const oauthResult = await validateOAuthToken(data.accessToken);
      if (!oauthResult.valid || !oauthResult.sub) {
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
           VALUES ($1, $2, $3, 10000, 1, 0, $4)
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

      authSessions.set(socket.id, { userId, username: localUser.username });
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
              if (reSeat) {
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
            if (reSeatLegacy) {
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
    const result = createClub(auth.userId, data.name, data.description, data.settings || {});
    if (result.success) {
      socket.emit('clubCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('joinClub', async (data: { clubCode: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = joinClub(auth.userId, data.clubCode);
    if (result.success) {
      socket.emit('clubJoined', result);
      if (result.club && result.status === 'active') {
        addActivity(result.club.id, 'member_join', { username: auth.username });
        sendClubMessage(result.club.id, auth.userId, auth.username, `${auth.username} joined the club`, 'system');
      }
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('leaveClub', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = leaveClub(auth.userId, data.clubId);
    if (result.success) {
      socket.emit('clubLeft', { clubId: data.clubId });
      addActivity(data.clubId, 'member_leave', { username: auth.username });
      sendClubMessage(data.clubId, auth.userId, auth.username, `${auth.username} left the club`, 'system');
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getMyClubs', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('myClubs', { success: false, clubs: [] }); return; }
    const result = getMyClubs(auth.userId);
    socket.emit('myClubs', result);
  });

  socket.on('getClubInfo', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    const result = getClubInfo(data.clubId, auth?.userId);
    socket.emit('clubInfo', result);
  });

  socket.on('getClubMembers', async (data: { clubId: number }) => {
    const result = getClubMembers(data.clubId);
    socket.emit('clubMembers', result);
  });

  socket.on('approveMember', async (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = approveMember(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberApproved', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('removeMember', async (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = removeMember(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberRemoved', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('promoteToManager', async (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = promoteToManager(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberPromoted', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('createClubTable', async (data: { clubId: number; config: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = createClubTable(auth.userId, data.clubId, data.config);
    if (result.success && result.table) {
      // Create a real table in the TableManager
      const clubInfoResult = getClubInfo(data.clubId);
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
        updateClubTableId(result.table.id, tableId);
        result.table.tableId = tableId;
      }
      socket.emit('clubTableCreated', { success: true, table: result.table });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubTables', async (data: { clubId: number }) => {
    const result = getClubTables(data.clubId);
    socket.emit('clubTables', result);
  });

  socket.on('joinClubTable', async (data: { clubTableId: number; playerName: string; seatIndex: number; buyIn: number; avatar?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }

    const clubTable = getClubTableById(data.clubTableId);
    if (!clubTable) { socket.emit('error', { message: 'Club table not found' }); return; }
    if (!isClubMember(clubTable.clubId, auth.userId)) {
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
    const result = searchClubs(data.query || '');
    socket.emit('clubSearchResults', result);
  });

  socket.on('updateClubSettings', async (data: { clubId: number; settings: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = updateClubSettings(auth.userId, data.clubId, data.settings);
    if (result.success) {
      socket.emit('clubSettingsUpdated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('deleteClub', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = deleteClub(auth.userId, data.clubId);
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
    if (!isClubMember(data.clubId, auth.userId)) return;
    socket.join(`club:${data.clubId}`);
  });

  socket.on('leaveClubRoom', async (data: { clubId: number }) => {
    socket.leave(`club:${data.clubId}`);
  });

  socket.on('sendClubMessage', async (data: { clubId: number; message: string; type?: 'chat' | 'announcement' | 'system' }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    if (!isClubMember(data.clubId, auth.userId)) { socket.emit('error', { message: 'Not a club member' }); return; }

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
    const result = sendClubMessage(data.clubId, auth.userId, auth.username, msgText, msgType);
    if (result.success && result.message) {
      io.to(`club:${data.clubId}`).emit('clubMessage', result.message);
      if (msgType === 'announcement') {
        addActivity(data.clubId, 'announcement', { username: auth.username, message: data.message });
      }
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubMessages', async (data: { clubId: number; limit?: number }) => {
    const result = getClubMessages(data.clubId, data.limit || 50);
    socket.emit('clubMessages', result);
  });

  socket.on('getClubAnnouncements', async (data: { clubId: number }) => {
    const result = getAnnouncements(data.clubId);
    socket.emit('clubAnnouncements', result);
  });

  socket.on('pinClubMessage', async (data: { clubId: number; messageId: number; pin: boolean }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = data.pin ? pinMessage(data.clubId, data.messageId) : unpinMessage(data.clubId, data.messageId);
    if (result.success) {
      io.to(`club:${data.clubId}`).emit('clubMessagePinned', { messageId: data.messageId, pinned: data.pin });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // ─── Club Leaderboard & Stats ───

  socket.on('getClubLeaderboard', async (data: { clubId: number; period?: 'today' | 'week' | 'alltime' }) => {
    const result = getClubLeaderboard(data.clubId, data.period || 'alltime');
    socket.emit('clubLeaderboard', result);
  });

  socket.on('getClubStatistics', async (data: { clubId: number }) => {
    const result = getClubStatistics(data.clubId);
    socket.emit('clubStatistics', result);
  });

  // ─── Club Activity Feed ───

  socket.on('getClubActivity', async (data: { clubId: number; limit?: number }) => {
    const result = getActivityFeed(data.clubId, data.limit || 20);
    socket.emit('clubActivity', result);
  });

  // ========== Club Tournaments ==========

  socket.on('createClubTournament', async (data: { clubId: number; config: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = createClubTournament(auth.userId, data.clubId, data.config);
    if (result.success) {
      socket.emit('clubTournamentCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubTournaments', async (data: { clubId: number }) => {
    const result = getClubTournaments(data.clubId);
    socket.emit('clubTournaments', result);
  });

  socket.on('registerClubTournament', async (data: { tournamentId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = registerForClubTournament(data.tournamentId, auth.userId);
    if (result.success) {
      socket.emit('clubTournamentRegistered', { tournamentId: data.tournamentId, registered: result.registered });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('startClubTournament', async (data: { tournamentId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = startClubTournament(data.tournamentId, auth.userId);
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
    const result = createChallenge(data.clubId, auth.userId, data.challengedId, data.stakes);
    if (result.success) {
      socket.emit('clubChallengeCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('acceptClubChallenge', async (data: { challengeId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = acceptChallenge(data.challengeId, auth.userId);
    if (result.success) {
      socket.emit('clubChallengeAccepted', { challengeId: data.challengeId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('declineClubChallenge', async (data: { challengeId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = declineChallenge(data.challengeId, auth.userId);
    if (result.success) {
      socket.emit('clubChallengeDeclined', { challengeId: data.challengeId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubChallenges', async (data: { clubId: number }) => {
    const result = getClubChallenges(data.clubId);
    socket.emit('clubChallenges', result);
  });

  // ========== Table Scheduling ==========

  socket.on('scheduleClubTable', async (data: { clubId: number; config: any; scheduledTime: string; recurring: boolean; recurrencePattern?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = scheduleTable(data.clubId, auth.userId, data.config, data.scheduledTime, data.recurring, data.recurrencePattern);
    if (result.success) {
      socket.emit('clubTableScheduled', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getScheduledClubTables', async (data: { clubId: number }) => {
    const result = getScheduledTables(data.clubId);
    socket.emit('scheduledClubTables', result);
  });

  socket.on('activateScheduledClubTable', async (data: { id: number; clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = activateScheduledTable(data.id, auth.userId);
    if (result.success && result.tableConfig) {
      // Create the actual table
      const clubInfoResult = getClubInfo(data.clubId);
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
    const result = deleteScheduledTable(data.id, auth.userId);
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

    const result = createBlindStructure(data.clubId, auth.userId, data.name, data.levels);
    if (result.success) {
      socket.emit('blindStructureCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getBlindStructures', async (data: { clubId: number }) => {
    const result = getBlindStructures(data.clubId);
    socket.emit('blindStructures', result);
  });

  socket.on('deleteBlindStructure', async (data: { id: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = deleteBlindStructure(data.id, auth.userId);
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
    const result = inviteToClub(data.clubId, auth.userId, auth.username || '', data.invitedUsername);
    if (result.success) {
      socket.emit('invitationSent', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getMyInvitations', async () => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('myInvitations', { success: false, invitations: [] }); return; }
    const result = getMyInvitations(auth.userId);
    socket.emit('myInvitations', result);
  });

  socket.on('acceptInvitation', async (data: { invitationId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = acceptInvitation(data.invitationId, auth.userId);
    if (result.success) {
      socket.emit('invitationAccepted', result);
      socket.emit('myClubs', getMyClubs(auth.userId));
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('declineInvitation', async (data: { invitationId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = declineInvitation(data.invitationId, auth.userId);
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
    const result = createUnion(data.clubId, auth.userId, data.name, data.description);
    if (result.success) {
      socket.emit('unionCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getUnionInfo', async (data: { clubId: number }) => {
    const result = getUnionInfo(data.clubId);
    socket.emit('unionInfo', result);
  });

  // ── Feature 12: Member Profiles ──

  socket.on('getMemberProfile', async (data: { clubId: number; userId: number }) => {
    const result = getMemberProfile(data.clubId, data.userId);
    socket.emit('memberProfile', result);
  });

  // ── Feature 13: Club Badges ──

  socket.on('updateClubBadge', async (data: { clubId: number; badge: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = updateClubBadge(data.clubId, auth.userId, data.badge);
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
    const result = generateReferralCode(data.clubId, auth.userId);
    socket.emit('referralCode', result);
  });

  socket.on('joinByReferral', async (data: { referralCode: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = joinByReferral(data.referralCode, auth.userId);
    if (result.success) {
      socket.emit('referralJoined', result);
      socket.emit('myClubs', getMyClubs(auth.userId));
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getReferralStats', async (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = getReferralStats(data.clubId, auth.userId);
    socket.emit('referralStats', result);
  });

  // ── Feature 15: Club Levels ──

  socket.on('getClubLevel', async (data: { clubId: number }) => {
    const result = getClubLevel(data.clubId);
    socket.emit('clubLevel', result);
  });

  // ── Feature 16: Featured Clubs ──

  socket.on('getFeaturedClubs', async () => {
    const featured = getFeaturedClubs();
    const clubOfWeek = getClubOfWeek();
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
      console.log(`[QP] inProgress=${inProgress}, occupied=${occupied}, phase=${table.currentPhase}`);
      if (!inProgress && occupied >= 2) {
        const started = table.startNewHand();
        console.log(`[QP] startNewHand result: ${started}, phase now: ${table.currentPhase}, cards: ${table.seats[targetSeat].holeCards.length}`);
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
        progress.stars -= cost;
        progress.chips += payout;
        dbPersistStars(ctx.userId, progress.stars).catch(() => {});
        await addChipsToUser(ctx.userId, payout);
        socket.emit('purchaseResult', { success: true, itemType, itemId, cost, payout });
        sendProgressToPlayer(socket.id);
        return;
      }

      // Mystery box: spend stars → roll a random reward (chips / stars
      // refund / cosmetic). Tier determines loot quality.
      if (itemType === 'mystery_box') {
        progress.stars -= cost;
        dbPersistStars(ctx.userId, progress.stars).catch(() => {});

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
          progress.stars += amt;
          dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
            progress.stars += refund;
            dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
          progress.stars += refund;
        }
        dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
        progress.stars -= cost;
        dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
        progress.stars -= cost;
        dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
      progress.stars -= cost;
      dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
      dbPersistStars(ctx.userId, progress.stars).catch(() => {});
      await updateLoginStreak(ctx.userId, newStreak);
      await recordDailyClaim(ctx.userId, 'login', { day, chips, stars });

      socket.emit('dailyLoginClaimed', { success: true, day, streak: newStreak, chips, stars });
      sendProgressToPlayer(socket.id);
    } catch (err: any) {
      console.error('claimDailyLogin error:', err);
      socket.emit('dailyLoginClaimed', { success: false, error: 'server_error' });
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
      if (reward.stars > 0) dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
        progress.stars += reward.stars;
        dbPersistStars(ctx.userId, progress.stars).catch(() => {});
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
  socket.on('getAchievements', () => {
    const session = playerSessions.get(socket.id);
    const playerId = session?.playerId;
    if (!playerId) {
      socket.emit('achievementsList', { daily: [], weekly: [], lifetime: [], windowEndsAt: { daily: 0, weekly: 0 } });
      return;
    }
    const summary = progressionManager.getAchievementsSummary(playerId);
    socket.emit('achievementsList', summary || { daily: [], weekly: [], lifetime: [], windowEndsAt: { daily: 0, weekly: 0 } });
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
          socket.emit('loginResult', { success: false, error: 'Token verify failed' });
          return;
        }
        const verifyJson: any = await verifyRes.json();
        const payload = verifyJson?.data || verifyJson;
        if (!payload?.valid) {
          socket.emit('loginResult', { success: false, error: `Invalid token: ${payload?.reason || 'unknown'}` });
          return;
        }
        const remoteUserId = payload.payload?.userId;
        if (!remoteUserId) {
          socket.emit('loginResult', { success: false, error: 'Token missing userId' });
          return;
        }

        // 2. Fetch master user details
        let meRes;
        try {
          meRes = await fetchWithTimeout(`${MASTER_API_BASE}/users/${remoteUserId}/me`);
        } catch (err: any) {
          const isTimeout = err?.name === 'AbortError';
          socket.emit('loginResult', {
            success: false,
            error: isTimeout ? 'Auth service slow — please try again' : 'Could not load user',
          });
          return;
        }
        if (!meRes.ok) {
          socket.emit('loginResult', { success: false, error: 'Could not load user' });
          return;
        }
        const meJson: any = await meRes.json();
        const masterUser = meJson?.data || meJson;
        const phone = masterUser.phoneNumber || masterUser.phone_number;
        const displayName = masterUser.firstName
          ? `${masterUser.firstName} ${(masterUser.lastName || '')[0] || ''}.`.trim()
          : masterUser.username || phone;

        // 3. Lookup or insert local user. We key on the master phone number
        //    (same convention as syncMasterUser in authManager.ts). We do NOT
        //    overwrite an existing password_hash on upsert — only insert when
        //    absent so a ticket-login never invalidates the user's password.
        const bcrypt = require('bcryptjs');
        const placeholderHash = bcrypt.hashSync(
          `ticket-placeholder-${remoteUserId}-${Date.now()}`,
          10
        );
        const { rows } = await getPool().query(
          `INSERT INTO users (username, display_name, password_hash, chips, level, xp, stats)
             VALUES ($1, $2, $3, 10000, 1, 0, $4)
             ON CONFLICT (LOWER(username)) DO UPDATE
               SET display_name = COALESCE(users.display_name, $2)
           RETURNING *`,
          [phone, displayName, placeholderHash, JSON.stringify({ masterPhone: phone, masterUsername: masterUser.username, masterUserId: remoteUserId })]
        );
        const localUser = rows[0];

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
            const meRes = await fetchWithTimeout(`${MASTER_API_BASE}/users/${remoteUserId}/me`);
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
            }
          } catch (e) {
            console.warn('[joinWithWaitlistContext] auth-bootstrap failed:', (e as Error).message);
          }
        }

        // If we still don't have an auth session after the bootstrap attempt,
        // abort rather than seating an unauthenticated player who will then
        // silently fail on every subsequent action.
        if (!authSessions.has(socket.id)) {
          socket.emit('error', { message: 'Authentication could not be established — please sign in and try again.' });
          return;
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
        {
          const authNow = authSessions.get(socket.id);
          if (authNow) clearGhostSeatsForUser(authNow.userId, bestTable.tableId, socket.id, targetSeat);
        }
        const success = table.sitDown(
          targetSeat,
          playerName,
          table.config.minBuyIn,
          playerId,
          false
        );
        if (!success) {
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
    // Don't allow rebuys in the middle of a hand while the player is
    // still in the pot — the stack is committed. Rebuy between hands or
    // while folded/sat-out only.
    if (table.isHandInProgress() && !seat.folded) {
      socket.emit('error', { message: 'Cannot rebuy while in a live hand — wait for the hand to finish' });
      return;
    }
    const requested = Math.max(table.config.minBuyIn, data?.amount || table.config.minBuyIn);
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
    seat.chipCount = requested;
    seat.eliminated = false;
    broadcastGameState(session.tableId);
    socket.emit('rebuyComplete', { success: true, newStack: requested, added: topUpAmount });
    console.log(`[Rebuy] ${seat.playerName} topped up by ${topUpAmount} to ${requested}`);
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
      // can't replay a nonce from one table at another)
      if (data.nonce) {
        const nonceKey = `${session.tableId}:${session.seatIndex}`;
        const lastNonce = actionNonces.get(nonceKey);
        if (lastNonce === data.nonce) {
          socket.emit('error', { message: 'Duplicate action' });
          return;
        }
        actionNonces.set(nonceKey, data.nonce);
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

    const result = progressionManager.claimDailyBonus(session.playerId);
    if (result.success) {
      socket.emit('dailyBonusClaimed', {
        chips: result.chips,
        stars: result.stars,
        streak: result.streak,
      });
    } else {
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

    // Verify the player is at this table (owner/manager check could be added)
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

    const tableId = tableManager.createHeadsUpTable(`Heads-Up Snap: ${playerName}`);
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, playerName, 1000, playerId, false);

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
      500
    );
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, playerName, 500, playerId, false);

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

    const tableId = tableManager.createQuickTable(
      'All-In or Fold',
      6,
      10,
      20,
      1000
    );
    const table = tableManager.getTable(tableId)!;

    const playerId = `player-${uuidv4()}`;
    table.sitDown(0, playerName, 1000, playerId, false);

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
    const session = playerSessions.get(socket.id);
    if (!session) return;

    // Cost is looked up server-side — never trust cost from the client
    const THEME_COSTS: Record<string, number> = {
      gold: 500, neon: 300, classic: 200, dark: 250, ocean: 350, royal: 600,
    };
    const cost = THEME_COSTS[data.themeId] ?? 400;

    const result = progressionManager.purchaseTheme(session.playerId, data.themeId, cost);
    if (result.success) {
      socket.emit('themePurchased', { themeId: data.themeId });
    } else {
      socket.emit('error', { message: result.error || 'Purchase failed' });
    }
    sendProgressToPlayer(socket.id);
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
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const result = progressionManager.equipTheme(session.playerId, data.themeId);
    if (result.success) {
      socket.emit('themeEquipped', { themeId: data.themeId });
    } else {
      socket.emit('error', { message: result.error || 'Equip failed' });
    }
    sendProgressToPlayer(socket.id);
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

    const result = tournamentManager.registerPlayer(data.tournamentId, playerId, playerName, socket.id);
    if (result.success) {
      socket.emit('tournamentRegistered', { tournamentId: data.tournamentId });

      // Check if tournament can auto-start
      if (tournamentManager.canStart(data.tournamentId)) {
        startTournamentGame(data.tournamentId);
      }
    } else {
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

    const playerId = `player-${uuidv4()}`;
    // Ghost-seat defense (multi-table / joinTableAsPlayer path).
    {
      const authNow = authSessions.get(socket.id);
      if (authNow) clearGhostSeatsForUser(authNow.userId, tableId, socket.id, targetSeat);
    }
    const success = table.sitDown(targetSeat, playerName, buyIn, playerId, false);
    if (!success) {
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

    const actualBuyIn = Math.max(table.config.minBuyIn, buyIn || table.config.minBuyIn);

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
  const predictionBets = new Map<string, { socketId: string; outcome: string; amount: number }[]>();

  socket.on('marketBet', async (data: { marketId: string; handId: string; outcome: string; amount: number }) => {
    if (!data.marketId || !data.handId || !data.outcome || typeof data.amount !== 'number' || data.amount <= 0) return;
    const key = `${data.marketId}:${data.handId}`;
    const existing = predictionBets.get(key) || [];
    existing.push({ socketId: socket.id, outcome: data.outcome, amount: data.amount });
    predictionBets.set(key, existing);
  });

  socket.on('marketResolve', async (data: { marketId: string; handId: string; winningOutcome: string }) => {
    if (!data.marketId || !data.handId || !data.winningOutcome) return;
    const key = `${data.marketId}:${data.handId}`;
    const bets = predictionBets.get(key);
    if (!bets || bets.length === 0) return;

    const totalPool = bets.reduce((sum, b) => sum + b.amount, 0);
    const winners = bets.filter((b) => b.outcome === data.winningOutcome);
    const totalWinnerStake = winners.reduce((sum, b) => sum + b.amount, 0);

    if (winners.length === 0) {
      // No winners — refund all bettors
      for (const bet of bets) {
        const s = io.sockets.sockets.get(bet.socketId);
        if (s) s.emit('marketResult', { marketId: data.marketId, handId: data.handId, refund: bet.amount, payout: 0 });
      }
    } else {
      // Pay winners proportionally from total pool
      for (const bet of winners) {
        const payout = Math.floor((bet.amount / totalWinnerStake) * totalPool);
        const s = io.sockets.sockets.get(bet.socketId);
        if (s) s.emit('marketResult', { marketId: data.marketId, handId: data.handId, payout, refund: 0 });
      }
      // Losers get nothing (their bets funded the pool)
      const loserSocketIds = new Set(bets.filter((b) => b.outcome !== data.winningOutcome).map((b) => b.socketId));
      for (const sid of loserSocketIds) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('marketResult', { marketId: data.marketId, handId: data.handId, payout: 0, refund: 0 });
      }
    }

    predictionBets.delete(key);
  });

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
          await saveProgress(authSession.userId, {
            xp: prog?.xp,
            level: prog?.level,
            achievements: prog?.achievements || [],
          });

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

          // Don't call handlePlayerLeave — seat stays reserved
          playerSessions.delete(socket.id);
          authSessions.delete(socket.id);
          lastSentState.delete(socket.id); lastSentJson.delete(socket.id);
          return;
        }
      }
    }

    if (authSession) authSessions.delete(socket.id);
    handlePlayerLeave(socket);
    // Clear delta tracking so a reconnect gets a fresh full state
    lastSentState.delete(socket.id); lastSentJson.delete(socket.id);
  });
});

function handlePlayerLeave(socket: Socket): void {
  const session = playerSessions.get(socket.id);
  if (!session) return;

  const table = tableManager.getTable(session.tableId);
  if (table) {
    // If hand is in progress, fold first
    if (
      table.isHandInProgress() &&
      table.activeSeatIndex === session.seatIndex
    ) {
      table.playerFold(session.seatIndex);
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
    const auth = authSessions.get(socket.id);
    const chipsToReturn = leavingSeat?.chipCount || 0;
    if (auth && chipsToReturn > 0) {
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

    socket.leave(`table:${session.tableId}`);
  }

  playerSessions.delete(socket.id);

  // Clean up multi-table sessions
  const multiSessions = multiTableSessions.get(socket.id);
  if (multiSessions) {
    for (const ms of multiSessions) {
      const mt = tableManager.getTable(ms.tableId);
      if (mt) {
        if (mt.isHandInProgress() && mt.activeSeatIndex === ms.seatIndex) {
          mt.playerFold(ms.seatIndex);
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
    }
    if (event === 'tournamentFinished') {
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
  const playerCount = req.body?.playerCount || 200;
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
  initClubTables();

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
      let mutatedStats = false;

      // One-time 1B chip recovery grant — compensates for the disconnect
      // chip-wipe bug (fixed in 03b5170).
      if (!stats.chipRecoveryGrantApplied) {
        const GRANT_AMOUNT = 1_000_000_000;
        await pool.query(`UPDATE users SET chips = chips + $1 WHERE id = $2`, [GRANT_AMOUNT, user.id]);
        stats.chipRecoveryGrantApplied = true;
        stats.chipRecoveryGrantAt = new Date().toISOString();
        mutatedStats = true;
        console.log(`[Recovery] Granted ${GRANT_AMOUNT.toLocaleString()} chips to admin userId=${user.id} (${adminPhone})`);
      }

      // One-time stars recovery grant — compensates for the persistStars
      // pre-hydration clobber bug (fixed this commit).
      if (!stats.starsRecoveryGrantApplied) {
        const STARS_GRANT = 50000;
        await pool.query(`UPDATE users SET stars = stars + $1 WHERE id = $2`, [STARS_GRANT, user.id]);
        stats.starsRecoveryGrantApplied = true;
        stats.starsRecoveryGrantAt = new Date().toISOString();
        mutatedStats = true;
        console.log(`[Recovery] Granted ${STARS_GRANT.toLocaleString()} stars to admin userId=${user.id} (${adminPhone})`);
      }

      if (mutatedStats) {
        await pool.query(`UPDATE users SET stats = $1 WHERE id = $2`, [JSON.stringify(stats), user.id]);
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
    for (const [socketId, session] of playerSessions) {
      try {
        const auth = authSessions.get(socketId);
        if (!auth) continue;
        const table = tableManager.getTable(session.tableId);
        const seat = table?.seats?.[session.seatIndex];
        if (seat && seat.state === 'occupied' && seat.chipCount > 0) {
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
        if (chips > 0) {
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
  } finally {
    // Give the logger a moment, then exit so Railway can finish the redeploy.
    setTimeout(() => process.exit(0), 500);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

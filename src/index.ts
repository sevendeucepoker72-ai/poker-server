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
} from './game/PokerTable';
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
import { initDB, loginUser, loginUserAsync, registerUser, isUsernameTaken, getUserFromToken, saveProgress, loadProgress, isUserAdmin, isUserBanned, getUserChips, deductChips, bumpTokenVersion, getAllUsers, banUser as banUserDB, unbanUser as unbanUserDB, addChipsToUser, getTotalUsers, getLeaderboard, searchUsers, mergeUserStats } from './auth/authManager';
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
}

const playerSessions = new Map<string, PlayerSession>();

// Turn timeout: tableId -> { timeout, seatIndex, turnId }
const turnTimers = new Map<string, { timeout: ReturnType<typeof setTimeout>; seatIndex: number; turnId: number }>();
let globalTurnId = 0;
const TURN_TIMEOUT_MS = 30000; // 30 seconds

// Track when each table's current turn started (epoch ms) so clients can render
// a per-player countdown ring.
const turnStartedAtMap = new Map<string, number>();

// Delta state tracking: socketId -> last full state sent to that client
const lastSentState = new Map<string, Record<string, any>>();

/**
 * Compute a shallow diff between two state objects.
 * Returns only the top-level keys whose values changed (by reference/JSON equality).
 */
function shallowDiff(prev: Record<string, any>, next: Record<string, any>): Record<string, any> | null {
  const delta: Record<string, any> = {};
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    const prevVal = prev[key];
    const nextVal = next[key];
    if (prevVal !== nextVal) {
      // For primitive values a reference check suffices; for objects use JSON comparison
      if (typeof nextVal === 'object' && nextVal !== null) {
        if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
          delta[key] = nextVal;
        }
      } else {
        delta[key] = nextVal;
      }
    }
  }
  return Object.keys(delta).length > 0 ? delta : null;
}

/**
 * Emit game state to a single socket using delta compression.
 * Sends a full state on first send or reconnect; subsequent sends only include changed keys.
 * Pass forceFullState=true to always send the full state (e.g. on joinTable / reconnect).
 */
function emitGameState(socket: any, state: any, forceFullState = false): void {
  const prev = lastSentState.get(socket.id);
  if (!prev || forceFullState) {
    socket.emit('gameState', { full: true, state });
    lastSentState.set(socket.id, state);
  } else {
    const delta = shallowDiff(prev, state);
    if (delta) {
      socket.emit('gameState', { full: false, delta });
      // Merge into stored state so subsequent diffs are accurate
      lastSentState.set(socket.id, { ...prev, ...delta });
    }
    // If nothing changed, skip emitting entirely
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
// Chip velocity auto-ban counter: userId -> alert count
const chipVelocityAlerts = new Map<number, number>();

// Module-scope audit log (used by anti-cheat auto-ban, admin ops, and buy-in audit)
function auditLog(actorUsername: string, action: string, details: Record<string, unknown> = {}) {
  const entry = `[AUDIT] ${new Date().toISOString()} | ${actorUsername} | ${action} | ${JSON.stringify(details)}`;
  console.log(entry);
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
  // chipVelocity: drop entries with no recent activity
  for (const [uid, v] of chipVelocity) {
    if (now - v.sessionStartAt > 4 * 60 * 60 * 1000) chipVelocity.delete(uid); // 4h idle
  }
}, 60_000).unref?.();

// Auth session tracking: socketId -> userId
const authSessions = new Map<string, { userId: number; username: string }>();

// Tournament table mapping: tableId -> tournamentId
const tournamentTables = new Map<string, string>();

// Fast mode tracking per table (#12)
const fastModeTables = new Map<string, boolean>();

// Missed blinds tracking per table per seat (#16)
// tableId -> Map<seatIndex, missedBlindsAmount>
const missedBlinds = new Map<string, Map<number, number>>();

// Track which seats were sitting out when they missed blinds (#16)
const sitOutTracker = new Map<string, Set<number>>();

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
}
const reservedSeats = new Map<number, ReservedSeat>();
const SEAT_RESERVE_MS = 10 * 60 * 1000; // 10 minutes

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

// ========== Helper Functions ==========

function getVariantInfo(table: PokerTable): { variant: VariantType; variantName: string; holeCardCount: number; hasDrawPhase: boolean; isStudGame: boolean } {
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

  // Add bomb pot flag
  if (bombPotActive.get(table.config.tableId)) {
    stateObj.bombPot = true;
  }

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

  // Add missed blinds for this player (#16)
  if (playerSeatIndex >= 0) {
    const tableMissed = missedBlinds.get(table.config.tableId);
    if (tableMissed && tableMissed.has(playerSeatIndex)) {
      stateObj.missedBlinds = tableMissed.get(playerSeatIndex);
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

  // Server-side turn timeout: clear old timer, set new one if hand is in progress
  {
    const existing = turnTimers.get(tableId);
    if (existing) clearTimeout(existing.timeout);
    turnTimers.delete(tableId);

    if (table.isHandInProgress() && table.activeSeatIndex >= 0) {
      const activeSeat = table.activeSeatIndex;
      const turnId = ++globalTurnId;
      turnStartedAtMap.set(tableId, Date.now());
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

function ensureTableProgressListener(table: PokerTable, tableId: string): void {
  if (tableProgressListeners.has(tableId)) return;
  tableProgressListeners.add(tableId);

  table.on('handResult', (data: { results: any[]; handNumber: number }) => {
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
          chipsAtStart: getUserChips(userId),
          sessionStartAt: Date.now(),
          handsThisSession: 0,
          lastActionMs: [],
        });
      }
      const vel = chipVelocity.get(userId)!;
      vel.handsThisSession++;
      if (result.chipsWon && result.chipsWon > 0) {
        const currentChips = getUserChips(userId);
        const gained = currentChips - vel.chipsAtStart;
        const sessionMinutes = (Date.now() - vel.sessionStartAt) / 60_000;
        if (vel.handsThisSession >= 5 && gained > vel.chipsAtStart * 10) {
          console.warn(`[AntiCheat] Chip velocity alert: userId=${userId} gained ${gained} chips (${vel.handsThisSession} hands, ${sessionMinutes.toFixed(1)}m)`);
          // Track alert count; auto-ban after 3 alerts
          chipVelocityAlerts.set(userId, (chipVelocityAlerts.get(userId) || 0) + 1);
          const alertCount = chipVelocityAlerts.get(userId)!;
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
      }
    }
  });
}

function fillWithAI(
  table: PokerTable,
  tableId: string,
  difficulty: Difficulty = 'hard'
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

  // Count empty seats — always leave at least 1 open for a live player
  const emptySeats = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    if (table.seats[i].state === 'empty') {
      emptySeats.push(i);
    }
  }

  // Leave 1 seat open for live players
  const seatsToFill = emptySeats.slice(0, Math.max(0, emptySeats.length - 1));

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

  const profile = profiles.get(activeSeat);
  if (!profile) { return; }

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
  // Normalize AI response window to a fixed range so timing doesn't leak hand strength.
  // Internally compute the "natural" delay but clamp to [800, 1200]ms (or 300ms in fast mode).
  const naturalDelay = getThinkingDelay(profile.difficulty);
  const delay = isFastMode ? 300 : Math.min(1200, Math.max(800, naturalDelay));
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
      // Cancel any previously scheduled auto-start for this table (defensive)
      const existing = pendingAutoStartTimers.get(tableId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        pendingAutoStartTimers.delete(tableId);
        autoStartNextHand(tableId);
      }, 3000);
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

function autoStartNextHand(tableId: string): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;

  if (table.currentPhase !== GamePhase.HandComplete) return;

  // Remove eliminated AI players; give human players a free reload
  for (let i = 0; i < MAX_SEATS; i++) {
    const seat = table.seats[i];
    if (seat.state === 'occupied' && seat.chipCount <= 0) {
      if (seat.isAI) {
        table.standUp(i);
        const profiles = aiProfiles.get(tableId);
        if (profiles) profiles.delete(i);
      } else {
        // Human player at 0 chips: free reload to min buy-in
        seat.chipCount = table.config.minBuyIn;
        seat.eliminated = false;
        console.log(`[Reload] ${seat.playerName} reloaded with ${table.config.minBuyIn} chips`);
      }
    }
  }

  // Refill AI seats if needed
  const humanCount = table.seats.filter(
    (s) => s.state === 'occupied' && !s.isAI
  ).length;
  if (humanCount > 0) {
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

// ========== Progression Helpers ==========

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

function handleHandComplete(tableId: string, results: any[]): void {
  const table = tableManager.getTable(tableId);
  if (!table) return;

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
    // Everyone who played gets recordHandPlayed + 5 XP
    progressionManager.recordHandPlayed(session.playerId);
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
          mergeUserStats(authSession.userId, {
            handsPlayed: clientProgress.totalHandsPlayed || 0,
            handsWon: clientProgress.handsWon || 0,
            biggestPot: clientProgress.biggestPot || 0,
            lastHandAt: Date.now(),
          });
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
        } catch (e) {
          console.error('[Tournament] eliminatePlayer failed:', e);
        }
      }
    }
  }
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

  socket.on('disconnect', () => {
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
  });

  socket.on('register', (data: { username: string; password: string }) => {
    const result = registerUser(data.username, data.password);
    if (result.success && result.userData) {
      authSessions.set(socket.id, { userId: result.userData.id, username: result.userData.username });
    }
    socket.emit('registerResult', result);
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

  socket.on('checkUsername', (data: { username: string }) => {
    const name = (data.username || '').trim();
    if (name.length < 2) { socket.emit('checkUsernameResult', { available: null, username: name }); return; }
    const taken = isUsernameTaken(name);
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
  socket.on('voiceJoin', (data: { tableId: string; username: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    if (!data?.tableId || !isSeatedAt(data.tableId)) { socket.emit('error', { message: 'Not seated at table' }); return; }
    const room = `voice_${data.tableId}`;
    socket.join(room);
    // Use the authenticated username, not the one the client sent.
    socket.to(room).emit('voicePeerJoined', { socketId: socket.id, username: auth.username });
  });
  socket.on('voiceLeave', (data: { tableId: string }) => {
    if (!authSessions.get(socket.id)) return;
    if (!data?.tableId) return;
    socket.leave(`voice_${data.tableId}`);
    socket.to(`voice_${data.tableId}`).emit('voicePeerLeft', { socketId: socket.id });
  });
  socket.on('voiceOffer', (data: { to: string; offer: any; username: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !data?.to) return;
    io.to(data.to).emit('voiceOffer', { from: socket.id, offer: data.offer, username: auth.username });
  });
  socket.on('voiceAnswer', (data: { to: string; answer: any }) => {
    if (!authSessions.get(socket.id) || !data?.to) return;
    io.to(data.to).emit('voiceAnswer', { from: socket.id, answer: data.answer });
  });
  socket.on('voiceIce', (data: { to: string; candidate: any }) => {
    if (!authSessions.get(socket.id) || !data?.to) return;
    io.to(data.to).emit('voiceIce', { from: socket.id, candidate: data.candidate });
  });

  // ========== Staking Marketplace ==========
  const stakingOffers: Map<string, any> = (global as any).__stakingOffers || ((global as any).__stakingOffers = new Map());
  socket.on('createStake', (data: { tournamentId: string; totalPct: number; pricePerPct: number; playerName: string }) => {
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
  socket.on('buyStake', (data: { offerId: string; pct: number; buyerName: string }) => {
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
  socket.on('getStakes', () => {
    socket.emit('stakingUpdated', { offers: Array.from(stakingOffers.values()) });
  });

  socket.on('tokenLogin', (data: { token: string }) => {
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

    const result = getUserFromToken(data.token);
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
            clearTimeout(reserved.cleanupTimer);
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
            // (they'll sit back in since they reconnected)
            restoredSession.sittingOut = false;
            const tracker = sitOutTracker.get(reserved.tableId);
            if (tracker) tracker.delete(reserved.seatIndex);

            socket.emit('reconnectedToTable', {
              tableId: reserved.tableId,
              seatIndex: reserved.seatIndex,
            });

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
  });

  socket.on('logout', () => {
    authSessions.delete(socket.id);
  });

  socket.on('loadProgress', (data: { userId: number }) => {
    const result = loadProgress(data.userId);
    socket.emit('progressLoaded', result);
  });

  socket.on('saveProgress', (data: { userId: number; chips?: number; level?: number; xp?: number; stats?: Record<string, any>; achievements?: string[] }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || auth.userId !== data.userId) {
      socket.emit('error', { message: 'Unauthorized' }); return;
    }
    const { userId, ...progressData } = data;
    const success = saveProgress(userId, progressData);
    socket.emit('progressSaved', { success });
  });

  // ========== End Auth Events ==========

  // ========== Spin Wheel / Reward Events ==========

  socket.on('claimSpinReward', (data: { type: string; value: number; label: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }

    // Validate daily limit (server-side)
    const spinKey = `spin_${auth.userId}_${new Date().toDateString()}`;
    if ((global as any).__spinTracker?.[spinKey]) {
      socket.emit('error', { message: 'Daily spin already claimed' });
      return;
    }
    if (!(global as any).__spinTracker) (global as any).__spinTracker = {};
    (global as any).__spinTracker[spinKey] = true;

    if (data.type === 'chips' || data.type === 'mystery') {
      const chips = data.type === 'mystery' ? Math.floor(Math.random() * 3000) + 500 : data.value;
      addChipsToUser(auth.userId, chips);
      socket.emit('spinRewardClaimed', { type: 'chips', value: chips });
    } else if (data.type === 'xp_multiplier') {
      socket.emit('spinRewardClaimed', { type: 'xp_multiplier', value: data.value });
    } else if (data.type === 'xp') {
      // XP from scratch cards
      socket.emit('spinRewardClaimed', { type: 'xp', value: data.value });
    }
  });

  // ========== Leaderboard Events ==========

  socket.on('getLeaderboard', (data: { period?: string }) => {
    try {
      const period = data?.period || 'alltime';
      const entries = getLeaderboard(50, period);
      socket.emit('leaderboardData', { period, entries });
    } catch {
      socket.emit('leaderboardData', { period: data?.period || 'alltime', entries: [] });
    }
  });

  socket.on('searchPlayers', (data: { query: string }) => {
    try {
      const q = (data?.query || '').trim();
      if (q.length < 2) { socket.emit('playerSearchResults', { results: [] }); return; }
      socket.emit('playerSearchResults', { results: searchUsers(q) });
    } catch {
      socket.emit('playerSearchResults', { results: [] });
    }
  });

  // ========== Admin Events ==========
  // auditLog is declared at module scope

  socket.on('getAdminStats', () => {
    const auth = authSessions.get(socket.id);
    if (!auth || !isUserAdmin(auth.userId)) {
      socket.emit('adminStats', { error: 'Access denied' });
      return;
    }

    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const memUsage = process.memoryUsage();
    const memMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);

    socket.emit('adminStats', {
      totalUsers: getTotalUsers(),
      activeConnections: io.engine.clientsCount,
      tablesRunning: tableManager.getTableList().length,
      handsPlayedToday,
      uptime: `${hours}h ${mins}m`,
      memoryUsage: `${memMB} MB`,
      users: getAllUsers(),
    });
  });

  socket.on('adminGrantChips', (data: { userId: number; amount: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !isUserAdmin(auth.userId)) {
      socket.emit('error', { message: 'Access denied' });
      return;
    }
    const CHIP_GRANT_ALERT_THRESHOLD = 1_000_000;
    const amount = Math.floor(data.amount);
    if (amount <= 0 || amount > 100_000_000) {
      socket.emit('error', { message: 'Invalid chip amount' });
      return;
    }
    auditLog(auth.username, 'GRANT_CHIPS', { targetUserId: data.userId, amount });
    if (amount >= CHIP_GRANT_ALERT_THRESHOLD) {
      console.warn(`[AntiCheat] LARGE CHIP GRANT ALERT: admin ${auth.username} granted ${amount} chips to userId=${data.userId}`);
    }
    const success = addChipsToUser(data.userId, amount);
    socket.emit('adminGrantChipsResult', { success, userId: data.userId, amount });
  });

  socket.on('banUser', (data: { userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !isUserAdmin(auth.userId)) {
      socket.emit('error', { message: 'Access denied' });
      return;
    }
    auditLog(auth.username, 'BAN_USER', { targetUserId: data.userId });
    banUserDB(data.userId);
    socket.emit('userBanned', { userId: data.userId });
  });

  socket.on('unbanUser', (data: { userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth || !isUserAdmin(auth.userId)) {
      socket.emit('error', { message: 'Access denied' });
      return;
    }
    auditLog(auth.username, 'UNBAN_USER', { targetUserId: data.userId });
    unbanUserDB(data.userId);
    socket.emit('userUnbanned', { userId: data.userId });
  });

  // ========== End Admin Events ==========

  // ========== Club Events ==========

  socket.on('createClub', (data: { name: string; description: string; settings?: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = createClub(auth.userId, data.name, data.description, data.settings || {});
    if (result.success) {
      socket.emit('clubCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('joinClub', (data: { clubCode: string }) => {
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

  socket.on('leaveClub', (data: { clubId: number }) => {
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

  socket.on('getMyClubs', () => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('myClubs', { success: false, clubs: [] }); return; }
    const result = getMyClubs(auth.userId);
    socket.emit('myClubs', result);
  });

  socket.on('getClubInfo', (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    const result = getClubInfo(data.clubId, auth?.userId);
    socket.emit('clubInfo', result);
  });

  socket.on('getClubMembers', (data: { clubId: number }) => {
    const result = getClubMembers(data.clubId);
    socket.emit('clubMembers', result);
  });

  socket.on('approveMember', (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = approveMember(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberApproved', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('removeMember', (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = removeMember(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberRemoved', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('promoteToManager', (data: { clubId: number; userId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = promoteToManager(auth.userId, data.clubId, data.userId);
    if (result.success) {
      socket.emit('memberPromoted', { clubId: data.clubId, userId: data.userId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('createClubTable', (data: { clubId: number; config: any }) => {
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

  socket.on('getClubTables', (data: { clubId: number }) => {
    const result = getClubTables(data.clubId);
    socket.emit('clubTables', result);
  });

  socket.on('joinClubTable', (data: { clubTableId: number; playerName: string; seatIndex: number; buyIn: number; avatar?: string }) => {
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

  socket.on('searchClubs', (data: { query: string }) => {
    const result = searchClubs(data.query || '');
    socket.emit('clubSearchResults', result);
  });

  socket.on('updateClubSettings', (data: { clubId: number; settings: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = updateClubSettings(auth.userId, data.clubId, data.settings);
    if (result.success) {
      socket.emit('clubSettingsUpdated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('deleteClub', (data: { clubId: number }) => {
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

  socket.on('joinClubRoom', (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) return;
    if (!isClubMember(data.clubId, auth.userId)) return;
    socket.join(`club:${data.clubId}`);
  });

  socket.on('leaveClubRoom', (data: { clubId: number }) => {
    socket.leave(`club:${data.clubId}`);
  });

  socket.on('sendClubMessage', (data: { clubId: number; message: string; type?: 'chat' | 'announcement' | 'system' }) => {
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

  socket.on('getClubMessages', (data: { clubId: number; limit?: number }) => {
    const result = getClubMessages(data.clubId, data.limit || 50);
    socket.emit('clubMessages', result);
  });

  socket.on('getClubAnnouncements', (data: { clubId: number }) => {
    const result = getAnnouncements(data.clubId);
    socket.emit('clubAnnouncements', result);
  });

  socket.on('pinClubMessage', (data: { clubId: number; messageId: number; pin: boolean }) => {
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

  socket.on('getClubLeaderboard', (data: { clubId: number; period?: 'today' | 'week' | 'alltime' }) => {
    const result = getClubLeaderboard(data.clubId, data.period || 'alltime');
    socket.emit('clubLeaderboard', result);
  });

  socket.on('getClubStatistics', (data: { clubId: number }) => {
    const result = getClubStatistics(data.clubId);
    socket.emit('clubStatistics', result);
  });

  // ─── Club Activity Feed ───

  socket.on('getClubActivity', (data: { clubId: number; limit?: number }) => {
    const result = getActivityFeed(data.clubId, data.limit || 20);
    socket.emit('clubActivity', result);
  });

  // ========== Club Tournaments ==========

  socket.on('createClubTournament', (data: { clubId: number; config: any }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = createClubTournament(auth.userId, data.clubId, data.config);
    if (result.success) {
      socket.emit('clubTournamentCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubTournaments', (data: { clubId: number }) => {
    const result = getClubTournaments(data.clubId);
    socket.emit('clubTournaments', result);
  });

  socket.on('registerClubTournament', (data: { tournamentId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = registerForClubTournament(data.tournamentId, auth.userId);
    if (result.success) {
      socket.emit('clubTournamentRegistered', { tournamentId: data.tournamentId, registered: result.registered });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('startClubTournament', (data: { tournamentId: number }) => {
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

  socket.on('createClubChallenge', (data: { clubId: number; challengedId: number; stakes: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = createChallenge(data.clubId, auth.userId, data.challengedId, data.stakes);
    if (result.success) {
      socket.emit('clubChallengeCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('acceptClubChallenge', (data: { challengeId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = acceptChallenge(data.challengeId, auth.userId);
    if (result.success) {
      socket.emit('clubChallengeAccepted', { challengeId: data.challengeId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('declineClubChallenge', (data: { challengeId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = declineChallenge(data.challengeId, auth.userId);
    if (result.success) {
      socket.emit('clubChallengeDeclined', { challengeId: data.challengeId });
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getClubChallenges', (data: { clubId: number }) => {
    const result = getClubChallenges(data.clubId);
    socket.emit('clubChallenges', result);
  });

  // ========== Table Scheduling ==========

  socket.on('scheduleClubTable', (data: { clubId: number; config: any; scheduledTime: string; recurring: boolean; recurrencePattern?: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = scheduleTable(data.clubId, auth.userId, data.config, data.scheduledTime, data.recurring, data.recurrencePattern);
    if (result.success) {
      socket.emit('clubTableScheduled', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getScheduledClubTables', (data: { clubId: number }) => {
    const result = getScheduledTables(data.clubId);
    socket.emit('scheduledClubTables', result);
  });

  socket.on('activateScheduledClubTable', (data: { id: number; clubId: number }) => {
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

  socket.on('deleteScheduledClubTable', (data: { id: number }) => {
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

  socket.on('createBlindStructure', (data: { clubId: number; name: string; levels: any[] }) => {
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

  socket.on('getBlindStructures', (data: { clubId: number }) => {
    const result = getBlindStructures(data.clubId);
    socket.emit('blindStructures', result);
  });

  socket.on('deleteBlindStructure', (data: { id: number }) => {
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

  socket.on('inviteToClub', (data: { clubId: number; invitedUsername: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = inviteToClub(data.clubId, auth.userId, auth.username || '', data.invitedUsername);
    if (result.success) {
      socket.emit('invitationSent', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getMyInvitations', () => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('myInvitations', { success: false, invitations: [] }); return; }
    const result = getMyInvitations(auth.userId);
    socket.emit('myInvitations', result);
  });

  socket.on('acceptInvitation', (data: { invitationId: number }) => {
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

  socket.on('declineInvitation', (data: { invitationId: number }) => {
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

  socket.on('createUnion', (data: { clubId: number; name: string; description: string }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = createUnion(data.clubId, auth.userId, data.name, data.description);
    if (result.success) {
      socket.emit('unionCreated', result);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('getUnionInfo', (data: { clubId: number }) => {
    const result = getUnionInfo(data.clubId);
    socket.emit('unionInfo', result);
  });

  // ── Feature 12: Member Profiles ──

  socket.on('getMemberProfile', (data: { clubId: number; userId: number }) => {
    const result = getMemberProfile(data.clubId, data.userId);
    socket.emit('memberProfile', result);
  });

  // ── Feature 13: Club Badges ──

  socket.on('updateClubBadge', (data: { clubId: number; badge: string }) => {
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

  socket.on('generateReferralCode', (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = generateReferralCode(data.clubId, auth.userId);
    socket.emit('referralCode', result);
  });

  socket.on('joinByReferral', (data: { referralCode: string }) => {
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

  socket.on('getReferralStats', (data: { clubId: number }) => {
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Not authenticated' }); return; }
    const result = getReferralStats(data.clubId, auth.userId);
    socket.emit('referralStats', result);
  });

  // ── Feature 15: Club Levels ──

  socket.on('getClubLevel', (data: { clubId: number }) => {
    const result = getClubLevel(data.clubId);
    socket.emit('clubLevel', result);
  });

  // ── Feature 16: Featured Clubs ──

  socket.on('getFeaturedClubs', () => {
    const featured = getFeaturedClubs();
    const clubOfWeek = getClubOfWeek();
    socket.emit('featuredClubs', { ...featured, clubOfWeek: clubOfWeek.club || null });
  });

  // ========== End Club Events ==========

  socket.on('getTableList', () => {
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
    }) => {
      let { tableId, playerName, seatIndex, buyIn } = data;
      const table = tableManager.getTable(tableId);

      if (!table) {
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      // If player already has a session, leave old table first
      const existingSession = playerSessions.get(socket.id);
      if (existingSession) {
        handlePlayerLeave(socket);
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
      if (authForJoin && isUserBanned(authForJoin.userId)) {
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

      // Validate buy-in against DB balance for authenticated users
      if (authForJoin) {
        const dbChips = getUserChips(authForJoin.userId);
        if (buyIn > dbChips) {
          socket.emit('error', { message: 'Insufficient chips' });
          return;
        }
        if (!deductChips(authForJoin.userId, buyIn)) {
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

      // Initialize progression
      progressionManager.getOrCreateProgress(playerId, playerName);
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
    }
  );

  socket.on(
    'quickPlay',
    (data: { playerName: string; avatar?: string }) => {
      const { playerName } = data;

      // If the player already has a session on a table, leave it first
      const existingSession = playerSessions.get(socket.id);
      if (existingSession) {
        handlePlayerLeave(socket);
      }

      const tables = tableManager.getTableList();

      // Quick Play prefers Texas Hold'em tables. Sort: holdem first,
      // then by player count, then by smallest blinds.
      const isHoldem = (t: any) => {
        const tbl = tableManager.getTable(t.tableId);
        const id = (tbl as any)?.variantId || '';
        return !id || id === 'texas-holdem';
      };
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

      const bestTable = sorted[0];
      const table = tableManager.getTable(bestTable.tableId);
      if (!table) {
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      // Find an empty seat or an AI seat
      let targetSeat = -1;
      for (let i = 0; i < MAX_SEATS; i++) {
        if (table.seats[i].state === 'empty') {
          targetSeat = i;
          break;
        }
      }
      if (targetSeat === -1) {
        // Try to take an AI seat
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

      const playerId = `player-${uuidv4()}`;
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
        avatar: data.avatar || undefined,
      };
      playerSessions.set(socket.id, session);
      socket.join(`table:${bestTable.tableId}`);

      // Initialize progression
      progressionManager.getOrCreateProgress(playerId, playerName);
      ensureTableProgressListener(table, bestTable.tableId);

      // Fill with AI
      fillWithAI(table, bestTable.tableId);

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
      broadcastGameState(bestTable.tableId);
      sendProgressToPlayer(socket.id);

      // Schedule AI if it's an AI's turn
      scheduleAIAction(bestTable.tableId);
    }
  );

  socket.on('startHand', () => {
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

    // Track missed blinds for sitting-out players (#16)
    const sitOuts = sitOutTracker.get(session.tableId);
    if (sitOuts && sitOuts.size > 0) {
      if (!missedBlinds.has(session.tableId)) {
        missedBlinds.set(session.tableId, new Map());
      }
      const tableMissed = missedBlinds.get(session.tableId)!;
      const bb = table.config.bigBlind || 50;
      for (const seatIdx of sitOuts) {
        const current = tableMissed.get(seatIdx) || 0;
        tableMissed.set(seatIdx, current + bb);
      }
    }

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
  socket.on('playerDraw', (data: { discardIndices: number[] }) => {
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
  socket.on('chatMessage', (data: { message: string }) => {
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

  socket.on('getProgress', () => {
    sendProgressToPlayer(socket.id);
  });

  socket.on('claimMission', (data: { missionId: string }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const result = progressionManager.claimMissionReward(session.playerId, data.missionId);
    if (result.success) {
      socket.emit('missionClaimed', { missionId: data.missionId, reward: result.reward });
    }
    sendProgressToPlayer(socket.id);
  });

  socket.on('claimDailyBonus', () => {
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

  socket.on('getDailyMissions', () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const missions = progressionManager.getDailyMissions(session.playerId);
    socket.emit('dailyMissions', missions);
    sendProgressToPlayer(socket.id);
  });

  // ========== Sit Out ==========

  socket.on('sitOut', () => {
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
    } else {
      // Returning from sit-out: check if they have missed blinds
      const tableMissed = missedBlinds.get(session.tableId);
      if (tableMissed && tableMissed.has(session.seatIndex)) {
        const amount = tableMissed.get(session.seatIndex)!;
        socket.emit('missedBlinds', { amount });
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
  socket.on('playerAFK', () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    session.sittingOut = true;
    if (!sitOutTracker.has(session.tableId)) sitOutTracker.set(session.tableId, new Set());
    sitOutTracker.get(session.tableId)!.add(session.seatIndex);

    socket.emit('sitOutToggled', { sittingOut: true, reason: 'afk' });

    // Auto-fold if it's currently their turn
    const table = tableManager.getTable(session.tableId);
    if (table && table.activeSeatIndex === session.seatIndex) {
      table.playerFold(session.seatIndex);
      broadcastGameState(session.tableId);
    }
  });

  socket.on('playerBack', () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    session.sittingOut = false;
    const tracker = sitOutTracker.get(session.tableId);
    if (tracker) tracker.delete(session.seatIndex);

    socket.emit('sitOutToggled', { sittingOut: false, reason: 'back' });
  });

  // ========== Fast Mode (#12) ==========
  socket.on('setFastMode', (data: { enabled: boolean }) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    // Only authenticated (registered) players can change fast mode
    const auth = authSessions.get(socket.id);
    if (!auth) { socket.emit('error', { message: 'Must be logged in to change fast mode' }); return; }
    fastModeTables.set(session.tableId, data.enabled);
    socket.emit('fastModeSet', { enabled: data.enabled });
  });

  // ========== Post Missed Blinds (#16) ==========
  socket.on('postMissedBlinds', () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    const tableMissed = missedBlinds.get(session.tableId);
    if (!tableMissed || !tableMissed.has(session.seatIndex)) return;

    const amount = tableMissed.get(session.seatIndex)!;
    const table = tableManager.getTable(session.tableId);
    if (!table) return;

    const seat = table.seats[session.seatIndex];
    if (seat && seat.chipCount >= amount) {
      seat.chipCount -= amount;
      // Add missed blinds to the pot as dead money
      seat.currentBet += amount;
      seat.totalInvestedThisHand += amount;
      tableMissed.delete(session.seatIndex);
      socket.emit('missedBlindsPosted', { amount });
      broadcastGameState(session.tableId);
    }
  });

  // ========== Show Mucked Hand ==========
  socket.on('showMuckedHand', (data: { cards: any[] }) => {
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

  socket.on('toggleTraining', () => {
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
  socket.on('triggerBombPot', (data: { tableId?: string }) => {
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
  socket.on('enableDealersChoice', (data: { tableId?: string; enabled: boolean }) => {
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
  socket.on('quickHeadsUp', (data: { playerName: string }) => {
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

    progressionManager.getOrCreateProgress(playerId, playerName);
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
  socket.on('quickSpinGo', (data: { playerName: string }) => {
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

    progressionManager.getOrCreateProgress(playerId, playerName);
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
  socket.on('quickAllInOrFold', (data: { playerName: string }) => {
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

    progressionManager.getOrCreateProgress(playerId, playerName);
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

  socket.on('startCareerGame', (data: { venue: number; stage: number }) => {
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

    progressionManager.getOrCreateProgress(playerId, careerPlayerName);
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

  socket.on('emote', (data: { emoteId: string }) => {
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

  socket.on('tableReaction', (data: { reactionId: string }) => {
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

  socket.on('spectate', (data: { tableId: string }) => {
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

  socket.on('stopSpectating', () => {
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
    lastSentState.delete(socket.id);
  });

  // ========== Theme Shop ==========

  socket.on('purchaseTheme', (data: { themeId: string }) => {
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

  socket.on('purchaseBattlePass', (_data: unknown, callback?: (ack: { success: boolean; error?: string }) => void) => {
    const auth = authSessions.get(socket.id);
    const session = playerSessions.get(socket.id);
    const respond = (ack: { success: boolean; error?: string }) => { if (typeof callback === 'function') callback(ack); };
    if (!auth) { respond({ success: false, error: 'Not authenticated' }); return; }
    const playerId = session?.playerId;
    if (!playerId) { respond({ success: false, error: 'Not in a session' }); return; }
    const BATTLE_PASS_COST = 950;
    const result = progressionManager.purchaseTheme(playerId, '__battlepass_premium__', BATTLE_PASS_COST);
    if (!result.success) { respond({ success: false, error: result.error }); return; }
    mergeUserStats(auth.userId, { battlePassPremium: true });
    sendProgressToPlayer(socket.id);
    respond({ success: true });
  });

  socket.on('equipTheme', (data: { themeId: string }) => {
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

  socket.on('getDetailedStats', () => {
    const session = playerSessions.get(socket.id);
    if (!session) return;

    const stats = progressionManager.getDetailedStats(session.playerId);
    socket.emit('detailedStats', stats);
  });

  // ========== Tournament System ==========

  socket.on('getTournaments', () => {
    socket.emit('tournamentList', tournamentManager.getTournamentList());
  });

  socket.on('registerTournament', (data: { tournamentId: string; playerName: string }) => {
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
  socket.on('startSimulatedTournament', (data: { playerCount?: number; turbo?: boolean }) => {
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
  socket.on('setTournamentSpeed', (data: { tournamentId: string; turbo: boolean }) => {
    const tournament = tournamentManager.getTournament(data.tournamentId);
    if (!tournament) return;
    tournament.turboMode = data.turbo;
    for (const tid of tournament.tableIds) {
      fastModeTables.set(tid, data.turbo);
    }
  });

  // ========== Multi-Table Support ==========

  socket.on('joinAdditionalTable', (data: { tableId: string; playerName: string; buyIn: number; avatar?: string }) => {
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

    progressionManager.getOrCreateProgress(playerId, playerName);
    ensureTableProgressListener(table, tableId);
    fillWithAI(table, tableId);

    socket.emit('additionalTableJoined', {
      tableId,
      seatIndex: targetSeat,
      gameState: getGameStateForPlayer(table, targetSeat),
    });

    broadcastGameState(tableId);
  });

  socket.on('leaveAdditionalTable', (data: { tableId: string }) => {
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

  socket.on('switchTable', (data: { tableId: string }) => {
    // Client-side only - just acknowledge
    socket.emit('tableSwitched', { tableId: data.tableId });
  });

  socket.on('leaveTable', () => {
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

  socket.on('joinByInviteCode', (data: { inviteCode: string; playerName: string; buyIn: number; avatar?: any }) => {
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

    const playerId = `player-${uuidv4()}`;
    const actualBuyIn = Math.max(table.config.minBuyIn, buyIn || table.config.minBuyIn);
    table.sitDown(openSeat, playerName, actualBuyIn, playerId, false);

    const session: PlayerSession = {
      socketId: socket.id, tableId, seatIndex: openSeat, playerName, playerId,
      trainingEnabled: false, sittingOut: false, avatar: avatar || undefined,
    };
    playerSessions.set(socket.id, session);
    socket.join(`table:${tableId}`);
    progressionManager.getOrCreateProgress(playerId, playerName);
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
  socket.on('coachWhisper', (data: { targetSocketId: string; message: string; coachName?: string }) => {
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

  socket.on('marketBet', (data: { marketId: string; handId: string; outcome: string; amount: number }) => {
    if (!data.marketId || !data.handId || !data.outcome || typeof data.amount !== 'number' || data.amount <= 0) return;
    const key = `${data.marketId}:${data.handId}`;
    const existing = predictionBets.get(key) || [];
    existing.push({ socketId: socket.id, outcome: data.outcome, amount: data.amount });
    predictionBets.set(key, existing);
  });

  socket.on('marketResolve', (data: { marketId: string; handId: string; winningOutcome: string }) => {
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

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    const authSession = authSessions.get(socket.id);
    const session = playerSessions.get(socket.id);

    // Auto-save progress on disconnect
    if (authSession && session) {
      const table = tableManager.getTable(session.tableId);
      if (table) {
        const seat = table.seats[session.seatIndex];
        if (seat && seat.state === 'occupied') {
          saveProgress(authSession.userId, { chips: seat.chipCount });

          // Reserve the seat for 10 minutes so the player can reconnect
          // Cancel any existing reservation for this user first
          const existing = reservedSeats.get(authSession.userId);
          if (existing) clearTimeout(existing.cleanupTimer);

          const cleanupTimer = setTimeout(() => {
            const reserved = reservedSeats.get(authSession.userId);
            if (reserved) {
              const t = tableManager.getTable(reserved.tableId);
              if (t) t.standUp(reserved.seatIndex);
              reservedSeats.delete(authSession.userId);
              console.log(`[Reserve] Seat reservation expired for user ${authSession.userId}`);
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
          });

          // Mark player as sitting out while disconnected (auto-folds their turn)
          session.sittingOut = true;
          if (!sitOutTracker.has(session.tableId)) sitOutTracker.set(session.tableId, new Set());
          sitOutTracker.get(session.tableId)!.add(session.seatIndex);

          // Auto-fold if it's their turn right now
          if (table.isHandInProgress() && table.activeSeatIndex === session.seatIndex) {
            table.playerFold(session.seatIndex);
            broadcastGameState(session.tableId);
          }

          console.log(`[Reserve] Seat ${session.seatIndex} on table ${session.tableId} reserved for user ${authSession.userId} (${session.playerName})`);

          // Don't call handlePlayerLeave — seat stays reserved
          playerSessions.delete(socket.id);
          authSessions.delete(socket.id);
          lastSentState.delete(socket.id);
          return;
        }
      }
    }

    if (authSession) authSessions.delete(socket.id);
    handlePlayerLeave(socket);
    // Clear delta tracking so a reconnect gets a fresh full state
    lastSentState.delete(socket.id);
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
          // Human player — update their session
          const tp = tournament.players.find(p => p.playerId === player.playerId);
          if (tp) {
            const session = playerSessions.get(tp.socketId);
            if (session) {
              session.tableId = targetTid;
              session.seatIndex = emptySeat;
            }
            const sock = io.sockets.sockets.get(tp.socketId);
            if (sock) {
              sock.leave(`table:${breakTableId}`);
              sock.join(`table:${targetTid}`);
              sock.emit('playerMoved', {
                fromTable: breakTableId,
                toTable: targetTid,
                toSeat: emptySeat,
                tableId: targetTid,
              });
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
}

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
initDB();
initClubTables();

// ========== Start Server ==========

httpServer.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
  console.log(`Tables available: ${tableManager.getTableList().length}`);
  for (const table of tableManager.getTableList()) {
    console.log(
      `  - ${table.tableName} (${table.smallBlind}/${table.bigBlind} blinds, min buy-in: ${table.minBuyIn})`
    );
  }
});

/**
 * 2026-11-02 — .online TOURNAMENT BROADCAST: the shared wire contract, v1.
 *
 * THE single source of names and shapes for every repo (lead architect spec §3,
 * merged from the server / client / ops lanes, with the owner's decisions of
 * 2026-11-02 applied — they override the spec where they differ):
 *   - poker-server (this repo): the /broadcast namespace, the program data,
 *     the REST routes, the default-namespace additions;
 *   - poker-3d: broadcast.html (the OBS / worker page) and the producer panel;
 *   - the master API: the Broadcasts page and the worker routes (§3 "master API").
 * A breaking change bumps BROADCAST_CONTRACT_VERSION; the page shows its slate on
 * an unknown major version. Recorded frames (tests/fixtures/broadcast/*.json)
 * are validated against these shapes.
 *
 * HARD RULES this contract carries:
 *   - A hole-card leak on any public path is a P0. The PUBLIC feed builder never
 *     reads seat.holeCards; public program data carries NO cards at all (no hole
 *     cards, no board): cards appear only in a featured-table frame, and there
 *     only under the contested-showdown gate (index.ts getGameStateForPlayer).
 *   - Owner 2026-11-02: hole cards appear ONLY on a DELAYED feed whose delay is
 *     at least HOLECARD_MIN_DELAY_MS (5 minutes; the default; configurable
 *     upward), on the featured table (a producer may pin one), with the producer
 *     switch on AND an allowlisted issuer (default allowlist: the owner only).
 *     A hand's hole cards are NEVER released to any feed while that hand is still
 *     being played live: only when (a) the hand has ended live (handResult / hand
 *     complete) AND (b) at least the delay has passed since the frame shown. A
 *     delayed frame of a hand still live shows card backs (hasCards, no faces)
 *     until it ends live. The policy ships 'off' (built dark).
 *   - No playerId, masterUserId, userId, publicId, seed, deck or burn data in
 *     any payload. Entrants are keyed by `pid` (broadcastNames.broadcastPid).
 *   - Names are applied on the server at emit time (broadcastNames.broadcastNameOf:
 *     'First L.', the name cut into words at every separator, digit and CamelCase
 *     boundary so no surname goes on air ('JohnSmith' -> 'John S.', 'Mary22Jones'
 *     -> 'Mary J.'), a one-word alias as is, 'Player' when opted out or unknown).
 *   - Play money only. The legal line says so on every frame.
 *
 * Types are erased at build; the runtime constants below are what other modules
 * (and the canonical-features lock) read.
 */

export const BROADCAST_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------- transport

/** The Socket.IO namespace on poker-server (same host, same /socket.io path). */
export const BROADCAST_NAMESPACE = '/broadcast';

/** Event names on /broadcast (client <-> server). */
export const BC_EVENTS = {
  subscribe: 'bc:subscribe',
  resync: 'bc:resync',
  unsubscribe: 'bc:unsubscribe',
  snapshot: 'bc:snapshot',
  frame: 'bc:frame',
  heartbeat: 'bc:heartbeat',
  command: 'bc:command',
  sessionReplaced: 'bc:sessionReplaced',
  authExpired: 'bc:authExpired',
} as const;

export const BROADCAST_CHANNELS = ['main', 'weekly', 'monthly', 'sitgo'] as const;
export type ChannelId = typeof BROADCAST_CHANNELS[number];

/** One bc:heartbeat per subscribed stream every this many ms (R9). */
export const BROADCAST_HEARTBEAT_MS = 2000;
/** Program frames: on change, at most this often (R10). */
export const BROADCAST_PROGRAM_MIN_INTERVAL_MS = 1000;
/** Ticker: newest last, at most this many. */
export const BROADCAST_TICKER_MAX = 30;
/** Standings leaders: the top N. */
export const BROADCAST_LEADERS_MAX = 10;

/** The legal line on every program frame (play money only). ASCII-escaped middle dots. */
export const BROADCAST_LEGAL_LINE = 'Free to play · Play money only · No purchase necessary · 21+ to enter.';

/**
 * Owner 2026-11-02: hole cards only on a delayed feed; the MINIMUM and the
 * DEFAULT delay is 5 minutes (the spec's 15/30/45 is replaced); a producer may
 * set it higher. User-facing text that names the delay reads the configured
 * value (or says 5 minutes).
 */
export const HOLECARD_MIN_DELAY_MS = 5 * 60_000;
export const HOLECARD_DEFAULT_DELAY_MS = HOLECARD_MIN_DELAY_MS;
export type HoleCardPolicy = 'off' | 'after_event' | 'delayed';
/** Ships OFF (built dark): the owner turns it on after a security review. */
export const HOLECARD_POLICY_DEFAULT: HoleCardPolicy = 'off';

// ---------------------------------------------------------------- delayed hole cards (P5)

/**
 * 2026-11-02 (P5-S5, owner 2026-11-02) — THE DELAYED HOLE-CARD FEED's knobs
 * (src/broadcast/holeCardDelay.ts + delayedFeed.ts). Env, read once at boot:
 *   BROADCAST_HOLECARD_POLICY    'off' (DEFAULT: built dark) | 'delayed' | 'after_event'
 *   BROADCAST_HOLECARD_DELAY_MIN default 5; floor 5 (no API can lower it); at most 240
 *   BROADCAST_HOLECARD_ISSUERS   master user ids, comma-separated, who may mint a
 *                                'delayed' key and switch hole cards on. Empty /
 *                                unset = NOBODY. Intended value: the owner only.
 *   BROADCAST_HOLECARD_TABLES    'featured' (DEFAULT, owner: the featured table; a
 *                                producer may pin one) | 'final_table'
 *   BROADCAST_HOLECARD_SHOW      'all' (DEFAULT, every dealt hand) | 'vpip'
 * Turning cards ON also needs the producer switch (bc:producer:holeCardsSwitch
 * {on:true}) from a key whose issuer is allowlisted; the switch starts OFF at
 * every boot. Off: the switch, or POST /api/broadcast/holecards {on:0}.
 */
export const HOLECARD_POLICY_ENV = 'BROADCAST_HOLECARD_POLICY';
export const HOLECARD_MAX_DELAY_MS = 240 * 60_000;
/** Kept past the longest delay in use (then purged): frames, hand records. */
export const HOLECARD_RETAIN_EXTRA_MS = 5 * 60_000;
/** Delayed sessions are released (and re-validated) on this tick. */
export const HOLECARD_RELEASE_TICK_MS = 250;
/** At most this many delayed sessions per event; one live session per key (jti). */
export const DELAYED_SESSIONS_PER_EVENT_MAX = 4;
/** Buffer caps (the oldest are dropped first, counted droppedAtCap). */
export const HOLECARD_HANDS_PER_TABLE_MAX = 300;
export const HOLECARD_EVENT_BYTES_MAX = 32 * 1024 * 1024;
/** Log tag of every buffer purge / wipe (counts only: never a card, never an id). */
export const HOLECARD_PURGED_TAG = 'holecard_delay_purged';
/** Durable audit of every hole-card switch change (producer or REST). */
export const HOLECARD_SWITCH_AUDIT = 'BROADCAST_HOLECARDS_SET';

// ---------------------------------------------------------------- handshake

/**
 * io(SERVER_URL + '/broadcast', { auth: { key?: string }, transports: ['websocket','polling'],
 *    reconnectionAttempts: Infinity, reconnectionDelayMax: 5000 })
 * Public output needs NO key. A refusal is a connect_error whose `data.code` is
 * one of these (wire.ts's handshake guard is typed to this list: it can send no other).
 *   'registry_loading'   (2026-11-02 fix round 2; was 'starting') a key presented
 *                        while the persisted key list is still loading after a
 *                        restart, past BCAST_KEY_LIST_WAIT_MS: RETRYABLE, the page
 *                        keeps its key and reconnects with it.
 *   'origin_not_allowed' (review round 1) a KEYLESS browser handshake from an
 *                        Origin outside BCAST_ALLOWED_ORIGINS.
 */
export const HANDSHAKE_REFUSAL_CODES = [
  'bad_token', 'expired', 'not_yet_valid', 'revoked', 'registry_loading', 'secret_unset', 'rate_limited',
  'too_many_connections', 'banned', 'feed_off', 'origin_not_allowed',
] as const;
export type HandshakeRefusalCode = typeof HANDSHAKE_REFUSAL_CODES[number];

// ---------------------------------------------------------------- ids

/** 'q:<masterQualifierId>' | 't:<tournamentId>' | 'next:weekly' | 'next:monthly' */
export type EventKey = string;
export type Card = { rank: number; suit: 0 | 1 | 2 | 3 };

// ---------------------------------------------------------------- client -> server

export interface SubscribeRequest {
  v: 1;
  channel?: ChannelId;
  event?: EventKey;
  layout: '16x9' | '9x16';
  role?: 'viewer' | 'output';
  follow?: 'program' | 'none' | { tableId: string };
  lastSeq?: number;
}
export const SUBSCRIBE_REFUSAL_CODES = [
  'channel_unknown', 'event_not_found', 'not_broadcastable', 'rate_limited', 'wrong_event', 'entrant',
  'holecards_off', 'too_many_sessions', 'version_unsupported',
] as const;
export type SubscribeRefusalCode = typeof SUBSCRIBE_REFUSAL_CODES[number];
/**
 * Ack of bc:subscribe. A CHANNEL subscription whose channel has no event bound
 * right now acks {ok:false, code:'event_not_found', parked:true} and STAYS on the
 * channel: the server sends bc:snapshot as soon as the channel resolves to an
 * event (a fixed OBS URL such as ?ch=weekly works week after week).
 */
export type SubscribeAck =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; code: SubscribeRefusalCode; parked?: boolean };

// ---------------------------------------------------------------- server -> client

export interface Feed {
  mode: 'public' | 'delayed';
  delayMs: number;
  /** true only when mode==='delayed', delayMs >= HOLECARD_MIN_DELAY_MS and the session holds the 'delayed' scope. */
  holeCards: boolean;
  policy: HoleCardPolicy;
}
/**
 * 2026-11-02 (P5) — a DELAYED session (a key with the 'delayed' scope, policy on,
 * the producer switch on) gets the same bc:snapshot / bc:frame / bc:heartbeat as
 * every page, but from the delay buffer and by direct socket.emit (never a room):
 * feed {mode:'delayed', delayMs, holeCards:true, policy}; program.programNow and
 * every frame's `at` / `t` are the ORIGINAL server times (now - delayMs); the
 * heartbeat's programNow = serverNow - delayMs. Until the buffer holds anything
 * that old, bc:subscribe acks {ok:false, code:'event_not_found', parked:true} and
 * bc:snapshot follows once it does.
 */

export interface Snapshot {
  v: 1;
  seq: number;
  serverNow: number;
  feed: Feed;
  program: ProgramState;
  table: BroadcastTableFrame | null;
  tables?: TableSummary[];
}

export type Frame =
  | { v: 1; seq: number; at: number; kind: 'program'; program: ProgramState }
  | { v: 1; seq: number; at: number; kind: 'table'; table: BroadcastTableFrame }
  | { v: 1; seq: number; at: number; kind: 'event'; event: TickerEvent };

export interface Heartbeat { seq: number; serverNow: number; programNow: number; delayMs: number; onAir: boolean }
export interface Command { cmd: 'reload' | 'identify'; id: string }

export type EventStatus = 'scheduled' | 'registering' | 'tables_open' | 'running' | 'finished' | 'cancelled';
export type SceneId = 'starting' | 'table' | 'break' | 'hfh' | 'finalIntro' | 'results' | 'slate' | 'recap' | 'room';

export interface ProgramEvent {
  kind: 'weekly' | 'monthly' | 'sitgo';
  qualifierId: string | null;
  tournamentId: string | null;
  name: string;
  title: string | null;
  status: EventStatus;
  /** epoch ms (server clock) */
  scheduledAt: number;
  dealsAt: number | null;
  registered: number;
  entries: number;
  startingStack: number;
  levels: { sb: number; bb: number; ante: number; minutes: number }[];
  howToEnter: string | null;
  prizes: {
    kind: 'seats' | 'chips';
    seatsForTop: number | null;
    seatPackage: Record<string, number> | null;
    paidPlaces: number | null;
    rows: { place: number; seats?: number; amount?: number }[];
    bubblePlace: number | null;
    onBubble: boolean;
  };
  lateReg: { open: boolean | null; until: number | null; closedReason: 'seat_bubble' | 'time' | null };
}

export interface ProgramState {
  v: 1;
  channel: ChannelId | null;
  eventKey: EventKey;
  onAir: boolean;
  rehearsal: boolean;
  programNow: number;
  event: ProgramEvent;
  scene: { id: SceneId; auto: boolean; since: number; params?: Record<string, unknown> };
  featured: {
    tableId: string | null; tableNo: number | null; tableName: string | null;
    mode: 'auto' | 'producer' | 'final_table';
    reason: 'all_in' | 'big_pot' | 'chip_leader' | 'bubble' | 'final_table' | 'producer' | 'table_broken' | null;
    since: number;
  };
  /** The tournamentClock object exactly as index.ts tournamentClockStateFor builds it, or null. */
  clock: Record<string, unknown> | null;
  standings: {
    playersLeft: number; entries: number; avgStack: number | null; avgStackBb: number | null; paidPlaces: number | null; tables: number;
    leaders: { pid: string; name: string; chips: number; bb: number | null; tableNo: number | null; rank: number; prevRank: number | null }[];
  };
  ticker: TickerEvent[];
  handForHand: { on: boolean; round: number | null; tables: { tableId: string; tableNo: number | null; state: 'waiting' | 'playing' | 'done' }[] } | null;
  lowerThirds: { id: string; kind: 'host' | 'info' | 'player' | 'legal' | 'venue'; title: string; sub?: string; until: number | null }[];
  legal: { line: string; platformLine: string | null };
  /** Only once programNow >= the finish time. */
  results: { place: number; pid: string; name: string; seatsWon?: number; amount?: number; tied?: boolean }[] | null;
  finalTable: { seats: { seatIndex: number; pid: string; name: string; chips: number }[] } | null;
}

export const TICKER_KINDS = [
  'bust', 'doubleUp', 'levelUp', 'breakStart', 'breakEnd', 'hfhOn', 'hfhOff', 'lateRegClosed',
  'tableBroken', 'finalTable', 'featured', 'finished',
] as const;
export type TickerKind = typeof TICKER_KINDS[number];
/** A seat-winning bust is 'bust' with seatsWon > 0 (no separate kind). */
export interface TickerEvent {
  id: string; t: number; kind: TickerKind;
  pid?: string; name?: string; place?: number; of?: number; byName?: string; tableNo?: number; handNumber?: number;
  level?: number; seatsWon?: number; amount?: number; tied?: boolean; handForHand?: boolean;
}

export interface BroadcastTableFrame {
  t: number; tableId: string; tableNo: number | null; tableName: string; maxSeats: number; featured: boolean;
  handNumber: number; phase: string; handLevel: { sb: number; bb: number; ante: number };
  dealerSeat: number; smallBlindSeat: number; bigBlindSeat: number; activeSeat: number;
  turnStartedAt: number | null; turnTimeout: number | null;
  pot: number; pots?: { amount: number; eligibleSeats: number[] }[]; board: Card[];
  lastAction?: { seatIndex: number; text: string; amount?: number };
  seats: {
    seatIndex: number; pid: string; name: string; chips: number; bet: number; folded: boolean; allIn: boolean;
    sittingOut: boolean; eliminated: boolean; hasCards: boolean;
    /** Public feed: non-null ONLY for a seat that reached a contested showdown and did not muck. */
    holeCards: Card[] | null; mucked?: boolean; handName?: string | null;
  }[];
  handResult: { winners: { seatIndex: number; name: string; amount: number; handName?: string }[]; showdownSeats: number[]; muckedSeats: number[] } | null;
  /**
   * 2026-11-02 (P2-S3; the poker-3d mirror's one addition to §3, owner HARD RULE):
   * server ms when THIS frame's hand ended LIVE (its handResult), null while the
   * hand is still being played. The delayed HoleCam shows faces only once it is set
   * and in the past; the public feed never needs it to hide anything.
   */
  liveHandEndedAt?: number | null;
  /**
   * 2026-11-02 (P5; the poker-3d mirror's second addition, its holeCardGate rule c):
   * server ms when the delay buffer released THIS frame's hand's hole cards to
   * this delayed session. Only on a DELAYED frame that carries them, and never
   * before max(liveHandEndedAt, t + delayMs); null on a delayed frame without
   * them. A public frame never carries the field.
   */
  holeCardsReleasedAt?: number | null;
}

export interface TableSummary {
  tableId: string; tableNo: number | null; tableName: string; players: number; handNumber: number; pot: number;
  allIn: boolean; biggestStack: number; chipLeaderHere: boolean;
}

/** GET /api/broadcast/events rows. */
export interface EventSummary {
  eventKey: EventKey; name: string; kind: 'weekly' | 'monthly' | 'sitgo'; scheduledAt: number; phase: EventStatus;
  playersLeft: number; registered: number;
}

// ---------------------------------------------------------------- default namespace (signed in)

/**
 * 'setBroadcastOptOut' {optOut:boolean} / 'getBroadcastOptOut' {} →
 * 'broadcastOptOutResult'. The signed-in profile carries the value as
 * loginResult.userData.stats.broadcastOptOut (absent = false).
 * Codes: login_required, save_failed (also: a non-boolean optOut), rate_limited
 * (more than 10 changes a minute), load_failed (get: the row could not be read).
 */
export type BroadcastOptOutResult = { ok: true; optOut: boolean } | { ok: false; code: 'login_required' | 'save_failed' | 'rate_limited' | 'load_failed' };
/** 'adminSetBroadcastOptOut' {userId? | masterUserId?, optOut} → 'adminBroadcastOptOutResult' (isUserAdmin; audited BROADCAST_OPT_OUT_SET). */
export type AdminBroadcastOptOutResult =
  | { ok: true; userId: number; masterUserId: string | null; optOut: boolean }
  | { ok: false; code: 'login_required' | 'not_admin' | 'invalid_request' | 'user_not_found' | 'save_failed' | 'load_failed' };
/** Voice chat at qualifier tables (P1-S6): 'voiceRefused', 'voiceForcedOff'; gameState.voiceChatAllowed always present. */
export interface VoiceRefused { tableId: string; code: 'voice_off_qualifier'; message: 'Voice chat is off in qualifier tournaments.' }
export interface VoiceForcedOff { code: 'voice_off_qualifier'; tableId: string; message: string }

// ---------------------------------------------------------------- featured table + table frames (P2-S3)

/** Table frames: coalesced, at most this often per stream (R10: 5 Hz), featured / pinned table only. */
export const BROADCAST_TABLE_MIN_INTERVAL_MS = 200;
/** The featured-table recommender runs at most this often per program (2 Hz). */
export const FEATURED_EVAL_MIN_MS = 500;
/** Log tag of every featured-table change (also a canonical-features token). */
export const FEATURED_CHANGED_TAG = 'broadcast_featured_changed';
/** A producer lock on a featured table: 0..240 minutes (0 = until the producer releases it). */
export const FEATURE_LOCK_MAX_MINUTES = 240;

// ---------------------------------------------------------------- broadcast tokens (P2-S4)

/**
 * HS256-pinned, `typ: 'bcast+jwt'`, secret env BROADCAST_TOKEN_SECRET (32+
 * characters; else every token feature is off: `secret_unset`). Claims: jti, ev
 * ('ch:<channel>' | 'ch:*' (producer only) | 'q:<id>' | 't:<id>'; 'delayed' only
 * q: / t:), scp, iss_m, lbl, nbf, exp (<= nbf + 12 h). Postgres
 * broadcast_tokens keeps the jti + metadata, never the token string.
 */
export const BROADCAST_TOKEN_TYP = 'bcast+jwt';
export const BROADCAST_TOKEN_SCOPES = ['output', 'producer', 'delayed'] as const;
export type BroadcastScope = typeof BROADCAST_TOKEN_SCOPES[number];
export const BROADCAST_TOKEN_MAX_TTL_MS = 12 * 60 * 60 * 1000;

/** Default namespace, signed-in admin: 'broadcastIssueToken' {ev, scopes, label, ttlHours, notBefore?} → 'broadcastTokenIssued' (and the ack). */
export interface BroadcastIssueTokenRequest { ev: string; scopes: BroadcastScope[]; label: string; ttlHours?: number; notBefore?: number }
export type BroadcastTokenIssued =
  | { ok: true; token: string; jti: string; scopes: BroadcastScope[]; nbf: number; exp: number }
  | { ok: false; code: 'login_required' | 'not_admin' | 'issuer_is_entrant' | 'issuer_not_allowlisted' | 'holecards_off' | 'secret_unset' | 'event_not_found' | 'invalid_request' | 'rate_limited' | 'save_failed' };
/** Registration refusal while the account holds a live broadcast key for that event (spec R4). */
export const BROADCAST_STAFF_CANNOT_ENTER = 'broadcast_staff_cannot_enter';

// ---------------------------------------------------------------- producer (P2-S9)

/** Producer events on /broadcast (need the 'producer' scope; every mutation is audited BROADCAST_PRODUCER_ACTION). */
export const PRODUCER_EVENTS = {
  hello: 'bc:producer:hello',
  watch: 'bc:producer:watch',
  state: 'bc:producer:state',
  setEvent: 'bc:producer:setEvent',
  setScene: 'bc:producer:setScene',
  setAuto: 'bc:producer:setAuto',
  feature: 'bc:producer:feature',
  lowerThird: 'bc:producer:lowerThird',
  setFeed: 'bc:producer:setFeed',
  onAir: 'bc:producer:onAir',
  command: 'bc:producer:command',
  mintKey: 'bc:producer:mintKey',
  revokeKey: 'bc:producer:revokeKey',
  listKeys: 'bc:producer:listKeys',
  // 2026-11-02 (P5) — the delayed hole-card feed: the table it shows / the switch.
  delayedPin: 'bc:producer:delayedPin',
  holeCardsSwitch: 'bc:producer:holeCardsSwitch',
} as const;
export const PRODUCER_REFUSAL_CODES = [
  'not_producer', 'producer_is_entrant', 'issuer_not_allowlisted', 'holecards_off', 'delay_below_minimum', 'event_not_found',
  'table_not_in_event', 'scene_not_allowed', 'event_not_finished', 'not_captured', 'secret_unset',
  // 2026-11-02 additions: a malformed call, a channel the key does not cover, a
  // producer key minting a producer key, a mutation loop, the binding's event key.
  'invalid_request', 'wrong_event', 'scope_not_allowed', 'rate_limited', 'not_broadcastable', 'channel_unknown',
] as const;
export type ProducerRefusalCode = typeof PRODUCER_REFUSAL_CODES[number];
export const BROADCAST_PRODUCER_AUDIT = 'BROADCAST_PRODUCER_ACTION';
/** A producer's on-air toggle auto-clears this long after it was set … */
export const ON_AIR_MAX_MS = 9 * 60 * 60 * 1000;
/** … or this long after the channel's event finished. */
export const ON_AIR_AFTER_FINISH_MS = 2 * 60 * 60 * 1000;
/** bc:producer:state at most this often per producer socket (twice a second). */
export const PRODUCER_PUSH_MIN_MS = 500;
export const LOWER_THIRDS_MAX = 6;

export type LowerThird = ProgramState['lowerThirds'][number];
export interface ChannelSummary {
  channel: ChannelId; onAir: boolean; eventKey: EventKey | null; eventName: string | null;
  subscribers: { '16x9': number; '9x16': number }; outputs: number;
}
/** bc:producer:state — `live` is ALWAYS public-feed data (no hole card ever reaches a producer). */
export interface ProducerState {
  program: Snapshot;
  live: { liveNow: number; tables: TableSummary[]; featuredLive: BroadcastTableFrame | null; bufferMs: number };
}
/** GET /api/broadcast/on-air */
export interface OnAirView {
  onAir: boolean;
  channels: { channel: ChannelId; onAir: boolean; since: number | null; eventKey: EventKey | null; source: 'producer' | 'output' | null }[];
}

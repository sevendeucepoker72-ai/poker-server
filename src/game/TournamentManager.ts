import { v4 as uuidv4 } from 'uuid';

export interface BlindLevel {
  sb: number;
  bb: number;
  ante: number;
  duration: number; // seconds
}

export interface TournamentConfig {
  tournamentId: string;
  name: string;
  buyIn: number;
  prizePool: number;
  maxPlayers: number;
  startInterval: number; // ms between auto-starts (0 = manual)
  blindLevels: BlindLevel[];
  isBounty?: boolean; // bounty tournament — earn chips for eliminating players
  bountyAmount?: number; // chips awarded per knockout
  startingChips?: number; // 2026-07-07 gap-fill [14] — custom starting stack (default 1000)
  /**
   * R2 (2026-10-11, P3) — an on-demand tournament starts at this many
   * registrants (clamped to 2..maxPlayers). Unset (every template): min(4, max)
   * as before. A custom tournament defaults to its maxPlayers (starts when
   * full) unless the director set one — it used to start at 4 whatever its max.
   */
  minPlayers?: number;
  /**
   * R2 (TOURNEY-14) — a CLUB tournament: listed only to its own entrants
   * (getTournamentList) and never open to registerTournament (its members are
   * entered by the club start, their buy-ins already paid to the club).
   */
  unlisted?: boolean;
  /**
   * 2026-10-23 (qualifier lifecycle S3, owner: "take breaks") — a SCHEDULED
   * break of `seconds` after every `everyLevels`-th level (never after the last
   * one). Only the online qualifiers set it (index.ts startQualifierTournament);
   * every other tournament runs its levels back to back, as before.
   */
  breaks?: TournamentBreaks;
  /**
   * 2026-10-24 (Sit & Go fix-all F9) — born from a lobby TEMPLATE
   * (createTemplateTournaments / a template's re-creation). Only these are
   * re-created (one registering instance per template); a custom, club or
   * qualifier event never is, whatever its name.
   */
  fromTemplate?: boolean;
}

/** S3 — the break schedule: `seconds` of break after every `everyLevels`-th level. */
export interface TournamentBreaks {
  everyLevels: number;
  seconds: number;
}

/** S3 — why a running tournament's clock is stopped (null = not paused). */
export type TournamentPauseReason = 'director' | 'break' | 'prestart';

/**
 * S3 — the level clock as the tables show it (getLevelClock). `remainingMs` is
 * live while the clock runs, frozen while paused (null on a break: the level is
 * over and the next one starts with its full time).
 */
export interface TournamentLevelClock {
  level: number;
  levels: number;
  durationSec: number;
  levelEndsAt: number | null;
  remainingMs: number | null;
  paused: boolean;
  pauseReason: TournamentPauseReason | null;
  breakUntil: number | null;
  sb: number;
  bb: number;
  ante: number;
  next: { sb: number; bb: number; ante: number } | null;
  entries: number;
  alive: number;
}

export interface TournamentPlayer {
  playerId: string;
  playerName: string;
  socketId: string;
  chips: number;
  eliminated: boolean;
  finishPosition: number;
  bounties: number; // number of players knocked out
  bountyEarnings: number; // total chips earned from bounties
  // 2026-06-11 tournament economy: wallet user id of a PAYING human entrant
  // (undefined for AI fill / unauthenticated). Prize credits on finish go to
  // this id; only entrants with a userId paid the entry fee and fund the pool.
  userId?: number;
  // 2026-10-10 (F4) — the MASTER account id the entrant registered with. A
  // QUALIFIER entrant has no local userId (startQualifierTournament registers
  // him by the qualifier registration's playerId); his identity is the master
  // id that registration holds (qualifierTournaments[].players[].masterPlayerId).
  // The hand-start play gate screens an ABSENT entrant by it. Never a payout key.
  masterUserId?: string;
  // 2026-10-09 — set by disqualifyPlayer (play gate: suspended mid-tournament).
  // A disqualified entrant is eliminated and is paid NO prize (his share stays
  // unpaid — never redistributed, never minted).
  disqualified?: boolean;
  /** R2 (C2) — this registration's own id (the lobby's `entryId`). */
  entryId?: string;
  registeredAt?: number;
  /**
   * R2 (P3) — busted in the SAME hand as other entrants with an EQUAL pre-hand
   * stack (markSimultaneousBustTie): they tie, and finishTournament splits the
   * prize money of their places equally between them (TDA). Was: ordered by
   * seat number.
   */
  tieGroup?: number;
}

export type TournamentStatus = 'registering' | 'running' | 'finished' | 'cancelled';

export interface Tournament {
  config: TournamentConfig;
  status: TournamentStatus;
  players: TournamentPlayer[];
  currentBlindLevel: number;
  blindTimer: NodeJS.Timeout | null;
  nextStartTime: number; // timestamp
  createdAt: number; // timestamp registration opened (for the stalled-tournament sweep)
  tableId: string | null;
  tableIds: string[]; // multi-table: all active table IDs
  startedAt: number;
  eliminationOrder: string[]; // playerIds in elimination order
  turboMode: boolean; // fast AI actions for stress testing
  playerTableMap: Map<string, string>; // playerId → tableId mapping
  // 2026-06-11 tournament economy: the prize pool is FUNDED by collected
  // entry fees (sum of buyIn over paying human entrants), NOT the template
  // `prizePool` constant. Payouts are distributed from this — guaranteeing
  // Σpayouts ≤ Σcollected, so the tournament can never mint chips.
  collectedEntryFees: number;
  // 2026-07-07 gap-fill [15] — live director pause. When true, the blind clock
  // is stopped and tournament tables hold at the next hand boundary (never
  // mid-hand). Resuming re-arms the blind timer and re-kicks the tables.
  paused: boolean;
  /**
   * R2 (TOURNEY-5) — when the CURRENT field's first registrant registered
   * (null while nobody is registered). The stall clock of an on-demand buy-in
   * tournament runs from here: it used to run from `createdAt` (the template's
   * creation at boot), so the first registration more than 30 minutes after a
   * deploy was cancelled ~10 seconds later.
   */
  firstRegistrationAt: number | null;
  /** R2 — when it finished / was cancelled (finished non-template tournaments are pruned an hour later). */
  finishedAt: number | null;
  /**
   * 2026-10-23 (qualifier lifecycle S3, owner: "run the blinds and raise them,
   * take breaks") — the level clock. `levelEndsAt` = when the current level
   * ends (set every time the blind timer is armed; null while paused / on a
   * break). `levelRemainingMs` = what was left of the level when it was
   * paused (Resume arms exactly that — it used to restart the level at full
   * length). `pauseReason` = why `paused` is set: a director's pause, a
   * scheduled break, or the hold before the first deal ('prestart' — only a
   * 'prestart' resume ends it). `breakUntil` = when a running break ends.
   * `advanceOnResume` = the level is OVER (a break, or a director pause that
   * replaced one): the resume starts the NEXT level with its full time.
   */
  levelEndsAt: number | null;
  levelRemainingMs: number | null;
  pauseReason: TournamentPauseReason | null;
  breakUntil: number | null;
  advanceOnResume: boolean;
  /**
   * S3 — every entry made: the field at the start, plus each late entry and
   * each re-entry (minus a late entry undone). The average stack is
   * entries x the starting stack / alive.
   */
  entries: number;
  /**
   * 2026-10-24 (owner 2026-10-23: "Fix both") — late entry AND re-entry CLOSED
   * at the qualifier's seat bubble (null / absent = not closed that way; the
   * 2:00 PM close is index.ts's lateRegUntil). Set by eliminatePlayer in the
   * same synchronous call that lowered the alive count; never cleared (once
   * closed, it never reopens for this event). See lateEntryBubbleOf.
   */
  lateEntryClosed?: LateEntryClosedAtBubble | null;
  /**
   * 2026-10-24 review fix-up — the largest field that PLAYED: the alive count just
   * before each elimination after the first deal (an elimination during the
   * 'prestart' hold is not counted; a no-show release / an undone seat is not an
   * elimination). The bubble is reached by any elimination that leaves the alive
   * count at the bubble or below once this went above it — so a crossing the
   * resolver could not judge (no answer at that moment) or a bubble the seat
   * package moved closes at the next elimination instead of never.
   */
  lateEntryPeakAlive?: number;
  /**
   * 2026-10-24 (Sit & Go fix-all F7) — finishTournament's results (each
   * entrant's position + payout), kept on the record so prizeForEntrant can
   * answer the runner-up's bust notice (his bust is what finished it).
   */
  finalResults?: Array<{ playerId: string; position: number; payout: number; tied?: boolean; disqualified?: boolean }>;
}

/**
 * 2026-10-24 — when (`at`, ms), at what alive count (`alive`, = the bubble or
 * below), against which bubble (`closeAtAlive`) and by whose elimination
 * (`playerId`) late entry closed at the seat bubble.
 */
export interface LateEntryClosedAtBubble {
  at: number;
  alive: number;
  closeAtAlive: number;
  playerId: string;
}

/** 2026-10-24 — what lateEntryBubbleOf answers for a tournament (null = no bubble close: not a qualifier). */
export interface LateEntryBubble {
  /** The seat bubble: seatsForTop + 1 (Sunday's package, top 10 → 11). An integer >= 2. */
  closeAtAlive: number;
  /** The 2:00 PM late close (ms): an elimination after it never closes anything (late entry is already closed). */
  openUntil: number;
}

export const DEFAULT_BLIND_LEVELS: BlindLevel[] = [
  { sb: 10, bb: 20, ante: 0, duration: 300 },
  { sb: 15, bb: 30, ante: 0, duration: 300 },
  { sb: 25, bb: 50, ante: 5, duration: 300 },
  { sb: 50, bb: 100, ante: 10, duration: 240 },
  { sb: 75, bb: 150, ante: 15, duration: 240 },
  { sb: 100, bb: 200, ante: 25, duration: 180 },
  { sb: 150, bb: 300, ante: 25, duration: 180 },
  { sb: 200, bb: 400, ante: 50, duration: 120 },
  { sb: 300, bb: 600, ante: 50, duration: 120 },
  { sb: 500, bb: 1000, ante: 100, duration: 120 },
];

export interface TournamentTemplate {
  name: string;
  buyIn: number;
  prizePool: number;
  maxPlayers: number;
  startInterval: number;
  blindLevels: BlindLevel[];
  isBounty?: boolean;
  bountyAmount?: number;
  startingChips?: number;
  /** R2 — see TournamentConfig.minPlayers. */
  minPlayers?: number;
  /** R2 — see TournamentConfig.unlisted (a club tournament). */
  unlisted?: boolean;
  /** S3 (2026-10-23) — see TournamentConfig.breaks (qualifiers only). */
  breaks?: TournamentBreaks;
}

/**
 * R2 (2026-10-11, P3) — the prize split by the size of the field. The pool is
 * split 50 / 30 / 20 (unchanged for 3 or more entrants); a field SMALLER than
 * the paid places used to leave the missing places' shares unpaid — a
 * 2-player event never paid its 3rd-place 20% (those chips simply vanished).
 * Now the places that exist share the whole pool in the same proportions
 * (2 entrants: 62.5 / 37.5) — always the whole pool (floors aside).
 */
export const PAYOUT_PERCENTS = [50, 30, 20];
export function payoutSharesFor(entrants: number, percents: number[] = PAYOUT_PERCENTS): number[] {
  const places = Math.max(0, Math.min(percents.length, Math.floor(entrants)));
  const used = percents.slice(0, places);
  const total = used.reduce((a, b) => a + b, 0);
  return total > 0 ? used.map((x) => x / total) : [];
}

const SNG_BLIND_LEVELS: BlindLevel[] = [
  { sb: 10, bb: 20, ante: 0, duration: 180 },
  { sb: 20, bb: 40, ante: 0, duration: 180 },
  { sb: 30, bb: 60, ante: 5, duration: 150 },
  { sb: 50, bb: 100, ante: 10, duration: 150 },
  { sb: 75, bb: 150, ante: 15, duration: 120 },
  { sb: 100, bb: 200, ante: 25, duration: 120 },
  { sb: 150, bb: 300, ante: 25, duration: 90 },
  { sb: 200, bb: 400, ante: 50, duration: 90 },
  { sb: 300, bb: 600, ante: 50, duration: 60 },
  { sb: 500, bb: 1000, ante: 100, duration: 60 },
];

/**
 * 2026-10-24 (owner 2026-10-23: "5-minute levels"; Sit & Go fix-all F21) — the
 * two Sit & Go templates' OWN structures. The blind / ante amounts of the old
 * SNG_BLIND_LEVELS are kept level for level; every level now lasts the same
 * time (Sit & Go 5 minutes, Turbo 3 minutes), and the schedule is extended past
 * 500/1000 (ante = bb / 10) until one hand's forced bets at a full table cover
 * every chip in play (9 x 1,500), so a long game never sits on the last level.
 * SNG_BLIND_LEVELS itself is unchanged: Bounty Turbo is still derived from it.
 */
const SNG_STRUCTURE_AMOUNTS: Array<[number, number, number]> = [
  ...SNG_BLIND_LEVELS.map((l): [number, number, number] => [l.sb, l.bb, l.ante]),
  [750, 1500, 150], [1000, 2000, 200], [1500, 3000, 300], [2000, 4000, 400], [3000, 6000, 600], [5000, 10000, 1000],
];
function sitAndGoStructure(levelSeconds: number): BlindLevel[] {
  return SNG_STRUCTURE_AMOUNTS.map(([sb, bb, ante]) => ({ sb, bb, ante, duration: levelSeconds }));
}
/** F21 — 'Sit & Go' (9 max): 1,500 chips, 5-minute levels. */
export const SIT_AND_GO_LEVELS: BlindLevel[] = sitAndGoStructure(5 * 60);
/** F21 — 'Sit & Go Turbo' (6 max): 1,500 chips, 3-minute levels. */
export const SIT_AND_GO_TURBO_LEVELS: BlindLevel[] = sitAndGoStructure(3 * 60);
export const SIT_AND_GO_STARTING_CHIPS = 1500;

const TOURNAMENT_TEMPLATES: TournamentTemplate[] = [
  {
    name: 'Freeroll',
    buyIn: 0,
    prizePool: 1000,
    maxPlayers: 9,
    startInterval: 30 * 60 * 1000, // 30 minutes
    blindLevels: DEFAULT_BLIND_LEVELS,
  },
  {
    name: 'Daily 5K',
    buyIn: 500,
    prizePool: 5000,
    maxPlayers: 12,
    startInterval: 0, // manual start when full
    blindLevels: DEFAULT_BLIND_LEVELS,
  },
  {
    name: 'High Stakes',
    buyIn: 5000,
    prizePool: 50000,
    maxPlayers: 18,
    startInterval: 0,
    blindLevels: DEFAULT_BLIND_LEVELS.map((l) => ({
      ...l,
      sb: l.sb * 5,
      bb: l.bb * 5,
      ante: l.ante * 5,
    })),
  },
  {
    name: 'Sit & Go',
    buyIn: 100,
    prizePool: 900,
    maxPlayers: 9,
    // 2026-10-24 (owner: "Make the sit and gos not start until full") — every seat
    // taken, never the templates' default of 4 (startThreshold).
    minPlayers: 9,
    startInterval: 0, // starts when full
    // F21 (owner 2026-10-23: "5-minute levels") — its own structure: 1,500 chips, 5-minute levels.
    blindLevels: SIT_AND_GO_LEVELS,
    startingChips: SIT_AND_GO_STARTING_CHIPS,
  },
  {
    name: 'Sit & Go Turbo',
    buyIn: 250,
    prizePool: 2250,
    maxPlayers: 6,
    minPlayers: 6,   // 2026-10-24 (owner) — starts only when full
    startInterval: 0,
    // F21 — its own structure: 1,500 chips, 3-minute levels.
    blindLevels: SIT_AND_GO_TURBO_LEVELS,
    startingChips: SIT_AND_GO_STARTING_CHIPS,
  },
  {
    name: 'Bounty Hunter',
    buyIn: 500,
    prizePool: 3000,
    maxPlayers: 9,
    startInterval: 0,
    blindLevels: DEFAULT_BLIND_LEVELS,
    isBounty: true,
    bountyAmount: 200,
  },
  {
    name: 'Bounty Turbo',
    buyIn: 1000,
    prizePool: 7000,
    maxPlayers: 6,
    startInterval: 0,
    isBounty: true,
    bountyAmount: 500,
    blindLevels: SNG_BLIND_LEVELS.map((l) => ({
      ...l,
      sb: l.sb * 2,
      bb: l.bb * 2,
      ante: l.ante * 2,
      duration: Math.floor(l.duration * 0.5),
    })),
  },
];

export class TournamentManager {
  /**
   * 2026-10-24 (Sit & Go fix-all F8) — an on-demand buy-in event still short
   * of its start threshold this long after its earliest REMAINING entry is
   * cancelled and refunded (checkStalledTournaments). The lobby item says so
   * (stallCancelMs / stallCancelAt).
   */
  static readonly STALL_MS = 30 * 60 * 1000;
  private tournaments: Map<string, Tournament> = new Map();
  private eventCallbacks: Map<string, Array<(event: string, data: any) => void>> = new Map();
  /**
   * 2026-10-23 (qualifier lifecycle S3) — the scheduled-break switch. Read at
   * each level boundary: off = the level advances with no break (a break
   * already running is NOT ended by turning it off — a director resume ends
   * it). index.ts sets it from Railway env QUALIFIER_BREAKS ('0' = off) at
   * boot and from POST /api/qualifiers/breaks at runtime.
   */
  breaksEnabled = true;
  /**
   * S3 — health r2Play.qualifiers.breaks: `taken` = breaks started; `endedEarly`
   * = breaks a director action interrupted (a pause, which replaces the break,
   * or a resume, which ends it at once).
   */
  readonly breakStats = { taken: 0, endedEarly: 0 };
  /**
   * 2026-10-24 (owner 2026-10-23: "Fix both") — the seat bubble of a tournament,
   * asked at EVERY elimination (null / a null answer = it never closes at the
   * bubble: every tournament that is not an online qualifier). index.ts assigns
   * qualifierLateEntryBubbleOf at boot (the event's live seat package; the 2:00
   * PM late close). The rule (eliminatePlayer): the bubble is REACHED by an
   * elimination that leaves the alive count at closeAtAlive or below while now
   * <= openUntil, once the field has PLAYED above closeAtAlive (lateEntryPeakAlive:
   * the alive count before each elimination after the first deal). Normally that
   * is the elimination that crosses it; review fix-up: if that one could not close
   * (no resolver answer at that moment, or the seat package moved the bubble), the
   * next elimination does. One elimination removes one player, so a double bust
   * that skips past the bubble passes through it on the first of the two. A field
   * that never played above the bubble stays open until openUntil;
   * removeLateEntrant (a no-show release, an undone seat) never counts. Once
   * closed, addLateEntrant / reinstateForReentry refuse (no push, no place shift)
   * for the rest of the event.
   */
  lateEntryBubbleOf: ((tournamentId: string) => LateEntryBubble | null) | null = null;
  /**
   * 2026-10-24 — health r2Play.qualifiers.lateRegBubble: `closed` = events closed
   * at the bubble; `resolverErrors` = lateEntryBubbleOf threw (nothing closed —
   * should stay 0); `lockRefusals` = late entries / re-entries refused HERE
   * because the event was closed (index.ts refuses them before any credit is
   * consumed, so this is the second lock).
   */
  readonly lateEntryBubbleStats = { closed: 0, resolverErrors: 0, lockRefusals: 0 };

  constructor() {
    this.createTemplateTournaments();
  }

  private createTemplateTournaments(): void {
    for (const template of TOURNAMENT_TEMPLATES) {
      this.createTournament(template, { fromTemplate: true });
    }
  }

  createTournament(template: TournamentTemplate, opts?: { fromTemplate?: boolean }): string {
    const tournamentId = uuidv4();
    const config: TournamentConfig = {
      tournamentId,
      name: template.name,
      buyIn: template.buyIn,
      prizePool: template.prizePool,
      maxPlayers: template.maxPlayers,
      startInterval: template.startInterval,
      blindLevels: template.blindLevels,
      isBounty: template.isBounty || false,
      bountyAmount: template.bountyAmount || 0,
      startingChips: template.startingChips || 1000,
      ...(template.minPlayers !== undefined ? { minPlayers: template.minPlayers } : {}),
      ...(template.unlisted ? { unlisted: true } : {}),
      ...(template.breaks ? { breaks: { everyLevels: template.breaks.everyLevels, seconds: template.breaks.seconds } } : {}),
      ...(opts?.fromTemplate ? { fromTemplate: true } : {}),   // F9
    };

    const now = Date.now();
    const tournament: Tournament = {
      config,
      status: 'registering',
      players: [],
      currentBlindLevel: 0,
      blindTimer: null,
      nextStartTime: template.startInterval > 0 ? now + template.startInterval : 0,
      createdAt: now,
      tableId: null,
      tableIds: [],
      startedAt: 0,
      eliminationOrder: [],
      turboMode: false,
      playerTableMap: new Map(),
      collectedEntryFees: 0,
      paused: false,
      firstRegistrationAt: null,
      finishedAt: null,
      levelEndsAt: null,
      levelRemainingMs: null,
      pauseReason: null,
      breakUntil: null,
      advanceOnResume: false,
      entries: 0,
    };

    this.tournaments.set(tournamentId, tournament);
    return tournamentId;
  }

  /** R2 — a tournament is gone for good: its record AND its event listeners (they used to leak, one set per tournament). */
  private dropTournament(tournamentId: string): void {
    this.tournaments.delete(tournamentId);
    this.eventCallbacks.delete(tournamentId);
  }

  /**
   * R2 — the template this tournament re-creates after it ends (templates only;
   * ad-hoc tournaments are not resurrected). F9 (2026-10-24): only a
   * tournament BORN from a template (config.fromTemplate) — a custom / club
   * event named like a template used to be cloned.
   */
  private templateOf(t: Tournament): TournamentTemplate | undefined {
    if (!t.config.fromTemplate) return undefined;
    return TOURNAMENT_TEMPLATES.find((x) => x.name === t.config.name);
  }

  /** F9 — is a template instance of this name open for registration right now? */
  private hasRegisteringInstanceOf(name: string): boolean {
    for (const t of this.tournaments.values()) {
      if (t.config.fromTemplate && t.config.name === name && t.status === 'registering') return true;
    }
    return false;
  }

  /**
   * F9 — re-create a template instance, unless one of that template is already
   * registering (exactly one registering instance per template at any time).
   */
  private recreateTemplateIfNone(template: TournamentTemplate): void {
    if (this.hasRegisteringInstanceOf(template.name)) return;
    this.createTournament(template, { fromTemplate: true });
  }

  /**
   * R2 — finished / cancelled NON-template tournaments (qualifiers, custom,
   * club, simulations) older than `maxAgeMs` are dropped with their listeners
   * (they used to stay in memory forever). Returns the ids dropped.
   */
  pruneEndedTournaments(now: number = Date.now(), maxAgeMs: number = 60 * 60 * 1000): string[] {
    const dropped: string[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status !== 'finished' && t.status !== 'cancelled') continue;
      if (this.templateOf(t)) continue;   // a template is re-created by its own timer
      if (t.finishedAt === null || now - t.finishedAt < maxAgeMs) continue;
      this.dropTournament(id);
      dropped.push(id);
    }
    return dropped;
  }

  /**
   * R2 (P3) — a TIMED freeroll whose start passed with fewer than two
   * registrants rolls its start forward by its interval (its registrants stay
   * registered). It used to keep the past time forever: the lobby said
   * "Starting soon" all day. (A timed BUY-IN event is left to the stall sweep,
   * which cancels and refunds it.) Returns the ids rolled.
   */
  rollOverdueFreerollStarts(now: number = Date.now(), graceMs: number = 60 * 1000): string[] {
    const rolled: string[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status !== 'registering' || t.config.startInterval <= 0 || (t.config.buyIn || 0) > 0) continue;
      if (now < t.nextStartTime + graceMs || t.players.length >= 2) continue;
      while (t.nextStartTime <= now) t.nextStartTime += t.config.startInterval;
      rolled.push(id);
    }
    return rolled;
  }

  /**
   * The lobby's list. R2 (C2) — `viewer` (the asking socket's account): every
   * item carries `registered` (an entry of THIS account — by local userId or
   * master id) and `entryId` (that entry's id, else null). Without a viewer
   * both are false / null. `minPlayers` = the start threshold.
   */
  getTournamentList(viewer?: { userId?: number; masterUserId?: string | null } | null): object[] {
    const list: object[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status === 'cancelled') continue; // don't surface cancelled tournaments
      const mine = viewer ? this.entryOfAccount(id, viewer) : undefined;
      if (t.config.unlisted && !mine) continue;   // R2 — a club tournament: its own entrants only
      const currentBlinds = t.config.blindLevels[t.currentBlindLevel] || t.config.blindLevels[0];
      const isFreeroll = (t.config.buyIn || 0) === 0;
      list.push({
        registered: !!mine,
        entryId: mine?.entryId ?? null,
        minPlayers: this.startThreshold(t),
        tournamentId: id,
        name: t.config.name,
        buyIn: t.config.buyIn,
        prizePool: t.config.prizePool,
        // What will ACTUALLY be paid: freerolls are house-funded to the
        // advertised pool; buy-in events pay the collected entry fees (grows as
        // players register). Lets the client show the real, honest prize pool.
        fundedPool: isFreeroll ? (t.config.prizePool || 0) : t.collectedEntryFees,
        isFreeroll,
        maxPlayers: t.config.maxPlayers,
        registeredPlayers: t.players.length,
        status: t.status,
        // 2026-07-07 gap-fill [15] — surface director pause state in the polled
        // list so an admin watching from the LOBBY (not in the tournament's
        // table room, where the tournamentPaused echo goes) still sees it.
        paused: t.paused,
        // 2026-10-23 (qualifier lifecycle S3 review fix-up) — WHY it is paused
        // (additive): 'director' | 'break' | 'prestart', null when not paused —
        // the same rule as getLevelClock. The lobby's TD control (poker-3d
        // TournamentLobby, marksDirectorPause) offers '▶ Resume' only for a
        // director pause; without this every scheduled break read as one, and
        // a TD's click ended the break at once.
        pauseReason: t.paused ? (t.pauseReason ?? 'director') : null,
        nextStartTime: t.nextStartTime,
        currentBlinds: t.status === 'running' ? { sb: currentBlinds.sb, bb: currentBlinds.bb, ante: currentBlinds.ante } : null,
        blindLevel: t.currentBlindLevel + 1,
        blindLevelCount: t.config.blindLevels.length,
        // F7 (2026-10-24) — the payout table (places paid + amounts) for the card /
        // detail, before registering: the SAME floor(pool x share) finishTournament
        // pays. payoutField = the field it is computed for; payoutsProjected =
        // the field (so the table) can still change. [] when nothing is paid.
        ...(() => { const pt = this.payoutTableOf(t); return { payouts: pt.payouts, payoutField: pt.field, payoutsProjected: pt.projected }; })(),
        // F8 (2026-10-24) — an on-demand BUY-IN event (startInterval 0) is cancelled
        // + refunded STALL_MS after its earliest remaining entry if still short of
        // `minPlayers`: stallCancelMs (null for other events) and stallCancelAt
        // (ms; only while registering with an entrant, else null). Additive.
        ...this.stallFieldsOf(t),
        // F21 (2026-10-24) — the structure, for the lobby card / detail (additive):
        // the starting stack, the one level length in seconds (null when the
        // levels differ) and every level.
        ...this.structureOf(t),
      });
    }
    return list;
  }

  /**
   * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F7) — the payout
   * table of a tournament: `field` (running / finished: the entrants; else the
   * field it starts with: the registrants, at least the start threshold, at
   * most maxPlayers), `projected` (registering and that field can still change)
   * and `payouts` [{place, amount}] = floor(pool x payoutSharesFor(field)), the
   * same numbers finishTournament pays. pool: a freeroll's advertised prizePool;
   * a buy-in event's collected fees once running, buyIn x field before. [] when
   * the pool is 0 (a qualifier pays seats, not chips).
   */
  payoutTableOf(t: Tournament): { field: number; projected: boolean; payouts: Array<{ place: number; amount: number }> } {
    const started = t.status === 'running' || t.status === 'finished';
    const max = Math.max(1, t.config.maxPlayers);
    const field = started ? t.players.length : Math.min(max, Math.max(t.players.length, this.startThreshold(t)));
    const freeroll = (t.config.buyIn || 0) === 0;
    const pool = freeroll ? (t.config.prizePool || 0) : (started ? t.collectedEntryFees : (t.config.buyIn || 0) * field);
    const projected = t.status === 'registering' && (t.config.startInterval > 0 || this.startThreshold(t) < max);
    if (!(pool > 0) || !(field > 0)) return { field, projected, payouts: [] };
    const payouts = payoutSharesFor(field).map((share, i) => ({ place: i + 1, amount: Math.floor(pool * share) }));
    return { field, projected, payouts };
  }

  /**
   * F7 — the prize of one entrant, for HIS notices: finished → his payout in
   * the stored results (0 = null); running and eliminated in a PAID place, not
   * in a tie group (the split is known at the finish) and not disqualified →
   * floor(pool x share) of his place (a non-qualifier field is fixed after the
   * start); otherwise null. A qualifier's pool is 0 → always null.
   */
  prizeForEntrant(tournamentId: string, playerId: string): number | null {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;
    if (t.status === 'finished') {
      const r = t.finalResults?.find((x) => x.playerId === playerId);
      return r && r.payout > 0 ? r.payout : null;
    }
    if (t.status !== 'running') return null;
    const p = t.players.find((x) => x.playerId === playerId);
    if (!p || !p.eliminated || !(p.finishPosition > 0) || p.tieGroup !== undefined || p.disqualified) return null;
    const row = this.payoutTableOf(t).payouts.find((x) => x.place === p.finishPosition);
    return row && row.amount > 0 ? row.amount : null;
  }

  /** F8 — the stall-cancel fields of a lobby item (see getTournamentList). */
  private stallFieldsOf(t: Tournament): { stallCancelMs: number | null; stallCancelAt: number | null } {
    const onDemandBuyIn = t.config.startInterval === 0 && (t.config.buyIn || 0) > 0;
    if (!onDemandBuyIn) return { stallCancelMs: null, stallCancelAt: null };
    const at = t.status === 'registering' && t.players.length > 0 && t.firstRegistrationAt !== null
      ? t.firstRegistrationAt + TournamentManager.STALL_MS : null;
    return { stallCancelMs: TournamentManager.STALL_MS, stallCancelAt: at };
  }

  /**
   * F21 (2026-10-24) — the structure fields of a lobby item: `startingChips`,
   * `levelSeconds` (every level's length when they are all the same, else null)
   * and `blindStructure` [{level, sb, bb, ante, durationSec}].
   */
  private structureOf(t: Tournament): { startingChips: number; levelSeconds: number | null; blindStructure: Array<{ level: number; sb: number; bb: number; ante: number; durationSec: number }> } {
    const levels = t.config.blindLevels || [];
    const first = levels.length > 0 ? levels[0].duration : null;
    const uniform = first !== null && levels.every((l) => l.duration === first);
    return {
      startingChips: t.config.startingChips || 1000,
      levelSeconds: uniform ? first : null,
      blindStructure: levels.map((l, i) => ({ level: i + 1, sb: l.sb, bb: l.bb, ante: l.ante, durationSec: l.duration })),
    };
  }

  /**
   * R2 (C2) — the entry THIS account holds in a tournament: by local userId,
   * else by master id (a qualifier entrant has no local userId). Never by a
   * display name or a socket.
   */
  entryOfAccount(tournamentId: string, account: { userId?: number; masterUserId?: string | null }): TournamentPlayer | undefined {
    const t = this.tournaments.get(tournamentId);
    if (!t) return undefined;
    return t.players.find((p) =>
      (account.userId !== undefined && p.userId !== undefined && p.userId === account.userId)
      || (!!account.masterUserId && !!p.masterUserId && String(p.masterUserId) === String(account.masterUserId)));
  }

  /** The number of registrants an on-demand tournament starts at. */
  private startThreshold(t: Tournament): number {
    const max = Math.max(2, t.config.maxPlayers);
    const want = t.config.minPlayers !== undefined ? Math.floor(t.config.minPlayers) : Math.min(4, max);
    return Math.max(2, Math.min(max, Number.isFinite(want) ? want : 4));
  }

  registerPlayer(
    tournamentId: string, playerId: string, playerName: string, socketId: string, userId?: number,
    /** F4 (2026-10-10) — the entrant's attested MASTER id (qualifier registrations); identity only, never paid by it. */
    masterUserId?: string,
  ): { success: boolean; error?: string; code?: string; entryId?: string } {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return { success: false, error: 'Tournament not found', code: 'tournament_not_found' };
    if (tournament.status !== 'registering') return { success: false, error: 'Tournament not open for registration', code: 'registration_closed' };
    // R2 (C2 / TOURNEY-7) — ONE entry per ACCOUNT: a second registration by the
    // same local user or master id is refused (it used to dedupe on the random
    // per-request playerId only — two lobby mounts registered twice, paid twice,
    // and a freeroll could be farmed).
    if (tournament.players.some((p) => p.playerId === playerId)
        || this.entryOfAccount(tournamentId, { userId, masterUserId: masterUserId ?? null })) {
      return { success: false, error: 'You are already registered for this tournament', code: 'already_registered' };
    }
    if (tournament.players.length >= tournament.config.maxPlayers) return { success: false, error: 'Tournament is full', code: 'tournament_full' };

    const entryId = uuidv4();
    const now = Date.now();
    tournament.players.push({
      playerId,
      playerName,
      socketId,
      chips: 1000, // starting stack
      eliminated: false,
      finishPosition: 0,
      bounties: 0,
      bountyEarnings: 0,
      userId,
      ...(masterUserId ? { masterUserId } : {}),
      entryId,
      registeredAt: now,
    });
    if (tournament.firstRegistrationAt === null) tournament.firstRegistrationAt = now;

    // 2026-06-11 tournament economy: a PAYING human entrant (has a userId and
    // the table has a buy-in) funds the prize pool by exactly their entry fee.
    // The caller (registerTournament in index.ts) has already deducted this
    // from their wallet before calling — keep the two in lockstep so the pool
    // equals real collected chips (Σpayouts ≤ Σcollected ⇒ never mints).
    if (userId !== undefined && tournament.config.buyIn > 0) {
      tournament.collectedEntryFees += tournament.config.buyIn;
    }

    return { success: true, entryId };
  }

  /**
   * R2 (TOURNEY-3, qualifier LATE entry) — add a NEW entrant to a RUNNING
   * tournament (the caller seats him at the same moment with `chips`).
   * registerPlayer refuses a running tournament; a late registrant used to be
   * charged a qualifier credit and never seated. Refused for an account that
   * already has an entry (a busted one re-enters through its own path).
   */
  addLateEntrant(
    tournamentId: string, playerId: string, playerName: string, socketId: string, chips: number,
    identity: { userId?: number; masterUserId?: string },
  ): TournamentPlayer | null {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running') return null;
    // 2026-10-24 — closed at the seat bubble: nobody is added (no push, no place shift).
    if (t.lateEntryClosed) { this.lateEntryBubbleStats.lockRefusals++; return null; }
    if (t.players.some((p) => p.playerId === playerId)
        || this.entryOfAccount(tournamentId, { userId: identity.userId, masterUserId: identity.masterUserId ?? null })) return null;
    const tp: TournamentPlayer = {
      playerId, playerName, socketId, chips, eliminated: false, finishPosition: 0, bounties: 0, bountyEarnings: 0,
      ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
      ...(identity.masterUserId ? { masterUserId: identity.masterUserId } : {}),
      entryId: uuidv4(), registeredAt: Date.now(),
    };
    t.players.push(tp);
    t.entries++;   // S3 — one more entry (the average stack counts it)
    if (t.config.maxPlayers < t.players.length) t.config.maxPlayers = t.players.length;
    // 2026-10-20 — the field grew: everyone already out finished BELOW the new
    // entrant, so each busted place moves down one. A place is fixed at the
    // bust ("players still alive + 1"); without this shift the next bust got a
    // place someone already held and the last place was never given (local
    // rig: 31 entrants, a late entry after 15 busts -> two 16ths, no 31st).
    this.shiftBustedPlaces(t, null, +1);
    return tp;
  }

  /**
   * 2026-10-20 — move busted entrants' places by `delta`: all of them
   * (`better === null`), or only those who finished BETTER than `better`
   * (a smaller place number). Keeps places a permutation of 1..N as the field
   * grows (late entry, re-entry) or shrinks back (removeLateEntrant).
   */
  private shiftBustedPlaces(t: Tournament, better: number | null, delta: number): void {
    for (const p of t.players) {
      if (!p.eliminated || !(p.finishPosition > 0)) continue;
      if (better === null || p.finishPosition < better) p.finishPosition += delta;
    }
  }

  /**
   * 2026-10-20 — a busted entrant RE-ENTERS (qualifier re-entry): he is alive
   * again with `chips`, his old place is freed, and everyone who busted AFTER
   * him (a better place) moves down one — so the next bust gets a free place
   * and places stay 1..N. false = not a busted entrant of a running tournament.
   */
  reinstateForReentry(tournamentId: string, playerId: string, chips: number): boolean {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running') return false;
    // 2026-10-24 — closed at the seat bubble: he stays out, every place unchanged.
    if (t.lateEntryClosed) { this.lateEntryBubbleStats.lockRefusals++; return false; }
    const p = t.players.find((x) => x.playerId === playerId);
    if (!p || !p.eliminated) return false;
    const old = p.finishPosition;
    if (old > 0) {
      p.eliminated = false;          // out of the shift below (his own place is freed)
      this.shiftBustedPlaces(t, old, +1);
    }
    p.eliminated = false;
    p.finishPosition = 0;
    p.chips = chips;
    delete p.tieGroup;
    t.eliminationOrder = t.eliminationOrder.filter((id) => id !== playerId);
    t.entries++;   // S3 — a re-entry is another entry (a fresh starting stack in play)
    return true;
  }

  /** R2 — undo addLateEntrant when the seat could not be taken after all (nothing else references him yet). */
  removeLateEntrant(tournamentId: string, playerId: string): boolean {
    const t = this.tournaments.get(tournamentId);
    if (!t) return false;
    const before = t.players.length;
    t.players = t.players.filter((p) => p.playerId !== playerId || p.eliminated);
    t.playerTableMap.delete(playerId);
    // 2026-10-20 — the field shrank back: undo addLateEntrant's place shift.
    if (t.players.length < before) {
      this.shiftBustedPlaces(t, null, -1);
      t.entries = Math.max(0, t.entries - 1);   // S3 — the entry was undone
    }
    return t.players.length < before;
  }

  /**
   * Refund a player's contribution to the collected pool (used when the
   * caller deducted the entry fee but then could not complete registration /
   * seating, and has refunded the wallet). Keeps collectedEntryFees in lockstep
   * with real wallet chips.
   */
  refundEntryFee(tournamentId: string, userId?: number): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || userId === undefined || tournament.config.buyIn <= 0) return;
    tournament.collectedEntryFees = Math.max(0, tournament.collectedEntryFees - tournament.config.buyIn);
  }

  /**
   * Remove a registrant. Returns true ONLY when a registration was actually
   * removed. 2026-10-09 (D5): it used to return true for a player who was not
   * (or no longer) registered, and both callers refund the entry fee on true —
   * so the tournament start screen, working from a snapshot taken before an
   * await, refunded a suspended registrant a SECOND time when he had already
   * left (and been refunded by leaveTournament) during that await.
   */
  unregisterPlayer(tournamentId: string, playerId: string): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'registering') return false;
    const before = tournament.players.length;
    tournament.players = tournament.players.filter((p) => p.playerId !== playerId);
    // R2 (TOURNEY-5) — an empty field's stall clock starts again at the next registration.
    if (tournament.players.length === 0) tournament.firstRegistrationAt = null;
    // 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F8) — else the
    // clock restarts from the EARLIEST REMAINING entry: it kept the first
    // registrant's time after he left, so the others could be cancelled minutes
    // after they entered.
    else if (tournament.players.length < before) {
      const now = Date.now();
      tournament.firstRegistrationAt = Math.min(...tournament.players.map((p) => p.registeredAt ?? now));
    }
    return tournament.players.length < before;
  }

  /**
   * Find buy-in tournaments STUCK in registration that can never start, so the
   * caller can cancel + refund every entrant (2026-07-01 audit #3 — otherwise a
   * tournament that never reaches its start threshold leaves entry fees debited
   * with no reclaim). Only flags tournaments with a real entry fee and ≥1
   * registrant. Two stall shapes:
   *   - timed (startInterval > 0): past nextStartTime + grace with < 2 players.
   *   - on-demand (startInterval === 0): STALL_MS after its FIRST registration
   *     (R2, TOURNEY-5 — it used to be the template's creation at boot) and
   *     still below its start threshold.
   */
  checkStalledTournaments(now: number = Date.now()): string[] {
    const STALL_MS = TournamentManager.STALL_MS; // 30 min (F8: also shown in the lobby)
    const GRACE_MS = 5 * 60 * 1000;  // 5 min past the scheduled start
    const stalled: string[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status !== 'registering') continue;
      if ((t.config.buyIn || 0) <= 0) continue;   // nothing to refund
      if (t.players.length === 0) continue;         // nobody to strand
      if (t.config.startInterval > 0) {
        if (now >= t.nextStartTime + GRACE_MS && t.players.length < 2) stalled.push(id);
      } else {
        const since = t.firstRegistrationAt ?? now;
        if (now - since >= STALL_MS && t.players.length < this.startThreshold(t)) stalled.push(id);
      }
    }
    return stalled;
  }

  /**
   * Cancel a still-registering tournament and return its registrants (with
   * userId + the per-entrant refund amount) so the caller can refund wallets.
   * Sets status to 'cancelled' and zeroes the collected pool. Idempotent.
   */
  cancelTournament(tournamentId: string): { playerId: string; userId?: number; refund: number }[] {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'registering') return [];
    const entryFee = tournament.config.buyIn || 0;
    const registrants = tournament.players.map((p) => ({
      playerId: p.playerId,
      userId: p.userId,
      refund: (entryFee > 0 && p.userId !== undefined) ? entryFee : 0,
    }));
    tournament.status = 'cancelled';
    tournament.players = [];
    tournament.collectedEntryFees = 0;
    tournament.firstRegistrationAt = null;
    tournament.finishedAt = Date.now();

    // B1 fix (2026-07-01 review): recreate the template for the next round so a
    // stalled-and-cancelled tournament REAPPEARS in the lobby — otherwise the
    // type is filtered out of getTournamentList forever (until process restart).
    // Mirrors finishTournament's recreate; gated on a real template name so
    // ad-hoc qualifier/simulated tournaments are NOT resurrected.
    const template = this.templateOf(tournament);
    if (template) {
      const recreate = setTimeout(() => {
        this.dropTournament(tournamentId);
        this.recreateTemplateIfNone(template);   // F9 — never a second registering instance
      }, 10000);
      (recreate as any)?.unref?.();   // R2 — a pending re-creation never holds the process open
    }

    return registrants;
  }

  /**
   * R2 (item 1, the shutdown flush) — a RUNNING tournament cannot survive the
   * restart (it lives in memory): it is VOIDED — status 'cancelled' (no
   * elimination can finish it any more, so no prize is paid on top of the
   * refund), clock stopped — and every PAYING entrant (eliminated or not) is
   * returned with his entry fee to refund. Idempotent (a second call returns []).
   */
  voidRunningTournament(tournamentId: string): { playerId: string; userId?: number; entryId?: string; refund: number }[] {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running') return [];
    const fee = t.config.buyIn || 0;
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    if (t.blindTimer) { clearTimeout(t.blindTimer); t.blindTimer = null; }
    return t.players.map((p) => ({
      playerId: p.playerId, userId: p.userId, ...(p.entryId ? { entryId: p.entryId } : {}),
      // A DISQUALIFIED entrant (suspended mid-tournament) is never paid — not even his fee back (2026-10-09 S4 rule).
      refund: fee > 0 && p.userId !== undefined && !p.disqualified ? fee : 0,
    }));
  }

  /** R2 — the ids of tournaments in a given state (the shutdown flush, the stall / prune sweeps). */
  tournamentIdsWithStatus(status: TournamentStatus): string[] {
    const out: string[] = [];
    for (const [id, t] of this.tournaments) if (t.status === status) out.push(id);
    return out;
  }

  canStart(tournamentId: string): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return false;
    if (tournament.status !== 'registering') return false;
    // Need at least 2 players, or if timed, need at least 2 and time passed
    if (tournament.players.length < 2) return false;
    if (tournament.config.startInterval > 0) {
      return Date.now() >= tournament.nextStartTime && tournament.players.length >= 2;
    }
    // Manual start: when its start threshold is reached (R2 — a custom
    // tournament's own minPlayers; templates min(4, max) as before).
    return tournament.players.length >= this.startThreshold(tournament);
  }

  startTournament(tournamentId: string): { success: boolean; startingChips: number; blinds: BlindLevel } | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'registering') return null;
    if (tournament.players.length < 2) return null;

    tournament.status = 'running';
    tournament.startedAt = Date.now();
    tournament.currentBlindLevel = 0;
    tournament.entries = tournament.players.length;   // S3 — the field at the start

    // 2026-07-07 gap-fill [14] — honor a custom starting stack; defaults to 1000
    // (every hardcoded template omits startingChips, so their behavior is unchanged).
    const startingChips = tournament.config.startingChips || 1000;
    for (const p of tournament.players) {
      p.chips = startingChips;
      p.eliminated = false;
      p.finishPosition = 0;
    }

    const firstLevel = tournament.config.blindLevels[0];

    // Schedule blind level ups
    this.scheduleBlindUp(tournamentId);

    // 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F9) — an
    // on-demand TEMPLATE event (the Sit & Gos, Daily 5K, ...) opens a fresh
    // registering instance the moment it starts, so arriving players queue for
    // the next table (there used to be none until 10 s after this one ENDED).
    // The timed Freeroll keeps its finish + 10 s re-creation (its cadence).
    const template = this.templateOf(tournament);
    if (template && tournament.config.startInterval === 0) this.recreateTemplateIfNone(template);

    return { success: true, startingChips, blinds: firstLevel };
  }

  /**
   * Arms the blind timer for the CURRENT level: its full duration, or
   * `durationMs` (S3: what was left of it when it was paused). Sets
   * `levelEndsAt` (the level clock the tables show). Never while paused.
   */
  private scheduleBlindUp(tournamentId: string, durationMs?: number): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') return;
    // 2026-07-07 gap-fill [15] — never re-arm the clock while paused.
    if (tournament.paused) return;

    const currentLevel = tournament.config.blindLevels[tournament.currentBlindLevel];
    if (!currentLevel) return;

    // 2026-07-07 review fix — ALWAYS clear any pending timer before arming a new
    // one. Without this, a redundant resume (or a double-fired resume from two
    // admins) would leak the running timer and arm a second, double-advancing
    // the blind level and leaving an untracked timer that pause can't cancel.
    if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }

    const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? Math.round(durationMs)
      : currentLevel.duration * 1000;
    // S3 (2026-10-23) — the level clock: when this level ends.
    tournament.levelEndsAt = Date.now() + ms;
    tournament.levelRemainingMs = null;
    tournament.blindTimer = setTimeout(() => {
      this.advanceBlindLevel(tournamentId);
    }, ms);
    (tournament.blindTimer as any)?.unref?.();   // R2 — a blind clock never holds the process open
  }

  /**
   * The blind timer fired: the current level is over. S3 (2026-10-23, owner:
   * "take breaks") — a SCHEDULED BREAK starts instead of the next level when
   * the tournament has a break schedule (qualifiers only), the switch is on
   * (`breaksEnabled`), the level that ended is a multiple of `everyLevels` and
   * it is not the last level. Else the next level starts, as before.
   */
  private advanceBlindLevel(tournamentId: string): void {
    if (this.startBreakIfDue(tournamentId)) return;
    this.doAdvanceLevel(tournamentId);
  }

  /**
   * S3 — start the break due at the end of the current level (see
   * advanceBlindLevel). The tournament is PAUSED with reason 'break' (every
   * table holds at its next hand boundary, exactly as a director's pause), and
   * the break's end timer is the tournament's `blindTimer`, so finish / void /
   * a director pause clear it like the level timer. `advanceOnResume`: the
   * level is over, so the end of the break (or a director's resume) starts the
   * NEXT level with its full time. Emits 'tournamentBreak' {tournamentId,
   * afterLevel, resumesAt (ms)}. true = a break started.
   */
  private startBreakIfDue(tournamentId: string): boolean {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running' || t.paused) return false;
    const b = t.config.breaks;
    if (!b || !this.breaksEnabled) return false;
    const every = Math.floor(Number(b.everyLevels));
    const seconds = Number(b.seconds);
    if (!(every >= 1) || !(seconds > 0) || !Number.isFinite(seconds)) return false;
    const endedLevel = t.currentBlindLevel + 1;                        // 1-based
    if (endedLevel % every !== 0) return false;
    if (endedLevel >= t.config.blindLevels.length) return false;       // never after the last level
    const ms = Math.max(1000, Math.round(seconds * 1000));
    const now = Date.now();
    if (t.blindTimer) { clearTimeout(t.blindTimer); t.blindTimer = null; }
    t.paused = true;
    t.pauseReason = 'break';
    t.breakUntil = now + ms;
    t.levelEndsAt = null;
    t.levelRemainingMs = null;
    t.advanceOnResume = true;
    t.blindTimer = setTimeout(() => { this.endBreak(tournamentId); }, ms);
    (t.blindTimer as any)?.unref?.();
    this.breakStats.taken++;
    this.emitEvent(tournamentId, 'tournamentBreak', { tournamentId, afterLevel: endedLevel, resumesAt: t.breakUntil });
    return true;
  }

  /**
   * S3 — the break's own timer fired. Only while the break is still running
   * (a director pause replaced it, or a resume ended it: nothing to do). It
   * un-pauses, then starts the next level (blindLevelUp, full time), then
   * emits 'tournamentBreakEnded' {tournamentId, level} — index.ts balances the
   * tables and re-deals them.
   */
  private endBreak(tournamentId: string): void {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running' || !t.paused || t.pauseReason !== 'break') return;
    t.blindTimer = null;
    t.paused = false;
    t.pauseReason = null;
    t.breakUntil = null;
    t.advanceOnResume = false;
    t.levelRemainingMs = null;
    this.doAdvanceLevel(tournamentId);
    this.emitEvent(tournamentId, 'tournamentBreakEnded', { tournamentId, level: t.currentBlindLevel + 1 });
  }

  // 2026-07-07 gap-fill [15] — shared blind-up body so BOTH the automatic timer
  // and a director's manual "Advance Level" run identical logic. Returns the new
  // BlindLevel (or null if already at the top / not running).
  private doAdvanceLevel(tournamentId: string): BlindLevel | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') return null;

    // 2026-06-11 audit E3: STOP at the final level. The old code clamped
    // currentBlindLevel to the max but then ALWAYS rescheduled — so at the top
    // level it fired forever, re-emitting blindLevelUp (and the per-level push
    // notification) every `duration`. Once we're at the last level, don't
    // increment, emit, or reschedule again.
    if (tournament.currentBlindLevel >= tournament.config.blindLevels.length - 1) {
      return null;
    }

    tournament.currentBlindLevel++;

    const newLevel = tournament.config.blindLevels[tournament.currentBlindLevel];
    // S3 (2026-10-23) — the new level's clock is armed BEFORE the event, so
    // blindLevelUp carries its `levelEndsAt` (additive).
    this.scheduleBlindUp(tournamentId);
    this.emitEvent(tournamentId, 'blindLevelUp', {
      level: tournament.currentBlindLevel + 1,
      sb: newLevel.sb,
      bb: newLevel.bb,
      ante: newLevel.ante,
      levelEndsAt: tournament.levelEndsAt,
    });
    return newLevel;
  }

  // 2026-07-07 gap-fill [15] — manual director "Advance Level". Clears the
  // pending auto timer (so we don't double-advance), then advances one level via
  // the shared body. The blindLevelUp event listener in index.ts mutates the
  // live table blinds + broadcasts, so a manual advance rides that path too.
  advanceLevel(tournamentId: string): BlindLevel | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running' || tournament.paused) return null;
    if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }
    return this.doAdvanceLevel(tournamentId);
  }

  // 2026-07-07 gap-fill [15] — director pause/resume. Pausing stops the blind
  // clock; index.ts holds the tables at the next hand boundary. Returns false
  // if the tournament isn't running.
  //
  // 2026-10-23 (qualifier lifecycle S3) — `reason`: 'director' (the default:
  // the TD's Pause / Resume, POST /api/qualifiers/pause) or 'prestart' (the
  // hold before the first deal).
  //   Pause stores what is left of the level (levelRemainingMs, at least 1 s)
  //   and stops the clock; a 'prestart' hold keeps the FULL first level. A
  //   pause during a running BREAK replaces the break with a director's pause
  //   (its end timer stops; the level stays over — advanceOnResume).
  //   Resume arms exactly the time that was left (it used to restart the level
  //   at its FULL length); after a break (advanceOnResume) it starts the NEXT
  //   level with its full time; a 'prestart' resume arms the full first level.
  //   A 'prestart' hold is ended ONLY by a 'prestart' resume: any other resume
  //   is refused (false).
  pauseTournament(tournamentId: string, paused: boolean, reason: 'director' | 'prestart' = 'director'): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') return false;
    // S3 — a director's pause during a BREAK: the break becomes his pause.
    if (paused && tournament.paused && tournament.pauseReason === 'break' && reason === 'director') {
      if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }
      tournament.pauseReason = 'director';
      tournament.breakUntil = null;
      this.breakStats.endedEarly++;
      this.emitEvent(tournamentId, 'tournamentPaused', { tournamentId, reason: 'director' });
      return true;
    }
    // 2026-07-07 review fix — no-op if already in the requested state. Without
    // this, a redundant resume (paused already false) would call scheduleBlindUp
    // on a running tournament and (pre-clearTimeout-fix) leak/duplicate the timer.
    if (tournament.paused === paused) return true;
    if (paused) {
      const level = tournament.config.blindLevels[tournament.currentBlindLevel];
      const full = level ? level.duration * 1000 : null;
      if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }
      tournament.levelRemainingMs = reason === 'prestart'
        ? full
        : (tournament.levelEndsAt !== null ? Math.max(1000, tournament.levelEndsAt - Date.now()) : full);
      tournament.levelEndsAt = null;
      tournament.paused = true;
      tournament.pauseReason = reason;
      tournament.breakUntil = null;
      this.emitEvent(tournamentId, 'tournamentPaused', { tournamentId, reason });
    } else {
      // S3 — the hold before the first deal ends only at the start.
      if (tournament.pauseReason === 'prestart' && reason !== 'prestart') return false;
      const was = tournament.pauseReason;
      const remaining = tournament.levelRemainingMs;
      const advance = tournament.advanceOnResume;
      if (was === 'break') this.breakStats.endedEarly++;   // a resume ended a break early
      if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }
      tournament.paused = false;
      tournament.pauseReason = null;
      tournament.breakUntil = null;
      tournament.advanceOnResume = false;
      tournament.levelRemainingMs = null;
      if (advance) this.doAdvanceLevel(tournamentId);                   // the level was over: the next one, full time
      else if (was === 'prestart') this.scheduleBlindUp(tournamentId);  // the start: the full first level
      else this.scheduleBlindUp(tournamentId, remaining ?? undefined);  // what was left of the level
      this.emitEvent(tournamentId, 'tournamentResumed', { tournamentId, reason });
    }
    return true;
  }

  /**
   * S3 (2026-10-23) — the level clock (index.ts puts it in every tournament
   * table's state). null = no such tournament. `remainingMs`: live while the
   * clock runs; frozen while paused; null on a break (the level is over) and
   * once the tournament is no longer running. `next` = the next level's blinds
   * (null at the last level).
   */
  getLevelClock(tournamentId: string): TournamentLevelClock | null {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;
    const levels = t.config.blindLevels;
    if (levels.length === 0) return null;
    const idx = Math.max(0, Math.min(levels.length - 1, t.currentBlindLevel));
    const cur = levels[idx];
    const nxt = idx + 1 < levels.length ? levels[idx + 1] : null;
    const running = t.status === 'running';
    const paused = running && t.paused;
    let remainingMs: number | null = null;
    if (running && !t.paused && t.levelEndsAt !== null) remainingMs = Math.max(0, t.levelEndsAt - Date.now());
    else if (paused && !t.advanceOnResume) remainingMs = t.levelRemainingMs;
    return {
      level: idx + 1,
      levels: levels.length,
      durationSec: cur.duration,
      levelEndsAt: running && !t.paused ? t.levelEndsAt : null,
      remainingMs,
      paused,
      pauseReason: paused ? (t.pauseReason ?? 'director') : null,
      breakUntil: paused && t.pauseReason === 'break' ? t.breakUntil : null,
      sb: cur.sb,
      bb: cur.bb,
      ante: cur.ante,
      next: nxt ? { sb: nxt.sb, bb: nxt.bb, ante: nxt.ante } : null,
      entries: t.entries,
      alive: this.getAliveCount(tournamentId),
    };
  }

  eliminatePlayer(tournamentId: string, playerId: string, eliminatorId?: string): { finished: boolean; position: number; payout: number; bountyPayout?: number } | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') return null;

    const player = tournament.players.find((p) => p.playerId === playerId);
    if (!player || player.eliminated) return null;

    player.eliminated = true;
    tournament.eliminationOrder.push(playerId);

    const alivePlayers = tournament.players.filter((p) => !p.eliminated);
    player.finishPosition = alivePlayers.length + 1;

    // 2026-10-24 (owner 2026-10-23: "Fix both") — did THIS elimination reach the
    // seat bubble? Decided here, in the same synchronous call that lowered the
    // alive count, BEFORE the bounty and 'playerEliminated' (so no late entry can
    // slip in between, and the close is recorded before the bust is handled).
    this.closeLateEntryIfBubbleReached(tournamentId, tournament, alivePlayers.length, playerId);

    // Bounty payout: award the eliminator if this is a bounty tournament
    let bountyPayout = 0;
    if (tournament.config.isBounty && tournament.config.bountyAmount && eliminatorId) {
      const eliminator = tournament.players.find((p) => p.playerId === eliminatorId && !p.eliminated);
      if (eliminator) {
        eliminator.bounties++;
        eliminator.bountyEarnings += tournament.config.bountyAmount;
        bountyPayout = tournament.config.bountyAmount;
        this.emitEvent(tournamentId, 'bountyAwarded', {
          eliminatorId,
          eliminatorName: eliminator.playerName,
          eliminatedName: player.playerName,
          bountyAmount: tournament.config.bountyAmount,
        });
      }
    }

    this.emitEvent(tournamentId, 'playerEliminated', {
      playerId,
      playerName: player.playerName,
      position: player.finishPosition,
      eliminatorId,
    });

    // Check if tournament is over
    if (alivePlayers.length <= 1) {
      return this.finishTournament(tournamentId);
    }

    return { finished: false, position: player.finishPosition, payout: 0, bountyPayout };
  }

  /** 2026-10-24 — the seat-bubble close of a tournament (null = late entry was not closed that way). */
  lateEntryClosedAtBubble(tournamentId: string): LateEntryClosedAtBubble | null {
    return this.tournaments.get(tournamentId)?.lateEntryClosed ?? null;
  }

  /**
   * 2026-10-24 — eliminatePlayer's seat-bubble test (see lateEntryBubbleOf).
   * `alive` = the alive count AFTER this elimination (it was alive + 1). Never
   * throws: a resolver that throws is counted and closes nothing. The state is
   * set BEFORE the 'lateEntryClosedAtBubble' event, so the lock holds even if a
   * listener throws; a throwing listener is logged and never breaks the
   * elimination.
   */
  private closeLateEntryIfBubbleReached(tournamentId: string, t: Tournament, alive: number, playerId: string): void {
    if (t.lateEntryClosed || !this.lateEntryBubbleOf) return;
    // Review fix-up — the field that played (alive + 1 were playing), recorded
    // BEFORE the resolver is asked, so a moment it has no answer is not lost.
    if (!(t.paused && t.pauseReason === 'prestart')) t.lateEntryPeakAlive = Math.max(t.lateEntryPeakAlive ?? 0, alive + 1);
    let bubble: LateEntryBubble | null;
    try {
      bubble = this.lateEntryBubbleOf(tournamentId);
    } catch {
      this.lateEntryBubbleStats.resolverErrors++;
      return;
    }
    if (!bubble || typeof bubble !== 'object') return;
    const { closeAtAlive, openUntil } = bubble;
    if (!Number.isInteger(closeAtAlive) || closeAtAlive < 2) return;
    if (typeof openUntil !== 'number' || !Number.isFinite(openUntil)) return;
    const now = Date.now();
    if (now > openUntil) return;                                       // after 2:00 PM: already closed by the clock
    // Review fix-up — at or below the bubble now, having PLAYED above it (the
    // crossing elimination itself, or the first elimination after a crossing the
    // resolver could not judge / after the package moved the bubble).
    if (!((t.lateEntryPeakAlive ?? 0) > closeAtAlive && alive <= closeAtAlive)) return;
    t.lateEntryClosed = { at: now, alive, closeAtAlive, playerId };
    this.lateEntryBubbleStats.closed++;
    try {
      this.emitEvent(tournamentId, 'lateEntryClosedAtBubble', { tournamentId, alive, closeAtAlive, playerId, at: now });
    } catch (e) {
      console.error(`[Tournament] ${JSON.stringify({ event: 'late_entry_closed_listener_failed', tournamentId, error: String((e as Error)?.message || e) })}`);
    }
  }

  /**
   * 2026-10-09 — DISQUALIFY a running entrant (play gate: found suspended at a
   * hand boundary mid-tournament). Standing his seat up WITHOUT eliminating
   * him would leave him "alive" in `players` forever, so the tournament could
   * never reach one survivor and finish. So: mark disqualified, zero his
   * tournament stack, and eliminate him through the normal path (no
   * eliminator → no bounty), which records a finish position and finishes the
   * tournament if only one entrant is left. finishTournament pays a
   * disqualified entrant nothing. Returns null if he is not a live entrant.
   */
  disqualifyPlayer(tournamentId: string, playerId: string): { finished: boolean; position: number } | null {
    return this.disqualifyPlayers(tournamentId, [playerId]).get(playerId) ?? null;
  }

  /**
   * 2026-10-09 (S4) — disqualify SEVERAL running entrants found suspended at
   * the SAME hand boundary. ALL of them are flagged `disqualified` (stack
   * zeroed) BEFORE any is eliminated: eliminating one can finish the
   * tournament synchronously, and finishTournament pays the last entrant
   * alive — if that survivor is himself being disqualified he must already
   * carry the flag, or he is paid 1st place (heads-up with both players
   * suspended: the second one used to win the pool). A survivor who is
   * flagged gets position 1 and payout 0; his share stays unpaid (no
   * redistribution, no mint). Per player: `{finished, position}`, or null if
   * he was not a live entrant of a running tournament.
   */
  disqualifyPlayers(tournamentId: string, playerIds: string[]): Map<string, { finished: boolean; position: number } | null> {
    const out = new Map<string, { finished: boolean; position: number } | null>();
    const ids = Array.from(new Set(playerIds));
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') {
      for (const id of ids) out.set(id, null);
      return out;
    }
    const live = new Map<string, TournamentPlayer>();
    for (const id of ids) {
      const p = tournament.players.find((x) => x.playerId === id);
      if (p && !p.eliminated) live.set(id, p);
    }
    // 1. Flag every one of them first (nothing is eliminated yet).
    for (const p of live.values()) {
      p.disqualified = true;
      p.chips = 0;
    }
    // 2. Then eliminate them one by one through the normal path.
    for (const id of ids) {
      const p = live.get(id);
      if (!p) { out.set(id, null); continue; }
      if (tournament.status !== 'running') {
        // An earlier elimination in this batch finished the tournament and he
        // was its survivor: already flagged, so he was paid nothing.
        out.set(id, { finished: true, position: p.finishPosition });
        continue;
      }
      const r = this.eliminatePlayer(tournamentId, id);
      out.set(id, r ? { finished: r.finished, position: p.finishPosition } : null);
    }
    return out;
  }

  /**
   * R2 (P3) — these entrants busted in the SAME hand with an EQUAL pre-hand
   * stack: they tie (TDA). Call it before eliminating them (the bust check);
   * their places are still assigned one by one, and finishTournament splits the
   * prize money of all their places equally between them. Fewer than two live
   * entrants: nothing to tie.
   */
  private nextTieGroup = 1;
  markSimultaneousBustTie(tournamentId: string, playerIds: string[]): boolean {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running') return false;
    const live = t.players.filter((p) => playerIds.includes(p.playerId) && !p.eliminated);
    if (live.length < 2) return false;
    const group = this.nextTieGroup++;
    for (const p of live) p.tieGroup = group;
    return true;
  }

  /**
   * 2026-10-24 (owner 2026-10-23, TDA; the HAND-FOR-HAND companion) — these
   * entrants busted in the SAME hand-for-hand hand, at one table or several. Each
   * was eliminated at once (eliminatePlayer: alive + 1 at that moment), so their
   * places followed whichever table's bust check ran first. They are re-placed
   * among their OWN place numbers by their stack at the START of that hand: the
   * bigger stack takes the better (smaller) place.
   *  - Members: entrants of this RUNNING tournament that are eliminated with a
   *    place (> 0) and not disqualified; ids de-duplicated (the first entry
   *    counts). Fewer than two → [] and nothing changes.
   *  - Equal starting stacks: the larger `order` (the caller's table order x
   *    MAX_SEATS + seat index) takes the better number — the LOWER-numbered seat
   *    (Qualifier Table 1 before 2) takes the WORSE place, the existing in-table
   *    rule — and every such group of 2+ gets ONE fresh tie group (overriding an
   *    in-table one), so finishTournament splits their places' money and marks
   *    them tied (the existing tie rule; a qualifier's pool is 0).
   *  - eliminationOrder: the members' slots are refilled worst place first.
   * Only the members' own numbers are permuted, so places stay a permutation of
   * 1..N, everyone once (the place range is fixed: hand-for-hand runs only after
   * the late close). No chip or credit moves. Returns every member's
   * {playerId, from, to}, best place first.
   */
  placeSimultaneousBusts(
    tournamentId: string, busts: Array<{ playerId: string; startStack: number; order: number }>,
  ): Array<{ playerId: string; from: number; to: number }> {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running' || !Array.isArray(busts)) return [];
    const seen = new Set<string>();
    const members: Array<{ p: TournamentPlayer; startStack: number; order: number }> = [];
    for (const b of busts) {
      if (!b || typeof b.playerId !== 'string' || seen.has(b.playerId)) continue;
      const p = t.players.find((x) => x.playerId === b.playerId);
      if (!p || !p.eliminated || !(p.finishPosition > 0) || p.disqualified) continue;
      seen.add(b.playerId);
      members.push({
        p,
        startStack: Number.isFinite(b.startStack) ? b.startStack : 0,
        order: Number.isFinite(b.order) ? b.order : 0,
      });
    }
    if (members.length < 2) return [];
    const places = members.map((m) => m.p.finishPosition).sort((a, b) => a - b);
    const ranked = [...members].sort((a, b) => (b.startStack - a.startStack) || (b.order - a.order));
    const out: Array<{ playerId: string; from: number; to: number }> = [];
    ranked.forEach((m, k) => {
      out.push({ playerId: m.p.playerId, from: m.p.finishPosition, to: places[k] });
      m.p.finishPosition = places[k];
    });
    // eliminationOrder runs worst place first: the members' own slots, refilled in that order.
    const slots: number[] = [];
    t.eliminationOrder.forEach((id, i) => { if (seen.has(id)) slots.push(i); });
    if (slots.length === ranked.length) {
      const worstFirst = [...ranked].reverse().map((m) => m.p.playerId);
      slots.forEach((slot, k) => { t.eliminationOrder[slot] = worstFirst[k]; });
    }
    // An exact tie (equal starting stacks): one fresh tie group per group of 2+.
    const byStack = new Map<number, TournamentPlayer[]>();
    for (const m of ranked) {
      const g = byStack.get(m.startStack) || [];
      g.push(m.p);
      byStack.set(m.startStack, g);
    }
    for (const g of byStack.values()) {
      if (g.length < 2) continue;
      const group = this.nextTieGroup++;
      for (const p of g) p.tieGroup = group;
    }
    return out;
  }

  private finishTournament(tournamentId: string): { finished: boolean; position: number; payout: number } | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return null;

    tournament.status = 'finished';
    tournament.finishedAt = Date.now();
    if (tournament.blindTimer) {
      clearTimeout(tournament.blindTimer);
      tournament.blindTimer = null;
    }

    const alivePlayers = tournament.players.filter((p) => !p.eliminated);
    if (alivePlayers.length === 1) {
      alivePlayers[0].finishPosition = 1;
    }

    // Tournament economy (product decision 2026-07-05):
    //  • FREEROLLS (buyIn 0) are HOUSE-SPONSORED — pay the advertised prizePool.
    //    Previously they collected $0 in fees and therefore paid $0, so an
    //    advertised "1,000 chip freeroll" was a lie. The house now funds it: an
    //    intentional, audited play-money mint. Only human (userId) winners are
    //    credited in index.ts, so an all-AI freeroll mints nothing.
    //  • BUY-IN events still pay the FUNDED pool (collected entry fees), so a
    //    large advertised guarantee on an under-subscribed event can't trigger a
    //    runaway house mint. Σpayouts ≤ collected for these — mint-free.
    const isFreeroll = (tournament.config.buyIn || 0) === 0;
    const prizePool = isFreeroll
      ? (tournament.config.prizePool || 0)
      : tournament.collectedEntryFees;
    // R2 (P3) — the shares by the size of the field (payoutSharesFor): a
    // 2-entrant event pays 62.5 / 37.5 — its "3rd place" 20% used to vanish.
    const shares = payoutSharesFor(tournament.players.length);
    const payouts: Record<number, number> = {};
    shares.forEach((s, i) => { payouts[i + 1] = Math.floor(prizePool * s); });
    // R2 (P3) — a TIE (busted in the same hand with equal stacks): the money of
    // all the tied places, split equally (floors; the remainder stays unpaid —
    // never minted).
    const tiedPayout = new Map<number, number>();
    const groups = new Map<number, TournamentPlayer[]>();
    for (const p of tournament.players) {
      if (p.tieGroup === undefined || !p.eliminated) continue;
      const g = groups.get(p.tieGroup) || [];
      g.push(p);
      groups.set(p.tieGroup, g);
    }
    for (const [group, members] of groups) {
      if (members.length < 2) continue;
      const sum = members.reduce((a, p) => a + (payouts[p.finishPosition] || 0), 0);
      tiedPayout.set(group, Math.floor(sum / members.length));
    }

    const results = tournament.players.map((p) => {
      const tied = p.tieGroup !== undefined && tiedPayout.has(p.tieGroup);
      const base = tied ? tiedPayout.get(p.tieGroup!)! : (payouts[p.finishPosition] || 0);
      return {
        playerId: p.playerId,
        playerName: p.playerName,
        position: p.finishPosition,
        // 2026-10-09 — a disqualified entrant (suspended mid-tournament) is paid
        // nothing; his position's share stays unpaid (no redistribution, no mint).
        payout: p.disqualified ? 0 : base,
        userId: p.userId,
        // (No master id here: these results go to every socket in the table
        // rooms — index.ts finds a master id on the entrant record.)
        ...(p.entryId ? { entryId: p.entryId } : {}),
        ...(tied ? { tied: true } : {}),
        ...(p.disqualified ? { disqualified: true } : {}),
      };
    });

    // F7 (2026-10-24) — kept for prizeForEntrant (the runner-up's own bust notice).
    tournament.finalResults = results.map((r) => ({
      playerId: r.playerId, position: r.position, payout: r.payout,
      ...(r.tied ? { tied: true } : {}), ...(r.disqualified ? { disqualified: true } : {}),
    }));

    this.emitEvent(tournamentId, 'tournamentFinished', {
      tournamentId,
      results,
    });

    // Re-create the tournament for next round after a delay. F9 (2026-10-24):
    // the finished record is dropped; a new instance only if none of that
    // template is registering (an on-demand one opened at this one's start).
    const recreate = setTimeout(() => {
      const template = this.templateOf(tournament);
      if (template) {
        this.dropTournament(tournamentId);
        this.recreateTemplateIfNone(template);
      }
    }, 10000);
    (recreate as any)?.unref?.();   // R2 — a pending re-creation never holds the process open

    return { finished: true, position: 1, payout: payouts[1] || 0 };
  }

  getTournament(tournamentId: string): Tournament | undefined {
    return this.tournaments.get(tournamentId);
  }

  getCurrentBlinds(tournamentId: string): BlindLevel | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return null;
    return tournament.config.blindLevels[tournament.currentBlindLevel] || null;
  }

  setTableId(tournamentId: string, tableId: string): void {
    const tournament = this.tournaments.get(tournamentId);
    if (tournament) {
      tournament.tableId = tableId;
    }
  }

  // Event system
  onEvent(tournamentId: string, callback: (event: string, data: any) => void): void {
    if (!this.eventCallbacks.has(tournamentId)) {
      this.eventCallbacks.set(tournamentId, []);
    }
    this.eventCallbacks.get(tournamentId)!.push(callback);
  }

  private emitEvent(tournamentId: string, event: string, data: any): void {
    const callbacks = this.eventCallbacks.get(tournamentId) || [];
    for (const cb of callbacks) {
      cb(event, data);
    }
  }

  // Auto-check timed tournaments
  checkTimedTournaments(): string[] {
    const readyToStart: string[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status === 'registering' && t.config.startInterval > 0) {
        if (Date.now() >= t.nextStartTime && t.players.length >= 2) {
          readyToStart.push(id);
        }
      }
    }
    return readyToStart;
  }

  // ========== Multi-Table Tournament Support ==========

  /** Set all table IDs for a multi-table tournament */
  setTableIds(tournamentId: string, tableIds: string[]): void {
    const t = this.tournaments.get(tournamentId);
    if (t) {
      t.tableIds = [...tableIds];
      // Legacy single-table compat
      if (!t.tableId && tableIds.length > 0) t.tableId = tableIds[0];
    }
  }

  /** Map a player to their current table */
  setPlayerTable(tournamentId: string, playerId: string, tableId: string): void {
    const t = this.tournaments.get(tournamentId);
    if (t) t.playerTableMap.set(playerId, tableId);
  }

  /** Get which table a player is at */
  getPlayerTable(tournamentId: string, playerId: string): string | undefined {
    return this.tournaments.get(tournamentId)?.playerTableMap.get(playerId);
  }

  /** Remove a table from the tournament (after breaking) */
  removeTable(tournamentId: string, tableId: string): void {
    const t = this.tournaments.get(tournamentId);
    if (t) {
      t.tableIds = t.tableIds.filter(id => id !== tableId);
    }
  }

  /**
   * 2026-10-22 (owner: "Build it for Sunday") — a table OPENED in a running
   * tournament (index.ts openQualifierOverflowTable: a qualifier late entrant
   * or re-entrant found every seat alive). Appended to the LIVE tableIds — a
   * new array, like removeTable — only while the tournament is running and only
   * once; the tournament's one event listener (blind-ups, eliminations, the
   * finish, the table retirement) reads the live tableIds, so the table follows
   * it with no second listener. Before, tables were only ever removed.
   * false = not added.
   */
  addTable(tournamentId: string, tableId: string): boolean {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.status !== 'running' || !tableId || t.tableIds.includes(tableId)) return false;
    t.tableIds = [...t.tableIds, tableId];
    return true;
  }

  /** Get alive (non-eliminated) player count */
  getAliveCount(tournamentId: string): number {
    const t = this.tournaments.get(tournamentId);
    if (!t) return 0;
    return t.players.filter(p => !p.eliminated).length;
  }

  /** Get count of active tables */
  getActiveTableCount(tournamentId: string): number {
    return this.tournaments.get(tournamentId)?.tableIds.length || 0;
  }

  /** Get alive players on a specific table */
  getAlivePlayersOnTable(tournamentId: string, tableId: string): TournamentPlayer[] {
    const t = this.tournaments.get(tournamentId);
    if (!t) return [];
    return t.players.filter(p => !p.eliminated && t.playerTableMap.get(p.playerId) === tableId);
  }

  /** Minimum players per table when multiple tables are in play */
  static readonly MIN_TABLE_PLAYERS = 5;

  /**
   * Check if tables should be combined and return the table to break.
   *
   * Rules:
   * 1. If total alive players fit in fewer tables, break the smallest.
   * 2. Any table with fewer than MIN_TABLE_PLAYERS (5) must be broken
   *    when multiple tables are still in play.
   * 3. The final table (only 1 table left) plays with any number of players.
   *
   * 2026-10-10 (P1) — CAPACITY. A table is broken ONLY when the other tables'
   * free seats can hold every player it would move: before this, Rule 2 broke
   * any table under 5 without looking (TA 6 / TB 4 alive: TB's 4 players met 3
   * free seats on TA — one was left seatless while still alive, and the
   * tournament could never finish). `freeSeatsOf(tableId)` = the seats a moved
   * player could take there RIGHT NOW (index.ts counts empty seats plus busted
   * seats it stands up before placing); without it, 9 minus the alive players
   * mapped to that table. When no table can be broken this returns null: the
   * short table plays on short-handed until a bust elsewhere frees seats.
   */
  checkRebalance(tournamentId: string, freeSeatsOf?: (tableId: string) => number): {
    breakTableId: string;
    playersToMove: { playerId: string; playerName: string }[];
  } | null {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.tableIds.length <= 1) return null;

    const alive = this.getAliveCount(tournamentId);
    const tableCount = t.tableIds.length;
    const threshold = (tableCount - 1) * 9;

    // Build table population list
    const tablePops: { tid: string; count: number }[] = [];
    for (const tid of t.tableIds) {
      tablePops.push({ tid, count: this.getAlivePlayersOnTable(tournamentId, tid).length });
    }
    tablePops.sort((a, b) => a.count - b.count);

    const free = new Map<string, number>();
    for (const tp of tablePops) {
      const n = freeSeatsOf ? freeSeatsOf(tp.tid) : 9 - tp.count;
      free.set(tp.tid, Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0));
    }
    /** P1 — can the OTHER tables seat every player `tp` would move? */
    const fits = (tp: { tid: string; count: number }): boolean => {
      let room = 0;
      for (const [tid, n] of free) if (tid !== tp.tid) room += n;
      return room >= tp.count;
    };
    const breakOf = (tp: { tid: string }) => ({
      breakTableId: tp.tid,
      playersToMove: this.getAlivePlayersOnTable(tournamentId, tp.tid)
        .map(p => ({ playerId: p.playerId, playerName: p.playerName })),
    });

    // Rule 1: can we fit everyone in fewer tables?
    if (alive <= threshold) {
      const smallest = tablePops[0];
      if (smallest && fits(smallest)) return breakOf(smallest);
    }

    // Rule 2: any table with < 5 players must be broken (unless it's the final
    // table) — the smallest one whose players the other tables can seat.
    if (tableCount > 1) {
      for (const tp of tablePops) {
        if (tp.count > 0 && tp.count < TournamentManager.MIN_TABLE_PLAYERS && fits(tp)) return breakOf(tp);
      }
    }

    return null;
  }

  /** Set turbo mode for fast AI */
  setTurboMode(tournamentId: string, turbo: boolean): void {
    const t = this.tournaments.get(tournamentId);
    if (t) t.turboMode = turbo;
  }

  isTurboMode(tournamentId: string): boolean {
    return this.tournaments.get(tournamentId)?.turboMode || false;
  }

  /** Get tournament summary for overlay display */
  getTournamentStatus(tournamentId: string): {
    totalPlayers: number;
    alivePlayers: number;
    tables: number;
    blindLevel: number;
    blinds: { sb: number; bb: number; ante: number } | null;
    turbo: boolean;
  } | null {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;
    const blinds = t.config.blindLevels[t.currentBlindLevel] || null;
    return {
      totalPlayers: t.players.length,
      alivePlayers: this.getAliveCount(tournamentId),
      tables: t.tableIds.length || (t.tableId ? 1 : 0),
      blindLevel: t.currentBlindLevel + 1,
      blinds: blinds ? { sb: blinds.sb, bb: blinds.bb, ante: blinds.ante } : null,
      turbo: t.turboMode,
    };
  }

  /**
   * Full standings roster for the Live Bracket UI (TournamentBracket.jsx). The
   * component treats a non-null finishPosition as ELIMINATED, so we translate
   * the start/alive value 0 -> null. TournamentPlayer.chips is start-only, so we
   * resolve each alive player's LIVE stack from their seat via playerTableMap +
   * tableManager. Eliminated players report 0.
   */
  getTournamentStandings(tournamentId: string, tableManager: any): {
    tournamentId: string;
    name: string;
    status: TournamentStatus;
    eliminationOrder: string[];
    players: { playerId: string; playerName: string; chipCount: number; finishPosition: number | null }[];
  } | null {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;
    const players = t.players.map((p) => {
      const eliminated = !!p.eliminated || (p.finishPosition && p.finishPosition > 0);
      let chipCount = 0;
      if (!eliminated) {
        // 2026-10-21 (gameplay F94) — a SINGLE-table tournament never maps its
        // players (playerTableMap stays empty; only `tableId` is set), so every
        // alive player showed the starting stack: his table is `tableId` then.
        const tid = t.playerTableMap.get(p.playerId) ?? t.tableId ?? undefined;
        const table = tid ? tableManager?.getTable?.(tid) : null;
        // F97 — his LIVE seat first: a qualifier re-entry leaves his old busted
        // seat (occupied, eliminated, 0 chips) on the table under the same
        // playerId, and the first match showed the re-entered player at 0.
        const seats: any[] = Array.isArray(table?.seats) ? table.seats : [];
        const seat = seats.find((s: any) => s?.state === 'occupied' && !s.eliminated && s.playerId === p.playerId)
          ?? seats.find((s: any) => s?.state === 'occupied' && s.playerId === p.playerId);
        chipCount = seat?.chipCount ?? p.chips ?? 0;
      }
      return {
        playerId: p.playerId,
        playerName: p.playerName,
        chipCount,
        finishPosition: (p.finishPosition && p.finishPosition > 0) ? p.finishPosition : null,
      };
    });
    return {
      tournamentId,
      name: t.config.name,
      status: t.status,
      eliminationOrder: t.eliminationOrder || [],
      players,
    };
  }
}

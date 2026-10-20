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
    startInterval: 0, // starts when full
    blindLevels: SNG_BLIND_LEVELS,
  },
  {
    name: 'Sit & Go Turbo',
    buyIn: 250,
    prizePool: 2250,
    maxPlayers: 6,
    startInterval: 0,
    blindLevels: SNG_BLIND_LEVELS.map((l) => ({
      ...l,
      duration: Math.floor(l.duration * 0.6),
    })),
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
  private tournaments: Map<string, Tournament> = new Map();
  private eventCallbacks: Map<string, Array<(event: string, data: any) => void>> = new Map();

  constructor() {
    this.createTemplateTournaments();
  }

  private createTemplateTournaments(): void {
    for (const template of TOURNAMENT_TEMPLATES) {
      this.createTournament(template);
    }
  }

  createTournament(template: TournamentTemplate): string {
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
    };

    this.tournaments.set(tournamentId, tournament);
    return tournamentId;
  }

  /** R2 — a tournament is gone for good: its record AND its event listeners (they used to leak, one set per tournament). */
  private dropTournament(tournamentId: string): void {
    this.tournaments.delete(tournamentId);
    this.eventCallbacks.delete(tournamentId);
  }

  /** R2 — the template this tournament re-creates after it ends (templates only; ad-hoc tournaments are not resurrected). */
  private templateOf(t: Tournament): TournamentTemplate | undefined {
    return TOURNAMENT_TEMPLATES.find((x) => x.name === t.config.name);
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
        nextStartTime: t.nextStartTime,
        currentBlinds: t.status === 'running' ? { sb: currentBlinds.sb, bb: currentBlinds.bb, ante: currentBlinds.ante } : null,
        blindLevel: t.currentBlindLevel + 1,
        blindLevelCount: t.config.blindLevels.length,
      });
    }
    return list;
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
    if (t.players.some((p) => p.playerId === playerId)
        || this.entryOfAccount(tournamentId, { userId: identity.userId, masterUserId: identity.masterUserId ?? null })) return null;
    const tp: TournamentPlayer = {
      playerId, playerName, socketId, chips, eliminated: false, finishPosition: 0, bounties: 0, bountyEarnings: 0,
      ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
      ...(identity.masterUserId ? { masterUserId: identity.masterUserId } : {}),
      entryId: uuidv4(), registeredAt: Date.now(),
    };
    t.players.push(tp);
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
    if (t.players.length < before) this.shiftBustedPlaces(t, null, -1);
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
    const STALL_MS = 30 * 60 * 1000; // 30 min
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
        this.createTournament(template);
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

    return { success: true, startingChips, blinds: firstLevel };
  }

  private scheduleBlindUp(tournamentId: string): void {
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

    tournament.blindTimer = setTimeout(() => {
      this.advanceBlindLevel(tournamentId);
    }, currentLevel.duration * 1000);
    (tournament.blindTimer as any)?.unref?.();   // R2 — a blind clock never holds the process open
  }

  private advanceBlindLevel(tournamentId: string): void {
    this.doAdvanceLevel(tournamentId);
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
    this.emitEvent(tournamentId, 'blindLevelUp', {
      level: tournament.currentBlindLevel + 1,
      sb: newLevel.sb,
      bb: newLevel.bb,
      ante: newLevel.ante,
    });

    this.scheduleBlindUp(tournamentId);
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
  // clock; index.ts holds the tables at the next hand boundary. Resuming re-arms
  // the clock (v1: resets the current level's timer to a full duration — a
  // precise remaining-time pause would need levelStartedAt tracking). Returns
  // false if the tournament isn't running.
  pauseTournament(tournamentId: string, paused: boolean): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') return false;
    // 2026-07-07 review fix — no-op if already in the requested state. Without
    // this, a redundant resume (paused already false) would call scheduleBlindUp
    // on a running tournament and (pre-clearTimeout-fix) leak/duplicate the timer.
    if (tournament.paused === paused) return true;
    if (paused) {
      if (tournament.blindTimer) { clearTimeout(tournament.blindTimer); tournament.blindTimer = null; }
      tournament.paused = true;
      this.emitEvent(tournamentId, 'tournamentPaused', { tournamentId });
    } else {
      tournament.paused = false;
      this.scheduleBlindUp(tournamentId);
      this.emitEvent(tournamentId, 'tournamentResumed', { tournamentId });
    }
    return true;
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

    this.emitEvent(tournamentId, 'tournamentFinished', {
      tournamentId,
      results,
    });

    // Re-create the tournament for next round after a delay
    const recreate = setTimeout(() => {
      const template = this.templateOf(tournament);
      if (template) {
        this.dropTournament(tournamentId);
        this.createTournament(template);
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
        const tid = t.playerTableMap.get(p.playerId);
        const table = tid ? tableManager?.getTable?.(tid) : null;
        const seat = table?.seats?.find((s: any) => s.playerId === p.playerId);
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

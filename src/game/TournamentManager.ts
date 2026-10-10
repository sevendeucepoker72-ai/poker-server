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
    };

    this.tournaments.set(tournamentId, tournament);
    return tournamentId;
  }

  getTournamentList(): object[] {
    const list: object[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status === 'cancelled') continue; // don't surface cancelled tournaments
      const currentBlinds = t.config.blindLevels[t.currentBlindLevel] || t.config.blindLevels[0];
      const isFreeroll = (t.config.buyIn || 0) === 0;
      list.push({
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

  registerPlayer(
    tournamentId: string, playerId: string, playerName: string, socketId: string, userId?: number,
    /** F4 (2026-10-10) — the entrant's attested MASTER id (qualifier registrations); identity only, never paid by it. */
    masterUserId?: string,
  ): { success: boolean; error?: string } {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return { success: false, error: 'Tournament not found' };
    if (tournament.status !== 'registering') return { success: false, error: 'Tournament not open for registration' };
    if (tournament.players.length >= tournament.config.maxPlayers) return { success: false, error: 'Tournament is full' };
    if (tournament.players.some((p) => p.playerId === playerId)) return { success: false, error: 'Already registered' };

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
    });

    // 2026-06-11 tournament economy: a PAYING human entrant (has a userId and
    // the table has a buy-in) funds the prize pool by exactly their entry fee.
    // The caller (registerTournament in index.ts) has already deducted this
    // from their wallet before calling — keep the two in lockstep so the pool
    // equals real collected chips (Σpayouts ≤ Σcollected ⇒ never mints).
    if (userId !== undefined && tournament.config.buyIn > 0) {
      tournament.collectedEntryFees += tournament.config.buyIn;
    }

    return { success: true };
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
    return tournament.players.length < before;
  }

  /**
   * Find buy-in tournaments STUCK in registration that can never start, so the
   * caller can cancel + refund every entrant (2026-07-01 audit #3 — otherwise a
   * tournament that never reaches its start threshold leaves entry fees debited
   * with no reclaim). Only flags tournaments with a real entry fee and ≥1
   * registrant. Two stall shapes:
   *   - timed (startInterval > 0): past nextStartTime + grace with < 2 players.
   *   - on-demand (startInterval === 0): older than STALL_MS and still below the
   *     min(4, maxPlayers) start threshold.
   */
  checkStalledTournaments(): string[] {
    const STALL_MS = 30 * 60 * 1000; // 30 min
    const GRACE_MS = 5 * 60 * 1000;  // 5 min past the scheduled start
    const now = Date.now();
    const stalled: string[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.status !== 'registering') continue;
      if ((t.config.buyIn || 0) <= 0) continue;   // nothing to refund
      if (t.players.length === 0) continue;         // nobody to strand
      if (t.config.startInterval > 0) {
        if (now >= t.nextStartTime + GRACE_MS && t.players.length < 2) stalled.push(id);
      } else {
        const threshold = Math.min(4, t.config.maxPlayers);
        if (now - t.createdAt >= STALL_MS && t.players.length < threshold) stalled.push(id);
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

    // B1 fix (2026-07-01 review): recreate the template for the next round so a
    // stalled-and-cancelled tournament REAPPEARS in the lobby — otherwise the
    // type is filtered out of getTournamentList forever (until process restart).
    // Mirrors finishTournament's recreate; gated on a real template name so
    // ad-hoc qualifier/simulated tournaments are NOT resurrected.
    const template = TOURNAMENT_TEMPLATES.find((t) => t.name === tournament.config.name);
    if (template) {
      setTimeout(() => {
        this.tournaments.delete(tournamentId);
        this.createTournament(template);
      }, 10000);
    }

    return registrants;
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
    // Manual start: when full or has enough players
    return tournament.players.length >= Math.min(4, tournament.config.maxPlayers);
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

  private finishTournament(tournamentId: string): { finished: boolean; position: number; payout: number } | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return null;

    tournament.status = 'finished';
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
    const payouts: Record<number, number> = {
      1: Math.floor(prizePool * 0.50),
      2: Math.floor(prizePool * 0.30),
      3: Math.floor(prizePool * 0.20),
    };

    const results = tournament.players.map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      position: p.finishPosition,
      // 2026-10-09 — a disqualified entrant (suspended mid-tournament) is paid
      // nothing; his position's share stays unpaid (no redistribution, no mint).
      payout: p.disqualified ? 0 : (payouts[p.finishPosition] || 0),
      userId: p.userId,
      ...(p.disqualified ? { disqualified: true } : {}),
    }));

    this.emitEvent(tournamentId, 'tournamentFinished', {
      tournamentId,
      results,
    });

    // Re-create the tournament for next round after a delay
    setTimeout(() => {
      const template = TOURNAMENT_TEMPLATES.find((t) => t.name === tournament.config.name);
      if (template) {
        this.tournaments.delete(tournamentId);
        this.createTournament(template);
      }
    }, 10000);

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

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
}

export type TournamentStatus = 'registering' | 'running' | 'finished';

export interface Tournament {
  config: TournamentConfig;
  status: TournamentStatus;
  players: TournamentPlayer[];
  currentBlindLevel: number;
  blindTimer: NodeJS.Timeout | null;
  nextStartTime: number; // timestamp
  tableId: string | null;
  tableIds: string[]; // multi-table: all active table IDs
  startedAt: number;
  eliminationOrder: string[]; // playerIds in elimination order
  turboMode: boolean; // fast AI actions for stress testing
  playerTableMap: Map<string, string>; // playerId → tableId mapping
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
    };

    const now = Date.now();
    const tournament: Tournament = {
      config,
      status: 'registering',
      players: [],
      currentBlindLevel: 0,
      blindTimer: null,
      nextStartTime: template.startInterval > 0 ? now + template.startInterval : 0,
      tableId: null,
      tableIds: [],
      startedAt: 0,
      eliminationOrder: [],
      turboMode: false,
      playerTableMap: new Map(),
    };

    this.tournaments.set(tournamentId, tournament);
    return tournamentId;
  }

  getTournamentList(): object[] {
    const list: object[] = [];
    for (const [id, t] of this.tournaments) {
      const currentBlinds = t.config.blindLevels[t.currentBlindLevel] || t.config.blindLevels[0];
      list.push({
        tournamentId: id,
        name: t.config.name,
        buyIn: t.config.buyIn,
        prizePool: t.config.prizePool,
        maxPlayers: t.config.maxPlayers,
        registeredPlayers: t.players.length,
        status: t.status,
        nextStartTime: t.nextStartTime,
        currentBlinds: t.status === 'running' ? { sb: currentBlinds.sb, bb: currentBlinds.bb, ante: currentBlinds.ante } : null,
        blindLevel: t.currentBlindLevel + 1,
        blindLevelCount: t.config.blindLevels.length,
      });
    }
    return list;
  }

  registerPlayer(tournamentId: string, playerId: string, playerName: string, socketId: string): { success: boolean; error?: string } {
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
    });

    return { success: true };
  }

  unregisterPlayer(tournamentId: string, playerId: string): boolean {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'registering') return false;
    tournament.players = tournament.players.filter((p) => p.playerId !== playerId);
    return true;
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

    const startingChips = 1000;
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

    const currentLevel = tournament.config.blindLevels[tournament.currentBlindLevel];
    if (!currentLevel) return;

    tournament.blindTimer = setTimeout(() => {
      this.advanceBlindLevel(tournamentId);
    }, currentLevel.duration * 1000);
  }

  private advanceBlindLevel(tournamentId: string): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'running') return;

    tournament.currentBlindLevel++;
    if (tournament.currentBlindLevel >= tournament.config.blindLevels.length) {
      tournament.currentBlindLevel = tournament.config.blindLevels.length - 1;
    }

    const newLevel = tournament.config.blindLevels[tournament.currentBlindLevel];
    this.emitEvent(tournamentId, 'blindLevelUp', {
      level: tournament.currentBlindLevel + 1,
      sb: newLevel.sb,
      bb: newLevel.bb,
      ante: newLevel.ante,
    });

    this.scheduleBlindUp(tournamentId);
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

    // Calculate payouts: 1st: 50%, 2nd: 30%, 3rd: 20%
    const prizePool = tournament.config.prizePool;
    const payouts: Record<number, number> = {
      1: Math.floor(prizePool * 0.50),
      2: Math.floor(prizePool * 0.30),
      3: Math.floor(prizePool * 0.20),
    };

    const results = tournament.players.map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      position: p.finishPosition,
      payout: payouts[p.finishPosition] || 0,
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
   */
  checkRebalance(tournamentId: string): {
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

    // Rule 1: can we fit everyone in fewer tables?
    if (alive <= threshold) {
      const smallest = tablePops[0];
      if (smallest) {
        return {
          breakTableId: smallest.tid,
          playersToMove: this.getAlivePlayersOnTable(tournamentId, smallest.tid)
            .map(p => ({ playerId: p.playerId, playerName: p.playerName })),
        };
      }
    }

    // Rule 2: any table with < 5 players must be broken (unless it's the final table)
    if (tableCount > 1) {
      const underMin = tablePops.find(tp => tp.count > 0 && tp.count < TournamentManager.MIN_TABLE_PLAYERS);
      if (underMin) {
        return {
          breakTableId: underMin.tid,
          playersToMove: this.getAlivePlayersOnTable(tournamentId, underMin.tid)
            .map(p => ({ playerId: p.playerId, playerName: p.playerName })),
        };
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
}

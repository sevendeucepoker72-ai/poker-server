export interface PlayerProgress {
  playerId: string;
  /** Numeric users.id in Postgres — set by ProgressionManager.hydrateFromDB.
   *  Required for persistStars and other DB writes. May be 0 for AI / unauth. */
  userId?: number;
  playerName: string;
  level: number;
  xp: number;
  xpToNextLevel: number;
  totalHandsPlayed: number;
  handsWon: number;
  biggestPot: number;
  currentStreak: number;
  bestStreak: number;
  achievements: string[];
  dailyMissions: Mission[];
  dailyMissionsRefreshAt: number;
  chips: number;
  stars: number;
  dailyLoginStreak: number;
  lastLoginDate: string;
  lastDailyBonusClaimed: string;
  equippedCardBack: string;
  equippedTableTheme: string;
  ownedCardBacks: string[];
  ownedTableThemes: string[];
  // Detailed stats
  handsPerRank: Record<string, number>; // handRankName -> count
  actionCounts: Record<string, number>; // fold/check/call/raise/allin -> count
  chipHistory: number[]; // last 20 hand chip totals
  positionWins: Record<string, { wins: number; total: number }>; // early/middle/late/blind

  // Ranked system
  elo: number;          // ELO rating (starts at 500)
  rank: string;         // e.g. "Silver I"
  rankedWins: number;
  rankedLosses: number;
  peakElo: number;

  // Cosmetics
  ownedThemes: string[]; // theme IDs owned

  // Internal tracking not sent to client
  bluffWins: number;
  allInWins: number;
  chatMessagesSent: number;

  // ── Daily / weekly rolling stat windows (for daily/weekly achievements) ──
  // Reset lazily on first stat-touch in a new window (UTC date / week).
  dailyStats: DailyStats;
  dailyStatsDate: string;        // 'YYYY-MM-DD' UTC
  weeklyStats: WeeklyStats;
  weeklyStatsWeekStart: string;  // 'YYYY-MM-DD' UTC Sunday

  // Cached IDs of daily/weekly achievements already earned in the current
  // window — hydrated from DB on login, appended to on each new unlock.
  dailyAchievementsToday: string[];
  weeklyAchievementsThisWeek: string[];

  // Rare-hand counters (for lifetime achievements)
  straightFlushHits: number;
  fullHouseHits: number;
  quadsHits: number;
  royalFlushHits: number;
  // Tournament tracking
  tournamentsWon: number;
  tournamentsPlayed: number;
  // Variant breadth tracking for "variety" achievements
  variantsPlayed: string[];      // distinct variantIds

  /**
   * True once hydrateFromDB has completed for this progress entry.
   * The hand-complete save path MUST check this before writing xp/level
   * to Postgres — otherwise a hand that resolves before the async hydrate
   * finishes overwrites the user's real DB values with the fresh-init
   * defaults (level 1, xp 0). This was the root cause of "level resets
   * every login" reports: first hand after join kept bulldozing the
   * previous session's progress.
   */
  hydrated: boolean;
}

export interface Mission {
  id: string;
  type: MissionType;
  description: string;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  reward: { chips: number; xp: number; stars?: number };
}

export enum MissionType {
  PlayHands = 'PlayHands',
  WinHands = 'WinHands',
  WinPotOver = 'WinPotOver',
  GetHandRank = 'GetHandRank',
  PlayAllIn = 'PlayAllIn',
  WinStreak = 'WinStreak',
  FoldPreFlop = 'FoldPreFlop',
  WinWithBluff = 'WinWithBluff',
}

/** Per-day counters used by daily-achievement check functions. */
export interface DailyStats {
  handsPlayed: number;
  handsWon: number;
  chipsWon: number;            // total chips won today (sum of pot wins)
  bestPotToday: number;
  currentWinStreakToday: number;
  bluffWinsToday: number;
  allInWinsToday: number;
  variantsPlayedToday: string[];
  flushesHit: number;          // flush or better
  straightsHit: number;        // straight or better (excluding flushes)
  fullHousesHit: number;
  foldsToday: number;
  preflopRaisesToday: number;
}

/** Per-week counters — reset every Sunday 00:00 UTC. */
export interface WeeklyStats {
  handsPlayed: number;
  handsWon: number;
  chipsWonThisWeek: number;
  tournamentsWonThisWeek: number;
  daysActive: number;          // incremented once per distinct day
  lastActiveDate: string;      // 'YYYY-MM-DD' for daysActive accounting
  variantsPlayedThisWeek: string[];
  bestPotThisWeek: number;
  winStreakThisWeek: number;
}

export const emptyDailyStats = (): DailyStats => ({
  handsPlayed: 0,
  handsWon: 0,
  chipsWon: 0,
  bestPotToday: 0,
  currentWinStreakToday: 0,
  bluffWinsToday: 0,
  allInWinsToday: 0,
  variantsPlayedToday: [],
  flushesHit: 0,
  straightsHit: 0,
  fullHousesHit: 0,
  foldsToday: 0,
  preflopRaisesToday: 0,
});

export const emptyWeeklyStats = (): WeeklyStats => ({
  handsPlayed: 0,
  handsWon: 0,
  chipsWonThisWeek: 0,
  tournamentsWonThisWeek: 0,
  daysActive: 0,
  lastActiveDate: '',
  variantsPlayedThisWeek: [],
  bestPotThisWeek: 0,
  winStreakThisWeek: 0,
});

export interface PlayerProgress {
  playerId: string;
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

import {
  PlayerProgress, Mission, MissionType,
  DailyStats, WeeklyStats, emptyDailyStats, emptyWeeklyStats,
} from './PlayerProgress';
import {
  persistStars as dbPersistStars,
  loadDurableProgress,
  loadInventory,
  loadProgress as dbLoadProgress,
  recordDailyAchievement,
  recordWeeklyAchievement,
  loadTodayDailyAchievements,
  loadThisWeekWeeklyAchievements,
} from '../auth/authManager';

// ── Level / XP system (1000 levels) ─────────────────────────────────────────
// Unified curve — MUST match poker-3d/src/store/progressStore.js
// (xpRequiredForLevel) exactly or client/server levels desync.
// Formula: 100 + 35·L + 0.05·L²
//   L1→2:        135 XP
//   L100→101:  4,100 XP
//   L500→501: 30,100 XP
//   Total to L1000 ≈ 13.5M XP
export const MAX_LEVEL = 1000;
export function xpRequiredForLevel(level: number): number {
  if (level <= 0) return 100;
  if (level >= MAX_LEVEL) return Infinity;
  return Math.round(100 + 35 * level + 0.05 * level * level);
}
export function milestoneStarsBonus(level: number): number {
  if (level === 1000) return 10000;
  if (level === 500)  return 5000;
  if (level === 250)  return 2000;
  if (level === 100)  return 500;
  if (level % 100 === 0) return 300;
  if (level % 50 === 0)  return 100;
  if (level % 25 === 0)  return 40;
  if (level % 10 === 0)  return 15;
  return 0;
}

// ── Ranked / ELO constants ──────────────────────────────────────────────────
const ELO_START = 500;
const ELO_K_HIGH = 16;  // K factor once elo >= 1500
const ELO_K_LOW = 32;   // K factor below 1500

const RANK_TIERS: { name: string; min: number }[] = [
  { name: 'Champion', min: 2000 },
  { name: 'Diamond III', min: 1800 },
  { name: 'Diamond II', min: 1700 },
  { name: 'Diamond I', min: 1500 },
  { name: 'Platinum III', min: 1400 },
  { name: 'Platinum II', min: 1300 },
  { name: 'Platinum I', min: 1000 },
  { name: 'Gold III', min: 900 },
  { name: 'Gold II', min: 800 },
  { name: 'Gold I', min: 600 },
  { name: 'Silver III', min: 500 },
  { name: 'Silver II', min: 400 },
  { name: 'Silver I', min: 300 },
  { name: 'Bronze III', min: 200 },
  { name: 'Bronze II', min: 100 },
  { name: 'Bronze I', min: 0 },
];

function eloToRank(elo: number): string {
  for (const tier of RANK_TIERS) {
    if (elo >= tier.min) return tier.name;
  }
  return 'Bronze I';
}

function calcEloChange(playerElo: number, opponentElo: number, won: boolean): number {
  const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
  const k = playerElo >= 1500 ? ELO_K_HIGH : ELO_K_LOW;
  return Math.round(k * ((won ? 1 : 0) - expected));
}
import { v4 as uuidv4 } from 'uuid';

interface AchievementDef {
  id: string;
  name: string;
  description: string;
  check: (p: PlayerProgress) => boolean;
  reward: { xp: number; chips: number; stars?: number };
}

interface ProgressEvent {
  type: 'levelUp' | 'achievementUnlocked' | 'missionComplete';
  data: any;
}

// ──────────────────────────────────────────────────────────────────────
//   LIFETIME ACHIEVEMENTS — never reset. Stored in users.achievements.
// ──────────────────────────────────────────────────────────────────────
const ACHIEVEMENTS: AchievementDef[] = [
  // ── Hand count milestones
  { id: 'first_win',    name: 'First Blood',      description: 'Win your first hand',
    check: (p) => p.handsWon >= 1,              reward: { xp: 100, chips: 1000, stars: 5 } },
  { id: 'hands_100',    name: 'Card Shark',       description: 'Play 100 hands',
    check: (p) => p.totalHandsPlayed >= 100,    reward: { xp: 200, chips: 2000, stars: 10 } },
  { id: 'hands_500',    name: 'Regular',          description: 'Play 500 hands',
    check: (p) => p.totalHandsPlayed >= 500,    reward: { xp: 500, chips: 5000, stars: 25 } },
  { id: 'hands_1000',   name: 'Veteran',          description: 'Play 1,000 hands',
    check: (p) => p.totalHandsPlayed >= 1000,   reward: { xp: 1000, chips: 10000, stars: 50 } },
  { id: 'hands_5000',   name: 'Road Warrior',     description: 'Play 5,000 hands',
    check: (p) => p.totalHandsPlayed >= 5000,   reward: { xp: 3000, chips: 30000, stars: 150 } },
  { id: 'hands_10000',  name: 'Poker Lifer',      description: 'Play 10,000 hands',
    check: (p) => p.totalHandsPlayed >= 10000,  reward: { xp: 8000, chips: 80000, stars: 400 } },
  { id: 'hands_50000',  name: 'Grinder',          description: 'Play 50,000 hands',
    check: (p) => p.totalHandsPlayed >= 50000,  reward: { xp: 30000, chips: 300000, stars: 1500 } },
  { id: 'hands_100000', name: 'Iron Player',      description: 'Play 100,000 hands',
    check: (p) => p.totalHandsPlayed >= 100000, reward: { xp: 60000, chips: 700000, stars: 3000 } },

  // ── Win count milestones
  { id: 'wins_50',      name: 'Solid Winner',     description: 'Win 50 hands',
    check: (p) => p.handsWon >= 50,             reward: { xp: 300, chips: 3000, stars: 20 } },
  { id: 'wins_250',     name: 'Winning Player',   description: 'Win 250 hands',
    check: (p) => p.handsWon >= 250,            reward: { xp: 1500, chips: 15000, stars: 75 } },
  { id: 'wins_1000',    name: 'Crusher',          description: 'Win 1,000 hands',
    check: (p) => p.handsWon >= 1000,           reward: { xp: 6000, chips: 60000, stars: 300 } },
  { id: 'wins_5000',    name: 'Dominator',        description: 'Win 5,000 hands',
    check: (p) => p.handsWon >= 5000,           reward: { xp: 25000, chips: 250000, stars: 1200 } },

  // ── Pot size milestones
  { id: 'pot_10k',      name: 'Nice Score',       description: 'Win a pot of 10,000+',
    check: (p) => p.biggestPot >= 10000,        reward: { xp: 200, chips: 2000, stars: 10 } },
  { id: 'pot_50k',      name: 'High Roller',      description: 'Win a pot of 50,000+',
    check: (p) => p.biggestPot >= 50000,        reward: { xp: 500, chips: 5000, stars: 30 } },
  { id: 'pot_200k',     name: 'Whale Slayer',     description: 'Win a pot of 200,000+',
    check: (p) => p.biggestPot >= 200000,       reward: { xp: 2000, chips: 20000, stars: 100 } },
  { id: 'pot_1m',       name: 'Millionaire Pot',  description: 'Win a pot of 1,000,000+',
    check: (p) => p.biggestPot >= 1000000,      reward: { xp: 10000, chips: 100000, stars: 500 } },

  // ── Streaks
  { id: 'streak_5',     name: 'Hot Streak',       description: 'Win 5 hands in a row',
    check: (p) => p.bestStreak >= 5,            reward: { xp: 300, chips: 3000, stars: 15 } },
  { id: 'streak_10',    name: 'Unstoppable',      description: 'Win 10 hands in a row',
    check: (p) => p.bestStreak >= 10,           reward: { xp: 1000, chips: 10000, stars: 60 } },
  { id: 'streak_20',    name: 'Heater',           description: 'Win 20 hands in a row',
    check: (p) => p.bestStreak >= 20,           reward: { xp: 3000, chips: 30000, stars: 200 } },

  // ── Rare hands (counters ticked in recordHandWon)
  { id: 'straight_flush', name: 'Straight Flush', description: 'Make a straight flush',
    check: (p) => (p.straightFlushHits || 0) >= 1, reward: { xp: 2000, chips: 20000, stars: 50 } },
  { id: 'quads',          name: 'Four of a Kind', description: 'Make four of a kind',
    check: (p) => (p.quadsHits || 0) >= 1,      reward: { xp: 1000, chips: 10000, stars: 25 } },
  { id: 'full_house',     name: 'Full House',    description: 'Make a full house',
    check: (p) => (p.fullHouseHits || 0) >= 1,  reward: { xp: 200, chips: 2000, stars: 10 } },
  { id: 'royal_flush',    name: 'Royal Flush!',  description: 'Make a Royal Flush',
    check: (p) => (p.royalFlushHits || 0) >= 1, reward: { xp: 5000, chips: 50000, stars: 250 } },

  // ── Playstyle
  { id: 'bluff_10',     name: 'Bluff Master',     description: 'Win 10 hands by bluffing',
    check: (p) => p.bluffWins >= 10,            reward: { xp: 500, chips: 5000, stars: 25 } },
  { id: 'bluff_50',     name: 'Con Artist',       description: 'Win 50 hands by bluffing',
    check: (p) => p.bluffWins >= 50,            reward: { xp: 2500, chips: 25000, stars: 125 } },
  { id: 'allin_20',     name: 'All-In Warrior',   description: 'Win 20 hands all-in',
    check: (p) => p.allInWins >= 20,            reward: { xp: 400, chips: 4000, stars: 20 } },
  { id: 'allin_100',    name: 'No Fear',          description: 'Win 100 hands all-in',
    check: (p) => p.allInWins >= 100,           reward: { xp: 2500, chips: 25000, stars: 125 } },

  // ── Tournaments
  { id: 'tourney_win_1',   name: 'Champion',       description: 'Win a tournament',
    check: (p) => (p.tournamentsWon || 0) >= 1, reward: { xp: 2000, chips: 20000, stars: 100 } },
  { id: 'tourney_win_10',  name: 'Tour Grinder',   description: 'Win 10 tournaments',
    check: (p) => (p.tournamentsWon || 0) >= 10, reward: { xp: 15000, chips: 150000, stars: 750 } },
  { id: 'tourney_enter_50', name: 'Regular Entry', description: 'Enter 50 tournaments',
    check: (p) => (p.tournamentsPlayed || 0) >= 50, reward: { xp: 3000, chips: 30000, stars: 150 } },

  // ── Variety
  { id: 'all_variants',   name: 'Game Master',    description: 'Play every poker variant at least once',
    check: (p) => (p.variantsPlayed || []).length >= 6,
    reward: { xp: 3000, chips: 30000, stars: 150 } },

  // ── Social
  { id: 'social_10',    name: 'Chatty',           description: 'Send 10 chat messages',
    check: (p) => p.chatMessagesSent >= 10,     reward: { xp: 50, chips: 500, stars: 3 } },
  { id: 'social_100',   name: 'Social Butterfly', description: 'Send 100 chat messages',
    check: (p) => p.chatMessagesSent >= 100,    reward: { xp: 400, chips: 4000, stars: 20 } },

  // ── Level-gated prestige
  { id: 'lvl_25',       name: 'Silver Reached',   description: 'Reach level 25',
    check: (p) => p.level >= 25,                reward: { xp: 0, chips: 10000, stars: 50 } },
  { id: 'lvl_75',       name: 'Gold Reached',     description: 'Reach level 75',
    check: (p) => p.level >= 75,                reward: { xp: 0, chips: 30000, stars: 150 } },
  { id: 'lvl_150',      name: 'Diamond Reached',  description: 'Reach level 150',
    check: (p) => p.level >= 150,               reward: { xp: 0, chips: 100000, stars: 400 } },
  { id: 'lvl_300',      name: 'Platinum Reached', description: 'Reach level 300',
    check: (p) => p.level >= 300,               reward: { xp: 0, chips: 300000, stars: 1000 } },
  { id: 'lvl_500',      name: 'Master Reached',   description: 'Reach level 500',
    check: (p) => p.level >= 500,               reward: { xp: 0, chips: 1000000, stars: 3000 } },
  { id: 'lvl_700',      name: 'Legendary Reached', description: 'Reach level 700',
    check: (p) => p.level >= 700,               reward: { xp: 0, chips: 2500000, stars: 6000 } },
  { id: 'lvl_1000',     name: 'The Ceiling',     description: 'Reach level 1000 (max)',
    check: (p) => p.level >= 1000,              reward: { xp: 0, chips: 10000000, stars: 20000 } },
];

// ──────────────────────────────────────────────────────────────────────
//   DAILY ACHIEVEMENTS — reset every UTC 00:00. (user, ach, date) PK
//   in DB prevents double-claim. Check functions read `p.dailyStats`.
// ──────────────────────────────────────────────────────────────────────
interface WindowedAchievementDef {
  id: string;
  name: string;
  description: string;
  check: (p: PlayerProgress) => boolean;
  reward: { xp: number; chips: number; stars?: number };
}
const DAILY_ACHIEVEMENTS: WindowedAchievementDef[] = [
  { id: 'd_play_5',     name: 'Warmup',            description: 'Play 5 hands today',
    check: (p) => p.dailyStats.handsPlayed >= 5,       reward: { xp: 50, chips: 500, stars: 2 } },
  { id: 'd_play_20',    name: 'Getting Into It',   description: 'Play 20 hands today',
    check: (p) => p.dailyStats.handsPlayed >= 20,      reward: { xp: 150, chips: 1500, stars: 5 } },
  { id: 'd_play_50',    name: 'Marathon',          description: 'Play 50 hands today',
    check: (p) => p.dailyStats.handsPlayed >= 50,      reward: { xp: 400, chips: 4000, stars: 15 } },
  { id: 'd_win_3',      name: 'Morning Coffee',    description: 'Win 3 hands today',
    check: (p) => p.dailyStats.handsWon >= 3,          reward: { xp: 100, chips: 1000, stars: 4 } },
  { id: 'd_win_10',     name: 'On Fire',           description: 'Win 10 hands today',
    check: (p) => p.dailyStats.handsWon >= 10,         reward: { xp: 300, chips: 3000, stars: 12 } },
  { id: 'd_win_25',     name: 'Daily Dominance',   description: 'Win 25 hands today',
    check: (p) => p.dailyStats.handsWon >= 25,         reward: { xp: 800, chips: 8000, stars: 30 } },
  { id: 'd_streak_3',   name: 'Mini Streak',       description: 'Win 3 hands in a row today',
    check: (p) => p.dailyStats.currentWinStreakToday >= 3, reward: { xp: 100, chips: 1000, stars: 5 } },
  { id: 'd_streak_5',   name: 'Daily Heater',      description: 'Win 5 hands in a row today',
    check: (p) => p.dailyStats.currentWinStreakToday >= 5, reward: { xp: 300, chips: 3000, stars: 15 } },
  { id: 'd_pot_10k',    name: 'Big Pot',           description: 'Win a pot of 10,000+ today',
    check: (p) => p.dailyStats.bestPotToday >= 10000,   reward: { xp: 150, chips: 1500, stars: 8 } },
  { id: 'd_pot_50k',    name: 'Crusher Pot',       description: 'Win a pot of 50,000+ today',
    check: (p) => p.dailyStats.bestPotToday >= 50000,   reward: { xp: 600, chips: 6000, stars: 25 } },
  { id: 'd_bluff',      name: 'Daily Bluff',       description: 'Win a hand by bluffing today',
    check: (p) => p.dailyStats.bluffWinsToday >= 1,     reward: { xp: 100, chips: 1000, stars: 5 } },
  { id: 'd_allin',      name: 'Shove & Scoop',     description: 'Win an all-in today',
    check: (p) => p.dailyStats.allInWinsToday >= 1,     reward: { xp: 100, chips: 1000, stars: 5 } },
  { id: 'd_flush',      name: 'Flush or Better',   description: 'Hit a flush or better today',
    check: (p) => p.dailyStats.flushesHit >= 1,         reward: { xp: 100, chips: 1000, stars: 5 } },
  { id: 'd_full_house', name: 'Boat Today',        description: 'Hit a full house today',
    check: (p) => p.dailyStats.fullHousesHit >= 1,      reward: { xp: 300, chips: 3000, stars: 10 } },
  { id: 'd_variety',    name: 'Mixed Bag',         description: 'Play 3 different variants today',
    check: (p) => p.dailyStats.variantsPlayedToday.length >= 3, reward: { xp: 200, chips: 2000, stars: 10 } },
];

// ──────────────────────────────────────────────────────────────────────
//   WEEKLY ACHIEVEMENTS — reset every Sunday 00:00 UTC.
// ──────────────────────────────────────────────────────────────────────
const WEEKLY_ACHIEVEMENTS: WindowedAchievementDef[] = [
  { id: 'w_play_100',      name: 'Weekly Grinder',     description: 'Play 100 hands this week',
    check: (p) => p.weeklyStats.handsPlayed >= 100,     reward: { xp: 500, chips: 5000, stars: 25 } },
  { id: 'w_play_500',      name: 'Dedicated',          description: 'Play 500 hands this week',
    check: (p) => p.weeklyStats.handsPlayed >= 500,     reward: { xp: 2500, chips: 25000, stars: 120 } },
  { id: 'w_win_50',        name: '50 Wins',            description: 'Win 50 hands this week',
    check: (p) => p.weeklyStats.handsWon >= 50,         reward: { xp: 1500, chips: 15000, stars: 75 } },
  { id: 'w_win_200',       name: 'Top Form',           description: 'Win 200 hands this week',
    check: (p) => p.weeklyStats.handsWon >= 200,        reward: { xp: 6000, chips: 60000, stars: 300 } },
  { id: 'w_chips_100k',    name: 'Weekly Stacker',     description: 'Win 100K chips total this week',
    check: (p) => p.weeklyStats.chipsWonThisWeek >= 100000, reward: { xp: 1000, chips: 10000, stars: 50 } },
  { id: 'w_chips_1m',      name: 'Weekly Shark',       description: 'Win 1M chips total this week',
    check: (p) => p.weeklyStats.chipsWonThisWeek >= 1000000, reward: { xp: 10000, chips: 100000, stars: 500 } },
  { id: 'w_days_3',        name: 'Checking In',        description: 'Play on 3 different days this week',
    check: (p) => p.weeklyStats.daysActive >= 3,        reward: { xp: 400, chips: 4000, stars: 20 } },
  { id: 'w_days_7',        name: 'Perfect Attendance', description: 'Play every day this week',
    check: (p) => p.weeklyStats.daysActive >= 7,        reward: { xp: 3000, chips: 30000, stars: 200 } },
  { id: 'w_tournament_win', name: 'Weekly Tournament', description: 'Win a tournament this week',
    check: (p) => p.weeklyStats.tournamentsWonThisWeek >= 1, reward: { xp: 3000, chips: 30000, stars: 150 } },
  { id: 'w_variety',       name: 'Variety Pack',       description: 'Play 4+ variants this week',
    check: (p) => p.weeklyStats.variantsPlayedThisWeek.length >= 4, reward: { xp: 1500, chips: 15000, stars: 80 } },
  { id: 'w_pot_250k',      name: 'Weekly Whale',       description: 'Win a pot of 250K+ this week',
    check: (p) => p.weeklyStats.bestPotThisWeek >= 250000, reward: { xp: 2000, chips: 20000, stars: 100 } },
  { id: 'w_streak_8',      name: 'Hot Week',           description: 'Win 8 in a row this week',
    check: (p) => p.weeklyStats.winStreakThisWeek >= 8, reward: { xp: 2500, chips: 25000, stars: 120 } },
];

// Utility — UTC date and week-start in YYYY-MM-DD.
function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function utcWeekStartKey(d: Date = new Date()): string {
  const dow = d.getUTCDay();
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return sunday.toISOString().slice(0, 10);
}

const DAILY_BONUS_AMOUNTS = [500, 1000, 1500, 2500, 4000, 6000, 10000];
const MISSIONS_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

interface MissionTemplate {
  type: MissionType;
  description: string;
  target: number;
  reward: { chips: number; xp: number; stars?: number };
}

const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    type: MissionType.PlayHands,
    description: 'Play 10 hands',
    target: 10,
    reward: { chips: 500, xp: 50 },
  },
  {
    type: MissionType.WinHands,
    description: 'Win 3 hands',
    target: 3,
    reward: { chips: 1000, xp: 100 },
  },
  {
    type: MissionType.WinPotOver,
    description: 'Win a pot over 5,000',
    target: 5000,
    reward: { chips: 2000, xp: 200 },
  },
  {
    type: MissionType.PlayAllIn,
    description: 'Go All-In 3 times',
    target: 3,
    reward: { chips: 750, xp: 75 },
  },
  {
    type: MissionType.GetHandRank,
    description: 'Get a Flush or better',
    target: 5, // HandRank.Flush = 5
    reward: { chips: 1500, xp: 150 },
  },
  {
    type: MissionType.WinStreak,
    description: 'Win 3 hands in a row',
    target: 3,
    reward: { chips: 3000, xp: 300, stars: 10 },
  },
  {
    type: MissionType.PlayHands,
    description: 'Play 20 hands',
    target: 20,
    reward: { chips: 1000, xp: 100 },
  },
  {
    type: MissionType.WinHands,
    description: 'Win 5 hands',
    target: 5,
    reward: { chips: 2000, xp: 200 },
  },
  {
    type: MissionType.FoldPreFlop,
    description: 'Fold pre-flop 5 times',
    target: 5,
    reward: { chips: 500, xp: 50 },
  },
  {
    type: MissionType.WinWithBluff,
    description: 'Win with less than a pair',
    target: 1,
    reward: { chips: 1500, xp: 150 },
  },
  {
    type: MissionType.PlayAllIn,
    description: 'Go All-In 5 times',
    target: 5,
    reward: { chips: 1200, xp: 120 },
  },
  {
    type: MissionType.WinPotOver,
    description: 'Win a pot over 10,000',
    target: 10000,
    reward: { chips: 3000, xp: 300, stars: 5 },
  },
];

export class ProgressionManager {
  private progressMap: Map<string, PlayerProgress> = new Map();
  private pendingEvents: Map<string, ProgressEvent[]> = new Map();

  getOrCreateProgress(playerId: string, playerName: string, userId?: number): PlayerProgress {
    let progress = this.progressMap.get(playerId);
    if (progress) {
      progress.playerName = playerName;
      // If we now have a userId and the entry hasn't been hydrated yet, do it.
      // This ensures xp/level/achievements reflect DB state even for
      // entries that were created pre-auth.
      if (userId && !progress.userId) {
        this.hydrateFromDB(playerId, userId).catch((e) =>
          console.warn(`[ProgressionManager.getOrCreateProgress hydrate ${userId}]`, e?.message)
        );
      }
      return progress;
    }

    progress = {
      playerId,
      playerName,
      level: 1,
      xp: 0,
      xpToNextLevel: xpRequiredForLevel(1),
      totalHandsPlayed: 0,
      handsWon: 0,
      biggestPot: 0,
      currentStreak: 0,
      bestStreak: 0,
      achievements: [],
      dailyMissions: [],
      dailyMissionsRefreshAt: 0,
      chips: 10000,
      stars: 0,
      dailyLoginStreak: 0,
      lastLoginDate: '',
      lastDailyBonusClaimed: '',
      equippedCardBack: 'default',
      equippedTableTheme: 'default',
      ownedCardBacks: ['default'],
      ownedTableThemes: ['default'],
      handsPerRank: {},
      actionCounts: { fold: 0, check: 0, call: 0, raise: 0, allin: 0 },
      chipHistory: [],
      positionWins: {
        early: { wins: 0, total: 0 },
        middle: { wins: 0, total: 0 },
        late: { wins: 0, total: 0 },
        blind: { wins: 0, total: 0 },
      },
      ownedThemes: ['classic_blue'],
      elo: ELO_START,
      rank: eloToRank(ELO_START),
      rankedWins: 0,
      rankedLosses: 0,
      peakElo: ELO_START,
      bluffWins: 0,
      allInWins: 0,
      chatMessagesSent: 0,
      // Daily/weekly achievement window stats — reset lazily.
      dailyStats: emptyDailyStats(),
      dailyStatsDate: utcDateKey(),
      weeklyStats: emptyWeeklyStats(),
      weeklyStatsWeekStart: utcWeekStartKey(),
      dailyAchievementsToday: [],
      weeklyAchievementsThisWeek: [],
      // Rare-hand + tournament counters
      straightFlushHits: 0,
      fullHouseHits: 0,
      quadsHits: 0,
      royalFlushHits: 0,
      tournamentsWon: 0,
      tournamentsPlayed: 0,
      variantsPlayed: [],
      // Gate for save paths — flipped to true only after hydrateFromDB
      // completes successfully. Until then, no write should touch the
      // users row (could clobber real values with fresh-init defaults).
      hydrated: false,
    };

    this.progressMap.set(playerId, progress);
    this.generateDailyMissions(playerId);

    // Hydrate new entry from DB if userId known — this is the normal path
    // for authenticated players joining their first table in a session.
    if (userId) {
      this.hydrateFromDB(playerId, userId).catch((e) =>
        console.warn(`[ProgressionManager.getOrCreateProgress hydrate-new ${userId}]`, e?.message)
      );
    }
    return progress;
  }

  getProgress(playerId: string): PlayerProgress | undefined {
    return this.progressMap.get(playerId);
  }

  /**
   * Hydrate a player's progress entry from Postgres. Call once after auth
   * (authWithTicket, oauthLogin, etc.) so stars + durable fields reflect DB.
   * Idempotent — safe to call multiple times.
   */
  async hydrateFromDB(playerId: string, userId: number): Promise<void> {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;
    // Idempotent: short-circuit if already hydrated for this userId.
    // Prevents a late re-hydrate from clobbering mid-session gains.
    if (progress.hydrated && progress.userId === userId) return;
    progress.userId = userId;

    // ─── Hydrate xp / level / achievements / chips from users table ────────
    // Without this, every login seeds level=1 xp=0 achievements=[] in-memory
    // even though the DB already has the real values. Then the first XP gain
    // overwrites the DB with fresh-start numbers. This is the root cause of
    // "exp and achievements don't persist".
    try {
      const res = await dbLoadProgress(userId);
      if (res.success && res.userData) {
        const u = res.userData;
        if (typeof u.level === 'number' && u.level > 0) progress.level = Math.min(u.level, MAX_LEVEL);
        if (typeof u.xp === 'number' && u.xp >= 0) progress.xp = u.xp;
        progress.xpToNextLevel = xpRequiredForLevel(progress.level);
        if (Array.isArray(u.achievements)) {
          progress.achievements = Array.from(new Set([...(progress.achievements || []), ...u.achievements]));
        }
        if (typeof u.chips === 'number') progress.chips = u.chips;
        if (u.stats && typeof u.stats === 'object') {
          // Re-seed stat counters that live in PlayerProgress.
          const s: any = u.stats;
          if (typeof s.handsPlayed === 'number') progress.totalHandsPlayed = s.handsPlayed;
          if (typeof s.handsWon === 'number')    progress.handsWon = s.handsWon;
          if (typeof s.biggestPot === 'number')  progress.biggestPot = s.biggestPot;
          if (typeof s.bestStreak === 'number')  progress.bestStreak = s.bestStreak;
          if (typeof s.bluffWins === 'number')   progress.bluffWins = s.bluffWins;
          if (typeof s.allInWins === 'number')   progress.allInWins = s.allInWins;
          if (typeof s.chatMessagesSent === 'number') progress.chatMessagesSent = s.chatMessagesSent;
          // Rare-hand / tournament counters
          if (typeof s.straightFlushHits === 'number') progress.straightFlushHits = s.straightFlushHits;
          if (typeof s.fullHouseHits === 'number')     progress.fullHouseHits     = s.fullHouseHits;
          if (typeof s.quadsHits === 'number')         progress.quadsHits         = s.quadsHits;
          if (typeof s.royalFlushHits === 'number')    progress.royalFlushHits    = s.royalFlushHits;
          if (typeof s.tournamentsWon === 'number')    progress.tournamentsWon    = s.tournamentsWon;
          if (typeof s.tournamentsPlayed === 'number') progress.tournamentsPlayed = s.tournamentsPlayed;
          if (Array.isArray(s.variantsPlayed))         progress.variantsPlayed    = s.variantsPlayed;
        }
      }
    } catch (e: any) {
      console.warn(`[ProgressionManager.hydrateFromDB progress ${userId}]`, e?.message);
    }

    // Hydrate already-earned daily/weekly achievement IDs for the current
    // windows so the user doesn't re-earn them on reconnect inside the same
    // day/week. rollAchievementWindows handles future rollover naturally.
    try {
      const [todayIds, weekIds] = await Promise.all([
        loadTodayDailyAchievements(userId),
        loadThisWeekWeeklyAchievements(userId),
      ]);
      progress.dailyAchievementsToday = todayIds;
      progress.weeklyAchievementsThisWeek = weekIds;
      progress.dailyStatsDate = utcDateKey();
      progress.weeklyStatsWeekStart = utcWeekStartKey();
    } catch (e: any) {
      console.warn(`[ProgressionManager.hydrateFromDB ach-windows ${userId}]`, e?.message);
    }

    const durable = await loadDurableProgress(userId);
    if (durable) {
      progress.stars = durable.stars;
      progress.dailyLoginStreak = durable.loginStreak;
      // Don't clobber equippedCardBack / equippedTableTheme here — those are
      // sourced from user_inventory via loadInventory below.
    }
    const inv = await loadInventory(userId);
    if (inv.length > 0) {
      const cardBacks = inv.filter((r) => r.item_type === 'card_back').map((r) => r.item_id);
      const themes    = inv.filter((r) => r.item_type === 'theme').map((r) => r.item_id);
      const equippedCB = inv.find((r) => r.item_type === 'card_back' && r.equipped)?.item_id;
      const equippedTheme = inv.find((r) => r.item_type === 'theme' && r.equipped)?.item_id;
      if (cardBacks.length > 0) progress.ownedCardBacks = Array.from(new Set([...progress.ownedCardBacks, ...cardBacks]));
      if (themes.length > 0) progress.ownedThemes = Array.from(new Set([...progress.ownedThemes, ...themes]));
      if (equippedCB) progress.equippedCardBack = equippedCB;
      if (equippedTheme) progress.equippedTableTheme = equippedTheme;
    }
    // Flip hydrated LAST — all DB reads complete, safe to save now.
    progress.hydrated = true;
  }

  /** Push the current stars balance to Postgres. Fire-and-forget. */
  private persistStars(progress: PlayerProgress): void {
    if (!progress.userId) return;
    dbPersistStars(progress.userId, progress.stars).catch((e) =>
      console.warn(`[ProgressionManager.persistStars ${progress.userId}]`, e?.message)
    );
  }

  // Consume pending events (levelUp, achievements, missionComplete)
  consumeEvents(playerId: string): ProgressEvent[] {
    const events = this.pendingEvents.get(playerId) || [];
    this.pendingEvents.delete(playerId);
    return events;
  }

  private pushEvent(playerId: string, event: ProgressEvent): void {
    if (!this.pendingEvents.has(playerId)) {
      this.pendingEvents.set(playerId, []);
    }
    this.pendingEvents.get(playerId)!.push(event);
  }

  addXP(playerId: string, amount: number): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;
    if (progress.level >= MAX_LEVEL) {
      // At cap — just accumulate for stats, no further level-ups.
      progress.xp = 0;
      progress.xpToNextLevel = Infinity;
      return;
    }

    progress.xp += amount;

    while (progress.level < MAX_LEVEL && progress.xp >= progress.xpToNextLevel) {
      progress.xp -= progress.xpToNextLevel;
      progress.level++;
      progress.xpToNextLevel = xpRequiredForLevel(progress.level);

      // Reward schedule: base per-level stars + milestone bonuses.
      const baseChips = progress.level * 500;
      const baseStars = progress.level * 5;
      const bonusStars = milestoneStarsBonus(progress.level);
      progress.chips += baseChips;
      progress.stars += baseStars + bonusStars;
      this.persistStars(progress);

      this.pushEvent(playerId, {
        type: 'levelUp',
        data: {
          newLevel: progress.level,
          bonusChips: baseChips,
          bonusStars: baseStars + bonusStars,
          milestoneStars: bonusStars,
          isMilestone: bonusStars > 0,
        },
      });
    }

    if (progress.level >= MAX_LEVEL) {
      progress.xp = 0;
      progress.xpToNextLevel = Infinity;
    }
  }

  recordHandPlayed(playerId: string, variantId?: string): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;

    progress.totalHandsPlayed++;
    (progress as any).lastHandAt = Date.now();

    // Track variant breadth for lifetime "all_variants" + daily/weekly buckets.
    if (variantId && !progress.variantsPlayed.includes(variantId)) {
      progress.variantsPlayed.push(variantId);
    }
    this.tickWindows(progress, 'played', { variantId });

    // Update missions
    for (const mission of progress.dailyMissions) {
      if (mission.completed || mission.claimed) continue;
      if (mission.type === MissionType.PlayHands) {
        mission.progress = Math.min(mission.progress + 1, mission.target);
        if (mission.progress >= mission.target) {
          mission.completed = true;
          this.pushEvent(playerId, {
            type: 'missionComplete',
            data: { missionId: mission.id, description: mission.description, reward: mission.reward },
          });
        }
      }
    }

    this.checkAchievements(playerId);
  }

  recordHandWon(
    playerId: string,
    potSize: number,
    handRank?: number,
    wasAllIn?: boolean
  ): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;

    progress.handsWon++;
    progress.currentStreak++;
    if (progress.currentStreak > progress.bestStreak) {
      progress.bestStreak = progress.currentStreak;
    }
    if (potSize > progress.biggestPot) {
      progress.biggestPot = potSize;
    }

    // Check bluff win (handRank < 1 means less than OnePair)
    const wasBluff = handRank !== undefined && handRank < 1;
    if (wasBluff) {
      progress.bluffWins++;
    }

    if (wasAllIn) {
      progress.allInWins++;
    }

    // Track hand rank distribution + rare-hand counters
    if (handRank !== undefined) {
      const rankNames: Record<number, string> = {
        0: 'High Card', 1: 'One Pair', 2: 'Two Pair', 3: 'Three of a Kind',
        4: 'Straight', 5: 'Flush', 6: 'Full House', 7: 'Four of a Kind',
        8: 'Straight Flush', 9: 'Royal Flush',
      };
      const rankName = rankNames[handRank] || 'Unknown';
      progress.handsPerRank[rankName] = (progress.handsPerRank[rankName] || 0) + 1;
      if (handRank === 6) progress.fullHouseHits     = (progress.fullHouseHits     || 0) + 1;
      if (handRank === 7) progress.quadsHits         = (progress.quadsHits         || 0) + 1;
      if (handRank === 8) progress.straightFlushHits = (progress.straightFlushHits || 0) + 1;
      if (handRank === 9) progress.royalFlushHits    = (progress.royalFlushHits    || 0) + 1;
    }

    // Tick daily/weekly windows for this win
    const handRankName = handRank !== undefined
      ? (['HighCard','OnePair','TwoPair','ThreeOfAKind','Straight','Flush','FullHouse','FourOfAKind','StraightFlush','RoyalFlush'][handRank] || '')
      : '';
    this.tickWindows(progress, 'won', {
      potSize,
      handRank: handRankName,
      wasAllIn,
      wasBluff,
    });

    // XP: 10 base + bonus for big pots
    let xpGain = 10;
    if (potSize >= 10000) xpGain += 20;
    else if (potSize >= 5000) xpGain += 10;
    else if (potSize >= 1000) xpGain += 5;
    this.addXP(playerId, xpGain);

    // Update missions
    for (const mission of progress.dailyMissions) {
      if (mission.completed || mission.claimed) continue;

      switch (mission.type) {
        case MissionType.WinHands:
          mission.progress = Math.min(mission.progress + 1, mission.target);
          break;
        case MissionType.WinPotOver:
          if (potSize >= mission.target) {
            mission.progress = mission.target;
          }
          break;
        case MissionType.WinStreak:
          mission.progress = Math.min(progress.currentStreak, mission.target);
          break;
        case MissionType.GetHandRank:
          if (handRank !== undefined && handRank >= mission.target) {
            mission.progress = mission.target;
          }
          break;
        case MissionType.WinWithBluff:
          if (handRank !== undefined && handRank < 1) {
            mission.progress = Math.min(mission.progress + 1, mission.target);
          }
          break;
      }

      if (mission.progress >= mission.target && !mission.completed) {
        mission.completed = true;
        this.pushEvent(playerId, {
          type: 'missionComplete',
          data: { missionId: mission.id, description: mission.description, reward: mission.reward },
        });
      }
    }

    this.checkAchievements(playerId);
  }

  recordHandLost(playerId: string): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;
    progress.currentStreak = 0;
    // Also break the within-today streak so daily streak achievements
    // reflect the latest run, not an all-time-per-day max.
    this.rollAchievementWindows(progress);
    progress.dailyStats.currentWinStreakToday = 0;
  }

  recordChipHistory(playerId: string, chipCount: number): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;
    progress.chipHistory.push(chipCount);
    if (progress.chipHistory.length > 20) {
      progress.chipHistory = progress.chipHistory.slice(-20);
    }
  }

  recordPositionResult(playerId: string, position: string, won: boolean): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;
    if (!progress.positionWins[position]) {
      progress.positionWins[position] = { wins: 0, total: 0 };
    }
    progress.positionWins[position].total++;
    if (won) {
      progress.positionWins[position].wins++;
    }
  }

  purchaseTheme(playerId: string, themeId: string, cost: number): { success: boolean; error?: string } {
    const progress = this.progressMap.get(playerId);
    if (!progress) return { success: false, error: 'Player not found' };
    if (progress.ownedThemes.includes(themeId)) return { success: false, error: 'Already owned' };
    if (progress.stars < cost) return { success: false, error: 'Not enough stars' };

    progress.stars -= cost;
    this.persistStars(progress);
    progress.ownedThemes.push(themeId);
    return { success: true };
  }

  equipTheme(playerId: string, themeId: string): { success: boolean; error?: string } {
    const progress = this.progressMap.get(playerId);
    if (!progress) return { success: false, error: 'Player not found' };
    if (!progress.ownedThemes.includes(themeId)) return { success: false, error: 'Theme not owned' };

    progress.equippedTableTheme = themeId;
    return { success: true };
  }

  /**
   * Update ELO for a head-to-head result. Call once per winner-loser pair per hand.
   * For multi-player games pass the average ELO of all other players as opponentElo.
   */
  updateElo(winnerId: string, loserId: string): void {
    const winner = this.progressMap.get(winnerId);
    const loser = this.progressMap.get(loserId);
    if (!winner || !loser) return;

    const winnerChange = calcEloChange(winner.elo, loser.elo, true);
    const loserChange = calcEloChange(loser.elo, winner.elo, false);

    winner.elo = Math.max(0, winner.elo + winnerChange);
    loser.elo = Math.max(0, loser.elo + loserChange);

    if (winner.elo > winner.peakElo) winner.peakElo = winner.elo;

    winner.rank = eloToRank(winner.elo);
    loser.rank = eloToRank(loser.elo);

    winner.rankedWins++;
    loser.rankedLosses++;
  }

  getDetailedStats(playerId: string): object | null {
    const progress = this.progressMap.get(playerId);
    if (!progress) return null;

    return {
      ...this.getClientProgress(playerId),
      handsPerRank: progress.handsPerRank,
      actionCounts: progress.actionCounts,
      chipHistory: progress.chipHistory,
      positionWins: progress.positionWins,
      winRate: progress.totalHandsPlayed > 0
        ? ((progress.handsWon / progress.totalHandsPlayed) * 100).toFixed(1)
        : '0.0',
      ownedThemes: progress.ownedThemes,
      bluffWins: progress.bluffWins,
      allInWins: progress.allInWins,
    };
  }

  recordAction(
    playerId: string,
    action: string,
    context?: { phase?: string; handRank?: number }
  ): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;

    // Track action counts for stats
    if (action === 'fold' || action === 'check' || action === 'call' || action === 'raise' || action === 'allIn') {
      const key = action === 'allIn' ? 'allin' : action;
      progress.actionCounts[key] = (progress.actionCounts[key] || 0) + 1;
    }

    if (action === 'allIn') {
      for (const mission of progress.dailyMissions) {
        if (mission.completed || mission.claimed) continue;
        if (mission.type === MissionType.PlayAllIn) {
          mission.progress = Math.min(mission.progress + 1, mission.target);
          if (mission.progress >= mission.target && !mission.completed) {
            mission.completed = true;
            this.pushEvent(playerId, {
              type: 'missionComplete',
              data: { missionId: mission.id, description: mission.description, reward: mission.reward },
            });
          }
        }
      }
    }

    if (action === 'fold' && context?.phase === 'PreFlop') {
      for (const mission of progress.dailyMissions) {
        if (mission.completed || mission.claimed) continue;
        if (mission.type === MissionType.FoldPreFlop) {
          mission.progress = Math.min(mission.progress + 1, mission.target);
          if (mission.progress >= mission.target && !mission.completed) {
            mission.completed = true;
            this.pushEvent(playerId, {
              type: 'missionComplete',
              data: { missionId: mission.id, description: mission.description, reward: mission.reward },
            });
          }
        }
      }
    }

    if (action === 'chat') {
      progress.chatMessagesSent++;
      this.checkAchievements(playerId);
    }
  }

  recordRoyalFlush(playerId: string): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;

    if (!progress.achievements.includes('royal_flush')) {
      const achDef = ACHIEVEMENTS.find((a) => a.id === 'royal_flush');
      if (achDef) {
        progress.achievements.push('royal_flush');
        progress.chips += achDef.reward.chips;
        progress.stars += (achDef.reward.stars || 0);
        this.persistStars(progress);
        this.addXP(playerId, achDef.reward.xp);

        this.pushEvent(playerId, {
          type: 'achievementUnlocked',
          data: {
            id: achDef.id,
            name: achDef.name,
            description: achDef.description,
            reward: achDef.reward,
          },
        });
      }
    }
  }

  generateDailyMissions(playerId: string): Mission[] {
    const progress = this.progressMap.get(playerId);
    if (!progress) return [];

    // Shuffle and pick 3 unique mission types
    const shuffled = [...MISSION_TEMPLATES].sort(() => Math.random() - 0.5);
    const selected: MissionTemplate[] = [];
    const usedTypes = new Set<string>();

    for (const template of shuffled) {
      const key = `${template.type}_${template.target}`;
      if (!usedTypes.has(key) && selected.length < 3) {
        usedTypes.add(key);
        selected.push(template);
      }
    }

    progress.dailyMissions = selected.map((t) => ({
      id: uuidv4(),
      type: t.type,
      description: t.description,
      target: t.target,
      progress: 0,
      completed: false,
      claimed: false,
      reward: { ...t.reward },
    }));

    progress.dailyMissionsRefreshAt = Date.now() + MISSIONS_REFRESH_INTERVAL;

    return progress.dailyMissions;
  }

  getDailyMissions(playerId: string): Mission[] {
    const progress = this.progressMap.get(playerId);
    if (!progress) return [];

    // Check if missions need refreshing
    if (Date.now() >= progress.dailyMissionsRefreshAt || progress.dailyMissions.length === 0) {
      return this.generateDailyMissions(playerId);
    }

    return progress.dailyMissions;
  }

  claimMissionReward(playerId: string, missionId: string): { success: boolean; reward?: { chips: number; xp: number; stars?: number } } {
    const progress = this.progressMap.get(playerId);
    if (!progress) return { success: false };

    const mission = progress.dailyMissions.find((m) => m.id === missionId);
    if (!mission) return { success: false };
    if (!mission.completed || mission.claimed) return { success: false };

    mission.claimed = true;
    progress.chips += mission.reward.chips;
    if (mission.reward.stars) {
      progress.stars += mission.reward.stars;
      this.persistStars(progress);
    }
    this.addXP(playerId, mission.reward.xp);

    return { success: true, reward: mission.reward };
  }

  claimDailyBonus(playerId: string): { success: boolean; chips?: number; stars?: number; streak?: number } {
    const progress = this.progressMap.get(playerId);
    if (!progress) return { success: false };

    const today = new Date().toISOString().split('T')[0];

    if (progress.lastDailyBonusClaimed === today) {
      return { success: false };
    }

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    if (progress.lastLoginDate === yesterday) {
      progress.dailyLoginStreak = Math.min(progress.dailyLoginStreak + 1, 7);
    } else if (progress.lastLoginDate !== today) {
      progress.dailyLoginStreak = 1;
    }

    progress.lastLoginDate = today;
    progress.lastDailyBonusClaimed = today;

    const streakIndex = Math.min(progress.dailyLoginStreak - 1, DAILY_BONUS_AMOUNTS.length - 1);
    const bonusChips = DAILY_BONUS_AMOUNTS[streakIndex];
    const bonusStars = progress.dailyLoginStreak * 5;

    progress.chips += bonusChips;
    progress.stars += bonusStars;
    this.persistStars(progress);

    return {
      success: true,
      chips: bonusChips,
      stars: bonusStars,
      streak: progress.dailyLoginStreak,
    };
  }

  checkAchievements(playerId: string): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;
    // Roll daily/weekly windows lazily so checks always run against the
    // current window — an idle user whose server process stayed up across
    // midnight UTC still gets a fresh day.
    this.rollAchievementWindows(progress);

    // Lifetime achievements
    for (const achDef of ACHIEVEMENTS) {
      if (progress.achievements.includes(achDef.id)) continue;
      if (achDef.check(progress)) {
        progress.achievements.push(achDef.id);
        progress.chips += achDef.reward.chips;
        if (achDef.reward.stars) {
          progress.stars += achDef.reward.stars;
          this.persistStars(progress);
        }
        this.addXP(playerId, achDef.reward.xp);
        this.pushEvent(playerId, {
          type: 'achievementUnlocked',
          data: {
            category: 'lifetime',
            id: achDef.id,
            name: achDef.name,
            description: achDef.description,
            reward: achDef.reward,
          },
        });
      }
    }

    // Daily achievements
    for (const achDef of DAILY_ACHIEVEMENTS) {
      if (progress.dailyAchievementsToday.includes(achDef.id)) continue;
      if (achDef.check(progress)) {
        progress.dailyAchievementsToday.push(achDef.id);
        progress.chips += achDef.reward.chips;
        if (achDef.reward.stars) {
          progress.stars += achDef.reward.stars;
          this.persistStars(progress);
        }
        this.addXP(playerId, achDef.reward.xp);
        if (progress.userId) {
          recordDailyAchievement(progress.userId, achDef.id).catch(() => {});
        }
        this.pushEvent(playerId, {
          type: 'achievementUnlocked',
          data: {
            category: 'daily',
            id: achDef.id,
            name: achDef.name,
            description: achDef.description,
            reward: achDef.reward,
          },
        });
      }
    }

    // Weekly achievements
    for (const achDef of WEEKLY_ACHIEVEMENTS) {
      if (progress.weeklyAchievementsThisWeek.includes(achDef.id)) continue;
      if (achDef.check(progress)) {
        progress.weeklyAchievementsThisWeek.push(achDef.id);
        progress.chips += achDef.reward.chips;
        if (achDef.reward.stars) {
          progress.stars += achDef.reward.stars;
          this.persistStars(progress);
        }
        this.addXP(playerId, achDef.reward.xp);
        if (progress.userId) {
          recordWeeklyAchievement(progress.userId, achDef.id).catch(() => {});
        }
        this.pushEvent(playerId, {
          type: 'achievementUnlocked',
          data: {
            category: 'weekly',
            id: achDef.id,
            name: achDef.name,
            description: achDef.description,
            reward: achDef.reward,
          },
        });
      }
    }
  }

  /** Reset dailyStats / weeklyStats lazily if the window has rolled over. */
  private rollAchievementWindows(progress: PlayerProgress): void {
    const today = utcDateKey();
    if (progress.dailyStatsDate !== today) {
      progress.dailyStats = emptyDailyStats();
      progress.dailyStatsDate = today;
      progress.dailyAchievementsToday = [];
    }
    const weekStart = utcWeekStartKey();
    if (progress.weeklyStatsWeekStart !== weekStart) {
      progress.weeklyStats = emptyWeeklyStats();
      progress.weeklyStatsWeekStart = weekStart;
      progress.weeklyAchievementsThisWeek = [];
    }
  }

  /** Call from recordHandPlayed/recordHandWon to tick per-window counters.
   *  `outcome` is 'played' for every hand, 'won' for won hands. */
  private tickWindows(
    progress: PlayerProgress,
    outcome: 'played' | 'won',
    opts: {
      potSize?: number;
      handRank?: string;  // e.g. 'Flush', 'FullHouse', 'StraightFlush', 'RoyalFlush'
      wasAllIn?: boolean;
      wasBluff?: boolean;
      variantId?: string;
    } = {},
  ): void {
    this.rollAchievementWindows(progress);
    const d = progress.dailyStats;
    const w = progress.weeklyStats;
    const today = progress.dailyStatsDate;

    if (outcome === 'played') {
      d.handsPlayed++;
      w.handsPlayed++;
      if (opts.variantId) {
        if (!d.variantsPlayedToday.includes(opts.variantId)) d.variantsPlayedToday.push(opts.variantId);
        if (!w.variantsPlayedThisWeek.includes(opts.variantId)) w.variantsPlayedThisWeek.push(opts.variantId);
      }
      if (w.lastActiveDate !== today) {
        w.lastActiveDate = today;
        w.daysActive = Math.min(7, (w.daysActive || 0) + 1);
      }
    } else if (outcome === 'won') {
      d.handsWon++;
      d.currentWinStreakToday++;
      w.handsWon++;
      const p = Math.max(0, opts.potSize || 0);
      d.chipsWon += p;
      w.chipsWonThisWeek += p;
      if (p > d.bestPotToday) d.bestPotToday = p;
      if (p > w.bestPotThisWeek) w.bestPotThisWeek = p;
      if (opts.wasAllIn) d.allInWinsToday++;
      if (opts.wasBluff) d.bluffWinsToday++;
      const rank = (opts.handRank || '').toLowerCase();
      if (rank.includes('flush')) d.flushesHit++;
      if (rank.includes('straight')) d.straightsHit++;
      if (rank.includes('fullhouse') || rank.includes('full')) d.fullHousesHit++;
      // Best streak-this-week tracked from currentStreak.
      if (progress.currentStreak > w.winStreakThisWeek) w.winStreakThisWeek = progress.currentStreak;
    }
  }

  /** Full achievement listing for the UI panel — combines all 3 buckets
   *  with per-entry unlocked flag, current progress hint, and reward.
   *  Safe to call even before hydration (returns all locked). */
  getAchievementsSummary(playerId: string): {
    daily: any[]; weekly: any[]; lifetime: any[];
    windowEndsAt: { daily: number; weekly: number };
  } | null {
    const progress = this.progressMap.get(playerId);
    if (!progress) return null;
    this.rollAchievementWindows(progress);

    const now = new Date();
    const dailyEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const weekEnd = dailyEnd + (6 - now.getUTCDay()) * 24 * 60 * 60 * 1000;

    const summarize = (
      defs: WindowedAchievementDef[] | AchievementDef[],
      earnedIds: string[],
    ) => defs.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      reward: def.reward,
      unlocked: earnedIds.includes(def.id),
      // Running check lets the panel show a ✓ even before the sync tick.
      progressMet: (def as any).check ? (def as any).check(progress) : false,
    }));

    return {
      daily:    summarize(DAILY_ACHIEVEMENTS,    progress.dailyAchievementsToday),
      weekly:   summarize(WEEKLY_ACHIEVEMENTS,   progress.weeklyAchievementsThisWeek),
      lifetime: summarize(ACHIEVEMENTS,          progress.achievements),
      windowEndsAt: { daily: dailyEnd, weekly: weekEnd },
    };
  }

  // Returns a sanitized version for sending to client (no internal tracking fields)
  getClientProgress(playerId: string): object | null {
    const progress = this.progressMap.get(playerId);
    if (!progress) return null;

    return {
      playerId: progress.playerId,
      playerName: progress.playerName,
      hydrated: progress.hydrated,
      level: progress.level,
      xp: progress.xp,
      xpToNextLevel: progress.xpToNextLevel,
      totalHandsPlayed: progress.totalHandsPlayed,
      handsWon: progress.handsWon,
      biggestPot: progress.biggestPot,
      currentStreak: progress.currentStreak,
      bestStreak: progress.bestStreak,
      achievements: progress.achievements,
      dailyMissions: progress.dailyMissions,
      dailyMissionsRefreshAt: progress.dailyMissionsRefreshAt,
      chips: progress.chips,
      stars: progress.stars,
      dailyLoginStreak: progress.dailyLoginStreak,
      lastLoginDate: progress.lastLoginDate,
      lastDailyBonusClaimed: progress.lastDailyBonusClaimed,
      equippedCardBack: progress.equippedCardBack,
      equippedTableTheme: progress.equippedTableTheme,
      ownedCardBacks: progress.ownedCardBacks,
      ownedTableThemes: progress.ownedTableThemes,
      ownedThemes: progress.ownedThemes,
      dailyAchievementsToday: progress.dailyAchievementsToday,
      weeklyAchievementsThisWeek: progress.weeklyAchievementsThisWeek,
      handsPerRank: progress.handsPerRank,
      actionCounts: progress.actionCounts,
      chipHistory: progress.chipHistory,
      positionWins: progress.positionWins,
      elo: progress.elo,
      rank: progress.rank,
      rankedWins: progress.rankedWins,
      rankedLosses: progress.rankedLosses,
      peakElo: progress.peakElo,
    };
  }
}

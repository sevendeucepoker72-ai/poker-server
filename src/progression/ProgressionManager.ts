import {
  PlayerProgress, Mission, MissionType,
  emptyDailyStats, emptyWeeklyStats,
} from './PlayerProgress';
import {
  addChipsToUser as dbAddChipsToUser,
  addStarsToUser as dbAddStarsToUser,
  mergeUserStats as dbMergeUserStats,
} from '../auth/authManager';
import {
  loadProgressBundle, settleAchievementReward, settleLevelUps,
  type ProgressBundle, type AchievementCategory, type Balances,
} from '../economy/economyDb';
import {
  missionTemplateIdsFor, applyMissionProgress, missionRows, emptyMissionDay, missionTemplate, parseMissionId,
  type MissionDayState,
} from './missions';
import { mergeProgressStats } from './progressMerge';
import { denverDateKey, nextDenverMidnightMs, denverMonthKey } from '../economy/denverTime';
import {
  vipTierForSeasonXp, VIP_EMOTES, FREE_EMOTES, VIP_PASS_PERKS, VIP_MONTHLY_BONUS_CHIPS, VIP_LOGIN_MULTIPLIER,
  SHOP_PRICES, itemKey, normalizeItemType, CHIP_BOOSTED_REWARDS,
} from '../economy/catalog';

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

/**
 * 2026-10-09 (D2, guest carry-over) — the LIFETIME achievement ids that
 * reaching `toLevel` unlocks which `fromLevel` did not, by level ALONE (every
 * other counter held at zero). The carry-over raises the caller's level by
 * ratchet; the achievements this returns are written as ALREADY EARNED so
 * checkAchievements never re-pays a level reward the guest already received
 * (its chips are in the wallet that moved). Derived from ACHIEVEMENTS'
 * own check functions, so a new level-gated achievement is covered without
 * touching this. Never throws.
 */
export function lifetimeAchievementsUnlockedByLevel(fromLevel: number, toLevel: number): string[] {
  const clampLevel = (v: number) => Math.min(MAX_LEVEL, Math.max(0, Math.floor(Number(v) || 0)));
  // Every field other than `level` reads as 0, so only level can satisfy a check.
  const probe = (level: number) => new Proxy({ level } as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : 0),
  }) as unknown as PlayerProgress;
  const lo = probe(clampLevel(fromLevel));
  const hi = probe(clampLevel(toLevel));
  const out: string[] = [];
  for (const def of ACHIEVEMENTS) {
    let atHi = false;
    let atLo = false;
    try { atHi = !!def.check(hi); atLo = !!def.check(lo); } catch { continue; }
    if (atHi && !atLo) out.push(def.id);
  }
  return out;
}

/**
 * 2026-10-10 (account merge) — every LIFETIME achievement a stored state
 * already satisfies. `state` is shaped like PlayerProgress (level,
 * totalHandsPlayed, handsWon, biggestPot, …); missing fields read as 0.
 *
 * Used by the one-time account merge (auth/accountMerge.ts) and its
 * achievement backfill: a saveProgress bug (2026-06-19..10-10) paid achievement
 * rewards but never stored the achievement id, and a merge SUMS counters /
 * takes the other row's level — either way checkAchievements would pay a
 * reward again on the next hand. Marking every satisfied achievement as earned
 * closes that, the same rule the guest carry-over applies (D2). Derived from
 * ACHIEVEMENTS' own checks, so a new achievement is covered automatically.
 * Never throws.
 */
export function lifetimeAchievementsSatisfiedBy(state: Record<string, unknown>): string[] {
  const probe = new Proxy({ ...state } as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : 0),
  }) as unknown as PlayerProgress;
  const out: string[] = [];
  for (const def of ACHIEVEMENTS) {
    try { if (def.check(probe)) out.push(def.id); } catch { /* a check that cannot run is not satisfied */ }
  }
  return out;
}

/**
 * 2026-10-09 (D2) — the most xp a player can legitimately hold AT `level`
 * (one short of the next level-up; 0 at MAX_LEVEL). The carry-over clamps the
 * guest's xp to it: an inflated xp would otherwise walk the next addXP through
 * the level-up loop, paying level * 500 chips per level.
 */
export function maxXpAtLevel(level: number): number {
  const l = Math.floor(Number(level) || 0);
  if (l >= MAX_LEVEL) return 0;
  return Math.max(0, xpRequiredForLevel(Math.max(1, l)) - 1);
}

/** Cumulative ("season") XP of (level, xp in level) — the Battle Pass / VIP-tier XP. */
export function seasonXpOf(level: number, xp: number): number {
  let total = Math.max(0, Number(xp) || 0);
  const lv = Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(level) || 1)));
  for (let l = 1; l < lv; l++) {
    const req = xpRequiredForLevel(l);
    if (!Number.isFinite(req)) break;
    total += req;
  }
  return total;
}

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

// Utility — UTC date and week-start in YYYY-MM-DD (the achievement windows).
function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function utcWeekStartKey(d: Date = new Date()): string {
  const dow = d.getUTCDay();
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return sunday.toISOString().slice(0, 10);
}

// ── 2026-10-11 (.online R2) — the per-USER record ────────────────────────────

/** The canonical progress key of an account. Every seat's playerId of that account is an ALIAS of it. */
export const userProgressKey = (userId: number): string => `user-${userId}`;
const validUserId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** stats key ↔ PlayerProgress field, for counters that grow by events. */
const ADDITIVE_COUNTERS: ReadonlyArray<[string, keyof PlayerProgress]> = [
  ['handsPlayed', 'totalHandsPlayed'], ['handsWon', 'handsWon'], ['bluffWins', 'bluffWins'], ['allInWins', 'allInWins'],
  ['chatMessagesSent', 'chatMessagesSent'], ['straightFlushHits', 'straightFlushHits'], ['fullHouseHits', 'fullHouseHits'],
  ['quadsHits', 'quadsHits'], ['royalFlushHits', 'royalFlushHits'], ['tournamentsWon', 'tournamentsWon'],
  ['tournamentsPlayed', 'tournamentsPlayed'], ['vpipHands', 'vpipHands'], ['pfrHands', 'pfrHands'],
  ['flopsSeenHands', 'flopsSeenHands'], ['showdownHands', 'showdownHands'], ['showdownWins', 'showdownWins'],
  ['threeBetOpps', 'threeBetOpps'], ['threeBets', 'threeBets'], ['rankedWins', 'rankedWins'], ['rankedLosses', 'rankedLosses'],
];
/** Counters that are a running MAXIMUM. */
const MAX_COUNTERS: ReadonlyArray<[string, keyof PlayerProgress]> = [
  ['biggestPot', 'biggestPot'], ['bestStreak', 'bestStreak'], ['peakElo', 'peakElo'],
];

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Per-hand facts of one table's hand, keyed `${tableId}#${handNumber}` (a player can be in two hands at once). */
interface HandFlags { vpip: boolean; pfr: boolean; faced3bet: boolean; did3bet: boolean; foldedPreflop: boolean; allIns: number }
export interface HandRef { tableId?: string; handNumber?: number }
const handKeyOf = (ref?: HandRef): string =>
  ref && ref.tableId != null && ref.handNumber != null ? `${ref.tableId}#${ref.handNumber}` : '';
const emptyFlags = (): HandFlags => ({ vpip: false, pfr: false, faced3bet: false, did3bet: false, foldedPreflop: false, allIns: 0 });

/** Internal per-record state that never leaves the server. */
interface RecordInternals {
  handFlags: Map<string, HandFlags>;
  committedHands: string[];
  /** `${category}:${id}:${window}` payouts in flight (never re-triggered meanwhile). */
  pendingAch: Set<string>;
  /** achievement payout retry back-off after a DB error (id → epoch ms). */
  achRetryAfter: Map<string, number>;
  /**
   * Chips / stars the record SHOWS that no transaction has confirmed yet
   * (optimistic achievement / level-up rewards in flight). A DB wallet snapshot
   * is applied as `DB + pending`, so a hand-complete or sign-in refresh never
   * makes a reward that is still settling disappear from the display.
   */
  pendChips: number;
  pendStars: number;
}

export interface EconomyAuditEvent {
  userId: number;
  kind: 'achievement' | 'level_up';
  chips: number;
  stars: number;
  detail: Record<string, unknown>;
}

export class ProgressionManager {
  private progressMap: Map<string, PlayerProgress> = new Map();
  /** seat playerId (player-<uuid>, user_<id>, …) → the account's canonical key. */
  private aliases: Map<string, string> = new Map();
  private pendingEvents: Map<string, ProgressEvent[]> = new Map();
  private internals: WeakMap<PlayerProgress, RecordInternals> = new WeakMap();
  private hydrations: Map<string, Promise<boolean>> = new Map();
  private retryTimers: Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }> = new Map();
  private inflight: Set<Promise<unknown>> = new Set();
  private changeListener: ((userId: number) => void) | null = null;
  private auditHook: ((e: EconomyAuditEvent) => void) | null = null;

  /** The Battle Pass season whose premium the record carries (index.ts sets it). */
  battlePassSeason = 'season_1_the_river';
  /** Back-off between hydrate attempts (ms); tests set [0, 0, 0]. */
  hydrateBackoffMs: number[] = [0, 250, 1000];
  /** Background re-hydrate schedule after every attempt failed (ms). */
  hydrateRetryDelaysMs: number[] = [5_000, 15_000, 60_000, 180_000];
  /** Clock seam for tests. */
  now: () => number = () => Date.now();

  // ───────────────────────── identity / lifecycle ─────────────────────────

  private keyOf(playerId: string): string {
    return this.aliases.get(playerId) ?? playerId;
  }

  private rec(playerId: string): PlayerProgress | undefined {
    const p = this.progressMap.get(this.keyOf(playerId));
    if (p) p.lastTouchedAt = this.now();
    return p;
  }

  private inner(p: PlayerProgress): RecordInternals {
    let i = this.internals.get(p);
    if (!i) {
      i = { handFlags: new Map(), committedHands: [], pendingAch: new Set(), achRetryAfter: new Map(), pendChips: 0, pendStars: 0 };
      this.internals.set(p, i);
    }
    return i;
  }

  /** Called whenever an asynchronous settlement changed a user's progress (index.ts pushes C5). */
  setChangeListener(fn: ((userId: number) => void) | null): void { this.changeListener = fn; }
  /** Every economy credit the engine pays is reported here (index.ts: auditLog + large-grant alert). */
  setAuditHook(fn: ((e: EconomyAuditEvent) => void) | null): void { this.auditHook = fn; }

  private notify(p: PlayerProgress): void {
    if (!p.userId || !this.changeListener) return;
    try { this.changeListener(p.userId); } catch (e: any) { console.warn('[ProgressionManager] change listener threw:', e?.message); }
  }
  private audit(e: EconomyAuditEvent): void {
    if (!this.auditHook) return;
    try { this.auditHook(e); } catch (err: any) { console.warn('[ProgressionManager] audit hook threw:', err?.message); }
  }
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => { this.inflight.delete(p); };
    p.then(done, done);
    return p;
  }
  /** Resolve once every settlement in flight has finished (tests, graceful shutdown). */
  async flushPending(): Promise<void> {
    for (let i = 0; i < 10 && this.inflight.size > 0; i++) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private newRecord(playerId: string, playerName: string): PlayerProgress {
    const now = this.now();
    return {
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
      chips: 0,
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
      vpipHands: 0,
      pfrHands: 0,
      flopsSeenHands: 0,
      showdownHands: 0,
      showdownWins: 0,
      threeBetOpps: 0,
      threeBets: 0,
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
      dailyStats: emptyDailyStats(),
      dailyStatsDate: utcDateKey(new Date(now)),
      weeklyStats: emptyWeeklyStats(),
      weeklyStatsWeekStart: utcWeekStartKey(new Date(now)),
      dailyAchievementsToday: [],
      weeklyAchievementsThisWeek: [],
      straightFlushHits: 0,
      fullHouseHits: 0,
      quadsHits: 0,
      royalFlushHits: 0,
      tournamentsWon: 0,
      tournamentsPlayed: 0,
      variantsPlayed: [],
      // Gate for save paths — flipped to true only after hydrateFromDB
      // completes successfully. Until then, no write may touch the users row.
      hydrated: false,
      everHydrated: false,
      scratchCardsAvailable: 0,
      lastLoginClaimDate: null,
      vipExpiresAt: 0,
      activeBoosters: {},
      battlePassPremium: false,
      owned: new Set<string>(),
      equipped: {},
      missionDay: emptyMissionDay(denverDateKey(now)),
      vipMonthlyClaimedMonth: null,
      spinClaimedDate: null,
      lastTouchedAt: now,
    };
  }

  /**
   * The progress record for a seat / lobby id. With an account (`userId`) there
   * is exactly ONE record per account — `user-<id>` — and every seat playerId
   * of that account becomes an alias of it (2026-10-11 R2, ECON-9 / ECON-10:
   * one entry per SEAT used to double-pay achievements across two seats, let
   * counters last-writer-win, and leave the lobby entry stale). Without an
   * account the id is its own record (unauthenticated sockets, tests).
   */
  getOrCreateProgress(playerId: string, playerName: string, userId?: number): PlayerProgress {
    const uid = validUserId(userId);
    const now = this.now();
    if (uid) {
      const ukey = userProgressKey(uid);
      let entry = this.progressMap.get(ukey);
      if (playerId !== ukey) {
        // A record created under this playerId before the account was known —
        // adopt it as the account's record (or drop it if the account already has one).
        const own = this.progressMap.get(playerId);
        if (own && own !== entry && (!own.userId || own.userId === uid)) {
          this.progressMap.delete(playerId);
          if (!entry) {
            own.playerId = ukey;
            own.userId = uid;
            this.progressMap.set(ukey, own);
            entry = own;
            const ev = this.pendingEvents.get(playerId);
            if (ev) { this.pendingEvents.delete(playerId); this.pendingEvents.set(ukey, [...(this.pendingEvents.get(ukey) || []), ...ev]); }
          }
        }
        this.aliases.set(playerId, ukey);
      }
      if (!entry) {
        entry = this.newRecord(ukey, playerName);
        entry.userId = uid;
        this.progressMap.set(ukey, entry);
      }
      if (playerName) entry.playerName = playerName;
      entry.lastTouchedAt = now;
      if (!entry.hydrated && !this.hydrations.has(ukey)) {
        this.hydrateFromDB(ukey, uid).catch((e) =>
          console.warn(`[ProgressionManager.getOrCreateProgress hydrate ${uid}]`, e?.message));
      }
      return entry;
    }
    const key = this.keyOf(playerId);
    const existing = this.progressMap.get(key);
    if (existing) {
      existing.playerName = playerName;
      existing.lastTouchedAt = now;
      return existing;
    }
    const fresh = this.newRecord(playerId, playerName);
    this.progressMap.set(playerId, fresh);
    return fresh;
  }

  getProgress(playerId: string): PlayerProgress | undefined {
    return this.rec(playerId);
  }

  /** The account's record, if loaded. */
  userRecord(userId: number): PlayerProgress | undefined {
    const uid = validUserId(userId);
    return uid ? this.progressMap.get(userProgressKey(uid)) : undefined;
  }

  /**
   * 2026-10-09 (D2) — merge a guest carry-over into the CALLER's live
   * in-memory progress, WITHOUT reloading it from Postgres. A full reload
   * would throw away progress that is ahead of the DB and, while `hydrated` is
   * false, persistChipReward / persistStarReward skip — a reward earned in
   * that window would be lost for good. So only the carried fields move:
   *   chips / stars    += what the claim added (the DB got the same, additively);
   *   level / xp       ratchet — never lowers what memory holds;
   *   achievements     union (incl. the level achievements marked earned).
   * Nothing is written to the DB here (the claim transaction already did).
   * An entry still hydrating gets a fresh hydrate instead (its read may
   * predate the claim's commit). Returns the playerIds merged / re-hydrated.
   */
  applyCarriedProgress(
    userId: number,
    carried: { chipsAdded: number; starsAdded: number; levelAfter: number; xpAfter: number; achievementIds: string[] },
  ): { merged: string[]; reloading: string[] } {
    const merged: string[] = [];
    const reloading: string[] = [];
    const nonNeg = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
    const chipsAdded = nonNeg(carried.chipsAdded);
    const starsAdded = nonNeg(carried.starsAdded);
    const levelAfter = Math.min(MAX_LEVEL, Math.max(1, nonNeg(carried.levelAfter)));
    const xpAfter = Math.min(nonNeg(carried.xpAfter), maxXpAtLevel(levelAfter));
    const ids = (carried.achievementIds || []).filter((a) => typeof a === 'string' && a.length > 0);
    for (const [playerId, progress] of this.progressMap) {
      if (progress.userId !== userId) continue;
      if (!progress.hydrated) { reloading.push(playerId); continue; }
      progress.chips += chipsAdded;
      progress.stars += starsAdded;
      if (levelAfter > progress.level) {
        progress.level = levelAfter;
        progress.xp = xpAfter;
        progress.xpToNextLevel = xpRequiredForLevel(progress.level);
        if (progress.level >= MAX_LEVEL) { progress.xp = 0; progress.xpToNextLevel = Infinity; }
      } else if (levelAfter === progress.level && progress.level < MAX_LEVEL) {
        progress.xp = Math.max(progress.xp, xpAfter);
      }
      progress.achievements = Array.from(new Set([...(progress.achievements || []), ...ids]));
      merged.push(playerId);
    }
    for (const playerId of reloading) {
      this.hydrateFromDB(playerId, userId).catch((e: any) =>
        console.warn(`[ProgressionManager.applyCarriedProgress hydrate ${userId}]`, e?.message));
    }
    return { merged, reloading };
  }

  /**
   * 2026-10-09 — force every in-memory entry belonging to `userId` to re-read
   * Postgres, after an out-of-band DB change to that user's progress. Used for
   * the RETIRED guest row after a carry-over (its stars/chips just left it).
   * NOT for the caller — see applyCarriedProgress. Clearing `hydrated` first
   * engages the write gate for the duration of the reload, so nothing is
   * written from the stale values meanwhile. Returns the ids reloaded.
   */
  async rehydrateUser(userId: number): Promise<string[]> {
    const ids: string[] = [];
    for (const [playerId, progress] of this.progressMap) {
      if (progress.userId === userId) {
        progress.hydrated = false;
        ids.push(playerId);
      }
    }
    await Promise.all(ids.map((playerId) => this.hydrateFromDB(playerId, userId, { refresh: true }).catch((e: any) =>
      console.warn(`[ProgressionManager.rehydrateUser ${userId}]`, e?.message))));
    return ids;
  }

  /**
   * Load a record from Postgres. 2026-10-11 (R2):
   *  - ECON-12: `hydrated` becomes true ONLY when every read succeeded
   *    (loadProgressBundle throws instead of returning [] / null); failed
   *    attempts are retried (hydrateBackoffMs), then re-tried in the background
   *    (hydrateRetryDelaysMs) — a record never fresh-inits counters over real data.
   *  - C5: `refresh` re-reads an ALREADY hydrated record (every sign-in does):
   *    the DB-owned fields (wallet, inventory, entitlements, claims) are taken
   *    from the DB, counters / level / achievements are merged (never lowered).
   * Concurrent calls share one load. Returns whether the record is hydrated.
   */
  async hydrateFromDB(playerId: string, userId: number, opts: { refresh?: boolean } = {}): Promise<boolean | undefined> {
    const key = this.keyOf(playerId);
    const progress = this.progressMap.get(key);
    if (!progress) return false;
    if (!opts.refresh && progress.hydrated && progress.userId === userId) return true;
    const running = this.hydrations.get(key);
    if (running) {
      const ok = await running;
      if (!opts.refresh) return ok && !!progress.hydrated;
    }
    progress.userId = userId;
    const p = this.runHydrate(key, progress, userId).finally(() => {
      if (this.hydrations.get(key) === p) this.hydrations.delete(key);
    });
    this.hydrations.set(key, p);
    return p;
  }

  private async runHydrate(key: string, progress: PlayerProgress, userId: number): Promise<boolean> {
    const now = this.now();
    let lastErr = '';
    const delays = this.hydrateBackoffMs.length ? this.hydrateBackoffMs : [0];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
      try {
        const bundle = await loadProgressBundle(userId, {
          utcToday: utcDateKey(new Date(now)), utcWeekStart: utcWeekStartKey(new Date(now)), battlePassSeason: this.battlePassSeason,
        });
        if (!bundle) {
          console.warn(`[ProgressionManager.hydrateFromDB ${userId}] no users row — record stays un-hydrated`);
          return false;
        }
        if (this.progressMap.get(key) !== progress) return false; // evicted / replaced meanwhile
        this.applyBundle(progress, bundle);
        const rt = this.retryTimers.get(key);
        if (rt?.timer) clearTimeout(rt.timer);
        this.retryTimers.delete(key);
        return true;
      } catch (e: any) {
        lastErr = e?.message || String(e);
      }
    }
    console.warn(`[ProgressionManager.hydrateFromDB ${userId}] every read attempt failed — hydrated stays ${progress.hydrated}: ${lastErr}`);
    if (!progress.hydrated) this.scheduleRehydrate(key, userId);
    return !!progress.hydrated;
  }

  private scheduleRehydrate(key: string, userId: number): void {
    const state = this.retryTimers.get(key) || { attempts: 0, timer: null };
    if (state.timer || state.attempts >= this.hydrateRetryDelaysMs.length) return;
    const delay = this.hydrateRetryDelaysMs[state.attempts];
    state.attempts++;
    state.timer = setTimeout(() => {
      state.timer = null;
      const p = this.progressMap.get(key);
      if (!p || p.hydrated) return;
      this.hydrateFromDB(key, userId).then((ok) => { if (ok) this.notify(p); }).catch(() => { /* logged inside */ });
    }, delay);
    if (typeof (state.timer as any)?.unref === 'function') (state.timer as any).unref();
    this.retryTimers.set(key, state);
  }

  /**
   * Fold a DB bundle into a record. FIRST load: the DB's values, plus whatever
   * the record counted before the load landed (it started from zero, so its
   * counters ARE deltas). LATER loads (sign-in refresh): DB-owned fields from
   * the DB, counters max(memory, DB), level ratchet, achievement union.
   */
  private applyBundle(p: PlayerProgress, b: ProgressBundle): void {
    const fresh = !p.everHydrated;
    const s = b.stats || {};
    const now = this.now();

    // DB-owned: every write path of these writes the DB (additive SQL / a
    // transaction). Rewards still settling stay on top (`DB + pending`).
    const inner = this.inner(p);
    p.chips = b.chips + inner.pendChips;
    p.stars = b.stars + inner.pendStars;
    p.scratchCardsAvailable = b.scratchCardsAvailable;
    p.dailyLoginStreak = b.loginStreak;
    p.lastLoginClaimDate = b.lastLoginClaimDate;
    p.lastLoginDate = b.lastLoginClaimDate || '';
    p.vipExpiresAt = num(s.vipExpiresAt);
    p.activeBoosters = liveBoosters(s.activeBoosters, now);
    p.battlePassPremium = !!b.battlePassPremium;
    p.vipMonthlyClaimedMonth = b.vipMonthlyClaimed ? b.denverMonth : null;
    p.spinClaimedDate = b.spinClaimedToday ? b.denverToday : null;
    const owned = new Set<string>();
    const equipped: Record<string, string> = {};
    for (const row of b.inventory) {
      owned.add(itemKey(row.itemType, row.itemId));
      if (row.equipped) equipped[normalizeItemType(row.itemType)] = row.itemId;
    }
    p.owned = owned;
    p.equipped = equipped;
    this.syncLegacyCosmetics(p);

    // Level / xp.
    const dbLevel = Math.min(MAX_LEVEL, Math.max(1, b.level));
    if (fresh || dbLevel > p.level) {
      p.level = dbLevel;
      p.xp = b.xp;
    } else if (dbLevel === p.level) {
      p.xp = Math.max(p.xp, b.xp);
    }
    p.xpToNextLevel = xpRequiredForLevel(p.level);
    if (p.level >= MAX_LEVEL) { p.xp = 0; p.xpToNextLevel = Infinity; }

    // Lifetime achievements: users.achievements ∪ the ledger ∪ confirmed memory.
    p.achievements = Array.from(new Set([...(p.achievements || []), ...b.achievements, ...b.lifetimeLedger]));

    // Counters.
    const rec = p as unknown as Record<string, number>;
    for (const [sk, field] of ADDITIVE_COUNTERS) {
      const dbv = num(s[sk]);
      const mem = num(rec[field as string]);
      rec[field as string] = fresh ? dbv + mem : Math.max(dbv, mem);
    }
    for (const [sk, field] of MAX_COUNTERS) {
      if (typeof s[sk] === 'number') rec[field as string] = Math.max(num(s[sk]), num(rec[field as string]));
    }
    if (Array.isArray(s.variantsPlayed)) {
      p.variantsPlayed = Array.from(new Set([...(s.variantsPlayed as string[]), ...(p.variantsPlayed || [])]));
    }
    p.actionCounts = mergeCounterMaps(s.actionCounts, p.actionCounts, fresh);
    p.handsPerRank = mergeCounterMaps(s.handsPerRank, p.handsPerRank, fresh);
    p.positionWins = mergePositionWins(s.positionWins, p.positionWins, fresh);
    if (typeof s.lastHandAt === 'number') p.lastHandAt = Math.max(s.lastHandAt, p.lastHandAt || 0);

    // ELO: the stored rating on the first load; a live record keeps its own (single writer).
    if (fresh) {
      if (typeof s.elo === 'number' && Number.isFinite(s.elo)) p.elo = Math.max(0, s.elo + (p.elo - ELO_START));
      if (Array.isArray(s.eloHistory)) {
        p.eloHistory = [...(s.eloHistory as Array<{ t: number; elo: number }>), ...(p.eloHistory || [])]
          .filter((x) => x && typeof x.t === 'number' && typeof x.elo === 'number').slice(-30);
      }
    }
    if (p.elo > p.peakElo) p.peakElo = p.elo;
    p.rank = eloToRank(p.elo);

    // HUD / achievement windows (persisted with their date since R2).
    this.rollAchievementWindows(p);
    if (s.dailyStatsDate === p.dailyStatsDate && s.dailyStats && typeof s.dailyStats === 'object') {
      p.dailyStats = { ...emptyDailyStats(), ...mergeProgressStats({ dailyStats: s.dailyStats, dailyStatsDate: p.dailyStatsDate }, { dailyStats: p.dailyStats, dailyStatsDate: p.dailyStatsDate }).dailyStats };
    }
    if (s.weeklyStatsWeekStart === p.weeklyStatsWeekStart && s.weeklyStats && typeof s.weeklyStats === 'object') {
      p.weeklyStats = { ...emptyWeeklyStats(), ...mergeProgressStats({ weeklyStats: s.weeklyStats, weeklyStatsWeekStart: p.weeklyStatsWeekStart }, { weeklyStats: p.weeklyStats, weeklyStatsWeekStart: p.weeklyStatsWeekStart }).weeklyStats };
    }
    p.dailyAchievementsToday = Array.from(new Set([...(p.dailyAchievementsToday || []), ...b.dailyAchievementIds]));
    p.weeklyAchievementsThisWeek = Array.from(new Set([...(p.weeklyAchievementsThisWeek || []), ...b.weeklyAchievementIds]));

    // Missions (Denver day).
    const day = this.missionDayOf(p);
    if (b.denverToday === day.date) {
      const stored = s.missions;
      if (stored && typeof stored === 'object' && stored.date === day.date && stored.progress && typeof stored.progress === 'object') {
        for (const [tid, v] of Object.entries(stored.progress as Record<string, unknown>)) {
          day.progress[tid] = Math.max(num(v), num(day.progress[tid]));
        }
      }
      day.claimed = Array.from(new Set([...day.claimed, ...b.missionClaims]));
    }

    if (b.displayName && !p.playerName) p.playerName = b.displayName;
    if (b.publicId) p.publicId = b.publicId;
    p.hydrated = true;
    p.everHydrated = true;
  }

  /** The legacy cosmetic mirrors older clients read (ownedThemes, equippedTableTheme, …). */
  private syncLegacyCosmetics(p: PlayerProgress): void {
    const owned = p.owned || new Set<string>();
    const ofType = (t: string) => [...owned].filter((k) => k.startsWith(`${t}:`)).map((k) => k.slice(t.length + 1));
    p.ownedThemes = Array.from(new Set(['classic_blue', ...ofType('theme')]));
    p.ownedTableThemes = Array.from(new Set(['default', ...ofType('theme')]));
    p.ownedCardBacks = Array.from(new Set(['default', ...ofType('card_back')]));
    p.equippedTableTheme = p.equipped?.theme || 'default';
    p.equippedCardBack = p.equipped?.card_back || 'default';
  }

  /**
   * Sign-in refresh (C5: "login always re-hydrates from the DB"): the account's
   * record is created if needed and re-read from Postgres — a fresh load the
   * first time, a merge afterwards. Returns the record (hydrated or not).
   */
  async refreshUser(userId: number, displayName: string): Promise<PlayerProgress | undefined> {
    const uid = validUserId(userId);
    if (!uid) return undefined;
    const ukey = userProgressKey(uid);
    const p = this.getOrCreateProgress(ukey, displayName, uid);
    await this.hydrateFromDB(ukey, uid, { refresh: true });
    return p;
  }

  /** Overwrite the DB-owned wallet fields of a loaded record (a transaction's RETURNING / a fresh read). */
  applyWallet(userId: number, w: Partial<Balances> & { loginStreak?: number; lastLoginClaimDate?: string | null }): void {
    const p = this.userRecord(userId);
    if (!p) return;
    const inner = this.inner(p);
    if (typeof w.chips === 'number' && Number.isFinite(w.chips)) p.chips = w.chips + inner.pendChips;
    if (typeof w.stars === 'number' && Number.isFinite(w.stars)) p.stars = w.stars + inner.pendStars;
    if (typeof w.scratchCardsAvailable === 'number') p.scratchCardsAvailable = w.scratchCardsAvailable;
    if (typeof w.loginStreak === 'number') p.dailyLoginStreak = w.loginStreak;
    if (w.lastLoginClaimDate !== undefined) { p.lastLoginClaimDate = w.lastLoginClaimDate; p.lastLoginDate = w.lastLoginClaimDate || ''; }
  }

  /** Apply a change to a loaded record (economy handlers mirror their committed transaction). */
  updateUser(userId: number, fn: (p: PlayerProgress) => void): PlayerProgress | undefined {
    const p = this.userRecord(userId);
    if (!p) return undefined;
    fn(p);
    if (!p.owned) p.owned = new Set();
    if (!p.equipped) p.equipped = {};
    this.syncLegacyCosmetics(p);
    return p;
  }

  /**
   * Drop records nobody uses (P3: progressMap was never evicted). A record of an
   * account with a live socket / seat (`isLive`) is kept; so is one with a
   * settlement in flight. Aliases pointing at a dropped record go with it.
   */
  evictIdle(isLive: (userId: number) => boolean, idleMs = 30 * 60_000): string[] {
    const now = this.now();
    const dropped: string[] = [];
    for (const [key, p] of this.progressMap) {
      if (now - (p.lastTouchedAt || 0) < idleMs) continue;
      if (p.userId && isLive(p.userId)) continue;
      const i = this.internals.get(p);
      if (i && i.pendingAch.size > 0) continue;
      if (this.hydrations.has(key)) continue;
      this.progressMap.delete(key);
      this.pendingEvents.delete(key);
      const rt = this.retryTimers.get(key);
      if (rt?.timer) clearTimeout(rt.timer);
      this.retryTimers.delete(key);
      dropped.push(key);
    }
    if (dropped.length) {
      const gone = new Set(dropped);
      for (const [alias, key] of this.aliases) if (gone.has(key)) this.aliases.delete(alias);
    }
    return dropped;
  }

  /** Forget a seat playerId alias (the seat is gone). The account's record stays. */
  dropAlias(playerId: string): void {
    this.aliases.delete(playerId);
  }

  get size(): number { return this.progressMap.size; }
  get aliasCount(): number { return this.aliases.size; }

  // ───────────────────────── rewards ─────────────────────────

  /**
   * Credit REAL reward chips to an ONLINE player (referral reward, etc.):
   * additive in-memory so their live client sees it immediately, AND additive to
   * the DB (atomic chips = chips + amount — no ratchet needed, no clobber risk).
   * Returns true if the player was online (had an in-memory entry). Offline
   * players are credited DB-only by the caller via addChipsToUser.
   */
  creditChips(playerId: string, amount: number): boolean {
    const progress = this.rec(playerId);
    if (!progress || amount <= 0) return false;
    progress.chips += amount;
    if (progress.userId) {
      dbAddChipsToUser(progress.userId, amount).catch((e) =>
        console.warn(`[ProgressionManager.creditChips ${progress.userId}]`, e?.message)
      );
    }
    return true;
  }

  /**
   * Persist a chip reward. 2026-10-11 (R2, ECON-10): an ACHIEVEMENT reward
   * (`ledger` given) is paid through its durable ledger — chips AND stars in
   * one transaction that pays only when the ledger INSERT returns a row
   * (settleRewardLedger). Without a ledger: the atomic additive credit
   * (hydrated gate, as before).
   */
  private persistChipReward(progress: PlayerProgress, amount: number, ledger?: AchievementLedgerRef): void {
    if (ledger) { this.settleRewardLedger(progress, ledger); return; }
    if (!progress.userId || amount <= 0) return;
    if (!progress.hydrated) {
      console.warn(`[persistChipReward ${progress.userId}] SKIPPED — not hydrated`);
      return;
    }
    dbAddChipsToUser(progress.userId, amount).catch((e) =>
      console.warn(`[ProgressionManager.persistChipReward ${progress.userId}]`, e?.message)
    );
  }

  /** Atomic additive star credit (no ledger); hydrated gate. */
  private persistStarReward(progress: PlayerProgress, amount: number): void {
    if (!progress.userId || amount <= 0) return;
    if (!progress.hydrated) {
      console.warn(`[persistStarReward ${progress.userId}] SKIPPED — not hydrated`);
      return;
    }
    dbAddStarsToUser(progress.userId, amount).catch((e) =>
      console.warn(`[ProgressionManager.persistStarReward ${progress.userId}]`, e?.message)
    );
  }

  /**
   * The achievement payout: the record already shows the reward (optimistic —
   * the toast-free part), the DB pays it only if the ledger says it is new.
   *   paid    → confirmed: lifetime id stored, XP granted, event + audit, push.
   *   already → paid elsewhere (another process / an earlier session): the
   *             optimistic chips/stars are taken back, the id kept as earned.
   *   error   → taken back, un-marked, retried after a minute.
   */
  private settleRewardLedger(p: PlayerProgress, l: AchievementLedgerRef): void {
    const inner = this.inner(p);
    const unmark = () => {
      inner.pendingAch.delete(l.pendingKey);
      if (l.category === 'daily') p.dailyAchievementsToday = p.dailyAchievementsToday.filter((x) => x !== l.def.id);
      if (l.category === 'weekly') p.weeklyAchievementsThisWeek = p.weeklyAchievementsThisWeek.filter((x) => x !== l.def.id);
    };
    const settled = () => {
      inner.pendChips = Math.max(0, inner.pendChips - l.optimisticChips);
      inner.pendStars = Math.max(0, inner.pendStars - l.optimisticStars);
    };
    const takeBack = () => {
      p.chips = Math.max(0, p.chips - l.optimisticChips);
      p.stars = Math.max(0, p.stars - l.optimisticStars);
    };
    if (!p.userId || !p.hydrated) {
      settled();
      takeBack();
      unmark();
      return;
    }
    const userId = p.userId;
    const job = settleAchievementReward(userId, l.category, l.def.id, l.windowKey, { chips: l.def.reward.chips, stars: l.def.reward.stars || 0 }, { now: this.now() })
      .then((res) => {
        inner.pendingAch.delete(l.pendingKey);
        settled();
        if (res.status === 'paid') {
          p.chips += res.chips - l.optimisticChips;
          p.stars += res.stars - l.optimisticStars;
          if (l.category === 'lifetime' && !p.achievements.includes(l.def.id)) p.achievements.push(l.def.id);
          if (l.def.reward.xp > 0) this.addXP(p.playerId, l.def.reward.xp);
          this.pushEvent(p.playerId, {
            type: 'achievementUnlocked',
            data: { category: l.category, id: l.def.id, name: l.def.name, description: l.def.description, reward: l.def.reward, chipsPaid: res.chips },
          });
          this.audit({ userId, kind: 'achievement', chips: res.chips, stars: res.stars, detail: { category: l.category, achId: l.def.id, window: l.windowKey } });
        } else {
          takeBack();
          if (l.category === 'lifetime' && !p.achievements.includes(l.def.id)) p.achievements.push(l.def.id);
        }
        this.notify(p);
      })
      .catch((e: any) => {
        settled();
        takeBack();
        unmark();
        inner.achRetryAfter.set(l.pendingKey, this.now() + 60_000);
        console.warn(`[ProgressionManager.achievement ${userId} ${l.category}/${l.def.id}] settlement failed — will retry:`, e?.message || e);
        this.notify(p);
      });
    this.track(job);
  }

  // Consume pending events (levelUp, achievements, missionComplete)
  consumeEvents(playerId: string): ProgressEvent[] {
    const key = this.keyOf(playerId);
    const events = this.pendingEvents.get(key) || [];
    this.pendingEvents.delete(key);
    return events;
  }

  private pushEvent(playerId: string, event: ProgressEvent): void {
    const key = this.keyOf(playerId);
    if (!this.pendingEvents.has(key)) {
      this.pendingEvents.set(key, []);
    }
    const list = this.pendingEvents.get(key)!;
    list.push(event);
    if (list.length > 50) list.splice(0, list.length - 50);
  }

  /** The live chip-booster multiplier (1 when none). */
  private chipBoost(progress: PlayerProgress): number {
    const b = progress.activeBoosters?.chip;
    return b && b.expiresAt > this.now() && b.mult > 0 ? b.mult : 1;
  }

  /**
   * Active chip-booster multiplier, applied to chip REWARD grants only
   * (level-up, achievements, missions, daily login, spin, scratch — see
   * CHIP_BOOSTED_REWARDS). NEVER applied to pot winnings — that would mint
   * chips and break table conservation.
   */
  private boostChipReward(progress: PlayerProgress, amount: number): number {
    return Math.round(amount * this.chipBoost(progress));
  }

  addXP(playerId: string, amount: number): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    if (progress.level >= MAX_LEVEL) {
      progress.xp = 0;
      progress.xpToNextLevel = Infinity;
      return;
    }

    // Apply XP booster if active (consumable from shop).
    const xpBooster = progress.activeBoosters?.xp;
    if (xpBooster && xpBooster.expiresAt > this.now()) {
      amount = Math.round(amount * (xpBooster.mult || 1));
    }
    // The loyalty XP-rate perk (Silver 1.5x / Gold 2x / Platinum 3x by
    // cumulative season XP BEFORE this gain — the tier VIPPanel shows).
    const vipRate = this.vipXpRate(progress);
    if (vipRate > 1) amount = Math.round(amount * vipRate);
    progress.xp += amount;

    // Accumulate the level-up rewards across every level crossed, show them at
    // once (optimistic), and settle them through the per-LEVEL ledger
    // (economyDb.settleLevelUps): each level pays exactly once, whatever order
    // the hand-complete save and this commit land in.
    const levels: Array<{ level: number; chips: number; stars: number }> = [];
    while (progress.level < MAX_LEVEL && progress.xp >= progress.xpToNextLevel) {
      progress.xp -= progress.xpToNextLevel;
      progress.level++;
      progress.xpToNextLevel = xpRequiredForLevel(progress.level);

      const baseChips = progress.level * 500;
      const shownChips = this.boostChipReward(progress, baseChips);
      const baseStars = progress.level * 5;
      const bonusStars = milestoneStarsBonus(progress.level);
      progress.chips += shownChips;
      progress.stars += baseStars + bonusStars;
      levels.push({ level: progress.level, chips: baseChips, stars: baseStars + bonusStars });

      this.pushEvent(playerId, {
        type: 'levelUp',
        data: {
          newLevel: progress.level,
          bonusChips: shownChips,
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

    if (levels.length > 0 && progress.userId && progress.hydrated) {
      const shownChips = levels.reduce((s, l) => s + this.boostChipReward(progress, l.chips), 0);
      const shownStars = levels.reduce((s, l) => s + l.stars, 0);
      const inner = this.inner(progress);
      inner.pendChips += shownChips;
      inner.pendStars += shownStars;
      this.settleLevels(progress, levels, progress.level, progress.xp, shownChips, shownStars, 0);
    }
  }

  private settleLevels(
    progress: PlayerProgress, levels: Array<{ level: number; chips: number; stars: number }>, newLevel: number, xp: number,
    shownChips: number, shownStars: number, attempt: number,
  ): void {
    const userId = progress.userId!;
    const inner = this.inner(progress);
    const settled = () => {
      inner.pendChips = Math.max(0, inner.pendChips - shownChips);
      inner.pendStars = Math.max(0, inner.pendStars - shownStars);
    };
    const job = settleLevelUps(userId, levels, newLevel, xp, { now: this.now() })
      .then((res) => {
        settled();
        // Levels the ledger had already paid (another process / a stale record) are taken back.
        progress.chips = Math.max(0, progress.chips + res.chips - shownChips);
        progress.stars = Math.max(0, progress.stars + res.stars - shownStars);
        if (res.chips > 0 || res.stars > 0) {
          this.audit({ userId, kind: 'level_up', chips: res.chips, stars: res.stars, detail: { levels: res.paidLevels } });
        }
        this.notify(progress);
      })
      .catch((e: any) => {
        if (attempt < 2) {
          const retry = new Promise<void>((resolve) => setTimeout(() => {
            this.settleLevels(progress, levels, newLevel, xp, shownChips, shownStars, attempt + 1);
            resolve();
          }, 500 * (attempt + 1)));
          this.track(retry);
          return;
        }
        settled();
        progress.chips = Math.max(0, progress.chips - shownChips);
        progress.stars = Math.max(0, progress.stars - shownStars);
        console.error(`[ProgressionManager.levelUp ${userId}] reward settlement failed after retries (levels ${levels.map((l) => l.level).join(',')}):`, e?.message || e);
        this.notify(progress);
      });
    this.track(job);
  }

  // ───────────────────────── per-hand recording ─────────────────────────

  private flagsFor(p: PlayerProgress, ref?: HandRef): HandFlags {
    const inner = this.inner(p);
    const key = handKeyOf(ref);
    let f = inner.handFlags.get(key);
    if (!f) {
      f = emptyFlags();
      inner.handFlags.set(key, f);
      if (inner.handFlags.size > 20) {
        const first = inner.handFlags.keys().next().value;
        if (first !== undefined) inner.handFlags.delete(first);
      }
    }
    return f;
  }

  /** The hand's flags, removed (the hand is being committed). A late action of a committed hand applies directly. */
  private takeFlags(p: PlayerProgress, ref?: HandRef): HandFlags {
    const inner = this.inner(p);
    const key = handKeyOf(ref);
    const f = inner.handFlags.get(key) || emptyFlags();
    inner.handFlags.delete(key);
    if (key) {
      inner.committedHands.push(key);
      if (inner.committedHands.length > 20) inner.committedHands.shift();
    }
    return f;
  }

  private handCommitted(p: PlayerProgress, ref?: HandRef): boolean {
    const key = handKeyOf(ref);
    return !!key && this.inner(p).committedHands.includes(key);
  }

  /**
   * A hand the player was DEALT INTO completed (handleHandComplete calls this
   * only for dealt-in seats — ECON-13). `ref` = { tableId, handNumber }.
   */
  recordHandPlayed(playerId: string, variantId?: string, ref?: HandRef, dealtIn = true): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    if (!dealtIn) {
      // ECON-13 — a seat sitting out / joining mid-hand: no hand, no XP, no
      // mission, no scratch progress. Its per-hand flags are dropped.
      this.takeFlags(progress, ref);
      return;
    }

    progress.totalHandsPlayed++;
    progress.lastHandAt = this.now();

    const f = this.takeFlags(progress, ref);
    if (f.vpip) progress.vpipHands = (progress.vpipHands || 0) + 1;
    if (f.pfr) progress.pfrHands = (progress.pfrHands || 0) + 1;
    if (f.faced3bet) progress.threeBetOpps = (progress.threeBetOpps || 0) + 1;
    if (f.did3bet) progress.threeBets = (progress.threeBets || 0) + 1;
    // Remembered for recordShowdownResult of the same hand (called right after).
    this.inner(progress).handFlags.set(`sd|${handKeyOf(ref)}`, { ...emptyFlags(), foldedPreflop: f.foldedPreflop });

    // Track variant breadth for lifetime "all_variants" + daily/weekly buckets.
    if (variantId && !progress.variantsPlayed.includes(variantId)) {
      progress.variantsPlayed.push(variantId);
    }
    this.tickWindows(progress, 'played', { variantId });

    this.advanceMissions(progress, { played: true, allIns: f.allIns });

    this.checkAchievements(playerId);
  }

  /**
   * Preflop 3-bet context for the HUD 3-Bet%. `facingRaise` = the player is
   * acting with a prior preflop raise already in front of them (a 3-bet spot);
   * `isReraise` = they raised in that spot (a 3-bet+). Fed by the per-table
   * playerAction listener, keyed by the hand.
   */
  recordPreflopRaiseContext(playerId: string, facingRaise: boolean, isReraise: boolean, ref?: HandRef): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    if (this.handCommitted(progress, ref)) {
      if (facingRaise) progress.threeBetOpps = (progress.threeBetOpps || 0) + 1;
      if (isReraise) progress.threeBets = (progress.threeBets || 0) + 1;
      return;
    }
    const f = this.flagsFor(progress, ref);
    if (facingRaise) f.faced3bet = true;
    if (isReraise) f.did3bet = true;
  }

  /**
   * Record the showdown outcome of a hand for the WTSD / W$SD HUD stats. Called
   * once per dealt-in human at hand-complete, after recordHandPlayed. `sawFlop`
   * is derived from the hand's foldedPreflop flag.
   */
  recordShowdownResult(playerId: string, flopDealt: boolean, reachedShowdown: boolean, wonAtShowdown: boolean, ref?: HandRef): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    const inner = this.inner(progress);
    const sdKey = `sd|${handKeyOf(ref)}`;
    const folded = inner.handFlags.get(sdKey)?.foldedPreflop || false;
    inner.handFlags.delete(sdKey);
    const sawFlop = flopDealt && !folded;
    if (sawFlop) progress.flopsSeenHands = (progress.flopsSeenHands || 0) + 1;
    if (reachedShowdown) progress.showdownHands = (progress.showdownHands || 0) + 1;
    if (wonAtShowdown) progress.showdownWins = (progress.showdownWins || 0) + 1;
  }

  /**
   * Record a finished tournament for a participant. position 1 === winner.
   * Called once per participant from payTournamentPrizes (rides its
   * paidOutTournaments idempotency guard). AI players have no progress entry,
   * so this no-ops for them.
   */
  recordTournamentResult(playerId: string, position: number): void {
    const progress = this.rec(playerId);
    if (!progress) return;

    progress.tournamentsPlayed = (progress.tournamentsPlayed || 0) + 1;
    if (position === 1) {
      progress.tournamentsWon = (progress.tournamentsWon || 0) + 1;
      this.rollAchievementWindows(progress);
      progress.weeklyStats.tournamentsWonThisWeek = (progress.weeklyStats.tournamentsWonThisWeek || 0) + 1;
    }

    // Persist the lifetime counters durably (a win must survive an immediate
    // quit) — merged under the row lock, never lowered (R2: max-merge).
    if (progress.userId && progress.hydrated) {
      dbMergeUserStats(progress.userId, {
        tournamentsWon: progress.tournamentsWon,
        tournamentsPlayed: progress.tournamentsPlayed,
      }, { monotonic: true }).catch((e: any) => console.warn(`[recordTournamentResult ${progress.userId}]`, e?.message));
    }

    this.checkAchievements(playerId);
  }

  recordHandWon(
    playerId: string,
    potSize: number,
    handRank?: number,
    wasAllIn?: boolean
  ): void {
    const progress = this.rec(playerId);
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

    this.advanceMissions(progress, { win: { potWon: potSize, handRank, currentStreak: progress.currentStreak } });

    this.checkAchievements(playerId);
  }

  recordHandLost(playerId: string): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    progress.currentStreak = 0;
    // Also break the within-today streak so daily streak achievements
    // reflect the latest run, not an all-time-per-day max.
    this.rollAchievementWindows(progress);
    progress.dailyStats.currentWinStreakToday = 0;
  }

  recordChipHistory(playerId: string, chipCount: number): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    progress.chipHistory.push(chipCount);
    if (progress.chipHistory.length > 20) {
      progress.chipHistory = progress.chipHistory.slice(-20);
    }
  }

  recordPositionResult(playerId: string, position: string, won: boolean): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    if (!progress.positionWins[position]) {
      progress.positionWins[position] = { wins: 0, total: 0 };
    }
    progress.positionWins[position].total++;
    if (won) {
      progress.positionWins[position].wins++;
    }
  }

  /**
   * Update ELO for a head-to-head result. Call once per winner-loser pair per hand.
   * For multi-player games pass the average ELO of all other players as opponentElo.
   */
  updateElo(winnerId: string, loserId: string): void {
    const winner = this.rec(winnerId);
    const loser = this.rec(loserId);
    if (!winner || !loser || winner === loser) return;

    const winnerChange = calcEloChange(winner.elo, loser.elo, true);
    const loserChange = calcEloChange(loser.elo, winner.elo, false);

    winner.elo = Math.max(0, winner.elo + winnerChange);
    loser.elo = Math.max(0, loser.elo + loserChange);

    if (winner.elo > winner.peakElo) winner.peakElo = winner.elo;

    // Bounded ELO samples for the rank sparkline (persisted since R2).
    const now = this.now();
    const pushElo = (p: PlayerProgress) => {
      if (!Array.isArray(p.eloHistory)) p.eloHistory = [];
      p.eloHistory.push({ t: now, elo: p.elo });
      if (p.eloHistory.length > 30) p.eloHistory = p.eloHistory.slice(-30);
    };
    pushElo(winner);
    pushElo(loser);

    winner.rank = eloToRank(winner.elo);
    loser.rank = eloToRank(loser.elo);

    winner.rankedWins++;
    loser.rankedLosses++;
  }

  /**
   * The HUD (C10): computed from the record's PERSISTED counters (since R2 the
   * action / position counters are stored too), so an unseated socket gets the
   * same numbers as a seated one. Null stats = no sample yet (client shows N/A).
   */
  getDetailedStats(playerId: string): object | null {
    const progress = this.rec(playerId);
    if (!progress) return null;

    const th = progress.totalHandsPlayed || 0;
    const ac = progress.actionCounts || {};
    const passive = ac.call || 0;
    const aggressive = (ac.raise || 0) + (ac.allin || 0);
    const af = passive > 0
      ? Number((aggressive / passive).toFixed(2))
      : (aggressive > 0 ? 99 : 0);
    const vpip = th > 0 ? Number((((progress.vpipHands || 0) / th) * 100).toFixed(1)) : 0;
    const pfr = th > 0 ? Number((((progress.pfrHands || 0) / th) * 100).toFixed(1)) : 0;
    const fs = progress.flopsSeenHands || 0;
    const sd = progress.showdownHands || 0;
    const wtsd = fs > 0 ? Number(((sd / fs) * 100).toFixed(1)) : null;
    const wsd = sd > 0 ? Number((((progress.showdownWins || 0) / sd) * 100).toFixed(1)) : null;
    const tbo = progress.threeBetOpps || 0;
    const threeBet = tbo > 0 ? Number((((progress.threeBets || 0) / tbo) * 100).toFixed(1)) : null;
    const positionStats: Record<string, { wins: number; total: number; winRate: number | null }> = {};
    for (const [pos, v] of Object.entries(progress.positionWins || {})) {
      positionStats[pos] = { wins: v.wins, total: v.total, winRate: v.total > 0 ? Number(((v.wins / v.total) * 100).toFixed(1)) : null };
    }

    return {
      ...this.getClientProgress(playerId),
      handsPerRank: progress.handsPerRank,
      actionCounts: progress.actionCounts,
      chipHistory: progress.chipHistory,
      positionWins: progress.positionWins,
      positionStats,
      handsTracked: th,
      winRate: winRateOf(progress),
      ownedThemes: progress.ownedThemes,
      bluffWins: progress.bluffWins,
      allInWins: progress.allInWins,
      vpip,
      pfr,
      af,
      wtsd,
      wsd,
      threeBet,
      vpipHands: progress.vpipHands || 0,
      pfrHands: progress.pfrHands || 0,
      hydrated: progress.hydrated,
    };
  }

  /**
   * An action of a hand. 2026-10-11 (R2, C10/APPUI-10): fed from the table's
   * 'playerAction' event, which fires with the phase the action was MADE in
   * and before the hand can complete (it used to be recorded after the
   * action was applied, reading the ALREADY ADVANCED phase: the preflop call
   * that closed the round never counted for VPIP, and a flag set after the
   * hand-complete commit leaked into the next hand). `ref` keys the per-hand
   * flags by table + hand; a late action of a committed hand applies directly.
   */
  recordAction(
    playerId: string,
    action: string,
    context?: { phase?: string; handRank?: number; tableId?: string; handNumber?: number }
  ): void {
    const progress = this.rec(playerId);
    if (!progress) return;

    if (action === 'fold' || action === 'check' || action === 'call' || action === 'raise' || action === 'allIn') {
      const key = action === 'allIn' ? 'allin' : action;
      progress.actionCounts[key] = (progress.actionCounts[key] || 0) + 1;
    }

    const ref: HandRef | undefined = context?.tableId != null && context?.handNumber != null
      ? { tableId: context.tableId, handNumber: context.handNumber } : undefined;
    const late = this.handCommitted(progress, ref);
    const preflop = context?.phase === 'PreFlop';
    const voluntary = action === 'call' || action === 'raise' || action === 'allIn';
    const raised = action === 'raise' || action === 'allIn';
    if (late) {
      if (preflop && voluntary) progress.vpipHands = (progress.vpipHands || 0) + 1;
      if (preflop && raised) progress.pfrHands = (progress.pfrHands || 0) + 1;
      if (action === 'allIn') this.advanceMissions(progress, { allIns: 1 });
    } else if (action !== 'chat') {
      const f = this.flagsFor(progress, ref);
      if (preflop && voluntary) f.vpip = true;
      if (preflop && raised) f.pfr = true;
      if (preflop && action === 'fold') f.foldedPreflop = true;
      if (action === 'allIn') f.allIns++;
    }

    if (action === 'chat') {
      progress.chatMessagesSent++;
      this.checkAchievements(playerId);
    }
  }

  recordRoyalFlush(playerId: string): void {
    // royal_flush is a regular lifetime achievement since R2 (royalFlushHits,
    // counted in recordHandWon, pays it through the ledger): a second path that
    // paid it here could race the ledger. Just make sure the check has run.
    this.checkAchievements(playerId);
  }

  // ───────────────────────── missions (C6) ─────────────────────────

  /** Today's (Denver) mission day of a record, rolled over at Denver midnight. */
  private missionDayOf(p: PlayerProgress): MissionDayState {
    const today = denverDateKey(this.now());
    if (!p.missionDay || p.missionDay.date !== today) p.missionDay = emptyMissionDay(today);
    return p.missionDay as MissionDayState;
  }

  private missionTemplatesOf(p: PlayerProgress): string[] {
    if (!p.userId) return [];
    return missionTemplateIdsFor(p.userId, this.missionDayOf(p).date);
  }

  private advanceMissions(p: PlayerProgress, event: Parameters<typeof applyMissionProgress>[2]): void {
    const ids = this.missionTemplatesOf(p);
    if (ids.length === 0) return;
    const day = this.missionDayOf(p);
    const done = applyMissionProgress(day, ids, event);
    for (const tid of done) {
      const t = missionTemplate(tid);
      if (!t) continue;
      this.pushEvent(p.playerId, {
        type: 'missionComplete',
        data: { missionId: `${day.date}:${tid}`, templateId: tid, description: t.description, reward: { ...t.reward } },
      });
    }
  }

  /** The C5 / C6 mission rows of a record. */
  missionsOf(playerId: string): ReturnType<typeof missionRows> {
    const p = this.rec(playerId);
    if (!p) return [];
    return missionRows(this.missionDayOf(p), this.missionTemplatesOf(p));
  }

  /**
   * Can this mission be claimed now? (C6) It must be one of TODAY's (Denver)
   * three missions of this account, complete, and not claimed yet. The claim
   * itself is the ledger transaction (economyDb.settleMissionClaim).
   */
  missionClaimCheck(userId: number, missionIdRaw: unknown):
    | { ok: true; dateKey: string; templateId: string; reward: { chips: number; xp: number; stars: number } }
    | { ok: false; code: 'progress_loading' | 'mission_not_found' | 'mission_expired' | 'mission_incomplete' | 'already_claimed' } {
    const p = this.userRecord(userId);
    if (!p || !p.hydrated) return { ok: false, code: 'progress_loading' };
    const parsed = parseMissionId(missionIdRaw);
    if (!parsed) return { ok: false, code: 'mission_not_found' };
    const day = this.missionDayOf(p);
    if (parsed.dateKey !== day.date) return { ok: false, code: 'mission_expired' };
    if (!this.missionTemplatesOf(p).includes(parsed.templateId)) return { ok: false, code: 'mission_not_found' };
    const t = missionTemplate(parsed.templateId);
    if (!t) return { ok: false, code: 'mission_not_found' };
    if (day.claimed.includes(t.id)) return { ok: false, code: 'already_claimed' };
    if ((day.progress[t.id] || 0) < t.target) return { ok: false, code: 'mission_incomplete' };
    return { ok: true, dateKey: day.date, templateId: t.id, reward: { ...t.reward } };
  }

  /** Mirror a committed mission claim: mark it claimed, grant its XP. */
  markMissionClaimed(userId: number, dateKey: string, templateId: string, xp: number): void {
    const p = this.userRecord(userId);
    if (!p) return;
    const day = this.missionDayOf(p);
    if (day.date === dateKey && !day.claimed.includes(templateId)) day.claimed.push(templateId);
    if (xp > 0) this.addXP(p.playerId, xp);
  }

  // ───────────────────────── achievements ─────────────────────────

  checkAchievements(playerId: string): void {
    const progress = this.rec(playerId);
    if (!progress) return;
    // Roll daily/weekly windows lazily so checks always run against the current window.
    this.rollAchievementWindows(progress);
    const inner = this.inner(progress);
    const now = this.now();
    const blocked = (pk: string) => {
      const until = inner.achRetryAfter.get(pk);
      if (until === undefined) return false;
      if (until <= now) { inner.achRetryAfter.delete(pk); return false; }
      return true;
    };

    // Lifetime achievements
    for (const achDef of ACHIEVEMENTS) {
      if (progress.achievements.includes(achDef.id)) continue;
      const pk = `lifetime:${achDef.id}:`;
      if (inner.pendingAch.has(pk) || blocked(pk)) continue;
      if (!achDef.check(progress)) continue;
      this.payAchievement(progress, 'lifetime', achDef, '', pk);
    }

    // Daily achievements
    for (const achDef of DAILY_ACHIEVEMENTS) {
      if (progress.dailyAchievementsToday.includes(achDef.id)) continue;
      const pk = `daily:${achDef.id}:${progress.dailyStatsDate}`;
      if (inner.pendingAch.has(pk) || blocked(pk)) continue;
      if (!achDef.check(progress)) continue;
      progress.dailyAchievementsToday.push(achDef.id);
      this.payAchievement(progress, 'daily', achDef, progress.dailyStatsDate, pk);
    }

    // Weekly achievements
    for (const achDef of WEEKLY_ACHIEVEMENTS) {
      if (progress.weeklyAchievementsThisWeek.includes(achDef.id)) continue;
      const pk = `weekly:${achDef.id}:${progress.weeklyStatsWeekStart}`;
      if (inner.pendingAch.has(pk) || blocked(pk)) continue;
      if (!achDef.check(progress)) continue;
      progress.weeklyAchievementsThisWeek.push(achDef.id);
      this.payAchievement(progress, 'weekly', achDef, progress.weeklyStatsWeekStart, pk);
    }
  }

  /**
   * Show the reward now (optimistic) and settle it through its ledger
   * (persistChipReward → settleRewardLedger). A LIFETIME id is not added to
   * `achievements` until the ledger confirms — the hand-complete save writes
   * `achievements`, and an id stored before the ledger row would read as
   * "already paid" and lose the reward.
   */
  private payAchievement(
    progress: PlayerProgress, category: AchievementCategory, def: AchievementDef | WindowedAchievementDef, windowKey: string, pendingKey: string,
  ): void {
    const inner = this.inner(progress);
    inner.pendingAch.add(pendingKey);
    const optimisticChips = this.boostChipReward(progress, def.reward.chips);
    const optimisticStars = def.reward.stars || 0;
    progress.chips += optimisticChips;
    progress.stars += optimisticStars;
    inner.pendChips += optimisticChips;
    inner.pendStars += optimisticStars;
    this.persistChipReward(progress, def.reward.chips, {
      category, def: def as AchievementDef, windowKey, pendingKey, optimisticChips, optimisticStars,
    });
  }

  /** Reset dailyStats / weeklyStats lazily if the window has rolled over. */
  private rollAchievementWindows(progress: PlayerProgress): void {
    const nowD = new Date(this.now());
    const today = utcDateKey(nowD);
    if (progress.dailyStatsDate !== today) {
      progress.dailyStats = emptyDailyStats();
      progress.dailyStatsDate = today;
      progress.dailyAchievementsToday = [];
    }
    const weekStart = utcWeekStartKey(nowD);
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
    const progress = this.rec(playerId);
    if (!progress) return null;
    this.rollAchievementWindows(progress);

    const now = new Date(this.now());
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
      progressMet: (def as any).check ? (def as any).check(progress) : false,
    }));

    return {
      daily:    summarize(DAILY_ACHIEVEMENTS,    progress.dailyAchievementsToday),
      weekly:   summarize(WEEKLY_ACHIEVEMENTS,   progress.weeklyAchievementsThisWeek),
      lifetime: summarize(ACHIEVEMENTS,          progress.achievements),
      windowEndsAt: { daily: dailyEnd, weekly: weekEnd },
    };
  }

  // ───────────────────────── persistence snapshots ─────────────────────────

  /**
   * The stats patch the hand-complete save MERGES (mergeUserStats monotonic,
   * progressMerge rules): every counter, the HUD maps, the dated achievement
   * windows, today's mission progress and the rating. Never the wallet or the
   * entitlements (their own transactions write those).
   */
  persistStatsPatch(playerId: string): Record<string, unknown> {
    const p = this.rec(playerId);
    if (!p) return {};
    const out: Record<string, unknown> = {};
    for (const [sk, field] of ADDITIVE_COUNTERS) out[sk] = num((p as any)[field]);
    for (const [sk, field] of MAX_COUNTERS) out[sk] = num((p as any)[field]);
    out.variantsPlayed = [...(p.variantsPlayed || [])];
    out.actionCounts = { ...(p.actionCounts || {}) };
    out.handsPerRank = { ...(p.handsPerRank || {}) };
    out.positionWins = JSON.parse(JSON.stringify(p.positionWins || {}));
    out.dailyStats = { ...p.dailyStats };
    out.dailyStatsDate = p.dailyStatsDate;
    out.weeklyStats = { ...p.weeklyStats };
    out.weeklyStatsWeekStart = p.weeklyStatsWeekStart;
    const day = this.missionDayOf(p);
    out.missions = { date: day.date, progress: { ...day.progress } };
    out.elo = p.elo;
    out.rank = p.rank;
    out.eloHistory = (p.eloHistory || []).slice(-30);
    return out;
  }

  // ───────────────────────── VIP / cosmetics views (C7 / C8) ─────────────────────────

  /**
   * Cumulative ("season") XP: total XP earned to reach the current level plus
   * progress into it. Battle-pass tiers unlock at 500 XP each; getClientProgress
   * emits this as `totalXp` and claimBattlePassTier gates on it.
   */
  private seasonXpFor(progress: { level: number; xp: number }): number {
    let total = Math.max(0, progress.xp || 0);
    for (let lvl = 1; lvl < progress.level; lvl++) {
      const req = xpRequiredForLevel(lvl);
      if (!Number.isFinite(req)) break;
      total += req;
    }
    return total;
  }

  /** The loyalty XP-rate multiplier by cumulative season XP (Bronze 1x … Platinum 3x). */
  private vipXpRate(progress: PlayerProgress): number {
    return vipTierForSeasonXp(this.seasonXpFor(progress)).rate;
  }

  getSeasonXp(playerId: string): number {
    const progress = this.rec(playerId);
    if (!progress) return 0;
    return this.seasonXpFor(progress);
  }

  /** Is the account's VIP pass active? */
  vipActive(p: PlayerProgress | undefined): boolean {
    return !!p && num(p.vipExpiresAt) > this.now();
  }

  /** C8 — the VIP block of the C5 payload. */
  vipView(p: PlayerProgress): {
    active: boolean; tier: string; xpRate: number; expiresAt: number | null; perks: string[];
    loginMultiplier: number; monthlyBonus: number; monthlyClaimed: boolean; monthKey: string;
  } {
    const tier = vipTierForSeasonXp(this.seasonXpFor(p));
    const active = this.vipActive(p);
    const monthKey = denverMonthKey(this.now());
    const perks: string[] = active ? [...VIP_PASS_PERKS] : [];
    if (tier.rate > 1) perks.push('xp_rate');
    return {
      active,
      tier: tier.name,
      xpRate: tier.rate,
      expiresAt: active ? num(p.vipExpiresAt) : null,
      perks,
      loginMultiplier: active ? VIP_LOGIN_MULTIPLIER : 1,
      monthlyBonus: VIP_MONTHLY_BONUS_CHIPS,
      monthlyClaimed: p.vipMonthlyClaimedMonth === monthKey,
      monthKey,
    };
  }

  /** Emotes the account can use on the wheel: the free ones, owned shop emotes, VIP emotes while VIP. */
  usableEmotes(p: PlayerProgress): string[] {
    const owned = [...(p.owned || [])].filter((k) => k.startsWith('emote:')).map((k) => k.slice('emote:'.length));
    const vip = this.vipActive(p) ? VIP_EMOTES : [];
    return Array.from(new Set([...FREE_EMOTES, ...owned, ...vip]));
  }

  canUseEmote(userId: number, emoteId: string): boolean {
    const p = this.userRecord(userId);
    if (!p) return FREE_EMOTES.includes(emoteId);
    return this.usableEmotes(p).includes(emoteId);
  }

  /** C7 — what other players see at this account's seat (null slots = default look). */
  seatCosmetics(userId: number): { frame: string | null; title: string | null; cardBack: string | null; badge: string | null; vip: boolean } | null {
    const p = this.userRecord(userId);
    if (!p || !p.hydrated) return null;
    const eq = p.equipped || {};
    return {
      frame: eq.frame ?? null,
      title: eq.title ?? null,
      cardBack: eq.card_back ?? null,
      badge: eq.badge ?? null,
      vip: this.vipActive(p),
    };
  }

  /** C7 — the equipped table theme (per-player `myTheme`). */
  equippedTheme(userId: number): string | null {
    const p = this.userRecord(userId);
    return p?.hydrated ? (p.equipped?.theme ?? null) : null;
  }

  // ───────────────────────── client payload (C5) ─────────────────────────

  /**
   * The `playerProgress` payload (C5). Keys of the pre-R2 payload are kept
   * (older clients); the C5 keys are added. Never anything another player may
   * not see — this goes only to the account's own sockets.
   */
  getClientProgress(playerId: string): object | null {
    const progress = this.rec(playerId);
    if (!progress) return null;
    const now = this.now();
    const missions = this.missionsOf(playerId);
    const day = this.missionDayOf(progress);
    const owned = [...(progress.owned || [])].sort();
    const eq = progress.equipped || {};
    const boostersArr = Object.entries(progress.activeBoosters || {})
      .filter(([, b]) => b && b.expiresAt > now)
      .map(([type, b]) => ({ type, multiplier: b.mult, expiresAt: b.expiresAt }));
    const dailyMissions = missions.map((m) => ({ ...m }));

    return {
      playerId: progress.playerId,
      playerName: progress.playerName,
      hydrated: progress.hydrated,
      level: progress.level,
      xp: progress.xp,
      xpToNextLevel: progress.xpToNextLevel,
      // Cumulative season XP for the battle-pass UI (client reads totalXp).
      totalXp: this.seasonXpFor(progress),
      totalHandsPlayed: progress.totalHandsPlayed,
      handsWon: progress.handsWon,
      winRate: winRateOf(progress),
      biggestPot: progress.biggestPot,
      currentStreak: progress.currentStreak,
      bestStreak: progress.bestStreak,
      achievements: progress.achievements,
      // C6 — today's (Denver) missions; `dailyMissions` is the same list under the pre-R2 key.
      missions,
      dailyMissions,
      dailyMissionsDate: day.date,
      dailyMissionsRefreshAt: nextDenverMidnightMs(now),
      chips: progress.chips,
      stars: progress.stars,
      scratchCardsAvailable: progress.scratchCardsAvailable ?? 0,
      dailyLoginStreak: progress.dailyLoginStreak,
      lastLoginDate: progress.lastLoginDate,
      loginStreak: progress.dailyLoginStreak,
      lastLoginClaimDate: progress.lastLoginClaimDate ?? null,
      dailySpinClaimed: progress.spinClaimedDate === denverDateKey(now),
      battlePassPremium: !!progress.battlePassPremium,
      vip: this.vipView(progress),
      vipExpiresAt: num(progress.vipExpiresAt),
      activeBoosters: boostersArr,
      chipBoostedRewards: CHIP_BOOSTED_REWARDS,
      equipped: {
        theme: eq.theme ?? null,
        cardBack: eq.card_back ?? null,
        frame: eq.frame ?? null,
        title: eq.title ?? null,
        badge: eq.badge ?? null,
        chipSkin: eq.chip_skin ?? null,
        cardFront: eq.card_front ?? null,
        dealerVoice: eq.dealer_voice ?? null,
        profileBg: eq.profile_bg ?? null,
        soundPack: eq.sound_pack ?? null,
        celebration: eq.celebration ?? null,
        emotes: this.usableEmotes(progress),
      },
      owned,
      badges: owned.filter((k) => k.startsWith('badge:')).map((k) => k.slice('badge:'.length)),
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
      eloHistory: progress.eloHistory || [],
    };
  }

  /** Every loaded record's account id (for sweeps). */
  loadedUserIds(): number[] {
    const out: number[] = [];
    for (const p of this.progressMap.values()) if (p.userId) out.push(p.userId);
    return out;
  }

  /** Price of a sellable item — re-exported for handlers that only hold the manager. */
  static shopPrice(itemType: string, itemId: string): number | null {
    const prices = SHOP_PRICES[itemType];
    return prices && Object.prototype.hasOwnProperty.call(prices, itemId) ? prices[itemId] : null;
  }
}

interface AchievementLedgerRef {
  category: AchievementCategory;
  def: AchievementDef;
  windowKey: string;
  pendingKey: string;
  optimisticChips: number;
  optimisticStars: number;
}

/** Win % (0-100, one decimal) from the lifetime counters. */
function winRateOf(p: PlayerProgress): number {
  const th = p.totalHandsPlayed || 0;
  return th > 0 ? Math.round(((p.handsWon || 0) / th) * 1000) / 10 : 0;
}

function liveBoosters(raw: unknown, now: number): Record<string, { mult: number; expiresAt: number }> {
  const out: Record<string, { mult: number; expiresAt: number }> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (v && Number(v.expiresAt) > now && Number(v.mult) > 0) out[k] = { mult: Number(v.mult), expiresAt: Number(v.expiresAt) };
  }
  return out;
}

function mergeCounterMaps(db: unknown, mem: Record<string, number> | undefined, add: boolean): Record<string, number> {
  const out: Record<string, number> = { ...(mem || {}) };
  if (db && typeof db === 'object') {
    for (const [k, v] of Object.entries(db as Record<string, unknown>)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = add ? n + (out[k] || 0) : Math.max(n, out[k] || 0);
    }
  }
  return out;
}

function mergePositionWins(
  db: unknown, mem: Record<string, { wins: number; total: number }> | undefined, add: boolean,
): Record<string, { wins: number; total: number }> {
  const out: Record<string, { wins: number; total: number }> = {};
  for (const [k, v] of Object.entries(mem || {})) out[k] = { wins: v.wins, total: v.total };
  if (db && typeof db === 'object') {
    for (const [k, v] of Object.entries(db as Record<string, any>)) {
      if (!v || typeof v !== 'object') continue;
      const cur = out[k] || { wins: 0, total: 0 };
      out[k] = add
        ? { wins: num(v.wins) + cur.wins, total: num(v.total) + cur.total }
        : { wins: Math.max(num(v.wins), cur.wins), total: Math.max(num(v.total), cur.total) };
    }
  }
  return out;
}

// Re-exported for tests / handlers that type mission rows.
export type { Mission, MissionType };

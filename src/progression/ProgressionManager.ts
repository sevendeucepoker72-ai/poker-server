import { PlayerProgress, Mission, MissionType } from './PlayerProgress';
import { persistStars as dbPersistStars, loadDurableProgress, loadInventory, loadProgress as dbLoadProgress } from '../auth/authManager';

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

const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'first_win',
    name: 'First Blood',
    description: 'Win your first hand',
    check: (p) => p.handsWon >= 1,
    reward: { xp: 100, chips: 1000 },
  },
  {
    id: 'high_roller',
    name: 'High Roller',
    description: 'Win a pot over 50,000',
    check: (p) => p.biggestPot >= 50000,
    reward: { xp: 500, chips: 5000 },
  },
  {
    id: 'streak_5',
    name: 'Hot Streak',
    description: 'Win 5 hands in a row',
    check: (p) => p.bestStreak >= 5,
    reward: { xp: 300, chips: 3000 },
  },
  {
    id: 'streak_10',
    name: 'Unstoppable',
    description: 'Win 10 hands in a row',
    check: (p) => p.bestStreak >= 10,
    reward: { xp: 1000, chips: 10000 },
  },
  {
    id: 'hands_100',
    name: 'Card Shark',
    description: 'Play 100 hands',
    check: (p) => p.totalHandsPlayed >= 100,
    reward: { xp: 200, chips: 2000 },
  },
  {
    id: 'hands_1000',
    name: 'Veteran',
    description: 'Play 1000 hands',
    check: (p) => p.totalHandsPlayed >= 1000,
    reward: { xp: 1000, chips: 10000 },
  },
  {
    id: 'royal_flush',
    name: 'Royal Flush!',
    description: 'Get a Royal Flush',
    check: () => false, // checked manually via hand rank
    reward: { xp: 5000, chips: 50000, stars: 100 },
  },
  {
    id: 'bluff_master',
    name: 'Bluff Master',
    description: 'Win 10 hands where you had less than one pair',
    check: (p) => p.bluffWins >= 10,
    reward: { xp: 500, chips: 5000 },
  },
  {
    id: 'all_in_warrior',
    name: 'All-In Warrior',
    description: 'Go all-in and win 20 times',
    check: (p) => p.allInWins >= 20,
    reward: { xp: 400, chips: 4000 },
  },
  {
    id: 'social_butterfly',
    name: 'Social Butterfly',
    description: 'Send 50 chat messages',
    check: (p) => p.chatMessagesSent >= 50,
    reward: { xp: 100, chips: 1000 },
  },
];

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
      xpToNextLevel: 100,
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
        if (typeof u.level === 'number' && u.level > 0) progress.level = u.level;
        if (typeof u.xp === 'number' && u.xp >= 0) progress.xp = u.xp;
        // xpToNextLevel scales with level
        progress.xpToNextLevel = Math.max(100, progress.level * 100);
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
        }
      }
    } catch (e: any) {
      console.warn(`[ProgressionManager.hydrateFromDB progress ${userId}]`, e?.message);
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

    progress.xp += amount;

    while (progress.xp >= progress.xpToNextLevel) {
      progress.xp -= progress.xpToNextLevel;
      progress.level++;
      progress.xpToNextLevel = progress.level * 100;

      const bonusChips = progress.level * 500;
      const bonusStars = progress.level * 5;
      progress.chips += bonusChips;
      progress.stars += bonusStars;
      this.persistStars(progress);

      this.pushEvent(playerId, {
        type: 'levelUp',
        data: {
          newLevel: progress.level,
          bonusChips,
          bonusStars,
        },
      });
    }
  }

  recordHandPlayed(playerId: string): void {
    const progress = this.progressMap.get(playerId);
    if (!progress) return;

    progress.totalHandsPlayed++;
    (progress as any).lastHandAt = Date.now();

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
    if (handRank !== undefined && handRank < 1) {
      progress.bluffWins++;
    }

    if (wasAllIn) {
      progress.allInWins++;
    }

    // Track hand rank distribution
    if (handRank !== undefined) {
      const rankNames: Record<number, string> = {
        0: 'High Card', 1: 'One Pair', 2: 'Two Pair', 3: 'Three of a Kind',
        4: 'Straight', 5: 'Flush', 6: 'Full House', 7: 'Four of a Kind',
        8: 'Straight Flush', 9: 'Royal Flush',
      };
      const rankName = rankNames[handRank] || 'Unknown';
      progress.handsPerRank[rankName] = (progress.handsPerRank[rankName] || 0) + 1;
    }

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

    for (const achDef of ACHIEVEMENTS) {
      if (progress.achievements.includes(achDef.id)) continue;
      if (achDef.id === 'royal_flush') continue; // handled separately

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
            id: achDef.id,
            name: achDef.name,
            description: achDef.description,
            reward: achDef.reward,
          },
        });
      }
    }
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

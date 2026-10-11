/**
 * .online R2 (S3, 2026-10-11) — the pure economy rules: the catalog every
 * grant and equip is checked against (C7 / ECON-16 / career / mystery /
 * scratch / bundles), the Denver calendar (ECON-4 / C6 / C8 / C9), the
 * deterministic daily missions (C6) and the no-last-writer-wins stats merge
 * (ECON-10).
 */
import {
  SHOP_PRICES, BUNDLE_CONTENTS, CAREER_REWARDS, MYSTERY_BOX_TIERS, SCRATCH_EMOTE_POOL, SEASON_REWARDS, SEASON_BADGES,
  VIP_EMOTES, FREE_EMOTES, EQUIPPABLE_TYPES, BOOSTER_DURATION, VIP_PASS_DURATION, SPIN_WHEEL_SEGMENTS,
  LOGIN_CHIPS_BY_DAY, LOGIN_STARS_BY_DAY, CHIP_GRANT_ALERT_THRESHOLD,
  isOwnableItem, shopPrice, isFreeItem, isFreeForEveryone, normalizeItemType, rollMysteryBox, rollSpinWheel, rollScratchCard, loginCycleDay,
  vipTierForSeasonXp, catalogForClient,
} from '../src/economy/catalog';
import {
  denverDateKey, denverMonthKey, previousDenverMonthKey, nextDenverMidnightMs, nextDenverMonthStartMs, monthDateRange,
  denverWeekRange, addDaysToDateKey, denverWallTimeToMs,
} from '../src/economy/denverTime';
import {
  MISSION_TEMPLATES, missionTemplateIdsFor, applyMissionProgress, missionRows, emptyMissionDay, parseMissionId, missionClaimKey,
} from '../src/progression/missions';
import { mergeProgressStats, isProgressRuleKey } from '../src/progression/progressMerge';

const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

describe('catalog (C7 / ECON-16): every grant names a real, renderable catalog item', () => {
  it('Battle Pass premium milestone items, career rewards, mystery-box pools, scratch emotes, bundles and season badges are all ownable catalog items', () => {
    const bpPremium: Array<[string, string]> = [['card_back', 'dragon'], ['emote', 'trophy'], ['theme', 'neon_vegas'], ['frame', 'diamond'], ['title', 'royal']];
    const all: Array<[string, string]> = [
      ...bpPremium,
      ...CAREER_REWARDS.filter((r) => r.item).map((r) => r.item!),
      ...Object.values(MYSTERY_BOX_TIERS).flatMap((t) => t.itemPool),
      ...SCRATCH_EMOTE_POOL.map((id) => ['emote', id] as [string, string]),
      ...Object.values(BUNDLE_CONTENTS).flat(),
      ...SEASON_REWARDS.map((r) => ['badge', r.badge] as [string, string]),
      ...VIP_EMOTES.map((id) => ['emote', id] as [string, string]),
    ];
    const bad = all.filter(([t, id]) => !isOwnableItem(t, id));
    expect(bad).toEqual([]);
    // The pre-R2 ids that matched NO catalog item are not grantable any more.
    for (const [t, id] of [['emote', 'legendary_pack'], ['title', 'season_champion'], ['card_back', 'career_local_casino'], ['theme', 'career_macau']]) {
      expect(isOwnableItem(t, id)).toBe(false);
    }
    expect(isOwnableItem('avatar_frame', 'diamond')).toBe(true);   // legacy type → 'frame'
    expect(normalizeItemType('avatar_frame')).toBe('frame');
  });

  it('prices: server-side only; consumables / passes / packs are not ownable cosmetics; free items are owned by everyone', () => {
    expect(shopPrice('theme', 'cosmic_nebula')).toBe(1500);
    expect(shopPrice('theme', 'made_up')).toBeNull();          // no `?? 400` default
    expect(shopPrice('frame', '__proto__')).toBeNull();
    for (const [t, id] of [['chip_pack', 'small'], ['booster', 'xp_2x_1h'], ['vip_pass', 'daily'], ['bundle', 'starter'], ['mystery_box', 'basic']]) {
      expect(shopPrice(t, id)).not.toBeNull();
      expect(isOwnableItem(t, id)).toBe(false);
    }
    expect(isFreeItem('theme', 'green_felt')).toBe(true);
    expect(isFreeItem('theme', 'royal_gold')).toBe(false);
    expect(isOwnableItem('badge', 'season_gold')).toBe(true);
    expect(shopPrice('badge', 'season_gold')).toBeNull();     // never sold
    for (const t of ['card_back', 'theme', 'frame', 'title', 'badge']) expect(EQUIPPABLE_TYPES.has(t)).toBe(true);
    expect(EQUIPPABLE_TYPES.has('emote')).toBe(false);
    for (const id of Object.keys(SHOP_PRICES.booster)) expect(BOOSTER_DURATION[id]).toBeDefined();
    for (const id of Object.keys(SHOP_PRICES.vip_pass)) expect(VIP_PASS_DURATION[id]).toBeGreaterThan(0);
    expect(CHIP_GRANT_ALERT_THRESHOLD).toBe(1_000_000);
    const c = catalogForClient();
    expect(c.prices.theme.royal_gold).toBe(800);
    expect(c.rewardOnly.badge.sort()).toEqual(Object.keys(SEASON_BADGES).sort());
    expect(c.vipEmotes).toEqual(VIP_EMOTES);
    expect(c.freeEmotes).toEqual(FREE_EMOTES);
    expect(c.chipBoostedRewards).toEqual(['level_up', 'achievement', 'mission', 'daily_login', 'daily_spin', 'scratch_card']);
  });

  it('reward rolls are the documented tables (deterministic with an injected rng)', () => {
    expect(rollMysteryBox('basic', seq(0.1, 0.5))).toEqual({ kind: 'chips', amount: 15000 });
    expect(rollMysteryBox('basic', seq(0.6, 0.0))).toEqual({ kind: 'stars', amount: 50 });
    expect(rollMysteryBox('legendary', seq(0.9, 0.99))).toEqual({ kind: 'item', itemType: 'card_back', itemId: 'mythic' });
    expect(rollMysteryBox('nope', seq(0.1, 0))).toEqual({ kind: 'chips', amount: 5000 });   // unknown tier = basic
    expect(SPIN_WHEEL_SEGMENTS.reduce((s, x) => s + x.weight, 0)).toBe(100);
    expect(rollSpinWheel(seq(0)).id).toBe('stars_100');
    expect(rollSpinWheel(seq(0.049)).id).toBe('stars_100');
    expect(rollSpinWheel(seq(0.05)).id).toBe('stars_25');
    expect(rollSpinWheel(seq(0.74)).id).toBe('chips_2500');
    expect(rollSpinWheel(seq(0.999)).id).toBe('chips_10000');
    expect(rollScratchCard(seq(0.1, 0.5))).toEqual({ kind: 'stars', amount: 30 });
    expect(rollScratchCard(seq(0.25, 0.99))).toEqual({ kind: 'item', itemType: 'emote', itemId: 'crown' });
    expect(rollScratchCard(seq(0.5, 0.0))).toEqual({ kind: 'chips', amount: 1000 });
  });

  it('login table: day 1..7 cycle (Day 7 = 20,000 chips + 50 stars + a basic Mystery Box); VIP tiers by season XP', () => {
    expect([1, 2, 7, 8, 14, 15].map(loginCycleDay)).toEqual([1, 2, 7, 1, 7, 1]);
    expect([LOGIN_CHIPS_BY_DAY[7], LOGIN_STARS_BY_DAY[7]]).toEqual([20000, 50]);
    expect([0, 999, 1000, 5000, 20000].map((x) => vipTierForSeasonXp(x).name)).toEqual(['Bronze', 'Bronze', 'Silver', 'Gold', 'Platinum']);
    expect(vipTierForSeasonXp(25000).rate).toBe(3);
  });
});

describe('the Denver calendar (ECON-4 / C6 / C8 / C9)', () => {
  // 2026-10-12T04:30Z = 2026-10-11 22:30 MDT (UTC-6): a UTC-evening claim.
  const EVENING = Date.UTC(2026, 9, 12, 4, 30);
  it('the Denver date of a UTC-next-day instant is still "today" in Denver (the old UTC "yesterday" reset 45 of 51 evening streaks)', () => {
    expect(new Date(EVENING).toISOString().slice(0, 10)).toBe('2026-10-12');
    expect(denverDateKey(EVENING)).toBe('2026-10-11');
    expect(denverMonthKey(EVENING)).toBe('2026-10');
  });

  it('midnight / month rollovers, DST, previous month, ranges', () => {
    expect(new Date(nextDenverMidnightMs(EVENING)).toISOString()).toBe('2026-10-12T06:00:00.000Z');   // MDT
    expect(new Date(denverWallTimeToMs(2026, 12, 1)).toISOString()).toBe('2026-12-01T07:00:00.000Z');   // MST
    expect(new Date(nextDenverMonthStartMs(Date.UTC(2026, 9, 31, 12))).toISOString()).toBe('2026-11-01T06:00:00.000Z');
    // 2026-11-01 is the DST end day: 00:00 is still MDT (UTC-6).
    expect(new Date(nextDenverMidnightMs(Date.UTC(2026, 10, 1, 7))).toISOString()).toBe('2026-11-02T07:00:00.000Z');
    expect(previousDenverMonthKey(Date.UTC(2026, 0, 15))).toBe('2025-12');
    expect(previousDenverMonthKey(Date.UTC(2026, 10, 1, 5))).toBe('2026-09');   // still Oct 31 in Denver
    expect(monthDateRange('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(monthDateRange('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(monthDateRange('2026-13')).toBeNull();
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(denverWeekRange(EVENING)).toEqual({ first: '2026-10-11', last: '2026-10-17' });   // Sunday start
  });
});

describe('daily missions (C6): per user per Denver day, deterministic', () => {
  it('the same account gets the same three missions all day (every device, every restart); another day / account differs; one per group', () => {
    const a = missionTemplateIdsFor(42, '2026-10-11');
    expect(a).toHaveLength(3);
    expect(missionTemplateIdsFor(42, '2026-10-11')).toEqual(a);
    const groups = a.map((id) => MISSION_TEMPLATES.find((t) => t.id === id)!.group);
    expect(new Set(groups).size).toBe(3);
    const variety = new Set<string>();
    for (let d = 1; d <= 20; d++) variety.add(missionTemplateIdsFor(42, `2026-10-${String(d).padStart(2, '0')}`).join(','));
    expect(variety.size).toBeGreaterThan(5);
    expect(MISSION_TEMPLATES.some((t) => /fold/i.test(t.description))).toBe(false);   // no AFK-farmable mission
  });

  it('progress: played / won / pot / rank / bluff / streak / all-in; completion is reported once; rows carry the C6 shape', () => {
    const day = emptyMissionDay('2026-10-11');
    const ids = ['play_10', 'pot_5k', 'streak_3', 'allin_3', 'flush_plus', 'bluff_1', 'win_3'];
    for (let i = 0; i < 9; i++) expect(applyMissionProgress(day, ids, { played: true })).toEqual([]);
    expect(applyMissionProgress(day, ids, { played: true })).toEqual(['play_10']);
    expect(applyMissionProgress(day, ids, { played: true })).toEqual([]);               // already complete
    expect(applyMissionProgress(day, ids, { win: { potWon: 4999, handRank: 1, currentStreak: 1 } })).toEqual([]);
    expect(applyMissionProgress(day, ids, { win: { potWon: 5000, handRank: 5, currentStreak: 2 } }).sort()).toEqual(['flush_plus', 'pot_5k']);
    expect(applyMissionProgress(day, ids, { win: { potWon: 10, handRank: 0, currentStreak: 3 } }).sort()).toEqual(['bluff_1', 'streak_3', 'win_3']);
    expect(applyMissionProgress(day, ids, { allIns: 2 })).toEqual([]);
    expect(applyMissionProgress(day, ids, { allIns: 2 })).toEqual(['allin_3']);
    day.claimed.push('play_10');
    const rows = missionRows(day, ['play_10', 'allin_3']);
    expect(rows[0]).toEqual({
      id: '2026-10-11:play_10', templateId: 'play_10', type: 'play_hands', description: 'Play 10 hands',
      progress: 10, target: 10, reward: { chips: 500, xp: 50, stars: 0 }, completed: true, claimed: true,
    });
    expect(rows[1]).toMatchObject({ progress: 3, target: 3, completed: true, claimed: false });
    expect(parseMissionId('2026-10-11:play_10')).toEqual({ dateKey: '2026-10-11', templateId: 'play_10' });
    for (const bad of ['', 'play_10', '2026-10-11:', "2026-10-11:x'; drop", 5, null]) expect(parseMissionId(bad)).toBeNull();
    expect(missionClaimKey('2026-10-11', 'win_3')).toBe('mission:2026-10-11:win_3');
  });
});

describe('progress stats merge (ECON-10): never last-writer-wins', () => {
  it('counters max, sets union, maps per-key max, positions per-field max, windows newest, boosters later expiry, BP flag OR, other keys overwrite', () => {
    const existing = {
      handsPlayed: 500, handsWon: 50, biggestPot: 9000, vipExpiresAt: 2000, masterUserId: 'm-1', elo: 600,
      variantsPlayed: ['holdem'], actionCounts: { fold: 10, call: 5 }, positionWins: { early: { wins: 2, total: 9 } },
      dailyStats: { handsPlayed: 30, variantsPlayedToday: ['holdem'] }, dailyStatsDate: '2026-10-11',
      weeklyStats: { handsPlayed: 300 }, weeklyStatsWeekStart: '2026-10-11',
      missions: { date: '2026-10-11', progress: { play_10: 7 } },
      activeBoosters: { xp: { mult: 2, expiresAt: 500 } }, battlePassPremium: true,
    };
    const stale = {
      handsPlayed: 480, handsWon: 55, biggestPot: 100, vipExpiresAt: 1000, elo: 590,
      variantsPlayed: ['omaha'], actionCounts: { fold: 8, raise: 4 }, positionWins: { early: { wins: 3, total: 4 }, late: { wins: 1, total: 1 } },
      dailyStats: { handsPlayed: 12, variantsPlayedToday: ['omaha'] }, dailyStatsDate: '2026-10-11',
      weeklyStats: { handsPlayed: 999 }, weeklyStatsWeekStart: '2026-10-04',          // an OLDER week
      missions: { date: '2026-10-11', progress: { play_10: 9, win_3: 1 } },
      activeBoosters: { xp: { mult: 2, expiresAt: 400 }, chip: { mult: 1.5, expiresAt: 900 } }, battlePassPremium: false,
    };
    const m = mergeProgressStats(existing, stale);
    expect(m).toMatchObject({
      handsPlayed: 500, handsWon: 55, biggestPot: 9000, vipExpiresAt: 2000, masterUserId: 'm-1', elo: 590,
      variantsPlayed: ['holdem', 'omaha'], actionCounts: { fold: 10, call: 5, raise: 4 },
      positionWins: { early: { wins: 3, total: 9 }, late: { wins: 1, total: 1 } },
      dailyStats: { handsPlayed: 30, variantsPlayedToday: ['holdem', 'omaha'] }, dailyStatsDate: '2026-10-11',
      weeklyStats: { handsPlayed: 300 }, weeklyStatsWeekStart: '2026-10-11',
      missions: { date: '2026-10-11', progress: { play_10: 9, win_3: 1 } },
      activeBoosters: { xp: { mult: 2, expiresAt: 500 }, chip: { mult: 1.5, expiresAt: 900 } }, battlePassPremium: true,
    });
    // A NEWER window / mission day replaces the stored one.
    const next = mergeProgressStats(m, { dailyStats: { handsPlayed: 1 }, dailyStatsDate: '2026-10-12', missions: { date: '2026-10-12', progress: { win_5: 1 } } });
    expect(next).toMatchObject({ dailyStats: { handsPlayed: 1 }, dailyStatsDate: '2026-10-12', missions: { date: '2026-10-12', progress: { win_5: 1 } } });
    expect(mergeProgressStats(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeProgressStats({ a: 1 }, 'junk')).toEqual({ a: 1 });
    expect(isProgressRuleKey('handsPlayed')).toBe(true);
    expect(isProgressRuleKey('clientData')).toBe(false);
    expect(isProgressRuleKey('masterUserId')).toBe(false);
  });
});

describe('free wheel emotes the shop also lists (fire, dead) are never sold or won', () => {
  it('isFreeForEveryone: the free wheel emotes and price-0 items; a priced shop-only emote is not', () => {
    const overlap = Object.keys(SHOP_PRICES.emote).filter((id) => FREE_EMOTES.includes(id));
    expect(overlap.sort()).toEqual(['dead', 'fire']);           // the owner call: rename or drop these two
    for (const id of overlap) expect(isFreeForEveryone('emote', id)).toBe(true);
    expect(isFreeForEveryone('emote', 'nice_hand')).toBe(false);
    expect(isFreeForEveryone('card_back', 'classic_red')).toBe(true);   // price 0
    expect(isFreeForEveryone('card_back', 'mythic')).toBe(false);
    // The scratch pool and the basic box still roll `fire` — settled as a duplicate (stars), see economySettlements.
    expect(SCRATCH_EMOTE_POOL).toContain('fire');
    expect(MYSTERY_BOX_TIERS.basic.itemPool).toContainEqual(['emote', 'fire']);
  });
});

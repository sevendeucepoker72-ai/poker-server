/**
 * Bots review 2026-11-04 (economy-farming E5 part g, E12, E13) — the REAL
 * ProgressionManager on a fake DB layer (the progressionPerUser pattern):
 *   (8)  recordHandPlayed(id, v, ref, true, false) returns false first on the
 *        IDLE_HANDS_REWARD_LIMIT-th (30th) idle hand in a row; a voluntary chip
 *        resets the run; the default arguments return true (every existing
 *        caller unchanged). A hand that does not earn ticks no 'played' daily /
 *        weekly window and no play_hands mission.
 *   (9)  E13: totalHandsPlayed stops at 29 during a 40-hand idle streak;
 *        hands_100 pays only after 100 REWARDED hands.
 *   (10) E12: handXpFor(id, 1000) is HAND_XP (5) for the first 1,000 rewarded
 *        hands of the account's UTC day (the existing dailyStats window, NOT a
 *        Denver day) and HAND_XP_AFTER_CAP (1) for the 1,001st; the next UTC
 *        day's first hand is 5 again; fullPerDay 0 = always 5.
 * Plus a guard: the idle run is outside the evictable record, so evictIdle
 * (30 min offline) does not reset it.
 *
 * Fails on 0dc1b96: recordHandPlayed there takes 4 arguments and returns void,
 * and IDLE_HANDS_REWARD_LIMIT / HAND_XP / HAND_XP_AFTER_CAP / handXpFor do not
 * exist (the suite does not compile); with the 5th argument ignored, every idle
 * hand counted (40 of 40).
 */

interface FakeUser { chips: number; stars: number; level: number; xp: number; achievements: string[]; stats: Record<string, any> }
const db = {
  users: new Map<number, FakeUser>(),
  lifetime: new Set<string>(),
  windows: new Set<string>(),
  settleCalls: [] as string[],
};
const user = (id: number, over: Partial<FakeUser> = {}): FakeUser => {
  const u: FakeUser = { chips: 50000, stars: 100, level: 10, xp: 50, achievements: [], stats: {}, ...over };
  db.users.set(id, u);
  return u;
};

jest.mock('../src/economy/economyDb', () => ({
  loadProgressBundle: jest.fn(async (userId: number) => {
    const u = db.users.get(userId);
    if (!u) return null;
    return {
      userId, displayName: `Player ${userId}`, publicId: `p${String(userId).padStart(15, '0')}`, chips: u.chips, level: u.level, xp: u.xp,
      stars: u.stars, stats: JSON.parse(JSON.stringify(u.stats)), achievements: [...u.achievements],
      lifetimeLedger: [...db.lifetime].filter((k) => k.startsWith(`${userId}|`)).map((k) => k.split('|')[1]),
      loginStreak: 0, lastLoginClaimDate: null, scratchCardsAvailable: 0, inventory: [], dailyAchievementIds: [], weeklyAchievementIds: [],
      missionClaims: [], spinClaimedToday: false, vipMonthlyClaimed: false, battlePassPremium: false,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      denverToday: require('../src/economy/denverTime').denverDateKey(), denverMonth: require('../src/economy/denverTime').denverMonthKey(),
    };
  }),
  settleAchievementReward: jest.fn(async (userId: number, category: string, achId: string, windowKey: string, reward: { chips: number; stars: number }) => {
    db.settleCalls.push(`${userId}:${category}:${achId}`);
    const u = db.users.get(userId)!;
    const key = category === 'lifetime' ? `${userId}|${achId}` : `${userId}|${category}|${achId}|${windowKey}`;
    const ledger = category === 'lifetime' ? db.lifetime : db.windows;
    if (ledger.has(key)) return { status: 'already', chips: 0, stars: 0, balances: null };
    ledger.add(key);
    u.chips += reward.chips;
    u.stars += reward.stars;
    if (category === 'lifetime') u.achievements.push(achId);
    return { status: 'paid', chips: reward.chips, stars: reward.stars, balances: { chips: u.chips, stars: u.stars, scratchCardsAvailable: 0 } };
  }),
  settleLevelUps: jest.fn(async (userId: number, levels: Array<{ level: number; chips: number; stars: number }>) => {
    const u = db.users.get(userId)!;
    const chips = levels.reduce((s, l) => s + l.chips, 0);
    const stars = levels.reduce((s, l) => s + l.stars, 0);
    u.chips += chips; u.stars += stars;
    return { paidLevels: levels.map((l) => l.level), chips, stars, balances: { chips: u.chips, stars: u.stars, scratchCardsAvailable: 0 } };
  }),
}));
jest.mock('../src/auth/authManager', () => ({
  addChipsToUser: jest.fn(async () => true),
  addStarsToUser: jest.fn(async () => true),
  mergeUserStats: jest.fn(async () => {}),
}));

import {
  ProgressionManager, userProgressKey, IDLE_HANDS_REWARD_LIMIT, IDLE_RUNS_CAP, HAND_XP, HAND_XP_AFTER_CAP,
} from '../src/progression/ProgressionManager';
import { missionTemplateIdsFor } from '../src/progression/missions';
import { denverDateKey } from '../src/economy/denverTime';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const DAY_MS = 24 * 60 * 60_000;

function freshPm(clock?: { t: number }): ProgressionManager {
  const pm = new ProgressionManager();
  pm.hydrateBackoffMs = [0, 0, 0];
  pm.hydrateRetryDelaysMs = [5, 5, 5];
  if (clock) pm.now = () => clock.t;
  return pm;
}
let hn = 0;
/** One dealt-in hand; `participated` = a voluntary chip this hand. */
const hand = (pm: ProgressionManager, id: string, participated: boolean): boolean =>
  pm.recordHandPlayed(id, 'texas-holdem', { tableId: 'T1', handNumber: ++hn }, true, participated);

let warn: jest.SpyInstance;
beforeEach(() => {
  db.users.clear(); db.lifetime.clear(); db.windows.clear(); db.settleCalls = [];
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

describe('E5 (g) — the idle-hand window in ProgressionManager.recordHandPlayed', () => {
  it('constants of the contract', () => {
    expect(IDLE_HANDS_REWARD_LIMIT).toBe(30);
    expect(IDLE_RUNS_CAP).toBe(50_000);
    expect(HAND_XP).toBe(5);
    expect(HAND_XP_AFTER_CAP).toBe(1);
  });

  it('(8) returns false first on the 30th idle hand in a row; a voluntary chip resets the run (that hand and the next 29 idle hands earn)', async () => {
    user(101);
    const pm = freshPm();
    pm.getOrCreateProgress('seat-101', 'P', 101);
    await flush();
    const earned: boolean[] = [];
    for (let i = 0; i < 40; i++) earned.push(hand(pm, 'seat-101', false));
    expect(earned.indexOf(false)).toBe(IDLE_HANDS_REWARD_LIMIT - 1);         // 0-based: the 30th hand
    expect(earned.filter(Boolean)).toHaveLength(29);
    expect(earned.slice(29).every((e) => e === false)).toBe(true);           // and every idle hand after it

    expect(hand(pm, 'seat-101', true)).toBe(true);                           // a call / bet / raise / all-in
    const after: boolean[] = [];
    for (let i = 0; i < 30; i++) after.push(hand(pm, 'seat-101', false));
    expect(after.filter(Boolean)).toHaveLength(29);
    expect(after[29]).toBe(false);
  });

  it('(8) the default arguments return true and never start an idle run (every existing caller is unchanged); no record → true; not dealt in → false', async () => {
    user(102);
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('seat-102', 'P', 102);
    await flush();
    for (let i = 0; i < 45; i++) expect(pm.recordHandPlayed('seat-102', 'texas-holdem', { tableId: 'T1', handNumber: ++hn })).toBe(true);
    expect(rec.totalHandsPlayed).toBe(45);
    expect(pm.recordHandPlayed('nobody-here', 'texas-holdem')).toBe(true);
    expect(pm.recordHandPlayed('seat-102', 'texas-holdem', { tableId: 'T1', handNumber: ++hn }, false)).toBe(false);
    expect(rec.totalHandsPlayed).toBe(45);
  });

  it('a hand past the window ticks no daily / weekly "played" window; the idle run lasts across days (no play_hands mission progress on the new day until a chip goes in)', async () => {
    // An account whose missions today AND tomorrow include a play_hands mission.
    const clock = { t: Date.UTC(2026, 10, 10, 18, 0, 0) };     // 11 AM Denver
    const today = denverDateKey(clock.t);
    const tomorrow = denverDateKey(clock.t + DAY_MS);
    const isPlay = (t: string) => t === 'play_10' || t === 'play_20';
    let uid = 200;
    while (!(missionTemplateIdsFor(uid, today).some(isPlay) && missionTemplateIdsFor(uid, tomorrow).some(isPlay))) uid++;
    user(uid);
    const pm = freshPm(clock);
    const rec = pm.getOrCreateProgress('seat-m', 'P', uid);
    await flush();
    for (let i = 0; i < 40; i++) hand(pm, 'seat-m', false);
    expect(rec.dailyStats.handsPlayed).toBe(29);
    expect(rec.weeklyStats.handsPlayed).toBe(29);

    clock.t += DAY_MS;                                          // a new UTC day and a new Denver day
    for (let i = 0; i < 5; i++) expect(hand(pm, 'seat-m', false)).toBe(false);
    const playId = missionTemplateIdsFor(uid, tomorrow).find(isPlay)!;
    expect(pm.missionsOf('seat-m').find((m) => m.templateId === playId)).toMatchObject({ progress: 0 });
    expect(rec.dailyStats.handsPlayed).toBe(0);

    expect(hand(pm, 'seat-m', true)).toBe(true);
    expect(pm.missionsOf('seat-m').find((m) => m.templateId === playId)).toMatchObject({ progress: 1 });
    expect(rec.dailyStats.handsPlayed).toBe(1);
  });

  it('guard: the idle run survives evictIdle (it is not on the evictable record); a boot (a new manager) starts clean', async () => {
    user(103);
    const clock = { t: Date.now() };
    const pm = freshPm(clock);
    pm.getOrCreateProgress('seat-103', 'P', 103);
    await flush();
    for (let i = 0; i < 35; i++) hand(pm, 'seat-103', false);
    await pm.flushPending();                                                // daily achievements settled (else not evictable)
    clock.t += 31 * 60_000;
    expect(pm.evictIdle(() => false)).toEqual([userProgressKey(103)]);      // the record is dropped
    expect(pm.getProgress('seat-103')).toBeUndefined();
    pm.getOrCreateProgress('seat-103b', 'P', 103);                          // signs in again, a new seat id
    await flush();
    expect(hand(pm, 'seat-103b', false)).toBe(false);                       // still past the window
    const booted = freshPm(clock);
    booted.getOrCreateProgress('seat-103c', 'P', 103);
    await flush();
    expect(hand(booted, 'seat-103c', false)).toBe(true);
  });
});

describe('E13 — lifetime hands played counts rewarded hands only', () => {
  it('(9) totalHandsPlayed stops at 29 during a 40-hand idle streak; hands_100 pays only after 100 rewarded hands', async () => {
    user(104);
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('seat-104', 'P', 104);
    await flush();
    for (let i = 0; i < 40; i++) hand(pm, 'seat-104', false);
    expect(rec.totalHandsPlayed).toBe(29);
    expect(rec.lastHandAt).toBeGreaterThan(0);                              // lastHandAt is still recorded

    for (let i = 0; i < 70; i++) hand(pm, 'seat-104', true);
    await pm.flushPending();
    expect(rec.totalHandsPlayed).toBe(99);
    expect(db.settleCalls).not.toContain('104:lifetime:hands_100');         // 110 dealt hands, 99 rewarded

    hand(pm, 'seat-104', true);
    await pm.flushPending();
    expect(rec.totalHandsPlayed).toBe(100);
    expect(db.settleCalls.filter((c) => c === '104:lifetime:hands_100')).toHaveLength(1);
    expect(rec.achievements).toContain('hands_100');
  });
});

describe('E12 — handXpFor: full hand XP for the first N rewarded hands of the UTC day', () => {
  it('(10) the 1,001st rewarded hand of a UTC day gets HAND_XP_AFTER_CAP; the next UTC day (still the same Denver day) starts at HAND_XP again; 0 = always HAND_XP', async () => {
    user(105);
    // 23:00 UTC = 4 PM Denver (MST). One hour later it is a new UTC day but the SAME Denver day:
    // the window is the existing UTC daily window, not a Denver day.
    const clock = { t: Date.UTC(2026, 10, 12, 23, 0, 0) };
    const pm = freshPm(clock);
    const rec = pm.getOrCreateProgress('seat-105', 'P', 105);
    await flush();
    const xps: number[] = [];
    for (let i = 0; i < 1001; i++) {
      expect(hand(pm, 'seat-105', true)).toBe(true);
      xps.push(pm.handXpFor('seat-105', 1000));
    }
    expect(rec.dailyStats.handsPlayed).toBe(1001);
    expect(xps.slice(0, 1000).every((x) => x === HAND_XP)).toBe(true);
    expect(xps[1000]).toBe(HAND_XP_AFTER_CAP);
    expect(pm.handXpFor('seat-105', 0)).toBe(HAND_XP);                      // 0 = no cap
    expect(pm.handXpFor('seat-105', -5)).toBe(HAND_XP);
    expect(pm.handXpFor('seat-105', Number.NaN)).toBe(HAND_XP);

    const denverBefore = denverDateKey(clock.t);
    clock.t += 60 * 60_000;                                                 // 00:00 UTC next day = 5 PM Denver
    expect(denverDateKey(clock.t)).toBe(denverBefore);
    hand(pm, 'seat-105', true);
    expect(pm.handXpFor('seat-105', 1000)).toBe(HAND_XP);
    expect(rec.dailyStats.handsPlayed).toBe(1);
    expect(pm.handXpFor('no-record', 1000)).toBe(HAND_XP);
  });

  it('(10) a stale window never reduces a new day\'s XP (handXpFor rolls the window itself)', async () => {
    user(106);
    const clock = { t: Date.UTC(2026, 10, 12, 12, 0, 0) };
    const pm = freshPm(clock);
    pm.getOrCreateProgress('seat-106', 'P', 106);
    await flush();
    for (let i = 0; i < 12; i++) hand(pm, 'seat-106', true);
    expect(pm.handXpFor('seat-106', 10)).toBe(HAND_XP_AFTER_CAP);
    clock.t += DAY_MS;
    expect(pm.handXpFor('seat-106', 10)).toBe(HAND_XP);
  });
});

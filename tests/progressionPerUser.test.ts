/**
 * .online R2 (S3, 2026-10-11) — the REAL ProgressionManager on a fake DB layer
 * (economy/economyDb + authManager mocked; the SQL itself is proven in
 * economyPostgres.test.ts against Postgres 18):
 *   ECON-9   one record per ACCOUNT, re-read from the DB at every sign-in;
 *   ECON-10  achievements pay only through their ledger (two seats / two
 *            processes pay once), level-ups through a per-LEVEL ledger;
 *   ECON-12  hydrated only after every read succeeded (retried);
 *   ECON-13  a seat not dealt in records nothing;
 *   C5       the payload; C6 missions; C7/C8 cosmetics + VIP views; C10 HUD.
 */

interface FakeUser {
  chips: number; stars: number; level: number; xp: number; achievements: string[]; stats: Record<string, any>;
  loginStreak: number; lastLoginClaimDate: string | null; scratch: number;
  inventory: Array<{ itemType: string; itemId: string; equipped: boolean }>;
  missionClaims: string[]; spinClaimedToday: boolean; vipMonthlyClaimed: boolean; bpPremium: boolean; publicId: string | null;
}
const db = {
  users: new Map<number, FakeUser>(),
  lifetime: new Set<string>(),
  windows: new Set<string>(),
  levels: new Set<string>(),
  failBundle: 0,
  failSettle: 0,
  /** R3 (S3-4) — settleLevelUps calls that throw (a DB blip), and the level lists sent. */
  failLevels: 0,
  levelCalls: [] as number[][],
  bundleCalls: 0,
  settleCalls: [] as string[],
  merges: [] as Array<[number, Record<string, any>, any]>,
};
const user = (id: number, over: Partial<FakeUser> = {}): FakeUser => {
  const u: FakeUser = {
    chips: 50000, stars: 100, level: 10, xp: 50, achievements: [], stats: {}, loginStreak: 0, lastLoginClaimDate: null, scratch: 0,
    inventory: [], missionClaims: [], spinClaimedToday: false, vipMonthlyClaimed: false, bpPremium: false, publicId: `p${String(id).padStart(15, '0')}`,
    ...over,
  };
  db.users.set(id, u);
  return u;
};

jest.mock('../src/economy/economyDb', () => ({
  loadProgressBundle: jest.fn(async (userId: number) => {
    db.bundleCalls++;
    if (db.failBundle > 0) { db.failBundle--; throw new Error('connection terminated'); }
    const u = db.users.get(userId);
    if (!u) return null;
    return {
      userId, displayName: `Player ${userId}`, publicId: u.publicId, chips: u.chips, level: u.level, xp: u.xp, stars: u.stars,
      stats: JSON.parse(JSON.stringify(u.stats)), achievements: [...u.achievements],
      lifetimeLedger: [...db.lifetime].filter((k) => k.startsWith(`${userId}|`)).map((k) => k.split('|')[1]),
      loginStreak: u.loginStreak, lastLoginClaimDate: u.lastLoginClaimDate, scratchCardsAvailable: u.scratch,
      inventory: u.inventory.map((r) => ({ ...r })), dailyAchievementIds: [], weeklyAchievementIds: [],
      missionClaims: [...u.missionClaims], spinClaimedToday: u.spinClaimedToday, vipMonthlyClaimed: u.vipMonthlyClaimed,
      battlePassPremium: u.bpPremium,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      denverToday: require('../src/economy/denverTime').denverDateKey(), denverMonth: require('../src/economy/denverTime').denverMonthKey(),
    };
  }),
  settleAchievementReward: jest.fn(async (userId: number, category: string, achId: string, windowKey: string, reward: { chips: number; stars: number }) => {
    db.settleCalls.push(`${userId}:${category}:${achId}`);
    if (db.failSettle > 0) { db.failSettle--; throw new Error('deadlock detected'); }
    const u = db.users.get(userId)!;
    const key = category === 'lifetime' ? `${userId}|${achId}` : `${userId}|${category}|${achId}|${windowKey}`;
    const ledger = category === 'lifetime' ? db.lifetime : db.windows;
    if (ledger.has(key) || (category === 'lifetime' && u.achievements.includes(achId))) return { status: 'already', chips: 0, stars: 0, balances: null };
    ledger.add(key);
    u.chips += reward.chips;
    u.stars += reward.stars;
    if (category === 'lifetime') u.achievements.push(achId);
    return { status: 'paid', chips: reward.chips, stars: reward.stars, balances: { chips: u.chips, stars: u.stars, scratchCardsAvailable: u.scratch } };
  }),
  settleLevelUps: jest.fn(async (userId: number, levels: Array<{ level: number; chips: number; stars: number }>, newLevel: number, xp: number) => {
    db.levelCalls.push(levels.map((l) => l.level));
    if (db.failLevels > 0) { db.failLevels--; throw new Error('Connection terminated unexpectedly'); }
    const u = db.users.get(userId)!;
    let chips = 0; let stars = 0; const paidLevels: number[] = [];
    for (const l of levels) {
      const k = `${userId}|${l.level}`;
      if (db.levels.has(k)) continue;
      db.levels.add(k); paidLevels.push(l.level); chips += l.chips; stars += l.stars;
    }
    u.chips += chips; u.stars += stars;
    if (newLevel > u.level) { u.level = newLevel; u.xp = xp; }
    return { paidLevels, chips, stars, balances: { chips: u.chips, stars: u.stars, scratchCardsAvailable: u.scratch } };
  }),
}));
jest.mock('../src/auth/authManager', () => ({
  addChipsToUser: jest.fn(async () => true),
  addStarsToUser: jest.fn(async () => true),
  mergeUserStats: jest.fn(async (uid: number, patch: Record<string, any>, opts: any) => { db.merges.push([uid, patch, opts]); }),
}));

import { ProgressionManager, userProgressKey, xpRequiredForLevel } from '../src/progression/ProgressionManager';
import { missionTemplateIdsFor } from '../src/progression/missions';
import { denverDateKey } from '../src/economy/denverTime';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function reset() {
  db.users.clear(); db.lifetime.clear(); db.windows.clear(); db.levels.clear();
  db.failBundle = 0; db.failSettle = 0; db.bundleCalls = 0; db.settleCalls = []; db.merges = [];
  db.failLevels = 0; db.levelCalls = [];
}
function freshPm(): ProgressionManager {
  const pm = new ProgressionManager();
  pm.hydrateBackoffMs = [0, 0, 0];
  pm.hydrateRetryDelaysMs = [5, 5, 5];
  return pm;
}
let warn: jest.SpyInstance;
beforeEach(() => { reset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('ECON-9 / ECON-10 — ONE progress record per account', () => {
  it('every seat of the account is an ALIAS of `user-<id>`: one record, one achievement payout (two seats used to pay it twice)', async () => {
    user(7, { stats: { handsPlayed: 95, handsWon: 1 }, achievements: ['first_win'] });
    const pm = freshPm();
    const a = pm.getOrCreateProgress('player-A', 'Josh', 7);
    const b = pm.getOrCreateProgress('player-B', 'Josh', 7);
    const lobby = pm.getOrCreateProgress(userProgressKey(7), 'Josh', 7);
    expect(a).toBe(b);
    expect(a).toBe(lobby);
    expect(pm.size).toBe(1);
    await flush();
    expect(a.hydrated).toBe(true);
    expect(db.bundleCalls).toBe(1);                       // one load for the account, not one per seat
    for (let h = 0; h < 5; h++) { pm.recordHandPlayed('player-A', 'holdem'); pm.recordHandPlayed('player-B', 'holdem'); }
    await pm.flushPending();
    expect(a.totalHandsPlayed).toBe(105);
    expect(db.settleCalls.filter((c) => c.endsWith(':lifetime:hands_100'))).toEqual(['7:lifetime:hands_100']);
    expect(db.settleCalls.filter((c) => c.endsWith(':daily:d_play_5'))).toEqual(['7:daily:d_play_5']);
    expect(db.users.get(7)!.chips).toBe(50000 + 2000 + 500);   // hands_100 + today's d_play_5, each paid ONCE
    expect(a.achievements).toContain('hands_100');
  });

  it('two PROCESSES (two managers, a deploy overlap) on one account: the ledger pays the achievement once; the loser shows nothing extra', async () => {
    user(8, { stats: { handsWon: 0 } });
    const p1 = freshPm(); const p2 = freshPm();
    const r1 = p1.getOrCreateProgress('player-1', 'A', 8);
    const r2 = p2.getOrCreateProgress('player-2', 'A', 8);
    await flush();
    p1.recordHandWon('player-1', 500, 2);
    p2.recordHandWon('player-2', 500, 2);
    expect(r1.chips - 50000).toBe(1000);                   // optimistic first_win on both…
    expect(r2.chips - 50000).toBe(1000);
    await p1.flushPending(); await p2.flushPending();
    expect(db.settleCalls.filter((c) => c === '8:lifetime:first_win')).toHaveLength(2);
    expect(db.users.get(8)!.chips).toBe(51000);           // …paid ONCE
    expect([r1.chips, r2.chips].sort()).toEqual([50000, 51000]);   // the loser took its display back
  });

  it('every sign-in re-reads the DB (refreshUser): wallet / level / stars / achievements of a long-lived record are DB-fresh; counters never go back', async () => {
    const u = user(9, { level: 10, xp: 50, chips: 50000, stars: 100, stats: { handsPlayed: 90 } });
    const pm = freshPm();
    const rec = pm.getOrCreateProgress(userProgressKey(9), 'P', 9);
    await flush();
    rec.totalHandsPlayed = 120;                             // played here, not yet saved
    Object.assign(u, { level: 14, xp: 900, chips: 180000, stars: 900, achievements: ['hands_100'], stats: { handsPlayed: 100 } });
    // CONTROL — the pre-R2 path (hydrate once, then short-circuit): stale.
    await pm.hydrateFromDB(userProgressKey(9), 9);
    expect([rec.level, rec.chips, rec.stars]).toEqual([10, 50000, 100]);
    await pm.refreshUser(9, 'P');
    expect([rec.level, rec.xp, rec.chips, rec.stars]).toEqual([14, 900, 180000, 900]);
    expect(rec.achievements).toContain('hands_100');
    expect(rec.totalHandsPlayed).toBe(120);                 // max(memory, DB) — never lowered
    expect(rec.xpToNextLevel).toBe(xpRequiredForLevel(14));
  });

  it('applyCarriedProgress (guest carry-over) still merges into the account record (aliases resolve to it)', async () => {
    user(10);
    const pm = freshPm();
    const seat = pm.getOrCreateProgress('player-x', 'P', 10);
    await flush();
    const out = pm.applyCarriedProgress(10, { chipsAdded: 100, starsAdded: 5, levelAfter: 12, xpAfter: 3, achievementIds: ['lvl_x'] });
    expect(out).toEqual({ merged: [userProgressKey(10)], reloading: [] });
    expect([seat.level, seat.chips, seat.stars]).toEqual([12, 50100, 105]);
  });
});

describe('ECON-12 — hydrated only after every read succeeded', () => {
  it('failed reads leave the record un-hydrated (nothing persisted, no payout, no push payload); the background re-load fills it with the DB values', async () => {
    // The background re-load is a timer: the clock is faked so it fires only
    // when the test advances it (under a loaded CI box a real 5ms timer fired
    // during the first flush and the record was already hydrated).
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      user(11, { level: 40, chips: 77777, stats: { handsPlayed: 300, handsWon: 120 }, achievements: ['first_win'] });
      db.failBundle = 3;                                      // all three immediate attempts fail
      const pm = freshPm();                                   // background re-load 5ms later
      const rec = pm.getOrCreateProgress('player-q', 'Q', 11);
      await flush();
      expect(rec.hydrated).toBe(false);
      expect(db.bundleCalls).toBe(3);
      pm.recordHandPlayed('player-q', 'holdem');
      pm.recordHandWon('player-q', 100, 3);
      await pm.flushPending();
      expect(db.settleCalls).toEqual([]);                     // nothing paid from a fresh-init record
      expect(rec.chips).toBe(0);                              // the optimistic first_win was taken back at once
      jest.advanceTimersByTime(10);                           // the background re-load
      await flush();
      expect(db.bundleCalls).toBe(4);
      expect(rec.hydrated).toBe(true);
      expect(rec.level).toBe(40);
      expect(rec.chips).toBe(77777);
      expect(rec.totalHandsPlayed).toBe(301);                 // DB 300 + the hand counted before the load (a delta)
      expect(rec.handsWon).toBe(121);
    } finally {
      jest.useRealTimers();
    }
  });

  it('CONTROL — the pre-R2 loaders returned [] on an error: today\'s daily achievements read as "none" and paid again (here: the ledger blocks the re-pay)', async () => {
    user(12, { stats: {} });
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('player-w', 'W', 12);
    await flush();
    for (let i = 0; i < 5; i++) pm.recordHandPlayed('player-w', 'holdem');
    await pm.flushPending();
    const paid = db.users.get(12)!.chips;
    // A second record (a restart) whose window list is empty pays nothing: the ledger has today's row.
    const pm2 = freshPm();
    const rec2 = pm2.getOrCreateProgress('player-w2', 'W', 12);
    await flush();
    for (let i = 0; i < 5; i++) pm2.recordHandPlayed('player-w2', 'holdem');
    await pm2.flushPending();
    expect(db.users.get(12)!.chips).toBe(paid);
    expect(rec.dailyAchievementsToday).toContain('d_play_5');
    expect(rec2.dailyAchievementsToday).toContain('d_play_5');
  });
});

describe('achievements + level-ups settle through ledgers', () => {
  it('a settlement error takes the reward back and retries the achievement only after a minute', async () => {
    user(13);
    const pm = freshPm();
    let clock = Date.now();
    pm.now = () => clock;
    const rec = pm.getOrCreateProgress('p13', 'P', 13);
    await flush();
    db.failSettle = 1;
    pm.recordHandWon('p13', 100, 2);
    await pm.flushPending();
    expect(rec.chips).toBe(50000);
    expect(rec.achievements).not.toContain('first_win');
    pm.checkAchievements('p13');
    await pm.flushPending();
    expect(db.settleCalls.filter((c) => c.endsWith('first_win'))).toHaveLength(1);   // backing off
    clock += 61_000;
    pm.checkAchievements('p13');
    await pm.flushPending();
    expect(rec.achievements).toContain('first_win');
    expect(rec.chips).toBe(51000);
  });

  it('level-ups pay once per level through the ledger; a level already paid elsewhere is taken back', async () => {
    user(14, { level: 1, xp: 0, chips: 0, stars: 0 });
    db.levels.add('14|2');                                  // level 2 was paid by another process
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('p14', 'P', 14);
    await flush();
    pm.addXP('p14', xpRequiredForLevel(1) + xpRequiredForLevel(2));   // 1 → 3
    expect(rec.level).toBe(3);
    await pm.flushPending();
    expect(db.users.get(14)!.chips).toBe(1500);             // only level 3 (3 x 500)
    expect(rec.chips).toBe(1500);                           // level 2's optimistic 1,000 taken back
  });

  it('R3 (S3-4) — a level-up whose settlement exhausts its retries stays OWED: the next level-up pays both levels, each once', async () => {
    user(30, { level: 1, xp: 0, chips: 0, stars: 0 });
    jest.spyOn(console, 'error').mockImplementationOnce(() => {});
    const pm = freshPm();
    let clock = Date.now();
    pm.now = () => clock;
    const rec = pm.getOrCreateProgress('p30', 'P', 30);
    await flush();
    db.failLevels = 3;                                       // a DB blip longer than the 3 attempts
    pm.addXP('p30', xpRequiredForLevel(1));                  // 1 → 2 during the outage
    await pm.flushPending();
    expect(rec.level).toBe(2);                               // the level is kept (the hand save persists it)
    expect(db.levelCalls).toEqual([[2], [2], [2]]);
    expect(db.users.get(30)!.chips).toBe(0);
    expect(rec.chips).toBe(0);                               // the unpaid reward is not shown
    clock += 1_000;
    pm.addXP('p30', 1);                                      // inside the back-off: not re-sent yet
    await pm.flushPending();
    expect(db.levelCalls).toHaveLength(3);
    clock += 60_000;
    pm.addXP('p30', xpRequiredForLevel(2));                  // 2 → 3, the DB is back
    await pm.flushPending();
    expect(db.levelCalls[db.levelCalls.length - 1]).toEqual([2, 3]);   // the owed level rides along
    expect(db.users.get(30)!.chips).toBe(2 * 500 + 3 * 500);
    expect(db.users.get(30)!.stars).toBe(2 * 5 + 3 * 5);
    expect(rec.chips).toBe(2500);                             // shown once paid
    expect(rec.stars).toBe(25);
    clock += 120_000;
    pm.addXP('p30', 1);                                       // nothing owed any more: nothing re-sent
    await pm.flushPending();
    expect(db.levelCalls).toHaveLength(4);
  });

  it('R3 (S3-4) — …or the retry timer pays it with no further XP; a record still owing a level-up is never evicted', async () => {
    user(31, { level: 1, xp: 0, chips: 0, stars: 0 });
    jest.spyOn(console, 'error').mockImplementationOnce(() => {});
    const pm = freshPm();
    pm.levelSettleRetryMs = 20;
    const rec = pm.getOrCreateProgress('p31', 'P', 31);
    await flush();
    db.failLevels = 3;
    pm.addXP('p31', xpRequiredForLevel(1));
    await pm.flushPending();
    expect(db.users.get(31)!.chips).toBe(0);
    expect(pm.evictIdle(() => false, -1)).toEqual([]);       // owed: kept
    await new Promise((r) => setTimeout(r, 120));
    await pm.flushPending();
    expect(db.levelCalls[db.levelCalls.length - 1]).toEqual([2]);
    expect(db.users.get(31)!.chips).toBe(1000);
    expect(rec.chips).toBe(1000);
    expect(pm.evictIdle(() => false, -1)).toEqual([userProgressKey(31)]);   // paid: evictable again
  });

  it('the chip booster multiplies reward grants (level-up) — never anything else', async () => {
    user(15, { level: 1, xp: 0, chips: 0, stats: { activeBoosters: { chip: { mult: 1.5, expiresAt: Date.now() + 60_000 } } } });
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('p15', 'P', 15);
    await flush();
    pm.addXP('p15', xpRequiredForLevel(1));
    expect(rec.chips).toBe(1500);                           // level 2: 1,000 x 1.5 shown
  });
});

describe('per-hand HUD flags (C10 / APPUI-10) and dealt-in hands only (ECON-13)', () => {
  it('a PREFLOP call counts for VPIP even when it closed the round; flags are per table + hand (two tables interleaved); a late action of a committed hand applies directly', async () => {
    user(16);
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('p16', 'P', 16);
    await flush();
    const A = { tableId: 'TA', handNumber: 5 };
    const B = { tableId: 'TB', handNumber: 9 };
    pm.recordAction('p16', 'call', { phase: 'PreFlop', ...A });
    pm.recordAction('p16', 'fold', { phase: 'PreFlop', ...B });
    pm.recordHandPlayed('p16', 'holdem', B);                // table B's hand ends first
    expect(rec.vpipHands).toBe(0);                          // B's fold is not VPIP; A's call is not B's
    pm.recordHandPlayed('p16', 'holdem', A);
    expect(rec.vpipHands).toBe(1);
    pm.recordAction('p16', 'raise', { phase: 'PreFlop', ...A });   // late (after A's commit)
    expect([rec.vpipHands, rec.pfrHands]).toEqual([2, 1]);
    expect(rec.actionCounts).toMatchObject({ call: 1, fold: 1, raise: 1 });
  });

  it('dealtIn=false: no hand, no XP, no mission progress, its flags dropped', async () => {
    user(17);
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('p17', 'P', 17);
    await flush();
    const H = { tableId: 'T', handNumber: 1 };
    pm.recordAction('p17', 'allIn', { phase: 'PreFlop', ...H });
    pm.recordHandPlayed('p17', 'holdem', H, false);
    expect(rec.totalHandsPlayed).toBe(0);
    expect(rec.vpipHands).toBe(0);
    expect(Object.values(rec.missionDay!.progress)).toEqual([]);
  });
});

describe('missions (C6) on the account record', () => {
  it('progress from dealt-in hands; claim checks: not loaded / not today\'s / not one of his / incomplete / claimed', async () => {
    user(18);
    const pm = freshPm();
    expect(pm.missionClaimCheck(18, 'x')).toEqual({ ok: false, code: 'progress_loading' });
    const rec = pm.getOrCreateProgress('p18', 'P', 18);
    await flush();
    const today = denverDateKey();
    const ids = missionTemplateIdsFor(18, today);
    const rows = pm.missionsOf('p18');
    expect(rows.map((r) => r.templateId)).toEqual(ids);
    const play = ['play_10', 'play_20'].find((t) => ids.includes(t));
    const notMine = ['play_10', 'play_20', 'win_3', 'win_5', 'pot_5k'].find((t) => !ids.includes(t))!;
    expect(pm.missionClaimCheck(18, `${today}:${notMine}`)).toEqual({ ok: false, code: 'mission_not_found' });
    expect(pm.missionClaimCheck(18, `2020-01-01:${ids[0]}`)).toEqual({ ok: false, code: 'mission_expired' });
    expect(pm.missionClaimCheck(18, `${today}:${ids[0]}`)).toEqual({ ok: false, code: 'mission_incomplete' });
    if (play) {
      for (let i = 0; i < 25; i++) pm.recordHandPlayed('p18', 'holdem', { tableId: 'T', handNumber: i });
      const ok = pm.missionClaimCheck(18, `${today}:${play}`);
      expect(ok).toMatchObject({ ok: true, dateKey: today, templateId: play });
      const events = pm.consumeEvents('p18').filter((e) => e.type === 'missionComplete');
      expect(events.map((e) => e.data.templateId)).toContain(play);
      pm.markMissionClaimed(18, today, play, 50);
      expect(pm.missionClaimCheck(18, `${today}:${play}`)).toEqual({ ok: false, code: 'already_claimed' });
      expect(pm.missionsOf('p18').find((m) => m.templateId === play)).toMatchObject({ completed: true, claimed: true });
    }
    expect(rec.missionDay!.date).toBe(today);
  });

  it('claims recorded in the ledger come back with the record (hydrate)', async () => {
    const today = denverDateKey();
    const ids = missionTemplateIdsFor(19, today);
    user(19, { missionClaims: [ids[0]], stats: { missions: { date: today, progress: { [ids[0]]: 99 } } } });
    const pm = freshPm();
    pm.getOrCreateProgress('p19', 'P', 19);
    await flush();
    expect(pm.missionsOf('p19')[0]).toMatchObject({ templateId: ids[0], claimed: true });
  });
});

describe('C5 payload / C7 cosmetics / C8 VIP', () => {
  it('playerProgress carries every C5 key with the contract types', async () => {
    const now = Date.now();
    user(20, {
      level: 30, xp: 10, chips: 1234, stars: 56, scratch: 3, loginStreak: 4, lastLoginClaimDate: '2026-10-10', bpPremium: true,
      stats: { handsPlayed: 200, handsWon: 31, elo: 640, peakElo: 700, rankedWins: 4, rankedLosses: 2, vipExpiresAt: now + 86_400_000,
        activeBoosters: { xp: { mult: 2, expiresAt: now + 60_000 }, chip: { mult: 1.5, expiresAt: now - 1 } } },
      inventory: [{ itemType: 'theme', itemId: 'royal_gold', equipped: true }, { itemType: 'frame', itemId: 'gold', equipped: true },
        { itemType: 'emote', itemId: 'crown', equipped: false }, { itemType: 'badge', itemId: 'season_gold', equipped: false }],
    });
    const pm = freshPm();
    pm.getOrCreateProgress('p20', 'P', 20);
    await flush();
    const c: any = pm.getClientProgress('p20');
    expect(c).toMatchObject({
      chips: 1234, stars: 56, level: 30, xp: 10, handsWon: 31, totalHandsPlayed: 200, winRate: 15.5,
      elo: 640, peakElo: 700, rankedWins: 4, rankedLosses: 2, lastLoginClaimDate: '2026-10-10', loginStreak: 4,
      battlePassPremium: true, scratchCardsAvailable: 3, dailyMissionsDate: denverDateKey(), badges: ['season_gold'],
      equipped: { theme: 'royal_gold', cardBack: null, frame: 'gold', title: null },
    });
    expect(c.totalXp).toBeGreaterThan(0);
    expect(c.vip).toMatchObject({ active: true, expiresAt: now + 86_400_000, loginMultiplier: 1.5, monthlyBonus: 25000, monthlyClaimed: false });
    expect(c.vip.perks).toEqual(expect.arrayContaining(['vip_badge', 'gold_frame', 'login_bonus_50', 'monthly_chips', 'vip_emotes', 'xp_rate']));
    expect(c.activeBoosters).toEqual([{ type: 'xp', multiplier: 2, expiresAt: now + 60_000 }]);   // the expired chip booster is gone
    expect(c.equipped.emotes).toEqual(expect.arrayContaining(['nice', 'crown', 'vip_crown']));
    expect(c.owned).toEqual(['badge:season_gold', 'emote:crown', 'frame:gold', 'theme:royal_gold']);
    expect(c.missions).toHaveLength(3);
    expect(c.missions[0]).toEqual(expect.objectContaining({ id: expect.any(String), templateId: expect.any(String), description: expect.any(String),
      progress: 0, target: expect.any(Number), reward: expect.objectContaining({ chips: expect.any(Number), xp: expect.any(Number), stars: expect.any(Number) }),
      completed: false, claimed: false }));
    expect(c.dailyMissions).toEqual(c.missions);
    expect(pm.seatCosmetics(20)).toEqual({ frame: 'gold', title: null, cardBack: null, badge: null, vip: true });
    expect(pm.equippedTheme(20)).toBe('royal_gold');
    expect(pm.canUseEmote(20, 'vip_diamond')).toBe(true);
    expect(pm.canUseEmote(20, 'mic_drop')).toBe(false);    // not owned
    expect(pm.canUseEmote(20, 'gg')).toBe(true);           // free
  });

  it('a lapsed VIP pass: no VIP emotes / frame flag / login bonus; the XP-rate tier stays (by season XP)', async () => {
    user(21, { level: 40, stats: { vipExpiresAt: Date.now() - 1 } });
    const pm = freshPm();
    pm.getOrCreateProgress('p21', 'P', 21);
    await flush();
    const c: any = pm.getClientProgress('p21');
    expect(c.vip).toMatchObject({ active: false, expiresAt: null, loginMultiplier: 1 });
    expect(c.vip.perks).toEqual(['xp_rate']);
    expect(pm.canUseEmote(21, 'vip_crown')).toBe(false);
    expect(pm.seatCosmetics(21)!.vip).toBe(false);
  });

  it('a DB wallet snapshot is applied as DB + rewards still settling (a refresh never hides a pending reward)', async () => {
    user(22, { chips: 1000, stats: {} });
    const pm = freshPm();
    const rec = pm.getOrCreateProgress('p22', 'P', 22);
    await flush();
    pm.recordHandWon('p22', 10, 2);                        // first_win shown (+1,000), settling
    pm.applyWallet(22, { chips: 1000, stars: 100 });       // a snapshot read before the settlement committed
    expect(rec.chips).toBe(2000);
    await pm.flushPending();
    expect(rec.chips).toBe(2000);
  });
});

describe('persistence round trip (APPUI-11) / stats (C10) / eviction (P3)', () => {
  it('the hand-complete patch carries ELO, ranked W-L, eloHistory, the HUD maps, the dated windows and missions — and a load reads them back', async () => {
    user(23, { stats: {} });
    user(24, { stats: {} });
    const pm = freshPm();
    const w = pm.getOrCreateProgress('p23', 'W', 23);
    pm.getOrCreateProgress('p24', 'L', 24);
    await flush();
    pm.updateElo('p23', 'p24');
    pm.recordPositionResult('p23', 'late', true);
    pm.recordAction('p23', 'raise', { phase: 'PreFlop', tableId: 'T', handNumber: 1 });
    pm.recordHandPlayed('p23', 'holdem', { tableId: 'T', handNumber: 1 });
    const patch: any = pm.persistStatsPatch('p23');
    expect(patch).toMatchObject({ elo: w.elo, rankedWins: 1, peakElo: w.peakElo, handsPlayed: 1, pfrHands: 1,
      positionWins: { late: { wins: 1, total: 1 } }, actionCounts: { raise: 1 }, dailyStatsDate: w.dailyStatsDate });
    expect(patch.eloHistory).toHaveLength(1);
    expect(patch.missions.date).toBe(denverDateKey());
    // a new process loads it back
    db.users.get(23)!.stats = JSON.parse(JSON.stringify(patch));
    const pm2 = freshPm();
    const back = pm2.getOrCreateProgress('p23b', 'W', 23);
    await flush();
    expect([back.elo, back.rankedWins, back.peakElo, back.pfrHands]).toEqual([w.elo, 1, w.peakElo, 1]);
    expect(back.positionWins.late).toEqual({ wins: 1, total: 1 });
    expect(back.eloHistory).toHaveLength(1);
    expect(back.dailyStats.handsPlayed).toBe(1);
  });

  it('getDetailedStats answers from the account record (seated or not): vpip / pfr / af / handsTracked / winRate / positionStats', async () => {
    user(25, { stats: { handsPlayed: 200, handsWon: 50, vpipHands: 50, pfrHands: 20, actionCounts: { call: 10, raise: 20 },
      positionWins: { late: { wins: 5, total: 20 } }, flopsSeenHands: 0 } });
    const pm = freshPm();
    pm.getOrCreateProgress(userProgressKey(25), 'S', 25);
    await flush();
    const s: any = pm.getDetailedStats(userProgressKey(25));
    expect(s).toMatchObject({ vpip: 25, pfr: 10, af: 2, handsTracked: 200, winRate: 25, wtsd: null, hydrated: true,
      positionStats: { late: { wins: 5, total: 20, winRate: 25 } } });
  });

  it('eviction drops idle records of accounts with no live socket (and their aliases); keeps live ones', async () => {
    user(26); user(27);
    const pm = freshPm();
    let clock = Date.now();
    pm.now = () => clock;
    pm.getOrCreateProgress('seat-26', 'A', 26);
    pm.getOrCreateProgress('seat-27', 'B', 27);
    await flush();
    clock += 31 * 60_000;
    expect(pm.evictIdle((uid) => uid === 27)).toEqual([userProgressKey(26)]);
    expect(pm.size).toBe(1);
    expect(pm.getProgress('seat-26')).toBeUndefined();
    expect(pm.getProgress('seat-27')).toBeDefined();
  });
});

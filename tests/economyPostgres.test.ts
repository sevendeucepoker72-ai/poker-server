/**
 * .online R2 (S3, 2026-10-11) — the economy settlements against a REAL
 * Postgres (the SQL proof: ledgers, row locks, the Denver streak, the BIGINT
 * migration with the merged-credit trigger, concurrency).
 *
 * Runs only when ECONOMY_TEST_PG_URL points at a THROWAWAY database (never
 * prod): e.g. `docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:18`
 * then ECONOMY_TEST_PG_URL=postgres://postgres:x@localhost:55432/postgres.
 * Skipped otherwise (CI has no Postgres) — the same behaviour is pinned with
 * fakes in economySettlements.test.ts / progressionPerUser.test.ts.
 */
const PG_URL = process.env.ECONOMY_TEST_PG_URL || '';
if (PG_URL) process.env.DATABASE_URL = PG_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-economy-pg';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const am = require('../src/auth/authManager') as typeof import('../src/auth/authManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const edb = require('../src/economy/economyDb') as typeof import('../src/economy/economyDb');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const schema = require('../src/economy/schema') as typeof import('../src/economy/schema');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const merge = require('../src/auth/accountMerge') as typeof import('../src/auth/accountMerge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const brackets = require('../src/social/bracketManager') as typeof import('../src/social/bracketManager');

const d = PG_URL ? describe : describe.skip;

/** A deterministic rng from a list (cycles). */
const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

d('economy on a real Postgres', () => {
  let pool: any;
  let n = 0;
  const mkUser = async (over: Record<string, unknown> = {}): Promise<number> => {
    n++;
    const o: Record<string, unknown> = { username: `u${n}_${Date.now()}`, chips: 10000, stars: 0, display_name: `Player ${n}`, stats: '{}', ...over };
    const cols = Object.keys(o);
    const { rows } = await pool.query(
      `INSERT INTO users (password_hash, ${cols.join(', ')}) VALUES ('x', ${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => o[c]),
    );
    return Number(rows[0].id);
  };
  const row = async (id: number) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
  const denver = async (offsetDays = 0): Promise<string> =>
    (await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'America/Denver')::date + $1::int, 'YYYY-MM-DD') AS d`, [offsetDays])).rows[0].d;

  beforeAll(async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await am.initDB();
      pool = am.getPool();
      for (const t of ['user_achievements', 'economy_credits', 'user_chip_wins', 'user_battle_pass_premium', 'season_award_runs',
        'season_leaderboard_awards', 'user_daily_claims', 'user_inventory', 'user_battle_pass_claims', 'user_career_reward_claims',
        'user_daily_achievements', 'user_weekly_achievements']) {
        await pool.query(`DELETE FROM ${t}`).catch(() => {});
      }
      await merge.ensureMergeTables(pool);
      await merge.installMergedCreditRedirect(pool);
      await schema.initEconomyTables(pool);
      await brackets.initBracketTables();
    } finally { warn.mockRestore(); log.mockRestore(); }
  }, 60_000);

  afterAll(async () => { if (pool) await pool.end(); });

  describe('schema', () => {
    it('initEconomyTables is idempotent; every row gets a DISTINCT public id (per-row SQL randomness, unique index)', async () => {
      for (let i = 0; i < 30; i++) await pool.query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x')`, [`pid_${i}_${Date.now()}`]);
      await schema.initEconomyTables(pool);
      await schema.initEconomyTables(pool);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT public_id)::int AS d, COUNT(*) FILTER (WHERE public_id IS NULL)::int AS missing FROM users');
      expect(rows[0].missing).toBe(0);
      expect(rows[0].d).toBe(rows[0].n);
      const ids = await mkUser();
      const map = await edb.publicIdsFor([ids, 999999]);
      expect(map.get(ids)).toMatch(/^p[0-9a-f]{15}$/);
      expect(map.has(999999)).toBe(false);
      expect(await edb.userIdForPublicId(map.get(ids))).toBe(ids);
      expect(await edb.userIdForPublicId('p000000000000000')).toBeNull();
      expect(await edb.userIdForPublicId("x' OR 1=1 --")).toBeNull();
    });

    it('users.chips INTEGER → BIGINT: the merged-credit trigger is dropped and re-created identically in ONE transaction; values kept; idempotent; int8 reads back as a number', async () => {
      const id = await mkUser({ chips: 2_000_000_000 });
      const trigBefore = (await pool.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid='users'::regclass AND NOT tgisinternal`)).rows.map((r: any) => r.def);
      expect(trigBefore.length).toBe(1);
      // Control: a plain ALTER is refused because of the trigger.
      await expect(pool.query('ALTER TABLE users ALTER COLUMN chips TYPE BIGINT')).rejects.toThrow(/trigger/);
      expect(await schema.migrateUsersChipsToBigint(pool)).toBe('migrated');
      const type = (await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='chips'`)).rows[0].data_type;
      expect(type).toBe('bigint');
      const trigAfter = (await pool.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid='users'::regclass AND NOT tgisinternal`)).rows.map((r: any) => r.def);
      expect(trigAfter).toEqual(trigBefore);
      expect(await schema.migrateUsersChipsToBigint(pool)).toBe('already_bigint');
      expect(await am.addChipsToUser(id, 1_500_000_000)).toBe(true);           // past INT4 max now
      const r = await row(id);
      expect(r.chips).toBe(3_500_000_000);
      expect(typeof r.chips).toBe('number');
      // The redirect trigger still works on BIGINT chips (a tombstone's credit goes to its survivor).
      const survivor = await mkUser({ chips: 100 });
      const tomb = await mkUser({ chips: 0, stats: JSON.stringify({ mergedInto: survivor }) });
      await am.addChipsToUser(tomb, 500);
      expect((await row(tomb)).chips).toBe(0);
      expect((await row(survivor)).chips).toBe(600);
    });
  });

  describe('daily login (ECON-4 / C8)', () => {
    it('Denver streak: continues from the Denver YESTERDAY, resets after a gap; once per Denver day (5 concurrent claims pay once)', async () => {
      const yesterday = await denver(-1);
      const id = await mkUser({ login_streak: 3, last_login_claim_date: yesterday });
      const claims = await Promise.all([1, 2, 3, 4, 5].map(() => edb.settleDailyLogin(id, { rng: seq(0.9, 0.5) })));
      const ok = claims.filter((c) => c.ok) as any[];
      expect(ok).toHaveLength(1);
      expect(ok[0]).toMatchObject({ day: 4, streak: 4, chips: 5000, stars: 5, lastLoginClaimDate: await denver(0) });
      expect(claims.filter((c) => !c.ok).every((c: any) => c.code === 'already_claimed')).toBe(true);
      const r = await row(id);
      expect(r.chips).toBe(15000);
      expect(r.stars).toBe(5);
      expect(r.login_streak).toBe(4);
      const gap = await mkUser({ login_streak: 6, last_login_claim_date: await denver(-2) });
      expect(await edb.settleDailyLogin(gap)).toMatchObject({ ok: true, day: 1, streak: 1, chips: 1000 });
    });

    it('VIP pass active: +50% chips AND stars; a chip booster multiplies the chips (reward grants only)', async () => {
      const now = Date.now();
      const id = await mkUser({
        login_streak: 4, last_login_claim_date: await denver(-1),
        stats: JSON.stringify({ vipExpiresAt: now + 86_400_000, activeBoosters: { chip: { mult: 1.5, expiresAt: now + 3_600_000 } } }),
      });
      const r = await edb.settleDailyLogin(id, { now });
      // day 5: 7,500 chips / 10 stars → VIP 11,250 / 15 → booster 16,875 chips
      expect(r).toMatchObject({ ok: true, day: 5, vip: true, chipBoost: 1.5, chips: 16875, stars: 15 });
    });

    it('Day 7 grants the advertised Mystery Box (a real roll in the same transaction; a duplicate item pays stars)', async () => {
      const id = await mkUser({ login_streak: 6, last_login_claim_date: await denver(-1) });
      await pool.query(`INSERT INTO user_inventory (user_id, item_type, item_id) VALUES ($1, 'emote', 'nice_hand')`, [id]);
      // roll 0.9 → item; index 0 → emote nice_hand (owned) → 40% of the 500-star box = 200 stars
      const r: any = await edb.settleDailyLogin(id, { rng: seq(0.9, 0.0) });
      expect(r).toMatchObject({ ok: true, day: 7, mysteryBox: { kind: 'stars', amount: 200, reason: 'duplicate_refund' } });
      expect(r.stars).toBe(50 + 200);
      expect((await row(id)).stars).toBe(250);
      const id2 = await mkUser({ login_streak: 13, last_login_claim_date: await denver(-1) });
      const r2: any = await edb.settleDailyLogin(id2, { rng: seq(0.1, 0.5) });   // chips roll
      expect(r2.day).toBe(7);
      expect(r2.mysteryBox.kind).toBe('chips');
      expect(r2.chips).toBe(20000 + r2.mysteryBox.amount);
    });
  });

  describe('spin / scratch / missions', () => {
    it('daily spin: once per Denver day under concurrency; pays the landed segment', async () => {
      const id = await mkUser();
      const res = await Promise.all([0, 1, 2].map(() => edb.settleDailySpin(id, { rng: seq(0.99) })));
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      expect(res.find((r) => r.ok)).toMatchObject({ segmentId: 'chips_10000', chips: 10000 });
      expect((await row(id)).chips).toBe(20000);
    });

    it('scratch card: no card → refused, nothing paid; a card is consumed AND paid in one transaction; a duplicate emote pays stars', async () => {
      const id = await mkUser({ scratch_cards_available: 0 });
      expect(await edb.settleScratchCard(id)).toEqual({ ok: false, code: 'no_cards_available' });
      await pool.query('UPDATE users SET scratch_cards_available = 2 WHERE id = $1', [id]);
      await pool.query(`INSERT INTO user_inventory (user_id, item_type, item_id) VALUES ($1, 'emote', 'nice_hand')`, [id]);
      const dup: any = await edb.settleScratchCard(id, { rng: seq(0.25, 0.0) });   // item roll → nice_hand (owned)
      expect(dup).toMatchObject({ ok: true, reward: { kind: 'stars', amount: 25, reason: 'duplicate_refund' }, stars: 25 });
      const chips: any = await edb.settleScratchCard(id, { rng: seq(0.5, 0.5) });
      expect(chips.reward.kind).toBe('chips');
      const r = await row(id);
      expect(r.scratch_cards_available).toBe(0);
      expect(r.stars).toBe(25);
      expect(r.chips).toBe(10000 + chips.reward.amount);
    });

    it('mission claim: once (ledger keyed by the mission date); boosted chips', async () => {
      const id = await mkUser();
      const date = await denver(0);
      const a = await Promise.all([1, 2, 3].map(() => edb.settleMissionClaim(id, date, 'win_3', { chips: 1000, stars: 0 })));
      expect(a.filter((x) => x.ok)).toHaveLength(1);
      expect((await row(id)).chips).toBe(11000);
      const ledger = (await pool.query(`SELECT claim_type, to_char(claim_date,'YYYY-MM-DD') AS d FROM user_daily_claims WHERE user_id=$1`, [id])).rows;
      expect(ledger).toEqual([{ claim_type: `mission:${date}:win_3`, d: date }]);
    });
  });

  describe('achievements + level-ups (ECON-10)', () => {
    it('a lifetime achievement pays ONCE across 5 concurrent settlements (two seats / two processes); an id already in users.achievements pays nothing', async () => {
      const id = await mkUser({ achievements: '["first_win"]' });
      const res = await Promise.all([1, 2, 3, 4, 5].map(() => edb.settleAchievementReward(id, 'lifetime', 'hands_100', '', { chips: 2000, stars: 10 })));
      expect(res.filter((r) => r.status === 'paid')).toHaveLength(1);
      const r = await row(id);
      expect(r.chips).toBe(12000);
      expect(r.stars).toBe(10);
      expect(JSON.parse(r.achievements).sort()).toEqual(['first_win', 'hands_100']);
      expect(await edb.settleAchievementReward(id, 'lifetime', 'first_win', '', { chips: 1000, stars: 5 })).toMatchObject({ status: 'already' });
      expect((await row(id)).chips).toBe(12000);
    });

    it('daily / weekly: once per window; a new window pays again', async () => {
      const id = await mkUser();
      expect((await edb.settleAchievementReward(id, 'daily', 'd_play_5', '2026-10-11', { chips: 500, stars: 2 })).status).toBe('paid');
      expect((await edb.settleAchievementReward(id, 'daily', 'd_play_5', '2026-10-11', { chips: 500, stars: 2 })).status).toBe('already');
      expect((await edb.settleAchievementReward(id, 'daily', 'd_play_5', '2026-10-12', { chips: 500, stars: 2 })).status).toBe('paid');
      expect((await edb.settleAchievementReward(id, 'weekly', 'w_play_100', '2026-10-11', { chips: 5000, stars: 25 })).status).toBe('paid');
      expect((await edb.settleAchievementReward(id, 'weekly', 'w_play_100', '2026-10-11', { chips: 5000, stars: 25 })).status).toBe('already');
      expect((await row(id)).chips).toBe(10000 + 500 + 500 + 5000);
    });

    it('level-ups pay once PER LEVEL even when users.level was already raised by a save (the old `WHERE level < $new` race lost the reward)', async () => {
      const id = await mkUser({ level: 5, xp: 10 });
      await am.saveProgress(id, { level: 6, xp: 3 });           // the hand-complete save landed first
      const a = await edb.settleLevelUps(id, [{ level: 6, chips: 3000, stars: 30 }], 6, 3);
      expect(a.paidLevels).toEqual([6]);
      const b = await edb.settleLevelUps(id, [{ level: 6, chips: 3000, stars: 30 }], 6, 3);   // a stale re-cross
      expect(b.paidLevels).toEqual([]);
      const r = await row(id);
      expect(r.chips).toBe(13000);
      expect(r.level).toBe(6);
    });

    it('saveProgress: level ratchets and xp belongs to that level (a stale lower level never writes its xp)', async () => {
      const id = await mkUser({ level: 9, xp: 100 });
      await am.saveProgress(id, { level: 8, xp: 5000 });
      expect([(await row(id)).level, (await row(id)).xp]).toEqual([9, 100]);
      await am.saveProgress(id, { level: 9, xp: 50 });
      expect((await row(id)).xp).toBe(100);
      await am.saveProgress(id, { level: 10, xp: 7 });
      expect([(await row(id)).level, (await row(id)).xp]).toEqual([10, 7]);
    });

    it('mergeUserStats monotonic: counters never go down, windows keep the newest, other keys overwrite (TEXT stats column)', async () => {
      const id = await mkUser({ stats: JSON.stringify({ handsPlayed: 100, masterUserId: 'm-1', dailyStats: { handsPlayed: 9 }, dailyStatsDate: '2026-10-11' }) });
      await am.mergeUserStats(id, { handsPlayed: 90, handsWon: 4, elo: 520, dailyStats: { handsPlayed: 3 }, dailyStatsDate: '2026-10-11' }, { monotonic: true });
      const s = JSON.parse((await row(id)).stats);
      expect(s).toMatchObject({ handsPlayed: 100, handsWon: 4, elo: 520, masterUserId: 'm-1', dailyStats: { handsPlayed: 9 }, dailyStatsDate: '2026-10-11' });
      await am.saveProgress(id, { stats: { handsPlayed: 50, tournamentsWon: 2 } });   // the SIGTERM flush shape
      expect(JSON.parse((await row(id)).stats)).toMatchObject({ handsPlayed: 100, tournamentsWon: 2 });
    });

    it('tickScratchProgress returns the wallet with the tick (the hand-complete push is DB-fresh)', async () => {
      const id = await mkUser({ chips: 777, stars: 3, hands_since_last_scratch: 19, scratch_cards_available: 1 });
      expect(await am.tickScratchProgress(id)).toEqual({ awarded: true, chips: 777, stars: 3, scratchCardsAvailable: 2 });
      expect(await am.tickScratchProgress(id)).toMatchObject({ awarded: false, scratchCardsAvailable: 2 });
    });
  });

  describe('purchases (C7 / C8 / ECON-16)', () => {
    it('cosmetic: stars deducted then granted; not enough stars → nothing; already owned → no charge; 4 concurrent buys of one item charge ONCE', async () => {
      const id = await mkUser({ stars: 1000 });
      expect(await edb.purchaseCosmetic(id, 'frame', 'diamond', 5000)).toEqual({ ok: false, code: 'not_enough_stars' });
      const res = await Promise.all([1, 2, 3, 4].map(() => edb.purchaseCosmetic(id, 'frame', 'bronze', 500)));
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      expect(res.filter((r) => !r.ok).every((r: any) => r.code === 'already_owned')).toBe(true);
      expect((await row(id)).stars).toBe(500);
      const inv = (await pool.query('SELECT item_type, item_id FROM user_inventory WHERE user_id=$1', [id])).rows;
      expect(inv).toEqual([{ item_type: 'frame', item_id: 'bronze' }]);
    });

    it('bundle: duplicates refund 25% pro rata; everything owned → refused, nothing charged', async () => {
      const id = await mkUser({ stars: 5000 });
      await pool.query(`INSERT INTO user_inventory (user_id, item_type, item_id) VALUES ($1,'card_back','silver_foil')`, [id]);
      const a: any = await edb.purchaseBundle(id, 'starter', 800);
      expect(a).toMatchObject({ ok: true, duplicates: 1, refund: Math.floor((800 * 0.25) / 3) });
      expect((await row(id)).stars).toBe(5000 - 800 + a.refund);
      expect(await edb.purchaseBundle(id, 'starter', 800)).toEqual({ ok: false, code: 'already_owned' });
      expect((await row(id)).stars).toBe(5000 - 800 + a.refund);
    });

    it('chip pack / mystery box: stars → chips in one transaction; the box result is {kind, amount} | {kind:item}', async () => {
      const id = await mkUser({ stars: 3000 });
      expect(await edb.purchaseChipPack(id, 'small', 100)).toMatchObject({ ok: true, payout: 25000 });
      const box: any = await edb.purchaseMysteryBox(id, 'premium', 2000, { rng: seq(0.85, 0.0) });
      expect(box.mysteryReward).toEqual({ kind: 'item', itemType: 'frame', itemId: 'silver' });
      const r = await row(id);
      expect(r.chips).toBe(35000);
      expect(r.stars).toBe(900);
    });

    it('booster and VIP pass EXTEND (time is added, never lost); stored in stats under the row lock', async () => {
      const now = Date.now();
      const id = await mkUser({ stars: 10000 });
      const b1: any = await edb.purchaseBooster(id, 400, 'chip', 1.5, 3_600_000, { now });
      const b2: any = await edb.purchaseBooster(id, 400, 'chip', 1.5, 3_600_000, { now: now + 1000 });
      expect(b2.booster.expiresAt).toBe(b1.booster.expiresAt + 3_600_000);
      const v1: any = await edb.purchaseVipPass(id, 300, 86_400_000, { now });
      const v2: any = await edb.purchaseVipPass(id, 300, 86_400_000, { now: now + 5 });
      expect(v2.vipExpiresAt).toBe(v1.vipExpiresAt + 86_400_000);
      const s = JSON.parse((await row(id)).stats);
      expect(s.vipExpiresAt).toBe(v2.vipExpiresAt);
      expect(s.activeBoosters.chip.expiresAt).toBe(b2.booster.expiresAt);
      expect((await row(id)).stars).toBe(10000 - 1400);
    });

    it('Battle Pass premium: bought ONCE (3 concurrent purchases charge 950 once); remembered; the premium track checks it', async () => {
      const id = await mkUser({ stars: 5000 });
      expect(await edb.hasBattlePassPremium(id, 'season_1_the_river')).toBe(false);
      const res = await Promise.all([1, 2, 3].map(() => edb.purchaseBattlePassPremium(id, 'season_1_the_river', 950)));
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      expect((await row(id)).stars).toBe(4050);
      expect(await edb.hasBattlePassPremium(id, 'season_1_the_river')).toBe(true);
      expect(await edb.purchaseBattlePassPremium(id, 'season_1_the_river', 950)).toEqual({ ok: false, code: 'already_owned' });
    });

    it('a Battle Pass tier claim + its chips in one transaction: a failing credit rolls the claim row back', async () => {
      const id = await mkUser();
      await expect(edb.withEconomyTx(async (tx) => {
        expect(await am.claimBattlePassTier(id, 'season_1_the_river', 10, 'free', tx)).toBe(true);
        throw new Error('credit failed');
      })).rejects.toThrow('credit failed');
      const left = (await pool.query('SELECT COUNT(*)::int AS n FROM user_battle_pass_claims WHERE user_id=$1', [id])).rows[0].n;
      expect(left).toBe(0);   // claimable again — the reward was never lost
      await edb.withEconomyTx(async (tx) => {
        expect(await am.claimBattlePassTier(id, 'season_1_the_river', 10, 'free', tx)).toBe(true);
        expect(await am.addChipsToUser(id, 2000, tx)).toBe(true);
      });
      expect((await row(id)).chips).toBe(12000);
    });

    it('equip: only owned items; a FREE catalog item is owned by everyone; null unequips', async () => {
      const id = await mkUser();
      expect(await edb.equipItemTx(id, 'frame', 'gold', false)).toEqual({ ok: false, code: 'not_owned' });
      expect(await edb.equipItemTx(id, 'theme', 'green_felt', true)).toMatchObject({ ok: true });
      await pool.query(`INSERT INTO user_inventory (user_id, item_type, item_id) VALUES ($1,'theme','royal_gold')`, [id]);
      await edb.equipItemTx(id, 'theme', 'royal_gold', false);
      const eq = (await pool.query(`SELECT item_id FROM user_inventory WHERE user_id=$1 AND item_type='theme' AND equipped`, [id])).rows;
      expect(eq).toEqual([{ item_id: 'royal_gold' }]);
      await edb.equipItemTx(id, 'theme', null, false);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM user_inventory WHERE user_id=$1 AND equipped`, [id])).rows[0].n).toBe(0);
    });
  });

  describe('VIP monthly, career, keyed credits', () => {
    it('VIP monthly bonus: needs an active pass; once per month', async () => {
      const now = Date.now();
      const noVip = await mkUser();
      expect(await edb.settleVipMonthly(noVip, '2026-10', 25000, { now })).toEqual({ ok: false, code: 'vip_required' });
      const vip = await mkUser({ stats: JSON.stringify({ vipExpiresAt: now + 60_000 }) });
      const a = await Promise.all([1, 2, 3].map(() => edb.settleVipMonthly(vip, '2026-10', 25000, { now })));
      expect(a.filter((x) => x.ok)).toHaveLength(1);
      expect((await row(vip)).chips).toBe(35000);
      expect(await edb.settleVipMonthly(vip, '2026-11', 25000, { now })).toMatchObject({ ok: true });
    });

    it('career venue reward once (claim + chips + catalog item in one transaction)', async () => {
      const id = await mkUser();
      const a = await Promise.all([1, 2].map(() => edb.settleCareerReward(id, 2, 15000, ['theme', 'royal_gold'])));
      expect(a.filter((x) => x.ok)).toHaveLength(1);
      expect((await row(id)).chips).toBe(25000);
      expect((await pool.query(`SELECT item_id FROM user_inventory WHERE user_id=$1`, [id])).rows).toEqual([{ item_id: 'royal_gold' }]);
    });

    it('creditOnce: a key pays once (Spin & Go prize)', async () => {
      const id = await mkUser();
      const a = await Promise.all([1, 2, 3].map(() => edb.creditOnceWithRetry('spingo:T-1', id, 5000, 0, 'spingo_prize')));
      expect(a.filter((x) => x.status === 'credited')).toHaveLength(1);
      expect((await row(id)).chips).toBe(15000);
    });
  });

  describe('season award (C9)', () => {
    it('ranks by chips WON in the month — never an admin, banned, tombstone or guest; pays top 3 + badges ONCE (3 concurrent sweeps)', async () => {
      await pool.query('DELETE FROM user_chip_wins');
      const admin = await mkUser({ is_admin: true });
      const banned = await mkUser({ banned: true });
      const guest = await mkUser({ username: `Guest${9000 + n}` });
      const a = await mkUser({ display_name: 'Alpha' });
      const b = await mkUser({ display_name: 'Bravo' });
      const c = await mkUser({ display_name: 'Charlie' });
      const loser = await mkUser({ display_name: 'Delta' });
      const add = (u: number, day: string, won: number) => edb.recordChipWins(u, day, won);
      await add(admin, '2026-09-10', 9_000_000);
      await add(banned, '2026-09-10', 8_000_000);
      await add(guest, '2026-09-10', 7_000_000);
      await add(a, '2026-09-03', 40_000); await add(a, '2026-09-04', 10_000);   // 50k
      await add(b, '2026-09-30', 60_000);                                        // 60k
      await add(c, '2026-09-15', 20_000);
      await add(loser, '2026-09-15', -5_000);
      await add(c, '2026-10-01', 999_999);                                       // October: not this season
      const standings = await edb.chipsWonStandings('2026-09-01', '2026-09-30', 10);
      expect(standings.map((s) => s.userId)).toEqual([b, a, c]);
      const runs = await Promise.all([1, 2, 3].map(() => edb.awardSeason('2026-09', 'test')));
      expect(runs.filter((r) => r.status === 'awarded')).toHaveLength(1);
      const won = runs.find((r) => r.status === 'awarded')!;
      expect(won.winners.map((w) => [w.id, w.place, w.chips, w.badge])).toEqual([[b, 1, 50000, 'season_gold'], [a, 2, 25000, 'season_silver'], [c, 3, 10000, 'season_bronze']]);
      expect((await row(b)).chips).toBe(60000);
      expect((await pool.query(`SELECT item_type, item_id FROM user_inventory WHERE user_id=$1`, [b])).rows).toEqual([{ item_type: 'badge', item_id: 'season_gold' }]);
      expect((await pool.query(`SELECT winners FROM season_award_runs WHERE season_key='2026-09'`)).rows).toEqual([{ winners: 3 }]);
      // A month with no eligible winner is marked run too (the sweep never retries it).
      expect(await edb.awardSeason('2025-01', 'test')).toMatchObject({ status: 'awarded', winners: [] });
      expect((await edb.awardSeason('2025-01', 'test')).status).toBe('already_awarded');
    });
  });

  describe('hydration bundle (ECON-12)', () => {
    it('reads everything the record needs on one connection: inventory, today\'s windows, ledgers, claims, BP premium, public id', async () => {
      const id = await mkUser({ achievements: '["first_win"]', stars: 1000, scratch_cards_available: 4 });
      await pool.query(`INSERT INTO user_inventory (user_id, item_type, item_id, equipped) VALUES ($1,'frame','gold',TRUE), ($1,'avatar_frame','silver',FALSE)`, [id]);
      await pool.query(`INSERT INTO user_achievements (user_id, ach_id) VALUES ($1,'hands_100')`, [id]);
      const today = await denver(0);
      await pool.query(`INSERT INTO user_daily_claims (user_id, claim_type, claim_date) VALUES ($1, $2, $3::date), ($1, 'spin', (NOW() AT TIME ZONE 'America/Denver')::date)`, [id, `mission:${today}:win_3`, today]);
      await edb.purchaseBattlePassPremium(id, 'season_1_the_river', 950);
      const b = await edb.loadProgressBundle(id, { utcToday: '2026-10-11', utcWeekStart: '2026-10-11', battlePassSeason: 'season_1_the_river' });
      expect(b).toMatchObject({
        userId: id, stars: 50, scratchCardsAvailable: 4, achievements: ['first_win'], lifetimeLedger: ['hands_100'],
        missionClaims: ['win_3'], spinClaimedToday: true, battlePassPremium: true, denverToday: today,
      });
      expect(b!.publicId).toMatch(/^p[0-9a-f]{15}$/);
      expect(b!.inventory).toEqual(expect.arrayContaining([
        { itemType: 'frame', itemId: 'gold', equipped: true }, { itemType: 'frame', itemId: 'silver', equipped: false },
      ]));
    });
  });

  describe('social bracket side bets (ECON-14)', () => {
    it('the organizer and the players in the bracket are refused; betting closes at the first elimination (also atomically at write)', async () => {
      const org = await mkUser();
      const fan = await mkUser({ display_name: 'Fan' });
      const made = await brackets.createBracket(org, `B${Date.now() % 1_000_000}`, 'B', 'neon', ['Alice', 'Bob', 'Fan']);
      const id = made.state!.bracketId;
      expect(await brackets.sideBetRefusal(id, org, ['Org'])).toMatchObject({ code: 'organizer_cannot_bet' });
      expect(await brackets.sideBetRefusal(id, fan, ['fan'])).toMatchObject({ code: 'player_cannot_bet' });
      const stranger = await mkUser({ display_name: 'Stranger' });
      expect(await brackets.sideBetRefusal(id, stranger, ['Stranger'])).toBeNull();
      expect((await brackets.addSideBet(id, 'Stranger', 'Alice', 100, stranger, ['Stranger'])).ok).toBe(true);
      expect((await brackets.addSideBet(id, 'Org', 'Alice', 100, org, ['Org'])).ok).toBe(false);   // the INSERT itself refuses
      await brackets.eliminatePlayer(id, org, 'Bob');
      expect(await brackets.sideBetRefusal(id, stranger, ['Stranger'])).toMatchObject({ code: 'betting_closed' });
      expect(await brackets.addSideBet(id, 'Stranger', 'Alice', 100, stranger, ['Stranger'])).toMatchObject({ ok: false, code: 'betting_closed' });
    });
  });
});

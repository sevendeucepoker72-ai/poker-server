/**
 * 2026-10-10 — one person, one local account (src/auth/accountMerge.ts).
 *
 * Pins the PURE merge rules. The DB half (runAccountMerge / runGoodwillGrant /
 * the redirect trigger) was rehearsed end to end on a restored copy of the
 * production .online database (114 split masters / 240 rows → 114 survivors,
 * balances + prediction wallets + child rows invariant, resolver → survivor for
 * every master, goodwill exactly once); see AGENT.md "Account merge".
 */
import {
  pickSurvivor, planAccountMerge, tombstoneUsername, isMergedTombstone, mergedIntoOf,
  masterRowSql, REPOINT_SPECS, GOODWILL_SINCE_ISO, GOODWILL_AMOUNT, type LocalUserRow,
} from '../src/auth/accountMerge';

const M = '7cb738db-17dc-49f3-9d48-c80aa26b397a';
const NOW = '2026-10-10T19:00:00.000Z';

function row(over: Partial<LocalUserRow> & { id: number }): LocalUserRow {
  return {
    username: `u${over.id}`, display_name: `U ${over.id}`, chips: 50_000, stars: 0, level: 1, xp: 0,
    stats: JSON.stringify({ masterUserId: M }), achievements: '[]', is_admin: false, banned: false,
    token_version: 0, created_at: '2026-05-19T18:15:53.027Z', login_streak: 0, last_login_claim_date: null,
    scratch_cards_available: 0, hands_since_last_scratch: 0, customization: {}, preferences: {},
    ...over,
  };
}

// The real pair from production (Josh): OIDC row 868 + ticket row 890.
const josh868 = row({
  id: 868, username: 'Josh Hall', display_name: 'Josh Hall', chips: 1_366_856, stars: 16_081, level: 75, xp: 1866,
  stats: JSON.stringify({ masterUserId: M, masterDisplayName: 'Josh Hall', handsPlayed: 4000, handsWon: 900, biggestPot: 300_000, lastHandAt: 1_791_000_000_000 }),
  achievements: JSON.stringify(['first_win', 'lvl_75', 'pot_10k']), scratch_cards_available: 2, login_streak: 3,
  last_login_claim_date: '2026-10-09',
});
const josh890 = row({
  id: 890, username: 'josh.hall2', display_name: 'Josh H.', chips: 2_668_577, stars: 13_013, level: 67, xp: 402,
  stats: JSON.stringify({ masterUserId: M, masterUsername: 'josh.hall2', handsPlayed: 3000, handsWon: 600, biggestPot: 500_000, lastHandAt: 1_790_000_000_000, variantsPlayed: ['omaha'] }),
  achievements: JSON.stringify(['first_win', 'pot_200k']), scratch_cards_available: 1, login_streak: 7,
  last_login_claim_date: '2026-10-10', is_admin: true,
});

describe('pickSurvivor — the row a person keeps', () => {
  it('prefers the most recently played row', () => {
    expect(pickSurvivor([josh890, josh868]).id).toBe(868);
  });
  it('then the highest level, then most chips, then the lowest id', () => {
    const a = row({ id: 5, level: 3 }); const b = row({ id: 4, level: 9 });
    expect(pickSurvivor([a, b]).id).toBe(4);
    const c = row({ id: 7, chips: 10 }); const d = row({ id: 6, chips: 20 });
    expect(pickSurvivor([c, d]).id).toBe(6);
    expect(pickSurvivor([row({ id: 9 }), row({ id: 8 })]).id).toBe(8);
  });
  it('is order-independent', () => {
    const rows = [row({ id: 1, level: 2 }), row({ id: 2, level: 5 }), row({ id: 3, level: 5, chips: 1 })];
    expect(pickSurvivor(rows).id).toBe(pickSurvivor([...rows].reverse()).id);
  });
});

describe('planAccountMerge — Josh 868 + 890', () => {
  const plan = planAccountMerge(M, [josh868, josh890], NOW);
  const s = plan.survivor;
  const stats = JSON.parse(s.stats);

  it('keeps 868 and retires 890', () => {
    expect(plan.survivorId).toBe(868);
    expect(plan.loserIds).toEqual([890]);
    expect(plan.refuse).toBeUndefined();
  });
  it('SUMS chips, stars and scratch cards — nothing minted, nothing lost', () => {
    expect(s.chips).toBe(1_366_856 + 2_668_577);
    expect(s.stars).toBe(16_081 + 13_013);
    expect(s.scratch_cards_available).toBe(3);
    expect(plan.totals).toEqual({ chips: s.chips, stars: s.stars, scratch: 3 });
  });
  it('keeps the highest level with ITS xp', () => {
    expect(s.level).toBe(75);
    expect(s.xp).toBe(1866);
  });
  it('unions achievements and variants, sums hand counters, maxes best results', () => {
    // The union of both rows' lists, plus every achievement the merged state
    // already satisfies (pre-marked so it is never paid again — review fix).
    const ach: string[] = JSON.parse(s.achievements);
    for (const id of ['first_win', 'lvl_75', 'pot_10k', 'pot_200k']) expect(ach).toContain(id);
    expect([...ach].sort()).toEqual(ach); // stored sorted, no duplicates
    expect(new Set(ach).size).toBe(ach.length);
    expect(stats.handsPlayed).toBe(7000);
    expect(stats.handsWon).toBe(1500);
    expect(stats.biggestPot).toBe(500_000);
    expect(stats.lastHandAt).toBe(1_791_000_000_000);
    expect(stats.variantsPlayed).toEqual(['omaha']);
  });
  it('keeps the master link and fills identity keys from the other row', () => {
    expect(stats.masterUserId).toBe(M);
    expect(stats.masterDisplayName).toBe('Josh Hall');
    expect(stats.masterUsername).toBe('josh.hall2');
    expect(stats.accountMergedFrom).toEqual([890]);
  });
  it('ORs admin, maxes streak and claim date, keeps the survivor name', () => {
    expect(s.is_admin).toBe(true);
    expect(s.banned).toBe(false);
    expect(s.login_streak).toBe(7);
    expect(s.last_login_claim_date).toBe('2026-10-10');
    expect(s.display_name).toBe('Josh Hall');
  });
  it('turns 890 into a tombstone the resolver can never pick', () => {
    expect(plan.tombstones).toHaveLength(1);
    const t = plan.tombstones[0];
    expect(t.id).toBe(890);
    expect(t.username).toBe('merged-890-josh.hall2');
    expect(t.token_version).toBe(1); // its resume tokens die
    const ts = JSON.parse(t.stats);
    expect(ts.mergedInto).toBe(868);
    expect(ts.masterUserId).toBeUndefined(); // no longer resolvable by master id
    expect(ts.handsPlayed).toBeUndefined(); // counters live on the survivor only
    expect(isMergedTombstone(t.stats)).toBe(true);
    expect(mergedIntoOf(t.stats)).toBe(868);
    expect(isMergedTombstone(s.stats)).toBe(false);
  });
});

describe('planAccountMerge — edges', () => {
  it('three rows: one survivor, two tombstones, all balances summed', () => {
    const rows = [row({ id: 662, username: '7202984894', chips: 50_000 }), row({ id: 1350, chips: 364_278, level: 28, stars: 2723 }), row({ id: 1364, chips: 70_710, level: 12, stars: 507 })];
    const p = planAccountMerge(M, rows, NOW);
    expect(p.loserIds).toHaveLength(2);
    expect(p.survivor.chips).toBe(50_000 + 364_278 + 70_710);
    expect(p.survivor.stars).toBe(2723 + 507);
    expect(new Set([p.survivorId, ...p.loserIds])).toEqual(new Set([662, 1350, 1364]));
  });
  it('refuses a merge that would overflow a 32-bit balance', () => {
    const p = planAccountMerge(M, [row({ id: 1, chips: 2_000_000_000 }), row({ id: 2, chips: 200_000_000 })], NOW);
    expect(p.refuse).toMatch(/int4 overflow/);
  });
  it('propagates a ban to the person (any row banned → survivor banned)', () => {
    const p = planAccountMerge(M, [row({ id: 1 }), row({ id: 2, banned: true })], NOW);
    expect(p.survivor.banned).toBe(true);
  });
  it('keeps recovery-grant flags so a one-time grant can never pay twice', () => {
    const p = planAccountMerge(M, [row({ id: 1 }), row({ id: 2, stats: JSON.stringify({ masterUserId: M, chipRecoveryGrantApplied: true, chipRecoveryGrantAt: 'x' }) })], NOW);
    const st = JSON.parse(p.survivor.stats);
    expect(st.chipRecoveryGrantApplied).toBe(true);
    expect(st.chipRecoveryGrantAt).toBe('x');
  });
  it('tolerates corrupt stats / achievements text', () => {
    const p = planAccountMerge(M, [row({ id: 1, stats: '{not json', achievements: 'nope' }), row({ id: 2 })], NOW);
    expect(JSON.parse(p.survivor.stats).masterUserId).toBe(M);
    expect(JSON.parse(p.survivor.achievements)).toEqual([]);
  });
  it('needs at least two rows', () => {
    expect(() => planAccountMerge(M, [row({ id: 1 })], NOW)).toThrow();
  });
});

describe('resolver SQL and constants', () => {
  it('is TEXT-safe and corrupt-row-safe, and skips tombstones', () => {
    const sql = masterRowSql('$1');
    expect(sql).toContain("pg_input_is_valid(users.stats::text, 'jsonb')");
    expect(sql).toContain("->> 'masterUserId'");
    expect(sql).toContain("? 'mergedInto'");
    expect(sql).not.toMatch(/[^:]stats->>/); // the old TEXT-breaking form
  });
  it('tombstone usernames are unique per row id', () => {
    expect(tombstoneUsername(1, 'Josh Hall')).not.toBe(tombstoneUsername(2, 'Josh Hall'));
  });
  it('covers every user-keyed table the merge must move', () => {
    const keys = REPOINT_SPECS.map((s) => `${s.table}.${s.col}`);
    for (const k of ['user_hand_history.user_id', 'user_daily_claims.user_id', 'user_daily_achievements.user_id',
      'user_weekly_achievements.user_id', 'user_battle_pass_claims.user_id', 'user_inventory.user_id']) {
      expect(keys).toContain(k);
    }
  });
  it('goodwill: 50,000 chips, since 2026-06-19 00:00 Denver', () => {
    expect(GOODWILL_AMOUNT).toBe(50_000);
    expect(GOODWILL_SINCE_ISO).toBe('2026-06-19T06:00:00.000Z');
  });
});

describe('review fixes (2026-10-10)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const am = require('../src/auth/accountMerge') as typeof import('../src/auth/accountMerge');

  it('a lookup that cannot be answered THROWS (after retries) — never "no row"', async () => {
    let calls = 0;
    const pool: any = { query: async () => { calls++; throw new Error('timeout exceeded when trying to connect'); } };
    await expect(am.findLocalUserByMasterId(pool, M)).rejects.toBeInstanceOf(am.MasterLookupError);
    expect(calls).toBe(3); // first try + 2 retries
  });

  it('a transient lookup error is retried and then answers', async () => {
    let calls = 0;
    const pool: any = { query: async () => { calls++; if (calls === 1) throw new Error('reset'); return { rows: [{ id: 868, stats: JSON.stringify({ masterUserId: M }) }] }; } };
    const r = await am.findLocalUserByMasterId(pool, M);
    expect(r.id).toBe(868);
    expect(calls).toBe(2);
  });

  it('"not found" is null (a real answer), not an error', async () => {
    const pool: any = { query: async () => ({ rows: [] }) };
    await expect(am.findLocalUserByMasterId(pool, M)).resolves.toBeNull();
  });

  it('withMasterLock serializes the SAME master and leaves others parallel', async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`); return tag; };
    const results = await Promise.all([
      am.withMasterLock('m1', slow('a', 30)),
      am.withMasterLock('m1', slow('b', 1)),
      am.withMasterLock('m2', slow('c', 1)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    // b starts only after a finished; c (another master) does not wait for a.
    expect(order.indexOf('b+')).toBeGreaterThan(order.indexOf('a-'));
    expect(order.indexOf('c+')).toBeLessThan(order.indexOf('a-'));
  });

  it('withMasterLock releases after a failure', async () => {
    await expect(am.withMasterLock('m3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(am.withMasterLock('m3', async () => 'ok')).resolves.toBe('ok');
  });

  it('identityStampPatch returns only the changed identity keys', () => {
    const stats = JSON.stringify({ masterUserId: M, masterUsername: 'josh.hall2', handsPlayed: 9 });
    expect(am.identityStampPatch(stats, { masterUserId: M, masterUsername: 'josh.hall2' })).toBeNull();
    expect(am.identityStampPatch(stats, { masterUserId: M, masterPhone: '7205551234' })).toEqual({ masterPhone: '7205551234' });
    expect(am.identityStampPatch('{}', { masterUserId: M, masterDisplayName: undefined })).toEqual({ masterUserId: M });
  });
});

describe('chip-safety review fixes (2026-10-10)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const am = require('../src/auth/accountMerge') as typeof import('../src/auth/accountMerge');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pm = require('../src/progression/ProgressionManager') as typeof import('../src/progression/ProgressionManager');

  it('lifetimeAchievementsSatisfiedBy reads the same checks the payout uses', () => {
    const got = pm.lifetimeAchievementsSatisfiedBy({ level: 75, totalHandsPlayed: 7000, handsWon: 1500, biggestPot: 500_000 });
    for (const id of ['lvl_25', 'lvl_75', 'hands_100', 'hands_1000', 'hands_5000', 'wins_50', 'wins_250', 'wins_1000', 'pot_10k', 'pot_50k', 'pot_200k', 'first_win']) {
      expect(got).toContain(id);
    }
    expect(got).not.toContain('hands_10000');
    expect(got).not.toContain('pot_1m');
    expect(pm.lifetimeAchievementsSatisfiedBy({})).toEqual([]);
  });

  it('a merge marks every achievement the MERGED state satisfies as earned — nothing pays again', () => {
    const plan = planAccountMerge(M, [josh868, josh890], NOW);
    const ach: string[] = JSON.parse(plan.survivor.achievements);
    // 4000 + 3000 hands (hands_5000), 900 + 600 wins (wins_1000) and the other
    // row's 500k pot (pot_200k) are reached only by merging — pre-marked.
    for (const id of ['hands_5000', 'wins_1000', 'pot_200k', 'lvl_75']) expect(ach).toContain(id);
    const satisfied = pm.lifetimeAchievementsSatisfiedBy(am.progressStateFrom(plan.survivor.level, plan.survivor.stats));
    expect(satisfied.filter((id) => !ach.includes(id))).toEqual([]);
  });

  it('progressStateFrom maps stored stats onto PlayerProgress field names', () => {
    const st = am.progressStateFrom(12, JSON.stringify({ handsPlayed: 30, handsWon: 4, fullHouseHits: 1, variantsPlayed: ['omaha'] }));
    expect(st).toMatchObject({ level: 12, totalHandsPlayed: 30, handsWon: 4, fullHouseHits: 1, variantsPlayed: ['omaha'] });
  });

  it('newer counters are summed, VIP keeps the latest expiry, boosters the longest per kind', () => {
    const a = row({ id: 1, stats: JSON.stringify({ masterUserId: M, vpipHands: 10, quadsHits: 1, vipExpiresAt: 100, activeBoosters: { xp: { mult: 2, expiresAt: 50 } }, lastHandAt: 2 }) });
    const b = row({ id: 2, stats: JSON.stringify({ masterUserId: M, vpipHands: 5, quadsHits: 2, vipExpiresAt: 300, activeBoosters: { xp: { mult: 2, expiresAt: 90 }, chips: { mult: 2, expiresAt: 10 } }, lastHandAt: 1 }) });
    const st = JSON.parse(planAccountMerge(M, [a, b], NOW).survivor.stats);
    expect(st.vpipHands).toBe(15);
    expect(st.quadsHits).toBe(3);
    expect(st.vipExpiresAt).toBe(300);
    expect(st.activeBoosters).toEqual({ xp: { mult: 2, expiresAt: 90 }, chips: { mult: 2, expiresAt: 10 } });
  });
});

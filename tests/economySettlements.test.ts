/**
 * .online R2 (S3, 2026-10-11) — the economy settlements' STATEMENT ORDER on a
 * scripted client (CI: no Postgres; the real-SQL behaviour is proven in
 * economyPostgres.test.ts):
 *   - a purchase DEDUCTS the stars, THEN grants — and a refused grant ROLLS
 *     BACK the deduct (ECON-6: purchaseShopItem used to grant first);
 *   - a claim writes its LEDGER row, THEN credits — a lost ledger insert
 *     credits nothing; ledger + credit commit together (ECON-17);
 *   - the login streak is computed in SQL on the Denver calendar (ECON-4);
 *   - every refusal / error is a ROLLBACK.
 */
import {
  withEconomyTx, purchaseCosmetic, purchaseBattlePassPremium, settleDailyLogin, settleAchievementReward, creditOnceWithRetry, settleMissionClaim,
  settleScratchCard,
  type TxPool,
} from '../src/economy/economyDb';

type Reply = { rows?: any[]; rowCount?: number } | Error;
function scripted(answer: (sql: string, params: unknown[]) => Reply) {
  const log: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const head = sql.replace(/\s+/g, ' ').trim();
      log.push(head);
      const r = answer(head, params);
      if (r instanceof Error) throw r;
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? (r.rows ? r.rows.length : 0) };
    },
    release: () => {},
  };
  const pool = { connect: async () => client, query: client.query } as unknown as TxPool;
  return { log, pool };
}
const userRow = (over: Record<string, unknown> = {}) => ({
  id: 7, chips: 1000, stars: 2000, stats: '{}', achievements: '[]', login_streak: 3, last_login_claim_date: '2026-10-10',
  next_login_streak: 4, scratch_cards_available: 0, denver_today: '2026-10-11', ...over,
});
const kind = (h: string) =>
  h.startsWith('SELECT id, chips, stars') ? 'lock'
    : h.startsWith('UPDATE users SET stars = stars -') ? 'deduct'
      : h.startsWith('INSERT INTO user_inventory') ? 'grant'
        : h.startsWith('INSERT INTO user_daily_claims') ? 'ledger'
          : h.startsWith('INSERT INTO user_achievements') ? 'ach_ledger'
            : h.startsWith('INSERT INTO user_battle_pass_premium') ? 'bp_ledger'
              : h.startsWith('INSERT INTO economy_credits') ? 'credit_ledger'
                : h.startsWith('UPDATE users SET chips = chips +') ? 'credit'
                  : h.startsWith('UPDATE users SET login_streak') ? 'streak'
                    : h.startsWith('SELECT chips, stars') ? 'balances'
                      : h.split(' ')[0];

describe('purchases: deduct THEN grant; a refused grant rolls the deduct back', () => {
  it('a cosmetic: BEGIN → lock → deduct → grant → balances → COMMIT', async () => {
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('UPDATE users SET stars = stars -')) return { rows: [{ stars: 1500 }], rowCount: 1 };
      if (h.startsWith('INSERT INTO user_inventory')) return { rowCount: 1 };
      if (h.startsWith('SELECT chips, stars')) return { rows: [{ chips: 1000, stars: 1500, scratch_cards_available: 0 }] };
      return {};
    });
    expect(await purchaseCosmetic(7, 'frame', 'bronze', 500, pool)).toMatchObject({ ok: true, itemType: 'frame', itemId: 'bronze', balances: { stars: 1500 } });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'deduct', 'grant', 'balances', 'COMMIT']);
  });

  it('already owned: the deduct is ROLLED BACK (stars never kept for nothing)', async () => {
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('UPDATE users SET stars = stars -')) return { rows: [{ stars: 1500 }], rowCount: 1 };
      if (h.startsWith('INSERT INTO user_inventory')) return { rowCount: 0 };
      return {};
    });
    expect(await purchaseCosmetic(7, 'frame', 'bronze', 500, pool)).toEqual({ ok: false, code: 'already_owned' });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'deduct', 'grant', 'ROLLBACK']);
  });

  it('not enough stars: no grant at all', async () => {
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow({ stars: 10 })] };
      if (h.startsWith('UPDATE users SET stars = stars -')) return { rowCount: 0 };
      return {};
    });
    expect(await purchaseCosmetic(7, 'frame', 'gold', 2000, pool)).toEqual({ ok: false, code: 'not_enough_stars' });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'deduct', 'ROLLBACK']);
  });

  it('Battle Pass premium: a second purchase is already_owned and its deduct is rolled back (never charged twice)', async () => {
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('UPDATE users SET stars = stars -')) return { rows: [{ stars: 1050 }], rowCount: 1 };
      if (h.startsWith('INSERT INTO user_battle_pass_premium')) return { rowCount: 0 };
      return {};
    });
    expect(await purchaseBattlePassPremium(7, 'season_1_the_river', 950, pool)).toEqual({ ok: false, code: 'already_owned' });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'deduct', 'bp_ledger', 'ROLLBACK']);
  });
});

describe('claims: ledger row THEN credit, one transaction', () => {
  it('daily login: the streak is computed IN SQL on the Denver calendar; ledger before credit; a lost ledger insert credits nothing', async () => {
    let ledgerWins = true;
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('INSERT INTO user_daily_claims')) return { rowCount: ledgerWins ? 1 : 0 };
      if (h.startsWith('UPDATE users SET chips = chips +')) return { rows: [{ chips: 6000, stars: 2005, scratch_cards_available: 0 }] };
      if (h.startsWith('UPDATE users SET login_streak')) return { rows: [{ chips: 6000, stars: 2005, scratch_cards_available: 0, last_login_claim_date: '2026-10-11' }] };
      return {};
    });
    expect(await settleDailyLogin(7, {}, pool)).toMatchObject({ ok: true, day: 4, streak: 4, chips: 5000, stars: 5 });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'ledger', 'credit', 'streak', 'COMMIT']);
    const lockSql = log[1];
    expect(lockSql).toContain("CASE WHEN last_login_claim_date = (NOW() AT TIME ZONE 'America/Denver')::date - 1 THEN COALESCE(login_streak, 0) + 1 ELSE 1 END");
    expect(log[2]).toContain("(NOW() AT TIME ZONE 'America/Denver')::date");
    log.length = 0;
    ledgerWins = false;
    expect(await settleDailyLogin(7, {}, pool)).toEqual({ ok: false, code: 'already_claimed' });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'ledger', 'ROLLBACK']);
  });

  it('a row already claimed today (last_login_claim_date = Denver today) is refused before the ledger', async () => {
    const { log, pool } = scripted((h) => (h.startsWith('SELECT id, chips, stars') ? { rows: [userRow({ last_login_claim_date: '2026-10-11' })] } : {}));
    expect(await settleDailyLogin(7, {}, pool)).toEqual({ ok: false, code: 'already_claimed' });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'ROLLBACK']);
  });

  it('an achievement: the ledger INSERT decides — no row, no credit (paid elsewhere)', async () => {
    let inserted = 1;
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('INSERT INTO user_achievements')) return { rowCount: inserted };
      if (h.startsWith('UPDATE users SET chips = chips +')) return { rows: [{ chips: 3000, stars: 2010, scratch_cards_available: 0 }] };
      return {};
    });
    expect(await settleAchievementReward(7, 'lifetime', 'hands_100', '', { chips: 2000, stars: 10 }, {}, pool)).toMatchObject({ status: 'paid', chips: 2000 });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'ach_ledger', 'UPDATE', 'credit', 'COMMIT']);
    log.length = 0;
    inserted = 0;
    expect(await settleAchievementReward(7, 'lifetime', 'hands_100', '', { chips: 2000, stars: 10 }, {}, pool)).toMatchObject({ status: 'already', chips: 0 });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'ach_ledger', 'COMMIT']);
  });

  it('a mission claim keys its ledger row by the MISSION date', async () => {
    const { log, pool } = scripted((h, p) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('INSERT INTO user_daily_claims')) { expect(p.slice(1, 3)).toEqual(['mission:2026-10-11:win_3', '2026-10-11']); return { rowCount: 1 }; }
      if (h.startsWith('UPDATE users SET chips = chips +')) return { rows: [{ chips: 2000, stars: 2000, scratch_cards_available: 0 }] };
      return {};
    });
    expect(await settleMissionClaim(7, '2026-10-11', 'win_3', { chips: 1000, stars: 0 }, {}, pool)).toMatchObject({ ok: true, chips: 1000 });
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'ledger', 'credit', 'COMMIT']);
  });

  it('a scratch card that rolls a FREE wheel emote (fire) pays the duplicate stars — nothing is inserted into the inventory', async () => {
    const { log, pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow({ scratch_cards_available: 1 })] };
      if (h.startsWith('UPDATE users SET scratch_cards_available')) return { rows: [{ scratch_cards_available: 0 }], rowCount: 1 };
      if (h.startsWith('UPDATE users SET chips = chips +')) return { rows: [{ chips: 1000, stars: 2025, scratch_cards_available: 0 }] };
      return {};
    });
    // rng: 0.25 -> the emote branch; 0.6 -> index 2 of [nice_hand, good_game, fire, crown] = fire
    const seq = [0.25, 0.6];
    const r: any = await settleScratchCard(7, { rng: () => seq.shift() ?? 0 }, pool);
    expect(r).toMatchObject({ ok: true, stars: 25, reward: { kind: 'stars', amount: 25, reason: 'duplicate_refund', itemType: 'emote', itemId: 'fire' } });
    expect(log.map(kind)).not.toContain('grant');
    expect(log.map(kind)).toEqual(['BEGIN', 'lock', 'UPDATE', 'credit', 'COMMIT']);
  });

  it('withEconomyTx: an error rolls back and is re-thrown', async () => {
    const { log, pool } = scripted(() => ({}));
    await expect(withEconomyTx(async (tx) => { await tx.query('SELECT 1'); throw new Error('boom'); }, pool)).rejects.toThrow('boom');
    expect(log.map(kind)).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
  });

  it('creditOnceWithRetry: a transient error is retried; a duplicate key is final', async () => {
    let fails = 2;
    let dup = false;
    const { pool } = scripted((h) => {
      if (h.startsWith('SELECT id, chips, stars')) return { rows: [userRow()] };
      if (h.startsWith('INSERT INTO economy_credits')) { if (fails > 0) { fails--; return new Error('connection reset'); } return { rowCount: dup ? 0 : 1 }; }
      if (h.startsWith('UPDATE users SET chips = chips +')) return { rows: [{ chips: 6000, stars: 2000, scratch_cards_available: 0 }] };
      return {};
    });
    expect(await creditOnceWithRetry('spingo:T', 7, 5000, 0, 'spingo_prize', {}, { delayMs: 1, pool })).toMatchObject({ status: 'credited' });
    dup = true;
    expect(await creditOnceWithRetry('spingo:T', 7, 5000, 0, 'spingo_prize', {}, { delayMs: 1, pool })).toMatchObject({ status: 'duplicate' });
    fails = 99;
    expect(await creditOnceWithRetry('spingo:T2', 7, 5000, 0, 'spingo_prize', {}, { delayMs: 1, attempts: 2, pool })).toMatchObject({ status: 'failed' });
  });
});

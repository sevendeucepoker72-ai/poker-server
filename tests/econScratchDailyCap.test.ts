/**
 * Bots review 2026-11-04 (economy-farming E7 parts 1-4) — the daily scratch-card
 * cap from hands, at the SQL boundary, with a fake pg Pool that captures every
 * statement and its params (the SQL itself runs against a real Postgres in
 * economyPostgres.test.ts when ECONOMY_TEST_PG_URL is set).
 *
 * Fails on 0dc1b96: tickScratchProgress sent params [userId] (no
 * SCRATCH_HANDS_PER_CARD / SCRATCH_CARDS_PER_DAY), its tick had no `capped`,
 * and initDB added no scratch_earned_on / scratch_earned_today columns.
 *
 * The capped notice (serverAnnouncement kind 'scratch_daily_limit') is an
 * index.ts change and is tested by the server lane (econHandRewardsGate).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-scratch-cap';

interface Captured { sql: string; params: unknown[] | undefined }
const mockPg: {
  queries: Captured[];
  reply: ((sql: string, params: unknown[] | undefined) => unknown) | null;
} = { queries: [], reply: null };

jest.mock('pg', () => ({
  Pool: class FakePool {
    constructor(public opts: unknown) {}
    on(): this { return this; }
    async query(sql: string, params?: unknown[]): Promise<unknown> {
      mockPg.queries.push({ sql, params });
      const r = mockPg.reply ? mockPg.reply(sql, params) : undefined;
      if (r instanceof Error) throw r;
      return r || { rows: [], rowCount: 0 };
    }
    async end(): Promise<void> {}
  },
  types: { setTypeParser() {} },
}));

type AuthManager = typeof import('../src/auth/authManager');

/** A fresh authManager module loaded with SCRATCH_CARDS_PER_DAY = `env` (undefined = unset). */
function loadWith(env: string | undefined): AuthManager {
  const saved = process.env.SCRATCH_CARDS_PER_DAY;
  if (env === undefined) delete process.env.SCRATCH_CARDS_PER_DAY; else process.env.SCRATCH_CARDS_PER_DAY = env;
  let mod: AuthManager | undefined;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('../src/auth/authManager') as AuthManager;
    });
  } finally {
    if (saved === undefined) delete process.env.SCRATCH_CARDS_PER_DAY; else process.env.SCRATCH_CARDS_PER_DAY = saved;
  }
  return mod!;
}

async function initFake(am: AuthManager): Promise<void> {
  const savedUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://fake:fake@127.0.0.1:1/fake';
  try { await am.initDB(); } finally {
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  }
}

const tickSql = (): Captured => {
  const q = mockPg.queries.filter((x) => /hands_since_last_scratch\s*=/.test(x.sql) && /RETURNING/.test(x.sql));
  expect(q).toHaveLength(1);
  return q[0];
};
const occurrences = (s: string, needle: string): number => s.split(needle).length - 1;

let log: jest.SpyInstance; let warn: jest.SpyInstance;
beforeEach(() => {
  mockPg.queries = []; mockPg.reply = null;
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); warn.mockRestore(); });

describe('E7 — SCRATCH_CARDS_PER_DAY / SCRATCH_HANDS_PER_CARD', () => {
  it('default 10 per day; 20 hands per card', () => {
    const am = loadWith(undefined);
    expect(am.SCRATCH_CARDS_PER_DAY).toBe(10);
    expect(am.SCRATCH_HANDS_PER_CARD).toBe(20);
  });

  it.each([
    ['0', 0], ['15', 15], ['junk', 10], ['', 10], ['  ', 10], ['-3', 10], ['2.5', 10],
  ])('env SCRATCH_CARDS_PER_DAY=%j gives %d (0 = no cap; anything not a non-negative integer = the default 10)', (env, want) => {
    expect(loadWith(env).SCRATCH_CARDS_PER_DAY).toBe(want);
  });
});

describe('E7 — initDB self-migration', () => {
  it('adds users.scratch_earned_on DATE and users.scratch_earned_today INTEGER NOT NULL DEFAULT 0 (IF NOT EXISTS), next to the scratch columns', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    const sqls = mockPg.queries.map((q) => q.sql.replace(/\s+/g, ' ').trim());
    const iCounter = sqls.indexOf('ALTER TABLE users ADD COLUMN IF NOT EXISTS hands_since_last_scratch INTEGER NOT NULL DEFAULT 0');
    const iOn = sqls.indexOf('ALTER TABLE users ADD COLUMN IF NOT EXISTS scratch_earned_on DATE');
    const iToday = sqls.indexOf('ALTER TABLE users ADD COLUMN IF NOT EXISTS scratch_earned_today INTEGER NOT NULL DEFAULT 0');
    expect(iCounter).toBeGreaterThan(-1);
    expect(iOn).toBeGreaterThan(iCounter);
    expect(iToday).toBeGreaterThan(iOn);
  });
});

describe('E7 — tickScratchProgress: one atomic UPDATE with the Denver-day cap', () => {
  it('sends [userId, SCRATCH_HANDS_PER_CARD, SCRATCH_CARDS_PER_DAY] = [7, 20, 10]', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    mockPg.queries = [];
    await am.tickScratchProgress(7);
    expect(tickSql().params).toEqual([7, 20, 10]);
  });

  it('the cap value follows the env (0 = no cap is sent as 0)', async () => {
    const am = loadWith('0');
    await initFake(am);
    mockPg.queries = [];
    await am.tickScratchProgress(9);
    expect(tickSql().params).toEqual([9, 20, 0]);
  });

  it('the SQL: Denver day, IS NOT DISTINCT FROM, the award condition INLINE in all four CASEs (never in the FROM subquery), the counter held with LEAST, capped returned', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    mockPg.queries = [];
    await am.tickScratchProgress(7);
    const sql = tickSql().sql.replace(/\s+/g, ' ');
    expect(sql).toContain("AT TIME ZONE 'America/Denver'");
    expect(sql).toContain('IS NOT DISTINCT FROM');
    const A = 'WHEN hands_since_last_scratch + 1 >= $2 AND NOT ($3 > 0 AND scratch_earned_on IS NOT DISTINCT FROM d.today AND scratch_earned_today >= $3)';
    expect(occurrences(sql, A)).toBe(4);
    for (const col of ['hands_since_last_scratch', 'scratch_cards_available', 'scratch_earned_today', 'scratch_earned_on']) {
      expect(sql).toMatch(new RegExp(`\\b${col} = (${col} \\+ )?CASE ${A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} THEN`));
    }
    expect(sql).toContain('ELSE LEAST(hands_since_last_scratch + 1, $2) END');
    expect(sql).toContain("FROM (SELECT (NOW() AT TIME ZONE 'America/Denver')::date AS today) d WHERE users.id = $1");
    const fromSub = sql.slice(sql.indexOf('FROM ('), sql.indexOf(') d WHERE'));
    expect(fromSub).not.toMatch(/\$[23]|hands_since|scratch_earned/);   // the subquery reads nothing of the row
    expect(sql).toContain('(users.hands_since_last_scratch >= $2) AS capped');
    expect(sql).toMatch(/^UPDATE users SET /);
    expect(occurrences(sql, 'UPDATE users')).toBe(1);                   // one statement, no second round trip
  });

  it('maps the row: hands_since 20 + capped → {awarded: false, capped: true}; hands_since 0 → awarded; mid-count → neither; no row / DB error → false', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    const rowOf = (r: Record<string, unknown>) => () => ({ rows: [r], rowCount: 1 });

    mockPg.reply = rowOf({ hands_since_last_scratch: 20, chips: '12345', stars: 7, scratch_cards_available: 3, capped: true });
    expect(await am.tickScratchProgress(7)).toEqual({ awarded: false, chips: 12345, stars: 7, scratchCardsAvailable: 3, capped: true });

    mockPg.reply = rowOf({ hands_since_last_scratch: 0, chips: 500, stars: 1, scratch_cards_available: 4, capped: false });
    expect(await am.tickScratchProgress(7)).toEqual({ awarded: true, chips: 500, stars: 1, scratchCardsAvailable: 4, capped: false });

    mockPg.reply = rowOf({ hands_since_last_scratch: 5, chips: 500, stars: 1, scratch_cards_available: 4, capped: false });
    expect(await am.tickScratchProgress(7)).toMatchObject({ awarded: false, capped: false });

    mockPg.reply = rowOf({ hands_since_last_scratch: 20, chips: 1, stars: 1, scratch_cards_available: 0, capped: null });
    expect(await am.tickScratchProgress(7)).toMatchObject({ capped: false });   // only a real `true` is capped

    mockPg.reply = () => ({ rows: [], rowCount: 0 });
    expect(await am.tickScratchProgress(7)).toBe(false);

    mockPg.reply = (sql) => (/hands_since_last_scratch\s*=/.test(sql) ? new Error('column "scratch_earned_on" does not exist') : undefined);
    expect(await am.tickScratchProgress(7)).toBe(false);
  });
});

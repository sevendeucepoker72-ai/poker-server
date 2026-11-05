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

/**
 * Fix round 2 (2026-11-05, ECON-R2 / SCD-1) — the cap's two columns come from two boot
 * ALTERs whose errors initDB used to swallow (`.catch(() => {})`): if they did not apply
 * (a lock wait past the pool's 8 s statement_timeout in a deploy overlap), every tick's
 * UPDATE failed with 42703 for the whole boot — no hand moved anyone toward a card, and
 * nothing said so. Now the failure is logged `[scratch-cap-columns]` and flagged
 * (scratchCapColumnState, health economy.handRewards.scratchCapColumns), and a tick that
 * finds a column missing runs the pre-cap UPDATE (0dc1b96's: no daily cap).
 * Fails on d1ec56a: no scratchCapColumnState; the 42703 tick returns false.
 */
describe('fix round 2 (ECON-R2 / SCD-1) — a missing cap column never stops scratch progress', () => {
  const undefinedColumn = () => Object.assign(new Error('column "scratch_earned_on" does not exist'), { code: '42703' });
  const tagged = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[scratch-cap-columns] '))
    .map((l) => JSON.parse(l.slice('[scratch-cap-columns] '.length)));
  let err: jest.SpyInstance;
  beforeEach(() => { err = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => err.mockRestore());

  it('initDB: each failed scratch_earned_* ALTER is logged (tagged, naming the column) and flagged; initDB still resolves; a clean boot flags nothing', async () => {
    const am = loadWith(undefined);
    mockPg.reply = (sql) => (/ADD COLUMN IF NOT EXISTS scratch_earned_/.test(sql) ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : undefined);
    await expect(initFake(am)).resolves.toBeUndefined();
    expect(am.scratchCapColumnState).toMatchObject({ alterFailed: true, alterFailures: 2, uncappedTicks: 0, lastError: 'canceling statement due to statement timeout' });
    expect(tagged(err)).toEqual([
      { event: 'alter_failed', column: 'scratch_earned_on', code: '57014', error: 'canceling statement due to statement timeout' },
      { event: 'alter_failed', column: 'scratch_earned_today', code: '57014', error: 'canceling statement due to statement timeout' },
    ]);

    const clean = loadWith(undefined);
    mockPg.reply = null;
    err.mockClear();
    await initFake(clean);
    expect(clean.scratchCapColumnState).toEqual({ alterFailed: false, alterFailures: 0, uncappedTicks: 0, lastError: null });
    expect(tagged(err)).toEqual([]);
  });

  it('a tick whose capped UPDATE fails with 42703 runs the pre-cap UPDATE (no scratch_earned_*, params [userId, 20]) and returns its tick (capped:false); counted, logged once', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    mockPg.queries = [];
    mockPg.reply = (sql) => (/scratch_earned/.test(sql) ? undefinedColumn()
      : /hands_since_last_scratch\s*=/.test(sql) ? { rows: [{ hands_since_last_scratch: 0, chips: '777', stars: 3, scratch_cards_available: 2 }], rowCount: 1 } : undefined);
    expect(await am.tickScratchProgress(7)).toEqual({ awarded: true, chips: 777, stars: 3, scratchCardsAvailable: 2, capped: false });
    const ticks = mockPg.queries.filter((q) => /hands_since_last_scratch\s*=/.test(q.sql));
    expect(ticks).toHaveLength(2);
    expect(ticks[0].sql).toContain('scratch_earned_on');              // the capped statement first
    const fallback = ticks[1].sql.replace(/\s+/g, ' ');
    expect(fallback).not.toContain('scratch_earned');
    expect(fallback).toContain('hands_since_last_scratch = CASE WHEN hands_since_last_scratch + 1 >= $2 THEN 0 ELSE hands_since_last_scratch + 1 END');
    expect(fallback).toContain('scratch_cards_available = scratch_cards_available + CASE WHEN hands_since_last_scratch + 1 >= $2 THEN 1 ELSE 0 END');
    expect(fallback).toMatch(/WHERE id = \$1 RETURNING hands_since_last_scratch, chips, stars, scratch_cards_available$/);
    expect(ticks[1].params).toEqual([7, 20]);
    await am.tickScratchProgress(7);
    expect(am.scratchCapColumnState.uncappedTicks).toBe(2);
    expect(tagged(err).map((l) => l.event)).toEqual(['uncapped_tick']);   // the first one (then every 1000th)
  });

  it('20 ticks with the columns missing bank exactly ONE card (a stateful row); d1ec56a banked none and every tick returned false', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    const row = { hands_since_last_scratch: 0, chips: 1000, stars: 0, scratch_cards_available: 0 };
    mockPg.reply = (sql, params) => {
      if (/scratch_earned/.test(sql)) return undefinedColumn();
      if (!/hands_since_last_scratch\s*=/.test(sql)) return undefined;
      const per = Number((params as unknown[])[1]);
      const hit = row.hands_since_last_scratch + 1 >= per;
      row.scratch_cards_available += hit ? 1 : 0;
      row.hands_since_last_scratch = hit ? 0 : row.hands_since_last_scratch + 1;
      return { rows: [{ ...row }], rowCount: 1 };
    };
    const out: any[] = [];
    for (let i = 0; i < 20; i++) out.push(await am.tickScratchProgress(7));
    expect(out.every((t) => t && typeof t === 'object' && t.capped === false)).toBe(true);
    expect(out.filter((t) => t.awarded)).toHaveLength(1);
    expect(out[19].awarded).toBe(true);
    expect(row).toMatchObject({ hands_since_last_scratch: 0, scratch_cards_available: 1 });
    expect(am.scratchCapColumnState.uncappedTicks).toBe(20);
  });

  it('any other error is no fallback: false, one statement (a missing row / a pool error is not a missing column)', async () => {
    const am = loadWith(undefined);
    await initFake(am);
    mockPg.queries = [];
    mockPg.reply = (sql) => (/hands_since_last_scratch\s*=/.test(sql) ? Object.assign(new Error('connection terminated'), { code: '57P01' }) : undefined);
    expect(await am.tickScratchProgress(7)).toBe(false);
    expect(mockPg.queries.filter((q) => /hands_since_last_scratch\s*=/.test(q.sql))).toHaveLength(1);
    expect(am.scratchCapColumnState.uncappedTicks).toBe(0);
  });
});

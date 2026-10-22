/**
 * 2026-10-22 (owner: "Save finish order to DB") — a qualifier's finish order
 * is saved in poker-server's audit_log table, not only in Railway stdout.
 *
 * The results POST to the master (/qualifiers/:id/results/internal) is what
 * awards the championship seats. Before the POST, postQualifierResults audits
 * the full finish order (QUALIFIER_RESULTS_RECORDED), and audits it again when
 * the POST fails for good (QUALIFIER_RESULTS_POST_FAILED). Neither action was
 * in DURABLE_AUDIT_ACTIONS, so both were stdout lines only: a restart or a lost
 * log made the order unrecoverable and no seats could be awarded. Now both rows
 * (plus QUALIFIER_RESULTS_POSTED, "the master took it") are durable, and
 * nothing about that write (a failing / hung DB, even a throwing auditLog) can
 * delay, stop or re-send the POST.
 *
 * Runs the REAL src/index.ts source (DURABLE_AUDIT_ACTIONS, _ensureAuditTable,
 * auditLog, postQualifierResults) against a fake pg pool and a fake master.
 */
import { slice, fnSrc, load, flush } from './helpers/indexSource';

const AUDIT_SRC = [
  slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);'),
  slice('let _auditTableReady = false;', '\n}\n'),
  slice('const PHONE_HANDLE_RE', '\n}\n'),
  fnSrc('function auditLog('),
].join('\n');
const POST_SRC = slice('const postedQualifierResults = new Set<string>();', '\n}\n');

// The Sunday 2026-10-25 weekly's master id (the live registry's one entry).
const QID = '7a8dd4a8-cc63-4c91-8da6-dacc8a58da38';

/** A finished qualifier: four account holders and a bot the master does not know. */
function field(n = 4) {
  const players = Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, masterPlayerId: `m-${i + 1}` }));
  const results = players.map((p, i) => ({ playerId: p.playerId, playerName: `P${i + 1}`, position: i + 1, payout: 0 }));
  results.push({ playerId: 'bot-1', playerName: 'Bot', position: n + 1, payout: 0 });
  const order = players.map((p, i) => ({ playerId: p.masterPlayerId, finishPosition: i + 1, pointsAwarded: 0 }));
  return { qt: { tournamentId: 'TQ', masterQualifierId: QID, players }, data: { tournamentId: 'TQ', results }, order };
}

type DbMode = 'ok' | 'reject' | 'hang' | 'getPool_throws';

function world(opts: { db?: DbMode; stdoutThrows?: boolean; postAnswers?: Array<{ ok: boolean; status: number }>; n?: number } = {}) {
  const { qt, data, order } = field(opts.n);
  const events: string[] = [];
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const posts: Array<{ url: string; headers: any; body: any }> = [];
  const lines: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const postAnswers = [...(opts.postAnswers || [])];
  const pool = {
    query: (sql: string, params?: any[]) => {
      events.push(`db:${sql.trim().split(/\s+/).slice(0, 2).join(' ')}`);
      // node-postgres sends an object parameter as JSON.stringify(value): the
      // JSONB column holds exactly that.
      queries.push({ sql, params: params && JSON.parse(JSON.stringify(params)) });
      if (opts.db === 'reject') return Promise.reject(new Error('Connection terminated unexpectedly'));
      if (opts.db === 'hang') return new Promise(() => { /* a DB that never answers */ });
      return Promise.resolve({ rows: [] });
    },
  };
  const scope: Record<string, unknown> = {
    qualifierTournaments: new Map([['weekly', qt]]),
    authSessions: new Map(),
    Sentry: null,
    getPool: () => {
      if (opts.db === 'getPool_throws') throw new Error('DATABASE_URL not set');
      return pool;
    },
    process: { env: { INTERNAL_NOTIFY_TOKEN: 'tok', MASTER_API_URL: 'https://master.test/poker-api' } },
    fetch: async (url: string, init: any) => {
      events.push('post');
      posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return postAnswers.shift() ?? { ok: true, status: 200 };
    },
    console: {
      log: (l: string) => { if (opts.stdoutThrows) throw new Error('EPIPE'); lines.push(String(l)); },
      warn: (...a: unknown[]) => { warns.push(a.map(String).join(' ')); },
      error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); },
    },
  };
  const { exports: m, stubbed } = load(`${AUDIT_SRC}\n${POST_SRC}`, scope, '{ postQualifierResults, qualifierResultPosts, auditLog }');
  /** The audit_log rows written (INSERT parameters), in order. */
  const rows = () => queries.filter((q) => /^INSERT INTO audit_log/.test(q.sql))
    .map((q) => ({ actor: q.params![0], action: q.params![1], details: q.params![2] }));
  return { m, stubbed, qt, data, order, events, queries, posts, lines, warns, errors, rows };
}

async function runTimers(rounds: number, ms: number): Promise<void> {
  for (let i = 0; i < rounds; i++) { await flush(); jest.advanceTimersByTime(ms); }
  await flush();
}

describe('the qualifier finish order is saved in audit_log (durable)', () => {
  it('the three qualifier-results actions are in DURABLE_AUDIT_ACTIONS; audit_log.details is JSONB', () => {
    const durable = slice('const DURABLE_AUDIT_ACTIONS = new Set([', ']);');
    for (const a of ['QUALIFIER_RESULTS_RECORDED', 'QUALIFIER_RESULTS_POSTED', 'QUALIFIER_RESULTS_POST_FAILED']) expect(durable).toContain(`'${a}'`);
    expect(slice('let _auditTableReady = false;', '\n}\n')).toContain('details JSONB');
  });

  it('RECORDED: the full order is written to audit_log as the POST goes out, and it IS the POST\'s results (the replay body)', async () => {
    const w = world();
    w.m.postQualifierResults('TQ', w.data);
    // The durable write was started before the POST went out, and the POST did
    // not wait for it (both in the same tick).
    expect(w.events[0]).toMatch(/^db:/);
    expect(w.events).toContain('post');
    await flush();
    const [recorded, posted, ...rest] = w.rows();
    expect(rest).toEqual([]);
    expect(recorded).toEqual({ actor: 'SYSTEM', action: 'QUALIFIER_RESULTS_RECORDED', details: { tournamentId: 'TQ', masterQualifierId: QID, finishOrder: w.order } });
    // The owner's replay: POST /qualifiers/<masterQualifierId>/results with
    // { results: details.finishOrder } — byte-for-byte what poker-server sent.
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0].url).toBe(`https://master.test/poker-api/qualifiers/${QID}/results/internal`);
    expect(w.posts[0].body).toEqual({ results: recorded.details.finishOrder });
    for (const r of recorded.details.finishOrder) expect(Object.keys(r).sort()).toEqual(['finishPosition', 'playerId', 'pointsAwarded']);
    // POSTED: the durable "the master took it" marker.
    expect(posted).toEqual({ actor: 'SYSTEM', action: 'QUALIFIER_RESULTS_POSTED', details: { tournamentId: 'TQ', masterQualifierId: QID, results: 4, attempts: 1 } });
    expect(w.m.qualifierResultPosts).toEqual({ posted: 1, retried: 0, failed: 0 });
    expect([...w.stubbed]).toEqual([]);
  });

  it('a big field (650 players) is saved whole: one row, every place, nothing truncated', async () => {
    const w = world({ n: 650 });
    w.m.postQualifierResults('TQ', w.data);
    await flush();
    const recorded = w.rows().find((r) => r.action === 'QUALIFIER_RESULTS_RECORDED')!;
    expect(recorded.details.finishOrder).toHaveLength(650);
    expect(recorded.details.finishOrder.map((r: any) => r.finishPosition)).toEqual(Array.from({ length: 650 }, (_, i) => i + 1));
    expect(w.posts[0].body).toEqual({ results: recorded.details.finishOrder });
  });

  it('POST_FAILED: a POST that never lands leaves a durable row with the order again (after the 8th attempt)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world({ postAnswers: Array.from({ length: 8 }, () => ({ ok: false, status: 503 })) });
      w.m.postQualifierResults('TQ', w.data);
      await runTimers(6, 100_000);
      expect(w.rows().map((r) => r.action)).toEqual(['QUALIFIER_RESULTS_RECORDED']);   // still retrying
      await runTimers(6, 400_000);
      expect(w.posts).toHaveLength(8);
      expect(w.rows()).toEqual([
        { actor: 'SYSTEM', action: 'QUALIFIER_RESULTS_RECORDED', details: { tournamentId: 'TQ', masterQualifierId: QID, finishOrder: w.order } },
        { actor: 'SYSTEM', action: 'QUALIFIER_RESULTS_POST_FAILED', details: { tournamentId: 'TQ', masterQualifierId: QID, results: 4, finishOrder: w.order, error: 'http_503' } },
      ]);
      expect(w.m.qualifierResultPosts).toEqual({ posted: 0, retried: 7, failed: 1 });
    } finally { jest.useRealTimers(); }
  });
});

describe('the durable write never blocks, stops or re-sends the results POST', () => {
  it.each<DbMode>(['reject', 'hang', 'getPool_throws'])('DB %s: the POST goes out at once, lands once; the failure is logged; stdout keeps the order', async (db) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world({ db });
      w.m.postQualifierResults('TQ', w.data);
      expect(w.posts).toHaveLength(1);                       // same tick: never waits on the DB
      await runTimers(4, 400_000);
      expect(w.posts).toHaveLength(1);                       // never re-sent
      expect(w.m.qualifierResultPosts).toEqual({ posted: 1, retried: 0, failed: 0 });
      // The durable write WAS attempted (getPool_throws: it throws inside the write).
      if (db !== 'getPool_throws') expect(w.queries.length).toBeGreaterThan(0);
      if (db === 'hang') {
        expect(w.warns).toEqual([]);                         // still waiting — and the POST did not
      } else {
        expect(w.warns).toEqual(expect.arrayContaining([expect.stringContaining('[AUDIT] durable write failed (non-fatal): QUALIFIER_RESULTS_RECORDED')]));
        expect(w.warns).toEqual(expect.arrayContaining([expect.stringContaining('[AUDIT] durable write failed (non-fatal): QUALIFIER_RESULTS_POSTED')]));
      }
      // The stdout [AUDIT] line still carries the whole order.
      expect(w.lines.find((l) => l.includes('| QUALIFIER_RESULTS_RECORDED |'))).toContain(JSON.stringify(w.order));
    } finally { jest.useRealTimers(); }
  });

  it('even an auditLog that THROWS (stdout gone) cannot stop the POST, nor make a landed POST retry', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const w = world({ stdoutThrows: true });
      expect(() => w.m.postQualifierResults('TQ', w.data)).not.toThrow();
      expect(w.posts).toHaveLength(1);
      expect(w.posts[0].body).toEqual({ results: w.order });
      await runTimers(4, 400_000);
      expect(w.posts).toHaveLength(1);
      expect(w.m.qualifierResultPosts).toEqual({ posted: 1, retried: 0, failed: 0 });
      expect(w.errors).toEqual(expect.arrayContaining([expect.stringContaining('[QualifierResults] audit failed (the POST is unaffected): QUALIFIER_RESULTS_RECORDED')]));
    } finally { jest.useRealTimers(); }
  });

  it('CONTROL — a tournament that is not a qualifier posts nothing and audits nothing', async () => {
    const w = world();
    w.m.postQualifierResults('T-other', { results: w.data.results });
    await flush();
    expect(w.posts).toEqual([]);
    expect(w.queries).toEqual([]);
    expect(w.lines).toEqual([]);
  });
});

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
import fs from 'fs';
import path from 'path';
import vm from 'vm';
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

// ── 2026-10-22 review fix-up — AGENT.md's recovery recipe, step 3. No admin
// page calls the replay route (poker-admin's qualifiersApi.recordResults is
// never used), so the recipe gives the owner a snippet to paste into the
// Console of a signed-in admin tab. These tests run THAT snippet, read from
// AGENT.md, in a fake admin tab, against the body step 2's SQL builds from a
// REAL QUALIFIER_RESULTS_RECORDED row.
const AGENT_MD = fs.readFileSync(path.join(__dirname, '..', 'AGENT.md'), 'utf8');
const ADMIN = '0b9a6f3e-6c7d-4f0e-9a51-2f4c1d7e8a90';
const KIOSK = '5d2c8e11-3b4a-4c6f-8e7d-9a0b1c2d3e4f';
/** The master poker-server itself posts to (its MASTER_API_URL default). */
const MASTER = (POST_SRC.match(/process\.env\.MASTER_API_URL \|\| '([^']+)'/) || [])[1];

function replaySnippet(): string {
  const m = AGENT_MD.match(/```js\n([ \t]*\/\/ qualifier-results-replay[\s\S]*?)\n[ \t]*```/);
  if (!m) throw new Error('AGENT.md has no qualifier-results-replay snippet');
  return m[1];
}

/** How Postgres prints jsonb as text: keys by length, then bytes; ", " and ": ". */
function pgJsonbText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pgJsonbText).join(', ')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${pgJsonbText(o[k])}`).join(', ')}}`;
  }
  return JSON.stringify(v);
}

function jwt(claims: Record<string, unknown>): string {
  const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}.signature`;
}

type FinishRow = { playerId: string; finishPosition: number | null; pointsAwarded: number };
interface StepTwo { players: number; finishOrder: FinishRow[]; replayBody: string; sentByServer: { url: string; headers: any; body: any } }

/** Step 2's output (`players`, `replay_body`) for a real RECORDED row, and the POST poker-server sent. */
async function stepTwo(n: number): Promise<StepTwo> {
  const w = world({ n });
  w.m.postQualifierResults('TQ', w.data);
  await flush();
  const recorded = w.rows().find((r) => r.action === 'QUALIFIER_RESULTS_RECORDED')!;
  const finishOrder = recorded.details.finishOrder as FinishRow[];
  return { players: finishOrder.length, finishOrder, replayBody: pgJsonbText({ results: finishOrder }), sentByServer: w.posts[0] };
}

type Answer = { ok: boolean; status: number; json: unknown };
interface Tab { storage?: Record<string, string | null>; answer?: Answer; fetchThrows?: boolean }
interface Req { url: string; method: string; headers: Record<string, string>; body: any }

/** Fill the snippet's three PASTE_ values and run it in a fake admin.americanpub.poker tab. */
async function pasteInAdminTab(fill: { qid: string; players: string; body: string }, tab: Tab = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const storage: Record<string, string | null> = {
    poker_admin_session: JSON.stringify({ user: { id: ADMIN, roles: ['siteAdmin'] }, timestamp: Date.now() }),
    oauth_access_token: jwt({ sub: ADMIN, exp: nowS + 900 }),
    oauth_id_token: jwt({ sub: ADMIN, exp: nowS + 3600 }),
    ...tab.storage,
  };
  const requests: Req[] = [];
  const logs: string[] = [];
  const errs: string[] = [];
  const fetchFake = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method || 'GET';
    requests.push({ url, method, headers: init.headers || {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (tab.fetchThrows) throw new TypeError('Failed to fetch');
    if (method === 'POST') {
      const a = tab.answer ?? { ok: true, status: 200, json: { success: true, data: { recorded: requests[0].body.results.length, advanced: { yearly: 16, monthly: 65 } } } };
      return { ok: a.ok, status: a.status, json: async () => a.json };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { results: requests[0].body.results } }) };
  };
  const code = replaySnippet()
    .replace("'PASTE_QUALIFIER_ID_HERE'", () => `'${fill.qid}'`)
    .replace('PASTE_PLAYERS_HERE', () => fill.players)
    .replace('PASTE_REPLAY_BODY_HERE', () => fill.body);
  const ctx = vm.createContext({
    localStorage: { getItem: (k: string) => (k in storage ? storage[k] : null) },
    fetch: fetchFake,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    console: {
      log: (...a: unknown[]) => { logs.push(a.map(String).join(' ')); },
      error: (...a: unknown[]) => { errs.push(a.map(String).join(' ')); },
    },
  });
  let outcome: unknown;
  let thrown: any = null;
  try { outcome = await vm.runInContext(code, ctx); } catch (e) { thrown = e; }
  return { outcome, thrown, requests, logs, errs, storage };
}

describe('the replay recipe (AGENT.md step 3): the snippet the owner pastes into an admin tab', () => {
  it('is in AGENT.md with each PASTE_ value once, and posts to the master poker-server posts to', () => {
    const s = replaySnippet();
    for (const p of ["'PASTE_QUALIFIER_ID_HERE'", 'PASTE_PLAYERS_HERE', 'PASTE_REPLAY_BODY_HERE']) expect(s.split(p)).toHaveLength(2);
    expect(MASTER).toBe('https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api');
    expect(s).toContain(`const API = '${MASTER}';`);
  });

  it('sends step 2\'s body as the admin replay: the exact results poker-server POSTed, the admin header + his own Bearer', async () => {
    const two = await stepTwo(650);
    const r = await pasteInAdminTab({ qid: QID, players: String(two.players), body: two.replayBody });
    expect(r.thrown).toBeNull();
    expect(r.errs).toEqual([]);
    expect(r.outcome).toBe('sent');
    expect(r.requests).toHaveLength(2);
    const [post, check] = r.requests;
    expect(post.url).toBe(`${MASTER}/qualifiers/${QID}/results`);
    expect(post.method).toBe('POST');
    expect(post.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Admin-User-Id': ADMIN,
      Authorization: `Bearer ${r.storage.oauth_access_token}`,
    });
    // Byte-for-byte the results array poker-server sent to /results/internal.
    expect(post.body).toEqual(two.sentByServer.body);
    expect(post.body.results).toHaveLength(650);
    // Then it re-reads the public qualifier and prints the count.
    expect(check).toEqual({ url: `${MASTER}/qualifiers/${QID}`, method: 'GET', headers: {}, body: undefined });
    expect(r.logs.join('\n')).toContain('SENT. The master recorded 650 results. Seats and monthly entries: {"yearly":16,"monthly":65}');
    expect(r.logs.join('\n')).toContain('Results now on the master: 650 (must be 650).');
  });

  it.each<[string, (t: StepTwo) => string]>([
    ['in quotes (a string)', (t) => JSON.stringify(t.replayBody)],
    ['as finishOrder alone (the array)', (t) => pgJsonbText(t.finishOrder)],
  ])('the body pasted %s sends the same POST', async (_label, paste) => {
    const two = await stepTwo(12);
    const r = await pasteInAdminTab({ qid: QID, players: String(two.players), body: paste(two) });
    expect(r.outcome).toBe('sent');
    expect(r.requests[0].body).toEqual(two.sentByServer.body);
  });

  it('an opaque access token: the id_token is the Bearer (the admin app\'s own choice)', async () => {
    const two = await stepTwo(4);
    const idt = jwt({ sub: ADMIN, exp: Math.floor(Date.now() / 1000) + 3600 });
    const r = await pasteInAdminTab({ qid: QID, players: '4', body: two.replayBody }, { storage: { oauth_access_token: 'opaqueAccessToken', oauth_id_token: idt } });
    expect(r.outcome).toBe('sent');
    expect(r.requests[0].headers.Authorization).toBe(`Bearer ${idt}`);
  });

  const soon = (): number => Math.floor(Date.now() / 1000) + 30;
  it.each<[string, (t: StepTwo) => { qid?: string; players?: string; body?: string; tab?: Tab }, RegExp]>([
    ['the id was not filled in', () => ({ qid: 'PASTE_QUALIFIER_ID_HERE' }), /QID is not a qualifier id/],
    ['the copied replay_body was cut off (pasted in quotes)', (t) => ({ body: JSON.stringify(t.replayBody.slice(0, -300)) }), /not complete JSON/],
    ['the player count is not step 2\'s', (t) => ({ players: String(t.players - 1) }), /has 650 players, step 2 said 649/],
    ['a row has no place', (t) => ({ body: pgJsonbText({ results: t.finishOrder.map((r, i) => (i === 7 ? { ...r, finishPosition: null } : r)) }) }), /no playerId or no place/],
    ['the tab is not signed in to admin', () => ({ tab: { storage: { poker_admin_session: null } } }), /not signed in to admin/],
    ['a kiosk "Admin Login" (the token is the kiosk\'s)', () => ({ tab: { storage: { oauth_access_token: jwt({ sub: KIOSK, exp: soon() + 900 }), oauth_id_token: jwt({ sub: KIOSK, exp: soon() + 900 }) } } }), /no sign-in token of your own/],
    ['no token at all', () => ({ tab: { storage: { oauth_access_token: null, oauth_id_token: null } } }), /no sign-in token of your own/],
    ['the token is about to expire', () => ({ tab: { storage: { oauth_access_token: jwt({ sub: ADMIN, exp: soon() }) } } }), /about to expire/],
  ])('NOT SENT when %s: nothing goes to the master', async (_label, make, why) => {
    const two = await stepTwo(650);
    const f = make(two);
    const r = await pasteInAdminTab({ qid: f.qid ?? QID, players: f.players ?? String(two.players), body: f.body ?? two.replayBody }, f.tab);
    expect(r.thrown).toBeNull();
    expect(r.outcome).toBe('not sent');
    expect(r.requests).toEqual([]);
    expect(r.errs).toHaveLength(1);
    expect(r.errs[0]).toMatch(/^NOT SENT: /);
    expect(r.errs[0]).toMatch(why);
  });

  it('a cut-off replay_body pasted without quotes does not even run: nothing goes out', async () => {
    const two = await stepTwo(650);
    const r = await pasteInAdminTab({ qid: QID, players: String(two.players), body: two.replayBody.slice(0, -300) });
    expect(r.thrown).not.toBeNull();
    expect(r.thrown.name).toBe('SyntaxError');
    expect(r.requests).toEqual([]);
  });

  it('the master refuses (401): REFUSED is printed, nothing is re-read', async () => {
    const two = await stepTwo(4);
    const r = await pasteInAdminTab({ qid: QID, players: '4', body: two.replayBody }, { answer: { ok: false, status: 401, json: { success: false, message: 'identity_mismatch' } } });
    expect(r.outcome).toBe('refused');
    expect(r.requests).toHaveLength(1);
    expect(r.errs.join('\n')).toContain('REFUSED (HTTP 401): identity_mismatch. Nothing was awarded.');
    expect(r.logs).toEqual([]);
  });

  it('no answer (network): it says a re-paste is safe', async () => {
    const two = await stepTwo(4);
    const r = await pasteInAdminTab({ qid: QID, players: '4', body: two.replayBody }, { fetchThrows: true });
    expect(r.outcome).toBe('no answer');
    expect(r.requests).toHaveLength(1);
    expect(r.errs.join('\n')).toContain('It is safe to paste again.');
  });
});

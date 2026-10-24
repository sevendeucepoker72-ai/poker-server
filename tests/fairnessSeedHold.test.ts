/**
 * 2026-10-24 (owner 2026-10-23: "Fix both") — a RUNNING qualifier's fairness
 * SEEDS are withheld until the qualifier ends.
 *
 * GET /api/fairness/:tableId and /:tableId/:handNumber are unauthenticated and
 * served each finished hand's seed. The seed rebuilds the whole deck
 * (CardDeck.ts; the repo is public), so anyone with a table id saw every
 * opponent's folded / mucked cards during a seat event. Now, for a table of a
 * qualifier tournament that is still running: the commitment (hash) is served,
 * the seed is not (`seed: null, seedHeld: true`); the moment that qualifier ends
 * (finished, cancelled, pruned, or unknown after a restart) every one of its
 * seeds is served and verifies. The stamp (`holdForTournamentId`) travels with
 * the entry, so a table broken mid-event stays held, and it is persisted to
 * Redis. The pre-hand `deckCommitment` frame carries `seedHeld: true` there.
 * Non-qualifier tables (cash, Sit & Go) are byte-identical to before, and the
 * per-hand 'deckSeedRevealed' still never reaches a client (F162).
 *
 * The REAL index.ts source (sliced): both routes, recordRevealedCommitment and
 * the hold helpers, the deck listeners, tournamentIdOfTable / isTournamentTable,
 * qualifierOfTournament, qualifierListItem — on the REAL PokerTable and
 * TournamentManager.
 */
import { createHash } from 'crypto';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import {
  qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
  QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft,
} from '../src/game/qualifierSchedule';
import { SRC, slice, fnSrc, load } from './helpers/indexSource';

const CODE = [
  slice('const brokenTournamentTables = new Map', 'brokenTournamentTables.has(tableId);\n}\n'),
  fnSrc('function qualifierOfTournament('),
  slice('// Rolling buffer of revealed deck commitments per table', '// ===== end fairness seed hold =====\n'),
  slice("app.get('/api/fairness/:tableId', (req, res) => {", '\n});\n'),
  slice("app.get('/api/fairness/:tableId/:handNumber', (req, res) => {", '\n});\n'),
  `function wireFairness(table, tableId) {\n${slice("  table.on('deckSeedRevealed',", "committedAt: Date.now(), tableId });\n  });\n")}\n}`,
].join('\n');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function world(extraScope: Record<string, unknown> = {}) {
  const tm = new TournamentManager();
  const tournamentTables = new Map<string, string>();
  const qualifierTournaments = new Map<string, any>();
  const routes = new Map<string, (req: any, res: any) => void>();
  const room: Array<[string, string, any]> = [];
  const appended: Array<[string, any, number | undefined]> = [];
  const tables = new Map<string, PokerTable>();
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, SEAT_RESERVE_MS: 6 * 3600_000,
    app: { get: (p: string, fn: (req: any, res: any) => void) => { routes.set(p, fn); } },
    io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) },
    appendFairnessCommitment: async (tid: string, e: any, keep?: number) => { appended.push([tid, e, keep]); },
    console: { log() {}, warn() {}, error() {} },
    ...extraScope,
  };
  const { exports: m, stubbed } = load(CODE, scope, `{
    recordRevealedCommitment, revealedCommitmentsByTable, wireFairness, brokenTournamentTables,
    fairnessSeedHoldOf, fairnessSeedIsHeld, publicFairnessEntry, seedHeldFieldsFor, fairnessSeedHoldStats,
    trimFairnessBuffer, restoreFairnessBuffer, fairnessRedisKeepFor, fairnessEventBufferStats,
  }`);
  const startTournament = (n = 2) => {
    const tid = tm.createTournament({ name: 'T', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 720 }], startingChips: 50_000 } as any);
    for (let i = 0; i < n; i++) tm.registerPlayer(tid, `${tid}-p${i}`, `P${i}`, `s${i}`, undefined, `m-${tid}-${i}`);
    expect(tm.startTournament(tid)).toBeTruthy();
    return tid;
  };
  /** A table playing real hands (two seats), its deck listeners wired as ensureTableProgressListener does. */
  const table = (id: string, tournamentId?: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 100_000, maxPlayers: 9 } as any);
    t.sitDown(0, 'A', 5000, `${id}-a`, false);
    t.sitDown(1, 'B', 5000, `${id}-b`, false);
    if (tournamentId) tournamentTables.set(id, tournamentId);
    tables.set(id, t);
    m.wireFairness(t, id);
    return t;
  };
  const playHand = (t: PokerTable) => {
    expect(t.startNewHand()).toBe(true);
    let guard = 0;
    while (t.isHandInProgress() && guard++ < 10) t.playerFold(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
  };
  const get = (path: string, params: Record<string, string>) => {
    const out: { status: number; body: any } = { status: 200, body: null };
    const res = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = JSON.parse(JSON.stringify(b)); return res; } };
    routes.get(path)!({ params }, res);
    return out;
  };
  const list = (tableId: string) => get('/api/fairness/:tableId', { tableId });
  const one = (tableId: string, hand: number) => get('/api/fairness/:tableId/:handNumber', { tableId, handNumber: String(hand) });
  const finish = (tid: string) => {
    const t = tm.getTournament(tid)!;
    for (const p of [...t.players].slice(1)) tm.eliminatePlayer(tid, p.playerId);
    expect(t.status).toBe('finished');
  };
  return { tm, m, stubbed, tournamentTables, qualifierTournaments, room, appended, tables, startTournament, table, playHand, list, one, finish };
}

/** A running QUALIFIER (two tables QA / QB), a running Sit & Go (SG), a cash table (C1); `hands` hands each. */
function field(hands = 2) {
  const w = world();
  const qtid = w.startTournament(3);
  w.qualifierTournaments.set('Q-weekly', { tournamentId: qtid, status: 'running', qualifierType: 'weekly', players: [] });
  const sng = w.startTournament(2);
  const QA = w.table('QA', qtid);
  const QB = w.table('QB', qtid);
  const SG = w.table('SG', sng);
  const C1 = w.table('C1');
  for (let i = 0; i < hands; i++) for (const t of [QA, QB, SG, C1]) w.playHand(t);
  return { ...w, qtid, sng, QA, QB, SG, C1 };
}

describe('FS1 — while the qualifier RUNS: the hash is served, the seed is held (seed:null, seedHeld:true); cash / Sit & Go tables are byte-identical to before', () => {
  it('list + single route at a qualifier table: no seed anywhere in the answer; at a cash and a Sit & Go table: exactly {seed, hash, handNumber, revealedAt} with the seed (9c37499: the seed of every finished qualifier hand)', () => {
    const x = field(2);
    const qa = x.list('QA');
    expect(qa.status).toBe(200);
    expect(qa.body.tableId).toBe('QA');
    expect(qa.body.commitments).toHaveLength(2);
    for (const c of qa.body.commitments) {
      expect(c).toEqual({ handNumber: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/), revealedAt: expect.any(Number), seed: null, seedHeld: true });
    }
    const hand = qa.body.commitments[0].handNumber;
    const single = x.one('QA', hand);
    expect(single.status).toBe(200);
    expect(single.body).toEqual({ tableId: 'QA', handNumber: hand, hash: qa.body.commitments[0].hash, revealedAt: expect.any(Number), seed: null, seedHeld: true });
    // No real seed leaks through either route (the private buffer holds it).
    const seeds = x.m.revealedCommitmentsByTable.get('QA').map((r: any) => r.seed);
    expect(seeds.every((s: any) => typeof s === 'string' && s.length > 0)).toBe(true);
    for (const s of seeds) expect(JSON.stringify([qa.body, single.body])).not.toContain(s);
    // Cash + Sit & Go: unchanged, key order included (byte-identical JSON).
    for (const id of ['C1', 'SG']) {
      const body = x.list(id).body;
      expect(body.commitments).toHaveLength(2);
      for (const c of body.commitments) {
        expect(Object.keys(c)).toEqual(['seed', 'hash', 'handNumber', 'revealedAt']);
        expect(sha(c.seed)).toBe(c.hash);
      }
      const s = x.one(id, body.commitments[0].handNumber).body;
      expect(s).toEqual({ tableId: id, handNumber: body.commitments[0].handNumber, seed: body.commitments[0].seed, hash: body.commitments[0].hash, computedHash: body.commitments[0].hash, verified: true, revealedAt: body.commitments[0].revealedAt });
    }
    expect(x.one('QA', 999).status).toBe(404);
    expect(x.m.fairnessSeedHoldStats.heldEntriesServed).toBe(3);
  });
});

describe('FS2 — the moment the qualifier ENDS, every held seed is served and verifies', () => {
  it('finished: both tables serve every seed, sha256(seed) === hash, the single route says verified:true', () => {
    const x = field(3);
    x.finish(x.qtid);
    for (const id of ['QA', 'QB']) {
      const body = x.list(id).body;
      expect(body.commitments).toHaveLength(3);
      for (const c of body.commitments) {
        expect(Object.keys(c)).toEqual(['seed', 'hash', 'handNumber', 'revealedAt']);   // the stamp is never served
        expect(sha(c.seed)).toBe(c.hash);
        expect(x.one(id, c.handNumber).body).toMatchObject({ seed: c.seed, verified: true, computedHash: c.hash });
      }
    }
  });

  it('cancelled, pruned (gone from TournamentManager) and unknown after a restart: released', () => {
    const x = field(1);
    x.tm.getTournament(x.qtid)!.status = 'cancelled';
    expect(x.list('QA').body.commitments[0].seed).toEqual(expect.any(String));
    const y = field(1);
    const buf = y.m.revealedCommitmentsByTable.get('QA');
    buf[0] = { ...buf[0], holdForTournamentId: 'pruned-or-previous-process' };
    expect(y.list('QA').body.commitments[0]).toEqual({ seed: expect.any(String), hash: expect.any(String), handNumber: expect.any(Number), revealedAt: expect.any(Number) });
  });
});

describe('FS3 — a table BROKEN mid-event stays held until the qualifier ends (the stamp travels with the entry)', () => {
  it('QB leaves tournamentTables and the broken-table registry: still held; after the finish: released', () => {
    const x = field(2);
    x.tournamentTables.delete('QB');
    x.m.brokenTournamentTables.delete('QB');
    expect(x.m.fairnessSeedHoldOf('QB')).toBeNull();                         // a new hand there would not be stamped...
    expect(x.list('QB').body.commitments.every((c: any) => c.seed === null && c.seedHeld === true)).toBe(true);   // ...but its old ones stay held
    x.finish(x.qtid);
    expect(x.list('QB').body.commitments.every((c: any) => typeof c.seed === 'string' && sha(c.seed) === c.hash)).toBe(true);
  });
});

describe('FS4 — the stamp is persisted with the entry (Redis); a rehydrated entry of an unknown tournament is released', () => {
  it('appendFairnessCommitment gets holdForTournamentId for a qualifier hand only; a buffer restored from Redis for a tournament this process never knew serves its seeds', () => {
    const x = field(1);
    const of = (id: string) => x.appended.filter(([t]) => t === id).map(([, e]) => e);
    expect(of('QA')).toEqual([expect.objectContaining({ holdForTournamentId: x.qtid, seed: expect.any(String) })]);
    expect(of('QB')).toEqual([expect.objectContaining({ holdForTournamentId: x.qtid })]);
    for (const id of ['C1', 'SG']) expect(of(id).map((e) => Object.keys(e))).toEqual([['seed', 'hash', 'handNumber', 'revealedAt']]);
    // The boot rehydrate (index.ts) puts Redis entries straight into the buffer.
    const seed = 'f'.repeat(64);
    x.m.revealedCommitmentsByTable.set('OLD', [{ seed, hash: sha(seed), handNumber: 7, revealedAt: 1, holdForTournamentId: 'a-previous-process-tournament' }]);
    expect(x.list('OLD').body.commitments).toEqual([{ seed, hash: sha(seed), handNumber: 7, revealedAt: 1 }]);
    expect(x.one('OLD', 7).body).toMatchObject({ seed, verified: true });
  });
});

describe('FS5 — the pre-hand commitment frame says the seed will be held; the seed itself is never pushed to a room', () => {
  it('deckCommitment carries seedHeld:true only at a running qualifier table; no room ever gets deckSeedRevealed', () => {
    const x = field(1);
    const commits = (id: string) => x.room.filter(([r, ev]) => r === `table:${id}` && ev === 'deckCommitment').map(([, , d]) => d);
    expect(commits('QA')).toEqual([expect.objectContaining({ tableId: 'QA', hash: expect.any(String), seedHeld: true, committedAt: expect.any(Number) })]);
    expect(commits('QB')[0].seedHeld).toBe(true);
    for (const id of ['C1', 'SG']) {
      expect(commits(id)).toHaveLength(1);
      expect('seedHeld' in commits(id)[0]).toBe(false);
    }
    expect(x.room.filter(([, ev]) => ev === 'deckSeedRevealed')).toEqual([]);
    // After the end, a qualifier table (if it deals on) is no longer marked.
    x.finish(x.qtid);
    expect(x.m.seedHeldFieldsFor('QA')).toEqual({});
    expect(x.m.seedHeldFieldsFor('C1')).toEqual({});
  });
});

describe('FS6 — the lobby item says so (seedsHeldUntilEnd: capability flag the rules page reads)', () => {
  it('every qualifier item carries seedsHeldUntilEnd: true; nothing qualifierListItem reads is stubbed', () => {
    const tm = new TournamentManager();
    const qt: any = {
      qualifierId: 'Q1', masterQualifierId: 'Q1', qualifierType: 'weekly', qualifierName: 'Weekly Qualifier',
      scheduledAt: new Date(Date.now() + 2 * 3600_000).toISOString(), startingStack: QUALIFIER_BASE_STACK, players: [], status: 'registering',
      tournamentId: null, results: null, seatPackage: null,
    };
    const { exports: m, stubbed } = load(fnSrc('function qualifierListItem('), {
      tournamentManager: tm, qualifierWindows, qualifierStatusOf, seatsForTopWith, qualifierStructure, QUALIFIER_BASE_STACK,
      QUALIFIER_MAX_REENTRIES, qualifierReEntriesLeft, qualifiedPlayers: new Map(),
    }, '{ qualifierListItem }');
    expect(m.qualifierListItem('Q1', qt, Date.now(), null)).toMatchObject({ seedsHeldUntilEnd: true, lateRegClosesAtBubble: true });
    expect([...stubbed]).toEqual([]);
  });

  it('wiring: health key, manifest tokens, the routes go through publicFairnessEntry', () => {
    expect(SRC).toContain('fairnessHold: { ...fairnessSeedHoldStats, ...fairnessEventBufferStats },');
    expect(slice("app.get('/api/fairness/:tableId', (req, res) => {", '\n});\n')).toContain('commitments: buf.map(publicFairnessEntry)');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['seedsHeldUntilEnd', 'seedHeld']) expect(manifest).toContain(tok);
  });
});

// ═══════════════════════ review fix-up — EVERY hand of the event stays verifiable ══
/**
 * A held seed sat in the same 50-entry ring as every other seed, so a qualifier
 * table (4-6 hours, ~300 hands) lost every hand older than its last 50 before the
 * qualifier ended and its seeds were released: the list route left them out and
 * the single route said 404 — "After the qualifier ends, each hand's shuffle code
 * can be checked" was false. Now a qualifier's hands (stamped holdForTournamentId)
 * are exempt from the ring (7 days, up to 2000 per table) in memory, in Redis
 * (LTRIM keep / LRANGE) and in the boot rehydrate. Every other table: the newest
 * 50, exactly as before.
 */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const ttl = new Map<string, number>();
  const trims: Array<[string, number, number]> = [];
  const handlers: Record<string, (...a: any[]) => void> = {};
  const client: any = {
    on: (ev: string, fn: (...a: any[]) => void) => { handlers[ev] = fn; return client; },
    connect: async () => { if (handlers.ready) handlers.ready(); },
    multi: () => {
      const ops: Array<() => void> = [];
      const m: any = {
        lPush: (k: string, v: string) => { ops.push(() => { lists.set(k, [v, ...(lists.get(k) || [])]); }); return m; },
        lTrim: (k: string, a: number, b: number) => { trims.push([k, a, b]); ops.push(() => { lists.set(k, (lists.get(k) || []).slice(a, b + 1)); }); return m; },
        expire: (k: string, sec: number) => { ops.push(() => { ttl.set(k, sec); }); return m; },
        exec: async () => { for (const op of ops) op(); return []; },
      };
      return m;
    },
    lRange: async (k: string, a: number, b: number) => (lists.get(k) || []).slice(a, b + 1),
    scanIterator: async function* scan(opts: { MATCH: string }) {
      const pre = opts.MATCH.replace(/\*$/, '');
      for (const k of [...lists.keys()]) if (k.startsWith(pre)) yield k;
    },
  };
  return { client, lists, ttl, trims };
}
/** The REAL redisStore on a fake Redis client (REDIS_URL set only while it connects). */
async function realRedisStore() {
  const fake = fakeRedis();
  let rs: any;
  jest.isolateModules(() => {
    jest.doMock('redis', () => ({ createClient: () => fake.client }));
    rs = require('../src/redisStore');
  });
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://fake-for-test';
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});   // '[redisStore] ready'
  try {
    expect(await rs.connectRedis()).toBe(true);
  } finally {
    quiet.mockRestore();
    if (prev === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = prev;
  }
  expect(rs.isRedisReady()).toBe(true);
  return { rs, fake };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('FS7 — a qualifier table plays 80 hands while it runs: after it ends EVERY one of the 80 is listed and verifies (51ddfd8: only the last 50 — hands 1-30 never verifiable); a cash table keeps its newest 50 as before', () => {
  it('in memory: the list route serves 80 seeds, the single route verifies each (hand 1 included); the cash table 50; Redis is asked to keep the max for the qualifier table, 50 for cash', () => {
    const w = world();
    const qtid = w.startTournament(3);
    w.qualifierTournaments.set('Q-weekly', { tournamentId: qtid, status: 'running', qualifierType: 'weekly', players: [] });
    const QA = w.table('QA', qtid);
    const C1 = w.table('C1');
    for (let i = 0; i < 80; i++) { w.playHand(QA); w.playHand(C1); }
    // While it runs: 80 held entries, no seed served.
    const held = w.list('QA').body.commitments;
    expect(held).toHaveLength(80);
    expect(held.every((c: any) => c.seed === null && c.seedHeld === true)).toBe(true);
    const handsQA = held.map((c: any) => c.handNumber);
    w.finish(qtid);
    const after = w.list('QA').body.commitments;
    expect(after.map((c: any) => c.handNumber)).toEqual(handsQA);   // nothing lost, newest-first
    for (const c of after) {
      expect(sha(c.seed)).toBe(c.hash);
      expect(w.one('QA', c.handNumber).body).toMatchObject({ verified: true, seed: c.seed });
    }
    expect(w.one('QA', Math.min(...handsQA)).status).toBe(200);     // the FIRST hand of the event
    // The cash table: the newest 50, exactly as before (key order included).
    const cash = w.list('C1').body.commitments;
    expect(cash).toHaveLength(50);
    expect(cash.every((c: any) => Object.keys(c).join() === 'seed,hash,handNumber,revealedAt')).toBe(true);
    expect(w.one('C1', Math.min(...cash.map((c: any) => c.handNumber)) - 1).status).toBe(404);
    // Redis LTRIM keep: the max for the qualifier table (a superset), 50 for cash.
    const keeps = (id: string) => [...new Set(w.appended.filter(([t]) => t === id).map(([, , k]) => k))];
    expect(keeps('QA')).toEqual([2000]);
    expect(keeps('C1')).toEqual([50]);
    expect(w.m.fairnessEventBufferStats).toEqual({ eventEntriesDroppedAtMax: 0 });
  });

  it('the trim rule: newest 50 + every qualifier hand of the last 7 days, up to 2000 per table; unstamped entries past 50 dropped; a 7-day-old qualifier hand past 50 dropped', () => {
    const w = world();
    const now = Date.now();
    const e = (n: number, stamp: boolean, ageMs = 0) => ({ handNumber: n, seed: `s${n}`, hash: `h${n}`, revealedAt: now - ageMs, ...(stamp ? { holdForTournamentId: 'T' } : {}) });
    // 60 unstamped (newest), then 40 stamped, then 5 stamped older than 7 days.
    const buf = [
      ...Array.from({ length: 60 }, (_, i) => e(200 - i, false)),
      ...Array.from({ length: 40 }, (_, i) => e(100 - i, true, 3600_000)),
      ...Array.from({ length: 5 }, (_, i) => e(50 - i, true, 8 * 24 * 3600_000)),
    ];
    const out = w.m.trimFairnessBuffer(buf, now);
    expect(out.slice(0, 50).map((x: any) => x.handNumber)).toEqual(buf.slice(0, 50).map((x) => x.handNumber));
    expect(out.slice(50).map((x: any) => x.handNumber)).toEqual(Array.from({ length: 40 }, (_, i) => 100 - i));
    expect(out).toHaveLength(90);
    // 50 or fewer: the same array, untouched.
    const small = buf.slice(0, 50);
    expect(w.m.trimFairnessBuffer(small, now)).toBe(small);
    // The per-table max.
    const huge = Array.from({ length: 2100 }, (_, i) => e(5000 - i, true));
    expect(w.m.trimFairnessBuffer(huge, now)).toHaveLength(2000);
    expect(w.m.fairnessEventBufferStats.eventEntriesDroppedAtMax).toBe(100);
    expect(w.m.fairnessRedisKeepFor([e(1, false)])).toBe(50);
    expect(w.m.fairnessRedisKeepFor([e(2, false), e(1, true)])).toBe(2000);
  });
});

describe('FS8 — through the REAL redisStore (fake client) and a restart: the qualifier table keeps all 80 hands through LTRIM, the boot scan and the rehydrate, and all verify (51ddfd8: LTRIM 0 49 + LRANGE 0 49 + slice 50)', () => {
  it('80 hands at a running qualifier table + 80 at a cash table: Redis keeps 80 / 50 (7-day TTL); a new process restores 80 / 50; every qualifier seed is served (its tournament is unknown after the restart) and verifies', async () => {
    const { rs, fake } = await realRedisStore();
    expect(rs.FAIRNESS_LIST_MAX).toBe(2000);
    expect(SRC).toContain('const FAIRNESS_EVENT_BUFFER_MAX = 2000;');   // the two caps agree
    const w = world({ appendFairnessCommitment: rs.appendFairnessCommitment });
    const qtid = w.startTournament(3);
    w.qualifierTournaments.set('Q-weekly', { tournamentId: qtid, status: 'running', qualifierType: 'weekly', players: [] });
    const QA = w.table('QA', qtid);
    const C1 = w.table('C1');
    for (let i = 0; i < 80; i++) { w.playHand(QA); w.playHand(C1); await settle(); }
    await settle();
    expect(fake.lists.get('poker:fairness:QA')).toHaveLength(80);
    expect(fake.lists.get('poker:fairness:C1')).toHaveLength(50);
    expect(fake.ttl.get('poker:fairness:QA')).toBe(7 * 24 * 3600);
    expect(new Set(fake.trims.filter(([k]) => k === 'poker:fairness:C1').map(([, , b]) => b))).toEqual(new Set([49]));
    // A restart: a NEW process (its TournamentManager never knew the qualifier) rehydrates from Redis.
    const scanned = await rs.scanFairnessBuffers();
    expect(scanned.map((x: any) => [x.tableId, x.entries.length]).sort()).toEqual([['C1', 50], ['QA', 80]]);
    const y = world();
    let restored = 0;
    for (const { tableId, entries } of scanned) restored += y.m.restoreFairnessBuffer(tableId, entries);
    expect(restored).toBe(130);
    const qa = y.list('QA').body.commitments;
    expect(qa).toHaveLength(80);
    for (const c of qa) {
      expect('holdForTournamentId' in c).toBe(false);   // the stamp is never served
      expect(sha(c.seed)).toBe(c.hash);
      expect(y.one('QA', c.handNumber).body).toMatchObject({ verified: true });
    }
    expect(y.list('C1').body.commitments).toHaveLength(50);
  });

  it('wiring: the boot rehydrate restores through restoreFairnessBuffer (no 50-slice left); record passes the Redis keep', () => {
    const boot = slice('const fairnessBuffers = await scanFairnessBuffers();', "console.warn('[Rehydrate] fairness scan failed:'");
    expect(boot).toContain('totalEntries += restoreFairnessBuffer(tableId, entries);');
    expect(boot).not.toContain('entries.slice(0, FAIRNESS_BUFFER_SIZE)');
    expect(fnSrc('function recordRevealedCommitment(')).toContain('appendFairnessCommitment(tableId, rc, fairnessRedisKeepFor(buf))');
    expect(SRC).not.toContain('if (buf.length > FAIRNESS_BUFFER_SIZE) buf.length = FAIRNESS_BUFFER_SIZE;');
  });
});

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

function world() {
  const tm = new TournamentManager();
  const tournamentTables = new Map<string, string>();
  const qualifierTournaments = new Map<string, any>();
  const routes = new Map<string, (req: any, res: any) => void>();
  const room: Array<[string, string, any]> = [];
  const appended: Array<[string, any]> = [];
  const tables = new Map<string, PokerTable>();
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, SEAT_RESERVE_MS: 6 * 3600_000,
    app: { get: (p: string, fn: (req: any, res: any) => void) => { routes.set(p, fn); } },
    io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) },
    appendFairnessCommitment: async (tid: string, e: any) => { appended.push([tid, e]); },
    console: { log() {}, warn() {}, error() {} },
  };
  const { exports: m, stubbed } = load(CODE, scope, `{
    recordRevealedCommitment, revealedCommitmentsByTable, wireFairness, brokenTournamentTables,
    fairnessSeedHoldOf, fairnessSeedIsHeld, publicFairnessEntry, seedHeldFieldsFor, fairnessSeedHoldStats,
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
    expect(SRC).toContain('fairnessHold: { ...fairnessSeedHoldStats },');
    expect(slice("app.get('/api/fairness/:tableId', (req, res) => {", '\n});\n')).toContain('commitments: buf.map(publicFairnessEntry)');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '..', 'canonical-features.txt'), 'utf8');
    for (const tok of ['seedsHeldUntilEnd', 'seedHeld']) expect(manifest).toContain(tok);
  });
});

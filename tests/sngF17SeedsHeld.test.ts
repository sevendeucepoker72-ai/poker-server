/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F17) — the
 * fairness SEEDS of EVERY running tournament (Sit & Go, custom, club,
 * scheduled — not only qualifiers) are held until it finishes, and each of
 * its hands is kept server-side for the advertised 7 days.
 * The audit: /api/fairness served a Sit & Go hand's seed as soon as the hand
 * ended — the seed rebuilds every folded hand of the opponents still playing;
 * and the 50-hand ring could drop a long event's hands before anyone checked.
 *  - fairnessSeedHoldOf: any running tournament's table (live or just broken).
 *  - Its entries are stamped, so they are exempt from the 50-hand ring (kept 7
 *    days, up to 2000 per table; Redis keep 2000), and served with seed:null +
 *    seedHeld:true while it runs; every seed verifies once it ends.
 *  - deckCommitment carries seedHeld:true there. Cash tables unchanged.
 *  - Qualifiers: unchanged (they were already held).
 *  - The seed never reaches a player (no 'deckSeedRevealed' to a room; no seed
 *    in the hand-history record).
 */
import { createHash } from 'crypto';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { slice, fnSrc, load } from './helpers/indexSource';

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
  const appended: Array<[string, any, number | undefined]> = [];
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, SEAT_RESERVE_MS: 6 * 3600_000,
    app: { get: (p: string, fn: (req: any, res: any) => void) => { routes.set(p, fn); } },
    io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) },
    appendFairnessCommitment: async (tid: string, e: any, keep?: number) => { appended.push([tid, e, keep]); },
    console: { log() {}, warn() {}, error() {} },
  };
  const { exports: m } = load(CODE, scope, '{ revealedCommitmentsByTable, wireFairness, fairnessSeedHoldOf, seedHeldFieldsFor }');
  const start = (name: string, n = 2) => {
    const tid = tm.createTournament({ name, buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 720 }], startingChips: 50_000 } as any);
    for (let i = 0; i < n; i++) tm.registerPlayer(tid, `${tid}-p${i}`, `P${i}`, `s${i}`, 100 + i);
    expect(tm.startTournament(tid)).toBeTruthy();
    const t = tm.getTournament(tid)!;
    if (t.blindTimer) clearTimeout(t.blindTimer);
    return tid;
  };
  const table = (id: string, tournamentId?: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 1_000_000, maxPlayers: 9 } as any);
    t.sitDown(0, 'A', 500_000, `${id}-a`, false);
    t.sitDown(1, 'B', 500_000, `${id}-b`, false);
    if (tournamentId) tournamentTables.set(id, tournamentId);
    m.wireFairness(t, id);
    return t;
  };
  const play = (t: PokerTable, hands: number) => {
    for (let h = 0; h < hands; h++) {
      expect(t.startNewHand()).toBe(true);
      while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
      expect(t.currentPhase).toBe(GamePhase.HandComplete);
    }
  };
  const get = (path: string, params: Record<string, string>) => {
    const out: { status: number; body: any } = { status: 200, body: null };
    const res = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = JSON.parse(JSON.stringify(b)); return res; } };
    routes.get(path)!({ params }, res);
    return out;
  };
  const list = (id: string) => get('/api/fairness/:tableId', { tableId: id }).body.commitments as any[];
  const one = (id: string, hand: number) => get('/api/fairness/:tableId/:handNumber', { tableId: id, handNumber: String(hand) });
  const finish = (tid: string) => {
    const t = tm.getTournament(tid)!;
    for (const p of [...t.players].slice(1)) tm.eliminatePlayer(tid, p.playerId);
    expect(t.status).toBe('finished');
  };
  return { tm, m, room, appended, start, table, play, list, one, finish, qualifierTournaments };
}

describe('F17 — every running tournament\'s seeds are held until it ends', () => {
  it('a running Sit & Go table: hash served, seed:null + seedHeld:true (e038f7b: the seed of every finished hand); after the finish: every seed served and verified', () => {
    const w = world();
    const sng = w.start('Sit & Go');
    const SG = w.table('SG', sng);
    w.play(SG, 3);
    for (const c of w.list('SG')) expect(c).toEqual({ handNumber: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/), revealedAt: expect.any(Number), seed: null, seedHeld: true });
    expect(w.one('SG', 1).body).toMatchObject({ seed: null, seedHeld: true });
    w.finish(sng);
    for (const c of w.list('SG')) {
      expect(Object.keys(c)).toEqual(['seed', 'hash', 'handNumber', 'revealedAt']);
      expect(sha(c.seed)).toBe(c.hash);
      expect(w.one('SG', c.handNumber).body).toMatchObject({ verified: true });
    }
  });

  it('a custom (non-template) tournament is held too; a CASH table is unchanged (served at once, no stamp)', () => {
    const w = world();
    const cup = w.start('Friday Cup');
    const CT = w.table('CT', cup);
    const C1 = w.table('C1');
    w.play(CT, 1);
    w.play(C1, 1);
    expect(w.list('CT')[0]).toMatchObject({ seed: null, seedHeld: true });
    expect(Object.keys(w.list('C1')[0])).toEqual(['seed', 'hash', 'handNumber', 'revealedAt']);
    expect(w.appended.filter(([t]) => t === 'C1').map(([, e]) => 'holdForTournamentId' in e)).toEqual([false]);
    expect(w.appended.filter(([t]) => t === 'CT').map(([, e]) => e.holdForTournamentId)).toEqual([cup]);
  });

  it('every hand of the event is KEPT (exempt from the 50-hand ring: 80 hands, all verifiable after the end); Redis keeps 2000 for that table', () => {
    const w = world();
    const sng = w.start('Sit & Go');
    const SG = w.table('SG', sng);
    w.play(SG, 80);
    expect(w.m.revealedCommitmentsByTable.get('SG')).toHaveLength(80);           // e038f7b: the newest 50
    expect(w.appended[w.appended.length - 1][2]).toBe(2000);
    w.finish(sng);
    expect(w.one('SG', 1).body).toMatchObject({ verified: true });
    // A cash table still keeps the newest 50.
    const C1 = w.table('C1');
    w.play(C1, 60);
    expect(w.m.revealedCommitmentsByTable.get('C1')).toHaveLength(50);
  });

  it('the pre-hand deckCommitment says seedHeld at a running Sit & Go table; the seed never reaches a room', () => {
    const w = world();
    const sng = w.start('Sit & Go');
    const SG = w.table('SG', sng);
    w.play(SG, 1);
    const commits = w.room.filter(([r, ev]) => r === 'table:SG' && ev === 'deckCommitment').map(([, , d]) => d);
    expect(commits[0].seedHeld).toBe(true);
    expect(w.room.filter(([, ev]) => ev === 'deckSeedRevealed')).toEqual([]);
    w.finish(sng);
    expect(w.m.seedHeldFieldsFor('SG')).toEqual({});
  });

  it('qualifiers are unchanged: still held while running', () => {
    const w = world();
    const q = w.start('Qualifier Tournament', 3);
    w.qualifierTournaments.set('Q-weekly', { tournamentId: q, status: 'running', qualifierType: 'weekly', players: [] });
    const QA = w.table('QA', q);
    w.play(QA, 2);
    expect(w.list('QA').every((c) => c.seed === null && c.seedHeld === true)).toBe(true);
    expect(w.m.fairnessSeedHoldOf('QA')).toBe(q);
  });

  it('the lobby item of every tournament says so: seedsHeldUntilEnd (capability flag)', () => {
    const items = new TournamentManager().getTournamentList() as any[];
    expect(items.length).toBeGreaterThan(3);
    for (const it of items) expect(it.seedsHeldUntilEnd).toBe(true);
  });
});

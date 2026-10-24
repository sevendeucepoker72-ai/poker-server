/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F17, review fix-up)
 *  (1) a running SPIN & GO's seeds are held too. F17 says "the seeds of EVERY
 *      running tournament", and F5 counts a Spin & Go as one; but
 *      fairnessSeedHoldOf found the event only through tournamentIdOfTable,
 *      and a Spin & Go table is a prize-format quick table (spinGoMultipliers +
 *      quickGames), never in tournamentTables: each hand's seed was served the
 *      moment it ended, rebuilding the bots' folded hands mid-game. Now its
 *      hands are stamped `spingo:<tableId>` and held while that game runs
 *      (quickGames entry, format spinGo, not ended); released when it ends or
 *      the table is gone (also after a restart).
 *  (2) the held entry says WHICH kind of event holds it: `seedHeldFor:
 *      'tournament'` (additive) on the /api/fairness entries and the
 *      deckCommitment frame of a NON-qualifier hold, so poker-3d (K10) reads
 *      "Seed shown after the tournament ends"; a QUALIFIER's held entries and
 *      frames are byte-identical (no key: the client keeps the qualifier line).
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
  const quickGames = new Map<string, any>();
  const spinGoMultipliers = new Map<string, number>();
  const routes = new Map<string, (req: any, res: any) => void>();
  const room: Array<[string, string, any]> = [];
  const appended: Array<[string, any, number | undefined]> = [];
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tournamentTables, qualifierTournaments, quickGames, spinGoMultipliers, SEAT_RESERVE_MS: 6 * 3600_000,
    app: { get: (p: string, fn: (req: any, res: any) => void) => { routes.set(p, fn); } },
    io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) },
    appendFairnessCommitment: async (tid: string, e: any, keep?: number) => { appended.push([tid, e, keep]); },
    console: { log() {}, warn() {}, error() {} },
  };
  const { exports: m, stubbed } = load(CODE, scope, '{ revealedCommitmentsByTable, wireFairness, fairnessSeedHoldOf, seedHeldFieldsFor }');
  const start = (name: string, n = 2) => {
    const tid = tm.createTournament({ name, buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 720 }], startingChips: 50_000 } as any);
    for (let i = 0; i < n; i++) tm.registerPlayer(tid, `${tid}-p${i}`, `P${i}`, `s${i}`, 100 + i);
    expect(tm.startTournament(tid)).toBeTruthy();
    const t = tm.getTournament(tid)!;
    if (t.blindTimer) clearTimeout(t.blindTimer);
    return tid;
  };
  const table = (id: string, opts: { tournamentId?: string; spinGo?: boolean } = {}) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, minBuyIn: 100, maxBuyIn: 1_000_000, maxPlayers: 3 } as any);
    t.sitDown(0, 'Hero', 500, `${id}-hero`, false);
    t.sitDown(1, 'Bot1', 500, `ai-${id}-1`, true);
    t.sitDown(2, 'Bot2', 500, `ai-${id}-2`, true);
    if (opts.tournamentId) tournamentTables.set(id, opts.tournamentId);
    if (opts.spinGo) {
      // What quickSpinGo does: the multiplier, then registerQuickGame (format spinGo, not ended).
      spinGoMultipliers.set(id, 3);
      quickGames.set(id, { format: 'spinGo', ended: false, settlement: 'open', started: true, multiplier: 3 });
    }
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
  return { tm, m, stubbed, room, appended, start, table, play, list, one, qualifierTournaments, quickGames, spinGoMultipliers };
}

describe('F17 review fix-up — a running Spin & Go\'s seeds are held', () => {
  it('while the Spin & Go runs: hash served, seed:null + seedHeld:true + seedHeldFor:tournament (0e71b42: every seed at once); once it ended: every seed verifies', () => {
    const w = world();
    const SP = w.table('SP', { spinGo: true });
    w.play(SP, 3);
    for (const c of w.list('SP')) expect(c).toEqual({ handNumber: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/), revealedAt: expect.any(Number), seed: null, seedHeld: true, seedHeldFor: 'tournament' });
    expect(w.one('SP', 2).body).toMatchObject({ seed: null, seedHeld: true, seedHeldFor: 'tournament' });
    expect(w.appended.filter(([t]) => t === 'SP').map(([, e]) => e.holdForTournamentId)).toEqual(['spingo:SP', 'spingo:SP', 'spingo:SP']);
    const commits = w.room.filter(([r, ev]) => r === 'table:SP' && ev === 'deckCommitment').map(([, , d]) => d);
    expect(commits.map((d) => [d.seedHeld, d.seedHeldFor])).toEqual([[true, 'tournament'], [true, 'tournament'], [true, 'tournament']]);
    // The game ends (one player left): released.
    w.quickGames.get('SP').ended = true;
    for (const c of w.list('SP')) {
      expect(Object.keys(c)).toEqual(['seed', 'hash', 'handNumber', 'revealedAt']);
      expect(sha(c.seed)).toBe(c.hash);
      expect(w.one('SP', c.handNumber).body).toMatchObject({ verified: true });
    }
    expect(w.m.seedHeldFieldsFor('SP')).toEqual({});
  });

  it('the table removed (cleanupQuickGame) or a restart (no quickGames entry): released', () => {
    const w = world();
    const SP = w.table('SP', { spinGo: true });
    w.play(SP, 1);
    expect(w.list('SP')[0].seedHeld).toBe(true);
    w.quickGames.delete('SP');
    w.spinGoMultipliers.delete('SP');
    expect(w.list('SP')[0].seedHeld).toBeUndefined();
    expect(w.one('SP', 1).body).toMatchObject({ verified: true });
  });

  it('a heads-up / AoF quick table (not a Spin & Go) and a cash table are unchanged', () => {
    const w = world();
    const HU = w.table('HU');
    w.quickGames.set('HU', { format: 'headsUp', ended: false });
    w.play(HU, 1);
    expect(Object.keys(w.list('HU')[0])).toEqual(['seed', 'hash', 'handNumber', 'revealedAt']);
    expect(w.appended.filter(([t]) => t === 'HU').map(([, e]) => 'holdForTournamentId' in e)).toEqual([false]);
  });
});

describe('F17 review fix-up — the held entry names its kind (seedHeldFor), qualifiers byte-identical', () => {
  it('a running Sit & Go: seedHeldFor "tournament" on the list, the single route and the deckCommitment frame', () => {
    const w = world();
    const sng = w.start('Sit & Go');
    const SG = w.table('SG', { tournamentId: sng });
    w.play(SG, 2);
    for (const c of w.list('SG')) expect(c.seedHeldFor).toBe('tournament');   // 0e71b42: absent (K10 read the qualifier line)
    expect(w.one('SG', 1).body.seedHeldFor).toBe('tournament');
    const commits = w.room.filter(([r, ev]) => r === 'table:SG' && ev === 'deckCommitment').map(([, , d]) => d);
    expect(commits.every((d) => d.seedHeld === true && d.seedHeldFor === 'tournament')).toBe(true);
    expect(w.m.seedHeldFieldsFor('SG')).toEqual({ seedHeld: true, seedHeldFor: 'tournament' });
  });

  it('a running QUALIFIER: exactly as before (seed:null, seedHeld:true, NO seedHeldFor key anywhere)', () => {
    const w = world();
    const q = w.start('Qualifier Tournament', 3);
    w.qualifierTournaments.set('Q-weekly', { tournamentId: q, status: 'running', qualifierType: 'weekly', players: [] });
    const QA = w.table('QA', { tournamentId: q });
    w.play(QA, 2);
    for (const c of w.list('QA')) expect(c).toEqual({ handNumber: expect.any(Number), hash: expect.any(String), revealedAt: expect.any(Number), seed: null, seedHeld: true });
    expect(w.one('QA', 1).body).toEqual({ tableId: 'QA', handNumber: 1, hash: expect.any(String), revealedAt: expect.any(Number), seed: null, seedHeld: true });
    const commits = w.room.filter(([r, ev]) => r === 'table:QA' && ev === 'deckCommitment').map(([, , d]) => d);
    expect(commits.every((d) => d.seedHeld === true && !('seedHeldFor' in d))).toBe(true);
    expect(w.m.seedHeldFieldsFor('QA')).toEqual({ seedHeld: true });
    expect(w.m.fairnessSeedHoldOf('QA')).toBe(q);
  });
});

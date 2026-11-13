/**
 * tests/sdLiveGolden.test.ts (2026-11-12, bots review: the Short Deck reset).
 *
 * Short Deck bots play EXACTLY as live 0dc1b96 did (SHORT_DECK_BOTS_PLAY_LIVE in src/ai/AIPlayer.ts): decideAction hands
 * a Short Deck table to the frozen copy of 0dc1b96's decision code in src/ai/live0dc1b96/. This suite pins that:
 *  - B10: the first Short Deck decision of a process builds no pre-flop table (no Math.random storm, no freeze);
 *  - the switch is on, it routes Short Deck tables only, and its test hook cannot be used outside Jest;
 *  - the frozen copy reads the one opponent-model store index.ts writes (recordOpponentObservation);
 *  - the frozen copy is byte-for-byte 0dc1b96's code apart from its import lines (and the shared-store line);
 *  - GOLDEN: 420 Short Deck decisions recorded from a git archive of 0dc1b96 (tests/fixtures/sdLiveGolden.json; every
 *    archetype x difficulty, 2-6 seats, 8-300 BB equal and unequal stacks, pre-flop / flop / turn / river, with
 *    opponent reads) are reproduced by the production entry (AIPlayer.decideAction): action, raise size and the number
 *    of Math.random draws. The fixture's 0dc1b96 tree read a3ac266's baked pre-flop table (preflopTable.ts), the one
 *    allowed difference (B10).
 * Each record is self-contained: a fresh ShortDeckTable (seats, stacks, button, the deck seed of the deal), the
 * opponent observations to feed, the concrete engine actions before the decision, the deciding profile and the
 * Math.random seed of the decision. Date.now is frozen, so every Monte Carlo runs its full count.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as nodeCrypto from 'crypto';
import { PokerTable, PlayerAction } from '../src/game/PokerTable';
import { CardDeck } from '../src/game/CardDeck';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { PineappleTable } from '../src/game/variants/PineappleTable';
import * as AI from '../src/ai/AIPlayer';
import * as LIVE from '../src/ai/live0dc1b96/AIPlayer';
import { OPPONENT_PROFILE_STORE } from '../src/ai/opponentProfileStore';

const BB = 100;
const cfg = (id: string) => ({ tableId: id, tableName: id, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: BB } as any);
const prof = (archetype: string, difficulty = 'hard') =>
  ({ botName: 'G', difficulty, personality: 'x', archetype, vpip: 0.3, pfr: 0.2, aggressionFactor: 2.5, bluffFrequency: 0.15 } as any);

let draws = 0;
/** Seeded Math.random (counting draws), frozen Date.now, and a deck whose commitment seed is `deck` (ShortDeckTable shuffles its 36 cards from it). */
function withDet<T>(seed: number, deck: string, fn: () => T): T {
  const r = Math.random, now = Date.now, shuffle = CardDeck.prototype.shuffle;
  let s = seed >>> 0;
  Math.random = () => { draws++; return ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); };
  Date.now = () => 1_800_000_000_000;
  (CardDeck.prototype as any).shuffle = function (handNumber = 0) {
    (this as any).currentIndex = 0;
    (this as any)._commitment = { seed: deck, hash: nodeCrypto.createHash('sha256').update(deck).digest('hex'), handNumber };
    return (this as any)._commitment;
  };
  try { return fn(); } finally { Math.random = r; Date.now = now; CardDeck.prototype.shuffle = shuffle; }
}

describe('B10 — the first Short Deck decision of the process (this file runs it first)', () => {
  it('reads the baked pre-flop table: a handful of Math.random draws, no lazy Monte Carlo build', () => {
    const d = withDet(7, 'b10-deck', () => {
      const t = new ShortDeckTable(cfg('b10'));
      for (let i = 0; i < 6; i++) expect(t.sitDown(i, 'P' + i, 100 * BB, `ai-b10-${i}`, true)).toBe(true);
      expect(t.startNewHand()).toBe(true);
      draws = 0;
      const t0 = process.hrtime.bigint();
      const dec = AI.decideAction(t, t.activeSeatIndex, prof('TAG'));
      return { dec, draws, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    });
    // 0dc1b96 built its table here: 169 hands x 600 runs, ~710,000 draws and a 7-13 s whole-server freeze.
    expect(d.draws).toBeLessThanOrEqual(5);
    expect(d.ms).toBeLessThan(1000);
  });
});

describe('the switch (SHORT_DECK_BOTS_PLAY_LIVE)', () => {
  it('is on in production and routes Short Deck tables only', () => {
    expect(AI.SHORT_DECK_BOTS_PLAY_LIVE).toBe(true);
    expect(AI.shortDeckBotsPlayLive(new ShortDeckTable(cfg('s1')))).toBe(true);
    expect(AI.isShortDeckBotTable(new ShortDeckTable(cfg('s2')))).toBe(true);
    expect(AI.shortDeckBotsPlayLive(new PokerTable(cfg('h1')))).toBe(false);
    expect(AI.shortDeckBotsPlayLive(new OmahaTable(cfg('o1'), false, 4))).toBe(false);
    expect(AI.shortDeckBotsPlayLive(new OmahaTable(cfg('o2'), true, 4))).toBe(false);
    expect(AI.shortDeckBotsPlayLive(new PineappleTable(cfg('p1'), false))).toBe(false);
    expect(AI.shortDeckBotsPlayLive(new PineappleTable(cfg('p2'), true))).toBe(false);
  });

  it('its test hook (the dormant lane code) works only under Jest and is off by default', () => {
    const t = new ShortDeckTable(cfg('s3'));
    expect(AI.shortDeckBotsPlayLive(t)).toBe(true);
    AI.setShortDeckLaneForTests(true);
    try { expect(AI.shortDeckBotsPlayLive(t)).toBe(false); } finally { AI.setShortDeckLaneForTests(false); }
    expect(AI.shortDeckBotsPlayLive(t)).toBe(true);
    const saved = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    try { expect(() => AI.setShortDeckLaneForTests(true)).toThrow(/Jest-only/); } finally { process.env.JEST_WORKER_ID = saved; }
    expect(AI.shortDeckBotsPlayLive(t)).toBe(true);
  });
});

describe('the frozen copy reads the one opponent-model store index.ts writes', () => {
  it('recordOpponentObservation (index.ts\'s writer) is what the frozen 0dc1b96 code categorises', () => {
    const k = 'store-test-key';
    for (let h = 1; h <= 20; h++) AI.recordOpponentObservation(k, 'hand_start', { handNumber: h });
    for (let i = 0; i < 12; i++) AI.recordOpponentObservation(k, 'vpip');
    for (let i = 0; i < 9; i++) AI.recordOpponentObservation(k, 'pfr');
    expect(AI.categorizeOpponent(k)).toBe('maniac');
    expect(LIVE.categorizeOpponent(k)).toBe('maniac');
    expect(LIVE.getOpponentProfile(k)).toBe(AI.getOpponentProfile(k));
    expect(OPPONENT_PROFILE_STORE.get(k)).toBe(AI.getOpponentProfile(k));
    expect(LIVE.opponentProfileCount()).toBe(AI.opponentProfileCount());
    expect(LIVE.OPPONENT_PROFILES_CAP).toBe(AI.OPPONENT_PROFILES_CAP);
  });
});

describe('the frozen copy is 0dc1b96\'s code', () => {
  // sha256 of `git show 0dc1b96:src/ai/AIPlayer.ts` / `:src/training/TrainingEngine.ts` with every import line
  // ('import ...' and '} from ...;') and the OPPONENT_PROFILES initializer removed. Never re-pin these to make an
  // edit pass: the copy is frozen; a changed Short Deck bot is a new reviewed change behind the switch.
  const FINGERPRINT: Record<string, string> = {
    'AIPlayer.ts': '99fe914ec77cea2753840fcbf84c6c1909b88da0159f290ca8707a63fcb9e68a',
    'TrainingEngine.ts': 'b586ae4b39ba0d0ea2b793459317cc4b4e13e846e6beb2d7e1230cea4f1af86b',
  };
  it.each(Object.keys(FINGERPRINT))('src/ai/live0dc1b96/%s differs from 0dc1b96 only in its import lines', (f) => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'live0dc1b96', f), 'utf8').replace(/\r\n/g, '\n');
    const norm = text.split('\n').filter((l) => !/^import /.test(l) && !/^\} from '/.test(l)
      && !/^const OPPONENT_PROFILES: Map<string, OpponentSessionProfile> = /.test(l)).join('\n');
    expect(nodeCrypto.createHash('sha256').update(norm).digest('hex')).toBe(FINGERPRINT[f]);
  });
});

interface GoldRec {
  i: string; ns: number; seats: number[]; btn: number; deck: string; obs: Array<[number, Array<[string, number]>]>;
  prefix: Array<[number, string, number]>; profile: any; phase: string; seat: number; rand: number;
  expect: { action: string; raiseAmount: number; draws: number }; hole: string; board: string;
}
const GOLD: { source: string; records: GoldRec[] } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sdLiveGolden.json'), 'utf8'));

function apply(t: PokerTable, s: number, k: string, amt: number): boolean {
  return k === 'fold' ? t.playerFold(s) : k === 'check' ? t.playerCheck(s) : k === 'call' ? t.playerCall(s) : k === 'raise' ? t.playerRaise(s, amt) : t.playerAllIn(s);
}
/** Rebuilds the record's spot (keys suffixed so a second replay starts from fresh opponent reads) and decides it. */
function replay(r: GoldRec, suffix: string): { action: string; raiseAmount: number; draws: number; hole: string; board: string } {
  return withDet(r.rand, r.deck, () => {
    const t = new ShortDeckTable(cfg('g' + r.i));
    r.seats.forEach((bbs, i) => expect(t.sitDown(i, 'S' + i, bbs * BB, `gold-${r.i}${suffix}-${i}`, i !== 0)).toBe(true));
    // the opponent reads, written as index.ts writes them
    for (const [i, obs] of r.obs) for (const [o, n] of obs) for (let k = 0; k < n; k++) {
      AI.recordOpponentObservation(`gold-${r.i}${suffix}-${i}`, o as any, o === 'hand_start' ? { handNumber: k + 1 } : undefined);
    }
    t.presetFirstButton(r.btn);
    expect(t.startNewHand()).toBe(true);
    for (const [s, k, amt] of r.prefix) expect([r.i, s, k, amt, apply(t, s, k, amt)]).toEqual([r.i, s, k, amt, true]);
    expect([r.i, t.activeSeatIndex, t.currentPhase]).toEqual([r.i, r.seat, r.phase]);
    draws = 0;
    const d = AI.decideAction(t, r.seat, r.profile);
    return {
      action: d.action, raiseAmount: d.raiseAmount, draws,
      hole: t.seats[r.seat].holeCards.map((c) => `${c.rank}.${c.suit}`).join(' '),
      board: t.communityCards.map((c) => `${c.rank}.${c.suit}`).join(' '),
    };
  });
}

describe('GOLDEN — Short Deck decisions recorded from 0dc1b96 are reproduced by AIPlayer.decideAction', () => {
  it('the fixture covers every archetype x difficulty, 2-6 seats, 8-300 BB, every street and every action', () => {
    const recs = GOLD.records;
    expect(recs.length).toBeGreaterThanOrEqual(400);
    const combos = new Set(recs.map((r) => `${r.profile.archetype}/${r.profile.difficulty}`));
    expect(combos.size).toBe(28);
    for (const ph of ['PreFlop', 'Flop', 'Turn', 'River']) expect([ph, recs.filter((r) => r.phase === ph).length >= 80]).toEqual([ph, true]);
    for (const n of [2, 3, 4, 5, 6]) expect([n, recs.some((r) => r.ns === n)]).toEqual([n, true]);
    for (const a of [PlayerAction.Fold, PlayerAction.Check, PlayerAction.Call, PlayerAction.Raise, PlayerAction.AllIn]) {
      expect([a, recs.filter((r) => r.expect.action === a).length >= 20]).toEqual([a, true]);
    }
    const depths = recs.flatMap((r) => r.seats);
    expect(Math.min(...depths)).toBe(8);
    expect(Math.max(...depths)).toBe(300);
    expect(recs.some((r) => new Set(r.seats).size > 1)).toBe(true);
    expect(recs.some((r) => r.obs.some(([, o]) => o.some(([k, n]) => k === 'hand_start' && n >= 10)))).toBe(true);
  });

  it('every record: same action, same raise size, same number of Math.random draws (and the same deal)', () => {
    const bad: string[] = [];
    for (const r of GOLD.records) {
      const got = replay(r, '');
      if (got.hole !== r.hole || got.board !== r.board) bad.push(`${r.i} deal ${got.hole} | ${got.board} vs ${r.hole} | ${r.board}`);
      const g = { action: got.action, raiseAmount: got.raiseAmount, draws: got.draws };
      if (JSON.stringify(g) !== JSON.stringify(r.expect)) bad.push(`${r.i} ${r.profile.archetype}/${r.profile.difficulty} ${r.phase}: ${JSON.stringify(g)} vs 0dc1b96 ${JSON.stringify(r.expect)}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('CONTROL — the dormant lane code (the test hook) decides some of these spots differently, so this pin has teeth', () => {
    AI.setShortDeckLaneForTests(true);
    let differ = 0;
    try {
      for (const r of GOLD.records.slice(0, 140)) {
        const got = replay(r, '-lane');
        if (got.action !== r.expect.action || got.raiseAmount !== r.expect.raiseAmount) differ++;
      }
    } finally { AI.setShortDeckLaneForTests(false); }
    expect(differ).toBeGreaterThanOrEqual(5);
  }, 300_000);
});

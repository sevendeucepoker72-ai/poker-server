/**
 * tests/sdLiveOpponentStore.test.ts (2026-11-12, Short Deck reset fix-up ID1-B11-SHARED-STORE).
 *
 * Short Deck bots play live 0dc1b96 (SHORT_DECK_BOTS_PLAY_LIVE): the frozen 0dc1b96 copy reads its opponents from the
 * ONE process-wide opponent store (src/ai/opponentProfileStore.ts) that index.ts writes. B11 (a Stud bot fix) made the
 * feed count Stud's first betting round, Third Street, as VPIP / PFR / facing-a-3-bet. Live 0dc1b96 counted PreFlop
 * only. When B11 wrote those Stud counts into the same fields, a human who played Stud / Razz and then Short Deck
 * read as a 'maniac' to the Short Deck bots where live read him as a 'nit', and they decided differently (re-review:
 * 2,641 differing bot decisions over 6 tables x 60 hands after 60 Stud hands).
 *
 * Now index.ts records Third Street under its own kinds ('vpip_3rd' ...) into its own fields (vpipHands3rd ...). The
 * frozen copy reads only the PreFlop fields; the current bots read PreFlop + Third Street (firstRoundCounts).
 *
 * This suite runs the REAL src/index.ts feed (ensureTableProgressListener's 'playerAction' listener, sliced and
 * transpiled) on a REAL SevenStudTable, then:
 *  - pins what the feed writes on Third Street: only 'hand_start' and the '*_3rd' kinds (0dc1b96 wrote 'hand_start'
 *    only there: ThirdStreet is neither its PreFlop nor its Flop branch);
 *  - pins that the fields the frozen copy reads equal the profile 0dc1b96's feed would have built (the same calls
 *    without the '*_3rd' ones), and that the current module still reads B11's counts;
 *  - decides Short Deck spots with that human in the hand through the production entry (AIPlayer.decideAction, which
 *    routes to the frozen copy): every decision (action, raise size, Math.random draws) equals the one made against
 *    the 0dc1b96-fed profile; CONTROL: against the 9c6c6a1 layout (Stud counts in the PreFlop fields) some differ;
 *  - decides Hold'em spots the same way: every decision against the real profile equals the one against a3ac266's
 *    layout (Stud counts in the PreFlop fields), so no non-Short-Deck decision changed; CONTROL: against the
 *    0dc1b96-fed profile some differ (B11 still reaches the current bots).
 * Seeded Math.random (draws counted), frozen Date.now during each decision (every Monte Carlo runs its full count),
 * seeded decks.
 */
import * as nodeCrypto from 'crypto';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { CardDeck } from '../src/game/CardDeck';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import * as AI from '../src/ai/AIPlayer';
import * as LIVE from '../src/ai/live0dc1b96/AIPlayer';
import { OPPONENT_PROFILE_STORE } from '../src/ai/opponentProfileStore';
import { fnSrc, load } from './helpers/indexSource';

const LISTENER = fnSrc('function ensureTableProgressListener(');
const quiet = { log() {}, warn() {}, error() {} };
const HUMAN = 'player-sdstore-mix';
const BB = 100;

type Call = [string, string, any];
/** Wire the REAL listener on `table` (keeping only its 'playerAction' feed); every recordOpponentObservation call is logged, then applied. */
function wire(table: PokerTable, tableId: string, calls: Call[]) {
  const scope: Record<string, unknown> = {
    tableProgressListeners: new Set<string>(), GamePhase, PlayerAction, opponentModelKey: AI.opponentModelKey,
    recordOpponentObservation: (k: string, o: any, x?: any) => { calls.push([k, o, x]); AI.recordOpponentObservation(k, o, x); },
    progressionManager: { recordAction() {}, recordPreflopRaiseContext() {} },
    console: quiet,
  };
  const { exports: ensure, stubbed } = load(LISTENER, scope, 'ensureTableProgressListener');
  const before = new Map(table.eventNames().map((ev) => [ev, table.listeners(ev).length]));
  ensure(table, tableId);
  for (const ev of table.eventNames()) {
    if (ev === 'playerAction') continue;
    const added = table.listeners(ev).slice(before.get(ev) ?? 0);
    for (const fn of added) table.off(ev as string, fn as (...a: any[]) => void);
  }
  return stubbed;
}

// ── determinism: seeded Math.random (draws counted) and seeded decks for the whole file ──
let st = 1, draws = 0, deckN = 0;
const realRandom = Math.random, realNow = Date.now, realShuffle = CardDeck.prototype.shuffle;
beforeAll(() => {
  Math.random = () => { draws++; return ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296); };
  (CardDeck.prototype as any).shuffle = function (handNumber = 0) {
    const seed = `sdstore-${deckN++}`;
    let s = nodeCrypto.createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
    const c = (this as any).cards; (this as any).currentIndex = 0;
    for (let i = c.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = Math.floor((s / 4294967296) * (i + 1)); const z = c[i]; c[i] = c[j]; c[j] = z; }
    (this as any)._commitment = { seed, hash: nodeCrypto.createHash('sha256').update(seed).digest('hex'), handNumber };
    return (this as any)._commitment;
  };
});
afterAll(() => { Math.random = realRandom; Date.now = realNow; CardDeck.prototype.shuffle = realShuffle; });

/**
 * Stud phase: HANDS hands of Seven Card Stud, the human at seat 0 completing Third Street at his first turn and, facing a
 * re-raise (seat 2 re-raises every completion), folding on even hands and calling on odd ones. The other seats call.
 */
const STUD_HANDS = 24;
let studCalls: Call[] = [];
let studStubbed: Set<string>;
function playStud(): void {
  const t = new SevenStudTable({ tableId: 'sdstore-stud', tableName: 'Stud', smallBlind: 25, bigBlind: 50, ante: 5, minBuyIn: 1 } as any, false, false);
  expect(t.sitDown(0, 'Hero', 50_000, HUMAN, false)).toBe(true);
  for (let i = 1; i < 4; i++) expect(t.sitDown(i, `B${i}`, 50_000, `ai-sdstore-stud-${i}`, true)).toBe(true);
  for (const k of [HUMAN, 'ai-sdstore-stud-1', 'ai-sdstore-stud-2', 'ai-sdstore-stud-3']) OPPONENT_PROFILE_STORE.delete(k);
  studCalls = [];
  studStubbed = wire(t, 'sdstore-stud', studCalls);
  for (let h = 0; h < STUD_HANDS; h++) {
    for (const s of t.seats) if (s.state === 'occupied') { s.chipCount = 50_000; s.eliminated = false; }
    expect(t.startNewHand()).toBe(true);
    let heroRaised = false, s2Raised = false, g = 0;
    while (t.isHandInProgress() && t.currentPhase === GamePhase.ThirdStreet && g++ < 40) {
      const a = t.activeSeatIndex;
      if (a < 0) break;
      if (a === 0) {
        if (!heroRaised && t.playerRaise(0, t.getMinRaise())) { heroRaised = true; continue; }
        if (heroRaised && h % 2 === 0 && t.playerFold(0)) continue;
        if (!t.playerCall(0)) t.playerCheck(0) || t.playerFold(0);
      } else if (a === 2 && heroRaised && !s2Raised && t.playerRaise(2, t.getMinRaise())) {
        s2Raised = true;
      } else if (!t.playerCall(a)) t.playerCheck(a) || t.playerFold(a);
    }
    while (t.isHandInProgress() && g++ < 300) { const a = t.activeSeatIndex; if (a < 0) break; if (!t.playerCheck(a)) t.playerFold(a); }
  }
}

const FIELDS_0DC1B96 = ['handsSeen', 'vpipHands', 'pfrHands', 'threeBetsFaced', 'threeBetFolds', 'cbetsFaced', 'cbetFolds',
  'showdownsReached', 'showdownsWonWithBluff', 'lastHandNumber'];
const pick = (p: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, p[k]]));
const THIRD: Record<string, string> = { vpip_3rd: 'vpip', pfr_3rd: 'pfr', face_3bet_3rd: 'face_3bet', fold_to_3bet_3rd: 'fold_to_3bet' };

/** Replays the logged feed of the human under `key`: 'live' = 0dc1b96's feed (no '*_3rd' call), 'b11' = 9c6c6a1 / a3ac266 (Stud counts in the PreFlop kinds). */
function replayAs(key: string, mode: 'live' | 'b11'): AI.OpponentSessionProfile {
  OPPONENT_PROFILE_STORE.delete(key);
  for (const [k, o, x] of studCalls) {
    if (k !== HUMAN) continue;
    if (THIRD[o]) { if (mode === 'b11') AI.recordOpponentObservation(key, THIRD[o] as any, x); continue; }
    AI.recordOpponentObservation(key, o as AI.OpponentObservation, x);
  }
  return AI.getOpponentProfile(key)!;
}

describe('the real index.ts feed on Stud Third Street, and the store fields each module reads', () => {
  beforeAll(() => { st = 11; playStud(); });

  it('Third Street writes only hand_start and the *_3rd kinds (0dc1b96 wrote hand_start only there)', () => {
    expect([...studStubbed].filter((n) => /recordOpponentObservation|opponentModelKey|progressionManager|GamePhase|PlayerAction/.test(n))).toEqual([]);
    const kinds = new Set(studCalls.map(([, o]) => o));
    for (const k of ['vpip', 'pfr', 'face_3bet', 'fold_to_3bet', 'face_cbet', 'fold_to_cbet']) expect([k, kinds.has(k)]).toEqual([k, false]);
    for (const k of ['hand_start', 'vpip_3rd', 'pfr_3rd', 'face_3bet_3rd', 'fold_to_3bet_3rd']) expect([k, kinds.has(k)]).toEqual([k, true]);
  });

  it('the frozen copy reads exactly the profile 0dc1b96\'s feed built ("nit"); the current bots still read B11 (not "nit")', () => {
    const real = AI.getOpponentProfile(HUMAN)!;
    expect(real.handsSeen).toBe(STUD_HANDS);
    expect(real.vpipHands3rd).toBeGreaterThanOrEqual(12);
    expect(real.pfrHands3rd).toBeGreaterThanOrEqual(12);
    expect(real.threeBetsFaced3rd).toBeGreaterThanOrEqual(6);
    expect(real.threeBetFolds3rd).toBeGreaterThanOrEqual(3);
    const live = replayAs('sdstore-live-0', 'live');
    expect(pick(real, FIELDS_0DC1B96)).toEqual(pick(live, FIELDS_0DC1B96));
    expect([real.vpipHands, real.pfrHands, real.threeBetsFaced, real.threeBetFolds]).toEqual([0, 0, 0, 0]);
    expect(LIVE.categorizeOpponent(HUMAN)).toBe('nit');
    expect(LIVE.categorizeOpponent(HUMAN)).toBe(LIVE.categorizeOpponent('sdstore-live-0'));
    // The current module: PreFlop + Third Street, the same counts a3ac266 held in the PreFlop fields.
    const b11 = replayAs('sdstore-b11-0', 'b11');
    expect(AI.firstRoundCounts(real)).toEqual(AI.firstRoundCounts(b11));
    expect(AI.firstRoundCounts(b11)).toEqual({ vpip: b11.vpipHands, pfr: b11.pfrHands, threeBetsFaced: b11.threeBetsFaced, threeBetFolds: b11.threeBetFolds });
    expect(AI.categorizeOpponent(HUMAN)).not.toBe('nit');
    expect(AI.categorizeOpponent(HUMAN)).toBe(AI.categorizeOpponent('sdstore-b11-0'));
    // 9c6c6a1 (the blocker): the frozen copy read the Stud counts.
    expect(LIVE.categorizeOpponent('sdstore-b11-0')).not.toBe('nit');
  });
});

const ARCHS = ['TAG', 'LAG', 'NIT', 'ROCK', 'FISH', 'MANIAC', 'CALLING_STATION'];
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const prof = (archetype: string, difficulty: string) =>
  ({ botName: 'B', difficulty, personality: 'x', archetype, vpip: 0.3, pfr: 0.2, aggressionFactor: 2.5, bluffFrequency: 0.15 } as any);

/**
 * Plays `tables` tables of `hands` hands (the human at seat 0 calls / checks every street, the bots decide through
 * AIPlayer.decideAction). At every bot decision the human's store entry is swapped to each of `variants` in turn and
 * the spot decided with the same Math.random seed; the first variant's decision is applied. Returns per variant the
 * decision lines. The store is not fed during this phase (only the swapped profiles are read).
 */
function playSpots(mk: (id: string) => PokerTable, variants: AI.OpponentSessionProfile[], tables: number, hands: number): string[][] {
  const out: string[][] = variants.map(() => []);
  const saved = OPPONENT_PROFILE_STORE.get(HUMAN);
  try {
    for (let c = 0; c < tables; c++) {
      const t = mk(`sdstore-spot-${c}`);
      const ns = 2 + (c % 3);
      expect(t.sitDown(0, 'Hero', 100 * BB, HUMAN, false)).toBe(true);
      const ps: any[] = [null];
      for (let i = 1; i < ns; i++) {
        expect(t.sitDown(i, `B${i}`, 100 * BB, `ai-sdstore-spot-${c}-${i}`, true)).toBe(true);
        ps.push(prof(ARCHS[(c * 3 + i) % ARCHS.length], DIFFS[(c + i) % DIFFS.length]));
      }
      for (let h = 0; h < hands; h++) {
        for (const s of t.seats) if (s.state === 'occupied') { s.chipCount = 100 * BB; s.eliminated = false; }
        expect(t.startNewHand()).toBe(true);
        let g = 0;
        while (t.isHandInProgress() && g++ < 300) {
          const a = t.activeSeatIndex;
          if (a < 0) break;
          if (a === 0) { if (!t.playerCall(0)) t.playerCheck(0) || t.playerFold(0); continue; }
          const seed = (st = (Math.imul(st, 1664525) + 1013904223) >>> 0);
          const decided: AI.AIDecision[] = [];
          for (let vi = 0; vi < variants.length; vi++) {
            OPPONENT_PROFILE_STORE.set(HUMAN, variants[vi]);
            st = seed; draws = 0;
            Date.now = () => 1_800_000_000_000;
            let dv: AI.AIDecision;
            try { dv = AI.decideAction(t, a, ps[a]); } finally { Date.now = realNow; }
            out[vi].push(`${c}/${t.handNumber} ${t.currentPhase} s${a} ${ps[a].archetype}/${ps[a].difficulty} ${dv.action} ${dv.raiseAmount} r${draws}`);
            decided.push(dv);
          }
          st = (seed ^ 0x9e3779b9) >>> 0;
          const d = decided[0];
          let ok = false;
          switch (d.action) {
            case PlayerAction.Fold: ok = t.playerFold(a); break;
            case PlayerAction.Check: ok = t.playerCheck(a) || t.playerFold(a); break;
            case PlayerAction.Call: ok = t.playerCall(a) || t.playerCheck(a) || t.playerFold(a); break;
            case PlayerAction.Raise: ok = t.playerRaise(a, d.raiseAmount) || t.playerCall(a) || t.playerCheck(a) || t.playerFold(a); break;
            case PlayerAction.AllIn: ok = t.playerAllIn(a) || t.playerFold(a); break;
            default: ok = t.playerFold(a);
          }
          if (!ok) (t as any).advanceTurn();
        }
        expect(t.isHandInProgress()).toBe(false);
      }
    }
  } finally {
    if (saved) OPPONENT_PROFILE_STORE.set(HUMAN, saved); else OPPONENT_PROFILE_STORE.delete(HUMAN);
  }
  return out;
}
const differing = (a: string[], b: string[]) => a.filter((x, i) => x !== b[i]).length;

describe('decisions with that human in the hand', () => {
  let real: AI.OpponentSessionProfile, live: AI.OpponentSessionProfile, b11: AI.OpponentSessionProfile;
  beforeAll(() => {
    st = 11; deckN = 0; playStud();
    real = { ...AI.getOpponentProfile(HUMAN)! };
    live = { ...replayAs('sdstore-live-1', 'live') };
    b11 = { ...replayAs('sdstore-b11-1', 'b11') };
  });

  it('Short Deck (the frozen 0dc1b96 copy): every decision equals the one against the 0dc1b96-fed profile; CONTROL: the 9c6c6a1 layout changes some', () => {
    const t = new ShortDeckTable({ tableId: 'x', tableName: 'x', smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: 1 } as any);
    expect(AI.shortDeckBotsPlayLive(t)).toBe(true);
    st = 101;
    const [r, l, b] = playSpots((id) => new ShortDeckTable({ tableId: id, tableName: id, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: 1 } as any), [real, live, b11], 3, 8);
    expect(r.length).toBeGreaterThanOrEqual(60);
    expect(r.filter((x) => !/ PreFlop /.test(x)).length).toBeGreaterThanOrEqual(30);
    expect(r.filter((x, i) => x !== l[i])).toEqual([]);
    expect(differing(r, b)).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it('Hold\'em (the current bots): every decision equals the one against a3ac266\'s layout; CONTROL: the 0dc1b96-fed profile changes some', () => {
    st = 202;
    const [r, b, l] = playSpots((id) => new PokerTable({ tableId: id, tableName: id, smallBlind: BB / 2, bigBlind: BB, ante: 0, minBuyIn: 1 } as any), [real, b11, live], 3, 8);
    expect(r.length).toBeGreaterThanOrEqual(60);
    expect(r.filter((x, i) => x !== b[i])).toEqual([]);
    expect(differing(r, l)).toBeGreaterThanOrEqual(1);
  }, 300_000);
});

/**
 * Bots review 2026-11-04 (equity-variants C7) — the human Training-mode coach
 * at Omaha Hi-Lo prices the expected POT SHARE (the high and the low halves),
 * not a high-only win chance.
 *
 * At 0dc1b96 getGameStateForPlayer called getFullTrainingData with 8 arguments
 * (no hi-lo flag): the coach showed 26% for A-2-3-K on 5-6-8 heads-up, a hand
 * that wins about 62% of the pot (a made nut low plus high chances). Now the
 * coach block passes `isHiLo` as the 9th argument (contract/equity-1), from the
 * table's variant (variant.isHiLo — a 6-card hi-lo table's variantId is
 * 'omaha-6') or a 'hi-lo' variantId.
 *
 * The REAL getVariantInfo + getGameStateForPlayer, sliced from src/index.ts
 * (the gameplay_S6 G181 harness scope), on REAL OmahaTables, with the REAL
 * getFullTrainingData behind a spy.
 *
 * Fails on 0dc1b96: 8 arguments; equity 26 (cases a, b and d fail).
 */
import { PokerTable, GamePhase, MAX_SEATS } from '../src/game/PokerTable';
import { OmahaTable } from '../src/game/variants/OmahaTable';
import { ShortDeckTable } from '../src/game/variants/ShortDeckTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { Card, cardToString } from '../src/game/Card';
import * as TE from '../src/training/TrainingEngine';
import { fnSrc, load } from './helpers/indexSource';

const STATE = [fnSrc('function getVariantInfo('), fnSrc('function getGameStateForPlayer(')].join('\n');
const C = (x: string): Card[] => x.split(' ').map((tk) => ({ rank: ({ A: 14, K: 13, Q: 12, J: 11, T: 10 } as Record<string, number>)[tk[0]] ?? Number(tk[0]), suit: ({ h: 0, d: 1, c: 2, s: 3 } as Record<string, number>)[tk[1]] } as Card));

function seedRandom(seed: number): () => void {
  const orig = Math.random;
  let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}

function coachAt(table: OmahaTable) {
  const spy = jest.fn((...a: any[]) => (TE.getFullTrainingData as any)(...a));
  const { exports: gs, stubbed } = load(STATE, {
    isTournamentTable: () => false, PokerTable, OmahaTable, ShortDeckTable, FiveCardDrawTable, SevenStudTable, MAX_SEATS, GamePhase, cardToString,
    playerSessions: new Map(), turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(),
    dealersChoiceState: new Map(), DEALERS_CHOICE_VARIANTS: [], insuranceQuoteForSeat: () => null, sitOutTracker: new Map(),
    tournamentIdOfTable: () => undefined, rebuyAllowedAt: () => true, progressionManager: { getProgress: () => null },
    tableKindOf: () => 'cash', bombPotAllowedAt: () => false, straddleAllowedAt: () => false, drawClockStart: () => 0,
    getFullTrainingData: spy,
  }, 'getGameStateForPlayer');
  table.sitDown(0, 'P0', 10000, 'p0', false);
  table.sitDown(1, 'P1', 10000, 'p1', false);
  expect(table.startNewHand()).toBe(true);
  for (let g = 0; g < 10 && table.currentPhase === GamePhase.PreFlop; g++) { const a = table.activeSeatIndex; if (!table.playerCall(a)) table.playerCheck(a); }
  expect(table.currentPhase).toBe(GamePhase.Flop);
  const holes = table.seats[0].holeCards.length;
  table.seats[0].holeCards = holes === 4 ? C('Ah 2d 3c Ks') : C(`Ah 2d 3c Ks ${holes >= 5 ? 'Qs' : ''} ${holes >= 6 ? 'Jd' : ''}`.trim().replace(/\s+/g, ' '));
  table.communityCards = C('5h 6c 8d');
  const restore = seedRandom(7);
  let state: any;
  try { state = gs(table, 0, true); } finally { restore(); }
  return { spy, state, stubbed };
}
const cfg = () => ({ tableId: 'A', tableName: 'A', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 10000 } as any);

describe('C7 — the Training coach at Omaha Hi-Lo prices the pot share', () => {
  it('(a)(b) PLO-8: getFullTrainingData gets isHiLo = true (9th argument); A-2-3-K on 5-6-8 shows ~62% (0dc1b96: 8 arguments, 26%)', () => {
    const { spy, state, stubbed } = coachAt(new OmahaTable(cfg(), true, 4));
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0];
    expect(args).toHaveLength(9);
    expect(args[7]).toBe(true);     // isOmaha
    expect(args[8]).toBe(true);     // isHiLo
    expect(state.trainingData.equity).toBeGreaterThanOrEqual(57);
    expect(state.trainingData.equity).toBeLessThanOrEqual(67);
    expect([...stubbed].filter((n) => /getFullTrainingData|OmahaTable|GamePhase/.test(n))).toEqual([]);
  }, 60_000);

  it('(c) PLO (high only): isHiLo = false; the high-only equity as before', () => {
    const { spy, state } = coachAt(new OmahaTable(cfg(), false, 4));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][7]).toBe(true);
    expect(spy.mock.calls[0][8]).toBe(false);
    expect(state.trainingData.equity).toBeLessThan(45);
  }, 60_000);

  it("(d) 6-card Omaha Hi-Lo (variantId 'omaha-6'): isHiLo = true through variant.isHiLo", () => {
    const t = new OmahaTable(cfg(), true, 6);
    expect((t as any).variantId).toBe('omaha-6');
    const { spy } = coachAt(t);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][8]).toBe(true);
  }, 60_000);

  it('GUARD — the coach still never runs at a qualifier table (the !stateQualifierId gate is unchanged)', () => {
    const src = fnSrc('function getGameStateForPlayer(');
    expect(src).toMatch(/trainingEnabled &&\n\s+!stateQualifierId &&/);
    expect(src).toContain('const isHiLo = isOmaha && ((table as any).variant?.isHiLo === true || vId.includes(\'hi-lo\'));');
  });
});

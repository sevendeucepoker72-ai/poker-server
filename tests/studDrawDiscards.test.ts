/**
 * Bots review 2026-11-04 (stud-draw-lowball SD1, B3 / B15 / Badugi-greedy): the bots' draw
 * picker, chooseBotDiscards / keepForDraw in src/ai/studDrawStrength.ts. UNIT cases only; the
 * scheduleAIAction wiring (the REAL index.ts draw timer) is tested by the server lane in
 * tests/studDrawDrawHang.test.ts.
 *
 * At 0dc1b96 the draw picker lived inline in index.ts scheduleAIAction and (measured over
 * 200k seeded deals, design/stud-draw-lowball/drawchk.out):
 *   - Five Card Draw broke a pat straight / flush 82.6% of the time and never drew one to a four-flush;
 *   - Badugi kept a worse subset than the hand's best badugi 5.16% of the time (greedy pick);
 *   - 2-7 never stood pat on a made 9- or 10-low at the last draw.
 *
 * Fails on 0dc1b96: src/ai/studDrawStrength.ts does not exist.
 */
import { Card } from '../src/game/Card';
import { evaluateBadugiHand, compareBadugiHands } from '../src/game/HandEvaluatorExtensions';
import { chooseBotDiscards, keepForDraw, drawsLeftAt, studDrawKindOf } from '../src/ai/studDrawStrength';

const SUIT: Record<string, number> = { h: 0, d: 1, c: 2, s: 3 };
const RANK: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const C = (s: string): Card[] => s.trim().split(/\s+/).map((t) => ({ rank: RANK[t[0]] ?? Number(t[0]), suit: SUIT[t[1]] } as Card));
const kept = (cards: Card[], discards: number[]) => cards.filter((_, i) => !discards.includes(i));
const str = (cards: Card[]) => cards.map((c) => `${c.rank}/${c.suit}`).join(' ');

describe('studDrawKindOf / drawsLeftAt', () => {
  test('variant ids map to their game', () => {
    expect(studDrawKindOf('seven-stud', null)).toBe('stud-hi');
    expect(studDrawKindOf('seven-card-stud', null)).toBe('stud-hi');
    expect(studDrawKindOf('seven-card-stud-hi-lo', null)).toBe('stud8');
    expect(studDrawKindOf('razz', null)).toBe('razz');
    expect(studDrawKindOf('five-card-draw', null)).toBe('draw-hi');
    expect(studDrawKindOf('triple-draw', null)).toBe('deuce7');
    expect(studDrawKindOf('badugi', null)).toBe('badugi');
    expect(studDrawKindOf('texas-holdem', null)).toBeNull();
  });
  test('an unknown id falls back on the table shape', () => {
    expect(studDrawKindOf('x', { getStudFirstActor() {}, variant: { isRazz: true } })).toBe('razz');
    expect(studDrawKindOf('x', { getStudFirstActor() {}, isHiLo: true })).toBe('stud8');
    expect(studDrawKindOf('x', { getStudFirstActor() {} })).toBe('stud-hi');
    expect(studDrawKindOf('x', { playerDraw() {}, holeCardCount: 4 })).toBe('badugi');
    expect(studDrawKindOf('x', { playerDraw() {}, holeCardCount: 5, variant: { isTripleDraw: true } })).toBe('deuce7');
    expect(studDrawKindOf('x', { playerDraw() {}, holeCardCount: 5 })).toBe('draw-hi');
  });
  test('draws left by round', () => {
    expect(['PreFlop', 'Draw1', 'Bet2', 'Draw2', 'Bet3', 'Draw3', 'River'].map((p) => drawsLeftAt('deuce7', p))).toEqual([3, 3, 2, 2, 1, 1, 0]);
    expect(['PreFlop', 'Draw1', 'Bet2'].map((p) => drawsLeftAt('draw-hi', p))).toEqual([1, 1, 0]);
  });
});

describe('Five Card Draw (B3)', () => {
  test.each(['9h Td Jc Qs Kh', 'Ah Jh 8h 5h 2h', 'Kc Tc 7c 4c 3c'])('pat hand %s discards nothing at Draw1', (h) => {
    expect(chooseBotDiscards('draw-hi', C(h), 'Draw1')).toEqual([]);
  });
  test('a four-flush draws one: Kh Qh 8h 4h 2c throws the 2c', () => {
    expect(chooseBotDiscards('draw-hi', C('Kh Qh 8h 4h 2c'), 'Draw1')).toEqual([4]);
  });
  test('an open-ended four-straight draws one: 8c 9d Th Js 3c throws the 3c', () => {
    expect(chooseBotDiscards('draw-hi', C('8c 9d Th Js 3c'), 'Draw1')).toEqual([4]);
  });
  test('two pair discards one card; a full house discards none; one pair keeps the pair', () => {
    expect(chooseBotDiscards('draw-hi', C('Kh Kd 7c 7s 2h'), 'Draw1')).toEqual([4]);
    expect(chooseBotDiscards('draw-hi', C('Kh Kd Kc 7s 7h'), 'Draw1')).toEqual([]);
    expect(chooseBotDiscards('draw-hi', C('2h Qd 9c Qs 5h'), 'Draw1')).toEqual([0, 2, 4]);
  });
});

describe('Badugi (B15 / greedy pick)', () => {
  test('Ah As 2h 3c keeps As 2h 3c', () => {
    const h = C('Ah As 2h 3c');
    expect(str(kept(h, chooseBotDiscards('badugi', h, 'Draw1')))).toBe(str(C('As 2h 3c')));
  });
  test('7d 2d 2s Ks keeps 7d 2s', () => {
    const h = C('7d 2d 2s Ks');
    expect(str(kept(h, chooseBotDiscards('badugi', h, 'Draw1')))).toBe(str(C('7d 2s')));
  });
  test('Ah 3d Kc 5h keeps A-3 at Draw1 (no drawing to a K with draws to come) and A-3-K at Draw3', () => {
    const h = C('Ah 3d Kc 5h');
    expect(str(kept(h, chooseBotDiscards('badugi', h, 'Draw1')))).toBe(str(C('Ah 3d')));
    expect(str(kept(h, chooseBotDiscards('badugi', h, 'Draw3')))).toBe(str(C('Ah 3d Kc')));
  });
  test.each(['Ah 2d 3c 4s', 'Kh Qd Jc Ts'])('a badugi (%s) stands pat at every draw', (h) => {
    for (const ph of ['Draw1', 'Draw2', 'Draw3']) expect(chooseBotDiscards('badugi', C(h), ph)).toEqual([]);
  });
  test('over 50k seeded hands at Draw3 the kept subset is never worse than evaluateBadugiHand\'s best (0dc1b96: 5.16% worse)', () => {
    const deck: Card[] = [];
    for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s } as Card);
    let x = 777;
    const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
    let worse = 0;
    for (let n = 0; n < 50000; n++) {
      const d = deck.slice();
      for (let i = 0; i < 4; i++) { const j = i + Math.floor(rnd() * (d.length - i)); const t = d[i]; d[i] = d[j]; d[j] = t; }
      const h = d.slice(0, 4);
      const keep = kept(h, chooseBotDiscards('badugi', h, 'Draw3'));
      if (compareBadugiHands(evaluateBadugiHand(keep), evaluateBadugiHand(h)) < 0) worse++;
    }
    expect(worse).toBe(0);
  }, 60000);
});

describe('2-7 Triple Draw (B15)', () => {
  test('9-7-5-3-2 stands pat at Draw3 and throws the 9 at Draw1', () => {
    const h = C('9h 7d 5c 3s 2h');
    expect(chooseBotDiscards('deuce7', h, 'Draw3')).toEqual([]);
    expect(chooseBotDiscards('deuce7', h, 'Draw1')).toEqual([0]);
  });
  test('T-7-5-3-2 stands pat at Draw3', () => {
    expect(chooseBotDiscards('deuce7', C('Th 7d 5c 3s 2h'), 'Draw3')).toEqual([]);
  });
  test('2-3-4-5-6 (a straight) throws the 6 at every draw', () => {
    for (const ph of ['Draw1', 'Draw2', 'Draw3']) expect(chooseBotDiscards('deuce7', C('2h 3d 4c 5s 6h'), ph)).toEqual([4]);
  });
  test('K-Q-9-8-3 keeps 8-3 at Draw1 and 9-8-3 at the last draw', () => {
    const h = C('Kh Qd 9c 8s 3h');
    expect(kept(h, chooseBotDiscards('deuce7', h, 'Draw1')).map((c) => c.rank).sort((a, b) => b - a)).toEqual([8, 3]);
    expect(kept(h, chooseBotDiscards('deuce7', h, 'Draw3')).map((c) => c.rank).sort((a, b) => b - a)).toEqual([9, 8, 3]);
  });
  test('keepForDraw and chooseBotDiscards partition the hand', () => {
    const h = C('Kh Qd 9c 8s 3h');
    const keep = keepForDraw('deuce7', h, 3), disc = chooseBotDiscards('deuce7', h, 'Draw1');
    expect([...keep, ...disc].sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

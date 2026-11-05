/**
 * Hold'em countOuts (bots review 2026-11-04): a gutshot is 4 outs.
 */
import * as AIP from '../src/ai/AIPlayer';

const S: any = { h: 0, d: 1, c: 2, s: 3 }; const RK: any = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const cards = (s: string) => s.trim().split(/\s+/).map(t => ({ rank: RK[t[0]] ?? Number(t[0]), suit: S[t[1]] })) as any;
function seedRandom(seed: number): () => void {
  const orig = Math.random; let s = seed >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => { Math.random = orig; };
}

describe('Hold\'em countOuts — a gutshot is 4 outs, not 8', () => {
  const co = (h: string, b: string) => (AIP as any).countOuts(cards(h), cards(b));
  it('gutshots 4, open-enders and double gutters 8, with a flush draw 12 / 15', () => {
    expect(co('9h 8c', 'Jd 7s 2c')).toBe(4);
    expect(co('Qh Jh', 'As Kd 4s')).toBe(4);
    expect(co('9h 8c', 'Td 7s 2c')).toBe(8);
    expect(co('9h 7c', 'Jd 8s 5c')).toBe(8);
    expect(co('9h 8h', 'Jh 7s 2h')).toBe(12);
    expect(co('9h 8h', 'Th 7s 2h')).toBe(15);
  });
  it('random flops: >= 8 outs on <= 10% (was 17.1%; true straight/flush 8+ is ~6.5%)', () => {
    const restore = seedRandom(12345);
    try {
      const deck: any[] = []; for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
      let n8 = 0; const N = 5000;
      for (let i = 0; i < N; i++) {
        const d = deck.slice(); for (let k = 0; k < 5; k++) { const j = k + Math.floor(Math.random() * (d.length - k)); const t = d[k]; d[k] = d[j]; d[j] = t; }
        if ((AIP as any).countOuts(d.slice(0, 2), d.slice(2, 5)) >= 8) n8++;
      }
      expect(n8 / N).toBeLessThanOrEqual(0.10);
    } finally { restore(); }
  });
});

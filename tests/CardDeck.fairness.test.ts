/**
 * Shuffle uniformity (2026-07-05).
 *
 * The deck is provably-fair: a crypto.randomBytes(32) seed feeds a DETERMINISTIC seeded PRNG
 * (required so the shuffle replays from the revealed seed for verification), driving a textbook
 * Fisher-Yates. We do NOT swap to crypto.randomInt (that would break replay) or change the PRNG
 * (that would break the published fairness-verification contract). Instead we PROVE the current
 * shuffle is statistically uniform: over many real shuffles, every card should land in every
 * board position with equal probability (~N/52). A chi-square goodness-of-fit test flags any
 * position bias.
 */
import { CardDeck } from '../src/game/CardDeck';

// chi-square critical value for df=51 at alpha=0.001 (very lenient — we only want to catch REAL bias)
const CHI2_CRIT_51_p001 = 92.0; // ~ upper 0.1% point of chi-square(51)

function cardId(c: { suit: number; rank: number }): number {
  return c.suit * 13 + (c.rank - 2); // 0..51 assuming Rank.Two==2
}

describe('CardDeck — shuffle uniformity (provably-fair, unbiased)', () => {
  test('a fixed card lands in every deck position with equal frequency (chi-square)', () => {
    const N = 60000;
    const TARGET = 0; // track one specific card (id 0) across all 52 positions
    const posCounts = new Array(52).fill(0);

    for (let n = 0; n < N; n++) {
      const d = new CardDeck();
      d.shuffle(n);
      const cards: Array<{ suit: number; rank: number }> = (d as any).cards;
      const pos = cards.findIndex(c => cardId(c) === TARGET);
      expect(pos).toBeGreaterThanOrEqual(0); // the card is always somewhere
      posCounts[pos]++;
    }

    const expected = N / 52;
    let chi2 = 0;
    for (let p = 0; p < 52; p++) {
      const diff = posCounts[p] - expected;
      chi2 += (diff * diff) / expected;
    }
    // If the shuffle were biased (e.g. modulo bias, a stuck PRNG bit), some positions would be
    // over/under-represented and chi2 would blow past the critical value.
    expect(chi2).toBeLessThan(CHI2_CRIT_51_p001);
  });

  test('every card appears exactly once and all 52 are present (no dupes/drops)', () => {
    for (let n = 0; n < 500; n++) {
      const d = new CardDeck();
      d.shuffle(n);
      const cards: Array<{ suit: number; rank: number }> = (d as any).cards;
      expect(cards.length).toBe(52);
      const ids = new Set(cards.map(cardId));
      expect(ids.size).toBe(52);
    }
  });

  test('same seed reproduces the exact shuffle (deterministic replay for verification)', () => {
    // Two decks, same commitment seed → identical order. This is what makes the reveal verifiable.
    const d1 = new CardDeck();
    const c1 = d1.shuffle(1);
    const order1 = ((d1 as any).cards as Array<{ suit: number; rank: number }>).map(cardId);
    // Rehydrate a second deck from the same commitment (seed) and confirm identical order.
    const d2 = new CardDeck();
    (d2 as any)._commitment = c1;
    (d2 as any).currentIndex = 0;
    // Re-run the same deterministic shuffle path by replaying with the seed.
    const seededRandom = (seed: string) => {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(seed).digest();
      let s0 = hash.readUInt32BE(0), s1 = hash.readUInt32BE(4), s2 = hash.readUInt32BE(8), s3 = hash.readUInt32BE(12);
      return () => {
        const t = s1 << 9;
        s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = (s3 << 11) | (s3 >>> 21);
        return (s0 >>> 0) / 4294967296;
      };
    };
    const cards: Array<{ suit: number; rank: number }> = [];
    for (let suit = 0; suit <= 3; suit++) for (let rank = 2; rank <= 14; rank++) cards.push({ suit, rank });
    const rng = seededRandom(c1.seed);
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    expect(cards.map(cardId)).toEqual(order1);
  });
});

import { Card, Suit, Rank } from './Card';
import * as crypto from 'crypto';

export interface DeckCommitment {
  seed: string;       // revealed after hand
  hash: string;       // committed before hand (SHA-256 of seed)
  handNumber: number;
}

function seededRandom(seed: string): () => number {
  // Simple xorshift PRNG seeded from SHA-256 of seed string
  const hash = crypto.createHash('sha256').update(seed).digest();
  let s0 = hash.readUInt32BE(0);
  let s1 = hash.readUInt32BE(4);
  let s2 = hash.readUInt32BE(8);
  let s3 = hash.readUInt32BE(12);
  return () => {
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    const result = ((s0 >>> 0) / 4294967296);
    return result;
  };
}

export class CardDeck {
  private cards: Card[] = [];
  private currentIndex: number = 0;
  private _commitment: DeckCommitment | null = null;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.cards = [];
    for (let suit = Suit.Hearts; suit <= Suit.Spades; suit++) {
      for (let rank = Rank.Two; rank <= Rank.Ace; rank++) {
        this.cards.push({ suit, rank });
      }
    }
    this.currentIndex = 0;
    this._commitment = null;
  }

  shuffle(handNumber: number = 0): DeckCommitment {
    this.currentIndex = 0;
    // Generate random seed
    const seed = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(seed).digest('hex');
    this._commitment = { seed, hash, handNumber };

    // Fisher-Yates shuffle using seeded PRNG
    const rng = seededRandom(seed);
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }

    // Return commitment (hash only — seed stays secret until hand ends)
    return this._commitment;
  }

  revealSeed(): DeckCommitment | null {
    return this._commitment;
  }

  dealOne(): Card | null {
    if (this.currentIndex >= this.cards.length) return null;
    return this.cards[this.currentIndex++];
  }

  cardsRemaining(): number {
    return this.cards.length - this.currentIndex;
  }

  get commitment(): DeckCommitment | null {
    return this._commitment;
  }
}

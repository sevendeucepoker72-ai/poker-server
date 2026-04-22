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

  /**
   * Shuffle a foreign array of cards using a PRNG derived from this deck's
   * commitment seed (plus a domain tag so the same seed produces a different
   * shuffle for different purposes — e.g., reshuffling discards in 5-card draw).
   * Falls back to a fresh per-call seed if no commitment exists yet.
   */
  shuffleForeignCards(cards: Card[], domain: string): Card[] {
    const seed = (this._commitment?.seed || crypto.randomBytes(16).toString('hex')) + ':' + domain;
    const rng = seededRandom(seed);
    const arr = [...cards];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Serialize enough state to restore a deck identically after a
   * server restart. We only persist the commitment (seed + hash +
   * handNumber) and currentIndex. On restore we reset, re-run Fisher-
   * Yates with the same seed (deterministic because the PRNG is seeded
   * from the seed), and advance the index — producing the exact same
   * card order and the same "cards already dealt" pointer without ever
   * serializing the card array itself.
   */
  serialize(): { commitment: DeckCommitment | null; currentIndex: number } {
    return {
      commitment: this._commitment,
      currentIndex: this.currentIndex,
    };
  }

  static deserialize(snapshot: { commitment: DeckCommitment | null; currentIndex: number }): CardDeck {
    const deck = new CardDeck();
    deck.reset();
    if (snapshot.commitment) {
      // Replay the shuffle deterministically with the original seed.
      deck._commitment = snapshot.commitment;
      const rng = seededRandom(snapshot.commitment.seed);
      for (let i = deck.cards.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck.cards[i], deck.cards[j]] = [deck.cards[j], deck.cards[i]];
      }
    }
    deck.currentIndex = Math.max(0, Math.min(snapshot.currentIndex, deck.cards.length));
    return deck;
  }
}

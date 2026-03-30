export enum Suit {
  Hearts = 0,
  Diamonds = 1,
  Clubs = 2,
  Spades = 3,
}

export enum Rank {
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
  Ten = 10,
  Jack = 11,
  Queen = 12,
  King = 13,
  Ace = 14,
}

export interface Card {
  suit: Suit;
  rank: Rank;
}

const SUIT_SYMBOLS: Record<Suit, string> = {
  [Suit.Hearts]: '\u2665',
  [Suit.Diamonds]: '\u2666',
  [Suit.Clubs]: '\u2663',
  [Suit.Spades]: '\u2660',
};

const RANK_NAMES: Record<Rank, string> = {
  [Rank.Two]: '2',
  [Rank.Three]: '3',
  [Rank.Four]: '4',
  [Rank.Five]: '5',
  [Rank.Six]: '6',
  [Rank.Seven]: '7',
  [Rank.Eight]: '8',
  [Rank.Nine]: '9',
  [Rank.Ten]: '10',
  [Rank.Jack]: 'J',
  [Rank.Queen]: 'Q',
  [Rank.King]: 'K',
  [Rank.Ace]: 'A',
};

export function cardToString(c: Card): string {
  return `${RANK_NAMES[c.rank]}${SUIT_SYMBOLS[c.suit]}`;
}

export function cardsToString(cards: Card[]): string {
  return cards.map(cardToString).join(' ');
}

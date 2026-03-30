const { evaluateHand, compareTo, HandRank } = require('./dist/game/HandEvaluator');
const { Rank, Suit } = require('./dist/game/Card');

function card(rank, suit) { return { rank, suit: suit || Suit.Hearts }; }

let fails = 0;
function test(name, cards, expectedRank, expectedPrimary) {
  const r = evaluateHand(cards);
  const pass = r.handRank === expectedRank && (expectedPrimary === undefined || r.primaryValue === expectedPrimary);
  console.log(pass ? 'PASS' : 'FAIL', name, '- Got:', r.handName, 'primary:', r.primaryValue);
  if (!pass) {
    console.log('  Expected rank', expectedRank, 'primary', expectedPrimary);
    fails++;
  }
  return r;
}

function cmpTest(name, cards1, cards2, expectedSign) {
  const r1 = evaluateHand(cards1);
  const r2 = evaluateHand(cards2);
  const cmp = compareTo(r1, r2);
  const pass = (expectedSign > 0 && cmp > 0) || (expectedSign < 0 && cmp < 0) || (expectedSign === 0 && cmp === 0);
  console.log(pass ? 'PASS' : 'FAIL', name, '- cmp:', cmp, '(' + r1.handName + ' vs ' + r2.handName + ')');
  if (!pass) fails++;
}

console.log('\n=== Basic Hand Rankings ===');
test('Royal Flush', [card(Rank.Ace,Suit.Spades), card(Rank.King,Suit.Spades), card(Rank.Queen,Suit.Spades), card(Rank.Jack,Suit.Spades), card(Rank.Ten,Suit.Spades)], HandRank.RoyalFlush, Rank.Ace);
test('Straight Flush 9-high', [card(9,Suit.Clubs), card(8,Suit.Clubs), card(7,Suit.Clubs), card(6,Suit.Clubs), card(5,Suit.Clubs)], HandRank.StraightFlush, 9);
test('Wheel Straight Flush', [card(Rank.Ace,Suit.Diamonds), card(2,Suit.Diamonds), card(3,Suit.Diamonds), card(4,Suit.Diamonds), card(5,Suit.Diamonds)], HandRank.StraightFlush, 5);
test('Four Aces', [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.Ace,Suit.Spades), card(Rank.King)], HandRank.FourOfAKind, Rank.Ace);
test('Full House KKK-AA', [card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds)], HandRank.FullHouse, Rank.King);
test('Flush A-high', [card(Rank.Ace,Suit.Hearts), card(10,Suit.Hearts), card(7,Suit.Hearts), card(4,Suit.Hearts), card(2,Suit.Hearts)], HandRank.Flush, Rank.Ace);
test('Straight T-high', [card(10,Suit.Hearts), card(9,Suit.Diamonds), card(8,Suit.Clubs), card(7,Suit.Spades), card(6,Suit.Hearts)], HandRank.Straight, 10);
test('Wheel Straight', [card(Rank.Ace), card(2,Suit.Diamonds), card(3,Suit.Clubs), card(4,Suit.Spades), card(5,Suit.Hearts)], HandRank.Straight, 5);
test('Three Jacks', [card(Rank.Jack,Suit.Hearts), card(Rank.Jack,Suit.Diamonds), card(Rank.Jack,Suit.Clubs), card(9,Suit.Spades), card(2)], HandRank.ThreeOfAKind, Rank.Jack);
test('Two Pair AA-KK', [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.King,Suit.Spades), card(Rank.Queen)], HandRank.TwoPair, Rank.Ace);
test('Pair Aces', [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Queen,Suit.Spades), card(Rank.Jack)], HandRank.OnePair, Rank.Ace);
test('High Card Ace', [card(Rank.Ace), card(Rank.King,Suit.Diamonds), card(Rank.Queen,Suit.Clubs), card(Rank.Jack,Suit.Spades), card(9)], HandRank.HighCard, Rank.Ace);

console.log('\n=== Ranking Order (each should beat the next) ===');
cmpTest('Royal > Straight Flush',
  [card(Rank.Ace,Suit.Spades), card(Rank.King,Suit.Spades), card(Rank.Queen,Suit.Spades), card(Rank.Jack,Suit.Spades), card(10,Suit.Spades)],
  [card(9,Suit.Clubs), card(8,Suit.Clubs), card(7,Suit.Clubs), card(6,Suit.Clubs), card(5,Suit.Clubs)], 1);
cmpTest('Straight Flush > Four Kind',
  [card(9,Suit.Clubs), card(8,Suit.Clubs), card(7,Suit.Clubs), card(6,Suit.Clubs), card(5,Suit.Clubs)],
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.Ace,Suit.Spades), card(Rank.King)], 1);
cmpTest('Four Kind > Full House',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.Ace,Suit.Spades), card(Rank.King)],
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds)], 1);
cmpTest('Full House > Flush',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds)],
  [card(Rank.Ace,Suit.Hearts), card(10,Suit.Hearts), card(7,Suit.Hearts), card(4,Suit.Hearts), card(2,Suit.Hearts)], 1);
cmpTest('Flush > Straight',
  [card(Rank.Ace,Suit.Hearts), card(10,Suit.Hearts), card(7,Suit.Hearts), card(4,Suit.Hearts), card(2,Suit.Hearts)],
  [card(Rank.Ace), card(Rank.King,Suit.Diamonds), card(Rank.Queen,Suit.Clubs), card(Rank.Jack,Suit.Spades), card(10,Suit.Hearts)], 1);
cmpTest('Straight > Three Kind',
  [card(10,Suit.Hearts), card(9,Suit.Diamonds), card(8,Suit.Clubs), card(7,Suit.Spades), card(6)],
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.King,Suit.Spades), card(Rank.Queen)], 1);
cmpTest('Three Kind > Two Pair',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.King,Suit.Spades), card(Rank.Queen)],
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.King,Suit.Spades), card(Rank.Queen)], 1);
cmpTest('Two Pair > One Pair',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.King,Suit.Spades), card(Rank.Queen)],
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Queen,Suit.Spades), card(Rank.Jack)], 1);
cmpTest('One Pair > High Card',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Queen,Suit.Spades), card(Rank.Jack)],
  [card(Rank.Ace), card(Rank.King,Suit.Diamonds), card(Rank.Queen,Suit.Clubs), card(Rank.Jack,Suit.Spades), card(9)], 1);

console.log('\n=== Within-Rank Comparisons ===');
cmpTest('AAA-KK > KKK-AA (Full House trips matter)',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.Ace,Suit.Clubs), card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds)],
  [card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds)], 1);
cmpTest('Broadway > Wheel (Straight)',
  [card(Rank.Ace), card(Rank.King,Suit.Diamonds), card(Rank.Queen,Suit.Clubs), card(Rank.Jack,Suit.Spades), card(10,Suit.Hearts)],
  [card(Rank.Ace,Suit.Diamonds), card(2,Suit.Hearts), card(3,Suit.Clubs), card(4,Suit.Spades), card(5,Suit.Hearts)], 1);
cmpTest('AA-KK-Q > AA-KK-J (Two Pair kicker)',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.King,Suit.Spades), card(Rank.Queen)],
  [card(Rank.Ace,Suit.Clubs), card(Rank.Ace,Suit.Spades), card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds), card(Rank.Jack)], 1);
cmpTest('AA with K kicker > AA with Q kicker',
  [card(Rank.Ace,Suit.Hearts), card(Rank.Ace,Suit.Diamonds), card(Rank.King), card(5,Suit.Spades), card(3)],
  [card(Rank.Ace,Suit.Clubs), card(Rank.Ace,Suit.Spades), card(Rank.Queen), card(5,Suit.Diamonds), card(3,Suit.Clubs)], 1);
cmpTest('Exact tie (same ranks)',
  [card(Rank.Ace), card(Rank.King,Suit.Diamonds), card(Rank.Queen,Suit.Clubs), card(Rank.Jack,Suit.Spades), card(9)],
  [card(Rank.Ace,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Queen,Suit.Spades), card(Rank.Jack), card(9,Suit.Clubs)], 0);

console.log('\n=== 7-Card Best Hand Selection ===');
test('7-card finds Flush', [card(Rank.Ace,Suit.Hearts), card(10,Suit.Hearts), card(7,Suit.Hearts), card(4,Suit.Hearts), card(2,Suit.Hearts), card(Rank.King,Suit.Diamonds), card(Rank.Queen,Suit.Clubs)], HandRank.Flush, Rank.Ace);
test('7-card finds Full House', [card(Rank.King,Suit.Hearts), card(Rank.King,Suit.Diamonds), card(Rank.King,Suit.Clubs), card(Rank.Queen,Suit.Hearts), card(Rank.Queen,Suit.Diamonds), card(Rank.Jack,Suit.Clubs), card(10,Suit.Spades)], HandRank.FullHouse, Rank.King);
test('7-card finds Straight', [card(10,Suit.Hearts), card(9,Suit.Diamonds), card(8,Suit.Clubs), card(7,Suit.Spades), card(6), card(2,Suit.Clubs), card(3,Suit.Diamonds)], HandRank.Straight, 10);
test('7-card with two pair + trips = Full House', [card(Rank.Queen,Suit.Hearts), card(Rank.Queen,Suit.Diamonds), card(Rank.Queen,Suit.Clubs), card(Rank.Jack,Suit.Hearts), card(Rank.Jack,Suit.Diamonds), card(10,Suit.Clubs), card(10,Suit.Spades)], HandRank.FullHouse, Rank.Queen);

console.log('\n=== RESULTS:', fails === 0 ? 'ALL PASSED ✓' : fails + ' FAILURES ✗', '===');
process.exit(fails > 0 ? 1 : 0);

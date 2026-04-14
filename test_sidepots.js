/**
 * Side Pot Manager tests — verifies all scenarios from the dealer's guide.
 */
const { SidePotManager } = require('./dist/game/SidePotManager');
const { Suit } = require('./dist/game/Card');

const mgr = new SidePotManager();
let fails = 0;

function seat(idx, invested, allIn = false, folded = false) {
  return {
    seatIndex: idx,
    chipCount: 10000,
    totalInvestedThisHand: invested,
    folded,
    allIn,
    holeCards: [],
    state: 'occupied',
  };
}

function test(name, seats, expectedPots) {
  const pots = mgr.calculatePots(seats);
  const totalPot = pots.reduce((s, p) => s + p.amount, 0);
  const totalInvested = seats.reduce((s, p) => s + p.totalInvestedThisHand, 0);
  let pass = true;

  if (totalPot !== totalInvested) {
    console.log(`FAIL ${name} — pot total ${totalPot} !== invested ${totalInvested}`);
    fails++;
    return;
  }

  if (pots.length !== expectedPots.length) {
    console.log(`FAIL ${name} — expected ${expectedPots.length} pots, got ${pots.length}`);
    console.log('  Got:', JSON.stringify(pots.map(p => ({ name: p.name, amount: p.amount, eligible: p.eligibleSeatIndices }))));
    fails++;
    return;
  }

  for (let i = 0; i < expectedPots.length; i++) {
    const got = pots[i];
    const exp = expectedPots[i];
    if (got.amount !== exp.amount) {
      console.log(`FAIL ${name} — pot ${i}: expected amount ${exp.amount}, got ${got.amount}`);
      pass = false;
    }
    const gotElig = [...got.eligibleSeatIndices].sort();
    const expElig = [...exp.eligible].sort();
    if (gotElig.join(',') !== expElig.join(',')) {
      console.log(`FAIL ${name} — pot ${i}: expected eligible [${expElig}], got [${gotElig}]`);
      pass = false;
    }
  }

  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    fails++;
  }
}

// ─── Scenario 1: 2 Players, no side pot (B's excess already refunded) ───
test('2 Players — A=$100 all-in, B calls $100 (excess refunded)', [
  seat(0, 100, true),   // A all-in $100
  seat(1, 100, false),  // B called $100 (excess already returned by refundUncalledBets)
], [
  { amount: 200, eligible: [0, 1] },
]);

// ─── Scenario 2: 3 Players, 1 side pot ───
test('3 Players — A=$50 all-in, B=$150, C=$150', [
  seat(0, 50, true),    // A all-in $50
  seat(1, 150, false),  // B called $150
  seat(2, 150, false),  // C called $150
], [
  { amount: 150, eligible: [0, 1, 2] },  // Main: 50*3
  { amount: 200, eligible: [1, 2] },     // Side: 100*2
]);

// ─── Scenario 3: 3 Players, 2 all-ins, excess refunded ───
test('3 Players — A=$30 all-in, B=$80 all-in, C=$80 (excess refunded)', [
  seat(0, 30, true),    // A all-in $30
  seat(1, 80, true),    // B all-in $80
  seat(2, 80, false),   // C called $80 (excess $120 already returned)
], [
  { amount: 90, eligible: [0, 1, 2] },   // Main: 30*3
  { amount: 100, eligible: [1, 2] },     // Side: 50*2
]);

// ─── Scenario 4: 4 Players, 3 all-ins, maximum complexity ───
test('4 Players — A=$20, B=$60, C=$150, D=$150 (excess refunded)', [
  seat(0, 20, true),    // A all-in $20
  seat(1, 60, true),    // B all-in $60
  seat(2, 150, true),   // C all-in $150
  seat(3, 150, false),  // D called $150 (excess $150 already returned)
], [
  { amount: 80, eligible: [0, 1, 2, 3] },   // Main: 20*4
  { amount: 120, eligible: [1, 2, 3] },      // Side 1: 40*3
  { amount: 180, eligible: [2, 3] },         // Side 2: 90*2
]);

// ─── Scenario 5: With folded players (dead money) ───
test('Folded players contribute dead money but are not eligible', [
  seat(0, 50, true),    // A all-in $50
  seat(1, 100, false),  // B active $100
  seat(2, 25, false, true),  // C folded after posting $25
], [
  { amount: 125, eligible: [0, 1] },    // Main: 50+50+25 (C's 25 is dead money)
  { amount: 50, eligible: [1] },        // Side: 50*1 (only B)
]);

// ─── Scenario 6: Merge test — adjacent pots with same eligible set ───
test('Adjacent pots with same eligible players merge', [
  seat(0, 30, true),     // A all-in $30
  seat(1, 80, true),     // B all-in $80
  seat(2, 200, true),    // C all-in $200
  seat(3, 200, false),   // D called $200
  seat(4, 50, false, true),  // E folded after $50
], [
  // After merge: pots with same eligibility combine
  // Layer 0-30: 30*5=150, eligible: A,B,C,D (E folded)
  // Layer 30-80: B,C,D contribute 50 each + E contributes 20 = 170, eligible: B,C,D
  // Layer 80-200: C,D contribute 120 each = 240, eligible: C,D
  // B,C,D are eligible for layer 30-80, C,D for 80-200 — different sets, no merge
  { amount: 150, eligible: [0, 1, 2, 3] },
  { amount: 170, eligible: [1, 2, 3] },
  { amount: 240, eligible: [2, 3] },
]);

// ─── Scenario 7: Folded player with higher investment than all-in (bug fix) ───
test('Folded player invested more than all-in player — dead money captured', [
  seat(0, 6, true),          // A all-in $6
  seat(1, 114, false, true), // B folded after investing $114 (dead money)
  seat(2, 6, false),         // C called $6
], [
  // Total = 126. Dead money from B flows to eligible non-folded players (A, C).
  // After merge: both tiers have same eligible set [0,2] → merged into one pot.
  { amount: 126, eligible: [0, 2] },
]);

// ─── Scenario 8: Multiple folded with big investments ───
test('Multiple folded players with varying investments', [
  seat(0, 20, false, true),  // folded $20
  seat(1, 369, true),        // all-in $369
  seat(2, 369, false),       // called $369
  seat(3, 2920, false, true),// folded after investing $2920
  seat(4, 10, false, true),  // folded $10
], [
  // Total: 20+369+369+2920+10 = 3688
  // All dead money flows to non-folded players [1,2]. After merge: single pot.
  { amount: 3688, eligible: [1, 2] },
]);

console.log(`\n${fails === 0 ? 'ALL TESTS PASSED' : `${fails} TESTS FAILED`}`);
process.exit(fails > 0 ? 1 : 0);

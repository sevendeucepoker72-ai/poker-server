/**
 * All-in insurance (cashout) money math — 2026-07-05 completeness build.
 *
 * Locks the pricing (90% of equity share) and the post-hand settlement delta so
 * the insured player always ends with exactly the locked-in cashout, and the
 * house keeps a positive edge over time.
 *
 * Run: `npm test` from poker-server/.
 */
import { insuranceCashoutAmount, insuranceSettlementDelta } from '../src/game/insurance';

describe('insurance cashout pricing', () => {
  test('90% of the equity share of the pot', () => {
    expect(insuranceCashoutAmount(2000, 0.6)).toBe(1080); // round(2000*0.6*0.9)
    expect(insuranceCashoutAmount(1000, 1)).toBe(900);
    expect(insuranceCashoutAmount(1000, 0.5)).toBe(450);
  });

  test('degenerate inputs are safe', () => {
    expect(insuranceCashoutAmount(0, 0.5)).toBe(0);
    expect(insuranceCashoutAmount(1000, 0)).toBe(0);
    expect(insuranceCashoutAmount(1000, 2)).toBe(900);   // equity clamped to 1
    expect(insuranceCashoutAmount(-5, 0.5)).toBe(0);     // pot floored at 0
  });

  test('cashout never exceeds a fair equity payout (the house always has an edge)', () => {
    for (const pot of [500, 1234, 9999]) {
      for (const eq of [0.1, 0.33, 0.5, 0.75, 0.99]) {
        const c = insuranceCashoutAmount(pot, eq);
        expect(c).toBeLessThanOrEqual(Math.ceil(pot * eq));
      }
    }
  });
});

describe('insurance settlement delta', () => {
  test('outdrawn (won 0) → house pays the full cashout', () => {
    expect(insuranceSettlementDelta(1080, 0)).toBe(1080);
  });

  test('won the pot → house collects the margin, player keeps the cashout', () => {
    // Won 2000 but locked in 1080: adjust by -920 so the live stack becomes 1080.
    expect(insuranceSettlementDelta(1080, 2000)).toBe(-920);
  });

  test('the player ends with exactly the cashout regardless of the runout', () => {
    const cashout = 1080;
    for (const actualWon of [0, 500, 1080, 2000]) {
      // Model an all-in player: pre-pot stack 0, pot distribution added actualWon,
      // then the settlement delta is applied.
      const stackAfterPot = 0 + actualWon;
      const finalStack = stackAfterPot + insuranceSettlementDelta(cashout, actualWon);
      expect(finalStack).toBe(cashout);
    }
  });
});

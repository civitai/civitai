import { describe, it, expect } from 'vitest';
import { BUZZ_PER_USD_CENT, buzzAmountToUnitAmount } from '~/shared/utils/buzz-charge';

describe('buzzAmountToUnitAmount', () => {
  it('returns a whole number of cents for the fractional case that reached Stripe', () => {
    // 10,004 Buzz / 10 = 1000.4 — the live `Invalid integer: 1000.4` 500.
    expect(buzzAmountToUnitAmount(10_004)).toBe(1001);
  });

  it('returns a whole number of cents for the second live fractional case', () => {
    // 8,888 Buzz / 10 = 888.8 — the other event in the 7-day window.
    expect(buzzAmountToUnitAmount(8_888)).toBe(889);
  });

  it('ceils rather than rounds, so the buyer is never granted more Buzz than charged for', () => {
    // 1000.1 rounds DOWN to 1000 — 1 Buzz granted free. Ceil must give 1001.
    expect(buzzAmountToUnitAmount(10_001)).toBe(1001);
    // 1000.9 floors DOWN to 1000 for the same reason.
    expect(buzzAmountToUnitAmount(10_009)).toBe(1001);
  });

  it('leaves an amount that is already a whole number of cents untouched', () => {
    expect(buzzAmountToUnitAmount(10_000)).toBe(1000);
    expect(buzzAmountToUnitAmount(5_000)).toBe(500);
  });

  it('never returns a fraction for any Buzz amount in the purchasable range', () => {
    for (const buzzAmount of [1_000, 1_001, 1_009, 12_345, 99_999, 1_234_567]) {
      const unitAmount = buzzAmountToUnitAmount(buzzAmount);
      expect(Number.isInteger(unitAmount)).toBe(true);
    }
  });

  // Named for what it actually does. It asserts a LOCAL constant against a literal and
  // touches no server code — the server's `/ 10` in `getPaymentIntent` is an independent
  // literal, so this can neither detect nor locate a divergence between the two. That
  // relationship is pinned by
  // `src/server/services/__tests__/no-open-coded-buzz-cents.test.ts`, which reads the guard
  // out of the service source and compares it to this constant.
  it('pins the local Buzz-per-cent ratio constant', () => {
    expect(BUZZ_PER_USD_CENT).toBe(10);
  });
});

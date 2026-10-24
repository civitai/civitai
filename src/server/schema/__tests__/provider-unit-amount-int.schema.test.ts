import { describe, expect, it } from 'vitest';

import { createBuzzChargeSchema as coinbaseSchema } from '~/server/schema/coinbase.schema';
import { createBuzzChargeSchema as emerchantpaySchema } from '~/server/schema/emerchantpay.schema';
import { transactionCreateSchema as paddleSchema } from '~/server/schema/paddle.schema';
import { paymentIntentCreationSchema } from '~/server/schema/stripe.schema';

/**
 * Every provider route that receives the purchase form's derived `unitAmount` must refuse a
 * fractional minor unit, not just the Stripe one.
 *
 * This exists because the round-5 reasoning was wrong and got measured: the claim was that
 * `.int()` on the Stripe schema made an open-coded cents division a loud failure. It made it
 * loud on STRIPE. The same value is handed to `BuzzCoinbaseButton`, whose schema accepted
 * `1000.4`, whose service-side tamper check (`unitAmount !== buzzAmount / 10`) does NOT fire —
 * both values come from the same division, so a fractional pair is self-consistent — and which
 * forwarded the fraction to `createCharge` as `local_price.amount = "10.004"`, a sub-cent USD
 * price.
 *
 * The bound is asserted per provider rather than centrally on purpose: these are four separate
 * trust boundaries with four separate schemas, and a caller can reach any of them directly
 * without going through the purchase form at all.
 */

/** The exact shape the live 500 had: 10,004 Buzz / 10 = 1000.4 cents. */
const FRACTIONAL = 1000.4;
const WHOLE = 1000;

describe('every provider refuses a fractional minor unit', () => {
  it('stripe', () => {
    const base = {
      currency: 'USD',
      metadata: { type: 'buzzPurchase' as const, buzzAmount: 10_000, unitAmount: WHOLE, userId: 1 },
      recaptchaToken: 'token',
    };
    expect(paymentIntentCreationSchema.safeParse({ ...base, unitAmount: WHOLE }).success).toBe(
      true
    );
    const bad = paymentIntentCreationSchema.safeParse({ ...base, unitAmount: FRACTIONAL });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toContain('unitAmount');
  });

  it('coinbase', () => {
    // Positive control first: the whole amount must still pass, or the bound proves nothing.
    expect(coinbaseSchema.safeParse({ unitAmount: WHOLE, buzzAmount: 10_000 }).success).toBe(true);

    const bad = coinbaseSchema.safeParse({ unitAmount: FRACTIONAL, buzzAmount: 10_004 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toContain('unitAmount');
  });

  it('emerchantpay', () => {
    expect(emerchantpaySchema.safeParse({ unitAmount: WHOLE, buzzAmount: 10_000 }).success).toBe(
      true
    );

    const bad = emerchantpaySchema.safeParse({ unitAmount: FRACTIONAL, buzzAmount: 10_004 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toContain('unitAmount');
  });

  it('paddle', () => {
    // `recaptchaToken` is required; without it the positive control fails and the rejection
    // below would pass for the wrong reason — the schema refusing everything.
    const base = { recaptchaToken: 'token' };
    expect(paddleSchema.safeParse({ ...base, unitAmount: WHOLE }).success).toBe(true);

    const bad = paddleSchema.safeParse({ ...base, unitAmount: FRACTIONAL });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toContain('unitAmount');
  });

  it('the integer rule did not replace paddle existing bounds', () => {
    // Guards against a fix that swaps one constraint for another: both bounds must still bite.
    const base = { recaptchaToken: 'token' };
    expect(paddleSchema.safeParse({ ...base, unitAmount: 1 }).success).toBe(false);
    expect(paddleSchema.safeParse({ ...base, unitAmount: 100_000_000 }).success).toBe(false);
  });

  it('emerchantpay still rejects a non-positive whole amount', () => {
    expect(emerchantpaySchema.safeParse({ unitAmount: -100, buzzAmount: 1000 }).success).toBe(
      false
    );
  });
});

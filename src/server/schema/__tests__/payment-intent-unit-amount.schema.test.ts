import { describe, expect, it } from 'vitest';
import { paymentIntentCreationSchema } from '~/server/schema/stripe.schema';

/**
 * Stripe amounts are in the currency's MINOR unit and must be integers — `amount: 1000.4`
 * is rejected by the API with `Invalid integer: 1000.4`, which reached the client as a
 * tRPC INTERNAL_SERVER_ERROR / HTTP 500.
 *
 * A fraction gets here honestly. The buzz-purchase form derives the USD cents amount from
 * the Buzz amount by dividing by 10, so a Buzz amount that is not a multiple of 10 (e.g.
 * 10,004) yields 1000.4 cents. The service-side tamper guard compares `unitAmount` against
 * `metadata.buzzAmount / 10`, so the pair agrees and nothing between the form and Stripe
 * looked at whether the number was whole.
 *
 * This is the trust boundary — the router feeds this schema straight into
 * `getPaymentIntent` — so the integer requirement is pinned here, and a rejection here is a
 * tRPC BAD_REQUEST rather than a 500.
 */

const VALID = {
  unitAmount: 1000,
  currency: 'USD',
  metadata: {
    type: 'buzzPurchase' as const,
    buzzAmount: 10000,
    unitAmount: 1000,
    userId: 1,
  },
  recaptchaToken: 'token',
};

describe('paymentIntentCreationSchema — unitAmount must be a whole minor unit', () => {
  it('accepts a whole amount', () => {
    const result = paymentIntentCreationSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('rejects the fractional amount the Buzz-to-USD division produces', () => {
    // 10,004 Buzz / 10 = 1000.4 cents — the exact shape Stripe rejected in production.
    const result = paymentIntentCreationSchema.safeParse({
      ...VALID,
      unitAmount: 1000.4,
      metadata: { ...VALID.metadata, buzzAmount: 10004, unitAmount: 1000.4 },
    });

    expect(result.success).toBe(false);
    // Pin the field, not just the failure: an unrelated rule rejecting this input would
    // otherwise read as coverage.
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('unitAmount');
  });

  it('rejects a sub-cent fraction that rounds to the same integer', () => {
    // 1000.0001 is in range, is not a multiple-of-ten artifact, and still is not an
    // integer. Pinned separately so a fix that only rejects one decimal place fails.
    const result = paymentIntentCreationSchema.safeParse({
      ...VALID,
      unitAmount: 1000.0001,
      metadata: { ...VALID.metadata, buzzAmount: 10000.001, unitAmount: 1000.0001 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('unitAmount');
  });

  it('still rejects an out-of-range whole amount, so the integer rule did not replace the bounds', () => {
    const tooSmall = paymentIntentCreationSchema.safeParse({ ...VALID, unitAmount: 1 });
    const tooLarge = paymentIntentCreationSchema.safeParse({ ...VALID, unitAmount: 100_000_000 });

    expect(tooSmall.success).toBe(false);
    expect(tooLarge.success).toBe(false);
  });
});

/**
 * The second route by which a fraction can reach Stripe is
 * `createBuzzSessionSchema.customAmount`, handed over as `unit_amount: customAmount * 100`
 * (`stripe.service.ts`). It is NOT bounded here and it is NOT bounded anywhere: the schema
 * declares `.min()` only, so `customAmount: 500.004` parses, reaches
 * `checkout.sessions.create` as `unit_amount: 50000.4`, and comes back `Invalid integer` —
 * the same 500 this file exists to close, on a different route.
 *
 * It is left alone here because the whole path — schema, service, controller, tRPC procedure
 * and the client hook wrapper — is DELETED by #4955, which is split out of this change and
 * merges separately. Hardening a surface that is about to be removed would be wasted work.
 *
 * 🔴 So until #4955 lands, `stripe.createBuzzSession` remains an exposed, authenticated,
 * Stripe-calling procedure with an unbounded amount. If #4955 is closed unmerged rather than
 * merged, this route needs `.int()` and a `.max()` and that is not optional.
 */

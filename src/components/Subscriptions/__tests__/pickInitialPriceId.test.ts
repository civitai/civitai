import { describe, expect, it } from 'vitest';
import { pickInitialPriceId } from '~/components/Subscriptions/pickInitialPriceId';

/**
 * INVARIANT GUARD, not a regression test — `pickInitialPriceId` is new in this change, so
 * none of these could have been watched fail on pre-change code. The regression test for
 * this change is the server-side one in
 * `src/server/services/__tests__/stripe.createSubscribeSession.currency.test.ts`, which is
 * red at the base commit. These pin the selection rule so it cannot drift silently.
 *
 * What the rule is for: Stripe pins a customer to one billing currency on their first
 * invoice and it is immutable. The server substitutes the correct sibling price before it
 * calls Stripe either way, so a purchase succeeds regardless of what this returns — this
 * exists so the figure on the plan card is the figure that gets charged, which matters most
 * on the plan-change path where there is no Stripe-hosted confirmation screen.
 */

// Lower-case codes, as Stripe's API returns them and as our Stripe rows carry them.
const STRIPE_ROWS = [
  { id: 'gold_usd', currency: 'usd' },
  { id: 'gold_aud', currency: 'aud' },
  { id: 'gold_eur', currency: 'eur' },
];

// Upper-case codes, as the other payment provider's rows carry them. This component is
// provider-generic — `getPlans` takes the provider as an argument — so both spellings reach
// it, and a case-sensitive comparison silently matches nothing for one of the two catalogs.
const OTHER_PROVIDER_ROWS = [
  { id: 'gold_USD', currency: 'USD' },
  { id: 'gold_AUD', currency: 'AUD' },
];

describe('pickInitialPriceId — no pinned currency (behaviour before this change)', () => {
  it('returns the product default', () => {
    expect(pickInitialPriceId({ prices: STRIPE_ROWS, defaultPriceId: 'gold_usd' })).toBe(
      'gold_usd'
    );
  });

  it('falls back to USD when the default is not among the prices', () => {
    expect(pickInitialPriceId({ prices: STRIPE_ROWS, defaultPriceId: 'not_in_list' })).toBe(
      'gold_usd'
    );
  });

  it('falls back to the first price when there is no USD row either', () => {
    expect(
      pickInitialPriceId({
        prices: [{ id: 'gold_jpy', currency: 'jpy' }, ...STRIPE_ROWS.slice(1)],
        defaultPriceId: 'not_in_list',
      })
    ).toBe('gold_jpy');
  });

  it('returns null rather than throwing on an empty price list', () => {
    expect(pickInitialPriceId({ prices: [], defaultPriceId: 'gold_usd' })).toBeNull();
  });
});

describe('pickInitialPriceId — pinned currency', () => {
  it('preselects the sibling in the pinned currency instead of the USD default', () => {
    expect(
      pickInitialPriceId({
        prices: STRIPE_ROWS,
        defaultPriceId: 'gold_usd',
        pinnedCurrency: 'aud',
      })
    ).toBe('gold_aud');
  });

  it('keeps the default when the default is already in the pinned currency', () => {
    // Exact-id match wins over a currency search, so a card showing the plan the member
    // already holds keeps that member's own price rather than some other row in the same
    // currency. Two USD rows here so the two rules can disagree.
    expect(
      pickInitialPriceId({
        prices: [{ id: 'gold_usd_legacy', currency: 'usd' }, ...STRIPE_ROWS],
        defaultPriceId: 'gold_usd',
        pinnedCurrency: 'usd',
      })
    ).toBe('gold_usd');
  });

  it('falls back to the default when the plan is not sold in the pinned currency', () => {
    // The server raises a typed error in this case; the card still has to render something.
    expect(
      pickInitialPriceId({
        prices: STRIPE_ROWS,
        defaultPriceId: 'gold_usd',
        pinnedCurrency: 'krw',
      })
    ).toBe('gold_usd');
  });

  it('ignores an empty-string pinned currency rather than treating it as a filter', () => {
    expect(
      pickInitialPriceId({ prices: STRIPE_ROWS, defaultPriceId: 'gold_usd', pinnedCurrency: '' })
    ).toBe('gold_usd');
  });
});

describe('pickInitialPriceId — currency case is normalised on both sides', () => {
  it('matches an upper-case pin against lower-case price rows', () => {
    expect(
      pickInitialPriceId({
        prices: STRIPE_ROWS,
        defaultPriceId: 'gold_usd',
        pinnedCurrency: 'AUD',
      })
    ).toBe('gold_aud');
  });

  it('matches a lower-case pin against upper-case price rows', () => {
    expect(
      pickInitialPriceId({
        prices: OTHER_PROVIDER_ROWS,
        defaultPriceId: 'gold_USD',
        pinnedCurrency: 'aud',
      })
    ).toBe('gold_AUD');
  });

  it('treats the default as already payable when only its case differs from the pin', () => {
    // Without normalisation on the default-price branch, this falls through to the currency
    // search and can return a different row — the mutation that a single-sided test misses.
    expect(
      pickInitialPriceId({
        prices: [{ id: 'gold_usd_other', currency: 'usd' }, ...OTHER_PROVIDER_ROWS],
        defaultPriceId: 'gold_USD',
        pinnedCurrency: 'usd',
      })
    ).toBe('gold_USD');
  });
});

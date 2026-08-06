import { describe, expect, it } from 'vitest';
import {
  BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE,
  getBuzzMembershipPrice,
  getSubscriptionDisplayBuzzType,
} from '~/shared/utils/buzz-membership';
import { getBuzzCurrencyConfig } from '~/shared/constants/currency.constants';
import { buzzAccountTypes } from '~/shared/constants/buzz.constants';
import {
  purchaseMembershipWithBuzzSchema,
  subscriptionProductMetadataSchema,
} from '~/server/schema/subscriptions.schema';

describe('getBuzzMembershipPrice', () => {
  it('charges a 25% premium over the cash price', () => {
    expect(getBuzzMembershipPrice({ unitAmount: 1000 })).toBe(12_500);
    expect(getBuzzMembershipPrice({ unitAmount: 5000 })).toBe(62_500);
  });

  it('prefers an explicit metadata price', () => {
    expect(getBuzzMembershipPrice({ unitAmount: 1000, buzzPrice: 20_000 })).toBe(20_000);
  });

  it('falls back to the derived price when the override is absent or zero', () => {
    expect(getBuzzMembershipPrice({ unitAmount: 1000, buzzPrice: 0 })).toBe(12_500);
    expect(getBuzzMembershipPrice({ unitAmount: 1000, buzzPrice: null })).toBe(12_500);
  });

  it('rounds to a whole Buzz amount', () => {
    expect(Number.isInteger(getBuzzMembershipPrice({ unitAmount: 333 }))).toBe(true);
  });

  it('prices the live Civitai tiers at the numbers the spec called for', () => {
    expect(getBuzzMembershipPrice({ unitAmount: 1000 })).toBe(12_500); // bronze $10
    expect(getBuzzMembershipPrice({ unitAmount: 2500 })).toBe(31_250); // silver $25
    expect(getBuzzMembershipPrice({ unitAmount: 5000 })).toBe(62_500); // gold $50
  });
});

describe('purchaseMembershipWithBuzzSchema', () => {
  const priceId = 'civitai-buzz-gold-monthly';

  // The debited account is the domain's currency, resolved server-side from ctx.features.
  // Accepting it as input would let a crafted request spend the other colour, so the
  // input must carry nothing but the price.
  it('takes the price and nothing else', () => {
    const parsed = purchaseMembershipWithBuzzSchema.parse({ priceId });
    expect(parsed).toEqual({ priceId });
  });

  it('ignores a client-supplied currency instead of honouring it', () => {
    const parsed = purchaseMembershipWithBuzzSchema.parse({ priceId, buzzType: 'yellow' });
    expect(parsed).not.toHaveProperty('buzzType');
  });
});

describe('BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE', () => {
  // It's a CustomerSubscription slot discriminator, not a currency. Colliding with a
  // real account type would put Buzz memberships in a paid membership's unique slot.
  it('is not a Buzz account type', () => {
    expect(buzzAccountTypes).not.toContain(BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE);
  });

  it('does not collide with the referral slot', () => {
    expect(BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE).not.toBe('referral');
  });
});

// The seed script (scripts/oneoffs/seed-buzz-membership-products.sql) builds product
// metadata by copying the live cash product and overriding the money-side keys. These
// are the exact blobs that SQL produces, captured by running its SELECT against the
// replica. If the schema stops accepting them — or stops reading them the way the plan
// card and the purchase guard expect — the seeded catalog is wrong and this fails.
const SEEDED_PRODUCT_METADATA = {
  bronze: {
    tier: 'bronze',
    type: 'subscription',
    badge: '87a4e5c6-c7d9-4d40-97f2-4ed1842e5521',
    level: '1',
    steps: '60',
    badgeType: 'none',
    resources: '8',
    queueLimit: '8',
    vaultSizeKb: '104857600',
    buzzPurchase: true,
    quantityLimit: '8',
    rewardsMultiplier: 1,
    purchasesMultiplier: 1,
  },
  silver: {
    tier: 'silver',
    badge: '2fe60e72-e960-403c-b558-9f58bd82e638',
    level: '2',
    steps: '60',
    badgeType: 'none',
    resources: '12',
    queueLimit: '10',
    vaultSizeKb: '262144000',
    buzzPurchase: true,
    quantityLimit: '10',
    rewardsMultiplier: 1,
    purchasesMultiplier: 1,
  },
  gold: {
    tier: 'gold',
    badge: '78c46ee0-5d9a-4b58-9fc9-57b7ea3bc80d',
    level: '3',
    steps: '60',
    badgeType: 'none',
    resources: '12',
    queueLimit: '10',
    vaultSizeKb: '524288000',
    buzzPurchase: true,
    quantityLimit: '12',
    rewardsMultiplier: 1,
    purchasesMultiplier: 1,
  },
} as const;

describe('seeded Buzz membership product metadata', () => {
  const cashPrice = { bronze: 1000, silver: 2500, gold: 5000 } as const;

  for (const [tier, raw] of Object.entries(SEEDED_PRODUCT_METADATA)) {
    describe(tier, () => {
      const meta = subscriptionProductMetadataSchema.parse(raw);

      it('is a Buzz-purchase product on a real tier', () => {
        expect(meta.buzzPurchase).toBe(true);
        expect(meta.tier).toBe(tier);
      });

      it('grants no Buzz of any kind', () => {
        expect(raw).not.toHaveProperty('monthlyBuzz');
        expect(meta.purchasesMultiplier).toBe(1);
        expect(meta.rewardsMultiplier).toBe(1);
      });

      // deliverMonthlyCosmetics and the token-unlock cron both require monthlyBuzz to be
      // present, so dropping it keeps both off these rows — no monthly Buzz, no badge.
      // deliverMonthlyCosmetics also excludes buzzPurchase products outright.
      it('earns no monthly badge', () => {
        expect(meta.badgeType).toBe('none');
        expect(raw).not.toHaveProperty('monthlyBuzz');
      });

      it('carries the perks copied from the cash tier', () => {
        expect(meta.badge).toBeTruthy();
        expect(meta.vaultSizeKb).toBeGreaterThan(0);
        expect(meta.queueLimit).toBeGreaterThan(0);
        expect(meta.quantityLimit).toBeGreaterThan(0);
      });

      // The script strips buzzType so one catalog serves both sites: getPlans skips its
      // colour filter for buzzPurchase products, and a leftover colour would read as a
      // display hint these memberships don't earn.
      it('carries no site colour', () => {
        expect(raw).not.toHaveProperty('buzzType');
      });

      it('prices at the cash tier plus the premium', () => {
        expect(
          getBuzzMembershipPrice({
            unitAmount: cashPrice[tier as keyof typeof cashPrice],
            buzzPrice: meta.buzzPrice,
          })
        ).toBe(Math.round((cashPrice[tier as keyof typeof cashPrice] / 100) * 1000 * 1.25));
      });
    });
  }
});

describe('getSubscriptionDisplayBuzzType', () => {
  // CustomerSubscription.buzzType is a currency for ordinary rows and a kind-discriminator
  // for others. Feeding a discriminator to the currency theme lookup returned undefined and
  // crashed the account page on `config.icon`.
  it('passes real currencies through', () => {
    expect(getSubscriptionDisplayBuzzType('green', 'yellow')).toBe('green');
    expect(getSubscriptionDisplayBuzzType('yellow', 'green')).toBe('yellow');
  });

  it('falls back for kind-discriminator slots', () => {
    expect(getSubscriptionDisplayBuzzType(BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE, 'green')).toBe(
      'green'
    );
    expect(getSubscriptionDisplayBuzzType('referral', 'yellow')).toBe('yellow');
    expect(getSubscriptionDisplayBuzzType(null, 'green')).toBe('green');
    expect(getSubscriptionDisplayBuzzType(undefined, 'yellow')).toBe('yellow');
  });

  it('always yields a type the currency theme lookup can resolve', () => {
    for (const raw of [BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE, 'referral', 'nonsense', null]) {
      const config = getBuzzCurrencyConfig(getSubscriptionDisplayBuzzType(raw, 'green'));
      expect(config?.icon).toBeDefined();
    }
  });
});

describe('getBuzzCurrencyConfig', () => {
  it('never returns undefined, even for a non-currency string', () => {
    // Belt and braces for the crash above: any caller that still passes the raw column
    // gets a usable theme instead of a TypeError.
    expect(getBuzzCurrencyConfig('buzzPurchase' as never)?.icon).toBeDefined();
    expect(getBuzzCurrencyConfig('referral' as never)?.icon).toBeDefined();
  });
});

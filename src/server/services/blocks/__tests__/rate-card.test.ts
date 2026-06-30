import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RATE_CARD,
  computeRateCardSplit,
  computeSpendShare,
  computeSubscriptionShare,
  RATE_CARD_V1,
  RATE_CARD_V2,
  RATE_CARD_V3,
  RATE_CARD_V4,
  RATE_CARD_V5,
  type RateCard,
} from '../rate-card';

/**
 * Rate-card math tests. The CHECK constraint on block_buzz_attribution
 * enforces `provider_fee + platform_share + app_owner_share = gross`
 * at the DB layer — these tests assert the same invariant at the
 * service layer, plus the self-purchase / internal-owner overrides.
 */
describe('computeRateCardSplit', () => {
  // A fixed rate card so the tests don't break when the live card's
  // percentages get adjusted by leadership sign-off. The live values
  // are exercised in the "active rate card" suite below.
  const fixedCard: RateCard = {
    version: 'test',
    publisherSharePctByScope: {
      per_model_install: 20,
      publisher_all_my_models: 20,
      viewer_personal: 25,
      platform_default: 0,
      viewer_global: 0,
    },
    spendSharePct: 10,
    subscriptionSharePct: 0,
    internalAppOwnerUserIds: [42],
    effectiveFrom: '2026-01-01',
  };

  it('splits a clean per-model-install purchase per the rate card', () => {
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      scope: 'per_model_install',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    // net = 1000 - 50 = 950. 20% of 950 = 190. Platform gets 760.
    expect(split.providerFeeCents).toBe(50);
    expect(split.appOwnerShareCents).toBe(190);
    expect(split.platformShareCents).toBe(760);
    // Invariant: sum equals gross (matches the SQL CHECK constraint).
    expect(
      split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
    ).toBe(1000);
    expect(split.rateCardVersion).toBe('test');
  });

  it('rewards viewer_personal with the higher share', () => {
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      scope: 'viewer_personal',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    // net = 950, 25% of 950 = 237 (Math.floor)
    expect(split.appOwnerShareCents).toBe(237);
    expect(split.platformShareCents).toBe(713);
  });

  it('zeroes publisher share for platform_default', () => {
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      scope: 'platform_default',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(950);
  });

  it('zeroes publisher share on self-purchase regardless of scope', () => {
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      scope: 'viewer_personal',
      isSelfPurchase: true,
      appOwnerUserId: 99,
    });
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(950);
  });

  it('zeroes publisher share when the owner is on the internal allowlist', () => {
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      scope: 'per_model_install',
      isSelfPurchase: false,
      appOwnerUserId: 42, // in internalAppOwnerUserIds
    });
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(950);
  });

  it('floors fractional cents so the publisher never overcollects', () => {
    // gross 999, fee 0, scope viewer_personal (25%): 999 * 0.25 = 249.75
    // → publisher gets 249, platform absorbs the 0.75c remainder.
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 999,
      providerFeeCents: 0,
      scope: 'viewer_personal',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.appOwnerShareCents).toBe(249);
    expect(split.platformShareCents).toBe(750);
    expect(split.appOwnerShareCents + split.platformShareCents).toBe(999);
  });

  it('clamps a negative gross to zero rather than emitting a CHECK violation', () => {
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: -10,
      providerFeeCents: 0,
      scope: 'per_model_install',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.providerFeeCents).toBe(0);
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(0);
  });

  it('clamps a provider fee that exceeds gross', () => {
    // Some refund/dispute flows can land here. Publisher gets nothing,
    // platform absorbs the loss.
    const split = computeRateCardSplit({
      rateCard: fixedCard,
      grossCents: 100,
      providerFeeCents: 500,
      scope: 'per_model_install',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.providerFeeCents).toBe(100);
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(0);
    expect(
      split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
    ).toBe(100);
  });

  it('rounds fractional percentages safely on the active rate card', () => {
    // Doesn't matter what the live numbers are — the invariant must
    // hold for every scope.
    const grossCents = 1234;
    const providerFeeCents = 50;
    for (const scope of [
      'per_model_install',
      'publisher_all_my_models',
      'viewer_personal',
      'platform_default',
      'viewer_global',
    ] as const) {
      const split = computeRateCardSplit({
        grossCents,
        providerFeeCents,
        scope,
        isSelfPurchase: false,
        appOwnerUserId: 1,
      });
      expect(
        split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
      ).toBe(grossCents);
      expect(split.appOwnerShareCents).toBeGreaterThanOrEqual(0);
      expect(split.platformShareCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('defaults to ACTIVE_RATE_CARD (now V5) when no rateCard is passed', () => {
    const split = computeRateCardSplit({
      grossCents: 1000,
      providerFeeCents: 0,
      scope: 'per_model_install',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.rateCardVersion).toBe(ACTIVE_RATE_CARD.version);
    expect(split.rateCardVersion).toBe(RATE_CARD_V5.version);
    expect(ACTIVE_RATE_CARD).toBe(RATE_CARD_V5);
    // V5 carries V4's purchase percentages unchanged (the subscription
    // dimension is the only addition), so per_model_install is still 15%.
    expect(split.appOwnerShareCents).toBe(150);
  });

  // --- W3 flow B: viewer_global (page purchase) at 0% ---------------------

  it('viewer_global pays the publisher 0% — platform keeps net, conservation holds', () => {
    const split = computeRateCardSplit({
      grossCents: 1000,
      providerFeeCents: 50,
      scope: 'viewer_global',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    // net = 950, viewer_global @ 0% → publisher 0, platform 950.
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(950);
    expect(split.providerFeeCents).toBe(50);
    // Conservation: fee + platform + author == gross (the SQL CHECK).
    expect(
      split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
    ).toBe(1000);
  });

  it('viewer_global on the ACTIVE card (V5) also pays 0% with conservation', () => {
    const split = computeRateCardSplit({
      grossCents: 4999,
      providerFeeCents: 217,
      scope: 'viewer_global',
      isSelfPurchase: false,
      appOwnerUserId: 7,
    });
    expect(split.rateCardVersion).toBe('v5');
    expect(split.appOwnerShareCents).toBe(0);
    expect(
      split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
    ).toBe(4999);
  });

  // --- Immutability: every card carries its stamped percentages ----------

  it('V3 carries V2 percentages verbatim and adds viewer_global at 0%', () => {
    expect(RATE_CARD_V3.version).toBe('v3');
    expect(RATE_CARD_V3.publisherSharePctByScope.per_model_install).toBe(
      RATE_CARD_V2.publisherSharePctByScope.per_model_install
    );
    expect(RATE_CARD_V3.publisherSharePctByScope.publisher_all_my_models).toBe(
      RATE_CARD_V2.publisherSharePctByScope.publisher_all_my_models
    );
    expect(RATE_CARD_V3.publisherSharePctByScope.viewer_personal).toBe(
      RATE_CARD_V2.publisherSharePctByScope.viewer_personal
    );
    expect(RATE_CARD_V3.publisherSharePctByScope.platform_default).toBe(
      RATE_CARD_V2.publisherSharePctByScope.platform_default
    );
    // The new scope is the only addition, at 0%.
    expect(RATE_CARD_V3.publisherSharePctByScope.viewer_global).toBe(0);
    // Sanity on the actual V2 numbers (15/15/25/0) so a future edit to V2
    // can't silently drift V3's "carried" values.
    expect(RATE_CARD_V2.publisherSharePctByScope.per_model_install).toBe(15);
    expect(RATE_CARD_V2.publisherSharePctByScope.publisher_all_my_models).toBe(15);
    expect(RATE_CARD_V2.publisherSharePctByScope.viewer_personal).toBe(25);
    expect(RATE_CARD_V2.publisherSharePctByScope.platform_default).toBe(0);
  });

  it('V1/V2 keep their stamped values (immutable) + viewer_global at 0%', () => {
    expect(RATE_CARD_V1.version).toBe('v1');
    expect(RATE_CARD_V1.publisherSharePctByScope).toMatchObject({
      per_model_install: 20,
      publisher_all_my_models: 20,
      viewer_personal: 25,
      platform_default: 0,
      viewer_global: 0,
    });
    expect(RATE_CARD_V2.version).toBe('v2');
    expect(RATE_CARD_V2.publisherSharePctByScope).toMatchObject({
      per_model_install: 15,
      publisher_all_my_models: 15,
      viewer_personal: 25,
      platform_default: 0,
      viewer_global: 0,
    });
  });

  it('a row stamped under V2 still pays V2 percentages (past rows pay under their version)', () => {
    // Backward-compat: an old model-slot purchase computed against V2 must
    // still pay viewer_personal @ 25%, regardless of ACTIVE_RATE_CARD moving
    // to V3.
    const split = computeRateCardSplit({
      rateCard: RATE_CARD_V2,
      grossCents: 1000,
      providerFeeCents: 0,
      scope: 'viewer_personal',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.rateCardVersion).toBe('v2');
    expect(split.appOwnerShareCents).toBe(250);
    expect(split.platformShareCents).toBe(750);
  });
});

/**
 * W3 flow A — buzz SPEND author-bounty math. The bounty is a
 * platform-funded percentage of the spend's USD value, NOT a split of a
 * pool. The invariants asserted here mirror the migration's CHECKs:
 *   - share >= 0, share <= gross
 *   - share = floor(gross * pct / 100)
 *   - self-spend / internal-owner -> 0
 */
describe('computeSpendShare', () => {
  // Fixed 10% card so the test is stable when the live placeholder moves.
  const fixedCard: RateCard = {
    version: 'spend-test',
    publisherSharePctByScope: {
      per_model_install: 0,
      publisher_all_my_models: 0,
      viewer_personal: 0,
      platform_default: 0,
      viewer_global: 0,
    },
    spendSharePct: 10,
    subscriptionSharePct: 0,
    internalAppOwnerUserIds: [42],
    effectiveFrom: '2026-01-01',
  };

  it('pays the placeholder spend rate of the gross USD value, floored', () => {
    // 1234 cents gross @ 10% = 123.4 -> 123 (platform absorbs the .4).
    const res = computeSpendShare({
      rateCard: fixedCard,
      grossValueCents: 1234,
      isSelfSpend: false,
      appOwnerUserId: 1,
    });
    expect(res.rateCardVersion).toBe('spend-test');
    expect(res.spendSharePct).toBe(10);
    expect(res.appOwnerShareCents).toBe(123);
    // Invariant: 0 <= share <= gross.
    expect(res.appOwnerShareCents).toBeGreaterThanOrEqual(0);
    expect(res.appOwnerShareCents).toBeLessThanOrEqual(1234);
    // Invariant: share == floor(gross * pct / 100).
    expect(res.appOwnerShareCents).toBe(Math.floor((1234 * 10) / 100));
  });

  it('zeroes the bounty on self-spend (author generating in own app)', () => {
    const res = computeSpendShare({
      rateCard: fixedCard,
      grossValueCents: 1000,
      isSelfSpend: true,
      appOwnerUserId: 7,
    });
    expect(res.appOwnerShareCents).toBe(0);
    expect(res.spendSharePct).toBe(0);
  });

  it('zeroes the bounty for an internal civitai-owned app', () => {
    const res = computeSpendShare({
      rateCard: fixedCard,
      grossValueCents: 1000,
      isSelfSpend: false,
      appOwnerUserId: 42, // ∈ internalAppOwnerUserIds
    });
    expect(res.appOwnerShareCents).toBe(0);
    expect(res.spendSharePct).toBe(0);
  });

  it('clamps a never-exceed-gross ceiling even with a runaway rate', () => {
    const runaway: RateCard = { ...fixedCard, spendSharePct: 250 };
    const res = computeSpendShare({
      rateCard: runaway,
      grossValueCents: 100,
      isSelfSpend: false,
      appOwnerUserId: 1,
    });
    // 100 * 250% = 250, clamped to gross (100) — a bounty can never exceed
    // the revenue it rewards (matches the migration's share_le_gross CHECK).
    expect(res.appOwnerShareCents).toBe(100);
    expect(res.appOwnerShareCents).toBeLessThanOrEqual(100);
  });

  it('floors a negative/garbage gross to 0', () => {
    const res = computeSpendShare({
      rateCard: fixedCard,
      grossValueCents: -500,
      isSelfSpend: false,
      appOwnerUserId: 1,
    });
    expect(res.appOwnerShareCents).toBe(0);
  });

  it('V5 is the active card; V4/V5 carry the placeholder spend rate', () => {
    expect(ACTIVE_RATE_CARD.version).toBe('v5');
    expect(ACTIVE_RATE_CARD).toBe(RATE_CARD_V5);
    // The spend placeholder (non-zero, conservative) was introduced in V4
    // and carried into V5 verbatim. If this number changes, it's a
    // deliberate sign-off decision — update the test alongside the new card.
    expect(RATE_CARD_V4.spendSharePct).toBe(5);
    expect(RATE_CARD_V5.spendSharePct).toBe(5);
    expect(ACTIVE_RATE_CARD.spendSharePct).toBeGreaterThan(0);
    // Purchase percentages carried from V3 unchanged through V4 and V5.
    expect(RATE_CARD_V4.publisherSharePctByScope).toEqual(
      RATE_CARD_V3.publisherSharePctByScope
    );
    expect(RATE_CARD_V5.publisherSharePctByScope).toEqual(
      RATE_CARD_V4.publisherSharePctByScope
    );
  });

  it('older cards (V1-V3) carry a 0% spend rate (spend is net-new in V4)', () => {
    expect(RATE_CARD_V1.spendSharePct).toBe(0);
    expect(RATE_CARD_V2.spendSharePct).toBe(0);
    expect(RATE_CARD_V3.spendSharePct).toBe(0);
  });

  // ---------------------------------------------------------------
  // PAYOUT-SAFETY GATE (App Blocks Sybil / payout review). Block currencies
  // were widened to on-site parity (blue/green/yellow); the bounty must only
  // accrue on PURCHASED/EARNED Buzz (yellow), never on free/granted Buzz
  // (blue/green), so the widening can never become platform-funded farming.
  // ---------------------------------------------------------------
  describe('payout-eligibility by buzzType', () => {
    it('defaults to yellow (legacy/pre-parity) → pays the bounty (behavior-preserving)', () => {
      const res = computeSpendShare({
        rateCard: fixedCard,
        grossValueCents: 1000,
        isSelfSpend: false,
        appOwnerUserId: 1,
        // buzzType omitted → defaults to 'yellow'
      });
      expect(res.spendSharePct).toBe(10);
      expect(res.appOwnerShareCents).toBe(100);
    });

    it('yellow (purchased/earned) → pays the bounty', () => {
      const res = computeSpendShare({
        rateCard: fixedCard,
        grossValueCents: 1000,
        isSelfSpend: false,
        appOwnerUserId: 1,
        buzzType: 'yellow',
      });
      expect(res.spendSharePct).toBe(10);
      expect(res.appOwnerShareCents).toBe(100);
    });

    it('blue (free generation Buzz) → ZERO bounty (excluded)', () => {
      const res = computeSpendShare({
        rateCard: fixedCard,
        grossValueCents: 1000,
        isSelfSpend: false,
        appOwnerUserId: 1,
        buzzType: 'blue',
      });
      expect(res.spendSharePct).toBe(0);
      expect(res.appOwnerShareCents).toBe(0);
    });

    it('green (includes free/granted daily Buzz) → ZERO bounty (excluded)', () => {
      const res = computeSpendShare({
        rateCard: fixedCard,
        grossValueCents: 1000,
        isSelfSpend: false,
        appOwnerUserId: 1,
        buzzType: 'green',
      });
      expect(res.spendSharePct).toBe(0);
      expect(res.appOwnerShareCents).toBe(0);
    });

    it('unknown / garbage buzzType → ZERO bounty (fail-closed)', () => {
      const res = computeSpendShare({
        rateCard: fixedCard,
        grossValueCents: 1000,
        isSelfSpend: false,
        appOwnerUserId: 1,
        buzzType: 'totally-bogus',
      });
      expect(res.spendSharePct).toBe(0);
      expect(res.appOwnerShareCents).toBe(0);
    });

    it('the gate is independent of self-spend / internal (any one zeroes the bounty)', () => {
      // yellow + self-spend still 0 (self-spend wash dominates).
      expect(
        computeSpendShare({
          rateCard: fixedCard,
          grossValueCents: 1000,
          isSelfSpend: true,
          appOwnerUserId: 1,
          buzzType: 'yellow',
        }).appOwnerShareCents
      ).toBe(0);
      // blue + non-self / non-internal still 0 (payout-gate dominates).
      expect(
        computeSpendShare({
          rateCard: fixedCard,
          grossValueCents: 1000,
          isSelfSpend: false,
          appOwnerUserId: 1,
          buzzType: 'blue',
        }).appOwnerShareCents
      ).toBe(0);
    });
  });
});

/**
 * W3 flow C — MEMBERSHIP / subscription rev-share math. A membership
 * payment is a real card transaction split THREE ways (NOT the
 * platform-funded bounty model of spend), so the invariants mirror
 * computeRateCardSplit's:
 *   - fee + platform + author = gross (the SQL CHECK, entry_type='charge')
 *   - self-purchase / internal-owner -> author 0
 *   - floor so the platform absorbs the sub-cent remainder
 */
describe('computeSubscriptionShare', () => {
  // Fixed 20% card so the test is stable when the live placeholder moves.
  const fixedCard: RateCard = {
    version: 'sub-test',
    publisherSharePctByScope: {
      per_model_install: 0,
      publisher_all_my_models: 0,
      viewer_personal: 0,
      platform_default: 0,
      viewer_global: 0,
    },
    spendSharePct: 0,
    subscriptionSharePct: 20,
    internalAppOwnerUserIds: [42],
    effectiveFrom: '2026-01-01',
  };

  it('splits a clean membership invoice three ways, conservation holds', () => {
    const split = computeSubscriptionShare({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    // net = 950, 20% of 950 = 190, platform 760.
    expect(split.providerFeeCents).toBe(50);
    expect(split.appOwnerShareCents).toBe(190);
    expect(split.platformShareCents).toBe(760);
    expect(split.subscriptionSharePct).toBe(20);
    expect(
      split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
    ).toBe(1000);
    expect(split.rateCardVersion).toBe('sub-test');
  });

  it('zeroes author share on self-purchase (subscriber == owner)', () => {
    const split = computeSubscriptionShare({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      isSelfPurchase: true,
      appOwnerUserId: 99,
    });
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.subscriptionSharePct).toBe(0);
    expect(split.platformShareCents).toBe(950);
  });

  it('zeroes author share for an internal civitai-owned app', () => {
    const split = computeSubscriptionShare({
      rateCard: fixedCard,
      grossCents: 1000,
      providerFeeCents: 50,
      isSelfPurchase: false,
      appOwnerUserId: 42, // ∈ internalAppOwnerUserIds
    });
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.subscriptionSharePct).toBe(0);
  });

  it('floors fractional cents so the author never overcollects', () => {
    // gross 999, fee 0, 20% → 199.8 → 199, platform absorbs the .8c.
    const split = computeSubscriptionShare({
      rateCard: fixedCard,
      grossCents: 999,
      providerFeeCents: 0,
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.appOwnerShareCents).toBe(199);
    expect(split.platformShareCents).toBe(800);
    expect(split.appOwnerShareCents + split.platformShareCents).toBe(999);
  });

  it('clamps a provider fee that exceeds gross', () => {
    const split = computeSubscriptionShare({
      rateCard: fixedCard,
      grossCents: 100,
      providerFeeCents: 500,
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.providerFeeCents).toBe(100);
    expect(split.appOwnerShareCents).toBe(0);
    expect(split.platformShareCents).toBe(0);
    expect(
      split.providerFeeCents + split.platformShareCents + split.appOwnerShareCents
    ).toBe(100);
  });

  it('V5 is the active card and carries the placeholder subscription rate', () => {
    expect(ACTIVE_RATE_CARD.version).toBe('v5');
    expect(RATE_CARD_V5.subscriptionSharePct).toBe(15);
    expect(RATE_CARD_V5.subscriptionSharePct).toBeGreaterThan(0);
    const split = computeSubscriptionShare({
      grossCents: 1000,
      providerFeeCents: 0,
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.rateCardVersion).toBe('v5');
    // 15% of 1000 = 150.
    expect(split.appOwnerShareCents).toBe(150);
    expect(split.platformShareCents).toBe(850);
  });

  it('older cards (V1-V4) carry a 0% subscription rate (flow C is net-new in V5)', () => {
    expect(RATE_CARD_V1.subscriptionSharePct).toBe(0);
    expect(RATE_CARD_V2.subscriptionSharePct).toBe(0);
    expect(RATE_CARD_V3.subscriptionSharePct).toBe(0);
    expect(RATE_CARD_V4.subscriptionSharePct).toBe(0);
  });

  it('V5 carries V4 verbatim (purchase + spend) and only adds the subscription rate', () => {
    // Immutability: V5 must not silently drift V4's stamped values.
    expect(RATE_CARD_V5.publisherSharePctByScope).toEqual(
      RATE_CARD_V4.publisherSharePctByScope
    );
    expect(RATE_CARD_V5.spendSharePct).toBe(RATE_CARD_V4.spendSharePct);
    // Sanity on the carried V4 numbers (15/15/25/0/0, spend 5) so a future
    // edit to V4 can't silently change V5's "carried" assertion.
    expect(RATE_CARD_V4.publisherSharePctByScope).toMatchObject({
      per_model_install: 15,
      publisher_all_my_models: 15,
      viewer_personal: 25,
      platform_default: 0,
      viewer_global: 0,
    });
    expect(RATE_CARD_V4.spendSharePct).toBe(5);
    // The subscription rate is the ONLY thing V5 changes.
    expect(RATE_CARD_V5.subscriptionSharePct).toBe(15);
    expect(RATE_CARD_V4.subscriptionSharePct).toBe(0);
  });

  it('a row stamped under V5 pays V5 rates forever (immutability)', () => {
    const split = computeSubscriptionShare({
      rateCard: RATE_CARD_V5,
      grossCents: 2000,
      providerFeeCents: 0,
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.rateCardVersion).toBe('v5');
    expect(split.subscriptionSharePct).toBe(15);
    expect(split.appOwnerShareCents).toBe(300);
  });
});

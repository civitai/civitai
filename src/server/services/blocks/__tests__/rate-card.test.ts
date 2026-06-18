import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RATE_CARD,
  computeRateCardSplit,
  computeSpendShare,
  RATE_CARD_V1,
  RATE_CARD_V2,
  RATE_CARD_V3,
  RATE_CARD_V4,
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

  it('defaults to ACTIVE_RATE_CARD (now V4) when no rateCard is passed', () => {
    const split = computeRateCardSplit({
      grossCents: 1000,
      providerFeeCents: 0,
      scope: 'per_model_install',
      isSelfPurchase: false,
      appOwnerUserId: 1,
    });
    expect(split.rateCardVersion).toBe(ACTIVE_RATE_CARD.version);
    expect(split.rateCardVersion).toBe(RATE_CARD_V4.version);
    expect(ACTIVE_RATE_CARD).toBe(RATE_CARD_V4);
    // V4 carries V3's purchase percentages unchanged (the spend dimension
    // is the only addition), so per_model_install is still 15%.
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

  it('viewer_global on the ACTIVE card (V4) also pays 0% with conservation', () => {
    const split = computeRateCardSplit({
      grossCents: 4999,
      providerFeeCents: 217,
      scope: 'viewer_global',
      isSelfPurchase: false,
      appOwnerUserId: 7,
    });
    expect(split.rateCardVersion).toBe('v4');
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

  it('V4 is the active card and carries the placeholder spend rate', () => {
    expect(ACTIVE_RATE_CARD.version).toBe('v4');
    expect(ACTIVE_RATE_CARD).toBe(RATE_CARD_V4);
    // The placeholder is non-zero (the spend flow pays something) but
    // conservative. If this number changes, it's a deliberate sign-off
    // decision — update the test alongside the new card.
    expect(RATE_CARD_V4.spendSharePct).toBe(5);
    expect(RATE_CARD_V4.spendSharePct).toBeGreaterThan(0);
    // Purchase percentages carried from V3 unchanged.
    expect(RATE_CARD_V4.publisherSharePctByScope).toEqual(
      RATE_CARD_V3.publisherSharePctByScope
    );
  });

  it('older cards (V1-V3) carry a 0% spend rate (spend is net-new in V4)', () => {
    expect(RATE_CARD_V1.spendSharePct).toBe(0);
    expect(RATE_CARD_V2.spendSharePct).toBe(0);
    expect(RATE_CARD_V3.spendSharePct).toBe(0);
  });
});

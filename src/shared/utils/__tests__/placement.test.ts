import { describe, expect, it } from 'vitest';
import type { PlacementOutcome, PlacementStatus } from '~/shared/utils/placement';
import {
  clampDeclineFeeRate,
  declineFeeAmount,
  effectivePlacementPrice,
  isPlacementSurface,
  MAX_DECLINE_FEE_RATE,
  MIN_DECLINE_FEE_RATE,
  PLACEMENT_SURFACES,
  placementOutcomeFromStatus,
  placementPriceCap,
  placementSurfaces,
  placementTransactionId,
  resolvePlacementSpace,
  splitPlacementPayment,
} from '~/shared/utils/placement';

const OUTCOMES: PlacementOutcome[] = [
  'approved',
  'declined',
  'expired',
  'removedByOwner',
  'removedByModerator',
];

// Boundaries plus the awkward middles. 0 and 1 are included deliberately: the
// rate is operator-configurable, so the invariant has to hold at values nobody
// intends to ship, not just at the 30% default.
const RATES = [0, 0.001, 0.05, 0.1, 0.3, 0.333333, 0.5, 0.7, 0.999, 1];
// Small amounts are where conservation actually breaks — three components each
// rounding down is how a sum drifts away from its input.
const AMOUNTS = [0, 1, 2, 3, 7, 19, 20, 49, 50, 99, 100, 101, 333, 1_000, 123_457];

describe('splitPlacementPayment — the Buzz-conservation invariant', () => {
  it('never pays out more than the placer spent, at any configured rate', () => {
    for (const amount of AMOUNTS)
      for (const outcome of OUTCOMES)
        for (const declineFeeRate of RATES)
          for (const sellerShare of RATES)
            for (const platformShare of RATES) {
              if (sellerShare + platformShare > 1) continue;

              const split = splitPlacementPayment({
                amount,
                outcome,
                declineFeeRate,
                sellerShare,
                platformShare,
              });
              const paidOut = split.toOwner + split.toSeller + split.toPlatform + split.toPlacer;
              const label = `${outcome} amount=${amount} decline=${declineFeeRate} seller=${sellerShare} platform=${platformShare}`;

              expect(paidOut, `paid out ${paidOut} for ${amount} — ${label}`).toBe(amount);
              for (const [part, value] of Object.entries(split))
                expect(
                  Number.isSafeInteger(value) && value >= 0,
                  `${part}=${value} — ${label}`
                ).toBe(true);
            }
  });

  it('refuses out-of-range input rather than clamping it', () => {
    const valid = {
      amount: 100,
      outcome: 'approved' as const,
      declineFeeRate: 0.3,
      sellerShare: 0.3,
      platformShare: 0.3,
    };

    expect(() => splitPlacementPayment({ ...valid, amount: 10.5 })).toThrow();
    expect(() => splitPlacementPayment({ ...valid, amount: -1 })).toThrow();
    expect(() => splitPlacementPayment({ ...valid, declineFeeRate: 1.5 })).toThrow();
    expect(() => splitPlacementPayment({ ...valid, sellerShare: -0.1 })).toThrow();
    // Over-allocating an approved placement is the shape that would mint Buzz.
    expect(() =>
      splitPlacementPayment({ ...valid, sellerShare: 0.7, platformShare: 0.7 })
    ).toThrow();
  });

  it('pays the owner the rounding dust on approval', () => {
    const split = splitPlacementPayment({
      amount: 101,
      outcome: 'approved',
      declineFeeRate: 0.3,
      sellerShare: 0.333333,
      platformShare: 0.333333,
    });

    expect(split.toSeller).toBe(33);
    expect(split.toPlatform).toBe(33);
    expect(split.toOwner).toBe(35);
    expect(split.toPlacer).toBe(0);
  });

  it('returns everything on expiry and on owner removal of an auto-approved placement', () => {
    for (const outcome of ['expired', 'removedByOwner'] as const) {
      const split = splitPlacementPayment({
        amount: 250,
        outcome,
        declineFeeRate: MAX_DECLINE_FEE_RATE,
        sellerShare: 0.3,
        platformShare: 0.3,
      });
      expect(split).toEqual({ toOwner: 0, toSeller: 0, toPlatform: 0, toPlacer: 250 });
    }
  });

  it('forfeits a moderator removal instead of paying the owner', () => {
    const split = splitPlacementPayment({
      amount: 250,
      outcome: 'removedByModerator',
      declineFeeRate: 0.3,
      sellerShare: 0.3,
      platformShare: 0.3,
    });
    expect(split).toEqual({ toOwner: 0, toSeller: 0, toPlatform: 250, toPlacer: 0 });
  });
});

describe('settling a stored placement', () => {
  // `status` comes back from a schemaless TEXT column, so the failure mode to
  // close is a value that isn't in the union reaching the split and falling off
  // the end of the switch as `undefined` — which pays nobody, silently.
  it('refuses an outcome it does not recognise instead of returning undefined', () => {
    const call = () =>
      splitPlacementPayment({
        amount: 100,
        outcome: 'removed' as unknown as PlacementOutcome,
        declineFeeRate: 0.3,
        sellerShare: 0.3,
        platformShare: 0.3,
      });

    expect(call).toThrow(/unknown outcome/);
  });

  it('resolves a removal only when it knows who removed it', () => {
    expect(placementOutcomeFromStatus('removed', 'owner')).toBe('removedByOwner');
    expect(placementOutcomeFromStatus('removed', 'moderator')).toBe('removedByModerator');
    expect(() => placementOutcomeFromStatus('removed', null)).toThrow(/who removed it/);
    expect(() => placementOutcomeFromStatus('removed')).toThrow(/who removed it/);
  });

  it('maps the unambiguous statuses and refuses the ones that settle nothing', () => {
    expect(placementOutcomeFromStatus('approved')).toBe('approved');
    expect(placementOutcomeFromStatus('declined')).toBe('declined');
    expect(placementOutcomeFromStatus('expired')).toBe('expired');
    expect(() => placementOutcomeFromStatus('pending')).toThrow(/no settled outcome/);
    expect(() => placementOutcomeFromStatus('nonsense' as PlacementStatus)).toThrow(
      /unknown status/
    );
  });

  // The two removals pay opposite amounts, which is the whole reason the actor
  // is stored rather than inferred.
  it('pays opposite amounts for the two removals', () => {
    const settle = (removedBy: 'owner' | 'moderator') =>
      splitPlacementPayment({
        amount: 500,
        outcome: placementOutcomeFromStatus('removed', removedBy),
        declineFeeRate: 0.3,
        sellerShare: 0.3,
        platformShare: 0.3,
      });

    expect(settle('owner').toPlacer).toBe(500);
    expect(settle('moderator').toPlacer).toBe(0);
  });
});

describe('the transaction ledger', () => {
  // Both escrow precedents build `…-${Date.now()}` prefixes, so a retry presents
  // a different id and walks past the Buzz service's dedupe — which the challenge
  // payouts rely on deliberately. Row-derived is the rule, not the preference.
  it('derives the external id from the row, never from the clock', () => {
    expect(placementTransactionId(42, 'holdFee')).toBe('placement-42-holdFee');
    expect(placementTransactionId(42, 'holdFee')).toBe(placementTransactionId(42, 'holdFee'));
    expect(placementTransactionId(42, 'holdFee')).not.toBe(placementTransactionId(42, 'toOwner'));
    expect(placementTransactionId(42, 'toOwner')).not.toBe(placementTransactionId(43, 'toOwner'));
    expect(placementTransactionId(42, 'holdFee')).not.toMatch(/\d{10,}$/);
  });

  it('splits the escrow so the fee is never taken from the principal', () => {
    for (const amount of AMOUNTS) {
      const fee = declineFeeAmount(amount, 0.3);
      const principal = amount - fee;

      expect(fee + principal).toBe(amount);
      expect(principal).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('declineFeeAmount', () => {
  it('never rounds a non-zero rate away to nothing', () => {
    // 5% of 19 floors to 0; a free decline defeats the whole point of the fee.
    expect(declineFeeAmount(19, MIN_DECLINE_FEE_RATE)).toBe(1);
    expect(declineFeeAmount(1, MIN_DECLINE_FEE_RATE)).toBe(1);
    expect(declineFeeAmount(20, MIN_DECLINE_FEE_RATE)).toBe(1);
  });

  it('never exceeds the amount', () => {
    expect(declineFeeAmount(1, 1)).toBe(1);
    expect(declineFeeAmount(0, 1)).toBe(0);
  });

  it('is zero only when the rate is', () => {
    expect(declineFeeAmount(100, 0)).toBe(0);
  });
});

describe('clampDeclineFeeRate', () => {
  it('holds the floor and the ceiling', () => {
    expect(clampDeclineFeeRate(0, 0.3)).toBe(MIN_DECLINE_FEE_RATE);
    expect(clampDeclineFeeRate(-1, 0.3)).toBe(MIN_DECLINE_FEE_RATE);
    expect(clampDeclineFeeRate(1, 0.3)).toBe(MAX_DECLINE_FEE_RATE);
    expect(clampDeclineFeeRate(0.3, 0.3)).toBe(0.3);
  });

  it('falls back when the stored value is unusable', () => {
    expect(clampDeclineFeeRate(null, 0.3)).toBe(0.3);
    expect(clampDeclineFeeRate(undefined, 0.3)).toBe(0.3);
    expect(clampDeclineFeeRate(Number.NaN, 0.3)).toBe(0.3);
    expect(clampDeclineFeeRate('30%' as unknown as number, 0.3)).toBe(0.3);
  });
});

describe('pricing', () => {
  it('caps by score band and tier', () => {
    expect(placementPriceCap(0, 'free')).toBe(100);
    expect(placementPriceCap(4_999, 'gold')).toBe(500);
    expect(placementPriceCap(5_000, 'gold')).toBe(1_000);
    expect(placementPriceCap(1_000_000, 'free')).toBe(1_000);
  });

  it('treats a missing or negative score as the bottom band', () => {
    expect(placementPriceCap(-50_000, 'silver')).toBe(placementPriceCap(0, 'silver'));
    expect(placementPriceCap(Number.NaN, 'silver')).toBe(placementPriceCap(0, 'silver'));
  });

  it('never lets a set price exceed the cap', () => {
    expect(effectivePlacementPrice(10_000, 500)).toBe(500);
    expect(effectivePlacementPrice(250, 500)).toBe(250);
    expect(effectivePlacementPrice(-5, 500)).toBe(0);
  });

  // Defaulting an unpriced space to its ceiling would charge the maximum for a
  // space whose owner never named a price.
  it('reports an unset price as unset rather than as the cap', () => {
    expect(effectivePlacementPrice(null, 500)).toBeNull();
  });
});

describe('space resolution', () => {
  const mode = (m: 'off' | 'review' | 'auto', price: number | null = null) => ({ mode: m, price });

  it('resolves image over post over account', () => {
    expect(
      resolvePlacementSpace('sticker', {
        image: mode('auto'),
        post: mode('off'),
        user: mode('review'),
      }).mode
    ).toBe('auto');
    expect(resolvePlacementSpace('sticker', { post: mode('off'), user: mode('review') }).mode).toBe(
      'off'
    );
    expect(resolvePlacementSpace('sticker', { user: mode('review') }).mode).toBe('review');
  });

  it('falls back to the surface default when nothing is configured', () => {
    expect(resolvePlacementSpace('sticker', {}).mode).toBe(PLACEMENT_SURFACES.sticker.defaultMode);
  });

  it('keeps an account-level price when only the image mode was changed', () => {
    const resolved = resolvePlacementSpace('sticker', {
      image: mode('auto'),
      user: mode('off', 250),
    });
    expect(resolved).toEqual({ mode: 'auto', price: 250 });
  });
});

describe('the surface table', () => {
  it('denies anything not listed', () => {
    expect(isPlacementSurface('sticker')).toBe(true);
    expect(isPlacementSurface('remixGallery')).toBe(true);
    expect(isPlacementSurface('comment')).toBe(false);
    expect(isPlacementSurface('')).toBe(false);
  });

  // Equality, not containment, so a third surface has to come here and be given
  // a decline rate and an expiry rather than silently inheriting someone else's.
  it('is exactly the two surfaces this foundation was built for', () => {
    expect([...placementSurfaces].sort()).toEqual(['remixGallery', 'sticker']);
  });

  it('gives every surface a usable decline rate and expiry', () => {
    for (const surface of placementSurfaces) {
      const config = PLACEMENT_SURFACES[surface];
      expect(config.defaultDeclineFeeRate).toBeGreaterThanOrEqual(MIN_DECLINE_FEE_RATE);
      expect(config.defaultDeclineFeeRate).toBeLessThanOrEqual(MAX_DECLINE_FEE_RATE);
      expect(config.expiryHours).toBeGreaterThan(0);
    }
  });
});

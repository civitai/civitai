import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_TRIAL_LIMIT,
  acceptsBlueBuzz,
  buildModelVersionTerms,
  migrateTermsForUsageControl,
  generationOpenToNonBuyers,
  generationPrice,
  generationTrialLimit,
  grantsGeneration,
  isFreeGeneration,
  isPaidAccessActive,
  isTimedGateActive,
  paidGenerationGrant,
  paidAccessBlockedFor,
  licensingFeeBlockedFor,
  separateGenerationPriceMissing,
  CAP_TIERS,
  nextCapTier,
  type ModelVersionTerms,
} from './paid-access';
import {
  monthlyPricingAllowance,
  shouldUpsellAllowance,
  tierAllowanceRows,
} from './pricing-allowance';
import {
  MAX_LICENSING_FEE,
  feeToRatio,
  VIDEO_CAP_MULTIPLIER,
  maxLicensingFeeCeiling,
  suggestedFeePerImage,
} from './licensing-fee';
import { capMediaType } from './media-type';

const NOW = new Date('2026-07-28T00:00:00.000Z');
const PAST = new Date('2026-07-27T00:00:00.000Z');
const FUTURE = new Date('2026-07-29T00:00:00.000Z');

describe('isPaidAccessActive / isTimedGateActive — the endsAt boundary', () => {
  it('permanent gate (endsAt null): active, but NOT timed-active', () => {
    expect(isPaidAccessActive({ endsAt: null }, NOW)).toBe(true);
    expect(isTimedGateActive({ endsAt: null }, NOW)).toBe(false);
  });
  it('future window: both active and timed-active', () => {
    expect(isPaidAccessActive({ endsAt: FUTURE }, NOW)).toBe(true);
    expect(isTimedGateActive({ endsAt: FUTURE }, NOW)).toBe(true);
  });
  it('past window (tombstone): neither', () => {
    expect(isPaidAccessActive({ endsAt: PAST }, NOW)).toBe(false);
    expect(isTimedGateActive({ endsAt: PAST }, NOW)).toBe(false);
  });
  it('endsAt exactly now is expired (strict >)', () => {
    expect(isPaidAccessActive({ endsAt: NOW }, NOW)).toBe(false);
    expect(isTimedGateActive({ endsAt: NOW }, NOW)).toBe(false);
  });
});

describe('generation terms predicates', () => {
  const free: ModelVersionTerms = { generation: { free: true } };
  const bundled: ModelVersionTerms = { download: { price: 500 } }; // no generation key = must buy
  const paidGen: ModelVersionTerms = {
    download: { price: 500 },
    generation: { price: 200, trialLimit: 5 },
  };
  const paidGenNoTrial: ModelVersionTerms = { generation: { price: 200, trialLimit: 0 } };
  const paidGenAbsentTrial: ModelVersionTerms = { generation: { price: 200 } };

  it('isFreeGeneration only for { free: true }', () => {
    expect(isFreeGeneration(free)).toBe(true);
    expect(isFreeGeneration(bundled)).toBe(false);
    expect(isFreeGeneration(paidGen)).toBe(false);
  });

  it('paidGenerationGrant: the paid tier, or undefined for free/bundled', () => {
    expect(paidGenerationGrant(paidGen)).toEqual({ price: 200, trialLimit: 5 });
    expect(paidGenerationGrant(free)).toBeUndefined();
    expect(paidGenerationGrant(bundled)).toBeUndefined();
  });

  it('generationTrialLimit: explicit value, 0, or the default for an absent trialLimit', () => {
    expect(generationTrialLimit(paidGen)).toBe(5);
    expect(generationTrialLimit(paidGenNoTrial)).toBe(0);
    expect(generationTrialLimit(paidGenAbsentTrial)).toBe(DEFAULT_GENERATION_TRIAL_LIMIT);
    expect(generationTrialLimit(bundled)).toBe(0); // no paid gen tier
    expect(generationTrialLimit(free)).toBe(0); // free is not a "trial"
  });

  it('generationOpenToNonBuyers: free OR a positive trial limit', () => {
    expect(generationOpenToNonBuyers(free)).toBe(true);
    expect(generationOpenToNonBuyers(paidGen)).toBe(true); // trialLimit 5
    expect(generationOpenToNonBuyers(paidGenAbsentTrial)).toBe(true); // defaults to 10
    expect(generationOpenToNonBuyers(paidGenNoTrial)).toBe(false); // trialLimit 0
    expect(generationOpenToNonBuyers(bundled)).toBe(false); // must buy
  });
});

describe('generationPrice — effective generation-only purchase price', () => {
  it('uses the generation tier price when set', () => {
    expect(generationPrice({ download: { price: 500 }, generation: { price: 200 } })).toBe(200);
  });
  it('falls back to the download price when the generation grant omits price', () => {
    expect(generationPrice({ download: { price: 500 }, generation: { trialLimit: 5 } })).toBe(500);
  });
  it('undefined when there is no paid generation tier (free or bundled)', () => {
    expect(generationPrice({ generation: { free: true } })).toBeUndefined();
    expect(generationPrice({ download: { price: 500 } })).toBeUndefined();
  });
});

describe('model-level monetization policy', () => {
  it('refuses a gate on a POI model, and on a private one', () => {
    expect(paidAccessBlockedFor({ poi: true, availability: 'Public' })).toBe(true);
    expect(paidAccessBlockedFor({ poi: false, availability: 'Private' })).toBe(true);
  });
  it('allows a gate on an ordinary public model', () => {
    expect(paidAccessBlockedFor({ poi: false, availability: 'Public' })).toBe(false);
  });
  // The asymmetry is deliberate: a private model has no audience to sell access to, but its fee is for
  // when it is published. A POI model earns nothing either way.
  it('refuses a licensing fee on a POI model but keeps it on a private one', () => {
    expect(licensingFeeBlockedFor({ poi: true, availability: 'Public' })).toBe(true);
    expect(licensingFeeBlockedFor({ poi: false, availability: 'Private' })).toBe(false);
  });
  // Rows arrive from two apps and two ORMs; an absent column must not read as permission granted by
  // accident, nor as a block that strands every save.
  it('treats missing fields as unblocked rather than guessing', () => {
    expect(paidAccessBlockedFor({})).toBe(false);
    expect(licensingFeeBlockedFor({ poi: null })).toBe(false);
  });
});

describe('separateGenerationPriceMissing — the blank "cheaper price" box', () => {
  it('a stated price is not missing', () => {
    expect(separateGenerationPriceMissing(200)).toBe(false);
  });
  it.each([
    ['undefined', undefined],
    ['null', null],
    // Defensive: the form's zod schema rejects NaN before the guard runs, and its number input maps a
    // cleared box to undefined. Kept so the predicate is total for callers without that schema.
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -50],
  ])('%s is missing', (_label, value) => {
    expect(separateGenerationPriceMissing(value as number | null | undefined)).toBe(true);
  });
  it('what an unrefused blank costs the buyer: the FULL download price', () => {
    const blank = buildModelVersionTerms({ accessPrice: 500, generationPrice: undefined });
    expect(generationPrice(blank)).toBe(500);
  });
});

describe('grantsGeneration — the full access decision', () => {
  const bundled: ModelVersionTerms = { download: { price: 500 } };
  const trial: ModelVersionTerms = {
    download: { price: 500 },
    generation: { price: 200, trialLimit: 5 },
  };
  const free: ModelVersionTerms = { generation: { free: true } };

  it('owner/mod always may generate, even on a bundled must-buy gate', () => {
    expect(grantsGeneration(bundled, { isOwnerOrMod: true, hasBought: false })).toBe(true);
  });
  it('a buyer may generate on a bundled gate', () => {
    expect(grantsGeneration(bundled, { isOwnerOrMod: false, hasBought: true })).toBe(true);
  });
  it('a non-owner non-buyer is BLOCKED on a bundled must-buy gate', () => {
    expect(grantsGeneration(bundled, { isOwnerOrMod: false, hasBought: false })).toBe(false);
  });
  it('a non-owner non-buyer may generate when the gate offers a trial', () => {
    expect(grantsGeneration(trial, { isOwnerOrMod: false, hasBought: false })).toBe(true);
  });
  it('free generation is open to everyone', () => {
    expect(grantsGeneration(free, { isOwnerOrMod: false, hasBought: false })).toBe(true);
  });
});

describe('buildModelVersionTerms — the three generation grants', () => {
  it('bundles generation with the download when no generation price is given', () => {
    expect(buildModelVersionTerms({ accessPrice: 500, freePreviewGenerations: 10 })).toEqual({
      download: { price: 500 },
      generation: { trialLimit: 10 },
    });
  });

  it('writes a cheaper generation-only tier when a price is given', () => {
    expect(
      buildModelVersionTerms({ accessPrice: 500, generationPrice: 200, freePreviewGenerations: 10 })
    ).toEqual({ download: { price: 500 }, generation: { price: 200, trialLimit: 10 } });
  });

  // The point of the free grant: gate the download, leave generation open, earn per generation via a
  // licensing fee instead. It carries no price and no trial limit — there is nothing to sample toward.
  it('writes a free generation grant, dropping price and trial limit', () => {
    const terms = buildModelVersionTerms({
      accessPrice: 500,
      generationPrice: 200,
      freePreviewGenerations: 1000,
      freeGeneration: true,
    });
    expect(terms).toEqual({ download: { price: 500 }, generation: { free: true } });
    expect(isFreeGeneration(terms)).toBe(true);
    expect(paidGenerationGrant(terms)).toBeUndefined();
    expect(generationPrice(terms)).toBeUndefined();
    expect(grantsGeneration(terms, { isOwnerOrMod: false, hasBought: false })).toBe(true);
  });

  // A gen-only version has no download tier, so generation IS what's being sold — free would leave
  // nothing to charge for, and assertPaidAccessInput rejects that shape.
  it('ignores freeGeneration for a generation-only version', () => {
    expect(
      buildModelVersionTerms({
        accessPrice: 500,
        freePreviewGenerations: 10,
        genOnly: true,
        freeGeneration: true,
      })
    ).toEqual({ generation: { price: 500, trialLimit: 10 } });
  });
});

describe('acceptsBlueBuzz — an extra accepted currency, not a second price', () => {
  it('is absent by default and set only when opted in', () => {
    const base = { accessPrice: 500, freePreviewGenerations: 10 };
    expect(buildModelVersionTerms(base)).not.toHaveProperty('acceptsBlueBuzz');
    expect(acceptsBlueBuzz(buildModelVersionTerms(base))).toBe(false);
    expect(buildModelVersionTerms({ ...base, acceptsBlueBuzz: true })).toEqual({
      acceptsBlueBuzz: true,
      download: { price: 500 },
      generation: { trialLimit: 10 },
    });
  });

  it('leaves the prices alone — blue and the domain currency cost the same', () => {
    const withBlue = buildModelVersionTerms({
      accessPrice: 500,
      generationPrice: 200,
      freePreviewGenerations: 10,
      acceptsBlueBuzz: true,
    });
    expect(withBlue.download?.price).toBe(500);
    expect(generationPrice(withBlue)).toBe(200);
  });

  it.each([
    ['gen-only', { accessPrice: 500, genOnly: true }],
    ['free generation', { accessPrice: 500, freeGeneration: true }],
  ])('survives the %s shape', (_label, opts) => {
    expect(acceptsBlueBuzz(buildModelVersionTerms({ ...opts, acceptsBlueBuzz: true }))).toBe(true);
  });

  it('survives a usage-control migration', () => {
    const terms = buildModelVersionTerms({ accessPrice: 5000, acceptsBlueBuzz: true });
    expect(acceptsBlueBuzz(migrateTermsForUsageControl(terms, true))).toBe(true);
  });
});

describe('video pricing — the fee ceiling is 5x on a video model', () => {
  it('multiplies the licensing-fee ceiling', () => {
    expect(maxLicensingFeeCeiling('video')).toBe(
      maxLicensingFeeCeiling('image') * VIDEO_CAP_MULTIPLIER
    );
    expect(maxLicensingFeeCeiling('video')).toBe(500);
    expect(maxLicensingFeeCeiling('image')).toBe(MAX_LICENSING_FEE);
  });

  it('multiplies the suggested default, so a new video model is not seeded too low', () => {
    expect(suggestedFeePerImage('Checkpoint', 'video')).toBe(
      suggestedFeePerImage('Checkpoint') * VIDEO_CAP_MULTIPLIER
    );
    expect(suggestedFeePerImage('LORA', 'video')).toBeCloseTo(
      suggestedFeePerImage('LORA') * VIDEO_CAP_MULTIPLIER,
      5
    );
  });

  it('does NOT multiply the monthly allowance — it counts prices, it does not size them', () => {
    expect(monthlyPricingAllowance('free')).toBe(3);
    expect(tierAllowanceRows().find((r) => r.tier === 'free')?.monthlyPrices).toBe(3);
  });
});

describe('monthlyPricingAllowance — what membership actually governs', () => {
  it('rises with the tier and is unlimited at gold', () => {
    expect(monthlyPricingAllowance('free')).toBe(3);
    expect(monthlyPricingAllowance('bronze')).toBe(10);
    expect(monthlyPricingAllowance('silver')).toBe(25);
    expect(monthlyPricingAllowance('gold')).toBe(Infinity);
  });

  it('charges the legacy founder tier as bronze', () => {
    expect(monthlyPricingAllowance('founder')).toBe(monthlyPricingAllowance('bronze'));
  });

  it('falls back to the FREE allowance for an unknown or lapsed tier, never to zero', () => {
    // Losing a membership must never take away the ability to price anything at all.
    expect(monthlyPricingAllowance(null)).toBe(3);
    expect(monthlyPricingAllowance(undefined)).toBe(3);
    expect(monthlyPricingAllowance('platinum')).toBe(3);
  });

  it('reports unlimited as null for display, so it survives a JSON boundary', () => {
    expect(tierAllowanceRows().find((r) => r.tier === 'gold')?.monthlyPrices).toBeNull();
    expect(tierAllowanceRows().map((r) => r.tier)).toEqual([...CAP_TIERS]);
  });
});

describe('capMediaType — which column a base model lands in', () => {
  it('resolves a video ecosystem to video', () => {
    expect(capMediaType('Hunyuan Video')).toBe('video');
    expect(capMediaType('LTXV')).toBe('video');
  });

  it('resolves an image ecosystem to image', () => {
    expect(capMediaType('SDXL 1.0')).toBe('image');
    expect(capMediaType('Flux.1 D')).toBe('image');
  });

  it('falls back to image for anything unmatched — a miss must never widen a ceiling', () => {
    expect(capMediaType(undefined)).toBe('image');
    expect(capMediaType(null)).toBe('image');
    expect(capMediaType('')).toBe('image');
    expect(capMediaType('Other')).toBe('image');
    expect(capMediaType('not-a-real-base-model')).toBe('image');
  });
});

// The caps table renders each ceiling through feeToRatio, so a cap that can't be expressed as whole Buzz
// over 1 or 10 generations would render as an unusable ratio the editor can't accept.
it('the licensing ceiling is a whole number of Buzz over 1 or 10 generations', () => {
  for (const mediaType of ['image', 'video'] as const) {
    const { buzz, images } = feeToRatio(maxLicensingFeeCeiling(mediaType));
    expect([1, 10]).toContain(images);
    expect(Number.isInteger(buzz)).toBe(true);
  }
});

describe('shouldUpsellAllowance — nudge only when the limit is actually in the way', () => {
  it('offers an upgrade once the creator reaches 80% of their allowance', () => {
    expect(shouldUpsellAllowance({ used: 7, limit: 10, tier: 'free' })).toBe(false);
    expect(shouldUpsellAllowance({ used: 8, limit: 10, tier: 'free' })).toBe(true);
    expect(shouldUpsellAllowance({ used: 10, limit: 10, tier: 'free' })).toBe(true);
  });

  it('stays quiet with plenty of headroom', () => {
    expect(shouldUpsellAllowance({ used: null, limit: 10, tier: 'free' })).toBe(false);
    expect(shouldUpsellAllowance({ used: 0, limit: 10, tier: 'free' })).toBe(false);
    expect(shouldUpsellAllowance({ used: 1, limit: 10, tier: 'free' })).toBe(false);
  });

  it('never upsells gold — there is nothing above it', () => {
    expect(shouldUpsellAllowance({ used: 100, limit: 10, tier: 'gold' })).toBe(false);
    expect(nextCapTier('gold')).toBeNull();
  });

  // Normalising a raw tier string (founder, unknown, lapsed) is resolveCapTier's job and is tested there;
  // nextCapTier takes the canonical tier that produces, so it only has to walk the ladder.
  it('walks one step up the ladder', () => {
    expect(nextCapTier('free')).toBe('bronze');
    expect(nextCapTier('bronze')).toBe('silver');
    expect(nextCapTier('silver')).toBe('gold');
  });

  it('never upsells against an unlimited or zero limit', () => {
    expect(shouldUpsellAllowance({ used: 99999, limit: Infinity, tier: 'silver' })).toBe(false);
    expect(shouldUpsellAllowance({ used: 0, limit: 0, tier: 'free' })).toBe(false);
    expect(shouldUpsellAllowance({ used: 5, limit: 0, tier: 'free' })).toBe(false);
  });
});

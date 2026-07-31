import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_TRIAL_LIMIT,
  buildModelVersionTerms,
  generationOpenToNonBuyers,
  generationPrice,
  generationTrialLimit,
  grantsGeneration,
  isFreeGeneration,
  isPaidAccessActive,
  isTimedGateActive,
  paidGenerationGrant,
  CAP_TIERS,
  nextCapTier,
  shouldUpsellCap,
  cappedTerms,
  maxPaidAccessPrice,
  maxPermanentAccessModels,
  tierCapRows,
  type ModelVersionTerms,
} from './paid-access';
import {
  MAX_LICENSING_FEE,
  feeToRatio,
  VIDEO_CAP_MULTIPLIER,
  effectiveLicensingFee,
  maxLicensingFee,
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

describe('video pricing — every ceiling is 5x on a video model', () => {
  it('multiplies the licensing-fee cap for each tier and model type', () => {
    for (const tier of CAP_TIERS) {
      for (const modelType of ['Checkpoint', 'LORA']) {
        expect(maxLicensingFee(tier, modelType, 'video')).toBe(
          maxLicensingFee(tier, modelType, 'image') * VIDEO_CAP_MULTIPLIER
        );
      }
    }
  });

  it('multiplies the paid-access price cap, leaving gold unlimited', () => {
    expect(maxPaidAccessPrice('free', 'video')).toBe(maxPaidAccessPrice('free') * 5);
    expect(maxPaidAccessPrice('silver', 'video')).toBe(maxPaidAccessPrice('silver') * 5);
    expect(maxPaidAccessPrice('gold', 'video')).toBe(Infinity);
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

  it('does NOT multiply the permanent-gate allowance — it counts gates, it does not price them', () => {
    expect(maxPermanentAccessModels('free')).toBe(3);
    expect(tierCapRows().find((r) => r.tier === 'free')?.permanentGates).toBe(3);
  });

  it('gold video is no longer clamped by the image ceiling', () => {
    // The whole point of raising the ceiling: 5 x 100 must survive rather than saturating at 100.
    expect(maxLicensingFee('gold', 'Checkpoint', 'video')).toBe(500);
    expect(maxLicensingFeeCeiling('video')).toBe(500);
    expect(maxLicensingFeeCeiling('image')).toBe(MAX_LICENSING_FEE);
  });

  it('clamps a stored fee against the video cap, not the image one', () => {
    expect(effectiveLicensingFee(20, 'free', 'Checkpoint', 'image')).toBe(1);
    expect(effectiveLicensingFee(20, 'free', 'Checkpoint', 'video')).toBe(5);
  });

  it('prices gate terms against the video cap', () => {
    const terms = { download: { price: 5000 } };
    expect(cappedTerms(terms, 'free', 'image')).toEqual({ download: { price: 500 } });
    expect(cappedTerms(terms, 'free', 'video')).toEqual({ download: { price: 2500 } });
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
it('every licensing cap is a whole number of Buzz over 1 or 10 generations', () => {
  for (const tier of CAP_TIERS)
    for (const mediaType of ['image', 'video'] as const)
      for (const modelType of ['Checkpoint', 'LORA']) {
        const { buzz, images } = feeToRatio(maxLicensingFee(tier, modelType, mediaType));
        expect([1, 10]).toContain(images);
        expect(Number.isInteger(buzz)).toBe(true);
      }
});

describe('shouldUpsellCap — nudge only when the ceiling is actually in the way', () => {
  it('offers an upgrade once the value reaches 80% of the cap', () => {
    expect(shouldUpsellCap({ value: 79, cap: 100, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 80, cap: 100, tier: 'free' })).toBe(true);
    expect(shouldUpsellCap({ value: 100, cap: 100, tier: 'free' })).toBe(true);
  });

  it('stays quiet for an empty or comfortably-low value', () => {
    expect(shouldUpsellCap({ value: null, cap: 100, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 0, cap: 100, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 10, cap: 100, tier: 'free' })).toBe(false);
  });

  it('never upsells gold — there is nothing above it', () => {
    expect(shouldUpsellCap({ value: 100, cap: 100, tier: 'gold' })).toBe(false);
    expect(nextCapTier('gold')).toBeNull();
  });

  it('treats founder as bronze, so it upgrades to silver', () => {
    expect(nextCapTier('founder')).toBe('silver');
    expect(nextCapTier('bronze')).toBe('silver');
  });

  it('an unknown or lapsed tier prices as free, so the next step is bronze', () => {
    expect(nextCapTier(null)).toBe('bronze');
    expect(nextCapTier('free')).toBe('bronze');
  });

  // 99999 >= Infinity * 0.8 is false by arithmetic, so an Infinity case would pass even without the
  // guard. cap: 0 is the one that actually pins it — reachable via maxFeeBuzzForRatio at the free/other
  // cap of 0.1 with a denominator of 1, where floor() yields 0.
  it('never upsells against an unlimited or zero cap', () => {
    expect(shouldUpsellCap({ value: 99999, cap: Infinity, tier: 'silver' })).toBe(false);
    expect(shouldUpsellCap({ value: 0, cap: 0, tier: 'free' })).toBe(false);
    expect(shouldUpsellCap({ value: 5, cap: 0, tier: 'free' })).toBe(false);
  });
});

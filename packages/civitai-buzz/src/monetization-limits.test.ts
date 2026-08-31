import { describe, expect, it } from 'vitest';
import { maxFeeBuzzForRatio } from './licensing-fee';
import {
  feeMaxFor,
  monetizationLimits,
  resolveCapTier,
  seedFeeRatio,
  suggestedFee,
  suggestedFeeRatio,
} from './monetization-limits';
import { maxLicensingFeeCeiling, SUGGESTED_FEE_PER_IMAGE } from './licensing-fee';

describe('resolveCapTier — the one tier rule, shared by both apps', () => {
  it('a member gets their own tier', () => {
    expect(resolveCapTier({ tier: 'silver', isMember: true })).toBe('silver');
    expect(resolveCapTier({ tier: 'gold', isMember: true })).toBe('gold');
  });

  it('founder is a legacy paid tier priced as bronze', () => {
    expect(resolveCapTier({ tier: 'founder', isMember: true })).toBe('bronze');
  });

  it('a lapsed member falls back to free, never to "no access"', () => {
    expect(resolveCapTier({ tier: 'gold', isMember: false })).toBe('free');
  });

  it('always returns a real tier — never null, so callers drop the ?? free fallback', () => {
    expect(resolveCapTier({ tier: null, isMember: false })).toBe('free');
    expect(resolveCapTier({ tier: null, isMember: true })).toBe('free');
    expect(resolveCapTier({ tier: 'platinum', isMember: true })).toBe('free');
  });
});

describe('monetizationLimits — one call replaces the per-site composition', () => {
  it('lets a video model earn 5x the fee of the same image model', () => {
    const image = monetizationLimits({ tier: 'bronze', baseModel: 'SDXL 1.0' });
    const video = monetizationLimits({ tier: 'bronze', baseModel: 'Hunyuan Video' });
    expect(video.fee.maxPerGeneration).toBe(image.fee.maxPerGeneration * 5);
  });

  it('resolves the media axis from the base model, so no caller can name the wrong one', () => {
    const unmatched = monetizationLimits({ tier: 'bronze' });
    const image = monetizationLimits({ tier: 'bronze', baseModel: 'SDXL 1.0' });
    // An unmatched base model prices as image — the stricter of the two.
    expect(unmatched.fee.maxPerGeneration).toBe(image.fee.maxPerGeneration);
  });

  it('gives every tier the same fee ceiling — membership governs how often, not how much', () => {
    const perGeneration = (tier: 'free' | 'bronze' | 'silver' | 'gold') =>
      monetizationLimits({ tier, baseModel: 'SDXL 1.0' }).fee.maxPerGeneration;
    expect(perGeneration('free')).toBe(perGeneration('gold'));
    expect(perGeneration('bronze')).toBe(perGeneration('silver'));
  });

  it('offers every denominator, since the flat ceiling can express all of them', () => {
    const { fee } = monetizationLimits({ tier: 'free', baseModel: 'SDXL 1.0' });
    expect(fee.denominators).toContain(1);
    expect(fee.denominators).toContain(100);
  });

  it('varies the monthly allowance by tier, reporting unlimited as null', () => {
    expect(monetizationLimits({ tier: 'free' }).allowance.monthlyPrices).toBe(3);
    expect(monetizationLimits({ tier: 'bronze' }).allowance.monthlyPrices).toBe(10);
    expect(monetizationLimits({ tier: 'silver' }).allowance.monthlyPrices).toBe(25);
    expect(monetizationLimits({ tier: 'gold' }).allowance.monthlyPrices).toBeNull();
  });

  // Moderators are exempt from the fee CEILING, applied on the write path — never from the allowance.
  // Reporting them unlimited here promised something assertPricingAllowed then refuses.
  it('does not exempt moderators from the allowance', () => {
    expect(monetizationLimits({ tier: 'free' }).allowance.monthlyPrices).toBe(3);
  });

  it('does not scale the allowance for video — it counts prices rather than sizing them', () => {
    expect(
      monetizationLimits({ tier: 'free', baseModel: 'Hunyuan Video' }).allowance.monthlyPrices
    ).toBe(monetizationLimits({ tier: 'free', baseModel: 'SDXL 1.0' }).allowance.monthlyPrices);
  });
});

describe('feeMaxFor — the editor bound, in whole buzz', () => {
  it('matches the enforced ceiling at every denominator, offered or not', () => {
    const limits = monetizationLimits({ tier: 'free', baseModel: 'SDXL 1.0' });
    for (const images of [1, 2, 10, 20, 50, 100]) {
      expect(feeMaxFor(limits, images)).toBe(maxFeeBuzzForRatio(images));
    }
  });

  it('scales with the denominator the editor is showing', () => {
    const limits = monetizationLimits({ tier: 'silver', baseModel: 'SDXL 1.0' });
    expect(feeMaxFor(limits, 1)).toBe(100);
    expect(feeMaxFor(limits, 10)).toBe(1000);
  });
});

describe('suggestedFee — seeded default, independent of tier', () => {
  it('varies by model type and media, never by tier', () => {
    expect(suggestedFee({ modelType: 'Checkpoint' })).toBeGreaterThan(
      suggestedFee({ modelType: 'LORA' })
    );
    expect(suggestedFee({ modelType: 'LORA', baseModel: 'Hunyuan Video' })).toBeCloseTo(
      suggestedFee({ modelType: 'LORA', baseModel: 'SDXL 1.0' }) * 5,
      5
    );
  });
});

describe('seedFeeRatio — what a fee editor opens on', () => {
  it('opens a checkpoint on 1 per generation and a LoRA on 1 per 10', () => {
    expect(seedFeeRatio({ modelType: 'Checkpoint' })).toEqual({ buzz: 1, images: 1 });
    expect(seedFeeRatio({ modelType: 'LORA' })).toEqual({ buzz: 1, images: 10 });
  });

  it('an existing fee wins over the suggestion', () => {
    expect(seedFeeRatio({ licensingFee: 0.05, modelType: 'Checkpoint' })).toEqual({
      buzz: 1,
      images: 20,
    });
  });

  it('a cleared fee falls back to the suggestion rather than to the flat denominator', () => {
    expect(seedFeeRatio({ licensingFee: 0, modelType: 'Checkpoint' }).images).toBe(1);
  });

  it('carries the video multiplier', () => {
    expect(seedFeeRatio({ modelType: 'LORA', baseModel: 'Hunyuan Video' })).toEqual({
      buzz: 5,
      images: 10,
    });
  });
});

describe('a suggestion is dropped when the editor cannot offer its denominator', () => {
  it('keeps a suggestion the editor offers', () => {
    expect(suggestedFeeRatio(1, [1, 10, 20, 50, 100])).toEqual({ buzz: 1, images: 1 });
  });

  it('falls back to the flat denominator with no amount when it does not', () => {
    // Seeding a denominator the select has no item for renders an editor with nothing selected.
    expect(suggestedFeeRatio(1, [10, 20, 50, 100])).toEqual({ buzz: 0, images: 10 });
  });

  it('clamps the suggestion branch of seedFeeRatio but never an existing fee', () => {
    expect(seedFeeRatio({ modelType: 'Checkpoint', denominators: [10, 20, 50, 100] })).toEqual({
      buzz: 0,
      images: 10,
    });
    // A stored fee always opens on the denominator it was actually saved with.
    expect(
      seedFeeRatio({ licensingFee: 1, modelType: 'Checkpoint', denominators: [10, 20, 50, 100] })
    ).toEqual({ buzz: 1, images: 1 });
  });
});

describe('every seeded suggestion is saveable', () => {
  // The suggestion and the ceiling are separate constants. Raise one or lower the other and a fresh
  // editor opens on a value the server rejects at submit, with nothing in the UI to explain it.
  const types = [...Object.keys(SUGGESTED_FEE_PER_IMAGE), 'LORA'];

  it.each(types)('%s stays within the ceiling for image and video', (modelType) => {
    for (const baseModel of ['SDXL 1.0', 'Hunyuan Video']) {
      expect(suggestedFee({ modelType, baseModel })).toBeLessThanOrEqual(
        maxLicensingFeeCeiling(baseModel === 'Hunyuan Video' ? 'video' : 'image')
      );
    }
  });
});

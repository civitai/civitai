import { describe, expect, it } from 'vitest';
import { maxFeeBuzzForRatio } from './licensing-fee';
import { feeMaxFor, monetizationLimits, resolveCapTier, suggestedFee } from './monetization-limits';

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

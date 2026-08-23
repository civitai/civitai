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
import { maxLicensingFee, SUGGESTED_FEE_PER_IMAGE } from './licensing-fee';

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
  it('caps a video model 5x higher than the same image model', () => {
    const image = monetizationLimits({
      tier: 'bronze',
      modelType: 'Checkpoint',
      baseModel: 'SDXL 1.0',
    });
    const video = monetizationLimits({
      tier: 'bronze',
      modelType: 'Checkpoint',
      baseModel: 'Hunyuan Video',
    });
    expect(video.fee.maxPerGeneration).toBe(image.fee.maxPerGeneration * 5);
    expect(video.access.maxPrice).toBe((image.access.maxPrice as number) * 5);
  });

  it('resolves the media axis from the base model, so no caller can name the wrong one', () => {
    const unmatched = monetizationLimits({ tier: 'bronze', modelType: 'Checkpoint' });
    const image = monetizationLimits({
      tier: 'bronze',
      modelType: 'Checkpoint',
      baseModel: 'SDXL 1.0',
    });
    // An unmatched base model prices as image — the stricter of the two.
    expect(unmatched.fee.maxPerGeneration).toBe(image.fee.maxPerGeneration);
  });

  it('offers only denominators that can express at least 1 buzz', () => {
    // free/other caps at 0.1 per generation, so "per 1 generation" has no whole-number entry.
    const { fee } = monetizationLimits({ tier: 'free', modelType: 'LORA', baseModel: 'SDXL 1.0' });
    expect(fee.denominators).not.toContain(1);
    expect(fee.denominators).toContain(10);
  });

  it('reports unlimited as null so it survives a JSON boundary', () => {
    const gold = monetizationLimits({ tier: 'gold' });
    expect(gold.access.maxPrice).toBeNull();
    expect(gold.permanent.limit).toBeNull();
    expect(monetizationLimits({ tier: 'free' }).permanent.limit).toBe(3);
  });

  it('exempts moderators from the tier caps, and offers them every denominator', () => {
    const mod = monetizationLimits({ tier: 'free', modelType: 'LORA', isModerator: true });
    expect(mod.access.maxPrice).toBeNull();
    expect(mod.permanent.limit).toBeNull();
    expect(mod.fee.denominators).toContain(1);
    expect(mod.fee.maxPerGeneration).toBeGreaterThan(
      monetizationLimits({ tier: 'free', modelType: 'LORA' }).fee.maxPerGeneration
    );
  });
});

describe('feeMaxFor — the editor bound, in whole buzz', () => {
  // The regression this guards: a lookup keyed by the OFFERED denominators has no entry for one the tier
  // can't express, and falling back to another overstates the ceiling. A silver creator who set
  // 5 buzz/generation and then lapsed opens the editor at images=1, which free tier cannot express — the
  // bound must be 0, not a value borrowed from images=10.
  it('matches the enforced cap at every denominator, offered or not', () => {
    const limits = monetizationLimits({ tier: 'free', modelType: 'LORA' });
    for (const images of [1, 2, 10, 20, 50, 100]) {
      expect(feeMaxFor(limits, images)).toBe(maxFeeBuzzForRatio('free', 'LORA', images));
    }
    expect(feeMaxFor(limits, 1)).toBe(0);
  });

  it('scales with the denominator the editor is showing', () => {
    const limits = monetizationLimits({ tier: 'silver', modelType: 'Checkpoint' });
    expect(feeMaxFor(limits, 1)).toBe(10);
    expect(feeMaxFor(limits, 10)).toBe(100);
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
    // A checkpoint filter over a free-capped selection: 1 ⚡ / 1 generation, against a list that starts
    // at 10. Seeding it renders a select with no matching item and a ceiling of 0.
    expect(suggestedFeeRatio(1, [10, 20, 50, 100])).toEqual({ buzz: 0, images: 10 });
  });

  it('clamps the suggestion branch of seedFeeRatio but never an existing fee', () => {
    expect(seedFeeRatio({ modelType: 'Checkpoint', denominators: [10, 20, 50, 100] })).toEqual({
      buzz: 0,
      images: 10,
    });
    // A lapsed creator keeps the denominator they were grandfathered on, ceiling of 0 and all.
    expect(
      seedFeeRatio({ licensingFee: 1, modelType: 'Checkpoint', denominators: [10, 20, 50, 100] })
    ).toEqual({ buzz: 1, images: 1 });
  });
});

describe('every seeded suggestion is saveable on the free tier', () => {
  // The suggestion and the free cap are separate tables. Raise one or lower the other and a fresh editor
  // opens on a value the server rejects at submit — a failure with no ceiling in the UI to explain it.
  const types = [...Object.keys(SUGGESTED_FEE_PER_IMAGE), 'LORA'];

  it.each(types)('%s stays within the free-tier cap for image and video', (modelType) => {
    for (const baseModel of ['SDXL 1.0', 'Hunyuan Video']) {
      expect(suggestedFee({ modelType, baseModel })).toBeLessThanOrEqual(
        maxLicensingFee('free', modelType, baseModel === 'Hunyuan Video' ? 'video' : 'image')
      );
    }
  });
});

describe('access price ceiling applies to permanent gates only', () => {
  it('caps a permanent gate at the tier ceiling', () => {
    expect(monetizationLimits({ tier: 'free', permanent: true }).access.maxPrice).toBe(500);
    expect(monetizationLimits({ tier: 'silver', permanent: true }).access.maxPrice).toBe(5000);
  });

  it('leaves a timed early-access window uncapped — it becomes free when the window closes', () => {
    expect(monetizationLimits({ tier: 'free', permanent: false }).access.maxPrice).toBeNull();
    expect(monetizationLimits({ tier: 'silver', permanent: false }).access.maxPrice).toBeNull();
  });

  it('defaults to capped, so a caller that forgets cannot accidentally uncap a permanent gate', () => {
    expect(monetizationLimits({ tier: 'free' }).access.maxPrice).toBe(500);
  });

  it('leaves the LICENSING fee capped either way — it is charged per generation, not per window', () => {
    const timed = monetizationLimits({ tier: 'free', modelType: 'Checkpoint', permanent: false });
    const perm = monetizationLimits({ tier: 'free', modelType: 'Checkpoint', permanent: true });
    expect(timed.fee.maxPerGeneration).toBe(perm.fee.maxPerGeneration);
    expect(timed.fee.maxPerGeneration).toBe(1);
  });

  it('leaves the permanent-gate COUNT limit alone — that is about how many, not how much', () => {
    expect(monetizationLimits({ tier: 'free', permanent: false }).permanent.limit).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import { fitCustomDimensions, type CustomDimensionLimits } from '~/utils/aspect-ratio-helpers';
import {
  flux1ProCustomDimensionLimits,
  fourMegapixelCustomDimensionLimits,
  sd1CustomDimensionLimits,
  sdxlCustomDimensionLimits,
} from '~/shared/constants/generation.constants';

const SDXL = sdxlCustomDimensionLimits;

describe('fitCustomDimensions', () => {
  it('keeps an in-limits request exactly', () => {
    expect(fitCustomDimensions({ width: 1024, height: 1536 }, SDXL)).toEqual({
      width: 1024,
      height: 1536,
    });
    expect(fitCustomDimensions({ width: 1536, height: 640 }, SDXL)).toEqual({
      width: 1536,
      height: 640,
    });
  });

  it('snaps to the step', () => {
    expect(fitCustomDimensions({ width: 1000, height: 1000 }, SDXL)).toEqual({
      width: 992,
      height: 992,
    });
  });

  it('scales an oversized request down to the area cap, keeping its shape', () => {
    const fit = fitCustomDimensions({ width: 2048, height: 2048 }, SDXL)!;
    expect(fit.width).toBe(fit.height);
    expect(fit.width * fit.height).toBeLessThanOrEqual(SDXL.maxArea);
  });

  it('raises a tiny request to the minimum side', () => {
    expect(fitCustomDimensions({ width: 64, height: 64 }, SDXL)).toEqual({
      width: 512,
      height: 512,
    });
  });

  it('caps an extreme ratio', () => {
    const fit = fitCustomDimensions({ width: 2048, height: 64 }, SDXL)!;
    expect(fit.width / fit.height).toBeLessThanOrEqual(SDXL.maxRatio);
  });

  it('keeps the shape when a side runs past the maximum', () => {
    // 16:9 at 4 MP is 2731 wide; shrinking both sides keeps it 16:9 (2048 × 1152),
    // where clamping the width alone gave 4:3.
    expect(
      fitCustomDimensions({ width: 2752, height: 1536 }, fourMegapixelCustomDimensionLimits)
    ).toEqual({ width: 2048, height: 1152 });
  });

  it('holds Flux.1 Pro to its 1440 side', () => {
    expect(
      fitCustomDimensions({ width: 1536, height: 640 }, flux1ProCustomDimensionLimits)
    ).toEqual({ width: 1440, height: 608 });
  });

  it('refuses a non-positive or non-numeric request', () => {
    expect(fitCustomDimensions({ width: 0, height: 1024 }, SDXL)).toBeUndefined();
    expect(fitCustomDimensions({ width: NaN, height: 1024 }, SDXL)).toBeUndefined();
    expect(fitCustomDimensions({ width: -512, height: 1024 }, SDXL)).toBeUndefined();
  });

  it.each([
    ['SDXL', SDXL],
    ['Flux.1 Pro', flux1ProCustomDimensionLimits],
    ['SD1', sd1CustomDimensionLimits],
  ] as [string, CustomDimensionLimits][])(
    'every result is inside the %s limits, for any request',
    (_, limits) => {
      // Deterministic spread of requests, including extremes far past every limit.
      let seed = 1;
      const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 2000; i++) {
        const fit = fitCustomDimensions(
          { width: 1 + next() * 5000, height: 1 + next() * 5000 },
          limits
        )!;
        for (const side of [fit.width, fit.height]) {
          expect(side % limits.step).toBe(0);
          expect(side).toBeGreaterThanOrEqual(limits.minSide);
          expect(side).toBeLessThanOrEqual(limits.maxSide);
        }
        expect(fit.width * fit.height).toBeLessThanOrEqual(limits.maxArea);
        expect(
          Math.max(fit.width, fit.height) / Math.min(fit.width, fit.height)
        ).toBeLessThanOrEqual(limits.maxRatio);
      }
    }
  );
});

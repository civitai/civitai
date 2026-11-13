import { describe, expect, it } from 'vitest';
import {
  LORA_STRENGTH_BOUNDS,
  strengthSliderBounds,
  clampStrength,
} from '~/shared/constants/generation.constants';

describe('strengthSliderBounds', () => {
  it("keeps a version's own range", () => {
    expect(strengthSliderBounds({ min: 0.1, max: 1.5 })).toEqual({ min: 0.1, max: 1.5 });
  });

  // Equal bounds, and form state saved before the settings shape, both mean "none set".
  it.each([
    ['equal bounds', { min: 1, max: 1 }],
    ['no range', undefined],
  ])('falls back to the full range for %s', (_, range) => {
    expect(strengthSliderBounds(range)).toBe(LORA_STRENGTH_BOUNDS);
  });
});

describe('clampStrength', () => {
  it.each([
    ['inside the range', 0.5, { min: 0, max: 1 }, 0.5],
    ['above it', 1.5, { min: 0, max: 1 }, 1],
    ['below it', -0.5, { min: 0, max: 1 }, 0],
    ['with no range, into the full bounds', 3, undefined, LORA_STRENGTH_BOUNDS.max],
  ])('keeps a weight %s', (_, strength, range, expected) => {
    expect(clampStrength(strength, range)).toBe(expected);
  });
});

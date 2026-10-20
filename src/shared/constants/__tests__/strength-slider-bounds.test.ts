import { describe, expect, it } from 'vitest';
import { LORA_STRENGTH_BOUNDS, strengthSliderBounds } from '~/shared/constants/strength.constants';

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

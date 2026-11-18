import { describe, expect, it } from 'vitest';
import { getReviewImageWidth } from '../review-image-width';

describe('getReviewImageWidth', () => {
  it('asks for the source width, up to 1600, for landscape images', () => {
    expect(getReviewImageWidth({ width: 2712, height: 1160 })).toBe(1600);
    expect(getReviewImageWidth({ width: 1344, height: 768 })).toBe(1200);
    expect(getReviewImageWidth({ width: 1000, height: 500 })).toBe(800);
  });

  it('keeps 800 for portrait, square, unknown sizes and phones', () => {
    expect(getReviewImageWidth({ width: 1160, height: 2712 })).toBe(800);
    expect(getReviewImageWidth({ width: 900, height: 900 })).toBe(800);
    expect(getReviewImageWidth({ width: null, height: null })).toBe(800);
    expect(getReviewImageWidth({ width: 2712, height: 1160 }, true)).toBe(800);
  });
});

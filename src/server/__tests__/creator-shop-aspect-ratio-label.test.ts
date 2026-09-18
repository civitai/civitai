import { describe, expect, it } from 'vitest';
import { aspectRatioLabel } from '~/server/schema/creator-shop.schema';

describe('aspectRatioLabel', () => {
  it.each([
    // The profile-background recommendation, which a stale comment had mislabeled "25:9".
    [450, 144, '25:8'],
    [144, 144, '1:1'],
    [256, 256, '1:1'],
    [1920, 1080, '16:9'],
    [120, 90, '4:3'],
  ])('reduces %i×%i to "%s"', (width, height, expected) => {
    expect(aspectRatioLabel(width, height)).toBe(expected);
  });

  it('does not divide by zero when a dimension is 0', () => {
    expect(aspectRatioLabel(0, 0)).toBe('0:0');
    expect(aspectRatioLabel(450, 0)).toBe('450:0');
  });
});

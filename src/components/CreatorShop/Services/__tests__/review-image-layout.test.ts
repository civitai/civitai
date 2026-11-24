import { describe, expect, it } from 'vitest';
import {
  reviewImageLayout,
  reviewRowTileStyle,
} from '~/components/CreatorShop/Services/review-image-layout';

describe('reviewImageLayout', () => {
  it.each([
    [1, 'single'],
    [2, 'row'],
    [3, 'row'],
    [4, 'grid'],
  ])('%i image(s) use the %s layout', (count, layout) => {
    expect(reviewImageLayout(count)).toBe(layout);
  });
});

describe('reviewRowTileStyle', () => {
  it('sizes a tile by its own shape so the image shows whole', () => {
    expect(reviewRowTileStyle({ width: 800, height: 600 })).toEqual({
      aspectRatio: '1.3333333333333333',
      flex: '1.3333333333333333 1 0',
    });
    expect(reviewRowTileStyle({ width: 300, height: 400 }).aspectRatio).toBe('0.75');
  });

  it('falls back to a square when a size is missing', () => {
    expect(reviewRowTileStyle({ width: null, height: 400 }).aspectRatio).toBe('1');
    expect(reviewRowTileStyle({}).aspectRatio).toBe('1');
  });
});

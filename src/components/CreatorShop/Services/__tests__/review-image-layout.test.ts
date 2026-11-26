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
    const wide = reviewRowTileStyle({ width: 800, height: 600 });
    const tall = reviewRowTileStyle({ width: 300, height: 400 });
    // The tile keeps the image's own shape...
    expect(Number(wide.aspectRatio)).toBeCloseTo(800 / 600);
    expect(Number(tall.aspectRatio)).toBeCloseTo(300 / 400);
    // ...and a wider image takes more of the row than a taller one, shrinking from nothing.
    const grow = (style: { flex: string }) => Number(style.flex.split(' ')[0]);
    expect(grow(wide)).toBeGreaterThan(grow(tall));
    expect(wide.flex.endsWith(' 1 0')).toBe(true);
  });

  it('falls back to a square when a size is missing', () => {
    expect(reviewRowTileStyle({ width: null, height: 400 }).aspectRatio).toBe('1');
    expect(reviewRowTileStyle({}).aspectRatio).toBe('1');
  });
});

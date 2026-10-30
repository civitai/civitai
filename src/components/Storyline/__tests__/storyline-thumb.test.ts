import { describe, expect, it } from 'vitest';
import { storylineThumbRequestWidth } from '~/components/Storyline/storyline-thumb';

describe('storylineThumbRequestWidth', () => {
  // A 2:1 image filling a 3:4 tile is drawn 2 / 0.75 times the tile's width; asking for the tile's
  // width alone upscaled it and it came out soft.
  it('asks a wide image for as many pixels as it is drawn wide', () => {
    expect(storylineThumbRequestWidth(140, '3/4', { width: 2000, height: 1000 })).toBe(747);
  });

  it('asks a tall or matching image for the tile width at 2x', () => {
    expect(storylineThumbRequestWidth(140, '3/4', { width: 768, height: 1024 })).toBe(280);
    expect(storylineThumbRequestWidth(140, '3/4', { width: 600, height: 1200 })).toBe(280);
  });

  it('falls back to the tile width when the size is unknown', () => {
    expect(storylineThumbRequestWidth(140, '3/4', { width: null, height: null })).toBe(280);
  });

  it('judges a banner by its own shape', () => {
    expect(storylineThumbRequestWidth(600, '16/6', { width: 2000, height: 1000 })).toBe(1200);
    expect(storylineThumbRequestWidth(600, '16/6', { width: 4000, height: 1000 })).toBe(1800);
  });
});

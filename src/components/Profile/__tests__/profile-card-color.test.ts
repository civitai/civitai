import { encode } from 'blurhash';
import { describe, expect, it } from 'vitest';
import {
  profileBarBackground,
  profileCardBackground,
  profileCardInk,
  suggestedCardColor,
} from '~/components/Profile/profile-card-color';

const solid = (r: number, g: number, b: number) => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([r, g, b, 255], i);
  return encode(pixels, 4, 4, 1, 1);
};

describe('suggestedCardColor', () => {
  it("is the image's average colour", () => {
    expect(suggestedCardColor(solid(200, 40, 10))).toBe('#c8280a');
  });

  it('suggests nothing without a usable hash', () => {
    expect(suggestedCardColor(null)).toBeNull();
    expect(suggestedCardColor('not a hash')).toBeNull();
  });
});

describe('profileCardBackground', () => {
  it('applies the opacity, 80% when none is set, and nothing without a colour', () => {
    expect(profileCardBackground('#112233', 60)).toBe('#11223399');
    expect(profileCardBackground('#112233', null)).toBe('#112233cc');
    expect(profileCardBackground(null, 70)).toBeUndefined();
  });
});

describe('profileBarBackground', () => {
  it('is the card colour nearly opaque, and nothing without one', () => {
    expect(profileBarBackground('#112233')).toBe('#112233ed');
    expect(profileBarBackground(null)).toBeUndefined();
  });
});

describe('profileCardInk', () => {
  it('picks dark text on a light card and light text on a dark one', () => {
    expect(profileCardInk('#f3ead7', 100, 'dark')).toBe('dark'); // cream
    expect(profileCardInk('#7fd1c4', 100, 'dark')).toBe('dark'); // teal
    expect(profileCardInk('#1b2a4a', 100, 'dark')).toBe('light'); // navy
  });

  it('accounts for the theme showing through a translucent card', () => {
    // A mid-light colour at 60% over the dark theme renders dark enough for light text.
    expect(profileCardInk('#9aa0a6', 60, 'dark')).toBe('light');
    expect(profileCardInk('#9aa0a6', 60, 'light')).toBe('dark');
  });

  it('leaves the theme alone without a colour', () => {
    expect(profileCardInk(null, 80, 'dark')).toBeUndefined();
  });
});

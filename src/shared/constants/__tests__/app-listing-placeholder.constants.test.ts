import { describe, expect, it } from 'vitest';

import {
  CATEGORY_GLYPH,
  appInitial,
  categoryGlyph,
  listingPlaceholderGradient,
  listingPlaceholderSeed,
  placeholderHues,
  placeholderStop,
  seededHue,
} from '../app-listing-placeholder.constants';

/**
 * These primitives back BOTH the server-generated placeholder assets and the
 * CLIENT render-time fallback for a listing with no icon/cover. The whole point
 * of the shared module is that the two can't drift, so the properties that must
 * hold are: determinism (no SSR/hydration flicker), per-app variation (below-
 * floor listings must not all look identical), and stable stop values (a change
 * here changes generated assets too — so it should break a test, loudly).
 */

describe('seededHue', () => {
  it('is deterministic and within [0,360)', () => {
    expect(seededHue('cool-app')).toBe(seededHue('cool-app'));
    expect(seededHue('cool-app')).toBeGreaterThanOrEqual(0);
    expect(seededHue('cool-app')).toBeLessThan(360);
  });

  it('varies across seeds (below-floor listings must not all look alike)', () => {
    const hues = new Set(
      ['buzz', 'df-qwen-canvas', 'gen-matrix', 'prompt-vault', 'panorama-360'].map(seededHue)
    );
    // Not a strict guarantee of the hash, but a collapse to 1 bucket would mean
    // the per-app identity this module exists to provide is gone.
    expect(hues.size).toBeGreaterThan(1);
  });

  it('handles the empty seed without throwing', () => {
    expect(() => seededHue('')).not.toThrow();
    expect(seededHue('')).toBeGreaterThanOrEqual(0);
    expect(seededHue('')).toBeLessThan(360);
  });
});

describe('appInitial', () => {
  it('takes the first alphanumeric of the name, uppercased', () => {
    expect(appInitial('Cool App', 'slug')).toBe('C');
    expect(appInitial('123abc', 'x')).toBe('1');
    expect(appInitial('  spaced', 'x')).toBe('S');
  });

  it('falls through to the slug for a blank/whitespace-only name', () => {
    expect(appInitial('  ', 'slug')).toBe('S');
    expect(appInitial('', 'df-qwen-canvas')).toBe('D');
  });

  it("resolves to '?' only when neither name nor slug has an alphanumeric", () => {
    expect(appInitial('', '')).toBe('?');
    expect(appInitial('—', '—')).toBe('?');
  });
});

describe('categoryGlyph', () => {
  it('maps a known category', () => {
    expect(categoryGlyph('generation')).toBe(CATEGORY_GLYPH.generation);
    expect(categoryGlyph('analytics')).toBe(CATEGORY_GLYPH.analytics);
  });

  it('falls back to the `other` glyph for null / unknown (never undefined)', () => {
    // df-qwen-canvas is live with a NULL category — this path is real.
    expect(categoryGlyph(null)).toBe(CATEGORY_GLYPH.other);
    expect(categoryGlyph(undefined)).toBe(CATEGORY_GLYPH.other);
    expect(categoryGlyph('not-a-category')).toBe(CATEGORY_GLYPH.other);
  });
});

describe('listingPlaceholderSeed', () => {
  it('is `<category>:<slug>` and treats null category as `other`', () => {
    expect(listingPlaceholderSeed('buzz', 'analytics')).toBe('analytics:buzz');
    expect(listingPlaceholderSeed('df-qwen-canvas', null)).toBe('other:df-qwen-canvas');
    expect(listingPlaceholderSeed('x', undefined)).toBe('other:x');
  });

  it('distinguishes two apps that share a category', () => {
    expect(listingPlaceholderSeed('a', 'utility')).not.toBe(listingPlaceholderSeed('b', 'utility'));
  });
});

describe('placeholderHues', () => {
  it('offsets the second hue by 40°, wrapping at 360', () => {
    const { hue, hue2 } = placeholderHues('some-seed');
    expect(hue2).toBe((hue + 40) % 360);
    expect(hue2).toBeGreaterThanOrEqual(0);
    expect(hue2).toBeLessThan(360);
  });
});

describe('placeholderStop', () => {
  // Locks the exact saturation/lightness pairs. These are ALSO baked into the
  // generated icon/cover SVGs, so an unintended change here would silently
  // recolour previously-generated assets relative to live placeholders.
  it('emits the icon surface stops', () => {
    expect(placeholderStop('icon', 'from', 10)).toBe('hsl(10 55% 42%)');
    expect(placeholderStop('icon', 'to', 50)).toBe('hsl(50 60% 22%)');
  });

  it('emits the (dimmer) cover surface stops', () => {
    expect(placeholderStop('cover', 'from', 10)).toBe('hsl(10 45% 32%)');
    expect(placeholderStop('cover', 'to', 50)).toBe('hsl(50 50% 16%)');
  });

  it('keeps the cover darker than the icon so foreground glyph/text stays legible', () => {
    const lightness = (s: string) => Number(/\s(\d+)%\)$/.exec(s)?.[1]);
    expect(lightness(placeholderStop('cover', 'from', 0))).toBeLessThan(
      lightness(placeholderStop('icon', 'from', 0))
    );
  });
});

describe('listingPlaceholderGradient', () => {
  it('is a deterministic 135deg CSS gradient', () => {
    const a = listingPlaceholderGradient({ slug: 'buzz', category: 'analytics', surface: 'cover' });
    const b = listingPlaceholderGradient({ slug: 'buzz', category: 'analytics', surface: 'cover' });
    expect(a).toBe(b);
    expect(a).toMatch(
      /^linear-gradient\(135deg, hsl\(\d+ \d+% \d+%\) 0%, hsl\(\d+ \d+% \d+%\) 100%\)$/
    );
  });

  it('differs per app', () => {
    const buzz = listingPlaceholderGradient({ slug: 'buzz', category: null, surface: 'cover' });
    const qwen = listingPlaceholderGradient({
      slug: 'df-qwen-canvas',
      category: null,
      surface: 'cover',
    });
    expect(buzz).not.toBe(qwen);
  });

  it('differs per surface for the same app (icon is brighter than cover)', () => {
    const icon = listingPlaceholderGradient({ slug: 'buzz', category: null, surface: 'icon' });
    const cover = listingPlaceholderGradient({ slug: 'buzz', category: null, surface: 'cover' });
    expect(icon).not.toBe(cover);
  });

  it('uses the same hue for icon and cover of one app (one colour identity)', () => {
    const hue = seededHue(listingPlaceholderSeed('buzz', null));
    expect(listingPlaceholderGradient({ slug: 'buzz', category: null, surface: 'icon' })).toContain(
      `hsl(${hue} `
    );
    expect(
      listingPlaceholderGradient({ slug: 'buzz', category: null, surface: 'cover' })
    ).toContain(`hsl(${hue} `);
  });

  it('null and "other" category resolve identically (same seed)', () => {
    expect(listingPlaceholderGradient({ slug: 'x', category: null, surface: 'icon' })).toBe(
      listingPlaceholderGradient({ slug: 'x', category: 'other', surface: 'icon' })
    );
  });
});

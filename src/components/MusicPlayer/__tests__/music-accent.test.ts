import { encode } from 'blurhash';
import { describe, expect, it } from 'vitest';
import { musicAccentFromHash } from '~/components/MusicPlayer/music-accent';

/** A blurhash of a flat image in one colour: its average is that colour. */
function flatHash(r: number, g: number, b: number) {
  const size = 4;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) pixels.set([r, g, b, 255], i * 4);
  return encode(pixels, size, size, 4, 3);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const DARK_CARD = '#25262B';
const LIGHT_CARD = '#f8f9fa';
const WHITE = '#ffffff';

/** The play glyph is white on the accent; played bars sit on the card in both schemes. */
function expectReadable(accent: string) {
  expect(contrast(accent, WHITE)).toBeGreaterThanOrEqual(3);
  expect(contrast(accent, DARK_CARD)).toBeGreaterThanOrEqual(3);
  expect(contrast(accent, LIGHT_CARD)).toBeGreaterThanOrEqual(3);
}

describe('the artwork accent', () => {
  it("keeps a readable cover colour as it is, within the blurhash's rounding", () => {
    const accent = musicAccentFromHash(flatHash(0xe6, 0x49, 0x80));

    expect(accent).not.toBeNull();
    const [r, g, b] = rgb(accent!.accent);
    expect(Math.abs(r - 0xe6)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - 0x49)).toBeLessThanOrEqual(3);
    expect(Math.abs(b - 0x80)).toBeLessThanOrEqual(3);
    expectReadable(accent!.accent);
  });

  it('gives two different covers two different accents', () => {
    const pink = musicAccentFromHash(flatHash(0xe6, 0x49, 0x80));
    const teal = musicAccentFromHash(flatHash(0x0c, 0x85, 0x99));

    expect(pink!.accent).not.toBe(teal!.accent);
  });

  it.each([
    ['very dark', [10, 12, 30]],
    ['very light', [250, 245, 235]],
    ['grey', [128, 128, 128]],
    ['bright yellow', [255, 230, 0]],
  ] as const)('clamps a %s cover into a readable accent', (_, [r, g, b]) => {
    const accent = musicAccentFromHash(flatHash(r, g, b));

    expect(accent).not.toBeNull();
    expectReadable(accent!.accent);
  });

  it('keeps the hue of a dark cover rather than inventing one', () => {
    const accent = musicAccentFromHash(flatHash(10, 12, 60));
    const [r, g, b] = rgb(accent!.accent);

    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('gives a second colour for the wash, different from the accent', () => {
    const accent = musicAccentFromHash(flatHash(0xe6, 0x49, 0x80));

    expect(accent!.accent2).toMatch(/^#[0-9a-f]{6}$/);
    expect(accent!.accent2).not.toBe(accent!.accent);
  });

  it.each([null, undefined, '', 'not a hash', 'L'])(
    'is null for a missing or invalid hash (%s)',
    (hash) => {
      expect(musicAccentFromHash(hash)).toBeNull();
    }
  );
});

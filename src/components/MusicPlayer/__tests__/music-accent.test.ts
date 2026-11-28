import { encode } from 'blurhash';
import { describe, expect, it } from 'vitest';
import type {
  MusicAccent,
  MusicSurface,
  SurfaceState,
} from '~/components/MusicPlayer/music-accent';
import {
  blend,
  MUSIC_SURFACES,
  musicAccentFromHash,
  musicAccentVars,
  musicSurface,
  readableAccent,
} from '~/components/MusicPlayer/music-accent';

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
function hue(hex: string) {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
  const d = max - min;
  if (!d) return 0;
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
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
    ['bright yellow', [255, 230, 0]],
  ] as const)('clamps a %s cover into a readable accent', (_, [r, g, b]) => {
    const accent = musicAccentFromHash(flatHash(r, g, b));

    expect(accent).not.toBeNull();
    expectReadable(accent!.accent);
  });

  // A grey accent reads like the player's dimmed "off" controls, so Shuffle and Repeat look off.
  it.each([
    ['grey', [128, 128, 128]],
    ['grey tabby', [120, 114, 104]],
  ] as const)('is null for a %s cover, which has no colour to take', (_, [r, g, b]) => {
    expect(musicAccentFromHash(flatHash(r, g, b))).toBeNull();
  });

  it('keeps the hue of a dark cover rather than inventing one', () => {
    const accent = musicAccentFromHash(flatHash(10, 12, 60));
    const [r, g, b] = rgb(accent!.accent);

    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it.each([
    ['pink', [0xe6, 0x49, 0x80]],
    ['teal', [0x0c, 0x85, 0x99]],
    ['yellow', [255, 230, 0]],
    ['red', [200, 30, 30]],
  ] as const)(
    "gives the wash a darker second colour within the %s artwork's hues",
    (_, [r, g, b]) => {
      const accent = musicAccentFromHash(flatHash(r, g, b))!;

      expect(accent.accent2).toMatch(/^#[0-9a-f]{6}$/);
      expect(luminance(accent.accent2)).toBeLessThan(luminance(accent.accent));
      const turn = Math.abs(hue(accent.accent2) - hue(accent.accent)) % 360;
      expect(Math.min(turn, 360 - turn)).toBeLessThanOrEqual(20);
    }
  );

  it.each([null, undefined, '', 'not a hash', 'L'])(
    'is null for a missing or invalid hash (%s)',
    (hash) => {
      expect(musicAccentFromHash(hash)).toBeNull();
    }
  );
});

describe('readableAccent', () => {
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // The Pencil accent, the Mantine primary, and the corners of the player's accent band.
  const ACCENTS = ['#e64980', '#228be6', '#f59f00', '#2b8a3e', '#7048e8', '#0b7285'];
  // The surfaces a time sits on: white and the dark list (#2C2E33), and the comment card in both.
  const SURFACES = ['#ffffff', '#2c2e33', '#25262b', '#f8f9fa'];

  it('reaches 4.5:1 on every surface, in the accent’s hue', () => {
    for (const accent of ACCENTS)
      for (const surface of SURFACES) {
        const shown = readableAccent(accent, surface);
        expect(contrast(shown, surface), `${accent} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(Math.abs(hue(shown) - hue(accent)), `${accent} on ${surface}`).toBeLessThan(6);
      }
  });

  it('leaves an accent that already reads alone', () => {
    expect(readableAccent('#0b3d91', '#ffffff')).toBe('#0b3d91');
  });
});

describe('musicSurface', () => {
  // Mantine's primary when no cover gives an accent: blue-6 in light, blue-8 in dark (Mantine's
  // default primaryShade; the theme sets neither primaryColor nor primaryShade).
  const PRIMARY = { light: '#228be6', dark: '#1971c2' };
  type Scheme = 'light' | 'dark';
  /** Covers around the wheel, made very dark and very light so the accent lands on the band's edges. */
  const covers: [string, MusicAccent | null][] = [];
  for (let h = 0; h < 360; h += 30)
    for (const [label, l] of [
      ['dark', 0.12],
      ['light', 0.88],
    ] as const) {
      const k = (n: number) => (n + h / 30) % 12;
      const a = 0.9 * Math.min(l, 1 - l);
      const f = (n: number) =>
        Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255);
      const accent = musicAccentFromHash(flatHash(f(0), f(8), f(4)));
      expect(accent, `hue ${h} ${label}`).not.toBeNull();
      covers.push([`hue ${h} ${label}`, accent]);
    }
  // The chips' tint is always the primary's shade 6.
  covers.push(['the primary as an accent', { accent: '#228be6', accent2: '#228be6' }]);
  covers.push(['no cover', null]);

  // The tints the design names (PR #10146) and the hovers the components paint,
  // kept apart from MUSIC_SURFACES so the text is still held to them if one is dropped there.
  const DESIGN_STATES: Partial<Record<MusicSurface, SurfaceState[]>> = {
    bar: [{ tint: 0.15 }, { light: '#f1f3f5', dark: '#2c2e33' }],
    upNextPanel: [{ tint: 0.33 }, { light: '#f1f3f5', dark: '#373a40' }],
    commentChips: [{ tint: 0.12 }, { tint: 0.192 }],
    commentList: [{ light: '#f1f3f5', dark: '#373a40' }],
  };

  it.each(Object.keys(MUSIC_SURFACES) as MusicSurface[])(
    'reads at 4.5:1 on the %s at rest, hovered and highlighted, in both schemes',
    (surface) => {
      const { states, ...base } = MUSIC_SURFACES[surface];
      const all = [...(Object.values(states) as SurfaceState[]), ...(DESIGN_STATES[surface] ?? [])];
      for (const [label, accent] of covers)
        for (const scheme of ['light', 'dark'] as Scheme[]) {
          const { style } = musicSurface(accent, surface);
          const text = style[`--music-accent-text-${scheme}`];
          expect(text, `${label}, ${scheme}`).toMatch(/^#[0-9a-f]{6}$/);
          const fill = accent?.accent ?? PRIMARY[scheme];
          const second = accent?.accent2 ?? PRIMARY[scheme];
          const backgrounds = [
            base[scheme],
            ...all.map((state) =>
              'tint' in state
                ? blend(state.second ? second : fill, base[scheme], state.tint)
                : state[scheme]
            ),
          ];
          for (const background of backgrounds)
            expect(
              contrast(text, background),
              `${label} on ${surface} (${background}), ${scheme}`
            ).toBeGreaterThanOrEqual(4.5);

          // The Civitai blue that stays blue under a cover, on the surface and its hovers.
          const primary = style[`--music-primary-text-${scheme}`];
          for (const background of [
            base[scheme],
            ...all.flatMap((s) => ('tint' in s ? [] : [s[scheme]])),
          ])
            expect(
              contrast(primary, background),
              `primary on ${surface} (${background}), ${scheme}`
            ).toBeGreaterThanOrEqual(4.5);
        }
    }
  );

  it("sets the cover's colours for fills, and none without a cover, so fills fall back to the primary", () => {
    const accent = musicAccentFromHash(flatHash(0xe6, 0x49, 0x80))!;

    expect(musicSurface(accent, 'bar').style).toMatchObject({
      '--music-accent': accent.accent,
      '--music-accent-2': accent.accent2,
    });
    expect(musicSurface(null, 'bar').style).not.toHaveProperty('--music-accent');
    expect(musicSurface(null, 'bar').style).not.toHaveProperty('--music-accent-2');
  });

  it('sets only the fill colours where no accent text sits', () => {
    const accent = musicAccentFromHash(flatHash(0xe6, 0x49, 0x80))!;

    expect(musicAccentVars(accent)).toEqual({
      '--music-accent': accent.accent,
      '--music-accent-2': accent.accent2,
    });
    expect(musicAccentVars(null)).toEqual({});
  });
});

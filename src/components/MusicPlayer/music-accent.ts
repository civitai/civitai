import { isBlurhashValid } from 'blurhash';

export type MusicAccent = { accent: string; accent2: string };

const BASE83 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(value: string) {
  let out = 0;
  for (const ch of value) out = out * 83 + BASE83.indexOf(ch);
  return out;
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function rgbToHsl([r, g, b]: number[]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
      ? (bn - rn) / d + 2
      : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

const toHex = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

// White on the accent, and the accent on the card in both schemes (#25262B, #f8f9fa), keep 3:1
// when its relative luminance is inside this band.
const MIN_LUMINANCE = 0.17;
const MAX_LUMINANCE = 0.27;
const MAX_SATURATION = 0.85;
// Below this the cover is greyish: its accent would read like the player's dimmed "off" controls.
const MIN_SATURATION = 0.25;
// The wash's second colour stays inside the artwork's hues: the same hue, turned a little and darker.
const SECOND_HUE_SHIFT = -12;
const SECOND_LIGHTNESS = 0.7;

/** `hsl` with its lightness moved until its luminance reaches `target`. */
function withLuminance(hsl: { h: number; s: number; l: number }, target: number) {
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 24; i++) {
    const l = (lo + hi) / 2;
    if (luminance(hslToRgb({ ...hsl, l })) < target) lo = l;
    else hi = l;
  }
  return { ...hsl, l: (lo + hi) / 2 };
}

/**
 * The global player's accent from a cover's blurhash: its average colour, held to a lightness and
 * saturation that stay readable on the player's card in dark and light, plus a second colour for
 * the wash. Null for a missing or invalid hash or a greyish cover, so the caller falls back to the
 * Civitai primary.
 */
export function musicAccentFromHash(hash: string | null | undefined): MusicAccent | null {
  if (!hash || !isBlurhashValid(hash).result) return null;
  const value = decode83(hash.substring(2, 6));
  const average = [value >> 16, (value >> 8) & 255, value & 255];

  let hsl = rgbToHsl(average);
  if (hsl.s < MIN_SATURATION) return null;
  hsl = { ...hsl, s: Math.min(hsl.s, MAX_SATURATION) };
  const lum = luminance(hslToRgb(hsl));
  if (lum < MIN_LUMINANCE) hsl = withLuminance(hsl, MIN_LUMINANCE);
  else if (lum > MAX_LUMINANCE) hsl = withLuminance(hsl, MAX_LUMINANCE);

  const second = {
    ...hsl,
    h: (hsl.h + SECOND_HUE_SHIFT + 360) % 360,
    l: hsl.l * SECOND_LIGHTNESS,
  };
  return { accent: toHex(hslToRgb(hsl)), accent2: toHex(hslToRgb(second)) };
}

/** `hex` (`#rrggbb`) at `alpha` (0..1), as `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number) {
  return `${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// WCAG AA for normal-size text.
const AA_TEXT = 4.5;
// Lightness is found by bisection, so aim a little past the bound to land on its right side.
const AA_MARGIN = 0.005;

/**
 * `accent` as text on `background`, both `#rrggbb`: the accent when it already reaches 4.5:1 there,
 * else the same hue and saturation made lighter (on a dark surface) or darker (on a light one)
 * until it does.
 */
export function readableAccent(accent: string, background: string) {
  const fg = luminance(hexRgb(accent));
  const bg = luminance(hexRgb(background));
  const darkSurface = bg < 0.18;
  const target = darkSurface ? AA_TEXT * (bg + 0.05) - 0.05 : (bg + 0.05) / AA_TEXT - 0.05;
  if (darkSurface ? fg >= target : fg <= target) return accent;
  const hsl = withLuminance(
    rgbToHsl(hexRgb(accent)),
    darkSurface ? target + AA_MARGIN : Math.max(0, target - AA_MARGIN)
  );
  return toHex(hslToRgb(hsl));
}

/** `fg` laid at `alpha` over `bg`, both `#rrggbb`, as a solid `#rrggbb`. */
export function blend(fg: string, bg: string, alpha: number) {
  const [f, b] = [hexRgb(fg), hexRgb(bg)];
  return toHex(f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha))));
}

/** Fills (backgrounds, bars, borders) in the accent: the cover's colour, else the Civitai primary. */
export const ACCENT_FILL = 'var(--music-accent, var(--mantine-primary-color-filled))';
/** Text and icons in the accent, at 4.5:1 on the surface given to `musicAccentVars`. */
export const ACCENT_TEXT = 'var(--music-accent-text)';
/** Sets `--music-accent-text` to the scheme's colour; goes where `musicAccentVars` is spread. */
export const ACCENT_TEXT_SCHEME =
  '[--music-accent-text:var(--music-accent-text-light)] dark:[--music-accent-text:var(--music-accent-text-dark)]';

// What `ACCENT_FILL` falls back to, `--mantine-primary-color-filled`: Mantine's blue at its default
// primaryShade, 6 in light and 8 in dark (the theme sets neither primaryColor nor primaryShade).
export const PRIMARY_FILL = { light: '#228BE6', dark: '#1971C2' };

type Scheme = 'light' | 'dark';
/** A background the text sits on over the surface: the accent (or its second colour) at `tint`, or a hover. */
export type SurfaceState = { tint: number; second?: true } | Record<Scheme, string>;

/**
 * The surfaces accent text sits on, per scheme, with the tints and hovers over them. A surface dark
 * in both schemes still computes each scheme from that scheme's primary.
 */
export const MUSIC_SURFACES = {
  // gray-0 / dark-6. The active toggles' 15% tint; the wash under Shuffle and Repeat, at most ~17%
  // of the accent or its second colour; the small buttons' hover, gray-1 / dark-5.
  bar: {
    light: '#f8f9fa',
    dark: '#25262B',
    states: [
      { tint: 0.15 },
      { tint: 0.2 },
      { tint: 0.2, second: true },
      { light: '#f1f3f5', dark: '#2C2E33' },
    ],
  },
  // White / dark-5; the now-playing row is the accent at 33% at its left edge.
  upNextPanel: { light: '#ffffff', dark: '#2C2E33', states: [{ tint: 0.33 }] },
  // The phone's Up next sheet, dark-5 in both schemes, with the same now-playing row.
  upNextSheet: { light: '#2C2E33', dark: '#2C2E33', states: [{ tint: 0.33 }] },
  // dark-7 in both schemes, under the cover's wash: the accent at 40% where the controls start.
  nowPlayingSheet: { light: '#1A1B1E', dark: '#1A1B1E', states: [{ tint: 0.4 }] },
  // The comment card (Mantine Card); the chip's tint at rest and hovered.
  commentChips: { light: '#ffffff', dark: '#25262b', states: [{ tint: 0.12 }, { tint: 0.192 }] },
  // The player's cluster list: white / dark-5, rows hovered gray-1 / dark-4.
  commentList: {
    light: '#ffffff',
    dark: '#2c2e33',
    states: [{ light: '#f1f3f5', dark: '#373A40' }],
  },
} satisfies Record<string, Record<Scheme, string> & { states: SurfaceState[] }>;
export type MusicSurface = keyof typeof MUSIC_SURFACES;

/** `fill` made readable on every background of `surface` in `scheme`. */
function textOn(surface: MusicSurface, scheme: Scheme, fill: string, second: string) {
  const { states, ...base } = MUSIC_SURFACES[surface];
  const backgrounds = [
    base[scheme],
    ...(states as SurfaceState[]).map((state) =>
      'tint' in state
        ? blend(state.second ? second : fill, base[scheme], state.tint)
        : state[scheme]
    ),
  ];
  // A scheme's backgrounds are all light or all dark, so each step only moves the text further from
  // the ones already passed, and the last colour reads on all of them.
  return backgrounds.reduce((text, background) => readableAccent(text, background), fill);
}

/**
 * The accent's CSS variables for a music surface: `--music-accent` and `--music-accent-2` for fills
 * (unset without a cover, so fills fall back to the primary), and `--music-accent-text-light` /
 * `-dark`, the cover's accent or the primary at 4.5:1 on `surface` in each scheme. Spread on the
 * surface's root with `ACCENT_TEXT_SCHEME`; omit `surface` where no accent text sits.
 */
export function musicAccentVars(accent: MusicAccent | null, surface?: MusicSurface) {
  const vars: Record<string, string> = {};
  if (accent) {
    vars['--music-accent'] = accent.accent;
    vars['--music-accent-2'] = accent.accent2;
  }
  if (surface)
    for (const scheme of ['light', 'dark'] as const) {
      const fill = accent?.accent ?? PRIMARY_FILL[scheme];
      vars[`--music-accent-text-${scheme}`] = textOn(
        surface,
        scheme,
        fill,
        accent?.accent2 ?? fill
      );
    }
  return vars;
}

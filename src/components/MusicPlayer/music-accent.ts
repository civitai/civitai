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
// The wash's second colour: the accent's hue turned towards violet, as the sample song's pair is.
const SECOND_HUE_SHIFT = -84;

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
 * the wash. Null for a missing or invalid hash, so the caller falls back to the Civitai primary.
 */
export function musicAccentFromHash(hash: string | null | undefined): MusicAccent | null {
  if (!hash || !isBlurhashValid(hash).result) return null;
  const value = decode83(hash.substring(2, 6));
  const average = [value >> 16, (value >> 8) & 255, value & 255];

  let hsl = rgbToHsl(average);
  hsl = { ...hsl, s: Math.min(hsl.s, MAX_SATURATION) };
  const lum = luminance(hslToRgb(hsl));
  if (lum < MIN_LUMINANCE) hsl = withLuminance(hsl, MIN_LUMINANCE);
  else if (lum > MAX_LUMINANCE) hsl = withLuminance(hsl, MAX_LUMINANCE);

  const second = { ...hsl, h: (hsl.h + SECOND_HUE_SHIFT + 360) % 360 };
  return { accent: toHex(hslToRgb(hsl)), accent2: toHex(hslToRgb(second)) };
}

/** `hex` (`#rrggbb`) at `alpha` (0..1), as `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number) {
  return `${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

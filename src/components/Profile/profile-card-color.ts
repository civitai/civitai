import { decode, isBlurhashValid } from 'blurhash';
import { profileCardOpacityDefault } from '~/server/schema/user-profile.schema';

/**
 * A card colour suggested from an image's stored blurhash: its 1x1 decode is the image's average
 * colour, so no pixels are fetched (a canvas read would need CORS from the image host).
 */
export function suggestedCardColor(hash: string | null | undefined): string | null {
  if (!hash || !isBlurhashValid(hash).result) return null;
  const [r, g, b] = decode(hash, 1, 1);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** The card background for a colour and opacity, or undefined to keep the theme's own. */
export function profileCardBackground(color: string | null, opacity: number | null) {
  if (!color) return undefined;
  const alpha = Math.round(((opacity ?? profileCardOpacityDefault) / 100) * 255);
  return `${color}${alpha.toString(16).padStart(2, '0')}`;
}

/** The profile tab bar's tint: the card colour, nearly opaque so the tabs stay readable (Ellie's mockup). */
export function profileBarBackground(color: string | null) {
  return color ? `${color}ed` : undefined;
}

const hexChannels = (hex: string) =>
  [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));

const luminance = ([r, g, b]: number[]) => {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

/** The theme surface a translucent card is painted over. */
const schemeSurface = { dark: '#25262b', light: '#ffffff' } as const;

/**
 * Whether text on a tinted card should be dark or light: the card colour as it renders, blended
 * over the theme surface at its opacity, against whichever of black or white contrasts more.
 */
export function profileCardInk(
  color: string | null,
  opacity: number | null,
  scheme: keyof typeof schemeSurface
): 'dark' | 'light' | undefined {
  if (!color) return undefined;
  const alpha = (opacity ?? profileCardOpacityDefault) / 100;
  const surface = hexChannels(schemeSurface[scheme]);
  const rendered = hexChannels(color).map(
    (channel, i) => channel * alpha + surface[i] * (1 - alpha)
  );
  const l = luminance(rendered);
  // Contrast with black is (l + .05) / .05, with white 1.05 / (l + .05); equal at l ≈ .179.
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? 'dark' : 'light';
}

/** A colour scaled towards black, for suggesting a sidebar colour from a bright image. */
export function darkenHex(hex: string, amount: number) {
  return `#${[1, 3, 5]
    .map((start) =>
      Math.round(parseInt(hex.slice(start, start + 2), 16) * (1 - amount))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

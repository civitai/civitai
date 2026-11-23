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

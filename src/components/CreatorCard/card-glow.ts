import type { CSSProperties } from 'react';
import type { CardGlow } from '~/server/selectors/cosmetic.selector';

// Cosmetic data is authored by hand, and a custom property takes any token stream, url() included.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DEFAULT_INTENSITY = 0.6;

/** The creator card's glow from a `CardDecoration`'s data, or null when it has no usable colour. */
export function cardGlowOf(data: unknown) {
  const glow = (data as { glow?: CardGlow } | null | undefined)?.glow;
  if (typeof glow?.color !== 'string' || !HEX_COLOR.test(glow.color)) return null;
  const raw = typeof glow.intensity === 'number' ? glow.intensity : DEFAULT_INTENSITY;
  const intensity = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : DEFAULT_INTENSITY));
  return {
    animated: glow.animated === true,
    style: {
      '--card-glow-color': glow.color,
      '--card-glow-size': `${Math.round(6 + 26 * intensity)}px`,
    } as CSSProperties,
  };
}

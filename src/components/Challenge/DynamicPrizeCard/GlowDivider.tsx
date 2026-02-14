import { getGlowGradient } from './constants';

type ColorVariant = 'teal' | 'yellow' | 'gray';

/** Cursor-tracking glow overlay positioned on top of a section's border-top. */
export function GlowDivider({ variant }: { variant: ColorVariant }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: -1,
        left: 0,
        right: 0,
        height: 1,
        background: getGlowGradient(variant),
        opacity: 'var(--spotlight-opacity)' as unknown as number,
        transition: 'opacity 0.5s ease',
        pointerEvents: 'none',
      }}
    />
  );
}

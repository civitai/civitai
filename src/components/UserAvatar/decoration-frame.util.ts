import type { CSSProperties } from 'react';
import type { CosmeticOffsets } from '~/server/schema/creator-shop.schema';

// Offsets are authored in pixels at this reference avatar size and rendered as
// percentages, so a frame looks identical on every surface (a 60px creator-card
// avatar and a ~112px profile-sidebar avatar included) instead of a raw pixel
// nudge that's proportionally huge on small avatars and invisible on large ones.
const DECORATION_OFFSET_BASE_SIZE = 96;

// Geometry for an avatar frame/decoration image rendered absolutely over the
// avatar. Per-side pixel `offsets` (creator-shop cosmetics) win over the legacy
// uniform `offset` string (official cosmetics); with neither, the frame matches
// the avatar box exactly. Negative offsets extend the frame outside the avatar
// (bigger); positive offsets inset it.
export function decorationFrameStyle(
  data: { offset?: string; offsets?: CosmeticOffsets } | null | undefined
): CSSProperties {
  const { offset, offsets } = data ?? {};
  if (offsets) {
    const pct = (px: number) => `${((px / DECORATION_OFFSET_BASE_SIZE) * 100).toFixed(3)}%`;
    return {
      position: 'absolute',
      maxWidth: 'none',
      top: pct(offsets.top),
      left: pct(offsets.left),
      width: `calc(100% - ${pct(offsets.left + offsets.right)})`,
      height: `calc(100% - ${pct(offsets.top + offsets.bottom)})`,
      transform: 'none',
    };
  }
  return {
    position: 'absolute',
    maxWidth: 'none',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    width: offset ? `calc(100% + ${offset})` : '100%',
    height: offset ? `calc(100% + ${offset})` : '100%',
  };
}

/**
 * `decorationFrameStyle` resolved to pixels for one avatar size, for a renderer without `calc()` or
 * `transform` (the og image's satori). Left and top are relative to the avatar box.
 */
export function decorationFrameBox(
  size: number,
  data: { offset?: string; offsets?: CosmeticOffsets } | null | undefined
) {
  const { offset, offsets } = data ?? {};
  if (offsets) {
    const px = (side: number) => (side / DECORATION_OFFSET_BASE_SIZE) * size;
    return {
      left: px(offsets.left),
      top: px(offsets.top),
      width: size - px(offsets.left + offsets.right),
      height: size - px(offsets.top + offsets.bottom),
    };
  }
  const grow = offset?.endsWith('%') ? (parseFloat(offset) / 100) * size : 0;
  const frame = size + (Number.isFinite(grow) ? grow : 0);
  return { left: (size - frame) / 2, top: (size - frame) / 2, width: frame, height: frame };
}

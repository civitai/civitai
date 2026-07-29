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

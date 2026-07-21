import type { CSSProperties } from 'react';
import type { CosmeticOffsets } from '~/server/schema/creator-shop.schema';

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
    return {
      position: 'absolute',
      maxWidth: 'none',
      top: `${offsets.top}px`,
      left: `${offsets.left}px`,
      width: `calc(100% - ${offsets.left + offsets.right}px)`,
      height: `calc(100% - ${offsets.top + offsets.bottom}px)`,
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

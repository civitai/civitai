import type { MinimizedPosition } from '~/store/music-player.store';

type Viewport = { width: number; height: number };
type Pixels = { left: number; top: number };

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0));

/** The top-left corner of a `size` square at `position`, held inside the viewport. */
export function positionToPixels(
  position: MinimizedPosition,
  viewport: Viewport,
  size: number
): Pixels {
  return {
    left: Math.round(clamp(position.x * viewport.width, viewport.width - size)),
    top: Math.round(clamp(position.y * viewport.height, viewport.height - size)),
  };
}

/** A dragged top-left corner as fractions of the viewport, clamped inside it first. */
export function pixelsToPosition(
  pixels: Pixels,
  viewport: Viewport,
  size: number
): MinimizedPosition {
  return {
    x: viewport.width > 0 ? clamp(pixels.left, viewport.width - size) / viewport.width : 0,
    y: viewport.height > 0 ? clamp(pixels.top, viewport.height - size) / viewport.height : 0,
  };
}

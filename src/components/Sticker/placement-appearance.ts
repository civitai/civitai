import type { CSSProperties } from 'react';

/**
 * The two things the placer chooses about their own sticker, as styles.
 *
 * Shared by the draft and the placed sticker so the preview is what gets bought:
 * a draft dressed differently from the thing it becomes is a preview of something
 * else, the same reason the treatment is applied to both.
 *
 * **Opacity goes on the artwork, and on the plate behind it, and nowhere else.**
 * Not on the wrapper: that would take the pending placement's dashed outline with
 * it, and the outline is the whole of "awaiting review" now. The artwork's shadow
 * and die-cut edge are its own `filter`, so they fade with it — a full-strength
 * shadow under faint artwork reads as a rendering fault rather than a choice, and
 * the plate is a surface the sticker sits on, so it belongs to the same object.
 *
 * The sway is deliberately untouched. Motion is the cue that survives fading, and
 * it is what keeps a faint sticker reading as a sticker rather than as part of
 * the artwork underneath.
 */
export function stickerArtworkStyle({
  flip,
  opacity,
}: {
  flip: boolean;
  opacity: number;
}): CSSProperties {
  return {
    opacity,
    // Mirrors the artwork alone. Flipping the positioned wrapper instead would
    // mirror the rotation with it, so dragging the rotate knob would turn the
    // sticker the opposite way once flipped.
    ...(flip ? { transform: 'scaleX(-1)' } : null),
  };
}

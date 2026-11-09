import type { StickerTrackFrame, StickerTrackPose } from '~/shared/utils/sticker-track';

type Pose = Omit<StickerTrackPose, 'show' | 'opacity'>;

/** Where a placed sticker sits in its media box. Shared so a moving sticker is drawn exactly as a still one. */
export const stickerPoseStyle = ({ x, y, scale, rotation }: Pose) => ({
  left: `${x * 100}%`,
  top: `${y * 100}%`,
  width: `${scale * 100}%`,
  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
});

/**
 * A track's frames as keyframes for `Element.animate`. Opacity goes in `filter`, not `opacity`:
 * the reveal holds and fades a sticker with `opacity`, and an animation of the same property
 * would override it rather than multiply.
 */
export const stickerTrackKeyframes = (frames: StickerTrackFrame[]): Keyframe[] =>
  frames.map(({ offset, easing, opacity, ...pose }) => ({
    offset,
    easing,
    ...stickerPoseStyle(pose),
    filter: `opacity(${opacity})`,
  }));

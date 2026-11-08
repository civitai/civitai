import type { StickerTrackPose } from '~/shared/utils/sticker-track';

type Pose = Omit<StickerTrackPose, 'show'>;

/** Where a placed sticker sits in its media box. Shared so a moving sticker is drawn exactly as a still one. */
export const stickerPoseStyle = ({ x, y, scale, rotation }: Pose) => ({
  left: `${x * 100}%`,
  top: `${y * 100}%`,
  width: `${scale * 100}%`,
  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
});

/** Marks inside a sticker that turn against its rotation so they read upright. */
export const COUNTER_ROTATE_ATTR = 'data-counter-rotate';

export const counterRotation = (rotation: number) => `rotate(${-rotation}deg)`;

/** Writes a pose straight to a placed sticker, for playback that must not render React every frame. */
export function writeStickerPose(node: HTMLElement, pose: Pose) {
  Object.assign(node.style, stickerPoseStyle(pose));
  node.querySelectorAll<HTMLElement>(`[${COUNTER_ROTATE_ATTR}]`).forEach((mark) => {
    mark.style.transform = counterRotation(pose.rotation);
  });
}

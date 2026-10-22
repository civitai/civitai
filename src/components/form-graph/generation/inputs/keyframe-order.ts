import { arrayMove } from '@dnd-kit/sortable';
import type { ImageObjectValue } from '~/shared/generation/values';

export type Flux3KeyframeEntry = { image?: ImageObjectValue; frameIndex: number };

export function nextFrameIndex(entries: Flux3KeyframeEntry[], maxFrame: number, fps: number) {
  const used = new Set(entries.map((e) => e.frameIndex));
  if (used.size === 0) return 0;
  let candidate = Math.min(maxFrame, Math.max(...used) + fps);
  while (used.has(candidate) && candidate > 0) candidate--;
  return candidate;
}

export const byFrame = (entries: Flux3KeyframeEntry[]) =>
  [...entries].sort((a, b) => a.frameIndex - b.frameIndex);

/** Swaps images between rows; the frame positions stay with the rows. */
export function swapImages(entries: Flux3KeyframeEntry[], from: number, to: number) {
  const frames = entries.map((e) => e.frameIndex);
  return arrayMove(entries, from, to).map((e, i) => ({ ...e, frameIndex: frames[i] }));
}

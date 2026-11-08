import type { StickerTrackSample } from '~/shared/utils/sticker-track';
import {
  STICKER_TRACK_DEFAULT_MS,
  STICKER_TRACK_MAX_DURATION_MS,
} from '~/shared/utils/sticker-track';

/** One pose per tick of the video, from its start: index `n` is `n * RECORDING_TICK_MS`. */
export type StickerRecording = StickerTrackSample[];

export const RECORDING_TICK_MS = STICKER_TRACK_DEFAULT_MS;
export const RECORDING_MAX_TICKS = STICKER_TRACK_MAX_DURATION_MS / RECORDING_TICK_MS;

/** Every 4th capture beats: 2.5 a second, under the three-flashes-a-second limit (WCAG 2.3.1). */
export const RECORDING_BEAT_EVERY = 4;

export const recordingTick = (timeMs: number) => Math.floor(timeMs / RECORDING_TICK_MS);

/**
 * The recording to capture into from `tick` on: what came before is kept, and everything after is
 * overwritten. Before the first take, the sticker holds its starting pose from the video's start.
 */
export function beginTake(
  recording: StickerRecording,
  tick: number,
  pose: StickerTrackSample
): StickerRecording {
  const kept = recording.slice(0, tick);
  const hold = kept.at(-1) ?? pose;
  while (kept.length < tick) kept.push(hold);
  kept.push(pose);
  return kept;
}

/** Fills every tick up to `tick` with `pose`. Returns how many captures that was. */
export function captureTo(recording: StickerRecording, tick: number, pose: StickerTrackSample) {
  const last = Math.min(tick, RECORDING_MAX_TICKS - 1);
  let captured = 0;
  while (recording.length <= last) {
    recording.push(pose);
    captured++;
  }
  return captured;
}

/** The recorded pose at a video time; past the end it holds the last one. */
export const recordingPoseAt = (recording: StickerRecording, timeMs: number) =>
  recording.length ? recording[Math.min(recordingTick(timeMs), recording.length - 1)] : undefined;

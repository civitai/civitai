import { describe, expect, test } from 'vitest';
import {
  beginTake,
  captureTo,
  RECORDING_MAX_TICKS,
  recordingPoseAt,
} from '~/components/Sticker/sticker-recording';

const at = (x: number) => ({ x, y: 0.5, scale: 0.2, rotation: 0 });

describe('recording a draft against the video', () => {
  test('a first take from mid-video holds the starting pose from the video start', () => {
    const take = beginTake([], 3, at(0.4));

    expect(take).toEqual([at(0.4), at(0.4), at(0.4), at(0.4)]);
  });

  test('a take from the playhead keeps what came before and drops what came after', () => {
    const recorded = [at(0.1), at(0.2), at(0.3), at(0.4), at(0.5)];

    const take = beginTake(recorded, 2, at(0.9));

    expect(take).toEqual([at(0.1), at(0.2), at(0.9)]);
  });

  test('a take from past the end holds the last recorded pose until it starts', () => {
    const take = beginTake([at(0.1), at(0.2)], 4, at(0.9));

    expect(take).toEqual([at(0.1), at(0.2), at(0.2), at(0.2), at(0.9)]);
  });

  test('a frame that skips ticks fills each of them, and counts every capture', () => {
    const take = [at(0.1)];

    expect(captureTo(take, 3, at(0.5))).toBe(3);
    expect(take).toEqual([at(0.1), at(0.5), at(0.5), at(0.5)]);
    expect(captureTo(take, 3, at(0.7))).toBe(0);
  });

  test('capture stops at the longest track the server accepts', () => {
    const take = [at(0.1)];

    captureTo(take, RECORDING_MAX_TICKS + 50, at(0.5));

    expect(take).toHaveLength(RECORDING_MAX_TICKS);
  });

  test('past the end of the recording the draft holds its last pose', () => {
    const recorded = [at(0.1), at(0.2)];

    expect(recordingPoseAt(recorded, 150)).toEqual(at(0.2));
    expect(recordingPoseAt(recorded, 9000)).toEqual(at(0.2));
    expect(recordingPoseAt(recorded, 0)).toEqual(at(0.1));
    expect(recordingPoseAt([], 0)).toBeUndefined();
  });
});

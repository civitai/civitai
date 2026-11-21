import { describe, expect, it } from 'vitest';
import type { StickerTrackV1 } from '~/shared/utils/sticker-track';
import { STICKER_TRACK_MAX_KEYS, stickerTrackRefusal } from '~/shared/utils/sticker-track';
import {
  autoTrackPollDelay,
  autoTrackRunKeys,
  fitAutoTrackKeys,
  mergeAutoTrackKeys,
} from '~/shared/utils/sticker-auto-track-keys';
import { stickerKeysTrack } from '~/shared/utils/sticker-track-edit';
import type { StickerTrackKey } from '~/shared/utils/sticker-track';

/** A run sampled every 250 ms: `n` ticks moving right, hidden over `hidden` ticks. */
function run(n: number, hidden?: [number, number], wobble = 0): StickerTrackV1 {
  const ticks = Array.from({ length: n }, (_, i) => i);
  return {
    v: 1,
    ms: 250,
    x: ticks.map((i) => [i, 0.1 + i * 0.002 + (i % 2 ? wobble : 0)]),
    y: [[0, 0.5]],
    s: [[0, 0.2]],
    r: [[0, 0]],
    ...(hidden
      ? {
          show: [
            [0, 1],
            [hidden[0], 0],
            [hidden[1], 1],
          ],
        }
      : null),
  };
}

const key = (t: number, x = 0.5, o = 1): StickerTrackKey => ({
  t,
  x,
  y: 0.5,
  s: 0.2,
  r: 0,
  o,
  ease: 'linear',
});

describe('autoTrackRunKeys', () => {
  it('puts tick 0 at the start time', () => {
    const keys = autoTrackRunKeys(run(4), 2000);
    expect(keys.map((k) => k.t)).toEqual([2000, 2250, 2500, 2750]);
    expect(keys[0].x).toBeCloseTo(0.1);
  });

  it('keeps moving up to the tick before a cut, where it jumps', () => {
    // x keyed only at its ends, so no channel would put a key before the hide by itself.
    const track: StickerTrackV1 = {
      ...run(1, [4, 6]),
      x: [
        [0, 0.1],
        [8, 0.5],
      ],
    };
    const keys = autoTrackRunKeys(track, 0);
    expect(keys.find((k) => k.t === 750)).toMatchObject({ ease: 'jump', o: 1 });
    expect(keys.find((k) => k.t === 750)!.x).toBeCloseTo(0.25);
    expect(keys.find((k) => k.t === 1000)).toMatchObject({ o: 0 });
  });

  it('cuts at a hide instead of fading, so long hidden spans pass the fade budget', () => {
    // Twenty hide and show pairs: as fades they would spend 40 x 250 ms = 10 s of fading.
    const show: [number, number][] = [];
    for (let i = 0; i < 20; i++) show.push([i * 4, 1], [i * 4 + 2, 0]);
    const keys = autoTrackRunKeys({ ...run(80), show }, 0);
    expect(keys.find((k) => k.t === 250)?.ease).toBe('jump');
    expect(stickerTrackRefusal(stickerKeysTrack(keys))).toBeNull();
  });
});

describe('fitAutoTrackKeys', () => {
  it('drops keys a straight line already draws', () => {
    const keys = autoTrackRunKeys(run(240), 0);
    const fitted = fitAutoTrackKeys(keys, 500);
    expect(fitted.map((k) => k.t)).toEqual([0, 239 * 250]);
  });

  it('keeps the keys either side of a hide', () => {
    const fitted = fitAutoTrackKeys(autoTrackRunKeys(run(40, [10, 20]), 0), 500);
    expect(fitted.map((k) => [k.t, k.o])).toEqual([
      [0, 1],
      [2250, 1],
      [2500, 0],
      [4750, 0],
      [5000, 1],
      [9750, 1],
    ]);
  });

  it('fits a jittery run into the room left', () => {
    const fitted = fitAutoTrackKeys(autoTrackRunKeys(run(240, undefined, 0.05), 0), 50);
    expect(fitted.length).toBeLessThanOrEqual(50);
    expect(fitted[0].t).toBe(0);
    expect(fitted.at(-1)!.t).toBe(239 * 250);
  });
});

describe('mergeAutoTrackKeys', () => {
  it('keeps keys before and after the run and replaces the ones it spans', () => {
    const existing = [key(0, 0.9), key(1000, 0.9), key(1500, 0.9), key(9000, 0.9)];
    const merged = mergeAutoTrackKeys(existing, run(9), 1000);
    expect(merged.map((k) => k.t)).toEqual([0, 1000, 3000, 9000]);
    expect(merged[1].x).toBeCloseTo(0.1);
  });

  it('stays under the key cap however many keys the draft has', () => {
    const existing = Array.from({ length: STICKER_TRACK_MAX_KEYS - 10 }, (_, i) => key(i * 10));
    const merged = mergeAutoTrackKeys(existing, run(240, undefined, 0.05), 10_000);
    expect(merged.length).toBeLessThanOrEqual(STICKER_TRACK_MAX_KEYS);
    expect(stickerTrackRefusal(stickerKeysTrack(merged))).toBeNull();
  });
});

describe('autoTrackPollDelay', () => {
  it('gives up after five minutes', () => {
    expect(autoTrackPollDelay(0)).toBe(3000);
    expect(autoTrackPollDelay(200_000)).toBe(6000);
    expect(autoTrackPollDelay(300_000)).toBeNull();
  });
});

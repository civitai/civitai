import { describe, expect, it } from 'vitest';
import type { StickerTrackV1 } from '~/shared/utils/sticker-track';
import { STICKER_TRACK_MAX_KEYS, stickerTrackRefusal } from '~/shared/utils/sticker-track';
import {
  autoTrackPollDelay,
  autoTrackRunKeys,
  discardAutoTrackKeys,
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

  it('keeps a turn a straight line would cut across', () => {
    // Right for two seconds, then down: the corner is the only key a line between the ends misses.
    const corner: StickerTrackV1 = {
      v: 1,
      ms: 250,
      x: [
        [0, 0.1],
        [8, 0.5],
      ],
      y: [
        [0, 0.1],
        [8, 0.1],
        [16, 0.5],
      ],
      s: [[0, 0.2]],
      r: [[0, 0]],
    };
    const fitted = fitAutoTrackKeys(autoTrackRunKeys(corner, 0), 500);
    expect(fitted.map((k) => k.t)).toEqual([0, 2000, 4000]);
  });

  it('keeps the first and last key when only the cuts fit, and never exceeds the room', () => {
    const cuts = {
      ...run(1),
      show: Array.from({ length: 240 }, (_, i) => [i, i % 2 ? 0 : 1]),
    } as StickerTrackV1;
    const keys = autoTrackRunKeys(
      {
        ...cuts,
        x: [
          [0, 0.1],
          [239, 0.5],
        ],
      },
      0
    );
    const fitted = fitAutoTrackKeys(keys, 100);
    expect(fitted).toHaveLength(100);
    expect(fitted[0]).toBe(keys[0]);
    expect(fitted.at(-1)).toBe(keys.at(-1));
    expect(fitAutoTrackKeys(keys, 1)).toHaveLength(1);
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
    const merged = mergeAutoTrackKeys(existing, run(9), 1000)!;
    expect(merged.keys.map((k) => k.t)).toEqual([0, 1000, 3000, 9000]);
    expect(merged.keys[1].x).toBeCloseTo(0.1);
    expect(merged).toMatchObject({ startMs: 1000, endMs: 3000 });
  });

  it('leaves room for the keys on both sides of the run', () => {
    const before = Array.from({ length: 200 }, (_, i) => key(i * 10));
    const after = Array.from({ length: 200 }, (_, i) => key(70_000 + i * 10));
    const cuts = {
      ...run(1),
      x: [
        [0, 0.1],
        [239, 0.5],
      ],
      show: Array.from({ length: 240 }, (_, i) => [i, i % 2 ? 0 : 1]),
    } as StickerTrackV1;
    const merged = mergeAutoTrackKeys([...before, ...after], cuts, 2000)!;
    expect(merged.keys).toHaveLength(STICKER_TRACK_MAX_KEYS);
    expect(merged.keys.filter((k) => k.t < 2000)).toEqual(before);
    expect(merged.keys.filter((k) => k.t > merged.endMs)).toEqual(after);
    expect(stickerTrackRefusal(stickerKeysTrack(merged.keys))).toBeNull();
  });

  it('refuses a run when the keys outside it already fill the cap', () => {
    const existing = Array.from({ length: STICKER_TRACK_MAX_KEYS }, (_, i) => key(i * 10));
    expect(mergeAutoTrackKeys(existing, run(9), 10_000)).toBeNull();
  });

  it('cuts where the run meets a hidden key of the placer, instead of fading for seconds', () => {
    // The placer hid the sticker at 20 s; a shown run ending at 3 s would fade over 17 s.
    const merged = mergeAutoTrackKeys([key(0, 0.5, 0), key(20_000, 0.5, 0)], run(9), 1000)!;
    expect(merged.keys[0].ease).toBe('jump');
    expect(merged.keys.at(-2)).toMatchObject({ t: 3000, ease: 'jump' });
    expect(stickerTrackRefusal(stickerKeysTrack(merged.keys))).toBeNull();
  });
});

describe('discardAutoTrackKeys', () => {
  it('puts back the keys the run replaced and keeps edits made outside it', () => {
    const previous = [key(0), key(2000, 0.9)];
    const current = [key(0, 0.3), key(1000), key(1500), key(3000), key(8000)];
    expect(
      discardAutoTrackKeys(current, previous, { startMs: 1000, endMs: 3000 }).map((k) => [k.t, k.x])
    ).toEqual([
      [0, 0.3],
      [2000, 0.9],
      [8000, 0.5],
    ]);
  });
});

describe('autoTrackPollDelay', () => {
  it('bounds the reads a run makes, and stops after five minutes', () => {
    let reads = 0;
    for (
      let t = 0, delay = autoTrackPollDelay(0);
      delay !== null;
      t += delay, delay = autoTrackPollDelay(t)
    )
      reads++;
    expect(reads).toBeLessThanOrEqual(80);
    expect(autoTrackPollDelay(299_999)).not.toBeNull();
    expect(autoTrackPollDelay(300_000)).toBeNull();
  });
});

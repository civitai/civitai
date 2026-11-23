import { describe, expect, it } from 'vitest';
import type { StickerTrackV1 } from '~/shared/utils/sticker-track';
import {
  STICKER_TRACK_MAX_KEYS,
  sampleStickerTrack,
  stickerTrackRefusal,
} from '~/shared/utils/sticker-track';
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

describe('autoTrackRunKeys at scene cuts', () => {
  // Shaped on a tester's clip: 250 ms ticks, fast motion moves up to ~0.08 a tick, the cut 0.15.
  const leap = (dy: number): StickerTrackV1 => ({
    v: 1,
    ms: 250,
    x: [
      [0, 0.5],
      [1, 0.55],
      [2, 0.6],
      [3, 0.62],
    ],
    y: [
      [0, 0.3],
      [1, 0.3],
      [2, 0.3 - dy],
      [3, 0.3 - dy],
    ],
    s: [[0, 0.2]],
    r: [[0, 0]],
  });

  it('snaps across a cut instead of gliding through it', () => {
    const keys = autoTrackRunKeys(leap(0.15), 0);
    expect(keys.map((k) => k.ease)).toEqual(['linear', 'jump', 'linear', 'linear']);
    // Partway through the cut's tick it still sits where it was, not on its way to the new spot.
    expect(sampleStickerTrack(stickerKeysTrack(keys), 400).y).toBeCloseTo(0.3);
  });

  it('glides through fast motion that is not a cut', () => {
    const keys = autoTrackRunKeys(leap(0.06), 0);
    expect(keys.every((k) => k.ease === 'linear')).toBe(true);
  });

  it('snaps when the subject jumps in size, as a cut to a close-up does', () => {
    const track: StickerTrackV1 = {
      ...run(4),
      s: [
        [0, 0.2],
        [1, 0.2],
        [2, 0.35],
      ],
    };
    expect(autoTrackRunKeys(track, 0)[1].ease).toBe('jump');
  });

  it('scales the cut distance with longer ticks', () => {
    // At 500 ms a tick, 0.15 of the frame is fast motion; 0.3 is still a cut.
    const at500 = (dy: number) => ({ ...leap(dy), ms: 500 });
    expect(autoTrackRunKeys(at500(0.15), 0).every((k) => k.ease === 'linear')).toBe(true);
    expect(autoTrackRunKeys(at500(0.3), 0)[1].ease).toBe('jump');
  });

  it('glides across a leap spread over several ticks', () => {
    // Keyed two ticks apart: the tracker reports a slide, not a cut.
    const track: StickerTrackV1 = {
      ...leap(0),
      x: [
        [0, 0.5],
        [2, 0.7],
      ],
      y: [[0, 0.3]],
    };
    expect(autoTrackRunKeys(track, 0).every((k) => k.ease === 'linear')).toBe(true);
  });

  it('hides a one-tick flash between hides', () => {
    const track: StickerTrackV1 = {
      ...run(12),
      show: [
        [0, 1],
        [4, 0],
        [7, 1],
        [8, 0],
        [10, 1],
      ],
    };
    const keys = autoTrackRunKeys(track, 0);
    expect(keys.filter((k) => k.t >= 1000 && k.t < 2500).every((k) => k.o === 0)).toBe(true);
    expect(keys.find((k) => k.t === 2500)?.o).toBe(1);
  });

  it('measures a sighting from its start when the tracker repeats a shown entry', () => {
    const track: StickerTrackV1 = {
      ...run(6),
      show: [
        [0, 1],
        [2, 1],
        [3, 0],
      ],
    };
    expect(autoTrackRunKeys(track, 0).find((k) => k.t === 500)?.o).toBe(1);
  });

  it('keeps a sighting long enough to see', () => {
    const track: StickerTrackV1 = {
      ...run(12),
      show: [
        [0, 1],
        [4, 0],
        [6, 1],
        [8, 0],
        [10, 1],
      ],
    };
    expect(autoTrackRunKeys(track, 0).find((k) => k.t === 1500)?.o).toBe(1);
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
      // Shown and hidden 500 ms at a time, so none is a flash.
      show: Array.from({ length: 240 }, (_, i) => [i * 2, i % 2 ? 0 : 1]),
    } as StickerTrackV1;
    const keys = autoTrackRunKeys(
      {
        ...cuts,
        x: [
          [0, 0.1],
          [479, 0.5],
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
    const after = Array.from({ length: 200 }, (_, i) => key(130_000 + i * 10));
    const cuts = {
      ...run(1),
      x: [
        [0, 0.1],
        [479, 0.5],
      ],
      // Shown and hidden 500 ms at a time, so none is a flash.
      show: Array.from({ length: 240 }, (_, i) => [i * 2, i % 2 ? 0 : 1]),
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
    // Capped, so a schedule that never ends fails here instead of hanging the run.
    for (
      let t = 0, delay = autoTrackPollDelay(0);
      delay !== null && reads <= 200;
      t += delay, delay = autoTrackPollDelay(t)
    )
      reads++;
    expect(reads).toBeLessThanOrEqual(80);
    expect(autoTrackPollDelay(299_999)).not.toBeNull();
    expect(autoTrackPollDelay(300_000)).toBeNull();
  });
});

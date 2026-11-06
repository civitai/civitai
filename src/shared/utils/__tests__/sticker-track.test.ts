import { describe, expect, it } from 'vitest';
import type { StickerTrack, StickerTrackSample } from '~/shared/utils/sticker-track';
import {
  encodeStickerTrack,
  sampleStickerTrack,
  STICKER_TRACK_MAX_BYTES,
  stickerTrackRefusal,
} from '~/shared/utils/sticker-track';

const pose = (x: number, overrides: Partial<StickerTrackSample> = {}): StickerTrackSample => ({
  x,
  y: 0.5,
  scale: 0.2,
  rotation: 0,
  ...overrides,
});

describe('encodeStickerTrack', () => {
  it('keeps the end of a hold, so the sticker waits and then moves', () => {
    // Held at 0.1 for ticks 0-4, then moves to 0.5 at tick 5.
    const track = encodeStickerTrack([0.1, 0.1, 0.1, 0.1, 0.1, 0.5].map((x) => pose(x)));
    expect(track.x).toEqual([
      [0, 0.1],
      [4, 0.1],
      [5, 0.5],
    ]);
    // Without the end-of-hold pair this would read 0.26 halfway through the hold.
    expect(sampleStickerTrack(track, 200).x).toBe(0.1);
    expect(sampleStickerTrack(track, 450).x).toBeCloseTo(0.3);
  });

  it('collapses a channel that never changes to one pair', () => {
    const track = encodeStickerTrack([0.1, 0.2, 0.3].map((x) => pose(x)));
    expect(track.y).toEqual([[0, 0.5]]);
    expect(track.show).toBeUndefined();
  });

  it('records a hidden window as change points only, and keeps a track hidden throughout', () => {
    const hidden = (show: boolean) => pose(0.1, { show });
    const window = encodeStickerTrack([true, true, false, false, true].map(hidden));
    expect(window.show).toEqual([
      [0, 1],
      [2, 0],
      [4, 1],
    ]);
    expect(sampleStickerTrack(window, 300).show).toBe(false);
    expect(sampleStickerTrack(window, 400).show).toBe(true);

    const never = encodeStickerTrack([false, false].map(hidden));
    expect(never.show).toEqual([[0, 0]]);
    expect(sampleStickerTrack(never, 0).show).toBe(false);
  });

  it('round-trips a recorded path through sampling at every tick', () => {
    const samples = Array.from({ length: 50 }, (_, i) =>
      pose(0.5 + 0.4 * Math.sin(i / 5), { rotation: (i * 13) % 360, scale: 0.1 + i / 500 })
    );
    const track = encodeStickerTrack(samples);
    samples.forEach((sample, i) => {
      const got = sampleStickerTrack(track, i * 100);
      expect(got.x).toBeCloseTo(sample.x, 3);
      expect(got.scale).toBeCloseTo(sample.scale, 3);
      // Stored wrapped into [-180, 180).
      expect((((got.rotation - sample.rotation) % 360) + 360) % 360).toBeCloseTo(0, 1);
    });
    expect(stickerTrackRefusal(track)).toBeNull();
  });
});

describe('sampleStickerTrack', () => {
  const base: StickerTrack = {
    v: 1,
    ms: 100,
    x: [[0, 0.5]],
    y: [[0, 0.5]],
    s: [[0, 0.2]],
    r: [
      [0, 170],
      [10, -170],
    ],
  };

  it('turns rotation the short way across ±180', () => {
    // 170 → -170 is 20° through 180, not 340° through 0.
    expect(Math.abs(sampleStickerTrack(base, 500).rotation)).toBeCloseTo(180);
  });

  it('holds the last pose after the track ends', () => {
    expect(sampleStickerTrack(base, 60_000).rotation).toBe(-170);
  });

  it('shows a moment sticker only inside its window', () => {
    const moment: StickerTrack = {
      ...base,
      show: [
        [0, 0],
        [50, 1],
        [60, 0],
      ],
    };
    expect(sampleStickerTrack(moment, 4900).show).toBe(false);
    expect(sampleStickerTrack(moment, 5500).show).toBe(true);
    expect(sampleStickerTrack(moment, 6000).show).toBe(false);
  });
});

describe('stickerTrackRefusal', () => {
  const ok = encodeStickerTrack([pose(0.1), pose(0.2)]);

  it.each<[string, StickerTrack, RegExp]>([
    [
      'ticks out of order',
      {
        ...ok,
        x: [
          [0, 0.1],
          [3, 0.2],
          [2, 0.3],
        ],
      },
      /x: ticks must increase/,
    ],
    [
      'repeated tick',
      {
        ...ok,
        x: [
          [0, 0.1],
          [1, 0.2],
          [1, 0.3],
        ],
      },
      /x: ticks must increase/,
    ],
    ['not starting at zero', { ...ok, x: [[1, 0.1]] }, /x: must start at tick 0/],
    ['show not starting at zero', { ...ok, show: [[2, 1]] }, /show: must start at tick 0/],
    [
      'a fractional tick',
      {
        ...ok,
        x: [
          [0, 0.1],
          [1.5, 0.2],
        ],
      },
      /x: tick out of range/,
    ],
    ['x off the image', { ...ok, x: [[0, 1.2]] }, /x: out of bounds/],
    [
      'scale over the ceiling',
      {
        ...ok,
        s: [
          [0, 0.2],
          [5, 0.9],
        ],
      },
      /s: out of bounds/,
    ],
    ['rotation past 180', { ...ok, r: [[0, 181]] }, /r: out of bounds/],
    ['a non-finite value', { ...ok, y: [[0, Number.NaN]] }, /y: not a number/],
    ['show not binary', { ...ok, show: [[0, 0.5]] }, /show: must be 0 or 1/],
    [
      'tick past the longest video',
      {
        ...ok,
        x: [
          [0, 0.1],
          [5000, 0.2],
        ],
      },
      /x: tick out of range/,
    ],
    ['empty channel', { ...ok, y: [] }, /y: empty/],
    ['a zero capture rate', { ...ok, ms: 0 }, /capture rate/],
    ['a capture rate under the floor', { ...ok, ms: 5 }, /capture rate/],
    ['a capture rate over a second', { ...ok, ms: 2000 }, /capture rate/],
    ['an unknown version', { ...ok, v: 2 as 1 }, /version/],
  ])('refuses %s', (_, track, reason) => {
    expect(stickerTrackRefusal(track)).toMatch(reason);
  });

  it('refuses a track over the size limit', () => {
    const x = Array.from({ length: 14_000 }, (_, i): [number, number] => [i, (i % 2) * 0.5]);
    const track = { ...ok, ms: 20, x };
    expect(JSON.stringify(track).length).toBeGreaterThan(STICKER_TRACK_MAX_BYTES);
    expect(stickerTrackRefusal(track)).toMatch(/too long/);
  });
});

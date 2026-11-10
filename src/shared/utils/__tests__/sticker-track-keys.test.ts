import { describe, expect, it } from 'vitest';
import { createStickerPlacementSchema } from '~/server/schema/placement.schema';
import type {
  StickerTrackEase,
  StickerTrackKey,
  StickerTrackV2,
} from '~/shared/utils/sticker-track';
import {
  momentStickerTrack,
  sampleStickerTrack,
  STICKER_TRACK_MAX_FADE_MS,
  STICKER_TRACK_MAX_FAINT_MS,
  STICKER_TRACK_MAX_KEYS,
  stickerTrackAnimates,
  stickerTrackFrames,
  stickerTrackMaxScale,
  stickerTrackRefusal,
} from '~/shared/utils/sticker-track';

const key = (t: number, overrides: Partial<StickerTrackKey> = {}): StickerTrackKey => ({
  t,
  x: 0.2,
  y: 0.5,
  s: 0.2,
  r: 0,
  o: 1,
  ease: 'linear',
  ...overrides,
});

/** From x 0.2 at 1 s to x 0.6 at 3 s, with `ease`; holds before and after. */
const slide = (ease: StickerTrackEase): StickerTrackV2 => ({
  v: 2,
  keys: [key(1000, { ease }), key(3000, { x: 0.6 })],
});

describe('sampleStickerTrack on keys', () => {
  it('lands on each key exactly, and holds the first before it and the last after', () => {
    const track = slide('smooth');
    expect(sampleStickerTrack(track, 0).x).toBe(0.2);
    expect(sampleStickerTrack(track, 1000).x).toBe(0.2);
    expect(sampleStickerTrack(track, 3000).x).toBe(0.6);
    expect(sampleStickerTrack(track, 60_000).x).toBe(0.6);
  });

  it('travels to the next key by the ease of the key it leaves', () => {
    const halfway = (ease: StickerTrackEase) => sampleStickerTrack(slide(ease), 2000).x;
    expect(halfway('linear')).toBeCloseTo(0.4);
    // Smooth is symmetric, so halfway in time is halfway in space.
    expect(halfway('smooth')).toBeCloseTo(0.4);
    expect(halfway('in')).toBeLessThan(0.33);
    expect(halfway('out')).toBeGreaterThan(0.47);
    // Jump holds until the next key, then snaps.
    expect(halfway('jump')).toBe(0.2);
    expect(sampleStickerTrack(slide('jump'), 2999).x).toBe(0.2);
    expect(sampleStickerTrack(slide('jump'), 3000).x).toBe(0.6);
  });

  it('fades by the same ease, and counts as hidden only at zero', () => {
    const fade: StickerTrackV2 = { v: 2, keys: [key(0), key(1000, { o: 0 })] };
    expect(stickerTrackRefusal(fade)).toBeNull();
    expect(sampleStickerTrack(fade, 500)).toMatchObject({ opacity: 0.5, show: true });
    expect(sampleStickerTrack(fade, 1000)).toMatchObject({ opacity: 0, show: false });
  });

  it('turns the short way across ±180', () => {
    const spin: StickerTrackV2 = { v: 2, keys: [key(0, { r: 170 }), key(1000, { r: -170 })] };
    expect(Math.abs(sampleStickerTrack(spin, 500).rotation)).toBeCloseTo(180);
    expect(sampleStickerTrack(spin, 250).rotation).toBeCloseTo(175);
  });
});

describe('stickerTrackFrames', () => {
  /** The pose the frames draw at `t`, interpolated linearly as a browser does between `linear` frames. */
  const framesAgreeWithSampling = (track: Parameters<typeof stickerTrackFrames>[0]) => {
    const { duration, frames } = stickerTrackFrames(track);
    expect(frames[0].offset).toBe(0);
    expect(frames[frames.length - 1].offset).toBe(1);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      // At a shared offset the later frame is the one in force from that time on.
      if (frames[i + 1]?.offset === frame.offset) continue;
      const pose = sampleStickerTrack(track, frame.offset * duration);
      expect(frame.x).toBeCloseTo(pose.x);
      expect(frame.scale).toBeCloseTo(pose.scale);
      expect(frame.opacity).toBe(pose.opacity);
      expect((((frame.rotation - pose.rotation) % 360) + 360) % 360).toBeCloseTo(0);
    }
  };

  it('starts a track whose first key is late with that key, so the start holds', () => {
    const { duration, frames } = stickerTrackFrames(slide('smooth'));
    expect(duration).toBe(3000);
    expect(frames.map((frame) => [frame.offset, frame.x])).toEqual([
      [0, 0.2],
      [1000 / 3000, 0.2],
      [1, 0.6],
    ]);
    expect(frames[1].easing).toBe('cubic-bezier(0.45, 0, 0.55, 1)');
    framesAgreeWithSampling(slide('smooth'));
  });

  it('unwraps rotation, so the browser turns the short way too', () => {
    const spin: StickerTrackV2 = { v: 2, keys: [key(0, { r: 170 }), key(1000, { r: -170 })] };
    expect(stickerTrackFrames(spin).frames.map((frame) => frame.rotation)).toEqual([170, 190]);
  });

  it('plays a v1 moment sticker as an instant show and hide', () => {
    const moment = momentStickerTrack({ x: 0.3, y: 0.3, scale: 0.2, rotation: 0 }, 1000, 1000);
    const { duration, frames } = stickerTrackFrames(moment);
    expect(frames.map((frame) => [frame.offset * duration, frame.opacity])).toEqual([
      [0, 0],
      [1000, 0],
      [1000, 1],
      [2000, 1],
      [2000, 0],
    ]);
    framesAgreeWithSampling(moment);
  });

  it('gives a single key a duration, so the animation can be built', () => {
    const { duration, frames } = stickerTrackFrames({ v: 2, keys: [key(0, { o: 0.5 })] });
    expect(duration).toBe(1);
    expect(frames.map((frame) => frame.offset)).toEqual([0, 1]);
  });
});

describe('what the player and the size limit see in keys', () => {
  it('animates a track that only fades, and one held at partial opacity', () => {
    expect(stickerTrackAnimates({ v: 2, keys: [key(0), key(1000, { o: 0 })] })).toBe(true);
    expect(stickerTrackAnimates({ v: 2, keys: [key(0, { o: 0.4 })] })).toBe(true);
    expect(stickerTrackAnimates({ v: 2, keys: [key(0), key(1000)] })).toBe(false);
  });

  it('takes the largest scale of any key', () => {
    expect(
      stickerTrackMaxScale({ v: 2, keys: [key(0, { s: 0.3 }), key(10, { s: 0.9 }), key(20)] })
    ).toBe(0.9);
  });
});

/** `n` longest fades back to back, alternating in and out, each `gap` ms after the last. */
const fades = (n: number, gap = 0) =>
  Array.from({ length: n + 1 }, (_, i) =>
    key(i * (STICKER_TRACK_MAX_FADE_MS + gap), { o: i % 2 ? 1 : 0, ease: 'smooth' })
  );

describe('stickerTrackRefusal on keys', () => {
  const ok: StickerTrackV2 = { v: 2, keys: [key(0), key(500, { x: 0.8 })] };

  it('accepts keys in increasing time', () => {
    expect(stickerTrackRefusal(ok)).toBeNull();
  });

  it.each<[string, StickerTrackKey[], RegExp]>([
    ['no keys', [], /keys: empty/],
    ['times out of order', [key(500), key(0)], /times must increase/],
    ['a repeated time', [key(500), key(500)], /times must increase/],
    ['a fractional time', [key(0.5)], /time out of range/],
    ['a time past the longest video', [key(300_001)], /time out of range/],
    ['opacity above 1', [key(0, { o: 1.2 })], /o out of bounds/],
    ['a shown key fainter than a still sticker may be', [key(0, { o: 0.1 })], /o too faint/],
    ['a position off the media', [key(0, { x: -0.1 })], /x out of bounds/],
    ['an unknown ease', [key(0, { ease: 'bounce' as StickerTrackEase })], /unknown ease/],
    ['a long fade in', [key(0, { o: 0, ease: 'smooth' }), key(10_000)], /fade too long/],
    ['a long fade out', [key(0, { ease: 'smooth' }), key(10_000, { o: 0 })], /fade too long/],
    [
      'a fade just past the limit',
      [key(0, { o: 0, ease: 'smooth' }), key(STICKER_TRACK_MAX_FADE_MS + 1)],
      /fade too long/,
    ],
    [
      'short fades that add up past the limit',
      fades(STICKER_TRACK_MAX_FAINT_MS / STICKER_TRACK_MAX_FADE_MS + 1),
      /too much fading/,
    ],
    [
      'too many keys',
      Array.from({ length: STICKER_TRACK_MAX_KEYS + 1 }, (_, i) => key(i)),
      /too many keys/,
    ],
  ])('refuses %s', (_, keys, message) => {
    expect(stickerTrackRefusal({ v: 2, keys })).toMatch(message);
  });

  // A fade can spend all of its time below the floor, so how long it lasts bounds how long the
  // sticker stays faint; jump and two hidden keys never draw it faint at all.
  it.each<[string, StickerTrackKey[]]>([
    ['the longest fade', [key(0, { o: 0, ease: 'smooth' }), key(STICKER_TRACK_MAX_FADE_MS)]],
    ['a long jump out of hiding', [key(0, { o: 0, ease: 'jump' }), key(10_000)]],
    ['a long jump into hiding', [key(0, { ease: 'jump' }), key(10_000, { o: 0 })]],
    ['a long gap between hidden keys', [key(0, { o: 0 }), key(10_000, { o: 0 })]],
    ['a long glide between shown keys', [key(0, { o: 0.4 }), key(10_000, { x: 0.8 })]],
    [
      'fades that add up to the limit',
      fades(STICKER_TRACK_MAX_FAINT_MS / STICKER_TRACK_MAX_FADE_MS),
    ],
  ])('accepts %s', (_, keys) => {
    expect(stickerTrackRefusal({ v: 2, keys })).toBeNull();
  });

  it('is enforced by the create schema', () => {
    const parse = (track: unknown) =>
      createStickerPlacementSchema.safeParse({
        imageId: 74,
        data: { cosmeticId: 9, x: 0.2, y: 0.5, scale: 0.2, rotation: 0 },
        track,
      });
    expect(parse(ok).success).toBe(true);
    const late = parse({ v: 2, keys: [key(500), key(0)] });
    expect(late.success).toBe(false);
    expect(late.error?.issues[0].message).toMatch(/^track: keys: times must increase/);
    expect(parse({ v: 2, keys: [{ ...key(0), ease: 'bounce' }] }).success).toBe(false);
    expect(parse({ v: 3, keys: [key(0)] }).success).toBe(false);
    const faint = parse({
      v: 2,
      keys: fades(STICKER_TRACK_MAX_FAINT_MS / STICKER_TRACK_MAX_FADE_MS + 1),
    });
    expect(faint.error?.issues[0].message).toMatch(/^track: keys: too much fading/);
    const long = parse({ v: 2, keys: [key(0, { o: 0, ease: 'smooth' }), key(10_000)] });
    expect(long.error?.issues[0].message).toMatch(/^track: keys: fade too long/);
  });
});

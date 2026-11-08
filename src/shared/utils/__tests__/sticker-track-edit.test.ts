import { describe, expect, it } from 'vitest';
import type { StickerTrackKey } from '~/shared/utils/sticker-track';
import {
  sampleStickerTrack,
  STICKER_TRACK_MAX_FADE_MS,
  stickerTrackRefusal,
} from '~/shared/utils/sticker-track';
import {
  capFades,
  editKey,
  keyIndexAt,
  poseAt,
  stickerKeysTrack,
  upsertKey,
} from '~/shared/utils/sticker-track-edit';

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

describe('upsertKey', () => {
  const keys = [key(1000), key(3000, { x: 0.6, o: 0.5 })];

  it('updates the key under the playhead rather than adding a second one beside it', () => {
    const next = upsertKey(keys, 1030, { x: 0.9 });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ t: 1000, x: 0.9 });
  });

  it('adds a key between two without changing the motion around it', () => {
    const before = sampleStickerTrack({ v: 2, keys }, 2000);
    const next = upsertKey(keys, 2000, { y: 0.1 });
    expect(next.map((k) => k.t)).toEqual([1000, 2000, 3000]);
    expect(next[1]).toMatchObject({ x: before.x, y: 0.1, o: before.opacity, ease: 'linear' });
  });

  it('starts a track from nothing at the pose given', () => {
    expect(upsertKey([], 500, { x: 0.3, y: 0.4, scale: 0.5, rotation: 10 })).toEqual([
      { t: 500, x: 0.3, y: 0.4, s: 0.5, r: 10, o: 1, ease: 'smooth' },
    ]);
  });
});

describe('editKey', () => {
  it('re-sorts a key retimed past its neighbour, and refuses to land on another key', () => {
    const keys = [key(0), key(1000, { x: 0.8 })];
    expect(editKey(keys, 0, { t: 1500 }).map((k) => k.x)).toEqual([0.8, 0.2]);
    expect(editKey(keys, 0, { t: 1000 })).toBe(keys);
  });
});

describe('keyIndexAt', () => {
  it('finds the nearest key within half a frame, and none further away', () => {
    const keys = [key(1000), key(1080)];
    expect(keyIndexAt(keys, 1050)).toBe(1);
    expect(keyIndexAt(keys, 1200)).toBe(-1);
  });
});

describe('capFades', () => {
  // A 10 s fade in is what the editor lets a placer make by putting keys far apart.
  const longFade = [key(0, { o: 0, ease: 'smooth' }), key(10_000, { x: 0.8 })];

  it('turns a long fade into one the server accepts', () => {
    expect(stickerTrackRefusal({ v: 2, keys: longFade })).toMatch(/fade too long/);
    expect(stickerTrackRefusal(stickerKeysTrack(longFade))).toBeNull();
  });

  it('still reaches every key at its time, and the preview draws what is sent', () => {
    const capped = capFades(longFade);
    expect(capped.map((k) => k.t)).toEqual([0, 8000, 10_000]);
    expect(poseAt(longFade, 10_000)).toEqual({
      pose: { x: 0.8, y: 0.5, scale: 0.2, rotation: 0 },
      opacity: 1,
    });
    expect(poseAt(longFade, 7000).opacity).toBe(0);
  });

  it('leaves short fades and jumps alone', () => {
    const keys = [key(0, { o: 0, ease: 'jump' }), key(10_000), key(11_000, { o: 0 })];
    expect(capFades(keys)).toEqual(keys);
    const longest = [key(0, { o: 0, ease: 'smooth' }), key(STICKER_TRACK_MAX_FADE_MS)];
    expect(capFades(longest)).toEqual(longest);
  });
});

describe('upsertKey inside a fade', () => {
  // A linear fade in over 2 s: opacity is t / 2000 on screen.
  const fadeIn = [key(0, { o: 0 }), key(2000)];
  const added = (keys: StickerTrackKey[], t: number) =>
    upsertKey(keys, t, { x: 0.4 }).find((k) => k.t === t);

  it('gives a new key an opacity the server accepts, nearest to what is on screen', () => {
    expect(added(fadeIn, 200)?.o).toBe(0);
    expect(added(fadeIn, 400)?.o).toBe(0.3);
    expect(added(fadeIn, 1000)?.o).toBeCloseTo(0.5);
    for (const t of [200, 400, 1000])
      expect(stickerTrackRefusal(stickerKeysTrack(upsertKey(fadeIn, t, { x: 0.4 })))).toBeNull();
  });

  it('samples the fade the preview draws, not the uncapped one', () => {
    // Capped, this 10 s fade waits hidden until 8 s, so at 7 s the sticker is not on screen.
    const longFade = [key(0, { o: 0 }), key(10_000)];
    expect(poseAt(longFade, 7000).opacity).toBe(0);
    expect(added(longFade, 7000)?.o).toBe(0);
  });
});

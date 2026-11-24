import { describe, expect, it } from 'vitest';
import { formatPlaybackTime, storedSongDurationSec } from '../song-time';

describe('storedSongDurationSec', () => {
  it("reads a song's stored length in seconds", () => {
    expect(storedSongDurationSec(183.4)).toBe(183.4);
  });

  it('reads anything but a positive, finite number as unknown', () => {
    for (const stored of [undefined, null, '183', 0, -5, Number.NaN, Infinity])
      expect({ stored, sec: storedSongDurationSec(stored) }).toEqual({ stored, sec: null });
  });
});

describe('formatPlaybackTime', () => {
  it('reads m:ss, seconds rounded down', () => {
    expect(formatPlaybackTime(83.9)).toBe('1:23');
    expect(formatPlaybackTime(5)).toBe('0:05');
    expect(formatPlaybackTime(600)).toBe('10:00');
  });

  it('reads an unknown or negative time as 0:00', () => {
    for (const seconds of [Number.NaN, Infinity, -3])
      expect(formatPlaybackTime(seconds)).toBe('0:00');
  });
});

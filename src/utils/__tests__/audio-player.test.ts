import { describe, expect, it } from 'vitest';
import { formatPlaybackTime } from '~/utils/audio-player';

describe('formatPlaybackTime', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [192, '3:12'],
    [600, '10:00'],
  ])('shows %s seconds as %s', (seconds, expected) => {
    expect(formatPlaybackTime(seconds)).toBe(expected);
  });

  it.each([NaN, Infinity, -3])('shows an unknown time (%s) as 0:00', (seconds) => {
    expect(formatPlaybackTime(seconds)).toBe('0:00');
  });
});

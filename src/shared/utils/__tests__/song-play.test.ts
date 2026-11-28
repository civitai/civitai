import { describe, expect, it } from 'vitest';
import { isCountablePlay, songPlayThresholdSec } from '~/shared/utils/song-play';

describe('isCountablePlay', () => {
  it('counts 30 s of a long song and not a moment less', () => {
    expect(isCountablePlay(29.9, 200)).toBe(false);
    expect(isCountablePlay(30, 200)).toBe(true);
  });

  it('counts a song shorter than 30 s once it has played in full', () => {
    expect(isCountablePlay(12, 12)).toBe(true);
    expect(isCountablePlay(11, 12)).toBe(false);
  });

  it('falls back to 30 s when the duration is unknown, zero or not a number', () => {
    for (const duration of [undefined, null, 0, NaN, -5, Infinity]) {
      expect(songPlayThresholdSec(duration)).toBe(30);
      expect(isCountablePlay(29.9, duration)).toBe(false);
      expect(isCountablePlay(30, duration)).toBe(true);
    }
  });

  it('never counts a negative or non-numeric listen', () => {
    expect(isCountablePlay(-1, 12)).toBe(false);
    expect(isCountablePlay(-1, 0.5)).toBe(false);
    expect(isCountablePlay(NaN, 12)).toBe(false);
  });
});

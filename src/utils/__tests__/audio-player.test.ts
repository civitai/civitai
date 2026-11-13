import { describe, expect, it } from 'vitest';
import { computeWaveformPeaks, formatPlaybackTime } from '~/utils/audio-player';

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

describe('computeWaveformPeaks', () => {
  it('averages each slice and scales the loudest slice to 1', () => {
    const samples = new Float32Array([1, -1, 0.5, -0.5, 0.25, -0.25]);
    expect(computeWaveformPeaks(samples, 3)).toEqual([1, 0.5, 0.25]);
  });

  it('leaves out the samples past the last whole slice', () => {
    expect(computeWaveformPeaks([0.5, 0.5, 1, 1, 8], 2)).toEqual([0.5, 1]);
  });

  it('pads input shorter than the bar count with silent bars', () => {
    expect(computeWaveformPeaks([0.5, -1], 4)).toEqual([0.5, 1, 0, 0]);
  });

  it('gives silent bars for empty or silent input', () => {
    expect(computeWaveformPeaks([], 3)).toEqual([0, 0, 0]);
    expect(computeWaveformPeaks([0, 0, 0, 0], 2)).toEqual([0, 0]);
  });
});

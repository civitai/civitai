import { describe, expect, it } from 'vitest';
import {
  clampPlaybackTime,
  computeWaveformPeaks,
  formatPlaybackTime,
  playbackProgress,
  timeFromPointer,
} from '~/utils/audio-player';

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

describe('clampPlaybackTime', () => {
  it('keeps a time inside the track as it is', () => {
    expect(clampPlaybackTime(42.5, 200)).toBe(42.5);
  });

  it('stops a negative time at the start and a time past the end at the end', () => {
    expect(clampPlaybackTime(-3, 200)).toBe(0);
    expect(clampPlaybackTime(250, 200)).toBe(200);
  });

  it.each([0, NaN, Infinity, -10])('gives 0 when the duration is unknown (%s)', (duration) => {
    expect(clampPlaybackTime(42, duration)).toBe(0);
  });

  it('gives 0 for an unknown time', () => {
    expect(clampPlaybackTime(NaN, 200)).toBe(0);
  });
});

describe('timeFromPointer', () => {
  const rect = { left: 100, width: 400 };

  it('maps the pointer across the bar onto the track', () => {
    expect(timeFromPointer(100, rect, 200)).toBe(0);
    expect(timeFromPointer(300, rect, 200)).toBe(100);
    expect(timeFromPointer(500, rect, 200)).toBe(200);
  });

  it('stops at the ends when the pointer is dragged past the bar', () => {
    expect(timeFromPointer(40, rect, 200)).toBe(0);
    expect(timeFromPointer(900, rect, 200)).toBe(200);
  });

  it.each([0, NaN, Infinity])('gives 0 when the duration is unknown (%s)', (duration) => {
    expect(timeFromPointer(300, rect, duration)).toBe(0);
  });

  it('gives 0 for a bar with no width', () => {
    expect(timeFromPointer(300, { left: 100, width: 0 }, 200)).toBe(0);
  });
});

describe('playbackProgress', () => {
  it('is the played fraction of the track', () => {
    expect(playbackProgress(50, 200)).toBe(0.25);
  });

  it('stays inside 0..1', () => {
    expect(playbackProgress(-5, 200)).toBe(0);
    expect(playbackProgress(260, 200)).toBe(1);
  });

  it.each([0, NaN, Infinity])('is 0 when the duration is unknown (%s)', (duration) => {
    expect(playbackProgress(50, duration)).toBe(0);
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

import { describe, expect, test } from 'vitest';
import { resamplePeaks } from '~/components/Audio/resample-peaks';

describe('resamplePeaks', () => {
  test('keeps the loudest peak of each group', () => {
    expect(resamplePeaks([0.1, 0.9, 0.2, 0.3, 0.4, 0.05], 3)).toEqual([0.9, 0.3, 0.4]);
  });

  test('covers every peak when the counts do not divide evenly', () => {
    const peaks = [0.1, 0.2, 0.3, 0.4, 1];
    const bars = resamplePeaks(peaks, 2);
    expect(bars).toHaveLength(2);
    expect(bars[1]).toBe(1);
  });

  test('returns the peaks unchanged when there are no more than the bars asked for', () => {
    const peaks = [0.5, 0.6];
    expect(resamplePeaks(peaks, 4)).toBe(peaks);
    expect(resamplePeaks(peaks, 0)).toEqual([]);
  });
});

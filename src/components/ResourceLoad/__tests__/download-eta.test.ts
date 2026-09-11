import { describe, expect, it } from 'vitest';
import { formatDownloadEta } from '~/components/ResourceLoad/download-eta';

describe('formatDownloadEta', () => {
  it.each([
    [30, 'less than a minute'],
    [60, 'about 1 minute'],
    [7 * 60 + 20, 'about 7 minutes'],
    [23 * 60, 'about 25 minutes'],
    [10136, 'about 3 hours'],
    [50 * 60 * 60, 'about 2 days'],
  ])('%i seconds reads as "%s"', (seconds, expected) => {
    expect(formatDownloadEta(seconds)).toBe(expected);
  });
});

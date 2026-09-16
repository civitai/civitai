import { describe, expect, it } from 'vitest';
import {
  downloadSpeedup,
  formatDownloadEta,
  formatDownloadEtaShort,
} from '~/components/ResourceLoad/download-eta';

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

describe('formatDownloadEtaShort', () => {
  it.each([
    [30, '<1 min'],
    [3 * 60 + 10, '3 min'],
    [23 * 60, '25 min'],
    [58 * 60, '1 hr'],
    [64 * 60, '1 hr 5 min'],
    [10136, '3 hr'],
    [50 * 60 * 60, '2 days'],
  ])('%i seconds reads as "%s"', (seconds, expected) => {
    expect(formatDownloadEtaShort(seconds)).toBe(expected);
  });
});

describe('downloadSpeedup', () => {
  it('rounds the ratio of the two ETAs', () => {
    expect(downloadSpeedup(65 * 60, 5 * 60)).toBe(13);
  });

  it('says nothing under 2x, or without both ETAs', () => {
    expect(downloadSpeedup(300, 200)).toBeNull();
    expect(downloadSpeedup(300, null)).toBeNull();
    expect(downloadSpeedup(null, 60)).toBeNull();
  });
});

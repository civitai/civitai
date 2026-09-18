import { describe, expect, it } from 'vitest';
import {
  boostBuysVisibleTime,
  downloadSpeedup,
  ETA_FLOOR_SECONDS,
  formatDownloadEta,
  formatDownloadEtaShort,
} from '~/components/ResourceLoad/download-eta';

/** Two ETAs the floor swallows whatever it is set to, so these cases survive retuning it. */
const NEAR_FLOOR = ETA_FLOOR_SECONDS - 1;
const WELL_UNDER_FLOOR = Math.max(1, Math.round(ETA_FLOOR_SECONDS / 4));

describe('formatDownloadEta', () => {
  it.each([
    [30, 'about 2 minutes'],
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
    [30, '2 min'],
    [3 * 60 + 10, '3 min'],
    [7 * 60, '7 min'],
    [23 * 60, '25 min'],
    [58 * 60, '1 hr'],
    [64 * 60, '1 hr 5 min'],
    [10136, '3 hr'],
    [50 * 60 * 60, '2 days'],
  ])('%i seconds reads as "%s"', (seconds, expected) => {
    expect(formatDownloadEtaShort(seconds)).toBe(expected);
  });
});

// A 40-second boost promised in 40 seconds is a promise the orchestrator's projection cannot keep.
describe('the ETA floor', () => {
  it('never advertises anything sooner than the floor', () => {
    for (const seconds of [0, 1, WELL_UNDER_FLOOR, NEAR_FLOOR]) {
      expect(formatDownloadEta(seconds)).toBe(formatDownloadEta(ETA_FLOOR_SECONDS));
      expect(formatDownloadEtaShort(seconds)).toBe(formatDownloadEtaShort(ETA_FLOOR_SECONDS));
    }
  });

  it('leaves anything above the floor alone', () => {
    expect(formatDownloadEtaShort(8 * 60)).toBe('8 min');
  });
});

describe('boostBuysVisibleTime', () => {
  it('offers the boost when it reads as faster', () => {
    expect(boostBuysVisibleTime(65 * 60, 5 * 60)).toBe(true);
    expect(boostBuysVisibleTime(8 * 60, 6 * 60)).toBe(true);
  });

  it('offers it on an unknown plain ETA — there is nothing to contradict', () => {
    expect(boostBuysVisibleTime(null, 5 * 60)).toBe(true);
  });

  it('withholds it when the floor collapses the gain', () => {
    expect(formatDownloadEtaShort(NEAR_FLOOR)).toBe(formatDownloadEtaShort(WELL_UNDER_FLOOR));
    expect(boostBuysVisibleTime(NEAR_FLOOR, WELL_UNDER_FLOOR)).toBe(false);
  });

  // Well above the floor, so only the rounding can collapse this pair — the floor clamp alone
  // cannot, which is what a floor-only implementation would rely on.
  it('withholds it when the rounding collapses the gain', () => {
    expect(formatDownloadEtaShort(1400)).toBe(formatDownloadEtaShort(1360));
    expect(boostBuysVisibleTime(1400, 1360)).toBe(false);
  });

  it('withholds it when the boost is slower, or has no ETA at all', () => {
    expect(boostBuysVisibleTime(600, 900)).toBe(false);
    expect(boostBuysVisibleTime(600, null)).toBe(false);
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

  it('never claims a speedup the printed numbers do not show', () => {
    expect(formatDownloadEtaShort(NEAR_FLOOR)).toBe(formatDownloadEtaShort(WELL_UNDER_FLOOR));
    expect(downloadSpeedup(NEAR_FLOOR, WELL_UNDER_FLOOR)).toBeNull();
  });

  // '1 hr' against '30 min' — a multiple the rounding creates rather than one raw seconds would give.
  it('claims the multiple the printed numbers do show', () => {
    expect(downloadSpeedup(3599, 1801)).toBe(2);
  });
});
